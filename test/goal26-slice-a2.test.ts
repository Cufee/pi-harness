import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory, type ResumeRunResult } from "../src/control-plane/orchestrator.js";
import type { AnchoredHandoff } from "../src/control-plane/prompts.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function makeTempGitRepo(): Promise<string> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-goal26-a2-")));
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("goal-26 slice A2: orchestrator resumeCompletedOrchestrator", () => {
  it("resumes a completed Tier 1 only when resumeCompletedOrchestrator is true and preserves its anchored handoff", async () => {
    const repoRoot = await makeTempGitRepo();
    const db = new ControlPlaneDb(":memory:");
    const gate = deferred<void>();
    const started = deferred<void>();
    const launchedTaskIds: string[] = [];
    let capturedPrompt = "";

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        launchedTaskIds.push(req.taskId);
        capturedPrompt = req.initialPrompt;
        started.resolve();
        await gate.promise;
        return { text: "gen+1 finished", stopReason: "completed" };
      },
    });

    const config = withFixtureCatalog({ ...loadConfig(repoRoot), codeMode: "off", stateDir: join(repoRoot, "state") });
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const orchestrator = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);

    let runId: string | null = null;
    try {
      const run = db.createRun({ goal: "Goal 26 A2 completed orch", repoRoot, baseBranch: "main", baseSha: "HEAD" });
      runId = run.id;
      const orch = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Tier 1 orchestrator",
        objective: "Coordinate goal 26 slice A2",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const priorHandoff: AnchoredHandoff = {
        goalInvariants: ["INVARIANT-A2-KEEP"],
        architecturalDecisions: [{ decision: "Preserve anchored handoff", rationale: "Continue without losing context" }],
        activeRisks: ["PRIOR-RISK-MARKER"],
        nextActions: ["NEXT-ACTION-MARKER-42"],
      };
      db.updateTask(orch.id, {
        status: "completed",
        generation: 2,
        summary: "Completed gen 2 before human review",
        handoffJson: JSON.stringify(priorHandoff),
      });
      db.updateRunStatus(run.id, "completed", "Orchestrator completed");

      // Default resumeRun (flag unset) keeps already_completed behavior unchanged.
      const defaultRes = await orchestrator.resumeRun(run.id);
      assert.equal(defaultRes.outcome, "already_completed");
      assert.equal(defaultRes.resumed, false);
      assert.equal(defaultRes.reason, "already_completed");
      assert.deepEqual(defaultRes.resumedTaskIds, []);
      assert.equal(launchedTaskIds.length, 0);
      assert.equal(db.getTask(orch.id)!.status, "completed");
      assert.equal(db.getTask(orch.id)!.generation, 2);

      // Type-level check for queued ResumeRunResult shape reserved for slice B.
      const queuedShape: ResumeRunResult = {
        ...defaultRes,
        outcome: "queued",
        queuePosition: 1,
        reason: "queued_for_goal_slot",
      };
      assert.equal(queuedShape.outcome, "queued");
      assert.equal(queuedShape.queuePosition, 1);
      assert.equal(queuedShape.reason, "queued_for_goal_slot");

      // With resumeCompletedOrchestrator: true, resumes Tier 1 in place at generation+1.
      const resumed = await orchestrator.resumeRun(run.id, {
        resumeCompletedOrchestrator: true,
        note: "Follow up on review feedback",
      });
      assert.equal(resumed.outcome, "resumed");
      assert.equal(resumed.resumed, true);
      assert.deepEqual(resumed.resumedTaskIds, [orch.id]);
      assert.equal(resumed.runStatus, "active");
      assert.equal(db.getRun(run.id)!.status, "active");
      assert.equal(db.listRuns().length, 1, "must resume in place without creating a new run");

      const updated = db.getTask(orch.id)!;
      assert.equal(updated.generation, 3);
      assert.ok(updated.status === "ready" || updated.status === "running", `expected ready/running, got ${updated.status}`);

      const handoff = JSON.parse(updated.handoffJson!) as AnchoredHandoff;
      const expectedHeader =
        `Run ${run.id}'s orchestrator had completed and its goal was handed to a human; a fresh generation continues from its anchored handoff. Open escalations are listed in your hydration.`;
      assert.ok(handoff.goalInvariants.includes("INVARIANT-A2-KEEP"));
      assert.ok(handoff.architecturalDecisions.some((d) => d.decision === "Preserve anchored handoff"));
      assert.ok(handoff.activeRisks.includes("PRIOR-RISK-MARKER"));
      assert.ok(
        handoff.activeRisks.some((r) => r.includes("Generation 2 completed previously")),
        `expected completed stopReason risk, got: ${JSON.stringify(handoff.activeRisks)}`,
      );
      assert.ok(
        !handoff.activeRisks.some((r) => r.includes("ended before completing")),
        `unexpected error stopReason risk: ${JSON.stringify(handoff.activeRisks)}`,
      );
      assert.ok(
        handoff.nextActions.includes("NEXT-ACTION-MARKER-42"),
        `expected prior nextActions marker to be preserved, got: ${JSON.stringify(handoff.nextActions)}`,
      );
      assert.ok(
        handoff.nextActions[0]?.includes(expectedHeader),
        `expected completed-orch header in handoff.nextActions[0], got: ${JSON.stringify(handoff.nextActions)}`,
      );
      assert.ok(handoff.nextActions[0]?.includes("Follow up on review feedback"));

      const events = db.getEventsSince(run.id, 0, null, 100);
      const taskResumedEv = events.find((e) => e.type === "task.resumed" && e.taskId === orch.id);
      assert.ok(taskResumedEv, "expected task.resumed event");
      const taskResumedPayload = taskResumedEv.payload as { fromStatus: string; generation: number };
      assert.equal(taskResumedPayload.fromStatus, "completed");
      assert.equal(taskResumedPayload.generation, 3);

      await started.promise;
      assert.deepEqual(launchedTaskIds, [orch.id]);
      assert.ok(capturedPrompt.includes("NEXT-ACTION-MARKER-42"));
      assert.ok(capturedPrompt.includes(expectedHeader));
    } finally {
      gate.resolve();
      if (runId) await orchestrator.stopRun(runId, "test cleanup");
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("resumes a completed Tier 1 when a blocked writable worker causes the run to derive failed, leaving the worker blocked and naming it in the note", async () => {
    const repoRoot = await makeTempGitRepo();
    const db = new ControlPlaneDb(":memory:");
    const gate = deferred<void>();
    const started = deferred<void>();
    const launchedTaskIds: string[] = [];

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        launchedTaskIds.push(req.taskId);
        started.resolve();
        await gate.promise;
        return { text: "gen+1 finished", stopReason: "completed" };
      },
    });

    const config = withFixtureCatalog({ ...loadConfig(repoRoot), codeMode: "off", stateDir: join(repoRoot, "state") });
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const orchestrator = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);

    let runId: string | null = null;
    try {
      const run = db.createRun({ goal: "Goal 26 A2 completed orch + blocked worker", repoRoot, baseBranch: "main", baseSha: "HEAD" });
      runId = run.id;
      const orch = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Tier 1 orchestrator",
        objective: "Coordinate work",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const worker = db.createTask({
        runId: run.id,
        parentId: orch.id,
        tier: 2,
        kind: "worker",
        title: "Blocked writable worker",
        objective: "Edit src/feature.ts",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
        writeScopes: ["src/feature.ts"],
      });

      const priorHandoff: AnchoredHandoff = {
        goalInvariants: ["INVARIANT-FAILED-RUN"],
        architecturalDecisions: [],
        activeRisks: [],
        nextActions: ["FAILED-RUN-MARKER"],
      };
      db.updateTask(orch.id, {
        status: "completed",
        generation: 1,
        summary: "Orch finished while worker blocked",
        handoffJson: JSON.stringify(priorHandoff),
      });
      db.updateTask(worker.id, {
        status: "blocked",
        summary: "Blocked on escalation",
      });
      db.updateRunStatus(run.id, "failed", "Blocked writable worker");

      assert.equal(orchestrator.getEffectiveRun(run.id)!.status, "failed");

      // Default resumeRun (flag unset) refuses to resume the completed Tier 1 or blocked worker.
      const defaultRes = await orchestrator.resumeRun(run.id);
      assert.equal(defaultRes.outcome, "nothing_to_resume");
      assert.equal(defaultRes.resumed, false);
      assert.deepEqual(defaultRes.resumedTaskIds, []);
      assert.equal(db.getTask(orch.id)!.status, "completed");
      assert.equal(db.getTask(worker.id)!.status, "blocked");

      // With resumeCompletedOrchestrator: true, resumes Tier 1 ONLY, leaves worker blocked, and names worker in header/note.
      const resumed = await orchestrator.resumeRun(run.id, { resumeCompletedOrchestrator: true });
      assert.equal(resumed.outcome, "resumed");
      assert.equal(resumed.resumed, true);
      assert.deepEqual(resumed.resumedTaskIds, [orch.id]);
      assert.equal(resumed.runStatus, "active");
      assert.equal(db.getRun(run.id)!.status, "active");
      assert.equal(db.listRuns().length, 1);

      const updatedOrch = db.getTask(orch.id)!;
      const updatedWorker = db.getTask(worker.id)!;
      assert.equal(updatedOrch.generation, 2);
      assert.ok(updatedOrch.status === "ready" || updatedOrch.status === "running");
      assert.equal(updatedWorker.status, "blocked", "blocked writable worker must remain blocked");

      const expectedHeader =
        `Run ${run.id}'s orchestrator had completed and its goal was handed to a human; a fresh generation continues from its anchored handoff. Blocked tasks NOT restarted: ${worker.id} (resume_task them if still needed). Open escalations are listed in your hydration.`;
      const handoff = JSON.parse(updatedOrch.handoffJson!) as AnchoredHandoff;
      assert.ok(handoff.nextActions.includes("FAILED-RUN-MARKER"));
      assert.ok(
        handoff.nextActions[0]?.includes(expectedHeader),
        `expected blocked-worker header in handoff.nextActions[0], got: ${JSON.stringify(handoff.nextActions)}`,
      );
      assert.ok(
        resumed.message.includes(worker.id),
        `expected blocked worker ${worker.id} to be named in resume message, got: ${resumed.message}`,
      );

      const events = db.getEventsSince(run.id, 0, null, 100);
      const runResumedEv = events.find((e) => e.type === "run.resumed");
      assert.ok(runResumedEv, "expected run.resumed event");
      const runResumedPayload = runResumedEv.payload as { note: string | null; resumedTaskIds: string[] };
      assert.deepEqual(runResumedPayload.resumedTaskIds, [orch.id]);
      assert.ok(runResumedPayload.note?.includes(expectedHeader));

      await started.promise;
      assert.deepEqual(launchedTaskIds, [orch.id]);
    } finally {
      gate.resolve();
      if (runId) await orchestrator.stopRun(runId, "test cleanup");
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
