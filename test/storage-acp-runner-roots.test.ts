import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { REJECTIONS } from "../src/advisories/rejections.js";
import type { AcpProfileConfig } from "../src/config.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { DENIED_HARNESS_STATE_REASON, prepareAcpSpawn } from "../src/runners/acp-shims.js";
import type { RunAgentRequest } from "../src/runners/types.js";
import { legacyStoragePaths, StoragePaths, type StorageLayout } from "../src/storage/paths.js";

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

  it("forwards resolved cwd and deniedRoots to prepareAcpSpawn in data-dir layout and keeps legacy spawn env unchanged", async () => {
    const fx = setupStateLayout();
    const wtLink = join(fx.home, "wt1-link");
    symlinkSync(fx.wt1, wtLink);

    const fakeScript = join(fx.home, "capture-opencode-spawn.ts");
    const captureDataDir = join(fx.home, "opencode-data-dir.json");
    const captureLegacyDirs = join(fx.home, "opencode-legacy-dirs.json");
    const captureLegacyEmpty = join(fx.home, "opencode-legacy-empty.json");
    writeFileSync(
      fakeScript,
      `import { writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk/unstable";

writeFileSync(
  process.env.CAPTURE_OUT!,
  JSON.stringify({ opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT ?? null }),
);
const app = agent()
  .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
  .onRequest("session/new", async () => ({
    sessionId: "s-opencode-spawn",
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

    const makeOpenCodeProfile = (captureOut: string): AcpProfileConfig =>
      profile("generic", {
        id: "acp:opencode",
        command: process.execPath,
        args: [fakeScript],
        env: { CAPTURE_OUT: captureOut },
      });

    // Data-dir layout: AcpRunner forwards resolved cwd (fx.wt1, not symlink wtLink) and deniedRoots (fx.stateDir).
    await new AcpRunner(makeOpenCodeProfile(captureDataDir)).run(
      makeBaseRequest({
        cwd: wtLink,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      }),
    );
    const dataDirCaptured = JSON.parse(readFileSync(captureDataDir, "utf8")) as { opencodeConfig: string | null };
    assert.ok(dataDirCaptured.opencodeConfig, "data-dir OpenCode spawn must set OPENCODE_CONFIG_CONTENT");
    const dataDirCfg = JSON.parse(dataDirCaptured.opencodeConfig) as {
      permission: {
        external_directory: Record<string, string>;
        read: Record<string, string>;
        edit: Record<string, string>;
      };
    };
    const extKeys = Object.keys(dataDirCfg.permission.external_directory);
    assert.equal(extKeys[0], "**");
    assert.equal(dataDirCfg.permission.external_directory[fx.stateDir], "deny");
    assert.equal(dataDirCfg.permission.external_directory[`${fx.stateDir}/**`], "deny");
    assert.equal(dataDirCfg.permission.external_directory[fx.wt1], "allow");
    assert.equal(dataDirCfg.permission.external_directory[wtLink], undefined);
    assert.ok(extKeys.indexOf(`${fx.stateDir}/**`) < extKeys.indexOf(fx.wt1));
    assert.ok(extKeys.indexOf(`${fx.stateDir}/**`) < extKeys.indexOf(fx.artifactsDir));
    assert.ok(extKeys.indexOf(`${fx.stateDir}/**`) < extKeys.indexOf(fx.goalsDir));

    const readKeys = Object.keys(dataDirCfg.permission.read);
    assert.equal(dataDirCfg.permission.read[`${fx.stateDir}/**`], "deny");
    assert.equal(dataDirCfg.permission.read[`${fx.wt1}/**`], "allow");
    assert.ok(readKeys.indexOf(`${fx.stateDir}/**`) < readKeys.indexOf(fx.wt1));

    const editKeys = Object.keys(dataDirCfg.permission.edit);
    assert.equal(dataDirCfg.permission.edit[`${fx.stateDir}/**`], "deny");
    assert.equal(dataDirCfg.permission.edit[`${fx.wt1}/**`], "allow");
    assert.equal(dataDirCfg.permission.edit[`${fx.goalsDir}/**`], "allow");
    assert.equal(dataDirCfg.permission.edit[fx.artifactsDir], undefined);
    assert.ok(editKeys.indexOf(`${fx.stateDir}/**`) < editKeys.indexOf(fx.wt1));

    // Legacy layout (no deniedRoots): OPENCODE_CONFIG_CONTENT is byte-identical to prepareAcpSpawn without cwd/deniedRoots.
    const legacyDirsProfile = makeOpenCodeProfile(captureLegacyDirs);
    await new AcpRunner(legacyDirsProfile).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
      }),
    );
    const expectedLegacyDirs = prepareAcpSpawn(legacyDirsProfile, {
      systemPrompt: "Test role",
      toolPolicy: "read_write_workspace",
      allowShellInReadOnly: false,
      tier: 2,
      readDirectories: [fx.artifactsDir, fx.goalsDir],
      writeDirectories: [fx.goalsDir],
    });
    const legacyDirsCaptured = JSON.parse(readFileSync(captureLegacyDirs, "utf8")) as { opencodeConfig: string | null };
    assert.equal(legacyDirsCaptured.opencodeConfig, expectedLegacyDirs.env.OPENCODE_CONFIG_CONTENT ?? null);
    expectedLegacyDirs.cleanup();

    const legacyEmptyProfile = makeOpenCodeProfile(captureLegacyEmpty);
    await new AcpRunner(legacyEmptyProfile).run(
      makeBaseRequest({
        cwd: fx.workspace,
        toolPolicy: "read_write_workspace",
      }),
    );
    const expectedLegacyEmpty = prepareAcpSpawn(legacyEmptyProfile, {
      systemPrompt: "Test role",
      toolPolicy: "read_write_workspace",
      allowShellInReadOnly: false,
      tier: 2,
      readDirectories: [],
      writeDirectories: [],
    });
    const legacyEmptyCaptured = JSON.parse(readFileSync(captureLegacyEmpty, "utf8")) as { opencodeConfig: string | null };
    assert.equal(legacyEmptyCaptured.opencodeConfig, expectedLegacyEmpty.env.OPENCODE_CONFIG_CONTENT ?? null);
    expectedLegacyEmpty.cleanup();
  });

  it("FRc: external MCP calls (octofs) refuse denied roots and protected worktrees in data-dir layout while approving allowed/outside/legacy calls", async () => {
    const fx = setupStateLayout();
    const otherChatGoals = join(fx.stateDir, "data", "projects", "p", "chats", "chat-2", "goals", "goal-2");
    const otherChatFile = join(otherChatGoals, "secret.txt");
    mkdirSync(otherChatGoals, { recursive: true });
    writeFileSync(otherChatFile, "chat-2-secret\n", "utf8");
    const outsideDir = makeTempDir("acp-frc-outside-");
    const outsideFile = join(outsideDir, "outside.txt");
    writeFileSync(outsideFile, "outside-ok\n", "utf8");
    const stateSymlink = join(fx.wt1, "link-config.json");
    symlinkSync(fx.cfgFile, stateSymlink);

    type McpCheck = {
      id: string;
      /** When set, emits a Codex `session/update` tool_call first and sends a bare correlated permission request. */
      codexTracked?: { server: string; tool: string; args?: Record<string, unknown> };
      perm: Record<string, unknown>;
    };

    const runChecks = async (
      adapter: AcpProfileConfig["adapter"],
      reqOverrides: Partial<RunAgentRequest>,
      checks: McpCheck[],
    ) => {
      const outcomes: Record<string, string> = {};
      const events: ToolEvent[] = [];
      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: "s-frc",
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          for (const c of checks) {
            if (c.codexTracked) {
              await client.notify("session/update", {
                sessionId,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: c.id,
                  title: `mcp.${c.codexTracked.server}.${c.codexTracked.tool}`,
                  kind: "execute",
                  status: "in_progress",
                  rawInput: {
                    server: c.codexTracked.server,
                    tool: c.codexTracked.tool,
                    ...(c.codexTracked.args ? { arguments: c.codexTracked.args } : {}),
                  },
                  _meta: { is_mcp_tool_call: true },
                },
              });
            }
            outcomes[c.id] = permissionOutcome(
              await client.request("session/request_permission", {
                sessionId,
                options: PERM_OPTIONS,
                ...c.perm,
              } as never),
            );
          }
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(profile(adapter)).run(
        makeBaseRequest({
          cwd: fx.wt1,
          externalMcpServers: [{ name: "octofs", command: "octofs", args: ["mcp"], enabled: true }],
          callbacks: { onToolEvent: (ev) => events.push(ev) },
          ...reqOverrides,
        }),
        fixture,
      );
      return { outcomes, events };
    };

    const claudeView = (id: string, rawInput: Record<string, unknown>): McpCheck => ({
      id,
      perm: {
        toolCall: {
          toolCallId: id,
          title: "mcp__octofs__view",
          kind: "other",
          rawInput,
          _meta: { claudeCode: { toolName: "mcp__octofs__view", mcpServer: { name: "octofs", source: "sdk" } } },
        },
      },
    });

    const codexDirectView = (id: string, args: Record<string, unknown>): McpCheck => ({
      id,
      perm: {
        _meta: { is_mcp_tool_approval: true },
        toolCall: {
          toolCallId: id,
          title: "mcp.octofs.view",
          kind: "execute",
          rawInput: { server: "octofs", tool: "view", arguments: args },
        },
      },
    });

    const codexTrackedCall = (id: string, tool: string, args?: Record<string, unknown>): McpCheck => ({
      id,
      codexTracked: { server: "octofs", tool, args },
      perm: {
        _meta: { is_mcp_tool_approval: true },
        toolCall: {
          toolCallId: id,
          kind: "execute",
          status: "pending",
        },
      },
    });

    // 1. Data-dir layout, read-only Tier 3 task (Claude shape: direct rawInput)
    const claudeDataDir = await runChecks(
      "claude",
      {
        tier: 3,
        kind: "research",
        toolPolicy: "read_only_workspace",
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        deniedRoots: [fx.stateDir],
      },
      [
        claudeView("deny-state-file", { path: fx.cfgFile }),
        claudeView("deny-other-chat", { path: otherChatFile }),
        claudeView("deny-sibling-wt", { path: fx.wt2File }),
        claudeView("deny-relative-sibling", { path: "../t-2/src/secret.ts" }),
        claudeView("deny-symlink-state", { path: stateSymlink }),
        claudeView("deny-pipe-multi", { path: `src/worker.ts|${otherChatFile}` }),
        claudeView("deny-ranges-path", { path: "src/worker.ts", ranges: [{ path: fx.wt2File, start: 1, end: 5 }] }),
        claudeView("allow-ws-rel", { path: "src/worker.ts" }),
        claudeView("allow-ws-abs", { path: fx.wt1File }),
        claudeView("allow-granted-goal", { path: fx.goalFile }),
        claudeView("allow-granted-art", { path: fx.artifactFile }),
        claudeView("allow-outside", { path: outsideFile }),
        claudeView("allow-remote-ssh", { path: "ssh://devbox/etc/hosts" }),
        claudeView("allow-no-path", { flags: "s" }),
      ],
    );

    const claudeDeniedIds = [
      "deny-state-file",
      "deny-other-chat",
      "deny-sibling-wt",
      "deny-relative-sibling",
      "deny-symlink-state",
      "deny-pipe-multi",
      "deny-ranges-path",
    ];
    for (const id of claudeDeniedIds) {
      assert.equal(claudeDataDir.outcomes[id], "deny", `claude data-dir: ${id} must be refused`);
      const ev = claudeDataDir.events.find((e) => e.id === id && e.status === "failed");
      assert.equal(ev?.denied, "protected-path", `claude data-dir: ${id} denied rule`);
      assert.ok(
        ev?.error?.includes(DENIED_HARNESS_STATE_REASON),
        `claude data-dir: ${id} must report harness-state reason, got: ${ev?.error}`,
      );
    }
    for (const id of [
      "allow-ws-rel",
      "allow-ws-abs",
      "allow-granted-goal",
      "allow-granted-art",
      "allow-outside",
      "allow-remote-ssh",
      "allow-no-path",
    ]) {
      assert.equal(claudeDataDir.outcomes[id], "allow", `claude data-dir: ${id} must be approved`);
    }

    // 2. Data-dir layout, Codex shape: both direct request_permission and correlated tool_call -> bare request_permission,
    //    covering read-only (`view`) and write-decision (`text_edit`, where read-only artifactsDir is refused for writes).
    const codexDataDir = await runChecks(
      "codex",
      {
        toolPolicy: "read_write_workspace",
        extraReadRoots: [fx.goalsDir, fx.artifactsDir],
        extraWriteRoots: [fx.goalsDir],
        deniedRoots: [fx.stateDir],
      },
      [
        codexDirectView("codex-direct-deny-state", { path: fx.cfgFile }),
        codexDirectView("codex-direct-allow-art", { path: fx.artifactFile }),
        codexTrackedCall("codex-tracked-deny-view-state", "view", { path: fx.cfgFile }),
        codexTrackedCall("codex-tracked-deny-edit-state", "text_edit", { command: "create", path: fx.cfgFile, content: "x" }),
        codexTrackedCall("codex-tracked-deny-edit-ro-art", "text_edit", { command: "create", path: fx.artifactFile, content: "x" }),
        codexTrackedCall("codex-tracked-deny-edit-sibling", "text_edit", { command: "create", path: "../t-2/escape.txt", content: "x" }),
        codexTrackedCall("codex-tracked-allow-edit-goal", "text_edit", { command: "create", path: fx.goalFile, content: "ok" }),
        codexTrackedCall("codex-tracked-allow-edit-ws", "text_edit", { command: "create", path: "src/new.ts", content: "ok" }),
        codexTrackedCall("codex-tracked-allow-edit-outside", "text_edit", { command: "create", path: outsideFile, content: "ok" }),
      ],
    );

    for (const id of [
      "codex-direct-deny-state",
      "codex-tracked-deny-view-state",
      "codex-tracked-deny-edit-state",
      "codex-tracked-deny-edit-ro-art",
      "codex-tracked-deny-edit-sibling",
    ]) {
      assert.equal(codexDataDir.outcomes[id], "deny", `codex data-dir: ${id} must be refused`);
      const ev = codexDataDir.events.find((e) => e.id === id && e.status === "failed");
      assert.equal(ev?.denied, "protected-path", `codex data-dir: ${id} denied rule`);
      assert.ok(
        ev?.error?.includes(DENIED_HARNESS_STATE_REASON),
        `codex data-dir: ${id} must report harness-state reason, got: ${ev?.error}`,
      );
    }
    for (const id of [
      "codex-direct-allow-art",
      "codex-tracked-allow-edit-goal",
      "codex-tracked-allow-edit-ws",
      "codex-tracked-allow-edit-outside",
    ]) {
      assert.equal(codexDataDir.outcomes[id], "allow", `codex data-dir: ${id} must be approved`);
    }

    // 3. Legacy layout (deniedRoots empty): approves all octofs view calls as today
    const legacyRes = await runChecks(
      "claude",
      {
        cwd: fx.workspace,
        tier: 3,
        kind: "research",
        toolPolicy: "read_only_workspace",
      },
      [
        claudeView("legacy-state", { path: fx.cfgFile }),
        claudeView("legacy-other-chat", { path: otherChatFile }),
        claudeView("legacy-sibling", { path: fx.wt2File }),
        claudeView("legacy-ws", { path: fx.wsFile }),
        claudeView("legacy-outside", { path: outsideFile }),
      ],
    );
    for (const id of ["legacy-state", "legacy-other-chat", "legacy-sibling", "legacy-ws", "legacy-outside"]) {
      assert.equal(legacyRes.outcomes[id], "allow", `legacy layout: ${id} must stay approved`);
    }
  });

  it("D4 (C1): refuses reads and writes when a granted evidence dir is replaced by a symlink to stateDir after or before session start in both layouts", async () => {
    const runReplacementCases = async (layout: "data-dir" | "legacy") => {
      const fx = setupStateLayout();
      const operatorTarget = makeTempDir(`acp-d4-op-target-${layout}-`);
      const operatorLink = join(fx.home, `op-link-${layout}`);
      const operatorFile = join(operatorTarget, "notes.txt");
      writeFileSync(operatorFile, "operator-ok\n", "utf8");
      symlinkSync(operatorTarget, operatorLink);

      const grantDir =
        layout === "data-dir"
          ? fx.goalsDir
          : legacyStoragePaths.goalEvidenceDir({ id: "goal-1", repoRoot: fx.workspace });
      const deniedRoots = layout === "data-dir" ? [fx.stateDir] : [];
      const cwd = layout === "data-dir" ? fx.wt1 : fx.workspace;
      mkdirSync(grantDir, { recursive: true });
      writeFileSync(join(grantDir, "brief.md"), "# Original\n", "utf8");

      // Case 1: grant dir is a real dir at session start, then replaced by a symlink to stateDir mid-session.
      let midReadErr = "";
      let midWriteErr = "";
      let opReadContent = "";
      const midSessionFixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: `s-d4-mid-${layout}`,
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          // Operator root outside denied/legacy storage still resolves normally.
          const opRes = (await client.request("fs/read_text_file", {
            sessionId,
            path: join(operatorLink, "notes.txt"),
          })) as { content: string };
          opReadContent = opRes.content;

          // Replace the granted evidence dir with a symlink pointing directly to stateDir after session root resolution.
          rmSync(grantDir, { recursive: true, force: true });
          symlinkSync(fx.stateDir, grantDir);

          try {
            await client.request("fs/read_text_file", {
              sessionId,
              path: join(grantDir, "config.json"),
            });
          } catch (err) {
            midReadErr = errorDetail(err);
          }

          try {
            await client.request("fs/write_text_file", {
              sessionId,
              path: join(grantDir, "injected.txt"),
              content: "pwned\n",
            });
          } catch (err) {
            midWriteErr = errorDetail(err);
          }

          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(profile("claude")).run(
        makeBaseRequest({
          cwd,
          toolPolicy: "read_write_workspace",
          extraReadRoots: [grantDir, operatorLink],
          extraWriteRoots: [grantDir],
          ...(deniedRoots.length > 0 ? { deniedRoots } : {}),
        }),
        midSessionFixture,
      );

      assert.equal(opReadContent, "operator-ok\n", `${layout}: operator root outside storage must keep normal resolution`);
      assert.ok(midReadErr, `${layout}: mid-session replaced grant dir must refuse read of stateDir/config.json`);
      assert.ok(midWriteErr, `${layout}: mid-session replaced grant dir must refuse write under stateDir`);
      if (layout === "data-dir") {
        assert.ok(midReadErr.includes(DENIED_HARNESS_STATE_REASON), `${layout} mid read reason: ${midReadErr}`);
        assert.ok(midWriteErr.includes(DENIED_HARNESS_STATE_REASON), `${layout} mid write reason: ${midWriteErr}`);
      }
      assert.equal(existsSync(join(fx.stateDir, "injected.txt")), false, `${layout}: mid-session write must not touch stateDir`);

      // Case 2: grant dir is already replaced by a symlink to stateDir BEFORE session start; grant must be dropped.
      let preReadErr = "";
      let preWriteErr = "";
      let seenAdditionalDirs: string[] | undefined;
      const preSessionFixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async ({ params }) => {
          const meta = (params as { _meta?: { claudeCode?: { options?: { additionalDirectories?: string[] } } } })._meta;
          seenAdditionalDirs = meta?.claudeCode?.options?.additionalDirectories;
          return {
            sessionId: `s-d4-pre-${layout}`,
            models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
          };
        })
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          try {
            await client.request("fs/read_text_file", {
              sessionId,
              path: join(grantDir, "config.json"),
            });
          } catch (err) {
            preReadErr = errorDetail(err);
          }

          try {
            await client.request("fs/write_text_file", {
              sessionId,
              path: join(grantDir, "pre-injected.txt"),
              content: "pwned\n",
            });
          } catch (err) {
            preWriteErr = errorDetail(err);
          }

          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(profile("claude")).run(
        makeBaseRequest({
          cwd,
          toolPolicy: "read_write_workspace",
          extraReadRoots: [grantDir, operatorLink],
          extraWriteRoots: [grantDir],
          ...(deniedRoots.length > 0 ? { deniedRoots } : {}),
        }),
        preSessionFixture,
      );

      assert.ok(preReadErr, `${layout}: pre-session replaced grant dir must be dropped and refuse read`);
      assert.ok(preWriteErr, `${layout}: pre-session replaced grant dir must be dropped and refuse write`);
      assert.equal(existsSync(join(fx.stateDir, "pre-injected.txt")), false, `${layout}: pre-session write must not touch stateDir`);
      assert.equal(
        (seenAdditionalDirs ?? []).includes(fx.stateDir),
        false,
        `${layout}: dropped symlinked grant must not advertise stateDir in additionalDirectories: ${JSON.stringify(seenAdditionalDirs)}`,
      );
      assert.equal(
        (seenAdditionalDirs ?? []).includes(grantDir),
        false,
        `${layout}: dropped symlinked grant must not remain in additionalDirectories: ${JSON.stringify(seenAdditionalDirs)}`,
      );
      assert.equal(
        (seenAdditionalDirs ?? []).includes(operatorTarget),
        true,
        `${layout}: operator root outside storage must remain in additionalDirectories: ${JSON.stringify(seenAdditionalDirs)}`,
      );
    };

    await runReplacementCases("data-dir");
    await runReplacementCases("legacy");
  });

  it("D5 (C7): denies explicit shell operands/locations, dir_path native read/search, and kind=read name-only MCP calls without issuing them", async () => {
    const fx = setupStateLayout();
    const otherChatFile = join(fx.stateDir, "data", "projects", "p", "chats", "chat-2", "secret.txt");
    mkdirSync(dirname(otherChatFile), { recursive: true });
    writeFileSync(otherChatFile, "chat2-secret\n", "utf8");

    type PermSpec = {
      id: string;
      toolCall: {
        toolCallId: string;
        name?: string;
        title?: string;
        kind: string;
        locations?: Array<{ path: string }>;
        rawInput?: Record<string, unknown>;
      };
    };

    const runPermBatch = async (
      adapter: AcpProfileConfig["adapter"],
      reqOverrides: Partial<RunAgentRequest>,
      specs: PermSpec[],
    ) => {
      const outcomes: Record<string, string> = {};
      const issuedOps: string[] = [];
      const events: ToolEvent[] = [];
      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: `s-d5-${adapter}`,
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          for (const spec of specs) {
            const outcome = permissionOutcome(
              await client.request("session/request_permission", {
                sessionId,
                toolCall: spec.toolCall,
                options: PERM_OPTIONS,
              }),
            );
            outcomes[spec.id] = outcome;
            if (outcome === "allow") {
              issuedOps.push(spec.id);
            }
          }
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(profile(adapter)).run(
        makeBaseRequest({
          cwd: fx.wt1,
          toolPolicy: "read_write_workspace",
          extraReadRoots: [fx.home, fx.goalsDir, fx.artifactsDir],
          extraWriteRoots: [fx.goalsDir],
          deniedRoots: [fx.stateDir],
          callbacks: { onToolEvent: (ev) => events.push(ev) },
          ...reqOverrides,
        }),
        fixture,
      );
      return { outcomes, issuedOps, events };
    };

    // (a) Shell requests when shell is enabled: explicit path operands and reported locations bound to cwd,
    //     while recursive commands under an allowed ancestor stay unfiltered (B11).
    const shellBatch = await runPermBatch("claude", {}, [
      {
        id: "sh-operand-sibling",
        toolCall: {
          toolCallId: "sh-operand-sibling",
          title: "Bash",
          kind: "execute",
          rawInput: { command: "cat ../t-2/src/secret.ts" },
        },
      },
      {
        id: "sh-operand-cwd-bound",
        toolCall: {
          toolCallId: "sh-operand-cwd-bound",
          title: "Bash",
          kind: "execute",
          rawInput: { command: "cat .pi-harness/config.json", cwd: fx.home },
        },
      },
      {
        id: "sh-location-denied",
        toolCall: {
          toolCallId: "sh-location-denied",
          title: "Bash",
          kind: "execute",
          locations: [{ path: fx.cfgFile }],
          rawInput: { command: "echo inspect", cwd: fx.wt1 },
        },
      },
      {
        id: "sh-allow-ws",
        toolCall: {
          toolCallId: "sh-allow-ws",
          title: "Bash",
          kind: "execute",
          rawInput: { command: "cat src/worker.ts" },
        },
      },
      {
        id: "sh-allow-b11-recursive",
        toolCall: {
          toolCallId: "sh-allow-b11-recursive",
          title: "Bash",
          kind: "execute",
          rawInput: { command: "grep -r hello .", cwd: fx.home },
        },
      },
    ]);

    for (const id of ["sh-operand-sibling", "sh-operand-cwd-bound", "sh-location-denied"]) {
      assert.equal(shellBatch.outcomes[id], "deny", `D5(a) ${id} must be denied`);
      assert.equal(shellBatch.issuedOps.includes(id), false, `D5(a) ${id} must not be issued`);
      const ev = shellBatch.events.find((e) => e.id === id && e.status === "failed");
      assert.equal(ev?.denied, "protected-path", `D5(a) ${id} denied rule`);
      assert.ok(ev?.error?.includes(DENIED_HARNESS_STATE_REASON), `D5(a) ${id} reason: ${ev?.error}`);
    }
    for (const id of ["sh-allow-ws", "sh-allow-b11-recursive"]) {
      assert.equal(shellBatch.outcomes[id], "allow", `D5(a) ${id} must be allowed`);
      assert.equal(shellBatch.issuedOps.includes(id), true, `D5(a) ${id} should be issued`);
    }

    // (b) Native read or search carrying dir_path (no locations) must validate the directory like a file path.
    const dirBatch = await runPermBatch("claude", {}, [
      {
        id: "search-dir-path-state",
        toolCall: {
          toolCallId: "search-dir-path-state",
          title: "Search",
          kind: "search",
          rawInput: { dir_path: fx.stateDir, pattern: "secret" },
        },
      },
      {
        id: "read-dir-path-sibling",
        toolCall: {
          toolCallId: "read-dir-path-sibling",
          title: "ListDir",
          kind: "read",
          rawInput: { dir_path: fx.wt2 },
        },
      },
      {
        id: "search-dir-path-goal-ok",
        toolCall: {
          toolCallId: "search-dir-path-goal-ok",
          title: "Search",
          kind: "search",
          rawInput: { dir_path: fx.goalsDir, pattern: "Goal" },
        },
      },
    ]);

    for (const id of ["search-dir-path-state", "read-dir-path-sibling"]) {
      assert.equal(dirBatch.outcomes[id], "deny", `D5(b) ${id} must be denied`);
      assert.equal(dirBatch.issuedOps.includes(id), false, `D5(b) ${id} must not be issued`);
      const ev = dirBatch.events.find((e) => e.id === id && e.status === "failed");
      assert.equal(ev?.denied, "protected-path", `D5(b) ${id} denied rule`);
      assert.ok(ev?.error?.includes(DENIED_HARNESS_STATE_REASON), `D5(b) ${id} reason: ${ev?.error}`);
    }
    assert.equal(dirBatch.outcomes["search-dir-path-goal-ok"], "allow");
    assert.equal(dirBatch.issuedOps.includes("search-dir-path-goal-ok"), true);

    // (c) Generic name-only MCP call reported with kind="read" must be classified as external
    //     and inspect nested arguments/ranges via the FRc path.
    const mcpBatch = await runPermBatch(
      "generic",
      {
        tier: 3,
        kind: "research",
        toolPolicy: "read_only_workspace",
        extraWriteRoots: undefined,
        externalMcpServers: [{ name: "octofs", command: "unused", args: [] }],
      },
      [
        {
          id: "mcp-read-nested-ranges",
          toolCall: {
            toolCallId: "mcp-read-nested-ranges",
            name: "mcp__octofs__view",
            kind: "read",
            rawInput: {
              arguments: {
                path: "src/worker.ts",
                ranges: [{ path: fx.cfgFile, start: 1, end: 5 }],
              },
            },
          },
        },
        {
          id: "mcp-read-nested-other-chat",
          toolCall: {
            toolCallId: "mcp-read-nested-other-chat",
            name: "octofs:view",
            kind: "read",
            rawInput: {
              arguments: {
                path: otherChatFile,
              },
            },
          },
        },
        {
          id: "mcp-read-allow-goal",
          toolCall: {
            toolCallId: "mcp-read-allow-goal",
            name: "mcp__octofs__view",
            kind: "read",
            rawInput: {
              arguments: {
                path: fx.goalFile,
                ranges: [{ path: "src/worker.ts", start: 1, end: 2 }],
              },
            },
          },
        },
      ],
    );

    for (const id of ["mcp-read-nested-ranges", "mcp-read-nested-other-chat"]) {
      assert.equal(mcpBatch.outcomes[id], "deny", `D5(c) ${id} must be denied`);
      assert.equal(mcpBatch.issuedOps.includes(id), false, `D5(c) ${id} must not be issued`);
      const ev = mcpBatch.events.find((e) => e.id === id && e.status === "failed");
      assert.equal(ev?.denied, "protected-path", `D5(c) ${id} denied rule`);
      assert.ok(ev?.error?.includes(DENIED_HARNESS_STATE_REASON), `D5(c) ${id} reason: ${ev?.error}`);
    }
    assert.equal(mcpBatch.outcomes["mcp-read-allow-goal"], "allow");
    assert.equal(mcpBatch.issuedOps.includes("mcp-read-allow-goal"), true);
  });

  it("FR3 (E1): admits ordinary workspace shell commands in both layouts and enforces write grants on explicit shell write targets in data-dir", async () => {
    const runForLayout = async (layout: StorageLayout) => {
      const home = makeTempDir(`acp-fr3-${layout}-`);
      const repo = join(home, "repo");
      const stateDir = join(home, ".pi-harness");
      mkdirSync(repo, { recursive: true });
      mkdirSync(stateDir, { recursive: true });
      const cfgFile = join(stateDir, "config.json");
      writeFileSync(cfgFile, '{"secret":true}\n', "utf8");

      const sp = new StoragePaths({ stateDir }, layout);
      const run = { id: "run-1", repoRoot: repo, chatSessionId: "chat-1" };
      const goal = { id: "goal-1", repoRoot: repo, chatSessionId: "chat-1", linkedRunId: "run-1" };

      const wt1 = sp.worktreePath(run, "t-1");
      const wt2 = sp.worktreePath(run, "t-2");
      mkdirSync(join(wt1, "src"), { recursive: true });
      mkdirSync(join(wt1, ".git"), { recursive: true });
      mkdirSync(wt2, { recursive: true });
      writeFileSync(join(wt1, "README.md"), "# Readme\n", "utf8");
      writeFileSync(join(wt1, "src", "index.ts"), "export const foo = 1;\n", "utf8");
      writeFileSync(join(wt1, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
      const siblingFile = join(wt2, "file");
      writeFileSync(siblingFile, "sibling-secret\n", "utf8");

      const projectNotesDir = sp.projectNotesDir(repo);
      mkdirSync(projectNotesDir, { recursive: true });
      const noteFile = join(projectNotesDir, "n.md");
      writeFileSync(noteFile, "# Project note\n", "utf8");

      const grants = sp.taskGrants({ run, goal, writable: true });
      const ownEvidenceDir = grants.extraEnv?.HARNESS_GOAL_EVIDENCE_DIR ?? sp.goalEvidenceDir(goal);
      mkdirSync(ownEvidenceDir, { recursive: true });
      const evidenceOut = join(ownEvidenceDir, "out.txt");
      if (layout === "data-dir") {
        assert.ok(grants.extraReadRoots.includes(projectNotesDir), "data-dir worker must have read grant on project notes");
        assert.ok(!(grants.extraWriteRoots ?? []).includes(projectNotesDir), "data-dir worker must not have write grant on project notes");
        assert.ok((grants.extraWriteRoots ?? []).includes(ownEvidenceDir), "data-dir writable worker must have write grant on own evidence dir");
      }

      const specs: Array<{ id: string; command: string; expect: "allow" | "deny" }> = [
        { id: "ls-ignore-git", command: "ls --ignore=.git", expect: "allow" },
        { id: "cd-src-cat-readme", command: "cd src && cat ../README.md", expect: "allow" },
        { id: "grep-exclude-dir-git", command: "grep -r --exclude-dir=.git foo .", expect: "allow" },
        { id: "git-status", command: "git status", expect: "allow" },
        { id: "cat-git-head", command: "cat .git/HEAD", expect: "allow" },
      ];
      if (layout === "data-dir") {
        specs.push(
          { id: "cat-project-notes", command: `cat "${noteFile}"`, expect: "allow" },
          { id: "echo-own-evidence", command: `echo x > "${evidenceOut}"`, expect: "allow" },
          { id: "cat-state-config", command: `cat "${cfgFile}"`, expect: "deny" },
          { id: "cd-state-cat-config", command: `cd "${stateDir}" && cat config.json`, expect: "deny" },
          { id: "echo-project-notes-ro", command: `echo x > "${noteFile}"`, expect: "deny" },
          { id: "cat-sibling-wt", command: `cat "${siblingFile}"`, expect: "deny" },
        );
      }

      const outcomes: Record<string, string> = {};
      const events: ToolEvent[] = [];
      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: `s-fr3-${layout}`,
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          for (const spec of specs) {
            outcomes[spec.id] = permissionOutcome(
              await client.request("session/request_permission", {
                sessionId,
                toolCall: {
                  toolCallId: spec.id,
                  title: "Bash",
                  kind: "execute",
                  rawInput: { command: spec.command },
                },
                options: PERM_OPTIONS,
              }),
            );
          }
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(profile("claude")).run(
        makeBaseRequest({
          cwd: wt1,
          toolPolicy: "read_write_workspace",
          extraReadRoots: grants.extraReadRoots,
          extraWriteRoots: grants.extraWriteRoots,
          deniedRoots: grants.deniedRoots,
          protectedRoots: grants.protectedRoots,
          callbacks: { onToolEvent: (ev) => events.push(ev) },
        }),
        fixture,
      );

      for (const spec of specs) {
        assert.equal(outcomes[spec.id], spec.expect, `${layout}: ${spec.id} (${spec.command}) expected ${spec.expect}, got ${outcomes[spec.id]}`);
        if (spec.expect === "deny") {
          const ev = events.find((e) => e.id === spec.id && e.status === "failed");
          assert.equal(ev?.denied, "protected-path", `${layout}: ${spec.id} denied rule`);
          assert.ok(ev?.error?.includes(DENIED_HARNESS_STATE_REASON), `${layout}: ${spec.id} reason: ${ev?.error}`);
        }
      }
    };

    await runForLayout("legacy");
    await runForLayout("data-dir");
  });
});
