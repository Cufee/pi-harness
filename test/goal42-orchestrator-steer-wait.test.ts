import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(prefix: string): Promise<{ root: string; repoRoot: string; stateDir: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  const stateDir = join(root, "state");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return { root, repoRoot, stateDir };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.ok(predicate(), `Timed out waiting for ${label}`);
}

describe("goal-42 Slice B: orchestrator delivers steers & goal amendments via blocking waits", () => {
  it("delivers direct steer and goal amendment to a task inside wait_children as steeringMessages without calling handle.steer", async () => {
    const { root, repoRoot, stateDir } = await makeTempRepo("pi-g42-steer-wait-children-");
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: join(stateDir, "d.sock"),
    });

    const handleSteerCalls: string[] = [];
    const handleCancelCalls: string[] = [];
    const waitResults: Array<Record<string, unknown>> = [];
    let orchTaskId = "";
    const enteredWait1 = Promise.withResolvers<void>();
    const enteredWait2 = Promise.withResolvers<void>();
    const releaseChild = Promise.withResolvers<void>();

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.tier === 1) {
            orchTaskId = req.taskId;
            req.onHandle?.({
              steer: async (msg) => {
                handleSteerCalls.push(msg);
                return true;
              },
              cancel: async (reason) => {
                handleCancelCalls.push(reason ?? "");
              },
            });
            // Spawn a child worker that stays live while Tier 1 waits.
            await req.executeTool("spawn_worker", {
              title: "Long worker",
              objective: "Hold wait_children open",
              criteria: "c1",
              write_scopes: ["README.md"],
              model: "fixture/fixture",
            });

            // Wait #1: woken by direct steerTaskDetailed
            const wait1Promise = req.executeTool("wait_children", { timeout_s: 30 }) as Promise<Record<string, unknown>>;
            enteredWait1.resolve();
            waitResults.push(await wait1Promise);

            // Wait #2: woken by DirectorRuntime.amendGoal -> deliverOrQueueLiveSteer
            const wait2Promise = req.executeTool("wait_children", { timeout_s: 30 }) as Promise<Record<string, unknown>>;
            enteredWait2.resolve();
            waitResults.push(await wait2Promise);

            releaseChild.resolve();
            return { text: "orchestrator done", stopReason: "completed" };
          }
          // Tier 2 worker stays alive until released.
          req.onHandle?.({
            steer: async () => false,
            cancel: async () => releaseChild.resolve(),
          });
          await releaseChild.promise;
          await req.executeTool("return_task", {
            status: "completed",
            summary: "child done",
          });
          return { text: "child done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Wait-children steer test",
        description: "Verify steers and amendments flow through wait_children",
        criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      });
      await daemon.director.commitGoal(goal.id);

      await enteredWait1.promise;
      await waitFor(() => daemon.db.getTask(orchTaskId)?.status === "waiting_children", 5_000, "T1 in wait_children #1");

      const directSteer = await daemon.orchestrator.steerTaskDetailed(orchTaskId, "Direct steer during wait_children");
      assert.equal(directSteer.steered, true);
      assert.equal(directSteer.live, true);
      assert.equal(directSteer.mode, "queued_wait");
      assert.equal(handleSteerCalls.length, 0, "handle.steer must NOT be called for direct steer during wait_children");

      await enteredWait2.promise;
      await waitFor(
        () => waitResults.length >= 1 && daemon.db.getTask(orchTaskId)?.status === "waiting_children",
        5_000,
        "T1 in wait_children #2",
      );

      const amendRes = await daemon.director.amendGoal(goal.id, {
        rationale: "Add v2 check during wait_children",
        appendDescription: "v2 requirement during wait_children",
      });
      assert.equal(amendRes.delivery.delivered, true, "goal amendment during wait_children must report delivered");
      assert.equal(handleSteerCalls.length, 0, "handle.steer must NOT be called for goal amendment during wait_children");

      await waitFor(() => waitResults.length === 2, 5_000, "both wait_children calls completed");
      await waitFor(() => daemon.db.getTask(orchTaskId)?.status === "completed", 5_000, "T1 completed");

      assert.equal(handleSteerCalls.length, 0, "handle.steer must NOT be called while task is inside wait_children");
      assert.equal(handleCancelCalls.length, 0);

      assert.equal(waitResults[0]!.wakeReason, "steered");
      assert.deepEqual(waitResults[0]!.steeringMessages, ["Direct steer during wait_children"]);

      assert.equal(waitResults[1]!.wakeReason, "steered");
      const amendMessages = waitResults[1]!.steeringMessages as string[];
      assert.ok(Array.isArray(amendMessages) && amendMessages.length >= 1, "wait_children #2 must carry amendment in steeringMessages");
      assert.ok(
        amendMessages.some((m) => m.includes("v2 requirement during wait_children") || m.includes("Add v2 check during wait_children")),
        `Expected amendment text in steeringMessages, got: ${JSON.stringify(amendMessages)}`,
      );

      const events = daemon.db.getEventsSince(goal.linkedRunId ?? daemon.db.getTask(orchTaskId)!.runId, 0, orchTaskId);
      const orchSteerEvents = events.filter((e) => e.type === "agent.steered");
      assert.ok(orchSteerEvents.length >= 2);
      for (const ev of orchSteerEvents) {
        const p = ev.payload as { mode?: string; live?: boolean; accepted?: boolean };
        assert.equal(p.accepted, true);
        assert.equal(p.mode, "queued_wait");
        assert.equal(p.live, true);
      }
    } finally {
      releaseChild.resolve();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("delivers direct steer and goal amendment to a task inside wait_timer as steeringMessages without calling handle.steer (and preserves prompt cancel)", async () => {
    const { root, repoRoot, stateDir } = await makeTempRepo("pi-g42-steer-wait-timer-");
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: join(stateDir, "d.sock"),
    });

    const handleSteerCalls: string[] = [];
    const handleCancelCalls: string[] = [];
    const waitResults: Array<Record<string, unknown>> = [];
    let orchTaskId = "";
    const enteredTimer1 = Promise.withResolvers<void>();
    const enteredTimer2 = Promise.withResolvers<void>();
    const enteredTimer3 = Promise.withResolvers<void>();
    const cancelledWait3 = Promise.withResolvers<void>();

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          orchTaskId = req.taskId;
          req.onHandle?.({
            steer: async (msg) => {
              handleSteerCalls.push(msg);
              return true;
            },
            turnOpen: () => true,
            cancel: async (reason) => {
              handleCancelCalls.push(reason ?? "");
              cancelledWait3.resolve();
            },
          });

          // Timer #1: woken by direct steerTaskDetailed
          const t1Promise = req.executeTool("wait_timer", { delay_seconds: 30, reason: "lease backoff #1" }) as Promise<
            Record<string, unknown>
          >;
          enteredTimer1.resolve();
          waitResults.push(await t1Promise);

          // Timer #2: woken by DirectorRuntime.amendGoal -> deliverOrQueueLiveSteer
          const t2Promise = req.executeTool("wait_timer", { delay_seconds: 30, reason: "lease backoff #2" }) as Promise<
            Record<string, unknown>
          >;
          enteredTimer2.resolve();
          waitResults.push(await t2Promise);

          // Timer #3: interrupted promptly by explicit cancelTask
          const t3Promise = req.executeTool("wait_timer", { delay_seconds: 30, reason: "lease backoff #3" });
          enteredTimer3.resolve();
          await Promise.race([t3Promise.catch(() => {}), cancelledWait3.promise]);
          return { text: "cancelled during wait_timer", stopReason: "cancelled" };
        },
      }),
    });

    await daemon.start();
    try {
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Wait-timer steer test",
        description: "Verify steers and amendments flow through wait_timer",
        criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      });
      await daemon.director.commitGoal(goal.id);

      await enteredTimer1.promise;
      await waitFor(() => daemon.db.timers.isTaskWaitingTimer(orchTaskId), 5_000, "T1 in wait_timer #1");

      const directSteer = await daemon.orchestrator.steerTaskDetailed(orchTaskId, "Direct steer during wait_timer");
      assert.equal(directSteer.steered, true);
      assert.equal(directSteer.live, true);
      assert.equal(directSteer.mode, "queued_wait");

      await enteredTimer2.promise;
      await waitFor(
        () => waitResults.length >= 1 && daemon.db.timers.isTaskWaitingTimer(orchTaskId),
        5_000,
        "T1 in wait_timer #2",
      );

      const amendRes = await daemon.director.amendGoal(goal.id, {
        rationale: "Add v2 check during wait_timer",
        appendDescription: "v2 requirement during wait_timer",
      });
      assert.equal(amendRes.delivery.delivered, true, "goal amendment during wait_timer must report delivered");

      await enteredTimer3.promise;
      await waitFor(
        () => waitResults.length >= 2 && daemon.db.timers.isTaskWaitingTimer(orchTaskId),
        5_000,
        "T1 in wait_timer #3",
      );

      assert.equal(handleSteerCalls.length, 0, "handle.steer must NOT be called while task is inside wait_timer");

      assert.equal(waitResults[0]!.wakeReason, "steered");
      assert.deepEqual(waitResults[0]!.steeringMessages, ["Direct steer during wait_timer"]);

      assert.equal(waitResults[1]!.wakeReason, "steered");
      const amendMessages = waitResults[1]!.steeringMessages as string[];
      assert.ok(Array.isArray(amendMessages) && amendMessages.length >= 1, "wait_timer #2 must carry amendment in steeringMessages");
      assert.ok(
        amendMessages.some((m) => m.includes("v2 requirement during wait_timer") || m.includes("Add v2 check during wait_timer")),
        `Expected amendment text in steeringMessages, got: ${JSON.stringify(amendMessages)}`,
      );

      const events = daemon.db.getEventsSince(daemon.db.getTask(orchTaskId)!.runId, 0, orchTaskId);
      const orchSteerEvents = events.filter((e) => e.type === "agent.steered");
      assert.ok(orchSteerEvents.length >= 2);
      for (const ev of orchSteerEvents) {
        const p = ev.payload as { mode?: string; live?: boolean; accepted?: boolean };
        assert.equal(p.accepted, true);
        assert.equal(p.mode, "queued_wait");
        assert.equal(p.live, true);
      }

      // Control: explicit user cancel must still invoke handle.cancel promptly and never queue.
      await daemon.orchestrator.cancelTask(orchTaskId, "User requested stop");
      assert.equal(handleCancelCalls.length, 1, "explicit cancelTask must still call handle.cancel promptly");
      assert.equal(handleCancelCalls[0], "User requested stop");
      assert.equal(daemon.db.getTask(orchTaskId)?.status, "cancelled");
    } finally {
      cancelledWait3.resolve();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P1-1: routes a steer queued behind a blocked native steer to wait_timer without calling handle.steer (steerTaskDetailed and deliverOrQueueLiveSteer)", async () => {
    const { root, repoRoot, stateDir } = await makeTempRepo("pi-g42-steer-chain-race-");
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: join(stateDir, "d.sock"),
    });

    const handleSteerCalls: string[] = [];
    const waitResults: Array<Record<string, unknown>> = [];
    let orchTaskId = "";
    const handleReady = Promise.withResolvers<void>();
    const steer1Started = Promise.withResolvers<void>();
    const releaseSteer1 = Promise.withResolvers<boolean>();
    const allowEnterTimer1 = Promise.withResolvers<void>();
    const enteredTimer1 = Promise.withResolvers<void>();

    const steer3Started = Promise.withResolvers<void>();
    const releaseSteer3 = Promise.withResolvers<boolean>();
    const allowEnterTimer2 = Promise.withResolvers<void>();
    const enteredTimer2 = Promise.withResolvers<void>();

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          orchTaskId = req.taskId;
          req.onHandle?.({
            steer: async (msg) => {
              handleSteerCalls.push(msg);
              if (msg === "steer-1-blocking") {
                steer1Started.resolve();
                return await releaseSteer1.promise;
              }
              if (msg === "deliver-1-blocking") {
                steer3Started.resolve();
                return await releaseSteer3.promise;
              }
              return true;
            },
            cancel: async () => {},
          });
          handleReady.resolve();

          await allowEnterTimer1.promise;
          const t1 = req.executeTool("wait_timer", { delay_seconds: 30, reason: "race timer 1" }) as Promise<
            Record<string, unknown>
          >;
          enteredTimer1.resolve();
          waitResults.push(await t1);

          await allowEnterTimer2.promise;
          const t2 = req.executeTool("wait_timer", { delay_seconds: 30, reason: "race timer 2" }) as Promise<
            Record<string, unknown>
          >;
          enteredTimer2.resolve();
          waitResults.push(await t2);

          return { text: "done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Steer chain wait_timer race",
        description: "Verify serialized steer step checks blocking wait before calling handle.steer",
        criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      });
      await daemon.director.commitGoal(goal.id);
      await handleReady.promise;

      // Part A: steerTaskDetailed race
      const p1 = daemon.orchestrator.steerTaskDetailed(orchTaskId, "steer-1-blocking");
      await steer1Started.promise;
      const p2 = daemon.orchestrator.steerTaskDetailed(orchTaskId, "steer-2-queued-behind-1");
      // Let steer-2 queue on exec.steerChain while the task is NOT yet in wait_timer.
      await Bun.sleep(15);

      allowEnterTimer1.resolve();
      await enteredTimer1.promise;
      await waitFor(() => daemon.db.timers.isTaskWaitingTimer(orchTaskId), 5_000, "T1 in race timer 1");

      // Release steer-1; steer-2 must now observe isTaskInBlockingWait inside the serialized step.
      releaseSteer1.resolve(true);
      const [r1, r2] = await Promise.all([p1, p2]);

      assert.equal(r1.mode, "native");
      assert.equal(r2.steered, true);
      assert.equal(r2.live, true);
      assert.equal(r2.mode, "queued_wait", `Expected steer-2 to route via queued_wait, got ${r2.mode}`);
      await waitFor(() => waitResults.length >= 1, 2_000, "race timer 1 woken by steer-2");
      assert.equal(waitResults[0]!.wakeReason, "steered");
      assert.deepEqual(waitResults[0]!.steeringMessages, ["steer-2-queued-behind-1"]);
      assert.deepEqual(handleSteerCalls, ["steer-1-blocking"], "steer-2 must NOT call handle.steer once task entered wait_timer");

      // Part B: deliverOrQueueLiveSteer race
      const d1 = daemon.orchestrator.deliverOrQueueLiveSteer(orchTaskId, "deliver-1-blocking");
      await steer3Started.promise;
      const d2 = daemon.orchestrator.deliverOrQueueLiveSteer(orchTaskId, "deliver-2-queued-behind-1");
      await Bun.sleep(15);

      allowEnterTimer2.resolve();
      await enteredTimer2.promise;
      await waitFor(() => daemon.db.timers.isTaskWaitingTimer(orchTaskId), 5_000, "T1 in race timer 2");

      releaseSteer3.resolve(true);
      const [dr1, dr2] = await Promise.all([d1, d2]);

      assert.equal(dr1.delivered, true);
      assert.equal(dr1.mode, "steer");
      assert.equal(dr2.delivered, true);
      assert.equal(dr2.mode, "queued_wait", `Expected deliver-2 to route via queued_wait, got ${dr2.mode}`);
      await waitFor(() => waitResults.length >= 2, 2_000, "race timer 2 woken by deliver-2");
      assert.equal(waitResults[1]!.wakeReason, "steered");
      assert.deepEqual(waitResults[1]!.steeringMessages, ["deliver-2-queued-behind-1"]);
      assert.deepEqual(
        handleSteerCalls,
        ["steer-1-blocking", "deliver-1-blocking"],
        "deliver-2 must NOT call handle.steer once task entered wait_timer",
      );

      await waitFor(() => daemon.db.getTask(orchTaskId)?.status === "completed", 5_000, "T1 completed");
    } finally {
      releaseSteer1.resolve(false);
      releaseSteer3.resolve(false);
      allowEnterTimer1.resolve();
      allowEnterTimer2.resolve();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P1-1: routes pre-handle drained steers to wait_timer when task enters wait_timer while draining", async () => {
    const { root, repoRoot, stateDir } = await makeTempRepo("pi-g42-prehandle-drain-race-");
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: join(stateDir, "d.sock"),
    });

    const handleSteerCalls: string[] = [];
    const outcomes: Array<{ label: string; accepted: boolean; reason: string }> = [];
    let waitResult: Record<string, unknown> | null = null;
    let orchTaskId = "";
    const runnerEntered = Promise.withResolvers<void>();
    const allowOnHandle = Promise.withResolvers<void>();
    const pre1Started = Promise.withResolvers<void>();
    const releasePre1 = Promise.withResolvers<boolean>();
    const enteredTimer = Promise.withResolvers<void>();

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          orchTaskId = req.taskId;
          runnerEntered.resolve();
          await allowOnHandle.promise;
          req.onHandle?.({
            steer: async (msg) => {
              handleSteerCalls.push(msg);
              if (msg === "pre-1-blocking") {
                pre1Started.resolve();
                return await releasePre1.promise;
              }
              return true;
            },
            cancel: async () => {},
          });
          await pre1Started.promise;
          const t = req.executeTool("wait_timer", { delay_seconds: 30, reason: "pre-handle drain timer" }) as Promise<
            Record<string, unknown>
          >;
          enteredTimer.resolve();
          waitResult = await t;
          return { text: "done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Pre-handle drain race",
        description: "Verify pre-handle drain checks blocking wait inside serialized chain",
        criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      });
      await daemon.director.commitGoal(goal.id);
      await runnerEntered.promise;

      const q1 = await daemon.orchestrator.deliverOrQueueLiveSteer(orchTaskId, "pre-1-blocking", {
        onOutcome: (accepted, reason) => outcomes.push({ label: "pre-1", accepted, reason }),
      });
      const q2 = await daemon.orchestrator.deliverOrQueueLiveSteer(orchTaskId, "pre-2-for-wait", {
        onOutcome: (accepted, reason) => outcomes.push({ label: "pre-2", accepted, reason }),
      });
      assert.equal(q1.mode, "queued_before_handle");
      assert.equal(q2.mode, "queued_before_handle");

      allowOnHandle.resolve();
      await enteredTimer.promise;
      await waitFor(() => daemon.db.timers.isTaskWaitingTimer(orchTaskId), 5_000, "T1 in pre-handle drain timer");

      releasePre1.resolve(true);
      await waitFor(() => waitResult !== null, 2_000, "pre-handle drain timer woken by pre-2");
      await waitFor(() => daemon.db.getTask(orchTaskId)?.status === "completed", 5_000, "T1 completed");

      assert.deepEqual(handleSteerCalls, ["pre-1-blocking"], "pre-2 must NOT call handle.steer once task entered wait_timer");
      assert.equal(waitResult!.wakeReason, "steered");
      assert.deepEqual(waitResult!.steeringMessages, ["pre-2-for-wait"]);
      assert.ok(
        outcomes.some((o) => o.label === "pre-2" && o.accepted === true),
        `Expected pre-2 onOutcome accepted=true, got ${JSON.stringify(outcomes)}`,
      );
    } finally {
      allowOnHandle.resolve();
      releasePre1.resolve(false);
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P1-1: late native steer ack does NOT wake wait_children; only a wait-routed steer wakes it", async () => {
    const { root, repoRoot, stateDir } = await makeTempRepo("pi-g42-late-native-ack-");
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: join(stateDir, "d.sock"),
    });

    const handleSteerCalls: string[] = [];
    let orchTaskId = "";
    let waitResult: Record<string, unknown> | null = null;
    const childSpawned = Promise.withResolvers<void>();
    const nativeSteerStarted = Promise.withResolvers<void>();
    const releaseNativeSteer = Promise.withResolvers<boolean>();
    const allowEnterWait = Promise.withResolvers<void>();
    const enteredWait = Promise.withResolvers<void>();
    const releaseChild = Promise.withResolvers<void>();

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.tier === 1) {
            orchTaskId = req.taskId;
            req.onHandle?.({
              steer: async (msg) => {
                handleSteerCalls.push(msg);
                if (msg === "late-native-steer") {
                  nativeSteerStarted.resolve();
                  return await releaseNativeSteer.promise;
                }
                return true;
              },
              cancel: async () => {},
            });
            await req.executeTool("spawn_worker", {
              title: "Holding worker",
              objective: "Keep wait_children open",
              criteria: "c1",
              write_scopes: ["README.md"],
              model: "fixture/fixture",
            });
            childSpawned.resolve();

            await allowEnterWait.promise;
            const wp = req.executeTool("wait_children", { timeout_s: 30 }) as Promise<Record<string, unknown>>;
            enteredWait.resolve();
            waitResult = await wp;
            releaseChild.resolve();
            return { text: "done", stopReason: "completed" };
          }
          req.onHandle?.({
            steer: async () => false,
            cancel: async () => releaseChild.resolve(),
          });
          await releaseChild.promise;
          await req.executeTool("return_task", { status: "completed", summary: "child done" });
          return { text: "child done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Late native ack does not wake wait_children",
        description: "Verify wait_children ignores late native agent.steered ack",
        criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      });
      await daemon.director.commitGoal(goal.id);
      await childSpawned.promise;

      const lateNativePromise = daemon.orchestrator.steerTaskDetailed(orchTaskId, "late-native-steer");
      await nativeSteerStarted.promise;

      allowEnterWait.resolve();
      await enteredWait.promise;
      await waitFor(() => daemon.db.getTask(orchTaskId)?.status === "waiting_children", 5_000, "T1 in wait_children");

      // Resolve the earlier native steer after T1 has already entered wait_children.
      releaseNativeSteer.resolve(true);
      const lateRes = await lateNativePromise;
      assert.equal(lateRes.mode, "native");

      // Give any accidental event listener a chance to run; wait_children must stay asleep.
      await Bun.sleep(60);
      assert.equal(waitResult, null, "Late native steer ack must NOT wake wait_children");
      assert.equal(daemon.db.getTask(orchTaskId)?.status, "waiting_children");

      // Now send a genuine wait-routed steer; this one MUST wake wait_children with steeringMessages.
      const waitSteer = await daemon.orchestrator.steerTaskDetailed(orchTaskId, "genuine-wait-steer");
      assert.equal(waitSteer.mode, "queued_wait");
      await waitFor(() => waitResult !== null, 2_000, "wait_children woken by queued_wait steer");
      assert.equal(waitResult!.wakeReason, "steered");
      assert.deepEqual(waitResult!.steeringMessages, ["genuine-wait-steer"]);
      assert.deepEqual(handleSteerCalls, ["late-native-steer"]);

      await waitFor(() => daemon.db.getTask(orchTaskId)?.status === "completed", 5_000, "T1 completed");
    } finally {
      releaseNativeSteer.resolve(false);
      allowEnterWait.resolve();
      releaseChild.resolve();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
