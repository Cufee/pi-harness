import type { Database } from "bun:sqlite";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { RunRecord, TaskStatus } from "../../control-plane/db.js";
import { directorTaskRunOwner, isDirectorTaskContainer } from "../../control-plane/ids.js";
import type { GoalStatus } from "../../goals/engine.js";
import type { StorageUnitKind } from "../data-dir/units.js";
import type { StoragePaths } from "../paths.js";
import { canonicalPath, isRealDirUnderRoot, LEGACY_HARNESS_DIR, readMigrationState } from "./fs.js";

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
}

/** True if `tableName` exists in SQLite (`sqlite_master`). Read-only. */
export function hasTable(sqlite: Database, tableName: string): boolean {
  try {
    const row = sqlite
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .get(tableName);
    return Boolean(row);
  } catch {
    return false;
  }
}

/** Returns column names for `tableName`, or an empty set if missing. Read-only. */
export function getTableColumns(sqlite: Database, tableName: string): Set<string> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(tableName) || !hasTable(sqlite, tableName)) {
    return new Set();
  }
  try {
    const cols = sqlite.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return new Set(cols.map((c) => c.name));
  } catch {
    return new Set();
  }
}

/**
 * Discovers distinct canonical repo roots from `runs` and `goals` that still have a `.harness` directory
 * (or pending crash-recovery state / unrewritten legacy artifact rows), or returns the deduplicated
 * canonicalized `optsRepoRoots` when supplied.
 * Safe on read-only DBs and standalone/older DBs missing `goals` or optional columns.
 */
export function discoverRepoRoots(
  sqlite: Database,
  optsRepoRoots?: readonly string[],
  storage?: StoragePaths,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const hasPendingWork = (canon: string): boolean => {
    if (isRealDirUnderRoot(canon, [LEGACY_HARNESS_DIR])) return true;
    if (storage && storage.layout === "data-dir") {
      try {
        if (readMigrationState(storage.projectDir(canon)).pendingUnits.length > 0) return true;
      } catch {
        // Ignore unreadable state dir.
      }
      if (listLegacyArtifactRowsForRepo(sqlite, canon).length > 0) return true;
    }
    return false;
  };
  const add = (raw: string, requireHarnessOrPending: boolean) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const canon = canonicalPath(trimmed);
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

  const runCols = getTableColumns(sqlite, "runs");
  if (runCols.has("repo_root")) {
    try {
      const rows = sqlite.prepare("SELECT DISTINCT repo_root FROM runs WHERE repo_root IS NOT NULL").all() as Array<{
        repo_root: string;
      }>;
      for (const r of rows) {
        if (typeof r.repo_root === "string") add(r.repo_root, true);
      }
    } catch {
      // Guard older/incompatible DB layouts.
    }
  }

  const goalCols = getTableColumns(sqlite, "goals");
  if (goalCols.has("repo_root")) {
    try {
      const rows = sqlite.prepare("SELECT DISTINCT repo_root FROM goals WHERE repo_root IS NOT NULL").all() as Array<{
        repo_root: string;
      }>;
      for (const r of rows) {
        if (typeof r.repo_root === "string") add(r.repo_root, true);
      }
    } catch {
      // Guard older/incompatible DB layouts.
    }
  }

  return out;
}

/** Reads a goal row by ID using SELECT only, guarding missing tables and columns. */
export function readGoalRow(sqlite: Database, goalId: string): GoalRowInfo | null {
  const cols = getTableColumns(sqlite, "goals");
  if (!cols.has("id") || !cols.has("status")) return null;
  const selectLinked = cols.has("linked_run_id") ? "linked_run_id" : "NULL AS linked_run_id";
  const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
  const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
  try {
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
  } catch {
    return null;
  }
}

/** Finds all goals whose `linked_run_id` equals `runId`. Read-only. */
export function findGoalsByLinkedRun(sqlite: Database, runId: string): GoalRowInfo[] {
  const cols = getTableColumns(sqlite, "goals");
  if (!cols.has("id") || !cols.has("status") || !cols.has("linked_run_id")) return [];
  const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
  const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
  const orderBy = cols.has("updated_at") ? "ORDER BY updated_at DESC, id ASC" : "ORDER BY id ASC";
  try {
    const rows = sqlite
      .prepare(
        `SELECT id, status, linked_run_id, ${selectChat}, ${selectRepo} FROM goals WHERE linked_run_id = ? ${orderBy}`,
      )
      .all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      status: String(row.status),
      linkedRunId: row.linked_run_id ? String(row.linked_run_id) : null,
      chatSessionId: row.chat_session_id ? String(row.chat_session_id) : null,
      repoRoot: row.repo_root ? String(row.repo_root) : null,
    }));
  } catch {
    return [];
  }
}

/** Reads a run row by ID using SELECT only, guarding missing tables and columns. */
export function readRunRow(sqlite: Database, runId: string): RunRowInfo | null {
  const cols = getTableColumns(sqlite, "runs");
  if (!cols.has("id") || !cols.has("status")) return null;
  const selectChat = cols.has("chat_session_id") ? "chat_session_id" : "NULL AS chat_session_id";
  const selectRepo = cols.has("repo_root") ? "repo_root" : "NULL AS repo_root";
  try {
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
  } catch {
    return null;
  }
}

/** Lists tasks belonging to `runId` using SELECT only. */
export function listTasksForRun(sqlite: Database, runId: string): TaskRowInfo[] {
  const cols = getTableColumns(sqlite, "tasks");
  if (!cols.has("id") || !cols.has("run_id") || !cols.has("status")) return [];
  try {
    const rows = sqlite
      .prepare("SELECT id, run_id, status FROM tasks WHERE run_id = ? ORDER BY id ASC")
      .all(runId) as Array<{ id: string; run_id: string; status: string }>;
    return rows.map((r) => ({ id: String(r.id), runId: String(r.run_id), status: String(r.status) }));
  } catch {
    return [];
  }
}

/** Reads one task row by ID using SELECT only. */
export function readTaskRow(sqlite: Database, taskId: string): TaskRowInfo | null {
  const cols = getTableColumns(sqlite, "tasks");
  if (!cols.has("id") || !cols.has("run_id") || !cols.has("status")) return null;
  try {
    const row = sqlite
      .prepare("SELECT id, run_id, status FROM tasks WHERE id = ? LIMIT 1")
      .get(taskId) as { id: string; run_id: string; status: string } | undefined;
    if (!row) return null;
    return { id: String(row.id), runId: String(row.run_id), status: String(row.status) };
  } catch {
    return null;
  }
}

/**
 * Pure read-only derivation of a run's owning chat session ID (never writes to SQLite).
 * Mirrors `ControlPlaneDb.getRunChatSessionId` using SELECTs only.
 */
export function deriveRunChatSessionIdReadOnly(sqlite: Database, runId: string): string | null {
  const run = readRunRow(sqlite, runId);
  if (run?.chatSessionId) return run.chatSessionId;

  if (isDirectorTaskContainer(runId)) {
    const owner = directorTaskRunOwner(runId);
    if (owner) {
      const chatCols = getTableColumns(sqlite, "chat_sessions");
      if (chatCols.has("id")) {
        try {
          const chatRow = sqlite
            .prepare("SELECT id FROM chat_sessions WHERE id = ? LIMIT 1")
            .get(owner) as { id?: string } | undefined;
          if (chatRow?.id) return String(chatRow.id);
        } catch {
          // Ignore incompatible schema.
        }
      }
      const goalCols = getTableColumns(sqlite, "goals");
      if (goalCols.has("id") && goalCols.has("chat_session_id")) {
        try {
          const goalRow = sqlite
            .prepare("SELECT chat_session_id FROM goals WHERE id = ? AND chat_session_id IS NOT NULL LIMIT 1")
            .get(owner) as { chat_session_id?: string | null } | undefined;
          if (goalRow?.chat_session_id) return String(goalRow.chat_session_id);
        } catch {
          // Ignore incompatible schema.
        }
      }
    }
  }

  const linkedGoals = findGoalsByLinkedRun(sqlite, runId);
  for (const goal of linkedGoals) {
    if (goal.chatSessionId) return goal.chatSessionId;
  }
  return null;
}

const LEGACY_SUBDIRS = new Set(["artifacts", "goals", "notes"]);

/**
 * Parses an `artifacts.path` value if it is a legacy `.harness/{artifacts,goals,notes}/...` path
 * belonging to `canonRepo` (under raw, canonical, symlinked repo root spellings, or workspace-relative).
 */
export function parseLegacyPathForRepo(
  canonRepo: string,
  rawPath: string,
  runRepoRoot: string | null,
): { subdir: "artifacts" | "goals" | "notes"; subParts: string[] } | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  if (!isAbsolute(trimmed)) {
    const norm = trimmed.replaceAll("\\", "/").replace(/^\.\//, "");
    const parts = norm.split("/").filter((s) => s.length > 0 && s !== ".");
    if (parts.length < 3 || parts[0] !== LEGACY_HARNESS_DIR || !LEGACY_SUBDIRS.has(parts[1]!)) return null;
    if (parts.some((p) => p === "..")) return null;
    if (runRepoRoot !== null && canonicalPath(runRepoRoot) !== canonRepo) return null;
    return {
      subdir: parts[1] as "artifacts" | "goals" | "notes",
      subParts: parts.slice(2),
    };
  }

  const abs = resolve(trimmed);
  const marker = `${sep}${LEGACY_HARNESS_DIR}${sep}`;
  for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
    const prefix = abs.slice(0, idx) || sep;
    let matchesRepo = prefix === canonRepo;
    if (!matchesRepo) {
      try {
        matchesRepo = canonicalPath(prefix) === canonRepo;
      } catch {
        matchesRepo = false;
      }
    }
    if (!matchesRepo && runRepoRoot !== null) {
      if (resolve(runRepoRoot) === resolve(prefix) && canonicalPath(runRepoRoot) === canonRepo) {
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
    };
  }

  return null;
}

/** Lists all `artifacts` rows that still name a legacy path belonging to `canonRepo`. Read-only. */
export function listLegacyArtifactRowsForRepo(sqlite: Database, canonRepo: string): ParsedLegacyArtifactRow[] {
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

  let rows: Array<{
    id: string;
    run_id: string | null;
    task_id: string | null;
    path: string;
    repo_root: string | null;
  }>;
  try {
    rows = sqlite.prepare(sql).all() as typeof rows;
  } catch {
    return [];
  }

  const out: ParsedLegacyArtifactRow[] = [];
  for (const row of rows) {
    if (typeof row.path !== "string") continue;
    const parsed = parseLegacyPathForRepo(canonRepo, row.path, row.repo_root ? String(row.repo_root) : null);
    if (!parsed) continue;
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

  let rows: Array<{
    run_id: string | null;
    task_id: string | null;
    path: string;
    repo_root: string | null;
  }>;
  try {
    rows = sqlite.prepare(sql).all() as typeof rows;
  } catch {
    return [];
  }

  const out: Array<{ runId: string | null; taskId: string | null }> = [];
  const seen = new Set<string>();
  const record = (runId: string | null, taskId: string | null) => {
    const key = `${runId ?? ""}\0${taskId ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ runId, taskId });
  };

  for (const row of rows) {
    if (typeof row.path !== "string") continue;
    const runRepo = row.repo_root ? String(row.repo_root) : null;
    const legacyParsed = parseLegacyPathForRepo(canonRepo, row.path, runRepo);
    if (legacyParsed && legacyParsed.subdir === "artifacts" && legacyParsed.subParts.length === 1 && legacyParsed.subParts[0] === fileName) {
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
          return row.subParts.length === 1
            ? m.destinationPath
            : join(m.destinationPath, ...row.subParts.slice(1));
        }
        break;
      case "run":
        if (row.subdir === "artifacts" && row.subParts[0] === m.id) {
          return row.subParts.length === 1
            ? m.destinationPath
            : join(m.destinationPath, ...row.subParts.slice(1));
        }
        break;
      case "bucket_task":
        if (row.subdir === "artifacts" && row.subParts[0] === m.id && row.subParts[1] === m.taskId) {
          return row.subParts.length === 2
            ? m.destinationPath
            : join(m.destinationPath, ...row.subParts.slice(2));
        }
        break;
      case "flat_artifact":
        if (row.subdir === "artifacts" && row.subParts.length === 1 && row.subParts[0] === m.id) {
          return m.destinationPath;
        }
        break;
      case "note":
        if (row.subdir === "notes" && row.subParts.join("/") === m.id) {
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
