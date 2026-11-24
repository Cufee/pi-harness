import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { HARNESS_TEXT_COUNT_PATTERN } from "../src/advisories/rules.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb, type ArtifactRecord, type TaskRecord } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import {
  buildHydrationTurn,
  buildImmutableSystemPrompt,
  buildMissingReturnWrapUpPrompt,
} from "../src/control-plane/prompts.js";
import { buildDirectorSystemPrompt } from "../src/director/session.js";
import { GoalEngine } from "../src/goals/engine.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const REJECTION_SHAPE = /^\[harness blocked: [\w-]+\] .+ Why: .+ Allowed: .+/;

async function setupHarness() {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-lim-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-lim-state-"));
  await runGit(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "README.md"), "initial\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

  const db = new ControlPlaneDb(":memory:");
  const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, codeMode: "off" });
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const orch = new HarnessOrchestrator(db, config, catalog, quota);
  const goals = new GoalEngine(db.db);
  const cleanup = () => {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  };
  return { repoRoot, stateDir, baseSha, db, config, orch, goals, cleanup };
}

describe("goal-14 slice C1 limits and rejections", () => {
  it("T3-10 read-only finding default in report_issue", async () => {
    const { repoRoot, baseSha, db, orch, cleanup } = await setupHarness();
    try {
      const run = db.createRun({ goal: "Read-only findings", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(parent.id, { status: "running" });

      // 1. research, plan, and verify reporting code_defect P1 without blocking -> non-blocking, parent-addressed, task stays running.
      for (const kind of ["research", "plan", "verify"] as const) {
        const t = db.createTask({
          runId: run.id,
          parentId: parent.id,
          tier: 3,
          kind,
          title: `${kind} task`,
          objective: "Inspect",
          readOnly: true,
          profileId: "pi:local",
        });
        db.updateTask(t.id, { status: "running" });

        const res = (await orch.toolExecutor.execute(run.id, t.id, "report_issue", {
          severity: "P1",
          category: "code_defect",
          title: `Defect found by ${kind}`,
          evidence_paths: ["README.md"],
        })) as { escalationId: string; blocking: boolean; routedTo: string; advisory?: string };

        assert.equal(res.blocking, false);
        assert.equal(res.routedTo, parent.id);
        assert.match(res.advisory ?? "", /non-blocking.*return_task/i);
        assert.equal(db.getTask(t.id)?.status, "running");
        const esc = db.getEscalation(res.escalationId)!;
        assert.equal(esc.blocking, false);
        assert.equal(esc.toTaskId, parent.id);
      }

      // 2. code_defect P0 from research -> non-blocking, task stays running, and human-addressed so it surfaces in the inbox.
      const resP0Task = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Research P0 finding",
        objective: "Inspect",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(resP0Task.id, { status: "running" });
      const resP0 = (await orch.toolExecutor.execute(run.id, resP0Task.id, "report_issue", {
        severity: "P0",
        category: "code_defect",
        title: "Critical defect found in research",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; routedTo: string; advisory?: string; harness_advisory?: string[] };
      assert.equal(resP0.blocking, false);
      assert.equal(resP0.routedTo, "human");
      assert.match(resP0.advisory ?? "", /non-blocking.*return_task/i);
      assert.ok(Array.isArray(resP0.harness_advisory) && resP0.harness_advisory.length === 1);
      assert.ok(resP0.harness_advisory[0]!.includes("for the human"));
      assert.doesNotMatch(resP0.harness_advisory[0]!, /for your parent|blocking:\s*true/);
      assert.equal(db.getTask(resP0Task.id)?.status, "running");
      const escP0 = db.getEscalation(resP0.escalationId)!;
      assert.equal(escP0.blocking, false);
      assert.equal(escP0.toTaskId, null);

      // 3. env_failure P1 from read-only verify -> never blocks; task keeps running with tool-result advisory.
      const envTask = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "Verify env fail",
        objective: "Check",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(envTask.id, { status: "running" });
      const envRes = (await orch.toolExecutor.execute(run.id, envTask.id, "report_issue", {
        severity: "P1",
        category: "env_failure",
        title: "Missing binary",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; routedTo: string; advisory?: string };
      assert.equal(envRes.blocking, false);
      assert.equal(envRes.routedTo, parent.id);
      assert.match(envRes.advisory ?? "", /non-blocking.*return_task/i);
      assert.equal(db.getTask(envTask.id)?.status, "running");
      assert.equal(db.getEscalation(envRes.escalationId)?.blocking, false);

      // 3b. env_failure P1 from writable execute task -> blocks as before.
      const execEnvTask = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "execute",
        title: "Execute env fail",
        objective: "Run command",
        readOnly: false,
        profileId: "pi:local",
      });
      db.updateTask(execEnvTask.id, { status: "running" });
      const execEnvRes = (await orch.toolExecutor.execute(run.id, execEnvTask.id, "report_issue", {
        severity: "P1",
        category: "env_failure",
        title: "Missing binary in execute",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; advisory?: string };
      assert.equal(execEnvRes.blocking, true);
      assert.equal(execEnvRes.advisory, undefined);
      assert.equal(db.getTask(execEnvTask.id)?.status, "blocked");
      assert.equal(db.getEscalation(execEnvRes.escalationId)?.blocking, true);

      // 4. code_defect P1 with explicit blocking: true from read-only verify -> still non-blocking; task stays running.
      const explicitBlockTask = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "Verify explicit block",
        objective: "Check",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(explicitBlockTask.id, { status: "running" });
      const expRes = (await orch.toolExecutor.execute(run.id, explicitBlockTask.id, "report_issue", {
        severity: "P1",
        category: "code_defect",
        title: "Must halt",
        evidence_paths: ["README.md"],
        blocking: true,
      })) as { escalationId: string; blocking: boolean; routedTo: string; advisory?: string };
      assert.equal(expRes.blocking, false);
      assert.equal(expRes.routedTo, parent.id);
      assert.match(expRes.advisory ?? "", /non-blocking.*return_task/i);
      assert.equal(db.getTask(explicitBlockTask.id)?.status, "running");
      assert.equal(db.getEscalation(expRes.escalationId)?.blocking, false);

      // 5. code_defect P1 from a worker -> blocked as today.
      const worker = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Implement",
        readOnly: false,
        profileId: "pi:local",
      });
      db.updateTask(worker.id, { status: "running" });
      const workerRes = (await orch.toolExecutor.execute(run.id, worker.id, "report_issue", {
        severity: "P1",
        category: "code_defect",
        title: "Blocked worker defect",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean };
      assert.equal(workerRes.blocking, true);
      assert.equal(db.getTask(worker.id)?.status, "blocked");
      assert.equal(db.getEscalation(workerRes.escalationId)?.blocking, true);
    } finally {
      cleanup();
    }
  });

  it("T3-10e read-only finding advisory end to end through orchestrator advised executor", async () => {
    const { repoRoot, baseSha, db, orch, cleanup } = await setupHarness();
    try {
      const run = db.createRun({ goal: "Read-only finding advisory e2e", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(parent.id, { status: "running" });

      const verify = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "Verify slice",
        objective: "Check implementation",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(verify.id, { status: "running" });

      const firstRes = (await orch.toolExecutor.execute(run.id, verify.id, "report_issue", {
        severity: "P1",
        category: "code_defect",
        title: "First defect found during verify",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; routedTo: string; harness_advisory?: string[] };

      assert.equal(firstRes.blocking, false);
      assert.equal(firstRes.routedTo, parent.id);
      assert.equal(db.getTask(verify.id)?.status, "running");
      const firstEsc = db.getEscalation(firstRes.escalationId)!;
      assert.equal(firstEsc.blocking, false);
      assert.equal(firstEsc.toTaskId, parent.id);

      assert.ok(Array.isArray(firstRes.harness_advisory), "expected harness_advisory array on first read-only finding");
      assert.equal(firstRes.harness_advisory.length, 1);
      const advisoryText = firstRes.harness_advisory[0]!;
      assert.match(
        advisoryText,
        /^\[harness advisory: read-only-finding-escalation\] .+ Why: .+ Instead: .+return_task.+/,
      );
      assert.ok(advisoryText.includes(firstRes.escalationId));
      assert.ok(advisoryText.includes("for your parent"));
      assert.match(advisoryText, /Keep going.*return_task.*status "blocked"/);
      assert.doesNotMatch(advisoryText, /blocking:\s*true/);

      // P0 code_defect from a read-only verify task routes to human and names the human recipient in harness_advisory.
      const p0Verify = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "Verify P0 defect",
        objective: "Check critical issue",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(p0Verify.id, { status: "running" });

      const p0Res = (await orch.toolExecutor.execute(run.id, p0Verify.id, "report_issue", {
        severity: "P0",
        category: "code_defect",
        title: "Critical defect found during verify",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; routedTo: string; harness_advisory?: string[] };

      assert.equal(p0Res.blocking, false);
      assert.equal(p0Res.routedTo, "human");
      assert.equal(db.getTask(p0Verify.id)?.status, "running");
      assert.ok(Array.isArray(p0Res.harness_advisory) && p0Res.harness_advisory.length === 1);
      const p0AdvisoryText = p0Res.harness_advisory[0]!;
      assert.ok(p0AdvisoryText.includes(p0Res.escalationId));
      assert.ok(p0AdvisoryText.includes("for the human"));
      assert.doesNotMatch(p0AdvisoryText, /\byour parent\b/);
      assert.match(p0AdvisoryText, /Keep going.*return_task.*status "blocked"/);
      assert.doesNotMatch(p0AdvisoryText, /blocking:\s*true/);

      // Second call on the same verify task yields no second advisory (dedupe per subject).
      const secondRes = (await orch.toolExecutor.execute(run.id, verify.id, "report_issue", {
        severity: "P1",
        category: "code_defect",
        title: "Second defect found during verify",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; routedTo: string; harness_advisory?: string[] };

      assert.equal(secondRes.blocking, false);
      assert.equal(secondRes.routedTo, parent.id);
      assert.equal(db.getTask(verify.id)?.status, "running");
      assert.equal(secondRes.harness_advisory, undefined);

      const verifyAdvisories = db
        .getEventsSince(run.id, 0)
        .filter((e) => e.taskId === verify.id && e.type === "agent.advisory");
      assert.equal(verifyAdvisories.length, 1);
      assert.equal((verifyAdvisories[0]!.payload as { rule?: string }).rule, "read-only-finding-escalation");

      // A verify task reporting env_failure at P1 is non-blocking (with tool-result advisory) and gets no read-only-finding-escalation advisory.
      const envVerify = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "Verify env failure",
        objective: "Check environment",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(envVerify.id, { status: "running" });

      const envRes = (await orch.toolExecutor.execute(run.id, envVerify.id, "report_issue", {
        severity: "P1",
        category: "env_failure",
        title: "Test binary unavailable",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; advisory?: string; harness_advisory?: string[] };

      assert.equal(envRes.blocking, false);
      assert.match(envRes.advisory ?? "", /non-blocking.*return_task/i);
      assert.equal(db.getTask(envVerify.id)?.status, "running");
      assert.equal(db.getEscalation(envRes.escalationId)?.blocking, false);
      assert.equal(envRes.harness_advisory, undefined);

      const envAdvisories = db
        .getEventsSince(run.id, 0)
        .filter((e) => e.taskId === envVerify.id && e.type === "agent.advisory");
      assert.equal(envAdvisories.length, 0);

      // A writable execute task reporting env_failure at P1 is blocked as before and gets no read-only-finding-escalation advisory.
      const envExecute = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "execute",
        title: "Execute env failure",
        objective: "Run environment check",
        readOnly: false,
        profileId: "pi:local",
      });
      db.updateTask(envExecute.id, { status: "running" });

      const envExecRes = (await orch.toolExecutor.execute(run.id, envExecute.id, "report_issue", {
        severity: "P1",
        category: "env_failure",
        title: "Test binary unavailable in execute",
        evidence_paths: ["README.md"],
      })) as { escalationId: string; blocking: boolean; advisory?: string; harness_advisory?: string[] };

      assert.equal(envExecRes.blocking, true);
      assert.equal(envExecRes.advisory, undefined);
      assert.equal(db.getTask(envExecute.id)?.status, "blocked");
      assert.equal(db.getEscalation(envExecRes.escalationId)?.blocking, true);
      assert.equal(envExecRes.harness_advisory, undefined);

      const envExecAdvisories = db
        .getEventsSince(run.id, 0)
        .filter((e) => e.taskId === envExecute.id && e.type === "agent.advisory");
      assert.equal(envExecAdvisories.length, 0);
    } finally {
      cleanup();
    }
  });

  it("T5-1 converted limits (L18, L20, L6, L33)", async () => {
    const { repoRoot, baseSha, db, orch, goals, cleanup } = await setupHarness();
    try {
      const run = db.createRun({ goal: "Converted limits", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(parent.id, { status: "completed" });

      // (a) return_task scope_too_large with one split and no evidence -> accepted, splitsMissing: true, no "[Partial" prefix.
      const worker = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Oversized worker",
        objective: "Too big",
        readOnly: false,
        profileId: "pi:local",
      });
      db.updateTask(worker.id, { status: "running" });
      const aRes = (await orch.toolExecutor.execute(run.id, worker.id, "return_task", {
        status: "scope_too_large",
        summary: "Too many modules touched",
        suggested_splits: ["Split module A"],
      })) as { status: string; escalationId: string; splitsMissing?: boolean };

      assert.equal(aRes.status, "returned_for_rescope");
      assert.equal(aRes.splitsMissing, true);
      const aTask = db.getTask(worker.id)!;
      assert.equal(aTask.status, "returned_for_rescope");
      assert.ok(!aTask.summary?.startsWith("[Partial"), `unexpected [Partial prefix: ${aTask.summary}`);
      const aResult = JSON.parse(aTask.resultJson ?? "{}") as { partial?: boolean };
      assert.equal(aResult.partial, undefined);
      const aEsc = db.getEscalation(aRes.escalationId)!;
      assert.equal(aEsc.category, "scope_too_large");
      assert.deepEqual(aEsc.suggestedSplits, ["Split module A"]);
      assert.deepEqual(aEsc.evidencePaths, []);

      // (b) Final verify returning scope_too_large with one split and no evidence -> verdict recorded as failed (same as non-completed final verify).
      const goal = goals.createGoal({
        repoRoot,
        title: "Verify verdict test",
        description: "Ensure scope_too_large does not drop final verify verdict",
        criteria: [{ description: "Passes", kind: "behavioral" }],
      });
      const vRun = db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha });
      goals.linkRunAndStart(goal.id, vRun.id);
      const vParent = db.createTask({
        runId: vRun.id,
        tier: 1,
        kind: "orchestrator",
        title: "V-Orch",
        objective: "Coord",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(vParent.id, { status: "completed" });
      const finalVerify = db.createTask({
        runId: vRun.id,
        parentId: vParent.id,
        tier: 3,
        kind: "verify",
        title: "Final verify",
        objective: "Verify everything",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(finalVerify.id, { status: "running" });

      const bRes = (await orch.toolExecutor.execute(vRun.id, finalVerify.id, "return_task", {
        status: "scope_too_large",
        summary: "Verification scope exceeds single pass",
        sources: [{ path: "README.md", lines: "1" }],
        suggested_splits: ["Verify part 1"],
      })) as { status: string; splitsMissing?: boolean };
      assert.equal(bRes.status, "returned_for_rescope");
      assert.equal(bRes.splitsMissing, true);
      assert.equal(goals.getGoal(goal.id)?.liveProgress?.verificationStatus, "failed");

      // (c) inspect_command from a writable execute task runs (L20), and truncated output gains narrowing hint (L6).
      writeFileSync(join(repoRoot, "big.txt"), "x".repeat(25_000), "utf8");
      const execTask = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "execute",
        title: "Writable execute",
        objective: "Do work",
        readOnly: false,
        profileId: "pi:local",
      });
      db.updateTask(execTask.id, { status: "running" });
      const cSmall = (await orch.toolExecutor.execute(run.id, execTask.id, "inspect_command", {
        argv: ["cat", "README.md"],
      })) as { exit_code: number; stdout: string; truncated: boolean; hint?: string };
      assert.equal(cSmall.exit_code, 0);
      assert.equal(cSmall.stdout, "initial\n");
      assert.equal(cSmall.truncated, false);
      assert.equal(cSmall.hint, undefined);

      const cBig = (await orch.toolExecutor.execute(run.id, execTask.id, "inspect_command", {
        argv: ["cat", "big.txt"],
      })) as { exit_code: number; truncated: boolean; output_path?: string; hint?: string };
      assert.equal(cBig.exit_code, 0);
      assert.equal(cBig.truncated, true);
      assert.ok(cBig.output_path);
      assert.ok(cBig.hint?.includes("artifact_read"));

      // (d) peer_request past round cap names peer_notify before report_issue (L33).
      const peerRunA = db.createRun({ goal: "Peer run A", repoRoot, baseBranch: "main", baseSha, coordinationGroup: "g-peer" });
      const peerRunB = db.createRun({ goal: "Peer run B", repoRoot, baseBranch: "main", baseSha, coordinationGroup: "g-peer" });
      const r1 = db.createPeerRequest({ fromRunId: peerRunA.id, toRunId: peerRunB.id, topicKey: "api", message: "q1" });
      db.replyPeerRequest(r1.id, peerRunB.id, "a1");
      const r2 = db.createPeerRequest({ fromRunId: peerRunA.id, toRunId: peerRunB.id, topicKey: "api", message: "q2" });
      db.replyPeerRequest(r2.id, peerRunB.id, "a2");
      let peerErr = "";
      try {
        db.createPeerRequest({ fromRunId: peerRunA.id, toRunId: peerRunB.id, topicKey: "api", message: "q3" });
      } catch (err) {
        peerErr = err instanceof Error ? err.message : String(err);
      }
      assert.match(peerErr, REJECTION_SHAPE);
      assert.ok(peerErr.startsWith("[harness blocked: peer-round-cap]"));
      assert.ok(peerErr.indexOf("peer_notify") !== -1 && peerErr.indexOf("peer_notify") < peerErr.indexOf("report_issue"));
    } finally {
      cleanup();
    }
  });

  it("T5-2 every block we own explains (what, why, allowed) and does not execute", async () => {
    const { repoRoot, stateDir, baseSha, db, orch, cleanup } = await setupHarness();
    try {
      const run = db.createRun({ goal: "Rejections", repoRoot, baseBranch: "main", baseSha });
      const orchTask = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coord",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(orchTask.id, { status: "running" });

      const research = db.createTask({
        runId: run.id,
        parentId: orchTask.id,
        tier: 3,
        kind: "research",
        title: "Research",
        objective: "Read",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(research.id, { status: "running" });

      const assertBlocked = async (fn: () => Promise<unknown>, expectedRule: string) => {
        await assert.rejects(fn, (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, REJECTION_SHAPE, `unexpected format for ${expectedRule}: ${msg}`);
          assert.ok(msg.startsWith(`[harness blocked: ${expectedRule}]`), `expected ${expectedRule}, got: ${msg}`);
          return true;
        });
      };

      // 1. not-your-tool: research calling spawn_task
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, research.id, "spawn_task", {
            kind: "research",
            objective: "Nope",
            model: "fixture/fixture",
          }),
        "not-your-tool",
      );
      assert.deepEqual(db.listTasks(run.id, { parentId: research.id }), []);

      // 2. spawn-execute-needs-worker: Tier 1 spawn_task with execute
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, orchTask.id, "spawn_task", {
            kind: "execute",
            objective: "Write code",
            model: "fixture/fixture",
          }),
        "spawn-execute-needs-worker",
      );
      assert.equal(db.listTasks(run.id, { parentId: orchTask.id }).length, 1);

      // 3. write-scopes-required: spawn_worker with empty write_scopes
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, orchTask.id, "spawn_worker", {
            objective: "Work",
            write_scopes: [],
            model: "fixture/fixture",
          }),
        "write-scopes-required",
      );

      // 4. write-scopes-blanket: spawn_worker with blanket glob while sibling run active on same branch
      const siblingRun = db.createRun({ goal: "Sibling", repoRoot, baseBranch: "main", baseSha });
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, orchTask.id, "spawn_worker", {
            objective: "Work",
            write_scopes: ["**"],
            model: "fixture/fixture",
          }),
        "write-scopes-blanket",
      );
      db.updateRunStatus(siblingRun.id, "completed");

      // 5. draining: spawn_worker and spawn_task while draining
      db.updateTask(orchTask.id, { status: "draining" });
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, orchTask.id, "spawn_worker", {
            objective: "Work",
            write_scopes: ["src/**"],
            model: "fixture/fixture",
          }),
        "draining",
      );
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, orchTask.id, "spawn_task", {
            kind: "research",
            objective: "Read",
            model: "fixture/fixture",
          }),
        "draining",
      );
      db.updateTask(orchTask.id, { status: "running" });

      // 6. settlement-live-children: return_task completed with live child
      const worker = db.createTask({
        runId: run.id,
        parentId: orchTask.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Build",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
      });
      db.updateTask(worker.id, { status: "running" });
      const liveChild = db.createTask({
        runId: run.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Live sub",
        objective: "Check",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(liveChild.id, { status: "running" });
      await assertBlocked(
        () => orch.toolExecutor.execute(run.id, worker.id, "return_task", { status: "completed", summary: "Done" }),
        "settlement-live-children",
      );
      assert.equal(db.getTask(worker.id)?.status, "running");
      db.updateTask(liveChild.id, { status: "completed" });

      // 7 & 8 & 13: worktree rejections (settlement-dirty-worktree, submit-dirty-worktree, settlement-unmerged)
      const wtMgr = orch.getWorktreeManager(repoRoot);
      const wt = await wtMgr.createForWorker(run.id, worker.id, baseSha);
      db.updateTask(worker.id, { worktreeId: wt.id });
      writeFileSync(join(wt.path, "README.md"), "dirty edit\n", "utf8");

      await assertBlocked(
        () => orch.toolExecutor.execute(run.id, worker.id, "return_task", { status: "completed", summary: "Done" }),
        "settlement-dirty-worktree",
      );
      assert.equal(db.getTask(worker.id)?.status, "running");

      await assertBlocked(
        () => orch.toolExecutor.execute(run.id, worker.id, "submit_for_merge", { summary: "Merge dirty" }),
        "submit-dirty-worktree",
      );
      assert.equal(db.listMergeQueue({ runId: run.id }).length, 0);

      await runGit(wt.path, ["add", "README.md"]);
      await runGit(wt.path, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "unmerged"]);
      await assertBlocked(
        () => orch.toolExecutor.execute(run.id, worker.id, "return_task", { status: "completed", summary: "Done" }),
        "settlement-unmerged",
      );
      assert.equal(db.getTask(worker.id)?.status, "running");

      // 9. escalation-evidence: report_issue with empty evidence_paths
      const escBefore = db.listEscalations(run.id).length;
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, worker.id, "report_issue", {
            severity: "P1",
            category: "code_defect",
            title: "Missing evidence",
            evidence_paths: [],
          }),
        "escalation-evidence",
      );
      assert.equal(db.listEscalations(run.id).length, escBefore);

      // 10. read-only-argv: inspect_command with disallowed binary
      await assertBlocked(
        () => orch.toolExecutor.execute(run.id, research.id, "inspect_command", { argv: ["rm", "-f", "README.md"] }),
        "read-only-argv",
      );
      assert.ok(existsSync(join(repoRoot, "README.md")));

      // 11. inspect-cwd: inspect_command with cwd outside workspace
      await assertBlocked(
        () =>
          orch.toolExecutor.execute(run.id, research.id, "inspect_command", {
            argv: ["ls"],
            cwd: "..",
          }),
        "inspect-cwd",
      );

      // 12. artifact-outside-workspace: artifact_read outside workspace
      const outsideFile = join(stateDir, "outside.txt");
      writeFileSync(outsideFile, "secret outside workspace\n", "utf8");
      await assertBlocked(
        () => orch.toolExecutor.execute(run.id, research.id, "artifact_read", { path: outsideFile }),
        "artifact-outside-workspace",
      );
    } finally {
      cleanup();
    }
  });

  it("T5-4 no counts in harness text and L35 hydration artifact cutoff", () => {
    const prompts: Array<{ label: string; text: string }> = [
      { label: "director", text: buildDirectorSystemPrompt("off") },
      { label: "orchestrator", text: buildImmutableSystemPrompt(1, "orchestrator", "off") },
      { label: "worker", text: buildImmutableSystemPrompt(2, "worker", "off") },
      { label: "research", text: buildImmutableSystemPrompt(3, "research", "off") },
      { label: "plan", text: buildImmutableSystemPrompt(3, "plan", "off") },
      { label: "verify", text: buildImmutableSystemPrompt(3, "verify", "off") },
      { label: "execute", text: buildImmutableSystemPrompt(3, "execute", "off") },
      { label: "wrapup:worker", text: buildMissingReturnWrapUpPrompt(2, "worker") },
      { label: "wrapup:research", text: buildMissingReturnWrapUpPrompt(3, "research") },
      { label: "wrapup:plan", text: buildMissingReturnWrapUpPrompt(3, "plan") },
      { label: "wrapup:verify", text: buildMissingReturnWrapUpPrompt(3, "verify") },
      { label: "wrapup:execute", text: buildMissingReturnWrapUpPrompt(3, "execute") },
    ];

    const mkTask = (tier: 1 | 2 | 3, kind: TaskRecord["kind"]): TaskRecord => ({
      id: `t-${tier}`,
      runId: "run-1",
      parentId: tier === 1 ? null : "t-1",
      tier,
      kind,
      title: `Task ${tier}`,
      objective: "Work",
      criteria: "",
      readOnly: tier !== 2 && kind !== "execute",
      profileId: "pi:local",
      model: "fixture/fixture",
      effort: null,
      status: "running",
      generation: 1,
      maxTurns: 0,
      turnsUsed: 0,
      contextUsed: 0,
      contextSize: 0,
      worktreeId: null,
      sessionId: null,
      summary: null,
      handoffJson: null,
      resultJson: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const artifacts: ArtifactRecord[] = Array.from({ length: 35 }, (_, i) => ({
      id: `art-${i + 1}`,
      runId: "run-1",
      taskId: "t-2",
      kind: "dossier",
      path: `.harness/artifacts/run-1/t-2/doc-${i + 1}.md`,
      summary: `Artifact ${i + 1}`,
      gitSha: null,
      exitCode: null,
      createdAt: i + 1,
    }));

    for (const [tier, kind] of [
      [1, "orchestrator"],
      [2, "worker"],
      [3, "research"],
    ] as const) {
      const hydration = buildHydrationTurn({
        task: mkTask(tier, kind),
        tasksSnapshot: [],
        artifacts,
        openEscalations: [],
        blackboard: {},
      });
      prompts.push({ label: `hydration:t${tier}`, text: hydration });
      // L35: artifact index cutoff mentions remaining count and artifact_read.
      assert.ok(
        hydration.includes("... and 5 more, read with `artifact_read`"),
        `hydration:t${tier} missing L35 artifact cutoff line`,
      );
    }

    for (const { label, text } of prompts) {
      assert.ok(
        !HARNESS_TEXT_COUNT_PATTERN.test(text),
        `${label} matched HARNESS_TEXT_COUNT_PATTERN: ${text.match(HARNESS_TEXT_COUNT_PATTERN)?.[0]}`,
      );
    }
  });

  it("T5-6 sources stay required for read-only handoffs", async () => {
    const { repoRoot, baseSha, db, orch, goals, cleanup } = await setupHarness();
    try {
      const goal = goals.createGoal({
        repoRoot,
        title: "Sources required",
        description: "Verify sources check",
        criteria: [{ description: "Verified", kind: "behavioral" }],
      });
      const run = db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha });
      goals.linkRunAndStart(goal.id, run.id);
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coord",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(parent.id, { status: "completed" });

      // (a) Final verify return_task completed with no sources -> throws handoff-sources rejection, task stays running.
      const verify = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "Final verify",
        objective: "Verify",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(verify.id, { status: "running" });

      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, verify.id, "return_task", {
            status: "completed",
            summary: "Looks good",
          }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /^\[harness blocked: handoff-sources\] .+ Why: .+ Allowed: .+partial: true.+/);
          return true;
        },
      );
      assert.equal(db.getTask(verify.id)?.status, "running");

      // Same call WITH sources succeeds and records verificationStatus: "passed".
      await orch.toolExecutor.execute(run.id, verify.id, "return_task", {
        status: "completed",
        summary: "Verified",
        sources: [{ path: "README.md", lines: "1" }],
      });
      assert.equal(db.getTask(verify.id)?.status, "completed");
      assert.equal(goals.getGoal(goal.id)?.liveProgress?.verificationStatus, "passed");

      // (b) Research with partial: true and artifact_paths and no sources is accepted as today.
      const research = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Partial research",
        objective: "Explore",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(research.id, { status: "running" });
      const art = (await orch.toolExecutor.execute(run.id, research.id, "artifact_write", {
        name: "partial.md",
        content: "partial findings",
        summary: "Partial",
      })) as { path: string };
      const res = (await orch.toolExecutor.execute(run.id, research.id, "return_task", {
        status: "completed",
        summary: "Partial findings saved",
        partial: true,
        artifact_paths: [art.path],
      })) as { returned: boolean; status: string };
      assert.equal(res.returned, true);
      assert.equal(res.status, "completed");
      assert.equal(db.getTask(research.id)?.status, "completed");
    } finally {
      cleanup();
    }
  });
});
