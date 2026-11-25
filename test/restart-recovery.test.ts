import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { listChildProcessGroups, reapChildProcessGroups } from "../src/daemon/reap.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { RunAgentRequest, RunAgentResult } from "../src/runners/types.js";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-restart-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTestConfig(repoDir: string, stateDir: string) {
  mkdirSync(stateDir, { recursive: true });
  const cfg = loadConfig(repoDir);
  cfg.stateDir = stateDir;
  cfg.socketPath = join(stateDir, "d.sock");
  cfg.quotaEndpoint = undefined;
  cfg.catalog = { ttlHours: 24 };
  cfg.worktree = { archiveRetentionDays: 7, maxConcurrentWorkers: 4 };
  cfg.codeMode = "off";
  cfg.profiles = [
    { id: "pi:local", kind: "pi", provider: "fixture", billing: "local", models: ["fixture"] },
  ];
  cfg.defaultOrchestratorProfile = "pi:local";
  cfg.defaultWorkerProfile = "pi:local";
  cfg.defaultTaskProfile = "pi:local";
  const compiler = new ModelCatalogCompiler(cfg);
  const catalog = compiler.compileFromData({
    enabledProfiles: cfg.profiles,
    inventory: new Map([["pi:local", [{ wireModelId: "fixture" }]]]),
    profileStatuses: [{ profileId: "pi:local", status: "ok", modelCount: 1 }],
    modelsDev: [],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [],
    sources: [],
  });
  writeFileSync(compiler.cachePath, JSON.stringify(catalog));
  return cfg;
}

async function waitUntil(pred: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("restart-recovery", () => {
  it("relaunches interrupted tasks in place", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfgA = makeTestConfig(repoDir, stateDir);

    let orchId = "";
    let childT3Id = "";
    let workerId = "";
    let readyTaskId = "";
    let readyWithHandoffId = "";
    let pendingTaskId = "";
    let drainRunId = "";
    let drainOrchId = "";
    let workerRunning = false;
    let childT3Running = false;

    const runnerA: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (req.tier === 1) {
          orchId = req.taskId;
          const t3 = (await req.executeTool("spawn_task", {
            kind: "research",
            title: "Active scout",
            objective: "Scout running during restart",
            profile_id: "pi:local",
            model: "fixture",
          })) as { spawned: string };
          childT3Id = t3.spawned;

          const w = (await req.executeTool("spawn_worker", {
            title: "Leased worker",
            objective: "Worker with active write leases",
            write_scopes: ["src/leased/**"],
            profile_id: "pi:local",
            model: "fixture",
          })) as { spawned: string };
          workerId = w.spawned;

          const dep = (await req.executeTool("spawn_task", {
            kind: "research",
            title: "Dependent scout",
            objective: "Waits for Leased worker",
            depends_on: [workerId],
            profile_id: "pi:local",
            model: "fixture",
          })) as { spawned: string };
          pendingTaskId = dep.spawned;

          await req.executeTool("wait_children", { ids: [childT3Id, workerId], mode: "all", fallback_interval_s: 60 });
          await waitForAbort(req.signal);
          return { text: "interrupted", stopReason: "cancelled" };
        }
        if (req.taskId === childT3Id) {
          childT3Running = true;
          await waitForAbort(req.signal);
          return { text: "interrupted", stopReason: "cancelled" };
        }
        if (req.taskId === workerId) {
          workerRunning = true;
          await waitForAbort(req.signal);
          return { text: "interrupted", stopReason: "cancelled" };
        }
        await waitForAbort(req.signal);
        return { text: "interrupted", stopReason: "cancelled" };
      },
    });

    const a = new HarnessDaemon(cfgA, { dbPath, customRunnerFactory: runnerA });
    await a.start();
    let runId = "";
    let statusesBeforeStop = new Map<string, string>();
    let gensBeforeStop = new Map<string, number>();
    let taskIdsBeforeStop: string[] = [];

    try {
      const started = await a.orchestrator.startRun({
        goal: "In-place restart recovery",
        repoRoot: repoDir,
        profileId: "pi:local",
        model: "fixture",
      });
      runId = started.run.id;

      await waitUntil(
        () =>
          Boolean(orchId && childT3Id && workerId && pendingTaskId) &&
          workerRunning &&
          childT3Running &&
          a.db.getTask(orchId)?.status === "waiting_children",
      );

      // Insert an unlaunched `ready` task and a `ready` sibling with a drain-steered handoff (X2 check).
      const readyRec = a.db.createTask({
        runId,
        parentId: orchId,
        tier: 3,
        kind: "research",
        title: "Unlaunched ready scout",
        objective: "Never started before stop",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture",
      });
      readyTaskId = readyRec.id;

      const readyHandoffRec = a.db.createTask({
        runId,
        parentId: orchId,
        tier: 3,
        kind: "research",
        title: "Held ready scout with handoff",
        objective: "Must wait for phase B sanitize instead of early launch",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture",
      });
      readyWithHandoffId = readyHandoffRec.id;
      a.db.updateTask(readyWithHandoffId, {
        handoffJson: JSON.stringify({
          goalInvariants: [],
          architecturalDecisions: [],
          activeRisks: [],
          nextActions: [
            "Steered update: [harness:daemon-restart] call request_rollover now",
            "Keep real next action",
          ],
        }),
      });

      const beforeTasks = a.db.listTasks(runId);
      taskIdsBeforeStop = beforeTasks.map((t) => t.id).sort();
      statusesBeforeStop = new Map(beforeTasks.map((t) => [t.id, t.status]));
      gensBeforeStop = new Map(beforeTasks.map((t) => [t.id, t.generation]));

      assert.equal(statusesBeforeStop.get(orchId), "waiting_children");
      assert.equal(statusesBeforeStop.get(childT3Id), "running");
      assert.equal(statusesBeforeStop.get(workerId), "running");
      assert.equal(statusesBeforeStop.get(readyTaskId), "ready");
      assert.equal(statusesBeforeStop.get(readyWithHandoffId), "ready");
      assert.equal(statusesBeforeStop.get(pendingTaskId), "pending");

      // N2 regression (A13): a run whose only unsettled task is a `ready` Tier 1 with a handoff stays `active`
      // when getEffectiveRun is read during quiesce.
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
      const drainRun = a.db.createRun({ goal: "Drain N2 run", repoRoot: repoDir, baseBranch: "main", baseSha });
      drainRunId = drainRun.id;
      const drainOrch = a.db.createTask({
        runId: drainRunId,
        tier: 1,
        kind: "orchestrator",
        title: "Drained T1",
        objective: "Handed off during drain",
        profileId: "pi:local",
        model: "fixture",
      });
      drainOrchId = drainOrch.id;
      a.db.updateTask(drainOrchId, {
        handoffJson: JSON.stringify({
          goalInvariants: [],
          architecturalDecisions: [],
          activeRisks: [],
          nextActions: ["Resume after drain"],
        }),
      });
      a.enterQuiesce("draining");
      a.orchestrator.launchTaskLoop(drainOrchId);
      assert.equal(a.orchestrator.getEffectiveRun(drainRunId)?.status, "active");

      await a.stop();
    } finally {
      await a.stop().catch(() => {});
    }

    const runCountsB = new Map<string, number>();
    const promptsB = new Map<string, string>();
    const runnerB: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        runCountsB.set(req.taskId, (runCountsB.get(req.taskId) ?? 0) + 1);
        promptsB.set(req.taskId, req.initialPrompt);
        // X2 check: finish childT3Id cleanly during phase B stagger so afterTaskInactiveInRun fires while
        // held ready siblings have not yet been launched by phase B.
        if (req.taskId === childT3Id) {
          await req.executeTool("return_task", {
            status: "completed",
            summary: "quick finish",
            sources: [{ path: "README.md", note: "verified" }],
          });
          return { text: "quick finish", stopReason: "completed" };
        }
        await waitForAbort(req.signal);
        return { text: "stopped", stopReason: "cancelled" };
      },
    });

    const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: runnerB,
      recoveryStaggerMs: 25,
    });
    try {
      // Verify a.stop() did not rewrite any task status in SQLite and kept drainRunId active (A13).
      for (const [id, status] of statusesBeforeStop) {
        assert.equal(b.db.getTask(id)?.status, status, `Task ${id} status must be unchanged after stop`);
      }
      assert.equal(b.db.getRun(drainRunId)?.status, "active", "Drain N2 run must stay active after stop");

      await b.start();
      // Between phase A and phase B completion, getEffectiveRun must stay active.
      assert.equal(b.orchestrator.getEffectiveRun(runId)?.status, "active");
      await b.recovered;
      await waitUntil(
        () =>
          runCountsB.get(orchId) === 1 &&
          runCountsB.get(childT3Id) === 1 &&
          runCountsB.get(workerId) === 1 &&
          runCountsB.get(readyTaskId) === 1 &&
          runCountsB.get(readyWithHandoffId) === 1 &&
          runCountsB.get(drainOrchId) === 1,
      );

      const afterTasks = b.db.listTasks(runId);
      assert.deepEqual(
        afterTasks.map((t) => t.id).sort(),
        taskIdsBeforeStop,
        "Task ID set must be unchanged",
      );

      const statusEvents = b.db.db
        .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'task.status'")
        .all(runId) as Array<{ payload_json: string }>;
      for (const ev of statusEvents) {
        const p = JSON.parse(ev.payload_json) as { to?: string };
        assert.ok(p.to !== "failed" && p.to !== "cancelled", `Unexpected failed/cancelled task.status event: ${ev.payload_json}`);
      }

      for (const [id, gen] of gensBeforeStop) {
        assert.equal(b.db.getTask(id)?.generation, gen, `Task ${id} generation must be unchanged`);
      }

      assert.deepEqual(b.db.listActiveWriteScopes(runId, workerId), ["src/leased/**"], "Worker leases must stay active");
      assert.equal(runCountsB.get(orchId), 1);
      assert.equal(runCountsB.get(childT3Id), 1);
      assert.equal(runCountsB.get(workerId), 1);
      assert.equal(runCountsB.get(readyTaskId), 1);
      assert.equal(runCountsB.get(readyWithHandoffId), 1);
      assert.equal(runCountsB.get(pendingTaskId) ?? 0, 0);
      assert.equal(b.db.getTask(pendingTaskId)?.status, "pending");

      const orchPrompt = promptsB.get(orchId) ?? "";
      assert.ok(orchPrompt.includes(childT3Id), "Orchestrator prompt must contain child ID");
      assert.ok(orchPrompt.includes("tree_view"), "Orchestrator prompt must mention tree_view");

      // X2 check: held ready sibling ran once through phase B with sanitized handoff (never launched early by afterTaskInactiveInRun).
      const readyHandoffPrompt = promptsB.get(readyWithHandoffId) ?? "";
      assert.ok(
        !readyHandoffPrompt.includes("[harness:daemon-restart]"),
        "Held ready sibling prompt must strip drain steer marker",
      );
      assert.ok(readyHandoffPrompt.includes("Keep real next action"));
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("wait_timer and schedule_timer rows survive a stop", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfg = makeTestConfig(repoDir, stateDir);

    let waitTimerId = "";
    let schedTimerId = "";
    let runId = "";
    let taskId = "";
    let waitingNow = false;

    const runnerA: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        runId = req.runId;
        taskId = req.taskId;
        const sched = (await req.executeTool("schedule_timer", {
          delay_seconds: 0.6,
          reason: "scheduled check",
        })) as { timer: { id: string } };
        schedTimerId = sched.timer.id;
        waitingNow = true;
        const waited = (await req.executeTool("wait_timer", {
          delay_seconds: 0.6,
          reason: "blocking wait",
        })) as { timerId: string; wakeReason: string };
        waitTimerId = waited.timerId;
        await waitForAbort(req.signal);
        return { text: "stopped", stopReason: "cancelled" };
      },
    });

    const a = new HarnessDaemon(cfg, { dbPath, customRunnerFactory: runnerA });
    await a.start();
    try {
      await a.orchestrator.startRun({
        goal: "Timer survival test",
        repoRoot: repoDir,
        profileId: "pi:local",
        model: "fixture",
      });
      await waitUntil(() => waitingNow && a.db.timers.list({ status: "pending" }).length === 2);
      const pendingBefore = a.db.timers.list({ status: "pending" });
      assert.equal(pendingBefore.length, 2);
      const wtRow = pendingBefore.find((t) => t.id !== schedTimerId)!;
      waitTimerId = wtRow.id;

      await a.stop();

      let relaunchPrompt = "";
      const steeredMessages: string[] = [];
      const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
        dbPath,
        customRunnerFactory: () => ({
          run: async (req) => {
            relaunchPrompt = req.initialPrompt;
            req.onHandle?.({
              steer: async (msg) => {
                steeredMessages.push(msg);
                return true;
              },
              cancel: async () => {},
            });
            await waitForAbort(req.signal);
            return { text: "", stopReason: "cancelled" };
          },
        }),
      });
      // Before starting B (and firing timers), verify both rows survived A's stop as pending.
      assert.equal(b.db.timers.get(waitTimerId)?.status, "pending", "wait_timer row must stay pending after stop");
      assert.equal(b.db.timers.get(schedTimerId)?.status, "pending", "schedule_timer row must stay pending after stop");
      await b.start();
      await b.recovered;
      try {
        await waitUntil(
          () => b.db.timers.get(waitTimerId)?.status === "fired" && b.db.timers.get(schedTimerId)?.status === "fired",
          4000,
        );
        await waitUntil(() => relaunchPrompt.length > 0);
        // Wait for the asynchronous steer acknowledgments to be recorded before querying events.
        const getAcceptedSteers = () => {
          const rows = b.db.db
            .prepare("SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND type = 'agent.steered'")
            .all(runId, taskId) as Array<{ payload_json: string }>;
          return rows
            .map((e) => JSON.parse(e.payload_json) as { accepted?: boolean; message?: string })
            .filter((p) => p.accepted === true && typeof p.message === "string");
        };
        await waitUntil(() => {
          const acceptedNow = getAcceptedSteers();
          return (
            steeredMessages.length >= 2 &&
            acceptedNow.some((p) => p.message!.includes(waitTimerId)) &&
            acceptedNow.some((p) => p.message!.includes(schedTimerId))
          );
        }, 4000);

        assert.ok(relaunchPrompt.includes(waitTimerId), `Relaunch prompt must name wait_timer ${waitTimerId}`);
        assert.ok(relaunchPrompt.includes(schedTimerId), `Relaunch prompt must name schedule_timer ${schedTimerId}`);

        const accepted = getAcceptedSteers();
        assert.equal(
          accepted.filter((p) => p.message!.includes(waitTimerId)).length,
          1,
          "Expected exactly one accepted steer for wait_timer",
        );
        assert.equal(
          accepted.filter((p) => p.message!.includes(schedTimerId)).length,
          1,
          "Expected exactly one accepted steer for schedule_timer",
        );
      } finally {
        await b.stop();
      }
    } finally {
      await a.stop().catch(() => {});
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("only active runs are recovered", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");

    const a = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async () => ({ text: "ok", stopReason: "completed" }),
      }),
    });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const stoppedRun = a.db.createRun({ goal: "Stopped run", repoRoot: repoDir, baseBranch: "main", baseSha });
    const stoppedTask = a.db.createTask({
      runId: stoppedRun.id,
      tier: 1,
      kind: "orchestrator",
      title: "Stopped running task",
      objective: "Should fail via legacy rule",
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateTask(stoppedTask.id, { status: "running" });
    a.db.updateRunStatus(stoppedRun.id, "stopped");

    const completedRun = a.db.createRun({ goal: "Completed run", repoRoot: repoDir, baseBranch: "main", baseSha });
    const completedTask = a.db.createTask({
      runId: completedRun.id,
      tier: 1,
      kind: "orchestrator",
      title: "Finished orch",
      objective: "Done",
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateTask(completedTask.id, { status: "completed", summary: "Done" });
    const orphanReady = a.db.createTask({
      runId: completedRun.id,
      parentId: completedTask.id,
      tier: 3,
      kind: "research",
      title: "Orphan ready child",
      objective: "Should fail via legacy rule",
      readOnly: true,
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateRunStatus(completedRun.id, "completed");
    await a.stop();

    const ranInB: string[] = [];
    const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          ranInB.push(req.taskId);
          return { text: "should not run", stopReason: "completed" };
        },
      }),
    });
    try {
      await b.start();
      await b.recovered;

      const tStopped = b.db.getTask(stoppedTask.id)!;
      const tOrphan = b.db.getTask(orphanReady.id)!;
      assert.equal(tStopped.status, "failed");
      assert.ok(tStopped.summary?.includes("Interrupted by daemon restart"));
      assert.equal(tOrphan.status, "failed");
      assert.ok(tOrphan.summary?.includes("Interrupted by daemon restart"));
      assert.deepEqual(ranInB, []);
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("missing worktree is recreated and a merged worktree survives the sweep", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");

    const a = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const run = a.db.createRun({ goal: "Worktree recovery", repoRoot: repoDir, baseBranch: "main", baseSha });
    const orch = a.db.createTask({
      runId: run.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch",
      objective: "Coordinate",
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateTask(orch.id, { status: "completed", summary: "Done" });

    const missingWtWorker = a.db.createTask({
      runId: run.id,
      parentId: orch.id,
      tier: 2,
      kind: "worker",
      title: "Worker with missing checkout",
      objective: "Continue after worktree recreated",
      readOnly: false,
      profileId: "pi:local",
      model: "fixture",
      writeScopes: ["src/missing/**"],
    });
    const mgrA = a.orchestrator.getWorktreeManager(repoDir);
    const createdMissingWt = await mgrA.createForWorker(run.id, missingWtWorker.id);
    a.db.updateTask(missingWtWorker.id, { status: "running" });

    const mergedWtWorker = a.db.createTask({
      runId: run.id,
      parentId: orch.id,
      tier: 2,
      kind: "worker",
      title: "Ready worker with merged worktree",
      objective: "Return after merge",
      readOnly: false,
      profileId: "pi:local",
      model: "fixture",
      writeScopes: ["src/merged/**"],
    });
    const createdMergedWt = await mgrA.createForWorker(run.id, mergedWtWorker.id);
    a.db.updateWorktree(createdMergedWt.id, { status: "merged" });
    // Keep mergedWtWorker in `ready` status.
    assert.equal(a.db.getTask(mergedWtWorker.id)?.status, "ready");

    // Verify sweep keeps the merged worktree while its task is `ready`.
    await mgrA.sweep();
    assert.ok(existsSync(createdMergedWt.path), "Merged worktree of ready task must survive sweep");

    await a.stop();

    // Delete the first worker's checkout directory while the daemon is down.
    rmSync(createdMissingWt.path, { recursive: true, force: true });
    assert.equal(existsSync(createdMissingWt.path), false);

    let recreatedCwd = "";
    let recreatedPrompt = "";
    const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId === missingWtWorker.id) {
            recreatedCwd = req.cwd;
            recreatedPrompt = req.initialPrompt;
          }
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    try {
      await b.start();
      await b.recovered;
      await waitUntil(() => recreatedCwd.length > 0);

      assert.ok(existsSync(recreatedCwd), `Recreated worktree cwd must exist: ${recreatedCwd}`);
      assert.ok(
        recreatedPrompt.includes("archived before the daemon restart"),
        `Prompt must contain archive note, got: ${recreatedPrompt}`,
      );
      assert.notEqual(b.db.getTask(missingWtWorker.id)?.status, "failed");

      // Also verify sweep on daemon B keeps the merged worktree while its task is active/ready.
      await b.orchestrator.getWorktreeManager(repoDir).sweep();
      assert.ok(existsSync(createdMergedWt.path), "Merged worktree must still exist after sweep");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("stale bridge token is refused", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");

    const a = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    const nonceA = a.instanceNonce;
    await a.start();
    let runId = "";
    let taskId = "";
    try {
      const started = await a.orchestrator.startRun({
        goal: "Bridge token nonce check",
        repoRoot: repoDir,
        profileId: "pi:local",
        model: "fixture",
      });
      runId = started.run.id;
      await waitUntil(() => a.db.listTasks(runId).some((t) => t.status === "running"));
      taskId = a.db.listTasks(runId)[0]!.id;
      await a.stop();
    } finally {
      await a.stop().catch(() => {});
    }

    const cfgB = makeTestConfig(repoDir, stateDir);
    const b = new HarnessDaemon(cfgB, {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    await b.start();
    await b.recovered;
    const client = new DaemonClient(cfgB.socketPath);
    await client.connect();
    try {
      await waitUntil(() => b.db.getTask(taskId)?.status === "running");
      const gen = b.db.getTask(taskId)!.generation;

      await assert.rejects(
        () =>
          client.request("tool.call", {
            runId,
            taskId: `${taskId}@g${gen}@${nonceA}`,
            name: "__list_tools",
            args: {},
          }),
        /previous harnessd process/,
      );

      await assert.rejects(
        () =>
          client.request("tool.call", {
            runId,
            taskId: `${taskId}@g${gen}`,
            name: "__list_tools",
            args: {},
          }),
        /previous harnessd process/,
      );

      const tools = await client.request<Array<{ name: string }>>("tool.call", {
        runId,
        taskId: `${taskId}@g${gen}@${b.instanceNonce}`,
        name: "__list_tools",
        args: {},
      });
      assert.ok(Array.isArray(tools) && tools.length > 0, "Current daemon nonce must allow __list_tools");
    } finally {
      client.close();
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("interrupted Director turn keeps its tool list and does not respawn", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfgA = makeTestConfig(repoDir, stateDir);

    let spawnedTaskId = "";
    let turnAReadyToStop = false;

    const runnerA: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) {
          await waitForAbort(req.signal);
          return { text: "child interrupted", stopReason: "cancelled" };
        }
        req.callbacks.onTextDelta?.("Working on delegating the scout.");
        req.callbacks.onToolEvent?.({
          id: "tc-spawn-1",
          name: "spawn_task",
          status: "in_progress",
          args: '{"title":"Inspect config"}',
        });
        const spawned = (await req.executeTool("spawn_task", {
          kind: "research",
          title: "Inspect config",
          objective: "Check config files",
          profile_id: "pi:local",
          model: "fixture",
        })) as { task_id?: string; id?: string; spawned?: string };
        spawnedTaskId = String(spawned.task_id ?? spawned.spawned ?? spawned.id ?? "");
        req.callbacks.onToolEvent?.({
          id: "tc-spawn-1",
          name: "spawn_task",
          status: "completed",
          args: '{"title":"Inspect config"}',
        });
        req.callbacks.onToolEvent?.({
          id: "tc-unwind-1",
          name: "check_status",
          status: "in_progress",
          args: '{"scope":"config"}',
        });
        turnAReadyToStop = true;
        await waitForAbort(req.signal);
        // Simulate a tool completing during the cancel unwind before the runner returns.
        req.callbacks.onToolEvent?.({
          id: "tc-unwind-1",
          name: "check_status",
          status: "completed",
          args: '{"scope":"config"}',
        });
        return { text: "Working on delegating the scout.", stopReason: "cancelled" };
      },
    });

    const a = new HarnessDaemon(cfgA, { dbPath, customRunnerFactory: runnerA });
    await a.start();
    const clientA = new DaemonClient(cfgA.socketPath);
    await clientA.connect();
    let chatId = "";
    let turnEndHistoryThrough: number | null = null;
    clientA.onEvent((ev) => {
      if (ev.type === "chat.turn.end") {
        const p = ev.payload as { historyThrough?: unknown };
        if (typeof p.historyThrough === "number") turnEndHistoryThrough = p.historyThrough;
      }
    });
    try {
      const opened = await clientA.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Director Tool List Test",
      });
      chatId = opened.session.id;

      const sendPromise = clientA
        .request("chat.send", { chatSessionId: chatId, text: "Delegate a scout" })
        .catch(() => {});
      await waitUntil(() => turnAReadyToStop && spawnedTaskId.length > 0);

      await a.stop();
      await sendPromise;
    } finally {
      clientA.close();
      await a.stop().catch(() => {});
    }

    let continuationTurns = 0;
    let continuationPrompt = "";
    const runnerB: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) {
          await waitForAbort(req.signal);
          return { text: "child", stopReason: "cancelled" };
        }
        continuationTurns++;
        continuationPrompt = req.initialPrompt;
        if (!req.initialPrompt.includes("Tool calls of the interrupted turn")) {
          await req.executeTool("spawn_task", {
            kind: "research",
            title: "Duplicate scout",
            objective: "Should not run",
            profile_id: "pi:local",
            model: "fixture",
          });
        }
        req.callbacks.onTextDelta?.("Continuing without respawning.");
        return { text: "Continuing without respawning.", stopReason: "completed" };
      },
    });

    const cfgB = makeTestConfig(repoDir, stateDir);
    const b = new HarnessDaemon(cfgB, { dbPath, customRunnerFactory: runnerB });
    try {
      const historyBeforeB = b.director.chats.getHistory(chatId, 0, 50);
      const partialTurn = historyBeforeB.find(
        (h) => h.role === "assistant" && h.content.includes("Working on delegating the scout."),
      );
      const notice = historyBeforeB.find(
        (h) => h.role === "system_notice" && h.content.includes("daemon restarted while this turn was running"),
      );
      assert.ok(partialTurn, "Expected flushed assistant partial turn before notice");
      assert.ok(notice, "Expected system_notice turn after stop");
      assert.ok(partialTurn.seq < notice.seq, "Notice must be appended after the final partial assistant turn");
      if (turnEndHistoryThrough !== null) {
        assert.ok(
          turnEndHistoryThrough < notice.seq,
          `chat.turn.end historyThrough (${turnEndHistoryThrough}) must precede notice seq (${notice.seq})`,
        );
      }
      assert.ok(notice.content.includes("spawn_task"), `Notice should mention spawn_task: ${notice.content}`);
      assert.ok(
        notice.content.includes("- completed: check_status"),
        `Tool completed during unwind must be listed as completed: ${notice.content}`,
      );
      assert.ok(
        !notice.content.includes("in flight when cancelled (outcome unknown): check_status"),
        `Tool completed during unwind must not be listed as in flight: ${notice.content}`,
      );
      assert.ok(notice.content.includes(spawnedTaskId), `Notice should mention ${spawnedTaskId}: ${notice.content}`);

      await b.start();
      await b.recovered;
      await waitUntil(() => continuationTurns === 1 && !b.director.activeChatCount());

      assert.equal(continuationTurns, 1);
      assert.ok(continuationPrompt.includes("Tool calls of the interrupted turn"));
      assert.ok(continuationPrompt.includes("spawn_task"));
      assert.ok(continuationPrompt.includes(spawnedTaskId));

      const delegatedTasks = b.orchestrator
        .listDirectorTaskRuns(chatId)
        .flatMap((r) => b.db.listTasks(r.id))
        .filter((t) => t.profileId !== "director");
      assert.equal(delegatedTasks.length, 1, "Director container must have exactly one delegated task");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("queued wakeups are saved at a plain stop and delivered once", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfgA = makeTestConfig(repoDir, stateDir);

    let inFlight = false;
    const runnerA: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) {
          return { text: "ok", stopReason: "completed" };
        }
        inFlight = true;
        req.callbacks.onTextDelta?.("Handling first turn...");
        await waitForAbort(req.signal);
        return { text: "Handling first turn...", stopReason: "cancelled" };
      },
    });

    const a = new HarnessDaemon(cfgA, { dbPath, customRunnerFactory: runnerA });
    await a.start();
    const clientA = new DaemonClient(cfgA.socketPath);
    await clientA.connect();
    let chatId = "";
    try {
      const opened = await clientA.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Queued Wakeup Test",
      });
      chatId = opened.session.id;

      const sendPromise = clientA
        .request("chat.send", { chatSessionId: chatId, text: "Start long turn" })
        .catch(() => {});
      await waitUntil(() => inFlight);

      const wakeEvent = {
        kind: "timer.fired" as const,
        timerId: "timer-99",
        reason: "follow up on build",
        wakeReason: "timer_expired",
      };
      (a as unknown as { scheduleDirectorWakeup: (id: string, ev: unknown) => void }).scheduleDirectorWakeup(
        chatId,
        wakeEvent,
      );

      await a.stop();
      await sendPromise;
    } finally {
      clientA.close();
      await a.stop().catch(() => {});
    }

    const receivedPrompts: string[] = [];
    const runnerB: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) return { text: "ok", stopReason: "completed" };
        receivedPrompts.push(req.initialPrompt);
        req.callbacks.onTextDelta?.(`handled #${receivedPrompts.length}`);
        return { text: `handled #${receivedPrompts.length}`, stopReason: "completed" };
      },
    });

    const cfgB = makeTestConfig(repoDir, stateDir);
    const b = new HarnessDaemon(cfgB, { dbPath, customRunnerFactory: runnerB });
    try {
      const pendingRows = b.db.db
        .prepare("SELECT chat_session_id, kind, payload_json FROM pending_wakeups ORDER BY id ASC")
        .all() as Array<{ chat_session_id: string; kind: string; payload_json: string | null }>;
      assert.equal(pendingRows.length, 2, "pending_wakeups must hold 1 continue + 1 event row");
      assert.equal(pendingRows[0]!.kind, "continue");
      assert.equal(pendingRows[1]!.kind, "event");

      await b.start();
      await b.recovered;
      await waitUntil(() => receivedPrompts.length === 2 && !b.director.activeChatCount());

      const remaining = b.db.db.prepare("SELECT COUNT(*) AS n FROM pending_wakeups").get() as { n: number };
      assert.equal(remaining.n, 0, "pending_wakeups must be empty after recovery");
      assert.ok(receivedPrompts[0]!.includes("Your previous turn was interrupted by a daemon restart"));
      assert.ok(receivedPrompts[1]!.includes("timer-99"), `Expected timer-99 wake turn, got: ${receivedPrompts[1]}`);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(receivedPrompts.length, 2);
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("malformed stored handoff still relaunches the task and subsequent tasks", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");

    const a = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const run = a.db.createRun({ goal: "Malformed handoff recovery", repoRoot: repoDir, baseBranch: "main", baseSha });
    const badTask = a.db.createTask({
      runId: run.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch with bad stored handoff",
      objective: "Continue despite malformed decision entry",
      profileId: "pi:local",
      model: "fixture",
    });
    const nextTask = a.db.createTask({
      runId: run.id,
      parentId: badTask.id,
      tier: 3,
      kind: "research",
      title: "Second task in launch order",
      objective: "Must also relaunch after badTask",
      readOnly: true,
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateTask(badTask.id, {
      status: "running",
      handoffJson: JSON.stringify({
        goalInvariants: ["keep invariant"],
        architecturalDecisions: [{ rationale: "missing decision string" }, { decision: "valid", rationale: "kept" }],
        activeRisks: [],
        nextActions: ["resume work"],
      }),
    });
    a.db.updateTask(nextTask.id, { status: "running" });
    await a.stop();

    const runCounts = new Map<string, number>();
    const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          runCounts.set(req.taskId, (runCounts.get(req.taskId) ?? 0) + 1);
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    try {
      await b.start();
      await b.recovered;
      await waitUntil(() => runCounts.get(badTask.id) === 1 && runCounts.get(nextTask.id) === 1, 5000);

      assert.equal(runCounts.get(badTask.id), 1, "Task with malformed stored handoff must still relaunch");
      assert.equal(runCounts.get(nextTask.id), 1, "Second task after it in launch order must also relaunch");
      assert.notEqual(b.db.getTask(badTask.id)?.status, "failed");
      assert.notEqual(b.db.getTask(badTask.id)?.status, "cancelled");
      assert.notEqual(b.db.getTask(nextTask.id)?.status, "failed");
      assert.notEqual(b.db.getTask(nextTask.id)?.status, "cancelled");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("ordinary Tier 3 verify task titled Done-Review in an executing goal is relaunched, not cancelled", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");

    const a = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const run = a.db.createRun({ goal: "Ordinary Done-Review title", repoRoot: repoDir, baseBranch: "main", baseSha });
    const goal = a.director.goals.createGoal({
      repoRoot: repoDir,
      title: "Executing goal",
      description: "Active goal with a user verify task",
      criteria: [{ description: "Passes checks", kind: "behavioral" }],
    });
    a.director.goals.linkRunAndStart(goal.id, run.id);

    const orch = a.db.createTask({
      runId: run.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch",
      objective: "Lead",
      profileId: "pi:local",
      model: "fixture",
    });
    const verifyTask = a.db.createTask({
      runId: run.id,
      parentId: orch.id,
      tier: 3,
      kind: "verify",
      title: "Done-Review: something",
      objective: "Verify implementation changes",
      readOnly: true,
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateTask(orch.id, { status: "waiting_children" });
    a.db.updateTask(verifyTask.id, { status: "running" });
    await a.stop();

    const runCounts = new Map<string, number>();
    const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          runCounts.set(req.taskId, (runCounts.get(req.taskId) ?? 0) + 1);
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    try {
      await b.start();
      await b.recovered;
      await waitUntil(() => runCounts.get(orch.id) === 1 && runCounts.get(verifyTask.id) === 1, 5000);

      assert.equal(runCounts.get(verifyTask.id), 1, "Ordinary verify task titled Done-Review must be relaunched");
      assert.notEqual(b.db.getTask(verifyTask.id)?.status, "cancelled", "Ordinary verify task must not be cancelled");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("early-trigger task timer stays pending while owner is held during phase B and steers once", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");

    const a = new HarnessDaemon(makeTestConfig(repoDir, stateDir), { dbPath });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const run = a.db.createRun({ goal: "Timer phase B guard", repoRoot: repoDir, baseBranch: "main", baseSha });
    const t1 = a.db.createTask({
      runId: run.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch launched first",
      objective: "Launches before held owner",
      profileId: "pi:local",
      model: "fixture",
    });
    const owner = a.db.createTask({
      runId: run.id,
      parentId: t1.id,
      tier: 2,
      kind: "worker",
      title: "Held owner with any timer",
      objective: "Owns wake_on_event any timer",
      readOnly: true,
      profileId: "pi:local",
      model: "fixture",
    });
    const child = a.db.createTask({
      runId: run.id,
      parentId: owner.id,
      tier: 3,
      kind: "research",
      title: "Child settling during phase B",
      objective: "Settles while owner is still held",
      readOnly: true,
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateTask(t1.id, { status: "running" });
    a.db.updateTask(owner.id, { status: "running" });
    const timer = a.db.timers.schedule({
      ownerKind: "task",
      ownerId: owner.id,
      runId: run.id,
      delaySeconds: 0.45,
      reason: "wake owner after restart",
      wakeOnEvent: "any",
    });
    await a.stop();

    let ownerStarted = false;
    let statusAfterChildSettled: string | undefined;
    let statusWhenOwnerStarted: string | undefined;
    const ownerSteers: string[] = [];

    const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      recoveryStaggerMs: 150,
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId === t1.id) {
            assert.equal(ownerStarted, false, "t1 must launch before held Tier 2 owner");
            // Startup suspension must allow schedule() without throwing (unarmed until restorePending).
            const tempTimer = b.db.timers.schedule({
              ownerKind: "task",
              ownerId: t1.id,
              runId: run.id,
              delaySeconds: 60,
              reason: "scheduled during startup",
            });
            b.db.timers.cancel(tempTimer.id, "cleanup");
            // Settle owner's child while owner is still held in Phase B.
            b.db.updateTask(child.id, { status: "completed", summary: "settled during phase B" });
            statusAfterChildSettled = b.db.timers.get(timer.id)?.status;
          }
          if (req.taskId === owner.id) {
            ownerStarted = true;
            statusWhenOwnerStarted = b.db.timers.get(timer.id)?.status;
            req.onHandle?.({
              steer: async (msg) => {
                ownerSteers.push(msg);
                return true;
              },
              cancel: async () => {},
            });
          }
          await waitForAbort(req.signal);
          return { text: "stopped", stopReason: "cancelled" };
        },
      }),
    });
    try {
      await b.start();
      await b.recovered;

      assert.equal(
        statusAfterChildSettled,
        "pending",
        "Event-triggered timer must remain pending when child settles while owner is held",
      );
      assert.equal(
        statusWhenOwnerStarted,
        "pending",
        "Timer must still be pending until Phase B finishes and restorePending arms it",
      );

      const getAcceptedSteers = () => {
        const rows = b.db.db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND type = 'agent.steered'")
          .all(run.id, owner.id) as Array<{ payload_json: string }>;
        return rows
          .map((e) => JSON.parse(e.payload_json) as { accepted?: boolean; message?: string })
          .filter((p) => p.accepted === true && typeof p.message === "string" && p.message.includes(timer.id));
      };
      await waitUntil(
        () =>
          b.db.timers.get(timer.id)?.status === "fired" &&
          ownerSteers.some((m) => m.includes(timer.id)) &&
          getAcceptedSteers().length >= 1,
        4000,
      );
      await new Promise((r) => setTimeout(r, 80));

      assert.equal(ownerSteers.filter((m) => m.includes(timer.id)).length, 1, "Owner must be steered exactly once");
      assert.equal(getAcceptedSteers().length, 1, "Expected exactly one accepted steer event");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("interrupted review of a failed-run goal replays once after restart", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");

    const a = new HarnessDaemon(makeTestConfig(repoDir, stateDir), { dbPath });
    const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
    const chat = a.director.chats.createSession({
      repoRoot: repoDir,
      title: "Review replay chat",
      profileId: "pi:local",
      model: "fixture",
    });

    const runFailed = a.db.createRun({ goal: "Failed run under review", repoRoot: repoDir, baseBranch: "main", baseSha });
    const goalFailed = a.director.goals.createGoal({
      repoRoot: repoDir,
      chatSessionId: chat.id,
      title: "Failed-run review goal",
      description: "Verify failed run can still be reviewed after restart",
      criteria: [{ id: "c1", kind: "behavioral", description: "Check behavior", required: true }],
    });
    a.director.goals.linkRunAndStart(goalFailed.id, runFailed.id);
    a.db.db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runFailed.id);
    a.director.goals.setStatus(goalFailed.id, "reviewing");

    const runStopped = a.db.createRun({ goal: "Stopped run under review", repoRoot: repoDir, baseBranch: "main", baseSha });
    const goalStopped = a.director.goals.createGoal({
      repoRoot: repoDir,
      chatSessionId: chat.id,
      title: "Stopped-run review goal",
      description: "Falls back to Director wake when run is stopped",
      criteria: [{ id: "c1", kind: "behavioral", description: "Check stopped", required: true }],
    });
    a.director.goals.linkRunAndStart(goalStopped.id, runStopped.id);
    a.db.db.prepare("UPDATE runs SET status = 'stopped' WHERE id = ?").run(runStopped.id);
    a.director.goals.setStatus(goalStopped.id, "reviewing");
    await a.stop();

    let reviewerRuns = 0;
    const chatWakePrompts: string[] = [];
    const cfgB = makeTestConfig(repoDir, stateDir);
    // Disable autoVerifyOnSettle so the test also proves manual/non-auto reviews replay.
    cfgB.goals = { ...cfgB.goals, autoVerifyOnSettle: false };
    const b = new HarnessDaemon(cfgB, {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.kind === "verify") {
            reviewerRuns += 1;
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Verified after restart" }],
              blockingIssues: [],
              summary: "Approved on replayed failed-run review",
            });
            return { text: "approved", stopReason: "completed" };
          }
          if (req.taskId.startsWith("chat-")) {
            chatWakePrompts.push(req.initialPrompt);
            return { text: "noted", stopReason: "completed" };
          }
          return { text: "ok", stopReason: "completed" };
        },
      }),
    });
    try {
      await b.start();
      await b.recovered;

      await waitUntil(
        () =>
          b.director.goals.getGoal(goalFailed.id)?.status === "achieved" &&
          chatWakePrompts.some((p) => p.includes(goalStopped.id) && p.includes("interrupted by daemon restart")),
        6000,
      );
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(reviewerRuns, 1, "Interrupted failed-run review must replay exactly once");
      assert.equal(b.director.goals.getGoal(goalFailed.id)?.status, "achieved");
      assert.equal(b.director.goals.getGoal(goalStopped.id)?.status, "awaiting_human");
      const fallbackEvents = b.director.chats
        .getHistory(chat.id, 0, 50)
        .filter(
          (t) =>
            t.event?.kind === "goal.settled" &&
            t.event.goalId === goalStopped.id &&
            (t.event.detail ?? "").includes("interrupted by daemon restart"),
        );
      assert.equal(fallbackEvents.length, 1, "Fallback Director wake for unreplayable goal must fire once");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("reapChildProcessGroups kills a captured detached child group after its leader exits", async () => {
    if (process.platform === "win32") return;

    const isAlive = (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    };
    const isGroupAlive = (pgid: number): boolean => {
      try {
        process.kill(-pgid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    };

    const grandchildCode = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const leaderCode = `
      const { spawn } = require("node:child_process");
      const g = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildCode)}], { stdio: "ignore" });
      process.stdout.write("GRANDCHILD:" + g.pid + "\\n");
      process.on("SIGTERM", () => process.exit(0));
      setInterval(() => {}, 1000);
    `;
    const parentCode = `
      const { spawn } = require("node:child_process");
      const l = spawn(process.execPath, ["-e", ${JSON.stringify(leaderCode)}], {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      process.stdout.write("LEADER:" + l.pid + "\\n");
      l.stdout.on("data", (d) => process.stdout.write(d));
      setInterval(() => {}, 1000);
    `;

    const parent = spawn(process.execPath, ["-e", parentCode], { stdio: ["ignore", "pipe", "pipe"] });
    let leaderPid = 0;
    let grandchildPid = 0;
    let outBuf = "";
    parent.stdout?.on("data", (chunk: Buffer) => {
      outBuf += chunk.toString("utf8");
      const lMatch = outBuf.match(/LEADER:(\d+)/);
      const gMatch = outBuf.match(/GRANDCHILD:(\d+)/);
      if (lMatch) leaderPid = Number(lMatch[1]);
      if (gMatch) grandchildPid = Number(gMatch[1]);
    });

    try {
      await waitUntil(() => leaderPid > 0 && grandchildPid > 0, 5000);
      assert.ok(parent.pid && parent.pid > 0);

      // Capture direct detached child PGIDs before unwind while the group leader is still alive.
      const captured = listChildProcessGroups(parent.pid);
      assert.ok(captured.includes(leaderPid), `Expected captured PGIDs ${captured.join(",")} to include ${leaderPid}`);

      // Group leader exits on SIGTERM while grandchild ignores SIGTERM and stays alive in PGID = leaderPid.
      process.kill(leaderPid, "SIGTERM");
      await waitUntil(() => !isAlive(leaderPid), 3000);
      assert.equal(isAlive(grandchildPid), true, "Grandchild must still be alive after leader exits");
      assert.equal(
        listChildProcessGroups(parent.pid).includes(leaderPid),
        false,
        "Post-exit listing alone can no longer discover the orphaned process group",
      );

      // Reaping with the pre-unwind captured PGIDs kills the surviving grandchild group and waits until gone.
      const sigkilled = await reapChildProcessGroups(parent.pid, 200, captured);
      assert.ok(sigkilled >= 1, `Expected SIGKILL on SIGTERM-ignoring grandchild group, got ${sigkilled}`);
      assert.equal(isAlive(grandchildPid), false, "Grandchild must be gone before reapChildProcessGroups returns");
      assert.equal(isGroupAlive(leaderPid), false, "Process group must be gone before reapChildProcessGroups returns");
    } finally {
      for (const target of [leaderPid ? -leaderPid : 0, grandchildPid, leaderPid, parent.pid ?? 0]) {
        if (!target) continue;
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 15_000);
});
