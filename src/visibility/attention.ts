import type {
  EscalationRecord,
  MergeQueueRecord,
  MessageRecord,
  RunRecord,
  TaskRecord,
} from "../control-plane/db.js";
import { isReadOnlyKind } from "../control-plane/handoffs.js";
import { isDirectorTaskContainer } from "../control-plane/ids.js";
import type { GoalRecord } from "../goals/engine.js";
import type { AttentionAudience, InboxItem } from "../protocol/daemon-rpc.js";

export type { AttentionAudience };

export interface AttentionQuotaPause {
  mode: string;
  reason: string;
  resumeAt?: string | number | null;
}

export interface AttentionRunInput {
  run: RunRecord;
  goalId: string | null;
  tasks: TaskRecord[];
  escalations: EscalationRecord[];
  quotaPause: AttentionQuotaPause | null;
}

export interface AttentionInput {
  goals: GoalRecord[];
  runs: AttentionRunInput[];
  merges: MergeQueueRecord[];
  messages: MessageRecord[];
  dismissals?: ReadonlyMap<string, number>;
}

export interface AttentionVerdict {
  audience: AttentionAudience;
  reason?: string;
}

export interface AttentionClassification {
  inbox: InboxItem[];
  internalAttention: InboxItem[];
}

export type AttentionCandidate =
  | {
      kind: "escalation";
      escalation: EscalationRecord;
      raiserTask?: TaskRecord | null;
      owningGoal?: GoalRecord | null;
      superseded?: boolean;
      dismissedItemCreatedAt?: number;
    }
  | {
      kind: "goal_awaiting_human";
      goal: GoalRecord;
      dismissedItemCreatedAt?: number;
    }
  | {
      kind: "quota_paused";
      run: RunRecord;
      quotaPause: AttentionQuotaPause | null;
      dismissedItemCreatedAt?: number;
    }
  | {
      kind: "run_failed";
      run: RunRecord;
      goalId: string | null;
      dismissedItemCreatedAt?: number;
    }
  | {
      kind: "task_blocked" | "task_failed";
      run: RunRecord;
      task: TaskRecord;
      dismissedItemCreatedAt?: number;
    }
  | {
      kind: "merge_bounced";
      merge: MergeQueueRecord;
      run?: RunRecord | null;
      goalId: string | null;
      remerged?: boolean;
      dismissedItemCreatedAt?: number;
    }
  | {
      kind: "open_message";
      message: MessageRecord;
      dismissedItemCreatedAt?: number;
    };

const FINISHED_TASK_STATUSES = new Set<TaskRecord["status"]>(["completed", "cancelled", "failed"]);
const FINISHED_GOAL_STATUSES = new Set<GoalRecord["status"]>(["achieved", "cancelled"]);
const LIVE_RUN_STATUSES = new Set<RunRecord["status"]>(["active", "paused_quota"]);
const REMERGED_STATUSES = new Set<MergeQueueRecord["status"]>(["merged", "queued", "running"]);
const SEV_RANK: Record<InboxItem["severity"], number> = { P0: 0, P1: 1, P2: 2, info: 3 };

function kindRank(item: InboxItem): number {
  return item.kind === "escalation" ? 0 : 1;
}

function compareInboxItems(a: InboxItem, b: InboxItem): number {
  return SEV_RANK[a.severity] - SEV_RANK[b.severity] || kindRank(a) - kindRank(b) || b.createdAt - a.createdAt;
}

function isDismissedAt(itemCreatedAt: number, dismissedItemCreatedAt?: number): boolean {
  return dismissedItemCreatedAt !== undefined && dismissedItemCreatedAt >= itemCreatedAt;
}

function withDismissal(verdict: AttentionVerdict, itemCreatedAt: number, dismissedItemCreatedAt?: number): AttentionVerdict {
  if (isDismissedAt(itemCreatedAt, dismissedItemCreatedAt)) {
    return { audience: verdict.audience, reason: "dismissed" };
  }
  return verdict;
}

function baseEscalationVerdict(
  e: EscalationRecord,
  raiserTask?: TaskRecord | null,
  owningGoal?: GoalRecord | null,
): AttentionVerdict {
  if (e.status !== "open") {
    return { audience: "none", reason: "not_open" };
  }
  if (e.toTaskId !== null) {
    return { audience: "orchestrator", reason: "agent_addressed" };
  }
  if (!(e.severity === "P0" || e.blocking)) {
    return { audience: "orchestrator", reason: "not_blocking" };
  }
  if (raiserTask && (raiserTask.readOnly || isReadOnlyKind(raiserTask.kind))) {
    return { audience: "orchestrator", reason: "read_only_raiser" };
  }
  if (raiserTask && FINISHED_TASK_STATUSES.has(raiserTask.status)) {
    const keepSettledT1ForAwaitingGoal = raiserTask.tier === 1 && owningGoal?.status === "awaiting_human";
    if (!keepSettledT1ForAwaitingGoal) {
      return { audience: "orchestrator", reason: "raiser_finished" };
    }
  }
  if (owningGoal && FINISHED_GOAL_STATUSES.has(owningGoal.status)) {
    return { audience: "none", reason: "goal_finished" };
  }
  return { audience: "human" };
}

/** Evaluates who should see a single attention candidate and why it is hidden when not human-facing. */
export function evaluateAttentionVerdict(candidate: AttentionCandidate): AttentionVerdict {
  switch (candidate.kind) {
    case "escalation": {
      let verdict = baseEscalationVerdict(candidate.escalation, candidate.raiserTask, candidate.owningGoal);
      if (verdict.audience === "human" && candidate.superseded) {
        verdict = { audience: "none", reason: "superseded" };
      }
      return withDismissal(verdict, candidate.escalation.createdAt, candidate.dismissedItemCreatedAt);
    }

    case "goal_awaiting_human": {
      const verdict: AttentionVerdict =
        candidate.goal.status === "awaiting_human"
          ? { audience: "human" }
          : { audience: "none", reason: "not_awaiting_human" };
      return withDismissal(verdict, candidate.goal.updatedAt, candidate.dismissedItemCreatedAt);
    }

    case "quota_paused": {
      let verdict: AttentionVerdict;
      if (candidate.run.status !== "paused_quota") {
        verdict = { audience: "none", reason: "not_paused" };
      } else if (candidate.quotaPause?.mode === "manual") {
        verdict = { audience: "human" };
      } else {
        verdict = { audience: "none", reason: "auto_resume" };
      }
      return withDismissal(verdict, candidate.run.updatedAt, candidate.dismissedItemCreatedAt);
    }

    case "run_failed": {
      let verdict: AttentionVerdict;
      if (isDirectorTaskContainer(candidate.run.id)) {
        verdict = { audience: "director", reason: "director_container" };
      } else if (candidate.run.status !== "failed") {
        verdict = { audience: "none", reason: "not_failed" };
      } else if (candidate.goalId !== null) {
        verdict = { audience: "director", reason: "covered_by_goal" };
      } else {
        verdict = { audience: "human" };
      }
      return withDismissal(verdict, candidate.run.updatedAt, candidate.dismissedItemCreatedAt);
    }

    case "task_blocked":
    case "task_failed": {
      const verdict: AttentionVerdict = {
        audience: "orchestrator",
        reason: candidate.run.status === "active" ? "run_live" : "covered_by_run_or_goal",
      };
      return withDismissal(verdict, candidate.task.updatedAt, candidate.dismissedItemCreatedAt);
    }

    case "merge_bounced": {
      const itemCreatedAt = candidate.merge.finishedAt ?? candidate.merge.createdAt;
      let verdict: AttentionVerdict;
      if (candidate.merge.status !== "conflict" && candidate.merge.status !== "ci_failed") {
        verdict = { audience: "none", reason: "not_bounced" };
      } else if (isDirectorTaskContainer(candidate.merge.runId)) {
        verdict = { audience: "director", reason: "director_container" };
      } else if (candidate.run && LIVE_RUN_STATUSES.has(candidate.run.status)) {
        verdict = { audience: "orchestrator", reason: "run_live" };
      } else if (candidate.goalId !== null) {
        verdict = { audience: "orchestrator", reason: "covered_by_goal" };
      } else if (candidate.remerged) {
        verdict = { audience: "orchestrator", reason: "remerged" };
      } else {
        verdict = { audience: "human" };
      }
      return withDismissal(verdict, itemCreatedAt, candidate.dismissedItemCreatedAt);
    }

    case "open_message": {
      const verdict: AttentionVerdict = { audience: "none", reason: "agent_to_agent" };
      return withDismissal(verdict, candidate.message.createdAt, candidate.dismissedItemCreatedAt);
    }
  }
}

function isNewerEscalation(a: EscalationRecord, b: EscalationRecord): boolean {
  return a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id);
}

/**
 * Classifies snapshot state into human-actionable `inbox` items and hidden `internalAttention` items.
 * A goal-linked run surfaces to the human only through its goal row and its escalations; run/merge rows
 * show only for goalless, non-container, settled runs; task and message rows stay internal.
 */
export function classifyAttention(input: AttentionInput): AttentionClassification {
  const dismissals = input.dismissals;
  const inbox: InboxItem[] = [];
  const internalAttention: InboxItem[] = [];

  const goalById = new Map<string, GoalRecord>();
  const goalByRunId = new Map<string, GoalRecord>();
  for (const g of input.goals) {
    goalById.set(g.id, g);
    if (g.linkedRunId) goalByRunId.set(g.linkedRunId, g);
  }

  const runById = new Map<string, AttentionRunInput>();
  const taskById = new Map<string, TaskRecord>();
  for (const re of input.runs) {
    runById.set(re.run.id, re);
    for (const t of re.tasks) {
      taskById.set(t.id, t);
    }
  }

  const pushClassified = (item: InboxItem, verdict: AttentionVerdict): void => {
    if (verdict.audience === "human" && !verdict.reason) {
      inbox.push(item);
      return;
    }
    internalAttention.push({
      ...item,
      audience: verdict.audience,
      hiddenReason: verdict.reason,
    });
  };

  // 1. Goals awaiting human input
  for (const g of input.goals) {
    if (g.status !== "awaiting_human") continue;
    const item: InboxItem = {
      id: `inbox:goal:${g.id}`,
      severity: "P0",
      kind: "goal_awaiting_human",
      title: `${g.id} (v${g.version}) awaits input: ${g.title}`,
      detail: g.lastReviewSummary ?? "Goal paused awaiting human review or decision",
      ref: { kind: "goal", id: g.id, runId: g.linkedRunId ?? undefined, label: `${g.id} ${g.title}` },
      goalId: g.id,
      runId: g.linkedRunId,
      createdAt: g.updatedAt,
    };
    const verdict = evaluateAttentionVerdict({
      kind: "goal_awaiting_human",
      goal: g,
      dismissedItemCreatedAt: dismissals?.get(item.id),
    });
    pushClassified(item, verdict);
  }

  // 2. Escalations: evaluate base eligibility and dismissal first so only shown escalations can supersede older ones
  interface PendingEscalation {
    escalation: EscalationRecord;
    raiserTask: TaskRecord | null;
    owningGoal: GoalRecord | null;
    item: InboxItem;
    baseAudience: AttentionAudience;
    dismissedItemCreatedAt: number | undefined;
  }
  const pendingEscalations: PendingEscalation[] = [];
  const newestByGoalCategory = new Map<string, EscalationRecord>();

  for (const re of input.runs) {
    const runTaskById = new Map(re.tasks.map((t) => [t.id, t]));
    const owningGoal = goalByRunId.get(re.run.id) ?? (re.goalId ? goalById.get(re.goalId) ?? null : null);
    for (const e of re.escalations) {
      const raiserTask = runTaskById.get(e.fromTaskId) ?? taskById.get(e.fromTaskId) ?? null;
      const base = baseEscalationVerdict(e, raiserTask, owningGoal);
      const item: InboxItem = {
        id: `inbox:esc:${e.id}`,
        severity: e.severity,
        kind: "escalation",
        title: `[${e.severity}/${e.category}] ${e.title}`,
        detail: `from ${e.fromTaskId} in ${e.runId}${e.blocking ? " · blocking" : ""}`,
        ref: { kind: "escalation", id: e.id, runId: e.runId, goalId: owningGoal?.id, label: `${e.id} ${e.title}` },
        goalId: owningGoal?.id ?? null,
        runId: e.runId,
        taskId: e.fromTaskId,
        createdAt: e.createdAt,
      };
      const dismissedItemCreatedAt = dismissals?.get(item.id);
      if (base.audience === "human" && !isDismissedAt(e.createdAt, dismissedItemCreatedAt) && owningGoal) {
        const key = `${owningGoal.id}:${e.category}`;
        const prev = newestByGoalCategory.get(key);
        if (!prev || isNewerEscalation(e, prev)) {
          newestByGoalCategory.set(key, e);
        }
      }
      pendingEscalations.push({
        escalation: e,
        raiserTask,
        owningGoal,
        item,
        baseAudience: base.audience,
        dismissedItemCreatedAt,
      });
    }
  }

  for (const entry of pendingEscalations) {
    let superseded = false;
    if (entry.baseAudience === "human" && entry.owningGoal) {
      const key = `${entry.owningGoal.id}:${entry.escalation.category}`;
      const newest = newestByGoalCategory.get(key);
      if (newest && isNewerEscalation(newest, entry.escalation)) {
        superseded = true;
      }
    }
    const verdict = evaluateAttentionVerdict({
      kind: "escalation",
      escalation: entry.escalation,
      raiserTask: entry.raiserTask,
      owningGoal: entry.owningGoal,
      superseded,
      dismissedItemCreatedAt: entry.dismissedItemCreatedAt,
    });
    pushClassified(entry.item, verdict);
  }

  // 3. Quota pauses, failed runs, and blocked/failed tasks
  for (const re of input.runs) {
    if (re.run.status === "paused_quota") {
      const item: InboxItem = {
        id: `inbox:quota:${re.run.id}`,
        severity: re.quotaPause?.mode === "manual" ? "P0" : "P1",
        kind: "quota_paused",
        title: `${re.run.id} paused for quota`,
        detail: re.quotaPause?.reason ?? "Quota limit reached",
        ref: { kind: "run", id: re.run.id, goalId: re.goalId ?? undefined, label: re.run.id },
        goalId: re.goalId,
        runId: re.run.id,
        createdAt: re.run.updatedAt,
      };
      const verdict = evaluateAttentionVerdict({
        kind: "quota_paused",
        run: re.run,
        quotaPause: re.quotaPause,
        dismissedItemCreatedAt: dismissals?.get(item.id),
      });
      pushClassified(item, verdict);
    } else if (re.run.status === "failed" && !isDirectorTaskContainer(re.run.id)) {
      const item: InboxItem = {
        id: `inbox:run:${re.run.id}`,
        severity: "P1",
        kind: "run_failed",
        title: `${re.run.id} failed`,
        detail: re.run.goal.split("\n")[0] ?? re.run.id,
        ref: { kind: "run", id: re.run.id, goalId: re.goalId ?? undefined, label: re.run.id },
        goalId: re.goalId,
        runId: re.run.id,
        createdAt: re.run.updatedAt,
      };
      const verdict = evaluateAttentionVerdict({
        kind: "run_failed",
        run: re.run,
        goalId: re.goalId,
        dismissedItemCreatedAt: dismissals?.get(item.id),
      });
      pushClassified(item, verdict);
    }

    if (isDirectorTaskContainer(re.run.id)) continue;
    for (const t of re.tasks) {
      if (t.status === "blocked" || (t.status === "failed" && re.run.status === "active")) {
        const kind = t.status === "blocked" ? "task_blocked" : "task_failed";
        const item: InboxItem = {
          id: `inbox:task:${t.id}`,
          severity: t.status === "blocked" ? "P1" : "P2",
          kind,
          title: `${t.id} (${t.status}): ${t.title}`,
          detail: t.summary ?? `${re.run.id} · T${t.tier}/${t.kind}`,
          ref: { kind: "task", id: t.id, runId: re.run.id, goalId: re.goalId ?? undefined, label: `${t.id} ${t.title}` },
          goalId: re.goalId,
          runId: re.run.id,
          taskId: t.id,
          createdAt: t.updatedAt,
        };
        const verdict = evaluateAttentionVerdict({
          kind,
          run: re.run,
          task: t,
          dismissedItemCreatedAt: dismissals?.get(item.id),
        });
        pushClassified(item, verdict);
      }
    }
  }

  // 4. Bounced merges
  for (const m of input.merges) {
    if (m.status !== "conflict" && m.status !== "ci_failed") continue;
    const runEntry = runById.get(m.runId);
    const owningGoal = goalByRunId.get(m.runId);
    const goalId = owningGoal?.id ?? runEntry?.goalId ?? null;
    const remerged = input.merges.some(
      (other) =>
        other.id !== m.id &&
        (other.branch === m.branch || other.taskId === m.taskId) &&
        other.createdAt > m.createdAt &&
        REMERGED_STATUSES.has(other.status),
    );
    const item: InboxItem = {
      id: `inbox:merge:${m.id}`,
      severity: "P1",
      kind: "merge_bounced",
      title: `Merge ${m.id} (${m.status}): ${m.branch}`,
      detail: (m.log ?? "").split("\n")[0] ?? m.status,
      ref: { kind: "merge", id: m.id, runId: m.runId, goalId: goalId ?? undefined, label: m.id },
      goalId,
      runId: m.runId,
      taskId: m.taskId,
      createdAt: m.finishedAt ?? m.createdAt,
    };
    const verdict = evaluateAttentionVerdict({
      kind: "merge_bounced",
      merge: m,
      run: runEntry?.run ?? null,
      goalId,
      remerged,
      dismissedItemCreatedAt: dismissals?.get(item.id),
    });
    pushClassified(item, verdict);
  }

  // 5. Open task-to-task messages
  for (const msg of input.messages) {
    if (msg.status !== "open") continue;
    const item: InboxItem = {
      id: `inbox:msg:${msg.id}`,
      severity: "P2",
      kind: "open_message",
      title: `Open message ${msg.id} (${msg.fromTaskId} -> ${msg.toTaskId})`,
      detail: msg.question.slice(0, 140),
      ref: { kind: "message", id: msg.id, runId: msg.runId, label: msg.id },
      runId: msg.runId,
      taskId: msg.toTaskId,
      createdAt: msg.createdAt,
    };
    const verdict = evaluateAttentionVerdict({
      kind: "open_message",
      message: msg,
      dismissedItemCreatedAt: dismissals?.get(item.id),
    });
    pushClassified(item, verdict);
  }

  inbox.sort(compareInboxItems);
  internalAttention.sort(compareInboxItems);
  return { inbox, internalAttention };
}
