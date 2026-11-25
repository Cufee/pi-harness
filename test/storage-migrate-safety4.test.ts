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
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { BRIDGE_MAX_AGE_MS, planStorageMigration, runStorageMigrationPass } from "../src/storage/migrate.js";
import { LEGACY_HARNESS_DIR } from "../src/storage/migrate/fs.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeFile(absPath: string, content: string | Buffer): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

function createEnv(prefix: string, opts?: { inMemoryDb?: boolean }) {
  const root = makeTempDir(prefix);
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const cpDb = new ControlPlaneDb(opts?.inMemoryDb ? ":memory:" : join(stateDir, "control-plane.sqlite"));
  const storage = storagePaths({ stateDir }, { layout: "data-dir" });
  return { root, stateDir, repo, cpDb, storage };
}

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storage migration safety round-4 regressions (G1-G5)", () => {
  it("G1: same-inode pair skips hashing within budget; different-inode pair stops at deadline with both names in place", () => {
    // Part 1: Same-inode recovery of a large sparse file (kill between hard-link placement and bridge)
    // skips hashing and finishes well inside the budget with the bridge created.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-g1-same-inode-");
      try {
        const legacyNote = join(repo, LEGACY_HARNESS_DIR, "notes", "huge-same-inode.bin");
        writeFile(legacyNote, "");
        truncateSync(legacyNote, 2 * 1024 * 1024 * 1024); // 2 GiB sparse file
        const originalIno = lstatSync(legacyNote, { bigint: true }).ino;

        // Simulate crash right after hard-link placement and before bridge swap.
        const pass1 = runStorageMigrationPass(
          {
            sqlite: cpDb.db,
            storage,
            fault: (point) => {
              if (point === "after_rename_into_place") {
                throw new Error("simulated kill between hard-link and bridge");
              }
            },
          },
          { repoRoots: [repo] },
        );
        assert.equal(pass1.errors.length, 1);

        const destNote = join(storage.projectDir(repo), "notes", "huge-same-inode.bin");
        const legStat = lstatSync(legacyNote, { bigint: true });
        const dstStat = lstatSync(destNote, { bigint: true });
        assert.equal(legStat.isFile(), true);
        assert.equal(dstStat.isFile(), true);
        assert.equal(legStat.dev, dstStat.dev);
        assert.equal(legStat.ino, dstStat.ino);
        assert.equal(legStat.ino, originalIno);

        const budgetMs = 500;
        const t0 = Date.now();
        const pass2 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage },
          { repoRoots: [repo], budgetMs },
        );
        const elapsed = Date.now() - t0;

        assert.equal(pass2.errors.length, 0, `Unexpected errors: ${JSON.stringify(pass2.errors)}`);
        assert.equal(pass2.budgetExceeded, false, `Same-inode recovery should not exceed budget (elapsed=${elapsed}ms)`);
        assert.ok(elapsed < budgetMs, `Expected same-inode recovery well inside ${budgetMs}ms, took ${elapsed}ms`);
        assert.equal(lstatSync(legacyNote).isSymbolicLink(), true, "Bridge symlink must be created");
        assert.equal(lstatSync(destNote, { bigint: true }).ino, originalIno, "Destination inode must be preserved");
      } finally {
        cpDb.close();
      }
    }

    // Part 2: Different-inode pair hashes with deadline checks and stops at the budget
    // leaving both names in place and the unit pending.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-g1-diff-inode-");
      try {
        const legacyNote = join(repo, LEGACY_HARNESS_DIR, "notes", "huge-diff-inode.bin");
        const projectDir = storage.ensureProjectDir(repo);
        const destNote = join(projectDir, "notes", "huge-diff-inode.bin");
        writeFile(legacyNote, "");
        truncateSync(legacyNote, 2 * 1024 * 1024 * 1024); // 2 GiB sparse file
        writeFile(destNote, "");
        truncateSync(destNote, 2 * 1024 * 1024 * 1024); // Separate inode 2 GiB sparse file

        const legStatBefore = lstatSync(legacyNote, { bigint: true });
        const dstStatBefore = lstatSync(destNote, { bigint: true });
        assert.notEqual(legStatBefore.ino, dstStatBefore.ino, "Fixture requires distinct inodes");

        const budgetMs = 50;
        const t0 = Date.now();
        const pass = runStorageMigrationPass(
          { sqlite: cpDb.db, storage },
          { repoRoots: [repo], budgetMs },
        );
        const elapsed = Date.now() - t0;

        assert.equal(pass.errors.length, 0, `Unexpected errors: ${JSON.stringify(pass.errors)}`);
        assert.equal(pass.budgetExceeded, true, `Different-inode large merge must stop at deadline (elapsed=${elapsed}ms)`);
        assert.ok(elapsed < 2_000, `Expected deadline stop promptly after ${budgetMs}ms, took ${elapsed}ms`);
        assert.equal(lstatSync(legacyNote).isFile(), true, "Legacy file must remain a real file after deadline stop");
        assert.equal(lstatSync(legacyNote).isSymbolicLink(), false);
        assert.equal(lstatSync(destNote).isFile(), true, "Destination file must remain a real file after deadline stop");
        assert.equal(existsSync(join(projectDir, "migration-state.json")), true);
        const state = JSON.parse(readFileSync(join(projectDir, "migration-state.json"), "utf8")) as {
          pendingUnits: Array<{ unitKey: string; stale?: boolean }>;
        };
        assert.ok(
          state.pendingUnits.some((u) => u.stale !== true && u.unitKey === "note:huge-diff-inode.bin"),
          "Unit must remain pending after deadline stop during different-inode merge hashing",
        );
      } finally {
        cpDb.close();
      }
    }
  });

  it("G2: 255-byte and 220-byte note basenames migrate in one pass, conflict preservation stays within NAME_MAX, and leftover temp bridge symlink is cleaned", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-g2-long-names-");
    try {
      const name255 = `${"a".repeat(252)}.md`;
      const name220 = `${"b".repeat(217)}.md`;
      assert.equal(Buffer.byteLength(name255, "utf8"), 255);
      assert.equal(Buffer.byteLength(name220, "utf8"), 220);

      const legacy255 = join(repo, LEGACY_HARNESS_DIR, "notes", name255);
      const legacy220 = join(repo, LEGACY_HARNESS_DIR, "notes", name220);
      writeFile(legacy255, "note-255-v1\n");
      writeFile(legacy220, "note-220-v1\n");

      // Seed a leftover prepared bridge temp symlink (from a simulated killed pass) and a regular file
      // with the same pattern (which must NOT be deleted because it is not a symlink).
      const leftoverTempLink = join(repo, LEGACY_HARNESS_DIR, "notes", ".pi-harness-bridge-0123456789abcdef0123456789abcdef.tmp");
      const regularSamePattern = join(repo, LEGACY_HARNESS_DIR, "notes", ".pi-harness-bridge-fedcba9876543210fedcba9876543210.tmp");
      const projectDir = storage.projectDir(repo);
      const dest255 = join(projectDir, "notes", name255);
      const dest220 = join(projectDir, "notes", name220);
      symlinkSync(dest255, leftoverTempLink);
      writeFile(regularSamePattern, "real-regular-file\n");

      // Dry-run must not delete the leftover temp symlink and must not report it as an error unit.
      const plan = planStorageMigration({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(plan.repos[0]!.errors.length, 0);
      assert.equal(lstatSync(leftoverTempLink).isSymbolicLink(), true, "Dry-run must not delete leftover temp symlink");

      // Pass 1: migrates both 255-byte and 220-byte notes in one pass AND cleans the leftover temp symlink.
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass1.errors.length, 0, `Unexpected errors: ${JSON.stringify(pass1.errors)}`);
      assert.equal(lstatSync(legacy255).isSymbolicLink(), true, "255-byte note must be bridged in one pass");
      assert.equal(lstatSync(legacy220).isSymbolicLink(), true, "220-byte note must be bridged in one pass");
      assert.equal(readFileSync(dest255, "utf8"), "note-255-v1\n");
      assert.equal(readFileSync(dest220, "utf8"), "note-220-v1\n");
      assert.equal(existsSync(leftoverTempLink), false, "Leftover bridge temp symlink must be cleaned on next pass");
      // The regular file with the same pattern was migrated as a regular note, not deleted.
      assert.equal(
        readFileSync(join(projectDir, "notes", basename(regularSamePattern)), "utf8"),
        "real-regular-file\n",
      );

      // Recreate the 255-byte legacy note with different content to exercise merge temp + preserved-conflict suffix.
      rmSync(legacy255);
      writeFile(legacy255, "note-255-v2-winner\n");
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass2.errors.length, 0, `Conflict merge on 255-byte note failed: ${JSON.stringify(pass2.errors)}`);
      assert.equal(lstatSync(legacy255).isSymbolicLink(), true);
      assert.equal(readFileSync(dest255, "utf8"), "note-255-v2-winner\n");
      const preserved = readdirSync(join(projectDir, "notes")).filter((n) => n.includes(".pre-merge-"));
      assert.equal(preserved.length, 1, `Expected one preserved conflict file, found: ${preserved.join(",")}`);
      assert.ok(Buffer.byteLength(preserved[0]!, "utf8") <= 255);
      assert.equal(readFileSync(join(projectDir, "notes", preserved[0]!), "utf8"), "note-255-v1\n");
    } finally {
      cpDb.close();
    }
  });

  it("G3: recreated bridge killed at after_bridge before state flush keeps fresh lstat mtime age and is not expired 101ms later", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-g3-bridge-age-");
    try {
      const legacyNote = join(repo, LEGACY_HARNESS_DIR, "notes", "recreated-kill.md");
      const projectDir = storage.projectDir(repo);
      const statePath = join(projectDir, "migration-state.json");
      writeFile(legacyNote, "v1\n");

      // Pass 1 records an old bridge almost 7 days old relative to current wall-clock time.
      const tRecreateBase = Date.now();
      const t0 = tRecreateBase - (BRIDGE_MAX_AGE_MS - 100);
      const pass1 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => t0 },
        { repoRoots: [repo] },
      );
      assert.equal(pass1.errors.length, 0);
      assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);

      // Recreate legacy file just before old 7-day expiry.
      rmSync(legacyNote);
      writeFile(legacyNote, "v2-recreated\n");

      // Pass 2 recreates the bridge and is killed at after_bridge before the state flush writes the new createdAt.
      let stateBytesAtKill: Buffer | null = null;
      const pass2 = runStorageMigrationPass(
        {
          sqlite: cpDb.db,
          storage,
          now: () => tRecreateBase,
          fault: (point) => {
            if (point === "after_bridge") {
              stateBytesAtKill = readFileSync(statePath);
              throw new Error("simulated SIGKILL at after_bridge");
            }
          },
        },
        { repoRoots: [repo] },
      );
      assert.equal(pass2.errors.length, 1);
      const snapshot = stateBytesAtKill as Buffer | null;
      assert.ok(snapshot !== null, "Expected after_bridge fault to fire");
      // Verify state on disk at after_bridge still holds the old createdAt (pre-flush), and keep that exact crash state.
      const crashState = JSON.parse(snapshot.toString("utf8")) as {
        bridges: Array<{ legacyPath: string; createdAt: number }>;
      };
      const crashRec = crashState.bridges.find((b) => b.legacyPath === legacyNote);
      assert.equal(crashRec?.createdAt, t0, "State file on disk at after_bridge must still hold the old createdAt");
      writeFileSync(statePath, snapshot);

      assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);
      const recreatedMtimeMs = lstatSync(legacyNote).mtimeMs;

      // Pass 3 runs 101ms after recreation (past t0 + 7d, but only ~101ms after the fresh bridge link mtime).
      const pass3 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => Math.max(tRecreateBase, recreatedMtimeMs) + 101 },
        { repoRoots: [repo] },
      );
      assert.equal(pass3.errors.length, 0);
      assert.equal(pass3.totals.bridgesRemoved, 0, "Recreated bridge must not expire 101ms after kill before state flush");
      assert.equal(lstatSync(legacyNote).isSymbolicLink(), true, "Bridge symlink must remain in place");

      // Full 7 days after the recreated symlink's lstat mtime: now expires cleanly.
      const pass4 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => Math.max(tRecreateBase, recreatedMtimeMs) + BRIDGE_MAX_AGE_MS },
        { repoRoots: [repo] },
      );
      assert.equal(pass4.errors.length, 0);
      assert.equal(pass4.totals.bridgesRemoved, 1);
      assert.equal(existsSync(legacyNote), false);
    } finally {
      cpDb.close();
    }
  });

  it("G4: ambiguous relative flat row on a bucket run (director-tasks-*) defers both repos' spills while bucket run is non-terminal or has any live task", () => {
    const root = makeTempDir("pi-mig-g4-bucket-f6-");
    const stateDir = join(root, "state");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    const storage = storagePaths({ stateDir }, { layout: "data-dir" });
    try {
      // Register both repos as known repos via settled runs.
      const rA = cpDb.createRun({ goal: "A", repoRoot: repoA, baseBranch: "main", baseSha: "aaa", chatSessionId: "chat-a" });
      const rB = cpDb.createRun({ goal: "B", repoRoot: repoB, baseBranch: "main", baseSha: "bbb", chatSessionId: "chat-b" });
      cpDb.updateRunStatus(rA.id, "completed");
      cpDb.updateRunStatus(rB.id, "completed");

      // Active bucket run director-tasks-chat-1 with empty repo_root (older incomplete ownership) and a completed task.
      const bucketId = "director-tasks-chat-1";
      const now = Date.now();
      cpDb.db
        .prepare(
          `INSERT INTO runs (id, goal, repo_root, base_branch, base_sha, status, chat_session_id, created_at, updated_at)
           VALUES (?, 'Director bucket', '', 'main', 'ccc', 'active', 'chat-1', ?, ?)`,
        )
        .run(bucketId, now, now);
      const doneTask = cpDb.createTask({
        runId: bucketId,
        tier: 2,
        kind: "worker",
        title: "Completed bucket task",
        objective: "O",
        profileId: "acp:claude",
      });
      cpDb.updateTask(doneTask.id, { status: "completed" });

      const relSpillPath = `${LEGACY_HARNESS_DIR}/artifacts/bucket-shared-spill.md`;
      const spillA = join(repoA, LEGACY_HARNESS_DIR, "artifacts", "bucket-shared-spill.md");
      const spillB = join(repoB, LEGACY_HARNESS_DIR, "artifacts", "bucket-shared-spill.md");
      writeFile(spillA, "bucket-spill-in-repo-a\n");
      writeFile(spillB, "bucket-spill-in-repo-b\n");

      const ambigArt = cpDb.recordArtifact({
        runId: bucketId,
        taskId: doneTask.id,
        kind: "dossier",
        path: relSpillPath,
        summary: "ambiguous relative bucket summary",
      });

      // Subcase 1: bucket run is active (non-terminal) with only a completed task -> must defer both repos' spills.
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.totals.migrated, 0, "Must not migrate spills while ambiguous bucket run is active");
      const deferred1 = pass1.repos.flatMap((r) =>
        r.deferred.filter((u) => u.unitKey === "flat_artifact:bucket-shared-spill.md"),
      );
      assert.equal(deferred1.length, 2, "Both repos' spills must be deferred while bucket run is active");
      assert.equal(lstatSync(spillA).isFile(), true);
      assert.equal(lstatSync(spillA).isSymbolicLink(), false);
      assert.equal(lstatSync(spillB).isFile(), true);
      assert.equal(lstatSync(spillB).isSymbolicLink(), false);
      assert.equal(
        (cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(ambigArt.id) as { path: string }).path,
        relSpillPath,
      );

      // Subcase 2: bucket run is terminal, but another task in the bucket is live -> must still defer both spills.
      cpDb.updateRunStatus(bucketId, "completed");
      const liveTask = cpDb.createTask({
        runId: bucketId,
        tier: 2,
        kind: "worker",
        title: "Live sibling bucket task",
        objective: "O2",
        profileId: "acp:claude",
      });
      cpDb.updateTask(liveTask.id, { status: "running" });

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.migrated, 0, "Must not migrate spills while ambiguous bucket run has a live task");
      const deferred2 = pass2.repos.flatMap((r) =>
        r.deferred.filter((u) => u.unitKey === "flat_artifact:bucket-shared-spill.md"),
      );
      assert.equal(deferred2.length, 2, "Both repos' spills must be deferred while any bucket task is live");
    } finally {
      cpDb.close();
    }
  });

  it("G5: bridge record persists legacy unit kind so an extensionless flat file whose target becomes a directory is not classified as a run and is not expired", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-g5-persisted-kind-");
    try {
      const legacySpill = join(repo, LEGACY_HARNESS_DIR, "artifacts", "spill");
      writeFile(legacySpill, "extensionless-flat-spill\n");

      const t0 = Date.now() + 1_000;
      const pass1 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => t0 },
        { repoRoots: [repo] },
      );
      assert.equal(pass1.errors.length, 0);
      assert.equal(lstatSync(legacySpill).isSymbolicLink(), true);

      const projectDir = storage.projectDir(repo);
      const destSpill = join(projectDir, "chats", "legacy", "artifacts", "spill");
      const statePath = join(projectDir, "migration-state.json");
      const stateAfterPass1 = JSON.parse(readFileSync(statePath, "utf8")) as {
        pendingUnits: unknown[];
        bridges: Array<{ legacyPath: string; target: string; createdAt: number; kind?: string }>;
      };
      assert.equal(stateAfterPass1.pendingUnits.length, 0);
      const bridgeRec = stateAfterPass1.bridges.find((b) => b.legacyPath === legacySpill);
      assert.equal(bridgeRec?.kind, "flat_artifact", "Bridge record must persist legacy unit kind");

      // Replace the flat-file target with a directory (no DB row and no pending entry exist).
      rmSync(destSpill);
      mkdirSync(destSpill, { recursive: true });

      const after7d = t0 + BRIDGE_MAX_AGE_MS + 10_000;
      const plan = planStorageMigration(
        { sqlite: cpDb.db, storage, now: () => after7d },
        { repoRoots: [repo] },
      );
      const plannedSpill = plan.repos[0]!.units.find((u) => u.legacyPath === legacySpill);
      assert.equal(plannedSpill?.kind, "flat_artifact", "Extensionless flat bridge must stay classified as flat_artifact, not run");
      assert.equal(plannedSpill?.action, "defer", "Wrong-type bridge must be deferred");

      const pass2 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => after7d },
        { repoRoots: [repo] },
      );
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.bridgesRemoved, 0, "Wrong-type extensionless flat bridge must never expire");
      assert.equal(pass2.totals.rowsRewritten, 0);
      assert.equal(lstatSync(legacySpill).isSymbolicLink(), true);

      // Legacy bridge record without `kind` (from an earlier pass): target type mismatching inferred kind is also a wrong-type bridge.
      const legacyNoKind = join(repo, LEGACY_HARNESS_DIR, "artifacts", "earlier-pass-spill");
      const destNoKind = join(projectDir, "chats", "legacy", "artifacts", "earlier-pass-spill");
      writeFile(destNoKind, "file-target\n");
      symlinkSync(destNoKind, legacyNoKind);
      const state2 = JSON.parse(readFileSync(statePath, "utf8")) as {
        version: 1;
        reportedUnknownEntries: string[];
        pendingUnits: unknown[];
        bridges: Array<{ legacyPath: string; target: string; createdAt: number; kind?: string }>;
      };
      state2.bridges.push({ legacyPath: legacyNoKind, target: destNoKind, createdAt: t0 });
      writeFileSync(statePath, JSON.stringify(state2, null, 2), "utf8");

      const pass3 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => after7d },
        { repoRoots: [repo] },
      );
      assert.equal(pass3.errors.length, 0);
      assert.equal(pass3.totals.bridgesRemoved, 0, "Earlier-pass record without kind whose target mismatches inferred kind must not expire");
      assert.equal(lstatSync(legacyNoKind).isSymbolicLink(), true);
    } finally {
      cpDb.close();
    }
  });
});
