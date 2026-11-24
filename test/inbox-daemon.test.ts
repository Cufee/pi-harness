import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { WorkSnapshot } from "../src/tui/store.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-inbox-daemon-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# Inbox Daemon Test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("Inbox daemon RPCs and snapshot integration", () => {
  it("hides old failed children on a resumed goal-linked run, persists inbox.dismiss across DB reopen, and clears stale items", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-inbox-state-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = withFixtureCatalog({
      ...loadConfig(repoDir),
      stateDir,
      socketPath: sockPath,
    });

    const daemon = new HarnessDaemon(cfg);
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      const chat = await client.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Inbox Daemon Test",
      });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();

      // 1. Goal-linked run whose T1 failed and whose T2 child failed, then resumed (T1 running again)
      const goal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chat.session.id,
        title: "Resumed goal run",
        description: "Test resumed T1 with failed T2 child",
        criteria: [{ id: "c1", kind: "deterministic", description: "Pass", command: "true" }],
      });
      const goalRun = daemon.db.createRun({ goal: goal.title, repoRoot: repoDir, baseBranch: "main", baseSha });
      daemon.director.goals.linkRunAndStart(goal.id, goalRun.id);

      const t1 = daemon.db.createTask({
        runId: goalRun.id,
        tier: 1,
        kind: "orchestrator",
        title: "T1 orchestrator",
        objective: "Coordinate goal",
        profileId: "acp:codex",
      });
      const t2Child = daemon.db.createTask({
        runId: goalRun.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Old failed child",
        objective: "Do slice",
        profileId: "acp:codex",
      });
      daemon.db.updateTask(t2Child.id, { status: "failed", summary: "timed out" });
      daemon.db.updateTask(t1.id, { status: "failed", summary: "child failed" });
      daemon.db.updateRunStatus(goalRun.id, "failed");

      // Resume: rewrite T1 in place (generation + 1, status running) and mark run active
      daemon.db.updateTask(t1.id, { status: "running", generation: t1.generation + 1 });
      daemon.db.updateRunStatus(goalRun.id, "active");

      const resumedSnap = await client.request<WorkSnapshot>("work.snapshot", {
        chatSessionId: chat.session.id,
        repoRoot: repoDir,
      });
      assert.equal(
        resumedSnap.inbox.some((i) => i.runId === goalRun.id && (i.kind === "task_failed" || i.kind === "task_blocked" || i.kind === "run_failed")),
        false,
        "Resumed goal-linked run must not show task or run rows in inbox",
      );
      const hiddenChild = (resumedSnap.internalAttention ?? []).find((i) => i.id === `inbox:task:${t2Child.id}`);
      assert.ok(hiddenChild, "Old failed T2 child must appear in internalAttention");
      assert.equal(hiddenChild.hiddenReason, "run_live");
      assert.equal(hiddenChild.audience, "orchestrator");

      // 2. Goalless failed run + human P0 escalation: test inbox.dismiss persistence and inbox.clear_stale
      const goallessRun = daemon.db.createRun({
        goal: "Standalone ad-hoc run",
        repoRoot: repoDir,
        baseBranch: "main",
        baseSha,
      });
      daemon.db.updateRunStatus(goallessRun.id, "failed");

      const escTask = daemon.db.createTask({
        runId: goalRun.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Active worker",
        objective: "Needs human input",
        profileId: "acp:codex",
      });
      daemon.db.updateTask(escTask.id, { status: "running" });
      const humanEsc = daemon.db.createEscalation({
        runId: goalRun.id,
        fromTaskId: escTask.id,
        toTaskId: null,
        severity: "P0",
        category: "blocked_dependency",
        title: "Need schema sign-off",
        evidencePaths: ["README.md"],
        blocking: true,
      });

      const repoSnapBefore = await client.request<WorkSnapshot>("work.snapshot", { repoRoot: repoDir });
      const failedRunItem = repoSnapBefore.inbox.find((i) => i.id === `inbox:run:${goallessRun.id}`);
      const escItem = repoSnapBefore.inbox.find((i) => i.id === `inbox:esc:${humanEsc.id}`);
      assert.ok(failedRunItem, "Goalless failed run must appear in repo-scope inbox");
      assert.ok(escItem, "Human P0 escalation must appear in inbox");

      // Dismiss the escalation via RPC and verify persistence after reopening ControlPlaneDb on the same file
      await client.request("inbox.dismiss", { itemId: escItem.id, itemCreatedAt: escItem.createdAt });
      const reopenedDb = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
      try {
        assert.equal(reopenedDb.listInboxDismissals().get(escItem.id), escItem.createdAt);
      } finally {
        reopenedDb.close();
      }

      const afterDismissSnap = await client.request<WorkSnapshot>("work.snapshot", { repoRoot: repoDir });
      assert.equal(afterDismissSnap.inbox.some((i) => i.id === escItem.id), false);
      const dismissedEsc = (afterDismissSnap.internalAttention ?? []).find((i) => i.id === escItem.id);
      assert.ok(dismissedEsc);
      assert.equal(dismissedEsc.hiddenReason, "dismissed");
      assert.equal(dismissedEsc.audience, "human");

      // Restore brings the escalation back
      const restoreRes = await client.request<{ restored: boolean }>("inbox.restore", { itemId: escItem.id });
      assert.equal(restoreRes.restored, true);
      const afterRestoreSnap = await client.request<WorkSnapshot>("work.snapshot", { repoRoot: repoDir });
      assert.ok(afterRestoreSnap.inbox.some((i) => i.id === escItem.id));

      // inbox.clear_stale dismisses the goalless failed-run item but leaves the human escalation untouched
      const clearRes = await client.request<{ dismissed: number }>("inbox.clear_stale", { repoRoot: repoDir });
      assert.equal(clearRes.dismissed, 1);

      const afterClearSnap = await client.request<WorkSnapshot>("work.snapshot", { repoRoot: repoDir });
      assert.equal(afterClearSnap.inbox.some((i) => i.id === failedRunItem.id), false);
      assert.ok(afterClearSnap.inbox.some((i) => i.id === escItem.id));
      const hiddenRun = (afterClearSnap.internalAttention ?? []).find((i) => i.id === failedRunItem.id);
      assert.equal(hiddenRun?.hiddenReason, "dismissed");
      assert.equal(daemon.db.getRun(goallessRun.id)?.status, "failed", "clear_stale must not mutate runs table");
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("keeps max(stored, incoming) item_created_at on out-of-order dismiss upserts and resets on restore", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-inbox-watermark-"));
    const db = new ControlPlaneDb(join(stateDir, "control-plane.sqlite"));
    try {
      const itemId = "inbox:goal:goal-1";
      db.dismissInboxItem(itemId, 20, 1_000);
      assert.equal(db.listInboxDismissals().get(itemId), 20);

      // Late out-of-order dismiss for an older item version must not regress the stored watermark
      db.dismissInboxItem(itemId, 10, 2_000);
      assert.equal(db.listInboxDismissals().get(itemId), 20);

      // Newer item version advances the stored watermark
      db.dismissInboxItem(itemId, 30, 3_000);
      assert.equal(db.listInboxDismissals().get(itemId), 30);

      // Explicit restore removes the watermark so a later dismiss starts fresh
      assert.equal(db.restoreInboxItem(itemId), true);
      assert.equal(db.listInboxDismissals().has(itemId), false);
      db.dismissInboxItem(itemId, 10, 4_000);
      assert.equal(db.listInboxDismissals().get(itemId), 10);
    } finally {
      db.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
