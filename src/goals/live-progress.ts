import type { CriterionEvaluation, GoalRecord } from "./engine.js";

/** Who made a live-progress claim. Only coordinator, director and verify_task failures gate settlement. */
export type GoalProgressSource = "coordinator" | "worker" | "verify_task" | "director" | "system";

export interface GoalLiveProgress {
  phase?: string;
  summary?: string;
  verificationStatus?: "not_needed" | "in_progress" | "passed" | "failed";
  criteriaResults?: CriterionEvaluation[];
  reportedByTaskId?: string | null;
  updatedAt: number;
  /** Provenance of the last CLAIM (verificationStatus, criteriaResults, or phase "blocked"). Absent on legacy rows. */
  goalVersion?: number;
  runId?: string | null;
  reviewCycle?: number;
  source?: GoalProgressSource;
  claimedAt?: number;
}

export type GoalLiveProgressPatch = Omit<
  GoalLiveProgress,
  "updatedAt" | "goalVersion" | "runId" | "reviewCycle" | "source" | "claimedAt"
>;

export interface GoalProgressContext {
  goalVersion: number;
  runId: string | null;
  reviewCycle: number;
  source: GoalProgressSource;
  now: number;
}

export function isBlockedPhase(phase?: string | null): boolean {
  return phase?.trim().toLowerCase() === "blocked";
}

function hasProvenance(lp: GoalLiveProgress): boolean {
  return lp.goalVersion !== undefined || lp.runId !== undefined || lp.reviewCycle !== undefined;
}

/**
 * Merges a progress patch into the stored live progress. Claims (verification status, criterion results, or a
 * blocked phase) are stamped with the goal epoch they were made in; a claim from a different epoch drops the
 * previous claim first. Summary or ordinary phase updates never refresh a claim's provenance.
 */
export function mergeGoalLiveProgress(
  prev: GoalLiveProgress | null | undefined,
  patch: GoalLiveProgressPatch,
  ctx: GoalProgressContext,
): GoalLiveProgress {
  const isClaim =
    patch.verificationStatus !== undefined || patch.criteriaResults !== undefined || isBlockedPhase(patch.phase);
  let base: GoalLiveProgress | null | undefined = prev;
  if (
    isClaim &&
    prev &&
    hasProvenance(prev) &&
    (prev.goalVersion !== ctx.goalVersion || prev.runId !== ctx.runId || prev.reviewCycle !== ctx.reviewCycle)
  ) {
    const { verificationStatus: _v, criteriaResults: _c, ...rest } = prev;
    base = rest;
    if (isBlockedPhase(prev.phase) && patch.phase === undefined) {
      delete base.phase;
    }
  }

  const mergedById = new Map<string, CriterionEvaluation>();
  for (const c of base?.criteriaResults ?? []) mergedById.set(c.criterionId, c);
  for (const c of patch.criteriaResults ?? []) mergedById.set(c.criterionId, c);

  const next: GoalLiveProgress = {
    phase: patch.phase ?? base?.phase,
    summary: patch.summary ?? base?.summary,
    verificationStatus: patch.verificationStatus ?? base?.verificationStatus,
    criteriaResults: mergedById.size > 0 ? [...mergedById.values()] : undefined,
    reportedByTaskId: patch.reportedByTaskId ?? base?.reportedByTaskId ?? null,
    updatedAt: ctx.now,
  };
  if (isClaim) {
    next.goalVersion = ctx.goalVersion;
    next.runId = ctx.runId;
    next.reviewCycle = ctx.reviewCycle;
    next.source = ctx.source;
    next.claimedAt = ctx.now;
  } else if (base) {
    if (base.goalVersion !== undefined) next.goalVersion = base.goalVersion;
    if (base.runId !== undefined) next.runId = base.runId;
    if (base.reviewCycle !== undefined) next.reviewCycle = base.reviewCycle;
    if (base.source !== undefined) next.source = base.source;
    if (base.claimedAt !== undefined) next.claimedAt = base.claimedAt;
  }
  return next;
}

/** True when the live progress claim was made for the goal's current version, linked run and review cycle. */
export function isCurrentClaim(
  goal: Pick<GoalRecord, "version" | "linkedRunId" | "reviewCycle">,
  lp: GoalLiveProgress | null | undefined,
): boolean {
  return (
    lp != null && lp.goalVersion === goal.version && lp.runId === goal.linkedRunId && lp.reviewCycle === goal.reviewCycle
  );
}

/** Removes claim fields and provenance (and optionally a blocked phase); `next` is null when nothing meaningful remains. */
export function stripStaleLiveProgress(
  lp: GoalLiveProgress | null | undefined,
  opts?: { clearBlockedPhase?: boolean },
): { next: GoalLiveProgress | null; changed: boolean } {
  if (!lp) return { next: null, changed: false };
  const {
    verificationStatus,
    criteriaResults,
    goalVersion,
    runId,
    reviewCycle,
    source,
    claimedAt,
    ...rest
  } = lp;
  let changed = [verificationStatus, criteriaResults, goalVersion, runId, reviewCycle, source, claimedAt].some(
    (v) => v !== undefined,
  );
  const next: GoalLiveProgress = { ...rest };
  if (opts?.clearBlockedPhase && isBlockedPhase(lp.phase)) {
    delete next.phase;
    delete next.summary;
    changed = true;
  }
  if (next.phase === undefined && next.summary === undefined) return { next: null, changed };
  return { next, changed };
}
