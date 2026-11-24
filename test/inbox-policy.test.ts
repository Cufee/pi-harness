import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  EscalationRecord,
  MergeQueueRecord,
  MessageRecord,
  RunRecord,
  TaskRecord,
} from "../src/control-plane/db.js";
import type { GoalRecord } from "../src/goals/engine.js";
import {
  classifyAttention,
  evaluateAttentionVerdict,
  type AttentionInput,
  type AttentionRunInput,
} from "../src/visibility/index.js";

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id: "goal-1",
    chatSessionId: "chat-1",
    repoRoot: "/repo",
    version: 1,
    title: "Ship inbox policy",
    description: "Desc",
    criteria: [],
    nonGoals: [],
    budgets: { maxReviewCycles: 3, maxNoProgressCycles: 2 },
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

function makeRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    goal: "Run goal text",
    repoRoot: "/repo",
    baseBranch: "main",
    baseSha: "abc123",
    coordinationGroup: null,
    isolationMode: "standalone",
    status: "active",
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "t-1",
    runId: "run-1",
    parentId: null,
    tier: 2,
    kind: "worker",
    title: "Worker task",
    objective: "Do work",
    criteria: "",
    readOnly: false,
    profileId: "acp:codex",
    model: null,
    effort: null,
    status: "running",
    generation: 1,
    maxTurns: 0,
    turnsUsed: 0,
    contextUsed: 0,
    contextSize: 0,
    worktreeId: null,
    sessionId: null,
    summary: null,
    handoffJson: null,
    resultJson: null,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function makeEscalation(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: "esc-1",
    runId: "run-1",
    fromTaskId: "t-1",
    toTaskId: null,
    severity: "P0",
    category: "blocked_dependency",
    title: "Need approval",
    evidencePaths: [],
    attempted: [],
    suggestedSplits: [],
    blocking: true,
    status: "open",
    resolution: null,
    createdAt: 3_000,
    ackedAt: null,
    ...overrides,
  };
}

function makeMerge(overrides: Partial<MergeQueueRecord> = {}): MergeQueueRecord {
  return {
    id: "mq-1",
    runId: "run-1",
    taskId: "t-1",
    worktreeId: "wt-1",
    branch: "harness/run-1/t-1",
    status: "ci_failed",
    log: "tests failed",
    createdAt: 4_000,
    finishedAt: 4_500,
    ...overrides,
  };
}

function makeMessage(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: "msg-1",
    runId: "run-1",
    fromTaskId: "t-1",
    toTaskId: "t-2",
    question: "Can you share schema?",
    answer: null,
    status: "open",
    createdAt: 5_000,
    answeredAt: null,
    ...overrides,
  };
}

function makeInput(partial: Partial<AttentionInput> = {}): AttentionInput {
  return {
    goals: [],
    runs: [],
    merges: [],
    messages: [],
    ...partial,
  };
}

function runEntry(
  overrides: Omit<Partial<AttentionRunInput>, "run"> & { run?: Partial<RunRecord> } = {},
): AttentionRunInput {
  const { run: runOverrides, ...rest } = overrides;
  return {
    run: makeRun(runOverrides),
    goalId: "goal-1",
    tasks: [],
    escalations: [],
    quotaPause: null,
    ...rest,
  };
}

describe("classifyAttention policy", () => {
  it("includes every human-actionable kind and sorts by severity, escalation first, createdAt desc", () => {
    const goalAwaiting = makeGoal({ id: "goal-await", status: "awaiting_human", linkedRunId: "run-goal", updatedAt: 9_000 });
    const goalExec = makeGoal({ id: "goal-exec", status: "executing", linkedRunId: "run-esc", updatedAt: 8_000 });
    const worker = makeTask({ id: "t-worker", runId: "run-esc", kind: "worker", status: "running" });

    const humanP0 = makeEscalation({
      id: "esc-p0",
      runId: "run-esc",
      fromTaskId: worker.id,
      severity: "P0",
      blocking: false,
      category: "security_risk",
      createdAt: 1_000,
    });
    const humanBlockingP1 = makeEscalation({
      id: "esc-p1",
      runId: "run-esc",
      fromTaskId: worker.id,
      severity: "P1",
      blocking: true,
      category: "blocked_dependency",
      createdAt: 2_000,
    });
    const missingRaiserP0 = makeEscalation({
      id: "esc-missing-raiser",
      runId: "run-esc",
      fromTaskId: "t-deleted",
      severity: "P0",
      blocking: true,
      category: "code_defect",
      createdAt: 5_000,
    });

    const manualQuotaRun = runEntry({
      run: { id: "run-quota", status: "paused_quota", updatedAt: 7_000 },
      goalId: null,
      quotaPause: { mode: "manual", reason: "429 rate limit", resumeAt: null },
    });
    const goallessFailedRun = runEntry({
      run: { id: "run-fail", status: "failed", updatedAt: 6_000 },
      goalId: null,
    });
    const goallessSettledRun = runEntry({
      run: { id: "run-settled", status: "completed", updatedAt: 3_000 },
      goalId: null,
    });
    const goallessBounce = makeMerge({
      id: "mq-human",
      runId: "run-settled",
      taskId: "t-9",
      branch: "harness/run-settled/t-9",
      status: "conflict",
      createdAt: 3_500,
      finishedAt: 3_600,
    });

    const res = classifyAttention(
      makeInput({
        goals: [goalAwaiting, goalExec],
        runs: [
          runEntry({
            run: { id: "run-esc", status: "active" },
            goalId: goalExec.id,
            tasks: [worker],
            escalations: [humanP0, humanBlockingP1, missingRaiserP0],
          }),
          manualQuotaRun,
          goallessFailedRun,
          goallessSettledRun,
        ],
        merges: [goallessBounce],
      }),
    );

    assert.equal(res.internalAttention.length, 0);
    assert.deepEqual(
      res.inbox.map((i) => i.id),
      [
        "inbox:esc:esc-missing-raiser",
        "inbox:esc:esc-p0",
        "inbox:goal:goal-await",
        "inbox:quota:run-quota",
        "inbox:esc:esc-p1",
        "inbox:run:run-fail",
        "inbox:merge:mq-human",
      ],
    );
  });

  it("hides non-open, agent-addressed, non-blocking, read-only raiser, finished raiser, and finished goal escalations", () => {
    const activeGoal = makeGoal({ id: "goal-active", status: "executing", linkedRunId: "run-1" });
    const achievedGoal = makeGoal({ id: "goal-achieved", status: "achieved", linkedRunId: "run-achieved" });
    const cancelledGoal = makeGoal({ id: "goal-cancelled", status: "cancelled", linkedRunId: "run-cancelled" });

    const runningWorker = makeTask({ id: "t-run", runId: "run-1", kind: "worker", status: "running" });
    const readOnlyFlagTask = makeTask({ id: "t-ro-flag", runId: "run-1", kind: "worker", readOnly: true, status: "running" });
    const verifyTask = makeTask({ id: "t-verify", runId: "run-1", kind: "verify", readOnly: false, status: "running" });
    const completedWorker = makeTask({ id: "t-done", runId: "run-1", kind: "worker", status: "completed" });
    const failedWorker = makeTask({ id: "t-fail", runId: "run-1", kind: "worker", status: "failed" });
    const cancelledWorker = makeTask({ id: "t-cancel", runId: "run-1", kind: "worker", status: "cancelled" });
    const achievedWorker = makeTask({ id: "t-ach", runId: "run-achieved", kind: "worker", status: "running" });
    const cancelledGoalWorker = makeTask({ id: "t-cng", runId: "run-cancelled", kind: "worker", status: "running" });

    const res = classifyAttention(
      makeInput({
        goals: [activeGoal, achievedGoal, cancelledGoal],
        runs: [
          runEntry({
            run: { id: "run-1", status: "active" },
            goalId: activeGoal.id,
            tasks: [runningWorker, readOnlyFlagTask, verifyTask, completedWorker, failedWorker, cancelledWorker],
            escalations: [
              makeEscalation({ id: "esc-acked", fromTaskId: runningWorker.id, status: "acked" }),
              makeEscalation({ id: "esc-resolved", fromTaskId: runningWorker.id, status: "resolved" }),
              makeEscalation({ id: "esc-agent", fromTaskId: runningWorker.id, toTaskId: "t-parent" }),
              makeEscalation({ id: "esc-p1-nonblock", fromTaskId: runningWorker.id, severity: "P1", blocking: false }),
              makeEscalation({ id: "esc-p2-nonblock", fromTaskId: runningWorker.id, severity: "P2", blocking: false }),
              makeEscalation({ id: "esc-ro-flag", fromTaskId: readOnlyFlagTask.id, severity: "P0" }),
              makeEscalation({ id: "esc-ro-kind", fromTaskId: verifyTask.id, severity: "P0" }),
              makeEscalation({ id: "esc-done-raiser", fromTaskId: completedWorker.id, severity: "P0" }),
              makeEscalation({ id: "esc-fail-raiser", fromTaskId: failedWorker.id, severity: "P0" }),
              makeEscalation({ id: "esc-cancel-raiser", fromTaskId: cancelledWorker.id, severity: "P0" }),
            ],
          }),
          runEntry({
            run: { id: "run-achieved", status: "completed" },
            goalId: achievedGoal.id,
            tasks: [achievedWorker],
            escalations: [makeEscalation({ id: "esc-goal-achieved", runId: "run-achieved", fromTaskId: achievedWorker.id })],
          }),
          runEntry({
            run: { id: "run-cancelled", status: "stopped" },
            goalId: cancelledGoal.id,
            tasks: [cancelledGoalWorker],
            escalations: [makeEscalation({ id: "esc-goal-cancelled", runId: "run-cancelled", fromTaskId: cancelledGoalWorker.id })],
          }),
        ],
      }),
    );

    assert.equal(res.inbox.length, 0);
    const byId = new Map(res.internalAttention.map((i) => [i.id, i]));
    assert.equal(byId.get("inbox:esc:esc-acked")?.hiddenReason, "not_open");
    assert.equal(byId.get("inbox:esc:esc-acked")?.audience, "none");
    assert.equal(byId.get("inbox:esc:esc-resolved")?.hiddenReason, "not_open");
    assert.equal(byId.get("inbox:esc:esc-agent")?.hiddenReason, "agent_addressed");
    assert.equal(byId.get("inbox:esc:esc-agent")?.audience, "orchestrator");
    assert.equal(byId.get("inbox:esc:esc-p1-nonblock")?.hiddenReason, "not_blocking");
    assert.equal(byId.get("inbox:esc:esc-p2-nonblock")?.hiddenReason, "not_blocking");
    assert.equal(byId.get("inbox:esc:esc-ro-flag")?.hiddenReason, "read_only_raiser");
    assert.equal(byId.get("inbox:esc:esc-ro-kind")?.hiddenReason, "read_only_raiser");
    assert.equal(byId.get("inbox:esc:esc-done-raiser")?.hiddenReason, "raiser_finished");
    assert.equal(byId.get("inbox:esc:esc-fail-raiser")?.hiddenReason, "raiser_finished");
    assert.equal(byId.get("inbox:esc:esc-cancel-raiser")?.hiddenReason, "raiser_finished");
    assert.equal(byId.get("inbox:esc:esc-goal-achieved")?.hiddenReason, "goal_finished");
    assert.equal(byId.get("inbox:esc:esc-goal-achieved")?.audience, "none");
    assert.equal(byId.get("inbox:esc:esc-goal-cancelled")?.hiddenReason, "goal_finished");
  });

  it("keeps settled T1 raiser escalation when owning goal is awaiting_human, and hides it otherwise", () => {
    const awaitingGoal = makeGoal({ id: "goal-wait", status: "awaiting_human", linkedRunId: "run-wait" });
    const execGoal = makeGoal({ id: "goal-exec", status: "executing", linkedRunId: "run-exec" });
    const t1DoneWait = makeTask({ id: "t-1-wait", runId: "run-wait", tier: 1, kind: "orchestrator", status: "failed" });
    const t2DoneWait = makeTask({ id: "t-2-wait", runId: "run-wait", tier: 2, kind: "worker", status: "failed" });
    const t1DoneExec = makeTask({ id: "t-1-exec", runId: "run-exec", tier: 1, kind: "orchestrator", status: "failed" });

    const res = classifyAttention(
      makeInput({
        goals: [awaitingGoal, execGoal],
        runs: [
          runEntry({
            run: { id: "run-wait", status: "failed" },
            goalId: awaitingGoal.id,
            tasks: [t1DoneWait, t2DoneWait],
            escalations: [
              makeEscalation({ id: "esc-t1-wait", runId: "run-wait", fromTaskId: t1DoneWait.id, category: "blocked_dependency" }),
              makeEscalation({ id: "esc-t2-wait", runId: "run-wait", fromTaskId: t2DoneWait.id, category: "code_defect" }),
            ],
          }),
          runEntry({
            run: { id: "run-exec", status: "failed" },
            goalId: execGoal.id,
            tasks: [t1DoneExec],
            escalations: [
              makeEscalation({ id: "esc-t1-exec", runId: "run-exec", fromTaskId: t1DoneExec.id }),
            ],
          }),
        ],
      }),
    );

    assert.deepEqual(
      res.inbox.map((i) => i.id),
      ["inbox:esc:esc-t1-wait", "inbox:goal:goal-wait"],
    );
    const byId = new Map(res.internalAttention.map((i) => [i.id, i]));
    assert.equal(byId.get("inbox:esc:esc-t2-wait")?.hiddenReason, "raiser_finished");
    assert.equal(byId.get("inbox:esc:esc-t1-exec")?.hiddenReason, "raiser_finished");
  });

  it("supersedes older escalations with the same owning goal and category, ignoring hidden newer ones", () => {
    const goal = makeGoal({ id: "goal-1", status: "executing", linkedRunId: "run-1" });
    const worker = makeTask({ id: "t-1", runId: "run-1", status: "running" });

    const res = classifyAttention(
      makeInput({
        goals: [goal],
        runs: [
          runEntry({
            run: { id: "run-1", status: "active" },
            goalId: goal.id,
            tasks: [worker],
            escalations: [
              makeEscalation({ id: "esc-old", fromTaskId: worker.id, category: "blocked_dependency", createdAt: 1_000 }),
              makeEscalation({ id: "esc-new", fromTaskId: worker.id, category: "blocked_dependency", createdAt: 2_000 }),
              makeEscalation({
                id: "esc-newest-resolved",
                fromTaskId: worker.id,
                category: "blocked_dependency",
                status: "resolved",
                createdAt: 3_000,
              }),
              makeEscalation({ id: "esc-other-cat", fromTaskId: worker.id, category: "security_risk", createdAt: 1_500 }),
            ],
          }),
        ],
      }),
    );

    assert.deepEqual(
      res.inbox.map((i) => i.id),
      ["inbox:esc:esc-new", "inbox:esc:esc-other-cat"],
    );
    const byId = new Map(res.internalAttention.map((i) => [i.id, i]));
    assert.equal(byId.get("inbox:esc:esc-old")?.hiddenReason, "superseded");
    assert.equal(byId.get("inbox:esc:esc-old")?.audience, "none");
    assert.equal(byId.get("inbox:esc:esc-newest-resolved")?.hiddenReason, "not_open");
  });

  it("hides auto quota pause, goal-linked failed run, container run, task rows, live/goal/remerged bounces, and open messages", () => {
    const goal = makeGoal({ id: "goal-1", status: "executing", linkedRunId: "run-goal-fail" });
    const goalSettled = makeGoal({ id: "goal-2", status: "paused", linkedRunId: "run-goal-settled" });

    const blockedActiveTask = makeTask({ id: "t-blk-active", runId: "run-live", status: "blocked" });
    const failedActiveTask = makeTask({ id: "t-fail-active", runId: "run-live", status: "failed" });
    const blockedSettledTask = makeTask({ id: "t-blk-settled", runId: "run-settled", status: "blocked" });

    const res = classifyAttention(
      makeInput({
        goals: [goal, goalSettled],
        runs: [
          runEntry({
            run: { id: "run-auto-q", status: "paused_quota" },
            goalId: null,
            quotaPause: { mode: "auto", reason: "auto wait", resumeAt: 99_999 },
          }),
          runEntry({
            run: { id: "run-goal-fail", status: "failed" },
            goalId: goal.id,
          }),
          runEntry({
            run: { id: "director-tasks-chat-1", status: "failed" },
            goalId: null,
            tasks: [makeTask({ id: "t-bucket", runId: "director-tasks-chat-1", status: "blocked" })],
          }),
          runEntry({
            run: { id: "run-live", status: "active" },
            goalId: null,
            tasks: [blockedActiveTask, failedActiveTask],
          }),
          runEntry({
            run: { id: "run-settled", status: "completed" },
            goalId: null,
            tasks: [blockedSettledTask],
          }),
          runEntry({
            run: { id: "run-goal-settled", status: "completed" },
            goalId: goalSettled.id,
          }),
        ],
        merges: [
          makeMerge({ id: "mq-live", runId: "run-live", taskId: "t-live", branch: "harness/run-live/t-live", status: "ci_failed", createdAt: 1_000 }),
          makeMerge({ id: "mq-goal", runId: "run-goal-settled", taskId: "t-g", branch: "harness/run-goal-settled/t-g", status: "conflict", createdAt: 1_000 }),
          makeMerge({ id: "mq-remerged-branch", runId: "run-settled", taskId: "t-r1", branch: "harness/run-settled/shared", status: "ci_failed", createdAt: 1_000, finishedAt: 1_100 }),
          makeMerge({ id: "mq-remerged-branch-ok", runId: "run-settled", taskId: "t-r1-retry", branch: "harness/run-settled/shared", status: "merged", createdAt: 2_000, finishedAt: 2_100 }),
          makeMerge({ id: "mq-remerged-task", runId: "run-settled", taskId: "t-r2", branch: "harness/run-settled/old", status: "conflict", createdAt: 1_000, finishedAt: 1_100 }),
          makeMerge({ id: "mq-remerged-task-queued", runId: "run-settled", taskId: "t-r2", branch: "harness/run-settled/new", status: "queued", createdAt: 2_000, finishedAt: null }),
        ],
        messages: [makeMessage({ id: "msg-open", runId: "run-live", status: "open" })],
      }),
    );

    assert.equal(res.inbox.length, 0);
    const byId = new Map(res.internalAttention.map((i) => [i.id, i]));
    assert.equal(byId.get("inbox:quota:run-auto-q")?.hiddenReason, "auto_resume");
    assert.equal(byId.get("inbox:quota:run-auto-q")?.audience, "none");
    assert.equal(byId.get("inbox:run:run-goal-fail")?.hiddenReason, "covered_by_goal");
    assert.equal(byId.get("inbox:run:run-goal-fail")?.audience, "director");
    assert.equal(byId.has("inbox:run:director-tasks-chat-1"), false);
    assert.equal(byId.has("inbox:task:t-bucket"), false);
    assert.equal(byId.get("inbox:task:t-blk-active")?.hiddenReason, "run_live");
    assert.equal(byId.get("inbox:task:t-blk-active")?.audience, "orchestrator");
    assert.equal(byId.get("inbox:task:t-fail-active")?.hiddenReason, "run_live");
    assert.equal(byId.get("inbox:task:t-blk-settled")?.hiddenReason, "covered_by_run_or_goal");
    assert.equal(byId.get("inbox:merge:mq-live")?.hiddenReason, "run_live");
    assert.equal(byId.get("inbox:merge:mq-goal")?.hiddenReason, "covered_by_goal");
    assert.equal(byId.get("inbox:merge:mq-remerged-branch")?.hiddenReason, "remerged");
    assert.equal(byId.get("inbox:merge:mq-remerged-task")?.hiddenReason, "remerged");
    assert.equal(byId.get("inbox:msg:msg-open")?.hiddenReason, "agent_to_agent");
    assert.equal(byId.get("inbox:msg:msg-open")?.audience, "none");
  });

  it("hides dismissed items while preserving audience, and resurfaces them when createdAt is newer", () => {
    const failedRunOld = runEntry({
      run: { id: "run-d1", status: "failed", updatedAt: 5_000 },
      goalId: null,
    });
    const failedRunNewer = runEntry({
      run: { id: "run-d2", status: "failed", updatedAt: 6_000 },
      goalId: null,
    });
    const dismissals = new Map<string, number>([
      ["inbox:run:run-d1", 5_000],
      ["inbox:run:run-d2", 5_500],
    ]);

    const res = classifyAttention(
      makeInput({
        runs: [failedRunOld, failedRunNewer],
        dismissals,
      }),
    );

    assert.deepEqual(
      res.inbox.map((i) => i.id),
      ["inbox:run:run-d2"],
    );
    assert.equal(res.internalAttention.length, 1);
    assert.equal(res.internalAttention[0]!.id, "inbox:run:run-d1");
    assert.equal(res.internalAttention[0]!.audience, "human");
    assert.equal(res.internalAttention[0]!.hiddenReason, "dismissed");

    // Per-item verdict function agrees directly
    assert.deepEqual(
      evaluateAttentionVerdict({
        kind: "run_failed",
        run: failedRunOld.run,
        goalId: null,
        dismissedItemCreatedAt: 5_000,
      }),
      { audience: "human", reason: "dismissed" },
    );
  });
});
