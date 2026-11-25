import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { readWorkspaceArtifact } from "../src/control-plane/dossiers.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("re-review B2 storage path and fallback regressions (D8, D6)", () => {
  it("D8: resolves legacy worktree.dir literally against repoRoot (matching origin/main) and protects sibling checkouts", () => {
    const root = makeTempDir("pi-b2-d8-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });

    // origin/main:src/worktree/manager.ts derived baseDir as:
    //   resolve(canonicalPath(this.repoRoot), this.config.dir ?? ".harness/worktrees")
    // with no trimming and no leading '~' expansion in config.ts or manager.ts.
    const cases: Array<{ dir: string; expectedRoot: string; wrongRoot?: string }> = [
      {
        dir: "~/trees",
        expectedRoot: join(repo, "~", "trees"),
        wrongRoot: join(homedir(), "trees"),
      },
      {
        dir: " padded ",
        expectedRoot: join(repo, " padded "),
        wrongRoot: join(repo, "padded"),
      },
      {
        dir: "rel/trees",
        expectedRoot: join(repo, "rel", "trees"),
      },
    ];

    for (const { dir, expectedRoot, wrongRoot } of cases) {
      assert.equal(expectedRoot, resolve(repo, dir));
      if (wrongRoot !== undefined) {
        assert.notEqual(expectedRoot, wrongRoot);
      }

      const ownWt = join(expectedRoot, "run-1", "t-1");
      const siblingWt = join(expectedRoot, "run-1", "t-2");
      mkdirSync(join(ownWt, "src"), { recursive: true });
      mkdirSync(join(siblingWt, "src"), { recursive: true });
      writeFileSync(join(ownWt, "src", "a.ts"), "export const own = 1;\n", "utf8");
      writeFileSync(join(siblingWt, "src", "a.ts"), "export const sib = 2;\n", "utf8");

      const spLegacy = storagePaths({ stateDir, worktree: { dir } }, { layout: "legacy" });
      assert.deepEqual(spLegacy.managedWorktreeRoots(repo), [expectedRoot]);
      assert.equal(spLegacy.worktreePath({ repoRoot: repo, id: "run-1" }, "t-1"), ownWt);
      assert.equal(spLegacy.scratchPath(repo, "_verify", "v-1"), join(expectedRoot, "_verify", "v-1"));
      assert.equal(spLegacy.isProtectedWorktreePath(join(siblingWt, "src", "a.ts"), ownWt), true);
      assert.equal(spLegacy.isProtectedWorktreePath(join(ownWt, "src", "a.ts"), ownWt), false);
      assert.equal(spLegacy.directorReadPolicy(repo, join(siblingWt, "src", "a.ts")).ok, false);
      assert.equal(spLegacy.directorReadPolicy(repo, join(repo, "src", "index.ts")).ok, true);

      const spDataDir = storagePaths({ stateDir, worktree: { dir } }, { layout: "data-dir" });
      assert.equal(spDataDir.managedWorktreeRoots(repo).includes(expectedRoot), true);
      assert.equal(spDataDir.isProtectedWorktreePath(join(siblingWt, "src", "a.ts"), ownWt), true);
      assert.equal(spDataDir.isProtectedWorktreePath(join(ownWt, "src", "a.ts"), ownWt), false);
    }
  });

  it("D6: readWorkspaceArtifact allows a workspace inside stateDir to read its own files while refusing siblings and state files", () => {
    const root = makeTempDir("pi-b2-d6-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const customRoot = join(stateDir, "custom-trees");
    const wt1 = join(customRoot, "wt-1");
    const wt2 = join(customRoot, "wt-2");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(wt1, "src"), { recursive: true });
    mkdirSync(wt2, { recursive: true });

    const ownContent = "OWN_WORKSPACE_FILE_OK\n";
    writeFileSync(join(wt1, "src", "own.txt"), ownContent, "utf8");
    writeFileSync(join(wt2, "file"), "SIBLING_SECRET\n", "utf8");
    writeFileSync(join(stateDir, "config.json"), '{"secret":true}\n', "utf8");
    writeFileSync(join(stateDir, "control-plane.sqlite"), "SQLITE_SECRET\n", "utf8");
    symlinkSync(join(stateDir, "config.json"), join(wt1, "src", "link-config.json"));

    const sp = storagePaths({ stateDir, worktree: { dir: customRoot } }, { layout: "data-dir" });
    const grants = sp.taskGrants({
      run: { repoRoot: repo, chatSessionId: "chat-1", id: "run-1" },
      goal: null,
      writable: true,
      workspace: wt1,
    });
    const policy = {
      allowedRoots: [...grants.extraReadRoots, ...(grants.extraWriteRoots ?? [])],
      deniedRoots: grants.deniedRoots,
    };

    // Workspace at <stateDir>/custom-trees/wt-1 reads its own file (both default policy and taskGrants policy).
    const ownDefault = readWorkspaceArtifact(wt1, "src/own.txt", undefined, undefined, sp) as { content: string };
    assert.equal(ownDefault.content, ownContent);
    const ownWithPolicy = readWorkspaceArtifact(wt1, "src/own.txt", undefined, undefined, sp, policy) as { content: string };
    assert.equal(ownWithPolicy.content, ownContent);

    // Sibling checkout, state-dir config.json, control-plane.sqlite, and symlinks to them stay refused.
    const refusedTargets = [
      "../wt-2/file",
      join(wt2, "file"),
      "../../config.json",
      join(stateDir, "config.json"),
      "../../control-plane.sqlite",
      join(stateDir, "control-plane.sqlite"),
      "src/link-config.json",
    ];
    for (const target of refusedTargets) {
      assert.throws(
        () => readWorkspaceArtifact(wt1, target, undefined, undefined, sp),
        /artifact-outside-workspace/,
        `expected default policy refusal for ${target}`,
      );
      assert.throws(
        () => readWorkspaceArtifact(wt1, target, undefined, undefined, sp, policy),
        /artifact-outside-workspace/,
        `expected taskGrants policy refusal for ${target}`,
      );
    }

    // When the workspace is stateDir itself (not strictly more specific than stateDir), state files stay refused.
    assert.throws(
      () => readWorkspaceArtifact(stateDir, "config.json", undefined, undefined, sp),
      /artifact-outside-workspace/,
    );
    assert.throws(
      () => readWorkspaceArtifact(stateDir, "control-plane.sqlite", undefined, undefined, sp),
      /artifact-outside-workspace/,
    );
  });
});
