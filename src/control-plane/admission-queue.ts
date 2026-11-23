import type { Database } from "bun:sqlite";

export type AdmissionLane = "goal" | "worker";
export type QueuePositionInput = number | "front" | "back";

export interface AdmissionQueueEntry {
  lane: AdmissionLane;
  repoRoot: string;
  targetId: string;
  /** 1-based dense position within `(lane, repoRoot)` — 1 is next up. */
  position: number;
  forceStart: boolean;
  launchOpts: Record<string, unknown> | null;
  note: string | null;
  createdAt: number;
}

export const ADMISSION_QUEUE_SCHEMA = `
CREATE TABLE IF NOT EXISTS admission_queue (
  lane TEXT NOT NULL CHECK (lane IN ('goal','worker')),
  repo_root TEXT NOT NULL,
  target_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  force_start INTEGER NOT NULL DEFAULT 0,
  launch_opts_json TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lane, target_id)
);
CREATE INDEX IF NOT EXISTS idx_admission_queue_order ON admission_queue(lane, repo_root, force_start DESC, position ASC, created_at ASC);
`;

/**
 * Unified durable admission queue backing BOTH Goals (`maxConcurrentGoals`) and Tier 2 Workers
 * (`maxConcurrentWorkers`). Supports inserting at any position, reordering dynamically,
 * force-starting urgent work, and instant sub-millisecond wakeups when capacity or limits change.
 */
export class AdmissionQueue {
  private listeners = new Set<(lane?: AdmissionLane) => void>();

  constructor(private readonly db: Database) {
    this.db.exec(ADMISSION_QUEUE_SCHEMA);
  }

  onChange(fn: (lane?: AdmissionLane) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(lane?: AdmissionLane): void {
    for (const fn of this.listeners) {
      try {
        fn(lane);
      } catch {
        // never let listener errors break queue commits
      }
    }
  }

  private mapRow(r: Record<string, unknown>): AdmissionQueueEntry {
    let launchOpts: Record<string, unknown> | null = null;
    if (r.launch_opts_json) {
      try {
        launchOpts = JSON.parse(String(r.launch_opts_json)) as Record<string, unknown>;
      } catch {
        launchOpts = null;
      }
    }
    return {
      lane: String(r.lane) as AdmissionLane,
      repoRoot: String(r.repo_root),
      targetId: String(r.target_id),
      position: Number(r.position),
      forceStart: Number(r.force_start ?? 0) !== 0,
      launchOpts,
      note: r.note ? String(r.note) : null,
      createdAt: Number(r.created_at),
    };
  }

  private normalizePositions(lane: AdmissionLane, repoRoot: string): void {
    const rows = this.db
      .prepare(
        `SELECT target_id FROM admission_queue
         WHERE lane = ? AND repo_root = ?
         ORDER BY position ASC, created_at ASC`,
      )
      .all(lane, repoRoot) as Array<{ target_id: string }>;
    const stmt = this.db.prepare("UPDATE admission_queue SET position = ? WHERE lane = ? AND target_id = ?");
    for (let i = 0; i < rows.length; i++) {
      stmt.run(i + 1, lane, rows[i]!.target_id);
    }
  }

  private resolveTargetIndex(count: number, position?: QueuePositionInput): number {
    if (position === undefined || position === "back") return count;
    if (position === "front") return 0;
    const n = Math.floor(Number(position));
    if (!Number.isFinite(n) || n <= 1) return 0;
    return Math.min(count, n - 1);
  }

  get(lane: AdmissionLane, targetId: string): AdmissionQueueEntry | null {
    const row = this.db
      .prepare("SELECT * FROM admission_queue WHERE lane = ? AND target_id = ?")
      .get(lane, targetId) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(opts?: { lane?: AdmissionLane; repoRoot?: string }): AdmissionQueueEntry[] {
    const clauses: string[] = [];
    const params: Array<string | number> = [];
    if (opts?.lane) {
      clauses.push("lane = ?");
      params.push(opts.lane);
    }
    if (opts?.repoRoot) {
      clauses.push("repo_root = ?");
      params.push(opts.repoRoot);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM admission_queue ${where} ORDER BY lane ASC, repo_root ASC, force_start DESC, position ASC, created_at ASC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  enqueue(input: {
    lane: AdmissionLane;
    repoRoot: string;
    targetId: string;
    position?: QueuePositionInput;
    forceStart?: boolean;
    launchOpts?: Record<string, unknown> | null;
    note?: string | null;
  }): AdmissionQueueEntry {
    const entry = this.db.transaction(() => {
      const existing = this.get(input.lane, input.targetId);
      const siblings = this.db
        .prepare(
          `SELECT target_id FROM admission_queue
           WHERE lane = ? AND repo_root = ? AND target_id != ?
           ORDER BY position ASC, created_at ASC`,
        )
        .all(input.lane, input.repoRoot, input.targetId) as Array<{ target_id: string }>;

      const ordered = siblings.map((s) => s.target_id);
      const insertIdx =
        existing && input.position === undefined
          ? Math.min(ordered.length, Math.max(0, existing.position - 1))
          : this.resolveTargetIndex(ordered.length, input.position);
      ordered.splice(insertIdx, 0, input.targetId);

      const now = existing?.createdAt ?? Date.now();
      const force = input.forceStart !== undefined ? (input.forceStart ? 1 : 0) : existing?.forceStart ? 1 : 0;
      const optsJson =
        input.launchOpts !== undefined
          ? input.launchOpts
            ? JSON.stringify(input.launchOpts)
            : null
          : existing?.launchOpts
            ? JSON.stringify(existing.launchOpts)
            : null;
      const note = input.note !== undefined ? input.note : existing?.note ?? null;

      this.db
        .prepare(
          `INSERT INTO admission_queue(lane, repo_root, target_id, position, force_start, launch_opts_json, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(lane, target_id) DO UPDATE SET
             repo_root = excluded.repo_root,
             position = excluded.position,
             force_start = excluded.force_start,
             launch_opts_json = excluded.launch_opts_json,
             note = excluded.note`,
        )
        .run(input.lane, input.repoRoot, input.targetId, insertIdx + 1, force, optsJson, note, now);

      const upd = this.db.prepare("UPDATE admission_queue SET position = ? WHERE lane = ? AND target_id = ?");
      for (let i = 0; i < ordered.length; i++) {
        upd.run(i + 1, input.lane, ordered[i]!);
      }
      return this.get(input.lane, input.targetId)!;
    }).immediate();

    this.notify(input.lane);
    return entry;
  }

  reorder(lane: AdmissionLane, targetId: string, position: QueuePositionInput): AdmissionQueueEntry {
    const existing = this.get(lane, targetId);
    if (!existing) {
      throw new Error(`Item "${targetId}" is not queued in the ${lane} admission queue.`);
    }
    return this.enqueue({
      lane,
      repoRoot: existing.repoRoot,
      targetId,
      position,
      forceStart: existing.forceStart,
      launchOpts: existing.launchOpts,
      note: existing.note,
    });
  }

  markForceStart(lane: AdmissionLane, targetId: string): AdmissionQueueEntry | null {
    const existing = this.get(lane, targetId);
    if (!existing) return null;
    this.db.prepare("UPDATE admission_queue SET force_start = 1 WHERE lane = ? AND target_id = ?").run(lane, targetId);
    const updated = this.get(lane, targetId)!;
    this.notify(lane);
    return updated;
  }

  remove(lane: AdmissionLane, targetId: string): boolean {
    const existing = this.get(lane, targetId);
    if (!existing) return false;
    const removed = this.db.transaction(() => {
      const res = this.db.prepare("DELETE FROM admission_queue WHERE lane = ? AND target_id = ?").run(lane, targetId);
      if (res.changes > 0) this.normalizePositions(lane, existing.repoRoot);
      return res.changes > 0;
    }).immediate();
    if (removed) this.notify(lane);
    return removed;
  }

  peekNext(lane: AdmissionLane, repoRoot: string): AdmissionQueueEntry | null {
    const row = this.db
      .prepare(
        `SELECT * FROM admission_queue
         WHERE lane = ? AND repo_root = ?
         ORDER BY force_start DESC, position ASC, created_at ASC
         LIMIT 1`,
      )
      .get(lane, repoRoot) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Returns true if `targetId` is marked `forceStart` OR is currently #1 in line for `(lane, repoRoot)`. */
  isFrontOrForced(lane: AdmissionLane, repoRoot: string, targetId: string): boolean {
    const entry = this.get(lane, targetId);
    if (!entry) return true;
    if (entry.forceStart) return true;
    const next = this.peekNext(lane, repoRoot);
    return !next || next.targetId === targetId;
  }
}
