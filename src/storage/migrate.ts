import type { Database } from "bun:sqlite";
import { linkSync, readlinkSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isDirectorTaskContainer } from "../control-plane/ids.js";
import {
  type DiscoveredLegacyUnit,
  listLegacyUnknownEntries,
  type StorageUnitKind,
} from "./data-dir/units.js";
import type { StorageLayout, StoragePaths } from "./paths.js";
import {
  buildHistoricalRunGoalIndex,
  buildPassArtifactRowSnapshot,
  buildRepoArtifactRowIndex,
  countPendingRowRewritesFromIndex,
  createPassOwnershipIndex,
  deriveRunChatSessionIdReadOnly,
  findAmbiguousRowIdsFromIndex,
  findFlatArtifactOwnerRowsFromIndex,
  findGoalsByLinkedRun,
  type GoalRowInfo,
  hasAnyLegacyArtifactRowForRepo,
  type HistoricalRunGoalIndex,
  listAllKnownRepoRoots,
  listRegisteredWorktreePaths,
  type ParsedLegacyArtifactRow,
  type PassArtifactRowSnapshot,
  type PassOwnershipIndex,
  readGoalRow,
  type RepoArtifactRowIndex,
  rewriteUnitArtifactRowsFromIndex,
  type RowRewriteMemberSpec,
  TERMINAL_GOAL_STATUSES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
} from "./migrate/db.js";
import {
  BudgetExceededError,
  type CachedUnitBaseDirs,
  cachedUnitDataDirDestination,
  canonicalPath,
  cleanupEmptyLegacyDirs,
  cleanupLeftoverBridgeTempLinks,
  copyToStaging,
  createBridgeSymlink,
  createCachedUnitBaseDirs,
  createRepoBasePaths,
  deleteVerifiedLegacy,
  ensureParentDirsUnderRoot,
  ensurePrivateStageDir,
  enumerateLegacyUnitsSafe,
  findExistingDataDirUnit,
  fsyncDirChain,
  fsyncStageTree,
  generateStagingOpId,
  isProtectedOtherUnitDirEntry,
  isRealDirUnderRoot,
  isValidBridgeTarget,
  isValidRelativePath,
  isValidStagingOpId,
  LEGACY_HARNESS_DIR,
  legacyPathForUnit,
  linkFileNoOverwrite,
  listUnrecordedStagingEntries,
  mergeBothExist,
  type MigrationStateFile,
  moveFileNoOverwrite,
  overlapsAnyPath,
  type PendingMigrationMember,
  type PendingMigrationUnit,
  PreservedPathExhaustedError,
  privateStagePayloadPath,
  readMigrationCursor,
  readMigrationState,
  type RecordedBridgeEntry,
  removeRecordedStageDir,
  type RepoBasePaths,
  safeLstat,
  type ShadowedFileRecord,
  verifyCopyMatches,
  verifyUnitReadable,
  writeMigrationCursorAtomic,
  writeMigrationStateAtomic,
} from "./migrate/fs.js";

/** Default wall-clock budget for a single synchronous migration pass (5 seconds). */
export const DEFAULT_MIGRATION_BUDGET_MS = 5_000;

/** Minimum age (7 days) of a unit-level migration bridge symlink before it may be removed. */
export const BRIDGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;

/** Fault-injection hook points for crash-recovery testing. */
export type MigrationFaultStep =
  | "after_copy"
  | "after_verify"
  | "before_rename_into_place"
  | "after_rename_into_place"
  | "after_legacy_delete"
  | "after_merge"
  | "after_row_rewrite"
  | "before_bridge"
  | "after_bridge";

/** Unit metadata passed to `deps.fault(step, unit)` during fault-injection tests. */
export interface MigrationUnitFaultContext {
  unitKey: string;
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  repoRoot: string;
  legacyPath: string;
  destinationPath: string;
  memberKind: StorageUnitKind;
  memberId: string;
  memberTaskId?: string;
  memberLegacyPath: string;
  memberDestinationPath: string;
}

export interface StorageMigrationDeps {
  /** Raw `bun:sqlite` handle (`ControlPlaneDb` exposes it as `.db`). */
  sqlite: Database;
  /** Storage path resolver configured with the active layout (`legacy` or `data-dir`). */
  storage: StoragePaths;
  /** Clock provider for budget and bridge-age checks (default `Date.now`). */
  now?: () => number;
  /** Optional structured log sink. */
  log?: (line: string) => void;
  /** Test hook called after each step; throwing simulates a crash at that step. */
  fault?: (step: MigrationFaultStep, unit: MigrationUnitFaultContext) => void;
  /** Test hook forcing the cross-filesystem staged copy + verify path instead of `renameSync`. */
  forceCopy?: boolean;
  /** Optional bridge creator override (defaults to `createBridgeSymlink`; used in tests to simulate bridge creation failures). */
  createBridge?: (
    legacyPath: string,
    destinationPath: string,
    canonRepo: string,
    opts?: { replaceFile?: boolean },
  ) => void;
}

export interface StorageMigrationOptions {
  /** Wall-clock budget in milliseconds for `runStorageMigrationPass` (default 5000). */
  budgetMs?: number;
  /** Explicit repository roots to inspect instead of discovering from SQLite `runs` and `goals`. */
  repoRoots?: string[];
}

export type MigrationUnitAction =
  | "migrate"
  | "merge"
  | "finish_migration"
  | "rewrite_rows"
  | "remove_bridge"
  | "keep_bridge"
  | "defer";

export type LegacyMemberDiskState = "real" | "bridge" | "invalid_symlink" | "absent";

export interface PlannedMigrationMember {
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  legacyPath: string;
  destinationPath: string;
  legacyState: LegacyMemberDiskState;
  destExists: boolean;
  action: MigrationUnitAction;
  bridgeAgeMs?: number;
  /** True when a valid bridge exists on disk with no provenance record yet in `migration-state.json`. */
  bridgeNeedsRecord?: boolean;
  reason?: string;
}

export interface PlannedMigrationUnit {
  unitKey: string;
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  repoRoot: string;
  ownerChat: string | null;
  legacyPath: string;
  destinationPath: string;
  action: MigrationUnitAction;
  reason?: string;
  /** Present when the unit is deferred due to a destination collision with another unit's directory (F4). */
  collisionError?: { path: string; message: string };
  pendingRowRewrites: number;
  ambiguousRowsSkipped?: number;
  members: PlannedMigrationMember[];
}

export interface StalePendingJournalEntry {
  unitKey: string;
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  legacyPath?: string;
  destinationPath?: string;
  reason: string;
}

export interface RepoMigrationPlan {
  repoRoot: string;
  projectDir: string;
  units: PlannedMigrationUnit[];
  unknownEntries: string[];
  newUnknownEntries: string[];
  stalePendingUnits?: StalePendingJournalEntry[];
  errors: MigrationErrorRecord[];
  totals: MigrationPlanTotals;
}

export interface MigrationPlanTotals {
  totalUnits: number;
  migrate: number;
  merge: number;
  finishMigration: number;
  rewriteRows: number;
  removeBridge: number;
  keepBridge: number;
  deferred: number;
  unknownEntries: number;
  newUnknownEntries: number;
  pendingRowRewrites: number;
  ambiguousRowsSkipped?: number;
}

export interface StorageMigrationPlan {
  layout: StorageLayout;
  noop: boolean;
  noopReason?: string;
  generatedAt: number;
  repos: RepoMigrationPlan[];
  totals: MigrationPlanTotals;
}

export interface MigrationErrorRecord {
  repoRoot?: string;
  unitKey?: string;
  path?: string;
  message: string;
}

export interface MigratedUnitResult {
  unitKey: string;
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  repoRoot: string;
  legacyPath: string;
  destinationPath: string;
  action: MigrationUnitAction;
  outcome:
    | "migrated"
    | "merged"
    | "finished"
    | "rows_rewritten"
    | "bridge_removed"
    | "bridge_kept"
    | "both_exist"
    | "deferred"
    | "error"
    | "budget_exceeded";
  method?: "rename" | "copy" | "merge";
  reason?: string;
  rowsRewritten: number;
  ambiguousRowsSkipped?: number;
  bridgesCreated: number;
  bridgesRemoved: number;
  shadowedFiles: ShadowedFileRecord[];
  members: PlannedMigrationMember[];
}

export interface RepoMigrationReport {
  repoRoot: string;
  projectDir: string;
  results: MigratedUnitResult[];
  deferred: PlannedMigrationUnit[];
  remainingUnits: PlannedMigrationUnit[];
  unknownEntries: string[];
  newUnknownEntries: string[];
  removedEmptyDirs: string[];
  ambiguousRowsSkipped?: number;
  errors: MigrationErrorRecord[];
}

export interface StorageMigrationReportTotals {
  reposScanned: number;
  migrated: number;
  merged: number;
  finished: number;
  rowsRewritten: number;
  ambiguousRowsSkipped?: number;
  bridgesCreated: number;
  bridgesRemoved: number;
  bridgesKept: number;
  deferred: number;
  remaining: number;
  unknownEntries: number;
  newUnknownEntries: number;
  errors: number;
}

export interface StorageMigrationReport {
  layout: StorageLayout;
  skipped: boolean;
  skipReason?: string;
  startedAt: number;
  finishedAt: number;
  elapsedMs: number;
  budgetMs: number;
  budgetExceeded: boolean;
  repos: RepoMigrationReport[];
  remainingUnits: PlannedMigrationUnit[];
  unknownEntries: string[];
  newUnknownEntries: string[];
  errors: MigrationErrorRecord[];
  totals: StorageMigrationReportTotals;
}

interface MemberSeed {
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  legacyPath: string;
  recoveredDestinationPath?: string;
  /** True when an artifact symlink has no persisted kind, DB provenance, or legacy bridge record. */
  indeterminateBridgeKind?: boolean;
}

interface UnitSeed {
  unitKey: string;
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  repoRoot: string;
  members: MemberSeed[];
  linkedRunIds: string[];
  linkedGoalIds: string[];
  /** Non-empty when a DB error occurred during discovery for a member of this unit (forces fail-closed deferral). */
  discoveryDbError?: string;
}

const UNIT_KIND_ORDER: Record<StorageUnitKind, number> = {
  goal: 0,
  run: 1,
  bucket_task: 2,
  flat_artifact: 3,
  note: 4,
};

function isDirUnitKind(kind: StorageUnitKind): boolean {
  return kind === "goal" || kind === "run" || kind === "bucket_task";
}

function makeMemberKey(kind: StorageUnitKind, id: string, taskId?: string): string {
  return taskId !== undefined ? `${kind}:${id}:${taskId}` : `${kind}:${id}`;
}

function emptyPlanTotals(): MigrationPlanTotals {
  return {
    totalUnits: 0,
    migrate: 0,
    merge: 0,
    finishMigration: 0,
    rewriteRows: 0,
    removeBridge: 0,
    keepBridge: 0,
    deferred: 0,
    unknownEntries: 0,
    newUnknownEntries: 0,
    pendingRowRewrites: 0,
    ambiguousRowsSkipped: 0,
  };
}

function addActionToPlanTotals(totals: MigrationPlanTotals, unit: PlannedMigrationUnit): void {
  totals.totalUnits++;
  totals.pendingRowRewrites += unit.pendingRowRewrites;
  switch (unit.action) {
    case "migrate":
      totals.migrate++;
      break;
    case "merge":
      totals.merge++;
      break;
    case "finish_migration":
      totals.finishMigration++;
      break;
    case "rewrite_rows":
      totals.rewriteRows++;
      break;
    case "remove_bridge":
      totals.removeBridge++;
      break;
    case "keep_bridge":
      totals.keepBridge++;
      break;
    case "defer":
      totals.deferred++;
      break;
  }
}

function mergePlanTotals(target: MigrationPlanTotals, src: MigrationPlanTotals): void {
  target.totalUnits += src.totalUnits;
  target.migrate += src.migrate;
  target.merge += src.merge;
  target.finishMigration += src.finishMigration;
  target.rewriteRows += src.rewriteRows;
  target.removeBridge += src.removeBridge;
  target.keepBridge += src.keepBridge;
  target.deferred += src.deferred;
  target.unknownEntries += src.unknownEntries;
  target.newUnknownEntries += src.newUnknownEntries;
  target.pendingRowRewrites += src.pendingRowRewrites;
}

/** Extracts candidate member seeds from unrewritten legacy `artifacts` rows whose unit now lives in data-dir. */
function recoverMembersFromArtifactRows(
  storage: StoragePaths,
  canonRepo: string,
  legacyRows: readonly ParsedLegacyArtifactRow[],
  existingMemberKeys: ReadonlySet<string>,
  existingLegacyPaths: ReadonlySet<string>,
  ownershipIndex: PassOwnershipIndex,
  checkBudget?: () => void,
  repoBase?: RepoBasePaths | null,
): MemberSeed[] {
  const recovered: MemberSeed[] = [];
  const seen = new Set<string>();
  const resolvedRepoBase = repoBase ?? createRepoBasePaths(storage, canonRepo);
  const baseCacheByChat = new Map<string, CachedUnitBaseDirs | null>();
  const getBaseForChat = (ownerChat: string | null): CachedUnitBaseDirs | null => {
    const mapKey = ownerChat ?? "";
    let cached = baseCacheByChat.get(mapKey);
    if (cached === undefined) {
      cached = createCachedUnitBaseDirs(storage, canonRepo, ownerChat, resolvedRepoBase);
      baseCacheByChat.set(mapKey, cached);
    }
    return cached;
  };

  const tryAdd = (kind: StorageUnitKind, id: string, taskId: string | undefined, ownerChat: string | null) => {
    const key = makeMemberKey(kind, id, taskId);
    const legacyPath = legacyPathForUnit(canonRepo, kind, id, taskId);
    if (existingMemberKeys.has(key) || existingLegacyPaths.has(legacyPath) || seen.has(key)) return;
    const dest = findExistingDataDirUnit(
      storage,
      canonRepo,
      kind,
      id,
      taskId,
      ownerChat,
      undefined,
      getBaseForChat(ownerChat),
    );
    if (!dest) return;
    seen.add(key);
    recovered.push({
      kind,
      id,
      ...(taskId !== undefined ? { taskId } : {}),
      legacyPath,
      recoveredDestinationPath: dest,
    });
  };

  for (let i = 0; i < legacyRows.length; i++) {
    if ((i & 63) === 0) checkBudget?.();
    const row = legacyRows[i]!;
    try {
      if (row.subdir === "goals" && row.subParts[0]) {
        const goalId = row.subParts[0];
        const goalRow = ownershipIndex.getGoal(goalId);
        tryAdd("goal", goalId, undefined, goalRow?.chatSessionId ?? null);
      } else if (row.subdir === "artifacts" && row.subParts[0]) {
        const first = row.subParts[0];
        if (isDirectorTaskContainer(first) && row.subParts[1]) {
          const ownerChat = ownershipIndex.deriveRunChatSessionId(first);
          tryAdd("bucket_task", first, row.subParts[1], ownerChat);
        } else if (row.subParts.length === 1) {
          const ownerChat = row.runId ? ownershipIndex.deriveRunChatSessionId(row.runId) : null;
          // Try flat_artifact first; only fall back to run when `first` is actually a run id (never reclassify a flat spill as a run).
          const flatDest = findExistingDataDirUnit(
            storage,
            canonRepo,
            "flat_artifact",
            first,
            undefined,
            ownerChat,
            undefined,
            getBaseForChat(ownerChat),
          );
          if (flatDest) {
            tryAdd("flat_artifact", first, undefined, ownerChat);
          } else if (ownershipIndex.getRun(first) !== null || /^run-\d+$/.test(first)) {
            tryAdd("run", first, undefined, ownerChat);
          }
        } else {
          const ownerChat = ownershipIndex.deriveRunChatSessionId(first);
          tryAdd("run", first, undefined, ownerChat);
        }
      } else if (row.subdir === "notes" && row.subParts.length >= 1) {
        tryAdd("note", row.subParts.join("/"), undefined, null);
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // Fail closed: skip recovering row on unexpected DB read error so it will be retried safely.
    }
  }
  return recovered;
}

function isSafePendingSegment(seg: string): boolean {
  return seg.length > 0 && seg !== "." && seg !== ".." && !seg.includes("/") && !seg.includes("\0");
}

function isSafePendingMemberIds(kind: StorageUnitKind, id: string, taskId?: string): boolean {
  if (kind === "note") {
    return isValidRelativePath(id);
  }
  if (!isSafePendingSegment(id)) return false;
  if (kind === "bucket_task") {
    return typeof taskId === "string" && isSafePendingSegment(taskId);
  }
  return taskId === undefined;
}

function derivePendingUnitOwnerChat(
  sqlite: Database,
  artifactIndex: RepoArtifactRowIndex,
  pending: PendingMigrationUnit,
  historicalIndex: HistoricalRunGoalIndex,
): string | null {
  if (pending.kind === "note") return null;
  if (pending.kind === "goal") {
    return readGoalRow(sqlite, pending.id)?.chatSessionId ?? null;
  }
  if (pending.kind === "run" || pending.kind === "bucket_task") {
    return deriveRunChatSessionIdReadOnly(sqlite, pending.id, historicalIndex);
  }
  const ownerRows = findFlatArtifactOwnerRowsFromIndex(artifactIndex, pending.id).filter((o) => !o.ambiguous);
  const chats = new Set<string>();
  for (const owner of ownerRows) {
    if (!owner.runId) continue;
    const linkedGoals = findGoalsByLinkedRun(sqlite, owner.runId, historicalIndex);
    if (linkedGoals.length > 0) {
      for (const g of linkedGoals) {
        if (g.chatSessionId) chats.add(g.chatSessionId);
      }
    } else {
      const chat = deriveRunChatSessionIdReadOnly(sqlite, owner.runId, historicalIndex);
      if (chat) chats.add(chat);
    }
  }
  return chats.size === 1 ? [...chats][0]! : null;
}

/**
 * Normalizes every registered worktree path from DB `worktrees` once per pass (resolved + canonical),
 * checking `checkBudget` inside the canonicalization loop.
 */
function buildRegisteredWorktreeRoots(sqlite: Database, checkBudget?: () => void): string[] {
  const rawPaths = listRegisteredWorktreePaths(sqlite, checkBudget);
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = 0; i < rawPaths.length; i++) {
    if ((i & 31) === 0) checkBudget?.();
    const raw = rawPaths[i]!;
    const resolved = resolve(raw);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
    const canon = canonicalPath(resolved);
    if (!seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

/**
 * Combines pre-indexed registered worktree paths with `storage.managedWorktreeRoots(canonRepo)`,
 * normalized as both resolved and canonical paths.
 */
function collectExcludedWorktreeRoots(
  storage: StoragePaths,
  canonRepo: string,
  registeredWorktreeRoots: readonly string[],
  checkBudget?: () => void,
): string[] {
  const seen = new Set<string>(registeredWorktreeRoots);
  const out = [...registeredWorktreeRoots];
  const managed = storage.managedWorktreeRoots(canonRepo);
  for (let i = 0; i < managed.length; i++) {
    if ((i & 31) === 31) checkBudget?.();
    const raw = managed[i]!;
    const resolved = resolve(raw);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      out.push(resolved);
    }
    const canon = canonicalPath(resolved);
    if (!seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

interface PassDbIndexes {
  getHistoricalRunGoalIndex: () => HistoricalRunGoalIndex;
  getOwnershipIndex: () => PassOwnershipIndex;
  getPassArtifactSnapshot: () => PassArtifactRowSnapshot;
  getRegisteredWorktreeRoots: () => string[];
}

function createPassDbIndexes(sqlite: Database, checkBudget?: () => void): PassDbIndexes {
  let historicalIndex: HistoricalRunGoalIndex | undefined;
  let ownershipIndex: PassOwnershipIndex | undefined;
  let artifactSnapshot: PassArtifactRowSnapshot | undefined;
  let registeredWorktrees: string[] | undefined;

  const getHistoricalRunGoalIndex = (): HistoricalRunGoalIndex => {
    if (!historicalIndex) {
      historicalIndex = buildHistoricalRunGoalIndex(sqlite, checkBudget);
    }
    return historicalIndex;
  };

  return {
    getHistoricalRunGoalIndex,
    getOwnershipIndex: () => {
      if (!ownershipIndex) {
        ownershipIndex = createPassOwnershipIndex(sqlite, getHistoricalRunGoalIndex, checkBudget);
      }
      return ownershipIndex;
    },
    getPassArtifactSnapshot: () => {
      if (!artifactSnapshot) {
        artifactSnapshot = buildPassArtifactRowSnapshot(sqlite, checkBudget);
      }
      return artifactSnapshot;
    },
    getRegisteredWorktreeRoots: () => {
      if (!registeredWorktrees) {
        registeredWorktrees = buildRegisteredWorktreeRoots(sqlite, checkBudget);
      }
      return registeredWorktrees;
    },
  };
}

/** Rotates `candidates` so the pass starts at `nextRepoRoot` (or the next lexicographic entry if removed). */
function rotateReposFromCursor(candidates: readonly string[], nextRepoRoot: string | null): string[] {
  if (!nextRepoRoot || candidates.length <= 1) return [...candidates];
  let idx = candidates.indexOf(nextRepoRoot);
  if (idx === -1) {
    idx = candidates.findIndex((r) => r.localeCompare(nextRepoRoot) >= 0);
  }
  if (idx <= 0) return [...candidates];
  return [...candidates.slice(idx), ...candidates.slice(0, idx)];
}

/**
 * Validates pending journal entries by recomputing legacy and destination paths from
 * `(canonical repo, kind, ids, owner)`:
 * - Entries whose validation hits a DB error stay on disk (`deferredPending`) and take no part in this pass.
 * - Entries that fail recomputation are kept on disk marked `stale: true` (`stalePending`), never acted on,
 *   never dropped, and reported by `planStorageMigration` / `--dry-run`.
 */
function validatePendingUnits(
  sqlite: Database,
  storage: StoragePaths,
  canonRepo: string,
  state: MigrationStateFile,
  artifactIndex: RepoArtifactRowIndex,
  excludedWorktreeRoots: readonly string[],
  historicalIndex: HistoricalRunGoalIndex,
  checkBudget?: () => void,
  repoBase?: RepoBasePaths | null,
): {
  validPending: PendingMigrationUnit[];
  deferredPending: PendingMigrationUnit[];
  stalePending: PendingMigrationUnit[];
  newlyStaleErrors: MigrationErrorRecord[];
  dbErrors: MigrationErrorRecord[];
} {
  const validPending: PendingMigrationUnit[] = [];
  const deferredPending: PendingMigrationUnit[] = [];
  const stalePending: PendingMigrationUnit[] = [];
  const newlyStaleErrors: MigrationErrorRecord[] = [];
  const dbErrors: MigrationErrorRecord[] = [];

  const markStale = (pending: PendingMigrationUnit, reason: string, path?: string): void => {
    stalePending.push({
      ...pending,
      stale: true,
      staleReason: reason,
    });
    newlyStaleErrors.push({
      repoRoot: canonRepo,
      unitKey: pending.unitKey,
      ...(path ? { path } : {}),
      message: `Kept stale pending journal entry ${pending.unitKey}: ${reason}`,
    });
  };

  for (const pending of state.pendingUnits) {
    checkBudget?.();
    if (pending.stale === true) {
      stalePending.push(pending);
      continue;
    }
    if (pending.members.length === 0) {
      markStale(pending, "no members recorded");
      continue;
    }
    if (pending.repoRoot !== undefined) {
      let recordedCanon: string;
      try {
        recordedCanon = canonicalPath(pending.repoRoot);
      } catch {
        recordedCanon = pending.repoRoot;
      }
      if (recordedCanon !== canonRepo) {
        markStale(pending, `recorded repoRoot (${pending.repoRoot}) does not match ${canonRepo}`, pending.repoRoot);
        continue;
      }
    }

    if (!isSafePendingMemberIds(pending.kind, pending.id, pending.taskId)) {
      markStale(
        pending,
        `unsafe unit identifier (${pending.kind}:${pending.id}${pending.taskId ? `:${pending.taskId}` : ""})`,
      );
      continue;
    }
    const unsafeMember = pending.members.find((m) => !isSafePendingMemberIds(m.kind, m.id, m.taskId));
    if (unsafeMember) {
      markStale(
        pending,
        `invalid member identifier (${unsafeMember.kind}:${unsafeMember.id}${unsafeMember.taskId ? `:${unsafeMember.taskId}` : ""})`,
      );
      continue;
    }

    let ownerChat: string | null;
    try {
      ownerChat = derivePendingUnitOwnerChat(sqlite, artifactIndex, pending, historicalIndex);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // A6/D6: fail closed on unexpected DB errors — keep on disk intact, and take NO part in this pass.
      deferredPending.push(pending);
      dbErrors.push({
        repoRoot: canonRepo,
        unitKey: pending.unitKey,
        path: pending.members[0]?.legacyPath,
        message: `Deferred pending journal entry ${pending.unitKey} due to DB validation error: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    let mismatchReason: string | null = null;
    let cachedBaseDirs: CachedUnitBaseDirs | null | undefined;
    const getBaseDirs = (): CachedUnitBaseDirs | null => {
      if (cachedBaseDirs === undefined) {
        cachedBaseDirs = createCachedUnitBaseDirs(storage, canonRepo, ownerChat, repoBase);
      }
      return cachedBaseDirs;
    };

    for (let mIdx = 0; mIdx < pending.members.length; mIdx++) {
      if (mIdx > 0 && (mIdx & 63) === 0) checkBudget?.();
      const m = pending.members[mIdx]!;
      let expectedLegacy: string;
      let expectedOwnerDest: string;
      let expectedLegacyChatDest: string;
      try {
        expectedLegacy = legacyPathForUnit(canonRepo, m.kind, m.id, m.taskId);
        const base = getBaseDirs();
        expectedOwnerDest = cachedUnitDataDirDestination(
          storage,
          canonRepo,
          m.kind,
          m.id,
          m.taskId,
          ownerChat,
          base,
        );
        expectedLegacyChatDest = cachedUnitDataDirDestination(
          storage,
          canonRepo,
          m.kind,
          m.id,
          m.taskId,
          null,
          base,
        );
      } catch (err) {
        mismatchReason = err instanceof Error ? err.message : String(err);
        break;
      }

      if (m.legacyPath !== expectedLegacy) {
        mismatchReason = `stored legacyPath (${m.legacyPath}) differs from recomputed ${expectedLegacy}`;
        break;
      }

      if (overlapsAnyPath(expectedLegacy, excludedWorktreeRoots)) {
        mismatchReason = `legacyPath (${expectedLegacy}) overlaps a registered worktree or managed worktree root`;
        break;
      }

      const destMatchesOwner = m.destinationPath === expectedOwnerDest;
      const destMatchesExistingLegacyChat =
        m.destinationPath === expectedLegacyChatDest &&
        (ownerChat === null || Boolean(safeLstat(expectedLegacyChatDest)));
      if (!destMatchesOwner && !destMatchesExistingLegacyChat) {
        mismatchReason = `stored destinationPath (${m.destinationPath}) differs from recomputed ${expectedOwnerDest}`;
        break;
      }
    }

    if (mismatchReason) {
      markStale(pending, mismatchReason, pending.members[0]?.legacyPath);
      continue;
    }
    validPending.push(pending);
  }

  return { validPending, deferredPending, stalePending, newlyStaleErrors, dbErrors };
}

/**
 * Collects every legacy path protected from leftover temp-link cleanup (G7):
 * recorded bridges in `migration-state.json` and every member legacy path named by any pending journal entry.
 */
function collectProtectedBridgePaths(
  state: MigrationStateFile,
  recordedBridges?: ReadonlyMap<string, RecordedBridgeEntry>,
): Set<string> {
  const protectedPaths = new Set<string>();
  if (recordedBridges) {
    for (const legacyPath of recordedBridges.keys()) {
      protectedPaths.add(resolve(legacyPath));
    }
  } else if (state.bridges) {
    for (const b of state.bridges) {
      protectedPaths.add(resolve(b.legacyPath));
    }
  }
  for (const pending of state.pendingUnits) {
    for (const m of pending.members) {
      protectedPaths.add(resolve(m.legacyPath));
    }
  }
  return protectedPaths;
}

/** Discovers all logical unit seeds for a repository from disk, unrewritten artifact rows, and validated pending state. */
function discoverRepoUnitSeeds(
  storage: StoragePaths,
  canonRepo: string,
  validPendingUnits: readonly PendingMigrationUnit[],
  artifactIndex: RepoArtifactRowIndex,
  excludedWorktreeRoots: readonly string[],
  ownershipIndex: PassOwnershipIndex,
  checkBudget?: () => void,
  excludedPendingUnitKeys?: ReadonlySet<string>,
  recordedBridges?: ReadonlyMap<string, RecordedBridgeEntry>,
  repoBase?: RepoBasePaths | null,
  protectedBridgePaths?: ReadonlySet<string>,
): {
  seeds: UnitSeed[];
  worktreeOverlaps: string[];
  enumerationErrors: MigrationErrorRecord[];
  leftoverBridgeTempLinks: string[];
} {
  checkBudget?.();
  let effectiveProtected = protectedBridgePaths;
  if (!effectiveProtected) {
    const derived = new Set<string>();
    if (recordedBridges) {
      for (const legacyPath of recordedBridges.keys()) derived.add(resolve(legacyPath));
    }
    for (const pending of validPendingUnits) {
      for (const m of pending.members) derived.add(resolve(m.legacyPath));
    }
    effectiveProtected = derived;
  }
  const {
    units: discovered,
    worktreeOverlaps: enumOverlaps,
    errors: enumErrs,
    leftoverBridgeTempLinks,
  } = enumerateLegacyUnitsSafe(storage, canonRepo, checkBudget, excludedWorktreeRoots, effectiveProtected);
  const worktreeOverlapSet = new Set<string>(enumOverlaps);
  const enumerationErrors: MigrationErrorRecord[] = enumErrs.map((e) => ({
    repoRoot: canonRepo,
    path: e.path,
    message: e.message,
  }));

  const runIdsInArtifactRows = new Set<string>();
  const flatNamesInArtifactRows = new Set<string>(artifactIndex.flatOwnersByFileName.keys());
  for (let i = 0; i < artifactIndex.legacyRows.length; i++) {
    if ((i & 127) === 127) checkBudget?.();
    const row = artifactIndex.legacyRows[i]!;
    if (row.subdir === "artifacts" && row.subParts[0] && !isDirectorTaskContainer(row.subParts[0])) {
      if (row.subParts.length >= 2) {
        runIdsInArtifactRows.add(row.subParts[0]);
      } else if (row.subParts.length === 1) {
        flatNamesInArtifactRows.add(row.subParts[0]);
      }
    }
  }

  const pendingKindByLegacyPath = new Map<string, StorageUnitKind>();
  for (const pending of validPendingUnits) {
    for (const m of pending.members) {
      pendingKindByLegacyPath.set(m.legacyPath, m.kind);
    }
  }

  const classifyArtifactBridgeKind = (
    legacyPath: string,
    name: string,
  ): { kind: "run" | "flat_artifact"; indeterminate?: boolean } => {
    const pendingKind = pendingKindByLegacyPath.get(legacyPath);
    if (pendingKind === "run" || pendingKind === "flat_artifact") return { kind: pendingKind };

    const recorded = recordedBridges?.get(legacyPath);
    if (recorded?.kind === "run" || recorded?.kind === "flat_artifact") return { kind: recorded.kind };

    if (runIdsInArtifactRows.has(name)) return { kind: "run" };
    if (flatNamesInArtifactRows.has(name)) return { kind: "flat_artifact" };

    try {
      if (ownershipIndex.getRun(name) !== null) return { kind: "run" };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // On DB error, fall through; eligibility will fail closed.
    }

    // Legacy bridge records written by earlier passes without a persisted `kind`:
    // fall back to name inference; evaluateUnit / isValidBridgeTarget still verifies
    // the target's physical type matches the inferred kind, else it is a wrong-type bridge.
    if (recorded !== undefined && recorded.kind === undefined) {
      if (/^run-\d+$/.test(name)) return { kind: "run" };
      if (/\.[a-zA-Z0-9_-]{1,16}$/.test(name)) return { kind: "flat_artifact" };
      return { kind: "run" };
    }

    return { kind: "flat_artifact", indeterminate: true };
  };

  const memberMap = new Map<string, MemberSeed>();
  const addDiscovered = (u: DiscoveredLegacyUnit) => {
    if (overlapsAnyPath(u.legacyPath, excludedWorktreeRoots)) {
      worktreeOverlapSet.add(u.legacyPath);
      return;
    }
    let kind: StorageUnitKind = u.kind;
    let indeterminateBridgeKind = false;
    // Resolve artifact bridge kind from persisted records / DB provenance, never from target type or extension.
    if (u.isBridge && (kind === "run" || kind === "flat_artifact")) {
      const classified = classifyArtifactBridgeKind(u.legacyPath, u.id);
      kind = classified.kind;
      indeterminateBridgeKind = classified.indeterminate === true;
    }
    const key = makeMemberKey(kind, u.id, u.taskId);
    if (!memberMap.has(key)) {
      memberMap.set(key, {
        kind,
        id: u.id,
        ...(u.taskId !== undefined ? { taskId: u.taskId } : {}),
        legacyPath: u.legacyPath,
        ...(indeterminateBridgeKind ? { indeterminateBridgeKind: true } : {}),
      });
    }
  };
  for (let i = 0; i < discovered.length; i++) {
    if ((i & 63) === 0) checkBudget?.();
    addDiscovered(discovered[i]!);
  }

  // Crash recovery source 1: artifacts rows still pointing to a legacy path whose unit now lives in data-dir.
  const legacyRows = artifactIndex.legacyRows;
  const existingLegacyPaths = new Set<string>([...memberMap.values()].map((m) => m.legacyPath));
  for (const rec of recoverMembersFromArtifactRows(
    storage,
    canonRepo,
    legacyRows,
    new Set(memberMap.keys()),
    existingLegacyPaths,
    ownershipIndex,
    checkBudget,
    repoBase,
  )) {
    if (overlapsAnyPath(rec.legacyPath, excludedWorktreeRoots)) {
      if (safeLstat(rec.legacyPath)) worktreeOverlapSet.add(rec.legacyPath);
      continue;
    }
    const key = makeMemberKey(rec.kind, rec.id, rec.taskId);
    if (!memberMap.has(key)) memberMap.set(key, rec);
  }

  // Crash recovery source 2: validated pendingUnits from migration-state.json (covers units with 0 artifact rows,
  // or crashes after row rewrite and before bridge creation).
  for (const pending of validPendingUnits) {
    checkBudget?.();
    for (const m of pending.members) {
      if (overlapsAnyPath(m.legacyPath, excludedWorktreeRoots)) {
        if (safeLstat(m.legacyPath)) worktreeOverlapSet.add(m.legacyPath);
        continue;
      }
      const key = makeMemberKey(m.kind, m.id, m.taskId);
      const existing = memberMap.get(key);
      if (existing) {
        if (!existing.recoveredDestinationPath) {
          existing.recoveredDestinationPath = m.destinationPath;
        }
        continue;
      }
      const destStat = safeLstat(m.destinationPath);
      if (!destStat || destStat.isSymbolicLink()) continue;
      const expectDir = isDirUnitKind(m.kind);
      if (expectDir ? !destStat.isDirectory() : !destStat.isFile()) continue;
      memberMap.set(key, {
        kind: m.kind,
        id: m.id,
        ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
        legacyPath: m.legacyPath,
        recoveredDestinationPath: m.destinationPath,
      });
    }
  }

  // Group members into logical units:
  // - Goal unit = goal dir + its linked run dir(s) + flat spill files indexed for those run(s).
  // - Non-goal run, bucket task, non-goal flat artifact, and note are each their own unit.
  const goalSeeds = new Map<string, UnitSeed>();
  const runToGoalId = new Map<string, string>();
  const claimedMemberKeys = new Set<string>();

  const ensureGoalSeed = (goalId: string): UnitSeed => {
    let seed = goalSeeds.get(goalId);
    if (!seed) {
      seed = {
        unitKey: `goal:${goalId}`,
        kind: "goal",
        id: goalId,
        repoRoot: canonRepo,
        members: [],
        linkedRunIds: [],
        linkedGoalIds: [goalId],
      };
      goalSeeds.set(goalId, seed);
    }
    return seed;
  };

  const addMemberToSeed = (seed: UnitSeed, member: MemberSeed) => {
    const key = makeMemberKey(member.kind, member.id, member.taskId);
    if (claimedMemberKeys.has(key)) return;
    claimedMemberKeys.add(key);
    seed.members.push(member);
  };

  const memberDbErrors = new Map<string, string>();
  const recordMemberDbError = (member: MemberSeed, err: unknown) => {
    const key = makeMemberKey(member.kind, member.id, member.taskId);
    if (!memberDbErrors.has(key)) {
      memberDbErrors.set(key, err instanceof Error ? err.message : String(err));
    }
  };

  // Pass 1: goal members and their linked runs.
  let passIdx = 0;
  for (const member of memberMap.values()) {
    if ((passIdx++ & 63) === 0) checkBudget?.();
    if (member.kind !== "goal") continue;
    const seed = ensureGoalSeed(member.id);
    addMemberToSeed(seed, member);
    try {
      const goalRow = ownershipIndex.getGoal(member.id);
      if (goalRow?.linkedRunId && !isDirectorTaskContainer(goalRow.linkedRunId)) {
        if (!seed.linkedRunIds.includes(goalRow.linkedRunId)) {
          seed.linkedRunIds.push(goalRow.linkedRunId);
        }
        if (!runToGoalId.has(goalRow.linkedRunId)) {
          runToGoalId.set(goalRow.linkedRunId, member.id);
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      seed.discoveryDbError ??= msg;
      recordMemberDbError(member, err);
    }
  }

  // Pass 2: run members that belong to a goal via goals.linked_run_id (even if the goal dir isn't on disk).
  passIdx = 0;
  for (const member of memberMap.values()) {
    if ((passIdx++ & 63) === 0) checkBudget?.();
    if (member.kind !== "run") continue;
    let targetGoalId = runToGoalId.get(member.id);
    let linkedGoals: GoalRowInfo[];
    try {
      linkedGoals = ownershipIndex.getGoalsByLinkedRun(member.id);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      recordMemberDbError(member, err);
      continue;
    }
    if (!targetGoalId && linkedGoals.length > 0) {
      const withDiskDir = linkedGoals.find((g) => goalSeeds.has(g.id));
      targetGoalId = (withDiskDir ?? linkedGoals[0]!).id;
      runToGoalId.set(member.id, targetGoalId);
    }
    if (targetGoalId) {
      const seed = ensureGoalSeed(targetGoalId);
      addMemberToSeed(seed, member);
      if (!seed.linkedRunIds.includes(member.id)) {
        seed.linkedRunIds.push(member.id);
      }
      for (const g of linkedGoals) {
        if (!seed.linkedGoalIds.includes(g.id)) seed.linkedGoalIds.push(g.id);
      }
    }
  }

  // Pass 3: flat_artifact members attach to a goal unit ONLY when every indexed owner row
  // belongs exclusively to that single goal (never when shared with a non-goal run, bucket task, or another goal).
  passIdx = 0;
  for (const member of memberMap.values()) {
    if ((passIdx++ & 63) === 0) checkBudget?.();
    if (member.kind !== "flat_artifact") continue;
    const ownerRows = findFlatArtifactOwnerRowsFromIndex(artifactIndex, member.id).filter((o) => !o.ambiguous);
    if (ownerRows.length === 0) continue;
    const matchedGoalIds = new Set<string>();
    const matchedRunIds = new Set<string>();
    let allOwnersBelongToGoal = true;
    let dbFailed = false;
    for (let ownerIdx = 0; ownerIdx < ownerRows.length; ownerIdx++) {
      if ((ownerIdx & 63) === 63) checkBudget?.();
      const owner = ownerRows[ownerIdx]!;
      if (!owner.runId || isDirectorTaskContainer(owner.runId)) {
        allOwnersBelongToGoal = false;
        break;
      }
      let gid = runToGoalId.get(owner.runId);
      if (!gid) {
        try {
          const linkedGoals = ownershipIndex.getGoalsByLinkedRun(owner.runId);
          if (linkedGoals.length === 1) {
            gid = linkedGoals[0]!.id;
            runToGoalId.set(owner.runId, gid);
          } else if (linkedGoals.length > 1) {
            allOwnersBelongToGoal = false;
            break;
          }
        } catch (err) {
          if (err instanceof BudgetExceededError) throw err;
          recordMemberDbError(member, err);
          dbFailed = true;
          break;
        }
      }
      if (!gid) {
        allOwnersBelongToGoal = false;
        break;
      }
      matchedGoalIds.add(gid);
      matchedRunIds.add(owner.runId);
    }
    if (!dbFailed && allOwnersBelongToGoal && matchedGoalIds.size === 1) {
      const [gid] = [...matchedGoalIds];
      const seed = ensureGoalSeed(gid!);
      addMemberToSeed(seed, member);
      for (const rid of matchedRunIds) {
        if (!seed.linkedRunIds.includes(rid)) seed.linkedRunIds.push(rid);
      }
    }
  }

  // Pass 4: remaining unclaimed members become standalone units.
  const otherSeeds: UnitSeed[] = [];
  passIdx = 0;
  for (const member of memberMap.values()) {
    if ((passIdx++ & 63) === 0) checkBudget?.();
    const key = makeMemberKey(member.kind, member.id, member.taskId);
    if (claimedMemberKeys.has(key)) continue;
    claimedMemberKeys.add(key);
    const discoveryDbError = memberDbErrors.get(key);
    otherSeeds.push({
      unitKey: key,
      kind: member.kind,
      id: member.id,
      ...(member.taskId !== undefined ? { taskId: member.taskId } : {}),
      repoRoot: canonRepo,
      members: [member],
      linkedRunIds: member.kind === "run" || member.kind === "bucket_task" ? [member.id] : [],
      linkedGoalIds: [],
      ...(discoveryDbError !== undefined ? { discoveryDbError } : {}),
    });
  }

  // Sort members inside each goal unit deterministically: goal dir first, then run dirs, then flat spill files.
  for (const seed of goalSeeds.values()) {
    seed.members.sort((a, b) => {
      const ko = UNIT_KIND_ORDER[a.kind] - UNIT_KIND_ORDER[b.kind];
      if (ko !== 0) return ko;
      return a.id.localeCompare(b.id);
    });
  }

  const allSeeds = [...goalSeeds.values(), ...otherSeeds]
    .filter((s) => !excludedPendingUnitKeys || !excludedPendingUnitKeys.has(s.unitKey))
    .sort((a, b) => {
      const ko = UNIT_KIND_ORDER[a.kind] - UNIT_KIND_ORDER[b.kind];
      if (ko !== 0) return ko;
      return a.unitKey.localeCompare(b.unitKey);
    });

  return {
    seeds: allSeeds,
    worktreeOverlaps: [...worktreeOverlapSet].sort(),
    enumerationErrors,
    leftoverBridgeTempLinks,
  };
}

interface UnitOwnershipDecision {
  eligible: boolean;
  deferReason?: string;
  ownerChat: string | null;
}

/**
 * Evaluates eligibility and chat ownership across every indexed `(runId, taskId)` row for a flat spill file.
 * A flat spill file moves only when every run and task indexed for it is eligible.
 */
function decideFlatArtifactOwnership(
  artifactIndex: RepoArtifactRowIndex,
  fileName: string,
  ownershipIndex: PassOwnershipIndex,
  checkBudget?: () => void,
): UnitOwnershipDecision {
  const ownerRows = findFlatArtifactOwnerRowsFromIndex(artifactIndex, fileName);
  if (ownerRows.length === 0) {
    return { eligible: true, ownerChat: null };
  }

  const candidateChats = new Set<string | null>();
  for (let i = 0; i < ownerRows.length; i++) {
    if ((i & 63) === 63) checkBudget?.();
    const owner = ownerRows[i]!;
    if (owner.taskId) {
      const taskRow = ownershipIndex.getTask(owner.taskId);
      if (taskRow && !TERMINAL_TASK_STATUSES.has(taskRow.status)) {
        const ownerChat = owner.runId ? ownershipIndex.deriveRunChatSessionId(owner.runId) : null;
        return {
          eligible: false,
          deferReason: `flat artifact ${fileName} belongs to live task ${owner.taskId} (${taskRow.status})`,
          ownerChat,
        };
      }
    }

    if (!owner.runId) continue;

    // Check linked goals for this run.
    const linkedGoals = ownershipIndex.getGoalsByLinkedRun(owner.runId);
    for (const g of linkedGoals) {
      if (!TERMINAL_GOAL_STATUSES.has(g.status)) {
        return {
          eligible: false,
          deferReason: `flat artifact ${fileName} belongs to non-terminal goal ${g.id} (${g.status})`,
          ownerChat: g.chatSessionId ?? null,
        };
      }
      if (!owner.ambiguous) candidateChats.add(g.chatSessionId ?? null);
    }

    if (isDirectorTaskContainer(owner.runId)) {
      const bucketChat = ownershipIndex.deriveRunChatSessionId(owner.runId);
      if (owner.ambiguous) {
        const bucketRunRow = ownershipIndex.getRun(owner.runId);
        if (bucketRunRow && !TERMINAL_RUN_STATUSES.has(bucketRunRow.status)) {
          return {
            eligible: false,
            deferReason: `flat artifact ${fileName} belongs to non-terminal bucket run ${owner.runId} (${bucketRunRow.status})`,
            ownerChat: bucketChat,
          };
        }
      }
      if (owner.ambiguous || !owner.taskId) {
        const liveTasks = ownershipIndex.getLiveTasksForRun(owner.runId);
        if (liveTasks.length > 0) {
          const sample = liveTasks
            .slice(0, 3)
            .map((t) => `${t.id} (${t.status})`)
            .join(", ");
          return {
            eligible: false,
            deferReason: `flat artifact ${fileName} belongs to bucket ${owner.runId} with live task(s): ${sample}`,
            ownerChat: bucketChat,
          };
        }
      }
      if (!owner.ambiguous) candidateChats.add(bucketChat);
      continue;
    }

    const runRow = ownershipIndex.getRun(owner.runId);
    const runChat = ownershipIndex.deriveRunChatSessionId(owner.runId);
    if (runRow && (owner.ambiguous || linkedGoals.length === 0) && !TERMINAL_RUN_STATUSES.has(runRow.status)) {
      return {
        eligible: false,
        deferReason: `flat artifact ${fileName} belongs to non-terminal run ${owner.runId} (${runRow.status})`,
        ownerChat: runChat,
      };
    }

    const liveTasks = ownershipIndex.getLiveTasksForRun(owner.runId);
    if (liveTasks.length > 0) {
      const sample = liveTasks
        .slice(0, 3)
        .map((t) => `${t.id} (${t.status})`)
        .join(", ");
      return {
        eligible: false,
        deferReason: `flat artifact ${fileName} belongs to run ${owner.runId} with live task(s): ${sample}`,
        ownerChat: runChat,
      };
    }

    if (!owner.ambiguous && linkedGoals.length === 0 && runRow) {
      candidateChats.add(runChat);
    }
  }

  const nonNullChats = [...candidateChats].filter((c): c is string => Boolean(c));
  const ownerChat = nonNullChats.length === 1 ? nonNullChats[0]! : null;
  return { eligible: true, ownerChat };
}

/**
 * Evaluates a unit's eligibility and chat ownership from the pass-level DB indexes.
 * Fails closed on any unexpected DB error by deferring the unit with a reason naming the DB error.
 */
function decideUnitOwnership(
  _storage: StoragePaths,
  seed: UnitSeed,
  artifactIndex: RepoArtifactRowIndex,
  ownershipIndex: PassOwnershipIndex,
  checkBudget?: () => void,
): UnitOwnershipDecision {
  if (seed.discoveryDbError) {
    return {
      eligible: false,
      deferReason: `DB error while checking eligibility for ${seed.unitKey}: ${seed.discoveryDbError}`,
      ownerChat: null,
    };
  }

  if (seed.kind === "note") {
    return { eligible: true, ownerChat: null };
  }

  try {
    if (seed.kind === "goal") {
      const goalIds = new Set<string>([seed.id, ...seed.linkedGoalIds]);
      const runIds = new Set<string>(seed.linkedRunIds);

      const primaryGoal = ownershipIndex.getGoal(seed.id);
      if (primaryGoal?.linkedRunId && !isDirectorTaskContainer(primaryGoal.linkedRunId)) {
        runIds.add(primaryGoal.linkedRunId);
      }
      for (const rid of [...runIds]) {
        for (const g of ownershipIndex.getGoalsByLinkedRun(rid)) {
          goalIds.add(g.id);
        }
      }

      const goalRows: GoalRowInfo[] = [];
      for (const gid of goalIds) {
        const row = ownershipIndex.getGoal(gid);
        if (row) {
          goalRows.push(row);
          if (row.linkedRunId && !isDirectorTaskContainer(row.linkedRunId)) {
            runIds.add(row.linkedRunId);
          }
        }
      }

      // Unknown goal id (no row in goals): ownerless -> eligible, destination chats/legacy.
      if (goalRows.length === 0) {
        return { eligible: true, ownerChat: null };
      }

      for (const g of goalRows) {
        if (!TERMINAL_GOAL_STATUSES.has(g.status)) {
          return {
            eligible: false,
            deferReason: `goal ${g.id} is non-terminal (${g.status})`,
            ownerChat: primaryGoal?.chatSessionId ?? g.chatSessionId ?? null,
          };
        }
      }

      for (const rid of runIds) {
        checkBudget?.();
        const liveTasks = ownershipIndex.getLiveTasksForRun(rid);
        if (liveTasks.length > 0) {
          const sample = liveTasks
            .slice(0, 3)
            .map((t) => `${t.id} (${t.status})`)
            .join(", ");
          return {
            eligible: false,
            deferReason: `linked run ${rid} has live task(s): ${sample}`,
            ownerChat: primaryGoal?.chatSessionId ?? null,
          };
        }
      }

      // Verify every attached flat spill file is also eligible across ALL of its indexed owners.
      for (let i = 0; i < seed.members.length; i++) {
        if (i > 0 && (i & 63) === 0) checkBudget?.();
        const m = seed.members[i]!;
        if (m.kind !== "flat_artifact") continue;
        const flatDecision = decideFlatArtifactOwnership(artifactIndex, m.id, ownershipIndex, checkBudget);
        if (!flatDecision.eligible) {
          return {
            eligible: false,
            deferReason: flatDecision.deferReason,
            ownerChat: primaryGoal?.chatSessionId ?? flatDecision.ownerChat,
          };
        }
      }

      // Owner chat for goal units comes strictly from goals.chat_session_id (null -> chats/legacy).
      return {
        eligible: true,
        ownerChat: primaryGoal?.chatSessionId ?? null,
      };
    }

    if (seed.kind === "run") {
      const linkedGoals = ownershipIndex.getGoalsByLinkedRun(seed.id);
      for (const g of linkedGoals) {
        if (!TERMINAL_GOAL_STATUSES.has(g.status)) {
          return {
            eligible: false,
            deferReason: `linked goal ${g.id} is non-terminal (${g.status})`,
            ownerChat: g.chatSessionId ?? ownershipIndex.deriveRunChatSessionId(seed.id),
          };
        }
      }

      const linkedGoalChat = linkedGoals.find((g) => g.chatSessionId)?.chatSessionId ?? null;
      const runRow = ownershipIndex.getRun(seed.id);
      if (!runRow) {
        // Unknown run id: ownerless (or historically linked goal's chat) -> eligible.
        return { eligible: true, ownerChat: linkedGoalChat };
      }

      const ownerChat = linkedGoalChat ?? ownershipIndex.deriveRunChatSessionId(seed.id);
      if (!TERMINAL_RUN_STATUSES.has(runRow.status)) {
        return {
          eligible: false,
          deferReason: `run ${seed.id} is non-terminal (${runRow.status})`,
          ownerChat,
        };
      }

      const liveTasks = ownershipIndex.getLiveTasksForRun(seed.id);
      if (liveTasks.length > 0) {
        const sample = liveTasks
          .slice(0, 3)
          .map((t) => `${t.id} (${t.status})`)
          .join(", ");
        return {
          eligible: false,
          deferReason: `run ${seed.id} has live task(s): ${sample}`,
          ownerChat,
        };
      }

      return { eligible: true, ownerChat };
    }

    if (seed.kind === "bucket_task") {
      const taskId = seed.taskId;
      if (!taskId) {
        return { eligible: true, ownerChat: null };
      }
      const taskRow = ownershipIndex.getTask(taskId);
      if (!taskRow) {
        // Unknown task id: ownerless -> eligible, destination chats/legacy.
        return { eligible: true, ownerChat: null };
      }
      const ownerChat = ownershipIndex.deriveRunChatSessionId(seed.id);
      if (!TERMINAL_TASK_STATUSES.has(taskRow.status)) {
        return {
          eligible: false,
          deferReason: `bucket task ${taskId} is non-terminal (${taskRow.status})`,
          ownerChat,
        };
      }
      return { eligible: true, ownerChat };
    }

    // flat_artifact (not attached to a goal unit)
    return decideFlatArtifactOwnership(artifactIndex, seed.id, ownershipIndex, checkBudget);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      eligible: false,
      deferReason: `DB error while checking eligibility for ${seed.unitKey}: ${msg}`,
      ownerChat: null,
    };
  }
}

function buildBridgeMap(state: MigrationStateFile): Map<string, RecordedBridgeEntry> {
  const map = new Map<string, RecordedBridgeEntry>();
  for (const b of state.bridges ?? []) {
    map.set(b.legacyPath, b);
  }
  return map;
}

function upsertBridgeRecord(
  bridgeMap: Map<string, RecordedBridgeEntry>,
  legacyPath: string,
  target: string,
  createdAt: number,
  resetCreatedAt = false,
  kind?: StorageUnitKind,
): boolean {
  const existing = bridgeMap.get(legacyPath);
  const resolvedKind = kind ?? existing?.kind;
  if (existing && existing.target === target && !resetCreatedAt && existing.kind === resolvedKind) {
    return false;
  }
  bridgeMap.set(legacyPath, {
    legacyPath,
    target,
    createdAt: existing && existing.target === target && !resetCreatedAt ? existing.createdAt : createdAt,
    ...(resolvedKind !== undefined ? { kind: resolvedKind } : {}),
  });
  return true;
}

/** Effective creation timestamp for bridge expiry: later of recorded `createdAt` and symlink `lstat` mtime. */
function effectiveBridgeCreatedAt(recordedCreatedAt: number, linkStat: { mtimeMs: number }): number {
  return Number.isFinite(linkStat.mtimeMs) ? Math.max(recordedCreatedAt, linkStat.mtimeMs) : recordedCreatedAt;
}

function removeBridgeRecord(bridgeMap: Map<string, RecordedBridgeEntry>, legacyPath: string): boolean {
  return bridgeMap.delete(legacyPath);
}

function syncBridgeMapToState(state: MigrationStateFile, bridgeMap: Map<string, RecordedBridgeEntry>): void {
  state.bridges = [...bridgeMap.values()];
}

/** Evaluates current disk + DB state for one logical unit without mutating anything. */
function evaluateUnit(
  storage: StoragePaths,
  seed: UnitSeed,
  nowMs: number,
  artifactIndex: RepoArtifactRowIndex,
  bridgeByLegacyPath: ReadonlyMap<string, RecordedBridgeEntry>,
  ownershipIndex: PassOwnershipIndex,
  checkBudget?: () => void,
  repoBase?: RepoBasePaths | null,
): PlannedMigrationUnit {
  checkBudget?.();
  const canonRepo = seed.repoRoot;
  const ownership = decideUnitOwnership(storage, seed, artifactIndex, ownershipIndex, checkBudget);

  const plannedMembers: PlannedMigrationMember[] = [];
  let invalidSymlinkReason: string | undefined;
  let protectedCollisionError: { path: string; message: string } | undefined;
  let cachedBaseDirs: CachedUnitBaseDirs | null | undefined;
  const getBaseDirs = (): CachedUnitBaseDirs | null => {
    if (cachedBaseDirs === undefined) {
      cachedBaseDirs = createCachedUnitBaseDirs(storage, canonRepo, ownership.ownerChat, repoBase);
    }
    return cachedBaseDirs;
  };

  for (let mIdx = 0; mIdx < seed.members.length; mIdx++) {
    if (mIdx > 0 && (mIdx & 31) === 0) checkBudget?.();
    const m = seed.members[mIdx]!;
    const expectDir = isDirUnitKind(m.kind);
    const legStat = safeLstat(m.legacyPath);
    let legacyState: LegacyMemberDiskState = "absent";
    let validBridgeDest: string | null = null;
    let bridgeAgeMs: number | undefined;
    let bridgeNeedsRecord = false;
    const baseDirs = getBaseDirs();

    if (legStat) {
      if (legStat.isSymbolicLink()) {
        if (m.indeterminateBridgeKind) {
          legacyState = "invalid_symlink";
          invalidSymlinkReason ??= `legacy symlink at ${m.legacyPath} has no recorded legacy unit kind`;
        } else {
          let rawTarget: string | null = null;
          try {
            rawTarget = readlinkSync(m.legacyPath);
          } catch {
            rawTarget = null;
          }
          validBridgeDest = isValidBridgeTarget(
            storage,
            canonRepo,
            m.legacyPath,
            rawTarget,
            {
              kind: m.kind,
              id: m.id,
              ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
              ownerChat: ownership.ownerChat,
            },
            baseDirs,
          );
          if (validBridgeDest) {
            const recorded = bridgeByLegacyPath.get(m.legacyPath);
            if (recorded && recorded.target !== validBridgeDest) {
              // Symlink target differs from the recorded bridge provenance: leave alone, report, never rewrite rows.
              validBridgeDest = null;
              legacyState = "invalid_symlink";
              invalidSymlinkReason ??= `bridge symlink at ${m.legacyPath} target differs from recorded target (${recorded.target})`;
            } else if (recorded) {
              legacyState = "bridge";
              bridgeAgeMs = Math.max(0, nowMs - effectiveBridgeCreatedAt(recorded.createdAt, legStat));
            } else {
              legacyState = "bridge";
              bridgeAgeMs = 0;
              bridgeNeedsRecord = true;
            }
          } else {
            legacyState = "invalid_symlink";
            invalidSymlinkReason ??= `legacy symlink at ${m.legacyPath} is not a valid migration bridge for ${m.kind}:${m.id}`;
          }
        }
      } else if (expectDir ? legStat.isDirectory() : legStat.isFile()) {
        legacyState = "real";
      } else {
        legacyState = "invalid_symlink";
        invalidSymlinkReason ??= `unexpected entry type at ${m.legacyPath}`;
      }
    }

    // Choose destination path:
    // 1. Existing valid bridge target (keeps row rewrites aligned with actual files).
    // 2. Crash-recovered destination path if it exists on disk.
    // 3. Existing data-dir unit anywhere under projectDir (owner chat first, then chats/legacy).
    // 4. Fresh data-dir destination for the unit's current ownerChat (or projectNotesDir for notes).
    let destinationPath: string;
    if (validBridgeDest) {
      destinationPath = validBridgeDest;
    } else if (m.recoveredDestinationPath && safeLstat(m.recoveredDestinationPath)) {
      destinationPath = m.recoveredDestinationPath;
    } else {
      const existingDataDir = findExistingDataDirUnit(
        storage,
        canonRepo,
        m.kind,
        m.id,
        m.taskId,
        ownership.ownerChat,
        baseDirs?.chatOrder,
        baseDirs,
      );
      destinationPath =
        existingDataDir ??
        cachedUnitDataDirDestination(storage, canonRepo, m.kind, m.id, m.taskId, ownership.ownerChat, baseDirs);
    }

    const dstStat = safeLstat(destinationPath);
    const destExists = Boolean(
      dstStat && !dstStat.isSymbolicLink() && (expectDir ? dstStat.isDirectory() : dstStat.isFile()),
    );
    const destOppositeType = Boolean(
      dstStat && !dstStat.isSymbolicLink() && (expectDir ? dstStat.isFile() : dstStat.isDirectory()),
    );
    let memberCollisionReason: string | undefined;
    if (
      destOppositeType &&
      legacyState === "real" &&
      dstStat &&
      isProtectedOtherUnitDirEntry(baseDirs?.projectDir ?? storage.projectDir(canonRepo), destinationPath, dstStat, {
        kind: m.kind,
        id: m.id,
        ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
        destinationPath,
      })
    ) {
      memberCollisionReason = `destination collision: ${m.legacyPath} conflicts with another unit's directory at ${destinationPath}`;
      protectedCollisionError ??= { path: m.legacyPath, message: memberCollisionReason };
    }

    plannedMembers.push({
      kind: m.kind,
      id: m.id,
      ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
      legacyPath: m.legacyPath,
      destinationPath,
      legacyState,
      destExists,
      action:
        destOppositeType && legacyState === "real" && !memberCollisionReason ? "merge" : "keep_bridge",
      ...(memberCollisionReason !== undefined ? { reason: memberCollisionReason } : {}),
      ...(bridgeAgeMs !== undefined ? { bridgeAgeMs } : {}),
      ...(bridgeNeedsRecord ? { bridgeNeedsRecord: true } : {}),
    });
  }

  const rowSpecs: RowRewriteMemberSpec[] =
    invalidSymlinkReason || protectedCollisionError
      ? []
      : plannedMembers.map((m) => ({
          kind: m.kind,
          id: m.id,
          ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
          destinationPath: m.destinationPath,
        }));
  const pendingRowRewrites =
    rowSpecs.length > 0 ? countPendingRowRewritesFromIndex(artifactIndex, rowSpecs, checkBudget) : 0;
  const ambiguousRowsSkipped =
    rowSpecs.length > 0 ? findAmbiguousRowIdsFromIndex(artifactIndex, rowSpecs, checkBudget).length : 0;

  // Assign per-member actions.
  for (let mIdx = 0; mIdx < plannedMembers.length; mIdx++) {
    if (mIdx > 0 && (mIdx & 63) === 0) checkBudget?.();
    const m = plannedMembers[mIdx]!;
    if (!ownership.eligible) {
      m.action = "defer";
      m.reason = ownership.deferReason;
      continue;
    }
    if (invalidSymlinkReason || m.legacyState === "invalid_symlink") {
      m.action = "defer";
      m.reason = invalidSymlinkReason ?? `invalid legacy entry at ${m.legacyPath}`;
      continue;
    }
    if (protectedCollisionError) {
      m.action = "defer";
      m.reason ??= protectedCollisionError.message;
      continue;
    }
    if (m.legacyState === "real") {
      m.action = m.destExists || m.action === "merge" ? "merge" : "migrate";
    } else if (m.legacyState === "absent") {
      m.action = m.destExists ? "finish_migration" : "keep_bridge";
    } else if (m.legacyState === "bridge") {
      if (!m.bridgeNeedsRecord && (m.bridgeAgeMs ?? 0) >= BRIDGE_MAX_AGE_MS) {
        m.action = "remove_bridge";
      } else if (pendingRowRewrites > 0) {
        m.action = "rewrite_rows";
      } else {
        m.action = "keep_bridge";
        m.reason = m.bridgeNeedsRecord ? "valid bridge awaiting provenance record" : "bridge is younger than 7 days";
      }
    }
  }

  // Roll up unit-level action.
  let unitAction: MigrationUnitAction = "keep_bridge";
  let unitReason: string | undefined;
  if (!ownership.eligible) {
    unitAction = "defer";
    unitReason = ownership.deferReason;
  } else if (invalidSymlinkReason) {
    unitAction = "defer";
    unitReason = invalidSymlinkReason;
  } else if (protectedCollisionError) {
    unitAction = "defer";
    unitReason = protectedCollisionError.message;
  } else if (plannedMembers.some((m) => m.action === "merge")) {
    unitAction = "merge";
  } else if (plannedMembers.some((m) => m.action === "migrate")) {
    unitAction = "migrate";
  } else if (plannedMembers.some((m) => m.action === "finish_migration")) {
    unitAction = "finish_migration";
  } else if (plannedMembers.some((m) => m.action === "remove_bridge")) {
    unitAction = "remove_bridge";
  } else if (plannedMembers.some((m) => m.action === "rewrite_rows")) {
    unitAction = "rewrite_rows";
  } else {
    unitAction = "keep_bridge";
    unitReason = "bridge is younger than 7 days";
  }

  const primary = plannedMembers[0]!;
  return {
    unitKey: seed.unitKey,
    kind: seed.kind,
    id: seed.id,
    ...(seed.taskId !== undefined ? { taskId: seed.taskId } : {}),
    repoRoot: canonRepo,
    ownerChat: ownership.ownerChat,
    legacyPath: primary.legacyPath,
    destinationPath: primary.destinationPath,
    action: unitAction,
    ...(unitReason !== undefined ? { reason: unitReason } : {}),
    ...(protectedCollisionError !== undefined ? { collisionError: protectedCollisionError } : {}),
    pendingRowRewrites,
    ambiguousRowsSkipped,
    members: plannedMembers,
  };
}

function makeFaultContext(
  unit: PlannedMigrationUnit,
  member: PlannedMigrationMember,
): MigrationUnitFaultContext {
  return {
    unitKey: unit.unitKey,
    kind: unit.kind,
    id: unit.id,
    ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
    repoRoot: unit.repoRoot,
    legacyPath: unit.legacyPath,
    destinationPath: unit.destinationPath,
    memberKind: member.kind,
    memberId: member.id,
    ...(member.taskId !== undefined ? { memberTaskId: member.taskId } : {}),
    memberLegacyPath: member.legacyPath,
    memberDestinationPath: member.destinationPath,
  };
}

function toPendingUnitRecord(
  unit: PlannedMigrationUnit,
  existing?: PendingMigrationUnit,
): PendingMigrationUnit {
  const existingOpIds = new Map<string, string>();
  if (existing) {
    for (const m of existing.members) {
      if (isValidStagingOpId(m.stagingOpId)) {
        existingOpIds.set(makeMemberKey(m.kind, m.id, m.taskId), m.stagingOpId);
      }
    }
  }
  const members: PendingMigrationMember[] = unit.members.map((m) => {
    const opId = existingOpIds.get(makeMemberKey(m.kind, m.id, m.taskId));
    return {
      kind: m.kind,
      id: m.id,
      ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
      legacyPath: m.legacyPath,
      destinationPath: m.destinationPath,
      ...(opId !== undefined ? { stagingOpId: opId } : {}),
    };
  });
  return {
    unitKey: unit.unitKey,
    kind: unit.kind,
    id: unit.id,
    ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
    repoRoot: unit.repoRoot,
    ownerChat: unit.ownerChat,
    members,
  };
}

function upsertPendingUnit(projectDir: string, state: MigrationStateFile, unit: PlannedMigrationUnit): void {
  const existing = state.pendingUnits.find((u) => u.stale !== true && u.unitKey === unit.unitKey);
  const next = state.pendingUnits.filter((u) => u.stale === true || u.unitKey !== unit.unitKey);
  next.push(toPendingUnitRecord(unit, existing));
  state.pendingUnits = next;
  writeMigrationStateAtomic(projectDir, state);
}

/**
 * Returns the recorded crypto-random `stagingOpId` for `member` under `unit.unitKey`, or generates a new one
 * and persists it in `migration-state.json` BEFORE any staging directory or byte is written.
 */
function ensureMemberStagingOpId(
  projectDir: string,
  state: MigrationStateFile,
  unit: PlannedMigrationUnit,
  member: PlannedMigrationMember,
): string {
  const memberKey = makeMemberKey(member.kind, member.id, member.taskId);
  let pending = state.pendingUnits.find((u) => u.stale !== true && u.unitKey === unit.unitKey);
  if (!pending) {
    pending = toPendingUnitRecord(unit);
    state.pendingUnits.push(pending);
  }
  const pendingMember = pending.members.find((m) => makeMemberKey(m.kind, m.id, m.taskId) === memberKey);
  if (pendingMember && isValidStagingOpId(pendingMember.stagingOpId)) {
    return pendingMember.stagingOpId;
  }
  const opId = generateStagingOpId();
  if (pendingMember) {
    pendingMember.stagingOpId = opId;
  } else {
    pending.members.push({
      kind: member.kind,
      id: member.id,
      ...(member.taskId !== undefined ? { taskId: member.taskId } : {}),
      legacyPath: member.legacyPath,
      destinationPath: member.destinationPath,
      stagingOpId: opId,
    });
  }
  writeMigrationStateAtomic(projectDir, state);
  return opId;
}

/** Removes a recorded member's private stage dir and clears its `stagingOpId` in `migration-state.json`. */
function releaseMemberStage(
  projectDir: string,
  state: MigrationStateFile,
  unitKey: string,
  member: PlannedMigrationMember,
): void {
  const memberKey = makeMemberKey(member.kind, member.id, member.taskId);
  const pending = state.pendingUnits.find((u) => u.stale !== true && u.unitKey === unitKey);
  const pendingMember = pending?.members.find((m) => makeMemberKey(m.kind, m.id, m.taskId) === memberKey);
  if (!pendingMember || !isValidStagingOpId(pendingMember.stagingOpId)) return;
  const opId = pendingMember.stagingOpId;
  removeRecordedStageDir(projectDir, opId);
  delete pendingMember.stagingOpId;
  writeMigrationStateAtomic(projectDir, state);
}

/** Removes any private stage dirs recorded for `unitKey` in `state.pendingUnits` before removing the pending record. */
function cleanupRecordedUnitStages(projectDir: string, state: MigrationStateFile, unitKey: string): void {
  const pending = state.pendingUnits.find((u) => u.stale !== true && u.unitKey === unitKey);
  if (!pending) return;
  for (const m of pending.members) {
    if (isValidStagingOpId(m.stagingOpId)) {
      removeRecordedStageDir(projectDir, m.stagingOpId);
      delete m.stagingOpId;
    }
  }
}

function removePendingUnit(
  projectDir: string,
  state: MigrationStateFile,
  unitKey: string,
  opts?: { deferWrite?: boolean },
): boolean {
  cleanupRecordedUnitStages(projectDir, state, unitKey);
  const filtered = state.pendingUnits.filter((u) => u.stale === true || u.unitKey !== unitKey);
  if (filtered.length === state.pendingUnits.length) return false;
  state.pendingUnits = filtered;
  if (!opts?.deferWrite) {
    writeMigrationStateAtomic(projectDir, state);
  }
  return true;
}

function listAllUnknownEntries(
  canonRepo: string,
  projectDir: string,
  state: MigrationStateFile,
  extraUnknownEntries?: readonly string[],
): string[] {
  return [
    ...new Set([
      ...listLegacyUnknownEntries(canonRepo),
      ...listUnrecordedStagingEntries(projectDir, state),
      ...(extraUnknownEntries ?? []),
    ]),
  ].sort();
}

/**
 * Computes a read-only storage migration plan across all discovered (or specified) repositories.
 * Works on a `bun:sqlite` Database opened read-only and never creates or modifies any file, directory, or DB row.
 */
export function planStorageMigration(
  deps: StorageMigrationDeps,
  opts?: StorageMigrationOptions,
): StorageMigrationPlan {
  const nowFn = deps.now ?? Date.now;
  const generatedAt = nowFn();
  const layout = deps.storage.layout;

  if (layout === "legacy") {
    return {
      layout,
      noop: true,
      noopReason: "Storage layout is 'legacy'; migration only runs under 'data-dir' layout.",
      generatedAt,
      repos: [],
      totals: emptyPlanTotals(),
    };
  }

  const passIndexes = createPassDbIndexes(deps.sqlite);
  let cachedKnownRepoRoots: ReadonlySet<string> | null | undefined;
  let candidateRepos: string[] = [];
  const getKnownRepoRoots = (): ReadonlySet<string> | null => {
    if (cachedKnownRepoRoots !== undefined) return cachedKnownRepoRoots;
    try {
      const set = listAllKnownRepoRoots(deps.sqlite, opts?.repoRoots);
      for (const r of candidateRepos) set.add(r);
      cachedKnownRepoRoots = set;
    } catch {
      cachedKnownRepoRoots = null;
    }
    return cachedKnownRepoRoots;
  };
  if (opts?.repoRoots !== undefined) {
    const seen = new Set<string>();
    for (const raw of opts.repoRoots) {
      if (!raw || raw.length === 0) continue;
      const canon = canonicalPath(raw);
      if (!seen.has(canon)) {
        seen.add(canon);
        candidateRepos.push(canon);
      }
    }
  } else {
    const known = listAllKnownRepoRoots(deps.sqlite);
    cachedKnownRepoRoots = known;
    candidateRepos = [...known].sort();
  }

  const repos: RepoMigrationPlan[] = [];
  const totals = emptyPlanTotals();
  const allPlanAmbiguousRowIds = new Set<string>();

  for (const canonRepo of candidateRepos) {
    const projectDir = deps.storage.projectDir(canonRepo);
    const state = readMigrationState(projectDir);
    if (opts?.repoRoots === undefined) {
      const hasWork =
        isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR]) ||
        state.pendingUnits.length > 0 ||
        hasAnyLegacyArtifactRowForRepo(
          deps.sqlite,
          canonRepo,
          undefined,
          getKnownRepoRoots,
          passIndexes.getPassArtifactSnapshot(),
        );
      if (!hasWork) continue;
    }
    const excludedWorktreeRoots = collectExcludedWorktreeRoots(
      deps.storage,
      canonRepo,
      passIndexes.getRegisteredWorktreeRoots(),
    );
    const artifactIndex = buildRepoArtifactRowIndex(
      deps.sqlite,
      canonRepo,
      deps.storage,
      undefined,
      getKnownRepoRoots,
      passIndexes.getPassArtifactSnapshot(),
    );
    const historicalIndex = passIndexes.getHistoricalRunGoalIndex();
    const ownershipIndex = passIndexes.getOwnershipIndex();
    const repoBase = createRepoBasePaths(deps.storage, canonRepo);
    const { validPending, deferredPending, stalePending, newlyStaleErrors, dbErrors } = validatePendingUnits(
      deps.sqlite,
      deps.storage,
      canonRepo,
      state,
      artifactIndex,
      excludedWorktreeRoots,
      historicalIndex,
      undefined,
      repoBase,
    );
    const stalePendingUnits: StalePendingJournalEntry[] = stalePending.map((p) => ({
      unitKey: p.unitKey,
      kind: p.kind,
      id: p.id,
      ...(p.taskId !== undefined ? { taskId: p.taskId } : {}),
      ...(p.members[0]?.legacyPath ? { legacyPath: p.members[0].legacyPath } : {}),
      ...(p.members[0]?.destinationPath ? { destinationPath: p.members[0].destinationPath } : {}),
      reason: p.staleReason ?? "stale pending journal entry",
    }));
    const deferredPendingKeys = new Set(deferredPending.map((p) => p.unitKey));
    const bridgeMap = buildBridgeMap(state);
    const protectedBridgePaths = collectProtectedBridgePaths(state, bridgeMap);
    const { seeds, worktreeOverlaps, enumerationErrors } = discoverRepoUnitSeeds(
      deps.storage,
      canonRepo,
      validPending,
      artifactIndex,
      excludedWorktreeRoots,
      ownershipIndex,
      undefined,
      deferredPendingKeys,
      bridgeMap,
      repoBase,
      protectedBridgePaths,
    );
    const units: PlannedMigrationUnit[] = [];
    const repoTotals = emptyPlanTotals();
    const collisionErrors: MigrationErrorRecord[] = [];

    for (const seed of seeds) {
      if (seed.members.length === 0) continue;
      const evaluated = evaluateUnit(
        deps.storage,
        seed,
        generatedAt,
        artifactIndex,
        bridgeMap,
        ownershipIndex,
        undefined,
        repoBase,
      );
      // Drop stale pending entries that exist neither in legacy nor in data-dir.
      if (evaluated.members.every((m) => m.legacyState === "absent" && !m.destExists)) continue;
      if (evaluated.collisionError) {
        collisionErrors.push({
          repoRoot: canonRepo,
          unitKey: evaluated.unitKey,
          path: evaluated.collisionError.path,
          message: evaluated.collisionError.message,
        });
      }
      units.push(evaluated);
      addActionToPlanTotals(repoTotals, evaluated);
    }

    const unknownEntries = listAllUnknownEntries(canonRepo, projectDir, state, worktreeOverlaps);
    const reportedSet = new Set(state.reportedUnknownEntries);
    const newUnknownEntries = unknownEntries.filter((p) => !reportedSet.has(p));
    repoTotals.unknownEntries = unknownEntries.length;
    repoTotals.newUnknownEntries = newUnknownEntries.length;
    repoTotals.ambiguousRowsSkipped = artifactIndex.ambiguousRows.length;
    for (const row of artifactIndex.ambiguousRows) {
      allPlanAmbiguousRowIds.add(row.id);
    }

    repos.push({
      repoRoot: canonRepo,
      projectDir,
      units,
      unknownEntries,
      newUnknownEntries,
      ...(stalePendingUnits.length > 0 ? { stalePendingUnits } : {}),
      errors: [...newlyStaleErrors, ...dbErrors, ...enumerationErrors, ...collisionErrors],
      totals: repoTotals,
    });
    mergePlanTotals(totals, repoTotals);
  }
  totals.ambiguousRowsSkipped = allPlanAmbiguousRowIds.size;

  return {
    layout,
    noop: false,
    generatedAt,
    repos,
    totals,
  };
}

/**
 * Formats a `StorageMigrationPlan` for `pi-harness migrate-storage --dry-run`.
 * Lists each repo, each unit's kind, legacy path, destination, action, deferral reason,
 * unknown leftovers, and totals.
 */
export function formatStorageMigrationPlan(plan: StorageMigrationPlan): string {
  const lines: string[] = [];
  lines.push(`Storage migration plan (layout: ${plan.layout})`);

  if (plan.noop) {
    lines.push(plan.noopReason ?? "No-op.");
    return lines.join("\n");
  }

  if (plan.repos.length === 0) {
    lines.push("No repositories with legacy harness storage found.");
    lines.push(
      `Totals: 0 units (migrate: 0, merge: 0, finish: 0, rewrite_rows: 0, remove_bridge: 0, keep_bridge: 0, defer: 0, unknown: 0)`,
    );
    return lines.join("\n");
  }

  for (const repo of plan.repos) {
    lines.push("");
    lines.push(`Repository: ${repo.repoRoot}`);
    lines.push(`  Project dir: ${repo.projectDir}`);

    if (repo.units.length === 0) {
      lines.push("  Units: none");
    } else {
      lines.push(`  Units (${repo.units.length}):`);
      for (const unit of repo.units) {
        const reasonSuffix = unit.reason ? ` (${unit.reason})` : "";
        const rowsSuffix = unit.pendingRowRewrites > 0 ? ` [${unit.pendingRowRewrites} row(s) to rewrite]` : "";
        const ambigSuffix =
          (unit.ambiguousRowsSkipped ?? 0) > 0 ? ` [${unit.ambiguousRowsSkipped} ambiguous row(s) skipped]` : "";
        const idLabel = unit.taskId ? `${unit.id}/${unit.taskId}` : unit.id;
        lines.push(
          `    - [${unit.action}] ${unit.kind} ${idLabel}: ${unit.legacyPath} -> ${unit.destinationPath}${rowsSuffix}${ambigSuffix}${reasonSuffix}`,
        );
        if (unit.members.length > 1) {
          for (const m of unit.members) {
            const mId = m.taskId ? `${m.id}/${m.taskId}` : m.id;
            lines.push(`        * (${m.action}) ${m.kind} ${mId}: ${m.legacyPath} -> ${m.destinationPath}`);
          }
        }
      }
    }

    if (repo.unknownEntries.length > 0) {
      const newSet = new Set(repo.newUnknownEntries);
      lines.push(`  Unknown entries (${repo.unknownEntries.length}):`);
      for (const entry of repo.unknownEntries) {
        const tag = newSet.has(entry) ? " [new]" : "";
        lines.push(`    - ${entry}${tag}`);
      }
    }

    if (repo.stalePendingUnits && repo.stalePendingUnits.length > 0) {
      lines.push(`  Stale pending journal entries (${repo.stalePendingUnits.length}):`);
      for (const stale of repo.stalePendingUnits) {
        const pathSuffix =
          stale.legacyPath && stale.destinationPath ? `: ${stale.legacyPath} -> ${stale.destinationPath}` : "";
        lines.push(`    - [stale] ${stale.unitKey}${pathSuffix} (${stale.reason})`);
      }
    }

    if (repo.errors.length > 0) {
      lines.push(`  Errors (${repo.errors.length}):`);
      for (const err of repo.errors) {
        lines.push(`    - ${err.path ? `${err.path}: ` : ""}${err.message}`);
      }
    }

    const t = repo.totals;
    const repoAmbig = (t.ambiguousRowsSkipped ?? 0) > 0 ? `, ambiguous_rows_skipped: ${t.ambiguousRowsSkipped}` : "";
    lines.push(
      `  Repo totals: ${t.totalUnits} unit(s) (migrate: ${t.migrate}, merge: ${t.merge}, finish: ${t.finishMigration}, rewrite_rows: ${t.rewriteRows}, remove_bridge: ${t.removeBridge}, keep_bridge: ${t.keepBridge}, defer: ${t.deferred}, unknown: ${t.unknownEntries}${repoAmbig})`,
    );
  }

  const g = plan.totals;
  const globalAmbig = (g.ambiguousRowsSkipped ?? 0) > 0 ? `, ambiguous_rows_skipped: ${g.ambiguousRowsSkipped}` : "";
  lines.push("");
  lines.push(
    `Totals across ${plan.repos.length} repo(s): ${g.totalUnits} unit(s) (migrate: ${g.migrate}, merge: ${g.merge}, finish: ${g.finishMigration}, rewrite_rows: ${g.rewriteRows}, remove_bridge: ${g.removeBridge}, keep_bridge: ${g.keepBridge}, defer: ${g.deferred}, unknown: ${g.unknownEntries}${globalAmbig})`,
  );

  return lines.join("\n");
}

function executeSingleUnit(
  deps: StorageMigrationDeps,
  unit: PlannedMigrationUnit,
  projectDir: string,
  state: MigrationStateFile,
  bridgeMap: Map<string, RecordedBridgeEntry>,
  artifactIndex: RepoArtifactRowIndex,
  checkBudget: () => void,
  opts?: { onStateDeferred?: () => void; alreadyJournaled?: boolean },
): MigratedUnitResult {
  const { sqlite, storage, fault, forceCopy } = deps;
  const nowFn = deps.now ?? Date.now;
  const canonRepo = unit.repoRoot;
  const shadowedFiles: ShadowedFileRecord[] = [];
  let rowsRewritten = 0;
  let bridgesCreated = 0;
  let bridgesRemoved = 0;
  let method: "rename" | "copy" | "merge" | undefined;

  const markStateChanged = () => {
    if (opts?.onStateDeferred) {
      opts.onStateDeferred();
    } else {
      syncBridgeMapToState(state, bridgeMap);
      const ensured = storage.ensureProjectDir(canonRepo);
      writeMigrationStateAtomic(ensured, state);
    }
  };

  const adoptUnrecordedBridges = (): boolean => {
    let changed = false;
    for (const member of unit.members) {
      if (member.legacyState === "bridge" && member.bridgeNeedsRecord) {
        if (upsertBridgeRecord(bridgeMap, member.legacyPath, member.destinationPath, nowFn(), false, member.kind)) {
          changed = true;
        }
      }
    }
    return changed;
  };

  const rowSpecs: RowRewriteMemberSpec[] = unit.members.map((m) => ({
    kind: m.kind,
    id: m.id,
    ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
    destinationPath: m.destinationPath,
  }));
  const ambiguousRowsSkipped =
    unit.action === "defer" ? 0 : findAmbiguousRowIdsFromIndex(artifactIndex, rowSpecs, checkBudget).length;

  if (unit.action === "defer") {
    return {
      unitKey: unit.unitKey,
      kind: unit.kind,
      id: unit.id,
      ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
      repoRoot: canonRepo,
      legacyPath: unit.legacyPath,
      destinationPath: unit.destinationPath,
      action: unit.action,
      outcome: "deferred",
      ...(unit.reason !== undefined ? { reason: unit.reason } : {}),
      rowsRewritten: 0,
      ambiguousRowsSkipped: 0,
      bridgesCreated: 0,
      bridgesRemoved: 0,
      shadowedFiles: [],
      members: unit.members,
    };
  }

  if (unit.action === "keep_bridge") {
    let stateModified = adoptUnrecordedBridges();
    if (state.pendingUnits.some((u) => u.stale !== true && u.unitKey === unit.unitKey)) {
      storage.ensureProjectDir(canonRepo);
      if (removePendingUnit(projectDir, state, unit.unitKey, { deferWrite: Boolean(opts?.onStateDeferred) })) {
        stateModified = true;
      }
    }
    if (stateModified) {
      markStateChanged();
    }
    return {
      unitKey: unit.unitKey,
      kind: unit.kind,
      id: unit.id,
      ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
      repoRoot: canonRepo,
      legacyPath: unit.legacyPath,
      destinationPath: unit.destinationPath,
      action: unit.action,
      outcome: "bridge_kept",
      ...(unit.reason !== undefined ? { reason: unit.reason } : {}),
      rowsRewritten: 0,
      ambiguousRowsSkipped,
      bridgesCreated: 0,
      bridgesRemoved: 0,
      shadowedFiles: [],
      members: unit.members,
    };
  }

  if (unit.action === "rewrite_rows") {
    rowsRewritten = rewriteUnitArtifactRowsFromIndex(sqlite, artifactIndex, rowSpecs, checkBudget);
    fault?.("after_row_rewrite", makeFaultContext(unit, unit.members[0]!));
    let stateModified = adoptUnrecordedBridges();
    if (state.pendingUnits.some((u) => u.stale !== true && u.unitKey === unit.unitKey)) {
      storage.ensureProjectDir(canonRepo);
      if (removePendingUnit(projectDir, state, unit.unitKey, { deferWrite: Boolean(opts?.onStateDeferred) })) {
        stateModified = true;
      }
    }
    if (stateModified) {
      markStateChanged();
    }
    return {
      unitKey: unit.unitKey,
      kind: unit.kind,
      id: unit.id,
      ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
      repoRoot: canonRepo,
      legacyPath: unit.legacyPath,
      destinationPath: unit.destinationPath,
      action: unit.action,
      outcome: "rows_rewritten",
      rowsRewritten,
      ambiguousRowsSkipped,
      bridgesCreated: 0,
      bridgesRemoved: 0,
      shadowedFiles: [],
      members: unit.members,
    };
  }

  if (unit.action === "remove_bridge") {
    rowsRewritten = rewriteUnitArtifactRowsFromIndex(sqlite, artifactIndex, rowSpecs, checkBudget);
    let stateModified = adoptUnrecordedBridges();
    for (const member of unit.members) {
      if (member.action !== "remove_bridge") continue;
      checkBudget();
      const recorded = bridgeMap.get(member.legacyPath);
      if (!recorded) continue;
      const st = safeLstat(member.legacyPath);
      if (!st?.isSymbolicLink()) continue;
      if (nowFn() - effectiveBridgeCreatedAt(recorded.createdAt, st) < BRIDGE_MAX_AGE_MS) continue;
      let rawTarget: string | null = null;
      try {
        rawTarget = readlinkSync(member.legacyPath);
      } catch {
        continue;
      }
      const resolvedTarget = resolve(dirname(member.legacyPath), rawTarget);
      if (resolvedTarget !== recorded.target) continue;
      // A6/D6 defense-in-depth: never expire a dangling or wrong-type bridge symlink.
      const targetStat = safeLstat(resolvedTarget);
      if (!targetStat || targetStat.isSymbolicLink()) continue;
      const expectDir = isDirUnitKind(member.kind);
      if (expectDir ? !targetStat.isDirectory() : !targetStat.isFile()) continue;
      unlinkSync(member.legacyPath);
      if (removeBridgeRecord(bridgeMap, member.legacyPath)) {
        stateModified = true;
        opts?.onStateDeferred?.();
      }
      bridgesRemoved++;
    }
    if (state.pendingUnits.some((u) => u.stale !== true && u.unitKey === unit.unitKey)) {
      storage.ensureProjectDir(canonRepo);
      if (removePendingUnit(projectDir, state, unit.unitKey, { deferWrite: Boolean(opts?.onStateDeferred) })) {
        stateModified = true;
      }
    }
    if (stateModified) {
      markStateChanged();
    }
    return {
      unitKey: unit.unitKey,
      kind: unit.kind,
      id: unit.id,
      ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
      repoRoot: canonRepo,
      legacyPath: unit.legacyPath,
      destinationPath: unit.destinationPath,
      action: unit.action,
      outcome: "bridge_removed",
      rowsRewritten,
      ambiguousRowsSkipped,
      bridgesCreated: 0,
      bridgesRemoved,
      shadowedFiles: [],
      members: unit.members,
    };
  }

  // Pre-flight readability check across all real members so an unreadable (e.g. chmod 000) member
  // fails before touching projectDir, migration-state.json, or moving another half of a goal unit.
  for (const member of unit.members) {
    if (member.action === "migrate" || member.action === "merge") {
      verifyUnitReadable(member.legacyPath, isDirUnitKind(member.kind), checkBudget);
    }
  }

  // Active data movement / crash finish: migrate, merge, or finish_migration.
  const ensuredProjectDir = storage.ensureProjectDir(canonRepo);
  if (!opts?.alreadyJournaled) {
    syncBridgeMapToState(state, bridgeMap);
    upsertPendingUnit(ensuredProjectDir, state, unit);
  }

  const createBridgeFn = deps.createBridge ?? createBridgeSymlink;
  let bridgeStateModified = adoptUnrecordedBridges();
  const bridgedMembers = new Set<string>();

  const bridgeMember = (member: PlannedMigrationMember, bridgeOpts?: { replaceRegularFile?: boolean }): void => {
    const memberKey = makeMemberKey(member.kind, member.id, member.taskId);
    const existing = safeLstat(member.legacyPath);
    if (!existing) {
      createBridgeFn(member.legacyPath, member.destinationPath, canonRepo);
      let createdAt = nowFn();
      if (!deps.now) {
        const linkStat = safeLstat(member.legacyPath);
        if (linkStat) {
          createdAt = Math.min(createdAt, Math.floor(linkStat.mtimeMs));
        }
      }
      if (upsertBridgeRecord(bridgeMap, member.legacyPath, member.destinationPath, createdAt, true, member.kind)) {
        bridgeStateModified = true;
        opts?.onStateDeferred?.();
      }
      bridgesCreated++;
      bridgedMembers.add(memberKey);
    } else if (existing.isFile() && bridgeOpts?.replaceRegularFile) {
      createBridgeFn(member.legacyPath, member.destinationPath, canonRepo, { replaceFile: true });
      let createdAt = nowFn();
      if (!deps.now) {
        const linkStat = safeLstat(member.legacyPath);
        if (linkStat) {
          createdAt = Math.min(createdAt, Math.floor(linkStat.mtimeMs));
        }
      }
      if (upsertBridgeRecord(bridgeMap, member.legacyPath, member.destinationPath, createdAt, true, member.kind)) {
        bridgeStateModified = true;
        opts?.onStateDeferred?.();
      }
      bridgesCreated++;
      bridgedMembers.add(memberKey);
    } else if (existing.isSymbolicLink()) {
      // Idempotent check that an existing symlink points to destinationPath.
      createBridgeFn(member.legacyPath, member.destinationPath, canonRepo);
      if (upsertBridgeRecord(bridgeMap, member.legacyPath, member.destinationPath, nowFn(), false, member.kind)) {
        bridgeStateModified = true;
        opts?.onStateDeferred?.();
      }
      bridgedMembers.add(memberKey);
    } else {
      throw new Error(`Expected legacy path ${member.legacyPath} to be absent before creating bridge`);
    }
  };

  const rollbackRenamedMember = (
    member: PlannedMigrationMember,
    isDir: boolean,
    linkedWithoutUnlink = false,
  ): void => {
    if (!isDir && linkedWithoutUnlink) {
      if (safeLstat(member.legacyPath)?.isFile() && safeLstat(member.destinationPath)?.isFile()) {
        unlinkSync(member.destinationPath);
        return;
      }
    }
    if (safeLstat(member.legacyPath) !== null) return;
    if (isDir) {
      renameSync(member.destinationPath, member.legacyPath);
      return;
    }
    try {
      linkSync(member.destinationPath, member.legacyPath);
      unlinkSync(member.destinationPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return;
      if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS") {
        if (safeLstat(member.legacyPath) === null) {
          renameSync(member.destinationPath, member.legacyPath);
        }
        return;
      }
      throw err;
    }
  };

  // Step 1 & 2: recover unbridged members (bridge first), then move or merge every member that still has a real legacy entry on disk.
  const bothExistMembers = new Set<string>();
  const partialMovedRelPathsByMember = new Map<string, Set<string>>();

  const runMergeMember = (
    member: PlannedMigrationMember,
    isDir: boolean,
    faultCtx: MigrationUnitFaultContext,
    memberKey: string,
  ): void => {
    method = "merge";
    // F2: one unit's both-exist merge is one in-flight operation; check deadline before starting,
    // then complete the merge and create the bridge before any further deadline check or row transaction.
    checkBudget();
    const canPreserve = (entryPath: string, st: import("node:fs").Stats) =>
      !isProtectedOtherUnitDirEntry(ensuredProjectDir, entryPath, st, member);
    const mergeRes = mergeBothExist(
      member.legacyPath,
      member.destinationPath,
      isDir,
      isDir ? () => {} : checkBudget,
      {
        canPreserve,
        ...(!isDir
          ? {
              replaceSingleFileWithBridge: () => {
                fault?.("before_bridge", faultCtx);
                bridgeMember(member, { replaceRegularFile: true });
                fault?.("after_bridge", faultCtx);
              },
            }
          : {}),
      },
    );
    shadowedFiles.push(...mergeRes.shadowed);
    if (!mergeRes.fullyMerged) {
      bothExistMembers.add(memberKey);
      partialMovedRelPathsByMember.set(memberKey, new Set(mergeRes.mergedRelPaths));
    } else if (isDir) {
      fault?.("before_bridge", faultCtx);
      bridgeMember(member);
      fault?.("after_bridge", faultCtx);
    }
    fault?.("after_merge", faultCtx);
  };

  for (const member of unit.members) {
    const isDir = isDirUnitKind(member.kind);
    const faultCtx = makeFaultContext(unit, member);
    const memberKey = makeMemberKey(member.kind, member.id, member.taskId);

    if (member.action === "finish_migration") {
      checkBudget();
      fault?.("before_bridge", faultCtx);
      bridgeMember(member);
      fault?.("after_bridge", faultCtx);
      continue;
    }

    if (member.action === "migrate") {
      checkBudget();
      const canPreserve = (entryPath: string, st: import("node:fs").Stats) =>
        !isProtectedOtherUnitDirEntry(ensuredProjectDir, entryPath, st, member);
      shadowedFiles.push(
        ...ensureParentDirsUnderRoot(ensuredProjectDir, member.destinationPath, checkBudget, canPreserve),
      );

      // Re-check destination existence immediately before moving to avoid ever clobbering a concurrent file.
      const existingDest = safeLstat(member.destinationPath);
      if (existingDest) {
        runMergeMember(member, isDir, faultCtx, memberKey);
      } else {
        let didRename = false;
        let didLinkWithoutUnlink = false;
        let destAppearedDuringPlace = false;
        if (!forceCopy) {
          fault?.("before_rename_into_place", faultCtx);
          if (!isDir) {
            const placed = linkFileNoOverwrite(member.legacyPath, member.destinationPath);
            if (placed === "linked") {
              didRename = true;
              didLinkWithoutUnlink = true;
              method = method ?? "rename";
            } else if (placed === "exists") {
              destAppearedDuringPlace = true;
            }
          } else {
            try {
              renameSync(member.legacyPath, member.destinationPath);
              didRename = true;
              method = method ?? "rename";
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
                destAppearedDuringPlace = true;
              } else if (code !== "EXDEV") {
                throw err;
              }
            }
          }
        }
        if (destAppearedDuringPlace) {
          runMergeMember(member, isDir, faultCtx, memberKey);
        } else if (didRename) {
          fault?.("after_rename_into_place", faultCtx);
          fault?.("before_bridge", faultCtx);
          try {
            bridgeMember(member, didLinkWithoutUnlink ? { replaceRegularFile: true } : undefined);
          } catch (bridgeErr) {
            try {
              rollbackRenamedMember(member, isDir, didLinkWithoutUnlink);
            } catch {
              // If rollback itself fails, the pending journal remains on disk for recovery.
            }
            throw bridgeErr;
          }
          fault?.("after_bridge", faultCtx);
        } else {
          method = "copy";
          const opId = ensureMemberStagingOpId(ensuredProjectDir, state, unit, member);
          const stageDir = ensurePrivateStageDir(ensuredProjectDir, opId);
          const payloadPath = privateStagePayloadPath(ensuredProjectDir, opId);
          const staged = copyToStaging(member.legacyPath, stageDir, isDir, checkBudget);
          fault?.("after_copy", faultCtx);
          verifyCopyMatches(member.legacyPath, payloadPath, isDir, checkBudget, staged.manifest);
          fault?.("after_verify", faultCtx);
          checkBudget();
          fsyncStageTree(stageDir, payloadPath, isDir, staged.dirs, checkBudget);
          fault?.("before_rename_into_place", faultCtx);
          let copyDestCollided = false;
          if (!isDir) {
            const placed = moveFileNoOverwrite(payloadPath, member.destinationPath);
            if (placed === "exists") {
              copyDestCollided = true;
            } else if (placed === "exdev") {
              // payloadPath and destinationPath share projectDir; fallback only if linkSync is unsupported.
              if (safeLstat(member.destinationPath) !== null) {
                copyDestCollided = true;
              } else {
                renameSync(payloadPath, member.destinationPath);
              }
            }
          } else {
            try {
              renameSync(payloadPath, member.destinationPath);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code === "EEXIST" || code === "ENOTEMPTY" || code === "ENOTDIR") {
                copyDestCollided = true;
              } else {
                throw err;
              }
            }
          }
          if (copyDestCollided) {
            releaseMemberStage(ensuredProjectDir, state, unit.unitKey, member);
            runMergeMember(member, isDir, faultCtx, memberKey);
          } else {
            fsyncDirChain(storage.dataRoot ?? ensuredProjectDir, dirname(member.destinationPath));
            fault?.("after_rename_into_place", faultCtx);
            releaseMemberStage(ensuredProjectDir, state, unit.unitKey, member);
            const delRes = deleteVerifiedLegacy(member.legacyPath, isDir, staged.manifest, staged.dirs, checkBudget);
            if (!delRes.fullyDeleted) {
              bothExistMembers.add(memberKey);
              partialMovedRelPathsByMember.set(memberKey, new Set(delRes.deletedRelPaths));
            }
            fault?.("after_legacy_delete", faultCtx);
          }
        }
      }
    } else if (member.action === "merge") {
      runMergeMember(member, isDir, faultCtx, memberKey);
    }
  }

  // Step 3: One immediate SQLite transaction per unit rewrites artifacts.path rows for moved/verified files only (A7/D7).
  const effectiveRowSpecs: RowRewriteMemberSpec[] = [];
  for (const spec of rowSpecs) {
    const memberKey = makeMemberKey(spec.kind, spec.id, spec.taskId);
    if (!bothExistMembers.has(memberKey)) {
      effectiveRowSpecs.push(spec);
    } else if (isDirUnitKind(spec.kind)) {
      effectiveRowSpecs.push({
        ...spec,
        allowedRelPaths: partialMovedRelPathsByMember.get(memberKey) ?? new Set<string>(),
      });
    }
    // Single-file members left behind in legacy (bothExistMembers) are omitted so their rows stay on legacy.
  }
  const primaryFaultCtx = makeFaultContext(unit, unit.members[0]!);
  rowsRewritten = rewriteUnitArtifactRowsFromIndex(sqlite, artifactIndex, effectiveRowSpecs, checkBudget);
  fault?.("after_row_rewrite", primaryFaultCtx);

  // Step 4: Replace any remaining converged legacy unit paths (copy/merge paths) with unit-level symlink bridges.
  // Any member whose legacy entry changed after verification stays a real path (no bridge) for merge on the next pass.
  const membersToBridge = unit.members.filter((member) => {
    if (member.action === "keep_bridge" || member.action === "rewrite_rows" || member.action === "remove_bridge") {
      return false;
    }
    const memberKey = makeMemberKey(member.kind, member.id, member.taskId);
    return !bothExistMembers.has(memberKey) && !bridgedMembers.has(memberKey);
  });
  if (membersToBridge.length > 0) {
    fault?.("before_bridge", primaryFaultCtx);
    for (const member of membersToBridge) {
      bridgeMember(member);
    }
    fault?.("after_bridge", primaryFaultCtx);
  }

  // Clear pending recovery record; defer the disk flush until the next unit's upsert or end-of-repo flush
  // (a crash before that flush is idempotent because the bridge/dest already exist on disk).
  const pendingRemoved = removePendingUnit(ensuredProjectDir, state, unit.unitKey, {
    deferWrite: Boolean(opts?.onStateDeferred),
  });
  if (pendingRemoved || bridgeStateModified) {
    if (opts?.onStateDeferred) {
      opts.onStateDeferred();
    } else {
      syncBridgeMapToState(state, bridgeMap);
      writeMigrationStateAtomic(ensuredProjectDir, state);
    }
  }

  const outcome =
    bothExistMembers.size > 0
      ? "both_exist"
      : unit.action === "merge"
        ? "merged"
        : unit.action === "finish_migration"
          ? "finished"
          : "migrated";
  const reason =
    bothExistMembers.size > 0
      ? "both-exist: legacy unit changed after verification; unverified entries left in place for merge on next pass"
      : undefined;

  return {
    unitKey: unit.unitKey,
    kind: unit.kind,
    id: unit.id,
    ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
    repoRoot: canonRepo,
    legacyPath: unit.legacyPath,
    destinationPath: unit.destinationPath,
    action: unit.action,
    outcome,
    ...(method !== undefined ? { method } : {}),
    ...(reason !== undefined ? { reason } : {}),
    rowsRewritten,
    ambiguousRowsSkipped,
    bridgesCreated,
    bridgesRemoved,
    shadowedFiles,
    members: unit.members,
  };
}

/**
 * Runs one synchronous, budgeted storage migration pass.
 * Never throws: every error is caught, logged, recorded in the returned report, and retried on the next pass.
 * A no-op when `deps.storage.layout === "legacy"`.
 */
export function runStorageMigrationPass(
  deps: StorageMigrationDeps,
  opts?: StorageMigrationOptions,
): StorageMigrationReport {
  const nowFn = deps.now ?? Date.now;
  const startedAt = nowFn();
  const budgetMs =
    typeof opts?.budgetMs === "number" && Number.isFinite(opts.budgetMs) && opts.budgetMs >= 0
      ? opts.budgetMs
      : DEFAULT_MIGRATION_BUDGET_MS;

  const totals: StorageMigrationReportTotals = {
    reposScanned: 0,
    migrated: 0,
    merged: 0,
    finished: 0,
    rowsRewritten: 0,
    ambiguousRowsSkipped: 0,
    bridgesCreated: 0,
    bridgesRemoved: 0,
    bridgesKept: 0,
    deferred: 0,
    remaining: 0,
    unknownEntries: 0,
    newUnknownEntries: 0,
    errors: 0,
  };

  const log = (line: string) => {
    try {
      deps.log?.(line);
    } catch {
      // Never let a logging failure abort or throw from migration.
    }
  };

  if (deps.storage.layout === "legacy") {
    const skipReason = "Storage layout is 'legacy'; migration is a no-op.";
    log(`[storage-migrate] ${skipReason}`);
    const finishedAt = nowFn();
    return {
      layout: deps.storage.layout,
      skipped: true,
      skipReason,
      startedAt,
      finishedAt,
      elapsedMs: Math.max(0, finishedAt - startedAt),
      budgetMs,
      budgetExceeded: false,
      repos: [],
      remainingUnits: [],
      unknownEntries: [],
      newUnknownEntries: [],
      errors: [],
      totals,
    };
  }

  const allErrors: MigrationErrorRecord[] = [];
  const allRemaining: PlannedMigrationUnit[] = [];
  const allUnknown: string[] = [];
  const allNewUnknown: string[] = [];
  const allAmbiguousRowIds = new Set<string>();
  const repoReports: RepoMigrationReport[] = [];
  let budgetExceeded = false;
  let unevaluatedRemaining = 0;

  const checkBudget = () => {
    if (nowFn() - startedAt >= budgetMs) {
      throw new BudgetExceededError();
    }
  };

  const passIndexes = createPassDbIndexes(deps.sqlite, checkBudget);
  const dataRoot = deps.storage.dataRoot;
  const prevCursor = dataRoot ? readMigrationCursor(dataRoot) : { version: 1 as const, nextRepoRoot: null };

  let cachedKnownRepoRoots: ReadonlySet<string> | null | undefined;
  let candidateRepos: string[] = [];
  const getKnownRepoRoots = (): ReadonlySet<string> | null => {
    if (cachedKnownRepoRoots !== undefined) return cachedKnownRepoRoots;
    try {
      const set = listAllKnownRepoRoots(deps.sqlite, opts?.repoRoots, checkBudget);
      for (const r of candidateRepos) set.add(r);
      cachedKnownRepoRoots = set;
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      // Fail closed: cannot rule out another repo when DB lookup fails.
      cachedKnownRepoRoots = null;
    }
    return cachedKnownRepoRoots;
  };
  try {
    if (opts?.repoRoots !== undefined) {
      const seen = new Set<string>();
      for (const raw of opts.repoRoots) {
        checkBudget();
        if (!raw || raw.length === 0) continue;
        const canon = canonicalPath(raw);
        if (!seen.has(canon)) {
          seen.add(canon);
          candidateRepos.push(canon);
        }
      }
    } else {
      const known = listAllKnownRepoRoots(deps.sqlite, undefined, checkBudget);
      cachedKnownRepoRoots = known;
      candidateRepos = [...known].sort();
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      budgetExceeded = true;
      log(`[storage-migrate] wall-clock budget (${budgetMs}ms) reached during repo discovery`);
    } else {
      const record: MigrationErrorRecord = {
        message: err instanceof Error ? err.message : String(err),
      };
      allErrors.push(record);
      log(`[storage-migrate] repo discovery failed: ${record.message}`);
    }
  }

  const rotatedRepos = rotateReposFromCursor(candidateRepos, prevCursor.nextRepoRoot);
  let budgetHitRepo: string | null = null;

  for (const canonRepo of rotatedRepos) {
    if (budgetExceeded) break;
    try {
      checkBudget();
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetExceeded = true;
        budgetHitRepo = canonRepo;
        break;
      }
      throw err;
    }

    const projectDir = deps.storage.projectDir(canonRepo);
    let state: MigrationStateFile;
    let stateReadError: MigrationErrorRecord | null = null;
    try {
      state = readMigrationState(projectDir);
    } catch (err) {
      state = { version: 1, reportedUnknownEntries: [], pendingUnits: [] };
      stateReadError = {
        repoRoot: canonRepo,
        path: projectDir,
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (opts?.repoRoots === undefined) {
      let hasWork = false;
      try {
        hasWork =
          isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR]) ||
          state.pendingUnits.length > 0 ||
          hasAnyLegacyArtifactRowForRepo(
            deps.sqlite,
            canonRepo,
            checkBudget,
            getKnownRepoRoots,
            passIndexes.getPassArtifactSnapshot(),
          );
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExceeded = true;
          budgetHitRepo = canonRepo;
          log(`[storage-migrate] wall-clock budget (${budgetMs}ms) reached while checking pending work in ${canonRepo}`);
          break;
        }
        const record: MigrationErrorRecord = {
          repoRoot: canonRepo,
          message: err instanceof Error ? err.message : String(err),
        };
        allErrors.push(record);
        log(`[storage-migrate] failed checking pending work for ${canonRepo}: ${record.message}`);
        continue;
      }
      if (!hasWork) continue;
    }

    totals.reposScanned++;
    const repoReport: RepoMigrationReport = {
      repoRoot: canonRepo,
      projectDir,
      results: [],
      deferred: [],
      remainingUnits: [],
      unknownEntries: [],
      newUnknownEntries: [],
      removedEmptyDirs: [],
      ambiguousRowsSkipped: 0,
      errors: [],
    };
    repoReports.push(repoReport);
    if (stateReadError) {
      repoReport.errors.push(stateReadError);
      allErrors.push(stateReadError);
    }

    let artifactIndex: RepoArtifactRowIndex;
    let historicalIndex: HistoricalRunGoalIndex;
    let ownershipIndex: PassOwnershipIndex;
    let repoBase: RepoBasePaths | null = null;
    let excludedWorktreeRoots: string[] = [];
    let worktreeOverlaps: string[] = [];
    let seeds: UnitSeed[] = [];
    try {
      excludedWorktreeRoots = collectExcludedWorktreeRoots(
        deps.storage,
        canonRepo,
        passIndexes.getRegisteredWorktreeRoots(),
        checkBudget,
      );
      artifactIndex = buildRepoArtifactRowIndex(
        deps.sqlite,
        canonRepo,
        deps.storage,
        checkBudget,
        getKnownRepoRoots,
        passIndexes.getPassArtifactSnapshot(),
      );
      historicalIndex = passIndexes.getHistoricalRunGoalIndex();
      ownershipIndex = passIndexes.getOwnershipIndex();
      repoBase = createRepoBasePaths(deps.storage, canonRepo);
      repoReport.ambiguousRowsSkipped = artifactIndex.ambiguousRows.length;
      if (artifactIndex.ambiguousRows.length > 0) {
        for (const row of artifactIndex.ambiguousRows) {
          allAmbiguousRowIds.add(row.id);
        }
        log(
          `[storage-migrate] skipped ${artifactIndex.ambiguousRows.length} ambiguous relative artifact row(s) for ${canonRepo}`,
        );
      }
      const { validPending, deferredPending, stalePending, newlyStaleErrors, dbErrors } = validatePendingUnits(
        deps.sqlite,
        deps.storage,
        canonRepo,
        state,
        artifactIndex,
        excludedWorktreeRoots,
        historicalIndex,
        checkBudget,
        repoBase,
      );
      for (const errRec of [...newlyStaleErrors, ...dbErrors]) {
        repoReport.errors.push(errRec);
        allErrors.push(errRec);
        log(`[storage-migrate] ${errRec.message}`);
      }
      if (newlyStaleErrors.length > 0) {
        // Keep deferredPending and stalePending on disk (never dropped); mark newly failed entries stale: true.
        state.pendingUnits = [...validPending, ...deferredPending, ...stalePending];
        try {
          const ensured = deps.storage.ensureProjectDir(canonRepo);
          writeMigrationStateAtomic(ensured, state);
        } catch (writeErr) {
          const record: MigrationErrorRecord = {
            repoRoot: canonRepo,
            path: projectDir,
            message: writeErr instanceof Error ? writeErr.message : String(writeErr),
          };
          repoReport.errors.push(record);
          allErrors.push(record);
        }
      }
      const deferredPendingKeys = new Set(deferredPending.map((p) => p.unitKey));
      const initialBridgeMap = buildBridgeMap(state);
      const protectedBridgePaths = collectProtectedBridgePaths(state, initialBridgeMap);
      const discovered = discoverRepoUnitSeeds(
        deps.storage,
        canonRepo,
        validPending,
        artifactIndex,
        excludedWorktreeRoots,
        ownershipIndex,
        checkBudget,
        deferredPendingKeys,
        initialBridgeMap,
        repoBase,
        protectedBridgePaths,
      );
      seeds = discovered.seeds;
      worktreeOverlaps = discovered.worktreeOverlaps;
      for (const e of discovered.enumerationErrors) {
        repoReport.errors.push(e);
        allErrors.push(e);
        log(`[storage-migrate] enumeration error in ${e.path ?? canonRepo}: ${e.message}`);
      }
      if (discovered.leftoverBridgeTempLinks.length > 0) {
        cleanupLeftoverBridgeTempLinks(
          discovered.leftoverBridgeTempLinks,
          checkBudget,
          excludedWorktreeRoots,
          protectedBridgePaths,
        );
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetExceeded = true;
        budgetHitRepo = canonRepo;
        log(`[storage-migrate] wall-clock budget (${budgetMs}ms) reached during discovery in ${canonRepo}`);
        break;
      }
      const record: MigrationErrorRecord = {
        repoRoot: canonRepo,
        message: err instanceof Error ? err.message : String(err),
      };
      repoReport.errors.push(record);
      allErrors.push(record);
      log(`[storage-migrate] failed discovering units for ${canonRepo}: ${record.message}`);
      continue;
    }

    // Try units whose previous attempt hit the budget without completing AFTER all other units of this pass.
    const budgetDeferredSet = new Set<string>(state.budgetDeferredUnits ?? []);
    if (budgetDeferredSet.size > 0) {
      const normalSeeds: UnitSeed[] = [];
      const deprioritizedSeeds: UnitSeed[] = [];
      for (const s of seeds) {
        if (budgetDeferredSet.has(s.unitKey)) {
          deprioritizedSeeds.push(s);
        } else {
          normalSeeds.push(s);
        }
      }
      seeds = [...normalSeeds, ...deprioritizedSeeds];
    }

    const countRemainingSeedsFrom = (startIndex: number): number => {
      let count = 0;
      for (let r = startIndex; r < seeds.length; r++) {
        if (seeds[r]!.members.length > 0) count++;
      }
      return count;
    };

    const NOTE_JOURNAL_BATCH_SIZE = 64;
    const bridgeMap = buildBridgeMap(state);
    const evaluatedCache = new Map<number, PlannedMigrationUnit>();
    // F3: remember entries that already existed when this pass began; a budget stop must never drop them.
    const initialPendingUnitKeys = new Set<string>(
      state.pendingUnits.filter((u) => u.stale !== true).map((u) => u.unitKey),
    );
    const preJournaledNoteKeys = new Set<string>();
    let stateDirty = false;
    const flushPendingStateIfDirty = () => {
      if (preJournaledNoteKeys.size > 0) {
        state.pendingUnits = state.pendingUnits.filter(
          (u) => u.stale === true || initialPendingUnitKeys.has(u.unitKey) || !preJournaledNoteKeys.has(u.unitKey),
        );
        preJournaledNoteKeys.clear();
        stateDirty = true;
      }
      if (!stateDirty) return;
      try {
        syncBridgeMapToState(state, bridgeMap);
        state.budgetDeferredUnits = [...budgetDeferredSet].sort();
        const ensured = deps.storage.ensureProjectDir(canonRepo);
        writeMigrationStateAtomic(ensured, state);
        stateDirty = false;
      } catch (err) {
        const record: MigrationErrorRecord = {
          repoRoot: canonRepo,
          path: projectDir,
          message: err instanceof Error ? err.message : String(err),
        };
        repoReport.errors.push(record);
        allErrors.push(record);
      }
    };

    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]!;
      if (seed.members.length === 0) continue;

      let evaluated: PlannedMigrationUnit;
      const cachedEval = evaluatedCache.get(i);
      if (cachedEval) {
        evaluatedCache.delete(i);
        evaluated = cachedEval;
      } else {
        try {
          checkBudget();
          evaluated = evaluateUnit(
            deps.storage,
            seed,
            nowFn(),
            artifactIndex,
            bridgeMap,
            ownershipIndex,
            checkBudget,
            repoBase,
          );
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            budgetExceeded = true;
            budgetHitRepo = canonRepo;
            unevaluatedRemaining += countRemainingSeedsFrom(i);
            log(`[storage-migrate] wall-clock budget (${budgetMs}ms) reached before evaluating ${seed.unitKey}`);
            break;
          }
          const record: MigrationErrorRecord = {
            repoRoot: canonRepo,
            unitKey: seed.unitKey,
            message: err instanceof Error ? err.message : String(err),
          };
          repoReport.errors.push(record);
          allErrors.push(record);
          log(`[storage-migrate] failed evaluating ${seed.unitKey} in ${canonRepo}: ${record.message}`);
          continue;
        }
      }

      // Skip stale pending units that no longer exist anywhere on disk.
      if (evaluated.members.every((m) => m.legacyState === "absent" && !m.destExists)) {
        try {
          if (state.pendingUnits.some((u) => u.stale !== true && u.unitKey === seed.unitKey)) {
            syncBridgeMapToState(state, bridgeMap);
            const ensured = deps.storage.ensureProjectDir(canonRepo);
            removePendingUnit(ensured, state, seed.unitKey);
          }
        } catch {
          // Ignore cleanup errors for absent stale entries.
        }
        if (budgetDeferredSet.delete(seed.unitKey)) {
          stateDirty = true;
        }
        continue;
      }

      if (evaluated.action === "defer") {
        // Adopt any valid unrecorded bridge on first sight even if the unit is currently deferred (e.g. reopened goal).
        for (const m of evaluated.members) {
          if (m.legacyState === "bridge" && m.bridgeNeedsRecord) {
            if (upsertBridgeRecord(bridgeMap, m.legacyPath, m.destinationPath, nowFn(), false, m.kind)) {
              stateDirty = true;
            }
          } else if (m.legacyState === "invalid_symlink") {
            log(`[storage-migrate] leaving non-bridge symlink in place: ${m.legacyPath} (${m.reason ?? evaluated.reason ?? "invalid symlink"})`);
          }
        }
        if (evaluated.collisionError) {
          const record: MigrationErrorRecord = {
            repoRoot: canonRepo,
            unitKey: evaluated.unitKey,
            path: evaluated.collisionError.path,
            message: evaluated.collisionError.message,
          };
          repoReport.errors.push(record);
          allErrors.push(record);
          log(`[storage-migrate] ${record.message}`);
        }
        repoReport.deferred.push(evaluated);
        totals.deferred++;
        repoReport.results.push({
          unitKey: evaluated.unitKey,
          kind: evaluated.kind,
          id: evaluated.id,
          ...(evaluated.taskId !== undefined ? { taskId: evaluated.taskId } : {}),
          repoRoot: canonRepo,
          legacyPath: evaluated.legacyPath,
          destinationPath: evaluated.destinationPath,
          action: "defer",
          outcome: "deferred",
          ...(evaluated.reason !== undefined ? { reason: evaluated.reason } : {}),
          rowsRewritten: 0,
          bridgesCreated: 0,
          bridgesRemoved: 0,
          shadowedFiles: [],
          members: evaluated.members,
        });
        continue;
      }

      let startedUnitExecution = false;
      try {
        checkBudget();
        let alreadyJournaled = false;
        if (
          evaluated.kind === "note" &&
          (evaluated.action === "migrate" || evaluated.action === "merge" || evaluated.action === "finish_migration")
        ) {
          if (preJournaledNoteKeys.has(evaluated.unitKey)) {
            alreadyJournaled = true;
          } else {
            // Batch-journal up to NOTE_JOURNAL_BATCH_SIZE consecutive note units with one fsynced state write
            // (notes have no DB ownership state, so pre-journaling preserves crash durability while avoiding
            // thousands of per-file fsync barriers on large note trees).
            const batch: PlannedMigrationUnit[] = [];
            for (let j = i; j < seeds.length && batch.length < NOTE_JOURNAL_BATCH_SIZE; j++) {
              const s = seeds[j]!;
              if (s.members.length === 0) continue;
              if (s.kind !== "note") break;
              let ev: PlannedMigrationUnit;
              if (j === i) {
                ev = evaluated;
              } else {
                checkBudget();
                ev = evaluateUnit(
                  deps.storage,
                  s,
                  nowFn(),
                  artifactIndex,
                  bridgeMap,
                  ownershipIndex,
                  checkBudget,
                  repoBase,
                );
                evaluatedCache.set(j, ev);
              }
              if (ev.action === "migrate" || ev.action === "merge" || ev.action === "finish_migration") {
                let readable = true;
                for (const m of ev.members) {
                  if (m.action === "migrate" || m.action === "merge") {
                    try {
                      verifyUnitReadable(m.legacyPath, false, checkBudget);
                    } catch (readErr) {
                      if (readErr instanceof BudgetExceededError) throw readErr;
                      readable = false;
                      break;
                    }
                  }
                }
                if (readable) {
                  batch.push(ev);
                }
              }
            }
            if (batch.length > 0) {
              syncBridgeMapToState(state, bridgeMap);
              state.budgetDeferredUnits = [...budgetDeferredSet].sort();
              const ensured = deps.storage.ensureProjectDir(canonRepo);
              const existingByKey = new Map(
                state.pendingUnits.filter((u) => u.stale !== true).map((u) => [u.unitKey, u]),
              );
              const batchKeys = new Set(batch.map((b) => b.unitKey));
              const nextPending = state.pendingUnits.filter((u) => u.stale === true || !batchKeys.has(u.unitKey));
              for (const b of batch) {
                nextPending.push(toPendingUnitRecord(b, existingByKey.get(b.unitKey)));
                if (!existingByKey.has(b.unitKey) && !initialPendingUnitKeys.has(b.unitKey)) {
                  preJournaledNoteKeys.add(b.unitKey);
                }
              }
              state.pendingUnits = nextPending;
              writeMigrationStateAtomic(ensured, state);
              stateDirty = false;
              alreadyJournaled = batchKeys.has(evaluated.unitKey);
            }
          }
          checkBudget();
        }
        preJournaledNoteKeys.delete(evaluated.unitKey);
        startedUnitExecution = true;
        const result = executeSingleUnit(deps, evaluated, projectDir, state, bridgeMap, artifactIndex, checkBudget, {
          onStateDeferred: () => {
            stateDirty = true;
          },
          alreadyJournaled,
        });
        repoReport.results.push(result);
        totals.rowsRewritten += result.rowsRewritten;
        totals.bridgesCreated += result.bridgesCreated;
        totals.bridgesRemoved += result.bridgesRemoved;
        switch (result.outcome) {
          case "migrated":
            totals.migrated++;
            if (budgetDeferredSet.delete(evaluated.unitKey)) stateDirty = true;
            break;
          case "merged":
            totals.merged++;
            if (budgetDeferredSet.delete(evaluated.unitKey)) stateDirty = true;
            break;
          case "finished":
            totals.finished++;
            if (budgetDeferredSet.delete(evaluated.unitKey)) stateDirty = true;
            break;
          case "rows_rewritten":
          case "bridge_removed":
            if (budgetDeferredSet.delete(evaluated.unitKey)) stateDirty = true;
            break;
          case "bridge_kept":
            totals.bridgesKept++;
            if (budgetDeferredSet.delete(evaluated.unitKey)) stateDirty = true;
            break;
          case "both_exist":
            repoReport.remainingUnits.push(evaluated);
            allRemaining.push(evaluated);
            break;
          default:
            break;
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExceeded = true;
          budgetHitRepo = canonRepo;
          if (startedUnitExecution && !budgetDeferredSet.has(evaluated.unitKey)) {
            budgetDeferredSet.add(evaluated.unitKey);
            stateDirty = true;
          }
          repoReport.remainingUnits.push(evaluated);
          allRemaining.push(evaluated);
          repoReport.results.push({
            unitKey: evaluated.unitKey,
            kind: evaluated.kind,
            id: evaluated.id,
            ...(evaluated.taskId !== undefined ? { taskId: evaluated.taskId } : {}),
            repoRoot: canonRepo,
            legacyPath: evaluated.legacyPath,
            destinationPath: evaluated.destinationPath,
            action: evaluated.action,
            outcome: "budget_exceeded",
            reason: err.message,
            rowsRewritten: 0,
            bridgesCreated: 0,
            bridgesRemoved: 0,
            shadowedFiles: [],
            members: evaluated.members,
          });
          unevaluatedRemaining += countRemainingSeedsFrom(i + 1);
          log(`[storage-migrate] wall-clock budget (${budgetMs}ms) reached while processing ${evaluated.unitKey}`);
          break;
        }
        if (err instanceof PreservedPathExhaustedError) {
          const message = err.message;
          const record: MigrationErrorRecord = {
            repoRoot: canonRepo,
            unitKey: evaluated.unitKey,
            path: err.entryPath,
            message,
          };
          repoReport.errors.push(record);
          allErrors.push(record);
          repoReport.deferred.push({ ...evaluated, action: "defer", reason: message });
          totals.deferred++;
          repoReport.results.push({
            unitKey: evaluated.unitKey,
            kind: evaluated.kind,
            id: evaluated.id,
            ...(evaluated.taskId !== undefined ? { taskId: evaluated.taskId } : {}),
            repoRoot: canonRepo,
            legacyPath: evaluated.legacyPath,
            destinationPath: evaluated.destinationPath,
            action: "defer",
            outcome: "deferred",
            reason: message,
            rowsRewritten: 0,
            bridgesCreated: 0,
            bridgesRemoved: 0,
            shadowedFiles: [],
            members: evaluated.members,
          });
          log(`[storage-migrate] deferred unit ${evaluated.unitKey}: ${message}`);
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        const record: MigrationErrorRecord = {
          repoRoot: canonRepo,
          unitKey: evaluated.unitKey,
          path: evaluated.legacyPath,
          message,
        };
        repoReport.errors.push(record);
        allErrors.push(record);
        repoReport.results.push({
          unitKey: evaluated.unitKey,
          kind: evaluated.kind,
          id: evaluated.id,
          ...(evaluated.taskId !== undefined ? { taskId: evaluated.taskId } : {}),
          repoRoot: canonRepo,
          legacyPath: evaluated.legacyPath,
          destinationPath: evaluated.destinationPath,
          action: evaluated.action,
          outcome: "error",
          reason: message,
          rowsRewritten: 0,
          bridgesCreated: 0,
          bridgesRemoved: 0,
          shadowedFiles: [],
          members: evaluated.members,
        });
        log(`[storage-migrate] unit ${evaluated.unitKey} failed: ${message}`);
      }
    }

    if (!budgetExceeded && budgetDeferredSet.size > 0) {
      const activeKeys = new Set(seeds.map((s) => s.unitKey));
      for (const k of [...budgetDeferredSet]) {
        if (!activeKeys.has(k)) {
          budgetDeferredSet.delete(k);
          stateDirty = true;
        }
      }
    }

    flushPendingStateIfDirty();

    if (budgetExceeded) break;

    // Record unknown top-level entries under .harness, worktree overlaps, and unrecorded staging dirs (reported once in newUnknownEntries).
    try {
      checkBudget();
      const unknownEntries = listAllUnknownEntries(canonRepo, projectDir, state, worktreeOverlaps);
      const reportedSet = new Set(state.reportedUnknownEntries);
      const newUnknown = unknownEntries.filter((p) => !reportedSet.has(p));
      repoReport.unknownEntries = unknownEntries;
      repoReport.newUnknownEntries = newUnknown;
      allUnknown.push(...unknownEntries);
      allNewUnknown.push(...newUnknown);

      if (newUnknown.length > 0) {
        const ensured = deps.storage.ensureProjectDir(canonRepo);
        state.reportedUnknownEntries = [...new Set([...state.reportedUnknownEntries, ...newUnknown])].sort();
        writeMigrationStateAtomic(ensured, state);
        for (const entry of newUnknown) {
          log(`[storage-migrate] leaving unknown legacy entry in place: ${entry}`);
        }
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        budgetExceeded = true;
        budgetHitRepo = canonRepo;
        break;
      }
      const record: MigrationErrorRecord = {
        repoRoot: canonRepo,
        message: err instanceof Error ? err.message : String(err),
      };
      repoReport.errors.push(record);
      allErrors.push(record);
    }

    // Remove empty legacy container directories (never enters unit dirs, never runs when active pending recovery exists).
    if (!budgetExceeded && state.pendingUnits.every((u) => u.stale === true)) {
      try {
        checkBudget();
        repoReport.removedEmptyDirs = cleanupEmptyLegacyDirs(canonRepo, checkBudget, excludedWorktreeRoots);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExceeded = true;
          budgetHitRepo = canonRepo;
          break;
        }
        const record: MigrationErrorRecord = {
          repoRoot: canonRepo,
          message: err instanceof Error ? err.message : String(err),
        };
        repoReport.errors.push(record);
        allErrors.push(record);
      }
    }
  }

  let nextCursor: string | null = prevCursor.nextRepoRoot;
  if (budgetExceeded) {
    if (budgetHitRepo !== null && candidateRepos.length > 1) {
      const idx = candidateRepos.indexOf(budgetHitRepo);
      nextCursor = idx >= 0 ? candidateRepos[(idx + 1) % candidateRepos.length]! : null;
    } else if (candidateRepos.length <= 1) {
      nextCursor = null;
    }
  } else {
    nextCursor = null;
  }
  if (dataRoot && nextCursor !== prevCursor.nextRepoRoot) {
    try {
      writeMigrationCursorAtomic(dataRoot, { version: 1, nextRepoRoot: nextCursor });
    } catch (err) {
      const record: MigrationErrorRecord = {
        path: dataRoot,
        message: err instanceof Error ? err.message : String(err),
      };
      allErrors.push(record);
      log(`[storage-migrate] failed writing migration repo cursor: ${record.message}`);
    }
  }

  totals.remaining = allRemaining.length + unevaluatedRemaining;
  totals.ambiguousRowsSkipped = allAmbiguousRowIds.size;
  totals.unknownEntries = allUnknown.length;
  totals.newUnknownEntries = allNewUnknown.length;
  totals.errors = allErrors.length;

  const finishedAt = nowFn();
  return {
    layout: deps.storage.layout,
    skipped: false,
    startedAt,
    finishedAt,
    elapsedMs: Math.max(0, finishedAt - startedAt),
    budgetMs,
    budgetExceeded,
    repos: repoReports,
    remainingUnits: allRemaining,
    unknownEntries: allUnknown,
    newUnknownEntries: allNewUnknown,
    errors: allErrors,
    totals,
  };
}
