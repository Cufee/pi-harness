import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { RunAgentRequest, RunAgentResult } from "../src/runners/types.js";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-restart-rollover-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeTestConfig(repoDir: string, stateDir: string) {
  mkdirSync(stateDir, { recursive: true });
  const cfg = loadConfig(repoDir);
  cfg.stateDir = stateDir;
  cfg.socketPath = join(stateDir, "d.sock");
  cfg.quotaEndpoint = undefined;
  cfg.catalog = { ttlHours: 24 };
  cfg.worktree = { archiveRetentionDays: 7, maxConcurrentWorkers: 4 };
  cfg.codeMode = "off";
  cfg.profiles = [
    { id: "pi:local", kind: "pi", provider: "fixture", billing: "local", models: ["fixture"] },
  ];
  cfg.defaultOrchestratorProfile = "pi:local";
  cfg.defaultWorkerProfile = "pi:local";
  cfg.defaultTaskProfile = "pi:local";
  const compiler = new ModelCatalogCompiler(cfg);
  const catalog = compiler.compileFromData({
    enabledProfiles: cfg.profiles,
    inventory: new Map([["pi:local", [{ wireModelId: "fixture" }]]]),
    profileStatuses: [{ profileId: "pi:local", status: "ok", modelCount: 1 }],
    modelsDev: [],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [],
    sources: [],
  });
  writeFileSync(compiler.cachePath, JSON.stringify(catalog));
  return cfg;
}

async function waitUntil(pred: () => boolean, timeoutMs = 5000, stepMs = 20): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("restart-rollover-guard", () => {
  it("skips the no-progress guard on restart rollovers during quiesce and preserves streak state", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfg = makeTestConfig(repoDir, stateDir);

    let workerId = "";
    let workerRuns = 0;
    let gen3Running = false;
    let restartRolloverScheduled = false;
    let releaseGen3!: () => void;
    const gen3Gate = new Promise<void>((resolve) => {
      releaseGen3 = resolve;
    });

    const runner: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (req.tier === 1) {
          const w = (await req.executeTool("spawn_worker", {
            title: "Stalled-streak worker",
            objective: "Reach streak 2 then obey restart rollover",
            write_scopes: ["src/**"],
            profile_id: "pi:local",
            model: "fixture",
          })) as { spawned: string };
          workerId = w.spawned;
          await req.executeTool("wait_children", { ids: [workerId], mode: "all", fallback_interval_s: 60 });
          await waitForAbort(req.signal);
          return { text: "interrupted", stopReason: "cancelled" };
        }

        if (req.taskId === workerId) {
          workerRuns += 1;
          if (workerRuns <= 2) {
            await req.executeTool("request_rollover", {
              goal_invariants: ["preserve state"],
              architectural_decisions: [],
              active_risks: [],
              next_actions: [`normal rollover ${workerRuns}`],
            });
            return { text: `rollover ${workerRuns}`, stopReason: "rollover_requested" };
          }
          gen3Running = true;
          await Promise.race([gen3Gate, waitForAbort(req.signal)]);
          if (req.signal.aborted) {
            return { text: "aborted", stopReason: "cancelled" };
          }
          await req.executeTool("request_rollover", {
            goal_invariants: ["preserve state"],
            architectural_decisions: [],
            active_risks: [],
            next_actions: ["Resume after daemon restart"],
          });
          restartRolloverScheduled = true;
          return { text: "restart rollover", stopReason: "rollover_requested" };
        }

        await waitForAbort(req.signal);
        return { text: "interrupted", stopReason: "cancelled" };
      },
    });

    const daemon = new HarnessDaemon(cfg, { dbPath, customRunnerFactory: runner });
    await daemon.start();

    const orchInternals = daemon.orchestrator as unknown as {
      active: Map<string, unknown>;
      recoveringTasks: Set<string>;
      taskRolloverProgress: Map<string, { fp: string; streak: number; artHigh: number; routes: string[] }>;
    };

    try {
      const started = await daemon.orchestrator.startRun({
        goal: "Restart rollover bypasses no-progress guard",
        repoRoot: repoDir,
        profileId: "pi:local",
        model: "fixture",
      });
      const runId = started.run.id;

      await waitUntil(
        () =>
          Boolean(workerId) &&
          gen3Running &&
          daemon.db.getTask(workerId)?.generation === 3 &&
          daemon.db.getTask(workerId)?.status === "running",
      );

      const beforeProgress = orchInternals.taskRolloverProgress.get(workerId);
      assert.ok(beforeProgress, "Expected no-progress state to exist after two rollovers");
      assert.equal(beforeProgress.streak, 2, "Expected streak at the last allowed value before guard trip");
      const beforeSnapshot = {
        fp: beforeProgress.fp,
        streak: beforeProgress.streak,
        artHigh: beforeProgress.artHigh,
        routes: [...beforeProgress.routes],
      };

      daemon.enterQuiesce("draining");
      releaseGen3();

      await waitUntil(() => restartRolloverScheduled && !orchInternals.active.has(workerId));

      const afterTask = daemon.db.getTask(workerId);
      assert.ok(afterTask, "Expected worker task record to exist");
      assert.notEqual(afterTask.status, "failed", "Restart rollover must not fail the task");
      assert.equal(afterTask.status, "ready", "Restart rollover must leave task ready for relaunch");
      assert.equal(afterTask.generation, 3, "Restart rollover must keep generation unchanged");
      assert.equal(orchInternals.recoveringTasks.has(workerId), true, "Task must be held for relaunch during quiesce");
      assert.equal(orchInternals.active.has(workerId), false, "Task must not remain active after restart rollover");
      assert.equal(workerRuns, 3, "Task must not relaunch while quiescing");
      assert.deepEqual(
        orchInternals.taskRolloverProgress.get(workerId),
        beforeSnapshot,
        "Restart rollover must neither increment nor reset no-progress streak state",
      );

      const handoff = JSON.parse(afterTask.handoffJson ?? "{}") as { nextActions?: string[] };
      assert.ok(
        handoff.nextActions?.includes("Resume after daemon restart"),
        "Restart rollover handoff should be persisted",
      );

      const workerEscalations = daemon.db.listEscalations(runId).filter((e) => e.fromTaskId === workerId);
      assert.equal(workerEscalations.length, 0, "Restart rollover must not emit a budget_exhausted escalation");
    } finally {
      releaseGen3();
      await daemon.stop().catch(() => {});
      rmSync(repoDir, { recursive: true, force: true });
    }
  }, 15_000);
});
