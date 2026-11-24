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

  it("fences evicted cancelled runners, cancelTask post-await updates, and Tier 2 return_task worktree awaits (esc-29)", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-cancel-fence-"));
    const repoRoot = join(root, "repo");
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");

    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

    const gen1ReturnGate = Promise.withResolvers<void>();
    const gen1ThrowGate = Promise.withResolvers<void>();
    const gen2ReturnGate = Promise.withResolvers<void>();
    const gen2ThrowGate = Promise.withResolvers<void>();
    const gen1ReturnStarted = Promise.withResolvers<void>();
    const gen1ThrowStarted = Promise.withResolvers<void>();
    const gen2ReturnStarted = Promise.withResolvers<void>();
    const gen2ThrowStarted = Promise.withResolvers<void>();
    const rescopeHandleGate = Promise.withResolvers<void>();
    const rescopeStarted = Promise.withResolvers<void>();
    const blockedHandleGate = Promise.withResolvers<void>();
    const blockedStarted = Promise.withResolvers<void>();
    const t2Started = Promise.withResolvers<void>();
    const t2Done = Promise.withResolvers<void>();

    const customRunnerFactory: CustomRunnerFactory = () => ({
      async run(req) {
        req.onHandle?.({
          steer: async () => true,
          cancel: async () => {
            if (req.initialPrompt.includes("CASE_CANCEL_RACE_RESCOPE")) {
              await rescopeHandleGate.promise;
            } else if (req.initialPrompt.includes("CASE_CANCEL_RACE_BLOCKED")) {
              await blockedHandleGate.promise;
            }
          },
        });
        if (req.initialPrompt.includes("CASE_EVICT_RETURN")) {
          if (req.taskGeneration === 1) {
            gen1ReturnStarted.resolve();
            await gen1ReturnGate.promise;
            return { text: "stale gen 1 output that must never overwrite gen 2", stopReason: "cancelled" };
          }
          gen2ReturnStarted.resolve();
          await gen2ReturnGate.promise;
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Gen 2 completed cleanly",
            sources: [{ path: "README.md", note: "gen 2" }],
          });
          return { text: "gen 2 done", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_EVICT_THROW")) {
          if (req.taskGeneration === 1) {
            gen1ThrowStarted.resolve();
            await gen1ThrowGate.promise;
            throw new Error("stale gen 1 threw after eviction");
          }
          gen2ThrowStarted.resolve();
          await gen2ThrowGate.promise;
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Gen 2 survived gen 1 throw",
            sources: [{ path: "README.md", note: "gen 2" }],
          });
          return { text: "gen 2 done", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_CANCEL_RACE_RESCOPE")) {
          await req.executeTool("return_task", {
            status: "scope_too_large",
            summary: "Accepted rescope before cancel unwind finished",
            sources: [{ path: "README.md", note: "scope check" }],
            evidence_paths: ["README.md"],
            suggested_splits: ["Split part A", "Split part B"],
          });
          rescopeStarted.resolve();
          await rescopeHandleGate.promise;
          return { text: "", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_CANCEL_RACE_BLOCKED")) {
          await req.executeTool("report_issue", {
            severity: "P1",
            category: "dependency_missing",
            title: "Accepted block before cancel unwind finished",
            evidence_paths: ["README.md"],
            blocking: true,
          });
          blockedStarted.resolve();
          await blockedHandleGate.promise;
          return { text: "", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_T2_RETURN_RACE")) {
          t2Started.resolve();
          await t2Done.promise;
          return { text: "", stopReason: "completed" };
        }
        return { text: "", stopReason: "completed" };
      },
    });

    const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, socketPath: sockPath, codeMode: "off" });
    const daemon = new HarnessDaemon(config, { customRunnerFactory });
    (daemon.orchestrator as unknown as { cancelUnwindTimeoutMs: number }).cancelUnwindTimeoutMs = 25;
    await daemon.start();

    try {
      const run = daemon.db.createRun({ goal: "Cancel fence tests", repoRoot, baseBranch: "main", baseSha });
      const parent = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(parent.id, { status: "running" });

      const waitSettled = async (taskId: string) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const t = daemon.db.getTask(taskId);
          if (t && ["completed", "failed", "cancelled", "returned_for_rescope", "blocked"].includes(t.status)) return t;
          await Bun.sleep(10);
        }
        throw new Error(`Timed out waiting for ${taskId}`);
      };

      // 1a. Evicted gen 1 runner returning late must NOT cancel or write dossiers onto gen 2.
      const tRet = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Evict return",
        objective: "CASE_EVICT_RETURN",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await gen1ReturnStarted.promise;
      await daemon.orchestrator.cancelTask(tRet.id, "evict gen 1");
      const resumedRet = await daemon.orchestrator.resumeTaskDetailed(tRet.id);
      assert.equal(resumedRet.task.generation, 2);
      await gen2ReturnStarted.promise;
      gen1ReturnGate.resolve();
      await Bun.sleep(50);
      const midRet = daemon.db.getTask(tRet.id)!;
      assert.equal(midRet.generation, 2);
      assert.equal(midRet.status, "running", "Stale gen 1 return must not cancel gen 2");
      assert.equal(
        daemon.db.listArtifacts(run.id, tRet.id).some((a) => a.path.includes("output-gen1")),
        false,
        "Evicted gen 1 must not create stray output-gen1 dossier while gen 2 runs",
      );
      gen2ReturnGate.resolve();
      const finalRet = await waitSettled(tRet.id);
      assert.equal(finalRet.status, "completed");
      assert.equal(finalRet.summary, "Gen 2 completed cleanly");

      // 1b. Evicted gen 1 runner throwing late must NOT cancel or overwrite gen 2.
      const tThrow = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Evict throw",
        objective: "CASE_EVICT_THROW",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await gen1ThrowStarted.promise;
      await daemon.orchestrator.cancelTask(tThrow.id, "evict gen 1 throw");
      const resumedThrow = await daemon.orchestrator.resumeTaskDetailed(tThrow.id);
      assert.equal(resumedThrow.task.generation, 2);
      await gen2ThrowStarted.promise;
      gen1ThrowGate.resolve();
      await Bun.sleep(50);
      const midThrow = daemon.db.getTask(tThrow.id)!;
      assert.equal(midThrow.generation, 2);
      assert.equal(midThrow.status, "running", "Stale gen 1 throw must not cancel gen 2");
      gen2ThrowGate.resolve();
      const finalThrow = await waitSettled(tThrow.id);
      assert.equal(finalThrow.status, "completed");
      assert.equal(finalThrow.summary, "Gen 2 survived gen 1 throw");

      // 1c. cancelTask must NOT overwrite an accepted returned_for_rescope or blocked status.
      const tRescope = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Rescope race",
        objective: "CASE_CANCEL_RACE_RESCOPE",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await rescopeStarted.promise;
      const cancelRescopeP = daemon.orchestrator.cancelTask(tRescope.id, "late cancel");
      await Bun.sleep(30);
      rescopeHandleGate.resolve();
      await cancelRescopeP;
      assert.equal(daemon.db.getTask(tRescope.id)?.status, "returned_for_rescope");

      const blockedParent = daemon.db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Blocked race worker",
        objective: "Parent worker for writable execute task",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(blockedParent.id, { status: "running" });
      await daemon.orchestrator.getWorktreeManager(repoRoot).createForWorker(run.id, blockedParent.id);

      const tBlocked = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: blockedParent.id,
        tier: 3,
        kind: "execute",
        title: "Blocked race",
        objective: "CASE_CANCEL_RACE_BLOCKED",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await blockedStarted.promise;
      const cancelBlockedP = daemon.orchestrator.cancelTask(tBlocked.id, "late cancel on blocked");
      await Bun.sleep(30);
      blockedHandleGate.resolve();
      await cancelBlockedP;
      assert.equal(daemon.db.getTask(tBlocked.id)?.status, "blocked");

      // 1d. Tier 2 return_task must revalidate generation/status/cancel after awaited worktree checks.
      const t2 = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Tier 2 return race",
        objective: "CASE_T2_RETURN_RACE",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await t2Started.promise;
      const wtMgr = daemon.orchestrator.getWorktreeManager(repoRoot);
      const origIsDirty = wtMgr.isDirty.bind(wtMgr);
      let cancelTriggered = false;
      wtMgr.isDirty = async (wtPath: string) => {
        const res = await origIsDirty(wtPath);
        if (!cancelTriggered) {
          cancelTriggered = true;
          await daemon.orchestrator.cancelTask(t2.id, "cancelled during return_task worktree check");
        }
        return res;
      };
      try {
        await assert.rejects(
          () =>
            daemon.orchestrator.toolExecutor.execute(run.id, t2.id, "return_task", {
              status: "completed",
              summary: "Oversized summary ".repeat(200),
            }),
          /aborted|rejected|Stale/,
        );
      } finally {
        wtMgr.isDirty = origIsDirty;
        t2Done.resolve();
      }
      assert.equal(daemon.db.getTask(t2.id)?.status, "cancelled", "Cancelled Tier 2 row must not be overwritten by raced return_task");
      assert.equal(
        daemon.db.listArtifacts(run.id, t2.id).some((a) => a.path.includes("-summary-")),
        false,
        "Rejected raced return_task must not spill a summary overflow dossier",
      );
    } finally {
      gen1ReturnGate.resolve();
      gen1ThrowGate.resolve();
      gen2ReturnGate.resolve();
      gen2ThrowGate.resolve();
      rescopeHandleGate.resolve();
      blockedHandleGate.resolve();
      t2Done.resolve();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes partial fallbacks on daemon restart, worktree alloc failure, launch failure, and blocking report_issue, and routes Code Mode inner events to Tier 3 scope monitor", async () => {
    const root = realpathSync(mkdtempSync("/tmp/pi-fallbacks-codemode-"));
    const repoRoot = join(root, "repo");
    const stateDir = join(root, "state");
    const sockPath = join(stateDir, "d.sock");

    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
    await runGit(repoRoot, ["add", "."]);
    await runGit(repoRoot, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
    const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

    const codeModeTaskReady = Promise.withResolvers<void>();
    const codeModeTaskRelease = Promise.withResolvers<void>();
    const codeModeSteers: string[] = [];

    const customRunnerFactory: CustomRunnerFactory = () => ({
      async run(req) {
        req.onHandle?.({
          steer: async (msg) => {
            if (req.initialPrompt.includes("CASE_CODE_MODE_INNER")) codeModeSteers.push(msg);
            return true;
          },
          cancel: async () => {},
        });
        if (req.initialPrompt.includes("CASE_LONG_FALLBACK")) {
          return { text: "L".repeat(2500), stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_CODE_MODE_INNER")) {
          codeModeTaskReady.resolve();
          await codeModeTaskRelease.promise;
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Finished after inner events",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }
        return { text: "", stopReason: "completed" };
      },
    });

    const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, socketPath: sockPath, codeMode: "off" });
    const daemon = new HarnessDaemon(config, { customRunnerFactory });
    await daemon.start();

    try {
      const run = daemon.db.createRun({ goal: "Fallbacks and inner code_exec", repoRoot, baseBranch: "main", baseSha });
      const parent = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      // 2a. Daemon-startup orphan failure: non-Tier-1 gets partial fallback + indexed artifacts; Tier 1 stays bare.
      const orphanT1 = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orphan T1",
        objective: "Orch",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(orphanT1.id, { status: "running" });
      const orphanT3 = daemon.db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Orphan T3",
        objective: "Research",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(orphanT3.id, { status: "running" });
      const orphanArt = (await daemon.orchestrator.toolExecutor.execute(run.id, orphanT3.id, "artifact_write", {
        name: "orphan-notes.md",
        content: "partial notes before crash",
        summary: "Orphan notes",
      })) as { path: string };

      daemon.orchestrator.reconcileStaleRunsOnStartup();

      const orphanT1Handoff = compactTaskHandoff(daemon.db.getTask(orphanT1.id)!);
      assert.equal(orphanT1Handoff.status, "failed");
      assert.equal((orphanT1Handoff as { partial?: boolean }).partial, undefined, "Tier 1 orphan must stay bare");

      const orphanT3Handoff = compactTaskHandoff(daemon.db.getTask(orphanT3.id)!);
      assert.equal(orphanT3Handoff.status, "failed");
      assert.equal((orphanT3Handoff as { partial?: boolean }).partial, true);
      assert.ok(orphanT3Handoff.summary?.includes("daemon_restart"));
      assert.ok(orphanT3Handoff.artifact_paths.includes(orphanArt.path));

      // 2b. Blocking report_issue: preserves status blocked + escalation, writes partial fallback + indexed artifacts (Tier 1 unchanged).
      const blockT3 = daemon.db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "execute",
        title: "Blocked T3",
        objective: "Research",
        readOnly: false,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(blockT3.id, { status: "running" });
      const blockArt = (await daemon.orchestrator.toolExecutor.execute(run.id, blockT3.id, "artifact_write", {
        name: "blocked-evidence.md",
        content: "evidence before block",
        summary: "Evidence",
      })) as { path: string };
      await daemon.orchestrator.toolExecutor.execute(run.id, blockT3.id, "report_issue", {
        severity: "P1",
        category: "dependency_missing",
        title: "Missing API credentials",
        evidence_paths: [blockArt.path],
        blocking: true,
      });
      const blockT3Row = daemon.db.getTask(blockT3.id)!;
      const blockT3Handoff = compactTaskHandoff(blockT3Row, daemon.db.listEscalations(run.id));
      assert.equal(blockT3Handoff.status, "blocked");
      assert.equal((blockT3Handoff as { partial?: boolean }).partial, true);
      assert.ok(blockT3Handoff.artifact_paths.includes(blockArt.path));
      assert.equal(blockT3Handoff.escalations.length, 1);
      assert.equal(blockT3Handoff.escalations[0]?.title, "Missing API credentials");

      const blockT1 = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Blocked T1",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      daemon.db.updateTask(blockT1.id, { status: "running" });
      await daemon.orchestrator.toolExecutor.execute(run.id, blockT1.id, "report_issue", {
        severity: "P0",
        category: "dependency_missing",
        title: "Tier 1 P0 block",
        evidence_paths: ["README.md"],
        blocking: true,
      });
      const blockT1Handoff = compactTaskHandoff(daemon.db.getTask(blockT1.id)!, daemon.db.listEscalations(run.id));
      assert.equal(blockT1Handoff.status, "blocked");
      assert.equal((blockT1Handoff as { partial?: boolean }).partial, undefined, "Tier 1 blocking report_issue must stay bare");

      // 2c. Initial worktree allocation failure: Tier 2 gets partial fallback.
      const wtMgr = daemon.orchestrator.getWorktreeManager(repoRoot);
      const origCreate = wtMgr.createForWorker.bind(wtMgr);
      wtMgr.createForWorker = async () => {
        throw new Error("simulated git worktree add failure");
      };
      let allocFailedId: string | undefined;
      try {
        await assert.rejects(
          () =>
            daemon.orchestrator.spawnAndStartTask({
              runId: run.id,
              parentId: parent.id,
              tier: 2,
              kind: "worker",
              title: "Alloc fail worker",
              objective: "Should fail alloc",
              readOnly: false,
              writeScopes: ["README.md"],
              profileId: "pi:local",
              model: "fixture/fixture",
            }),
          /simulated git worktree add failure/,
        );
        allocFailedId = daemon.db.listTasks(run.id).find((t) => t.title === "Alloc fail worker")?.id;
      } finally {
        wtMgr.createForWorker = origCreate;
      }
      assert.ok(allocFailedId);
      const allocHandoff = compactTaskHandoff(daemon.db.getTask(allocFailedId)!);
      assert.equal(allocHandoff.status, "failed");
      assert.equal((allocHandoff as { partial?: boolean }).partial, true);
      assert.ok(allocHandoff.summary?.includes("worktree_allocation_failed"));

      // 2d. Launch failure (launchTaskLoop .catch): non-Tier-1 gets partial fallback + indexed artifacts.
      const launchFailT3 = daemon.db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Launch fail T3",
        objective: "Bad profile",
        readOnly: true,
        profileId: "nonexistent:profile",
        model: "nonexistent/model",
      });
      const launchArt = (await daemon.orchestrator.toolExecutor.execute(run.id, launchFailT3.id, "artifact_write", {
        name: "pre-launch.md",
        content: "context",
        summary: "Pre-launch",
      })) as { path: string };
      daemon.orchestrator.launchTaskLoop(launchFailT3.id);
      const launchDeadline = Date.now() + 3_000;
      while (Date.now() < launchDeadline && daemon.db.getTask(launchFailT3.id)?.status !== "failed") {
        await Bun.sleep(10);
      }
      const launchHandoff = compactTaskHandoff(daemon.db.getTask(launchFailT3.id)!);
      assert.equal(launchHandoff.status, "failed");
      assert.equal((launchHandoff as { partial?: boolean }).partial, true);
      assert.ok(launchHandoff.summary?.includes("launch_failed"));
      assert.ok(launchHandoff.artifact_paths.includes(launchArt.path));

      // Non-blocking check: long clipped fallback output DOES set truncated:true and full_summary.
      const longTask = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Long fallback",
        objective: "CASE_LONG_FALLBACK",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const longDeadline = Date.now() + 3_000;
      while (Date.now() < longDeadline && daemon.db.getTask(longTask.id)?.status !== "failed") {
        await Bun.sleep(10);
      }
      const longHandoff = compactTaskHandoff(daemon.db.getTask(longTask.id)!) as {
        truncated?: boolean;
        full_summary?: { path: string };
      };
      assert.equal(longHandoff.truncated, true);
      assert.ok(longHandoff.full_summary?.path.includes("output-gen1"));

      // 4. Code Mode inner tool events (actual createCodeExecEventSink path) feed Tier 3 ScopeNudgeMonitor once per gen.
      const cmTask = await daemon.orchestrator.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Code Mode inner monitor",
        objective: "CASE_CODE_MODE_INNER",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await codeModeTaskReady.promise;
      const liveGen = daemon.db.getTask(cmTask.id)!.generation;
      const sink = daemon.orchestrator.toolExecutor.createCodeExecEventSink(run.id, cmTask.id, liveGen);

      // 3 distinct inner inspect_command calls at cwd '.' -> no nudge, 6 agent.tool events (start+end each, once).
      for (const file of ["a.ts", "b.ts", "c.ts"]) {
        const args = { cwd: ".", argv: ["cat", file] };
        sink({ name: "inspect_command", args, phase: "start", via: "code_exec" });
        sink({ name: "inspect_command", args, phase: "end", ok: true, result: "ok", via: "code_exec" });
      }
      const eventsAfterDistinct = daemon.db.getEventsSince(run.id, 0, cmTask.id);
      assert.equal(eventsAfterDistinct.filter((e) => e.type === "agent.tool").length, 6);
      assert.equal(eventsAfterDistinct.some((e) => e.type === "agent.scope_nudge"), false);

      // Stale-generation sink must be fenced out (no agent.tool emitted, no nudge).
      const staleSink = daemon.orchestrator.toolExecutor.createCodeExecEventSink(run.id, cmTask.id, liveGen + 99);
      for (let i = 0; i < 3; i++) {
        const args = { cwd: ".", argv: ["cat", "stale.ts"] };
        staleSink({ name: "inspect_command", args, phase: "start", via: "code_exec" });
        staleSink({ name: "inspect_command", args, phase: "end", ok: true, result: "ok", via: "code_exec" });
      }
      assert.equal(
        daemon.db.getEventsSince(run.id, 0, cmTask.id).filter((e) => e.type === "agent.tool").length,
        6,
        "Stale-generation inner events must be fenced out",
      );

      // 3 identical consecutive inner inspect_command calls -> triggers agent.scope_nudge and steers live task!
      for (let i = 0; i < 3; i++) {
        const args = { cwd: ".", argv: ["cat", "repeat.ts"] };
        sink({ name: "inspect_command", args, phase: "start", via: "code_exec" });
        sink({ name: "inspect_command", args, phase: "end", ok: true, result: "ok", via: "code_exec" });
      }
      await Bun.sleep(50);
      const eventsAfterRepeat = daemon.db.getEventsSince(run.id, 0, cmTask.id);
      assert.equal(eventsAfterRepeat.filter((e) => e.type === "agent.tool").length, 12);
      assert.ok(eventsAfterRepeat.some((e) => e.type === "agent.scope_nudge"), "Inner code_exec repeats must trigger scope nudge");
      assert.ok(
        codeModeSteers.some((m) => m.includes("[Harness scope check]")),
        "Inner code_exec scope nudge must steer the live Tier 3 task",
      );

      codeModeTaskRelease.resolve();
      const cmDeadline = Date.now() + 3_000;
      while (Date.now() < cmDeadline && daemon.db.getTask(cmTask.id)?.status !== "completed") {
        await Bun.sleep(10);
      }
      assert.equal(daemon.db.getTask(cmTask.id)?.status, "completed");
    } finally {
      codeModeTaskRelease.resolve();
      await daemon.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
