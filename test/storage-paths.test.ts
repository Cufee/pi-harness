import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { dossierDirectory } from "../src/control-plane/dossiers.js";
import { ensureGoalEvidenceDir, goalEvidenceDir } from "../src/goals/engine.js";
import { isProtectedWritePath } from "../src/runners/protected-paths.js";
import {
  createLegacyStoragePaths,
  legacyStoragePaths,
  resetStoragePathsForTest,
  resolveStorageLayout,
  storagePaths,
  type StoragePathsConfig,
} from "../src/storage/paths.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("src/storage/paths (legacy layout)", () => {
  it("resolves layout, rejects data-dir as not implemented, caches per config object, and pins data root per stateDir", () => {
    assert.equal(resolveStorageLayout(), "legacy");
    assert.equal(resolveStorageLayout("legacy"), "legacy");
    assert.equal(resolveStorageLayout("data-dir"), "data-dir");
    assert.throws(
      () => resolveStorageLayout("bogus" as unknown as "legacy"),
      /Invalid storage layout from opts\.layout/,
    );

    const cfg1: StoragePathsConfig = {};
    const cfg2: StoragePathsConfig = {};
    assert.equal(storagePaths(cfg1), storagePaths(cfg1));
    assert.notEqual(storagePaths(cfg1), storagePaths(cfg2));

    assert.throws(() => storagePaths(cfg1, { layout: "data-dir" }), /not implemented/i);

    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();
    assert.equal(resolveStorageLayout(), "data-dir");
    assert.throws(() => storagePaths({}), /not implemented/i);
    assert.equal(storagePaths({}, { layout: "legacy" }).layout, "legacy");

    process.env.PI_HARNESS_STORAGE_LAYOUT = "invalid-mode";
    resetStoragePathsForTest();
    assert.throws(() => resolveStorageLayout(), /Invalid storage layout from PI_HARNESS_STORAGE_LAYOUT/);

    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
    resetStoragePathsForTest();

    // Pinned data root per stateDir: a later config object with a different storage.dataDir keeps the first pin.
    const root = makeTempDir("pi-storage-pin-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const dataA = join(stateDir, "data-a");
    const dataB = join(stateDir, "data-b");
    mkdirSync(dataA, { recursive: true });
    mkdirSync(dataB, { recursive: true });

    const first = storagePaths({ stateDir, storage: { dataDir: dataA } });
    const second = storagePaths({ stateDir, storage: { dataDir: dataB } });
    assert.equal(first.isStateInternalPath(join(dataA, "projects", "p")), false);
    assert.equal(second.isStateInternalPath(join(dataA, "projects", "p")), false);
    assert.equal(second.isStateInternalPath(join(dataB, "projects", "p")), true);

    resetStoragePathsForTest();
    const afterReset = storagePaths({ stateDir, storage: { dataDir: dataB } });
    assert.equal(afterReset.isStateInternalPath(join(dataB, "projects", "p")), false);
  });

  it("computes every legacy path against hand-written expectations and ignores worktree.artifactsDir", () => {
    const root = makeTempDir("pi-storage-paths-");
    const repo = join(root, "my-repo");
    const repoLink = join(root, "my-repo-link");
    mkdirSync(repo, { recursive: true });
    symlinkSync(repo, repoLink);

    const cfg: StoragePathsConfig = {
      worktree: {
        dir: undefined,
        extraReadRoots: [],
        extraWriteRoots: [],
        // @ts-expect-error verifying legacy artifactsDir on config is ignored
        artifactsDir: "custom/artifacts",
      },
    };
    const sp = storagePaths(cfg);
    const owner = { repoRoot: repo, chatSessionId: "chat-7" };
    const goal = { repoRoot: repo, chatSessionId: "chat-7", id: "goal-42" };
    const run = { repoRoot: repo, chatSessionId: "chat-7", id: "run-9" };

    const expectedHash = createHash("sha256").update(repo).digest("hex").slice(0, 12);
    assert.equal(sp.projectKey(repo), `${basename(repo)}-${expectedHash}`);
    assert.equal(sp.projectKey(repoLink), `${basename(repo)}-${expectedHash}`);

    assert.equal(sp.projectDir(repo), `${repo}/.harness`);
    assert.equal(sp.chatDir(owner), `${repo}/.harness`);
    assert.equal(sp.chatDir({ repoRoot: repo }), `${repo}/.harness`);
    assert.equal(sp.goalsDir(owner), `${repo}/.harness/goals`);
    assert.equal(sp.goalEvidenceDir(goal), `${repo}/.harness/goals/goal-42`);
    assert.equal(sp.artifactsDir(owner), `${repo}/.harness/artifacts`);
    assert.equal(sp.runArtifactsDir(run), `${repo}/.harness/artifacts/run-9`);
    assert.equal(sp.taskDossierDir(run, "t-12"), `${repo}/.harness/artifacts/run-9/t-12`);
    assert.equal(sp.notesDir(owner), `${repo}/.harness/notes`);
    assert.equal(sp.projectNotesDir(repo), `${repo}/.harness/notes`);
    assert.equal(sp.worktreePath(run, "t-12"), `${repo}/.harness/worktrees/run-9/t-12`);
    assert.equal(sp.scratchPath(repo, "_verify", "v1"), `${repo}/.harness/worktrees/_verify/v1`);
    assert.equal(sp.scratchPath(repo, "_integration", "i1"), `${repo}/.harness/worktrees/_integration/i1`);
    assert.deepEqual(sp.managedWorktreeRoots(repo), [`${repo}/.harness/worktrees`]);

    // Custom worktree.dir in legacy config is respected for worktrees and managedWorktreeRoots.
    const customSp = createLegacyStoragePaths({ worktree: { dir: "custom-wt" } });
    assert.equal(customSp.worktreePath(run, "t-12"), `${repo}/custom-wt/run-9/t-12`);
    assert.equal(customSp.scratchPath(repo, "_verify", "v2"), `${repo}/custom-wt/_verify/v2`);
    assert.deepEqual(customSp.managedWorktreeRoots(repo), [`${repo}/custom-wt`]);

    // artifactRel accepts raw and symlinked repo roots and rejects non-artifact paths.
    assert.equal(
      sp.artifactRel(run, `${repo}/.harness/artifacts/run-9/t-12/dossier.md`),
      ".harness/artifacts/run-9/t-12/dossier.md",
    );
    assert.equal(
      sp.artifactRel(run, `${repoLink}/.harness/artifacts/run-9/t-12/dossier.md`),
      ".harness/artifacts/run-9/t-12/dossier.md",
    );
    assert.equal(sp.artifactRel(run, `${repo}/.harness/goals/goal-42/note.md`), null);
    assert.equal(sp.artifactRel(run, `${repo}/.harness/artifacts/`), null);
    assert.equal(sp.artifactRel(run, `${repo}/.harness/artifacts/run-9/\0bad.md`), null);
  });

  it("validates goal id segments strictly", () => {
    const repo = makeTempDir("pi-storage-goal-id-");
    assert.equal(legacyStoragePaths.goalEvidenceDir({ repoRoot: repo, id: "goal-1_a.2" }), `${repo}/.harness/goals/goal-1_a.2`);
    assert.equal(goalEvidenceDir(repo, "goal-1_a.2"), `${repo}/.harness/goals/goal-1_a.2`);

    for (const badId of ["", ".", "..", "../escape", "a/b", "a\\b", "goal 1", "goal$1", "goal\0"]) {
      assert.throws(() => legacyStoragePaths.goalEvidenceDir({ repoRoot: repo, id: badId }), /Invalid goal id/);
      assert.throws(() => goalEvidenceDir(repo, badId), /Invalid goal id/);
      assert.equal(legacyStoragePaths.ensureGoalEvidenceDir({ repoRoot: repo, id: badId }), null);
      assert.equal(ensureGoalEvidenceDir(repo, badId), null);
    }
  });

  it("refuses symlinks and non-directories in ensureGoalEvidenceDir and ensureDossierDir", () => {
    const root = makeTempDir("pi-storage-symlink-");
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });

    // Clean creation succeeds for both.
    const repoClean = join(root, "repo-clean");
    mkdirSync(repoClean, { recursive: true });
    assert.equal(
      legacyStoragePaths.ensureGoalEvidenceDir({ repoRoot: repoClean, id: "goal-1" }),
      `${repoClean}/.harness/goals/goal-1`,
    );
    assert.equal(existsSync(`${repoClean}/.harness/goals/goal-1`), true);
    assert.equal(
      legacyStoragePaths.ensureDossierDir({ repoRoot: repoClean, id: "run-1" }, "run-1", "t-1"),
      `${repoClean}/.harness/artifacts/run-1/t-1`,
    );
    assert.equal(existsSync(`${repoClean}/.harness/artifacts/run-1/t-1`), true);

    // Symlink at .harness
    const repoSymHarness = join(root, "repo-sym-harness");
    mkdirSync(repoSymHarness, { recursive: true });
    symlinkSync(outside, join(repoSymHarness, ".harness"));
    assert.equal(legacyStoragePaths.ensureGoalEvidenceDir({ repoRoot: repoSymHarness, id: "goal-1" }), null);
    assert.throws(
      () => legacyStoragePaths.ensureDossierDir({ repoRoot: repoSymHarness, id: "run-1" }, "run-1", "t-1"),
      /ENOTDIR/,
    );

    // Symlink at .harness/goals and .harness/artifacts
    const repoSymSubdir = join(root, "repo-sym-subdir");
    mkdirSync(join(repoSymSubdir, ".harness"), { recursive: true });
    symlinkSync(outside, join(repoSymSubdir, ".harness", "goals"));
    symlinkSync(outside, join(repoSymSubdir, ".harness", "artifacts"));
    assert.equal(legacyStoragePaths.ensureGoalEvidenceDir({ repoRoot: repoSymSubdir, id: "goal-1" }), null);
    assert.throws(
      () => legacyStoragePaths.ensureDossierDir({ repoRoot: repoSymSubdir, id: "run-1" }, "run-1"),
      /ENOTDIR/,
    );

    // Broken symlink and regular file at leaf
    const repoLeaf = join(root, "repo-leaf");
    mkdirSync(join(repoLeaf, ".harness", "goals"), { recursive: true });
    mkdirSync(join(repoLeaf, ".harness", "artifacts"), { recursive: true });
    symlinkSync(join(root, "does-not-exist"), join(repoLeaf, ".harness", "goals", "goal-broken"));
    writeFileSync(join(repoLeaf, ".harness", "goals", "goal-file"), "x", "utf8");
    symlinkSync(join(root, "does-not-exist"), join(repoLeaf, ".harness", "artifacts", "run-broken"));
    writeFileSync(join(repoLeaf, ".harness", "artifacts", "run-file"), "x", "utf8");

    assert.equal(legacyStoragePaths.ensureGoalEvidenceDir({ repoRoot: repoLeaf, id: "goal-broken" }), null);
    assert.equal(legacyStoragePaths.ensureGoalEvidenceDir({ repoRoot: repoLeaf, id: "goal-file" }), null);
    assert.throws(
      () => legacyStoragePaths.ensureDossierDir({ repoRoot: repoLeaf, id: "run-broken" }, "run-broken", "t-1"),
      /ENOTDIR/,
    );
    assert.throws(
      () => legacyStoragePaths.ensureDossierDir({ repoRoot: repoLeaf, id: "run-file" }, "run-file"),
      /ENOTDIR/,
    );
    assert.throws(
      () => legacyStoragePaths.ensureDossierDir({ repoRoot: repoLeaf, id: "run-1" }, "..", "escape"),
      /ENOTDIR/,
    );

    // Deprecated wrappers match StoragePaths behavior.
    assert.equal(ensureGoalEvidenceDir(repoLeaf, "goal-broken"), null);
    assert.equal(dossierDirectory(repoClean, "run-2", "t-2"), `${repoClean}/.harness/artifacts/run-2/t-2`);
    assert.throws(() => dossierDirectory(repoLeaf, "run-file"), /ENOTDIR/);
  });

  it("computes taskGrants for goal writable, goal read-only, symlinked evidence dir, and non-goal runs", () => {
    const root = makeTempDir("pi-storage-grants-");
    const repo = join(root, "repo");
    const extraRead = join(root, "extra-read");
    const extraWrite = join(root, "extra-write");
    mkdirSync(repo, { recursive: true });
    mkdirSync(extraRead, { recursive: true });
    mkdirSync(extraWrite, { recursive: true });

    const sp = storagePaths({
      worktree: {
        extraReadRoots: [extraRead, `${repo}/.harness/goals`],
        extraWriteRoots: [extraWrite],
      },
    });
    const run = { repoRoot: repo, id: "run-1" };
    const goal = { repoRoot: repo, id: "goal-7" };

    const writableGoal = sp.taskGrants({ run, goal, writable: true });
    assert.deepEqual(writableGoal, {
      extraReadRoots: [`${repo}/.harness/goals`, `${repo}/.harness/artifacts`, extraRead],
      extraWriteRoots: [`${repo}/.harness/goals/goal-7`, extraWrite],
      extraEnv: {
        HARNESS_GOAL_EVIDENCE_DIR: `${repo}/.harness/goals/goal-7`,
        HARNESS_GOAL_ID: "goal-7",
        HARNESS_GOALS_DIR: `${repo}/.harness/goals`,
        HARNESS_ARTIFACTS_DIR: `${repo}/.harness/artifacts`,
      },
      deniedRoots: [],
      protectedRoots: [],
    });

    const readOnlyGoal = sp.taskGrants({ run, goal, writable: false });
    assert.deepEqual(readOnlyGoal, {
      extraReadRoots: [`${repo}/.harness/goals`, `${repo}/.harness/artifacts`, extraRead],
      extraWriteRoots: undefined,
      extraEnv: {
        HARNESS_GOAL_EVIDENCE_DIR: `${repo}/.harness/goals/goal-7`,
        HARNESS_GOAL_ID: "goal-7",
        HARNESS_GOALS_DIR: `${repo}/.harness/goals`,
        HARNESS_ARTIFACTS_DIR: `${repo}/.harness/artifacts`,
      },
      deniedRoots: [],
      protectedRoots: [],
    });

    const nonGoal = sp.taskGrants({ run, goal: null, writable: true });
    assert.deepEqual(nonGoal, {
      extraReadRoots: [`${repo}/.harness/goals`, `${repo}/.harness/artifacts`, extraRead],
      extraWriteRoots: [`${repo}/.harness/goals`, extraWrite],
      extraEnv: undefined,
      deniedRoots: [],
      protectedRoots: [],
    });

    // Symlinked evidence dir fails closed: omitted from extraWriteRoots and extraEnv.
    symlinkSync(extraWrite, join(repo, ".harness", "goals", "goal-sym"));
    const symGoal = sp.taskGrants({ run, goal: { repoRoot: repo, id: "goal-sym" }, writable: true });
    assert.deepEqual(symGoal.extraWriteRoots, [extraWrite]);
    assert.deepEqual(symGoal.extraEnv, {
      HARNESS_GOAL_ID: "goal-sym",
      HARNESS_GOALS_DIR: `${repo}/.harness/goals`,
      HARNESS_ARTIFACTS_DIR: `${repo}/.harness/artifacts`,
    });
  });

  it("maps relative and absolute legacy paths and rejects non-data paths in resolveLegacyPath", () => {
    const root = makeTempDir("pi-storage-legacy-map-");
    const repo = join(root, "repo");
    const repoLink = join(root, "repo-link");
    const otherRepo = join(root, "other-repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    symlinkSync(repo, repoLink);

    assert.equal(
      legacyStoragePaths.resolveLegacyPath(repo, ".harness/goals/goal-1/evidence.md"),
      `${repo}/.harness/goals/goal-1/evidence.md`,
    );
    assert.equal(
      legacyStoragePaths.resolveLegacyPath(repo, "./.harness/notes/plan.md"),
      `${repo}/.harness/notes/plan.md`,
    );
    assert.equal(
      legacyStoragePaths.resolveLegacyPath(repo, ".harness/artifacts/run-1/t-1/out.md"),
      `${repo}/.harness/artifacts/run-1/t-1/out.md`,
    );
    assert.equal(
      legacyStoragePaths.resolveLegacyPath(repo, ".harness/goals"),
      `${repo}/.harness/goals`,
    );
    assert.equal(
      legacyStoragePaths.resolveLegacyPath(repo, `${repo}/.harness/goals/goal-1/a.md`),
      `${repo}/.harness/goals/goal-1/a.md`,
    );
    assert.equal(
      legacyStoragePaths.resolveLegacyPath(repo, `${repoLink}/.harness/notes/n.md`),
      `${repo}/.harness/notes/n.md`,
    );
    assert.equal(
      legacyStoragePaths.resolveLegacyPath(repoLink, `${repo}/.harness/artifacts/run-1/a.md`),
      `${repo}/.harness/artifacts/run-1/a.md`,
    );

    for (const nonData of [
      "",
      "   ",
      "~",
      "~/.pi-harness/config.json",
      ".harness",
      ".harness/worktrees/run-1/t-1/file.ts",
      ".harness/other/file.txt",
      ".harness/goals/../worktrees/run-1/t-1/file.ts",
      ".harness/goals/../../src/index.ts",
      "src/index.ts",
      `${repo}/.harness/worktrees/run-1/t-1/file.ts`,
      `${otherRepo}/.harness/goals/goal-1/a.md`,
      ".harness/notes/bad\0.md",
    ]) {
      assert.equal(legacyStoragePaths.resolveLegacyPath(repo, nonData), null, `expected null for ${JSON.stringify(nonData)}`);
    }
  });

  it("enforces path policies on both sides of every boundary", () => {
    const root = makeTempDir("pi-storage-policy-");
    const repo = join(root, "repo");
    const stateDir = join(root, "state");
    const external = join(root, "external");
    const noteExtra = join(root, "notes-extra");
    const noteExtraLink = join(root, "notes-extra-link");
    mkdirSync(repo, { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(external, { recursive: true });
    mkdirSync(noteExtra, { recursive: true });
    symlinkSync(noteExtra, noteExtraLink);

    const sp = storagePaths({
      stateDir,
      worktree: { extraWriteRoots: [noteExtra, noteExtraLink, "  "] },
    });

    // directorNoteRoots
    assert.deepEqual(sp.directorNoteRoots({ repoRoot: repo }), {
      root: repo,
      allowedWriteRoots: [`${repo}/.harness/goals`, `${repo}/.harness/notes`, noteExtra],
    });

    // directorReadPolicy inside repo
    assert.deepEqual(sp.directorReadPolicy(repo, repo), { ok: true });
    assert.deepEqual(sp.directorReadPolicy(repo, `${repo}/src/index.ts`), { ok: true });
    assert.deepEqual(sp.directorReadPolicy(repo, `${repo}/.harness/goals/g/a.md`), { ok: true });
    assert.deepEqual(sp.directorReadPolicy(repo, `${repo}/.harness/notes/n.md`), { ok: true });
    assert.deepEqual(sp.directorReadPolicy(repo, `${repo}/.harness/artifacts/r/t/d.md`), { ok: true });
    assert.equal(sp.directorReadPolicy(repo, `${repo}/.harness`).ok, false);
    assert.equal(sp.directorReadPolicy(repo, `${repo}/.harness/worktrees/r/t/a.ts`).ok, false);
    assert.equal(sp.directorReadPolicy(repo, `${repo}/.harness/internal/state.json`).ok, false);
    assert.equal(sp.directorReadPolicy(repo, `${repo}/.git/HEAD`).ok, false);
    assert.equal(sp.directorReadPolicy(repo, `${repo}/.GIT/config`).ok, false);
    assert.equal(sp.directorReadPolicy(repo, `${repo}/.harness/goals/.git/config`).ok, false);

    // directorReadPolicy outside repo
    assert.deepEqual(sp.directorReadPolicy(repo, `${external}/notes.md`), { ok: true });
    assert.deepEqual(sp.directorReadPolicy(repo, `${external}/.harness/goals/g/a.md`), { ok: true });
    assert.equal(sp.directorReadPolicy(repo, `${external}/.git/HEAD`).ok, false);
    assert.equal(sp.directorReadPolicy(repo, `${external}/.harness/worktrees/r/t/a.ts`).ok, false);

    // isProtectedWorktreePath without ownWorkspace
    assert.equal(sp.isProtectedWorktreePath(`${repo}/.git/HEAD`), true);
    assert.equal(sp.isProtectedWorktreePath(`${repo}/.GIT/config`), true);
    assert.equal(sp.isProtectedWorktreePath(`${repo}/.harness/worktrees/run-1/t-1/a.ts`), true);
    assert.equal(sp.isProtectedWorktreePath(`${repo}/.HARNESS/Worktrees`), true);
    assert.equal(sp.isProtectedWorktreePath(`${repo}/.harness/goals/goal-1/note.md`), false);
    assert.equal(sp.isProtectedWorktreePath(`${repo}/src/index.ts`), false);

    // isProtectedWorktreePath with ownWorkspace inside .harness/worktrees
    const ownWt = `${repo}/.harness/worktrees/run-1/t-1`;
    assert.equal(sp.isProtectedWorktreePath(ownWt, ownWt), false);
    assert.equal(sp.isProtectedWorktreePath(`${ownWt}/src/index.ts`, ownWt), false);
    assert.equal(sp.isProtectedWorktreePath(`${ownWt}/.git`, ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(`${ownWt}/.git/HEAD`, ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(`${ownWt}/.harness/worktrees/nested`, ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(`${repo}/.harness/worktrees/run-1/t-2/src/a.ts`, ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(`${repo}/.harness/goals/goal-1/note.md`, ownWt), false);

    // Deprecated isProtectedWritePath preserves root-relative behavior for outside paths.
    assert.equal(isProtectedWritePath(ownWt, "src/index.ts"), false);
    assert.equal(isProtectedWritePath(ownWt, ".git/HEAD"), true);
    assert.equal(isProtectedWritePath(ownWt, "../t-2/src/a.ts"), false);
    assert.equal(isProtectedWritePath(ownWt, "../t-2/.git/HEAD"), true);
    assert.equal(isProtectedWritePath(repo, ".harness/worktrees/run-1/t-1/a.ts"), true);
    assert.equal(isProtectedWritePath(repo, ".harness/goals/goal-1/note.md"), false);

    // isStateInternalPath
    assert.equal(legacyStoragePaths.isStateInternalPath(stateDir), false);
    assert.equal(sp.isStateInternalPath(stateDir), true);
    assert.equal(sp.isStateInternalPath(`${stateDir}/control-plane.sqlite`), true);
    assert.equal(sp.isStateInternalPath(`${stateDir}/config.json`), true);
    assert.equal(sp.isStateInternalPath(`${stateDir}/install/current`), true);
    assert.equal(sp.isStateInternalPath(`${stateDir}/tools/bin/rg`), true);
    assert.equal(sp.isStateInternalPath(`${stateDir}/logs/daemon.log`), true);
    assert.equal(sp.isStateInternalPath(`${stateDir}/data/projects/p/notes/a.md`), false);
    assert.equal(sp.isStateInternalPath(`${external}/file.txt`), false);

    // isHarnessOwnedRelPath, containsHarnessDirSegment, harnessDirtyPathspec
    assert.equal(sp.isHarnessOwnedRelPath(".harness"), true);
    assert.equal(sp.isHarnessOwnedRelPath(".harness/goals/g1"), true);
    assert.equal(sp.isHarnessOwnedRelPath("./.harness/notes/n.md"), true);
    assert.equal(sp.isHarnessOwnedRelPath(".harness\\artifacts\\a.md"), true);
    assert.equal(sp.isHarnessOwnedRelPath(".harness-extra/a.md"), false);
    assert.equal(sp.isHarnessOwnedRelPath("src/.harness/a.md"), false);
    assert.equal(sp.isHarnessOwnedRelPath("src/index.ts"), false);

    assert.equal(sp.containsHarnessDirSegment(".harness/a.md"), true);
    assert.equal(sp.containsHarnessDirSegment("nested/.HARNESS/a.md"), true);
    assert.equal(sp.containsHarnessDirSegment(".harness-extra/a.md"), false);
    assert.equal(sp.containsHarnessDirSegment("src/index.ts"), false);

    assert.equal(sp.harnessDirtyPathspec(), ":!.harness");
  });

  it("produces exact legacy describe* strings for prompts, tool descriptions, and rejections", () => {
    assert.equal(legacyStoragePaths.describeArtifactsRoot(), ".harness/artifacts");
    assert.equal(legacyStoragePaths.describeGoalEvidenceDirTemplate(), "<repo>/.harness/goals/<goalId>");
    assert.equal(
      legacyStoragePaths.describeDirectorNoteLocation("/tmp/notes"),
      ".harness/goals/, .harness/notes/, or a configured extra write root (/tmp/notes)",
    );
    assert.equal(
      legacyStoragePaths.describeWriteNoteTool(),
      "Logged Director note/report writer scoped strictly to `.harness/goals/`, `.harness/notes/`, or configured `extraWriteRoots` (never writes tracked repository source code).",
    );
    assert.equal(
      legacyStoragePaths.describeWriteNoteTool([]),
      "Logged Director note/report writer scoped strictly to `.harness/goals/`, `.harness/notes/` (no extraWriteRoots configured; never writes tracked repository source code).",
    );
    assert.equal(
      legacyStoragePaths.describeWriteNoteTool(["/a", "/b"]),
      "Logged Director note/report writer scoped strictly to `.harness/goals/`, `.harness/notes/`, or these configured extraWriteRoots: /a, /b (never writes tracked repository source code).",
    );
    assert.equal(
      legacyStoragePaths.describeWriteNotePathParam(),
      "Destination file under .harness/goals/, .harness/notes/, or extraWriteRoots.",
    );
    assert.equal(
      legacyStoragePaths.describeWriteNotePathParam([]),
      "Destination file under .harness/goals/, .harness/notes/ (no extraWriteRoots configured).",
    );
    assert.equal(
      legacyStoragePaths.describeWriteNotePathParam(["/a", "/b"]),
      "Destination file under .harness/goals/, .harness/notes/, or these configured extraWriteRoots: /a, /b.",
    );
    assert.equal(
      legacyStoragePaths.describeDirectorNoteRootAlternative(),
      "Write under .harness/goals, .harness/notes, or a configured worktree.extraWriteRoots path. Code changes go through goal_create and goal_commit.",
    );
    assert.equal(
      legacyStoragePaths.describeDossierInvalidDirectoryReason(),
      "Dossiers are stored only in regular directories under .harness/artifacts to keep run artifacts confined.",
    );
    assert.equal(
      legacyStoragePaths.describeDossierSymlinkWhat("/repo/.harness/artifacts/x"),
      "Dossier must be a non-symlink path under .harness/artifacts: /repo/.harness/artifacts/x.",
    );
  });
});
