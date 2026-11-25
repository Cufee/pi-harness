import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { runGit } from "../src/worktree/manager.js";
import { mergedRef as runMergedRef } from "../src/storage/names.js";
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

        const mergedRef1 = runMergedRef({ ...run1, chatSessionId: g1.chatSessionId });
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
        await runGit(repoRoot, ["update-ref", runMergedRef({ ...runExplicit, chatSessionId: gExplicit.chatSessionId }), workSha]);

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

  it("fails closed with remedies when refs/harness/merged/<runId> is stale after base branch deletion without running gates, while still allowing goal_accept", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal19-stale-state-"));
    const sockPath = join(stateDir, "d.sock");
    const markerPath = join(stateDir, "gate-ran-marker");

    try {
      const mainSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

      await runGit(repoRoot, ["checkout", "-b", "stale-base"]);
      writeFileSync(join(repoRoot, "b1.txt"), "good at b1\n", "utf8");
      await runGit(repoRoot, ["add", "b1.txt"]);
      await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: b1"]);
      const b1Sha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

      rmSync(join(repoRoot, "b1.txt"));
      writeFileSync(join(repoRoot, "b2.txt"), "broken at b2\n", "utf8");
      await runGit(repoRoot, ["add", "-A"]);
      await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: b2"]);
      const b2Sha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
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
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Stale merged ref must fail closed after base deletion",
          description: "Do not approve broken B2 by verifying stale B1 ref",
          verificationMode: "deterministic",
          criteria: [
            {
              id: "c1",
              description: "b1.txt exists",
              kind: "deterministic",
              command: `touch "${markerPath}" && test -f b1.txt`,
              required: true,
            },
          ],
        });
        const run = daemon.db.createRun({ goal: goal.title, repoRoot, baseBranch: "stale-base", baseSha: mainSha });
        daemon.db.updateRunStatus(run.id, "completed");
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        // Ref stays stale at B1 while merge.promoted records B2, then base branch is deleted.
        const mergedRef = runMergedRef({ ...run, chatSessionId: goal.chatSessionId });
        await runGit(repoRoot, ["update-ref", mergedRef, b1Sha]);
        daemon.db.emitEvent(run.id, null, "merge.promoted", { mergedSha: b2Sha });
        await runGit(repoRoot, ["branch", "-D", "stale-base"]);

        await assert.rejects(
          () => daemon.director.verifyAndReviewGoal(goal.id),
          (err: unknown) => {
            assert.ok(err instanceof Error);
            assert.ok(err.message.includes("stale-base"), err.message);
            assert.ok(err.message.includes(mergedRef), err.message);
            assert.ok(err.message.includes("stale"), err.message);
            assert.ok(err.message.includes(b2Sha.slice(0, 7)), err.message);
            assert.ok(err.message.includes("goal_amend verify_ref"), err.message);
            assert.ok(err.message.includes("goal_trigger_review"), err.message);
            assert.ok(err.message.includes("override_deterministic"), err.message);
            return true;
          },
        );

        // No gate ran at the stale SHA.
        assert.equal(existsSync(markerPath), false, "gate must not execute against a stale merged ref");
        const afterFail = daemon.director.goals.getGoal(goal.id)!;
        assert.equal(afterFail.status, "awaiting_human");
        assert.ok(afterFail.lastReviewSummary?.includes(mergedRef), afterFail.lastReviewSummary ?? "");
        assert.ok(afterFail.lastReviewSummary?.includes("override_deterministic"), afterFail.lastReviewSummary ?? "");

        // goal_accept still succeeds without override_deterministic when checkout fails due to stale ref.
        const evidenceFile = join(repoRoot, "stale-accept-proof.txt");
        writeFileSync(evidenceFile, "verified externally\n", "utf8");
        const accepted = await daemon.director.acceptGoalOverride(goal.id, {
          reason: "Accepted after verifying B2 externally",
          evidencePaths: [evidenceFile],
          source: "director",
        });
        assert.equal(accepted.goal.status, "achieved");
        assert.equal(accepted.review.audit?.verifyRef, null);
        assert.ok(accepted.review.audit?.gatesNotRun?.includes(mergedRef), accepted.review.audit?.gatesNotRun ?? "");
        assert.equal(existsSync(markerPath), false, "goal_accept must not run gates when checkout failed");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("prevents a same-name tag from shadowing deleted-branch merged-ref fallback while keeping explicit verify_ref tag lookup", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal19-tag-state-"));
    const sockPath = join(stateDir, "d.sock");

    try {
      const mainSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

      await runGit(repoRoot, ["checkout", "-b", "release"]);
      writeFileSync(join(repoRoot, "old-tag.txt"), "tagged v1\n", "utf8");
      await runGit(repoRoot, ["add", "old-tag.txt"]);
      await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "v1"]);
      const tagSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      await runGit(repoRoot, ["tag", "release", tagSha]);

      writeFileSync(join(repoRoot, "delivered.txt"), "delivered on release\n", "utf8");
      await runGit(repoRoot, ["add", "delivered.txt"]);
      await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "deliver work"]);
      const deliveredSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
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

        // Implicit recorded branch `release` deleted while tag `release` still exists at old commit.
        const gImplicit = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Tag must not shadow deleted base branch",
          description: "Must fall back to refs/harness/merged/<runId> instead of resolving tag release",
          verificationMode: "deterministic",
          criteria: [
            {
              id: "c1",
              description: "delivered.txt exists at HARNESS_VERIFY_SHA",
              kind: "deterministic",
              command: 'test -f delivered.txt && test "$(git rev-parse HEAD)" = "$HARNESS_VERIFY_SHA"',
              required: true,
            },
          ],
        });
        const run1 = daemon.db.createRun({ goal: gImplicit.title, repoRoot, baseBranch: "release", baseSha: mainSha });
        daemon.db.updateRunStatus(run1.id, "completed");
        daemon.director.goals.linkRunAndStart(gImplicit.id, run1.id);

        const mergedRef = runMergedRef({ ...run1, chatSessionId: gImplicit.chatSessionId });
        await runGit(repoRoot, ["update-ref", mergedRef, deliveredSha]);
        daemon.db.emitEvent(run1.id, null, "merge.promoted", { mergedSha: deliveredSha });
        await runGit(repoRoot, ["branch", "-D", "release"]);

        // Sanity check: bare rev-parse resolves the tag to tagSha, not deliveredSha.
        assert.equal((await runGit(repoRoot, ["rev-parse", "--verify", "release^{commit}"])).stdout, tagSha);

        const resImplicit = await daemon.director.verifyAndReviewGoal(gImplicit.id);
        assert.equal(resImplicit.review.verdict, "approved");
        assert.equal(resImplicit.goal.status, "achieved");
        const gateImplicit = resImplicit.review.criteriaResults[0]?.gate;
        assert.ok(gateImplicit);
        assert.equal(gateImplicit.source, "merged_commit");
        assert.equal(gateImplicit.sha, deliveredSha);
        assert.equal(gateImplicit.ref, mergedRef);
        assert.equal(gateImplicit.isolated, true);

        // Explicit verify_ref still resolves tags generically.
        const gExplicitTag = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Explicit verify_ref resolves tag generically",
          description: "Explicit verify_ref=release should resolve tag release",
          verifyRef: "release",
          verificationMode: "deterministic",
          criteria: [
            {
              id: "c1",
              description: "old-tag.txt exists and delivered.txt absent at tagSha",
              kind: "deterministic",
              command: 'test -f old-tag.txt && test ! -f delivered.txt && test "$(git rev-parse HEAD)" = "$HARNESS_VERIFY_SHA"',
              required: true,
            },
          ],
        });
        const run2 = daemon.db.createRun({ goal: gExplicitTag.title, repoRoot, baseBranch: "main", baseSha: mainSha });
        daemon.db.updateRunStatus(run2.id, "completed");
        daemon.director.goals.linkRunAndStart(gExplicitTag.id, run2.id);

        const resExplicit = await daemon.director.verifyAndReviewGoal(gExplicitTag.id);
        assert.equal(resExplicit.review.verdict, "approved");
        assert.equal(resExplicit.goal.status, "achieved");
        const gateExplicit = resExplicit.review.criteriaResults[0]?.gate;
        assert.ok(gateExplicit);
        assert.equal(gateExplicit.source, "verify_ref");
        assert.equal(gateExplicit.sha, tagSha);
        assert.equal(gateExplicit.ref, "release");
        assert.equal(gateExplicit.isolated, true);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("runs deterministic gates directly in a plain non-Git folder without a deleted-branch error", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "pi-harness-goal19-plain-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal19-plain-state-"));
    const sockPath = join(stateDir, "d.sock");

    try {
      writeFileSync(join(plainDir, "plain-artifact.txt"), "plain folder work\n", "utf8");

      const baseCfg = loadConfig(plainDir);
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
        const wtMgr = daemon.orchestrator.getWorktreeManager(plainDir);
        assert.equal(wtMgr.isGitRepo(), false);
        const repoInfo = await wtMgr.resolveRepoInfo();
        assert.deepEqual(repoInfo, { baseBranch: "workspace", baseSha: "none" });

        const chat = await daemon.director.createChat({ repoRoot: plainDir });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot: plainDir,
          title: "Plain folder deterministic verification",
          description: "Gates run in non-Git folder without deleted-branch failure",
          verificationMode: "deterministic",
          criteria: [
            {
              id: "c1",
              description: "plain-artifact.txt exists in folder",
              kind: "deterministic",
              command: 'test -f plain-artifact.txt && test "$(pwd -P)" = "$(cd "$HARNESS_REPO_ROOT" && pwd -P)"',
              required: true,
            },
          ],
        });
        const run = daemon.db.createRun({
          goal: goal.title,
          repoRoot: plainDir,
          baseBranch: repoInfo.baseBranch,
          baseSha: repoInfo.baseSha,
        });
        daemon.db.updateRunStatus(run.id, "completed");
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const res = await daemon.director.verifyAndReviewGoal(goal.id);
        assert.equal(res.review.verdict, "approved");
        assert.equal(res.goal.status, "achieved");
        const gate = res.review.criteriaResults[0]?.gate;
        assert.ok(gate);
        assert.equal(gate.source, "repo_root");
        assert.equal(gate.isolated, false);
        assert.equal(gate.cwd, plainDir);
        assert.equal(gate.ref, "workspace");
        assert.equal(gate.sha, "");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
