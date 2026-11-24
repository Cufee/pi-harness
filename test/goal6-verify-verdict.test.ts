import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import type { TaskRecord } from "../src/control-plane/db.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { GoalRecord } from "../src/goals/engine.js";
import { deriveGoalVerificationLabel } from "../src/protocol/tool-display.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-goal6-verify-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "init\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("goal-6: read-only blocked-with-result settles completed without Goal P0", () => {
  it("settles a final verify FAIL verdict (status: blocked with sources) as completed, records verificationStatus failed, and does not park the goal or create a Goal P0", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal6-state-"));
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: true },
        goals: { ...baseCfg.goals, autoVerifyOnSettle: true },
        stateDir,
        socketPath: join(stateDir, "d.sock"),
      });
      let releaseRelaunch: (() => void) | undefined;
      const relaunchGate = new Promise<void>((resolve) => {
        releaseRelaunch = resolve;
      });
      let runnerCalls = 0;
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            runnerCalls += 1;
            // Hold any auto-relaunched Tier 1 execution until assertions finish so we observe
            // the post-settlement transition cleanly without tripping anti-spin on an empty no-op turn.
            await Promise.race([
              relaunchGate,
              new Promise<void>((resolve) => {
                if (req.signal?.aborted) resolve();
                else req.signal?.addEventListener("abort", () => resolve(), { once: true });
              }),
            ]);
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });
      await daemon.start();
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Verify FAIL verdict must not park goal",
          description: "A verify FAIL returned via status: blocked with sources must settle completed and never raise a Goal P0.",
          criteria: [{ id: "c1", description: "Deterministic check", kind: "deterministic", command: "true", required: true }],
          verificationMode: "deterministic",
        });
        const run = daemon.db.createRun({
          goal: goal.title,
          repoRoot,
          baseBranch: "main",
          baseSha,
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const orch = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Tier 1 Orchestrator",
          objective: "Coordinate goal",
          readOnly: true,
          profileId: "pi:local",
        });
        daemon.db.updateTask(orch.id, { status: "completed", summary: "Orchestrator finished" });

        const finalVerify = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 3,
          kind: "verify",
          title: "Final verify",
          objective: "Verify acceptance criteria",
          readOnly: true,
          profileId: "pi:local",
        });
        daemon.db.updateTask(finalVerify.id, { status: "running" });

        // Raise a non-blocking parent-addressed finding before returning; settling completed must auto-resolve it.
        const finding = (await daemon.orchestrator.toolExecutor.execute(run.id, finalVerify.id, "report_issue", {
          severity: "P1",
          category: "code_defect",
          title: "Missing edge-case guard",
          evidence_paths: ["README.md"],
        })) as { escalationId: string; blocking: boolean };
        assert.equal(finding.blocking, false);

        const res = (await daemon.orchestrator.toolExecutor.execute(run.id, finalVerify.id, "return_task", {
          status: "blocked",
          summary: "Final verify: FAIL — missing edge-case guard",
          sources: [{ path: "README.md", lines: "1", note: "inspected" }],
        })) as { returned: boolean; status: string };

        assert.equal(res.returned, true);
        assert.equal(res.status, "completed");

        const persistedVerify = daemon.db.getTask(finalVerify.id)!;
        assert.equal(persistedVerify.status, "completed");
        assert.equal(JSON.parse(persistedVerify.resultJson!).status, "blocked");

        const resolvedFinding = daemon.db.getEscalation(finding.escalationId)!;
        assert.equal(resolvedFinding.status, "resolved");
        assert.equal(resolvedFinding.resolution, `Auto-resolved: raising task ${finalVerify.id} completed`);

        assert.equal(daemon.director.goals.getGoal(goal.id)?.liveProgress?.verificationStatus, "failed");

        // Settle the run and let DirectorRuntime process run.status.
        // Because finalVerify settled completed (not blocked), detectExplicitBlocker returns null:
        // the Director does not park the goal or create a Goal P0, and instead runs auto-verification,
        // sees verificationStatus === "failed", records changes_requested, and relaunches Tier 1.
        assert.equal(daemon.orchestrator.getEffectiveRun(run.id)?.status, "completed");
        daemon.db.updateRunStatus(run.id, "completed");
        await waitFor(
          () => daemon.director.goals.listReviews(goal.id).length >= 1 && runnerCalls >= 1,
          4000,
          "Director auto-verification and relaunch after verify FAIL verdict",
        );

        const settledGoal = daemon.director.goals.getGoal(goal.id)!;
        assert.notEqual(settledGoal.status, "awaiting_human");
        assert.equal(settledGoal.status, "executing");

        const reviews = daemon.director.goals.listReviews(goal.id);
        assert.equal(reviews.length, 1);
        assert.equal(reviews[0]!.verdict, "changes_requested");
        assert.equal(reviews[0]!.source, "coordinator_failed");

        const escalations = daemon.db.listEscalations(run.id);
        const p0OrGoalBlocked = escalations.filter(
          (e) => e.severity === "P0" || /^Goal .+ blocked:/i.test(e.title),
        );
        assert.deepEqual(p0OrGoalBlocked, []);
      } finally {
        releaseRelaunch?.();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps blocked for empty read-only returns and writable workers, and preserves partial/intermediate verify semantics", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal6-edge-state-"));
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: join(stateDir, "d.sock"),
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async () => ({ text: "ok", stopReason: "completed" }),
        }),
      });
      await daemon.start();
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

      try {
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          title: "Edge cases for blocked return_task",
          description: "Check empty read-only blocked, writable worker blocked, and intermediate/partial verify.",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const run = daemon.db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const orch = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orch",
          objective: "Coord",
          readOnly: true,
          profileId: "pi:local",
        });
        daemon.db.updateTask(orch.id, { status: "running" });

        // 1. Intermediate Tier 2 verify returning blocked-with-result while orchestrator is live:
        //    settles completed, but must NOT write verificationStatus because original status !== completed && otherLive.
        const interVerify = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 2,
          kind: "verify",
          title: "Intermediate verify",
          objective: "Probe",
          readOnly: true,
          profileId: "pi:local",
        });
        daemon.db.updateTask(interVerify.id, { status: "running" });
        const interRes = (await daemon.orchestrator.toolExecutor.execute(run.id, interVerify.id, "return_task", {
          status: "blocked",
          summary: "Intermediate probe found issue",
          sources: [{ path: "README.md", lines: "1" }],
        })) as { status: string };
        assert.equal(interRes.status, "completed");
        assert.equal(daemon.db.getTask(interVerify.id)?.status, "completed");
        assert.equal(daemon.director.goals.getGoal(goal.id)?.liveProgress?.verificationStatus, undefined);

        // 2. Read-only research returning blocked with result (artifact_paths + summary) settles completed.
        const researchWithResult = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 3,
          kind: "research",
          title: "Research with result",
          objective: "Inspect",
          readOnly: true,
          profileId: "pi:local",
        });
        daemon.db.updateTask(researchWithResult.id, { status: "running" });
        const researchRes = (await daemon.orchestrator.toolExecutor.execute(run.id, researchWithResult.id, "return_task", {
          status: "blocked",
          summary: "Findings captured in dossier",
          partial: true,
          artifact_paths: [".harness/artifacts/notes.md"],
        })) as { status: string };
        assert.equal(researchRes.status, "completed");
        assert.equal(daemon.db.getTask(researchWithResult.id)?.status, "completed");

        // Complete orchestrator so subsequent verify is final.
        daemon.db.updateTask(orch.id, { status: "completed" });

        // 3. Read-only verify returning blocked with empty summary (no result) + partial: true stays blocked
        //    and records neither passed nor failed on verificationStatus.
        const emptyBlockedVerify = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 3,
          kind: "verify",
          title: "Empty blocked verify",
          objective: "Verify",
          readOnly: true,
          profileId: "pi:local",
        });
        daemon.db.updateTask(emptyBlockedVerify.id, { status: "running" });
        const emptyRes = (await daemon.orchestrator.toolExecutor.execute(run.id, emptyBlockedVerify.id, "return_task", {
          status: "blocked",
          summary: "   ",
          partial: true,
          artifact_paths: [".harness/artifacts/empty.md"],
        })) as { status: string };
        assert.equal(emptyRes.status, "blocked");
        assert.equal(daemon.db.getTask(emptyBlockedVerify.id)?.status, "blocked");
        assert.equal(daemon.director.goals.getGoal(goal.id)?.liveProgress?.verificationStatus, undefined);

        // 4. Writable worker returning blocked with summary + sources stays blocked (unchanged).
        const worker = daemon.db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 2,
          kind: "worker",
          title: "Writable worker",
          objective: "Edit file",
          readOnly: false,
          profileId: "pi:local",
          writeScopes: ["README.md"],
        });
        daemon.db.updateTask(worker.id, { status: "running" });
        const workerRes = (await daemon.orchestrator.toolExecutor.execute(run.id, worker.id, "return_task", {
          status: "blocked",
          summary: "Blocked on external dependency",
          sources: [{ path: "README.md", lines: "1" }],
        })) as { status: string };
        assert.equal(workerRes.status, "blocked");
        assert.equal(daemon.db.getTask(worker.id)?.status, "blocked");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("deriveGoalVerificationLabel prioritizes verify failed over completed verify count when reviewCycle is 0", () => {
    const baseGoal: GoalRecord = {
      id: "goal-6",
      chatSessionId: "chat-1",
      repoRoot: "/tmp/repo",
      version: 3,
      title: "Goal 6 verify label",
      description: "Ensure verify failed outranks completed verify count.",
      criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      nonGoals: [],
      budgets: { maxReviewCycles: 10, maxNoProgressCycles: 3 },
      verificationMode: "auto",
      verifyRef: "main",
      liveProgress: null,
      status: "executing",
      linkedRunId: "run-1",
      reviewCycle: 0,
      noProgressStreak: 0,
      lastProgressFingerprint: null,
      lastReviewSummary: null,
      createdAt: 1_000,
      updatedAt: 2_000,
    };

    const completedVerifyTask: TaskRecord = {
      id: "t-verify-1",
      runId: "run-1",
      parentId: "t-orch-1",
      tier: 3,
      kind: "verify",
      title: "Final verify",
      objective: "Verify criteria",
      criteria: "",
      readOnly: true,
      profileId: "pi:local",
      model: null,
      effort: null,
      status: "completed",
      generation: 1,
      maxTurns: 20,
      turnsUsed: 3,
      contextUsed: 0,
      contextSize: 0,
      worktreeId: null,
      sessionId: null,
      summary: "Final verify: FAIL",
      handoffJson: null,
      resultJson: null,
      createdAt: 1_100,
      updatedAt: 1_900,
    };

    assert.equal(
      deriveGoalVerificationLabel(
        {
          ...baseGoal,
          liveProgress: {
            verificationStatus: "failed",
            updatedAt: 2_000,
          },
        },
        [completedVerifyTask],
      ),
      "verify failed",
    );

    assert.equal(
      deriveGoalVerificationLabel(
        {
          ...baseGoal,
          liveProgress: {
            verificationStatus: "passed",
            updatedAt: 2_000,
          },
        },
        [completedVerifyTask],
      ),
      "1 verified",
    );

    assert.equal(
      deriveGoalVerificationLabel(
        {
          ...baseGoal,
          liveProgress: null,
        },
        [completedVerifyTask],
      ),
      "1 verified",
    );

    assert.equal(
      deriveGoalVerificationLabel(
        {
          ...baseGoal,
          liveProgress: {
            phase: "implementing",
            updatedAt: 2_000,
          },
        },
        [completedVerifyTask],
      ),
      "1 verified",
    );
    assert.equal(
      deriveGoalVerificationLabel(
        {
          ...baseGoal,
          reviewCycle: 1,
          liveProgress: {
            verificationStatus: "failed",
            updatedAt: 2_000,
          },
        },
        [completedVerifyTask],
      ),
      "1 rev",
    );
  });
});
