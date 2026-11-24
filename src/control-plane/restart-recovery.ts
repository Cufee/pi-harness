import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";
import type { AgentTier, ControlPlaneDb, TaskKind, TaskRecord } from "./db.js";
import { settleTaskMinimalFallback } from "./handoffs.js";
import { directorTaskRunOwner, isDirectorTaskContainer } from "./ids.js";
import type { AnchoredHandoff } from "./prompts.js";
import { toolPolicyForTask } from "../runners/types.js";
import type { WorktreeManager } from "../worktree/manager.js";

export const DRAIN_STEER_MARKER = "[harness:daemon-restart]";

const LIVE_STATUSES = new Set(["running", "draining", "waiting_children", "merging"]);
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const DONE_REVIEW_OBJECTIVE_PREFIX = "# Independent Skeptical Done-Review (Goal ";

export type WorktreeRecoveryAction = "in_place" | "recreate" | "fallback_repo_root";

export interface PlannedTask {
  id: string;
  runId: string;
  runStatus: string;
  tier: number;
  kind: string;
  title: string;
  status: string;
  generation: number;
  createdAt: number;
  parentId: string | null;
  readOnly: boolean;
  worktreeId: string | null;
  worktreeTaskId: string | null;
  worktreeRunId: string | null;
  worktreeStatus: string | null;
  worktreePath: string | null;
  worktreeExists: boolean;
  worktreeAction: WorktreeRecoveryAction;
}

export interface RecoveryPlan {
  recoverableRunIds: string[];
  relaunch: PlannedTask[];
  cancelReviews: PlannedTask[];
  legacyFail: PlannedTask[];
  untouched: PlannedTask[];
  staleMerges: { id: string; runId: string; taskId: string; status: string }[];
  pendingTimers: { id: string; ownerKind: string; ownerId: string; wakeAt: number; reason: string; viaWaitTimer: boolean }[];
  revivableTimerIds: string[];
  reviewGoals: { goalId: string; runId: string }[];
}

export interface PhaseAHost {
  hold(taskId: string): void;
  checkQuota(runId: string): void;
}

export interface RecoveryHost {
  db: ControlPlaneDb;
  worktrees(repoRoot: string): WorktreeManager;
  buildHandoff(
    task: TaskRecord,
    worktreePath: string | null,
    reason: string,
    explicit: AnchoredHandoff | null,
  ): Promise<AnchoredHandoff>;
  setResumeNote(taskId: string, note: { kind: "resume"; reason: string; userMessage: string }): void;
  release(taskId: string): void;
  launch(taskId: string): void;
  isActive?(taskId: string): boolean;
  isStopping(): boolean;
}

interface ReviewingGoalMeta {
  id: string;
  title: string;
  reviewCycle: number;
  linkedRunId: string | null;
  chatSessionId: string | null;
}

function ownsWritableWorktree(t: {
  id: string;
  tier: number;
  kind: string;
  readOnly: boolean;
  worktreeId: string | null;
  worktreeTaskId: string | null;
}): boolean {
  if (!t.worktreeId) return false;
  if (toolPolicyForTask(t.tier as AgentTier, t.kind as TaskKind, t.readOnly) !== "read_write_workspace") return false;
  return t.worktreeTaskId === null || t.worktreeTaskId === t.id;
}

function classifyWorktreeAction(t: {
  id: string;
  tier: number;
  kind: string;
  readOnly: boolean;
  worktreeId: string | null;
  worktreeTaskId: string | null;
  worktreeExists: boolean;
}): WorktreeRecoveryAction {
  if (!t.worktreeId || t.worktreeExists) return "in_place";
  return ownsWritableWorktree(t) ? "recreate" : "fallback_repo_root";
}

function isDirectorDoneReviewTask(
  t: {
    id: string;
    runId: string;
    parentId: string | null;
    tier: number;
    kind: string;
    readOnly: boolean;
    title: string;
    objective: string;
  },
  ctx: {
    doneReviewCostTaskIds: Set<string>;
    reviewingGoals: ReviewingGoalMeta[];
    tier1ByRun: Map<string, Set<string>>;
  },
): boolean {
  if (t.tier !== 3 || t.kind !== "verify" || !t.readOnly || !t.title.startsWith("Done-Review:")) {
    return false;
  }
  if (ctx.doneReviewCostTaskIds.has(t.id)) {
    return true;
  }
  const containerOwner = directorTaskRunOwner(t.runId);
  const runTier1Ids = ctx.tier1ByRun.get(t.runId);
  const parentMatches = t.parentId === null || Boolean(runTier1Ids?.has(t.parentId));
  if (!parentMatches) return false;

  return ctx.reviewingGoals.some((g) => {
    const runMatches =
      g.linkedRunId === t.runId ||
      (containerOwner !== null && (containerOwner === g.chatSessionId || containerOwner === g.id));
    if (!runMatches) return false;
    const expectedTitle = `Done-Review: ${g.title} (cycle ${g.reviewCycle + 1})`;
    if (t.title !== expectedTitle) return false;
    return t.objective.startsWith(`${DONE_REVIEW_OBJECTIVE_PREFIX}${g.id} `);
  });
}

function normalizeHandoff(raw: unknown): { handoff: AnchoredHandoff; malformed: boolean; reason: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      handoff: { goalInvariants: [], architecturalDecisions: [], activeRisks: [], nextActions: [] },
      malformed: true,
      reason: "stored handoff is not an object",
    };
  }
  const obj = raw as Record<string, unknown>;
  let malformed = false;
  const reasons: string[] = [];

  const cleanStringList = (field: string, value: unknown): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      malformed = true;
      reasons.push(`${field} is not an array`);
      return [];
    }
    const out: string[] = [];
    for (const item of value) {
      if (typeof item === "string") {
        out.push(item);
      } else {
        malformed = true;
        if (!reasons.includes(`${field} contains non-string entry`)) {
          reasons.push(`${field} contains non-string entry`);
        }
      }
    }
    return out;
  };

  const decisions: Array<{ decision: string; rationale: string }> = [];
  if (obj.architecturalDecisions !== undefined) {
    if (!Array.isArray(obj.architecturalDecisions)) {
      malformed = true;
      reasons.push("architecturalDecisions is not an array");
    } else {
      for (const entry of obj.architecturalDecisions) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          const rec = entry as Record<string, unknown>;
          if (typeof rec.decision === "string") {
            const rationale = typeof rec.rationale === "string" ? rec.rationale : "";
            if (rec.rationale !== undefined && typeof rec.rationale !== "string") {
              malformed = true;
              if (!reasons.includes("architecturalDecisions entry has non-string rationale")) {
                reasons.push("architecturalDecisions entry has non-string rationale");
              }
            }
            decisions.push({ decision: rec.decision, rationale });
            continue;
          }
        }
        malformed = true;
        if (!reasons.includes("architecturalDecisions entry missing string decision")) {
          reasons.push("architecturalDecisions entry missing string decision");
        }
      }
    }
  }

  return {
    handoff: {
      goalInvariants: cleanStringList("goalInvariants", obj.goalInvariants),
      architecturalDecisions: decisions,
      activeRisks: cleanStringList("activeRisks", obj.activeRisks),
      nextActions: cleanStringList("nextActions", obj.nextActions),
    },
    malformed,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}

function parseHandoffWithStatus(raw: string | null): {
  handoff: AnchoredHandoff | null;
  malformed: boolean;
  reason: string | null;
} {
  if (!raw) return { handoff: null, malformed: false, reason: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { handoff: null, malformed: true, reason: `invalid JSON (${msg})` };
  }
  const normalized = normalizeHandoff(parsed);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { handoff: null, malformed: true, reason: normalized.reason };
  }
  return normalized;
}

function minimalRecoveryHandoff(generation: number, reason: string): AnchoredHandoff {
  return {
    goalInvariants: [],
    architecturalDecisions: [],
    activeRisks: [`Generation ${generation} recovered with minimal handoff: ${reason.slice(0, 300)}`],
    nextActions: [],
  };
}

function isRunStoppedForRecovery(run: { id: string; status: string }): boolean {
  return !isDirectorTaskContainer(run.id) && run.status === "stopped";
}

export function listInterruptedReviewGoals(raw: Database): { goalId: string; runId: string }[] {
  try {
    const rows = raw
      .prepare(
        `SELECT id, linked_run_id FROM goals
         WHERE status IN ('verifying', 'reviewing') AND linked_run_id IS NOT NULL
         ORDER BY id ASC`,
      )
      .all() as Array<{ id: string; linked_run_id: string }>;
    return rows.map((r) => ({ goalId: String(r.id), runId: String(r.linked_run_id) }));
  } catch {
    return [];
  }
}

export function classifyInterruptedTasks(raw: Database, opts?: { legacyStopAt?: number }): RecoveryPlan {
  const recoverableRunSet = new Set<string>();
  const activeRunRows = raw
    .prepare("SELECT id FROM runs WHERE status IN ('active', 'paused_quota')")
    .all() as Array<{ id: string }>;
  for (const row of activeRunRows) {
    recoverableRunSet.add(String(row.id));
  }

  const taskRows = raw
    .prepare(
      `SELECT
        t.id, t.run_id, r.status AS run_status, t.tier, t.kind, t.title, t.objective, t.status,
        t.generation, t.created_at, t.parent_id, t.profile_id, t.read_only, t.worktree_id,
        w.task_id AS worktree_task_id, w.run_id AS worktree_run_id,
        w.status AS worktree_status, w.path AS worktree_path
       FROM tasks t
       JOIN runs r ON r.id = t.run_id
       LEFT JOIN worktrees w ON w.id = t.worktree_id
       WHERE t.status IN ('pending', 'ready', 'running', 'draining', 'waiting_children', 'merging', 'paused_quota')
       ORDER BY t.tier ASC, t.created_at ASC, t.id ASC`,
    )
    .all() as Array<{
    id: string;
    run_id: string;
    run_status: string;
    tier: number;
    kind: string;
    title: string;
    objective: string;
    status: string;
    generation: number;
    created_at: number;
    parent_id: string | null;
    profile_id: string;
    read_only: number;
    worktree_id: string | null;
    worktree_task_id: string | null;
    worktree_run_id: string | null;
    worktree_status: string | null;
    worktree_path: string | null;
  }>;

  const doneReviewCostTaskIds = new Set<string>();
  try {
    const costRows = raw
      .prepare("SELECT DISTINCT task_id FROM cost_invocations WHERE activity = 'done_review' AND task_id IS NOT NULL")
      .all() as Array<{ task_id: string }>;
    for (const r of costRows) doneReviewCostTaskIds.add(String(r.task_id));
  } catch {
    // cost_invocations table may not exist in minimal databases
  }

  const reviewingGoals: ReviewingGoalMeta[] = [];
  try {
    const gRows = raw
      .prepare("SELECT id, title, review_cycle, linked_run_id, chat_session_id FROM goals WHERE status IN ('reviewing', 'verifying')")
      .all() as Array<{
      id: string;
      title: string;
      review_cycle: number;
      linked_run_id: string | null;
      chat_session_id: string | null;
    }>;
    for (const g of gRows) {
      reviewingGoals.push({
        id: String(g.id),
        title: String(g.title),
        reviewCycle: Number(g.review_cycle),
        linkedRunId: g.linked_run_id ? String(g.linked_run_id) : null,
        chatSessionId: g.chat_session_id ? String(g.chat_session_id) : null,
      });
    }
  } catch {
    // goals table may not exist in minimal databases
  }

  const tier1ByRun = new Map<string, Set<string>>();
  try {
    const t1Rows = raw.prepare("SELECT id, run_id FROM tasks WHERE tier = 1").all() as Array<{ id: string; run_id: string }>;
    for (const t1 of t1Rows) {
      const rid = String(t1.run_id);
      let set = tier1ByRun.get(rid);
      if (!set) {
        set = new Set<string>();
        tier1ByRun.set(rid, set);
      }
      set.add(String(t1.id));
    }
  } catch {
    // ignore
  }

  const reviewCtx = { doneReviewCostTaskIds, reviewingGoals, tier1ByRun };

  const toPlanned = (r: (typeof taskRows)[number]): PlannedTask => {
    const runId = String(r.run_id);
    const id = String(r.id);
    const tier = Number(r.tier);
    const kind = String(r.kind);
    const readOnly = Boolean(r.read_only);
    const worktreeId = r.worktree_id ? String(r.worktree_id) : null;
    const worktreeTaskId = r.worktree_task_id ? String(r.worktree_task_id) : null;
    const worktreeRunId = r.worktree_run_id ? String(r.worktree_run_id) : null;
    const wtPath = r.worktree_path ? String(r.worktree_path) : null;
    const worktreeExists = wtPath !== null && worktreeRunId === runId && existsSync(wtPath);
    return {
      id,
      runId,
      runStatus: String(r.run_status),
      tier,
      kind,
      title: String(r.title),
      status: String(r.status),
      generation: Number(r.generation),
      createdAt: Number(r.created_at),
      parentId: r.parent_id ? String(r.parent_id) : null,
      readOnly,
      worktreeId,
      worktreeTaskId,
      worktreeRunId,
      worktreeStatus: r.worktree_status ? String(r.worktree_status) : null,
      worktreePath: wtPath,
      worktreeExists,
      worktreeAction: classifyWorktreeAction({
        id,
        tier,
        kind,
        readOnly,
        worktreeId,
        worktreeTaskId,
        worktreeExists,
      }),
    };
  };

  const cancelReviews: PlannedTask[] = [];
  const remaining: Array<(typeof taskRows)[number]> = [];

  for (const row of taskRows) {
    const status = String(row.status);
    if (
      (LIVE_STATUSES.has(status) || status === "ready" || status === "pending") &&
      isDirectorDoneReviewTask(
        {
          id: String(row.id),
          runId: String(row.run_id),
          parentId: row.parent_id ? String(row.parent_id) : null,
          tier: Number(row.tier),
          kind: String(row.kind),
          readOnly: Boolean(row.read_only),
          title: String(row.title),
          objective: String(row.objective ?? ""),
        },
        reviewCtx,
      )
    ) {
      cancelReviews.push(toPlanned(row));
      continue;
    }
    if (String(row.profile_id) === "director") continue;
    const runId = String(row.run_id);
    if (isDirectorTaskContainer(runId) && (LIVE_STATUSES.has(status) || status === "ready")) {
      recoverableRunSet.add(runId);
    }
    remaining.push(row);
  }

  const relaunch: PlannedTask[] = [];
  const untouched: PlannedTask[] = [];
  const legacyFail: PlannedTask[] = [];
  const runsWithHeldOrQuota = new Set<string>();

  for (const row of remaining) {
    const runId = String(row.run_id);
    const status = String(row.status);
    if (recoverableRunSet.has(runId)) {
      if (LIVE_STATUSES.has(status) || status === "ready") {
        relaunch.push(toPlanned(row));
        runsWithHeldOrQuota.add(runId);
      } else if (status === "paused_quota") {
        untouched.push(toPlanned(row));
        runsWithHeldOrQuota.add(runId);
      } else if (status === "pending") {
        untouched.push(toPlanned(row));
      }
    } else if (LIVE_STATUSES.has(status) || status === "ready" || status === "pending") {
      legacyFail.push(toPlanned(row));
    }
  }

  // Only keep runs in recoverableRunIds that actually have a held or paused_quota task (A15);
  // empty active runs (or ones with only unresolvable pending tasks) fall through to the legacy loop.
  for (const runId of [...recoverableRunSet]) {
    if (!runsWithHeldOrQuota.has(runId)) {
      recoverableRunSet.delete(runId);
    }
  }
  const finalUntouched: PlannedTask[] = [];
  for (const t of untouched) {
    if (!recoverableRunSet.has(t.runId) && t.status === "pending") {
      legacyFail.push(t);
    } else {
      finalUntouched.push(t);
    }
  }
  untouched.length = 0;
  untouched.push(...finalUntouched);

  relaunch.sort((a, b) => a.tier - b.tier || a.createdAt - b.createdAt || a.id.localeCompare(b.id));

  let staleMerges: RecoveryPlan["staleMerges"] = [];
  try {
    const mRows = raw
      .prepare("SELECT id, run_id, task_id, status FROM merge_queue WHERE status IN ('queued', 'running') ORDER BY created_at ASC")
      .all() as Array<{ id: string; run_id: string; task_id: string; status: string }>;
    staleMerges = mRows.map((m) => ({
      id: String(m.id),
      runId: String(m.run_id),
      taskId: String(m.task_id),
      status: String(m.status),
    }));
  } catch {
    staleMerges = [];
  }

  let pendingTimers: RecoveryPlan["pendingTimers"] = [];
  let revivableTimerIds: string[] = [];
  try {
    const waitTimerIds = new Set<string>();
    try {
      const sleepRows = raw
        .prepare("SELECT payload_json FROM events WHERE type = 'agent.timer_sleep'")
        .all() as Array<{ payload_json: string }>;
      for (const sr of sleepRows) {
        try {
          const payload = JSON.parse(sr.payload_json) as { timerId?: unknown };
          if (typeof payload.timerId === "string" && payload.timerId) waitTimerIds.add(payload.timerId);
        } catch {
          // ignore malformed payload
        }
      }
    } catch {
      // events table missing or unreadable
    }

    const tRows = raw
      .prepare("SELECT id, owner_kind, owner_id, wake_at, reason FROM timers WHERE status = 'pending' ORDER BY wake_at ASC")
      .all() as Array<{ id: string; owner_kind: string; owner_id: string; wake_at: number; reason: string }>;
    pendingTimers = tRows.map((t) => ({
      id: String(t.id),
      ownerKind: String(t.owner_kind),
      ownerId: String(t.owner_id),
      wakeAt: Number(t.wake_at),
      reason: String(t.reason),
      viaWaitTimer: String(t.owner_kind) === "task" && waitTimerIds.has(String(t.id)),
    }));

    if (typeof opts?.legacyStopAt === "number" && Number.isFinite(opts.legacyStopAt) && relaunch.length > 0) {
      const placeholders = relaunch.map(() => "?").join(",");
      const rRows = raw
        .prepare(
          `SELECT id FROM timers
           WHERE status = 'cancelled' AND fired_reason = 'aborted' AND owner_kind = 'task'
             AND fired_at >= ? AND owner_id IN (${placeholders})`,
        )
        .all(opts.legacyStopAt - 1000, ...relaunch.map((t) => t.id)) as Array<{ id: string }>;
      revivableTimerIds = rRows.map((r) => String(r.id));
    }
  } catch {
    pendingTimers = [];
    revivableTimerIds = [];
  }

  const reviewGoals = listInterruptedReviewGoals(raw);

  return {
    recoverableRunIds: [...recoverableRunSet].sort(),
    relaunch,
    cancelReviews,
    legacyFail,
    untouched,
    staleMerges,
    pendingTimers,
    revivableTimerIds,
    reviewGoals,
  };
}

function formatTaskLine(t: PlannedTask): string {
  return `  ${t.id} T${t.tier} ${t.kind} ${t.status} run=${t.runId} "${t.title}"`;
}

export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const inPlace = plan.relaunch.filter((t) => t.worktreeAction === "in_place");
  const recreated = plan.relaunch.filter((t) => t.worktreeAction === "recreate");
  const fallbackRepoRoot = plan.relaunch.filter((t) => t.worktreeAction === "fallback_repo_root");
  const lines: string[] = [];

  lines.push(`1. Relaunched in place (${inPlace.length}):`);
  for (const t of inPlace) lines.push(formatTaskLine(t));

  lines.push(`2. Relaunched with a recreated worktree (${recreated.length}):`);
  for (const t of recreated) lines.push(formatTaskLine(t));

  lines.push(`3. Inherited read-only reference missing, falls back to repo root (${fallbackRepoRoot.length}):`);
  for (const t of fallbackRepoRoot) lines.push(formatTaskLine(t));

  lines.push(`4. Failed by the legacy rule (${plan.legacyFail.length}):`);
  const legacyByRun = new Map<string, { runStatus: string; tasks: PlannedTask[] }>();
  for (const t of plan.legacyFail) {
    let group = legacyByRun.get(t.runId);
    if (!group) {
      group = { runStatus: t.runStatus, tasks: [] };
      legacyByRun.set(t.runId, group);
    }
    group.tasks.push(t);
  }
  for (const [runId, group] of legacyByRun) {
    lines.push(`  run=${runId} (${group.runStatus}):`);
    for (const t of group.tasks) lines.push(`  ${formatTaskLine(t)}`);
  }

  lines.push(`5. Left alone: pending, paused_quota (${plan.untouched.length}):`);
  for (const t of plan.untouched) lines.push(formatTaskLine(t));

  lines.push(`6. Done-Review rows cancelled and re-run (${plan.cancelReviews.length}):`);
  for (const t of plan.cancelReviews) lines.push(formatTaskLine(t));

  lines.push(`7. Pending timers (${plan.pendingTimers.length}):`);
  for (const tm of plan.pendingTimers) {
    const kind = tm.viaWaitTimer ? "wait_timer" : "schedule_timer";
    lines.push(`  ${tm.id} ${tm.ownerKind}:${tm.ownerId} due=${new Date(tm.wakeAt).toISOString()} ${kind} "${tm.reason}"`);
  }

  lines.push(`8. Merge rows closed as ci_failed (${plan.staleMerges.length}):`);
  for (const m of plan.staleMerges) {
    lines.push(`  ${m.id} task=${m.taskId} run=${m.runId} status=${m.status}`);
  }

  lines.push(`9. Goals whose review is replayed (${plan.reviewGoals.length}):`);
  for (const g of plan.reviewGoals) {
    lines.push(`  ${g.goalId} run=${g.runId}`);
  }

  return lines.join("\n");
}

export function applyRecoveryPhaseA(db: ControlPlaneDb, plan: RecoveryPlan, host: PhaseAHost): string[] {
  for (const review of plan.cancelReviews) {
    const rec = db.getTask(review.id);
    if (!rec) continue;
    settleTaskMinimalFallback(
      db,
      rec,
      "cancelled",
      "Review interrupted by daemon restart; the review runs again",
      "daemon_restart",
    );
  }

  for (const runId of plan.recoverableRunIds) {
    db.failStaleMergesForRun(runId, "Interrupted by daemon restart");
  }

  for (const t of plan.relaunch) {
    if (
      ownsWritableWorktree(t) &&
      t.worktreeId &&
      t.worktreeExists &&
      (t.worktreeStatus === "queued" || t.worktreeStatus === "bounced")
    ) {
      db.updateWorktree(t.worktreeId, { status: "active", cleanedAt: null });
    }
  }

  if (plan.revivableTimerIds.length > 0) {
    const placeholders = plan.revivableTimerIds.map(() => "?").join(",");
    db.db
      .prepare(
        `UPDATE timers SET status = 'pending', fired_reason = NULL, fired_at = NULL
         WHERE status = 'cancelled' AND fired_reason = 'aborted' AND id IN (${placeholders})`,
      )
      .run(...plan.revivableTimerIds);
  }

  db.db
    .prepare(
      `UPDATE write_leases SET active = 0
       WHERE active = 1 AND NOT EXISTS (
         SELECT 1 FROM tasks t JOIN runs r ON r.id = t.run_id
         WHERE t.id = write_leases.task_id AND (
           t.status = 'paused_quota'
           OR (t.status IN ('pending','ready','running','draining','waiting_children','merging')
               AND (r.status IN ('active','paused_quota') OR r.id LIKE 'director-tasks-%'))))`,
    )
    .run();

  const heldIds: string[] = [];
  for (const t of plan.relaunch) {
    host.hold(t.id);
    heldIds.push(t.id);
  }

  const quotaRuns = new Set<string>();
  for (const t of plan.untouched) {
    if (t.status === "paused_quota") quotaRuns.add(t.runId);
  }
  for (const runId of plan.recoverableRunIds) {
    if (quotaRuns.has(runId) || db.getRun(runId)?.status === "paused_quota") {
      host.checkQuota(runId);
    }
  }

  return heldIds;
}

export function sanitizeRestartHandoff(h: AnchoredHandoff): AnchoredHandoff {
  const drainPrefix = `Steered update: ${DRAIN_STEER_MARKER}`;
  const { handoff } = normalizeHandoff(h);
  return {
    ...handoff,
    nextActions: handoff.nextActions.filter((entry) => !entry.startsWith(drainPrefix)),
  };
}

function getWaitTimerIdsForTask(db: ControlPlaneDb, runId: string, taskId: string): Set<string> {
  const ids = new Set<string>();
  try {
    const rows = db.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND type = 'agent.timer_sleep'")
      .all(runId, taskId) as Array<{ payload_json: string }>;
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.payload_json) as { timerId?: unknown };
        if (typeof parsed.timerId === "string" && parsed.timerId) ids.add(parsed.timerId);
      } catch {
        // ignore malformed payload
      }
    }
  } catch {
    // ignore
  }
  return ids;
}

function latestMergeRowForTask(
  db: ControlPlaneDb,
  taskId: string,
): { status: string; log: string | null; branch: string } | null {
  try {
    const row = db.db
      .prepare("SELECT status, log, branch FROM merge_queue WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as { status: string; log: string | null; branch: string } | undefined;
    if (!row) return null;
    return { status: String(row.status), log: row.log == null ? null : String(row.log), branch: String(row.branch) };
  } catch {
    return null;
  }
}

export async function relaunchInterruptedTasks(
  host: RecoveryHost,
  taskIds: string[],
  opts: { reason: string; staggerMs: number; onFailed?: (failure: { id: string; error: string }) => void },
): Promise<string[]> {
  const launched: string[] = [];
  const failed: { id: string; error: string }[] = [];
  if (taskIds.length === 0) return launched;
  console.error(`[harnessd ${new Date().toISOString()}] recovery: starting phase B for ${taskIds.length} task(s)`);

  for (let i = 0; i < taskIds.length; i++) {
    const taskId = taskIds[i]!;
    if (host.isStopping()) break;

    try {
      if (host.isActive?.(taskId)) {
        host.release(taskId);
        continue;
      }

      const task = host.db.getTask(taskId);
      const run = task ? host.db.getRun(task.runId) : null;
      if (!task || !run || (!LIVE_STATUSES.has(task.status) && task.status !== "ready") || isRunStoppedForRecovery(run)) {
        console.error(
          `[harnessd ${new Date().toISOString()}] recovery: ${taskId} skipped (task=${task?.status ?? "missing"}, run=${run?.status ?? "missing"})`,
        );
        host.release(taskId);
        continue;
      }

      const fromStatus = task.status;
      const wasLive = LIVE_STATUSES.has(fromStatus);
      let wt = task.worktreeId ? host.db.getWorktree(task.worktreeId) : null;
      let mergedWorktreeNote: string | null = null;
      let archiveWorktreeNote: string | null = null;

      if (task.worktreeId) {
        const ownsWritable = ownsWritableWorktree({
          id: task.id,
          tier: task.tier,
          kind: task.kind,
          readOnly: task.readOnly,
          worktreeId: task.worktreeId,
          worktreeTaskId: wt?.taskId ?? null,
        });
        if (ownsWritable) {
          if (wt && wt.runId === task.runId && existsSync(wt.path)) {
            if (wt.status !== "active" && wt.status !== "merged") {
              host.db.updateWorktree(wt.id, { status: "active", cleanedAt: null });
              wt = host.db.getWorktree(wt.id);
            } else if (wt.status === "merged") {
              mergedWorktreeNote = `Your branch ${wt.branch} is already merged. Do not edit or resubmit. Call return_task with your summary.`;
            }
          } else {
            const prevWt = wt;
            const mgr = host.worktrees(run.repoRoot);
            try {
              if (await mgr.isGitRepo()) {
                wt = await mgr.createForWorker(run.id, task.id, undefined, { force: true });
                const prevId = prevWt?.id ?? task.worktreeId;
                const branchHint = prevWt?.branch ? ` (previous branch ${prevWt.branch})` : "";
                archiveWorktreeNote =
                  `The previous worktree ${prevId}${branchHint} was archived before the daemon restart; this generation starts on a fresh worktree from base branch ${run.baseBranch || "HEAD"}` +
                  (prevWt?.archiveRef
                    ? ` and the archived work is at ${prevWt.archiveRef} (inspect it with \`git log ${prevWt.archiveRef}\` and cherry-pick what is still needed).`
                    : prevWt?.branch
                      ? ` (nothing unmerged was archived; check \`git log ${prevWt.branch}\` if any commits remain on the previous branch).`
                      : " (nothing unmerged was archived).");
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              const failure = { id: taskId, error: `worktree recreation failed: ${msg}` };
              failed.push(failure);
              opts.onFailed?.(failure);
              console.error(`[harnessd ${new Date().toISOString()}] recovery: ${taskId} skipped (worktree recreation failed: ${msg})`);
              host.db.emitEvent(run.id, task.id, "agent.error", {
                error: `Recovery worktree recreation failed: ${msg}`,
              });
              host.release(task.id);
              continue;
            }
          }
        } else if (!wt || wt.runId !== task.runId || !existsSync(wt.path)) {
          // Read-only / inherited worktree whose checkout is gone: clear worktreeId so the runner falls back to run.repoRoot.
          host.db.updateTask(task.id, { worktreeId: null });
          wt = null;
        }
      }

      if (host.isStopping()) break;

      let handoff: AnchoredHandoff | null = null;
      try {
        const parsedStored = parseHandoffWithStatus(task.handoffJson);
        if (parsedStored.malformed) {
          console.error(
            `[harnessd ${new Date().toISOString()}] recovery: ${taskId} malformed stored handoff (${parsedStored.reason ?? "invalid shape"}); using sanitized/minimal handoff`,
          );
        }
        const taskForHandoff: TaskRecord =
          parsedStored.malformed || (task.handoffJson && parsedStored.handoff === null)
            ? { ...task, handoffJson: parsedStored.handoff ? JSON.stringify(parsedStored.handoff) : null }
            : task;
        if (wasLive && fromStatus !== "draining") {
          handoff = await host.buildHandoff(taskForHandoff, wt?.path ?? null, opts.reason, null);
        } else if (fromStatus === "draining") {
          handoff = await host.buildHandoff(taskForHandoff, wt?.path ?? null, opts.reason, parsedStored.handoff);
        } else if (parsedStored.handoff !== null) {
          handoff = parsedStored.handoff;
        } else if (parsedStored.malformed) {
          handoff = minimalRecoveryHandoff(task.generation, parsedStored.reason ?? "malformed stored handoff");
        }
        if (handoff !== null) {
          handoff = sanitizeRestartHandoff(handoff);
        }
      } catch (handoffErr) {
        const msg = handoffErr instanceof Error ? handoffErr.message : String(handoffErr);
        console.error(
          `[harnessd ${new Date().toISOString()}] recovery: ${taskId} handoff failed (${msg}); falling back to minimal recovery handoff`,
        );
        handoff = minimalRecoveryHandoff(task.generation, msg);
      }

      if (host.isStopping()) break;

      const latestTask = host.db.getTask(taskId);
      const latestRun = latestTask ? host.db.getRun(latestTask.runId) : null;
      if (
        !latestTask ||
        !latestRun ||
        (!LIVE_STATUSES.has(latestTask.status) && latestTask.status !== "ready") ||
        isRunStoppedForRecovery(latestRun)
      ) {
        console.error(
          `[harnessd ${new Date().toISOString()}] recovery: ${taskId} skipped after handoff (task=${latestTask?.status ?? "missing"}, run=${latestRun?.status ?? "missing"})`,
        );
        host.release(taskId);
        continue;
      }

      if (handoff !== null) {
        const prefix: string[] = [];

        if (wasLive) {
          prefix.push(
            `The daemon restarted (${opts.reason}). Your previous session ended mid-turn. Anything you had not written to the worktree, an artifact or a tool call is lost. Worktree edits and commits are preserved. Inspect the worktree before continuing.`,
          );
        }

        if (task.tier === 1 || task.tier === 2) {
          prefix.push(
            "Your child tasks already exist. Call tree_view with include_settled true before spawning anything. Never spawn a task that already exists. Use wait_children or resume_task.",
          );
        }

        const taskTimers = host.db.timers.list({ ownerKind: "task", ownerId: task.id, status: "pending" });
        if (taskTimers.length > 0) {
          const waitTimerIds = getWaitTimerIdsForTask(host.db, run.id, task.id);
          for (const tm of taskTimers) {
            const due = new Date(tm.wakeAt).toISOString();
            if (waitTimerIds.has(tm.id)) {
              prefix.push(
                `You were blocked in wait_timer on ${tm.id} ("${tm.reason}", due ${due}) when the daemon restarted. The timer is still scheduled and fires once as the steering message "[SCHEDULED TIMER ${tm.id} FIRED]". Do not create a replacement. If you have nothing to do until then, call wait_children when you have unsettled children (the steering message wakes it). With no unsettled children, call cancel_timer for ${tm.id} and then wait_timer for the remaining time.`,
              );
            } else {
              prefix.push(
                `Timer ${tm.id} ("${tm.reason}", due ${due}) is still scheduled. It fires once and steers you. Do not schedule it again.`,
              );
            }
          }
        }

        const lastMerge = latestMergeRowForTask(host.db, task.id);
        const mergeInterrupted =
          fromStatus === "merging" ||
          (lastMerge?.status === "ci_failed" &&
            Boolean(
              lastMerge.log &&
                (lastMerge.log.startsWith("Merge aborted") || lastMerge.log === "Interrupted by daemon restart"),
            ));
        if (mergeInterrupted) {
          const branch = wt?.branch ?? lastMerge?.branch ?? "your branch";
          const base = run.baseBranch || "main";
          prefix.push(
            `Your submit_for_merge was interrupted by the daemon restart. Run git merge-base --is-ancestor ${branch} ${base} first. If it succeeds your branch is merged: call return_task. Otherwise call submit_for_merge again.`,
          );
        }

        if (mergedWorktreeNote) prefix.push(mergedWorktreeNote);
        if (archiveWorktreeNote) prefix.push(archiveWorktreeNote);

        const existingSet = new Set(handoff.nextActions);
        const toPrepend = prefix.filter((line) => !existingSet.has(line));
        if (toPrepend.length > 0) {
          handoff = { ...handoff, nextActions: [...toPrepend, ...handoff.nextActions] };
        }

        const nextJson = JSON.stringify(handoff);
        if (wasLive) {
          host.db.updateTask(task.id, {
            status: "ready",
            sessionId: null,
            contextUsed: 0,
            summary: null,
            handoffJson: nextJson,
          });
          host.setResumeNote(task.id, {
            kind: "resume",
            reason: opts.reason,
            userMessage: "Continue from the preserved worktree and artifacts without redoing completed steps.",
          });
          host.db.emitEvent(run.id, task.id, "task.resumed", {
            taskId: task.id,
            fromStatus,
            generation: task.generation,
            model: task.model,
            effort: task.effort,
            note: "daemon_restart",
          });
        } else if (nextJson !== latestTask.handoffJson) {
          host.db.updateTask(task.id, { handoffJson: nextJson });
        }
      }

      host.release(task.id);
      host.launch(task.id);
      launched.push(task.id);
      console.error(
        `[harnessd ${new Date().toISOString()}] recovery: ${task.id} relaunched (T${task.tier} ${task.kind}, from=${fromStatus}, gen=${task.generation})`,
      );

      if (opts.staggerMs > 0 && i < taskIds.length - 1 && !host.isStopping()) {
        await new Promise((r) => setTimeout(r, opts.staggerMs));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const failure = { id: taskId, error: msg };
      failed.push(failure);
      opts.onFailed?.(failure);
      console.error(`[harnessd ${new Date().toISOString()}] recovery: ${taskId} failed to relaunch (${msg}); releasing hold`);
      try {
        host.release(taskId);
      } catch {
        // best-effort release
      }
    }
  }

  if (failed.length > 0) {
    console.error(
      `[harnessd ${new Date().toISOString()}] recovery: degraded phase B (${launched.length} launched, ${failed.length} failed: ${failed.map((f) => f.id).join(", ")})`,
    );
  }

  return launched;
}

export function replayInterruptedReviews(
  db: ControlPlaneDb,
  goals: { setStatus(id: string, status: "executing"): unknown },
  rows: { goalId: string; runId: string }[],
): void {
  for (const { goalId, runId } of rows) {
    const run = db.getRun(runId);
    if (!run) continue;
    if (run.status === "completed" || run.status === "failed") {
      let payload: Record<string, unknown> = { status: run.status };
      try {
        const ev = db.db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'run.status' ORDER BY seq DESC LIMIT 1")
          .get(runId) as { payload_json: string } | undefined;
        if (ev?.payload_json) {
          const parsed = JSON.parse(ev.payload_json) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") payload = parsed;
        }
      } catch {
        // fallback to minimal status payload
      }
      db.emitEvent(runId, null, "run.status", { ...payload, replayed: true });
    } else if (run.status === "active" || run.status === "paused_quota") {
      goals.setStatus(goalId, "executing");
    }
  }
}

function normalizeTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?:;,\s]+$/, "");
}

export function spawnDuplicateAdvisory(
  db: ControlPlaneDb,
  caller: TaskRecord,
  newTaskId: string,
  title: string,
): string | null {
  let resumedAfterRestart = false;
  try {
    const rows = db.db
      .prepare("SELECT payload_json FROM events WHERE run_id = ? AND task_id = ? AND type = 'task.resumed' ORDER BY seq DESC")
      .all(caller.runId, caller.id) as Array<{ payload_json: string }>;
    for (const row of rows) {
      try {
        const p = JSON.parse(row.payload_json) as { note?: unknown; generation?: unknown };
        if (p.note === "daemon_restart" && Number(p.generation) === caller.generation) {
          resumedAfterRestart = true;
          break;
        }
      } catch {
        // ignore
      }
    }
  } catch {
    return null;
  }
  if (!resumedAfterRestart) return null;

  const targetNorm = normalizeTaskTitle(title);
  if (!targetNorm) return null;
  const siblings = db.listTasks(caller.runId, { parentId: caller.id });
  const existing = siblings.find(
    (t) =>
      t.id !== newTaskId &&
      !TERMINAL_STATUSES.has(t.status) &&
      normalizeTaskTitle(t.title) === targetNorm,
  );
  if (!existing) return null;

  return `Task ${existing.id} ("${existing.title}", ${existing.status}) with the same title already exists under you and predates the daemon restart. ${newTaskId} was created anyway. If it is a duplicate, cancel_task it and use wait_children or resume_task on ${existing.id}.`;
}
