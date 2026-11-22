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

export type DaemonOp =
  | "ping"
  | "status"
  | "daemon.shutdown"
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
  | "chat.history"
  | "chat.list"
  | "sessions.list"
  | "session.leave"
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
  | "watch.start"
  | "watch.stop"
  | "task.get"
  | "task.steer"
  | "task.cancel"
  | "task.resume"
  | "escalation.list"
  | "escalation.get"
  | "escalation.ack"
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
}
