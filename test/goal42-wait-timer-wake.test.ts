import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { DirectorRuntime } from "../src/director/runtime.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function initTempRepo(prefix: string): Promise<{ root: string; repoRoot: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, baseSha };
}

describe("goal-42: wait_timer wakes only via tool result (never steerTask)", () => {
  it("(b) wait_timer expiry and early wake resolve wait_timer without calling orchestrator.steerTask, while schedule_timer still steers", async () => {
    const { root, repoRoot, baseSha } = await initTempRepo("pi-g42-wait-timer-");
    const stateDir = join(root, "state");
    const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir });
    const db = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const orchestrator = new HarnessOrchestrator(db, config, catalog, quota);
    const director = new DirectorRuntime(db, config, catalog, quota, orchestrator);

    const steerCalls: Array<{ taskId: string; message: string }> = [];
    const origSteerTask = orchestrator.steerTask.bind(orchestrator);
    orchestrator.steerTask = async (taskId: string, message: string) => {
      steerCalls.push({ taskId, message });
      return true;
    };

    try {
      const run = db.createRun({
        goal: "Verify wait_timer wake isolation",
        repoRoot,
        baseBranch: "main",
        baseSha,
      });
      const task = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Tier 1 waiting on wait_timer",
        objective: "Sleep with wait_timer",
        profileId: "acp:amp",
        model: "anthropic/claude-opus-5-5",
      });
      db.updateTask(task.id, { status: "running" });

      // Case 1: wait_timer fires on normal expiry -> wakes via tool result ONLY, zero steerTask calls.
      const expiryPromise = orchestrator.toolExecutor.execute(run.id, task.id, "wait_timer", {
        delay_seconds: 0.05,
        reason: "lease backoff",
      }) as Promise<Record<string, unknown>>;

      const expiryRes = await expiryPromise;
      await Bun.sleep(30);

      assert.equal(expiryRes.status, "fired");
      assert.equal(expiryRes.wakeReason, "timer_expired");
      assert.equal(steerCalls.length, 0, "wait_timer expiry must NEVER call orchestrator.steerTask");

      // Case 2: wait_timer woken early via triggerEarly (child_settled) -> still zero steerTask calls.
      const earlyPromise = orchestrator.toolExecutor.execute(run.id, task.id, "wait_timer", {
        delay_seconds: 30,
        reason: "wait for child",
        wake_on_event: "child_settled",
      }) as Promise<Record<string, unknown>>;

      db.timers.triggerEarly((t) => t.ownerId === task.id && t.wakeOnEvent === "child_settled", "child_settled");
      const earlyRes = await earlyPromise;
      await Bun.sleep(30);

      assert.equal(earlyRes.status, "fired");
      assert.equal(earlyRes.wakeReason, "child_settled");
      assert.equal(steerCalls.length, 0, "wait_timer early wake must NEVER call orchestrator.steerTask");

      // Case 3: isTaskWaitingTimer / wakeTaskWaiters (Slice B hooks) track and unblock wait_timer without steering.
      const steeredWaitPromise = orchestrator.toolExecutor.execute(run.id, task.id, "wait_timer", {
        delay_seconds: 30,
        reason: "wait until steered",
      }) as Promise<Record<string, unknown>>;

      assert.equal(db.timers.isTaskWaitingTimer(task.id), true, "task should be tracked as waiting in wait_timer");
      const wokenCount = db.timers.wakeTaskWaiters(task.id, "steered");
      assert.equal(wokenCount, 1);
      const steeredWaitRes = await steeredWaitPromise;
      await Bun.sleep(30);

      assert.equal(steeredWaitRes.wakeReason, "steered");
      assert.equal(db.timers.isTaskWaitingTimer(task.id), false, "task should clear wait_timer tracking after wakeup");
      assert.equal(steerCalls.length, 0, "wakeTaskWaiters must not invoke onFireCallback / steerTask");

      // Case 4 (control): schedule_timer (no active wait_timer waiter) STILL delivers via orchestrator.steerTask.
      const scheduled = (await orchestrator.toolExecutor.execute(run.id, task.id, "schedule_timer", {
        delay_seconds: 0.05,
        reason: "scheduled reminder",
      })) as { timer: { id: string } };

      const deadline = Date.now() + 2000;
      while (steerCalls.length === 0 && Date.now() < deadline) {
        await Bun.sleep(15);
      }
      assert.equal(steerCalls.length, 1, "schedule_timer with no wait_timer waiter must still call steerTask");
      assert.equal(steerCalls[0]?.taskId, task.id);
      assert.ok(steerCalls[0]?.message.includes(scheduled.timer.id));
    } finally {
      orchestrator.steerTask = origSteerTask;
      director.dispose();
      orchestrator.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
