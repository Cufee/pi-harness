import type {
  ArtifactRecord,
  EscalationRecord,
  MergeQueueRecord,
  MessageRecord,
  RunRecord,
  TaskRecord,
  WorktreeRecord,
} from "../control-plane/db.js";
import type { RunActivitySummary, TaskActivitySnapshot } from "../control-plane/telemetry.js";
import type { TimerRecord } from "../control-plane/timers.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { GoalActiveVerification } from "../director/goal-get.js";
import type { GoalRecord, GoalReviewVerdict, GoalRevisionRecord } from "../goals/engine.js";
import type { DaemonEventFrame, InboxItem, SnapshotWorktreeEntry } from "../protocol/daemon-rpc.js";
import type { TuiEntityRef as EntityRef } from "./core/index.js";

export interface AttachableSession {
  id: string;
  host?: string;
  nodeId?: string | null;
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
  activeVerification?: GoalActiveVerification | null;
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
  internalAttention?: InboxItem[];
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
  internalAttention: [],
};

const WORK_EVENT_PREFIXES = ["goal.", "escalation.", "quota."];
const WORK_EVENT_EXACT = new Set([
  "run.status",
  "run.created",
  "task.created",
  "task.status",
  "task.resumed",
  "agent.timer_sleep",
  "agent.rollover",
]);

/** How a goal, run, or agent shows in the work tree: `active` and `blocked` rows are shown by default. */
export type WorkState = "blocked" | "active" | "queued" | "done";

export interface WorkTreeNode {
  kind: "goal" | "run" | "task";
  id: string;
  title: string;
  status: string;
  state: WorkState;
  /** `T1/execute · model` for agents; empty for goals and runs. */
  agent: string;
  /** What is happening right now, or what the item is waiting on. */
  activity: string;
  updatedAt: number;
  ref: EntityRef;
  children: WorkTreeNode[];
}

export interface WorkSummary {
  active: number;
  blocked: number;
  /** The first blocked item, so the dock can name it. */
  firstBlocked: WorkTreeNode | null;
}

const GOAL_STATE: Record<GoalRecord["status"], WorkState> = {
  draft: "queued",
  executing: "active",
  verifying: "active",
  reviewing: "active",
  awaiting_human: "blocked",
  paused: "blocked",
  achieved: "done",
  cancelled: "done",
};

const TASK_STATE: Record<TaskRecord["status"], WorkState> = {
  running: "active",
  merging: "active",
  draining: "active",
  waiting_children: "active",
  blocked: "blocked",
  returned_for_rescope: "blocked",
  paused_quota: "blocked",
  pending: "queued",
  ready: "queued",
  completed: "done",
  failed: "done",
  cancelled: "done",
};

const RUN_STATE: Record<RunRecord["status"], WorkState> = {
  active: "active",
  paused_quota: "blocked",
  completed: "done",
  failed: "done",
  stopped: "done",
};

const STATE_ORDER: Record<WorkState, number> = { blocked: 0, active: 1, queued: 2, done: 3 };

function isShownByDefault(state: WorkState): boolean {
  return state === "active" || state === "blocked";
}

function sortNodes(nodes: WorkTreeNode[]): WorkTreeNode[] {
  return nodes.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.updatedAt - a.updatedAt);
}

/** An open escalation that waits on a person; the Director relays it, the tree only marks the item blocked. */
function openHumanEscalation(run: SnapshotRunEntry | undefined): EscalationRecord | undefined {
  return run?.escalations.find((e) => e.status !== "resolved" && (e.blocking || e.severity === "P0"));
}

/**
 * Keeps a node when it, or anything under it, passes the filter. With `all` unset, only active and
 * blocked items pass, so finished, queued, and failed work drops out of the tree.
 */
function filterTree(nodes: WorkTreeNode[], all: boolean): WorkTreeNode[] {
  const out: WorkTreeNode[] = [];
  for (const node of nodes) {
    const children = filterTree(node.children, all);
    if (all || isShownByDefault(node.state) || children.length > 0) out.push({ ...node, children });
  }
  return out;
}

/**
 * Normalized client-side state store fed by `work.snapshot` and debounced live daemon events.
 * Shared by the dock, the work tree, and inspectors.
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

  get currentScope(): Readonly<{ chatSessionId?: string; repoRoot?: string; runId?: string }> {
    return this.scope;
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
    } else if (ev.type === "agent.tool") {
      // Attached-run streams deliver tool calls; refresh with a gentler debounce so live currentAction stays fresh.
      this.scheduleRefresh(600);
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
      await this.inflight;
      if (this.inflight) return this.inflight;
      return this.snapshot;
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

  /**
   * Builds the goal → run → agent tree. Agents nest strictly by `parentId`, whatever their tier or kind,
   * so a run with a lone Tier 1 agent and a Tier 1 agent with Tier 3 children both render as they are.
   * Synthetic `director` placeholder tasks are skipped and their children move up a level.
   * With `all` unset, only active and blocked items (and the parents that lead to them) are kept.
   */
  buildWorkTree(opts: { all?: boolean } = {}): WorkTreeNode[] {
    const linkedRunIds = new Set<string>();
    const roots: WorkTreeNode[] = [];

    for (const { goal } of this.snapshot.goals) {
      const run = goal.linkedRunId ? this.getRunEntry(goal.linkedRunId) : undefined;
      if (goal.linkedRunId) linkedRunIds.add(goal.linkedRunId);
      const humanEsc = openHumanEscalation(run);
      const quotaPaused = run?.run.status === "paused_quota" || Boolean(run?.quotaPause);
      const ownState = GOAL_STATE[goal.status] ?? "queued";
      const state: WorkState = ownState === "done" ? "done" : humanEsc || quotaPaused ? "blocked" : ownState;
      roots.push({
        kind: "goal",
        id: goal.id,
        title: goal.title,
        status: humanEsc && ownState !== "blocked" ? "blocked" : quotaPaused && ownState !== "blocked" ? "paused_quota" : goal.status,
        state,
        agent: "",
        activity: this.describeGoalActivity(goal, run, humanEsc),
        updatedAt: Math.max(goal.updatedAt, run?.run.updatedAt ?? 0),
        ref: { kind: "goal", id: goal.id, runId: goal.linkedRunId ?? undefined, label: `${goal.id} ${goal.title}` },
        children: run ? this.buildTaskNodes(run) : [],
      });
    }

    for (const run of this.snapshot.runs) {
      if (linkedRunIds.has(run.run.id) || (run.goalId && this.getGoalEntry(run.goalId))) continue;
      const isDirectorContainer = run.run.id.startsWith("director-tasks-");
      const quotaPaused = Boolean(run.quotaPause);
      roots.push({
        kind: "run",
        id: run.run.id,
        title: isDirectorContainer ? "Director subagents" : (run.run.goal.split("\n")[0] ?? run.run.id).trim(),
        status: quotaPaused && run.run.status === "active" ? "paused_quota" : run.run.status,
        state: quotaPaused && run.run.status === "active" ? "blocked" : RUN_STATE[run.run.status] ?? "done",
        agent: "",
        activity: run.quotaPause ? `quota paused: ${run.quotaPause.reason}` : "",
        updatedAt: run.run.updatedAt,
        ref: { kind: "run", id: run.run.id, label: run.run.id },
        children: this.buildTaskNodes(run),
      });
    }

    const tree = opts.all ? roots : filterTree(roots, false);
    const sortDeep = (nodes: WorkTreeNode[]): WorkTreeNode[] => {
      for (const n of nodes) sortDeep(n.children);
      return sortNodes(nodes);
    };
    return sortDeep(tree);
  }

  /** Counts active agents and blocked items in the default (active + blocked) tree. */
  workSummary(): WorkSummary {
    let active = 0;
    let blocked = 0;
    let firstBlocked: WorkTreeNode | null = null;
    const walk = (nodes: WorkTreeNode[]) => {
      for (const n of nodes) {
        if (n.state === "blocked") {
          blocked++;
          firstBlocked ??= n;
        } else if (n.state === "active" && n.kind === "task") {
          active++;
        }
        walk(n.children);
      }
    };
    walk(this.buildWorkTree());
    return { active, blocked, firstBlocked };
  }

  /** True when any goal, run, or agent is in flight (drives gentle live polling of the snapshot). */
  hasLiveWork(): boolean {
    const walk = (nodes: WorkTreeNode[]): boolean =>
      nodes.some((n) => n.state === "active" || n.state === "blocked" || walk(n.children));
    return walk(this.buildWorkTree());
  }

  private buildTaskNodes(run: SnapshotRunEntry): WorkTreeNode[] {
    const activityById = new Map((run.activity?.tasks ?? []).map((t) => [t.id, t]));
    const ids = new Set(run.tasks.map((t) => t.id));
    const childrenOf = new Map<string | null, TaskRecord[]>();
    for (const t of run.tasks) {
      const parent = t.parentId && ids.has(t.parentId) ? t.parentId : null;
      const list = childrenOf.get(parent) ?? [];
      list.push(t);
      childrenOf.set(parent, list);
    }
    const build = (parentId: string | null): WorkTreeNode[] => {
      const out: WorkTreeNode[] = [];
      for (const t of childrenOf.get(parentId) ?? []) {
        if (t.profileId === "director") {
          out.push(...build(t.id));
          continue;
        }
        const live = activityById.get(t.id);
        out.push({
          kind: "task",
          id: t.id,
          title: t.title,
          status: t.status,
          state: TASK_STATE[t.status] ?? "queued",
          agent: `T${t.tier}/${t.kind}${t.model ? ` · ${t.model}` : ""}`,
          activity: describeTaskActivity(t, live),
          updatedAt: t.updatedAt,
          ref: { kind: "task", id: t.id, runId: t.runId, label: `${t.id} ${t.title}` },
          children: build(t.id),
        });
      }
      return out;
    };
    return build(null);
  }

  private describeGoalActivity(goal: GoalRecord, run: SnapshotRunEntry | undefined, humanEsc: EscalationRecord | undefined): string {
    if (goal.status === "awaiting_human") return `needs your input: ${goal.lastReviewSummary || "reply in the Director chat"}`;
    if (goal.status === "paused") return "paused";
    if (humanEsc) return `needs your input: ${humanEsc.title}`;
    if (run?.quotaPause) return `quota paused: ${run.quotaPause.reason}`;
    const lp = goal.liveProgress;
    const phase = lp?.phase?.trim() || "";
    const summary = lp?.summary?.trim() || "";
    if (phase && summary) return summary.toLowerCase().startsWith(phase.toLowerCase()) ? summary : `${phase}: ${summary}`;
    if (summary || phase) return summary || phase;
    if (goal.status === "reviewing" && goal.reviewCycle > 0) return `review cycle ${goal.reviewCycle}`;
    return goal.lastReviewSummary || "";
  }
}

function describeTaskActivity(t: TaskRecord, live: TaskActivitySnapshot | undefined): string {
  if (live?.currentAction && TASK_STATE[t.status] === "active") return live.currentAction;
  switch (t.status) {
    case "waiting_children":
      return "waiting on its agents";
    case "blocked":
      return t.summary ? `blocked: ${t.summary}` : "blocked";
    case "returned_for_rescope":
      return t.summary ? `returned for rescope: ${t.summary}` : "returned for rescope";
    case "paused_quota":
      return "paused (quota)";
    case "pending":
    case "ready":
      return "queued";
    default:
      return t.summary ?? live?.currentAction ?? "";
  }
}

export type { ArtifactRecord, EscalationRecord, GoalActiveVerification, GoalRecord, MergeQueueRecord, MessageRecord, RunRecord, TaskRecord, TimerRecord, WorktreeRecord };
