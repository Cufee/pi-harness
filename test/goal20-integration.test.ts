import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { GOAL_GET_LIMITS, GOAL_GET_SECTIONS } from "../src/director/goal-get.js";
import type { GoalCriterion } from "../src/goals/engine.js";
import type { ChatControlEvent } from "../src/protocol/chat-events.js";
import type { GoalsTableData, ToolDisplayPayload } from "../src/protocol/tool-display.js";
import { serializeToolResult } from "../src/runners/mcp-bridge.js";
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

        // Fetch followed by a rejected push (status: failed) must NOT emit remote_push from fetch's ref line (P2 fetch-then-push).
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c6",
          name: "Bash",
          kind: "execute",
          status: "failed",
          title: "Bash",
          args: JSON.stringify({ command: "git fetch && git push origin main" }),
          error:
            "From origin\n   1234567..89abcde  main -> origin/main\nTo origin\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs",
        });
        assert.equal(gateEvents().length, 4, "fetch ref line before rejected push must not trigger remote_push");

        // Partial deletion push ('- [deleted] topic' + rejected main, status: failed) MUST emit confirmed remote_push (P2 deletion).
        daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
          id: "c7",
          name: "Bash",
          kind: "execute",
          status: "failed",
          title: "Bash",
          args: JSON.stringify({ command: "git push origin :topic :main" }),
          error:
            "To origin\n - [deleted]         topic\n ! [rejected]        main -> main (remote rejected)\nerror: failed to push some refs",
        });
        assert.equal(gateEvents().length, 5);
        assert.equal(gateEvents()[4]!.confirmed, true);
        assert.deepEqual(gateEvents()[4]!.refs, ["[deleted] topic"]);
        assert.equal(gateEvents()[4]!.toolCallId, "c7");

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
        assert.equal(gateEvents().length, 5, "must not call wakeHandler when wakeDirectorOnGoalSettle is false");
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
        const serialized = serializeToolResult(defaultResult);
        assert.ok(serialized.length <= 40_000, `expected <=40,000 wire chars, got ${serialized.length}`);
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
        assert.equal(readFileSync(resolve(repoRoot, goalOut.description.path!), "utf8"), fullDescription);

        // Verify paging through Director tool path.
        assert.ok(pagedResult, "expected paged goal_get result");
        assert.ok(serializeToolResult(pagedResult).length <= 40_000);
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
        const jsonLen30 = serializeToolResult(list30).length;
        assert.ok(jsonLen30 <= 20_000, `expected <= 20,000 wire chars for 30 large goals, got ${jsonLen30}`);
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
          assert.ok(serializeToolResult(res).length <= 20_000, `page ${pageCount} exceeded 20,000 wire chars`);
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

  it("goal_list limit:1 presentation table matches the returned page and unresolved escalation count", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-state-"));
    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: join(stateDir, "d.sock"),
      });
      type ListRes = {
        goals: Array<{ id: string; openEscalations: number }>;
        page: { total: number; returned: number; nextCursor: string | null };
        presentation_id: string;
      };
      const pageResults: ListRes[] = [];
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            const p1 = (await req.executeTool("goal_list", { limit: 1 })) as ListRes;
            pageResults.push(p1);
            await req.executeTool("present_result", { presentation_id: p1.presentation_id });
            const p2 = (await req.executeTool("goal_list", {
              limit: 1,
              cursor: p1.page.nextCursor,
            })) as ListRes;
            pageResults.push(p2);
            await req.executeTool("present_result", { presentation_id: p2.presentation_id });
            return { text: "presented", stopReason: "completed" };
          },
        }),
      });
      await daemon.start();

      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
        const g1 = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal one",
          description: "First goal",
          criteria: [],
          verificationMode: "none",
        });
        const g2 = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal two",
          description: "Second goal",
          criteria: [],
          verificationMode: "none",
        });
        const g3 = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Goal three (unresolved escalations)",
          description: "Newest goal with open + acked + resolved escalations",
          criteria: [],
          verificationMode: "none",
        });
        const run = daemon.db.createRun({ repoRoot, baseBranch: "main", baseSha, goal: g3.title });
        const t1 = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orch",
          objective: "Coordinate",
          profileId: "fixture",
        });
        daemon.director.goals.linkRunAndStart(g3.id, run.id);
        // 1 open + 1 acked = 2 unresolved; plus 1 resolved that must be excluded.
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
        daemon.db.tryResolveEscalation(resolved.id, "already fixed");

        const displays: ToolDisplayPayload[] = [];
        await daemon.director.sendChatMessage(chat.id, "list goals page by page", undefined, (ev) => {
          if (ev.display) displays.push(ev.display);
        });

        assert.equal(pageResults.length, 2);
        assert.equal(displays.length, 2);

        // Page 1 summary and presentation card match the single newest goal (g3) and unresolved count = 2.
        const [p1, p2] = pageResults;
        assert.deepEqual(p1!.page, { total: 3, returned: 1, nextCursor: g3.id });
        assert.equal(p1!.goals.length, 1);
        assert.equal(p1!.goals[0]!.id, g3.id);
        assert.equal(p1!.goals[0]!.openEscalations, 2);

        assert.equal(displays[0]!.kind, "goals_table");
        const table1 = (displays[0]!.data as GoalsTableData).goals;
        assert.equal(table1.length, 1);
        assert.equal(table1[0]!.id, g3.id);
        assert.equal(table1[0]!.openEscalations, 2);

        // Page 2 summary and presentation card advance to g2 instead of repeating all 3 goals.
        assert.deepEqual(p2!.page, { total: 3, returned: 1, nextCursor: g2.id });
        assert.equal(p2!.goals.length, 1);
        assert.equal(p2!.goals[0]!.id, g2.id);
        assert.notEqual(p2!.goals[0]!.id, g1.id);

        assert.equal(displays[1]!.kind, "goals_table");
        const table2 = (displays[1]!.data as GoalsTableData).goals;
        assert.equal(table2.length, 1);
        assert.equal(table2[0]!.id, g2.id);
        assert.equal(table2[0]!.openEscalations, 0);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("goal_get (default compact and full) returns recentlyResolvedEscalations with status, resolution, resolvedAt, and omitted count after escalation resolution and goal_accept", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-state-"));
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
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Escalation history visibility",
          description: "Ensure resolved escalations remain visible in goal_get after resolution and goal_accept",
          criteria: [{ id: "c1", description: "Accepted", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const run = daemon.db.createRun({ repoRoot, baseBranch: "main", baseSha, goal: goal.title });
        const t1 = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orchestrator",
          objective: "Coordinate",
          profileId: "fixture",
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        // Seed 11 resolved escalations (10 older + 1 with a long resolution) so total with the
        // goal_accept auto-resolved escalation is 12 -> 10 returned, 2 omitted.
        const longResolution = "Manual resolution with full audit details: ".padEnd(360, "r");
        let longResolvedId = "";
        for (let i = 1; i <= 11; i++) {
          const esc = daemon.db.createEscalation({
            runId: run.id,
            fromTaskId: t1.id,
            toTaskId: null,
            severity: i % 2 === 0 ? "P1" : "P2",
            category: "code_defect",
            title: `Historical escalation ${i}`,
            evidencePaths: ["README.md"],
            blocking: false,
          });
          daemon.db.tryResolveEscalation(esc.id, i === 11 ? longResolution : `Resolved item ${i}`);
          if (i === 11) longResolvedId = esc.id;
        }
        // Also seed resolved escalations with whitespace-only resolutions (spaces and tab); neither may be returned or counted.
        const emptyEsc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: t1.id,
          toTaskId: null,
          severity: "P2",
          category: "code_defect",
          title: "Whitespace resolution",
          evidencePaths: ["README.md"],
          blocking: false,
        });
        daemon.db.tryResolveEscalation(emptyEsc.id, "   ");
        const tabEsc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: t1.id,
          toTaskId: null,
          severity: "P2",
          category: "code_defect",
          title: "Tab-only resolution",
          evidencePaths: ["README.md"],
          blocking: false,
        });
        daemon.db.tryResolveEscalation(tabEsc.id, "\t");

        // Leave one open escalation that goal_accept auto-resolves.
        const acceptedEsc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: t1.id,
          toTaskId: null,
          severity: "P1",
          category: "verification_failed",
          title: "Pending blocker resolved on accept",
          evidencePaths: ["README.md"],
          blocking: true,
        });

        await daemon.director.executeDirectorMcpTool(chat.id, "goal_accept", {
          goal_id: goal.id,
          reason: "Verified end-to-end",
          evidence_paths: ["README.md"],
        });

        type ResolvedItem = {
          id: string;
          status: string;
          resolution: string;
          resolvedAt: number | null;
        };
        type GoalGetEscalationResult = {
          openEscalations: unknown[];
          recentlyResolvedEscalations: ResolvedItem[];
          recentlyResolvedEscalationsPage: { total: number; returned: number; omitted: number };
        };

        // 1. Default compact goal_get.
        const compact = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
          goal_id: goal.id,
        })) as GoalGetEscalationResult;
        assert.ok(serializeToolResult(compact).length <= GOAL_GET_LIMITS.budgetChars);
        assert.deepEqual(compact.openEscalations, []);
        assert.equal(compact.recentlyResolvedEscalations.length, GOAL_GET_LIMITS.recentEscalationsMax);
        assert.deepEqual(compact.recentlyResolvedEscalationsPage, { total: 12, returned: 10, omitted: 2 });

        const compactAccepted = compact.recentlyResolvedEscalations.find((e) => e.id === acceptedEsc.id);
        assert.ok(compactAccepted, "goal_accept auto-resolved escalation must appear in compact goal_get");
        assert.equal(compactAccepted.status, "resolved");
        assert.equal(compactAccepted.resolution, `Auto-resolved: goal ${goal.id} achieved`);
        assert.equal(typeof compactAccepted.resolvedAt, "number");

        const compactLong = compact.recentlyResolvedEscalations.find((e) => e.id === longResolvedId);
        assert.ok(compactLong, "manually resolved escalation must appear in compact goal_get");
        assert.equal(compactLong.status, "resolved");
        assert.equal(typeof compactLong.resolvedAt, "number");
        assert.ok(compactLong.resolution.length <= GOAL_GET_LIMITS.escalationResolution);
        assert.equal(
          compact.recentlyResolvedEscalations.some((e) => e.id === emptyEsc.id || e.id === tabEsc.id),
          false,
          "whitespace-only resolved escalations (spaces or tab) must be excluded",
        );
        assert.equal(
          compact.recentlyResolvedEscalations.every((e) => e.resolution.trim() !== ""),
          true,
          "compact resolved escalation page must contain no blank resolutions",
        );
        assert.equal(
          compact.recentlyResolvedEscalationsPage.omitted,
          compact.recentlyResolvedEscalationsPage.total - compact.recentlyResolvedEscalationsPage.returned,
        );

        // 2. Full goal_get (all sections) and narrow escalations section (unclipped resolution).
        const full = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
          goal_id: goal.id,
          sections: [...GOAL_GET_SECTIONS],
        })) as GoalGetEscalationResult;
        assert.ok(serializeToolResult(full).length <= GOAL_GET_LIMITS.budgetChars);
        assert.deepEqual(full.openEscalations, []);
        assert.equal(full.recentlyResolvedEscalations.length, GOAL_GET_LIMITS.recentEscalationsMax);
        assert.deepEqual(full.recentlyResolvedEscalationsPage, { total: 12, returned: 10, omitted: 2 });
        assert.equal(
          full.recentlyResolvedEscalations.every((e) => e.resolution.trim() !== ""),
          true,
          "full resolved escalation page must contain no blank resolutions",
        );
        assert.equal(
          full.recentlyResolvedEscalationsPage.omitted,
          full.recentlyResolvedEscalationsPage.total - full.recentlyResolvedEscalationsPage.returned,
        );
        const fullAccepted = full.recentlyResolvedEscalations.find((e) => e.id === acceptedEsc.id);
        assert.ok(fullAccepted, "goal_accept auto-resolved escalation must appear in full goal_get");
        assert.equal(fullAccepted.status, "resolved");
        assert.equal(fullAccepted.resolution, `Auto-resolved: goal ${goal.id} achieved`);
        assert.equal(typeof fullAccepted.resolvedAt, "number");

        const escalationsOnly = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
          goal_id: goal.id,
          sections: ["escalations"],
        })) as GoalGetEscalationResult;
        assert.deepEqual(escalationsOnly.recentlyResolvedEscalationsPage, { total: 12, returned: 10, omitted: 2 });
        const unclippedLong = escalationsOnly.recentlyResolvedEscalations.find((e) => e.id === longResolvedId);
        assert.ok(unclippedLong);
        assert.equal(unclippedLong.resolution, longResolution);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("goal_get (default compact and full) retains a recently acknowledged escalation when 21+ newer open escalations exist", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal20-state-"));
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
        const goal = daemon.director.goals.createGoal({
          chatSessionId: chat.id,
          repoRoot,
          title: "Recent ack survives escalation cap",
          description: "Ensure a recently acked escalation survives the 20-row openEscalations cap",
          criteria: [{ id: "c1", description: "Visible", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const run = daemon.db.createRun({ repoRoot, baseBranch: "main", baseSha, goal: goal.title });
        const t1 = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orchestrator",
          objective: "Coordinate",
          profileId: "fixture",
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        // Create 1 older escalation, then 21 newer open escalations, then ack the first last (resolve=false).
        const firstEsc = daemon.db.createEscalation({
          runId: run.id,
          fromTaskId: t1.id,
          toTaskId: null,
          severity: "P1",
          category: "code_defect",
          title: "Older escalation acknowledged last",
          evidencePaths: ["README.md"],
          blocking: false,
        });
        await Bun.sleep(5);

        let latestNewerCreatedAt = 0;
        for (let i = 1; i <= 21; i++) {
          const esc = daemon.db.createEscalation({
            runId: run.id,
            fromTaskId: t1.id,
            toTaskId: null,
            severity: "P2",
            category: "code_defect",
            title: `Newer open escalation ${i}`,
            evidencePaths: ["README.md"],
            blocking: false,
          });
          latestNewerCreatedAt = Math.max(latestNewerCreatedAt, esc.createdAt);
        }
        await Bun.sleep(5);

        const acked = daemon.db.ackEscalation(firstEsc.id, "acknowledged now", false);
        assert.equal(acked.status, "acked");
        assert.equal(typeof acked.ackedAt, "number");
        assert.ok(acked.ackedAt! > latestNewerCreatedAt);

        type OpenEscalationItem = {
          id: string;
          status: string;
          resolution?: string;
          ackedAt?: number;
        };
        type GoalGetAckResult = {
          openEscalations: OpenEscalationItem[];
          escalationsPage: { total: number; returned: number; omitted: number };
        };

        const checkResult = (res: GoalGetAckResult, label: string) => {
          assert.ok(serializeToolResult(res).length <= GOAL_GET_LIMITS.budgetChars, `${label} within budget`);
          assert.equal(res.openEscalations.length, GOAL_GET_LIMITS.escalationsMax, `${label} capped at 20`);
          assert.deepEqual(res.escalationsPage, { total: 22, returned: 20, omitted: 2 }, `${label} page counts`);
          const found = res.openEscalations.find((e) => e.id === firstEsc.id);
          assert.ok(found, `${label} must include recently acked escalation ${firstEsc.id}`);
          assert.equal(res.openEscalations[0]!.id, firstEsc.id, `${label} orders most recent ack first`);
          assert.equal(found.status, "acked");
          assert.equal(found.resolution, "acknowledged now");
          assert.equal(found.ackedAt, acked.ackedAt);
        };

        const compact = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
          goal_id: goal.id,
        })) as GoalGetAckResult;
        checkResult(compact, "compact goal_get");

        const full = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
          goal_id: goal.id,
          sections: [...GOAL_GET_SECTIONS],
        })) as GoalGetAckResult;
        checkResult(full, "full goal_get");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
