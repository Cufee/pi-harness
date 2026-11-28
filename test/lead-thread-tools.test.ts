import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import type { RunAgentRequest } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function makeTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; stateDir: string }> {
  const root = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  return { root, repoRoot, stateDir: join(root, "state") };
}

function makeOrchestrator(repoRoot: string, stateDir: string, runnerFactory: CustomRunnerFactory, patch?: (c: HarnessConfig) => HarnessConfig) {
  const db = new ControlPlaneDb(":memory:");
  const base = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, codeMode: "off" });
  const config = patch ? patch(base) : base;
  const quota = new QuotaClient();
  const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota, runnerFactory);
  return { db, config, orch };
}

async function waitUntil(pred: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe("lead thread tools", () => {
  it("stops reopening a turn after the same list came back unchanged, and records what was left open", async () => {
    const { root, repoRoot, stateDir } = await makeTempGitRepo("pi-harness-lead-giveup-");
    const checks: Array<string | null> = [];
    let failure: unknown = null;
    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req: RunAgentRequest) => {
        try {
          await req.executeTool("update_plan", { scope: "x", steps: [{ id: "s1", title: "Never finished" }] });
          // The scripted lead ends its turn again and again without changing anything.
          for (let i = 0; i < 4; i++) checks.push(await req.turnEndCheck!());
        } catch (err) {
          failure = err;
        }
        return { text: "I think I am done.", stopReason: "completed" as const };
      },
    }));
    try {
      const { run, orchestratorTask } = await orch.startRun({ goal: "Do the thing", repoRoot });
      await waitUntil(() => db.getTask(orchestratorTask.id)?.status === "completed", "the lead to end");
      assert.equal(failure, null);
      // goals.leadTurnEndChecks defaults to 3: three reopenings, the third announced as the last, then the turn may end.
      assert.equal(checks.filter((c) => c !== null).length, 3);
      assert.match(checks[0]!, /Plan steps are not finished: s1 \(Never finished\)/);
      assert.doesNotMatch(checks[1]!, /last check/);
      assert.match(checks[2]!, /This is the last check for this list/);
      assert.equal(checks[3], null);
      const settled = db.getTask(orchestratorTask.id)!;
      assert.match(settled.summary ?? "", /^I think I am done\.\s+\[Ended with 1 open item: Plan steps are not finished: s1/);
      const events = db.getEventsSince(run.id, 0).filter((e) => e.type === "lead.turn_end_check").map((e) => (e.payload as { outcome: string }).outcome);
      assert.deepEqual(events, ["reopened", "reopened", "reopened", "ended_unfinished"]);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resets the unchanged count when the lead makes progress between checks", async () => {
    const { root, repoRoot, stateDir } = await makeTempGitRepo("pi-harness-lead-progress-");
    const checks: Array<string | null> = [];
    let failure: unknown = null;
    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req: RunAgentRequest) => {
        try {
          const steps = (done: number) => [1, 2, 3, 4, 5].map((n) => ({ id: `s${n}`, title: `step ${n}`, status: n <= done ? "done" : "pending" }));
          // Five rounds, each finishing one more step: more rounds than the unchanged limit of 3, and every one reopens.
          for (let done = 0; done < 5; done++) {
            await req.executeTool("update_plan", { scope: "x", steps: steps(done) });
            checks.push(await req.turnEndCheck!());
          }
          await req.executeTool("update_plan", { steps: steps(5) });
          checks.push(await req.turnEndCheck!());
        } catch (err) {
          failure = err;
        }
        return { text: "Done.", stopReason: "completed" as const };
      },
    }));
    try {
      const { orchestratorTask } = await orch.startRun({ goal: "Do five things", repoRoot });
      await waitUntil(() => db.getTask(orchestratorTask.id)?.status === "completed", "the lead to end");
      assert.equal(failure, null);
      assert.equal(checks.slice(0, 5).every((c) => typeof c === "string" && !c.includes("last check")), true);
      assert.equal(checks[5], null);
      assert.equal(db.getTask(orchestratorTask.id)!.summary, "Done.");
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps a lead read-only when goals.leadWritable is false: no worktree, no merge tools, no execute subagents", async () => {
    const { root, repoRoot, stateDir } = await makeTempGitRepo("pi-harness-lead-readonly-");
    const seen: { cwd?: string; policy?: string; tools?: string[]; prompt?: string; executeError?: string; mergeError?: string } = {};
    const { db, orch } = makeOrchestrator(
      repoRoot,
      stateDir,
      () => ({
        run: async (req: RunAgentRequest) => {
          seen.cwd = req.cwd;
          seen.policy = req.toolPolicy;
          seen.tools = req.tools.map((t) => t.name);
          seen.prompt = req.systemPrompt;
          seen.executeError = await req
            .executeTool("spawn_task", { kind: "execute", objective: "edit", model: "fixture" })
            .then(() => "", (err) => String(err));
          seen.mergeError = await req.executeTool("submit_for_merge", { summary: "x" }).then(() => "", (err) => String(err));
          return { text: "planned", stopReason: "completed" as const };
        },
      }),
      (c) => ({ ...c, goals: { ...c.goals, leadWritable: false } }),
    );
    try {
      const { orchestratorTask } = await orch.startRun({ goal: "Plan only", repoRoot });
      await waitUntil(() => db.getTask(orchestratorTask.id)?.status === "completed", "the lead to end");
      assert.equal(seen.cwd, repoRoot);
      assert.equal(seen.policy, "read_only_workspace");
      assert.equal(db.getTask(orchestratorTask.id)!.worktreeId, null);
      assert.equal(seen.tools!.includes("submit_for_merge"), false);
      assert.equal(seen.tools!.includes("worktree_status"), false);
      assert.equal(seen.tools!.includes("update_plan"), true);
      assert.match(seen.prompt!, /You are read-only in this run/);
      assert.doesNotMatch(seen.prompt!, /submit_for_merge/);
      assert.match(seen.executeError!, /spawn-execute-needs-worker/);
      assert.match(seen.executeError!, /only permits research, plan, and verify for a read-only lead thread/);
      // A hidden merge tool called anyway is refused with the reason and the way forward, not a bare error.
      assert.match(seen.mergeError!, /\[harness blocked: not-your-tool\] submit_for_merge is not available to a read-only lead task/);
      assert.match(seen.mergeError!, /spawn_worker/);
      assert.doesNotMatch(seen.prompt!, /mechanical change across many files|Worker or subagent/);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("triage: accept and delegate keep the request with the lead, decline hands it to the Director as routed work", async () => {
    const { root, repoRoot, stateDir } = await makeTempGitRepo("pi-harness-lead-triage-");
    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({ run: async () => ({ text: "idle", stopReason: "completed" as const }) }));
    try {
      const run = db.createRun({ goal: "g", repoRoot, baseBranch: "main", baseSha: "abc", chatSessionId: "chat-1" });
      const lead = db.createTask({ runId: run.id, tier: 1, kind: "orchestrator", title: "Lead", objective: "o", profileId: "pi:local", readOnly: true });
      const other = db.createTask({ runId: run.id, tier: 1, kind: "orchestrator", title: "Other", objective: "o", profileId: "pi:local", readOnly: true });
      const child = db.createTask({ runId: run.id, parentId: lead.id, tier: 3, kind: "research", title: "Scout", objective: "o", profileId: "pi:local", readOnly: true });
      db.updateTask(lead.id, { status: "running" });
      const exec = (name: string, args: Record<string, unknown>) => orch.toolExecutor.execute(run.id, lead.id, name, args);
      const forward = (title: string, taskId = lead.id) =>
        db.threads.createRequest({ kind: "user_request", runId: run.id, taskId, chatSessionId: "chat-1", goalId: "goal-1", title, body: title });
      const [a, b, c, foreign] = [forward("add a flag"), forward("check the logs"), forward("rewrite the docs site"), forward("not mine", other.id)];

      await assert.rejects(() => exec("triage_request", { request_id: a.id, decision: "accept", note: "" }), /note is required/);
      await assert.rejects(() => exec("triage_request", { request_id: a.id, decision: "maybe", note: "x" }), /not one of accept, delegate, answer, decline/);
      // A request addressed to another thread is not this lead's to decide.
      await assert.rejects(() => exec("triage_request", { request_id: foreign.id, decision: "accept", note: "x" }), new RegExp(`Open requests: ${a.id}, ${b.id}, ${c.id}\\.`));
      await assert.rejects(() => exec("triage_request", { request_id: b.id, decision: "delegate", note: "x" }), /needs task_id/);

      const accepted = (await exec("triage_request", { request_id: a.id, decision: "accept", note: "Adding --dry-run." })) as Record<string, unknown>;
      assert.deepEqual([accepted.outcome, accepted.routedToDirector], ["accepted", undefined]);
      assert.match(String(accepted.next), /update_plan/);
      const delegated = (await exec("triage_request", { request_id: b.id, decision: "delegate", note: "Scout reads them.", task_id: child.id })) as Record<string, unknown>;
      assert.equal(delegated.outcome, "delegated");
      assert.equal(db.threads.getRequest(b.id)!.delegatedTaskId, child.id);
      assert.equal(db.threads.listRequests({ kind: "routed_work" }).length, 0);

      const declined = (await exec("triage_request", { request_id: c.id, decision: "decline", note: "Separate project." })) as { routedToDirector: string };
      const routed = db.threads.getRequest(declined.routedToDirector)!;
      assert.deepEqual(
        [routed.kind, routed.status, routed.originId, routed.chatSessionId, routed.goalId, routed.title],
        ["routed_work", "open", c.id, "chat-1", "goal-1", "rewrite the docs site"],
      );
      await assert.rejects(() => exec("triage_request", { request_id: c.id, decision: "accept", note: "x" }), /already resolved \(declined\)/);

      // Work the lead finds itself goes the same way, and a question for the user is recorded for the Director.
      const found = (await exec("route_to_director", { title: "CI is flaky", detail: "build 12 and 15 failed on the same test", reason: "not caused by this goal" })) as { request: string; routedTo: string };
      assert.equal(found.routedTo, "director:chat-1");
      assert.match(db.threads.getRequest(found.request)!.body, /build 12 and 15[\s\S]*Why it is outside the goal: not caused by this goal/);
      const asked = (await exec("ask_user", { question: "Keep the old flag?", options: ["yes", "no"] })) as { request: string };
      assert.equal(db.threads.getRequest(asked.request)!.body, "Keep the old flag?\n\nOptions:\n1. yes\n2. no");

      const phases = db.getEventsSince(run.id, 0).filter((e) => e.type === "thread.request").map((e) => {
        const p = e.payload as { requestKind: string; phase: string; outcome?: string };
        return `${p.requestKind}:${p.phase}${p.outcome ? `:${p.outcome}` : ""}`;
      });
      assert.deepEqual(phases, [
        "user_request:triaged:accepted",
        "user_request:triaged:delegated",
        "user_request:triaged:declined",
        "routed_work:created",
        "user_question:created",
      ]);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
