import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { GoalCriterion } from "../src/goals/engine.js";
import type { ChatControlEvent } from "../src/protocol/chat-events.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-int-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "init\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

describe("goal-20 integration: DirectorRuntime gate-activity events and compact goal_get", () => {
  it("emits goal.gate_activity for Tier 2 worker spawn and remote push while awaiting_human, dedupes re-emits, and ignores Tier 3 spawns", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-state-"));
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: true },
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: join(stateDir, "d.sock"),
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async () => ({ text: "ok", stopReason: "completed" }),
        }),
      });
      await daemon.start();
      const wakes: Array<{ chatSessionId: string; event: ChatControlEvent }> = [];
      daemon.director.setWakeHandler((chatSessionId, event) => {
        wakes.push({ chatSessionId, event });
      });

      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Gate activity visibility",
          description: "Detect orchestrator spawns and remote pushes during human gate",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const run = daemon.db.createRun({
          repoRoot,
          baseBranch: "main",
          baseSha: (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout,
          goal: goal.title,
        });
        const t1 = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orchestrator",
          objective: "Coordinate",
          profileId: "fixture",
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);
        daemon.director.goals.setStatus(goal.id, "awaiting_human");

        // Tier 2 worker spawn while awaiting_human -> exactly one worker_spawned event.
        const worker = daemon.db.createTask({
          runId: run.id,
          parentId: t1.id,
          tier: 2,
          kind: "worker",
          title: "Implement extra patch",
          objective: "Edit files",
          profileId: "fixture",
          writeScopes: ["src/**"],
        });

        const gateEvents = () =>
          wakes.map((w) => w.event).filter((e): e is Extract<ChatControlEvent, { kind: "goal.gate_activity" }> => e.kind === "goal.gate_activity");

        assert.equal(gateEvents().length, 1);
        assert.equal(wakes[0]!.chatSessionId, chat.id);
        assert.deepEqual(gateEvents()[0], {
          kind: "goal.gate_activity",
          goalId: goal.id,
          goalVersion: goal.version,
          goalTitle: goal.title,
          runId: run.id,
          gate: "awaiting_human",
          escalationIds: [],
          openBlockingEscalations: 0,
          activity: "worker_spawned",
          taskId: worker.id,
          taskTier: 2,
          title: "Implement extra patch",
        });

        // Push command split across in_progress (args) and completed (result) -> one confirmed remote_push event.
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c1",
          name: "Bash",
          status: "in_progress",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin main" }),
        });
        assert.equal(gateEvents().length, 1, "in_progress alone must not emit remote_push");

        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c1",
          name: "Bash",
          status: "completed",
          title: "Bash",
          result: "To origin\n   abc1234..def5678  main -> main",
        });
        assert.equal(gateEvents().length, 2);
        assert.deepEqual(gateEvents()[1], {
          kind: "goal.gate_activity",
          goalId: goal.id,
          goalVersion: goal.version,
          goalTitle: goal.title,
          runId: run.id,
          gate: "awaiting_human",
          escalationIds: [],
          openBlockingEscalations: 0,
          activity: "remote_push",
          taskId: worker.id,
          taskTier: 2,
          command: "git push origin main",
          remote: "origin",
          refs: ["abc1234..def5678 main -> main"],
          confirmed: true,
          toolCallId: "c1",
        });

        // Re-emitting completed (both without and with args) yields no duplicate event.
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c1",
          name: "Bash",
          status: "completed",
          title: "Bash",
          result: "To origin\n   abc1234..def5678  main -> main",
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c1",
          name: "Bash",
          status: "completed",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin main" }),
          result: "To origin\n   abc1234..def5678  main -> main",
        });
        assert.equal(gateEvents().length, 2);

        // Tier 3 read-only spawn_task produces no event.
        daemon.db.createTask({
          runId: run.id,
          parentId: t1.id,
          tier: 3,
          kind: "research",
          title: "Read-only scout",
          objective: "Inspect codebase",
          readOnly: true,
          profileId: "fixture",
        });
        assert.equal(gateEvents().length, 2);

        // Failed push drops cache so a later completed event without args does not spuriously fire.
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c2",
          name: "Bash",
          status: "in_progress",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin feat" }),
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c2",
          name: "Bash",
          status: "failed",
          title: "Bash",
          error: "network error",
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c2",
          name: "Bash",
          status: "completed",
          title: "Bash",
          result: "To origin\n   1111111..2222222  feat -> feat",
        });
        assert.equal(gateEvents().length, 2);

        // Non-shell file write mentioning "git push" and shell echo mentioning "git push" produce NO events (P2-c).
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "w1",
          name: "Write",
          kind: "edit",
          status: "in_progress",
          title: "Write README.md",
          args: JSON.stringify({ path: "README.md", content: "To publish, run git push origin main" }),
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "w1",
          name: "Write",
          kind: "edit",
          status: "completed",
          title: "Write README.md",
          result: "ok",
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "e1",
          name: "Bash",
          kind: "execute",
          status: "completed",
          title: "Bash",
          args: JSON.stringify({ command: 'echo "To publish, run git push origin main"' }),
          result: "To publish, run git push origin main",
        });
        assert.equal(gateEvents().length, 2, "non-shell writes and echoed push text must not emit remote_push");

        // Partially rejected multi-ref push (status: failed, but one ref updated in error text) DOES emit confirmed remote_push (P2-d).
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c3",
          name: "Bash",
          kind: "execute",
          status: "in_progress",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin feat main" }),
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c3",
          name: "Bash",
          kind: "execute",
          status: "failed",
          title: "Bash",
          error:
            "To origin\n   aaa1111..bbb2222  feat -> feat\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
        });
        assert.equal(gateEvents().length, 3);
        const partialEv = gateEvents()[2]!;
        assert.equal(partialEv.activity, "remote_push");
        assert.equal(partialEv.confirmed, true);
        assert.deepEqual(partialEv.refs, ["aaa1111..bbb2222 feat -> feat"]);
        assert.equal(partialEv.toolCallId, "c3");

        // Fully rejected push (status: failed, no updated refs) produces NO event (P2-d).
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c4",
          name: "Bash",
          kind: "execute",
          status: "failed",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin main" }),
          error: "To origin\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
        });
        assert.equal(gateEvents().length, 3);

        // Push followed by a failing command (status: failed, ref update confirmed in error text) DOES emit remote_push (P2-d).
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c5",
          name: "Bash",
          kind: "execute",
          status: "failed",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin feat2 && false" }),
          error: "To origin\n   ccc1111..ddd2222  feat2 -> feat2\nexit status 1",
        });
        assert.equal(gateEvents().length, 4);
        assert.equal(gateEvents()[3]!.confirmed, true);
        assert.deepEqual(gateEvents()[3]!.refs, ["ccc1111..ddd2222 feat2 -> feat2"]);
        assert.equal(gateEvents()[3]!.toolCallId, "c5");

        // When wakes are disabled, gate activity is still recorded as a system_notice turn.
        daemon.director.updateConfig({
          ...config,
          events: { ...config.events, wakeDirectorOnGoalSettle: false },
        });
        const worker2 = daemon.db.createTask({
          runId: run.id,
          parentId: t1.id,
          tier: 2,
          kind: "worker",
          title: "Fallback notice worker",
          objective: "Edit files",
          profileId: "fixture",
        });
        assert.equal(gateEvents().length, 4, "must not call wakeHandler when wakeDirectorOnGoalSettle is false");
        const notices = daemon.director.chats
          .getHistory(chat.id)
          .filter((t) => t.role === "system_notice" && t.event?.kind === "goal.gate_activity");
        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.event?.kind === "goal.gate_activity" && notices[0]!.event.taskId, worker2.id);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("stays silent while goal is active, then emits blocking_escalation once a P0 human escalation opens", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-active-"));
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        events: { ...baseCfg.events, wakeDirectorOnGoalSettle: true },
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: join(stateDir, "d.sock"),
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async () => ({ text: "ok", stopReason: "completed" }),
        }),
      });
      await daemon.start();
      const wakes: ChatControlEvent[] = [];
      daemon.director.setWakeHandler((_chatSessionId, event) => {
        wakes.push(event);
      });

      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Active then escalated",
          description: "No noise when executing normally",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const run = daemon.db.createRun({
          repoRoot,
          baseBranch: "main",
          baseSha: (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout,
          goal: goal.title,
        });
        const t1 = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orchestrator",
          objective: "Coordinate",
          profileId: "fixture",
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const gateEvents = () =>
          wakes.filter((e): e is Extract<ChatControlEvent, { kind: "goal.gate_activity" }> => e.kind === "goal.gate_activity");

        // Goal is executing with no human-routed blocking escalations: worker spawn + push are silent.
        const worker = daemon.db.createTask({
          runId: run.id,
          parentId: t1.id,
          tier: 2,
          kind: "worker",
          title: "Normal worker",
          objective: "Build",
          profileId: "fixture",
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "p1",
          name: "Bash",
          status: "in_progress",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin feat-1" }),
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "p1",
          name: "Bash",
          status: "completed",
          title: "Bash",
          result: "To origin\n   1111111..2222222  feat-1 -> feat-1",
        });
        assert.equal(gateEvents().length, 0);

        // Open a P0 blocking escalation routed to human (toTaskId: null), then push -> blocking_escalation event.
        const esc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: t1.id,
          toTaskId: null,
          severity: "P0",
          category: "ambiguous_spec",
          title: "Confirm deployment target",
          evidencePaths: ["README.md"],
          blocking: true,
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "p2",
          name: "Bash",
          status: "in_progress",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin main" }),
        });
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "p2",
          name: "Bash",
          status: "completed",
          title: "Bash",
          result: "To origin\n   2222222..3333333  main -> main",
        });

        assert.equal(gateEvents().length, 1);
        assert.equal(gateEvents()[0]!.gate, "blocking_escalation");
        assert.deepEqual(gateEvents()[0]!.escalationIds, [esc.id]);
        assert.equal(gateEvents()[0]!.openBlockingEscalations, 1);
        assert.equal(gateEvents()[0]!.activity, "remote_push");
        assert.deepEqual(gateEvents()[0]!.refs, ["2222222..3333333 main -> main"]);
        assert.equal(gateEvents()[0]!.confirmed, true);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns compact goal_get (<50,000 chars) through the Director tool path for a 40KB / 18-criteria / 12-review goal", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-get-"));
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: join(stateDir, "d.sock"),
      });

      let goalId = "";
      let defaultResult: Record<string, unknown> | undefined;
      let pagedResult: Record<string, unknown> | undefined;

      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            if (req.taskId.startsWith("chat-")) {
              defaultResult = (await req.executeTool("goal_get", { goal_id: goalId })) as Record<string, unknown>;
              const firstCursor = (defaultResult.reviewsPage as { nextBefore: string | null }).nextBefore;
              pagedResult = (await req.executeTool("goal_get", {
                goal_id: goalId,
                sections: ["reviews"],
                reviews_before: firstCursor,
                reviews_limit: 5,
              })) as Record<string, unknown>;
              return { text: "inspected", stopReason: "completed" };
            }
            return { text: "ok", stopReason: "completed" };
          },
        }),
      });
      await daemon.start();

      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const fullDescription = Array.from({ length: 800 }, (_, i) =>
          `Spec line ${String(i).padStart(4, "0")}: requirement details for large goal. `.padEnd(50, "x"),
        )
          .join("")
          .slice(0, 40_000);
        assert.equal(fullDescription.length, 40_000);

        const criteria: GoalCriterion[] = Array.from({ length: 18 }, (_, i) => ({
          id: `c${i + 1}`,
          description: `Criterion ${i + 1} detailed requirement `.padEnd(400, "d"),
          kind: i % 3 === 0 ? "deterministic" : i % 3 === 1 ? "behavioral" : "architectural",
          command: i % 3 === 0 ? `bun test test/suite-${i + 1}.test.ts --verbose `.padEnd(150, "a") : undefined,
          required: i < 15,
        }));

        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Large 40KB goal",
          description: fullDescription,
          criteria,
          budgets: { maxReviewCycles: 50, maxNoProgressCycles: 50 },
          verificationMode: "none",
        });
        goalId = goal.id;

        const run = daemon.db.createRun({
          repoRoot,
          baseBranch: "main",
          baseSha: (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout,
          goal: goal.title,
        });
        const t1 = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orchestrator",
          objective: "Coordinate",
          profileId: "fixture",
        });
        for (let i = 0; i < 40; i++) {
          const w = daemon.db.createTask({
            runId: run.id,
            parentId: t1.id,
            tier: 2,
            kind: "worker",
            title: `Worker ${i + 1}`,
            objective: `Task ${i + 1}`,
            profileId: "fixture",
          });
          daemon.db.updateTask(w.id, {
            status: "completed",
            summary: `Worker ${i + 1} completed: `.padEnd(2_000, "s"),
          });
        }
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        for (let cycle = 1; cycle <= 12; cycle++) {
          daemon.director.goals.recordReviewVerdict(goal.id, {
            verdict: "changes_requested",
            diffHash: `diff-hash-${cycle}`,
            summary: `Review cycle ${cycle} summary: `.padEnd(3_000, "r"),
            blockingIssues: Array.from({ length: 15 }, (_, b) => `Issue ${cycle}.${b + 1}: `.padEnd(400, "b")),
            criteriaResults: criteria.map((c, idx) => ({
              criterionId: c.id,
              passed: (idx + cycle) % 3 !== 0,
              evidence: `Cycle ${cycle} evidence for ${c.id}: `.padEnd(1_500, "e"),
              remediation: (idx + cycle) % 3 === 0 ? `Fix ${c.id} in cycle ${cycle + 1}` : undefined,
            })),
          });
        }

        await daemon.director.sendChatMessage(chat.id, "inspect large goal");
        assert.ok(defaultResult, "expected default goal_get result");
        const serialized = JSON.stringify(defaultResult);
        assert.ok(serialized.length < 50_000, `expected <50,000 chars, got ${serialized.length}`);
        assert.equal(typeof defaultResult.presentation_id, "string");

        const criteriaOut = defaultResult.criteria as Array<{ id: string; status: string }>;
        assert.deepEqual(
          criteriaOut.map((c) => c.id),
          criteria.map((c) => c.id),
        );
        for (const c of criteriaOut) {
          assert.ok(["passed", "failed", "not_evaluated"].includes(c.status), `unexpected status ${c.status}`);
        }

        const reviewsOut = defaultResult.reviews as Array<{ id: string; cycle: number; criteriaResults?: unknown[] }>;
        assert.equal(reviewsOut.length, 1);
        assert.equal(reviewsOut[0]!.cycle, 12);
        assert.equal(reviewsOut[0]!.criteriaResults?.length, 18);
        assert.deepEqual(defaultResult.reviewsPage, { total: 12, returned: 1, nextBefore: reviewsOut[0]!.id });

        const goalOut = defaultResult.goal as { description: { chars: number; path: string | null } };
        assert.equal(goalOut.description.chars, 40_000);
        assert.ok(goalOut.description.path, "expected full description file path");
        assert.equal(readFileSync(join(repoRoot, goalOut.description.path!), "utf8"), fullDescription);

        // Verify paging through Director tool path.
        assert.ok(pagedResult, "expected paged goal_get result");
        assert.ok(JSON.stringify(pagedResult).length < 50_000);
        const pagedReviews = pagedResult.reviews as Array<{ cycle: number; criteriaResults?: unknown[] }>;
        assert.deepEqual(
          pagedReviews.map((r) => r.cycle),
          [11, 10, 9, 8, 7],
        );
        assert.equal(pagedReviews[0]!.criteriaResults?.length, 18);
        for (const older of pagedReviews.slice(1)) {
          assert.equal(older.criteriaResults, undefined);
        }
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("goal_list returns compact summaries (<20k chars) for 30 large goals, supports status filter, and pages 120 goals via nextCursor", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-list-state-"));
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: join(stateDir, "d.sock"),
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async () => ({ text: "ok", stopReason: "completed" }),
        }),
      });
      await daemon.start();
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
        const bigDescription = "Large specification paragraph for compact goal_list testing. ".repeat(700).slice(0, 40_000);
        assert.equal(bigDescription.length, 40_000);

        const first30Ids: string[] = [];
        for (let i = 1; i <= 30; i++) {
          const g = daemon.director.goals.createGoal({
            chatSessionId: chat.id,
            repoRoot,
            title: `Large goal ${i}: ` + "X".repeat(200),
            description: bigDescription,
            criteria: [{ id: "c1", description: "Must pass", kind: "behavioral", required: true }],
            budgets: { maxReviewCycles: 20, maxNoProgressCycles: 20 },
            verificationMode: "none",
          });
          first30Ids.push(g.id);
          const run = daemon.db.createRun({
            repoRoot,
            baseBranch: "main",
            baseSha,
            goal: g.title,
          });
          const t1 = daemon.db.createTask({
            runId: run.id,
            tier: 1,
            kind: "orchestrator",
            title: `Orch ${i}`,
            objective: "Coord",
            profileId: "fixture",
          });
          daemon.director.goals.linkRunAndStart(g.id, run.id);

          // Add 2 unresolved escalations (1 open + 1 acked) and 1 resolved escalation on goal 1.
          if (i === 1) {
            daemon.db.createEscalation({
              runId: run.id,
              fromTaskId: t1.id,
              toTaskId: null,
              severity: "P1",
              category: "code_defect",
              title: "Open escalation",
              evidencePaths: ["README.md"],
              blocking: true,
            });
            const acked = daemon.db.createEscalation({
              runId: run.id,
              fromTaskId: t1.id,
              toTaskId: null,
              severity: "P2",
              category: "code_defect",
              title: "Acked escalation",
              evidencePaths: ["README.md"],
              blocking: false,
            });
            daemon.db.ackEscalation(acked.id, "acknowledged", false);
            const resolved = daemon.db.createEscalation({
              runId: run.id,
              fromTaskId: t1.id,
              toTaskId: null,
              severity: "P2",
              category: "code_defect",
              title: "Resolved escalation",
              evidencePaths: ["README.md"],
              blocking: false,
            });
            daemon.db.tryResolveEscalation(resolved.id, "fixed");
          }

          // Record 3 reviews per goal.
          for (let c = 1; c <= 3; c++) {
            daemon.director.goals.recordReviewVerdict(g.id, {
              verdict: c === 3 && i % 5 === 0 ? "approved" : "changes_requested",
              diffHash: `diff-${i}-${c}`,
              summary: `Review ${c} for goal ${i}: `.padEnd(1_200, "r"),
              blockingIssues: [`Blocking ${i}.${c}`],
              criteriaResults: [{ criterionId: "c1", passed: c === 3 && i % 5 === 0, evidence: "ev".padEnd(500, "e") }],
            });
          }
          if (i % 3 === 0) {
            daemon.director.goals.setStatus(g.id, "awaiting_human");
          }
        }

        // 1. Default goal_list on 30 large goals: < 20,000 chars, all 30 ids present with compact summary fields.
        const list30 = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_list", {})) as {
          goals: Array<{
            id: string;
            version: number;
            title: string;
            status: string;
            reviewCycle: number;
            linkedRunId: string | null;
            openEscalations: number;
            latestReview: { verdict: string; cycle: number; goalVersion: number; createdAt: number } | null;
            updatedAt: number;
          }>;
          page: { total: number; returned: number; nextCursor: string | null };
          presentation_id: string;
        };
        const jsonLen30 = JSON.stringify(list30).length;
        assert.ok(jsonLen30 < 20_000, `expected < 20,000 chars for 30 large goals, got ${jsonLen30}`);
        assert.deepEqual(list30.page, { total: 30, returned: 30, nextCursor: null });
        assert.deepEqual(new Set(list30.goals.map((g) => g.id)), new Set(first30Ids));
        assert.equal(typeof list30.presentation_id, "string");

        const g1Summary = list30.goals.find((g) => g.id === first30Ids[0])!;
        assert.equal(g1Summary.openEscalations, 2); // 1 open + 1 acked, excludes resolved
        assert.equal(g1Summary.version, 1);
        assert.equal(g1Summary.reviewCycle, 3);
        assert.ok(g1Summary.title.length <= 160);
        assert.equal("description" in g1Summary, false);
        assert.equal(g1Summary.latestReview?.cycle, 3);
        assert.equal(g1Summary.latestReview?.goalVersion, 1);
        assert.equal(g1Summary.latestReview?.verdict, "changes_requested");

        // 2. Status filter returns only matching goals.
        const awaiting = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_list", {
          status: "awaiting_human",
        })) as typeof list30;
        assert.equal(awaiting.page.total, 10);
        assert.equal(awaiting.page.returned, 10);
        assert.equal(awaiting.page.nextCursor, null);
        assert.ok(awaiting.goals.every((g) => g.status === "awaiting_human"));

        // 3. Add 90 more goals (120 total) and page through via nextCursor: every id returned exactly once.
        const all120Ids = new Set(first30Ids);
        for (let i = 31; i <= 120; i++) {
          const g = daemon.director.goals.createGoal({
            chatSessionId: chat.id,
            repoRoot,
            title: `Extra goal ${i}`,
            description: `Description ${i}`,
            criteria: [],
            verificationMode: "none",
          });
          all120Ids.add(g.id);
        }

        const seenIds = new Set<string>();
        let cursor: string | null = null;
        let pageCount = 0;
        do {
          const res = (await daemon.director.executeDirectorMcpTool(
            chat.id,
            "goal_list",
            cursor ? { cursor } : {},
          )) as typeof list30;
          assert.ok(JSON.stringify(res).length < 20_000, `page ${pageCount} exceeded 20,000 chars`);
          assert.equal(res.page.total, 120);
          for (const g of res.goals) {
            assert.ok(!seenIds.has(g.id), `duplicate goal id ${g.id} across pages`);
            seenIds.add(g.id);
          }
          cursor = res.page.nextCursor;
          pageCount++;
          assert.ok(pageCount <= 10, "paging 120 goals with default limit=30 should take 4 pages");
        } while (cursor !== null);
        assert.equal(pageCount, 4);
        assert.deepEqual(seenIds, all120Ids);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
