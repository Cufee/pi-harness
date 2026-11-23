import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, readdirSync, realpathSync, rmSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

const initializedDbs = new WeakSet<Database>();
const seededPrefixes = new WeakMap<Database, Set<string>>();

const VALID_TABLE_RE = /^[a-z_][a-z0-9_]*$/i;

function ensureSequenceTable(db: Database): void {
  if (initializedDbs.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS id_sequences (
      prefix TEXT PRIMARY KEY,
      next_value INTEGER NOT NULL
    );
  `);
  initializedDbs.add(db);
}

/**
 * Ensures the sequence for `prefix` starts above any pre-existing numeric `${prefix}-<N>` IDs
 * in `existingTable` (e.g. from legacy rows or explicit fixture IDs), without ever regressing.
 */
function ensureSeeded(db: Database, prefix: string, existingTable?: string): void {
  if (!existingTable || !VALID_TABLE_RE.test(existingTable)) return;
  let set = seededPrefixes.get(db);
  if (!set) {
    set = new Set();
    seededPrefixes.set(db, set);
  }
  const key = `${existingTable}:${prefix}`;
  if (set.has(key)) return;
  set.add(key);

  try {
    const rows = db
      .prepare(`SELECT id FROM ${existingTable} WHERE id LIKE ?`)
      .all(`${prefix}-%`) as Array<{ id: string }>;
    let maxExisting = 0;
    const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
    for (const r of rows) {
      const m = re.exec(r.id);
      if (m) {
        const n = Number.parseInt(m[1]!, 10);
        if (Number.isFinite(n) && n > maxExisting) maxExisting = n;
      }
    }
    if (maxExisting > 0) {
      db.prepare(
        `INSERT INTO id_sequences(prefix, next_value) VALUES (?, ?)
         ON CONFLICT(prefix) DO UPDATE SET next_value = MAX(next_value, excluded.next_value)`,
      ).run(prefix, maxExisting);
    }
  } catch {
    // Table may not exist yet in partial-schema unit tests; safe to ignore.
  }
}

/**
 * Generates short, model-friendly sequential identifiers (`goal-1`, `run-1`, `t-1`, `esc-1`, `kb-1`, `chat-1`, ...)
 * backed by a durable SQLite monotonic counter so LLMs can transcribe and reference IDs reliably
 * without hallucinating random hex/UUID strings.
 */
export function nextFriendlyId(db: Database, prefix: string, existingTable?: string): string {
  ensureSequenceTable(db);
  ensureSeeded(db, prefix, existingTable);

  const checkStmt =
    existingTable && VALID_TABLE_RE.test(existingTable)
      ? db.prepare(`SELECT 1 FROM ${existingTable} WHERE id = ? LIMIT 1`)
      : null;

  for (let attempt = 0; attempt < 10_000; attempt++) {
    const row = db
      .prepare(
        `INSERT INTO id_sequences(prefix, next_value) VALUES (?, 1)
         ON CONFLICT(prefix) DO UPDATE SET next_value = next_value + 1
         RETURNING next_value`,
      )
      .get(prefix) as { next_value: number };
    const candidate = `${prefix}-${row.next_value}`;
    if (!checkStmt || !checkStmt.get(candidate)) return candidate;
  }
  throw new Error(`Exhausted friendly ID allocation for prefix ${prefix}`);
}

/**
 * Produces ordered lookup candidates for a model-supplied ID:
 *   1. Exact trimmed string (always matches first — preserves legacy hex IDs like `goal-95d485df`)
 *   2. Normalized friendly form for minor LLM drift (`GOAL-1`, `goal_1`, `goal 1`, `#1`, `1` -> `goal-1`)
 */
export function friendlyIdCandidates(raw: string, prefix: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const out = [trimmed];
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lower = trimmed.toLowerCase();

  const prefixed = new RegExp(`^${escaped}[_\\s-]+(\\d+)$`).exec(lower);
  if (prefixed) {
    const norm = `${prefix}-${Number.parseInt(prefixed[1]!, 10)}`;
    if (!out.includes(norm)) out.push(norm);
    return out;
  }

  const bareNum = /^#?(\d+)$/.exec(trimmed);
  if (bareNum) {
    const norm = `${prefix}-${Number.parseInt(bareNum[1]!, 10)}`;
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

// Per-process high-water mark so an index is not reused after its file is deleted.
const fileNameCounters = new Map<string, number>();

/** Highest N among existing `<stem>-<N><ext>` entries in dir (0 when none or unreadable). */
function scanMaxFileIndex(dir: string, stem: string, ext: string): number {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  const prefix = `${stem}-`;
  let max = 0;
  for (const entry of entries) {
    if (entry.length <= prefix.length + ext.length || !entry.startsWith(prefix) || !entry.endsWith(ext)) continue;
    const mid = entry.slice(prefix.length, entry.length - ext.length);
    if (!/^[0-9]{1,10}$/.test(mid)) continue;
    const n = Number.parseInt(mid, 10);
    if (n < 0x80000000 && n > max) max = n;
  }
  return max;
}

/** Creates path exclusively and writes content. Returns false when the entry already exists. */
function tryCreateExclusive(path: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    const buf = Buffer.from(content, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  } catch (error) {
    closeSync(fd);
    rmSync(path, { force: true });
    throw error;
  }
  closeSync(fd);
  return true;
}

/**
 * Creates a new file `<stem>-<n><ext>` in dir (O_CREAT|O_EXCL, mode 0o600) holding content and returns its basename.
 * Never overwrites, truncates, or deletes an existing entry. dir must exist.
 */
export function writeUniqueFile(dir: string, stem: string, ext: string, content: string): string {
  let canonDir: string;
  try {
    canonDir = realpathSync(dir);
  } catch {
    canonDir = resolve(dir);
  }
  const key = `${canonDir}\0${stem}\0${ext}`;
  let n = Math.max(fileNameCounters.get(key) ?? 0, scanMaxFileIndex(dir, stem, ext));
  for (let attempt = 0; attempt < 64; attempt++) {
    n++;
    const name = `${stem}-${n}${ext}`;
    if (tryCreateExclusive(join(dir, name), content)) {
      fileNameCounters.set(key, n);
      return name;
    }
  }
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `${stem}-${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
    if (tryCreateExclusive(join(dir, name), content)) return name;
  }
  throw Object.assign(new Error(`EEXIST: could not allocate a unique file for ${stem}-N${ext} in ${dir}`), { code: "EEXIST" });
}
