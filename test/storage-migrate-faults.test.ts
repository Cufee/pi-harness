import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { GoalEngine } from "../src/goals/engine.js";
import {
  type MigrationFaultStep,
  runStorageMigrationPass,
} from "../src/storage/migrate.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

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

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

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

function seedGoalUnitFixture(prefix: string) {
  const root = makeTempDir(prefix);
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
  const goals = new GoalEngine(cpDb.db);
  const storage = storagePaths({ stateDir }, { layout: "data-dir" });

  const goal = goals.createGoal({
    repoRoot: repo,
    chatSessionId: "chat-4",
    title: "Fault fixture",
    description: "Crash recovery test",
    criteria: [{ id: "c1", description: "Converges", kind: "behavioral" }],
  });
  const run = cpDb.createRun({
    goal: "Fault fixture",
    repoRoot: repo,
    baseBranch: "main",
    baseSha: "abc1234",
    chatSessionId: "chat-4",
  });
  goals.linkRunAndStart(goal.id, run.id);
  const task = cpDb.createTask({
    runId: run.id,
    tier: 2,
    kind: "worker",
    title: "Worker",
    objective: "Write dossiers",
    profileId: "acp:claude",
  });
  cpDb.updateTask(task.id, { status: "completed" });
  cpDb.updateRunStatus(run.id, "completed");
  goals.setStatus(goal.id, "achieved");

  const goalDir = join(repo, ".harness", "goals", goal.id);
  const runDir = join(repo, ".harness", "artifacts", run.id);
  const spillFile = join(repo, ".harness", "artifacts", `${task.id}-summary-1.md`);

  writeFile(join(goalDir, "evidence.md"), "goal evidence payload\n");
  writeFile(join(goalDir, "nested", "metrics.json"), '{"score":42}\n');
  const dossierA = join(runDir, task.id, "dossier-a.md");
  const dossierB = join(runDir, task.id, "sub", "dossier-b.md");
  writeFile(dossierA, "dossier A payload\n");
  writeFile(dossierB, "dossier B payload\n");
  writeFile(spillFile, "summary overflow payload\n");

  const artA = cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: dossierA, summary: "A" });
  const artB = cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: dossierB, summary: "B" });
  const artSpill = cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: spillFile, summary: "Spill" });

  const projDir = storage.projectDir(repo);
  const destGoalDir = join(projDir, "chats", "chat-4", "goals", goal.id);
  const destRunDir = join(projDir, "chats", "chat-4", "artifacts", run.id);
  const destSpillFile = join(projDir, "chats", "chat-4", "artifacts", `${task.id}-summary-1.md`);

  return {
    root,
    stateDir,
    repo,
    cpDb,
    goals,
    storage,
    goal,
    run,
    task,
    goalDir,
    runDir,
    spillFile,
    destGoalDir,
    destRunDir,
    destSpillFile,
    artA,
    artB,
    artSpill,
    beforeGoalHashes: hashTree(goalDir),
    beforeRunHashes: hashTree(runDir),
    beforeSpillHashes: hashTree(spillFile),
  };
}

function assertConverged(f: ReturnType<typeof seedGoalUnitFixture>, label: string): void {
  // Files exist at destination with exact pre-migration hashes.
  assertHashMapEqual(hashTree(f.destGoalDir), f.beforeGoalHashes, `${label}: goal dir`);
  assertHashMapEqual(hashTree(f.destRunDir), f.beforeRunHashes, `${label}: run dir`);
  assertHashMapEqual(hashTree(f.destSpillFile), f.beforeSpillHashes, `${label}: spill file`);

  // No leftover .migrating staging paths.
  assert.equal(existsSync(`${f.destGoalDir}.migrating`), false);
  assert.equal(existsSync(`${f.destRunDir}.migrating`), false);
  assert.equal(existsSync(`${f.destSpillFile}.migrating`), false);

  // Unit-level bridge symlinks are in place at every legacy path.
  for (const [legacyPath, destPath] of [
    [f.goalDir, f.destGoalDir],
    [f.runDir, f.destRunDir],
    [f.spillFile, f.destSpillFile],
  ] as const) {
    const st = lstatSync(legacyPath);
    assert.equal(st.isSymbolicLink(), true, `${label}: expected bridge at ${legacyPath}`);
    assert.equal(readlinkSync(legacyPath), destPath, `${label}: bridge target mismatch`);
  }

  // All artifacts rows rewritten to exact new absolute paths.
  const getPath = (id: string) =>
    (f.cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(id) as { path: string }).path;
  assert.equal(getPath(f.artA.id), join(f.destRunDir, f.task.id, "dossier-a.md"));
  assert.equal(getPath(f.artB.id), join(f.destRunDir, f.task.id, "sub", "dossier-b.md"));
  assert.equal(getPath(f.artSpill.id), f.destSpillFile);

  // Follow-up pass is a pure idempotent no-op.
  const idemp = runStorageMigrationPass({ sqlite: f.cpDb.db, storage: f.storage });
  assert.equal(idemp.errors.length, 0);
  assert.equal(idemp.totals.migrated, 0);
  assert.equal(idemp.totals.merged, 0);
  assert.equal(idemp.totals.finished, 0);
  assert.equal(idemp.totals.rowsRewritten, 0);
}

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storage migration fault injection & both-exist merge", () => {
  const renameSteps: MigrationFaultStep[] = ["after_rename_into_place", "after_row_rewrite", "before_bridge"];

  for (const step of renameSteps) {
    it(`rename path converges after simulated crash at ${step}`, () => {
      const f = seedGoalUnitFixture(`pi-fault-rename-${step}-`);
      try {
        let fired = false;
        const pass1 = runStorageMigrationPass({
          sqlite: f.cpDb.db,
          storage: f.storage,
          forceCopy: false,
          fault: (s) => {
            if (s === step && !fired) {
              fired = true;
              throw new Error(`Injected crash at ${s}`);
            }
          },
        });
        assert.equal(fired, true, `Expected fault hook ${step} to fire on rename path`);
        assert.ok(pass1.errors.length >= 1);

        // Verify intermediate state at the crash point.
        if (step === "after_rename_into_place" || step === "before_bridge") {
          assert.equal(existsSync(f.destGoalDir), true);
          assert.equal(existsSync(f.goalDir), false);
          // Rows were not rewritten yet (rename path bridges before row rewrite per D3).
          const rowA = f.cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(f.artA.id) as { path: string };
          assert.ok(rowA.path.includes(".harness"));
        } else {
          // Rows ARE rewritten, and bridges were already created before row rewrite (D3).
          const rowA = f.cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(f.artA.id) as { path: string };
          assert.equal(rowA.path, join(f.destRunDir, f.task.id, "dossier-a.md"));
          assert.equal(lstatSync(f.goalDir).isSymbolicLink(), true);
          assert.equal(readlinkSync(f.goalDir), f.destGoalDir);
        }

        const pass2 = runStorageMigrationPass({ sqlite: f.cpDb.db, storage: f.storage, forceCopy: false });
        assert.equal(pass2.errors.length, 0);
        assertConverged(f, `rename/${step}`);
      } finally {
        f.cpDb.close();
      }
    });
  }

  it("rename crash after rename and before row rewrite recovers purely from artifacts rows even without migration-state.json", () => {
    const root = makeTempDir("pi-fault-row-only-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    try {
      const storage = storagePaths({ stateDir }, { layout: "data-dir" });
      const run = cpDb.createRun({
        goal: "Pure row recovery",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc",
        chatSessionId: "chat-3",
      });
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "W",
        objective: "O",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const runDir = join(repo, ".harness", "artifacts", run.id);
      const doc = join(runDir, task.id, "doc.md");
      writeFile(doc, "recover me from rows\n");
      const art = cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: doc, summary: "Doc" });
      const beforeHashes = hashTree(runDir);

      // Crash right after renameSync, before row rewrite.
      const pass1 = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        fault: (s) => {
          if (s === "after_rename_into_place") throw new Error("Crash after rename");
        },
      });
      assert.ok(pass1.errors.length >= 1);
      assert.equal(existsSync(runDir), false);

      // Delete migration-state.json so recovery MUST rely purely on artifacts rows + data-dir scan.
      const stateFile = join(storage.projectDir(repo), "migration-state.json");
      if (existsSync(stateFile)) unlinkSync(stateFile);

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.rowsRewritten, 1);

      const destRunDir = join(storage.projectDir(repo), "chats", "chat-3", "artifacts", run.id);
      assertHashMapEqual(hashTree(destRunDir), beforeHashes, "pure row recovery");
      assert.equal(lstatSync(runDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(runDir), destRunDir);
      const rewritten = (cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string }).path;
      assert.equal(rewritten, join(destRunDir, task.id, "doc.md"));
    } finally {
      cpDb.close();
    }
  });

  const forceCopySteps: MigrationFaultStep[] = [
    "after_copy",
    "after_verify",
    "after_rename_into_place",
    "after_legacy_delete",
    "after_row_rewrite",
    "before_bridge",
  ];

  for (const step of forceCopySteps) {
    it(`forceCopy path converges after simulated crash at ${step}`, () => {
      const f = seedGoalUnitFixture(`pi-fault-copy-${step}-`);
      try {
        let fired = false;
        const pass1 = runStorageMigrationPass({
          sqlite: f.cpDb.db,
          storage: f.storage,
          forceCopy: true,
          fault: (s) => {
            if (s === step && !fired) {
              fired = true;
              throw new Error(`Injected copy crash at ${s}`);
            }
          },
        });
        assert.equal(fired, true, `Expected fault hook ${step} to fire on forceCopy path`);
        assert.ok(pass1.errors.length >= 1);

        // Verify intermediate invariants at each step.
        if (step === "after_copy" || step === "after_verify") {
          assert.equal(existsSync(`${f.destGoalDir}.migrating`), false, "Must never stage at public <dest>.migrating");
          const stagingRoot = join(f.storage.projectDir(f.repo), ".migration-staging");
          assert.equal(existsSync(stagingRoot), true, "Expected private .migration-staging directory");
          const stageDirs = readdirSync(stagingRoot);
          assert.equal(stageDirs.length, 1, `Expected 1 recorded stage opId dir, got ${stageDirs.length}`);
          assert.equal(existsSync(join(stagingRoot, stageDirs[0]!, "payload")), true);
          assert.equal(existsSync(f.destGoalDir), false);
          assertHashMapEqual(hashTree(f.goalDir), f.beforeGoalHashes, `${step}: legacy untouched`);
        } else if (step === "after_rename_into_place") {
          // Both real legacy dir and real dest dir exist on disk right after staged rename.
          assert.equal(existsSync(f.destGoalDir), true);
          assert.equal(existsSync(f.goalDir), true);
          assert.equal(lstatSync(f.goalDir).isSymbolicLink(), false);
        } else if (step === "after_legacy_delete") {
          assert.equal(existsSync(f.destGoalDir), true);
          assert.equal(existsSync(f.goalDir), false);
          const rowA = f.cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(f.artA.id) as { path: string };
          assert.ok(rowA.path.includes(".harness"));
        } else {
          const rowA = f.cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(f.artA.id) as { path: string };
          assert.equal(rowA.path, join(f.destRunDir, f.task.id, "dossier-a.md"));
        }

        const pass2 = runStorageMigrationPass({ sqlite: f.cpDb.db, storage: f.storage, forceCopy: true });
        assert.equal(pass2.errors.length, 0);
        assertConverged(f, `forceCopy/${step}`);
      } finally {
        f.cpDb.close();
      }
    });
  }

  it("merges when both real legacy dir and destination exist after fallback, keeping legacy at canonical name and preserving shadowed dest copy", () => {
    const root = makeTempDir("pi-fault-both-exist-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    try {
      const storage = storagePaths({ stateDir }, { layout: "data-dir" });
      const run = cpDb.createRun({
        goal: "Fallback merge",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc",
        chatSessionId: "chat-2",
      });
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Merge",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const legacyRunDir = join(repo, ".harness", "artifacts", run.id);
      writeFile(join(legacyRunDir, task.id, "same.md"), "identical content\n");
      writeFile(join(legacyRunDir, task.id, "conflict.md"), "original dest content\n");
      writeFile(join(legacyRunDir, task.id, "dest-only.md"), "stays at dest\n");

      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass1.errors.length, 0);
      const destRunDir = join(storage.projectDir(repo), "chats", "chat-2", "artifacts", run.id);
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);

      // Simulate previous release fallback: remove bridge symlink and recreate real legacy dir
      // with one identical file, one conflicting file, and two new files.
      unlinkSync(legacyRunDir);
      writeFile(join(legacyRunDir, task.id, "same.md"), "identical content\n");
      writeFile(join(legacyRunDir, task.id, "conflict.md"), "newer legacy fallback content\n");
      writeFile(join(legacyRunDir, task.id, "fallback-new.md"), "brand new file from fallback\n");
      writeFile(join(legacyRunDir, task.id, "nested", "extra.md"), "nested fallback file\n");

      const destConflictHex8 = sha256("original dest content\n").slice(0, 8);
      const expectedPreMergePath = join(destRunDir, task.id, `conflict.md.pre-merge-${destConflictHex8}`);

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.merged, 1);

      // Legacy path is back to a bridge symlink.
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyRunDir), destRunDir);

      // Verify full content survival at destination:
      const expectedFiles = new Map<string, string>([
        [`${task.id}/same.md`, sha256("identical content\n")],
        [`${task.id}/dest-only.md`, sha256("stays at dest\n")],
        [`${task.id}/conflict.md`, sha256("newer legacy fallback content\n")],
        [`${task.id}/conflict.md.pre-merge-${destConflictHex8}`, sha256("original dest content\n")],
        [`${task.id}/fallback-new.md`, sha256("brand new file from fallback\n")],
        [`${task.id}/nested/extra.md`, sha256("nested fallback file\n")],
      ]);
      assertHashMapEqual(hashTree(destRunDir), expectedFiles, "both-exist merge result");
      assert.equal(readFileSync(expectedPreMergePath, "utf8"), "original dest content\n");

      // Idempotent third pass.
      const pass3 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass3.errors.length, 0);
      assert.equal(pass3.totals.merged, 0);
      assertHashMapEqual(hashTree(destRunDir), expectedFiles, "post-merge idempotency");
    } finally {
      cpDb.close();
    }
  });

  it("merges a conflicting single-file note unit without losing either version", () => {
    const root = makeTempDir("pi-fault-note-merge-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    try {
      const storage = storagePaths({ stateDir }, { layout: "data-dir" });
      const run = cpDb.createRun({ goal: "Note merge", repoRoot: repo, baseBranch: "main", baseSha: "abc" });
      cpDb.updateRunStatus(run.id, "completed");

      const legacyNote = join(repo, ".harness", "notes", "guide.md");
      writeFile(legacyNote, "v1 note content\n");
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass1.errors.length, 0);

      const destNote = join(storage.projectNotesDir(repo), "guide.md");
      assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);

      // Replace bridge with a real legacy note containing conflicting edits.
      unlinkSync(legacyNote);
      writeFile(legacyNote, "v2 fallback note content\n");

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.merged, 1);

      const v1Hex8 = sha256("v1 note content\n").slice(0, 8);
      assert.equal(readFileSync(destNote, "utf8"), "v2 fallback note content\n");
      assert.equal(readFileSync(`${destNote}.pre-merge-${v1Hex8}`, "utf8"), "v1 note content\n");
      assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyNote), destNote);
    } finally {
      cpDb.close();
    }
  });

  it("rewrites unrewritten artifact rows for an already-bridged unit younger than 7 days", () => {
    const root = makeTempDir("pi-fault-bridge-rows-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    try {
      const storage = storagePaths({ stateDir }, { layout: "data-dir" });
      const run = cpDb.createRun({ goal: "Bridge rows", repoRoot: repo, baseBranch: "main", baseSha: "abc", chatSessionId: "chat-6" });
      const task = cpDb.createTask({ runId: run.id, tier: 2, kind: "worker", title: "T", objective: "O", profileId: "acp:claude" });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const legacyRunDir = join(repo, ".harness", "artifacts", run.id);
      const legacyDoc = join(legacyRunDir, task.id, "doc.md");
      writeFile(legacyDoc, "bridged doc\n");

      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass1.errors.length, 0);
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);

      // Insert a legacy-path artifact row after the bridge already exists (e.g. legacy fallback write).
      const lateArt = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: legacyDoc,
        summary: "Late legacy row",
      });

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.rowsRewritten, 1);
      const destDoc = join(storage.projectDir(repo), "chats", "chat-6", "artifacts", run.id, task.id, "doc.md");
      const updated = (cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(lateArt.id) as { path: string }).path;
      assert.equal(updated, destDoc);
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);
    } finally {
      cpDb.close();
    }
  });
});
