import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { GoalEngine } from "../src/goals/engine.js";
import {
  BRIDGE_MAX_AGE_MS,
  planStorageMigration,
  runStorageMigrationPass,
} from "../src/storage/migrate.js";
import { LEGACY_HARNESS_DIR } from "../src/storage/migrate/fs.js";
import { resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function writeFile(absPath: string, content: string | Buffer): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content);
}

function createEnv(prefix: string, opts?: { inMemoryDb?: boolean }) {
  const root = makeTempDir(prefix);
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const cpDb = new ControlPlaneDb(opts?.inMemoryDb ? ":memory:" : join(stateDir, "control-plane.sqlite"));
  const goals = new GoalEngine(cpDb.db);
  const storage = storagePaths({ stateDir }, { layout: "data-dir" });
  return { root, stateDir, repo, cpDb, goals, storage };
}

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("storage migration safety round-3 regressions (F1-F4, F6-F7)", () => {
  it("F1: evaluation with 24,000 tasks and 6,000 flat spills stays within twice the budget and continues on pass 2", () => {
    const { repo, cpDb, goals, storage } = createEnv("pi-mig-f1-", { inMemoryDb: true });
    try {
      const goal = goals.createGoal({
        repoRoot: repo,
        chatSessionId: "chat-1",
        title: "F1 large goal",
        description: "24,000 tasks and 6,000 flat spill files",
        criteria: [{ id: "c1", description: "done", kind: "behavioral" }],
      });
      const run = cpDb.createRun({
        goal: "F1 large run",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-1",
      });
      goals.linkRunAndStart(goal.id, run.id);
      cpDb.updateRunStatus(run.id, "completed");
      goals.setStatus(goal.id, "achieved");

      const legacyArtifactsDir = join(repo, LEGACY_HARNESS_DIR, "artifacts");
      mkdirSync(legacyArtifactsDir, { recursive: true });

      const now = Date.now();
      const insertTask = cpDb.db.prepare(
        `INSERT INTO tasks (id, run_id, tier, kind, title, objective, criteria, status, profile_id, created_at, updated_at)
         VALUES (?, ?, 2, 'worker', ?, 'o', '[]', 'completed', 'acp:claude', ?, ?)`,
      );
      const insertArtifact = cpDb.db.prepare(
        `INSERT INTO artifacts (id, run_id, task_id, kind, path, summary, created_at)
         VALUES (?, ?, ?, 'summary', ?, 's', ?)`,
      );

      const seedTx = cpDb.db.transaction(() => {
        for (let i = 1; i <= 24_000; i++) {
          insertTask.run(`t-${i}`, run.id, `T${i}`, now, now);
        }
        for (let i = 1; i <= 6_000; i++) {
          const fileName = `t-${i}-summary-1.md`;
          const filePath = join(legacyArtifactsDir, fileName);
          insertArtifact.run(`art-${i}`, run.id, `t-${i}`, filePath, now);
        }
      });
      seedTx();

      for (let i = 1; i <= 6_000; i++) {
        writeFileSync(join(legacyArtifactsDir, `t-${i}-summary-1.md`), "x");
      }

      // Use a tight wall-clock budget (150ms): pre-fix evaluation takes ~30s+ (>> 2x budget) with 0 moved;
      // post-fix returns within 2x budget, reports budgetExceeded, and subsequent passes continue cleanly.
      const budgetMs = 150;
      const t0 = Date.now();
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo], budgetMs });
      const elapsed1 = Date.now() - t0;

      assert.equal(pass1.errors.length, 0, `Unexpected errors: ${JSON.stringify(pass1.errors)}`);
      assert.equal(pass1.budgetExceeded, true, `Expected pass1 to report budget stop at ${budgetMs}ms (elapsed=${elapsed1}ms)`);
      assert.ok(
        elapsed1 <= budgetMs * 2,
        `Expected pass1 to return within 2x budget (${budgetMs * 2}ms), took ${elapsed1}ms`,
      );

      // A second pass continues and completes within a generous budget.
      const t1 = Date.now();
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo], budgetMs: 10_000 });
      const elapsed2 = Date.now() - t1;
      assert.equal(pass2.errors.length, 0, `Unexpected errors on pass2: ${JSON.stringify(pass2.errors)}`);
      assert.equal(pass2.budgetExceeded, false, `Expected pass2 to finish within 10s (took ${elapsed2}ms)`);
      assert.equal(pass2.totals.remaining, 0);
      assert.equal(pass2.totals.rowsRewritten, 6_000);
      assert.equal(lstatSync(join(legacyArtifactsDir, "t-1-summary-1.md")).isSymbolicLink(), true);
      assert.equal(lstatSync(join(legacyArtifactsDir, "t-6000-summary-1.md")).isSymbolicLink(), true);
    } finally {
      cpDb.close();
    }
  });

  it("F2: both-exist merge bridges before row rewrite on budget stop, completes one unit atomically, and single-file moves never lose the legacy name", () => {
    // Part 1: Advancing test clock at 'after_merge' leaves legacy path readable through the bridge; next pass rewrites rows.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-f2-merge-clock-");
      try {
        const run = cpDb.createRun({
          goal: "F2 merge clock",
          repoRoot: repo,
          baseBranch: "main",
          baseSha: "abc123",
          chatSessionId: "chat-1",
        });
        const task = cpDb.createTask({
          runId: run.id,
          tier: 2,
          kind: "worker",
          title: "W",
          objective: "O",
          profileId: "acp:claude",
        });
        cpDb.updateTask(task.id, { status: "completed" });
        cpDb.updateRunStatus(run.id, "completed");

        const legacyRunDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
        const legacyDossier = join(legacyRunDir, task.id, "dossier.md");
        const destRunDir = join(storage.projectDir(repo), "chats", "chat-1", "artifacts", run.id);
        const destDossier = join(destRunDir, task.id, "dossier.md");
        writeFile(legacyDossier, "legacy-recreated-bytes\n");
        writeFile(destDossier, "existing-dest-bytes\n");
        const art = cpDb.recordArtifact({
          runId: run.id,
          taskId: task.id,
          kind: "dossier",
          path: legacyDossier,
          summary: "d",
        });

        let fakeNow = 10_000;
        let sawAfterMerge = false;
        const pass1 = runStorageMigrationPass(
          {
            sqlite: cpDb.db,
            storage,
            now: () => fakeNow,
            fault: (step, ctx) => {
              if (step === "after_merge" && ctx.memberId === run.id) {
                sawAfterMerge = true;
                // Advance ONLY the clock past the budget without throwing.
                fakeNow += 10_000;
              }
            },
          },
          { repoRoots: [repo], budgetMs: 5_000 },
        );

        assert.equal(sawAfterMerge, true);
        assert.equal(pass1.errors.length, 0);
        assert.equal(pass1.budgetExceeded, true);
        assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true, "Legacy run dir must already be bridged after merge");
        assert.equal(readlinkSync(legacyRunDir), destRunDir);
        assert.equal(readFileSync(legacyDossier, "utf8"), "legacy-recreated-bytes\n");
        const rowAfterPass1 = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
        assert.equal(rowAfterPass1.path, legacyDossier, "Row rewrite should be deferred until next pass");

        const pass2 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: () => fakeNow },
          { repoRoots: [repo], budgetMs: 5_000 },
        );
        assert.equal(pass2.errors.length, 0);
        assert.equal(pass2.totals.rowsRewritten, 1);
        const rowAfterPass2 = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
        assert.equal(rowAfterPass2.path, destDossier);
        assert.equal(readFileSync(legacyDossier, "utf8"), "legacy-recreated-bytes\n");
      } finally {
        cpDb.close();
      }
    }

    // Part 2: Single-file move (plain move path AND merge path) has NO instant without the legacy name.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-f2-single-file-");
      try {
        const plainNote = join(repo, LEGACY_HARNESS_DIR, "notes", "plain.md");
        writeFile(plainNote, "plain-note-content\n");

        const mergeNote = join(repo, LEGACY_HARNESS_DIR, "notes", "merged.md");
        const destMergeNote = join(storage.projectDir(repo), "notes", "merged.md");
        writeFile(mergeNote, "merged-legacy-winner\n");
        writeFile(destMergeNote, "merged-dest-older\n");

        const seenPlainSteps: string[] = [];
        const seenMergeSteps: string[] = [];

        const pass = runStorageMigrationPass(
          {
            sqlite: cpDb.db,
            storage,
            fault: (step, ctx) => {
              if (ctx.memberLegacyPath === plainNote) {
                seenPlainSteps.push(step);
                assert.equal(existsSync(plainNote), true, `plainNote missing at step ${step}`);
                assert.equal(readFileSync(plainNote, "utf8"), "plain-note-content\n");
              }
              if (ctx.memberLegacyPath === mergeNote) {
                seenMergeSteps.push(step);
                assert.equal(existsSync(mergeNote), true, `mergeNote missing at step ${step}`);
                assert.equal(readFileSync(mergeNote, "utf8"), "merged-legacy-winner\n");
              }
            },
          },
          { repoRoots: [repo] },
        );

        assert.equal(pass.errors.length, 0);
        assert.ok(seenPlainSteps.includes("after_rename_into_place"), `Expected after_rename_into_place, got ${seenPlainSteps.join(",")}`);
        assert.ok(seenPlainSteps.includes("before_bridge"), `Expected before_bridge, got ${seenPlainSteps.join(",")}`);
        assert.ok(seenPlainSteps.includes("after_bridge"), `Expected after_bridge, got ${seenPlainSteps.join(",")}`);
        assert.ok(seenMergeSteps.includes("after_merge"), `Expected after_merge, got ${seenMergeSteps.join(",")}`);
        assert.equal(lstatSync(plainNote).isSymbolicLink(), true);
        assert.equal(lstatSync(mergeNote).isSymbolicLink(), true);
        assert.equal(readFileSync(plainNote, "utf8"), "plain-note-content\n");
        assert.equal(readFileSync(mergeNote, "utf8"), "merged-legacy-winner\n");
      } finally {
        cpDb.close();
      }
    }

    // Part 3: Recovery after a kill inside a directory merge (some children moved, dir still real) continues cleanly.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-f2-kill-mid-merge-");
      try {
        const run = cpDb.createRun({
          goal: "F2 kill mid merge",
          repoRoot: repo,
          baseBranch: "main",
          baseSha: "abc123",
          chatSessionId: "chat-1",
        });
        const task = cpDb.createTask({
          runId: run.id,
          tier: 2,
          kind: "worker",
          title: "W",
          objective: "O",
          profileId: "acp:claude",
        });
        cpDb.updateTask(task.id, { status: "completed" });
        cpDb.updateRunStatus(run.id, "completed");

        const legacyRunDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
        const destRunDir = join(storage.projectDir(repo), "chats", "chat-1", "artifacts", run.id);
        // Simulate mid-merge kill state: file-a already moved to dest, file-b still in real legacy dir.
        writeFile(join(destRunDir, task.id, "file-a.md"), "a-moved\n");
        writeFile(join(legacyRunDir, task.id, "file-b.md"), "b-remaining\n");
        const artA = cpDb.recordArtifact({
          runId: run.id,
          taskId: task.id,
          kind: "dossier",
          path: join(legacyRunDir, task.id, "file-a.md"),
          summary: "a",
        });
        const artB = cpDb.recordArtifact({
          runId: run.id,
          taskId: task.id,
          kind: "dossier",
          path: join(legacyRunDir, task.id, "file-b.md"),
          summary: "b",
        });

        const pass = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
        assert.equal(pass.errors.length, 0);
        assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);
        assert.equal(readFileSync(join(legacyRunDir, task.id, "file-a.md"), "utf8"), "a-moved\n");
        assert.equal(readFileSync(join(legacyRunDir, task.id, "file-b.md"), "utf8"), "b-remaining\n");
        assert.equal(
          (cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(artA.id) as { path: string }).path,
          join(destRunDir, task.id, "file-a.md"),
        );
        assert.equal(
          (cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(artB.id) as { path: string }).path,
          join(destRunDir, task.id, "file-b.md"),
        );
      } finally {
        cpDb.close();
      }
    }
  });

  it("F3: a budget stop keeps pre-existing journal entries (z.md/a.md recovery) and recreated bridges reset createdAt", () => {
    // Part 1: Review's z.md + a.md sequence (plus newly pre-journaled untouched b.md dropped on budget stop).
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-f3-journal-");
      try {
        const projectDir = storage.ensureProjectDir(repo);
        const legacyZ = join(repo, LEGACY_HARNESS_DIR, "notes", "z.md");
        const destZ = join(projectDir, "notes", "z.md");
        const legacyA = join(repo, LEGACY_HARNESS_DIR, "notes", "a.md");
        const legacyB = join(repo, LEGACY_HARNESS_DIR, "notes", "b.md");

        // Simulate an interrupted move of z.md: bytes at destZ, legacyZ absent, pending note:z.md in journal.
        writeFile(destZ, "z-interrupted-content\n");
        const statePath = join(projectDir, "migration-state.json");
        writeFileSync(
          statePath,
          JSON.stringify(
            {
              version: 1,
              reportedUnknownEntries: [],
              bridges: [],
              pendingUnits: [
                {
                  unitKey: "note:z.md",
                  kind: "note",
                  id: "z.md",
                  repoRoot: repo,
                  ownerChat: null,
                  members: [
                    {
                      kind: "note",
                      id: "z.md",
                      legacyPath: legacyZ,
                      destinationPath: destZ,
                    },
                  ],
                },
              ],
            },
            null,
            2,
          ),
          "utf8",
        );

        // Fallback creates a.md and b.md (both sort before z.md).
        writeFile(legacyA, "a-fallback-content\n");
        writeFile(legacyB, "b-fallback-content\n");

        // Pass 1 pre-journals [a.md, b.md, z.md], completes a.md, then advances clock past budget before b.md/z.md.
        let fakeNow = 50_000;
        const pass1 = runStorageMigrationPass(
          {
            sqlite: cpDb.db,
            storage,
            now: () => fakeNow,
            fault: (step, ctx) => {
              if (step === "after_bridge" && ctx.memberId === "a.md") {
                fakeNow += 10_000;
              }
            },
          },
          { repoRoots: [repo], budgetMs: 5_000 },
        );

        assert.equal(pass1.errors.length, 0);
        assert.equal(pass1.budgetExceeded, true);
        assert.equal(lstatSync(legacyA).isSymbolicLink(), true, "a.md should have migrated");
        assert.equal(lstatSync(legacyB).isFile(), true, "b.md should remain untouched real file");
        assert.equal(existsSync(legacyZ), false, "z.md was not reached yet before budget stop");

        // Inspect persisted journal: pre-existing note:z.md MUST survive; newly pre-journaled unstarted note:b.md MUST be dropped.
        const stateAfterPass1 = JSON.parse(readFileSync(statePath, "utf8")) as {
          pendingUnits: Array<{ unitKey: string }>;
        };
        assert.deepEqual(
          stateAfterPass1.pendingUnits.map((u) => u.unitKey),
          ["note:z.md"],
          "Budget stop must keep pre-existing note:z.md and drop only newly pre-journaled unstarted entries",
        );

        // Pass 2 recovers z.md and migrates b.md cleanly.
        const pass2 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: () => fakeNow },
          { repoRoots: [repo], budgetMs: 5_000 },
        );
        assert.equal(pass2.errors.length, 0);
        assert.equal(pass2.totals.finished, 1, "z.md must be recovered via finish_migration");
        assert.equal(lstatSync(legacyZ).isSymbolicLink(), true);
        assert.equal(readlinkSync(legacyZ), destZ);
        assert.equal(readFileSync(legacyZ, "utf8"), "z-interrupted-content\n");
        assert.equal(lstatSync(legacyB).isSymbolicLink(), true);
      } finally {
        cpDb.close();
      }
    }

    // Part 2: Recreating a bridge for a legacy path with an old bridge record resets createdAt.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-f3-bridge-age-");
      try {
        const legacyNote = join(repo, LEGACY_HARNESS_DIR, "notes", "recreated.md");
        writeFile(legacyNote, "v1\n");

        const t0 = 1_000_000;
        const pass1 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: () => t0 },
          { repoRoots: [repo] },
        );
        assert.equal(pass1.errors.length, 0);
        assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);

        // Nearly 7 days later (100ms before expiry), fallback replaces the bridge symlink with a real legacy file.
        const tRecreate = t0 + BRIDGE_MAX_AGE_MS - 100;
        rmSync(legacyNote);
        writeFile(legacyNote, "v2-recreated\n");

        const pass2 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: () => tRecreate },
          { repoRoots: [repo] },
        );
        assert.equal(pass2.errors.length, 0);
        assert.equal(pass2.totals.merged, 1);
        assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);

        // 101ms later (past t0 + 7d, but only 101ms after recreation): bridge MUST NOT expire!
        const pass3 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: () => tRecreate + 101 },
          { repoRoots: [repo] },
        );
        assert.equal(pass3.errors.length, 0);
        assert.equal(pass3.totals.bridgesRemoved, 0, "Recreated bridge must not expire 101ms after recreation");
        assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);

        // 6 days after recreation: still kept!
        const pass4 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: () => tRecreate + BRIDGE_MAX_AGE_MS - 1_000 },
          { repoRoots: [repo] },
        );
        assert.equal(pass4.totals.bridgesRemoved, 0);
        assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);

        // Full 7 days after recreation: now eligible for expiry!
        const pass5 = runStorageMigrationPass(
          { sqlite: cpDb.db, storage, now: () => tRecreate + BRIDGE_MAX_AGE_MS },
          { repoRoots: [repo] },
        );
        assert.equal(pass5.errors.length, 0);
        assert.equal(pass5.totals.bridgesRemoved, 1);
        assert.equal(existsSync(legacyNote), false);
      } finally {
        cpDb.close();
      }
    }
  });

  it("F4: root collision never renames another unit's live run directory and reports the colliding legacy member", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-f4-root-collision-");
    try {
      // Settled run-1 in chat-1 owns a legacy flat artifact literally named "run-2".
      const run1 = cpDb.createRun({
        goal: "Settled run 1",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-1",
      });
      const t1 = cpDb.createTask({
        runId: run1.id,
        tier: 2,
        kind: "worker",
        title: "T1",
        objective: "O1",
        profileId: "acp:claude",
      });
      cpDb.updateTask(t1.id, { status: "completed" });
      cpDb.updateRunStatus(run1.id, "completed");

      // Active run-2 in chat-1 already has its live data-dir artifacts/run-2/t-2 directory and a running task.
      const run2 = cpDb.createRun({
        goal: "Active run 2",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-1",
      });
      const t2 = cpDb.createTask({
        runId: run2.id,
        tier: 2,
        kind: "worker",
        title: "T2",
        objective: "O2",
        profileId: "acp:claude",
      });
      cpDb.updateTask(t2.id, { status: "running" });

      const projectDir = storage.projectDir(repo);
      const legacyFlatNamedRun2 = join(repo, LEGACY_HARNESS_DIR, "artifacts", run2.id);
      writeFile(legacyFlatNamedRun2, "flat-spill-named-like-run-2\n");
      const flatArt = cpDb.recordArtifact({
        runId: run1.id,
        taskId: t1.id,
        kind: "dossier",
        path: legacyFlatNamedRun2,
        summary: "colliding flat spill",
      });

      const liveRun2Dir = join(projectDir, "chats", "chat-1", "artifacts", run2.id);
      const liveRun2Dossier = join(liveRun2Dir, t2.id, "live-dossier.md");
      writeFile(liveRun2Dossier, "live-run-2-active-work\n");

      const plan = planStorageMigration({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      const plannedFlat = plan.repos[0]!.units.find((u) => u.unitKey === `flat_artifact:${run2.id}`);
      assert.equal(plannedFlat?.action, "defer", "Plan must defer member colliding with another unit's directory");
      assert.ok(plan.repos[0]!.errors.length >= 1, "Plan must report collision error");

      const pass = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.ok(pass.errors.length >= 1, "Pass must report colliding flat member as an error");
      assert.ok(
        pass.errors.some((e) => e.unitKey === `flat_artifact:${run2.id}` || e.path === legacyFlatNamedRun2),
        `Expected error naming flat_artifact:${run2.id}, got ${JSON.stringify(pass.errors)}`,
      );
      assert.equal(pass.totals.merged, 0);
      assert.equal(pass.totals.migrated, 0);
      assert.ok(
        pass.repos[0]!.deferred.some((u) => u.unitKey === `flat_artifact:${run2.id}`),
        `Expected flat_artifact:${run2.id} to be deferred`,
      );

      // Active run-2 directory and its live dossier MUST remain untouched in place with no .pre-merge-* rename.
      assert.equal(lstatSync(liveRun2Dir).isDirectory(), true, "Live run-2 directory must remain a directory in place");
      assert.equal(readFileSync(liveRun2Dossier, "utf8"), "live-run-2-active-work\n");
      const artifactsEntries = readdirSync(join(projectDir, "chats", "chat-1", "artifacts"));
      assert.deepEqual(artifactsEntries, [run2.id], `Must not create .pre-merge-* sibling for live run dir: ${artifactsEntries.join(",")}`);

      // Legacy flat file stays untouched and its DB row stays unrewritten.
      assert.equal(lstatSync(legacyFlatNamedRun2).isFile(), true);
      assert.equal(readFileSync(legacyFlatNamedRun2, "utf8"), "flat-spill-named-like-run-2\n");
      const rowAfter = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(flatArt.id) as { path: string };
      assert.equal(rowAfter.path, legacyFlatNamedRun2);
    } finally {
      cpDb.close();
    }
  });

  it("F6: ambiguous relative flat row defers both repos' spills while its run is non-terminal even with an achieved linked goal", () => {
    const root = makeTempDir("pi-mig-f6-ambig-run-");
    const stateDir = join(root, "state");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });
    const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    const goals = new GoalEngine(cpDb.db);
    const storage = storagePaths({ stateDir }, { layout: "data-dir" });
    try {
      // Register both repos as known repos via settled runs.
      const rA = cpDb.createRun({ goal: "A", repoRoot: repoA, baseBranch: "main", baseSha: "aaa", chatSessionId: "chat-a" });
      const rB = cpDb.createRun({ goal: "B", repoRoot: repoB, baseBranch: "main", baseSha: "bbb", chatSessionId: "chat-b" });
      cpDb.updateRunStatus(rA.id, "completed");
      cpDb.updateRunStatus(rB.id, "completed");

      // Older run with unknown repo root, status='active', linked to an ACHIEVED goal, with NO live tasks.
      const achievedGoal = goals.createGoal({
        repoRoot: repoA,
        chatSessionId: "chat-a",
        title: "Achieved goal with still-active linked run",
        description: "F6",
        criteria: [{ id: "c1", description: "done", kind: "behavioral" }],
      });
      const activeRun = cpDb.createRun({
        goal: "Older active run",
        repoRoot: repoA,
        baseBranch: "main",
        baseSha: "ccc",
        chatSessionId: "chat-a",
      });
      const doneTask = cpDb.createTask({
        runId: activeRun.id,
        tier: 2,
        kind: "worker",
        title: "Done task",
        objective: "O",
        profileId: "acp:claude",
      });
      cpDb.updateTask(doneTask.id, { status: "completed" });
      goals.linkRunAndStart(achievedGoal.id, activeRun.id);
      goals.setStatus(achievedGoal.id, "achieved");
      // Clear repo_root on activeRun (simulating an older run row with unknown repo root) while keeping status='active'.
      cpDb.db.prepare("UPDATE runs SET repo_root = '', status = 'active' WHERE id = ?").run(activeRun.id);

      const relSpillPath = `${LEGACY_HARNESS_DIR}/artifacts/shared-spill.md`;
      const spillA = join(repoA, LEGACY_HARNESS_DIR, "artifacts", "shared-spill.md");
      const spillB = join(repoB, LEGACY_HARNESS_DIR, "artifacts", "shared-spill.md");
      writeFile(spillA, "spill-in-repo-a\n");
      writeFile(spillB, "spill-in-repo-b\n");

      const ambigArt = cpDb.recordArtifact({
        runId: activeRun.id,
        taskId: doneTask.id,
        kind: "dossier",
        path: relSpillPath,
        summary: "ambiguous relative spill",
      });

      const pass = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass.errors.length, 0);
      const deferredSpills = pass.repos.flatMap((r) =>
        r.deferred.filter((u) => u.unitKey === "flat_artifact:shared-spill.md"),
      );
      assert.equal(deferredSpills.length, 2, "Both repos' spills must be deferred while ambiguous owner run is active");

      // Both legacy files remain real files untouched and the ambiguous row stays unrewritten.
      assert.equal(lstatSync(spillA).isFile(), true);
      assert.equal(lstatSync(spillA).isSymbolicLink(), false);
      assert.equal(lstatSync(spillB).isFile(), true);
      assert.equal(lstatSync(spillB).isSymbolicLink(), false);
      const rowAfter = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(ambigArt.id) as { path: string };
      assert.equal(rowAfter.path, relSpillPath);
    } finally {
      cpDb.close();
    }
  });

  it("F7: flat-file bridge whose target is a directory is a wrong-type bridge with no row rewrite and no expiry", () => {
    const { repo, cpDb, storage } = createEnv("pi-mig-f7-wrong-type-flat-");
    try {
      const run = cpDb.createRun({
        goal: "F7 wrong-type flat bridge",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-1",
      });
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "T1",
        objective: "O1",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });
      cpDb.updateRunStatus(run.id, "completed");

      const projectDir = storage.ensureProjectDir(repo);
      const flatName = "t-1-summary-1.md";
      const legacyFlatBridge = join(repo, LEGACY_HARNESS_DIR, "artifacts", flatName);
      const destFlatWrongDir = join(projectDir, "chats", "chat-1", "artifacts", flatName);

      // Destination at the expected chat-1 spelling is a DIRECTORY (wrong type for a flat-file bridge!).
      mkdirSync(destFlatWrongDir, { recursive: true });
      mkdirSync(dirname(legacyFlatBridge), { recursive: true });
      symlinkSync(destFlatWrongDir, legacyFlatBridge);

      const art = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: legacyFlatBridge,
        summary: "indexed flat spill",
      });

      // Record an old bridge provenance entry (> 7 days old) to prove expiry also refuses wrong-type flat bridges.
      const t0 = 1_000_000;
      writeFileSync(
        join(projectDir, "migration-state.json"),
        JSON.stringify(
          {
            version: 1,
            reportedUnknownEntries: [],
            pendingUnits: [],
            bridges: [
              {
                legacyPath: legacyFlatBridge,
                target: destFlatWrongDir,
                createdAt: t0,
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const plan = planStorageMigration(
        { sqlite: cpDb.db, storage, now: () => t0 + BRIDGE_MAX_AGE_MS + 10_000 },
        { repoRoots: [repo] },
      );
      const plannedUnit = plan.repos[0]!.units.find((u) => u.legacyPath === legacyFlatBridge);
      assert.equal(plannedUnit?.kind, "flat_artifact", "Bridge kind must come from legacy unit kind, not target dir type");
      assert.equal(plannedUnit?.action, "defer", "Wrong-type flat bridge must be deferred");

      const pass = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => t0 + BRIDGE_MAX_AGE_MS + 10_000 },
        { repoRoots: [repo] },
      );
      assert.equal(pass.errors.length, 0);
      assert.equal(pass.totals.rowsRewritten, 0, "Wrong-type flat bridge must never rewrite artifact rows");
      assert.equal(pass.totals.bridgesRemoved, 0, "Wrong-type flat bridge must never be removed by 7-day expiry");
      assert.equal(lstatSync(legacyFlatBridge).isSymbolicLink(), true);
      const rowAfter = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
      assert.equal(rowAfter.path, legacyFlatBridge, "Artifact row must stay on legacy path");
    } finally {
      cpDb.close();
    }
  });
});
