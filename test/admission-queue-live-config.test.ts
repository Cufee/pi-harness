import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe("Unified Goal & Worker Admission Queue + Live Config Reload", () => {
  it("queues workers on maxConcurrentWorkers instead of failing, honors reordering, and unblocks instantly on config.update & disk config.json edits", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-queue-workers-"));
    const repoRoot = join(root, "repo");
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");

    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# test\n", "utf8");
    await runGit(repoRoot, ["add", "-A"]);
    await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);

    const startedWorkers: string[] = [];
    const resolvers = new Map<string, () => void>();
    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        if (req.tier === 2) {
          startedWorkers.push(req.taskId);
          await new Promise<void>((resolve) => {
            resolvers.set(req.taskId, resolve);
            req.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } else {
          // Keep Tier 1 alive until aborted
          await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
        }
        return { text: "done", stopReason: "completed" };
      },
    });

    const baseCfg = loadConfig(repoRoot);
    const cfg = withFixtureCatalog({
      ...baseCfg,
      profiles: baseCfg.profiles.map((p) => (p.id === "acp:codex" ? { ...p, enabled: true } : p)),
      codeMode: "off",
      stateDir,
      socketPath: sockPath,
      worktree: { ...baseCfg.worktree, maxConcurrentWorkers: 1 },
    });
    const daemon = new HarnessDaemon(cfg, { dbPath: join(stateDir, "db.sqlite"), customRunnerFactory: runnerFactory });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      const { run, orchestratorTask: rootTask } = await daemon.orchestrator.startRun({
        goal: "Test worker queue",
        repoRoot,
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      // Spawn 3 workers while maxConcurrentWorkers = 1:
      // w1 starts immediately; w2 and w3 MUST enter the queue cleanly (NEVER fail or throw!).
      const w1 = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: rootTask.id,
        tier: 2,
        kind: "worker",
        title: "Worker 1",
        objective: "Work 1",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
        writeScopes: ["a/**"],
      });
      const w2 = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: rootTask.id,
        tier: 2,
        kind: "worker",
        title: "Worker 2",
        objective: "Work 2",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
        writeScopes: ["b/**"],
      });
      const w3 = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: rootTask.id,
        tier: 2,
        kind: "worker",
        title: "Worker 3",
        objective: "Work 3",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
        writeScopes: ["c/**"],
      });

      await waitFor(() => startedWorkers.includes(w1.id));
      assert.equal(daemon.db.getTask(w2.id)?.status, "ready", "w2 must remain queued (ready), never failed");
      assert.equal(daemon.db.getTask(w3.id)?.status, "ready", "w3 must remain queued (ready), never failed");
      const qBefore = daemon.db.admissionQueue.list({ lane: "worker", repoRoot });
      assert.deepEqual(
        qBefore.map((e) => [e.targetId, e.position]),
        [
          [w2.id, 1],
          [w3.id, 2],
        ],
      );

      // Reorder w3 to front via unified queue_reorder tool!
      const reordered = (await daemon.orchestrator.toolExecutor.execute(run.id, rootTask.id, "queue_reorder", {
        lane: "worker",
        target_id: w3.id,
        position: "front",
      })) as { queue: Array<{ targetId: string; position: number }> };
      assert.deepEqual(
        reordered.queue.map((e) => e.targetId),
        [w3.id, w2.id],
      );

      // Live config update via RPC (`maxConcurrentWorkers: 1 -> 2`): w3 MUST unblock immediately (not w2)!
      await client.request("config.update", {
        patch: { worktree: { ...cfg.worktree, maxConcurrentWorkers: 2 } },
      });
      await waitFor(() => startedWorkers.includes(w3.id));
      assert.equal(startedWorkers.includes(w2.id), false, "w2 must remain queued at #1 while limit is 2");

      // Live config reload via editing `<stateDir>/config.json` directly on disk (`maxConcurrentWorkers: 2 -> 3`)!
      writeFileSync(
        join(stateDir, "config.json"),
        JSON.stringify({ ...daemon.config, worktree: { ...daemon.config.worktree, maxConcurrentWorkers: 3 } }, null, 2),
        "utf8",
      );
      await waitFor(() => startedWorkers.includes(w2.id), 4_000);
      assert.equal(daemon.db.admissionQueue.list({ lane: "worker", repoRoot }).length, 0);
    } finally {
      for (const r of resolvers.values()) r();
      client.close();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces separate maxConcurrentGoals with insert-at-position, reordering, live reload drain, and emergency queue_force_start (including quota bypass)", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-queue-goals-"));
    const repoRoot = join(root, "repo");
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");

    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# test\n", "utf8");
    await runGit(repoRoot, ["add", "-A"]);
    await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        await new Promise<void>((resolve) => req.signal.addEventListener("abort", () => resolve(), { once: true }));
        return { text: "done", stopReason: "completed" };
      },
    });

    const baseCfg = loadConfig(repoRoot);
    const cfg = withFixtureCatalog({
      ...baseCfg,
      profiles: baseCfg.profiles.map((p) => (p.id === "acp:codex" ? { ...p, enabled: true } : p)),
      codeMode: "off",
      stateDir,
      socketPath: sockPath,
      goals: { ...baseCfg.goals, maxConcurrentGoals: 1 },
      worktree: { ...baseCfg.worktree, maxConcurrentWorkers: 4 },
    });
    const daemon = new HarnessDaemon(cfg, { dbPath: join(stateDir, "db.sqlite"), customRunnerFactory: runnerFactory });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      const chat = await daemon.director.openDefaultChat({ repoRoot });
      const g1 = daemon.director.goals.createGoal({ chatSessionId: chat.id, repoRoot, title: "Goal 1", description: "First", criteria: [], verificationMode: "none" });
      const g2 = daemon.director.goals.createGoal({ chatSessionId: chat.id, repoRoot, title: "Goal 2", description: "Second", criteria: [], verificationMode: "none" });
      const g3 = daemon.director.goals.createGoal({ chatSessionId: chat.id, repoRoot, title: "Goal 3", description: "Third", criteria: [], verificationMode: "none" });

      // Commit g1 -> starts immediately; g2 -> queued #1; g3 with position="front" -> jumps ahead of g2!
      const c1 = await daemon.director.commitGoal(g1.id, { profileId: "pi:local", model: "fixture/fixture" });
      assert.equal(c1.status, "executing");

      const c2 = await daemon.director.commitGoal(g2.id, { profileId: "pi:local", model: "fixture/fixture" });
      assert.equal(c2.status, "draft");
      assert.equal(daemon.db.admissionQueue.get("goal", g2.id)?.position, 1);

      const c3 = await daemon.director.commitGoal(g3.id, {
        profileId: "pi:local",
        model: "fixture/fixture",
        position: "front",
      });
      assert.equal(c3.status, "draft");
      assert.deepEqual(
        daemon.db.admissionQueue.list({ lane: "goal", repoRoot }).map((e) => e.targetId),
        [g3.id, g2.id],
      );

      // Reorder g2 back ahead of g3
      daemon.db.admissionQueue.reorder("goal", g2.id, 1);
      assert.deepEqual(
        daemon.db.admissionQueue.list({ lane: "goal", repoRoot }).map((e) => e.targetId),
        [g2.id, g3.id],
      );

      // Live-increase maxConcurrentGoals from 1 -> 2: g2 immediately auto-starts, g3 stays queued!
      await client.request("config.update", {
        patch: { goals: { ...cfg.goals, maxConcurrentGoals: 2 } },
      });
      await waitFor(() => daemon.director.goals.getGoal(g2.id)?.status === "executing");
      assert.equal(daemon.director.goals.getGoal(g3.id)?.status, "draft");

      // Force-start g3 despite 2/2 active goals -> bypasses limit with explicit warning!
      const forced = await daemon.director.forceStartQueuedItem({
        lane: "goal",
        targetId: g3.id,
        reason: "Urgent hotfix",
      });
      assert.equal(forced.action, "force_started_queued_goal");
      assert.ok(String(forced.warning).includes("use sparingly"));
      assert.equal(daemon.director.goals.getGoal(g3.id)?.status, "executing");

      // Quota-paused task force-start: rejected without bypassQuota, succeeds with bypassQuota: true
      const runId = daemon.director.goals.getGoal(g1.id)!.linkedRunId!;
      const orchTask = daemon.db.listTasks(runId)[0]!;
      const pausedTask = daemon.db.createTask({
        runId,
        parentId: orchTask.id,
        tier: 3,
        kind: "research",
        title: "Paused scout",
        objective: "Scout",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(pausedTask.id, { status: "paused_quota", summary: "Quota exhausted" });

      await assert.rejects(
        () => daemon.director.forceStartQueuedItem({ lane: "worker", targetId: pausedTask.id, bypassQuota: false }),
        /bypass_quota: true/i,
      );
      const forcedQuota = await daemon.director.forceStartQueuedItem({
        lane: "worker",
        targetId: pausedTask.id,
        bypassQuota: true,
        reason: "Critical outage check",
      });
      assert.equal(forcedQuota.action, "force_resumed_from_quota");
    } finally {
      client.close();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
