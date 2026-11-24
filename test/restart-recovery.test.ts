import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { RunAgentRequest, RunAgentResult } from "../src/runners/types.js";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-restart-"));
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
  cfg.worktree = { dir: ".harness/worktrees", archiveRetentionDays: 7, maxConcurrentWorkers: 4 };
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

describe("restart-recovery", () => {
  it("wait_timer and schedule_timer rows survive a stop", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfg = makeTestConfig(repoDir, stateDir);

    let waitTimerId = "";
    let schedTimerId = "";
    let waitingNow = false;

    const runnerA: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        const sched = (await req.executeTool("schedule_timer", {
          delay_seconds: 0.6,
          reason: "scheduled check",
        })) as { timer: { id: string } };
        schedTimerId = sched.timer.id;
        waitingNow = true;
        const waited = (await req.executeTool("wait_timer", {
          delay_seconds: 0.6,
          reason: "blocking wait",
        })) as { timerId: string; wakeReason: string };
        waitTimerId = waited.timerId;
        await waitForAbort(req.signal);
        return { text: "stopped", stopReason: "cancelled" };
      },
    });

    const a = new HarnessDaemon(cfg, { dbPath, customRunnerFactory: runnerA });
    await a.start();
    try {
      await a.orchestrator.startRun({
        goal: "Timer survival test",
        repoRoot: repoDir,
        profileId: "pi:local",
        model: "fixture",
      });
      await waitUntil(() => waitingNow && a.db.timers.list({ status: "pending" }).length === 2);
      const pendingBefore = a.db.timers.list({ status: "pending" });
      assert.equal(pendingBefore.length, 2);
      const wtRow = pendingBefore.find((t) => t.id !== schedTimerId)!;
      waitTimerId = wtRow.id;

      await a.stop();

      const b = new HarnessDaemon(makeTestConfig(repoDir, stateDir), {
        dbPath,
        customRunnerFactory: () => ({
          run: async (req) => {
            await waitForAbort(req.signal);
            return { text: "", stopReason: "cancelled" };
          },
        }),
      });
      // Before starting B (and firing timers), verify both rows survived A's stop as pending.
      assert.equal(b.db.timers.get(waitTimerId)?.status, "pending", "wait_timer row must stay pending after stop");
      assert.equal(b.db.timers.get(schedTimerId)?.status, "pending", "schedule_timer row must stay pending after stop");
      await b.start();
      await b.recovered;
      try {
        await waitUntil(
          () => b.db.timers.get(waitTimerId)?.status === "fired" && b.db.timers.get(schedTimerId)?.status === "fired",
          4000,
        );
      } finally {
        await b.stop();
      }
    } finally {
      await a.stop().catch(() => {});
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("interrupted Director turn keeps its tool list and does not respawn", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfgA = makeTestConfig(repoDir, stateDir);

    let spawnedTaskId = "";
    let turnAReadyToStop = false;

    const runnerA: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) {
          await waitForAbort(req.signal);
          return { text: "child interrupted", stopReason: "cancelled" };
        }
        req.callbacks.onTextDelta?.("Working on delegating the scout.");
        req.callbacks.onToolEvent?.({
          id: "tc-spawn-1",
          name: "spawn_task",
          status: "in_progress",
          args: '{"title":"Inspect config"}',
        });
        const spawned = (await req.executeTool("spawn_task", {
          kind: "research",
          title: "Inspect config",
          objective: "Check config files",
          profile_id: "pi:local",
          model: "fixture",
        })) as { task_id?: string; id?: string; spawned?: string };
        spawnedTaskId = String(spawned.task_id ?? spawned.spawned ?? spawned.id ?? "");
        req.callbacks.onToolEvent?.({
          id: "tc-spawn-1",
          name: "spawn_task",
          status: "completed",
          args: '{"title":"Inspect config"}',
        });
        turnAReadyToStop = true;
        await waitForAbort(req.signal);
        return { text: "Working on delegating the scout.", stopReason: "cancelled" };
      },
    });

    const a = new HarnessDaemon(cfgA, { dbPath, customRunnerFactory: runnerA });
    await a.start();
    const clientA = new DaemonClient(cfgA.socketPath);
    await clientA.connect();
    let chatId = "";
    try {
      const opened = await clientA.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Director Tool List Test",
      });
      chatId = opened.session.id;

      // Start the Director turn in the background and wait until spawn_task completes and it blocks.
      const sendPromise = clientA
        .request("chat.send", { chatSessionId: chatId, text: "Delegate a scout" })
        .catch(() => {});
      await waitUntil(() => turnAReadyToStop && spawnedTaskId.length > 0);

      await a.stop();
      await sendPromise;
    } finally {
      clientA.close();
      await a.stop().catch(() => {});
    }

    let continuationTurns = 0;
    let continuationPrompt = "";
    const runnerB: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) {
          await waitForAbort(req.signal);
          return { text: "child", stopReason: "cancelled" };
        }
        continuationTurns++;
        continuationPrompt = req.initialPrompt;
        if (!req.initialPrompt.includes("Tool calls of the interrupted turn")) {
          await req.executeTool("spawn_task", {
            kind: "research",
            title: "Duplicate scout",
            objective: "Should not run",
            profile_id: "pi:local",
            model: "fixture",
          });
        }
        req.callbacks.onTextDelta?.("Continuing without respawning.");
        return { text: "Continuing without respawning.", stopReason: "completed" };
      },
    });

    const cfgB = makeTestConfig(repoDir, stateDir);
    const b = new HarnessDaemon(cfgB, { dbPath, customRunnerFactory: runnerB });
    try {
      const historyBeforeB = b.director.chats.getHistory(chatId, 0, 50);
      const notice = historyBeforeB.find(
        (h) => h.role === "system_notice" && h.content.includes("daemon restarted while this turn was running"),
      );
      assert.ok(notice, "Expected system_notice turn after stop");
      assert.ok(notice.content.includes("spawn_task"), `Notice should mention spawn_task: ${notice.content}`);
      assert.ok(notice.content.includes(spawnedTaskId), `Notice should mention ${spawnedTaskId}: ${notice.content}`);

      await b.start();
      await b.recovered;
      await waitUntil(() => continuationTurns === 1 && !b.director.activeChatCount());

      assert.equal(continuationTurns, 1);
      assert.ok(continuationPrompt.includes("Tool calls of the interrupted turn"));
      assert.ok(continuationPrompt.includes("spawn_task"));
      assert.ok(continuationPrompt.includes(spawnedTaskId));

      const delegatedTasks = b.orchestrator
        .listDirectorTaskRuns(chatId)
        .flatMap((r) => b.db.listTasks(r.id))
        .filter((t) => t.profileId !== "director");
      assert.equal(delegatedTasks.length, 1, "Director container must have exactly one delegated task");
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("queued wakeups are saved at a plain stop and delivered once", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = join(repoDir, ".state");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const cfgA = makeTestConfig(repoDir, stateDir);

    let inFlight = false;
    const runnerA: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) {
          return { text: "ok", stopReason: "completed" };
        }
        inFlight = true;
        req.callbacks.onTextDelta?.("Handling first turn...");
        await waitForAbort(req.signal);
        return { text: "Handling first turn...", stopReason: "cancelled" };
      },
    });

    const a = new HarnessDaemon(cfgA, { dbPath, customRunnerFactory: runnerA });
    await a.start();
    const clientA = new DaemonClient(cfgA.socketPath);
    await clientA.connect();
    let chatId = "";
    try {
      const opened = await clientA.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Queued Wakeup Test",
      });
      chatId = opened.session.id;

      const sendPromise = clientA
        .request("chat.send", { chatSessionId: chatId, text: "Start long turn" })
        .catch(() => {});
      await waitUntil(() => inFlight);

      // Queue one timer.fired chat event behind the active Director turn.
      const wakeEvent = {
        kind: "timer.fired" as const,
        timerId: "timer-99",
        reason: "follow up on build",
        wakeReason: "timer_expired",
      };
      (a as unknown as { scheduleDirectorWakeup: (id: string, ev: unknown) => void }).scheduleDirectorWakeup(
        chatId,
        wakeEvent,
      );

      await a.stop();
      await sendPromise;
    } finally {
      clientA.close();
      await a.stop().catch(() => {});
    }

    const receivedPrompts: string[] = [];
    const runnerB: CustomRunnerFactory = () => ({
      run: async (req: RunAgentRequest): Promise<RunAgentResult> => {
        if (!req.taskId.startsWith("chat-")) return { text: "ok", stopReason: "completed" };
        receivedPrompts.push(req.initialPrompt);
        req.callbacks.onTextDelta?.(`handled #${receivedPrompts.length}`);
        return { text: `handled #${receivedPrompts.length}`, stopReason: "completed" };
      },
    });

    const cfgB = makeTestConfig(repoDir, stateDir);
    const b = new HarnessDaemon(cfgB, { dbPath, customRunnerFactory: runnerB });
    try {
      const pendingRows = b.db.db
        .prepare("SELECT chat_session_id, kind, payload_json FROM pending_wakeups ORDER BY id ASC")
        .all() as Array<{ chat_session_id: string; kind: string; payload_json: string | null }>;
      assert.equal(pendingRows.length, 2, "pending_wakeups must hold 1 continue + 1 event row");
      assert.equal(pendingRows[0]!.kind, "continue");
      assert.equal(pendingRows[1]!.kind, "event");

      await b.start();
      await b.recovered;
      await waitUntil(() => receivedPrompts.length === 2 && !b.director.activeChatCount());

      const remaining = b.db.db.prepare("SELECT COUNT(*) AS n FROM pending_wakeups").get() as { n: number };
      assert.equal(remaining.n, 0, "pending_wakeups must be empty after recovery");
      assert.ok(receivedPrompts[0]!.includes("Your previous turn was interrupted by a daemon restart"));
      assert.ok(receivedPrompts[1]!.includes("timer-99"), `Expected timer-99 wake turn, got: ${receivedPrompts[1]}`);
      // Give a brief tick to verify no duplicate delivery occurs.
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(receivedPrompts.length, 2);
    } finally {
      await b.stop();
      rmSync(repoDir, { recursive: true, force: true });
    }
  });
});
