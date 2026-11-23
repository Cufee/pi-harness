import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { canonicalPath, runGit, WorktreeManager } from "../src/worktree/manager.js";
import { BisectingMergeQueue, checkTestIntegrity } from "../src/worktree/merge-queue.js";

async function initTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-wt-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# demo\n", "utf8");
  writeFileSync(join(dir, "app.test.js"), "test('ok', () => {});\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
  return dir;
}

describe("Git Worktrees, Bisecting Merge Queue, Test Integrity & Automated Cleanup", () => {
  it("creates worker worktree, merges cleanly via queue, and auto-tears down worktree", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Add feature", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Add hello.txt",
        objective: "Create hello.txt",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      assert.ok(existsSync(wt.path));

      writeFileSync(join(wt.path, "hello.txt"), "hello from worker\n", "utf8");
      await runGit(wt.path, ["add", "hello.txt"]);
      await runGit(wt.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "add hello"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, { ciCommands: ["test -f hello.txt"] });
      db.enqueueMerge({ runId: run.id, taskId: worker.id, worktreeId: wt.id, branch: wt.branch });
      const outcome = await mq.processNext(run.id);

      assert.equal(outcome?.item.status, "merged");
      assert.ok(outcome?.mergedSha);
      assert.equal(existsSync(wt.path), false, "Worktree must be automatically removed after clean merge");
      assert.equal(readFileSync(join(repo, "hello.txt"), "utf8").trim(), "hello from worker");
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("bounces test-skipping hacks via test-integrity guard and sweeps dirty orphaned worktrees with safety archive ref", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", archiveRetentionDays: 7 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Guard tests", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Sneaky skip",
        objective: "Edit test",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      writeFileSync(join(wt.path, "app.test.js"), "test.skip('ok', () => {});\n", "utf8");
      await runGit(wt.path, ["add", "app.test.js"]);
      await runGit(wt.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "skip test"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, {});
      db.enqueueMerge({ runId: run.id, taskId: worker.id, worktreeId: wt.id, branch: wt.branch });
      const outcome = await mq.processNext(run.id);

      assert.equal(outcome?.item.status, "ci_failed");
      assert.match(outcome?.bouncedReason ?? "", /Test-integrity check failed/);

      // Leave uncommitted dirty file and mark worker cancelled -> orphan sweeper archives & removes it
      writeFileSync(join(wt.path, "wip.txt"), "unsaved work\n", "utf8");
      db.updateTask(worker.id, { status: "cancelled" });

      const cleanup = await mgr.sweep({ runId: run.id });
      assert.equal(cleanup.removed.length, 1);
      assert.equal(cleanup.archivedRefs.length, 1);
      assert.equal(existsSync(wt.path), false);

      // Verify the safety archive git ref actually exists in git!
      const refCheck = await runGit(repo, ["rev-parse", cleanup.archivedRefs[0]!]);
      assert.ok(refCheck.stdout.length >= 40);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("materializes merged files safely when untracked files exist (like bun.lock) and auto-links gitignored node_modules", async () => {
    const repo = await initTempRepo();
    try {
      const { mkdirSync, lstatSync } = await import("node:fs");
      writeFileSync(join(repo, ".gitignore"), "node_modules/\n", "utf8");
      await runGit(repo, ["add", ".gitignore"]);
      await runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "ignore node_modules"]);
      mkdirSync(join(repo, "node_modules/fake-pkg"), { recursive: true });
      writeFileSync(join(repo, "node_modules/fake-pkg/index.js"), "export const ok = true;\n", "utf8");
      // Untracked file in repo root (just like bun.lock created by `bun install`)
      writeFileSync(join(repo, "bun.lock"), "# untracked lockfile\n", "utf8");

      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Merge with untracked lockfile", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Add feature.ts",
        objective: "Create feature.ts",
        profileId: "acp:codex",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      // Verify gitignored node_modules was automatically symlinked into the worker worktree!
      assert.ok(lstatSync(join(wt.path, "node_modules")).isSymbolicLink());
      assert.ok(existsSync(join(wt.path, "node_modules/fake-pkg/index.js")));

      writeFileSync(join(wt.path, "feature.ts"), "export const answer = 42;\n", "utf8");
      await runGit(wt.path, ["add", "feature.ts"]);
      await runGit(wt.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "add feature"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, { ciCommands: ["test -f node_modules/fake-pkg/index.js"] });
      db.enqueueMerge({ runId: run.id, taskId: worker.id, worktreeId: wt.id, branch: wt.branch });
      const outcome = await mq.processNext(run.id);

      assert.equal(outcome?.item.status, "merged");
      // Merged file MUST exist on disk AND NOT be staged as a deletion!
      assert.equal(readFileSync(join(repo, "feature.ts"), "utf8").trim(), "export const answer = 42;");
      assert.equal(readFileSync(join(repo, "bun.lock"), "utf8").trim(), "# untracked lockfile");
      const status = (await runGit(repo, ["status", "--porcelain"])).stdout;
      assert.ok(!status.includes("D  feature.ts"), `Unexpected staged deletion in git status:\n${status}`);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("serializes concurrent submitAndDrain from 2 workers and preserves live task/worktree when preserveLiveTask is true", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Concurrent merges", repoRoot: repo, baseBranch, baseSha });

      const w1 = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker 1",
        objective: "Add one.txt",
        profileId: "acp:claude",
      });
      const w2 = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker 2",
        objective: "Add two.txt",
        profileId: "acp:claude",
      });
      db.updateTask(w1.id, { status: "running" });
      db.updateTask(w2.id, { status: "running" });

      const wt1 = await mgr.createForWorker(run.id, w1.id, baseSha);
      const wt2 = await mgr.createForWorker(run.id, w2.id, baseSha);

      writeFileSync(join(wt1.path, "one.txt"), "from worker 1\n", "utf8");
      await runGit(wt1.path, ["add", "one.txt"]);
      await runGit(wt1.path, ["-c", "user.name=w1", "-c", "user.email=w1@local", "commit", "-m", "add one"]);

      writeFileSync(join(wt2.path, "two.txt"), "from worker 2\n", "utf8");
      await runGit(wt2.path, ["add", "two.txt"]);
      await runGit(wt2.path, ["-c", "user.name=w2", "-c", "user.email=w2@local", "commit", "-m", "add two"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, { ciCommands: ["sleep 0.05"] });
      const item1 = db.enqueueMerge({ runId: run.id, taskId: w1.id, worktreeId: wt1.id, branch: wt1.branch });
      const item2 = db.enqueueMerge({ runId: run.id, taskId: w2.id, worktreeId: wt2.id, branch: wt2.branch });

      const [outcome1, outcome2] = await Promise.all([
        mq.submitAndDrain(run.id, item1.id, { preserveLiveTask: true }),
        mq.submitAndDrain(run.id, item2.id, { preserveLiveTask: true }),
      ]);

      assert.equal(outcome1.item.id, item1.id);
      assert.equal(outcome1.item.status, "merged");
      assert.ok(outcome1.mergedSha);

      assert.equal(outcome2.item.id, item2.id);
      assert.equal(outcome2.item.status, "merged");
      assert.ok(outcome2.mergedSha);
      assert.notEqual(outcome1.mergedSha, outcome2.mergedSha);

      // Both files landed on main in serialized order
      assert.equal(readFileSync(join(repo, "one.txt"), "utf8").trim(), "from worker 1");
      assert.equal(readFileSync(join(repo, "two.txt"), "utf8").trim(), "from worker 2");

      // Live tasks stay running and worktrees stay on disk with status "merged" until explicit teardown
      assert.equal(db.getTask(w1.id)?.status, "running");
      assert.equal(db.getTask(w2.id)?.status, "running");
      assert.equal(db.getWorktree(wt1.id)?.status, "merged");
      assert.equal(db.getWorktree(wt2.id)?.status, "merged");
      assert.equal(existsSync(wt1.path), true);
      assert.equal(existsSync(wt2.path), true);

      await mgr.teardown(wt1.id, { archiveBeforeRemove: false, finalStatus: "merged" });
      await mgr.teardown(wt2.id, { archiveBeforeRemove: false, finalStatus: "merged" });
      assert.equal(existsSync(wt1.path), false);
      assert.equal(existsSync(wt2.path), false);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("runs setupCommand in both worker and integration worktrees and cleans up leaked worktree + branch on setupCommand failure", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const logFile = join(repo, ".setup-invocations.log");
      // Make sure untracked log file won't interfere with git status in worktrees (it lives in repo root)
      const setupCmd = `printf '%s\\n' "$HARNESS_WORKTREE_PATH" >> "${logFile}" && printf 'bootstrapped' > .bootstrapped`;

      const mgr = new WorktreeManager(db, repo, {
        dir: ".harness/worktrees",
        maxConcurrentWorkers: 4,
        setupCommand: setupCmd,
      });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Bootstrap hook", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Add feature",
        objective: "Add ok.txt",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      assert.equal(readFileSync(join(wt.path, ".bootstrapped"), "utf8"), "bootstrapped");
      // Remove untracked marker from worker worktree so commit stays clean
      rmSync(join(wt.path, ".bootstrapped"));

      writeFileSync(join(wt.path, "ok.txt"), "ok\n", "utf8");
      await runGit(wt.path, ["add", "ok.txt"]);
      await runGit(wt.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "add ok"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, {
        ciCommands: ["test -f .bootstrapped && test -f ok.txt"],
      });
      const item = db.enqueueMerge({ runId: run.id, taskId: worker.id, worktreeId: wt.id, branch: wt.branch });
      const outcome = await mq.submitAndDrain(run.id, item.id);
      assert.equal(outcome.item.status, "merged");

      const invocations = readFileSync(logFile, "utf8").trim().split("\n");
      assert.equal(invocations.length, 2, `Expected setupCommand to run in worker and integration worktrees, got: ${invocations.join(", ")}`);
      assert.ok(invocations[0]!.includes(worker.id));
      assert.ok(invocations[1]!.includes("_integration"));

      // Failing setupCommand must clean up both the newly created worktree and branch
      const badMgr = new WorktreeManager(db, repo, {
        dir: ".harness/worktrees",
        maxConcurrentWorkers: 4,
        setupCommand: "echo boom >&2 && exit 1",
      });
      const failingWorker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Failing bootstrap",
        objective: "Should fail setup",
        profileId: "acp:claude",
      });

      await assert.rejects(() => badMgr.createForWorker(run.id, failingWorker.id, baseSha));

      const expectedBranch = `harness/${run.id}/${failingWorker.id}`;
      const expectedPath = join(badMgr.baseDir, run.id, failingWorker.id);
      assert.equal(existsSync(expectedPath), false, "Leaked worktree directory must be removed on setupCommand failure");
      const branchExists = await runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${expectedBranch}`]).then(
        () => true,
        () => false,
      );
      assert.equal(branchExists, false, "Leaked worker branch must be deleted on setupCommand failure");
      assert.equal(db.listWorktrees(run.id).some((w) => w.taskId === failingWorker.id), false);

      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("hardens checkTestIntegrity to ignore comments while catching test.only and Rust #[ignore]", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Test integrity", repoRoot: repo, baseBranch, baseSha });

      // 1. Comment-only lines mentioning skip/only must be ignored
      const wComments = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Add comments",
        objective: "Document tests",
        profileId: "acp:claude",
      });
      const wtComments = await mgr.createForWorker(run.id, wComments.id, baseSha);
      writeFileSync(
        join(wtComments.path, "app.test.js"),
        [
          "// it.skip('documented example', () => {});",
          "/* test.only('block comment', () => {}); */",
          " * describe.skip('jsdoc comment', () => {});",
          "# pytest.skip('python comment')",
          "test('ok', () => {});",
        ].join("\n") + "\n",
        "utf8",
      );
      await runGit(wtComments.path, ["add", "app.test.js"]);
      await runGit(wtComments.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "comment only"]);

      const commentWarnings = await checkTestIntegrity(repo, baseBranch, wtComments.branch);
      assert.deepEqual(commentWarnings, []);

      // 2. Real test.only( and Rust #[ignore] must be caught
      const wViolations = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Add test.only and #[ignore]",
        objective: "Weaken tests",
        profileId: "acp:claude",
      });
      const wtViolations = await mgr.createForWorker(run.id, wViolations.id, baseSha);
      writeFileSync(join(wtViolations.path, "app.test.js"), "test.only('focused', () => {});\n", "utf8");
      writeFileSync(join(wtViolations.path, "lib_test.rs"), "#[test]\n#[ignore]\nfn skipped_rust_test() {}\n", "utf8");
      await runGit(wtViolations.path, ["add", "app.test.js", "lib_test.rs"]);
      await runGit(wtViolations.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "weaken tests"]);

      const warnings = await checkTestIntegrity(repo, baseBranch, wtViolations.branch);
      assert.equal(warnings.length, 2, `Expected 2 warnings, got: ${warnings.join(" | ")}`);
      assert.ok(warnings.some((w) => w.includes("app.test.js") && w.includes("test.only")));
      assert.ok(warnings.some((w) => w.includes("lib_test.rs") && w.includes("#[ignore]")));

      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("enforces write_scopes mechanically at merge time, bouncing out-of-scope edits while allowing in-scope edits", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Enforce write scopes", repoRoot: repo, baseBranch, baseSha });

      // 1. Out-of-scope edit bounces with ci_failed naming the offending file
      const wBad = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Out-of-scope edit",
        objective: "Edit src/a",
        profileId: "acp:claude",
        writeScopes: ["src/a/**"],
      });
      const wtBad = await mgr.createForWorker(run.id, wBad.id, baseSha);
      mkdirSync(join(wtBad.path, "src/b"), { recursive: true });
      writeFileSync(join(wtBad.path, "src/b/secret.ts"), "export const oops = true;\n", "utf8");
      await runGit(wtBad.path, ["add", "src/b/secret.ts"]);
      await runGit(wtBad.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "edit outside scope"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, {});
      const badItem = db.enqueueMerge({ runId: run.id, taskId: wBad.id, worktreeId: wtBad.id, branch: wtBad.branch });
      const badOutcome = await mq.submitAndDrain(run.id, badItem.id, { preserveLiveTask: true });

      assert.equal(badOutcome.item.status, "ci_failed");
      assert.match(badOutcome.bouncedReason ?? "", /src\/b\/secret\.ts/);
      assert.equal(db.getTask(wBad.id)?.status, "running");
      assert.equal(db.getWorktree(wtBad.id)?.status, "bounced");

      // 2. In-scope edit (plus shared metadata file package.json) merges cleanly
      const wGood = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "In-scope edit",
        objective: "Edit src/c",
        profileId: "acp:claude",
        writeScopes: ["src/c/**"],
      });
      const wtGood = await mgr.createForWorker(run.id, wGood.id, baseSha);
      mkdirSync(join(wtGood.path, "src/c"), { recursive: true });
      writeFileSync(join(wtGood.path, "src/c/ok.ts"), "export const ok = 1;\n", "utf8");
      writeFileSync(join(wtGood.path, "package.json"), '{"name":"demo"}\n', "utf8");
      await runGit(wtGood.path, ["add", "src/c/ok.ts", "package.json"]);
      await runGit(wtGood.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "edit inside scope"]);

      const goodItem = db.enqueueMerge({ runId: run.id, taskId: wGood.id, worktreeId: wtGood.id, branch: wtGood.branch });
      const goodOutcome = await mq.submitAndDrain(run.id, goodItem.id);

      assert.equal(goodOutcome.item.status, "merged");
      assert.equal(readFileSync(join(repo, "src/c/ok.ts"), "utf8").trim(), "export const ok = 1;");

      // Also verify bounced worktrees count toward maxConcurrentWorkers and detached HEAD is rejected
      const cappedMgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 1 });
      const wExtra = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Capped worker",
        objective: "Should hit cap because wtBad is bounced",
        profileId: "acp:claude",
      });
      await assert.rejects(() => cappedMgr.createForWorker(run.id, wExtra.id, baseSha), /concurrency cap reached/);

      // Detached HEAD check in resolveRepoInfo
      await runGit(repo, ["checkout", "--detach", "HEAD"]);
      await assert.rejects(() => mgr.resolveRepoInfo(), /detached HEAD/);

      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("blocks rename bypass of write_scopes, aborts cancelled merges during CI, and re-acquires leases on resume", async () => {
    const repo = await initTempRepo();
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(join(repo, "private"), { recursive: true });
      mkdirSync(join(repo, "allowed"), { recursive: true });
      writeFileSync(join(repo, "private/secret.txt"), "do not move\n", "utf8");
      await runGit(repo, ["add", "-A"]);
      await runGit(repo, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "add private file"]);

      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Rename & cancel guards", repoRoot: repo, baseBranch, baseSha });

      // 1. Rename bypass: moving private/secret.txt -> allowed/moved.txt MUST bounce under scope `allowed/**`
      const wRename = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Rename escape",
        objective: "Try moving private file",
        profileId: "acp:claude",
        writeScopes: ["allowed/**"],
      });
      const wtRename = await mgr.createForWorker(run.id, wRename.id, baseSha);
      mkdirSync(join(wtRename.path, "allowed"), { recursive: true });
      await runGit(wtRename.path, ["mv", "private/secret.txt", "allowed/moved.txt"]);
      await runGit(wtRename.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "sneaky rename"]);

      // Even if task was blocked (deactivating leases), listAssignedWriteScopes still enforces `allowed/**`!
      db.updateTask(wRename.id, { status: "blocked" });
      assert.deepEqual(db.listActiveWriteScopes(run.id, wRename.id), []);
      assert.deepEqual(db.listAssignedWriteScopes(run.id, wRename.id), ["allowed/**"]);
      assert.deepEqual(db.reacquireWriteLeasesForTask(run.id, wRename.id), ["allowed/**"]);

      const mq = new BisectingMergeQueue(db, mgr, repo, {});
      const itemRename = db.enqueueMerge({ runId: run.id, taskId: wRename.id, worktreeId: wtRename.id, branch: wtRename.branch });
      const renameOut = await mq.submitAndDrain(run.id, itemRename.id, { preserveLiveTask: true });
      assert.equal(renameOut.item.status, "ci_failed");
      assert.match(renameOut.bouncedReason ?? "", /private\/secret\.txt/);
      assert.equal(existsSync(join(repo, "private/secret.txt")), true, "Protected source must remain intact on main");

      // 2. Cancelling a task mid-CI must abort merge and never resurrect task to `running` or land on `main`
      const wCancel = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Cancelled during CI",
        objective: "Add cancelled.txt",
        profileId: "acp:codex",
        writeScopes: ["cancelled.txt"],
      });
      const wtCancel = await mgr.createForWorker(run.id, wCancel.id, baseSha);
      writeFileSync(join(wtCancel.path, "cancelled.txt"), "should not land\n", "utf8");
      await runGit(wtCancel.path, ["add", "cancelled.txt"]);
      await runGit(wtCancel.path, ["-c", "user.name=w", "-c", "user.email=w@local", "commit", "-m", "add cancelled"]);

      const slowMq = new BisectingMergeQueue(db, mgr, repo, { ciCommands: ["sleep 2"] });
      const abortCtrl = new AbortController();
      const itemCancel = db.enqueueMerge({ runId: run.id, taskId: wCancel.id, worktreeId: wtCancel.id, branch: wtCancel.branch });
      const mergePromise = slowMq.submitAndDrain(run.id, itemCancel.id, { preserveLiveTask: true, signal: abortCtrl.signal });
      setTimeout(() => {
        db.updateTask(wCancel.id, { status: "cancelled", summary: "Cancelled mid-CI" });
        abortCtrl.abort(new Error("Cancelled mid-CI"));
      }, 80);
      const cancelOut = await mergePromise;
      assert.equal(cancelOut.item.status, "ci_failed");
      assert.equal(db.getTask(wCancel.id)?.status, "cancelled", "Cancelled task must NOT be resurrected to running");
      assert.equal(existsSync(join(repo, "cancelled.txt")), false, "Cancelled branch must NOT land on main");

      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  async function porcelainBlocks(repo: string): Promise<string[]> {
    const { stdout } = await runGit(repo, ["worktree", "list", "--porcelain"]);
    return stdout ? stdout.split(/\r?\n\r?\n/) : [];
  }

  function findBlock(blocks: string[], targetPath: string): string | undefined {
    const canon = canonicalPath(targetPath);
    return blocks.find((b) => {
      const line = b.split(/\r?\n/).find((l) => l.startsWith("worktree "));
      return line ? canonicalPath(line.slice("worktree ".length)) === canon : false;
    });
  }

  it("locks harness worktrees so prune keeps a hidden live registration, then teardown removes it", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Lock protection", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Locked worker",
        objective: "Test worktree lock",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      const initialBlock = findBlock(await porcelainBlocks(repo), wt.path);
      assert.ok(initialBlock?.split(/\r?\n/).includes("locked pi-harness"));

      // Hide both the locked worker checkout and an unlocked control checkout, then run prune
      renameSync(wt.path, `${wt.path}.hidden`);
      const ctrlPath = join(repo, ".harness", "ctrl");
      await runGit(repo, ["worktree", "add", "--detach", ctrlPath, "HEAD"]);
      renameSync(ctrlPath, `${ctrlPath}.hidden`);

      await runGit(repo, ["worktree", "prune"]);

      const afterPrune = await porcelainBlocks(repo);
      const wtAfterPrune = findBlock(afterPrune, wt.path);
      assert.ok(wtAfterPrune?.split(/\r?\n/).includes("locked pi-harness"));
      assert.equal(findBlock(afterPrune, ctrlPath), undefined, "unlocked control registration must be pruned");

      renameSync(`${wt.path}.hidden`, wt.path);
      db.updateTask(worker.id, { status: "completed" });
      await mgr.teardown(wt.id);

      assert.equal(findBlock(await porcelainBlocks(repo), wt.path), undefined);
      assert.equal(existsSync(wt.path), false);
      const branchExists = await runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${wt.branch}`]).then(
        () => true,
        () => false,
      );
      assert.equal(branchExists, false);
      assert.ok(db.getWorktree(wt.id)?.cleanedAt != null);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("a foreign lock is left in place", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Foreign lock", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Foreign locked worker",
        objective: "Keep foreign lock",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      await runGit(repo, ["worktree", "unlock", wt.path]);
      await runGit(repo, ["worktree", "lock", "--reason", "keep me", wt.path]);
      db.updateTask(worker.id, { status: "completed" });

      await assert.rejects(() => mgr.teardown(wt.id), /locked \(keep me\); left in place/);
      assert.equal(existsSync(wt.path), true);
      assert.ok(findBlock(await porcelainBlocks(repo), wt.path));

      // Repeat with a bare lock (no reason)
      await runGit(repo, ["worktree", "unlock", wt.path]);
      await runGit(repo, ["worktree", "lock", wt.path]);
      await assert.rejects(() => mgr.teardown(wt.id), /locked/);
      assert.equal(existsSync(wt.path), true);
      assert.ok(findBlock(await porcelainBlocks(repo), wt.path));

      // sweep reports it in errors and leaves it in place
      const cleanup = await mgr.sweep({ runId: run.id });
      assert.equal(cleanup.removed.length, 0);
      assert.equal(cleanup.errors.length, 1);
      assert.match(cleanup.errors[0]!.error, /locked/);
      assert.equal(existsSync(wt.path), true);
      assert.ok(findBlock(await porcelainBlocks(repo), wt.path));
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("pre-lock unlocked rows still tear down", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Legacy unlocked", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Unlocked worker",
        objective: "Legacy teardown",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      await runGit(repo, ["worktree", "unlock", wt.path]);
      db.updateTask(worker.id, { status: "completed" });

      await mgr.teardown(wt.id);
      assert.equal(findBlock(await porcelainBlocks(repo), wt.path), undefined);
      assert.equal(existsSync(wt.path), false);
      const branchExists = await runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${wt.branch}`]).then(
        () => true,
        () => false,
      );
      assert.equal(branchExists, false);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("retired harness-locked row whose checkout was deleted is finalised", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Deleted checkout", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Deleted worker",
        objective: "Finalise missing checkout",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      db.updateTask(worker.id, { status: "completed" });
      rmSync(wt.path, { recursive: true, force: true });

      const cleanup = await mgr.sweep({ runId: run.id });
      assert.deepEqual(cleanup.errors, []);
      assert.equal(findBlock(await porcelainBlocks(repo), wt.path), undefined);
      assert.ok(db.getWorktree(wt.id)?.cleanedAt != null);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("scratch worktrees are locked and removable", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseSha } = await mgr.resolveRepoInfo();

      const s = await mgr.addScratchWorktree("_verify", "x", baseSha);
      const block = findBlock(await porcelainBlocks(repo), s.path);
      assert.ok(block?.split(/\r?\n/).includes("locked pi-harness"));

      await s.remove();
      assert.equal(findBlock(await porcelainBlocks(repo), s.path), undefined);
      assert.equal(existsSync(s.path), false);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("foreign lock taken during teardown archive is left in place", async () => {
    const repo = await initTempRepo();
    try {
      const db = new ControlPlaneDb(":memory:");
      const mgr = new WorktreeManager(db, repo, { dir: ".harness/worktrees", maxConcurrentWorkers: 4 });
      const { baseBranch, baseSha } = await mgr.resolveRepoInfo();
      const run = db.createRun({ goal: "Mid-teardown lock", repoRoot: repo, baseBranch, baseSha });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Mid-teardown worker",
        objective: "Acquire foreign lock during archive",
        profileId: "acp:claude",
      });

      const wt = await mgr.createForWorker(run.id, worker.id, baseSha);
      writeFileSync(join(wt.path, "dirty.txt"), "uncommitted\n", "utf8");
      db.updateTask(worker.id, { status: "completed" });

      const origSnapshot = mgr.snapshotToArchiveRef.bind(mgr);
      mgr.snapshotToArchiveRef = async (rec) => {
        const ref = await origSnapshot(rec);
        await runGit(repo, ["worktree", "unlock", rec.path]);
        await runGit(repo, ["worktree", "lock", "--reason", "taken mid-teardown", rec.path]);
        return ref;
      };

      await assert.rejects(
        () => mgr.teardown(wt.id, { archiveBeforeRemove: true }),
        /locked \(taken mid-teardown\); left in place/,
      );
      assert.equal(existsSync(wt.path), true);
      const lockedBlock = findBlock(await porcelainBlocks(repo), wt.path);
      assert.ok(lockedBlock?.split(/\r?\n/).includes("locked taken mid-teardown"));
      assert.equal(db.getWorktree(wt.id)?.cleanedAt, null);
      assert.ok(db.getWorktree(wt.id)?.archiveRef);
      const branchStillExists = await runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${wt.branch}`]).then(
        () => true,
        () => false,
      );
      assert.equal(branchStillExists, true);

      // Unlocked at initial check, then bare-locked during archive
      await runGit(repo, ["worktree", "unlock", wt.path]);
      mgr.snapshotToArchiveRef = async (rec) => {
        const ref = await origSnapshot(rec);
        await runGit(repo, ["worktree", "lock", rec.path]);
        return ref;
      };

      await assert.rejects(() => mgr.teardown(wt.id, { archiveBeforeRemove: true }), /locked; left in place/);
      assert.equal(existsSync(wt.path), true);
      const bareLockedBlock = findBlock(await porcelainBlocks(repo), wt.path);
      assert.ok(bareLockedBlock?.split(/\r?\n/).includes("locked"));
      assert.equal(db.getWorktree(wt.id)?.cleanedAt, null);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
