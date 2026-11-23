import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { loadConfig, type AcpProfileConfig } from "../src/config.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { AcpRunner, describeToolPolicyMode, detectCodexCodeModeMisconfig } from "../src/runners/acp-runner.js";
import {
  buildNewSessionParams,
  buildPostSessionActions,
  hasCodexCodeModeHost,
  isReadOnlyExternalMcpTool,
  isSafeReadOnlyShellCommand,
  prepareAcpSpawn,
} from "../src/runners/acp-shims.js";
import { detectQuotaErrorText } from "../src/runners/quota-detect.js";
import type { PassiveQuotaSignal, RunAgentRequest, RunnerExecutionHandle, RunnerUsage } from "../src/runners/types.js";

const claudeAgent = { name: "@agentclientprotocol/claude-agent-acp", version: "0.109.0" };
const profile = (adapter: AcpProfileConfig["adapter"]): AcpProfileConfig => ({
  id: `acp:${adapter}`, kind: "acp", adapter, command: "unused", billing: "subscription",
});

describe("ACP role policies", () => {
  const request: RunAgentRequest = {
    // Director and T1 both call the runner as tier 1, with different tool inventories.
    runId: "fixture", taskId: "fixture", tier: 1, kind: "orchestrator", toolPolicy: "control_plane_only",
    cwd: process.cwd(), systemPrompt: "Fixture role", initialPrompt: "Fixture turn", model: "opus", maxTurns: 1,
    tools: [], executeTool: async () => ({}), signal: new AbortController().signal, callbacks: {},
  };

  it("runs every adapter with the file capabilities for the selected role", async () => {
    for (const adapter of ["claude", "codex", "gemini", "generic"] as const) {
      const runner = new AcpRunner(profile(adapter));
      for (const [role, readTextFile, writeTextFile] of [
        [request, false, false],
        [{ ...request, tier: 3, kind: "research", toolPolicy: "read_only_workspace" }, true, false],
        [{ ...request, tier: 2, kind: "worker", toolPolicy: "read_write_workspace" }, true, true],
      ] as const) {
        const fixture = agent().onRequest("initialize", async ({ params }) => {
          assert.deepEqual(params.clientCapabilities?.fs, { readTextFile, writeTextFile });
          return { protocolVersion: 1, agentCapabilities: {} };
        }).onRequest("session/new", async () => ({
          sessionId: "fixture", models: {
            currentModelId: adapter === "gemini" ? "previous" : role.model,
            availableModels: [{ modelId: role.model, name: role.model }],
          },
        })).onRequest("*", async ({ method, params }) => {
          assert.equal(method, "session/set_model");
          assert.deepEqual(params, { sessionId: "fixture", modelId: role.model });
          return {};
        }).onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } });
          return { stopReason: "end_turn" };
        });
        const result = await runner.run(role, fixture);
        assert.equal(result.text, "ok", `${adapter} ${role.toolPolicy}`);
      }
    }
  });

  for (const [role, roleTool, bridge] of [["Director", "goal_list", true], ["T1", "tree_view", true], ["T1 without bridge", "tree_view", false]] as const) {
    it(`disables native tools and gates role MCP permissions for ${role}`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), "acp-policy-"));
      const path = join(cwd, "fixture.txt");
      try {
        writeFileSync(path, "original");
        const fixture = agent().onRequest("initialize", async ({ params }) => {
          assert.deepEqual(params.clientCapabilities?.fs, { readTextFile: false, writeTextFile: false });
          return { protocolVersion: 1, agentCapabilities: {}, agentInfo: claudeAgent };
        }).onRequest("session/new", async ({ params }) => {
          const options = (params._meta?.claudeCode as { options: { tools: string[]; disallowedTools: string[]; strictMcpConfig: boolean } }).options;
          assert.deepEqual(options.tools, ["ToolSearch"]);
          assert.equal(options.strictMcpConfig, true);
          for (const tool of ["Read", "Grep", "Glob", "Bash", "Write", "Edit", "Agent", "Task"]) assert.ok(options.disallowedTools.includes(tool), tool);
          assert.deepEqual(params.mcpServers.map(s => s.name), bridge ? ["harness"] : []);
          return { sessionId: "fixture", models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] } };
        }).onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          const ctrlMode = describeToolPolicyMode("control_plane_only", false);
          await assert.rejects(client.request("fs/read_text_file", { sessionId, path }), { data: { details: `Read denied: agent is running in ${ctrlMode} mode` } });
          await assert.rejects(client.request("fs/write_text_file", { sessionId, path, content: "changed" }), { data: { details: `Write denied: agent is running in ${ctrlMode} mode` } });
          const permission = async (kind: "read" | "search" | "edit" | "execute" | "other", tool?: string) => {
            const res = await client.request("session/request_permission", {
              sessionId, toolCall: { toolCallId: `call-${kind}-${tool ?? "native"}`, title: roleTool, kind, locations: [{ path }],
                ...(tool && { _meta: { claudeCode: { toolName: `mcp__harness__${tool}`, mcpServer: { name: "harness", source: "dynamic" } } } }),
              }, options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "deny", name: "Deny" }],
            });
            return res.outcome.outcome === "selected" ? res.outcome.optionId : res.outcome.outcome;
          };
          for (const kind of ["read", "search", "edit", "execute", "other"] as const) assert.equal(await permission(kind), "deny", kind);
          assert.equal(await permission("other", "unlisted"), "deny");
          assert.equal(await permission("other", roleTool), bridge ? "allow" : "deny");
          await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "checked" } } });
          return { stopReason: "end_turn" };
        });
        const result = await new AcpRunner(profile("claude")).run({ ...request, cwd,
          ...(bridge && { daemonSocketPath: "/unused/socket", mcpBridgeEntrypoint: "/unused/bridge" }),
          tools: [{ name: roleTool, description: roleTool, inputSchema: {} }],
        }, fixture);
        assert.equal(result.text, "checked");
        assert.equal(readFileSync(path, "utf8"), "original");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});

describe("ACP Shims, Live Rollover/Artifact Telemetry & Daemon Attach/Detach", () => {
  it("applies the 4 verified per-adapter shims cleanly (Claude, Codex, Gemini)", () => {
    // 1. Claude shim: disallowedTools + DISABLE_COMPACT + initial configOptions
    const claudeProfile: AcpProfileConfig = {
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "claude-agent-acp",
      billing: "subscription",
    };
    const claudeSpawn = prepareAcpSpawn(claudeProfile, { systemPrompt: "Role", toolPolicy: "read_write_workspace" });
    assert.equal(claudeSpawn.env.DISABLE_COMPACT, "1");
    claudeSpawn.cleanup();

    const claudeNew = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "claude-opus-5-5",
      effort: "high",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { options: {} } },
    });
    const meta = (claudeNew.params._meta as { claudeCode: { options: { disallowedTools: string[] } } }).claudeCode.options;
    assert.ok(meta.disallowedTools.includes("Agent"));
    for (const tool of ["Write", "Edit", "Bash"]) assert.ok(!meta.disallowedTools.includes(tool), tool);

    // 2. Writable Codex still blocks internal multi_agent and configures model + effort.
    const codexProfile: AcpProfileConfig = {
      id: "acp:codex",
      kind: "acp",
      adapter: "codex",
      command: "codex-acp",
      billing: "subscription",
    };
    const codexSpawn = prepareAcpSpawn(codexProfile, { systemPrompt: "Role", toolPolicy: "read_write_workspace" });
    assert.ok(codexSpawn.args.includes("features.multi_agent=false"));
    assert.equal(codexSpawn.env.DISABLE_MCP_CONFIG_FILTERING, "true");
    assert.equal(JSON.parse(codexSpawn.env.CODEX_CONFIG ?? "{}").features?.multi_agent, false);
    codexSpawn.cleanup();

    const codexNew = buildNewSessionParams("codex", {
      cwd: "/tmp",
      systemPrompt: "Role",
      toolPolicy: "control_plane_only",
      model: "gpt-6.2-sol",
      mcpServers: [{ name: "harness", command: "bun", args: ["bridge.ts"], env: [] }],
    });
    assert.equal((codexNew.params._meta as { mcpStartupAwaitTimeoutMs?: number })?.mcpStartupAwaitTimeoutMs, 15_000);

    const codexPost = buildPostSessionActions("codex", "s1", {}, { toolPolicy: "read_write_workspace", model: "gpt-6.2-sol", effort: "high" });
    assert.deepEqual(codexPost.map(action => action.params.configId), ["model", "reasoning_effort"]);

    // Codex legacy bracketed currentModelId (`gpt-6.2-sol[high]`) does not conflict with bare configOption `gpt-6.2-sol`
    const codexNoop = buildPostSessionActions(
      "codex",
      "s1",
      {
        configOptions: [{ id: "model", category: "model", currentValue: "gpt-6.2-sol", options: [{ value: "gpt-6.2-sol" }] }],
        models: { currentModelId: "gpt-6.2-sol[high]" },
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6.2-sol" },
    );
    assert.deepEqual(codexNoop, []);

    // 2b. Amp ACP shim: temp AMP_SETTINGS_FILE enforces control_plane_only / read_only_workspace policies
    const ampProfile: AcpProfileConfig = {
      id: "acp:amp",
      kind: "acp",
      adapter: "generic",
      command: "amp-acp",
      billing: "subscription",
    };
    const ampCtrlSpawn = prepareAcpSpawn(ampProfile, { systemPrompt: "Role", toolPolicy: "control_plane_only" });
    assert.ok(ampCtrlSpawn.env.AMP_SETTINGS_FILE);
    const ampCfg = JSON.parse(readFileSync(ampCtrlSpawn.env.AMP_SETTINGS_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(ampCfg["amp.dangerouslyAllowAll"], false);
    assert.deepEqual(ampCfg["amp.tools.enable"], ["mcp__harness__*"]);
    const ctrlDisabled = ampCfg["amp.tools.disable"] as string[];
    for (const t of ["Bash", "shell_command", "shell_command_status", "shell_command_kill", "edit_file", "create_file", "apply_patch", "Task"]) {
      assert.ok(ctrlDisabled.includes(t), `control_plane_only should disable ${t}`);
    }
    ampCtrlSpawn.cleanup();

    // Regression for esc-19 / esc-20: Amp read_only_workspace (allowShellInReadOnly=false) must NOT disable
    // `shell_command` (Amp has no built-in Read/Grep/glob tools), and must instead disable write/subagent tools
    // while enforcing a strict read-only `amp.permissions` allowlist with `amp.dangerouslyAllowAll: false`.
    const ampRoSpawn = prepareAcpSpawn(ampProfile, {
      systemPrompt: "Research",
      toolPolicy: "read_only_workspace",
      allowShellInReadOnly: false,
    });
    assert.ok(ampRoSpawn.env.AMP_SETTINGS_FILE);
    const ampRoCfg = JSON.parse(readFileSync(ampRoSpawn.env.AMP_SETTINGS_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(ampRoCfg["amp.dangerouslyAllowAll"], false);
    const roDisabled = ampRoCfg["amp.tools.disable"] as string[];
    assert.ok(!roDisabled.includes("shell_command"), "read_only_workspace must keep shell_command enabled for Amp");
    assert.ok(!roDisabled.includes("Bash"), "read_only_workspace must keep Bash enabled for Amp");
    for (const t of ["edit_file", "create_file", "delete_file", "apply_patch", "Task", "create_thread"]) {
      assert.ok(roDisabled.includes(t), `read_only_workspace must disable ${t}`);
    }
    const roPerms = ampRoCfg["amp.permissions"] as Array<{ tool: string; action: string; matches?: Record<string, string[]> }>;
    assert.ok(Array.isArray(roPerms) && roPerms.length >= 6);
    const shellRules = roPerms.filter((r) => r.tool === "shell_command");
    assert.equal(shellRules.length, 3);
    assert.equal(shellRules[0]?.action, "reject");
    assert.ok(shellRules[0]?.matches?.command?.includes("*>*"));
    assert.ok(shellRules[0]?.matches?.command?.includes("*&&*"));
    assert.equal(shellRules[1]?.action, "allow");
    assert.ok(shellRules[1]?.matches?.command?.includes("rg *"));
    assert.ok(shellRules[1]?.matches?.command?.includes("cat *"));
    assert.ok(shellRules[1]?.matches?.command?.includes("git status *"));
    assert.equal(shellRules[2]?.action, "reject");
    assert.equal(shellRules[2]?.matches, undefined);
    ampRoSpawn.cleanup();

    // Amp read_only_workspace with allowShellInReadOnly=true (verify / Done-Review) disables/rejects write tools without restricting shell
    const ampVerifySpawn = prepareAcpSpawn(ampProfile, {
      systemPrompt: "Verify",
      toolPolicy: "read_only_workspace",
      allowShellInReadOnly: true,
    });
    assert.ok(ampVerifySpawn.env.AMP_SETTINGS_FILE);
    const ampVerifyCfg = JSON.parse(readFileSync(ampVerifySpawn.env.AMP_SETTINGS_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(ampVerifyCfg["amp.dangerouslyAllowAll"], false);
    const verifyPerms = ampVerifyCfg["amp.permissions"] as Array<{ tool: string; action: string }>;
    assert.ok(verifyPerms.some((r) => r.tool === "edit_file" && r.action === "reject"));
    assert.ok(verifyPerms.some((r) => r.tool === "shell_command" && r.action === "allow"));
    assert.ok(!verifyPerms.some((r) => r.tool === "shell_command" && r.action === "reject"));
    assert.ok((ampVerifyCfg["amp.tools.disable"] as string[]).includes("apply_patch"));
    assert.ok(!(ampVerifyCfg["amp.tools.disable"] as string[]).includes("shell_command"));
    ampVerifySpawn.cleanup();

    // 3. Gemini shim: GEMINI_SYSTEM_MD env file + legacy session/set_model
    const geminiProfile: AcpProfileConfig = {
      id: "acp:gemini",
      kind: "acp",
      adapter: "gemini",
      command: "gemini",
      args: ["--acp"],
      billing: "subscription",
    };
    const geminiSpawn = prepareAcpSpawn(geminiProfile, { systemPrompt: "Gemini role", toolPolicy: "read_write_workspace" });
    assert.ok(geminiSpawn.env.GEMINI_SYSTEM_MD?.endsWith("system.md"));
    geminiSpawn.cleanup();

    const geminiPost = buildPostSessionActions("gemini", "s1", {}, { toolPolicy: "read_write_workspace", model: "gemini-4-neon" });
    assert.equal(geminiPost.find((a) => a.method === "session/set_model")?.params.modelId, "gemini-4-neon");
  });

  it("streams ACP updates, triggers rollover on usage_update >= threshold, indexes Gemini-style artifacts, and harvests passive _claude/rateLimit", async () => {
    let cancelReceived = false;
    let permDeniedForWrite = false;
    let permAllowedForHarnessMcp = false;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({
        protocolVersion: 1,
        agentInfo: claudeAgent,
        agentCapabilities: { sessionCapabilities: { systemPrompt: {}, options: {} } },
        _meta: { steering: { supported: true } },
      } as never))
      .onRequest("session/new", async () => ({ sessionId: "sess-1", models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] } } as never))
      .onRequest("session/set_mode", async () => ({}))
      .onNotification("session/cancel", async () => {
        cancelReceived = true;
      })
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        // Control-plane permission enforcement: write denied, harness MCP allowed
        const writePerm = (await acpClient.request("session/request_permission", {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-w", title: "Write file", kind: "edit" },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        } as never)) as unknown as { outcome: { optionId?: string } };
        permDeniedForWrite = writePerm.outcome.optionId === "deny";

        const mcpPerm = (await acpClient.request("session/request_permission", {
          sessionId: "sess-1",
          toolCall: { toolCallId: "tc-m", title: "harness: tree_view", kind: "other", _meta: { claudeCode: { toolName: "mcp__harness__tree_view", mcpServer: { name: "harness", source: "dynamic" } } } },
          options: [
            { optionId: "allow", kind: "allow_once", name: "Allow" },
            { optionId: "deny", kind: "reject_once", name: "Deny" },
          ],
        } as never)) as unknown as { outcome: { optionId?: string } };
        permAllowedForHarnessMcp = mcpPerm.outcome.optionId === "allow";

        // Emit Gemini-style tool_call_update (NO rawInput/rawOutput, only kind + locations + diff)
        await acpClient.notify("session/update", {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-1",
            kind: "read",
            status: "completed",
            title: "Read auth.ts",
            locations: [{ path: "src/auth.ts", line: 12 }],
          },
        } as never);

        // Emit usage_update crossing 65% threshold + passive `_claude/rateLimit`
        await acpClient.notify("session/update", {
          sessionId: "sess-1",
          update: {
            sessionUpdate: "usage_update",
            used: 70_000,
            size: 100_000,
            _meta: {
              "_claude/rateLimit": { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.85 },
            },
          },
        } as never);

        await new Promise((r) => setTimeout(r, 20));
        return { stopReason: cancelReceived ? "cancelled" : "end_turn" } as never;
      });

    const runner = new AcpRunner({
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "noop",
      billing: "subscription",
    });

    const artifacts: Array<{ kind: string; path: string }> = [];
    const passiveQuotas: PassiveQuotaSignal[] = [];
    let observedUsage: RunnerUsage | undefined;

    const result = await runner.run(
      {
        runId: "run-1",
        taskId: "t-1",
        tier: 1,
        kind: "orchestrator",
        cwd: process.cwd(),
        toolPolicy: "control_plane_only",
        systemPrompt: "sys",
        initialPrompt: "hello",
        maxTurns: 5,
        rolloverThreshold: 0.65,
        model: "opus",
        daemonSocketPath: "/unused/socket",
        mcpBridgeEntrypoint: "/unused/bridge.ts",
        tools: [{ name: "tree_view", description: "View task tree", inputSchema: {} }],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {
          onArtifact: (a) => artifacts.push({ kind: a.kind, path: a.path }),
          onPassiveQuota: (q) => passiveQuotas.push(q),
          onUsage: (u) => (observedUsage = u),
        },
      },
      mockAgent,
    );

    assert.equal(permDeniedForWrite, true);
    assert.equal(permAllowedForHarnessMcp, true);
    assert.equal(cancelReceived, true);
    assert.equal(result.stopReason, "rollover_requested");
    assert.equal(observedUsage?.used, 70_000);
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0]?.path, "src/auth.ts");
    assert.equal(passiveQuotas.length, 1);
  });

  it("supports daemon attach, detach, and cursor-based sinceSeq event replay across reconnects", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-d-"));
    const sockPath = join(stateDir, "d.sock");
    const config = { ...loadConfig(), stateDir, socketPath: sockPath };
    const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });

    await daemon.start();
    try {
      const run = daemon.db.createRun({ goal: "Persist across detach", repoRoot: stateDir, baseBranch: "main", baseSha: "abc" });
      const ev1 = daemon.db.emitEvent(run.id, null, "agent.text_delta", { text: "first" });

      const c1 = new DaemonClient(sockPath);
      await c1.connect();
      const att1 = (await c1.request("attach", { runId: run.id, sinceSeq: 0 })) as { replay: Array<{ seq: number }> };
      assert.ok(att1.replay.some((e) => e.seq === ev1.seq));
      c1.close(); // Simulate terminal closing!

      // Events keep accumulating in daemon while no client is attached
      const ev2 = daemon.db.emitEvent(run.id, null, "agent.text_delta", { text: "while-detached" });

      // New client reattaches with sinceSeq = ev1.seq and receives only missed events
      const c2 = new DaemonClient(sockPath);
      await c2.connect();
      const att2 = (await c2.request("attach", { runId: run.id, sinceSeq: ev1.seq })) as {
        replay: Array<{ seq: number; payload: { text: string } }>;
      };
      assert.equal(att2.replay.length, 1);
      assert.equal(att2.replay[0]?.seq, ev2.seq);
      assert.equal(att2.replay[0]?.payload.text, "while-detached");
      c2.close();
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("supports exclusive session takeover, default-to-last session, sessions.list, and idle session.leave detection", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-takeover-"));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(), stateDir, socketPath: sockPath });
    const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });

    await daemon.start();
    try {
      const c1 = new DaemonClient(sockPath);
      const c2 = new DaemonClient(sockPath);
      await c1.connect();
      await c2.connect();

      const evictedEvents: Array<{ type: string; payload: unknown }> = [];
      c1.onEvent((ev) => evictedEvents.push({ type: ev.type, payload: ev.payload }));

      const s1 = (await c1.request("chat.open", { repoRoot: stateDir })) as { session: { id: string } };
      const s2 = (await c1.request("chat.create", { repoRoot: stateDir, title: "Second Session" })) as {
        session: { id: string };
      };
      assert.notEqual(s1.session.id, s2.session.id);

      // Default chat.open should now resolve to s2 (the last session) AND take over from c1!
      const taken = (await c2.request("chat.open", { repoRoot: stateDir })) as {
        session: { id: string };
        tookOver: boolean;
      };
      assert.equal(taken.session.id, s2.session.id);
      assert.equal(taken.tookOver, true);

      // Wait briefly for `session.taken_over` frame to arrive on c1
      await new Promise((r) => setTimeout(r, 40));
      assert.ok(evictedEvents.some((e) => e.type === "session.taken_over"));

      const listed = (await c2.request("sessions.list")) as Array<{
        id: string;
        attached: boolean;
        attachedByMe: boolean;
      }>;
      const entry2 = listed.find((s) => s.id === s2.session.id);
      assert.equal(entry2?.attached, true);
      assert.equal(entry2?.attachedByMe, true);

      // Switching c2 to s1 makes s1 the most-recent session
      await c2.request("chat.open", { repoRoot: stateDir, chatSessionId: s1.session.id });
      const leaveRes = (await c2.request("session.leave")) as { running: boolean };
      assert.equal(leaveRes.running, false);

      c1.close();
      c2.close();
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns rollover_requested when handle.cancel('clean_rollover') causes session/prompt to reject", async () => {
    let handle: RunnerExecutionHandle | undefined;
    let rejectPrompt: ((err: Error) => void) | undefined;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-rollover",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      } as never))
      .onNotification("session/cancel", async () => {
        rejectPrompt?.(new Error("Request cancelled (-32800)"));
      })
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        await acpClient.notify("session/update", {
          sessionId: "sess-rollover",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Handoff saved." } },
        } as never);
        const promptWait = new Promise<never>((_resolve, reject) => {
          rejectPrompt = reject;
        });
        void handle?.cancel("clean_rollover");
        return await promptWait;
      });

    const result = await new AcpRunner(profile("claude")).run(
      {
        runId: "r-roll",
        taskId: "t-roll",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_write_workspace",
        systemPrompt: "Worker",
        initialPrompt: "Work",
        model: "opus",
        maxTurns: 5,
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
        onHandle: (h) => {
          handle = h;
        },
      },
      mockAgent,
    );

    assert.equal(result.stopReason, "rollover_requested");
    assert.equal(result.text, "Handoff saved.");
  });

  it("returns quota_paused (not completed) when Claude emits _claude/rateLimit rejected + explanation text + end_turn", async () => {
    const futureSec = Math.floor((Date.now() + 600_000) / 1000);
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentInfo: claudeAgent } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-rl",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        await acpClient.notify("session/update", {
          sessionId: "sess-rl",
          update: {
            sessionUpdate: "usage_update",
            used: 500,
            size: 200_000,
            _meta: { "_claude/rateLimit": { status: "rejected", rateLimitType: "five_hour", resetsAt: futureSec } },
          },
        } as never);
        await acpClient.notify("session/update", {
          sessionId: "sess-rl",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "You've hit your five-hour limit · resets later today." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const result = await new AcpRunner(profile("claude")).run(
      {
        runId: "r-rl",
        taskId: "t-rl",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_write_workspace",
        systemPrompt: "Worker",
        initialPrompt: "Work",
        model: "opus",
        maxTurns: 5,
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
      },
      mockAgent,
    );

    assert.equal(result.stopReason, "quota_paused");
    assert.ok(result.quotaPause);
    assert.equal(result.quotaPause?.isHardExhaustion, true);
    assert.equal(result.quotaPause?.resetAt, new Date(futureSec * 1000).toISOString());
  });

  it("tightens 429 detection so port/line numbers do not false-trigger while HTTP 429 still matches", () => {
    assert.equal(detectQuotaErrorText("Listening on port 429").isQuota, false);
    assert.equal(detectQuotaErrorText("SyntaxError at src/index.ts line 429").isQuota, false);
    assert.equal(detectQuotaErrorText("Process pid 429 exited cleanly").isQuota, false);

    const http429 = detectQuotaErrorText("HTTP 429 Too Many Requests");
    assert.equal(http429.isQuota, true);
    assert.equal(http429.isHardExhaustion, false);

    assert.equal(detectQuotaErrorText("API returned status 429").isQuota, true);
    assert.equal(detectQuotaErrorText("error code: 429").isQuota, true);
  });

  it("enforces maxTurns, avoids duplicating generic systemPrompt, evaluates PromptResponse.usage rollover, and allows nested new workspace directories while blocking symlink escapes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "acp-hardening-"));
    const outside = mkdtempSync(join(tmpdir(), "acp-outside-"));
    try {
      symlinkSync(outside, join(cwd, "escape-link"));
      let receivedPrompt = "";
      let nestedAllowed = false;
      let escapeDenied = false;

      const genericAgent = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { systemPrompt: {} } },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-gen",
          models: { currentModelId: "amp-model", availableModels: [{ modelId: "amp-model", name: "Amp" }] },
        } as never))
        .onRequest("session/prompt", async ({ client: acpClient, params }) => {
          const p = params as unknown as { prompt?: Array<{ text?: string }> };
          receivedPrompt = p.prompt?.[0]?.text ?? "";
          const nested = await acpClient.request("session/request_permission", {
            sessionId: "sess-gen",
            toolCall: { toolCallId: "c1", title: "edit", kind: "edit", locations: [{ path: join(cwd, "newdir/sub/file.ts") }] },
            options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "deny", name: "Deny" }],
          });
          nestedAllowed = nested.outcome.outcome === "selected" && nested.outcome.optionId === "allow";
          const esc = await acpClient.request("session/request_permission", {
            sessionId: "sess-gen",
            toolCall: { toolCallId: "c2", title: "edit", kind: "edit", locations: [{ path: join(cwd, "escape-link/newdir/file.ts") }] },
            options: [{ kind: "allow_once", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "deny", name: "Deny" }],
          });
          escapeDenied = esc.outcome.outcome === "selected" && esc.outcome.optionId === "deny";
          return { stopReason: "end_turn", usage: { totalTokens: 80_000, inputTokens: 70_000, outputTokens: 10_000 } } as never;
        });

      const genRes = await new AcpRunner(profile("generic")).run(
        {
          runId: "r-gen",
          taskId: "t-gen",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "UNIQUE_SYSTEM_PROMPT",
          initialPrompt: "USER_TURN_1",
          model: "amp-model",
          maxTurns: 3,
          contextWindow: 100_000,
          rolloverThreshold: 0.75,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        genericAgent,
      );

      assert.equal(receivedPrompt, "USER_TURN_1");
      assert.equal(nestedAllowed, true);
      assert.equal(escapeDenied, true);
      assert.equal(genRes.stopReason, "rollover_requested");
      assert.equal(genRes.usage?.used, 80_000);
      assert.equal(genRes.usage?.size, 100_000);

      // maxTurns enforcement across tool-call waves
      let cancelOnMaxTurns = false;
      const loopAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-mt",
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelOnMaxTurns = true;
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          for (let i = 1; i <= 3; i++) {
            await acpClient.notify("session/update", {
              sessionId: "sess-mt",
              update: { sessionUpdate: "tool_call", toolCallId: `tc-${i}`, title: "read", status: "in_progress" },
            } as never);
            await acpClient.notify("session/update", {
              sessionId: "sess-mt",
              update: { sessionUpdate: "tool_call_update", toolCallId: `tc-${i}`, title: "read", status: "completed" },
            } as never);
            await acpClient.notify("session/update", {
              sessionId: "sess-mt",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `wave ${i}` } },
            } as never);
          }
          return { stopReason: cancelOnMaxTurns ? "cancelled" : "end_turn" } as never;
        });

      const mtRes = await new AcpRunner(profile("claude")).run(
        {
          runId: "r-mt",
          taskId: "t-mt",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Loop",
          model: "opus",
          maxTurns: 2,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        loopAgent,
      );
      assert.equal(cancelOnMaxTurns, true);
      assert.equal(mtRes.stopReason, "max_turns");

      // Ordinary assistant prose mentioning "rate limiting" without any observed rejection signal MUST NOT trigger quota_paused
      const proseAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({ sessionId: "sess-prose", models: { currentModelId: "fixture" } } as never))
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await acpClient.notify("session/update", {
            sessionId: "sess-prose",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "The implementation handles rate limiting correctly. No changes are needed." },
            },
          } as never);
          return { stopReason: "end_turn" } as never;
        });
      const proseRes = await new AcpRunner(profile("claude")).run(
        {
          runId: "r-prose",
          taskId: "t-prose",
          tier: 3,
          kind: "verify",
          cwd,
          toolPolicy: "read_only_workspace",
          model: "fixture",
          systemPrompt: "Verify",
          initialPrompt: "Check rate limiting",
          maxTurns: 3,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        proseAgent,
      );
      assert.equal(proseRes.stopReason, "completed");

      // read_only_workspace allows Bash when allowShellInReadOnly=true (verify/Done-Review in isolated checkouts)
      // while keeping Bash disabled for Tier 1 read_only_workspace on the host repo!
      const roVerify = buildNewSessionParams("claude", {
        cwd,
        systemPrompt: "Verify",
        toolPolicy: "read_only_workspace",
        allowShellInReadOnly: true,
        model: "claude-fable-5-2",
        mcpServers: [],
      });
      const roVerifyDisallowed = (roVerify.params._meta as { claudeCode: { options: { disallowedTools: string[] } } }).claudeCode.options.disallowedTools;
      assert.ok(!roVerifyDisallowed.includes("Bash"), "verify read_only_workspace must allow Bash for tmux/tests");
      assert.ok(roVerifyDisallowed.includes("Edit") && roVerifyDisallowed.includes("Write"), "verify read_only_workspace must still disable direct file edits");

      const roTier1 = buildNewSessionParams("claude", {
        cwd,
        systemPrompt: "Plan",
        toolPolicy: "read_only_workspace",
        allowShellInReadOnly: false,
        model: "claude-opus-5-5",
        mcpServers: [],
      });
      const roTier1Disallowed = (roTier1.params._meta as { claudeCode: { options: { disallowedTools: string[] } } }).claudeCode.options.disallowedTools;
      assert.ok(roTier1Disallowed.includes("Bash"), "Tier 1 read_only_workspace on host checkout must keep Bash disabled");
      assert.ok(!roTier1Disallowed.includes("Read"), "Tier 1 read_only_workspace must still allow Read/Grep/Glob");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("enables unattended yolo/bypass modes for writable ACPs and allows harness MCP tools across Claude, Gemini, and Antigravity/generic", async () => {
    // 1. Gemini writable spawn adds --approval-mode=yolo; Amp writable sets dangerouslyAllowAll=true; Amp control_plane_only explicitly allows mcp__harness__*
    const geminiSpawn = prepareAcpSpawn(
      { id: "acp:gemini", kind: "acp", adapter: "gemini", command: "gemini", args: ["--acp"], billing: "subscription" },
      { systemPrompt: "Worker", toolPolicy: "read_write_workspace" },
    );
    assert.ok(geminiSpawn.args.includes("--approval-mode=yolo"));
    geminiSpawn.cleanup();

    const ampWrite = prepareAcpSpawn(
      { id: "acp:amp", kind: "acp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"], billing: "subscription" },
      { systemPrompt: "Worker", toolPolicy: "read_write_workspace" },
    );
    const ampWriteSettings = JSON.parse(readFileSync(ampWrite.env.AMP_SETTINGS_FILE!, "utf8")) as Record<string, unknown>;
    assert.equal(ampWriteSettings["amp.dangerouslyAllowAll"], true);
    ampWrite.cleanup();

    const ampDir = prepareAcpSpawn(
      { id: "acp:amp", kind: "acp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"], billing: "subscription" },
      { systemPrompt: "Director", toolPolicy: "control_plane_only" },
    );
    const ampDirSettings = JSON.parse(readFileSync(ampDir.env.AMP_SETTINGS_FILE!, "utf8")) as {
      "amp.permissions"?: Array<{ tool: string; action: string }>;
    };
    assert.ok(ampDirSettings["amp.permissions"]?.some((r) => r.tool === "mcp__harness__*" && r.action === "allow"));
    ampDir.cleanup();

    // 2. Claude control_plane_only keeps ToolSearch + allowedTools for harness MCP
    const claudeDir = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Director",
      toolPolicy: "control_plane_only",
      model: "claude-opus-5-5",
      mcpServers: [{ name: "harness", command: "bun", args: ["bridge.ts"], env: [] }],
    });
    const claudeOpts = (claudeDir.params._meta as { claudeCode: { options: { tools: string[]; allowedTools?: string[] } } }).claudeCode.options;
    assert.deepEqual(claudeOpts.tools, ["ToolSearch"]);
    assert.deepEqual(claudeOpts.allowedTools, ["ToolSearch", "mcp__harness__*"]);

    // 3. Post-session mode auto-selection switches writable sessions into bypassPermissions / yolo
    const modeActions = buildPostSessionActions(
      "claude",
      "s1",
      {
        configOptions: [
          { id: "model", category: "model", currentValue: "opus", options: [{ value: "opus", name: "Opus 5.5" }] },
          {
            id: "mode",
            category: "mode",
            currentValue: "default",
            options: [{ value: "default" }, { value: "acceptEdits" }, { value: "bypassPermissions" }],
          },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "claude-opus-5-5" },
    );
    assert.deepEqual(modeActions, [
      { method: "session/set_config_option", params: { sessionId: "s1", configId: "mode", value: "bypassPermissions" } },
    ]);

    const legacyModeActions = buildPostSessionActions(
      "generic",
      "s2",
      {
        models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] },
        modes: { currentModeId: "manual", availableModes: [{ id: "manual" }, { id: "yolo" }] },
      },
      { toolPolicy: "read_write_workspace", model: "gemini-4-neon" },
    );
    assert.deepEqual(legacyModeActions, [{ method: "session/set_mode", params: { sessionId: "s2", modeId: "yolo" } }]);

    // 4. Generic / Antigravity (`agy acp`) control_plane_only allows prefixed harness MCP calls (`mcp__harness__code_exec`, kind: "fetch")
    // while still denying spoofed file reads with locations!
    const cwd = mkdtempSync(join(tmpdir(), "acp-generic-mcp-"));
    try {
      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "agy", version: "1.5" } }))
        .onRequest("session/new", async () => ({
          sessionId: "s-agy",
          models: { currentModelId: "gemini-4-neon", availableModels: [{ modelId: "gemini-4-neon" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          const ask = async (toolCall: Record<string, unknown>) => {
            const res = (await client.request("session/request_permission", {
              sessionId,
              toolCall,
              options: [{ kind: "allow_always", optionId: "allow", name: "Allow" }, { kind: "reject_once", optionId: "deny", name: "Deny" }],
            })) as { outcome: { outcome: string; optionId?: string } };
            return res.outcome.outcome === "selected" ? res.outcome.optionId : res.outcome.outcome;
          };
          assert.equal(await ask({ toolCallId: "1", name: "mcp__harness__code_exec", kind: "fetch" }), "allow");
          assert.equal(await ask({ toolCallId: "1b", name: "mcp_harness_goal_list", kind: "other" }), "allow");
          assert.equal(await ask({ toolCallId: "1c", title: "mcp_harness_code_exec", kind: "fetch" }), "allow");
          assert.equal(await ask({ toolCallId: "2", title: "harness:goal_list", kind: "execute" }), "allow");
          assert.equal(await ask({ toolCallId: "3", title: "code_exec", kind: "read", locations: [{ path: join(cwd, "a.txt") }] }), "deny");
          assert.equal(await ask({ toolCallId: "4", name: "mcp_harness_goal_list", kind: "read", locations: [{ path: join(cwd, "a.txt") }] }), "deny");
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "checked" } },
          });
          return { stopReason: "end_turn" };
        });
      const res = await new AcpRunner(profile("generic")).run(
        {
          runId: "run-agy",
          taskId: "t-agy",
          tier: 1,
          kind: "orchestrator",
          cwd,
          model: "gemini-4-neon",
          systemPrompt: "Director",
          initialPrompt: "test",
          maxTurns: 1,
          toolPolicy: "control_plane_only",
          daemonSocketPath: "/unused/socket",
          mcpBridgeEntrypoint: "/unused/bridge",
          tools: [
            { name: "code_exec", description: "code_exec", inputSchema: {} },
            { name: "goal_list", description: "goal_list", inputSchema: {} },
          ],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fixture,
      );
      assert.equal(res.stopReason, "completed");
      assert.equal(res.text, "checked");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("proactively disables Codex features.code_mode_host when codex-code-mode-host is absent and surfaces clear misconfig errors", async () => {
    const emptyBinDir = mkdtempSync(join(tmpdir(), "codex-no-host-"));
    const hostBinDir = mkdtempSync(join(tmpdir(), "codex-with-host-"));
    try {
      const fakeHost = join(hostBinDir, "codex-code-mode-host");
      writeFileSync(fakeHost, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(fakeHost, 0o755);

      const fakeCodex = join(hostBinDir, "codex-acp");
      writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n", "utf8");
      chmodSync(fakeCodex, 0o755);

      // 1. Missing codex-code-mode-host -> proactively adds -c features.code_mode_host=false & CODEX_CONFIG override
      assert.equal(hasCodexCodeModeHost("codex-acp", { PATH: emptyBinDir }), false);
      const missingProfile: AcpProfileConfig = {
        id: "acp:codex",
        kind: "acp",
        adapter: "codex",
        command: "codex-acp",
        billing: "subscription",
        env: { PATH: emptyBinDir },
      };
      const missingSpawn = prepareAcpSpawn(missingProfile, { systemPrompt: "Director", toolPolicy: "control_plane_only" });
      assert.ok(missingSpawn.args.includes("features.code_mode_host=false"));
      assert.equal(JSON.parse(missingSpawn.env.CODEX_CONFIG ?? "{}").features?.code_mode_host, false);
      assert.equal(JSON.parse(missingSpawn.env.CODEX_CONFIG ?? "{}").features?.multi_agent, false);
      missingSpawn.cleanup();

      // 2. Discoverable codex-code-mode-host (in binary dir even when PATH is empty) -> does NOT force code_mode_host=false
      assert.equal(hasCodexCodeModeHost(fakeCodex, { PATH: emptyBinDir }), true);
      assert.equal(hasCodexCodeModeHost("codex-acp", { PATH: hostBinDir }), true);
      const presentProfile: AcpProfileConfig = {
        id: "acp:codex",
        kind: "acp",
        adapter: "codex",
        command: fakeCodex,
        billing: "subscription",
        env: { PATH: emptyBinDir },
      };
      const presentSpawn = prepareAcpSpawn(presentProfile, { systemPrompt: "Director", toolPolicy: "control_plane_only" });
      assert.equal(presentSpawn.args.includes("features.code_mode_host=false"), false);
      assert.equal(JSON.parse(presentSpawn.env.CODEX_CONFIG ?? "{}").features?.code_mode_host, undefined);
      presentSpawn.cleanup();

      // 3. Explicit user CODEX_CONFIG override is preserved
      const explicitProfile: AcpProfileConfig = {
        id: "acp:codex",
        kind: "acp",
        adapter: "codex",
        command: "codex-acp",
        billing: "subscription",
        env: { PATH: emptyBinDir, CODEX_CONFIG: JSON.stringify({ features: { code_mode_host: true } }) },
      };
      const explicitSpawn = prepareAcpSpawn(explicitProfile, { systemPrompt: "Director", toolPolicy: "control_plane_only" });
      assert.equal(explicitSpawn.args.includes("features.code_mode_host=false"), false);
      assert.equal(JSON.parse(explicitSpawn.env.CODEX_CONFIG ?? "{}").features?.code_mode_host, true);
      explicitSpawn.cleanup();

      // 4. Error classifier detects Codex Code Mode fail-closed errors and surfaces actionable Profile misconfigured error
      const classified = detectCodexCodeModeMisconfig("Code Mode is unavailable (codex-code-mode-host not found); fail closed");
      assert.ok(classified?.includes("Profile misconfigured"));
      assert.ok(classified?.includes("codex-code-mode-host"));
      assert.ok(classified?.includes("features.code_mode_host=false"));
      assert.equal(detectCodexCodeModeMisconfig("normal unrelated failure"), null);

      const failClosedFixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: "s-codex-broken",
          models: { currentModelId: "gpt-6.2-sol", availableModels: [{ modelId: "gpt-6.2-sol" }] },
        }))
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          await client.notify("session/update", {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-1",
              title: "goal_list",
              kind: "execute",
              status: "failed",
              rawOutput: { error: "Code Mode is unavailable (codex-code-mode-host missing); fail closed" },
            },
          });
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Unable to call tools." } },
          });
          return { stopReason: "end_turn" };
        });

      await assert.rejects(
        () =>
          new AcpRunner(profile("codex")).run(
            {
              runId: "r-codex",
              taskId: "t-codex",
              tier: 1,
              kind: "orchestrator",
              cwd: emptyBinDir,
              model: "gpt-6.2-sol",
              systemPrompt: "Director",
              initialPrompt: "list goals",
              maxTurns: 1,
              toolPolicy: "control_plane_only",
              tools: [{ name: "goal_list", description: "list", inputSchema: {} }],
              executeTool: async () => ({}),
              signal: new AbortController().signal,
              callbacks: {},
            },
            failClosedFixture,
          ),
        /Profile misconfigured.*codex-code-mode-host.*features\.code_mode_host=false/,
      );
    } finally {
      rmSync(emptyBinDir, { recursive: true, force: true });
      rmSync(hostBinDir, { recursive: true, force: true });
    }
  });

  it("reports accurate tool policy descriptions across all modes without falsely claiming strictly read-only", async () => {
    assert.equal(
      describeToolPolicyMode("control_plane_only", false),
      "control-plane-only (harness MCP tools only; no workspace reads, writes, or shell)",
    );
    assert.equal(
      describeToolPolicyMode("read_only_workspace", false),
      "read-only workspace (no file writes or shell)",
    );
    assert.equal(
      describeToolPolicyMode("read_only_workspace", true),
      "read-only workspace with verification shell (no file writes)",
    );
    assert.equal(describeToolPolicyMode("read_write_workspace", false), "read-write workspace");

    const cwd = mkdtempSync(join(tmpdir(), "acp-policy-msg-"));
    try {
      const target = join(cwd, "check.txt");
      writeFileSync(target, "hello", "utf8");
      const recoveryPrompts: string[] = [];
      let promptCalls = 0;

      const verifyFixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: "s-verify",
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params }) => {
          promptCalls += 1;
          const text = ((params.prompt as Array<{ text?: string }>) ?? []).map((b) => b.text ?? "").join("\n");
          recoveryPrompts.push(text);
          if (promptCalls === 1) {
            // Write attempt must report "read-only workspace with verification shell (no file writes)", never "strictly read-only"
            await assert.rejects(client.request("fs/write_text_file", { sessionId: params.sessionId, path: target, content: "mutated" }), {
              data: { details: "Write denied: agent is running in read-only workspace with verification shell (no file writes) mode" },
            });
            // Denied edit permission triggers continuation recovery on silent stop
            const perm = await client.request("session/request_permission", {
              sessionId: params.sessionId,
              toolCall: { toolCallId: "edit-1", title: "edit_file", kind: "edit", locations: [{ path: target }] },
              options: [
                { kind: "allow_once", optionId: "allow", name: "Allow" },
                { kind: "reject_once", optionId: "deny", name: "Deny" },
              ],
            });
            assert.equal(perm.outcome.outcome === "selected" ? perm.outcome.optionId : perm.outcome.outcome, "deny");
            // Shell execute IS allowed in verify mode
            const shellPerm = await client.request("session/request_permission", {
              sessionId: params.sessionId,
              toolCall: { toolCallId: "exec-1", title: "bun test", kind: "execute" },
              options: [
                { kind: "allow_once", optionId: "allow", name: "Allow" },
                { kind: "reject_once", optionId: "deny", name: "Deny" },
              ],
            });
            assert.equal(shellPerm.outcome.outcome === "selected" ? shellPerm.outcome.optionId : shellPerm.outcome.outcome, "allow");
            return { stopReason: "end_turn" };
          }
          await client.notify("session/update", {
            sessionId: params.sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Verified via shell." } },
          });
          return { stopReason: "end_turn" };
        });

      const res = await new AcpRunner(profile("claude")).run(
        {
          runId: "r-verify",
          taskId: "t-verify",
          tier: 3,
          kind: "verify",
          cwd,
          model: "opus",
          systemPrompt: "Verifier",
          initialPrompt: "verify",
          maxTurns: 3,
          toolPolicy: "read_only_workspace",
          allowShellInReadOnly: true,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        verifyFixture,
      );

      assert.equal(res.stopReason, "completed");
      assert.equal(res.text, "Verified via shell.");
      assert.equal(recoveryPrompts.length, 2);
      assert.ok(
        recoveryPrompts[1]!.includes("read-only workspace with verification shell (no file writes)"),
        `Expected accurate policy phrasing in recovery prompt, got: ${recoveryPrompts[1]}`,
      );
      assert.equal(
        recoveryPrompts[1]!.includes("strictly read-only"),
        false,
        "Must never claim 'strictly read-only' when verification shell is enabled",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("enforces quote-aware read-only shell validation, external MCP read-only filtering, and full read_only_workspace permission matrix across adapters", async () => {
    // 1. Quote-aware read-only shell validator
    for (const okCmd of [
      `rg "=>" src/ | head -n 20`,
      `git status && git log -n 5 --oneline`,
      `git diff -U3 HEAD~1 2>/dev/null`,
      `find src -name "*.ts" 2>&1 | sort`,
      `sed -n '1,40p' src/cli.ts`,
      `sg -p 'fn $A()' src/`,
      `sqlite3 -readonly db.sqlite "SELECT 1"`,
    ]) {
      assert.equal(isSafeReadOnlyShellCommand(okCmd), true, `Expected safe read-only command to pass: ${okCmd}`);
    }
    for (const badCmd of [
      `echo hi > out.txt`,
      `rm -rf /tmp/x`,
      `sed -i 's/a/b/' foo.ts`,
      `sg -U -p 'a' -r 'b' src/`,
      `find . -delete`,
      `git checkout main`,
      `git branch new-branch`,
      `git commit -m x`,
      `PATH=/evil rg foo`,
      `rg $(whoami) src/`,
      `python3 -c 'print(1)'`,
    ]) {
      assert.equal(isSafeReadOnlyShellCommand(badCmd), false, `Expected mutating command to be rejected: ${badCmd}`);
    }

    // 2. External MCP read-only filter (`octofs` & `ast-grep`)
    assert.equal(isReadOnlyExternalMcpTool("octofs", "view"), true);
    assert.equal(isReadOnlyExternalMcpTool("octofs", "view_signatures"), true);
    assert.equal(isReadOnlyExternalMcpTool("octofs", "ast_grep"), true);
    assert.equal(isReadOnlyExternalMcpTool("octofs", "text_editor"), false);
    assert.equal(isReadOnlyExternalMcpTool("octofs", "batch_edit"), false);
    assert.equal(isReadOnlyExternalMcpTool("octofs", "shell"), false);
    assert.equal(isReadOnlyExternalMcpTool("ast-grep", "find_code"), true);

    // 3. Claude read_only_workspace pre-allows Read/Grep/Glob + read-only octofs, blocks mutating octofs
    const claudeRo = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Research",
      toolPolicy: "read_only_workspace",
      allowShellInReadOnly: false,
      model: "claude-sonnet-5-5",
      mcpServers: [
        { name: "harness", command: "bun", args: ["bridge"], env: [] },
        { name: "octofs", command: "octofs", args: ["mcp"], env: [] },
      ],
    });
    const claudeOpts = (claudeRo.params._meta as { claudeCode: { options: { allowedTools: string[]; disallowedTools: string[] } } }).claudeCode.options;
    assert.ok(claudeOpts.allowedTools.includes("Read") && claudeOpts.allowedTools.includes("Grep") && claudeOpts.allowedTools.includes("Glob"));
    assert.ok(claudeOpts.allowedTools.includes("mcp__octofs__view"));
    assert.ok(claudeOpts.disallowedTools.includes("mcp__octofs__text_editor"));
    assert.ok(claudeOpts.disallowedTools.includes("mcp__octofs__shell"));

    // 4. Codex allowShellInReadOnly=true (verify/Done-Review) does NOT set INITIAL_AGENT_MODE=read-only,
    //    whereas allowShellInReadOnly=false (research/plan) DOES set INITIAL_AGENT_MODE=read-only.
    const codexProfile = profile("codex");
    const codexResearch = prepareAcpSpawn(codexProfile, { systemPrompt: "R", toolPolicy: "read_only_workspace", allowShellInReadOnly: false });
    const codexVerify = prepareAcpSpawn(codexProfile, { systemPrompt: "V", toolPolicy: "read_only_workspace", allowShellInReadOnly: true });
    assert.equal(codexResearch.env.INITIAL_AGENT_MODE, "read-only");
    assert.equal(codexVerify.env.INITIAL_AGENT_MODE, undefined);
    codexResearch.cleanup();
    codexVerify.cleanup();

    // 5. Real AcpRunner permission matrix for read_only_workspace (allowShellInReadOnly=false)
    const cwd = mkdtempSync(join(tmpdir(), "pi-ro-matrix-"));
    try {
      writeFileSync(join(cwd, "index.ts"), "export const x = () => 1;\n", "utf8");
      const decisions: Record<string, string> = {};
      const seenMcpNames: string[] = [];

      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {}, agentInfo: { name: "codex-acp", version: "1.0" } }))
        .onRequest("session/new", async ({ params }) => {
          const srvs = (params as { mcpServers?: Array<{ name: string }> }).mcpServers ?? [];
          seenMcpNames.push(...srvs.map((s) => s.name));
          return {
            sessionId: "ro-s1",
            configOptions: [
              {
                id: "model",
                name: "Model",
                type: "select" as const,
                category: "model",
                currentValue: "gpt-6.2-sol",
                options: [{ value: "gpt-6.2-sol", name: "GPT-6.2 Sol" }],
              },
            ],
          };
        })
        .onRequest("session/prompt", async ({ client: c }) => {
          const ask = async (label: string, req: Record<string, unknown>) => {
            const resp = (await c.request("session/request_permission", {
              sessionId: "ro-s1",
              options: [
                { optionId: "allow", kind: "allow_once", name: "Allow" },
                { optionId: "deny", kind: "reject_once", name: "Deny" },
              ],
              ...req,
            } as never)) as { outcome?: { optionId?: string } };
            decisions[label] = resp?.outcome?.optionId ?? "cancelled";
          };

          // Grep/Glob with empty locations & glob pattern inside workspace -> ALLOW
          await ask("grep_empty_loc", { toolCall: { toolCallId: "1", title: "Grep", kind: "search", locations: [] } });
          await ask("glob_pattern", { toolCall: { toolCallId: "2", title: "Glob", kind: "search", locations: [{ path: "**/*.ts" }] } });
          // Read outside workspace -> DENY
          await ask("read_escape", { toolCall: { toolCallId: "3", title: "Read", kind: "read", locations: [{ path: "/etc/passwd" }] } });
          // Write inside workspace -> DENY
          await ask("write_local", { toolCall: { toolCallId: "4", title: "Edit", kind: "edit", locations: [{ path: "index.ts" }] } });
          // Read-only shell wrapped in ["/bin/zsh", "-lc", ...] -> ALLOW
          await ask("shell_ro_zsh", {
            toolCall: {
              toolCallId: "5",
              title: "shell",
              kind: "execute",
              rawInput: { command: ["/bin/zsh", "-lc", `git status && rg "=>" index.ts 2>/dev/null`] },
            },
          });
          // Mutating shell -> DENY
          await ask("shell_mutating", {
            toolCall: { toolCallId: "6", title: "shell", kind: "execute", rawInput: { command: "rm -rf index.ts" } },
          });
          // `think` & read-only `other` (`list_dir`) -> ALLOW
          await ask("think_tool", { toolCall: { toolCallId: "7", title: "Thinking", kind: "think" } });
          await ask("list_dir_other", { toolCall: { toolCallId: "8", title: "list_dir", kind: "other", rawInput: { path: "." } } });
          // Dot-separated harness MCP (`mcp.harness.return_task`) -> ALLOW
          await ask("harness_dot", { toolCall: { toolCallId: "9", title: "mcp.harness.return_task", kind: "execute" } });
          // External `octofs` read tool -> ALLOW; mutating `octofs.text_editor` -> DENY
          await ask("octofs_view", {
            _meta: { is_mcp_tool_approval: true },
            toolCall: { toolCallId: "10", title: "mcp.octofs.view", kind: "execute", rawInput: { server: "octofs", tool: "view" } },
          });
          await ask("octofs_edit", {
            _meta: { is_mcp_tool_approval: true },
            toolCall: { toolCallId: "11", title: "mcp.octofs.text_editor", kind: "execute", rawInput: { server: "octofs", tool: "text_editor" } },
          });

          await c.notify("session/update", {
            sessionId: "ro-s1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "matrix done" } },
          });
          return { stopReason: "end_turn" };
        });

      const runner = new AcpRunner(codexProfile);
      await runner.run(
        {
          runId: "r-ro",
          taskId: "t-ro",
          tier: 3,
          kind: "research",
          cwd,
          toolPolicy: "read_only_workspace",
          allowShellInReadOnly: false,
          systemPrompt: "Research",
          initialPrompt: "Inspect",
          model: "gpt-6.2-sol",
          maxTurns: 10,
          daemonSocketPath: "/tmp/fake.sock",
          mcpBridgeEntrypoint: "/tmp/fake-bridge.ts",
          externalMcpServers: [{ name: "octofs", command: "octofs", args: ["mcp"], enabled: true }],
          tools: [{ name: "return_task", description: "Return", inputSchema: { type: "object" } }],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fixture,
      );

      assert.ok(seenMcpNames.includes("octofs"), "octofs external MCP must be attached for read_only_workspace agents");
      assert.equal(decisions.grep_empty_loc, "allow");
      assert.equal(decisions.glob_pattern, "allow");
      assert.equal(decisions.read_escape, "deny");
      assert.equal(decisions.write_local, "deny");
      assert.equal(decisions.shell_ro_zsh, "allow");
      assert.equal(decisions.shell_mutating, "deny");
      assert.equal(decisions.think_tool, "allow");
      assert.equal(decisions.list_dir_other, "allow");
      assert.equal(decisions.harness_dot, "allow");
      assert.equal(decisions.octofs_view, "allow");
      assert.equal(decisions.octofs_edit, "deny");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
