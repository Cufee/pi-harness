import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type {
  EscalationRecord,
  MergeQueueRecord,
  RunRecord,
  TaskRecord,
} from "../src/control-plane/db.js";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { GoalRecord } from "../src/goals/engine.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import {
  createTheme,
  fit,
  FixedDock,
  ImmutableTranscript,
  ModalScreen,
  stripTerminalSequences,
  visibleWidth,
} from "../src/tui/core/index.js";
import { WorkStore, type WorkSnapshot } from "../src/tui/store.js";

function makeFakeTerminal(cols = 100, rows = 30) {
  const writes: string[] = [];
  let onDataCb: ((data: string) => void) | null = null;
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
    write(data: string) {
      writes.push(data);
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

function makeMockClient(getSnapshot: () => WorkSnapshot) {
  let snapshotCalls = 0;
  const eventListeners = new Set<(ev: DaemonEventFrame) => void>();
  const client = {
    async request<T = unknown>(op: string): Promise<T> {
      if (op === "work.snapshot") {
        snapshotCalls++;
        return getSnapshot() as unknown as T;
      }
      return {} as T;
    },
    onEvent(fn: (ev: DaemonEventFrame) => void): () => void {
      eventListeners.add(fn);
      return () => eventListeners.delete(fn);
    },
    onClose(): () => void {
      return () => {};
    },
    close() {},
  } as unknown as DaemonClient;
  return {
    client,
    getSnapshotCalls: () => snapshotCalls,
    emit(ev: DaemonEventFrame) {
      for (const fn of eventListeners) fn(ev);
    },
  };
}

function makeRun(id: string, status: RunRecord["status"], goal = "Run goal"): RunRecord {
  const now = Date.now();
  return {
    id,
    goal,
    repoRoot: "/repo",
    baseBranch: "main",
    baseSha: "abc123",
    coordinationGroup: null,
    isolationMode: "standalone",
    status,
    createdAt: now - 30_000,
    updatedAt: now,
  };
}

function makeTask(
  id: string,
  runId: string,
  status: TaskRecord["status"],
  overrides: Partial<TaskRecord> = {},
): TaskRecord {
  const now = Date.now();
  return {
    id,
    runId,
    parentId: null,
    tier: 2,
    kind: "worker",
    title: `Task ${id}`,
    objective: "Do work",
    criteria: "",
    readOnly: false,
    profileId: "acp:codex",
    model: "openai/gpt-6.2-sol",
    effort: "medium",
    status,
    generation: 1,
    maxTurns: 40,
    turnsUsed: 3,
    contextUsed: 10_000,
    contextSize: 200_000,
    worktreeId: null,
    sessionId: null,
    summary: null,
    handoffJson: null,
    resultJson: null,
    createdAt: now - 20_000,
    updatedAt: now,
    ...overrides,
  };
}

function makeGoal(
  id: string,
  status: GoalRecord["status"],
  title: string,
  overrides: Partial<GoalRecord> = {},
): GoalRecord {
  const now = Date.now();
  return {
    id,
    chatSessionId: "chat-1",
    repoRoot: "/repo",
    version: 1,
    title,
    description: title,
    criteria: [],
    nonGoals: [],
    budgets: { maxReviewCycles: 4, maxNoProgressCycles: 2 },
    status,
    linkedRunId: null,
    reviewCycle: 0,
    noProgressStreak: 0,
    lastProgressFingerprint: null,
    lastReviewSummary: null,
    liveProgress: null,
    createdAt: now - 60_000,
    updatedAt: now,
    ...overrides,
  };
}

function makeEscalation(id: string, runId: string, status: EscalationRecord["status"] = "open"): EscalationRecord {
  const now = Date.now();
  return {
    id,
    runId,
    fromTaskId: "t-blocked",
    toTaskId: null,
    severity: "P0",
    category: "blocked_dependency",
    title: "Need schema sign-off",
    evidencePaths: [],
    attempted: [],
    suggestedSplits: [],
    blocking: true,
    status,
    resolution: null,
    createdAt: now - 10_000,
    ackedAt: null,
  };
}

function makeMerge(id: string, runId: string, status: MergeQueueRecord["status"]): MergeQueueRecord {
  const now = Date.now();
  return {
    id,
    runId,
    taskId: "t1",
    worktreeId: "wt-1",
    branch: `harness/${runId}/t1`,
    status,
    log: null,
    createdAt: now - 5_000,
    finishedAt: status === "merged" ? now : null,
  };
}

function makeBusySnapshot(): WorkSnapshot {
  const now = Date.now();
  const esc1 = makeEscalation("esc-1", "run-1", "open");
  const escResolved = makeEscalation("esc-2", "run-1", "resolved");

  const run1Tasks: TaskRecord[] = [
    makeTask("t-dir", "run-1", "running", { profileId: "director", title: "Director placeholder" }),
    makeTask("t-run1", "run-1", "running", { tier: 2, kind: "worker", title: "Implement HUD rows" }),
    makeTask("t-drain", "run-1", "draining", { tier: 2, kind: "worker", title: "Flush rollover" }),
    makeTask("t-wait", "run-1", "waiting_children", { tier: 1, kind: "orchestrator", title: "Coordinate HUD" }),
    makeTask("t-blk", "run-1", "blocked", { tier: 2, kind: "worker", title: "Migration blocked" }),
    makeTask("t-rescope", "run-1", "returned_for_rescope", { tier: 3, kind: "worker", title: "Split parser" }),
    makeTask("t-pending", "run-1", "pending", { tier: 3, kind: "verify", title: "Run visual checks" }),
    makeTask("t-ready", "run-1", "ready", { tier: 2, kind: "worker", title: "Wire status bar" }),
    makeTask("t-fail", "run-1", "failed", { tier: 3, kind: "verify", title: "Lint check" }),
    makeTask("t-done", "run-1", "completed", { tier: 2, kind: "research", title: "Inspect dock" }),
  ];

  // Quota-paused run with NO paused_quota task -> should still contribute +1 to `paused`
  const run2Tasks: TaskRecord[] = [
    makeTask("t-r2-done", "run-2", "completed", { title: "Prep patch" }),
  ];

  // Active run with explicit paused_quota task + running task
  const run3Tasks: TaskRecord[] = [
    makeTask("t-r3-run", "run-3", "running", { tier: 2, kind: "verify", title: "Run integration suite" }),
    makeTask("t-r3-paused", "run-3", "paused_quota", { tier: 2, kind: "worker", title: "Rate-limited worker" }),
  ];

  // Historical completed run with stale failed/queued tasks -> MUST NOT pollute live counts!
  const oldRunTasks: TaskRecord[] = [
    makeTask("t-old-fail", "run-old", "failed", { title: "Old failure" }),
    makeTask("t-old-queued", "run-old", "pending", { title: "Old pending" }),
    makeTask("t-old-blk", "run-old", "blocked", { title: "Old blocked" }),
  ];

  const goal1 = makeGoal("goal-1", "executing", "Live Status HUD", {
    linkedRunId: "run-1",
    liveProgress: { phase: "implementing", summary: "Updating FixedDock rows", updatedAt: now },
  });
  const goal2 = makeGoal("goal-2", "paused", "Quota Recovery", {
    linkedRunId: "run-2",
  });
  const goal3 = makeGoal("goal-3", "verifying", "Verify Theme Widths", {
    linkedRunId: "run-3",
  });
  const goalDone = makeGoal("goal-0", "achieved", "Earlier Goal", {
    linkedRunId: "run-old",
  });

  return {
    generatedAt: now,
    latestSeq: 42,
    goals: [
      { goal: goal1, reviews: [], revisions: [] },
      { goal: goal2, reviews: [], revisions: [] },
      { goal: goal3, reviews: [], revisions: [] },
      { goal: goalDone, reviews: [], revisions: [] },
    ],
    runs: [
      {
        run: makeRun("run-1", "active", "Live Status HUD"),
        goalId: "goal-1",
        tasks: run1Tasks,
        escalations: [esc1, escResolved],
        quotaPause: null,
        activity: {
          runId: "run-1",
          phase: "implementing",
          elapsedMs: 12_000,
          filesEdited: 2,
          openEscalations: 1,
          modelsUsed: ["openai/gpt-6.2-sol"],
          counts: { total: 9, running: 2, completed: 1, failed: 1, verifyRunning: 1, verifyCompleted: 0 },
          tasks: [
            {
              id: "t-run1",
              parentId: "t-wait",
              tier: 2,
              kind: "worker",
              title: "Implement HUD rows",
              status: "running",
              model: "openai/gpt-6.2-sol",
              effort: "medium",
              profileId: "acp:codex",
              generation: 1,
              currentAction: "⚙ edit_file",
              toolCalls: 5,
              filesEdited: 2,
              elapsedMs: 11_000,
              ctxPct: 12,
            },
          ],
        },
      },
      {
        run: makeRun("run-2", "paused_quota", "Quota Recovery"),
        goalId: "goal-2",
        tasks: run2Tasks,
        escalations: [],
        quotaPause: { mode: "auto", reason: "Codex 5h limit reached", resumeAt: now + 300_000 },
        activity: null,
      },
      {
        run: makeRun("run-3", "active", "Verify Theme Widths"),
        goalId: "goal-3",
        tasks: run3Tasks,
        escalations: [],
        quotaPause: null,
        activity: {
          runId: "run-3",
          phase: "verifying",
          elapsedMs: 5_000,
          filesEdited: 0,
          openEscalations: 0,
          modelsUsed: ["openai/gpt-6.2-sol"],
          counts: { total: 2, running: 1, completed: 0, failed: 0, verifyRunning: 1, verifyCompleted: 0 },
          tasks: [
            {
              id: "t-r3-run",
              parentId: null,
              tier: 2,
              kind: "verify",
              title: "Run integration suite",
              status: "running",
              model: "openai/gpt-6.2-sol",
              effort: "medium",
              profileId: "acp:codex",
              generation: 1,
              currentAction: "⚙ bun test",
              toolCalls: 2,
              filesEdited: 0,
              elapsedMs: 4_000,
              ctxPct: 8,
            },
          ],
        },
      },
      {
        run: makeRun("run-old", "completed", "Earlier Goal"),
        goalId: "goal-0",
        tasks: oldRunTasks,
        escalations: [],
        quotaPause: null,
        activity: null,
      },
    ],
    escalations: [esc1, escResolved],
    timers: [],
    merges: [
      makeMerge("m-1", "run-1", "queued"),
      makeMerge("m-2", "run-1", "conflict"),
      makeMerge("m-3", "run-old", "merged"),
    ],
    worktrees: [],
    messages: [],
    inbox: [
      {
        id: "inbox:esc:esc-1",
        severity: "P0",
        kind: "escalation",
        title: "[P0/blocked_dependency] Need schema sign-off",
        detail: "from t-blk in run-1 · blocking",
        ref: { kind: "escalation", id: "esc-1", runId: "run-1", goalId: "goal-1", label: "esc-1 Need schema sign-off" },
        goalId: "goal-1",
        runId: "run-1",
        taskId: "t-blk",
        createdAt: now - 10_000,
      },
      {
        id: "inbox:quota:run-2",
        severity: "P1",
        kind: "quota_paused",
        title: "run-2 paused for quota",
        detail: "Codex 5h limit reached",
        ref: { kind: "run", id: "run-2", goalId: "goal-2", label: "run-2" },
        goalId: "goal-2",
        runId: "run-2",
        createdAt: now - 5_000,
      },
    ],
  };
}

describe("Main Screen Status HUD", () => {
  it("buckets WorkStore agent counts accurately across all task states, quota-paused runs, escalations, and merges", async () => {
    const snap = makeBusySnapshot();
    const mock = makeMockClient(() => snap);
    const store = new WorkStore(mock.client, { chatSessionId: "chat-1", repoRoot: "/repo" });
    await store.refresh();

    const counts = store.getAgentCounts();
    assert.deepEqual(counts, {
      active: 3, // t-run1 (running) + t-drain (draining) + t-r3-run (running); director placeholder excluded
      waiting: 1, // t-wait (waiting_children)
      blocked: 2, // t-blk (blocked) + t-rescope (returned_for_rescope)
      paused: 2, // t-r3-paused (paused_quota) + run-2 (paused_quota run with 0 paused_quota tasks)
      queued: 2, // t-pending (pending) + t-ready (ready); oldRun stale pending excluded
      failed: 1, // t-fail on active run-1; oldRun stale failed excluded
      openEscalations: 1, // esc-1 open; esc-2 resolved excluded
      activeMerges: 2, // m-1 queued + m-2 conflict; m-3 merged excluded
      bouncedMerges: 1, // m-2 conflict
    });
    assert.equal(store.hasLiveWork(), true);

    const hud = store.buildLiveHud();
    assert.equal(hud.activeGoalsCount, 3);
    assert.equal(hud.slots[0]?.ref.id, "esc-1");
    assert.equal(hud.hudItems[0]?.slot, 1);
    assert.equal(hud.hudItems[0]?.id, "esc-1");
    assert.equal(hud.hudItems[1]?.slot, 2);
    assert.equal(hud.hudItems[1]?.id, "run-2");
    // Goal-1 and Goal-3 (distinct from quota-paused goal-2) appear ahead of duplicate goal-2
    assert.equal(hud.hudItems[2]?.id, "goal-1");
    assert.ok(hud.hudItems[2]?.activity?.includes("Esc P0: Need schema sign-off"));
    assert.equal(hud.hudItems[3]?.id, "goal-3");
    assert.ok(hud.hudItems[3]?.activity?.includes("Run integration suite"));
    assert.ok(hud.hudItems[3]?.activity?.includes("⚙ bun test"));

    store.dispose();
  });

  it("refreshes WorkStore automatically on goal.progress and task.status events and derives live goal progress & single-goal secondary detail", async () => {
    const now = Date.now();
    let currentSnap: WorkSnapshot = {
      generatedAt: now,
      latestSeq: 1,
      goals: [
        {
          goal: makeGoal("goal-7", "executing", "Ship Telemetry", {
            linkedRunId: "run-7",
            liveProgress: { phase: "implementing", summary: "Wiring agent counters", updatedAt: now },
          }),
          reviews: [],
          revisions: [],
        },
      ],
      runs: [
        {
          run: makeRun("run-7", "active", "Ship Telemetry"),
          goalId: "goal-7",
          tasks: [makeTask("t-7", "run-7", "running", { tier: 2, kind: "worker", title: "Edit dock.ts" })],
          escalations: [],
          quotaPause: null,
          activity: {
            runId: "run-7",
            phase: "implementing",
            elapsedMs: 4_000,
            filesEdited: 1,
            openEscalations: 0,
            modelsUsed: ["openai/gpt-6.2-sol"],
            counts: { total: 1, running: 1, completed: 0, failed: 0, verifyRunning: 0, verifyCompleted: 0 },
            tasks: [
              {
                id: "t-7",
                parentId: null,
                tier: 2,
                kind: "worker",
                title: "Edit dock.ts",
                status: "running",
                model: "openai/gpt-6.2-sol",
                effort: "medium",
                profileId: "acp:codex",
                generation: 1,
                currentAction: "⚙ edit_file",
                toolCalls: 3,
                filesEdited: 1,
                elapsedMs: 4_000,
                ctxPct: 5,
              },
            ],
          },
        },
      ],
      escalations: [],
      timers: [],
      merges: [],
      worktrees: [],
      messages: [],
      inbox: [],
    };

    const mock = makeMockClient(() => currentSnap);
    const store = new WorkStore(mock.client, { chatSessionId: "chat-1", repoRoot: "/repo" });
    await store.refresh();

    const firstHud = store.buildLiveHud();
    assert.equal(firstHud.hudItems.length, 1);
    assert.equal(firstHud.hudItems[0]?.activity, "implementing: Wiring agent counters");
    assert.ok(firstHud.hudSecondaryLine?.includes("T2/worker Edit dock.ts — ⚙ edit_file"));

    // Emit live goal.progress event -> must trigger debounced work.snapshot refresh automatically
    const callsBefore = mock.getSnapshotCalls();
    currentSnap = {
      ...currentSnap,
      goals: [
        {
          ...currentSnap.goals[0]!,
          goal: {
            ...currentSnap.goals[0]!.goal,
            status: "verifying",
            liveProgress: { phase: "verifying", summary: "Running bun test", updatedAt: Date.now() },
          },
        },
      ],
    };
    mock.emit({
      kind: "event",
      seq: 2,
      runId: "run-7",
      taskId: "t-7",
      type: "goal.progress",
      payload: { goalId: "goal-7", phase: "verifying", summary: "Running bun test" },
      createdAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(mock.getSnapshotCalls() > callsBefore, "goal.progress must trigger automatic debounced refresh");
    assert.equal(store.buildLiveHud().hudItems[0]?.activity, "verifying: Running bun test");

    // Emit task.status event -> must also trigger debounced refresh
    const callsBeforeTask = mock.getSnapshotCalls();
    mock.emit({
      kind: "event",
      seq: 3,
      runId: "run-7",
      taskId: "t-7",
      type: "task.status",
      payload: { status: "completed" },
      createdAt: Date.now(),
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(mock.getSnapshotCalls() > callsBeforeTask, "task.status must trigger automatic debounced refresh");

    store.dispose();
  });

  it("renders agent counts + live goal/activity HUD within exact widths (60, 100, 140) and preserves strict constant height with zero scrollback wipes", async () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes } = makeFakeTerminal(100, 30);
    const tui = new ModalScreen(terminal);

    const mock = makeMockClient(() => makeBusySnapshot());
    const store = new WorkStore(mock.client, { chatSessionId: "chat-1", repoRoot: "/repo" });

    const idleHud = store.buildLiveHud();
    const dock = new FixedDock(tui, theme, {
      onSubmit: () => {},
      initialState: {
        slots: idleHud.slots,
        agentCounts: idleHud.agentCounts,
        hudItems: idleHud.hudItems,
        hudSecondaryLine: idleHud.hudSecondaryLine,
        activeGoalsCount: idleHud.activeGoalsCount,
        idleBanner: "[pi-harness] · chat-1 · Director Chat",
        busy: false,
        phaseText: "Ready",
        rightStatus: "acp:codex · gpt-6.2",
        queuedCount: 0,
        hints: [
          { key: "Ctrl+G", label: "Work" },
          { key: "Ctrl+T", label: "Runs" },
        ],
      },
    });

    // 1. Idle state render check across 60, 100, 140 cols
    const idle100 = dock.render(100);
    const expectedHeight = idle100.length;
    assert.equal(expectedHeight, 9, "Standard dock height should be exactly 9 rows (1 rule + 2 HUD + 1 agents + 1 status + 3 composer + 1 hints)");
    assert.equal(dock.renderedHeight, expectedHeight);
    const idlePlain = idle100.map(stripTerminalSequences).join("\n");
    assert.ok(idlePlain.includes("Agents: 0 active"), "Idle state must show muted 0 active agents line");
    assert.ok(idlePlain.includes("Goals: no active goals"), "Idle state must show muted idle goals line");

    for (const w of [60, 100, 140]) {
      const lines = dock.render(w);
      assert.equal(lines.length, expectedHeight);
      assert.equal(dock.renderedHeight, lines.length);
      for (const l of lines) {
        assert.ok(visibleWidth(l) <= w, `Idle dock overflowed width ${w}: got ${visibleWidth(l)}`);
      }
    }

    // 2. Populate busy multi-goal / multi-agent snapshot & verify constant height + width safety
    await store.refresh();
    const busyHud = store.buildLiveHud();
    dock.update({
      slots: busyHud.slots,
      agentCounts: busyHud.agentCounts,
      hudItems: busyHud.hudItems,
      hudSecondaryLine: busyHud.hudSecondaryLine,
      activeGoalsCount: busyHud.activeGoalsCount,
      busy: true,
      phaseText: "Coordinating goals…",
      queuedCount: 2,
    });

    for (const w of [60, 100, 140]) {
      const lines = dock.render(w);
      assert.equal(lines.length, expectedHeight, `Active dock height must stay strictly constant at width ${w}`);
      assert.equal(dock.renderedHeight, lines.length);
      for (const l of lines) {
        assert.ok(visibleWidth(l) <= w, `Active dock overflowed width ${w}: got ${visibleWidth(l)}`);
      }
    }

    const busy140Plain = dock.render(140).map(stripTerminalSequences).join("\n");
    assert.ok(busy140Plain.includes("[Alt+1]"), "Must show Alt+1 quick-jump badge");
    assert.ok(busy140Plain.includes("[2]"), "Must show slot 2 badge");
    assert.ok(busy140Plain.includes("more (/goals)"), "Must show +N more (/goals) overflow indicator");
    assert.ok(busy140Plain.includes("3 active"), "Must show active count");
    assert.ok(busy140Plain.includes("1 waiting"), "Must show waiting count");
    assert.ok(busy140Plain.includes("2 blocked"), "Must show blocked count");
    assert.ok(busy140Plain.includes("2 paused"), "Must show paused count");
    assert.ok(busy140Plain.includes("2 queued"), "Must show queued count");
    assert.ok(busy140Plain.includes("1 failed"), "Must show failed count");
    assert.ok(busy140Plain.includes("1 esc"), "Must show open escalations count");
    assert.ok(busy140Plain.includes("2 merges"), "Must show active merges count");

    // Verify 60-col compact/micro rendering preserves counts without overflowing
    const busy60Plain = dock.render(60).map(stripTerminalSequences).join("\n");
    assert.ok(busy60Plain.includes("Agents:"), "Narrow 60-col agents row must still render Agents summary");
    assert.ok(busy60Plain.includes("(/goals)"), "Narrow 60-col HUD must preserve (/goals) overflow hint");

    // 3. Transient hint state keeps exact same height
    dock.update({ transientHint: "Press Esc again to stop active turn" });
    const hintLines = dock.render(100);
    assert.equal(hintLines.length, expectedHeight);
    assert.equal(dock.renderedHeight, expectedHeight);
    assert.ok(hintLines.map(stripTerminalSequences).join("\n").includes("Press Esc again"));

    // 4. Full ModalScreen transitions (idle -> busy -> transient hint -> idle) emit ZERO scrollback wipes (\x1b[3J)!
    const tr = new ImmutableTranscript(theme);
    for (let i = 0; i < 32; i++) tr.appendLines([`Transcript line ${i + 1}`]);
    tui.addChild(tr);
    tui.addChild(dock);
    tui.setFocus(dock.editor);
    dock.editor.floatAutocomplete = true;
    tui.setFloatingPopupProvider((w) => {
      const ac = dock.editor.getFloatingAutocompleteLines();
      return ac.length ? { lines: ac.map((l) => fit(l, w)), bottomOffset: dock.renderedHeight } : null;
    });
    tui.start();
    const doRender = () => (tui as unknown as { doRender: () => void }).doRender();
    doRender();
    writes.length = 0;

    // Transition back to idle
    dock.update({
      slots: [],
      agentCounts: idleHud.agentCounts,
      hudItems: [],
      hudSecondaryLine: null,
      activeGoalsCount: 0,
      busy: false,
      phaseText: "Ready",
      transientHint: null,
      queuedCount: 0,
    });
    const linesIdleScreen = tui.render(100).length;
    doRender();

    // Transition to busy multi-goal state
    dock.update({
      slots: busyHud.slots,
      agentCounts: busyHud.agentCounts,
      hudItems: busyHud.hudItems,
      hudSecondaryLine: busyHud.hudSecondaryLine,
      activeGoalsCount: busyHud.activeGoalsCount,
      busy: true,
      phaseText: "Running…",
    });
    const linesBusyScreen = tui.render(100).length;
    doRender();

    assert.equal(linesBusyScreen, linesIdleScreen, "Total rendered line count must NOT shift between idle and active HUD states");
    assert.equal(
      writes.filter((w) => w.includes("\x1b[3J")).length,
      0,
      "HUD state transitions must emit 0 terminal scrollback wipes (\\x1b[3J)",
    );
    tui.stop();

    // 5. Ultra-short terminal (< 18 rows) collapses to 1 HUD row (8 rows total) and remains strictly constant
    const { terminal: shortTerm } = makeFakeTerminal(80, 15);
    const shortTui = new ModalScreen(shortTerm);
    const shortDock = new FixedDock(shortTui, theme, {
      onSubmit: () => {},
      initialState: {
        slots: [],
        agentCounts: idleHud.agentCounts,
        hudItems: [],
        idleBanner: "Ready",
        busy: false,
        phaseText: "Ready",
        rightStatus: "codex",
        queuedCount: 0,
        hints: [{ key: "Ctrl+G", label: "Work" }],
      },
    });
    const shortIdleH = shortDock.render(80).length;
    assert.equal(shortIdleH, 8, "Ultra-short terminal (<18 rows) should collapse HUD to 1 row (8 rows total)");
    assert.equal(shortDock.renderedHeight, 8);

    shortDock.update({
      slots: busyHud.slots,
      agentCounts: busyHud.agentCounts,
      hudItems: busyHud.hudItems,
      activeGoalsCount: busyHud.activeGoalsCount,
      busy: true,
      phaseText: "Working…",
    });
    const shortBusyLines = shortDock.render(80);
    assert.equal(shortBusyLines.length, shortIdleH, "Ultra-short dock height must stay constant across idle -> active");
    assert.equal(shortDock.renderedHeight, shortIdleH);
    assert.ok(shortBusyLines.map(stripTerminalSequences).join("\n").includes("more (/goals)"));

    store.dispose();
  });
});
