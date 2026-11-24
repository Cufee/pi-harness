import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { describe, it } from "bun:test";
import { AdmissionQueue } from "../src/control-plane/admission-queue.js";
import { GoalEngine } from "../src/goals/engine.js";

describe("goal-26 slice A: AdmissionQueue canonical repoRoot/forceStart order & GoalEngine.updateBudgets", () => {
  it("(a) shares one queue across symlink alias and real path with canonical repoRoot and consistent peekNext", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-goal26-slice-a-sym-")));
    const realRepo = join(root, "real-repo");
    const aliasRepo = join(root, "alias-repo");
    mkdirSync(realRepo, { recursive: true });
    symlinkSync(realRepo, aliasRepo);

    const db = new Database(":memory:");
    try {
      const queue = new AdmissionQueue(db);

      const first = queue.enqueue({ lane: "goal", repoRoot: aliasRepo, targetId: "goal-1" });
      const second = queue.enqueue({ lane: "goal", repoRoot: realRepo, targetId: "goal-2" });

      assert.equal(first.repoRoot, realRepo);
      assert.equal(first.position, 1);
      assert.equal(second.repoRoot, realRepo);
      assert.equal(second.position, 2);

      const viaAlias = queue.list({ lane: "goal", repoRoot: aliasRepo });
      const viaReal = queue.list({ lane: "goal", repoRoot: realRepo });
      assert.deepEqual(
        viaAlias.map((e) => ({ targetId: e.targetId, position: e.position, repoRoot: e.repoRoot })),
        [
          { targetId: "goal-1", position: 1, repoRoot: realRepo },
          { targetId: "goal-2", position: 2, repoRoot: realRepo },
        ],
      );
      assert.deepEqual(viaReal, viaAlias);

      const nextViaAlias = queue.peekNext("goal", aliasRepo);
      const nextViaReal = queue.peekNext("goal", realRepo);
      assert.equal(nextViaAlias?.targetId, "goal-1");
      assert.equal(nextViaAlias?.repoRoot, realRepo);
      assert.equal(nextViaReal?.targetId, "goal-1");
      assert.equal(nextViaReal?.repoRoot, realRepo);

      assert.equal(queue.isFrontOrForced("goal", aliasRepo, "goal-1"), true);
      assert.equal(queue.isFrontOrForced("goal", realRepo, "goal-1"), true);
      assert.equal(queue.isFrontOrForced("goal", aliasRepo, "goal-2"), false);
      assert.equal(queue.isFrontOrForced("goal", realRepo, "goal-2"), false);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(b) keeps forceStart entries partitioned ahead and renumbered across markForceStart, forced enqueue, and remove", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-goal26-slice-a-force-")));
    const db = new Database(":memory:");
    try {
      const queue = new AdmissionQueue(db);
      const notifications: Array<string | undefined> = [];
      queue.onChange((lane) => notifications.push(lane));

      queue.enqueue({ lane: "goal", repoRoot: root, targetId: "A" });
      queue.enqueue({ lane: "goal", repoRoot: root, targetId: "B" });
      queue.enqueue({ lane: "goal", repoRoot: root, targetId: "C" });
      notifications.length = 0;

      const forcedC = queue.markForceStart("goal", "C");
      assert.ok(forcedC);
      assert.equal(forcedC.forceStart, true);
      assert.equal(forcedC.position, 1);
      assert.deepEqual(notifications, ["goal"]);

      const afterMark = queue.list({ lane: "goal", repoRoot: root });
      assert.deepEqual(
        afterMark.map((e) => [e.targetId, e.position, e.forceStart]),
        [
          ["C", 1, true],
          ["A", 2, false],
          ["B", 3, false],
        ],
      );
      assert.deepEqual(
        afterMark.map((e) => e.position),
        afterMark.map((_, i) => i + 1),
      );

      const forcedD = queue.enqueue({ lane: "goal", repoRoot: root, targetId: "D", forceStart: true });
      assert.equal(forcedD.forceStart, true);
      assert.equal(forcedD.position, 2);

      const afterForcedEnqueue = queue.list({ lane: "goal", repoRoot: root });
      assert.deepEqual(
        afterForcedEnqueue.map((e) => [e.targetId, e.position, e.forceStart]),
        [
          ["C", 1, true],
          ["D", 2, true],
          ["A", 3, false],
          ["B", 4, false],
        ],
      );

      assert.equal(queue.remove("goal", "C"), true);
      const afterRemove = queue.list({ lane: "goal", repoRoot: root });
      assert.deepEqual(
        afterRemove.map((e) => [e.targetId, e.position, e.forceStart]),
        [
          ["D", 1, true],
          ["A", 2, false],
          ["B", 3, false],
        ],
      );
      assert.equal(queue.peekNext("goal", root)?.targetId, "D");

      notifications.length = 0;
      assert.equal(queue.markForceStart("goal", "missing"), null);
      assert.deepEqual(notifications, []);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(c) migrates and renumbers legacy non-canonical repo_root rows on AdmissionQueue construction", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-goal26-slice-a-mig-")));
    const realRepo = join(root, "real-repo");
    const aliasOne = join(root, "alias-1");
    const aliasTwo = join(root, "alias-2");
    mkdirSync(realRepo, { recursive: true });
    symlinkSync(realRepo, aliasOne);
    symlinkSync(realRepo, aliasTwo);

    const db = new Database(":memory:");
    try {
      // Initialize schema once, then seed raw legacy alias rows directly into SQLite.
      new AdmissionQueue(db);
      const insertRaw = db.prepare(
        `INSERT INTO admission_queue(lane, repo_root, target_id, position, force_start, launch_opts_json, note, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      );
      insertRaw.run("goal", realRepo, "g-real", 1, 0, 100);
      insertRaw.run("goal", aliasOne, "g-alias", 1, 0, 200);
      insertRaw.run("goal", aliasTwo, "g-forced-alias", 2, 1, 300);
      insertRaw.run("worker", aliasOne, "w-alias", 5, 0, 150);

      const migrated = new AdmissionQueue(db);

      const goalEntries = migrated.list({ lane: "goal", repoRoot: realRepo });
      assert.deepEqual(
        goalEntries.map((e) => [e.targetId, e.position, e.forceStart, e.repoRoot]),
        [
          ["g-forced-alias", 1, true, realRepo],
          ["g-real", 2, false, realRepo],
          ["g-alias", 3, false, realRepo],
        ],
      );
      assert.deepEqual(migrated.list({ lane: "goal", repoRoot: aliasOne }), goalEntries);

      const workerEntries = migrated.list({ lane: "worker", repoRoot: realRepo });
      assert.deepEqual(
        workerEntries.map((e) => [e.targetId, e.position, e.repoRoot]),
        [["w-alias", 1, realRepo]],
      );

      const distinctRoots = db
        .prepare("SELECT DISTINCT repo_root FROM admission_queue")
        .all() as Array<{ repo_root: string }>;
      assert.deepEqual(
        distinctRoots.map((r) => r.repo_root),
        [realRepo],
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("(d) GoalEngine.updateBudgets updates budgets in place without mutating version/counters/status and rejects invalid or terminal goals", () => {
    const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-goal26-slice-a-budgets-")));
    const db = new Database(":memory:");
    const invalidated: string[] = [];
    try {
      const engine = new GoalEngine(db, (id) => invalidated.push(id));
      const created = engine.createGoal({
        repoRoot,
        title: "Budget update test",
        description: "Verify in-place budget updates",
        criteria: [{ id: "c1", description: "passes", kind: "deterministic", command: "true", required: true }],
        budgets: {
          maxReviewCycles: 2,
          maxNoProgressCycles: 2,
          maxWallClockMin: 45,
          maxApiEquivUsd: 12.5,
        },
      });

      engine.setStatus(created.id, "awaiting_human", "Max review cycles reached (2/2)");
      db.prepare("UPDATE goals SET review_cycle = 2, no_progress_streak = 1, updated_at = ? WHERE id = ?").run(
        created.updatedAt - 10,
        created.id,
      );
      const beforeUpdate = engine.getGoal(created.id)!;

      const { goal: updated, before } = engine.updateBudgets(created.id, { maxReviewCycles: 3 });
      assert.deepEqual(before, {
        maxReviewCycles: 2,
        maxNoProgressCycles: 2,
        maxWallClockMin: 45,
        maxApiEquivUsd: 12.5,
      });
      assert.deepEqual(updated.budgets, {
        maxReviewCycles: 3,
        maxNoProgressCycles: 2,
        maxWallClockMin: 45,
        maxApiEquivUsd: 12.5,
      });
      assert.equal(updated.version, beforeUpdate.version);
      assert.equal(updated.reviewCycle, 2);
      assert.equal(updated.noProgressStreak, 1);
      assert.equal(updated.status, "awaiting_human");
      assert.ok(updated.updatedAt > beforeUpdate.updatedAt);
      assert.deepEqual(invalidated, []);
      assert.equal(engine.listRevisions(created.id).length, 1);

      const { goal: updatedBoth, before: beforeBoth } = engine.updateBudgets(created.id, {
        maxReviewCycles: 0,
        maxNoProgressCycles: 4,
      });
      assert.equal(beforeBoth.maxReviewCycles, 3);
      assert.equal(beforeBoth.maxNoProgressCycles, 2);
      assert.equal(updatedBoth.budgets.maxReviewCycles, 0);
      assert.equal(updatedBoth.budgets.maxNoProgressCycles, 4);
      assert.equal(updatedBoth.version, 1);
      assert.equal(updatedBoth.reviewCycle, 2);
      assert.equal(updatedBoth.noProgressStreak, 1);

      for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3" as unknown as number]) {
        assert.throws(
          () => engine.updateBudgets(created.id, { maxReviewCycles: bad }),
          /budgets\.maxReviewCycles must be a non-negative integer/,
        );
      }
      for (const bad of [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "2" as unknown as number]) {
        assert.throws(
          () => engine.updateBudgets(created.id, { maxNoProgressCycles: bad }),
          /budgets\.maxNoProgressCycles must be a positive integer/,
        );
      }

      assert.throws(() => engine.updateBudgets("goal-9999", { maxReviewCycles: 4 }), /Unknown goal/);

      engine.setStatus(created.id, "achieved", "Done");
      assert.throws(() => engine.updateBudgets(created.id, { maxReviewCycles: 5 }), /achieved/);

      const cancelled = engine.createGoal({
        repoRoot,
        title: "Cancelled goal",
        description: "Will be cancelled",
        criteria: [{ id: "c1", description: "passes", kind: "deterministic", command: "true", required: true }],
      });
      engine.setStatus(cancelled.id, "cancelled", "No longer needed");
      assert.throws(() => engine.updateBudgets(cancelled.id, { maxReviewCycles: 5 }), /cancelled/);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
