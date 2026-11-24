import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
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
  cfg.worktree = { dir: ".harness/worktrees", archiveRetentionDays: 7, maxConcurrentWorkers: 4 };
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
    let pendingTaskId = "";
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
            objective: "Waits for Active scout",
            depends_on: [childT3Id],
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

      // Insert an unlaunched `ready` task into the active run before stopping.
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

      const beforeTasks = a.db.listTasks(runId);
      taskIdsBeforeStop = beforeTasks.map((t) => t.id).sort();
      statusesBeforeStop = new Map(beforeTasks.map((t) => [t.id, t.status]));
      gensBeforeStop = new Map(beforeTasks.map((t) => [t.id, t.generation]));

      assert.equal(statusesBeforeStop.get(orchId), "waiting_children");
      assert.equal(statusesBeforeStop.get(childT3Id), "running");
      assert.equal(statusesBeforeStop.get(workerId), "running");
      assert.equal(statusesBeforeStop.get(readyTaskId), "ready");
      assert.equal(statusesBeforeStop.get(pendingTaskId), "pending");

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
      // Verify a.stop() did not rewrite any task status in SQLite.
      for (const [id, status] of statusesBeforeStop) {
        assert.equal(b.db.getTask(id)?.status, status, `Task ${id} status must be unchanged after stop`);
      }

      await b.start();
      // Between phase A and phase B completion, getEffectiveRun must stay active.
      assert.equal(b.orchestrator.getEffectiveRun(runId)?.status, "active");
      await b.recovered;
      await waitUntil(
        () =>
          runCountsB.get(orchId) === 1 &&
          runCountsB.get(childT3Id) === 1 &&
          runCountsB.get(workerId) === 1 &&
          runCountsB.get(readyTaskId) === 1,
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
      assert.equal(runCountsB.get(pendingTaskId) ?? 0, 0);
      assert.equal(b.db.getTask(pendingTaskId)?.status, "pending");

      const orchPrompt = promptsB.get(orchId) ?? "";
      assert.ok(orchPrompt.includes(childT3Id), "Orchestrator prompt must contain child ID");
      assert.ok(orchPrompt.includes("tree_view"), "Orchestrator prompt must mention tree_view");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

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
      const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
        dbPath,
        customRunnerFactory: () => ({
          run: async (req) => {
            relaunchPrompt = req.initialPrompt;
            req.onHandle?.({
              steer: async () => true,
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
        assert.ok(relaunchPrompt.includes(waitTimerId), `Relaunch prompt must name wait_timer ${waitTimerId}`);
        assert.ok(relaunchPrompt.includes(schedTimerId), `Relaunch prompt must name schedule_timer ${schedTimerId}`);

        const steeredEvents = b.db.db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND type = 'agent.steered'")
          .all(runId, taskId) as Array<{ payload_json: string }>;
        const accepted = steeredEvents
          .map((e) => JSON.parse(e.payload_json) as { accepted?: boolean; message?: string })
          .filter((p) => p.accepted === true && typeof p.message === "string");
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
  });

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
  });

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
  });

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
  });

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
        turnAReadyToStop = true;
        await waitForAbort(req.signal);
        return { text: "Working on delegating the scout.", stopReason: "cancelled" };
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
      const notice = historyBeforeB.find(
        (h) => h.role === "system_notice" && h.content.includes("daemon restarted while this turn was running"),
      );
      assert.ok(notice, "Expected system_notice turn after stop");
      assert.ok(notice.content.includes("spawn_task"), `Notice should mention spawn_task: ${notice.content}`);
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
  });

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
  });

  it("a stop during recovery is recovered by the next start", async () => {
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
    const run = a.db.createRun({ goal: "Mid-recovery stop", repoRoot: repoDir, baseBranch: "main", baseSha });
    const t1 = a.db.createTask({
      runId: run.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch",
      objective: "Lead",
      profileId: "pi:local",
      model: "fixture",
    });
    const t2 = a.db.createTask({
      runId: run.id,
      parentId: t1.id,
      tier: 3,
      kind: "research",
      title: "Scout A",
      objective: "Research A",
      readOnly: true,
      profileId: "pi:local",
      model: "fixture",
    });
    const t3 = a.db.createTask({
      runId: run.id,
      parentId: t1.id,
      tier: 3,
      kind: "research",
      title: "Scout B",
      objective: "Research B",
      readOnly: true,
      profileId: "pi:local",
      model: "fixture",
    });
    a.db.updateTask(t1.id, { status: "running" });
    a.db.updateTask(t2.id, { status: "running" });
    a.db.updateTask(t3.id, { status: "running" });
    await a.stop();

    const launchedInB: string[] = [];
    const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      recoveryStaggerMs: 50,
      customRunnerFactory: () => ({
        run: async (req) => {
          launchedInB.push(req.taskId);
          await waitForAbort(req.signal);
          return { text: "stopped in B", stopReason: "cancelled" };
        },
      }),
    });
    await b.start();
    try {
      await waitUntil(() => launchedInB.length >= 1);
      await b.stop();
      await b.recovered;
    } finally {
      await b.stop().catch(() => {});
    }

    const countsInC = new Map<string, number>();
    const c = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
      dbPath,
      customRunnerFactory: () => ({
        run: async (req) => {
          countsInC.set(req.taskId, (countsInC.get(req.taskId) ?? 0) + 1);
          await waitForAbort(req.signal);
          return { text: "stopped in C", stopReason: "cancelled" };
        },
      }),
    });
    try {
      await c.start();
      await c.recovered;
      await waitUntil(() => countsInC.get(t1.id) === 1 && countsInC.get(t2.id) === 1 && countsInC.get(t3.id) === 1);

      const executing = new Set(c.orchestrator.executingTaskIds());
      for (const id of [t1.id, t2.id, t3.id]) {
        assert.equal(countsInC.get(id), 1, `Task ${id} must run once in C`);
        assert.notEqual(c.db.getTask(id)?.status, "failed", `Task ${id} must not be failed`);
        assert.ok(executing.has(id), `Task ${id} must have a live execution in C`);
      }
    } finally {
      await c.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
