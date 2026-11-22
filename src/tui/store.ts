import type {
  ArtifactRecord,
  EscalationRecord,
  MergeQueueRecord,
  MessageRecord,
  RunRecord,
  TaskRecord,
  WorktreeRecord,
} from "../control-plane/db.js";
import type { RunActivitySummary } from "../control-plane/telemetry.js";
import type { TimerRecord } from "../control-plane/timers.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { GoalRecord, GoalReviewVerdict, GoalRevisionRecord } from "../goals/engine.js";
import type { DaemonEventFrame, InboxItem, SnapshotWorktreeEntry } from "../protocol/daemon-rpc.js";
import type { AttentionSlot, TuiEntityRef as EntityRef } from "./core/index.js";

export interface AttachableSession {
  id: string;
  host?: string;
  address?: string;
  kind: "chat" | "run";
  title: string;
  projectId?: string | null;
  projectName?: string | null;
  repoRoot: string;
  status: string;
  running: boolean;
  attached: boolean;
  attachedByMe?: boolean;
  activeGoals?: number;
  profileId?: string;
  model?: string | null;
  effort?: string | null;
  updatedAt: number;
}

export interface SnapshotGoalEntry {
  goal: GoalRecord;
  reviews: GoalReviewVerdict[];
  revisions: GoalRevisionRecord[];
}

export interface SnapshotRunEntry {
  run: RunRecord;
  goalId: string | null;
  tasks: TaskRecord[];
  escalations: EscalationRecord[];
  quotaPause: {
    mode: string;
    reason: string;
    resumeAt: number | null;
  } | null;
  activity: RunActivitySummary | null;
}

export interface WorkSnapshot {
  generatedAt: number;
  latestSeq: number;
  goals: SnapshotGoalEntry[];
  runs: SnapshotRunEntry[];
  escalations: EscalationRecord[];
  timers: TimerRecord[];
  merges: MergeQueueRecord[];
  worktrees: SnapshotWorktreeEntry[];
  messages: MessageRecord[];
  inbox: InboxItem[];
}

const EMPTY_SNAPSHOT: WorkSnapshot = {
  generatedAt: 0,
  latestSeq: 0,
  goals: [],
  runs: [],
  escalations: [],
  timers: [],
  merges: [],
  worktrees: [],
  messages: [],
  inbox: [],
};

const WORK_EVENT_PREFIXES = ["goal.", "escalation.", "merge.", "timer.", "quota.", "worktree."];
const WORK_EVENT_EXACT = new Set(["run.status", "run.created", "task.created", "task.status", "task.resumed"]);

/**
 * Normalized client-side state store fed by `work.snapshot` and debounced live daemon events.
 * Shared by Dock, Work Navigator, Inspectors, and Go-To-Anything palette.
 */
export class WorkStore {
  private snapshot: WorkSnapshot = EMPTY_SNAPSHOT;
  private listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<WorkSnapshot> | null = null;
  private pendingRefresh = false;
  private disposed = false;
  private detachEvent: (() => void) | null = null;
  lastError: string | null = null;

  constructor(
    private readonly client: DaemonClient,
    private scope: { chatSessionId?: string; repoRoot?: string; runId?: string },
  ) {
    this.detachEvent = client.onEvent((ev) => this.handleDaemonEvent(ev));
  }

  setScope(scope: { chatSessionId?: string; repoRoot?: string; runId?: string }): void {
    this.scope = scope;
  }

  get state(): WorkSnapshot {
    return this.snapshot;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // ignore listener errors
      }
    }
  }

  private handleDaemonEvent(ev: DaemonEventFrame): void {
    if (this.disposed) return;
    if (ev.watchId) return; // watch frames are handled by live transcript inspector
    if (
      WORK_EVENT_EXACT.has(ev.type) ||
      WORK_EVENT_PREFIXES.some((p) => ev.type.startsWith(p))
    ) {
      this.scheduleRefresh(140);
    }
  }

  scheduleRefresh(delayMs = 150): void {
    if (this.disposed) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh();
    }, delayMs);
    this.refreshTimer.unref?.();
  }

  async refresh(): Promise<WorkSnapshot> {
    if (this.disposed) return this.snapshot;
    if (this.inflight) {
      this.pendingRefresh = true;
      return this.inflight;
    }
    this.inflight = this.client
      .request<WorkSnapshot>("work.snapshot", {
        ...(this.scope.chatSessionId ? { chatSessionId: this.scope.chatSessionId } : {}),
        ...(this.scope.repoRoot ? { repoRoot: this.scope.repoRoot } : {}),
        ...(this.scope.runId ? { runId: this.scope.runId } : {}),
      })
      .then((snap) => {
        this.snapshot = snap ?? EMPTY_SNAPSHOT;
        this.lastError = null;
        this.emit();
        return this.snapshot;
      })
      .catch((err) => {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.emit();
        return this.snapshot;
      })
      .finally(() => {
        this.inflight = null;
        if (this.pendingRefresh && !this.disposed) {
          this.pendingRefresh = false;
          void this.refresh();
        }
      });
    return this.inflight;
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    this.detachEvent?.();
    this.detachEvent = null;
    this.listeners.clear();
  }

  getGoalEntry(goalId: string): SnapshotGoalEntry | undefined {
    return this.snapshot.goals.find((g) => g.goal.id === goalId);
  }

  getRunEntry(runId: string): SnapshotRunEntry | undefined {
    return this.snapshot.runs.find((r) => r.run.id === runId);
  }

  getEscalation(id: string): EscalationRecord | undefined {
    return this.snapshot.escalations.find((e) => e.id === id);
  }

  getTimer(id: string): TimerRecord | undefined {
    return this.snapshot.timers.find((t) => t.id === id);
  }

  getWorktree(id: string): SnapshotWorktreeEntry | undefined {
    return this.snapshot.worktrees.find((w) => w.id === id || w.path === id);
  }

  getMerge(id: string): MergeQueueRecord | undefined {
    return this.snapshot.merges.find((m) => m.id === id);
  }

  get openEscalationsCount(): number {
    return this.snapshot.escalations.filter((e) => e.status === "open").length;
  }

  get unresolvedEscalationsCount(): number {
    return this.snapshot.escalations.filter((e) => e.status === "open" || e.status === "acked").length;
  }

  get pendingTimersCount(): number {
    return this.snapshot.timers.filter((t) => t.status === "pending").length;
  }

  /**
   * Builds numbered attention slots for Row 1 of the FixedDock:
   *  - Open P0/P1 escalations and `awaiting_human` goals appear FIRST so blockers are always 1 keypress away.
   *  - Active/verifying/reviewing/paused goals follow, up to 5 compact slots.
   */
  buildAttentionSlots(maxSlots = 5): AttentionSlot[] {
    const slots: AttentionSlot[] = [];
    const seenKeys = new Set<string>();

    const pushSlot = (item: Omit<AttentionSlot, "slot">) => {
      if (slots.length >= maxSlots) return;
      const key = `${item.ref.kind}:${item.ref.id}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      slots.push({ slot: slots.length + 1, ...item });
    };

    // 1. Open escalations & awaiting_human goals from severity-sorted inbox
    for (const item of this.snapshot.inbox) {
      if (item.kind === "escalation" || item.kind === "goal_awaiting_human" || item.kind === "quota_paused") {
        const ref: EntityRef = {
          kind: item.ref.kind,
          id: item.ref.id,
          runId: item.ref.runId,
          goalId: item.ref.goalId,
          label: item.ref.label ?? item.title,
        };
        pushSlot({
          label: item.ref.id,
          status: item.severity === "P0" ? "p0" : item.kind === "goal_awaiting_human" ? "awaiting_human" : "p1",
          badge: item.kind === "escalation" ? item.severity : item.kind === "goal_awaiting_human" ? "input" : "quota",
          ref,
        });
      }
    }

    // 2. Active goals (executing / verifying / reviewing / paused / draft)
    const activeStatuses = new Set(["executing", "verifying", "reviewing", "awaiting_human", "paused"]);
    for (const entry of this.snapshot.goals) {
      const g = entry.goal;
      if (!activeStatuses.has(g.status)) continue;
      const run = g.linkedRunId ? this.getRunEntry(g.linkedRunId) : undefined;
      const openEsc = run ? run.escalations.filter((e) => e.status === "open").length : 0;
      const runningTasks = run ? run.tasks.filter((t) => t.status === "running").length : 0;
      const badge = openEsc > 0 ? `!${openEsc}` : runningTasks > 0 ? `${runningTasks}w` : g.status;
      pushSlot({
        label: `${g.id} ${g.title.slice(0, 18)}`,
        status: openEsc > 0 ? "blocked" : g.status,
        badge,
        ref: { kind: "goal", id: g.id, runId: g.linkedRunId ?? undefined, label: `${g.id} ${g.title}` },
      });
    }

    // 3. Standalone active runs not bound to a goal
    for (const r of this.snapshot.runs) {
      if (r.goalId) continue;
      if (r.run.id.startsWith("director-tasks-")) continue;
      if (r.run.status !== "active" && r.run.status !== "paused_quota") continue;
      const running = r.tasks.filter((t) => t.status === "running").length;
      pushSlot({
        label: r.run.id,
        status: r.run.status,
        badge: running > 0 ? `${running}w` : r.run.status,
        ref: { kind: "run", id: r.run.id, label: r.run.id },
      });
    }

    return slots;
  }
}

export type { ArtifactRecord, EscalationRecord, GoalRecord, MergeQueueRecord, MessageRecord, RunRecord, TaskRecord, TimerRecord, WorktreeRecord };
