import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { resolveConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { GoalEngine } from "../src/goals/engine.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, resolveStorageLayout, storagePaths } from "../src/storage/paths.js";
import { runGit, WorktreeManager } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const initialStorageLayout = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (initialStorageLayout === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = initialStorageLayout;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("default storage layout (data-dir)", () => {
  it("resolves data-dir with no env and no option, places goal/artifacts/notes/worktree under <stateDir>/data/projects/<key>/chats/<chat>/, and creates nothing in the repo", async () => {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
    resetStoragePathsForTest();

    const root = makeTempDir("pi-default-layout-");
    const stateDir = join(root, "state");
    const repoRoot = join(root, "my-project");
    mkdirSync(stateDir, { recursive: true });
    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# demo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
    const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

    assert.equal(resolveStorageLayout(), "data-dir");

    const cfg = resolveConfig({}, {}, { stateDir });
    const sp = storagePaths(cfg);
    assert.equal(sp.layout, "data-dir");

    const chatId = "chat-42";
    const key = sp.projectKey(repoRoot);
    const expectedChatRoot = join(stateDir, "data", "projects", key, "chats", chatId);

    const owner = { repoRoot, chatSessionId: chatId };
    const goal = { ...owner, id: "goal-1" };
    const runRef = { ...owner, id: "run-1" };

    // Goal evidence dir
    const evidenceDir = sp.ensureGoalEvidenceDir(goal);
    assert.equal(evidenceDir, join(expectedChatRoot, "goals", "goal-1"));
    assert.equal(existsSync(evidenceDir!), true);

    // Run artifacts dir
    const runArtifactsDir = sp.ensureDossierDir(runRef, runRef.id, "t-1");
    assert.equal(runArtifactsDir, join(expectedChatRoot, "artifacts", "run-1", "t-1"));
    assert.equal(existsSync(runArtifactsDir), true);

    // Director note under chat notes/
    const chatNotesDir = sp.notesDir(owner);
    const notePath = join(chatNotesDir, "decision.md");
    assert.equal(chatNotesDir, join(expectedChatRoot, "notes"));
    assert.equal(sp.directorWritePolicy(owner, notePath).ok, true);
    mkdirSync(chatNotesDir, { recursive: true });
    writeFileSync(notePath, "# Note\n", "utf8");
    assert.equal(existsSync(notePath), true);

    // Worktree path (both path helper and real WorktreeManager checkout)
    const expectedWorktreePath = sp.worktreePath(runRef, "t-1");
    assert.equal(expectedWorktreePath, join(expectedChatRoot, "worktrees", "run-1", "t-1"));

    const db = new ControlPlaneDb(":memory:");
    try {
      const dbRun = db.createRun({
        goal: "Verify default data-dir layout",
        repoRoot,
        baseBranch: "main",
        baseSha,
        chatSessionId: chatId,
      });
      const worker = db.createTask({
        runId: dbRun.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Check worktree placement",
        profileId: "acp:claude",
      });
      const mgr = new WorktreeManager(db, repoRoot, cfg.worktree, { stateDir }, sp);
      const wt = await mgr.createForWorker(dbRun.id, worker.id, baseSha);
      assert.equal(wt.path, join(expectedChatRoot, "worktrees", dbRun.id, worker.id));
      assert.equal(existsSync(wt.path), true);
      await mgr.teardown(wt.id);
    } finally {
      db.close();
    }

    // Nothing was created in the repository.
    assert.equal(existsSync(join(repoRoot, ".harness")), false);
    assert.equal((await runGit(repoRoot, ["status", "--porcelain"])).stdout, "");
  });

  it("migrates eligible legacy units automatically on daemon start with PI_HARNESS_STORAGE_LAYOUT unset while deferring active goals", async () => {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
    resetStoragePathsForTest();

    const root = makeTempDir("pi-default-layout-upgrade-");
    const stateDir = join(root, "state");
    const repoRoot = join(root, "legacy-repo");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const socketPath = join(stateDir, "daemon.sock");
    mkdirSync(stateDir, { recursive: true });
    await runGit(root, ["init", "-b", "main", repoRoot]);
    writeFileSync(join(repoRoot, "README.md"), "# legacy repo\n", "utf8");
    await runGit(repoRoot, ["add", "README.md"]);
    await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
    const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;

    // Seed legacy DB and legacy .harness units before starting the daemon under default (unset-env) layout.
    const seedDb = new ControlPlaneDb(dbPath);
    let doneGoalId: string;
    let doneRunId: string;
    let liveGoalId: string;
    let legacyDossierPath: string;
    try {
      const legacySp = createLegacyStoragePaths({ stateDir });
      const goals = new GoalEngine(seedDb.db, undefined, undefined, undefined, undefined, legacySp);
      const doneGoal = goals.createGoal({
        chatSessionId: "chat-1",
        repoRoot,
        title: "Completed legacy goal",
        description: "Eligible for startup migration",
        criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      });
      doneGoalId = doneGoal.id;
      const doneRun = seedDb.createRun({
        goal: doneGoal.title,
        repoRoot,
        baseBranch: "main",
        baseSha,
        chatSessionId: "chat-1",
      });
      doneRunId = doneRun.id;
      goals.linkRunAndStart(doneGoal.id, doneRun.id);
      const doneTask = seedDb.createTask({
        runId: doneRun.id,
        tier: 2,
        kind: "worker",
        title: "Finished worker",
        objective: "Write dossier",
        profileId: "acp:claude",
      });
      seedDb.updateTask(doneTask.id, { status: "completed", summary: "done" });
      seedDb.updateRunStatus(doneRun.id, "completed", "done");
      goals.recordReviewVerdict(doneGoal.id, {
        verdict: "approved",
        criteriaResults: [{ criterionId: "c1", passed: true, evidence: "ok" }],
        blockingIssues: [],
        summary: "approved",
        diffHash: "abc",
      });

      const doneEvDir = join(repoRoot, ".harness", "goals", doneGoal.id);
      mkdirSync(doneEvDir, { recursive: true });
      writeFileSync(join(doneEvDir, "proof.md"), "completed goal proof\n", "utf8");

      const doneArtDir = join(repoRoot, ".harness", "artifacts", doneRun.id, doneTask.id);
      mkdirSync(doneArtDir, { recursive: true });
      legacyDossierPath = join(doneArtDir, "report.md");
      writeFileSync(legacyDossierPath, "migrated dossier body\n", "utf8");
      seedDb.recordArtifact({
        runId: doneRun.id,
        taskId: doneTask.id,
        kind: "dossier",
        path: legacyDossierPath,
        summary: "Legacy dossier",
      });

      mkdirSync(join(repoRoot, ".harness", "notes"), { recursive: true });
      writeFileSync(join(repoRoot, ".harness", "notes", "legacy-note.md"), "note body\n", "utf8");

      const liveGoal = goals.createGoal({
        chatSessionId: "chat-2",
        repoRoot,
        title: "Unfinished legacy goal",
        description: "Must remain deferred in repo",
        criteria: [{ id: "c1", description: "Pending", kind: "behavioral", required: true }],
      });
      liveGoalId = liveGoal.id;
      const liveEvDir = join(repoRoot, ".harness", "goals", liveGoal.id);
      mkdirSync(liveEvDir, { recursive: true });
      writeFileSync(join(liveEvDir, "wip.md"), "live wip\n", "utf8");
    } finally {
      seedDb.close();
    }

    // Start real daemon with PI_HARNESS_STORAGE_LAYOUT unset: default layout is data-dir and startup migrates completed units.
    assert.equal(process.env.PI_HARNESS_STORAGE_LAYOUT, undefined);
    const cfg = withFixtureCatalog({
      ...resolveConfig({}, {}, { stateDir, socketPath }),
      codeMode: "off",
    });
    const daemon = new HarnessDaemon(cfg, {
      dbPath,
      repoRoot,
      customRunnerFactory: () => ({ run: async () => ({ text: "ok", stopReason: "completed" }) }),
    });
    await daemon.start();
    try {
      const sp = storagePaths(cfg);
      assert.equal(sp.layout, "data-dir");

      const key = sp.projectKey(repoRoot);
      const migratedGoalFile = join(stateDir, "data", "projects", key, "chats", "chat-1", "goals", doneGoalId, "proof.md");
      const migratedNoteFile = join(stateDir, "data", "projects", key, "notes", "legacy-note.md");
      assert.equal(readFileSync(migratedGoalFile, "utf8"), "completed goal proof\n");
      assert.equal(readFileSync(migratedNoteFile, "utf8"), "note body\n");

      // Migrated legacy paths hold bridge symlinks; DB artifact path was rewritten into data-dir.
      assert.equal(lstatSync(join(repoRoot, ".harness", "goals", doneGoalId)).isSymbolicLink(), true);
      assert.equal(lstatSync(join(repoRoot, ".harness", "notes", "legacy-note.md")).isSymbolicLink(), true);
      const artifacts = daemon.db.listArtifacts(doneRunId);
      assert.equal(artifacts.length, 1);
      assert.ok(artifacts[0]!.path.startsWith(join(stateDir, "data", "projects", key, "chats", "chat-1", "artifacts", doneRunId)));
      assert.equal(readFileSync(artifacts[0]!.path, "utf8"), "migrated dossier body\n");

      // Unfinished live goal stayed in the repository (not a symlink).
      const liveDir = join(repoRoot, ".harness", "goals", liveGoalId);
      assert.equal(lstatSync(liveDir).isSymbolicLink(), false);
      assert.equal(lstatSync(liveDir).isDirectory(), true);
      assert.equal(readFileSync(join(liveDir, "wip.md"), "utf8"), "live wip\n");
    } finally {
      await daemon.stop();
    }
  });
});
