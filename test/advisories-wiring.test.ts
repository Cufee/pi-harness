import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import type { ToolDefinition } from "../src/runners/types.js";
import * as scopeNudgeMod from "../src/runners/scope-nudge.js";
import { toolsForRole } from "../src/tool-descriptions/registry.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const REPO_ROOT_DIR = resolve(import.meta.dir, "..");

async function makeTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; stateDir: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  const repoRoot = join(root, "repo");
  const stateDir = join(root, "state");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
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

async function waitUntil(pred: () => boolean, timeoutMs = 5_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "returned_for_rescope", "blocked"]);

describe("goal-14 slice B1: orchestrator advisory wiring", () => {
  it("T3-9: worker out-of-scope edit is not blocked, arrives as harness_advisory once, dedupes repeats, and consumes no steer/turn", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-adv-t39-");
    let runCalls = 0;
    let steerCalls = 0;
    let drainedSteers: string[] = ["sentinel"];
    let firstToolRes: { harness_advisory?: string[] } | undefined;
    let secondToolRes: { harness_advisory?: string[] } | undefined;
    let inScopeToolRes: { harness_advisory?: string[] } | undefined;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runCalls += 1;
        // Handle without turnOpen -> steer must never be called (Case 4).
        req.onHandle?.({
          steer: async () => {
            steerCalls += 1;
            return true;
          },
          cancel: async () => {},
        });

        // In-scope edit -> silent.
        req.callbacks.onToolEvent?.({
          id: "edit-in-scope",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "README.md" }),
        });
        inScopeToolRes = (await req.executeTool("artifact_write", {
          name: "in-scope.md",
          content: "notes",
          summary: "in-scope check",
        })) as { harness_advisory?: string[] };

        // Out-of-scope native edit -> queued, not blocked.
        req.callbacks.onToolEvent?.({
          id: "edit-out-1",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "src/x.ts" }),
        });
        firstToolRes = (await req.executeTool("artifact_write", {
          name: "after-edit-1.md",
          content: "notes 1",
          summary: "after edit 1",
        })) as { harness_advisory?: string[] };

        // Repeat out-of-scope edit on the exact same path -> deduped, no second notice.
        req.callbacks.onToolEvent?.({
          id: "edit-out-2",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "src/x.ts" }),
        });
        secondToolRes = (await req.executeTool("artifact_write", {
          name: "after-edit-2.md",
          content: "notes 2",
          summary: "after edit 2",
        })) as { harness_advisory?: string[] };

        drainedSteers = req.drainPendingSteers?.() ?? [];
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Worker finished",
          sources: [{ path: "README.md", note: "done" }],
        });
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const run = db.createRun({ goal: "T3-9 worker out-of-scope", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
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
        title: "Scoped worker",
        objective: "Edit README.md",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(worker.id)?.status ?? "") && orch.activeTaskCount() === 0, 5_000, "worker settled");

      assert.equal(runCalls, 1, "advisory must never open a second runner turn");
      assert.equal(steerCalls, 0, "handle without turnOpen must never be steered");
      assert.deepEqual(drainedSteers, [], "advisory must never enqueue into pendingSteers");
      assert.equal(inScopeToolRes?.harness_advisory, undefined, "in-scope edit must yield no notice");

      assert.ok(Array.isArray(firstToolRes?.harness_advisory) && firstToolRes.harness_advisory.length === 1);
      const noticeText = firstToolRes.harness_advisory[0]!;
      assert.match(noticeText, /^\[harness advisory: worker-edit-outside-scope\] .+ Why: .+ Instead: .+/);
      assert.ok(noticeText.includes("src/x.ts"));
      assert.equal(secondToolRes?.harness_advisory, undefined, "repeat edit of same path must not emit a second notice");

      const events = db.getEventsSince(run.id, 0, worker.id);
      const editEvents = events.filter(
        (e) => e.type === "agent.tool" && (e.payload as { id?: string } | null)?.id === "edit-out-1",
      );
      assert.equal(editEvents.length, 1);
      assert.equal((editEvents[0]!.payload as { status?: string }).status, "completed", "edit event status must remain completed");

      const advisories = events.filter((e) => e.type === "agent.advisory");
      assert.equal(advisories.length, 1);
      const payload = advisories[0]!.payload as { rule?: string; key?: string; delivery?: string; level?: string; text?: string };
      assert.equal(payload.rule, "worker-edit-outside-scope");
      assert.equal(payload.key, "src/x.ts");
      assert.equal(payload.level, "advisory");
      assert.equal(payload.delivery, "tool_result");
      assert.equal(payload.text, noticeText);

      assert.equal(events.some((e) => e.type === "agent.steered"), false, "no agent.steered event for an advisory");
      assert.equal(events.some((e) => e.type === "agent.scope_nudge"), false);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T3-9s: live steer delivers only when turnOpen is true before and after send, and requeues otherwise", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-adv-t39s-");

    type Mode = "open_ok" | "closed_before" | "flips_during_steer" | "steer_false_end";
    const modes: Mode[] = ["open_ok", "closed_before", "flips_during_steer", "steer_false_end"];
    const steersByTask = new Map<string, string[]>();
    const toolResByTask = new Map<string, { harness_advisory?: string[] }>();
    const runCallsByTask = new Map<string, number>();
    const drainedByTask = new Map<string, string[]>();

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runCallsByTask.set(req.taskId, (runCallsByTask.get(req.taskId) ?? 0) + 1);
        const mode = modes.find((m) => req.initialPrompt.includes(`MODE:${m}`))!;
        const received: string[] = [];
        steersByTask.set(req.taskId, received);

        let open = mode !== "closed_before";
        const steerSeen = Promise.withResolvers<void>();

        req.onHandle?.({
          turnOpen: () => open,
          steer: async (msg) => {
            received.push(msg);
            if (mode === "flips_during_steer") {
              open = false;
              steerSeen.resolve();
              return true;
            }
            if (mode === "steer_false_end") {
              steerSeen.resolve();
              return false;
            }
            steerSeen.resolve();
            return true;
          },
          cancel: async () => {},
        });

        req.callbacks.onToolEvent?.({
          id: `edit-${mode}`,
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "src/x.ts" }),
        });

        if (mode === "open_ok") {
          await steerSeen.promise;
          // Let steerLive complete delivered() while turnOpen is still true.
          await Bun.sleep(15);
          open = false;
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Done after live steer",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        if (mode === "closed_before") {
          await Bun.sleep(15);
          const res = (await req.executeTool("artifact_write", {
            name: "closed.md",
            content: "notes",
            summary: "closed",
          })) as { harness_advisory?: string[] };
          toolResByTask.set(req.taskId, res);
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Done after tool_result",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        if (mode === "flips_during_steer") {
          await steerSeen.promise;
          // Allow steerLive to observe stillOpen === false and requeue.
          await Bun.sleep(15);
          const res = (await req.executeTool("artifact_write", {
            name: "flipped.md",
            content: "notes",
            summary: "flipped",
          })) as { harness_advisory?: string[] };
          toolResByTask.set(req.taskId, res);
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Done after requeue",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        // steer_false_end: steer returns false and runner ends without calling another harness tool.
        await steerSeen.promise;
        drainedByTask.set(req.taskId, req.drainPendingSteers?.() ?? []);
        open = false;
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const run = db.createRun({ goal: "T3-9s live steer gating", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      const spawnWorker = async (mode: Mode) => {
        const task = await orch.spawnAndStartTask({
          runId: run.id,
          parentId: parent.id,
          tier: 2,
          kind: "worker",
          title: `Worker ${mode}`,
          objective: `MODE:${mode}`,
          readOnly: false,
          writeScopes: ["README.md"],
          profileId: "pi:local",
          model: "fixture/fixture",
        });
        await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? "") && orch.activeTaskCount() === 0, 5_000, mode);
        return task.id;
      };

      // Case 1: turnOpen true before and after steer returning true -> delivery: "steer".
      const t1 = await spawnWorker("open_ok");
      const e1 = db.getEventsSince(run.id, 0, t1);
      const a1 = e1.filter((e) => e.type === "agent.advisory");
      assert.equal(a1.length, 1);
      assert.equal((a1[0]!.payload as { delivery?: string }).delivery, "steer");
      assert.ok(steersByTask.get(t1)?.[0]?.startsWith("[harness advisory: worker-edit-outside-scope]"));
      assert.equal(e1.some((e) => e.type === "agent.steered"), false);
      assert.equal((e1.find((e) => e.type === "agent.tool")!.payload as { status?: string }).status, "completed");

      // Case 2: turnOpen false before send -> never steers, delivered on next tool result.
      const t2 = await spawnWorker("closed_before");
      const e2 = db.getEventsSince(run.id, 0, t2);
      const a2 = e2.filter((e) => e.type === "agent.advisory");
      assert.equal(steersByTask.get(t2)?.length, 0);
      assert.equal(a2.length, 1);
      assert.equal((a2[0]!.payload as { delivery?: string }).delivery, "tool_result");
      assert.ok(toolResByTask.get(t2)?.harness_advisory?.[0]?.startsWith("[harness advisory: worker-edit-outside-scope]"));
      assert.equal(e2.some((e) => e.type === "agent.steered"), false);

      // Case 3: turnOpen flips to false while steer is pending -> no steer delivery recorded, requeued onto tool_result.
      const t3 = await spawnWorker("flips_during_steer");
      const e3 = db.getEventsSince(run.id, 0, t3);
      const a3 = e3.filter((e) => e.type === "agent.advisory");
      assert.equal(a3.length, 1);
      assert.equal((a3[0]!.payload as { delivery?: string }).delivery, "tool_result");
      assert.equal(
        a3.some((e) => (e.payload as { delivery?: string }).delivery === "steer"),
        false,
        "must not record delivery steer when turnOpen flipped false",
      );
      assert.ok(toolResByTask.get(t3)?.harness_advisory?.[0]?.startsWith("[harness advisory: worker-edit-outside-scope]"));
      assert.equal(e3.some((e) => e.type === "agent.steered"), false);

      // Case 4: steer returns false and runner ends -> runner called once, completed, no pending steers, delivery dropped.
      const t4 = await spawnWorker("steer_false_end");
      const e4 = db.getEventsSince(run.id, 0, t4);
      const a4 = e4.filter((e) => e.type === "agent.advisory");
      assert.equal(runCallsByTask.get(t4), 1);
      assert.equal(db.getTask(t4)?.status, "completed");
      assert.deepEqual(drainedByTask.get(t4), []);
      assert.equal(e4.some((e) => e.type === "agent.steered"), false);
      assert.equal(a4.length, 1);
      assert.equal((a4[0]!.payload as { delivery?: string }).delivery, "dropped");
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T3-14: runner denial becomes a rejection notice, and a task ending with a queued notice drops it with no extra turn", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-adv-t314-");
    let denialToolRes: { harness_advisory?: string[] } | undefined;
    let dropRunCalls = 0;
    let dropDrained: string[] = ["sentinel"];

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        if (req.initialPrompt.includes("CASE_DENIED")) {
          req.callbacks.onToolEvent?.({
            id: "deny-1",
            name: "Bash",
            kind: "execute",
            status: "failed",
            args: JSON.stringify({ command: "rm -rf /tmp/foo" }),
            denied: "read-only-shell",
          });
          denialToolRes = (await req.executeTool("artifact_write", {
            name: "after-deny.md",
            content: "recorded",
            summary: "after denial",
          })) as { harness_advisory?: string[] };
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Finished after denial",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        // CASE_DROP: worker queues an advisory and ends without calling another harness tool.
        dropRunCalls += 1;
        req.callbacks.onToolEvent?.({
          id: "edit-drop",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "src/unowned.ts" }),
        });
        dropDrained = req.drainPendingSteers?.() ?? [];
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const run = db.createRun({ goal: "T3-14 denial and dropped", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      // Subcase A: runner denial -> rejection notice on tool_result.
      const scout = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Denied scout",
        objective: "CASE_DENIED",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(scout.id)?.status ?? "") && orch.activeTaskCount() === 0, 5_000, "scout");
      const scoutAdvisories = db.getEventsSince(run.id, 0, scout.id).filter((e) => e.type === "agent.advisory");
      assert.equal(scoutAdvisories.length, 1);
      const denyPayload = scoutAdvisories[0]!.payload as { level?: string; rule?: string; delivery?: string; text?: string };
      assert.equal(denyPayload.level, "rejection");
      assert.equal(denyPayload.rule, "read-only-shell");
      assert.equal(denyPayload.delivery, "tool_result");
      assert.match(denyPayload.text ?? "", /^\[harness blocked: read-only-shell\] .+ Why: .+ Allowed: .+/);
      assert.ok(denialToolRes?.harness_advisory?.[0]?.startsWith("[harness blocked: read-only-shell]"));

      // Subcase B: queued notice when task ends -> same stop outcome, no extra turn, delivery: "dropped".
      const worker = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Dropping worker",
        objective: "CASE_DROP",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(worker.id)?.status ?? "") && orch.activeTaskCount() === 0, 5_000, "worker");
      assert.equal(dropRunCalls, 1, "queued notice must not open an extra turn");
      assert.equal(db.getTask(worker.id)?.status, "completed");
      assert.deepEqual(dropDrained, []);
      const workerEvents = db.getEventsSince(run.id, 0, worker.id);
      assert.equal(workerEvents.some((e) => e.type === "agent.steered"), false);
      const workerAdvisories = workerEvents.filter((e) => e.type === "agent.advisory");
      assert.equal(workerAdvisories.length, 1);
      assert.equal((workerAdvisories[0]!.payload as { rule?: string }).rule, "worker-edit-outside-scope");
      assert.equal((workerAdvisories[0]!.payload as { delivery?: string }).delivery, "dropped");
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T6-1: one mechanism handles both scope-too-large and worker-edit-outside-scope without agent.scope_nudge or steerTaskDetailed", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-adv-t61-");
    const allHandleSteers: string[] = [];

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        let open = true;
        const steerSeen = Promise.withResolvers<void>();
        req.onHandle?.({
          turnOpen: () => open,
          steer: async (msg) => {
            allHandleSteers.push(msg);
            steerSeen.resolve();
            return true;
          },
          cancel: async () => {},
        });

        if (req.tier === 3) {
          // scope-too-large reports spinning only (reading widely is silent): the same read three times in a row.
          for (let i = 0; i < 3; i++) {
            req.callbacks.onToolEvent?.({
              id: `r-${i}`,
              name: "read",
              kind: "read",
              status: "completed",
              args: JSON.stringify({ path: "cloud/mod0/handler.go" }),
            });
          }
          await steerSeen.promise;
          await Bun.sleep(15);
          open = false;
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Scout done",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        req.callbacks.onToolEvent?.({
          id: "w-edit",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "src/outside.ts" }),
        });
        await steerSeen.promise;
        await Bun.sleep(15);
        open = false;
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Worker done",
          sources: [{ path: "README.md", note: "done" }],
        });
        return { text: "done", stopReason: "completed" };
      },
    }));

    let steerTaskDetailedCalls = 0;
    const origSteerDetailed = orch.steerTaskDetailed.bind(orch);
    orch.steerTaskDetailed = async (...args) => {
      steerTaskDetailedCalls += 1;
      return origSteerDetailed(...args);
    };

    try {
      const run = db.createRun({ goal: "T6-1 one mechanism", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      const scout = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Scout",
        objective: "Survey",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(scout.id)?.status ?? "") && orch.activeTaskCount() === 0, 5_000, "scout");

      const worker = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Edit",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(worker.id)?.status ?? "") && orch.activeTaskCount() === 0, 5_000, "worker");

      assert.equal(steerTaskDetailedCalls, 0, "steerTaskDetailed must never be called for advisories");
      assert.equal(allHandleSteers.length, 2);
      for (const msg of allHandleSteers) {
        assert.ok(
          msg.startsWith("[harness advisory:") || msg.startsWith("[harness blocked:"),
          `unexpected steer text: ${msg}`,
        );
      }

      const runEvents = db.getEventsSince(run.id, 0);
      assert.equal(runEvents.some((e) => e.type === "agent.scope_nudge"), false);
      assert.equal(runEvents.some((e) => e.type === "agent.steered"), false);

      const advisories = runEvents.filter((e) => e.type === "agent.advisory");
      assert.equal(advisories.length, 2);
      const rules = new Set(advisories.map((e) => (e.payload as { rule?: string }).rule));
      assert.deepEqual(rules, new Set(["scope-too-large", "worker-edit-outside-scope"]));
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T6-2: no second advisory producer in orchestrator.ts or src/runners/*.ts", () => {
    const runnersDir = join(REPO_ROOT_DIR, "src", "runners");
    const files = [
      join(REPO_ROOT_DIR, "src", "control-plane", "orchestrator.ts"),
      ...readdirSync(runnersDir)
        .filter((f) => f.endsWith(".ts"))
        .map((f) => join(runnersDir, f)),
    ];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      assert.equal(content.includes("agent.scope_nudge"), false, `${file} must not reference agent.scope_nudge`);
      assert.equal(content.includes("Harness scope check"), false, `${file} must not contain legacy Harness scope check text`);
      assert.equal(content.includes("[harness advisory"), false, `${file} must not contain raw [harness advisory literals`);
    }

    // scope-nudge.ts exports no function that returns a string; ScopeNudgeMonitor.observe returns void.
    const exportedKeys = Object.keys(scopeNudgeMod);
    assert.deepEqual(exportedKeys, ["ScopeNudgeMonitor"]);
    const monitor = new scopeNudgeMod.ScopeNudgeMonitor({ workspaceRoot: "/repo" });
    const ret = monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } });
    assert.equal(ret, undefined);
  });

  it("T4-1o: orchestrator launches each role with its registry tool definitions (names and descriptions)", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-adv-t41o-");
    const recordedTools = new Map<string, ToolDefinition[]>();

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        recordedTools.set(req.kind, req.tools);
        await req.executeTool("return_task", {
          status: "completed",
          summary: `${req.kind} finished`,
          sources: [{ path: "README.md", note: "checked" }],
        });
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const run = db.createRun({ goal: "T4-1o per-role tool descriptions", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      const specs = [
        { role: "research" as const, tier: 3 as const, kind: "research" as const, readOnly: true, writeScopes: undefined },
        { role: "verify" as const, tier: 3 as const, kind: "verify" as const, readOnly: true, writeScopes: undefined },
        { role: "plan" as const, tier: 3 as const, kind: "plan" as const, readOnly: true, writeScopes: undefined },
        { role: "worker" as const, tier: 2 as const, kind: "worker" as const, readOnly: false, writeScopes: ["README.md"] },
      ];

      for (const spec of specs) {
        const spawned = await orch.spawnAndStartTask({
          runId: run.id,
          parentId: parent.id,
          tier: spec.tier,
          kind: spec.kind,
          title: `Task ${spec.role}`,
          objective: `Run ${spec.role}`,
          readOnly: spec.readOnly,
          ...(spec.writeScopes ? { writeScopes: spec.writeScopes } : {}),
          profileId: "pi:local",
          model: "fixture/fixture",
        });
        await waitUntil(
          () => TERMINAL_STATUSES.has(db.getTask(spawned.id)?.status ?? "") && orch.activeTaskCount() === 0,
          5_000,
          `${spec.role} task`,
        );
      }

      for (const spec of specs) {
        const actual = recordedTools.get(spec.role);
        assert.ok(actual, `expected recorded req.tools for ${spec.role}`);
        const expected = toolsForRole(spec.role);
        assert.deepEqual(
          actual.map((t) => ({ name: t.name, description: t.description })),
          expected.map((t) => ({ name: t.name, description: t.description })),
          `${spec.role} req.tools names/descriptions must equal toolsForRole("${spec.role}")`,
        );
        assert.deepEqual(actual, expected, `${spec.role} req.tools must equal toolsForRole("${spec.role}")`);
      }

      const descOf = (role: string, toolName: string): string => {
        const found = recordedTools.get(role)?.find((t) => t.name === toolName);
        assert.ok(found, `expected ${toolName} in ${role} tools`);
        return found.description;
      };

      const workerReportIssue = descOf("worker", "report_issue");
      const workerReturnTask = descOf("worker", "return_task");
      for (const roRole of ["research", "verify"] as const) {
        assert.notEqual(
          descOf(roRole, "report_issue"),
          workerReportIssue,
          `${roRole} report_issue description must differ from worker`,
        );
        assert.notEqual(
          descOf(roRole, "return_task"),
          workerReturnTask,
          `${roRole} return_task description must differ from worker`,
        );

        const directorOnlyTools = ["goal_create", "goal_commit", "present_result"];
        for (const tool of recordedTools.get(roRole)!) {
          for (const dirTool of directorOnlyTools) {
            assert.equal(
              tool.description.includes(dirTool),
              false,
              `${roRole} tool ${tool.name} description must not mention Director tool ${dirTool}`,
            );
          }
        }
      }
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
