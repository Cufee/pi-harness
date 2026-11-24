import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import {
  ReviewBudgetExhaustedError,
  ReviewInProgressError,
  StaleReviewError,
  type ActiveReviewInfo,
} from "../src/director/runtime.js";
import type { GoalRecord, GoalReviewVerdict, ReviewerDiagnostics } from "../src/goals/engine.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-"));
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

describe("goal-18 v5 criteria", () => {
  it("T1 [accept-final]: rejects late reviewer and direct verdict writes after goal_accept without reopening or escalating", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");
    const evidenceFile = join(repoRoot, "evidence.txt");
    writeFileSync(evidenceFile, "verified externally\n", "utf8");

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
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            reviewerEntered.resolve();
            await releaseReviewer.promise;
            await req.executeTool("submit_review_verdict", {
              verdict: "changes_requested",
              criteriaResults: [{ criterionId: "c1", passed: false, evidence: "late failure" }],
              blockingIssues: ["late blocker"],
              summary: "Late changes_requested verdict after accept.",
            });
            return { text: "late changes_requested output", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Accept-final goal", repoRoot, baseBranch: "main", baseSha });
        daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 1,
          kind: "orchestrator",
          title: "T1",
          objective: "Work",
          profileId: "fixture",
        });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Accept-final late reviewer",
          description: "Late reviewer must not reopen achieved goal",
          criteria: [{ id: "c1", description: "Behavioral requirement", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const reviewPromise = daemon.director.verifyAndReviewGoal(goal.id);
        await reviewerEntered.promise;

        // Mark goal achieved directly in the engine while the reviewer is still in flight (simulating a racing accept).
        daemon.director.goals.acceptGoalOverride(goal.id, {
          expectedVersion: goal.version,
          criteriaResults: [{ criterionId: "c1", passed: true, evidence: "[DIRECTOR ACCEPTED] verified" }],
          summary: "[DIRECTOR ACCEPTED OVERRIDE] Accepted while reviewer in flight.",
          diffHash: "accept-hash",
          audit: {
            acceptedBy: "director",
            chatSessionId: chat.id,
            reason: "Already verified",
            evidence: [{ input: "evidence.txt", canonicalPath: evidenceFile, kind: "file", mtimeMs: Date.now() }],
            overrideDeterministic: false,
            failedDeterministicCriteria: [],
            prevStatus: "reviewing",
            goalVersion: goal.version,
            verifyRef: null,
            acceptedAt: Date.now(),
          },
        });
        const reviewCountAfterAccept = daemon.director.goals.listReviews(goal.id).length;
        assert.equal(reviewCountAfterAccept, 1);

        // Release the late reviewer, which submits changes_requested.
        releaseReviewer.resolve();
        let caught: unknown = null;
        try {
          await reviewPromise;
        } catch (err) {
          caught = err;
        }

        assert.ok(caught instanceof StaleReviewError, `expected StaleReviewError, got ${String(caught)}`);
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "achieved");
        assert.equal(daemon.director.goals.listReviews(goal.id).length, reviewCountAfterAccept);
        assert.equal(daemon.db.listEscalations(run.id, "open").length, 0);

        const staleEvents = daemon.db.getEventsSince(run.id, 0).filter((e) => e.type === "goal.review_stale");
        assert.equal(staleEvents.length, 1);
        const stalePayload = staleEvents[0]!.payload as {
          goalId?: string;
          currentStatus?: string;
          verdict?: string;
          reviewerTaskId?: string;
        };
        assert.equal(stalePayload.goalId, goal.id);
        assert.equal(stalePayload.currentStatus, "achieved");
        assert.equal(stalePayload.verdict, "changes_requested");
        assert.ok(stalePayload.reviewerTaskId, "expected reviewerTaskId on goal.review_stale");

        const reviewerTask = daemon.db.getTask(stalePayload.reviewerTaskId!);
        assert.equal(reviewerTask?.status, "completed");
        assert.match(reviewerTask?.summary ?? "", /^Stale: goal /);

        // Direct GoalEngine.recordReviewVerdict guard also rejects achieved goals with StaleReviewError.
        assert.throws(
          () =>
            daemon.director.goals.recordReviewVerdict(goal.id, {
              verdict: "changes_requested",
              criteriaResults: [{ criterionId: "c1", passed: false, evidence: "late direct write" }],
              summary: "Should be rejected",
              diffHash: "direct-stale",
              expectedVersion: goal.version,
            }),
          StaleReviewError,
        );
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "achieved");
        assert.equal(daemon.director.goals.listReviews(goal.id).length, reviewCountAfterAccept);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T2 [accept-final]: goal_trigger_review on an achieved goal with a failing deterministic gate returns stale without reopening", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");
    const evidenceFile = join(repoRoot, "proof.txt");
    writeFileSync(evidenceFile, "proof\n", "utf8");

    let directorAction: ((executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | null =
      null;

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
            if (req.taskId.startsWith("chat-") && directorAction) {
              const fn = directorAction;
              directorAction = null;
              await fn(req.executeTool);
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Rev-14 repro", repoRoot, baseBranch: "main", baseSha });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Failing gate after accept",
          description: "Reproduces rev-14 pattern",
          criteria: [
            {
              id: "failing-gate",
              description: "Always fails",
              kind: "deterministic",
              command: "exit 1",
              required: true,
            },
          ],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        await daemon.director.acceptGoalOverride(goal.id, {
          reason: "Accepted with deterministic override",
          evidencePaths: ["proof.txt"],
          overrideDeterministic: true,
          source: "director",
          chatSessionId: chat.id,
        });
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "achieved");
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 1);

        let triggerResult!: Record<string, unknown>;
        directorAction = async (executeTool) => {
          triggerResult = (await executeTool("goal_trigger_review", { goal_id: goal.id })) as Record<string, unknown>;
        };
        await daemon.director.sendChatMessage(chat.id, "trigger review after accept");

        assert.equal(triggerResult.outcome, "stale");
        assert.match(String(triggerResult.reason ?? ""), /achieved/i);
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "achieved");
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 1);
        assert.equal(daemon.db.listEscalations(run.id, "open").length, 0);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T3 [reviewer-diagnostics]: persists and surfaces diagnostics for successful reviews and failed reviewer attempts", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");

    let directorAction: ((executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | null =
      null;
    let reviewerMode:
      | "succeed"
      | "empty_twice"
      | "completed_high_turns_context_prose"
      | "quota_paused_twice"
      | "rollover_twice"
      | "explicit_max_turns"
      | "throw_crash" = "succeed";

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        rollover: { ...baseCfg.rollover, reviewerMaxTurns: 5 },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.taskId.startsWith("chat-") && directorAction) {
              const fn = directorAction;
              directorAction = null;
              await fn(req.executeTool);
              return { text: "done", stopReason: "completed" };
            }
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            if (reviewerMode === "succeed") {
              req.callbacks.onTurn?.(2);
              req.callbacks.onUsage?.({ used: 40_000, size: 200_000 });
              await req.executeTool("submit_review_verdict", {
                verdict: "approved",
                criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Verified base.txt" }],
                blockingIssues: [],
                summary: "Looks good.",
              });
              return { text: "approved raw output", stopReason: "completed" };
            }
            if (reviewerMode === "empty_twice") {
              req.callbacks.onTurn?.(1);
              return { text: "", stopReason: "completed" };
            }
            if (reviewerMode === "completed_high_turns_context_prose") {
              req.callbacks.onTurn?.(5);
              req.callbacks.onUsage?.({ used: 192_000, size: 200_000 });
              return { text: "finished reviewing the context of the change without submitting", stopReason: "completed" };
            }
            if (reviewerMode === "quota_paused_twice") {
              req.callbacks.onTurn?.(2);
              return { text: "paused on quota", stopReason: "quota_paused" };
            }
            if (reviewerMode === "rollover_twice") {
              req.callbacks.onTurn?.(3);
              return { text: "context window exhausted", stopReason: "rollover_requested" };
            }
            if (reviewerMode === "explicit_max_turns") {
              req.callbacks.onTurn?.(5);
              return { text: "runner hit max turns", stopReason: "max_turns" as unknown as "completed" };
            }
            throw new Error("runner backend exception");
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });

        // 1. Successful review records submitted diagnostics and raw output dossier.
        const goalOk = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Diagnostics success goal",
          description: "Check diagnostics on success",
          criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
        });
        let okTrigger: { goal: GoalRecord; review: GoalReviewVerdict } | null = null;
        let okGet: { goal: GoalRecord; reviews: GoalReviewVerdict[] } | null = null;
        directorAction = async (executeTool) => {
          okTrigger = (await executeTool("goal_trigger_review", { goal_id: goalOk.id })) as {
            goal: GoalRecord;
            review: GoalReviewVerdict;
          };
          okGet = (await executeTool("goal_get", { goal_id: goalOk.id })) as {
            goal: GoalRecord;
            reviews: GoalReviewVerdict[];
          };
        };
        await daemon.director.sendChatMessage(chat.id, "review success goal");

        const okDiag = okTrigger!.review.diagnostics!;
        assert.ok(okDiag, "expected diagnostics on successful review");
        assert.ok(okDiag.reviewerTaskId.startsWith("t-"));
        assert.ok(okDiag.model.length > 0);
        assert.equal(okDiag.attempts, 1);
        assert.equal(okDiag.stopReason, "submitted");
        assert.equal(okDiag.contextPct, 20);
        assert.equal(okDiag.turnsUsed, 2);
        assert.equal(okDiag.rawOutputPaths.length, 1);
        assert.equal(existsSync(okDiag.rawOutputPaths[0]!), true);
        assert.equal(readFileSync(okDiag.rawOutputPaths[0]!, "utf8"), "approved raw output");
        assert.ok(okDiag.transcript.includes(okDiag.reviewerTaskId));
        assert.deepEqual(okGet!.reviews[0]!.diagnostics, okDiag);
        assert.equal(okGet!.goal.lastReviewerFailure, null);

        // 2. Empty reviewer output twice -> outcome reviewer_failed + lastReviewerFailure persisted on goal.
        reviewerMode = "empty_twice";
        const goalEmpty = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Diagnostics empty failure goal",
          description: "Check diagnostics on empty reviewer output",
          criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
        });
        let failTrigger: { outcome?: string; reviewerFailure?: ReviewerDiagnostics; goal?: GoalRecord } | null = null;
        let failGet: { goal: GoalRecord; reviews: GoalReviewVerdict[] } | null = null;
        directorAction = async (executeTool) => {
          failTrigger = (await executeTool("goal_trigger_review", { goal_id: goalEmpty.id })) as {
            outcome?: string;
            reviewerFailure?: ReviewerDiagnostics;
            goal?: GoalRecord;
          };
          failGet = (await executeTool("goal_get", { goal_id: goalEmpty.id })) as {
            goal: GoalRecord;
            reviews: GoalReviewVerdict[];
          };
        };
        await daemon.director.sendChatMessage(chat.id, "review empty goal");

        assert.equal(failTrigger!.outcome, "reviewer_failed");
        const failDiag = failTrigger!.reviewerFailure!;
        assert.ok(failDiag, "expected reviewerFailure diagnostics");
        assert.equal(failDiag.attempts, 2);
        assert.equal(failDiag.stopReason, "end_turn_without_verdict");
        assert.equal(failDiag.infrastructure, true);
        assert.equal(failDiag.rawOutputPaths.length, 2);
        for (const p of failDiag.rawOutputPaths) {
          assert.equal(existsSync(p), true);
          assert.equal(readFileSync(p, "utf8"), "(empty)");
        }
        assert.deepEqual(failGet!.goal.lastReviewerFailure, failDiag);
        assert.equal(failGet!.reviews.length, 0);
        assert.equal(failGet!.goal.reviewCycle, 0);

        // 3. Normal stopReason="completed" at/above advisory reviewerMaxTurns and prose mentioning "context"
        // must NOT fabricate max_turns or context_limit; it reports end_turn_without_verdict with turnsUsed preserved.
        reviewerMode = "completed_high_turns_context_prose";
        const goalCompletedHighTurns = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Diagnostics completed high turns goal",
          description: "Check honest stop reason classification for normal completed session",
          criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
        });
        let highTurnsTrigger: { outcome?: string; reviewerFailure?: ReviewerDiagnostics } | null = null;
        directorAction = async (executeTool) => {
          highTurnsTrigger = (await executeTool("goal_trigger_review", { goal_id: goalCompletedHighTurns.id })) as {
            outcome?: string;
            reviewerFailure?: ReviewerDiagnostics;
          };
        };
        await daemon.director.sendChatMessage(chat.id, "review completed high turns goal");
        assert.equal(highTurnsTrigger!.outcome, "reviewer_failed");
        assert.equal(highTurnsTrigger!.reviewerFailure?.stopReason, "end_turn_without_verdict");
        assert.equal(highTurnsTrigger!.reviewerFailure?.turnsUsed, 5);
        assert.equal(highTurnsTrigger!.reviewerFailure?.contextPct, 96);

        // 4. Genuine runner signals map honestly: quota_paused, rollover_requested -> context_limit, max_turns, crash.
        for (const [mode, expectedStop] of [
          ["quota_paused_twice", "quota_paused"],
          ["rollover_twice", "context_limit"],
          ["explicit_max_turns", "max_turns"],
          ["throw_crash", "crash"],
        ] as const) {
          reviewerMode = mode;
          const g = daemon.director.goals.createGoal({
            chatSessionId: chat.id,
            repoRoot,
            title: `Diagnostics ${mode}`,
            description: `Check ${expectedStop} classification`,
            criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
          });
          let res: { outcome?: string; reviewerFailure?: ReviewerDiagnostics } | null = null;
          directorAction = async (executeTool) => {
            res = (await executeTool("goal_trigger_review", { goal_id: g.id })) as {
              outcome?: string;
              reviewerFailure?: ReviewerDiagnostics;
            };
          };
          await daemon.director.sendChatMessage(chat.id, `review ${mode}`);
          assert.equal(res!.outcome, "reviewer_failed");
          assert.equal(res!.reviewerFailure?.stopReason, expectedStop, `expected ${expectedStop} for ${mode}`);
        }
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T4 [review-in-progress-visible]: concurrent goal_trigger_review reports inflightId, reviewerTaskId, goalVersion, and howToWait", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");

    const reviewerStarted = deferred<string>();
    const releaseReviewer = deferred<void>();
    let directorAction: ((executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | null =
      null;

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
            if (req.taskId.startsWith("chat-") && directorAction) {
              const fn = directorAction;
              directorAction = null;
              await fn(req.executeTool);
              return { text: "done", stopReason: "completed" };
            }
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            reviewerStarted.resolve(req.taskId);
            await releaseReviewer.promise;
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Done" }],
              blockingIssues: [],
              summary: "Approved.",
            });
            return { text: "approved", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "In-progress visibility goal",
          description: "Check review_in_progress details",
          criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
        });

        const firstReview = daemon.director.verifyAndReviewGoal(goal.id);
        const reviewerTaskId = await reviewerStarted.promise;

        // Direct API throws typed ReviewInProgressError.
        let directErr: unknown = null;
        try {
          await daemon.director.verifyAndReviewGoal(goal.id);
        } catch (err) {
          directErr = err;
        }
        assert.ok(directErr instanceof ReviewInProgressError);
        assert.equal(directErr.inFlight.reviewerTaskId, reviewerTaskId);
        assert.equal(directErr.inFlight.goalVersion, 1);

        // Director tool returns structured outcome review_in_progress.
        let toolRes!: {
          outcome?: string;
          inFlight?: ActiveReviewInfo;
          superseded?: boolean;
          howToWait?: string;
        };
        directorAction = async (executeTool) => {
          toolRes = (await executeTool("goal_trigger_review", { goal_id: goal.id })) as typeof toolRes;
        };
        await daemon.director.sendChatMessage(chat.id, "trigger second review");

        assert.equal(toolRes.outcome, "review_in_progress");
        assert.equal(toolRes.superseded, false);
        assert.equal(toolRes.inFlight?.reviewerTaskId, reviewerTaskId);
        assert.equal(toolRes.inFlight?.goalVersion, 1);
        assert.equal(toolRes.inFlight?.phase, "reviewer");
        assert.ok(toolRes.inFlight?.inflightId.includes(goal.id));
        assert.match(toolRes.howToWait ?? "", /goal_wait/);

        // Following howToWait (goal_wait) while the reviewer is still running MUST actually block
        // rather than returning already_settled, and wake as soon as the review finishes.
        let waitSettled = false;
        let waitResult: { wakeReason?: string; goal?: GoalRecord } | null = null;
        const waitChatTurn = (async () => {
          directorAction = async (executeTool) => {
            waitResult = (await executeTool("goal_wait", {
              goal_id: goal.id,
              fallback_interval_s: 30,
            })) as typeof waitResult;
            waitSettled = true;
          };
          await daemon.director.sendChatMessage(chat.id, "follow howToWait with goal_wait");
        })();
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(waitSettled, false, "goal_wait must stay blocked while in-flight review is still running");

        releaseReviewer.resolve();
        const done = await firstReview;
        assert.equal(done.review.verdict, "approved");
        await waitChatTurn;
        assert.equal(waitSettled, true);
        assert.equal(waitResult!.wakeReason, "event");
        assert.equal(waitResult!.goal?.status, "achieved");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T5 [review-in-progress-visible]: goal_amend supersedes an in-flight v1 review so immediate goal_trigger_review runs v2 cleanly", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");

    const v1Started = deferred<string>();
    let v1RunId = "";
    let v1TaskId = "";
    let directorAction: ((executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | null =
      null;

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
            if (req.taskId.startsWith("chat-") && directorAction) {
              const fn = directorAction;
              directorAction = null;
              await fn(req.executeTool);
              return { text: "done", stopReason: "completed" };
            }
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            if (!v1TaskId) {
              v1TaskId = req.taskId;
              v1RunId = req.runId;
              v1Started.resolve(req.taskId);
              // Wait for abort from goal_amend, then unwind slightly asynchronously to exercise waitForReviewUnwind.
              await new Promise<void>((resolve) => {
                if (req.signal.aborted) {
                  setTimeout(resolve, 60);
                  return;
                }
                req.signal.addEventListener("abort", () => setTimeout(resolve, 60), { once: true });
              });
              return { text: "", stopReason: "cancelled" };
            }
            // v2 reviewer approves cleanly.
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "c1", passed: true, evidence: "v2 verified" }],
              blockingIssues: [],
              summary: "Approved v2.",
            });
            return { text: "approved v2", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Supersede on amend goal",
          description: "v1 description",
          criteria: [{ id: "c1", description: "Original criterion", kind: "behavioral", required: true }],
        });

        const v1Promise = daemon.director.verifyAndReviewGoal(goal.id).catch((err) => err);
        await v1Started.promise;

        // Amend to v2 and immediately invoke goal_trigger_review while v1 is still unwinding.
        let v2Trigger!: { goal?: GoalRecord; review?: GoalReviewVerdict; outcome?: string };
        directorAction = async (executeTool) => {
          await executeTool("goal_amend", {
            goal_id: goal.id,
            rationale: "Tighten v2 scope",
            description: "v2 description",
          });
          v2Trigger = (await executeTool("goal_trigger_review", { goal_id: goal.id })) as typeof v2Trigger;
        };
        await daemon.director.sendChatMessage(chat.id, "amend and immediately trigger review");
        await v1Promise;

        assert.equal(v2Trigger.outcome, undefined, `expected v2 review to run, got ${JSON.stringify(v2Trigger)}`);
        assert.equal(v2Trigger.review?.goalVersion, 2);
        assert.equal(v2Trigger.review?.cycle, 1);
        assert.equal(v2Trigger.review?.verdict, "approved");
        assert.equal(v2Trigger.goal?.status, "achieved");

        // v1 reviewer task ended cancelled and wrote no goal_reviews row.
        assert.equal(daemon.db.getTask(v1TaskId)?.status, "cancelled");
        const reviews = daemon.director.goals.listReviews(goal.id);
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0]!.goalVersion, 2);
        assert.equal(reviews[0]!.cycle, 1);

        const supersededEvents = daemon.db.getEventsSince(v1RunId, 0).filter((e) => e.type === "goal.review_superseded");
        assert.equal(supersededEvents.length, 1);
        const supPayload = supersededEvents[0]!.payload as { fromVersion?: number; toVersion?: number; reviewerTaskId?: string };
        assert.equal(supPayload.fromVersion, 1);
        assert.equal(supPayload.toVersion, 2);
        assert.equal(supPayload.reviewerTaskId, v1TaskId);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T6 [reviewer-context-budget]: compacts 18-criterion / 40KB prompt, nudges at 70%+ usage, and treats empty output as infrastructure error", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");

    const criteriaIds: string[] = [];
    const criteria = Array.from({ length: 18 }, (_, i) => {
      const id = `crit-${i + 1}`;
      criteriaIds.push(id);
      if (i < 2) {
        return {
          id,
          description: `Deterministic check ${i + 1} `.repeat(20),
          kind: "deterministic" as const,
          command: "echo ok",
          required: true,
        };
      }
      return {
        id,
        description: `Behavioral criterion ${i + 1}: ` + "detailed specification text ".repeat(30),
        kind: "behavioral" as const,
        required: true,
      };
    });
    const bigDescription = "Large specification paragraph describing invariants and edge cases.\n".repeat(650); // > 40 KB
    assert.ok(bigDescription.length > 40_000);

    let capturedPrompt = "";
    const steeredMessages: string[] = [];
    let drainedSteers: string[] = [];
    let mode: "large_with_nudge" | "empty_infra" = "large_with_nudge";
    let directorAction: ((executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | null =
      null;

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
            if (req.taskId.startsWith("chat-") && directorAction) {
              const fn = directorAction;
              directorAction = null;
              await fn(req.executeTool);
              return { text: "done", stopReason: "completed" };
            }
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            if (mode === "empty_infra") {
              return { text: "", stopReason: "completed" };
            }
            capturedPrompt = req.initialPrompt;
            // Register an onHandle whose steer fails once -> verify fallback queues into drainPendingSteers too.
            req.onHandle?.({
              steer: async (msg) => {
                steeredMessages.push(msg);
                return false;
              },
              cancel: async () => {},
            });
            // Report 75% context utilization -> triggers 70% context nudge.
            req.callbacks.onUsage?.({ used: 150_000, size: 200_000 });
            // Wait a microtask for handle.steer().then() fallback to enqueue into pendingSteers.
            await new Promise((r) => setTimeout(r, 10));
            drainedSteers = req.drainPendingSteers?.() ?? [];

            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: criteriaIds.map((criterionId) => ({
                criterionId,
                passed: true,
                evidence: `Verified ${criterionId}`,
              })),
              blockingIssues: [],
              summary: "All 18 criteria verified after 75% context nudge.",
            });
            return { text: "submitted after nudge", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Large 18-criterion goal",
          description: bigDescription,
          criteria,
        });

        // Pre-seed an existing contract-v1.md and a dangling symlink in the evidence dir to ensure the
        // exclusive contract write creates a fresh unique file without overwriting existing evidence or following symlinks.
        const goalEvidencePath = join(repoRoot, ".harness", "goals", goal.id);
        mkdirSync(goalEvidencePath, { recursive: true });
        const existingEvidenceFile = join(goalEvidencePath, "contract-v1.md");
        writeFileSync(existingEvidenceFile, "pre-existing evidence must stay untouched\n", "utf8");
        const outsideTarget = join(stateDir, "should-not-be-created.md");
        symlinkSync(outsideTarget, join(goalEvidencePath, "dangling-link.md"));

        const outcome = await daemon.director.verifyAndReviewGoal(goal.id);
        assert.ok(capturedPrompt.length < 16_000, `expected compact prompt < 16000 chars, got ${capturedPrompt.length}`);
        for (const id of criteriaIds) {
          assert.ok(capturedPrompt.includes(`[${id}]`), `prompt missing criterion id ${id}`);
        }
        // Passed deterministic criteria are collapsed so reviewer does not re-verify them.
        assert.ok(capturedPrompt.includes("- [crit-1] PASS (gate)"));
        assert.ok(capturedPrompt.includes("- [crit-2] PASS (gate)"));
        assert.match(capturedPrompt, /reserve the last 30% of context/i);

        // Fresh exclusive contract file exists on disk with the complete 40KB+ description, while pre-existing file is untouched.
        assert.equal(readFileSync(existingEvidenceFile, "utf8"), "pre-existing evidence must stay untouched\n");
        assert.equal(existsSync(outsideTarget), false);
        const contractFiles = readdirSync(goalEvidencePath).filter((f) => /^contract-v1-[0-9a-f]{8}\.md$/.test(f));
        assert.equal(contractFiles.length, 1, `expected one unique contract file, found: ${JSON.stringify(contractFiles)}`);
        const contractFile = join(goalEvidencePath, contractFiles[0]!);
        assert.ok(readFileSync(contractFile, "utf8").includes(bigDescription.trim()));
        assert.ok(capturedPrompt.includes(contractFile));

        // 75% usage triggered the context nudge via handle.steer and fallback drainPendingSteers.
        assert.equal(steeredMessages.length, 1);
        assert.match(steeredMessages[0]!, /75%/);
        assert.match(steeredMessages[0]!, /submit_review_verdict/);
        assert.equal(drainedSteers.length, 1);
        assert.equal(drainedSteers[0], steeredMessages[0]);

        assert.equal(outcome.review.verdict, "approved");
        assert.equal(outcome.review.diagnostics?.stopReason, "submitted");
        assert.equal(outcome.review.diagnostics?.contextPct, 75);
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 1);

        // Without a contractPath (e.g. when evidence dir is unavailable), buildReviewerPrompt must NEVER truncate
        // the description or required criterion text so critical tails stay accessible to the reviewer.
        const descTailMarker = "CRITICAL_DESCRIPTION_TAIL_QUALIFICATION";
        const critTailMarker = "CRITICAL_CRITERION_TAIL_QUALIFICATION";
        const goalNoContract = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Fallback no-contract-file goal",
          description: `${"A".repeat(4500)} ${descTailMarker}`,
          criteria: [
            {
              id: "tail-req",
              description: `${"B".repeat(360)} ${critTailMarker}`,
              kind: "behavioral",
              required: true,
            },
          ],
        });
        const inlinePrompt = daemon.director.goals.buildReviewerPrompt(
          goalNoContract,
          {
            allPassed: true,
            diffHash: "h1",
            results: [],
            location: { cwd: repoRoot, ref: "main", sha: "HEAD", isolated: false, source: "repo_root" },
          },
          "",
          undefined,
          {},
        );
        assert.ok(inlinePrompt.includes(descTailMarker), "description tail must not be truncated without contractPath");
        assert.ok(inlinePrompt.includes(critTailMarker), "criterion tail must not be truncated without contractPath");

        // Runtime fallback: when the goal's evidence path is blocked by a regular file (ensureGoalEvidenceDir -> null),
        // verifyAndReviewGoal still passes the full description and criterion tails inline to the reviewer.
        const blockedEvidencePath = join(repoRoot, ".harness", "goals", goalNoContract.id);
        rmSync(blockedEvidencePath, { recursive: true, force: true });
        writeFileSync(blockedEvidencePath, "blocking-file-not-a-dir\n", "utf8");
        capturedPrompt = "";
        const savedCriteriaIds = [...criteriaIds];
        criteriaIds.splice(0, criteriaIds.length, "tail-req");
        await daemon.director.verifyAndReviewGoal(goalNoContract.id);
        criteriaIds.splice(0, criteriaIds.length, ...savedCriteriaIds);
        assert.ok(capturedPrompt.includes(descTailMarker), "runtime fallback must include full description tail");
        assert.ok(capturedPrompt.includes(critTailMarker), "runtime fallback must include full criterion tail");

        // Empty output is an infrastructure error, never changes_requested, and never advances reviewCycle or noProgressStreak.
        mode = "empty_infra";
        const goalInfra = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Empty output infra check",
          description: "Verify empty output does not feed no-progress breaker",
          criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
        });
        daemon.director.goals.recordReviewVerdict(goalInfra.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "not ready" }],
          blockingIssues: ["missing feature"],
          summary: "Cycle 1 changes requested",
          diffHash: "same-diff",
        });
        assert.equal(daemon.director.goals.getGoal(goalInfra.id)?.reviewCycle, 1);
        assert.equal(daemon.director.goals.getGoal(goalInfra.id)?.noProgressStreak, 0);

        let infraTrigger!: { outcome?: string; reviewerFailure?: ReviewerDiagnostics };
        directorAction = async (executeTool) => {
          infraTrigger = (await executeTool("goal_trigger_review", { goal_id: goalInfra.id })) as typeof infraTrigger;
        };
        await daemon.director.sendChatMessage(chat.id, "run empty reviewer");

        assert.equal(infraTrigger.outcome, "reviewer_failed");
        assert.equal(infraTrigger.reviewerFailure?.infrastructure, true);
        assert.equal(infraTrigger.reviewerFailure?.stopReason, "end_turn_without_verdict");
        const afterInfra = daemon.director.goals.getGoal(goalInfra.id)!;
        assert.equal(afterInfra.reviewCycle, 1);
        assert.equal(afterInfra.noProgressStreak, 0);
        assert.equal(daemon.director.goals.listReviews(goalInfra.id).length, 1);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T7 [max-cycles-enforced]: blocks auto-verify and trigger once maxReviewCycles is reached until override or amend", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");

    let reviewerCalls = 0;
    const holdOrch = deferred<void>();
    let directorAction: ((executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | null =
      null;

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
            if (req.taskId.startsWith("chat-") && directorAction) {
              const fn = directorAction;
              directorAction = null;
              await fn(req.executeTool);
              return { text: "done", stopReason: "completed" };
            }
            if (req.kind === "orchestrator") {
              await Promise.race([
                holdOrch.promise,
                new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true })),
              ]);
              return { text: "ok", stopReason: req.signal.aborted ? "cancelled" : "completed" };
            }
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            reviewerCalls += 1;
            const currentGoal = daemon.director.goals.listGoals({ repoRoot })[0]!;
            const isV2 = currentGoal.version >= 2;
            await req.executeTool("submit_review_verdict", {
              verdict: isV2 ? "approved" : "changes_requested",
              criteriaResults: [{ criterionId: "c1", passed: isV2, evidence: isV2 ? "v2 ok" : "cycle 3 still failing" }],
              blockingIssues: isV2 ? [] : ["still failing on override cycle"],
              summary: isV2 ? "Approved v2" : "Override cycle 3 changes requested",
            });
            return { text: "done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
        const run = daemon.db.createRun({ goal: "Max cycles goal", repoRoot, baseBranch: "main", baseSha });
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
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Max cycles enforcement",
          description: "Enforce maxReviewCycles=2",
          budgets: { maxReviewCycles: 2, maxNoProgressCycles: 5 },
          criteria: [{ id: "c1", description: "Behavior verified", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        // Record two changes_requested verdicts with distinct diff hashes -> cycle 2 trips maxReviewCycles=2.
        daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "missing 1" }],
          blockingIssues: ["issue 1"],
          summary: "Cycle 1 failed",
          diffHash: "diff-1",
        });
        const c2 = daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c1", passed: false, evidence: "missing 2" }],
          blockingIssues: ["issue 2"],
          summary: "Cycle 2 failed",
          diffHash: "diff-2",
        });
        assert.equal(c2.goal.status, "awaiting_human");
        assert.match(c2.circuitBreakerTripped ?? "", /Max review cycles reached \(2\/2\)/);
        daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: orch.id,
          toTaskId: null,
          severity: "P0",
          category: "verification_failed",
          title: "Max review cycles reached (2/2)",
          evidencePaths: [repoRoot],
          blocking: true,
        });

        // Simulate a resume that flips the goal back to executing, then emit run.status completed.
        daemon.db.updateTask(orch.id, { status: "completed", summary: "completed" });
        daemon.director.goals.setStatus(goal.id, "executing");
        daemon.db.updateRunStatus(run.id, "completed");
        await new Promise((r) => setTimeout(r, 150));

        // Auto-verify MUST NOT run cycle 3: zero reviewer invocations, still 2 rows, status awaiting_human.
        assert.equal(reviewerCalls, 0);
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 2);
        assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "awaiting_human");

        // Direct API throws ReviewBudgetExhaustedError without override.
        await assert.rejects(() => daemon.director.verifyAndReviewGoal(goal.id), ReviewBudgetExhaustedError);

        // Director tool goal_trigger_review without override returns review_budget_exhausted.
        let blockedRes!: { outcome?: string; reason?: string; howToProceed?: string };
        directorAction = async (executeTool) => {
          blockedRes = (await executeTool("goal_trigger_review", { goal_id: goal.id })) as typeof blockedRes;
        };
        await daemon.director.sendChatMessage(chat.id, "try review without override");
        assert.equal(blockedRes.outcome, "review_budget_exhausted");
        assert.match(blockedRes.reason ?? "", /Max review cycles reached/);
        assert.match(blockedRes.howToProceed ?? "", /override_review_budget/);
        assert.equal(reviewerCalls, 0);
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 2);

        // Explicit override_review_budget: true runs cycle 3.
        let overrideRes!: { goal?: GoalRecord; review?: GoalReviewVerdict; outcome?: string };
        directorAction = async (executeTool) => {
          overrideRes = (await executeTool("goal_trigger_review", {
            goal_id: goal.id,
            override_review_budget: true,
          })) as typeof overrideRes;
        };
        await daemon.director.sendChatMessage(chat.id, "trigger review with override");
        assert.equal(overrideRes.outcome, undefined);
        assert.equal(overrideRes.review?.cycle, 3);
        assert.equal(overrideRes.goal?.status, "awaiting_human");
        assert.equal(reviewerCalls, 1);
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 3);

        // Amending the goal resets reviewCycle and supersedes verification_failed escalations -> review runs without override.
        let afterAmendRes!: { goal?: GoalRecord; review?: GoalReviewVerdict; outcome?: string };
        directorAction = async (executeTool) => {
          await executeTool("goal_amend", {
            goal_id: goal.id,
            rationale: "New approach in v2",
            append_description: "Updated spec v2",
          });
          afterAmendRes = (await executeTool("goal_trigger_review", { goal_id: goal.id })) as typeof afterAmendRes;
        };
        await daemon.director.sendChatMessage(chat.id, "amend and trigger review without override");
        assert.equal(afterAmendRes.outcome, undefined);
        assert.equal(afterAmendRes.review?.goalVersion, 2);
        assert.equal(afterAmendRes.review?.cycle, 1);
        assert.equal(afterAmendRes.review?.verdict, "approved");
        assert.equal(afterAmendRes.goal?.status, "achieved");
        assert.equal(reviewerCalls, 2);
      } finally {
        holdOrch.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T8 [max-cycles-enforced]: maxReviewCycles=0 blocks cycle 1 without explicit override and rejects invalid negative budgets", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18v5-state-"));
    const sockPath = join(stateDir, "d.sock");

    let reviewerCalls = 0;
    let directorAction: ((executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) => Promise<void>) | null =
      null;

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
            if (req.taskId.startsWith("chat-") && directorAction) {
              const fn = directorAction;
              directorAction = null;
              await fn(req.executeTool);
              return { text: "done", stopReason: "completed" };
            }
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            reviewerCalls += 1;
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Verified" }],
              blockingIssues: [],
              summary: "Approved via explicit override.",
            });
            return { text: "done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });

        // Invalid negative or non-integer budgets are rejected on goal creation.
        assert.throws(
          () =>
            daemon.director.goals.createGoal({
              chatSessionId: chat.id,
              repoRoot,
              title: "Negative budget goal",
              description: "Should fail validation",
              criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
              budgets: { maxReviewCycles: -1 },
            }),
          /non-negative integer/,
        );
        assert.throws(
          () =>
            daemon.director.goals.createGoal({
              chatSessionId: chat.id,
              repoRoot,
              title: "Fractional budget goal",
              description: "Should fail validation",
              criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
              budgets: { maxReviewCycles: 1.5 },
            }),
          /non-negative integer/,
        );

        // Zero budget blocks cycle 1 without explicit override.
        const zeroGoal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Zero review budget goal",
          description: "Zero cycles must block cycle 1",
          criteria: [{ id: "c1", description: "Verified", kind: "behavioral", required: true }],
          budgets: { maxReviewCycles: 0 },
        });
        assert.equal(zeroGoal.budgets.maxReviewCycles, 0);

        let directErr: unknown = null;
        try {
          await daemon.director.verifyAndReviewGoal(zeroGoal.id);
        } catch (err) {
          directErr = err;
        }
        assert.ok(directErr instanceof ReviewBudgetExhaustedError);
        assert.match(directErr.reason, /Max review cycles reached \(0\/0\)/);
        assert.equal(reviewerCalls, 0);

        let blockedToolRes!: { outcome?: string; reason?: string };
        directorAction = async (executeTool) => {
          blockedToolRes = (await executeTool("goal_trigger_review", { goal_id: zeroGoal.id })) as typeof blockedToolRes;
        };
        await daemon.director.sendChatMessage(chat.id, "trigger review on zero-budget goal");
        assert.equal(blockedToolRes.outcome, "review_budget_exhausted");
        assert.match(blockedToolRes.reason ?? "", /0\/0/);
        assert.equal(reviewerCalls, 0);

        // Explicit override_review_budget: true runs cycle 1.
        let overrideRes!: { outcome?: string; review?: GoalReviewVerdict; goal?: GoalRecord };
        directorAction = async (executeTool) => {
          overrideRes = (await executeTool("goal_trigger_review", {
            goal_id: zeroGoal.id,
            override_review_budget: true,
          })) as typeof overrideRes;
        };
        await daemon.director.sendChatMessage(chat.id, "override zero-budget goal");
        assert.equal(overrideRes.outcome, undefined);
        assert.equal(overrideRes.review?.cycle, 1);
        assert.equal(overrideRes.goal?.status, "achieved");
        assert.equal(reviewerCalls, 1);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
