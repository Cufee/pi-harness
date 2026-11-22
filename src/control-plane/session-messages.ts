import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

export type SessionMessageStatus = "queued" | "delivered" | "failed";
export type SessionMessageWakeStatus = "none" | "pending" | "done" | "tripped";

export interface SessionMessageRecord {
  id: string;
  direction: "outbound" | "inbound";
  fromNode: string;
  fromHost: string;
  fromSessionId: string;
  fromProjectName: string | null;
  toNode: string | null;
  toHost: string;
  toSessionId: string;
  body: string;
  replyToId: string | null;
  expectReply: boolean;
  hopCount: number;
  status: SessionMessageStatus;
  wakeStatus: SessionMessageWakeStatus;
  error: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

export const SESSION_MESSAGES_SCHEMA = `
CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  direction TEXT NOT NULL CHECK (direction IN ('outbound','inbound')),
  from_node TEXT NOT NULL,
  from_host TEXT NOT NULL,
  from_session_id TEXT NOT NULL,
  from_project_name TEXT,
  to_node TEXT,
  to_host TEXT NOT NULL,
  to_session_id TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to_id TEXT,
  expect_reply INTEGER NOT NULL DEFAULT 1,
  hop_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('queued','delivered','failed')),
  wake_status TEXT NOT NULL DEFAULT 'none' CHECK (wake_status IN ('none','pending','done','tripped')),
  error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_messages_outbox ON session_messages(direction, status, to_host, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(direction, to_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_from_session ON session_messages(direction, from_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_wake ON session_messages(direction, wake_status, created_at);
`;

/** Loads or generates a stable daemon node identifier persisted under `<stateDir>/node-id`. */
export function loadOrCreateNodeId(stateDir: string): string {
  try {
    mkdirSync(stateDir, { recursive: true });
    const file = join(stateDir, "node-id");
    if (existsSync(file)) {
      const existing = readFileSync(file, "utf8").trim();
      if (existing) return existing;
    }
    const created = `node-${randomUUID()}`;
    writeFileSync(file, `${created}\n`, "utf8");
    return created;
  } catch {
    return `node-${randomUUID()}`;
  }
}

/**
 * Parses a unified session target address:
 *  - `"chat-2"` -> `{ host: null, sessionId: "chat-2" }` (same host)
 *  - `"local:chat-2"` -> `{ host: "local", sessionId: "chat-2" }`
 *  - `"gpu-box:chat-4"` -> `{ host: "gpu-box", sessionId: "chat-4" }`
 */
export function parseSessionAddress(raw: string): { host: string | null; sessionId: string } {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf(":");
  if (idx > 0) {
    const host = trimmed.slice(0, idx).trim();
    const sessionId = trimmed.slice(idx + 1).trim();
    if (host && sessionId) return { host, sessionId };
  }
  return { host: null, sessionId: trimmed };
}

/**
 * Durable SQLite outbox/inbox for unified local + remote bidirectional session messaging.
 * Guarantees idempotent delivery, strict node pinning, and durable wakeup recovery across crashes & SSH drops.
 */
export class SessionMessageStore {
  constructor(private readonly db: Database) {
    this.db.exec(SESSION_MESSAGES_SCHEMA);
    this.migrateColumns();
  }

  private migrateColumns(): void {
    const cols = new Set(
      (this.db.prepare("PRAGMA table_info(session_messages)").all() as Array<{ name: string }>).map((c) => c.name),
    );
    if (!cols.has("wake_status")) {
      this.db.exec("ALTER TABLE session_messages ADD COLUMN wake_status TEXT NOT NULL DEFAULT 'none'");
    }
  }

  private mapRow(r: Record<string, unknown>): SessionMessageRecord {
    return {
      id: String(r.id),
      direction: String(r.direction) as "outbound" | "inbound",
      fromNode: String(r.from_node),
      fromHost: String(r.from_host),
      fromSessionId: String(r.from_session_id),
      fromProjectName: r.from_project_name ? String(r.from_project_name) : null,
      toNode: r.to_node ? String(r.to_node) : null,
      toHost: String(r.to_host),
      toSessionId: String(r.to_session_id),
      body: String(r.body),
      replyToId: r.reply_to_id ? String(r.reply_to_id) : null,
      expectReply: Number(r.expect_reply) !== 0,
      hopCount: Number(r.hop_count ?? 1),
      status: String(r.status) as SessionMessageStatus,
      wakeStatus: (r.wake_status ? String(r.wake_status) : "none") as SessionMessageWakeStatus,
      error: r.error ? String(r.error) : null,
      createdAt: Number(r.created_at),
      deliveredAt: r.delivered_at != null ? Number(r.delivered_at) : null,
    };
  }

  getById(id: string): SessionMessageRecord | null {
    const row = this.db.prepare("SELECT * FROM session_messages WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  enqueueOutbound(input: {
    id?: string;
    fromNode: string;
    fromHost: string;
    fromSessionId: string;
    fromProjectName?: string | null;
    toNode?: string | null;
    toHost: string;
    toSessionId: string;
    body: string;
    replyToId?: string | null;
    expectReply?: boolean;
    hopCount?: number;
  }): SessionMessageRecord {
    const id = input.id ?? `smsg-${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_messages(
           id, direction, from_node, from_host, from_session_id, from_project_name,
           to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, wake_status, created_at
         ) VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?)`,
      )
      .run(
        id,
        input.fromNode,
        input.fromHost,
        input.fromSessionId,
        input.fromProjectName ?? null,
        input.toNode ?? null,
        input.toHost,
        input.toSessionId,
        input.body,
        input.replyToId ?? null,
        input.expectReply === false ? 0 : 1,
        Math.max(1, input.hopCount ?? 1),
        now,
      );
    return this.getById(id)!;
  }

  /**
   * Idempotently records an inbound message by `id`.
   * Validates immutable envelope fields on collision so a conflicting message ID cannot spoof or silently succeed.
   */
  recordInbound(input: {
    id: string;
    fromNode: string;
    fromHost: string;
    fromSessionId: string;
    fromProjectName?: string | null;
    toNode: string;
    toHost: string;
    toSessionId: string;
    body: string;
    replyToId?: string | null;
    expectReply?: boolean;
    hopCount?: number;
    wakeStatus?: SessionMessageWakeStatus;
  }): { record: SessionMessageRecord; inserted: boolean } {
    const now = Date.now();
    const wakeStatus = input.wakeStatus ?? "pending";
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO session_messages(
           id, direction, from_node, from_host, from_session_id, from_project_name,
           to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, wake_status, created_at, delivered_at
         ) VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
      )
      .run(
        input.id,
        input.fromNode,
        input.fromHost,
        input.fromSessionId,
        input.fromProjectName ?? null,
        input.toNode,
        input.toHost,
        input.toSessionId,
        input.body,
        input.replyToId ?? null,
        input.expectReply === false ? 0 : 1,
        Math.max(1, input.hopCount ?? 1),
        wakeStatus,
        now,
        now,
      );
    const existing = this.getById(input.id)!;
    if (res.changes === 0) {
      if (
        existing.direction !== "inbound" ||
        existing.fromNode !== input.fromNode ||
        existing.fromSessionId !== input.fromSessionId ||
        existing.toSessionId !== input.toSessionId ||
        existing.body !== input.body
      ) {
        throw new Error(`Conflicting session message envelope for existing id "${input.id}"`);
      }
    }
    return { record: existing, inserted: res.changes > 0 };
  }

  markDelivered(id: string): boolean {
    const res = this.db
      .prepare("UPDATE session_messages SET status = 'delivered', error = NULL, delivered_at = ? WHERE id = ? AND status = 'queued'")
      .run(Date.now(), id);
    return res.changes > 0;
  }

  markFailed(id: string, error: string): boolean {
    const res = this.db
      .prepare("UPDATE session_messages SET status = 'failed', error = ? WHERE id = ? AND status = 'queued'")
      .run(error, id);
    return res.changes > 0;
  }

  markWakeStatus(id: string, wakeStatus: SessionMessageWakeStatus): void {
    this.db.prepare("UPDATE session_messages SET wake_status = ? WHERE id = ?").run(wakeStatus, id);
  }

  listPendingInboundWakes(): SessionMessageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM session_messages WHERE direction = 'inbound' AND wake_status = 'pending' ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Lists queued outbound messages for a connected peer.
   * Security invariant: if a queued row has `toNode` pinned, ONLY deliver it to a peer whose authenticated `nodeId`
   * matches `toNode` (never fall back to matching an unpinned hostname of a different node!).
   */
  listQueuedOutboundForPeer(peer: { alias?: string; hostName?: string | null; nodeId?: string | null }): SessionMessageRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM session_messages WHERE direction = 'outbound' AND status = 'queued' ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    const peerNode = peer.nodeId?.toLowerCase() ?? null;
    const hostNames = new Set(
      [peer.alias, peer.hostName].filter((s): s is string => Boolean(s && s.trim())).map((s) => s.trim().toLowerCase()),
    );
    return rows
      .map((r) => this.mapRow(r))
      .filter((m) => {
        if (m.toNode) {
          return peerNode !== null && m.toNode.toLowerCase() === peerNode;
        }
        return hostNames.has(m.toHost.toLowerCase()) || (peerNode !== null && m.toHost.toLowerCase() === peerNode);
      });
  }

  /** Looks up the most recently observed `nodeId` for a remote host alias (from prior inbound/outbound traffic). */
  findKnownNodeForHost(host: string): string | null {
    const lower = host.trim().toLowerCase();
    const row = this.db
      .prepare(
        `SELECT from_node AS node FROM session_messages WHERE direction = 'inbound' AND lower(from_host) = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(lower) as { node?: string } | undefined;
    if (row?.node) return String(row.node);
    const outRow = this.db
      .prepare(
        `SELECT to_node AS node FROM session_messages WHERE direction = 'outbound' AND to_node IS NOT NULL AND lower(to_host) = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(lower) as { node?: string } | undefined;
    return outRow?.node ? String(outRow.node) : null;
  }

  countQueuedOutbound(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM session_messages WHERE direction = 'outbound' AND status = 'queued'")
      .get() as { cnt: number };
    return Number(row?.cnt ?? 0);
  }

  queuedCountsByHost(): Map<string, number> {
    const rows = this.db
      .prepare(
        "SELECT to_host, COUNT(*) AS cnt FROM session_messages WHERE direction = 'outbound' AND status = 'queued' GROUP BY to_host",
      )
      .all() as Array<{ to_host: string; cnt: number }>;
    return new Map(rows.map((r) => [r.to_host, Number(r.cnt)]));
  }

  /**
   * Lists messages belonging strictly to THIS daemon's local `sessionId`
   * (never mixes a remote host's session that happens to share the same friendly ID).
   */
  listForSession(sessionId: string, limit = 50): SessionMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages
         WHERE (direction = 'outbound' AND from_session_id = ?)
            OR (direction = 'inbound' AND to_session_id = ?)
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, sessionId, Math.max(1, limit)) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r)).reverse();
  }

  /** Counts inbound peer messages received on `toSessionId` since `sinceMs` (for anti-loop circuit breaker). */
  countInboundSince(toSessionId: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM session_messages
         WHERE direction = 'inbound' AND to_session_id = ? AND created_at > ?`,
      )
      .get(toSessionId, sinceMs) as { cnt: number };
    return Number(row?.cnt ?? 0);
  }
}
