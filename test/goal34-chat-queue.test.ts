import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../src/director/session.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui } from "../src/tui/app.js";
import { ChatQueueModel, formatQueueItemState, formatQueueReason } from "../src/tui/chat-queue.js";
import { createTheme, FixedDock, stripTerminalSequences } from "../src/tui/core/index.js";

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
  let connected = true;
  let connectionEpoch = 1;

  const client = {
    get connected() {
      return connected;
    },
    get connectionEpoch() {
      return connectionEpoch;
    },
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
    async connect() {
      connected = true;
      connectionEpoch += 1;
    },
    close() {
      connected = false;
      for (const fn of closeListeners) fn();
    },
  } as unknown as DaemonClient;

  return {
    client,
    calls,
    emit(ev: DaemonEventFrame) {
      for (const fn of eventListeners) fn(ev);
    },
    disconnect() {
      connected = false;
      for (const fn of closeListeners) fn();
    },
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) return count;
    count += 1;
    idx = found + needle.length;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function makeChatSession(id = "chat-q34"): ChatSessionRecord {
  const now = Date.now();
  return {
    id,
    projectId: null,
    repoRoot: "/repo",
    title: "Goal 34 Queue Test",
    profileId: "acp:amp",
    model: "anthropic/claude-opus-5-5",
    effort: "high",
    acpSessionId: null,
    modelSelectionContext: null,
    createdAt: now,
    updatedAt: now,
  };
}

function emptyWorkSnapshot() {
  return {
    generatedAt: Date.now(),
    latestSeq: 0,
    goals: [],
    runs: [],
    escalations: [],
    timers: [],
    merges: [],
    worktrees: [],
    messages: [],
    inbox: [],
  };
}

describe("goal-34 c2: ChatQueueModel pure unit tests", () => {
  it("preserves FIFO order, supports front insertion, state transitions, and reason formatting", () => {
    const q = new ChatQueueModel();
    assert.equal(q.length, 0);
    assert.equal(q.queuedLength, 0);

    const a = q.enqueue("first message", { state: "sending", reason: "after_turn" });
    const b = q.enqueue("second message", { state: "queued", reason: "after_turn" });
    const c = q.enqueue("urgent front", { state: "queued", reason: "restart", front: true });

    assert.equal(q.length, 3);
    assert.equal(q.queuedLength, 2);
    assert.deepEqual(
      q.list().map((i) => i.text),
      ["urgent front", "first message", "second message"],
    );

    assert.equal(formatQueueItemState(a), "sending");
    assert.equal(formatQueueItemState(b), "queued · sends after this turn");
    assert.equal(formatQueueReason("reconnect"), "sends when harnessd reconnects");
    assert.equal(formatQueueReason("restart"), "sends after harnessd restarts");
    assert.equal(formatQueueReason("control"), "sends when you take control");

    const transitioned = q.markQueued(a.id, "reconnect");
    assert.equal(transitioned?.state, "queued");
    assert.equal(transitioned?.reason, "reconnect");
    assert.equal(q.queuedLength, 3);

    const sending = q.markSending(c.id);
    assert.equal(sending?.state, "sending");
    assert.equal(q.queuedLength, 2);

    // takeNext skips `sending` items and returns the first `queued` item
    const next = q.takeNext();
    assert.equal(next?.id, a.id);
    assert.equal(q.length, 2);
  });

  it("supports removeAt, removeById, popLatest (skipping sending), and clearQueued", () => {
    const q = new ChatQueueModel();
    const s = q.enqueue("in flight", { state: "sending", reason: "after_turn" });
    const q1 = q.enqueue("queued one", { state: "queued", reason: "after_turn" });
    const q2 = q.enqueue("queued two", { state: "queued", reason: "after_turn" });
    const q3 = q.enqueue("queued three", { state: "queued", reason: "control" });

    assert.equal(q.removeAt(-1), null);
    assert.equal(q.removeAt(99), null);
    assert.equal(q.popLatest()?.id, q3.id);
    assert.equal(q.removeAt(1)?.id, q1.id);
    assert.deepEqual(
      q.list().map((i) => i.id),
      [s.id, q2.id],
    );

    // clearQueued leaves in-flight `sending` item untouched
    const cleared = q.clearQueued();
    assert.deepEqual(
      cleared.map((i) => i.id),
      [q2.id],
    );
    assert.deepEqual(
      q.list().map((i) => i.id),
      [s.id],
    );
    assert.equal(q.popLatest(), null);
    assert.equal(q.removeById(s.id)?.id, s.id);
    assert.equal(q.length, 0);
  });

  it("FixedDock renders pinned queue strip with cap + overflow row and adds zero rows when empty", () => {
    const theme = createTheme({ color: false, ascii: false });
    const fakeTui = {
      terminal: { columns: 100, rows: 30 },
      requestRender() {},
    } as unknown as TUI;

    const dock = new FixedDock(fakeTui, theme, {
      onSubmit: () => {},
      initialState: {
        slots: [],
        idleBanner: "Ready",
        busy: true,
        phaseText: "Director responding...",
        rightStatus: "chat-q34",
        queuedCount: 0,
        queuedItems: [],
        hints: [{ key: "Ctrl+G", label: "Work" }],
      },
    });

    const emptyLines = dock.render(100);
    assert.equal(emptyLines.length, 9, "Empty queue must keep baseline 9-row FixedDock height");

    const q = new ChatQueueModel();
    q.enqueue("First queued item", { state: "sending", reason: "after_turn" });
    q.enqueue("Second queued item", { state: "queued", reason: "after_turn" });
    q.enqueue("Third queued item", { state: "queued", reason: "reconnect" });
    q.enqueue("Fourth queued item", { state: "queued", reason: "restart" });
    q.enqueue("Fifth queued item", { state: "queued", reason: "control" });
    q.enqueue("Sixth queued item", { state: "queued", reason: "after_turn" });
    q.enqueue("Seventh queued item", { state: "queued", reason: "after_turn" });

    dock.update({ queuedCount: q.length, queuedItems: q.list() });
    const fullLines = dock.render(100).map((l) => stripTerminalSequences(l));
    // Cap is 5 visible items + 1 overflow row = 6 extra rows
    assert.equal(fullLines.length, 9 + 6);
    const joined = fullLines.join("\n");
    assert.ok(joined.includes("1 sending"));
    assert.ok(joined.includes("First queued item"));
    assert.ok(joined.includes("2 queued · sends after this turn"));
    assert.ok(joined.includes("3 queued · sends when harnessd reconnects"));
    assert.ok(joined.includes("4 queued · sends after harnessd restarts"));
    assert.ok(joined.includes("5 queued · sends when you take control"));
    assert.ok(joined.includes("+2 more queued"));
    assert.ok(joined.includes("Ctrl+R edit · Alt+Q drop"));
  });
});

describe("goal-34 c2: runDirectorChatTui pinned queue strip end-to-end", () => {
  it("shows sending immediately while chat.steer hangs, transitions to queued on {steered:false}, drains on turn end, and renders user turn once", async () => {
    const { terminal, writes, text, since, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-q34-e2e");
    const queuedMsg = "I think we can keep IDs scoped to session";

    let resolveFirstSend!: () => void;
    const firstSendGate = new Promise<void>((r) => (resolveFirstSend = r));
    let resolveSteer!: (val: { steered: boolean }) => void;
    const steerGate = new Promise<{ steered: boolean }>((r) => (resolveSteer = r));
    let sendCount = 0;

    const mock = makeMockClient(async (op) => {
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
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "chat.send") {
        sendCount += 1;
        if (sendCount === 1) {
          await firstSendGate;
        }
        return { ok: true };
      }
      if (op === "chat.steer") {
        return await steerGate;
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-q34-e2e"), 3000, "initial render");

    // 1. Start turn 1
    typeText("Initial prompt");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "first chat.send");
    const turn1Id = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    // 2. While turn 1 is active and chat.steer will hang, type queuedMsg and press Enter
    const markBeforeQueue = writes.length;
    typeText(queuedMsg);
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.steer"), 3000, "chat.steer invoked");

    // Assert the pinned queue strip renders the message as `sending` BEFORE chat.steer resolves
    await waitFor(
      () => since(markBeforeQueue).includes("1 sending") && since(markBeforeQueue).includes(queuedMsg),
      3000,
      "sending state visible before steer resolves",
    );

    // 3. Resolve chat.steer as { steered: false } -> transitions to `queued · sends after this turn`
    const markBeforeSteerResolve = writes.length;
    resolveSteer({ steered: false });
    await waitFor(
      () => since(markBeforeSteerResolve).includes("queued · sends after this turn"),
      3000,
      "queued · sends after this turn visible",
    );

    // Must NOT append legacy `[queued] Queued (` receipt
    assert.equal(text().includes("[queued]"), false, "Must not render removed [queued] transcript receipt");

    // 4. End turn 1 -> drains queuedMsg via chat.send, clears strip, renders user turn once
    const markBeforeDrain = writes.length;
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: turn1Id,
        historyThrough: 2,
        assistantTurn: {
          seq: 2,
          chatSessionId: session.id,
          role: "assistant",
          content: "First answer done.",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveFirstSend();

    await waitFor(
      () => mock.calls.filter((c) => c.op === "chat.send").length === 2,
      3000,
      "second chat.send drained queued message",
    );
    const secondSend = mock.calls.filter((c) => c.op === "chat.send")[1]!;
    assert.equal(secondSend.params.text, queuedMsg);
    const turn2Id = String(secondSend.params.turnId);

    // Finish turn 2 so the transcript and dock settle
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: turn2Id,
        historyThrough: 4,
        assistantTurn: {
          seq: 4,
          chatSessionId: session.id,
          role: "assistant",
          content: "Scoped IDs noted.",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    await waitFor(() => since(markBeforeDrain).includes("Scoped IDs noted."), 3000, "second turn settled");

    // Strip must no longer appear in the final frame, and queuedMsg appears once as a UserCard
    const afterDrainText = since(markBeforeDrain);
    assert.equal(afterDrainText.includes("sends after this turn"), false, "Queue strip should be empty after drain");
    assert.equal(countOccurrences(afterDrainText, queuedMsg), 1, "Queued message should render once after drain");
    assert.equal(
      (afterDrainText.match(new RegExp(`[›>] ${queuedMsg}`, "g")) ?? []).length,
      1,
      "Queued message should render once as a user turn",
    );
    assert.equal(text().includes("[queued]"), false);

    sendInput("\x1d");
    await runPromise;
  });

  it("supports Ctrl+Q queueing, Ctrl+R recall, Alt+Q drop, /drop, and offline reconnect reason", async () => {
    const { terminal, writes, text, since, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-q34-keys");

    let resolveSend!: () => void;
    const sendGate = new Promise<void>((r) => (resolveSend = r));

    const mock = makeMockClient(async (op) => {
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
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "chat.send") {
        await sendGate;
        return { ok: true };
      }
      if (op === "ping") {
        throw new Error("daemon offline");
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-q34-keys"), 3000, "initial render");

    // Start an active turn
    typeText("Busy turn");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "busy turn started");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    // Queue two items with Ctrl+Q without calling chat.steer
    typeText("keep-first");
    sendInput("\x11");
    await waitFor(() => text().includes("1 queued · sends after this turn") && text().includes("keep-first"), 3000, "first Ctrl+Q queued");

    typeText("drop-second");
    sendInput("\x11");
    await waitFor(() => text().includes("2 queued · sends after this turn") && text().includes("drop-second"), 3000, "second Ctrl+Q queued");
    assert.equal(mock.calls.some((c) => c.op === "chat.steer"), false, "Ctrl+Q must not call chat.steer");

    // Drop latest (`drop-second`) with Alt+Q
    const markAfterAltQ = writes.length;
    sendInput("\x1bq");
    await waitFor(() => since(markAfterAltQ).includes("+1 queued"), 3000, "Alt+Q dropped second item");

    // Recall `keep-first` with Ctrl+R into composer, edit it, and re-queue with Ctrl+Q
    sendInput("\x12");
    await new Promise((r) => setTimeout(r, 30));
    typeText("-edited");
    sendInput("\x11");
    await waitFor(() => text().includes("keep-first-edited"), 3000, "recalled and re-queued edited draft");

    // Drop via `/drop all`
    const markAfterDrop = writes.length;
    typeText("/drop all");
    sendInput("\r");
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(since(markAfterDrop).includes("keep-first-edited"), false, "/drop all cleared the strip");

    // End the active turn so nothing drains
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, historyThrough: 1 },
    });
    resolveSend();
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.send").length === 1, 3000, "no dropped items sent");
    await new Promise((r) => setTimeout(r, 40));

    // Go offline and submit a message -> shows `queued · sends when harnessd reconnects` immediately
    const markOffline = writes.length;
    mock.disconnect();
    await waitFor(() => since(markOffline).includes("RECONNECTING"), 3000, "offline state shown");
    typeText("offline-msg");
    sendInput("\r");
    await waitFor(
      () => since(markOffline).includes("queued · sends when harnessd reconnects") && since(markOffline).includes("offline-msg"),
      3000,
      "offline queued item shown in strip",
    );
    assert.equal(text().includes("Queued until harnessd reconnects"), false, "Must not render removed offline receipt");

    sendInput("\x1d");
    await runPromise;
  });
});
