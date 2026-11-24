import type { Database } from "bun:sqlite";

export interface PendingWake {
  chatSessionId: string;
  kind: "event" | "continue";
  payload: unknown;
}

const WAKEUP_SCHEMA = `
CREATE TABLE IF NOT EXISTS pending_wakeups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL
);
`;

export class WakeupStore {
  constructor(private readonly db: Database) {
    this.db.exec(WAKEUP_SCHEMA);
  }

  append(rows: PendingWake[]): void {
    if (rows.length === 0) return;
    const now = Date.now();
    const insert = this.db.prepare(
      "INSERT INTO pending_wakeups (chat_session_id, kind, payload_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const tx = this.db.transaction((items: PendingWake[]) => {
      for (const row of items) {
        insert.run(
          row.chatSessionId,
          row.kind,
          row.payload === undefined ? null : JSON.stringify(row.payload),
          now,
        );
      }
    });
    tx(rows);
  }

  takeAll(): PendingWake[] {
    const tx = this.db.transaction(() => {
      const rows = this.db
        .prepare("SELECT chat_session_id, kind, payload_json FROM pending_wakeups ORDER BY id ASC")
        .all() as Array<{ chat_session_id: string; kind: string; payload_json: string | null }>;
      if (rows.length > 0) {
        this.db.prepare("DELETE FROM pending_wakeups").run();
      }
      return rows.map((r): PendingWake => ({
        chatSessionId: String(r.chat_session_id),
        kind: r.kind === "continue" ? "continue" : "event",
        payload: r.payload_json ? JSON.parse(r.payload_json) : null,
      }));
    });
    return tx();
  }
}
