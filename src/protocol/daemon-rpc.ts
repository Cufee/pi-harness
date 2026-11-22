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
  | "goal.review"
  | "goal.pause"
  | "goal.cancel"
  | "run.create"
  | "run.list"
  | "run.get"
  | "run.stop"
  | "attach"
  | "detach"
  | "tree.get"
  | "task.steer"
  | "task.cancel"
  | "escalation.ack"
  | "models.list"
  | "models.sync"
  | "quota.get"
  | "quota.sync"
  | "worktrees.list"
  | "worktrees.clean"
  | "pty.open"
  | "pty.input"
  | "pty.resize"
  | "pty.close"
  | "tool.call";
