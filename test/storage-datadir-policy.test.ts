import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

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

describe("src/storage/paths (data-dir layout: taskGrants, directorNoteRoots, directorReadPolicy, protected/state predicates)", () => {
  it("computes taskGrants matrix across goal writable, goal read-only, non-goal, bucket, and custom dataDir outside stateDir", () => {
    const root = makeTempDir("pi-dd-grants-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const otherRepo = join(root, "other-repo");
    const extraRead = join(root, "extra-read");
    const extraWrite = join(root, "extra-write");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    mkdirSync(extraRead, { recursive: true });
    mkdirSync(extraWrite, { recursive: true });

    const sp = storagePaths(
      {
        stateDir,
        worktree: { extraReadRoots: [extraRead], extraWriteRoots: [extraWrite] },
      },
      { layout: "data-dir" },
    );
    const projDir = sp.projectDir(repo);
    const otherProjDir = sp.projectDir(otherRepo);

    const run = { repoRoot: repo, chatSessionId: "chat-1", id: "run-1" };
    const goal = { repoRoot: repo, chatSessionId: "chat-1", id: "goal-1" };

    // 1. Goal run writable
    const writableGoal = sp.taskGrants({ run, goal, writable: true });
    assert.deepEqual(writableGoal.extraReadRoots, [
      join(projDir, "chats", "chat-1", "goals"),
      join(projDir, "chats", "chat-1", "artifacts"),
      join(projDir, "chats", "chat-1", "notes"),
      join(projDir, "notes"),
      join(projDir, "chats", "legacy", "goals"),
      join(projDir, "chats", "legacy", "artifacts"),
      join(projDir, "chats", "legacy", "notes"),
      extraRead,
    ]);
    assert.deepEqual(writableGoal.extraWriteRoots, [
      join(projDir, "chats", "chat-1", "goals", "goal-1"),
      extraWrite,
    ]);
    assert.deepEqual(writableGoal.extraEnv, {
      HARNESS_GOAL_EVIDENCE_DIR: join(projDir, "chats", "chat-1", "goals", "goal-1"),
      HARNESS_GOAL_ID: "goal-1",
      HARNESS_GOALS_DIR: join(projDir, "chats", "chat-1", "goals"),
      HARNESS_ARTIFACTS_DIR: join(projDir, "chats", "chat-1", "artifacts"),
    });
    assert.deepEqual(writableGoal.deniedRoots, [stateDir]);
    assert.deepEqual(writableGoal.protectedRoots, []);

    // Other chats' dirs and other projects are NOT in the read or write roots (c4).
    const otherChatDir = join(projDir, "chats", "chat-2");
    assert.equal(writableGoal.extraReadRoots.some((r) => r.startsWith(otherChatDir)), false);
    assert.equal(writableGoal.extraReadRoots.some((r) => r.startsWith(otherProjDir)), false);

    // 2. Goal run read-only
    const readOnlyGoal = sp.taskGrants({ run, goal, writable: false });
    assert.equal(readOnlyGoal.extraWriteRoots, undefined);
    assert.deepEqual(readOnlyGoal.extraEnv, writableGoal.extraEnv);
    assert.deepEqual(readOnlyGoal.deniedRoots, [stateDir]);

    // 3. Non-goal run (no legacy goals dir -> only own chat goals dir + configured extraWriteRoots)
    const nonGoal = sp.taskGrants({ run: { repoRoot: repo, chatSessionId: "chat-1", id: "run-2" }, goal: null, writable: true });
    assert.equal(nonGoal.extraEnv, undefined);
    assert.deepEqual(nonGoal.extraWriteRoots, [join(projDir, "chats", "chat-1", "goals"), extraWrite]);

    // 4. Bucket run with existing in-repo legacy goals and artifacts dirs
    mkdirSync(join(repo, ".harness", "goals"), { recursive: true });
    mkdirSync(join(repo, ".harness", "artifacts"), { recursive: true });
    const bucketGrants = sp.taskGrants({
      run: { repoRoot: repo, chatSessionId: "chat-1", id: "director-tasks-chat-1" },
      goal: null,
      writable: true,
    });
    assert.ok(bucketGrants.extraReadRoots.includes(join(repo, ".harness", "goals")));
    assert.ok(bucketGrants.extraReadRoots.includes(join(repo, ".harness", "artifacts")));
    assert.deepEqual(bucketGrants.extraWriteRoots, [
      join(projDir, "chats", "chat-1", "goals"),
      join(repo, ".harness", "goals"),
      extraWrite,
    ]);

    // 5. Custom storage.dataDir outside stateDir adds both stateDir and dataRoot to deniedRoots.
    resetStoragePathsForTest();
    const customState = join(root, "state-custom");
    const customData = join(root, "external-data");
    mkdirSync(customState, { recursive: true });
    mkdirSync(customData, { recursive: true });
    const spCustom = storagePaths({ stateDir: customState, storage: { dataDir: customData } }, { layout: "data-dir" });
    const customGrants = spCustom.taskGrants({ run, goal: null, writable: false });
    assert.deepEqual(customGrants.deniedRoots, [customState, customData]);
    assert.deepEqual(customGrants.protectedRoots, []);
  });

  it("enforces directorNoteRoots and directorReadPolicy matrix (Addendum A6)", () => {
    const root = makeTempDir("pi-dd-dir-policy-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const otherRepo = join(root, "other-repo");
    const external = join(root, "external");
    const extraWrite = join(root, "extra-write");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(otherRepo, { recursive: true });
    mkdirSync(external, { recursive: true });
    mkdirSync(extraWrite, { recursive: true });

    const sp = storagePaths(
      {
        stateDir,
        worktree: { extraWriteRoots: [extraWrite] },
      },
      { layout: "data-dir" },
    );
    const dataRoot = sp.dataRoot!;
    const projDir = sp.projectDir(repo);
    const otherProjDir = sp.projectDir(otherRepo);

    // directorNoteRoots without legacy dirs
    assert.deepEqual(sp.directorNoteRoots({ repoRoot: repo, chatSessionId: "chat-3" }), {
      root: repo,
      allowedWriteRoots: [
        join(projDir, "chats", "chat-3", "goals"),
        join(projDir, "chats", "chat-3", "notes"),
        join(projDir, "notes"),
        extraWrite,
      ],
    });

    // directorNoteRoots includes real legacy goals/notes dirs while they exist, not symlinks.
    mkdirSync(join(repo, ".harness", "goals"), { recursive: true });
    symlinkSync(external, join(repo, ".harness", "notes"));
    assert.deepEqual(sp.directorNoteRoots({ repoRoot: repo, chatSessionId: "chat-3" }), {
      root: repo,
      allowedWriteRoots: [
        join(projDir, "chats", "chat-3", "goals"),
        join(projDir, "chats", "chat-3", "notes"),
        join(projDir, "notes"),
        join(repo, ".harness", "goals"),
        extraWrite,
      ],
    });
    rmSync(join(repo, ".harness", "notes"));
    mkdirSync(join(repo, ".harness", "notes"), { recursive: true });
    assert.ok(sp.directorNoteRoots({ repoRoot: repo, chatSessionId: "chat-3" }).allowedWriteRoots.includes(join(repo, ".harness", "notes")));

    // directorReadPolicy: allowed data-dir paths (own chat, other chat of project, project notes, another project's data).
    const allowedPaths = [
      join(projDir, "notes", "shared.md"),
      join(projDir, "chats", "chat-3", "goals", "goal-1", "ev.md"),
      join(projDir, "chats", "chat-3", "artifacts", "run-1", "t-1", "d.md"),
      join(projDir, "chats", "chat-3", "notes", "n.md"),
      join(projDir, "chats", "chat-9", "goals", "goal-2", "ev.md"),
      join(projDir, "chats", "legacy", "artifacts", "run-0", "t-1", "d.md"),
      join(otherProjDir, "notes", "other.md"),
      join(otherProjDir, "chats", "chat-1", "goals", "goal-9", "ev.md"),
      join(otherProjDir, "chats", "chat-1", "artifacts", "run-9", "t-1", "d.md"),
      join(otherProjDir, "chats", "chat-1", "notes", "n.md"),
      // Ordinary repo and host files
      repo,
      join(repo, "src", "index.ts"),
      join(repo, ".harness", "goals", "goal-1", "ev.md"),
      join(repo, ".harness", "notes", "n.md"),
      join(repo, ".harness", "artifacts", "run-1", "t-1", "d.md"),
      join(external, "readme.md"),
    ];
    for (const p of allowedPaths) {
      assert.deepEqual(sp.directorReadPolicy(repo, p), { ok: true }, `expected read allowed for ${p}`);
    }

    // directorReadPolicy: refused paths (worktrees, scratch, project.json, data root, state internals, .git, legacy worktrees).
    const refusedPaths = [
      dataRoot,
      join(dataRoot, "projects"),
      projDir,
      join(projDir, "project.json"),
      join(projDir, "chats", "chat-3"),
      join(projDir, "chats", "chat-3", "worktrees"),
      join(projDir, "chats", "chat-3", "worktrees", "run-1", "t-1", "src", "a.ts"),
      join(projDir, "scratch"),
      join(projDir, "scratch", "_verify", "v1", "src", "a.ts"),
      join(projDir, "scratch", "_integration", "i1", "src", "a.ts"),
      join(otherProjDir, "project.json"),
      join(otherProjDir, "chats", "chat-1", "worktrees", "run-1", "t-1", "a.ts"),
      stateDir,
      join(stateDir, "control-plane.sqlite"),
      join(stateDir, "config.json"),
      join(stateDir, "install", "current", "src", "cli.ts"),
      join(stateDir, "tools", "bin", "rg"),
      join(stateDir, "daemon.log"),
      join(repo, ".git", "HEAD"),
      join(repo, ".harness"),
      join(repo, ".harness", "worktrees", "run-1", "t-1", "src", "a.ts"),
      join(external, ".git", "config"),
      join(external, ".harness", "worktrees", "run-1", "t-1", "a.ts"),
      join(projDir, "chats", "chat-3", "notes", ".git", "HEAD"),
    ];
    for (const p of refusedPaths) {
      assert.equal(sp.directorReadPolicy(repo, p).ok, false, `expected read refused for ${p}`);
    }

    // Symlink inside an allowed notes dir pointing to control-plane.sqlite is refused.
    mkdirSync(join(projDir, "notes"), { recursive: true });
    const dbPath = join(stateDir, "control-plane.sqlite");
    writeFileSync(dbPath, "sqlite", "utf8");
    const evilLink = join(projDir, "notes", "escape.md");
    symlinkSync(dbPath, evilLink);
    assert.equal(sp.directorReadPolicy(repo, evilLink).ok, false);
  });

  it("enforces isProtectedWorktreePath (with ownWorkspace exemption) and isStateInternalPath on absolute roots", () => {
    const root = makeTempDir("pi-dd-prot-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const projDir = sp.projectDir(repo);
    const ownWt = sp.worktreePath({ repoRoot: repo, chatSessionId: "chat-1", id: "run-1" }, "t-1");
    const siblingWt = sp.worktreePath({ repoRoot: repo, chatSessionId: "chat-1", id: "run-1" }, "t-2");
    const otherChatWt = sp.worktreePath({ repoRoot: repo, chatSessionId: "chat-2", id: "run-2" }, "t-1");
    const scratchWt = sp.scratchPath(repo, "_verify", "v1");
    mkdirSync(ownWt, { recursive: true });
    mkdirSync(siblingWt, { recursive: true });

    // Without ownWorkspace: every data-dir worktree, scratch, legacy worktree, and .git is protected.
    assert.equal(sp.isProtectedWorktreePath(ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(ownWt, "src", "index.ts")), true);
    assert.equal(sp.isProtectedWorktreePath(scratchWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(scratchWt, "src", "index.ts")), true);
    assert.equal(sp.isProtectedWorktreePath(join(repo, ".harness", "worktrees", "run-1", "t-1", "a.ts")), true);
    assert.equal(sp.isProtectedWorktreePath(join(repo, ".git", "HEAD")), true);
    assert.equal(sp.isProtectedWorktreePath(join(projDir, "chats", "chat-1", "goals", "goal-1", "ev.md")), false);
    assert.equal(sp.isProtectedWorktreePath(join(projDir, "notes", "n.md")), false);

    // With ownWorkspace under data-dir: own worktree files allowed; sibling, other chat, scratch, .git, nested worktrees refused.
    assert.equal(sp.isProtectedWorktreePath(ownWt, ownWt), false);
    assert.equal(sp.isProtectedWorktreePath(join(ownWt, "src", "index.ts"), ownWt), false);
    assert.equal(sp.isProtectedWorktreePath(join(ownWt, ".git"), ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(ownWt, ".git", "HEAD"), ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(ownWt, ".harness", "worktrees", "nested", "a.ts"), ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(siblingWt, ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(siblingWt, "src", "a.ts"), ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(otherChatWt, "src", "a.ts"), ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(scratchWt, "src", "a.ts"), ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(repo, ".harness", "worktrees", "run-0", "t-0", "a.ts"), ownWt), true);
    assert.equal(sp.isProtectedWorktreePath(join(projDir, "chats", "chat-1", "goals", "goal-1", "ev.md"), ownWt), false);

    // Symlink inside ownWorkspace pointing to sibling worktree is refused.
    const wtEscape = join(ownWt, "escape.ts");
    writeFileSync(join(siblingWt, "secret.ts"), "secret", "utf8");
    symlinkSync(join(siblingWt, "secret.ts"), wtEscape);
    assert.equal(sp.isProtectedWorktreePath(wtEscape, ownWt), true);

    // isStateInternalPath: true for stateDir root and non-data internals; false strictly inside dataRoot or outside stateDir.
    assert.equal(sp.isStateInternalPath(stateDir), true);
    assert.equal(sp.isStateInternalPath(join(stateDir, "control-plane.sqlite")), true);
    assert.equal(sp.isStateInternalPath(join(stateDir, "config.json")), true);
    assert.equal(sp.isStateInternalPath(join(stateDir, "install", "current")), true);
    assert.equal(sp.isStateInternalPath(join(stateDir, "tools", "octofs")), true);
    assert.equal(sp.isStateInternalPath(join(stateDir, "daemon.log")), true);
    assert.equal(sp.isStateInternalPath(sp.dataRoot!), true);
    assert.equal(sp.isStateInternalPath(join(projDir, "chats", "chat-1", "goals", "goal-1")), false);
    assert.equal(sp.isStateInternalPath(join(repo, "src", "index.ts")), false);

    // Custom dataDir outside stateDir: stateDir/data is treated as internal because dataRoot is elsewhere.
    resetStoragePathsForTest();
    const externalData = join(root, "ext-data");
    mkdirSync(externalData, { recursive: true });
    const spExt = storagePaths({ stateDir, storage: { dataDir: externalData } }, { layout: "data-dir" });
    assert.equal(spExt.isStateInternalPath(join(stateDir, "data", "stale")), true);
    assert.equal(spExt.isStateInternalPath(join(externalData, "projects", "p", "notes", "a.md")), false);
  });
});
