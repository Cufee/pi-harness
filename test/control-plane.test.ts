import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { buildImmutableSystemPrompt } from "../src/control-plane/prompts.js";
import { DirectorRuntime } from "../src/director/runtime.js";
import { buildDirectorSystemPrompt } from "../src/director/session.js";
import { QuotaClient } from "../src/quota/client.js";
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
    assert.match(prompt, /never edit code, run shell commands, or inspect repository files directly/i);
    assert.match(prompt, /delegate lookups.*read-only research, plan, or verify.*spawn_task/i);
    assert.match(prompt, /concrete model from list_models/i);
    assert.match(prompt, /summary and sources via wait_tasks.*artifacts on demand/i);
    assert.match(prompt, /read_file only as a rare logged exception.*exception_reason/i);
    assert.match(prompt, /goal_create.*commit it immediately.*clear action request/i);
    assert.match(prompt, /sensible defaults.*ask only.*ambiguous or irreversible/i);
    assert.match(prompt, /separate goals for distinct requests.*amend the relevant active goal/i);
    assert.match(prompt, /goal_amend/);
    assert.match(prompt, /never duplicate a rendered table/i);
  });

  it("assigns implementation and research to distinct tiers", () => {
    const prompt = buildImmutableSystemPrompt(1, "orchestrator", "off");
    assert.match(prompt, /never read repository files, edit code, or run shell commands/i);
    assert.match(prompt, /implementation to Tier 2 Workers with disjoint write_scopes.*Blackboard/i);
    assert.match(prompt, /always choose a concrete model ID from list_models/i);
    assert.match(prompt, /spawn_task.*read-only research, planning, and verification/i);
    assert.match(prompt, /wait_children.*summaries.*sources.*artifact_paths.*artifact_read.*more detail/i);
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
    assert.match(prompt, /return_task.*2,000 characters.*sources.*path.*lines.*symbol.*note/i);
    assert.match(prompt, /research, plan, and verify tasks must include at least one source/i);
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
          assert.match(req.systemPrompt, /never edit files, run mutating commands, or delegate/i);
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

      // Create a Tier 3 task and test scope_too_large guardrail
      const child = db.createTask({
        runId: run.id,
        parentId: orchestratorTask.id,
        tier: 3,
        kind: "execute",
        title: "Too big task",
        objective: "Rewrite entire compiler",
        profileId: "acp:claude",
      });

      // Rejected when missing suggested_splits (< 2)
      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, child.id, "return_task", {
            status: "scope_too_large",
            summary: "Too big",
            evidence_paths: ["src/compiler.ts"],
            suggested_splits: ["only one"],
          }),
        /at least 2 concrete suggested_splits/,
      );

      // Accepted when evidence + >= 2 splits provided
      const res = (await orch.toolExecutor.execute(run.id, child.id, "return_task", {
        status: "scope_too_large",
        summary: "Spans parser and codegen",
        evidence_paths: ["src/parser.ts", "src/codegen.ts"],
        suggested_splits: ["Refactor parser AST", "Update codegen emitter"],
      })) as { status: string; escalationId: string };

      assert.equal(res.status, "returned_for_rescope");
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
        /Settlement gate rejected/,
      );

      db.close();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
