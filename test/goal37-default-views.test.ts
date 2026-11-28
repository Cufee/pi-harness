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
import { stripTerminalSequences } from "../src/tui/core/index.js";
import type { WorkSnapshot } from "../src/tui/store.js";

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

    // Also verify a turn with a failed tool renders "N call · K failed" and /internal toggles internal chat lines
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

    // Toggle /internal and confirm it reports that internal chat lines are now shown
    const writesBeforeInternal = writes.length;
    typeText("/internal");
    sendInput("\r");
    await waitFor(
      () => since(writesBeforeInternal).includes("Internal lines: shown"),
      3000,
      "/internal shows internal chat lines",
    );

    sendInput("\x1d"); // Detach cleanly
    await runPromise;
  });
});
