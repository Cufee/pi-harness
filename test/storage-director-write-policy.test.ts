import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const tempDirs: string[] = [];
const ORIGINAL_LAYOUT = process.env.PI_HARNESS_STORAGE_LAYOUT;

function setLayoutEnv(layout: "legacy" | "data-dir" | undefined): void {
  if (layout === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = layout;
  resetStoragePathsForTest();
}

afterEach(() => {
  setLayoutEnv(ORIGINAL_LAYOUT as "legacy" | "data-dir" | undefined);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function makeTempGitRepo(parent: string, name = "repo"): Promise<string> {
  const repoRoot = join(parent, name);
  await runGit(parent, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return repoRoot;
}

function makeConfig(
  repoRoot: string,
  stateDir: string,
  extraWriteRoots: string[] = [],
): HarnessConfig {
  const base = loadConfig(repoRoot);
  return withFixtureCatalog({
    ...base,
    stateDir,
    socketPath: join(stateDir, "d.sock"),
    storage: { dataDir: join(stateDir, "data") },
    codeMode: "off",
    worktree: {
      ...base.worktree,
      extraWriteRoots,
    },
  });
}

describe("Director write_note policy and project metadata (data-dir layout)", () => {
  it("W1: authorizes write_note via directorWritePolicy under an ancestor extraWriteRoot and refuses other chats' dirs and legacy goals", async () => {
    setLayoutEnv("data-dir");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-dir-w1-")));
    tempDirs.push(root);
    const repoRoot = await makeTempGitRepo(root, "repo");
    const otherRepoRoot = await makeTempGitRepo(root, "other-repo");
    const stateDir = join(root, "state");
    const externalDocs = join(root, "docs");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(externalDocs, { recursive: true });
    writeFileSync(join(stateDir, "config.json"), "{}\n", "utf8");

    // Configure an ancestor root covering stateDir, dataRoot, repoRoot, otherRepoRoot, and externalDocs (like $HOME).
    const config = makeConfig(repoRoot, stateDir, [root]);
    const sp = storagePaths(config, { layout: "data-dir" });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async () => ({ stopReason: "completed", text: "ok" }),
      }),
    });

    try {
      const chat1 = await daemon.director.createChat({ repoRoot });
      const chat2 = await daemon.director.createChat({ repoRoot });
      const owner1 = { repoRoot, chatSessionId: chat1.id };

      // Create one live legacy goal owned by chat1 and one owned by chat2, plus an existing legacy note file.
      const ownGoal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat1.id,
        title: "Chat 1 legacy goal",
        description: "Owned by chat1",
        criteria: [{ id: "c1", kind: "behavioral", description: "Works", required: true }],
      });
      const otherGoal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat2.id,
        title: "Chat 2 legacy goal",
        description: "Owned by chat2",
        criteria: [{ id: "c1", kind: "behavioral", description: "Works", required: true }],
      });
      const ownLegacyGoalDir = join(repoRoot, ".harness", "goals", ownGoal.id);
      const otherLegacyGoalDir = join(repoRoot, ".harness", "goals", otherGoal.id);
      const existingLegacyNote = join(repoRoot, ".harness", "notes", "existing.md");
      mkdirSync(ownLegacyGoalDir, { recursive: true });
      mkdirSync(otherLegacyGoalDir, { recursive: true });
      mkdirSync(dirname(existingLegacyNote), { recursive: true });
      writeFileSync(existingLegacyNote, "legacy v1\n", "utf8");

      // Populate another chat's artifact/notes/goals and another project's notes in data-dir.
      const chat2Artifact = join(sp.artifactsDir({ repoRoot, chatSessionId: chat2.id }), "run-2", "t-1", "dossier.md");
      const chat2Note = join(sp.notesDir({ repoRoot, chatSessionId: chat2.id }), "private.md");
      const chat2GoalEv = join(sp.goalsDir({ repoRoot, chatSessionId: chat2.id }), "goal-x", "ev.md");
      const chat1Artifact = join(sp.artifactsDir(owner1), "run-1", "t-1", "dossier.md");
      const otherProjectNote = join(sp.projectNotesDir(otherRepoRoot), "other.md");
      for (const f of [chat2Artifact, chat2Note, chat2GoalEv, chat1Artifact, otherProjectNote]) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, "original\n", "utf8");
      }

      // Confirm A6 read_file still reads another chat's artifact.
      const readRes = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
        path: chat2Artifact,
      })) as { content: string };
      assert.equal(readRes.content, "original\n");

      const expectedOwnNotes = sp.notesDir(owner1);
      const expectedOwnGoals = sp.goalsDir(owner1);
      const expectedProjNotes = sp.projectNotesDir(repoRoot);

      // Refused targets: all must fail with director-note-root naming the allowed write roots.
      const refusedTargets = [
        chat2Artifact,
        chat2Note,
        chat2GoalEv,
        chat1Artifact,
        otherProjectNote,
        join(otherLegacyGoalDir, "tamper.md"),
        `.harness/goals/${otherGoal.id}/tamper.md`,
        join(stateDir, "config.json"),
      ];
      for (const target of refusedTargets) {
        await assert.rejects(
          () =>
            daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
              path: target,
              content: "overwritten\n",
              reason: "Attempt unauthorized write",
            }),
          (err: Error) => {
            assert.match(err.message, /^\[harness blocked: director-note-root\] /);
            assert.ok(err.message.includes(expectedOwnNotes), `missing own notes root in: ${err.message}`);
            assert.ok(err.message.includes(expectedOwnGoals), `missing own goals root in: ${err.message}`);
            assert.ok(err.message.includes(expectedProjNotes), `missing project notes root in: ${err.message}`);
            return true;
          },
          `write_note must refuse ${target}`,
        );
      }
      assert.equal(readFileSync(chat2Artifact, "utf8"), "original\n");
      assert.equal(readFileSync(chat2Note, "utf8"), "original\n");
      assert.equal(existsSync(join(otherLegacyGoalDir, "tamper.md")), false);

      // Symlink inside own notes pointing into chat2 is refused.
      mkdirSync(expectedOwnNotes, { recursive: true });
      const escapeLink = join(expectedOwnNotes, "escape.md");
      symlinkSync(chat2Note, escapeLink);
      await assert.rejects(
        () =>
          daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
            path: escapeLink,
            content: "pwn\n",
            reason: "Symlink escape",
          }),
        (err: Error) => {
          assert.match(err.message, /^\[harness blocked: director-note-root\] /);
          assert.ok(err.message.includes(expectedOwnNotes), err.message);
          return true;
        },
      );
      assert.equal(readFileSync(chat2Note, "utf8"), "original\n");

      // Allowed targets: own chat notes/goals, project notes, own live legacy goal, existing legacy note, external extraWriteRoot.
      const allowedCases = [
        { input: join(expectedOwnNotes, "chat1.md"), disk: join(expectedOwnNotes, "chat1.md"), body: "own note\n" },
        { input: join(expectedOwnGoals, "goal-new", "ev.md"), disk: join(expectedOwnGoals, "goal-new", "ev.md"), body: "own goal\n" },
        { input: join(expectedProjNotes, "shared.md"), disk: join(expectedProjNotes, "shared.md"), body: "project note\n" },
        { input: `.harness/goals/${ownGoal.id}/ev.md`, disk: join(ownLegacyGoalDir, "ev.md"), body: "own legacy goal\n" },
        { input: ".harness/notes/existing.md", disk: existingLegacyNote, body: "legacy v2\n" },
        { input: join(externalDocs, "report.md"), disk: join(externalDocs, "report.md"), body: "external doc\n" },
      ];
      for (const c of allowedCases) {
        const res = (await daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
          path: c.input,
          content: c.body,
          reason: "Allowed write",
        })) as { written: boolean; path: string };
        assert.equal(res.written, true, `expected allowed write for ${c.input}`);
        assert.equal(readFileSync(c.disk, "utf8"), c.body);
      }
    } finally {
      await daemon.stop();
    }
  });

  it("W4: first write_note in a notes-only project creates project.json via ensureProjectDir and rejects symlink parent components", async () => {
    setLayoutEnv("data-dir");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-dir-w4-")));
    tempDirs.push(root);
    const repoA = await makeTempGitRepo(root, "repo-a");
    const repoB = await makeTempGitRepo(root, "repo-b");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const config = makeConfig(repoA, stateDir);
    const sp = storagePaths(config, { layout: "data-dir" });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async () => ({ stopReason: "completed", text: "ok" }),
      }),
    });

    try {
      // Project A: first operation is a legacy-mapped project note write (no goals, runs, worktrees, or dossiers).
      const chatA = await daemon.director.createChat({ repoRoot: repoA });
      const projDirA = sp.projectDir(repoA);
      const projJsonA = join(projDirA, "project.json");
      assert.equal(existsSync(projDirA), false);

      const resA = (await daemon.director.executeDirectorMcpTool(chatA.id, "write_note", {
        path: ".harness/notes/first.md",
        content: "hello project A\n",
        reason: "First note in notes-only project",
      })) as { written: boolean; path: string };
      assert.equal(resA.written, true);
      assert.equal(resA.path, join(sp.projectNotesDir(repoA), "first.md"));
      assert.equal(existsSync(projJsonA), true, "first write_note must create project.json");
      const metaA = JSON.parse(readFileSync(projJsonA, "utf8")) as { root: string; key: string };
      assert.equal(metaA.root, repoA);
      assert.equal(metaA.key, sp.projectKey(repoA));

      // Symlinked subdirectory inside notes/ (even pointing within the same root) is refused by symlink-safe component checks.
      const realSub = join(sp.projectNotesDir(repoA), "real-sub");
      const linkSub = join(sp.projectNotesDir(repoA), "link-sub");
      mkdirSync(realSub, { recursive: true });
      symlinkSync(realSub, linkSub);
      await assert.rejects(
        () =>
          daemon.director.executeDirectorMcpTool(chatA.id, "write_note", {
            path: join(linkSub, "nested.md"),
            content: "should not write through symlink parent\n",
            reason: "Symlink parent check",
          }),
        /\[harness blocked: director-note-root\] /,
      );
      assert.equal(existsSync(join(realSub, "nested.md")), false);

      // Project B: first operation is a chat-scoped note write.
      const chatB = await daemon.director.createChat({ repoRoot: repoB });
      const projDirB = sp.projectDir(repoB);
      const projJsonB = join(projDirB, "project.json");
      assert.equal(existsSync(projDirB), false);

      const chatBNote = join(sp.notesDir({ repoRoot: repoB, chatSessionId: chatB.id }), "session.md");
      const resB = (await daemon.director.executeDirectorMcpTool(chatB.id, "write_note", {
        path: chatBNote,
        content: "hello project B\n",
        reason: "First chat note in notes-only project",
      })) as { written: boolean; path: string };
      assert.equal(resB.written, true);
      assert.equal(existsSync(projJsonB), true, "first chat write_note must create project.json");
      const metaB = JSON.parse(readFileSync(projJsonB, "utf8")) as { root: string; key: string };
      assert.equal(metaB.root, repoB);
      assert.equal(metaB.key, sp.projectKey(repoB));
    } finally {
      await daemon.stop();
    }
  });
});
