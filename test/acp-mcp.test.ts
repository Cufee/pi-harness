import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { loadConfig, type AcpProfileConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { buildNewSessionParams, buildPostSessionActions, prepareAcpSpawn } from "../src/runners/acp-shims.js";
import type { PassiveQuotaSignal, RunnerUsage } from "../src/runners/types.js";

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
    const claudeSpawn = prepareAcpSpawn(claudeProfile, { systemPrompt: "Role", toolPolicy: "read_only_workspace" });
    assert.equal(claudeSpawn.env.DISABLE_COMPACT, "1");
    claudeSpawn.cleanup();

    const claudeNew = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Role",
      toolPolicy: "read_only_workspace",
      model: "claude-opus-5-5",
      effort: "high",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { options: {} } },
    });
    const meta = (claudeNew.params._meta as { claudeCode: { options: { disallowedTools: string[] } } }).claudeCode.options;
    assert.ok(meta.disallowedTools.includes("Agent"));
    assert.ok(meta.disallowedTools.includes("Write"));

    // 2. Codex shim: blocks internal multi_agent + post-new set_config_option + read-only mode
    const codexProfile: AcpProfileConfig = {
      id: "acp:codex",
      kind: "acp",
      adapter: "codex",
      command: "codex-acp",
      billing: "subscription",
    };
    const codexSpawn = prepareAcpSpawn(codexProfile, { systemPrompt: "Role", toolPolicy: "read_only_workspace" });
    assert.ok(codexSpawn.args.includes("features.multi_agent=false"));
    assert.equal(codexSpawn.env.INITIAL_AGENT_MODE, "read-only");
    codexSpawn.cleanup();

    const codexPost = buildPostSessionActions("codex", "s1", {}, { toolPolicy: "read_only_workspace", model: "gpt-6.2-sol", effort: "high" });
    assert.equal(codexPost[0]?.method, "session/set_mode");
    assert.equal(codexPost[1]?.method, "session/set_config_option");
    assert.equal(codexPost[2]?.params.configId, "reasoning_effort");

    // 3. Gemini shim: GEMINI_SYSTEM_MD env file + legacy session/set_model
    const geminiProfile: AcpProfileConfig = {
      id: "acp:gemini",
      kind: "acp",
      adapter: "gemini",
      command: "gemini",
      args: ["--acp"],
      billing: "subscription",
    };
    const geminiSpawn = prepareAcpSpawn(geminiProfile, { systemPrompt: "Gemini role", toolPolicy: "read_only_workspace" });
    assert.ok(geminiSpawn.env.GEMINI_SYSTEM_MD?.endsWith("system.md"));
    geminiSpawn.cleanup();

    const geminiPost = buildPostSessionActions("gemini", "s1", {}, { toolPolicy: "read_only_workspace", model: "gemini-4-neon" });
    assert.equal(geminiPost.find((a) => a.method === "session/set_model")?.params.modelId, "gemini-4-neon");
  });

  it("streams ACP updates, triggers rollover on usage_update >= threshold, indexes Gemini-style artifacts, and harvests passive _claude/rateLimit", async () => {
    let cancelReceived = false;
    let permDeniedForWrite = false;
    let permAllowedForHarnessMcp = false;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: { systemPrompt: {}, options: {} } },
        _meta: { steering: { supported: true } },
      } as never))
      .onRequest("session/new", async () => ({ sessionId: "sess-1", models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] } } as never))
      .onRequest("session/set_mode", async () => ({}))
      .onNotification("session/cancel", async () => {
        cancelReceived = true;
      })
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        // Test read-only permission enforcement: write denied, harness MCP allowed
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
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_only_workspace",
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
    const config = { ...loadConfig(), stateDir, socketPath: sockPath };
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
});
