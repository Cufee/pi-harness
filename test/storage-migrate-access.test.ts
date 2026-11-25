import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { findRunDossier, hashRunDossier, readRunDossier } from "../src/control-plane/dossiers.js";
import { GoalEngine } from "../src/goals/engine.js";
import { BRIDGE_MAX_AGE_MS, runStorageMigrationPass } from "../src/storage/migrate.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeFile(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storage migration access continuity (goal criterion c8)", () => {
  it("keeps resolveLegacyPath, dossier readers, and project notes identical before migration, after migration, and after 7-day bridge removal", async () => {
    const root = makeTempDir("pi-mig-access-c8-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    const goals = new GoalEngine(cpDb.db);
    const storage = storagePaths({ stateDir }, { layout: "data-dir" });

    try {
      // Seed terminal goal + linked run + bucket task + flat spill + note in legacy layout before migration.
      const goal = goals.createGoal({
        repoRoot: repo,
        chatSessionId: "chat-4",
        title: "Continuity goal",
        description: "Verify access before and after migration",
        criteria: [{ id: "c8", description: "Old and new paths resolve to same content", kind: "behavioral" }],
      });
      const goalRun = cpDb.createRun({
        goal: "Continuity goal",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-4",
      });
      goals.linkRunAndStart(goal.id, goalRun.id);
      const goalTask = cpDb.createTask({
        runId: goalRun.id,
        tier: 2,
        kind: "worker",
        title: "Goal worker",
        objective: "Write artifacts",
        profileId: "acp:claude",
      });
      cpDb.updateTask(goalTask.id, { status: "completed" });
      cpDb.updateRunStatus(goalRun.id, "completed");
      goals.setStatus(goal.id, "achieved");

      const bucketRun = cpDb.createRun({
        id: "director-tasks-chat-5",
        goal: "Director bucket",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-5",
      });
      const bucketTask = cpDb.createTask({
        runId: bucketRun.id,
        tier: 2,
        kind: "research",
        title: "Bucket research",
        objective: "Produce bucket dossier",
        profileId: "acp:claude",
      });
      cpDb.updateTask(bucketTask.id, { status: "completed" });

      const contents = {
        goalEvidence: "goal evidence body v1\n",
        runDossier: "run dossier body v1\n",
        bucketDossier: "bucket dossier body v1\n",
        flatSpill: "flat spill overflow body v1\n",
        note: "# Team Architecture Guide\nPersists at projectNotesDir.\n",
      };

      const relPaths = {
        goalEvidence: `.harness/goals/${goal.id}/evidence.md`,
        runDossier: `.harness/artifacts/${goalRun.id}/${goalTask.id}/report.md`,
        bucketDossier: `.harness/artifacts/${bucketRun.id}/${bucketTask.id}/findings.md`,
        flatSpill: `.harness/artifacts/${goalTask.id}-summary-1.md`,
        note: `.harness/notes/team/guide.md`,
      };

      const oldAbsPaths = {
        goalEvidence: join(repo, relPaths.goalEvidence),
        runDossier: join(repo, relPaths.runDossier),
        bucketDossier: join(repo, relPaths.bucketDossier),
        flatSpill: join(repo, relPaths.flatSpill),
        note: join(repo, relPaths.note),
      };

      const projDir = storage.projectDir(repo);
      const newAbsPaths = {
        goalEvidence: join(projDir, "chats", "chat-4", "goals", goal.id, "evidence.md"),
        runDossier: join(projDir, "chats", "chat-4", "artifacts", goalRun.id, goalTask.id, "report.md"),
        bucketDossier: join(projDir, "chats", "chat-5", "artifacts", bucketRun.id, bucketTask.id, "findings.md"),
        flatSpill: join(projDir, "chats", "chat-4", "artifacts", `${goalTask.id}-summary-1.md`),
        note: join(storage.projectNotesDir(repo), "team", "guide.md"),
      };

      writeFile(oldAbsPaths.goalEvidence, contents.goalEvidence);
      writeFile(oldAbsPaths.runDossier, contents.runDossier);
      writeFile(oldAbsPaths.bucketDossier, contents.bucketDossier);
      writeFile(oldAbsPaths.flatSpill, contents.flatSpill);
      writeFile(oldAbsPaths.note, contents.note);

      // Record pre-migration artifact rows using legacy paths.
      cpDb.recordArtifact({
        runId: goalRun.id,
        taskId: goalTask.id,
        kind: "dossier",
        path: oldAbsPaths.runDossier,
        summary: "Run report",
      });
      cpDb.recordArtifact({
        runId: bucketRun.id,
        taskId: bucketTask.id,
        kind: "dossier",
        path: oldAbsPaths.bucketDossier,
        summary: "Bucket findings",
      });
      cpDb.recordArtifact({
        runId: goalRun.id,
        taskId: goalTask.id,
        kind: "dossier",
        path: oldAbsPaths.flatSpill,
        summary: "Summary spill",
      });

      const assertAllAccess = async (phase: "before" | "after_migrate" | "after_bridge_removal") => {
        const expectedPath = phase === "before" ? oldAbsPaths : newAbsPaths;

        // 1. storage.resolveLegacyPath for relative, old absolute, and (when migrated) new absolute resolves to one file with identical content.
        const items: Array<keyof typeof contents> = [
          "goalEvidence",
          "runDossier",
          "bucketDossier",
          "flatSpill",
          "note",
        ];
        for (const key of items) {
          const fromRel = storage.resolveLegacyPath(repo, relPaths[key]);
          const fromOldAbs = storage.resolveLegacyPath(repo, oldAbsPaths[key]);
          assert.equal(fromRel, expectedPath[key], `${phase}: rel path resolution mismatch for ${key}`);
          assert.equal(fromOldAbs, expectedPath[key], `${phase}: old abs path resolution mismatch for ${key}`);
          assert.equal(readFileSync(fromRel!, "utf8"), contents[key], `${phase}: content mismatch for ${key}`);

          if (phase !== "before") {
            const fromNewAbs = storage.resolveLegacyPath(repo, newAbsPaths[key]);
            assert.equal(fromNewAbs, newAbsPaths[key], `${phase}: new abs path resolution mismatch for ${key}`);
            assert.equal(readFileSync(fromNewAbs!, "utf8"), contents[key]);
            // Verify resolved file is a real file, not a symlink.
            assert.equal(lstatSync(fromRel!).isSymbolicLink(), false);
            assert.equal(lstatSync(fromRel!).isFile(), true);
          }
        }

        // 2. Dossier readers in src/control-plane/dossiers.ts return the exact same content and hash for pre-migration rows.
        const dossierChecks = [
          {
            label: "runDossier",
            run: cpDb.getRun(goalRun.id)!,
            rel: relPaths.runDossier,
            oldAbs: oldAbsPaths.runDossier,
            newAbs: newAbsPaths.runDossier,
            body: contents.runDossier,
          },
          {
            label: "bucketDossier",
            run: cpDb.getRun(bucketRun.id)!,
            rel: relPaths.bucketDossier,
            oldAbs: oldAbsPaths.bucketDossier,
            newAbs: newAbsPaths.bucketDossier,
            body: contents.bucketDossier,
          },
          {
            label: "flatSpill",
            run: cpDb.getRun(goalRun.id)!,
            rel: relPaths.flatSpill,
            oldAbs: oldAbsPaths.flatSpill,
            newAbs: newAbsPaths.flatSpill,
            body: contents.flatSpill,
          },
        ] as const;

        for (const chk of dossierChecks) {
          const queries = phase === "before" ? [chk.rel, chk.oldAbs] : [chk.rel, chk.oldAbs, chk.newAbs];
          for (const q of queries) {
            const found = findRunDossier(cpDb, chk.run, q, storage);
            assert.ok(found, `${phase}: findRunDossier failed for ${chk.label} via ${q}`);

            const readRes = readRunDossier(cpDb, chk.run, { path: q }, storage) as { path: string; content: string };
            assert.equal(readRes.content, chk.body, `${phase}: readRunDossier content mismatch for ${chk.label} via ${q}`);

            const hashRes = await hashRunDossier(cpDb, chk.run, q, undefined, storage);
            assert.deepEqual(hashRes, {
              sha256: sha256(chk.body),
              bytes: Buffer.byteLength(chk.body, "utf8"),
            });
          }
        }

        // 3. Note is at projectNotesDir after migration, never under chats/legacy/notes.
        if (phase !== "before") {
          assert.equal(existsSync(newAbsPaths.note), true);
          assert.equal(readFileSync(newAbsPaths.note, "utf8"), contents.note);
          assert.equal(existsSync(join(projDir, "chats", "legacy", "notes")), false);
        }
      };

      // Phase 1: Before migration
      await assertAllAccess("before");

      // Run real migration pass
      const migReport = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(migReport.errors.length, 0);
      assert.ok(migReport.totals.migrated >= 3);

      // Phase 2: Immediately after migration (bridges present)
      await assertAllAccess("after_migrate");

      // Advance clock past 7-day bridge lifetime and remove bridges + empty .harness
      const bridgeMtime = lstatSync(oldAbsPaths.note).mtimeMs;
      const cleanupReport = runStorageMigrationPass({
        sqlite: cpDb.db,
        storage,
        now: () => bridgeMtime + BRIDGE_MAX_AGE_MS + 1_000,
      });
      assert.equal(cleanupReport.errors.length, 0);
      assert.equal(existsSync(join(repo, ".harness")), false);

      // Phase 3: After bridge removal and empty .harness cleanup
      await assertAllAccess("after_bridge_removal");
    } finally {
      cpDb.close();
    }
  });
});
