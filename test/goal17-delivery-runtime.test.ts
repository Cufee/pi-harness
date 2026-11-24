import { withFixtureCatalog } from "./fixtures/launch-config.js";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { formatAmendmentDelta } from "../src/director/runtime.js";
import { runGit } from "../src/worktree/manager.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-g17-rt-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("Timed out waiting for condition");
}

describe("goal-17 runtime settlement fence, bindings, and amendment text", () => {
  it("fences settlement and keeps T1 bound to old version while worker fanout is awaiting", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g17-fence-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: true },
        stateDir,
        socketPath: sockPath,
      });

      let t1Id = "";
      let workerId = "";
      let t1Runs = 0;
      const workerReady = Promise.withResolvers<void>();
      const workerSteerEntered = Promise.withResolvers<void>();
      const workerSteerGate = Promise.withResolvers<boolean>();
      const releaseT1Gen1 = Promise.withResolvers<void>();
      const t1Gen2Started = Promise.withResolvers<string>();
      const releaseT1Gen2 = Promise.withResolvers<void>();
      const releaseWorker = Promise.withResolvers<void>();

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.tier === 1) {
              t1Id = req.taskId;
              t1Runs += 1;
              if (t1Runs === 1) {
                req.onHandle?.({
                  steer: async () => true,
                  cancel: async () => releaseT1Gen1.resolve(),
                });
                const spawned = (await req.executeTool("spawn_worker", {
                  title: "Worker on c2",
                  objective: "Build c2",
                  criteria: "c2",
                  write_scopes: ["a.txt"],
                  model: "fixture/fixture",
                })) as { spawned: string };
                workerId = spawned.spawned;
                await releaseT1Gen1.promise;
                return { text: "t1 gen1 finished on v1", stopReason: "completed" };
              }
              req.onHandle?.({
                steer: async () => true,
                cancel: async () => releaseT1Gen2.resolve(),
              });
              t1Gen2Started.resolve(req.initialPrompt);
              await releaseT1Gen2.promise;
              return { text: "t1 gen2 finished on v2", stopReason: "completed" };
            }
            if (req.taskId === workerId) {
              req.onHandle?.({
                steer: async () => {
                  workerSteerEntered.resolve();
                  return await workerSteerGate.promise;
                },
                cancel: async () => releaseWorker.resolve(),
              });
              workerReady.resolve();
              await releaseWorker.promise;
              return { text: "worker done", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          title: "Fence test",
          description: "Test settlement fence during worker fanout",
          criteria: [
            { id: "c1", description: "file.txt exists", kind: "deterministic", command: "test -f file.txt", required: true },
            { id: "c2", description: "Drop c2", kind: "behavioral", required: true },
          ],
          verificationMode: "deterministic",
        });
        await daemon.director.commitGoal(goal.id);
        await workerReady.promise;
        const runId = daemon.director.goals.getGoal(goal.id)!.linkedRunId!;

        // Start v1 -> v2 amendment; it will pause inside worker steer fanout.
        const amendPromise = daemon.director.amendGoal(goal.id, {
          removeCriteriaIds: ["c2"],
          rationale: "Cut c2 in v2",
        });
        await workerSteerEntered.promise;

        // 1. T1's bound version must remain v1 while worker fanout is awaiting.
        assert.equal(daemon.db.getTask(t1Id)?.goalVersion, 1, "T1 must stay bound to v1 before delivery");

        // 2. T1 cannot report passed/completed against the old contract while worker fanout is awaiting.
        const staleProg = (await daemon.orchestrator.toolExecutor.execute(runId, t1Id, "report_goal_progress", {
          summary: "finished v1 work",
          phase: "completed",
          verification_status: "passed",
        })) as { recorded: boolean; dropped?: Array<{ field: string; value: string }>; note?: string };
        assert.ok(staleProg.dropped?.some((d) => d.field === "verificationStatus" && d.value === "passed"));
        assert.ok(staleProg.dropped?.some((d) => d.field === "phase" && d.value === "completed"));
        assert.ok(staleProg.note?.includes("v1"));
        const midGoal = daemon.director.goals.getGoal(goal.id)!;
        assert.notEqual(midGoal.liveProgress?.verificationStatus, "passed");
        assert.notEqual(midGoal.liveProgress?.phase, "completed");

        // 3. Verification/review cannot run while amendment fanout is in flight.
        await assert.rejects(
          () => daemon.director.verifyAndReviewGoal(goal.id),
          /unacknowledged amendment/,
        );

        // 4. T1 + worker settling while fanout is awaiting must NOT achieve the goal on v1.
        releaseWorker.resolve();
        releaseT1Gen1.resolve();
        await waitFor(() => daemon.db.getTask(t1Id)?.status === "completed");
        await new Promise((r) => setTimeout(r, 60));
        assert.equal(
          daemon.director.goals.getGoal(goal.id)?.status,
          "executing",
          "goal must stay executing while in-flight amendment fences stale settlement",
        );

        // 5. Release worker fanout -> amendGoal detects T1 settled and relaunches T1 on v2.
        workerSteerGate.resolve(false);
        const amended = await amendPromise;
        assert.equal(amended.delivery.delivered, true);
        assert.equal(amended.delivery.via, "resume");

        const gen2Prompt = await t1Gen2Started.promise;
        assert.ok(gen2Prompt.includes("v1 -> v2") || gen2Prompt.includes("Cut c2 in v2"));
        assert.equal(daemon.db.getTask(t1Id)?.goalVersion, 2, "relaunched T1 must bind to v2");

        // 6. Now T1 gen 2 can report passed/completed on v2 and settle the goal.
        const v2Prog = (await daemon.orchestrator.toolExecutor.execute(runId, t1Id, "report_goal_progress", {
          summary: "finished v2 work",
          phase: "completed",
          verification_status: "passed",
        })) as { recorded: boolean; dropped?: unknown[] };
        assert.equal(v2Prog.recorded, true);
        assert.equal(v2Prog.dropped, undefined);

        releaseT1Gen2.resolve();
        await waitFor(() => daemon.director.goals.getGoal(goal.id)?.status === "achieved");
      } finally {
        workerSteerGate.resolve(false);
        releaseWorker.resolve();
        releaseT1Gen1.resolve();
        releaseT1Gen2.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps T1 bound to old version on refused or in-flight steer and advances only on live confirmation", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g17-t1bind-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      let t1Id = "";
      let steerAttempt = 0;
      const t1Ready = Promise.withResolvers<void>();
      const releaseT1 = Promise.withResolvers<void>();
      const secondSteerEntered = Promise.withResolvers<void>();
      const secondSteerGate = Promise.withResolvers<boolean>();

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            t1Id = req.taskId;
            req.onHandle?.({
              steer: async () => {
                steerAttempt += 1;
                if (steerAttempt === 1) return false;
                secondSteerEntered.resolve();
                return await secondSteerGate.promise;
              },
              cancel: async () => releaseT1.resolve(),
            });
            t1Ready.resolve();
            await releaseT1.promise;
            return { text: "t1 done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          title: "T1 live binding",
          description: "Verify T1 version advances only after live delivery",
          criteria: [{ id: "c1", description: "Criterion 1", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        await daemon.director.commitGoal(goal.id);
        await t1Ready.promise;

        // First amendment refused by T1 handle: T1 stays at v1.
        const amend2 = await daemon.director.amendGoal(goal.id, {
          appendDescription: "v2 requirement",
          rationale: "add v2",
        });
        assert.equal(amend2.delivery.delivered, false);
        assert.equal(daemon.db.getTask(t1Id)?.goalVersion, 1);

        // Second amendment in flight: T1 stays at v1 until steer resolves true.
        const amend3Promise = daemon.director.amendGoal(goal.id, {
          appendDescription: "v3 requirement",
          rationale: "add v3",
        });
        await secondSteerEntered.promise;
        assert.equal(daemon.db.getTask(t1Id)?.goalVersion, 1);

        secondSteerGate.resolve(true);
        const amend3 = await amend3Promise;
        assert.equal(amend3.delivery.delivered, true);
        assert.equal(amend3.delivery.via, "steer");
        assert.equal(daemon.db.getTask(t1Id)?.goalVersion, 3);
      } finally {
        secondSteerGate.resolve(false);
        releaseT1.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("leaves worker goalVersion unchanged on not-live steer and reports not-delivered per task", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g17-notlive-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      let liveWorkerId = "";
      let queuedWorkerId = "";
      let refusedWorkerId = "";
      let readyCount = 0;
      const allReady = Promise.withResolvers<void>();
      const releaseAll = Promise.withResolvers<void>();
      const releaseRefused = Promise.withResolvers<void>();
      const t1Steers: string[] = [];

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.tier === 1) {
              req.onHandle?.({
                steer: async (msg) => {
                  t1Steers.push(msg);
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              const r1 = (await req.executeTool("spawn_worker", {
                title: "Live worker",
                objective: "Work on c2",
                criteria: "c2",
                write_scopes: ["a.txt"],
                model: "fixture/fixture",
              })) as { spawned: string };
              liveWorkerId = r1.spawned;
              const r2 = (await req.executeTool("spawn_worker", {
                title: "Queued worker",
                objective: "Work on c2 too",
                criteria: "c2",
                write_scopes: ["b.txt"],
                model: "fixture/fixture",
              })) as { spawned: string };
              queuedWorkerId = r2.spawned;
              const r3 = (await req.executeTool("spawn_worker", {
                title: "Refused worker",
                objective: "Work on c1",
                criteria: "c1",
                write_scopes: ["c.txt"],
                model: "fixture/fixture",
              })) as { spawned: string };
              refusedWorkerId = r3.spawned;
              await releaseAll.promise;
              return { text: "t1 done", stopReason: "completed" };
            }
            if (req.taskId === liveWorkerId) {
              req.onHandle?.({
                steer: async () => {
                  // Let refusedWorker settle before the loop reaches it.
                  releaseRefused.resolve();
                  await waitFor(() => daemon.db.getTask(refusedWorkerId)?.status === "completed");
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              readyCount += 1;
              if (readyCount === 3) allReady.resolve();
              await releaseAll.promise;
              return { text: "live done", stopReason: "completed" };
            }
            if (req.taskId === queuedWorkerId) {
              req.onHandle?.({
                steer: async () => false,
                cancel: async () => releaseAll.resolve(),
              });
              readyCount += 1;
              if (readyCount === 3) allReady.resolve();
              await releaseAll.promise;
              return { text: "queued done", stopReason: "completed" };
            }
            if (req.taskId === refusedWorkerId) {
              req.onHandle?.({
                steer: async () => false,
                cancel: async () => releaseRefused.resolve(),
              });
              readyCount += 1;
              if (readyCount === 3) allReady.resolve();
              await releaseRefused.promise;
              return { text: "refused worker finished early", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          title: "Not-live steer reporting",
          description: "Report not-delivered per worker when steer is not live",
          criteria: [
            { id: "c1", description: "Keep c1", kind: "behavioral", required: true },
            { id: "c2", description: "Cut c2", kind: "behavioral", required: true },
          ],
          verificationMode: "none",
        });
        await daemon.director.commitGoal(goal.id);
        await allReady.promise;

        const amended = await daemon.director.amendGoal(goal.id, {
          removeCriteriaIds: ["c2"],
          rationale: "Drop c2",
        });

        const liveEntry = amended.affectedTasks.find((a) => a.taskId === liveWorkerId)!;
        const queuedEntry = amended.affectedTasks.find((a) => a.taskId === queuedWorkerId)!;
        const refusedEntry = amended.affectedTasks.find((a) => a.taskId === refusedWorkerId)!;

        assert.equal(liveEntry.action, "delivered");
        assert.equal(liveEntry.live, true);
        assert.equal(liveEntry.delivered, true);
        assert.equal(daemon.db.getTask(liveWorkerId)?.goalVersion, 2);

        assert.equal(queuedEntry.action, "queued");
        assert.equal(queuedEntry.live, false);
        assert.equal(queuedEntry.delivered, false);
        assert.equal(daemon.db.getTask(queuedWorkerId)?.goalVersion, 1, "queued steer must not advance goalVersion");

        assert.equal(refusedEntry.action, "refused");
        assert.equal(refusedEntry.live, false);
        assert.equal(refusedEntry.delivered, false);
        assert.equal(daemon.db.getTask(refusedWorkerId)?.goalVersion, 1, "refused steer must not advance goalVersion");

        assert.equal(t1Steers.length, 1);
        const t1Msg = t1Steers[0]!;
        assert.ok(t1Msg.includes(`${queuedWorkerId}`) && t1Msg.includes("not delivered"), t1Msg);
        assert.ok(t1Msg.includes(`${refusedWorkerId}`) && t1Msg.includes("not delivered"), t1Msg);
        assert.ok(t1Msg.includes("cancel_child"), t1Msg);
      } finally {
        releaseRefused.resolve();
        releaseAll.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("fences late worker fanout when a newer amendment supersedes it", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g17-latefan-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      let w1Id = "";
      let w2Id = "";
      let t1Id = "";
      let readyCount = 0;
      const allReady = Promise.withResolvers<void>();
      const releaseAll = Promise.withResolvers<void>();
      const w1V2Entered = Promise.withResolvers<void>();
      const w1V2Gate = Promise.withResolvers<boolean>();
      const w2Steers: string[] = [];
      const t1Steers: string[] = [];

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.tier === 1) {
              t1Id = req.taskId;
              req.onHandle?.({
                steer: async (msg) => {
                  t1Steers.push(msg);
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              const r1 = (await req.executeTool("spawn_worker", {
                title: "Worker 1",
                objective: "Work A",
                write_scopes: ["a.txt"],
                model: "fixture/fixture",
              })) as { spawned: string };
              w1Id = r1.spawned;
              const r2 = (await req.executeTool("spawn_worker", {
                title: "Worker 2",
                objective: "Work B",
                write_scopes: ["b.txt"],
                model: "fixture/fixture",
              })) as { spawned: string };
              w2Id = r2.spawned;
              await releaseAll.promise;
              return { text: "t1 done", stopReason: "completed" };
            }
            if (req.taskId === w1Id) {
              req.onHandle?.({
                steer: async (msg) => {
                  if (msg.includes("v1 -> v2")) {
                    w1V2Entered.resolve();
                    return await w1V2Gate.promise;
                  }
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              readyCount += 1;
              if (readyCount === 2) allReady.resolve();
              await releaseAll.promise;
              return { text: "w1 done", stopReason: "completed" };
            }
            if (req.taskId === w2Id) {
              req.onHandle?.({
                steer: async (msg) => {
                  w2Steers.push(msg);
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              readyCount += 1;
              if (readyCount === 2) allReady.resolve();
              await releaseAll.promise;
              return { text: "w2 done", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          title: "Late fanout fence",
          description: "Ensure superseded v2 fanout does not steer remaining workers or T1",
          criteria: [{ id: "c1", description: "Keep c1", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        await daemon.director.commitGoal(goal.id);
        await allReady.promise;

        // v2 starts and pauses inside w1 steer.
        const amendV2Promise = daemon.director.amendGoal(goal.id, {
          appendDescription: "v2 scope",
          rationale: "v2 change",
        });
        await w1V2Entered.promise;

        // v3 supersedes v2 while v2 is still awaiting w1.
        const amendV3Promise = daemon.director.amendGoal(goal.id, {
          appendDescription: "v3 scope",
          rationale: "v3 supersedes v2",
        });

        // Release v2's steer on w1; v2 must detect supersession and stop before steering w2 or T1.
        w1V2Gate.resolve(true);
        const [v2Res, v3Res] = await Promise.all([amendV2Promise, amendV3Promise]);

        assert.equal(v2Res.delivery.delivered, false);
        assert.ok(v2Res.delivery.reason?.includes("superseded"), v2Res.delivery.reason);
        assert.equal(v3Res.delivery.delivered, true);

        // Neither w2 nor T1 should receive stale v2 steers.
        assert.ok(w2Steers.every((m) => !m.includes("v1 -> v2")), `unexpected v2 steer to w2: ${w2Steers.join(" | ")}`);
        assert.ok(w2Steers.some((m) => m.includes("v2 -> v3")), "w2 must receive v3 steer");
        assert.ok(t1Steers.every((m) => !m.includes("v1 -> v2")), `unexpected v2 steer to T1: ${t1Steers.join(" | ")}`);
        assert.ok(t1Steers.some((m) => m.includes("v2 -> v3")), "T1 must receive v3 steer");

        assert.equal(daemon.db.getTask(w1Id)?.goalVersion, 3);
        assert.equal(daemon.db.getTask(w2Id)?.goalVersion, 3);
        assert.equal(daemon.db.getTask(t1Id)?.goalVersion, 3);
      } finally {
        w1V2Gate.resolve(false);
        releaseAll.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("includes NULL-bound linked workers as affected with observed version while unlinked tasks stay NULL", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g17-nullbind-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      let linkedWorkerId = "";
      const workerReady = Promise.withResolvers<void>();
      const releaseAll = Promise.withResolvers<void>();

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.tier === 1) {
              req.onHandle?.({
                steer: async () => true,
                cancel: async () => releaseAll.resolve(),
              });
              const r = (await req.executeTool("spawn_worker", {
                title: "Migrated worker",
                objective: "Work on c2",
                criteria: "c2",
                write_scopes: ["m.txt"],
                model: "fixture/fixture",
              })) as { spawned: string };
              linkedWorkerId = r.spawned;
              await releaseAll.promise;
              return { text: "t1 done", stopReason: "completed" };
            }
            req.onHandle?.({
              steer: async () => false,
              cancel: async () => releaseAll.resolve(),
            });
            workerReady.resolve();
            await releaseAll.promise;
            return { text: "w done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        // Create an unlinked run + task (no goal linked to it).
        const unlinkedRun = daemon.db.createRun({
          goal: "Unlinked standalone run",
          repoRoot,
          baseBranch: "main",
          baseSha: "HEAD",
        });
        const unlinkedTask = daemon.db.createTask({
          runId: unlinkedRun.id,
          parentId: null,
          tier: 2,
          kind: "worker",
          title: "Unlinked task",
          objective: "Standalone work",
          criteria: "Done",
          profileId: "fixture",
          readOnly: false,
          writeScopes: [],
        });
        assert.equal(daemon.db.getTask(unlinkedTask.id)?.goalVersion, null);

        const goal = daemon.director.goals.createGoal({
          repoRoot,
          title: "NULL binding migration test",
          description: "Linked worker with NULL goal_version is included as affected",
          criteria: [
            { id: "c1", description: "Keep c1", kind: "behavioral", required: true },
            { id: "c2", description: "Drop c2", kind: "behavioral", required: true },
          ],
          verificationMode: "none",
        });
        await daemon.director.commitGoal(goal.id);
        await workerReady.promise;

        // Simulate a worker running across the schema migration (goal_version = NULL).
        daemon.db.db.prepare("UPDATE tasks SET goal_version = NULL WHERE id = ?").run(linkedWorkerId);
        assert.equal(daemon.db.getTask(linkedWorkerId)?.goalVersion, null);

        const amended = await daemon.director.amendGoal(goal.id, {
          removeCriteriaIds: ["c2"],
          rationale: "Drop c2",
        });

        const entry = amended.affectedTasks.find((a) => a.taskId === linkedWorkerId);
        assert.ok(entry, "NULL-bound linked worker must be included in affectedTasks");
        assert.equal(entry.action, "queued");
        assert.equal(entry.live, false);
        assert.equal(entry.delivered, false);
        assert.equal(entry.boundVersion, 1, "observed upper bound version recorded");
        assert.equal(
          daemon.db.getTask(linkedWorkerId)?.goalVersion,
          1,
          "NULL-bound linked worker should record observed upper bound version (not stay NULL or jump to v2)",
        );
        assert.equal(
          daemon.db.getTask(unlinkedTask.id)?.goalVersion,
          null,
          "unlinked task must remain NULL",
        );
      } finally {
        releaseAll.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("does not tell read-only Tier 3 tasks to commit and uses concrete return_task fields", async () => {
    const baseGoal = { id: "goal-1", version: 2, description: "desc", nonGoals: [] };
    const delta = {
      fromVersion: 1,
      toVersion: 2,
      rationale: "cut c2",
      addedCriteria: [],
      removedCriteriaIds: ["c2"],
      modifiedCriteria: [],
      descriptionChanged: false,
      nonGoalsChanged: false,
    };

    const readOnlyMsg = formatAmendmentDelta(baseGoal, delta, {
      audience: "worker",
      boundVersion: 1,
      readOnly: true,
    });
    assert.ok(!/\bcommit\b/i.test(readOnlyMsg), `read-only amendment text must not mention commit: ${readOnlyMsg}`);
    assert.ok(readOnlyMsg.includes('return_task({ status: "completed", partial: true, summary, sources })'), readOnlyMsg);

    const writableMsg = formatAmendmentDelta(baseGoal, delta, {
      audience: "worker",
      boundVersion: 1,
      readOnly: false,
    });
    assert.ok(writableMsg.includes('return_task({ status: "completed", partial: true, summary })'), writableMsg);

    // Also verify end-to-end through amendGoal with a running Tier 3 read-only research task.
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g17-ro-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      let t3Id = "";
      const t3Ready = Promise.withResolvers<void>();
      const releaseAll = Promise.withResolvers<void>();
      const t3Steers: string[] = [];

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.tier === 1) {
              req.onHandle?.({
                steer: async () => true,
                cancel: async () => releaseAll.resolve(),
              });
              const r = (await req.executeTool("spawn_task", {
                kind: "research",
                title: "Read-only research",
                objective: "Research c2",
                criteria: "Report findings on c2",
                model: "fixture/fixture",
              })) as { spawned: string };
              t3Id = r.spawned;
              await releaseAll.promise;
              return { text: "t1 done", stopReason: "completed" };
            }
            if (req.taskId === t3Id) {
              req.onHandle?.({
                steer: async (msg) => {
                  t3Steers.push(msg);
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              t3Ready.resolve();
              await releaseAll.promise;
              return { text: "research done", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          title: "Read-only Tier 3 amendment wording",
          description: "Verify Tier 3 research receives read-only guidance",
          criteria: [
            { id: "c1", description: "Keep c1", kind: "behavioral", required: true },
            { id: "c2", description: "Cut c2", kind: "behavioral", required: true },
          ],
          verificationMode: "none",
        });
        await daemon.director.commitGoal(goal.id);
        await t3Ready.promise;

        await daemon.director.amendGoal(goal.id, {
          removeCriteriaIds: ["c2"],
          rationale: "Drop c2",
        });

        assert.equal(t3Steers.length, 1);
        assert.ok(!/\bcommit\b/i.test(t3Steers[0]!), `Tier 3 steer must not say commit: ${t3Steers[0]}`);
        assert.ok(t3Steers[0]!.includes('return_task({ status: "completed", partial: true, summary, sources })'), t3Steers[0]);
      } finally {
        releaseAll.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
