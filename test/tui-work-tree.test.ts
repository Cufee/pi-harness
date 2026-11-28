import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type { EscalationRecord, RunRecord, TaskRecord } from "../src/control-plane/db.js";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { GoalRecord } from "../src/goals/engine.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import {
  createTheme,
  FixedDock,
  ModalScreen,
  Navigator,
  stripTerminalSequences,
  visibleWidth,
} from "../src/tui/core/index.js";
import { GoalInspectorScreen } from "../src/tui/inspectors.js";
import { type SnapshotRunEntry, WorkStore, type WorkSnapshot, type WorkTreeNode } from "../src/tui/store.js";
import { WorkTreeScreen } from "../src/tui/work-tree.js";

const NOW = Date.now();

function makeTerminal(cols = 120, rows = 30): Terminal {
  return {
    columns: cols,
    rows,
    kittyProtocolActive: false,
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
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
}

function makeClient(getSnapshot: () => WorkSnapshot) {
  const listeners = new Set<(ev: DaemonEventFrame) => void>();
  let snapshotCalls = 0;
  const client = {
    async request<T>(op: string): Promise<T> {
      if (op === "work.snapshot") {
        snapshotCalls++;
        return getSnapshot() as unknown as T;
      }
      return {} as T;
    },
    onEvent(fn: (ev: DaemonEventFrame) => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onClose: () => () => {},
    close() {},
  } as unknown as DaemonClient;
  return {
    client,
    snapshotCalls: () => snapshotCalls,
    emit: (ev: DaemonEventFrame) => {
      for (const fn of listeners) fn(ev);
    },
  };
}

function task(id: string, runId: string, status: TaskRecord["status"], o: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id,
    runId,
    parentId: null,
    tier: 3,
    kind: "execute",
    title: `Task ${id}`,
    objective: "",
    criteria: "",
    readOnly: false,
    profileId: "acp:codex",
    model: null,
    effort: null,
    status,
    generation: 1,
    maxTurns: 40,
    turnsUsed: 1,
    contextUsed: 0,
    contextSize: 200_000,
    worktreeId: null,
    sessionId: null,
    summary: null,
    handoffJson: null,
    resultJson: null,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 1_000,
    ...o,
  };
}

function goal(id: string, status: GoalRecord["status"], o: Partial<GoalRecord> = {}): GoalRecord {
  return {
    id,
    chatSessionId: "chat-1",
    repoRoot: "/repo",
    version: 1,
    title: `Goal ${id}`,
    description: "",
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
    createdAt: NOW - 120_000,
    updatedAt: NOW - 10_000,
    ...o,
  } as GoalRecord;
}

function runEntry(id: string, status: RunRecord["status"], goalId: string | null, tasks: TaskRecord[], o: Partial<SnapshotRunEntry> = {}): SnapshotRunEntry {
  return {
    run: {
      id,
      goal: `Run ${id} objective\nsecond line`,
      repoRoot: "/repo",
      baseBranch: "main",
      baseSha: "abc",
      coordinationGroup: null,
      isolationMode: "standalone",
      status,
      createdAt: NOW - 100_000,
      updatedAt: NOW - 20_000,
    },
    goalId,
    tasks,
    escalations: [],
    quotaPause: null,
    activity: null,
    ...o,
  };
}

function humanEscalation(runId: string, o: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: "esc-1",
    runId,
    fromTaskId: "c-t1",
    toTaskId: null,
    severity: "P1",
    category: "ambiguous_spec",
    title: "Which auth provider?",
    evidencePaths: [],
    attempted: [],
    suggestedSplits: [],
    blocking: true,
    status: "open",
    resolution: null,
    createdAt: NOW - 5_000,
    ackedAt: null,
    ...o,
  } as EscalationRecord;
}

function emptySnapshot(): WorkSnapshot {
  return {
    generatedAt: NOW,
    latestSeq: 1,
    goals: [],
    runs: [],
    escalations: [],
    timers: [],
    merges: [],
    worktrees: [],
    messages: [],
    inbox: [],
    internalAttention: [],
  };
}

/**
 * goal-a executing: a Tier 1 lead runs with a Tier 3 child directly under it (no Tier 2 in between),
 *   a blocked Tier 2 child with a queued grandchild, a finished verify child, and a director placeholder
 *   whose running child must move up to the run's top level. An older run of goal-a still lists a running task.
 * goal-b awaiting_human with no run. goal-c executing whose run has an open blocking escalation and only
 *   finished tasks. goal-d achieved. goal-e draft. run-x has no goal and is quota-paused.
 */
function fixture(): WorkSnapshot {
  const snap: WorkSnapshot = {
    ...emptySnapshot(),
    goals: [
      { goal: goal("goal-a", "executing", { linkedRunId: "run-a", updatedAt: NOW - 1_000 }), reviews: [], revisions: [] },
      { goal: goal("goal-b", "awaiting_human", { lastReviewSummary: "Pick a database", updatedAt: NOW - 3_000 }), reviews: [], revisions: [] },
      { goal: goal("goal-c", "executing", { linkedRunId: "run-c", updatedAt: NOW - 50_000 }), reviews: [], revisions: [] },
      { goal: goal("goal-d", "achieved", { linkedRunId: "run-d" }), reviews: [], revisions: [] },
      { goal: goal("goal-e", "draft"), reviews: [], revisions: [] },
    ],
    runs: [
      runEntry(
        "run-a",
        "active",
        "goal-a",
        [
          task("a-lead", "run-a", "running", { tier: 1, kind: "orchestrator", title: "Lead", model: "claude-opus" }),
          task("a-exec", "run-a", "running", { parentId: "a-lead", title: "Write parser", updatedAt: NOW - 2_000 }),
          task("a-verify", "run-a", "completed", { parentId: "a-lead", kind: "verify", title: "Old check" }),
          task("a-worker", "run-a", "blocked", { parentId: "a-lead", tier: 2, kind: "worker", title: "Migrate DB", summary: "schema lock held" }),
          task("a-queued", "run-a", "pending", { parentId: "a-worker", title: "Queued follow-up" }),
          task("a-dir", "run-a", "running", { tier: 1, profileId: "director", title: "Director placeholder" }),
          task("a-side", "run-a", "running", { parentId: "a-dir", tier: 3, kind: "research", title: "Side research" }),
        ],
        {
          activity: {
            runId: "run-a",
            phase: "implementing",
            elapsedMs: 0,
            filesEdited: 0,
            openEscalations: 0,
            modelsUsed: [],
            counts: { total: 0, running: 0, completed: 0, failed: 0, verifyRunning: 0, verifyCompleted: 0 },
            tasks: [
              {
                id: "a-exec",
                parentId: "a-lead",
                tier: 3,
                kind: "execute",
                title: "Write parser",
                status: "running",
                model: null,
                effort: null,
                profileId: "acp:codex",
                generation: 1,
                currentAction: "edit_file src/parser.ts",
                toolCalls: 3,
                filesEdited: 1,
                elapsedMs: 1_000,
                ctxPct: 5,
              },
            ],
          },
        },
      ),
      runEntry("run-a-old", "stopped", "goal-a", [task("old-t", "run-a-old", "running", { title: "Stale old-run task" })]),
      runEntry("run-c", "active", "goal-c", [task("c-t1", "run-c", "completed", { title: "Done step" })], {
        escalations: [humanEscalation("run-c")],
      }),
      runEntry("run-d", "completed", "goal-d", [task("d-t1", "run-d", "completed", { title: "Shipped step" })]),
      runEntry("run-x", "active", null, [task("x-t1", "run-x", "paused_quota", { title: "Rate-limited" })], {
        quotaPause: { mode: "auto", reason: "5h limit", resumeAt: NOW + 60_000 },
      }),
    ],
  };
  // Blockers sort newest first: goal-b (3s ago), then run-x (15s), then goal-c (its run, 20s).
  snap.runs.find((r) => r.run.id === "run-x")!.run.updatedAt = NOW - 15_000;
  return snap;
}

/** Renders a tree as `kind:id` lines indented two spaces per level, for whole-shape assertions. */
function shape(nodes: WorkTreeNode[], depth = 0): string[] {
  return nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.id} ${n.state}`, ...shape(n.children, depth + 1)]);
}

async function loadedStore(snap: WorkSnapshot) {
  const mock = makeClient(() => snap);
  const store = new WorkStore(mock.client, { chatSessionId: "chat-1", repoRoot: "/repo" });
  await store.refresh();
  return { store, mock };
}

describe("goal/agent work tree", () => {
  it("shows only active and blocked work by default, nests agents by parent at any tier, and puts blockers first", async () => {
    const { store } = await loadedStore(fixture());

    assert.deepEqual(shape(store.buildWorkTree()), [
      "goal-b blocked",
      "run-x blocked",
      "  x-t1 blocked",
      "goal-c blocked",
      "goal-a active",
      "  a-lead active",
      "    a-worker blocked",
      "    a-exec active",
      "  a-side active",
    ]);

    const byId = new Map<string, WorkTreeNode>();
    const index = (nodes: WorkTreeNode[]) => nodes.forEach((n) => (byId.set(n.id, n), index(n.children)));
    index(store.buildWorkTree());
    assert.equal(byId.get("goal-b")!.activity, "needs your input: Pick a database");
    assert.equal(byId.get("goal-c")!.activity, "needs your input: Which auth provider?");
    assert.equal(byId.get("goal-c")!.status, "blocked");
    assert.equal(byId.get("run-x")!.title, "Run run-x objective");
    assert.equal(byId.get("a-exec")!.activity, "edit_file src/parser.ts");
    assert.equal(byId.get("a-exec")!.agent, "T3/execute");
    assert.equal(byId.get("a-lead")!.agent, "T1/orchestrator · claude-opus");
    assert.equal(byId.get("a-worker")!.activity, "blocked: schema lock held");

    assert.deepEqual(
      { ...store.workSummary(), firstBlocked: store.workSummary().firstBlocked?.id },
      { active: 3, blocked: 5, firstBlocked: "goal-b" },
    );
    store.dispose();
  });

  it("shows finished, queued, and draft work with all, and never shows a goal's superseded runs", async () => {
    const { store } = await loadedStore(fixture());
    const all = shape(store.buildWorkTree({ all: true }));
    for (const line of ["goal-d done", "  d-t1 done", "goal-e queued", "    a-verify done", "      a-queued queued", "  c-t1 done"]) {
      assert.ok(all.includes(line), `missing ${JSON.stringify(line)} in\n${all.join("\n")}`);
    }
    assert.equal(all.some((l) => l.includes("old-t") || l.includes("run-a-old")), false);
    store.dispose();
  });

  it("ignores resolved and non-blocking P2 escalations when deciding whether a goal is blocked", async () => {
    const snap = fixture();
    const runC = snap.runs.find((r) => r.run.id === "run-c")!;
    runC.escalations = [
      humanEscalation("run-c", { id: "esc-r", status: "resolved" }),
      humanEscalation("run-c", { id: "esc-p2", severity: "P2", blocking: false }),
    ];
    const { store } = await loadedStore(snap);
    const goalC = store.buildWorkTree().find((n) => n.id === "goal-c");
    assert.equal(goalC?.state, "active");
    assert.equal(goalC?.status, "executing");
    assert.deepEqual(goalC?.children, []);
    store.dispose();
  });

  it("renders the tree in one screen, toggles all with 'a', and opens the goal inspector on Enter", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const terminal = makeTerminal();
    const nav = new Navigator(new ModalScreen(terminal), terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };
    const { store } = await loadedStore(fixture());
    const screen = new WorkTreeScreen({ client: makeClient(fixture).client, store, repoRoot: "/repo" });
    nav.push(screen);

    const text = () => screen.render(120, 28, theme).map(stripTerminalSequences).join("\n");
    const first = text();
    assert.ok(first.includes("Active + blocked · 3 active · 5 blocked"), first);
    assert.match(first, /goal-a Goal goal-a/);
    assert.match(first, /├─ a-worker Migrate DB/);
    assert.match(first, /│  └─ a-exec Write parser/);
    assert.match(first, /└─ a-side Side research/);
    assert.equal(first.includes("goal-d"), false);
    assert.equal(first.includes("Escalation"), false);

    screen.handleInput("a", ctx);
    const all = text();
    assert.ok(all.includes("All work"), all);
    assert.ok(all.includes("goal-d"), all);

    screen.handleInput("a", ctx);
    screen.handleInput("\r", ctx);
    assert.ok(nav.current instanceof GoalInspectorScreen, "Enter on the first row (goal-b) opens its goal inspector");
    assert.equal((nav.current as GoalInspectorScreen).title, "goal-b");
    store.dispose();
  });

  it("refreshes the tree when a task changes status", async () => {
    let snap = emptySnapshot();
    const mock = makeClient(() => snap);
    const store = new WorkStore(mock.client, { chatSessionId: "chat-1" });
    await store.refresh();
    assert.deepEqual(store.buildWorkTree(), []);

    snap = fixture();
    mock.emit({ type: "task.status", runId: "run-a", taskId: "a-exec", payload: { to: "running" }, ts: NOW } as unknown as DaemonEventFrame);
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(mock.snapshotCalls() >= 2);
    assert.equal(store.buildWorkTree()[0]?.id, "goal-b");
    store.dispose();
  });
});

describe("dock work row", () => {
  const theme = createTheme({ color: false, ascii: false });
  const makeDock = (work?: { active: number; blocked: number; blockedLabel?: string | null }) => {
    const tui = { requestRender() {}, terminal: { rows: 30 }, render: () => [], invalidate() {} };
    return new FixedDock(tui as never, theme, {
      onSubmit: () => {},
      initialState: {
        idleBanner: "Ready — describe what you want built",
        work,
        busy: false,
        phaseText: "Ready",
        rightStatus: "codex · gpt",
        queuedCount: 0,
        hints: [{ key: "Ctrl+G", label: "Work" }],
      },
    });
  };

  it("keeps a constant 7-row height and fits every width with one work row", () => {
    for (const work of [undefined, { active: 2, blocked: 1, blockedLabel: "goal-b needs your input: Pick a database" }]) {
      for (const width of [40, 60, 100, 140]) {
        const lines = makeDock(work).render(width);
        assert.equal(lines.length, 7, `height at ${width}`);
        for (const l of lines) assert.ok(visibleWidth(l) <= width, `overflow at ${width}: ${stripTerminalSequences(l)}`);
      }
    }
  });

  it("shows the idle banner when nothing is active or blocked, and names the first blocker otherwise", () => {
    const idle = stripTerminalSequences(makeDock({ active: 0, blocked: 0 }).render(120)[1]!);
    assert.ok(idle.includes("Ready — describe what you want built"), idle);
    assert.ok(idle.includes("Ctrl+G work"), idle);

    const busy = stripTerminalSequences(makeDock({ active: 2, blocked: 1, blockedLabel: "goal-b needs your input: Pick a database" }).render(120)[1]!);
    assert.ok(busy.includes("Work: ● 2 active · ! 1 blocked · goal-b needs your input: Pick a database"), busy);
  });
});
