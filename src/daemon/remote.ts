import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { DaemonEventFrame, DaemonOp, RpcRequest, RpcResponse } from "../protocol/daemon-rpc.js";
import { attachNdjsonReader, writeNdjson } from "../protocol/frames.js";

export interface DaemonClientTarget {
  /** Local Unix socket path OR `ssh://[user@]host[:port]` remote target */
  target: string;
}

/**
 * Thin daemon client supporting both:
 *  - Local Unix domain sockets (`0600`)
 *  - Zero-port native SSH remote bridging (`ssh -T -o ServerAliveInterval=15 host pi-harness bridge`)
 *    automatically reusing `~/.ssh/config`, `ProxyJump`, and SSH keys!
 */
export class DaemonClient {
  private readable: Readable | null = null;
  private writable: Writable | null = null;
  private socket: Socket | null = null;
  private sshProc: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventListeners = new Set<(ev: DaemonEventFrame) => void>();
  private closeListeners = new Set<() => void>();

  constructor(private readonly target: string) {}

  onEvent(fn: (ev: DaemonEventFrame) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  async connect(): Promise<void> {
    if (this.target.startsWith("ssh://")) {
      const url = new URL(this.target);
      const host = url.username ? `${url.username}@${url.hostname}` : url.hostname;
      const args = ["-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
      if (url.port) args.push("-p", url.port);
      const remoteCmd = url.pathname && url.pathname !== "/" ? url.pathname.slice(1) : "pi-harness bridge";
      args.push(host, remoteCmd);

      const proc = spawn("ssh", args, { stdio: ["pipe", "pipe", "inherit"] });
      this.sshProc = proc;
      this.readable = proc.stdout!;
      this.writable = proc.stdin!;
      proc.once("exit", () => this.handleDisconnect());
    } else {
      const sock = createConnection(this.target);
      await new Promise<void>((resolve, reject) => {
        sock.once("connect", resolve);
        sock.once("error", reject);
      });
      this.socket = sock;
      this.readable = sock;
      this.writable = sock;
      sock.once("close", () => this.handleDisconnect());
    }

    this.detachReader = attachNdjsonReader(this.readable, {
      onMessage: (raw) => {
        const frame = raw as RpcResponse | DaemonEventFrame;
        if (frame.kind === "res") {
          const p = this.pending.get(frame.id);
          if (p) {
            this.pending.delete(frame.id);
            if (frame.ok) p.resolve(frame.result);
            else p.reject(new Error(frame.error ?? "Daemon RPC failed"));
          }
        } else if (frame.kind === "event") {
          for (const fn of this.eventListeners) fn(frame);
        }
      },
      onError: () => this.handleDisconnect(),
      onEnd: () => this.handleDisconnect(),
    });
  }

  private handleDisconnect(): void {
    for (const p of this.pending.values()) {
      p.reject(new Error("Disconnected from harnessd"));
    }
    this.pending.clear();
    for (const fn of this.closeListeners) fn();
  }

  request<T = unknown>(op: DaemonOp, params?: Record<string, unknown>): Promise<T> {
    if (!this.writable) return Promise.reject(new Error("DaemonClient not connected"));
    const id = randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      const ok = writeNdjson(this.writable!, { kind: "req", id, op, params } satisfies RpcRequest);
      if (!ok) {
        this.pending.delete(id);
        reject(new Error("Failed to write request to daemon stream"));
      }
    });
  }

  close(): void {
    this.detachReader?.();
    this.socket?.end();
    this.sshProc?.kill("SIGTERM");
  }
}

/**
 * Stdio <-> Unix socket bridge run on remote hosts by `ssh host pi-harness bridge`.
 * Zero open ports; splices stdin/stdout directly to local `harnessd`.
 */
export async function runStdioSocketBridge(socketPath: string): Promise<void> {
  const sock = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", resolve);
    sock.once("error", reject);
  });
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
  await new Promise<void>((resolve) => {
    sock.once("close", resolve);
    process.stdin.once("end", () => sock.end());
  });
}
