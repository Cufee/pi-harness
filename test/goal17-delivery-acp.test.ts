import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig, type AcpProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { buildRunActivitySummary } from "../src/control-plane/telemetry.js";
import { GoalEngine } from "../src/goals/engine.js";
import { QuotaClient } from "../src/quota/client.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import type { RunnerExecutionHandle } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const AMP_PROFILE: AcpProfileConfig = {
  id: "acp:amp",
  kind: "acp",
  adapter: "generic",
  command: "npx",
  args: ["-y", "amp-acp"],
  billing: "subscription",
};

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, baseSha };
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  assert.ok(pred(), `Timed out waiting for ${label}`);
}

describe("goal-17 ACP steer ack, single delivery path, and cancel/drain events", () => {
  it("Finding 1: replacement session/prompt rejected before model reports steer not live (false)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g17-f1-reject-"));
    try {
      let resolveTurn1!: (res: { stopReason: string }) => void;
      const turn1Ready = Promise.withResolvers<void>();
      let promptCalls = 0;

      const testAgent = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-f1-reject",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          resolveTurn1?.({ stopReason: "cancelled" });
        })
        .onRequest("session/prompt", async () => {
          promptCalls += 1;
          if (promptCalls === 1) {
            turn1Ready.resolve();
            return (await new Promise<{ stopReason: string }>((r) => {
              resolveTurn1 = r;
            })) as never;
          }
          throw new Error("replacement rejected before model");
        })
        .onRequest("*", async ({ method }) => {
          if (method === "_amp/session/steer") return { outcome: "queued" } as never;
          throw new Error(`Unexpected method ${method}`);
        });

      let handle: RunnerExecutionHandle | undefined;
      const runner = new AcpRunner(AMP_PROFILE);
      const runPromise = runner.run(
        {
          runId: "r-f1-reject",
          taskId: "t-f1-reject",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Initial work",
          model: "anthropic/claude-opus-5-5",
          maxTurns: 10,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          onHandle: (h) => {
            handle = h;
          },
          callbacks: {},
        },
        testAgent,
      );
      runPromise.catch(() => {});

      await turn1Ready.promise;
      assert.ok(handle, "expected runner handle");
      const live = await handle.steer("STOP: goal amended to v2");
      assert.equal(live, false, "rejected replacement prompt must not report live steer delivery");

      await assert.rejects(runPromise, /replacement rejected before model/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Finding 1: steer resolves live on matched user_message_chunk without awaiting the whole turn, and returns false on ack timeout", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g17-f1-ack-"));
    try {
      // Part A: matched user_message_chunk confirms live delivery while turn 2 is still running.
      let resolveTurn1!: (res: { stopReason: string }) => void;
      const turn1Ready = Promise.withResolvers<void>();
      const releaseTurn2 = Promise.withResolvers<void>();
      let turn2Completed = false;
      let promptCalls = 0;

      const echoAgent = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-f1-echo",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          resolveTurn1?.({ stopReason: "cancelled" });
        })
        .onRequest("session/prompt", async ({ params, client: acpClient }) => {
          promptCalls += 1;
          const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
          if (promptCalls === 1) {
            turn1Ready.resolve();
            return (await new Promise<{ stopReason: string }>((r) => {
              resolveTurn1 = r;
            })) as never;
          }
          await acpClient.notify("session/update", {
            sessionId: "S-f1-echo",
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
          } as never);
          await releaseTurn2.promise;
          await acpClient.notify("session/update", {
            sessionId: "S-f1-echo",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after-echo-ack" } },
          } as never);
          turn2Completed = true;
          return { stopReason: "end_turn" } as never;
        })
        .onRequest("*", async ({ method }) => {
          if (method === "_amp/session/steer") return { outcome: "queued" } as never;
          throw new Error(`Unexpected method ${method}`);
        });

      let echoHandle: RunnerExecutionHandle | undefined;
      const echoRunner = new AcpRunner(AMP_PROFILE);
      const echoRun = echoRunner.run(
        {
          runId: "r-f1-echo",
          taskId: "t-f1-echo",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Initial work",
          model: "anthropic/claude-opus-5-5",
          maxTurns: 10,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          onHandle: (h) => {
            echoHandle = h;
          },
          callbacks: {},
        },
        echoAgent,
      );

      await turn1Ready.promise;
      assert.ok(echoHandle);
      const acked = await echoHandle.steer("STOP: goal amended to v2");
      assert.equal(acked, true, "matched user_message_chunk should confirm live delivery");
      assert.equal(turn2Completed, false, "steer must resolve without awaiting the whole replacement turn");

      releaseTurn2.resolve();
      const echoRes = await echoRun;
      assert.equal(echoRes.stopReason, "completed");
      assert.ok(echoRes.text.includes("after-echo-ack"));

      // Part B: replacement prompt that never emits an ack signal times out as not live (false).
      let resolveHangTurn1!: (res: { stopReason: string }) => void;
      let resolveHangTurn2!: (res: { stopReason: string }) => void;
      const hangTurn1Ready = Promise.withResolvers<void>();
      let hangPrompts = 0;
      let hangCancels = 0;

      const hangAgent = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-f1-hang",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          hangCancels += 1;
          if (hangCancels === 1) resolveHangTurn1?.({ stopReason: "cancelled" });
          else resolveHangTurn2?.({ stopReason: "cancelled" });
        })
        .onRequest("session/prompt", async () => {
          hangPrompts += 1;
          if (hangPrompts === 1) {
            hangTurn1Ready.resolve();
            return (await new Promise<{ stopReason: string }>((r) => {
              resolveHangTurn1 = r;
            })) as never;
          }
          // Never emits user_message_chunk or any model output.
          return (await new Promise<{ stopReason: string }>((r) => {
            resolveHangTurn2 = r;
          })) as never;
        })
        .onRequest("*", async ({ method }) => {
          if (method === "_amp/session/steer") return { outcome: "queued" } as never;
          throw new Error(`Unexpected method ${method}`);
        });

      let hangHandle: RunnerExecutionHandle | undefined;
      const hangRunner = new AcpRunner(AMP_PROFILE, { steerAckTimeoutMs: 60 });
      const hangRun = hangRunner.run(
        {
          runId: "r-f1-hang",
          taskId: "t-f1-hang",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Initial work",
          model: "anthropic/claude-opus-5-5",
          maxTurns: 10,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          onHandle: (h) => {
            hangHandle = h;
          },
          callbacks: {},
        },
        hangAgent,
      );

      await hangTurn1Ready.promise;
      assert.ok(hangHandle);
      const timedOutLive = await hangHandle.steer("STOP: hung replacement");
      assert.equal(timedOutLive, false, "unacknowledged replacement prompt must time out as not live");
      const hangRes = await hangRun;
      assert.equal(hangRes.stopReason, "cancelled");
      assert.ok(hangCancels >= 2, "ack timeout should cancel the unacknowledged replacement prompt");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Finding 2: single delivery path — never probes mutating _amp/session/steer or double-delivers on disabled handoff, SDK transport, or concurrent steer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g17-f2-single-"));
    try {
      // Helper simulating real amp-acp's mutating _amp/session/steer queue: any queued steer autonomously runs
      // as an extra turn when the current turn ends.
      const runScenario = async (opts: {
        extraEnv?: Record<string, string>;
        steerCount?: number;
      }) => {
        const deliveredTexts: string[] = [];
        const adapterQueue: string[] = [];
        const harnessQueue: string[] = [];
        let steerRpcCalls = 0;
        let cancelCount = 0;
        let finishTurn1!: (res: { stopReason: string }) => void;
        let finishTurn2!: (res: { stopReason: string }) => void;
        const turn1Ready = Promise.withResolvers<void>();
        const turn2Started = Promise.withResolvers<void>();
        let promptCalls = 0;

        const fakeAmpAgent = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: "S-f2",
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            cancelCount += 1;
            adapterQueue.length = 0;
            finishTurn1?.({ stopReason: "cancelled" });
          })
          .onRequest("session/prompt", async ({ params, client: acpClient }) => {
            promptCalls += 1;
            const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
            if (promptCalls === 1) {
              turn1Ready.resolve();
              const res = await new Promise<{ stopReason: string }>((r) => {
                finishTurn1 = r;
              });
              // Simulate amp-acp's startNextQueuedPrompt() autonomously running any queued adapter steer on normal turn end.
              if (res.stopReason !== "cancelled" && adapterQueue.length > 0) {
                const queued = adapterQueue.shift()!;
                deliveredTexts.push(queued);
              }
              return res as never;
            }
            deliveredTexts.push(text);
            if (promptCalls === 2 && opts.steerCount === 2) {
              turn2Started.resolve();
              await new Promise<{ stopReason: string }>((r) => {
                finishTurn2 = r;
              });
              await acpClient.notify("session/update", {
                sessionId: "S-f2",
                update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
              } as never);
              return { stopReason: "end_turn" } as never;
            }
            await acpClient.notify("session/update", {
              sessionId: "S-f2",
              update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
            } as never);
            return { stopReason: "end_turn" } as never;
          })
          .onRequest("*", async ({ method, params }) => {
            if (method === "_amp/session/steer") {
              steerRpcCalls += 1;
              const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
              adapterQueue.unshift(text);
              return { outcome: "queued" } as never;
            }
            throw new Error(`Unexpected method ${method}`);
          });

        let handle: RunnerExecutionHandle | undefined;
        const runner = new AcpRunner(AMP_PROFILE);
        const runPromise = runner.run(
          {
            runId: "r-f2",
            taskId: "t-f2",
            tier: 2,
            kind: "worker",
            cwd,
            toolPolicy: "read_write_workspace",
            systemPrompt: "Worker",
            initialPrompt: "Initial work",
            model: "anthropic/claude-opus-5-5",
            maxTurns: 10,
            extraEnv: opts.extraEnv,
            tools: [],
            executeTool: async () => ({}),
            drainPendingSteers: () => harnessQueue.splice(0),
            signal: new AbortController().signal,
            onHandle: (h) => {
              handle = h;
            },
            callbacks: {},
          },
          fakeAmpAgent,
        );

        await turn1Ready.promise;
        assert.ok(handle);

        if (opts.steerCount === 2) {
          // First steer starts cancel-then-prompt (still pending ack); second steer must fall back cleanly without probing _amp/session/steer.
          const firstSteerPromise = handle.steer("AMEND_ONE");
          await turn2Started.promise;
          const secondLive = await handle.steer("AMEND_TWO");
          assert.equal(secondLive, false, "second steer while replacement ack is pending must fall back to harness queue");
          harnessQueue.push("AMEND_TWO");
          finishTurn2({ stopReason: "end_turn" });
          const firstLive = await firstSteerPromise;
          assert.equal(firstLive, true);
        } else {
          const live = await handle.steer("AMEND_SINGLE");
          assert.equal(live, false);
          harnessQueue.push("AMEND_SINGLE");
          finishTurn1({ stopReason: "end_turn" });
        }

        const res = await runPromise;
        assert.equal(res.stopReason, "completed");
        return { deliveredTexts, steerRpcCalls, cancelCount };
      };

      // Case A: explicit override disables cancel-then-prompt -> no _amp/session/steer probe, single harness delivery.
      const killCase = await runScenario({ extraEnv: { AMP_ACP_CANCEL_MODE: "kill" } });
      assert.equal(killCase.steerRpcCalls, 0, "must never probe mutating _amp/session/steer when handoff is disabled");
      assert.equal(killCase.cancelCount, 0);
      assert.equal(
        killCase.deliveredTexts.filter((t) => t.includes("AMEND_SINGLE")).length,
        1,
        `expected exactly 1 delivery, got ${JSON.stringify(killCase.deliveredTexts)}`,
      );

      // Case B: SDK transport must not be forced into CLI-only cancel-then-prompt steering, and must not double-deliver.
      const sdkCase = await runScenario({ extraEnv: { AMP_ACP_TRANSPORT: "sdk" } });
      assert.equal(sdkCase.steerRpcCalls, 0, "SDK transport must not probe mutating _amp/session/steer");
      assert.equal(sdkCase.cancelCount, 0, "SDK transport must not trigger CLI-only cancel-then-prompt");
      assert.equal(
        sdkCase.deliveredTexts.filter((t) => t.includes("AMEND_SINGLE")).length,
        1,
        `expected exactly 1 delivery on SDK transport, got ${JSON.stringify(sdkCase.deliveredTexts)}`,
      );

      // Case C: second steer while an earlier replacement handoff is still outstanding -> no _amp/session/steer probe, single delivery each.
      const overlapCase = await runScenario({ steerCount: 2 });
      assert.equal(overlapCase.steerRpcCalls, 0, "must not probe _amp/session/steer while replacement handoff is in flight");
      assert.equal(overlapCase.cancelCount, 1);
      assert.equal(overlapCase.deliveredTexts.filter((t) => t.includes("AMEND_ONE")).length, 1);
      assert.equal(overlapCase.deliveredTexts.filter((t) => t.includes("AMEND_TWO")).length, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Finding 2: re-checks abort and task settlement after awaiting session/cancel before sending replacement prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g17-f2-recheck-"));
    try {
      const runRecheck = async (trigger: "abort" | "settled") => {
        const seenPrompts: string[] = [];
        let resolveTurn1!: (res: { stopReason: string }) => void;
        const turn1Ready = Promise.withResolvers<void>();
        const cancelStarted = Promise.withResolvers<void>();
        const releaseCancel = Promise.withResolvers<void>();
        const ac = new AbortController();
        let settled = false;

        const testAgent = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: `S-recheck-${trigger}`,
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            cancelStarted.resolve();
            await releaseCancel.promise;
            resolveTurn1?.({ stopReason: "cancelled" });
          })
          .onRequest("session/prompt", async ({ params }) => {
            const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
            seenPrompts.push(text);
            if (seenPrompts.length === 1) {
              turn1Ready.resolve();
              return (await new Promise<{ stopReason: string }>((r) => {
                resolveTurn1 = r;
              })) as never;
            }
            return { stopReason: "end_turn" } as never;
          })
          .onRequest("*", async ({ method }) => {
            if (method === "_amp/session/steer") return { outcome: "queued" } as never;
            throw new Error(`Unexpected method ${method}`);
          });

        let handle: RunnerExecutionHandle | undefined;
        const runner = new AcpRunner(AMP_PROFILE);
        const runPromise = runner.run(
          {
            runId: `r-recheck-${trigger}`,
            taskId: `t-recheck-${trigger}`,
            tier: 2,
            kind: "worker",
            cwd,
            toolPolicy: "read_write_workspace",
            systemPrompt: "Worker",
            initialPrompt: "Initial work",
            model: "anthropic/claude-opus-5-5",
            maxTurns: 10,
            tools: [],
            executeTool: async () => ({}),
            isTaskSettled: () => settled,
            signal: ac.signal,
            onHandle: (h) => {
              handle = h;
            },
            callbacks: {},
          },
          testAgent,
        );

        await turn1Ready.promise;
        assert.ok(handle);
        const steerPromise = handle.steer("STOP: should not send replacement");
        await cancelStarted.promise;
        if (trigger === "abort") ac.abort(new Error("cancelled during handoff"));
        else settled = true;
        releaseCancel.resolve();

        const live = await steerPromise;
        assert.equal(live, false, `steer must return false when ${trigger} fires during session/cancel`);
        assert.equal(seenPrompts.length, 1, `must not send replacement session/prompt after ${trigger} during session/cancel`);
        const res = await runPromise;
        assert.equal(res.stopReason, "cancelled");
      };

      await runRecheck("abort");
      await runRecheck("settled");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Finding 6: emits goal.amendment_task cancelled once on authoritative transition for NULL-bound, live-rebound, and runner-first cancellations", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g17-f6-cancel-");
    const stateDir = join(root, "state");
    const runnerStarted = Promise.withResolvers<void>();
    const runnerFinished = Promise.withResolvers<void>();
    const releaseHandleCancel = Promise.withResolvers<void>();

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        if (req.initialPrompt.includes("RUNNER_FIRST_CANCEL")) {
          const aborted = Promise.withResolvers<void>();
          req.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          req.onHandle?.({
            steer: async () => false,
            cancel: async () => {
              // Delay handle.cancel so the runner loop settles writeFallbackHandoff("cancelled") BEFORE cancelTask resumes.
              await releaseHandleCancel.promise;
            },
          });
          runnerStarted.resolve();
          await aborted.promise;
          return { text: "aborted early", stopReason: "cancelled" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    });

    const cfg = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir });
    const db = new ControlPlaneDb(join(stateDir, "cp.sqlite"));
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(cfg, quota);
    const orch = new HarnessOrchestrator(db, cfg, catalog, quota, runnerFactory);
    const goals = new GoalEngine(db.db);

    try {
      const goal = goals.createGoal({
        repoRoot,
        title: "Goal 17 cancel events",
        description: "Test cancel events",
        criteria: [{ id: "c1", description: "Criterion 1", kind: "behavioral", required: true }],
      });
      const run = db.createRun({ repoRoot, baseBranch: "main", baseSha, goal: goal.title });
      goals.linkRunAndStart(goal.id, run.id);

      const t1 = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "T1",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      // Spawn workers on v1 before amending to v2.
      const nullWorker = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "NULL-bound worker",
        objective: "Migrated worker",
        profileId: "pi:local",
        model: "fixture/fixture",
        goalVersion: null,
      });
      const reboundWorker = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Live-rebound worker",
        objective: "Rebound worker",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const runnerFirstWorker = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 3,
        kind: "research",
        title: "Runner-first worker",
        objective: "RUNNER_FIRST_CANCEL",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      // Amend goal v1 -> v2.
      goals.amendGoal(goal.id, { rationale: "v2 drops worker scope" });

      // Simulate reboundWorker receiving live delivery (version bumped to 2, amendment_task delivered recorded).
      db.updateTask(reboundWorker.id, { goalVersion: 2 });
      db.emitEvent(run.id, reboundWorker.id, "goal.amendment_task", {
        goalId: goal.id,
        fromVersion: 1,
        toVersion: 2,
        taskId: reboundWorker.id,
        tier: 2,
        boundVersion: 1,
        action: "delivered",
        delivered: true,
        mode: "native",
        live: true,
        scopeHit: ["c1"],
      });

      // Spawn an unaffected post-amendment worker on v2 (never had an amendment event).
      const v2Worker = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Unaffected v2 worker",
        objective: "Spawned on v2",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      assert.equal(v2Worker.goalVersion, 2);

      // Unlinked run worker with NULL goalVersion must never emit goal.amendment_task.
      const unlinkedRun = db.createRun({ repoRoot, baseBranch: "main", baseSha, goal: "Unlinked" });
      const unlinkedWorker = db.createTask({
        runId: unlinkedRun.id,
        tier: 2,
        kind: "worker",
        title: "Unlinked worker",
        objective: "No goal",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      assert.equal(unlinkedWorker.goalVersion, null);

      const getCancelEvents = (targetRunId: string, taskId: string) =>
        (
          db.db
            .prepare("SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND type = 'goal.amendment_task' ORDER BY seq ASC")
            .all(targetRunId, taskId) as Array<{ payload_json: string }>
        )
          .map((r) => JSON.parse(r.payload_json) as Record<string, unknown>)
          .filter((p) => p.action === "cancelled");

      // Case A: NULL-bound linked worker cancelled -> exactly 1 cancelled event.
      await orch.cancelTask(nullWorker.id, "drop migrated worker");
      const nullEvents = getCancelEvents(run.id, nullWorker.id);
      assert.equal(nullEvents.length, 1, "NULL-bound linked worker must emit exactly one cancelled event");
      assert.equal(nullEvents[0]!.boundVersion, null);
      assert.equal(nullEvents[0]!.toVersion, 2);
      assert.equal(nullEvents[0]!.reason, "drop migrated worker");

      // Case B: live-rebound worker cancelled by T1 -> exactly 1 cancelled event preserving boundVersion 1.
      await orch.cancelTask(reboundWorker.id, "v2 removed scope");
      const reboundEvents = getCancelEvents(run.id, reboundWorker.id);
      assert.equal(reboundEvents.length, 1, "live-rebound affected worker must emit exactly one cancelled event");
      assert.equal(reboundEvents[0]!.boundVersion, 1);
      assert.equal(reboundEvents[0]!.toVersion, 2);
      assert.equal(reboundEvents[0]!.reason, "v2 removed scope");
      const activityAfterReboundCancel = buildRunActivitySummary(db, run.id);
      const reboundSummary = activityAfterReboundCancel.tasks.find((t) => t.id === reboundWorker.id);
      assert.equal(reboundSummary?.lastAmendmentAction, "cancelled");

      // Case C: runner-first cancellation (writeFallbackHandoff transitions task to cancelled before cancelTask finishes).
      orch.launchTaskLoop(runnerFirstWorker.id);
      await runnerStarted.promise;
      const cancelPromise = orch.cancelTask(runnerFirstWorker.id, "runner settles first");
      // Wait until runner settles task status to cancelled BEFORE releasing handle.cancel!
      await waitUntil(() => db.getTask(runnerFirstWorker.id)?.status === "cancelled", 4000, "runner-first cancelled status");
      releaseHandleCancel.resolve();
      await cancelPromise;
      runnerFinished.resolve();
      const runnerFirstEvents = getCancelEvents(run.id, runnerFirstWorker.id);
      assert.equal(runnerFirstEvents.length, 1, "runner-first cancellation must emit exactly one cancelled event");
      assert.equal(runnerFirstEvents[0]!.boundVersion, 1);
      assert.equal(runnerFirstEvents[0]!.toVersion, 2);
      assert.equal(runnerFirstEvents[0]!.reason, "runner settles first");

      // Case D: unaffected v2 worker and unlinked NULL worker emit 0 cancelled amendment events.
      await orch.cancelTask(v2Worker.id, "not stale");
      assert.equal(getCancelEvents(run.id, v2Worker.id).length, 0, "unaffected v2 worker must not emit amendment cancel event");
      await orch.cancelTask(unlinkedWorker.id, "unlinked");
      assert.equal(getCancelEvents(unlinkedRun.id, unlinkedWorker.id).length, 0, "unlinked worker must not emit amendment cancel event");
    } finally {
      releaseHandleCancel.resolve();
      await orch.shutdownAndWait(1000);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Finding 6: emits goal.amendment_task delivered on actual drain so activity updates from queued to delivered", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g17-f6-drain-");
    const stateDir = join(root, "state");
    const workerStarted = Promise.withResolvers<void>();
    const workerRelease = Promise.withResolvers<void>();

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        req.onHandle?.({
          steer: async () => false,
          cancel: async () => {},
        });
        workerStarted.resolve();
        await workerRelease.promise;
        return { text: "done", stopReason: "completed" };
      },
    });

    const cfg = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir });
    const db = new ControlPlaneDb(join(stateDir, "cp.sqlite"));
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(cfg, quota);
    const orch = new HarnessOrchestrator(db, cfg, catalog, quota, runnerFactory);
    const goals = new GoalEngine(db.db);

    try {
      const goal = goals.createGoal({
        repoRoot,
        title: "Goal 17 drain event",
        description: "Test drain delivery event",
        criteria: [{ id: "c1", description: "Criterion 1", kind: "behavioral", required: true }],
      });
      const run = db.createRun({ repoRoot, baseBranch: "main", baseSha, goal: goal.title });
      goals.linkRunAndStart(goal.id, run.id);

      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Queued worker",
        objective: "Work on v1",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      assert.equal(worker.goalVersion, 1);

      orch.launchTaskLoop(worker.id);
      await workerStarted.promise;

      goals.amendGoal(goal.id, { rationale: "v2 changes criteria" });
      const steerRes = await orch.steerTaskDetailed(worker.id, "[GOAL AMENDED: v1 -> v2] Apply v2.");
      assert.equal(steerRes.steered, true);
      assert.equal(steerRes.live, false);
      orch.setAmendBindOnDrain(worker.id, 2);
      db.emitEvent(run.id, worker.id, "goal.amendment_task", {
        goalId: goal.id,
        fromVersion: 1,
        toVersion: 2,
        taskId: worker.id,
        tier: 2,
        boundVersion: 1,
        action: "queued",
        delivered: false,
        mode: steerRes.mode,
        live: false,
        scopeHit: ["c1"],
      });

      assert.equal(buildRunActivitySummary(db, run.id).tasks.find((t) => t.id === worker.id)?.lastAmendmentAction, "queued");

      // Worker invokes a control-plane tool -> drains queued amendment and rebinds to v2.
      const treeRes = (await orch.toolExecutor.execute(run.id, worker.id, "tree_view", {})) as {
        steeringMessages?: string[];
      };
      assert.equal(treeRes.steeringMessages?.length, 1);
      assert.equal(db.getTask(worker.id)?.goalVersion, 2);

      const amendEvents = (
        db.db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND type = 'goal.amendment_task' ORDER BY seq ASC")
          .all(run.id, worker.id) as Array<{ payload_json: string }>
      ).map((r) => JSON.parse(r.payload_json) as Record<string, unknown>);
      assert.equal(amendEvents.length, 2, "expected queued followed by delivered on drain");
      assert.equal(amendEvents[0]!.action, "queued");
      assert.equal(amendEvents[1]!.action, "delivered");
      assert.equal(amendEvents[1]!.delivered, true);
      assert.equal(amendEvents[1]!.toVersion, 2);
      assert.equal(amendEvents[1]!.boundVersion, 1);
      assert.equal(buildRunActivitySummary(db, run.id).tasks.find((t) => t.id === worker.id)?.lastAmendmentAction, "delivered");
    } finally {
      workerRelease.resolve();
      await orch.shutdownAndWait(1000);
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
