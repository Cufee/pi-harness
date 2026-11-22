import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { DAEMON_PROTOCOL_REV, HarnessDaemon } from "../src/daemon/server.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import {
  createTheme,
  ModalScreen,
  Navigator,
  RecentRefsRing,
  visibleWidth,
} from "../src/tui/core/index.js";
import { GoToPaletteScreen } from "../src/tui/pickers.js";
import { WorkStore, type WorkSnapshot } from "../src/tui/store.js";
import { WorkNavigatorScreen } from "../src/tui/work-navigator.js";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-tuiv2-repo-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeFakeTerminal(): Terminal {
  return {
    columns: 100,
    rows: 30,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    moveBy() {},
    hideCursor() {},
    showCursor() {},
    clearLine() {},
    clearFromCursor() {},
    clearScreen() {},
    setTitle() {},
    setProgress() {},
    setProgramStatus() {},
  };
}

describe("TUI v2 Reachability, WorkSnapshot & Inspector Drill-Down", () => {
  it("exposes all surfaced entities via work.snapshot, streams live escalation events on chat sockets, and resolves escalations via Navigator", async () => {
    assert.equal(DAEMON_PROTOCOL_REV, 6);
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-tuiv2-state-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(repoDir);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg);
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      const chat = await client.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Reachability Test Chat",
      });

      const goal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chat.session.id,
        title: "Ship unified TUI v2",
        description: "Replace scattered overlays with a single Work Navigator",
        criteria: [{ id: "c1", kind: "deterministic", description: "Typecheck passes", command: "bun run typecheck" }],
      });
      const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
      const run = daemon.db.createRun({
        goal: goal.title,
        repoRoot: repoDir,
        baseBranch: "main",
        baseSha,
      });
      daemon.director.goals.linkRunAndStart(goal.id, run.id);

      const task = daemon.db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Build core primitives",
        objective: "Create src/tui/core/*",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-sol",
      });
      daemon.db.updateTask(task.id, { status: "blocked", summary: "Need human confirmation on protocol rev" });

      // Watch live events arriving on the chat socket when an escalation is recorded
      const receivedEvents: DaemonEventFrame[] = [];
      const detach = client.onEvent((ev) => receivedEvents.push(ev));

      const esc = daemon.db.createEscalation({
        runId: run.id,
        fromTaskId: task.id,
        toTaskId: null,
        severity: "P0",
        category: "blocked_dependency",
        title: "Blocked on schema approval",
        evidencePaths: ["src/daemon/server.ts"],
        attempted: ["Checked protocol rev"],
        suggestedSplits: ["Approve rev 6"],
        blocking: true,
      });
      daemon.db.emitEvent(run.id, task.id, "escalation.created", {
        id: esc.id,
        severity: esc.severity,
        title: esc.title,
      });

      // Add a timer and an artifact so every tab has real data
      const timer = daemon.db.timers.schedule({
        ownerKind: "chat",
        ownerId: chat.session.id,
        runId: run.id,
        goalId: goal.id,
        delaySeconds: 300,
        reason: "Check CI after push",
        wakeOnEvent: "none",
      });
      const artPath = join(stateDir, "notes.md");
      writeFileSync(artPath, "Artifact line 1\nArtifact line 2\n");
      daemon.db.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "dossier",
        path: "notes.md",
        summary: "Test notes artifact",
      });

      // Wait briefly for live chat socket fanout
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(
        receivedEvents.some((e) => e.type === "escalation.created"),
        "Chat socket must receive live escalation.created events",
      );
      detach();

      // 1. Verify work.snapshot single-trip payload & severity-sorted Inbox
      const snap = await client.request<WorkSnapshot>("work.snapshot", {
        chatSessionId: chat.session.id,
        repoRoot: repoDir,
      });
      assert.equal(snap.goals.length, 1);
      assert.equal(snap.escalations.length, 1);
      assert.equal(snap.timers.length, 1);
      assert.ok(snap.inbox.length >= 1);
      assert.equal(snap.inbox[0]!.kind, "escalation");
      assert.equal(snap.inbox[0]!.severity, "P0");
      assert.equal(snap.inbox[0]!.ref.id, esc.id);

      // 2. Verify escalation.get + escalation.ack (ack without resolve, then resolve)
      const escDetail = await client.request<{ escalation: { id: string; status: string }; goal: { id: string } | null }>(
        "escalation.get",
        { escalationId: esc.id },
      );
      assert.equal(escDetail.escalation.id, esc.id);
      assert.equal(escDetail.goal?.id, goal.id);

      await client.request("escalation.ack", { escalationId: esc.id, resolution: "Investigating", resolve: false });
      assert.equal(daemon.db.getEscalation(esc.id)?.status, "acked");

      // Re-open briefly to test WorkNavigator -> EscalationInspector UI drill-down
      daemon.db.db.prepare("UPDATE escalations SET status = 'open' WHERE id = ?").run(esc.id);

      // 3. Verify task.get, goal.revisions, timer.list/cancel
      const taskDetail = await client.request<{ task: { id: string }; escalations: unknown[]; artifacts: unknown[] }>(
        "task.get",
        { taskId: task.id },
      );
      assert.equal(taskDetail.task.id, task.id);
      assert.equal(taskDetail.escalations.length, 1);
      assert.equal(taskDetail.artifacts.length, 1);

      const revisions = await client.request<unknown[]>("goal.revisions", { goalId: goal.id });
      assert.ok(Array.isArray(revisions));

      const timers = await client.request<Array<{ id: string }>>("timer.list", { status: "pending" });
      assert.ok(timers.some((t) => t.id === timer.id));

      // 4. Drive WorkStore -> WorkNavigatorScreen -> EscalationInspectorScreen end-to-end
      const store = new WorkStore(client, { chatSessionId: chat.session.id, repoRoot: repoDir });
      await store.refresh();

      const slots = store.buildAttentionSlots(5);
      assert.ok(slots.length >= 1);
      assert.equal(slots[0]!.ref.kind, "escalation");
      assert.equal(slots[0]!.ref.id, esc.id);

      const theme = createTheme({ color: false });
      const terminal = makeFakeTerminal();
      const tui = new ModalScreen(terminal);
      const nav = new Navigator(tui, terminal, theme);
      const deps = { client, store, repoRoot: repoDir };

      const workNav = new WorkNavigatorScreen(deps);
      nav.push(workNav);
      await new Promise((r) => setTimeout(r, 30));

      // Render across widths 60..120 without overflow
      for (const w of [60, 80, 120]) {
        const lines = workNav.render(w, 24, theme);
        assert.ok(lines.length <= 24);
        assert.ok(lines.some((l) => l.includes("Inbox")));
        assert.ok(lines.some((l) => l.includes("Blocked on schema approval")));
        for (const l of lines) assert.ok(visibleWidth(l) <= w, `WorkNavigator overflowed ${w}`);
      }

      // Press Enter on top Inbox item -> drills into EscalationInspectorScreen!
      const screenCtx = {
        navigator: nav,
        theme,
        requestRender: () => {},
        writeTerminal: () => {},
      };
      nav.current!.handleInput("\r", screenCtx);
      assert.deepEqual(nav.breadcrumbs, ["Work", esc.id]);
      await new Promise((r) => setTimeout(r, 30));

      const escLines = nav.current!.render(90, 24, theme);
      assert.ok(escLines.some((l) => l.includes("Blocked on schema approval")));
      assert.ok(escLines.some((l) => l.includes("src/daemon/server.ts")));

      // Press 'r' -> Enter -> resolves escalation live against daemon!
      nav.current!.handleInput("r", screenCtx);
      nav.current!.handleInput("\r", screenCtx);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(daemon.db.getEscalation(esc.id)?.status, "resolved");

      // Cancel timer via RPC
      await client.request("timer.cancel", { timerId: timer.id });
      assert.equal(daemon.db.timers.get(timer.id)?.status, "cancelled");

      // Verify GoToPaletteScreen fuzzy jump renders cleanly
      const palette = new GoToPaletteScreen(deps, new RecentRefsRing(), []);
      const palLines = palette.render(70, 18, theme);
      assert.ok(palLines.length <= 18);
      for (const l of palLines) assert.ok(visibleWidth(l) <= 70);

      store.dispose();
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
