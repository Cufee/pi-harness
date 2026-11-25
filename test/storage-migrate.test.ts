import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { GoalEngine } from "../src/goals/engine.js";
import {
  BRIDGE_MAX_AGE_MS,
  formatStorageMigrationPlan,
  planStorageMigration,
  runStorageMigrationPass,
} from "../src/storage/migrate.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const tempDirs: string[] = [];
const restoreModes: Array<{ path: string; mode: number }> = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeFile(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Recursively hashes all regular files under `rootDir` (never following symlinks) keyed by POSIX relPath. */
function hashTree(rootDir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(rootDir)) return out;
  const st = lstatSync(rootDir);
  if (st.isSymbolicLink()) return out;
  if (st.isFile()) {
    out.set(prefix || ".", sha256(readFileSync(rootDir)));
    return out;
  }
  for (const entry of readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const abs = join(rootDir, entry.name);
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of hashTree(abs, rel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(rel, sha256(readFileSync(abs)));
    }
  }
  return out;
}

function assertHashMapEqual(actual: Map<string, string>, expected: Map<string, string>, label: string): void {
  assert.deepEqual(
    [...actual.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [...expected.entries()].sort(([a], [b]) => a.localeCompare(b)),
    `Hash map mismatch for ${label}`,
  );
}

function createTestEnv(prefix = "pi-migrate-") {
  const root = makeTempDir(prefix);
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const dbPath = join(stateDir, "control-plane.sqlite");
  const cpDb = new ControlPlaneDb(dbPath);
  const goals = new GoalEngine(cpDb.db);
  const storage = storagePaths({ stateDir }, { layout: "data-dir" });
  return { root, stateDir, repo, dbPath, cpDb, goals, storage };
}

function makeGoal(goals: GoalEngine, repo: string, title: string, chatSessionId?: string) {
  return goals.createGoal({
    repoRoot: repo,
    chatSessionId,
    title,
    description: `Goal ${title}`,
    criteria: [{ id: "c1", description: "Done", kind: "behavioral" }],
  });
}

afterEach(() => {
  while (restoreModes.length > 0) {
    const item = restoreModes.pop()!;
    try {
      chmodSync(item.path, item.mode);
    } catch {
      // Best-effort restore before cleanup.
    }
  }
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storage migration engine (core)", () => {
  it("migrates every unit kind to the right destination, rewrites rows, creates unit bridges, and preserves hashes", () => {
    const { repo, cpDb, goals, storage } = createTestEnv("pi-mig-kinds-");
    try {
      // 1. Goal with chat + linked run + flat spill file indexed for that run
      const gChat = makeGoal(goals, repo, "With chat", "chat-4");
      const rChat = cpDb.createRun({
        goal: "Goal with chat",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-4",
      });
      goals.linkRunAndStart(gChat.id, rChat.id);
      const tChat = cpDb.createTask({
        runId: rChat.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Work",
        profileId: "acp:claude",
      });
      cpDb.updateTask(tChat.id, { status: "completed" });
      cpDb.updateRunStatus(rChat.id, "completed");
      goals.setStatus(gChat.id, "achieved");

      const gChatEvDir = join(repo, ".harness", "goals", gChat.id);
      const rChatArtDir = join(repo, ".harness", "artifacts", rChat.id);
      const rChatDossier = join(rChatArtDir, tChat.id, "report.md");
      const rChatSpill = join(repo, ".harness", "artifacts", `${tChat.id}-summary-1.md`);
      writeFile(join(gChatEvDir, "evidence.md"), "goal-with-chat evidence\n");
      writeFile(join(gChatEvDir, "sub", "proof.txt"), "nested proof\n");
      writeFile(rChatDossier, "chat-4 dossier content\n");
      writeFile(rChatSpill, "chat-4 flat spill content\n");
      const artChatDossier = cpDb.recordArtifact({
        runId: rChat.id,
        taskId: tChat.id,
        kind: "dossier",
        path: rChatDossier,
        summary: "Dossier",
      });
      const artChatSpill = cpDb.recordArtifact({
        runId: rChat.id,
        taskId: tChat.id,
        kind: "dossier",
        path: rChatSpill,
        summary: "Spill",
      });

      // 2. Goal without chat + linked run
      const gNoChat = makeGoal(goals, repo, "Without chat");
      const rNoChat = cpDb.createRun({
        goal: "Goal without chat",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
      });
      goals.linkRunAndStart(gNoChat.id, rNoChat.id);
      const tNoChat = cpDb.createTask({
        runId: rNoChat.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Work",
        profileId: "acp:claude",
      });
      cpDb.updateTask(tNoChat.id, { status: "completed" });
      cpDb.updateRunStatus(rNoChat.id, "completed");
      goals.setStatus(gNoChat.id, "cancelled");

      const gNoChatEvDir = join(repo, ".harness", "goals", gNoChat.id);
      const rNoChatArtDir = join(repo, ".harness", "artifacts", rNoChat.id);
      writeFile(join(gNoChatEvDir, "ev.md"), "no-chat evidence\n");
      writeFile(join(rNoChatArtDir, tNoChat.id, "out.md"), "no-chat run dossier\n");
      const artNoChat = cpDb.recordArtifact({
        runId: rNoChat.id,
        taskId: tNoChat.id,
        kind: "dossier",
        path: join(rNoChatArtDir, tNoChat.id, "out.md"),
        summary: "No chat dossier",
      });

      // 3. Non-goal run (with chat) + standalone flat spill file indexed for it
      const rStandalone = cpDb.createRun({
        goal: "Standalone run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-7",
      });
      const tStandalone = cpDb.createTask({
        runId: rStandalone.id,
        tier: 2,
        kind: "worker",
        title: "Standalone task",
        objective: "Run",
        profileId: "acp:claude",
      });
      cpDb.updateTask(tStandalone.id, { status: "completed" });
      cpDb.updateRunStatus(rStandalone.id, "completed");
      const rStandaloneDir = join(repo, ".harness", "artifacts", rStandalone.id);
      const rStandaloneDossier = join(rStandaloneDir, tStandalone.id, "doc.md");
      const standaloneSpill = join(repo, ".harness", "artifacts", "spill-standalone-1.json");
      writeFile(rStandaloneDossier, "standalone dossier\n");
      writeFile(standaloneSpill, '{"standalone":true}\n');
      const artStandalone = cpDb.recordArtifact({
        runId: rStandalone.id,
        taskId: tStandalone.id,
        kind: "dossier",
        path: rStandaloneDossier,
        summary: "Standalone",
      });
      const artStandaloneSpill = cpDb.recordArtifact({
        runId: rStandalone.id,
        taskId: tStandalone.id,
        kind: "dossier",
        path: standaloneSpill,
        summary: "Standalone spill",
      });

      // 4. Director bucket task
      const bucketRun = cpDb.createRun({
        id: "director-tasks-chat-9",
        goal: "Director bucket",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-9",
      });
      const tBucket = cpDb.createTask({
        runId: bucketRun.id,
        tier: 2,
        kind: "research",
        title: "Bucket research",
        objective: "Research",
        profileId: "acp:claude",
      });
      cpDb.updateTask(tBucket.id, { status: "completed" });
      const bucketTaskDir = join(repo, ".harness", "artifacts", bucketRun.id, tBucket.id);
      const bucketDossier = join(bucketTaskDir, "findings.md");
      writeFile(bucketDossier, "bucket task findings\n");
      const artBucket = cpDb.recordArtifact({
        runId: bucketRun.id,
        taskId: tBucket.id,
        kind: "dossier",
        path: bucketDossier,
        summary: "Bucket",
      });

      // 5. Nested note
      const nestedNoteLegacy = join(repo, ".harness", "notes", "arch", "deep", "design.md");
      writeFile(nestedNoteLegacy, "# Design notes\n");

      // 6. Ownerless flat spill file + ownerless goal dir + ownerless run dir
      const orphanSpillLegacy = join(repo, ".harness", "artifacts", "orphan-spill.txt");
      const orphanGoalLegacy = join(repo, ".harness", "goals", "goal-orphan-999");
      const orphanRunLegacy = join(repo, ".harness", "artifacts", "run-orphan-999");
      writeFile(orphanSpillLegacy, "orphan spill\n");
      writeFile(join(orphanGoalLegacy, "notes.txt"), "orphan goal\n");
      writeFile(join(orphanRunLegacy, "t-x", "doc.txt"), "orphan run\n");

      // Capture before hash maps for every unit.
      const beforeHashes = {
        gChat: hashTree(gChatEvDir),
        rChat: hashTree(rChatArtDir),
        rChatSpill: hashTree(rChatSpill),
        gNoChat: hashTree(gNoChatEvDir),
        rNoChat: hashTree(rNoChatArtDir),
        rStandalone: hashTree(rStandaloneDir),
        standaloneSpill: hashTree(standaloneSpill),
        bucketTask: hashTree(bucketTaskDir),
        nestedNote: hashTree(nestedNoteLegacy),
        orphanSpill: hashTree(orphanSpillLegacy),
        orphanGoal: hashTree(orphanGoalLegacy),
        orphanRun: hashTree(orphanRunLegacy),
      };

      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(report.skipped, false);
      assert.equal(report.errors.length, 0);
      assert.equal(report.budgetExceeded, false);

      const projDir = storage.projectDir(repo);
      const destGChat = join(projDir, "chats", "chat-4", "goals", gChat.id);
      const destRChat = join(projDir, "chats", "chat-4", "artifacts", rChat.id);
      const destRChatSpill = join(projDir, "chats", "chat-4", "artifacts", `${tChat.id}-summary-1.md`);
      const destGNoChat = join(projDir, "chats", "legacy", "goals", gNoChat.id);
      const destRNoChat = join(projDir, "chats", "legacy", "artifacts", rNoChat.id);
      const destRStandalone = join(projDir, "chats", "chat-7", "artifacts", rStandalone.id);
      const destStandaloneSpill = join(projDir, "chats", "chat-7", "artifacts", "spill-standalone-1.json");
      const destBucketTask = join(projDir, "chats", "chat-9", "artifacts", bucketRun.id, tBucket.id);
      const destNestedNote = join(storage.projectNotesDir(repo), "arch", "deep", "design.md");
      const destOrphanSpill = join(projDir, "chats", "legacy", "artifacts", "orphan-spill.txt");
      const destOrphanGoal = join(projDir, "chats", "legacy", "goals", "goal-orphan-999");
      const destOrphanRun = join(projDir, "chats", "legacy", "artifacts", "run-orphan-999");

      // Verify hash maps at destinations match 100%.
      assertHashMapEqual(hashTree(destGChat), beforeHashes.gChat, "goal with chat");
      assertHashMapEqual(hashTree(destRChat), beforeHashes.rChat, "linked run with chat");
      assertHashMapEqual(hashTree(destRChatSpill), beforeHashes.rChatSpill, "linked flat spill");
      assertHashMapEqual(hashTree(destGNoChat), beforeHashes.gNoChat, "goal without chat");
      assertHashMapEqual(hashTree(destRNoChat), beforeHashes.rNoChat, "linked run without chat");
      assertHashMapEqual(hashTree(destRStandalone), beforeHashes.rStandalone, "standalone run");
      assertHashMapEqual(hashTree(destStandaloneSpill), beforeHashes.standaloneSpill, "standalone spill");
      assertHashMapEqual(hashTree(destBucketTask), beforeHashes.bucketTask, "bucket task");
      assertHashMapEqual(hashTree(destNestedNote), beforeHashes.nestedNote, "nested note");
      assertHashMapEqual(hashTree(destOrphanSpill), beforeHashes.orphanSpill, "orphan spill");
      assertHashMapEqual(hashTree(destOrphanGoal), beforeHashes.orphanGoal, "orphan goal");
      assertHashMapEqual(hashTree(destOrphanRun), beforeHashes.orphanRun, "orphan run");

      // Notes never go to chats/legacy/notes.
      assert.equal(existsSync(join(projDir, "chats", "legacy", "notes")), false);

      // Every legacy unit path is now a bridge symlink to its exact destination.
      const bridgePairs: Array<[string, string]> = [
        [gChatEvDir, destGChat],
        [rChatArtDir, destRChat],
        [rChatSpill, destRChatSpill],
        [gNoChatEvDir, destGNoChat],
        [rNoChatArtDir, destRNoChat],
        [rStandaloneDir, destRStandalone],
        [standaloneSpill, destStandaloneSpill],
        [bucketTaskDir, destBucketTask],
        [nestedNoteLegacy, destNestedNote],
        [orphanSpillLegacy, destOrphanSpill],
        [orphanGoalLegacy, destOrphanGoal],
        [orphanRunLegacy, destOrphanRun],
      ];
      for (const [legacyPath, expectedDest] of bridgePairs) {
        const st = lstatSync(legacyPath);
        assert.equal(st.isSymbolicLink(), true, `Expected bridge symlink at ${legacyPath}`);
        assert.equal(readlinkSync(legacyPath), expectedDest, `Bridge target mismatch at ${legacyPath}`);
      }

      // Container dirs are NEVER symlinked.
      for (const container of [
        join(repo, ".harness"),
        join(repo, ".harness", "goals"),
        join(repo, ".harness", "artifacts"),
        join(repo, ".harness", "notes"),
        join(repo, ".harness", "artifacts", bucketRun.id),
      ]) {
        const st = lstatSync(container);
        assert.equal(st.isSymbolicLink(), false, `Container ${container} must never be symlinked`);
        assert.equal(st.isDirectory(), true);
      }

      // Every artifacts row was rewritten to its new absolute data-dir path.
      const getArtPath = (id: string) =>
        (cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(id) as { path: string }).path;
      assert.equal(getArtPath(artChatDossier.id), join(destRChat, tChat.id, "report.md"));
      assert.equal(getArtPath(artChatSpill.id), destRChatSpill);
      assert.equal(getArtPath(artNoChat.id), join(destRNoChat, tNoChat.id, "out.md"));
      assert.equal(getArtPath(artStandalone.id), join(destRStandalone, tStandalone.id, "doc.md"));
      assert.equal(getArtPath(artStandaloneSpill.id), destStandaloneSpill);
      assert.equal(getArtPath(artBucket.id), join(destBucketTask, "findings.md"));
    } finally {
      cpDb.close();
    }
  });

  it("defers an in-flight goal and migrates evidence dir + run dir together once terminal", () => {
    const { repo, cpDb, goals, storage } = createTestEnv("pi-mig-inflight-");
    try {
      const goal = makeGoal(goals, repo, "In-flight", "chat-2");
      const run = cpDb.createRun({
        goal: "In-flight",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-2",
      });
      goals.linkRunAndStart(goal.id, run.id);
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Live worker",
        objective: "Running",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "running" });

      const goalDir = join(repo, ".harness", "goals", goal.id);
      const runDir = join(repo, ".harness", "artifacts", run.id);
      const dossierPath = join(runDir, task.id, "work.md");
      writeFile(join(goalDir, "evidence.md"), "live evidence");
      writeFile(dossierPath, "live dossier");
      const art = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: dossierPath,
        summary: "Work",
      });

      const beforeGoalHashes = hashTree(goalDir);
      const beforeRunHashes = hashTree(runDir);

      // Pass 1 while in-flight: nothing moves, no bridge, rows unchanged, deferred with reason.
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.totals.migrated, 0);
      assert.equal(pass1.totals.deferred, 1);
      const deferredUnit = pass1.repos[0]!.deferred[0]!;
      assert.equal(deferredUnit.kind, "goal");
      assert.equal(deferredUnit.id, goal.id);
      assert.ok(deferredUnit.reason && deferredUnit.reason.includes("executing"));
      assert.equal(lstatSync(goalDir).isSymbolicLink(), false);
      assert.equal(lstatSync(runDir).isSymbolicLink(), false);
      assert.equal(existsSync(storage.projectDir(repo)), false);
      const rowAfter1 = cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
      assert.equal(rowAfter1.path, dossierPath);

      // Now turn goal and task terminal: pass 2 moves both halves together.
      cpDb.updateTask(task.id, { status: "completed" });
      goals.setStatus(goal.id, "achieved");

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.migrated, 1);
      assert.equal(pass2.totals.deferred, 0);

      const destGoalDir = join(storage.projectDir(repo), "chats", "chat-2", "goals", goal.id);
      const destRunDir = join(storage.projectDir(repo), "chats", "chat-2", "artifacts", run.id);
      assertHashMapEqual(hashTree(destGoalDir), beforeGoalHashes, "goal evidence after terminal");
      assertHashMapEqual(hashTree(destRunDir), beforeRunHashes, "run artifacts after terminal");
      assert.equal(lstatSync(goalDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(goalDir), destGoalDir);
      assert.equal(lstatSync(runDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(runDir), destRunDir);

      const rowAfter2 = cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
      assert.equal(rowAfter2.path, join(destRunDir, task.id, "work.md"));
    } finally {
      cpDb.close();
    }
  });

  it("defers a terminal goal with a live task, and isolates terminal vs running bucket siblings", () => {
    const { repo, cpDb, goals, storage } = createTestEnv("pi-mig-mixed-");
    try {
      // Terminal goal with one completed task and one live task -> deferred!
      const goal = makeGoal(goals, repo, "Terminal with live task", "chat-3");
      const run = cpDb.createRun({
        goal: "Terminal with live task",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-3",
      });
      goals.linkRunAndStart(goal.id, run.id);
      const tDone = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Done",
        objective: "Done",
        profileId: "acp:claude",
      });
      const tLive = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Still running",
        objective: "Live",
        profileId: "acp:claude",
      });
      cpDb.updateTask(tDone.id, { status: "completed" });
      cpDb.updateTask(tLive.id, { status: "running" });
      goals.setStatus(goal.id, "achieved");

      const goalDir = join(repo, ".harness", "goals", goal.id);
      const runDir = join(repo, ".harness", "artifacts", run.id);
      writeFile(join(goalDir, "ev.md"), "ev");
      writeFile(join(runDir, tDone.id, "d.md"), "done");
      writeFile(join(runDir, tLive.id, "l.md"), "live");

      // Director bucket: one terminal task (moves) and one running sibling (stays).
      const bucketRun = cpDb.createRun({
        id: "director-tasks-chat-5",
        goal: "Bucket",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-5",
      });
      const bDone = cpDb.createTask({
        runId: bucketRun.id,
        tier: 2,
        kind: "research",
        title: "Bucket done",
        objective: "Done",
        profileId: "acp:claude",
      });
      const bLive = cpDb.createTask({
        runId: bucketRun.id,
        tier: 2,
        kind: "research",
        title: "Bucket live",
        objective: "Live",
        profileId: "acp:claude",
      });
      cpDb.updateTask(bDone.id, { status: "completed" });
      cpDb.updateTask(bLive.id, { status: "running" });

      const bDoneDir = join(repo, ".harness", "artifacts", bucketRun.id, bDone.id);
      const bLiveDir = join(repo, ".harness", "artifacts", bucketRun.id, bLive.id);
      writeFile(join(bDoneDir, "done.md"), "bucket done");
      writeFile(join(bLiveDir, "live.md"), "bucket live");
      const beforeBDone = hashTree(bDoneDir);

      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(report.errors.length, 0);

      // Goal + linked run stayed untouched (deferred).
      assert.equal(lstatSync(goalDir).isSymbolicLink(), false);
      assert.equal(lstatSync(runDir).isSymbolicLink(), false);
      const deferredGoal = report.repos[0]!.deferred.find((u) => u.kind === "goal" && u.id === goal.id);
      assert.ok(deferredGoal);
      assert.ok(deferredGoal.reason?.includes(tLive.id));

      // Bucket terminal sibling moved; running sibling stayed.
      const destBDone = join(storage.projectDir(repo), "chats", "chat-5", "artifacts", bucketRun.id, bDone.id);
      assertHashMapEqual(hashTree(destBDone), beforeBDone, "bucket done");
      assert.equal(lstatSync(bDoneDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(bDoneDir), destBDone);
      assert.equal(lstatSync(bLiveDir).isSymbolicLink(), false);
      assert.equal(readFileSync(join(bLiveDir, "live.md"), "utf8"), "bucket live");
      const deferredBucket = report.repos[0]!.deferred.find((u) => u.kind === "bucket_task" && u.taskId === bLive.id);
      assert.ok(deferredBucket);
      assert.ok(deferredBucket.reason?.includes("running"));
    } finally {
      cpDb.close();
    }
  });

  it("is idempotent on a second pass and reports unknown top-level entries once", () => {
    const { repo, cpDb, storage } = createTestEnv("pi-mig-idempotent-");
    try {
      const run = cpDb.createRun({
        goal: "Done run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-1",
      });
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "T",
        objective: "O",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const dossierPath = join(repo, ".harness", "artifacts", run.id, task.id, "doc.md");
      writeFile(dossierPath, "hello\n");
      cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: dossierPath, summary: "Doc" });
      const unknownPath = join(repo, ".harness", "custom-user-data.txt");
      writeFile(unknownPath, "keep me");

      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.totals.migrated, 1);
      assert.equal(pass1.totals.rowsRewritten, 1);
      assert.deepEqual(pass1.unknownEntries, [unknownPath]);
      assert.deepEqual(pass1.newUnknownEntries, [unknownPath]);
      assert.equal(readFileSync(unknownPath, "utf8"), "keep me");

      const projDir = storage.projectDir(repo);
      const projectJsonBefore = readFileSync(join(projDir, "project.json"), "utf8");
      const stateMtimeBefore = lstatSync(join(projDir, "migration-state.json")).mtimeMs;
      const destTreeBefore = hashTree(projDir);
      const rowsBefore = cpDb.db.prepare("SELECT id, path FROM artifacts ORDER BY id").all();
      const totalChangesBefore = (cpDb.db.prepare("SELECT total_changes() AS c").get() as { c: number }).c;

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.migrated, 0);
      assert.equal(pass2.totals.merged, 0);
      assert.equal(pass2.totals.finished, 0);
      assert.equal(pass2.totals.rowsRewritten, 0);
      assert.equal(pass2.totals.bridgesCreated, 0);
      assert.equal(pass2.totals.bridgesRemoved, 0);
      assert.deepEqual(pass2.unknownEntries, [unknownPath]);
      assert.deepEqual(pass2.newUnknownEntries, []);

      assert.equal(readFileSync(join(projDir, "project.json"), "utf8"), projectJsonBefore);
      assert.equal(lstatSync(join(projDir, "migration-state.json")).mtimeMs, stateMtimeBefore);
      assertHashMapEqual(hashTree(projDir), destTreeBefore, "idempotent project dir");
      assert.deepEqual(cpDb.db.prepare("SELECT id, path FROM artifacts ORDER BY id").all(), rowsBefore);
      assert.equal((cpDb.db.prepare("SELECT total_changes() AS c").get() as { c: number }).c, totalChangesBefore);
    } finally {
      cpDb.close();
    }
  });

  it("rewrites artifact rows recorded under a symlinked repo root spelling and workspace-relative paths", () => {
    const { root, repo, cpDb, storage } = createTestEnv("pi-mig-symlink-root-");
    try {
      const symlinkRepo = join(root, "repo-symlink-alias");
      symlinkSync(repo, symlinkRepo);

      const run = cpDb.createRun({
        goal: "Alias run",
        repoRoot: symlinkRepo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-6",
      });
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Alias task",
        objective: "Alias",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const realFile1 = join(repo, ".harness", "artifacts", run.id, task.id, "from-symlink.md");
      const realFile2 = join(repo, ".harness", "artifacts", run.id, task.id, "from-rel.md");
      writeFile(realFile1, "symlink spelling");
      writeFile(realFile2, "relative spelling");

      const artSymlink = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: join(symlinkRepo, ".harness", "artifacts", run.id, task.id, "from-symlink.md"),
        summary: "Symlink row",
      });
      const artRel = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: `.harness/artifacts/${run.id}/${task.id}/from-rel.md`,
        summary: "Relative row",
      });

      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(report.errors.length, 0);
      assert.equal(report.totals.rowsRewritten, 2);

      const destDir = join(storage.projectDir(repo), "chats", "chat-6", "artifacts", run.id, task.id);
      const p1 = (cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(artSymlink.id) as { path: string }).path;
      const p2 = (cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(artRel.id) as { path: string }).path;
      assert.equal(p1, join(destDir, "from-symlink.md"));
      assert.equal(p2, join(destDir, "from-rel.md"));
    } finally {
      cpDb.close();
    }
  });

  it("enforces 7-day bridge lifetime, removes .harness only when empty without touching worktrees or tracked .gitignore", () => {
    const { repo, cpDb, storage } = createTestEnv("pi-mig-bridges-");
    try {
      // Initialize a real git repo with a tracked .gitignore containing .harness
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      const gitignorePath = join(repo, ".gitignore");
      const gitignoreContent = "node_modules/\n.harness/\n";
      writeFileSync(gitignorePath, gitignoreContent, "utf8");
      const gitignoreHashBefore = sha256(readFileSync(gitignorePath));
      execFileSync("git", ["add", ".gitignore"], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

      // Seed a migratable note + an active worktree directory under .harness/worktrees
      const noteLegacy = join(repo, ".harness", "notes", "sub", "note.md");
      writeFile(noteLegacy, "keep note\n");
      const wtFile = join(repo, ".harness", "worktrees", "run-1", "t-1", "README.md");
      writeFile(wtFile, "worktree content\n");

      // Register repo in runs so discovery finds it.
      const run = cpDb.createRun({
        goal: "Bridge lifecycle",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
      });
      cpDb.updateRunStatus(run.id, "completed");

      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass1.errors.length, 0);
      assert.equal(lstatSync(noteLegacy).isSymbolicLink(), true);
      const bridgeMtime = lstatSync(noteLegacy).mtimeMs;

      // Younger than 7 days: bridge stays.
      const passYoung = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        now: () => bridgeMtime + BRIDGE_MAX_AGE_MS - 1_000,
      });
      assert.equal(passYoung.totals.bridgesRemoved, 0);
      assert.equal(lstatSync(noteLegacy).isSymbolicLink(), true);

      // At 7 days: bridge is removed, empty .harness/notes is removed, but .harness/worktrees and .harness stay!
      const passOld = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        now: () => bridgeMtime + BRIDGE_MAX_AGE_MS,
      });
      assert.equal(passOld.totals.bridgesRemoved, 1);
      assert.equal(existsSync(noteLegacy), false);
      assert.equal(existsSync(join(repo, ".harness", "notes")), false);
      assert.equal(existsSync(wtFile), true, "Worktree file must never be touched");
      assert.equal(existsSync(join(repo, ".harness", "worktrees")), true);
      assert.equal(existsSync(join(repo, ".harness")), true);

      // Empty .harness/worktrees (simulating sweep retiring the last worktree): next pass removes worktrees and .harness.
      rmSync(join(repo, ".harness", "worktrees", "run-1"), { recursive: true, force: true });
      const passCleanup = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        now: () => bridgeMtime + BRIDGE_MAX_AGE_MS + 1_000,
      });
      assert.equal(passCleanup.errors.length, 0);
      assert.equal(existsSync(join(repo, ".harness", "worktrees")), false);
      assert.equal(existsSync(join(repo, ".harness")), false);

      // Tracked .gitignore is byte-identical and git status is completely clean.
      assert.equal(sha256(readFileSync(gitignorePath)), gitignoreHashBefore);
      const gitStatus = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
      assert.equal(gitStatus, "");
    } finally {
      cpDb.close();
    }
  });

  it("plans safely on a read-only SQLite handle without creating directories and formats every unit with action and reason", () => {
    const { stateDir, repo, dbPath, cpDb, goals, storage } = createTestEnv("pi-mig-plan-ro-");
    try {
      // One eligible goal unit, one deferred goal unit, one note, one unknown entry
      const gDone = makeGoal(goals, repo, "Done", "chat-1");
      const rDone = cpDb.createRun({ goal: "Done", repoRoot: repo, baseBranch: "main", baseSha: "abc", chatSessionId: "chat-1" });
      goals.linkRunAndStart(gDone.id, rDone.id);
      goals.setStatus(gDone.id, "achieved");
      cpDb.updateRunStatus(rDone.id, "completed");
      writeFile(join(repo, ".harness", "goals", gDone.id, "ev.md"), "done ev");
      writeFile(join(repo, ".harness", "artifacts", rDone.id, "t-1", "a.md"), "done art");

      const gLive = makeGoal(goals, repo, "Live", "chat-2");
      const rLive = cpDb.createRun({ goal: "Live", repoRoot: repo, baseBranch: "main", baseSha: "abc", chatSessionId: "chat-2" });
      goals.linkRunAndStart(gLive.id, rLive.id);
      writeFile(join(repo, ".harness", "goals", gLive.id, "ev.md"), "live ev");
      writeFile(join(repo, ".harness", "notes", "team.md"), "note");
      writeFile(join(repo, ".harness", "mystery-entry"), "leftover");
    } finally {
      cpDb.close();
    }

    const dataDir = join(stateDir, "data");
    assert.equal(existsSync(dataDir), false);
    const beforeRepoHashes = hashTree(repo);

    const roDb = new Database(dbPath, { readonly: true });
    try {
      const plan = planStorageMigration({ sqlite: roDb, storage });
      assert.equal(plan.noop, false);
      assert.equal(plan.repos.length, 1);
      assert.equal(plan.totals.migrate, 2); // gDone (goal+run) and note
      assert.equal(plan.totals.deferred, 1); // gLive
      assert.equal(plan.totals.unknownEntries, 1);

      // Nothing created on disk!
      assert.equal(existsSync(dataDir), false);
      assertHashMapEqual(hashTree(repo), beforeRepoHashes, "read-only plan must not touch repo");

      const formatted = formatStorageMigrationPlan(plan);
      assert.ok(formatted.includes(repo));
      assert.ok(formatted.includes("[migrate]"));
      assert.ok(formatted.includes("[defer]"));
      assert.ok(formatted.includes("non-terminal"));
      assert.ok(formatted.includes("mystery-entry"));
      assert.ok(formatted.includes("team.md"));
      assert.ok(formatted.includes("Totals across 1 repo(s)"));
    } finally {
      roDb.close();
    }
  });

  it("handles standalone/older DBs missing the goals table or chat_session_id column without throwing", () => {
    const root = makeTempDir("pi-mig-old-db-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sqlite = new Database(":memory:");
    try {
      sqlite.exec(`
        CREATE TABLE runs (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, status TEXT NOT NULL);
        CREATE TABLE artifacts (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL, path TEXT NOT NULL);
      `);
      sqlite.prepare("INSERT INTO runs (id, repo_root, status) VALUES (?, ?, ?)").run("run-1", repo, "completed");
      sqlite.prepare("INSERT INTO tasks (id, run_id, status) VALUES (?, ?, ?)").run("t-1", "run-1", "completed");
      const artPath = join(repo, ".harness", "artifacts", "run-1", "t-1", "old.md");
      writeFile(artPath, "legacy schema content");
      sqlite.prepare("INSERT INTO artifacts (id, run_id, task_id, path) VALUES (?, ?, ?, ?)").run("art-1", "run-1", "t-1", artPath);

      const storage = storagePaths({ stateDir }, { layout: "data-dir" });
      const plan = planStorageMigration({ sqlite, storage });
      assert.equal(plan.repos.length, 1);
      assert.equal(plan.totals.migrate, 1);

      const report = runStorageMigrationPass({ sqlite, storage });
      assert.equal(report.errors.length, 0);
      assert.equal(report.totals.migrated, 1);
      assert.equal(report.totals.rowsRewritten, 1);
    } finally {
      sqlite.close();
    }
  });

  it("is a no-op when storage layout is legacy", () => {
    const { stateDir, repo, cpDb } = createTestEnv("pi-mig-legacy-layout-");
    try {
      writeFile(join(repo, ".harness", "notes", "stay.md"), "stay in legacy");
      const legacyStorage = storagePaths({ stateDir }, { layout: "legacy" });

      const plan = planStorageMigration({ sqlite: cpDb.db, storage: legacyStorage });
      assert.equal(plan.layout, "legacy");
      assert.equal(plan.noop, true);
      assert.ok(formatStorageMigrationPlan(plan).includes("legacy"));

      const logs: string[] = [];
      const report = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage: legacyStorage,
        log: (line) => logs.push(line),
      });
      assert.equal(report.layout, "legacy");
      assert.equal(report.skipped, true);
      assert.ok(report.skipReason?.toLowerCase().includes("legacy"));
      assert.equal(lstatSync(join(repo, ".harness", "notes", "stay.md")).isSymbolicLink(), false);
      assert.ok(logs.length > 0);
    } finally {
      cpDb.close();
    }
  });

  it("stops between files when budget expires mid-copy and completes cleanly on the next pass", () => {
    const { repo, cpDb, storage } = createTestEnv("pi-mig-budget-");
    try {
      const run = cpDb.createRun({
        goal: "Budget test",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-8",
      });
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Multi-file",
        objective: "Files",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const runDir = join(repo, ".harness", "artifacts", run.id);
      for (let i = 1; i <= 5; i++) {
        const p = join(runDir, task.id, `file-${i}.txt`);
        writeFile(p, `payload-${i}-`.repeat(50));
        cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: p, summary: `File ${i}` });
      }
      const beforeHashes = hashTree(runDir);

      // Fake clock: ticks forward by 20ms per check so budgetMs=100 expires after ~2 files during copyToStaging.
      let clock = 1_000;
      const fakeNow = () => {
        clock += 20;
        return clock;
      };

      const pass1 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: fakeNow, forceCopy: true },
        { budgetMs: 140 },
      );
      assert.equal(pass1.budgetExceeded, true);
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.remainingUnits.length, 1);

      const destDir = join(storage.projectDir(repo), "chats", "chat-8", "artifacts", run.id);
      const stagingDir = `${destDir}.migrating`;
      assert.equal(existsSync(destDir), false, "Destination must not exist after mid-copy budget expiry");
      assert.equal(existsSync(stagingDir), true, "Partial .migrating staging dir proves copy started");
      const copiedCount = hashTree(stagingDir).size;
      assert.equal(copiedCount, 2, `Expected partial copy to stop between files (2/5), got ${copiedCount}/5`);
      assertHashMapEqual(hashTree(runDir), beforeHashes, "legacy files untouched after budget expiry");

      // Second pass with generous budget removes stale staging and finishes migration.
      const pass2 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, forceCopy: true },
        { budgetMs: 30_000 },
      );
      assert.equal(pass2.budgetExceeded, false);
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.remainingUnits.length, 0);
      assert.equal(pass2.totals.migrated, 1);
      assert.equal(existsSync(stagingDir), false);
      assertHashMapEqual(hashTree(destDir), beforeHashes, "full hash map after resumed copy");
      assert.equal(lstatSync(runDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(runDir), destDir);
    } finally {
      cpDb.close();
    }
  });

  it("never throws on an unreadable chmod-000 unit and still migrates all other units", () => {
    const { repo, cpDb, storage } = createTestEnv("pi-mig-chmod000-");
    try {
      const rBad = cpDb.createRun({ goal: "Bad", repoRoot: repo, baseBranch: "main", baseSha: "abc" });
      const rGood = cpDb.createRun({ goal: "Good", repoRoot: repo, baseBranch: "main", baseSha: "abc", chatSessionId: "chat-2" });
      cpDb.updateRunStatus(rBad.id, "completed");
      cpDb.updateRunStatus(rGood.id, "completed");

      const badDir = join(repo, ".harness", "artifacts", rBad.id);
      const goodDir = join(repo, ".harness", "artifacts", rGood.id);
      writeFile(join(badDir, "t-1", "secret.md"), "unreadable");
      writeFile(join(goodDir, "t-2", "ok.md"), "readable");
      const beforeGood = hashTree(goodDir);

      // Make badDir unreadable (skip assertion only if running as root where chmod 000 still allows reads).
      chmodSync(badDir, 0o000);
      restoreModes.push({ path: badDir, mode: 0o755 });

      let isRoot = false;
      try {
        readdirSync(badDir);
        isRoot = true;
      } catch {
        isRoot = false;
      }

      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      const destGood = join(storage.projectDir(repo), "chats", "chat-2", "artifacts", rGood.id);
      assertHashMapEqual(hashTree(destGood), beforeGood, "good unit migrated despite bad unit");
      assert.equal(lstatSync(goodDir).isSymbolicLink(), true);

      if (!isRoot) {
        assert.ok(report.errors.length >= 1, "Unreadable chmod-000 unit must be recorded in report.errors");
        assert.ok(report.errors.some((e) => e.unitKey === `run:${rBad.id}`));
        assert.equal(lstatSync(badDir).isSymbolicLink(), false, "Unreadable unit must not be moved or bridged");
      }
    } finally {
      cpDb.close();
    }
  });

  it("re-reads DB eligibility at the start of each unit rather than once per pass", () => {
    const { repo, cpDb, storage } = createTestEnv("pi-mig-per-unit-db-");
    try {
      const r1 = cpDb.createRun({ goal: "Run 1", repoRoot: repo, baseBranch: "main", baseSha: "abc", chatSessionId: "chat-1" });
      const r2 = cpDb.createRun({ goal: "Run 2", repoRoot: repo, baseBranch: "main", baseSha: "abc", chatSessionId: "chat-1" });
      const t1 = cpDb.createTask({ runId: r1.id, tier: 2, kind: "worker", title: "T1", objective: "O", profileId: "acp:claude" });
      const t2 = cpDb.createTask({ runId: r2.id, tier: 2, kind: "worker", title: "T2", objective: "O", profileId: "acp:claude" });
      cpDb.updateTask(t1.id, { status: "completed" });
      cpDb.updateTask(t2.id, { status: "completed" });
      cpDb.updateRunStatus(r1.id, "completed");
      cpDb.updateRunStatus(r2.id, "completed");

      const dir1 = join(repo, ".harness", "artifacts", r1.id);
      const dir2 = join(repo, ".harness", "artifacts", r2.id);
      writeFile(join(dir1, t1.id, "a.md"), "one");
      writeFile(join(dir2, t2.id, "b.md"), "two");

      // While r1 is migrating, flip r2 back to active + t2 to running.
      // Because eligibility is decided at the start of each unit, r2 must be deferred!
      const report = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        fault: (step, unit) => {
          if (step === "after_rename_into_place" && unit.id === r1.id) {
            cpDb.updateRunStatus(r2.id, "active");
            cpDb.updateTask(t2.id, { status: "running" });
          }
        },
      });
      assert.equal(report.errors.length, 0);
      assert.equal(lstatSync(dir1).isSymbolicLink(), true, "r1 should have migrated");
      assert.equal(lstatSync(dir2).isSymbolicLink(), false, "r2 became active before its turn and must be deferred");
      assert.ok(report.repos[0]!.deferred.some((u) => u.id === r2.id));
    } finally {
      cpDb.close();
    }
  });
});
