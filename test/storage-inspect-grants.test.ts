import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { sandboxAvailable } from "../src/code-mode/sandbox.js";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { writeTaskDossier } from "../src/control-plane/dossiers.js";
import { SUMMARY_LIMIT } from "../src/control-plane/handoffs.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { GoalEngine } from "../src/goals/engine.js";
import { DENIED_HARNESS_STATE_REASON } from "../src/runners/acp-shims.js";
import { legacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit, WorktreeManager } from "../src/worktree/manager.js";

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "app.ts"), "export const answer = 42;\n", "utf8");
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return { root, repoRoot };
}

function makeHooks(
  wtMgr: WorktreeManager,
  opts?: {
    signal?: AbortSignal;
    resolveLinkedGoalForRun?: ToolRuntimeHooks["resolveLinkedGoalForRun"];
  },
): ToolRuntimeHooks {
  return {
    spawnAndStartTask: async () => {
      throw new Error("unused");
    },
    waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
    steerTask: async () => false,
    cancelTask: async () => {},
    scheduleRollover: async () => {},
    getWorktreeManager: () => wtMgr,
    getMergeQueue: () => {
      throw new Error("unused");
    },
    getTaskSignal: () => opts?.signal,
    ...(opts?.resolveLinkedGoalForRun ? { resolveLinkedGoalForRun: opts.resolveLinkedGoalForRun } : {}),
  };
}

function makeExecutor(
  db: ControlPlaneDb,
  wtMgr: WorktreeManager,
  config: HarnessConfig,
  opts?: {
    signal?: AbortSignal;
    resolveLinkedGoalForRun?: ToolRuntimeHooks["resolveLinkedGoalForRun"];
  },
): ControlPlaneToolExecutor {
  return new ControlPlaneToolExecutor(
    db,
    () => {
      throw new Error("unused");
    },
    makeHooks(wtMgr, opts),
    config,
  );
}

describe("ControlPlaneToolExecutor storage grants and legacy path mapping", () => {
  it("legacy layout: read-only worktree task reads granted goals/artifacts via inspect_command, refuses outside/.git/sibling worktree, and supports legacy relative artifact_read", async () => {
    const { root, repoRoot } = await initTempGitRepo("pi-tools-grants-legacy-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    const outsideFile = join(root, "outside-secret.txt");
    writeFileSync(outsideFile, "OUTSIDE SECRET\n", "utf8");

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = {
      ...base,
      stateDir,
      codeMode: "off",
      worktree: {
        ...base.worktree,
        // Ignored in legacy layout (fixed legacy path only).
        artifactsDir: ".ignored-custom-artifacts",
        extraReadRoots: [],
        extraWriteRoots: [],
      },
    };

    const db = new ControlPlaneDb(":memory:");
    const sp = storagePaths(config);
    const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
      const chatSessionId = "chat-legacy-1";
      const goal = goals.createGoal({
        chatSessionId,
        repoRoot,
        title: "Legacy inspect grants",
        description: "Verify legacy inspect_command grants.",
        criteria: [{ id: "c1", description: "Reads granted dirs", kind: "behavioral", required: true }],
      });
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const run = db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha, chatSessionId });
      goals.linkRunAndStart(goal.id, run.id);

      // Worker owning the worktree, plus a read-only Tier 3 task sharing that worktree, plus a sibling worktree.
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Work",
        profileId: "pi:local",
      });
      const wt = await wtMgr.createForWorker(run.id, worker.id);

      const sibling = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Sibling",
        objective: "Sibling work",
        profileId: "pi:local",
      });
      const siblingWt = await wtMgr.createForWorker(run.id, sibling.id);
      const siblingFile = join(siblingWt.path, "sibling-only.txt");
      writeFileSync(siblingFile, "SIBLING DATA\n", "utf8");

      const reader = db.createTask({
        runId: run.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Read-only worktree scout",
        objective: "Inspect granted dirs",
        profileId: "pi:local",
        readOnly: true,
      });
      db.updateTask(reader.id, { worktreeId: wt.id });

      // Populate files in granted goals dir and artifacts dir.
      const goalEvDir = sp.ensureGoalEvidenceDir({ repoRoot, id: goal.id, chatSessionId })!;
      const goalEvidenceFile = join(goalEvDir, "evidence.md");
      writeFileSync(goalEvidenceFile, "goal evidence body\n", "utf8");

      const dossier = writeTaskDossier(db, run, worker.id, "findings.md", "artifact findings body\n", "Findings", sp);
      const exec = makeExecutor(db, wtMgr, config);

      // 1. Read-only task in a worktree can inspect_command 'cat' in granted goals dir and artifacts dir.
      const goalCat = (await exec.execute(run.id, reader.id, "inspect_command", {
        argv: ["cat", goalEvidenceFile],
      })) as { exit_code: number; stdout: string };
      assert.equal(goalCat.exit_code, 0);
      assert.equal(goalCat.stdout, "goal evidence body\n");

      const artCat = (await exec.execute(run.id, reader.id, "inspect_command", {
        argv: ["cat", dossier.path],
      })) as { exit_code: number; stdout: string };
      assert.equal(artCat.exit_code, 0);
      assert.equal(artCat.stdout, "artifact findings body\n");

      // 2. Path outside all roots is still refused.
      await assert.rejects(
        () => exec.execute(run.id, reader.id, "inspect_command", { argv: ["cat", outsideFile] }),
        /read-only-argv/,
      );

      // 3. .git and sibling worktree paths are still refused (both operand and cwd).
      await assert.rejects(
        () => exec.execute(run.id, reader.id, "inspect_command", { argv: ["cat", join(wt.path, ".git")] }),
        /read-only-argv/,
      );
      await assert.rejects(
        () => exec.execute(run.id, reader.id, "inspect_command", { argv: ["cat", join(repoRoot, ".git", "HEAD")] }),
        /read-only-argv/,
      );
      await assert.rejects(
        () => exec.execute(run.id, reader.id, "inspect_command", { argv: ["cat", siblingFile] }),
        /read-only-argv/,
      );
      await assert.rejects(
        () => exec.execute(run.id, reader.id, "inspect_command", { argv: ["ls"], cwd: ".git" }),
        /inspect-cwd/,
      );

      // 4. artifact_read by workspace-relative legacy path still works, and normal workspace file read works.
      const legacyRel = `.harness/artifacts/${run.id}/${worker.id}/findings.md`;
      const dossierRead = (await exec.execute(run.id, reader.id, "artifact_read", {
        path: legacyRel,
      })) as { path: string; content: string };
      assert.equal(dossierRead.content, "artifact findings body\n");

      const wsRead = (await exec.execute(run.id, reader.id, "artifact_read", {
        path: "src/app.ts",
      })) as { content: string };
      assert.equal(wsRead.content, "export const answer = 42;\n");

      // 5. Ignored repo-configurable artifactsDir is never granted to inspect_command.
      const customArtDir = join(repoRoot, ".ignored-custom-artifacts");
      mkdirSync(customArtDir, { recursive: true });
      const customArtFile = join(customArtDir, "nope.txt");
      writeFileSync(customArtFile, "SHOULD NOT READ\n", "utf8");
      await assert.rejects(
        () => exec.execute(run.id, reader.id, "inspect_command", { argv: ["cat", customArtFile] }),
        /read-only-argv/,
      );
    } finally {
      db.close();
    }
  });

  it("data-dir layout: enforces deniedRoots with ~ in extraReadRoots, isolates other chats, maps legacy paths in artifact_read and inspect_command, and routes writes to data-dir", async () => {
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    const { root, repoRoot } = await initTempGitRepo("pi-tools-grants-datadir-");
    // Place stateDir inside the isolated test HOME so '~' in worktree.extraReadRoots strictly covers stateDir.
    const testHome = realpathSync(homedir());
    const stateDir = realpathSync(mkdtempSync(join(testHome, "pi-tools-state-")));
    tempDirs.push(stateDir);

    // Put a real file directly in testHome (outside stateDir) to prove '~' really is admitted as an extraReadRoot.
    const homeProbeFile = join(testHome, `home-probe-${Date.now()}.txt`);
    writeFileSync(homeProbeFile, "home probe ok\n", "utf8");
    tempDirs.push(homeProbeFile);

    // Real state-dir internal files that must be refused even with '~' in extraReadRoots.
    const dbFile = join(stateDir, "control-plane.sqlite");
    const configFile = join(stateDir, "config.json");
    writeFileSync(dbFile, "SQLITE SECRET\n", "utf8");
    writeFileSync(configFile, '{"secret":true}\n', "utf8");

    const outsideFile = join(root, "outside-secret.txt");
    writeFileSync(outsideFile, "OUTSIDE SECRET\n", "utf8");
    const extraWriteDir = join(root, "extra-write");
    mkdirSync(extraWriteDir, { recursive: true });
    const extraWriteFile = join(extraWriteDir, "writable-note.txt");
    writeFileSync(extraWriteFile, "extra write root ok\n", "utf8");

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = {
      ...base,
      stateDir,
      codeMode: "hybrid",
      codeExec: { ...base.codeExec, maxOutputChars: 80 },
      worktree: {
        ...base.worktree,
        artifactsDir: ".ignored-custom-artifacts",
        extraReadRoots: ["~"],
        extraWriteRoots: [extraWriteDir],
      },
    };

    const db = new ControlPlaneDb(":memory:");
    const sp = storagePaths(config);
    assert.equal(sp.layout, "data-dir");
    const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
      const chatA = "chat-a";
      const chatB = "chat-b";

      const goalA = goals.createGoal({
        chatSessionId: chatA,
        repoRoot,
        title: "Chat A goal",
        description: "Test data-dir grants for chat A.",
        criteria: [{ id: "c1", description: "Isolated grants", kind: "behavioral", required: true }],
      });
      const goalB = goals.createGoal({
        chatSessionId: chatB,
        repoRoot,
        title: "Chat B goal",
        description: "Other chat goal that chat A must not read.",
        criteria: [{ id: "c1", description: "Secret", kind: "behavioral", required: true }],
      });

      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const runA = db.createRun({ goal: goalA.title, repoRoot, baseBranch: "main", baseSha, chatSessionId: chatA });
      goals.linkRunAndStart(goalA.id, runA.id);

      const worker = db.createTask({
        runId: runA.id,
        tier: 2,
        kind: "worker",
        title: "Worker A",
        objective: "Work in data-dir worktree",
        profileId: "pi:local",
      });
      const wt = await wtMgr.createForWorker(runA.id, worker.id);

      const sibling = db.createTask({
        runId: runA.id,
        tier: 2,
        kind: "worker",
        title: "Sibling A",
        objective: "Sibling worktree",
        profileId: "pi:local",
      });
      const siblingWt = await wtMgr.createForWorker(runA.id, sibling.id);
      const siblingFile = join(siblingWt.path, "sibling-only.txt");
      writeFileSync(siblingFile, "SIBLING DATA\n", "utf8");

      const reader = db.createTask({
        runId: runA.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Read-only scout A",
        objective: "Inspect granted dirs in data-dir",
        profileId: "pi:local",
        readOnly: true,
      });
      db.updateTask(reader.id, { status: "running", worktreeId: wt.id });

      // Own chat's goal evidence and artifact files (under data-dir).
      const goalAEvDir = sp.ensureGoalEvidenceDir({ repoRoot, id: goalA.id, chatSessionId: chatA })!;
      const goalAFile = join(goalAEvDir, "evidence-a.md");
      writeFileSync(goalAFile, "chat A evidence\n", "utf8");

      const dossierA = writeTaskDossier(db, runA, worker.id, "report-a.md", "chat A artifact\n", "Report A", sp);
      assert.ok(dossierA.path.startsWith(sp.dataRoot!));

      // Other chat's goal evidence dir (must be refused).
      const goalBEvDir = sp.ensureGoalEvidenceDir({ repoRoot, id: goalB.id, chatSessionId: chatB })!;
      const goalBFile = join(goalBEvDir, "secret-b.md");
      writeFileSync(goalBFile, "chat B secret\n", "utf8");

      const ac = new AbortController();
      const exec = makeExecutor(db, wtMgr, config, { signal: ac.signal });

      // 1. Granted own-chat goals dir, artifacts dir, and '~' outside stateDir are readable via inspect_command.
      const goalACat = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", goalAFile],
      })) as { exit_code: number; stdout: string };
      assert.equal(goalACat.exit_code, 0);
      assert.equal(goalACat.stdout, "chat A evidence\n");

      const artACat = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", dossierA.path],
      })) as { exit_code: number; stdout: string };
      assert.equal(artACat.exit_code, 0);
      assert.equal(artACat.stdout, "chat A artifact\n");

      const homeCat = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", homeProbeFile],
      })) as { exit_code: number; stdout: string };
      assert.equal(homeCat.exit_code, 0);
      assert.equal(homeCat.stdout, "home probe ok\n");

      // 2. Absolute legacy data path operand maps through resolveLegacyPath to the data-dir file.
      const legacyGoalAPath = join(repoRoot, ".harness", "goals", goalA.id, "evidence-a.md");
      const legacyGoalACat = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", legacyGoalAPath],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(legacyGoalACat.exit_code, 0);
      assert.equal(legacyGoalACat.stdout, "chat A evidence\n");
      assert.equal(legacyGoalACat.argv[1], goalAFile);

      // 3. State dir root, control-plane.sqlite, and config.json are refused even with '~' in extraReadRoots.
      for (const forbidden of [stateDir, dbFile, configFile]) {
        await assert.rejects(
          () => exec.execute(runA.id, reader.id, "inspect_command", { argv: ["cat", forbidden] }),
          (err: Error) => {
            assert.match(err.message, /read-only-argv/);
            assert.ok(err.message.includes(DENIED_HARNESS_STATE_REASON), `expected denied-state reason, got: ${err.message}`);
            return true;
          },
        );
      }

      // 4. Another chat's goals dir is refused (both direct data-dir path and mapped legacy path).
      for (const otherChatPath of [goalBFile, join(repoRoot, ".harness", "goals", goalB.id, "secret-b.md")]) {
        await assert.rejects(
          () => exec.execute(runA.id, reader.id, "inspect_command", { argv: ["cat", otherChatPath] }),
          (err: Error) => {
            assert.match(err.message, /read-only-argv/);
            assert.ok(err.message.includes(DENIED_HARNESS_STATE_REASON), `expected denied-state reason, got: ${err.message}`);
            return true;
          },
        );
      }

      // 5. Outside path, .git, and sibling worktree paths are refused.
      await assert.rejects(
        () => exec.execute(runA.id, reader.id, "inspect_command", { argv: ["cat", outsideFile] }),
        /read-only-argv/,
      );
      await assert.rejects(
        () => exec.execute(runA.id, reader.id, "inspect_command", { argv: ["cat", join(wt.path, ".git")] }),
        /read-only-argv/,
      );
      await assert.rejects(
        () => exec.execute(runA.id, reader.id, "inspect_command", { argv: ["cat", siblingFile] }),
        (err: Error) => {
          assert.match(err.message, /read-only-argv/);
          assert.ok(err.message.includes(DENIED_HARNESS_STATE_REASON), `expected denied-state reason, got: ${err.message}`);
          return true;
        },
      );

      // 6. Simulated migration: create a legacy unit dir + DB row, rename it to data-dir, rewrite artifacts.path,
      //    and verify artifact_read of the old workspace-relative legacy path returns the migrated file.
      const migratedRun = db.createRun({
        goal: "Migrated run",
        repoRoot,
        baseBranch: "main",
        baseSha,
        chatSessionId: chatA,
      });
      const migratedTask = db.createTask({
        runId: migratedRun.id,
        tier: 3,
        kind: "research",
        title: "Migrated reader",
        objective: "Verify migrated artifact_read and inspect_command",
        profileId: "pi:local",
        readOnly: true,
      });
      db.updateTask(migratedTask.id, { status: "running", worktreeId: wt.id });

      const legacyArt = writeTaskDossier(
        db,
        migratedRun,
        migratedTask.id,
        "migrated.md",
        "migrated dossier payload\n",
        "Migrated dossier",
        legacyStoragePaths,
      );
      const legacyRunDir = join(repoRoot, ".harness", "artifacts", migratedRun.id);
      const dataRunDir = join(sp.artifactsDir(migratedRun), migratedRun.id);
      mkdirSync(dirname(dataRunDir), { recursive: true });
      renameSync(legacyRunDir, dataRunDir);
      const migratedAbsPath = join(dataRunDir, migratedTask.id, "migrated.md");
      db.db.prepare("UPDATE artifacts SET path = ? WHERE id = ?").run(migratedAbsPath, legacyArt.id);
      // Leave a bridge symlink pointing to a trap directory to prove artifact_read maps via resolveLegacyPath rather than following it.
      const trapDir = join(root, "trap-bridge");
      mkdirSync(join(trapDir, migratedTask.id), { recursive: true });
      writeFileSync(join(trapDir, migratedTask.id, "migrated.md"), "TRAP DO NOT READ\n", "utf8");
      symlinkSync(trapDir, legacyRunDir);

      const oldRelPath = `.harness/artifacts/${migratedRun.id}/${migratedTask.id}/migrated.md`;
      const migratedRead = (await exec.execute(migratedRun.id, migratedTask.id, "artifact_read", {
        path: oldRelPath,
      })) as { path: string; content: string };
      assert.equal(migratedRead.path, migratedAbsPath);
      assert.equal(migratedRead.content, "migrated dossier payload\n");

      // Also verify inspect_command maps the absolute legacy artifact path to the migrated data-dir file.
      const migratedCat = (await exec.execute(migratedRun.id, migratedTask.id, "inspect_command", {
        argv: ["cat", join(repoRoot, oldRelPath)],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(migratedCat.exit_code, 0);
      assert.equal(migratedCat.stdout, "migrated dossier payload\n");
      assert.equal(migratedCat.argv[1], migratedAbsPath);

      // 7. artifact_write, truncated inspect_command output, and writable extraWriteRoots in data-dir.
      const written = (await exec.execute(runA.id, reader.id, "artifact_write", {
        name: "notes.md",
        content: "written in data-dir\n",
        summary: "Notes",
      })) as { path: string };
      assert.ok(written.path.startsWith(sp.artifactsDir(runA)));
      assert.equal(existsSync(written.path), true);

      // Writable Tier 3 execute task receives extraWriteRoots in inspect_command, while read-only research does not.
      const writableExec = db.createTask({
        runId: runA.id,
        parentId: worker.id,
        tier: 3,
        kind: "execute",
        title: "Writable execute",
        objective: "Check extraWriteRoots in inspect_command",
        profileId: "pi:local",
        readOnly: false,
      });
      db.updateTask(writableExec.id, { status: "running", worktreeId: wt.id });

      await assert.rejects(
        () => exec.execute(runA.id, reader.id, "inspect_command", { argv: ["cat", extraWriteFile] }),
        /read-only-argv/,
      );
      const extraWriteCat = (await exec.execute(runA.id, writableExec.id, "inspect_command", {
        argv: ["cat", extraWriteFile],
      })) as { exit_code: number; stdout: string };
      assert.equal(extraWriteCat.exit_code, 0);
      assert.equal(extraWriteCat.stdout, "extra write root ok\n");

      // Truncated inspect_command output writes its dossier under data-dir (via writeUniqueTaskDossier + storage).
      const bigFile = join(wt.path, "big.txt");
      writeFileSync(bigFile, "B".repeat(25_000), "utf8");
      const bigCat = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", "big.txt"],
      })) as { exit_code: number; truncated: boolean; output_path?: string };
      assert.equal(bigCat.exit_code, 0);
      assert.equal(bigCat.truncated, true);
      assert.ok(bigCat.output_path);
      assert.ok(bigCat.output_path!.startsWith(sp.taskDossierDir(runA, reader.id)));
      const spilledInspect = (await exec.execute(runA.id, reader.id, "artifact_read", {
        path: bigCat.output_path,
        max_chars: 120,
      })) as { path: string; content: string };
      assert.equal(spilledInspect.path, bigCat.output_path);
      assert.ok(spilledInspect.content.includes("$ cat big.txt"));

      // 8. Code Mode: verify code_exec output spill lands in data-dir and inner artifact_read maps legacy paths.
      if (sandboxAvailable()) {
        const codeRes = (await exec.execute(migratedRun.id, migratedTask.id, "code_exec", {
          code: `
            import { artifact_read } from "harness";
            const doc = await artifact_read({ path: ${JSON.stringify(oldRelPath)} });
            output({ content: doc.content, path: doc.path, pad: "x".repeat(200) });
          `,
        })) as { ok: boolean; artifactPath?: string };
        assert.equal(codeRes.ok, true);
        assert.ok(codeRes.artifactPath, "expected code_exec to spill large output");
        assert.equal(dirname(codeRes.artifactPath!), sp.artifactsDir(migratedRun));
      }

      // 9. Summary overflow in return_task spills into data-dir and task_get maps handoff paths.
      const longSummary = "Z".repeat(SUMMARY_LIMIT + 300);
      await exec.execute(runA.id, reader.id, "return_task", {
        status: "completed",
        summary: longSummary,
        sources: [{ path: "src/app.ts" }],
      });
      const taskInfo = (await exec.execute(runA.id, worker.id, "task_get", {
        task_id: reader.id,
      })) as { task: { full_summary?: { path: string } } };
      assert.ok(taskInfo.task.full_summary?.path);
      assert.equal(dirname(taskInfo.task.full_summary!.path), sp.artifactsDir(runA));
    } finally {
      db.close();
    }
  });

  it("resolveLinkedGoalForRun uses optional hook when provided and falls back cleanly on standalone DB without goals table", async () => {
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    const { root, repoRoot } = await initTempGitRepo("pi-tools-grants-hook-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = {
      ...base,
      stateDir,
      codeMode: "off",
    };

    // Standalone DB has NO goals table.
    const db = new ControlPlaneDb(":memory:");
    const sp = storagePaths(config);
    const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const run = db.createRun({ goal: "Standalone run", repoRoot, baseBranch: "main", baseSha, chatSessionId: "chat-solo" });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Work",
        profileId: "pi:local",
      });
      const wt = await wtMgr.createForWorker(run.id, worker.id);
      const reader = db.createTask({
        runId: run.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Standalone reader",
        objective: "Inspect workspace and hook goal",
        profileId: "pi:local",
        readOnly: true,
      });
      db.updateTask(reader.id, { worktreeId: wt.id });

      // Without hook and without goals table: fallback returns null without throwing.
      const execNoHook = makeExecutor(db, wtMgr, config);
      const readmeRes = (await execNoHook.execute(run.id, reader.id, "inspect_command", {
        argv: ["cat", "README.md"],
      })) as { exit_code: number; stdout: string };
      assert.equal(readmeRes.exit_code, 0);
      assert.equal(readmeRes.stdout, "# repo\n");

      // With optional resolveLinkedGoalForRun hook pointing to a goal in another chat: grants that goal's evidence dir.
      const transferredGoalId = "goal-hook-1";
      const hookEvDir = sp.ensureGoalEvidenceDir({
        repoRoot,
        id: transferredGoalId,
        chatSessionId: "chat-origin",
      })!;
      const hookEvFile = join(hookEvDir, "hook-evidence.md");
      writeFileSync(hookEvFile, "from hook goal\n", "utf8");

      const execWithHook = makeExecutor(db, wtMgr, config, {
        resolveLinkedGoalForRun: (rid) =>
          rid === run.id ? { id: transferredGoalId, chatSessionId: "chat-origin" } : null,
      });
      const hookRes = (await execWithHook.execute(run.id, reader.id, "inspect_command", {
        argv: ["cat", hookEvFile],
      })) as { exit_code: number; stdout: string };
      assert.equal(hookRes.exit_code, 0);
      assert.equal(hookRes.stdout, "from hook goal\n");
    } finally {
      db.close();
    }
  });

  it("data-dir layout: maps workspace-relative legacy path operands in inspect_command from an external worktree without rewriting search patterns", async () => {
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    const { root, repoRoot } = await initTempGitRepo("pi-tools-rel-legacy-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = {
      ...base,
      stateDir,
      codeMode: "off",
      worktree: {
        ...base.worktree,
        extraReadRoots: [],
        extraWriteRoots: [],
      },
    };

    const db = new ControlPlaneDb(":memory:");
    const sp = storagePaths(config);
    assert.equal(sp.layout, "data-dir");
    const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
      const chatA = "chat-a";
      const chatB = "chat-b";
      const goalA = goals.createGoal({
        chatSessionId: chatA,
        repoRoot,
        title: "Goal A relative inspect",
        description: "Verify relative legacy operands from external worktree.",
        criteria: [{ id: "c1", description: "Relative legacy path works", kind: "behavioral", required: true }],
      });
      const goalB = goals.createGoal({
        chatSessionId: chatB,
        repoRoot,
        title: "Goal B other chat",
        description: "Must be refused via relative legacy path too.",
        criteria: [{ id: "c1", description: "Isolated", kind: "behavioral", required: true }],
      });

      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const runA = db.createRun({ goal: goalA.title, repoRoot, baseBranch: "main", baseSha, chatSessionId: chatA });
      goals.linkRunAndStart(goalA.id, runA.id);

      const worker = db.createTask({
        runId: runA.id,
        tier: 2,
        kind: "worker",
        title: "Worker A",
        objective: "Work in external worktree",
        profileId: "pi:local",
      });
      const wt = await wtMgr.createForWorker(runA.id, worker.id);
      assert.ok(wt.path.startsWith(sp.dataRoot!), "worktree must be outside repoRoot");

      const reader = db.createTask({
        runId: runA.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Scout A",
        objective: "Inspect relative legacy paths",
        profileId: "pi:local",
        readOnly: true,
      });
      db.updateTask(reader.id, { status: "running", worktreeId: wt.id });

      const goalAEvDir = sp.ensureGoalEvidenceDir({ repoRoot, id: goalA.id, chatSessionId: chatA })!;
      const goalAFile = join(goalAEvDir, "evidence-a.md");
      const relGoalA = `.harness/goals/${goalA.id}/evidence-a.md`;
      writeFileSync(goalAFile, `chat A relative evidence\nref: ${relGoalA}\n`, "utf8");

      const dossierA = writeTaskDossier(db, runA, worker.id, "report-a.md", "chat A relative artifact\n", "Report A", sp);
      const relDossierA = `.harness/artifacts/${runA.id}/${worker.id}/report-a.md`;

      const goalBEvDir = sp.ensureGoalEvidenceDir({ repoRoot, id: goalB.id, chatSessionId: chatB })!;
      const goalBFile = join(goalBEvDir, "secret-b.md");
      writeFileSync(goalBFile, "chat B secret\n", "utf8");
      const relGoalB = `.harness/goals/${goalB.id}/secret-b.md`;

      // Put a file in the worktree that literally mentions the legacy relative path so rg pattern preservation is testable.
      writeFileSync(join(wt.path, "src", "note-ref.ts"), `export const doc = "${relGoalA}";\n`, "utf8");

      const exec = makeExecutor(db, wtMgr, config);

      // 1. Relative legacy goal path maps to data-dir from external worktree root and subdirectory cwd.
      const catRelGoal = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", relGoalA],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(catRelGoal.exit_code, 0);
      assert.equal(catRelGoal.stdout, `chat A relative evidence\nref: ${relGoalA}\n`);
      assert.equal(catRelGoal.argv[1], goalAFile);

      const catRelGoalFromSubdir = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", `./${relGoalA}`],
        cwd: "src",
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(catRelGoalFromSubdir.exit_code, 0);
      assert.equal(catRelGoalFromSubdir.argv[1], goalAFile);

      // 2. Relative legacy artifact path maps to data-dir.
      const catRelArt = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["cat", relDossierA],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(catRelArt.exit_code, 0);
      assert.equal(catRelArt.stdout, "chat A relative artifact\n");
      assert.equal(catRelArt.argv[1], dossierA.path);

      // 3. Relative legacy path for another chat maps and is refused by the same grants.
      await assert.rejects(
        () => exec.execute(runA.id, reader.id, "inspect_command", { argv: ["cat", relGoalB] }),
        (err: Error) => {
          assert.match(err.message, /read-only-argv/);
          assert.ok(err.message.includes(DENIED_HARNESS_STATE_REASON), `expected denied-state reason, got: ${err.message}`);
          return true;
        },
      );

      // 4. rg: path operand is mapped, while positional search pattern and -e pattern are never rewritten.
      const rgPath = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["rg", "relative evidence", relGoalA],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(rgPath.exit_code, 0);
      assert.equal(rgPath.argv[1], "relative evidence");
      assert.equal(rgPath.argv[2], goalAFile);
      assert.ok(rgPath.stdout.includes("chat A relative evidence"));

      const rgPattern = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["rg", "-F", relGoalA, "src"],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(rgPattern.exit_code, 0);
      assert.equal(rgPattern.argv[2], relGoalA);
      assert.ok(rgPattern.stdout.includes("note-ref.ts"));

      const rgExplicitPattern = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["rg", "-F", "-e", relGoalA, relGoalA],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(rgExplicitPattern.exit_code, 0);
      assert.equal(rgExplicitPattern.argv[3], relGoalA);
      assert.equal(rgExplicitPattern.argv[4], goalAFile);
      assert.ok(rgExplicitPattern.stdout.includes(`ref: ${relGoalA}`));

      const rgFiles = (await exec.execute(runA.id, reader.id, "inspect_command", {
        argv: ["rg", "--files", `.harness/goals/${goalA.id}`],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(rgFiles.exit_code, 0);
      assert.equal(rgFiles.argv[2], goalAEvDir);
      assert.ok(rgFiles.stdout.includes("evidence-a.md"));
    } finally {
      db.close();
    }
  });

  it("data-dir layout: workspace artifact_read fallback refuses state-dir and non-granted data paths nested inside repo while reading ordinary files", async () => {
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    // Topology 1: repoRoot contains stateDir (home-directory project).
    const { root, repoRoot } = await initTempGitRepo("pi-tools-fallback-home-");
    const stateDir = join(repoRoot, ".pi-harness-state");
    mkdirSync(stateDir, { recursive: true });
    const configFile = join(stateDir, "config.json");
    const dbFile = join(stateDir, "control-plane.sqlite");
    writeFileSync(configFile, '{"secret":true}\n', "utf8");
    writeFileSync(dbFile, "SQLITE SECRET\n", "utf8");
    const linkToConfig = join(repoRoot, "src", "link-to-config.json");
    symlinkSync(configFile, linkToConfig);

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = {
      ...base,
      stateDir,
      storage: { dataDir: join(stateDir, "data") },
      codeMode: "off",
      worktree: {
        ...base.worktree,
        extraReadRoots: [],
        extraWriteRoots: [],
      },
    };

    const db = new ControlPlaneDb(":memory:");
    const sp = storagePaths(config);
    assert.equal(sp.layout, "data-dir");
    const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
      const chatA = "chat-a";
      const chatB = "chat-b";
      const goalA = goals.createGoal({
        chatSessionId: chatA,
        repoRoot,
        title: "Home repo goal A",
        description: "Fallback denial check",
        criteria: [{ id: "c1", description: "Refuse state/data", kind: "behavioral", required: true }],
      });
      const goalB = goals.createGoal({
        chatSessionId: chatB,
        repoRoot,
        title: "Home repo goal B",
        description: "Other chat",
        criteria: [{ id: "c1", description: "Secret", kind: "behavioral", required: true }],
      });
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const runA = db.createRun({ goal: goalA.title, repoRoot, baseBranch: "main", baseSha, chatSessionId: chatA });
      goals.linkRunAndStart(goalA.id, runA.id);

      // Task WITHOUT a worktree: artifact_read fallback root is run.repoRoot.
      const reader = db.createTask({
        runId: runA.id,
        tier: 3,
        kind: "research",
        title: "No-worktree scout",
        objective: "Test workspace artifact fallback",
        profileId: "pi:local",
        readOnly: true,
      });

      // Populate non-granted data files inside stateDir/data: other chat, other project, project.json, sibling worktree.
      const goalBEvDir = sp.ensureGoalEvidenceDir({ repoRoot, id: goalB.id, chatSessionId: chatB })!;
      const otherChatFile = join(goalBEvDir, "secret-b.md");
      writeFileSync(otherChatFile, "OTHER CHAT SECRET\n", "utf8");

      const otherRepo = join(root, "other-repo");
      mkdirSync(otherRepo, { recursive: true });
      const otherProjNoteDir = sp.projectNotesDir(otherRepo);
      mkdirSync(otherProjNoteDir, { recursive: true });
      const otherProjFile = join(otherProjNoteDir, "other-secret.md");
      writeFileSync(otherProjFile, "OTHER PROJECT SECRET\n", "utf8");

      const projMetaFile = join(sp.projectDir(repoRoot), "project.json");
      writeFileSync(projMetaFile, '{"repo":"home"}\n', "utf8");

      const siblingWorker = db.createTask({
        runId: runA.id,
        tier: 2,
        kind: "worker",
        title: "Sibling worker",
        objective: "Sibling worktree",
        profileId: "pi:local",
      });
      const siblingWt = await wtMgr.createForWorker(runA.id, siblingWorker.id);
      const siblingWtFile = join(siblingWt.path, "sibling-secret.ts");
      writeFileSync(siblingWtFile, "export const secret = 1;\n", "utf8");

      const exec = makeExecutor(db, wtMgr, config);

      // Ordinary workspace file still reads cleanly.
      const okRead = (await exec.execute(runA.id, reader.id, "artifact_read", {
        path: "src/app.ts",
      })) as { content: string };
      assert.equal(okRead.content, "export const answer = 42;\n");

      // State-dir internals, symlink into state-dir, other project, other chat, project.json, and sibling worktree are all refused.
      const relFromRepo = (abs: string) => {
        assert.ok(abs.startsWith(`${repoRoot}/`), `expected fixture path inside repoRoot: ${abs}`);
        return abs.slice(repoRoot.length + 1);
      };
      for (const forbidden of [
        relFromRepo(configFile),
        relFromRepo(dbFile),
        "src/link-to-config.json",
        relFromRepo(otherChatFile),
        relFromRepo(otherProjFile),
        relFromRepo(projMetaFile),
        relFromRepo(siblingWtFile),
      ]) {
        await assert.rejects(
          () => exec.execute(runA.id, reader.id, "artifact_read", { path: forbidden }),
          /artifact-outside-workspace/,
          `expected refusal for ${forbidden}`,
        );
      }
    } finally {
      db.close();
    }

    // Topology 2: custom storage.dataDir inside repoRoot (separate from stateDir).
    resetStoragePathsForTest();
    const { root: root2, repoRoot: repo2 } = await initTempGitRepo("pi-tools-fallback-custom-data-");
    const stateDir2 = join(root2, "external-state");
    const customDataDir = join(repo2, "custom-harness-data");
    mkdirSync(stateDir2, { recursive: true });
    mkdirSync(customDataDir, { recursive: true });

    const base2 = loadConfig(repo2);
    const config2: HarnessConfig = {
      ...base2,
      stateDir: stateDir2,
      storage: { dataDir: customDataDir },
      codeMode: "off",
      worktree: { ...base2.worktree, extraReadRoots: [], extraWriteRoots: [] },
    };
    const db2 = new ControlPlaneDb(":memory:");
    const sp2 = storagePaths(config2);
    const wtMgr2 = new WorktreeManager(db2, repo2, config2.worktree, { stateDir: stateDir2 }, sp2);
    try {
      const baseSha2 = (await runGit(repo2, ["rev-parse", "HEAD"])).stdout;
      const run2 = db2.createRun({ goal: "Custom dataDir run", repoRoot: repo2, baseBranch: "main", baseSha: baseSha2, chatSessionId: "chat-1" });
      const reader2 = db2.createTask({
        runId: run2.id,
        tier: 3,
        kind: "research",
        title: "No-worktree scout 2",
        objective: "Check custom dataDir denial",
        profileId: "pi:local",
        readOnly: true,
      });

      const otherRepo2 = join(root2, "other-repo-2");
      mkdirSync(otherRepo2, { recursive: true });
      const otherProjDir2 = sp2.projectNotesDir(otherRepo2);
      mkdirSync(otherProjDir2, { recursive: true });
      const otherProjFile2 = join(otherProjDir2, "secret.md");
      writeFileSync(otherProjFile2, "OTHER PROJECT CUSTOM DATA SECRET\n", "utf8");

      const otherChatNotes2 = sp2.notesDir({ repoRoot: repo2, chatSessionId: "chat-other" });
      mkdirSync(otherChatNotes2, { recursive: true });
      const otherChatFile2 = join(otherChatNotes2, "secret.md");
      writeFileSync(otherChatFile2, "OTHER CHAT CUSTOM DATA SECRET\n", "utf8");

      const exec2 = makeExecutor(db2, wtMgr2, config2);
      const ok2 = (await exec2.execute(run2.id, reader2.id, "artifact_read", { path: "src/app.ts" })) as { content: string };
      assert.equal(ok2.content, "export const answer = 42;\n");

      assert.ok(otherProjFile2.startsWith(`${repo2}/`));
      assert.ok(otherChatFile2.startsWith(`${repo2}/`));
      for (const forbidden of [
        otherProjFile2.slice(repo2.length + 1),
        otherChatFile2.slice(repo2.length + 1),
      ]) {
        await assert.rejects(
          () => exec2.execute(run2.id, reader2.id, "artifact_read", { path: forbidden }),
          /artifact-outside-workspace/,
          `expected refusal for custom dataDir path ${forbidden}`,
        );
      }
    } finally {
      db2.close();
    }
  });

  it("data-dir layout (D3): maps relative legacy operands after GNU optional-value long options and names ending in whitespace", async () => {
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    const { root, repoRoot } = await initTempGitRepo("pi-tools-d3-operands-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = {
      ...base,
      stateDir,
      codeMode: "off",
      worktree: {
        ...base.worktree,
        extraReadRoots: [],
        extraWriteRoots: [],
      },
    };

    const db = new ControlPlaneDb(":memory:");
    const sp = storagePaths(config);
    assert.equal(sp.layout, "data-dir");
    const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
      const chatId = "chat-d3";
      const goal = goals.createGoal({
        chatSessionId: chatId,
        repoRoot,
        title: "Goal D3 operand mapping",
        description: "Verify optional-value long options and trailing-whitespace filenames.",
        criteria: [{ id: "c1", description: "Both operand shapes map", kind: "behavioral", required: true }],
      });

      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const run = db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha, chatSessionId: chatId });
      goals.linkRunAndStart(goal.id, run.id);

      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker D3",
        objective: "Work in external worktree",
        profileId: "pi:local",
      });
      const wt = await wtMgr.createForWorker(run.id, worker.id);
      assert.ok(wt.path.startsWith(sp.dataRoot!), "worktree must be outside repoRoot");

      const reader = db.createTask({
        runId: run.id,
        parentId: worker.id,
        tier: 3,
        kind: "research",
        title: "Scout D3",
        objective: "Inspect migrated files",
        profileId: "pi:local",
        readOnly: true,
      });
      db.updateTask(reader.id, { status: "running", worktreeId: wt.id });

      const evDir = sp.ensureGoalEvidenceDir({ repoRoot, id: goal.id, chatSessionId: chatId })!;
      const evFile = join(evDir, "proof.txt");
      const relEvFile = `.harness/goals/${goal.id}/proof.txt`;
      writeFileSync(evFile, "migrated proof\n", "utf8");

      const spaceFile = join(evDir, "trailing-space ");
      const relSpaceFile = `.harness/goals/${goal.id}/trailing-space `;
      writeFileSync(spaceFile, "trailing space payload\n", "utf8");

      const exec = makeExecutor(db, wtMgr, config);

      // Bare `--color` takes its optional argument only with `=`, so the next word is the file operand.
      const lsColor = (await exec.execute(run.id, reader.id, "inspect_command", {
        argv: ["ls", "--color", relEvFile],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(lsColor.exit_code, 0);
      assert.equal(lsColor.argv[2], evFile);
      assert.ok(lsColor.stdout.includes("proof.txt"));

      // File names ending in whitespace are still mapped rather than skipped by a trim-equality check.
      const catSpace = (await exec.execute(run.id, reader.id, "inspect_command", {
        argv: ["cat", relSpaceFile],
      })) as { exit_code: number; stdout: string; argv: string[] };
      assert.equal(catSpace.exit_code, 0);
      assert.equal(catSpace.argv[1], spaceFile);
      assert.equal(catSpace.stdout, "trailing space payload\n");
    } finally {
      db.close();
    }
  });

  it("both layouts (D4): a granted evidence dir replaced by a link to stateDir admits no state read in inspect_command or code_exec helpers while operator roots keep symlink resolution", async () => {
    for (const layout of ["data-dir", "legacy"] as const) {
      if (layout === "legacy") delete process.env.PI_HARNESS_STORAGE_LAYOUT;
      else process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
      resetStoragePathsForTest();

      const { root, repoRoot } = await initTempGitRepo(`pi-tools-d4-${layout}-`);
      const stateDir = join(root, "state");
      mkdirSync(stateDir, { recursive: true });
      const stateSecret = join(stateDir, "config.json");
      writeFileSync(stateSecret, '{"secret":"TOP_SECRET_STATE"}\n', "utf8");

      const opReal = join(root, "op-real-docs");
      const opLink = join(root, "op-link-docs");
      mkdirSync(opReal, { recursive: true });
      writeFileSync(join(opReal, "doc.txt"), "operator doc ok\n", "utf8");
      symlinkSync(opReal, opLink);

      const base = loadConfig(repoRoot);
      const config: HarnessConfig = {
        ...base,
        stateDir,
        codeMode: "hybrid",
        worktree: {
          ...base.worktree,
          extraReadRoots: [opLink],
          extraWriteRoots: [],
        },
      };

      const db = new ControlPlaneDb(":memory:");
      const sp = storagePaths(config);
      assert.equal(sp.layout, layout);
      const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
      try {
        const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
        const chatId = `chat-d4-${layout}`;
        const goal = goals.createGoal({
          chatSessionId: chatId,
          repoRoot,
          title: `Goal D4 ${layout}`,
          description: "Verify redirected grant root is dropped.",
          criteria: [{ id: "c1", description: "Redirected grant admits nothing", kind: "behavioral", required: true }],
        });

        const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
        const run = db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha, chatSessionId: chatId });
        goals.linkRunAndStart(goal.id, run.id);

        const worker = db.createTask({
          runId: run.id,
          tier: 2,
          kind: "worker",
          title: "Worker D4",
          objective: "Own worktree",
          profileId: "pi:local",
        });
        const wt = await wtMgr.createForWorker(run.id, worker.id);

        const writableExec = db.createTask({
          runId: run.id,
          parentId: worker.id,
          tier: 3,
          kind: "execute",
          title: "Writable execute D4",
          objective: "Test redirected grant root",
          profileId: "pi:local",
          readOnly: false,
        });
        db.updateTask(writableExec.id, { status: "running", worktreeId: wt.id });

        const evDir = sp.ensureGoalEvidenceDir({
          repoRoot,
          id: goal.id,
          chatSessionId: chatId,
          linkedRunId: run.id,
        })!;
        assert.ok(existsSync(evDir), "evidence dir must exist at issuance");

        // Capture grants issued while evDir is a real directory, then replace evDir with a symlink to stateDir.
        const issuedGrants = sp.taskGrants({
          run: { ...run, linkedGoalId: goal.id },
          goal: { repoRoot, id: goal.id, chatSessionId: chatId, linkedRunId: run.id },
          writable: true,
          workspace: realpathSync(wt.path),
        });
        assert.ok(issuedGrants.extraWriteRoots?.includes(evDir), `expected issued grants to include ${evDir}`);

        rmSync(evDir, { recursive: true, force: true });
        symlinkSync(stateDir, evDir);

        // Return the pre-replacement grants from taskGrants so resolveTaskReadRoots processes the now-redirected root.
        const origTaskGrants = sp.taskGrants.bind(sp);
        sp.taskGrants = () => issuedGrants;
        try {
          const ac = new AbortController();
          const exec = makeExecutor(db, wtMgr, config, { signal: ac.signal });

          // Direct inspect_command must refuse both direct stateDir path and path through the redirected evDir link.
          for (const target of [stateSecret, join(evDir, "config.json")]) {
            await assert.rejects(
              () => exec.execute(run.id, writableExec.id, "inspect_command", { argv: ["cat", target] }),
              (err: Error) => {
                assert.match(err.message, /read-only-argv/);
                if (layout === "data-dir") {
                  assert.ok(
                    err.message.includes(DENIED_HARNESS_STATE_REASON),
                    `expected denied-state reason in ${layout}, got: ${err.message}`,
                  );
                }
                return true;
              },
              `inspect_command (${layout}) must refuse ${target}`,
            );
          }

          // code_exec inner file helpers (inspect_command and artifact_read with scriptSignal) must also refuse.
          for (const target of [stateSecret, join(evDir, "config.json")]) {
            await assert.rejects(
              () => exec.execute(run.id, writableExec.id, "inspect_command", { argv: ["cat", target] }, ac.signal),
              /read-only-argv/,
              `code_exec inner inspect_command (${layout}) must refuse ${target}`,
            );
            await assert.rejects(
              () => exec.execute(run.id, writableExec.id, "artifact_read", { path: target }, ac.signal),
              /artifact-outside-workspace|dossier-not-indexed/,
              `code_exec inner artifact_read (${layout}) must refuse ${target}`,
            );
          }

          if (sandboxAvailable()) {
            const codeRes = (await exec.execute(run.id, writableExec.id, "code_exec", {
              code: `
                import { artifact_read, inspect_command } from "harness";
                const results = [];
                for (const target of [${JSON.stringify(stateSecret)}, ${JSON.stringify(join(evDir, "config.json"))}]) {
                  try {
                    await inspect_command({ argv: ["cat", target] });
                    results.push("leaked:inspect:" + target);
                  } catch {
                    results.push("refused:inspect");
                  }
                  try {
                    await artifact_read({ path: target });
                    results.push("leaked:artifact:" + target);
                  } catch {
                    results.push("refused:artifact");
                  }
                }
                output(results);
              `,
            })) as { ok: boolean; value?: string[] };
            assert.equal(codeRes.ok, true);
            assert.deepEqual(codeRes.value, [
              "refused:inspect",
              "refused:artifact",
              "refused:inspect",
              "refused:artifact",
            ]);
          }

          // Operator extraReadRoot outside stateDir/dataRoot/legacy storage keeps symlink resolution.
          const opCat = (await exec.execute(run.id, writableExec.id, "inspect_command", {
            argv: ["cat", join(opReal, "doc.txt")],
          })) as { exit_code: number; stdout: string };
          assert.equal(opCat.exit_code, 0);
          assert.equal(opCat.stdout, "operator doc ok\n");
        } finally {
          sp.taskGrants = origTaskGrants;
        }
      } finally {
        db.close();
      }
    }
  });
});
