import assert from "node:assert/strict";
import { homedir, tmpdir, userInfo } from "node:os";
import { homedir as bareOsHomedir } from "os";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import { normalizeAttachRunId } from "../src/cli.js";
import { defaultStateDir, loadConfig } from "../src/config.js";
import { ControlPlaneDb, deriveTitle } from "../src/control-plane/db.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { formatQuotaPauseSummary } from "../src/runners/quota-detect.js";

describe("goal-22 hygiene", () => {
  it("isolates homedir(), defaultStateDir(), and home-derived env vars into the preload temp home", () => {
    const stateDir = resolve(defaultStateDir());
    const home = resolve(process.env.HOME ?? "");
    assert.ok(home.startsWith(resolve(tmpdir())), `expected temp HOME under tmpdir, got ${home}`);
    assert.equal(resolve(homedir()), home);
    assert.equal(resolve(bareOsHomedir()), home);
    assert.equal(resolve(userInfo().homedir), home);
    assert.equal(stateDir, resolve(join(home, ".pi-harness")));
    assert.equal(resolve(process.env.CODEX_HOME ?? ""), resolve(join(home, ".codex")));
    assert.equal(resolve(process.env.CLAUDE_CONFIG_DIR ?? ""), resolve(join(home, ".claude")));
    assert.equal(resolve(process.env.XDG_DATA_HOME ?? ""), resolve(join(home, ".local", "share")));
    assert.equal(resolve(process.env.XDG_CONFIG_HOME ?? ""), resolve(join(home, ".config")));
  });

  it("derives titles cleanly and treats non-string, blank, undefined, and null as missing", () => {
    assert.deepEqual(deriveTitle("  Explicit title  ", ["unused"], "Fallback"), {
      title: "Explicit title",
      derived: false,
    });
    assert.deepEqual(deriveTitle(undefined, ["\n  First line\nSecond line"], "Fallback"), {
      title: "First line",
      derived: true,
    });
    assert.deepEqual(deriveTitle("undefined", [null, "   ", "null", "Recovered line"], "Fallback"), {
      title: "Recovered line",
      derived: true,
    });
    assert.deepEqual(deriveTitle("null", ["undefined", ""], "Untitled worker task"), {
      title: "Untitled worker task",
      derived: true,
    });
    const longLine = "x".repeat(95);
    const capped = deriveTitle(123, [longLine], "Fallback");
    assert.equal(capped.derived, true);
    assert.equal(capped.title.length, 80);
    assert.ok(capped.title.endsWith("…"));
  });

  it("derives missing escalation titles inside createEscalation instead of persisting undefined", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "Test", repoRoot: "/tmp/repo", baseBranch: "main", baseSha: "abc" });
      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Do work",
        profileId: "pi:anthropic",
      });

      const escUndefined = db.createEscalation({
        runId: run.id,
        fromTaskId: task.id,
        toTaskId: null,
        severity: "P1",
        category: "code_defect",
        title: undefined,
        attempted: ["  First attempted fix\nwith extra details  "],
        evidencePaths: ["src/control-plane/db.ts"],
      });
      assert.equal(escUndefined.title, "First attempted fix");
      assert.equal(db.getEscalation(escUndefined.id)?.title, "First attempted fix");

      const escStringUndefined = db.createEscalation({
        runId: run.id,
        fromTaskId: task.id,
        toTaskId: null,
        severity: "P1",
        category: "code_defect",
        title: "undefined",
        evidencePaths: ["src/control-plane/db.ts"],
      });
      assert.notEqual(escStringUndefined.title, "undefined");
      assert.equal(escStringUndefined.title, "src/control-plane/db.ts");
      assert.equal(db.getEscalation(escStringUndefined.id)?.title, "src/control-plane/db.ts");

      const escFallback = db.createEscalation({
        runId: run.id,
        fromTaskId: task.id,
        toTaskId: null,
        severity: "P2",
        category: "code_defect",
        title: "undefined",
        evidencePaths: ["   "],
      });
      assert.equal(escFallback.title, "Untitled code_defect issue");
    } finally {
      db.close();
    }
  });

  it("derives missing task titles inside createTask from objective or kind fallback", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "Test", repoRoot: "/tmp/repo", baseBranch: "main", baseSha: "abc" });

      const fromObjective = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: undefined,
        objective: "  Wire preload isolation\nSecond line ignored",
        profileId: "pi:anthropic",
      });
      assert.equal(fromObjective.title, "Wire preload isolation");
      assert.equal(db.getTask(fromObjective.id)?.title, "Wire preload isolation");

      const fromFallback = db.createTask({
        runId: run.id,
        tier: 3,
        kind: "research",
        title: "undefined",
        objective: "undefined",
        profileId: "pi:anthropic",
      });
      assert.equal(fromFallback.title, "Untitled research task");
    } finally {
      db.close();
    }
  });

  it("formats quota pause summaries cleanly with and without resetAt", () => {
    assert.equal(
      formatQuotaPauseSummary({
        provider: "anthropic",
        profileId: "pi:anthropic",
        model: "claude-opus-5-5",
        resetAt: "2026-11-24T14:05:00Z",
      }),
      "Paused (quota): anthropic claude-opus-5-5 rate-limited; resets 2026-11-24 14:05 UTC",
    );

    assert.equal(
      formatQuotaPauseSummary({
        provider: "anthropic",
        model: "claude-opus-5-5",
        resetAt: Date.UTC(2026, 10, 24, 14, 5, 0),
        hard: true,
      }),
      "Paused (quota): anthropic claude-opus-5-5 quota exhausted; resets 2026-11-24 14:05 UTC",
    );

    assert.equal(
      formatQuotaPauseSummary({
        profileId: "acp:codex",
        model: "gpt-6",
      }),
      "Paused (quota): acp:codex gpt-6 rate-limited; reset time unknown",
    );

    assert.equal(
      formatQuotaPauseSummary({
        provider: "anthropic",
        model: "anthropic/claude-opus-5-5",
        resetAt: "not-a-timestamp",
      }),
      "Paused (quota): anthropic/claude-opus-5-5 rate-limited; reset time unknown",
    );
  });

  it("derives titles with an advisory note through ControlPlaneToolExecutor for report_issue, spawn_task, spawn_worker, and kb_propose", async () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const repoRoot = process.cwd();
      const cfg = loadConfig(repoRoot);
      const run = db.createRun({ goal: "Tool title hygiene", repoRoot, baseBranch: "main", baseSha: "abc1234" });
      const orch = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:anthropic",
      });
      const worker = db.createTask({
        runId: run.id,
        parentId: orch.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Build feature",
        profileId: "pi:anthropic",
      });

      const hooks: ToolRuntimeHooks = {
        spawnAndStartTask: async (input) =>
          db.createTask({
            runId: input.runId,
            parentId: input.parentId,
            tier: input.tier,
            kind: input.kind,
            title: input.title,
            objective: input.objective,
            criteria: input.criteria,
            readOnly: input.readOnly,
            profileId: input.profileId ?? "pi:anthropic",
            model: input.model,
            effort: input.effort,
            dependsOn: input.dependsOn,
            writeScopes: input.writeScopes,
          }),
        waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
        steerTask: async () => false,
        cancelTask: async () => {},
        scheduleRollover: async () => {},
        getWorktreeManager: () => {
          throw new Error("unused");
        },
        getMergeQueue: () => {
          throw new Error("unused");
        },
        getTaskSignal: () => undefined,
      };

      const executor = new ControlPlaneToolExecutor(db, () => {
        throw new Error("unused");
      }, hooks, cfg);

      // 1. report_issue without title -> derived, not "undefined", advisory note included, not rejected
      const issueRes = (await executor.execute(run.id, worker.id, "report_issue", {
        severity: "P2",
        category: "code_defect",
        evidence_paths: ["src/control-plane/tools.ts"],
        attempted: ["Checked missing title coercion"],
      })) as { escalationId: string; note?: string };
      const persistedEsc = db.getEscalation(issueRes.escalationId);
      assert.ok(persistedEsc);
      assert.notEqual(persistedEsc.title, "undefined");
      assert.equal(persistedEsc.title, "Checked missing title coercion");
      assert.equal(
        issueRes.note,
        "title was missing; derived 'Checked missing title coercion'. Pass a short title next time.",
      );

      // Explicit title -> no advisory note
      const explicitIssue = (await executor.execute(run.id, worker.id, "report_issue", {
        severity: "P2",
        category: "code_defect",
        title: "Explicit issue title",
        evidence_paths: ["src/control-plane/tools.ts"],
      })) as { escalationId: string; note?: string };
      assert.equal(db.getEscalation(explicitIssue.escalationId)?.title, "Explicit issue title");
      assert.equal(explicitIssue.note, undefined);

      // 2. spawn_task without title -> derived from objective, advisory note included
      const taskRes = (await executor.execute(run.id, orch.id, "spawn_task", {
        kind: "research",
        objective: "Inspect attach run-id normalization\nInclude fallback behavior",
        model: "anthropic/claude-opus-5-5",
      })) as { spawned: string; note?: string };
      const persistedTask = db.getTask(taskRes.spawned);
      assert.ok(persistedTask);
      assert.notEqual(persistedTask.title, "undefined");
      assert.equal(persistedTask.title, "Inspect attach run-id normalization");
      assert.equal(
        taskRes.note,
        "title was missing; derived 'Inspect attach run-id normalization'. Pass a short title next time.",
      );

      // 3. spawn_worker without title -> derived from objective, advisory note included
      const workerRes = (await executor.execute(run.id, orch.id, "spawn_worker", {
        objective: "Wire quota summary formatting",
        write_scopes: ["src/control-plane/orchestrator.ts"],
        model: "anthropic/claude-opus-5-5",
      })) as { spawned: string; note?: string };
      const persistedWorker = db.getTask(workerRes.spawned);
      assert.ok(persistedWorker);
      assert.notEqual(persistedWorker.title, "undefined");
      assert.equal(persistedWorker.title, "Wire quota summary formatting");
      assert.equal(
        workerRes.note,
        "title was missing; derived 'Wire quota summary formatting'. Pass a short title next time.",
      );

      // 4. kb_propose without title -> derived from summary/body, advisory note included
      const kbRes = (await executor.execute(run.id, orch.id, "kb_propose", {
        kind: "gotcha",
        summary: "Never coerce missing args.title via String()",
        context_md: "String(undefined) persists literal 'undefined' in SQLite.",
        evidence_paths: ["src/control-plane/tools.ts"],
      })) as { id: string; note?: string };
      const persistedKb = db.kb.getRaw(kbRes.id);
      assert.ok(persistedKb);
      assert.notEqual(persistedKb.title, "undefined");
      assert.equal(persistedKb.title, "Never coerce missing args.title via String()");
      assert.equal(
        kbRes.note,
        "title was missing; derived 'Never coerce missing args.title via String()'. Pass a short title next time.",
      );
    } finally {
      db.close();
    }
  });

  it("normalizes attach run IDs case-insensitively and leaves non-run targets untouched", () => {
    assert.equal(normalizeAttachRunId("RUN-5"), "run-5");
    assert.equal(normalizeAttachRunId("run-5"), "run-5");
    assert.equal(normalizeAttachRunId("Run_abcdef12"), "run-abcdef12");
    assert.equal(normalizeAttachRunId("RUN-dir-chat-1"), "run-dir-chat-1");
    assert.equal(normalizeAttachRunId("chat-x"), null);
  });
});
