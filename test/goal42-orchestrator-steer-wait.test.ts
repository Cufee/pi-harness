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
    const handleInjectLiveCalls: string[] = [];
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
            injectLive: async (msg) => {
              handleInjectLiveCalls.push(msg);
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
      assert.equal(handleInjectLiveCalls.length, 0, "handle.injectLive must NOT be called while task is inside wait_timer");

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
});
