import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { GoalEngine, type GoalRecord } from "../src/goals/engine.js";
import {
  filterProgressPatch,
  isCurrentClaim,
  mergeGoalLiveProgress,
} from "../src/goals/live-progress.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, baseSha };
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: "goal-17",
    chatSessionId: "chat-1",
    repoRoot: "/tmp/repo",
    version: 2,
    title: "Goal 17 r2 progress test",
    description: "Verify stale worker ordinary phase updates on current evidence rows",
    criteria: [
      { id: "A", description: "Criterion A", kind: "behavioral", required: true },
      { id: "B", description: "Criterion B", kind: "behavioral", required: true },
    ],
    nonGoals: [],
    budgets: { maxReviewCycles: 10, maxNoProgressCycles: 3 },
    verificationMode: "auto",
    verifyRef: "main",
    liveProgress: null,
    status: "executing",
    linkedRunId: "run-1",
    reviewCycle: 0,
    noProgressStreak: 0,
    lastProgressFingerprint: null,
    lastReviewSummary: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

describe("goal-17 r2: stale worker ordinary phase updates", () => {
  it("applies a stale worker's ordinary phase and summary after current evidence without restamping claims", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g17-r2-progress-");
    const stateDir = join(root, "state");

    const db = new ControlPlaneDb(":memory:");
    const goals = new GoalEngine(db.db);
    const config = withFixtureCatalog({
      ...loadConfig(repoRoot),
      stateDir,
      codeMode: "off",
    });
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const orch = new HarnessOrchestrator(db, config, catalog, quota, () => ({
      run: async () => ({ text: "ok", stopReason: "completed" }),
    }));

    try {
      const v1Goal = goals.createGoal({
        chatSessionId: "chat-g17-r2",
        repoRoot,
        title: "Goal 17 r2 stale ordinary phase",
        description: "Reproduce Astra race order: v2 evidence + building, then stale v1 testing + summary",
        criteria: [
          { id: "A", description: "Criterion A", kind: "behavioral", required: true },
          { id: "B", description: "Criterion B", kind: "behavioral", required: true },
        ],
      });
      const run = db.createRun({ goal: v1Goal.title, repoRoot, baseBranch: "main", baseSha });
      goals.linkRunAndStart(v1Goal.id, run.id);

      const t1 = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(t1.id, { status: "running" });

      // Stale worker bound to v1 before amendment.
      const staleWorker = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Stale v1 worker",
        objective: "Started on v1",
        profileId: "pi:local",
        model: "fixture/fixture",
        goalVersion: 1,
      });

      // Amend goal to v2 and spawn a current v2 worker.
      goals.amendGoal(v1Goal.id, {
        updateCriteria: [{ id: "A", description: "Criterion A (v2)" }],
        rationale: "Update A for v2",
      });
      const currentWorker = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Current v2 worker",
        objective: "Started on v2",
        profileId: "pi:local",
        model: "fixture/fixture",
        goalVersion: 2,
      });

      // 1. Current v2 worker reports criterion result A + phase "building".
      const v2Res = (await orch.toolExecutor.execute(run.id, currentWorker.id, "report_goal_progress", {
        phase: "building",
        summary: "v2 worker built A",
        criteria_results: [{ criterion_id: "A", passed: true, evidence: "verified against v2" }],
      })) as { recorded: boolean; dropped?: unknown[]; note?: string };
      assert.equal(v2Res.recorded, true);
      assert.equal(v2Res.dropped, undefined);

      const afterV2 = goals.getGoal(v1Goal.id)!;
      assert.equal(afterV2.liveProgress?.phase, "building");
      assert.equal(afterV2.liveProgress?.goalVersion, 2);
      assert.equal(afterV2.liveProgress?.reporterGoalVersion, 2);
      assert.equal(afterV2.liveProgress?.reportedByTaskId, currentWorker.id);
      const originalClaimedAt = afterV2.liveProgress?.claimedAt;
      assert.ok(typeof originalClaimedAt === "number");

      // 2. Stale v1 worker reports ordinary phase "testing" + summary (Astra's exact repro).
      const staleOrdinaryRes = (await orch.toolExecutor.execute(run.id, staleWorker.id, "report_goal_progress", {
        phase: "testing",
        summary: "v1 worker running tests",
      })) as { recorded: boolean; dropped?: unknown[]; note?: string };
      assert.equal(staleOrdinaryRes.recorded, true);
      assert.equal(staleOrdinaryRes.dropped, undefined);
      assert.equal(staleOrdinaryRes.note, undefined);

      const afterStaleOrdinary = goals.getGoal(v1Goal.id)!;
      assert.equal(afterStaleOrdinary.liveProgress?.phase, "testing");
      assert.equal(afterStaleOrdinary.liveProgress?.summary, "v1 worker running tests");
      assert.deepEqual(afterStaleOrdinary.liveProgress?.criteriaResults, [
        { criterionId: "A", passed: true, evidence: "verified against v2" },
      ]);
      assert.equal(afterStaleOrdinary.liveProgress?.goalVersion, 2);
      assert.equal(afterStaleOrdinary.liveProgress?.reporterGoalVersion, 2);
      assert.equal(afterStaleOrdinary.liveProgress?.reportedByTaskId, currentWorker.id);
      assert.equal(afterStaleOrdinary.liveProgress?.claimedAt, originalClaimedAt);
      assert.equal(isCurrentClaim(afterStaleOrdinary, afterStaleOrdinary.liveProgress), true);

      // 3. Stale v1 worker sends mixed report (ordinary phase + summary + dropped passed/criteriaResults):
      //    ordinary phase & summary apply, protected v2 evidence stays untouched, and note says what was kept.
      const staleMixedRes = (await orch.toolExecutor.execute(run.id, staleWorker.id, "report_goal_progress", {
        phase: "verifying",
        summary: "v1 worker finishing checks",
        verification_status: "passed",
        criteria_results: [{ criterion_id: "B", passed: true, evidence: "v1 check" }],
      })) as {
        recorded: boolean;
        dropped?: Array<{ field: string; value: string }>;
        note?: string;
      };
      assert.equal(staleMixedRes.recorded, true);
      assert.equal(staleMixedRes.dropped?.length, 2);
      assert.ok(staleMixedRes.note?.includes("phase verifying"), `expected kept phase in note, got: ${staleMixedRes.note}`);
      assert.ok(staleMixedRes.note?.includes("summary"), `expected kept summary in note, got: ${staleMixedRes.note}`);

      const afterStaleMixed = goals.getGoal(v1Goal.id)!;
      assert.equal(afterStaleMixed.liveProgress?.phase, "verifying");
      assert.equal(afterStaleMixed.liveProgress?.summary, "v1 worker finishing checks");
      assert.equal(afterStaleMixed.liveProgress?.verificationStatus, undefined);
      assert.deepEqual(afterStaleMixed.liveProgress?.criteriaResults, [
        { criterionId: "A", passed: true, evidence: "verified against v2" },
      ]);
      assert.equal(afterStaleMixed.liveProgress?.goalVersion, 2);
      assert.equal(afterStaleMixed.liveProgress?.reporterGoalVersion, 2);
      assert.equal(afterStaleMixed.liveProgress?.reportedByTaskId, currentWorker.id);
      assert.equal(afterStaleMixed.liveProgress?.claimedAt, originalClaimedAt);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("filterProgressPatch note states kept ordinary phase and summary alongside dropped stale claims", () => {
    const criterionIds = new Set(["A", "B"]);
    const res = filterProgressPatch(
      {
        phase: "testing",
        summary: "v1 worker running checks",
        verificationStatus: "passed",
        criteriaResults: [{ criterionId: "A", passed: true, evidence: "v1 evidence" }],
      },
      { goalId: "goal-17", criterionIds, boundVersion: 1, currentVersion: 2 },
    );

    assert.equal(res.patch.phase, "testing");
    assert.equal(res.patch.summary, "v1 worker running checks");
    assert.equal(res.patch.verificationStatus, undefined);
    assert.equal(res.patch.criteriaResults, undefined);
    assert.equal(res.dropped.length, 2);
    assert.ok(res.note?.includes("Kept phase testing and summary"), `unexpected note: ${res.note}`);
    assert.ok(res.note?.includes("criteria A ignored"));
    assert.ok(res.note?.includes("verification_status passed ignored"));
  });

  it("still protects current claims from stale blocked/completed phases and verification downgrades", () => {
    const v2Goal = makeGoal({ version: 2 });

    // Current v2 row with authoritative passed status + criterion A + ordinary phase "building".
    const currentPassed = mergeGoalLiveProgress(
      null,
      {
        phase: "building",
        summary: "v2 passed",
        verificationStatus: "passed",
        criteriaResults: [{ criterionId: "A", passed: true, evidence: "v2 ok" }],
        reportedByTaskId: "t-orch",
      },
      { goalVersion: 2, reporterGoalVersion: 2, runId: "run-1", reviewCycle: 0, source: "coordinator", now: 100 },
    );

    // Unknown-version (v0) stale worker sending ordinary phase updates phase without altering claims or provenance.
    const afterUnknownOrdinary = mergeGoalLiveProgress(
      currentPassed,
      { phase: "testing", summary: "v0 running tests", reportedByTaskId: "t-v0" },
      { goalVersion: 2, reporterGoalVersion: 0, runId: "run-1", reviewCycle: 0, source: "worker", now: 150 },
    );
    assert.equal(afterUnknownOrdinary.phase, "testing");
    assert.equal(afterUnknownOrdinary.summary, "v0 running tests");
    assert.equal(afterUnknownOrdinary.verificationStatus, "passed");
    assert.equal(afterUnknownOrdinary.source, "coordinator");
    assert.equal(afterUnknownOrdinary.verificationSource, "coordinator");
    assert.equal(afterUnknownOrdinary.reportedByTaskId, "t-orch");
    assert.equal(afterUnknownOrdinary.claimedAt, 100);
    assert.equal(isCurrentClaim(v2Goal, afterUnknownOrdinary), true);

    // Stale v1 worker sending phase "blocked" + verificationStatus "failed" cannot overwrite current claims or phase.
    const afterStaleBlocked = mergeGoalLiveProgress(
      afterUnknownOrdinary,
      {
        phase: "blocked",
        summary: "v1 stuck",
        verificationStatus: "failed",
        criteriaResults: [{ criterionId: "B", passed: false, evidence: "v1 fail" }],
        reportedByTaskId: "t-v1",
      },
      { goalVersion: 2, reporterGoalVersion: 1, runId: "run-1", reviewCycle: 0, source: "worker", now: 200 },
    );
    assert.equal(afterStaleBlocked.phase, "testing");
    assert.equal(afterStaleBlocked.verificationStatus, "passed");
    assert.deepEqual(afterStaleBlocked.criteriaResults, [{ criterionId: "A", passed: true, evidence: "v2 ok" }]);
    assert.equal(afterStaleBlocked.reportedByTaskId, "t-orch");
    assert.equal(afterStaleBlocked.claimedAt, 100);

    // Stale v1 worker sending phase "completed" is dropped and keeps existing phase.
    const afterStaleCompleted = mergeGoalLiveProgress(
      afterUnknownOrdinary,
      { phase: "completed", summary: "v1 done", reportedByTaskId: "t-v1" },
      { goalVersion: 2, reporterGoalVersion: 1, runId: "run-1", reviewCycle: 0, source: "worker", now: 250 },
    );
    assert.equal(afterStaleCompleted.phase, "testing");
    assert.equal(afterStaleCompleted.verificationStatus, "passed");
    assert.equal(afterStaleCompleted.claimedAt, 100);

    // Current v2 row in phase "blocked" cannot be cleared by a stale worker's ordinary phase.
    const currentBlocked = mergeGoalLiveProgress(
      null,
      { phase: "blocked", summary: "v2 blocked on dep", reportedByTaskId: "t-v2" },
      { goalVersion: 2, reporterGoalVersion: 2, runId: "run-1", reviewCycle: 0, source: "worker", now: 300 },
    );
    const afterStaleOverBlocked = mergeGoalLiveProgress(
      currentBlocked,
      { phase: "testing", summary: "v1 testing", reportedByTaskId: "t-v1" },
      { goalVersion: 2, reporterGoalVersion: 1, runId: "run-1", reviewCycle: 0, source: "worker", now: 350 },
    );
    assert.equal(afterStaleOverBlocked.phase, "blocked");
    assert.equal(afterStaleOverBlocked.reportedByTaskId, "t-v2");
    assert.equal(afterStaleOverBlocked.claimedAt, 300);
  });
});
