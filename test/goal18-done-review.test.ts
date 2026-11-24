import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { ReviewerFailedError } from "../src/director/runtime.js";
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
});
