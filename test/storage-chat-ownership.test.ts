import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { describe, it } from "bun:test";
import { ControlPlaneDb, formatFallbackSummary } from "../src/control-plane/db.js";
import { directorTaskRunId } from "../src/control-plane/ids.js";
import { DirectorSessionStore } from "../src/director/session.js";
import { GoalEngine } from "../src/goals/engine.js";

const PRE_CHANGE_CORE_SCHEMA = `
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  goal TEXT NOT NULL,
  repo_root TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  coordination_group TEXT,
  isolation_mode TEXT NOT NULL DEFAULT 'standalone',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE timers (
  id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('chat','task')),
  owner_id TEXT NOT NULL,
  run_id TEXT,
  goal_id TEXT,
  wake_at INTEGER NOT NULL,
  reason TEXT NOT NULL,
  wake_on_event TEXT NOT NULL DEFAULT 'none',
  resume_goal INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','fired','cancelled')),
  fired_reason TEXT,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);

CREATE TABLE session_messages (
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
`;

const PRE_CHANGE_CHAT_SESSIONS_SCHEMA = `
CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  repo_root TEXT NOT NULL,
  title TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  model TEXT,
  effort TEXT,
  acp_session_id TEXT,
  model_selection_context TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const PRE_CHANGE_GOALS_SCHEMA = `
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  chat_session_id TEXT,
  repo_root TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  non_goals_json TEXT NOT NULL DEFAULT '[]',
  budgets_json TEXT NOT NULL,
  verification_mode TEXT NOT NULL DEFAULT 'auto',
  verify_ref TEXT,
  live_progress_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  linked_run_id TEXT,
  review_cycle INTEGER NOT NULL DEFAULT 0,
  no_progress_streak INTEGER NOT NULL DEFAULT 0,
  last_progress_fingerprint TEXT,
  last_review_summary TEXT,
  last_reviewer_failure_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

function columnInfo(db: Database, table: string): Map<string, { type: string; notnull: number }> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;
  return new Map(rows.map((r) => [r.name, { type: r.type, notnull: r.notnull }]));
}

function insertRawChat(db: Database, id: string, repoRoot: string, now: number): void {
  db.prepare(
    `INSERT INTO chat_sessions(id, repo_root, title, profile_id, created_at, updated_at)
     VALUES (?, ?, ?, 'acp:codex', ?, ?)`,
  ).run(id, repoRoot, `Chat ${id}`, now, now);
}

function insertRawGoal(
  db: Database,
  input: {
    id: string;
    chatSessionId: string | null;
    repoRoot: string;
    linkedRunId: string | null;
    updatedAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO goals(
       id, chat_session_id, repo_root, version, title, description,
       criteria_json, non_goals_json, budgets_json, status, linked_run_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, 1, ?, 'desc', '[]', '[]', '{}', 'executing', ?, ?, ?)`,
  ).run(
    input.id,
    input.chatSessionId,
    input.repoRoot,
    `Goal ${input.id}`,
    input.linkedRunId,
    input.updatedAt,
    input.updatedAt,
  );
}

describe("storage chat ownership (slice 3a)", () => {
  it("creates nullable chat_session_id columns on fresh DB and derives chat ownership in createRun", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      for (const table of ["runs", "timers", "session_messages"]) {
        const cols = columnInfo(db.db, table);
        const col = cols.get("chat_session_id");
        assert.ok(col, `${table}.chat_session_id should exist`);
        assert.equal(col.type.toUpperCase(), "TEXT");
        assert.equal(col.notnull, 0);
      }

      const repoRoot = "/tmp/repo-fresh";
      const otherRepo = "/tmp/repo-other";

      // Before chat_sessions or goals tables exist: explicit chat works, standalone is null,
      // and bucket runs without a chat_sessions/goals table stay null without throwing.
      const explicitRun = db.createRun({
        goal: "Explicit chat",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-explicit",
      });
      assert.equal(explicitRun.chatSessionId, "chat-explicit");
      assert.equal(db.getRun(explicitRun.id)?.chatSessionId, "chat-explicit");

      const standaloneRun = db.createRun({
        goal: "Standalone run",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(standaloneRun.chatSessionId, null);

      const missingTablesBucket = db.createRun({
        id: directorTaskRunId("chat-absent", null),
        goal: "Bucket before tables",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(missingTablesBucket.chatSessionId, null);

      // Now construct DirectorSessionStore and GoalEngine (creates chat_sessions and goals tables).
      const sessions = new DirectorSessionStore(db.db);
      const goals = new GoalEngine(db.db);
      const chat1 = sessions.createSession({ repoRoot, title: "Chat 1", profileId: "acp:codex" });
      const chat2 = sessions.createSession({ repoRoot, title: "Chat 2", profileId: "acp:codex" });

      const ownerlessGoal = goals.createGoal({
        chatSessionId: null,
        repoRoot,
        title: "Ownerless goal",
        description: "No owning chat",
        criteria: [],
        verificationMode: "none",
      });
      const ownedGoal = goals.createGoal({
        chatSessionId: chat2.id,
        repoRoot,
        title: "Owned goal",
        description: "Owned by chat 2",
        criteria: [],
        verificationMode: "none",
      });

      const chatBucketBase = db.createRun({
        id: directorTaskRunId(chat1.id, null),
        goal: "Chat bucket base",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(chatBucketBase.chatSessionId, chat1.id);

      const chatBucketWs = db.createRun({
        id: directorTaskRunId(chat1.id, otherRepo),
        goal: "Chat bucket secondary workspace",
        repoRoot: otherRepo,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(chatBucketWs.chatSessionId, chat1.id);

      const ownerlessGoalBucket = db.createRun({
        id: directorTaskRunId(ownerlessGoal.id, null),
        goal: "Ownerless goal bucket",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(ownerlessGoalBucket.chatSessionId, null);

      const ownedGoalBucket = db.createRun({
        id: directorTaskRunId(ownedGoal.id, null),
        goal: "Owned goal bucket",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(ownedGoalBucket.chatSessionId, chat2.id);

      const ownedGoalBucketWs = db.createRun({
        id: directorTaskRunId(ownedGoal.id, otherRepo),
        goal: "Owned goal bucket secondary workspace",
        repoRoot: otherRepo,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(ownedGoalBucketWs.chatSessionId, chat2.id);

      // Unknown bucket owner (neither a chat_sessions row nor a goals row) must stay null.
      const unknownBucket = db.createRun({
        id: directorTaskRunId("chat-does-not-exist", null),
        goal: "Unknown owner bucket",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(unknownBucket.chatSessionId, null);

      // listRuns also maps chatSessionId for all rows.
      const listed = new Map(db.listRuns(50).map((r) => [r.id, r.chatSessionId]));
      assert.equal(listed.get(explicitRun.id), "chat-explicit");
      assert.equal(listed.get(standaloneRun.id), null);
      assert.equal(listed.get(chatBucketBase.id), chat1.id);
      assert.equal(listed.get(chatBucketWs.id), chat1.id);
      assert.equal(listed.get(ownerlessGoalBucket.id), null);
      assert.equal(listed.get(ownedGoalBucket.id), chat2.id);
      assert.equal(listed.get(ownedGoalBucketWs.id), chat2.id);
      assert.equal(listed.get(unknownBucket.id), null);
    } finally {
      db.close();
    }
  });

  it("backfills pre-change DBs with goals table idempotently and tolerates missing goals/chat_sessions tables", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-harness-chat-own-backfill-"));
    try {
      // Case 1: pre-change DB with chat_sessions and goals tables.
      const fullPath = join(tempDir, "with-goals.sqlite");
      const now = 1_700_000_000_000;
      const repoRoot = join(tempDir, "repo");
      const wsBucketChat1 = directorTaskRunId("chat-1", join(tempDir, "repo-2"));
      const wsBucketGoalOwned = directorTaskRunId("goal-owned", join(tempDir, "repo-2"));

      const legacy = new Database(fullPath);
      try {
        legacy.exec(PRE_CHANGE_CORE_SCHEMA);
        legacy.exec(PRE_CHANGE_CHAT_SESSIONS_SCHEMA);
        legacy.exec(PRE_CHANGE_GOALS_SCHEMA);

        insertRawChat(legacy, "chat-1", repoRoot, now);
        insertRawChat(legacy, "chat-2", repoRoot, now);

        insertRawGoal(legacy, {
          id: "goal-ownerless",
          chatSessionId: null,
          repoRoot,
          linkedRunId: "run-ownerless-goal",
          updatedAt: now + 10,
        });
        insertRawGoal(legacy, {
          id: "goal-owned",
          chatSessionId: "chat-2",
          repoRoot,
          linkedRunId: null,
          updatedAt: now + 20,
        });
        // Multiple goals pointing at the same run: newest non-null chat_session_id must win.
        insertRawGoal(legacy, {
          id: "goal-linked-old",
          chatSessionId: "chat-1",
          repoRoot,
          linkedRunId: "run-linked",
          updatedAt: now + 100,
        });
        insertRawGoal(legacy, {
          id: "goal-linked-new",
          chatSessionId: "chat-2",
          repoRoot,
          linkedRunId: "run-linked",
          updatedAt: now + 200,
        });
        insertRawGoal(legacy, {
          id: "goal-linked-null-newest",
          chatSessionId: null,
          repoRoot,
          linkedRunId: "run-linked",
          updatedAt: now + 300,
        });

        const insertOldRun = legacy.prepare(
          `INSERT INTO runs(id, goal, repo_root, base_branch, base_sha, coordination_group, isolation_mode, status, created_at, updated_at)
           VALUES (?, ?, ?, 'main', 'sha1', NULL, 'standalone', 'active', ?, ?)`,
        );
        insertOldRun.run("director-tasks-chat-1", "Chat 1 bucket", repoRoot, now, now);
        insertOldRun.run(wsBucketChat1, "Chat 1 ws bucket", join(tempDir, "repo-2"), now, now);
        insertOldRun.run("director-tasks-goal-ownerless", "Ownerless goal bucket", repoRoot, now, now);
        insertOldRun.run("director-tasks-goal-owned", "Owned goal bucket", repoRoot, now, now);
        insertOldRun.run(wsBucketGoalOwned, "Owned goal ws bucket", join(tempDir, "repo-2"), now, now);
        insertOldRun.run("director-tasks-chat-ghost", "Ghost bucket", repoRoot, now, now);
        insertOldRun.run("run-linked", "Linked run", repoRoot, now, now);
        insertOldRun.run("run-ownerless-goal", "Ownerless linked run", repoRoot, now, now);
        insertOldRun.run("run-standalone", "Standalone run", repoRoot, now, now);

        const insertOldTimer = legacy.prepare(
          `INSERT INTO timers(id, owner_kind, owner_id, run_id, goal_id, wake_at, reason, wake_on_event, resume_goal, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'none', 0, 'pending', ?)`,
        );
        insertOldTimer.run("timer-1", "chat", "chat-1", null, null, now + 60_000, "chat timer", now);
        insertOldTimer.run("timer-2", "task", "t-1", "run-linked", null, now + 60_000, "task timer linked run", now);
        insertOldTimer.run("timer-3", "task", "t-2", "director-tasks-chat-1", null, now + 60_000, "task timer bucket", now);
        insertOldTimer.run("timer-4", "task", "t-3", "run-standalone", null, now + 60_000, "task timer standalone", now);
        insertOldTimer.run("timer-5", "task", "t-4", null, null, now + 60_000, "task timer no run", now);

        const insertOldMsg = legacy.prepare(
          `INSERT INTO session_messages(
             id, direction, from_node, from_host, from_session_id, from_project_name,
             to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, wake_status, created_at
           ) VALUES (?, ?, 'node-a', 'local', ?, NULL, 'node-b', 'remote', ?, 'hello', NULL, 1, 1, 'queued', 'none', ?)`,
        );
        insertOldMsg.run("smsg-out", "outbound", "chat-1", "chat-remote", now);
        insertOldMsg.run("smsg-in", "inbound", "chat-remote", "chat-2", now);
      } finally {
        legacy.close();
      }

      const firstOpen = new ControlPlaneDb(fullPath);
      let firstSnapshot: {
        runs: unknown[];
        timers: unknown[];
        messages: unknown[];
      };
      try {
        assert.ok(columnInfo(firstOpen.db, "runs").has("chat_session_id"));
        assert.ok(columnInfo(firstOpen.db, "timers").has("chat_session_id"));
        assert.ok(columnInfo(firstOpen.db, "session_messages").has("chat_session_id"));

        assert.equal(firstOpen.getRun("director-tasks-chat-1")?.chatSessionId, "chat-1");
        assert.equal(firstOpen.getRun(wsBucketChat1)?.chatSessionId, "chat-1");
        assert.equal(firstOpen.getRun("director-tasks-goal-ownerless")?.chatSessionId, null);
        assert.equal(firstOpen.getRun("director-tasks-goal-owned")?.chatSessionId, "chat-2");
        assert.equal(firstOpen.getRun(wsBucketGoalOwned)?.chatSessionId, "chat-2");
        assert.equal(firstOpen.getRun("director-tasks-chat-ghost")?.chatSessionId, null);
        assert.equal(firstOpen.getRun("run-linked")?.chatSessionId, "chat-2");
        assert.equal(firstOpen.getRun("run-ownerless-goal")?.chatSessionId, null);
        assert.equal(firstOpen.getRun("run-standalone")?.chatSessionId, null);

        assert.equal(firstOpen.timers.get("timer-1")?.chatSessionId, "chat-1");
        assert.equal(firstOpen.timers.get("timer-2")?.chatSessionId, "chat-2");
        assert.equal(firstOpen.timers.get("timer-3")?.chatSessionId, "chat-1");
        assert.equal(firstOpen.timers.get("timer-4")?.chatSessionId, null);
        assert.equal(firstOpen.timers.get("timer-5")?.chatSessionId, null);

        assert.equal(firstOpen.sessionMessages.getById("smsg-out")?.chatSessionId, "chat-1");
        assert.equal(firstOpen.sessionMessages.getById("smsg-in")?.chatSessionId, "chat-2");

        firstSnapshot = {
          runs: firstOpen.db.prepare("SELECT * FROM runs ORDER BY id").all(),
          timers: firstOpen.db.prepare("SELECT * FROM timers ORDER BY id").all(),
          messages: firstOpen.db.prepare("SELECT * FROM session_messages ORDER BY id").all(),
        };
      } finally {
        firstOpen.close();
      }

      // Reopen and verify idempotency (no rows modified).
      const secondOpen = new ControlPlaneDb(fullPath);
      try {
        const secondSnapshot = {
          runs: secondOpen.db.prepare("SELECT * FROM runs ORDER BY id").all(),
          timers: secondOpen.db.prepare("SELECT * FROM timers ORDER BY id").all(),
          messages: secondOpen.db.prepare("SELECT * FROM session_messages ORDER BY id").all(),
        };
        assert.deepEqual(secondSnapshot, firstSnapshot);

        // Pre-populated values must not be overwritten by a later open.
        secondOpen.db.prepare("UPDATE runs SET chat_session_id = 'chat-pinned' WHERE id = 'director-tasks-chat-1'").run();
      } finally {
        secondOpen.close();
      }

      const thirdOpen = new ControlPlaneDb(fullPath);
      try {
        assert.equal(thirdOpen.getRun("director-tasks-chat-1")?.chatSessionId, "chat-pinned");
      } finally {
        thirdOpen.close();
      }

      // Case 2: pre-change DB without any goals table (only chat_sessions).
      const noGoalsPath = join(tempDir, "without-goals.sqlite");
      const legacyNoGoals = new Database(noGoalsPath);
      try {
        legacyNoGoals.exec(PRE_CHANGE_CORE_SCHEMA);
        legacyNoGoals.exec(PRE_CHANGE_CHAT_SESSIONS_SCHEMA);
        insertRawChat(legacyNoGoals, "chat-1", repoRoot, now);
        legacyNoGoals
          .prepare(
            `INSERT INTO runs(id, goal, repo_root, base_branch, base_sha, coordination_group, isolation_mode, status, created_at, updated_at)
             VALUES ('director-tasks-chat-1', 'Bucket', ?, 'main', 'sha1', NULL, 'standalone', 'active', ?, ?)`,
          )
          .run(repoRoot, now, now);
        legacyNoGoals
          .prepare(
            `INSERT INTO timers(id, owner_kind, owner_id, run_id, goal_id, wake_at, reason, wake_on_event, resume_goal, status, created_at)
             VALUES ('timer-1', 'task', 't-1', 'director-tasks-chat-1', NULL, ?, 'bucket task timer', 'none', 0, 'pending', ?)`,
          )
          .run(now + 60_000, now);
        legacyNoGoals
          .prepare(
            `INSERT INTO session_messages(
               id, direction, from_node, from_host, from_session_id, from_project_name,
               to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, wake_status, created_at
             ) VALUES ('smsg-1', 'inbound', 'node-a', 'remote', 'chat-remote', NULL, 'node-b', 'local', 'chat-1', 'hi', NULL, 1, 1, 'delivered', 'done', ?)`,
          )
          .run(now);
      } finally {
        legacyNoGoals.close();
      }

      const migratedNoGoals = new ControlPlaneDb(noGoalsPath);
      try {
        assert.equal(migratedNoGoals.getRun("director-tasks-chat-1")?.chatSessionId, "chat-1");
        assert.equal(migratedNoGoals.timers.get("timer-1")?.chatSessionId, "chat-1");
        assert.equal(migratedNoGoals.sessionMessages.getById("smsg-1")?.chatSessionId, "chat-1");
      } finally {
        migratedNoGoals.close();
      }

      // Case 3: pre-change DB without goals or chat_sessions tables.
      const minimalPath = join(tempDir, "minimal.sqlite");
      const legacyMinimal = new Database(minimalPath);
      try {
        legacyMinimal.exec(PRE_CHANGE_CORE_SCHEMA);
        legacyMinimal
          .prepare(
            `INSERT INTO runs(id, goal, repo_root, base_branch, base_sha, coordination_group, isolation_mode, status, created_at, updated_at)
             VALUES ('director-tasks-chat-1', 'Bucket', ?, 'main', 'sha1', NULL, 'standalone', 'active', ?, ?)`,
          )
          .run(repoRoot, now, now);
        legacyMinimal
          .prepare(
            `INSERT INTO timers(id, owner_kind, owner_id, run_id, goal_id, wake_at, reason, wake_on_event, resume_goal, status, created_at)
             VALUES ('timer-chat', 'chat', 'chat-9', NULL, NULL, ?, 'chat timer', 'none', 0, 'pending', ?)`,
          )
          .run(now + 60_000, now);
      } finally {
        legacyMinimal.close();
      }

      const migratedMinimal = new ControlPlaneDb(minimalPath);
      try {
        assert.equal(migratedMinimal.getRun("director-tasks-chat-1")?.chatSessionId, null);
        assert.equal(migratedMinimal.timers.get("timer-chat")?.chatSessionId, "chat-9");
      } finally {
        migratedMinimal.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts pre-change INSERT column lists on migrated tables and maps rows cleanly", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pi-harness-chat-own-old-bin-"));
    const dbPath = join(tempDir, "migrated.sqlite");
    try {
      const now = 1_700_000_000_000;
      const seed = new Database(dbPath);
      try {
        seed.exec(PRE_CHANGE_CORE_SCHEMA);
      } finally {
        seed.close();
      }

      const migrated = new ControlPlaneDb(dbPath);
      try {
        // Simulate an older binary running its pre-change INSERT statements against the migrated schema.
        migrated.db
          .prepare(
            "INSERT INTO runs(id, goal, repo_root, base_branch, base_sha, coordination_group, isolation_mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)",
          )
          .run("run-old-bin", "From old binary", tempDir, "main", "deadbeef", null, "standalone", now, now);

        migrated.db
          .prepare(
            `INSERT INTO timers(
               id, owner_kind, owner_id, run_id, goal_id, wake_at, reason,
               wake_on_event, resume_goal, status, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
          )
          .run("timer-old-bin", "chat", "chat-old", "run-old-bin", null, now + 60_000, "old binary timer", "none", 0, now);

        migrated.db
          .prepare(
            `INSERT INTO session_messages(
               id, direction, from_node, from_host, from_session_id, from_project_name,
               to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, wake_status, created_at
             ) VALUES (?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'none', ?)`,
          )
          .run("smsg-old-out", "node-1", "local", "chat-old", null, null, "remote", "chat-peer", "body", null, 1, 1, now);

        migrated.db
          .prepare(
            `INSERT OR IGNORE INTO session_messages(
               id, direction, from_node, from_host, from_session_id, from_project_name,
               to_node, to_host, to_session_id, body, reply_to_id, expect_reply, hop_count, status, wake_status, created_at, delivered_at
             ) VALUES (?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?, ?, ?)`,
          )
          .run("smsg-old-in", "node-2", "remote", "chat-peer", null, "node-1", "local", "chat-old", "reply", null, 1, 1, "pending", now, now);

        assert.equal(migrated.getRun("run-old-bin")?.chatSessionId, null);
        assert.equal(migrated.listRuns(10).find((r) => r.id === "run-old-bin")?.chatSessionId, null);
        assert.equal(migrated.timers.get("timer-old-bin")?.chatSessionId, null);
        assert.equal(migrated.timers.list().find((t) => t.id === "timer-old-bin")?.chatSessionId, null);
        assert.equal(migrated.sessionMessages.getById("smsg-old-out")?.chatSessionId, null);
        assert.equal(migrated.sessionMessages.getById("smsg-old-in")?.chatSessionId, null);
      } finally {
        migrated.close();
      }

      // Next open backfills the rows written by the old binary.
      const reopened = new ControlPlaneDb(dbPath);
      try {
        assert.equal(reopened.timers.get("timer-old-bin")?.chatSessionId, "chat-old");
        assert.equal(reopened.sessionMessages.getById("smsg-old-out")?.chatSessionId, "chat-old");
        assert.equal(reopened.sessionMessages.getById("smsg-old-in")?.chatSessionId, "chat-old");
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("getRunChatSessionId derives and persists ownership for a run linked to a goal after creation", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const repoRoot = "/tmp/repo-late-link";
      const run = db.createRun({
        goal: "Linked later",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      assert.equal(run.chatSessionId, null);
      assert.equal(db.getRunChatSessionId(run.id), null);

      const goals = new GoalEngine(db.db);
      const olderGoal = goals.createGoal({
        chatSessionId: "chat-older",
        repoRoot,
        title: "Older linked goal",
        description: "Linked first",
        criteria: [],
        verificationMode: "none",
      });
      const newerGoal = goals.createGoal({
        chatSessionId: "chat-newer",
        repoRoot,
        title: "Newer linked goal",
        description: "Linked second",
        criteria: [],
        verificationMode: "none",
      });
      const newestNullGoal = goals.createGoal({
        chatSessionId: null,
        repoRoot,
        title: "Ownerless goal",
        description: "Must not override non-null chat",
        criteria: [],
        verificationMode: "none",
      });

      db.db.prepare("UPDATE goals SET linked_run_id = ?, updated_at = ? WHERE id = ?").run(run.id, 1000, olderGoal.id);
      db.db.prepare("UPDATE goals SET linked_run_id = ?, updated_at = ? WHERE id = ?").run(run.id, 2000, newerGoal.id);
      db.db.prepare("UPDATE goals SET linked_run_id = ?, updated_at = ? WHERE id = ?").run(run.id, 3000, newestNullGoal.id);

      assert.equal(db.getRunChatSessionId(run.id), "chat-newer");
      assert.equal(db.getRun(run.id)?.chatSessionId, "chat-newer");

      // Unlink goals to prove the derived chat_session_id was persisted on runs.
      db.db.prepare("UPDATE goals SET linked_run_id = NULL, chat_session_id = NULL").run();
      assert.equal(db.getRun(run.id)?.chatSessionId, "chat-newer");
      assert.equal(db.getRunChatSessionId(run.id), "chat-newer");
    } finally {
      db.close();
    }
  });

  it("records chatSessionId on timers and session messages via writers and mapRow", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const repoRoot = "/tmp/repo-timers-msgs";
      const chatRun = db.createRun({
        goal: "Chat run",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-run-owner",
      });
      const standaloneRun = db.createRun({
        goal: "Standalone run",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      const lateLinkedRun = db.createRun({
        goal: "Late linked run",
        repoRoot,
        baseBranch: "main",
        baseSha: "abc123",
      });
      const goals = new GoalEngine(db.db);
      const goal = goals.createGoal({
        chatSessionId: "chat-from-goal",
        repoRoot,
        title: "Goal for task timer",
        description: "Links after run creation",
        criteria: [],
        verificationMode: "none",
      });
      db.db.prepare("UPDATE goals SET linked_run_id = ? WHERE id = ?").run(lateLinkedRun.id, goal.id);

      const chatTimer = db.timers.schedule({
        ownerKind: "chat",
        ownerId: "chat-direct",
        runId: standaloneRun.id,
        delaySeconds: 600,
        reason: "Director timer",
      });
      assert.equal(chatTimer.chatSessionId, "chat-direct");
      assert.equal(db.timers.get(chatTimer.id)?.chatSessionId, "chat-direct");

      const taskTimerInChatRun = db.timers.schedule({
        ownerKind: "task",
        ownerId: "t-1",
        runId: chatRun.id,
        delaySeconds: 600,
        reason: "Task in chat run",
      });
      assert.equal(taskTimerInChatRun.chatSessionId, "chat-run-owner");

      const taskTimerLateGoal = db.timers.schedule({
        ownerKind: "task",
        ownerId: "t-2",
        runId: lateLinkedRun.id,
        delaySeconds: 600,
        reason: "Task in late-linked run",
      });
      assert.equal(taskTimerLateGoal.chatSessionId, "chat-from-goal");
      assert.equal(db.getRun(lateLinkedRun.id)?.chatSessionId, "chat-from-goal");

      const taskTimerStandalone = db.timers.schedule({
        ownerKind: "task",
        ownerId: "t-3",
        runId: standaloneRun.id,
        delaySeconds: 600,
        reason: "Task in standalone run",
      });
      assert.equal(taskTimerStandalone.chatSessionId, null);

      const outbound = db.sessionMessages.enqueueOutbound({
        fromNode: "node-local",
        fromHost: "local",
        fromSessionId: "chat-sender",
        toHost: "remote-box",
        toSessionId: "chat-receiver",
        body: "ping",
      });
      assert.equal(outbound.chatSessionId, "chat-sender");
      assert.equal(db.sessionMessages.getById(outbound.id)?.chatSessionId, "chat-sender");

      const inbound = db.sessionMessages.recordInbound({
        id: "smsg-inbound-1",
        fromNode: "node-remote",
        fromHost: "remote-box",
        fromSessionId: "chat-remote-sender",
        toNode: "node-local",
        toHost: "local",
        toSessionId: "chat-local-receiver",
        body: "pong",
      });
      assert.equal(inbound.inserted, true);
      assert.equal(inbound.record.chatSessionId, "chat-local-receiver");
      assert.equal(db.sessionMessages.listForSession("chat-local-receiver")[0]?.chatSessionId, "chat-local-receiver");
    } finally {
      db.close();
    }
  });

  it("formatFallbackSummary keeps in-repo paths relative and renders out-of-repo outputPath as absolute", () => {
    const repoRoot = "/tmp/workspace/my-repo";
    const insideOutput = join(repoRoot, ".harness", "artifacts", "run-1", "t-1", "output.md");
    const insideRes = formatFallbackSummary({
      repoRoot,
      reason: "timeout",
      wtPath: null,
      git: {},
      paths: [join(repoRoot, ".harness", "artifacts", "run-1", "t-1", "notes.md")],
      outputPath: insideOutput,
      text: "partial text",
      excerptLimit: 200,
    });
    assert.ok(
      insideRes.summary.includes("\n[Full output: .harness/artifacts/run-1/t-1/output.md]"),
      `Expected repo-relative output pointer, got:\n${insideRes.summary}`,
    );
    assert.ok(insideRes.summary.includes("Artifacts: 1 indexed: .harness/artifacts/run-1/t-1/notes.md"));

    const outsideOutput = "/tmp/pi-harness-data/projects/my-repo-1234567890ab/chats/chat-1/artifacts/run-1/t-1/output.md";
    const outsideRes = formatFallbackSummary({
      repoRoot,
      reason: "timeout",
      wtPath: null,
      git: {},
      paths: [outsideOutput],
      outputPath: outsideOutput,
      text: "partial text",
      excerptLimit: 200,
    });
    assert.ok(
      outsideRes.summary.includes(`\n[Full output: ${outsideOutput}]`),
      `Expected absolute output pointer, got:\n${outsideRes.summary}`,
    );
    assert.equal(outsideRes.summary.includes("../"), false);

    // Sibling path sharing repoRoot string prefix must still be treated as outside repoRoot.
    const siblingOutput = "/tmp/workspace/my-repo-data/output.md";
    const siblingRes = formatFallbackSummary({
      repoRoot,
      reason: "timeout",
      wtPath: null,
      git: {},
      paths: [],
      outputPath: siblingOutput,
      text: "partial text",
      excerptLimit: 200,
    });
    assert.ok(siblingRes.summary.includes(`\n[Full output: ${siblingOutput}]`));
    assert.equal(siblingRes.summary.includes("../"), false);

    // Relative outputPath escaping repoRoot must resolve to an absolute path without '../'.
    const escapingRes = formatFallbackSummary({
      repoRoot,
      reason: "timeout",
      wtPath: null,
      git: {},
      paths: [],
      outputPath: "../outside/output.md",
      text: "partial text",
      excerptLimit: 200,
    });
    assert.ok(escapingRes.summary.includes(`\n[Full output: ${resolve(repoRoot, "../outside/output.md")}]`));
    assert.equal(escapingRes.summary.includes("../"), false);

    // File inside repoRoot whose basename starts with '..' stays repo-relative.
    const dotDotName = join(repoRoot, "..notes.md");
    const dotDotRes = formatFallbackSummary({
      repoRoot,
      reason: "timeout",
      wtPath: null,
      git: {},
      paths: [dotDotName],
      outputPath: dotDotName,
      text: "partial text",
      excerptLimit: 200,
    });
    assert.ok(dotDotRes.summary.includes("\n[Full output: ..notes.md]"));
  });
});
