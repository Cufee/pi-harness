import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EscalationRecord, TaskRecord } from "../control-plane/db.js";
import { compactTaskHandoff } from "../control-plane/handoffs.js";
import type { RunActivitySummary, TaskActivitySnapshot } from "../control-plane/telemetry.js";
import type { GoalLiveProgress, GoalRecord, GoalReviewVerdict } from "../goals/engine.js";
import { isReviewInvalidated } from "../protocol/chat-events.js";
import type { ToolDefinition } from "../runners/types.js";

export const GOAL_GET_LIMITS = {
  budgetChars: 40_000, // hard target for JSON.stringify(result); client limit is 50,000
  descriptionExcerpt: 1_500,
  descriptionPage: 30_000,
  criterionDescription: 280,
  criterionCommand: 200,
  reviewSummary: 1_200,
  blockingIssue: 300,
  blockingIssuesMax: 10,
  evidence: 240,
  remediation: 200,
  taskTitle: 120,
  taskSummary: 240,
  tasksMax: 30,
  escalationTitle: 200,
  nonGoal: 300,
  nonGoalsMax: 20,
  reviewsDefault: 1,
  reviewsMax: 10,
} as const;

export const GOAL_GET_SECTIONS = ["goal", "description", "criteria", "reviews", "run", "escalations"] as const;
export type GoalGetSection = (typeof GOAL_GET_SECTIONS)[number];
export const DEFAULT_GOAL_GET_SECTIONS: readonly GoalGetSection[] = [
  "goal",
  "criteria",
  "reviews",
  "run",
  "escalations",
];

const ALLOWED_SECTIONS_SET = new Set<string>(GOAL_GET_SECTIONS);

export const GOAL_GET_TOOL: ToolDefinition = {
  name: "goal_get",
  description:
    "Inspect a Goal. Default output is compact and always fits one tool result: goal header with a description excerpt and a path to the full text, " +
    "every criterion with its id, kind, required flag and latest status, the latest review in full, the run's tasks (one-line summaries) and activity, and open escalations. " +
    "Narrow it with sections (goal, description, criteria, reviews, run, escalations). Page older reviews with reviews_limit (default 1, max 10; only the newest returned review includes criteriaResults) and reviews_before_cycle (pass reviewsPage.nextBeforeCycle). " +
    "Read the full description with read_file on description.path, or sections: ['description'] with description_offset (pages of 30000 characters). Full task handoffs: run_status. " +
    "Pass the returned presentation_id to present_result to show the Goal detail card.",
  inputSchema: {
    type: "object",
    required: ["goal_id"],
    properties: {
      goal_id: { type: "string" },
      sections: {
        type: "array",
        items: { type: "string", enum: ["goal", "description", "criteria", "reviews", "run", "escalations"] },
        description: "Sections to return. Default: goal, criteria, reviews, run, escalations (description is opt-in).",
      },
      reviews_limit: { type: "number", description: "Reviews to return, newest first. Default 1, max 10." },
      reviews_before_cycle: { type: "number", description: "Only reviews with cycle below this value (paging)." },
      description_offset: {
        type: "number",
        description: "Character offset into the full description when sections includes description. Default 0.",
      },
    },
  },
};

export interface GoalGetOptions {
  sections: GoalGetSection[];
  reviewsLimit: number;
  reviewsBeforeCycle: number | null;
  descriptionOffset: number;
}

/** Structural input matching `DirectorRuntime.goalDisplayData(goal)`. */
export interface GoalGetDetailInput {
  goal: GoalRecord;
  reviews: GoalReviewVerdict[];
  tasks: TaskRecord[];
  openEscalations: EscalationRecord[];
  activity: RunActivitySummary | null;
}

export interface GoalGetContext {
  evidenceDir: string | null;
  repoRoot?: string | null;
  /** Optional precomputed description file path; when omitted, written automatically if description exceeds descriptionExcerpt. */
  descriptionPath?: string | null;
}

export function parseGoalGetOptions(args: Record<string, unknown>): GoalGetOptions {
  let sections: GoalGetSection[];
  if (args.sections === undefined || args.sections === null) {
    sections = [...DEFAULT_GOAL_GET_SECTIONS];
  } else {
    if (!Array.isArray(args.sections)) {
      throw new Error(`Invalid sections: expected an array of allowed sections (${GOAL_GET_SECTIONS.join(", ")})`);
    }
    const seen = new Set<GoalGetSection>();
    sections = [];
    for (const raw of args.sections) {
      if (typeof raw !== "string" || !ALLOWED_SECTIONS_SET.has(raw)) {
        throw new Error(
          `Unknown goal_get section ${JSON.stringify(raw)}; allowed values: ${GOAL_GET_SECTIONS.join(", ")}`,
        );
      }
      const sec = raw as GoalGetSection;
      if (!seen.has(sec)) {
        seen.add(sec);
        sections.push(sec);
      }
    }
  }

  let reviewsLimit: number = GOAL_GET_LIMITS.reviewsDefault;
  if (typeof args.reviews_limit === "number" && Number.isFinite(args.reviews_limit)) {
    reviewsLimit = Math.min(GOAL_GET_LIMITS.reviewsMax, Math.max(1, Math.floor(args.reviews_limit)));
  }

  let reviewsBeforeCycle: number | null = null;
  if (typeof args.reviews_before_cycle === "number" && Number.isFinite(args.reviews_before_cycle)) {
    reviewsBeforeCycle = Math.floor(args.reviews_before_cycle);
  }

  let descriptionOffset = 0;
  if (
    typeof args.description_offset === "number" &&
    Number.isFinite(args.description_offset) &&
    args.description_offset >= 0
  ) {
    descriptionOffset = Math.floor(args.description_offset);
  }

  return {
    sections,
    reviewsLimit,
    reviewsBeforeCycle,
    descriptionOffset,
  };
}

function clip(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  if (maxChars <= 1) return "…".slice(0, Math.max(0, maxChars));
  return s.slice(0, maxChars - 1) + "…";
}

function canonicalPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Writes `<evidenceDir>/goal-description-v<version>.md` when the goal's description exceeds `descriptionExcerpt`
 * and `evidenceDir` is non-null. Skips writing if an existing regular file already has the same byte length.
 * Returns the repo-relative path (or absolute path if `evidenceDir` is outside `repoRoot`), or `null`.
 */
export function writeGoalDescriptionFile(
  goal: Pick<GoalRecord, "version" | "description" | "repoRoot">,
  evidenceDir: string | null,
  repoRoot?: string | null,
): string | null {
  if (!evidenceDir || goal.description.length <= GOAL_GET_LIMITS.descriptionExcerpt) {
    return null;
  }
  try {
    mkdirSync(evidenceDir, { recursive: true });
    const filePath = join(evidenceDir, `goal-description-v${goal.version}.md`);
    const expectedBytes = Buffer.byteLength(goal.description, "utf8");
    let skipWrite = false;
    try {
      const st = lstatSync(filePath);
      if (st.isSymbolicLink() || !st.isFile()) return null;
      if (st.size === expectedBytes) skipWrite = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    if (!skipWrite) {
      writeFileSync(filePath, goal.description, "utf8");
    }
    const root = canonicalPath(repoRoot ?? goal.repoRoot);
    const target = canonicalPath(filePath);
    const rel = relative(root, target);
    if (rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
      return rel.split(sep).join("/");
    }
    return filePath;
  } catch {
    return null;
  }
}

const TERMINAL_TASK_STATUSES = new Set<TaskRecord["status"]>([
  "completed",
  "failed",
  "cancelled",
  "returned_for_rescope",
]);

function compactLiveProgress(lp: GoalLiveProgress | null | undefined): Record<string, unknown> | null {
  if (!lp) return null;
  return {
    ...(lp.phase !== undefined ? { phase: lp.phase } : {}),
    ...(lp.summary !== undefined ? { summary: clip(lp.summary, 500) } : {}),
    ...(lp.verificationStatus !== undefined ? { verificationStatus: lp.verificationStatus } : {}),
    ...(lp.criteriaResults
      ? {
          criteriaResults: lp.criteriaResults.map((cr) => ({
            criterionId: cr.criterionId,
            passed: cr.passed,
          })),
        }
      : {}),
    updatedAt: lp.updatedAt,
  };
}

interface ShrinkState {
  tasksMax: number;
  dropActivityTasks: boolean;
  dropOlderReviewText: boolean;
  criterionDescription: number;
  includeCriterionCommand: boolean;
  criterionEvidence: number | null;
  latestReviewSummary: number;
  latestReviewEvidence: number | null;
  latestReviewRemediation: number | null;
  latestReviewGate: boolean;
  latestReviewBlockingMax: number;
  descriptionExcerpt: number;
  nonGoalsMax: number;
  goalLastReviewSummary: number;
  dropLiveProgressSummary: boolean;
}

function initialShrinkState(): ShrinkState {
  return {
    tasksMax: GOAL_GET_LIMITS.tasksMax,
    dropActivityTasks: false,
    dropOlderReviewText: false,
    criterionDescription: GOAL_GET_LIMITS.criterionDescription,
    includeCriterionCommand: true,
    criterionEvidence: GOAL_GET_LIMITS.evidence,
    latestReviewSummary: GOAL_GET_LIMITS.reviewSummary,
    latestReviewEvidence: GOAL_GET_LIMITS.evidence,
    latestReviewRemediation: GOAL_GET_LIMITS.remediation,
    latestReviewGate: true,
    latestReviewBlockingMax: GOAL_GET_LIMITS.blockingIssuesMax,
    descriptionExcerpt: GOAL_GET_LIMITS.descriptionExcerpt,
    nonGoalsMax: GOAL_GET_LIMITS.nonGoalsMax,
    goalLastReviewSummary: GOAL_GET_LIMITS.reviewSummary,
    dropLiveProgressSummary: false,
  };
}

export function buildGoalGetResult(
  detail: GoalGetDetailInput,
  opts: GoalGetOptions,
  ctx: GoalGetContext,
): Record<string, unknown> {
  const { goal } = detail;
  const sectionSet = new Set<GoalGetSection>(opts.sections);
  const hasGoal = sectionSet.has("goal");
  const hasDescription = sectionSet.has("description");
  const hasCriteria = sectionSet.has("criteria");
  const hasReviews = sectionSet.has("reviews");
  const hasRun = sectionSet.has("run");
  const hasEscalations = sectionSet.has("escalations");

  const descriptionPath =
    ctx.descriptionPath !== undefined
      ? ctx.descriptionPath
      : writeGoalDescriptionFile(goal, ctx.evidenceDir, ctx.repoRoot ?? goal.repoRoot);

  // Reviews ordered newest-first regardless of DB query order.
  const sortedReviews = [...detail.reviews].sort((a, b) => b.cycle - a.cycle || b.createdAt - a.createdAt);

  // Criterion status lookup: newest review matching current goal.version that evaluated that criterion.
  const latestEvalByCriterion = new Map<string, { cycle: number; passed: boolean; evidence: string }>();
  for (const rev of sortedReviews) {
    if (rev.goalVersion !== goal.version) continue;
    for (const cr of rev.criteriaResults) {
      if (!latestEvalByCriterion.has(cr.criterionId)) {
        latestEvalByCriterion.set(cr.criterionId, {
          cycle: rev.cycle,
          passed: cr.passed,
          evidence: cr.evidence,
        });
      }
    }
  }

  // Reviews paging.
  const filteredReviews =
    opts.reviewsBeforeCycle !== null
      ? sortedReviews.filter((r) => r.cycle < opts.reviewsBeforeCycle!)
      : sortedReviews;
  const pagedReviews = filteredReviews.slice(0, opts.reviewsLimit);
  const hasMoreReviews = filteredReviews.length > pagedReviews.length;
  const nextBeforeCycle =
    hasMoreReviews && pagedReviews.length > 0 ? pagedReviews[pagedReviews.length - 1]!.cycle : null;

  // Tasks ordered active first, then newest.
  const sortedTasks = [...detail.tasks].sort((a, b) => {
    const aActive = !TERMINAL_TASK_STATUSES.has(a.status);
    const bActive = !TERMINAL_TASK_STATUSES.has(b.status);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
  });

  const acceptOverrides = sortedReviews
    .filter((r) => r.source === "director_accept_override")
    .map((r) => ({
      id: r.id,
      cycle: r.cycle,
      acceptedBy: r.audit?.acceptedBy ?? "director",
      reason: clip(r.audit?.reason ?? r.summary, 300),
      createdAt: r.createdAt,
    }));

  const render = (state: ShrinkState, truncated: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};

    if (hasGoal) {
      const descriptionMore =
        goal.description.length > state.descriptionExcerpt
          ? descriptionPath
            ? "read_file path, or goal_get sections:['description']"
            : "goal_get sections:['description']"
          : undefined;
      const lp = compactLiveProgress(goal.liveProgress);
      if (lp && state.dropLiveProgressSummary) delete lp.summary;
      out.goal = {
        id: goal.id,
        version: goal.version,
        title: goal.title,
        status: goal.status,
        verificationMode: goal.verificationMode ?? "auto",
        verifyRef: goal.verifyRef ?? null,
        linkedRunId: goal.linkedRunId,
        reviewCycle: goal.reviewCycle,
        noProgressStreak: goal.noProgressStreak,
        budgets: goal.budgets,
        lastReviewSummary:
          goal.lastReviewSummary != null ? clip(goal.lastReviewSummary, state.goalLastReviewSummary) : null,
        nonGoals: goal.nonGoals.slice(0, state.nonGoalsMax).map((ng) => clip(ng, GOAL_GET_LIMITS.nonGoal)),
        liveProgress: lp,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        description: {
          chars: goal.description.length,
          excerpt: clip(goal.description, state.descriptionExcerpt),
          path: descriptionPath,
          ...(descriptionMore ? { more: descriptionMore } : {}),
        },
      };
    } else {
      out.goal = {
        id: goal.id,
        version: goal.version,
        title: goal.title,
        status: goal.status,
      };
    }

    if (hasDescription) {
      const offset = opts.descriptionOffset;
      const text = goal.description.slice(offset, offset + GOAL_GET_LIMITS.descriptionPage);
      const nextOffset = offset + text.length < goal.description.length ? offset + text.length : null;
      out.descriptionPage = {
        offset,
        text,
        chars: goal.description.length,
        nextOffset,
      };
    }

    if (hasCriteria) {
      out.criteria = goal.criteria.map((c) => {
        const evaluated = latestEvalByCriterion.get(c.id);
        const status: "passed" | "failed" | "not_evaluated" = evaluated
          ? evaluated.passed
            ? "passed"
            : "failed"
          : "not_evaluated";
        const evidence =
          evaluated && state.criterionEvidence !== null && evaluated.evidence
            ? clip(evaluated.evidence, state.criterionEvidence)
            : undefined;
        return {
          id: c.id,
          kind: c.kind,
          required: c.required,
          status,
          evaluatedInCycle: evaluated ? evaluated.cycle : null,
          description: clip(c.description, state.criterionDescription),
          ...(c.command !== undefined && state.includeCriterionCommand
            ? { command: clip(c.command, GOAL_GET_LIMITS.criterionCommand) }
            : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        };
      });
    }

    if (hasReviews) {
      out.reviews = pagedReviews.map((r, idx) => {
        const stale = isReviewInvalidated(goal, r);
        const source = r.source ?? "review";
        if (idx === 0) {
          return {
            id: r.id,
            goalVersion: r.goalVersion,
            cycle: r.cycle,
            verdict: r.verdict,
            source,
            createdAt: r.createdAt,
            stale,
            summary: clip(r.summary, state.latestReviewSummary),
            blockingIssues: r.blockingIssues
              .slice(0, state.latestReviewBlockingMax)
              .map((b) => clip(b, GOAL_GET_LIMITS.blockingIssue)),
            criteriaResults: r.criteriaResults.map((cr) => ({
              criterionId: cr.criterionId,
              passed: cr.passed,
              ...(state.latestReviewEvidence !== null
                ? { evidence: clip(cr.evidence, state.latestReviewEvidence) }
                : {}),
              ...(cr.remediation !== undefined && state.latestReviewRemediation !== null
                ? { remediation: clip(cr.remediation, state.latestReviewRemediation) }
                : {}),
              ...(cr.gate && state.latestReviewGate
                ? { gate: { ref: cr.gate.ref, sha: cr.gate.sha, source: cr.gate.source } }
                : {}),
            })),
          };
        }
        const passedCount = r.criteriaResults.filter((cr) => cr.passed).length;
        const failedCriteria = r.criteriaResults.filter((cr) => !cr.passed).map((cr) => cr.criterionId);
        return {
          id: r.id,
          goalVersion: r.goalVersion,
          cycle: r.cycle,
          verdict: r.verdict,
          source,
          createdAt: r.createdAt,
          stale,
          ...(!state.dropOlderReviewText
            ? {
                summary: clip(r.summary, GOAL_GET_LIMITS.reviewSummary),
                blockingIssues: r.blockingIssues
                  .slice(0, GOAL_GET_LIMITS.blockingIssuesMax)
                  .map((b) => clip(b, GOAL_GET_LIMITS.blockingIssue)),
              }
            : {}),
          passedCount,
          failedCount: failedCriteria.length,
          failedCriteria,
        };
      });
      out.reviewsPage = {
        total: detail.reviews.length,
        returned: pagedReviews.length,
        nextBeforeCycle,
      };
      out.acceptOverrides = acceptOverrides;
    }

    if (hasRun) {
      const selectedTasks = sortedTasks.slice(0, state.tasksMax);
      const selectedTaskIds = new Set(selectedTasks.map((t) => t.id));
      out.tasks = selectedTasks.map((t) => {
        const handoff = compactTaskHandoff(t, detail.openEscalations);
        return {
          id: t.id,
          parentId: t.parentId,
          tier: t.tier,
          kind: t.kind,
          title: clip(t.title, GOAL_GET_LIMITS.taskTitle),
          status: t.status,
          generation: t.generation,
          goalVersion: t.goalVersion ?? null,
          staleGoalVersion: t.goalVersion != null && t.goalVersion < goal.version,
          summary: handoff.summary != null ? clip(handoff.summary, GOAL_GET_LIMITS.taskSummary) : null,
          ...(handoff.partial ? { partial: true } : {}),
        };
      });
      out.tasksPage = {
        total: detail.tasks.length,
        returned: selectedTasks.length,
        omitted: Math.max(0, detail.tasks.length - selectedTasks.length),
        more: "run_status({ goal_id })",
      };
      if (detail.activity === null) {
        out.activity = null;
      } else if (state.dropActivityTasks) {
        const { tasks: _dropped, ...activityWithoutTasks } = detail.activity;
        out.activity = activityWithoutTasks;
      } else {
        const compactActivityTasks = detail.activity.tasks
          .filter((t: TaskActivitySnapshot) => selectedTaskIds.has(t.id))
          .map((t: TaskActivitySnapshot) => ({
            ...t,
            title: clip(t.title, GOAL_GET_LIMITS.taskTitle),
            currentAction: t.currentAction != null ? clip(t.currentAction, 120) : null,
          }));
        out.activity = {
          ...detail.activity,
          tasks: compactActivityTasks,
        };
      }
    }

    if (hasEscalations) {
      out.openEscalations = detail.openEscalations.map((e) => ({
        id: e.id,
        severity: e.severity,
        category: e.category,
        title: clip(e.title, GOAL_GET_LIMITS.escalationTitle),
        blocking: e.blocking,
        status: e.status,
        fromTaskId: e.fromTaskId,
        toTaskId: e.toTaskId,
        createdAt: e.createdAt,
      }));
    }

    out.evidenceDir = ctx.evidenceDir;
    out.truncated = [...truncated];
    return out;
  };

  const state = initialShrinkState();
  const truncated: string[] = [];

  const shrinkSteps: Array<{ label: string; apply: () => boolean }> = [
    {
      label: "tasks",
      apply: () => {
        if (!hasRun || sortedTasks.length <= 10) return false;
        state.tasksMax = 10;
        return true;
      },
    },
    {
      label: "activity.tasks",
      apply: () => {
        if (!hasRun || !detail.activity || detail.activity.tasks.length === 0) return false;
        state.dropActivityTasks = true;
        return true;
      },
    },
    {
      label: "reviews.older",
      apply: () => {
        if (!hasReviews || pagedReviews.length <= 1) return false;
        state.dropOlderReviewText = true;
        return true;
      },
    },
    {
      label: "criteria.description",
      apply: () => {
        if (!hasCriteria || goal.criteria.length === 0) return false;
        state.criterionDescription = 100;
        state.includeCriterionCommand = false;
        return true;
      },
    },
    {
      label: "reviews.latest.evidence",
      apply: () => {
        if (!hasReviews && !hasCriteria) return false;
        if (hasReviews && pagedReviews.length === 0 && !hasCriteria) return false;
        state.latestReviewEvidence = 80;
        state.latestReviewRemediation = 80;
        state.latestReviewBlockingMax = 3;
        state.criterionEvidence = 80;
        return true;
      },
    },
    {
      label: "goal.description",
      apply: () => {
        if (!hasGoal) return false;
        state.descriptionExcerpt = 300;
        state.nonGoalsMax = 5;
        return true;
      },
    },
    {
      label: "tasks.empty",
      apply: () => {
        if (!hasRun || sortedTasks.length === 0) return false;
        state.tasksMax = 0;
        return true;
      },
    },
    // Safety floor beyond step 7 for extreme inputs while preserving all never-dropped invariants:
    // goal header, every criteria[].id+status, newest review cycle/verdict/summary(>=300)/criteriaResults[].criterionId+passed, openEscalations ids.
    {
      label: "details.floor",
      apply: () => {
        state.criterionEvidence = null;
        state.latestReviewEvidence = null;
        state.latestReviewRemediation = null;
        state.latestReviewGate = false;
        state.latestReviewBlockingMax = 0;
        state.latestReviewSummary = 300;
        state.goalLastReviewSummary = 300;
        state.dropLiveProgressSummary = true;
        return true;
      },
    },
  ];

  let result = render(state, truncated);
  for (const step of shrinkSteps) {
    if (JSON.stringify(result).length <= GOAL_GET_LIMITS.budgetChars) break;
    if (!step.apply()) continue;
    truncated.push(step.label);
    result = render(state, truncated);
  }

  return result;
}
