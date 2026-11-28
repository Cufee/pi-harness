import type { Database } from "bun:sqlite";
import { friendlyIdCandidates, nextFriendlyId } from "./ids.js";

/**
 * Durable state a lead thread (the Tier 1 task of a run) drives its goal with: its plan, and the request ledger
 * that carries work and questions between the user, the Director, and the lead.
 *
 * The harness reads both at turn boundaries (hydration, the turn-end check, the Director's turn banner), so
 * neither a rollover nor a daemon restart can lose a plan step, a forwarded user request, or a question the
 * user has not answered yet.
 */

export type PlanStepStatus = "pending" | "in_progress" | "done" | "dropped";

export type PlanDelivery = "merge" | "external" | "none";

export interface PlanStep {
  id: string;
  title: string;
  status: PlanStepStatus;
  /** "self", or the id of the child task that owns the step. */
  owner: string;
  /** Goal criterion ids this step is meant to satisfy. */
  criteria: string[];
  note: string | null;
}

export interface ThreadPlan {
  taskId: string;
  runId: string;
  /** What the thread took on, and what it left out. */
  scope: string;
  /**
   * How the work reaches the user. merge: on the run's base branch through the merge queue. external: pushed or
   * published somewhere else, named in deliveryNote. none: the goal produces no repository change.
   */
  delivery: PlanDelivery;
  deliveryNote: string | null;
  steps: PlanStep[];
  /** Bumped on every write. */
  revision: number;
  updatedAt: number;
}

/**
 * user_request: the Director forwarded something the user asked for mid-flight; the lead triages it.
 * user_question: the lead needs an answer from the user; the Director asks and re-asks until it is answered.
 * routed_work: the lead sent work back as out of its scope; the Director reschedules or drops it.
 */
export type ThreadRequestKind = "user_request" | "user_question" | "routed_work";

export type ThreadRequestOutcome =
  // user_request, decided by the lead
  | "accepted"
  | "delegated"
  | "answered"
  | "declined"
  // user_question, decided by the Director (with the user's answer) or the lead
  | "user_answered"
  | "withdrawn"
  // routed_work, decided by the Director
  | "rescheduled"
  | "dropped";

export const REQUEST_OUTCOMES: Readonly<Record<ThreadRequestKind, readonly ThreadRequestOutcome[]>> = {
  user_request: ["accepted", "delegated", "answered", "declined"],
  user_question: ["user_answered", "withdrawn"],
  routed_work: ["rescheduled", "dropped"],
};

export interface ThreadRequestRecord {
  id: string;
  kind: ThreadRequestKind;
  runId: string;
  /** The lead task the request is addressed to (user_request) or came from (user_question, routed_work). */
  taskId: string;
  /** The Director chat that owns the run, when it has one. */
  chatSessionId: string | null;
  goalId: string | null;
  title: string;
  body: string;
  status: "open" | "resolved";
  outcome: ThreadRequestOutcome | null;
  /** The lead's triage note, the user's answer, or the Director's rescheduling note. */
  resolution: string | null;
  /** The request this one continues: a routed_work created by declining a user_request points at it. */
  originId: string | null;
  /** The child task that took a delegated user_request. */
  delegatedTaskId: string | null;
  /** user_question: how many Director replies have shown it to the user. */
  promptCount: number;
  lastPromptedAt: number | null;
  createdAt: number;
  resolvedAt: number | null;
}

export const THREAD_STATE_SCHEMA = `
CREATE TABLE IF NOT EXISTS thread_plans (
  task_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  delivery TEXT NOT NULL DEFAULT 'merge',
  delivery_note TEXT,
  steps_json TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user_request','user_question','routed_work')),
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  chat_session_id TEXT,
  goal_id TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  outcome TEXT,
  resolution TEXT,
  origin_id TEXT,
  delegated_task_id TEXT,
  prompt_count INTEGER NOT NULL DEFAULT 0,
  last_prompted_at INTEGER,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_thread_requests_task ON thread_requests(task_id, status);
CREATE INDEX IF NOT EXISTS idx_thread_requests_chat ON thread_requests(chat_session_id, status);
`;

const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "done", "dropped"]);
const MAX_PLAN_STEPS = 40;
const MAX_STEP_TITLE_CHARS = 240;
const MAX_NOTE_CHARS = 600;
const MAX_SCOPE_CHARS = 2000;

function clip(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Validates a plan as an agent wrote it. Throws with the exact field that is wrong. */
export function parsePlanSteps(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) throw new Error("steps must be an array");
  if (raw.length === 0) throw new Error("steps must contain at least one step");
  if (raw.length > MAX_PLAN_STEPS) throw new Error(`steps holds ${raw.length} entries; the limit is ${MAX_PLAN_STEPS}. Merge related steps.`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`steps[${index}] must be an object`);
    const step = entry as Record<string, unknown>;
    const id = clip(step.id ?? `s${index + 1}`, 40);
    if (!id) throw new Error(`steps[${index}].id must not be blank`);
    if (seen.has(id)) throw new Error(`steps[${index}].id "${id}" is used twice`);
    seen.add(id);
    const title = clip(step.title, MAX_STEP_TITLE_CHARS);
    if (!title) throw new Error(`steps[${index}].title is required`);
    const status = step.status === undefined ? "pending" : String(step.status);
    if (!STEP_STATUSES.has(status)) {
      throw new Error(`steps[${index}].status "${status}" is not one of pending, in_progress, done, dropped`);
    }
    const note = clip(step.note, MAX_NOTE_CHARS);
    if (status === "dropped" && !note) throw new Error(`steps[${index}] is dropped; say why in note`);
    return {
      id,
      title,
      status: status as PlanStepStatus,
      owner: clip(step.owner, 40) || "self",
      criteria: Array.isArray(step.criteria) ? step.criteria.map((c) => clip(c, 40)).filter(Boolean) : [],
      note: note || null,
    };
  });
}

export function openPlanSteps(plan: ThreadPlan | null): PlanStep[] {
  return plan ? plan.steps.filter((s) => s.status === "pending" || s.status === "in_progress") : [];
}

/** One line per step, for prompts. */
export function formatPlanForPrompt(plan: ThreadPlan): string[] {
  const mark: Record<PlanStepStatus, string> = { pending: " ", in_progress: "~", done: "x", dropped: "-" };
  const lines: string[] = [];
  if (plan.scope) lines.push(`Scope: ${plan.scope}`);
  if (plan.delivery !== "merge") lines.push(`Delivery: ${plan.delivery}${plan.deliveryNote ? ` (${plan.deliveryNote})` : ""}`);
  for (const s of plan.steps) {
    const owner = s.owner !== "self" ? ` (owner: ${s.owner})` : "";
    const criteria = s.criteria.length ? ` [criteria: ${s.criteria.join(", ")}]` : "";
    const note = s.note ? ` — ${s.note}` : "";
    lines.push(`- [${mark[s.status]}] ${s.id}: ${s.title}${owner}${criteria}${note}`);
  }
  return lines;
}

export class ThreadStateStore {
  constructor(private readonly db: Database) {
    this.db.exec(THREAD_STATE_SCHEMA);
  }

  getPlan(taskId: string): ThreadPlan | null {
    const row = this.db.prepare("SELECT * FROM thread_plans WHERE task_id = ?").get(taskId) as Record<string, unknown> | undefined;
    if (!row) return null;
    let steps: PlanStep[] = [];
    try {
      steps = JSON.parse(String(row.steps_json)) as PlanStep[];
    } catch {
      steps = [];
    }
    return {
      taskId: String(row.task_id),
      runId: String(row.run_id),
      scope: String(row.scope ?? ""),
      delivery: row.delivery === "external" || row.delivery === "none" ? row.delivery : "merge",
      deliveryNote: row.delivery_note ? String(row.delivery_note) : null,
      steps,
      revision: Number(row.revision),
      updatedAt: Number(row.updated_at),
    };
  }

  /** Replaces the steps. Scope and delivery keep their stored value when omitted. */
  setPlan(input: {
    taskId: string;
    runId: string;
    scope?: string;
    delivery?: PlanDelivery;
    deliveryNote?: string | null;
    steps: PlanStep[];
  }): ThreadPlan {
    const now = Date.now();
    const prior = this.getPlan(input.taskId);
    const scope = input.scope === undefined ? (prior?.scope ?? "") : clip(input.scope, MAX_SCOPE_CHARS);
    const delivery = input.delivery ?? prior?.delivery ?? "merge";
    const deliveryNote =
      input.deliveryNote === undefined ? (prior?.deliveryNote ?? null) : clip(input.deliveryNote, MAX_NOTE_CHARS) || null;
    if (delivery === "external" && !deliveryNote) {
      throw new Error('delivery "external" needs delivery_note: say where the work goes (remote and branch, PR URL, or artifact path).');
    }
    this.db
      .prepare(
        `INSERT INTO thread_plans(task_id, run_id, scope, delivery, delivery_note, steps_json, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(task_id) DO UPDATE SET scope = excluded.scope, delivery = excluded.delivery,
           delivery_note = excluded.delivery_note, steps_json = excluded.steps_json,
           revision = thread_plans.revision + 1, updated_at = excluded.updated_at`,
      )
      .run(input.taskId, input.runId, scope, delivery, deliveryNote, JSON.stringify(input.steps), now);
    return this.getPlan(input.taskId)!;
  }

  createRequest(input: {
    kind: ThreadRequestKind;
    runId: string;
    taskId: string;
    chatSessionId?: string | null;
    goalId?: string | null;
    title: string;
    body: string;
    originId?: string | null;
  }): ThreadRequestRecord {
    const id = nextFriendlyId(this.db, "req", "thread_requests");
    this.db
      .prepare(
        `INSERT INTO thread_requests(id, kind, run_id, task_id, chat_session_id, goal_id, title, body, origin_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.kind,
        input.runId,
        input.taskId,
        input.chatSessionId ?? null,
        input.goalId ?? null,
        clip(input.title, 200) || "Untitled request",
        String(input.body ?? "").trim(),
        input.originId ?? null,
        Date.now(),
      );
    return this.getRequest(id)!;
  }

  getRequest(id: string): ThreadRequestRecord | null {
    for (const candidate of friendlyIdCandidates(id, "req")) {
      const row = this.db.prepare("SELECT * FROM thread_requests WHERE id = ?").get(candidate) as Record<string, unknown> | undefined;
      if (row) return this.mapRequest(row);
    }
    return null;
  }

  listRequests(filter: {
    taskId?: string;
    runId?: string;
    chatSessionId?: string;
    kind?: ThreadRequestKind;
    status?: "open" | "resolved";
    limit?: number;
  }): ThreadRequestRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    for (const [column, value] of [
      ["task_id", filter.taskId],
      ["run_id", filter.runId],
      ["chat_session_id", filter.chatSessionId],
      ["kind", filter.kind],
      ["status", filter.status],
    ] as const) {
      if (value !== undefined) {
        where.push(`${column} = ?`);
        params.push(value);
      }
    }
    params.push(Math.max(1, Math.min(500, filter.limit ?? 200)));
    const rows = this.db
      .prepare(
        `SELECT * FROM thread_requests ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at ASC, rowid ASC LIMIT ?`,
      )
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRequest(r));
  }

  /** Resolves an open request. Throws when it is unknown, already resolved, or the outcome does not fit its kind. */
  resolveRequest(
    id: string,
    input: { outcome: ThreadRequestOutcome; resolution?: string | null; delegatedTaskId?: string | null },
  ): ThreadRequestRecord {
    const current = this.getRequest(id);
    if (!current) throw new Error(`Unknown request ${id}`);
    if (current.status !== "open") {
      throw new Error(`Request ${current.id} is already resolved (${current.outcome ?? "no outcome"}); nothing was changed.`);
    }
    if (!REQUEST_OUTCOMES[current.kind].includes(input.outcome)) {
      throw new Error(
        `Outcome "${input.outcome}" does not apply to a ${current.kind} request; use one of ${REQUEST_OUTCOMES[current.kind].join(", ")}.`,
      );
    }
    this.db
      .prepare(
        "UPDATE thread_requests SET status = 'resolved', outcome = ?, resolution = ?, delegated_task_id = ?, resolved_at = ? WHERE id = ? AND status = 'open'",
      )
      .run(input.outcome, input.resolution?.trim() || null, input.delegatedTaskId ?? null, Date.now(), current.id);
    return this.getRequest(current.id)!;
  }

  /** Records that a Director reply showed these questions to the user. */
  markPrompted(ids: readonly string[]): void {
    const now = Date.now();
    const stmt = this.db.prepare(
      "UPDATE thread_requests SET prompt_count = prompt_count + 1, last_prompted_at = ? WHERE id = ? AND status = 'open'",
    );
    for (const id of ids) stmt.run(now, id);
  }

  private mapRequest(row: Record<string, unknown>): ThreadRequestRecord {
    return {
      id: String(row.id),
      kind: String(row.kind) as ThreadRequestKind,
      runId: String(row.run_id),
      taskId: String(row.task_id),
      chatSessionId: row.chat_session_id ? String(row.chat_session_id) : null,
      goalId: row.goal_id ? String(row.goal_id) : null,
      title: String(row.title),
      body: String(row.body),
      status: row.status === "resolved" ? "resolved" : "open",
      outcome: row.outcome ? (String(row.outcome) as ThreadRequestOutcome) : null,
      resolution: row.resolution ? String(row.resolution) : null,
      originId: row.origin_id ? String(row.origin_id) : null,
      delegatedTaskId: row.delegated_task_id ? String(row.delegated_task_id) : null,
      promptCount: Number(row.prompt_count ?? 0),
      lastPromptedAt: row.last_prompted_at == null ? null : Number(row.last_prompted_at),
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at == null ? null : Number(row.resolved_at),
    };
  }
}
