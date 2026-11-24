import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { runGit } from "../src/worktree/manager.js";
import { runMergedRef } from "../src/worktree/merge-queue.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-goal19-deleted-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "status.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

describe("goal-19 v2: deleted base branch gate fallback and goal_accept resilience", () => {
  it("falls back to refs/harness/merged/<runId> when base branch is deleted, fails closed with remedies when neither exists or explicit verify_ref is unresolved, and lets goal_accept proceed with gatesNotRun", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal19-deleted-state-"));
    const sockPath = join(stateDir, "d.sock");

    try {
      const mainSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

      // Create branch `goal-base` with a commit adding work.txt, record its SHA, then return to main.
      await runGit(repoRoot, ["checkout", "-b", "goal-base"]);
      writeFileSync(join(repoRoot, "work.txt"), "delivered work\n", "utf8");
      await runGit(repoRoot, ["add", "work.txt"]);
      await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add work.txt"]);
      const workSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      await runGit(repoRoot, ["checkout", "main"]);

      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async () => ({ text: "idle", stopReason: "completed" }),
        }),
      });

      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });

        // 1. Deleted base branch WITH refs/harness/merged/<runId> -> fallback to merged_commit.
        const g1 = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Fallback to merged commit when base branch deleted",
          description: "Verify work.txt at merged commit after goal-base is deleted",
          verificationMode: "deterministic",
          criteria: [
            {
              id: "c1",
              description: "work.txt exists at HARNESS_VERIFY_SHA",
              kind: "deterministic",
              command: 'test -f work.txt && test "$(git rev-parse HEAD)" = "$HARNESS_VERIFY_SHA"',
              required: true,
            },
          ],
        });
        const run1 = daemon.db.createRun({ goal: g1.title, repoRoot, baseBranch: "goal-base", baseSha: mainSha });
        daemon.db.updateRunStatus(run1.id, "completed");
        daemon.director.goals.linkRunAndStart(g1.id, run1.id);

        const mergedRef1 = runMergedRef(run1.id);
        await runGit(repoRoot, ["update-ref", mergedRef1, workSha]);
        await runGit(repoRoot, ["branch", "-D", "goal-base"]);

        const g1Res = await daemon.director.verifyAndReviewGoal(g1.id);
        assert.equal(g1Res.review.verdict, "approved");
        assert.equal(g1Res.goal.status, "achieved");
        const g1Gate = g1Res.review.criteriaResults[0]?.gate;
        assert.ok(g1Gate, "expected gate location recorded on criterion evaluation");
        assert.equal(g1Gate.source, "merged_commit");
        assert.equal(g1Gate.sha, workSha);
        assert.equal(g1Gate.ref, mergedRef1);
        assert.equal(g1Gate.isolated, true);
        assert.ok(g1Gate.note?.includes("goal-base"), `expected deleted base branch in note: ${g1Gate.note}`);
        assert.ok(g1Gate.note?.includes("no longer exists"), `expected missing-branch phrasing in note: ${g1Gate.note}`);
        assert.ok(g1Gate.note?.includes(workSha.slice(0, 7)), `expected short SHA in note: ${g1Gate.note}`);
        assert.ok(g1Gate.note?.includes(mergedRef1), `expected merged ref in note: ${g1Gate.note}`);

        // Primary checkout untouched and _verify worktree removed.
        assert.equal((await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout, "main");
        assert.equal(existsSync(join(repoRoot, "work.txt")), false);
        assert.equal((await runGit(repoRoot, ["worktree", "list", "--porcelain"])).stdout.includes("_verify"), false);
        assert.equal(existsSync(g1Gate.cwd), false);

        // Explicit verify_ref still fails closed even when refs/harness/merged/<runId> exists.
        const gExplicit = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Explicit verify_ref fails closed even with merged ref",
          description: "Do not substitute merged_commit for an explicit unresolved verify_ref",
          verifyRef: "missing-explicit-ref",
          verificationMode: "deterministic",
          criteria: [{ id: "c1", description: "Always true", kind: "deterministic", command: "true", required: true }],
        });
        const runExplicit = daemon.db.createRun({ goal: gExplicit.title, repoRoot, baseBranch: "goal-base", baseSha: mainSha });
        daemon.db.updateRunStatus(runExplicit.id, "completed");
        daemon.director.goals.linkRunAndStart(gExplicit.id, runExplicit.id);
        await runGit(repoRoot, ["update-ref", runMergedRef(runExplicit.id), workSha]);

        await assert.rejects(
          () => daemon.director.verifyAndReviewGoal(gExplicit.id),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes("missing-explicit-ref"), err.message);
            assert.ok(err.message.includes("does not resolve"), err.message);
            assert.ok(err.message.includes("goal_amend verify_ref"), err.message);
            assert.ok(err.message.includes("override_deterministic"), err.message);
            return true;
          },
        );
        const explicitAfter = daemon.director.goals.getGoal(gExplicit.id)!;
        assert.equal(explicitAfter.status, "awaiting_human");
        assert.ok(explicitAfter.lastReviewSummary?.includes("override_deterministic"), explicitAfter.lastReviewSummary ?? "");

        // 2. Deleted base branch WITHOUT merged ref -> fails with full unsliced error naming missing ref, run, and remedies.
        const longMissingBranch = "gone-branch-with-a-long-feature-name-to-ensure-no-240-char-truncation";
        const g2 = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Missing base branch with no merged commit",
          description: "Should fail verification with unsliced remedies",
          verificationMode: "deterministic",
          criteria: [{ id: "c1", description: "status.txt exists", kind: "deterministic", command: "test -f status.txt", required: true }],
        });
        const run2 = daemon.db.createRun({ goal: g2.title, repoRoot, baseBranch: longMissingBranch, baseSha: mainSha });
        daemon.db.updateRunStatus(run2.id, "completed");
        daemon.director.goals.linkRunAndStart(g2.id, run2.id);

        await assert.rejects(
          () => daemon.director.verifyAndReviewGoal(g2.id),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes(longMissingBranch), err.message);
            assert.ok(err.message.includes(run2.id), err.message);
            assert.ok(err.message.includes("goal_amend verify_ref"), err.message);
            assert.ok(err.message.includes("goal_trigger_review"), err.message);
            assert.ok(err.message.includes("override_deterministic"), err.message);
            return true;
          },
        );
        const g2AfterFail = daemon.director.goals.getGoal(g2.id)!;
        assert.equal(g2AfterFail.status, "awaiting_human");
        const summary = g2AfterFail.lastReviewSummary ?? "";
        assert.ok(summary.length > 240, `expected unsliced error summary > 240 chars, got ${summary.length}: ${summary}`);
        assert.ok(summary.includes(longMissingBranch), summary);
        assert.ok(summary.includes(run2.id), summary);
        assert.ok(summary.includes("goal_amend verify_ref"), summary);
        assert.ok(summary.includes("goal_trigger_review"), summary);
        assert.ok(summary.includes("override_deterministic"), summary);

        // 3. goal_accept succeeds without override_deterministic when gate checkout cannot be prepared, recording gatesNotRun.
        const evidenceFile = join(repoRoot, "acceptance-proof.txt");
        writeFileSync(evidenceFile, "verified manually after PR squash-merge\n", "utf8");

        const accepted = await daemon.director.acceptGoalOverride(g2.id, {
          reason: "Work already squash-merged and verified manually",
          evidencePaths: [evidenceFile],
          source: "director",
        });
        assert.equal(accepted.goal.status, "achieved");
        assert.equal(accepted.review.source, "director_accept_override");
        assert.equal(accepted.review.audit?.verifyRef, null);
        assert.ok(
          accepted.review.audit?.gatesNotRun?.includes(longMissingBranch),
          `expected audit.gatesNotRun to mention missing branch, got ${accepted.review.audit?.gatesNotRun}`,
        );
        assert.ok(accepted.review.summary.includes("gates not run"), accepted.review.summary);
        assert.ok(
          accepted.review.criteriaResults[0]?.evidence.includes("gates not run"),
          accepted.review.criteriaResults[0]?.evidence ?? "",
        );
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
