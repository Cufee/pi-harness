import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb, type MessageRecord, type PeerExchangeRecord, type TaskRecord } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { buildHydrationTurn, buildImmutableSystemPrompt } from "../src/control-plane/prompts.js";
import { buildRunActivitySummary } from "../src/control-plane/telemetry.js";
import { DirectorRuntime } from "../src/director/runtime.js";
import { buildDirectorSystemPrompt } from "../src/director/session.js";
import { QuotaClient } from "../src/quota/client.js";
import { toolPolicyForTask, validateRunPolicy } from "../src/runners/types.js";
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

  it("assigns implementation and research to distinct tiers", () => {
    const prompt = buildImmutableSystemPrompt(1, "orchestrator", "off");
    assert.match(prompt, /read-only file\/search access.*never editing files or running mutating commands/i);
    assert.match(prompt, /1 cohesive Tier 2 Worker/i);
    assert.match(prompt, /implementation to Tier 2 Workers with disjoint write_scopes.*Blackboard/i);
    assert.match(prompt, /always choose a concrete model ID from `list_models`/i);
    assert.match(prompt, /spawn_task.*read-only research, planning, and verification/i);
    assert.match(prompt, /wait_children.*summaries.*sources.*artifact_paths.*artifact_read.*more detail/i);
    assert.match(prompt, /kb_search.*kb_propose.*kb_promote.*kb_archive.*kb_flag_stale/i);

    // Tier 1 is read-only workspace by default, allows narrowing to control_plane_only (Director), and forbids writes.
    assert.equal(toolPolicyForTask(1, "orchestrator"), "read_only_workspace");
    const baseReq = {
      runId: "r", taskId: "t", tier: 1 as const, kind: "orchestrator" as const, cwd: "/tmp",
      systemPrompt: "sys", initialPrompt: "init", model: "opus", maxTurns: 1,
      tools: [], executeTool: async () => ({}), signal: new AbortController().signal, callbacks: {},
    };
    validateRunPolicy({ ...baseReq, toolPolicy: "read_only_workspace" });
    validateRunPolicy({ ...baseReq, toolPolicy: "control_plane_only" });
    assert.throws(() => validateRunPolicy({ ...baseReq, toolPolicy: "read_write_workspace" }), /Invalid tool policy/);
  });

  it("gives T2 ownership of a scoped worktree and independent verification", () => {
    const prompt = buildImmutableSystemPrompt(2, "worker", "off");
    assert.match(prompt, /isolated git worktree.*only within your assigned write scopes/i);
    assert.match(prompt, /read-only Tier 3.*research.*explore/i);
    assert.match(prompt, /independent read-only Tier 3.*verify.*before submitting/i);
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
        answeredMessages?: MessageRecord[];
        openPeerRequests?: PeerExchangeRecord[];
      };
      assert.equal(tv.answeredMessages?.length, 1);
      assert.equal(tv.answeredMessages?.[0]?.id, msg.id);
      assert.equal(tv.openPeerRequests?.length, 1);

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
});
