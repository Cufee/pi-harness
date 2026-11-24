import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-g25-resolve-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

describe("goal-25 escalation resolution delivery through resolve path", () => {
  it("delivers resolutions via director.resolveEscalation and daemon escalation.resolve RPC, skips repeat and bulk resolves, and exposes answers in tree_view and hydration", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g25-state-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      let t1Id = "";
      let workerId = "";
      const t1ExecuteTool = Promise.withResolvers<(name: string, args: Record<string, unknown>) => Promise<unknown>>();
      const t1Steers: string[] = [];
      const workerSteers: string[] = [];
      const escalationsFiled = Promise.withResolvers<{ esc1: string; esc2: string }>();
      const probeHydrated = Promise.withResolvers<string>();
      const releaseAll = Promise.withResolvers<void>();

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.taskId.startsWith("chat-")) {
              return { text: "director ack", stopReason: "completed" };
            }
            if (req.tier === 1) {
              t1Id = req.taskId;
              t1ExecuteTool.resolve(req.executeTool);
              req.onHandle?.({
                steer: async (msg) => {
                  t1Steers.push(msg);
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              const spawned = (await req.executeTool("spawn_worker", {
                title: "Live non-blocking raiser",
                objective: "File non-blocking escalations and keep running",
                criteria: "Escalations filed",
                write_scopes: ["a.txt"],
                model: "fixture/fixture",
              })) as { spawned: string };
              workerId = spawned.spawned;
              await releaseAll.promise;
              return { text: "t1 done", stopReason: "completed" };
            }
            if (req.tier === 2) {
              workerId = req.taskId;
              req.onHandle?.({
                steer: async (msg) => {
                  workerSteers.push(msg);
                  return true;
                },
                cancel: async () => releaseAll.resolve(),
              });
              const r1 = (await req.executeTool("report_issue", {
                severity: "P0",
                category: "ambiguous_spec",
                title: "Need storage choice",
                evidence_paths: ["file.txt"],
                blocking: false,
              })) as { escalationId: string };
              const r2 = (await req.executeTool("report_issue", {
                severity: "P0",
                category: "ambiguous_spec",
                title: "Need logging format",
                evidence_paths: ["file.txt"],
                blocking: false,
              })) as { escalationId: string };
              escalationsFiled.resolve({ esc1: r1.escalationId, esc2: r2.escalationId });
              await releaseAll.promise;
              return { text: "worker done", stopReason: "completed" };
            }
            if (req.tier === 3) {
              probeHydrated.resolve(req.initialPrompt);
              return { text: "probe done", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();
      try {
        const chat = await client.request<{ session: { id: string } }>("chat.create", {
          repoRoot,
          title: "Goal 25 Resolution Chat",
        });

        const goal = daemon.director.goals.createGoal({
          repoRoot,
          chatSessionId: chat.session.id,
          title: "Goal 25 resolution delivery",
          description: "Verify resolveEscalation and escalation.resolve deliver to live tasks",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        await daemon.director.commitGoal(goal.id);

        const { esc1, esc2 } = await escalationsFiled.promise;
        const runId = daemon.director.goals.getGoal(goal.id)!.linkedRunId!;
        assert.equal(daemon.db.getTask(t1Id)?.status, "running");
        assert.equal(daemon.db.getTask(workerId)?.status, "running");

        // 1. Resolve esc1 through director.resolveEscalation (resolvedBy: "director").
        const dirRes = await daemon.director.resolveEscalation({
          escalationId: esc1,
          reason: "Use SQLite for state",
          chatSessionId: chat.session.id,
          repoRoot,
          resolvedBy: "director",
        });
        assert.equal(dirRes.alreadyResolved, false);
        assert.deepEqual(dirRes.deliveredTo, [t1Id, workerId]);
        assert.equal(t1Steers.length, 1);
        assert.equal(workerSteers.length, 1);
        assert.ok(t1Steers[0]!.includes(`[ESCALATION RESOLVED: ${esc1} by director]`), t1Steers[0]);
        assert.ok(t1Steers[0]!.includes("Use SQLite for state"), t1Steers[0]);
        assert.ok(workerSteers[0]!.includes(`[ESCALATION RESOLVED: ${esc1} by director]`), workerSteers[0]);
        assert.ok(workerSteers[0]!.includes("Use SQLite for state"), workerSteers[0]);

        const dirEvents = daemon.db
          .getEventsSince(runId, 0)
          .filter(
            (e) =>
              e.type === "escalation.updated" &&
              (e.payload as { id?: string; status?: string }).id === esc1 &&
              (e.payload as { status?: string }).status === "resolved",
          );
        assert.equal(dirEvents.length, 1);
        assert.equal((dirEvents[0]!.payload as { resolvedBy?: string }).resolvedBy, "director");

        const dirNotices = daemon.director.chats
          .getHistory(chat.session.id)
          .filter((t) => t.role === "system_notice" && t.content.includes(esc1) && t.content.includes("resolved by"));
        assert.equal(dirNotices.length, 1);
        assert.ok(dirNotices[0]!.content.includes("resolved by director"), dirNotices[0]!.content);
        assert.ok(dirNotices[0]!.content.includes("Use SQLite for state"), dirNotices[0]!.content);

        // Repeat resolve of esc1: alreadyResolved, empty deliveredTo, no new steer, no duplicate notice.
        const dirRepeat = await daemon.director.resolveEscalation({
          escalationId: esc1,
          reason: "Second answer ignored",
          chatSessionId: chat.session.id,
          repoRoot,
          resolvedBy: "director",
        });
        assert.equal(dirRepeat.alreadyResolved, true);
        assert.deepEqual(dirRepeat.deliveredTo, []);
        assert.equal(t1Steers.length, 1);
        assert.equal(workerSteers.length, 1);
        assert.equal(
          daemon.director.chats
            .getHistory(chat.session.id)
            .filter((t) => t.role === "system_notice" && t.content.includes(esc1) && t.content.includes("resolved by"))
            .length,
          1,
        );

        // 2. Resolve esc2 through the daemon escalation.resolve RPC (resolvedBy: "operator").
        const rpcRes = await client.request<{
          alreadyResolved: boolean;
          deliveredTo: string[];
          escalation: { id: string; status: string; resolution: string | null };
        }>("escalation.resolve", {
          escalationId: esc2,
          reason: "Keep JSONL logs",
          chatSessionId: chat.session.id,
        });
        assert.equal(rpcRes.alreadyResolved, false);
        assert.deepEqual(rpcRes.deliveredTo, [t1Id, workerId]);
        assert.equal(rpcRes.escalation.status, "resolved");
        assert.equal(rpcRes.escalation.resolution, "Keep JSONL logs");
        assert.equal(t1Steers.length, 2);
        assert.equal(workerSteers.length, 2);
        assert.ok(t1Steers[1]!.includes(`[ESCALATION RESOLVED: ${esc2} by operator]`), t1Steers[1]);
        assert.ok(t1Steers[1]!.includes("Keep JSONL logs"), t1Steers[1]);
        assert.ok(workerSteers[1]!.includes(`[ESCALATION RESOLVED: ${esc2} by operator]`), workerSteers[1]);
        assert.ok(workerSteers[1]!.includes("Keep JSONL logs"), workerSteers[1]);

        const rpcEvents = daemon.db
          .getEventsSince(runId, 0)
          .filter(
            (e) =>
              e.type === "escalation.updated" &&
              (e.payload as { id?: string; status?: string }).id === esc2 &&
              (e.payload as { status?: string }).status === "resolved",
          );
        assert.equal(rpcEvents.length, 1);
        assert.equal((rpcEvents[0]!.payload as { resolvedBy?: string }).resolvedBy, "operator");

        const rpcNotices = daemon.director.chats
          .getHistory(chat.session.id)
          .filter((t) => t.role === "system_notice" && t.content.includes(esc2) && t.content.includes("resolved by"));
        assert.equal(rpcNotices.length, 1);
        assert.ok(rpcNotices[0]!.content.includes("resolved by operator"), rpcNotices[0]!.content);
        assert.ok(rpcNotices[0]!.content.includes("Keep JSONL logs"), rpcNotices[0]!.content);

        // Repeat resolve of esc2 via RPC: alreadyResolved, empty deliveredTo, no new steer.
        const rpcRepeat = await client.request<{ alreadyResolved: boolean; deliveredTo: string[] }>(
          "escalation.resolve",
          {
            escalationId: esc2,
            reason: "Duplicate RPC answer",
            chatSessionId: chat.session.id,
          },
        );
        assert.equal(rpcRepeat.alreadyResolved, true);
        assert.deepEqual(rpcRepeat.deliveredTo, []);
        assert.equal(t1Steers.length, 2);
        assert.equal(workerSteers.length, 2);

        // 3. Bulk autoResolveGoalEscalations must not steer live tasks.
        daemon.db.createEscalation({
          runId,
          fromTaskId: workerId,
          toTaskId: null,
          severity: "P0",
          category: "ambiguous_spec",
          title: "Bulk auto-closed issue",
          evidencePaths: ["file.txt"],
          blocking: false,
        });
        const autoCount = daemon.director.autoResolveGoalEscalations(runId, "Auto-resolved on settle");
        assert.equal(autoCount, 1);
        assert.equal(t1Steers.length, 2);
        assert.equal(workerSteers.length, 2);

        // 4. tree_view shows the resolved escalations with their answers.
        const executeTool = await t1ExecuteTool.promise;
        const tree = (await executeTool("tree_view", {})) as {
          recentlyResolvedEscalations?: Array<{
            id: string;
            title: string;
            resolution: string | null;
          }>;
        };
        const resolvedList = tree.recentlyResolvedEscalations ?? [];
        const byId = new Map(resolvedList.map((e) => [e.id, e]));
        assert.equal(byId.get(esc1)?.resolution, "Use SQLite for state");
        assert.equal(byId.get(esc2)?.resolution, "Keep JSONL logs");

        // 5. Hydration prompt includes the resolved escalations with their answers.
        await daemon.orchestrator.toolExecutor.execute(runId, t1Id, "spawn_task", {
          kind: "research",
          title: "Hydration check",
          objective: "Inspect hydrated prompt",
          criteria: "Prompt captured",
          model: "fixture/fixture",
        });
        const hydratedPrompt = await probeHydrated.promise;
        assert.ok(
          hydratedPrompt.includes("## Recently resolved escalations (human or Director answers)"),
          hydratedPrompt,
        );
        assert.ok(hydratedPrompt.includes(esc1), hydratedPrompt);
        assert.ok(hydratedPrompt.includes("Use SQLite for state"), hydratedPrompt);
        assert.ok(hydratedPrompt.includes(esc2), hydratedPrompt);
        assert.ok(hydratedPrompt.includes("Keep JSONL logs"), hydratedPrompt);
      } finally {
        client.close();
        releaseAll.resolve();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("still completes resolveEscalation when delivery throws", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-g25-err-"));
    const sockPath = join(stateDir, "d.sock");
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });

      const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });
      await daemon.start();
      try {
        const chat = daemon.director.chats.createSession({ repoRoot, profileId: "fixture", title: "Delivery error test" });
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          chatSessionId: chat.id,
          title: "Delivery error resilience",
          description: "Delivery error must not fail resolve",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
        const run = daemon.db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);
        const task = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "T1",
          objective: "Run",
          profileId: "fixture",
          model: "fixture/fixture",
        });
        const esc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: task.id,
          toTaskId: null,
          severity: "P0",
          category: "ambiguous_spec",
          title: "Needs decision",
          evidencePaths: ["file.txt"],
          blocking: false,
        });

        daemon.orchestrator.deliverEscalationResolution = async () => {
          throw new Error("simulated delivery failure");
        };

        const res = await daemon.director.resolveEscalation({
          escalationId: esc.id,
          reason: "Proceed with default",
          resolvedBy: "operator",
        });
        assert.equal(res.alreadyResolved, false);
        assert.deepEqual(res.deliveredTo, []);
        assert.equal(daemon.db.getEscalation(esc.id)?.status, "resolved");
        assert.equal(daemon.db.getEscalation(esc.id)?.resolution, "Proceed with default");
        const notices = daemon.director.chats
          .getHistory(chat.id)
          .filter((t) => t.role === "system_notice" && t.content.includes(esc.id));
        assert.equal(notices.length, 1);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
