import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { effectiveCodeMode } from "../src/code-mode/index.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { compactTaskHandoff } from "../src/control-plane/handoffs.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, baseSha };
}

function createTestOrchestrator(
  repoRoot: string,
  stateDir: string,
  runnerFactory: CustomRunnerFactory,
  codeMode: "off" | "collapsed" | "hybrid" = "off",
) {
  const db = new ControlPlaneDb(":memory:");
  const baseCfg = loadConfig(repoRoot);
  const config = withFixtureCatalog({
    ...baseCfg,
    codeMode,
    stateDir,
  });
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);
  return { db, config, orch };
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  assert.ok(pred(), `Timed out waiting for ${label}`);
}

describe("goal-13 re-review regression fixes", () => {
  it("accepts Code Mode-style return_task (distinct script signal) for live Tier 2 and Tier 3 tasks while rejecting aborted/stale returns", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g13-cm-ret-");
    const stateDir = join(root, "state");

    const t3Ready = Promise.withResolvers<void>();
    const t3Release = Promise.withResolvers<void>();
    const t2Ready = Promise.withResolvers<void>();
    const t2Release = Promise.withResolvers<void>();
    const t2StaleReady = Promise.withResolvers<void>();
    const t2StaleRelease = Promise.withResolvers<void>();
    const t2ScriptAbortReady = Promise.withResolvers<void>();
    const t2ScriptAbortRelease = Promise.withResolvers<void>();

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        if (req.initialPrompt.includes("CASE_T3_CM_RETURN")) {
          t3Ready.resolve();
          await t3Release.promise;
          return { text: "", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_T2_CM_RETURN")) {
          t2Ready.resolve();
          await t2Release.promise;
          return { text: "", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_T2_STALE_GEN")) {
          if (req.initialPrompt.includes("Generation: 1") || req.initialPrompt.includes("gen=1")) {
            t2StaleReady.resolve();
            await t2StaleRelease.promise;
          }
          return { text: "", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_T2_SCRIPT_ABORT")) {
          t2ScriptAbortReady.resolve();
          await t2ScriptAbortRelease.promise;
          return { text: "", stopReason: "completed" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    });

    const { db, orch } = createTestOrchestrator(repoRoot, stateDir, runnerFactory, "off");

    try {
      const run = db.createRun({ goal: "Code Mode return_task gate", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      // 1a. Live Tier 3 research task completes via Code Mode-style return_task (distinct scriptSignal).
      const t3 = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Live T3 CM return",
        objective: "CASE_T3_CM_RETURN",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await t3Ready.promise;

      const t3ScriptAbort = new AbortController();
      const t3Res = (await orch.toolExecutor.execute(
        run.id,
        t3.id,
        "return_task",
        {
          status: "completed",
          summary: "Tier 3 Code Mode return succeeded",
          sources: [{ path: "README.md", note: "verified" }],
        },
        t3ScriptAbort.signal,
      )) as { returned: boolean; status: string };
      assert.equal(t3Res.returned, true);
      assert.equal(t3Res.status, "completed");
      assert.equal(db.getTask(t3.id)?.status, "completed");
      t3Release.resolve();

      // 1b. Live Tier 2 worker with worktree completes via Code Mode-style return_task across async git checks.
      const t2 = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Live T2 CM return",
        objective: "CASE_T2_CM_RETURN",
        readOnly: false,
        writeScopes: ["a.txt"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await t2Ready.promise;

      const t2ScriptAbort = new AbortController();
      const t2Res = (await orch.toolExecutor.execute(
        run.id,
        t2.id,
        "return_task",
        {
          status: "completed",
          summary: "Tier 2 Code Mode return succeeded",
        },
        t2ScriptAbort.signal,
      )) as { returned: boolean; status: string };
      assert.equal(t2Res.returned, true);
      assert.equal(t2Res.status, "completed");
      assert.equal(db.getTask(t2.id)?.status, "completed");
      t2Release.resolve();

      // 1c. Script abort mid-await during Tier 2 worktree git check rejects settlement even though task stays live.
      const t2Script = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "T2 script abort mid-await",
        objective: "CASE_T2_SCRIPT_ABORT",
        readOnly: false,
        writeScopes: ["b.txt"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await t2ScriptAbortReady.promise;

      const wtMgr = orch.getWorktreeManager(repoRoot);
      const origIsDirty = wtMgr.isDirty.bind(wtMgr);
      const scriptAbortGate = Promise.withResolvers<void>();
      const scriptAbortEntered = Promise.withResolvers<void>();
      wtMgr.isDirty = async (wtPath) => {
        scriptAbortEntered.resolve();
        await scriptAbortGate.promise;
        return origIsDirty(wtPath);
      };
      const midScriptAbort = new AbortController();
      let scriptAbortPromise: Promise<unknown>;
      try {
        scriptAbortPromise = orch.toolExecutor.execute(
          run.id,
          t2Script.id,
          "return_task",
          { status: "completed", summary: "Should abort when script aborts" },
          midScriptAbort.signal,
        );
        await scriptAbortEntered.promise;
        midScriptAbort.abort(new Error("Code Mode timed out"));
        scriptAbortGate.resolve();
        await assert.rejects(() => scriptAbortPromise, /return_task aborted|cancelled or superseded/);
      } finally {
        wtMgr.isDirty = origIsDirty;
      }
      assert.equal(db.getTask(t2Script.id)?.status, "running", "Aborted script must not settle live task");
      t2ScriptAbortRelease.resolve();

      // 1d. Stale generation return_task (task advances generation mid-await) still rejects.
      const t2Stale = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "T2 stale gen mid-await",
        objective: "CASE_T2_STALE_GEN",
        readOnly: false,
        writeScopes: ["c.txt"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await t2StaleReady.promise;

      const staleGate = Promise.withResolvers<void>();
      const staleEntered = Promise.withResolvers<void>();
      wtMgr.isDirty = async (wtPath) => {
        staleEntered.resolve();
        await staleGate.promise;
        return origIsDirty(wtPath);
      };
      const staleScriptAbort = new AbortController();
      try {
        const stalePromise = orch.toolExecutor.execute(
          run.id,
          t2Stale.id,
          "return_task",
          { status: "completed", summary: "Stale gen-1 return" },
          staleScriptAbort.signal,
        );
        await staleEntered.promise;
        // Advance the task generation while gen-1's return_task is awaiting worktree checks.
        db.updateTask(t2Stale.id, { generation: 2 });
        staleGate.resolve();
        await assert.rejects(() => stalePromise, /Stale return_task.*generation 1.*current generation 2/);
      } finally {
        wtMgr.isDirty = origIsDirty;
      }
      assert.equal(db.getTask(t2Stale.id)?.status, "running", "Stale generation return must not settle gen-2");
      t2StaleRelease.resolve();

      await waitUntil(() => orch.activeTaskCount() === 0, 4000, "all runners to settle");

      // 1e. Stale Code Mode return_task after runner has exited (no live generation signal) must be rejected.
      const orphanedLive = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "No active gen T3",
        objective: "Orphaned",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(orphanedLive.id, { status: "running" });
      await assert.rejects(
        () =>
          orch.toolExecutor.execute(
            run.id,
            orphanedLive.id,
            "return_task",
            { status: "completed", summary: "Late script return", sources: [{ path: "README.md" }] },
            new AbortController().signal,
          ),
        /requires an active task generation|no longer the active execution/,
      );
      assert.equal(db.getTask(orphanedLive.id)?.status, "running");

      // 1f. On hosts with sandboxed Code Mode enabled (macOS), exercise real collapsed-mode code_exec -> return_task.
      if (effectiveCodeMode("collapsed") !== "off") {
        const cmReady = Promise.withResolvers<void>();
        const cmRelease = Promise.withResolvers<void>();
        const cm = createTestOrchestrator(
          repoRoot,
          join(root, "state-cm"),
          () => ({
            run: async () => {
              cmReady.resolve();
              await cmRelease.promise;
              return { text: "", stopReason: "completed" };
            },
          }),
          "collapsed",
        );
        try {
          const cmRun = cm.db.createRun({ goal: "Real collapsed code_exec return_task", repoRoot, baseBranch: "main", baseSha });
          const cmParent = cm.db.createTask({
            runId: cmRun.id,
            tier: 1,
            kind: "orchestrator",
            title: "Orch",
            objective: "Coordinate",
            profileId: "pi:local",
            model: "fixture/fixture",
          });
          cm.db.updateTask(cmParent.id, { status: "running" });
          const cmChild = await cm.orch.spawnAndStartTask({
            runId: cmRun.id,
            parentId: cmParent.id,
            tier: 3,
            kind: "research",
            title: "Collapsed T3",
            objective: "Return via code_exec",
            readOnly: true,
            profileId: "pi:local",
            model: "fixture/fixture",
          });
          await cmReady.promise;
          const execRes = (await cm.orch.toolExecutor.execute(cmRun.id, cmChild.id, "code_exec", {
            code: `output(await tools.return_task({ status: "completed", summary: "Returned from sandbox", sources: [{ path: "README.md" }] }))`,
          })) as { error?: string; output?: { returned?: boolean; status?: string } };
          assert.equal(execRes.error, undefined);
          assert.equal(execRes.output?.returned, true);
          assert.equal(cm.db.getTask(cmChild.id)?.status, "completed");
          cmRelease.resolve();
          await waitUntil(() => cm.orch.activeTaskCount() === 0, 4000, "collapsed runner to settle");
        } finally {
          cmRelease.resolve();
          cm.orch.dispose();
          cm.db.close();
        }
      }
    } finally {
      t3Release.resolve();
      t2Release.resolve();
      t2StaleRelease.resolve();
      t2ScriptAbortRelease.resolve();
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pages through all runs beyond 200 during daemon restart orphan reconciliation", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g13-restart-paging-");
    const stateDir = join(root, "state");
    const { db, orch } = createTestOrchestrator(repoRoot, stateDir, () => ({
      run: async () => ({ text: "ok", stopReason: "completed" }),
    }));

    try {
      const totalRuns = 205;
      let oldestRunId = "";
      let newestRunId = "";
      let oldestT3Id = "";
      let oldestT1Id = "";
      let newestT3Id = "";
      let oldestArtifactPath = "";

      for (let i = 0; i < totalRuns; i++) {
        const run = db.createRun({ goal: `Run ${i + 1}`, repoRoot, baseBranch: "main", baseSha });
        // Force distinct timestamps on the oldest vs newest while leaving middle runs tied to also exercise cursor tie-breaking.
        if (i === 0) {
          oldestRunId = run.id;
          db.db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(1_000_000, run.id);
          const t1 = db.createTask({
            runId: run.id,
            tier: 1,
            kind: "orchestrator",
            title: "Oldest orphan T1",
            objective: "Coordinate",
            profileId: "pi:local",
            model: "fixture/fixture",
          });
          db.updateTask(t1.id, { status: "running" });
          oldestT1Id = t1.id;

          const t3 = db.createTask({
            runId: run.id,
            parentId: t1.id,
            tier: 3,
            kind: "research",
            title: "Oldest orphan T3",
            objective: "Old research",
            readOnly: true,
            profileId: "pi:local",
            model: "fixture/fixture",
          });
          db.updateTask(t3.id, { status: "running" });
          oldestT3Id = t3.id;
          const art = (await orch.toolExecutor.execute(run.id, t3.id, "artifact_write", {
            name: "old-orphan.md",
            content: "partial findings in run 1",
            summary: "Old orphan notes",
          })) as { path: string };
          oldestArtifactPath = art.path;
        } else if (i === totalRuns - 1) {
          newestRunId = run.id;
          db.db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(3_000_000, run.id);
          const t1 = db.createTask({
            runId: run.id,
            tier: 1,
            kind: "orchestrator",
            title: "Newest parent T1",
            objective: "Coordinate",
            profileId: "pi:local",
            model: "fixture/fixture",
          });
          db.updateTask(t1.id, { status: "running" });

          const t3 = db.createTask({
            runId: run.id,
            parentId: t1.id,
            tier: 3,
            kind: "research",
            title: "Newest orphan T3",
            objective: "New research",
            readOnly: true,
            profileId: "pi:local",
            model: "fixture/fixture",
          });
          db.updateTask(t3.id, { status: "running" });
          newestT3Id = t3.id;
        } else {
          db.db.prepare("UPDATE runs SET created_at = ? WHERE id = ?").run(2_000_000, run.id);
          db.updateRunStatus(run.id, "completed");
        }
      }

      // Mark orphan runs non-active because restart recovery relaunches tasks of active runs in place.
      db.updateRunStatus(oldestRunId, "failed");
      db.updateRunStatus(newestRunId, "failed");

      orch.reconcileStaleRunsOnStartup();

      const oldestT3 = db.getTask(oldestT3Id)!;
      const oldestT3Handoff = compactTaskHandoff(oldestT3) as { status: string; partial?: boolean; summary?: string; artifact_paths: string[] };
      assert.equal(oldestT3Handoff.status, "failed", "Oldest run beyond 200-run window must be reconciled");
      assert.equal(oldestT3Handoff.partial, true);
      assert.ok(oldestT3Handoff.summary?.includes("daemon_restart"));
      assert.ok(oldestT3Handoff.artifact_paths.includes(oldestArtifactPath));
      assert.equal(db.getRun(oldestRunId)?.status, "failed");

      const oldestT1Handoff = compactTaskHandoff(db.getTask(oldestT1Id)!) as { status: string; partial?: boolean };
      assert.equal(oldestT1Handoff.status, "failed");
      assert.equal(oldestT1Handoff.partial, undefined, "Tier 1 orphan must remain bare");

      const newestT3Handoff = compactTaskHandoff(db.getTask(newestT3Id)!) as { status: string; partial?: boolean; summary?: string };
      assert.equal(newestT3Handoff.status, "failed");
      assert.equal(newestT3Handoff.partial, true);
      assert.ok(newestT3Handoff.summary?.includes("daemon_restart"));
      assert.equal(db.getRun(newestRunId)?.status, "failed");
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settles post-rollover route/launch failure with partial fallback without early tool authorization (and keeps Tier 1 bare)", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g13-rollover-launch-");
    const stateDir = join(root, "state");

    let t3ArtifactPath = "";
    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        if (req.initialPrompt.includes("CASE_ROLLOVER_FAIL_T3")) {
          const art = (await req.executeTool("artifact_write", {
            name: "gen1-notes.md",
            content: "partial gen-1 research",
            summary: "Gen 1 notes",
          })) as { path: string };
          t3ArtifactPath = art.path;
          return { text: "gen 1 hit context threshold", stopReason: "rollover_requested" };
        }
        if (req.initialPrompt.includes("CASE_ROLLOVER_FAIL_T1")) {
          return { text: "t1 gen 1 hit context threshold", stopReason: "rollover_requested" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    });

    const { db, orch } = createTestOrchestrator(repoRoot, stateDir, runnerFactory, "off");

    try {
      const run = db.createRun({ goal: "Post-rollover launch failure", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      const t3RouteAttempts: number[] = [];
      let t3Gen2ToolAuthRejected = false;
      let t3Gen1ToolAuthRejected = false;
      let t3TaskId = "";

      const t1RouteAttempts: number[] = [];
      let t1TaskId = "";

      const origTaskRoute = (orch as unknown as { taskRoute: (task: { id: string; generation: number }, cwd: string) => Promise<unknown> }).taskRoute.bind(orch);
      (orch as unknown as { taskRoute: (task: { id: string; generation: number }, cwd: string) => Promise<unknown> }).taskRoute = async (task, cwd) => {
        if (task.id === t3TaskId) {
          t3RouteAttempts.push(task.generation);
          if (task.generation === 2) {
            // Tool authorization must remain closed for gen 2 during setup, and gen 1 must already be stale.
            try {
              orch.assertCurrentToolGeneration(task.id, 2);
            } catch {
              t3Gen2ToolAuthRejected = true;
            }
            try {
              orch.assertCurrentToolGeneration(task.id, 1);
            } catch {
              t3Gen1ToolAuthRejected = true;
            }
            throw new Error("simulated gen-2 routing failure");
          }
        }
        if (task.id === t1TaskId) {
          t1RouteAttempts.push(task.generation);
          if (task.generation === 2) {
            throw new Error("simulated tier-1 gen-2 routing failure");
          }
        }
        return origTaskRoute(task, cwd);
      };

      // 2b-i. Tier 3 task rolls over gen 1 -> gen 2, then gen-2 taskRoute throws once.
      const t3 = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Rollover launch fail T3",
        objective: "CASE_ROLLOVER_FAIL_T3",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      t3TaskId = t3.id;
      orch.launchTaskLoop(t3.id);

      await waitUntil(() => orch.activeTaskCount() === 0 && db.getTask(t3.id)?.status === "failed", 4000, "T3 gen-2 launch failure settlement");

      assert.deepEqual(t3RouteAttempts, [1, 2], "Gen-2 failure must settle once rather than drop and relaunch");
      assert.equal(t3Gen2ToolAuthRejected, true, "Gen-2 tools must not be authorized before runner setup");
      assert.equal(t3Gen1ToolAuthRejected, true, "Gen-1 tools must be rejected once task rolled over to gen-2");

      const t3Row = db.getTask(t3.id)!;
      assert.equal(t3Row.generation, 2);
      assert.equal(t3Row.status, "failed");
      const t3Handoff = compactTaskHandoff(t3Row) as { status: string; partial?: boolean; summary?: string; artifact_paths: string[] };
      assert.equal(t3Handoff.status, "failed");
      assert.equal(t3Handoff.partial, true);
      assert.ok(t3Handoff.summary?.includes("launch_failed"));
      assert.ok(t3Handoff.summary?.includes("simulated gen-2 routing failure"));
      assert.ok(t3Handoff.artifact_paths.includes(t3ArtifactPath));

      const t3Events = db.getEventsSince(run.id, 0, t3.id);
      assert.ok(t3Events.some((e) => e.type === "agent.error"), "Launch catch must emit agent.error");

      // 2b-ii. Tier 1 task post-rollover launch failure settles failed once and stays bare (no partial wrapper).
      const run2 = db.createRun({ goal: "Tier 1 post-rollover launch failure", repoRoot, baseBranch: "main", baseSha });
      const t1 = db.createTask({
        runId: run2.id,
        tier: 1,
        kind: "orchestrator",
        title: "Rollover launch fail T1",
        objective: "CASE_ROLLOVER_FAIL_T1",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      t1TaskId = t1.id;
      orch.launchTaskLoop(t1.id);

      await waitUntil(() => orch.activeTaskCount() === 0 && db.getTask(t1.id)?.status === "failed", 4000, "T1 gen-2 launch failure settlement");

      assert.deepEqual(t1RouteAttempts, [1, 2]);
      const t1Handoff = compactTaskHandoff(db.getTask(t1.id)!) as { status: string; partial?: boolean };
      assert.equal(t1Handoff.status, "failed");
      assert.equal(t1Handoff.partial, undefined, "Tier 1 launch failure must remain bare");
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
