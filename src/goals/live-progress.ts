import type { CriterionEvaluation, GoalRecord } from "./engine.js";

/** Who made a live-progress claim. Only coordinator, director and verify_task failures gate settlement. */
export type GoalProgressSource = "coordinator" | "worker" | "verify_task" | "director" | "system";

export interface GoalLiveProgress {
  phase?: string;
  summary?: string;
  verificationStatus?: "not_needed" | "in_progress" | "passed" | "failed";
  criteriaResults?: CriterionEvaluation[];
  /** Task that reported the current verification claim (frozen by later updates that do not set a status). */
  reportedByTaskId?: string | null;
  updatedAt: number;
  /** Provenance of the last CLAIM (verificationStatus, criteriaResults, or phase "blocked"). Absent on legacy rows. */
  goalVersion?: number;
  /** Goal version the reporting task was bound to when it made the claim. */
  reporterGoalVersion?: number | null;
  runId?: string | null;
  reviewCycle?: number;
  /** Author of the claim; follows `verificationSource` while a verification status is stored. */
  source?: GoalProgressSource;
  /** Author of `verificationStatus`; criterion-only or summary updates never relabel it. */
  verificationSource?: GoalProgressSource;
  claimedAt?: number;
}

export type GoalLiveProgressPatch = Omit<
  GoalLiveProgress,
  "updatedAt" | "goalVersion" | "reporterGoalVersion" | "runId" | "reviewCycle" | "source" | "verificationSource" | "claimedAt"
>;

export interface GoalProgressContext {
  goalVersion: number;
  /** Goal version the reporting task was bound to (null for Director/unlinked reporters). */
  reporterGoalVersion?: number | null;
  runId: string | null;
  reviewCycle: number;
  source: GoalProgressSource;
  now: number;
}

export interface DroppedProgressEntry {
  field: "criteriaResults" | "verificationStatus" | "phase";
  value: string;
  reason: string;
}

/**
 * Filters out stale or unknown progress entries rather than failing the call ("inform, don't block"):
 *  - Drops `criteriaResults` entries whose `criterionId` is absent from the current goal version.
 *  - When the reporter is bound to an older goal version (`boundVersion < currentVersion`), drops
 *    `verificationStatus: "passed"` and `phase: "completed"` while keeping summary and non-terminal progress.
 */
export function filterProgressPatch(
  patch: GoalLiveProgressPatch,
  opts: {
    goalId?: string;
    criterionIds: ReadonlySet<string>;
    boundVersion: number | null;
    currentVersion: number;
  },
): {
  patch: GoalLiveProgressPatch;
  dropped: DroppedProgressEntry[];
  note?: string;
} {
  const dropped: DroppedProgressEntry[] = [];
  const next: GoalLiveProgressPatch = { ...patch };
  const goalRef = opts.goalId ? `${opts.goalId} v${opts.currentVersion}` : `goal v${opts.currentVersion}`;

  if (patch.criteriaResults !== undefined) {
    const kept: CriterionEvaluation[] = [];
    for (const r of patch.criteriaResults) {
      if (!opts.criterionIds.has(r.criterionId)) {
        dropped.push({
          field: "criteriaResults",
          value: r.criterionId,
          reason: `criterion ${r.criterionId} is not in goal v${opts.currentVersion}`,
        });
      } else {
        kept.push(r);
      }
    }
    next.criteriaResults = kept.length > 0 ? kept : undefined;
  }

  const isStaleVersion = opts.boundVersion !== null && opts.boundVersion < opts.currentVersion;
  if (isStaleVersion) {
    if (next.verificationStatus === "passed") {
      dropped.push({
        field: "verificationStatus",
        value: "passed",
        reason: `task bound to v${opts.boundVersion}; goal is v${opts.currentVersion}`,
      });
      next.verificationStatus = undefined;
    }
    if (next.phase?.trim().toLowerCase() === "completed") {
      dropped.push({
        field: "phase",
        value: next.phase,
        reason: `task bound to v${opts.boundVersion}; goal is v${opts.currentVersion}`,
      });
      next.phase = undefined;
    }
  }

  if (dropped.length === 0) {
    return { patch: next, dropped };
  }

  const parts: string[] = [];
  const droppedCriteria = dropped.filter((d) => d.field === "criteriaResults").map((d) => d.value);
  if (droppedCriteria.length > 0) {
    parts.push(`criteria ${droppedCriteria.join(",")} are not in ${goalRef}`);
  }
  const droppedVer = dropped.find((d) => d.field === "verificationStatus");
  if (droppedVer) {
    parts.push(`verification_status ${droppedVer.value} ignored because this task was started on v${opts.boundVersion}`);
  }
  const droppedPhase = dropped.find((d) => d.field === "phase");
  if (droppedPhase) {
    parts.push(`phase ${droppedPhase.value} ignored because this task was started on v${opts.boundVersion}`);
  }
  const note =
    `Dropped ${dropped.length} ${dropped.length === 1 ? "entry" : "entries"}: ${parts.join("; ")}. ` +
    `Re-check against v${opts.currentVersion} (blackboard goal_contract_v${opts.currentVersion}) before claiming.`;

  return { patch: next, dropped, note };
}

export function isBlockedPhase(phase?: string | null): boolean {
  return phase?.trim().toLowerCase() === "blocked";
}

/** Sources whose verification claims gate settlement; worker claims are display-only. */
export function isAuthoritativeSource(s?: GoalProgressSource): boolean {
  return s === "coordinator" || s === "director" || s === "verify_task";
}

function hasProvenance(lp: GoalLiveProgress): boolean {
  return lp.goalVersion !== undefined || lp.runId !== undefined || lp.reviewCycle !== undefined;
}

/**
 * Merges a progress patch into the stored live progress. Claims (verification status, criterion results, or a
 * blocked phase) are stamped with the goal epoch they were made in; a claim from a different epoch drops the
 * previous claim first. Summary or ordinary phase updates never refresh a claim's provenance, and only a patch
 * that sets `verificationStatus` changes who authored it. Within the same epoch, a worker cannot overwrite an
 * authoritative verification status or clear an authoritative blocked phase; it may still add summary, ordinary
 * phase and criterion results.
 */
export function mergeGoalLiveProgress(
  prev: GoalLiveProgress | null | undefined,
  patch: GoalLiveProgressPatch,
  ctx: GoalProgressContext,
): GoalLiveProgress {
  const isClaim =
    patch.verificationStatus !== undefined || patch.criteriaResults !== undefined || isBlockedPhase(patch.phase);
  const sameEpoch =
    !!prev &&
    prev.goalVersion === ctx.goalVersion &&
    prev.runId === ctx.runId &&
    prev.reviewCycle === ctx.reviewCycle;
  let base: GoalLiveProgress | null | undefined = prev;
  if (isClaim && prev && hasProvenance(prev) && !sameEpoch) {
    const { verificationStatus: _v, verificationSource: _vs, criteriaResults: _c, ...rest } = prev;
    base = rest;
    if (isBlockedPhase(prev.phase) && patch.phase === undefined) {
      delete base.phase;
    }
  }

  const baseVerificationSource =
    base?.verificationStatus !== undefined ? (base.verificationSource ?? base.source) : undefined;
  // A legacy claim (no provenance) stays legacy, validated by its reporter and time, until a non-worker
  // verification status or blocked phase replaces it; a worker can neither replace nor migrate it.
  const legacyClaim =
    !!prev && !hasProvenance(prev) && (prev.verificationStatus !== undefined || isBlockedPhase(prev.phase));
  const migratesLegacy =
    ctx.source !== "worker" && (patch.verificationStatus !== undefined || isBlockedPhase(patch.phase));
  const legacyLocked = legacyClaim && ctx.source === "worker";
  const authoritativeBlocked =
    (sameEpoch && isBlockedPhase(base?.phase) && isAuthoritativeSource(base?.source)) ||
    (legacyLocked && isBlockedPhase(base?.phase));
  const workerLocked =
    legacyLocked ||
    (ctx.source === "worker" &&
      sameEpoch &&
      ((base?.verificationStatus !== undefined && isAuthoritativeSource(baseVerificationSource)) || authoritativeBlocked));
  const setsVerification = patch.verificationStatus !== undefined && !workerLocked;

  const mergedById = new Map<string, CriterionEvaluation>();
  for (const c of base?.criteriaResults ?? []) mergedById.set(c.criterionId, c);
  for (const c of patch.criteriaResults ?? []) mergedById.set(c.criterionId, c);

  const keepClaimAuthor = !setsVerification && (workerLocked || base?.verificationStatus !== undefined);
  const next: GoalLiveProgress = {
    phase: authoritativeBlocked && ctx.source === "worker" ? base?.phase : (patch.phase ?? base?.phase),
    summary: patch.summary ?? base?.summary,
    verificationStatus: setsVerification ? patch.verificationStatus : base?.verificationStatus,
    criteriaResults: mergedById.size > 0 ? [...mergedById.values()] : undefined,
    reportedByTaskId: keepClaimAuthor
      ? (base?.reportedByTaskId ?? null)
      : (patch.reportedByTaskId ?? base?.reportedByTaskId ?? null),
    updatedAt: ctx.now,
  };
  if (isClaim && !workerLocked && (!legacyClaim || migratesLegacy)) {
    next.goalVersion = ctx.goalVersion;
    if (ctx.reporterGoalVersion != null) {
      next.reporterGoalVersion = ctx.reporterGoalVersion;
    } else if (base?.reporterGoalVersion != null && !setsVerification && base?.verificationStatus !== undefined) {
      next.reporterGoalVersion = base.reporterGoalVersion;
    }
    next.runId = ctx.runId;
    next.reviewCycle = ctx.reviewCycle;
    if (setsVerification) {
      next.source = ctx.source;
      next.verificationSource = ctx.source;
      next.claimedAt = ctx.now;
    } else if (base?.verificationStatus !== undefined) {
      // Criterion-only (or blocked-phase) claim on an existing status: the status keeps its author and time.
      if (baseVerificationSource !== undefined) {
        next.source = baseVerificationSource;
        next.verificationSource = baseVerificationSource;
      }
      next.claimedAt = base.claimedAt ?? base.updatedAt;
    } else {
      next.source = ctx.source;
      next.claimedAt = ctx.now;
    }
  } else if (base) {
    if (base.goalVersion !== undefined) next.goalVersion = base.goalVersion;
    if (base.reporterGoalVersion !== undefined) next.reporterGoalVersion = base.reporterGoalVersion;
    if (base.runId !== undefined) next.runId = base.runId;
    if (base.reviewCycle !== undefined) next.reviewCycle = base.reviewCycle;
    if (base.source !== undefined) next.source = base.source;
    if (base.verificationSource !== undefined) next.verificationSource = base.verificationSource;
    // Legacy rows have no claim time: remember when the stored status was reported before refreshing updatedAt.
    const claimedAt = base.claimedAt ?? (base.verificationStatus !== undefined ? base.updatedAt : undefined);
    if (claimedAt !== undefined) next.claimedAt = claimedAt;
  }
  return next;
}

/** True when the live progress claim was made for the goal's current version, linked run and review cycle. */
export function isCurrentClaim(
  goal: Pick<GoalRecord, "version" | "linkedRunId" | "reviewCycle">,
  lp: GoalLiveProgress | null | undefined,
): boolean {
  if (lp == null) return false;
  if (lp.reporterGoalVersion != null && lp.reporterGoalVersion < goal.version) return false;
  return lp.goalVersion === goal.version && lp.runId === goal.linkedRunId && lp.reviewCycle === goal.reviewCycle;
}

/** Removes claim fields and provenance (and optionally a blocked or non-queued phase/summary); `next` is null when nothing meaningful remains. */
export function stripStaleLiveProgress(
  lp: GoalLiveProgress | null | undefined,
  opts?: { clearBlockedPhase?: boolean; clearNonQueuedPhaseSummary?: boolean },
): { next: GoalLiveProgress | null; changed: boolean } {
  if (!lp) return { next: null, changed: false };
  const {
    verificationStatus,
    criteriaResults,
    goalVersion,
    reporterGoalVersion,
    runId,
    reviewCycle,
    source,
    verificationSource,
    claimedAt,
    ...rest
  } = lp;
  let changed = [
    verificationStatus,
    criteriaResults,
    goalVersion,
    reporterGoalVersion,
    runId,
    reviewCycle,
    source,
    verificationSource,
    claimedAt,
  ].some(
    (v) => v !== undefined,
  );
  const next: GoalLiveProgress = { ...rest };
  if (opts?.clearNonQueuedPhaseSummary) {
    const keepQueued = lp.phase === "queued" || lp.phase === "queue_launch_error";
    if (!keepQueued && (next.phase !== undefined || next.summary !== undefined)) {
      delete next.phase;
      delete next.summary;
      changed = true;
    }
  } else if (opts?.clearBlockedPhase && isBlockedPhase(lp.phase)) {
    delete next.phase;
    delete next.summary;
    changed = true;
  }
  if (next.phase === undefined && next.summary === undefined) return { next: null, changed };
  return { next, changed };
}
