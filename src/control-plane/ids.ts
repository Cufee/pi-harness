import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";

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

const fileNameCounters = new Map<string, number>();

/**
 * Generates a short, sequential, UUID-free filename (`t-3-summary-1.md`, `code-exec-1.json`)
 * that does not collide with existing files in `dir`.
 */
export function nextUniqueFileName(dir: string | null, stem: string, ext: string): string {
  const key = `${dir ?? "<mem>"}:${stem}${ext}`;
  let n = (fileNameCounters.get(key) ?? 0) + 1;
  while (dir && existsSync(join(dir, `${stem}-${n}${ext}`))) {
    n++;
  }
  fileNameCounters.set(key, n);
  return `${stem}-${n}${ext}`;
}
