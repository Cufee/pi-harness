import type { Database } from "bun:sqlite";
import { readlinkSync, renameSync, unlinkSync } from "node:fs";
import { isDirectorTaskContainer } from "../control-plane/ids.js";
import {
  type DiscoveredLegacyUnit,
  listLegacyUnknownEntries,
  type StorageUnitKind,
  unitDataDirDestination,
} from "./data-dir/units.js";
import type { StorageLayout, StoragePaths } from "./paths.js";
import {
  countPendingRowRewrites,
  deriveRunChatSessionIdReadOnly,
  discoverRepoRoots,
  findFlatArtifactOwnerRows,
  findGoalsByLinkedRun,
  type GoalRowInfo,
  listLegacyArtifactRowsForRepo,
  listTasksForRun,
  type ParsedLegacyArtifactRow,
  readGoalRow,
  readRunRow,
  readTaskRow,
  rewriteUnitArtifactRows,
  type RowRewriteMemberSpec,
  TERMINAL_GOAL_STATUSES,
  TERMINAL_RUN_STATUSES,
  TERMINAL_TASK_STATUSES,
} from "./migrate/db.js";
import {
  BudgetExceededError,
  cleanupEmptyLegacyDirs,
  copyToStaging,
  createBridgeSymlink,
  deleteVerifiedLegacy,
  ensureParentDirsUnderRoot,
  enumerateLegacyUnitsSafe,
  findExistingDataDirUnit,
  isValidBridgeTarget,
  legacyPathForUnit,
  mergeBothExist,
  type MigrationStateFile,
  type PendingMigrationMember,
  type PendingMigrationUnit,
  readMigrationState,
  safeLstat,
  type ShadowedFileRecord,
  verifyCopyMatches,
  verifyUnitReadable,
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
  | "after_rename_into_place"
  | "after_legacy_delete"
  | "after_merge"
  | "after_row_rewrite"
  | "before_bridge";

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
  pendingRowRewrites: number;
  members: PlannedMigrationMember[];
}

export interface RepoMigrationPlan {
  repoRoot: string;
  projectDir: string;
  units: PlannedMigrationUnit[];
  unknownEntries: string[];
  newUnknownEntries: string[];
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
    | "deferred"
    | "error"
    | "budget_exceeded";
  method?: "rename" | "copy" | "merge";
  reason?: string;
  rowsRewritten: number;
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
  errors: MigrationErrorRecord[];
}

export interface StorageMigrationReportTotals {
  reposScanned: number;
  migrated: number;
  merged: number;
  finished: number;
  rowsRewritten: number;
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
  sqlite: Database,
  storage: StoragePaths,
  canonRepo: string,
  legacyRows: readonly ParsedLegacyArtifactRow[],
  existingMemberKeys: ReadonlySet<string>,
): MemberSeed[] {
  const recovered: MemberSeed[] = [];
  const seen = new Set<string>();

  const tryAdd = (kind: StorageUnitKind, id: string, taskId: string | undefined, ownerChat: string | null) => {
    const key = makeMemberKey(kind, id, taskId);
    if (existingMemberKeys.has(key) || seen.has(key)) return;
    const dest = findExistingDataDirUnit(storage, canonRepo, kind, id, taskId, ownerChat);
    if (!dest) return;
    seen.add(key);
    recovered.push({
      kind,
      id,
      ...(taskId !== undefined ? { taskId } : {}),
      legacyPath: legacyPathForUnit(canonRepo, kind, id, taskId),
      recoveredDestinationPath: dest,
    });
  };

  for (const row of legacyRows) {
    if (row.subdir === "goals" && row.subParts[0]) {
      const goalId = row.subParts[0];
      const goalRow = readGoalRow(sqlite, goalId);
      tryAdd("goal", goalId, undefined, goalRow?.chatSessionId ?? null);
    } else if (row.subdir === "artifacts" && row.subParts[0]) {
      const first = row.subParts[0];
      if (isDirectorTaskContainer(first) && row.subParts[1]) {
        const ownerChat = deriveRunChatSessionIdReadOnly(sqlite, first);
        tryAdd("bucket_task", first, row.subParts[1], ownerChat);
      } else if (row.subParts.length === 1) {
        const ownerChat = row.runId ? deriveRunChatSessionIdReadOnly(sqlite, row.runId) : null;
        // Try flat_artifact first, then run dir.
        const flatDest = findExistingDataDirUnit(storage, canonRepo, "flat_artifact", first, undefined, ownerChat);
        if (flatDest) {
          tryAdd("flat_artifact", first, undefined, ownerChat);
        } else {
          tryAdd("run", first, undefined, ownerChat);
        }
      } else {
        const ownerChat = deriveRunChatSessionIdReadOnly(sqlite, first);
        tryAdd("run", first, undefined, ownerChat);
      }
    } else if (row.subdir === "notes" && row.subParts.length >= 1) {
      tryAdd("note", row.subParts.join("/"), undefined, null);
    }
  }
  return recovered;
}

/** Discovers all logical unit seeds for a repository from disk, unrewritten artifact rows, and pending state. */
function discoverRepoUnitSeeds(
  sqlite: Database,
  storage: StoragePaths,
  canonRepo: string,
  state: MigrationStateFile,
): { seeds: UnitSeed[]; enumerationErrors: MigrationErrorRecord[] } {
  const { units: discovered, errors: enumErrs } = enumerateLegacyUnitsSafe(storage, canonRepo);
  const enumerationErrors: MigrationErrorRecord[] = enumErrs.map((e) => ({
    repoRoot: canonRepo,
    path: e.path,
    message: e.message,
  }));

  const memberMap = new Map<string, MemberSeed>();
  const addDiscovered = (u: DiscoveredLegacyUnit) => {
    const key = makeMemberKey(u.kind, u.id, u.taskId);
    if (!memberMap.has(key)) {
      memberMap.set(key, {
        kind: u.kind,
        id: u.id,
        ...(u.taskId !== undefined ? { taskId: u.taskId } : {}),
        legacyPath: u.legacyPath,
      });
    }
  };
  for (const u of discovered) addDiscovered(u);

  // Crash recovery source 1: artifacts rows still pointing to a legacy path whose unit now lives in data-dir.
  const legacyRows = listLegacyArtifactRowsForRepo(sqlite, canonRepo);
  for (const rec of recoverMembersFromArtifactRows(sqlite, storage, canonRepo, legacyRows, new Set(memberMap.keys()))) {
    const key = makeMemberKey(rec.kind, rec.id, rec.taskId);
    if (!memberMap.has(key)) memberMap.set(key, rec);
  }

  // Crash recovery source 2: pendingUnits from migration-state.json (covers units with 0 artifact rows,
  // or crashes after row rewrite and before bridge creation).
  for (const pending of state.pendingUnits) {
    for (const m of pending.members) {
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

  // Pass 1: goal members and their linked runs.
  for (const member of memberMap.values()) {
    if (member.kind !== "goal") continue;
    const seed = ensureGoalSeed(member.id);
    addMemberToSeed(seed, member);
    const goalRow = readGoalRow(sqlite, member.id);
    if (goalRow?.linkedRunId && !isDirectorTaskContainer(goalRow.linkedRunId)) {
      if (!seed.linkedRunIds.includes(goalRow.linkedRunId)) {
        seed.linkedRunIds.push(goalRow.linkedRunId);
      }
      if (!runToGoalId.has(goalRow.linkedRunId)) {
        runToGoalId.set(goalRow.linkedRunId, member.id);
      }
    }
  }

  // Pass 2: run members that belong to a goal via goals.linked_run_id (even if the goal dir isn't on disk).
  for (const member of memberMap.values()) {
    if (member.kind !== "run") continue;
    let targetGoalId = runToGoalId.get(member.id);
    const linkedGoals = findGoalsByLinkedRun(sqlite, member.id);
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

  // Pass 3: flat_artifact members indexed for any goal-linked run attach to that goal unit.
  for (const member of memberMap.values()) {
    if (member.kind !== "flat_artifact") continue;
    const ownerRows = findFlatArtifactOwnerRows(sqlite, canonRepo, member.id, storage);
    const matchedGoalIds = new Set<string>();
    const matchedRunIds = new Set<string>();
    for (const owner of ownerRows) {
      if (!owner.runId) continue;
      let gid = runToGoalId.get(owner.runId);
      if (!gid) {
        const linkedGoals = findGoalsByLinkedRun(sqlite, owner.runId);
        if (linkedGoals.length > 0) {
          const withDiskDir = linkedGoals.find((g) => goalSeeds.has(g.id));
          gid = (withDiskDir ?? linkedGoals[0]!).id;
          runToGoalId.set(owner.runId, gid);
        }
      }
      if (gid) {
        matchedGoalIds.add(gid);
        matchedRunIds.add(owner.runId);
      }
    }
    if (matchedGoalIds.size === 1) {
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
  for (const member of memberMap.values()) {
    const key = makeMemberKey(member.kind, member.id, member.taskId);
    if (claimedMemberKeys.has(key)) continue;
    claimedMemberKeys.add(key);
    otherSeeds.push({
      unitKey: key,
      kind: member.kind,
      id: member.id,
      ...(member.taskId !== undefined ? { taskId: member.taskId } : {}),
      repoRoot: canonRepo,
      members: [member],
      linkedRunIds: member.kind === "run" || member.kind === "bucket_task" ? [member.id] : [],
      linkedGoalIds: [],
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

  const allSeeds = [...goalSeeds.values(), ...otherSeeds].sort((a, b) => {
    const ko = UNIT_KIND_ORDER[a.kind] - UNIT_KIND_ORDER[b.kind];
    if (ko !== 0) return ko;
    return a.unitKey.localeCompare(b.unitKey);
  });

  return { seeds: allSeeds, enumerationErrors };
}

interface UnitOwnershipDecision {
  eligible: boolean;
  deferReason?: string;
  ownerChat: string | null;
}

/**
 * Evaluates a unit's current eligibility and chat ownership directly from SQLite right now.
 * Called at the start of each unit during execution so decisions never use stale pass-start snapshots.
 */
function decideUnitOwnership(
  sqlite: Database,
  storage: StoragePaths,
  seed: UnitSeed,
): UnitOwnershipDecision {
  const canonRepo = seed.repoRoot;

  if (seed.kind === "note") {
    return { eligible: true, ownerChat: null };
  }

  if (seed.kind === "goal") {
    const goalIds = new Set<string>([seed.id, ...seed.linkedGoalIds]);
    const runIds = new Set<string>(seed.linkedRunIds);

    // Re-read primary goal and any linked goals fresh from DB.
    const primaryGoal = readGoalRow(sqlite, seed.id);
    if (primaryGoal?.linkedRunId && !isDirectorTaskContainer(primaryGoal.linkedRunId)) {
      runIds.add(primaryGoal.linkedRunId);
    }
    for (const rid of [...runIds]) {
      for (const g of findGoalsByLinkedRun(sqlite, rid)) {
        goalIds.add(g.id);
      }
    }

    const goalRows: GoalRowInfo[] = [];
    for (const gid of goalIds) {
      const row = readGoalRow(sqlite, gid);
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
      const tasks = listTasksForRun(sqlite, rid);
      const liveTasks = tasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
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

    // Owner chat for goal units comes strictly from goals.chat_session_id (null -> chats/legacy).
    return {
      eligible: true,
      ownerChat: primaryGoal?.chatSessionId ?? null,
    };
  }

  if (seed.kind === "run") {
    // Re-check whether a goal now links this run.
    const linkedGoals = findGoalsByLinkedRun(sqlite, seed.id);
    for (const g of linkedGoals) {
      if (!TERMINAL_GOAL_STATUSES.has(g.status)) {
        return {
          eligible: false,
          deferReason: `linked goal ${g.id} is non-terminal (${g.status})`,
          ownerChat: g.chatSessionId ?? deriveRunChatSessionIdReadOnly(sqlite, seed.id),
        };
      }
    }

    const runRow = readRunRow(sqlite, seed.id);
    if (!runRow) {
      // Unknown run id: ownerless -> eligible, destination chats/legacy.
      return { eligible: true, ownerChat: null };
    }

    const ownerChat = deriveRunChatSessionIdReadOnly(sqlite, seed.id);
    if (!TERMINAL_RUN_STATUSES.has(runRow.status)) {
      return {
        eligible: false,
        deferReason: `run ${seed.id} is non-terminal (${runRow.status})`,
        ownerChat,
      };
    }

    const tasks = listTasksForRun(sqlite, seed.id);
    const liveTasks = tasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
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
    const taskRow = readTaskRow(sqlite, taskId);
    if (!taskRow) {
      // Unknown task id: ownerless -> eligible, destination chats/legacy.
      return { eligible: true, ownerChat: null };
    }
    const ownerChat = deriveRunChatSessionIdReadOnly(sqlite, seed.id);
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
  const ownerRows = findFlatArtifactOwnerRows(sqlite, canonRepo, seed.id, storage);
  if (ownerRows.length === 0) {
    // Ownerless flat artifact -> eligible, destination chats/legacy.
    return { eligible: true, ownerChat: null };
  }

  const candidateChats = new Set<string | null>();
  for (const owner of ownerRows) {
    if (!owner.runId) continue;

    // Check linked goals for this run.
    const linkedGoals = findGoalsByLinkedRun(sqlite, owner.runId);
    for (const g of linkedGoals) {
      if (!TERMINAL_GOAL_STATUSES.has(g.status)) {
        return {
          eligible: false,
          deferReason: `flat artifact ${seed.id} belongs to non-terminal goal ${g.id} (${g.status})`,
          ownerChat: g.chatSessionId ?? null,
        };
      }
      candidateChats.add(g.chatSessionId ?? null);
    }

    if (isDirectorTaskContainer(owner.runId)) {
      if (owner.taskId) {
        const taskRow = readTaskRow(sqlite, owner.taskId);
        if (taskRow && !TERMINAL_TASK_STATUSES.has(taskRow.status)) {
          return {
            eligible: false,
            deferReason: `flat artifact ${seed.id} belongs to live bucket task ${owner.taskId} (${taskRow.status})`,
            ownerChat: deriveRunChatSessionIdReadOnly(sqlite, owner.runId),
          };
        }
        if (taskRow) {
          candidateChats.add(deriveRunChatSessionIdReadOnly(sqlite, owner.runId));
        }
      }
      continue;
    }

    const runRow = readRunRow(sqlite, owner.runId);
    if (!runRow) continue;

    const runChat = deriveRunChatSessionIdReadOnly(sqlite, owner.runId);
    if (linkedGoals.length === 0 && !TERMINAL_RUN_STATUSES.has(runRow.status)) {
      return {
        eligible: false,
        deferReason: `flat artifact ${seed.id} belongs to non-terminal run ${owner.runId} (${runRow.status})`,
        ownerChat: runChat,
      };
    }
    const tasks = listTasksForRun(sqlite, owner.runId);
    const liveTasks = tasks.filter((t) => !TERMINAL_TASK_STATUSES.has(t.status));
    if (liveTasks.length > 0) {
      const sample = liveTasks
        .slice(0, 3)
        .map((t) => `${t.id} (${t.status})`)
        .join(", ");
      return {
        eligible: false,
        deferReason: `flat artifact ${seed.id} belongs to run ${owner.runId} with live task(s): ${sample}`,
        ownerChat: runChat,
      };
    }
    if (linkedGoals.length === 0) {
      candidateChats.add(runChat);
    }
  }

  const nonNullChats = [...candidateChats].filter((c): c is string => Boolean(c));
  const ownerChat = nonNullChats.length === 1 ? nonNullChats[0]! : null;
  return { eligible: true, ownerChat };
}

/** Evaluates current disk + DB state for one logical unit without mutating anything. */
function evaluateUnit(
  sqlite: Database,
  storage: StoragePaths,
  seed: UnitSeed,
  nowMs: number,
): PlannedMigrationUnit {
  const canonRepo = seed.repoRoot;
  const ownership = decideUnitOwnership(sqlite, storage, seed);

  const plannedMembers: PlannedMigrationMember[] = [];
  let invalidSymlinkReason: string | undefined;

  for (const m of seed.members) {
    const expectDir = isDirUnitKind(m.kind);
    const legStat = safeLstat(m.legacyPath);
    let legacyState: LegacyMemberDiskState = "absent";
    let validBridgeDest: string | null = null;
    let bridgeAgeMs: number | undefined;

    if (legStat) {
      if (legStat.isSymbolicLink()) {
        let rawTarget: string | null = null;
        try {
          rawTarget = readlinkSync(m.legacyPath);
        } catch {
          rawTarget = null;
        }
        validBridgeDest = isValidBridgeTarget(storage, canonRepo, m.legacyPath, rawTarget);
        if (validBridgeDest) {
          legacyState = "bridge";
          bridgeAgeMs = Math.max(0, nowMs - legStat.mtimeMs);
        } else {
          legacyState = "invalid_symlink";
          invalidSymlinkReason ??= `legacy symlink at ${m.legacyPath} points outside project data dir`;
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
      );
      destinationPath =
        existingDataDir ??
        unitDataDirDestination(storage, {
          kind: m.kind,
          repoRoot: canonRepo,
          id: m.id,
          ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
          chatSessionId: ownership.ownerChat,
        });
    }

    const dstStat = safeLstat(destinationPath);
    const destExists = Boolean(
      dstStat && !dstStat.isSymbolicLink() && (expectDir ? dstStat.isDirectory() : dstStat.isFile()),
    );

    plannedMembers.push({
      kind: m.kind,
      id: m.id,
      ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
      legacyPath: m.legacyPath,
      destinationPath,
      legacyState,
      destExists,
      action: "keep_bridge",
      ...(bridgeAgeMs !== undefined ? { bridgeAgeMs } : {}),
    });
  }

  const rowSpecs: RowRewriteMemberSpec[] = plannedMembers.map((m) => ({
    kind: m.kind,
    id: m.id,
    ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
    destinationPath: m.destinationPath,
  }));
  const pendingRowRewrites = countPendingRowRewrites(sqlite, canonRepo, rowSpecs);

  // Assign per-member actions.
  for (const m of plannedMembers) {
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
    if (m.legacyState === "real") {
      m.action = m.destExists ? "merge" : "migrate";
    } else if (m.legacyState === "absent") {
      m.action = m.destExists ? "finish_migration" : "keep_bridge";
    } else if (m.legacyState === "bridge") {
      if ((m.bridgeAgeMs ?? 0) >= BRIDGE_MAX_AGE_MS) {
        m.action = "remove_bridge";
      } else if (pendingRowRewrites > 0) {
        m.action = "rewrite_rows";
      } else {
        m.action = "keep_bridge";
        m.reason = "bridge is younger than 7 days";
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
    pendingRowRewrites,
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

function toPendingUnitRecord(unit: PlannedMigrationUnit): PendingMigrationUnit {
  const members: PendingMigrationMember[] = unit.members.map((m) => ({
    kind: m.kind,
    id: m.id,
    ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
    legacyPath: m.legacyPath,
    destinationPath: m.destinationPath,
  }));
  return {
    unitKey: unit.unitKey,
    kind: unit.kind,
    id: unit.id,
    ...(unit.taskId !== undefined ? { taskId: unit.taskId } : {}),
    members,
  };
}

function upsertPendingUnit(projectDir: string, state: MigrationStateFile, unit: PlannedMigrationUnit): void {
  const next = state.pendingUnits.filter((u) => u.unitKey !== unit.unitKey);
  next.push(toPendingUnitRecord(unit));
  state.pendingUnits = next;
  writeMigrationStateAtomic(projectDir, state);
}

function removePendingUnit(projectDir: string, state: MigrationStateFile, unitKey: string): void {
  const filtered = state.pendingUnits.filter((u) => u.unitKey !== unitKey);
  if (filtered.length === state.pendingUnits.length) return;
  state.pendingUnits = filtered;
  writeMigrationStateAtomic(projectDir, state);
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

  const repoRoots = discoverRepoRoots(deps.sqlite, opts?.repoRoots, deps.storage);
  const repos: RepoMigrationPlan[] = [];
  const totals = emptyPlanTotals();

  for (const canonRepo of repoRoots) {
    const projectDir = deps.storage.projectDir(canonRepo);
    const state = readMigrationState(projectDir);
    const { seeds, enumerationErrors } = discoverRepoUnitSeeds(deps.sqlite, deps.storage, canonRepo, state);
    const units: PlannedMigrationUnit[] = [];
    const repoTotals = emptyPlanTotals();

    for (const seed of seeds) {
      if (seed.members.length === 0) continue;
      const evaluated = evaluateUnit(deps.sqlite, deps.storage, seed, generatedAt);
      // Drop stale pending entries that exist neither in legacy nor in data-dir.
      if (evaluated.members.every((m) => m.legacyState === "absent" && !m.destExists)) continue;
      units.push(evaluated);
      addActionToPlanTotals(repoTotals, evaluated);
    }

    const unknownEntries = listLegacyUnknownEntries(canonRepo);
    const reportedSet = new Set(state.reportedUnknownEntries);
    const newUnknownEntries = unknownEntries.filter((p) => !reportedSet.has(p));
    repoTotals.unknownEntries = unknownEntries.length;
    repoTotals.newUnknownEntries = newUnknownEntries.length;

    repos.push({
      repoRoot: canonRepo,
      projectDir,
      units,
      unknownEntries,
      newUnknownEntries,
      errors: enumerationErrors,
      totals: repoTotals,
    });
    mergePlanTotals(totals, repoTotals);
  }

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
        const idLabel = unit.taskId ? `${unit.id}/${unit.taskId}` : unit.id;
        lines.push(
          `    - [${unit.action}] ${unit.kind} ${idLabel}: ${unit.legacyPath} -> ${unit.destinationPath}${rowsSuffix}${reasonSuffix}`,
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

    if (repo.errors.length > 0) {
      lines.push(`  Errors (${repo.errors.length}):`);
      for (const err of repo.errors) {
        lines.push(`    - ${err.path ? `${err.path}: ` : ""}${err.message}`);
      }
    }

    const t = repo.totals;
    lines.push(
      `  Repo totals: ${t.totalUnits} unit(s) (migrate: ${t.migrate}, merge: ${t.merge}, finish: ${t.finishMigration}, rewrite_rows: ${t.rewriteRows}, remove_bridge: ${t.removeBridge}, keep_bridge: ${t.keepBridge}, defer: ${t.deferred}, unknown: ${t.unknownEntries})`,
    );
  }

  const g = plan.totals;
  lines.push("");
  lines.push(
    `Totals across ${plan.repos.length} repo(s): ${g.totalUnits} unit(s) (migrate: ${g.migrate}, merge: ${g.merge}, finish: ${g.finishMigration}, rewrite_rows: ${g.rewriteRows}, remove_bridge: ${g.removeBridge}, keep_bridge: ${g.keepBridge}, defer: ${g.deferred}, unknown: ${g.unknownEntries})`,
  );

  return lines.join("\n");
}

function executeSingleUnit(
  deps: StorageMigrationDeps,
  unit: PlannedMigrationUnit,
  projectDir: string,
  state: MigrationStateFile,
  checkBudget: () => void,
): MigratedUnitResult {
  const { sqlite, storage, fault, forceCopy } = deps;
  const canonRepo = unit.repoRoot;
  const shadowedFiles: ShadowedFileRecord[] = [];
  let rowsRewritten = 0;
  let bridgesCreated = 0;
  let bridgesRemoved = 0;
  let method: "rename" | "copy" | "merge" | undefined;

  const rowSpecs: RowRewriteMemberSpec[] = unit.members.map((m) => ({
    kind: m.kind,
    id: m.id,
    ...(m.taskId !== undefined ? { taskId: m.taskId } : {}),
    destinationPath: m.destinationPath,
  }));

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
      bridgesCreated: 0,
      bridgesRemoved: 0,
      shadowedFiles: [],
      members: unit.members,
    };
  }

  if (unit.action === "keep_bridge") {
    if (state.pendingUnits.some((u) => u.unitKey === unit.unitKey)) {
      storage.ensureProjectDir(canonRepo);
      removePendingUnit(projectDir, state, unit.unitKey);
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
      bridgesCreated: 0,
      bridgesRemoved: 0,
      shadowedFiles: [],
      members: unit.members,
    };
  }

  if (unit.action === "rewrite_rows") {
    rowsRewritten = rewriteUnitArtifactRows(sqlite, canonRepo, rowSpecs);
    fault?.("after_row_rewrite", makeFaultContext(unit, unit.members[0]!));
    if (state.pendingUnits.some((u) => u.unitKey === unit.unitKey)) {
      storage.ensureProjectDir(canonRepo);
      removePendingUnit(projectDir, state, unit.unitKey);
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
      bridgesCreated: 0,
      bridgesRemoved: 0,
      shadowedFiles: [],
      members: unit.members,
    };
  }

  if (unit.action === "remove_bridge") {
    rowsRewritten = rewriteUnitArtifactRows(sqlite, canonRepo, rowSpecs);
    for (const member of unit.members) {
      if (member.action !== "remove_bridge") continue;
      const st = safeLstat(member.legacyPath);
      if (st?.isSymbolicLink()) {
        unlinkSync(member.legacyPath);
        bridgesRemoved++;
      }
    }
    if (state.pendingUnits.some((u) => u.unitKey === unit.unitKey)) {
      storage.ensureProjectDir(canonRepo);
      removePendingUnit(projectDir, state, unit.unitKey);
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
      verifyUnitReadable(member.legacyPath, isDirUnitKind(member.kind));
    }
  }

  // Active data movement / crash finish: migrate, merge, or finish_migration.
  const ensuredProjectDir = storage.ensureProjectDir(canonRepo);
  upsertPendingUnit(ensuredProjectDir, state, unit);

  // Step 1 & 2: move or merge every member that still has a real legacy entry on disk.
  for (const member of unit.members) {
    const isDir = isDirUnitKind(member.kind);
    const faultCtx = makeFaultContext(unit, member);

    if (member.action === "migrate") {
      checkBudget();
      ensureParentDirsUnderRoot(ensuredProjectDir, member.destinationPath);

      // Re-check destination existence immediately before moving to avoid ever clobbering a concurrent file.
      const existingDest = safeLstat(member.destinationPath);
      if (existingDest) {
        method = "merge";
        const shadowed = mergeBothExist(member.legacyPath, member.destinationPath, isDir, checkBudget);
        shadowedFiles.push(...shadowed);
        fault?.("after_merge", faultCtx);
      } else {
        let didRename = false;
        if (!forceCopy) {
          try {
            renameSync(member.legacyPath, member.destinationPath);
            didRename = true;
            method = method ?? "rename";
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
          }
        }
        if (didRename) {
          fault?.("after_rename_into_place", faultCtx);
        } else {
          method = "copy";
          const stagingPath = `${member.destinationPath}.migrating`;
          copyToStaging(member.legacyPath, stagingPath, isDir, checkBudget);
          fault?.("after_copy", faultCtx);
          verifyCopyMatches(member.legacyPath, stagingPath, isDir);
          fault?.("after_verify", faultCtx);
          renameSync(stagingPath, member.destinationPath);
          fault?.("after_rename_into_place", faultCtx);
          verifyCopyMatches(member.legacyPath, member.destinationPath, isDir);
          deleteVerifiedLegacy(member.legacyPath, isDir);
          fault?.("after_legacy_delete", faultCtx);
        }
      }
    } else if (member.action === "merge") {
      checkBudget();
      method = "merge";
      const shadowed = mergeBothExist(member.legacyPath, member.destinationPath, isDir, checkBudget);
      shadowedFiles.push(...shadowed);
      fault?.("after_merge", faultCtx);
    }
  }

  // Step 3: One immediate SQLite transaction per unit rewrites artifacts.path rows for all members.
  const primaryFaultCtx = makeFaultContext(unit, unit.members[0]!);
  rowsRewritten = rewriteUnitArtifactRows(sqlite, canonRepo, rowSpecs);
  fault?.("after_row_rewrite", primaryFaultCtx);

  // Step 4: Replace each legacy unit path with a unit-level symlink bridge.
  fault?.("before_bridge", primaryFaultCtx);
  for (const member of unit.members) {
    if (member.action === "keep_bridge" || member.action === "rewrite_rows" || member.action === "remove_bridge") {
      continue;
    }
    const existing = safeLstat(member.legacyPath);
    if (!existing) {
      createBridgeSymlink(member.legacyPath, member.destinationPath, canonRepo);
      bridgesCreated++;
    } else if (existing.isSymbolicLink()) {
      // Idempotent check that an existing symlink points to destinationPath.
      createBridgeSymlink(member.legacyPath, member.destinationPath, canonRepo);
    } else {
      throw new Error(`Expected legacy path ${member.legacyPath} to be absent before creating bridge`);
    }
  }

  // Unit is completely converged; clear its pending recovery entry.
  removePendingUnit(ensuredProjectDir, state, unit.unitKey);

  const outcome =
    unit.action === "merge"
      ? "merged"
      : unit.action === "finish_migration"
        ? "finished"
        : "migrated";

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
    rowsRewritten,
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
  const repoReports: RepoMigrationReport[] = [];
  let budgetExceeded = false;

  const checkBudget = () => {
    if (nowFn() - startedAt >= budgetMs) {
      throw new BudgetExceededError();
    }
  };

  let repoRoots: string[] = [];
  try {
    repoRoots = discoverRepoRoots(deps.sqlite, opts?.repoRoots, deps.storage);
  } catch (err) {
    const record: MigrationErrorRecord = {
      message: err instanceof Error ? err.message : String(err),
    };
    allErrors.push(record);
    log(`[storage-migrate] repo discovery failed: ${record.message}`);
  }

  for (const canonRepo of repoRoots) {
    totals.reposScanned++;
    const projectDir = deps.storage.projectDir(canonRepo);
    const repoReport: RepoMigrationReport = {
      repoRoot: canonRepo,
      projectDir,
      results: [],
      deferred: [],
      remainingUnits: [],
      unknownEntries: [],
      newUnknownEntries: [],
      removedEmptyDirs: [],
      errors: [],
    };
    repoReports.push(repoReport);

    let state: MigrationStateFile;
    try {
      state = readMigrationState(projectDir);
    } catch (err) {
      state = { version: 1, reportedUnknownEntries: [], pendingUnits: [] };
      const record: MigrationErrorRecord = {
        repoRoot: canonRepo,
        path: projectDir,
        message: err instanceof Error ? err.message : String(err),
      };
      repoReport.errors.push(record);
      allErrors.push(record);
    }

    let seeds: UnitSeed[] = [];
    try {
      const discovered = discoverRepoUnitSeeds(deps.sqlite, deps.storage, canonRepo, state);
      seeds = discovered.seeds;
      for (const e of discovered.enumerationErrors) {
        repoReport.errors.push(e);
        allErrors.push(e);
        log(`[storage-migrate] enumeration error in ${e.path ?? canonRepo}: ${e.message}`);
      }
    } catch (err) {
      const record: MigrationErrorRecord = {
        repoRoot: canonRepo,
        message: err instanceof Error ? err.message : String(err),
      };
      repoReport.errors.push(record);
      allErrors.push(record);
      log(`[storage-migrate] failed discovering units for ${canonRepo}: ${record.message}`);
    }

    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]!;
      if (seed.members.length === 0) continue;

      let evaluated: PlannedMigrationUnit;
      try {
        evaluated = evaluateUnit(deps.sqlite, deps.storage, seed, nowFn());
      } catch (err) {
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

      // Skip stale pending units that no longer exist anywhere on disk.
      if (evaluated.members.every((m) => m.legacyState === "absent" && !m.destExists)) {
        try {
          if (state.pendingUnits.some((u) => u.unitKey === seed.unitKey)) {
            const ensured = deps.storage.ensureProjectDir(canonRepo);
            removePendingUnit(ensured, state, seed.unitKey);
          }
        } catch {
          // Ignore cleanup errors for absent stale entries.
        }
        continue;
      }

      if (evaluated.action === "defer") {
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

      if (budgetExceeded) {
        repoReport.remainingUnits.push(evaluated);
        allRemaining.push(evaluated);
        continue;
      }

      try {
        checkBudget();
        const result = executeSingleUnit(deps, evaluated, projectDir, state, checkBudget);
        repoReport.results.push(result);
        totals.rowsRewritten += result.rowsRewritten;
        totals.bridgesCreated += result.bridgesCreated;
        totals.bridgesRemoved += result.bridgesRemoved;
        switch (result.outcome) {
          case "migrated":
            totals.migrated++;
            break;
          case "merged":
            totals.merged++;
            break;
          case "finished":
            totals.finished++;
            break;
          case "bridge_kept":
            totals.bridgesKept++;
            break;
          default:
            break;
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          budgetExceeded = true;
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
          log(`[storage-migrate] wall-clock budget (${budgetMs}ms) reached while processing ${evaluated.unitKey}`);
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

    // Record unknown top-level entries under .harness (reported once in newUnknownEntries).
    try {
      const unknownEntries = listLegacyUnknownEntries(canonRepo);
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
      const record: MigrationErrorRecord = {
        repoRoot: canonRepo,
        message: err instanceof Error ? err.message : String(err),
      };
      repoReport.errors.push(record);
      allErrors.push(record);
    }

    // Remove empty legacy directories (never recursive, never removes non-empty worktrees or .harness,
    // and never runs while a unit has unfinished crash-recovery pending state).
    if (!budgetExceeded && state.pendingUnits.length === 0) {
      try {
        repoReport.removedEmptyDirs = cleanupEmptyLegacyDirs(canonRepo);
      } catch (err) {
        const record: MigrationErrorRecord = {
          repoRoot: canonRepo,
          message: err instanceof Error ? err.message : String(err),
        };
        repoReport.errors.push(record);
        allErrors.push(record);
      }
    }
  }

  totals.remaining = allRemaining.length;
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
