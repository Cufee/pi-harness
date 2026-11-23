import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { writeCodeOutput } from "../src/control-plane/dossiers.js";
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
});
