import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type { CompiledModelCatalog } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { DAEMON_PROTOCOL_REV, HarnessDaemon } from "../src/daemon/server.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../src/director/session.js";
import type { DaemonEventFrame, SnapshotWorktreeEntry } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui, runNativeScrollbackTui } from "../src/tui/app.js";
import {
  createTheme,
  ModalScreen,
  Navigator,
  RecentRefsRing,
  stripTerminalSequences,
  visibleWidth,
} from "../src/tui/core/index.js";
import {
  EscalationInspectorScreen,
  GoalInspectorScreen,
  LiveTranscriptScreen,
  RunInspectorScreen,
  TaskInspectorScreen,
} from "../src/tui/inspectors.js";
import {
  EffortPickerScreen,
  GoToPaletteScreen,
  KbBrowserScreen,
  ModelPickerScreen,
  QuotaCostScreen,
  QuotaWaitPickerScreen,
  SessionSwitcherScreen,
  SettingsScreen,
} from "../src/tui/pickers.js";
import { WorkStore, type WorkSnapshot } from "../src/tui/store.js";
import { WorkNavigatorScreen } from "../src/tui/work-navigator.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

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

function makeFakeTerminal(cols = 100, rows = 30) {
  let onDataCb: ((data: string) => void) | null = null;
  const writes: string[] = [];
  const terminal: Terminal = {
    columns: cols,
    rows,
    kittyProtocolActive: false,
    start(onData) {
      onDataCb = onData;
    },
    stop() {
      onDataCb = null;
    },
    async drainInput() {},
    write(d) {
      writes.push(d);
    },
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
  return {
    terminal,
    writes,
    sendInput: (data: string) => onDataCb?.(data),
  };
}

/** Lightweight mock DaemonClient for verifying exact RPC params, pagination, and event flows. */
function makeMockClient(
  handler: (op: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const eventListeners = new Set<(ev: DaemonEventFrame) => void>();
  const closeListeners = new Set<() => void>();

  const client = {
    async request<T = unknown>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ op, params });
      return (await handler(op, params)) as T;
    },
    onEvent(fn: (ev: DaemonEventFrame) => void): () => void {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    onClose(fn: () => void): () => void {
      closeListeners.add(fn);
      return () => closeListeners.delete(fn);
    },
    close() {
      for (const fn of closeListeners) fn();
    },
  } as unknown as DaemonClient;

  return {
    client,
    calls,
    emit(ev: DaemonEventFrame) {
      for (const fn of eventListeners) fn(ev);
    },
  };
}

describe("TUI v2 Reachability, WorkSnapshot & Inspector Drill-Down", () => {
  it("exposes all surfaced entities via work.snapshot, streams live escalation events, supports Left/Right tabs, aligned tables, and resolves escalations via Navigator", async () => {
    assert.equal(DAEMON_PROTOCOL_REV, 8);
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-tuiv2-state-"));
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

      const childA = daemon.db.createTask({
        runId: run.id,
        parentId: task.id,
        tier: 3,
        kind: "research",
        title: "Audit theme tokens",
        objective: "Check color tokens",
        profileId: "acp:codex",
      });
      const childB = daemon.db.createTask({
        runId: run.id,
        parentId: task.id,
        tier: 3,
        kind: "verify",
        title: "Verify column widths",
        objective: "Check width bounds",
        profileId: "acp:codex",
      });
      assert.ok(childA.id && childB.id);

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
      daemon.db.recordArtifact({
        runId: run.id,
        taskId: task.id,
        kind: "write",
        path: "README.md",
        summary: "Second task artifact",
      });

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

      // 2. Ack without resolving -> verify acked escalation STILL appears in unresolved Escalations tab!
      await client.request("escalation.ack", { escalationId: esc.id, resolution: "Investigating", resolve: false });
      assert.equal(daemon.db.getEscalation(esc.id)?.status, "acked");
      assert.equal(
        daemon.db
          .getEventsSince(run.id, 0)
          .some((e) => e.type === "escalation.updated" && (e.payload as { resolvedBy?: string }).resolvedBy !== undefined),
        false,
        "escalation.ack(resolve:false) must not record resolvedBy",
      );
      assert.equal(
        daemon.director.chats
          .getHistory(chat.session.id)
          .some((t) => t.role === "system_notice" && /Escalation .* resolved by/.test(t.content)),
        false,
        "escalation.ack(resolve:false) must not emit a resolved system_notice",
      );

      const store = new WorkStore(client, { chatSessionId: chat.session.id, repoRoot: repoDir });
      await store.refresh();

      const theme = createTheme({ color: false, ascii: false });
      const { terminal } = makeFakeTerminal();
      const tui = new ModalScreen(terminal);
      const nav = new Navigator(tui, terminal, theme);
      const deps = { client, store, repoRoot: repoDir };
      const screenCtx = {
        navigator: nav,
        theme,
        requestRender: () => {},
        writeTerminal: () => {},
      };

      const workNav = new WorkNavigatorScreen(deps, "escalations");
      nav.push(workNav);
      await new Promise((r) => setTimeout(r, 30));

      // Acked escalation MUST still be visible under default "unresolved" Escalations view!
      const escTabLines = workNav.render(100, 24, theme).map(stripTerminalSequences);
      assert.ok(escTabLines.some((l) => l.includes("STATUS") && l.includes("TITLE")), "Must render sticky aligned headers");
      assert.ok(escTabLines.some((l) => l.includes("Blocked on schema approval")), "Acked escalation must remain visible");

      // Re-open escalation for Inbox & resolve test
      daemon.db.db.prepare("UPDATE escalations SET status = 'open' WHERE id = ?").run(esc.id);
      await store.refresh();

      // Test Left/Right arrow tab switching on WorkNavigatorScreen
      workNav.setTab("inbox");
      assert.equal(workNav.currentTab, "inbox");
      workNav.handleInput("\x1b[C", screenCtx); // Right arrow -> goals
      assert.equal(workNav.currentTab, "goals");
      workNav.handleInput("\x1b[D", screenCtx); // Left arrow -> inbox
      assert.equal(workNav.currentTab, "inbox");

      // While `/` filter is active, Left/Right arrows MUST NOT switch tabs!
      workNav.handleInput("/", screenCtx);
      workNav.handleInput("\x1b[C", screenCtx);
      assert.equal(workNav.currentTab, "inbox");
      workNav.handleInput("\x1b", screenCtx); // Exit filter

      // Width sweep across 60, 80, 120
      for (const w of [60, 80, 120]) {
        const lines = workNav.render(w, 24, theme);
        assert.ok(lines.length <= 24);
        assert.ok(lines.some((l) => l.includes("Inbox")));
        assert.ok(lines.some((l) => l.includes("Blocked on schema approval")));
        for (const l of lines) assert.ok(visibleWidth(l) <= w, `WorkNavigator overflowed ${w}`);
      }

      // Press Enter on top Inbox item -> drills into EscalationInspectorScreen with dynamic breadcrumbs!
      nav.current!.handleInput("\r", screenCtx);
      assert.deepEqual(nav.breadcrumbs, ["Work", esc.id]);
      await new Promise((r) => setTimeout(r, 40));

      const escLines = nav.current!.render(90, 24, theme).map(stripTerminalSequences);
      assert.ok(escLines.some((l) => l.includes(`Work ▸ ${esc.id}`)), "Must use dynamic navigator.breadcrumbs");
      assert.ok(escLines.some((l) => l.includes("Blocked on schema approval")));

      // Verify `g` opens linked Goal (no collision with scroll-to-top!)
      nav.current!.handleInput("g", screenCtx);
      assert.deepEqual(nav.breadcrumbs, ["Work", esc.id, goal.id]);
      // Test Left/Right tab switching on GoalInspectorScreen
      nav.current!.handleInput("\x1b[C", screenCtx); // Overview -> Tasks
      const goalTasksLines = nav.current!.render(90, 24, theme).map(stripTerminalSequences);
      assert.ok(goalTasksLines.some((l) => l.includes("Build core primitives")));
      // Backspace pops when depth > 1
      nav.current!.handleInput("\x7f", screenCtx);
      assert.deepEqual(nav.breadcrumbs, ["Work", esc.id]);

      // Press 'r' -> type answer -> Enter -> resolves escalation live via escalation.resolve!
      nav.current!.handleInput("r", screenCtx);
      nav.current!.handleInput("\x15", screenCtx); // Clear default text
      for (const ch of "Approved rev 6") nav.current!.handleInput(ch, screenCtx);
      nav.current!.handleInput("\r", screenCtx);
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(daemon.db.getEscalation(esc.id)?.status, "resolved");
      assert.equal(daemon.db.getEscalation(esc.id)?.resolution, "Approved rev 6");

      const resolvedEvents = daemon.db
        .getEventsSince(run.id, 0)
        .filter(
          (e) =>
            e.type === "escalation.updated" &&
            (e.payload as { id?: string; status?: string; resolvedBy?: string }).id === esc.id &&
            (e.payload as { status?: string }).status === "resolved",
        );
      assert.equal(resolvedEvents.length, 1);
      assert.equal((resolvedEvents[0]!.payload as { resolvedBy?: string }).resolvedBy, "operator");
      assert.equal((resolvedEvents[0]!.payload as { resolution?: string }).resolution, "Approved rev 6");

      const chatNotices = daemon.director.chats
        .getHistory(chat.session.id)
        .filter((t) => t.role === "system_notice" && /Escalation .* resolved by operator/.test(t.content));
      assert.equal(chatNotices.length, 1);
      assert.ok(chatNotices[0]!.content.includes("Approved rev 6"));

      // Re-resolving reports alreadyResolved notice without duplicating audit event or chat notice
      nav.current!.handleInput("r", screenCtx);
      nav.current!.handleInput("\r", screenCtx);
      await new Promise((r) => setTimeout(r, 60));
      const alreadyRendered = nav.current!.render(100, 24, theme).map(stripTerminalSequences).join("\n");
      assert.ok(alreadyRendered.includes(`${esc.id} was already resolved`));
      assert.equal(
        daemon.director.chats
          .getHistory(chat.session.id)
          .filter((t) => t.role === "system_notice" && /Escalation .* resolved by operator/.test(t.content)).length,
        1,
      );

      // Inspect RunInspectorScreen tree connectors (`├─` vs `└─`)
      nav.push(new RunInspectorScreen(run.id, deps));
      const runLines = nav.current!.render(100, 24, theme).map(stripTerminalSequences);
      assert.ok(runLines.some((l) => l.includes("├─")), "Non-last sibling task must use ├─ connector");
      assert.ok(runLines.some((l) => l.includes("└─")), "Last sibling task must use └─ connector");

      // Inspect TaskInspectorScreen -> multi-artifact picker on 'a'
      nav.push(new TaskInspectorScreen(task.id, deps));
      await new Promise((r) => setTimeout(r, 40));
      const taskLines = nav.current!.render(100, 36, theme).map(stripTerminalSequences);
      assert.ok(taskLines.some((l) => l.includes("Child Tasks (2)")), "Must render child tasks");
      assert.ok(taskLines.some((l) => l.includes("Artifacts (2)")));
      nav.current!.handleInput("a", screenCtx);
      assert.equal(nav.current!.title, "Artifacts", "Multiple artifacts must open ArtifactPickerScreen");

      // Cancel timer via RPC
      await client.request("timer.cancel", { timerId: timer.id });
      assert.equal(daemon.db.timers.get(timer.id)?.status, "cancelled");

      // Verify GoToPaletteScreen puts pinned commands at the top and renders cleanly at 60/80/120
      const palette = new GoToPaletteScreen(deps, new RecentRefsRing(), [
        { id: "settings", label: "/settings", detail: "ACP CLIs & Models", pinned: true, run: () => {} },
        { id: "model", label: "/model", detail: "Select Model", pinned: true, run: () => {} },
      ]);
      for (const w of [60, 80, 120]) {
        const palLines = palette.render(w, 18, theme);
        assert.ok(palLines.length <= 18);
        assert.ok(palLines.some((l) => stripTerminalSequences(l).includes("/settings")));
        for (const l of palLines) assert.ok(visibleWidth(l) <= w, `Palette overflowed ${w}`);
      }

      store.dispose();
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("verifies SettingsScreen (ACP toggle/probe, Enabled Models Toggle All Off & Enable All, Quota URL clear), ModelPickerScreen route cycling, EffortPickerScreen, QuotaCostScreen, KbBrowserScreen, SessionSwitcherScreen, and QuotaWaitPickerScreen", async () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal } = makeFakeTerminal(100, 30);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };

    let cfg = loadConfig(process.cwd());
    cfg.quotaEndpoint = { url: "http://127.0.0.1:9090/v1/quota", format: "protojson" };

    const catalog: CompiledModelCatalog = {
      syncedAt: new Date().toISOString(),
      sources: ["vals"],
      sessionModelContext: "Prefer fast high-coding-score models for TUI work",
      profileStatuses: [
        { profileId: "acp:codex", status: "ok", modelCount: 2 },
        { profileId: "acp:gemini", status: "error", modelCount: 0, error: "gemini CLI not found" },
      ],
      models: [
        {
          id: "openai/gpt-6.2-sol",
          family: "gpt-6",
          name: "GPT-6.2 Sol",
          codingRank: 1,
          codingScore: 84.5,
          scoreSource: "vals_tb4",
          benchmarks: {},
          contextK: 200,
          efforts: ["low", "medium", "high"],
          preferredRoute: {
            profileId: "acp:codex",
            runner: "acp",
            provider: "openai",
            wireModelId: "gpt-6.2-sol",
            billing: "subscription",
            supportedEfforts: ["low", "medium", "high"],
          },
          alternateRoutes: [
            {
              profileId: "acp:amp",
              runner: "acp",
              provider: "openai",
              wireModelId: "openai/gpt-6.2-sol",
              billing: "subscription",
              supportedEfforts: ["medium", "high"],
            },
          ],
          costPerTaskUsd: 0,
          apiEquivCostUsd: 0.42,
          timePerTaskSeconds: 35,
          quota: {
            availabilityName: "available",
            exhausted: false,
            effectiveRemainingRatio: 0.82,
            bindingBucketId: "codex:5h",
            nextAvailableAt: null,
          } as unknown as CompiledModelCatalog["models"][number]["quota"],
          recommendedFor: ["worker", "execute"],
        },
      ],
    };

    const mock = makeMockClient(async (op, params) => {
      if (op === "config.get") return cfg;
      if (op === "config.update") {
        const patch = (params.patch ?? {}) as Record<string, unknown>;
        cfg = {
          ...cfg,
          ...(patch.catalog ? { catalog: { ...cfg.catalog, ...(patch.catalog as typeof cfg.catalog) } } : {}),
          ...(patch.codeMode ? { codeMode: patch.codeMode as typeof cfg.codeMode } : {}),
          ...("quotaEndpoint" in patch
            ? { quotaEndpoint: (patch.quotaEndpoint as typeof cfg.quotaEndpoint | null) ?? undefined }
            : {}),
        };
        return cfg;
      }
      if (op === "profiles.upsert") {
        const pr = params.profile as (typeof cfg.profiles)[number];
        cfg = { ...cfg, profiles: cfg.profiles.map((p) => (p.id === pr.id ? pr : p)) };
        return cfg;
      }
      if (op === "profiles.probe") {
        return { id: params.id, models: [{ wireModelId: "gpt-6.2-sol" }] };
      }
      if (op === "models.list" || op === "models.sync") return catalog;
      if (op === "quota.get" || op === "quota.sync") {
        return {
          configured: true,
          snapshot: {
            generatedAt: new Date().toISOString(),
            metadata: { source: "test-endpoint" },
            buckets: [
              {
                bucketId: "codex-pool",
                displayName: "Codex Subscription",
                windows: [{ windowId: "5h", label: "5-hour", remainingRatio: 0.65, resetAt: new Date(Date.now() + 900_000).toISOString() }],
              },
            ],
            models: [
              {
                modelId: "openai/gpt-6.2-sol",
                profile: "acp:codex",
                availability: "AVAILABILITY_AVAILABLE",
                exhausted: false,
                effectiveRemainingRatio: 0.65,
                nextAvailableAt: new Date(Date.now() + 900_000).toISOString(),
              },
            ],
          },
          coverage: [
            { profileId: "acp:codex", adapter: "codex", hasData: true, source: "endpoint", note: "Quota Endpoint" },
          ],
        };
      }
      if (op === "cost.get") {
        return {
          scope: { kind: "chat", id: "chat-1", label: "Test Chat" },
          available: true,
          totals: [{ currency: "USD", amount: 1.25 }],
          byModel: [{ model: "openai/gpt-6.2-sol", currency: "USD", amount: 1.25 }],
          coverage: {
            complete: true,
            routes: [{ profileId: "pi:openai", billing: "api", invocations: 3, running: 0, status: "reported", note: "3 reported" }],
            unattributed: [],
          },
        };
      }
      if (op === "kb.search") {
        return [
          {
            id: "kb-1",
            repoScope: "/repo",
            kind: "invariant",
            status: "active",
            confidence: "verified",
            title: "Use selective ANSI resets",
            summary: "Never emit bare 0m inside surfaces",
            tags: ["tui", "ansi"],
            pathGlobs: ["src/tui/**"],
            verifiedSha: "dbb6025",
            hitCount: 4,
          },
        ];
      }
      if (op === "kb.get") {
        return [
          {
            id: "kb-1",
            repoScope: "/repo",
            kind: "invariant",
            status: "active",
            confidence: "verified",
            title: "Use selective ANSI resets",
            summary: "Never emit bare 0m inside surfaces",
            contextMd: "Full hydrated markdown body from kb.get!",
            tags: ["tui", "ansi"],
            pathGlobs: ["src/tui/**"],
            evidencePaths: ["src/tui/core/tokens.ts"],
            verifiedSha: "dbb6025",
            hitCount: 4,
            createdAt: Date.now() - 60_000,
            updatedAt: Date.now() - 10_000,
          },
        ];
      }
      if (op === "sessions.list") {
        return [
          { id: "chat-1", kind: "chat", title: "Current", repoRoot: "/repo", status: "idle", running: false, attached: true, attachedByMe: true, model: "gpt-6.2", effort: "high", updatedAt: Date.now() },
          { id: "chat-2", kind: "chat", title: "Other", repoRoot: "/repo", status: "busy", running: true, attached: true, attachedByMe: false, model: "claude-opus", effort: null, updatedAt: Date.now() },
        ];
      }
      if (op === "run.schedule_resume" || op === "run.resume") return { ok: true };
      return {};
    });

    // 1. SettingsScreen: Tab 1 ACP toggle, Tab 2 Toggle All Off / Enable All, Tab 3 Quota URL clear
    const settings = new SettingsScreen(mock.client, { repoRoot: "/repo" });
    nav.push(settings);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settings.currentTab, "clis");
    settings.handleInput(" ", ctx); // Toggle first profile via profiles.upsert
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(mock.calls.some((c) => c.op === "profiles.upsert"));

    // Right arrow -> Tab 2 Enabled Models
    settings.handleInput("\x1b[C", ctx);
    assert.equal(settings.currentTab, "models");
    await new Promise((r) => setTimeout(r, 20));
    settings.handleInput("x", ctx); // Toggle All Off -> allowlist []
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cfg.catalog.modelFilterMode, "allowlist");
    assert.deepEqual(cfg.catalog.enabledModels, []);
    const emptyAllowlistRender = settings.render(100, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(emptyAllowlistRender.includes("Allowlist is empty"));
    settings.handleInput("a", ctx); // Enable All
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cfg.catalog.modelFilterMode, "all");

    // Right arrow -> Tab 3 Defaults & Runtime -> Quota Endpoint URL clear via blank submit
    settings.handleInput("\x1b[C", ctx);
    assert.equal(settings.currentTab, "runtime");
    // Move to index 4 (Quota Endpoint URL)
    for (let i = 0; i < 4; i++) settings.handleInput("j", ctx);
    settings.handleInput("\r", ctx); // open prompt
    // Clear existing value via Ctrl+U then submit blank!
    settings.handleInput("\x15", ctx);
    settings.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(cfg.quotaEndpoint, undefined, "Submitting blank Quota Endpoint URL must clear it");
    nav.pop();

    // 2. ModelPickerScreen: banners, CLI default row, route cycling (`r`/`Tab`), width sweep
    let pickedModel: { profileId: string; model: string | null; effort: string | null } | null = null;
    const modelPicker = new ModelPickerScreen(mock.client, {
      cwd: "/repo",
      currentProfileId: "acp:codex",
      currentModel: "openai/gpt-6.2-sol",
      currentEffort: "high",
      onSelected: (sel) => {
        pickedModel = sel;
      },
    });
    nav.push(modelPicker);
    await new Promise((r) => setTimeout(r, 20));
    for (const w of [60, 80, 120]) {
      const mLines = modelPicker.render(w, 24, theme);
      for (const l of mLines) assert.ok(visibleWidth(l) <= w, `ModelPicker overflowed ${w}`);
    }
    const mText = modelPicker.render(100, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(mText.includes("Session context: Prefer fast high-coding-score models"));
    assert.ok(mText.includes("acp:gemini: gemini CLI not found"));
    assert.ok(mText.includes("CLI default"));
    // Cycle route from acp:codex -> acp:amp using 'r' and select
    modelPicker.handleInput("r", ctx);
    modelPicker.handleInput("\r", ctx);
    assert.deepEqual(pickedModel, { profileId: "acp:amp", model: "openai/gpt-6.2-sol", effort: "high" });

    // 3. EffortPickerScreen: updates effort independently
    let chosenEffort: string | null = null;
    const effortPicker = new EffortPickerScreen({
      currentEffort: "medium",
      modelLabel: "acp:codex · CLI default",
      onSelected: (e) => {
        chosenEffort = e;
      },
    });
    nav.push(effortPicker);
    effortPicker.handleInput("j", ctx); // medium -> high
    effortPicker.handleInput("\r", ctx);
    assert.equal(chosenEffort, "high");

    // 4. QuotaCostScreen: real protojson buckets + models + coverage + cost.get + wheel scroll
    const quotaScreen = new QuotaCostScreen(mock.client, { chatSessionId: "chat-1" });
    nav.push(quotaScreen);
    await new Promise((r) => setTimeout(r, 20));
    for (const w of [60, 80, 120]) {
      const qLines = quotaScreen.render(w, 24, theme);
      for (const l of qLines) assert.ok(visibleWidth(l) <= w, `QuotaCost overflowed ${w}`);
    }
    const qText = quotaScreen.render(100, 30, theme).map(stripTerminalSequences).join("\n");
    assert.ok(qText.includes("Codex Subscription"));
    assert.ok(qText.includes("65%"));
    assert.ok(qText.includes("$1.25"));
    assert.ok(qText.includes("Quota Endpoint"));
    quotaScreen.handleInput("\x1b[<65;10;5M", ctx); // mouse wheel scrolls cleanly
    nav.pop();

    // 5. KbBrowserScreen: initial query + no NaNd ago + kb.get hydration in KbDetailScreen
    const kb = new KbBrowserScreen(mock.client, "/repo", "ANSI");
    nav.push(kb);
    await new Promise((r) => setTimeout(r, 20));
    const kbText = kb.render(100, 20, theme).map(stripTerminalSequences).join("\n");
    assert.ok(kbText.includes("Use selective ANSI resets"));
    assert.equal(kbText.includes("NaN"), false, "Must never render NaNd ago for KbCard");
    kb.handleInput("\r", ctx); // open KbDetailScreen -> calls kb.get
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(mock.calls.some((c) => c.op === "kb.get"));
    const kbDetText = nav.current!.render(100, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(kbDetText.includes("Full hydrated markdown body from kb.get!"));
    nav.closeAll();

    // 6. SessionSwitcherScreen: YOU/OTHER + avoids reattaching to current + 'n' creates new
    let newCreated = false;
    let switchedTo: string | null = null;
    const sessScreen = new SessionSwitcherScreen(
      mock.client,
      "chat-1",
      (s) => (switchedTo = s.id),
      () => (newCreated = true),
    );
    nav.push(sessScreen);
    await new Promise((r) => setTimeout(r, 20));
    const sessText = sessScreen.render(100, 20, theme).map(stripTerminalSequences).join("\n");
    assert.ok(sessText.includes("YOU") && sessText.includes("OTHER"));
    // Pre-selected first other session (chat-2) -> Enter switches to chat-2
    sessScreen.handleInput("\r", ctx);
    assert.equal(switchedTo, "chat-2");
    nav.push(sessScreen);
    sessScreen.handleInput("n", ctx);
    assert.equal(newCreated, true);

    // 7. QuotaWaitPickerScreen: 1-key preset ('2' = Wait 5 minutes)
    const waitPicker = new QuotaWaitPickerScreen(mock.client, { runId: "run-q1", reason: "429 limit" });
    nav.push(waitPicker);
    waitPicker.handleInput("2", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const schedCall = mock.calls.find((c) => c.op === "run.schedule_resume");
    assert.equal(schedCall?.params.runId, "run-q1");
    assert.equal(schedCall?.params.delayMs, 5 * 60_000);
  });

  it("verifies LiveTranscriptScreen (scope task/run, replay.page pagination, agent.tool, late-watch close guard) and TaskInspectorScreen task.resume note param", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(100, 24);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };

    let resolveSlowWatch!: (v: unknown) => void;
    const slowWatchPromise = new Promise((r) => (resolveSlowWatch = r));

    const mock = makeMockClient(async (op, params) => {
      if (op === "work.snapshot") {
        return {
          generatedAt: Date.now(),
          latestSeq: 1,
          goals: [],
          runs: [],
          escalations: [],
          timers: [],
          merges: [],
          worktrees: [
            {
              id: "wt-1",
              runId: "run-1",
              taskId: "task-1",
              status: "active",
              branch: "harness/run-1/task-1",
              path: "/repo/.harness/worktrees/wt-1",
              existsOnDisk: true,
              dirty: true,
              orphaned: false,
              archiveRef: null,
            } satisfies SnapshotWorktreeEntry,
          ],
          messages: [],
          inbox: [],
        } satisfies WorkSnapshot;
      }
      if (op === "watch.start") {
        if (params.runId === "run-slow") return slowWatchPromise;
        return {
          watchId: "watch-1",
          throughSeq: 2,
          replay: [
            { seq: 1, runId: "run-1", taskId: "task-1", type: "agent.tool", createdAt: Date.now(), payload: { name: "mcp__harness__read_file", status: "completed", result: "ok" } },
          ],
          next: { sinceSeq: 1, payloadOffset: 0 },
        };
      }
      if (op === "replay.page") {
        return {
          throughSeq: 2,
          replay: [
            { seq: 2, runId: "run-1", taskId: "task-1", type: "agent.rollover", createdAt: Date.now(), payload: { generation: 2, reason: "context_threshold" } },
          ],
        };
      }
      if (op === "task.get") {
        return {
          task: {
            id: "task-1",
            runId: "run-1",
            tier: 2,
            kind: "worker",
            status: "paused_quota",
            title: "Implement pagination",
            objective: "Drain replay.page",
            criteria: null,
            summary: "Paused on quota",
            generation: 1,
            turnsUsed: 4,
            profileId: "acp:codex",
            model: "gpt-6.2",
            parentId: null,
            worktreeId: null,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          },
          handoff: { summary: "Compact handoff state" },
          run: null,
          escalations: [],
          artifacts: [],
          worktree: null,
          merges: [],
          messages: [
            { id: "m1", runId: "run-1", fromTaskId: "task-1", toTaskId: "task-0", question: "Need schema?", answer: "Yes", status: "answered", createdAt: Date.now(), answeredAt: Date.now() },
          ],
          children: [],
          writeScopes: ["src/tui/**"],
        };
      }
      if (op === "task.resume") return { resumed: true };
      if (op === "watch.stop") return { stopped: true };
      return {};
    });

    const store = new WorkStore(mock.client, { repoRoot: "/repo" });
    await store.refresh();
    const deps = { client: mock.client, store, repoRoot: "/repo" };

    // 1. LiveTranscriptScreen with scope: "task" + replay.page pagination
    const liveTask = new LiveTranscriptScreen("run-1", "task-1", deps);
    nav.push(liveTask);
    await new Promise((r) => setTimeout(r, 30));
    const startTaskCall = mock.calls.find((c) => c.op === "watch.start");
    assert.equal(startTaskCall?.params.scope, "task");
    assert.ok(mock.calls.some((c) => c.op === "replay.page"), "Must paginate replay.page");
    const liveText = liveTask.render(100, 20, theme).join("\n");
    assert.ok(liveText.includes("read_file"));
    assert.ok(liveText.includes("rollover"));
    nav.pop();
    assert.ok(mock.calls.some((c) => c.op === "watch.stop" && c.params.watchId === "watch-1"));

    // 2. LiveTranscriptScreen with scope: "run" + closed guard when watch.start resolves AFTER onClose()
    const liveSlow = new LiveTranscriptScreen("run-slow", undefined, deps);
    nav.push(liveSlow);
    const startRunCall = mock.calls.find((c) => c.op === "watch.start" && c.params.runId === "run-slow");
    assert.equal(startRunCall?.params.scope, "run");
    nav.pop(); // Closes BEFORE watch.start resolves!
    resolveSlowWatch({ watchId: "watch-late", throughSeq: 0, replay: [] });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      mock.calls.some((c) => c.op === "watch.stop" && c.params.watchId === "watch-late"),
      "Late-resolving watch.start after onClose must immediately call watch.stop",
    );

    // 3. TaskInspectorScreen sends `note` (NOT `message`) to task.resume and renders handoff + messages
    const taskScreen = new TaskInspectorScreen("task-1", deps);
    nav.push(taskScreen);
    await new Promise((r) => setTimeout(r, 20));
    const tText = taskScreen.render(100, 30, theme).join("\n");
    assert.ok(tText.includes("Compact handoff state"));
    assert.ok(tText.includes("Need schema?"));
    taskScreen.handleInput("u", ctx);
    taskScreen.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const resumeCall = mock.calls.find((c) => c.op === "task.resume");
    assert.equal(resumeCall?.params.note, "Continue");
    assert.equal("message" in (resumeCall?.params ?? {}), false);

    // 4. WorkNavigatorScreen Worktrees tab renders real SnapshotWorktreeEntry (dirty)
    const wtNav = new WorkNavigatorScreen(deps, "worktrees");
    nav.push(wtNav);
    const wtText = wtNav.render(100, 20, theme).join("\n");
    assert.ok(wtText.includes("wt-1") && wtText.includes("dirty"));
    store.dispose();
  });

  it("verifies runDirectorChatTui (chat.history pagination, tool_output replay + live present_result, chat.send text, busy chat.steer, session.leave) and runNativeScrollbackTui (attach replay.page + agent.tool)", async () => {
    // 1. Director Chat TUI full wiring test
    {
      const { terminal, writes, sendInput } = makeFakeTerminal(100, 30);
      const chatSession: ChatSessionRecord = {
        id: "chat-42",
        projectId: null,
        repoRoot: "/repo",
        title: "Wiring Test",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-sol",
        effort: "high",
        acpSessionId: null,
        modelSelectionContext: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const goalCardDisplay = {
        kind: "goals_table",
        title: "Active Goals",
        data: { goals: [{ id: "goal-9", version: 1, status: "executing", title: "Verify live + replayed cards", criteriaTotal: 1, criteriaPassed: 1, openEscalations: 0 }] },
      };

      let resolveFirstSend!: () => void;
      const firstSendGate = new Promise<void>((r) => (resolveFirstSend = r));

      const mock = makeMockClient(async (op, params) => {
        if (op === "chat.open") {
          return {
            session: chatSession,
            history: [
              { seq: 1, chatSessionId: "chat-42", role: "user", content: "First page user turn", createdAt: Date.now() } satisfies ChatTurnRecord,
            ],
            historyNext: 1,
            historyThrough: 2,
            activeTurnId: null,
            activeText: "",
            activePartial: "",
            tookOver: false,
            busy: false,
          };
        }
        if (op === "chat.history") {
          assert.equal(params.afterSeq, 1);
          assert.equal(params.throughSeq, 2);
          return {
            history: [
              {
                seq: 2,
                chatSessionId: "chat-42",
                role: "tool_output",
                content: "Active Goals",
                toolName: "present_result",
                display: goalCardDisplay,
                createdAt: Date.now(),
              } satisfies ChatTurnRecord,
            ],
            historyNext: null,
          };
        }
        if (op === "work.snapshot") {
          return { generatedAt: Date.now(), latestSeq: 0, goals: [], runs: [], escalations: [], timers: [], merges: [], worktrees: [], messages: [], inbox: [] };
        }
        if (op === "chat.send") {
          await firstSendGate;
          return { ok: true };
        }
        if (op === "chat.steer") {
          return { steered: true };
        }
        if (op === "session.leave") {
          return { daemonWillQuit: false };
        }
        return {};
      });

      const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
      await new Promise((r) => setTimeout(r, 40));

      // Verify paginated history was drained & replayed tool_output card rendered!
      assert.ok(mock.calls.some((c) => c.op === "chat.history"));
      const joinedWrites = writes.map(stripTerminalSequences).join("\n");
      assert.ok(joinedWrites.includes("Verify live + replayed cards"), "Replayed tool_output card must render");

      // Submit a prompt -> verify chat.send receives `text`
      for (const ch of "Hello Director") sendInput(ch);
      sendInput("\r");
      await new Promise((r) => setTimeout(r, 20));
      const sendCall = mock.calls.find((c) => c.op === "chat.send");
      assert.equal(sendCall?.params.text, "Hello Director");
      const activeTurnId = String(sendCall?.params.turnId);

      // While busy, Enter must call `chat.steer`!
      for (const ch of "Focus on tests") sendInput(ch);
      sendInput("\r");
      await new Promise((r) => setTimeout(r, 20));
      const steerCall = mock.calls.find((c) => c.op === "chat.steer");
      assert.equal(steerCall?.params.message, "Focus on tests");
      assert.equal(steerCall?.params.turnId, activeTurnId);

      // Live `chat.tool` with `display` must render identical structured card
      mock.emit({
        kind: "event",
        seq: 0,
        runId: "chat-42",
        taskId: "chat-42",
        type: "chat.tool",
        createdAt: Date.now(),
        payload: {
          chatSessionId: "chat-42",
          turnId: activeTurnId,
          name: "present_result",
          status: "completed",
          display: {
            kind: "run_activity",
            data: { runId: "run-77", phase: "active", elapsedMs: 5000, tasks: [] },
          },
        },
      });
      mock.emit({
        kind: "event",
        seq: 0,
        runId: "chat-42",
        taskId: "chat-42",
        type: "chat.turn.end",
        createdAt: Date.now(),
        payload: { chatSessionId: "chat-42", turnId: activeTurnId, assistantTurn: { content: "Done!" } },
      });
      resolveFirstSend();
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(writes.map(stripTerminalSequences).join("\n").includes("run-77"), "Live present_result card must render");

      // Clean exit via Ctrl+] -> calls session.leave!
      sendInput("\x1d");
      const exitAction = await runPromise;
      assert.equal(exitAction.kind, "exit");
      assert.ok(mock.calls.some((c) => c.op === "session.leave"), "Clean detach must call session.leave");
    }

    // 2. Attached Run TUI: paginated attach + replay.page + agent.tool + ignore ev.watchId
    {
      const { terminal, writes, sendInput } = makeFakeTerminal(100, 30);
      const mock = makeMockClient(async (op) => {
        if (op === "attach") {
          return {
            attachmentId: "att-1",
            attached: true,
            tookOver: false,
            run: { id: "run-55", goal: "Run test", repoRoot: "/repo", baseBranch: "main", baseSha: "abc", status: "active", createdAt: Date.now(), updatedAt: Date.now() },
            throughSeq: 2,
            replay: [
              { seq: 1, runId: "run-55", taskId: "task-1", type: "agent.text_delta", createdAt: Date.now(), payload: { text: "Page1 text\n" } },
            ],
            next: { sinceSeq: 1, payloadOffset: 0 },
          };
        }
        if (op === "replay.page") {
          return {
            throughSeq: 2,
            replay: [
              { seq: 2, runId: "run-55", taskId: "task-1", type: "agent.tool", createdAt: Date.now(), payload: { id: "tc-1", name: "mcp__harness__run_tests", status: "completed", result: "12 passed" } },
            ],
          };
        }
        if (op === "work.snapshot") {
          return { generatedAt: Date.now(), latestSeq: 0, goals: [], runs: [], escalations: [], timers: [], merges: [], worktrees: [], messages: [], inbox: [] };
        }
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const runPromise = runNativeScrollbackTui({ client: mock.client, runId: "run-55", terminal });
      await new Promise((r) => setTimeout(r, 40));

      assert.ok(mock.calls.some((c) => c.op === "replay.page"), "Attached run must drain paginated replay.page");
      const out = writes.map(stripTerminalSequences).join("\n");
      assert.ok(out.includes("run_tests"), "Attached run must render agent.tool events");

      sendInput("\x1d");
      const exitAction = await runPromise;
      assert.equal(exitAction.kind, "exit");
    }
  });

  it("handles non-destructive read-only takeover, draft preservation, Ctrl+Y and /take reclaim in runDirectorChatTui", async () => {
    const { terminal, writes, sendInput } = makeFakeTerminal(120, 30);
    const chatSession: ChatSessionRecord = {
      id: "chat-42",
      projectId: null,
      repoRoot: "/repo",
      title: "Takeover Test",
      profileId: "acp:codex",
      model: "openai/gpt-6.2-sol",
      effort: "high",
      acpSessionId: null,
      modelSelectionContext: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const mock = makeMockClient(async (op) => {
      if (op === "chat.open") {
        return {
          session: chatSession,
          history: [],
          historyNext: null,
          historyThrough: 0,
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          tookOver: false,
          control: {
            sessionId: "chat-42",
            kind: "chat",
            clientId: "cli-a",
            controllerClientId: "cli-a",
            hasControl: true,
          },
          busy: false,
        };
      }
      if (op === "session.take_control") {
        return {
          sessionId: "chat-42",
          kind: "chat",
          clientId: "cli-a",
          controllerClientId: "cli-a",
          hasControl: true,
          tookOver: true,
        };
      }
      if (op === "chat.send") return { ok: true };
      if (op === "work.snapshot") {
        return { generatedAt: Date.now(), latestSeq: 0, goals: [], runs: [], escalations: [], timers: [], merges: [], worktrees: [], messages: [], inbox: [] };
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await new Promise((r) => setTimeout(r, 40));

    // 1. Lose control to cli-b -> stays open in READ-ONLY mode
    writes.length = 0;
    mock.emit({
      kind: "event",
      seq: 0,
      runId: "chat-42",
      taskId: "chat-42",
      type: "session.control_changed",
      createdAt: Date.now(),
      payload: { sessionId: "chat-42", kind: "chat", controllerClientId: "cli-b", reason: "attached" },
    });
    const raceResult = await Promise.race([
      runPromise.then(() => "exited"),
      new Promise<string>((r) => setTimeout(() => r("alive"), 50)),
    ]);
    assert.equal(raceResult, "alive", "TUI must stay open when losing control");
    const roOutput = writes.map(stripTerminalSequences).join("\n");
    assert.ok(roOutput.includes("READ-ONLY"), "Read-only status row must render");
    assert.ok(roOutput.includes("Ctrl+Y"), "Read-only indicator must mention Ctrl+Y");

    // 2. Typing and submitting while read-only blocks chat.send and preserves draft
    for (const ch of "Hello") sendInput(ch);
    sendInput("\r");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mock.calls.filter((c) => c.op === "chat.send").length, 0, "chat.send must be blocked while read-only");

    // 3. Ctrl+Y reclaims control; pressing Enter submits the preserved draft
    sendInput("\x19");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mock.calls.filter((c) => c.op === "session.take_control").length, 1);

    sendInput("\r");
    await new Promise((r) => setTimeout(r, 30));
    const sendCalls = mock.calls.filter((c) => c.op === "chat.send");
    assert.equal(sendCalls.length, 1);
    assert.equal(sendCalls[0]?.params.text, "Hello");

    // 4. Controller disconnects -> uncontrolled read-only state
    writes.length = 0;
    mock.emit({
      kind: "event",
      seq: 0,
      runId: "chat-42",
      taskId: "chat-42",
      type: "session.control_changed",
      createdAt: Date.now(),
      payload: { sessionId: "chat-42", kind: "chat", controllerClientId: null, reason: "disconnected" },
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(writes.map(stripTerminalSequences).join("\n").includes("no terminal has control"));

    // 5. While read-only, /take reclaims control a second time
    for (const ch of "/take") sendInput(ch);
    sendInput("\r");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mock.calls.filter((c) => c.op === "session.take_control").length, 2);

    // 6. Ctrl+] exits cleanly and calls session.leave
    sendInput("\x1d");
    const exitAction = await runPromise;
    assert.equal(exitAction.kind, "exit");
    assert.ok(mock.calls.some((c) => c.op === "session.leave"));
  });

  it("verifies EscalationInspector 'a' ack distinct from resolve, WorkNavigator 'R' escalation.resolve, and GoalInspector 'A' goal.accept", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(120, 30);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };

    const now = Date.now();
    const escRecord = {
      id: "esc-1",
      runId: "run-1",
      fromTaskId: "t-2",
      toTaskId: null,
      severity: "P0" as const,
      category: "blocked_dependency" as const,
      title: "Choose storage backend",
      evidencePaths: ["src/db.ts"],
      attempted: [],
      suggestedSplits: [],
      blocking: true,
      status: "open" as const,
      resolution: null,
      createdAt: now,
      ackedAt: null,
    };

    const makeGoal = (id: string, status: "executing" | "achieved" | "draft" | "cancelled") => ({
      goal: {
        id,
        chatSessionId: "chat-1",
        repoRoot: "/repo",
        version: 1,
        title: `Goal ${id}`,
        description: `Description for ${id}`,
        criteria: [],
        nonGoals: [],
        budgets: { maxReviewCycles: 3, maxNoProgressCycles: 2 },
        status,
        linkedRunId: null,
        reviewCycle: 0,
        noProgressStreak: 0,
        lastProgressFingerprint: null,
        lastReviewSummary: null,
        createdAt: now,
        updatedAt: now,
      },
      reviews: [],
      revisions: [],
    });

    let resolveCount = 0;
    let failAccept = false;
    const mock = makeMockClient(async (op) => {
      if (op === "work.snapshot") {
        return {
          generatedAt: now,
          latestSeq: 1,
          goals: [
            makeGoal("goal-exec", "executing"),
            makeGoal("goal-done", "achieved"),
            makeGoal("goal-draft", "draft"),
            makeGoal("goal-cancelled", "cancelled"),
          ],
          runs: [],
          escalations: [escRecord],
          timers: [],
          merges: [],
          worktrees: [],
          messages: [],
          inbox: [],
        } satisfies WorkSnapshot;
      }
      if (op === "escalation.get") {
        return { escalation: escRecord, run: null, fromTask: null, goal: null };
      }
      if (op === "escalation.ack") {
        return { ...escRecord, status: "acked" };
      }
      if (op === "escalation.resolve") {
        resolveCount += 1;
        if (resolveCount === 1) {
          return { escalation: { ...escRecord, status: "resolved" }, alreadyResolved: false, deliveredTo: ["t-1"] };
        }
        return { escalation: { ...escRecord, status: "resolved" }, alreadyResolved: true, deliveredTo: [] };
      }
      if (op === "goal.accept") {
        if (failAccept) throw new Error("deterministic gate c1 failed");
        return { ok: true };
      }
      return {};
    });

    const store = new WorkStore(mock.client, { repoRoot: "/repo" });
    await store.refresh();
    const deps = { client: mock.client, store, repoRoot: "/repo" };

    // 1. EscalationInspector 'a' stays on escalation.ack with resolve: false
    const escScreen = new EscalationInspectorScreen("esc-1", deps);
    nav.push(escScreen);
    await new Promise((r) => setTimeout(r, 20));
    escScreen.handleInput("a", ctx);
    escScreen.handleInput("\x15", ctx);
    for (const ch of "Investigating issue") escScreen.handleInput(ch, ctx);
    escScreen.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));

    const ackCalls = mock.calls.filter((c) => c.op === "escalation.ack");
    assert.equal(ackCalls.length, 1);
    assert.deepEqual(ackCalls[0]!.params, {
      escalationId: "esc-1",
      resolution: "Investigating issue",
      resolve: false,
    });
    assert.equal(mock.calls.filter((c) => c.op === "escalation.resolve").length, 0);
    nav.pop();

    // 2. WorkNavigator 'R' sends escalation.resolve with typed reason (no escalation.ack)
    mock.calls.length = 0;
    const workNav = new WorkNavigatorScreen(deps, "escalations");
    nav.push(workNav);
    workNav.handleInput("R", ctx);
    workNav.handleInput("\x15", ctx);
    for (const ch of "Use SQLite") workNav.handleInput(ch, ctx);
    workNav.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));

    const navResolveCalls = mock.calls.filter((c) => c.op === "escalation.resolve");
    assert.equal(navResolveCalls.length, 1);
    assert.deepEqual(navResolveCalls[0]!.params, { escalationId: "esc-1", reason: "Use SQLite" });
    assert.equal(mock.calls.filter((c) => c.op === "escalation.ack").length, 0);
    const firstResolveRender = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(firstResolveRender.includes("Resolved esc-1 (sent to t-1)"));

    // Second 'R' returning alreadyResolved shows info notice
    workNav.handleInput("R", ctx);
    workNav.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const alreadyRender = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(alreadyRender.includes("esc-1 was already resolved"));
    nav.pop();

    // 3. GoalInspector 'A' sends goal.accept with reason + evidencePaths, no overrideDeterministic
    mock.calls.length = 0;
    const execGoalScreen = new GoalInspectorScreen("goal-exec", deps);
    nav.push(execGoalScreen);
    const execHints = execGoalScreen.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(execHints.includes("A accept"), "Executing goal must offer A accept hint");

    execGoalScreen.handleInput("A", ctx);
    for (const ch of "Operator verified") execGoalScreen.handleInput(ch, ctx);
    execGoalScreen.handleInput("\r", ctx);
    for (const ch of "proof.txt, out/log.txt") execGoalScreen.handleInput(ch, ctx);
    execGoalScreen.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));

    const acceptCalls = mock.calls.filter((c) => c.op === "goal.accept");
    assert.equal(acceptCalls.length, 1);
    assert.deepEqual(acceptCalls[0]!.params, {
      goalId: "goal-exec",
      reason: "Operator verified",
      evidencePaths: ["proof.txt", "out/log.txt"],
    });
    assert.equal("overrideDeterministic" in acceptCalls[0]!.params, false);
    const acceptedRender = execGoalScreen.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(acceptedRender.includes("Accepted goal-exec"));

    // Separator-only evidence paths do not send goal.accept
    execGoalScreen.handleInput("A", ctx);
    for (const ch of "Some reason") execGoalScreen.handleInput(ch, ctx);
    execGoalScreen.handleInput("\r", ctx);
    for (const ch of ",,,") execGoalScreen.handleInput(ch, ctx);
    execGoalScreen.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mock.calls.filter((c) => c.op === "goal.accept").length, 1);

    // Failed goal.accept displays error in notice
    failAccept = true;
    execGoalScreen.handleInput("A", ctx);
    for (const ch of "Try accept") execGoalScreen.handleInput(ch, ctx);
    execGoalScreen.handleInput("\r", ctx);
    for (const ch of "proof.txt") execGoalScreen.handleInput(ch, ctx);
    execGoalScreen.handleInput("\r", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const failRender = execGoalScreen.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(failRender.includes("Accept failed: deterministic gate c1 failed"));
    nav.pop();

    // 4. GoalInspector 'A' is NOT offered or handled for achieved, draft, or cancelled goals
    for (const blockedGoalId of ["goal-done", "goal-draft", "goal-cancelled"]) {
      mock.calls.length = 0;
      const screen = new GoalInspectorScreen(blockedGoalId, deps);
      nav.push(screen);
      const rendered = screen.render(120, 24, theme).map(stripTerminalSequences).join("\n");
      assert.equal(rendered.includes("A accept"), false, `${blockedGoalId} must not offer A accept`);
      screen.handleInput("A", ctx);
      for (const ch of "Should not submit") screen.handleInput(ch, ctx);
      screen.handleInput("\r", ctx);
      for (const ch of "proof.txt") screen.handleInput(ch, ctx);
      screen.handleInput("\r", ctx);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(mock.calls.filter((c) => c.op === "goal.accept").length, 0);
      nav.pop();
    }

    store.dispose();
  });
});
