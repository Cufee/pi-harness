import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { GoalRecord } from "../src/goals/engine.js";
import {
  filterProgressPatch,
  isCurrentClaim,
  mergeGoalLiveProgress,
  type GoalLiveProgress,
} from "../src/goals/live-progress.js";
import { deriveGoalVerificationLabel, reconcileGoalWithLiveRun } from "../src/protocol/tool-display.js";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: "goal-17",
    chatSessionId: "chat-1",
    repoRoot: "/tmp/repo",
    version: 2,
    title: "Goal 17 provenance test",
    description: "Verify stale progress provenance filtering",
    criteria: [
      { id: "A", description: "Criterion A (modified in v2)", kind: "behavioral", required: true },
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

describe("goal-17 progress provenance", () => {
  it("A: drops v1-bound evidence so a subsequent v2 report cannot resurrect criterion A as a v2 pass", () => {
    const criterionIds = new Set(["A", "B"]);

    // Filter path: v1-bound worker reports pass on still-present (modified in v2) criterion A.
    const filteredV1 = filterProgressPatch(
      {
        summary: "v1 worker checked A",
        phase: "completed",
        verificationStatus: "passed",
        criteriaResults: [{ criterionId: "A", passed: true, evidence: "checked against v1" }],
      },
      { goalId: "goal-17", criterionIds, boundVersion: 1, currentVersion: 2 },
    );
    assert.equal(filteredV1.patch.criteriaResults, undefined);
    assert.equal(filteredV1.patch.verificationStatus, undefined);
    assert.equal(filteredV1.patch.phase, undefined);
    assert.equal(filteredV1.patch.summary, "v1 worker checked A");
    assert.equal(filteredV1.dropped.length, 3);
    assert.ok(filteredV1.note?.includes("A") && filteredV1.note.includes("v1") && filteredV1.note.includes("v2"));

    // Pure merge path (Astra's direct repro without prior filterProgressPatch):
    // 1. v1-bound worker reports A passed on a v2 goal.
    const afterV1 = mergeGoalLiveProgress(
      null,
      {
        summary: "v1 worker checked A",
        criteriaResults: [{ criterionId: "A", passed: true, evidence: "checked against v1" }],
        reportedByTaskId: "t-v1",
      },
      { goalVersion: 2, reporterGoalVersion: 1, runId: "run-1", reviewCycle: 0, source: "worker", now: 100 },
    );
    assert.equal(afterV1.criteriaResults, undefined);
    assert.equal(afterV1.summary, "v1 worker checked A");

    // 2. v2-bound reporter reports B passed.
    const afterV2 = mergeGoalLiveProgress(
      afterV1,
      {
        summary: "v2 worker checked B",
        criteriaResults: [{ criterionId: "B", passed: true, evidence: "checked against v2" }],
        reportedByTaskId: "t-v2",
      },
      { goalVersion: 2, reporterGoalVersion: 2, runId: "run-1", reviewCycle: 0, source: "worker", now: 200 },
    );
    assert.deepEqual(afterV2.criteriaResults, [{ criterionId: "B", passed: true, evidence: "checked against v2" }]);
    assert.equal(afterV2.goalVersion, 2);
    assert.equal(afterV2.reporterGoalVersion, 2);

    // Pre-existing stored row from a v1 reporter (e.g. written before this fix):
    // merging a v2 claim must drop the stored v1 criterion A and stale completed phase first.
    const preExistingStaleRow: GoalLiveProgress = {
      phase: "completed",
      summary: "legacy v1 pass",
      verificationStatus: "in_progress",
      criteriaResults: [{ criterionId: "A", passed: true, evidence: "v1 evidence" }],
      reportedByTaskId: "t-v1",
      goalVersion: 2,
      reporterGoalVersion: 1,
      runId: "run-1",
      reviewCycle: 0,
      source: "worker",
      updatedAt: 150,
    };
    const mergedOverStale = mergeGoalLiveProgress(
      preExistingStaleRow,
      {
        criteriaResults: [{ criterionId: "B", passed: true, evidence: "v2 evidence" }],
        reportedByTaskId: "t-v2",
      },
      { goalVersion: 2, reporterGoalVersion: 2, runId: "run-1", reviewCycle: 0, source: "worker", now: 300 },
    );
    assert.deepEqual(mergedOverStale.criteriaResults, [{ criterionId: "B", passed: true, evidence: "v2 evidence" }]);
    assert.equal(mergedOverStale.phase, undefined);
    assert.equal(mergedOverStale.verificationStatus, undefined);
    assert.equal(mergedOverStale.goalVersion, 2);
    assert.equal(mergedOverStale.reporterGoalVersion, 2);

    // Reverse order: a stale v1 reporter arriving after a current v2 claim cannot downgrade or corrupt it.
    const currentV2 = mergeGoalLiveProgress(
      null,
      {
        phase: "completed",
        summary: "v2 verified",
        verificationStatus: "passed",
        criteriaResults: [{ criterionId: "B", passed: true, evidence: "v2 ok" }],
        reportedByTaskId: "t-v2",
      },
      { goalVersion: 2, reporterGoalVersion: 2, runId: "run-1", reviewCycle: 0, source: "worker", now: 400 },
    );
    const afterLateV1 = mergeGoalLiveProgress(
      currentV2,
      {
        phase: "blocked",
        summary: "late v1 note",
        verificationStatus: "failed",
        criteriaResults: [{ criterionId: "A", passed: true, evidence: "late v1" }],
        reportedByTaskId: "t-v1",
      },
      { goalVersion: 2, reporterGoalVersion: 1, runId: "run-1", reviewCycle: 0, source: "worker", now: 500 },
    );
    assert.deepEqual(afterLateV1.criteriaResults, [{ criterionId: "B", passed: true, evidence: "v2 ok" }]);
    assert.equal(afterLateV1.verificationStatus, "passed");
    assert.equal(afterLateV1.phase, "completed");
    assert.equal(afterLateV1.reporterGoalVersion, 2);
    assert.equal(afterLateV1.reportedByTaskId, "t-v2");
  });

  it("B: treats version 0 (linked task with unknown binding) as stale while keeping null unrestricted", () => {
    const criterionIds = new Set(["A", "B"]);

    // Reporter version 0 (linked task with NULL goal_version mapped to 0 by tools.ts):
    const filteredUnknown = filterProgressPatch(
      {
        summary: "Legacy linked task progress",
        phase: "completed",
        verificationStatus: "passed",
        criteriaResults: [{ criterionId: "A", passed: true, evidence: "unknown contract version" }],
      },
      { goalId: "goal-17", criterionIds, boundVersion: 0, currentVersion: 1 },
    );
    assert.equal(filteredUnknown.patch.verificationStatus, undefined);
    assert.equal(filteredUnknown.patch.phase, undefined);
    assert.equal(filteredUnknown.patch.criteriaResults, undefined);
    assert.equal(filteredUnknown.patch.summary, "Legacy linked task progress");
    assert.equal(filteredUnknown.dropped.length, 3);
    assert.ok(filteredUnknown.note?.includes("unknown goal version") && filteredUnknown.note.includes("v1"));

    // Direct merge and isCurrentClaim also treat reporterGoalVersion 0 as stale.
    const mergedUnknown = mergeGoalLiveProgress(
      null,
      {
        summary: "Legacy linked task progress",
        phase: "completed",
        verificationStatus: "passed",
        criteriaResults: [{ criterionId: "A", passed: true, evidence: "unknown" }],
        reportedByTaskId: "t-legacy",
      },
      { goalVersion: 1, reporterGoalVersion: 0, runId: "run-1", reviewCycle: 0, source: "worker", now: 100 },
    );
    assert.equal(mergedUnknown.criteriaResults, undefined);
    assert.equal(mergedUnknown.verificationStatus, undefined);
    assert.equal(mergedUnknown.phase, undefined);
    assert.equal(mergedUnknown.summary, "Legacy linked task progress");

    const v1Goal = makeGoal({ version: 1 });
    assert.equal(
      isCurrentClaim(v1Goal, {
        goalVersion: 1,
        reporterGoalVersion: 0,
        runId: "run-1",
        reviewCycle: 0,
        verificationStatus: "failed",
        updatedAt: 100,
      }),
      false,
    );

    // Null boundVersion / reporterGoalVersion stays unrestricted for Director/system callers (engine.ts).
    const filteredDirector = filterProgressPatch(
      {
        summary: "Director verified v2",
        phase: "completed",
        verificationStatus: "passed",
        criteriaResults: [
          { criterionId: "A", passed: true, evidence: "director ok" },
          { criterionId: "removed", passed: true, evidence: "old id" },
        ],
      },
      { goalId: "goal-17", criterionIds, boundVersion: null, currentVersion: 2 },
    );
    assert.equal(filteredDirector.patch.verificationStatus, "passed");
    assert.equal(filteredDirector.patch.phase, "completed");
    assert.deepEqual(filteredDirector.patch.criteriaResults, [
      { criterionId: "A", passed: true, evidence: "director ok" },
    ]);
    assert.equal(filteredDirector.dropped.length, 1);
    assert.equal(filteredDirector.dropped[0]?.value, "removed");

    const mergedDirector = mergeGoalLiveProgress(
      null,
      filteredDirector.patch,
      { goalVersion: 2, reporterGoalVersion: null, runId: "run-1", reviewCycle: 0, source: "director", now: 200 },
    );
    assert.equal(mergedDirector.verificationStatus, "passed");
    assert.equal(mergedDirector.phase, "completed");
    assert.deepEqual(mergedDirector.criteriaResults, [{ criterionId: "A", passed: true, evidence: "director ok" }]);
    assert.equal(isCurrentClaim(makeGoal({ version: 2 }), mergedDirector), true);
  });

  it("C: reconcileGoalWithLiveRun strips stale reporters on paused/terminal goals and stale completed phases on executing goals", () => {
    const staleReporterProgress: GoalLiveProgress = {
      phase: "completed",
      summary: "v1 completed",
      verificationStatus: "passed",
      criteriaResults: [{ criterionId: "A", passed: true, evidence: "v1 check" }],
      goalVersion: 2,
      reporterGoalVersion: 1,
      runId: "run-1",
      reviewCycle: 0,
      source: "worker",
      updatedAt: 100,
    };

    // Paused and terminal goals must still filter out stale-reporter claims (both v1 < v2 and v0 < v2).
    for (const status of ["paused", "achieved", "cancelled", "draft"] as const) {
      const reconciledV1 = reconcileGoalWithLiveRun(makeGoal({ status, version: 2, liveProgress: staleReporterProgress }));
      assert.equal(reconciledV1.liveProgress?.verificationStatus, undefined, `${status} should hide stale verificationStatus`);
      assert.equal(reconciledV1.liveProgress?.criteriaResults, undefined, `${status} should hide stale criteriaResults`);
      assert.equal(reconciledV1.liveProgress?.phase, undefined, `${status} should hide stale completed phase`);

      const reconciledUnknown = reconcileGoalWithLiveRun(
        makeGoal({
          status,
          version: 1,
          liveProgress: { ...staleReporterProgress, goalVersion: 1, reporterGoalVersion: 0 },
        }),
      );
      assert.equal(reconciledUnknown.liveProgress?.verificationStatus, undefined, `${status} should hide v0 claim`);
      assert.equal(reconciledUnknown.liveProgress?.criteriaResults, undefined, `${status} should hide v0 criteria`);
      assert.equal(reconciledUnknown.liveProgress?.phase, undefined, `${status} should hide v0 completed phase`);
    }

    // Current-version achieved goal keeps its valid v2 live progress even after reviewCycle increments on approval.
    const validAchieved = reconcileGoalWithLiveRun(
      makeGoal({
        status: "achieved",
        version: 2,
        reviewCycle: 1,
        liveProgress: {
          phase: "completed",
          summary: "v2 approved",
          verificationStatus: "passed",
          criteriaResults: [{ criterionId: "A", passed: true, evidence: "v2 ok" }],
          goalVersion: 2,
          reporterGoalVersion: 2,
          runId: "run-1",
          reviewCycle: 0,
          source: "coordinator",
          updatedAt: 200,
        },
      }),
    );
    assert.equal(validAchieved.liveProgress?.verificationStatus, "passed");
    assert.equal(validAchieved.liveProgress?.phase, "completed");
    assert.equal(validAchieved.liveProgress?.criteriaResults?.length, 1);

    // Executing goal must not preserve a stale "completed" phase (stale review cycle or stale reporter).
    const bouncedExecuting = reconcileGoalWithLiveRun(
      makeGoal({
        status: "executing",
        version: 2,
        reviewCycle: 1,
        liveProgress: {
          phase: "completed",
          summary: "cycle 0 finished",
          verificationStatus: "passed",
          criteriaResults: [{ criterionId: "A", passed: true, evidence: "cycle 0" }],
          goalVersion: 2,
          reporterGoalVersion: 2,
          runId: "run-1",
          reviewCycle: 0,
          source: "coordinator",
          updatedAt: 300,
        },
      }),
    );
    assert.equal(bouncedExecuting.liveProgress?.phase, undefined);
    assert.equal(bouncedExecuting.liveProgress?.verificationStatus, undefined);
    assert.equal(bouncedExecuting.liveProgress?.criteriaResults, undefined);
    assert.notEqual(deriveGoalVerificationLabel(bouncedExecuting), "completed");

    const staleReporterExecuting = reconcileGoalWithLiveRun(
      makeGoal({
        status: "executing",
        version: 2,
        reviewCycle: 0,
        liveProgress: {
          phase: "completed",
          verificationStatus: "passed",
          goalVersion: 2,
          reporterGoalVersion: 1,
          runId: "run-1",
          reviewCycle: 0,
          updatedAt: 350,
        },
      }),
    );
    assert.equal(staleReporterExecuting.liveProgress, null);
    assert.notEqual(deriveGoalVerificationLabel(staleReporterExecuting), "completed");
  });
});
