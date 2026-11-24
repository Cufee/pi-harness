import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { GOAL_VERIFICATION_IDLE_NOTE, type GoalActiveVerification } from "../src/director/goal-get.js";
import type { GoalBudgets, GoalRecord } from "../src/goals/engine.js";
import type { WorkSnapshot } from "../src/tui/store.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "base.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

describe("goal-26 server RPC wiring", () => {
  it("a) goal.get and work.snapshot expose activeVerification for a verifying goal at reviewCycle 0", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const releaseFile = join(repoRoot, ".release-gate");
    const reviewerEntered = deferred<void>();
    const releaseReviewer = deferred<void>();

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind === "verify") {
              reviewerEntered.resolve();
              await Promise.race([
                releaseReviewer.promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              if (req.signal.aborted) return { text: "aborted", stopReason: "cancelled" };
              return {
                text: JSON.stringify({
                  verdict: "approved",
                  summary: "All good",
                  criteriaResults: [
                    { criterionId: "c1", passed: true, evidence: "gate passed" },
                    { criterionId: "c2", passed: true, evidence: "reviewed" },
                  ],
                  blockingIssues: [],
                  recommendations: [],
                }),
                stopReason: "completed",
              };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Verify visibility over RPC", repoRoot, baseBranch: "main", baseSha });
        const orch = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1",
          objective: "Work",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orch.id, { status: "completed", summary: "Done" });
        daemon.db.updateRunStatus(run.id, "completed");

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Verifying RPC visibility",
          description: "Exposes activeVerification during gates and reviewer at reviewCycle 0",
          criteria: [
            {
              id: "c1",
              description: "Gate file exists",
              kind: "deterministic",
              command: `until [ -f "${releaseFile}" ]; do sleep 0.05; done`,
              required: true,
            },
            { id: "c2", description: "Behavioral review", kind: "behavioral", required: true },
          ],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        // Idle verifying goal (no in-flight verification) emits activeVerification: null + verificationNote.
        const idleGoal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Idle verifying goal",
          description: "No live review running in daemon",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.setStatus(idleGoal.id, "verifying", "Orphaned verifying state");
        const idleGet = await client.request<{
          goal: GoalRecord;
          activeVerification: GoalActiveVerification | null;
          verificationNote?: string;
        }>("goal.get", { goalId: idleGoal.id });
        assert.equal(idleGet.activeVerification, null);
        assert.equal(idleGet.verificationNote, GOAL_VERIFICATION_IDLE_NOTE);

        const verifyPromise = daemon.director.verifyAndReviewGoal(goal.id);

        // 1) Gates phase at reviewCycle === 0.
        await waitFor(
          () => daemon.director.getActiveVerification(goal.id)?.phase === "gates",
          5_000,
          "gates phase",
        );
        assert.equal(daemon.director.goals.getGoal(goal.id)?.reviewCycle, 0);

        const gatesGet = await client.request<{
          goal: GoalRecord;
          activeVerification: GoalActiveVerification | null;
          verificationNote?: string;
        }>("goal.get", { goalId: goal.id });
        assert.ok(gatesGet.activeVerification, "goal.get must expose activeVerification in gates phase");
        assert.equal(gatesGet.activeVerification.kind, "review");
        assert.equal(gatesGet.activeVerification.phase, "gates");
        assert.equal(gatesGet.activeVerification.cycle, 1);
        assert.equal(gatesGet.activeVerification.reviewerTaskId, null);
        assert.equal(gatesGet.activeVerification.stale, false);
        assert.equal(gatesGet.verificationNote, undefined);

        const gatesSnap = await client.request<WorkSnapshot>("work.snapshot", { repoRoot });
        const snapGatesGoal = gatesSnap.goals.find((e) => e.goal.id === goal.id);
        assert.ok(snapGatesGoal?.activeVerification, "work.snapshot goals[] must expose activeVerification in gates phase");
        assert.equal(snapGatesGoal.activeVerification.phase, "gates");
        assert.equal(snapGatesGoal.activeVerification.cycle, 1);
        assert.equal(snapGatesGoal.activeVerification.reviewerTaskId, null);

        // 2) Release gate -> reviewer phase at reviewCycle === 0.
        writeFileSync(releaseFile, "go\n", "utf8");
        await reviewerEntered.promise;
        await waitFor(
          () => daemon.director.getActiveVerification(goal.id)?.phase === "reviewer",
          5_000,
          "reviewer phase",
        );

        const revGet = await client.request<{
          goal: GoalRecord;
          activeVerification: GoalActiveVerification | null;
          verificationNote?: string;
        }>("goal.get", { goalId: goal.id });
        assert.ok(revGet.activeVerification, "goal.get must expose activeVerification in reviewer phase");
        assert.equal(revGet.activeVerification.phase, "reviewer");
        assert.equal(revGet.activeVerification.cycle, 1);
        assert.ok(revGet.activeVerification.reviewerTaskId?.startsWith("t-"));
        assert.equal(revGet.verificationNote, undefined);

        const revSnap = await client.request<WorkSnapshot>("work.snapshot", { repoRoot });
        const snapRevGoal = revSnap.goals.find((e) => e.goal.id === goal.id);
        assert.ok(snapRevGoal?.activeVerification, "work.snapshot goals[] must expose activeVerification in reviewer phase");
        assert.equal(snapRevGoal.activeVerification.phase, "reviewer");
        assert.equal(snapRevGoal.activeVerification.reviewerTaskId, revGet.activeVerification.reviewerTaskId);

        // 3) Finish review -> activeVerification clears to null, no verificationNote.
        releaseReviewer.resolve();
        await verifyPromise;

        const doneGet = await client.request<{
          goal: GoalRecord;
          activeVerification: GoalActiveVerification | null;
          verificationNote?: string;
        }>("goal.get", { goalId: goal.id });
        assert.equal(doneGet.goal.status, "achieved");
        assert.equal(doneGet.activeVerification, null);
        assert.equal(doneGet.verificationNote, undefined);
      } finally {
        writeFileSync(releaseFile, "cleanup\n", "utf8");
        releaseReviewer.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("b) run.resume and task.resume route through runtime admission and return queued when no goal slot is free", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdResumed = deferred<void>();

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, maxConcurrentGoals: 1, autoVerifyOnSettle: false },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            const gate = req.initialPrompt.includes("Goal A holds slot") ? holdA.promise : holdResumed.promise;
            await Promise.race([
              gate,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Goal A occupies the single goal slot.
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A holds slot",
          description: "Occupies maxConcurrentGoals=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");

        // Goal B is awaiting_human with a failed linked run (does NOT hold a slot).
        const runB = daemon.db.createRun({ goal: "Goal B failed run", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch B",
          objective: "Goal B",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchB.id, { status: "failed", summary: "Boom" });
        daemon.db.updateRunStatus(runB.id, "failed");
        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B awaiting human",
          description: "Resuming via run.resume must queue behind Goal A",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Failed");

        // run.resume RPC must route through runtime admission -> queued #1, orchB untouched.
        const resumeBRes = await client.request<{
          resumed: boolean;
          outcome: string;
          reason?: string;
          queuePosition?: number;
          goalId?: string;
          goalStatus?: string;
        }>("run.resume", { runId: runB.id, note: "Continue Goal B" });
        assert.equal(resumeBRes.resumed, false);
        assert.equal(resumeBRes.outcome, "queued");
        assert.equal(resumeBRes.reason, "queued_for_goal_slot");
        assert.equal(resumeBRes.queuePosition, 1);
        assert.equal(resumeBRes.goalId, goalB.id);
        assert.equal(resumeBRes.goalStatus, "awaiting_human");
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 1);
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "awaiting_human");

        // Goal C is awaiting_human with a failed worker task (does NOT hold a slot).
        const runC = daemon.db.createRun({ goal: "Goal C failed worker", repoRoot, baseBranch: "main", baseSha });
        const orchC = daemon.db.createTask({
          runId: runC.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch C",
          objective: "Goal C",
          profileId: "pi:local",
          model: "fixture",
        });
        const workerC = daemon.db.createTask({
          runId: runC.id,
          parentId: orchC.id,
          tier: 2,
          kind: "worker",
          title: "Worker C",
          objective: "Worker C",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchC.id, { status: "completed", summary: "Done" });
        daemon.db.updateTask(workerC.id, { status: "failed", summary: "Worker failed" });
        daemon.db.updateRunStatus(runC.id, "failed");
        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C awaiting human",
          description: "Resuming worker via task.resume must queue behind Goal B",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalC.id, runC.id);
        daemon.director.goals.setStatus(goalC.id, "awaiting_human", "Worker failed");

        // task.resume RPC must route through runtime admission -> already_queued #2, workerC untouched.
        const resumeCRes = await client.request<{
          resumed: boolean;
          outcome: string;
          queuePosition?: number;
          goalId?: string;
          goalStatus?: string;
        }>("task.resume", { taskId: workerC.id, note: "Retry worker C" });
        assert.equal(resumeCRes.resumed, false);
        assert.equal(resumeCRes.outcome, "already_queued");
        assert.equal(resumeCRes.queuePosition, 2);
        assert.equal(resumeCRes.goalId, goalC.id);
        assert.equal(resumeCRes.goalStatus, "awaiting_human");
        assert.equal(daemon.db.getTask(workerC.id)?.generation, 1);

        // Release Goal A and verify a free-slot run.resume on an awaiting_human completed-T1 goal resumes & syncs goal.status.
        daemon.db.admissionQueue.remove("goal", goalB.id);
        daemon.db.admissionQueue.remove("goal", goalC.id);
        holdA.resolve();
        await waitFor(
          () => daemon.orchestrator.getEffectiveRun(commitA.goal.linkedRunId!)?.status === "completed",
          5_000,
          "Goal A run settles",
        );
        daemon.director.goals.setStatus(goalA.id, "achieved", "Done");

        const runD = daemon.db.createRun({ goal: "Goal D completed T1", repoRoot, baseBranch: "main", baseSha });
        const orchD = daemon.db.createTask({
          runId: runD.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch D",
          objective: "Goal D",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchD.id, { status: "completed", summary: "Handed to human" });
        daemon.db.updateRunStatus(runD.id, "completed");
        const goalD = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal D completed T1 awaiting human",
          description: "run.resume revives completed T1 and flips goal to executing",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalD.id, runD.id);
        daemon.director.goals.setStatus(goalD.id, "awaiting_human", "Needs follow-up");

        const resumeDRes = await client.request<{
          resumed: boolean;
          outcome: string;
          resumedTaskIds: string[];
          goalId?: string;
          goalStatus?: string;
        }>("run.resume", { runId: runD.id, note: "Continue completed T1" });
        assert.equal(resumeDRes.resumed, true);
        assert.equal(resumeDRes.outcome, "resumed");
        assert.deepEqual(resumeDRes.resumedTaskIds, [orchD.id]);
        assert.equal(resumeDRes.goalId, goalD.id);
        assert.equal(resumeDRes.goalStatus, "executing");
        assert.equal(daemon.director.goals.getGoal(goalD.id)?.status, "executing");
        assert.equal(daemon.db.getTask(orchD.id)?.generation, 2);
      } finally {
        holdA.resolve();
        holdResumed.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("c) goal.amend accepts maxReviewCycles/maxNoProgressCycles and routes budget-only amends through amendGoalBudgets", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdOrch = deferred<void>();

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            await Promise.race([
              holdOrch.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Budget amend over RPC", repoRoot, baseBranch: "main", baseSha });
        const orch = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch",
          objective: "Work",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orch.id, { status: "completed", summary: "Initial pass done" });
        daemon.db.updateRunStatus(run.id, "completed");

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Budget amend RPC goal",
          description: "Raise maxReviewCycles 2 -> 3 without version bump",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          budgets: { maxReviewCycles: 2, maxNoProgressCycles: 2 },
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        // Two distinct changes_requested verdicts exhaust maxReviewCycles=2 -> awaiting_human.
        daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "cycle 1 issue" }],
          summary: "Fix issue 1",
          blockingIssues: ["Fix issue 1"],
          diffHash: "diff-1",
        });
        const v2 = daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "cycle 2 issue" }],
          summary: "Fix issue 2",
          blockingIssues: ["Fix issue 2"],
          diffHash: "diff-2",
        });
        assert.equal(v2.goal.status, "awaiting_human");
        assert.equal(v2.goal.reviewCycle, 2);

        const maxCyclesEsc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: orch.id,
          toTaskId: null,
          severity: "P0",
          category: "verification_failed",
          title: "Max review cycles reached (2/2)",
          evidencePaths: [repoRoot],
          blocking: true,
        });

        // 1) Budget-only goal.amend RPC: maxReviewCycles 2 -> 3.
        const budgetRes = await client.request<{
          goal: GoalRecord;
          budgetsBefore: GoalBudgets;
          budgetsAfter: GoalBudgets;
          resolvedEscalationIds: string[];
          continuation: { action: string; message: string; queuePosition?: number };
        }>("goal.amend", {
          goalId: goal.id,
          rationale: "Allow one more review cycle",
          maxReviewCycles: 3,
        });

        assert.equal(budgetRes.goal.version, 1, "budget-only amend must not bump version");
        assert.equal(budgetRes.goal.reviewCycle, 2, "budget-only amend must not reset reviewCycle");
        assert.equal(budgetRes.budgetsBefore.maxReviewCycles, 2);
        assert.equal(budgetRes.budgetsAfter.maxReviewCycles, 3);
        assert.equal(budgetRes.goal.budgets.maxReviewCycles, 3);
        assert.deepEqual(budgetRes.resolvedEscalationIds, [maxCyclesEsc.id]);
        assert.equal(budgetRes.continuation.action, "resumed");
        assert.equal(budgetRes.goal.status, "executing");

        const escAfter = daemon.db.getEscalation(maxCyclesEsc.id)!;
        assert.equal(escAfter.status, "resolved");
        assert.ok(escAfter.resolution?.includes("max_review_cycles 2 -> 3"));
        assert.ok(escAfter.resolution?.includes("Allow one more review cycle"));
        assert.equal(daemon.db.getTask(orch.id)?.generation, 2);

        // 2) Combined budget + content goal.amend RPC updates budgets AND bumps version via amendGoal.
        const combinedRes = await client.request<{
          goal: GoalRecord;
          delta: { fromVersion: number; toVersion: number };
          budgetsBefore?: GoalBudgets;
          budgetsAfter?: GoalBudgets;
        }>("goal.amend", {
          goalId: goal.id,
          rationale: "Raise no-progress limit and add criterion",
          maxNoProgressCycles: 4,
          addCriteria: [{ id: "c2", description: "Added criterion", kind: "behavioral", required: true }],
        });
        assert.equal(combinedRes.delta.fromVersion, 1);
        assert.equal(combinedRes.delta.toVersion, 2);
        assert.equal(combinedRes.goal.version, 2);
        assert.equal(combinedRes.budgetsBefore?.maxNoProgressCycles, 2);
        assert.equal(combinedRes.budgetsAfter?.maxNoProgressCycles, 4);
        assert.equal(combinedRes.goal.budgets.maxNoProgressCycles, 4);
      } finally {
        holdOrch.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
