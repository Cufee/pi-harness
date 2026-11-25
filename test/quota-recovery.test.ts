import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { create, toJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { visibleWidth } from "@earendil-works/pi-tui";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { defaultProfiles, loadConfig, type AcpProfileConfig, type PiProfileConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import {
  BucketBindingSchema,
  ModelCapacitySchema,
  QuotaBucketSchema,
  QuotaSnapshotSchema,
  QuotaStatus,
  QuotaWindowSchema,
} from "../src/gen/quota_pb.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { buildPostSessionActions } from "../src/runners/acp-shims.js";
import { PiRunner } from "../src/runners/pi-runner.js";
import { detectQuotaErrorText } from "../src/runners/quota-detect.js";
import type { QuotaRetryStateEvent, RunAgentRequest, RunAgentResult } from "../src/runners/types.js";
import { parseDurationMs } from "../src/tui/core/index.js";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-quota-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function quotaRunConfig(repoDir: string, stateDir: string) {
  const cfg = loadConfig(repoDir);
  cfg.stateDir = stateDir;
  cfg.socketPath = join(stateDir, "d.sock");
  cfg.quotaEndpoint = undefined;
  cfg.quotaRetry.autoResumeEnabled = true;
  cfg.catalog = { ttlHours: 24 };
  cfg.worktree = { archiveRetentionDays: 7, maxConcurrentWorkers: 2 };
  cfg.codeMode = "off";
  cfg.profiles = [
    ...defaultProfiles().filter((profile) => ["acp:claude", "acp:codex"].includes(profile.id)),
    { id: "pi:local", kind: "pi", provider: "fixture", billing: "local", models: ["coordinator"] },
  ];
  cfg.defaultOrchestratorProfile = "pi:local";
  const compiler = new ModelCatalogCompiler(cfg);
  const catalog = compiler.compileFromData({
    enabledProfiles: cfg.profiles,
    inventory: new Map([
      ["pi:local", [{ wireModelId: "coordinator" }]],
      ["acp:claude", [{ wireModelId: "claude-sonnet-4-5" }]],
      ["acp:codex", [{ wireModelId: "gpt-5" }]],
    ]),
    profileStatuses: cfg.profiles.map((profile) => ({ profileId: profile.id, status: "ok", modelCount: 1 })),
    modelsDev: [], openRouter: [], litellmDep: new Map(), benchmarks: [], sources: [],
  });
  writeFileSync(compiler.cachePath, JSON.stringify(catalog));
  return cfg;
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("Tool-Failure Recovery, Robust Circuit Breaker & Subscription-Pool Quota State Machine", () => {
  it("recovers when an ACP agent stops silently after a failed tool call, and lets the model report inability cleanly", async () => {
    let promptCalls = 0;
    let titleOnlyRequestDenied = false;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.109.1" } } as never))
      .onRequest("session/new", async () => ({ sessionId: "sess-rec", models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] } } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        promptCalls++;
        if (promptCalls === 1) {
          // A display title cannot authorize native execution.
          const perm = (await acpClient.request("session/request_permission", {
            sessionId: "sess-rec",
            toolCall: { toolCallId: "tc-h", title: "goal_create", kind: "execute" },
            options: [
              { optionId: "allow", kind: "allow_once", name: "Allow" },
              { optionId: "deny", kind: "reject_once", name: "Deny" },
            ],
          } as never)) as unknown as { outcome: { optionId?: string } };
          titleOnlyRequestDenied = perm.outcome.optionId === "deny";

          // Simulate a failing tool followed by silent end_turn (the bug that caused `(done)`)
          await acpClient.notify("session/update", {
            sessionId: "sess-rec",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-fail-1",
              title: "shell_exec",
              status: "failed",
              rawOutput: { error: "permission denied: read-only session" },
            },
          } as never);
          return { stopReason: "end_turn" } as never;
        }

        // On continuation, model explains clearly that it cannot do the action -> harness accepts & stops!
        await acpClient.notify("session/update", {
          sessionId: "sess-rec",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "I am unable to modify files in read-only mode; please launch a Goal instead." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner({
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "noop",
      billing: "subscription",
    });

    const res = await runner.run(
      {
        runId: "chat-1",
        taskId: "chat-1",
        tier: 1,
        kind: "orchestrator",
        cwd: process.cwd(),
        toolPolicy: "control_plane_only",
        model: "fixture",
        systemPrompt: "Director",
        initialPrompt: "Edit a file",
        maxTurns: 5,
        tools: [{ name: "goal_create", description: "Create goal", inputSchema: {} }],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
      },
      mockAgent,
    );

    assert.equal(titleOnlyRequestDenied, true);
    assert.equal(promptCalls, 2);
    assert.equal(res.stopReason, "completed");
    assert.ok(res.text.includes("unable to modify files"));

    // Writable sessions retain per-call approval.
    const post = buildPostSessionActions(
      "generic",
      "s1",
      { configOptions: [{ id: "permission", options: [{ value: "default" }, { value: "bypass" }] }] },
      { toolPolicy: "read_write_workspace", model: "fixture" },
    );
    assert.ok(!post.some((a) => a.method === "session/set_config_option" && a.params.configId === "permission" && a.params.value === "bypass"));
  });

  it("never trips circuit breaker on exploratory failures with successes, but breaks wedged 6x identical failure loops", async () => {
    // Part A: 10 exploratory tool failures interspersed with successful tool calls -> completes cleanly in 1 prompt!
    let exploratoryPrompts = 0;
    const exploratoryAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({ sessionId: "sess-exp", models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] } } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        exploratoryPrompts++;
        for (let i = 0; i < 10; i++) {
          await acpClient.notify("session/update", {
            sessionId: "sess-exp",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: `fail-${i}`,
              title: "run_cmd",
              status: "failed",
              rawOutput: { error: `ENOENT attempt ${i}` },
            },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "sess-exp",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: `ok-${i}`,
              title: "read_file",
              status: "completed",
            },
          } as never);
        }
        await acpClient.notify("session/update", {
          sessionId: "sess-exp",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Found the right file after poking around." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const profile: AcpProfileConfig = {
      id: "acp:codex",
      kind: "acp",
      adapter: "codex",
      command: "noop",
      billing: "subscription",
    };
    const resA = await new AcpRunner(profile).run(
      {
        runId: "r1",
        taskId: "t1",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_write_workspace",
        model: "fixture",
        systemPrompt: "Worker",
        initialPrompt: "Explore",
        maxTurns: 10,
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
      },
      exploratoryAgent,
    );
    assert.equal(exploratoryPrompts, 1);
    assert.equal(resA.stopReason, "completed");
    assert.ok(resA.text.includes("Found the right file"));

    // Part B: 6 consecutive identical failures with ZERO successes -> trips circuit breaker, cancels, asks model to explain
    let wedgedPrompts = 0;
    let cancelHit = false;
    const wedgedAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({ sessionId: "sess-wedge", models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] } } as never))
      .onNotification("session/cancel", async () => {
        cancelHit = true;
      })
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        wedgedPrompts++;
        if (wedgedPrompts === 1) {
          for (let i = 0; i < 6; i++) {
            await acpClient.notify("session/update", {
              sessionId: "sess-wedge",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: `same-${i}`,
                title: "broken_tool",
                status: "failed",
                rawOutput: { error: "ECONNREFUSED 127.0.0.1:9999" },
              },
            } as never);
          }
          await new Promise((r) => setTimeout(r, 20));
          return { stopReason: cancelHit ? "cancelled" : "end_turn" } as never;
        }
        await acpClient.notify("session/update", {
          sessionId: "sess-wedge",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Blocked: local service on port 9999 is unreachable." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const resB = await new AcpRunner(profile).run(
      {
        runId: "r2",
        taskId: "t2",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_write_workspace",
        model: "fixture",
        systemPrompt: "Worker",
        initialPrompt: "Call service",
        maxTurns: 10,
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
      },
      wedgedAgent,
    );
    assert.equal(cancelHit, true);
    assert.equal(wedgedPrompts, 2);
    assert.equal(resB.stopReason, "completed");
    assert.ok(resB.text.includes("port 9999 is unreachable"));
  });

  it("disarms soft quota watchdog on pool-rotation recovery, and pauses cleanly when watchdog times out", async () => {
    const profile: AcpProfileConfig = {
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "noop",
      billing: "subscription",
    };

    // Case 1: 2 rate-limit rejections followed by forward progress within timeout -> recovers & completes!
    const retryEvents1: QuotaRetryStateEvent[] = [];
    const recoveringAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({ sessionId: "sess-pool-ok", models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] } } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        for (let i = 0; i < 2; i++) {
          await acpClient.notify("session/update", {
            sessionId: "sess-pool-ok",
            update: {
              sessionUpdate: "usage_update",
              used: 100,
              size: 1000,
              _meta: { "_claude/rateLimit": { status: "rejected", rateLimitType: "five_hour" } },
            },
          } as never);
          await new Promise((r) => setTimeout(r, 25));
        }
        // Pool proxy switched accounts -> healthy text delta arrives!
        await acpClient.notify("session/update", {
          sessionId: "sess-pool-ok",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Recovered after account switch!" },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const okRes = await new AcpRunner(profile).run(
      {
        runId: "r-ok",
        taskId: "t-ok",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_write_workspace",
        model: "fixture",
        systemPrompt: "Worker",
        initialPrompt: "Work",
        maxTurns: 5,
        quotaRetryTimeoutMs: 400,
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: { onQuotaRetryState: (ev) => retryEvents1.push(ev) },
      },
      recoveringAgent,
    );
    assert.equal(okRes.stopReason, "completed");
    assert.equal(okRes.text, "Recovered after account switch!");
    assert.deepEqual(
      retryEvents1.map((e) => e.state),
      ["retrying", "recovered"],
    );

    // Case 2: Persistent stall past quotaRetryTimeoutMs -> watchdog cancels & returns stopReason='quota_paused'
    let cancelSignaled = false;
    const stalledAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({ sessionId: "sess-stall", models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] } } as never))
      .onNotification("session/cancel", async () => {
        cancelSignaled = true;
      })
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        const futureSec = Math.floor((Date.now() + 120_000) / 1000);
        await acpClient.notify("session/update", {
          sessionId: "sess-stall",
          update: {
            sessionUpdate: "usage_update",
            used: 100,
            size: 1000,
            _meta: { "_claude/rateLimit": { status: "rejected", rateLimitType: "five_hour", resetsAt: futureSec } },
          },
        } as never);
        // Simulate CLI hanging in native retry loop until watchdog cancels it
        await waitUntil(() => cancelSignaled, 1500, 15);
        return { stopReason: "cancelled" } as never;
      });

    const pausedRes = await new AcpRunner(profile).run(
      {
        runId: "r-stall",
        taskId: "t-stall",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_write_workspace",
        model: "fixture",
        systemPrompt: "Worker",
        initialPrompt: "Work",
        maxTurns: 5,
        quotaRetryTimeoutMs: 120,
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
      },
      stalledAgent,
    );
    assert.equal(cancelSignaled, true);
    assert.equal(pausedRes.stopReason, "quota_paused");
    assert.equal(pausedRes.quotaPause?.watchdogTimedOut, true);
    assert.ok(pausedRes.quotaPause?.resetAt);
  });

  it("handles quiescence barrier without Quota Endpoint (manual stop + user-chosen wait timer + manual resume reset & re-pause)", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-qstate-"));

    let quotaStillExhausted = true;
    let runAttempts = 0;
    let lastHydratedPrompt = "";

    const cfg = quotaRunConfig(repoDir, stateDir);
    const longProviderLine =
      `HTTP 429 Too Many Requests (sub pool exhausted): ${"diagnostic-token-".repeat(12)}tail-sentinel-273-chars`;
    const shortReason = longProviderLine.slice(0, 220);

    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
          if (req.tier === 1) {
            runAttempts++;
            lastHydratedPrompt = req.initialPrompt;
            if (quotaStillExhausted) {
              if (runAttempts === 1) {
                daemon.db.updateTask(req.taskId, {
                  resultJson: JSON.stringify({ priorKey: "preserve-me", priorCount: 42 }),
                });
              }
              return {
                text: "",
                stopReason: "quota_paused",
                quotaPause: {
                  reason: shortReason,
                  detail: longProviderLine,
                  resetAt: null,
                  retryCount: 3,
                  watchdogTimedOut: true,
                  isHardExhaustion: false,
                },
              };
            }
            return { text: "Finished cleanly after resume!", stopReason: "completed" };
          }
          return { text: "ok", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    const client = new DaemonClient(cfg.socketPath);
    await client.connect();

    try {
      const { run } = await client.request<{ run: { id: string } }>("run.create", {
        goal: "Test quota quiescence without endpoint",
        repoRoot: repoDir,
      });

      // 1. Without a Quota Endpoint or resetAt, run pauses cleanly in `manual` mode (NO auto-retry loop!)
      await waitUntil(() => daemon.db.getRun(run.id)?.status === "paused_quota");
      const q1 = daemon.orchestrator.getRunQuotaStatus(run.id);
      assert.equal(q1?.mode, "manual");
      assert.equal(q1?.resumeAt, null);
      assert.equal(runAttempts, 1);

      const pausedOrch = daemon.db.listTasks(run.id).find((t) => t.tier === 1);
      assert.ok(pausedOrch?.summary?.startsWith("Paused (quota): "));
      assert.ok(pausedOrch?.summary?.includes("coordinator"), `expected model in summary, got: ${pausedOrch?.summary}`);
      assert.ok(!pausedOrch?.summary?.includes("429 Too Many Requests"), `raw line should not be in summary: ${pausedOrch?.summary}`);
      const parsedResult = pausedOrch?.resultJson
        ? (JSON.parse(pausedOrch.resultJson) as { quotaDetail?: string; priorKey?: string; priorCount?: number })
        : {};
      assert.equal(parsedResult.quotaDetail, longProviderLine);
      assert.equal(parsedResult.priorKey, "preserve-me");
      assert.equal(parsedResult.priorCount, 42);
      const pausedEvent = daemon.db.getEventsSince(run.id, 0).find((e) => e.type === "quota.agent_paused");
      assert.equal((pausedEvent?.payload as { reason?: string } | undefined)?.reason, shortReason);
      assert.equal((pausedEvent?.payload as { detail?: string } | undefined)?.detail, longProviderLine);

      // 2. User manually resumes with a message while quota is STILL exhausted -> resets state machine & walks cleanly back to paused_quota!
      await client.request("run.resume", { runId: run.id, message: "try resuming now" });
      await waitUntil(() => runAttempts === 2 && daemon.db.getRun(run.id)?.status === "paused_quota");
      assert.ok(lastHydratedPrompt.includes("try resuming now"));
      assert.equal(daemon.orchestrator.getRunQuotaStatus(run.id)?.mode, "manual");

      // 3. Now quota becomes available, and user selects a custom wait duration (120ms via scheduleRunQuotaResume) -> auto-resumes & completes!
      quotaStillExhausted = false;
      const scheduled = daemon.orchestrator.scheduleRunQuotaResume(run.id, 1000);
      assert.equal(scheduled.mode, "user_timer");
      assert.ok(scheduled.resumeAt);
      assert.equal(daemon.orchestrator.scheduledQuotaResumeCount(), 1);

      await waitUntil(() => daemon.db.getRun(run.id)?.status === "completed", 3000);
      assert.equal(runAttempts, 3);
      assert.equal(daemon.orchestrator.scheduledQuotaResumeCount(), 0);
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("auto-resumes after quiescence using live Quota Endpoint nextAvailableAt while letting healthy siblings finish first", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-qep-"));

    let endpointAvailable = false;
    let resetAtMs = Date.now() + 350;

    // Spin up a real ProtoJSON Quota Endpoint matching proto/quota.proto
    const server = createServer((_req, res) => {
      const snap = create(QuotaSnapshotSchema, {
        generatedAt: timestampFromMs(Date.now()),
        ttlSeconds: 1,
        buckets: [
          create(QuotaBucketSchema, {
            bucketId: "claude:5h",
            provider: "claude",
            displayName: "Claude 5h Pool",
            windows: [
              create(QuotaWindowSchema, {
                windowId: "five_hour",
                label: "5h",
                remainingRatio: endpointAvailable ? 0.9 : 0,
                resetAt: timestampFromMs(resetAtMs),
                binding: true,
                status: endpointAvailable ? QuotaStatus.AVAILABLE : QuotaStatus.EXHAUSTED,
              }),
            ],
          }),
        ],
        models: [
          create(ModelCapacitySchema, {
            provider: "claude",
            profile: "acp:claude",
            modelId: "*",
            bucketBindings: [create(BucketBindingSchema, { bucketId: "claude:5h", required: true })],
          }),
        ],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(toJsonString(QuotaSnapshotSchema, snap));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;

    const cfg = quotaRunConfig(repoDir, stateDir);
    cfg.quotaEndpoint = { url: `http://127.0.0.1:${port}/v1/quota`, format: "protojson", pollIntervalSec: 1 };
    cfg.quotaRetry.earlyWakePollMs = 5_000;

    let workerAAttempts = 0;
    let workerBFinished = false;
    let orchFinished = false;

    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
          if (req.tier === 1) {
            const existingChildren = daemon.db.listTasks(req.runId).filter((t) => t.tier === 2);
            if (existingChildren.length === 0) {
              // Spawn Worker A (hits quota immediately) and Worker B (healthy, takes 180ms to finish)
              await req.executeTool("spawn_worker", {
                title: "Worker A (claude quota)",
                objective: "Slice A",
                write_scopes: ["a/**"],
                profile_id: "acp:claude",
                model: "claude-sonnet-4-5",
              });
              await req.executeTool("spawn_worker", {
                title: "Worker B (healthy)",
                objective: "Slice B",
                write_scopes: ["b/**"],
                profile_id: "acp:codex",
                model: "gpt-5",
              });
            }
            await req.executeTool("wait_children", { mode: "all", timeout_s: 5 });
            const kids = daemon.db.listTasks(req.runId).filter((t) => t.tier === 2);
            if (kids.every((k) => k.status === "completed")) {
              orchFinished = true;
              return { text: "All workers complete!", stopReason: "completed" };
            }
            // Exit turn while Worker A is paused_quota -> orchestrator pauses Tier 1 cleanly instead of completing run!
            return { text: "Waiting for paused worker", stopReason: "completed" };
          }

          if (req.initialPrompt.includes("Slice A")) {
            workerAAttempts++;
            if (workerAAttempts === 1) {
              resetAtMs = Date.now() + 250;
              return {
                text: "",
                stopReason: "quota_paused",
                quotaPause: {
                  reason: "Claude 5h pool exhausted",
                  resetAt: null,
                  retryCount: 2,
                  watchdogTimedOut: true,
                  isHardExhaustion: true,
                },
              };
            }
            return { text: "Slice A completed after auto-resume!", stopReason: "completed" };
          }

          // Healthy sibling Worker B keeps running to completion even after Worker A paused!
          await new Promise((r) => setTimeout(r, 150));
          workerBFinished = true;
          return { text: "Slice B completed cleanly!", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const { run } = await daemon.orchestrator.startRun({
        goal: "Parallel workers with one quota-paused and one healthy",
        repoRoot: repoDir,
        profileId: "pi:local",
      });

      // Wait for quiescence barrier: Worker B MUST finish before run enters paused_quota!
      await waitUntil(() => daemon.db.getRun(run.id)?.status === "paused_quota", 4000);
      assert.equal(workerBFinished, true);
      const qStatus = daemon.orchestrator.getRunQuotaStatus(run.id);
      assert.equal(qStatus?.mode, "auto_timer");
      assert.equal(qStatus?.source, "quota_endpoint");
      assert.ok(qStatus?.resumeAt);

      const pausedWorkerA = daemon.db.listTasks(run.id).find((t) => t.title === "Worker A (claude quota)");
      assert.ok(pausedWorkerA?.summary?.startsWith("Paused (quota): "));
      assert.ok(pausedWorkerA?.summary?.includes("claude-sonnet-4-5"), `expected model in summary, got: ${pausedWorkerA?.summary}`);
      assert.ok(pausedWorkerA?.summary?.includes("quota exhausted"), `expected hard exhaustion wording, got: ${pausedWorkerA?.summary}`);
      assert.ok(!pausedWorkerA?.summary?.includes("Claude 5h pool exhausted"), `raw line should not be in summary: ${pausedWorkerA?.summary}`);
      const workerResult = pausedWorkerA?.resultJson ? (JSON.parse(pausedWorkerA.resultJson) as { quotaDetail?: string }) : {};
      assert.equal(workerResult.quotaDetail, "Claude 5h pool exhausted");

      // Flip endpoint available; auto-resume timer fires (~3.25s with safety cushion) and finishes the entire run!
      endpointAvailable = true;
      await waitUntil(() => daemon.db.getRun(run.id)?.status === "completed", 6000);
      assert.equal(workerAAttempts, 2);
      assert.equal(orchFinished, true);
    } finally {
      await daemon.stop();
      server.close();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("parses wait durations and detects quota error strings", () => {
    assert.equal(parseDurationMs("30s"), 30_000);
    assert.equal(parseDurationMs("15m"), 900_000);
    assert.equal(parseDurationMs("1h30m"), 5_400_000);
    assert.equal(parseDurationMs("10"), 600_000);
    assert.equal(parseDurationMs("in 45m"), 2_700_000);
    assert.equal(parseDurationMs("bogus"), null);

    const d1 = detectQuotaErrorText("HTTP 429 Too Many Requests; Retry-After: 45");
    assert.equal(d1.isQuota, true);
    assert.equal(d1.isHardExhaustion, false);
    assert.equal(d1.retryAfterSec, 45);

    const d2 = detectQuotaErrorText("You've hit your individual spend limit · run /usage-credits");
    assert.equal(d2.isQuota, true);
    assert.equal(d2.isHardExhaustion, true);

    const longLine = `HTTP 429 Too Many Requests: ${"x".repeat(230)}END-TAIL-MARKER`;
    const dLong = detectQuotaErrorText(`unrelated prefix\n${longLine}\nunrelated suffix`);
    assert.equal(dLong.isQuota, true);
    assert.equal(dLong.summary.length, 220);
    assert.equal(dLong.detail, longLine);
    assert.ok(dLong.detail.endsWith("END-TAIL-MARKER"));

    const hugeLine = `HTTP 429 Too Many Requests: ${"y".repeat(2500)}`;
    const dHuge = detectQuotaErrorText(hugeLine);
    assert.equal(dHuge.isQuota, true);
    assert.equal(dHuge.detail.length, 2000);

    const dNone = detectQuotaErrorText("ENOENT: file not found");
    assert.equal(dNone.isQuota, false);
    assert.equal(dNone.detail, "");
  });

  it("preserves untruncated >220-char provider quota lines in quotaPause.detail and resultJson.quotaDetail across AcpRunner and PiRunner", async () => {
    const longQuotaLine =
      `You've hit your individual spend limit: ${"provider-context-".repeat(13)}END-QUOTA-DETAIL-MARKER`;
    assert.ok(longQuotaLine.length > 220);
    const acpProfile: AcpProfileConfig = {
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "noop",
      billing: "subscription",
    };

    // 1. AcpRunner turn-end hard quota message -> untruncated detail in quotaPause.detail
    const acpTextAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-detail-text",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        await acpClient.notify("session/update", {
          sessionId: "sess-detail-text",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: longQuotaLine },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const acpTextRes = await new AcpRunner(acpProfile).run(
      {
        runId: "r-detail-1",
        taskId: "t-detail-1",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_write_workspace",
        model: "fixture",
        systemPrompt: "Worker",
        initialPrompt: "Work",
        maxTurns: 5,
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
      },
      acpTextAgent,
    );
    assert.equal(acpTextRes.stopReason, "quota_paused");
    assert.equal(acpTextRes.quotaPause?.reason, longQuotaLine.slice(0, 220));
    assert.equal(acpTextRes.quotaPause?.detail, longQuotaLine);
    assert.ok(acpTextRes.quotaPause?.detail?.endsWith("END-QUOTA-DETAIL-MARKER"));

    // 2. AcpRunner error/catch path wired through HarnessDaemon -> untruncated line lands in resultJson.quotaDetail
    const longRpcLine = `HTTP 429 Too Many Requests (quota exceeded): ${"rpc-trace-".repeat(20)}RPC-DETAIL-MARKER`;
    assert.ok(longRpcLine.length > 220);
    const acpErrAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-detail-err",
        models: { currentModelId: "coordinator", availableModels: [{ modelId: "coordinator", name: "Coordinator" }] },
      } as never))
      .onRequest("session/prompt", async () => {
        throw new Error(longRpcLine);
      });

    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-qdetail-"));
    const cfg = quotaRunConfig(repoDir, stateDir);
    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: (req: RunAgentRequest) => new AcpRunner(acpProfile).run(req, acpErrAgent),
      }),
    });

    await daemon.start();
    try {
      const { run } = await daemon.orchestrator.startRun({
        goal: "Verify AcpRunner quota detail persistence",
        repoRoot: repoDir,
        profileId: "pi:local",
      });
      await waitUntil(() => daemon.db.getRun(run.id)?.status === "paused_quota", 4000);
      const pausedOrch = daemon.db.listTasks(run.id).find((t) => t.tier === 1);
      assert.ok(pausedOrch?.summary?.startsWith("Paused (quota): "));
      const parsedResult = pausedOrch?.resultJson
        ? (JSON.parse(pausedOrch.resultJson) as { quotaDetail?: string })
        : {};
      assert.ok(parsedResult.quotaDetail && parsedResult.quotaDetail.length > 220);
      assert.ok(parsedResult.quotaDetail?.includes(longRpcLine), `expected full RPC line, got: ${parsedResult.quotaDetail}`);
      assert.ok(parsedResult.quotaDetail?.endsWith("RPC-DETAIL-MARKER"));
      const pausedEvent = daemon.db.getEventsSince(run.id, 0).find((e) => e.type === "quota.agent_paused");
      assert.equal((pausedEvent?.payload as { detail?: string } | undefined)?.detail, parsedResult.quotaDetail);
      assert.equal((pausedEvent?.payload as { reason?: string } | undefined)?.reason?.length, 220);
    } finally {
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }

    // 3. PiRunner HTTP 429 hard quota error -> untruncated detail in quotaPause.detail
    const piServer = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ error: { message: longQuotaLine, type: "insufficient_quota" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    });
    try {
      const piProfile: PiProfileConfig = {
        id: "pi:test-quota",
        kind: "pi",
        provider: "local-test",
        api: "openai-completions",
        baseUrl: `${piServer.url.toString().replace(/\/$/, "")}/v1`,
        billing: "local",
        models: ["test-model"],
      };
      const piRes = await new PiRunner(piProfile).run({
        runId: "r-pi-detail",
        taskId: "t-pi-detail",
        tier: 2,
        kind: "worker",
        cwd: process.cwd(),
        toolPolicy: "read_only_workspace",
        model: "test-model",
        systemPrompt: "Worker",
        initialPrompt: "Work",
        tools: [],
        executeTool: async () => ({}),
        signal: new AbortController().signal,
        callbacks: {},
      });
      assert.equal(piRes.stopReason, "quota_paused");
      assert.equal(piRes.quotaPause?.reason.length, 220);
      assert.ok(piRes.quotaPause?.detail && piRes.quotaPause.detail.length > 220);
      assert.ok(
        piRes.quotaPause?.detail?.includes("END-QUOTA-DETAIL-MARKER"),
        `expected full provider line in PiRunner quotaPause.detail, got: ${piRes.quotaPause?.detail}`,
      );
    } finally {
      piServer.stop(true);
    }
  });
});
