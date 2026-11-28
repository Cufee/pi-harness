import { withFixtureCatalog } from "./fixtures/launch-config.js";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { GoalRecord } from "../src/goals/engine.js";
import type { RunAgentRequest } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-lead-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "status.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(15);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

/**
 * One goal driven end to end through the daemon with scripted agents: the Director (Tier 0) and the lead thread
 * (Tier 1). The scripts stand in for the models; every assertion is on what the harness itself did.
 */
describe("lead thread: autonomy, turn-end check, and the request ledger", () => {
  it("lets the lead do the work itself, holds it to the goal, relays its question until answered, and routes declined work back", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-lead-state-"));
    const sockPath = join(stateDir, "d.sock");
    const seen = {
      leadCwd: "",
      leadPolicy: "",
      leadTools: [] as string[],
      checks: [] as Array<string | null>,
      leadPrompts: [] as string[],
      directorPrompts: [] as string[],
      errors: [] as string[],
      leadPlanSeenByDirector: null as { revision: number; scope: string; steps: Array<{ id: string; status: string }> } | null,
    };
    let leadRuns = 0;
    // An agent can only call what its tool list offers: every scripted call goes through this check.
    const callListed = (req: RunAgentRequest, name: string, args: Record<string, unknown>): Promise<unknown> => {
      assert.ok(req.tools.some((tool) => tool.name === name), `${name} must be in the ${req.taskId} tool list`);
      return req.executeTool(name, args);
    };

    const lead = async (req: RunAgentRequest): Promise<string> => {
      leadRuns += 1;
      seen.leadPrompts.push(req.initialPrompt);
      const check = async () => {
        const text = await req.turnEndCheck!();
        seen.checks.push(text);
        return text;
      };
      if (leadRuns === 1) {
        seen.leadCwd = req.cwd;
        seen.leadPolicy = req.toolPolicy;
        seen.leadTools = req.tools.map((t) => t.name);
        // The lead implements the change itself, in its own worktree.
        writeFileSync(join(req.cwd, "greet.txt"), "hello\n", "utf8");
        await runGit(req.cwd, ["add", "-A"]);
        await runGit(req.cwd, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add greeting"]);
        // It tries to end its turn: nothing is planned or merged yet.
        await check();
        await callListed(req, "update_plan", {
          scope: "Only greet.txt; the wording is the user's call.",
          steps: [
            { id: "s1", title: "Write greet.txt", status: "done", criteria: ["c1"] },
            { id: "s2", title: "Use the wording the user picks", status: "pending" },
          ],
        });
        const merge = (await callListed(req, "submit_for_merge", { summary: "greeting" })) as { status: string; note?: string };
        assert.equal(merge.status, "merged");
        assert.match(merge.note ?? "", /continues from main/);
        await callListed(req, "ask_user", { question: "Should the greeting say hello or hi?", options: ["hello", "hi"], context: "I recommend hello." });
        // Waiting on the user: told once to do what does not depend on the answer, then allowed to end.
        await check();
        await check();
        return "Result: greet.txt is merged. Not done: the wording. Next: answer the question.";
      }
      if (leadRuns === 2) {
        // Resumed with the user's answer: the plan and the answer are in the first prompt.
        writeFileSync(join(req.cwd, "greet.txt"), "hi\n", "utf8");
        await runGit(req.cwd, ["add", "-A"]);
        await runGit(req.cwd, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "use hi"]);
        await callListed(req, "update_plan", {
          steps: [
            { id: "s1", title: "Write greet.txt", status: "done", criteria: ["c1"] },
            { id: "s2", title: "Use the wording the user picks", status: "done", note: "hi" },
          ],
        });
        // Steps are done, but the second commit is not merged.
        await check();
        await callListed(req, "submit_for_merge", { summary: "wording" });
        // Merged, but no result is reported for the required criterion.
        await check();
        await callListed(req, "report_goal_progress", {
          summary: "greet.txt says hi on main",
          criteria_results: [{ criterion_id: "c1", passed: true, evidence: "git show main:greet.txt -> hi" }],
        });
        await check();
        return "Result: greet.txt says hi on main. Not done: nothing. Next: nothing.";
      }
      // Resumed a second time with a forwarded request that is outside the goal: decline it.
      const requestId = /Request (req-\d+) from the user/.exec(req.initialPrompt)?.[1];
      assert.ok(requestId, "the forwarded request reaches the lead's first prompt");
      await check();
      const declined = (await callListed(req, "triage_request", {
        request_id: requestId,
        decision: "decline",
        note: "A changelog is a separate deliverable; this goal is only the greeting.",
      })) as { routedToDirector?: string };
      assert.match(declined.routedToDirector ?? "", /^req-\d+$/);
      // A resumed goal drops the results reported before the resume, so the lead confirms the criterion again.
      await check();
      await callListed(req, "report_goal_progress", {
        summary: "unchanged: greet.txt says hi on main",
        criteria_results: [{ criterion_id: "c1", passed: true, evidence: "git show main:greet.txt -> hi" }],
      });
      await check();
      return "Result: nothing changed; the changelog request went back to the Director.";
    };

    const director = async (req: RunAgentRequest): Promise<string> => {
      const prompt = req.initialPrompt;
      seen.directorPrompts.push(prompt);
      const turn = prompt.slice(prompt.lastIndexOf("\n\nUser: ") >= 0 && !prompt.includes("Control-plane event (") ? prompt.lastIndexOf("\n\nUser: ") : prompt.lastIndexOf("Control-plane event ("));
      if (turn.startsWith("Control-plane event (thread.request)")) {
        if (turn.includes("needs an answer from the user")) return "The greeting thread needs your call on the wording.";
        if (turn.includes("declined request")) {
          const routedId = /routed work (req-\d+)/.exec(turn)?.[1];
          await callListed(req, "resolve_request", { request_id: routedId, outcome: "dropped", note: "User does not want a changelog now." });
          return "The greeting thread said a changelog is separate work; I dropped it for now.";
        }
        return "Noted.";
      }
      if (turn.startsWith("Control-plane event")) return "Noted.";
      if (turn.includes("ship the greeting")) {
        const created = (await callListed(req, "goal_create", {
          title: "Ship greeting file",
          description: "Create greet.txt.",
          criteria: [{ id: "c1", description: "greet.txt exists on main", kind: "behavioral", required: true }],
          verification_mode: "none",
          commit_immediately: true,
          model: req.model,
        })) as GoalRecord;
        return `Started ${created.id}.`;
      }
      if (turn.includes("how is it going")) {
        // The Director can read the lead's own plan instead of guessing where the thread stands.
        const goalId = /- (goal-\d+) v\d+/.exec(prompt)?.[1];
        const status = (await callListed(req, "run_status", { goal_id: goalId })) as {
          leadPlan?: { revision: number; scope: string; steps: Array<{ id: string; status: string }> };
        };
        seen.leadPlanSeenByDirector = status.leadPlan ?? null;
        return "Still waiting on the wording.";
      }
      if (turn.includes("use hi")) {
        const questionId = /- (req-\d+) \[goal-\d+/.exec(prompt)?.[1];
        const res = (await callListed(req, "resolve_request", { request_id: questionId, outcome: "user_answered", note: "hi" })) as {
          delivery: { delivered: boolean };
        };
        return res.delivery.delivered ? "Passed your answer to the thread." : "Could not deliver the answer.";
      }
      if (turn.includes("also write a changelog")) {
        const goalId = /- (goal-\d+) v\d+/.exec(prompt)?.[1];
        const res = (await callListed(req, "send_request", { goal_id: goalId, message: "Also write a changelog for the whole project." })) as {
          request: string;
        };
        return `Forwarded as ${res.request}.`;
      }
      return "ok";
    };

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        // Tools are listed directly instead of behind code_exec, so the scripts can check what each agent is offered.
        codeMode: "off",
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            try {
              const text = req.taskId.startsWith("chat-") ? await director(req) : req.tier === 1 ? await lead(req) : "idle";
              return { text, stopReason: "completed" };
            } catch (err) {
              seen.errors.push(err instanceof Error ? (err.stack ?? err.message) : String(err));
              return { text: "script failed", stopReason: "completed" };
            }
          },
        }),
      });
      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();
      const db = daemon.db;
      const turns = (chatId: string) =>
        db.db.prepare("SELECT role, content FROM chat_turns WHERE chat_session_id = ? ORDER BY seq").all(chatId) as Array<{ role: string; content: string }>;
      const requests = () => db.threads.listRequests({});
      const leadTask = () => db.listTasks(db.listRuns(10).find((r) => !r.id.startsWith("director-tasks-"))!.id).find((t) => t.tier === 1)!;

      try {
        const opened = (await client.request("chat.open", { repoRoot })) as { session: { id: string } };
        const chatId = opened.session.id;
        // A wake turn (a settled goal, a lead's request) may hold the chat for a moment; the user simply sends again.
        const send = async (text: string): Promise<string> => {
          for (let attempt = 0; ; attempt++) {
            try {
              const res = (await client.request("chat.send", { chatSessionId: chatId, text })) as { assistantTurn: { content: string } };
              return res.assistantTurn.content;
            } catch (err) {
              if (attempt > 400 || !/already responding/.test(String(err))) throw err;
              await Bun.sleep(15);
            }
          }
        };

        assert.match(await send("ship the greeting"), /Started goal-/);

        // 1. The lead is writable, works in its own worktree, and merged its own change.
        await waitUntil(() => leadRuns >= 1 && leadTask()?.status === "completed", "the lead's first turn to end");
        assert.deepEqual(seen.errors, []);
        assert.equal(seen.leadPolicy, "read_write_workspace");
        assert.notEqual(seen.leadCwd, repoRoot);
        for (const tool of ["update_plan", "submit_for_merge", "ask_user", "triage_request", "route_to_director", "spawn_task", "spawn_worker"]) {
          assert.ok(seen.leadTools.includes(tool), `lead tool ${tool}`);
        }
        assert.equal((await runGit(repoRoot, ["show", "main:greet.txt"])).stdout.trim(), "hello");

        // 2. Turn-end check: first everything that is open, then the one-time note while it waits on the user, then it may end.
        assert.match(seen.checks[0] ?? "", /No plan is recorded/);
        assert.match(seen.checks[0] ?? "", /commits that are not on main/);
        assert.match(seen.checks[1] ?? "", /Plan steps are not finished: s2/);
        assert.match(seen.checks[1] ?? "", /You are waiting on the user \(req-\d+\)/);
        assert.equal(seen.checks[2], null);

        // 3. A lead that stops to wait on the user parks its goal; it is not treated as finished.
        const goalId = ((await client.request("goal.list", { repoRoot })) as GoalRecord[])[0]!.id;
        await waitUntil(() => daemon.director.goals.getGoal(goalId)?.status === "awaiting_human", "the goal to wait on the user");

        // 4. The Director was woken with the question, and the harness put it under the Director's reply.
        await waitUntil(() => turns(chatId).some((t) => t.role === "assistant" && t.content.includes("Waiting on you:")), "the question to reach the user");
        const relayed = turns(chatId).find((t) => t.role === "assistant" && t.content.includes("Waiting on you:"))!.content;
        assert.match(relayed, /^The greeting thread needs your call on the wording\.\n\nWaiting on you:\n- \[req-\d+, goal-\d+\] Should the greeting say hello or hi\?/);
        assert.match(relayed, /1\. hello\n\s+2\. hi/);
        assert.match(relayed, /Context: I recommend hello\./);

        // 5. The user talks about something else: the reply still ends with the unanswered question.
        const status = await send("how is it going?");
        assert.match(status, /^Still waiting on the wording\.\n\nWaiting on you:\n- \[req-\d+, goal-\d+\] Should the greeting say hello or hi\?/);
        const question = requests().find((r) => r.kind === "user_question")!;
        assert.equal(question.promptCount, 2);
        // The work snapshot carries the same plan and the open question, so a client can show them.
        const snapshot = await client.request<{
          runs: Array<{
            goalId: string | null;
            leadPlan: { revision: number; steps: Array<{ id: string }> } | null;
            requests: Array<{ id: string; kind: string; status: string; title: string }>;
          }>;
        }>("work.snapshot", { chatSessionId: chatId, repoRoot });
        const snapshotRun = snapshot.runs.find((r) => r.goalId === goalId)!;
        assert.deepEqual(snapshotRun.leadPlan?.steps.map((step) => step.id), ["s1", "s2"]);
        assert.deepEqual(
          snapshotRun.requests.map((r) => [r.id, r.kind, r.status]),
          [[question.id, "user_question", "open"]],
        );
        assert.equal(seen.leadPlanSeenByDirector?.revision, 1);
        assert.equal(seen.leadPlanSeenByDirector?.scope, "Only greet.txt; the wording is the user's call.");
        assert.deepEqual(
          seen.leadPlanSeenByDirector?.steps.map((step) => [step.id, step.status]),
          [["s1", "done"], ["s2", "pending"]],
        );

        // 6. The user answers: the question closes, the reply no longer asks, and the lead is resumed with the answer and its plan.
        const answered = await send("use hi");
        assert.equal(answered, "Passed your answer to the thread.");
        await waitUntil(() => leadRuns >= 2 && leadTask()?.status === "completed", "the lead to finish after the answer");
        assert.deepEqual(seen.errors, []);
        assert.match(seen.leadPrompts[1]!, /\[The user answered your question req-\d+\]/);
        assert.match(seen.leadPrompts[1]!, /<user_answer>\s*hi\s*<\/user_answer>/);
        assert.match(seen.leadPrompts[1]!, /## Your Plan \(revision 1/);
        assert.match(seen.leadPrompts[1]!, /- \[ \] s2: Use the wording the user picks/);
        assert.equal(requests().find((r) => r.id === question.id)!.outcome, "user_answered");

        // 7. Second turn: unmerged work, then an unreported required criterion, each reopen the turn; then it may end.
        assert.match(seen.checks[3] ?? "", /commits that are not on main/);
        assert.doesNotMatch(seen.checks[3] ?? "", /Plan steps/);
        assert.match(seen.checks[4] ?? "", /Required criteria with no reported result: c1 \(greet\.txt exists on main\)/);
        assert.doesNotMatch(seen.checks[4] ?? "", /not on main/);
        assert.equal(seen.checks[5], null);
        assert.equal((await runGit(repoRoot, ["show", "main:greet.txt"])).stdout.trim(), "hi");
        // The finished lead's merged worktree is gone; nothing is left to clean up by hand.
        await waitUntil(() => !existsSync(seen.leadCwd), "the lead's worktree to be retired");
        assert.equal(readFileSync(join(repoRoot, "status.txt"), "utf8"), "v1\n");

        // 8. The user asks for something outside the goal: the Director forwards it, the lead declines, and it comes back as routed work.
        assert.match(await send("also write a changelog"), /^Forwarded as req-\d+\.$/);
        await waitUntil(
          () => seen.checks.length >= 9 && requests().some((r) => r.kind === "routed_work" && r.status === "resolved"),
          "the lead to decline and the Director to place the declined request",
        );
        assert.deepEqual(seen.errors, []);
        assert.match(seen.checks[6] ?? "", /Request req-\d+ \("Also write a changelog for the whole project\."\) is not triaged/);
        assert.doesNotMatch(seen.checks[7] ?? "", /is not triaged/);
        assert.match(seen.checks[7] ?? "", /Required criteria with no reported result: c1/);
        assert.equal(seen.checks[8], null);
        const forwarded = requests().find((r) => r.kind === "user_request")!;
        const routed = requests().find((r) => r.kind === "routed_work")!;
        assert.deepEqual([forwarded.status, forwarded.outcome], ["resolved", "declined"]);
        assert.equal(routed.originId, forwarded.id);
        assert.match(routed.body, /Also write a changelog[\s\S]*Declined by the lead thread: A changelog is a separate deliverable/);
        assert.deepEqual([routed.outcome, routed.resolution], ["dropped", "User does not want a changelog now."]);
        // The Director's relay is its own turn; a later wake for the settled run may follow it.
        await waitUntil(
          () => turns(chatId).some((t) => t.role === "assistant" && t.content === "The greeting thread said a changelog is separate work; I dropped it for now."),
          "the Director to tell the user where the request went",
        );
        assert.equal(requests().filter((r) => r.status === "open").length, 0);
      } finally {
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});
