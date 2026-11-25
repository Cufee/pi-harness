import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { GoalEngine } from "../src/goals/engine.js";
import { QuotaClient } from "../src/quota/client.js";
import type { RunAgentRequest, RunAgentResult } from "../src/runners/types.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const tempDirs: string[] = [];

afterEach(() => {
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return { root, repoRoot };
}

async function waitUntil(pred: () => boolean, timeoutMs = 5000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(15);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createCapturingRunner() {
  const captured = new Map<string, RunAgentRequest>();
  const resolvers: Array<() => void> = [];

  const runnerFactory: CustomRunnerFactory = () => ({
    run: (req: RunAgentRequest): Promise<RunAgentResult> => {
      captured.set(req.taskId, req);
      return new Promise<RunAgentResult>((resolve) => {
        let done = false;
        const finish = (stopReason: RunAgentResult["stopReason"]) => {
          if (done) return;
          done = true;
          resolve({ text: "ok", stopReason });
        };
        resolvers.push(() => finish("completed"));
        if (req.signal?.aborted) {
          finish("cancelled");
          return;
        }
        req.signal?.addEventListener("abort", () => finish("cancelled"), { once: true });
      });
    },
  });

  const releaseAll = () => {
    for (const r of resolvers.splice(0)) r();
  };

  return { captured, runnerFactory, releaseAll };
}

function createOrchestratorEnv(root: string, repoRoot: string, runnerFactory: CustomRunnerFactory) {
  const stateDir = join(root, "state");
  const extraRead = join(root, "extra-read");
  const extraWrite = join(root, "extra-write");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(extraRead, { recursive: true });
  mkdirSync(extraWrite, { recursive: true });

  const base = loadConfig(repoRoot);
  const config: HarnessConfig = withFixtureCatalog({
    ...base,
    stateDir,
    codeMode: "off",
    worktree: {
      ...base.worktree,
      extraReadRoots: [extraRead],
      extraWriteRoots: [extraWrite],
    },
  });

  const db = new ControlPlaneDb(":memory:");
  const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, storagePaths(config));
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);
  return { db, goals, config, orch, extraRead, extraWrite };
}

describe("orchestrator storage grants and startRun chat ownership", () => {
  it("passes storage.taskGrants verbatim for goal-linked writable worker and read-only Tier 3 task and persists startRun chatSessionId", async () => {
    const { root, repoRoot } = await initTempGitRepo("pi-orch-grants-goal-");
    const { captured, runnerFactory, releaseAll } = createCapturingRunner();
    const { db, goals, config, orch } = createOrchestratorEnv(root, repoRoot, runnerFactory);

    try {
      const chatSessionId = "chat-grants-goal";
      const goal = goals.createGoal({
        chatSessionId,
        repoRoot,
        title: "Verify orchestrator storage grants",
        description: "Ensure runner requests come from storage.taskGrants.",
        criteria: [{ id: "c1", description: "Grants match storage module", kind: "behavioral", required: true }],
      });

      const { run, orchestratorTask } = await orch.startRun({
        goal: goal.title,
        repoRoot,
        chatSessionId,
        onRunCreated: (created) => {
          goals.linkRunAndStart(goal.id, created.id);
        },
      });

      // startRun({ chatSessionId }) stores runs.chat_session_id.
      assert.equal(run.chatSessionId, chatSessionId);
      assert.equal(db.getRun(run.id)?.chatSessionId, chatSessionId);
      const rawRow = db.db
        .prepare("SELECT chat_session_id FROM runs WHERE id = ?")
        .get(run.id) as { chat_session_id: string | null } | null;
      assert.equal(rawRow?.chat_session_id, chatSessionId);

      await waitUntil(() => captured.has(orchestratorTask.id), 5000, "orchestrator runner request");

      const worker = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: orchestratorTask.id,
        tier: 2,
        kind: "worker",
        title: "Writable worker",
        objective: "Verify writable grants",
        readOnly: false,
        writeScopes: ["src/**"],
      });
      await waitUntil(() => captured.has(worker.id), 5000, "worker runner request");

      const research = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Read-only Tier 3 scout",
        objective: "Verify read-only grants",
        readOnly: true,
      });
      await waitUntil(() => captured.has(research.id), 5000, "tier-3 runner request");

      const sp = storagePaths(config);
      const runRef = { repoRoot, id: run.id, chatSessionId };
      const goalRef = { repoRoot, id: goal.id, chatSessionId };

      const workerReq = captured.get(worker.id)!;
      const expectedWorker = sp.taskGrants({
        run: runRef,
        goal: goalRef,
        writable: true,
        workspace: workerReq.cwd,
      });

      assert.equal(workerReq.toolPolicy, "read_write_workspace");
      assert.deepEqual(workerReq.extraReadRoots, expectedWorker.extraReadRoots);
      assert.deepEqual(workerReq.extraWriteRoots, expectedWorker.extraWriteRoots);
      assert.deepEqual(workerReq.extraEnv, expectedWorker.extraEnv);
      assert.deepEqual(workerReq.deniedRoots, expectedWorker.deniedRoots);
      assert.deepEqual(workerReq.protectedRoots, expectedWorker.protectedRoots);
      assert.ok(Array.isArray(workerReq.deniedRoots));
      assert.ok(Array.isArray(workerReq.protectedRoots));
      // Legacy worktree.artifactsDir override is ignored.
      assert.ok(
        !(workerReq.extraReadRoots ?? []).some((p) => p.includes(".ignored-custom-artifacts")),
        "ignored worktree.artifactsDir must not appear in extraReadRoots",
      );
      assert.equal(workerReq.extraEnv?.HARNESS_ARTIFACTS_DIR, sp.artifactsDir(runRef));
      assert.equal(workerReq.extraEnv?.HARNESS_GOAL_EVIDENCE_DIR, sp.goalEvidenceDir(goalRef));
      assert.ok(
        workerReq.initialPrompt.includes(expectedWorker.extraEnv!.HARNESS_GOAL_EVIDENCE_DIR!),
        "hydration prompt must advertise grants.extraEnv.HARNESS_GOAL_EVIDENCE_DIR",
      );

      const researchReq = captured.get(research.id)!;
      const expectedResearch = sp.taskGrants({
        run: runRef,
        goal: goalRef,
        writable: false,
        workspace: researchReq.cwd,
      });

      assert.equal(researchReq.toolPolicy, "read_only_workspace");
      assert.deepEqual(researchReq.extraReadRoots, expectedResearch.extraReadRoots);
      assert.equal(researchReq.extraWriteRoots, undefined);
      assert.deepEqual(researchReq.extraWriteRoots, expectedResearch.extraWriteRoots);
      assert.deepEqual(researchReq.extraEnv, expectedResearch.extraEnv);
      assert.deepEqual(researchReq.deniedRoots, expectedResearch.deniedRoots);
      assert.deepEqual(researchReq.protectedRoots, expectedResearch.protectedRoots);
      assert.ok(Array.isArray(researchReq.deniedRoots));
      assert.ok(Array.isArray(researchReq.protectedRoots));
    } finally {
      releaseAll();
      await orch.dispose();
      db.close();
    }
  });

  it("grants writable goals root for a run without a linked goal and stores optional startRun chatSessionId", async () => {
    const { root, repoRoot } = await initTempGitRepo("pi-orch-grants-nogoal-");
    const { captured, runnerFactory, releaseAll } = createCapturingRunner();
    const { db, config, orch, extraWrite } = createOrchestratorEnv(root, repoRoot, runnerFactory);

    try {
      const chatSessionId = "chat-grants-nogoal";
      const { run, orchestratorTask } = await orch.startRun({
        goal: "Run without linked goal",
        repoRoot,
        chatSessionId,
      });

      assert.equal(run.chatSessionId, chatSessionId);
      assert.equal(db.getRun(run.id)?.chatSessionId, chatSessionId);

      await waitUntil(() => captured.has(orchestratorTask.id), 5000, "orchestrator runner request");

      const worker = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: orchestratorTask.id,
        tier: 2,
        kind: "worker",
        title: "Non-goal worker",
        objective: "Verify goals root is writable",
        readOnly: false,
        writeScopes: ["README.md"],
      });
      await waitUntil(() => captured.has(worker.id), 5000, "non-goal worker runner request");

      const sp = storagePaths(config);
      const runRef = { repoRoot, id: run.id, chatSessionId };
      const workerReq = captured.get(worker.id)!;
      const expectedWorker = sp.taskGrants({
        run: runRef,
        goal: null,
        writable: true,
        workspace: workerReq.cwd,
      });

      assert.deepEqual(workerReq.extraReadRoots, expectedWorker.extraReadRoots);
      assert.deepEqual(workerReq.extraWriteRoots, expectedWorker.extraWriteRoots);
      assert.deepEqual(workerReq.extraWriteRoots, [sp.goalsDir(runRef), extraWrite]);
      assert.equal(workerReq.extraEnv, undefined);
      assert.deepEqual(workerReq.deniedRoots, expectedWorker.deniedRoots);
      assert.deepEqual(workerReq.protectedRoots, expectedWorker.protectedRoots);

      // Omitting chatSessionId stores null in runs.chat_session_id.
      const { run: unownedRun, orchestratorTask: unownedOrch } = await orch.startRun({
        goal: "Unowned run",
        repoRoot,
      });
      await waitUntil(() => captured.has(unownedOrch.id), 5000, "unowned orchestrator request");
      const rawRow = db.db
        .prepare("SELECT chat_session_id FROM runs WHERE id = ?")
        .get(unownedRun.id) as { chat_session_id: string | null } | null;
      assert.equal(rawRow?.chat_session_id, null);
    } finally {
      releaseAll();
      await orch.dispose();
      db.close();
    }
  });
});
