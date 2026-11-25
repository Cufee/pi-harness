import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { GoalActiveVerification } from "../src/director/goal-get.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-g26-"));
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

describe("goal-26 lifecycle (runtime wiring)", () => {
  it("1. resume_run continues an awaiting_human goal whose Tier 1 completed (and variant with blocked writable worker)", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-state-"));
    const sockPath = join(stateDir, "d.sock");
    let holdOrch = deferred<void>();

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
            if (req.kind === "orchestrator") {
              await Promise.race([
                holdOrch.promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Awaiting human completed T1", repoRoot, baseBranch: "main", baseSha });
        const orch = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1",
          objective: "Work on feature",
          profileId: "pi:local",
          model: "fixture",
        });
        const marker = "NEXT_ACTION_MARKER_GOAL26_T1";
        daemon.db.updateTask(orch.id, {
          status: "completed",
          summary: "Finished initial pass",
          handoffJson: JSON.stringify({
            goalInvariants: ["keep invariants"],
            architecturalDecisions: [],
            activeRisks: [],
            nextActions: [marker],
          }),
        });
        daemon.db.updateRunStatus(run.id, "completed");

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Completed T1 awaiting human",
          description: "Resume should revive completed T1 with anchored handoff",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);
        daemon.director.goals.setStatus(goal.id, "awaiting_human", "Handed off for human review");
        const esc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: orch.id,
          toTaskId: null,
          severity: "P0",
          category: "verification_failed",
          title: `Goal ${goal.id} needs human review`,
          evidencePaths: [repoRoot],
          blocking: true,
        });

        const runsBefore = daemon.db.listRuns(100).length;

        // Deliberate goal_commit behavior: completed + awaiting_human returns already_completed.
        const commitRes = await daemon.director.commitGoalDetailed(goal.id);
        assert.equal(commitRes.outcome, "already_completed");
        assert.equal(daemon.db.getTask(orch.id)?.generation, 1);

        // Explicit resume_run via Director MCP tool revives the completed Tier 1 in place.
        const resumeRes = (await daemon.director.executeDirectorMcpTool(chat.id, "resume_run", {
          goal_id: goal.id,
          note: "Please address the reviewer feedback",
        })) as {
          resumed: boolean;
          outcome: string;
          resumedTaskIds: string[];
          run: { id: string; status: string };
          goalId?: string;
          goalStatus?: string;
        };
        assert.equal(resumeRes.outcome, "resumed");
        assert.equal(resumeRes.resumed, true);
        assert.deepEqual(resumeRes.resumedTaskIds, [orch.id]);
        assert.equal(resumeRes.run.id, run.id);
        assert.equal(resumeRes.goalId, goal.id);
        assert.equal(resumeRes.goalStatus, "executing");

        const orchAfter = daemon.db.getTask(orch.id)!;
        assert.equal(orchAfter.generation, 2);
        assert.ok(["ready", "running"].includes(orchAfter.status), `expected ready/running, got ${orchAfter.status}`);
        assert.ok(orchAfter.handoffJson?.includes(marker), "preserved nextActions marker must remain in handoffJson");
        assert.ok(
          orchAfter.handoffJson?.includes("orchestrator had completed and its goal was handed to a human"),
          "resume header must be prepended in handoffJson",
        );
        assert.equal(daemon.orchestrator.getEffectiveRun(run.id)?.status, "active");
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "executing");
        assert.equal(daemon.db.listRuns(100).length, runsBefore, "must not create a duplicate run");
        assert.equal(daemon.db.getEscalation(esc.id)?.status, "open", "open escalation must remain open");

        holdOrch.resolve();
        await waitFor(() => daemon.db.getTask(orch.id)?.status === "completed", 5_000, "orch gen 2 completes");

        // Variant: completed orch + blocked writable worker -> run derives "failed".
        holdOrch = deferred<void>();
        const run2 = daemon.db.createRun({ goal: "Completed T1 + blocked worker", repoRoot, baseBranch: "main", baseSha });
        const orch2 = daemon.db.createTask({
          runId: run2.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1-2",
          objective: "Work 2",
          profileId: "pi:local",
          model: "fixture",
        });
        const blockedWorker = daemon.db.createTask({
          runId: run2.id,
          parentId: orch2.id,
          tier: 2,
          kind: "worker",
          title: "Blocked worker",
          objective: "Write file",
          profileId: "pi:local",
          model: "fixture",
          readOnly: false,
        });
        daemon.db.updateTask(orch2.id, { status: "completed", summary: "Orch done" });
        daemon.db.updateTask(blockedWorker.id, { status: "blocked", summary: "Waiting on decision" });
        daemon.db.updateRunStatus(run2.id, "failed");

        const goal2 = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Completed T1 with blocked worker",
          description: "Run derives failed while T1 is completed",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goal2.id, run2.id);
        daemon.director.goals.setStatus(goal2.id, "awaiting_human", "Blocked worker");

        assert.equal(daemon.orchestrator.getEffectiveRun(run2.id)?.status, "failed");

        const resume2 = (await daemon.director.executeDirectorMcpTool(chat.id, "resume_run", {
          goal_id: goal2.id,
        })) as { outcome: string; resumedTaskIds: string[]; message: string };
        assert.equal(resume2.outcome, "resumed");
        assert.deepEqual(resume2.resumedTaskIds, [orch2.id]);
        assert.equal(daemon.db.getTask(blockedWorker.id)?.status, "blocked", "blocked worker must remain untouched");
        assert.equal(daemon.db.getTask(blockedWorker.id)?.generation, 1);
        const orch2After = daemon.db.getTask(orch2.id)!;
        assert.equal(orch2After.generation, 2);
        assert.ok(
          orch2After.handoffJson?.includes(blockedWorker.id),
          `blocked worker ${blockedWorker.id} must be named in resumed orchestrator handoff`,
        );
        assert.equal(daemon.director.goals.getGoal(goal2.id)?.status, "executing");
        holdOrch.resolve();
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("2. goal status follows a paused_quota resume across resumeRunDetailed, quota_recovered event hook, and user timer", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-state-"));
    const sockPath = join(stateDir, "d.sock");
    let holdWorker = deferred<void>();

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
              holdWorker.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            if (req.signal.aborted) return { text: "cancelled", stopReason: "cancelled" };
            if (req.tier >= 2) {
              await req.executeTool("return_task", { status: "completed", summary: "worker finished" });
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Quota resume sync", repoRoot, baseBranch: "main", baseSha });
        const orch = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1",
          objective: "Quota test",
          profileId: "pi:local",
          model: "fixture",
        });
        const worker = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 2,
          kind: "worker",
          title: "Paused worker",
          objective: "Work",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Quota paused goal",
          description: "Goal follows quota resume",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const parkAsPausedQuota = (goalStatus: "awaiting_human" | "paused") => {
          daemon.db.updateTask(orch.id, { status: "completed", summary: "Orch idle" });
          daemon.db.updateTask(worker.id, { status: "paused_quota", summary: "Quota exhausted" });
          daemon.db.updateRunStatus(run.id, "paused_quota");
          daemon.director.goals.setStatus(goal.id, goalStatus, "Quota paused");
        };

        // (a) resumeRunDetailed on awaiting_human + paused_quota -> goal becomes executing.
        parkAsPausedQuota("awaiting_human");
        const r1 = await daemon.director.resumeRunDetailed(run.id, { trigger: "manual" });
        assert.equal(r1.outcome, "resumed");
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "executing");

        // Stop worker cleanly before resetting for (b).
        holdWorker.resolve();
        await waitFor(() => daemon.db.getTask(worker.id)?.status === "completed", 5_000, "worker completes (a)");

        // (b) Direct orchestrator.resumeRunFromQuota(trigger: quota_recovered) -> event hook syncs goal to executing.
        holdWorker = deferred<void>();
        parkAsPausedQuota("awaiting_human");
        const r2 = await daemon.orchestrator.resumeRunFromQuota(run.id, { trigger: "quota_recovered" });
        assert.equal(r2.resumed, true);
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "executing");
        // Verify microtask syncQueuedGoalProgress does not corrupt run status.
        await new Promise((r) => setTimeout(r, 40));
        assert.equal(daemon.orchestrator.getEffectiveRun(run.id)?.status, "active");
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "executing");

        holdWorker.resolve();
        await waitFor(() => daemon.db.getTask(worker.id)?.status === "completed", 5_000, "worker completes (b)");

        // (c) Chat timer with resumeGoal on a paused goal with paused_quota linked run -> executing via commitGoalDetailed.
        holdWorker = deferred<void>();
        parkAsPausedQuota("paused");
        const timer = daemon.db.timers.schedule({
          ownerKind: "chat",
          ownerId: chat.id,
          goalId: goal.id,
          runId: run.id,
          delaySeconds: 0.05,
          reason: "Quota reset timer",
          resumeGoal: true,
        });
        assert.equal(timer.status, "pending");
        await waitFor(() => daemon.director.goals.getGoal(goal.id)?.status === "executing", 5_000, "timer resumes paused goal");
        assert.equal(daemon.orchestrator.getEffectiveRun(run.id)?.status, "active");
        holdWorker.resolve();
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("3. verifying wedge: activeVerification is visible in gates & reviewer phases, and epoch bump during verification unwinds cleanly so the next settlement triggers verification", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-state-"));
    const sockPath = join(stateDir, "d.sock");
    const releaseFile = join(repoRoot, ".release-gate");
    const holdWorker = deferred<void>();
    const reviewerEntered = deferred<void>();
    const releaseReviewer = deferred<void>();
    let reviewerCalls = 0;

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: true },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind === "verify") {
              reviewerCalls += 1;
              reviewerEntered.resolve();
              await Promise.race([
                releaseReviewer.promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              if (req.signal.aborted) return { text: "aborted", stopReason: "cancelled" };
              await req.executeTool("submit_review_verdict", {
                verdict: "approved",
                criteriaResults: [
                  { criterionId: "c1", passed: true, evidence: "gate passed" },
                  { criterionId: "c2", passed: true, evidence: "behavior verified" },
                ],
                blockingIssues: [],
                summary: "Approved after restart",
              });
              return { text: "approved", stopReason: "completed" };
            }
            // Worker / orchestrator execution
            await Promise.race([
              holdWorker.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            if (req.signal.aborted) return { text: "cancelled", stopReason: "cancelled" };
            if (req.tier >= 2) {
              await req.executeTool("return_task", { status: "completed", summary: "worker finished" });
            }
            return { text: "worker done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Verifying wedge test", repoRoot, baseBranch: "main", baseSha });
        const orch = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1",
          objective: "Coordinate",
          profileId: "pi:local",
          model: "fixture",
        });
        const worker = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 2,
          kind: "worker",
          title: "Ready worker",
          objective: "Finish work",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        const failedScout = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 3,
          kind: "research",
          title: "Failed scout",
          objective: "Prior failed scout",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orch.id, { status: "completed", summary: "Orch done" });
        daemon.db.updateTask(failedScout.id, { status: "failed", summary: "Prior scout failed" });
        daemon.db.updateTask(worker.id, { status: "ready" });
        daemon.db.updateRunStatus(run.id, "failed");

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Wedge test goal",
          description: "Gate blocks until .release-gate exists",
          criteria: [
            {
              id: "c1",
              description: "Release file present",
              kind: "deterministic",
              command: `until [ -f "${releaseFile}" ]; do sleep 0.05; done`,
              required: true,
            },
            {
              id: "c2",
              description: "Behavioral verification after gate passes",
              kind: "behavioral",
              required: true,
            },
          ],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const epochBefore = daemon.director.getReviewInvalidationEpoch(goal.id);
        let verifyError: unknown = null;
        const verifyPromise = daemon.director
          .verifyAndReviewGoal(goal.id, undefined, { autoTriggered: true, settledRunStatus: "failed" })
          .catch((err) => {
            verifyError = err;
            return null;
          });

        // Wait until verification enters gates phase (goal.status === "verifying", reviewCycle === 0).
        await waitFor(() => daemon.director.goals.getGoal(goal.id)?.status === "verifying", 5_000, "verifying status");
        assert.equal(daemon.director.goals.getGoal(goal.id)?.reviewCycle, 0);

        // Inspect activeVerification via both public runtime method and goal_get MCP tool.
        const activeGates = daemon.director.getActiveVerification(goal.id);
        assert.ok(activeGates !== null, "getActiveVerification must be non-null during gates");
        assert.equal(activeGates.kind, "review");
        assert.equal(activeGates.phase, "gates");
        assert.equal(activeGates.cycle, 1);
        assert.equal(activeGates.reviewerTaskId, null);
        assert.equal(activeGates.reviewEpoch, epochBefore);
        assert.equal(activeGates.stale, false);

        const goalGetGates = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
          goal_id: goal.id,
        })) as { goal: { activeVerification: GoalActiveVerification | null; verificationNote?: string } };
        assert.ok(goalGetGates.goal.activeVerification !== null);
        assert.equal(goalGetGates.goal.activeVerification.phase, "gates");
        assert.equal(goalGetGates.goal.activeVerification.cycle, 1);
        assert.equal(goalGetGates.goal.activeVerification.reviewerTaskId, null);
        assert.equal(goalGetGates.goal.activeVerification.reviewEpoch, epochBefore);
        assert.equal(goalGetGates.goal.activeVerification.stale, false);
        assert.equal(goalGetGates.goal.verificationNote, undefined);

        // Resume the ready worker during verification -> bumps epoch, aborts review, restores executing (NOT wedged in verifying).
        const resumeWorkerRes = (await daemon.director.executeDirectorMcpTool(chat.id, "resume_task", {
          task_id: worker.id,
        })) as { outcome: string };
        assert.equal(resumeWorkerRes.outcome, "resumed");

        await verifyPromise;
        assert.ok(
          verifyError instanceof Error && verifyError.message.includes("Run resumed"),
          `expected verification to abort due to run resume, got: ${String(verifyError)}`,
        );
        assert.ok(
          daemon.director.getReviewInvalidationEpoch(goal.id) > epochBefore,
          "resuming the failed run must bump the review invalidation epoch",
        );
        await waitFor(
          () => daemon.director.getActiveVerification(goal.id) === null && daemon.director.goals.getGoal(goal.id)?.status === "executing",
          5_000,
          "verification unwinds to executing",
        );
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "executing", "goal must NOT remain wedged in verifying");
        assert.equal(daemon.director.getActiveVerification(goal.id), null);

        // Allow gate to pass and complete the worker -> run settles completed -> new verification starts automatically!
        writeFileSync(releaseFile, "go\n", "utf8");
        holdWorker.resolve();

        // Wait for the new verification to reach the reviewer phase.
        await reviewerEntered.promise;
        await waitFor(
          () => daemon.director.getActiveVerification(goal.id)?.phase === "reviewer",
          5_000,
          "reviewer phase activeVerification",
        );

        const activeReviewer = daemon.director.getActiveVerification(goal.id)!;
        assert.equal(activeReviewer.kind, "review");
        assert.equal(activeReviewer.phase, "reviewer");
        assert.equal(activeReviewer.cycle, 1);
        assert.ok(activeReviewer.reviewerTaskId && activeReviewer.reviewerTaskId.startsWith("t-"), "reviewerTaskId must be set");
        assert.equal(activeReviewer.stale, false);

        const goalGetReviewer = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
          goal_id: goal.id,
        })) as { goal: { activeVerification: GoalActiveVerification | null } };
        assert.equal(goalGetReviewer.goal.activeVerification?.phase, "reviewer");
        assert.equal(goalGetReviewer.goal.activeVerification?.reviewerTaskId, activeReviewer.reviewerTaskId);

        releaseReviewer.resolve();
        await waitFor(
          () =>
            daemon.director.goals.getGoal(goal.id)?.status === "achieved" &&
            daemon.director.getActiveVerification(goal.id) === null,
          5_000,
          "goal achieved and activeVerification cleared after restarted verification",
        );
        assert.equal(reviewerCalls, 1);
        assert.equal(daemon.director.getActiveVerification(goal.id), null);
      } finally {
        writeFileSync(releaseFile, "cleanup\n", "utf8");
        holdWorker.resolve();
        releaseReviewer.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("4. admission applies to resumes (resume_run, goal_commit, resume_task, amendGoal, drain in-place, and queue_force_start bypass)", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-state-"));
    const sockPath = join(stateDir, "d.sock");
    const evidenceFile = join(repoRoot, "evidence.txt");
    writeFileSync(evidenceFile, "accepted\n", "utf8");

    const runGates = new Map<string, ReturnType<typeof deferred<void>>>();
    const orchStarted = new Map<string, ReturnType<typeof deferred<void>>>();
    const getRunGate = (runId: string) => {
      let d = runGates.get(runId);
      if (!d) {
        d = deferred<void>();
        runGates.set(runId, d);
      }
      return d;
    };
    const getOrchStarted = (runId: string) => {
      let d = orchStarted.get(runId);
      if (!d) {
        d = deferred<void>();
        orchStarted.set(runId, d);
      }
      return d;
    };

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
            if (req.kind === "orchestrator") {
              getOrchStarted(req.runId).resolve();
              await Promise.race([
                getRunGate(req.runId).promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Goal A: active, holding the sole goal slot (maxConcurrentGoals = 1).
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A",
          description: "Holds slot 1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;
        await getOrchStarted(runAId).promise;

        // Goal C: committed -> queued at #1.
        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C",
          description: "Queued #1 ahead of B",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitC = await daemon.director.commitGoalDetailed(goalC.id);
        assert.equal(commitC.outcome, "queued");
        assert.equal(commitC.queuePosition, 1);

        // Goal B: awaiting_human with a failed linked run (orch failed + worker failed).
        const runB = daemon.db.createRun({ goal: "Goal B failed run", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 B",
          objective: "Work B",
          profileId: "pi:local",
          model: "fixture",
        });
        const workerB = daemon.db.createTask({
          runId: runB.id,
          parentId: orchB.id,
          tier: 2,
          kind: "worker",
          title: "Worker B",
          objective: "Subtask B",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchB.id, { status: "failed", summary: "Boom" });
        daemon.db.updateTask(workerB.id, { status: "failed", summary: "Worker boom" });
        daemon.db.updateRunStatus(runB.id, "failed");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B",
          description: "Failed linked run waiting for admission",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Run failed");

        // resume_run on Goal B -> queued at #2, orchB generation unchanged (1).
        const resumeB = (await daemon.director.executeDirectorMcpTool(chat.id, "resume_run", {
          goal_id: goalB.id,
          note: "Resume B when slot opens",
        })) as { outcome: string; queuePosition?: number; reason?: string };
        assert.equal(resumeB.outcome, "queued");
        assert.equal(resumeB.queuePosition, 2);
        assert.equal(resumeB.reason, "queued_for_goal_slot");
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 1, "B's orchestrator must not start while cap is full");

        // goal_commit on Goal B -> already queued at #2.
        const commitB = await daemon.director.commitGoalDetailed(goalB.id);
        assert.equal(commitB.outcome, "queued");
        assert.equal(commitB.queuePosition, 2);

        // resume_task on B's worker -> already_queued at #2.
        const resumeWorkerB = (await daemon.director.executeDirectorMcpTool(chat.id, "resume_task", {
          task_id: workerB.id,
        })) as { outcome: string; queuePosition?: number };
        assert.equal(resumeWorkerB.outcome, "already_queued");
        assert.equal(resumeWorkerB.queuePosition, 2);

        // Also verify amendGoal on a separate awaiting_human goal D with settled Tier 1 queues instead of bypassing cap.
        const runD = daemon.db.createRun({ goal: "Goal D completed run", repoRoot, baseBranch: "main", baseSha });
        const orchD = daemon.db.createTask({
          runId: runD.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 D",
          objective: "Work D",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchD.id, { status: "completed", summary: "Done D" });
        daemon.db.updateRunStatus(runD.id, "completed");
        const goalD = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal D",
          description: "Settled goal amended while cap is full",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalD.id, runD.id);
        daemon.director.goals.setStatus(goalD.id, "awaiting_human", "Waiting review");

        const amendD = await daemon.director.amendGoal(goalD.id, {
          rationale: "Add requirement while cap full",
          appendDescription: "Extra requirement",
        });
        assert.equal(amendD.delivery.delivered, false);
        assert.equal(amendD.delivery.reason, "queued for a goal slot");
        assert.equal(daemon.director.goals.getGoal(goalD.id)?.status, "awaiting_human");
        assert.equal(daemon.db.getTask(orchD.id)?.generation, 1);
        assert.equal(daemon.db.admissionQueue.get("goal", goalD.id)?.position, 3);

        // Release A (complete + accept) -> C starts first (FIFO); B stays queued!
        getRunGate(runAId).resolve();
        await waitFor(() => daemon.orchestrator.getEffectiveRun(runAId)?.status === "completed", 5_000, "run A completes");
        await daemon.director.acceptGoalOverride(goalA.id, {
          reason: "Verified A",
          evidencePaths: [evidenceFile],
          source: "director",
        });

        await waitFor(() => daemon.director.goals.getGoal(goalC.id)?.status === "executing", 5_000, "Goal C admitted first");
        const runCId = daemon.director.goals.getGoal(goalC.id)!.linkedRunId!;
        await getOrchStarted(runCId).promise;
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 1, "B must still wait while C holds the slot");

        const runsCountBeforeB = daemon.db.listRuns(100).length;

        // Release C (complete + accept) -> B resumes IN PLACE (same run id, orchB generation 2, no new run)!
        getRunGate(runCId).resolve();
        await waitFor(() => daemon.orchestrator.getEffectiveRun(runCId)?.status === "completed", 5_000, "run C completes");
        await daemon.director.acceptGoalOverride(goalC.id, {
          reason: "Verified C",
          evidencePaths: [evidenceFile],
          source: "director",
        });

        await waitFor(() => daemon.director.goals.getGoal(goalB.id)?.status === "executing", 5_000, "Goal B resumed from queue");
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.linkedRunId, runB.id, "B must keep its original run id");
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 2, "B's orchestrator must advance generation in place");
        assert.equal(daemon.db.listRuns(100).length, runsCountBeforeB, "resuming B from queue must not create a new run");

        // Now B holds the slot and D is queued at #1 (a queued resume). queue_force_start bypasses the cap for D!
        assert.equal(daemon.db.admissionQueue.get("goal", goalD.id)?.position, 1);
        const forceRes = (await daemon.director.executeDirectorMcpTool(chat.id, "queue_force_start", {
          lane: "goal",
          target_id: goalD.id,
          reason: "Urgent force-start of queued resume",
        })) as { outcome: string; action: string };
        assert.equal(forceRes.outcome, "resumed");
        assert.equal(forceRes.action, "force_started_queued_goal");
        assert.equal(daemon.director.goals.getGoal(goalD.id)?.status, "executing");
        assert.equal(daemon.director.goals.getGoal(goalD.id)?.linkedRunId, runD.id);
        assert.equal(daemon.db.getTask(orchD.id)?.generation, 2);

        for (const d of runGates.values()) d.resolve();
      } finally {
        for (const d of runGates.values()) d.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("6. goal_amend raising max_review_cycles (2 -> 3) and max_no_progress_cycles answers escalations and continues", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-state-"));
    const sockPath = join(stateDir, "d.sock");

    let reviewerCalls = 0;
    const holdOrch = deferred<void>();

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: true },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind === "orchestrator") {
              await Promise.race([
                holdOrch.promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "fixed", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            if (req.kind === "verify") {
              reviewerCalls += 1;
              await req.executeTool("submit_review_verdict", {
                verdict: "approved",
                criteriaResults: [{ criterionId: "c1", passed: true, evidence: "cycle 3 passes" }],
                blockingIssues: [],
                summary: "Cycle 3 approved",
              });
              return { text: "approved", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Budget amend goal", repoRoot, baseBranch: "main", baseSha });
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
        daemon.db.updateTask(orch.id, { status: "completed", summary: "Finished attempt 2" });
        daemon.db.updateRunStatus(run.id, "completed");

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Budget amend max cycles",
          description: "Raise maxReviewCycles 2 -> 3",
          budgets: { maxReviewCycles: 2, maxNoProgressCycles: 5 },
          criteria: [{ id: "c1", description: "Behavior passes", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        // Two distinct changes_requested reviews trip maxReviewCycles=2.
        daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "miss 1", remediation: "fix 1" }],
          blockingIssues: ["blocker 1"],
          summary: "Cycle 1 changes requested",
          diffHash: "hash-1",
        });
        const c2 = daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "miss 2", remediation: "fix 2" }],
          blockingIssues: ["blocker 2"],
          summary: "Cycle 2 changes requested",
          diffHash: "hash-2",
        });
        assert.equal(c2.goal.status, "awaiting_human");
        assert.equal(c2.goal.reviewCycle, 2);
        const maxEsc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: orch.id,
          toTaskId: null,
          severity: "P0",
          category: "verification_failed",
          title: "Max review cycles reached (2/2) (failed: c1)",
          evidencePaths: [repoRoot],
          blocking: true,
        });

        // Negative case: setting max_review_cycles to 2 (unchanged) leaves escalation open and does not continue.
        const negRes = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_amend", {
          goal_id: goal.id,
          rationale: "No actual raise",
          max_review_cycles: 2,
        })) as {
          goal: { version: number; status: string; reviewCycle: number; budgets: { maxReviewCycles: number } };
          resolvedEscalationIds: string[];
          continuation: { action: string; message: string };
        };
        assert.equal(negRes.goal.version, 1);
        assert.equal(negRes.goal.status, "awaiting_human");
        assert.deepEqual(negRes.resolvedEscalationIds, []);
        assert.equal(negRes.continuation.action, "none");
        assert.equal(daemon.db.getEscalation(maxEsc.id)?.status, "open");

        // Positive case: raising max_review_cycles 2 -> 3 answers escalation and resumes Tier 1 with CHANGES REQUESTED steer.
        const posRes = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_amend", {
          goal_id: goal.id,
          rationale: "Give one more review cycle for fix 2",
          max_review_cycles: 3,
        })) as {
          goal: { id: string; version: number; status: string; reviewCycle: number; linkedRunId: string; budgets: { maxReviewCycles: number } };
          budgetsBefore: { maxReviewCycles: number };
          budgetsAfter: { maxReviewCycles: number };
          resolvedEscalationIds: string[];
          continuation: { action: string; message: string };
        };
        assert.equal(posRes.goal.id, goal.id);
        assert.equal(posRes.goal.linkedRunId, run.id);
        assert.equal(posRes.goal.version, 1, "budget-only amend must not bump version");
        assert.equal(posRes.goal.reviewCycle, 2, "budget-only amend must not reset reviewCycle");
        assert.equal(posRes.budgetsBefore.maxReviewCycles, 2);
        assert.equal(posRes.budgetsAfter.maxReviewCycles, 3);
        assert.equal(posRes.goal.budgets.maxReviewCycles, 3);
        assert.deepEqual(posRes.resolvedEscalationIds, [maxEsc.id]);
        assert.equal(posRes.continuation.action, "resumed");
        assert.equal(posRes.goal.status, "executing");

        const escAfter = daemon.db.getEscalation(maxEsc.id)!;
        assert.equal(escAfter.status, "resolved");
        assert.ok(escAfter.resolution?.includes("max_review_cycles 2 -> 3"), `unexpected resolution: ${escAfter.resolution}`);
        assert.ok(escAfter.resolution?.includes("Give one more review cycle for fix 2"));

        const orchAfter = daemon.db.getTask(orch.id)!;
        assert.equal(orchAfter.generation, 2);
        assert.ok(orchAfter.handoffJson?.includes("CHANGES REQUESTED"), "resumed orch must receive CHANGES REQUESTED steer");

        // Complete Tier 1 -> auto-verify runs cycle 3 and achieves the goal!
        holdOrch.resolve();
        await waitFor(() => daemon.director.goals.getGoal(goal.id)?.status === "achieved", 5_000, "cycle 3 achieves goal");
        assert.equal(reviewerCalls, 1);
        const reviews = daemon.director.goals.listReviews(goal.id);
        assert.equal(reviews.length, 3);
        assert.equal(reviews[2]!.cycle, 3);
        assert.equal(reviews[2]!.verdict, "approved");

        // Also test max_no_progress_cycles raise resolving a "No-progress circuit breaker tripped" escalation.
        const runNP = daemon.db.createRun({ goal: "No-progress goal", repoRoot, baseBranch: "main", baseSha });
        const orchNP = daemon.db.createTask({
          runId: runNP.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 NP",
          objective: "Work NP",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchNP.id, { status: "completed", summary: "Done NP" });
        daemon.db.updateRunStatus(runNP.id, "completed");

        const goalNP = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "No-progress budget amend",
          description: "Raise maxNoProgressCycles 2 -> 3",
          budgets: { maxReviewCycles: 6, maxNoProgressCycles: 2 },
          criteria: [{ id: "c1", description: "Behavior", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalNP.id, runNP.id);

        // Same diffHash twice -> streak reaches 2 (trips maxNoProgressCycles = 2).
        daemon.director.goals.recordReviewVerdict(goalNP.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "same" }],
          blockingIssues: ["same issue"],
          summary: "NP cycle 1",
          diffHash: "same-hash",
        });
        daemon.director.goals.recordReviewVerdict(goalNP.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "same" }],
          blockingIssues: ["same issue"],
          summary: "NP cycle 2",
          diffHash: "same-hash",
        });
        const npTrip = daemon.director.goals.recordReviewVerdict(goalNP.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "same" }],
          blockingIssues: ["same issue"],
          summary: "NP cycle 3",
          diffHash: "same-hash",
        });
        assert.equal(npTrip.goal.status, "awaiting_human");
        assert.equal(npTrip.goal.noProgressStreak, 2);

        const npEsc = daemon.db.createEscalation({
          runId: runNP.id,
          fromTaskId: orchNP.id,
          toTaskId: null,
          severity: "P0",
          category: "verification_failed",
          title: "No-progress circuit breaker tripped (2 identical diff/failure cycles, fingerprint=abc)",
          evidencePaths: [repoRoot],
          blocking: true,
        });

        const npRes = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_amend", {
          goal_id: goalNP.id,
          rationale: "Allow one more no-progress cycle",
          max_no_progress_cycles: 3,
        })) as {
          goal: { version: number; noProgressStreak: number; status: string; budgets: { maxNoProgressCycles: number } };
          resolvedEscalationIds: string[];
          continuation: { action: string };
        };
        assert.equal(npRes.goal.version, 1);
        assert.equal(npRes.goal.noProgressStreak, 2);
        assert.equal(npRes.goal.budgets.maxNoProgressCycles, 3);
        assert.deepEqual(npRes.resolvedEscalationIds, [npEsc.id]);
        assert.equal(npRes.continuation.action, "resumed");
        const npEscAfter = daemon.db.getEscalation(npEsc.id)!;
        assert.equal(npEscAfter.status, "resolved");
        assert.ok(npEscAfter.resolution?.includes("max_no_progress_cycles 2 -> 3"));
      } finally {
        holdOrch.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("7. P1-1: stopRun removes queued goal resume, cancel_task removes task-specific queued intent, and drain never resumes a stopped run", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-p1-1-"));
    const sockPath = join(stateDir, "d.sock");
    const evidenceFile = join(repoRoot, "evidence.txt");
    writeFileSync(evidenceFile, "ok\n", "utf8");

    const runGates = new Map<string, ReturnType<typeof deferred<void>>>();
    const orchStarted = new Map<string, ReturnType<typeof deferred<void>>>();
    const getRunGate = (runId: string) => {
      let d = runGates.get(runId);
      if (!d) {
        d = deferred<void>();
        runGates.set(runId, d);
      }
      return d;
    };
    const getOrchStarted = (runId: string) => {
      let d = orchStarted.get(runId);
      if (!d) {
        d = deferred<void>();
        orchStarted.set(runId, d);
      }
      return d;
    };

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
            if (req.kind === "orchestrator") {
              getOrchStarted(req.runId).resolve();
              await Promise.race([
                getRunGate(req.runId).promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Goal A occupies the sole goal slot.
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A",
          description: "Holds cap=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;
        await getOrchStarted(runAId).promise;

        // Goal B: awaiting_human with a completed linked run -> queue resume, then stopRun(runB).
        const runB = daemon.db.createRun({ goal: "Goal B", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 B",
          objective: "Work B",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Done B" });
        daemon.db.updateRunStatus(runB.id, "completed");
        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B",
          description: "Queued then stopped",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Awaiting review");

        const resumeB = await daemon.director.resumeRunDetailed(runB.id, { note: "Resume B" });
        assert.equal(resumeB.outcome, "queued");
        assert.ok(daemon.db.admissionQueue.get("goal", goalB.id));

        await daemon.orchestrator.stopRun(runB.id, "Stopped by user");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null, "stopRun must remove queued resume intent for B");

        // Goal C: awaiting_human with failed worker -> queue task-specific resume, then cancel_task(workerC).
        const runC = daemon.db.createRun({ goal: "Goal C", repoRoot, baseBranch: "main", baseSha });
        const orchC = daemon.db.createTask({
          runId: runC.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 C",
          objective: "Work C",
          profileId: "pi:local",
          model: "fixture",
        });
        const workerC = daemon.db.createTask({
          runId: runC.id,
          parentId: orchC.id,
          tier: 2,
          kind: "worker",
          title: "Worker C",
          objective: "Subtask C",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchC.id, { status: "failed", summary: "Failed C" });
        daemon.db.updateTask(workerC.id, { status: "failed", summary: "Worker failed C" });
        daemon.db.updateRunStatus(runC.id, "failed");
        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C",
          description: "Task-specific queued resume then cancelled",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalC.id, runC.id);
        daemon.director.goals.setStatus(goalC.id, "awaiting_human", "Worker failed");

        const resumeWorkerC = await daemon.director.resumeTaskForCaller(workerC.id, { note: "Retry worker C" });
        assert.equal(resumeWorkerC.outcome, "already_queued");
        assert.ok(daemon.db.admissionQueue.get("goal", goalC.id));

        await daemon.director.executeDirectorMcpTool(chat.id, "cancel_task", {
          task_id: workerC.id,
          reason: "No longer needed",
        });
        assert.equal(daemon.db.admissionQueue.get("goal", goalC.id), null, "cancel_task must remove task-specific queued resume intent");

        // Goal D: even if a stale queue entry exists for a stopped run, drainGoalQueue must NOT resume or relaunch it.
        const runD = daemon.db.createRun({ goal: "Goal D", repoRoot, baseBranch: "main", baseSha });
        const orchD = daemon.db.createTask({
          runId: runD.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 D",
          objective: "Work D",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchD.id, { status: "cancelled", summary: "Stopped D" });
        daemon.db.updateRunStatus(runD.id, "stopped", "Stopped earlier");
        const goalD = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal D",
          description: "Stale queue entry for stopped run",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalD.id, runD.id);
        daemon.director.goals.setStatus(goalD.id, "awaiting_human", "Stopped");
        daemon.db.admissionQueue.enqueue({
          lane: "goal",
          repoRoot,
          targetId: goalD.id,
          launchOpts: { resume: { trigger: "manual", continueCompleted: true } },
        });

        const runsBeforeDrain = daemon.db.listRuns(100).length;

        // Complete and accept Goal A -> drains queue. Neither B, C, nor D may restart!
        getRunGate(runAId).resolve();
        await waitFor(() => daemon.orchestrator.getEffectiveRun(runAId)?.status === "completed", 5_000, "run A completes");
        await daemon.director.acceptGoalOverride(goalA.id, {
          reason: "Verified A",
          evidencePaths: [evidenceFile],
          source: "director",
        });
        await daemon.director.drainGoalQueue(repoRoot);
        await new Promise((r) => setTimeout(r, 60));

        assert.equal(daemon.db.getTask(orchB.id)?.generation, 1, "stopped run B must never restart from queue drain");
        assert.equal(daemon.orchestrator.getEffectiveRun(runB.id)?.status, "stopped");
        assert.equal(daemon.db.getTask(workerC.id)?.generation, 1, "cancelled task C must never restart from queue drain");
        assert.equal(daemon.db.getTask(orchD.id)?.generation, 1, "drain must not resume stopped run D");
        assert.equal(daemon.orchestrator.getEffectiveRun(runD.id)?.status, "stopped");
        assert.equal(daemon.db.admissionQueue.get("goal", goalD.id), null, "stale stopped entry must be evicted by drain");
        assert.equal(daemon.db.listRuns(100).length, runsBeforeDrain, "drain must not create fresh runs for stopped goals");
      } finally {
        for (const d of runGates.values()) d.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("8. P1-2: undelivered-amendment and requested-changes relaunches respect maxConcurrentGoals and FIFO queue order", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-p1-2-"));
    const sockPath = join(stateDir, "d.sock");
    const evidenceFile = join(repoRoot, "evidence.txt");
    writeFileSync(evidenceFile, "ok\n", "utf8");

    const runGates = new Map<string, ReturnType<typeof deferred<void>>>();
    const orchStarted = new Map<string, ReturnType<typeof deferred<void>>>();
    const getRunGate = (runId: string) => {
      let d = runGates.get(runId);
      if (!d) {
        d = deferred<void>();
        runGates.set(runId, d);
      }
      return d;
    };
    const getOrchStarted = (runId: string) => {
      let d = orchStarted.get(runId);
      if (!d) {
        d = deferred<void>();
        orchStarted.set(runId, d);
      }
      return d;
    };

    const reviewEntered = deferred<void>();
    let releaseReview = deferred<void>();

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, maxConcurrentGoals: 1, autoVerifyOnSettle: true },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind === "orchestrator") {
              getOrchStarted(req.runId).resolve();
              await Promise.race([
                getRunGate(req.runId).promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            if (req.kind === "verify") {
              reviewEntered.resolve();
              await Promise.race([
                releaseReview.promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              if (req.signal.aborted) return { text: "cancelled", stopReason: "cancelled" };
              await req.executeTool("submit_review_verdict", {
                verdict: "changes_requested",
                criteriaResults: [{ criterionId: "c1", passed: false, evidence: "checked" }],
                blockingIssues: ["needs revision"],
                summary: "Changes requested",
              });
              return { text: "changes_requested", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });

        // Part (a): Requested-changes relaunch must go through admission when Goal B is queued ahead!
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A review relaunch",
          description: "Will get changes_requested while B is queued",
          criteria: [{ id: "c1", description: "Behavior passes", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;
        const orchA = daemon.db.listTasks(runAId).find((t) => t.tier === 1)!;
        await getOrchStarted(runAId).promise;

        // Queue Goal B behind Goal A at #1.
        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B queued ahead",
          description: "Must claim slot before Goal A relaunches",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitB = await daemon.director.commitGoalDetailed(goalB.id);
        assert.equal(commitB.outcome, "queued");
        assert.equal(commitB.queuePosition, 1);

        // Complete Goal A -> auto-verify enters reviewer phase.
        getRunGate(runAId).resolve();
        await reviewEntered.promise;

        // Release reviewer with changes_requested -> Goal A releases review slot -> admission MUST let B start first and queue A!
        releaseReview.resolve();
        await waitFor(() => daemon.director.goals.getGoal(goalB.id)?.status === "executing", 5_000, "Goal B admitted first");
        const runBId = daemon.director.goals.getGoal(goalB.id)!.linkedRunId!;
        await getOrchStarted(runBId).promise;

        assert.equal(daemon.db.getTask(orchA.id)?.generation, 1, "Goal A must NOT bypass cap/FIFO to relaunch ahead of Goal B");
        assert.equal(daemon.director.goals.getGoal(goalA.id)?.status, "awaiting_human", "Goal A should park awaiting_human while queued");
        assert.equal(daemon.db.admissionQueue.get("goal", goalA.id)?.position, 1, "Goal A must be queued at #1 behind B");
        assert.equal(
          daemon.db.listEscalations(runAId, "open").length,
          0,
          "queuing Goal A for a slot after changes_requested must not create a spurious P0 escalation",
        );

        // Prepare gates for Goal A's gen 2 BEFORE releasing Goal B, and pause Goal B's review until acceptGoalOverride runs.
        runGates.set(runAId, deferred<void>());
        orchStarted.set(runAId, deferred<void>());
        releaseReview = deferred<void>();

        // Accept Goal B -> frees slot -> Goal A drains and resumes in generation 2!
        getRunGate(runBId).resolve();
        await waitFor(() => daemon.orchestrator.getEffectiveRun(runBId)?.status === "completed", 5_000, "run B completes");
        await daemon.director.acceptGoalOverride(goalB.id, {
          reason: "Accepted B",
          evidencePaths: [evidenceFile],
          source: "director",
        });

        await waitFor(() => daemon.db.getTask(orchA.id)?.generation === 2, 5_000, "Goal A resumes from queue after B finishes");
        assert.equal(daemon.director.goals.getGoal(goalA.id)?.status, "executing");

        // Part (b): Undelivered-amendment relaunch must ALSO go through admission when Goal C is queued ahead!
        // Note: customRunner does not expose a native steer handle, so deliverOrQueueLiveSteer refuses while live -> arms undeliveredAmendments.
        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C queued ahead of undelivered amend",
          description: "Must claim slot before Goal A undelivered-amendment relaunch",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitC = await daemon.director.commitGoalDetailed(goalC.id);
        assert.equal(commitC.outcome, "queued");
        assert.equal(commitC.queuePosition, 1);

        await orchStarted.get(runAId)!.promise;
        const amendA = await daemon.director.amendGoal(goalA.id, {
          rationale: "Add v2 requirement while live steer is unsupported",
          appendDescription: "v2 extra requirement",
        });
        assert.equal(amendA.delivery.delivered, false);

        // Now let Goal A gen 2 settle -> recoverUndeliveredAmendment fires -> MUST admit Goal C first and queue Goal A!
        getRunGate(runAId).resolve();
        await waitFor(() => daemon.director.goals.getGoal(goalC.id)?.status === "executing", 5_000, "Goal C admitted before undelivered-amend relaunch");
        const runCId = daemon.director.goals.getGoal(goalC.id)!.linkedRunId!;
        await getOrchStarted(runCId).promise;

        assert.equal(daemon.db.getTask(orchA.id)?.generation, 2, "Goal A must NOT bypass cap/FIFO on undelivered-amendment relaunch");
        assert.equal(daemon.db.admissionQueue.get("goal", goalA.id)?.position, 1, "Goal A must queue behind Goal C");

        // Prepare gate for Goal A gen 3 BEFORE completing Goal C.
        runGates.set(runAId, deferred<void>());
        releaseReview = deferred<void>();

        // Complete and accept Goal C -> Goal A drains and resumes in generation 3 on v2!
        getRunGate(runCId).resolve();
        await waitFor(() => daemon.orchestrator.getEffectiveRun(runCId)?.status === "completed", 5_000, "run C completes");
        await daemon.director.acceptGoalOverride(goalC.id, {
          reason: "Accepted C",
          evidencePaths: [evidenceFile],
          source: "director",
        });

        await waitFor(() => daemon.db.getTask(orchA.id)?.generation === 3, 5_000, "Goal A resumes gen 3 after C finishes");
        assert.equal(daemon.db.getTask(orchA.id)?.goalVersion, 2);
        getRunGate(runAId).resolve();
      } finally {
        for (const d of runGates.values()) d.resolve();
        releaseReview.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("9. P1-3: blocked worker resumed during verification completing BEFORE aborted review unwinds replays settlement cleanly", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-p1-3-"));
    const sockPath = join(stateDir, "d.sock");

    let reviewerCalls = 0;
    const firstReviewEntered = deferred<void>();
    const allowFirstReviewUnwind = deferred<void>();
    const secondReviewEntered = deferred<void>();

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: true },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind === "verify") {
              reviewerCalls += 1;
              if (reviewerCalls === 1) {
                firstReviewEntered.resolve();
                // Wait for abort, then hold unwind until the resumed blocked worker has already settled!
                await new Promise<void>((resolve) => {
                  if (req.signal.aborted) resolve();
                  else req.signal.addEventListener("abort", () => resolve(), { once: true });
                });
                await allowFirstReviewUnwind.promise;
                return { text: "cancelled", stopReason: "cancelled" };
              }
              secondReviewEntered.resolve();
              await req.executeTool("submit_review_verdict", {
                verdict: "approved",
                criteriaResults: [
                  { criterionId: "c1", passed: true, evidence: "gate passes" },
                  { criterionId: "c2", passed: true, evidence: "worker completed cleanly" },
                ],
                blockingIssues: [],
                summary: "Approved after deferred settlement replay",
              });
              return { text: "approved", stopReason: "completed" };
            }
            if (req.tier >= 2) {
              await req.executeTool("return_task", { status: "completed", summary: "Blocked worker completed" });
              return { text: "done", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Blocked worker unwind race", repoRoot, baseBranch: "main", baseSha });
        const orch = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1",
          objective: "Coordinate",
          profileId: "pi:local",
          model: "fixture",
        });
        const blockedWorker = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 2,
          kind: "worker",
          title: "Blocked worker",
          objective: "Finish work",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orch.id, { status: "completed", summary: "Delegated" });
        daemon.db.updateTask(blockedWorker.id, { status: "blocked", summary: "Waiting for answer" });
        daemon.db.updateRunStatus(run.id, "failed");

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Deferred settlement test",
          description: "Blocked worker finishes before aborted review unwinds",
          criteria: [
            { id: "c1", description: "Gate passes", kind: "deterministic", command: "true", required: true },
            { id: "c2", description: "Reviewer approves", kind: "behavioral", required: true },
          ],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const firstVerify = daemon.director
          .verifyAndReviewGoal(goal.id, undefined, { autoTriggered: true, settledRunStatus: "failed" })
          .catch(() => null);

        await firstReviewEntered.promise;
        assert.equal(daemon.director.getActiveVerification(goal.id)?.phase, "reviewer");

        // Resume the BLOCKED worker (performTaskResume flips goal.status='executing' before activation)
        // while the first review still holds activeReviews!
        const resumeRes = await daemon.director.resumeTaskForCaller(blockedWorker.id, { note: "Proceed" });
        assert.equal(resumeRes.outcome, "resumed");

        // Wait for the resumed worker to complete and the run to settle BEFORE releasing the first review's unwind!
        await waitFor(() => daemon.db.getTask(blockedWorker.id)?.status === "completed", 5_000, "blocked worker completes");
        await waitFor(() => daemon.db.getRun(run.id)?.status === "completed", 5_000, "run settles completed before unwind");
        assert.ok(daemon.director.getActiveVerification(goal.id) !== null, "first review must still be unwinding");

        // Now let the aborted first review finish unwinding -> deferred settlement MUST replay into review #2 -> achieved!
        allowFirstReviewUnwind.resolve();
        await firstVerify;

        await waitFor(() => reviewerCalls >= 2, 3_000, "second review starts after unwind");
        await secondReviewEntered.promise;
        await waitFor(
          () =>
            daemon.director.goals.getGoal(goal.id)?.status === "achieved" &&
            daemon.director.getActiveVerification(goal.id) === null,
          5_000,
          "goal achieves via replayed deferred settlement",
        );
        assert.equal(reviewerCalls, 2);
      } finally {
        allowFirstReviewUnwind.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("10. P1-4: content amend on awaiting_human + completed T1 + paused_quota child never misreports T1 delivery, and worker resume preserves pending T1 amendment", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-p1-4-"));
    const sockPath = join(stateDir, "d.sock");
    const holdTasks = deferred<void>();

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, maxConcurrentGoals: 4, autoVerifyOnSettle: false },
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            await Promise.race([
              holdTasks.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            if (req.signal.aborted) return { text: "cancelled", stopReason: "cancelled" };
            if (req.tier >= 2) {
              await req.executeTool("return_task", { status: "completed", summary: "worker done" });
            }
            return { text: "done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Part (a): Quota fixture: awaiting_human + completed T1 (gen 1, v1) + quota-paused child.
        const runQ = daemon.db.createRun({ goal: "Quota fixture", repoRoot, baseBranch: "main", baseSha });
        const orchQ = daemon.db.createTask({
          runId: runQ.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 Quota",
          objective: "Quota work",
          profileId: "pi:local",
          model: "fixture",
          goalVersion: 1,
        });
        const workerQ = daemon.db.createTask({
          runId: runQ.id,
          parentId: orchQ.id,
          tier: 2,
          kind: "worker",
          title: "Paused child",
          objective: "Child work",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
          goalVersion: 1,
        });
        daemon.db.updateTask(orchQ.id, { status: "completed", summary: "Orch done v1" });
        daemon.db.updateTask(workerQ.id, { status: "paused_quota", summary: "Quota hit" });
        daemon.db.updateRunStatus(runQ.id, "paused_quota");

        const goalQ = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Quota amend test",
          description: "Initial v1 description",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalQ.id, runQ.id);
        daemon.director.goals.setStatus(goalQ.id, "awaiting_human", "Paused on quota");

        const amendQ = await daemon.director.amendGoal(goalQ.id, {
          rationale: "Add v2 requirement on quota-paused goal",
          appendDescription: "v2 requirement",
        });
        const orchQAfter = daemon.db.getTask(orchQ.id)!;
        if (amendQ.delivery.delivered) {
          assert.equal(orchQAfter.generation, 2, "delivered:true is only valid if Tier 1 actually resumed to gen 2");
          assert.notEqual(orchQAfter.status, "completed", "delivered:true is invalid while Tier 1 remained completed");
          assert.equal(orchQAfter.goalVersion, 2);
        } else {
          assert.equal(orchQAfter.generation, 1);
          assert.equal(orchQAfter.goalVersion, 1, "Tier 1 bound version must not advance without delivery");
        }

        // Part (b): Resuming an unrelated worker task must NOT clear a pending Tier 1 undelivered amendment!
        const runU = daemon.db.createRun({ goal: "Unrelated worker resume", repoRoot, baseBranch: "main", baseSha });
        const orchU = daemon.db.createTask({
          runId: runU.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 U",
          objective: "Work U",
          profileId: "pi:local",
          model: "fixture",
          goalVersion: 1,
        });
        const workerU = daemon.db.createTask({
          runId: runU.id,
          parentId: orchU.id,
          tier: 2,
          kind: "worker",
          title: "Worker U",
          objective: "Subtask U",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
          goalVersion: 1,
        });
        const goalU = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Pending amend survives worker resume",
          description: "Initial U description",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalU.id, runU.id);
        // Simulate Tier 1 still active (without native steer) and worker failed, then amend -> undelivered armed for v2.
        daemon.db.updateTask(workerU.id, { status: "failed", summary: "Worker failed" });
        daemon.orchestrator.launchTaskLoop(orchU.id);
        await waitFor(() => daemon.db.getTask(orchU.id)?.status === "running", 5_000, "orchU running");

        const amendU = await daemon.director.amendGoal(goalU.id, {
          rationale: "Amend while orchU is live without native steer",
          appendDescription: "Must survive unrelated worker resume",
        });
        assert.equal(amendU.delivery.delivered, false);
        assert.equal(daemon.db.getTask(orchU.id)?.goalVersion, 1);

        // Resume the unrelated Tier 2 worker through resumeTaskForCaller -> must NOT wipe Tier 1's pending amendment!
        // Make goalU temporarily not hold a slot? Actually test the commitGoalDetailed -> resumeLinkedGoalRun path directly
        // by pausing orchU? Better: park goalU awaiting_human (with orchU completed) and test via resumeTaskForCaller on workerU!
        // First verify direct verifyAndReviewGoal rejects with PendingAmendmentError before and after workerU resumes.
        const resumeWorkerRes = await daemon.director.resumeTaskForCaller(workerU.id, { note: "Retry worker only" });
        assert.equal(resumeWorkerRes.outcome, "resumed");
        // Pending Tier 1 amendment must still block premature verification of v2!
        await assert.rejects(
          () => daemon.director.verifyAndReviewGoal(goalU.id),
          /pending|amendment/i,
          "resuming unrelated worker must not clear Tier 1 pending amendment",
        );

        // Also test the commitGoalDetailed -> resumeLinkedGoalRunBody(taskId) path specifically:
        const runU2 = daemon.db.createRun({ goal: "Unrelated worker queued path", repoRoot, baseBranch: "main", baseSha });
        const orchU2 = daemon.db.createTask({
          runId: runU2.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 U2",
          objective: "Work U2",
          profileId: "pi:local",
          model: "fixture",
          goalVersion: 1,
        });
        const workerU2 = daemon.db.createTask({
          runId: runU2.id,
          parentId: orchU2.id,
          tier: 2,
          kind: "worker",
          title: "Worker U2",
          objective: "Subtask U2",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
          goalVersion: 1,
        });
        const goalU2 = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Pending amend survives resumeLinkedGoalRun(worker)",
          description: "Initial U2 description",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalU2.id, runU2.id);
        daemon.db.updateTask(workerU2.id, { status: "failed", summary: "Worker failed" });
        daemon.orchestrator.launchTaskLoop(orchU2.id);
        await waitFor(() => daemon.db.getTask(orchU2.id)?.status === "running", 5_000, "orchU2 running");
        const amendU2 = await daemon.director.amendGoal(goalU2.id, {
          rationale: "Amend U2",
          appendDescription: "U2 v2 requirement",
        });
        assert.equal(amendU2.delivery.delivered, false);

        // Mark goalU2 awaiting_human so resumeTaskForCaller routes through commitGoalDetailed -> resumeLinkedGoalRunBody(opts.taskId)!
        daemon.director.goals.setStatus(goalU2.id, "awaiting_human", "Hold");
        const rWorkerU2 = await daemon.director.resumeTaskForCaller(workerU2.id, { note: "Resume worker U2" });
        assert.equal(rWorkerU2.outcome, "resumed");
        // Tier 1's pending amendment MUST still be armed (not wiped by line 2452)!
        await assert.rejects(
          () => daemon.director.verifyAndReviewGoal(goalU2.id),
          /pending|amendment/i,
          "resumeLinkedGoalRunBody(worker) must not clear Tier 1 pending amendment",
        );

        holdTasks.resolve();
      } finally {
        holdTasks.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("11. P2-1 & P2-2: mixed budget+content and budget+verify_ref validate atomically, and unchanged/non-exhausted budget amend is a no-op", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-p2-1-2-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();

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
            await Promise.race([
              holdA.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Occupy cap=1 with Goal A so any unintended continuation on Goal B would queue B.
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A",
          description: "Holds cap=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        await daemon.director.commitGoalDetailed(goalA.id);

        // Goal B: awaiting_human for an unrelated reason (reviewCycle=0, budgets.maxReviewCycles=4, no budget escalation).
        const runB = daemon.db.createRun({ goal: "Goal B", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 B",
          objective: "Work B",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Done" });
        daemon.db.updateRunStatus(runB.id, "completed");

        const longDesc = "Detailed original goal description that must not be replaced by a shorter string without confirmation.";
        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B atomic & budget noop",
          description: longDesc,
          budgets: { maxReviewCycles: 4, maxNoProgressCycles: 3 },
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Waiting on unrelated human review");

        // P2-1a: Mixed budget + guarded short-description replacement -> MUST throw and leave maxReviewCycles at 4!
        await assert.rejects(
          () =>
            daemon.director.executeDirectorMcpTool(chat.id, "goal_amend", {
              goal_id: goalB.id,
              rationale: "Short replacement without confirm",
              description: "short",
              max_review_cycles: 17,
            }),
          /Refusing to replace/,
        );
        const afterReject1 = daemon.director.goals.getGoal(goalB.id)!;
        assert.equal(afterReject1.budgets.maxReviewCycles, 4, "rejected mixed amend must NOT persist budgets");
        assert.equal(afterReject1.version, 1);
        assert.equal(afterReject1.description, longDesc);

        // P2-1b: Budget + verify_ref where budget is invalid -> MUST throw and leave verifyRef null!
        await assert.rejects(
          () =>
            daemon.director.executeDirectorMcpTool(chat.id, "goal_amend", {
              goal_id: goalB.id,
              rationale: "Bad budget with valid verify_ref",
              verify_ref: "main",
              max_review_cycles: -1,
            }),
          /non-negative integer/,
        );
        const afterReject2 = daemon.director.goals.getGoal(goalB.id)!;
        assert.equal(afterReject2.verifyRef, null, "rejected budget+verify_ref must NOT persist verifyRef");
        assert.equal(afterReject2.budgets.maxReviewCycles, 4);

        // P2-2a: Unchanged budget (4 -> 4) on unrelated awaiting_human goal -> NO-OP (not queued, not resumed)!
        const noopSame = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_amend", {
          goal_id: goalB.id,
          rationale: "Unchanged budget",
          max_review_cycles: 4,
        })) as { continuation: { action: string } };
        assert.equal(noopSame.continuation.action, "none", "unchanged budget must be a no-op");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null, "unchanged budget must not enqueue goal");

        // P2-2b: Raising a NON-exhausted budget (4 -> 10 with reviewCycle=0) on unrelated awaiting_human goal -> updates budget, NO continuation!
        const noopNonExhausted = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_amend", {
          goal_id: goalB.id,
          rationale: "Preemptively raise non-exhausted budget",
          max_review_cycles: 10,
        })) as { goal: { budgets: { maxReviewCycles: number } }; continuation: { action: string } };
        assert.equal(noopNonExhausted.goal.budgets.maxReviewCycles, 10);
        assert.equal(noopNonExhausted.continuation.action, "none", "raising a non-exhausted budget must not auto-continue");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null, "raising a non-exhausted budget must not enqueue goal");
      } finally {
        holdA.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("12. P2-4: drainGoalQueue does not turn a queued run-level resume into a fresh run launch if the linked run became active", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-p2-4-"));
    const sockPath = join(stateDir, "d.sock");
    const evidenceFile = join(repoRoot, "evidence.txt");
    writeFileSync(evidenceFile, "ok\n", "utf8");

    const runGates = new Map<string, ReturnType<typeof deferred<void>>>();
    const orchStarted = new Map<string, ReturnType<typeof deferred<void>>>();
    const getRunGate = (runId: string) => {
      let d = runGates.get(runId);
      if (!d) {
        d = deferred<void>();
        runGates.set(runId, d);
      }
      return d;
    };
    const getOrchStarted = (runId: string) => {
      let d = orchStarted.get(runId);
      if (!d) {
        d = deferred<void>();
        orchStarted.set(runId, d);
      }
      return d;
    };

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
            if (req.kind === "orchestrator") {
              getOrchStarted(req.runId).resolve();
              await Promise.race([
                getRunGate(req.runId).promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Goal A holds cap=1.
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A",
          description: "Holds cap=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;
        await getOrchStarted(runAId).promise;

        // Goal B: awaiting_human with failed runB -> queue run-level resume at #1.
        const runB = daemon.db.createRun({ goal: "Goal B", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 B",
          objective: "Work B",
          profileId: "pi:local",
          model: "fixture",
        });
        daemon.db.updateTask(orchB.id, { status: "failed", summary: "Boom" });
        daemon.db.updateRunStatus(runB.id, "failed");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B becomes active before drain",
          description: "Drain must not launch a fresh run",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Run failed");

        const resumeB = await daemon.director.resumeRunDetailed(runB.id, { note: "Resume B" });
        assert.equal(resumeB.outcome, "queued");
        assert.ok(daemon.db.admissionQueue.get("goal", goalB.id));

        // Now runB becomes active externally while goalB is still awaiting_human and queued!
        daemon.db.updateTask(orchB.id, { status: "ready" });
        daemon.db.updateRunStatus(runB.id, "active");
        daemon.orchestrator.launchTaskLoop(orchB.id);
        await getOrchStarted(runB.id).promise;
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "awaiting_human");

        const runsBeforeDrain = daemon.db.listRuns(100).length;

        // Complete and accept Goal A -> drainGoalQueue pops Goal B whose linked run is now active.
        getRunGate(runAId).resolve();
        await waitFor(() => daemon.orchestrator.getEffectiveRun(runAId)?.status === "completed", 5_000, "run A completes");
        await daemon.director.acceptGoalOverride(goalA.id, {
          reason: "Accepted A",
          evidencePaths: [evidenceFile],
          source: "director",
        });
        await daemon.director.drainGoalQueue(repoRoot);

        assert.equal(daemon.db.listRuns(100).length, runsBeforeDrain, "drain must NOT create a fresh run when linked run became active");
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.linkedRunId, runB.id);
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null);
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "executing");
      } finally {
        for (const d of runGates.values()) d.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("13. P1-2 hook: admitQuotaResume preserves fast path for slot-holders and queues non-slot-holders under maxConcurrentGoals", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-p1-2-quota-"));
    const sockPath = join(stateDir, "d.sock");
    const evidenceFile = join(repoRoot, "evidence.txt");
    writeFileSync(evidenceFile, "ok\n", "utf8");

    const runGates = new Map<string, ReturnType<typeof deferred<void>>>();
    const orchStarted = new Map<string, ReturnType<typeof deferred<void>>>();
    const getRunGate = (runId: string) => {
      let d = runGates.get(runId);
      if (!d) {
        d = deferred<void>();
        runGates.set(runId, d);
      }
      return d;
    };
    const getOrchStarted = (runId: string) => {
      let d = orchStarted.get(runId);
      if (!d) {
        d = deferred<void>();
        orchStarted.set(runId, d);
      }
      return d;
    };

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
            if (req.kind === "orchestrator") {
              getOrchStarted(req.runId).resolve();
            }
            await Promise.race([
              getRunGate(req.runId).promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            if (req.signal.aborted) return { text: "cancelled", stopReason: "cancelled" };
            if (req.tier >= 2) {
              await req.executeTool("return_task", { status: "completed", summary: "worker resumed" });
            }
            return { text: "done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Goal A occupies the sole slot.
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A",
          description: "Holds cap=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");
        const runAId = commitA.goal.linkedRunId!;
        await getOrchStarted(runAId).promise;

        // Slot-holder (Goal A executing) gets the fast path.
        const fastA = await daemon.director.admitQuotaResume(runAId, { trigger: "quota_recovered" });
        assert.equal(fastA.mode, "fast_path");

        // Goal B: awaiting_human with a quota-paused worker (does NOT hold a slot).
        const runB = daemon.db.createRun({ goal: "Goal B quota", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1 B",
          objective: "Work B",
          profileId: "pi:local",
          model: "fixture",
        });
        const workerB = daemon.db.createTask({
          runId: runB.id,
          parentId: orchB.id,
          tier: 2,
          kind: "worker",
          title: "Quota worker B",
          objective: "Subtask B",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Done" });
        daemon.db.updateTask(workerB.id, { status: "paused_quota", summary: "Quota hit" });
        daemon.db.updateRunStatus(runB.id, "paused_quota");
        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B awaiting_human quota",
          description: "Must queue under cap=1 on quota recovery",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Paused on quota");

        const gateB = await daemon.director.admitQuotaResume(runB.id, { trigger: "quota_recovered" });
        assert.equal(gateB.mode, "handled");
        if (gateB.mode === "handled") {
          assert.equal(gateB.resumed, false);
          assert.equal(gateB.queued, true);
          assert.equal(gateB.queuePosition, 1);
        }
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "awaiting_human");
        assert.equal(daemon.db.getTask(workerB.id)?.status, "paused_quota");
        const qList = (await daemon.director.executeDirectorMcpTool(chat.id, "queue_list", {})) as {
          activeGoals: number;
          limits: { maxConcurrentGoals: number };
        };
        assert.equal(qList.activeGoals, 1);
        assert.equal(qList.limits.maxConcurrentGoals, 1);

        // Explicitly paused goal must NOT auto-wake on quota_recovered.
        const runP = daemon.db.createRun({ goal: "Paused goal", repoRoot, baseBranch: "main", baseSha });
        const goalP = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Paused goal",
          description: "Explicitly paused",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalP.id, runP.id);
        daemon.director.goals.setStatus(goalP.id, "paused", "Paused by user");
        const gateP = await daemon.director.admitQuotaResume(runP.id, { trigger: "quota_recovered" });
        assert.equal(gateP.mode, "handled");
        if (gateP.mode === "handled") {
          assert.equal(gateP.resumed, false);
          assert.equal(gateP.queued, false);
        }

        // Complete and accept Goal A -> Goal B drains from queue and resumes workerB!
        getRunGate(runAId).resolve();
        await waitFor(() => daemon.orchestrator.getEffectiveRun(runAId)?.status === "completed", 5_000, "run A completes");
        await daemon.director.acceptGoalOverride(goalA.id, {
          reason: "Accepted A",
          evidencePaths: [evidenceFile],
          source: "director",
        });

        await waitFor(() => daemon.director.goals.getGoal(goalB.id)?.status === "executing", 5_000, "Goal B admitted from quota queue");
        assert.equal(daemon.orchestrator.getEffectiveRun(runB.id)?.status, "active");
        getRunGate(runB.id).resolve();
      } finally {
        for (const d of runGates.values()) d.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("14. C3 P1-a: amending an awaiting_human quota-paused non-slot-holder queues without exceeding maxConcurrentGoals", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-lc-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const orchBGen2Started = deferred<void>();

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
              return { text: "A done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            orchBGen2Started.resolve();
            await Promise.race([
              holdB.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "B done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Goal A holds the only slot (cap = 1).
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

        // Goal B: awaiting_human with completed Tier 1 and a paused_quota child worker.
        const runB = daemon.db.createRun({ goal: "Goal B quota-paused", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch B",
          objective: "Goal B v1",
          profileId: "pi:local",
          model: "fixture",
          goalVersion: 1,
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
          goalVersion: 1,
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Handed off v1" });
        daemon.db.updateTask(workerB.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runB.id, "paused_quota", "Quota exhausted");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B awaiting_human quota child",
          description: "Non-slot-holder amended while A holds cap=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Paused on quota");

        // Amend B before quota recovery while A holds the only slot.
        const amendB = await daemon.director.amendGoal(goalB.id, {
          rationale: "Append v2 requirement while cap=1 is full",
          appendDescription: "Must wait in queue until slot opens",
        });

        assert.equal(amendB.delivery.delivered, false, "must not deliver/resume while A holds cap=1");
        assert.equal(amendB.delivery.via, "none");
        assert.equal(amendB.delivery.reason, "queued for a goal slot");
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "awaiting_human", "queued B must stay awaiting_human");
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.version, 2);

        const orchBAfter = daemon.db.getTask(orchB.id)!;
        assert.equal(orchBAfter.status, "completed", "T1 must stay completed while queued");
        assert.equal(orchBAfter.generation, 1, "T1 must stay generation 1 while queued");
        assert.equal(orchBAfter.goalVersion, 1, "T1 bound goalVersion must stay 1 until delivered");
        assert.equal(daemon.db.getTask(workerB.id)?.status, "paused_quota");

        const qList = (await daemon.director.executeDirectorMcpTool(chat.id, "queue_list", {})) as {
          activeGoals: number;
          limits: { maxConcurrentGoals: number };
          entries: Array<{ lane: string; targetId: string; position: number }>;
        };
        assert.equal(qList.activeGoals, 1, "activeGoals must not exceed maxConcurrentGoals=1");
        assert.equal(qList.limits.maxConcurrentGoals, 1);
        assert.equal(qList.entries.length, 1);
        assert.equal(qList.entries[0]?.targetId, goalB.id);
        assert.equal(qList.entries[0]?.position, 1);

        // Pending amendment must still be armed while queued.
        await assert.rejects(
          () => daemon.director.verifyAndReviewGoal(goalB.id),
          /pending|amendment/i,
          "undelivered amendment must remain armed while queued",
        );

        // Free Goal A's slot -> drain admits B and resumes T1 as gen 2 bound to v2.
        await daemon.orchestrator.stopRun(runAId, "Free slot for amended B");
        await waitFor(
          () => daemon.director.goals.getGoal(goalB.id)?.status === "executing",
          5_000,
          "drain admits queued amended goal B",
        );
        await orchBGen2Started.promise;
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 2);
        assert.equal(daemon.db.getTask(orchB.id)?.goalVersion, 2);
      } finally {
        holdA.resolve();
        holdB.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("15. C3 P2: forceStartQueuedItem(bypassQuota=true) on an unqueued paused_quota goal resumes on first call without queueing", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-lc-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdB = deferred<void>();
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
            const gate = req.initialPrompt.includes("Goal A holds slot") ? holdA.promise : holdB.promise;
            await Promise.race([
              gate,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
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

        // Goal B: awaiting_human, paused on quota, NOT yet queued.
        const runB = daemon.db.createRun({ goal: "Goal B unqueued quota pause", repoRoot, baseBranch: "main", baseSha });
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
        const workerB = daemon.db.createTask({
          runId: runB.id,
          parentId: orchB.id,
          tier: 2,
          kind: "worker",
          title: "Worker B",
          objective: "Subtask B",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Done" });
        daemon.db.updateTask(workerB.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runB.id, "paused_quota", "Quota exhausted");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B unqueued quota override",
          description: "Force-started with bypassQuota=true while A holds cap=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Paused on quota");

        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null, "B starts unqueued");

        const forceRes = (await daemon.director.forceStartQueuedItem({
          lane: "goal",
          targetId: goalB.id,
          bypassQuota: true,
          reason: "Urgent quota override",
        })) as {
          action: string;
          goal: { status: string };
          resumed: { resumed: boolean; resumedTaskIds: string[] };
        };

        assert.equal(forceRes.action, "force_resumed_goal_from_quota");
        assert.equal(forceRes.resumed.resumed, true, "first call must actually resume, not queue");
        assert.deepEqual(forceRes.resumed.resumedTaskIds, [workerB.id]);
        assert.equal(forceRes.goal.status, "executing");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null, "must not be queued after force-resume");
        await waitFor(() => launchedTaskIds.includes(workerB.id), 5_000, "workerB launched on first forceStartQueuedItem call");

        // Terminal goal must still be refused even with bypassQuota=true.
        const runT = daemon.db.createRun({ goal: "Terminal goal", repoRoot, baseBranch: "main", baseSha });
        const workerT = daemon.db.createTask({
          runId: runT.id,
          parentId: null,
          tier: 2,
          kind: "worker",
          title: "Worker T",
          objective: "Subtask T",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(workerT.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runT.id, "paused_quota");
        const goalT = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Cancelled goal",
          description: "Cannot be force-resumed",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalT.id, runT.id);
        daemon.director.goals.setStatus(goalT.id, "cancelled", "Cancelled");
        await assert.rejects(
          () =>
            daemon.director.forceStartQueuedItem({
              lane: "goal",
              targetId: goalT.id,
              bypassQuota: true,
              reason: "Should refuse terminal goal",
            }),
          /already cancelled/i,
        );
      } finally {
        holdA.resolve();
        holdB.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("16. C4 P1-2: concurrent pauseGoal during unqueued forceStartQueuedItem(bypassQuota=true) keeps goal paused and run stopped", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-lc-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdB = deferred<void>();

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
            const gate = req.initialPrompt.includes("Goal A holds slot") ? holdA.promise : holdB.promise;
            await Promise.race([
              gate,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
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

        const runB = daemon.db.createRun({ goal: "Goal B unqueued quota pause", repoRoot, baseBranch: "main", baseSha });
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
        const workerB = daemon.db.createTask({
          runId: runB.id,
          parentId: orchB.id,
          tier: 2,
          kind: "worker",
          title: "Worker B",
          objective: "Subtask B",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Done" });
        daemon.db.updateTask(workerB.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runB.id, "paused_quota", "Quota exhausted");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B concurrent pause race",
          description: "Explicit pause during unqueued forceStartQueuedItem must win",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Paused on quota");

        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null, "B starts unqueued");

        // Start forceStartQueuedItem(bypassQuota:true) and immediately issue pauseGoal before awaiting force.
        const forceP = daemon.director.forceStartQueuedItem({
          lane: "goal",
          targetId: goalB.id,
          bypassQuota: true,
          reason: "Urgent quota override",
        });
        const pauseP = daemon.director.pauseGoal(goalB.id, "Explicit pause during force-start");
        await Promise.all([forceP, pauseP]);
        await new Promise((r) => setTimeout(r, 80));

        assert.equal(
          daemon.director.goals.getGoal(goalB.id)?.status,
          "paused",
          "explicit pause must not be overwritten by post-resume status update",
        );
        assert.equal(
          daemon.orchestrator.getEffectiveRun(runB.id)?.status,
          "stopped",
          "run must stay stopped after concurrent pauseGoal",
        );
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null);
      } finally {
        holdA.resolve();
        holdB.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("17. C4 P2: forceStartQueuedItem on an already queued quota-paused goal requires bypassQuota=true (ordinary and quota-only queue entries)", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-lc-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const holdC = deferred<void>();
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
            const gate = req.initialPrompt.includes("Goal A holds slot")
              ? holdA.promise
              : req.initialPrompt.includes("Subtask B")
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

        // Variant 1: ordinary queued entry for a quota-paused goal.
        const runB = daemon.db.createRun({ goal: "Goal B ordinary queued quota", repoRoot, baseBranch: "main", baseSha });
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
        const workerB = daemon.db.createTask({
          runId: runB.id,
          parentId: orchB.id,
          tier: 2,
          kind: "worker",
          title: "Worker B",
          objective: "Subtask B",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Done" });
        daemon.db.updateTask(workerB.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runB.id, "paused_quota", "Quota exhausted");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B ordinary queued quota",
          description: "Queued via commitGoalDetailed while quota-paused",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Paused on quota");

        const queuedB = await daemon.director.commitGoalDetailed(goalB.id);
        assert.equal(queuedB.outcome, "queued");
        assert.equal(queuedB.queuePosition, 1);

        // Variant 2: quota-only queued entry for another quota-paused goal.
        const runC = daemon.db.createRun({ goal: "Goal C quota-only queued", repoRoot, baseBranch: "main", baseSha });
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
          objective: "Subtask C",
          profileId: "pi:local",
          model: "fixture",
          readOnly: true,
        });
        daemon.db.updateTask(orchC.id, { status: "completed", summary: "Done" });
        daemon.db.updateTask(workerC.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runC.id, "paused_quota", "Quota exhausted");

        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C quota-only queued",
          description: "Queued via quota recovery while quota-paused",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalC.id, runC.id);
        daemon.director.goals.setStatus(goalC.id, "awaiting_human", "Paused on quota");

        const autoC = await daemon.orchestrator.resumeRunFromQuota(runC.id, { trigger: "auto_timer" });
        assert.equal(autoC.resumed, false);
        const qBeforeC = daemon.db.admissionQueue.get("goal", goalC.id);
        assert.equal(qBeforeC?.position, 2);
        assert.equal((qBeforeC?.launchOpts as { resume?: { quotaOnly?: boolean } } | null)?.resume?.quotaOnly, true);

        // Both ordinary and quota-only queued entries MUST refuse bypassQuota:false and leave queue entries unchanged.
        await assert.rejects(
          () =>
            daemon.director.forceStartQueuedItem({
              lane: "goal",
              targetId: goalB.id,
              bypassQuota: false,
              reason: "Should refuse without bypassQuota",
            }),
          /bypass_quota:\s*true/i,
        );
        const qAfterRefusalB = daemon.db.admissionQueue.get("goal", goalB.id);
        assert.ok(qAfterRefusalB, "refused ordinary entry must remain queued");
        assert.equal(qAfterRefusalB.position, 1, "refused ordinary entry position must stay unchanged");
        assert.equal(qAfterRefusalB.forceStart, false, "refused ordinary entry must not be marked forced");
        assert.equal(daemon.db.getTask(workerB.id)?.status, "paused_quota");
        assert.equal(launchedTaskIds.includes(workerB.id), false);

        await assert.rejects(
          () =>
            daemon.director.forceStartQueuedItem({
              lane: "goal",
              targetId: goalC.id,
              bypassQuota: false,
              reason: "Should refuse quota-only without bypassQuota",
            }),
          /bypass_quota:\s*true/i,
        );
        const qAfterRefusalC = daemon.db.admissionQueue.get("goal", goalC.id);
        assert.ok(qAfterRefusalC, "refused quota-only entry must remain queued");
        assert.equal(qAfterRefusalC.position, 2, "refused quota-only entry position must stay unchanged");
        assert.equal(qAfterRefusalC.forceStart, false, "refused quota-only entry must not be marked forced");
        assert.equal((qAfterRefusalC.launchOpts as { resume?: { quotaOnly?: boolean } } | null)?.resume?.quotaOnly, true);
        assert.equal(daemon.db.getTask(workerC.id)?.status, "paused_quota");
        assert.equal(launchedTaskIds.includes(workerC.id), false);

        // With bypassQuota:true, both ordinary and quota-only queued entries force-start as expected.
        const forcedB = (await daemon.director.forceStartQueuedItem({
          lane: "goal",
          targetId: goalB.id,
          bypassQuota: true,
          reason: "Explicit quota override for B",
        })) as { action: string; outcome: string; goal: { status: string } };
        assert.equal(forcedB.action, "force_started_queued_goal");
        assert.equal(forcedB.outcome, "resumed");
        assert.equal(forcedB.goal.status, "executing");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null);
        await waitFor(() => launchedTaskIds.includes(workerB.id), 5_000, "workerB launched with bypassQuota=true");

        const forcedC = (await daemon.director.forceStartQueuedItem({
          lane: "goal",
          targetId: goalC.id,
          bypassQuota: true,
          reason: "Explicit quota override for C",
        })) as { action: string; outcome: string; goal: { status: string } };
        assert.equal(forcedC.action, "force_started_queued_goal");
        assert.equal(forcedC.outcome, "resumed");
        assert.equal(forcedC.goal.status, "executing");
        assert.equal(daemon.db.admissionQueue.get("goal", goalC.id), null);
        await waitFor(() => launchedTaskIds.includes(workerC.id), 5_000, "workerC launched with bypassQuota=true");
      } finally {
        holdA.resolve();
        holdB.resolve();
        holdC.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("18. C5 P2: task-targeted queued amendment on a quota-paused run requires bypassQuota=true and preserves queue and quota timer on refusal", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g26-lc-state-"));
    const sockPath = join(stateDir, "d.sock");
    const holdA = deferred<void>();
    const holdB = deferred<void>();
    const orchBGen2Started = deferred<void>();

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
              return { text: "A done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            orchBGen2Started.resolve();
            await Promise.race([
              holdB.promise,
              new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
            ]);
            return { text: "B done", stopReason: req.signal.aborted ? "cancelled" : "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Goal A holds the only slot (cap = 1).
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A holds slot",
          description: "Occupies maxConcurrentGoals=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const commitA = await daemon.director.commitGoalDetailed(goalA.id);
        assert.equal(commitA.outcome, "started");

        // Goal B: awaiting_human with completed Tier 1 and a paused_quota child worker.
        const runB = daemon.db.createRun({ goal: "Goal B quota-paused", repoRoot, baseBranch: "main", baseSha });
        const orchB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "Orch B",
          objective: "Goal B v1",
          profileId: "pi:local",
          model: "fixture",
          goalVersion: 1,
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
          goalVersion: 1,
        });
        daemon.db.updateTask(orchB.id, { status: "completed", summary: "Handed off v1" });
        daemon.db.updateTask(workerB.id, { status: "paused_quota", summary: "429 quota" });
        daemon.db.updateRunStatus(runB.id, "paused_quota", "Quota exhausted");

        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal B awaiting_human quota child",
          description: "Non-slot-holder amended while A holds cap=1",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        daemon.director.goals.setStatus(goalB.id, "awaiting_human", "Paused on quota");

        // Amend B while A holds the only slot -> queues a task-targeted Tier 1 resume.
        const amendB = await daemon.director.amendGoal(goalB.id, {
          rationale: "Append v2 requirement while cap=1 is full",
          appendDescription: "Must wait in queue until slot opens",
        });
        assert.equal(amendB.delivery.delivered, false);
        assert.equal(amendB.delivery.reason, "queued for a goal slot");

        const qBefore = daemon.db.admissionQueue.get("goal", goalB.id);
        assert.ok(qBefore, "amended goal B must be queued");
        assert.equal(qBefore.position, 1);
        assert.equal((qBefore.launchOpts as { resume?: { taskId?: string } } | null)?.resume?.taskId, orchB.id);
        assert.equal(daemon.orchestrator.getEffectiveRun(runB.id)?.status, "paused_quota");

        // Arm a scheduled quota retry on run B.
        const quotaBefore = daemon.orchestrator.scheduleRunQuotaResume(runB.id, 60_000);
        assert.equal(quotaBefore.mode, "user_timer");

        // forceStartQueuedItem with bypassQuota:false MUST refuse and leave queue, goal, run, T1, and quota timer intact.
        await assert.rejects(
          () =>
            daemon.director.forceStartQueuedItem({
              lane: "goal",
              targetId: goalB.id,
              bypassQuota: false,
              reason: "Should refuse task-targeted queued amendment on quota-paused run",
            }),
          /bypass_quota:\s*true/i,
        );

        const qAfterRefusal = daemon.db.admissionQueue.get("goal", goalB.id);
        assert.ok(qAfterRefusal, "refused entry must remain in queue");
        assert.equal(qAfterRefusal.position, qBefore.position, "refused entry position must remain unchanged");
        assert.equal(qAfterRefusal.forceStart, false, "refused entry must not be marked forced");
        assert.equal(daemon.director.goals.getGoal(goalB.id)?.status, "awaiting_human", "goal must not become executing");
        assert.equal(daemon.orchestrator.getEffectiveRun(runB.id)?.status, "paused_quota", "run must remain paused_quota");
        assert.equal(daemon.db.getTask(orchB.id)?.status, "completed");
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 1);
        assert.deepEqual(
          daemon.orchestrator.getRunQuotaStatus(runB.id),
          quotaBefore,
          "scheduled quota retry status must remain unchanged after refusal",
        );

        // With bypassQuota:true, force-start succeeds and launches Tier 1 gen 2 bound to v2.
        const forced = (await daemon.director.forceStartQueuedItem({
          lane: "goal",
          targetId: goalB.id,
          bypassQuota: true,
          reason: "Explicit quota override for task-targeted amendment",
        })) as { action: string; outcome: string; goal: { status: string } };
        assert.equal(forced.action, "force_started_queued_goal");
        assert.equal(forced.outcome, "resumed");
        assert.equal(forced.goal.status, "executing");
        assert.equal(daemon.db.admissionQueue.get("goal", goalB.id), null);
        await orchBGen2Started.promise;
        assert.equal(daemon.db.getTask(orchB.id)?.generation, 2);
        assert.equal(daemon.db.getTask(orchB.id)?.goalVersion, 2);
      } finally {
        holdA.resolve();
        holdB.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
