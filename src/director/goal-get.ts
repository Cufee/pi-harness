import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EscalationRecord, TaskRecord } from "../control-plane/db.js";
import { compactTaskHandoff } from "../control-plane/handoffs.js";
import type { RunActivitySummary, TaskActivitySnapshot } from "../control-plane/telemetry.js";
import type { GoalLiveProgress, GoalRecord, GoalReviewVerdict, ReviewerDiagnostics } from "../goals/engine.js";
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
  escalationsMax: 20,
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
    "every criterion with its id, kind, required flag and latest status, a compact summary of the latest review, the run's tasks (summaries and artifact paths) and activity, and open escalations. " +
    "Narrow it with sections (goal, description, criteria, reviews, run, escalations); requesting a narrow section set (such as sections: ['criteria'] or ['reviews']) returns unclipped fields while within budget. " +
    "Page older reviews with reviews_limit (default 1, max 10; only the newest returned review includes criteriaResults) and reviews_before (pass reviewsPage.nextBefore). " +
    "Read the full description with read_file on description.path, or sections: ['description'] with description_offset (pages up to 30000 JSON chars). Read task handoff artifacts with read_file on tasks[].artifactPaths (use run_status for full run telemetry). " +
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
      reviews_before: {
        type: "string",
        description: "Return reviews older than this review id (pass reviewsPage.nextBefore).",
      },
      description_offset: {
        type: "number",
        description: "Character offset into the full description when sections includes description. Default 0.",
      },
    },
  },
};

export interface GoalGetOptions {
  sections: GoalGetSection[];
  explicitSections: boolean;
  reviewsLimit: number;
  reviewsBefore: string | null;
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
  /** Optional goal-18 last reviewer failure diagnostics override; defaults to `detail.goal.lastReviewerFailure ?? null`. */
  lastReviewerFailure?: ReviewerDiagnostics | null;
  /** Optional goal-18 per-review diagnostics overrides keyed by review id; defaults to each review's `.diagnostics`. */
  reviewDiagnostics?: ReadonlyMap<string, ReviewerDiagnostics | null>;
  /** Optional wire overhead (e.g. `presentation_id`) reserved inside `budgetChars`. */
  reserveChars?: number;
}

export function parseGoalGetOptions(args: Record<string, unknown>): GoalGetOptions {
  let sections: GoalGetSection[];
  const explicitSections = args.sections !== undefined && args.sections !== null;
  if (!explicitSections) {
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

  let reviewsBefore: string | null = null;
  if (typeof args.reviews_before === "string" && args.reviews_before.trim()) {
    reviewsBefore = args.reviews_before.trim();
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
    explicitSections,
    reviewsLimit,
    reviewsBefore,
    descriptionOffset,
  };
}

function clip(s: string, maxChars: number): string {
  if (!Number.isFinite(maxChars) || s.length <= maxChars) return s;
  if (maxChars <= 0) return "";
  if (maxChars <= 1) return "…".slice(0, Math.max(0, maxChars));
  return s.slice(0, maxChars - 1) + "…";
}

/**
 * Slices `text` starting at `startOffset` so the JSON-escaped string content (excluding surrounding quotes)
 * is at most `maxJsonContentChars` characters, without splitting a UTF-16 surrogate pair.
 */
function sliceByJsonContentLength(text: string, startOffset: number, maxJsonContentChars: number): string {
  if (startOffset >= text.length || maxJsonContentChars <= 0) return "";
  const maxRaw = Math.min(text.length - startOffset, maxJsonContentChars);
  const fullSlice = text.slice(startOffset, startOffset + maxRaw);
  if (JSON.stringify(fullSlice).length - 2 <= maxJsonContentChars) {
    if (maxRaw < text.length - startOffset && fullSlice.length > 0) {
      const lastCode = fullSlice.charCodeAt(fullSlice.length - 1);
      if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
        return fullSlice.slice(0, -1);
      }
    }
    return fullSlice;
  }
  let lo = 0;
  let hi = maxRaw;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = text.slice(startOffset, startOffset + mid);
    if (JSON.stringify(candidate).length - 2 <= maxJsonContentChars) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  let slice = text.slice(startOffset, startOffset + lo);
  if (lo > 0 && lo < text.length - startOffset) {
    const lastCode = slice.charCodeAt(slice.length - 1);
    if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
      slice = slice.slice(0, -1);
    }
  }
  return slice;
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

type DiagnosticsMode = "full" | "compact" | "omit";

function renderDiagnostics(
  diag: ReviewerDiagnostics | null | undefined,
  mode: DiagnosticsMode,
): ReviewerDiagnostics | null | undefined {
  if (diag === undefined) return undefined;
  if (diag === null || mode === "omit") return null;
  if (mode === "full") return diag;
  return {
    ...diag,
    transcript: clip(diag.transcript, 300),
    attemptFailures: diag.attemptFailures.slice(0, 3).map((f) => clip(f, 200)),
    rawOutputPaths: diag.rawOutputPaths.slice(0, 5),
  };
}

interface ShrinkState {
  tasksMax: number;
  taskSummary: number;
  includeTaskArtifacts: boolean;
  taskArtifactsMax: number;
  dropActivityTasks: boolean;
  dropActivity: boolean;
  dropOlderReviewText: boolean;
  pagedReviewsCap: number;
  criterionDescription: number;
  criterionCommand: number;
  includeCriterionCommand: boolean;
  criterionEvidence: number | null;
  latestReviewSummary: number;
  latestReviewEvidence: number | null;
  latestReviewRemediation: number | null;
  latestReviewGate: boolean;
  latestReviewBlockingMax: number;
  latestReviewBlockingIssue: number;
  descriptionExcerpt: number;
  descriptionPageJsonBudget: number;
  nonGoalsMax: number;
  goalLastReviewSummary: number;
  goalTitleMax: number;
  dropLiveProgress: boolean;
  dropLiveProgressSummary: boolean;
  escalationsMax: number;
  escalationTitle: number;
  diagnosticsMode: DiagnosticsMode;
  dropAcceptOverrides: boolean;
}

function initialShrinkState(opts: GoalGetOptions, sectionSet: Set<GoalGetSection>): ShrinkState {
  const isNarrow = opts.explicitSections && opts.sections.length <= 2;
  const unclipCriteria = isNarrow && sectionSet.has("criteria");
  const unclipLatestReview = isNarrow && sectionSet.has("reviews");
  const unclipTasks = isNarrow && sectionSet.has("run");
  return {
    tasksMax: GOAL_GET_LIMITS.tasksMax,
    taskSummary: unclipTasks ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.taskSummary,
    includeTaskArtifacts: true,
    taskArtifactsMax: unclipTasks ? Number.POSITIVE_INFINITY : 5,
    dropActivityTasks: false,
    dropActivity: false,
    dropOlderReviewText: false,
    pagedReviewsCap: opts.reviewsLimit,
    criterionDescription: unclipCriteria ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.criterionDescription,
    criterionCommand: unclipCriteria ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.criterionCommand,
    includeCriterionCommand: true,
    criterionEvidence: unclipCriteria ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.evidence,
    latestReviewSummary: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.reviewSummary,
    latestReviewEvidence: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.evidence,
    latestReviewRemediation: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.remediation,
    latestReviewGate: true,
    latestReviewBlockingMax: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.blockingIssuesMax,
    latestReviewBlockingIssue: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.blockingIssue,
    descriptionExcerpt: GOAL_GET_LIMITS.descriptionExcerpt,
    descriptionPageJsonBudget: GOAL_GET_LIMITS.descriptionPage,
    nonGoalsMax: GOAL_GET_LIMITS.nonGoalsMax,
    goalLastReviewSummary: GOAL_GET_LIMITS.reviewSummary,
    goalTitleMax: Number.POSITIVE_INFINITY,
    dropLiveProgress: false,
    dropLiveProgressSummary: false,
    escalationsMax: GOAL_GET_LIMITS.escalationsMax,
    escalationTitle: GOAL_GET_LIMITS.escalationTitle,
    diagnosticsMode: "full",
    dropAcceptOverrides: false,
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
  const reserveChars =
    typeof ctx.reserveChars === "number" && Number.isFinite(ctx.reserveChars) && ctx.reserveChars > 0
      ? Math.floor(ctx.reserveChars)
      : 0;
  const effectiveBudget = Math.max(2_000, GOAL_GET_LIMITS.budgetChars - reserveChars);

  const descriptionPath =
    ctx.descriptionPath !== undefined
      ? ctx.descriptionPath
      : writeGoalDescriptionFile(goal, ctx.evidenceDir, ctx.repoRoot ?? goal.repoRoot);

  // Version-aware total order newest-first: goalVersion desc, cycle desc, createdAt desc, id desc.
  const sortedReviews = [...detail.reviews].sort(
    (a, b) =>
      b.goalVersion - a.goalVersion ||
      b.cycle - a.cycle ||
      b.createdAt - a.createdAt ||
      (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
  );

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

  // Reviews cursor paging by unique review id along the version-aware total order.
  let filteredReviews: GoalReviewVerdict[];
  if (opts.reviewsBefore !== null) {
    const cursorIdx = sortedReviews.findIndex((r) => r.id === opts.reviewsBefore);
    filteredReviews = cursorIdx >= 0 ? sortedReviews.slice(cursorIdx + 1) : [];
  } else {
    filteredReviews = sortedReviews;
  }
  const pagedReviews = filteredReviews.slice(0, opts.reviewsLimit);
  const hasMoreReviews = filteredReviews.length > pagedReviews.length;
  const nextBefore = hasMoreReviews && pagedReviews.length > 0 ? pagedReviews[pagedReviews.length - 1]!.id : null;

  // Tasks ordered active first, then newest.
  const sortedTasks = [...detail.tasks].sort((a, b) => {
    const aActive = !TERMINAL_TASK_STATUSES.has(a.status);
    const bActive = !TERMINAL_TASK_STATUSES.has(b.status);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt;
  });

  // Escalations ordered newest-first.
  const sortedEscalations = [...detail.openEscalations].sort(
    (a, b) => b.createdAt - a.createdAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
  );

  const acceptOverrides = sortedReviews
    .filter((r) => r.source === "director_accept_override")
    .map((r) => ({
      id: r.id,
      cycle: r.cycle,
      acceptedBy: r.audit?.acceptedBy ?? "director",
      reason: clip(r.audit?.reason ?? r.summary, 300),
      createdAt: r.createdAt,
    }));

  const rawLastReviewerFailure =
    ctx.lastReviewerFailure !== undefined ? ctx.lastReviewerFailure : (goal.lastReviewerFailure ?? null);
  const getReviewDiagnostics = (r: GoalReviewVerdict): ReviewerDiagnostics | null | undefined =>
    ctx.reviewDiagnostics?.has(r.id) ? ctx.reviewDiagnostics.get(r.id) : r.diagnostics;

  const render = (state: ShrinkState, truncated: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const renderedTitle = clip(goal.title, state.goalTitleMax);

    if (hasGoal) {
      const descriptionMore =
        goal.description.length > state.descriptionExcerpt
          ? descriptionPath
            ? "read_file path, or goal_get sections:['description']"
            : "goal_get sections:['description']"
          : undefined;
      const lp = state.dropLiveProgress ? null : compactLiveProgress(goal.liveProgress);
      if (lp && state.dropLiveProgressSummary) delete lp.summary;
      out.goal = {
        id: goal.id,
        version: goal.version,
        title: renderedTitle,
        status: goal.status,
        verificationMode: goal.verificationMode ?? "auto",
        verifyRef: goal.verifyRef ?? null,
        linkedRunId: goal.linkedRunId,
        reviewCycle: goal.reviewCycle,
        noProgressStreak: goal.noProgressStreak,
        budgets: goal.budgets,
        lastReviewSummary:
          goal.lastReviewSummary != null && state.goalLastReviewSummary > 0
            ? clip(goal.lastReviewSummary, state.goalLastReviewSummary)
            : null,
        lastReviewerFailure: renderDiagnostics(rawLastReviewerFailure, state.diagnosticsMode) ?? null,
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
        title: renderedTitle,
        status: goal.status,
      };
    }

    if (hasDescription) {
      const offset = opts.descriptionOffset;
      const text = sliceByJsonContentLength(goal.description, offset, state.descriptionPageJsonBudget);
      const nextOffset = text.length > 0 && offset + text.length < goal.description.length ? offset + text.length : null;
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
            ? { command: clip(c.command, state.criterionCommand) }
            : {}),
          ...(evidence !== undefined ? { evidence } : {}),
        };
      });
    }

    if (hasReviews) {
      const visibleReviews = pagedReviews.slice(0, state.pagedReviewsCap);
      const visibleHasMore = filteredReviews.length > visibleReviews.length;
      const visibleNextBefore =
        visibleHasMore && visibleReviews.length > 0 ? visibleReviews[visibleReviews.length - 1]!.id : null;
      out.reviews = visibleReviews.map((r, idx) => {
        const stale = isReviewInvalidated(goal, r);
        const source = r.source ?? "review";
        if (idx === 0) {
          const rawDiag = getReviewDiagnostics(r);
          const diagOut =
            rawDiag !== undefined && state.diagnosticsMode !== "omit"
              ? renderDiagnostics(rawDiag, state.diagnosticsMode)
              : undefined;
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
              .map((b) => clip(b, state.latestReviewBlockingIssue)),
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
            ...(diagOut !== undefined ? { diagnostics: diagOut } : {}),
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
        returned: visibleReviews.length,
        nextBefore: visibleNextBefore ?? (visibleReviews.length === pagedReviews.length ? nextBefore : null),
      };
      out.acceptOverrides = state.dropAcceptOverrides ? [] : acceptOverrides;
    }

    if (hasRun) {
      const selectedTasks = sortedTasks.slice(0, state.tasksMax);
      const selectedTaskIds = new Set(selectedTasks.map((t) => t.id));
      out.tasks = selectedTasks.map((t) => {
        const handoff = compactTaskHandoff(t, detail.openEscalations);
        const artifactPaths =
          state.includeTaskArtifacts && Array.isArray(handoff.artifact_paths) && handoff.artifact_paths.length > 0
            ? handoff.artifact_paths.slice(0, state.taskArtifactsMax)
            : undefined;
        return {
          id: t.id,
          parentId: t.parentId,
          tier: t.tier,
          kind: t.kind,
          title: clip(t.title, GOAL_GET_LIMITS.taskTitle),
          status: t.status,
          generation: t.generation,
          goalVersion: t.goalVersion ?? null,
          staleGoalVersion: t.goalVersion != null ? t.goalVersion < goal.version : goal.version > 1,
          summary: handoff.summary != null ? clip(handoff.summary, state.taskSummary) : null,
          ...(artifactPaths ? { artifactPaths } : {}),
          ...(handoff.partial ? { partial: true } : {}),
        };
      });
      out.tasksPage = {
        total: detail.tasks.length,
        returned: selectedTasks.length,
        omitted: Math.max(0, detail.tasks.length - selectedTasks.length),
        more: "run_status({ goal_id }) for run telemetry; read_file on tasks[].artifactPaths for artifacts",
      };
      if (detail.activity === null || state.dropActivity) {
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
      const selectedEscalations = sortedEscalations.slice(0, state.escalationsMax);
      out.openEscalations = selectedEscalations.map((e) => ({
        id: e.id,
        severity: e.severity,
        category: e.category,
        title: clip(e.title, state.escalationTitle),
        blocking: e.blocking,
        status: e.status,
        fromTaskId: e.fromTaskId,
        toTaskId: e.toTaskId,
        createdAt: e.createdAt,
      }));
      out.escalationsPage = {
        total: detail.openEscalations.length,
        returned: selectedEscalations.length,
        omitted: Math.max(0, detail.openEscalations.length - selectedEscalations.length),
      };
    }

    out.evidenceDir = ctx.evidenceDir;
    out.truncated = [...truncated];
    return out;
  };

  const state = initialShrinkState(opts, sectionSet);
  const truncated: string[] = [];

  const shrinkSteps: Array<{ label: string; apply: () => boolean }> = [
    {
      label: "criteria.compact",
      apply: () => {
        if (!hasCriteria || Number.isFinite(state.criterionDescription)) return false;
        state.criterionDescription = GOAL_GET_LIMITS.criterionDescription;
        state.criterionCommand = GOAL_GET_LIMITS.criterionCommand;
        state.criterionEvidence = GOAL_GET_LIMITS.evidence;
        return true;
      },
    },
    {
      label: "reviews.latest.compact",
      apply: () => {
        if (!hasReviews || Number.isFinite(state.latestReviewSummary)) return false;
        state.latestReviewSummary = GOAL_GET_LIMITS.reviewSummary;
        state.latestReviewEvidence = GOAL_GET_LIMITS.evidence;
        state.latestReviewRemediation = GOAL_GET_LIMITS.remediation;
        state.latestReviewBlockingMax = GOAL_GET_LIMITS.blockingIssuesMax;
        state.latestReviewBlockingIssue = GOAL_GET_LIMITS.blockingIssue;
        return true;
      },
    },
    {
      label: "tasks.compact",
      apply: () => {
        if (!hasRun || Number.isFinite(state.taskSummary)) return false;
        state.taskSummary = GOAL_GET_LIMITS.taskSummary;
        state.taskArtifactsMax = 5;
        return true;
      },
    },
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
      label: "escalations",
      apply: () => {
        if (!hasEscalations || sortedEscalations.length === 0) return false;
        state.escalationsMax = Math.min(state.escalationsMax, 10);
        state.escalationTitle = 100;
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
      label: "diagnostics",
      apply: () => {
        const hasAnyDiag =
          (hasGoal && rawLastReviewerFailure !== null) ||
          (hasReviews && pagedReviews.length > 0 && getReviewDiagnostics(pagedReviews[0]!) != null);
        if (!hasAnyDiag) return false;
        state.diagnosticsMode = "compact";
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
    // goal header, every criteria[].id+status, newest review cycle/verdict/summary(>=300)/criteriaResults[].criterionId+passed, openEscalations page totals.
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
        state.diagnosticsMode = "omit";
        state.dropAcceptOverrides = true;
        if (hasEscalations && sortedEscalations.length > 0) {
          state.escalationsMax = Math.min(state.escalationsMax, 5);
          state.escalationTitle = 80;
        }
        return true;
      },
    },
  ];

  let result = render(state, truncated);
  for (const step of shrinkSteps) {
    if (JSON.stringify(result).length <= effectiveBudget) break;
    if (!step.apply()) continue;
    truncated.push(step.label);
    result = render(state, truncated);
  }

  // Final hard wire-budget guarantee: never return a payload exceeding effectiveBudget (<= 40,000 chars).
  if (JSON.stringify(result).length > effectiveBudget) {
    truncated.push("budget.cap");
    state.tasksMax = 0;
    state.includeTaskArtifacts = false;
    state.dropActivity = true;
    state.dropAcceptOverrides = true;
    state.dropLiveProgress = true;
    state.diagnosticsMode = "omit";
    state.nonGoalsMax = 0;
    state.descriptionExcerpt = 0;
    state.goalLastReviewSummary = 0;
    state.criterionDescription = 0;
    state.includeCriterionCommand = false;
    state.criterionEvidence = null;
    state.pagedReviewsCap = 1;
    state.latestReviewEvidence = null;
    state.latestReviewRemediation = null;
    state.latestReviewGate = false;
    state.latestReviewBlockingMax = 0;
    state.escalationsMax = Math.min(state.escalationsMax, 5);
    state.escalationTitle = 60;
    result = render(state, truncated);

    if (hasDescription && JSON.stringify(result).length > effectiveBudget) {
      state.descriptionPageJsonBudget = 0;
      const baseLen = JSON.stringify(render(state, truncated)).length;
      const room = Math.max(0, effectiveBudget - baseLen - 16);
      state.descriptionPageJsonBudget = room;
      result = render(state, truncated);
    }

    if (JSON.stringify(result).length > effectiveBudget) {
      state.goalTitleMax = 200;
      state.escalationsMax = 0;
      state.latestReviewSummary = 120;
      result = render(state, truncated);
    }

    if (JSON.stringify(result).length > effectiveBudget) {
      state.latestReviewSummary = 0;
      result = render(state, truncated);
    }

    // Absolute fallback for adversarial array sizes (e.g. thousands of criteria/results).
    if (JSON.stringify(result).length > effectiveBudget) {
      const trimArrayToBudget = (arr: unknown[]): void => {
        if (arr.length === 0 || JSON.stringify(result).length <= effectiveBudget) return;
        let lo = 0;
        let hi = arr.length;
        const copy = [...arr];
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          arr.length = 0;
          arr.push(...copy.slice(0, mid));
          if (JSON.stringify(result).length <= effectiveBudget) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        arr.length = 0;
        arr.push(...copy.slice(0, lo));
      };
      if (Array.isArray(result.openEscalations)) {
        trimArrayToBudget(result.openEscalations);
        if (result.escalationsPage && typeof result.escalationsPage === "object") {
          const ep = result.escalationsPage as { total: number; returned: number; omitted: number };
          ep.returned = result.openEscalations.length;
          ep.omitted = Math.max(0, ep.total - ep.returned);
        }
      }
      if (Array.isArray(result.reviews) && result.reviews.length > 0) {
        const firstRev = result.reviews[0] as { criteriaResults?: unknown[] };
        if (Array.isArray(firstRev.criteriaResults)) {
          trimArrayToBudget(firstRev.criteriaResults);
        }
      }
      if (Array.isArray(result.criteria)) {
        trimArrayToBudget(result.criteria);
      }
      if (Array.isArray(result.reviews)) {
        trimArrayToBudget(result.reviews);
      }
    }
  }

  return result;
}
