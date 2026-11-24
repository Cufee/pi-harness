import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { readWorkspaceArtifact } from "../src/control-plane/dossiers.js";

const BLOCKED_SHAPE = /^\[harness blocked: [\w-]+\] .+ Why: .+ Allowed: .+/;

describe("db and dossier limit texts (D0: L18, L33, L51)", () => {
  it("T5-1a-db: createEscalation with scope_too_large, two splits, and no evidence succeeds", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "L18 scope", repoRoot: "/tmp/repo", baseBranch: "main", baseSha: "abc" });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Parent",
        objective: "Coordinate",
        profileId: "acp:codex",
      });
      const child = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Child",
        objective: "Investigate",
        profileId: "acp:codex",
      });

      const esc = db.createEscalation({
        runId: run.id,
        fromTaskId: child.id,
        toTaskId: parent.id,
        severity: "P2",
        category: "scope_too_large",
        title: "Too wide",
        evidencePaths: [],
        suggestedSplits: ["Split part A", "Split part B"],
        blocking: true,
      });

      assert.equal(esc.category, "scope_too_large");
      assert.deepEqual(esc.evidencePaths, []);
      assert.deepEqual(esc.suggestedSplits, ["Split part A", "Split part B"]);
      assert.equal(db.getEscalation(esc.id)?.id, esc.id);
    } finally {
      db.close();
    }
  });

  it("T5-2-db: createEscalation with another category and empty evidence throws blocked shape and creates no row", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "L18 other", repoRoot: "/tmp/repo", baseBranch: "main", baseSha: "abc" });
      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Implement",
        profileId: "acp:codex",
      });

      let caught: unknown;
      try {
        db.createEscalation({
          runId: run.id,
          fromTaskId: task.id,
          toTaskId: null,
          severity: "P1",
          category: "code_defect",
          title: "Broken invariant",
          evidencePaths: [],
          blocking: true,
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught instanceof Error);
      assert.match(caught.message, BLOCKED_SHAPE);
      assert.match(caught.message, /^\[harness blocked: escalation-evidence\] /);
      assert.deepEqual(db.listEscalations(run.id), []);
    } finally {
      db.close();
    }
  });

  it("T5-1d: peer_request past the round cap throws blocked shape naming peer_notify", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const runA = db.createRun({
        goal: "Run A",
        repoRoot: "/tmp/repo",
        baseBranch: "main",
        baseSha: "abc",
        coordinationGroup: "grp-1",
      });
      const runB = db.createRun({
        goal: "Run B",
        repoRoot: "/tmp/repo",
        baseBranch: "main",
        baseSha: "abc",
        coordinationGroup: "grp-1",
      });

      const r1 = db.createPeerRequest({
        fromRunId: runA.id,
        toRunId: runB.id,
        topicKey: "api-contract",
        message: "Round 1",
      });
      db.replyPeerRequest(r1.id, runB.id, "Ack 1");

      const r2 = db.createPeerRequest({
        fromRunId: runA.id,
        toRunId: runB.id,
        topicKey: "api-contract",
        message: "Round 2",
      });
      db.replyPeerRequest(r2.id, runB.id, "Ack 2");

      let caught: unknown;
      try {
        db.createPeerRequest({
          fromRunId: runA.id,
          toRunId: runB.id,
          topicKey: "api-contract",
          message: "Round 3",
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught instanceof Error);
      assert.match(caught.message, BLOCKED_SHAPE);
      assert.match(caught.message, /^\[harness blocked: peer-round-cap\] /);
      assert.ok(caught.message.includes("peer_notify"));
      assert.ok(caught.message.includes("contract_publish"));
      const notifyIdx = caught.message.indexOf("peer_notify");
      const reportIdx = caught.message.indexOf("report_issue");
      assert.ok(notifyIdx >= 0 && (reportIdx < 0 || notifyIdx < reportIdx));
    } finally {
      db.close();
    }
  });

  it("T5-2-art: readWorkspaceArtifact outside the workspace throws blocked shape and reads nothing", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "pi-harness-art-outside-"));
    const workspace = join(baseDir, "workspace");
    const outsideFile = join(baseDir, "secret.txt");
    const secret = "OUTSIDE_SECRET_SENTINEL_94812";
    try {
      mkdirSync(workspace, { recursive: true });
      mkdirSync(join(workspace, ".git"), { recursive: true });
      writeFileSync(outsideFile, secret, "utf8");
      writeFileSync(join(workspace, ".git", "config"), secret, "utf8");

      for (const requested of [outsideFile, "../secret.txt", ".git/config"]) {
        let caught: unknown;
        try {
          readWorkspaceArtifact(workspace, requested, undefined);
        } catch (err) {
          caught = err;
        }
        assert.ok(caught instanceof Error, `expected rejection for ${requested}`);
        assert.match(caught.message, BLOCKED_SHAPE);
        assert.match(caught.message, /^\[harness blocked: artifact-outside-workspace\] /);
        assert.equal(caught.message.includes(secret), false);
      }
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
