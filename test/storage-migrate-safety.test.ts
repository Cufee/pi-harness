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
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { GoalEngine } from "../src/goals/engine.js";
import {
  BRIDGE_MAX_AGE_MS,
  planStorageMigration,
  runStorageMigrationPass,
} from "../src/storage/migrate.js";
import { parseLegacyPathForRepo } from "../src/storage/migrate/db.js";
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

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function hashTree(rootPath: string): Map<string, string> {
  const out = new Map<string, string>();
  const st = lstatSync(rootPath);
  if (st.isFile()) {
    out.set("", sha256(readFileSync(rootPath)));
    return out;
  }
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile()) {
        out.set(rel, sha256(readFileSync(abs)));
      }
    }
  };
  walk(rootPath, "");
  return out;
}

function createEnv(prefix: string, extraConfig?: { worktree?: { dir?: string } }) {
  const root = makeTempDir(prefix);
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
  const goals = new GoalEngine(cpDb.db);
  const storage = storagePaths({ stateDir, ...(extraConfig ?? {}) }, { layout: "data-dir" });
  return { root, stateDir, repo, cpDb, goals, storage };
}

afterEach(() => {
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("storage migration safety regressions", () => {
  it("M1: stages privately under .migration-staging/<opId>, never touches <dest>.migrating, and leaves unrecorded stages alone", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-m1-");
    try {
      const run = cpDb.createRun({
        goal: "M1 run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m1",
      });
      cpDb.updateRunStatus(run.id, "completed");

      const legacyNote = join(repo, ".harness", "notes", "brief");
      writeFile(legacyNote, "real legacy brief content\n");

      const legacyRunDir = join(repo, ".harness", "artifacts", run.id);
      writeFile(join(legacyRunDir, "t-1", "report.md"), "run report\n");

      const projectDir = storage.ensureProjectDir(repo);
      const destNote = join(storage.projectNotesDir(repo), "brief");
      const unrelatedNoteSibling = `${destNote}.migrating`;
      writeFile(unrelatedNoteSibling, "precious unrelated note named brief.migrating\n");

      const destRunDir = join(projectDir, "chats", "chat-m1", "artifacts", run.id);
      const unrelatedDirSibling = `${destRunDir}.migrating`;
      writeFile(join(unrelatedDirSibling, "keep.txt"), "precious unrelated directory sibling\n");

      const unrecordedStage = join(projectDir, ".migration-staging", "unowned-foreign-op");
      writeFile(join(unrecordedStage, "payload", "mystery.txt"), "do not delete me\n");

      let sawRecordedOpIdDuringCopy = false;
      const pass1 = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        forceCopy: true,
        fault: (step, ctx) => {
          if (step === "after_copy" && ctx.memberKind === "note") {
            const stateRaw = JSON.parse(readFileSync(join(projectDir, "migration-state.json"), "utf8")) as {
              pendingUnits: Array<{ unitKey: string; members: Array<{ stagingOpId?: string }> }>;
            };
            const pending = stateRaw.pendingUnits.find((u) => u.unitKey === ctx.unitKey);
            const opId = pending?.members[0]?.stagingOpId;
            assert.ok(opId && /^[0-9a-f]{32}$/.test(opId), `Expected crypto opId recorded before copy, got ${opId}`);
            assert.equal(existsSync(join(projectDir, ".migration-staging", opId, "payload")), true);
            sawRecordedOpIdDuringCopy = true;
          }
        },
      });

      assert.equal(pass1.errors.length, 0);
      assert.equal(sawRecordedOpIdDuringCopy, true);
      assert.equal(readFileSync(destNote, "utf8"), "real legacy brief content\n");
      assert.equal(readFileSync(join(destRunDir, "t-1", "report.md"), "utf8"), "run report\n");

      // Unrelated `<dest>.migrating` siblings survived untouched.
      assert.equal(readFileSync(unrelatedNoteSibling, "utf8"), "precious unrelated note named brief.migrating\n");
      assert.equal(readFileSync(join(unrelatedDirSibling, "keep.txt"), "utf8"), "precious unrelated directory sibling\n");

      // Unrecorded stage dir is left alone and reported once as unknown leftover.
      assert.equal(readFileSync(join(unrecordedStage, "payload", "mystery.txt"), "utf8"), "do not delete me\n");
      assert.ok(pass1.unknownEntries.includes(unrecordedStage), "Unrecorded stage must appear in unknownEntries");
      assert.ok(pass1.newUnknownEntries.includes(unrecordedStage), "Unrecorded stage must be reported once in newUnknownEntries");

      // Second pass does not re-report it as new and still leaves it untouched.
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage, forceCopy: true });
      assert.equal(pass2.errors.length, 0);
      assert.ok(pass2.unknownEntries.includes(unrecordedStage));
      assert.equal(pass2.newUnknownEntries.includes(unrecordedStage), false);
      assert.equal(existsSync(join(unrecordedStage, "payload", "mystery.txt")), true);
    } finally {
      cpDb.close();
    }
  });

  it("M2: cleanup removes only empty container dirs and never deletes empty deferred unit dirs or their empty subdirs", () => {
    const { repo, cpDb, goals, storage } = createEnv("pi-mig-m2-");
    try {
      // Executing goal with an empty legacy evidence dir and an empty legacy run dir.
      const liveGoal = goals.createGoal({
        repoRoot: repo,
        chatSessionId: "chat-m2",
        title: "Live goal",
        description: "In flight",
        criteria: [{ id: "c1", description: "done", kind: "behavioral" }],
      });
      const liveRun = cpDb.createRun({
        goal: "Live run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m2",
      });
      goals.linkRunAndStart(liveGoal.id, liveRun.id);

      const emptyGoalDir = join(repo, ".harness", "goals", liveGoal.id);
      const emptyRunDir = join(repo, ".harness", "artifacts", liveRun.id);
      mkdirSync(emptyGoalDir, { recursive: true });
      mkdirSync(emptyRunDir, { recursive: true });

      // Live bucket task with a file and an empty nested subdir.
      const liveBucket = cpDb.createRun({
        id: "director-tasks-chat-m2",
        goal: "Director bucket",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m2",
      });
      const liveTask = cpDb.createTask({
        runId: liveBucket.id,
        tier: 2,
        kind: "worker",
        title: "Running task",
        objective: "Work",
        profileId: "acp:claude",
      });
      cpDb.updateTask(liveTask.id, { status: "running" });
      const liveTaskDir = join(repo, ".harness", "artifacts", liveBucket.id, liveTask.id);
      const liveTaskEmptySub = join(liveTaskDir, "scratch-empty");
      writeFile(join(liveTaskDir, "wip.md"), "in progress\n");
      mkdirSync(liveTaskEmptySub, { recursive: true });

      // Empty container dirs that cleanup SHOULD remove: an empty bucket dir and empty notes subdirs.
      const emptyBucketContainer = join(repo, ".harness", "artifacts", "director-tasks-empty-chat");
      const emptyNotesSub = join(repo, ".harness", "notes", "nested", "empty");
      mkdirSync(emptyBucketContainer, { recursive: true });
      mkdirSync(emptyNotesSub, { recursive: true });

      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(report.errors.length, 0);
      assert.ok(report.totals.deferred >= 2, `Expected live units deferred, got ${report.totals.deferred}`);

      // Deferred empty unit dirs and empty subdirs inside live units MUST survive as real dirs.
      assert.equal(lstatSync(emptyGoalDir).isDirectory(), true, "Empty executing goal evidence dir must survive");
      assert.equal(lstatSync(emptyGoalDir).isSymbolicLink(), false);
      assert.equal(lstatSync(emptyRunDir).isDirectory(), true, "Empty executing run dir must survive");
      assert.equal(lstatSync(emptyRunDir).isSymbolicLink(), false);
      assert.equal(lstatSync(liveTaskEmptySub).isDirectory(), true, "Empty subdir inside live bucket task must survive");

      // Empty container dirs MUST be removed.
      assert.equal(existsSync(emptyBucketContainer), false, "Empty director-tasks-* container should be removed");
      assert.equal(existsSync(emptyNotesSub), false, "Empty notes subdir should be removed");
      assert.equal(existsSync(join(repo, ".harness", "notes")), false, "Empty notes container should be removed");
    } finally {
      cpDb.close();
    }
  });

  it("M3a: honors hard wall-clock budget on 4,200 empty notes + 10,000 artifact rows and converges over repeated equal budgets", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-m3a-");
    try {
      const run = cpDb.createRun({
        goal: "Reviewer budget fixture",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m3a",
      });
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Work",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const runDir = join(repo, ".harness", "artifacts", run.id);
      const taskDir = join(runDir, task.id);
      writeFile(join(taskDir, "summary.md"), "ok\n");

      const insertArt = cpDb.db.prepare(
        "INSERT INTO artifacts (id, run_id, task_id, kind, path, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      cpDb.db.transaction(() => {
        for (let i = 0; i < 10_000; i++) {
          insertArt.run(`art-m3-${i}`, run.id, task.id, "dossier", join(taskDir, `row-${i}.md`), "s", Date.now());
        }
      })();

      const notesDir = join(repo, ".harness", "notes");
      mkdirSync(notesDir, { recursive: true });
      for (let i = 0; i < 4_200; i++) {
        writeFileSync(join(notesDir, `note-${String(i).padStart(4, "0")}.md`), "");
      }

      // Tight equal budget (500ms): every pass must return well within budget + margin (1,500ms),
      // and repeated equal passes must converge cleanly with all 4,201 units migrated and 10,000 rows rewritten.
      const BUDGET_MS = 500;
      const MAX_WALL_MS = 1_500;
      let totalMigrated = 0;
      let totalRowsRewritten = 0;
      let sawBudgetHit = false;
      let passes = 0;
      let lastReport;

      while (passes < 60) {
        passes++;
        const t0 = performance.now();
        const report = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { budgetMs: BUDGET_MS });
        const wallMs = performance.now() - t0;
        assert.equal(report.errors.length, 0);
        assert.ok(wallMs < MAX_WALL_MS, `Pass ${passes} took ${Math.round(wallMs)}ms (budget ${BUDGET_MS}ms, limit ${MAX_WALL_MS}ms)`);
        totalMigrated += report.totals.migrated;
        totalRowsRewritten += report.totals.rowsRewritten;
        if (report.budgetExceeded) {
          sawBudgetHit = true;
          if (totalMigrated < 4_201) {
            assert.ok(report.totals.remaining > 0, "Expected remaining count > 0 when units still remain");
          }
        }
        lastReport = report;
        if (!report.budgetExceeded) break;
      }

      assert.ok(lastReport && !lastReport.budgetExceeded, `Did not converge within ${passes} equal-budget passes`);
      assert.equal(lastReport.totals.remaining, 0);
      assert.equal(totalMigrated, 4_201);
      assert.equal(totalRowsRewritten, 10_000);
      // Confirm repeated-pass convergence happened (if machine is super fast and finished in 1 pass, wallMs was <500ms!).
      assert.ok(sawBudgetHit || passes === 1);
    } finally {
      cpDb.close();
    }
  }, 30_000);

  it("M3b: forced-copy unit larger than one budget completes over several passes with the same injected-clock budget", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-m3b-");
    try {
      const run = cpDb.createRun({
        goal: "Resumable copy",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m3b",
      });
      cpDb.updateRunStatus(run.id, "completed");

      const runDir = join(repo, ".harness", "artifacts", run.id);
      for (let i = 1; i <= 12; i++) {
        writeFile(join(runDir, "t-1", `chunk-${String(i).padStart(2, "0")}.txt`), `data-${i}-`.repeat(20_000));
      }
      const beforeHashes = hashTree(runDir);

      // Fixed equal budget: each pass has the same 780ms injected clock (ticks 10ms per check),
      // so a single pass only copies a subset of files, yet repeated equal passes converge via manifest.jsonl
      // (D2 hashes destination bytes in the same pass before deletion, and D4 checks budget during fsync/delete).
      const EQUAL_BUDGET_MS = 780;
      const newPassClock = () => {
        let now = 5_000;
        return () => {
          now += 10;
          return now;
        };
      };

      const stagedCounts: number[] = [];
      let passes = 0;
      let totalMigrated = 0;
      let lastReport;
      const stagingRoot = join(storage.projectDir(repo), ".migration-staging");

      while (passes < 15) {
        passes++;
        const report = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: newPassClock(), forceCopy: true },
          { budgetMs: EQUAL_BUDGET_MS },
        );
        assert.equal(report.errors.length, 0);
        totalMigrated += report.totals.migrated + report.totals.merged + report.totals.finished;
        lastReport = report;
        if (!report.budgetExceeded) break;
        if (totalMigrated === 0 && existsSync(stagingRoot)) {
          const opIds = readdirSync(stagingRoot);
          assert.equal(opIds.length, 1, "Must reuse the same recorded opId across passes");
          const count = hashTree(join(stagingRoot, opIds[0]!, "payload")).size;
          stagedCounts.push(count);
        }
      }

      assert.ok(passes >= 3, `Expected multi-pass convergence (>=3 passes), finished in ${passes}`);
      assert.ok(stagedCounts.length >= 2, `Expected at least 2 intermediate staged snapshots, got ${stagedCounts.length}`);
      assert.ok(lastReport && !lastReport.budgetExceeded, "Must complete without raising budget");
      assert.equal(totalMigrated, 1);
      assert.equal(lastReport.totals.remaining, 0);
      // Verify monotonic progress across budget-limited passes (staged files kept between passes).
      for (let i = 1; i < stagedCounts.length; i++) {
        assert.ok(
          stagedCounts[i]! > stagedCounts[i - 1]!,
          `Expected strict forward progress between passes: ${JSON.stringify(stagedCounts)}`,
        );
      }

      const destRunDir = join(storage.projectDir(repo), "chats", "chat-m3b", "artifacts", run.id);
      assert.deepEqual(hashTree(destRunDir), beforeHashes);
      assert.equal(existsSync(stagingRoot), false, "Recorded stage dir must be cleaned up on completion");
      assert.equal(lstatSync(runDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(runDir), destRunDir);
    } finally {
      cpDb.close();
    }
  });

  it("M4: deletes only manifest-verified source identities; new/replaced files and new dirs survive for both-exist merge", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-m4-");
    try {
      const run = cpDb.createRun({
        goal: "M4 verified delete",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m4",
      });
      cpDb.updateRunStatus(run.id, "completed");

      const legacyRunDir = join(repo, ".harness", "artifacts", run.id);
      const untouchedPath = join(legacyRunDir, "t-1", "untouched.txt");
      const existingPath = join(legacyRunDir, "t-1", "existing.txt");
      writeFile(untouchedPath, "original untouched\n");
      writeFile(existingPath, "original v1\n");

      const lateFilePath = join(legacyRunDir, "t-1", "late-arrival.txt");
      const lateDirPath = join(legacyRunDir, "late-empty-dir");

      let mutatedAfterRename = false;
      const pass1 = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        forceCopy: true,
        fault: (step) => {
          if (step === "after_rename_into_place" && !mutatedAfterRename) {
            mutatedAfterRename = true;
            // 1. Brand-new file arrives after verification.
            writeFile(lateFilePath, "arrived after verification\n");
            // 2. Previously verified file is replaced atomically (new inode, size, mtimeNs).
            const tmpReplace = join(legacyRunDir, "t-1", ".replace.tmp");
            writeFileSync(tmpReplace, "replaced after verification with newer bytes\n", "utf8");
            renameSync(tmpReplace, existingPath);
            // 3. Brand-new empty directory arrives after verification.
            mkdirSync(lateDirPath, { recursive: true });
          }
        },
      });

      assert.equal(mutatedAfterRename, true);
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.repos[0]!.results.length, 1);
      assert.equal(pass1.repos[0]!.results[0]!.outcome, "both_exist");
      assert.equal(pass1.totals.bridgesCreated, 0);

      // Legacy path stayed a real directory (no bridge), verified untouched file was removed,
      // and every unverified/modified entry survived intact!
      assert.equal(lstatSync(legacyRunDir).isDirectory(), true);
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), false);
      assert.equal(existsSync(untouchedPath), false, "Verified unchanged file should have been removed from legacy");
      assert.equal(readFileSync(lateFilePath, "utf8"), "arrived after verification\n");
      assert.equal(readFileSync(existingPath, "utf8"), "replaced after verification with newer bytes\n");
      assert.equal(lstatSync(lateDirPath).isDirectory(), true);

      const destRunDir = join(storage.projectDir(repo), "chats", "chat-m4", "artifacts", run.id);
      assert.equal(readFileSync(join(destRunDir, "t-1", "untouched.txt"), "utf8"), "original untouched\n");
      assert.equal(readFileSync(join(destRunDir, "t-1", "existing.txt"), "utf8"), "original v1\n");

      // Next pass merges both-exist cleanly, preserving both versions of existing.txt and keeping late-arrival + late-empty-dir.
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage, forceCopy: true });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.merged, 1);
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyRunDir), destRunDir);
      assert.equal(readFileSync(join(destRunDir, "t-1", "untouched.txt"), "utf8"), "original untouched\n");
      assert.equal(readFileSync(join(destRunDir, "t-1", "late-arrival.txt"), "utf8"), "arrived after verification\n");
      assert.equal(
        readFileSync(join(destRunDir, "t-1", "existing.txt"), "utf8"),
        "replaced after verification with newer bytes\n",
      );
      assert.equal(lstatSync(join(destRunDir, "late-empty-dir")).isDirectory(), true);

      const shadowed = pass2.repos[0]!.results[0]!.shadowedFiles;
      assert.equal(shadowed.length, 1);
      assert.equal(readFileSync(shadowed[0]!.preservedPath, "utf8"), "original v1\n");
    } finally {
      cpDb.close();
    }
  });

  it("M5: resolves file-vs-directory collisions in both-exist merges by preserving the destination entry under a suffixed conflict name", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-m5-");
    try {
      const run = cpDb.createRun({
        goal: "M5 file vs dir merge",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m5",
      });
      cpDb.updateRunStatus(run.id, "completed");

      const legacyRunDir = join(repo, ".harness", "artifacts", run.id);
      const destRunDir = join(storage.ensureProjectDir(repo), "chats", "chat-m5", "artifacts", run.id);

      // Direction 1: legacy has a regular file at `t-1/item`, destination has a directory at `t-1/item/inside.txt`.
      writeFile(join(legacyRunDir, "t-1", "item"), "legacy file wins\n");
      writeFile(join(destRunDir, "t-1", "item", "inside.txt"), "destination dir preserved\n");

      // Direction 2: legacy has a directory at `t-1/node/child.txt`, destination has a regular file at `t-1/node`.
      writeFile(join(legacyRunDir, "t-1", "node", "child.txt"), "legacy dir child wins\n");
      writeFile(join(destRunDir, "t-1", "node"), "destination file preserved\n");

      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(report.errors.length, 0);
      assert.equal(report.totals.merged, 1);
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyRunDir), destRunDir);

      // Legacy entries won at canonical paths.
      assert.equal(lstatSync(join(destRunDir, "t-1", "item")).isFile(), true);
      assert.equal(readFileSync(join(destRunDir, "t-1", "item"), "utf8"), "legacy file wins\n");
      assert.equal(lstatSync(join(destRunDir, "t-1", "node")).isDirectory(), true);
      assert.equal(readFileSync(join(destRunDir, "t-1", "node", "child.txt"), "utf8"), "legacy dir child wins\n");

      // Both destination entries were preserved under `.pre-merge-*` suffixed names with nothing deleted.
      const shadowed = report.repos[0]!.results[0]!.shadowedFiles;
      assert.equal(shadowed.length, 2);
      const preservedDir = shadowed.find((s) => s.canonicalPath === join(destRunDir, "t-1", "item"))!;
      const preservedFile = shadowed.find((s) => s.canonicalPath === join(destRunDir, "t-1", "node"))!;
      assert.ok(preservedDir && preservedDir.preservedPath.includes(".pre-merge-"));
      assert.ok(preservedFile && preservedFile.preservedPath.includes(".pre-merge-"));
      assert.equal(readFileSync(join(preservedDir.preservedPath, "inside.txt"), "utf8"), "destination dir preserved\n");
      assert.equal(readFileSync(preservedFile.preservedPath, "utf8"), "destination file preserved\n");
    } finally {
      cpDb.close();
    }
  });

  it("M6: enforces exact bridge provenance, recorded bridge expiry, first-sight adoption, and recomputed pending journal recovery", () => {
    const { root, repo, cpDb, storage } = createEnv("pi-mig-m6-");
    try {
      const projDir = storage.ensureProjectDir(repo);

      // 1. Pre-existing symlink pointing to ANOTHER unit inside the same project subtree.
      const runA = cpDb.createRun({
        goal: "M6 wrong-target symlink",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m6",
      });
      const runB = cpDb.createRun({
        goal: "M6 decoy target run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m6",
      });
      cpDb.updateRunStatus(runA.id, "completed");
      cpDb.updateRunStatus(runB.id, "completed");
      const decoyDest = join(projDir, "chats", "chat-m6", "artifacts", runB.id);
      writeFile(join(decoyDest, "t-1", "decoy.md"), "decoy\n");

      const legacyRunA = join(repo, ".harness", "artifacts", runA.id);
      mkdirSync(dirname(legacyRunA), { recursive: true });
      symlinkSync(decoyDest, legacyRunA);

      const taskA = cpDb.createTask({
        runId: runA.id,
        tier: 2,
        kind: "worker",
        title: "Task A",
        objective: "Task A",
        profileId: "acp:claude",
      });
      cpDb.updateTask(taskA.id, { status: "completed" });
      const legacyArtPath = join(legacyRunA, taskA.id, "report.md");
      const artA = cpDb.recordArtifact({
        runId: runA.id,
        taskId: taskA.id,
        kind: "dossier",
        summary: "Report A",
        path: legacyArtPath,
      });

      // 2. Valid pre-existing bridge with NO record in migration-state.json (must be adopted on first sight, not removed immediately).
      const adoptedNoteLegacy = join(repo, ".harness", "notes", "adopted.md");
      const adoptedNoteDest = join(projDir, "notes", "adopted.md");
      writeFile(adoptedNoteDest, "adopted note\n");
      mkdirSync(dirname(adoptedNoteLegacy), { recursive: true });
      symlinkSync(adoptedNoteDest, adoptedNoteLegacy);

      // 3. Normal unit whose bridge will be created and recorded by the engine, then tampered with to test mismatch protection.
      const runC = cpDb.createRun({
        goal: "M6 recorded bridge",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m6",
      });
      cpDb.updateRunStatus(runC.id, "completed");
      const legacyRunC = join(repo, ".harness", "artifacts", runC.id);
      writeFile(join(legacyRunC, "t-1", "ok.md"), "run c\n");

      // 4. Tampered pending journal entry pointing at a relocated repo path / wrong destination.
      const bogusLegacy = join(root, "relocated-repo", ".harness", "notes", "stale.md");
      const bogusDest = join(projDir, "notes", "wrong-target.md");
      writeFile(bogusDest, "do not touch\n");
      const statePath = join(projDir, "migration-state.json");
      writeFileSync(
        statePath,
        JSON.stringify(
          {
            version: 1,
            reportedUnknownEntries: [],
            pendingUnits: [
              {
                unitKey: "note:stale.md",
                kind: "note",
                id: "stale.md",
                members: [
                  {
                    kind: "note",
                    id: "stale.md",
                    legacyPath: bogusLegacy,
                    destinationPath: bogusDest,
                  },
                ],
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const t0 = 1_700_000_000_000;
      const pass1 = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        now: () => t0,
      });

      // Stale pending entry was kept as stale with an error record and zero file changes (D6).
      assert.equal(pass1.errors.length, 1);
      assert.match(pass1.errors[0]!.message, /Kept stale pending journal entry note:stale\.md/);
      assert.equal(readFileSync(bogusDest, "utf8"), "do not touch\n");
      assert.equal(existsSync(join(repo, ".harness", "notes", "stale.md")), false);

      // Wrong-target symlink runA was deferred, left alone, and NEVER used for row rewrites.
      const resA = pass1.repos[0]!.results.find((r) => r.unitKey === `run:${runA.id}`);
      assert.equal(resA?.outcome, "deferred");
      assert.equal(lstatSync(legacyRunA).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyRunA), decoyDest);
      const artARow = cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(artA.id) as { path: string };
      assert.equal(artARow.path, legacyArtPath, "Non-bridge symlink must never rewrite artifact rows");

      // Adopted valid bridge was kept and recorded in migration-state.json with createdAt = t0.
      assert.equal(lstatSync(adoptedNoteLegacy).isSymbolicLink(), true);
      assert.equal(pass1.totals.bridgesRemoved, 0);

      // Run C migrated and its bridge was recorded in migration-state.json.
      const destRunC = join(projDir, "chats", "chat-m6", "artifacts", runC.id);
      assert.equal(lstatSync(legacyRunC).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyRunC), destRunC);

      const stateAfterPass1 = JSON.parse(readFileSync(statePath, "utf8")) as {
        pendingUnits: Array<{ unitKey: string; stale?: boolean; staleReason?: string }>;
        bridges: Array<{ legacyPath: string; target: string; createdAt: number }>;
      };
      assert.equal(stateAfterPass1.pendingUnits.length, 1);
      assert.equal(stateAfterPass1.pendingUnits[0]!.unitKey, "note:stale.md");
      assert.equal(stateAfterPass1.pendingUnits[0]!.stale, true);
      const recAdopted = stateAfterPass1.bridges.find((b) => b.legacyPath === adoptedNoteLegacy);
      const recRunC = stateAfterPass1.bridges.find((b) => b.legacyPath === legacyRunC);
      assert.deepEqual(recAdopted, { legacyPath: adoptedNoteLegacy, target: adoptedNoteDest, createdAt: t0 });
      assert.deepEqual(recRunC, { legacyPath: legacyRunC, target: destRunC, createdAt: t0 });

      // Replace run C's symlink with another allowed destination (chats/legacy) whose target differs from the recorded target.
      const altRunC = join(projDir, "chats", "legacy", "artifacts", runC.id);
      writeFile(join(altRunC, "t-1", "alt.md"), "alt\n");
      rmSync(legacyRunC);
      symlinkSync(altRunC, legacyRunC);

      // Advance clock past 7 days from t0:
      // - adoptedNoteLegacy has a matching record at t0 -> removed!
      // - legacyRunA (wrong target) -> still left alone!
      // - legacyRunC (target differs from recorded target) -> left alone and deferred!
      const pass2 = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        now: () => t0 + BRIDGE_MAX_AGE_MS + 1_000,
      });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.bridgesRemoved, 1);
      assert.equal(existsSync(adoptedNoteLegacy), false, "Recorded matching bridge should expire at 7 days");
      assert.equal(lstatSync(legacyRunA).isSymbolicLink(), true, "Non-bridge symlink must never be removed");
      assert.equal(lstatSync(legacyRunC).isSymbolicLink(), true, "Replaced bridge symlink must not be removed");
      assert.equal(readlinkSync(legacyRunC), altRunC);
      const resC2 = pass2.repos[0]!.results.find((r) => r.unitKey === `run:${runC.id}`);
      assert.equal(resC2?.outcome, "deferred");
    } finally {
      cpDb.close();
    }
  });

  it("M7: fails closed on unexpected DB read errors during eligibility and defers shared flat spill files until every indexed owner is eligible", () => {
    const { repo, cpDb, goals, storage } = createEnv("pi-mig-m7-");
    try {
      // Part 1: Executing goal + simulated SQLITE_BUSY error when querying `goals`.
      const liveGoal = goals.createGoal({
        title: "M7 Live Goal",
        description: "Must never be treated as ownerless on DB error",
        repoRoot: repo,
        chatSessionId: "chat-m7",
        criteria: [{ id: "c1", description: "done", kind: "behavioral" }],
      });
      const liveGoalRun = cpDb.createRun({
        goal: "M7 Live Goal",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m7",
      });
      goals.linkRunAndStart(liveGoal.id, liveGoalRun.id);
      const liveGoalEv = join(repo, ".harness", "goals", liveGoal.id, "ev.md");
      writeFile(liveGoalEv, "executing goal evidence\n");

      const originalPrepare = cpDb.db.prepare.bind(cpDb.db);
      const failingSqlite = new Proxy(cpDb.db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("FROM goals")) {
                throw new Error("SQLITE_BUSY: simulated database lock on goals");
              }
              return originalPrepare(sql);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const errPass = runStorageMigrationPass({ sqlite: failingSqlite, storage }, { repoRoots: [repo] });
      const goalRes = errPass.repos[0]!.results.find((r) => r.unitKey === `goal:${liveGoal.id}`);
      assert.equal(goalRes?.outcome, "deferred", "DB error on goals must defer, never treat as ownerless");
      assert.match(goalRes?.reason ?? "", /SQLITE_BUSY/);
      assert.equal(lstatSync(join(repo, ".harness", "goals", liveGoal.id)).isDirectory(), true);
      assert.equal(readFileSync(liveGoalEv, "utf8"), "executing goal evidence\n");

      // Part 2: Flat spill file shared by a TERMINAL goal run and a LIVE non-goal run.
      const doneGoal = goals.createGoal({
        title: "M7 Done Goal",
        description: "Terminal goal sharing a flat spill file",
        repoRoot: repo,
        chatSessionId: "chat-m7",
        criteria: [{ id: "c1", description: "done", kind: "behavioral" }],
      });
      const doneGoalRun = cpDb.createRun({
        goal: "M7 Done Goal",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m7",
      });
      goals.linkRunAndStart(doneGoal.id, doneGoalRun.id);
      const doneTask = cpDb.createTask({
        runId: doneGoalRun.id,
        tier: 2,
        kind: "worker",
        title: "Done task",
        objective: "Done",
        profileId: "acp:claude",
      });
      cpDb.updateTask(doneTask.id, { status: "completed" });
      cpDb.updateRunStatus(doneGoalRun.id, "completed");
      goals.setStatus(doneGoal.id, "achieved");

      const liveOtherRun = cpDb.createRun({
        goal: "M7 Live Non-Goal Run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m7",
      });
      const liveOtherTask = cpDb.createTask({
        runId: liveOtherRun.id,
        tier: 2,
        kind: "worker",
        title: "Running task",
        objective: "Still running",
        profileId: "acp:claude",
      });
      cpDb.updateTask(liveOtherTask.id, { status: "running" });

      const sharedSpillPath = join(repo, ".harness", "artifacts", "shared-spill.md");
      writeFile(sharedSpillPath, "shared between terminal goal and live run\n");
      writeFile(join(repo, ".harness", "goals", doneGoal.id, "done.md"), "done goal ev\n");

      cpDb.recordArtifact({
        runId: doneGoalRun.id,
        taskId: doneTask.id,
        kind: "dossier",
        summary: "Spill from terminal goal run",
        path: sharedSpillPath,
      });
      cpDb.recordArtifact({
        runId: liveOtherRun.id,
        taskId: liveOtherTask.id,
        kind: "dossier",
        summary: "Spill also indexed by live non-goal run",
        path: sharedSpillPath,
      });

      const passShared = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(passShared.errors.length, 0);
      // Terminal goal migrated, but the shared flat spill file stayed real and deferred!
      const spillRes = passShared.repos[0]!.results.find((r) => r.unitKey === "flat_artifact:shared-spill.md");
      assert.equal(spillRes?.outcome, "deferred");
      assert.equal(lstatSync(sharedSpillPath).isFile(), true);
      assert.equal(lstatSync(sharedSpillPath).isSymbolicLink(), false);

      // Once the live non-goal run and its task finish, the shared flat spill file migrates cleanly.
      cpDb.updateTask(liveOtherTask.id, { status: "completed" });
      cpDb.updateRunStatus(liveOtherRun.id, "completed");
      const passSettled = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(passSettled.errors.length, 0);
      assert.equal(lstatSync(sharedSpillPath).isSymbolicLink(), true);
    } finally {
      cpDb.close();
    }
  });

  it("M8: tracks historical run-to-goal links from goal.committed events, defers former runs while the goal is active, and assigns the goal's chat", () => {
    const { repo, cpDb, goals, storage } = createEnv("pi-mig-m8-");
    try {
      const goal = goals.createGoal({
        repoRoot: repo,
        chatSessionId: "chat-m8",
        title: "M8 multi-run goal",
        description: "Goal whose v1 run completed before v2 launched",
        criteria: [{ id: "c1", description: "done", kind: "behavioral" }],
      });

      // Former run v1 (no chat_session_id on runs row) linked via goal.committed event, then completed.
      const run1 = cpDb.createRun({
        goal: "M8 v1 run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
      });
      goals.linkRunAndStart(goal.id, run1.id);
      cpDb.emitEvent(run1.id, null, "goal.committed", { goalId: goal.id, version: 1, title: goal.title });
      cpDb.updateRunStatus(run1.id, "completed");

      // New version launches run2, overwriting goals.linked_run_id while the goal remains executing.
      const run2 = cpDb.createRun({
        goal: "M8 v2 run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-m8",
      });
      goals.linkRunAndStart(goal.id, run2.id);
      cpDb.emitEvent(run2.id, null, "goal.committed", { goalId: goal.id, version: 2, title: goal.title });

      const legacyGoalDir = join(repo, ".harness", "goals", goal.id);
      const legacyRun1Dir = join(repo, ".harness", "artifacts", run1.id);
      const legacyRun2Dir = join(repo, ".harness", "artifacts", run2.id);
      writeFile(join(legacyGoalDir, "ev.md"), "goal evidence\n");
      writeFile(join(legacyRun1Dir, "t-1", "v1.md"), "v1 former run artifact\n");
      writeFile(join(legacyRun2Dir, "t-2", "v2.md"), "v2 active run artifact\n");

      // While goal is executing, completed former run1 MUST stay deferred (never migrated as a standalone run).
      const passActive = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(passActive.errors.length, 0);
      assert.equal(passActive.totals.migrated, 0);
      assert.equal(lstatSync(legacyRun1Dir).isDirectory(), true);
      assert.equal(lstatSync(legacyRun1Dir).isSymbolicLink(), false);
      assert.equal(readFileSync(join(legacyRun1Dir, "t-1", "v1.md"), "utf8"), "v1 former run artifact\n");

      // Once the goal and run2 become terminal, former run1 migrates into the goal's chat (chat-m8), not chats/legacy.
      cpDb.updateRunStatus(run2.id, "completed");
      goals.setStatus(goal.id, "achieved");
      const passDone = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(passDone.errors.length, 0);
      assert.equal(passDone.totals.migrated, 1);

      const projDir = storage.projectDir(repo);
      const expectedRun1Dest = join(projDir, "chats", "chat-m8", "artifacts", run1.id);
      assert.equal(lstatSync(legacyRun1Dir).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyRun1Dir), expectedRun1Dest);
      assert.equal(readFileSync(join(expectedRun1Dest, "t-1", "v1.md"), "utf8"), "v1 former run artifact\n");
    } finally {
      cpDb.close();
    }
  });

  it("M9: excludes paths overlapping registered worktrees or managedWorktreeRoots, reporting them as unknown leftovers", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-m9-", {
      worktree: { dir: ".harness/artifacts/checkouts" },
    });
    try {
      // 1. Custom worktree.dir under .harness/artifacts/checkouts looks like an ownerless run dir.
      const customWtRoot = join(repo, ".harness", "artifacts", "checkouts");
      writeFile(join(customWtRoot, "t-9", "README.md"), "checkout file\n");

      // 2. Registered DB worktree inside a legacy artifacts subdir (without custom worktree.dir covering it).
      const runWithWt = cpDb.createRun({
        goal: "Run containing registered worktree",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
      });
      const taskWithWt = cpDb.createTask({
        runId: runWithWt.id,
        tier: 2,
        kind: "worker",
        title: "Worktree task",
        objective: "do work",
        profileId: "acp:claude",
      });
      const registeredWtPath = join(repo, ".harness", "artifacts", "run-wt-parent", "t-wt");
      writeFile(join(registeredWtPath, "src.ts"), "export const x = 1;\n");
      cpDb.recordWorktree({
        taskId: taskWithWt.id,
        runId: runWithWt.id,
        path: registeredWtPath,
        branch: "harness/run-wt-parent/t-wt",
        baseSha: "abc1234",
      });
      cpDb.updateTask(taskWithWt.id, { status: "completed" });
      cpDb.updateRunStatus(runWithWt.id, "completed");

      // 3. Normal eligible sibling run in the same .harness/artifacts container must still migrate.
      const normalRun = cpDb.createRun({
        goal: "Normal eligible run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
      });
      cpDb.updateRunStatus(normalRun.id, "completed");
      const normalRunDir = join(repo, ".harness", "artifacts", normalRun.id);
      writeFile(join(normalRunDir, "t-1", "out.md"), "normal artifact\n");

      const parentContainingWt = join(repo, ".harness", "artifacts", "run-wt-parent");

      // Plan must exclude both overlapping paths and report them as unknown leftovers.
      const plan = planStorageMigration({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      const planUnits = plan.repos[0]!.units.map((u) => u.unitKey);
      assert.ok(planUnits.includes(`run:${normalRun.id}`));
      assert.ok(!planUnits.includes("run:checkouts"));
      assert.ok(!planUnits.includes("run:run-wt-parent"));
      assert.ok(plan.repos[0]!.unknownEntries.includes(customWtRoot));
      assert.ok(plan.repos[0]!.unknownEntries.includes(parentContainingWt));

      // Pass 1 migrates only the normal run and leaves both worktree-overlapping dirs untouched.
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.totals.migrated, 1);
      assert.equal(lstatSync(normalRunDir).isSymbolicLink(), true);

      assert.equal(lstatSync(customWtRoot).isDirectory(), true);
      assert.equal(lstatSync(customWtRoot).isSymbolicLink(), false);
      assert.equal(readFileSync(join(customWtRoot, "t-9", "README.md"), "utf8"), "checkout file\n");

      assert.equal(lstatSync(parentContainingWt).isDirectory(), true);
      assert.equal(lstatSync(parentContainingWt).isSymbolicLink(), false);
      assert.equal(readFileSync(join(registeredWtPath, "src.ts"), "utf8"), "export const x = 1;\n");

      assert.ok(pass1.unknownEntries.includes(customWtRoot));
      assert.ok(pass1.unknownEntries.includes(parentContainingWt));
      assert.ok(pass1.newUnknownEntries.includes(customWtRoot));
      assert.ok(pass1.newUnknownEntries.includes(parentContainingWt));

      // Pass 2 reports them in unknownEntries but not again in newUnknownEntries.
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass2.errors.length, 0);
      assert.ok(pass2.unknownEntries.includes(customWtRoot));
      assert.ok(pass2.unknownEntries.includes(parentContainingWt));
      assert.equal(pass2.newUnknownEntries.length, 0);
    } finally {
      cpDb.close();
    }
  });

  it("M10: discovers notes-only repos via projects.root_path and chat_sessions.repo_root without explicit repoRoots", () => {
    const { root, cpDb, storage } = createEnv("pi-mig-m10-");
    try {
      const repoFromProjects = join(root, "repo-projects-only");
      const repoFromChats = join(root, "repo-chats-only");
      mkdirSync(repoFromProjects, { recursive: true });
      mkdirSync(repoFromChats, { recursive: true });

      const projectNote = join(repoFromProjects, ".harness", "notes", "director-plan.md");
      const chatNote = join(repoFromChats, ".harness", "notes", "chat-note.md");
      writeFile(projectNote, "project-only director note\n");
      writeFile(chatNote, "chat-only director note\n");

      // Insert directly into projects (created by ControlPlaneDb) and chat_sessions (optional table),
      // with zero runs and zero goals for either repo.
      const now = Date.now();
      cpDb.db
        .prepare(
          "INSERT INTO projects(id, name, root_path, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("proj-1", "Notes Only Project", repoFromProjects, now, now, now);
      cpDb.db.exec(`
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id TEXT PRIMARY KEY,
          repo_root TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'Chat',
          profile_id TEXT NOT NULL DEFAULT 'acp:claude',
          created_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT 0
        );
      `);
      cpDb.db
        .prepare("INSERT INTO chat_sessions(id, repo_root, title, profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("chat-notes-1", repoFromChats, "Notes Chat", "acp:claude", now, now);

      // Run migration with default discovery (no opts.repoRoots, matching daemon start).
      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(report.errors.length, 0);
      assert.equal(report.totals.migrated, 2);

      const expectedProjDest = join(storage.projectDir(repoFromProjects), "notes", "director-plan.md");
      const expectedChatDest = join(storage.projectDir(repoFromChats), "notes", "chat-note.md");
      assert.equal(lstatSync(projectNote).isSymbolicLink(), true);
      assert.equal(readlinkSync(projectNote), expectedProjDest);
      assert.equal(readFileSync(expectedProjDest, "utf8"), "project-only director note\n");

      assert.equal(lstatSync(chatNote).isSymbolicLink(), true);
      assert.equal(readlinkSync(chatNote), expectedChatDest);
      assert.equal(readFileSync(expectedChatDest, "utf8"), "chat-only director note\n");
    } finally {
      cpDb.close();
    }
  });

  it("M11: skips and counts ambiguous relative rows across repos, rewrites unambiguous ones, and preserves literal POSIX names", () => {
    const { root, cpDb, goals, storage } = createEnv("pi-mig-m11-");
    try {
      const repoA = join(root, "repo-a");
      const repoB = join(root, "repo-b");
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });

      // Direct unit assertions on parseLegacyPathForRepo literal POSIX preservation.
      assert.equal(parseLegacyPathForRepo(repoA, " .harness/notes/shared.md", repoA), null);
      assert.equal(parseLegacyPathForRepo(repoA, ".harness\\notes\\shared.md", repoA), null);
      const trailingSpaceParsed = parseLegacyPathForRepo(repoA, ".harness/notes/shared.md ", repoA);
      assert.deepEqual(trailingSpaceParsed?.subParts, ["shared.md "]);
      const backslashLeafParsed = parseLegacyPathForRepo(repoA, ".harness/notes/sub\\leaf.md", repoA);
      assert.deepEqual(backslashLeafParsed?.subParts, ["sub\\leaf.md"]);

      // Both repos have .harness/notes/shared.md and repoA also has a nested note sub/leaf.md (with real slash).
      writeFile(join(repoA, ".harness", "notes", "shared.md"), "repo A shared note\n");
      writeFile(join(repoB, ".harness", "notes", "shared.md"), "repo B shared note\n");
      writeFile(join(repoA, ".harness", "notes", "sub", "leaf.md"), "nested slash note\n");

      const runA = cpDb.createRun({ goal: "Run A", repoRoot: repoA, baseBranch: "main", baseSha: "aaa111" });
      cpDb.updateRunStatus(runA.id, "completed");
      const runB = cpDb.createRun({ goal: "Run B", repoRoot: repoB, baseBranch: "main", baseSha: "bbb222" });
      cpDb.updateRunStatus(runB.id, "completed");

      const goalA = goals.createGoal({
        title: "Terminal goal A",
        description: "Goal A desc",
        repoRoot: repoA,
        criteria: [{ id: "c1", description: "done", kind: "behavioral" }],
      });
      cpDb.db.prepare("UPDATE goals SET status = 'achieved' WHERE id = ?").run(goalA.id);
      writeFile(join(repoA, ".harness", "goals", goalA.id, "plan.md"), "goal A plan\n");
      writeFile(join(repoA, ".harness", "goals", goalA.id, "a\\b.md"), "literal backslash goal file\n");

      const now = Date.now();
      const insertArt = cpDb.db.prepare(
        "INSERT INTO artifacts(id, run_id, task_id, kind, path, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      // 1. Ambiguous relative row whose run gives no repo_root (missing run_id) across two known repos.
      cpDb.db.exec("PRAGMA foreign_keys = OFF");
      insertArt.run("art-ambig", "run-vanished", "t-vanished", "note", ".harness/notes/shared.md", "ambiguous", now);
      // 2. Relative goal row with no run repo_root, but goalA.repo_root pins it unambiguously to repoA.
      insertArt.run(
        "art-goal-pinned",
        "run-vanished",
        "t-vanished",
        "note",
        `.harness/goals/${goalA.id}/plan.md`,
        "pinned by goal",
        now,
      );
      // 3. Relative row with a trailing space belonging to runA: must NOT be trimmed onto shared.md!
      insertArt.run("art-trailing-space", runA.id, "t-a", "note", ".harness/notes/shared.md ", "trailing space", now);
      // 4. Relative row with a literal backslash belonging to runA: must NOT match nested note sub/leaf.md!
      insertArt.run("art-backslash-note", runA.id, "t-a", "note", ".harness/notes/sub\\leaf.md", "literal backslash", now);
      // 5. Relative row with a literal backslash inside goalA: must rewrite keeping the literal backslash!
      insertArt.run(
        "art-backslash-goal",
        runA.id,
        "t-a",
        "note",
        `.harness/goals/${goalA.id}/a\\b.md`,
        "literal backslash goal",
        now,
      );
      cpDb.db.exec("PRAGMA foreign_keys = ON");

      const plan = planStorageMigration({ sqlite: cpDb.db, storage });
      assert.equal(plan.totals.ambiguousRowsSkipped, 1);

      const report = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(report.errors.length, 0);
      assert.equal(report.totals.ambiguousRowsSkipped, 1);

      const getPath = (id: string) =>
        (cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(id) as { path: string }).path;

      // Ambiguous row was skipped and untouched.
      assert.equal(getPath("art-ambig"), ".harness/notes/shared.md");
      // Trailing-space row was NOT trimmed and NOT redirected to shared.md.
      assert.equal(getPath("art-trailing-space"), ".harness/notes/shared.md ");
      // Literal-backslash note row was NOT rewritten as if "\\" were "/" matching sub/leaf.md.
      assert.equal(getPath("art-backslash-note"), ".harness/notes/sub\\leaf.md");
      // Goal-pinned relative row and literal-backslash goal file row WERE rewritten to their exact destinations.
      assert.equal(
        getPath("art-goal-pinned"),
        join(storage.projectDir(repoA), "chats", "legacy", "goals", goalA.id, "plan.md"),
      );
      assert.equal(
        getPath("art-backslash-goal"),
        join(storage.projectDir(repoA), "chats", "legacy", "goals", goalA.id, "a\\b.md"),
      );

      // Single-repo check: when no other repo exists, a relative row with no run repo_root IS rewritten.
      const solo = createEnv("pi-mig-m11-solo-");
      try {
        writeFile(join(solo.repo, ".harness", "notes", "solo.md"), "only repo note\n");
        solo.cpDb.db.exec("PRAGMA foreign_keys = OFF");
        solo.cpDb.db
          .prepare(
            "INSERT INTO artifacts(id, run_id, task_id, kind, path, summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run("art-solo", "run-vanished", "t-vanished", "note", ".harness/notes/solo.md", "solo", now);
        solo.cpDb.db.exec("PRAGMA foreign_keys = ON");

        const soloReport = runStorageMigrationPass({ sqlite: solo.cpDb.db, storage: solo.storage }, { repoRoots: [solo.repo] });
        assert.equal(soloReport.errors.length, 0);
        assert.equal(soloReport.totals.ambiguousRowsSkipped, 0);
        assert.equal(soloReport.totals.rowsRewritten, 1);
        const soloPath = (
          solo.cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get("art-solo") as { path: string }
        ).path;
        assert.equal(soloPath, join(solo.storage.projectDir(solo.repo), "notes", "solo.md"));
      } finally {
        solo.cpDb.close();
      }
    } finally {
      cpDb.close();
    }
  });
});
