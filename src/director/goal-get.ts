import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { EscalationRecord, RecentlyResolvedEscalation, TaskRecord } from "../control-plane/db.js";
import { compactTaskHandoff } from "../control-plane/handoffs.js";
import type { RunActivitySummary, TaskActivitySnapshot } from "../control-plane/telemetry.js";
import type { GoalLiveProgress, GoalRecord, GoalReviewVerdict, GoalStatus, ReviewerDiagnostics } from "../goals/engine.js";
import { isReviewInvalidated } from "../protocol/chat-events.js";
import { serializeToolResult } from "../runners/mcp-bridge.js";
import type { ToolDefinition } from "../runners/types.js";

export const GOAL_GET_LIMITS = {
  budgetChars: 40_000, // hard target for serializeToolResult(result); client limit is 50,000
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
  escalationResolution: 240,
  escalationsMax: 20,
  recentEscalationsMax: 10,
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
    "every criterion with its id, kind, required flag and latest status (collapsing to {id, status} at the budget floor and paging via criteria_offset / criteriaPage.nextOffset only when criterion rows alone exceed budget), " +
    "a compact summary of the latest review, the run's tasks (summaries and artifact paths) and activity, open/acked escalations (openEscalations), and recent escalation history (recentlyResolvedEscalations, newest 10 with status, clipped resolution, resolvedAt, and recentlyResolvedEscalationsPage.omitted for older ones). " +
    "Narrow it with sections (goal, description, criteria, reviews, run, escalations); requesting a narrow section set (such as sections: ['criteria'], ['reviews'], or ['escalations']) returns unclipped fields while within budget. " +
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
      criteria_offset: {
        type: "number",
        description:
          "0-based index into criteria to start from when paging very large criterion lists (pass criteriaPage.nextOffset). Default 0.",
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
  criteriaOffset: number;
}

/** Structural input matching `DirectorRuntime.goalDisplayData(goal)`. */
export interface GoalGetDetailInput {
  goal: GoalRecord;
  reviews: GoalReviewVerdict[];
  tasks: TaskRecord[];
  openEscalations: EscalationRecord[];
  /** Recently resolved escalations on the goal's run (newest first), e.g. from `db.listRecentlyResolvedEscalations`. */
  recentlyResolvedEscalations?: RecentlyResolvedEscalation[];
  /** Total resolved escalations on the goal's run when larger than `recentlyResolvedEscalations.length`. */
  resolvedEscalationsTotal?: number;
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

  let criteriaOffset = 0;
  if (
    typeof args.criteria_offset === "number" &&
    Number.isFinite(args.criteria_offset) &&
    args.criteria_offset >= 0
  ) {
    criteriaOffset = Math.floor(args.criteria_offset);
  }

  return {
    sections,
    explicitSections,
    reviewsLimit,
    reviewsBefore,
    descriptionOffset,
    criteriaOffset,
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

function compactLiveProgress(lp: GoalLiveProgress | null | undefined, phaseMax = 200): Record<string, unknown> | null {
  if (!lp) return null;
  return {
    ...(lp.phase !== undefined ? { phase: clip(lp.phase, phaseMax) } : {}),
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
  criteriaMinimal: boolean;
  latestReviewSummary: number;
  latestReviewEvidence: number | null;
  latestReviewRemediation: number | null;
  latestReviewGate: boolean;
  gateFieldMax: number;
  gateNoteMax: number;
  latestReviewBlockingMax: number;
  latestReviewBlockingIssue: number;
  descriptionExcerpt: number;
  descriptionPageJsonBudget: number;
  nonGoalsMax: number;
  goalLastReviewSummary: number;
  goalTitleMax: number;
  verifyRefMax: number;
  liveProgressPhaseMax: number;
  dropLiveProgress: boolean;
  dropLiveProgressSummary: boolean;
  escalationsMax: number;
  recentEscalationsMax: number;
  escalationTitle: number;
  escalationResolution: number;
  diagnosticsMode: DiagnosticsMode;
  dropAcceptOverrides: boolean;
}

function initialShrinkState(opts: GoalGetOptions, sectionSet: Set<GoalGetSection>): ShrinkState {
  const isNarrow = opts.explicitSections && opts.sections.length <= 2;
  const unclipCriteria = isNarrow && sectionSet.has("criteria");
  const unclipLatestReview = isNarrow && sectionSet.has("reviews");
  const unclipTasks = isNarrow && sectionSet.has("run");
  const unclipEscalations = isNarrow && sectionSet.has("escalations");
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
    criteriaMinimal: false,
    latestReviewSummary: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.reviewSummary,
    latestReviewEvidence: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.evidence,
    latestReviewRemediation: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.remediation,
    latestReviewGate: true,
    gateFieldMax: Number.POSITIVE_INFINITY,
    gateNoteMax: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.evidence,
    latestReviewBlockingMax: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.blockingIssuesMax,
    latestReviewBlockingIssue: unclipLatestReview ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.blockingIssue,
    descriptionExcerpt: GOAL_GET_LIMITS.descriptionExcerpt,
    descriptionPageJsonBudget: GOAL_GET_LIMITS.descriptionPage,
    nonGoalsMax: GOAL_GET_LIMITS.nonGoalsMax,
    goalLastReviewSummary: GOAL_GET_LIMITS.reviewSummary,
    goalTitleMax: Number.POSITIVE_INFINITY,
    verifyRefMax: Number.POSITIVE_INFINITY,
    liveProgressPhaseMax: 200,
    dropLiveProgress: false,
    dropLiveProgressSummary: false,
    escalationsMax: GOAL_GET_LIMITS.escalationsMax,
    recentEscalationsMax: GOAL_GET_LIMITS.recentEscalationsMax,
    escalationTitle: unclipEscalations ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.escalationTitle,
    escalationResolution: unclipEscalations ? Number.POSITIVE_INFINITY : GOAL_GET_LIMITS.escalationResolution,
    diagnosticsMode: "full",
    dropAcceptOverrides: false,
  };
}

function sortReviewsNewestFirst(reviews: readonly GoalReviewVerdict[]): GoalReviewVerdict[] {
  return [...reviews].sort(
    (a, b) =>
      b.goalVersion - a.goalVersion ||
      b.cycle - a.cycle ||
      b.createdAt - a.createdAt ||
      (b.id < a.id ? -1 : b.id > a.id ? 1 : 0),
  );
}

export const GOAL_LIST_LIMITS = {
  budgetChars: 20_000, // hard target for serializeToolResult(result)
  titleMax: 160,
  limitDefault: 30,
  limitMax: 100,
} as const;

export const GOAL_LIST_STATUSES: readonly GoalStatus[] = [
  "draft",
  "executing",
  "verifying",
  "reviewing",
  "awaiting_human",
  "achieved",
  "paused",
  "cancelled",
] as const;

const ALLOWED_GOAL_STATUSES_SET = new Set<string>(GOAL_LIST_STATUSES);

export const GOAL_LIST_TOOL: ToolDefinition = {
  name: "goal_list",
  description:
    "List Goals in this workspace (or across all projects when all_projects is true). " +
    "Default output is compact (<= 20,000 chars) with per-goal summaries only (id, version, title, status, reviewCycle, linkedRunId, openEscalations, latestReview, updatedAt) and no description text; use goal_get for full detail. " +
    "Filter by status, control page size with limit (default 30, max 100), and page through more goals via cursor using the returned page.nextCursor. " +
    "Pass the returned presentation_id to present_result to show the Goals table.",
  inputSchema: {
    type: "object",
    properties: {
      all_projects: { type: "boolean", description: "When true, list goals across all registered projects." },
      status: {
        type: "string",
        enum: [...GOAL_LIST_STATUSES],
        description:
          "Optional goal status filter (draft, executing, verifying, reviewing, awaiting_human, achieved, paused, cancelled).",
      },
      limit: {
        type: "number",
        description: "Maximum number of goals to return per page. Default 30, max 100.",
      },
      cursor: {
        type: "string",
        description: "Cursor from a previous call's page.nextCursor to fetch the next page.",
      },
    },
  },
};

export interface GoalListOptions {
  allProjects: boolean;
  status: GoalStatus | null;
  limit: number;
  cursor: string | null;
}

export interface GoalListLatestReview {
  verdict: GoalReviewVerdict["verdict"];
  cycle: number;
  goalVersion: number;
  createdAt: number;
}

export interface GoalListSummaryInput {
  goal: Pick<GoalRecord, "id" | "version" | "title" | "status" | "reviewCycle" | "linkedRunId" | "updatedAt">;
  openEscalations: number;
  latestReview?: GoalListLatestReview | null;
  reviews?: readonly GoalReviewVerdict[];
}

export interface GoalListContext {
  /** Optional wire overhead (e.g. `presentation_id`) reserved inside `budgetChars`. */
  reserveChars?: number;
}

export interface GoalListItem {
  id: string;
  version: number;
  title: string;
  status: GoalStatus;
  reviewCycle: number;
  linkedRunId: string | null;
  openEscalations: number;
  latestReview: GoalListLatestReview | null;
  updatedAt: number;
}

export interface GoalListResult {
  goals: GoalListItem[];
  page: {
    total: number;
    returned: number;
    nextCursor: string | null;
  };
}

export function parseGoalListOptions(args: Record<string, unknown>): GoalListOptions {
  const allProjects = Boolean(args.all_projects);

  let status: GoalStatus | null = null;
  if (args.status !== undefined && args.status !== null && args.status !== "") {
    if (typeof args.status !== "string" || !ALLOWED_GOAL_STATUSES_SET.has(args.status.trim())) {
      throw new Error(
        `Unknown goal_list status ${JSON.stringify(args.status)}; allowed values: ${GOAL_LIST_STATUSES.join(", ")}`,
      );
    }
    status = args.status.trim() as GoalStatus;
  }

  let limit: number = GOAL_LIST_LIMITS.limitDefault;
  if (typeof args.limit === "number" && Number.isFinite(args.limit)) {
    limit = Math.min(GOAL_LIST_LIMITS.limitMax, Math.max(1, Math.floor(args.limit)));
  }

  let cursor: string | null = null;
  if (typeof args.cursor === "string" && args.cursor.trim()) {
    cursor = args.cursor.trim();
  }

  return { allProjects, status, limit, cursor };
}

export function buildGoalListResult(
  summaries: readonly GoalListSummaryInput[],
  opts: GoalListOptions,
  ctx?: GoalListContext,
): GoalListResult {
  const reserveChars =
    typeof ctx?.reserveChars === "number" && Number.isFinite(ctx.reserveChars) && ctx.reserveChars > 0
      ? Math.floor(ctx.reserveChars)
      : 0;
  const effectiveBudget = Math.max(500, GOAL_LIST_LIMITS.budgetChars - reserveChars);

  const filtered = opts.status ? summaries.filter((s) => s.goal.status === opts.status) : summaries;
  const sorted = [...filtered].sort(
    (a, b) =>
      b.goal.updatedAt - a.goal.updatedAt ||
      (b.goal.id < a.goal.id ? -1 : b.goal.id > a.goal.id ? 1 : 0),
  );

  let remaining: GoalListSummaryInput[];
  if (opts.cursor !== null) {
    const cursorIdx = sorted.findIndex((s) => s.goal.id === opts.cursor);
    remaining = cursorIdx >= 0 ? sorted.slice(cursorIdx + 1) : [];
  } else {
    remaining = sorted;
  }

  const pageSlice = remaining.slice(0, opts.limit);
  const projected = pageSlice.map((s) => {
    let latestReview: GoalListLatestReview | null = null;
    if (s.latestReview !== undefined) {
      latestReview = s.latestReview
        ? {
            verdict: s.latestReview.verdict,
            cycle: s.latestReview.cycle,
            goalVersion: s.latestReview.goalVersion,
            createdAt: s.latestReview.createdAt,
          }
        : null;
    } else if (s.reviews && s.reviews.length > 0) {
      const newest = sortReviewsNewestFirst(s.reviews)[0]!;
      latestReview = {
        verdict: newest.verdict,
        cycle: newest.cycle,
        goalVersion: newest.goalVersion,
        createdAt: newest.createdAt,
      };
    }
    return { s, latestReview };
  });

  const render = (count: number, titleMax: number): GoalListResult => {
    const goals: GoalListItem[] = projected.slice(0, count).map(({ s, latestReview }) => ({
      id: s.goal.id,
      version: s.goal.version,
      title: clip(s.goal.title, titleMax),
      status: s.goal.status,
      reviewCycle: s.goal.reviewCycle,
      linkedRunId: s.goal.linkedRunId,
      openEscalations: s.openEscalations,
      latestReview,
      updatedAt: s.goal.updatedAt,
    }));
    const hasMore = remaining.length > goals.length;
    const nextCursor = hasMore && goals.length > 0 ? goals[goals.length - 1]!.id : null;
    return {
      goals,
      page: {
        total: sorted.length,
        returned: goals.length,
        nextCursor,
      },
    };
  };

  let titleMax: number = GOAL_LIST_LIMITS.titleMax;
  let result = render(projected.length, titleMax);

  // Size guard step 1: shrink/clip titles before reducing the returned page count.
  for (const smallerTitleMax of [80, 40]) {
    if (serializeToolResult(result).length <= effectiveBudget) break;
    titleMax = smallerTitleMax;
    result = render(projected.length, titleMax);
  }

  // Size guard step 2: reduce returned count to fit budget and advance nextCursor accordingly.
  if (serializeToolResult(result).length > effectiveBudget) {
    let lo = 0;
    let hi = projected.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const candidate = render(mid, titleMax);
      if (serializeToolResult(candidate).length <= effectiveBudget) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    result = render(lo, titleMax);
  }

  return result;
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
  const sortedReviews = sortReviewsNewestFirst(detail.reviews);

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

  // Unresolved escalations ordered newest-first by latest activity (max of ackedAt and createdAt), then id.
  const sortedEscalations = [...detail.openEscalations].sort((a, b) => {
    const aActivity = a.ackedAt != null ? Math.max(a.ackedAt, a.createdAt) : a.createdAt;
    const bActivity = b.ackedAt != null ? Math.max(b.ackedAt, b.createdAt) : b.createdAt;
    if (bActivity !== aActivity) return bActivity - aActivity;
    const aAckedAtActivity = a.ackedAt != null && a.ackedAt >= a.createdAt ? 1 : 0;
    const bAckedAtActivity = b.ackedAt != null && b.ackedAt >= b.createdAt ? 1 : 0;
    if (bAckedAtActivity !== aAckedAtActivity) return bAckedAtActivity - aAckedAtActivity;
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });
  // Resolved escalation history ordered newest-first by resolvedAt (preserving input order on ties).
  const sortedResolvedEscalations = [...(detail.recentlyResolvedEscalations ?? [])].sort(
    (a, b) => (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0),
  );
  const totalResolvedEscalations = Math.max(sortedResolvedEscalations.length, detail.resolvedEscalationsTotal ?? 0);

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
      const lp = state.dropLiveProgress ? null : compactLiveProgress(goal.liveProgress, state.liveProgressPhaseMax);
      if (lp && state.dropLiveProgressSummary) delete lp.summary;
      out.goal = {
        id: goal.id,
        version: goal.version,
        title: renderedTitle,
        status: goal.status,
        verificationMode: goal.verificationMode ?? "auto",
        verifyRef: goal.verifyRef != null ? clip(goal.verifyRef, state.verifyRefMax) : null,
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
      const criteriaOffset = opts.criteriaOffset ?? 0;
      const slicedCriteria = goal.criteria.slice(criteriaOffset);
      const renderedCriteria = slicedCriteria.map((c) => {
        const evaluated = latestEvalByCriterion.get(c.id);
        const status: "passed" | "failed" | "not_evaluated" = evaluated
          ? evaluated.passed
            ? "passed"
            : "failed"
          : "not_evaluated";
        if (state.criteriaMinimal) {
          return {
            id: c.id,
            status,
          };
        }
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
      out.criteria = renderedCriteria;
      out.criteriaPage = {
        offset: criteriaOffset,
        total: goal.criteria.length,
        returned: renderedCriteria.length,
        omitted: Math.max(0, goal.criteria.length - renderedCriteria.length),
        nextOffset:
          renderedCriteria.length > 0 && criteriaOffset + renderedCriteria.length < goal.criteria.length
            ? criteriaOffset + renderedCriteria.length
            : null,
      };
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
                ? {
                    gate: {
                      cwd: clip(cr.gate.cwd, state.gateFieldMax),
                      ref: clip(cr.gate.ref, state.verifyRefMax),
                      sha: cr.gate.sha,
                      isolated: cr.gate.isolated,
                      source: cr.gate.source,
                      ...(cr.gate.note !== undefined ? { note: clip(cr.gate.note, state.gateNoteMax) } : {}),
                    },
                  }
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
          ...(handoff.external_deliverable ? { externalDeliverable: handoff.external_deliverable } : {}),
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
        ...(e.resolution != null ? { resolution: clip(e.resolution, state.escalationResolution) } : {}),
        ...(e.ackedAt != null ? { ackedAt: e.ackedAt } : {}),
      }));
      out.escalationsPage = {
        total: detail.openEscalations.length,
        returned: selectedEscalations.length,
        omitted: Math.max(0, detail.openEscalations.length - selectedEscalations.length),
      };
      const selectedResolved = sortedResolvedEscalations.slice(0, state.recentEscalationsMax);
      out.recentlyResolvedEscalations = selectedResolved.map((e) => ({
        id: e.id,
        fromTaskId: e.fromTaskId,
        severity: e.severity,
        category: e.category,
        title: clip(e.title, state.escalationTitle),
        status: "resolved" as const,
        resolution: clip(e.resolution, state.escalationResolution),
        resolvedAt: e.resolvedAt,
      }));
      out.recentlyResolvedEscalationsPage = {
        total: totalResolvedEscalations,
        returned: selectedResolved.length,
        omitted: Math.max(0, totalResolvedEscalations - selectedResolved.length),
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
        state.gateNoteMax = GOAL_GET_LIMITS.evidence;
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
      label: "escalations.compact",
      apply: () => {
        if (
          !hasEscalations ||
          (Number.isFinite(state.escalationTitle) && Number.isFinite(state.escalationResolution))
        ) {
          return false;
        }
        state.escalationTitle = GOAL_GET_LIMITS.escalationTitle;
        state.escalationResolution = GOAL_GET_LIMITS.escalationResolution;
        return true;
      },
    },
    {
      label: "goal.header",
      apply: () => {
        const longTitle = goal.title.length > 240;
        const longVerifyRef = hasGoal && (goal.verifyRef?.length ?? 0) > 240;
        const longPhase = hasGoal && (goal.liveProgress?.phase?.length ?? 0) > 120;
        const longGate =
          hasReviews &&
          pagedReviews.length > 0 &&
          pagedReviews[0]!.criteriaResults.some(
            (cr) =>
              cr.gate != null &&
              (cr.gate.ref.length > 240 || cr.gate.cwd.length > 300 || (cr.gate.note?.length ?? 0) > 240),
          );
        if (!longTitle && !longVerifyRef && !longPhase && !longGate) return false;
        state.goalTitleMax = 240;
        state.verifyRefMax = 240;
        state.liveProgressPhaseMax = 120;
        state.gateFieldMax = 300;
        state.gateNoteMax = 240;
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
        if (!hasEscalations || (sortedEscalations.length === 0 && sortedResolvedEscalations.length === 0)) return false;
        state.escalationsMax = Math.min(state.escalationsMax, 10);
        state.recentEscalationsMax = Math.min(state.recentEscalationsMax, 5);
        state.escalationTitle = 100;
        state.escalationResolution = 120;
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
        state.liveProgressPhaseMax = 80;
        state.diagnosticsMode = "omit";
        state.dropAcceptOverrides = true;
        if (hasEscalations && (sortedEscalations.length > 0 || sortedResolvedEscalations.length > 0)) {
          state.escalationsMax = Math.min(state.escalationsMax, 5);
          state.recentEscalationsMax = Math.min(state.recentEscalationsMax, 3);
          state.escalationTitle = 80;
          state.escalationResolution = 80;
        }
        return true;
      },
    },
    {
      label: "criteria.minimal",
      apply: () => {
        if (!hasCriteria || goal.criteria.length === 0 || state.criteriaMinimal) return false;
        state.criteriaMinimal = true;
        state.dropLiveProgress = true;
        return true;
      },
    },
  ];

  let result = render(state, truncated);
  for (const step of shrinkSteps) {
    if (serializeToolResult(result).length <= effectiveBudget) break;
    if (!step.apply()) continue;
    truncated.push(step.label);
    result = render(state, truncated);
  }

  // Final hard wire-budget guarantee: never return a payload exceeding effectiveBudget (<= 40,000 chars).
  if (serializeToolResult(result).length > effectiveBudget) {
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
    state.goalTitleMax = Math.min(state.goalTitleMax, 200);
    state.verifyRefMax = Math.min(state.verifyRefMax, 200);
    state.liveProgressPhaseMax = 60;
    state.criterionDescription = 0;
    state.includeCriterionCommand = false;
    state.criterionEvidence = null;
    state.criteriaMinimal = true;
    state.pagedReviewsCap = 1;
    state.latestReviewEvidence = null;
    state.latestReviewRemediation = null;
    state.latestReviewGate = false;
    state.latestReviewBlockingMax = 0;
    state.escalationsMax = Math.min(state.escalationsMax, 5);
    state.recentEscalationsMax = Math.min(state.recentEscalationsMax, 3);
    state.escalationTitle = 60;
    state.escalationResolution = 60;
    result = render(state, truncated);

    if (hasDescription && serializeToolResult(result).length > effectiveBudget) {
      state.descriptionPageJsonBudget = 0;
      const baseLen = serializeToolResult(render(state, truncated)).length;
      const room = Math.max(0, effectiveBudget - baseLen - 16);
      state.descriptionPageJsonBudget = room;
      result = render(state, truncated);
    }

    if (serializeToolResult(result).length > effectiveBudget) {
      state.goalTitleMax = 120;
      state.verifyRefMax = 120;
      state.escalationsMax = 0;
      state.recentEscalationsMax = 0;
      state.latestReviewSummary = 120;
      result = render(state, truncated);
    }

    if (serializeToolResult(result).length > effectiveBudget) {
      state.goalTitleMax = 60;
      state.verifyRefMax = 60;
      state.latestReviewSummary = 0;
      result = render(state, truncated);
    }

    // Absolute fallback for adversarial array sizes (e.g. hundreds/thousands of criteria or results).
    if (serializeToolResult(result).length > effectiveBudget) {
      const trimArrayToBudget = (arr: unknown[], onResize?: (len: number) => void): void => {
        if (arr.length === 0 || serializeToolResult(result).length <= effectiveBudget) return;
        let lo = 0;
        let hi = arr.length;
        const copy = [...arr];
        while (lo < hi) {
          const mid = Math.ceil((lo + hi) / 2);
          arr.length = 0;
          arr.push(...copy.slice(0, mid));
          onResize?.(mid);
          if (serializeToolResult(result).length <= effectiveBudget) {
            lo = mid;
          } else {
            hi = mid - 1;
          }
        }
        arr.length = 0;
        arr.push(...copy.slice(0, lo));
        onResize?.(lo);
      };
      if (Array.isArray(result.openEscalations)) {
        const ep =
          result.escalationsPage && typeof result.escalationsPage === "object"
            ? (result.escalationsPage as { total: number; returned: number; omitted: number })
            : null;
        trimArrayToBudget(result.openEscalations, (len) => {
          if (ep) {
            ep.returned = len;
            ep.omitted = Math.max(0, ep.total - len);
          }
        });
      }
      if (Array.isArray(result.recentlyResolvedEscalations)) {
        const rp =
          result.recentlyResolvedEscalationsPage && typeof result.recentlyResolvedEscalationsPage === "object"
            ? (result.recentlyResolvedEscalationsPage as { total: number; returned: number; omitted: number })
            : null;
        trimArrayToBudget(result.recentlyResolvedEscalations, (len) => {
          if (rp) {
            rp.returned = len;
            rp.omitted = Math.max(0, rp.total - len);
          }
        });
      }
      if (Array.isArray(result.reviews) && result.reviews.length > 0) {
        const firstRev = result.reviews[0] as { criteriaResults?: unknown[] };
        if (Array.isArray(firstRev.criteriaResults)) {
          trimArrayToBudget(firstRev.criteriaResults);
        }
      }
      if (Array.isArray(result.criteria)) {
        const cp =
          result.criteriaPage && typeof result.criteriaPage === "object"
            ? (result.criteriaPage as {
                offset: number;
                total: number;
                returned: number;
                omitted: number;
                nextOffset: number | null;
              })
            : null;
        trimArrayToBudget(result.criteria, (len) => {
          if (cp) {
            cp.returned = len;
            cp.omitted = Math.max(0, cp.total - len);
            cp.nextOffset = len > 0 && cp.offset + len < cp.total ? cp.offset + len : null;
          }
        });
      }
      if (Array.isArray(result.reviews)) {
        const rp =
          result.reviewsPage && typeof result.reviewsPage === "object"
            ? (result.reviewsPage as { total: number; returned: number; nextBefore: string | null })
            : null;
        trimArrayToBudget(result.reviews, (len) => {
          if (rp) {
            rp.returned = len;
            if (len === 0) rp.nextBefore = null;
          }
        });
      }
    }

    // Final guard for adversarial long path scalars (e.g. evidenceDir / description.path).
    if (serializeToolResult(result).length > effectiveBudget) {
      if (typeof result.evidenceDir === "string" && result.evidenceDir.length > 200) {
        result.evidenceDir = clip(result.evidenceDir, 200);
      }
      const g = result.goal as { description?: { path?: string | null } } | undefined;
      if (g?.description && typeof g.description.path === "string" && g.description.path.length > 200) {
        g.description.path = clip(g.description.path, 200);
      }
    }
  }

  return result;
}
