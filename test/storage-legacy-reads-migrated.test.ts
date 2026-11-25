import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { findRunDossier, hashRunDossier, readRunDossier, writeTaskDossier } from "../src/control-plane/dossiers.js";
import { resolveDirectorReadablePath } from "../src/director/runtime.js";
import { legacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeFile(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface MigratedFixture {
  root: string;
  stateDir: string;
  repo: string;
  otherRepo: string;
  db: ControlPlaneDb;
  legacySp: ReturnType<typeof storagePaths>;
  dataDirSp: ReturnType<typeof storagePaths>;
  run1: ReturnType<ControlPlaneDb["createRun"]>;
  run2: ReturnType<ControlPlaneDb["createRun"]>;
  bucketRun: ReturnType<ControlPlaneDb["createRun"]>;
  task1Id: string;
  task2Id: string;
  bucketTaskId: string;
  // Migrated dossier (run1)
  dossierBody: string;
  dossierDataAbs: string;
  dossierLegacyAbs: string;
  dossierLegacyRel: string;
  // Migrated flat spill (run1)
  spillBody: string;
  spillDataAbs: string;
  spillLegacyAbs: string;
  spillLegacyRel: string;
  // Migrated bucket task dossier (bucketRun)
  bucketBody: string;
  bucketDataAbs: string;
  bucketLegacyAbs: string;
  bucketLegacyRel: string;
  // Other run's migrated dossier (run2)
  run2DossierDataAbs: string;
  run2DossierLegacyAbs: string;
  run2DossierLegacyRel: string;
  run2SpillDataAbs: string;
  // Migrated goal evidence file
  goalId: string;
  goalEvBody: string;
  goalEvDataAbs: string;
  goalEvLegacyAbs: string;
  goalEvLegacyRel: string;
  // Migrated note
  noteBody: string;
  noteDataAbs: string;
  noteLegacyAbs: string;
  noteLegacyRel: string;
  // Migrated per-chat note
  chatNoteDataAbs: string;
}

function createMigratedFixture(): MigratedFixture {
  const root = makeTempDir("pi-legacy-reads-migrated-");
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  const otherRepo = join(root, "other-repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(otherRepo, { recursive: true });

  const dataDirSp = storagePaths({ stateDir }, { layout: "data-dir" });
  const legacySp = storagePaths({ stateDir }, { layout: "legacy" });
  dataDirSp.ensureProjectDir(repo);
  dataDirSp.ensureProjectDir(otherRepo);

  const db = new ControlPlaneDb(":memory:");
  const run1 = db.createRun({
    goal: "Migrated goal run",
    repoRoot: repo,
    baseBranch: "main",
    baseSha: "abc1234",
    chatSessionId: "chat-1",
  });
  const task1 = db.createTask({
    runId: run1.id,
    tier: 2,
    kind: "worker",
    title: "Worker 1",
    objective: "Write dossier",
    profileId: "acp:claude",
  });

  const run2 = db.createRun({
    goal: "Other run",
    repoRoot: repo,
    baseBranch: "main",
    baseSha: "abc1234",
    chatSessionId: "chat-2",
  });
  const task2 = db.createTask({
    runId: run2.id,
    tier: 2,
    kind: "worker",
    title: "Worker 2",
    objective: "Other run dossier",
    profileId: "acp:claude",
  });

  const bucketRun = db.createRun({
    id: "director-tasks-chat-1",
    goal: "Director bucket",
    repoRoot: repo,
    baseBranch: "main",
    baseSha: "abc1234",
    chatSessionId: "chat-1",
  });
  const bucketTask = db.createTask({
    runId: bucketRun.id,
    tier: 3,
    kind: "research",
    title: "Scout",
    objective: "Bucket dossier",
    profileId: "acp:claude",
  });

  // 1. Migrated run1 artifacts dir + bridge + rewritten DB row
  const dossierBody = "migrated run1 dossier body\n";
  const legacyArt1 = writeTaskDossier(db, run1, task1.id, "g0-dossier.md", dossierBody, "G0 dossier", legacyStoragePaths);
  const dossierLegacyAbs = legacyArt1.path;
  const dossierLegacyRel = `.harness/artifacts/${run1.id}/${task1.id}/g0-dossier.md`;
  const legacyRun1Dir = join(repo, ".harness", "artifacts", run1.id);
  const dataRun1Dir = join(dataDirSp.artifactsDir(run1), run1.id);
  mkdirSync(dirname(dataRun1Dir), { recursive: true });
  renameSync(legacyRun1Dir, dataRun1Dir);
  symlinkSync(dataRun1Dir, legacyRun1Dir);
  const dossierDataAbs = join(dataRun1Dir, task1.id, "g0-dossier.md");
  db.db.prepare("UPDATE artifacts SET path = ? WHERE id = ?").run(dossierDataAbs, legacyArt1.id);

  // 2. Migrated run1 flat spill file + bridge + rewritten DB row
  const spillBody = "migrated flat spill summary\n";
  const spillName = `${task1.id}-summary-1.md`;
  const spillLegacyRel = `.harness/artifacts/${spillName}`;
  const spillLegacyAbs = join(repo, spillLegacyRel);
  const spillDataAbs = join(dataDirSp.artifactsDir(run1), spillName);
  writeFile(spillDataAbs, spillBody);
  symlinkSync(spillDataAbs, spillLegacyAbs);
  db.recordArtifact({ runId: run1.id, taskId: task1.id, kind: "dossier", path: spillDataAbs, summary: "Flat spill" });

  // 3. Migrated bucket task dir + bridge + rewritten DB row
  const bucketBody = "migrated bucket scout dossier\n";
  const legacyBucketArt = writeTaskDossier(db, bucketRun, bucketTask.id, "scout.md", bucketBody, "Scout", legacyStoragePaths);
  const bucketLegacyAbs = legacyBucketArt.path;
  const bucketLegacyRel = `.harness/artifacts/${bucketRun.id}/${bucketTask.id}/scout.md`;
  const legacyBucketTaskDir = join(repo, ".harness", "artifacts", bucketRun.id, bucketTask.id);
  const dataBucketTaskDir = join(dataDirSp.artifactsDir(bucketRun), bucketRun.id, bucketTask.id);
  mkdirSync(dirname(dataBucketTaskDir), { recursive: true });
  renameSync(legacyBucketTaskDir, dataBucketTaskDir);
  symlinkSync(dataBucketTaskDir, legacyBucketTaskDir);
  const bucketDataAbs = join(dataBucketTaskDir, "scout.md");
  db.db.prepare("UPDATE artifacts SET path = ? WHERE id = ?").run(bucketDataAbs, legacyBucketArt.id);

  // 4. Other run (run2) migrated dossier + flat spill
  const legacyArt2 = writeTaskDossier(db, run2, task2.id, "secret-r2.md", "run2 secret\n", "R2", legacyStoragePaths);
  const run2DossierLegacyAbs = legacyArt2.path;
  const run2DossierLegacyRel = `.harness/artifacts/${run2.id}/${task2.id}/secret-r2.md`;
  const legacyRun2Dir = join(repo, ".harness", "artifacts", run2.id);
  const dataRun2Dir = join(dataDirSp.artifactsDir(run2), run2.id);
  mkdirSync(dirname(dataRun2Dir), { recursive: true });
  renameSync(legacyRun2Dir, dataRun2Dir);
  symlinkSync(dataRun2Dir, legacyRun2Dir);
  const run2DossierDataAbs = join(dataRun2Dir, task2.id, "secret-r2.md");
  db.db.prepare("UPDATE artifacts SET path = ? WHERE id = ?").run(run2DossierDataAbs, legacyArt2.id);

  const run2SpillDataAbs = join(dataDirSp.artifactsDir(run2), `${task2.id}-summary-1.md`);
  writeFile(run2SpillDataAbs, "run2 flat spill secret\n");
  db.recordArtifact({ runId: run2.id, taskId: task2.id, kind: "dossier", path: run2SpillDataAbs, summary: "R2 spill" });

  // 5. Migrated goal evidence dir + bridge
  const goalId = "goal-1";
  const goalEvBody = "migrated goal evidence content\n";
  const goalEvLegacyRel = `.harness/goals/${goalId}/evidence.md`;
  const goalEvLegacyAbs = join(repo, goalEvLegacyRel);
  const legacyGoalDir = join(repo, ".harness", "goals", goalId);
  const dataGoalDir = join(dataDirSp.goalsDir({ repoRoot: repo, chatSessionId: "chat-1" }), goalId);
  const goalEvDataAbs = join(dataGoalDir, "evidence.md");
  writeFile(goalEvDataAbs, goalEvBody);
  mkdirSync(dirname(legacyGoalDir), { recursive: true });
  symlinkSync(dataGoalDir, legacyGoalDir);

  // 6. Migrated project note + bridge
  const noteBody = "migrated project note content\n";
  const noteLegacyRel = ".harness/notes/migrated-note.md";
  const noteLegacyAbs = join(repo, noteLegacyRel);
  const noteDataAbs = join(dataDirSp.projectNotesDir(repo), "migrated-note.md");
  writeFile(noteDataAbs, noteBody);
  mkdirSync(dirname(noteLegacyAbs), { recursive: true });
  symlinkSync(noteDataAbs, noteLegacyAbs);

  // 7. Migrated per-chat note under projects/<key>/chats/chat-1/notes/
  const chatNoteDataAbs = join(dataDirSp.notesDir({ repoRoot: repo, chatSessionId: "chat-1" }), "chat-note.md");
  writeFile(chatNoteDataAbs, "per-chat note content\n");

  return {
    root,
    stateDir,
    repo,
    otherRepo,
    db,
    legacySp,
    dataDirSp,
    run1,
    run2,
    bucketRun,
    task1Id: task1.id,
    task2Id: task2.id,
    bucketTaskId: bucketTask.id,
    dossierBody,
    dossierDataAbs,
    dossierLegacyAbs,
    dossierLegacyRel,
    spillBody,
    spillDataAbs,
    spillLegacyAbs,
    spillLegacyRel,
    bucketBody,
    bucketDataAbs,
    bucketLegacyAbs,
    bucketLegacyRel,
    run2DossierDataAbs,
    run2DossierLegacyAbs,
    run2DossierLegacyRel,
    run2SpillDataAbs,
    goalId,
    goalEvBody,
    goalEvDataAbs,
    goalEvLegacyAbs,
    goalEvLegacyRel,
    noteBody,
    noteDataAbs,
    noteLegacyAbs,
    noteLegacyRel,
    chatNoteDataAbs,
  };
}

describe("legacy-layout readers accept already-migrated data-dir units (FL / esc-154)", () => {
  it("L1: readRunDossier/findRunDossier/hashRunDossier read migrated dossiers via rewritten path and valid bridges, while refusing other runs and foreign symlinks", async () => {
    const fx = createMigratedFixture();
    try {
      const { db, legacySp, run1, run2, bucketRun } = fx;
      assert.equal(legacySp.layout, "legacy");

      // 1. Run dossier readable by rewritten absolute, legacy absolute, and workspace-relative legacy spellings.
      const expectedDossierHash = {
        sha256: createHash("sha256").update(fx.dossierBody).digest("hex"),
        bytes: fx.dossierBody.length,
      };
      for (const query of [fx.dossierDataAbs, fx.dossierLegacyAbs, fx.dossierLegacyRel]) {
        const found = findRunDossier(db, run1, query, legacySp);
        assert.ok(found, `findRunDossier should match ${query} in legacy layout`);
        const read = readRunDossier(db, run1, { path: query }, legacySp) as { path: string; content: string };
        assert.equal(read.content, fx.dossierBody, `content mismatch for ${query}`);
        assert.equal(read.path, fx.dossierDataAbs, `path mismatch for ${query}`);
        assert.deepEqual(await hashRunDossier(db, run1, query, undefined, legacySp), expectedDossierHash);
      }

      // 2. Flat spill readable by all three spellings.
      for (const query of [fx.spillDataAbs, fx.spillLegacyAbs, fx.spillLegacyRel]) {
        const read = readRunDossier(db, run1, { path: query }, legacySp) as { path: string; content: string };
        assert.equal(read.content, fx.spillBody, `flat spill mismatch for ${query}`);
        assert.equal(read.path, fx.spillDataAbs);
      }

      // 3. Bucket task dossier readable by all three spellings.
      for (const query of [fx.bucketDataAbs, fx.bucketLegacyAbs, fx.bucketLegacyRel]) {
        const read = readRunDossier(db, bucketRun, { path: query }, legacySp) as { path: string; content: string };
        assert.equal(read.content, fx.bucketBody, `bucket dossier mismatch for ${query}`);
        assert.equal(read.path, fx.bucketDataAbs);
      }

      // 4. Rows belonging to another run (run2) are still refused when queried under run1.
      for (const foreign of [fx.run2DossierDataAbs, fx.run2DossierLegacyAbs, fx.run2DossierLegacyRel, fx.run2SpillDataAbs]) {
        assert.equal(findRunDossier(db, run1, foreign, legacySp), null, `run1 must not find run2 row ${foreign}`);
        assert.throws(() => readRunDossier(db, run1, { path: foreign }, legacySp), /dossier-not-indexed/);
        assert.equal(await hashRunDossier(db, run1, foreign, undefined, legacySp), null);
      }

      // 5. A symlink at the unit path pointing elsewhere (foreign target) is refused for legacy spellings.
      const trapDir = join(fx.root, "trap-dir");
      writeFile(join(trapDir, fx.task1Id, "g0-dossier.md"), "TRAP CONTENT DO NOT READ\n");
      const legacyRun1Dir = join(fx.repo, ".harness", "artifacts", run1.id);
      rmSync(legacyRun1Dir);
      symlinkSync(trapDir, legacyRun1Dir);

      for (const legacySpelling of [fx.dossierLegacyAbs, fx.dossierLegacyRel]) {
        assert.equal(findRunDossier(db, run1, legacySpelling, legacySp), null, `foreign symlink must not resolve ${legacySpelling}`);
        assert.throws(() => readRunDossier(db, run1, { path: legacySpelling }, legacySp), /dossier-not-indexed/);
        assert.equal(await hashRunDossier(db, run1, legacySpelling, undefined, legacySp), null);
      }
      // Rewritten direct data-dir row still reads the real data-dir file (never touches trapDir).
      const directAfterTrap = readRunDossier(db, run1, { path: fx.dossierDataAbs }, legacySp) as { content: string };
      assert.equal(directAfterTrap.content, fx.dossierBody);

      // Foreign symlink pointing to another run's data-dir unit is also refused.
      rmSync(legacyRun1Dir);
      symlinkSync(dirname(dirname(fx.run2DossierDataAbs)), legacyRun1Dir);
      assert.throws(() => readRunDossier(db, run1, { path: fx.dossierLegacyRel }, legacySp), /dossier-not-indexed/);

      // Without any bridge symlink, legacy spellings are refused as dossier-not-indexed while rewritten data-dir row still reads.
      rmSync(legacyRun1Dir);
      assert.throws(() => readRunDossier(db, run1, { path: fx.dossierLegacyRel }, legacySp), /dossier-not-indexed/);
      assert.equal(
        (readRunDossier(db, run1, { path: fx.dossierDataAbs }, legacySp) as { content: string }).content,
        fx.dossierBody,
      );

      // A symlink leaf inside the data-dir unit pointing to a secret file is refused (pinned open / O_NOFOLLOW).
      const secretFile = join(fx.root, "secret.txt");
      writeFile(secretFile, "TOP SECRET\n");
      const evilLeaf = join(dirname(fx.dossierDataAbs), "evil.md");
      symlinkSync(secretFile, evilLeaf);
      db.recordArtifact({ runId: run1.id, taskId: fx.task1Id, kind: "dossier", path: evilLeaf, summary: "Evil" });
      assert.throws(() => readRunDossier(db, run1, { path: evilLeaf }, legacySp), /dossier-symlink/);
      assert.equal(await hashRunDossier(db, run1, evilLeaf, undefined, legacySp), null);

      // 6. Legacy-layout writes stay in the repo (unchanged).
      const run3 = db.createRun({ goal: "New legacy write", repoRoot: fx.repo, baseBranch: "main", baseSha: "abc1234", chatSessionId: "chat-3" });
      const task3 = db.createTask({ runId: run3.id, tier: 2, kind: "worker", title: "W3", objective: "Write", profileId: "acp:claude" });
      const written = writeTaskDossier(db, run3, task3.id, "fresh.md", "fresh legacy write\n", "Fresh", legacySp);
      assert.equal(written.path, join(fx.repo, ".harness", "artifacts", run3.id, task3.id, "fresh.md"));
      assert.equal(lstatSync(written.path).isFile(), true);
    } finally {
      fx.db.close();
    }
  });

  it("L2: directorReadPolicy and resolveLegacyPath allow migrated goal/note spellings (with B8 union) and refuse worktrees, project.json, sqlite, and other projects", () => {
    const fx = createMigratedFixture();
    try {
      const { legacySp, dataDirSp, repo, otherRepo, stateDir } = fx;
      const owner = { repoRoot: repo, chatSessionId: "chat-1" };

      // 1. All three spellings of the migrated goal evidence file and note resolve and pass directorReadPolicy + resolveDirectorReadablePath.
      for (const query of [fx.goalEvDataAbs, fx.goalEvLegacyAbs, fx.goalEvLegacyRel]) {
        const mapped = legacySp.resolveLegacyPath(repo, query, owner);
        assert.equal(mapped, fx.goalEvDataAbs, `resolveLegacyPath failed for goal spelling ${query}`);
        assert.deepEqual(legacySp.directorReadPolicy(repo, mapped!), { ok: true }, `directorReadPolicy refused ${mapped}`);
        const resolved = resolveDirectorReadablePath(repo, query, { storage: legacySp, owner });
        assert.equal(resolved.target, fx.goalEvDataAbs);
      }
      // Direct bridge paths also pass directorReadPolicy.
      assert.deepEqual(legacySp.directorReadPolicy(repo, fx.goalEvLegacyAbs), { ok: true });

      for (const query of [fx.noteDataAbs, fx.noteLegacyAbs, fx.noteLegacyRel]) {
        const mapped = legacySp.resolveLegacyPath(repo, query, owner);
        assert.equal(mapped, fx.noteDataAbs, `resolveLegacyPath failed for note spelling ${query}`);
        assert.deepEqual(legacySp.directorReadPolicy(repo, mapped!), { ok: true }, `directorReadPolicy refused ${mapped}`);
        const resolved = resolveDirectorReadablePath(repo, query, { storage: legacySp, owner });
        assert.equal(resolved.target, fx.noteDataAbs);
      }
      assert.deepEqual(legacySp.directorReadPolicy(repo, fx.noteLegacyAbs), { ok: true });

      // Per-chat note under projects/<key>/chats/chat-1/notes/ is also accepted for reads.
      assert.equal(legacySp.resolveLegacyPath(repo, fx.chatNoteDataAbs, owner), fx.chatNoteDataAbs);
      assert.deepEqual(legacySp.directorReadPolicy(repo, fx.chatNoteDataAbs), { ok: true });

      // 2. Both-exist union (B8): real legacy file wins over data-dir copy; data-dir-only file remains readable; nonexistent stays legacy.
      const bothGoalId = "goal-both";
      const legBothDir = join(repo, ".harness", "goals", bothGoalId);
      const ddBothDir = join(dataDirSp.goalsDir(owner), bothGoalId);
      writeFile(join(legBothDir, "conflict.md"), "legacy winner\n");
      writeFile(join(ddBothDir, "conflict.md"), "data-dir shadowed\n");
      writeFile(join(ddBothDir, "only-dd.md"), "only in data-dir\n");

      for (const q of [`.harness/goals/${bothGoalId}/conflict.md`, join(legBothDir, "conflict.md"), join(ddBothDir, "conflict.md")]) {
        assert.equal(legacySp.resolveLegacyPath(repo, q, owner), join(legBothDir, "conflict.md"), `legacy must win for ${q}`);
      }
      for (const q of [`.harness/goals/${bothGoalId}/only-dd.md`, join(legBothDir, "only-dd.md"), join(ddBothDir, "only-dd.md")]) {
        assert.equal(legacySp.resolveLegacyPath(repo, q, owner), join(ddBothDir, "only-dd.md"), `data-dir-only must resolve for ${q}`);
      }
      // Brand-new file not present anywhere keeps legacy repo path (writes unchanged).
      assert.equal(
        legacySp.resolveLegacyPath(repo, ".harness/notes/brand-new.md", owner),
        join(repo, ".harness", "notes", "brand-new.md"),
      );

      // 3. Refusals: worktrees, scratch, project.json, migration state, control-plane.sqlite, and another project's data.
      const worktreeFile = join(
        dataDirSp.worktreePath({ repoRoot: repo, id: "run-99", chatSessionId: "chat-1" }, "t-99"),
        "secret.ts",
      );
      writeFile(worktreeFile, "worktree secret\n");

      const scratchFile = join(dataDirSp.scratchPath(repo, "_verify", "v1"), "scratch.ts");
      writeFile(scratchFile, "scratch secret\n");

      const projectJson = join(dataDirSp.projectDir(repo), "project.json");
      assert.equal(existsSync(projectJson), true);

      const migrationState = join(dataDirSp.projectDir(repo), "migration-state.json");
      writeFile(migrationState, "{}\n");

      const sqliteFile = join(stateDir, "control-plane.sqlite");
      writeFile(sqliteFile, "sqlite-bytes\n");

      const otherProjNote = join(dataDirSp.projectNotesDir(otherRepo), "other-secret.md");
      writeFile(otherProjNote, "other project note\n");
      const otherProjGoalEv = join(dataDirSp.goalsDir({ repoRoot: otherRepo, chatSessionId: "chat-1" }), "goal-other", "ev.md");
      writeFile(otherProjGoalEv, "other project goal\n");

      for (const forbidden of [worktreeFile, scratchFile, projectJson, migrationState, sqliteFile, otherProjNote, otherProjGoalEv]) {
        assert.equal(
          legacySp.directorReadPolicy(repo, forbidden).ok,
          false,
          `directorReadPolicy must refuse ${forbidden} in legacy layout`,
        );
        assert.equal(
          legacySp.resolveLegacyPath(repo, forbidden, owner),
          null,
          `resolveLegacyPath must return null for ${forbidden} in legacy layout`,
        );
      }

      // Foreign symlink at a legacy goal/note path pointing to protected state is refused and never bypasses to data-dir.
      const evilGoalLink = join(repo, ".harness", "goals", "goal-evil");
      symlinkSync(stateDir, evilGoalLink);
      assert.equal(
        legacySp.resolveLegacyPath(repo, ".harness/goals/goal-evil/control-plane.sqlite", owner),
        join(repo, ".harness", "goals", "goal-evil", "control-plane.sqlite"),
      );
      assert.equal(legacySp.directorReadPolicy(repo, join(evilGoalLink, "control-plane.sqlite")).ok, false);
      assert.throws(
        () => resolveDirectorReadablePath(repo, ".harness/goals/goal-evil/control-plane.sqlite", { storage: legacySp, owner }),
        /protected/i,
      );

      // 4. directorWritePolicy and directorNoteRoots are NOT widened in legacy layout.
      const noteRoots = legacySp.directorNoteRoots(owner);
      assert.deepEqual(noteRoots.allowedWriteRoots, [join(repo, ".harness", "goals"), join(repo, ".harness", "notes")]);
      assert.equal(legacySp.directorWritePolicy(owner, fx.noteDataAbs).ok, false);
      assert.equal(legacySp.directorWritePolicy(owner, fx.goalEvDataAbs).ok, false);
      assert.equal(legacySp.directorWritePolicy(owner, fx.noteLegacyAbs).ok, false);

      // 5. Pre-migration parity: a repo with nothing in dataRoot behaves identically to legacy-only.
      const cleanRepo = join(fx.root, "clean-repo");
      mkdirSync(cleanRepo, { recursive: true });
      assert.equal(
        legacySp.resolveLegacyPath(cleanRepo, ".harness/goals/goal-1/ev.md"),
        join(cleanRepo, ".harness", "goals", "goal-1", "ev.md"),
      );
      assert.equal(
        legacySp.resolveLegacyPath(cleanRepo, ".harness/notes/plan.md"),
        join(cleanRepo, ".harness", "notes", "plan.md"),
      );
      assert.equal(
        legacySp.resolveLegacyPath(cleanRepo, join(dataDirSp.projectNotesDir(cleanRepo), "plan.md")),
        null,
      );
      assert.deepEqual(
        legacySp.directorReadPolicy(cleanRepo, join(cleanRepo, "README.md")),
        legacyStoragePaths.directorReadPolicy(cleanRepo, join(cleanRepo, "README.md")),
      );
      assert.deepEqual(
        legacySp.directorReadPolicy(cleanRepo, join(stateDir, "outside.txt")),
        legacyStoragePaths.directorReadPolicy(cleanRepo, join(stateDir, "outside.txt")),
      );
    } finally {
      fx.db.close();
    }
  });
});
