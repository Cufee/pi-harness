import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../src/director/session.js";
import type { ChatControlEvent } from "../src/protocol/chat-events.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { runDirectorChatTui } from "../src/tui/app.js";
import { classifyAttentionAudience, classifyChatLine, classifyControlEvent } from "../src/tui/chat-lines.js";
import { stripTerminalSequences } from "../src/tui/core/index.js";

const RAW_EVENT_TYPE_RE = /^[a-z_]+\.[a-z_.]+$/;

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

function makeChatSession(id = "chat-c4"): ChatSessionRecord {
  const now = Date.now();
  return {
    id,
    projectId: null,
    repoRoot: "/repo",
    title: "Goal 34 Lines Test",
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

function frame(type: string, payload: Record<string, unknown> = {}, runId = "run-1"): DaemonEventFrame {
  return {
    kind: "event",
    seq: 1,
    runId,
    taskId: null,
    type,
    createdAt: Date.now(),
    payload,
  };
}

function assertNoRawEventLeak(
  res: ReturnType<typeof classifyChatLine>,
  eventType: string,
  label: string,
): void {
  assert.ok(res, `${label}: expected classified line`);
  assert.equal(RAW_EVENT_TYPE_RE.test(res.tag), false, `${label}: tag "${res.tag}" looks like raw event type`);
  assert.equal(RAW_EVENT_TYPE_RE.test(res.text), false, `${label}: text "${res.text}" looks like raw event type`);
  assert.equal(res.tag.includes(eventType), false, `${label}: tag "${res.tag}" contains "${eventType}"`);
  assert.equal(res.text.includes(eventType), false, `${label}: text "${res.text}" contains "${eventType}"`);
  assert.equal(/\bchanges_requested\b/.test(res.text), false, `${label}: raw token changes_requested in "${res.text}"`);
}

describe("goal-34 c4: classifyChatLine pure unit tests", () => {
  it("never emits a raw event type for any goal.* or quota.* frame, including empty payloads", () => {
    const goalTypes = [
      "goal.committed",
      "goal.amended",
      "goal.reviewed",
      "goal.settled",
      "goal.escalated",
      "goal.progress",
      "goal.gate_activity",
      "goal.amendment_task",
      "goal.amendment_undelivered",
      "goal.accept_rejected",
      "goal.accept_gates_skipped",
      "goal.review_stale",
      "goal.reviewer_failed",
      "goal.review_superseded",
      "goal.unknown_future_event",
    ];
    for (const type of goalTypes) {
      const emptyRes = classifyChatLine({ source: "live", event: frame(type, {}) });
      assertNoRawEventLeak(emptyRes, type, `${type} (empty)`);
      assert.equal(emptyRes?.audience, "internal", `${type} with empty payload must be internal`);

      const withGoalId = classifyChatLine({ source: "live", event: frame(type, { goalId: "goal-32" }) });
      assertNoRawEventLeak(withGoalId, type, `${type} (goalId only)`);
      assert.equal(withGoalId?.tag, "goal-32");
    }

    const quotaTypes = [
      "quota.run_paused",
      "quota.run_scheduled",
      "quota.run_resumed",
      "quota.agent_paused",
      "quota.agent_retrying",
      "quota.agent_recovered",
    ];
    for (const type of quotaTypes) {
      const res = classifyChatLine({ source: "live", event: frame(type, {}) });
      assertNoRawEventLeak(res, type, `${type} (empty)`);
      assert.equal(res?.audience, "internal", `${type} with empty payload must be internal`);
    }
  });

  it("never emits raw event kinds for all 12 ChatControlEvent kinds and matches human vs internal audit classification", () => {
    const controlEvents: Array<{ ev: ChatControlEvent; expectedAudience: "human" | "internal" }> = [
      {
        ev: {
          kind: "goal.settled",
          goalId: "goal-1",
          goalVersion: 1,
          goalTitle: "Ship feature",
          runId: "run-1",
          runStatus: "completed",
          openEscalations: 0,
        },
        expectedAudience: "human",
      },
      {
        ev: {
          kind: "goal.settled",
          goalId: "goal-1",
          goalVersion: 1,
          goalTitle: "Ship feature",
          runId: "run-1",
          runStatus: "stopped",
          openEscalations: 0,
          cause: "daemon_restart",
        },
        expectedAudience: "internal",
      },
      {
        ev: {
          kind: "goal.escalated",
          goalId: "goal-2",
          goalVersion: 1,
          goalTitle: "Fix auth",
          runId: "run-2",
          runStatus: "active",
          escalationId: "esc-9",
          severity: "P0",
          title: "Need key approval",
          openEscalations: 1,
        },
        expectedAudience: "human",
      },
      {
        ev: {
          kind: "goal.committed",
          goalId: "goal-3",
          goalVersion: 1,
          goalTitle: "Add queue strip",
          runId: "run-3",
          criteriaCount: 4,
        },
        expectedAudience: "human",
      },
      {
        ev: {
          kind: "goal.amended",
          goalId: "goal-4",
          fromVersion: 1,
          toVersion: 2,
          rationale: "Tighten criteria",
          source: "director",
        },
        expectedAudience: "internal",
      },
      {
        ev: {
          kind: "goal.amended",
          goalId: "goal-4",
          fromVersion: 2,
          toVersion: 3,
          rationale: "User changed scope",
          source: "user",
        },
        expectedAudience: "human",
      },
      {
        ev: {
          kind: "goal.reviewed",
          goalId: "goal-5",
          goalVersion: 1,
          cycle: 1,
          verdict: "changes_requested",
          status: "executing",
          summary: "changes_requested on local main",
        },
        expectedAudience: "human",
      },
      {
        ev: {
          kind: "goal.gate_activity",
          goalId: "goal-6",
          goalVersion: 1,
          goalTitle: "Gated goal",
          runId: "run-6",
          gate: "awaiting_human",
          escalationIds: [],
          openBlockingEscalations: 0,
          activity: "worker_spawned",
          taskId: "t-12",
          taskTier: 2,
          title: "Spawned worker",
        },
        expectedAudience: "internal",
      },
      {
        ev: {
          kind: "goal.events_batch",
          events: [
            {
              kind: "goal.reviewed",
              goalId: "goal-7",
              goalVersion: 1,
              cycle: 1,
              verdict: "approve",
              status: "achieved",
              summary: "Approved on local main",
            },
          ],
        },
        expectedAudience: "human",
      },
      {
        ev: {
          kind: "director.read_file",
          path: "src/tui/app.ts",
          bytes: 4096,
          reason: "inspect handler",
        },
        expectedAudience: "internal",
      },
      {
        ev: {
          kind: "timer.scheduled",
          timerId: "tm-1",
          wakeAt: Date.now() + 60_000,
          reason: "check CI",
          goalId: "goal-8",
        },
        expectedAudience: "internal",
      },
      {
        ev: {
          kind: "timer.fired",
          timerId: "tm-1",
          wakeReason: "auto_timer",
          reason: "check CI",
          goalId: "goal-8",
        },
        expectedAudience: "internal",
      },
      {
        ev: {
          kind: "task.settled",
          taskId: "t-99",
          generation: 1,
          runId: "run-9",
          title: "Explore repo",
          status: "completed",
          summary: "Found files",
        },
        expectedAudience: "internal",
      },
      {
        ev: {
          kind: "session.message_received",
          messageId: "m-1",
          fromHost: "local",
          fromSessionId: "chat-2",
          body: "Ready for handoff",
          hopCount: 0,
        },
        expectedAudience: "human",
      },
    ];

    for (const { ev, expectedAudience } of controlEvents) {
      const fromDirect = classifyControlEvent(ev);
      assertNoRawEventLeak(fromDirect, ev.kind, `control:${ev.kind}`);
      assert.equal(fromDirect?.audience, expectedAudience, `control:${ev.kind} audience`);

      // Same classification via history replay path
      const fromReplay = classifyChatLine({
        source: "replay",
        turn: { content: ev.kind, event: ev, createdAt: Date.now() },
      });
      assertNoRawEventLeak(fromReplay, ev.kind, `replay:${ev.kind}`);
      assert.equal(fromReplay?.audience, expectedAudience, `replay:${ev.kind} audience`);
    }
  });

  it("enforces interim local attention policy for escalations and quota events", () => {
    // Agent-addressed escalation is dropped
    assert.equal(classifyAttentionAudience({ kind: "escalation", toTaskId: "t-1", severity: "P0", blocking: true }), "drop");
    // Human-addressed P0 or blocking -> human
    assert.equal(classifyAttentionAudience({ kind: "escalation", toTaskId: null, severity: "P0", blocking: false }), "human");
    assert.equal(classifyAttentionAudience({ kind: "escalation", toTaskId: null, severity: "P1", blocking: true }), "human");
    // Human-addressed non-blocking P1/P2 -> internal
    assert.equal(classifyAttentionAudience({ kind: "escalation", toTaskId: null, severity: "P1", blocking: false }), "internal");
    assert.equal(classifyAttentionAudience({ kind: "escalation", toTaskId: null, severity: "P2", blocking: false }), "internal");

    // Quota: manual pause -> human, automatic/other -> internal
    assert.equal(classifyAttentionAudience({ kind: "quota", eventType: "quota.run_paused", mode: "manual" }), "human");
    assert.equal(classifyAttentionAudience({ kind: "quota", eventType: "quota.run_paused", mode: "auto" }), "internal");
    assert.equal(classifyAttentionAudience({ kind: "quota", eventType: "quota.agent_paused", mode: "manual" }), "internal");
  });

  it("classifies plain system_notice turns (write_note internal, director resolution internal, interrupted turn single line)", () => {
    const writeNote = classifyChatLine({
      source: "replay",
      turn: { content: "Director write_note: saved scratch note", createdAt: Date.now() },
    });
    assert.equal(writeNote?.audience, "internal");

    const dirResolved = classifyChatLine({
      source: "replay",
      turn: { content: "Escalation esc-1 resolved by director: handled automatically", createdAt: Date.now() },
    });
    assert.equal(dirResolved?.audience, "internal");

    const userResolved = classifyChatLine({
      source: "replay",
      turn: { content: "Escalation esc-1 resolved by user: approved", createdAt: Date.now() },
    });
    assert.equal(userResolved?.audience, "human");

    const interrupted = classifyChatLine({
      source: "replay",
      turn: {
        content: "[harness] The daemon restarted while this turn was running. Tools in flight: a, b, c.",
        createdAt: Date.now(),
      },
    });
    assert.equal(interrupted?.audience, "human");
    assert.equal(interrupted?.text.includes("Tools in flight"), false);
  });
});

describe("goal-34 c4: runDirectorChatTui internal hiding, /internal toggle, and quiet cancels", () => {
  it("hides live goal.progress with empty payload by default and reveals buffered internal lines on /internal", async () => {
    const { terminal, writes, text, since, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-c4-internal");

    const mock = makeMockClient(async (op) => {
      if (op === "chat.open") {
        return {
          session,
          history: [
            {
              seq: 1,
              chatSessionId: session.id,
              role: "system_notice",
              content: "timer.fired",
              event: {
                kind: "timer.fired",
                timerId: "tm-9",
                wakeReason: "auto_timer",
                reason: "Background watchdog check",
                goalId: "goal-32",
              },
              createdAt: Date.now() - 5000,
            } satisfies ChatTurnRecord,
          ],
          historyNext: null,
          historyThrough: 1,
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          tookOver: false,
          busy: false,
        };
      }
      if (op === "work.snapshot") return emptyWorkSnapshot();
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-c4-internal"), 3000, "initial render");

    // Emit live goal.progress with no summary
    const writesBeforeProgress = writes.length;
    mock.emit({
      kind: "event",
      seq: 10,
      runId: "run-32",
      taskId: null,
      type: "goal.progress",
      createdAt: Date.now(),
      payload: { goalId: "goal-32" },
    });
    await new Promise((r) => setTimeout(r, 40));

    // Nothing rendered for goal.progress and neither replayed timer.fired nor raw event names appear
    assert.equal(since(writesBeforeProgress), "", "Live empty goal.progress must print nothing by default");
    assert.equal(text().includes("goal.progress"), false);
    assert.equal(text().includes("timer.fired"), false);
    assert.equal(text().includes("Background watchdog check"), false);

    // Flip `/internal` on -> buffered replayed + live internal lines appear dimmed with human text
    const writesBeforeToggle = writes.length;
    typeText("/internal");
    sendInput("\r");
    await waitFor(
      () =>
        since(writesBeforeToggle).includes("Internal lines: shown") &&
        since(writesBeforeToggle).includes("Progress update") &&
        since(writesBeforeToggle).includes("Background watchdog check"),
      3000,
      "/internal revealed buffered internal lines",
    );
    assert.equal(text().includes("goal.progress"), false, "Even when /internal is on, never show raw goal.progress");
    assert.equal(text().includes("timer.fired"), false, "Even when /internal is on, never show raw timer.fired");

    // Flip `/internal` off again
    const writesBeforeHide = writes.length;
    typeText("/internal");
    sendInput("\r");
    await waitFor(() => since(writesBeforeHide).includes("Internal lines: hidden"), 3000, "/internal hid lines again");

    sendInput("\x1d");
    await runPromise;
  });

  it("renders user-requested cancel as muted 'Stopped.' and hides unknown unrequested cancels without 'Turn cancelled.'", async () => {
    const { terminal, writes, text, since, sendInput, typeText } = makeFakeTerminal(120, 30);
    const session = makeChatSession("chat-c4-cancel");

    let sendIdx = 0;
    const sendResolvers: Array<() => void> = [];

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
        sendIdx += 1;
        await new Promise<void>((r) => sendResolvers.push(r));
        return { ok: true };
      }
      if (op === "chat.cancel") return { cancelled: true };
      if (op === "session.leave") return { daemonWillQuit: false };
      return {};
    });

    const runPromise = runDirectorChatTui({ client: mock.client, repoRoot: "/repo", terminal });
    await waitFor(() => text().includes("chat-c4-cancel"), 3000, "initial render");

    // Case 1: User-requested cancel via Esc Esc -> muted `Stopped.` (no `! [cancelled] Turn cancelled.`)
    typeText("First turn");
    sendInput("\r");
    await waitFor(() => sendIdx === 1, 3000, "turn 1 started");
    const turn1Id = String(mock.calls.filter((c) => c.op === "chat.send")[0]!.params.turnId);

    // Double Esc triggers onCancelActiveTurn -> chat.cancel
    sendInput("\x1b");
    sendInput("\x1b");
    await waitFor(() => mock.calls.some((c) => c.op === "chat.cancel"), 3000, "chat.cancel called");

    const markBeforeCancel1 = writes.length;
    mock.emit({
      kind: "event",
      seq: 1,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: turn1Id, cancelled: true, historyThrough: 1 },
    });
    sendResolvers[0]!();
    await waitFor(() => since(markBeforeCancel1).includes("Stopped."), 3000, "user cancel shows Stopped.");
    assert.equal(text().includes("Turn cancelled."), false, "Must never show 'Turn cancelled.'");

    // Case 2: Unrequested cancel with unknown cause -> internal (hidden by default)
    typeText("Second turn");
    sendInput("\r");
    await waitFor(() => sendIdx === 2, 3000, "turn 2 started");
    const turn2Id = String(mock.calls.filter((c) => c.op === "chat.send")[1]!.params.turnId);

    const markBeforeCancel2 = writes.length;
    mock.emit({
      kind: "event",
      seq: 2,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: turn2Id, cancelled: true, historyThrough: 2 },
    });
    sendResolvers[1]!();
    await waitFor(() => since(markBeforeCancel2).includes("Ready"), 3000, "turn 2 settled");

    assert.equal(since(markBeforeCancel2).includes("Turn cancelled."), false);
    assert.equal(since(markBeforeCancel2).includes("Turn ended before completion."), false, "Unknown cancel hidden by default");

    // Toggling `/internal` reveals the buffered internal cancel note
    const markBeforeInternal = writes.length;
    typeText("/internal");
    sendInput("\r");
    await waitFor(
      () => since(markBeforeInternal).includes("Turn ended before completion."),
      3000,
      "unrequested unknown cancel revealed via /internal",
    );

    // Toggle `/internal` back off and verify a known unrequested cancel (daemon draining) explains itself quietly
    typeText("/internal");
    sendInput("\r");
    await new Promise((r) => setTimeout(r, 30));

    typeText("Third turn");
    sendInput("\r");
    await waitFor(() => sendIdx === 3, 3000, "turn 3 started");
    const turn3Id = String(mock.calls.filter((c) => c.op === "chat.send")[2]!.params.turnId);

    const markBeforeRestartCancel = writes.length;
    mock.emit({
      kind: "event",
      seq: 3,
      runId: "",
      taskId: null,
      type: "daemon.reload",
      createdAt: Date.now(),
      payload: { phase: "draining", toReleaseId: "rel-next" },
    });
    mock.emit({
      kind: "event",
      seq: 4,
      runId: session.id,
      taskId: session.id,
      type: "chat.turn.end",
      createdAt: Date.now(),
      payload: { chatSessionId: session.id, turnId: turn3Id, cancelled: true, historyThrough: 3 },
    });
    sendResolvers[2]!();
    await waitFor(
      () => since(markBeforeRestartCancel).includes("Turn ended early: harnessd restarted."),
      3000,
      "known restart cancel explained quietly",
    );
    assert.equal(text().includes("Turn cancelled."), false, "Must never show 'Turn cancelled.'");

    sendInput("\x1d");
    await runPromise;
  });
});
