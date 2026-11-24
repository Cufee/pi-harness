import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../src/director/session.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui, runNativeScrollbackTui } from "../src/tui/app.js";
import { createTheme, ImmutableTranscript, stripTerminalSequences } from "../src/tui/core/index.js";

/**
 * Minimal VT terminal screen + scrollback simulator matching TuiMainScreen's output
 * (CSI A/B/G, CSI 2K/0K/K, CSI 2J/3J/H, CR/LF, SGR/OSC/DEC private modes).
 * Returns the exact final visible + scrollback lines so assertions check the real rendered
 * transcript rather than raw concatenated write bytes.
 */
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
    if (col > cur.length) {
      lines[row] = cur + " ".repeat(col - cur.length) + ch;
    } else if (col === cur.length) {
      lines[row] = cur + ch;
    } else {
      lines[row] = cur.slice(0, col) + ch + cur.slice(col + 1);
    }
    col += 1;
  };

  const feed = (data: string) => {
    let i = 0;
    while (i < data.length) {
      const ch = data[i]!;
      if (ch === "\x1b") {
        const next = data[i + 1];
        if (next === "[") {
          // CSI sequence: ESC [ <params/intermediates> <final byte 0x40..0x7E>
          let j = i + 2;
          while (j < data.length && (data.charCodeAt(j) < 0x40 || data.charCodeAt(j) > 0x7e)) j += 1;
          const params = data.slice(i + 2, j);
          const cmd = data[j] ?? "";
          i = j + 1;
          if (params.startsWith("?")) continue; // DEC private modes (e.g. ?2026h/?2026l/?25l)
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
          // OSC sequence: terminated by BEL (\x07) or ST (\x1b\\)
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
          // APC (Kitty graphics): terminated by ST (\x1b\\)
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
    lines: () => lines.map((l) => l.trimEnd()),
    text: () => lines.map((l) => l.trimEnd()).join("\n"),
  };
}

function makeFakeTerminal(cols = 110, rows = 30) {
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
    /** Final rendered terminal state (scrollback + viewport), NOT concatenated raw writes. */
    text: () => screen.text(),
    rawWrites: () => stripTerminalSequences(writes.join("")),
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
      // Production DaemonClient.handleDisconnect rejects all pending RPCs before firing close listeners.
      for (const rej of [...pendingRejectors]) rej(new Error("Disconnected from harnessd"));
      pendingRejectors.clear();
      for (const fn of closeListeners) fn();
    },
    reconnectReady() {
      connected = true;
      connectionEpoch += 1;
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

function makeChatSession(id = "chat-34"): ChatSessionRecord {
  const now = Date.now();
  return {
    id,
    projectId: null,
    repoRoot: "/repo",
    title: "Goal 34 Transcript Test",
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

describe("goal-34 c3: Director chat assistant replies render exactly once", () => {
  it("renders assistant reply exactly once when a goal.* event arrives mid-turn before chat.turn.end", async () => {
    const { terminal, writes, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-goal");
    const reply = "Option (a) is what the orchestrator recommended too. Triggering the review against origin/main.";

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
    await waitFor(() => text().includes("chat-34-goal"), 3000, "initial render");

    typeText("Go with option a");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send called");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    // Stream assistant text via chat.delta
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: reply },
    });
    await waitFor(() => text().includes(reply), 3000, "streamed reply visible");

    // Emit a mid-turn goal.* event (human-visible review + internal progress)
    mock.emit({
      kind: "event",
      seq: 2,
      runId: "run-30",
      taskId: null,
      type: "goal.reviewed",
      createdAt: Date.now(),
      payload: {
        goalId: "goal-30",
        version: 1,
        cycle: 1,
        verdict: "approve",
        status: "achieved",
        summary: "Verified on local main",
      },
    });
    mock.emit({
      kind: "event",
      seq: 3,
      runId: "run-32",
      taskId: null,
      type: "goal.progress",
      createdAt: Date.now(),
      payload: { goalId: "goal-32", phase: "implementing", summary: "Working on slice 1" },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Settle the turn with assistantTurn.content carrying the full reply
    const writesBeforeEnd = writes.length;
    mock.emit({
      kind: "event",
      seq: 4,
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
          content: reply,
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSend();
    await waitFor(
      () => stripTerminalSequences(writes.slice(writesBeforeEnd).join("")).includes("Ready"),
      3000,
      "turn settled and rendered Ready",
    );
    await waitFor(() => text().includes("goal-30"), 3000, "goal-30 receipt rendered");

    sendInput("\x1d");
    const exit = await runPromise;
    assert.equal(exit.kind, "exit");

    assert.equal(
      countOccurrences(text(), reply),
      1,
      `Expected assistant reply to appear exactly once, got ${countOccurrences(text(), reply)}`,
    );
  });

  it("renders assistant reply exactly once when a mid-turn goal event is followed by cancelled chat.turn.end", async () => {
    const { terminal, writes, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-cancel");
    const reply = "Checking the latest review status before triggering the next cycle.";

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
    await waitFor(() => text().includes("chat-34-cancel"), 3000, "initial render");

    typeText("Check review");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send called");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: reply },
    });
    await waitFor(() => text().includes(reply), 3000, "streamed reply visible");

    mock.emit({
      kind: "event",
      seq: 2,
      runId: "run-29",
      taskId: null,
      type: "goal.committed",
      createdAt: Date.now(),
      payload: { goalId: "goal-29", version: 1, title: "Ship release" },
    });
    await new Promise((r) => setTimeout(r, 30));

    const writesBeforeEnd = writes.length;
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
        cancelled: true,
        historyThrough: 2,
        assistantTurn: {
          seq: 2,
          chatSessionId: session.id,
          role: "assistant",
          content: reply,
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSend();
    await waitFor(
      () => stripTerminalSequences(writes.slice(writesBeforeEnd).join("")).includes("Ready"),
      3000,
      "cancelled turn settled and rendered Ready",
    );
    await waitFor(() => text().includes("goal-29"), 3000, "goal-29 receipt rendered");

    sendInput("\x1d");
    await runPromise;

    assert.equal(
      countOccurrences(text(), reply),
      1,
      `Expected cancelled reply to appear exactly once, got ${countOccurrences(text(), reply)}`,
    );
  });

  it("renders assistant reply exactly once when escalation.created and peer message arrive mid-turn", async () => {
    const { terminal, writes, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-esc-peer");
    const reply = "Investigating the failing test suite and coordinating the fix.";

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
    await waitFor(() => text().includes("chat-34-esc-peer"), 3000, "initial render");

    typeText("Look at the suite");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send called");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: reply },
    });
    await waitFor(() => text().includes(reply), 3000, "streamed reply visible");

    mock.emit({
      kind: "event",
      seq: 2,
      runId: "run-50",
      taskId: "t-50",
      type: "escalation.created",
      createdAt: Date.now(),
      payload: {
        id: "esc-50",
        toTaskId: null,
        severity: "P0",
        blocking: true,
        title: "Need approval to rotate token",
      },
    });
    mock.emit({
      kind: "event",
      seq: 3,
      runId: session.id,
      taskId: null,
      type: "session.message_received",
      createdAt: Date.now(),
      payload: {
        messageId: "msg-1",
        fromHost: "local",
        fromSessionId: "chat-other",
        body: "Peer ping from sibling session",
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    const writesBeforeEnd = writes.length;
    mock.emit({
      kind: "event",
      seq: 4,
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
          content: reply,
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSend();
    await waitFor(
      () => stripTerminalSequences(writes.slice(writesBeforeEnd).join("")).includes("Ready"),
      3000,
      "turn with escalation+peer settled",
    );
    await waitFor(() => text().includes("esc-50") && text().includes("Peer ping"), 3000, "mid-turn receipts settled");

    sendInput("\x1d");
    await runPromise;

    assert.equal(
      countOccurrences(text(), reply),
      1,
      `Expected reply with mid-turn escalation+peer to appear once, got ${countOccurrences(text(), reply)}`,
    );
  });

  it("renders assistant reply exactly once on history reload and reconnect resync mid-turn", async () => {
    const reply = "UNIQUE-RELOAD-REPLY-435: verified across reload and reconnect.";

    // 1. Reopening the chat with persisted history via chat.open + chat.history
    {
      const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-reload");
      const mock = makeMockClient(async (op) => {
        if (op === "chat.open") {
          return {
            session,
            history: [
              { seq: 1, chatSessionId: session.id, role: "user", content: "Status?", createdAt: Date.now() - 2000 } satisfies ChatTurnRecord,
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
          return {
            history: [
              { seq: 2, chatSessionId: session.id, role: "assistant", content: reply, createdAt: Date.now() - 1000 } satisfies ChatTurnRecord,
            ],
            historyNext: null,
          };
        }
        if (op === "work.snapshot") return emptyWorkSnapshot();
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
      await waitFor(() => text().includes(reply), 3000, "reloaded reply rendered");

      sendInput("\x1d");
      await runPromise;

      assert.equal(
        countOccurrences(text(), reply),
        1,
        `Expected reloaded reply to appear exactly once, got ${countOccurrences(text(), reply)}`,
      );
    }

    // 2. Reconnect mid-turn after a mid-turn tool card froze the first segment
    {
      const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-resync");
      const part1 = "FROZEN-PREFIX-BEFORE-DISCONNECT.";
      const part2 = "SUFFIX-AFTER-RECONNECT.";
      const fullReply = `${part1}\n\n${part2}`;
      let openCount = 0;
      let turnId = "";

      let resolveSend!: () => void;
      const sendGate = new Promise<void>((r) => (resolveSend = r));

      const mock = makeMockClient(async (op) => {
        if (op === "ping") {
          return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-test" };
        }
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
          // Reconnect while the same turn is still active: daemon persisted part1 + tool_output
          // before disconnect and now holds only the post-flush activePartial (part2).
          return {
            session,
            history: [],
            historyNext: null,
            historyThrough: 2,
            activeTurnId: turnId,
            activeText: fullReply,
            activePartial: part2,
            tookOver: false,
            busy: true,
          };
        }
        if (op === "chat.history") {
          return {
            history: [
              { seq: 1, chatSessionId: session.id, role: "assistant", content: part1, createdAt: Date.now() - 500 } satisfies ChatTurnRecord,
              {
                seq: 2,
                chatSessionId: session.id,
                role: "tool_output",
                content: "run-99",
                toolName: "present_result",
                display: { kind: "run_activity", data: { runId: "run-99", phase: "active", elapsedMs: 1000, tasks: [] } },
                createdAt: Date.now() - 400,
              } satisfies ChatTurnRecord,
            ],
            historyNext: null,
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
      await waitFor(() => text().includes("chat-34-resync"), 3000, "initial render");

      typeText("Start long turn");
      sendInput("\r");
      await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send called");
      turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

      // Stream part1, then freeze it via a mid-turn tool output card
      mock.emit({
        kind: "event",
        seq: 1,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId, delta: part1 },
      });
      await waitFor(() => text().includes(part1), 3000, "part1 visible");

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
          name: "present_result",
          status: "completed",
          display: { kind: "run_activity", data: { runId: "run-99", phase: "active", elapsedMs: 1000, tasks: [] } },
        },
      });
      await waitFor(() => text().includes("run-99"), 3000, "mid-turn tool card rendered");

      // Drop connection so installAutoReconnect runs resyncChat while turn is still busy
      mock.disconnect();
      await waitFor(() => text().includes("Reconnected to harnessd"), 5000, "reconnected mid-turn");

      // Now finish the turn carrying the last persisted segment (part2, matching production runtime.ts)
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
          historyThrough: 3,
          assistantTurn: {
            seq: 3,
            chatSessionId: session.id,
            role: "assistant",
            content: part2,
            createdAt: Date.now(),
          } satisfies ChatTurnRecord,
        },
      });
      resolveSend();
      await waitFor(() => text().includes(part2), 3000, "part2 settled");

      sendInput("\x1d");
      await runPromise;

      assert.equal(
        countOccurrences(text(), part1),
        1,
        `Expected frozen prefix to appear exactly once across reconnect, got ${countOccurrences(text(), part1)}`,
      );
      assert.equal(
        countOccurrences(text(), part2),
        1,
        `Expected suffix to appear exactly once across reconnect, got ${countOccurrences(text(), part2)}`,
      );
    }
  });

  it("occurrence 2 (dupe-reply-repro-2): renders reply once after reconnect with reopened.busy, activePartial seed, and mid-turn goal event", async () => {
    const { terminal, writes, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-repro2");
    const reply = "goal-26 stopped a third time because the worker exceeded its scope.";
    let openCount = 0;

    const mock = makeMockClient(async (op) => {
      if (op === "ping") {
        // Different releaseId so appendReconnectReceipts appends BOTH reconnect receipts while liveTail is seeded
        return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "d9c4aec62a78" };
      }
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
        return {
          session,
          history: [],
          historyNext: null,
          historyThrough: 0,
          activeTurnId: "turn-repro2",
          activeText: reply,
          activePartial: reply,
          tookOver: false,
          busy: true,
        };
      }
      if (op === "chat.history") return { history: [], historyNext: null };
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-34-repro2"), 3000, "initial render");

    // Reconnect while daemon is busy with a non-empty activePartial seed
    mock.disconnect();
    await waitFor(
      () => text().includes("Reconnected to harnessd (release d9c4aec62a78)") && text().includes(reply),
      5000,
      "reconnected with activePartial seed",
    );

    // Mid-turn goal.* events arrive (a progress event and a human-visible review)
    mock.emit({
      kind: "event",
      seq: 10,
      runId: "run-26",
      taskId: null,
      type: "goal.progress",
      createdAt: Date.now(),
      payload: { goalId: "goal-26", phase: "implementing", summary: "B1 merged to local main" },
    });
    mock.emit({
      kind: "event",
      seq: 11,
      runId: "run-26",
      taskId: null,
      type: "goal.reviewed",
      createdAt: Date.now(),
      payload: {
        goalId: "goal-26",
        version: 1,
        cycle: 1,
        verdict: "approve",
        status: "achieved",
        summary: "B1 merged cleanly",
      },
    });
    await new Promise((r) => setTimeout(r, 30));

    // Normal (non-cancelled) chat.turn.end carrying full reply
    const writesBeforeEnd = writes.length;
    mock.emit({
      kind: "event",
      seq: 12,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: "turn-repro2",
        historyThrough: 2,
        assistantTurn: {
          seq: 2,
          chatSessionId: session.id,
          role: "assistant",
          content: reply,
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    await waitFor(
      () => stripTerminalSequences(writes.slice(writesBeforeEnd).join("")).includes("Ready"),
      3000,
      "repro2 turn settled",
    );
    await waitFor(() => text().includes("goal-26"), 3000, "goal-26 receipt rendered");

    sendInput("\x1d");
    await runPromise;

    assert.equal(
      countOccurrences(text(), reply),
      1,
      `Expected repro2 reply to appear exactly once, got ${countOccurrences(text(), reply)}`,
    );
  });

  it("renders reply once and prints no 'Turn cancelled.' when turn finishes offline before reconnect", async () => {
    const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-offline-end");
    const reply = "OFFLINE-FINISHED-REPLY-435: completed while TUI was disconnected.";
    let openCount = 0;

    let resolveSend!: () => void;
    const sendGate = new Promise<void>((r) => (resolveSend = r));

    const mock = makeMockClient(async (op) => {
      if (op === "ping") {
        return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-offline" };
      }
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
        // Turn already finished while offline: busy=false and historyThrough=2
        return {
          session,
          history: [],
          historyNext: null,
          historyThrough: 2,
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          tookOver: false,
          busy: false,
        };
      }
      if (op === "chat.history") {
        return {
          history: [
            {
              seq: 2,
              chatSessionId: session.id,
              role: "assistant",
              content: reply,
              createdAt: Date.now(),
            } satisfies ChatTurnRecord,
          ],
          historyNext: null,
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
    await waitFor(() => text().includes("chat-34-offline-end"), 3000, "initial render");

    typeText("Finish while offline");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send called");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    // Stream reply into liveTail before connection drops
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: reply },
    });
    await waitFor(() => text().includes(reply), 3000, "live reply visible before disconnect");

    // Disconnect; reconnect finds busy=false with assistant row seq=2 in history
    mock.disconnect();
    await waitFor(() => text().includes("Reconnected to harnessd"), 5000, "reconnected after offline turn end");

    // Also emit a stale late chat.turn.end with a FRESH turnId (not in settledTurns) carrying seq=2
    // so the seq guard itself is isolated from turnId deduplication.
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: "late-turn-seq-guard",
        historyThrough: 2,
        assistantTurn: {
          seq: 2,
          chatSessionId: session.id,
          role: "assistant",
          content: reply,
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSend();
    await new Promise((r) => setTimeout(r, 40));

    sendInput("\x1d");
    await runPromise;

    const out = text();
    assert.equal(
      countOccurrences(out, reply),
      1,
      `Expected offline-finished reply to appear exactly once, got ${countOccurrences(out, reply)}`,
    );
    assert.equal(out.includes("Turn cancelled."), false, "Must not print 'Turn cancelled.' on offline finish resync");
  });

  it("blocker 1: disconnect during own chat.send preserves active turn, renders final reply once, and drains queued message", async () => {
    const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-b1");
    const partial = "PARTIAL-BEFORE-DROP-B1";
    const finalReply = "FINAL-REPLY-AFTER-RECONNECT-B1";
    let openCount = 0;
    let firstTurnId = "";
    let sendCount = 0;

    let resolveFirstSend!: () => void;
    const firstSendGate = new Promise<void>((r) => (resolveFirstSend = r));
    let resolveSecondSend!: () => void;
    const secondSendGate = new Promise<void>((r) => (resolveSecondSend = r));

    const mock = makeMockClient(async (op) => {
      if (op === "ping") {
        return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-b1" };
      }
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
        // Reopen while first turn is STILL running on daemon
        return {
          session,
          history: [],
          historyNext: null,
          historyThrough: 1,
          activeTurnId: firstTurnId,
          activeText: partial,
          activePartial: partial,
          tookOver: false,
          busy: true,
        };
      }
      if (op === "chat.history") {
        return {
          history: [
            { seq: 1, chatSessionId: session.id, role: "user", content: "first", createdAt: Date.now() - 1000 } satisfies ChatTurnRecord,
          ],
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "chat.send") {
        sendCount += 1;
        if (sendCount === 1) await firstSendGate;
        else await secondSendGate;
        return { ok: true };
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-34-b1"), 3000, "initial render");

    // 1. Send "first" and stream partial text
    typeText("first");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "first chat.send");
    firstTurnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);

    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: firstTurnId, delta: partial },
    });
    await waitFor(() => text().includes(partial), 3000, "partial visible");

    // 2. Queue "second" while "first" is still running
    typeText("second");
    sendInput("\r");
    await waitFor(() => text().includes("second") && text().includes("sends after this turn"), 3000, "second queued");

    // 3. Disconnect (rejects pending chat.send just like DaemonClient.handleDisconnect) and reopen busy
    mock.disconnect();
    await waitFor(() => text().includes("Reconnected to harnessd"), 5000, "reconnected while turn busy");

    // 4. Emit the real chat.turn.end for firstTurnId carrying the final answer
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: firstTurnId,
        historyThrough: 2,
        assistantTurn: {
          seq: 2,
          chatSessionId: session.id,
          role: "assistant",
          content: finalReply,
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });

    // Final reply must appear once, and "second" must drain as the next chat.send!
    await waitFor(() => text().includes(finalReply), 3000, "final reply rendered");
    await waitFor(
      () => mock.calls.filter((c) => c.op === "chat.send").length === 2,
      3000,
      "queued 'second' drained after real turn end",
    );
    const secondCall = mock.calls.filter((c) => c.op === "chat.send")[1]!;
    assert.equal(secondCall.params.text, "second");

    // Finish second turn cleanly
    const secondTurnId = String(secondCall.params.turnId);
    mock.emit({
      kind: "event",
      seq: 3,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: secondTurnId,
        historyThrough: 4,
        assistantTurn: {
          seq: 4,
          chatSessionId: session.id,
          role: "assistant",
          content: "SECOND-DONE-B1",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveFirstSend();
    resolveSecondSend();
    await waitFor(() => text().includes("SECOND-DONE-B1"), 3000, "second turn settled");

    sendInput("\x1d");
    await runPromise;

    const finalScreen = text();
    assert.equal(countOccurrences(finalScreen, finalReply), 1, "Final reply must appear exactly once");
    assert.equal(countOccurrences(finalScreen, partial), 0, "Partial text must be replaced by final reply, not stranded");
    assert.equal((finalScreen.match(/[›>] first/g) ?? []).length, 1, "'first' user card must render once");
    assert.equal((finalScreen.match(/[›>] second/g) ?? []).length, 1, "'second' user card must render once");
  });

  it("blocker 2: renders full final segment after mid-turn tool card even with shared prefix or no deltas, and preserves reseed segment", async () => {
    // Unit probe on ImmutableTranscript.settleLiveTurn and LiveTurnTail.reseed
    {
      const theme = createTheme({ color: false, ascii: false });
      const tr = new ImmutableTranscript(theme);
      tr.beginLiveTurn("director · test");
      tr.liveTail.appendText("Yes.");
      tr.appendToolOutput({ kind: "run_activity", data: { runId: "run-u1", phase: "active", elapsedMs: 100, tasks: [] } });
      tr.resyncLiveTurn({ modelLabel: "director · test", seedText: "Yes. Next.", preserveFrozen: true });
      const reseeded = tr.liveTail.snapshot();
      assert.equal(reseeded.text, "Yes. Next.", "Reconnect seed must not strip frozen prefix from distinct post-flush segment");
    }

    // End-to-end probe A (shared prefix: frozen "Yes." -> second segment "Yes. Next.")
    // and probe B (final-only segment with no deltas: frozen "Intro-B2" -> "Conclusion only")
    const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-b2");
    let sendCount = 0;
    let resolveTurn1!: () => void;
    const turn1Gate = new Promise<void>((r) => (resolveTurn1 = r));
    let resolveTurn2!: () => void;
    const turn2Gate = new Promise<void>((r) => (resolveTurn2 = r));

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
        if (sendCount === 1) await turn1Gate;
        else await turn2Gate;
        return { ok: true };
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-34-b2"), 3000, "initial render");

    // Turn 1: "Yes." -> tool card -> "Yes. Next."
    typeText("probe A");
    sendInput("\r");
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.send").length === 1, 3000, "turn 1 send");
    const t1 = String(mock.calls.filter((c) => c.op === "chat.send")[0]!.params.turnId);

    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: t1, delta: "Yes." },
    });
    await waitFor(() => text().includes("Yes."), 3000, "Yes. visible");

    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: t1,
        name: "present_result",
        status: "completed",
        display: { kind: "run_activity", data: { runId: "run-b2a", phase: "active", elapsedMs: 500, tasks: [] } },
      },
    });
    await waitFor(() => text().includes("run-b2a"), 3000, "tool card b2a");

    mock.emit({
      kind: "event",
      seq: 3,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: t1, delta: "Yes. Next." },
    });
    mock.emit({
      kind: "event",
      seq: 4,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: t1,
        historyThrough: 4,
        assistantTurn: {
          seq: 4,
          chatSessionId: session.id,
          role: "assistant",
          content: "Yes. Next.",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveTurn1();
    await waitFor(() => text().includes("Yes. Next."), 3000, "full second segment rendered");

    // Turn 2: "Intro-B2" -> tool card -> NO deltas -> final-only "Conclusion only"
    typeText("probe B");
    sendInput("\r");
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.send").length === 2, 3000, "turn 2 send");
    const t2 = String(mock.calls.filter((c) => c.op === "chat.send")[1]!.params.turnId);

    mock.emit({
      kind: "event",
      seq: 5,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: t2, delta: "Intro-B2" },
    });
    await waitFor(() => text().includes("Intro-B2"), 3000, "Intro-B2 visible");

    mock.emit({
      kind: "event",
      seq: 6,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: t2,
        name: "present_result",
        status: "completed",
        display: { kind: "run_activity", data: { runId: "run-b2b", phase: "active", elapsedMs: 500, tasks: [] } },
      },
    });
    await waitFor(() => text().includes("run-b2b"), 3000, "tool card b2b");

    mock.emit({
      kind: "event",
      seq: 7,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: t2,
        historyThrough: 8,
        assistantTurn: {
          seq: 8,
          chatSessionId: session.id,
          role: "assistant",
          content: "Conclusion only",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveTurn2();
    await waitFor(() => text().includes("Conclusion only"), 3000, "final-only Conclusion only rendered");

    sendInput("\x1d");
    await runPromise;

    const finalScreen = text();
    assert.equal(countOccurrences(finalScreen, "Yes. Next."), 1, "Second segment 'Yes. Next.' must not be truncated");
    assert.equal(countOccurrences(finalScreen, "Intro-B2"), 1, "Frozen 'Intro-B2' must render once");
    assert.equal(countOccurrences(finalScreen, "Conclusion only"), 1, "Final-only 'Conclusion only' must not be dropped");
  });

  it("blocker 3: reconnect across offline tool card renders INTRO once, handles second reconnect cleanly, and preserves unpersisted tail on non-busy reopen", async () => {
    const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-b3");
    let openCount = 0;

    const allHistory: ChatTurnRecord[] = [];
    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") {
        return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-b3" };
      }
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
        if (openCount === 2) {
          // Reconnect #1: daemon persisted INTRO + tool_output while offline, now streaming MIDDLE-3
          return {
            session,
            history: [],
            historyNext: null,
            historyThrough: 2,
            activeTurnId: "wake-b3",
            activeText: "INTRO-B3MIDDLE-B3",
            activePartial: "MIDDLE-B3",
            tookOver: false,
            busy: true,
          };
        }
        // Reconnect #2: daemon persisted MIDDLE-3 + tool_output #2 + FINAL-3 and finished
        return {
          session,
          history: [],
          historyNext: null,
          historyThrough: 5,
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          tookOver: false,
          busy: false,
        };
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: allHistory.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-34-b3"), 3000, "initial render");

    // Wake turn starts and streams INTRO-B3 before disconnect
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "wake-b3", reason: "goal.progress" },
    });
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "wake-b3", delta: "INTRO-B3" },
    });
    await waitFor(() => text().includes("INTRO-B3"), 3000, "INTRO-B3 streaming");

    // While offline, daemon flushes INTRO-B3 and persists tool_output card run-b3a
    allHistory.push(
      { seq: 1, chatSessionId: session.id, role: "assistant", content: "INTRO-B3", createdAt: Date.now() },
      {
        seq: 2,
        chatSessionId: session.id,
        role: "tool_output",
        content: "run-b3a",
        toolName: "present_result",
        display: { kind: "run_activity", data: { runId: "run-b3a", phase: "active", elapsedMs: 400, tasks: [] } },
        createdAt: Date.now(),
      },
    );

    mock.disconnect();
    await waitFor(() => text().includes("run-b3a") && text().includes("MIDDLE-B3"), 5000, "reconnect #1 replayed tool card and seeded MIDDLE-B3");

    // Second disconnect: daemon flushes MIDDLE-B3, persists tool card run-b3b, and finishes with FINAL-B3
    allHistory.push(
      { seq: 3, chatSessionId: session.id, role: "assistant", content: "MIDDLE-B3", createdAt: Date.now() },
      {
        seq: 4,
        chatSessionId: session.id,
        role: "tool_output",
        content: "run-b3b",
        toolName: "present_result",
        display: { kind: "run_activity", data: { runId: "run-b3b", phase: "active", elapsedMs: 600, tasks: [] } },
        createdAt: Date.now(),
      },
      { seq: 5, chatSessionId: session.id, role: "assistant", content: "FINAL-B3", createdAt: Date.now() },
    );

    mock.disconnect();
    await waitFor(() => text().includes("run-b3b") && text().includes("FINAL-B3"), 5000, "reconnect #2 replayed remaining rows");

    sendInput("\x1d");
    await runPromise;

    const finalScreen = text();
    assert.equal(countOccurrences(finalScreen, "INTRO-B3"), 1, "INTRO-B3 must render exactly once (no stale-tail freeze on replay)");
    assert.equal(countOccurrences(finalScreen, "run-b3a"), 1, "run-b3a tool card must render once");
    assert.equal(countOccurrences(finalScreen, "MIDDLE-B3"), 1, "MIDDLE-B3 must render once");
    assert.equal(countOccurrences(finalScreen, "run-b3b"), 1, "run-b3b tool card must render once");
    assert.equal(countOccurrences(finalScreen, "FINAL-B3"), 1, "FINAL-B3 must render once");

    // Part 2: non-busy reconnect must NOT discard unpersisted post-tool live text just because an earlier assistant row was fetched
    {
      const term2 = makeFakeTerminal(120, 30);
      const session2 = makeChatSession("chat-34-b3-nonbusy");
      let openCount2 = 0;
      const mock2 = makeMockClient(async (op) => {
        if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-b3b" };
        if (op === "chat.open") {
          openCount2 += 1;
          if (openCount2 === 1) {
            return {
              session: session2,
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
          return {
            session: session2,
            history: [],
            historyNext: null,
            historyThrough: 2,
            activeTurnId: null,
            activeText: "",
            activePartial: "",
            tookOver: false,
            busy: false,
          };
        }
        if (op === "chat.history") {
          return {
            history: [
              { seq: 1, chatSessionId: session2.id, role: "assistant", content: "PRE-TOOL-SEG", createdAt: Date.now() },
              {
                seq: 2,
                chatSessionId: session2.id,
                role: "tool_output",
                content: "run-b3c",
                toolName: "present_result",
                display: { kind: "run_activity", data: { runId: "run-b3c", phase: "active", elapsedMs: 200, tasks: [] } },
                createdAt: Date.now(),
              },
            ],
            historyNext: null,
          };
        }
        if (op === "work.snapshot") return emptyWorkSnapshot();
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const run2 = runDirectorChatTui({ client: mock2.client, repoRoot: "/repo", terminal: term2.terminal });
      await waitFor(() => term2.text().includes("chat-34-b3-nonbusy"), 3000, "initial render part 2");

      mock2.emit({
        kind: "event",
        seq: 1,
        runId: session2.id,
        taskId: session2.id,
        type: "chat.turn.start",
        createdAt: Date.now(),
        payload: { chatSessionId: session2.id, turnId: "wake-b3-nb", reason: "goal.progress" },
      });
      mock2.emit({
        kind: "event",
        seq: 2,
        runId: session2.id,
        taskId: session2.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session2.id, turnId: "wake-b3-nb", delta: "PRE-TOOL-SEG" },
      });
      mock2.emit({
        kind: "event",
        seq: 3,
        runId: session2.id,
        taskId: session2.id,
        type: "chat.tool",
        createdAt: Date.now(),
        payload: {
          chatSessionId: session2.id,
          turnId: "wake-b3-nb",
          name: "present_result",
          status: "completed",
          display: { kind: "run_activity", data: { runId: "run-b3c", phase: "active", elapsedMs: 200, tasks: [] } },
        },
      });
      mock2.emit({
        kind: "event",
        seq: 4,
        runId: session2.id,
        taskId: session2.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session2.id, turnId: "wake-b3-nb", delta: "UNPERSISTED-POST-TOOL-TAIL" },
      });
      await waitFor(() => term2.text().includes("UNPERSISTED-POST-TOOL-TAIL"), 3000, "post-tool tail streaming");

      mock2.disconnect();
      await waitFor(() => term2.text().includes("Reconnected to harnessd"), 5000, "reconnected non-busy");

      term2.sendInput("\x1d");
      await run2;

      const screen2 = term2.text();
      assert.equal(countOccurrences(screen2, "PRE-TOOL-SEG"), 1, "Already-frozen pre-tool segment must render once");
      assert.equal(countOccurrences(screen2, "UNPERSISTED-POST-TOOL-TAIL"), 1, "Unpersisted post-tool tail must not be discarded");
    }
  });

  it("blocker 4: human-needed escalation and manual quota pause appear mid-turn while streaming, and run TUI shows draining notice mid-turn", async () => {
    // Part A: chat TUI shows escalation + manual quota pause BEFORE chat.turn.end
    {
      const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-b4");
      const reply = "STREAMING-REPLY-B4: waiting on background tool.";
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
      await waitFor(() => text().includes("chat-34-b4"), 3000, "initial render");

      typeText("Check deploy");
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
        payload: { chatSessionId: session.id, turnId, delta: reply },
      });
      await waitFor(() => text().includes(reply), 3000, "streaming reply visible");

      // Emit P0 blocking escalation and manual quota pause WHILE turn is still active
      mock.emit({
        kind: "event",
        seq: 2,
        runId: "run-b4",
        taskId: "t-b4",
        type: "escalation.created",
        createdAt: Date.now(),
        payload: {
          id: "esc-b4",
          toTaskId: null,
          severity: "P0",
          blocking: true,
          title: "Approve production deploy now",
        },
      });
      mock.emit({
        kind: "event",
        seq: 3,
        runId: "run-b4",
        taskId: null,
        type: "quota.run_paused",
        createdAt: Date.now(),
        payload: {
          mode: "manual",
          reason: "Manual quota intervention needed",
        },
      });

      // Both alerts MUST appear immediately BEFORE chat.turn.end!
      await waitFor(
        () => text().includes("Approve production deploy now") && text().includes("Manual quota intervention needed"),
        1500,
        "escalation and manual quota pause visible mid-turn before settle",
      );

      // Now finish the turn; reply must still render exactly once!
      mock.emit({
        kind: "event",
        seq: 4,
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
            content: reply,
            createdAt: Date.now(),
          } satisfies ChatTurnRecord,
        },
      });
      resolveSend();
      await waitFor(() => text().includes("Ready"), 3000, "turn settled");

      sendInput("\x1d");
      await runPromise;

      const finalScreen = text();
      assert.equal(countOccurrences(finalScreen, reply), 1, "Reply must still render once after mid-turn alerts");
      assert.ok(finalScreen.includes("Approve production deploy now"), "Escalation must remain in final transcript");
      assert.ok(finalScreen.includes("Manual quota intervention needed"), "Manual quota pause must remain in final transcript");
    }

    // Part B: run TUI shows daemon.reload draining notice immediately while agent streams mid-turn
    {
      const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
      const mock = makeMockClient(async (op) => {
        if (op === "attach") {
          return {
            attachmentId: "att-b4",
            run: { id: "run-b4-tui", status: "active", repoRoot: "/repo", goal: "Run test" },
            tasks: [],
            replay: [],
            replayNextSeq: null,
            control: { sessionId: "run-b4-tui", clientId: "c1", controllerClientId: "c1", hasControl: true, controlSeq: 1 },
          };
        }
        if (op === "work.snapshot") return emptyWorkSnapshot();
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const runPromise = runNativeScrollbackTui({ client: mock.client, runId: "run-b4-tui", terminal });
      await waitFor(() => text().includes("run-b4-tui"), 3000, "run TUI initial render");

      // Stream worker text mid-turn (no turn_end yet)
      mock.emit({
        kind: "event",
        seq: 1,
        runId: "run-b4-tui",
        taskId: "t-worker",
        type: "agent.text_delta",
        createdAt: Date.now(),
        payload: { delta: "WORKER-STREAMING-B4" },
      });
      await waitFor(() => text().includes("WORKER-STREAMING-B4"), 3000, "worker streaming visible");

      // Emit daemon.reload draining while worker is mid-turn -> must appear immediately!
      mock.emit({
        kind: "event",
        seq: 2,
        runId: "run-b4-tui",
        taskId: null,
        type: "daemon.reload",
        createdAt: Date.now(),
        payload: { phase: "draining", toReleaseId: "rel-b4-next" },
      });
      await waitFor(
        () => text().includes("harnessd is restarting for an update (release rel-b4-next)"),
        1500,
        "run TUI draining notice visible mid-turn",
      );

      sendInput("\x1d");
      await runPromise;
    }
  });

  it("should-fix 9: Work Navigator 'i' toggle flushes buffered internal lines on return to chat, and unrelated cancel does not print steer_cancelled", async () => {
    const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-sf9");
    let resolveSend!: () => void;
    const sendGate = new Promise<void>((r) => (resolveSend = r));
    let resolveSteer!: (v: { steered: boolean }) => void;
    const steerGate = new Promise<{ steered: boolean }>((r) => (resolveSteer = r));

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
      if (op === "chat.steer") return await steerGate;
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-34-sf9"), 3000, "initial render");

    // Emit an internal goal.progress line while showInternal is false -> stays hidden in buffer
    mock.emit({
      kind: "event",
      seq: 1,
      runId: "run-sf9",
      taskId: null,
      type: "goal.progress",
      createdAt: Date.now(),
      payload: { goalId: "goal-99", phase: "implementing", summary: "BUFFERED-INTERNAL-SF9" },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(text().includes("BUFFERED-INTERNAL-SF9"), false, "Internal line hidden by default");

    // Open Work Navigator (`Ctrl+G`), press `i` to enable showInternal, then `Esc` to return to chat
    sendInput("\x07");
    await new Promise((r) => setTimeout(r, 40));
    sendInput("i");
    await new Promise((r) => setTimeout(r, 40));
    sendInput("\x1b");
    await waitFor(
      () => text().includes("BUFFERED-INTERNAL-SF9"),
      3000,
      "buffered internal line flushed when returning to chat after Work Navigator 'i' toggle",
    );

    // Toggle /internal back OFF before testing unrelated cancel racing an in-flight steer
    typeText("/internal");
    sendInput("\r");
    await waitFor(() => text().includes("Internal lines: hidden"), 3000, "internal toggled off");

    // Start a turn, queue a follow-up, start /now steer, then emit an unrelated cancelled chat.turn.end
    typeText("Start SF9");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.send"), 3000, "chat.send");
    const turnId = String(mock.calls.find((c) => c.op === "chat.send")!.params.turnId);
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: "Working..." },
    });
    await waitFor(() => text().includes("Working..."), 3000, "delta visible");

    typeText("Steer SF9");
    sendInput("\r");
    await waitFor(() => text().includes("Steer SF9"), 3000, "queued");
    typeText("/now");
    sendInput("\r");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.steer"), 3000, "steer in flight");

    // Unrelated cancel arrives while steer is in flight -> must NOT misreport steer_cancelled
    mock.emit({
      kind: "event",
      seq: 3,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, cancelled: true, historyThrough: 2 },
    });
    resolveSteer({ steered: false });
    resolveSend();
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.send").length === 2, 3000, "queued item drained");
    const turn2Id = String(mock.calls.filter((c) => c.op === "chat.send")[1]!.params.turnId);
    mock.emit({
      kind: "event",
      seq: 4,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: turn2Id, historyThrough: 4 },
    });
    await waitFor(() => text().includes("Ready"), 3000, "turn settled");

    sendInput("\x1d");
    await runPromise;

    const finalScreen = text();
    assert.equal(
      finalScreen.includes("Turn ended while delivering your message; sending it next."),
      false,
      "Removed steer_cancelled inference must never appear",
    );
  });
});
