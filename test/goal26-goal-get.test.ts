import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  buildGoalGetResult,
  GOAL_VERIFICATION_IDLE_NOTE,
  parseGoalGetOptions,
  type GoalActiveVerification,
  type GoalGetDetailInput,
} from "../src/director/goal-get.js";
import type { GoalRecord, GoalStatus } from "../src/goals/engine.js";
import { serializeToolResult } from "../src/runners/mcp-bridge.js";
import { toolsForRole } from "../src/tool-descriptions/index.js";
import type { SnapshotGoalEntry } from "../src/tui/store.js";

function makeDetail(opts: {
  status: GoalStatus;
  reviewCycle?: number;
  version?: number;
  description?: string;
  criteriaCount?: number;
}): GoalGetDetailInput {
  const criteriaCount = opts.criteriaCount ?? 2;
  const goal: GoalRecord = {
    id: "goal-26",
    chatSessionId: "chat-1",
    repoRoot: "/tmp/repo",
    version: opts.version ?? 1,
    title: "Goal lifecycle verification visibility",
    description: opts.description ?? "Verify live visibility for reviewCycle 0 verifying goals.",
    criteria: Array.from({ length: criteriaCount }, (_, i) => ({
      id: `c${i + 1}`,
      description: `Criterion ${i + 1}`,
      kind: i === 0 ? "deterministic" : "behavioral",
      command: i === 0 ? "bun test" : undefined,
      required: true,
    })),
    nonGoals: [],
    budgets: { maxReviewCycles: 3, maxNoProgressCycles: 2 },
    verificationMode: "auto",
    verifyRef: "main",
    liveProgress: null,
    status: opts.status,
    linkedRunId: "run-26",
    reviewCycle: opts.reviewCycle ?? 0,
    noProgressStreak: 0,
    lastProgressFingerprint: null,
    lastReviewSummary: null,
    createdAt: 1_000,
    updatedAt: 2_000,
  };

  return {
    goal,
    reviews: [],
    tasks: [],
    openEscalations: [],
    activity: null,
  };
}

describe("goal-26 Slice B1: goal_get activeVerification view", () => {
  it("emits activeVerification for a verifying goal with reviewCycle 0 in the gates phase", () => {
    const detail = makeDetail({ status: "verifying", reviewCycle: 0 });
    const active: GoalActiveVerification = {
      inflightId: "rev-inflight-1",
      kind: "review",
      phase: "gates",
      goalVersion: 1,
      cycle: 1,
      reviewerTaskId: null,
      runId: "run-26",
      startedAt: 10_000,
      elapsedMs: 4_250,
      reviewEpoch: 2,
      currentEpoch: 2,
      stale: false,
    };

    const res = buildGoalGetResult(detail, parseGoalGetOptions({}), {
      evidenceDir: null,
      descriptionPath: null,
      activeVerification: active,
    });
    const goalOut = res.goal as Record<string, unknown>;
    assert.equal(goalOut.status, "verifying");
    assert.equal(goalOut.reviewCycle, 0);
    assert.deepEqual(goalOut.activeVerification, active);
    assert.equal("verificationNote" in goalOut, false);
  });

  it("emits activeVerification for a reviewing goal with reviewCycle 0 in the reviewer phase including stale flag", () => {
    const detail = makeDetail({ status: "reviewing", reviewCycle: 0 });
    const active: GoalActiveVerification = {
      inflightId: "rev-inflight-2",
      kind: "review",
      phase: "reviewer",
      goalVersion: 1,
      cycle: 1,
      reviewerTaskId: "t-rev-7",
      runId: "run-26",
      startedAt: 20_000,
      elapsedMs: 9_100,
      reviewEpoch: 2,
      currentEpoch: 3,
      stale: true,
    };

    const res = buildGoalGetResult(detail, parseGoalGetOptions({}), {
      evidenceDir: null,
      descriptionPath: null,
      activeVerification: active,
    });
    const goalOut = res.goal as Record<string, unknown>;
    assert.equal(goalOut.status, "reviewing");
    assert.equal(goalOut.reviewCycle, 0);
    assert.deepEqual(goalOut.activeVerification, active);
    assert.equal("verificationNote" in goalOut, false);
  });

  it("emits null activeVerification and verificationNote when a verifying or reviewing goal has no running verification", () => {
    for (const status of ["verifying", "reviewing"] as const) {
      const detail = makeDetail({ status, reviewCycle: 0 });

      const explicitNull = buildGoalGetResult(detail, parseGoalGetOptions({}), {
        evidenceDir: null,
        descriptionPath: null,
        activeVerification: null,
      });
      const goalNull = explicitNull.goal as Record<string, unknown>;
      assert.equal(goalNull.status, status);
      assert.equal(goalNull.reviewCycle, 0);
      assert.equal(goalNull.activeVerification, null);
      assert.equal(goalNull.verificationNote, GOAL_VERIFICATION_IDLE_NOTE);

      // Existing callers that omit activeVerification also get null + note.
      const omitted = buildGoalGetResult(detail, parseGoalGetOptions({}), {
        evidenceDir: null,
        descriptionPath: null,
      });
      const goalOmitted = omitted.goal as Record<string, unknown>;
      assert.equal(goalOmitted.activeVerification, null);
      assert.equal(goalOmitted.verificationNote, GOAL_VERIFICATION_IDLE_NOTE);
    }
  });

  it("omits verificationNote for non-verifying goals and preserves minimal header when goal section is excluded", () => {
    for (const status of ["draft", "executing", "awaiting_human", "paused", "achieved"] as const) {
      const detail = makeDetail({ status, reviewCycle: 0 });
      const res = buildGoalGetResult(detail, parseGoalGetOptions({}), {
        evidenceDir: null,
        descriptionPath: null,
      });
      const goalOut = res.goal as Record<string, unknown>;
      assert.equal(goalOut.activeVerification, null);
      assert.equal("verificationNote" in goalOut, false);
    }

    const verifyingDetail = makeDetail({ status: "verifying", reviewCycle: 0 });
    const narrow = buildGoalGetResult(verifyingDetail, parseGoalGetOptions({ sections: ["criteria"] }), {
      evidenceDir: null,
      descriptionPath: null,
      activeVerification: null,
    });
    assert.deepEqual(narrow.goal, {
      id: verifyingDetail.goal.id,
      version: verifyingDetail.goal.version,
      title: verifyingDetail.goal.title,
      status: "verifying",
    });
  });

  it("never clips or drops activeVerification or verificationNote under budget cap pressure", () => {
    const hugeDetail = makeDetail({
      status: "verifying",
      reviewCycle: 0,
      description: "x".repeat(45_000),
      criteriaCount: 250,
    });
    const active: GoalActiveVerification = {
      inflightId: "rev-inflight-budget",
      kind: "review",
      phase: "gates",
      goalVersion: 1,
      cycle: 1,
      reviewerTaskId: null,
      runId: "run-26",
      startedAt: 10_000,
      elapsedMs: 1_500,
      reviewEpoch: 1,
      currentEpoch: 1,
      stale: false,
    };

    const withActive = buildGoalGetResult(hugeDetail, parseGoalGetOptions({}), {
      evidenceDir: null,
      descriptionPath: null,
      activeVerification: active,
      reserveChars: 120,
    });
    assert.ok(serializeToolResult(withActive).length <= 40_000);
    assert.deepEqual((withActive.goal as Record<string, unknown>).activeVerification, active);

    const withNull = buildGoalGetResult(hugeDetail, parseGoalGetOptions({}), {
      evidenceDir: null,
      descriptionPath: null,
      activeVerification: null,
      reserveChars: 120,
    });
    assert.ok(serializeToolResult(withNull).length <= 40_000);
    assert.equal((withNull.goal as Record<string, unknown>).activeVerification, null);
    assert.equal((withNull.goal as Record<string, unknown>).verificationNote, GOAL_VERIFICATION_IDLE_NOTE);
  });

  it("SnapshotGoalEntry accepts optional activeVerification", () => {
    const detail = makeDetail({ status: "verifying", reviewCycle: 0 });
    const active: GoalActiveVerification = {
      inflightId: "rev-tui-1",
      kind: "review",
      phase: "gates",
      goalVersion: 1,
      cycle: 1,
      reviewerTaskId: null,
      runId: "run-26",
      startedAt: 5_000,
      elapsedMs: 250,
      reviewEpoch: 0,
      currentEpoch: 0,
      stale: false,
    };
    const withField: SnapshotGoalEntry = {
      goal: detail.goal,
      reviews: [],
      revisions: [],
      activeVerification: active,
    };
    const withoutField: SnapshotGoalEntry = {
      goal: detail.goal,
      reviews: [],
      revisions: [],
    };
    assert.deepEqual(withField.activeVerification, active);
    assert.equal(withoutField.activeVerification, undefined);
  });

  it("tool descriptions expose goal_amend budget fields and resume queue semantics", () => {
    const directorTools = new Map(toolsForRole("director").map((t) => [t.name, t]));

    const amend = directorTools.get("goal_amend");
    assert.ok(amend);
    const amendProps = (amend.inputSchema as { properties?: Record<string, { type?: string; description?: string }> })
      .properties;
    assert.equal(amendProps?.max_review_cycles?.type, "number");
    assert.equal(amendProps?.max_no_progress_cycles?.type, "number");
    assert.match(amend.description, /Budget-only changes.*do not bump the version or reset the review cycle/i);
    assert.match(amend.description, /max-cycles or no-progress escalation/i);

    const resumeRun = directorTools.get("resume_run");
    assert.ok(resumeRun);
    assert.match(resumeRun.description, /queued/i);
    assert.match(resumeRun.description, /queuePosition/);
    assert.match(resumeRun.description, /queue_force_start/);

    const resumeTask = directorTools.get("resume_task");
    assert.ok(resumeTask);
    assert.match(resumeTask.description, /queued/i);
    assert.match(resumeTask.description, /queuePosition/);
    assert.match(resumeTask.description, /queue_force_start/);
  });
});
