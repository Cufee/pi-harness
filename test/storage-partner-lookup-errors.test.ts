import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { GoalEngine } from "../src/goals/engine.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit, WorktreeManager } from "../src/worktree/manager.js";

const tempDirs: string[] = [];
const ORIGINAL_LAYOUT = process.env.PI_HARNESS_STORAGE_LAYOUT;

function restoreLayoutEnv(): void {
  if (ORIGINAL_LAYOUT === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = ORIGINAL_LAYOUT;
  resetStoragePathsForTest();
}

afterEach(() => {
  restoreLayoutEnv();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# partner lookup errors\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return { root, repoRoot };
}

function makeExecutor(
  db: ControlPlaneDb,
  wtMgr: WorktreeManager,
  config: HarnessConfig,
  resolveLinkedGoalForRun?: ToolRuntimeHooks["resolveLinkedGoalForRun"],
): ControlPlaneToolExecutor {
  const hooks: ToolRuntimeHooks = {
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
    getTaskSignal: () => undefined,
    ...(resolveLinkedGoalForRun ? { resolveLinkedGoalForRun } : {}),
  };
  return new ControlPlaneToolExecutor(
    db,
    () => {
      throw new Error("unused");
    },
    hooks,
    config,
  );
}

describe("ControlPlaneToolExecutor partner lookup error propagation (D7)", () => {
  it("propagates hook and unexpected DB errors without creating a split data-dir run half, while a DB without a goals table still writes as today", async () => {
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    const { root, repoRoot } = await initTempGitRepo("pi-tools-d7-partner-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const base = loadConfig(repoRoot);
    const config: HarnessConfig = {
      ...base,
      stateDir,
      storage: { dataDir: join(stateDir, "data") },
      codeMode: "off",
    };

    const sp = storagePaths(config);
    const legacySp = createLegacyStoragePaths(config);
    assert.equal(sp.layout, "data-dir");

    const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
    const chatSessionId = "chat-d7";
    const dataChatDir = sp.chatDir({ repoRoot, chatSessionId });

    // 1. Real legacy goal half exists; linked run has no artifacts dir yet.
    const db = new ControlPlaneDb(":memory:");
    const wtMgr = new WorktreeManager(db, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const legacyGoals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, legacySp);
      const goal = legacyGoals.createGoal({
        chatSessionId,
        repoRoot,
        title: "Legacy goal with failing partner lookup",
        description: "Must not split into data-dir when partner lookup throws.",
        criteria: [{ id: "c1", description: "No split run half", kind: "behavioral", required: true }],
      });
      const legacyGoalDir = legacySp.goalEvidenceDir(goal);
      assert.equal(existsSync(legacyGoalDir), true);

      const run = db.createRun({
        repoRoot,
        chatSessionId,
        goal: goal.title,
        baseBranch: "main",
        baseSha,
      });
      db.db.prepare("UPDATE goals SET linked_run_id = ?, status = 'executing' WHERE id = ?").run(run.id, goal.id);

      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker D7",
        objective: "Write first dossier",
        profileId: "pi:local",
      });
      db.updateTask(worker.id, { status: "running" });

      const dataDirRunDir = join(dataChatDir, "artifacts", run.id);
      const legacyRunDir = legacySp.runArtifactsDir(run);
      assert.equal(existsSync(dataDirRunDir), false);
      assert.equal(existsSync(legacyRunDir), false);

      // A throwing resolveLinkedGoalForRun hook must fail the write and never create a data-dir run half.
      const execWithThrowingHook = makeExecutor(db, wtMgr, config, () => {
        throw new Error("partner lookup hook exploded");
      });
      await assert.rejects(
        () =>
          execWithThrowingHook.execute(run.id, worker.id, "artifact_write", {
            name: "report.md",
            content: "# should fail\n",
            summary: "Must fail before creating split half",
          }),
        /partner lookup hook exploded/,
      );
      assert.equal(existsSync(dataDirRunDir), false, "throwing hook must not create a data-dir run half");
      assert.equal(existsSync(legacyRunDir), false, "throwing hook must not create a legacy run half");
      assert.equal(db.getTask(worker.id)?.status, "running", "task must not be marked failed");

      // An unexpected SQLite error (not missing goals table/column) must also propagate without splitting.
      const execDbOnly = makeExecutor(db, wtMgr, config);
      const origPrepare = db.db.prepare.bind(db.db);
      (db.db as unknown as { prepare: typeof db.db.prepare }).prepare = ((sql: string, ...rest: unknown[]) => {
        if (sql.includes("FROM goals")) {
          const busy = new Error("database is locked") as Error & { code?: string };
          busy.code = "SQLITE_BUSY";
          throw busy;
        }
        return (origPrepare as (...args: unknown[]) => unknown)(sql, ...rest);
      }) as typeof db.db.prepare;
      try {
        await assert.rejects(
          () =>
            execDbOnly.execute(run.id, worker.id, "artifact_write", {
              name: "report.md",
              content: "# should fail\n",
              summary: "Must fail on unexpected SQLite error",
            }),
          /database is locked/,
        );
      } finally {
        (db.db as unknown as { prepare: typeof db.db.prepare }).prepare = origPrepare;
      }
      assert.equal(existsSync(dataDirRunDir), false, "unexpected DB error must not create a data-dir run half");
      assert.equal(db.getTask(worker.id)?.status, "running", "task must not be marked failed");
    } finally {
      db.close();
    }

    // 2. Standalone ControlPlaneDb without a goals table still treats the run as unlinked and writes as today.
    const standaloneDb = new ControlPlaneDb(":memory:");
    const standaloneWtMgr = new WorktreeManager(standaloneDb, repoRoot, config.worktree, { stateDir }, sp);
    try {
      const standaloneRun = standaloneDb.createRun({
        repoRoot,
        chatSessionId,
        goal: "Standalone run without goals table",
        baseBranch: "main",
        baseSha,
      });
      const standaloneWorker = standaloneDb.createTask({
        runId: standaloneRun.id,
        tier: 2,
        kind: "worker",
        title: "Standalone worker",
        objective: "Write dossier on standalone DB",
        profileId: "pi:local",
      });
      const standaloneExec = makeExecutor(standaloneDb, standaloneWtMgr, config);
      const written = (await standaloneExec.execute(standaloneRun.id, standaloneWorker.id, "artifact_write", {
        name: "standalone.md",
        content: "# standalone ok\n",
        summary: "Standalone write succeeds without goals table",
      })) as { artifactId: string; path: string };
      assert.equal(existsSync(written.path), true);
      assert.ok(written.path.startsWith(join(dataChatDir, "artifacts", standaloneRun.id)));

      // A minimal goals table lacking linked_run_id also falls back to no partner.
      standaloneDb.db.exec("CREATE TABLE goals (id TEXT PRIMARY KEY)");
      const writtenMissingCol = (await standaloneExec.execute(standaloneRun.id, standaloneWorker.id, "artifact_write", {
        name: "missing-col.md",
        content: "# missing col ok\n",
        summary: "Write succeeds when goals schema lacks linked_run_id",
      })) as { artifactId: string; path: string };
      assert.equal(existsSync(writtenMissingCol.path), true);
    } finally {
      standaloneDb.close();
    }
  });
});
