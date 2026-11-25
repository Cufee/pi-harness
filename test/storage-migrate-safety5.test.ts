import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { runStorageMigrationPass } from "../src/storage/migrate.js";
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

function createEnv(prefix: string) {
  const root = makeTempDir(prefix);
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
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

describe("storage migration safety round-5 regressions (G7-G8)", () => {
  it("G7: temp-link cleanup preserves recorded and pending-journal bridges matching the temp pattern while still cleaning unrecorded leftover temp symlinks", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-g7-temp-link-");
    try {
      const projectDir = storage.projectDir(repo);
      const statePath = join(projectDir, "migration-state.json");

      // Part 1 (Astra A5 sequence): regular note matching BRIDGE_TEMP_NAME_RE migrates on pass 1
      // into a recorded bridge; pass 2 must keep that bridge while cleaning a real leftover temp link.
      const noteName = ".pi-harness-bridge-fedcba9876543210fedcba9876543210.tmp";
      const legacyNote = join(repo, LEGACY_HARNESS_DIR, "notes", noteName);
      const destNote = join(projectDir, "notes", noteName);
      writeFile(legacyNote, "real-note-content\n");

      const leftover1 = join(
        repo,
        LEGACY_HARNESS_DIR,
        "notes",
        ".pi-harness-bridge-0123456789abcdef0123456789abcdef.tmp",
      );
      symlinkSync(join(projectDir, "notes", "unrecorded-target.md"), leftover1);

      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass1.errors.length, 0, `Pass 1 errors: ${JSON.stringify(pass1.errors)}`);
      assert.equal(existsSync(leftover1), false, "Real leftover temp symlink must be cleaned on pass 1");
      assert.equal(lstatSync(legacyNote).isSymbolicLink(), true, "Pass 1 must create recorded bridge for regular note");
      assert.equal(readlinkSync(legacyNote), destNote);
      assert.equal(readFileSync(destNote, "utf8"), "real-note-content\n");

      // Plant a second real leftover temp link before pass 2.
      const leftover2 = join(
        repo,
        LEGACY_HARNESS_DIR,
        "notes",
        ".pi-harness-bridge-11112222333344445555666677778888.tmp",
      );
      symlinkSync(join(projectDir, "notes", "another-unrecorded-target.md"), leftover2);

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass2.errors.length, 0, `Pass 2 errors: ${JSON.stringify(pass2.errors)}`);
      assert.equal(existsSync(leftover2), false, "Real leftover temp symlink must be cleaned on pass 2");
      assert.equal(
        lstatSync(legacyNote).isSymbolicLink(),
        true,
        "Recorded bridge matching internal temp pattern must NOT be removed on pass 2",
      );
      assert.equal(readlinkSync(legacyNote), destNote);
      assert.equal(readFileSync(destNote, "utf8"), "real-note-content\n");

      // Part 2: bridge created before crash at after_bridge (present only in pendingUnits, not yet in state.bridges)
      // must also be kept by cleanup and adopted on the next pass.
      const pendingNoteName = ".pi-harness-bridge-abcdef0123456789abcdef0123456789.tmp";
      const legacyPendingNote = join(repo, LEGACY_HARNESS_DIR, "notes", pendingNoteName);
      const destPendingNote = join(projectDir, "notes", pendingNoteName);
      writeFile(legacyPendingNote, "pending-journal-note\n");

      let crashStateSnapshot: Buffer | null = null;
      const pass3Crash = runStorageMigrationPass(
        {
          sqlite: cpDb.db,
          storage,
          fault: (point, ctx) => {
            if (point === "after_bridge" && ctx.memberLegacyPath === legacyPendingNote) {
              crashStateSnapshot = readFileSync(statePath);
              throw new Error("simulated crash at after_bridge before state flush");
            }
          },
        },
        { repoRoots: [repo] },
      );
      assert.equal(pass3Crash.errors.length, 1);
      assert.ok(crashStateSnapshot !== null, "Expected after_bridge fault to capture pre-flush state");
      writeFileSync(statePath, crashStateSnapshot);

      const crashState = JSON.parse((crashStateSnapshot as Buffer).toString("utf8")) as {
        bridges?: Array<{ legacyPath: string }>;
        pendingUnits: Array<{ members: Array<{ legacyPath: string }> }>;
      };
      assert.equal(
        (crashState.bridges ?? []).some((b) => b.legacyPath === legacyPendingNote),
        false,
        "Pre-flush crash state must not yet record the bridge in state.bridges",
      );
      assert.equal(
        crashState.pendingUnits.some((u) => u.members.some((m) => m.legacyPath === legacyPendingNote)),
        true,
        "Pre-flush crash state must name the bridge in pendingUnits",
      );

      const pass4Recover = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass4Recover.errors.length, 0, `Pass 4 errors: ${JSON.stringify(pass4Recover.errors)}`);
      assert.equal(
        lstatSync(legacyPendingNote).isSymbolicLink(),
        true,
        "Pending-journal bridge matching internal temp pattern must NOT be removed on recovery pass",
      );
      assert.equal(readlinkSync(legacyPendingNote), destPendingNote);
      assert.equal(readFileSync(destPendingNote, "utf8"), "pending-journal-note\n");
    } finally {
      cpDb.close();
    }
  });

  it("G8: 255-byte self-truncating conflict name preserves both versions under different names, and two long names sharing a stem get distinct preserved paths", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-g8-preserved-conflict-");
    try {
      const projectDir = storage.projectDir(repo);

      // Part 1 (Astra A5 sequence): 255-byte basename ending in `.pre-merge-<8hex of v1>`.
      const v1Content = "original-255-byte-note-v1\n";
      const v2Content = "replacement-255-byte-note-v2\n";
      const v1Hex8 = createHash("sha256").update(v1Content).digest("hex").slice(0, 8);
      const selfTruncName = `${"a".repeat(236)}.pre-merge-${v1Hex8}`;
      assert.equal(Buffer.byteLength(selfTruncName, "utf8"), 255);

      const legacySelf = join(repo, LEGACY_HARNESS_DIR, "notes", selfTruncName);
      const destSelf = join(projectDir, "notes", selfTruncName);
      writeFile(legacySelf, v1Content);

      // Interrupt pass 1 right after hard-link placement so destSelf has v1 while legacySelf remains.
      const pass1Crash = runStorageMigrationPass(
        {
          sqlite: cpDb.db,
          storage,
          fault: (point) => {
            if (point === "after_rename_into_place") {
              throw new Error("simulated crash after hard-link placement");
            }
          },
        },
        { repoRoots: [repo] },
      );
      assert.equal(pass1Crash.errors.length, 1);
      assert.equal(readFileSync(destSelf, "utf8"), v1Content);

      // Simulate atomic save of legacy note on fallback (different inode, new bytes; destSelf still has v1).
      rmSync(legacySelf);
      writeFile(legacySelf, v2Content);

      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass2.errors.length, 0, `Pass 2 errors: ${JSON.stringify(pass2.errors)}`);
      assert.equal(lstatSync(legacySelf).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacySelf), destSelf);
      assert.equal(readFileSync(destSelf, "utf8"), v2Content);

      const selfResult = pass2.repos[0]!.results.find((r) => r.destinationPath === destSelf);
      assert.ok(selfResult, "Expected migration result for 255-byte self-truncating note");
      assert.equal(selfResult.shadowedFiles.length, 1);
      const selfShadow = selfResult.shadowedFiles[0]!;
      assert.equal(selfShadow.canonicalPath, destSelf);
      assert.notEqual(
        selfShadow.preservedPath,
        destSelf,
        "Preserved-conflict path must never equal the canonical destination path",
      );
      assert.ok(Buffer.byteLength(basename(selfShadow.preservedPath), "utf8") <= 255);
      assert.equal(readFileSync(selfShadow.preservedPath, "utf8"), v1Content);

      // Part 2: two distinct 255-byte names sharing the same truncated stem and identical old bytes
      // must each receive a distinct preserved-conflict path without overwriting or reusing each other's path.
      const sharedOld = "shared-stem-old-version\n";
      const nameA = `${"s".repeat(233)}${"1".repeat(19)}.md`;
      const nameB = `${"s".repeat(233)}${"2".repeat(19)}.md`;
      assert.equal(Buffer.byteLength(nameA, "utf8"), 255);
      assert.equal(Buffer.byteLength(nameB, "utf8"), 255);
      assert.notEqual(nameA, nameB);

      const legacyA = join(repo, LEGACY_HARNESS_DIR, "notes", nameA);
      const legacyB = join(repo, LEGACY_HARNESS_DIR, "notes", nameB);
      const destA = join(projectDir, "notes", nameA);
      const destB = join(projectDir, "notes", nameB);
      writeFile(legacyA, sharedOld);
      writeFile(legacyB, sharedOld);

      const pass3 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass3.errors.length, 0, `Pass 3 errors: ${JSON.stringify(pass3.errors)}`);

      rmSync(legacyA);
      rmSync(legacyB);
      writeFile(legacyA, "new-version-for-A\n");
      writeFile(legacyB, "new-version-for-B\n");

      const pass4 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass4.errors.length, 0, `Pass 4 errors: ${JSON.stringify(pass4.errors)}`);
      assert.equal(readFileSync(destA, "utf8"), "new-version-for-A\n");
      assert.equal(readFileSync(destB, "utf8"), "new-version-for-B\n");

      const resA = pass4.repos[0]!.results.find((r) => r.destinationPath === destA);
      const resB = pass4.repos[0]!.results.find((r) => r.destinationPath === destB);
      assert.ok(resA && resA.shadowedFiles.length === 1, "Expected preserved-conflict record for nameA");
      assert.ok(resB && resB.shadowedFiles.length === 1, "Expected preserved-conflict record for nameB");

      const preservedA = resA.shadowedFiles[0]!.preservedPath;
      const preservedB = resB.shadowedFiles[0]!.preservedPath;
      assert.notEqual(preservedA, destA);
      assert.notEqual(preservedB, destB);
      assert.notEqual(
        preservedA,
        preservedB,
        "Two distinct 255-byte notes sharing a stem must receive different preserved-conflict paths",
      );
      assert.ok(Buffer.byteLength(basename(preservedA), "utf8") <= 255);
      assert.ok(Buffer.byteLength(basename(preservedB), "utf8") <= 255);
      assert.equal(readFileSync(preservedA, "utf8"), sharedOld);
      assert.equal(readFileSync(preservedB, "utf8"), sharedOld);
    } finally {
      cpDb.close();
    }
  });
});
