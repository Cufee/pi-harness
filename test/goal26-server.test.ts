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

  it("d) P1-2: quota recovery (auto_timer, quota_recovered, run.schedule_resume user_timer) queues non-slot-holders under maxConcurrentGoals=1 while slot-holders keep the fast path", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdResumed = deferred<void>();
    const launchedTaskIds: string[] = [];

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
            launchedTaskIds.push(req.taskId);
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
        const activeGoalCount = () =>
          daemon.director.goals
            .listGoals({ repoRoot })
            .filter((g) => g.status === "executing" || g.status === "verifying" || g.status === "reviewing").length;

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
        const runAId = commitA.goal.linkedRunId!;
        const orchA = daemon.db.listTasks(runAId).find((t) => t.tier === 1)!;

        // Add a paused_quota worker to the executing slot-holder Goal A: quota recovery must keep the fast path.
        const workerA = daemon.db.createTask({
          runId: runAId,
          parentId: orchA.id,
          tier: 2,
          kind: "worker",
          title: "Slot-holder quota worker",
          objective: "Resume on fast path",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(workerA.id, { status: "paused_quota", summary: "Quota limit" });
        const fastRes = await daemon.orchestrator.resumeRunFromQuota(runAId, { trigger: "quota_recovered" });
        assert.equal(fastRes.resumed, true);
        assert.deepEqual(fastRes.resumedTaskIds, [workerA.id]);
        assert.equal(activeGoalCount(), 1);

        const makePausedQuotaGoal = (label: string) => {
          const run = daemon.db.createRun({ goal: label, repoRoot, baseBranch: "main", baseSha });
          const orch = daemon.db.createTask({
            runId: run.id,
            parentId: null,
            tier: 1,
            kind: "orchestrator",
            title: `${label} orch`,
            objective: label,
            profileId: "pi:local",
            model: "fixture",
          });
          const worker = daemon.db.createTask({
            runId: run.id,
            parentId: orch.id,
            tier: 2,
            kind: "worker",
            title: `${label} worker`,
            objective: label,
            profileId: "pi:local",
            model: "fixture",
            readOnly: true,
          });
          daemon.db.updateTask(orch.id, { status: "completed", summary: "Handed off" });
          daemon.db.updateTask(worker.id, { status: "paused_quota", summary: "429 quota" });
          daemon.db.updateRunStatus(run.id, "paused_quota", "Quota exhausted");
          const goal = daemon.director.goals.createGoal({
            chatSessionId: chat.id,
            repoRoot,
            title: label,
            description: `Non-slot-holder quota goal: ${label}`,
            criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          });
          daemon.director.goals.linkRunAndStart(goal.id, run.id);
          daemon.director.goals.setStatus(goal.id, "awaiting_human", "Paused on quota");
          return { goal, run, worker };
        };

        // 1) auto_timer on non-slot-holder queues behind Goal A and never yields 2 active goals.
        const gAuto = makePausedQuotaGoal("Goal AutoTimer");
        const autoRes = await daemon.orchestrator.resumeRunFromQuota(gAuto.run.id, { trigger: "auto_timer" });
        assert.equal(autoRes.resumed, false);
        assert.deepEqual(autoRes.resumedTaskIds, []);
        assert.equal(activeGoalCount(), 1, "auto_timer must not exceed maxConcurrentGoals=1");
        assert.equal(daemon.director.goals.getGoal(gAuto.goal.id)?.status, "awaiting_human");
        assert.equal(daemon.db.getTask(gAuto.worker.id)?.status, "paused_quota");
        assert.equal(daemon.db.admissionQueue.get("goal", gAuto.goal.id)?.position, 1);

        // 2) quota_recovered on non-slot-holder queues behind Goal AutoTimer.
        const gRecovered = makePausedQuotaGoal("Goal QuotaRecovered");
        const recRes = await daemon.orchestrator.resumeRunFromQuota(gRecovered.run.id, { trigger: "quota_recovered" });
        assert.equal(recRes.resumed, false);
        assert.deepEqual(recRes.resumedTaskIds, []);
        assert.equal(activeGoalCount(), 1, "quota_recovered must not exceed maxConcurrentGoals=1");
        assert.equal(daemon.director.goals.getGoal(gRecovered.goal.id)?.status, "awaiting_human");
        assert.equal(daemon.db.getTask(gRecovered.worker.id)?.status, "paused_quota");
        assert.equal(daemon.db.admissionQueue.get("goal", gRecovered.goal.id)?.position, 2);

        // 3) user_timer via run.schedule_resume RPC queues behind Goal QuotaRecovered and disarms quota state/timers.
        const gUser = makePausedQuotaGoal("Goal UserTimer");
        await client.request("run.schedule_resume", { runId: gUser.run.id, delayMs: 1_000 });
        assert.ok(daemon.orchestrator.getRunQuotaStatus(gUser.run.id), "quota status should be armed before timer fires");
        await waitFor(
          () => daemon.db.admissionQueue.get("goal", gUser.goal.id) !== null,
          4_000,
          "user_timer queues Goal UserTimer",
        );
        await waitFor(
          () => daemon.orchestrator.getRunQuotaStatus(gUser.run.id) === null,
          2_000,
          "user_timer disarms quota timers/state once queued",
        );
        assert.equal(activeGoalCount(), 1, "user_timer must not exceed maxConcurrentGoals=1");
        assert.equal(daemon.director.goals.getGoal(gUser.goal.id)?.status, "awaiting_human");
        assert.equal(daemon.db.getTask(gUser.worker.id)?.status, "paused_quota");
        assert.equal(daemon.db.admissionQueue.get("goal", gUser.goal.id)?.position, 3);

        // 4) Freeing Goal A's slot drains the queue and resumes Goal AutoTimer's paused_quota worker.
        daemon.db.admissionQueue.remove("goal", gRecovered.goal.id);
        daemon.db.admissionQueue.remove("goal", gUser.goal.id);
        await client.request("run.stop", { runId: runAId, reason: "Free slot for queued quota goal" });
        await waitFor(
          () => daemon.director.goals.getGoal(gAuto.goal.id)?.status === "executing",
          5_000,
          "drainGoalQueue admits queued quota goal",
        );
        assert.equal(activeGoalCount(), 1);
        await waitFor(() => launchedTaskIds.includes(gAuto.worker.id), 5_000, "queued paused_quota worker launches");
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

  it("e) P1-1: run.stop synchronously drops a queued run.resume on an awaiting_human goal and freeing the slot does not restart it", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdOther = deferred<void>();

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
            const gate = req.initialPrompt.includes("Goal A holds slot") ? holdA.promise : holdOther.promise;
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

        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A holds slot",
          description: "Occupies maxConcurrentGoals=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;

        // Goal B: awaiting_human with failed run, queued via run.resume.
        const runB = daemon.db.createRun({ goal: "Goal B queued then stopped", repoRoot, baseBranch: "main", baseSha });
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
          description: "Queued resume invalidated by run.stop",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Failed");

        const resumeBRes = await client.request<{ outcome: string; queuePosition?: number }>("run.resume", {
          runId: runB.id,
          note: "Queue Goal B",
        });
        assert.equal(resumeBRes.outcome, "queued");
        assert.equal(resumeBRes.queuePosition, 1);
        assert.ok(daemon.db.admissionQueue.get("goal", goalB.id));

        // Observe whether run.stop removes the queue entry synchronously BEFORE orchestrator.stopRun runs.
        let queueEntryAtStopRunEntry: unknown = "not-called";
        const origStopRun = daemon.orchestrator.stopRun.bind(daemon.orchestrator);
        daemon.orchestrator.stopRun = async (id, reason) => {
          if (id === runB.id) {
            queueEntryAtStopRunEntry = daemon.db.admissionQueue.get("goal", goalB.id);
          }
          return origStopRun(id, reason);
        };

        const stopBRes = await client.request<{ stopped: boolean }>("run.stop", {
          runId: runB.id,
          reason: "Cancel queued resume",
        });
        assert.equal(stopBRes.stopped, true);
        assert.equal(queueEntryAtStopRunEntry, null, "run.stop must invalidate queued resume synchronously before stopRun");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null);

        // Free Goal A's slot and confirm Goal B does NOT restart.
        await client.request("run.stop", { runId: runAId, reason: "Free slot" });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 1);
        assert.equal(daemon.db.getRun(runB.id)?.status, "stopped");
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "awaiting_human");
      } finally {
        holdA.resolve();
        holdOther.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("f) P1-1: task.cancel drops a queued task.resume for a failed task", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdOther = deferred<void>();

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
            const gate = req.initialPrompt.includes("Goal A holds slot") ? holdA.promise : holdOther.promise;
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

        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A holds slot",
          description: "Occupies maxConcurrentGoals=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;

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
          objective: "Failed worker",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchC.id, { status: "completed", summary: "Done" });
        daemon.db.updateTask(workerC.id, { status: "failed", summary: "Worker crashed" });
        daemon.db.updateRunStatus(runC.id, "failed");
        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C awaiting human",
          description: "Queued task.resume invalidated by task.cancel",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalC.id, runC.id);
        daemon.director.goals.setStatus(goalC.id, "awaiting_human", "Worker failed");

        const resumeCRes = await client.request<{ resumed: boolean; outcome: string; queuePosition?: number }>(
          "task.resume",
          { taskId: workerC.id, note: "Retry worker C" },
        );
        assert.equal(resumeCRes.resumed, false);
        assert.equal(resumeCRes.queuePosition, 1);
        assert.ok(daemon.db.admissionQueue.get("goal", goalC.id));

        const cancelRes = await client.request<{ cancelled: boolean }>("task.cancel", {
          taskId: workerC.id,
          reason: "Do not retry worker C",
        });
        assert.equal(cancelRes.cancelled, true);
        assert.equal(daemon.db.admissionQueue.get("goal", goalC.id), null, "task.cancel must drop queued task.resume");

        // Free Goal A's slot and confirm Goal C / workerC does NOT restart.
        await client.request("run.stop", { runId: runAId, reason: "Free slot" });
        await new Promise((r) => setTimeout(r, 150));
        assert.equal(daemon.db.getTask(workerC.id)?.generation, 1);
        assert.equal(daemon.director.goals.getGoal(goalC.id)?.status, "awaiting_human");
      } finally {
        holdA.resolve();
        holdOther.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("g) P2-1 & P2-2: mixed budget + rejected-content goal.amend RPC leaves budgets unchanged, and unchanged budget returns continuation.action === 'none'", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");

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
          run: async () => ({ text: "done", stopReason: "completed" }),
        }),
      });

      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Atomic amend RPC", repoRoot, baseBranch: "main", baseSha });
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
        daemon.db.updateTask(orch.id, { status: "completed", summary: "Done" });
        daemon.db.updateRunStatus(run.id, "completed");

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Atomic budget amend RPC goal",
          description: "A long original description that must not be silently replaced by a shorter string without confirmation.",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          budgets: { maxReviewCycles: 4, maxNoProgressCycles: 2 },
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);
        daemon.director.goals.setStatus(goal.id, "awaiting_human", "Waiting on unrelated human decision");

        // (d) Mixed budget + rejected shorter description must fail atomically with budgets unchanged.
        await assert.rejects(
          client.request("goal.amend", {
            goalId: goal.id,
            rationale: "Raise budget with guarded short description",
            maxReviewCycles: 17,
            description: "too short",
          }),
          /Refusing to replace goal/,
        );
        const afterRejected = daemon.director.goals.getGoal(goal.id)!;
        assert.equal(afterRejected.budgets.maxReviewCycles, 4, "rejected mixed amend must leave budgets unchanged");
        assert.equal(afterRejected.version, 1);

        // (e) Budget-only goal.amend with an unchanged budget returns continuation.action === "none".
        const noopRes = await client.request<{
          goal: GoalRecord;
          budgetsBefore: GoalBudgets;
          budgetsAfter: GoalBudgets;
          continuation: { action: string; message: string };
        }>("goal.amend", {
          goalId: goal.id,
          rationale: "No-op budget update",
          maxReviewCycles: 4,
        });
        assert.equal(noopRes.budgetsBefore.maxReviewCycles, 4);
        assert.equal(noopRes.budgetsAfter.maxReviewCycles, 4);
        assert.equal(noopRes.continuation.action, "none");
        assert.equal(daemon.db.admissionQueue.get("goal", goal.id), null);
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "awaiting_human");
      } finally {
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("h) C3 P1-b: fresh run.resume queued after run.stop is honored when slot opens (while pre-stop intent stays dropped)", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const orchBStarted = deferred<void>();

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
            if (req.initialPrompt.includes("Goal A holds slot")) {
              await Promise.race([
                holdA.promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "done A", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            orchBStarted.resolve();
            await Promise.race([
              holdB.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "done B", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A holds slot",
          description: "Occupies maxConcurrentGoals=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;

        // Goal B: awaiting_human with failed run.
        const runB = daemon.db.createRun({ goal: "Goal B stop then re-resume", repoRoot, baseBranch: "main", baseSha });
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
          description: "Stopped then explicitly resumed while cap=1 is full",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Failed");

        // 1) Queue B, then run.stop B (drops pre-stop intent).
        const firstResume = await client.request<{ outcome: string; queuePosition?: number }>("run.resume", {
          runId: runB.id,
          note: "Pre-stop resume",
        });
        assert.equal(firstResume.outcome, "queued");
        assert.equal(firstResume.queuePosition, 1);

        const stopB = await client.request<{ stopped: boolean }>("run.stop", {
          runId: runB.id,
          reason: "Stop before fresh resume",
        });
        assert.equal(stopB.stopped, true);
        assert.equal(daemon.db.getRun(runB.id)?.status, "stopped");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null);

        // 2) Issue a NEW explicit run.resume B AFTER run.stop B returns, while A still holds the slot.
        const secondResume = await client.request<{ outcome: string; queuePosition?: number }>("run.resume", {
          runId: runB.id,
          note: "Fresh post-stop resume",
        });
        assert.equal(secondResume.outcome, "queued");
        assert.equal(secondResume.queuePosition, 1);
        assert.ok(daemon.db.admissionQueue.get("goal", goalB.id));

        // 3) Free Goal A's slot -> drain MUST honor the post-stop explicit resume!
        await client.request("run.stop", { runId: runAId, reason: "Free slot for post-stop resume" });
        await waitFor(
          () => daemon.director.goals.getGoal(goalB.id)?.status === "executing",
          3_000,
          "drain honors fresh post-stop run.resume",
        );
        await orchBStarted.promise;
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 2, "Tier 1 must resume to generation 2");
        assert.equal(daemon.orchestrator.getEffectiveRun(runB.id)?.status, "active");
      } finally {
        holdA.resolve();
        holdB.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("i) C3 P1-c: queued quota recovery drops without restarting an unrelated failed Tier 1 after the only paused_quota worker is cancelled", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdOther = deferred<void>();
    const launchedTaskIds: string[] = [];

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
            launchedTaskIds.push(req.taskId);
            const gate = req.initialPrompt.includes("Goal A holds slot") ? holdA.promise : holdOther.promise;
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

        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A holds slot",
          description: "Occupies maxConcurrentGoals=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;

        // Goal B: awaiting_human with FAILED Tier 1 and one paused_quota worker.
        const runB = daemon.db.createRun({ goal: "Goal B failed T1 + quota worker", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch B failed",
          objective: "Goal B",
          profileId: "pi:local",
          model: "fixture",
        });
        const workerB = daemon.db.createTask({
          runId: runB.id,
          parentId: orchB.id,
          tier: 2,
          kind: "worker",
          title: "Worker B paused_quota",
          objective: "Subtask B",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchB.id, { status: "failed", summary: "Prior unrelated failure" });
        daemon.db.updateTask(workerB.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runB.id, "paused_quota", "Quota exhausted");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B quota recovery with failed T1",
          description: "Cancelling the only paused worker must drop queued quota recovery without retrying failed T1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Paused on quota");

        // 1) Queue B via quota recovery while A holds the slot.
        const autoRes = await daemon.orchestrator.resumeRunFromQuota(runB.id, { trigger: "auto_timer" });
        assert.equal(autoRes.resumed, false);
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id)?.position, 1);

        // 2) Cancel B's only paused_quota worker via task.cancel RPC.
        const cancelRes = await client.request<{ cancelled: boolean }>("task.cancel", {
          taskId: workerB.id,
          reason: "No longer needed",
        });
        assert.equal(cancelRes.cancelled, true);
        assert.equal(daemon.db.getTask(workerB.id)?.status, "cancelled");

        // 3) Free Goal A's slot -> drain MUST drop the empty quota-recovery entry without starting failed T1!
        await client.request("run.stop", { runId: runAId, reason: "Free slot" });
        await new Promise((r) => setTimeout(r, 200));

        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null, "empty quota-recovery intent must be dropped");
        assert.equal(daemon.db.getTask(workerB.id)?.status, "cancelled");
        assert.equal(daemon.db.getTask(orchB.id)?.status, "failed", "unrelated failed Tier 1 must NOT be restarted");
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 1, "unrelated failed Tier 1 must stay generation 1");
        assert.equal(launchedTaskIds.includes(orchB.id), false, "failed Tier 1 must never launch");
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "awaiting_human");
      } finally {
        holdA.resolve();
        holdOther.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("j) C4 P1-1: successive content amendments on a queued post-stop resume refresh to latest contract without losing queue position or tripping stop guard", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-srv-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const holdC = deferred<void>();
    const orchBStarted = deferred<string>();

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
            if (req.initialPrompt.includes("Goal B post-stop amend")) {
              orchBStarted.resolve(req.initialPrompt);
            }
            const gate = req.initialPrompt.includes("Goal A holds slot")
              ? holdA.promise
              : req.initialPrompt.includes("Goal B post-stop amend")
                ? holdB.promise
                : holdC.promise;
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

        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A holds slot",
          description: "Occupies maxConcurrentGoals=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;

        // Goal B: linked run with failed Tier 1 gen 1.
        const runB = daemon.db.createRun({ goal: "Goal B post-stop amend", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch B",
          objective: "Goal B post-stop amend",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchB.id, { status: "failed", summary: "Initial failure" });
        daemon.db.updateRunStatus(runB.id, "failed", "Initial failure");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B post-stop amend",
          description: "Base v1 description",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Failed");

        // 1) Stop B, then explicitly resume B -> queued at #1.
        const stopB = await client.request<{ stopped: boolean }>("run.stop", {
          runId: runB.id,
          reason: "Stop before fresh resume",
        });
        assert.equal(stopB.stopped, true);
        assert.equal(daemon.db.getRun(runB.id)?.status, "stopped");

        const resumeB = await client.request<{ outcome: string; queuePosition?: number }>("run.resume", {
          runId: runB.id,
          note: "Fresh post-stop resume",
        });
        assert.equal(resumeB.outcome, "queued");
        assert.equal(resumeB.queuePosition, 1);

        // Queue Goal C behind B at #2 to prove B keeps its #1 position across amendment refreshes.
        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C queued behind B",
          description: "Should stay at #2 while B refreshes",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitC = await daemon.director.commitGoalDetailed(goalC.id);
        assert.equal(commitC.outcome, "queued");
        assert.equal(commitC.queuePosition, 2);

        // 2) Two successive content amendments to B in separate milliseconds.
        await new Promise((r) => setTimeout(r, 5));
        const amendV2 = await daemon.director.amendGoal(goalB.id, {
          rationale: "First queued amendment",
          appendDescription: "Extra requirement v2",
        });
        assert.equal(amendV2.goal.version, 2);
        assert.equal(amendV2.delivery.reason, "queued for a goal slot");

        await new Promise((r) => setTimeout(r, 5));
        const amendV3 = await daemon.director.amendGoal(goalB.id, {
          rationale: "Second queued amendment",
          appendDescription: "Final requirement v3",
        });
        assert.equal(amendV3.goal.version, 3);
        assert.equal(amendV3.delivery.reason, "queued for a goal slot");

        // Queue entry for B must stay at #1 (ahead of C) and point at goal_contract_v3.
        const qEntryB = daemon.db.admissionQueue.get("goal", goalB.id);
        const qEntryC = daemon.db.admissionQueue.get("goal", goalC.id);
        assert.ok(qEntryB, "B must remain queued after successive amendments");
        assert.equal(qEntryB.position, 1, "B must keep queue position #1 without moving behind C");
        assert.equal(qEntryC?.position, 2, "C must remain at queue position #2");
        const persistedNote = ((qEntryB.launchOpts as { resume?: { note?: string } } | null)?.resume?.note ?? "");
        assert.match(persistedNote, /goal_contract_v3/, "persisted queue note must point to latest goal_contract_v3");

        // 3) Stop A -> drain must resume B at gen 2 with the v3 amendment.
        await client.request("run.stop", { runId: runAId, reason: "Free slot for amended post-stop resume" });
        await waitFor(
          () => daemon.director.goals.getGoal(goalB.id)?.status === "executing",
          3_000,
          "drain resumes amended post-stop goal B",
        );
        const launchedPrompt = await orchBStarted.promise;
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 2, "Tier 1 must resume to generation 2");
        assert.equal(daemon.db.getTask(orchB.id)?.goalVersion, 3, "Tier 1 must bind goalVersion=3 on resume");
        assert.equal(daemon.orchestrator.getEffectiveRun(runB.id)?.status, "active");
        assert.match(launchedPrompt, /goal_contract_v3/, "gen-2 Tier 1 prompt must carry latest v3 amendment");
        assert.match(launchedPrompt, /Final requirement v3/, "gen-2 Tier 1 prompt must carry v3 content");
      } finally {
        holdA.resolve();
        holdB.resolve();
        holdC.resolve();
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
