import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { countWords, WORD_BUDGET } from "../src/advisories/message.js";
import { HarnessRejection } from "../src/advisories/rejections.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import {
  ControlPlaneDb,
  type EscalationRecord,
  type MessageRecord,
  type PeerExchangeRecord,
  type RecentlyResolvedEscalation,
  type TaskRecord,
} from "../src/control-plane/db.js";
import { compactTaskHandoff, validateTaskHandoff } from "../src/control-plane/handoffs.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { buildHydrationTurn, buildImmutableSystemPrompt } from "../src/control-plane/prompts.js";
import { buildRunActivitySummary } from "../src/control-plane/telemetry.js";
import { buildGoalGetResult, parseGoalGetOptions } from "../src/director/goal-get.js";
import { archiveRef, archiveRefPatterns } from "../src/storage/names.js";
import { DirectorRuntime } from "../src/director/runtime.js";
import { buildDirectorSystemPrompt } from "../src/director/session.js";
import { QuotaClient } from "../src/quota/client.js";
import { toolPolicyForTask, validateRunPolicy } from "../src/runners/types.js";
import { toolsForRole } from "../src/tool-descriptions/index.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";
import { runGit } from "../src/worktree/manager.js";

async function makeTempGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-cp-"));
  await runGit(dir, ["init", "-b", "main"]);
  await runGit(dir, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "--allow-empty", "-m", "init"]);
  return dir;
}

describe("Tier role instructions", () => {
  it("directs T0 to delegate lookups and act on clear requests", () => {
    const prompt = buildDirectorSystemPrompt("off");
    assert.match(prompt, /never edit code or run shell commands yourself/i);
    assert.match(prompt, /delegate lookups.*read-only research, plan, or verify.*spawn_task/i);
    assert.match(prompt, /concrete model from `list_models`/i);
    assert.match(prompt, /summary and sources via `wait_tasks`.*artifacts on demand/i);
    assert.match(prompt, /read files directly with `read_file`/i);
    assert.match(prompt, /goal_create.*commit it immediately.*clear action request/i);
    assert.match(prompt, /sensible defaults.*ask only.*ambiguous or irreversible/i);
    assert.match(prompt, /separate goals for distinct requests.*amend the relevant active goal/i);
    assert.match(prompt, /goal_amend/);
    assert.match(prompt, /never duplicate a rendered table/i);
  });

  it("lets the T1 lead do the work itself and delegate when it helps, and keeps a read-only lead to planning", () => {
    const prompt = buildImmutableSystemPrompt(1, "orchestrator", "off");
    assert.match(prompt, /^You are a LEAD THREAD in pi-harness \(Tier 1\)/);
    // The lead works in its own worktree and does the work itself by default.
    assert.match(prompt, /own git worktree: you can read, edit, run commands, and commit there/i);
    assert.match(prompt, /do the work yourself by default.*hand a step to someone else only when it helps/i);
    assert.doesNotMatch(prompt, /read-only file\/search access/i);
    assert.doesNotMatch(prompt, /never editing files/i);
    // Delegation is the exception: no decomposition for its own sake, Workers only for steps that can run side by side.
    assert.match(prompt, /complexity alone is not a reason to delegate.*do not hand off one coherent change in pieces/i);
    assert.match(prompt, /do not touch the same files.*Worker thread with `spawn_worker`.*own worktree and merges its own slice.*shared types or interfaces first/i);
    assert.match(prompt, /choose a concrete model for every child from `list_models`.*never guess a model ID/i);
    assert.match(prompt, /subagent with `spawn_task` \(kind research, plan, execute, or verify\); it runs inside your worktree/i);
    assert.match(prompt, /`spawn_task` with kind verify, and scale that to risk/i);
    assert.match(prompt, /wait_children.*read handoffs first \(summary, sources, `artifact_paths`\).*artifact_read.*only when you need it/i);
    assert.match(prompt, /commit in your worktree.*on the base branch with `submit_for_merge`/i);
    assert.match(prompt, /kb_search.*kb_propose.*kb_promote.*kb_archive.*kb_flag_stale/i);

    // The read-only variant keeps the old separation: it reads and plans, and every change goes to someone else.
    const readOnlyPrompt = buildImmutableSystemPrompt(1, "orchestrator", "off", undefined, { readOnlyLead: true });
    assert.match(readOnlyPrompt, /^You are a LEAD THREAD in pi-harness \(Tier 1\)/);
    assert.match(readOnlyPrompt, /read-only in this run: you can read and search the workspace but not edit it or run shell commands, so every change goes to a Worker thread\./i);
    assert.match(readOnlyPrompt, /keep the understanding yourself and hand out the changes/i);
    assert.match(readOnlyPrompt, /subagent with `spawn_task` \(kind research, plan, or verify\)/i);
    assert.match(readOnlyPrompt, /Worker thread with `spawn_worker`.*own worktree and merges its own slice/i);
    assert.match(readOnlyPrompt, /Workers merge their own slices/);
    assert.doesNotMatch(readOnlyPrompt, /do the work yourself by default/i);
    assert.doesNotMatch(readOnlyPrompt, /you can read, edit, run commands, and commit/i);
    assert.doesNotMatch(readOnlyPrompt, /kind research, plan, execute, or verify/i);
    assert.doesNotMatch(readOnlyPrompt, /submit_for_merge|worktree_status/);

    // Tier 1 is read-write in its own worktree by default and read-only when created read-only. Its runner request may
    // narrow to read_only_workspace or control_plane_only (Director). Research stays on a tier that can never write.
    assert.equal(toolPolicyForTask(1, "orchestrator"), "read_write_workspace");
    assert.equal(toolPolicyForTask(1, "orchestrator", true), "read_only_workspace");
    assert.equal(toolPolicyForTask(3, "research"), "read_only_workspace");
    const baseReq = {
      runId: "r", taskId: "t", tier: 1 as const, kind: "orchestrator" as const, cwd: "/tmp",
      systemPrompt: "sys", initialPrompt: "init", model: "opus", maxTurns: 1,
      tools: [], executeTool: async () => ({}), signal: new AbortController().signal, callbacks: {},
    };
    validateRunPolicy({ ...baseReq, toolPolicy: "read_write_workspace" });
    validateRunPolicy({ ...baseReq, toolPolicy: "read_only_workspace" });
    validateRunPolicy({ ...baseReq, toolPolicy: "control_plane_only" });
    assert.throws(
      () => validateRunPolicy({ ...baseReq, tier: 3, kind: "research", toolPolicy: "read_write_workspace" }),
      /Invalid tool policy/,
    );
  });

  it("gives T2 ownership of a scoped worktree and independent verification", () => {
    const prompt = buildImmutableSystemPrompt(2, "worker", "off");
    assert.match(prompt, /isolated git worktree.*only within your assigned write scopes/i);
    assert.match(prompt, /do the work yourself by default/i);
    assert.match(prompt, /read-only subagent \(`spawn_task`, `kind: 'research'`\) when exploring a large unfamiliar area/i);
    assert.match(prompt, /independent read-only `verify` subagent before submitting/i);
    assert.match(prompt, /list_models.*model.*effort/i);
    assert.match(prompt, /wait_children.*summaries.*sources.*artifact_paths.*artifact_read.*more detail/i);
    assert.match(prompt, /return_task.*2,000 characters.*structured sources.*artifact_paths/i);
  });

  it.each(["research", "plan", "verify", "execute"] as const)("bounds a T3 %s assignment and its output", (kind) => {
    const prompt = buildImmutableSystemPrompt(3, kind, "off");
    if (kind === "execute") {
      assert.match(prompt, /execute only the assigned change.*respect any read-only restriction/i);
    } else {
      assert.ok(prompt.includes(`Your ${kind} assignment is read-only`));
      assert.match(prompt, /never edit workspace files, run mutating commands, or implement changes/i);
    }
    assert.match(prompt, /never attempt to spawn subagents/i);
    assert.match(prompt, /catalog model assigned by your parent/i);
    if (kind === "execute") {
      assert.match(prompt, /return_task.*2,000 characters.*structured sources.*path.*lines.*symbol.*note/i);
    } else {
      assert.match(prompt, /return_task.*2,000 characters.*files and lines.*handoff without sources is rejected/i);
    }
    assert.match(prompt, /artifact_write.*artifact_paths.*transcripts or tool logs/i);
  });

  it("launches the independent reviewer with a read-only evidence and verdict contract", async () => {
    const repoRoot = await makeTempGitRepo();
    const db = new ControlPlaneDb(":memory:");
    try {
      const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir: join(repoRoot, "state") });
      const quota = new QuotaClient();
      const catalog = new ModelCatalogCompiler(config, quota);
      const orch = new HarnessOrchestrator(db, config, catalog, quota);
      const director = new DirectorRuntime(db, config, catalog, quota, orch, () => ({
        run: async (req) => {
          assert.equal(req.kind, "verify");
          assert.equal(req.toolPolicy, "read_only_workspace");
          assert.match(req.systemPrompt, /independent read-only Done-Reviewer/i);
          assert.match(req.systemPrompt, /never edit tracked repository code or delegate/i);
          assert.match(req.systemPrompt, /concrete sources for every required criterion/i);
          assert.deepEqual(req.tools.map(tool => tool.name), ["submit_review_verdict"]);
          await req.executeTool("submit_review_verdict", {
            verdict: "approved", criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Fixture reviewed" }],
            summary: "Reviewed the fixture",
          });
          return { text: "", stopReason: "completed" };
        },
      }));
      const goal = director.goals.createGoal({
        repoRoot, title: "Review fixture", description: "Review the fixture",
        criteria: [{ id: "c1", kind: "behavioral", description: "Fixture reviewed" }],
      });
      assert.equal((await director.verifyAndReviewGoal(goal.id)).review.verdict, "approved");
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe("Control Plane: DAG, Leases, Scope Send-Back, Rollover & Seance", () => {
  it("enforces disjoint write-scope leases and auto-unblocks DAG dependents", () => {
    const db = new ControlPlaneDb(":memory:");
    const run = db.createRun({ goal: "Build auth + billing", repoRoot: "/tmp/repo", baseBranch: "main", baseSha: "abc" });
    const orch = db.createTask({
      runId: run.id,
      tier: 1,
      kind: "orchestrator",
      title: "Orch",
      objective: "Manage",
      readOnly: true,
      profileId: "acp:claude",
    });

    const w1 = db.createTask({
      runId: run.id,
      parentId: orch.id,
      tier: 2,
      kind: "worker",
      title: "Auth",
      objective: "Build auth",
      profileId: "acp:claude",
      writeScopes: ["src/auth/**"],
    });

    // Overlapping write scope must be rejected
    assert.throws(
      () =>
        db.createTask({
          runId: run.id,
          parentId: orch.id,
          tier: 2,
          kind: "worker",
          title: "Auth Overlap",
          objective: "Touch login",
          profileId: "acp:codex",
          writeScopes: ["src/auth/login.ts"],
        }),
      /Write-scope conflict/,
    );

    // Dependent task starts pending and unblocks when w1 completes
    const w2 = db.createTask({
      runId: run.id,
      parentId: orch.id,
      tier: 2,
      kind: "worker",
      title: "Billing",
      objective: "Uses auth",
      profileId: "acp:codex",
      writeScopes: ["src/billing/**"],
      dependsOn: [w1.id],
    });
    assert.equal(w2.status, "pending");

    db.updateTask(w1.id, { status: "completed", summary: "Auth done" });
    assert.equal(db.getTask(w2.id)?.status, "ready");

    // Lease released after w1 completed — new worker can now lease src/auth/**
    const w3 = db.createTask({
      runId: run.id,
      parentId: orch.id,
      tier: 2,
      kind: "worker",
      title: "Auth follow-up",
      objective: "Polish",
      profileId: "acp:claude",
      writeScopes: ["src/auth/**"],
    });
    assert.equal(w3.status, "ready");
    db.close();
  });

  it("enforces scope_too_large send-back guardrails, settlement gates, and Clean Relay rollover + Seance", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-state-"));
    try {
      const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir });
      const db = new ControlPlaneDb(":memory:");
      const quota = new QuotaClient();
      const catalog = new ModelCatalogCompiler(config, quota);

      let orchRuns = 0;
      const orch = new HarnessOrchestrator(db, config, catalog, quota, () => ({
        run: async (req) => {
          if (req.tier === 1) {
            orchRuns++;
            if (orchRuns === 1) {
              // Gen 1: record an architectural rationale event and trigger clean rollover
              await req.executeTool("blackboard_set", { key: "api_style", value: "ProtoJSON" });
              await req.executeTool("request_rollover", {
                goal_invariants: ["Preserve zero-compaction Task Agents"],
                architectural_decisions: [{ decision: "Use SQLite WAL", rationale: "Crash-safe single-host state" }],
                next_actions: ["Spawn worker"],
              });
              return { text: "Rolling over", stopReason: "rollover_requested" };
            }
            // Gen 2: verify Seance predecessor query finds Gen 1 blackboard decision!
            const seance = (await req.executeTool("query_predecessor", { query: "api_style" })) as {
              matchingEvents: unknown[];
            };
            assert.ok(seance.matchingEvents.length >= 1, "Seance must find predecessor generation events");
            return { text: "Gen 2 done", stopReason: "completed" };
          }
          return { text: "Child done", stopReason: "completed" };
        },
      }));

      const { run, orchestratorTask } = await orch.startRun({ goal: "Test rollover", repoRoot });

      // Wait for Gen 1 -> Gen 2 rollover and completion
      for (let i = 0; i < 40; i++) {
        const t = db.getTask(orchestratorTask.id)!;
        if (t.status === "completed") break;
        await new Promise((r) => setTimeout(r, 25));
      }

      const finalOrch = db.getTask(orchestratorTask.id)!;
      assert.equal(finalOrch.generation, 2);
      assert.equal(finalOrch.status, "completed");

      // Create a Tier 3 task and test scope_too_large send-back with < 2 splits (accepted with splitsMissing: true)
      const oneSplitChild = db.createTask({
        runId: run.id,
        parentId: orchestratorTask.id,
        tier: 3,
        kind: "execute",
        title: "One-split task",
        objective: "Rewrite entire compiler",
        profileId: "acp:claude",
      });

      const oneSplitRes = (await orch.toolExecutor.execute(run.id, oneSplitChild.id, "return_task", {
        status: "scope_too_large",
        summary: "Too big",
        evidence_paths: ["src/compiler.ts"],
        suggested_splits: ["only one"],
      })) as { status: string; escalationId: string; splitsMissing?: boolean };

      assert.equal(oneSplitRes.status, "returned_for_rescope");
      assert.equal(oneSplitRes.splitsMissing, true);
      assert.equal(db.getTask(oneSplitChild.id)?.status, "returned_for_rescope");

      // Accepted cleanly when evidence + >= 2 splits provided (no splitsMissing)
      const child = db.createTask({
        runId: run.id,
        parentId: orchestratorTask.id,
        tier: 3,
        kind: "execute",
        title: "Too big task",
        objective: "Rewrite entire compiler",
        profileId: "acp:claude",
      });

      const res = (await orch.toolExecutor.execute(run.id, child.id, "return_task", {
        status: "scope_too_large",
        summary: "Spans parser and codegen",
        evidence_paths: ["src/parser.ts", "src/codegen.ts"],
        suggested_splits: ["Refactor parser AST", "Update codegen emitter"],
      })) as { status: string; escalationId: string; splitsMissing?: boolean };

      assert.equal(res.status, "returned_for_rescope");
      assert.equal(res.splitsMissing, undefined);
      assert.equal(db.getTask(child.id)?.status, "returned_for_rescope");
      const esc = db.getEscalation(res.escalationId)!;
      assert.equal(esc.category, "scope_too_large");
      assert.equal(esc.suggestedSplits.length, 2);

      // Settlement gate: Tier 2 cannot complete while a Tier 3 child is still running
      const worker = db.createTask({
        runId: run.id,
        parentId: orchestratorTask.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Feature",
        profileId: "acp:claude",
      });
      const sub = db.createTask({
        runId: run.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Sub",
        objective: "Explore",
        readOnly: true,
        profileId: "acp:claude",
      });
      db.updateTask(sub.id, { status: "running" });

      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, worker.id, "return_task", {
            status: "completed",
            summary: "Done early",
          }),
        /harness blocked: settlement-/,
      );

      db.close();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("query_predecessor matches multi-word phrases across token deltas and past 2,000 delta rows (Gen 2+)", async () => {
    const repoRoot = await makeTempGitRepo();
    const db = new ControlPlaneDb(":memory:");
    try {
      const config = withFixtureCatalog({ ...loadConfig(repoRoot), codeMode: "off" });
      const quota = new QuotaClient();
      const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota);
      const run = db.createRun({ goal: "Seance coalescing", repoRoot, baseBranch: "main", baseSha: "abc" });
      const task = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "acp:claude",
      });

      // Emit 2,200 early filler text deltas (simulating heavy Gen 1 streaming past old 2,000-row cap)
      for (let i = 0; i < 2200; i++) {
        db.emitEvent(run.id, task.id, "agent.text_delta", { text: `filler-${i} ` });
      }
      // Non-delta boundary (rollover into Gen 2)
      db.emitEvent(run.id, task.id, "agent.rollover", { fromGen: 1, toGen: 2 });

      // Earlier Gen 2 turn mentioning only one token ("retry")
      db.emitEvent(run.id, task.id, "agent.text_delta", { text: "Single token mention of retry only." });
      db.emitEvent(run.id, task.id, "agent.tool", { id: "c1", name: "tree_view", status: "completed" });

      // Later Gen 2 turn splitting "retry backoff" across 3 consecutive token deltas with surrounding padding > 500 chars
      const pad = "x".repeat(300);
      db.emitEvent(run.id, task.id, "agent.text_delta", { text: `${pad} We chose exponential re` });
      db.emitEvent(run.id, task.id, "agent.text_delta", { text: "try back" });
      db.emitEvent(run.id, task.id, "agent.text_delta", { text: `off with jitter for 429s ${pad}` });

      const res = (await orch.toolExecutor.execute(run.id, task.id, "query_predecessor", {
        query: "retry backoff",
      })) as { matchingEvents: Array<{ seq: number; type: string; snippet: string; createdAt: number }> };

      assert.ok(res.matchingEvents.length >= 2);
      // Full two-token match ranks first, matches across chunk boundaries, and snippet is bounded <= 400 chars
      const top = res.matchingEvents[0]!;
      assert.equal(top.type, "agent.text");
      assert.match(top.snippet, /retry backoff with jitter/i);
      assert.ok(top.snippet.length <= 400, `snippet should be <= 400 chars, got ${top.snippet.length}`);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("artifact_read paginates large dossiers with offset and max_chars", async () => {
    const repoRoot = await makeTempGitRepo();
    const db = new ControlPlaneDb(":memory:");
    try {
      const config = withFixtureCatalog({ ...loadConfig(repoRoot), codeMode: "off" });
      const quota = new QuotaClient();
      const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota);
      const run = db.createRun({ goal: "Pagination", repoRoot, baseBranch: "main", baseSha: "abc" });
      const task = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Read dossiers",
        readOnly: true,
        profileId: "acp:claude",
      });

      const payload = Array.from({ length: 25 }, (_, i) => `CHUNK-${String(i).padStart(2, "0")}-Z`).join(""); // 250 chars
      assert.equal(payload.length, 250);
      const written = (await orch.toolExecutor.execute(run.id, task.id, "artifact_write", {
        name: "large.txt",
        summary: "Large dossier",
        content: payload,
      })) as { path: string };

      const p1 = (await orch.toolExecutor.execute(run.id, task.id, "artifact_read", {
        path: written.path,
        max_chars: 100,
      })) as { path: string; offset: number; totalChars: number; truncated: boolean; hasMore: boolean; content: string };
      assert.equal(p1.offset, 0);
      assert.equal(p1.totalChars, 250);
      assert.equal(p1.truncated, true);
      assert.equal(p1.hasMore, true);
      assert.equal(p1.content, payload.slice(0, 100));

      const p2 = (await orch.toolExecutor.execute(run.id, task.id, "artifact_read", {
        path: written.path,
        max_chars: 100,
        offset: 100,
      })) as typeof p1;
      assert.equal(p2.offset, 100);
      assert.equal(p2.totalChars, 250);
      assert.equal(p2.truncated, true);
      assert.equal(p2.hasMore, true);
      assert.equal(p2.content, payload.slice(100, 200));

      const p3 = (await orch.toolExecutor.execute(run.id, task.id, "artifact_read", {
        path: written.path,
        max_chars: 100,
        offset: 200,
      })) as typeof p1;
      assert.equal(p3.offset, 200);
      assert.equal(p3.totalChars, 250);
      assert.equal(p3.truncated, false);
      assert.equal(p3.hasMore, false);
      assert.equal(p3.content, payload.slice(200));
      assert.equal(p1.content + p2.content + p3.content, payload);

      // Negative offset clamps to 0
      const neg = (await orch.toolExecutor.execute(run.id, task.id, "artifact_read", {
        path: written.path,
        max_chars: 10,
        offset: -50,
      })) as typeof p1;
      assert.equal(neg.offset, 0);
      assert.equal(neg.content, payload.slice(0, 10));
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("buildHydrationTurn keeps active/failed tasks, caps older settled tasks and Blackboard values, and renders peer/message sections", () => {
    const mkTask = (id: string, status: TaskRecord["status"], updatedAt: number): TaskRecord => ({
      id,
      runId: "run-1",
      parentId: "t-1",
      tier: 2,
      kind: "worker",
      title: `Task ${id}`,
      objective: "Work",
      criteria: "",
      readOnly: false,
      profileId: "acp:claude",
      model: "claude/opus",
      effort: "medium",
      status,
      generation: 1,
      maxTurns: 40,
      turnsUsed: 0,
      contextUsed: 0,
      contextSize: 0,
      worktreeId: null,
      sessionId: null,
      summary: null,
      handoffJson: null,
      resultJson: null,
      createdAt: updatedAt - 10,
      updatedAt,
    });

    const orchTask = { ...mkTask("t-1", "running", 1000), parentId: null, tier: 1 as const, kind: "orchestrator" as const, readOnly: true };
    const settled = Array.from({ length: 12 }, (_, i) =>
      mkTask(`t-settled-${i + 1}`, i % 2 === 0 ? "completed" : "cancelled", 100 + i * 10),
    );
    const activeRunning = mkTask("t-live", "running", 50);
    const failedTask = mkTask("t-fail", "failed", 40);
    const blockedTask = mkTask("t-block", "blocked", 30);

    const openPeerRequests: PeerExchangeRecord[] = [
      {
        id: "preq-1",
        fromRunId: "run-2",
        toRunId: "run-1",
        kind: "request",
        topicKey: "api-v2",
        round: 1,
        message: "Freeze schema v2?",
        reply: null,
        status: "open",
        createdAt: 500,
        answeredAt: null,
      },
    ];
    const answeredMessages: MessageRecord[] = [
      {
        id: "msg-1",
        runId: "run-1",
        fromTaskId: "t-1",
        toTaskId: "t-live",
        question: "Ready to merge?",
        answer: "Tests pass, submitting now.",
        status: "answered",
        createdAt: 400,
        answeredAt: 450,
      },
    ];

    const bigContract = "B".repeat(1200);
    const prompt = buildHydrationTurn({
      task: orchTask,
      tasksSnapshot: [orchTask, ...settled, activeRunning, failedTask, blockedTask],
      artifacts: [],
      openEscalations: [],
      blackboard: {
        small_key: { value: { ok: true }, authorTaskId: "t-1" },
        huge_contract: { value: bigContract, authorTaskId: "t-1" },
      },
      openPeerRequests,
      answeredMessages,
    });

    // All active/failed/blocked tasks kept
    assert.ok(prompt.includes("t-live"));
    assert.ok(prompt.includes("t-fail"));
    assert.ok(prompt.includes("t-block"));
    // 8 most recent settled tasks (5..12) kept; 4 oldest (1..4) omitted with 1-line pointer
    for (let i = 5; i <= 12; i++) assert.ok(prompt.includes(`t-settled-${i}`), `expected t-settled-${i}`);
    for (let i = 1; i <= 4; i++) assert.ok(!prompt.includes(`t-settled-${i} `), `expected t-settled-${i} to be omitted`);
    assert.ok(prompt.includes("... and 4 older settled tasks (use `tree_view` or `task_get` for details)"));

    // Blackboard entry bounded to 500 chars with blackboard_get hint
    assert.ok(prompt.includes("small_key: {\"ok\":true}"));
    assert.ok(!prompt.includes(bigContract), "huge Blackboard value must be truncated");
    assert.match(prompt, /huge_contract:.*blackboard_get/);

    // Peer request and answered message sections rendered
    assert.match(prompt, /Open Cross-Run Peer Requests/);
    assert.ok(prompt.includes("preq-1"));
    assert.match(prompt, /Answered Peer Messages/);
    assert.ok(prompt.includes("msg-1"));
    assert.ok(!prompt.includes("Recently resolved escalations (human or Director answers)"));

    // Recently resolved escalations render next to open escalations without disturbing them
    const openEsc: EscalationRecord = {
      id: "esc-open-1",
      runId: "run-1",
      fromTaskId: "t-block",
      toTaskId: "t-1",
      severity: "P1",
      category: "blocked_dependency",
      title: "Waiting on API key",
      evidencePaths: ["src/api.ts"],
      attempted: [],
      suggestedSplits: [],
      blocking: true,
      status: "open",
      resolution: null,
      createdAt: 410,
      ackedAt: null,
    };
    const longAnswer = "A".repeat(600);
    const resolvedEscs: Array<RecentlyResolvedEscalation | EscalationRecord> = [
      {
        id: "esc-42",
        fromTaskId: "t-live",
        severity: "P0",
        category: "ambiguous_spec",
        title: "Need DB choice",
        resolution: "Use SQLite for local state.",
        resolvedAt: 520,
      },
      {
        id: "esc-43",
        fromTaskId: "t-live",
        severity: "P2",
        category: "code_defect",
        title: "Long guidance",
        resolution: longAnswer,
        resolvedAt: 510,
      },
      {
        ...openEsc,
        id: "esc-blank",
        status: "resolved",
        resolution: null,
        ackedAt: 505,
      },
    ];
    const promptWithEscalations = buildHydrationTurn({
      task: orchTask,
      tasksSnapshot: [orchTask, activeRunning],
      artifacts: [],
      openEscalations: [openEsc],
      recentlyResolvedEscalations: resolvedEscs,
      blackboard: {},
    });
    const openIdx = promptWithEscalations.indexOf("## Open Escalations / Scope Send-Backs");
    const resolvedIdx = promptWithEscalations.indexOf("## Recently resolved escalations (human or Director answers)");
    assert.ok(openIdx >= 0, "expected open escalations heading");
    assert.ok(resolvedIdx > openIdx, "expected recently resolved section right after open escalations");
    assert.ok(promptWithEscalations.includes("- [P1/blocked_dependency] esc-open-1 from t-block: Waiting on API key"));
    assert.ok(
      promptWithEscalations.includes("- [P0/ambiguous_spec] esc-42 from t-live: Need DB choice -> Use SQLite for local state."),
    );
    assert.ok(promptWithEscalations.includes(`- [P2/code_defect] esc-43 from t-live: Long guidance -> ${"A".repeat(500)}`));
    assert.ok(!promptWithEscalations.includes(longAnswer), "resolution text over 500 chars must be truncated");
    assert.ok(!promptWithEscalations.includes("esc-blank"), "resolved escalation without resolution text must be omitted");
  });

  it("wires tree_view inbox, repo-scoped KB lifecycle tools with HEAD SHA, and multi-hour telemetry past 400 events", async () => {
    const repoRoot = await makeTempGitRepo();
    const otherRepo = await makeTempGitRepo();
    const db = new ControlPlaneDb(":memory:");
    try {
      const headSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const config = withFixtureCatalog({ ...loadConfig(repoRoot), codeMode: "off" });
      const quota = new QuotaClient();
      const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota);
      const run = db.createRun({
        goal: "Inbox + KB + Telemetry",
        repoRoot,
        baseBranch: "main",
        baseSha: "stale-base-sha",
        coordinationGroup: "grp-1",
      });
      const peerRun = db.createRun({
        goal: "Peer",
        repoRoot,
        baseBranch: "dev",
        baseSha: "stale-base-sha",
        coordinationGroup: "grp-1",
      });
      const t1 = db.createTask({ runId: run.id, tier: 1, kind: "orchestrator", title: "Orch", objective: "Coord", readOnly: true, profileId: "acp:claude" });
      const t2 = db.createTask({ runId: run.id, parentId: t1.id, tier: 2, kind: "worker", title: "Worker", objective: "Work", profileId: "acp:claude" });

      // Answered message + open peer request appear in Tier 1 tree_view
      const msg = db.createMessage(run.id, t1.id, t2.id, "Need schema?");
      db.replyMessage(msg.id, "Yes, v2");
      db.createPeerRequest({ fromRunId: peerRun.id, toRunId: run.id, topicKey: "schema", message: "Align v2?" });
      const tv = (await orch.toolExecutor.execute(run.id, t1.id, "tree_view", {})) as {
        openEscalations: EscalationRecord[];
        recentlyResolvedEscalations?: RecentlyResolvedEscalation[];
        answeredMessages?: MessageRecord[];
        openPeerRequests?: PeerExchangeRecord[];
      };
      assert.equal(tv.answeredMessages?.length, 1);
      assert.equal(tv.answeredMessages?.[0]?.id, msg.id);
      assert.equal(tv.openPeerRequests?.length, 1);
      assert.equal(tv.recentlyResolvedEscalations, undefined);

      // Recently resolved escalations: newest-first by acked_at, limit enforced, open/acked/empty-resolution excluded
      const escA = db.createEscalation({
        runId: run.id,
        fromTaskId: t2.id,
        toTaskId: null,
        severity: "P0",
        category: "ambiguous_spec",
        title: "Storage backend",
        evidencePaths: ["src/db.ts"],
      });
      const escB = db.createEscalation({
        runId: run.id,
        fromTaskId: t2.id,
        toTaskId: t1.id,
        severity: "P1",
        category: "interface_conflict",
        title: "RPC payload",
        evidencePaths: ["src/rpc.ts"],
      });
      const escC = db.createEscalation({
        runId: run.id,
        fromTaskId: t2.id,
        toTaskId: t1.id,
        severity: "P2",
        category: "code_defect",
        title: "Retry backoff",
        evidencePaths: ["src/retry.ts"],
      });
      const escEmpty = db.createEscalation({
        runId: run.id,
        fromTaskId: t2.id,
        toTaskId: t1.id,
        severity: "P2",
        category: "code_defect",
        title: "Blank auto-resolved",
        evidencePaths: ["src/a.ts"],
      });
      const escNull = db.createEscalation({
        runId: run.id,
        fromTaskId: t2.id,
        toTaskId: t1.id,
        severity: "P2",
        category: "code_defect",
        title: "Null auto-resolved",
        evidencePaths: ["src/b.ts"],
      });
      const escAcked = db.createEscalation({
        runId: run.id,
        fromTaskId: t2.id,
        toTaskId: t1.id,
        severity: "P1",
        category: "blocked_dependency",
        title: "Still acked only",
        evidencePaths: ["src/c.ts"],
      });
      const escOpen = db.createEscalation({
        runId: run.id,
        fromTaskId: t2.id,
        toTaskId: t1.id,
        severity: "P1",
        category: "broken_test",
        title: "Still open",
        evidencePaths: ["test/x.test.ts"],
      });
      // Another run's resolved escalation must not leak into this run
      const peerT1 = db.createTask({
        runId: peerRun.id,
        tier: 1,
        kind: "orchestrator",
        title: "Peer Orch",
        objective: "Coord",
        readOnly: true,
        profileId: "acp:claude",
      });
      const peerEsc = db.createEscalation({
        runId: peerRun.id,
        fromTaskId: peerT1.id,
        toTaskId: null,
        severity: "P0",
        category: "ambiguous_spec",
        title: "Peer decision",
        evidencePaths: ["README.md"],
      });
      db.tryResolveEscalation(peerEsc.id, "Peer answer");

      db.tryResolveEscalation(escB.id, "Use v2 payload");
      db.tryResolveEscalation(escC.id, "Cap backoff at 5s");
      db.tryResolveEscalation(escA.id, "Use SQLite");
      db.tryResolveEscalation(escEmpty.id, "   ");
      db.db.prepare("UPDATE escalations SET status = 'resolved', resolution = NULL, acked_at = 4000 WHERE id = ?").run(escNull.id);
      db.db.prepare("UPDATE escalations SET acked_at = 1000 WHERE id = ?").run(escB.id);
      db.db.prepare("UPDATE escalations SET acked_at = 2000 WHERE id = ?").run(escC.id);
      db.db.prepare("UPDATE escalations SET acked_at = 3000 WHERE id = ?").run(escA.id);
      db.ackEscalation(escAcked.id, "Acknowledged, investigating", false);

      assert.deepEqual(db.listRecentlyResolvedEscalations(run.id, 0), []);
      const limited = db.listRecentlyResolvedEscalations(run.id, 2);
      assert.deepEqual(limited, [
        {
          id: escA.id,
          fromTaskId: t2.id,
          severity: "P0",
          category: "ambiguous_spec",
          title: "Storage backend",
          resolution: "Use SQLite",
          resolvedAt: 3000,
        },
        {
          id: escC.id,
          fromTaskId: t2.id,
          severity: "P2",
          category: "code_defect",
          title: "Retry backoff",
          resolution: "Cap backoff at 5s",
          resolvedAt: 2000,
        },
      ]);

      const tvWithResolved = (await orch.toolExecutor.execute(run.id, t1.id, "tree_view", {})) as {
        openEscalations: EscalationRecord[];
        recentlyResolvedEscalations?: RecentlyResolvedEscalation[];
      };
      assert.deepEqual(tvWithResolved.openEscalations.map((e) => e.id), [escOpen.id]);
      assert.deepEqual(tvWithResolved.recentlyResolvedEscalations?.map((e) => e.id), [escA.id, escC.id, escB.id]);
      assert.equal(tvWithResolved.recentlyResolvedEscalations?.[0]?.resolution, "Use SQLite");
      assert.equal(tvWithResolved.recentlyResolvedEscalations?.[0]?.resolvedAt, 3000);

      // KB propose resolves current HEAD SHA instead of stale baseSha
      const proposed = (await orch.toolExecutor.execute(run.id, t1.id, "kb_propose", {
        kind: "invariant",
        title: "WAL required",
        summary: "Always enable WAL mode",
        context_md: "SQLite runs in WAL mode for concurrent daemon reads.",
        evidence_paths: ["src/control-plane/db.ts"],
      })) as { id: string; status: string };
      assert.equal(db.kb.getRaw(proposed.id)?.verifiedSha, headSha);

      // kb_promote and kb_archive work in same repo, and cross-repo mutations are rejected
      const promoted = (await orch.toolExecutor.execute(run.id, t1.id, "kb_promote", { id: proposed.id })) as { status: string };
      assert.equal(promoted.status, "active");
      const archived = (await orch.toolExecutor.execute(run.id, t1.id, "kb_archive", { id: proposed.id, reason: "Replaced" })) as { status: string };
      assert.equal(archived.status, "archived");

      const foreignKb = db.kb.propose({
        repoScope: otherRepo,
        kind: "decision",
        title: "Foreign",
        summary: "Other repo entry",
        contextMd: "Scoped elsewhere",
        evidencePaths: [],
      });
      await assert.rejects(() => orch.toolExecutor.execute(run.id, t1.id, "kb_flag_stale", { id: foreignKb.id, reason: "nope" }), /not found in repository scope/);
      await assert.rejects(() => orch.toolExecutor.execute(run.id, t1.id, "kb_promote", { id: foreignKb.id }), /not found in repository scope/);
      await assert.rejects(() => orch.toolExecutor.execute(run.id, t1.id, "kb_archive", { id: foreignKb.id }), /not found in repository scope/);

      // Telemetry remains accurate past 450 tool events + 1,000 text deltas
      db.updateTask(t2.id, { status: "running" });
      for (let i = 0; i < 450; i++) {
        db.emitEvent(run.id, t2.id, "agent.tool", { id: `call-${i}`, name: "read", status: "completed", title: `Read #${i}` });
      }
      for (let i = 0; i < 1000; i++) {
        db.emitEvent(run.id, t2.id, "agent.text_delta", { text: "tok " });
      }
      const summary = buildRunActivitySummary(db, run.id);
      const snap = summary.tasks.find((t) => t.id === t2.id)!;
      assert.equal(snap.toolCalls, 450);
      assert.equal(snap.currentAction, "✓ Read #449");
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(otherRepo, { recursive: true, force: true });
    }
  });

  it("settles Tier 2 worker with external_deliverable without merging into base branch while preserving safety gates", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-ext-deliv-"));
    const db = new ControlPlaneDb(":memory:");
    try {
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, codeMode: "off" });
      const quota = new QuotaClient();
      const catalog = new ModelCatalogCompiler(config, quota);
      const orch = new HarnessOrchestrator(db, config, catalog, quota, () => ({
        run: async () => ({ text: "ok", stopReason: "completed" }),
      }));

      // Tool schema exposes external_deliverable only to workers.
      const workerReturnTool = toolsForRole("worker").find((t) => t.name === "return_task");
      assert.ok(
        (workerReturnTool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.external_deliverable,
        "worker return_task schema must expose external_deliverable",
      );
      for (const role of ["execute", "research", "plan", "verify"] as const) {
        const tool = toolsForRole(role).find((t) => t.name === "return_task");
        assert.equal(
          (tool?.inputSchema as { properties?: Record<string, unknown> })?.properties?.external_deliverable,
          undefined,
          `${role} return_task schema must not expose external_deliverable`,
        );
      }

      const run = db.createRun({ goal: "External deliverable settlement", repoRoot, baseBranch: "main", baseSha });
      const orchTask = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        profileId: "pi:local",
      });
      const worker = db.createTask({
        runId: run.id,
        parentId: orchTask.id,
        tier: 2,
        kind: "worker",
        title: "External worker",
        objective: "Push report to external remote",
        readOnly: false,
        writeScopes: ["report.md"],
        profileId: "pi:local",
      });
      db.updateTask(worker.id, { status: "running" });

      const wtMgr = orch.getWorktreeManager(repoRoot);
      const wt = await wtMgr.createForWorker(run.id, worker.id, baseSha);
      db.updateTask(worker.id, { worktreeId: wt.id });

      // Commit work in the worker worktree without merging into base branch.
      writeFileSync(join(wt.path, "report.md"), "# Report v1\n", "utf8");
      await runGit(wt.path, ["add", "report.md"]);
      await runGit(wt.path, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "Add report v1"]);
      const commit1 = (await runGit(wt.path, ["rev-parse", "HEAD"])).stdout;

      writeFileSync(join(wt.path, "report.md"), "# Report v2\n", "utf8");
      await runGit(wt.path, ["add", "report.md"]);
      await runGit(wt.path, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "Refine report v2"]);
      const commit2 = (await runGit(wt.path, ["rev-parse", "HEAD"])).stdout;

      // 1. Without external_deliverable: still rejected with settlement-unmerged and rejection text mentions external_deliverable.
      await assert.rejects(
        () => orch.toolExecutor.execute(run.id, worker.id, "return_task", { status: "completed", summary: "Done" }),
        (err: unknown) => {
          assert.ok(err instanceof HarnessRejection, `expected HarnessRejection, got ${String(err)}`);
          assert.equal(err.notice.rule, "settlement-unmerged");
          assert.ok(
            err.message.includes("external_deliverable"),
            `settlement-unmerged message should mention external_deliverable: ${err.message}`,
          );
          return true;
        },
      );
      assert.equal(db.getTask(worker.id)?.status, "running");

      // 2. Dirty worktree with external_deliverable: still rejected with settlement-dirty-worktree.
      writeFileSync(join(wt.path, "report.md"), "# Report dirty\n", "utf8");
      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, worker.id, "return_task", {
            status: "completed",
            summary: "Done",
            external_deliverable: { ref: "origin-ext/feature-x" },
          }),
        (err: unknown) => {
          assert.ok(err instanceof HarnessRejection);
          assert.equal(err.notice.rule, "settlement-dirty-worktree");
          return true;
        },
      );
      assert.equal(db.getTask(worker.id)?.status, "running");
      await runGit(wt.path, ["checkout", "--", "report.md"]);

      // 3. Blank ref, non-worker callers, and non-completed statuses are rejected with informative errors.
      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, worker.id, "return_task", {
            status: "completed",
            summary: "Done",
            external_deliverable: { ref: "   " },
          }),
        /non-empty string ref/,
      );
      for (const badStatus of ["blocked", "scope_too_large"] as const) {
        await assert.rejects(
          () =>
            orch.toolExecutor.execute(run.id, worker.id, "return_task", {
              status: badStatus,
              summary: `Cannot finish (${badStatus})`,
              external_deliverable: { ref: "origin-ext/feature-x" },
            }),
          /only supported with status 'completed'/,
        );
      }
      assert.throws(
        () =>
          validateTaskHandoff("worker", {
            summary: "Missing status with external deliverable",
            external_deliverable: { ref: "origin-ext/feature-x" },
          }),
        (err: unknown) => {
          assert.ok(err instanceof HarnessRejection, `expected HarnessRejection, got ${String(err)}`);
          assert.equal(err.notice.rule, "handoff-external-deliverable");
          assert.ok(
            countWords(err.notice) <= WORD_BUDGET,
            `missing-status rejection exceeded ${WORD_BUDGET}-word budget: ${countWords(err.notice)}`,
          );
          assert.match(err.message, /only supported with status 'completed'/);
          assert.match(err.message, /missing/);
          return true;
        },
      );
      assert.throws(
        () =>
          validateTaskHandoff("worker", {
            status: "blocked",
            summary: "Blocked with external deliverable",
            external_deliverable: { ref: "origin-ext/feature-x" },
          }),
        (err: unknown) => {
          assert.ok(err instanceof HarnessRejection);
          assert.equal(err.notice.rule, "handoff-external-deliverable");
          assert.match(err.message, /only supported with status 'completed'/);
          return true;
        },
      );
      assert.deepEqual(
        validateTaskHandoff("worker", {
          status: "completed",
          summary: "Completed with external deliverable",
          external_deliverable: { ref: "origin-ext/feature-x" },
        }).externalDeliverable,
        { ref: "origin-ext/feature-x" },
      );
      assert.equal(db.getTask(worker.id)?.status, "running");
      const t3 = db.createTask({
        runId: run.id,
        parentId: worker.id,
        tier: 3,
        kind: "execute",
        title: "Subtask",
        objective: "Helper",
        readOnly: false,
        profileId: "pi:local",
      });
      db.updateTask(t3.id, { status: "running" });
      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, t3.id, "return_task", {
            status: "completed",
            summary: "Subtask done",
            external_deliverable: { ref: "origin-ext/feature-x" },
          }),
        /only supported for Tier 2 workers/,
      );
      db.updateTask(t3.id, { status: "completed" });

      // 4. Queued/in-flight merge-queue item still rejects even with external_deliverable,
      // and instructs the worker to wait for the existing merge (not re-submit or retry external_deliverable).
      const queuedWorker = db.createTask({
        runId: run.id,
        parentId: orchTask.id,
        tier: 2,
        kind: "worker",
        title: "Queued worker",
        objective: "Queued merge",
        readOnly: false,
        writeScopes: ["other.md"],
        profileId: "pi:local",
      });
      db.updateTask(queuedWorker.id, { status: "running" });
      const queuedWt = await wtMgr.createForWorker(run.id, queuedWorker.id, baseSha);
      db.updateTask(queuedWorker.id, { worktreeId: queuedWt.id });
      const mqItem = db.enqueueMerge({ runId: run.id, taskId: queuedWorker.id, worktreeId: queuedWt.id, branch: queuedWt.branch });
      db.updateTask(queuedWorker.id, { status: "running" });
      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, queuedWorker.id, "return_task", {
            status: "completed",
            summary: "Try external while queued",
            external_deliverable: { ref: "origin-ext/queued" },
          }),
        (err: unknown) => {
          assert.ok(err instanceof HarnessRejection);
          assert.equal(err.notice.rule, "settlement-unmerged");
          assert.ok(
            countWords(err.notice) <= WORD_BUDGET,
            `merge-in-flight rejection exceeded ${WORD_BUDGET}-word budget: ${countWords(err.notice)}`,
          );
          assert.match(err.message, /^\[harness blocked: settlement-unmerged\] .+ Why: .+ Allowed: .+$/);
          assert.ok(err.message.toLowerCase().includes("wait"), `expected wait guidance, got: ${err.message}`);
          assert.ok(err.message.includes("worktree_status"), `expected worktree_status guidance, got: ${err.message}`);
          assert.ok(!err.message.includes("submit_for_merge"), `must not suggest submit_for_merge: ${err.message}`);
          assert.ok(!err.message.includes("external_deliverable"), `must not suggest external_deliverable: ${err.message}`);
          return true;
        },
      );
      // Clean up the queued worker's merge item from this run before testing clean empty merge queue on main worker.
      db.db.prepare("DELETE FROM merge_queue WHERE id = ?").run(mqItem.id);
      db.updateTask(queuedWorker.id, { status: "cancelled" });

      // 5. Bounced worktree status is allowed with external_deliverable; settle the worker with external_deliverable.
      db.updateWorktree(wt.id, { status: "bounced" });
      const res = (await orch.toolExecutor.execute(run.id, worker.id, "return_task", {
        status: "completed",
        summary: "Pushed feature branch to external remote",
        external_deliverable: {
          ref: "origin-ext/feature-x",
          sha: commit2,
          note: "Fork-only report branch",
        },
      })) as { returned: boolean; status: string };

      assert.equal(res.returned, true);
      assert.equal(res.status, "completed");

      const settledWorker = db.getTask(worker.id)!;
      assert.equal(settledWorker.status, "completed");
      const parsedResult = JSON.parse(settledWorker.resultJson ?? "{}") as {
        external_deliverable?: {
          ref: string;
          sha?: string;
          note?: string;
          worktree_head: string | null;
          unmerged_commits: string[];
        };
      };
      assert.deepEqual(parsedResult.external_deliverable, {
        ref: "origin-ext/feature-x",
        sha: commit2,
        note: "Fork-only report branch",
        worktree_head: commit2,
        unmerged_commits: [commit2, commit1],
      });

      // Base branch is untouched, merge queue is empty, and unmerged worktree is kept (not torn down).
      const mainAfter = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;
      assert.equal(mainAfter, baseSha);
      assert.equal(db.listMergeQueue({ runId: run.id }).length, 0);
      assert.equal(db.getWorktree(wt.id)?.cleanedAt, null);

      // Compact handoff and goal_get task rows both expose external_deliverable / externalDeliverable.
      const handoff = compactTaskHandoff(settledWorker);
      assert.deepEqual(handoff.external_deliverable, parsedResult.external_deliverable);

      const goalGet = buildGoalGetResult(
        {
          goal: {
            id: "goal-29",
            chatSessionId: "chat-1",
            repoRoot,
            version: 1,
            title: "External deliverable",
            description: "Deliver to external remote",
            criteria: [],
            nonGoals: [],
            budgets: { maxReviewCycles: 5, maxNoProgressCycles: 3 },
            verificationMode: "auto",
            verifyRef: "main",
            liveProgress: null,
            status: "executing",
            linkedRunId: run.id,
            reviewCycle: 0,
            noProgressStreak: 0,
            lastProgressFingerprint: null,
            lastReviewSummary: null,
            createdAt: 1_000,
            updatedAt: 2_000,
          },
          reviews: [],
          tasks: [settledWorker],
          openEscalations: [],
          activity: null,
        },
        parseGoalGetOptions({ sections: ["run"] }),
        { evidenceDir: null, repoRoot },
      ) as { tasks?: Array<{ id: string; externalDeliverable?: unknown }> };
      assert.deepEqual(goalGet.tasks?.[0]?.externalDeliverable, parsedResult.external_deliverable);

      // 6. Merged worktree followed by a new unmerged commit settled via external_deliverable:
      // HEAD must stay reachable through immediate finally-block teardown AND later wtMgr.sweep().
      const mergedWorker = db.createTask({
        runId: run.id,
        parentId: orchTask.id,
        tier: 2,
        kind: "worker",
        title: "Merged then external worker",
        objective: "Merge fix then commit report externally",
        readOnly: false,
        writeScopes: ["merged-part.md", "post-merge-report.md"],
        profileId: "pi:local",
      });
      db.updateTask(mergedWorker.id, { status: "running" });
      const mergedWt = await wtMgr.createForWorker(run.id, mergedWorker.id, baseSha);
      db.updateTask(mergedWorker.id, { worktreeId: mergedWt.id });

      // Merge an initial commit into main via submit_for_merge (leaving live worker running and worktree status = 'merged').
      writeFileSync(join(mergedWt.path, "merged-part.md"), "# Merged change\n", "utf8");
      await runGit(mergedWt.path, ["add", "merged-part.md"]);
      await runGit(mergedWt.path, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "Merged change"]);
      const mergeRes = (await orch.toolExecutor.execute(run.id, mergedWorker.id, "submit_for_merge", {
        summary: "Merged change",
      })) as { status: string; mergedSha?: string };
      assert.equal(mergeRes.status, "merged");
      assert.equal(db.getWorktree(mergedWt.id)?.status, "merged");
      assert.equal(db.getTask(mergedWorker.id)?.status, "running");

      // Worker commits additional work after merge and settles via external_deliverable.
      writeFileSync(join(mergedWt.path, "post-merge-report.md"), "# Post-merge report\n", "utf8");
      await runGit(mergedWt.path, ["add", "post-merge-report.md"]);
      await runGit(mergedWt.path, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "Post-merge report"]);
      const postMergeHead = (await runGit(mergedWt.path, ["rev-parse", "HEAD"])).stdout;
      const mainBeforeArchiveFailure = (await runGit(repoRoot, ["rev-parse", "main"])).stdout;

      // 6a. If the required archive ref update fails, return_task must reject before committing anything:
      // task stays running, worktree stays merged (not torn down), and base branch is unchanged.
      const hooksDir = join(repoRoot, ".git", "hooks");
      mkdirSync(hooksDir, { recursive: true });
      await runGit(repoRoot, ["config", "core.hooksPath", hooksDir]);
      const refTxHook = join(hooksDir, "reference-transaction");
      writeFileSync(
        refTxHook,
        [
          "#!/bin/sh",
          "while IFS= read -r line; do",
          '  case "$line" in',
          '    *"refs/harness/archive/"*|*"refs/harness/"*"/archive/"*) exit 1 ;;',
          "  esac",
          "done",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      chmodSync(refTxHook, 0o755);

      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, mergedWorker.id, "return_task", {
            status: "completed",
            summary: "Merged base fix and archived post-merge report externally",
            external_deliverable: {
              ref: "origin-ext/post-merge-report",
              sha: postMergeHead,
            },
          }),
        (err: unknown) => {
          assert.ok(err instanceof HarnessRejection, `expected HarnessRejection, got ${String(err)}`);
          assert.equal(err.notice.rule, "settlement-archive-failed");
          assert.ok(
            countWords(err.notice) <= WORD_BUDGET,
            `archive-failed rejection exceeded ${WORD_BUDGET}-word budget: ${countWords(err.notice)}`,
          );
          assert.match(err.message, /^\[harness blocked: settlement-archive-failed\] .+ Why: .+ Allowed: .+$/);
          assert.match(err.message, /archive ref/i);
          assert.ok(err.message.includes("return_task"), `expected return_task retry guidance: ${err.message}`);
          assert.ok(err.message.includes("submit_for_merge"), `expected submit_for_merge guidance: ${err.message}`);
          assert.ok(err.message.includes("blocked"), `expected blocked guidance: ${err.message}`);
          return true;
        },
      );
      // Yield to ensure no background teardown ran after the rejected settlement.
      await new Promise((r) => setTimeout(r, 150));

      const taskAfterArchiveFailure = db.getTask(mergedWorker.id)!;
      assert.equal(taskAfterArchiveFailure.status, "running");
      assert.equal(taskAfterArchiveFailure.resultJson, null);
      const wtAfterArchiveFailure = db.getWorktree(mergedWt.id)!;
      assert.equal(wtAfterArchiveFailure.status, "merged");
      assert.equal(wtAfterArchiveFailure.cleanedAt, null);
      assert.equal(wtAfterArchiveFailure.archiveRef, null);
      assert.equal(existsSync(mergedWt.path), true);
      assert.equal((await runGit(repoRoot, ["rev-parse", "main"])).stdout, mainBeforeArchiveFailure);

      // Remove the injected archive-ref failure hook and verify retrying return_task now succeeds cleanly.
      rmSync(refTxHook, { force: true });

      const mergedExtRes = (await orch.toolExecutor.execute(run.id, mergedWorker.id, "return_task", {
        status: "completed",
        summary: "Merged base fix and archived post-merge report externally",
        external_deliverable: {
          ref: "origin-ext/post-merge-report",
          sha: postMergeHead,
        },
      })) as { returned: boolean; status: string };
      assert.equal(mergedExtRes.returned, true);
      assert.equal(mergedExtRes.status, "completed");

      // Yield to allow any fire-and-forget async teardown in return_task's finally block to run.
      await new Promise((r) => setTimeout(r, 150));

      const expectedArchiveRef = archiveRef(run, mergedWorker.id);
      const settledMerged = db.getTask(mergedWorker.id)!;
      assert.equal(settledMerged.status, "completed");
      const parsedMergedResult = JSON.parse(settledMerged.resultJson ?? "{}") as {
        external_deliverable?: {
          ref: string;
          sha?: string;
          worktree_head: string | null;
          unmerged_commits: string[];
          archive_ref?: string;
        };
      };
      assert.deepEqual(parsedMergedResult.external_deliverable, {
        ref: "origin-ext/post-merge-report",
        sha: postMergeHead,
        worktree_head: postMergeHead,
        unmerged_commits: [postMergeHead],
        archive_ref: expectedArchiveRef,
      });
      assert.deepEqual(compactTaskHandoff(settledMerged).external_deliverable, parsedMergedResult.external_deliverable);

      const wtAfterSettle = db.getWorktree(mergedWt.id)!;
      assert.equal(wtAfterSettle.cleanedAt, null);
      assert.equal(wtAfterSettle.status, "active");
      assert.equal(wtAfterSettle.archiveRef, expectedArchiveRef);
      assert.equal((await runGit(repoRoot, ["rev-parse", expectedArchiveRef])).stdout, postMergeHead);

      // Subsequent sweep tears down the retired worktree while keeping postMergeHead reachable under refs/harness/archive.
      await wtMgr.sweep({ runId: run.id });
      const wtAfterSweep = db.getWorktree(mergedWt.id)!;
      assert.notEqual(wtAfterSweep.cleanedAt, null);
      assert.equal(wtAfterSweep.status, "archived");
      assert.equal(wtAfterSweep.archiveRef, expectedArchiveRef);
      assert.equal((await runGit(repoRoot, ["rev-parse", expectedArchiveRef])).stdout, postMergeHead);
      const containingRefs = (
        await runGit(repoRoot, ["for-each-ref", "--format=%(refname)", "--contains", postMergeHead, ...archiveRefPatterns(run)])
      ).stdout
        .split(/\r?\n/)
        .filter(Boolean);
      assert.ok(
        containingRefs.includes(expectedArchiveRef),
        `expected ${expectedArchiveRef} to contain ${postMergeHead}, got: ${containingRefs.join(", ")}`,
      );
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
