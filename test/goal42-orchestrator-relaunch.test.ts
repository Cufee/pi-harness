import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import { ACP_EXECUTOR_LOST_ERROR_CODE } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; stateDir: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  const stateDir = join(root, "state");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, stateDir, baseSha };
}

function makeOrchestrator(repoRoot: string, stateDir: string, runnerFactory: CustomRunnerFactory) {
  const db = new ControlPlaneDb(":memory:");
  const config = withFixtureCatalog({
    ...loadConfig(repoRoot),
    stateDir,
    codeMode: "off",
  });
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);
  return { db, config, orch };
}

async function waitUntil(pred: () => boolean, timeoutMs = 8_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  assert.ok(pred(), `Timed out waiting for ${label}`);
}

describe("goal-42 Slice B: Tier 1 relaunch on ACP_EXECUTOR_LOST_ERROR_CODE", () => {
  for (const stopReason of ["error", "cancelled"] as const) {
    it(`relaunches Tier 1 as generation+1 from handoff when runner returns { stopReason: "${stopReason}", errorCode: ACP_EXECUTOR_LOST_ERROR_CODE }`, async () => {
      const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo(`pi-g42-relaunch-t1-${stopReason}-`);
      const seenGenerations: number[] = [];
      const genPrompts: string[] = [];

      const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
        run: async (req) => {
          const gen = req.taskGeneration ?? seenGenerations.length + 1;
          seenGenerations.push(gen);
          genPrompts.push(req.initialPrompt);
          if (gen === 1) {
            return {
              text: "No executor is connected during wait_children",
              stopReason,
              errorCode: ACP_EXECUTOR_LOST_ERROR_CODE,
            };
          }
          return {
            text: "Recovered in generation 2 and finished",
            stopReason: "completed",
          };
        },
      }));

      try {
        const run = db.createRun({
          goal: `Tier 1 relaunch on ${stopReason}`,
          repoRoot,
          baseBranch: "main",
          baseSha,
        });
        const t1 = db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Tier 1 Orchestrator",
          objective: "Coordinate run across executor loss",
          readOnly: true,
          profileId: "pi:local",
          model: "fixture/fixture",
        });
        const seededRisk = `Seeded prior risk (${stopReason}): worker-B holds shared lease`;
        const seededAction = `Seeded prior action (${stopReason}): verify slice C after relaunch`;
        db.updateTask(t1.id, {
          handoffJson: JSON.stringify({
            goalInvariants: ["Never lose prior handoff state"],
            architecturalDecisions: [{ decision: "Use wait-routed steering", rationale: "Avoids cancel-steer" }],
            activeRisks: [seededRisk],
            nextActions: [seededAction],
          }),
        });

        orch.launchTaskLoop(t1.id);
        await waitUntil(
          () => ["completed", "failed", "cancelled"].includes(db.getTask(t1.id)?.status ?? ""),
          8_000,
          "T1 settles",
        );

        const finalTask = db.getTask(t1.id)!;
        assert.deepEqual(seenGenerations, [1, 2], "Tier 1 must relaunch cleanly into generation 2");
        assert.equal(finalTask.generation, 2);
        assert.equal(finalTask.status, "completed");
        assert.ok(
          genPrompts[1]?.includes(ACP_EXECUTOR_LOST_ERROR_CODE) ||
            genPrompts[1]?.includes("No executor is connected during wait_children"),
          "Generation 2 hydration prompt must carry generation 1 handoff context",
        );
        const persistedHandoff = finalTask.handoffJson
          ? (JSON.parse(finalTask.handoffJson) as { activeRisks?: string[]; nextActions?: string[] })
          : null;
        assert.ok(
          persistedHandoff?.activeRisks?.includes(seededRisk),
          `Expected prior activeRisks to survive executor-loss relaunch (${stopReason}), got: ${JSON.stringify(persistedHandoff?.activeRisks)}`,
        );
        assert.ok(
          persistedHandoff?.nextActions?.includes(seededAction),
          `Expected prior nextActions to survive executor-loss relaunch (${stopReason}), got: ${JSON.stringify(persistedHandoff?.nextActions)}`,
        );
        assert.ok(
          genPrompts[1]?.includes(seededRisk),
          `Generation 2 prompt must include prior activeRisk (${stopReason})`,
        );
        assert.ok(
          genPrompts[1]?.includes(seededAction),
          `Generation 2 prompt must include prior nextAction (${stopReason})`,
        );

        const rolloverEvents = db
          .getEventsSince(run.id, 0, t1.id)
          .filter((e) => e.type === "agent.rollover");
        assert.equal(rolloverEvents.length, 1);
        assert.deepEqual(rolloverEvents[0]!.payload, {
          fromGen: 1,
          toGen: 2,
          reason: "acp_executor_lost",
        });
      } finally {
        await orch.dispose();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("bounds repeated zero-progress acp_executor_lost relaunches via rollOver's no-progress streak guard and preserves diagnostic", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-g42-relaunch-streak-");
    const seenGenerations: number[] = [];

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        seenGenerations.push(req.taskGeneration ?? seenGenerations.length + 1);
        return {
          text: "No executor is connected",
          stopReason: "error",
          errorCode: ACP_EXECUTOR_LOST_ERROR_CODE,
        };
      },
    }));

    try {
      const run = db.createRun({
        goal: "Bounded relaunch loop",
        repoRoot,
        baseBranch: "main",
        baseSha,
      });
      const t1 = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Tier 1 repeatedly losing executor",
        objective: "Verify no infinite relaunch loop",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      orch.launchTaskLoop(t1.id);
      await waitUntil(() => db.getTask(t1.id)?.status === "failed", 8_000, "T1 stops on zero-progress streak");

      const finalTask = db.getTask(t1.id)!;
      assert.deepEqual(seenGenerations, [1, 2, 3], "No-progress guard must stop on the 3rd unchanged window");
      assert.equal(finalTask.status, "failed");
      assert.ok(
        finalTask.summary?.includes(ACP_EXECUTOR_LOST_ERROR_CODE),
        `Expected ${ACP_EXECUTOR_LOST_ERROR_CODE} in failure summary, got: ${finalTask.summary}`,
      );
      const parsedResult = finalTask.resultJson ? (JSON.parse(finalTask.resultJson) as Record<string, unknown>) : null;
      assert.equal(parsedResult?.errorCode, ACP_EXECUTOR_LOST_ERROR_CODE);
    } finally {
      await orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does NOT relaunch Tier 1 when explicitly cancelled via cancelTask even if runner returns acp_executor_lost", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-g42-relaunch-explicit-cancel-");
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const seenGenerations: number[] = [];

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        seenGenerations.push(req.taskGeneration ?? seenGenerations.length + 1);
        req.onHandle?.({
          steer: async () => false,
          cancel: async () => cancelled.resolve(),
        });
        started.resolve();
        await cancelled.promise;
        return {
          text: "No executor is connected",
          stopReason: "cancelled",
          errorCode: ACP_EXECUTOR_LOST_ERROR_CODE,
        };
      },
    }));

    try {
      const run = db.createRun({
        goal: "Explicit cancel never relaunches",
        repoRoot,
        baseBranch: "main",
        baseSha,
      });
      const t1 = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Tier 1 cancelled by user",
        objective: "Verify explicit cancel settles as cancelled",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      orch.launchTaskLoop(t1.id);
      await started.promise;
      await orch.cancelTask(t1.id, "Explicit stop");

      const finalTask = db.getTask(t1.id)!;
      assert.deepEqual(seenGenerations, [1]);
      assert.equal(finalTask.status, "cancelled");
      assert.equal(finalTask.generation, 1);
    } finally {
      cancelled.resolve();
      await orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  for (const stopReason of ["error", "cancelled"] as const) {
    it(`records Tier 2 worker as failed with ${ACP_EXECUTOR_LOST_ERROR_CODE} (no relaunch) when runner returns { stopReason: "${stopReason}", errorCode: ACP_EXECUTOR_LOST_ERROR_CODE }`, async () => {
      const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo(`pi-g42-relaunch-t2-${stopReason}-`);
      const seenGenerations: number[] = [];

      const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
        run: async (req) => {
          seenGenerations.push(req.taskGeneration ?? seenGenerations.length + 1);
          return {
            text: "No executor is connected",
            stopReason,
            errorCode: ACP_EXECUTOR_LOST_ERROR_CODE,
          };
        },
      }));

      try {
        const run = db.createRun({
          goal: `Tier 2 fails on ${stopReason} with acp_executor_lost`,
          repoRoot,
          baseBranch: "main",
          baseSha,
        });
        const parent = db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Parent T1",
          objective: "Parent",
          readOnly: true,
          profileId: "pi:local",
          model: "fixture/fixture",
        });
        db.updateTask(parent.id, { status: "running" });

        const worker = await orch.spawnAndStartTask({
          runId: run.id,
          parentId: parent.id,
          tier: 2,
          kind: "worker",
          title: "Tier 2 Worker",
          objective: "Implement feature",
          readOnly: false,
          writeScopes: ["README.md"],
          profileId: "pi:local",
          model: "fixture/fixture",
        });

        await waitUntil(() => db.getTask(worker.id)?.status === "failed", 8_000, "T2 settles as failed");

        const finalWorker = db.getTask(worker.id)!;
        assert.deepEqual(seenGenerations, [1], "Tier 2 must NOT be relaunched on acp_executor_lost");
        assert.equal(finalWorker.generation, 1);
        assert.equal(finalWorker.status, "failed");
        assert.ok(
          finalWorker.summary?.includes(ACP_EXECUTOR_LOST_ERROR_CODE),
          `Expected ${ACP_EXECUTOR_LOST_ERROR_CODE} in worker summary, got: ${finalWorker.summary}`,
        );
        const parsedResult = finalWorker.resultJson
          ? (JSON.parse(finalWorker.resultJson) as { errorCode?: string; fallback?: { error_code?: string; reason?: string } })
          : null;
        assert.equal(parsedResult?.errorCode, ACP_EXECUTOR_LOST_ERROR_CODE);
        assert.equal(parsedResult?.fallback?.error_code, ACP_EXECUTOR_LOST_ERROR_CODE);
        assert.ok(
          parsedResult?.fallback?.reason?.includes(ACP_EXECUTOR_LOST_ERROR_CODE),
          `Expected ${ACP_EXECUTOR_LOST_ERROR_CODE} in fallback.reason, got: ${parsedResult?.fallback?.reason}`,
        );

        const rolloverEvents = db
          .getEventsSince(run.id, 0, worker.id)
          .filter((e) => e.type === "agent.rollover");
        assert.equal(rolloverEvents.length, 0);
      } finally {
        await orch.dispose();
        db.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

  it("P1-2: coded acp_executor_lost beats context-overflow text heuristics on both Tier 2 (fails without rollover) and Tier 1 (relaunches with acp_executor_lost)", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-g42-p12-overflow-");
    const t2Gens: number[] = [];
    const t1Gens: number[] = [];

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        if (req.tier === 2) {
          t2Gens.push(req.taskGeneration ?? t2Gens.length + 1);
          return {
            text: "Observed earlier note: maximum context length exceeded; then No executor is connected",
            stopReason: "error",
            errorCode: ACP_EXECUTOR_LOST_ERROR_CODE,
          };
        }
        const gen = req.taskGeneration ?? t1Gens.length + 1;
        t1Gens.push(gen);
        if (gen === 1) {
          return {
            text: "maximum context length exceeded in log excerpt; No executor is connected",
            stopReason: "error",
            errorCode: ACP_EXECUTOR_LOST_ERROR_CODE,
          };
        }
        return { text: "T1 recovered in gen 2", stopReason: "completed" };
      },
    }));

    try {
      const run = db.createRun({
        goal: "Coded executor loss beats overflow text heuristic",
        repoRoot,
        baseBranch: "main",
        baseSha,
      });
      const t1 = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Tier 1 with overflow text in error",
        objective: "Relaunch with acp_executor_lost reason",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(t1.id, { status: "running" });

      const t2 = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Tier 2 with overflow text in error",
        objective: "Must fail immediately with acp_executor_lost",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      await waitUntil(
        () => ["completed", "failed", "cancelled", "paused_quota"].includes(db.getTask(t2.id)?.status ?? ""),
        8_000,
        "T2 settles",
      );

      const finalT2 = db.getTask(t2.id)!;
      assert.deepEqual(t2Gens, [1], `Tier 2 must fail in gen 1 without overflow rollover, got gens ${JSON.stringify(t2Gens)}`);
      assert.equal(finalT2.status, "failed");
      assert.equal(finalT2.generation, 1);
      assert.ok(finalT2.summary?.includes(ACP_EXECUTOR_LOST_ERROR_CODE));
      const t2Result = finalT2.resultJson ? (JSON.parse(finalT2.resultJson) as { errorCode?: string }) : null;
      assert.equal(t2Result?.errorCode, ACP_EXECUTOR_LOST_ERROR_CODE);
      assert.equal(
        db.getEventsSince(run.id, 0, t2.id).filter((e) => e.type === "agent.rollover").length,
        0,
        "Tier 2 must NOT emit agent.rollover on acp_executor_lost",
      );

      // Now run Tier 1 with the same overflow text + coded acp_executor_lost
      db.updateTask(t1.id, { status: "ready" });
      orch.launchTaskLoop(t1.id);
      await waitUntil(() => db.getTask(t1.id)?.status === "completed", 8_000, "T1 completes after relaunch");

      assert.deepEqual(t1Gens, [1, 2]);
      const t1Rollovers = db.getEventsSince(run.id, 0, t1.id).filter((e) => e.type === "agent.rollover");
      assert.equal(t1Rollovers.length, 1);
      assert.deepEqual(t1Rollovers[0]!.payload, {
        fromGen: 1,
        toGen: 2,
        reason: "acp_executor_lost",
      });
    } finally {
      await orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("P1-2: coded acp_executor_lost beats child-quota propagation on Tier 2 (fails instead of paused_quota)", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-g42-p12-child-quota-");
    const t2Gens: number[] = [];

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        t2Gens.push(req.taskGeneration ?? t2Gens.length + 1);
        // Seed a quota-paused Tier 3 child under this Tier 2 worker before failing with acp_executor_lost.
        const child = db.createTask({
          runId: req.runId,
          parentId: req.taskId,
          tier: 3,
          kind: "research",
          title: "Quota-paused Tier 3 child",
          objective: "Paused on provider quota",
          readOnly: true,
          profileId: "pi:local",
          model: "fixture/fixture",
        });
        db.updateTask(child.id, { status: "paused_quota", summary: "Paused on quota" });
        return {
          text: "No executor is connected",
          stopReason: "error",
          errorCode: ACP_EXECUTOR_LOST_ERROR_CODE,
        };
      },
    }));

    try {
      const run = db.createRun({
        goal: "Coded executor loss beats child quota propagation",
        repoRoot,
        baseBranch: "main",
        baseSha,
      });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Parent T1",
        objective: "Parent",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      const worker = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Tier 2 with quota-paused T3 child",
        objective: "Must fail with acp_executor_lost rather than becoming paused_quota",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      await waitUntil(
        () => ["completed", "failed", "cancelled", "paused_quota"].includes(db.getTask(worker.id)?.status ?? ""),
        8_000,
        "T2 settles",
      );

      const finalWorker = db.getTask(worker.id)!;
      assert.deepEqual(t2Gens, [1]);
      assert.equal(finalWorker.status, "failed", `Expected failed, got ${finalWorker.status}`);
      assert.ok(
        finalWorker.summary?.includes(ACP_EXECUTOR_LOST_ERROR_CODE),
        `Expected ${ACP_EXECUTOR_LOST_ERROR_CODE} in worker summary, got: ${finalWorker.summary}`,
      );
      const parsed = finalWorker.resultJson
        ? (JSON.parse(finalWorker.resultJson) as { errorCode?: string; fallback?: { error_code?: string } })
        : null;
      assert.equal(parsed?.errorCode, ACP_EXECUTOR_LOST_ERROR_CODE);
      assert.equal(parsed?.fallback?.error_code, ACP_EXECUTOR_LOST_ERROR_CODE);
    } finally {
      await orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
