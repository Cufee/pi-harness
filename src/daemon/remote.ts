import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import type { DaemonEventFrame, DaemonOp, RpcRequest, RpcResponse } from "../protocol/daemon-rpc.js";
import { attachDaemonReader, writeNdjson } from "../protocol/frames.js";
import { parseValidatedSshTarget } from "./peer.js";

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
  private connectingSocket: Socket | null = null;
  private sshProc: ChildProcess | null = null;
  private detachReader: (() => void) | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventListeners = new Set<(ev: DaemonEventFrame) => void>();
  private closeListeners = new Set<() => void>();
  private _closedByUser = false;
  private _connectionEpoch = 0;

  constructor(
    private readonly target: string,
    private readonly bridgeCommand?: string,
  ) {}

  get isRemote(): boolean {
    return this.target.startsWith("ssh://");
  }

  get remoteHost(): string | null {
    if (!this.isRemote) return null;
    try {
      return parseValidatedSshTarget(this.target, this.bridgeCommand).host;
    } catch {
      return this.target.replace(/^ssh:\/\//, "");
    }
  }

  get localSocketPath(): string | null {
    return this.isRemote ? null : this.target;
  }

  get connected(): boolean {
    return this.writable !== null;
  }

  get closedByUser(): boolean {
    return this._closedByUser;
  }

  get connectionEpoch(): number {
    return this._connectionEpoch;
  }

  onEvent(fn: (ev: DaemonEventFrame) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  async connect(): Promise<void> {
    if (this.writable || this.socket || this.connectingSocket || this.sshProc) {
      this.teardown();
    }
    this._closedByUser = false;
    const epoch = ++this._connectionEpoch;

    if (this.target.startsWith("ssh://")) {
      const { host, port, remoteCmd } = parseValidatedSshTarget(this.target, this.bridgeCommand);
      const args = ["-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
      if (port) args.push("-p", port);
      args.push("--", host, remoteCmd);

      const proc = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      this.sshProc = proc;
      this.readable = proc.stdout!;
      this.writable = proc.stdin!;
      let stderrBuf = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-2000);
      });
      const spawnErr = new Promise<never>((_, reject) => {
        proc.once("error", (err) => {
          this.handleDisconnect(proc.stdin!, epoch);
          reject(new Error(`SSH spawn failed: ${err.message}`));
        });
      });
      // "close" fires after stdout ends and stderr is drained, so a failed bridge reports its stderr.
      // Guard on transport epoch so a late close from a superseded child never rejects current pending requests.
      proc.once("close", (code) => {
        if (this._connectionEpoch !== epoch || this.writable !== proc.stdin) return;
        if (code && code !== 0 && stderrBuf.trim()) {
          for (const p of this.pending.values()) {
            p.reject(new Error(`SSH bridge exited (${code}): ${stderrBuf.trim()}`));
          }
          this.pending.clear();
        }
        this.handleDisconnect(proc.stdin!, epoch);
      });
      // Before the ping succeeds, stdout end waits for "close" so a failed bridge reports its stderr.
      let connected = false;
      this.attachTransportReader(proc.stdin!, epoch, () => connected);
      let connectTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.request("ping"),
          spawnErr,
          new Promise<never>((_, reject) => {
            connectTimer = setTimeout(() => reject(new Error(`Timed out connecting over SSH to ${host}`)), 15_000);
            connectTimer.unref?.();
          }),
        ]);
      } catch (err) {
        if (this._connectionEpoch === epoch) this.teardown();
        else proc.kill("SIGTERM");
        throw err;
      } finally {
        if (connectTimer) clearTimeout(connectTimer);
      }
      if (this._closedByUser || this._connectionEpoch !== epoch) {
        proc.kill("SIGTERM");
        throw new Error("Connection closed during handshake");
      }
      connected = true;
      stderrBuf = "";
      return;
    } else {
      const sock = createConnection(this.target);
      this.connectingSocket = sock;
      try {
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => {
            sock.off("connect", onConnect);
            sock.off("error", onError);
            sock.off("close", onClose);
          };
          const onConnect = () => {
            cleanup();
            resolve();
          };
          const onError = (err: Error) => {
            cleanup();
            reject(err);
          };
          const onClose = () => {
            cleanup();
            reject(new Error("Connection closed during handshake"));
          };
          sock.once("connect", onConnect);
          sock.once("error", onError);
          sock.once("close", onClose);
        });
      } catch (err) {
        if (this.connectingSocket === sock) this.connectingSocket = null;
        sock.destroy();
        throw err;
      }
      if (this.connectingSocket === sock) this.connectingSocket = null;
      if (this._closedByUser || this._connectionEpoch !== epoch) {
        sock.destroy();
        throw new Error("Connection closed during handshake");
      }
      this.socket = sock;
      this.readable = sock;
      this.writable = sock;
      sock.once("close", () => this.handleDisconnect(sock, epoch));
      this.attachTransportReader(sock, epoch);
    }
  }

  private attachTransportReader(
    transport: Writable | null,
    epoch: number,
    disconnectOnEnd: () => boolean = () => true,
  ): void {
    if (!this.readable) return;
    this.detachReader = attachDaemonReader(this.readable, {
      onMessage: (raw) => {
        if (this._connectionEpoch !== epoch || this.writable !== transport) return;
        const frame = raw as RpcResponse | DaemonEventFrame;
        if (frame.kind === "res") {
          const p = this.pending.get(frame.id);
          if (p) {
            this.pending.delete(frame.id);
            if (frame.ok) p.resolve(frame.result);
            else p.reject(new Error(frame.error ?? "Daemon RPC failed"));
          }
        } else if (frame.kind === "event") {
          for (const fn of this.eventListeners) {
            try {
              fn(frame);
            } catch {
              // Isolate listener errors so one faulty UI subscriber never disconnects the daemon socket.
            }
          }
        }
      },
      onError: () => this.handleDisconnect(transport, epoch),
      onEnd: () => {
        if (disconnectOnEnd()) this.handleDisconnect(transport, epoch);
      },
    });
  }

  private handleDisconnect(transport: Writable | null, epoch?: number): void {
    if (!transport || transport !== this.writable) return;
    if (epoch !== undefined && this._connectionEpoch !== epoch) return;
    this._connectionEpoch += 1;
    this.writable = null;
    this.readable = null;
    this.socket = null;
    this.sshProc = null;
    this.detachReader?.();
    this.detachReader = null;
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

  private teardown(): void {
    const connecting = this.connectingSocket;
    const sock = this.socket;
    const proc = this.sshProc;
    const writable = this.writable;
    this.connectingSocket = null;
    this.socket = null;
    this.sshProc = null;
    connecting?.destroy();
    sock?.end();
    proc?.kill("SIGTERM");
    if (writable) {
      this.handleDisconnect(writable);
    } else {
      this._connectionEpoch += 1;
    }
  }

  /** Tears down the active transport without setting closedByUser (used when resetting an unresponsive peer). */
  disconnect(): void {
    this.teardown();
  }

  close(): void {
    this._closedByUser = true;
    this.teardown();
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
  const onErr = () => {
    sock.destroy();
  };
  sock.on("error", onErr);
  process.stdin.on("error", onErr);
  process.stdout.on("error", onErr);
  process.stdin.pipe(sock);
  sock.pipe(process.stdout);
  await new Promise<void>((resolve) => {
    sock.once("close", resolve);
    process.stdin.once("end", () => sock.end());
  });
}
