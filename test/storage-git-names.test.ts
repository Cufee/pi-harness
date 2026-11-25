import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { GoalEngine } from "../src/goals/engine.js";
import {
  archiveRef,
  archiveRefPatterns,
  isArchiveRef,
  mergedRef,
  mergedRefCandidates,
  parseArchiveRef,
  taskBranchName,
} from "../src/storage/names.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit, WorktreeManager } from "../src/worktree/manager.js";
import { BisectingMergeQueue } from "../src/worktree/merge-queue.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];
const initialStorageLayout = process.env.PI_HARNESS_STORAGE_LAYOUT;

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

async function initTempGitRepo(dir: string): Promise<string> {
  mkdirSync(dir, { recursive: true });
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "# temp repo\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
  return (await runGit(dir, ["rev-parse", "HEAD"])).stdout;
}

async function createCommitWithDate(repo: string, parentSha: string, message: string, unixSec: number): Promise<string> {
  const { stdout: treeSha } = await runGit(repo, ["rev-parse", `${parentSha}^{tree}`]);
  const dateStr = `${unixSec} +0000`;
  const { stdout } = await execFileAsync("git", ["commit-tree", treeSha, "-p", parentSha, "-m", message], {
    cwd: repo,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@local",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@local",
      GIT_AUTHOR_DATE: dateStr,
      GIT_COMMITTER_DATE: dateStr,
    },
  });
  return stdout.trim();
}

async function refSha(repo: string, ref: string): Promise<string | null> {
  return runGit(repo, ["rev-parse", "--verify", `${ref}^{commit}`])
    .then((r) => r.stdout || null)
    .catch(() => null);
}

afterEach(() => {
  if (initialStorageLayout === undefined) {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  } else {
    process.env.PI_HARNESS_STORAGE_LAYOUT = initialStorageLayout;
  }
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("git names in data-dir layout (real git repos)", () => {
  it("matches both archive ref shapes in real git for-each-ref and isolates run-1 from run-10", async () => {
    const root = makeTempDir("pi-git-names-patterns-");
    const repo = join(root, "repo");
    const sha = await initTempGitRepo(repo);

    const expectedRun1Archives = [
      "refs/harness/archive/run-1/t-1",
      "refs/harness/chat-7/archive/run-1/t-2",
      "refs/harness/legacy/archive/run-1/t-3",
      "refs/harness/archive/archive/run-1/t-4",
      "refs/harness/merged/archive/run-1/t-5",
    ];
    const otherRunArchives = [
      "refs/harness/archive/run-10/t-6",
      "refs/harness/chat-7/archive/run-10/t-7",
      "refs/harness/archive/run-1-extra/t-8",
      "refs/harness/chat-7/archive/run-1-extra/t-9",
    ];
    const nonArchiveRefs = [
      "refs/harness/merged/run-1",
      "refs/harness/chat-7/merged/run-1",
      "refs/harness/archive/merged/run-1",
      "refs/harness/merged/merged/run-1",
      "refs/harness/a/b/archive/run-1/t-nested",
    ];

    for (const ref of [...expectedRun1Archives, ...otherRunArchives, ...nonArchiveRefs]) {
      await runGit(repo, ["update-ref", ref, sha]);
    }

    // Scoped to run-1: matches every run-1 archive across all chats and zero run-10 / run-1-extra / merged refs.
    const scopedOut = await runGit(repo, ["for-each-ref", "--format=%(refname)", ...archiveRefPatterns("run-1", "data-dir")]);
    const scopedMatched = scopedOut.stdout.split("\n").filter(Boolean).sort();
    assert.deepEqual(scopedMatched, [...expectedRun1Archives].sort());
    for (const ref of scopedMatched) {
      assert.equal(isArchiveRef(ref, "run-1"), true);
      assert.equal(parseArchiveRef(ref)?.runId, "run-1");
    }

    // Unscoped: after filtering with isArchiveRef, returns every archive ref of both shapes and excludes all merged/nested refs.
    const allOut = await runGit(repo, ["for-each-ref", "--format=%(refname)", ...archiveRefPatterns(undefined, "data-dir")]);
    const allArchives = allOut.stdout
      .split("\n")
      .filter(Boolean)
      .filter((ref) => isArchiveRef(ref))
      .sort();
    assert.deepEqual(allArchives, [...expectedRun1Archives, ...otherRunArchives].sort());
  });

  it("uses sticky legacy merged ref for pre-flip runs (loose and packed) and chat-scoped merged ref for new runs in data-dir layout", async () => {
    const root = makeTempDir("pi-git-names-sticky-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    const initSha = await initTempGitRepo(repo);

    const db = new ControlPlaneDb(":memory:");
    try {
      // Phase 1: Legacy layout — create pre-flip runs and merge first commits (creating legacy merged refs).
      process.env.PI_HARNESS_STORAGE_LAYOUT = "legacy";
      resetStoragePathsForTest();
      const legacySp = storagePaths({ stateDir });
      const legacyMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, legacySp);
      const legacyMq = new BisectingMergeQueue(db, legacyMgr, repo, {});

      const preFlipRun = db.createRun({
        goal: "Pre-flip run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: initSha,
        chatSessionId: "chat-7",
      });
      const preTask1 = db.createTask({
        runId: preFlipRun.id,
        tier: 2,
        kind: "worker",
        title: "Pre-flip merge 1",
        objective: "Add f1.txt",
        profileId: "acp:claude",
      });
      const preWt1 = await legacyMgr.createForWorker(preFlipRun.id, preTask1.id, initSha);
      assert.equal(preWt1.branch, taskBranchName(preFlipRun, preTask1.id, "legacy"));
      writeFileSync(join(preWt1.path, "f1.txt"), "one\n", "utf8");
      await runGit(preWt1.path, ["add", "f1.txt"]);
      await runGit(preWt1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "pre-flip 1"]);
      db.enqueueMerge({ runId: preFlipRun.id, taskId: preTask1.id, worktreeId: preWt1.id, branch: preWt1.branch });
      const preRes1 = await legacyMq.processNext(preFlipRun.id);
      assert.ok(preRes1?.mergedSha);

      const legacyMerged = mergedRef(preFlipRun, "legacy");
      const chatMerged = mergedRef(preFlipRun, "data-dir");
      assert.equal(legacyMerged, `refs/harness/merged/${preFlipRun.id}`);
      assert.equal(chatMerged, `refs/harness/chat-7/merged/${preFlipRun.id}`);
      assert.equal(await refSha(repo, legacyMerged), preRes1.mergedSha);
      assert.equal(await refSha(repo, chatMerged), null);

      // Also pack refs to prove sticky detection works when the legacy ref is in packed-refs.
      await runGit(repo, ["pack-refs", "--all"]);

      // Phase 2: Switch to data-dir layout.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
      resetStoragePathsForTest();
      const ddSp = storagePaths({ stateDir });
      const ddMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, ddSp);
      const ddMq = new BisectingMergeQueue(db, ddMgr, repo, {});

      // Merge a second commit on the pre-flip run in data-dir layout: legacy ref advances, no chat ref created.
      const preTask2 = db.createTask({
        runId: preFlipRun.id,
        tier: 2,
        kind: "worker",
        title: "Pre-flip merge 2",
        objective: "Add f2.txt",
        profileId: "acp:claude",
      });
      const preWt2 = await ddMgr.createForWorker(preFlipRun.id, preTask2.id);
      assert.equal(preWt2.branch, `harness/chat-7/${preFlipRun.id}/${preTask2.id}`);
      writeFileSync(join(preWt2.path, "f2.txt"), "two\n", "utf8");
      await runGit(preWt2.path, ["add", "f2.txt"]);
      await runGit(preWt2.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "pre-flip 2"]);
      db.enqueueMerge({ runId: preFlipRun.id, taskId: preTask2.id, worktreeId: preWt2.id, branch: preWt2.branch });
      const preRes2 = await ddMq.processNext(preFlipRun.id);
      assert.ok(preRes2?.mergedSha);
      assert.notEqual(preRes2.mergedSha, preRes1.mergedSha);

      assert.equal(await refSha(repo, legacyMerged), preRes2.mergedSha);
      assert.equal(await refSha(repo, chatMerged), null);
      const preEvents = db.getEventsSince(preFlipRun.id, 0);
      const prePromoted2 = preEvents.find((e) => e.type === "merge.promoted" && e.taskId === preTask2.id);
      assert.equal((prePromoted2?.payload as Record<string, unknown>)?.ref, legacyMerged);
      assert.equal((prePromoted2?.payload as Record<string, unknown>)?.refUpdated, true);

      // New run in data-dir layout with chat-7: only the chat-shaped merged ref exists and advances across merges.
      const newRun = db.createRun({
        goal: "Post-flip run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: preRes2.mergedSha,
        chatSessionId: "chat-7",
      });
      const newLegacyMerged = mergedRef(newRun, "legacy");
      const newChatMerged = mergedRef(newRun, "data-dir");
      assert.equal(newChatMerged, `refs/harness/chat-7/merged/${newRun.id}`);

      const newTask1 = db.createTask({
        runId: newRun.id,
        tier: 2,
        kind: "worker",
        title: "Post-flip merge 1",
        objective: "Add n1.txt",
        profileId: "acp:claude",
      });
      const newWt1 = await ddMgr.createForWorker(newRun.id, newTask1.id);
      writeFileSync(join(newWt1.path, "n1.txt"), "n1\n", "utf8");
      await runGit(newWt1.path, ["add", "n1.txt"]);
      await runGit(newWt1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "post-flip 1"]);
      db.enqueueMerge({ runId: newRun.id, taskId: newTask1.id, worktreeId: newWt1.id, branch: newWt1.branch });
      const newRes1 = await ddMq.processNext(newRun.id);
      assert.ok(newRes1?.mergedSha);
      assert.equal(await refSha(repo, newChatMerged), newRes1.mergedSha);
      assert.equal(await refSha(repo, newLegacyMerged), null);

      const newTask2 = db.createTask({
        runId: newRun.id,
        tier: 2,
        kind: "worker",
        title: "Post-flip merge 2",
        objective: "Add n2.txt",
        profileId: "acp:claude",
      });
      const newWt2 = await ddMgr.createForWorker(newRun.id, newTask2.id);
      writeFileSync(join(newWt2.path, "n2.txt"), "n2\n", "utf8");
      await runGit(newWt2.path, ["add", "n2.txt"]);
      await runGit(newWt2.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "post-flip 2"]);
      db.enqueueMerge({ runId: newRun.id, taskId: newTask2.id, worktreeId: newWt2.id, branch: newWt2.branch });
      const newRes2 = await ddMq.processNext(newRun.id);
      assert.ok(newRes2?.mergedSha);
      assert.notEqual(newRes2.mergedSha, newRes1.mergedSha);
      assert.equal(await refSha(repo, newChatMerged), newRes2.mergedSha);
      assert.equal(await refSha(repo, newLegacyMerged), null);

      // New run without a chat in data-dir layout: uses "legacy" as the chat segment, never the legacy ref shape.
      const noChatRun = db.createRun({
        goal: "Ownerless run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: newRes2.mergedSha,
      });
      const noChatTask = db.createTask({
        runId: noChatRun.id,
        tier: 2,
        kind: "worker",
        title: "Ownerless merge",
        objective: "Add nc.txt",
        profileId: "acp:claude",
      });
      const noChatWt = await ddMgr.createForWorker(noChatRun.id, noChatTask.id);
      assert.equal(noChatWt.branch, `harness/legacy/${noChatRun.id}/${noChatTask.id}`);
      writeFileSync(join(noChatWt.path, "nc.txt"), "nc\n", "utf8");
      await runGit(noChatWt.path, ["add", "nc.txt"]);
      await runGit(noChatWt.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "ownerless"]);
      db.enqueueMerge({ runId: noChatRun.id, taskId: noChatTask.id, worktreeId: noChatWt.id, branch: noChatWt.branch });
      const noChatRes = await ddMq.processNext(noChatRun.id);
      assert.ok(noChatRes?.mergedSha);
      assert.equal(await refSha(repo, `refs/harness/legacy/merged/${noChatRun.id}`), noChatRes.mergedSha);
      assert.equal(await refSha(repo, `refs/harness/merged/${noChatRun.id}`), null);

      // Run whose chat_session_id column is null resolves chat via db.getRunChatSessionId from its linked goal.
      const engine = new GoalEngine(db.db, undefined, undefined, undefined, undefined, ddSp);
      const linkedGoal = engine.createGoal({
        chatSessionId: "chat-9",
        repoRoot: repo,
        title: "Derived chat goal",
        description: "Goal owns run chat",
        criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
      });
      const derivedRun = db.createRun({
        goal: "Derived chat run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: noChatRes.mergedSha,
      });
      engine.linkRunAndStart(linkedGoal.id, derivedRun.id);
      // Confirm run row still has NULL chat_session_id before WorktreeManager / MergeQueue derive it.
      assert.equal(db.getRun(derivedRun.id)?.chatSessionId, null);
      const derivedTask = db.createTask({
        runId: derivedRun.id,
        tier: 2,
        kind: "worker",
        title: "Derived chat merge",
        objective: "Add b.txt",
        profileId: "acp:claude",
      });
      const derivedWt = await ddMgr.createForWorker(derivedRun.id, derivedTask.id);
      assert.equal(derivedWt.branch, `harness/chat-9/${derivedRun.id}/${derivedTask.id}`);
      writeFileSync(join(derivedWt.path, "b.txt"), "b\n", "utf8");
      await runGit(derivedWt.path, ["add", "b.txt"]);
      await runGit(derivedWt.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "derived"]);
      // Reset run.chat_session_id back to NULL to verify BisectingMergeQueue independently calls getRunChatSessionId.
      db.db.prepare("UPDATE runs SET chat_session_id = NULL WHERE id = ?").run(derivedRun.id);
      db.enqueueMerge({ runId: derivedRun.id, taskId: derivedTask.id, worktreeId: derivedWt.id, branch: derivedWt.branch });
      const derivedRes = await ddMq.processNext(derivedRun.id);
      assert.ok(derivedRes?.mergedSha);
      assert.equal(await refSha(repo, `refs/harness/chat-9/merged/${derivedRun.id}`), derivedRes.mergedSha);
      assert.equal(await refSha(repo, `refs/harness/merged/${derivedRun.id}`), null);
    } finally {
      db.close();
    }
  });

  it("expires both legacy and chat-shaped archive refs in data-dir layout, keeps fresh ones, and isolates run-1 from run-10", async () => {
    const root = makeTempDir("pi-git-names-expiry-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    const headSha = await initTempGitRepo(repo);

    const nowSec = Math.floor(Date.now() / 1000);
    const oldSec = nowSec - 30 * 86_400;
    const freshSec = nowSec - 60;
    const oldSha = await createCommitWithDate(repo, headSha, "old archive", oldSec);
    const freshSha = await createCommitWithDate(repo, headSha, "fresh archive", freshSec);

    const expiredRun1Legacy = "refs/harness/archive/run-1/t-old-legacy";
    const expiredRun1Chat = "refs/harness/chat-7/archive/run-1/t-old-chat";
    const freshRun1Legacy = "refs/harness/archive/run-1/t-fresh-legacy";
    const freshRun1Chat = "refs/harness/chat-7/archive/run-1/t-fresh-chat";
    const expiredRun10Legacy = "refs/harness/archive/run-10/t-old-10";
    const expiredRun10Chat = "refs/harness/chat-7/archive/run-10/t-old-10-chat";
    const oldMergedChat = "refs/harness/chat-7/merged/run-1";
    const oldMergedArchiveChat = "refs/harness/archive/merged/run-1";

    for (const ref of [
      expiredRun1Legacy,
      expiredRun1Chat,
      expiredRun10Legacy,
      expiredRun10Chat,
      oldMergedChat,
      oldMergedArchiveChat,
    ]) {
      await runGit(repo, ["update-ref", ref, oldSha]);
    }
    for (const ref of [freshRun1Legacy, freshRun1Chat]) {
      await runGit(repo, ["update-ref", ref, freshSha]);
    }

    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();
    const ddSp = storagePaths({ stateDir });
    const db = new ControlPlaneDb(":memory:");
    try {
      const mgr = new WorktreeManager(db, repo, { archiveRetentionDays: 7 }, {}, ddSp);

      // Scoped sweep for run-1: expires only run-1's expired legacy & chat refs, leaves fresh refs, run-10, and merged refs.
      const scopedReport = await mgr.sweep({ runId: "run-1" });
      assert.deepEqual(scopedReport.errors, []);
      assert.deepEqual([...scopedReport.expiredArchiveRefs].sort(), [expiredRun1Legacy, expiredRun1Chat].sort());

      assert.equal(await refSha(repo, expiredRun1Legacy), null);
      assert.equal(await refSha(repo, expiredRun1Chat), null);
      assert.equal(await refSha(repo, freshRun1Legacy), freshSha);
      assert.equal(await refSha(repo, freshRun1Chat), freshSha);
      assert.equal(await refSha(repo, expiredRun10Legacy), oldSha);
      assert.equal(await refSha(repo, expiredRun10Chat), oldSha);
      assert.equal(await refSha(repo, oldMergedChat), oldSha);
      assert.equal(await refSha(repo, oldMergedArchiveChat), oldSha);

      // Unscoped sweep: expires run-10's expired legacy & chat refs, still keeps fresh refs and merged refs (even chat="archive").
      const fullReport = await mgr.sweep();
      assert.deepEqual(fullReport.errors, []);
      assert.deepEqual([...fullReport.expiredArchiveRefs].sort(), [expiredRun10Legacy, expiredRun10Chat].sort());

      assert.equal(await refSha(repo, expiredRun10Legacy), null);
      assert.equal(await refSha(repo, expiredRun10Chat), null);
      assert.equal(await refSha(repo, freshRun1Legacy), freshSha);
      assert.equal(await refSha(repo, freshRun1Chat), freshSha);
      assert.equal(await refSha(repo, oldMergedChat), oldSha);
      assert.equal(await refSha(repo, oldMergedArchiveChat), oldSha);
    } finally {
      db.close();
    }
  });

  it("runs a full create + collision + archive + sweep cycle in data-dir and handles legacy worktrees after layout switch", async () => {
    const root = makeTempDir("pi-git-names-cycle-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    const headSha = await initTempGitRepo(repo);

    const db = new ControlPlaneDb(":memory:");
    try {
      // Phase 1: Legacy layout — create a worktree with uncommitted work.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "legacy";
      resetStoragePathsForTest();
      const legacySp = storagePaths({ stateDir });
      const legacyMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, legacySp);

      const legacyRun = db.createRun({
        goal: "Pre-flip cycle",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: headSha,
        chatSessionId: "chat-7",
      });
      const legacyTask = db.createTask({
        runId: legacyRun.id,
        tier: 2,
        kind: "worker",
        title: "Legacy worker",
        objective: "Pre-flip edits",
        profileId: "acp:claude",
      });
      const legacyWt = await legacyMgr.createForWorker(legacyRun.id, legacyTask.id, headSha);
      assert.equal(legacyWt.branch, `harness/${legacyRun.id}/${legacyTask.id}`);
      writeFileSync(join(legacyWt.path, "legacy-work.txt"), "uncommitted legacy work\n", "utf8");

      // Phase 2: Switch to data-dir layout via env + resetStoragePathsForTest.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
      resetStoragePathsForTest();
      const ddSp = storagePaths({ stateDir });
      const ddMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, ddSp);

      // New worktree in data-dir uses chat-scoped branch and data-dir path; collision suffix stays intact.
      const ddRun = db.createRun({
        goal: "Data-dir cycle",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: headSha,
        chatSessionId: "chat-7",
      });
      const ddTask = db.createTask({
        runId: ddRun.id,
        tier: 2,
        kind: "worker",
        title: "Data-dir worker",
        objective: "Post-flip edits",
        profileId: "acp:claude",
      });
      const ddWt1 = await ddMgr.createForWorker(ddRun.id, ddTask.id, headSha);
      assert.equal(ddWt1.branch, `harness/chat-7/${ddRun.id}/${ddTask.id}`);
      writeFileSync(join(ddWt1.path, "dd-work.txt"), "uncommitted data-dir work\n", "utf8");

      const ddWt2 = await ddMgr.createForWorker(ddRun.id, ddTask.id, headSha);
      assert.equal(ddWt2.branch, `harness/chat-7/${ddRun.id}/${ddTask.id}-2`);

      // Legacy worktree is still discovered by listLive with its original legacy branch intact.
      const live = await ddMgr.listLive();
      const legacyLive = live.find((l) => l.record?.id === legacyWt.id);
      assert.ok(legacyLive, "legacy worktree must be visible after switching to data-dir");
      assert.equal(legacyLive.branch, legacyWt.branch);
      assert.equal(legacyLive.dirty, true);

      // Mark both tasks completed and sweep: archives both under data-dir archive refs and removes worktrees + branches.
      db.db.prepare("UPDATE tasks SET status = 'completed' WHERE id IN (?, ?)").run(legacyTask.id, ddTask.id);
      const sweepReport = await ddMgr.sweep();
      assert.deepEqual(sweepReport.errors, []);

      const expectedLegacyArchive = archiveRef(legacyRun, legacyTask.id, "data-dir");
      const expectedDdArchive = archiveRef(ddRun, ddTask.id, "data-dir");
      assert.equal(expectedLegacyArchive, `refs/harness/chat-7/archive/${legacyRun.id}/${legacyTask.id}`);
      assert.equal(expectedDdArchive, `refs/harness/chat-7/archive/${ddRun.id}/${ddTask.id}`);
      assert.ok(sweepReport.archivedRefs.includes(expectedLegacyArchive));
      assert.ok(sweepReport.archivedRefs.includes(expectedDdArchive));

      assert.equal(existsSync(legacyWt.path), false);
      assert.equal(existsSync(ddWt1.path), false);
      assert.equal(existsSync(ddWt2.path), false);
      assert.equal(await refSha(repo, `refs/heads/${legacyWt.branch}`), null);
      assert.equal(await refSha(repo, `refs/heads/${ddWt1.branch}`), null);
      assert.equal(await refSha(repo, `refs/heads/${ddWt2.branch}`), null);
      assert.ok(await refSha(repo, expectedLegacyArchive));
      assert.ok(await refSha(repo, expectedDdArchive));

      // Force-sweep expires both newly created chat-shaped archive refs cleanly.
      const expireReport = await ddMgr.sweep({ forceAll: true });
      assert.deepEqual(expireReport.errors, []);
      assert.deepEqual([...expireReport.expiredArchiveRefs].sort(), [expectedLegacyArchive, expectedDdArchive].sort());
      assert.equal(await refSha(repo, expectedLegacyArchive), null);
      assert.equal(await refSha(repo, expectedDdArchive), null);
    } finally {
      db.close();
    }
  });

  it("skips merged-ref update and logs a warning without failing promotion when for-each-ref fails (G1)", async () => {
    const root = makeTempDir("pi-git-names-enum-fail-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const shimBin = join(root, "shim-bin");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(shimBin, { recursive: true });
    const initSha = await initTempGitRepo(repo);

    const realGit = Bun.which("git");
    assert.ok(realGit, "git executable must be on PATH");
    const fakeGit = join(shimBin, "git");
    const escapedRealGit = realGit.replace(/'/g, "'\\''");
    writeFileSync(
      fakeGit,
      [
        "#!/bin/sh",
        'if [ "$1" = "for-each-ref" ]; then',
        '  echo "fatal: simulated for-each-ref failure" >&2',
        "  exit 128",
        "fi",
        `exec '${escapedRealGit}' "$@"`,
        "",
      ].join("\n"),
      "utf8",
    );
    chmodSync(fakeGit, 0o755);

    const db = new ControlPlaneDb(":memory:");
    const origPath = process.env.PATH;
    const origWarn = console.warn;
    const warnings: string[] = [];
    try {
      // Phase 1: Legacy layout creates the existing legacy merged ref.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "legacy";
      resetStoragePathsForTest();
      const legacySp = storagePaths({ stateDir });
      const legacyMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, legacySp);
      const legacyMq = new BisectingMergeQueue(db, legacyMgr, repo, {});

      const run = db.createRun({
        goal: "Sticky ref enum failure",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: initSha,
        chatSessionId: "chat-7",
      });
      const task1 = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Merge 1",
        objective: "Add f1.txt",
        profileId: "acp:claude",
      });
      const wt1 = await legacyMgr.createForWorker(run.id, task1.id, initSha);
      writeFileSync(join(wt1.path, "f1.txt"), "one\n", "utf8");
      await runGit(wt1.path, ["add", "f1.txt"]);
      await runGit(wt1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "merge 1"]);
      db.enqueueMerge({ runId: run.id, taskId: task1.id, worktreeId: wt1.id, branch: wt1.branch });
      const res1 = await legacyMq.processNext(run.id);
      assert.ok(res1?.mergedSha);

      const legacyMerged = mergedRef(run, "legacy");
      const chatMerged = mergedRef(run, "data-dir");
      assert.equal(await refSha(repo, legacyMerged), res1.mergedSha);
      assert.equal(await refSha(repo, chatMerged), null);

      // Phase 2: Data-dir layout promotes a second commit while git for-each-ref fails.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
      resetStoragePathsForTest();
      const ddSp = storagePaths({ stateDir });
      const ddMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, ddSp);
      const ddMq = new BisectingMergeQueue(db, ddMgr, repo, {});

      const task2 = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Merge 2",
        objective: "Add f2.txt",
        profileId: "acp:claude",
      });
      const wt2 = await ddMgr.createForWorker(run.id, task2.id);
      writeFileSync(join(wt2.path, "f2.txt"), "two\n", "utf8");
      await runGit(wt2.path, ["add", "f2.txt"]);
      await runGit(wt2.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "merge 2"]);
      db.enqueueMerge({ runId: run.id, taskId: task2.id, worktreeId: wt2.id, branch: wt2.branch });

      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
      process.env.PATH = `${shimBin}${delimiter}${origPath ?? ""}`;
      let res2;
      try {
        res2 = await ddMq.processNext(run.id);
      } finally {
        process.env.PATH = origPath;
        console.warn = origWarn;
      }

      // Promotion succeeds and advances main, while existing legacy ref stays untouched and no competing ref is created.
      assert.equal(res2?.item.status, "merged");
      assert.ok(res2?.mergedSha);
      assert.notEqual(res2.mergedSha, res1.mergedSha);
      assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout, res2.mergedSha);
      assert.equal(await refSha(repo, legacyMerged), res1.mergedSha);
      assert.equal(await refSha(repo, chatMerged), null);

      assert.ok(
        warnings.some((w) => w.includes(legacyMerged) && w.includes(chatMerged)),
        `expected ref enumeration warning naming refs, got: ${JSON.stringify(warnings)}`,
      );
      const events = db.getEventsSince(run.id, 0);
      const refWarning = events.find((e) => e.type === "merge.ref_warning" && e.taskId === task2.id);
      assert.ok(refWarning, "expected merge.ref_warning event");
      assert.equal((refWarning.payload as Record<string, unknown>).mergedSha, res2.mergedSha);
      const promoted = events.find((e) => e.type === "merge.promoted" && e.taskId === task2.id);
      assert.ok(promoted, "expected merge.promoted event");
      assert.equal((promoted.payload as Record<string, unknown>).mergedSha, res2.mergedSha);
      assert.equal((promoted.payload as Record<string, unknown>).refUpdated, false);
    } finally {
      process.env.PATH = origPath;
      console.warn = origWarn;
      db.close();
    }
  });

  it("D2(a): completes a pre-flip queued merge with chat id 'weird.lock' exactly once in data-dir and creates later worker branches", async () => {
    const root = makeTempDir("pi-git-names-d2-weird-chat-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    const initSha = await initTempGitRepo(repo);

    const db = new ControlPlaneDb(":memory:");
    const origWarn = console.warn;
    const warnings: string[] = [];
    try {
      // Phase 1: Legacy layout — pre-flip run with non-git-safe chat id 'weird.lock' and a queued merge.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "legacy";
      resetStoragePathsForTest();
      const legacySp = storagePaths({ stateDir });
      const legacyMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, legacySp);

      const weirdChatRun = db.createRun({
        goal: "Pre-flip weird chat run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: initSha,
        chatSessionId: "weird.lock",
      });
      const task1 = db.createTask({
        runId: weirdChatRun.id,
        tier: 2,
        kind: "worker",
        title: "Pre-flip queued worker",
        objective: "Add weird.txt",
        profileId: "acp:claude",
      });
      const wt1 = await legacyMgr.createForWorker(weirdChatRun.id, task1.id, initSha);
      writeFileSync(join(wt1.path, "weird.txt"), "from pre-flip\n", "utf8");
      await runGit(wt1.path, ["add", "weird.txt"]);
      await runGit(wt1.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "pre-flip weird chat"]);
      const queued = db.enqueueMerge({
        runId: weirdChatRun.id,
        taskId: task1.id,
        worktreeId: wt1.id,
        branch: wt1.branch,
      });

      // Phase 2: Flip to data-dir layout.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
      resetStoragePathsForTest();
      const ddSp = storagePaths({ stateDir });
      const ddMgr = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, ddSp);
      const ddMq = new BisectingMergeQueue(db, ddMgr, repo, {});

      // Queued merge for chat 'weird.lock' completes exactly once.
      const res1 = await ddMq.processNext(weirdChatRun.id);
      assert.ok(res1?.mergedSha, "expected mergedSha for weird.lock run");
      assert.equal(res1.item.status, "merged");
      assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout, res1.mergedSha);
      assert.equal(db.getMergeQueueItem(queued.id)?.status, "merged");
      assert.deepEqual(db.listPendingMerges(weirdChatRun.id), []);
      assert.equal(await ddMq.processNext(weirdChatRun.id), null);

      const expectedMergedRef = `refs/harness/legacy/merged/${weirdChatRun.id}`;
      assert.equal(await refSha(repo, expectedMergedRef), res1.mergedSha);
      const weirdPromoted = db
        .getEventsSince(weirdChatRun.id, 0)
        .filter((e) => e.type === "merge.promoted" && e.taskId === task1.id);
      assert.equal(weirdPromoted.length, 1);
      assert.equal((weirdPromoted[0]!.payload as Record<string, unknown>).mergedSha, res1.mergedSha);
      assert.equal((weirdPromoted[0]!.payload as Record<string, unknown>).ref, expectedMergedRef);
      assert.equal((weirdPromoted[0]!.payload as Record<string, unknown>).refUpdated, true);

      // A later worker of the same 'weird.lock' run gets a valid branch in data-dir layout.
      const task2 = db.createTask({
        runId: weirdChatRun.id,
        tier: 2,
        kind: "worker",
        title: "Post-flip worker for weird.lock run",
        objective: "Follow-up work",
        profileId: "acp:claude",
      });
      const wt2 = await ddMgr.createForWorker(weirdChatRun.id, task2.id);
      assert.equal(wt2.branch, `harness/legacy/${weirdChatRun.id}/${task2.id}`);
      assert.ok(await refSha(repo, `refs/heads/${wt2.branch}`), "later worker branch must exist in git");

      // Also verify the merge-queue advisory-skip path when merged-ref naming fails in data-dir:
      // a pre-flip run with id 'foo.' (valid as an interior legacy git branch segment, rejected by
      // the data-dir validator) still advances main, emits merge.ref_warning + merge.promoted, and
      // finishes the merge item exactly once.
      process.env.PI_HARNESS_STORAGE_LAYOUT = "legacy";
      resetStoragePathsForTest();
      const legacySp2 = storagePaths({ stateDir });
      const legacyMgr2 = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, legacySp2);
      const invalidRunIdRun = db.createRun({
        id: "foo.",
        goal: "Pre-flip run with trailing-dot id",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: res1.mergedSha,
        chatSessionId: "chat-7",
      });
      const taskInvalidRun = db.createTask({
        runId: invalidRunIdRun.id,
        tier: 2,
        kind: "worker",
        title: "Pre-flip trailing-dot run worker",
        objective: "Add dot-run.txt",
        profileId: "acp:claude",
      });
      const wtInvalidRun = await legacyMgr2.createForWorker(invalidRunIdRun.id, taskInvalidRun.id, res1.mergedSha);
      writeFileSync(join(wtInvalidRun.path, "dot-run.txt"), "dot run\n", "utf8");
      await runGit(wtInvalidRun.path, ["add", "dot-run.txt"]);
      await runGit(wtInvalidRun.path, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "dot run commit"]);
      const queuedInvalidRun = db.enqueueMerge({
        runId: invalidRunIdRun.id,
        taskId: taskInvalidRun.id,
        worktreeId: wtInvalidRun.id,
        branch: wtInvalidRun.branch,
      });

      process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
      resetStoragePathsForTest();
      const ddSp2 = storagePaths({ stateDir });
      const ddMgr2 = new WorktreeManager(db, repo, { maxConcurrentWorkers: 4 }, {}, ddSp2);
      const ddMq2 = new BisectingMergeQueue(db, ddMgr2, repo, {});

      console.warn = (...args: unknown[]) => {
        warnings.push(args.map((a) => String(a)).join(" "));
      };
      let resInvalid;
      try {
        resInvalid = await ddMq2.processNext(invalidRunIdRun.id);
      } finally {
        console.warn = origWarn;
      }
      assert.ok(resInvalid?.mergedSha);
      assert.equal(resInvalid.item.status, "merged");
      assert.equal((await runGit(repo, ["rev-parse", "main"])).stdout, resInvalid.mergedSha);
      assert.equal(db.getMergeQueueItem(queuedInvalidRun.id)?.status, "merged");
      assert.equal(await ddMq2.processNext(invalidRunIdRun.id), null);

      const invalidEvents = db.getEventsSince(invalidRunIdRun.id, 0);
      const refWarn = invalidEvents.find((e) => e.type === "merge.ref_warning" && e.taskId === taskInvalidRun.id);
      assert.ok(refWarn, "expected advisory merge.ref_warning when merged-ref naming fails");
      assert.equal((refWarn.payload as Record<string, unknown>).ref, null);
      const promotedInvalid = invalidEvents.filter((e) => e.type === "merge.promoted" && e.taskId === taskInvalidRun.id);
      assert.equal(promotedInvalid.length, 1);
      assert.equal((promotedInvalid[0]!.payload as Record<string, unknown>).mergedSha, resInvalid.mergedSha);
      assert.equal((promotedInvalid[0]!.payload as Record<string, unknown>).ref, null);
      assert.equal((promotedInvalid[0]!.payload as Record<string, unknown>).refUpdated, false);
      assert.ok(warnings.length > 0);
    } finally {
      console.warn = origWarn;
      db.close();
    }
  });

  it("D2(b): legacy-layout builders return origin/main names for run and task ids rejected by data-dir", () => {
    const runId = "run.lock";
    const taskId = "task.lock";
    const run = { id: runId, chatSessionId: "weird.lock" };

    // Legacy layout passes run and task ids through unchanged, matching origin/main.
    assert.equal(taskBranchName(run, taskId, "legacy"), `harness/${runId}/${taskId}`);
    assert.equal(archiveRef(run, taskId, "legacy"), `refs/harness/archive/${runId}/${taskId}`);
    assert.equal(mergedRef(run, "legacy"), `refs/harness/merged/${runId}`);
    assert.deepEqual(mergedRefCandidates(run, "legacy"), [`refs/harness/merged/${runId}`]);
    assert.deepEqual(archiveRefPatterns(runId, "legacy"), [
      `refs/harness/archive/${runId}/*`,
      `refs/harness/*/archive/${runId}/*`,
    ]);
    assert.deepEqual(archiveRefPatterns(run, "legacy"), [
      `refs/harness/archive/${runId}/*`,
      `refs/harness/*/archive/${runId}/*`,
    ]);
    // Empty string remains the unfiltered pattern argument in legacy layout, matching origin/main.
    assert.deepEqual(archiveRefPatterns("", "legacy"), [
      "refs/harness/archive/*/*",
      "refs/harness/*/archive/*/*",
    ]);
    assert.deepEqual(archiveRefPatterns({ id: "" }, "legacy"), [
      "refs/harness/archive/*/*",
      "refs/harness/*/archive/*/*",
    ]);

    // Data-dir layout still validates run and task ids, while falling back to 'legacy' for chat ids.
    assert.throws(() => taskBranchName(run, "t-1", "data-dir"), /Invalid git ref segment/);
    assert.throws(() => taskBranchName({ id: "run-1", chatSessionId: "weird.lock" }, taskId, "data-dir"), /Invalid git ref segment/);
    assert.throws(() => archiveRef(run, "t-1", "data-dir"), /Invalid git ref segment/);
    assert.throws(() => mergedRef(run, "data-dir"), /Invalid git ref segment/);
    assert.throws(() => archiveRefPatterns(runId, "data-dir"), /Invalid git ref segment/);
    assert.throws(() => archiveRefPatterns("", "data-dir"), /Invalid git ref segment/);
    assert.equal(taskBranchName({ id: "run-1", chatSessionId: "chat+1" }, "t-1", "data-dir"), "harness/legacy/run-1/t-1");
  });
});
