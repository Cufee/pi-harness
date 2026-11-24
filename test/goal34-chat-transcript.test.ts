import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../src/director/session.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui } from "../src/tui/app.js";
import { stripTerminalSequences } from "../src/tui/core/index.js";

function makeFakeTerminal(cols = 110, rows = 30) {
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
          // Reconnect while the same turn is still active, with daemon reporting full partial including already-frozen prefix
          return {
            session,
            history: [],
            historyNext: null,
            historyThrough: 0,
            activeTurnId: turnId,
            activeText: fullReply,
            activePartial: fullReply,
            tookOver: false,
            busy: true,
          };
        }
        if (op === "chat.history") {
          return { history: [], historyNext: null };
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

      // Now finish the turn carrying fullReply (part1 + part2)
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
            content: fullReply,
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

    // Also emit a stale late chat.turn.end carrying seq=2 (already synced) to verify the seq guard
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
});
