import type { ReleaseTarget } from "../daemon/release.js";

export const DAEMON_PROTOCOL_REV = 8;

export type DaemonLifecycle = "serving" | "draining" | "stopping";

export interface DaemonReloadParams {
  target?: ReleaseTarget;
  allowCheckout?: boolean;
  source: "install" | "cli";
  now?: boolean;
  force?: boolean;
}

export type DaemonReloadReply =
  | { action: "noop"; reason: "already_current"; releaseId: string }
  | { action: "skipped"; reason: "mode_manual" }
  | { action: "scheduled"; targetReleaseId: string; dueAt: number; liveWork: string }
  | { action: "draining"; targetReleaseId: string; deadlineAt: number; liveWork: string };

export interface ReloadStatus {
  state: "idle" | "scheduled" | "draining";
  targetReleaseId?: string;
  dueAt?: number;
  deadlineAt?: number;
  previousReleaseId?: string;
  lastError?: { targetReleaseId: string; error: string };
}

export type SessionAttachControl = "take" | "view";

export interface ChatOpenParams {
  chatSessionId?: string;
  projectId?: string;
  repoRoot?: string;
  preferLastGlobal?: boolean;
  preferLastProject?: boolean;
  profileId?: string;
  model?: string;
  effort?: string;
  control?: SessionAttachControl;
}

export interface AttachParams {
  runId: string;
  taskId?: string | null;
  sinceSeq?: number;
  control?: SessionAttachControl;
}

export interface RpcRequest {
  kind: "req";
  id: string;
  op: DaemonOp;
  params?: Record<string, unknown>;
}

export interface RpcResponse {
  kind: "res";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface DaemonEventFrame {
  kind: "event";
  seq: number;
  runId: string;
  taskId: string | null;
  type: string;
  payload: unknown;
  createdAt: number;
  /** Set only on frames delivered for a read-only `watch.start` subscription. */
  watchId?: string;
}

export type WireFrame = RpcRequest | RpcResponse | DaemonEventFrame;

export type SessionControlReason = "attached" | "taken" | "released" | "disconnected";

/** Payload of the `session.control_changed` event, sent to every viewer of the session except the socket that caused it. */
export interface SessionControlPayload {
  sessionId: string;
  kind: "chat" | "run";
  /** null: no terminal has input control. */
  controllerClientId: string | null;
  reason: SessionControlReason;
  /** Monotonic per-session ownership sequence; clients ignore older updates. */
  controlSeq?: number;
}

/** Returned as `control` by chat.open, chat.create and attach, and as the result of session.take_control. */
export interface SessionControlState {
  sessionId: string;
  kind: "chat" | "run";
  clientId: string;
  controllerClientId: string | null;
  hasControl: boolean;
  /** Monotonic per-session ownership sequence; clients ignore older updates. */
  controlSeq?: number;
}

export type DaemonOp =
  | "ping"
  | "status"
  | "daemon.shutdown"
  | "daemon.reload"
  | "config.get"
  | "config.update"
  | "profiles.upsert"
  | "profiles.remove"
  | "profiles.probe"
  | "chat.open"
  | "chat.create"
  | "chat.send"
  | "chat.steer"
  | "chat.cancel"
  | "chat.update"
  | "chat.set_project"
  | "chat.history"
  | "chat.list"
  | "project.list"
  | "project.get"
  | "project.create"
  | "project.update"
  | "project.remove"
  | "project.browse"
  | "remote.list"
  | "remote.add"
  | "remote.remove"
  | "remote.connect"
  | "remote.disconnect"
  | "peer.hello"
  | "peer.proxy"
  | "peer.sync_outbox"
  | "session.send_message"
  | "session.deliver_message"
  | "session.list_messages"
  | "session.read"
  | "sessions.list"
  | "session.leave"
  | "session.take_control"
  | "tui.register"
  | "kb.search"
  | "kb.get"
  | "goal.create"
  | "goal.amend"
  | "goal.commit"
  | "goal.list"
  | "goal.get"
  | "goal.revisions"
  | "goal.resume"
  | "goal.table_display"
  | "goal.review"
  | "goal.accept"
  | "goal.pause"
  | "goal.cancel"
  | "run.create"
  | "run.list"
  | "run.get"
  | "run.stop"
  | "runs.stop_all"
  | "run.resume"
  | "run.schedule_resume"
  | "replay.page"
  | "attach"
  | "detach"
  | "tree.get"
  | "runs.trees"
  | "work.snapshot"
  | "inbox.dismiss"
  | "inbox.restore"
  | "inbox.clear_stale"
  | "watch.start"
  | "watch.stop"
  | "task.get"
  | "task.steer"
  | "task.cancel"
  | "task.resume"
  | "escalation.list"
  | "escalation.get"
  | "escalation.ack"
  | "escalation.resolve"
  | "escalation.reconcile"
  | "artifact.list"
  | "artifact.read"
  | "timer.list"
  | "timer.cancel"
  | "merge.list"
  | "messages.list"
  | "event.get"
  | "models.list"
  | "models.sync"
  | "quota.get"
  | "quota.sync"
  | "cost.get"
  | "worktrees.list"
  | "worktrees.get"
  | "worktrees.clean"
  | "pty.open"
  | "pty.input"
  | "pty.resize"
  | "pty.close"
  | "tool.call";

export type EntityKind =
  | "goal"
  | "run"
  | "task"
  | "escalation"
  | "review"
  | "revision"
  | "artifact"
  | "timer"
  | "worktree"
  | "merge"
  | "message"
  | "tool_call"
  | "transcript";

export interface EntityRef {
  kind: EntityKind;
  id: string;
  runId?: string;
  goalId?: string;
  label?: string;
}

export interface SnapshotWorktreeEntry {
  id: string | null;
  runId: string | null;
  taskId: string | null;
  status: string;
  branch: string;
  path: string;
  existsOnDisk: boolean;
  dirty: boolean;
  orphaned: boolean;
  archiveRef: string | null;
}

export type AttentionAudience = "human" | "director" | "orchestrator" | "none";

export interface InboxItem {
  id: string;
  severity: "P0" | "P1" | "P2" | "info";
  kind:
    | "goal_awaiting_human"
    | "escalation"
    | "task_failed"
    | "task_blocked"
    | "run_failed"
    | "quota_paused"
    | "merge_bounced"
    | "open_message";
  title: string;
  detail: string;
  ref: EntityRef;
  goalId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  createdAt: number;
  audience?: AttentionAudience;
  hiddenReason?: string;
}

/** `cost.get` params: the chat session, or the run whose owning session (or the run itself) is wanted. */
export interface CostGetParams {
  chatSessionId?: string;
  runId?: string;
}

export interface CostAmount {
  currency: string;
  amount: number;
}

export interface CostModelAmount extends CostAmount {
  /** `null` when the source did not say which model incurred the charge. */
  model: string | null;
}

export interface CostRoute {
  profileId: string;
  billing: "api" | "local";
  invocations: number;
  running: number;
  /** reported: every invocation has model-attributed cost; partial: some cost reported; unavailable: nothing reported; unsupported: the route never reports charges. */
  status: "reported" | "partial" | "unavailable" | "unsupported";
  note: string;
}

/** Known spend of one session scope; amounts are never summed across currencies. */
export interface CostSnapshot {
  scope: { kind: "chat" | "run"; id: string; label: string };
  /** The scope has at least one non-subscription invocation, even without any cost data. */
  available: boolean;
  totals: CostAmount[];
  byModel: CostModelAmount[];
  coverage: {
    /** True only when every non-subscription invocation has finished with model-attributed reported cost. */
    complete: boolean;
    routes: CostRoute[];
    unattributed: CostAmount[];
  };
}
