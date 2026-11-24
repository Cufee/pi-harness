import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ALL_RULES, AdvisoryEngine, buildSubject } from "../src/advisories/index.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb, type TaskRecord } from "../src/control-plane/db.js";
import { hashRunDossier, writeTaskDossier } from "../src/control-plane/dossiers.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import { ScopeNudgeMonitor } from "../src/runners/scope-nudge.js";
import type { RunnerCallbacks } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";
import { filesOutsideWriteScopes } from "../src/worktree/merge-queue.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "returned_for_rescope", "blocked"]);

async function makeTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; stateDir: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  const repoRoot = join(root, "repo");
  const stateDir = join(root, "state");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "a.ts"), "export const a = 1;\n", "utf8");
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, stateDir, baseSha };
}

function makeOrchestrator(repoRoot: string, stateDir: string, runnerFactory: CustomRunnerFactory) {
  const db = new ControlPlaneDb(":memory:");
  const config = withFixtureCatalog({
    ...loadConfig(repoRoot),
    stateDir,
    codeMode: "off",
  });
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);
  return { db, config, orch };
}

async function waitUntil(pred: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    id: "t-1",
    runId: "run-1",
    parentId: null,
    tier: 3,
    kind: "research",
    title: "Test task",
    objective: "Inspect workspace",
    criteria: "",
    readOnly: true,
    profileId: "pi:local",
    model: "fixture/fixture",
    effort: null,
    status: "running",
    generation: 1,
    maxTurns: 25,
    turnsUsed: 0,
    contextUsed: 0,
    contextSize: 200_000,
    worktreeId: null,
    sessionId: null,
    summary: null,
    handoffJson: null,
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("goal-14 fix FX-ORCH: safe dossier hashing, origin stripping, and FX-ADV follow-ups", () => {
  it("FXO-5a: a dossier path replaced by a symlink or a FIFO adds nothing and does not hang", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-fxo-5a-");
    const externalTarget = join(root, "external-big.txt");
    writeFileSync(externalTarget, "E".repeat(16_384), "utf8");

    let runs = 0;
    let savedDossierPath = "";

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runs += 1;
        if (runs === 1) {
          const wrote = (await req.executeTool("artifact_write", {
            name: "notes.md",
            content: "seed",
            summary: "seed dossier",
          })) as { path: string };
          savedDossierPath = wrote.path;
        } else if (runs === 2) {
          // Replace the indexed dossier with a symlink to a much larger external file.
          unlinkSync(savedDossierPath);
          symlinkSync(externalTarget, savedDossierPath);
        } else if (runs === 3) {
          // Replace the indexed dossier with a FIFO (named pipe) with no writer.
          unlinkSync(savedDossierPath);
          execFileSync("mkfifo", [savedDossierPath]);
        }
        return { text: `gen ${runs}`, stopReason: "rollover_requested" };
      },
    }));

    try {
      const run = db.createRun({ goal: "FXO-5a safe dossier hashing", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      // Direct unit checks on hashRunDossier for valid file, symlink, FIFO, and byte cap.
      const unitTask = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Unit dossier",
        objective: "Check hashRunDossier",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(unitTask.id, { status: "completed", summary: "unit fixture" });
      const rec = writeTaskDossier(db, run, unitTask.id, "direct.md", "hello world", "direct");
      const valid = await hashRunDossier(db, run, rec.path);
      assert.ok(valid !== null);
      assert.equal(valid.bytes, Buffer.byteLength("hello world"));

      const capped = await hashRunDossier(db, run, rec.path, { maxBytes: 4 });
      assert.equal(capped, null, "dossier exceeding maxBytes must return null");

      unlinkSync(rec.path);
      symlinkSync(externalTarget, rec.path);
      assert.equal(await hashRunDossier(db, run, rec.path), null, "symlinked dossier must return null");

      unlinkSync(rec.path);
      execFileSync("mkfifo", [rec.path]);
      const fifoStart = Date.now();
      assert.equal(await hashRunDossier(db, run, rec.path), null, "FIFO dossier must return null without hanging");
      assert.ok(Date.now() - fifoStart < 2_000, "FIFO check must not block");

      // End-to-end rollover check: symlink (gen 2) and FIFO (gen 3) add nothing and never hang -> stops on 3rd rollover.
      const task = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Rollover symlink and FIFO",
        objective: "Test safe rollover hashing",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const startMs = Date.now();
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 10_000, "FXO-5a terminal");
      assert.ok(Date.now() - startMs < 5_000, "Rollover must not hang on FIFO");
      assert.equal(runs, 3, "Symlink to larger external file and FIFO must add nothing to artHigh");
      assert.equal(db.getTask(task.id)?.status, "failed");
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FXO-5b: RunnerCallbacks.onArtifact cannot set origin='agent'; origin is stripped at persistence", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-fxo-5b-");
    let runs = 0;

    // Compile-time type check: origin is omitted from RunnerCallbacks["onArtifact"] parameter type.
    type OnArtifactParam = Parameters<NonNullable<RunnerCallbacks["onArtifact"]>>[0];
    const hasOriginKey: "origin" extends keyof OnArtifactParam ? true : false = false;
    assert.equal(hasOriginKey, false);

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runs += 1;
        // Write a real growing file under .harness/artifacts and try to spoof origin='agent' via onArtifact.
        const fakeDir = join(repoRoot, ".harness", "artifacts", req.runId, req.taskId);
        mkdirSync(fakeDir, { recursive: true });
        const fakePath = join(fakeDir, `spoof-${runs}.md`);
        writeFileSync(fakePath, "S".repeat(runs * 500), "utf8");
        req.callbacks.onArtifact?.({
          kind: "dossier",
          path: fakePath,
          summary: `spoofed ${runs}`,
          gitSha: null,
          exitCode: null,
          origin: "agent",
        } as unknown as OnArtifactParam);
        return { text: `spoof ${runs}`, stopReason: "rollover_requested" };
      },
    }));

    try {
      const run = db.createRun({ goal: "FXO-5b strip origin", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(parent.id, { status: "running" });

      const task = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Spoof origin via callback",
        objective: "Attempt origin spoofing",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 10_000, "FXO-5b terminal");

      // Growing spoofed dossiers did NOT mark origin='agent' and did NOT advance artHigh -> stopped on 3rd rollover.
      assert.equal(runs, 3);
      assert.equal(db.getTask(task.id)?.status, "failed");
      const recorded = db.listArtifacts(run.id, task.id, 50, "dossier");
      const spoofed = recorded.filter((a) => a.path.includes("spoof-"));
      assert.equal(spoofed.length, 3);
      for (const art of spoofed) {
        assert.equal(art.origin, undefined, "onArtifact must never persist origin='agent'");
      }
      assert.deepEqual(db.listAgentDossierPaths(run.id, task.id), []);

      // Contrast: writeTaskDossier still marks origin='agent'.
      const legit = writeTaskDossier(db, run, task.id, "real.md", "legit dossier", "legit");
      assert.equal(legit.origin, "agent");
      assert.deepEqual(db.listAgentDossierPaths(run.id, task.id), [legit.path]);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FXO-6a: '..config/x.ts' is treated as a legal in-workspace path by AdvisoryEngine and ScopeNudgeMonitor while '../outside/x.ts' is rejected", () => {
    const workspace = "/tmp/pi-fxo-6a-ws";
    const engine = new AdvisoryEngine({
      rules: ALL_RULES,
      createScopeSource: (s) => new ScopeNudgeMonitor({ workspaceRoot: s.workspaceRoot }),
      filesOutsideWriteScopes,
      harnessToolNames: new Set(["artifact_read", "artifact_write", "return_task"]),
      record: () => {},
    });
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-6a" }),
      workspaceRoot: workspace,
      writeScopes: [],
      writableExtraRoots: [],
    });

    // Legal in-workspace directory whose name begins with two dots.
    engine.observeEvent(subject, {
      id: "read-dotdot-name",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: JSON.stringify({ path: "..config/x.ts" }),
    });
    assert.equal(engine.activityProgress(subject.id), 1);

    // True parent traversal outside workspace must still be ignored.
    engine.observeEvent(subject, {
      id: "read-parent-escape",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: JSON.stringify({ path: "../outside/x.ts" }),
    });
    assert.equal(engine.activityProgress(subject.id), 1);

    // noteActivity follows the same exact component rule.
    engine.noteActivity(subject.id, ["..config/y.ts", "../escape/z.ts"]);
    assert.equal(engine.activityProgress(subject.id), 2);

    // ScopeNudgeMonitor buckets '..config/x.ts' inside workspace (not 'ext:...'), while '../outside/x.ts' is 'ext:...'.
    const monitor = new ScopeNudgeMonitor({ workspaceRoot: workspace });
    monitor.observe({
      id: "m-1",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: { path: "..config/x.ts" },
    });
    assert.deepEqual(monitor.signals().distinctAreas, ["..config"]);

    monitor.observe({
      id: "m-2",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: { path: "../outside/x.ts" },
    });
    const areas = monitor.signals().distinctAreas;
    assert.equal(areas.length, 2);
    assert.equal(areas[0], "..config");
    assert.ok(areas[1]!.startsWith("ext:"), `expected external area for '../outside/x.ts', got ${areas[1]}`);
  });

  it("FXO-6b: AdvisoryEngine.observeEvent forwards ev.result so repeated-call rule sees differing results", () => {
    const workspace = "/tmp/pi-fxo-6b-ws";
    const engine = new AdvisoryEngine({
      rules: ALL_RULES,
      createScopeSource: (s) => new ScopeNudgeMonitor({ workspaceRoot: s.workspaceRoot }),
      filesOutsideWriteScopes,
      harnessToolNames: new Set(["artifact_read", "artifact_write", "return_task"]),
      record: () => {},
    });
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-6b" }),
      workspaceRoot: workspace,
      writeScopes: [],
      writableExtraRoots: [],
    });

    // Three identical calls whose ev.result differs each time -> repeated-call notice suppressed.
    for (let i = 1; i <= 3; i += 1) {
      const pending = engine.observeEvent(subject, {
        id: `diff-${i}`,
        name: "read_file",
        kind: "read",
        status: "completed",
        args: JSON.stringify({ path: "src/a.ts" }),
        result: `version-${i}`,
      });
      assert.equal(pending, false, `call ${i} with differing ev.result must not trigger repeated-call notice`);
    }
    assert.deepEqual(engine.take(subject.id), []);

    // Three identical calls with the same ev.result -> repeated-call notice fires on the 3rd call.
    let fired = false;
    for (let i = 1; i <= 3; i += 1) {
      fired = engine.observeEvent(subject, {
        id: `same-${i}`,
        name: "read_file",
        kind: "read",
        status: "completed",
        args: JSON.stringify({ path: "src/b.ts" }),
        result: "unchanged-output",
      });
    }
    assert.equal(fired, true);
    const notices = engine.take(subject.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.rule, "scope-too-large");
    assert.ok(notices[0]!.what.includes("repeated"));
  });
});
