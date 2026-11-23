import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { writeCodeOutput } from "../src/control-plane/dossiers.js";
import { compactTaskHandoff } from "../src/control-plane/handoffs.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { isSafeReadOnlyShellCommand } from "../src/runners/acp-shims.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

describe("Mac-Server Field Report Fixes (Items 2, 4-9, 11-15, 17-22, 27-29)", () => {
  it("blocks git grep -O / --ext-diff / git config / git fetch bypasses in isSafeReadOnlyShellCommand (Item 4)", () => {
    for (const bad of [
      "git grep -Osh foo",
      "git grep -nOsh foo",
      "git grep --open-files-in-pager=sh foo",
      "git diff --ext-diff HEAD",
      "git log --textconv -n 1",
      "git config --list",
      "git fetch --upload-pa=id origin",
      "git fetch -f origin x:main",
    ]) {
      assert.equal(isSafeReadOnlyShellCommand(bad), false, `Expected bypass to be denied: ${bad}`);
    }
    assert.equal(isSafeReadOnlyShellCommand("git grep -n foo src/"), true);
    assert.equal(isSafeReadOnlyShellCommand("git remote -v"), true);
  });

  it("enforces partial updateCriteria merge (Item 9), deterministic command validation (Item 20), restart-safe code output (Item 14), dead lease cleanup (Item 13), safe resumeRun (Item 22), goal_accept + auto-resolved escalations (Items 19, 21), single goal.reviewed delivery (Item 27), Director .harness read/write_note (Items 7, 7b), and status configPath (Item 29)", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-field-rep-"));
    const repoRoot = join(root, "repo");
    const extraDir = join(root, "extra-work");
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");

    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
    mkdirSync(join(repoRoot, ".harness", "goals"), { recursive: true });
    writeFileSync(join(repoRoot, ".harness", "goals", "evidence.md"), "verified ok\n", "utf8");
    mkdirSync(extraDir, { recursive: true });
    writeFileSync(join(extraDir, "shared.txt"), "extra data\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        if (req.initialPrompt.includes("CALL_DIRECTOR_TOOLS")) {
          const readRes = await req.executeTool("read_file", {
            path: ".harness/goals/evidence.md",
            exception_reason: "Check goal evidence",
          });
          const extraReadRes = await req.executeTool("read_file", {
            path: join(extraDir, "shared.txt"),
            exception_reason: "Check extraReadRoots",
          });
          const noteRes = await req.executeTool("write_note", {
            path: ".harness/notes/report.md",
            content: "# Field report\n",
            reason: "Write session summary",
          });
          let rejectedSrcWrite = false;
          try {
            await req.executeTool("write_note", { path: "README.md", content: "bad", reason: "should fail" });
          } catch {
            rejectedSrcWrite = true;
          }
          return { text: JSON.stringify({ readRes, extraReadRes, noteRes, rejectedSrcWrite }), stopReason: "completed" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    });

    const baseCfg = loadConfig(repoRoot);
    const cfg = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      stateDir,
      socketPath: sockPath,
      rollover: { ...baseCfg.rollover, reviewerMaxTurns: 30 },
      worktree: { ...baseCfg.worktree, extraReadRoots: [extraDir], extraWriteRoots: [extraDir] },
    });
    const daemon = new HarnessDaemon(cfg, { dbPath: join(stateDir, "db.sqlite"), customRunnerFactory: runnerFactory });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      // Item 29: status exposes exact configPath & effectiveLimits
      const st = await client.request<{ configPath: string; effectiveLimits: { reviewerMaxTurns: number; extraReadRoots: string[] } }>("status");
      assert.equal(st.configPath, join(stateDir, "config.json"));
      assert.equal(st.effectiveLimits.reviewerMaxTurns, 30);
      assert.deepEqual(st.effectiveLimits.extraReadRoots, [extraDir]);

      // Item 20: deterministic criterion with no command rejected on create & amend
      assert.throws(
        () =>
          daemon.director.goals.createGoal({
            repoRoot,
            title: "Bad deterministic",
            description: "No cmd",
            criteria: [{ id: "c1", description: "Run tests", kind: "deterministic" }],
          }),
        /requires a non-empty shell 'command'/i,
      );

      // Item 9: partial updateCriteria merges with existing criterion without wiping kind/description/required
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Partial merge test",
        description: "Desc",
        criteria: [{ id: "c1", description: "Unit tests pass", kind: "deterministic", command: "true", required: true }],
      });
      const amended = daemon.director.goals.amendGoal(goal.id, {
        rationale: "Update command only",
        updateCriteria: [{ id: "c1", command: "echo ok" }],
      });
      assert.equal(amended.goal.criteria[0]!.kind, "deterministic");
      assert.equal(amended.goal.criteria[0]!.description, "Unit tests pass");
      assert.equal(amended.goal.criteria[0]!.required, true);
      assert.equal(amended.goal.criteria[0]!.command, "echo ok");

      // Item 14: restart-safe code output numbering never throws EEXIST when filename already exists
      const run = daemon.db.createRun({ goal: "Artifact test", repoRoot, baseBranch: "main", baseSha: "HEAD" });
      const t1 = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Obj",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const firstPath = writeCodeOutput(daemon.db, run, t1.id, "code-exec-1.json", '{"a":1}');
      const secondPath = writeCodeOutput(daemon.db, run, t1.id, "code-exec-1.json", '{"a":2}');
      assert.notEqual(firstPath, secondPath, "Duplicate name after restart must allocate next unique file");
      assert.equal(readFileSync(firstPath, "utf8"), '{"a":1}');
      assert.equal(readFileSync(secondPath, "utf8"), '{"a":2}');

      // Item 13: startup reconciliation releases dead task write leases even when sibling is paused_quota
      const deadWorker = daemon.db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Dead worker",
        objective: "Dead",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
        writeScopes: ["src/dead/**"],
      });
      const pausedWorker = daemon.db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Quota worker",
        objective: "Quota",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
        writeScopes: ["src/quota/**"],
      });
      daemon.db.updateTask(deadWorker.id, { status: "failed", summary: "Old failure" });
      daemon.db.updateTask(pausedWorker.id, { status: "paused_quota", summary: "Quota" });
      daemon.orchestrator.reconcileStaleRunsOnStartup();
      assert.equal(daemon.db.listActiveWriteScopes(run.id, deadWorker.id).length, 0, "Dead worker lease must be released");
      assert.equal(daemon.db.listActiveWriteScopes(run.id, pausedWorker.id).length, 1, "Quota-paused sibling lease preserved");

      // Item 22: resumeRun NEVER revives cancelled or completed tasks!
      const run2 = daemon.db.createRun({ goal: "Resume safety", repoRoot, baseBranch: "main", baseSha: "HEAD" });
      const r2Orch = daemon.db.createTask({
        runId: run2.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch 2",
        objective: "Obj 2",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const r2Cancelled = daemon.db.createTask({
        runId: run2.id,
        parentId: r2Orch.id,
        tier: 3,
        kind: "research",
        title: "Cancelled scout",
        objective: "Cancelled",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(r2Orch.id, { status: "failed", summary: "Interrupted by daemon restart" });
      daemon.db.updateTask(r2Cancelled.id, { status: "cancelled", summary: "Cancelled earlier" });
      const resumed = await daemon.orchestrator.resumeRun(run2.id);
      assert.ok(resumed.resumedTaskIds.includes(r2Orch.id));
      assert.ok(!resumed.resumedTaskIds.includes(r2Cancelled.id), "resumeRun must NEVER revive cancelled tasks");

      // Item 19 & 21 & 27: goal_accept resolves open escalations; auto-triggered goal.reviewed is not persisted twice!
      const chat = await daemon.director.openDefaultChat({ repoRoot });
      const gAcc = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "Accept test",
        description: "Verify accept + escalation auto-resolve",
        criteria: [{ id: "c1", description: "Behavioral", kind: "behavioral" }],
      });
      daemon.director.goals.linkRunAndStart(gAcc.id, run.id);
      const esc = daemon.db.createEscalation({
        runId: run.id,
        fromTaskId: t1.id,
        toTaskId: null,
        severity: "P0",
        category: "verification_failed",
        title: "Stale esc",
        evidencePaths: ["README.md"],
        blocking: true,
      });
      const outcome = daemon.director.goals.recordReviewVerdict(gAcc.id, {
        verdict: "approved",
        criteriaResults: [{ criterionId: "c1", passed: true, evidence: "ok" }],
        blockingIssues: [],
        summary: "Approved",
        diffHash: "h1",
      });
      await (daemon.director as unknown as { handlePostReviewTransition: (o: unknown, opts: { autoTriggered: boolean }) => Promise<void> })
        .handlePostReviewTransition(outcome, { autoTriggered: true });
      await new Promise((r) => setTimeout(r, 120));

      assert.equal(daemon.db.getEscalation(esc.id)?.status, "resolved", "Open escalations must auto-resolve when goal is achieved");
      const reviewedTurns = daemon.director.chats
        .getHistory(chat.id, 0, 100)
        .filter((t) => t.role === "system_notice" && t.event?.kind === "goal.reviewed" && t.event.goalId === gAcc.id);
      assert.equal(reviewedTurns.length, 1, "goal.reviewed must be recorded ONCE, not duplicated");

      // Item 7 & 7b: Director read_file on .harness/goals + extraReadRoots, and write_note on .harness/notes (rejecting README.md)
      const dirRes = await daemon.director.sendChatMessage(chat.id, "CALL_DIRECTOR_TOOLS");
      const parsed = JSON.parse(dirRes.assistantTurn?.content ?? "{}") as {
        readRes: { content: string };
        extraReadRes: { content: string };
        noteRes: { written: boolean };
        rejectedSrcWrite: boolean;
      };
      assert.ok(parsed.readRes.content.includes("verified ok"));
      assert.ok(parsed.extraReadRes.content.includes("extra data"));
      assert.equal(parsed.noteRes.written, true);
      assert.equal(parsed.rejectedSrcWrite, true);
      assert.ok(existsSync(join(repoRoot, ".harness", "notes", "report.md")));
    } finally {
      client.close();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes partial fallbacks on error/cancel, accepts return_task partial:true with artifacts, and nudges only Tier 3 on widening scope", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-goal13-handoff-"));
    const repoRoot = join(root, "repo");
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");

    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "init"]);

    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({ ...baseCfg, stateDir, socketPath: sockPath });

    const cancelStarted = Promise.withResolvers<void>();
    const cancelGate = Promise.withResolvers<void>();
    const emitWidening = (onToolEvent?: NonNullable<Parameters<ReturnType<CustomRunnerFactory>["run"]>[0]["callbacks"]["onToolEvent"]>) => {
      const topics = ["cortexsdk", "nats", "listdevices", "commissioning"];
      for (let i = 0; i < 4; i++) {
        onToolEvent?.({
          id: `g-${i}`,
          name: "grep",
          kind: "search",
          status: "completed",
          args: JSON.stringify({ pattern: topics[i], path: `cloud/mod${i}/handler.go` }),
        });
      }
      for (let i = 4; i < 9; i++) {
        onToolEvent?.({
          id: `r-${i}`,
          name: "read",
          kind: "read",
          status: "completed",
          args: JSON.stringify({ path: `cloud/mod${i}/service.go` }),
        });
      }
    };

    const customRunnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        if (req.initialPrompt.includes("CASE_ERROR")) {
          await req.executeTool("artifact_write", {
            name: "err-notes.md",
            content: "Findings before error",
            summary: "Error dossier",
          });
          return { text: "Adapter crashed mid-stream", stopReason: "error" };
        }
        if (req.initialPrompt.includes("CASE_CANCEL")) {
          await req.executeTool("artifact_write", {
            name: "cancel-notes.md",
            content: "Findings before cancel",
            summary: "Cancel dossier",
          });
          req.onHandle?.({
            steer: async () => true,
            cancel: async () => {
              cancelGate.resolve();
            },
          });
          cancelStarted.resolve();
          await cancelGate.promise;
          return { text: "Partial work before cancel", stopReason: "cancelled" };
        }
        if (req.initialPrompt.includes("CASE_PARTIAL_RETURN")) {
          const dossier = (await req.executeTool("artifact_write", {
            name: "partial-dossier.md",
            content: "Partial survey",
            summary: "Partial dossier",
          })) as { path: string };
          await req.executeTool("return_task", {
            status: "completed",
            partial: true,
            summary: "Verified area A; area B remains",
            artifact_paths: [dossier.path],
          });
          return { text: "done", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_WIDEN")) {
          emitWidening(req.callbacks.onToolEvent);
          const dossier = (await req.executeTool("artifact_write", {
            name: "widen.md",
            content: "Survey",
            summary: "Survey",
          })) as { path: string };
          await req.executeTool("return_task", {
            status: "completed",
            partial: true,
            summary: "Done after check",
            artifact_paths: [dossier.path],
          });
          return { text: "done", stopReason: "completed" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    });

    const daemon = new HarnessDaemon(config, { dbPath: ":memory:", customRunnerFactory });
    await daemon.start();
    try {
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
      const run = daemon.db.createRun({ goal: "goal-13 handoffs", repoRoot, baseBranch: "main", baseSha });
      const parent = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(parent.id, { status: "running" });

      const waitSettled = async (taskId: string) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const t = daemon.db.getTask(taskId);
          if (t && ["completed", "failed", "cancelled", "returned_for_rescope", "blocked"].includes(t.status)) return t;
          await new Promise((r) => setTimeout(r, 15));
        }
        throw new Error(`Timed out waiting for ${taskId}`);
      };

      // 1. stopReason "error" -> partial fallback with artifact_paths from earlier artifact_write
      const errTask = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Error scout",
        objective: "CASE_ERROR",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const errSettled = await waitSettled(errTask.id);
      const errHandoff = compactTaskHandoff(errSettled);
      assert.equal(errHandoff.status, "failed");
      assert.equal((errHandoff as { partial?: boolean }).partial, true);
      assert.ok(errHandoff.summary?.startsWith("[Partial handoff: task ended without return_task (runner_error:"));
      assert.ok(errHandoff.artifact_paths.some((p: string) => p.endsWith("err-notes.md")));

      // 2. Harness cancel -> status cancelled and partial fallback with earlier artifact_write
      const cancelTask = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Cancel scout",
        objective: "CASE_CANCEL",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await cancelStarted.promise;
      await daemon.orchestrator.cancelTask(cancelTask.id, "user abort");
      const cancelDeadline = Date.now() + 5_000;
      while (Date.now() < cancelDeadline && daemon.orchestrator.activeTaskCount() > 0) {
        await new Promise((r) => setTimeout(r, 15));
      }
      const cancelRow = daemon.db.getTask(cancelTask.id)!;
      const cancelHandoff = compactTaskHandoff(cancelRow);
      assert.equal(cancelHandoff.status, "cancelled");
      assert.equal((cancelHandoff as { partial?: boolean }).partial, true);
      assert.ok(cancelHandoff.summary?.startsWith("[Partial handoff: task ended without return_task (cancelled: user abort)"));
      assert.ok(cancelHandoff.artifact_paths.some((p: string) => p.endsWith("cancel-notes.md")));

      // 3. return_task partial: true with only artifact_paths (no sources) -> accepted, partial: true, "[Partial] " prefix
      const partialTask = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Partial scout",
        objective: "CASE_PARTIAL_RETURN",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const partialSettled = await waitSettled(partialTask.id);
      const partialHandoff = compactTaskHandoff(partialSettled);
      assert.equal(partialHandoff.status, "completed");
      assert.equal((partialHandoff as { partial?: boolean }).partial, true);
      assert.ok(partialHandoff.summary?.startsWith("[Partial] Verified area A"));
      assert.ok(partialHandoff.artifact_paths.some((p: string) => p.endsWith("partial-dossier.md")));

      // 4. Tier 3 widening onToolEvent -> emits agent.scope_nudge and agent.steered with "[Harness scope check]"
      const widenT3 = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Widening T3",
        objective: "CASE_WIDEN",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitSettled(widenT3.id);
      const t3Events = daemon.db.getEventsSince(run.id, 0, widenT3.id);
      assert.ok(
        t3Events.some((e) => e.type === "agent.scope_nudge"),
        "Tier 3 widening sequence must emit agent.scope_nudge",
      );
      assert.ok(
        t3Events.some(
          (e) =>
            e.type === "agent.steered" &&
            String((e.payload as { message?: string } | null)?.message ?? "").includes("[Harness scope check]"),
        ),
        "Tier 3 widening sequence must emit agent.steered with [Harness scope check]",
      );

      // 5. Same widening sequence on Tier 2 -> no scope nudge and no steer
      const widenT2 = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Widening T2",
        objective: "CASE_WIDEN",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitSettled(widenT2.id);
      const t2Events = daemon.db.getEventsSince(run.id, 0, widenT2.id);
      assert.equal(
        t2Events.some((e) => e.type === "agent.scope_nudge"),
        false,
        "Tier 2 worker must not receive Tier 3 scope nudges",
      );
      assert.equal(
        t2Events.some(
          (e) =>
            e.type === "agent.steered" &&
            String((e.payload as { message?: string } | null)?.message ?? "").includes("[Harness scope check]"),
        ),
        false,
        "Tier 2 worker must not be steered by scope check",
      );
    } finally {
      cancelGate.resolve();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
