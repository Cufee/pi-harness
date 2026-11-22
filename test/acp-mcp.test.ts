import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { loadConfig, type AcpProfileConfig } from "../src/config.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { buildNewSessionParams, buildPostSessionActions, prepareAcpSpawn } from "../src/runners/acp-shims.js";
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
          assert.deepEqual(options.tools, []);
          assert.equal(options.strictMcpConfig, true);
          for (const tool of ["Read", "Grep", "Glob", "Bash", "Write", "Edit", "Agent", "Task"]) assert.ok(options.disallowedTools.includes(tool), tool);
          assert.deepEqual(params.mcpServers.map(s => s.name), bridge ? ["harness"] : []);
          return { sessionId: "fixture", models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] } };
        }).onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          await assert.rejects(client.request("fs/read_text_file", { sessionId, path }), { data: { details: "Read denied: agent is running in control-plane-only mode" } });
          await assert.rejects(client.request("fs/write_text_file", { sessionId, path, content: "changed" }), { data: { details: "Write denied: agent is running in control-plane-only mode" } });
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
    const ampCfg = JSON.parse(readFileSync(ampCtrlSpawn.env.AMP_SETTINGS_FILE!, "utf8")) as Record<string, string[]>;
    assert.deepEqual(ampCfg["amp.tools.enable"], ["mcp__harness__*"]);
    assert.ok(ampCfg["amp.tools.disable"]?.includes("Bash"));
    ampCtrlSpawn.cleanup();

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
});
