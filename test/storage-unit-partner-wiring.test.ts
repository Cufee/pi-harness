import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const tempDirs: string[] = [];
const ORIGINAL_LAYOUT = process.env.PI_HARNESS_STORAGE_LAYOUT;

function setLayoutEnv(layout: "legacy" | "data-dir" | undefined): void {
  if (layout === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = layout;
  resetStoragePathsForTest();
}

afterEach(() => {
  setLayoutEnv(ORIGINAL_LAYOUT as "legacy" | "data-dir" | undefined);
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# partner wiring repo\n", "utf8");
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

describe("goal/run partner ID wiring in data-dir layout (esc-155 Option A)", () => {
  it("keeps live legacy goal+run units unsplit from either call order through Orchestrator, ControlPlaneToolExecutor, and GoalEngine", async () => {
    setLayoutEnv("data-dir");
    const { root, repoRoot } = await initTempGitRepo("pi-fw-partner-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = withFixtureCatalog({
      ...base,
      stateDir,
      storage: { dataDir: join(stateDir, "data") },
      codeMode: "off",
    });

    const sp = storagePaths(config, { layout: "data-dir" });
    const legacySp = createLegacyStoragePaths(config);
    assert.equal(sp.layout, "data-dir");

    const { captured, runnerFactory, releaseAll } = createCapturingRunner();
    const db = new ControlPlaneDb(":memory:");
    const legacyGoals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, legacySp);
    const ddGoals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);

    const chatSessionId = "chat-partner-1";
    const dataChatDir = sp.chatDir({ repoRoot, chatSessionId });

    try {
      // --- Case 1: legacy goal evidence dir exists; linked run has NO artifacts dir yet ---
      const goal1 = legacyGoals.createGoal({
        chatSessionId,
        repoRoot,
        title: "Live legacy goal before first dossier",
        description: "Ensure first run dossier and taskGrants stay in legacy layout.",
        criteria: [{ id: "c1", description: "Unit stays legacy", kind: "behavioral", required: true }],
      });
      const legacyGoal1Dir = legacySp.goalEvidenceDir(goal1);
      assert.equal(existsSync(legacyGoal1Dir), true);

      const run1 = db.createRun({
        repoRoot,
        chatSessionId,
        goal: goal1.title,
        baseBranch: "main",
        baseSha: (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim(),
      });
      db.db
        .prepare("UPDATE goals SET linked_run_id = ?, status = 'executing' WHERE id = ?")
        .run(run1.id, goal1.id);

      const orchProfileId = config.defaultOrchestratorProfile ?? config.profiles[0]!.id;
      const workerProfileId = config.defaultWorkerProfile ?? config.profiles[0]!.id;
      const orchTask1 = db.createTask({
        runId: run1.id,
        tier: 1,
        kind: "orchestrator",
        title: "Root orchestrator",
        objective: goal1.title,
        readOnly: true,
        profileId: orchProfileId,
      });
      const worker1 = db.createTask({
        runId: run1.id,
        parentId: orchTask1.id,
        tier: 2,
        kind: "worker",
        title: "First dossier worker",
        objective: "Write first dossier before taskGrants runs",
        readOnly: false,
        profileId: workerProfileId,
      });

      const legacyRun1Dir = legacySp.runArtifactsDir(run1);
      const dataDirRun1Dir = join(dataChatDir, "artifacts", run1.id);
      assert.equal(existsSync(legacyRun1Dir), false, "precondition: legacy run dir must not exist yet");
      assert.equal(existsSync(dataDirRun1Dir), false, "precondition: data-dir run dir must not exist yet");

      // Writing the run's first dossier through ControlPlaneToolExecutor must land in legacy location.
      const written = (await orch.toolExecutor.execute(run1.id, worker1.id, "artifact_write", {
        name: "first-dossier.md",
        content: "# first dossier\n",
        summary: "First dossier for legacy goal unit",
      })) as { artifactId: string; path: string };

      const expectedFirstDossier = join(legacyRun1Dir, worker1.id, "first-dossier.md");
      assert.equal(written.path, expectedFirstDossier);
      assert.equal(existsSync(expectedFirstDossier), true);
      assert.equal(existsSync(dataDirRun1Dir), false, "must not split run artifacts into data-dir");

      // Launching a writable worker in that run through Orchestrator must grant the legacy unit.
      const launchedWorker = await orch.spawnAndStartTask({
        runId: run1.id,
        parentId: orchTask1.id,
        tier: 2,
        kind: "worker",
        title: "Grants check worker",
        objective: "Verify taskGrants uses legacy unit",
        readOnly: false,
        writeScopes: ["README.md"],
      });
      await waitUntil(() => captured.has(launchedWorker.id), 5000, "launched worker runner request");

      const req = captured.get(launchedWorker.id)!;
      assert.equal(req.extraEnv?.HARNESS_GOAL_ID, goal1.id);
      assert.equal(req.extraEnv?.HARNESS_GOAL_EVIDENCE_DIR, legacyGoal1Dir);
      assert.equal(req.extraEnv?.HARNESS_GOALS_DIR, legacySp.goalsDir(goal1));
      assert.equal(req.extraEnv?.HARNESS_ARTIFACTS_DIR, legacySp.artifactsDir(run1));
      assert.ok(
        req.extraWriteRoots?.includes(legacyGoal1Dir),
        `expected extraWriteRoots to include legacy goal dir ${legacyGoal1Dir}, got ${JSON.stringify(req.extraWriteRoots)}`,
      );
      assert.ok(
        req.extraReadRoots?.includes(legacySp.goalsDir(goal1)),
        `expected extraReadRoots to include legacy goals root`,
      );
      assert.ok(
        req.extraReadRoots?.includes(legacySp.artifactsDir(run1)),
        `expected extraReadRoots to include legacy artifacts root`,
      );

      releaseAll();
      await waitUntil(() => {
        const s = db.getTask(launchedWorker.id)?.status;
        return s !== undefined && s !== "running" && s !== "pending" && s !== "ready";
      }, 5000, "launched worker to settle");

      // --- Case 2 (mirror): legacy run artifacts dir exists; goal has NO evidence dir yet ---
      const run2 = db.createRun({
        repoRoot,
        chatSessionId,
        goal: "Mirror legacy run unit",
        baseBranch: "main",
        baseSha: (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim(),
      });
      const legacyRun2Dir = legacySp.ensureDossierDir(run2, run2.id);
      assert.equal(existsSync(legacyRun2Dir), true);

      const goal2 = ddGoals.createGoal({
        chatSessionId,
        repoRoot,
        title: "Mirror goal with legacy run dir",
        description: "Ensure GoalEngine creates legacy evidence dir when linked run is legacy.",
        criteria: [{ id: "c1", description: "Mirror unit stays legacy", kind: "behavioral", required: true }],
      });
      const legacyGoal2Dir = legacySp.goalEvidenceDir(goal2);
      const dataDirGoal2Dir = join(dataChatDir, "goals", goal2.id);
      // Remove the data-dir goal dir created at draft time so neither goal evidence dir exists before linking.
      rmSync(dataDirGoal2Dir, { recursive: true, force: true });
      assert.equal(existsSync(legacyGoal2Dir), false, "precondition: legacy goal dir must not exist yet");
      assert.equal(existsSync(dataDirGoal2Dir), false, "precondition: data-dir goal dir must not exist yet");

      // GoalEngine.evidenceLocations with explicit runId must resolve both halves to legacy.
      const locsBeforeLink = ddGoals.evidenceLocations(goal2, run2.id);
      assert.equal(locsBeforeLink.goalEvidenceDir, legacyGoal2Dir);
      assert.equal(locsBeforeLink.goalsDir, legacySp.goalsDir(goal2));
      assert.equal(locsBeforeLink.artifactsDir, legacySp.artifactsDir(run2));
      assert.equal(locsBeforeLink.runArtifactsDir, legacyRun2Dir);

      // GoalEngine.linkRunAndStart must pass linkedRunId: run2.id to ensureGoalEvidenceDir and create legacyGoal2Dir.
      const linked2 = ddGoals.linkRunAndStart(goal2.id, run2.id);
      assert.equal(linked2.linkedRunId, run2.id);
      assert.equal(existsSync(legacyGoal2Dir), true, "linkRunAndStart must create the legacy goal evidence dir");
      assert.equal(existsSync(dataDirGoal2Dir), false, "must not split goal evidence into data-dir");
      assert.equal(ddGoals.ensureEvidenceDir(linked2), legacyGoal2Dir);
    } finally {
      releaseAll();
      orch.dispose();
      db.close();
    }
  });
});
