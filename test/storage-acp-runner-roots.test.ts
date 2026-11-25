import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { REJECTIONS } from "../src/advisories/rejections.js";
import type { AcpProfileConfig } from "../src/config.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { DENIED_HARNESS_STATE_REASON } from "../src/runners/acp-shims.js";
import type { RunAgentRequest } from "../src/runners/types.js";

type ToolEvent = Parameters<NonNullable<RunAgentRequest["callbacks"]["onToolEvent"]>>[0];

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

const profile = (adapter: AcpProfileConfig["adapter"], overrides?: Partial<AcpProfileConfig>): AcpProfileConfig => ({
  id: `acp:${adapter}`,
  kind: "acp",
  adapter,
  command: "unused",
  billing: "subscription",
  ...overrides,
});

function makeBaseRequest(overrides: Partial<RunAgentRequest> & { cwd: string }): RunAgentRequest {
  return {
    runId: "run-roots",
    taskId: "t-roots",
    tier: 2,
    kind: "worker",
    toolPolicy: "read_write_workspace",
    systemPrompt: "Test role",
    initialPrompt: "Run root checks",
    model: "opus",
    maxTurns: 1,
    tools: [],
    executeTool: async () => ({}),
    signal: new AbortController().signal,
    callbacks: {},
    ...overrides,
  };
}

function errorDetail(err: unknown): string {
  const data = (err as { data?: { details?: unknown } })?.data;
  if (typeof data?.details === "string") return data.details;
  return err instanceof Error ? err.message : String(err);
}

const PERM_OPTIONS = [
  { kind: "allow_once" as const, optionId: "allow", name: "Allow" },
  { kind: "reject_once" as const, optionId: "deny", name: "Deny" },
];

function permissionOutcome(resp: unknown): string {
  const out = (resp as { outcome: { outcome: string; optionId?: string } }).outcome;
  return out.outcome === "selected" ? (out.optionId ?? "") : out.outcome;
}

function setupStateLayout() {
  const home = makeTempDir("acp-runner-roots-");
  const workspace = join(home, "repo");
  const stateDir = join(home, ".pi-harness");
  const chatDir = join(stateDir, "data", "projects", "p", "chats", "chat-1");
  const goalsDir = join(chatDir, "goals", "goal-1");
  const artifactsDir = join(chatDir, "artifacts");
  const wt1 = join(chatDir, "worktrees", "t-1");
  const wt2 = join(chatDir, "worktrees", "t-2");

  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(goalsDir, { recursive: true });
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(join(wt1, "src"), { recursive: true });
  mkdirSync(join(wt2, "src"), { recursive: true });

  const wsFile = join(workspace, "src", "app.ts");
  const goalFile = join(goalsDir, "brief.md");
  const artifactFile = join(artifactsDir, "summary.md");
  const dbFile = join(stateDir, "control-plane.sqlite");
  const cfgFile = join(stateDir, "config.json");
  const homeOkFile = join(home, "outside-ok.txt");
  const wt1File = join(wt1, "src", "worker.ts");
  const wt2File = join(wt2, "src", "secret.ts");

  writeFileSync(wsFile, "export const app = 1;\n", "utf8");
  writeFileSync(goalFile, "# Goal 1 Brief\n", "utf8");
  writeFileSync(artifactFile, "# Run Artifact\n", "utf8");
  writeFileSync(dbFile, "sqlite-binary-stub", "utf8");
  writeFileSync(cfgFile, '{"secret":true}\n', "utf8");
  writeFileSync(homeOkFile, "home-readable\n", "utf8");
  writeFileSync(wt1File, "export const t1 = true;\n", "utf8");
  writeFileSync(wt2File, "export const t2Secret = true;\n", "utf8");

  return {
    home,
    workspace,
    stateDir,
    chatDir,
    goalsDir,
    artifactsDir,
    wt1,
    wt2,
    wsFile,
    goalFile,
    artifactFile,
    dbFile,
    cfgFile,
    homeOkFile,
    wt1File,
    wt2File,
  };
}

describe("ACP runner deniedRoots, protectedRoots, and adapter directory wiring (W6b)", () => {
  it("read-only task reads granted goals/artifacts dirs under denied stateDir and refuses writes and denied shell reads", async () => {
    const fx = setupStateLayout();
    let readGoalContent = "";
    let readArtifactContent = "";
    let writeErr = "";
    let permReadGoal = "";
    let permShellGoal = "";
    let permShellConfig = "";

    const fixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-ro-grants",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        const gRes = (await client.request("fs/read_text_file", { sessionId, path: fx.goalFile })) as { content: string };
        readGoalContent = gRes.content;
        const aRes = (await client.request("fs/read_text_file", { sessionId, path: fx.artifactFile })) as { content: string };
        readArtifactContent = aRes.content;

        try {
          await client.request("fs/write_text_file", { sessionId, path: fx.goalFile, content: "mutated" });
        } catch (err) {
          writeErr = errorDetail(err);
        }

        permReadGoal = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "read-goal", title: "Read", kind: "read", locations: [{ path: fx.goalFile }] },
            options: PERM_OPTIONS,
          }),
        );
        permShellGoal = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "sh-goal", title: "Bash", kind: "execute", rawInput: { command: `cat "${fx.goalFile}"` } },
            options: PERM_OPTIONS,
          }),
        );
        permShellConfig = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "sh-cfg", title: "Bash", kind: "execute", rawInput: { command: `cat "${fx.cfgFile}"` } },
            options: PERM_OPTIONS,
          }),
        );

        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        tier: 3,
        kind: "research",
        toolPolicy: "read_only_workspace",
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        deniedRoots: [fx.stateDir],
      }),
      fixture,
    );

    assert.equal(readGoalContent, "# Goal 1 Brief\n");
    assert.equal(readArtifactContent, "# Run Artifact\n");
    assert.match(writeErr, /^\[harness blocked: read-only-write\] /);
    assert.equal(readFileSync(fx.goalFile, "utf8"), "# Goal 1 Brief\n");
    assert.equal(permReadGoal, "allow");
    assert.equal(permShellGoal, "allow");
    assert.equal(permShellConfig, "deny");
  });

  it("writable task writes to the granted evidence dir under denied stateDir and refuses writes to read-only grants", async () => {
    const fx = setupStateLayout();
    const newEvidence = join(fx.goalsDir, "nested", "evidence.md");
    const tamperArtifact = join(fx.artifactsDir, "tamper.md");
    let permEditEvidence = "";
    let artifactWriteErr = "";

    const fixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-rw-evidence",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        await client.request("fs/write_text_file", {
          sessionId,
          path: newEvidence,
          content: "verified-evidence\n",
        });

        permEditEvidence = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "edit-ev",
              title: "Edit",
              kind: "edit",
              locations: [{ path: newEvidence }],
              rawInput: { file_path: newEvidence },
            },
            options: PERM_OPTIONS,
          }),
        );

        try {
          await client.request("fs/write_text_file", {
            sessionId,
            path: tamperArtifact,
            content: "should-fail",
          });
        } catch (err) {
          artifactWriteErr = errorDetail(err);
        }

        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      }),
      fixture,
    );

    assert.equal(existsSync(newEvidence), true);
    assert.equal(readFileSync(newEvidence, "utf8"), "verified-evidence\n");
    assert.equal(permEditEvidence, "allow");
    assert.ok(
      artifactWriteErr.includes(DENIED_HARNESS_STATE_REASON),
      `expected harness-state refusal, got: ${artifactWriteErr}`,
    );
    assert.equal(existsSync(tamperArtifact), false);
  });

  it("refuses stateDir root, control-plane.sqlite, and config.json for read and write with harness-state reason even when parent home dir is an extra root", async () => {
    const fx = setupStateLayout();
    const leakLink = join(fx.workspace, "leak-config.json");
    symlinkSync(fx.cfgFile, leakLink);

    const targets = [fx.stateDir, fx.dbFile, fx.cfgFile, leakLink];
    const readErrors: Record<string, string> = {};
    const writeErrors: Record<string, string> = {};
    const permReadOutcomes: Record<string, string> = {};
    const permWriteOutcomes: Record<string, string> = {};
    const toolEvents: ToolEvent[] = [];
    let homeFileContent = "";

    const fixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-denied-state",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        // Sanity check: sibling file directly under home IS readable because home is an extraReadRoot.
        const homeRes = (await client.request("fs/read_text_file", { sessionId, path: fx.homeOkFile })) as { content: string };
        homeFileContent = homeRes.content;

        for (const target of targets) {
          try {
            await client.request("fs/read_text_file", { sessionId, path: target });
            assert.fail(`expected read refusal for ${target}`);
          } catch (err) {
            readErrors[target] = errorDetail(err);
          }

          try {
            await client.request("fs/write_text_file", { sessionId, path: target, content: "pwned" });
            assert.fail(`expected write refusal for ${target}`);
          } catch (err) {
            writeErrors[target] = errorDetail(err);
          }

          permReadOutcomes[target] = permissionOutcome(
            await client.request("session/request_permission", {
              sessionId,
              toolCall: { toolCallId: `perm-r-${target}`, title: "Read", kind: "read", locations: [{ path: target }] },
              options: PERM_OPTIONS,
            }),
          );
          permWriteOutcomes[target] = permissionOutcome(
            await client.request("session/request_permission", {
              sessionId,
              toolCall: {
                toolCallId: `perm-w-${target}`,
                title: "Edit",
                kind: "edit",
                locations: [{ path: target }],
                rawInput: { file_path: target },
              },
              options: PERM_OPTIONS,
            }),
          );
        }

        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "checked" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.home, fx.goalsDir, fx.artifactsDir],
        extraWriteRoots: [fx.home, fx.goalsDir],
        deniedRoots: [fx.stateDir],
        callbacks: { onToolEvent: (ev) => toolEvents.push(ev) },
      }),
      fixture,
    );

    assert.equal(homeFileContent, "home-readable\n");
    for (const target of targets) {
      assert.ok(
        readErrors[target]?.includes(DENIED_HARNESS_STATE_REASON),
        `read of ${target} must name harness state, got: ${readErrors[target]}`,
      );
      assert.equal(
        readErrors[target]?.includes("outside the task workspace"),
        false,
        `read of ${target} must not use outside-roots message: ${readErrors[target]}`,
      );
      assert.ok(
        writeErrors[target]?.includes(DENIED_HARNESS_STATE_REASON),
        `write of ${target} must name harness state, got: ${writeErrors[target]}`,
      );
      assert.equal(
        writeErrors[target]?.includes("outside the task workspace"),
        false,
        `write of ${target} must not use outside-roots message: ${writeErrors[target]}`,
      );
      assert.equal(permReadOutcomes[target], "deny", `permission read of ${target}`);
      assert.equal(permWriteOutcomes[target], "deny", `permission write of ${target}`);
    }
    const deniedPermErrors = toolEvents.filter((e) => e.status === "failed").map((e) => e.error ?? "");
    assert.ok(deniedPermErrors.length >= targets.length * 2);
    for (const msg of deniedPermErrors) {
      assert.ok(msg.includes(DENIED_HARNESS_STATE_REASON), `permission denial must name harness state: ${msg}`);
    }
    assert.equal(readFileSync(fx.dbFile, "utf8"), "sqlite-binary-stub");
    assert.equal(readFileSync(fx.cfgFile, "utf8"), '{"secret":true}\n');
  });

  it("allows a worktree workspace inside denied stateDir to read and write itself while refusing a sibling worktree in protectedRoots", async () => {
    const fx = setupStateLayout();
    const newWt1File = join(fx.wt1, "src", "added.ts");
    let wt1Read = "";
    let wt2ReadErr = "";
    let wt2WriteErr = "";
    let permWt1Edit = "";
    let permWt2Read = "";

    const fixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-wt-under-state",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        const res = (await client.request("fs/read_text_file", { sessionId, path: fx.wt1File })) as { content: string };
        wt1Read = res.content;

        await client.request("fs/write_text_file", {
          sessionId,
          path: newWt1File,
          content: "export const added = true;\n",
        });

        permWt1Edit = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "edit-wt1", title: "Edit", kind: "edit", locations: [{ path: fx.wt1File }] },
            options: PERM_OPTIONS,
          }),
        );

        try {
          await client.request("fs/read_text_file", { sessionId, path: fx.wt2File });
          assert.fail("expected sibling worktree read refusal");
        } catch (err) {
          wt2ReadErr = errorDetail(err);
        }

        try {
          await client.request("fs/write_text_file", { sessionId, path: fx.wt2File, content: "mutated" });
          assert.fail("expected sibling worktree write refusal");
        } catch (err) {
          wt2WriteErr = errorDetail(err);
        }

        permWt2Read = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "read-wt2", title: "Read", kind: "read", locations: [{ path: fx.wt2File }] },
            options: PERM_OPTIONS,
          }),
        );

        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.wt1,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
        protectedRoots: [fx.wt2],
      }),
      fixture,
    );

    assert.equal(wt1Read, "export const t1 = true;\n");
    assert.equal(readFileSync(newWt1File, "utf8"), "export const added = true;\n");
    assert.equal(permWt1Edit, "allow");
    assert.ok(wt2ReadErr.length > 0);
    assert.ok(wt2WriteErr.length > 0);
    assert.equal(permWt2Read, "deny");
    assert.equal(readFileSync(fx.wt2File, "utf8"), "export const t2Secret = true;\n");

    // Also prove protectedRoots refuses the sibling worktree even when its parent directory is granted
    // and deniedRoots is omitted.
    let protOnlyReadErr = "";
    let protOnlyShell = "";
    const protOnlyFixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-wt-prot-only",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        try {
          await client.request("fs/read_text_file", { sessionId, path: fx.wt2File });
          assert.fail("expected protectedRoots read refusal");
        } catch (err) {
          protOnlyReadErr = errorDetail(err);
        }
        protOnlyShell = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "sh-wt2", title: "Bash", kind: "execute", rawInput: { command: `cat "${fx.wt2File}"` } },
            options: PERM_OPTIONS,
          }),
        );
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.wt1,
        tier: 3,
        kind: "research",
        toolPolicy: "read_only_workspace",
        extraReadRoots: [dirname(fx.wt2)],
        protectedRoots: [fx.wt2],
      }),
      protOnlyFixture,
    );

    assert.match(protOnlyReadErr, /^\[harness blocked: protected-path\] /);
    assert.equal(protOnlyShell, "deny");
  });

  it("keeps workspace usable when stateDir equals workspace (allowed wins a tie)", async () => {
    const fx = setupStateLayout();
    const outFile = join(fx.workspace, "src", "tie-write.ts");
    let readText = "";
    let permRead = "";
    let permShell = "";

    const rwFixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-tie-rw",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        const res = (await client.request("fs/read_text_file", { sessionId, path: fx.wsFile })) as { content: string };
        readText = res.content;
        await client.request("fs/write_text_file", { sessionId, path: outFile, content: "export const tie = true;\n" });
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        deniedRoots: [fx.workspace],
      }),
      rwFixture,
    );

    assert.equal(readText, "export const app = 1;\n");
    assert.equal(readFileSync(outFile, "utf8"), "export const tie = true;\n");

    const roFixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-tie-ro",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        permRead = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "tie-r", title: "Read", kind: "read", locations: [{ path: fx.wsFile }] },
            options: PERM_OPTIONS,
          }),
        );
        permShell = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: { toolCallId: "tie-sh", title: "Bash", kind: "execute", rawInput: { command: "cat src/app.ts" } },
            options: PERM_OPTIONS,
          }),
        );
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        tier: 3,
        kind: "research",
        toolPolicy: "read_only_workspace",
        deniedRoots: [fx.workspace],
      }),
      roFixture,
    );

    assert.equal(permRead, "allow");
    assert.equal(permShell, "allow");
  });

  it("sends only write roots as additionalDirectories for writable codex, both read and write roots for claude, and passes directories to prepareAcpSpawn", async () => {
    const fx = setupStateLayout();
    let codexSessionParams: Record<string, unknown> | undefined;
    let claudeSessionParams: Record<string, unknown> | undefined;

    const captureAgent = (onParams: (params: Record<string, unknown>) => void) =>
      agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } },
        }))
        .onRequest("session/new", async ({ params }) => {
          onParams(params as unknown as Record<string, unknown>);
          return {
            sessionId: "s-dirs",
            models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
          };
        })
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
          });
          return { stopReason: "end_turn" };
        });

    await new AcpRunner(profile("codex")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      }),
      captureAgent((p) => {
        codexSessionParams = p;
      }),
    );

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      }),
      captureAgent((p) => {
        claudeSessionParams = p;
      }),
    );

    assert.deepEqual(codexSessionParams?.additionalDirectories, [fx.goalsDir]);
    assert.deepEqual(claudeSessionParams?.additionalDirectories, [fx.artifactsDir, fx.goalsDir]);
    const claudeMetaDirs = (
      claudeSessionParams?._meta as { claudeCode?: { options?: { additionalDirectories?: string[] } } } | undefined
    )?.claudeCode?.options?.additionalDirectories;
    assert.deepEqual(claudeMetaDirs, [fx.artifactsDir, fx.goalsDir]);

    // Verify prepareAcpSpawn wiring end-to-end via a tiny local fake ACP subprocess for gemini:
    // readDirectories + writeDirectories must arrive as --include-directories CLI args.
    const fakeScript = join(fx.home, "capture-acp-agent.ts");
    const captureOut = join(fx.home, "spawn-capture.json");
    writeFileSync(
      fakeScript,
      `import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk/unstable";

writeFileSync(process.env.CAPTURE_OUT!, JSON.stringify({ argv: process.argv.slice(2), codexConfig: process.env.CODEX_CONFIG ?? null }));
const app = agent()
  .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
  .onRequest("session/new", async () => ({
    sessionId: "s-spawn",
    models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
  }))
  .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
    await client.notify("session/update", {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
    });
    return { stopReason: "end_turn" };
  });
app.connect(ndJsonStream(Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
`,
      "utf8",
    );
    chmodSync(fakeScript, 0o755);

    await new AcpRunner(
      profile("gemini", {
        command: process.execPath,
        args: [fakeScript],
        env: { CAPTURE_OUT: captureOut },
      }),
    ).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      }),
    );

    const geminiCaptured = JSON.parse(readFileSync(captureOut, "utf8")) as { argv: string[] };
    const includedDirs: string[] = [];
    for (let i = 0; i < geminiCaptured.argv.length; i++) {
      if (geminiCaptured.argv[i] === "--include-directories" && geminiCaptured.argv[i + 1]) {
        includedDirs.push(geminiCaptured.argv[i + 1]!);
      }
    }
    assert.deepEqual(includedDirs, [fx.artifactsDir, fx.goalsDir]);
  });

  it("preserves the exact outside-roots message when deniedRoots is omitted", async () => {
    const fx = setupStateLayout();
    const outsideFile = fx.homeOkFile;
    let readErr = "";
    let writeErr = "";
    const toolEvents: ToolEvent[] = [];

    const fixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-no-denied",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        try {
          await client.request("fs/read_text_file", { sessionId, path: outsideFile });
          assert.fail("expected outside-roots read error");
        } catch (err) {
          readErr = errorDetail(err);
        }
        try {
          await client.request("fs/write_text_file", { sessionId, path: outsideFile, content: "nope" });
          assert.fail("expected outside-roots write error");
        } catch (err) {
          writeErr = errorDetail(err);
        }
        await client.request("session/request_permission", {
          sessionId,
          toolCall: { toolCallId: "out-r", title: "Read", kind: "read", locations: [{ path: outsideFile }] },
          options: PERM_OPTIONS,
        });
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        callbacks: { onToolEvent: (ev) => toolEvents.push(ev) },
      }),
      fixture,
    );

    const expectedMsg = REJECTIONS.outsideRoots(outsideFile, fx.workspace).message;
    assert.equal(readErr, expectedMsg);
    assert.equal(writeErr, expectedMsg);
    assert.equal(toolEvents[0]?.denied, "outside-roots");
    assert.equal(toolEvents[0]?.error, expectedMsg);
  });

  it("R3: resolves relative permission paths once against the workspace for shell cwd and writes instead of retrying extra roots", async () => {
    const fx = setupStateLayout();
    const outsideDir = makeTempDir("acp-r3-outside-");
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "do-not-touch\n", "utf8");

    // Create a subdir and a nested write root under extra roots so retrying relative inputs against extra roots
    // would match a different path than the adapter's workspace cwd.
    const extraOnlySubdir = join(fx.goalsDir, "only-in-extra");
    mkdirSync(extraOnlySubdir, { recursive: true });
    const nestedGoalDir = join(fx.goalsDir, "nested");
    mkdirSync(nestedGoalDir, { recursive: true });
    writeFileSync(join(extraOnlySubdir, "note.md"), "extra-note\n", "utf8");

    // In workspace, `escape-link` is a symlink to an outside file, and `escape-dir` is a symlink to outsideDir.
    symlinkSync(outsideFile, join(fx.workspace, "escape-link"));
    symlinkSync(outsideDir, join(fx.workspace, "escape-dir"));
    mkdirSync(join(fx.goalsDir, "escape-dir"), { recursive: true });

    let roCwdExtraOnly = "";
    let roCwdSymlinkEscape = "";
    let roCwdWorkspaceSub = "";
    let roCwdAbsExtra = "";
    let rwEditSymlinkEscape = "";
    let rwEditDotDotRetry = "";
    let rwEditWorkspaceRel = "";
    let rwEditAbsExtra = "";

    const roFixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-r3-ro",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        roCwdExtraOnly = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-cwd-extra-only",
              title: "Bash",
              kind: "execute",
              rawInput: { command: "ls", cwd: "only-in-extra" },
            },
            options: PERM_OPTIONS,
          }),
        );
        roCwdSymlinkEscape = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-cwd-sym-escape",
              title: "Bash",
              kind: "execute",
              rawInput: { command: "ls", cwd: "escape-dir" },
            },
            options: PERM_OPTIONS,
          }),
        );
        roCwdWorkspaceSub = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-cwd-ws-sub",
              title: "Bash",
              kind: "execute",
              rawInput: { command: "ls", cwd: "src" },
            },
            options: PERM_OPTIONS,
          }),
        );
        roCwdAbsExtra = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-cwd-abs-extra",
              title: "Bash",
              kind: "execute",
              rawInput: { command: "ls", cwd: extraOnlySubdir },
            },
            options: PERM_OPTIONS,
          }),
        );
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        tier: 3,
        kind: "research",
        toolPolicy: "read_only_workspace",
        extraReadRoots: [fx.goalsDir],
      }),
      roFixture,
    );

    const rwFixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "s-r3-rw",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      }))
      .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
        // `escape-link` inside workspace points outside; retrying against extraWriteRoots would see a missing new file there.
        rwEditSymlinkEscape = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-edit-sym",
              title: "Edit",
              kind: "edit",
              locations: [{ path: "escape-link" }],
              rawInput: { file_path: "escape-link" },
            },
            options: PERM_OPTIONS,
          }),
        );
        // `../escaped.md` escapes workspace; retrying against nestedGoalDir would land inside fx.goalsDir.
        rwEditDotDotRetry = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-edit-dotdot",
              title: "Edit",
              kind: "edit",
              locations: [{ path: "../escaped.md" }],
              rawInput: { file_path: "../escaped.md" },
            },
            options: PERM_OPTIONS,
          }),
        );
        rwEditWorkspaceRel = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-edit-ws-rel",
              title: "Edit",
              kind: "edit",
              locations: [{ path: "src/app.ts" }],
              rawInput: { file_path: "src/app.ts" },
            },
            options: PERM_OPTIONS,
          }),
        );
        rwEditAbsExtra = permissionOutcome(
          await client.request("session/request_permission", {
            sessionId,
            toolCall: {
              toolCallId: "r3-edit-abs-extra",
              title: "Edit",
              kind: "edit",
              locations: [{ path: join(fx.goalsDir, "new-ev.md") }],
              rawInput: { file_path: join(fx.goalsDir, "new-ev.md") },
            },
            options: PERM_OPTIONS,
          }),
        );
        await client.notify("session/update", {
          sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
        });
        return { stopReason: "end_turn" };
      });

    await new AcpRunner(profile("claude")).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        extraWriteRoots: [nestedGoalDir, fx.goalsDir],
      }),
      rwFixture,
    );

    assert.equal(roCwdExtraOnly, "deny");
    assert.equal(roCwdSymlinkEscape, "deny");
    assert.equal(roCwdWorkspaceSub, "allow");
    assert.equal(roCwdAbsExtra, "allow");
    assert.equal(rwEditSymlinkEscape, "deny");
    assert.equal(rwEditDotDotRetry, "deny");
    assert.equal(rwEditWorkspaceRel, "allow");
    assert.equal(rwEditAbsExtra, "allow");
  });

  it("R1: refuses execute permissions with explicit cwd in denied roots or protected worktrees/scratch for workers and shell-enabled read-only tasks", async () => {
    const fx = setupStateLayout();
    const otherChatGoals = join(fx.stateDir, "data", "projects", "p", "chats", "chat-2", "goals", "goal-2");
    const scratchDir = join(fx.stateDir, "data", "projects", "p", "scratch", "_verify", "v-1");
    const stateInstallDir = join(fx.stateDir, "install");
    const outsideDir = makeTempDir("acp-r1-outside-");
    mkdirSync(otherChatGoals, { recursive: true });
    mkdirSync(scratchDir, { recursive: true });
    mkdirSync(stateInstallDir, { recursive: true });
    const stateSymlink = join(fx.wt1, "link-state");
    symlinkSync(fx.stateDir, stateSymlink);

    const runExecChecks = async (reqOverrides: Partial<RunAgentRequest>, checks: Array<{ id: string; rawInput?: Record<string, unknown> }>) => {
      const outcomes: Record<string, string> = {};
      const events: ToolEvent[] = [];
      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: "s-r1",
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          for (const c of checks) {
            outcomes[c.id] = permissionOutcome(
              await client.request("session/request_permission", {
                sessionId,
                toolCall: {
                  toolCallId: c.id,
                  title: "Bash",
                  kind: "execute",
                  ...(c.rawInput ? { rawInput: c.rawInput } : {}),
                },
                options: PERM_OPTIONS,
              }),
            );
          }
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(profile("claude")).run(
        makeBaseRequest({
          cwd: fx.wt1,
          callbacks: { onToolEvent: (ev) => events.push(ev) },
          ...reqOverrides,
        }),
        fixture,
      );
      return { outcomes, events };
    };

    const dataDirChecks = [
      { id: "denied-state-root", rawInput: { command: "ls", cwd: fx.stateDir } },
      { id: "denied-state-install", rawInput: { command: "ls", cwd: stateInstallDir } },
      { id: "denied-other-chat", rawInput: { command: "ls", workdir: otherChatGoals } },
      { id: "denied-sibling-wt", rawInput: { command: "ls", directory: fx.wt2 } },
      { id: "denied-scratch", rawInput: { command: "ls", dir_path: scratchDir } },
      { id: "denied-symlink", rawInput: { command: "ls", Cwd: stateSymlink } },
      { id: "denied-relative-sibling", rawInput: { command: "ls", working_directory: "../t-2" } },
      { id: "allow-no-cwd", rawInput: { command: "bun test" } },
      { id: "allow-own-wt", rawInput: { command: "bun test", cwd: fx.wt1 } },
      { id: "allow-own-sub", rawInput: { command: "bun test", cwd: "src" } },
      { id: "allow-granted-goal", rawInput: { command: "ls", workdir: fx.goalsDir } },
      { id: "allow-granted-art", rawInput: { command: "ls", workingDirectory: fx.artifactsDir } },
      { id: "allow-outside-tmp", rawInput: { command: "ls", cwd: outsideDir } },
    ];

    // 1. Writable worker in data-dir layout
    const workerRes = await runExecChecks(
      {
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      },
      dataDirChecks,
    );

    // 2. Shell-enabled read-only verify / isolated Done-Reviewer in data-dir layout
    const verifyRes = await runExecChecks(
      {
        tier: 3,
        kind: "verify",
        toolPolicy: "read_only_workspace",
        allowShellInReadOnly: true,
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        deniedRoots: [fx.stateDir],
      },
      dataDirChecks,
    );

    for (const [label, res] of [
      ["worker", workerRes],
      ["verify", verifyRes],
    ] as const) {
      for (const id of [
        "denied-state-root",
        "denied-state-install",
        "denied-other-chat",
        "denied-sibling-wt",
        "denied-scratch",
        "denied-symlink",
        "denied-relative-sibling",
      ]) {
        assert.equal(res.outcomes[id], "deny", `${label}: ${id} must be denied`);
      }
      for (const id of [
        "allow-no-cwd",
        "allow-own-wt",
        "allow-own-sub",
        "allow-granted-goal",
        "allow-granted-art",
        "allow-outside-tmp",
      ]) {
        assert.equal(res.outcomes[id], "allow", `${label}: ${id} must be allowed`);
      }
      const failedEvents = res.events.filter((ev) => ev.status === "failed");
      assert.equal(failedEvents.length, 7, `${label}: expected 7 failed events`);
      for (const ev of failedEvents) {
        assert.equal(ev.denied, "protected-path", `${label}: ${ev.id} denied rule`);
        assert.ok(ev.error?.includes(DENIED_HARNESS_STATE_REASON), `${label}: ${ev.id} error must name harness state: ${ev.error}`);
      }
    }

    // 3. Explicit protectedRoots sibling worktree (even when parent is granted and deniedRoots is omitted)
    const protRes = await runExecChecks(
      {
        toolPolicy: "read_write_workspace",
        extraReadRoots: [dirname(fx.wt2)],
        protectedRoots: [fx.wt2],
      },
      [
        { id: "prot-wt2", rawInput: { command: "ls", cwd: fx.wt2 } },
        { id: "prot-outside", rawInput: { command: "ls", cwd: outsideDir } },
      ],
    );
    assert.equal(protRes.outcomes["prot-wt2"], "deny");
    assert.equal(protRes.outcomes["prot-outside"], "allow");
    assert.equal(protRes.events.find((e) => e.id === "prot-wt2")?.denied, "protected-path");

    // 4. Legacy layout (no deniedRoots, no protectedRoots): outside and workspace cwds stay approved
    const legacyRes = await runExecChecks(
      {
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
      },
      [
        { id: "legacy-none", rawInput: { command: "bun test" } },
        { id: "legacy-ws", rawInput: { command: "bun test", cwd: fx.workspace } },
        { id: "legacy-outside", rawInput: { command: "ls", cwd: outsideDir } },
      ],
    );
    assert.equal(legacyRes.outcomes["legacy-none"], "allow");
    assert.equal(legacyRes.outcomes["legacy-ws"], "allow");
    assert.equal(legacyRes.outcomes["legacy-outside"], "allow");
  });

  it("R2: validates writable 'other' request target paths and locations against write rule A3 and protected paths while approving pathless requests", async () => {
    const fx = setupStateLayout();
    const otherChatFile = join(fx.stateDir, "data", "projects", "p", "chats", "chat-2", "goals", "goal-2", "brief.md");
    const scratchFile = join(fx.stateDir, "data", "projects", "p", "scratch", "_verify", "v-1", "out.txt");
    const gitConfig = join(fx.wt1, ".git", "config");
    const outsideDir = makeTempDir("acp-r2-outside-");
    const outsideFile = join(outsideDir, "scratch.txt");
    mkdirSync(dirname(otherChatFile), { recursive: true });
    mkdirSync(dirname(scratchFile), { recursive: true });
    mkdirSync(dirname(gitConfig), { recursive: true });
    writeFileSync(otherChatFile, "other-chat\n", "utf8");
    writeFileSync(scratchFile, "scratch\n", "utf8");
    writeFileSync(gitConfig, "[core]\n", "utf8");
    writeFileSync(outsideFile, "outside\n", "utf8");
    const leakLink = join(fx.wt1, "leak-cfg");
    symlinkSync(fx.cfgFile, leakLink);

    const runOtherChecks = async (
      reqOverrides: Partial<RunAgentRequest>,
      checks: Array<{
        id: string;
        title: string;
        kind?: string;
        locations?: Array<{ path: string }>;
        rawInput?: Record<string, unknown>;
      }>,
    ) => {
      const outcomes: Record<string, string> = {};
      const events: ToolEvent[] = [];
      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: "s-r2",
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          for (const c of checks) {
            outcomes[c.id] = permissionOutcome(
              await client.request("session/request_permission", {
                sessionId,
                toolCall: {
                  toolCallId: c.id,
                  title: c.title,
                  ...(c.kind !== undefined ? { kind: c.kind } : {}),
                  ...(c.locations ? { locations: c.locations } : {}),
                  ...(c.rawInput ? { rawInput: c.rawInput } : {}),
                },
                options: PERM_OPTIONS,
              }),
            );
          }
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(profile("claude")).run(
        makeBaseRequest({
          cwd: fx.wt1,
          toolPolicy: "read_write_workspace",
          callbacks: { onToolEvent: (ev) => events.push(ev) },
          ...reqOverrides,
        }),
        fixture,
      );
      return { outcomes, events };
    };

    const dataDirRes = await runOtherChecks(
      {
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      },
      [
        { id: "deny-state-loc", title: "custom_patch", kind: "other", locations: [{ path: fx.cfgFile }] },
        { id: "deny-other-chat", title: "custom_patch", kind: "other", rawInput: { file_path: otherChatFile } },
        { id: "deny-ro-artifact", title: "apply_patch", kind: "other", rawInput: { TargetFile: join(fx.artifactsDir, "tamper.md") } },
        { id: "deny-sibling-wt", title: "custom_patch", kind: "other", rawInput: { path: fx.wt2File } },
        { id: "deny-scratch", title: "custom_patch", kind: "other", rawInput: { destination: scratchFile } },
        { id: "deny-git", title: "custom_patch", kind: "other", rawInput: { path: gitConfig } },
        { id: "deny-relative-sibling", title: "custom_patch", kind: "other", rawInput: { file_path: "../t-2/src/secret.ts" } },
        { id: "deny-symlink", title: "custom_patch", kind: "other", rawInput: { path: "leak-cfg" } },
        { id: "deny-mixed-targets", title: "custom_patch", kind: "other", locations: [{ path: fx.wt1File }], rawInput: { paths: [fx.wt1File, fx.dbFile] } },
        { id: "deny-undefined-kind", title: "patch_tool", rawInput: { file_path: fx.cfgFile } },
        { id: "deny-ro-other-state", title: "list_dir", kind: "other", rawInput: { path: fx.stateDir } },
        { id: "allow-no-paths", title: "custom_tool", kind: "other", rawInput: { query: "status" } },
        { id: "allow-ws-target", title: "custom_patch", kind: "other", locations: [{ path: fx.wt1File }], rawInput: { file_path: "src/worker.ts" } },
        { id: "allow-granted-write", title: "custom_patch", kind: "other", rawInput: { file_path: join(fx.goalsDir, "new-ev.md") } },
        { id: "allow-outside", title: "custom_patch", kind: "other", rawInput: { file_path: outsideFile } },
        { id: "allow-ro-other-artifact", title: "list_dir", kind: "other", rawInput: { path: fx.artifactsDir } },
      ],
    );

    for (const id of [
      "deny-state-loc",
      "deny-other-chat",
      "deny-ro-artifact",
      "deny-sibling-wt",
      "deny-scratch",
      "deny-git",
      "deny-relative-sibling",
      "deny-symlink",
      "deny-mixed-targets",
      "deny-undefined-kind",
      "deny-ro-other-state",
    ]) {
      assert.equal(dataDirRes.outcomes[id], "deny", `${id} must be denied`);
      const ev = dataDirRes.events.find((e) => e.id === id);
      assert.equal(ev?.denied, "protected-path", `${id} must report protected-path`);
      if (id !== "deny-git") {
        assert.ok(ev?.error?.includes(DENIED_HARNESS_STATE_REASON), `${id} error must name harness state: ${ev?.error}`);
      }
    }
    for (const id of [
      "allow-no-paths",
      "allow-ws-target",
      "allow-granted-write",
      "allow-outside",
      "allow-ro-other-artifact",
    ]) {
      assert.equal(dataDirRes.outcomes[id], "allow", `${id} must be allowed`);
    }

    // Legacy layout (no deniedRoots, no protectedRoots): pathless and outside-workspace 'other' requests stay approved.
    const legacyRes = await runOtherChecks(
      { cwd: fx.workspace },
      [
        { id: "legacy-no-paths", title: "custom_tool", kind: "other", rawInput: { query: "status" } },
        { id: "legacy-outside", title: "custom_tool", kind: "other", rawInput: { file_path: outsideFile } },
        { id: "legacy-ws", title: "custom_tool", kind: "other", rawInput: { file_path: fx.wsFile } },
      ],
    );
    assert.equal(legacyRes.outcomes["legacy-no-paths"], "allow");
    assert.equal(legacyRes.outcomes["legacy-outside"], "allow");
    assert.equal(legacyRes.outcomes["legacy-ws"], "allow");
  });
});
