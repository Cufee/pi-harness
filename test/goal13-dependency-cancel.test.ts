import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { compactTaskHandoff } from "../src/control-plane/tools.js";

describe("goal-13 dependency cascade cancellation partial handoffs", () => {
  it("persists partial fallback results with cancellation reason and indexed artifacts on direct and second-level dependents before emitting task.status", () => {
    const db = new ControlPlaneDb(":memory:");
    const repoRoot = "/tmp/repo-dep-cancel";
    const run = db.createRun({
      goal: "Verify dependency cascade cancellation produces partial handoffs",
      repoRoot,
      baseBranch: "main",
      baseSha: "abc1234",
    });

    const taskA = db.createTask({
      runId: run.id,
      tier: 3,
      kind: "research",
      title: "Prerequisite research A",
      objective: "Gather facts for B",
      readOnly: true,
      profileId: "pi",
    });

    const taskB = db.createTask({
      runId: run.id,
      tier: 3,
      kind: "verify",
      title: "Dependent verify B",
      objective: "Verify A output",
      readOnly: true,
      profileId: "pi",
      dependsOn: [taskA.id],
    });

    const taskC = db.createTask({
      runId: run.id,
      tier: 2,
      kind: "worker",
      title: "Second-level dependent C",
      objective: "Act on B output",
      readOnly: false,
      profileId: "pi",
      dependsOn: [taskB.id],
      writeScopes: ["src/example.ts"],
    });

    assert.equal(taskB.status, "pending");
    assert.equal(taskC.status, "pending");

    const bArtifactPath = `${repoRoot}/.harness/artifacts/${run.id}/${taskB.id}/notes.md`;
    db.recordArtifact({
      runId: run.id,
      taskId: taskB.id,
      kind: "dossier",
      path: bArtifactPath,
      summary: "Pre-indexed artifact for B",
    });

    const observedAtEmit = new Map<string, { status: string; resultJson: string | null }>();
    db.onEvent((ev) => {
      if (ev.type === "task.status" && ev.taskId && (ev.taskId === taskB.id || ev.taskId === taskC.id)) {
        const row = db.getTask(ev.taskId)!;
        observedAtEmit.set(ev.taskId, { status: row.status, resultJson: row.resultJson });
      }
    });

    db.updateTask(taskA.id, { status: "failed", summary: "Prerequisite A failed" });

    // Direct dependent B: cancelled with partial fallback persisted before task.status emitted.
    const rowB = db.getTask(taskB.id)!;
    assert.equal(rowB.status, "cancelled");
    assert.ok(rowB.resultJson, "B should have a persisted fallback resultJson");
    assert.equal(observedAtEmit.get(taskB.id)?.status, "cancelled");
    assert.equal(observedAtEmit.get(taskB.id)?.resultJson, rowB.resultJson);

    const handoffB = compactTaskHandoff(rowB);
    assert.equal(handoffB.status, "cancelled");
    assert.equal(handoffB.partial, true);
    assert.ok(handoffB.summary && handoffB.summary.length > 0);
    assert.ok(handoffB.summary.includes("[Partial handoff:"));
    assert.ok(handoffB.summary.includes(`dependency ${taskA.id}`));
    assert.ok(handoffB.summary.includes("failed"));
    assert.ok(handoffB.summary.includes(`.harness/artifacts/${run.id}/${taskB.id}/notes.md`));
    assert.deepEqual(handoffB.artifact_paths, [bArtifactPath]);

    // Second-level dependent C: iteratively cancelled with partial fallback too.
    const rowC = db.getTask(taskC.id)!;
    assert.equal(rowC.status, "cancelled");
    assert.ok(rowC.resultJson, "C should have a persisted fallback resultJson");
    assert.equal(observedAtEmit.get(taskC.id)?.status, "cancelled");
    assert.equal(observedAtEmit.get(taskC.id)?.resultJson, rowC.resultJson);

    const handoffC = compactTaskHandoff(rowC);
    assert.equal(handoffC.status, "cancelled");
    assert.equal(handoffC.partial, true);
    assert.ok(handoffC.summary && handoffC.summary.length > 0);
    assert.ok(handoffC.summary.includes("[Partial handoff:"));
    assert.ok(handoffC.summary.includes(`dependency ${taskA.id}`));
    assert.deepEqual(handoffC.artifact_paths, []);

    db.close();
  });

  it("also cascades partial fallbacks when prerequisite is cancelled or returned_for_rescope and leaves non-pending tasks untouched", () => {
    const db = new ControlPlaneDb(":memory:");
    const run = db.createRun({
      goal: "Verify cascade on cancelled/returned_for_rescope prerequisites",
      repoRoot: "/tmp/repo-dep-cancel-2",
      baseBranch: "main",
      baseSha: "def5678",
    });

    const prereq = db.createTask({
      runId: run.id,
      tier: 3,
      kind: "plan",
      title: "Prerequisite plan",
      objective: "Plan work",
      readOnly: true,
      profileId: "pi",
    });

    const pendingDep = db.createTask({
      runId: run.id,
      tier: 3,
      kind: "verify",
      title: "Pending dependent",
      objective: "Wait for plan",
      readOnly: true,
      profileId: "pi",
      dependsOn: [prereq.id],
    });

    const independent = db.createTask({
      runId: run.id,
      tier: 3,
      kind: "research",
      title: "Independent ready task",
      objective: "Unrelated work",
      readOnly: true,
      profileId: "pi",
    });

    db.updateTask(prereq.id, { status: "returned_for_rescope", summary: "Too large" });

    const settledDep = db.getTask(pendingDep.id)!;
    const handoff = compactTaskHandoff(settledDep);
    assert.equal(handoff.status, "cancelled");
    assert.equal(handoff.partial, true);
    assert.ok(handoff.summary?.includes(`dependency ${prereq.id}`));
    assert.ok(handoff.summary?.includes("returned_for_rescope"));

    assert.equal(db.getTask(independent.id)!.status, "ready");
    db.close();
  });
});
