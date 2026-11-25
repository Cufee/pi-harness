import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ALL_RULES, AdvisoryEngine, AdvisedToolExecutor, buildSubject } from "../src/advisories/index.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { writeTaskDossier } from "../src/control-plane/dossiers.js";
import type { ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { QuotaClient } from "../src/quota/client.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const prevLayout = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];

function restoreLayout(): void {
  if (prevLayout === undefined) {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  } else {
    process.env.PI_HARNESS_STORAGE_LAYOUT = prevLayout;
  }
  resetStoragePathsForTest();
}

afterEach(() => {
  restoreLayout();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeHooks(signal: AbortSignal): ToolRuntimeHooks {
  return {
    spawnAndStartTask: async () => {
      throw new Error("unused");
    },
    waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
    steerTask: async () => true,
    cancelTask: async () => {},
    scheduleRollover: async () => {},
    getWorktreeManager: () => {
      throw new Error("unused");
    },
    getMergeQueue: () => {
      throw new Error("unused");
    },
    forceStartWorker: async () => [],
    getTaskSignal: () => signal,
  };
}

function makeFixture() {
  process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
  resetStoragePathsForTest();

  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-advisory-progress-")));
  tempDirs.push(root);
  const repoDir = join(root, "repo");
  const stateDir = join(root, "state");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  const db = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
  const baseConfig = loadConfig(repoDir);
  const config = { ...baseConfig, stateDir };
  const storage = storagePaths(config);
  assert.equal(storage.layout, "data-dir");

  const run = db.createRun({
    id: "run-adv-prog",
    goal: "Verify dossier-alias progress observation in data-dir layout",
    repoRoot: repoDir,
    baseBranch: "main",
    baseSha: "0000000000000000000000000000000000000000",
    chatSessionId: "chat-1",
  });

  const readerTask = db.createTask({
    runId: run.id,
    tier: 3,
    kind: "research",
    title: "Reader task",
    objective: "Read sibling dossiers",
    readOnly: true,
    profileId: "pi-default",
  });
  const siblingA = db.createTask({
    runId: run.id,
    tier: 3,
    kind: "research",
    title: "Sibling A",
    objective: "Produce dossier A",
    readOnly: true,
    profileId: "pi-default",
  });
  const siblingB = db.createTask({
    runId: run.id,
    tier: 3,
    kind: "research",
    title: "Sibling B",
    objective: "Produce dossier B",
    readOnly: true,
    profileId: "pi-default",
  });
  const siblingC = db.createTask({
    runId: run.id,
    tier: 3,
    kind: "research",
    title: "Sibling C",
    objective: "Produce dossier C",
    readOnly: true,
    profileId: "pi-default",
  });

  const engine = new AdvisoryEngine({
    rules: ALL_RULES,
    createScopeSource: () => null,
    filesOutsideWriteScopes: () => [],
    harnessToolNames: new Set(["artifact_read"]),
    record: () => {},
  });
  const abort = new AbortController();
  const catalog = new ModelCatalogCompiler(config, new QuotaClient());
  const executor = new AdvisedToolExecutor(db, () => catalog, makeHooks(abort.signal), config, {
    engine,
    subjectFor: (task) =>
      buildSubject({
        task,
        workspaceRoot: repoDir,
        writeScopes: [],
        writableExtraRoots: [],
      }),
  });

  return { root, repoDir, stateDir, db, config, storage, run, readerTask, siblingA, siblingB, siblingC, engine, executor };
}

describe("advisory progress for data-dir dossiers read via legacy aliases", () => {
  it("credits sibling dossier reads via workspace-relative legacy alias, absolute legacy alias, and exact data-dir path", async () => {
    const f = makeFixture();
    try {
      const artA = writeTaskDossier(f.db, f.run, f.siblingA.id, "notes-a.md", "findings A\n", "Findings A", f.storage);
      const artB = writeTaskDossier(f.db, f.run, f.siblingB.id, "notes-b.md", "findings B\n", "Findings B", f.storage);
      const artC = writeTaskDossier(f.db, f.run, f.siblingC.id, "notes-c.md", "findings C\n", "Findings C", f.storage);
      const artSelf = writeTaskDossier(f.db, f.run, f.readerTask.id, "self.md", "own notes\n", "Own notes", f.storage);

      assert.ok(f.storage.dataRoot && artA.path.startsWith(f.storage.dataRoot), "dossier must be indexed under data-dir");

      const subA = f.storage.artifactSubPath(f.run, artA.path);
      const subC = f.storage.artifactSubPath(f.run, artC.path);
      const subSelf = f.storage.artifactSubPath(f.run, artSelf.path);
      assert.ok(subA && subC && subSelf);

      const legacyRelA = f.storage.legacyArtifactRel(subA);
      const legacyAbsC = join(f.repoDir, f.storage.legacyArtifactRel(subC));
      const legacyRelSelf = f.storage.legacyArtifactRel(subSelf);

      // 1. Reading sibling A through its workspace-relative legacy alias must credit progress.
      const resA = (await f.executor.execute(f.run.id, f.readerTask.id, "artifact_read", {
        path: legacyRelA,
      })) as { content: string };
      assert.equal(resA.content, "findings A\n");
      assert.equal(
        f.engine.activityProgress(f.readerTask.id),
        1,
        "legacy workspace-relative alias read of sibling dossier must count as progress",
      );

      // 2. Re-reading the same sibling A dossier by its exact data-dir absolute path deduplicates.
      const resAExact = (await f.executor.execute(f.run.id, f.readerTask.id, "artifact_read", {
        path: artA.path,
      })) as { content: string };
      assert.equal(resAExact.content, "findings A\n");
      assert.equal(
        f.engine.activityProgress(f.readerTask.id),
        1,
        "reading the same dossier under legacy alias and data-dir absolute path must deduplicate",
      );

      // 3. Reading sibling B by its exact data-dir absolute spelling still credits progress.
      const resB = (await f.executor.execute(f.run.id, f.readerTask.id, "artifact_read", {
        path: artB.path,
      })) as { content: string };
      assert.equal(resB.content, "findings B\n");
      assert.equal(
        f.engine.activityProgress(f.readerTask.id),
        2,
        "exact data-dir absolute path read of sibling dossier must count as progress",
      );

      // 4. Reading sibling C through its absolute legacy alias also credits progress.
      const resC = (await f.executor.execute(f.run.id, f.readerTask.id, "artifact_read", {
        path: legacyAbsC,
      })) as { content: string };
      assert.equal(resC.content, "findings C\n");
      assert.equal(
        f.engine.activityProgress(f.readerTask.id),
        3,
        "absolute legacy alias read of sibling dossier must count as progress",
      );

      // 5. Reading the task's own dossier through its legacy alias must not credit progress.
      const resSelf = (await f.executor.execute(f.run.id, f.readerTask.id, "artifact_read", {
        path: legacyRelSelf,
      })) as { content: string };
      assert.equal(resSelf.content, "own notes\n");
      assert.equal(
        f.engine.activityProgress(f.readerTask.id),
        3,
        "reading own dossier through legacy alias must not credit progress",
      );
    } finally {
      f.db.close();
    }
  });
});
