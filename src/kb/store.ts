import type { Database } from "bun:sqlite";
import { globsOverlap } from "../control-plane/db.js";
import { friendlyIdCandidates, nextFriendlyId } from "../control-plane/ids.js";

export type KbKind = "invariant" | "gotcha" | "architecture" | "decision" | "convention";
export type KbStatus = "candidate" | "active" | "stale" | "archived";
export type KbConfidence = "verified" | "observed" | "inferred";

export interface KbCard {
  id: string;
  repoScope: string;
  kind: KbKind;
  status: KbStatus;
  confidence: KbConfidence;
  title: string;
  summary: string;
  tags: string[];
  pathGlobs: string[];
  verifiedSha: string | null;
  hitCount: number;
}

export interface KbEntry extends KbCard {
  contextMd: string;
  evidencePaths: string[];
  lastCheckedSha: string | null;
  staleReason: string | null;
  supersededBy: string | null;
  sourceRunId: string | null;
  sourceTaskId: string | null;
  lastHitAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export const KB_SCHEMA = `
CREATE TABLE IF NOT EXISTS kb_entries (
  id TEXT PRIMARY KEY,
  repo_scope TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('invariant','gotcha','architecture','decision','convention')),
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('candidate','active','stale','archived')),
  confidence TEXT NOT NULL DEFAULT 'observed' CHECK (confidence IN ('verified','observed','inferred')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  context_md TEXT NOT NULL,
  tags_text TEXT NOT NULL DEFAULT '',
  tags_json TEXT NOT NULL DEFAULT '[]',
  path_globs_json TEXT NOT NULL DEFAULT '[]',
  evidence_paths_json TEXT NOT NULL DEFAULT '[]',
  verified_sha TEXT,
  last_checked_sha TEXT,
  stale_reason TEXT,
  superseded_by TEXT REFERENCES kb_entries(id),
  source_run_id TEXT,
  source_task_id TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_kb_scope_status ON kb_entries(repo_scope, status, kind);

CREATE VIRTUAL TABLE IF NOT EXISTS kb_fts USING fts5(
  title,
  summary,
  tags_text,
  context_md,
  content='kb_entries',
  content_rowid='rowid',
  tokenize="porter unicode61 tokenchars '_./-'"
);

CREATE TRIGGER IF NOT EXISTS kb_entries_ai AFTER INSERT ON kb_entries BEGIN
  INSERT INTO kb_fts(rowid, title, summary, tags_text, context_md)
  VALUES (new.rowid, new.title, new.summary, new.tags_text, new.context_md);
END;

CREATE TRIGGER IF NOT EXISTS kb_entries_ad AFTER DELETE ON kb_entries BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, title, summary, tags_text, context_md)
  VALUES ('delete', old.rowid, old.title, old.summary, old.tags_text, old.context_md);
END;

CREATE TRIGGER IF NOT EXISTS kb_entries_au AFTER UPDATE ON kb_entries BEGIN
  INSERT INTO kb_fts(kb_fts, rowid, title, summary, tags_text, context_md)
  VALUES ('delete', old.rowid, old.title, old.summary, old.tags_text, old.context_md);
  INSERT INTO kb_fts(rowid, title, summary, tags_text, context_md)
  VALUES (new.rowid, new.title, new.summary, new.tags_text, new.context_md);
END;
`;

function kbId(db: Database): string {
  return nextFriendlyId(db, "kb", "kb_entries");
}

function sanitizeFtsQuery(raw: string): string {
  const tokens = raw
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*^():]/g, "").trim())
    .filter(Boolean);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

/**
 * Curated, evidence-anchored Knowledge Base backed by SQLite FTS5 (BM25 10/5/4/1)
 * with 2-stage progressive disclosure (`kb_search` cards -> `kb_get` context),
 * strict write size caps, bi-temporal archival (`superseded_by`), and hit-count telemetry.
 */
export class KnowledgeBaseStore {
  constructor(private readonly db: Database) {
    this.db.exec(KB_SCHEMA);
  }

  private mapEntry(r: Record<string, unknown>): KbEntry {
    return {
      id: String(r.id),
      repoScope: String(r.repo_scope),
      kind: String(r.kind) as KbKind,
      status: String(r.status) as KbStatus,
      confidence: String(r.confidence) as KbConfidence,
      title: String(r.title),
      summary: String(r.summary),
      contextMd: String(r.context_md),
      tags: JSON.parse(String(r.tags_json)) as string[],
      pathGlobs: JSON.parse(String(r.path_globs_json)) as string[],
      evidencePaths: JSON.parse(String(r.evidence_paths_json)) as string[],
      verifiedSha: r.verified_sha ? String(r.verified_sha) : null,
      lastCheckedSha: r.last_checked_sha ? String(r.last_checked_sha) : null,
      staleReason: r.stale_reason ? String(r.stale_reason) : null,
      supersededBy: r.superseded_by ? String(r.superseded_by) : null,
      sourceRunId: r.source_run_id ? String(r.source_run_id) : null,
      sourceTaskId: r.source_task_id ? String(r.source_task_id) : null,
      hitCount: Number(r.hit_count),
      lastHitAt: r.last_hit_at == null ? null : Number(r.last_hit_at),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  private toCard(e: KbEntry): KbCard {
    return {
      id: e.id,
      repoScope: e.repoScope,
      kind: e.kind,
      status: e.status,
      confidence: e.confidence,
      title: e.title,
      summary: e.summary,
      tags: e.tags,
      pathGlobs: e.pathGlobs,
      verifiedSha: e.verifiedSha,
      hitCount: e.hitCount,
    };
  }

  propose(input: {
    repoScope: string;
    kind: KbKind;
    title: string;
    summary: string;
    contextMd: string;
    tags?: string[];
    pathGlobs?: string[];
    evidencePaths: string[];
    verifiedSha?: string | null;
    sourceRunId?: string | null;
    sourceTaskId?: string | null;
    status?: KbStatus;
    confidence?: KbConfidence;
  }): KbEntry {
    const title = input.title.trim();
    const summary = input.summary.trim();
    const contextMd = input.contextMd.trim();
    if (!title || title.length > 80) throw new Error("KB title must be 1..80 characters");
    if (!summary || summary.length > 240) throw new Error("KB summary must be 1..240 characters");
    if (!contextMd || contextMd.length > 2000) throw new Error("KB context_md must be 1..2000 characters (required for Maintainer GC)");
    if (input.evidencePaths.length === 0 && input.kind !== "decision" && input.kind !== "convention") {
      throw new Error(`KB kind '${input.kind}' requires at least one evidence_paths reference`);
    }

    const id = kbId(this.db);
    const now = Date.now();
    const tags = (input.tags ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
    const globs = (input.pathGlobs ?? []).map((g) => g.trim()).filter(Boolean);

    this.db
      .prepare(
        `INSERT INTO kb_entries(
          id, repo_scope, kind, status, confidence, title, summary, context_md,
          tags_text, tags_json, path_globs_json, evidence_paths_json,
          verified_sha, last_checked_sha, source_run_id, source_task_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.repoScope,
        input.kind,
        input.status ?? "candidate",
        input.confidence ?? "observed",
        title,
        summary,
        contextMd,
        tags.join(" "),
        JSON.stringify(tags),
        JSON.stringify(globs),
        JSON.stringify(input.evidencePaths),
        input.verifiedSha ?? null,
        input.verifiedSha ?? null,
        input.sourceRunId ?? null,
        input.sourceTaskId ?? null,
        now,
        now,
      );

    return this.getRaw(id)!;
  }

  getRaw(id: string): KbEntry | null {
    for (const candidate of friendlyIdCandidates(id, "kb")) {
      const r = this.db.prepare("SELECT * FROM kb_entries WHERE id = ?").get(candidate) as Record<string, unknown> | undefined;
      if (r) return this.mapEntry(r);
    }
    return null;
  }

  /** Stage 2 on-demand fetch: returns full context_md + evidence and increments hit telemetry. */
  getMany(ids: string[]): KbEntry[] {
    const out: KbEntry[] = [];
    const now = Date.now();
    for (const id of ids.slice(0, 10)) {
      const entry = this.getRaw(id);
      if (!entry) continue;
      this.db.prepare("UPDATE kb_entries SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?").run(now, entry.id);
      out.push({ ...entry, hitCount: entry.hitCount + 1, lastHitAt: now });
    }
    return out;
  }

  /** Stage 1 progressive-disclosure search: FTS5 BM25 (10/5/4/1) + deterministic structured filters. */
  search(opts: {
    query?: string;
    repoScope?: string;
    pathGlobs?: string[];
    tags?: string[];
    kinds?: KbKind[];
    includeCandidates?: boolean;
    includeStale?: boolean;
    limit?: number;
  }): KbCard[] {
    const statuses: KbStatus[] = ["active"];
    if (opts.includeCandidates) statuses.push("candidate");
    if (opts.includeStale) statuses.push("stale");

    const limit = Math.min(opts.limit ?? 10, 50);
    const ftsQuery = opts.query ? sanitizeFtsQuery(opts.query) : "";
    const kinds = opts.kinds?.length ? opts.kinds : null;
    const needsJsFilter = Boolean(opts.pathGlobs?.length || opts.tags?.length);
    const sqlLimit = needsJsFilter ? (opts.repoScope ? null : Math.max(limit * 25, 250)) : limit;

    let rows: Record<string, unknown>[];
    if (ftsQuery) {
      const placeholders = statuses.map(() => "?").join(",");
      const params: (string | number)[] = [ftsQuery, ...statuses];
      let extraSql = "";
      if (opts.repoScope) {
        extraSql += " AND (e.repo_scope = ? OR e.repo_scope = 'global')";
        params.push(opts.repoScope);
      }
      if (kinds) {
        const kindPlaceholders = kinds.map(() => "?").join(",");
        extraSql += ` AND e.kind IN (${kindPlaceholders})`;
        params.push(...kinds);
      }
      let limitSql = "";
      if (sqlLimit !== null) {
        limitSql = "\n           LIMIT ?";
        params.push(sqlLimit);
      }
      rows = this.db
        .prepare(
          `SELECT e.*, bm25(kb_fts, 10.0, 5.0, 4.0, 1.0) AS rank
           FROM kb_fts
           JOIN kb_entries e ON e.rowid = kb_fts.rowid
           WHERE kb_fts MATCH ? AND e.status IN (${placeholders})${extraSql}
           ORDER BY rank ASC, e.hit_count DESC${limitSql}`,
        )
        .all(...params) as Record<string, unknown>[];
    } else {
      const placeholders = statuses.map(() => "?").join(",");
      const params: (string | number)[] = [...statuses];
      let extraSql = "";
      if (opts.repoScope) {
        extraSql += " AND (repo_scope = ? OR repo_scope = 'global')";
        params.push(opts.repoScope);
      }
      if (kinds) {
        const kindPlaceholders = kinds.map(() => "?").join(",");
        extraSql += ` AND kind IN (${kindPlaceholders})`;
        params.push(...kinds);
      }
      let limitSql = "";
      if (sqlLimit !== null) {
        limitSql = "\n           LIMIT ?";
        params.push(sqlLimit);
      }
      rows = this.db
        .prepare(
          `SELECT * FROM kb_entries
           WHERE status IN (${placeholders})${extraSql}
           ORDER BY CASE kind WHEN 'invariant' THEN 0 WHEN 'gotcha' THEN 1 ELSE 2 END, hit_count DESC, updated_at DESC${limitSql}`,
        )
        .all(...params) as Record<string, unknown>[];
    }

    const entries = rows.map((r) => this.mapEntry(r));
    const filtered = entries.filter((e) => {
      if (opts.kinds?.length && !opts.kinds.includes(e.kind)) return false;
      if (opts.tags?.length && !opts.tags.some((t) => e.tags.includes(t.toLowerCase()))) return false;
      if (opts.pathGlobs?.length) {
        if (e.pathGlobs.length === 0) return false;
        const overlaps = opts.pathGlobs.some((q) => e.pathGlobs.some((g) => globsOverlap(q, g)));
        if (!overlaps) return false;
      }
      return true;
    });

    return filtered.slice(0, limit).map((e) => this.toCard(e));
  }

  /** Stage 0 ambient scoped index for Tier 2 Worker hydration (hard-capped at <=5 1-line items). */
  getScopedAmbientIndex(repoScope: string, writeScopes: string[], maxItems = 5): KbCard[] {
    if (writeScopes.length === 0) return [];
    return this.search({
      repoScope,
      pathGlobs: writeScopes,
      kinds: ["invariant", "gotcha"],
      includeCandidates: false,
      includeStale: false,
      limit: maxItems,
    });
  }

  flagStale(id: string, reason: string): KbEntry {
    const existing = this.getRaw(id);
    if (!existing) throw new Error(`Unknown KB entry ${id}`);
    this.db
      .prepare("UPDATE kb_entries SET status = 'stale', stale_reason = ?, updated_at = ? WHERE id = ?")
      .run(reason.slice(0, 500), Date.now(), existing.id);
    return this.getRaw(existing.id)!;
  }

  promote(id: string, patch?: { title?: string; summary?: string; contextMd?: string; verifiedSha?: string }): KbEntry {
    const existing = this.getRaw(id);
    if (!existing) throw new Error(`Unknown KB entry ${id}`);
    this.db
      .prepare(
        `UPDATE kb_entries
         SET status = 'active', confidence = 'verified',
             title = ?, summary = ?, context_md = ?,
             verified_sha = COALESCE(?, verified_sha),
             last_checked_sha = COALESCE(?, last_checked_sha),
             stale_reason = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch?.title ?? existing.title,
        patch?.summary ?? existing.summary,
        patch?.contextMd ?? existing.contextMd,
        patch?.verifiedSha ?? null,
        patch?.verifiedSha ?? null,
        Date.now(),
        existing.id,
      );
    return this.getRaw(existing.id)!;
  }

  markCheckedClean(id: string, headSha: string): void {
    const existing = this.getRaw(id);
    if (!existing) return;
    this.db
      .prepare("UPDATE kb_entries SET last_checked_sha = ?, updated_at = ? WHERE id = ?")
      .run(headSha, Date.now(), existing.id);
  }

  /** Bi-temporal archival: never hard-delete; preserve history via `superseded_by`. */
  archive(id: string, opts?: { reason?: string; supersededBy?: string }): KbEntry {
    const existing = this.getRaw(id);
    if (!existing) throw new Error(`Unknown KB entry ${id}`);
    const supersededBy = opts?.supersededBy ? (this.getRaw(opts.supersededBy)?.id ?? opts.supersededBy) : null;
    this.db
      .prepare("UPDATE kb_entries SET status = 'archived', stale_reason = ?, superseded_by = ?, updated_at = ? WHERE id = ?")
      .run(opts?.reason ?? existing.staleReason, supersededBy, Date.now(), existing.id);
    return this.getRaw(existing.id)!;
  }

  listByStatus(repoScope: string, status: KbStatus): KbEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM kb_entries WHERE repo_scope = ? AND status = ? ORDER BY updated_at ASC")
      .all(repoScope, status) as Record<string, unknown>[];
    return rows.map((r) => this.mapEntry(r));
  }

  stats(repoScope: string): { candidate: number; active: number; stale: number; archived: number; candidateBytes: number } {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS cnt, COALESCE(SUM(LENGTH(title) + LENGTH(summary) + LENGTH(context_md)), 0) AS bytes
         FROM kb_entries WHERE repo_scope = ? GROUP BY status`,
      )
      .all(repoScope) as Array<{ status: KbStatus; cnt: number; bytes: number }>;
    const out = { candidate: 0, active: 0, stale: 0, archived: 0, candidateBytes: 0 };
    for (const r of rows) {
      out[r.status] = Number(r.cnt);
      if (r.status === "candidate") out.candidateBytes = Number(r.bytes);
    }
    return out;
  }
}
