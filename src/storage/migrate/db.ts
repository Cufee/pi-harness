import type { Database } from "bun:sqlite";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { RunRecord, TaskStatus } from "../../control-plane/db.js";
import { directorTaskRunOwner, isDirectorTaskContainer } from "../../control-plane/ids.js";
import type { GoalStatus } from "../../goals/engine.js";
import type { StorageUnitKind } from "../data-dir/units.js";
import type { StoragePaths } from "../paths.js";
import {
  BudgetExceededError,
  canonicalPath,
  isRealDirUnderRoot,
  LEGACY_HARNESS_DIR,
  readMigrationState,
} from "./fs.js";

/** Terminal GoalStatus values from `src/goals/engine.ts`. */
export const TERMINAL_GOAL_STATUSES: ReadonlySet<string> = new Set<GoalStatus>(["achieved", "cancelled"]);

/** Terminal RunRecord["status"] values from `src/control-plane/db.ts`. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set<RunRecord["status"]>([
  "completed",
  "failed",
  "stopped",
]);

/** Terminal TaskStatus values from `src/control-plane/orchestrator.ts` (`TERMINAL_TASK_STATUSES`). */
export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set<TaskStatus>([
  "completed",
  "returned_for_rescope",
  "cancelled",
  "failed",
  "blocked",
]);

export interface GoalRowInfo {
  id: string;
  status: string;
  linkedRunId: string | null;
  chatSessionId: string | null;
  repoRoot: string | null;
}

export interface RunRowInfo {
  id: string;
  status: string;
  chatSessionId: string | null;
  repoRoot: string | null;
}

export interface TaskRowInfo {
  id: string;
  runId: string;
  status: string;
}

export interface ParsedLegacyArtifactRow {
  id: string;
  runId: string | null;
  taskId: string | null;
  path: string;
  subdir: "artifacts" | "goals" | "notes";
  subParts: string[];
}

export interface RowRewriteMemberSpec {
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  destinationPath: string;
  /**
   * When present (e.g. after a copy or merge with legacy leftovers under A7/D7), restricts row rewrites
   * for directory units to only those POSIX relative subpaths whose files moved / have a verified copy
   * without a changed legacy leftover; rows for leftover files remain on their legacy path.
   */
  allowedRelPaths?: ReadonlySet<string>;
}

export interface FlatArtifactOwnerRef {
  runId: string | null;
  taskId: string | null;
  /** True when recorded from an ambiguous relative row (used for live-owner deferral only, never row rewrites or chat assignment). */
  ambiguous?: boolean;
}

/**
 * Per-pass index of historical run-to-goal links from `events` and `chat_turns.event_json`.
 * Built once per pass so `findGoalsByLinkedRun` never re-scans `events` or `chat_turns` per run.
 */
export interface HistoricalRunGoalIndex {
  byRunId: Map<string, string[]>;
  /** Unexpected DB read error encountered while building the index (fail closed on lookup). */
  error?: Error;
}

export interface RawArtifactJoinRow {
  id: string;
  runId: string | null;
  taskId: string | null;
  path: string;
  runRepo: string | null;
}

/**
 * Per-pass snapshot of `artifacts` rows scanned once via `stmt.iterate()` and bucketed by canonical repo root.
 * Avoids re-querying `artifacts` for every repository in the same migration pass.
 */
export interface PassArtifactRowSnapshot {
  hasArtifactsTable: boolean;
  /** Rows associated with a specific canonical repo root (via `runs.repo_root` or absolute `/.harness/` prefix). */
  rowsByCanonRepo: Map<string, RawArtifactJoinRow[]>;
  /** Relative rows with no `runs.repo_root` (checked against each repo). */
  unownedRelativeRows: RawArtifactJoinRow[];
  /** Non-`.harness` absolute rows without `runs.repo_root` (e.g. already-migrated data-dir paths). */
  otherAbsoluteRows: RawArtifactJoinRow[];
  /** Shared canonical-path cache built while bucketing. */
  canonCache: Map<string, string>;
}

/**
 * Per-repo index of `artifacts` rows built once per pass and reused across discovery,
 * flat-artifact ownership checks, pending-rewrite counts, and row rewrites.
 */
export interface RepoArtifactRowIndex {
  canonRepo: string;
  hasArtifactsTable: boolean;
  /** All legacy `.harness/{artifacts,goals,notes}/...` rows belonging to `canonRepo`. */
  legacyRows: ParsedLegacyArtifactRow[];
  /** Lookup buckets for O(1) per-member matching: `goal:<id>`, `run:<id>`, `bucket_task:<runId>:<taskId>`, `flat_artifact:<file>`, `note:<rel>`. */
  legacyByMemberKey: Map<string, ParsedLegacyArtifactRow[]>;
  /** Indexed `(runId, taskId)` owners for flat artifacts (matching both legacy and data-dir paths). */
  flatOwnersByFileName: Map<string, FlatArtifactOwnerRef[]>;
  /** Relative legacy rows whose run gave no repo root and which could belong to another known repo (skipped, never rewritten). */
  ambiguousRows: ParsedLegacyArtifactRow[];
  /** Lookup buckets for O(1) ambiguous-row counting per member. */
  ambiguousByMemberKey: Map<string, ParsedLegacyArtifactRow[]>;
}

/** True if `tableName` exists in SQLite (`sqlite_master`). Read-only; unexpected DB errors propagate. */
export function hasTable(sqlite: Database, tableName: string): boolean {
  const row = sqlite
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  return Boolean(row);
}

/** Returns column names for `tableName`, or an empty set if missing. Read-only; unexpected DB errors propagate. */
export function getTableColumns(sqlite: Database, tableName: string): Set<string> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName) || !hasTable(sqlite, tableName)) {
    return new Set();
  }
  const cols = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

export type KnownRepoRootsProvider = ReadonlySet<string> | (() => ReadonlySet<string> | null);

/**
 * Lists every distinct canonical repo root known to SQLite (`runs`, `goals`, `projects`, `chat_sessions`)
 * unioned with any explicit `extraRepoRoots`. Read-only; missing optional tables are ignored and DB errors propagate.
 */
export function listAllKnownRepoRoots(
  sqlite: Database,
  extraRepoRoots?: readonly string[],
  checkBudget?: () => void,
): Set<string> {
  const known = new Set<string>();
  const record = (raw: unknown) => {
    checkBudget?.();
    if (typeof raw !== "string" || raw.length === 0) return;
    known.add(canonicalPath(raw));
  };

  if (extraRepoRoots) {
    for (const root of extraRepoRoots) record(root);
  }

  checkBudget?.();
  if (getTableColumns(sqlite, "runs").has("repo_root")) {
    const rows = sqlite.prepare("SELECT DISTINCT repo_root FROM runs WHERE repo_root IS NOT NULL").all() as Array<{
      repo_root: unknown;
    }>;
    for (const r of rows) record(r.repo_root);
  }

  checkBudget?.();
  if (getTableColumns(sqlite, "goals").has("repo_root")) {
    const rows = sqlite.prepare("SELECT DISTINCT repo_root FROM goals WHERE repo_root IS NOT NULL").all() as Array<{
      repo_root: unknown;
    }>;
    for (const r of rows) record(r.repo_root);
  }

  checkBudget?.();
  if (getTableColumns(sqlite, "projects").has("root_path")) {
    const rows = sqlite.prepare("SELECT DISTINCT root_path FROM projects WHERE root_path IS NOT NULL").all() as Array<{
      root_path: unknown;
    }>;
    for (const r of rows) record(r.root_path);
  }

  checkBudget?.();
  if (getTableColumns(sqlite, "chat_sessions").has("repo_root")) {
    const rows = sqlite
      .prepare("SELECT DISTINCT repo_root FROM chat_sessions WHERE repo_root IS NOT NULL")
      .all() as Array<{
      repo_root: unknown;
    }>;
    for (const r of rows) record(r.repo_root);
  }

  return known;
}

/**
 * Discovers distinct canonical repo roots from `runs`, `goals`, `projects`, and `chat_sessions` that still
 * have a `.harness` directory (or pending crash-recovery state / unrewritten legacy artifact rows), or returns
 * the deduplicated canonicalized `optsRepoRoots` when supplied.
 * Safe on read-only DBs and standalone/older DBs missing optional tables (`goals`, `projects`, `chat_sessions`) or columns.
 */
export function discoverRepoRoots(
  sqlite: Database,
  optsRepoRoots?: readonly string[],
  storage?: StoragePaths,
  checkBudget?: () => void,
  knownRepoRoots?: KnownRepoRootsProvider,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  let cachedKnownRepos: ReadonlySet<string> | null | undefined =
    knownRepoRoots && typeof knownRepoRoots !== "function" ? knownRepoRoots : undefined;
  const getKnownRepos = (): ReadonlySet<string> | null => {
    if (cachedKnownRepos !== undefined) return cachedKnownRepos;
    if (typeof knownRepoRoots === "function") {
      cachedKnownRepos = knownRepoRoots();
      return cachedKnownRepos;
    }
    try {
      cachedKnownRepos = listAllKnownRepoRoots(sqlite, optsRepoRoots, checkBudget);
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      cachedKnownRepos = null;
    }
    return cachedKnownRepos;
  };
  const hasPendingWork = (canon: string): boolean => {
    checkBudget?.();
    if (isRealDirUnderRoot(canon, [LEGACY_HARNESS_DIR])) return true;
    if (storage && storage.layout === "data-dir") {
      try {
        if (readMigrationState(storage.projectDir(canon)).pendingUnits.length > 0) return true;
      } catch {
        // Ignore unreadable state dir.
      }
      if (hasAnyLegacyArtifactRowForRepo(sqlite, canon, checkBudget, getKnownRepos)) return true;
    }
    return false;
  };
  const add = (raw: string, requireHarnessOrPending: boolean) => {
    checkBudget?.();
    if (raw.length === 0) return;
    const canon = canonicalPath(raw);
    if (seen.has(canon)) return;
    if (requireHarnessOrPending && !hasPendingWork(canon)) return;
    seen.add(canon);
    out.push(canon);
  };

  if (optsRepoRoots !== undefined) {
    for (const root of optsRepoRoots) {
      add(root, false);
    }
    return out;
  }

  checkBudget?.();
  const runCols = getTableColumns(sqlite, "runs");
  if (runCols.has("repo_root")) {
    const rows = sqlite.prepare("SELECT DISTINCT repo_root FROM runs WHERE repo_root IS NOT NULL").all() as Array<{
      repo_root: string;
    }>;
    for (const r of rows) {
      if (typeof r.repo_root === "string") add(r.repo_root, true);
    }
  }

  checkBudget?.();
  const goalCols = getTableColumns(sqlite, "goals");
  if (goalCols.has("repo_root")) {
    const rows = sqlite.prepare("SELECT DISTINCT repo_root FROM goals WHERE repo_root IS NOT NULL").all() as Array<{
      repo_root: string;
    }>;
    for (const r of rows) {
      if (typeof r.repo_root === "string") add(r.repo_root, true);
    }
  }

  checkBudget?.();
  const projectCols = getTableColumns(sqlite, "projects");
  if (projectCols.has("root_path")) {
    const rows = sqlite.prepare("SELECT DISTINCT root_path FROM projects WHERE root_path IS NOT NULL").all() as Array<{
      root_path: string;
    }>;
    for (const r of rows) {
      if (typeof r.root_path === "string") add(r.root_path, true);
    }
  }

  checkBudget?.();
  const chatCols = getTableColumns(sqlite, "chat_sessions");
  if (chatCols.has("repo_root")) {
    const rows = sqlite
      .prepare("SELECT DISTINCT repo_root FROM chat_sessions WHERE repo_root IS NOT NULL")
      .all() as Array<{
      repo_root: string;
    }>;
    for (const r of rows) {
      if (typeof r.repo_root === "string") add(r.repo_root, true);
    }
  }

  return out;
}

/** Lists all registered worktree paths from `worktrees` (read-only; missing table returns `[]`, DB errors propagate). */
export function listRegisteredWorktreePaths(sqlite: Database, checkBudget?: () => void): string[] {
  const cols = getTableColumns(sqlite, "worktrees");
  if (!cols.has("path")) return [];
  const stmt = sqlite.prepare("SELECT DISTINCT path FROM worktrees WHERE path IS NOT NULL");
  const out: string[] = [];
  let idx = 0;
  for (const r of stmt.iterate() as Iterable<{ path: unknown }>) {
    if ((idx++ & 63) === 63) checkBudget?.();
    if (typeof r.path === "string" && r.path.length > 0) {
      out.push(r.path);
    }
  }
  return out;
}

/** Reads a goal row by ID using SELECT only, guarding missing tables and columns. Unexpected DB errors propagate. */
export function readGoalRow(sqlite: Database, goalId: string): GoalRowInfo | null {
  const cols = getTableColumns(sqlite, "goals");
  if (!cols.has("id") || !cols.has("status")) return null;
  const selectLinked = cols.has("linked_run_id") ? "linked_run_id" : "NULL AS linked_run_id";
  const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
  const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
  const row = sqlite
    .prepare(`SELECT id, status, ${selectLinked}, ${selectChat}, ${selectRepo} FROM goals WHERE id = ? LIMIT 1`)
    .get(goalId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status),
    linkedRunId: row.linked_run_id ? String(row.linked_run_id) : null,
    chatSessionId: row.chat_session_id ? String(row.chat_session_id) : null,
    repoRoot: row.repo_root ? String(row.repo_root) : null,
  };
}

/**
 * Scans `events` and `chat_turns.event_json` ONCE per pass to index every historical run-to-goal link.
 * Budget checks run periodically during iteration. Unexpected DB errors are captured on the returned index
 * so non-bucket run lookups fail closed while notes remain unaffected.
 */
export function buildHistoricalRunGoalIndex(sqlite: Database, checkBudget?: () => void): HistoricalRunGoalIndex {
  const sets = new Map<string, Set<string>>();
  const addLink = (runId: string, goalId: string) => {
    if (!runId || !goalId || isDirectorTaskContainer(runId)) return;
    let set = sets.get(runId);
    if (!set) {
      set = new Set<string>();
      sets.set(runId, set);
    }
    set.add(goalId);
  };

  try {
    const eventCols = getTableColumns(sqlite, "events");
    if (eventCols.has("run_id") && eventCols.has("type") && eventCols.has("payload_json")) {
      const stmt = sqlite.prepare(
        "SELECT run_id, payload_json FROM events WHERE run_id IS NOT NULL AND type LIKE 'goal.%'",
      );
      let idx = 0;
      for (const ev of stmt.iterate() as Iterable<{ run_id: unknown; payload_json: unknown }>) {
        if ((idx++ & 63) === 63) checkBudget?.();
        if (typeof ev.run_id !== "string" || typeof ev.payload_json !== "string") continue;
        try {
          const parsed = JSON.parse(ev.payload_json) as { goalId?: unknown } | null;
          if (parsed && typeof parsed.goalId === "string" && parsed.goalId.trim()) {
            addLink(ev.run_id, parsed.goalId.trim());
          }
        } catch {
          // Ignore malformed JSON payloads.
        }
      }
    }

    const turnCols = getTableColumns(sqlite, "chat_turns");
    if (turnCols.has("event_json")) {
      const stmt = sqlite.prepare(
        "SELECT event_json FROM chat_turns WHERE event_json IS NOT NULL AND instr(event_json, 'goal.') > 0",
      );
      let idx = 0;
      for (const turn of stmt.iterate() as Iterable<{ event_json: unknown }>) {
        if ((idx++ & 63) === 63) checkBudget?.();
        if (typeof turn.event_json !== "string") continue;
        try {
          const parsed = JSON.parse(turn.event_json) as { kind?: unknown; goalId?: unknown; runId?: unknown } | null;
          if (
            parsed &&
            typeof parsed.kind === "string" &&
            parsed.kind.startsWith("goal.") &&
            typeof parsed.runId === "string" &&
            parsed.runId.trim() &&
            typeof parsed.goalId === "string" &&
            parsed.goalId.trim()
          ) {
            addLink(parsed.runId.trim(), parsed.goalId.trim());
          }
        } catch {
          // Ignore malformed JSON payloads.
        }
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    return {
      byRunId: new Map(),
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  const byRunId = new Map<string, string[]>();
  for (const [runId, goalIds] of sets) {
    byRunId.set(runId, [...goalIds].sort());
  }
  return { byRunId };
}

/**
 * Finds all goals linked to `runId`, both currently (`goals.linked_run_id = runId`) and historically
 * (durable `goal.*` rows in `events` for `runId` and structured `goal.*` control events in `chat_turns.event_json`).
 * When `historicalIndex` is provided, historical links are read in O(1) without re-querying `events`/`chat_turns`.
 * Read-only; guards missing optional tables/columns with `getTableColumns` and lets unexpected DB errors propagate.
 */
export function findGoalsByLinkedRun(
  sqlite: Database,
  runId: string,
  historicalIndex?: HistoricalRunGoalIndex,
): GoalRowInfo[] {
  const cols = getTableColumns(sqlite, "goals");
  if (!cols.has("id") || !cols.has("status")) return [];
  const selectLinked = cols.has("linked_run_id") ? "linked_run_id" : "NULL AS linked_run_id";
  const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
  const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
  const orderBy = cols.has("updated_at") ? "ORDER BY updated_at DESC, id ASC" : "ORDER BY id ASC";

  const out: GoalRowInfo[] = [];
  const seenIds = new Set<string>();

  if (cols.has("linked_run_id")) {
    const rows = sqlite
      .prepare(
        `SELECT id, status, ${selectLinked}, ${selectChat}, ${selectRepo} FROM goals WHERE linked_run_id = ? ${orderBy}`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const id = String(row.id);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      out.push({
        id,
        status: String(row.status),
        linkedRunId: row.linked_run_id ? String(row.linked_run_id) : null,
        chatSessionId: row.chat_session_id ? String(row.chat_session_id) : null,
        repoRoot: row.repo_root ? String(row.repo_root) : null,
      });
    }
  }

  // Historical links apply to regular runs (Director task buckets host review/helper tasks across many goals).
  if (!isDirectorTaskContainer(runId)) {
    let sortedHistorical: string[];
    if (historicalIndex) {
      if (historicalIndex.error) {
        throw historicalIndex.error;
      }
      sortedHistorical = (historicalIndex.byRunId.get(runId) ?? []).filter((id) => !seenIds.has(id));
    } else {
      const historicalGoalIds = new Set<string>();

      // Source 1: durable goal.* events recorded on this run in `events`.
      const eventCols = getTableColumns(sqlite, "events");
      if (eventCols.has("run_id") && eventCols.has("type") && eventCols.has("payload_json")) {
        const eventRows = sqlite
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type LIKE 'goal.%'")
          .all(runId) as Array<{ payload_json: unknown }>;
        for (const ev of eventRows) {
          if (typeof ev.payload_json !== "string") continue;
          try {
            const parsed = JSON.parse(ev.payload_json) as { goalId?: unknown } | null;
            if (parsed && typeof parsed.goalId === "string" && parsed.goalId.trim()) {
              historicalGoalIds.add(parsed.goalId.trim());
            }
          } catch {
            // Ignore malformed JSON payloads.
          }
        }
      }

      // Source 2: durable structured ChatControlEvents in `chat_turns.event_json`.
      const turnCols = getTableColumns(sqlite, "chat_turns");
      if (turnCols.has("event_json")) {
        const turnRows = sqlite
          .prepare("SELECT event_json FROM chat_turns WHERE event_json IS NOT NULL AND instr(event_json, ?) > 0")
          .all(runId) as Array<{ event_json: unknown }>;
        for (const turn of turnRows) {
          if (typeof turn.event_json !== "string") continue;
          try {
            const parsed = JSON.parse(turn.event_json) as { kind?: unknown; goalId?: unknown; runId?: unknown } | null;
            if (
              parsed &&
              typeof parsed.kind === "string" &&
              parsed.kind.startsWith("goal.") &&
              parsed.runId === runId &&
              typeof parsed.goalId === "string" &&
              parsed.goalId.trim()
            ) {
              historicalGoalIds.add(parsed.goalId.trim());
            }
          } catch {
            // Ignore malformed JSON payloads.
          }
        }
      }

      sortedHistorical = [...historicalGoalIds].filter((id) => !seenIds.has(id)).sort();
    }

    for (const gid of sortedHistorical) {
      const goalRow = readGoalRow(sqlite, gid);
      if (goalRow) {
        seenIds.add(goalRow.id);
        out.push(goalRow);
      }
    }
  }

  return out;
}

/** Reads a run row by ID using SELECT only, guarding missing tables and columns. Unexpected DB errors propagate. */
export function readRunRow(sqlite: Database, runId: string): RunRowInfo | null {
  const cols = getTableColumns(sqlite, "runs");
  if (!cols.has("id") || !cols.has("status")) return null;
  const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
  const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
  const row = sqlite
    .prepare(`SELECT id, status, ${selectChat}, ${selectRepo} FROM runs WHERE id = ? LIMIT 1`)
    .get(runId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    status: String(row.status),
    chatSessionId: row.chat_session_id ? String(row.chat_session_id) : null,
    repoRoot: row.repo_root ? String(row.repo_root) : null,
  };
}

/** Lists tasks belonging to `runId` using SELECT only. Unexpected DB errors propagate. */
export function listTasksForRun(sqlite: Database, runId: string): TaskRowInfo[] {
  const cols = getTableColumns(sqlite, "tasks");
  if (!cols.has("id") || !cols.has("run_id") || !cols.has("status")) return [];
  const rows = sqlite
    .prepare("SELECT id, run_id, status FROM tasks WHERE run_id = ? ORDER BY id ASC")
    .all(runId) as Array<{ id: string; run_id: string; status: string }>;
  return rows.map((r) => ({ id: String(r.id), runId: String(r.run_id), status: String(r.status) }));
}

/** Reads one task row by ID using SELECT only. Unexpected DB errors propagate. */
export function readTaskRow(sqlite: Database, taskId: string): TaskRowInfo | null {
  const cols = getTableColumns(sqlite, "tasks");
  if (!cols.has("id") || !cols.has("run_id") || !cols.has("status")) return null;
  const row = sqlite
    .prepare("SELECT id, run_id, status FROM tasks WHERE id = ? LIMIT 1")
    .get(taskId) as { id: string; run_id: string; status: string } | undefined;
  if (!row) return null;
  return { id: String(row.id), runId: String(row.run_id), status: String(row.status) };
}

/**
 * Pass-level read-only index of `goals`, `runs`, `tasks`, and `chat_sessions`, loaded lazily once per table per pass.
 * Avoids repeated per-unit and per-flat-file DB scans during discovery and ownership evaluation while failing closed on
 * unexpected DB errors.
 */
export interface PassOwnershipIndex {
  getGoal: (goalId: string) => GoalRowInfo | null;
  getGoalsByLinkedRun: (runId: string) => GoalRowInfo[];
  getRun: (runId: string) => RunRowInfo | null;
  getTask: (taskId: string) => TaskRowInfo | null;
  getLiveTasksForRun: (runId: string) => readonly TaskRowInfo[];
  deriveRunChatSessionId: (runId: string) => string | null;
}

interface PassGoalsTableIndex {
  byId: Map<string, GoalRowInfo>;
  byLinkedRunId: Map<string, GoalRowInfo[]>;
  error?: Error;
}

interface PassRunsTableIndex {
  byId: Map<string, RunRowInfo>;
  error?: Error;
}

interface PassTasksTableIndex {
  byId: Map<string, TaskRowInfo>;
  liveByRunId: Map<string, TaskRowInfo[]>;
  error?: Error;
}

interface PassChatSessionsTableIndex {
  ids: Set<string>;
  error?: Error;
}

export function createPassOwnershipIndex(
  sqlite: Database,
  getHistoricalIndex: () => HistoricalRunGoalIndex,
  checkBudget?: () => void,
): PassOwnershipIndex {
  let goalsCache: PassGoalsTableIndex | undefined;
  let runsCache: PassRunsTableIndex | undefined;
  let tasksCache: PassTasksTableIndex | undefined;
  let chatSessionsCache: PassChatSessionsTableIndex | undefined;

  const loadGoals = (): PassGoalsTableIndex => {
    if (goalsCache) return goalsCache;
    const byId = new Map<string, GoalRowInfo>();
    const byLinkedRunId = new Map<string, GoalRowInfo[]>();
    try {
      const cols = getTableColumns(sqlite, "goals");
      if (cols.has("id") && cols.has("status")) {
        const selectLinked = cols.has("linked_run_id") ? "linked_run_id" : "NULL AS linked_run_id";
        const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
        const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
        const orderBy = cols.has("updated_at") ? "ORDER BY updated_at DESC, id ASC" : "ORDER BY id ASC";
        const stmt = sqlite.prepare(
          `SELECT id, status, ${selectLinked}, ${selectChat}, ${selectRepo} FROM goals ${orderBy}`,
        );
        let idx = 0;
        for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
          if ((idx++ & 127) === 127) checkBudget?.();
          const info: GoalRowInfo = {
            id: String(row.id),
            status: String(row.status),
            linkedRunId: row.linked_run_id ? String(row.linked_run_id) : null,
            chatSessionId: row.chat_session_id ? String(row.chat_session_id) : null,
            repoRoot: row.repo_root ? String(row.repo_root) : null,
          };
          byId.set(info.id, info);
          if (info.linkedRunId) {
            let list = byLinkedRunId.get(info.linkedRunId);
            if (!list) {
              list = [];
              byLinkedRunId.set(info.linkedRunId, list);
            }
            list.push(info);
          }
        }
      }
      goalsCache = { byId, byLinkedRunId };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      goalsCache = {
        byId: new Map(),
        byLinkedRunId: new Map(),
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    return goalsCache;
  };

  const loadRuns = (): PassRunsTableIndex => {
    if (runsCache) return runsCache;
    const byId = new Map<string, RunRowInfo>();
    try {
      const cols = getTableColumns(sqlite, "runs");
      if (cols.has("id") && cols.has("status")) {
        const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
        const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
        const stmt = sqlite.prepare(`SELECT id, status, ${selectChat}, ${selectRepo} FROM runs`);
        let idx = 0;
        for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
          if ((idx++ & 127) === 127) checkBudget?.();
          const info: RunRowInfo = {
            id: String(row.id),
            status: String(row.status),
            chatSessionId: row.chat_session_id ? String(row.chat_session_id) : null,
            repoRoot: row.repo_root ? String(row.repo_root) : null,
          };
          byId.set(info.id, info);
        }
      }
      runsCache = { byId };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      runsCache = {
        byId: new Map(),
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    return runsCache;
  };

  const loadTasks = (): PassTasksTableIndex => {
    if (tasksCache) return tasksCache;
    const byId = new Map<string, TaskRowInfo>();
    const liveByRunId = new Map<string, TaskRowInfo[]>();
    try {
      const cols = getTableColumns(sqlite, "tasks");
      if (cols.has("id") && cols.has("run_id") && cols.has("status")) {
        const stmt = sqlite.prepare("SELECT id, run_id, status FROM tasks");
        let idx = 0;
        for (const row of stmt.iterate() as Iterable<{ id: string; run_id: string; status: string }>) {
          if ((idx++ & 255) === 255) checkBudget?.();
          const info: TaskRowInfo = {
            id: String(row.id),
            runId: String(row.run_id),
            status: String(row.status),
          };
          byId.set(info.id, info);
          if (!TERMINAL_TASK_STATUSES.has(info.status)) {
            let list = liveByRunId.get(info.runId);
            if (!list) {
              list = [];
              liveByRunId.set(info.runId, list);
            }
            list.push(info);
          }
        }
        for (const list of liveByRunId.values()) {
          if (list.length > 1) {
            list.sort((a, b) => a.id.localeCompare(b.id));
          }
        }
      }
      tasksCache = { byId, liveByRunId };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      tasksCache = {
        byId: new Map(),
        liveByRunId: new Map(),
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    return tasksCache;
  };

  const loadChatSessions = (): PassChatSessionsTableIndex => {
    if (chatSessionsCache) return chatSessionsCache;
    const ids = new Set<string>();
    try {
      const cols = getTableColumns(sqlite, "chat_sessions");
      if (cols.has("id")) {
        const stmt = sqlite.prepare("SELECT id FROM chat_sessions");
        let idx = 0;
        for (const row of stmt.iterate() as Iterable<{ id: unknown }>) {
          if ((idx++ & 127) === 127) checkBudget?.();
          if (row.id) ids.add(String(row.id));
        }
      }
      chatSessionsCache = { ids };
    } catch (err) {
      if (err instanceof BudgetExceededError) throw err;
      chatSessionsCache = {
        ids: new Set(),
        error: err instanceof Error ? err : new Error(String(err)),
      };
    }
    return chatSessionsCache;
  };

  const getGoal = (goalId: string): GoalRowInfo | null => {
    const idx = loadGoals();
    if (idx.error) throw idx.error;
    return idx.byId.get(goalId) ?? null;
  };

  const getGoalsByLinkedRun = (runId: string): GoalRowInfo[] => {
    const gIdx = loadGoals();
    if (gIdx.error) throw gIdx.error;
    const direct = gIdx.byLinkedRunId.get(runId);
    const out: GoalRowInfo[] = [];
    const seenIds = new Set<string>();
    if (direct) {
      for (const g of direct) {
        if (seenIds.has(g.id)) continue;
        seenIds.add(g.id);
        out.push(g);
      }
    }
    if (!isDirectorTaskContainer(runId)) {
      const hist = getHistoricalIndex();
      if (hist.error) throw hist.error;
      const histIds = hist.byRunId.get(runId);
      if (histIds) {
        for (const gid of histIds) {
          if (seenIds.has(gid)) continue;
          const g = gIdx.byId.get(gid);
          if (g) {
            seenIds.add(g.id);
            out.push(g);
          }
        }
      }
    }
    return out;
  };

  const getRun = (runId: string): RunRowInfo | null => {
    const idx = loadRuns();
    if (idx.error) throw idx.error;
    return idx.byId.get(runId) ?? null;
  };

  const getTask = (taskId: string): TaskRowInfo | null => {
    const idx = loadTasks();
    if (idx.error) throw idx.error;
    return idx.byId.get(taskId) ?? null;
  };

  const getLiveTasksForRun = (runId: string): readonly TaskRowInfo[] => {
    const idx = loadTasks();
    if (idx.error) throw idx.error;
    return idx.liveByRunId.get(runId) ?? [];
  };

  const deriveRunChatSessionId = (runId: string): string | null => {
    const run = getRun(runId);
    if (run?.chatSessionId) return run.chatSessionId;

    if (isDirectorTaskContainer(runId)) {
      const owner = directorTaskRunOwner(runId);
      if (owner) {
        const chats = loadChatSessions();
        if (chats.error) throw chats.error;
        if (chats.ids.has(owner)) return owner;
        const ownerGoal = getGoal(owner);
        if (ownerGoal?.chatSessionId) return ownerGoal.chatSessionId;
      }
    }

    const linkedGoals = getGoalsByLinkedRun(runId);
    for (const goal of linkedGoals) {
      if (goal.chatSessionId) return goal.chatSessionId;
    }
    return null;
  };

  return {
    getGoal,
    getGoalsByLinkedRun,
    getRun,
    getTask,
    getLiveTasksForRun,
    deriveRunChatSessionId,
  };
}

/**
 * Pure read-only derivation of a run's owning chat session ID (never writes to SQLite).
 * Mirrors `ControlPlaneDb.getRunChatSessionId` using SELECTs only. Unexpected DB errors propagate.
 */
export function deriveRunChatSessionIdReadOnly(
  sqlite: Database,
  runId: string,
  historicalIndex?: HistoricalRunGoalIndex,
): string | null {
  const run = readRunRow(sqlite, runId);
  if (run?.chatSessionId) return run.chatSessionId;

  if (isDirectorTaskContainer(runId)) {
    const owner = directorTaskRunOwner(runId);
    if (owner) {
      const chatCols = getTableColumns(sqlite, "chat_sessions");
      if (chatCols.has("id")) {
        const chatRow = sqlite
          .prepare("SELECT id FROM chat_sessions WHERE id = ? LIMIT 1")
          .get(owner) as { id?: string } | undefined;
        if (chatRow?.id) return String(chatRow.id);
      }
      const goalCols = getTableColumns(sqlite, "goals");
      if (goalCols.has("id") && goalCols.has("chat_session_id")) {
        const goalRow = sqlite
          .prepare("SELECT chat_session_id FROM goals WHERE id = ? AND chat_session_id IS NOT NULL LIMIT 1")
          .get(owner) as { chat_session_id?: string | null } | undefined;
        if (goalRow?.chat_session_id) return String(goalRow.chat_session_id);
      }
    }
  }

  const linkedGoals = findGoalsByLinkedRun(sqlite, runId, historicalIndex);
  for (const goal of linkedGoals) {
    if (goal.chatSessionId) return goal.chatSessionId;
  }
  return null;
}

const LEGACY_SUBDIRS = new Set(["artifacts", "goals", "notes"]);

/**
 * Parses an `artifacts.path` value if it is a legacy `.harness/{artifacts,goals,notes}/...` path
 * belonging to `canonRepo` (under raw, canonical, symlinked repo root spellings, or workspace-relative).
 * Keeps literal POSIX names: never trims whitespace and never rewrites backslashes into path separators.
 */
export function parseLegacyPathForRepo(
  canonRepo: string,
  rawPath: string,
  runRepoRoot: string | null,
  canonCache?: Map<string, string>,
): { subdir: "artifacts" | "goals" | "notes"; subParts: string[]; isUnownedRelative: boolean } | null {
  if (!rawPath || rawPath.includes("\0")) return null;

  const getCanon = (p: string): string => {
    if (!canonCache) return canonicalPath(p);
    let cached = canonCache.get(p);
    if (cached === undefined) {
      cached = canonicalPath(p);
      canonCache.set(p, cached);
    }
    return cached;
  };

  if (!isAbsolute(rawPath)) {
    const rawSegments = rawPath.split("/");
    if (rawSegments.some((p) => p === "..")) return null;
    const parts = rawSegments.filter((s) => s.length > 0 && s !== ".");
    if (parts.length < 3 || parts[0] !== LEGACY_HARNESS_DIR || !LEGACY_SUBDIRS.has(parts[1]!)) return null;
    if (runRepoRoot !== null && getCanon(runRepoRoot) !== canonRepo) return null;
    return {
      subdir: parts[1] as "artifacts" | "goals" | "notes",
      subParts: parts.slice(2),
      isUnownedRelative: runRepoRoot === null,
    };
  }

  const abs = resolve(rawPath);
  const marker = `${sep}${LEGACY_HARNESS_DIR}${sep}`;
  for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
    const prefix = abs.slice(0, idx) || sep;
    let matchesRepo = prefix === canonRepo;
    if (!matchesRepo) {
      try {
        matchesRepo = getCanon(prefix) === canonRepo;
      } catch {
        matchesRepo = false;
      }
    }
    if (!matchesRepo && runRepoRoot !== null) {
      if (resolve(runRepoRoot) === resolve(prefix) && getCanon(runRepoRoot) === canonRepo) {
        matchesRepo = true;
      }
    }
    if (!matchesRepo) continue;

    const rest = abs.slice(idx + marker.length);
    const parts = rest.split(sep).filter((s) => s.length > 0 && s !== ".");
    if (parts.length < 2 || !LEGACY_SUBDIRS.has(parts[0]!)) return null;
    if (parts.some((p) => p === "..")) return null;
    return {
      subdir: parts[0] as "artifacts" | "goals" | "notes",
      subParts: parts.slice(1),
      isUnownedRelative: false,
    };
  }

  return null;
}

interface RelativeOwnerCaches {
  canonCache: Map<string, string>;
  goalRepoCache: Map<string, string | null>;
  chatRepoCache: Map<string, string | null>;
  hasChatRepoCol: boolean | null;
}

function createRelativeOwnerCaches(canonCache: Map<string, string>): RelativeOwnerCaches {
  return {
    canonCache,
    goalRepoCache: new Map(),
    chatRepoCache: new Map(),
    hasChatRepoCol: null,
  };
}

function getCanonCached(p: string, cache: Map<string, string>): string {
  let cached = cache.get(p);
  if (cached === undefined) {
    cached = canonicalPath(p);
    cache.set(p, cached);
  }
  return cached;
}

function lookupChatRepoRoot(sqlite: Database, chatId: string, caches: RelativeOwnerCaches): string | null {
  if (caches.chatRepoCache.has(chatId)) return caches.chatRepoCache.get(chatId)!;
  if (caches.hasChatRepoCol === null) {
    const cols = getTableColumns(sqlite, "chat_sessions");
    caches.hasChatRepoCol = cols.has("id") && cols.has("repo_root");
  }
  if (!caches.hasChatRepoCol) {
    caches.chatRepoCache.set(chatId, null);
    return null;
  }
  const row = sqlite.prepare("SELECT repo_root FROM chat_sessions WHERE id = ? LIMIT 1").get(chatId) as
    | { repo_root: unknown }
    | null;
  const repo = typeof row?.repo_root === "string" && row.repo_root.length > 0 ? row.repo_root : null;
  caches.chatRepoCache.set(chatId, repo);
  return repo;
}

function lookupGoalRepoRoot(sqlite: Database, goalId: string, caches: RelativeOwnerCaches): string | null {
  if (caches.goalRepoCache.has(goalId)) return caches.goalRepoCache.get(goalId)!;
  const goal = readGoalRow(sqlite, goalId);
  const repo = goal?.repoRoot && goal.repoRoot.length > 0 ? goal.repoRoot : null;
  caches.goalRepoCache.set(goalId, repo);
  return repo;
}

/**
 * Classifies a relative legacy `artifacts.path` row whose `runs` join gave no `repo_root`.
 * Returns `"owned"` only when the row cannot belong to another repo, `"other"` when DB ownership proves
 * it belongs to a different repo, and `"ambiguous"` when another known repo exists and ownership is unknown.
 */
function classifyUnownedRelativeRow(
  sqlite: Database,
  canonRepo: string,
  parsed: { subdir: "artifacts" | "goals" | "notes"; subParts: string[] },
  getOtherRepoExists: () => boolean,
  caches: RelativeOwnerCaches,
): "owned" | "other" | "ambiguous" {
  // Check whether goals or chat_sessions deterministically pin this path's repo.
  try {
    if (parsed.subdir === "goals" && parsed.subParts[0]) {
      const goalRepo = lookupGoalRepoRoot(sqlite, parsed.subParts[0], caches);
      if (goalRepo) {
        return getCanonCached(goalRepo, caches.canonCache) === canonRepo ? "owned" : "other";
      }
    } else if (parsed.subdir === "artifacts" && parsed.subParts[0] && isDirectorTaskContainer(parsed.subParts[0])) {
      const ownerId = directorTaskRunOwner(parsed.subParts[0]);
      if (ownerId) {
        const chatRepo = lookupChatRepoRoot(sqlite, ownerId, caches);
        if (chatRepo) {
          return getCanonCached(chatRepo, caches.canonCache) === canonRepo ? "owned" : "other";
        }
        const goalRepo = lookupGoalRepoRoot(sqlite, ownerId, caches);
        if (goalRepo) {
          return getCanonCached(goalRepo, caches.canonCache) === canonRepo ? "owned" : "other";
        }
      }
    }
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    // Fail closed when ownership lookup hits an unexpected DB error.
    return "ambiguous";
  }
  return getOtherRepoExists() ? "ambiguous" : "owned";
}

function makeOtherRepoExistsChecker(
  sqlite: Database,
  canonRepo: string,
  knownRepoRoots?: KnownRepoRootsProvider,
  checkBudget?: () => void,
): () => boolean {
  let cached: boolean | undefined;
  return () => {
    if (cached !== undefined) return cached;
    let known: ReadonlySet<string> | null;
    if (knownRepoRoots === undefined) {
      try {
        known = listAllKnownRepoRoots(sqlite, [canonRepo], checkBudget);
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        known = null;
      }
    } else if (typeof knownRepoRoots === "function") {
      known = knownRepoRoots();
    } else {
      known = knownRepoRoots;
    }
    if (known === null) {
      // Fail closed: cannot rule out another repo.
      cached = true;
      return true;
    }
    for (const r of known) {
      if (r !== canonRepo) {
        cached = true;
        return true;
      }
    }
    cached = false;
    return false;
  };
}

function indexBucketKeysForParsedRow(row: ParsedLegacyArtifactRow): string[] {
  const keys: string[] = [];
  if (row.subdir === "goals" && row.subParts[0]) {
    keys.push(`goal:${row.subParts[0]}`);
  } else if (row.subdir === "artifacts" && row.subParts[0]) {
    const first = row.subParts[0];
    keys.push(`run:${first}`);
    if (row.subParts.length >= 2 && row.subParts[1]) {
      keys.push(`bucket_task:${first}:${row.subParts[1]}`);
    }
    if (row.subParts.length === 1) {
      keys.push(`flat_artifact:${first}`);
    }
  } else if (row.subdir === "notes" && row.subParts.length >= 1) {
    keys.push(`note:${row.subParts.join("/")}`);
  }
  return keys;
}

function memberSpecBucketKey(m: RowRewriteMemberSpec): string {
  return m.taskId !== undefined ? `${m.kind}:${m.id}:${m.taskId}` : `${m.kind}:${m.id}`;
}

/**
 * Scans `artifacts` (joined with `runs.repo_root` when present) ONCE per pass via `stmt.iterate()`
 * and buckets rows by canonical repo root, checking `checkBudget` periodically.
 */
export function buildPassArtifactRowSnapshot(
  sqlite: Database,
  checkBudget?: () => void,
): PassArtifactRowSnapshot {
  checkBudget?.();
  const rowsByCanonRepo = new Map<string, RawArtifactJoinRow[]>();
  const unownedRelativeRows: RawArtifactJoinRow[] = [];
  const otherAbsoluteRows: RawArtifactJoinRow[] = [];
  const canonCache = new Map<string, string>();

  const artCols = getTableColumns(sqlite, "artifacts");
  if (!artCols.has("id") || !artCols.has("path")) {
    return {
      hasArtifactsTable: false,
      rowsByCanonRepo,
      unownedRelativeRows,
      otherAbsoluteRows,
      canonCache,
    };
  }

  const hasRunId = artCols.has("run_id");
  const hasTaskId = artCols.has("task_id");
  const runCols = getTableColumns(sqlite, "runs");
  const joinRuns = hasRunId && runCols.has("id") && runCols.has("repo_root");

  const sql = joinRuns
    ? `SELECT a.id, a.run_id, ${hasTaskId ? "a.task_id" : "NULL AS task_id"}, a.path, r.repo_root
       FROM artifacts a
       LEFT JOIN runs r ON r.id = a.run_id`
    : `SELECT id, ${hasRunId ? "run_id" : "NULL AS run_id"}, ${hasTaskId ? "task_id" : "NULL AS task_id"}, path, NULL AS repo_root
       FROM artifacts`;

  const addToRepoBucket = (canonRepo: string, entry: RawArtifactJoinRow, addedRepos: Set<string>) => {
    if (addedRepos.has(canonRepo)) return;
    addedRepos.add(canonRepo);
    let bucket = rowsByCanonRepo.get(canonRepo);
    if (!bucket) {
      bucket = [];
      rowsByCanonRepo.set(canonRepo, bucket);
    }
    bucket.push(entry);
  };

  const marker = `${sep}${LEGACY_HARNESS_DIR}${sep}`;
  const stmt = sqlite.prepare(sql);
  let rowIdx = 0;
  for (const row of stmt.iterate() as Iterable<{
    id: string;
    run_id: string | null;
    task_id: string | null;
    path: unknown;
    repo_root: unknown;
  }>) {
    if ((rowIdx++ & 127) === 127) checkBudget?.();
    if (typeof row.path !== "string") continue;
    const runId = row.run_id ? String(row.run_id) : null;
    const taskId = row.task_id ? String(row.task_id) : null;
    const runRepo = typeof row.repo_root === "string" && row.repo_root.length > 0 ? row.repo_root : null;
    const entry: RawArtifactJoinRow = {
      id: String(row.id),
      runId,
      taskId,
      path: row.path,
      runRepo,
    };

    if (!isAbsolute(row.path)) {
      if (runRepo !== null) {
        try {
          const canon = getCanonCached(runRepo, canonCache);
          let bucket = rowsByCanonRepo.get(canon);
          if (!bucket) {
            bucket = [];
            rowsByCanonRepo.set(canon, bucket);
          }
          bucket.push(entry);
        } catch {
          // Ignore uncanonicalizable run repo root.
        }
      } else {
        unownedRelativeRows.push(entry);
      }
      continue;
    }

    const addedRepos = new Set<string>();
    const abs = resolve(row.path);
    let foundMarker = false;
    for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
      foundMarker = true;
      const prefix = abs.slice(0, idx) || sep;
      try {
        addToRepoBucket(getCanonCached(prefix, canonCache), entry, addedRepos);
      } catch {
        // Ignore uncanonicalizable prefix.
      }
    }
    if (runRepo !== null) {
      try {
        addToRepoBucket(getCanonCached(runRepo, canonCache), entry, addedRepos);
      } catch {
        // Ignore uncanonicalizable run repo root.
      }
    } else if (!foundMarker) {
      otherAbsoluteRows.push(entry);
    }
  }

  return {
    hasArtifactsTable: true,
    rowsByCanonRepo,
    unownedRelativeRows,
    otherAbsoluteRows,
    canonCache,
  };
}

/** Fast check for whether `artifacts` contains at least one unambiguous legacy row belonging to `canonRepo`. Read-only. */
export function hasAnyLegacyArtifactRowForRepo(
  sqlite: Database,
  canonRepo: string,
  checkBudget?: () => void,
  knownRepoRoots?: KnownRepoRootsProvider,
  passSnapshot?: PassArtifactRowSnapshot,
): boolean {
  checkBudget?.();
  if (passSnapshot) {
    if (!passSnapshot.hasArtifactsTable) return false;
    const canonCache = passSnapshot.canonCache;
    const ownerCaches = createRelativeOwnerCaches(canonCache);
    const getOtherExists = makeOtherRepoExistsChecker(sqlite, canonRepo, knownRepoRoots, checkBudget);
    const repoRows = passSnapshot.rowsByCanonRepo.get(canonRepo);
    const groups = repoRows ? [repoRows, passSnapshot.unownedRelativeRows] : [passSnapshot.unownedRelativeRows];
    let idx = 0;
    for (const group of groups) {
      for (let i = 0; i < group.length; i++) {
        if ((idx++ & 127) === 0) checkBudget?.();
        const row = group[i]!;
        const parsed = parseLegacyPathForRepo(canonRepo, row.path, row.runRepo, canonCache);
        if (!parsed) continue;
        if (parsed.isUnownedRelative) {
          if (classifyUnownedRelativeRow(sqlite, canonRepo, parsed, getOtherExists, ownerCaches) !== "owned") {
            continue;
          }
        }
        return true;
      }
    }
    return false;
  }

  const artCols = getTableColumns(sqlite, "artifacts");
  if (!artCols.has("id") || !artCols.has("path")) return false;

  const hasRunId = artCols.has("run_id");
  const runCols = getTableColumns(sqlite, "runs");
  const joinRuns = hasRunId && runCols.has("id") && runCols.has("repo_root");
  const sql = joinRuns
    ? "SELECT a.path, r.repo_root FROM artifacts a LEFT JOIN runs r ON r.id = a.run_id"
    : "SELECT path, NULL AS repo_root FROM artifacts";

  const stmt = sqlite.prepare(sql);
  const canonCache = new Map<string, string>();
  const ownerCaches = createRelativeOwnerCaches(canonCache);
  const getOtherExists = makeOtherRepoExistsChecker(sqlite, canonRepo, knownRepoRoots, checkBudget);
  let i = 0;
  for (const row of stmt.iterate() as Iterable<{ path: unknown; repo_root: unknown }>) {
    if ((i++ & 127) === 0) checkBudget?.();
    if (typeof row.path !== "string") continue;
    const runRepo = typeof row.repo_root === "string" && row.repo_root.length > 0 ? row.repo_root : null;
    const parsed = parseLegacyPathForRepo(canonRepo, row.path, runRepo, canonCache);
    if (!parsed) continue;
    if (parsed.isUnownedRelative) {
      if (classifyUnownedRelativeRow(sqlite, canonRepo, parsed, getOtherExists, ownerCaches) !== "owned") {
        continue;
      }
    }
    return true;
  }
  return false;
}

/**
 * Builds an in-memory `artifacts` index for `canonRepo` reused across discovery, flat-artifact ownership
 * resolution, pending row-rewrite counts, ambiguous-row counting, and transactional row rewrites.
 * When `passSnapshot` is supplied, reuses the pass-level scan without re-querying SQLite.
 */
export function buildRepoArtifactRowIndex(
  sqlite: Database,
  canonRepo: string,
  storage?: StoragePaths,
  checkBudget?: () => void,
  knownRepoRoots?: KnownRepoRootsProvider,
  passSnapshot?: PassArtifactRowSnapshot,
): RepoArtifactRowIndex {
  checkBudget?.();
  const legacyRows: ParsedLegacyArtifactRow[] = [];
  const legacyByMemberKey = new Map<string, ParsedLegacyArtifactRow[]>();
  const flatOwnersByFileName = new Map<string, FlatArtifactOwnerRef[]>();
  const ambiguousRows: ParsedLegacyArtifactRow[] = [];
  const ambiguousByMemberKey = new Map<string, ParsedLegacyArtifactRow[]>();
  const flatSeen = new Map<string, Set<string>>();

  const emptyIndex: RepoArtifactRowIndex = {
    canonRepo,
    hasArtifactsTable: false,
    legacyRows,
    legacyByMemberKey,
    flatOwnersByFileName,
    ambiguousRows,
    ambiguousByMemberKey,
  };

  if (passSnapshot && !passSnapshot.hasArtifactsTable) {
    return emptyIndex;
  }

  const recordFlatOwner = (fileName: string, runId: string | null, taskId: string | null, ambiguous = false) => {
    let seen = flatSeen.get(fileName);
    if (!seen) {
      seen = new Set<string>();
      flatSeen.set(fileName, seen);
    }
    const dedupKey = `${runId ?? ""}\0${taskId ?? ""}\0${ambiguous ? "1" : "0"}`;
    if (seen.has(dedupKey)) return;
    seen.add(dedupKey);
    let list = flatOwnersByFileName.get(fileName);
    if (!list) {
      list = [];
      flatOwnersByFileName.set(fileName, list);
    }
    list.push(ambiguous ? { runId, taskId, ambiguous: true } : { runId, taskId });
  };

  const canonCache = passSnapshot?.canonCache ?? new Map<string, string>();
  const ownerCaches = createRelativeOwnerCaches(canonCache);
  const getOtherExists = makeOtherRepoExistsChecker(sqlite, canonRepo, knownRepoRoots, checkBudget);
  const dataDirRunStub = { repoRoot: canonRepo, id: "" };
  const checkDataDir = Boolean(storage && storage.layout === "data-dir");

  const processRow = (
    id: string,
    runId: string | null,
    taskId: string | null,
    rawPath: string,
    runRepo: string | null,
  ) => {
    const parsed = parseLegacyPathForRepo(canonRepo, rawPath, runRepo, canonCache);
    if (parsed) {
      const entry: ParsedLegacyArtifactRow = {
        id,
        runId,
        taskId,
        path: rawPath,
        subdir: parsed.subdir,
        subParts: parsed.subParts,
      };
      if (parsed.isUnownedRelative) {
        const ownership = classifyUnownedRelativeRow(sqlite, canonRepo, parsed, getOtherExists, ownerCaches);
        if (ownership === "other") return;
        if (ownership === "ambiguous") {
          ambiguousRows.push(entry);
          for (const key of indexBucketKeysForParsedRow(entry)) {
            let bucket = ambiguousByMemberKey.get(key);
            if (!bucket) {
              bucket = [];
              ambiguousByMemberKey.set(key, bucket);
            }
            bucket.push(entry);
          }
          // A8/D8: skipping an ambiguous rewrite must not hide a possible live owner of a flat spill file.
          if (parsed.subdir === "artifacts" && parsed.subParts.length === 1 && parsed.subParts[0]) {
            recordFlatOwner(parsed.subParts[0], runId, taskId, true);
          }
          return;
        }
      }
      legacyRows.push(entry);
      for (const key of indexBucketKeysForParsedRow(entry)) {
        let bucket = legacyByMemberKey.get(key);
        if (!bucket) {
          bucket = [];
          legacyByMemberKey.set(key, bucket);
        }
        bucket.push(entry);
      }
      if (parsed.subdir === "artifacts" && parsed.subParts.length === 1 && parsed.subParts[0]) {
        recordFlatOwner(parsed.subParts[0], runId, taskId);
      }
      return;
    }

    if (checkDataDir) {
      const info = storage!.dataDirArtifactInfo(dataDirRunStub, rawPath);
      if (info && !info.subPath.includes("/") && !info.subPath.includes(sep)) {
        recordFlatOwner(info.subPath, runId, taskId);
      }
    }
  };

  if (passSnapshot) {
    const repoRows = passSnapshot.rowsByCanonRepo.get(canonRepo);
    const groups: RawArtifactJoinRow[][] = [];
    if (repoRows) groups.push(repoRows);
    groups.push(passSnapshot.unownedRelativeRows);
    if (checkDataDir && passSnapshot.otherAbsoluteRows.length > 0) {
      groups.push(passSnapshot.otherAbsoluteRows);
    }
    let idx = 0;
    for (const group of groups) {
      for (let i = 0; i < group.length; i++) {
        if ((idx++ & 127) === 127) checkBudget?.();
        const row = group[i]!;
        processRow(row.id, row.runId, row.taskId, row.path, row.runRepo);
      }
    }
  } else {
    const artCols = getTableColumns(sqlite, "artifacts");
    if (!artCols.has("id") || !artCols.has("path")) {
      return emptyIndex;
    }

    const hasRunId = artCols.has("run_id");
    const hasTaskId = artCols.has("task_id");
    const runCols = getTableColumns(sqlite, "runs");
    const joinRuns = hasRunId && runCols.has("id") && runCols.has("repo_root");

    const sql = joinRuns
      ? `SELECT a.id, a.run_id, ${hasTaskId ? "a.task_id" : "NULL AS task_id"}, a.path, r.repo_root
         FROM artifacts a
         LEFT JOIN runs r ON r.id = a.run_id`
      : `SELECT id, ${hasRunId ? "run_id" : "NULL AS run_id"}, ${hasTaskId ? "task_id" : "NULL AS task_id"}, path, NULL AS repo_root
         FROM artifacts`;

    const stmt = sqlite.prepare(sql);
    let i = 0;
    for (const row of stmt.iterate() as Iterable<{
      id: string;
      run_id: string | null;
      task_id: string | null;
      path: unknown;
      repo_root: unknown;
    }>) {
      if ((i++ & 127) === 0) checkBudget?.();
      if (typeof row.path !== "string") continue;
      const runId = row.run_id ? String(row.run_id) : null;
      const taskId = row.task_id ? String(row.task_id) : null;
      const runRepo = typeof row.repo_root === "string" && row.repo_root.length > 0 ? row.repo_root : null;
      processRow(String(row.id), runId, taskId, row.path, runRepo);
    }
  }

  return {
    canonRepo,
    hasArtifactsTable: true,
    legacyRows,
    legacyByMemberKey,
    flatOwnersByFileName,
    ambiguousRows,
    ambiguousByMemberKey,
  };
}

/** Finds deduplicated IDs of ambiguous relative legacy rows matching `members` (skipped from rewrites). */
export function findAmbiguousRowIdsFromIndex(
  index: RepoArtifactRowIndex,
  members: readonly RowRewriteMemberSpec[],
  checkBudget?: () => void,
): string[] {
  const out: string[] = [];
  const seenRowIds = new Set<string>();
  let idx = 0;
  let memberIdx = 0;
  for (const m of members) {
    if ((memberIdx++ & 127) === 127) checkBudget?.();
    const bucket = index.ambiguousByMemberKey.get(memberSpecBucketKey(m));
    if (!bucket) continue;
    for (const row of bucket) {
      if ((idx++ & 127) === 127) checkBudget?.();
      if (seenRowIds.has(row.id)) continue;
      const newPath = matchRowToMembers(row, [m]);
      if (newPath && newPath !== row.path) {
        seenRowIds.add(row.id);
        out.push(row.id);
      }
    }
  }
  return out;
}

/** O(1) lookup of indexed flat-artifact owners from a pre-built `RepoArtifactRowIndex`. */
export function findFlatArtifactOwnerRowsFromIndex(
  index: RepoArtifactRowIndex,
  fileName: string,
): FlatArtifactOwnerRef[] {
  return index.flatOwnersByFileName.get(fileName) ?? [];
}

/** Collects candidate legacy rows matching `members` from a pre-built index (deduplicated by row ID). */
function matchingRowsFromIndex(
  index: RepoArtifactRowIndex,
  members: readonly RowRewriteMemberSpec[],
  checkBudget?: () => void,
): Array<{ row: ParsedLegacyArtifactRow; newPath: string }> {
  const out: Array<{ row: ParsedLegacyArtifactRow; newPath: string }> = [];
  const seenRowIds = new Set<string>();
  let idx = 0;
  let memberIdx = 0;
  for (const m of members) {
    if ((memberIdx++ & 127) === 127) checkBudget?.();
    const bucket = index.legacyByMemberKey.get(memberSpecBucketKey(m));
    if (!bucket) continue;
    for (const row of bucket) {
      if ((idx++ & 127) === 127) checkBudget?.();
      if (seenRowIds.has(row.id)) continue;
      const newPath = matchRowToMembers(row, [m]);
      if (newPath && newPath !== row.path) {
        seenRowIds.add(row.id);
        out.push({ row, newPath });
      }
    }
  }
  return out;
}

/** Counts pending row rewrites for `members` in O(matching rows) using the pass-level index. */
export function countPendingRowRewritesFromIndex(
  index: RepoArtifactRowIndex,
  members: readonly RowRewriteMemberSpec[],
  checkBudget?: () => void,
): number {
  return matchingRowsFromIndex(index, members, checkBudget).length;
}

/**
 * Rewrites `artifacts.path` for every row belonging to `members` using the pass-level index inside a single
 * `BEGIN IMMEDIATE` transaction, then removes rewritten rows from the index.
 * Checks `checkBudget` before starting the atomic transaction (which counts as one in-flight operation).
 */
export function rewriteUnitArtifactRowsFromIndex(
  sqlite: Database,
  index: RepoArtifactRowIndex,
  members: readonly RowRewriteMemberSpec[],
  checkBudget?: () => void,
): number {
  if (!index.hasArtifactsTable) return 0;
  const matches = matchingRowsFromIndex(index, members, checkBudget);
  if (matches.length === 0) return 0;

  checkBudget?.();
  let updated = 0;
  const tx = sqlite.transaction(() => {
    const stmt = sqlite.prepare("UPDATE artifacts SET path = ? WHERE id = ? AND path = ?");
    for (const { row, newPath } of matches) {
      const res = stmt.run(newPath, row.id, row.path);
      if (res.changes > 0) {
        updated++;
      }
    }
  });
  tx.immediate();

  // Remove updated rows from index buckets so subsequent units in the same pass see up-to-date state.
  const rewrittenIds = new Set(matches.map((m) => m.row.id));
  for (const m of members) {
    const key = memberSpecBucketKey(m);
    const bucket = index.legacyByMemberKey.get(key);
    if (!bucket) continue;
    const remaining = bucket.filter((r) => !rewrittenIds.has(r.id));
    if (remaining.length === 0) {
      index.legacyByMemberKey.delete(key);
    } else {
      index.legacyByMemberKey.set(key, remaining);
    }
  }

  return updated;
}

/** Lists all `artifacts` rows that still name a legacy path unambiguously belonging to `canonRepo`. Read-only. */
export function listLegacyArtifactRowsForRepo(
  sqlite: Database,
  canonRepo: string,
  knownRepoRoots?: KnownRepoRootsProvider,
): ParsedLegacyArtifactRow[] {
  const artCols = getTableColumns(sqlite, "artifacts");
  if (!artCols.has("id") || !artCols.has("path")) return [];

  const hasRunId = artCols.has("run_id");
  const hasTaskId = artCols.has("task_id");
  const runCols = getTableColumns(sqlite, "runs");
  const joinRuns = hasRunId && runCols.has("id") && runCols.has("repo_root");

  const sql = joinRuns
    ? `SELECT a.id, a.run_id, ${hasTaskId ? "a.task_id" : "NULL AS task_id"}, a.path, r.repo_root
       FROM artifacts a
       LEFT JOIN runs r ON r.id = a.run_id`
    : `SELECT id, ${hasRunId ? "run_id" : "NULL AS run_id"}, ${hasTaskId ? "task_id" : "NULL AS task_id"}, path, NULL AS repo_root
       FROM artifacts`;

  const rows = sqlite.prepare(sql).all() as Array<{
    id: string;
    run_id: string | null;
    task_id: string | null;
    path: string;
    repo_root: string | null;
  }>;

  const canonCache = new Map<string, string>();
  const ownerCaches = createRelativeOwnerCaches(canonCache);
  const getOtherExists = makeOtherRepoExistsChecker(sqlite, canonRepo, knownRepoRoots);
  const out: ParsedLegacyArtifactRow[] = [];
  for (const row of rows) {
    if (typeof row.path !== "string") continue;
    const runRepo = typeof row.repo_root === "string" && row.repo_root.length > 0 ? row.repo_root : null;
    const parsed = parseLegacyPathForRepo(canonRepo, row.path, runRepo, canonCache);
    if (!parsed) continue;
    if (parsed.isUnownedRelative) {
      if (classifyUnownedRelativeRow(sqlite, canonRepo, parsed, getOtherExists, ownerCaches) !== "owned") {
        continue;
      }
    }
    out.push({
      id: String(row.id),
      runId: row.run_id ? String(row.run_id) : null,
      taskId: row.task_id ? String(row.task_id) : null,
      path: row.path,
      subdir: parsed.subdir,
      subParts: parsed.subParts,
    });
  }
  return out;
}

/**
 * Finds owning `(runId, taskId)` rows in `artifacts` for a flat artifact file `fileName` in `canonRepo`,
 * matching both legacy `.harness/artifacts/<fileName>` paths and already-rewritten data-dir paths. Read-only.
 */
export function findFlatArtifactOwnerRows(
  sqlite: Database,
  canonRepo: string,
  fileName: string,
  storage?: StoragePaths,
  knownRepoRoots?: KnownRepoRootsProvider,
): Array<{ runId: string | null; taskId: string | null }> {
  const artCols = getTableColumns(sqlite, "artifacts");
  if (!artCols.has("path")) return [];
  const hasRunId = artCols.has("run_id");
  const hasTaskId = artCols.has("task_id");
  const runCols = getTableColumns(sqlite, "runs");
  const joinRuns = hasRunId && runCols.has("id") && runCols.has("repo_root");

  const sql = joinRuns
    ? `SELECT ${hasRunId ? "a.run_id" : "NULL AS run_id"}, ${hasTaskId ? "a.task_id" : "NULL AS task_id"}, a.path, r.repo_root
       FROM artifacts a
       LEFT JOIN runs r ON r.id = a.run_id`
    : `SELECT ${hasRunId ? "run_id" : "NULL AS run_id"}, ${hasTaskId ? "task_id" : "NULL AS task_id"}, path, NULL AS repo_root
       FROM artifacts`;

  const rows = sqlite.prepare(sql).all() as Array<{
    run_id: string | null;
    task_id: string | null;
    path: string;
    repo_root: string | null;
  }>;

  const out: Array<{ runId: string | null; taskId: string | null }> = [];
  const seen = new Set<string>();
  const record = (runId: string | null, taskId: string | null) => {
    const key = `${runId ?? ""}\0${taskId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ runId, taskId });
  };

  const canonCache = new Map<string, string>();
  const ownerCaches = createRelativeOwnerCaches(canonCache);
  const getOtherExists = makeOtherRepoExistsChecker(sqlite, canonRepo, knownRepoRoots);

  for (const row of rows) {
    if (typeof row.path !== "string") continue;
    const runRepo = typeof row.repo_root === "string" && row.repo_root.length > 0 ? row.repo_root : null;
    const legacyParsed = parseLegacyPathForRepo(canonRepo, row.path, runRepo, canonCache);
    if (legacyParsed && legacyParsed.subdir === "artifacts" && legacyParsed.subParts.length === 1 && legacyParsed.subParts[0] === fileName) {
      if (legacyParsed.isUnownedRelative) {
        if (classifyUnownedRelativeRow(sqlite, canonRepo, legacyParsed, getOtherExists, ownerCaches) !== "owned") {
          continue;
        }
      }
      record(row.run_id ? String(row.run_id) : null, row.task_id ? String(row.task_id) : null);
      continue;
    }
    if (storage && storage.layout === "data-dir") {
      const info = storage.dataDirArtifactInfo({ repoRoot: canonRepo, id: "" }, row.path);
      if (info && info.subPath === fileName) {
        record(row.run_id ? String(row.run_id) : null, row.task_id ? String(row.task_id) : null);
      }
    }
  }
  return out;
}

/** Computes the rewritten destination path for a parsed legacy artifact row if it belongs to one of `members`. */
export function matchRowToMembers(
  row: ParsedLegacyArtifactRow,
  members: readonly RowRewriteMemberSpec[],
): string | null {
  for (const m of members) {
    switch (m.kind) {
      case "goal":
        if (row.subdir === "goals" && row.subParts[0] === m.id) {
          if (m.allowedRelPaths !== undefined) {
            const rel = row.subParts.slice(1).join("/");
            if (rel.length === 0 || !m.allowedRelPaths.has(rel)) break;
          }
          return row.subParts.length === 1
            ? m.destinationPath
            : join(m.destinationPath, ...row.subParts.slice(1));
        }
        break;
      case "run":
        if (row.subdir === "artifacts" && row.subParts[0] === m.id) {
          if (m.allowedRelPaths !== undefined) {
            const rel = row.subParts.slice(1).join("/");
            if (rel.length === 0 || !m.allowedRelPaths.has(rel)) break;
          }
          return row.subParts.length === 1
            ? m.destinationPath
            : join(m.destinationPath, ...row.subParts.slice(1));
        }
        break;
      case "bucket_task":
        if (row.subdir === "artifacts" && row.subParts[0] === m.id && row.subParts[1] === m.taskId) {
          if (m.allowedRelPaths !== undefined) {
            const rel = row.subParts.slice(2).join("/");
            if (rel.length === 0 || !m.allowedRelPaths.has(rel)) break;
          }
          return row.subParts.length === 2
            ? m.destinationPath
            : join(m.destinationPath, ...row.subParts.slice(2));
        }
        break;
      case "flat_artifact":
        if (row.subdir === "artifacts" && row.subParts.length === 1 && row.subParts[0] === m.id) {
          if (m.allowedRelPaths !== undefined && m.allowedRelPaths.size === 0) break;
          return m.destinationPath;
        }
        break;
      case "note":
        if (row.subdir === "notes" && row.subParts.join("/") === m.id) {
          if (m.allowedRelPaths !== undefined && m.allowedRelPaths.size === 0) break;
          return m.destinationPath;
        }
        break;
    }
  }
  return null;
}

/** Counts how many `artifacts` rows currently need rewriting for `members`. Pure read-only. */
export function countPendingRowRewrites(
  sqlite: Database,
  canonRepo: string,
  members: readonly RowRewriteMemberSpec[],
): number {
  const rows = listLegacyArtifactRowsForRepo(sqlite, canonRepo);
  let count = 0;
  for (const row of rows) {
    const newPath = matchRowToMembers(row, members);
    if (newPath && newPath !== row.path) count++;
  }
  return count;
}

/**
 * Rewrites `artifacts.path` for every row belonging to `members` inside a single `BEGIN IMMEDIATE` transaction.
 * Does not open a write transaction when 0 rows need rewriting (keeps idempotent passes write-free).
 */
export function rewriteUnitArtifactRows(
  sqlite: Database,
  canonRepo: string,
  members: readonly RowRewriteMemberSpec[],
): number {
  const artCols = getTableColumns(sqlite, "artifacts");
  if (!artCols.has("id") || !artCols.has("path")) return 0;

  // Quick read-only check so an already-migrated unit touches 0 pages in SQLite.
  if (countPendingRowRewrites(sqlite, canonRepo, members) === 0) {
    return 0;
  }

  let updated = 0;
  const tx = sqlite.transaction(() => {
    const rows = listLegacyArtifactRowsForRepo(sqlite, canonRepo);
    const stmt = sqlite.prepare("UPDATE artifacts SET path = ? WHERE id = ?");
    for (const row of rows) {
      const newPath = matchRowToMembers(row, members);
      if (newPath && newPath !== row.path) {
        stmt.run(newPath, row.id);
        updated++;
      }
    }
  });
  tx.immediate();
  return updated;
}
