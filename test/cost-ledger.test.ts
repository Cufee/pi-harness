import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { Database } from "bun:sqlite";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { loadConfig, type RunnerProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { recordCostInvocation, summarizeCost } from "../src/cost/ledger.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { CostSnapshot } from "../src/protocol/daemon-rpc.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import type { RunAgentRequest, RunnerUsage } from "../src/runners/types.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const profiles: RunnerProfileConfig[] = [
  { id: "acp:claude-sub", kind: "acp", adapter: "claude", command: "claude-agent-acp", billing: "subscription" },
  { id: "acp:claude-api", kind: "acp", adapter: "claude", command: "claude-agent-acp", billing: "api" },
  { id: "acp:codex-api", kind: "acp", adapter: "codex", command: "codex-acp", billing: "api" },
  { id: "acp:amp-api", kind: "acp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"], billing: "api" },
  { id: "acp:opencode-api", kind: "acp", adapter: "generic", command: "opencode", args: ["acp"], billing: "api" },
  { id: "pi:openrouter", kind: "pi", provider: "openrouter", billing: "api" },
  { id: "pi:anthropic", kind: "pi", provider: "anthropic", billing: "api" },
  { id: "pi:local", kind: "pi", provider: "ollama", billing: "local" },
];

describe("Durable cost ledger & cost.get RPC", () => {
  it("excludes subscription-only activity and returns available: false", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const inv = recordCostInvocation(db, {
        chatSessionId: "chat-sub",
        activity: "director",
        profile: { id: "acp:claude-sub", billing: "subscription" },
        model: "anthropic/claude-opus-5-5",
      });
      inv.onSessionId("ext-sub-1");
      inv.onUsage({
        used: 1000,
        size: 200_000,
        cost: { amount: 1.25, currency: "USD", basis: "session_cumulative", model: "claude-opus-5-5" },
      });
      inv.finish();

      const snap = summarizeCost(
        db,
        { chatSessionId: "chat-sub", runIds: [], snapshotScope: { kind: "chat", id: "chat-sub", label: "Sub Only" } },
        profiles,
      );
      assert.equal(snap.available, false);
      assert.deepEqual(snap.totals, []);
      assert.deepEqual(snap.byModel, []);
      assert.equal(snap.coverage.complete, false);
      assert.deepEqual(snap.coverage.routes, []);
    } finally {
      db.close();
    }
  });

  it("tracks mixed API + subscription sessions, deduplicates cumulative and delta updates, and keeps currencies separate", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      // Subscription launch in same session must be completely ignored
      const subInv = recordCostInvocation(db, {
        chatSessionId: "chat-mix",
        activity: "director",
        profile: { id: "acp:claude-sub", billing: "subscription" },
      });
      subInv.onUsage({
        used: 500,
        size: 100_000,
        cost: { amount: 9.99, currency: "USD", basis: "session_cumulative", model: "claude-opus-5-5" },
      });
      subInv.finish();

      // API Claude invocation with repeated cumulative totals (0.10 -> 0.10 -> 0.25 -> 0.25)
      const api1 = recordCostInvocation(db, {
        chatSessionId: "chat-mix",
        runId: "run-1",
        taskId: "t-1",
        activity: "task",
        profile: { id: "acp:claude-api", billing: "api" },
      });
      api1.onSessionId("claude-ext-1");
      api1.onUsage({ used: 1000, size: 200_000, cost: { amount: 0.1, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      api1.onUsage({ used: 1200, size: 200_000, cost: { amount: 0.1, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      api1.onUsage({ used: 2000, size: 200_000, cost: { amount: 0.25, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      api1.onUsage({ used: 2000, size: 200_000, cost: { amount: 0.25, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      api1.finish();

      // Re-attached invocation on the SAME external session continuing from 0.25 -> 0.40 (must only add 0.15!)
      const api2 = recordCostInvocation(db, {
        chatSessionId: "chat-mix",
        runId: "run-1",
        taskId: "t-2",
        activity: "done_review",
        profile: { id: "acp:claude-api", billing: "api" },
      });
      api2.onSessionId("claude-ext-1");
      api2.onUsage({ used: 2200, size: 200_000, cost: { amount: 0.25, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      api2.onUsage({ used: 2500, size: 200_000, cost: { amount: 0.4, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      // Counter reset below baseline (e.g. 0.05) must not subtract, and subsequent increase (0.05 -> 0.12) adds 0.07
      api2.onUsage({ used: 2600, size: 200_000, cost: { amount: 0.05, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      api2.onUsage({ used: 2700, size: 200_000, cost: { amount: 0.12, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
      api2.finish();

      // OpenRouter delta charges: duplicate chargeId ignored, distinct chargeIds summed, non-USD currency kept separate
      const orInv = recordCostInvocation(db, {
        chatSessionId: "chat-mix",
        activity: "director",
        profile: { id: "pi:openrouter", billing: "api" },
      });
      orInv.onUsage({ used: 500, size: 100_000, cost: { amount: 0.03, currency: "USD", basis: "delta", model: "openai/gpt-6.2-sol", chargeId: "resp-1" } });
      orInv.onUsage({ used: 500, size: 100_000, cost: { amount: 0.03, currency: "USD", basis: "delta", model: "openai/gpt-6.2-sol", chargeId: "resp-1" } });
      orInv.onUsage({ used: 800, size: 100_000, cost: { amount: 0.02, currency: "USD", basis: "delta", model: "openai/gpt-6.2-sol", chargeId: "resp-2" } });
      orInv.onUsage({ used: 900, size: 100_000, cost: { amount: 5, currency: "credits", basis: "delta", model: "openai/gpt-6.2-sol", chargeId: "resp-3" } });
      orInv.finish();

      // Unrelated session must not leak in
      const otherInv = recordCostInvocation(db, {
        chatSessionId: "chat-other",
        activity: "director",
        profile: { id: "pi:openrouter", billing: "api" },
      });
      otherInv.onUsage({ used: 500, size: 100_000, cost: { amount: 10, currency: "USD", basis: "delta", model: "other/model", chargeId: "resp-x" } });
      otherInv.finish();

      const snap = summarizeCost(
        db,
        { chatSessionId: "chat-mix", runIds: ["run-1"], snapshotScope: { kind: "chat", id: "chat-mix", label: "Mixed" } },
        profiles,
      );
      assert.equal(snap.available, true);
      assert.equal(snap.coverage.complete, true);
      assert.deepEqual(snap.coverage.unattributed, []);
      assert.deepEqual(snap.totals, [
        { currency: "credits", amount: 5 },
        { currency: "USD", amount: 0.52 },
      ]);
      assert.deepEqual(snap.byModel, [
        { model: "openai/gpt-6.2-sol", currency: "credits", amount: 5 },
        { model: "claude-sonnet-5-5", currency: "USD", amount: 0.47 },
        { model: "openai/gpt-6.2-sol", currency: "USD", amount: 0.05 },
      ]);
      assert.equal(snap.coverage.routes.length, 2);
      assert.ok(snap.coverage.routes.every((r) => r.status === "reported" && r.running === 0));
    } finally {
      db.close();
    }
  });

  it("reports partial, unattributed, unsupported, unavailable, and live running coverage accurately", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      // 1. Partial route: one invocation with unattributed charge + one invocation with no cost reported + still running
      const c1 = recordCostInvocation(db, {
        chatSessionId: "chat-cov",
        activity: "director",
        profile: { id: "acp:claude-api", billing: "api" },
      });
      c1.onUsage({ used: 100, size: 100_000, cost: { amount: 0.2, currency: "USD", basis: "session_cumulative" } });
      c1.finish();

      const c2 = recordCostInvocation(db, {
        chatSessionId: "chat-cov",
        activity: "task",
        profile: { id: "acp:claude-api", billing: "api" },
      });
      // deliberately left live (running) with no cost reported yet

      // 2. Unsupported routes: codex, amp, non-openrouter pi, local
      const codex = recordCostInvocation(db, { chatSessionId: "chat-cov", activity: "task", profile: { id: "acp:codex-api", billing: "api" } });
      codex.finish();
      const amp = recordCostInvocation(db, { chatSessionId: "chat-cov", activity: "task", profile: { id: "acp:amp-api", billing: "api" } });
      amp.finish();
      const piAnth = recordCostInvocation(db, { chatSessionId: "chat-cov", activity: "task", profile: { id: "pi:anthropic", billing: "api" } });
      piAnth.finish();
      const local = recordCostInvocation(db, { chatSessionId: "chat-cov", activity: "task", profile: { id: "pi:local", billing: "local" } });
      local.finish();

      // 3. Unavailable route: openrouter that has not reported cost yet
      const or = recordCostInvocation(db, { chatSessionId: "chat-cov", activity: "task", profile: { id: "pi:openrouter", billing: "api" } });
      or.finish();

      try {
        const snap = summarizeCost(
          db,
          { chatSessionId: "chat-cov", runIds: [], snapshotScope: { kind: "chat", id: "chat-cov", label: "Coverage" } },
          profiles,
        );
        assert.equal(snap.available, true);
        assert.equal(snap.coverage.complete, false);
        assert.deepEqual(snap.coverage.unattributed, [{ currency: "USD", amount: 0.2 }]);
        const byProfile = new Map(snap.coverage.routes.map((r) => [r.profileId, r]));
        assert.equal(byProfile.get("acp:claude-api")?.status, "partial");
        assert.equal(byProfile.get("acp:claude-api")?.running, 1);
        assert.match(byProfile.get("acp:claude-api")?.note ?? "", /1 of 2 runs reported no cost/);
        assert.match(byProfile.get("acp:claude-api")?.note ?? "", /Some charges do not say which model/);
        assert.match(byProfile.get("acp:claude-api")?.note ?? "", /1 still running/);

        assert.equal(byProfile.get("acp:codex-api")?.status, "unsupported");
        assert.match(byProfile.get("acp:codex-api")?.note ?? "", /Codex reports token counts only/);
        assert.equal(byProfile.get("acp:amp-api")?.status, "unsupported");
        assert.match(byProfile.get("acp:amp-api")?.note ?? "", /Amp reports usage without charges/);
        assert.equal(byProfile.get("pi:anthropic")?.status, "unsupported");
        assert.equal(byProfile.get("pi:local")?.status, "unsupported");
        assert.equal(byProfile.get("pi:openrouter")?.status, "unavailable");
      } finally {
        c2.finish();
      }
    } finally {
      db.close();
    }
  });

  it("strips model attribution in AcpRunner when a turn reports multiple models in promptMeta.quota.model_usage", async () => {
    const usages: RunnerUsage[] = [];
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-multi",
        models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        await acpClient.notify("session/update", {
          sessionId: "sess-multi",
          update: {
            sessionUpdate: "usage_update",
            used: 4_000,
            size: 200_000,
            cost: { amount: 0.35, currency: "USD" },
            _meta: { "_claude/model": "claude-opus-5-5" },
          },
        } as never);
        return {
          stopReason: "end_turn",
          _meta: { quota: { model_usage: [{ model: "claude-opus-5-5" }, { model: "claude-haiku-5-5" }] } },
        } as never;
      });

    const req: RunAgentRequest = {
      runId: "r-cost",
      taskId: "t-cost",
      tier: 1,
      kind: "orchestrator",
      toolPolicy: "control_plane_only",
      cwd: process.cwd(),
      systemPrompt: "sys",
      initialPrompt: "go",
      model: "opus",
      maxTurns: 1,
      tools: [],
      executeTool: async () => ({}),
      signal: new AbortController().signal,
      callbacks: { onUsage: (u) => usages.push(u) },
    };

    const res = await new AcpRunner({
      id: "acp:claude-api",
      kind: "acp",
      adapter: "claude",
      command: "unused",
      billing: "api",
    }).run(req, mockAgent);

    assert.equal(res.usage?.cost?.amount, 0.35);
    assert.equal(res.usage?.cost?.currency, "USD");
    assert.equal(res.usage?.cost?.basis, "session_cumulative");
    assert.equal(res.usage?.cost?.model, undefined);
    // Mid-turn usage_update did NOT leak the attributed cost early; flushed cost arrived at end of turn without model
    assert.equal(usages[0]?.cost, undefined);
    assert.equal(usages[usages.length - 1]?.cost?.amount, 0.35);
    assert.equal(usages[usages.length - 1]?.cost?.model, undefined);
  });

  it("prefers OpenCode's per-message SQLite costs (including sub-agent sessions) over the wire session total", () => {
    const tmpXdg = mkdtempSync(join(tmpdir(), "pi-harness-oc-"));
    const prevXdg = process.env.XDG_DATA_HOME;
    try {
      const ocDir = join(tmpXdg, "opencode");
      mkdirSync(ocDir, { recursive: true });
      const ocDb = new Database(join(ocDir, "opencode.db"));
      ocDb.exec(`
        CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT);
        CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);
      `);
      ocDb.prepare("INSERT INTO session(id, parent_id) VALUES (?, ?)").run("oc-root", null);
      ocDb.prepare("INSERT INTO session(id, parent_id) VALUES (?, ?)").run("oc-child", "oc-root");
      ocDb.prepare("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run(
        "m1",
        "oc-root",
        JSON.stringify({ role: "assistant", modelID: "claude-opus-5-5", cost: 0.12 }),
      );
      ocDb.prepare("INSERT INTO message(id, session_id, data) VALUES (?, ?, ?)").run(
        "m2",
        "oc-child",
        JSON.stringify({ role: "assistant", modelID: "claude-haiku-5-5", cost: 0.03 }),
      );
      ocDb.close();

      process.env.XDG_DATA_HOME = tmpXdg;
      const db = new ControlPlaneDb(":memory:");
      try {
        const inv = recordCostInvocation(db, {
          chatSessionId: "chat-oc",
          activity: "task",
          profile: { id: "acp:opencode-api", billing: "api" },
        });
        inv.onSessionId("oc-root");
        inv.onUsage({ used: 1000, size: 200_000, cost: { amount: 0.99, currency: "USD", basis: "session_cumulative" } });
        inv.finish();

        const snap = summarizeCost(
          db,
          { chatSessionId: "chat-oc", runIds: [], snapshotScope: { kind: "chat", id: "chat-oc", label: "OC" } },
          profiles,
        );
        assert.equal(snap.coverage.complete, true);
        assert.deepEqual(snap.totals, [{ currency: "USD", amount: 0.15 }]);
        assert.deepEqual(snap.byModel, [
          { model: "claude-opus-5-5", currency: "USD", amount: 0.12 },
          { model: "claude-haiku-5-5", currency: "USD", amount: 0.03 },
        ]);
      } finally {
        db.close();
      }
    } finally {
      if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prevXdg;
      rmSync(tmpXdg, { recursive: true, force: true });
    }
  });

  it("exposes cost.get over daemon RPC scoped by chat session, owning run, standalone run, and attached session", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-cost-rpc-"));
    const sockPath = join(stateDir, "d.sock");
    const baseCfg = loadConfig();
    const config = withFixtureCatalog({
      ...baseCfg,
      stateDir,
      socketPath: sockPath,
      profiles: [
        { id: "acp:claude-api", kind: "acp", adapter: "claude", command: "unused", billing: "api" },
      ],
      defaultOrchestratorProfile: "acp:claude-api",
      defaultWorkerProfile: "acp:claude-api",
      defaultTaskProfile: "acp:claude-api",
    });

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req: RunAgentRequest) => {
          req.callbacks.onSessionId?.(`ext-${req.taskId}`);
          req.callbacks.onUsage?.({
            used: 1000,
            size: 200_000,
            cost: { amount: 0.18, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" },
          });
          return { text: "Director reply", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const client = new DaemonClient(sockPath);
      await client.connect();
      try {
        const opened = (await client.request("chat.open", { repoRoot: stateDir })) as { session: { id: string } };
        const chatId = opened.session.id;

        // Run a real Director chat turn so runtime.ts records Director spend automatically
        await client.request("chat.send", { chatSessionId: chatId, message: "hello" });

        // Link a goal + run to this chat session and record task + done_review spend under it
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chatId,
          repoRoot: stateDir,
          title: "Cost test goal",
          description: "Verify cost scoping",
          criteria: [{ id: "c1", kind: "behavioral", description: "passes", required: true }],
        });
        const run = daemon.db.createRun({ goal: goal.title, repoRoot: stateDir, baseBranch: "main", baseSha: "abc" });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const taskCost = recordCostInvocation(daemon.db, {
          runId: run.id,
          taskId: "t-worker",
          activity: "task",
          profile: { id: "acp:claude-api", billing: "api" },
        });
        taskCost.onSessionId("ext-worker");
        taskCost.onUsage({ used: 2000, size: 200_000, cost: { amount: 0.42, currency: "USD", basis: "session_cumulative", model: "claude-opus-5-5" } });
        taskCost.finish();

        // 1. cost.get by chatSessionId combines Director turn (0.18) + linked run task (0.42) = 0.60
        const byChat = (await client.request("cost.get", { chatSessionId: chatId })) as CostSnapshot;
        assert.equal(byChat.scope.kind, "chat");
        assert.equal(byChat.scope.id, chatId);
        assert.equal(byChat.available, true);
        assert.equal(byChat.coverage.complete, true);
        assert.deepEqual(byChat.totals, [{ currency: "USD", amount: 0.6 }]);

        // 2. cost.get by runId resolves to the owning chat session
        const byLinkedRun = (await client.request("cost.get", { runId: run.id })) as CostSnapshot;
        assert.equal(byLinkedRun.scope.kind, "chat");
        assert.equal(byLinkedRun.scope.id, chatId);
        assert.deepEqual(byLinkedRun.totals, [{ currency: "USD", amount: 0.6 }]);

        // 3. cost.get with no params resolves to the socket's attached chat session
        const byDefault = (await client.request("cost.get", {})) as CostSnapshot;
        assert.equal(byDefault.scope.kind, "chat");
        assert.equal(byDefault.scope.id, chatId);
        assert.deepEqual(byDefault.totals, [{ currency: "USD", amount: 0.6 }]);

        // 4. Standalone run (not owned by any chat session) returns scope.kind === "run"
        const standaloneRun = daemon.db.createRun({ goal: "Standalone", repoRoot: stateDir, baseBranch: "main", baseSha: "def" });
        const standaloneCost = recordCostInvocation(daemon.db, {
          runId: standaloneRun.id,
          taskId: "t-solo",
          activity: "task",
          profile: { id: "acp:claude-api", billing: "api" },
        });
        standaloneCost.onUsage({ used: 500, size: 200_000, cost: { amount: 0.09, currency: "USD", basis: "session_cumulative", model: "claude-sonnet-5-5" } });
        standaloneCost.finish();

        const byStandalone = (await client.request("cost.get", { runId: standaloneRun.id })) as CostSnapshot;
        assert.equal(byStandalone.scope.kind, "run");
        assert.equal(byStandalone.scope.id, standaloneRun.id);
        assert.deepEqual(byStandalone.totals, [{ currency: "USD", amount: 0.09 }]);
      } finally {
        client.close();
      }
    } finally {
      await daemon.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
