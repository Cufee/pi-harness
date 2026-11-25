import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  formatStorageMigrationPlan,
  planStorageMigration,
  runStorageMigrationPass,
} from "../src/storage/migrate.js";
import { createBridgeSymlink, LEGACY_HARNESS_DIR, MIGRATION_CURSOR_FILE } from "../src/storage/migrate/fs.js";
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

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function createEnv(prefix: string) {
  const root = makeTempDir(prefix);
  const stateDir = join(root, "state");
  const repo = join(root, "repo");
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(repo, { recursive: true });
  const cpDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
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

describe("storage migration safety round-2 regressions (A1-A9)", () => {
  it("A4: rename path bridges right after rename before row rewrite, recovery bridges first, and bridge failure rolls rename back", () => {
    // Part 1: Fault after rename + bridge but before row rewrite leaves legacy path readable through bridge,
    // and next pass completes the rows. Also verify recovery of an unbridged moved unit creates bridge first.
    {
      const { repo, cpDb, goals, storage } = createEnv("pi-mig-a4-bridge-");
      try {
        const goal = goals.createGoal({
          repoRoot: repo,
          chatSessionId: "chat-a4",
          title: "A4 goal",
          description: "Bridge before rows",
          criteria: [{ id: "c1", description: "Readable", kind: "behavioral" }],
        });
        const run = cpDb.createRun({
          goal: "A4 run",
          repoRoot: repo,
          baseBranch: "main",
          baseSha: "abc1234",
          chatSessionId: "chat-a4",
        });
        goals.linkRunAndStart(goal.id, run.id);
        const task = cpDb.createTask({
          runId: run.id,
          tier: 2,
          kind: "worker",
          title: "W",
          objective: "Work",
          profileId: "acp:claude",
        });
        cpDb.updateTask(task.id, { status: "completed" });
        cpDb.updateRunStatus(run.id, "completed");
        goals.setStatus(goal.id, "achieved");

        const goalDir = join(repo, LEGACY_HARNESS_DIR, "goals", goal.id);
        const runDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
        const dossier = join(runDir, task.id, "report.md");
        writeFile(join(goalDir, "evidence.md"), "goal-bytes\n");
        writeFile(dossier, "run-dossier-bytes\n");
        const art = cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: dossier, summary: "R" });

        // Inject fault after member 2 (run) is bridged, before row rewrite.
        let faultFired = false;
        const pass1 = runStorageMigrationPass({
          sqlite: cpDb.db,
          storage,
          fault: (step, ctx) => {
            if (step === "after_bridge" && ctx.memberKind === "run") {
              faultFired = true;
              throw new Error("Simulated crash after bridge before row rewrite");
            }
          },
        });
        assert.equal(faultFired, true, "Expected after_bridge to fire before row rewrite on rename path");
        assert.equal(pass1.errors.length, 1);

        // Both legacy paths are already bridged and readable (same bytes), while DB row is still on legacy path.
        assert.equal(lstatSync(goalDir).isSymbolicLink(), true);
        assert.equal(lstatSync(runDir).isSymbolicLink(), true);
        assert.equal(readFileSync(join(goalDir, "evidence.md"), "utf8"), "goal-bytes\n");
        assert.equal(readFileSync(dossier, "utf8"), "run-dossier-bytes\n");
        const rowAfterPass1 = cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
        assert.equal(rowAfterPass1.path, dossier, "Row should not yet be rewritten when fault fired at after_bridge");

        // Next pass finishes row rewrite cleanly.
        const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
        assert.equal(pass2.errors.length, 0);
        assert.equal(pass2.totals.rowsRewritten, 1);
        const destRunDir = join(storage.projectDir(repo), "chats", "chat-a4", "artifacts", run.id);
        const rowAfterPass2 = cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
        assert.equal(rowAfterPass2.path, join(destRunDir, task.id, "report.md"));

        // Recovery of an unbridged moved unit creates bridge FIRST before row rewrite.
        const run2 = cpDb.createRun({
          goal: "A4 recovery",
          repoRoot: repo,
          baseBranch: "main",
          baseSha: "abc1234",
          chatSessionId: "chat-a4",
        });
        const task2 = cpDb.createTask({
          runId: run2.id,
          tier: 2,
          kind: "worker",
          title: "W2",
          objective: "Work2",
          profileId: "acp:claude",
        });
        cpDb.updateTask(task2.id, { status: "completed" });
        cpDb.updateRunStatus(run2.id, "completed");
        const run2Dir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run2.id);
        const doc2 = join(run2Dir, task2.id, "doc2.md");
        writeFile(doc2, "recover-bridge-first\n");
        const art2 = cpDb.recordArtifact({ runId: run2.id, taskId: task2.id, kind: "dossier", path: doc2, summary: "R2" });

        // Crash right after rename before bridge.
        const recPass1 = runStorageMigrationPass({
          sqlite: cpDb.db,
          storage,
          fault: (step, ctx) => {
            if (step === "after_rename_into_place" && ctx.memberId === run2.id) {
              throw new Error("Simulated kill right after rename");
            }
          },
        });
        assert.equal(recPass1.errors.length, 1);
        assert.equal(existsSync(run2Dir), false);

        // On recovery pass, inject fault at after_bridge: bridge must be created BEFORE row rewrite.
        let recBridgeFired = false;
        const recPass2 = runStorageMigrationPass({
          sqlite: cpDb.db,
          storage,
          fault: (step, ctx) => {
            if (step === "after_bridge" && ctx.memberId === run2.id) {
              recBridgeFired = true;
              throw new Error("Simulated crash after recovery bridge before row rewrite");
            }
          },
        });
        assert.equal(recBridgeFired, true, "Recovery must bridge moved unit before row rewrite");
        assert.equal(recPass2.errors.length, 1);
        assert.equal(lstatSync(run2Dir).isSymbolicLink(), true);
        assert.equal(readFileSync(doc2, "utf8"), "recover-bridge-first\n");
        const art2AfterRec2 = cpDb.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art2.id) as { path: string };
        assert.equal(art2AfterRec2.path, doc2, "Rows should not yet be rewritten at recovery after_bridge");

        const recPass3 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
        assert.equal(recPass3.errors.length, 0);
        assert.equal(recPass3.totals.rowsRewritten, 1);
      } finally {
        cpDb.close();
      }
    }

    // Part 2: Bridge creation failure rolls the rename back and reports the unit as an error
    // (both single-file note and multi-member unit where member 2 fails).
    {
      const { repo, cpDb, goals, storage } = createEnv("pi-mig-a4-rollback-");
      try {
        const notePath = join(repo, LEGACY_HARNESS_DIR, "notes", "important.md");
        writeFile(notePath, "keep-me-readable\n");
        const destNote = join(storage.projectDir(repo), "notes", "important.md");

        const goal = goals.createGoal({
          repoRoot: repo,
          chatSessionId: "chat-a4b",
          title: "A4 rollback",
          description: "Multi-member rollback",
          criteria: [{ id: "c1", description: "Safe", kind: "behavioral" }],
        });
        const run = cpDb.createRun({
          goal: "A4 rollback run",
          repoRoot: repo,
          baseBranch: "main",
          baseSha: "abc1234",
          chatSessionId: "chat-a4b",
        });
        goals.linkRunAndStart(goal.id, run.id);
        cpDb.updateRunStatus(run.id, "completed");
        goals.setStatus(goal.id, "achieved");

        const goalDir = join(repo, LEGACY_HARNESS_DIR, "goals", goal.id);
        const runDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
        writeFile(join(goalDir, "g.md"), "goal-ok\n");
        writeFile(join(runDir, "t-1", "r.md"), "run-rollback\n");
        const destRunDir = join(storage.projectDir(repo), "chats", "chat-a4b", "artifacts", run.id);

        const pass = runStorageMigrationPass({
          sqlite: cpDb.db,
          storage,
          createBridge: (legacyPath, destinationPath, canonRepo) => {
            if (legacyPath === notePath || legacyPath === runDir) {
              throw new Error("ENOSPC: simulated bridge creation failure");
            }
            createBridgeSymlink(legacyPath, destinationPath, canonRepo);
          },
        });

        assert.equal(pass.errors.length, 2);

        // Single-file note was rolled back to real file at legacy path; destination absent.
        assert.equal(lstatSync(notePath).isFile(), true);
        assert.equal(lstatSync(notePath).isSymbolicLink(), false);
        assert.equal(readFileSync(notePath, "utf8"), "keep-me-readable\n");
        assert.equal(existsSync(destNote), false);

        // Multi-member unit: member 1 (goal) is bridged and readable; member 2 (run) rolled back to real dir and readable.
        assert.equal(lstatSync(goalDir).isSymbolicLink(), true);
        assert.equal(readFileSync(join(goalDir, "g.md"), "utf8"), "goal-ok\n");
        assert.equal(lstatSync(runDir).isDirectory(), true);
        assert.equal(lstatSync(runDir).isSymbolicLink(), false);
        assert.equal(readFileSync(join(runDir, "t-1", "r.md"), "utf8"), "run-rollback\n");
        assert.equal(existsSync(destRunDir), false);

        // Subsequent normal pass converges everything cleanly.
        const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage });
        assert.equal(pass2.errors.length, 0);
        assert.equal(lstatSync(notePath).isSymbolicLink(), true);
        assert.equal(readFileSync(notePath, "utf8"), "keep-me-readable\n");
        assert.equal(lstatSync(runDir).isSymbolicLink(), true);
        assert.equal(readFileSync(join(runDir, "t-1", "r.md"), "utf8"), "run-rollback\n");
        assert.equal(sha256(readFileSync(destNote)), sha256("keep-me-readable\n"));
      } finally {
        cpDb.close();
      }
    }
  });

  it("A3a: indexes historical run-to-goal links, worktrees, and artifact rows once per pass across many runs with chat history", () => {
    const { root, stateDir, cpDb, goals, storage } = createEnv("pi-mig-a3a-");
    try {
      const repoA = join(root, "repo-a");
      const repoB = join(root, "repo-b");
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });

      // Seed chat history with many chat turns and goal control events across 30 runs in two repos.
      cpDb.db.exec(
        "CREATE TABLE IF NOT EXISTS chat_turns (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, event_json TEXT)",
      );
      const insertTurn = cpDb.db.prepare(
        "INSERT INTO chat_turns (id, session_id, role, event_json) VALUES (?, ?, ?, ?)",
      );

      for (let i = 0; i < 30; i++) {
        const targetRepo = i < 15 ? repoA : repoB;
        const g = goals.createGoal({
          repoRoot: targetRepo,
          chatSessionId: "chat-a3",
          title: `Goal ${i}`,
          description: "Historical run test",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral" }],
        });
        const oldRun = cpDb.createRun({
          goal: `Old run ${i}`,
          repoRoot: targetRepo,
          baseBranch: "main",
          baseSha: "abc1234",
        });
        goals.linkRunAndStart(g.id, oldRun.id);
        cpDb.emitEvent(oldRun.id, null, "goal.committed", { goalId: g.id, version: 1 });
        insertTurn.run(
          `turn-goal-${i}`,
          "chat-a3",
          "system",
          JSON.stringify({ kind: "goal.committed", goalId: g.id, runId: oldRun.id }),
        );
        cpDb.updateRunStatus(oldRun.id, "completed");

        const newRun = cpDb.createRun({
          goal: `New run ${i}`,
          repoRoot: targetRepo,
          baseBranch: "main",
          baseSha: "abc1234",
          chatSessionId: "chat-a3",
        });
        goals.linkRunAndStart(g.id, newRun.id);
        cpDb.updateRunStatus(newRun.id, "completed");
        goals.setStatus(g.id, "achieved");

        const oldRunDir = join(targetRepo, LEGACY_HARNESS_DIR, "artifacts", oldRun.id);
        writeFile(join(oldRunDir, "t-1", "out.md"), `old-${i}\n`);
      }

      // Add extra noise turns so a per-run scan would be very obvious.
      cpDb.db.transaction(() => {
        for (let t = 0; t < 200; t++) {
          insertTurn.run(`turn-noise-${t}`, "chat-a3", "user", JSON.stringify({ kind: "note", index: t }));
        }
      })();

      let eventsQueries = 0;
      let chatTurnsQueries = 0;
      let artifactsQueries = 0;
      let worktreesQueries = 0;
      const origPrepare = cpDb.db.prepare.bind(cpDb.db);
      const spiedDb = new Proxy(cpDb.db, {
        get(target, prop) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("FROM events")) eventsQueries++;
              if (sql.includes("FROM chat_turns")) chatTurnsQueries++;
              if (sql.includes("FROM artifacts")) artifactsQueries++;
              if (sql.includes("FROM worktrees")) worktreesQueries++;
              return origPrepare(sql);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const report = runStorageMigrationPass({ sqlite: spiedDb, storage });
      assert.equal(report.errors.length, 0);
      assert.equal(report.totals.migrated, 30);
      assert.equal(eventsQueries, 1, `Expected 1 events scan per pass, got ${eventsQueries}`);
      assert.equal(chatTurnsQueries, 1, `Expected 1 chat_turns scan per pass, got ${chatTurnsQueries}`);
      assert.equal(artifactsQueries, 1, `Expected 1 artifacts scan per pass, got ${artifactsQueries}`);
      assert.equal(worktreesQueries, 1, `Expected 1 worktrees scan per pass, got ${worktreesQueries}`);
    } finally {
      cpDb.close();
    }
    void stateDir;
  });

  it("A3b: persists repo cursor under data root so a slow first repo never starves a second repo, and deprioritizes budget-hit units", () => {
    const { root, cpDb, storage } = createEnv("pi-mig-a3b-");
    try {
      const repoA = join(root, "repo-a");
      const repoB = join(root, "repo-b");
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });

      // Repo A has a multi-file forced-copy run that cannot finish within a 150ms injected clock budget.
      const runA = cpDb.createRun({
        goal: "Slow repo A",
        repoRoot: repoA,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-a",
      });
      cpDb.updateRunStatus(runA.id, "completed");
      const runADir = join(repoA, LEGACY_HARNESS_DIR, "artifacts", runA.id);
      for (let i = 0; i < 10; i++) {
        writeFile(join(runADir, "t-1", `blob-${String(i).padStart(2, "0")}.bin`), "A".repeat(140_000));
      }
      // Also a small note in repo A to verify budget-deferred unit deprioritization within the same repo.
      const smallNoteA = join(repoA, LEGACY_HARNESS_DIR, "notes", "small-a.md");
      writeFile(smallNoteA, "small note in repo A\n");

      // Repo B has a small run that easily fits in the same 150ms budget.
      const runB = cpDb.createRun({
        goal: "Fast repo B",
        repoRoot: repoB,
        baseBranch: "main",
        baseSha: "abc1234",
        chatSessionId: "chat-b",
      });
      cpDb.updateRunStatus(runB.id, "completed");
      const runBDir = join(repoB, LEGACY_HARNESS_DIR, "artifacts", runB.id);
      writeFile(join(runBDir, "t-1", "fast.md"), "fast-b\n");

      const BUDGET_MS = 280;
      const newClock = () => {
        let t = 10_000;
        return () => {
          t += 5;
          return t;
        };
      };

      // Pass 1 starts at repo-a, hits budget on runA, and advances cursor to repo-b.
      const pass1 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: newClock(), forceCopy: true },
        { budgetMs: BUDGET_MS },
      );
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.budgetExceeded, true);
      assert.equal(lstatSync(runBDir).isDirectory(), true, "Repo B not reached in pass 1");

      const cursorPath = join(storage.dataRoot!, MIGRATION_CURSOR_FILE);
      assert.equal(existsSync(cursorPath), true, "Expected migration-cursor.json under dataRoot");
      const cursor1 = JSON.parse(readFileSync(cursorPath, "utf8")) as { version: number; nextRepoRoot: string | null };
      assert.equal(cursor1.nextRepoRoot, repoB);

      // Verify runA was recorded in repo-a's migration-state.json budgetDeferredUnits.
      const stateA1 = JSON.parse(readFileSync(join(storage.projectDir(repoA), "migration-state.json"), "utf8")) as {
        budgetDeferredUnits?: string[];
      };
      assert.ok(stateA1.budgetDeferredUnits?.includes(`run:${runA.id}`));

      // Pass 2 (same budget) starts at repo-b and migrates repo-b completely within two passes!
      const pass2 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: newClock(), forceCopy: true },
        { budgetMs: BUDGET_MS },
      );
      assert.equal(pass2.errors.length, 0);
      assert.equal(lstatSync(runBDir).isSymbolicLink(), true, "Repo B must migrate within two passes of the same budget");
      assert.equal(readFileSync(join(runBDir, "t-1", "fast.md"), "utf8"), "fast-b\n");

      // Pass 3 (same budget) visits repo-a: smallNoteA is now tried BEFORE budget-deferred runA and migrates!
      const pass3 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: newClock(), forceCopy: true },
        { budgetMs: BUDGET_MS },
      );
      assert.equal(pass3.errors.length, 0);
      assert.equal(lstatSync(smallNoteA).isSymbolicLink(), true, "Small unit must run before previously budget-deferred unit");
    } finally {
      cpDb.close();
    }
  });

  it("A2: rejects a same-size corrupted stage file on resume (legacy survives) and never overwrites a concurrent destination file", () => {
    // Part 1: Same-size modified stage file after an interruption is rejected by verifyCopyMatches and legacy source survives.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-a2-stage-");
      try {
        const run = cpDb.createRun({
          goal: "A2 stage tamper",
          repoRoot: repo,
          baseBranch: "main",
          baseSha: "abc1234",
          chatSessionId: "chat-a2",
        });
        cpDb.updateRunStatus(run.id, "completed");

        const runDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
        const origPayload = "ORIGINAL-PAYLOAD-BYTES-1234567890\n";
        const corruptSameSize = "CORRUPTD-PAYLOAD-BYTES-1234567890\n";
        assert.equal(origPayload.length, corruptSameSize.length);
        const legacyFile = join(runDir, "t-1", "report.md");
        writeFile(legacyFile, origPayload);

        // Pass 1 interrupts after copyToStaging writes the private stage + manifest.
        const pass1 = runStorageMigrationPass({
          sqlite: cpDb.db,
          storage,
          forceCopy: true,
          fault: (step) => {
            if (step === "after_copy") throw new Error("Simulated interruption after staging");
          },
        });
        assert.equal(pass1.errors.length, 1);

        // Tamper with the staged payload using same-size different bytes (without touching source or manifest).
        const projDir = storage.projectDir(repo);
        const state = JSON.parse(readFileSync(join(projDir, "migration-state.json"), "utf8")) as {
          pendingUnits: Array<{ members: Array<{ stagingOpId?: string }> }>;
        };
        const opId = state.pendingUnits[0]!.members[0]!.stagingOpId!;
        assert.ok(opId);
        const stagedFile = join(projDir, ".migration-staging", opId, "payload", "t-1", "report.md");
        writeFileSync(stagedFile, corruptSameSize, "utf8");

        // Pass 2 must hash destination bytes in the same pass, reject the tampered stage, and preserve legacy source!
        const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage, forceCopy: true });
        assert.equal(pass2.errors.length, 1);
        assert.match(pass2.errors[0]!.message, /SHA-256 verification mismatch/);
        assert.equal(lstatSync(runDir).isDirectory(), true, "Legacy run dir must survive");
        assert.equal(lstatSync(runDir).isSymbolicLink(), false);
        assert.equal(readFileSync(legacyFile, "utf8"), origPayload);
        const destRunDir = join(projDir, "chats", "chat-a2", "artifacts", run.id);
        assert.equal(existsSync(destRunDir), false, "Tampered stage must never be installed at destination");
      } finally {
        cpDb.close();
      }
    }

    // Part 2: A destination file created between the absence check and placement on rename path is NOT overwritten.
    {
      const { repo, cpDb, storage } = createEnv("pi-mig-a2-race-");
      try {
        const legacyNote = join(repo, LEGACY_HARNESS_DIR, "notes", "raced.md");
        writeFile(legacyNote, "legacy-winner-bytes\n");
        const destNote = join(storage.projectDir(repo), "notes", "raced.md");
        const concurrentBytes = "concurrent-dest-bytes-must-not-be-lost\n";

        let injected = false;
        const pass = runStorageMigrationPass(
          {
            sqlite: cpDb.db,
            storage,
            fault: (step, ctx) => {
              if (step === "before_rename_into_place" && ctx.memberKind === "note" && !injected) {
                injected = true;
                // Simulate a concurrent writer creating destNote right after safeLstat returned null.
                writeFile(ctx.memberDestinationPath, concurrentBytes);
              }
            },
          },
          { repoRoots: [repo] },
        );
        assert.equal(injected, true);
        assert.equal(pass.errors.length, 0);

        // Legacy note won canonical name, bridge created, AND concurrent dest bytes preserved in .pre-merge-<8hex>!
        assert.equal(lstatSync(legacyNote).isSymbolicLink(), true);
        assert.equal(readFileSync(destNote, "utf8"), "legacy-winner-bytes\n");
        const expectedPreserved = `${destNote}.pre-merge-${sha256(concurrentBytes).slice(0, 8)}`;
        assert.equal(existsSync(expectedPreserved), true, "Concurrent destination bytes must be preserved, never overwritten");
        assert.equal(readFileSync(expectedPreserved, "utf8"), concurrentBytes);
      } finally {
        cpDb.close();
      }
    }
  });

  it("A1: a manifest with a parent-traversing entry removes nothing outside or inside the stage, and sibling files survive", () => {
    const { repo, cpDb, storage } = createEnv("migrate-a1-manifest-");
    try {
      const run = cpDb.createRun({
        goal: "A1 manifest confinement",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-a1",
      });
      cpDb.updateRunStatus(run.id, "completed");
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Task",
        objective: "p",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });

      const runDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
      const keepFile = join(runDir, task.id, "keep.txt");
      const obsoleteFile = join(runDir, task.id, "drop-me.txt");
      writeFile(keepFile, "keep-bytes\n");
      writeFile(obsoleteFile, "drop-bytes\n");
      cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: keepFile, summary: "keep" });

      // Pass 1: stage via forceCopy, abort at after_copy so valid opId + payload + manifest exist.
      const pass1 = runStorageMigrationPass(
        {
          sqlite: cpDb.db,
          storage,
          forceCopy: true,
          fault: (step) => {
            if (step === "after_copy") throw new Error("fault:after_copy");
          },
        },
        { repoRoots: [repo] },
      );
      assert.equal(pass1.errors.length, 1);

      const projectDir = storage.projectDir(repo);
      const stagingRoot = join(projectDir, ".migration-staging");
      const opIds = readdirSync(stagingRoot);
      assert.equal(opIds.length, 1);
      const stageDir = join(stagingRoot, opIds[0]!);
      const payloadDir = join(stageDir, "payload");
      const manifestPath = join(stageDir, "manifest.jsonl");

      // Remove drop-me.txt from legacy so copyToStaging would normally clean it as an obsolete manifest key.
      rmSync(obsoleteFile);

      // Plant sibling files outside payload (in stageDir, .migration-staging, and projectDir).
      const siblingInStage = join(stageDir, "sibling-in-stage.txt");
      const outsideSibling = join(stagingRoot, "outside-sibling.txt");
      const projectVictim = join(projectDir, "victim.txt");
      writeFile(siblingInStage, "stage-sibling-intact\n");
      writeFile(outsideSibling, "outside-sibling-intact\n");
      writeFile(projectVictim, "project-victim-intact\n");

      // Inject parent-traversing entries into manifest.jsonl.
      const existingManifest = readFileSync(manifestPath, "utf8");
      const malicious = [
        JSON.stringify({ relPath: "../sibling-in-stage.txt", size: "21", mtimeNs: "1", ino: "1", sha256: "a".repeat(64) }),
        JSON.stringify({ relPath: "../../outside-sibling.txt", size: "23", mtimeNs: "1", ino: "2", sha256: "b".repeat(64) }),
        JSON.stringify({ relPath: "../../../victim.txt", size: "22", mtimeNs: "1", ino: "3", sha256: "c".repeat(64) }),
      ].join("\n");
      writeFileSync(manifestPath, `${existingManifest}${malicious}\n`, "utf8");

      // Pass 2: must reject the untrusted manifest, report unit as error, and remove NOTHING inside or outside stage.
      const pass2 = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, forceCopy: true },
        { repoRoots: [repo] },
      );
      assert.equal(pass2.errors.length, 1, "Invalid manifest must report the unit as an error");
      assert.match(pass2.errors[0]!.message, /Invalid relative path in stage manifest/);
      assert.equal(pass2.totals.migrated, 0);

      // Sibling files outside payload must survive untouched.
      assert.equal(readFileSync(siblingInStage, "utf8"), "stage-sibling-intact\n");
      assert.equal(readFileSync(outsideSibling, "utf8"), "outside-sibling-intact\n");
      assert.equal(readFileSync(projectVictim, "utf8"), "project-victim-intact\n");

      // Everything inside the stage (even the obsolete file) must survive untouched.
      assert.equal(readFileSync(join(payloadDir, task.id, "keep.txt"), "utf8"), "keep-bytes\n");
      assert.equal(readFileSync(join(payloadDir, task.id, "drop-me.txt"), "utf8"), "drop-bytes\n");
      assert.equal(existsSync(manifestPath), true);

      // Legacy file must remain untouched.
      assert.equal(readFileSync(keepFile, "utf8"), "keep-bytes\n");
    } finally {
      cpDb.close();
    }
  });

  it("A5: resolves unit-root and parent type collisions in one pass while preserving both sides' bytes", () => {
    const { repo, cpDb, storage } = createEnv("migrate-a5-collisions-");
    try {
      const run = cpDb.createRun({
        goal: "A5 root type collisions",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-a5",
      });
      cpDb.updateRunStatus(run.id, "completed");
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Task",
        objective: "p",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });

      const projectDir = storage.projectDir(repo);

      // Shape 1: legacy note file against a data-dir directory of the same name.
      const legacyFileVsDir = join(repo, LEGACY_HARNESS_DIR, "notes", "file-vs-dir");
      const destDirEntry = join(projectDir, "notes", "file-vs-dir", "from-dest.md");
      writeFile(legacyFileVsDir, "legacy-note-file-winner\n");
      writeFile(destDirEntry, "dest-dir-child-preserved\n");

      // Shape 2: data-dir note file where a legacy nested note needs a parent directory.
      const legacyNestedNote = join(repo, LEGACY_HARNESS_DIR, "notes", "parent-file", "child.md");
      const destParentFile = join(projectDir, "notes", "parent-file");
      writeFile(legacyNestedNote, "legacy-nested-child-winner\n");
      writeFile(destParentFile, "dest-parent-file-preserved\n");

      // Shape 3: legacy run directory against a regular file at its destination root.
      const legacyRunDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
      const legacyDossier = join(legacyRunDir, task.id, "dossier.md");
      const destRunRootFile = join(projectDir, "chats", "chat-a5", "artifacts", run.id);
      writeFile(legacyDossier, "legacy-run-dossier-winner\n");
      writeFile(destRunRootFile, "dest-run-root-file-preserved\n");
      cpDb.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: legacyDossier, summary: "d" });

      // All three shapes must converge in ONE pass with zero errors.
      const pass = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass.errors.length, 0, `Unexpected errors: ${JSON.stringify(pass.errors)}`);
      assert.equal(pass.totals.remaining, 0);

      // Verify Shape 1: canonical note is now the legacy file, bridge exists, and dest dir was preserved with its child.
      const destFileVsDir = join(projectDir, "notes", "file-vs-dir");
      assert.equal(lstatSync(legacyFileVsDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyFileVsDir), destFileVsDir);
      assert.equal(lstatSync(destFileVsDir).isFile(), true);
      assert.equal(readFileSync(destFileVsDir, "utf8"), "legacy-note-file-winner\n");
      const shape1Preserved = readdirSync(join(projectDir, "notes")).filter((n) =>
        n.startsWith("file-vs-dir.pre-merge-"),
      );
      assert.equal(shape1Preserved.length, 1);
      assert.equal(
        readFileSync(join(projectDir, "notes", shape1Preserved[0]!, "from-dest.md"), "utf8"),
        "dest-dir-child-preserved\n",
      );

      // Verify Shape 2: canonical parent-file is now a directory containing child.md, bridge exists, and old parent file was preserved.
      const destNestedChild = join(projectDir, "notes", "parent-file", "child.md");
      assert.equal(lstatSync(legacyNestedNote).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyNestedNote), destNestedChild);
      assert.equal(readFileSync(destNestedChild, "utf8"), "legacy-nested-child-winner\n");
      const shape2Preserved = `${destParentFile}.pre-merge-${sha256("dest-parent-file-preserved\n").slice(0, 8)}`;
      assert.equal(existsSync(shape2Preserved), true);
      assert.equal(readFileSync(shape2Preserved, "utf8"), "dest-parent-file-preserved\n");

      // Verify Shape 3: canonical run root is now a directory with dossier.md, bridge exists, row rewritten, and old root file preserved.
      assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true);
      assert.equal(readlinkSync(legacyRunDir), destRunRootFile);
      assert.equal(lstatSync(destRunRootFile).isDirectory(), true);
      assert.equal(readFileSync(join(destRunRootFile, task.id, "dossier.md"), "utf8"), "legacy-run-dossier-winner\n");
      const shape3Preserved = `${destRunRootFile}.pre-merge-${sha256("dest-run-root-file-preserved\n").slice(0, 8)}`;
      assert.equal(existsSync(shape3Preserved), true);
      assert.equal(readFileSync(shape3Preserved, "utf8"), "dest-run-root-file-preserved\n");
      const rewrittenRow = cpDb.db.query("SELECT path FROM artifacts WHERE run_id = ?").get(run.id) as { path: string };
      assert.equal(rewrittenRow.path, join(destRunRootFile, task.id, "dossier.md"));
    } finally {
      cpDb.close();
    }
  });

  it("A6.1: a pending journal entry whose validation hits a DB error stays on disk and takes no part in the pass", () => {
    const { repo, cpDb, storage } = createEnv("migrate-a6-db-error-");
    try {
      const run = cpDb.createRun({
        goal: "A6.1 transient DB error during pending validation",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-a6",
      });
      cpDb.updateRunStatus(run.id, "completed");
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Task",
        objective: "p",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });

      const projectDir = storage.ensureProjectDir(repo);
      const legacyRunDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
      const bogusDest = join(projectDir, "chats", "chat-bogus", "artifacts", run.id);
      writeFile(join(bogusDest, task.id, "dossier.md"), "bogus-dest\n");
      const art = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: join(legacyRunDir, task.id, "dossier.md"),
        summary: "d",
      });

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
                unitKey: `run:${run.id}`,
                kind: "run",
                id: run.id,
                repoRoot: repo,
                ownerChat: "chat-bogus",
                members: [
                  {
                    kind: "run",
                    id: run.id,
                    legacyPath: legacyRunDir,
                    destinationPath: bogusDest,
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

      // Fail ONLY the first `FROM runs WHERE id = ?` (during validatePendingUnits), then allow subsequent queries.
      // Pre-fix, validatePendingUnits pushed the unvalidated entry into validPending, letting it bridge bogusDest & rewrite rows!
      let runsLookupCalls = 0;
      const originalPrepare = cpDb.db.prepare.bind(cpDb.db);
      const flakySqlite = new Proxy(cpDb.db, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              if (sql.includes("FROM runs WHERE id = ?")) {
                runsLookupCalls++;
                if (runsLookupCalls === 1) {
                  throw new Error("SQLITE_BUSY: transient error during pending validation");
                }
              }
              return originalPrepare(sql);
            };
          }
          const value = Reflect.get(target, prop, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      const pass = runStorageMigrationPass({ sqlite: flakySqlite, storage }, { repoRoots: [repo] });
      assert.ok(runsLookupCalls >= 1);
      assert.equal(pass.totals.finished, 0);
      assert.equal(pass.totals.bridgesCreated, 0);
      assert.equal(existsSync(legacyRunDir), false, "Unvalidated pending entry must not create a bridge");
      const rowAfter = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
      assert.equal(rowAfter.path, join(legacyRunDir, task.id, "dossier.md"), "Artifact row must not be rewritten");

      // Pending entry must remain on disk unchanged (not dropped and not marked stale).
      const stateAfter = JSON.parse(readFileSync(statePath, "utf8")) as {
        pendingUnits: Array<{ unitKey: string; stale?: boolean }>;
      };
      assert.equal(stateAfter.pendingUnits.length, 1);
      assert.equal(stateAfter.pendingUnits[0]!.unitKey, `run:${run.id}`);
      assert.equal(stateAfter.pendingUnits[0]!.stale, undefined);
    } finally {
      cpDb.close();
    }
  });

  it("A6.2: a pending entry that fails recomputation is kept as stale, never acted on, and listed by planStorageMigration", () => {
    const { repo, cpDb, storage } = createEnv("migrate-a6-stale-");
    try {
      const projectDir = storage.ensureProjectDir(repo);
      const legacyNote = join(repo, LEGACY_HARNESS_DIR, "notes", "drift.md");
      const bogusDest = join(projectDir, "notes", "wrong-target.md");
      writeFile(bogusDest, "do-not-touch\n");

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
                unitKey: "note:drift.md",
                kind: "note",
                id: "drift.md",
                repoRoot: repo,
                ownerChat: null,
                members: [
                  {
                    kind: "note",
                    id: "drift.md",
                    legacyPath: legacyNote,
                    destinationPath: bogusDest,
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

      // Run pass 1: fails recomputation, marks stale: true, keeps on disk, never acts on it.
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass1.errors.length, 1);
      assert.equal(existsSync(legacyNote), false);
      assert.equal(readFileSync(bogusDest, "utf8"), "do-not-touch\n");

      const stateAfter = JSON.parse(readFileSync(statePath, "utf8")) as {
        pendingUnits: Array<{ unitKey: string; stale?: boolean; staleReason?: string }>;
      };
      assert.equal(stateAfter.pendingUnits.length, 1, "Failed recomputation entry must be kept on disk, not dropped");
      assert.equal(stateAfter.pendingUnits[0]!.stale, true);
      assert.ok(stateAfter.pendingUnits[0]!.staleReason);

      // planStorageMigration (used by --dry-run) must list the stale entry and format it.
      const plan = planStorageMigration({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(plan.repos.length, 1);
      assert.equal(plan.repos[0]!.stalePendingUnits?.length, 1);
      assert.equal(plan.repos[0]!.stalePendingUnits![0]!.unitKey, "note:drift.md");
      const formatted = formatStorageMigrationPlan(plan);
      assert.match(formatted, /Stale pending journal entries \(1\)/);
      assert.match(formatted, /\[stale\] note:drift\.md/);

      // Second pass must keep it on disk without acting on it.
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repo] });
      assert.equal(pass2.errors.length, 0);
      assert.equal(existsSync(legacyNote), false);
      const stateAfter2 = JSON.parse(readFileSync(statePath, "utf8")) as {
        pendingUnits: Array<{ unitKey: string; stale?: boolean }>;
      };
      assert.equal(stateAfter2.pendingUnits.length, 1);
      assert.equal(stateAfter2.pendingUnits[0]!.stale, true);
    } finally {
      cpDb.close();
    }
  });

  it("A6.3: dangling and wrong-type bridges trigger no row rewrite and are never removed by 7-day expiry", () => {
    const { repo, cpDb, storage } = createEnv("migrate-a6-bridges-");
    try {
      const runDangling = cpDb.createRun({
        goal: "A6.3 dangling bridge",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-a6",
      });
      cpDb.updateRunStatus(runDangling.id, "completed");
      const taskD = cpDb.createTask({
        runId: runDangling.id,
        tier: 2,
        kind: "worker",
        title: "T",
        objective: "p",
        profileId: "acp:claude",
      });
      cpDb.updateTask(taskD.id, { status: "completed" });

      const runWrongType = cpDb.createRun({
        goal: "A6.3 wrong-type bridge",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-a6",
      });
      cpDb.updateRunStatus(runWrongType.id, "completed");
      const taskW = cpDb.createTask({
        runId: runWrongType.id,
        tier: 2,
        kind: "worker",
        title: "T",
        objective: "p",
        profileId: "acp:claude",
      });
      cpDb.updateTask(taskW.id, { status: "completed" });

      const projectDir = storage.ensureProjectDir(repo);
      const legacyDangling = join(repo, LEGACY_HARNESS_DIR, "artifacts", runDangling.id);
      const destDangling = join(projectDir, "chats", "chat-a6", "artifacts", runDangling.id); // does NOT exist!
      mkdirSync(dirname(legacyDangling), { recursive: true });
      symlinkSync(destDangling, legacyDangling);

      const legacyWrongRun = join(repo, LEGACY_HARNESS_DIR, "artifacts", runWrongType.id);
      const destWrongRun = join(projectDir, "chats", "chat-a6", "artifacts", runWrongType.id);
      writeFile(destWrongRun, "regular-file-not-a-dir\n"); // wrong type for directory unit!
      symlinkSync(destWrongRun, legacyWrongRun);

      const legacyWrongNote = join(repo, LEGACY_HARNESS_DIR, "notes", "dir-not-file.md");
      const destWrongNote = join(projectDir, "notes", "dir-not-file.md");
      mkdirSync(destWrongNote, { recursive: true }); // wrong type for file unit!
      mkdirSync(dirname(legacyWrongNote), { recursive: true });
      symlinkSync(destWrongNote, legacyWrongNote);

      const artD = cpDb.recordArtifact({
        runId: runDangling.id,
        taskId: taskD.id,
        kind: "dossier",
        path: join(legacyDangling, taskD.id, "d.md"),
        summary: "d",
      });
      const artW = cpDb.recordArtifact({
        runId: runWrongType.id,
        taskId: taskW.id,
        kind: "dossier",
        path: join(legacyWrongRun, taskW.id, "w.md"),
        summary: "w",
      });

      // Pre-record all three bridges with createdAt older than 7 days so expiry would remove them if accepted.
      const t0 = 1_700_000_000_000;
      const oldCreatedAt = t0 - BRIDGE_MAX_AGE_MS - 60_000;
      writeFileSync(
        join(projectDir, "migration-state.json"),
        JSON.stringify(
          {
            version: 1,
            reportedUnknownEntries: [],
            pendingUnits: [],
            bridges: [
              { legacyPath: legacyDangling, target: destDangling, createdAt: oldCreatedAt },
              { legacyPath: legacyWrongRun, target: destWrongRun, createdAt: oldCreatedAt },
              { legacyPath: legacyWrongNote, target: destWrongNote, createdAt: oldCreatedAt },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      const pass = runStorageMigrationPass(
        { sqlite: cpDb.db, storage, now: () => t0 },
        { repoRoots: [repo] },
      );
      assert.equal(pass.totals.rowsRewritten, 0, "Dangling or wrong-type bridges must trigger no row rewrite");
      assert.equal(pass.totals.bridgesRemoved, 0, "Dangling or wrong-type bridges must not be expired");

      // All three symlinks must remain untouched on disk.
      assert.equal(lstatSync(legacyDangling).isSymbolicLink(), true);
      assert.equal(lstatSync(legacyWrongRun).isSymbolicLink(), true);
      assert.equal(lstatSync(legacyWrongNote).isSymbolicLink(), true);

      // Both artifact rows must remain on their legacy paths.
      const rowD = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(artD.id) as { path: string };
      const rowW = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(artW.id) as { path: string };
      assert.equal(rowD.path, join(legacyDangling, taskD.id, "d.md"));
      assert.equal(rowW.path, join(legacyWrongRun, taskW.id, "w.md"));
    } finally {
      cpDb.close();
    }
  });

  it("A7: after a copy with leftovers, only moved/verified files have their rows rewritten while changed legacy files keep their legacy row", () => {
    const { repo, cpDb, storage } = createEnv("migrate-a7-leftover-rows-");
    try {
      const run = cpDb.createRun({
        goal: "A7 selective row rewrite on copy leftovers",
        repoRoot: repo,
        baseBranch: "main",
        baseSha: "abc123",
        chatSessionId: "chat-a7",
      });
      cpDb.updateRunStatus(run.id, "completed");
      const task = cpDb.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Task",
        objective: "p",
        profileId: "acp:claude",
      });
      cpDb.updateTask(task.id, { status: "completed" });

      const runDir = join(repo, LEGACY_HARNESS_DIR, "artifacts", run.id);
      const movedFile = join(runDir, task.id, "moved.md");
      const changedFile = join(runDir, task.id, "changed.md");
      writeFile(movedFile, "moved-v1\n");
      writeFile(changedFile, "changed-v1\n");

      const artMoved = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: movedFile,
        summary: "moved",
      });
      const artChanged = cpDb.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: changedFile,
        summary: "changed",
      });

      let mutated = false;
      const pass1 = runStorageMigrationPass(
        {
          sqlite: cpDb.db,
          storage,
          forceCopy: true,
          fault: (step) => {
            if (step === "after_rename_into_place" && !mutated) {
              mutated = true;
              // Modify changed.md in legacy right before deleteVerifiedLegacy runs so it is left behind.
              writeFileSync(changedFile, "changed-v2-newer-in-legacy\n", "utf8");
            }
          },
        },
        { repoRoots: [repo] },
      );
      assert.equal(mutated, true);
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.totals.rowsRewritten, 1, "Only the moved file's row should be rewritten");

      const destRunDir = join(storage.projectDir(repo), "chats", "chat-a7", "artifacts", run.id);
      const movedRow = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(artMoved.id) as { path: string };
      const changedRow = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(artChanged.id) as {
        path: string;
      };
      assert.equal(movedRow.path, join(destRunDir, task.id, "moved.md"), "Moved file row should point to data-dir");
      assert.equal(changedRow.path, changedFile, "Changed file left in legacy must keep its row on the legacy path");
      assert.equal(readFileSync(changedFile, "utf8"), "changed-v2-newer-in-legacy\n");

      // Next pass merges the changed file, preserves v1 in .pre-merge, rewrites changedRow, and creates the bridge.
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage, forceCopy: true }, { repoRoots: [repo] });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.merged, 1);
      assert.equal(pass2.totals.rowsRewritten, 1);
      const changedRowAfter = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(artChanged.id) as {
        path: string;
      };
      assert.equal(changedRowAfter.path, join(destRunDir, task.id, "changed.md"));
      assert.equal(readFileSync(join(destRunDir, task.id, "changed.md"), "utf8"), "changed-v2-newer-in-legacy\n");
      assert.equal(lstatSync(runDir).isSymbolicLink(), true);
    } finally {
      cpDb.close();
    }
  });

  it("A8: a flat spill file named by an ambiguous relative row is deferred while that row's task is live, and the row stays unrewritten", () => {
    const { root, cpDb, storage } = createEnv("migrate-a8-ambiguous-flat-");
    try {
      const repoA = join(root, "repo-a");
      const repoB = join(root, "repo-b");
      mkdirSync(repoA, { recursive: true });
      mkdirSync(repoB, { recursive: true });

      const spillA = join(repoA, LEGACY_HARNESS_DIR, "artifacts", "shared-spill.log");
      const spillB = join(repoB, LEGACY_HARNESS_DIR, "artifacts", "shared-spill.log");
      writeFile(spillA, "repo-a-live-spill\n");
      writeFile(spillB, "repo-b-live-spill\n");

      // Register both repos in DB so the relative row is ambiguous across repos, and create a live task whose run has no repo_root.
      const doneRunA = cpDb.createRun({ goal: "A", repoRoot: repoA, baseBranch: "main", baseSha: "aaa111" });
      cpDb.updateRunStatus(doneRunA.id, "completed");
      const doneRunB = cpDb.createRun({ goal: "B", repoRoot: repoB, baseBranch: "main", baseSha: "bbb222" });
      cpDb.updateRunStatus(doneRunB.id, "completed");

      const liveTaskRun = cpDb.createRun({ goal: "Live task run", repoRoot: "", baseBranch: "main", baseSha: "ccc333" });
      cpDb.updateRunStatus(liveTaskRun.id, "completed");
      const liveTask = cpDb.createTask({
        runId: liveTaskRun.id,
        tier: 2,
        kind: "worker",
        title: "Live spill owner",
        objective: "p",
        profileId: "acp:claude",
      });
      cpDb.updateTask(liveTask.id, { status: "running" });

      const relPath = `${LEGACY_HARNESS_DIR}/artifacts/shared-spill.log`;
      const art = cpDb.recordArtifact({
        runId: liveTaskRun.id,
        taskId: liveTask.id,
        kind: "dossier",
        path: relPath,
        summary: "ambiguous relative flat spill",
      });

      // Pass 1: while liveTask is running, both repos must defer shared-spill.log and keep the row unrewritten.
      const pass1 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repoA, repoB] });
      assert.equal(pass1.errors.length, 0);
      assert.equal(pass1.totals.migrated, 0, "Flat spill file with live ambiguous owner must be deferred");
      assert.equal(pass1.totals.deferred, 2);
      assert.equal(lstatSync(spillA).isFile(), true);
      assert.equal(lstatSync(spillB).isFile(), true);
      const rowAfter1 = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
      assert.equal(rowAfter1.path, relPath, "Ambiguous row must never be rewritten");

      // Pass 2: once liveTask is terminal, the flat spill files migrate, and the ambiguous row STILL is not rewritten.
      cpDb.updateTask(liveTask.id, { status: "completed" });
      const pass2 = runStorageMigrationPass({ sqlite: cpDb.db, storage }, { repoRoots: [repoA, repoB] });
      assert.equal(pass2.errors.length, 0);
      assert.equal(pass2.totals.migrated, 2);
      assert.equal(lstatSync(spillA).isSymbolicLink(), true);
      assert.equal(lstatSync(spillB).isSymbolicLink(), true);
      const rowAfter2 = cpDb.db.query("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string };
      assert.equal(rowAfter2.path, relPath, "Ambiguous row must still remain unrewritten after migration");
    } finally {
      cpDb.close();
    }
  });

  it("A9: discovers a notes-only repo whose path ends in a space without touching its trimmed sibling", () => {
    const { root, cpDb, storage } = createEnv("migrate-a9-trailing-space-");
    try {
      const repoSpaced = join(root, "notes-repo ");
      const repoTrimmed = join(root, "notes-repo");
      mkdirSync(repoSpaced, { recursive: true });
      mkdirSync(repoTrimmed, { recursive: true });

      const spacedNote = join(repoSpaced, LEGACY_HARNESS_DIR, "notes", "spaced.md");
      const trimmedNote = join(repoTrimmed, LEGACY_HARNESS_DIR, "notes", "untouched.md");
      writeFile(spacedNote, "trailing-space-repo-note\n");
      writeFile(trimmedNote, "trimmed-sibling-must-not-be-touched\n");

      // Register ONLY the trailing-space repo as a notes-only project (no runs, no explicit repoRoots).
      const now = Date.now();
      cpDb.db
        .prepare("INSERT INTO projects(id, name, root_path, created_at, updated_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("proj-spaced", "notes-repo ", repoSpaced, now, now, now);

      const pass = runStorageMigrationPass({ sqlite: cpDb.db, storage });
      assert.equal(pass.errors.length, 0);
      assert.equal(pass.totals.migrated, 1);

      // Spaced repo note must be migrated and bridged.
      const destSpaced = join(storage.projectDir(repoSpaced), "notes", "spaced.md");
      assert.equal(lstatSync(spacedNote).isSymbolicLink(), true);
      assert.equal(readlinkSync(spacedNote), destSpaced);
      assert.equal(readFileSync(destSpaced, "utf8"), "trailing-space-repo-note\n");

      // Trimmed sibling must remain completely untouched.
      assert.equal(lstatSync(trimmedNote).isFile(), true);
      assert.equal(readFileSync(trimmedNote, "utf8"), "trimmed-sibling-must-not-be-touched\n");
      assert.equal(existsSync(storage.projectDir(repoTrimmed)), false);
    } finally {
      cpDb.close();
    }
  });
});
