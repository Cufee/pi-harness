import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { runGit, WorktreeManager } from "../src/worktree/manager.js";
import { BisectingMergeQueue } from "../src/worktree/merge-queue.js";

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
      assert.equal(cleanup.prunedAdminEntries, true);

      // Verify the safety archive git ref actually exists in git!
      const refCheck = await runGit(repo, ["rev-parse", cleanup.archivedRefs[0]!]);
      assert.ok(refCheck.stdout.length >= 40);
      db.close();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
