import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { writeCodeOutput, writeTaskDossier, writeUniqueTaskDossier } from "../src/control-plane/dossiers.js";

describe("artifact origin marker (D0)", () => {
  it("T-origin: only artifact_write dossiers are agent-written and old DBs migrate with no origin", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-origin-"));
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "Origin test", repoRoot, baseBranch: "main", baseSha: "abc123" });
      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Write dossiers",
        profileId: "acp:codex",
      });

      // Agent dossier writer: twice for one name, once for another.
      const a1 = writeTaskDossier(db, run, task.id, "notes.md", "v1", "first draft");
      const a2 = writeTaskDossier(db, run, task.id, "notes.md", "v2", "second draft");
      const a3 = writeTaskDossier(db, run, task.id, "findings.md", "results", "findings");
      assert.equal(a1.origin, "agent");
      assert.equal(a2.origin, "agent");
      assert.equal(a3.origin, "agent");

      // Harness writers & runner-style records must omit origin.
      const uniqueRec = writeUniqueTaskDossier(db, run, task.id, "inspect-output", ".txt", "cmd out", "inspect_command output");
      assert.equal(uniqueRec.origin, undefined);
      assert.equal("origin" in uniqueRec, false);

      const codePath = writeCodeOutput(db, run, task.id, "code-exec.json", '{"ok":true}');
      const summaryRec = db.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: join(repoRoot, ".harness", "artifacts", `${task.id}-summary-1.md`),
        summary: "Full task summary",
      });
      const readRec = db.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "read",
        path: join(repoRoot, "src/index.ts"),
        summary: "read src/index.ts",
      });
      assert.equal(summaryRec.origin, undefined);
      assert.equal("origin" in summaryRec, false);
      assert.equal(readRec.origin, undefined);
      assert.equal("origin" in readRec, false);

      // listAgentDossierPaths returns exactly the two writeTaskDossier paths, each once.
      const agentPaths = db.listAgentDossierPaths(run.id, task.id).sort();
      assert.deepEqual(agentPaths, [a1.path, a3.path].sort());

      // listArtifacts returns origin: "agent" only on the writeTaskDossier rows; others omit the property.
      const all = db.listArtifacts(run.id, task.id, 50);
      assert.equal(all.length, 7);
      const agentIds = new Set([a1.id, a2.id, a3.id]);
      for (const rec of all) {
        if (agentIds.has(rec.id)) {
          assert.equal(rec.origin, "agent");
        } else {
          assert.equal(rec.origin, undefined);
          assert.equal("origin" in rec, false);
        }
      }
      assert.ok(all.some((r) => r.path === codePath && !("origin" in r)));
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }

    // Second case: temp file database created with old schema (artifacts table without origin column).
    const tempDir = mkdtempSync(join(tmpdir(), "pi-harness-origin-migrate-"));
    const dbPath = join(tempDir, "old.sqlite");
    let migrated: ControlPlaneDb | undefined;
    try {
      const legacy = new Database(dbPath);
      try {
        legacy.exec(`
          CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            goal TEXT NOT NULL,
            repo_root TEXT NOT NULL,
            base_branch TEXT NOT NULL,
            base_sha TEXT NOT NULL,
            status TEXT NOT NULL,
            isolation_mode TEXT NOT NULL DEFAULT 'isolated',
            coordination_group TEXT,
            budget_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE tasks (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id),
            parent_id TEXT,
            tier INTEGER NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            objective TEXT NOT NULL,
            status TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1,
            profile_id TEXT NOT NULL,
            model TEXT,
            effort TEXT,
            read_only INTEGER NOT NULL DEFAULT 0,
            write_scopes_json TEXT NOT NULL DEFAULT '[]',
            worktree_id TEXT,
            session_id TEXT,
            summary TEXT,
            handoff_json TEXT,
            result_json TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE TABLE artifacts (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL REFERENCES runs(id),
            task_id TEXT NOT NULL REFERENCES tasks(id),
            kind TEXT NOT NULL,
            path TEXT NOT NULL,
            summary TEXT NOT NULL,
            git_sha TEXT,
            exit_code INTEGER,
            created_at INTEGER NOT NULL
          );
        `);
        const now = Date.now();
        legacy
          .prepare(
            "INSERT INTO runs(id, goal, repo_root, base_branch, base_sha, status, budget_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("run-1", "Legacy run", tempDir, "main", "abc", "active", "{}", now, now);
        legacy
          .prepare(
            "INSERT INTO tasks(id, run_id, tier, kind, title, objective, status, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("t-1", "run-1", 2, "worker", "Legacy worker", "Work", "running", "acp:codex", now, now);
        legacy
          .prepare(
            "INSERT INTO artifacts(id, run_id, task_id, kind, path, summary, git_sha, exit_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run("art-1", "run-1", "t-1", "dossier", join(tempDir, "legacy.md"), "pre-migration dossier", null, null, now);
      } finally {
        legacy.close();
      }

      migrated = new ControlPlaneDb(dbPath);
      const cols = (migrated.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("origin"));

      const before = migrated.listArtifacts("run-1", "t-1", 20);
      assert.equal(before.length, 1);
      assert.equal(before[0]!.id, "art-1");
      assert.equal(before[0]!.origin, undefined);
      assert.equal("origin" in before[0]!, false);
      assert.deepEqual(migrated.listAgentDossierPaths("run-1", "t-1"), []);

      const run = migrated.getRun("run-1")!;
      const fresh = writeTaskDossier(migrated, run, "t-1", "after-migration.md", "new content", "post-migration");
      assert.equal(fresh.origin, "agent");

      const after = migrated.listArtifacts("run-1", "t-1", 20);
      const oldRow = after.find((r) => r.id === "art-1")!;
      const newRow = after.find((r) => r.id === fresh.id)!;
      assert.equal("origin" in oldRow, false);
      assert.equal(newRow.origin, "agent");
      assert.deepEqual(migrated.listAgentDossierPaths("run-1", "t-1"), [fresh.path]);
    } finally {
      migrated?.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
