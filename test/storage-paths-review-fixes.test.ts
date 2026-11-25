import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import {
  listUnitFiles,
  resetStoragePathsForTest,
  resolveUnitFile,
  storagePaths,
  unitDataDirDestination,
} from "../src/storage/paths.js";
import {
  archiveRef,
  archiveRefPatterns,
  mergedRef,
  mergedRefCandidates,
  taskBranchName,
} from "../src/storage/names.js";

const ORIGINAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (ORIGINAL_LAYOUT_ENV === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = ORIGINAL_LAYOUT_ENV;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storage path module review fixes (P1-P7)", () => {
  it("P7: preserves literal POSIX filenames (backslashes, trailing spaces) and rejects only empty, '.', '..', '/' and NUL segments", () => {
    const root = makeTempDir("pi-fp-p7-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const notesDir = sp.projectNotesDir(repo);
    mkdirSync(notesDir, { recursive: true });

    // 1. Literal backslash in filename is a single POSIX filename, NOT a directory separator.
    const backslashName = "foo\\bar.md";
    const backslashFile = join(notesDir, backslashName);
    writeFileSync(backslashFile, "literal-backslash", "utf8");
    // Also create a decoy nested file foo/bar.md that backslash rewriting would erroneously match.
    mkdirSync(join(notesDir, "foo"), { recursive: true });
    writeFileSync(join(notesDir, "foo", "bar.md"), "decoy-nested", "utf8");

    const hitBackslash = resolveUnitFile(sp, { kind: "note", repoRoot: repo, id: backslashName });
    assert.deepEqual(hitBackslash, {
      path: backslashFile,
      source: "data-dir",
      unitDir: notesDir,
    });
    assert.equal(
      unitDataDirDestination(sp, { kind: "note", repoRoot: repo, id: backslashName }),
      backslashFile,
    );

    // 2. Trailing-space filename must not be redirected to its trimmed neighbour.
    const trimmedFile = join(notesDir, "note.md");
    const trailingFile = join(notesDir, "note.md ");
    writeFileSync(trimmedFile, "trimmed", "utf8");
    writeFileSync(trailingFile, "trailing-space", "utf8");

    assert.equal(
      resolveUnitFile(sp, { kind: "note", repoRoot: repo, id: "note.md " })?.path,
      trailingFile,
    );
    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/notes/note.md "),
      trailingFile,
    );
    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/notes/note.md"),
      trimmedFile,
    );
    assert.equal(
      listUnitFiles(sp, { kind: "note", repoRoot: repo, id: backslashName })[0]?.path,
      backslashFile,
    );

    // 3. Reject empty segments, '.', '..', leading/trailing '/', and NUL; reject '/' in single-segment flat_artifact.
    for (const bad of ["", "/", "/a.md", "a/", "a//b.md", ".", "./a.md", "a/./b.md", "..", "a/../b.md", "a\0b.md"]) {
      assert.equal(
        resolveUnitFile(sp, { kind: "note", repoRoot: repo, id: bad }),
        null,
        `expected null for invalid relative path ${JSON.stringify(bad)}`,
      );
    }
    assert.equal(
      resolveUnitFile(sp, { kind: "flat_artifact", repoRoot: repo, id: "sub/spill.md" }),
      null,
    );
    // Flat artifact with literal backslash is accepted as a single POSIX filename.
    const flatDir = sp.artifactsDir({ repoRoot: repo, chatSessionId: "chat-1" });
    mkdirSync(flatDir, { recursive: true });
    const flatBackslash = join(flatDir, "a\\b.md");
    writeFileSync(flatBackslash, "flat-backslash", "utf8");
    assert.equal(
      resolveUnitFile(sp, { kind: "flat_artifact", repoRoot: repo, id: "a\\b.md", chatSessionId: "chat-1" })?.path,
      flatBackslash,
    );
  });

  it("P1: resolveLegacyPath returns the union-winning existing file across relative legacy, absolute legacy, and absolute data-dir spellings", () => {
    const root = makeTempDir("pi-fp-p1-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const projDir = sp.projectDir(repo);
    const owner = { repoRoot: repo, chatSessionId: "chat-1" };

    // 1. Goal unit exists in both legacy and data-dir.
    const legGoalDir = join(repo, ".harness", "goals", "goal-1");
    const ddGoalDir = join(projDir, "chats", "chat-1", "goals", "goal-1");
    mkdirSync(legGoalDir, { recursive: true });
    mkdirSync(ddGoalDir, { recursive: true });
    writeFileSync(join(ddGoalDir, "baseline.md"), "dd-only", "utf8");
    writeFileSync(join(legGoalDir, "conflict.md"), "legacy-wins", "utf8");
    writeFileSync(join(ddGoalDir, "conflict.md"), "dd-shadowed", "utf8");

    // Data-dir-only file must resolve to data-dir even though legacy goal directory exists.
    assert.equal(sp.resolveLegacyPath(repo, ".harness/goals/goal-1/baseline.md", owner), join(ddGoalDir, "baseline.md"));
    assert.equal(sp.resolveLegacyPath(repo, join(legGoalDir, "baseline.md"), owner), join(ddGoalDir, "baseline.md"));
    assert.equal(sp.resolveLegacyPath(repo, join(ddGoalDir, "baseline.md"), owner), join(ddGoalDir, "baseline.md"));

    // Conflicting file must resolve to legacy winner even when spelled as absolute data-dir path.
    assert.equal(sp.resolveLegacyPath(repo, ".harness/goals/goal-1/conflict.md", owner), join(legGoalDir, "conflict.md"));
    assert.equal(sp.resolveLegacyPath(repo, join(legGoalDir, "conflict.md"), owner), join(legGoalDir, "conflict.md"));
    assert.equal(sp.resolveLegacyPath(repo, join(ddGoalDir, "conflict.md"), owner), join(legGoalDir, "conflict.md"));

    // Missing file (creation placement) falls back to directory preference (legacy dir exists -> legacy).
    assert.equal(sp.resolveLegacyPath(repo, ".harness/goals/goal-1/new.md", owner), join(legGoalDir, "new.md"));

    // 2. Run unit exists in both legacy and data-dir.
    const legRunDir = join(repo, ".harness", "artifacts", "run-1", "t-1");
    const ddRunDir = join(projDir, "chats", "chat-1", "artifacts", "run-1", "t-1");
    mkdirSync(legRunDir, { recursive: true });
    mkdirSync(ddRunDir, { recursive: true });
    writeFileSync(join(ddRunDir, "dd-only.md"), "dd", "utf8");
    writeFileSync(join(legRunDir, "both.md"), "leg", "utf8");
    writeFileSync(join(ddRunDir, "both.md"), "dd", "utf8");

    assert.equal(sp.resolveLegacyPath(repo, ".harness/artifacts/run-1/t-1/dd-only.md", owner), join(ddRunDir, "dd-only.md"));
    assert.equal(sp.resolveLegacyPath(repo, join(ddRunDir, "both.md"), owner), join(legRunDir, "both.md"));

    // 3. Bucket task unit exists in both legacy and data-dir.
    const legBucketDir = join(repo, ".harness", "artifacts", "director-tasks-chat-1", "t-2");
    const ddBucketDir = join(projDir, "chats", "chat-1", "artifacts", "director-tasks-chat-1", "t-2");
    mkdirSync(legBucketDir, { recursive: true });
    mkdirSync(ddBucketDir, { recursive: true });
    writeFileSync(join(ddBucketDir, "dd-only.md"), "dd", "utf8");
    writeFileSync(join(legBucketDir, "both.md"), "leg", "utf8");
    writeFileSync(join(ddBucketDir, "both.md"), "dd", "utf8");

    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/artifacts/director-tasks-chat-1/t-2/dd-only.md", owner),
      join(ddBucketDir, "dd-only.md"),
    );
    assert.equal(
      sp.resolveLegacyPath(repo, join(ddBucketDir, "both.md"), owner),
      join(legBucketDir, "both.md"),
    );

    // 4. Flat artifact and note exist in both legacy and data-dir: absolute data-dir spelling resolves to legacy winner.
    const legSpill = join(repo, ".harness", "artifacts", "spill.md");
    const ddSpill = join(projDir, "chats", "chat-1", "artifacts", "spill.md");
    writeFileSync(legSpill, "leg-spill", "utf8");
    writeFileSync(ddSpill, "dd-spill", "utf8");
    assert.equal(sp.resolveLegacyPath(repo, ddSpill, owner), legSpill);

    const legNote = join(repo, ".harness", "notes", "shared.md");
    const ddNote = join(projDir, "notes", "shared.md");
    mkdirSync(join(repo, ".harness", "notes"), { recursive: true });
    mkdirSync(join(projDir, "notes"), { recursive: true });
    writeFileSync(legNote, "leg-note", "utf8");
    writeFileSync(ddNote, "dd-note", "utf8");
    assert.equal(sp.resolveLegacyPath(repo, ddNote, owner), legNote);
  });

  it("P2: taskGrants drops harness-derived roots with a symlink or non-directory component below the trusted anchor in both layouts", () => {
    const root = makeTempDir("pi-fp-p2-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    const opExtraRead = join(root, "op-extra-read");
    const opExtraWrite = join(root, "op-extra-write");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(outside, "run-1"), { recursive: true });
    mkdirSync(opExtraRead, { recursive: true });
    mkdirSync(opExtraWrite, { recursive: true });

    // 1. data-dir layout
    const sp = storagePaths(
      {
        stateDir,
        worktree: { extraReadRoots: [opExtraRead], extraWriteRoots: [opExtraWrite] },
      },
      { layout: "data-dir" },
    );
    const projDir = sp.projectDir(repo);
    mkdirSync(join(projDir, "chats", "chat-1"), { recursive: true });
    // Redirect own notes -> stateDir, own artifacts -> outside (which has run-1/), legacy chat -> outside, project notes -> file.
    symlinkSync(stateDir, join(projDir, "chats", "chat-1", "notes"));
    symlinkSync(outside, join(projDir, "chats", "chat-1", "artifacts"));
    symlinkSync(outside, join(projDir, "chats", "legacy"));
    writeFileSync(join(projDir, "notes"), "not-a-dir", "utf8");
    // Own goals does NOT exist yet -> stays granted lexically!

    const run = { repoRoot: repo, chatSessionId: "chat-1", id: "run-1" };
    const ddGrants = sp.taskGrants({ run, goal: null, writable: true });
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "chats", "chat-1", "goals")), true);
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "chats", "chat-1", "notes")), false);
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "chats", "chat-1", "artifacts")), false);
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "chats", "chat-1", "artifacts", "run-1")), false);
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "notes")), false);
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "chats", "legacy", "goals")), false);
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "chats", "legacy", "artifacts")), false);
    assert.equal(ddGrants.extraReadRoots.includes(join(projDir, "chats", "legacy", "notes")), false);
    // Operator-configured extra roots are unaffected.
    assert.equal(ddGrants.extraReadRoots.includes(opExtraRead), true);
    assert.equal(ddGrants.extraWriteRoots?.includes(opExtraWrite), true);
    assert.equal(ddGrants.extraWriteRoots?.includes(join(projDir, "chats", "chat-1", "goals")), true);

    // Non-directory at own goals drops it from both extraReadRoots and non-goal extraWriteRoots.
    writeFileSync(join(projDir, "chats", "chat-1", "goals"), "file", "utf8");
    const ddGrantsBadGoals = sp.taskGrants({ run, goal: null, writable: true });
    assert.equal(ddGrantsBadGoals.extraReadRoots.includes(join(projDir, "chats", "chat-1", "goals")), false);
    assert.equal(ddGrantsBadGoals.extraWriteRoots?.includes(join(projDir, "chats", "chat-1", "goals")), false);

    // 2. legacy layout
    const legacyRepo = join(root, "legacy-repo");
    mkdirSync(join(legacyRepo, ".harness"), { recursive: true });
    symlinkSync(outside, join(legacyRepo, ".harness", "goals"));
    writeFileSync(join(legacyRepo, ".harness", "artifacts"), "not-a-dir", "utf8");

    const spLegacy = storagePaths(
      {
        stateDir,
        worktree: { extraReadRoots: [opExtraRead], extraWriteRoots: [opExtraWrite] },
      },
      { layout: "legacy" },
    );
    const legGrants = spLegacy.taskGrants({
      run: { repoRoot: legacyRepo, id: "run-1" },
      goal: null,
      writable: true,
    });
    assert.equal(legGrants.extraReadRoots.includes(join(legacyRepo, ".harness", "goals")), false);
    assert.equal(legGrants.extraReadRoots.includes(join(legacyRepo, ".harness", "artifacts")), false);
    assert.equal(legGrants.extraWriteRoots?.includes(join(legacyRepo, ".harness", "goals")), false);
    // Operator-configured extra roots stay untouched.
    assert.equal(legGrants.extraReadRoots.includes(opExtraRead), true);
    assert.equal(legGrants.extraWriteRoots?.includes(opExtraWrite), true);

    // Non-existent legacy roots still stay granted lexically.
    const freshLegacyRepo = join(root, "fresh-legacy-repo");
    mkdirSync(freshLegacyRepo, { recursive: true });
    const freshLegGrants = spLegacy.taskGrants({
      run: { repoRoot: freshLegacyRepo, id: "run-2" },
      goal: null,
      writable: true,
    });
    assert.equal(freshLegGrants.extraReadRoots.includes(join(freshLegacyRepo, ".harness", "goals")), true);
    assert.equal(freshLegGrants.extraReadRoots.includes(join(freshLegacyRepo, ".harness", "artifacts")), true);
  });

  it("P3: goal unit entry points decide from both halves regardless of call order and fail closed when a partner half cannot be created", () => {
    const root = makeTempDir("pi-fp-p3-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const outside = join(root, "outside");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const projDir = sp.projectDir(repo);

    // 1. Only legacy run half exists: calling goalEvidenceDir/ensureGoalEvidenceDir BEFORE taskGrants picks and creates legacy goal dir.
    const legRun1 = join(repo, ".harness", "artifacts", "run-1");
    const legGoal1 = join(repo, ".harness", "goals", "goal-1");
    mkdirSync(legRun1, { recursive: true });

    const goal1 = { repoRoot: repo, chatSessionId: "chat-1", id: "goal-1", linkedRunId: "run-1" };
    const run1 = { repoRoot: repo, chatSessionId: "chat-1", id: "run-1", linkedGoalId: "goal-1" };
    assert.equal(sp.goalEvidenceDir(goal1), legGoal1);
    assert.equal(sp.ensureGoalEvidenceDir(goal1), legGoal1);
    assert.equal(existsSync(legGoal1), true);
    assert.equal(existsSync(join(projDir, "chats", "chat-1", "goals", "goal-1")), false);
    const grants1 = sp.taskGrants({ run: run1, goal: goal1, writable: true });
    assert.equal(grants1.extraEnv?.HARNESS_GOAL_EVIDENCE_DIR, legGoal1);

    // 2. Only legacy goal half exists: calling runArtifactsDir/ensureDossierDir BEFORE taskGrants picks and creates legacy run dir.
    const legGoal2 = join(repo, ".harness", "goals", "goal-2");
    const legRun2 = join(repo, ".harness", "artifacts", "run-2");
    mkdirSync(legGoal2, { recursive: true });

    const run2 = { repoRoot: repo, chatSessionId: "chat-1", id: "run-2", linkedGoalId: "goal-2" };
    assert.equal(sp.runArtifactsDir(run2), legRun2);
    assert.equal(sp.ensureDossierDir(run2, "run-2", "t-1"), join(legRun2, "t-1"));
    assert.equal(sp.ensureDossierDir(run2), join(repo, ".harness", "artifacts"));
    assert.equal(existsSync(join(projDir, "chats", "chat-1", "artifacts", "run-2")), false);

    // 3. Partner goal half is a symlink while legacy run half is a real dir -> fail closed, no split data-dir creation!
    const legRun3 = join(repo, ".harness", "artifacts", "run-3");
    const legGoal3 = join(repo, ".harness", "goals", "goal-3");
    mkdirSync(legRun3, { recursive: true });
    symlinkSync(outside, legGoal3);

    const goal3 = { repoRoot: repo, chatSessionId: "chat-1", id: "goal-3", linkedRunId: "run-3" };
    const run3 = { repoRoot: repo, chatSessionId: "chat-1", id: "run-3", linkedGoalId: "goal-3" };
    assert.equal(sp.ensureGoalEvidenceDir(goal3), null);
    assert.equal(existsSync(join(projDir, "chats", "chat-1", "goals", "goal-3")), false);
    const grants3 = sp.taskGrants({
      run: { repoRoot: repo, chatSessionId: "chat-1", id: "run-3" },
      goal: { repoRoot: repo, chatSessionId: "chat-1", id: "goal-3" },
      writable: true,
    });
    assert.equal(grants3.extraEnv?.HARNESS_GOAL_EVIDENCE_DIR, undefined);
    assert.deepEqual(grants3.extraWriteRoots, []);
    assert.equal(existsSync(join(projDir, "chats", "chat-1", "goals", "goal-3")), false);
    assert.throws(() => sp.ensureDossierDir(run3, "run-3", "t-1"), /ENOTDIR/);

    // 4. Partner run half is a regular file while legacy goal half is a real dir -> fail closed, no split placement!
    const legGoal4 = join(repo, ".harness", "goals", "goal-4");
    const legRun4 = join(repo, ".harness", "artifacts", "run-4");
    mkdirSync(legGoal4, { recursive: true });
    writeFileSync(legRun4, "not-a-dir", "utf8");

    const goal4 = { repoRoot: repo, chatSessionId: "chat-1", id: "goal-4", linkedRunId: "run-4" };
    const run4 = { repoRoot: repo, chatSessionId: "chat-1", id: "run-4", linkedGoalId: "goal-4" };
    assert.equal(sp.ensureGoalEvidenceDir(goal4), null);
    const grants4 = sp.taskGrants({
      run: { repoRoot: repo, chatSessionId: "chat-1", id: "run-4" },
      goal: { repoRoot: repo, chatSessionId: "chat-1", id: "goal-4" },
      writable: true,
    });
    assert.equal(grants4.extraEnv?.HARNESS_GOAL_EVIDENCE_DIR, undefined);
    assert.equal(grants4.extraEnv?.HARNESS_GOALS_DIR, join(repo, ".harness", "goals"));
    assert.equal(grants4.extraEnv?.HARNESS_ARTIFACTS_DIR, join(repo, ".harness", "artifacts"));
    assert.deepEqual(grants4.extraWriteRoots, []);
    assert.throws(() => sp.ensureDossierDir(run4, "run-4", "t-1"), /ENOTDIR/);
  });

  it("P4: protects custom legacy worktree.dir roots in directorReadPolicy, isProtectedWorktreePath, and taskGrants while exempting own workspace", () => {
    const root = makeTempDir("pi-fp-p4-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const customExtWt = join(root, "custom-wt");
    const ownWt = join(customExtWt, "run-1", "t-1");
    const siblingWt = join(customExtWt, "run-1", "t-2");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(ownWt, "src"), { recursive: true });
    mkdirSync(join(siblingWt, "src"), { recursive: true });

    // 1. data-dir layout with external custom worktree.dir
    const sp = storagePaths(
      {
        stateDir,
        worktree: { dir: customExtWt, extraReadRoots: [root, customExtWt], extraWriteRoots: [root, customExtWt] },
      },
      { layout: "data-dir" },
    );
    assert.ok(sp.managedWorktreeRoots(repo).includes(customExtWt));

    // Director read policy (used by read_file and goal_accept) refuses custom worktree root, keeps repo source allowed.
    assert.equal(sp.directorReadPolicy(repo, join(siblingWt, "src", "a.ts")).ok, false);
    assert.equal(sp.directorReadPolicy(repo, customExtWt).ok, false);
    assert.equal(sp.directorReadPolicy(repo, join(repo, "src", "index.ts")).ok, true);

    // isProtectedWorktreePath refuses custom worktrees, exempts caller's own workspace, refuses sibling.
    assert.equal(sp.isProtectedWorktreePath(join(ownWt, "src", "a.ts")), true);
    assert.equal(sp.isProtectedWorktreePath(join(ownWt, "src", "a.ts"), ownWt), false);
    assert.equal(sp.isProtectedWorktreePath(join(siblingWt, "src", "a.ts"), ownWt), true);

    // taskGrants exposes custom worktree root in deniedRoots & protectedRoots and drops direct extra roots inside it.
    const grants = sp.taskGrants({
      run: { repoRoot: repo, chatSessionId: "chat-1", id: "run-1" },
      goal: null,
      writable: true,
      workspace: ownWt,
    });
    assert.equal(grants.deniedRoots.includes(customExtWt), true);
    assert.equal(grants.protectedRoots.includes(customExtWt), true);
    assert.equal(grants.extraReadRoots.includes(customExtWt), false);
    assert.equal(grants.extraWriteRoots?.includes(customExtWt), false);

    // 2. legacy layout with repo-relative custom worktree.dir inside repo
    const relRepo = join(root, "rel-repo");
    const relCustomWt = join(relRepo, "custom-trees");
    const relOwnWt = join(relCustomWt, "run-2", "t-1");
    const relSiblingWt = join(relCustomWt, "run-2", "t-2");
    mkdirSync(join(relRepo, "src"), { recursive: true });
    mkdirSync(join(relOwnWt, "src"), { recursive: true });
    mkdirSync(join(relSiblingWt, "src"), { recursive: true });

    const spLeg = storagePaths({ stateDir, worktree: { dir: "custom-trees" } }, { layout: "legacy" });
    assert.deepEqual(spLeg.managedWorktreeRoots(relRepo), [relCustomWt]);
    assert.equal(spLeg.directorReadPolicy(relRepo, join(relOwnWt, "src", "a.ts")).ok, false);
    assert.equal(spLeg.directorReadPolicy(relRepo, join(relRepo, "src", "index.ts")).ok, true);
    assert.equal(spLeg.isProtectedWorktreePath(join(relOwnWt, "src", "a.ts"), relRepo), true);
    assert.equal(spLeg.isProtectedWorktreePath(join(relRepo, "src", "index.ts"), relRepo), false);
    assert.equal(spLeg.isProtectedWorktreePath(join(relOwnWt, "src", "a.ts"), relOwnWt), false);
    assert.equal(spLeg.isProtectedWorktreePath(join(relSiblingWt, "src", "a.ts"), relOwnWt), true);

    const legGrants = spLeg.taskGrants({
      run: { repoRoot: relRepo, id: "run-2" },
      goal: null,
      writable: true,
      workspace: relOwnWt,
    });
    assert.equal(legGrants.deniedRoots.includes(relCustomWt), true);
    assert.equal(legGrants.protectedRoots.includes(relCustomWt), true);
  });

  it("P5: directorWritePolicy restricts writes to own chat notes/goals, projectNotesDir, own live legacy units, and external extraWriteRoots without changing directorReadPolicy (A6)", () => {
    const root = makeTempDir("pi-fp-p5-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const otherRepo = join(root, "other-repo");
    const externalDocs = join(root, "docs");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    mkdirSync(externalDocs, { recursive: true });

    // Configure extraWriteRoots with `root` (an ancestor of stateDir, dataRoot, and repo — the exact Review B attack).
    const sp = storagePaths(
      {
        stateDir,
        worktree: { extraWriteRoots: [root] },
      },
      { layout: "data-dir" },
    );
    const projDir = sp.projectDir(repo);
    const otherProjDir = sp.projectDir(otherRepo);
    const owner = { repoRoot: repo, chatSessionId: "chat-1" };

    // Live legacy units on disk: one goal owned by chat-1, one goal owned by chat-2, one existing legacy note file.
    const ownLegGoal = join(repo, ".harness", "goals", "goal-own");
    const otherLegGoal = join(repo, ".harness", "goals", "goal-other");
    const legNotesDir = join(repo, ".harness", "notes");
    const existingLegNote = join(legNotesDir, "existing.md");
    mkdirSync(ownLegGoal, { recursive: true });
    mkdirSync(otherLegGoal, { recursive: true });
    mkdirSync(legNotesDir, { recursive: true });
    writeFileSync(existingLegNote, "legacy-note", "utf8");

    const opts = { ownLegacyGoalIds: ["goal-own"] };

    // Allowed writes:
    for (const allowed of [
      join(projDir, "chats", "chat-1", "notes", "scratch.md"),
      join(projDir, "chats", "chat-1", "goals", "goal-9", "ev.md"),
      join(projDir, "notes", "project-wide.md"),
      join(ownLegGoal, "ev.md"),
      existingLegNote,
      join(externalDocs, "report.md"),
    ]) {
      assert.deepEqual(
        sp.directorWritePolicy(owner, allowed, opts),
        { ok: true },
        `expected write allowed for ${allowed}`,
      );
    }

    // Refused writes (even though `root` is in extraWriteRoots and A6 allows reading other chats/projects/artifacts):
    const otherChatArtifact = join(projDir, "chats", "chat-2", "artifacts", "run-2", "t-1", "d.md");
    const otherChatNotes = join(projDir, "chats", "chat-2", "notes", "n.md");
    const otherProjNotes = join(otherProjDir, "notes", "n.md");
    // Confirm A6 read reach is unchanged.
    assert.deepEqual(sp.directorReadPolicy(repo, otherChatArtifact), { ok: true });
    assert.deepEqual(sp.directorReadPolicy(repo, otherChatNotes), { ok: true });
    assert.deepEqual(sp.directorReadPolicy(repo, otherProjNotes), { ok: true });

    const refused = [
      otherChatArtifact,
      otherChatNotes,
      join(projDir, "chats", "chat-2", "goals", "goal-2", "ev.md"),
      join(projDir, "chats", "chat-1", "artifacts", "run-1", "t-1", "d.md"),
      otherProjNotes,
      join(otherLegGoal, "ev.md"),
      join(legNotesDir, "brand-new.md"),
      join(repo, ".harness", "artifacts", "run-1", "t-1", "d.md"),
      join(stateDir, "config.json"),
      join(projDir, "project.json"),
      join(projDir, "chats", "chat-1", "worktrees", "run-1", "t-1", "a.ts"),
      join(projDir, "scratch", "_verify", "v1", "a.ts"),
      join(repo, ".git", "HEAD"),
    ];
    for (const target of refused) {
      const verdict = sp.directorWritePolicy(owner, target, opts);
      assert.equal(verdict.ok, false, `expected write refused for ${target}`);
      if (!verdict.ok) {
        assert.ok(
          verdict.reason.includes(sp.notesDir(owner)) && verdict.reason.includes(sp.projectNotesDir(repo)),
          `refusal reason must name allowed roots (got: ${verdict.reason})`,
        );
      }
    }

    // Omitting ownLegacyGoalIds fails closed on legacy goal dirs.
    assert.equal(sp.directorWritePolicy(owner, join(ownLegGoal, "ev.md")).ok, false);

    // Symlink inside own notes pointing into another chat is refused.
    mkdirSync(join(projDir, "chats", "chat-1", "notes"), { recursive: true });
    mkdirSync(join(projDir, "chats", "chat-2", "notes"), { recursive: true });
    writeFileSync(otherChatNotes, "other", "utf8");
    const escapeLink = join(projDir, "chats", "chat-1", "notes", "escape.md");
    symlinkSync(otherChatNotes, escapeLink);
    assert.equal(sp.directorWritePolicy(owner, escapeLink, opts).ok, false);
  });

  it("P6/D2: names.ts validates run/task segments in data-dir and normalizes unsafe chat ids to legacy without throwing", () => {
    const invalidSegments = [
      "",
      ".",
      "..",
      ".hidden",
      "trailing.",
      "demo.lock",
      "a..b",
      "a@{b",
      "@",
      "bad\x01ctrl",
      "bad\x7fdel",
      "has space",
      "a~1",
      "a^1",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "../bad/chat",
    ];

    for (const bad of invalidSegments) {
      assert.equal(
        taskBranchName({ id: "run-1", chatSessionId: bad }, "t-1", "data-dir"),
        "harness/legacy/run-1/t-1",
        `expected invalid chatSessionId ${JSON.stringify(bad)} to fall back to legacy in taskBranchName`,
      );
      assert.equal(
        archiveRef({ id: "run-1", chatSessionId: bad }, "t-1", "data-dir"),
        "refs/harness/legacy/archive/run-1/t-1",
        `expected invalid chatSessionId ${JSON.stringify(bad)} to fall back to legacy in archiveRef`,
      );
      assert.equal(
        mergedRef({ id: "run-1", chatSessionId: bad }, "data-dir"),
        "refs/harness/legacy/merged/run-1",
        `expected invalid chatSessionId ${JSON.stringify(bad)} to fall back to legacy in mergedRef`,
      );
      assert.deepEqual(
        mergedRefCandidates({ id: "run-1", chatSessionId: bad }, "data-dir"),
        ["refs/harness/legacy/merged/run-1", "refs/harness/merged/run-1"],
        `expected invalid chatSessionId ${JSON.stringify(bad)} to fall back to legacy in mergedRefCandidates`,
      );
      assert.throws(
        () => taskBranchName({ id: bad, chatSessionId: "chat-1" }, "t-1", "data-dir"),
        /Invalid git ref segment/,
        `expected invalid run.id ${JSON.stringify(bad)} to throw`,
      );
      assert.throws(
        () => taskBranchName({ id: "run-1", chatSessionId: "chat-1" }, bad, "data-dir"),
        /Invalid git ref segment/,
        `expected invalid taskId ${JSON.stringify(bad)} to throw`,
      );
      assert.throws(
        () => archiveRefPatterns(bad, "data-dir"),
        /Invalid git ref segment/,
        `expected invalid runId ${JSON.stringify(bad)} to throw in archiveRefPatterns`,
      );
    }

    // Storage-unsafe chat IDs (such as '+' rejected by StoragePaths.chatSegment) also fall back to legacy.
    assert.equal(taskBranchName({ id: "run-1", chatSessionId: "chat+1" }, "t-1", "data-dir"), "harness/legacy/run-1/t-1");

    // Normal generated IDs and null/undefined chatSessionId remain unaffected.
    assert.equal(taskBranchName({ id: "run-30", chatSessionId: "chat-4" }, "t-590", "data-dir"), "harness/chat-4/run-30/t-590");
    assert.equal(taskBranchName({ id: "run-30", chatSessionId: null }, "t-590", "data-dir"), "harness/legacy/run-30/t-590");
    assert.equal(archiveRef({ id: "run-30", chatSessionId: "chat-4" }, "t-590", "data-dir"), "refs/harness/chat-4/archive/run-30/t-590");
    assert.equal(mergedRef({ id: "run-30", chatSessionId: "chat-4" }, "data-dir"), "refs/harness/chat-4/merged/run-30");
  });
});
