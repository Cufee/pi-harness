import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { normalizeReviewerVerdict, parseReviewerVerdictJson, ReviewerFailedError } from "../src/director/runtime.js";
import { runGit } from "../src/worktree/manager.js";
import { BisectingMergeQueue, runMergedRef } from "../src/worktree/merge-queue.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-g18-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "base.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

describe("goal-18 Done-Review reliability", () => {
  it("nudges an unsettled reviewer via missingReturnWrapUpPrompt and records one review once submitted", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-state-"));
    const sockPath = join(stateDir, "d.sock");
    let reviewerSessions = 0;
    let wrapUpPromptSeen = "";

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            reviewerSessions += 1;
            assert.equal(typeof req.isTaskSettled, "function");
            assert.equal(req.isTaskSettled!(), false);
            assert.ok(req.missingReturnWrapUpPrompt, "expected missingReturnWrapUpPrompt on reviewer run");
            assert.match(req.missingReturnWrapUpPrompt!, /submit_review_verdict/);
            assert.match(req.missingReturnWrapUpPrompt!, /criteriaResults/);
            assert.match(req.missingReturnWrapUpPrompt!, /blockingIssues/);
            assert.match(req.missingReturnWrapUpPrompt!, /changes_requested/);

            // A rejected malformed submit leaves the reviewer unsettled.
            await assert.rejects(
              () =>
                req.executeTool("submit_review_verdict", {
                  verdict: "looks_good",
                  criteriaResults: [],
                  summary: "invalid",
                }),
              /looks_good/,
            );
            assert.equal(req.isTaskSettled!(), false);

            // Simulate the runner delivering the in-session wrap-up turn when turn 1 ends unsettled.
            if (!req.isTaskSettled!() && req.missingReturnWrapUpPrompt) {
              wrapUpPromptSeen = req.missingReturnWrapUpPrompt;
              await req.executeTool("submit_review_verdict", {
                verdict: "approved",
                criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Checked base.txt" }],
                blockingIssues: [],
                summary: "Approved after wrap-up nudge.",
              });
            }
            assert.equal(req.isTaskSettled!(), true);
            return { text: "submitted", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Wrap-up nudge goal",
          description: "Verify in-session reviewer wrap-up nudge",
          criteria: [{ id: "c1", description: "Behavior verified", kind: "behavioral", required: true }],
        });

        const outcome = await daemon.director.verifyAndReviewGoal(goal.id);
        assert.equal(reviewerSessions, 1);
        assert.ok(wrapUpPromptSeen.includes("submit_review_verdict"));
        assert.equal(outcome.review.verdict, "approved");
        assert.equal(outcome.goal.status, "achieved");
        assert.equal(outcome.goal.reviewCycle, 1);
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 1);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("retries once with attempt 1's concrete failure and reports ReviewerFailedError without consuming a review cycle", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-state-"));
    const sockPath = join(stateDir, "d.sock");
    const prompts: string[] = [];

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            prompts.push(req.initialPrompt);
            if (prompts.length === 1) {
              // Attempt 1 submits a malformed verdict, ignores the error, and ends with plain text.
              try {
                await req.executeTool("submit_review_verdict", {
                  verdict: "ship_it",
                  criteriaResults: [],
                  summary: "bad verdict enum",
                });
              } catch {
                // Model ignores tool error and ends without a valid verdict
              }
              return { text: "still inspecting c1 without valid verdict", stopReason: "completed" };
            }
            // Attempt 2 never calls submit_review_verdict and emits no JSON verdict.
            return { text: "attempt 2 ended with prose only", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Missing verdict goal",
          description: "Verify missing verdict never consumes a review cycle",
          criteria: [{ id: "c1", description: "Behavior verified", kind: "behavioral", required: true }],
        });

        let caught: unknown = null;
        try {
          await daemon.director.verifyAndReviewGoal(goal.id);
        } catch (err) {
          caught = err;
        }

        assert.ok(caught instanceof ReviewerFailedError, `expected ReviewerFailedError, got ${String(caught)}`);
        assert.equal(caught.attempts, 2);
        assert.equal(prompts.length, 2, "must perform exactly one retry (2 attempts total)");

        // Attempt 2 prompt must include concrete failure details from attempt 1.
        const retryPrompt = prompts[1]!;
        assert.match(retryPrompt, /stopReason=completed/);
        assert.match(retryPrompt, /submit_review_verdict=called \(1x, rejected\)/);
        assert.match(retryPrompt, /invalid verdict "ship_it"/);
        assert.match(retryPrompt, /still inspecting c1 without valid verdict/);

        // No goal_reviews row, reviewCycle unchanged, noProgressStreak unchanged, status reports reviewer failure.
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 0);
        const updatedGoal = daemon.director.goals.getGoal(goal.id)!;
        assert.equal(updatedGoal.reviewCycle, 0);
        assert.equal(updatedGoal.noProgressStreak, 0);
        assert.equal(updatedGoal.status, "awaiting_human");
        assert.ok(
          updatedGoal.lastReviewSummary?.includes(
            "Reviewer failed to return a structured verdict after 2 attempts; review cycle not consumed",
          ),
          `unexpected lastReviewSummary: ${updatedGoal.lastReviewSummary}`,
        );

        // Reviewer task is marked failed with a structured result describing the failure.
        const allRuns = daemon.db.listRuns();
        const reviewerTask = allRuns
          .flatMap((r) => daemon.db.listTasks(r.id))
          .find((t) => t.kind === "verify" && t.title.startsWith("Done-Review:"));
        assert.ok(reviewerTask, "expected persisted reviewer task");
        assert.equal(reviewerTask.status, "failed");
        assert.match(
          reviewerTask.summary ?? "",
          /Reviewer failed to return a structured verdict after 2 attempts; review cycle not consumed/,
        );
        const parsedResult = JSON.parse(reviewerTask.resultJson ?? "{}") as {
          reviewerFailed?: boolean;
          attempts?: number;
          attemptFailures?: string[];
        };
        assert.equal(parsedResult.reviewerFailed, true);
        assert.equal(parsedResult.attempts, 2);
        assert.equal(parsedResult.attemptFailures?.length, 2);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("checks out the goal run's own merged sha for verification even after a sibling merges later unpushed", async () => {
    const repoRoot = await makeTempRepo();
    const bareOrigin = mkdtempSync(join(tmpdir(), "pi-harness-g18-origin-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-state-"));
    const sockPath = join(stateDir, "d.sock");
    let verifyCheckoutHead = "";
    let fallbackCheckoutHead = "";

    try {
      await runGit(bareOrigin, ["init", "--bare"]);
      await runGit(repoRoot, ["remote", "add", "origin", bareOrigin]);
      await runGit(repoRoot, ["push", "-u", "origin", "main"]);
      const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            const head = (await runGit(req.cwd, ["rev-parse", "HEAD"])).stdout;
            if (!verifyCheckoutHead) verifyCheckoutHead = head;
            else fallbackCheckoutHead = head;
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "behavior", passed: true, evidence: `Verified at ${head}` }],
              blockingIssues: [],
              summary: "Verified at goal merge commit.",
            });
            return { text: "approved", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const wtMgr = daemon.orchestrator.getWorktreeManager(repoRoot);
        const mq = new BisectingMergeQueue(daemon.db, wtMgr, repoRoot, config.worktree, {
          gateShell: config.goals.gateShell,
          gateEnv: config.goals.gateEnv,
          stateDir,
        });

        // Goal A's run merges commit A onto local main and pushes A to origin/main.
        const runA = daemon.db.createRun({ goal: "Goal A", repoRoot, baseBranch: "main", baseSha });
        const taskA = daemon.db.createTask({
          runId: runA.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker A",
          objective: "Add a.txt",
          profileId: "fixture",
        });
        const wtA = await wtMgr.createForWorker(runA.id, taskA.id, "main");
        writeFileSync(join(wtA.path, "a.txt"), "from goal A\n", "utf8");
        await runGit(wtA.path, ["add", "a.txt"]);
        await runGit(wtA.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: goal A"]);
        daemon.db.enqueueMerge({ runId: runA.id, taskId: taskA.id, worktreeId: wtA.id, branch: wtA.branch });
        const mergedA = await mq.processNext(runA.id);
        assert.ok(mergedA?.mergedSha, "expected merge A to succeed");
        const refA = (await runGit(repoRoot, ["rev-parse", "--verify", `${runMergedRef(runA.id)}^{commit}`])).stdout;
        assert.equal(refA, mergedA.mergedSha);

        // Push Goal A's merge commit to origin/main.
        await runGit(repoRoot, ["push", "origin", `${mergedA.mergedSha}:refs/heads/main`]);

        // Sibling Goal B merges commit B onto local main AFTER A, and stays UNPUSHED.
        const runB = daemon.db.createRun({ goal: "Goal B", repoRoot, baseBranch: "main", baseSha: mergedA.mergedSha });
        const taskB = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker B",
          objective: "Add b.txt",
          profileId: "fixture",
        });
        const wtB = await wtMgr.createForWorker(runB.id, taskB.id, "main");
        writeFileSync(join(wtB.path, "b.txt"), "from sibling B\n", "utf8");
        await runGit(wtB.path, ["add", "b.txt"]);
        await runGit(wtB.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: sibling B"]);
        daemon.db.enqueueMerge({ runId: runB.id, taskId: taskB.id, worktreeId: wtB.id, branch: wtB.branch });
        const mergedB = await mq.processNext(runB.id);
        assert.ok(mergedB?.mergedSha, "expected merge B to succeed");
        assert.notEqual(mergedB.mergedSha, mergedA.mergedSha);

        // Confirm local main (commit B) is NOT an ancestor of origin/main (commit A).
        const localMainOnOrigin = await runGit(repoRoot, ["merge-base", "--is-ancestor", "main", "origin/main"])
          .then(() => true)
          .catch(() => false);
        assert.equal(localMainOnOrigin, false, "local main should contain unpushed sibling commit B");

        const chat = await daemon.director.createChat({ repoRoot });
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A shipped check",
          description: "Shipped gate checks goal A's own merged commit",
          criteria: [
            {
              id: "shipped",
              description: "Goal A merge is on origin/main",
              kind: "deterministic",
              command: "git fetch -q origin && git merge-base --is-ancestor HEAD origin/main",
              required: true,
            },
            { id: "behavior", description: "Behavior verified", kind: "behavioral", required: true },
          ],
        });
        daemon.director.goals.linkRunAndStart(goalA.id, runA.id);

        const outcome = await daemon.director.verifyAndReviewGoal(goalA.id);
        assert.equal(verifyCheckoutHead, mergedA.mergedSha);
        assert.equal(outcome.review.verdict, "approved");
        assert.equal(outcome.goal.status, "achieved");
        assert.equal(outcome.review.criteriaResults.find((c) => c.criterionId === "shipped")?.passed, true);

        // Fallback: when a run has no recorded merge ref (or non-ancestor ref), verify checkout uses base tip.
        const runNoRef = daemon.db.createRun({ goal: "Goal C", repoRoot, baseBranch: "main", baseSha });
        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C fallback check",
          description: "Falls back to local base tip when run has no merge ref",
          criteria: [{ id: "behavior", description: "Behavior verified", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalC.id, runNoRef.id);
        await daemon.director.verifyAndReviewGoal(goalC.id);
        assert.equal(fallbackCheckoutHead, mergedB.mergedSha);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(bareOrigin, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("rejects malformed verdict shapes in tool and text paths, retries with validation error, and never burns a cycle", async () => {
    // Unit-level strict validation checks across all malformed shapes, while keeping valid partial negative reviews allowed.
    assert.equal(normalizeReviewerVerdict({ verdict: "approved", criteriaResults: "not an array", summary: "ok" }), null);
    assert.equal(normalizeReviewerVerdict({ verdict: "approved", summary: "ok" }), null);
    assert.equal(
      normalizeReviewerVerdict({
        verdict: "approved",
        criteriaResults: [{ criterionId: "c1", passed: "true", evidence: "checked" }],
        summary: "ok",
      }),
      null,
    );
    assert.equal(
      normalizeReviewerVerdict({
        verdict: "approved",
        criteriaResults: [{ criterionId: "c1", passed: true }],
        summary: "ok",
      }),
      null,
    );
    assert.equal(
      normalizeReviewerVerdict({
        verdict: "approved",
        criteriaResults: [{ passed: true, evidence: "missing id" }],
        summary: "ok",
      }),
      null,
    );
    assert.equal(
      normalizeReviewerVerdict({
        verdict: "approved",
        criteriaResults: [{ criterionId: "c1", passed: true, evidence: "ok" }, { bad: true }],
        summary: "ok",
      }),
      null,
    );
    assert.equal(
      normalizeReviewerVerdict({
        verdict: "changes_requested",
        criteriaResults: [],
        blockingIssues: "not an array",
        summary: "ok",
      }),
      null,
    );
    assert.equal(
      normalizeReviewerVerdict({
        verdict: "changes_requested",
        criteriaResults: [],
        blockingIssues: [42],
        summary: "ok",
      }),
      null,
    );
    assert.equal(normalizeReviewerVerdict({ verdict: "approved", criteriaResults: [] }), null);
    assert.equal(normalizeReviewerVerdict({ verdict: "approved", criteriaResults: [], summary: "   " }), null);
    assert.equal(
      parseReviewerVerdictJson('```json\n{"verdict":"approved","criteriaResults":"not an array","summary":"ok"}\n```'),
      null,
    );
    // Partial but well-formed changes_requested verdict remains accepted.
    const validPartial = normalizeReviewerVerdict({
      verdict: "changes_requested",
      criteriaResults: [],
      blockingIssues: ["c1 still missing"],
      summary: "Partial review found missing c1.",
    });
    assert.equal(validPartial?.verdict, "changes_requested");

    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-state-"));
    const sockPath = join(stateDir, "d.sock");
    const prompts: string[] = [];

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            prompts.push(req.initialPrompt);
            if (prompts.length === 1) {
              await assert.rejects(
                () =>
                  req.executeTool("submit_review_verdict", {
                    verdict: "approved",
                    criteriaResults: "not an array",
                    summary: "malformed criteriaResults",
                  }),
                /criteriaResults must be an array/,
              );
              // Rejected malformed tool call leaves verdictBox empty (unsettled).
              assert.equal(req.isTaskSettled!(), false);
              // Also emit malformed fenced JSON in text — must also be rejected, never coerced.
              return {
                text: '```json\n{"verdict":"approved","criteriaResults":"not an array","summary":"malformed"}\n```',
                stopReason: "completed",
              };
            }
            // Attempt 2 also submits malformed criterion item (non-boolean passed) and ends without valid verdict.
            await assert.rejects(
              () =>
                req.executeTool("submit_review_verdict", {
                  verdict: "approved",
                  criteriaResults: [{ criterionId: "c1", passed: "yes", evidence: "checked" }],
                  summary: "non-boolean passed",
                }),
              /passed must be a boolean/,
            );
            assert.equal(req.isTaskSettled!(), false);
            return { text: "still no valid verdict", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Malformed verdict rejection goal",
          description: "Malformed criteriaResults must never record a review or burn a cycle",
          criteria: [{ id: "c1", description: "Behavior verified", kind: "behavioral", required: true }],
        });

        let caught: unknown = null;
        try {
          await daemon.director.verifyAndReviewGoal(goal.id);
        } catch (err) {
          caught = err;
        }

        assert.ok(caught instanceof ReviewerFailedError, `expected ReviewerFailedError, got ${String(caught)}`);
        assert.equal(caught.attempts, 2);
        assert.equal(prompts.length, 2, "must retry once after malformed verdict");
        assert.match(prompts[1]!, /criteriaResults must be an array/);
        assert.equal(daemon.director.goals.listReviews(goal.id).length, 0);
        const updatedGoal = daemon.director.goals.getGoal(goal.id)!;
        assert.equal(updatedGoal.reviewCycle, 0);
        assert.equal(updatedGoal.lastProgressFingerprint, null);
        assert.equal(updatedGoal.status, "awaiting_human");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("retries once on recoverable runner/stopReason failures, records one review on attempt 2 recovery, and never retries genuine cancellation", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-state-"));
    const sockPath = join(stateDir, "d.sock");

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      let mode: "throw-then-succeed" | "error-stop-twice" | "cancel-attempt-1" = "throw-then-succeed";
      const prompts: string[] = [];
      let cancelController: AbortController | null = null;

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            prompts.push(req.initialPrompt);
            if (mode === "throw-then-succeed") {
              if (prompts.length === 1) {
                throw new Error("ECONNRESET: transient reviewer transport failure");
              }
              await req.executeTool("submit_review_verdict", {
                verdict: "approved",
                criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Verified on attempt 2" }],
                blockingIssues: [],
                summary: "Recovered on attempt 2.",
              });
              return { text: "approved", stopReason: "completed" };
            }
            if (mode === "error-stop-twice") {
              if (prompts.length === 1) {
                return { text: "", stopReason: "error" };
              }
              return { text: "", stopReason: "" as never };
            }
            // mode === "cancel-attempt-1"
            cancelController!.abort(new Error("user cancelled review"));
            return { text: "", stopReason: "cancelled" };
          },
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });

        // 1. Runner throws on attempt 1 -> retried with error detail -> valid verdict on attempt 2 records exactly one review.
        const goalRecover = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Recoverable runner error goal",
          description: "Attempt 1 runner error recovers on attempt 2",
          criteria: [{ id: "c1", description: "Behavior verified", kind: "behavioral", required: true }],
        });
        const outcome = await daemon.director.verifyAndReviewGoal(goalRecover.id);
        assert.equal(prompts.length, 2);
        assert.match(prompts[1]!, /stopReason=runner_error/);
        assert.match(prompts[1]!, /ECONNRESET: transient reviewer transport failure/);
        assert.equal(outcome.review.verdict, "approved");
        assert.equal(outcome.goal.status, "achieved");
        assert.equal(outcome.goal.reviewCycle, 1);
        assert.equal(daemon.director.goals.listReviews(goalRecover.id).length, 1);

        // 2. Non-completed / empty stopReason across both attempts -> ReviewerFailedError with zero reviews and cycle unchanged.
        mode = "error-stop-twice";
        prompts.length = 0;
        const goalErrStop = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Errored stopReason twice goal",
          description: "Two errored/empty stopReasons fail as ReviewerFailedError without burning a cycle",
          criteria: [{ id: "c1", description: "Behavior verified", kind: "behavioral", required: true }],
        });
        let caughtErrStop: unknown = null;
        try {
          await daemon.director.verifyAndReviewGoal(goalErrStop.id);
        } catch (err) {
          caughtErrStop = err;
        }
        assert.ok(caughtErrStop instanceof ReviewerFailedError, `expected ReviewerFailedError, got ${String(caughtErrStop)}`);
        assert.equal(caughtErrStop.attempts, 2);
        assert.equal(prompts.length, 2);
        assert.match(prompts[1]!, /stopReason=error/);
        assert.match(caughtErrStop.detail, /stopReason=\(empty\)/);
        assert.equal(daemon.director.goals.listReviews(goalErrStop.id).length, 0);
        assert.equal(daemon.director.goals.getGoal(goalErrStop.id)?.reviewCycle, 0);
        assert.equal(daemon.director.goals.getGoal(goalErrStop.id)?.status, "awaiting_human");

        // 3. Genuine cancellation exits after attempt 1 with NO retry.
        mode = "cancel-attempt-1";
        prompts.length = 0;
        cancelController = new AbortController();
        const goalCancel = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Cancelled review goal",
          description: "Genuine cancellation must not retry",
          criteria: [{ id: "c1", description: "Behavior verified", kind: "behavioral", required: true }],
        });
        let caughtCancel: unknown = null;
        try {
          await daemon.director.verifyAndReviewGoal(goalCancel.id, cancelController.signal);
        } catch (err) {
          caughtCancel = err;
        }
        assert.ok(caughtCancel, "expected cancellation error");
        assert.equal(caughtCancel instanceof ReviewerFailedError, false, "genuine cancellation must not become ReviewerFailedError");
        assert.equal(prompts.length, 1, "genuine cancellation must not trigger attempt 2");
        assert.equal(daemon.director.goals.listReviews(goalCancel.id).length, 0);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("succeeds and records merge.promoted when refs/harness/merged/<runId>.lock is held, leaving ref and lock untouched", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-state-"));
    const sockPath = join(stateDir, "d.sock");
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const baseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async () => ({ text: "ok", stopReason: "completed" }),
        }),
      });

      await daemon.start();
      try {
        const wtMgr = daemon.orchestrator.getWorktreeManager(repoRoot);
        const mq = new BisectingMergeQueue(daemon.db, wtMgr, repoRoot, config.worktree, {
          gateShell: config.goals.gateShell,
          gateEnv: config.goals.gateEnv,
          stateDir,
        });

        const run = daemon.db.createRun({ goal: "Locked ref run", repoRoot, baseBranch: "main", baseSha });

        // Merge 1 lands sha1 and writes refs/harness/merged/<runId>.
        const task1 = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker 1",
          objective: "Add m1.txt",
          profileId: "fixture",
        });
        const wt1 = await wtMgr.createForWorker(run.id, task1.id, "main");
        writeFileSync(join(wt1.path, "m1.txt"), "one\n", "utf8");
        await runGit(wt1.path, ["add", "m1.txt"]);
        await runGit(wt1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: merge 1"]);
        daemon.db.enqueueMerge({ runId: run.id, taskId: task1.id, worktreeId: wt1.id, branch: wt1.branch });
        const merged1 = await mq.processNext(run.id);
        assert.ok(merged1?.mergedSha);

        const mergedRef = runMergedRef(run.id);
        const refAfter1 = (await runGit(repoRoot, ["rev-parse", "--verify", `${mergedRef}^{commit}`])).stdout;
        assert.equal(refAfter1, merged1.mergedSha);

        // Pre-create <ref>.lock to simulate another Git writer holding the lock during merge 2.
        const refFilePath = resolve(repoRoot, (await runGit(repoRoot, ["rev-parse", "--git-path", mergedRef])).stdout);
        const lockFilePath = `${refFilePath}.lock`;
        writeFileSync(lockFilePath, "other-writer-lock\n", "utf8");

        const task2 = daemon.db.createTask({
          runId: run.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker 2",
          objective: "Add m2.txt",
          profileId: "fixture",
        });
        const wt2 = await wtMgr.createForWorker(run.id, task2.id, "main");
        writeFileSync(join(wt2.path, "m2.txt"), "two\n", "utf8");
        await runGit(wt2.path, ["add", "m2.txt"]);
        await runGit(wt2.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: merge 2"]);
        daemon.db.enqueueMerge({ runId: run.id, taskId: task2.id, worktreeId: wt2.id, branch: wt2.branch });
        const merged2 = await mq.processNext(run.id);
        assert.equal(merged2?.item.status, "merged");
        assert.ok(merged2?.mergedSha);
        assert.notEqual(merged2.mergedSha, merged1.mergedSha);

        // Target branch advanced, while the pre-existing lock file and ref remain untouched.
        assert.equal((await runGit(repoRoot, ["rev-parse", "main"])).stdout, merged2.mergedSha);
        assert.equal(existsSync(lockFilePath), true, "pre-existing lock file must remain untouched");
        assert.equal(readFileSync(lockFilePath, "utf8"), "other-writer-lock\n");
        const refAfter2 = (await runGit(repoRoot, ["rev-parse", "--verify", `${mergedRef}^{commit}`])).stdout;
        assert.equal(refAfter2, merged1.mergedSha, "locked merge ref must remain untouched");

        // Warning logged and merge.ref_warning + merge.promoted events recorded with merge 2's sha.
        assert.ok(
          warnings.some((w) => w.includes(mergedRef)),
          `expected merge ref warning, got: ${JSON.stringify(warnings)}`,
        );
        const events = daemon.db.getEventsSince(run.id, 0);
        const refWarning = events.find((e) => e.type === "merge.ref_warning" && e.taskId === task2.id);
        assert.ok(refWarning, "expected merge.ref_warning event");
        const refWarningPayload = refWarning.payload as Record<string, unknown>;
        assert.equal(refWarningPayload.mergeId, merged2.item.id);
        assert.equal(refWarningPayload.ref, mergedRef);
        assert.equal(refWarningPayload.mergedSha, merged2.mergedSha);

        const promoted = events.find((e) => e.type === "merge.promoted" && e.taskId === task2.id);
        assert.ok(promoted, "expected merge.promoted event");
        const promotedPayload = promoted.payload as Record<string, unknown>;
        assert.equal(promotedPayload.mergeId, merged2.item.id);
        assert.equal(promotedPayload.mergedSha, merged2.mergedSha);
        assert.equal(promotedPayload.ref, mergedRef);
        assert.equal(promotedPayload.refUpdated, false);
      } finally {
        await daemon.stop();
      }
    } finally {
      console.warn = origWarn;
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("prepareVerifyCheckout rejects a stale packed merge ref older than the run's latest promoted merge even if packed-refs cleanup was locked", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-prov-state-"));
    const sockPath = join(stateDir, "d.sock");
    let verifyCheckoutHead = "";
    const origWarn = console.warn;
    console.warn = () => {};

    try {
      await runGit(repoRoot, ["config", "core.packedRefsTimeout", "50"]);
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            verifyCheckoutHead = (await runGit(req.cwd, ["rev-parse", "HEAD"])).stdout;
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "behavior", passed: true, evidence: `checked ${verifyCheckoutHead}` }],
              blockingIssues: [],
              summary: "Verified latest commit.",
            });
            return { text: "done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const wtMgr = daemon.orchestrator.getWorktreeManager(repoRoot);
        const mq = new BisectingMergeQueue(daemon.db, wtMgr, repoRoot, config.worktree);
        const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

        const runB = daemon.db.createRun({ goal: "Packed ref locked run B", repoRoot, baseBranch: "main", baseSha });
        const taskB1 = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker B1",
          objective: "Add b1.txt",
          profileId: "fixture",
        });
        const wtB1 = await wtMgr.createForWorker(runB.id, taskB1.id, "main");
        writeFileSync(join(wtB1.path, "b1.txt"), "b1\n", "utf8");
        await runGit(wtB1.path, ["add", "b1.txt"]);
        await runGit(wtB1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: b1"]);
        daemon.db.enqueueMerge({ runId: runB.id, taskId: taskB1.id, worktreeId: wtB1.id, branch: wtB1.branch });
        const mergedB1 = await mq.processNext(runB.id);
        assert.ok(mergedB1?.mergedSha);

        const refB = runMergedRef(runB.id);
        await runGit(repoRoot, ["pack-refs", "--all"]);
        const looseRefPathB = resolve(repoRoot, (await runGit(repoRoot, ["rev-parse", "--git-path", refB])).stdout);
        const packedRefsPath = resolve(repoRoot, (await runGit(repoRoot, ["rev-parse", "--git-path", "packed-refs"])).stdout);
        mkdirSync(dirname(looseRefPathB), { recursive: true });
        writeFileSync(`${looseRefPathB}.lock`, "locked\n", "utf8");
        writeFileSync(`${packedRefsPath}.lock`, "locked\n", "utf8");

        const taskB2 = daemon.db.createTask({
          runId: runB.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker B2",
          objective: "Add b2.txt",
          profileId: "fixture",
        });
        const wtB2 = await wtMgr.createForWorker(runB.id, taskB2.id, "main");
        writeFileSync(join(wtB2.path, "b2.txt"), "b2\n", "utf8");
        await runGit(wtB2.path, ["add", "b2.txt"]);
        await runGit(wtB2.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: b2"]);
        daemon.db.enqueueMerge({ runId: runB.id, taskId: taskB2.id, worktreeId: wtB2.id, branch: wtB2.branch });
        const mergedB2 = await mq.processNext(runB.id);
        assert.ok(mergedB2?.mergedSha);
        assert.notEqual(mergedB2.mergedSha, mergedB1.mergedSha);

        // Even though refB still resolves to stale mergedB1 because packed-refs.lock was held,
        // prepareVerifyCheckout refuses any ref older than the run's latest promoted merge SHA.
        assert.equal((await runGit(repoRoot, ["rev-parse", "--verify", `${refB}^{commit}`])).stdout, mergedB1.mergedSha);
        rmSync(`${packedRefsPath}.lock`, { force: true });

        const chat = await daemon.director.createChat({ repoRoot });
        const goalB = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Verify rejects stale packed ref via provenance",
          description: "Must verify merge B2, never stale packed merge B1",
          criteria: [{ id: "behavior", description: "Behavior verified", kind: "behavioral", required: true }],
        });
        daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
        await daemon.director.verifyAndReviewGoal(goalB.id);
        assert.equal(verifyCheckoutHead, mergedB2.mergedSha);
      } finally {
        await daemon.stop();
      }
    } finally {
      console.warn = origWarn;
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("prepareVerifyCheckout uses merge.promoted provenance over stale or missing merge refs even after an unpushed sibling merges onto main", async () => {
    const repoRoot = await makeTempRepo();
    const bareOrigin = mkdtempSync(join(tmpdir(), "pi-harness-g18-prov-origin-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g18-prov-comb-state-"));
    const sockPath = join(stateDir, "d.sock");
    const observedHeads: string[] = [];
    const origWarn = console.warn;
    console.warn = () => {};

    try {
      await runGit(bareOrigin, ["init", "--bare"]);
      await runGit(repoRoot, ["remote", "add", "origin", bareOrigin]);
      await runGit(repoRoot, ["push", "-u", "origin", "main"]);
      await runGit(repoRoot, ["config", "core.packedRefsTimeout", "50"]);

      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.kind !== "verify") return { text: "ok", stopReason: "completed" };
            const head = (await runGit(req.cwd, ["rev-parse", "HEAD"])).stdout;
            observedHeads.push(head);
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "behavior", passed: true, evidence: `checked ${head}` }],
              blockingIssues: [],
              summary: `Verified at ${head}.`,
            });
            return { text: "done", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      try {
        const wtMgr = daemon.orchestrator.getWorktreeManager(repoRoot);
        const mq = new BisectingMergeQueue(daemon.db, wtMgr, repoRoot, config.worktree);
        const initialBaseSha = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

        // Case 1: ref write fails on merge 2 due to pre-created locks (leaving a stale packed ref at merge 1),
        // merge 2 is pushed to origin/main, then an unpushed sibling merges onto local main.
        const runA = daemon.db.createRun({ goal: "Stale ref + sibling run A", repoRoot, baseBranch: "main", baseSha: initialBaseSha });
        const taskA1 = daemon.db.createTask({
          runId: runA.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker A1",
          objective: "Add a1.txt",
          profileId: "fixture",
        });
        const wtA1 = await wtMgr.createForWorker(runA.id, taskA1.id, "main");
        writeFileSync(join(wtA1.path, "a1.txt"), "a1\n", "utf8");
        await runGit(wtA1.path, ["add", "a1.txt"]);
        await runGit(wtA1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: a1"]);
        daemon.db.enqueueMerge({ runId: runA.id, taskId: taskA1.id, worktreeId: wtA1.id, branch: wtA1.branch });
        const mergedA1 = await mq.processNext(runA.id);
        assert.ok(mergedA1?.mergedSha);

        const refA = runMergedRef(runA.id);
        await runGit(repoRoot, ["pack-refs", "--all"]);
        const looseRefPathA = resolve(repoRoot, (await runGit(repoRoot, ["rev-parse", "--git-path", refA])).stdout);
        const packedRefsPath = resolve(repoRoot, (await runGit(repoRoot, ["rev-parse", "--git-path", "packed-refs"])).stdout);
        mkdirSync(dirname(looseRefPathA), { recursive: true });
        writeFileSync(`${looseRefPathA}.lock`, "locked\n", "utf8");
        writeFileSync(`${packedRefsPath}.lock`, "locked\n", "utf8");

        const taskA2 = daemon.db.createTask({
          runId: runA.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker A2",
          objective: "Add a2.txt",
          profileId: "fixture",
        });
        const wtA2 = await wtMgr.createForWorker(runA.id, taskA2.id, "main");
        writeFileSync(join(wtA2.path, "a2.txt"), "a2\n", "utf8");
        await runGit(wtA2.path, ["add", "a2.txt"]);
        await runGit(wtA2.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: a2"]);
        daemon.db.enqueueMerge({ runId: runA.id, taskId: taskA2.id, worktreeId: wtA2.id, branch: wtA2.branch });
        const mergedA2 = await mq.processNext(runA.id);
        assert.ok(mergedA2?.mergedSha);
        assert.notEqual(mergedA2.mergedSha, mergedA1.mergedSha);

        // Release locks for subsequent git commands while refA remains stale at mergedA1.
        rmSync(`${looseRefPathA}.lock`, { force: true });
        rmSync(`${packedRefsPath}.lock`, { force: true });
        assert.equal((await runGit(repoRoot, ["rev-parse", "--verify", `${refA}^{commit}`])).stdout, mergedA1.mergedSha);

        // Push Goal A's second merge commit to origin/main, then merge an unpushed sibling onto local main.
        await runGit(repoRoot, ["push", "origin", `${mergedA2.mergedSha}:refs/heads/main`]);

        const runSibling1 = daemon.db.createRun({
          goal: "Unpushed sibling 1",
          repoRoot,
          baseBranch: "main",
          baseSha: mergedA2.mergedSha,
        });
        const taskS1 = daemon.db.createTask({
          runId: runSibling1.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker S1",
          objective: "Add s1.txt",
          profileId: "fixture",
        });
        const wtS1 = await wtMgr.createForWorker(runSibling1.id, taskS1.id, "main");
        writeFileSync(join(wtS1.path, "s1.txt"), "unpushed sibling 1\n", "utf8");
        await runGit(wtS1.path, ["add", "s1.txt"]);
        await runGit(wtS1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: unpushed sibling 1"]);
        daemon.db.enqueueMerge({ runId: runSibling1.id, taskId: taskS1.id, worktreeId: wtS1.id, branch: wtS1.branch });
        const mergedS1 = await mq.processNext(runSibling1.id);
        assert.ok(mergedS1?.mergedSha);
        assert.notEqual(mergedS1.mergedSha, mergedA2.mergedSha);

        const localMainOnOrigin1 = await runGit(repoRoot, ["merge-base", "--is-ancestor", "main", "origin/main"])
          .then(() => true)
          .catch(() => false);
        assert.equal(localMainOnOrigin1, false, "local main should sit ahead of origin/main with unpushed sibling 1");

        const chat = await daemon.director.createChat({ repoRoot });
        const goalA = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal A shipped with stale merge ref + sibling",
          description: "Must verify promoted merge A2 even when refA is stale and local main has an unpushed sibling",
          criteria: [
            {
              id: "shipped",
              description: "Goal A's merge commit is on origin/main",
              kind: "deterministic",
              command: "git fetch -q origin && git merge-base --is-ancestor HEAD origin/main",
              required: true,
            },
            { id: "behavior", description: "Behavior verified", kind: "behavioral", required: true },
          ],
        });
        daemon.director.goals.linkRunAndStart(goalA.id, runA.id);

        const outcomeA = await daemon.director.verifyAndReviewGoal(goalA.id);
        assert.equal(observedHeads[0], mergedA2.mergedSha);
        assert.notEqual(observedHeads[0], mergedS1.mergedSha);
        assert.notEqual(observedHeads[0], mergedA1.mergedSha);
        assert.equal(outcomeA.review.verdict, "approved");
        assert.equal(outcomeA.goal.status, "achieved");
        const shippedA = outcomeA.review.criteriaResults.find((c) => c.criterionId === "shipped");
        assert.equal(shippedA?.passed, true);
        assert.equal(shippedA?.gate?.sha, mergedA2.mergedSha);

        // Case 2: ref write fails on merge 1 due to pre-created lock (so refs/harness/merged/<runId> does not exist at all),
        // followed by pushing the promoted merge and merging another unpushed sibling onto local main.
        const runC = daemon.db.createRun({ goal: "Missing ref + sibling run C", repoRoot, baseBranch: "main", baseSha: mergedS1.mergedSha });
        const refC = runMergedRef(runC.id);
        const looseRefPathC = resolve(repoRoot, (await runGit(repoRoot, ["rev-parse", "--git-path", refC])).stdout);
        mkdirSync(dirname(looseRefPathC), { recursive: true });
        writeFileSync(`${looseRefPathC}.lock`, "locked\n", "utf8");

        const taskC = daemon.db.createTask({
          runId: runC.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker C",
          objective: "Add c1.txt",
          profileId: "fixture",
        });
        const wtC = await wtMgr.createForWorker(runC.id, taskC.id, "main");
        writeFileSync(join(wtC.path, "c1.txt"), "c1\n", "utf8");
        await runGit(wtC.path, ["add", "c1.txt"]);
        await runGit(wtC.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: c1"]);
        daemon.db.enqueueMerge({ runId: runC.id, taskId: taskC.id, worktreeId: wtC.id, branch: wtC.branch });
        const mergedC = await mq.processNext(runC.id);
        assert.ok(mergedC?.mergedSha);
        rmSync(`${looseRefPathC}.lock`, { force: true });

        // Confirm refs/harness/merged/<runC.id> does not exist.
        const refCExists = await runGit(repoRoot, ["rev-parse", "--verify", `${refC}^{commit}`])
          .then(() => true)
          .catch(() => false);
        assert.equal(refCExists, false, "expected advisory merge ref to be absent after locked write");

        await runGit(repoRoot, ["push", "origin", `${mergedC.mergedSha}:refs/heads/main`]);

        const runSibling2 = daemon.db.createRun({
          goal: "Unpushed sibling 2",
          repoRoot,
          baseBranch: "main",
          baseSha: mergedC.mergedSha,
        });
        const taskS2 = daemon.db.createTask({
          runId: runSibling2.id,
          parentId: null,
          tier: 2,
          kind: "execute",
          title: "Worker S2",
          objective: "Add s2.txt",
          profileId: "fixture",
        });
        const wtS2 = await wtMgr.createForWorker(runSibling2.id, taskS2.id, "main");
        writeFileSync(join(wtS2.path, "s2.txt"), "unpushed sibling 2\n", "utf8");
        await runGit(wtS2.path, ["add", "s2.txt"]);
        await runGit(wtS2.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: unpushed sibling 2"]);
        daemon.db.enqueueMerge({ runId: runSibling2.id, taskId: taskS2.id, worktreeId: wtS2.id, branch: wtS2.branch });
        const mergedS2 = await mq.processNext(runSibling2.id);
        assert.ok(mergedS2?.mergedSha);
        assert.notEqual(mergedS2.mergedSha, mergedC.mergedSha);

        const goalC = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal C shipped with missing merge ref + sibling",
          description: "Must verify promoted merge C even when refC is missing and local main has an unpushed sibling",
          criteria: [
            {
              id: "shipped",
              description: "Goal C's merge commit is on origin/main",
              kind: "deterministic",
              command: "git fetch -q origin && git merge-base --is-ancestor HEAD origin/main",
              required: true,
            },
            { id: "behavior", description: "Behavior verified", kind: "behavioral", required: true },
          ],
        });
        daemon.director.goals.linkRunAndStart(goalC.id, runC.id);

        const outcomeC = await daemon.director.verifyAndReviewGoal(goalC.id);
        assert.equal(observedHeads[1], mergedC.mergedSha);
        assert.notEqual(observedHeads[1], mergedS2.mergedSha);
        assert.equal(outcomeC.review.verdict, "approved");
        assert.equal(outcomeC.goal.status, "achieved");
        const shippedC = outcomeC.review.criteriaResults.find((c) => c.criterionId === "shipped");
        assert.equal(shippedC?.passed, true);
        assert.equal(shippedC?.gate?.sha, mergedC.mergedSha);
      } finally {
        await daemon.stop();
      }
    } finally {
      console.warn = origWarn;
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(bareOrigin, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
