import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type {
  EscalationRecord,
  RunRecord,
} from "../src/control-plane/db.js";
import type { TimerRecord } from "../src/control-plane/timers.js";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../src/director/session.js";
import type { GoalRecord } from "../src/goals/engine.js";
import type {
  DaemonEventFrame,
  InboxItem,
  SnapshotWorktreeEntry,
} from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui } from "../src/tui/app.js";
import {
  createTheme,
  FixedDock,
  ModalScreen,
  Navigator,
  stripTerminalSequences,
  visibleWidth,
} from "../src/tui/core/index.js";
import { WorkStore, type WorkSnapshot } from "../src/tui/store.js";
import { WorkNavigatorScreen } from "../src/tui/work-navigator.js";

function maybeWriteEvidence(filename: string, content: string): void {
  if (process.env.GOAL37_WRITE_EVIDENCE !== "1") return;
  const dir = process.env.HARNESS_GOAL_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const clean = content
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
  writeFileSync(join(dir, filename), `${clean.trimEnd()}\n`, "utf8");
}

function makeFakeTerminal(cols = 120, rows = 30) {
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
    text: () => stripTerminalSequences(writes.join("")),
    since: (idx: number) => stripTerminalSequences(writes.slice(idx).join("")),
    sendInput: (data: string) => onDataCb?.(data),
    typeText: (str: string) => {
      for (const ch of str) onDataCb?.(ch);
    },
  };
}

function makeMockClient(
  handler: (op: string, params: Record<string, unknown>) => unknown | Promise<unknown>,
) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const eventListeners = new Set<(ev: DaemonEventFrame) => void>();
  const closeListeners = new Set<() => void>();
  const client = {
    isRemote: false,
    connected: true,
    connectionEpoch: 1,
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
    async connect() {},
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

async function waitFor(predicate: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeChatSession(id = "chat-37"): ChatSessionRecord {
  const now = Date.now();
  return {
    id,
    projectId: null,
    repoRoot: "/repo",
    title: "Goal 37 Test",
    profileId: "acp:amp",
    model: "anthropic/claude-opus-5-5",
    effort: "high",
    acpSessionId: null,
    modelSelectionContext: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makePopulatedSnapshot(): WorkSnapshot {
  const now = Date.now();
  const goal: GoalRecord = {
    id: "goal-37",
    chatSessionId: "chat-37",
    repoRoot: "/repo",
    version: 1,
    title: "Default views show goals, not machinery",
    description: "Hide internal tabs and collapse tool receipts by default",
    criteria: [],
    nonGoals: [],
    budgets: { maxReviewCycles: 4, maxNoProgressCycles: 2 },
    status: "executing",
    linkedRunId: "run-32",
    reviewCycle: 0,
    noProgressStreak: 0,
    lastProgressFingerprint: null,
    lastReviewSummary: null,
    liveProgress: null,
    createdAt: now - 60_000,
    updatedAt: now,
  };
  const run: RunRecord = {
    id: "run-32",
    goal: "Default views show goals, not machinery",
    repoRoot: "/repo",
    baseBranch: "main",
    baseSha: "abc123",
    coordinationGroup: null,
    isolationMode: "standalone",
    status: "active",
    createdAt: now - 30_000,
    updatedAt: now,
  };
  const esc: EscalationRecord = {
    id: "esc-1",
    runId: "run-32",
    fromTaskId: "t-1",
    toTaskId: null,
    severity: "P0",
    category: "blocked_dependency",
    title: "Approve release window",
    evidencePaths: [],
    attempted: [],
    suggestedSplits: [],
    blocking: true,
    status: "open",
    resolution: null,
    createdAt: now - 10_000,
    ackedAt: null,
  };
  const inboxItem: InboxItem = {
    id: "inbox:esc:esc-1",
    severity: "P0",
    kind: "escalation",
    title: "Approve release window",
    detail: "from t-1 in run-32 · blocking",
    ref: { kind: "escalation", id: "esc-1", runId: "run-32", label: "esc-1 Approve release window" },
    runId: "run-32",
    taskId: "t-1",
    createdAt: now - 10_000,
  };
  const timer: TimerRecord = {
    id: "tm-1",
    ownerKind: "chat",
    ownerId: "chat-37",
    runId: "run-32",
    goalId: "goal-37",
    wakeAt: now + 300_000,
    reason: "Poll CI build",
    wakeOnEvent: "none",
    resumeGoal: false,
    status: "pending",
    firedReason: null,
    createdAt: now - 5_000,
    firedAt: null,
  };
  const wt: SnapshotWorktreeEntry = {
    id: "wt-1",
    runId: "run-32",
    taskId: "t-474",
    status: "active",
    branch: "harness/run-32/t-474",
    path: "/repo/.harness/worktrees/run-32/t-474",
    existsOnDisk: true,
    dirty: false,
    orphaned: false,
    archiveRef: null,
  };
  return {
    generatedAt: now,
    latestSeq: 5,
    goals: [{ goal, reviews: [], revisions: [] }],
    runs: [{ run, goalId: goal.id, tasks: [], escalations: [esc], quotaPause: null, activity: null }],
    escalations: [esc],
    timers: [timer],
    merges: [],
    worktrees: [wt],
    messages: [],
    inbox: [inboxItem],
    internalAttention: [],
  };
}

describe("goal-37: default views show goals, not machinery", () => {
  it("hides Runs, Timers, and Worktrees by default and reveals/hides them globally with 'i'", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(120, 24);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };

    const snap = makePopulatedSnapshot();
    const mock = makeMockClient(async (op) => {
      if (op === "work.snapshot") return snap;
      return {};
    });
    const store = new WorkStore(mock.client, { chatSessionId: "chat-37", repoRoot: "/repo" });
    await store.refresh();
    assert.equal(store.showInternal, false);

    // Wire a FixedDock via store.subscribe (mirroring app.ts syncDock) to observe global showInternal propagation
    const initHud = store.buildLiveHud();
    const dock = new FixedDock(tui, theme, {
      onSubmit: () => {},
      initialState: {
        slots: initHud.slots,
        idleBanner: "[pi-harness] · chat-37 · Director Chat",
        agentCounts: initHud.agentCounts,
        hudItems: initHud.hudItems,
        hudSecondaryLine: initHud.hudSecondaryLine,
        activeGoalsCount: initHud.activeGoalsCount,
        needYouCount: store.state.inbox.length,
        showInternal: store.showInternal,
        busy: false,
        phaseText: "Ready",
        rightStatus: "director · opus",
        queuedCount: 0,
        hints: [{ key: "Ctrl+G", label: "Work" }],
      },
    });
    const observedShowInternal: boolean[] = [];
    const syncDock = () => {
      observedShowInternal.push(store.showInternal);
      const hud = store.buildLiveHud();
      dock.update({
        slots: hud.slots,
        agentCounts: hud.agentCounts,
        hudItems: hud.hudItems,
        hudSecondaryLine: hud.hudSecondaryLine,
        activeGoalsCount: hud.activeGoalsCount,
        needYouCount: store.state.inbox.length,
        showInternal: store.showInternal,
      });
    };
    const unsubStore = store.subscribe(syncDock);

    const renderDock = () => dock.render(120).map(stripTerminalSequences).join("\n");
    const dockBeforeToggle = renderDock();
    assert.ok(dockBeforeToggle.includes("1 need you"), "Default dock must show simplified '1 need you' count");
    assert.equal(dockBeforeToggle.includes("1 esc"), false, "Default dock must not show internal '1 esc' count");

    const deps = { client: mock.client, store, repoRoot: "/repo" };
    const workNav = new WorkNavigatorScreen(deps);
    nav.push(workNav);
    assert.equal(workNav.currentTab, "goals");

    // 1. Default navigator hides Runs, Timers, Worktrees and advertises 1-3 + i show internal
    const defaultPlain = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    maybeWriteEvidence("navigator-default.txt", defaultPlain);

    assert.ok(defaultPlain.includes("1:Inbox"), "Default navigator must show Inbox tab");
    assert.ok(defaultPlain.includes("2:Goals"), "Default navigator must show Goals tab");
    assert.ok(defaultPlain.includes("3:Escalations"), "Default navigator must show Escalations tab");
    assert.equal(defaultPlain.includes("Runs"), false, "Default navigator must hide Runs tab");
    assert.equal(defaultPlain.includes("Timers"), false, "Default navigator must hide Timers tab");
    assert.equal(defaultPlain.includes("Worktrees"), false, "Default navigator must hide Worktrees tab");
    assert.ok(defaultPlain.includes("1-3"), "Default navigator hint must show 1-3");
    assert.ok(defaultPlain.includes("i show internal"), "Default navigator must show 'i' hint on Goals tab");

    // Pressing "3" selects Escalations; Right wraps to Inbox (skipping Runs/Timers/Worktrees)
    workNav.handleInput("3", ctx);
    assert.equal(workNav.currentTab, "escalations");
    workNav.handleInput("\x1b[C", ctx);
    assert.equal(workNav.currentTab, "inbox");
    // Number 4-6 fall through when only 3 tabs are visible
    workNav.handleInput("4", ctx);
    assert.equal(workNav.currentTab, "inbox");

    // Return to Goals and press 'i' (proves global toggle outside Inbox propagates via store subscriber to dock)
    workNav.handleInput("2", ctx);
    assert.equal(workNav.currentTab, "goals");
    const subscriberCallsBeforeShow = observedShowInternal.length;
    workNav.handleInput("i", ctx);
    assert.equal(store.showInternal, true);
    await waitFor(
      () => observedShowInternal.length > subscriberCallsBeforeShow,
      1000,
      "store subscriber notified on 'i' showInternal toggle",
    );
    assert.equal(
      observedShowInternal[observedShowInternal.length - 1],
      true,
      "store subscriber must observe store.showInternal === true after 'i' toggle",
    );
    const dockAfterShow = renderDock();
    assert.ok(dockAfterShow.includes("1 esc"), "Dock counts row must reflect showInternal full breakdown ('1 esc') after 'i'");
    assert.equal(dockAfterShow.includes("1 need you"), false, "Dock counts row must leave simplified '1 need you' mode when showInternal is true");

    const internalPlain = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    maybeWriteEvidence("navigator-showInternal.txt", internalPlain);

    assert.ok(internalPlain.includes("3:Runs"), "showInternal navigator must show Runs tab");
    assert.ok(internalPlain.includes("5:Timers"), "showInternal navigator must show Timers tab");
    assert.ok(internalPlain.includes("6:Worktrees"), "showInternal navigator must show Worktrees tab");
    assert.ok(internalPlain.includes("1-6"), "showInternal navigator hint must show 1-6");
    assert.ok(internalPlain.includes("i hide internal"), "showInternal navigator must show 'i hide internal'");

    // "6" selects Worktrees; pressing 'i' again falls back to Goals, hides internal tabs, and restores default dock counts
    workNav.handleInput("6", ctx);
    assert.equal(workNav.currentTab, "worktrees");
    const subscriberCallsBeforeHide = observedShowInternal.length;
    workNav.handleInput("i", ctx);
    assert.equal(store.showInternal, false);
    assert.equal(workNav.currentTab, "goals");
    await waitFor(
      () => observedShowInternal.length > subscriberCallsBeforeHide,
      1000,
      "store subscriber notified on 'i' hide internal toggle",
    );
    assert.equal(
      observedShowInternal[observedShowInternal.length - 1],
      false,
      "store subscriber must observe store.showInternal === false after hiding internal",
    );
    const dockAfterHide = renderDock();
    assert.ok(dockAfterHide.includes("1 need you"), "Dock counts row must return to simplified '1 need you' after hiding internal");
    assert.equal(dockAfterHide.includes("1 esc"), false, "Dock counts row must hide internal '1 esc' after hiding internal");

    const afterHidePlain = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.equal(afterHidePlain.includes("Worktrees"), false, "Worktrees tab must disappear after hiding internal");
    assert.equal(afterHidePlain.includes("Runs"), false, "Runs tab must disappear after hiding internal");
    assert.equal(afterHidePlain.includes("Timers"), false, "Timers tab must disappear after hiding internal");

    unsubStore();
    store.dispose();
  });

  it("keeps an explicitly opened internal tab pinned while other internal tabs stay hidden", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(120, 24);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);

    const snap = makePopulatedSnapshot();
    const mock = makeMockClient(async (op) => {
      if (op === "work.snapshot") return snap;
      return {};
    });
    const store = new WorkStore(mock.client, { chatSessionId: "chat-37", repoRoot: "/repo" });
    await store.refresh();
    assert.equal(store.showInternal, false);

    const pinnedNav = new WorkNavigatorScreen({ client: mock.client, store, repoRoot: "/repo" }, "runs");
    nav.push(pinnedNav);
    assert.equal(pinnedNav.currentTab, "runs");

    const pinnedPlain = pinnedNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(pinnedPlain.includes("Runs"), "Pinned Runs tab must remain visible");
    assert.equal(pinnedPlain.includes("Timers"), false, "Non-pinned Timers tab must remain hidden");
    assert.equal(pinnedPlain.includes("Worktrees"), false, "Non-pinned Worktrees tab must remain hidden");
    assert.ok(pinnedPlain.includes("1-4"), "Hint must reflect 4 visible tabs (3 default + 1 pinned)");

    store.dispose();
  });

  it("renders simplified dock counts by default and full breakdown with showInternal", () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(120, 30);
    const tui = new ModalScreen(terminal);

    const dock = new FixedDock(tui, theme, {
      onSubmit: () => {},
      initialState: {
        slots: [],
        idleBanner: "[pi-harness] · chat-37 · Director Chat",
        agentCounts: {
          active: 0,
          waiting: 0,
          blocked: 0,
          paused: 0,
          queued: 0,
          failed: 0,
          openEscalations: 0,
          activeMerges: 0,
        },
        activeGoalsCount: 0,
        needYouCount: 0,
        showInternal: false,
        busy: false,
        phaseText: "Ready",
        rightStatus: "director · opus",
        queuedCount: 0,
        hints: [{ key: "Ctrl+G", label: "Work" }],
      },
    });

    // 1. Default idle state
    const idleLines = dock.render(100);
    const expectedHeight = idleLines.length;
    const idlePlain = idleLines.map(stripTerminalSequences).join("\n");
    assert.ok(idlePlain.includes("Agents: 0 active"), "Default idle dock must keep 'Agents: 0 active'");
    assert.ok(idlePlain.includes("Ctrl+G Work"), "Default idle dock right hint must point to Ctrl+G Work");
    assert.equal(idlePlain.includes("Ctrl+T Runs"), false, "Default idle dock must not point to hidden Ctrl+T Runs");

    // 2. Default busy state: active + need you + goals, no internal counts
    dock.update({
      agentCounts: {
        active: 3,
        waiting: 1,
        blocked: 2,
        paused: 2,
        queued: 2,
        failed: 1,
        openEscalations: 1,
        activeMerges: 2,
      },
      needYouCount: 1,
      activeGoalsCount: 2,
      showInternal: false,
      busy: true,
      phaseText: "Coordinating goals…",
    });

    for (const w of [60, 100, 140]) {
      const lines = dock.render(w);
      assert.equal(lines.length, expectedHeight, `Default dock height must stay constant at width ${w}`);
      for (const l of lines) {
        assert.ok(visibleWidth(l) <= w, `Default dock overflowed width ${w}: got ${visibleWidth(l)}`);
      }
    }

    const defaultDockPlain = dock.render(120).map(stripTerminalSequences).join("\n");
    maybeWriteEvidence("dock-default.txt", defaultDockPlain);

    assert.ok(defaultDockPlain.includes("3 active"), "Default dock must show active count");
    assert.ok(defaultDockPlain.includes("1 need you"), "Default dock must show need-you count");
    assert.ok(defaultDockPlain.includes("2 goals"), "Default dock must show goal count");
    assert.equal(defaultDockPlain.includes("blocked"), false, "Default dock must hide blocked count");
    assert.equal(defaultDockPlain.includes("queued"), false, "Default dock must hide queued count");
    assert.equal(defaultDockPlain.includes("failed"), false, "Default dock must hide failed count");
    assert.equal(defaultDockPlain.includes("merges"), false, "Default dock must hide merges count");

    // 3. Default state with 0 active and >0 needYou keeps "0 active · N need you"
    dock.update({
      agentCounts: {
        active: 0,
        waiting: 0,
        blocked: 2,
        paused: 0,
        queued: 1,
        failed: 1,
        openEscalations: 1,
        activeMerges: 0,
      },
      needYouCount: 2,
      activeGoalsCount: 1,
      showInternal: false,
    });
    const needOnlyPlain = dock.render(100).map(stripTerminalSequences).join("\n");
    assert.ok(needOnlyPlain.includes("0 active"), "Default dock keeps '0 active' when only need-you is non-zero");
    assert.ok(needOnlyPlain.includes("2 need you"), "Default dock shows need-you count when active is 0");
    assert.ok(needOnlyPlain.includes("1 goal"), "Default dock shows singular goal count");
    assert.equal(needOnlyPlain.includes("blocked"), false, "Default dock still hides internal counts");

    // 4. showInternal true: full agent breakdown restored
    dock.update({
      agentCounts: {
        active: 3,
        waiting: 1,
        blocked: 2,
        paused: 2,
        queued: 2,
        failed: 1,
        openEscalations: 1,
        activeMerges: 2,
      },
      needYouCount: 1,
      activeGoalsCount: 2,
      showInternal: true,
    });

    const internalDockPlain = dock.render(120).map(stripTerminalSequences).join("\n");
    maybeWriteEvidence("dock-showInternal.txt", internalDockPlain);

    assert.ok(internalDockPlain.includes("3 active"), "showInternal dock must show active count");
    assert.ok(internalDockPlain.includes("2 blocked"), "showInternal dock must show blocked count");
    assert.ok(internalDockPlain.includes("2 queued"), "showInternal dock must show queued count");
    assert.ok(internalDockPlain.includes("1 failed"), "showInternal dock must show failed count");
    assert.ok(internalDockPlain.includes("2 merges"), "showInternal dock must show merges count");
  });

  it("collapses per-turn chat tools receipt to a count and preserves full tool details in Ctrl+X inspector", async () => {
    const { terminal, writes, text, since, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-37-tools");
    let resolveSend1!: () => void;
    let resolveSend2!: () => void;
    const sendGates = [
      new Promise<void>((r) => (resolveSend1 = r)),
      new Promise<void>((r) => (resolveSend2 = r)),
    ];
    let sendIdx = 0;

    const snap = makePopulatedSnapshot();
    const mock = makeMockClient(async (op) => {
      if (op === "ping") {
        return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-test" };
      }
      if (op === "chat.open") {
        return {
          session,
          history: [],
          historyNext: null,
          historyThrough: 0,
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          tookOver: false,
          busy: false,
        };
      }
      if (op === "chat.history") return { history: [], historyNext: null };
      if (op === "work.snapshot") return snap;
      if (op === "chat.send") {
        const gate = sendGates[sendIdx++];
        if (gate) await gate;
        return { ok: true };
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("goal-37") && text().includes("Ready"), 3000, "initial chat render");

    typeText("Check files and run tests");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send called");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    const callId1 = "tc-payload-alpha-1";
    const callId2 = "tc-payload-beta-2";

    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId,
        toolCallId: callId1,
        name: "read_file",
        status: "completed",
      },
    });
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId,
        toolCallId: callId2,
        name: "run_tests",
        status: "completed",
      },
    });
    mock.emit({
      kind: "event",
      seq: 3,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId,
        historyThrough: 2,
        assistantTurn: {
          seq: 2,
          chatSessionId: session.id,
          role: "assistant",
          content: "All checks are green.",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSend1();

    await waitFor(() => text().includes("[tools]"), 3000, "collapsed tools receipt rendered");
    const transcriptBeforeInspector = text();
    const receiptLines = transcriptBeforeInspector
      .split("\n")
      .filter((l) => l.includes("[tools]"));
    assert.ok(receiptLines.length > 0, "Rendered transcript must contain a '[tools]' receipt line");
    for (const line of receiptLines) {
      assert.ok(line.includes("2 calls"), `Tools receipt line must contain '2 calls', got: ${line}`);
      assert.equal(line.includes("read_file"), false, `Tools receipt line must not include tool label 'read_file', got: ${line}`);
      assert.equal(line.includes("run_tests"), false, `Tools receipt line must not include tool label 'run_tests', got: ${line}`);
      assert.equal(line.includes("call(s):"), false, `Tools receipt line must not use verbose 'call(s):', got: ${line}`);
    }
    assert.equal(transcriptBeforeInspector.includes(callId1), false, "Payload-only tool call id 1 must not appear in transcript before Ctrl+X");
    assert.equal(transcriptBeforeInspector.includes(callId2), false, "Payload-only tool call id 2 must not appear in transcript before Ctrl+X");

    // Open Ctrl+X inspector and verify both payload-only call IDs (not just labels) appear in the inspector output
    const writesBeforeInspect = writes.length;
    sendInput("\x18");
    await waitFor(
      () => since(writesBeforeInspect).includes("Esc close"),
      3000,
      "Ctrl+X inspector opened",
    );

    const inspectorOut = since(writesBeforeInspect);
    assert.ok(
      inspectorOut.includes(callId1),
      "Ctrl+X inspector must render first payload-only tool call id from settled.tools",
    );
    assert.ok(
      inspectorOut.includes(callId2),
      "Ctrl+X inspector must render second payload-only tool call id from settled.tools",
    );
    assert.ok(inspectorOut.includes("read_file"), "Ctrl+X inspector must include first tool label");
    assert.ok(inspectorOut.includes("run_tests"), "Ctrl+X inspector must include second tool label");

    const receiptLine = receiptLines[receiptLines.length - 1]!;
    maybeWriteEvidence(
      "tools-receipt.txt",
      `=== Transcript receipt ===\n${receiptLine.trim()}\n\n=== Ctrl+X inspector ===\n${inspectorOut.trim()}`,
    );

    sendInput("\x1b"); // Close inspector

    // Also verify a turn with a failed tool renders "N call · K failed" and /internal updates dock counts
    const writesBeforeFailTurn = writes.length;
    typeText("Run failing tool");
    sendInput("\r");
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.send").length >= 2, 3000, "second chat.send");
    const turnId2 = String(mock.calls.filter((c) => c.op === "chat.send")[1]!.params.turnId);

    mock.emit({
      kind: "event",
      seq: 4,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: turnId2,
        toolCallId: "tc-3",
        name: "lint_check",
        status: "error",
      },
    });
    mock.emit({
      kind: "event",
      seq: 5,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: turnId2,
        historyThrough: 4,
        assistantTurn: {
          seq: 4,
          chatSessionId: session.id,
          role: "assistant",
          content: "Lint failed.",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSend2();

    await waitFor(
      () => since(writesBeforeFailTurn).includes("[tools] 1 call · 1 failed"),
      3000,
      "failed tool receipt rendered",
    );

    // Toggle /internal and confirm dock refreshes to show full internal breakdown (1 esc from snap)
    const writesBeforeInternal = writes.length;
    typeText("/internal");
    sendInput("\r");
    await waitFor(
      () => since(writesBeforeInternal).includes("1 esc"),
      3000,
      "/internal refreshes dock to show internal agent breakdown",
    );

    sendInput("\x1d"); // Detach cleanly
    await runPromise;
  });
});
