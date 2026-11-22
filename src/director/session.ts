import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { codeModePromptSection, type CodeMode } from "../code-mode/index.js";
import type { ToolDisplayPayload } from "../protocol/tool-display.js";

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
  role: "user" | "assistant" | "system_notice" | "tool_output";
  /** Short plain-text summary for tool_output turns, e.g. "goal_list → Goals table (3 goals)". */
  content: string;
  createdAt: number;
  /** Only set on tool_output turns. */
  toolName?: string | null;
  /** Only set on tool_output turns. */
  display?: ToolDisplayPayload | null;
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
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system_notice','tool_output')),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  tool_name TEXT,
  display_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(chat_session_id, seq);
`;

export function buildDirectorSystemPrompt(mode: CodeMode = "off"): string {
  const codeMode = codeModePromptSection(mode);
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
    "",
    "RICH TOOL OUTPUT:",
    "- `goal_list` renders the live Goals table directly in the user's UI, and `goal_get` renders the Goal detail card there. When the user asks about goals or progress, call the tool instead of printing a Goals table or goal details in prose.",
    "- Never duplicate a rendered table: after `goal_list` / `goal_get`, add only brief commentary (highlights, blockers, next steps), not a re-typed table or per-goal listing.",
    ...(codeMode ? ["", codeMode] : []),
  ].join("\n");
}

/**
 * Persistent Tier 0 Interactive Director chat store (survives terminal close & remote reattach in `harnessd`).
 */
export class DirectorSessionStore {
  constructor(private readonly db: Database) {
    this.db.exec(DIRECTOR_SCHEMA);
    this.migrateChatTurns();
  }

  /** Upgrades chat_turns created before tool_output turns existed: rebuilds it when its role CHECK lacks 'tool_output' (keeping rows and seq), then adds missing columns. */
  private migrateChatTurns(): void {
    const table = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'chat_turns'")
      .get() as { sql: string } | undefined;
    if (table && !table.sql.includes("'tool_output'")) {
      const cols = new Set((this.db.prepare("PRAGMA table_info(chat_turns)").all() as Array<{ name: string }>).map((c) => c.name));
      const copied = ["seq", "chat_session_id", "role", "content", "created_at", "tool_name", "display_json"].filter((c) => cols.has(c));
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE chat_turns_migrated (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id),
            role TEXT NOT NULL CHECK (role IN ('user','assistant','system_notice','tool_output')),
            content TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            tool_name TEXT,
            display_json TEXT
          );
          INSERT INTO chat_turns_migrated(${copied.join(", ")}) SELECT ${copied.join(", ")} FROM chat_turns;
          DELETE FROM sqlite_sequence WHERE name = 'chat_turns_migrated';
          INSERT INTO sqlite_sequence(name, seq) SELECT 'chat_turns_migrated', seq FROM sqlite_sequence WHERE name = 'chat_turns';
          DROP TABLE chat_turns;
          ALTER TABLE chat_turns_migrated RENAME TO chat_turns;
          CREATE INDEX IF NOT EXISTS idx_chat_turns_session ON chat_turns(chat_session_id, seq);
        `);
      })();
    }
    const cols = new Set((this.db.prepare("PRAGMA table_info(chat_turns)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("tool_name")) this.db.exec("ALTER TABLE chat_turns ADD COLUMN tool_name TEXT");
    if (!cols.has("display_json")) this.db.exec("ALTER TABLE chat_turns ADD COLUMN display_json TEXT");
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

  appendTurn(
    chatSessionId: string,
    role: ChatTurnRecord["role"],
    content: string,
    tool?: { toolName: string; display: ToolDisplayPayload | null },
  ): ChatTurnRecord {
    const now = Date.now();
    const res = this.db
      .prepare("INSERT INTO chat_turns(chat_session_id, role, content, created_at, tool_name, display_json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chatSessionId, role, content, now, tool?.toolName ?? null, tool?.display ? JSON.stringify(tool.display) : null);
    this.db.prepare("UPDATE chat_sessions SET updated_at = ? WHERE id = ?").run(now, chatSessionId);
    return {
      seq: Number(res.lastInsertRowid),
      chatSessionId,
      role,
      content,
      createdAt: now,
      ...(tool ? { toolName: tool.toolName, display: tool.display } : {}),
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
      ...(r.role === "tool_output"
        ? {
            toolName: r.tool_name ? String(r.tool_name) : null,
            display: r.display_json ? (JSON.parse(String(r.display_json)) as ToolDisplayPayload) : null,
          }
        : {}),
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
