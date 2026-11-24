import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import { defaultStateDir } from "../src/config.js";
import { ControlPlaneDb, deriveTitle } from "../src/control-plane/db.js";
import { formatQuotaPauseSummary } from "../src/runners/quota-detect.js";

describe("goal-22 hygiene", () => {
  it("isolates defaultStateDir() into the preload temp home", () => {
    const stateDir = resolve(defaultStateDir());
    const home = resolve(process.env.HOME ?? "");
    assert.ok(home.startsWith(resolve(tmpdir())), `expected temp HOME under tmpdir, got ${home}`);
    assert.equal(stateDir, resolve(join(home, ".pi-harness")));
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
});
