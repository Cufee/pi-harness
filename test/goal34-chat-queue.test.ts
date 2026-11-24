import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { Terminal, TUI } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../src/director/session.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui } from "../src/tui/app.js";
import { ChatQueueModel, formatQueueItemState, formatQueueReason } from "../src/tui/chat-queue.js";
import { createTheme, FixedDock, stripTerminalSequences } from "../src/tui/core/index.js";

function createVirtualScreen(rows: number) {
  let lines: string[] = [""];
  let row = 0;
  let col = 0;
  let viewportTop = 0;

  const ensureRow = (r: number) => {
    while (lines.length <= r) lines.push("");
  };

  const writeChar = (ch: string) => {
    ensureRow(row);
    const cur = lines[row]!;
    if (col > cur.length) lines[row] = cur + " ".repeat(col - cur.length) + ch;
    else if (col === cur.length) lines[row] = cur + ch;
    else lines[row] = cur.slice(0, col) + ch + cur.slice(col + 1);
    col += 1;
  };

  const feed = (data: string) => {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        const next = data[i + 1];
        if (next === "[") {
          let j = i + 2;
          while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j += 1;
          const params = data.slice(i + 2, j);
          const cmd = data[j] ?? "";
          i = j + 1;
          if (params.startsWith("?")) continue;
          const n = params === "" ? 1 : Number.parseInt(params.split(";")[0] || "1", 10);
          if (cmd === "A") {
            row = Math.max(viewportTop, row - (Number.isFinite(n) ? n : 1));
          } else if (cmd === "B") {
            row = Math.min(viewportTop + rows - 1, row + (Number.isFinite(n) ? n : 1));
            ensureRow(row);
          } else if (cmd === "G") {
            col = Math.max(0, (Number.isFinite(n) ? n : 1) - 1);
          } else if (cmd === "H" || cmd === "f") {
            const parts = params.split(";");
            const r = parts[0] ? Number.parseInt(parts[0], 10) : 1;
            const c = parts[1] ? Number.parseInt(parts[1], 10) : 1;
            row = viewportTop + Math.max(0, (Number.isFinite(r) ? r : 1) - 1);
            col = Math.max(0, (Number.isFinite(c) ? c : 1) - 1);
            ensureRow(row);
          } else if (cmd === "K") {
            ensureRow(row);
            const mode = params === "" ? 0 : Number.parseInt(params, 10);
            if (mode === 2) lines[row] = "";
            else if (mode === 0) lines[row] = lines[row]!.slice(0, col);
            else if (mode === 1) lines[row] = " ".repeat(col) + lines[row]!.slice(col);
          } else if (cmd === "J") {
            const mode = params === "" ? 0 : Number.parseInt(params, 10);
            if (mode === 3) {
              lines = lines.slice(viewportTop);
              row = Math.max(0, row - viewportTop);
              viewportTop = 0;
            } else if (mode === 2) {
              for (let r = viewportTop; r < Math.max(lines.length, viewportTop + rows); r += 1) {
                if (r < lines.length) lines[r] = "";
              }
            } else if (mode === 0) {
              ensureRow(row);
              lines[row] = lines[row]!.slice(0, col);
              for (let r = row + 1; r < lines.length; r += 1) lines[r] = "";
            }
          }
          continue;
        }
        if (next === "]") {
          let j = i + 2;
          while (j < data.length) {
            if (data[j] === "\x07") {
              j += 1;
              break;
            }
            if (data[j] === "\x1b" && data[j + 1] === "\\") {
              j += 2;
              break;
            }
            j += 1;
          }
          i = j;
          continue;
        }
        if (next === "_") {
          let j = i + 2;
          while (j < data.length && !(data[j] === "\x1b" && data[j + 1] === "\\")) j += 1;
          i = j + 2;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === "\r") {
        col = 0;
        i += 1;
        continue;
      }
      if (ch === "\n") {
        row += 1;
        if (row >= viewportTop + rows) viewportTop = row - rows + 1;
        ensureRow(row);
        i += 1;
        continue;
      }
      if (ch === "\b") {
        col = Math.max(0, col - 1);
        i += 1;
        continue;
      }
      writeChar(ch);
      i += 1;
    }
  };

  return {
    feed,
    text: () => lines.map((l) => l.trimEnd()).join("\n"),
  };
}

function makeFakeTerminal(cols = 120, rows = 30) {
  let onDataCb: ((data: string) => void) | null = null;
  const writes: string[] = [];
  const screen = createVirtualScreen(rows);
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
      screen.feed(d);
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
    /** Final rendered terminal state (scrollback + viewport). */
    text: () => screen.text(),
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
  const pendingRejectors = new Set<(err: Error) => void>();
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
      if (!connected) {
        throw new Error("DaemonClient not connected");
      }
      calls.push({ op, params });
      return await new Promise<T>((resolve, reject) => {
        const rejectOnDisconnect = (err: Error) => {
          pendingRejectors.delete(rejectOnDisconnect);
          reject(err);
        };
        pendingRejectors.add(rejectOnDisconnect);
        Promise.resolve(handler(op, params)).then(
          (val) => {
            if (!pendingRejectors.delete(rejectOnDisconnect)) return;
            resolve(val as T);
          },
          (err) => {
            if (!pendingRejectors.delete(rejectOnDisconnect)) return;
            reject(err);
          },
        );
      });
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
      for (const rej of [...pendingRejectors]) rej(new Error("Disconnected from harnessd"));
      pendingRejectors.clear();
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
      connectionEpoch += 1;
      for (const rej of [...pendingRejectors]) rej(new Error("Disconnected from harnessd"));
      pendingRejectors.clear();
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

  it("FixedDock uses available terminal rows, renders unconfirmed state, shows '+N more · /queue' on overflow, and adds zero rows when empty", () => {
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
    const u = q.enqueue("Sixth unconfirmed item", { state: "sending", reason: "after_turn" });
    q.markUnconfirmed(u.id);
    q.enqueue("Seventh queued item", { state: "queued", reason: "after_turn" });

    assert.equal(q.queuedLength, 5, "queuedLength counts only queued items (not sending or unconfirmed)");
    assert.equal(q.removableLength, 6, "removableLength counts queued and unconfirmed items (excluding sending)");
    assert.equal(formatQueueItemState(q.get(u.id)!), "may not have been delivered");

    dock.update({ queuedCount: q.queuedLength, queuedItems: q.list() });
    const fullLines = dock.render(100).map((l) => stripTerminalSequences(l));
    // At 30 terminal rows (9 baseline dock + 6 transcript reserve -> 15 rows available), all 7 items fit directly!
    assert.equal(fullLines.length, 9 + 7);
    const joined = fullLines.join("\n");
    assert.ok(joined.includes("1 sending"));
    assert.ok(joined.includes("First queued item"));
    assert.ok(joined.includes("2 queued · sends after this turn"));
    assert.ok(joined.includes("3 queued · sends when harnessd reconnects"));
    assert.ok(joined.includes("4 queued · sends after harnessd restarts"));
    assert.ok(joined.includes("5 queued · sends when you take control"));
    assert.ok(joined.includes("6 may not have been delivered"));
    assert.ok(joined.includes("Sixth unconfirmed item"));
    assert.ok(joined.includes("7 queued · sends after this turn"));
    assert.ok(joined.includes("Seventh queued item"));
    assert.ok(joined.includes("Alt+S /now · Ctrl+R edit · Alt+Q drop"));

    // On a short 17-row terminal (8 baseline dock + 6 reserve -> 3 strip rows), overflow shows `+N more · /queue`
    const shortTui = { terminal: { columns: 100, rows: 17 }, requestRender() {} } as unknown as TUI;
    const shortDock = new FixedDock(shortTui, theme, {
      onSubmit: () => {},
      initialState: {
        slots: [],
        idleBanner: "Ready",
        busy: true,
        phaseText: "Working",
        rightStatus: "chat-q34",
        queuedCount: q.queuedLength,
        queuedItems: q.list(),
        hints: [{ key: "Ctrl+G", label: "Work" }],
      },
    });
    const shortLines = shortDock.render(100).map((l) => stripTerminalSequences(l));
    assert.equal(shortLines.length, 8 + 3, "Short terminal uses 2 visible items + 1 overflow row");
    assert.ok(shortLines.join("\n").includes("+5 more · /queue"));
  });
});

describe("goal-34 c2: runDirectorChatTui pinned queue strip end-to-end", () => {
  it("busy Enter queues without RPC, explicit /now shows sending while chat.steer hangs, reverts to queued on {steered:false}, drains on turn end, and renders user turn once", async () => {
    const { terminal, writes, text, since, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-q34-e2e");
    const queuedMsg = "I think we can keep IDs scoped to session";

    let resolveFirstSend!: () => void;
    const firstSendGate = new Promise<void>((r) => (resolveFirstSend = r));
    let resolveSteer!: (val: { steered: boolean; cancelled?: boolean }) => void;
    const steerGate = new Promise<{ steered: boolean; cancelled?: boolean }>((r) => (resolveSteer = r));
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

    // 1. Start turn 1 and stream a delta so the daemon confirms acceptance of turn 1
    typeText("Initial prompt");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "first chat.send");
    const turn1Id = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: turn1Id, delta: "Working on initial..." },
    });
    await waitFor(() => text().includes("Working on initial..."), 3000, "turn 1 accepted");

    // 2. While turn 1 is active, busy Enter queues in the strip with zero steer/cancel RPCs
    const markBeforeQueue = writes.length;
    typeText(queuedMsg);
    sendInput("\r");
    await waitFor(
      () => since(markBeforeQueue).includes("1 queued · sends after this turn") && since(markBeforeQueue).includes(queuedMsg),
      3000,
      "busy Enter immediately queues in strip",
    );
    assert.equal(mock.calls.some((c) => c.op === "chat.steer"), false, "Busy Enter must not call chat.steer");
    assert.equal(mock.calls.some((c) => c.op === "chat.cancel"), false, "Busy Enter must not call chat.cancel");

    // 3. Explicit `/now` triggers chat.steer (which hangs) -> strip transitions to `1 sending` before steer resolves
    const markBeforeNow = writes.length;
    typeText("/now");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.steer"), 3000, "chat.steer invoked by /now");
    const steerCall = mock.calls.find((c) => c.op === "chat.steer")!;
    assert.equal(steerCall.params.message, queuedMsg);
    assert.equal(steerCall.params.turnId, turn1Id);

    await waitFor(
      () => since(markBeforeNow).includes("1 sending") && since(markBeforeNow).includes(queuedMsg),
      3000,
      "sending state visible before steer resolves",
    );

    // 4. Resolve chat.steer as { steered: false, cancelled: false } -> transitions back to `queued · sends after this turn`
    const markBeforeSteerResolve = writes.length;
    resolveSteer({ steered: false, cancelled: false });
    await waitFor(
      () => since(markBeforeSteerResolve).includes("queued · sends after this turn"),
      3000,
      "queued · sends after this turn visible",
    );
    assert.equal(mock.calls.some((c) => c.op === "chat.cancel"), false, "Rejected steer must never trigger chat.cancel");

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
      if (op === "chat.steer") {
        return { steered: true };
      }
      if (op === "ping") {
        throw new Error("daemon offline");
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-q34-keys"), 3000, "initial render");

    // Start an active turn (daemon emits delta to confirm acceptance)
    typeText("Busy turn");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "busy turn started");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: "Busy streaming..." },
    });
    await waitFor(() => text().includes("Busy streaming..."), 3000, "busy turn confirmed");

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

    // Queue two more items; steer #2 with `/now 2`, then steer remaining #1 with `Alt+S`
    typeText("steer-first-by-key");
    sendInput("\r");
    await waitFor(() => text().includes("steer-first-by-key"), 3000, "queued first for send-now");
    typeText("steer-second-by-cmd");
    sendInput("\r");
    await waitFor(() => text().includes("steer-second-by-cmd"), 3000, "queued second for send-now");
    assert.equal(mock.calls.filter((c) => c.op === "chat.steer").length, 0, "Busy Enter must not steer");

    typeText("/now 2");
    sendInput("\r");
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.steer").length === 1, 3000, "/now 2 steered second item");
    assert.equal(mock.calls.filter((c) => c.op === "chat.steer")[0]!.params.message, "steer-second-by-cmd");

    sendInput("\x1bs");
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.steer").length === 2, 3000, "Alt+S steered first queued item");
    assert.equal(mock.calls.filter((c) => c.op === "chat.steer")[1]!.params.message, "steer-first-by-key");

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

  it("should-fix 6: pre-accept rejections (read-only, DAEMON_RELOADING, already responding, pre-write failure) re-queue without duplicate user cards", async () => {
    const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-q34-sf6");
    let sendAttempt = 0;

    const mock = makeMockClient(async (op, params) => {
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
          control: { sessionId: session.id, clientId: "c1", controllerClientId: "c1", hasControl: true, controlSeq: 1 },
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.take_control") {
        return { sessionId: session.id, clientId: "c1", controllerClientId: "c1", hasControl: true, controlSeq: 3, tookOver: true };
      }
      if (op === "chat.send") {
        sendAttempt += 1;
        if (sendAttempt === 1) {
          // Read-only rejection on first attempt
          throw new Error("Session is read-only. Take control first.");
        }
        if (sendAttempt === 2) {
          // Pre-write transport failure (remote.ts:241/248) -> must stay queued with reason "reconnect", not drop!
          throw new Error("Failed to write request to daemon stream");
        }
        if (sendAttempt === 3) {
          // Race with a wake turn ("Director is already responding") -> must stay queued with reason "after_turn"
          throw new Error("Director is already responding");
        }
        if (sendAttempt === 4) {
          // Daemon reloading rejection -> must stay queued with reason "restart" and zero duplicate card
          throw new Error("DAEMON_RELOADING: draining");
        }
        // Fifth attempt succeeds: emit chat.turn.end cleanly
        const tid = String(params.turnId);
        setTimeout(() => {
          mock.emit({
            kind: "event",
            seq: 10,
            runId: session.id,
            taskId: session.id,
            type: "chat.turn.end",
            createdAt: Date.now(),
            payload: {
              chatSessionId: session.id,
              turnId: tid,
              historyThrough: 2,
              assistantTurn: {
                seq: 2,
                chatSessionId: session.id,
                role: "assistant",
                content: "ACCEPTED-ONCE-SF6",
                createdAt: Date.now(),
              } satisfies ChatTurnRecord,
            },
          });
        }, 10);
        return { ok: true };
      }
      if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-sf6" };
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-q34-sf6"), 3000, "initial render");

    // 1. Submit "ONE-CARD-MSG" -> attempt #1 rejected read-only -> queued with reason "control" and ZERO user cards
    typeText("ONE-CARD-MSG");
    sendInput("\r");
    await waitFor(
      () => text().includes("sends when you take control") && text().includes("ONE-CARD-MSG"),
      3000,
      "requeued with control reason on read-only rejection",
    );
    assert.equal((text().match(/[›>] ONE-CARD-MSG/g) ?? []).length, 0, "Rejected read-only send must not render a user card");

    // Demote control to another client, then reclaim via /take -> drains attempt #2 -> pre-write failure -> queued "reconnect"
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: null,
      type: "session.control_changed",
      createdAt: Date.now(),
      payload: { sessionId: session.id, controllerClientId: "other-client", controlSeq: 2 },
    });
    await waitFor(() => text().includes("READ-ONLY"), 3000, "demoted to read-only");
    typeText("/take");
    sendInput("\r");
    await waitFor(
      () => sendAttempt >= 2 && text().includes("sends when harnessd reconnects") && text().includes("ONE-CARD-MSG"),
      3000,
      "pre-write failure kept item queued with reconnect reason",
    );
    assert.equal((text().match(/[›>] ONE-CARD-MSG/g) ?? []).length, 0, "Pre-write failure must not render a user card");

    // 3. Re-trigger drain via control_changed -> attempt #3 rejects "Director is already responding" -> queued with "after_turn"
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: null,
      type: "session.control_changed",
      createdAt: Date.now(),
      payload: { sessionId: session.id, controllerClientId: "c1", controlSeq: 4 },
    });
    await waitFor(
      () => sendAttempt >= 3 && text().includes("sends after this turn") && text().includes("ONE-CARD-MSG"),
      3000,
      "already responding rejection kept item queued",
    );
    assert.equal((text().match(/[›>] ONE-CARD-MSG/g) ?? []).length, 0, "Already-responding rejection must not render a user card");

    // 4. Wake turn ends -> drains attempt #4 -> rejects DAEMON_RELOADING -> queued with "restart"
    mock.emit({
      kind: "event",
      seq: 3,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "wake-sf6", reason: "goal.progress" },
    });
    mock.emit({
      kind: "event",
      seq: 4,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "wake-sf6", historyThrough: 1 },
    });
    await waitFor(
      () => sendAttempt >= 4 && text().includes("sends after harnessd restarts") && text().includes("ONE-CARD-MSG"),
      3000,
      "DAEMON_RELOADING rejection kept item queued with restart reason",
    );
    assert.equal((text().match(/[›>] ONE-CARD-MSG/g) ?? []).length, 0, "DAEMON_RELOADING rejection must not render a user card");

    // 5. Reconnect clears reloadingBlocked and drains attempt #5 -> accepted and answered -> renders ONE user card!
    mock.disconnect();
    await waitFor(() => text().includes("ACCEPTED-ONCE-SF6"), 5000, "fifth attempt accepted and settled after reconnect");

    sendInput("\x1d");
    await runPromise;

    const finalScreen = text();
    assert.equal(sendAttempt, 5, "Should have attempted 5 times total across all 4 rejection kinds + final accept");
    assert.equal(
      (finalScreen.match(/[›>] ONE-CARD-MSG/g) ?? []).length,
      1,
      "Drained message must render as a single user card after pre-accept rejections",
    );
  });

  it("should-fix 7: /queue lists every item with 1-based position and state, even when strip overflows", async () => {
    const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 17);
    const session = makeChatSession("chat-q34-sf7");
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
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-q34-sf7"), 3000, "initial render");

    // Start an active confirmed turn
    typeText("Base turn");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: "Streaming..." },
    });
    await waitFor(() => text().includes("Streaming..."), 3000, "confirmed");

    // Queue 5 items on a 17-row terminal -> strip overflows with "+3 more · /queue"
    for (const label of ["ITEM-ONE", "ITEM-TWO", "ITEM-THREE", "ITEM-FOUR", "ITEM-FIVE"]) {
      typeText(label);
      sendInput("\r");
      await new Promise((r) => setTimeout(r, 15));
    }
    await waitFor(() => text().includes("+3 more · /queue"), 3000, "overflow points to /queue");

    // Run /queue -> prints all 5 items with 1-based position and state
    typeText("/queue");
    sendInput("\r");
    await waitFor(
      () =>
        text().includes("Queue (5):") &&
        text().includes("1. [queued · sends after this turn] ITEM-ONE") &&
        text().includes("5. [queued · sends after this turn] ITEM-FIVE"),
      3000,
      "/queue listed all 5 items",
    );

    resolveSend();
    sendInput("\x1d");
    await runPromise;
  });

  it("should-fix 8: multiple unconfirmed sends stay distinct in the strip across reconnect and occupied composer, reconcile delivered vs undelivered, and support recall/drop", async () => {
    const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-q34-sf8");
    let openCount = 0;
    let firstTurnId = "";
    const persistedHistory: ChatTurnRecord[] = [];
    let resolveSend!: () => void;
    const sendGate = new Promise<void>((r) => (resolveSend = r));

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-sf8" };
      if (op === "chat.open") {
        openCount += 1;
        if (openCount === 1) {
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
        // Reconnect: turn finished, ONLY STEER-DELIVERED was persisted (STEER-LOST was NOT!)
        return {
          session,
          history: [],
          historyNext: null,
          historyThrough: 3,
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          tookOver: false,
          busy: false,
        };
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        return { history: persistedHistory.filter((r) => r.seq > afterSeq), historyNext: null };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "chat.send") {
        await sendGate;
        return { ok: true };
      }
      if (op === "chat.steer") {
        // Hang both concurrent steer RPCs until disconnect rejects them
        await new Promise(() => {});
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-q34-sf8"), 3000, "initial render");

    // Start confirmed turn 1
    typeText("Initial SF8");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "turn 1 send");
    firstTurnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: firstTurnId, delta: "Working SF8" },
    });
    await waitFor(() => text().includes("Working SF8"), 3000, "turn 1 confirmed");

    // Queue two follow-ups and trigger Alt+S twice so TWO steer RPCs are in flight concurrently
    typeText("STEER-DELIVERED");
    sendInput("\r");
    await waitFor(() => text().includes("STEER-DELIVERED"), 3000, "queued steer 1");
    typeText("STEER-LOST");
    sendInput("\r");
    await waitFor(() => text().includes("STEER-LOST"), 3000, "queued steer 2");

    sendInput("\x1bs");
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.steer").length === 1, 3000, "steer 1 sent");
    sendInput("\x1bs");
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.steer").length === 2, 3000, "steer 2 sent");

    // Put a new draft in the composer BEFORE disconnecting so the composer is occupied on reconnect!
    typeText("NEW-DRAFT-IN-COMPOSER");
    await waitFor(() => text().includes("NEW-DRAFT-IN-COMPOSER"), 3000, "composer occupied");

    // Daemon persisted Initial SF8 + STEER-DELIVERED + final answer, but NOT STEER-LOST
    persistedHistory.push(
      { seq: 1, chatSessionId: session.id, role: "user", content: "Initial SF8", createdAt: Date.now() },
      { seq: 2, chatSessionId: session.id, role: "user", content: "STEER-DELIVERED", createdAt: Date.now() },
      { seq: 3, chatSessionId: session.id, role: "assistant", content: "SF8-FINAL-ANSWER", createdAt: Date.now() },
    );

    mock.disconnect();
    await waitFor(() => text().includes("Reconnected to harnessd") && text().includes("SF8-FINAL-ANSWER"), 5000, "reconnected");

    // STEER-DELIVERED was reconciled (removed from strip, rendered once as user card),
    // while STEER-LOST stayed in the strip as `may not have been delivered` (NOT auto-resent, composer draft intact)!
    const midScreen = text();
    assert.ok(midScreen.includes("may not have been delivered"), "Undelivered steer must stay in strip as unconfirmed");
    assert.ok(midScreen.includes("STEER-LOST"), "Undelivered steer text must not be lost");
    assert.ok(midScreen.includes("NEW-DRAFT-IN-COMPOSER"), "Existing composer draft must stay intact");
    assert.equal(mock.calls.filter((c) => c.op === "chat.send").length, 1, "Unconfirmed item must NEVER auto-resend");
    assert.equal((midScreen.match(/[›>] STEER-DELIVERED/g) ?? []).length, 1, "Delivered steer rendered once from history");

    // Drop the unconfirmed item with Alt+Q -> strip clears (no "1 may not have been delivered" row remains)!
    sendInput("\x1bq");
    await waitFor(() => !text().includes("1 may not have been delivered"), 3000, "Alt+Q dropped unconfirmed item");

    resolveSend();
    sendInput("\x1d");
    await runPromise;
  });
});
