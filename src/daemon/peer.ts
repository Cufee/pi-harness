import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { hostname } from "node:os";
import type { Readable, Writable } from "node:stream";
import type { RemoteHostConfig } from "../config.js";
import type { DaemonOp, RpcRequest, RpcResponse } from "../protocol/daemon-rpc.js";
import { attachDaemonReader, writeDaemonMessage } from "../protocol/frames.js";

export interface PeerIdentity {
  nodeId: string;
  hostName: string;
  protocolRev: number;
}

export interface RemoteHostStatus {
  name: string;
  sshTarget: string;
  bridgeCommand?: string;
  autoConnect: boolean;
  direction: "outbound" | "inbound";
  status: "connected" | "connecting" | "disconnected" | "error";
  remoteNodeId: string | null;
  remoteHostName: string | null;
  queuedMessages: number;
  lastConnectedAt: number | null;
  lastError: string | null;
}

export type PeerRequestHandler = (op: DaemonOp, params: Record<string, unknown>, peer: PeerLink) => Promise<unknown>;

/**
 * Symmetric bidirectional NDJSON RPC link between two `harnessd` instances.
 *
 * Works identically over:
 *  - Outbound zero-port SSH (`ssh -T -o ServerAliveInterval=15 <host> pi-harness bridge`)
 *  - Outbound local Unix socket (used for fast local peering & E2E tests)
 *  - Accepted inbound Unix socket inside `HarnessDaemon` upgraded via `peer.hello`
 *
 * Because BOTH ends can send `req` and answer with `res` over the same stream,
 * a remote server behind a firewall/NAT can call back into a laptop daemon with zero open ports.
 */
export class PeerLink {
  remoteIdentity: PeerIdentity | null = null;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closeListeners = new Set<() => void>();
  private detachReader: (() => void) | null = null;
  private closed = false;

  constructor(
    readonly alias: string,
    readonly direction: "outbound" | "inbound",
    private readonly readable: Readable,
    private readonly writable: Writable,
    private readonly onInboundRequest: PeerRequestHandler,
    private readonly teardownTransport?: () => void,
    attachReader = true,
  ) {
    if (attachReader) {
      this.detachReader = attachDaemonReader(this.readable, {
        onMessage: (raw) => this.handleWireFrame(raw),
        onError: () => this.close(),
        onEnd: () => this.close(),
      });
    }
  }

  get isOpen(): boolean {
    return !this.closed && !this.writable.destroyed && this.writable.writable;
  }

  onClose(fn: () => void): () => void {
    this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  /** Processes an incoming NDJSON frame (either a `res` to our outbound `req`, or an inbound `req` from the peer). */
  handleWireFrame(raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    const frame = raw as RpcRequest | RpcResponse;
    if (frame.kind === "res" && typeof frame.id === "string") {
      const p = this.pending.get(frame.id);
      if (!p) return;
      this.pending.delete(frame.id);
      if (frame.ok) p.resolve(frame.result);
      else p.reject(new Error(frame.error ?? "Peer RPC failed"));
      return;
    }
    if (frame.kind === "req" && typeof frame.id === "string" && typeof frame.op === "string") {
      const reqId = frame.id;
      const op = frame.op as DaemonOp;
      const params = (frame.params ?? {}) as Record<string, unknown>;
      void this.onInboundRequest(op, params, this).then(
        (result) => {
          if (this.isOpen) {
            writeDaemonMessage(this.writable, { kind: "res", id: reqId, ok: true, result } satisfies RpcResponse);
          }
        },
        (err) => {
          if (this.isOpen) {
            writeDaemonMessage(this.writable, {
              kind: "res",
              id: reqId,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies RpcResponse);
          }
        },
      );
    }
  }

  request<T = unknown>(op: DaemonOp, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error(`Peer "${this.alias}" is not connected`));
    const id = `peer-${randomUUID()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Peer RPC ${op} to "${this.alias}" timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        writeDaemonMessage(this.writable, { kind: "req", id, op, params } satisfies RpcRequest);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.detachReader?.();
    this.detachReader = null;
    for (const p of this.pending.values()) {
      p.reject(new Error(`Peer "${this.alias}" disconnected`));
    }
    this.pending.clear();
    try {
      this.teardownTransport?.();
    } catch {
      // ignore
    }
    for (const fn of this.closeListeners) {
      try {
        fn();
      } catch {
        // ignore
      }
    }
    this.closeListeners.clear();
  }
}

interface OutboundPeerEntry {
  config: RemoteHostConfig;
  link: PeerLink | null;
  status: RemoteHostStatus["status"];
  remoteNodeId: string | null;
  remoteHostName: string | null;
  lastConnectedAt: number | null;
  lastError: string | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  manuallyDisconnected: boolean;
  connectPromise: Promise<RemoteHostStatus> | null;
}

/**
 * Manages outbound configured remote `PeerLink`s (with auto-reconnect) AND inbound reverse
 * `PeerLink`s (upgraded via `peer.hello`) so any two peered daemons can communicate symmetrically.
 */
export class PeerManager {
  private outbound = new Map<string, OutboundPeerEntry>();
  private inbound = new Map<string, PeerLink>(); // keyed by remote nodeId
  private socketToInbound = new Map<Socket, PeerLink>();
  private disposed = false;

  constructor(
    readonly localNodeId: string,
    private readonly protocolRev: number,
    private readonly onInboundRequest: PeerRequestHandler,
    private readonly onPeerConnected: (peer: PeerLink) => void,
    private readonly hostNameOverride?: string,
  ) {}

  get localHostName(): string {
    return this.hostNameOverride?.trim() || hostname();
  }

  /** Applies configured `remotes` list, starting auto-connect links and closing removed ones. */
  syncRemotes(configs: RemoteHostConfig[]): void {
    if (this.disposed) return;
    const nextNames = new Set(configs.map((c) => c.name.toLowerCase()));
    for (const [key, entry] of [...this.outbound.entries()]) {
      if (!nextNames.has(key)) {
        this.clearReconnect(entry);
        entry.link?.close();
        this.outbound.delete(key);
      }
    }
    for (const cfg of configs) {
      const key = cfg.name.toLowerCase();
      const existing = this.outbound.get(key);
      if (!existing) {
        const entry: OutboundPeerEntry = {
          config: cfg,
          link: null,
          status: "disconnected",
          remoteNodeId: null,
          remoteHostName: null,
          lastConnectedAt: null,
          lastError: null,
          reconnectTimer: null,
          backoffMs: 2_000,
          manuallyDisconnected: false,
          connectPromise: null,
        };
        this.outbound.set(key, entry);
        if (cfg.autoConnect !== false) {
          void this.connectRemote(cfg.name).catch(() => {});
        }
      } else {
        const targetChanged =
          existing.config.sshTarget !== cfg.sshTarget || existing.config.bridgeCommand !== cfg.bridgeCommand;
        existing.config = cfg;
        if (targetChanged) {
          existing.link?.close();
          existing.link = null;
          if (cfg.autoConnect !== false && !existing.manuallyDisconnected) {
            void this.connectRemote(cfg.name).catch(() => {});
          }
        }
      }
    }
  }

  private clearReconnect(entry: OutboundPeerEntry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
  }

  private scheduleReconnect(entry: OutboundPeerEntry): void {
    if (this.disposed || entry.manuallyDisconnected || entry.config.autoConnect === false) return;
    this.clearReconnect(entry);
    const delay = entry.backoffMs;
    entry.backoffMs = Math.min(30_000, Math.round(entry.backoffMs * 1.7));
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.connectRemote(entry.config.name).catch(() => {});
    }, delay);
    entry.reconnectTimer.unref?.();
  }

  async connectRemote(name: string): Promise<RemoteHostStatus> {
    const entry = this.outbound.get(name.toLowerCase());
    if (!entry) throw new Error(`Unknown remote host: ${name}`);
    if (entry.link?.isOpen) return this.formatOutboundStatus(entry, 0);
    if (entry.connectPromise) return entry.connectPromise;

    entry.manuallyDisconnected = false;
    entry.status = "connecting";
    entry.lastError = null;
    this.clearReconnect(entry);

    const run = (async (): Promise<RemoteHostStatus> => {
      try {
        const link = await this.openOutboundLink(entry.config);
        const hello = await link.request<PeerIdentity>(
          "peer.hello",
          {
            nodeId: this.localNodeId,
            hostName: this.localHostName,
            protocolRev: this.protocolRev,
            peerAlias: entry.config.name,
          },
          15_000,
        );
        link.remoteIdentity = hello;
        entry.link = link;
        entry.status = "connected";
        entry.remoteNodeId = hello.nodeId;
        entry.remoteHostName = hello.hostName;
        entry.lastConnectedAt = Date.now();
        entry.lastError = null;
        entry.backoffMs = 2_000;

        link.onClose(() => {
          if (entry.link === link) {
            entry.link = null;
            entry.status = "disconnected";
            this.scheduleReconnect(entry);
          }
        });

        this.onPeerConnected(link);
        return this.formatOutboundStatus(entry, 0);
      } catch (err) {
        entry.link?.close();
        entry.link = null;
        entry.status = "error";
        entry.lastError = err instanceof Error ? err.message : String(err);
        this.scheduleReconnect(entry);
        throw err;
      } finally {
        if (entry.connectPromise === run) entry.connectPromise = null;
      }
    })();

    entry.connectPromise = run;
    return run;
  }

  disconnectRemote(name: string): RemoteHostStatus {
    const entry = this.outbound.get(name.toLowerCase());
    if (!entry) throw new Error(`Unknown remote host: ${name}`);
    entry.manuallyDisconnected = true;
    this.clearReconnect(entry);
    entry.link?.close();
    entry.link = null;
    entry.status = "disconnected";
    return this.formatOutboundStatus(entry, 0);
  }

  private async openOutboundLink(cfg: RemoteHostConfig): Promise<PeerLink> {
    if (cfg.sshTarget.startsWith("ssh://")) {
      const url = new URL(cfg.sshTarget);
      const host = url.username ? `${url.username}@${url.hostname}` : url.hostname;
      const args = ["-T", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "BatchMode=yes"];
      if (url.port) args.push("-p", url.port);
      const remoteCmd =
        cfg.bridgeCommand?.trim() ||
        (url.pathname && url.pathname !== "/" ? url.pathname.slice(1) : "pi-harness bridge");
      args.push(host, remoteCmd);

      const proc: ChildProcess = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stderrBuf = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderrBuf = (stderrBuf + chunk.toString("utf8")).slice(-1200);
      });
      await new Promise<void>((resolve, reject) => {
        const onErr = (err: Error) => reject(new Error(`SSH spawn failed: ${err.message}`));
        proc.once("error", onErr);
        // Spawn succeeded on next tick if no immediate error
        setImmediate(() => {
          proc.off("error", onErr);
          if (proc.exitCode !== null) {
            reject(new Error(`SSH exited (${proc.exitCode}): ${stderrBuf.trim() || "connection failed"}`));
          } else {
            resolve();
          }
        });
      });
      const link = new PeerLink(
        cfg.name,
        "outbound",
        proc.stdout!,
        proc.stdin!,
        this.onInboundRequest,
        () => {
          try {
            proc.kill("SIGTERM");
          } catch {
            // ignore
          }
        },
      );
      proc.once("exit", () => link.close());
      return link;
    }

    // Local Unix socket target (supports fast local daemon peering and deterministic E2E tests)
    const sock = createConnection(cfg.sshTarget);
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });
    const link = new PeerLink(cfg.name, "outbound", sock, sock, this.onInboundRequest, () => sock.end());
    sock.once("close", () => link.close());
    return link;
  }

  /**
   * Registers an accepted inbound daemon socket as a symmetric reverse `PeerLink` when it sends `peer.hello`.
   * Note: `attachReader` is `false` because `HarnessDaemon` already owns the socket's NDJSON reader and forwards
   * frames on this socket to `peer.handleWireFrame(raw)`.
   */
  registerInboundSocket(socket: Socket, hello: PeerIdentity): PeerLink {
    const existing = this.inbound.get(hello.nodeId);
    if (existing && existing.isOpen) {
      existing.close();
    }
    const link = new PeerLink(hello.hostName || hello.nodeId, "inbound", socket, socket, this.onInboundRequest, undefined, false);
    link.remoteIdentity = hello;
    this.inbound.set(hello.nodeId, link);
    this.socketToInbound.set(socket, link);
    socket.once("close", () => {
      this.socketToInbound.delete(socket);
      if (this.inbound.get(hello.nodeId) === link) this.inbound.delete(hello.nodeId);
      link.close();
    });
    // Defer sync hook slightly so `peer.hello` response reaches caller first
    setImmediate(() => {
      if (link.isOpen) this.onPeerConnected(link);
    });
    return link;
  }

  getInboundLinkForSocket(socket: Socket): PeerLink | undefined {
    return this.socketToInbound.get(socket);
  }

  /** Finds a live `PeerLink` by configured alias, remote hostname, or remote nodeId. */
  findLink(hostOrNodeId: string): PeerLink | null {
    const key = hostOrNodeId.trim().toLowerCase();
    if (!key || key === "local") return null;

    const outDirect = this.outbound.get(key);
    if (outDirect?.link?.isOpen) return outDirect.link;

    for (const entry of this.outbound.values()) {
      if (!entry.link?.isOpen) continue;
      if (entry.remoteNodeId?.toLowerCase() === key || entry.remoteHostName?.toLowerCase() === key) {
        return entry.link;
      }
    }
    for (const link of this.inbound.values()) {
      if (!link.isOpen) continue;
      if (
        link.alias.toLowerCase() === key ||
        link.remoteIdentity?.nodeId.toLowerCase() === key ||
        link.remoteIdentity?.hostName.toLowerCase() === key
      ) {
        return link;
      }
    }
    return null;
  }

  getRemoteConfig(name: string): RemoteHostConfig | undefined {
    return this.outbound.get(name.toLowerCase())?.config;
  }

  /** Returns all currently connected outbound + inbound peers. */
  connectedLinks(): PeerLink[] {
    const seen = new Set<string>();
    const out: PeerLink[] = [];
    for (const entry of this.outbound.values()) {
      if (entry.link?.isOpen) {
        out.push(entry.link);
        if (entry.remoteNodeId) seen.add(entry.remoteNodeId);
      }
    }
    for (const link of this.inbound.values()) {
      if (link.isOpen && (!link.remoteIdentity?.nodeId || !seen.has(link.remoteIdentity.nodeId))) {
        out.push(link);
      }
    }
    return out;
  }

  private formatOutboundStatus(entry: OutboundPeerEntry, queuedMessages: number): RemoteHostStatus {
    return {
      name: entry.config.name,
      sshTarget: entry.config.sshTarget,
      bridgeCommand: entry.config.bridgeCommand,
      autoConnect: entry.config.autoConnect !== false,
      direction: "outbound",
      status: entry.link?.isOpen ? "connected" : entry.status,
      remoteNodeId: entry.remoteNodeId,
      remoteHostName: entry.remoteHostName,
      queuedMessages,
      lastConnectedAt: entry.lastConnectedAt,
      lastError: entry.lastError,
    };
  }

  listStatuses(queuedByHost: Map<string, number>): RemoteHostStatus[] {
    const results: RemoteHostStatus[] = [];
    const coveredNodes = new Set<string>();
    for (const entry of this.outbound.values()) {
      const q =
        (queuedByHost.get(entry.config.name) ?? 0) +
        (entry.remoteNodeId ? queuedByHost.get(entry.remoteNodeId) ?? 0 : 0);
      results.push(this.formatOutboundStatus(entry, q));
      if (entry.remoteNodeId) coveredNodes.add(entry.remoteNodeId);
    }
    for (const link of this.inbound.values()) {
      if (!link.isOpen) continue;
      const nodeId = link.remoteIdentity?.nodeId ?? null;
      if (nodeId && coveredNodes.has(nodeId)) continue;
      const name = link.remoteIdentity?.hostName || link.alias;
      const q = (queuedByHost.get(name) ?? 0) + (nodeId ? queuedByHost.get(nodeId) ?? 0 : 0);
      results.push({
        name,
        sshTarget: "(inbound peer)",
        autoConnect: false,
        direction: "inbound",
        status: "connected",
        remoteNodeId: nodeId,
        remoteHostName: link.remoteIdentity?.hostName ?? null,
        queuedMessages: q,
        lastConnectedAt: Date.now(),
        lastError: null,
      });
    }
    return results;
  }

  async callRemote<T = unknown>(hostOrNodeId: string, op: DaemonOp, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    let link = this.findLink(hostOrNodeId);
    if (!link) {
      const entry = this.outbound.get(hostOrNodeId.toLowerCase());
      if (entry && !entry.manuallyDisconnected) {
        await this.connectRemote(entry.config.name);
        link = this.findLink(hostOrNodeId);
      }
    }
    if (!link) throw new Error(`Remote host "${hostOrNodeId}" is not connected`);
    return link.request<T>(op, params, timeoutMs);
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.outbound.values()) {
      this.clearReconnect(entry);
      entry.link?.close();
    }
    this.outbound.clear();
    for (const link of this.inbound.values()) {
      link.close();
    }
    this.inbound.clear();
    this.socketToInbound.clear();
  }
}
