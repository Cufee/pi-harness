import { randomUUID } from "node:crypto";
import type { CodeExecToolEvent } from "../code-mode/index.js";
import type { EscalationRecord, TaskRecord } from "../control-plane/db.js";
import type { GoalRecord, GoalReviewVerdict } from "../goals/engine.js";

/** Pair each inner call's start and end for live pills and replay, even for parallel calls of the same tool. */
export function codeExecEventSink(emit: (event: { id: string; name: string; status: string; via: "code_exec" }) => void) {
  const ids = new WeakMap<CodeExecToolEvent["args"], string>();
  return ({ name, args, phase, ok, via }: CodeExecToolEvent) => {
    const id = ids.get(args) ?? randomUUID();
    if (phase === "start") ids.set(args, id);
    emit({ id, name, status: phase === "start" ? "in_progress" : ok ? "completed" : "failed", via });
  };
}

/** Structured tool-output display (contract/tool-display-v1). Rendered by the TUI instead of a compact tool pill. */
export interface ToolDisplayPayload {
  kind: string;
  title?: string;
  data: unknown;
}

export interface GoalsTableRow {
  id: string;
  version: number;
  status: string;
  title: string;
  linkedRunId: string | null;
  reviewCycle: number;
  maxReviewCycles: number;
  criteriaTotal: number;
  /** Passed criteria in the latest review; null if never reviewed. */
  criteriaPassed: number | null;
  openEscalations: number;
}

export interface GoalsTableData {
  goals: GoalsTableRow[];
}

export interface GoalDetailData {
  goal: {
    id: string;
    version: number;
    status: string;
    title: string;
    description: string;
    linkedRunId: string | null;
    reviewCycle: number;
    maxReviewCycles: number;
    nonGoals: string[];
  };
  criteria: Array<{
    id: string;
    kind: string;
    description: string;
    command?: string;
    required: boolean;
    lastResult: "pass" | "fail" | null;
  }>;
  tasks: Array<{ id: string; title: string; status: string; tier: number }>;
  openEscalations: Array<{ id: string; taskId: string; summary: string }>;
  lastReview: { cycle: number; verdict: string; summary: string } | null;
}

/** The latest review: review cycles strictly increase per goal (amendments never reset them). */
function latestReview(reviews: GoalReviewVerdict[]): GoalReviewVerdict | null {
  let latest: GoalReviewVerdict | null = null;
  for (const r of reviews) if (!latest || r.cycle > latest.cycle) latest = r;
  return latest;
}

function criterionResults(goal: GoalRecord, review: GoalReviewVerdict | null): Map<string, "pass" | "fail"> {
  const results = new Map<string, "pass" | "fail">();
  if (!review) return results;
  const ids = new Set(goal.criteria.map((c) => c.id));
  for (const r of review.criteriaResults) {
    if (ids.has(r.criterionId)) results.set(r.criterionId, r.passed ? "pass" : "fail");
  }
  return results;
}

export function buildGoalsTableDisplay(
  entries: Array<{ goal: GoalRecord; reviews: GoalReviewVerdict[]; openEscalations: EscalationRecord[] }>,
): ToolDisplayPayload {
  const goals: GoalsTableRow[] = entries.map(({ goal, reviews, openEscalations }) => {
    const review = latestReview(reviews);
    const results = criterionResults(goal, review);
    return {
      id: goal.id,
      version: goal.version,
      status: goal.status,
      title: goal.title,
      linkedRunId: goal.linkedRunId,
      reviewCycle: goal.reviewCycle,
      maxReviewCycles: goal.budgets.maxReviewCycles,
      criteriaTotal: goal.criteria.length,
      criteriaPassed: review ? [...results.values()].filter((v) => v === "pass").length : null,
      openEscalations: openEscalations.length,
    };
  });
  return { kind: "goals_table", title: "Goals", data: { goals } satisfies GoalsTableData };
}

export function buildGoalDetailDisplay(input: {
  goal: GoalRecord;
  reviews: GoalReviewVerdict[];
  tasks: TaskRecord[];
  openEscalations: EscalationRecord[];
}): ToolDisplayPayload {
  const { goal } = input;
  const review = latestReview(input.reviews);
  const results = criterionResults(goal, review);
  const data: GoalDetailData = {
    goal: {
      id: goal.id,
      version: goal.version,
      status: goal.status,
      title: goal.title,
      description: goal.description,
      linkedRunId: goal.linkedRunId,
      reviewCycle: goal.reviewCycle,
      maxReviewCycles: goal.budgets.maxReviewCycles,
      nonGoals: goal.nonGoals,
    },
    criteria: goal.criteria.map((c) => ({
      id: c.id,
      kind: c.kind,
      description: c.description,
      ...(c.command ? { command: c.command } : {}),
      required: c.required,
      lastResult: results.get(c.id) ?? null,
    })),
    tasks: input.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, tier: t.tier })),
    openEscalations: input.openEscalations.map((e) => ({ id: e.id, taskId: e.fromTaskId, summary: e.title })),
    lastReview: review ? { cycle: review.cycle, verdict: review.verdict, summary: review.summary } : null,
  };
  return { kind: "goal_detail", title: `Goal ${goal.id} v${goal.version}`, data };
}

/** Short plain-text summary stored as a tool_output turn's content (and shown to the model in place of the display). */
export function summarizeToolDisplay(toolName: string, display: ToolDisplayPayload): string {
  if (display.kind === "goals_table") {
    const n = (display.data as GoalsTableData).goals.length;
    return `${toolName} → Goals table (${n} goal${n === 1 ? "" : "s"})`;
  }
  if (display.kind === "goal_detail") {
    const g = (display.data as GoalDetailData).goal;
    return `${toolName} → Goal ${g.id} v${g.version} detail (${g.status})`;
  }
  return `${toolName} → ${display.title ?? display.kind}`;
}
