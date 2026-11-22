import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";

function canonicalRepoPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export interface ChatSessionRecord {
  id: string;
  repoRoot: string;
  title: string;
  profileId: string;
  model: string | null;
  effort: string | null;
  acpSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ChatTurnRecord {
  seq: number;
  chatSessionId: string;
  role: "user" | "assistant" | "system_notice";
  content: string;
  createdAt: number;
}

export const DIRECTOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_sessions (
  id TEXT PRIMARY KEY,
  repo_root TEXT NOT NULL,
  title TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  acp_session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_turns (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id),
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system_notice')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(chat_session_id, seq);
`;

export function buildDirectorSystemPrompt(): string {
  return [
    "You are the Tier 0 INTERACTIVE DIRECTOR of pi-harness — the user's persistent engineering partner.",
    "You sit ABOVE the autonomous Tier 1 Run Orchestrators so the user always has an instant, responsive chat.",
    "",
    "YOUR RESPONSIBILITIES:",
    "1. Brainstorm designs, discuss tradeoffs, explore requirements, and answer progress questions immediately using deterministic tools (`goal_list`, `goal_get`, `tree_view`, `list_models`, `kb_search`).",
    "2. Never edit repository code directly. When the user is ready to execute work, draft a structured **Goal Contract** via `goal_create` (with concrete `deterministic` shell check commands + `behavioral`/`architectural` criteria + `non_goals`), confirm or commit it via `goal_commit` so an autonomous Tier 1 Orchestrator runs until objectively verified and independently reviewed.",
    "3. When the user changes requirements mid-flight, call `goal_amend` so a clean `vN -> vN+1` amendment delta propagates to the running Tier 1 Orchestrator without losing unaffected work.",
    "4. Surface `P0` escalations, circuit-breaker trips, and Independent Done-Review verdicts clearly to the user with actionable options.",
    "5. Keep responses crisp, direct, and grounded in actual tool state — never guess progress or invent statuses.",
  ].join("\n");
}

/**
 * Persistent Tier 0 Interactive Director chat store (survives terminal close & remote reattach in `harnessd`).
 */
export class DirectorSessionStore {
  constructor(private readonly db: Database) {
    this.db.exec(DIRECTOR_SCHEMA);
  }

  private lastTs = 0;

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
    return this.lastTs;
  }

  getOrCreateDefault(input: { repoRoot: string; profileId: string; model?: string | null; effort?: string | null }): ChatSessionRecord {
    const canon = canonicalRepoPath(input.repoRoot);
    const existing = this.db
      .prepare("SELECT * FROM chat_sessions WHERE repo_root = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get(canon) as Record<string, unknown> | undefined;
    if (existing) return this.mapSession(existing);

    return this.createSession({ ...input, repoRoot: canon });
  }

  createSession(input: {
    repoRoot: string;
    profileId: string;
    title?: string;
    model?: string | null;
    effort?: string | null;
  }): ChatSessionRecord {
    const canon = canonicalRepoPath(input.repoRoot);
    const id = `chat-${randomBytes(4).toString("hex")}`;
    const now = this.nextTimestamp();
    this.db
      .prepare(
        "INSERT INTO chat_sessions(id, repo_root, title, profile_id, model, effort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, canon, input.title?.trim() || "Director Chat", input.profileId, input.model ?? null, input.effort ?? null, now, now);
    return this.getSession(id)!;
  }

  touchSession(id: string): void {
    this.db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(this.nextTimestamp(), id);
  }

  getMostRecentSession(): ChatSessionRecord | null {
    const r = this.db
      .prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC, rowid DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return r ? this.mapSession(r) : null;
  }

  getSession(id: string): ChatSessionRecord | null {
    const r = this.db.prepare("SELECT * FROM chat_sessions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapSession(r) : null;
  }

  listSessions(limit = 20): ChatSessionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_sessions ORDER BY updated_at DESC LIMIT ?")
      .all(limit) as Record<string, unknown>[];
    return rows.map((r) => this.mapSession(r));
  }

  appendTurn(chatSessionId: string, role: ChatTurnRecord["role"], content: string): ChatTurnRecord {
    const now = Date.now();
    const res = this.db
      .prepare("INSERT INTO chat_turns(chat_session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(chatSessionId, role, content, now);
    this.db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(now, chatSessionId);
    return {
      seq: Number(res.lastInsertRowid),
      chatSessionId,
      role,
      content,
      createdAt: now,
    };
  }

  updateSession(
    chatSessionId: string,
    patch: Partial<{ profileId: string; model: string | null; effort: string | null; title: string }>,
  ): ChatSessionRecord {
    const existing = this.getSession(chatSessionId);
    if (!existing) throw new Error(`Unknown chat session ${chatSessionId}`);
    const now = Date.now();
    this.db
      .prepare("UPDATE chat_sessions SET profile_id = ?, model = ?, effort = ?, title = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.profileId ?? existing.profileId,
        patch.model !== undefined ? patch.model : existing.model,
        patch.effort !== undefined ? patch.effort : existing.effort,
        patch.title ?? existing.title,
        now,
        chatSessionId,
      );
    return this.getSession(chatSessionId)!;
  }

  getHistory(chatSessionId: string, sinceSeq = 0, limit = 100): ChatTurnRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_turns WHERE chat_session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
      .all(chatSessionId, sinceSeq, limit) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      chatSessionId: String(r.chat_session_id),
      role: String(r.role) as ChatTurnRecord["role"],
      content: String(r.content),
      createdAt: Number(r.created_at),
    }));
  }

  private mapSession(r: Record<string, unknown>): ChatSessionRecord {
    return {
      id: String(r.id),
      repoRoot: String(r.repo_root),
      title: String(r.title),
      profileId: String(r.profile_id),
      model: r.model ? String(r.model) : null,
      effort: r.effort ? String(r.effort) : null,
      acpSessionId: r.acp_session_id ? String(r.acp_session_id) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}
