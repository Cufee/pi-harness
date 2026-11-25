import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { spillSummaryOverflow, writeCodeOutput, writeTaskDossier } from "../src/control-plane/dossiers.js";
import { SUMMARY_LIMIT } from "../src/control-plane/handoffs.js";
import { GoalEngine } from "../src/goals/engine.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit, WorktreeManager } from "../src/worktree/manager.js";

const ORIGINAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function initTempGitRepo(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, ".gitignore"), "node_modules/\n", "utf8");
  writeFileSync(join(dir, "README.md"), "# temp repo\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
}

afterEach(() => {
  if (ORIGINAL_LAYOUT_ENV === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = ORIGINAL_LAYOUT_ENV;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("WorktreeManager and repo-cleanliness (data-dir layout)", () => {
  it("creates worker and scratch worktrees under data-dir, links node_modules, lists and sweeps legacy worktrees, and preserves layout on updateConfig", async () => {
    const root = makeTempDir("pi-dd-wt-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    await initTempGitRepo(repo);

    // Seed a gitignored node_modules directory so linkIgnoredNodeModules is exercised for out-of-repo worktrees.
    mkdirSync(join(repo, "node_modules", "demo-pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "demo-pkg", "index.js"), "module.exports = 42;\n", "utf8");

    const db = new ControlPlaneDb(":memory:");
    try {
      const legacySp = createLegacyStoragePaths();
      const legacyMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, legacySp);
      const { baseBranch, baseSha } = await legacyMgr.resolveRepoInfo();

      // 1. Pre-existing legacy worktree registered under <repo>/.harness/worktrees/
      const legacyRun = db.createRun({ goal: "Legacy run", repoRoot: repo, baseBranch, baseSha, chatSessionId: "chat-1" });
      const legacyTask = db.createTask({
        runId: legacyRun.id,
        tier: 2,
        kind: "worker",
        title: "Legacy worker",
        objective: "Pre-flip work",
        profileId: "acp:claude",
      });
      const legacyWt = await legacyMgr.createForWorker(legacyRun.id, legacyTask.id, baseSha);
      assert.equal(legacyWt.path.startsWith(join(repo, ".harness", "worktrees")), true);

      // Mark legacy task completed so its worktree is eligible for sweep.
      db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(legacyTask.id);

      // 2. Switch to data-dir WorktreeManager.
      const ddSp = storagePaths({ stateDir }, { layout: "data-dir" });
      const ddMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, ddSp);
      const projDir = ddSp.projectDir(repo);

      // 3. New worker worktree lands under data-dir, links ignored node_modules cleanly, and writes project.json.
      const newRun = db.createRun({ goal: "Data-dir run", repoRoot: repo, baseBranch, baseSha, chatSessionId: "chat-2" });
      const newTask = db.createTask({
        runId: newRun.id,
        tier: 2,
        kind: "worker",
        title: "New worker",
        objective: "Post-flip work",
        profileId: "acp:claude",
      });
      const newWt = await ddMgr.createForWorker(newRun.id, newTask.id, baseSha);
      assert.equal(newWt.path, join(projDir, "chats", "chat-2", "worktrees", newRun.id, newTask.id));
      assert.equal(existsSync(newWt.path), true);
      assert.equal(existsSync(join(projDir, "project.json")), true);
      assert.equal(lstatSync(join(newWt.path, "node_modules")).isSymbolicLink(), true);
      assert.equal(await ddMgr.isDirty(newWt.path), false);

      // 4. Scratch worktree lands under data-dir scratch/_verify and is excluded from listLive.
      const scratch = await ddMgr.addScratchWorktree("_verify", "v1", baseSha);
      assert.equal(scratch.path, join(projDir, "scratch", "_verify", "v1"));
      assert.equal(existsSync(scratch.path), true);

      // 5. listLive sees BOTH the new data-dir worktree and the pre-existing legacy worktree, and excludes scratch.
      const legacyWtReal = realpathSync(legacyWt.path);
      const newWtReal = realpathSync(newWt.path);
      const live = await ddMgr.listLive();
      const livePaths = live.map((l) => l.path).sort();
      assert.deepEqual(livePaths, [legacyWtReal, newWtReal].sort());
      assert.equal(live.find((l) => l.path === legacyWtReal)?.orphaned, true);
      assert.equal(live.find((l) => l.path === newWtReal)?.orphaned, false);

      // 6. sweep retires the pre-existing legacy worktree and leaves the active data-dir worktree intact.
      const report = await ddMgr.sweep();
      assert.deepEqual(report.errors, []);
      assert.deepEqual(report.removed, [legacyWtReal]);
      assert.equal(existsSync(legacyWt.path), false);
      assert.equal(existsSync(newWt.path), true);

      // 7. updateConfig preserves the injected data-dir StoragePaths instance.
      ddMgr.updateConfig({ maxConcurrentWorkers: 8 });
      const task2 = db.createTask({
        runId: newRun.id,
        tier: 2,
        kind: "worker",
        title: "Second worker",
        objective: "After config reload",
        profileId: "acp:claude",
      });
      const wt2 = await ddMgr.createForWorker(newRun.id, task2.id, baseSha);
      assert.equal(wt2.path, join(projDir, "chats", "chat-2", "worktrees", newRun.id, task2.id));

      // Cleanup scratch and active worktrees.
      await scratch.remove();
      assert.equal(existsSync(scratch.path), false);
      db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id IN (?, ?)").run(newTask.id, task2.id);
      const finalSweep = await ddMgr.sweep();
      assert.deepEqual(finalSweep.errors, []);
      assert.equal(finalSweep.removed.length, 2);
    } finally {
      db.close();
    }
  });

  it("keeps a fresh git repository completely clean (no .harness, empty git status --porcelain) across all data-dir operations (c2)", async () => {
    const root = makeTempDir("pi-dd-clean-repo-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    await initTempGitRepo(repo);

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const db = new ControlPlaneDb(":memory:");
    try {
      const mgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, sp);
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();

      const owner = { repoRoot: repo, chatSessionId: "chat-1" };
      const engine = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
      const goal = engine.createGoal({
        chatSessionId: "chat-1",
        repoRoot: repo,
        title: "Clean repo goal",
        description: "All data goes to data-dir",
        criteria: [{ id: "c1", description: "Clean", kind: "behavioral", required: true }],
      });
      writeFileSync(join(engine.evidenceDir(goal), "evidence.md"), "evidence\n", "utf8");

      const run = db.createRun({ goal: "Clean run", repoRoot: repo, baseBranch, baseSha, chatSessionId: "chat-1" });
      engine.linkRunAndStart(goal.id, run.id);
      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Do work",
        profileId: "acp:claude",
      });

      // Dossier, spill, code output
      const dossier = writeTaskDossier(db, run, task.id, "dossier.md", "dossier\n", "Dossier", sp);
      const spill = spillSummaryOverflow(db, run, task.id, "X".repeat(SUMMARY_LIMIT + 300), sp);
      const codeOut = writeCodeOutput(db, run, task.id, "out.json", '{"clean":true}', sp);
      assert.equal(existsSync(dossier.path), true);
      assert.equal(existsSync(spill.overflowPath!), true);
      assert.equal(existsSync(codeOut), true);

      // Notes roots (chat notes and project notes)
      const chatNotes = sp.notesDir(owner);
      const projNotes = sp.projectNotesDir(repo);
      mkdirSync(chatNotes, { recursive: true });
      mkdirSync(projNotes, { recursive: true });
      writeFileSync(join(chatNotes, "chat-note.md"), "chat note\n", "utf8");
      writeFileSync(join(projNotes, "project-note.md"), "project note\n", "utf8");

      // Worker worktree and scratch worktree
      const wt = await mgr.createForWorker(run.id, task.id, baseSha);
      const scratch = await mgr.addScratchWorktree("_integration", "i1", baseSha);
      assert.equal(existsSync(wt.path), true);
      assert.equal(existsSync(scratch.path), true);

      // Assert <repo>/.harness does NOT exist and `git status --porcelain` is empty.
      assert.equal(existsSync(join(repo, ".harness")), false);
      const status = await runGit(repo, ["status", "--porcelain"]);
      assert.equal(status.stdout.trim(), "");

      // Verify project.json was written once under data-dir.
      const projJson = JSON.parse(readFileSync(join(sp.projectDir(repo), "project.json"), "utf8"));
      assert.equal(projJson.root, repo);

      await scratch.remove();
      db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(task.id);
      await mgr.sweep();
    } finally {
      db.close();
    }
  });

  it("refuses symlinked or non-directory components below projectDir for worker and scratch worktrees in data-dir layout without modifying link targets, while leaving legacy layout unchanged (G2)", async () => {
    const root = makeTempDir("pi-dd-wt-symlink-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const outsideWorktrees = join(root, "outside-worktrees");
    const outsideVerify = join(root, "outside-verify");
    const outsideIntegration = join(root, "outside-integration");
    const outsideScratch = join(root, "outside-scratch");
    const outsideLeaf = join(root, "outside-leaf");
    const outsideScratchLeaf = join(root, "outside-scratch-leaf");
    const outsideLegacy = join(root, "outside-legacy");
    for (const dir of [
      stateDir,
      outsideWorktrees,
      outsideVerify,
      outsideIntegration,
      outsideScratch,
      outsideLeaf,
      outsideScratchLeaf,
      outsideLegacy,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    await initTempGitRepo(repo);

    const ddSp = storagePaths({ stateDir }, { layout: "data-dir" });
    const db = new ControlPlaneDb(":memory:");
    try {
      const ddMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, ddSp);
      const { baseBranch, baseSha } = await ddMgr.resolveRepoInfo();
      const projDir = ddSp.ensureProjectDir(repo);

      // 1. Symlinked parent at chats/chat-1/worktrees refuses worker worktree creation and leaves target empty.
      const run1 = db.createRun({ goal: "Symlink parent run", repoRoot: repo, baseBranch, baseSha, chatSessionId: "chat-1" });
      const task1 = db.createTask({
        runId: run1.id,
        tier: 2,
        kind: "worker",
        title: "Worker 1",
        objective: "Should be refused",
        profileId: "acp:claude",
      });
      mkdirSync(join(projDir, "chats", "chat-1"), { recursive: true });
      const badWtParent = join(projDir, "chats", "chat-1", "worktrees");
      symlinkSync(outsideWorktrees, badWtParent);
      await assert.rejects(
        () => ddMgr.createForWorker(run1.id, task1.id, baseSha),
        (err: unknown) => err instanceof Error && err.message.includes(badWtParent),
      );
      assert.deepEqual(readdirSync(outsideWorktrees), []);
      assert.equal(db.listWorktrees(run1.id).length, 0);

      // 2. Non-directory file at chats/chat-2/worktrees refuses worker worktree creation.
      const run2 = db.createRun({ goal: "File parent run", repoRoot: repo, baseBranch, baseSha, chatSessionId: "chat-2" });
      const task2 = db.createTask({
        runId: run2.id,
        tier: 2,
        kind: "worker",
        title: "Worker 2",
        objective: "Should be refused",
        profileId: "acp:claude",
      });
      mkdirSync(join(projDir, "chats", "chat-2"), { recursive: true });
      const fileWtParent = join(projDir, "chats", "chat-2", "worktrees");
      writeFileSync(fileWtParent, "not a directory\n", "utf8");
      await assert.rejects(
        () => ddMgr.createForWorker(run2.id, task2.id, baseSha),
        (err: unknown) => err instanceof Error && err.message.includes(fileWtParent),
      );
      assert.equal(db.listWorktrees(run2.id).length, 0);

      // 3. Symlinked scratch/_verify and scratch/_integration parents refuse scratch creation and leave targets empty.
      mkdirSync(join(projDir, "scratch"), { recursive: true });
      const badVerifyDir = join(projDir, "scratch", "_verify");
      const badIntegrationDir = join(projDir, "scratch", "_integration");
      symlinkSync(outsideVerify, badVerifyDir);
      symlinkSync(outsideIntegration, badIntegrationDir);
      await assert.rejects(
        () => ddMgr.addScratchWorktree("_verify", "v1", baseSha),
        (err: unknown) => err instanceof Error && err.message.includes(badVerifyDir),
      );
      assert.deepEqual(readdirSync(outsideVerify), []);
      await assert.rejects(
        () => ddMgr.addScratchWorktree("_integration", "i1", baseSha),
        (err: unknown) => err instanceof Error && err.message.includes(badIntegrationDir),
      );
      assert.deepEqual(readdirSync(outsideIntegration), []);

      // 4. Symlinked scratch leaf refuses scratch creation and leaves target empty.
      rmSync(badVerifyDir, { force: true });
      mkdirSync(badVerifyDir, { recursive: true });
      const badScratchLeaf = join(badVerifyDir, "leaf-link");
      symlinkSync(outsideScratchLeaf, badScratchLeaf);
      await assert.rejects(
        () => ddMgr.addScratchWorktree("_verify", "leaf-link", baseSha),
        (err: unknown) => err instanceof Error && err.message.includes(badScratchLeaf),
      );
      assert.deepEqual(readdirSync(outsideScratchLeaf), []);

      // 5. Symlinked top-level scratch dir refuses scratch creation and leaves target empty.
      rmSync(join(projDir, "scratch"), { recursive: true, force: true });
      const badScratchRoot = join(projDir, "scratch");
      symlinkSync(outsideScratch, badScratchRoot);
      await assert.rejects(
        () => ddMgr.addScratchWorktree("_verify", "v2", baseSha),
        (err: unknown) => err instanceof Error && err.message.includes(badScratchRoot),
      );
      assert.deepEqual(readdirSync(outsideScratch), []);

      // 6. Symlinked worker leaf refuses worker worktree creation and leaves target empty.
      const run3 = db.createRun({ goal: "Symlink leaf run", repoRoot: repo, baseBranch, baseSha, chatSessionId: "chat-3" });
      const task3 = db.createTask({
        runId: run3.id,
        tier: 2,
        kind: "worker",
        title: "Worker 3",
        objective: "Should be refused at leaf",
        profileId: "acp:claude",
      });
      const run3Parent = join(projDir, "chats", "chat-3", "worktrees", run3.id);
      mkdirSync(run3Parent, { recursive: true });
      const badLeaf = join(run3Parent, task3.id);
      symlinkSync(outsideLeaf, badLeaf);
      await assert.rejects(
        () => ddMgr.createForWorker(run3.id, task3.id, baseSha),
        (err: unknown) => err instanceof Error && err.message.includes(badLeaf),
      );
      assert.deepEqual(readdirSync(outsideLeaf), []);
      assert.equal(db.listWorktrees(run3.id).length, 0);

      // 7. Legacy layout remains unchanged (still allows symlinked worktrees root).
      mkdirSync(join(repo, ".harness"), { recursive: true });
      symlinkSync(outsideLegacy, join(repo, ".harness", "worktrees"));
      const legacySp = createLegacyStoragePaths();
      const legacyMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, legacySp);
      const legacyRun = db.createRun({ goal: "Legacy symlink run", repoRoot: repo, baseBranch, baseSha, chatSessionId: "chat-4" });
      const legacyTask = db.createTask({
        runId: legacyRun.id,
        tier: 2,
        kind: "worker",
        title: "Legacy worker",
        objective: "Legacy unchanged",
        profileId: "acp:claude",
      });
      const legacyWt = await legacyMgr.createForWorker(legacyRun.id, legacyTask.id, baseSha);
      assert.equal(existsSync(legacyWt.path), true);
      const legacyScratch = await legacyMgr.addScratchWorktree("_verify", "legacy-v1", baseSha);
      assert.equal(existsSync(legacyScratch.path), true);
      await legacyScratch.remove();
      db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id = ?").run(legacyTask.id);
      await legacyMgr.sweep();
    } finally {
      db.close();
    }
  });
});
