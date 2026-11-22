import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

export type SessionMessageStatus = "queued" | "delivered" | "failed";

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
  error TEXT,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_session_messages_outbox ON session_messages(direction, status, to_host, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(to_session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_from_session ON session_messages(from_session_id, created_at);
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
    const created = `node-${randomUUID().slice(0, 12)}`;
    writeFileSync(file, `${created}\n`, "utf8");
    return created;
  } catch {
    return `node-${randomUUID().slice(0, 12)}`;
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
 * Guarantees idempotent delivery across SSH drops, reconnects, and laptop sleep.
 */
export class SessionMessageStore {
  constructor(private readonly db: Database) {
    this.db.exec(SESSION_MESSAGES_SCHEMA);
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
    const id = input.id ?? `smsg-${randomUUID().slice(0, 12)}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO session_messages(
           id, direction, from_node, from_host, from_session_id, from_project_name,
           to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, created_at
         ) VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
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

  /** Idempotently records an inbound message by `id` (prevents duplicate wakeups on reconnect redelivery). */
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
  }): { record: SessionMessageRecord; inserted: boolean } {
    const now = Date.now();
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO session_messages(
           id, direction, from_node, from_host, from_session_id, from_project_name,
           to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, created_at, delivered_at
         ) VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?)`,
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
        now,
        now,
      );
    return { record: this.getById(input.id)!, inserted: res.changes > 0 };
  }

  markDelivered(id: string): void {
    this.db
      .prepare("UPDATE session_messages SET status = 'delivered', error = NULL, delivered_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  markFailed(id: string, error: string): void {
    this.db.prepare("UPDATE session_messages SET status = 'failed', error = ? WHERE id = ?").run(error, id);
  }

  /** Lists queued outbound messages matching any of the provided target host names or node IDs. */
  listQueuedOutbound(targets?: string[]): SessionMessageRecord[] {
    if (!targets || targets.length === 0) {
      const rows = this.db
        .prepare("SELECT * FROM session_messages WHERE direction = 'outbound' AND status = 'queued' ORDER BY created_at ASC")
        .all() as Record<string, unknown>[];
      return rows.map((r) => this.mapRow(r));
    }
    const lowerSet = new Set(targets.map((t) => t.toLowerCase()));
    const rows = this.db
      .prepare("SELECT * FROM session_messages WHERE direction = 'outbound' AND status = 'queued' ORDER BY created_at ASC")
      .all() as Record<string, unknown>[];
    return rows
      .map((r) => this.mapRow(r))
      .filter((m) => lowerSet.has(m.toHost.toLowerCase()) || (m.toNode != null && lowerSet.has(m.toNode.toLowerCase())));
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

  listForSession(sessionId: string, limit = 50): SessionMessageRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM session_messages
         WHERE from_session_id = ? OR to_session_id = ?
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
