import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { GoalEngine } from "../src/goals/engine.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const INITIAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];
const activeDaemons: HarnessDaemon[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function initTempGitRepo(prefix: string): { repoDir: string; baseSha: string } {
  const repoDir = makeTempDir(prefix);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "# Daemon RPC Storage Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  return { repoDir, baseSha };
}

function writeFile(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function setLayoutEnv(layout: "legacy" | "data-dir" | undefined): void {
  if (layout === undefined) {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  } else {
    process.env.PI_HARNESS_STORAGE_LAYOUT = layout;
  }
  resetStoragePathsForTest();
}

function makeDaemonConfig(repoDir: string, stateDir: string) {
  const sockPath = join(stateDir, "d.sock");
  const baseCfg = loadConfig(repoDir);
  return withFixtureCatalog({
    ...baseCfg,
    codeMode: "off",
    goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
    stateDir,
    socketPath: sockPath,
  });
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop()!;
    try {
      await d.stop();
    } catch {
      // ignore cleanup failures
    }
  }
  setLayoutEnv(INITIAL_LAYOUT_ENV as "legacy" | "data-dir" | undefined);
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("daemon RPC storage paths (artifact.read and task.get)", () => {
  it("resolves migrated dossiers across all three spellings, enforces data-dir read policy, compacts task.get handoffs, and keeps legacy layout unchanged", async () => {
    const legacyPaths = createLegacyStoragePaths();

    // --- Part 1: data-dir layout ---
    const { repoDir, baseSha } = initTempGitRepo("pi-rpc-datadir-repo-");
    const stateDir = makeTempDir("pi-rpc-datadir-state-");
    const dbPath = join(stateDir, "control-plane.sqlite");

    // Seed a terminal goal + legacy dossier before starting the data-dir daemon so daemon.start() migrates it.
    let migratedRunId: string;
    let migratedTaskId: string;
    let legacyDossierAbs: string;
    let legacyDossierRel: string;
    let bothExistRunId: string;
    let bothExistTaskId: string;
    let bothExistLegacyAbs: string;
    let bothExistLegacyRel: string;

    {
      const cpDb = new ControlPlaneDb(dbPath);
      const goals = new GoalEngine(cpDb.db);
      try {
        const goal = goals.createGoal({
          chatSessionId: "chat-1",
          repoRoot: repoDir,
          title: "Migrated goal",
          description: "Migrated dossier read test",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
        });
        const run = cpDb.createRun({
          goal: goal.title,
          repoRoot: repoDir,
          baseBranch: "main",
          baseSha,
          chatSessionId: "chat-1",
        });
        migratedRunId = run.id;
        goals.linkRunAndStart(goal.id, run.id);
        const task = cpDb.createTask({
          runId: run.id,
          tier: 2,
          kind: "worker",
          title: "Migrated worker",
          objective: "Write migrated dossier",
          profileId: "pi:local",
        });
        migratedTaskId = task.id;

        const legacyDir = legacyPaths.taskDossierDir(run, task.id);
        legacyDossierAbs = join(legacyDir, "g0-dossier.md");
        legacyDossierRel = relative(repoDir, legacyDossierAbs);
        writeFile(legacyDossierAbs, "migrated dossier body\n");
        writeFile(join(legacyPaths.goalEvidenceDir(goal), "evidence.txt"), "evidence\n");

        cpDb.recordArtifact({
          runId: run.id,
          taskId: task.id,
          kind: "dossier",
          path: legacyDossierAbs,
          summary: "Migrated dossier",
        });
        cpDb.updateTask(task.id, {
          status: "completed",
          summary: `Completed\n\n[Full summary: ${legacyDossierRel}]`,
          resultJson: JSON.stringify({
            summary: "Completed",
            artifact_paths: [legacyDossierAbs],
            summary_overflow: { path: legacyDossierRel, next_offset: 0 },
          }),
        });
        cpDb.updateRunStatus(run.id, "completed");
        cpDb.db.prepare("UPDATE goals SET status = 'achieved' WHERE id = ?").run(goal.id);

        // Create a second run linked to a non-terminal goal (so migration defers it) with a settled task
        // (so startup recovery does not launch an agent) to verify both-exist union precedence.
        const activeGoal = goals.createGoal({
          chatSessionId: "chat-2",
          repoRoot: repoDir,
          title: "Both-exist active goal",
          description: "Keeps run deferred during migration",
          criteria: [{ id: "c1", description: "Active", kind: "behavioral", required: true }],
        });
        const activeRun = cpDb.createRun({
          goal: activeGoal.title,
          repoRoot: repoDir,
          baseBranch: "main",
          baseSha,
          chatSessionId: "chat-2",
        });
        bothExistRunId = activeRun.id;
        goals.linkRunAndStart(activeGoal.id, activeRun.id);
        const activeTask = cpDb.createTask({
          runId: activeRun.id,
          tier: 2,
          kind: "worker",
          title: "Both-exist worker",
          objective: "Test both-exist union",
          profileId: "pi:local",
        });
        bothExistTaskId = activeTask.id;
        cpDb.updateTask(activeTask.id, { status: "completed", summary: "Done" });
        bothExistLegacyAbs = join(legacyPaths.taskDossierDir(activeRun, activeTask.id), "conflict.md");
        bothExistLegacyRel = relative(repoDir, bothExistLegacyAbs);
        writeFile(bothExistLegacyAbs, "legacy winner content\n");
        cpDb.recordArtifact({
          runId: activeRun.id,
          taskId: activeTask.id,
          kind: "dossier",
          path: bothExistLegacyAbs,
          summary: "Conflict dossier",
        });
      } finally {
        cpDb.close();
      }
    }

    setLayoutEnv("data-dir");
    const ddConfig = makeDaemonConfig(repoDir, stateDir);
    const ddStorage = storagePaths(ddConfig);
    assert.equal(ddStorage.layout, "data-dir");

    // Pre-seed the data-dir copy for the both-exist run before starting the daemon.
    const bothExistDataDirAbs = join(
      ddStorage.projectDir(repoDir),
      "chats",
      "chat-2",
      "artifacts",
      bothExistRunId,
      bothExistTaskId,
      "conflict.md",
    );
    writeFile(bothExistDataDirAbs, "data-dir loser content\n");

    const daemon = new HarnessDaemon(ddConfig, { dbPath });
    activeDaemons.push(daemon);
    await daemon.start();

    const client = new DaemonClient(ddConfig.socketPath);
    await client.connect();
    try {

    // Confirm migration actually moved the terminal dossier into data-dir with a bridge symlink.
    const expectedMigratedAbs = join(
      ddStorage.projectDir(repoDir),
      "chats",
      "chat-1",
      "artifacts",
      migratedRunId,
      migratedTaskId,
      "g0-dossier.md",
    );
    assert.equal(existsSync(expectedMigratedAbs), true);
    assert.equal(lstatSync(join(legacyPaths.artifactsDir({ repoRoot: repoDir }), migratedRunId)).isSymbolicLink(), true);

    // 1. artifact.read resolves all three spellings of the migrated dossier to the same content and absolute path.
    for (const reqPath of [expectedMigratedAbs, legacyDossierAbs, legacyDossierRel]) {
      const res = await client.request<{ path: string; content: string }>("artifact.read", {
        runId: migratedRunId,
        path: reqPath,
      });
      assert.equal(res.content, "migrated dossier body\n", `mismatch for ${reqPath}`);
      assert.equal(res.path, expectedMigratedAbs, `path mismatch for ${reqPath}`);
    }

    // 2. Both-exist union: real legacy file wins over data-dir copy across all three spellings.
    for (const reqPath of [bothExistDataDirAbs, bothExistLegacyAbs, bothExistLegacyRel]) {
      const res = await client.request<{ path: string; content: string }>("artifact.read", {
        runId: bothExistRunId,
        path: reqPath,
      });
      assert.equal(res.content, "legacy winner content\n", `both-exist mismatch for ${reqPath}`);
      assert.equal(res.path, bothExistLegacyAbs, `both-exist path mismatch for ${reqPath}`);
    }

    // 3. task.get compacts handoff paths via daemon storage in data-dir layout.
    const taskDetail = await client.request<{
      handoff: { artifact_paths?: string[]; full_summary?: { path: string } };
    }>("task.get", { taskId: migratedTaskId });
    assert.deepEqual(taskDetail.handoff.artifact_paths, [expectedMigratedAbs]);
    assert.equal(taskDetail.handoff.full_summary?.path, expectedMigratedAbs);

    // 4. Workspace fallback allows ordinary repo files and refuses state-dir internals, data-dir metadata, and worktree/scratch paths.
    const stateSecret = join(stateDir, "config.json");
    writeFile(stateSecret, '{"token":"secret"}\n');
    const stateLinkInRepo = join(repoDir, "link-to-state-config.json");
    symlinkSync(stateSecret, stateLinkInRepo);

    const projectMeta = join(ddStorage.projectDir(repoDir), "project.json");
    writeFile(projectMeta, '{"repoRoot":"test"}\n');

    const taskWtDir = ddStorage.worktreePath({ id: bothExistRunId, repoRoot: repoDir, chatSessionId: "chat-2" }, bothExistTaskId);
    const taskWtFile = join(taskWtDir, "wt-secret.txt");
    writeFile(taskWtFile, "worktree secret\n");

    const scratchFile = join(ddStorage.scratchPath(repoDir, "_verify", "s-1"), "scratch-secret.txt");
    writeFile(scratchFile, "scratch secret\n");

    const legacyWtFile = join(
      legacyPaths.worktreePath({ id: bothExistRunId, repoRoot: repoDir }, bothExistTaskId),
      "legacy-wt.txt",
    );
    writeFile(legacyWtFile, "legacy worktree secret\n");

    {
      const cpDb = new ControlPlaneDb(dbPath);
      try {
        cpDb.recordWorktree({
          runId: bothExistRunId,
          taskId: bothExistTaskId,
          branch: "harness/chat-2/run/task",
          path: taskWtDir,
          baseSha,
        });

        for (const p of ["README.md", stateSecret, stateLinkInRepo, projectMeta, taskWtFile, scratchFile, legacyWtFile]) {
          cpDb.recordArtifact({
            runId: bothExistRunId,
            taskId: bothExistTaskId,
            kind: "read",
            path: p,
            summary: `Indexed ${p}`,
          });
        }
      } finally {
        cpDb.close();
      }
    }

    const readmeRes = await client.request<{ path: string; content: string }>("artifact.read", {
      runId: bothExistRunId,
      path: "README.md",
    });
    assert.equal(readmeRes.content, "# Daemon RPC Storage Test\n");
    assert.equal(readmeRes.path, join(repoDir, "README.md"));

    for (const forbidden of [stateSecret, stateLinkInRepo, projectMeta, taskWtFile, scratchFile, legacyWtFile]) {
      await assert.rejects(
        () =>
          client.request("artifact.read", {
            runId: bothExistRunId,
            path: forbidden,
          }),
        /artifact-outside-workspace/,
        `expected refusal for ${forbidden}`,
      );
    }
    } finally {
      client.close();
    }

    await daemon.stop();
    activeDaemons.pop();

    // --- Part 2: legacy layout unchanged ---
    setLayoutEnv("legacy");
    const { repoDir: legacyRepo, baseSha: legacyBaseSha } = initTempGitRepo("pi-rpc-legacy-repo-");
    const legacyStateDir = makeTempDir("pi-rpc-legacy-state-");
    const legacyDbPath = join(legacyStateDir, "control-plane.sqlite");

    let legRunId: string;
    let legDossierAbs: string;
    let legDossierRel: string;
    let legWtFileRel: string;

    {
      const cpDb = new ControlPlaneDb(legacyDbPath);
      try {
        const run = cpDb.createRun({
          goal: "Legacy run",
          repoRoot: legacyRepo,
          baseBranch: "main",
          baseSha: legacyBaseSha,
        });
        legRunId = run.id;
        const task = cpDb.createTask({
          runId: run.id,
          tier: 2,
          kind: "worker",
          title: "Legacy worker",
          objective: "Legacy read check",
          profileId: "pi:local",
        });
        cpDb.updateTask(task.id, { status: "completed", summary: "Done" });
        cpDb.updateRunStatus(run.id, "completed");
        legDossierAbs = join(legacyPaths.taskDossierDir(run, task.id), "legacy-report.md");
        legDossierRel = relative(legacyRepo, legDossierAbs);
        writeFile(legDossierAbs, "legacy dossier body\n");
        cpDb.recordArtifact({
          runId: run.id,
          taskId: task.id,
          kind: "dossier",
          path: legDossierAbs,
          summary: "Legacy dossier",
        });

        const legWtDir = legacyPaths.worktreePath(run, task.id);
        legWtFileRel = "wt-note.txt";
        writeFile(join(legWtDir, legWtFileRel), "legacy worktree note\n");
        cpDb.recordWorktree({
          runId: run.id,
          taskId: task.id,
          branch: "harness/run/task",
          path: legWtDir,
          baseSha: legacyBaseSha,
        });
        cpDb.recordArtifact({
          runId: run.id,
          taskId: task.id,
          kind: "read",
          path: legWtFileRel,
          summary: "Worktree file",
        });
      } finally {
        cpDb.close();
      }
    }

    const legacyCfg = makeDaemonConfig(legacyRepo, legacyStateDir);
    const legacyDaemon = new HarnessDaemon(legacyCfg, { dbPath: legacyDbPath });
    activeDaemons.push(legacyDaemon);
    await legacyDaemon.start();
    const legacyClient = new DaemonClient(legacyCfg.socketPath);
    await legacyClient.connect();
    try {
      for (const reqPath of [legDossierAbs, legDossierRel]) {
        const res = await legacyClient.request<{ path: string; content: string }>("artifact.read", {
          runId: legRunId,
          path: reqPath,
        });
        assert.equal(res.content, "legacy dossier body\n");
        assert.equal(res.path, legDossierAbs);
      }

      const legacyWtRead = await legacyClient.request<{ content: string }>("artifact.read", {
        runId: legRunId,
        path: legWtFileRel,
      });
      assert.equal(legacyWtRead.content, "legacy worktree note\n");
    } finally {
      legacyClient.close();
    }
  });
});
