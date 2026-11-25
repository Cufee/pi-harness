import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import {
  enumerateLegacyUnits,
  hashFileSha256,
  hashFileSha256Sync,
  listLegacyUnknownEntries,
  listUnitFiles,
  resetStoragePathsForTest,
  resolveUnitFile,
  storagePaths,
  unitDataDirDestination,
} from "../src/storage/paths.js";

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

describe("src/storage/paths (data-dir layout: locations, units, union, resolveLegacyPath, pinning)", () => {
  it("resolves all new paths under <dataRoot>/projects/<key>/..., maps null/unsafe chats to chats/legacy, and writes project.json once", () => {
    const root = makeTempDir("pi-dd-loc-");
    const stateDir = join(root, "state");
    const repo = join(root, "demo-repo");
    const repoLink = join(root, "demo-repo-link");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    symlinkSync(repo, repoLink);

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const expectedHash = createHash("sha256").update(repo).digest("hex").slice(0, 12);
    const key = `${basename(repo)}-${expectedHash}`;
    const dataRoot = join(stateDir, "data");
    const projDir = join(dataRoot, "projects", key);

    assert.equal(sp.layout, "data-dir");
    assert.equal(sp.dataRoot, dataRoot);
    assert.equal(sp.projectKey(repo), key);
    assert.equal(sp.projectKey(repoLink), key);
    assert.equal(sp.projectDir(repo), projDir);
    assert.equal(sp.projectNotesDir(repo), join(projDir, "notes"));

    // Chat segment normalization: valid -> chat id; null/undefined/unsafe -> legacy.
    assert.equal(sp.chatDir({ repoRoot: repo, chatSessionId: "chat-4" }), join(projDir, "chats", "chat-4"));
    for (const fallbackChat of [null, undefined, "", ".", "..", "../escape", "a/b", "chat 1", "chat\0"]) {
      assert.equal(
        sp.chatDir({ repoRoot: repo, chatSessionId: fallbackChat }),
        join(projDir, "chats", "legacy"),
        `expected chats/legacy for ${JSON.stringify(fallbackChat)}`,
      );
    }

    const owner = { repoRoot: repo, chatSessionId: "chat-4" };
    const goal = { ...owner, id: "goal-9" };
    const run = { ...owner, id: "run-5" };
    assert.equal(sp.goalsDir(owner), join(projDir, "chats", "chat-4", "goals"));
    assert.equal(sp.goalEvidenceDir(goal), join(projDir, "chats", "chat-4", "goals", "goal-9"));
    assert.equal(sp.artifactsDir(owner), join(projDir, "chats", "chat-4", "artifacts"));
    assert.equal(sp.runArtifactsDir(run), join(projDir, "chats", "chat-4", "artifacts", "run-5"));
    assert.equal(sp.taskDossierDir(run, "t-1"), join(projDir, "chats", "chat-4", "artifacts", "run-5", "t-1"));
    assert.equal(sp.notesDir(owner), join(projDir, "chats", "chat-4", "notes"));
    assert.equal(sp.worktreePath(run, "t-1"), join(projDir, "chats", "chat-4", "worktrees", "run-5", "t-1"));
    assert.equal(sp.scratchPath(repo, "_verify", "v1"), join(projDir, "scratch", "_verify", "v1"));
    assert.equal(sp.scratchPath(repo, "_integration", "i1"), join(projDir, "scratch", "_integration", "i1"));

    // Flat spill dir for new run goes under chat artifacts dir, and creating it writes project.json once.
    const spillDir = sp.ensureDossierDir(run);
    assert.equal(spillDir, join(projDir, "chats", "chat-4", "artifacts"));
    const projectJsonPath = join(projDir, "project.json");
    assert.equal(existsSync(projectJsonPath), true);
    const firstJsonText = readFileSync(projectJsonPath, "utf8");
    const parsed = JSON.parse(firstJsonText);
    assert.equal(parsed.root, repo);
    assert.equal(parsed.key, key);
    assert.equal(typeof parsed.createdAt, "string");

    // Subsequent ensure calls never rewrite project.json.
    const createdGoalDir = sp.ensureGoalEvidenceDir(goal);
    assert.equal(createdGoalDir, join(projDir, "chats", "chat-4", "goals", "goal-9"));
    assert.equal(sp.ensureProjectDir(repoLink), projDir);
    assert.equal(readFileSync(projectJsonPath, "utf8"), firstJsonText);

    // Repo stays untouched.
    assert.equal(existsSync(join(repo, ".harness")), false);

    // Symlink / non-dir segment below dataRoot is refused by ensureGoalEvidenceDir and ensureDossierDir.
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(projDir, "chats", "chat-4", "goals", "goal-sym"));
    writeFileSync(join(projDir, "chats", "chat-4", "goals", "goal-file"), "x", "utf8");
    assert.equal(sp.ensureGoalEvidenceDir({ ...owner, id: "goal-sym" }), null);
    assert.equal(sp.ensureGoalEvidenceDir({ ...owner, id: "goal-file" }), null);

    symlinkSync(outside, join(projDir, "chats", "chat-4", "artifacts", "run-sym"));
    writeFileSync(join(projDir, "chats", "chat-4", "artifacts", "run-file"), "x", "utf8");
    assert.throws(() => sp.ensureDossierDir({ ...owner, id: "run-sym" }, "run-sym", "t-1"), /ENOTDIR/);
    assert.throws(() => sp.ensureDossierDir({ ...owner, id: "run-file" }, "run-file"), /ENOTDIR/);
    assert.throws(() => sp.ensureDossierDir(run, "..", "escape"), /ENOTDIR/);
  });

  it("enforces per-unit location rules: legacy goal units with A4 pinning in both directions, bucket runs, bridge symlinks, and existing chat lookup", () => {
    const root = makeTempDir("pi-dd-units-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const projDir = sp.projectDir(repo);

    // 1. Legacy goal dir exists -> A4 pinning in taskGrants creates legacy run dir; whole unit stays legacy.
    const legacyGoal1 = join(repo, ".harness", "goals", "goal-1");
    mkdirSync(legacyGoal1, { recursive: true });
    const goal1 = { repoRoot: repo, chatSessionId: "chat-1", id: "goal-1" };
    const run1 = { repoRoot: repo, chatSessionId: "chat-1", id: "run-1" };

    assert.equal(sp.goalEvidenceDir(goal1), legacyGoal1);
    const grants1 = sp.taskGrants({ run: run1, goal: goal1, writable: true });
    const legacyRun1 = join(repo, ".harness", "artifacts", "run-1");
    assert.equal(existsSync(legacyRun1), true, "A4 pinning must create legacy run dir when legacy goal dir exists");
    assert.equal(sp.runArtifactsDir(run1), legacyRun1);
    assert.equal(sp.taskDossierDir(run1, "t-9"), join(legacyRun1, "t-9"));
    assert.equal(sp.ensureDossierDir(run1, "run-1", "t-9"), join(legacyRun1, "t-9"));
    assert.equal(sp.ensureDossierDir(run1), join(repo, ".harness", "artifacts"));
    assert.deepEqual(grants1.extraEnv, {
      HARNESS_GOAL_EVIDENCE_DIR: legacyGoal1,
      HARNESS_GOAL_ID: "goal-1",
      HARNESS_GOALS_DIR: join(repo, ".harness", "goals"),
      HARNESS_ARTIFACTS_DIR: join(repo, ".harness", "artifacts"),
    });
    assert.ok(grants1.extraReadRoots.includes(join(repo, ".harness", "goals")));
    assert.ok(grants1.extraReadRoots.includes(join(repo, ".harness", "artifacts")));
    assert.deepEqual(grants1.extraWriteRoots, [legacyGoal1]);

    // 2. Reverse A4 pinning: legacy run dir exists, legacy goal dir does not -> taskGrants creates legacy goal dir.
    const legacyRun2 = join(repo, ".harness", "artifacts", "run-2");
    mkdirSync(legacyRun2, { recursive: true });
    const goal2 = { repoRoot: repo, chatSessionId: "chat-1", id: "goal-2" };
    const run2 = { repoRoot: repo, chatSessionId: "chat-1", id: "run-2" };

    const grants2 = sp.taskGrants({ run: run2, goal: goal2, writable: true });
    const legacyGoal2 = join(repo, ".harness", "goals", "goal-2");
    assert.equal(existsSync(legacyGoal2), true, "A4 pinning must create legacy goal dir when legacy run dir exists");
    assert.equal(sp.goalEvidenceDir(goal2), legacyGoal2);
    assert.equal(sp.ensureGoalEvidenceDir(goal2), legacyGoal2);
    assert.deepEqual(grants2.extraEnv, {
      HARNESS_GOAL_EVIDENCE_DIR: legacyGoal2,
      HARNESS_GOAL_ID: "goal-2",
      HARNESS_GOALS_DIR: join(repo, ".harness", "goals"),
      HARNESS_ARTIFACTS_DIR: join(repo, ".harness", "artifacts"),
    });

    // 3. Bucket run: task-level units. Old legacy task stays legacy; new task and flat spills land in data-dir.
    const bucketId = "director-tasks-chat-1";
    const legacyBucketTask = join(repo, ".harness", "artifacts", bucketId, "t-old");
    mkdirSync(legacyBucketTask, { recursive: true });
    const bucketRun = { repoRoot: repo, chatSessionId: "chat-1", id: bucketId };

    assert.equal(sp.taskDossierDir(bucketRun, "t-old"), legacyBucketTask);
    assert.equal(sp.ensureDossierDir(bucketRun, bucketId, "t-old"), legacyBucketTask);
    assert.equal(
      sp.taskDossierDir(bucketRun, "t-new"),
      join(projDir, "chats", "chat-1", "artifacts", bucketId, "t-new"),
    );
    assert.equal(
      sp.ensureDossierDir(bucketRun, bucketId, "t-new"),
      join(projDir, "chats", "chat-1", "artifacts", bucketId, "t-new"),
    );
    assert.equal(sp.ensureDossierDir(bucketRun), join(projDir, "chats", "chat-1", "artifacts"));

    // 4. Symlink bridge at legacy path counts as migrated (NOT legacy).
    const migratedGoalDest = join(projDir, "chats", "chat-2", "goals", "goal-mig");
    mkdirSync(migratedGoalDest, { recursive: true });
    symlinkSync(migratedGoalDest, join(repo, ".harness", "goals", "goal-mig"));
    assert.equal(
      sp.goalEvidenceDir({ repoRoot: repo, chatSessionId: "chat-2", id: "goal-mig" }),
      migratedGoalDest,
    );
    assert.equal(
      sp.ensureGoalEvidenceDir({ repoRoot: repo, chatSessionId: "chat-2", id: "goal-mig" }),
      migratedGoalDest,
    );

    const migratedRunDest = join(projDir, "chats", "chat-2", "artifacts", "run-mig");
    mkdirSync(migratedRunDest, { recursive: true });
    symlinkSync(migratedRunDest, join(repo, ".harness", "artifacts", "run-mig"));
    assert.equal(sp.runArtifactsDir({ repoRoot: repo, chatSessionId: "chat-2", id: "run-mig" }), migratedRunDest);

    // 5. Existing unit under chats/legacy or another chat is used where it is found.
    const inLegacyChat = join(projDir, "chats", "legacy", "goals", "goal-orphan");
    mkdirSync(inLegacyChat, { recursive: true });
    assert.equal(
      sp.goalEvidenceDir({ repoRoot: repo, chatSessionId: "chat-9", id: "goal-orphan" }),
      inLegacyChat,
    );

    const inOtherChat = join(projDir, "chats", "chat-3", "artifacts", "run-moved");
    mkdirSync(inOtherChat, { recursive: true });
    assert.equal(
      sp.runArtifactsDir({ repoRoot: repo, chatSessionId: "chat-9", id: "run-moved" }),
      inOtherChat,
    );
    assert.equal(
      sp.ensureDossierDir({ repoRoot: repo, chatSessionId: "chat-9", id: "run-moved" }, "run-moved", "t-1"),
      join(inOtherChat, "t-1"),
    );
  });

  it("applies the both-exist union rule: legacy wins on conflict, data-dir-only files stay visible, nothing deleted", () => {
    const root = makeTempDir("pi-dd-union-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const projDir = sp.projectDir(repo);

    // Run unit exists in both legacy and data-dir.
    const legacyRunDir = join(repo, ".harness", "artifacts", "run-7", "t-1");
    const dataRunDir = join(projDir, "chats", "chat-1", "artifacts", "run-7", "t-1");
    mkdirSync(legacyRunDir, { recursive: true });
    mkdirSync(dataRunDir, { recursive: true });
    writeFileSync(join(legacyRunDir, "shared.md"), "legacy-version", "utf8");
    writeFileSync(join(dataRunDir, "shared.md"), "datadir-version", "utf8");
    writeFileSync(join(legacyRunDir, "legacy-only.md"), "only-legacy", "utf8");
    writeFileSync(join(dataRunDir, "datadir-only.md"), "only-datadir", "utf8");

    // Writes go to legacy.
    assert.equal(sp.runArtifactsDir({ repoRoot: repo, chatSessionId: "chat-1", id: "run-7" }), join(repo, ".harness", "artifacts", "run-7"));

    // resolveUnitFile: legacy wins on conflict; data-dir-only visible.
    const unit = { kind: "run" as const, repoRoot: repo, id: "run-7", chatSessionId: "chat-1" };
    const sharedHit = resolveUnitFile(sp, unit, "t-1/shared.md");
    assert.deepEqual(sharedHit, {
      path: join(legacyRunDir, "shared.md"),
      source: "legacy",
      unitDir: join(repo, ".harness", "artifacts", "run-7"),
    });
    const dataOnlyHit = resolveUnitFile(sp, unit, "t-1/datadir-only.md");
    assert.deepEqual(dataOnlyHit, {
      path: join(dataRunDir, "datadir-only.md"),
      source: "data-dir",
      unitDir: join(projDir, "chats", "chat-1", "artifacts", "run-7"),
    });
    assert.equal(resolveUnitFile(sp, unit, "t-1/missing.md"), null);

    // listUnitFiles: full union with shadowedPaths recorded and nothing deleted or overwritten.
    const union = listUnitFiles(sp, unit);
    assert.deepEqual(
      union.map((u) => ({ relPath: u.relPath, source: u.source, path: u.path, shadowedPaths: u.shadowedPaths })),
      [
        {
          relPath: "t-1/datadir-only.md",
          source: "data-dir",
          path: join(dataRunDir, "datadir-only.md"),
          shadowedPaths: undefined,
        },
        {
          relPath: "t-1/legacy-only.md",
          source: "legacy",
          path: join(legacyRunDir, "legacy-only.md"),
          shadowedPaths: undefined,
        },
        {
          relPath: "t-1/shared.md",
          source: "legacy",
          path: join(legacyRunDir, "shared.md"),
          shadowedPaths: [join(dataRunDir, "shared.md")],
        },
      ],
    );
    assert.equal(readFileSync(join(legacyRunDir, "shared.md"), "utf8"), "legacy-version");
    assert.equal(readFileSync(join(dataRunDir, "shared.md"), "utf8"), "datadir-version");
  });

  it("maps legacy, symlinked-repo, already-current data-dir, notes, and missing-unit paths in resolveLegacyPath", () => {
    const root = makeTempDir("pi-dd-map-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const repoLink = join(root, "repo-link");
    const otherRepo = join(root, "other-repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    symlinkSync(repo, repoLink);

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const projDir = sp.projectDir(repo);
    const owner = { repoRoot: repo, chatSessionId: "chat-5" };

    // 1. Existing migrated units in data-dir (legacy paths removed or replaced by bridges).
    const migratedGoalDir = join(projDir, "chats", "chat-2", "goals", "goal-10");
    const migratedRunDir = join(projDir, "chats", "chat-2", "artifacts", "run-10");
    const migratedSpill = join(projDir, "chats", "chat-2", "artifacts", "t-1-summary-1.md");
    const migratedBucketTask = join(projDir, "chats", "chat-2", "artifacts", "director-tasks-chat-2", "t-5");
    mkdirSync(migratedGoalDir, { recursive: true });
    mkdirSync(join(migratedRunDir, "t-1"), { recursive: true });
    mkdirSync(migratedBucketTask, { recursive: true });
    writeFileSync(migratedSpill, "spill", "utf8");

    // Leave symlink bridges at legacy paths to confirm bridges do not fool resolveLegacyPath.
    mkdirSync(join(repo, ".harness", "goals"), { recursive: true });
    mkdirSync(join(repo, ".harness", "artifacts", "director-tasks-chat-2"), { recursive: true });
    symlinkSync(migratedGoalDir, join(repo, ".harness", "goals", "goal-10"));
    symlinkSync(migratedRunDir, join(repo, ".harness", "artifacts", "run-10"));
    symlinkSync(migratedSpill, join(repo, ".harness", "artifacts", "t-1-summary-1.md"));
    symlinkSync(migratedBucketTask, join(repo, ".harness", "artifacts", "director-tasks-chat-2", "t-5"));

    assert.equal(sp.resolveLegacyPath(repo, ".harness/goals/goal-10/ev.md"), join(migratedGoalDir, "ev.md"));
    assert.equal(sp.resolveLegacyPath(repo, `${repo}/.harness/goals/goal-10/ev.md`), join(migratedGoalDir, "ev.md"));
    assert.equal(sp.resolveLegacyPath(repo, `${repoLink}/.harness/goals/goal-10/ev.md`), join(migratedGoalDir, "ev.md"));
    assert.equal(sp.resolveLegacyPath(repoLink, `${repo}/.harness/artifacts/run-10/t-1/d.md`), join(migratedRunDir, "t-1", "d.md"));
    assert.equal(sp.resolveLegacyPath(repo, ".harness/artifacts/t-1-summary-1.md"), migratedSpill);
    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/artifacts/director-tasks-chat-2/t-5/d.md"),
      join(migratedBucketTask, "d.md"),
    );

    // 2. Notes: map to real legacy file while it exists, and to projectNotesDir after it is gone or bridged (for any owner).
    const legacyNote = join(repo, ".harness", "notes", "arch.md");
    mkdirSync(join(repo, ".harness", "notes"), { recursive: true });
    writeFileSync(legacyNote, "legacy note", "utf8");
    assert.equal(sp.resolveLegacyPath(repo, ".harness/notes/arch.md", owner), legacyNote);
    assert.equal(sp.resolveLegacyPath(repo, `${repoLink}/.harness/notes/arch.md`, owner), legacyNote);

    const migratedNote = join(sp.projectNotesDir(repo), "arch.md");
    mkdirSync(sp.projectNotesDir(repo), { recursive: true });
    writeFileSync(migratedNote, "migrated note", "utf8");
    rmSync(legacyNote);
    assert.equal(sp.resolveLegacyPath(repo, ".harness/notes/arch.md", owner), migratedNote);
    assert.equal(sp.resolveLegacyPath(repo, ".harness/notes/arch.md"), migratedNote);

    // Even with a bridge symlink at legacy note path, maps to projectNotesDir.
    symlinkSync(migratedNote, legacyNote);
    assert.equal(sp.resolveLegacyPath(repo, ".harness/notes/arch.md", owner), migratedNote);

    // 3. Missing unit with and without owner.
    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/goals/goal-new/ev.md", owner),
      join(projDir, "chats", "chat-5", "goals", "goal-new", "ev.md"),
    );
    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/goals/goal-new/ev.md"),
      join(projDir, "chats", "legacy", "goals", "goal-new", "ev.md"),
    );
    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/artifacts/run-new/t-1/d.md", owner),
      join(projDir, "chats", "chat-5", "artifacts", "run-new", "t-1", "d.md"),
    );
    assert.equal(
      sp.resolveLegacyPath(repo, ".harness/artifacts/run-new/t-1/d.md"),
      join(projDir, "chats", "legacy", "artifacts", "run-new", "t-1", "d.md"),
    );

    // 4. Already-current data-dir paths in this project's allowed data dirs return unchanged.
    const currentDataPaths = [
      join(projDir, "notes", "arch.md"),
      join(projDir, "chats", "chat-5", "goals", "goal-new", "ev.md"),
      join(projDir, "chats", "chat-5", "artifacts", "run-new", "t-1", "d.md"),
      join(projDir, "chats", "chat-5", "notes", "scratch.md"),
    ];
    for (const p of currentDataPaths) {
      assert.equal(sp.resolveLegacyPath(repo, p, owner), p);
    }

    // 5. Non-data paths return null.
    const otherProjDir = sp.projectDir(otherRepo);
    for (const nonData of [
      "",
      "   ",
      "~",
      "~/.pi-harness/config.json",
      ".harness",
      ".harness/worktrees/run-1/t-1/a.ts",
      ".harness/other/x.txt",
      ".harness/goals/../worktrees/run-1/t-1/a.ts",
      "src/index.ts",
      `${otherRepo}/.harness/goals/goal-1/a.md`,
      join(projDir, "project.json"),
      join(projDir, "chats", "chat-5", "worktrees", "run-1", "t-1", "a.ts"),
      join(projDir, "scratch", "_verify", "v1", "a.ts"),
      join(otherProjDir, "notes", "other.md"),
      join(stateDir, "control-plane.sqlite"),
      ".harness/notes/bad\0.md",
    ]) {
      assert.equal(sp.resolveLegacyPath(repo, nonData, owner), null, `expected null for ${JSON.stringify(nonData)}`);
    }
  });

  it("pins dataRoot per stateDir across distinct config objects until resetStoragePathsForTest()", () => {
    const root = makeTempDir("pi-dd-pin-");
    const stateDir = join(root, "state");
    const dataA = join(root, "custom-data-a");
    const dataB = join(root, "custom-data-b");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(dataA, { recursive: true });
    mkdirSync(dataB, { recursive: true });

    const spA = storagePaths({ stateDir, storage: { dataDir: dataA } }, { layout: "data-dir" });
    const spB = storagePaths({ stateDir, storage: { dataDir: dataB } }, { layout: "data-dir" });
    assert.equal(spA.dataRoot, dataA);
    assert.equal(spB.dataRoot, dataA);
    assert.equal(spB.projectDir(join(root, "repo")).startsWith(dataA), true);

    resetStoragePathsForTest();
    const spAfterReset = storagePaths({ stateDir, storage: { dataDir: dataB } }, { layout: "data-dir" });
    assert.equal(spAfterReset.dataRoot, dataB);
    assert.equal(spAfterReset.projectDir(join(root, "repo")).startsWith(dataB), true);
  });

  it("exports migration helpers: enumerateLegacyUnits, listLegacyUnknownEntries, unitDataDirDestination, and SHA-256 hashers", async () => {
    const root = makeTempDir("pi-dd-mig-helpers-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const projDir = sp.projectDir(repo);

    // Seed legacy units of every kind plus a bridge symlink and an unknown entry.
    mkdirSync(join(repo, ".harness", "goals", "goal-1"), { recursive: true });
    mkdirSync(join(repo, ".harness", "artifacts", "run-1", "t-1"), { recursive: true });
    mkdirSync(join(repo, ".harness", "artifacts", "director-tasks-chat-1", "t-2"), { recursive: true });
    mkdirSync(join(repo, ".harness", "notes", "sub"), { recursive: true });
    mkdirSync(join(repo, ".harness", "unknown-dir"), { recursive: true });
    writeFileSync(join(repo, ".harness", "artifacts", "t-1-summary-1.md"), "spill body", "utf8");
    writeFileSync(join(repo, ".harness", "notes", "top.md"), "top note", "utf8");
    writeFileSync(join(repo, ".harness", "notes", "sub", "nested.md"), "nested note", "utf8");

    const bridgedGoalDest = join(projDir, "chats", "chat-3", "goals", "goal-bridged");
    mkdirSync(bridgedGoalDest, { recursive: true });
    symlinkSync(bridgedGoalDest, join(repo, ".harness", "goals", "goal-bridged"));

    const units = enumerateLegacyUnits(sp, repo);
    assert.deepEqual(
      units.map((u) => ({ kind: u.kind, id: u.id, taskId: u.taskId, isBridge: u.isBridge })),
      [
        { kind: "goal", id: "goal-1", taskId: undefined, isBridge: false },
        { kind: "goal", id: "goal-bridged", taskId: undefined, isBridge: true },
        { kind: "bucket_task", id: "director-tasks-chat-1", taskId: "t-2", isBridge: false },
        { kind: "run", id: "run-1", taskId: undefined, isBridge: false },
        { kind: "flat_artifact", id: "t-1-summary-1.md", taskId: undefined, isBridge: false },
        { kind: "note", id: "sub/nested.md", taskId: undefined, isBridge: false },
        { kind: "note", id: "top.md", taskId: undefined, isBridge: false },
      ],
    );

    const goalUnit = units.find((u) => u.kind === "goal" && u.id === "goal-1")!;
    assert.equal(goalUnit.destinationFor({ repoRoot: repo, chatSessionId: "chat-7" }), join(projDir, "chats", "chat-7", "goals", "goal-1"));
    assert.equal(goalUnit.destinationFor(), join(projDir, "chats", "legacy", "goals", "goal-1"));

    const noteUnit = units.find((u) => u.kind === "note" && u.id === "sub/nested.md")!;
    assert.equal(noteUnit.destinationFor({ repoRoot: repo, chatSessionId: "chat-7" }), join(projDir, "notes", "sub", "nested.md"));

    const bucketUnit = units.find((u) => u.kind === "bucket_task")!;
    assert.equal(
      unitDataDirDestination(sp, { kind: "bucket_task", repoRoot: repo, id: "director-tasks-chat-1", taskId: "t-2", chatSessionId: "chat-1" }),
      bucketUnit.destinationFor({ repoRoot: repo, chatSessionId: "chat-1" }),
    );

    assert.deepEqual(listLegacyUnknownEntries(repo), [join(repo, ".harness", "unknown-dir")]);

    // Hash helpers (async and sync) agree and refuse symlinks.
    const sampleFile = join(repo, ".harness", "notes", "top.md");
    const expectedSha = createHash("sha256").update("top note").digest("hex");
    assert.deepEqual(await hashFileSha256(sampleFile), { sha256: expectedSha, bytes: 8 });
    assert.deepEqual(hashFileSha256Sync(sampleFile), { sha256: expectedSha, bytes: 8 });

    const linkFile = join(root, "note-link.md");
    symlinkSync(sampleFile, linkFile);
    assert.equal(await hashFileSha256(linkFile), null);
    assert.equal(hashFileSha256Sync(linkFile), null);
    assert.equal(await hashFileSha256(join(root, "does-not-exist.md")), null);
    assert.equal(hashFileSha256Sync(join(root, "does-not-exist.md")), null);
  });
});
