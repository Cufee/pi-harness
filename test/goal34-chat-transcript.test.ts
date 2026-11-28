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
    viewportText: () => lines.slice(viewportTop, viewportTop + rows).map((l) => l.trimEnd()).join("\n"),
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
    lines: () => screen.lines(),
    /** Visible terminal viewport ONLY (last `rows` rows, excluding scrollback). */
    viewportText: () => screen.viewportText(),
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

  it("occurrence 2 (dupe-reply-repro-2): post-reconnect streamed deltas + mid-turn goal line renders reply once in order; post-settle goal line never repeats reply", async () => {
    // Case A: Exact sequence from dupe-reply-repro-2.md:
    // reconnect -> both daemon receipts -> reply streams as deltas AFTER reconnect -> unique goal line -> chat.turn.end.
    {
      const { terminal, writes, text, sendInput } = makeFakeTerminal(160, 30);
      const session = makeChatSession("chat-34-repro2");
      const replyPart1 = "goal-26 stopped a third time ";
      const replyPart2 = "because the worker exceeded its scope.";
      const reply = `${replyPart1}${replyPart2}`;
      const uniqueGoalReceipt = "B1 merged cleanly · review-receipt-unique-26";
      let openCount = 0;

      const mock = makeMockClient(async (op) => {
        if (op === "ping") {
          // Different releaseId so appendReconnectReceipts appends BOTH reconnect receipts before the reply streams
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
          // Reconnect into busy turn BEFORE deltas arrive so receipts render first, then deltas stream
          return {
            session,
            history: [],
            historyNext: null,
            historyThrough: 0,
            activeTurnId: "turn-repro2",
            activeText: "",
            activePartial: "",
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

      // 1. Reconnect -> both daemon receipts appear first
      mock.disconnect();
      await waitFor(
        () =>
          text().includes("Reconnected to harnessd (release d9c4aec62a78)") &&
          text().includes("harnessd runs release d9c4aec62a78"),
        5000,
        "both reconnect receipts rendered",
      );

      // 2. Reply streams as deltas AFTER the reconnect
      mock.emit({
        kind: "event",
        seq: 8,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "turn-repro2", delta: replyPart1 },
      });
      mock.emit({
        kind: "event",
        seq: 9,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "turn-repro2", delta: replyPart2 },
      });
      await waitFor(() => text().includes(reply), 3000, "streamed reply visible after reconnect");

      // 3. Internal goal.progress (hidden) + human-visible goal.reviewed with unique receipt text
      mock.emit({
        kind: "event",
        seq: 10,
        runId: "run-26",
        taskId: null,
        type: "goal.progress",
        createdAt: Date.now(),
        payload: { goalId: "goal-26", phase: "implementing", summary: "INTERNAL-REPRO2-PROGRESS" },
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
          summary: uniqueGoalReceipt,
        },
      });
      await waitFor(() => text().includes(uniqueGoalReceipt), 3000, "unique goal receipt rendered");

      // 4. Normal (non-cancelled) chat.turn.end carrying full reply
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

      sendInput("\x1d");
      await runPromise;

      const out = text();
      const dockSplit = out.indexOf("Ctrl+G work");
      const transcriptPart = dockSplit >= 0 ? out.slice(0, dockSplit) : out;
      assert.equal(
        countOccurrences(out, reply),
        1,
        `Expected repro2 reply to appear exactly once, got ${countOccurrences(out, reply)}`,
      );
      assert.equal(
        countOccurrences(transcriptPart, uniqueGoalReceipt),
        1,
        "Unique goal receipt must appear once in the transcript",
      );
      assert.equal(countOccurrences(out, "INTERNAL-REPRO2-PROGRESS"), 0, "Internal progress must stay hidden");
      const reconnectedIdx = transcriptPart.indexOf("Reconnected to harnessd (release d9c4aec62a78)");
      const mismatchIdx = transcriptPart.indexOf("harnessd runs release d9c4aec62a78");
      const goalIdx = transcriptPart.indexOf(uniqueGoalReceipt);
      const replyIdx = transcriptPart.indexOf(reply);
      assert.ok(reconnectedIdx >= 0 && reconnectedIdx < mismatchIdx, "Reconnected receipt must precede release-mismatch notice");
      assert.ok(mismatchIdx < goalIdx && goalIdx < replyIdx, "Reconnect receipts precede mid-turn goal receipt and settled reply");
    }

    // Case B: Goal line arriving AFTER the turn has already settled renders below the reply without repeating it
    {
      const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-repro2-post");
      const settledReply = "SETTLED-BEFORE-GOAL-REPLY-26: already complete.";
      const postSettleGoal = "POST-SETTLE-UNIQUE-GOAL-RECEIPT-26";
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
      await waitFor(() => text().includes("chat-34-repro2-post"), 3000, "initial render post-settle");

      typeText("Check goal-26");
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
        payload: { chatSessionId: session.id, turnId, delta: settledReply },
      });
      mock.emit({
        kind: "event",
        seq: 2,
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
            content: settledReply,
            createdAt: Date.now(),
          } satisfies ChatTurnRecord,
        },
      });
      resolveSend();
      await waitFor(() => text().includes(settledReply) && text().includes("Ready"), 3000, "turn settled before goal event");

      // Goal line arrives AFTER settlement
      mock.emit({
        kind: "event",
        seq: 3,
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
          summary: postSettleGoal,
        },
      });
      await waitFor(() => text().includes(postSettleGoal), 3000, "post-settle goal receipt rendered");

      sendInput("\x1d");
      await runPromise;

      const out = text();
      assert.equal(countOccurrences(out, settledReply), 1, "Post-settle goal line must not duplicate settled reply");
      assert.equal(countOccurrences(out, postSettleGoal), 1, "Post-settle goal receipt must render once");
      assert.ok(
        out.indexOf(settledReply) < out.indexOf(postSettleGoal),
        "Settled reply must appear before post-settle goal receipt",
      );
    }
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
      tr.resyncLiveTurn({ modelLabel: "director · test", seedText: "Yes. Next." });
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

    // Part 2: non-busy reconnect after a daemon crash/restart must NOT discard unpersisted post-tool live text
    {
      const term2 = makeFakeTerminal(120, 30);
      const session2 = makeChatSession("chat-34-b3-nonbusy");
      let openCount2 = 0;
      let daemonPid2 = process.pid;
      const mock2 = makeMockClient(async (op) => {
        if (op === "ping") return { pong: true, pid: daemonPid2, protocolRev: 8, releaseId: "rel-b3b" };
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

      daemonPid2 = process.pid + 1;
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

  it("should-fix 9: /internal toggle flushes buffered internal lines into chat, and unrelated cancel does not print steer_cancelled", async () => {
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

    // `/internal` shows internal lines and flushes the buffered one into the transcript
    typeText("/internal");
    sendInput("\r");
    await waitFor(
      () => text().includes("BUFFERED-INTERNAL-SF9"),
      3000,
      "buffered internal line flushed after /internal toggle",
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

  it("review-2 blocker 1: idle reconnect after offline tool flush renders INTRO once with no early-end line, including goal notice, post-tool tail, and second reconnect", async () => {
    // (a) Stream INTRO (no live tool card), disconnect; daemon persists assistant INTRO + tool_output and finishes with no further text.
    {
      const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-r2b1-a");
      let openCount = 0;
      const history: ChatTurnRecord[] = [];

      const mock = makeMockClient(async (op, params) => {
        if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r2b1" };
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
            historyThrough: history.length,
            activeTurnId: null,
            activeText: "",
            activePartial: "",
            tookOver: false,
            busy: false,
          };
        }
        if (op === "chat.history") {
          const afterSeq = Number(params.afterSeq ?? 0);
          return { history: history.filter((r) => r.seq > afterSeq), historyNext: null };
        }
        if (op === "work.snapshot") return emptyWorkSnapshot();
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
      await waitFor(() => text().includes("chat-34-r2b1-a"), 3000, "initial render (a)");

      mock.emit({
        kind: "event",
        seq: 1,
        runId: session.id,
        taskId: session.id,
        type: "chat.turn.start",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b1-a", reason: "goal.progress" },
      });
      mock.emit({
        kind: "event",
        seq: 2,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b1-a", delta: "INTRO-R2B1-A" },
      });
      await waitFor(() => text().includes("INTRO-R2B1-A"), 3000, "INTRO streaming (a)");

      history.push(
        { seq: 1, chatSessionId: session.id, role: "assistant", content: "INTRO-R2B1-A", createdAt: Date.now() },
        {
          seq: 2,
          chatSessionId: session.id,
          role: "tool_output",
          content: "run-r2b1-a",
          toolName: "present_result",
          display: { kind: "run_activity", data: { runId: "run-r2b1-a", phase: "active", elapsedMs: 300, tasks: [] } },
          createdAt: Date.now(),
        },
      );

      mock.disconnect();
      await waitFor(() => text().includes("Reconnected to harnessd") && text().includes("run-r2b1-a"), 5000, "reconnected (a)");

      sendInput("\x1d");
      await runPromise;

      const out = text();
      assert.equal(countOccurrences(out, "INTRO-R2B1-A"), 1, "(a) INTRO must render exactly once");
      assert.equal(countOccurrences(out, "run-r2b1-a"), 1, "(a) tool card must render once");
      assert.equal(out.includes("Turn ended while disconnected"), false, "(a) must not print early-end line");
      assert.equal(out.includes("Turn ended early"), false, "(a) must not print restart early-end line");
      assert.equal(out.includes("Turn cancelled"), false, "(a) must not print Turn cancelled");
    }

    // (b) + (d): Same scenario with a human-visible goal system_notice after the tool row, plus a second reconnect.
    {
      const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-r2b1-b");
      let openCount = 0;
      const history: ChatTurnRecord[] = [];

      const mock = makeMockClient(async (op, params) => {
        if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r2b1" };
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
            historyThrough: history.length,
            activeTurnId: null,
            activeText: "",
            activePartial: "",
            tookOver: false,
            busy: false,
          };
        }
        if (op === "chat.history") {
          const afterSeq = Number(params.afterSeq ?? 0);
          return { history: history.filter((r) => r.seq > afterSeq), historyNext: null };
        }
        if (op === "work.snapshot") return emptyWorkSnapshot();
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
      await waitFor(() => text().includes("chat-34-r2b1-b"), 3000, "initial render (b)");

      mock.emit({
        kind: "event",
        seq: 1,
        runId: session.id,
        taskId: session.id,
        type: "chat.turn.start",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b1-b", reason: "goal.progress" },
      });
      mock.emit({
        kind: "event",
        seq: 2,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b1-b", delta: "INTRO-R2B1-B" },
      });
      await waitFor(() => text().includes("INTRO-R2B1-B"), 3000, "INTRO streaming (b)");

      history.push(
        { seq: 1, chatSessionId: session.id, role: "assistant", content: "INTRO-R2B1-B", createdAt: Date.now() },
        {
          seq: 2,
          chatSessionId: session.id,
          role: "tool_output",
          content: "run-r2b1-b",
          toolName: "present_result",
          display: { kind: "run_activity", data: { runId: "run-r2b1-b", phase: "active", elapsedMs: 300, tasks: [] } },
          createdAt: Date.now(),
        },
        {
          seq: 3,
          chatSessionId: session.id,
          role: "system_notice",
          content: "GOAL-NOTICE-R2B1 achieved",
          event: {
            kind: "goal.reviewed",
            goalId: "goal-r2b1",
            goalVersion: 1,
            cycle: 1,
            verdict: "approve",
            status: "achieved",
            summary: "GOAL-NOTICE-R2B1 achieved",
          },
          createdAt: Date.now(),
        },
      );

      // First reconnect (idle)
      mock.disconnect();
      await waitFor(
        () => text().includes("run-r2b1-b") && text().includes("GOAL-NOTICE-R2B1 achieved"),
        5000,
        "reconnected #1 (b)",
      );
      const afterFirst = text();
      assert.equal(countOccurrences(afterFirst, "INTRO-R2B1-B"), 1, "(b) INTRO must not repeat below goal notice");
      assert.ok(
        afterFirst.indexOf("INTRO-R2B1-B") < afterFirst.indexOf("GOAL-NOTICE-R2B1 achieved"),
        "(b) INTRO must appear before the goal notice",
      );
      assert.equal(afterFirst.includes("Turn ended while disconnected"), false, "(b) no early-end line");

      // (d) Second reconnect changes nothing
      mock.disconnect();
      await waitFor(() => openCount >= 3, 5000, "reconnected #2 (d)");
      await new Promise((r) => setTimeout(r, 40));

      sendInput("\x1d");
      await runPromise;

      const afterSecond = text();
      assert.equal(countOccurrences(afterSecond, "INTRO-R2B1-B"), 1, "(d) second reconnect must keep INTRO at 1");
      assert.equal(countOccurrences(afterSecond, "run-r2b1-b"), 1, "(d) second reconnect must keep tool card at 1");
      assert.equal(countOccurrences(afterSecond, "GOAL-NOTICE-R2B1 achieved"), 1, "(d) goal notice stays at 1");
      assert.equal(afterSecond.includes("Turn ended while disconnected"), false, "(d) still no early-end line");
    }

    // (c) Real unpersisted post-tool tail after a LIVE tool card is preserved once after a daemon restart.
    {
      const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-r2b1-c");
      let openCount = 0;
      let daemonPid = process.pid;

      const mock = makeMockClient(async (op) => {
        if (op === "ping") return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r2b1" };
        if (op === "chat.open") {
          openCount += 1;
          return {
            session,
            history: [],
            historyNext: null,
            historyThrough: openCount === 1 ? 0 : 2,
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
              { seq: 1, chatSessionId: session.id, role: "assistant", content: "PRE-TOOL-R2B1-C", createdAt: Date.now() },
              {
                seq: 2,
                chatSessionId: session.id,
                role: "tool_output",
                content: "run-r2b1-c",
                toolName: "present_result",
                display: { kind: "run_activity", data: { runId: "run-r2b1-c", phase: "active", elapsedMs: 200, tasks: [] } },
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

      const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
      await waitFor(() => text().includes("chat-34-r2b1-c"), 3000, "initial render (c)");

      mock.emit({
        kind: "event",
        seq: 1,
        runId: session.id,
        taskId: session.id,
        type: "chat.turn.start",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b1-c", reason: "goal.progress" },
      });
      mock.emit({
        kind: "event",
        seq: 2,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b1-c", delta: "PRE-TOOL-R2B1-C" },
      });
      mock.emit({
        kind: "event",
        seq: 3,
        runId: session.id,
        taskId: session.id,
        type: "chat.tool",
        createdAt: Date.now(),
        payload: {
          chatSessionId: session.id,
          turnId: "wake-r2b1-c",
          name: "present_result",
          status: "completed",
          display: { kind: "run_activity", data: { runId: "run-r2b1-c", phase: "active", elapsedMs: 200, tasks: [] } },
        },
      });
      mock.emit({
        kind: "event",
        seq: 4,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b1-c", delta: "UNPERSISTED-TAIL-R2B1-C" },
      });
      await waitFor(() => text().includes("UNPERSISTED-TAIL-R2B1-C"), 3000, "post-tool tail streaming (c)");

      daemonPid = process.pid + 1;
      mock.disconnect();
      await waitFor(() => text().includes("Reconnected to harnessd"), 5000, "reconnected (c)");

      sendInput("\x1d");
      await runPromise;

      const out = text();
      assert.equal(countOccurrences(out, "PRE-TOOL-R2B1-C"), 1, "(c) pre-tool segment rendered once");
      assert.equal(countOccurrences(out, "UNPERSISTED-TAIL-R2B1-C"), 1, "(c) unpersisted post-tool tail preserved once");
    }
  });

  it("review-2 blocker 2: two equal assistant segments with distinct seqs both render on live settle and across busy reopen, without re-adding flushed cumulative activeText", async () => {
    // Part A: Live settle of "Yes." -> tool card -> "Yes." (distinct seqs)
    {
      const { terminal, text, sendInput, typeText } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-r2b2-live");
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
      await waitFor(() => text().includes("chat-34-r2b2-live"), 3000, "initial render live");

      typeText("confirm twice");
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
        payload: { chatSessionId: session.id, turnId, delta: "EQUAL-SEG-YES." },
      });
      await waitFor(() => text().includes("EQUAL-SEG-YES."), 3000, "first Yes. visible");

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
          display: { kind: "run_activity", data: { runId: "run-r2b2-live", phase: "active", elapsedMs: 250, tasks: [] } },
        },
      });
      await waitFor(() => text().includes("run-r2b2-live"), 3000, "tool card rendered");

      mock.emit({
        kind: "event",
        seq: 3,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId, delta: "EQUAL-SEG-YES." },
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
          turnId,
          historyThrough: 4,
          assistantTurn: {
            seq: 4,
            chatSessionId: session.id,
            role: "assistant",
            content: "EQUAL-SEG-YES.",
            createdAt: Date.now(),
          } satisfies ChatTurnRecord,
        },
      });
      resolveSend();
      await waitFor(() => text().includes("Ready"), 3000, "turn settled");

      sendInput("\x1d");
      await runPromise;

      const out = text();
      assert.equal(
        countOccurrences(out, "EQUAL-SEG-YES."),
        2,
        `Both equal segments with distinct seqs must render on live settle, got ${countOccurrences(out, "EQUAL-SEG-YES.")}`,
      );
      const firstIdx = out.indexOf("EQUAL-SEG-YES.");
      const toolIdx = out.indexOf("run-r2b2-live");
      const secondIdx = out.lastIndexOf("EQUAL-SEG-YES.");
      assert.ok(firstIdx < toolIdx && toolIdx < secondIdx, "Tool card must sit between the two equal segments");
    }

    // Part B: Busy reopen where post-flush activePartial equals the frozen pre-tool segment
    {
      const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-r2b2-reopen");
      let openCount = 0;

      const mock = makeMockClient(async (op, params) => {
        if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r2b2" };
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
            historyThrough: 2,
            activeTurnId: "wake-r2b2",
            activeText: "EQUAL-REOPEN-YES.EQUAL-REOPEN-YES.",
            activePartial: "EQUAL-REOPEN-YES.",
            tookOver: false,
            busy: true,
          };
        }
        if (op === "chat.history") {
          const afterSeq = Number(params.afterSeq ?? 0);
          const rows: ChatTurnRecord[] = [
            { seq: 1, chatSessionId: session.id, role: "assistant", content: "EQUAL-REOPEN-YES.", createdAt: Date.now() },
            {
              seq: 2,
              chatSessionId: session.id,
              role: "tool_output",
              content: "run-r2b2-reopen",
              toolName: "present_result",
              display: { kind: "run_activity", data: { runId: "run-r2b2-reopen", phase: "active", elapsedMs: 250, tasks: [] } },
              createdAt: Date.now(),
            },
          ];
          return { history: rows.filter((r) => r.seq > afterSeq), historyNext: null };
        }
        if (op === "work.snapshot") return emptyWorkSnapshot();
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
      await waitFor(() => text().includes("chat-34-r2b2-reopen"), 3000, "initial render reopen");

      mock.emit({
        kind: "event",
        seq: 1,
        runId: session.id,
        taskId: session.id,
        type: "chat.turn.start",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b2", reason: "goal.progress" },
      });
      mock.emit({
        kind: "event",
        seq: 2,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "wake-r2b2", delta: "EQUAL-REOPEN-YES." },
      });
      mock.emit({
        kind: "event",
        seq: 3,
        runId: session.id,
        taskId: session.id,
        type: "chat.tool",
        createdAt: Date.now(),
        payload: {
          chatSessionId: session.id,
          turnId: "wake-r2b2",
          name: "present_result",
          status: "completed",
          display: { kind: "run_activity", data: { runId: "run-r2b2-reopen", phase: "active", elapsedMs: 250, tasks: [] } },
        },
      });
      await waitFor(() => text().includes("run-r2b2-reopen"), 3000, "tool card before disconnect");

      mock.disconnect();
      await waitFor(() => text().includes("Reconnected to harnessd"), 5000, "reconnected busy");

      // Second segment must be visible in live tail after reseed even though it equals the frozen segment!
      assert.equal(
        countOccurrences(text(), "EQUAL-REOPEN-YES."),
        2,
        "Post-flush activePartial equal to frozen segment must survive busy reopen reseed",
      );

      mock.emit({
        kind: "event",
        seq: 4,
        runId: session.id,
        taskId: session.id,
        type: "chat.turn.end",
        createdAt: Date.now(),
        payload: {
          chatSessionId: session.id,
          turnId: "wake-r2b2",
          historyThrough: 3,
          assistantTurn: {
            seq: 3,
            chatSessionId: session.id,
            role: "assistant",
            content: "EQUAL-REOPEN-YES.",
            createdAt: Date.now(),
          } satisfies ChatTurnRecord,
        },
      });
      await waitFor(() => text().includes("Ready"), 3000, "reopen turn settled");

      sendInput("\x1d");
      await runPromise;

      const out = text();
      assert.equal(
        countOccurrences(out, "EQUAL-REOPEN-YES."),
        2,
        `Both equal segments must remain after busy reopen + turn.end, got ${countOccurrences(out, "EQUAL-REOPEN-YES.")}`,
      );
    }

    // Part C: Busy reopen with empty activePartial after flush must NOT fall back to cumulative activeText
    {
      const { terminal, text, sendInput } = makeFakeTerminal(120, 30);
      const session = makeChatSession("chat-34-r2b2-empty-partial");
      let openCount = 0;

      const mock = makeMockClient(async (op) => {
        if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r2b2c" };
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
            activeTurnId: "wake-r2b2c",
            activeText: "CUMULATIVE-DISCARDED-ATTEMPT",
            activePartial: "",
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
      await waitFor(() => text().includes("chat-34-r2b2-empty-partial"), 3000, "initial render part C");

      mock.disconnect();
      await waitFor(() => text().includes("Reconnected to harnessd") && openCount >= 2, 5000, "reconnected busy part C");

      sendInput("\x1d");
      await runPromise;

      assert.equal(
        countOccurrences(text(), "CUMULATIVE-DISCARDED-ATTEMPT"),
        0,
        "Empty activePartial must never fall back to cumulative activeText",
      );
    }
  });

  it("review-2 should-fix 4: human-needed live alerts stay pinned in the visible viewport during a long reply, overflow with '+N more', ignore internal lines, and clear on non-interrupting submit", async () => {
    const { terminal, text, viewportText, sendInput, typeText } = makeFakeTerminal(120, 24);
    const session = makeChatSession("chat-34-r2sf4");
    const longLines = Array.from({ length: 40 }, (_, i) => `LONG-LIVE-LINE-${String(i + 1).padStart(2, "0")}`);
    const longReply = longLines.join("\n");
    let resolveSend!: () => void;
    const sendGate = new Promise<void>((r) => (resolveSend = r));
    let resolveSecondSend!: () => void;
    const secondSendGate = new Promise<void>((r) => (resolveSecondSend = r));
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
        if (sendCount === 1) await sendGate;
        else await secondSendGate;
        return { ok: true };
      }
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => viewportText().includes("chat-34-r2sf4"), 3000, "initial render");

    // Start a live turn and stream a reply taller than the 24-row viewport
    typeText("Start long analysis");
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
      payload: { chatSessionId: session.id, turnId, delta: longReply },
    });
    await waitFor(
      () => viewportText().includes("LONG-LIVE-LINE-40") && !viewportText().includes("LONG-LIVE-LINE-01"),
      3000,
      "long reply scrolled past viewport top",
    );

    // Emit an internal line (must NEVER pin) + 4 human-needed P0 escalations (must pin with bounded rows + '+N more')
    mock.emit({
      kind: "event",
      seq: 2,
      runId: "run-sf4",
      taskId: null,
      type: "goal.progress",
      createdAt: Date.now(),
      payload: { goalId: "goal-sf4", phase: "implementing", summary: "INTERNAL-NO-PIN-SF4" },
    });
    for (const [idx, title] of [
      "ESC-HUMAN-ALERT-1: Approve prod deploy",
      "ESC-HUMAN-ALERT-2: Confirm schema cutover",
      "ESC-HUMAN-ALERT-3: Approve DNS switch",
      "ESC-HUMAN-ALERT-4: Confirm rollback window",
    ].entries()) {
      mock.emit({
        kind: "event",
        seq: 3 + idx,
        runId: "run-sf4",
        taskId: `t-sf4-${idx + 1}`,
        type: "escalation.created",
        createdAt: Date.now(),
        payload: {
          id: `esc-sf4-${idx + 1}`,
          toTaskId: null,
          severity: "P0",
          blocking: true,
          title,
        },
      });
    }

    // Assert strictly on the LAST VIEWPORT ROWS (viewportText), NOT scrollback!
    await waitFor(
      () =>
        viewportText().includes("ESC-HUMAN-ALERT-1: Approve prod deploy") &&
        viewportText().includes("+2 more"),
      2000,
      "pinned human alerts + overflow visible in last viewport rows",
    );
    const vpWhileStreaming = viewportText();
    assert.equal(
      vpWhileStreaming.includes("LONG-LIVE-LINE-01"),
      false,
      "Top of long reply is in scrollback, confirming alert is rendered in the pinned dock",
    );
    assert.equal(
      vpWhileStreaming.includes("INTERNAL-NO-PIN-SF4"),
      false,
      "Internal lines must never appear in the pinned attention strip",
    );

    // Clear pinned alerts via a non-interrupting user action (submitting a follow-up message while busy -> queues without cancelling!)
    typeText("Follow up after seeing alerts");
    sendInput("\r");
    await waitFor(
      () =>
        !viewportText().includes("ESC-HUMAN-ALERT-1: Approve prod deploy") &&
        viewportText().includes("Follow up after seeing alerts"),
      2000,
      "non-interrupting submit cleared pinned alerts and queued follow-up",
    );
    assert.equal(
      mock.calls.some((c) => c.op === "chat.cancel"),
      false,
      "Clearing pinned alerts via submit must not cancel the active turn",
    );

    // Now finish the long turn; reply must render ONCE (never frozen or duplicated) and receipts remain in scrollback!
    mock.emit({
      kind: "event",
      seq: 10,
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
          content: longReply,
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSend();
    await waitFor(() => mock.calls.filter((c) => c.op === "chat.send").length === 2, 3000, "queued follow-up drained");
    const turn2Id = String(mock.calls.filter((c) => c.op === "chat.send")[1]!.params.turnId);
    mock.emit({
      kind: "event",
      seq: 11,
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
          content: "FOLLOWUP-DONE-SF4",
          createdAt: Date.now(),
        } satisfies ChatTurnRecord,
      },
    });
    resolveSecondSend();
    await waitFor(() => text().includes("FOLLOWUP-DONE-SF4"), 3000, "follow-up settled");

    sendInput("\x1d");
    await runPromise;

    const fullOut = text();
    assert.equal(countOccurrences(fullOut, "LONG-LIVE-LINE-01"), 1, "Long reply line 1 must render exactly once");
    assert.equal(countOccurrences(fullOut, "LONG-LIVE-LINE-40"), 1, "Long reply line 40 must render exactly once");
    assert.ok(fullOut.includes("ESC-HUMAN-ALERT-1: Approve prod deploy"), "Immutable receipt remains in transcript");
    assert.ok(fullOut.includes("ESC-HUMAN-ALERT-4: Confirm rollback window"), "All human receipts remain in transcript");
  });

  /**
   * Extracts rendered assistant text blocks from the final VT lines (between the banner rule
   * and FixedDock rule), ignoring non-assistant elements (user cards, tool cards, receipts,
   * timestamp dividers, and `◆ <model>` headers). Handles both Unicode and ASCII fallback glyphs.
   */
  function extractRenderedAssistantBlocks(screenLines: string[]): string[] {
    const ruleIdx: number[] = [];
    for (let i = 0; i < screenLines.length; i += 1) {
      if (/^[─-]{20,}$/.test(screenLines[i]!.trim())) ruleIdx.push(i);
    }
    assert.ok(ruleIdx.length >= 2, `Expected banner and dock horizontal rules, found ${ruleIdx.length}`);
    const bodyStart = ruleIdx[0]! + 1;
    const bodyEnd = ruleIdx[1]!;

    const blocks: string[] = [];
    let current: string[] = [];
    const flush = () => {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
    };

    for (let i = bodyStart; i < bodyEnd; i += 1) {
      const raw = screenLines[i]!;
      const trimmed = raw.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      // Timestamp divider
      if (/^[─-]{2,} .+ [─-]{2,}$/.test(trimmed)) {
        flush();
        continue;
      }
      // User card rail (`▎` / `|`) or structured tool-output card inner rail (`│` / `|`)
      if (/^\s*[▎│|]/.test(raw)) {
        flush();
        continue;
      }
      // Structured tool-output card frame (`╭─`, `╰─`, `├─`, `+-`, etc.)
      if (/^[╭╰├┌└+][─-]/.test(trimmed)) {
        flush();
        continue;
      }
      // Tool note (`  ✓ ...` / `  v ...`)
      if (/^  [✓v] /.test(raw)) {
        flush();
        continue;
      }
      // Single-line receipt (`  <glyph> [tag] ...`)
      if (/^  [•✓✗✕!◆●○▸*vxo>] \[[a-z0-9_.-]+\]/i.test(raw)) {
        flush();
        continue;
      }
      // Assistant model attribution header (` ◆ <model>` / ` * <model>`)
      if (/^ [◆*] /.test(raw)) {
        flush();
        continue;
      }
      current.push(trimmed);
    }
    flush();
    return blocks;
  }

  /**
   * Opens a fresh Director chat TUI against the exact persisted history (production-shaped
   * `chat.open` returning the first page + `chat.history` for any later pages) and returns its
   * rendered assistant paragraphs as the oracle for idle reopen reconciliation.
   *
   * Note on scope: this oracle compares rendered assistant paragraphs (split by blank lines,
   * headers, receipts, and cards) rather than immutable `AssistantCard` object boundaries, and
   * mock fixtures omit unrelated rows the daemon would persist before deltas when those rows
   * are equivalent as observed by the reconnecting client.
   */
  async function assertMatchesFreshHistoryOracle(opts: {
    session: ChatSessionRecord;
    persistedHistory: ChatTurnRecord[];
    actualLines: string[];
    expectedPrefixBlocks?: string[];
    expectedRemainderBlocks?: string[];
    cols?: number;
    rows?: number;
    label: string;
  }): Promise<{ actualBlocks: string[]; freshBlocks: string[]; freshText: string }> {
    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 30;
    const pageSize = 50;
    const throughSeq = opts.persistedHistory.reduce((max, r) => Math.max(max, r.seq), 0);
    const { terminal, lines, text, sendInput } = makeFakeTerminal(cols, rows);
    const freshMock = makeMockClient(async (op, params) => {
      if (op === "chat.open") {
        const firstPage = opts.persistedHistory.slice(0, pageSize);
        const lastInPage = firstPage[firstPage.length - 1]?.seq ?? 0;
        return {
          session: opts.session,
          history: firstPage,
          historyNext: opts.persistedHistory.length > pageSize ? lastInPage : null,
          historyThrough: throughSeq,
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          tookOver: false,
          busy: false,
        };
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const through = Number(params.throughSeq ?? throughSeq);
        const slice = opts.persistedHistory.filter((r) => r.seq > afterSeq && r.seq <= through);
        return { history: slice, historyNext: null };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const freshPromise = runDirectorChatTui({ client: freshMock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(opts.session.id), 3000, `${opts.label}: fresh TUI initial render`);
    sendInput("\x1d");
    await freshPromise;

    const freshBlocks = extractRenderedAssistantBlocks(lines());
    if (opts.persistedHistory.some((r) => r.role === "assistant" && r.content.trim())) {
      assert.ok(freshBlocks.length > 0, `${opts.label}: fresh history oracle must extract non-empty assistant blocks`);
    }
    const actualBlocks = extractRenderedAssistantBlocks(opts.actualLines);
    const expectedBlocks = [
      ...(opts.expectedPrefixBlocks ?? []),
      ...freshBlocks,
      ...(opts.expectedRemainderBlocks ?? []),
    ];
    assert.deepEqual(
      actualBlocks,
      expectedBlocks,
      `${opts.label}: assistant blocks after idle reopen must match fresh history load${opts.expectedRemainderBlocks?.length ? " + R3 remainder" : ""}`,
    );
    return { actualBlocks, freshBlocks, freshText: text() };
  }

  /** Production-shaped mock response builder for `chat.open` (returns first page of history). */
  function makeProdChatOpen(
    session: ChatSessionRecord,
    history: ChatTurnRecord[],
    overrides?: {
      busy?: boolean;
      activeTurnId?: string | null;
      activeText?: string;
      activePartial?: string;
      control?: { sessionId: string; controllerClientId: string | null; hasControl: boolean; controlSeq: number };
    },
  ) {
    const historyThrough = history.reduce((max, r) => Math.max(max, r.seq), 0);
    return {
      session,
      history: [...history],
      historyNext: null,
      historyThrough,
      activeTurnId: overrides?.activeTurnId ?? null,
      activeText: overrides?.activeText ?? "",
      activePartial: overrides?.activePartial ?? "",
      tookOver: false,
      busy: overrides?.busy ?? false,
      ...(overrides?.control ? { control: overrides.control } : {}),
    };
  }

  it("review-3 case 1 (rollover): tail AB with persisted rows A and B renders A and B once each and matches fresh history load", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r3-c1");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r3" };
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id), 3000, "initial render");

    // Production live frames carry seq: 0; rollover flushes A silently with no boundary event.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c1", reason: "goal.progress" },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c1", delta: "ROLLOVER-SEG-A-R3C1" },
    });
    // Daemon persists A on context rollover without emitting any chat boundary event, then streams B.
    history.push({
      seq: 1,
      chatSessionId: session.id,
      role: "assistant",
      content: "ROLLOVER-SEG-A-R3C1",
      createdAt: Date.now(),
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c1", delta: "\n\nROLLOVER-SEG-B-R3C1" },
    });
    await waitFor(() => text().includes("ROLLOVER-SEG-B-R3C1"), 3000, "tail AB streamed");

    // Disconnect; turn completes offline and persists B.
    history.push({
      seq: 2,
      chatSessionId: session.id,
      role: "assistant",
      content: "ROLLOVER-SEG-B-R3C1",
      createdAt: Date.now(),
    });
    mock.disconnect();
    await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, "reconnected idle");

    sendInput("\x1d");
    await runPromise;

    const out = text();
    await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      label: "review-3 case 1 (rollover)",
    });
    assert.equal(countOccurrences(out, "ROLLOVER-SEG-A-R3C1"), 1, "segment A must render once");
    assert.equal(countOccurrences(out, "ROLLOVER-SEG-B-R3C1"), 1, "segment B must render once");
    assert.equal(out.includes("Turn ended while disconnected"), false, "no spurious early-end line");
    assert.equal(out.includes("Turn ended early"), false, "no spurious restart early-end line");
  });

  it("review-3 case 2 (Pi last-response-only): tail AB with persisted row B renders B once, discards tail, and matches fresh history load", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r3-c2");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r3" };
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id), 3000, "initial render");

    // Pi streams A, runs an ordinary tool without display (no freeze), then streams B.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c2", reason: "goal.progress" },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c2", delta: "PI-COMMENTARY-A-R3C2" },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c2", id: "tool-ord-1", name: "list_goals", status: "completed" },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c2", delta: "\n\nPI-FINAL-B-R3C2" },
    });
    await waitFor(() => text().includes("PI-FINAL-B-R3C2"), 3000, "tail AB streamed");

    // Disconnect; Pi persists only its last provider response B.
    history.push({
      seq: 1,
      chatSessionId: session.id,
      role: "assistant",
      content: "PI-FINAL-B-R3C2",
      createdAt: Date.now(),
    });
    mock.disconnect();
    await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, "reconnected idle");

    sendInput("\x1d");
    await runPromise;

    const out = text();
    await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      label: "review-3 case 2 (Pi last-response-only)",
    });
    assert.equal(countOccurrences(out, "PI-FINAL-B-R3C2"), 1, "persisted final response B must render once");
    assert.equal(countOccurrences(out, "PI-COMMENTARY-A-R3C2"), 0, "unpersisted commentary A must be discarded with tail");
    assert.equal(out.includes("Turn ended while disconnected"), false, "no spurious early-end line");
  });

  it("review-3 case 3 (viewer opening before user row): renders opening user card once and reply once for both full and prefix tails", async () => {
    for (const variant of [
      { label: "full-tail", streamed: "VIEWER-REPLY-FULL-R3C3", persisted: "VIEWER-REPLY-FULL-R3C3" },
      { label: "prefix-tail", streamed: "VIEWER-REPLY-PRE", persisted: "VIEWER-REPLY-PREFIX-COMPLETE-R3C3" },
    ]) {
      const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
      const session = makeChatSession(`chat-34-r3-c3-${variant.label}`);
      const history: ChatTurnRecord[] = [];
      let openCount = 0;

      const mock = makeMockClient(async (op, params) => {
        if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r3" };
        if (op === "chat.open") {
          openCount += 1;
          if (openCount === 1) {
            // Viewer opens while another controller's turn is active BEFORE the opening user row is persisted.
            return makeProdChatOpen(session, history, {
              busy: true,
              activeTurnId: "turn-r3-c3",
              activeText: "",
              activePartial: "",
              control: {
                sessionId: session.id,
                controllerClientId: "other-controller",
                hasControl: false,
                controlSeq: 1,
              },
            });
          }
          return makeProdChatOpen(session, history, {
            busy: false,
            control: {
              sessionId: session.id,
              controllerClientId: "other-controller",
              hasControl: false,
              controlSeq: 1,
            },
          });
        }
        if (op === "chat.history") {
          const afterSeq = Number(params.afterSeq ?? 0);
          const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
          return {
            history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
            historyNext: null,
          };
        }
        if (op === "work.snapshot") return emptyWorkSnapshot();
        if (op === "session.leave") return { daemonWillQuit: false };
        return {};
      });

      const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
      await waitFor(() => text().includes(session.id), 3000, `${variant.label}: initial render`);

      // Viewer receives live deltas (seq: 0) with no prior live user card.
      mock.emit({
        kind: "event",
        seq: 0,
        runId: session.id,
        taskId: session.id,
        type: "chat.delta",
        createdAt: Date.now(),
        payload: { chatSessionId: session.id, turnId: "turn-r3-c3", delta: variant.streamed },
      });
      await waitFor(() => text().includes(variant.streamed), 3000, `${variant.label}: delta visible`);

      // Disconnect; turn completes offline with opening user row (seq 1) and assistant reply (seq 2).
      history.push(
        { seq: 1, chatSessionId: session.id, role: "user", content: "VIEWER-PROMPT-R3C3", createdAt: Date.now() },
        { seq: 2, chatSessionId: session.id, role: "assistant", content: variant.persisted, createdAt: Date.now() },
      );
      mock.disconnect();
      await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, `${variant.label}: reconnected idle`);

      sendInput("\x1d");
      await runPromise;

      const out = text();
      await assertMatchesFreshHistoryOracle({
        session,
        persistedHistory: history,
        actualLines: lines(),
        label: `review-3 case 3 (${variant.label})`,
      });
      assert.equal(countOccurrences(out, "VIEWER-PROMPT-R3C3"), 1, `${variant.label}: opening user card must render once`);
      assert.equal(countOccurrences(out, variant.persisted), 1, `${variant.label}: assistant reply must render once`);
      assert.equal(out.includes("Turn ended while disconnected"), false, `${variant.label}: no spurious early-end line`);
    }
  });

  it("review-3 case 4 (rollover + live structured tool card): frozen AB skips persisted A and B so nothing renders again", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r3-c4");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;

    const toolDisplay = {
      kind: "run_activity" as const,
      data: { runId: "run-r3-c4", phase: "active", elapsedMs: 400, tasks: [] },
    };

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") return { pong: true, pid: process.pid, protocolRev: 8, releaseId: "rel-r3" };
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id), 3000, "initial render");

    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c4", reason: "goal.progress" },
    });
    // Stream A, daemon silently persists A on rollover, stream B, then live structured tool card freezes AB.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c4", delta: "FROZEN-ROLLOVER-A-R3C4" },
    });
    history.push({
      seq: 1,
      chatSessionId: session.id,
      role: "assistant",
      content: "FROZEN-ROLLOVER-A-R3C4",
      createdAt: Date.now(),
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c4", delta: "\n\nFROZEN-ROLLOVER-B-R3C4" },
    });
    history.push(
      {
        seq: 2,
        chatSessionId: session.id,
        role: "assistant",
        content: "FROZEN-ROLLOVER-B-R3C4",
        createdAt: Date.now(),
      },
      {
        seq: 3,
        chatSessionId: session.id,
        role: "tool_output",
        content: "run-r3-c4",
        toolName: "present_result",
        display: toolDisplay,
        createdAt: Date.now(),
      },
    );
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: "turn-r3-c4",
        name: "present_result",
        status: "completed",
        display: toolDisplay,
      },
    });
    await waitFor(() => text().includes("run-r3-c4"), 3000, "live tool card froze AB");

    // Disconnect; turn ends right after the tool flush with no final assistant row.
    mock.disconnect();
    await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, "reconnected idle");

    sendInput("\x1d");
    await runPromise;

    const out = text();
    await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      label: "review-3 case 4 (rollover + live tool card)",
    });
    assert.equal(countOccurrences(out, "FROZEN-ROLLOVER-A-R3C4"), 1, "frozen A must not render again");
    assert.equal(countOccurrences(out, "FROZEN-ROLLOVER-B-R3C4"), 1, "frozen B must not render again");
    assert.equal(countOccurrences(out, "run-r3-c4"), 1, "live tool card must not render again");
    assert.equal(out.includes("Turn ended while disconnected"), false, "no spurious early-end line");
  });

  it("review-3 case 5 (rollover + daemon crash before B persisted): renders A once and appends unpersisted remainder B once with interrupted note", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r3-c5");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;
    let daemonPid = process.pid;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r3" };
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id), 3000, "initial render");

    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c5", reason: "goal.progress" },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c5", delta: "CRASH-PERSISTED-A-R3C5" },
    });
    // Rollover persists A silently.
    history.push({
      seq: 1,
      chatSessionId: session.id,
      role: "assistant",
      content: "CRASH-PERSISTED-A-R3C5",
      createdAt: Date.now(),
    });
    // B streams to the TUI, then daemon dies before B is persisted.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r3-c5", delta: "\n\nCRASH-UNPERSISTED-B-R3C5" },
    });
    await waitFor(() => text().includes("CRASH-UNPERSISTED-B-R3C5"), 3000, "tail AB streamed");

    daemonPid = process.pid + 1;
    mock.disconnect();
    await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, "reconnected after crash");

    sendInput("\x1d");
    await runPromise;

    const out = text();
    await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      expectedRemainderBlocks: ["CRASH-UNPERSISTED-B-R3C5"],
      label: "review-3 case 5 (rollover + crash before B)",
    });
    assert.equal(countOccurrences(out, "CRASH-PERSISTED-A-R3C5"), 1, "persisted A must render once");
    assert.equal(countOccurrences(out, "CRASH-UNPERSISTED-B-R3C5"), 1, "unpersisted remainder B must append once");
    assert.ok(
      out.includes("Turn ended early: harnessd restarted"),
      "must include quiet restart note when appending unpersisted remainder after daemon crash",
    );
  });

  it("review-4 blocker 1 (Pi commentary starts with final reply, same daemon pid): busy reopen then idle reopen matches fresh history load with no remainder", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r4-b1");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;
    let isBusy = false;
    let activePartial = "";
    const daemonPid = process.pid;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r4" };
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, {
          busy: isBusy,
          activeTurnId: isBusy ? "turn-r4-b1" : null,
          activeText: isBusy ? activePartial : "",
          activePartial: isBusy ? activePartial : "",
        });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id), 3000, "initial render");

    // Viewer sees turn.start(user), row 1 user, delta "Confirmed. I will check.", plain tool with no display.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r4-b1", reason: "user", text: "Check status and confirm." },
    });
    history.push({
      seq: 1,
      chatSessionId: session.id,
      role: "user",
      content: "Check status and confirm.",
      createdAt: Date.now(),
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r4-b1", delta: "Confirmed. I will check." },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: "turn-r4-b1",
        id: "tool-list-models",
        name: "list_models",
        status: "completed",
      },
    });
    await waitFor(() => text().includes("Confirmed. I will check."), 3000, "commentary streamed");

    // First disconnect: busy reopen on the same turn seeded from activePartial (same daemon pid).
    isBusy = true;
    activePartial = "Confirmed. I will check.";
    mock.disconnect();
    await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, "reconnected #1 busy");

    // Second provider response streams "\n\nConfirmed.", then a passive goal.reviewed arrives.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r4-b1", delta: "\n\nConfirmed." },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "goal.reviewed",
      createdAt: Date.now(),
      payload: {
        goalId: "goal-r4-b1",
        title: "Status verification",
        verdict: "approve",
        goalStatus: "verifying",
      },
    });
    await waitFor(() => countOccurrences(text(), "Confirmed.") >= 2, 3000, "second Confirmed delta streamed");

    // Second disconnect: Pi completes normally offline with one assistant row "Confirmed." (same daemon pid).
    isBusy = false;
    activePartial = "";
    history.push({
      seq: 2,
      chatSessionId: session.id,
      role: "assistant",
      content: "Confirmed.",
      createdAt: Date.now(),
    });
    mock.disconnect();
    await waitFor(() => openCount >= 3, 5000, "reconnected #2 idle");
    await new Promise((r) => setTimeout(r, 40));

    sendInput("\x1d");
    await runPromise;

    const out = text();
    await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      label: "review-4 blocker 1 (Pi commentary starting with final reply)",
    });
    assert.deepEqual(
      extractRenderedAssistantBlocks(lines()),
      ["Confirmed."],
      "assistant paragraphs must be exactly ['Confirmed.']",
    );
    assert.equal(out.includes("I will check."), false, "discarded commentary remainder must not append");
    assert.equal(out.includes("Turn ended while disconnected"), false, "no spurious early-end line");
  });

  it("review-4 blocker 2 (overflow retry + live structured tool card + offline empty cancel): keeps live screen and adds nothing on idle reopen", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r4-b2");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;
    const daemonPid = process.pid;
    const display = {
      kind: "run_activity" as const,
      data: { runId: "run-r4-b2", phase: "active", elapsedMs: 250, tasks: [] },
    };

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r4" };
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id), 3000, "initial render");

    // User row 1; delta "Prompt is too long."; overflow retry drops partial with no row and no live boundary.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r4-b2", reason: "user", text: "Summarize run activity." },
    });
    history.push({
      seq: 1,
      chatSessionId: session.id,
      role: "user",
      content: "Summarize run activity.",
      createdAt: Date.now(),
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r4-b2", delta: "Prompt is too long." },
    });
    // Overflow retry streams "\n\nRETRIED-ANSWER", then presents a tool display.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r4-b2", delta: "\n\nRETRIED-ANSWER" },
    });
    // Daemon persists assistant(RETRIED-ANSWER) seq 2 and tool_output seq 3, then sends the live card.
    history.push(
      {
        seq: 2,
        chatSessionId: session.id,
        role: "assistant",
        content: "RETRIED-ANSWER",
        createdAt: Date.now(),
      },
      {
        seq: 3,
        chatSessionId: session.id,
        role: "tool_output",
        content: "run-r4-b2",
        toolName: "present_result",
        display,
        createdAt: Date.now(),
      },
    );
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: "turn-r4-b2",
        name: "present_result",
        status: "completed",
        display,
      },
    });
    await waitFor(() => text().includes("run-r4-b2"), 3000, "live tool card froze overflow + retried text");

    // Disconnect; turn is cancelled offline with an empty partial, so no final assistant row is persisted.
    mock.disconnect();
    await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, "reconnected idle");

    sendInput("\x1d");
    await runPromise;

    const out = text();
    await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      expectedPrefixBlocks: ["Prompt is too long."],
      label: "review-4 blocker 2 (overflow retry + live tool card)",
    });
    assert.equal(countOccurrences(out, "RETRIED-ANSWER"), 1, "RETRIED-ANSWER must appear exactly once");
    assert.equal(countOccurrences(out, "run-r4-b2"), 1, "live tool card must appear exactly once");
    assert.equal(out.includes("Turn ended while disconnected"), false, "no spurious early-end line");
  });

  it("review-5 B3 (held initial ping + transport close 100ms after busy open): reconnects and renders OFFLINE-FINAL once", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r5-b3-disconnect");
    const history: ChatTurnRecord[] = [
      {
        seq: 1,
        chatSessionId: session.id,
        role: "user",
        content: "Check status",
        createdAt: Date.now(),
      },
    ];
    let busy = true;
    let activeTurnId: string | null = "turn-r5-b3";
    let openCount = 0;
    let pingCount = 0;
    const daemonPid = process.pid;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") {
        pingCount += 1;
        if (pingCount === 1) {
          // Hold the initial startup ping indefinitely until transport disconnect rejects it.
          return await new Promise<never>(() => {});
        }
        return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r5" };
      }
      if (op === "chat.open") {
        openCount += 1;
        if (openCount === 1) {
          // Schedule transport loss 100ms after initial chat.open while initial ping is held.
          setTimeout(() => {
            history.push({
              seq: 2,
              chatSessionId: session.id,
              role: "assistant",
              content: "OFFLINE-FINAL",
              createdAt: Date.now(),
            });
            busy = false;
            activeTurnId = null;
            mock.disconnect();
          }, 100);
        }
        return makeProdChatOpen(session, history, { busy, activeTurnId });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    try {
      await waitFor(
        () => openCount >= 2 && text().includes("OFFLINE-FINAL"),
        2000,
        "reconnect after held initial ping disconnect",
      );
    } finally {
      sendInput("\x1d");
      await runPromise;
    }

    const out = text();
    assert.equal(openCount, 2, "must reconnect with two chat.open calls");
    assert.equal(mock.client.connected, true, "client must be reconnected");
    assert.equal(countOccurrences(out, "OFFLINE-FINAL"), 1, "OFFLINE-FINAL must appear exactly once");
    await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      label: "review-5 B3 (held initial ping + disconnect)",
    });
  });

  it("review-5 B3 (held initial ping without disconnect): renders banner and history without waiting on ping", async () => {
    const { terminal, text, writes, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r5-b3-render");
    const history: ChatTurnRecord[] = [
      {
        seq: 1,
        chatSessionId: session.id,
        role: "user",
        content: "Initial prompt before held ping",
        createdAt: Date.now(),
      },
      {
        seq: 2,
        chatSessionId: session.id,
        role: "assistant",
        content: "HISTORY-ROW-VISIBLE",
        createdAt: Date.now(),
      },
    ];

    const mock = makeMockClient(async (op) => {
      if (op === "ping") {
        // Hold the startup ping forever without answering.
        return await new Promise<never>(() => {});
      }
      if (op === "chat.open") {
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    let renderErr: unknown = null;
    try {
      await waitFor(
        () => writes.length > 0 && text().includes(session.id) && text().includes("HISTORY-ROW-VISIBLE"),
        1500,
        "initial banner and history render while ping is held",
      );
    } catch (err) {
      renderErr = err;
    } finally {
      if (renderErr) {
        // If startup is still stuck awaiting ping, disconnect unblocks it so Ctrl+] can exit cleanly.
        mock.disconnect();
        await waitFor(() => writes.length > 0, 500).catch(() => {});
      }
      sendInput("\x1d");
      await runPromise.catch(() => {});
    }
    if (renderErr) throw renderErr;

    const out = text();
    assert.ok(writes.length > 0, "virtual terminal must receive output while ping is held");
    assert.ok(out.includes(session.id), "banner must render while ping is held");
    assert.ok(out.includes("Initial prompt before held ping"), "history user row must render while ping is held");
    assert.ok(out.includes("HISTORY-ROW-VISIBLE"), "history assistant row must render while ping is held");
  });

  it("review-5 B2 (draining + disconnect + same-PID idle reopen): discards Pi commentary remainder with no restart note", async () => {
    const { terminal, lines, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r5-b2");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;
    let pingCount = 0;
    let turnId = "";
    const daemonPid = process.pid;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") {
        pingCount += 1;
        return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r5" };
      }
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "chat.send") {
        turnId = String(params.turnId ?? "turn-r5-b2");
        history.push({
          seq: 1,
          chatSessionId: session.id,
          role: "user",
          content: String(params.message ?? params.text ?? "Check status"),
          createdAt: Date.now(),
        });
        // Hold chat.send open while the turn streams until disconnect rejects it.
        return await new Promise<never>(() => {});
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id) && pingCount >= 1, 3000, "initial render and startup pid probe");

    // One controller sends "Check status" (user seq 1).
    typeText("Check status");
    sendInput("\r");
    await waitFor(() => Boolean(turnId), 3000, "chat.send dispatched");

    // Pi commentary delta, plain list_models tool with no display, second delta "\n\nConfirmed.".
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: "Confirmed. I will check." },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.tool",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId,
        id: "tool-list-models-r5-b2",
        name: "list_models",
        status: "completed",
      },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: "\n\nConfirmed." },
    });
    await waitFor(() => text().includes("Confirmed. I will check."), 3000, "deltas streamed");

    // Daemon broadcasts reload draining, then transport drops; turn completes offline on the same daemon process.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: "",
      taskId: null,
      type: "daemon.reload",
      createdAt: Date.now(),
      payload: {
        phase: "draining",
        fromReleaseId: "rel-r5",
        toReleaseId: "rel-r5-next",
        deadlineAt: Date.now() + 30_000,
      },
    });
    history.push({
      seq: 2,
      chatSessionId: session.id,
      role: "assistant",
      content: "Confirmed.",
      createdAt: Date.now(),
    });
    mock.disconnect();
    await waitFor(() => openCount >= 2 && text().includes("Reconnected to harnessd"), 5000, "reconnected idle on same pid");

    sendInput("\x1d");
    await runPromise;

    const out = text();
    const { actualBlocks } = await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      label: "review-5 B2 (draining + same-PID idle reopen)",
    });
    assert.deepEqual(actualBlocks, ["Confirmed."], "assistant paragraphs must be exactly ['Confirmed.']");
    assert.equal(
      out.includes("Turn ended early: harnessd restarted"),
      false,
      "same-PID reconnect after draining must not print restart note",
    );
    assert.equal(out.includes("Turn ended early"), false, "no spurious early-end note");
  });

  it("review-5 B1 (overflow retry + accepted /now steer + offline completion): renders RETRIED-ANSWER and Keep going once each on idle reopen", async () => {
    const { terminal, lines, text, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r5-b1");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;
    let pingCount = 0;
    let turnId = "";
    const daemonPid = process.pid;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") {
        pingCount += 1;
        return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r5" };
      }
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, { busy: false });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "chat.send") {
        turnId = String(params.turnId ?? "turn-r5-b1");
        history.push({
          seq: 1,
          chatSessionId: session.id,
          role: "user",
          content: String(params.message ?? params.text ?? "Check status"),
          createdAt: Date.now(),
        });
        return await new Promise<never>(() => {});
      }
      if (op === "chat.steer") {
        // Accepted steer flushes post-overflow partial as assistant seq 2, then persists user seq 3.
        history.push(
          {
            seq: 2,
            chatSessionId: session.id,
            role: "assistant",
            content: "\n\nRETRIED-ANSWER",
            createdAt: Date.now(),
          },
          {
            seq: 3,
            chatSessionId: session.id,
            role: "user",
            content: String(params.message ?? "Keep going"),
            createdAt: Date.now(),
          },
        );
        return { steered: true };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id) && pingCount >= 1, 3000, "initial render and startup pid probe");

    // 1. User sends "Check status" (seq 1).
    typeText("Check status");
    sendInput("\r");
    await waitFor(() => Boolean(turnId), 3000, "chat.send dispatched");

    // 2. Delta "Prompt is too long.", silent overflow reset on daemon, delta "\n\nRETRIED-ANSWER".
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: "Prompt is too long." },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId, delta: "\n\nRETRIED-ANSWER" },
    });
    await waitFor(() => text().includes("RETRIED-ANSWER"), 3000, "retried delta streamed");

    // 3. User queues "Keep going" and submits /now -> chat.steer returns steered:true.
    typeText("Keep going");
    sendInput("\r");
    await waitFor(() => text().includes("Keep going"), 3000, "queued Keep going");
    typeText("/now");
    sendInput("\r");
    await waitFor(
      () => text().includes("Delivered live steering to Director"),
      3000,
      "steer accepted and frozen",
    );

    // 4. Disconnect; turn completes offline with assistant seq 4 "FINISHED"; idle reopen, same PID.
    history.push({
      seq: 4,
      chatSessionId: session.id,
      role: "assistant",
      content: "FINISHED",
      createdAt: Date.now(),
    });
    mock.disconnect();
    await waitFor(
      () => openCount >= 2 && text().includes("Reconnected to harnessd") && text().includes("FINISHED"),
      5000,
      "reconnected idle after steer",
    );

    sendInput("\x1d");
    await runPromise;

    const out = text();
    const { actualBlocks } = await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      expectedPrefixBlocks: ["Prompt is too long."],
      label: "review-5 B1 (overflow retry + accepted /now steer)",
    });
    assert.deepEqual(
      actualBlocks,
      ["Prompt is too long.", "RETRIED-ANSWER", "FINISHED"],
      "assistant paragraphs must be ['Prompt is too long.', 'RETRIED-ANSWER', 'FINISHED']",
    );
    assert.equal(countOccurrences(out, "RETRIED-ANSWER"), 1, "RETRIED-ANSWER must appear exactly once");
    assert.equal(countOccurrences(out, "Keep going"), 1, "Keep going must appear exactly once");
    assert.equal(countOccurrences(out, "FINISHED"), 1, "FINISHED must appear exactly once");
    assert.equal(out.includes("Turn ended while disconnected"), false, "no spurious early-end line");
    assert.equal(out.includes("Turn ended early"), false, "no spurious restart line");
  });

  it("review-5 B1 (chat.steered viewer path after overflow retry): renders RETRIED-ANSWER and Keep going once each on idle reopen", async () => {
    const { terminal, lines, text, sendInput } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-34-r5-b1-viewer");
    const history: ChatTurnRecord[] = [];
    let openCount = 0;
    let pingCount = 0;
    const daemonPid = process.pid;

    const mock = makeMockClient(async (op, params) => {
      if (op === "ping") {
        pingCount += 1;
        return { pong: true, pid: daemonPid, protocolRev: 8, releaseId: "rel-r5" };
      }
      if (op === "chat.open") {
        openCount += 1;
        return makeProdChatOpen(session, history, {
          busy: false,
          control: { sessionId: session.id, controllerClientId: "other-client", hasControl: false, controlSeq: 1 },
        });
      }
      if (op === "chat.history") {
        const afterSeq = Number(params.afterSeq ?? 0);
        const throughSeq = Number(params.throughSeq ?? Number.MAX_SAFE_INTEGER);
        return {
          history: history.filter((r) => r.seq > afterSeq && r.seq <= throughSeq),
          historyNext: null,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes(session.id) && pingCount >= 1, 3000, "initial viewer render");

    // Viewer observes turn start, overflow + retried deltas, and chat.steered from the controller.
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.start",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r5-b1-v", reason: "user", text: "Check status" },
    });
    history.push({
      seq: 1,
      chatSessionId: session.id,
      role: "user",
      content: "Check status",
      createdAt: Date.now(),
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r5-b1-v", delta: "Prompt is too long." },
    });
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.delta",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: "turn-r5-b1-v", delta: "\n\nRETRIED-ANSWER" },
    });
    history.push(
      {
        seq: 2,
        chatSessionId: session.id,
        role: "assistant",
        content: "\n\nRETRIED-ANSWER",
        createdAt: Date.now(),
      },
      {
        seq: 3,
        chatSessionId: session.id,
        role: "user",
        content: "Keep going",
        createdAt: Date.now(),
      },
    );
    mock.emit({
      kind: "event",
      seq: 0,
      runId: session.id,
      taskId: session.id,
      type: "chat.steered",
      createdAt: Date.now(),
      payload: {
        chatSessionId: session.id,
        turnId: "turn-r5-b1-v",
        role: "user",
        message: "Keep going",
        originClientId: "other-client",
      },
    });
    await waitFor(() => text().includes("Keep going"), 3000, "viewer received chat.steered");

    history.push({
      seq: 4,
      chatSessionId: session.id,
      role: "assistant",
      content: "FINISHED",
      createdAt: Date.now(),
    });
    mock.disconnect();
    await waitFor(
      () => openCount >= 2 && text().includes("Reconnected to harnessd") && text().includes("FINISHED"),
      5000,
      "viewer reconnected idle after steer",
    );

    sendInput("\x1d");
    await runPromise;

    const out = text();
    const { actualBlocks } = await assertMatchesFreshHistoryOracle({
      session,
      persistedHistory: history,
      actualLines: lines(),
      expectedPrefixBlocks: ["Prompt is too long."],
      label: "review-5 B1 (chat.steered viewer path)",
    });
    assert.deepEqual(actualBlocks, ["Prompt is too long.", "RETRIED-ANSWER", "FINISHED"]);
    assert.equal(countOccurrences(out, "RETRIED-ANSWER"), 1, "RETRIED-ANSWER must appear once on viewer");
    assert.equal(countOccurrences(out, "Keep going"), 1, "Keep going must appear once on viewer");
    assert.equal(countOccurrences(out, "FINISHED"), 1, "FINISHED must appear once on viewer");
  });
});
