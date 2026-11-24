import type { Database } from "bun:sqlite";
import { friendlyIdCandidates, nextFriendlyId } from "./ids.js";

export type TimerOwnerKind = "chat" | "task";
export type TimerStatus = "pending" | "fired" | "cancelled";
export type TimerWakeEvent = "none" | "user_message" | "goal_settled" | "child_settled" | "any";

export interface TimerRecord {
  id: string;
  ownerKind: TimerOwnerKind;
  ownerId: string;
  runId: string | null;
  goalId: string | null;
  wakeAt: number;
  reason: string;
  wakeOnEvent: TimerWakeEvent;
  resumeGoal: boolean;
  status: TimerStatus;
  firedReason: string | null;
  createdAt: number;
  firedAt: number | null;
}

/**
 * Whether a pending chat timer's early-cancel subscription covers `goal` settling.
 * A timer bound to a Goal matches only that Goal. Only an unbound `any` timer matches every
 * Goal owned by its chat session. An unbound `goal_settled` timer matches nothing and fires
 * at `wakeAt` (the Director refuses to schedule one; rows from older versions may exist).
 */
export function timerMatchesGoalSettlement(
  timer: Pick<TimerRecord, "ownerKind" | "ownerId" | "goalId" | "wakeOnEvent">,
  goal: { id: string; chatSessionId: string | null },
): boolean {
  if (timer.ownerKind !== "chat" || timer.ownerId !== goal.chatSessionId) return false;
  if (timer.wakeOnEvent === "any") return !timer.goalId || timer.goalId === goal.id;
  return timer.wakeOnEvent === "goal_settled" && Boolean(timer.goalId) && timer.goalId === goal.id;
}

const TIMER_SCHEMA = `
CREATE TABLE IF NOT EXISTS timers (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('chat','task')),
  owner_id TEXT NOT NULL,
  run_id TEXT,
  goal_id TEXT,
  wake_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  wake_on_event TEXT NOT NULL DEFAULT 'none',
  resume_goal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','cancelled')),
  fired_reason TEXT,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_timers_status_wake ON timers(status, wake_at);
CREATE INDEX IF NOT EXISTS idx_timers_owner ON timers(owner_kind, owner_id, status);
`;

/** Max safe delay per JS `setTimeout` call (~23.1 days, safely under 2^31-1 ms). */
const MAX_TIMEOUT_CHUNK_MS = 2_000_000_000;

/**
 * Durable SQLite-backed timer & self-pacing scheduler for Director chats and subagent tasks.
 *
 * - Survives daemon restarts (`restorePending()`).
 * - Safely supports multi-hour / multi-day quota-reset waits via chunked `setTimeout`.
 * - Supports event-driven early wakeups (`user_message`, `goal_settled`, `child_settled`, `any`).
 * - Uses model-friendly sequential IDs (`timer-1`, `timer-2`, ...).
 */
export class TimerManager {
  private handles = new Map<string, ReturnType<typeof setTimeout>>();
  private waiters = new Map<string, Set<(res: { timer: TimerRecord; wakeReason: string }) => void>>();
  private onFireCallback: ((timer: TimerRecord, wakeReason: string) => void) | null = null;
  private disposed = false;
  private suspendMode: "none" | "startup" | "stopping" = "none";

  constructor(private readonly db: Database) {
    this.db.exec(TIMER_SCHEMA);
  }

  setOnFire(cb: (timer: TimerRecord, wakeReason: string) => void): void {
    this.onFireCallback = cb;
  }

  /**
   * Suspends arming, firing, and early triggers during daemon startup/Phase B until `restorePending()`
   * runs. Unlike `suspend()`, `schedule()` still inserts pending rows (unarmed) so continuation turns
   * and early-relaunched tasks can schedule timers before Phase B finishes.
   */
  suspendForStartup(): void {
    if (this.suspendMode !== "none") return;
    this.suspendMode = "startup";
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
  }

  /**
   * Suspends timer firing and creation during daemon drain/stop without mutating SQLite rows.
   * Pending rows stay `pending` for the next daemon start; active waiters unblock with `daemon_restart`.
   */
  suspend(): void {
    if (this.suspendMode === "stopping") return;
    this.suspendMode = "stopping";
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
    const pendingWaiters = [...this.waiters.entries()];
    this.waiters.clear();
    for (const [id, set] of pendingWaiters) {
      const rec = this.get(id);
      if (!rec) continue;
      for (const fn of set) {
        fn({ timer: rec, wakeReason: "daemon_restart" });
      }
    }
  }

  /** Un-suspends startup suspension (if active) and re-arms any pending timers persisted before a daemon restart. */
  restorePending(): void {
    if (this.disposed || this.suspendMode === "stopping") return;
    if (this.suspendMode === "startup") {
      this.suspendMode = "none";
    }
    const rows = this.db
      .prepare("SELECT * FROM timers WHERE status = 'pending' ORDER BY wake_at ASC")
      .all() as Record<string, unknown>[];
    for (const r of rows) {
      this.armHandle(this.mapRow(r));
    }
  }

  schedule(input: {
    ownerKind: TimerOwnerKind;
    ownerId: string;
    runId?: string | null;
    goalId?: string | null;
    delaySeconds?: number;
    wakeAtIso?: string;
    reason: string;
    wakeOnEvent?: TimerWakeEvent;
    resumeGoal?: boolean;
  }): TimerRecord {
    if (this.suspendMode === "stopping") {
      throw new Error(
        "harnessd is restarting, so no new timer can be created. Existing timers stay scheduled and fire after the restart. Tier 1 and 2: call request_rollover now.",
      );
    }
    const now = Date.now();
    let wakeAt: number;
    if (typeof input.wakeAtIso === "string" && input.wakeAtIso.trim()) {
      const parsed = Date.parse(input.wakeAtIso.trim());
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid wake_at ISO timestamp: ${input.wakeAtIso}`);
      }
      wakeAt = parsed;
    } else if (typeof input.delaySeconds === "number" && Number.isFinite(input.delaySeconds)) {
      if (input.delaySeconds < 0) throw new Error("delay_seconds must be >= 0");
      wakeAt = now + Math.round(input.delaySeconds * 1000);
    } else {
      throw new Error("Timer requires either delay_seconds or wake_at (ISO timestamp)");
    }

    const reason = input.reason.trim() || "Scheduled wakeup";
    const wakeOnEvent: TimerWakeEvent = input.wakeOnEvent ?? "none";
    const id = nextFriendlyId(this.db, "timer", "timers");

    this.db
      .prepare(
        `INSERT INTO timers(
          id, owner_kind, owner_id, run_id, goal_id, wake_at, reason,
          wake_on_event, resume_goal, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      )
      .run(
        id,
        input.ownerKind,
        input.ownerId,
        input.runId ?? null,
        input.goalId ?? null,
        wakeAt,
        reason,
        wakeOnEvent,
        input.resumeGoal ? 1 : 0,
        now,
      );

    const record = this.get(id)!;
    this.armHandle(record);
    return record;
  }

  get(id: string): TimerRecord | null {
    for (const candidate of friendlyIdCandidates(id, "timer")) {
      const r = this.db.prepare("SELECT * FROM timers WHERE id = ?").get(candidate) as Record<string, unknown> | undefined;
      if (r) return this.mapRow(r);
    }
    return null;
  }

  list(filter?: { ownerKind?: TimerOwnerKind; ownerId?: string; status?: TimerStatus }): TimerRecord[] {
    let sql = "SELECT * FROM timers WHERE 1=1";
    const params: string[] = [];
    if (filter?.ownerKind) {
      sql += " AND owner_kind = ?";
      params.push(filter.ownerKind);
    }
    if (filter?.ownerId) {
      sql += " AND owner_id = ?";
      params.push(filter.ownerId);
    }
    if (filter?.status) {
      sql += " AND status = ?";
      params.push(filter.status);
    }
    sql += " ORDER BY wake_at ASC";
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => this.mapRow(r));
  }

  cancel(id: string, reason = "cancelled"): TimerRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (existing.status !== "pending") return existing;

    this.clearHandle(existing.id);
    const now = Date.now();
    this.db
      .prepare("UPDATE timers SET status = 'cancelled', fired_reason = ?, fired_at = ? WHERE id = ? AND status = 'pending'")
      .run(reason, now, existing.id);
    const updated = this.get(existing.id)!;
    this.resolveWaiters(existing.id, updated, reason);
    return updated;
  }

  /** Fires any pending timers matching `predicate` early (e.g. when a subscribed event occurs). */
  triggerEarly(predicate: (t: TimerRecord) => boolean, wakeReason: string): TimerRecord[] {
    if (this.disposed || this.suspendMode !== "none") return [];
    const pending = this.list({ status: "pending" });
    const fired: TimerRecord[] = [];
    for (const t of pending) {
      if (predicate(t)) {
        const res = this.fire(t.id, wakeReason);
        if (res) fired.push(res);
      }
    }
    return fired;
  }

  /** Blocks until the given timer fires, is cancelled, or `signal` aborts. Zero polling / zero tokens. */
  waitForTimer(id: string, signal?: AbortSignal): Promise<{ timer: TimerRecord; wakeReason: string }> {
    const existing = this.get(id);
    if (!existing) return Promise.reject(new Error(`Unknown timer ${id}`));
    if (existing.status !== "pending") {
      return Promise.resolve({ timer: existing, wakeReason: existing.firedReason ?? existing.status });
    }
    if (this.suspendMode === "stopping") {
      return Promise.resolve({ timer: existing, wakeReason: "daemon_restart" });
    }
    if (signal?.aborted) {
      const cancelled = this.cancel(existing.id, "aborted") ?? existing;
      return Promise.resolve({ timer: cancelled, wakeReason: "aborted" });
    }

    return new Promise((resolve) => {
      let set = this.waiters.get(existing.id);
      if (!set) {
        set = new Set();
        this.waiters.set(existing.id, set);
      }
      const onAbort = () => {
        set?.delete(onDone);
        if (set?.size === 0) this.waiters.delete(existing.id);
        if (this.suspendMode === "stopping") {
          resolve({ timer: this.get(existing.id) ?? existing, wakeReason: "daemon_restart" });
          return;
        }
        const cancelled = this.cancel(existing.id, "aborted") ?? this.get(existing.id) ?? existing;
        resolve({ timer: cancelled, wakeReason: "aborted" });
      };
      const onDone = (res: { timer: TimerRecord; wakeReason: string }) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(res);
      };
      set.add(onDone);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.handles.values()) clearTimeout(h);
    this.handles.clear();
    for (const [id, set] of this.waiters) {
      const rec = this.get(id);
      for (const fn of set) {
        if (rec) fn({ timer: rec, wakeReason: "disposed" });
      }
    }
    this.waiters.clear();
  }

  private armHandle(timer: TimerRecord): void {
    if (this.disposed || this.suspendMode !== "none" || timer.status !== "pending") return;
    this.clearHandle(timer.id);

    const remaining = timer.wakeAt - Date.now();
    if (remaining <= 0) {
      const h = setTimeout(() => {
        this.handles.delete(timer.id);
        if (this.disposed || this.suspendMode !== "none") return;
        this.fire(timer.id, "timer_expired");
      }, 0);
      h.unref?.();
      this.handles.set(timer.id, h);
      return;
    }

    const chunk = Math.min(remaining, MAX_TIMEOUT_CHUNK_MS);
    const h = setTimeout(() => {
      this.handles.delete(timer.id);
      if (this.disposed || this.suspendMode !== "none") return;
      const latest = this.get(timer.id);
      if (!latest || latest.status !== "pending") return;
      if (latest.wakeAt - Date.now() > 50) {
        this.armHandle(latest);
      } else {
        this.fire(latest.id, "timer_expired");
      }
    }, chunk);
    h.unref?.();
    this.handles.set(timer.id, h);
  }

  private fire(id: string, wakeReason: string): TimerRecord | null {
    if (this.suspendMode !== "none") return null;
    this.clearHandle(id);
    const now = Date.now();
    const res = this.db
      .prepare("UPDATE timers SET status = 'fired', fired_reason = ?, fired_at = ? WHERE id = ? AND status = 'pending'")
      .run(wakeReason, now, id);
    if (res.changes === 0) return null;
    const updated = this.get(id)!;
    this.resolveWaiters(id, updated, wakeReason);
    if (!this.disposed) {
      this.onFireCallback?.(updated, wakeReason);
    }
    return updated;
  }

  private clearHandle(id: string): void {
    const h = this.handles.get(id);
    if (h) {
      clearTimeout(h);
      this.handles.delete(id);
    }
  }

  private resolveWaiters(id: string, timer: TimerRecord, wakeReason: string): void {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const fn of set) fn({ timer, wakeReason });
  }

  private mapRow(r: Record<string, unknown>): TimerRecord {
    return {
      id: String(r.id),
      ownerKind: String(r.owner_kind) as TimerOwnerKind,
      ownerId: String(r.owner_id),
      runId: r.run_id ? String(r.run_id) : null,
      goalId: r.goal_id ? String(r.goal_id) : null,
      wakeAt: Number(r.wake_at),
      reason: String(r.reason),
      wakeOnEvent: String(r.wake_on_event ?? "none") as TimerWakeEvent,
      resumeGoal: Boolean(r.resume_goal),
      status: String(r.status) as TimerStatus,
      firedReason: r.fired_reason ? String(r.fired_reason) : null,
      createdAt: Number(r.created_at),
      firedAt: r.fired_at == null ? null : Number(r.fired_at),
    };
  }
}
