import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { EscalationRecord, EventRecord, RunRecord, TaskRecord } from "../src/control-plane/db.js";
import { createTheme } from "../src/tui/primitives/index.js";
import {
  buildRunsTreeRows,
  RunsTreeOverlay,
  type RunsTreeEntry,
  type RunsTreesResult,
  type WatchEventFrame,
} from "../src/tui/runs-tree.js";
import { AgentTranscriptOverlay, renderTranscriptLines, type TranscriptEvent } from "../src/tui/transcript-overlay.js";

const theme = createTheme();
const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const KEY = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", enter: "\r", esc: "\x1b", tab: "\t" };

function run(id: string, status: RunRecord["status"], updatedAt: number, goal: string): RunRecord {
  return {
    id,
    goal,
    repoRoot: "/repo",
    baseBranch: "main",
    baseSha: "abc",
    coordinationGroup: null,
    isolationMode: "standalone",
    status,
    createdAt: updatedAt - HOUR,
    updatedAt,
  };
}

function task(
  id: string,
  runId: string,
  p: Partial<TaskRecord> & Pick<TaskRecord, "tier" | "kind" | "status" | "createdAt" | "updatedAt">,
): TaskRecord {
  return {
    id,
    runId,
    parentId: null,
    title: `title ${id}`,
    objective: "",
    criteria: "",
    readOnly: false,
    profileId: "acp:amp",
    model: null,
    effort: null,
    generation: 1,
    maxTurns: 10,
    turnsUsed: 0,
    contextUsed: 0,
    contextSize: 0,
    worktreeId: null,
    sessionId: null,
    summary: null,
    handoffJson: null,
    resultJson: null,
    ...p,
  };
}

function escalation(id: string, runId: string, fromTaskId: string): EscalationRecord {
  return {
    id,
    runId,
    fromTaskId,
    toTaskId: null,
    severity: "P1",
    category: "broken_test",
    title: "tests broken",
    evidencePaths: [],
    attempted: [],
    suggestedSplits: [],
    blocking: false,
    status: "open",
    resolution: null,
    createdAt: NOW - 3 * DAY,
    ackedAt: null,
  };
}

const OLD = NOW - 3 * DAY;

function fixture(): RunsTreesResult {
  const a: RunsTreeEntry = {
    run: run("run-a", "active", NOW - 5 * 60_000, "Rework runs overlay"),
    tasks: [
      // Deliberately shuffled so DFS ordering must come from parentId/createdAt, not input order.
      task("t-rev", "run-a", { tier: 3, kind: "verify", status: "running", parentId: "t-orch", createdAt: 5, updatedAt: NOW, title: "Done-Review: Runs (cycle 1)" }),
      task("t-r1", "run-a", { tier: 3, kind: "research", status: "completed", parentId: "t-w1", createdAt: 4, updatedAt: NOW - HOUR }),
      task("t-orch", "run-a", { tier: 1, kind: "orchestrator", status: "running", createdAt: 1, updatedAt: NOW, model: "claude-opus", contextUsed: 50, contextSize: 200 }),
      task("t-orphan", "run-a", { tier: 2, kind: "worker", status: "running", parentId: "t-gone", createdAt: 6, updatedAt: NOW }),
      task("t-w2", "run-a", { tier: 2, kind: "worker", status: "completed", parentId: "t-orch", createdAt: 3, updatedAt: OLD }),
      task("t-w1", "run-a", { tier: 2, kind: "worker", status: "running", parentId: "t-orch", createdAt: 2, updatedAt: NOW }),
    ],
    escalations: [],
    quotaPause: null,
  };
  const b: RunsTreeEntry = {
    run: run("run-b", "failed", NOW - HOUR, "Billing export"),
    tasks: [task("t-b1", "run-b", { tier: 1, kind: "orchestrator", status: "failed", createdAt: 1, updatedAt: NOW - HOUR })],
    escalations: [],
    quotaPause: null,
  };
  const c: RunsTreeEntry = {
    run: run("run-c", "completed", OLD, "Old completed thing"),
    tasks: [task("t-c1", "run-c", { tier: 1, kind: "orchestrator", status: "completed", createdAt: 1, updatedAt: OLD })],
    escalations: [],
    quotaPause: null,
  };
  const d: RunsTreeEntry = {
    run: run("run-d", "completed", OLD, "Old run with open escalation"),
    tasks: [
      task("t-d1", "run-d", { tier: 1, kind: "orchestrator", status: "completed", createdAt: 1, updatedAt: OLD }),
      task("t-d2", "run-d", { tier: 2, kind: "worker", status: "completed", parentId: "t-d1", createdAt: 2, updatedAt: OLD }),
    ],
    escalations: [escalation("e-1", "run-d", "t-d2")],
    quotaPause: null,
  };
  return { generatedAt: NOW, runs: [a, b, c, d] };
}

const build = (filter: Parameters<typeof buildRunsTreeRows>[1]["filter"], query = "", collapsed = new Set<string>()) =>
  buildRunsTreeRows(fixture(), { filter, query, collapsed, now: NOW });

const runIds = (r: ReturnType<typeof build>) => r.rows.filter((x) => x.kind === "run").map((x) => x.runId);
const taskIds = (r: ReturnType<typeof build>) => r.rows.filter((x) => x.kind === "task").map((x) => x.task!.id);

describe("buildRunsTreeRows filters + search", () => {
  test("default running_recent hides old completed runs, shows running and recently failed", () => {
    const r = build("running_recent");
    expect(runIds(r)).toEqual(["run-a", "run-b"]);
    expect(r.matched).toBe(2);
    expect(r.hidden).toBe(2);
    // Old completed worker inside an active run is hidden; recent completed T3 is kept.
    expect(taskIds(r)).not.toContain("t-w2");
    expect(taskIds(r)).toContain("t-r1");
  });

  test("running shows only active runs/agents", () => {
    const r = build("running");
    expect(runIds(r)).toEqual(["run-a"]);
    expect(r.hidden).toBe(3);
    expect(taskIds(r)).toEqual(["t-orch", "t-w1", "t-rev", "t-orphan"]);
  });

  test("failed includes failed runs and tasks with open escalations (with ancestors)", () => {
    const r = build("failed");
    expect(runIds(r)).toEqual(["run-b", "run-d"]);
    expect(r.matched).toBe(2);
    expect(r.hidden).toBe(2);
    expect(taskIds(r)).toEqual(["t-b1", "t-d1", "t-d2"]);
    expect(r.rows.find((x) => x.task?.id === "t-d2")!.openEscalations).toBe(1);
    expect(r.rows.find((x) => x.task?.id === "t-d1")!.openEscalations).toBe(0);
  });

  test("failed also surfaces returned_for_rescope tasks and runs with only run-level escalations", () => {
    const t = fixture();
    t.runs[2]!.tasks[0]!.status = "returned_for_rescope";
    t.runs[0]!.escalations.push(escalation("e-run", "run-a", "t-not-in-run"));
    const r = buildRunsTreeRows(t, { filter: "failed", query: "", collapsed: new Set(), now: NOW });
    expect(runIds(r as ReturnType<typeof build>)).toEqual(["run-a", "run-b", "run-c", "run-d"]);
    expect(r.rows.find((x) => x.runId === "run-a")!.openEscalations).toBe(1);
  });

  test("all shows everything", () => {
    const r = build("all");
    expect(r.matched).toBe(4);
    expect(r.hidden).toBe(0);
  });

  test("search matches task title (keeping ancestors) and run goal", () => {
    const byTitle = build("all", "done-review");
    expect(runIds(byTitle)).toEqual(["run-a"]);
    expect(taskIds(byTitle)).toEqual(["t-orch", "t-rev"]);
    expect(byTitle.hidden).toBe(3);

    const byGoal = build("all", "BILLING");
    expect(runIds(byGoal)).toEqual(["run-b"]);
    expect(taskIds(byGoal)).toEqual(["t-b1"]);

    const byModel = build("all", "claude-opus");
    expect(taskIds(byModel)).toEqual(["t-orch"]);

    // Search is applied on top of the filter: run-c only exists under "all".
    expect(build("running_recent", "old completed").matched).toBe(0);
    expect(build("all", "old completed").matched).toBe(1);
  });
});

describe("buildRunsTreeRows hierarchy", () => {
  test("DFS order and connectors for T1/T2/T3 + reviewer + orphan", () => {
    const r = build("all");
    const a = r.rows.filter((x) => x.runId === "run-a");
    expect(a.map((x) => [x.task?.id ?? x.runId, x.connector])).toEqual([
      ["run-a", ""],
      ["t-orch", "├─ "],
      ["t-w1", "│  ├─ "],
      ["t-r1", "│  │  └─ "],
      ["t-w2", "│  ├─ "],
      ["t-rev", "│  └─ "],
      ["t-orphan", "└─ "],
    ]);
  });

  test("collapse hides a run's tasks only", () => {
    const r = build("all", "", new Set(["run-a"]));
    expect(r.rows.filter((x) => x.runId === "run-a").length).toBe(1);
    expect(r.rows.find((x) => x.runId === "run-a")!.collapsed).toBe(true);
    expect(taskIds(r)).toContain("t-b1");
  });
});

function makeOverlay(trees: () => RunsTreesResult = fixture) {
  const calls = {
    open: [] as Array<{ runId: string; taskId: string; title: string }>,
    actions: [] as Array<[string, string]>,
    closed: 0,
    stopped: 0,
    fetches: 0,
    emit: null as null | ((ev: WatchEventFrame) => void),
  };
  const overlay = new RunsTreeOverlay({
    theme,
    fetchTrees: async () => {
      calls.fetches++;
      return trees();
    },
    subscribe: async (onEvent) => {
      calls.emit = onEvent;
      return () => {
        calls.stopped++;
      };
    },
    onOpenTranscript: (row) => calls.open.push(row),
    onAction: (a, runId) => calls.actions.push([a, runId]),
    onClose: () => calls.closed++,
    requestRender: () => {},
    now: () => NOW,
    viewportRows: 30,
    refetchDebounceMs: 10,
  });
  return { overlay, calls };
}

describe("RunsTreeOverlay", () => {
  test("renders tier badges, reviewer label, counts and is width-safe", async () => {
    const { overlay } = makeOverlay();
    await tick();
    overlay.handleInput("4");
    const lines = overlay.render(120).map(strip);
    expect(lines.some((l) => l.includes("4 matched · 0 hidden"))).toBe(true);
    const rev = lines.find((l) => l.includes("t-rev"))!;
    expect(rev).toContain("Reviewer");
    expect(rev).not.toContain("T3");
    expect(lines.find((l) => l.includes("t-r1"))).toContain("T3");
    expect(lines.find((l) => l.includes("t-orch"))).toContain("25%");
    expect(lines.find((l) => l.includes("t-d2"))).toContain("⚑1");
    for (const w of [10, 40, 80]) {
      for (const l of overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
    }
  });

  test("Enter on agent row opens transcript with ids; r/w/x on task row target owning run", async () => {
    const { overlay, calls } = makeOverlay();
    await tick();
    // running_recent rows: run-a, t-orch, t-w1, ...
    overlay.handleInput(KEY.down);
    overlay.handleInput(KEY.down);
    expect(overlay.state.selectedKey).toBe("run-a/t-w1");
    overlay.handleInput(KEY.enter);
    expect(calls.open).toEqual([{ runId: "run-a", taskId: "t-w1", title: "title t-w1" }]);
    overlay.handleInput("r");
    overlay.handleInput("w");
    overlay.handleInput("x");
    expect(calls.actions).toEqual([
      ["resume", "run-a"],
      ["wait", "run-a"],
      ["stop", "run-a"],
    ]);
    expect(calls.closed).toBe(0);
  });

  test("filter cycling, search mode, and Esc clears search before closing", async () => {
    const { overlay, calls } = makeOverlay();
    await tick();
    expect(overlay.state.filter).toBe("running_recent");
    overlay.handleInput(KEY.tab);
    expect(overlay.state.filter).toBe("running");
    overlay.handleInput("f");
    expect(overlay.state.filter).toBe("failed");
    overlay.handleInput("4");
    overlay.handleInput("/");
    for (const ch of "billing") overlay.handleInput(ch);
    // Keys like r/x are search text while searching, not actions.
    expect(calls.actions).toEqual([]);
    expect(overlay.render(100).map(strip).some((l) => l.includes("1 matched · 3 hidden"))).toBe(true);
    overlay.handleInput(KEY.enter);
    expect(overlay.state.searching).toBe(false);
    expect(overlay.state.query).toBe("billing");
    overlay.handleInput(KEY.esc);
    expect(overlay.state.query).toBe("");
    expect(calls.closed).toBe(0);
    overlay.handleInput(KEY.esc);
    expect(calls.closed).toBe(1);
    expect(calls.stopped).toBe(1);
  });

  test("collapse via Left on a task row folds the owning run and selects it", async () => {
    const { overlay } = makeOverlay();
    await tick();
    overlay.handleInput(KEY.down);
    overlay.handleInput(KEY.left);
    expect(overlay.state.collapsed).toEqual(["run-a"]);
    expect(overlay.state.selectedKey).toBe("run-a");
    expect(overlay.render(100).map(strip).some((l) => l.includes("t-orch"))).toBe(false);
    overlay.handleInput(KEY.right);
    expect(overlay.state.collapsed).toEqual([]);
    overlay.handleInput(" ");
    expect(overlay.state.collapsed).toEqual(["run-a"]);
  });

  test("quota-paused run shows resume countdown on run and paused task rows", async () => {
    const { overlay } = makeOverlay(() => {
      const t = fixture();
      t.runs[0]!.run.status = "paused_quota";
      t.runs[0]!.tasks.find((x) => x.id === "t-w1")!.status = "paused_quota";
      const resumeAt = new Date(Date.now() + 42 * 60_000 + 5_000).toISOString();
      t.runs[0]!.quotaPause = { runId: "run-a", pausedTaskIds: ["t-w1"], mode: "auto_timer", source: "passive_reset", resumeAt, reason: "429", pausedAt: NOW };
      return t;
    });
    await tick();
    const lines = overlay.render(160).map(strip);
    expect(lines.find((l) => l.includes("run-a"))).toContain("resume in 43m");
    expect(lines.find((l) => l.includes("t-w1"))).toContain("PAUSED QUOTA");
    expect(lines.find((l) => l.includes("t-w1"))).toContain("⏱ in 43m");
    overlay.dispose();
  });

  test("selection falls back to the nearest row when the selected run disappears", async () => {
    let drop = false;
    const { overlay, calls } = makeOverlay(() => {
      const t = fixture();
      if (drop) t.runs = t.runs.filter((e) => e.run.id !== "run-b");
      return t;
    });
    await tick();
    overlay.handleInput("4");
    overlay.render(100);
    // all rows: run-a + 6 tasks, run-b, t-b1, run-c, ...
    for (let i = 0; i < 7; i++) overlay.handleInput(KEY.down);
    expect(overlay.state.selectedKey).toBe("run-b");
    drop = true;
    calls.emit!({ kind: "event", seq: 1, runId: "run-b", taskId: null, type: "run.deleted", payload: {}, createdAt: NOW });
    await tick(40);
    overlay.render(100);
    expect(overlay.state.selectedKey).toBe("run-c");
    overlay.dispose();
  });

  test("live events refetch once (debounced) and preserve selection by id", async () => {
    let version = 0;
    const { overlay, calls } = makeOverlay(() => {
      const t = fixture();
      if (version > 0) {
        // A new run appears at the top; the selected task moves down in the row list.
        t.runs.unshift({
          run: run("run-new", "active", NOW, "Brand new"),
          tasks: [task("t-n1", "run-new", { tier: 1, kind: "orchestrator", status: "running", createdAt: 1, updatedAt: NOW })],
          escalations: [],
          quotaPause: null,
        });
      }
      return t;
    });
    await tick();
    overlay.handleInput(KEY.down);
    overlay.handleInput(KEY.down);
    expect(overlay.state.selectedKey).toBe("run-a/t-w1");
    expect(calls.fetches).toBe(1);
    version = 1;
    const ev: WatchEventFrame = { kind: "event", seq: 1, runId: "run-new", taskId: null, type: "run.created", payload: {}, createdAt: NOW, watchId: "w1" };
    calls.emit!(ev);
    calls.emit!({ ...ev, seq: 2 });
    calls.emit!({ ...ev, seq: 3 });
    await tick(40);
    expect(calls.fetches).toBe(2);
    const lines = overlay.render(100).map(strip);
    expect(lines.some((l) => l.includes("run-new"))).toBe(true);
    expect(overlay.state.selectedKey).toBe("run-a/t-w1");
    expect(lines.find((l) => l.includes("▸") && l.includes("t-w1"))).toBeTruthy();
    overlay.dispose();
    expect(calls.stopped).toBe(1);
  });
});

function ev(seq: number, type: string, payload: unknown, taskId = "t-1"): EventRecord {
  return { seq, runId: "run-a", taskId, type, payload, createdAt: NOW };
}

describe("renderTranscriptLines", () => {
  test("coalesces text deltas, dims thoughts, colors errors red, merges tool updates", () => {
    const lines = renderTranscriptLines(
      [
        ev(1, "agent.thought_delta", { text: "pondering" }),
        ev(2, "agent.text_delta", { text: "Hello " }),
        ev(3, "agent.text_delta", { text: "world" }),
        ev(4, "agent.tool", { id: "x", name: "read_file", status: "pending" }),
        ev(5, "agent.tool", { id: "x", status: "completed" }),
        ev(6, "agent.error", { error: "boom" }),
        ev(7, "task.status", { from: "running", to: "completed" }),
        ev(8, "agent.rollover", { fromGen: 1, toGen: 2, reason: "context" }),
        ev(9, "quota.agent_paused", { reason: "429" }),
      ],
      theme,
      80,
    );
    const plain = lines.map(strip);
    const dimOpen = theme.dim("x").split("x")[0]!;
    const thought = lines[plain.indexOf("pondering")]!;
    expect(thought.startsWith(dimOpen)).toBe(true);
    const text = lines[plain.indexOf("Hello world")]!;
    expect(text.includes(dimOpen)).toBe(false);
    expect(plain.filter((l) => l.includes("read_file"))).toEqual(["✓ read_file"]);
    const errOpen = theme.error("x").split("x")[0]!;
    expect(lines.find((l) => strip(l).includes("boom"))!.startsWith(errOpen)).toBe(true);
    expect(plain.some((l) => l.includes("running → completed"))).toBe(true);
    expect(plain.some((l) => l.includes("rollover gen 1 → 2"))).toBe(true);
    expect(plain.some((l) => l.includes("quota (429"))).toBe(true);
    // Narrow widths wrap rather than truncate.
    const narrow = renderTranscriptLines([ev(1, "agent.text_delta", { text: "abcdefghij klmnopqrst uvwxyz" })], theme, 8);
    for (const l of narrow) expect(visibleWidth(l)).toBeLessThanOrEqual(8);
    expect(narrow.map(strip).join("").replace(/\s/g, "")).toBe("abcdefghijklmnopqrstuvwxyz");
  });
});

describe("AgentTranscriptOverlay", () => {
  function makeTranscript(replay: EventRecord[]) {
    const calls = { order: [] as string[], renders: 0, emit: null as null | ((e: TranscriptEvent) => void) };
    const overlay = new AgentTranscriptOverlay({
      theme,
      runId: "run-a",
      taskId: "t-1",
      title: "Worker one",
      startWatch: async (onEvent) => {
        calls.emit = onEvent;
        return {
          replay,
          stop: async () => {
            calls.order.push("stop");
          },
        };
      },
      onClose: () => calls.order.push("close"),
      requestRender: () => calls.renders++,
      viewportRows: 10,
    });
    return { overlay, calls };
  }

  test("replay of >500 events renders all and is scrollable to the very first line", async () => {
    const replay = Array.from({ length: 600 }, (_, i) => ev(i + 1, "agent.tool", { id: `tool-${i}`, name: `step-${i}`, status: "completed" }));
    expect(renderTranscriptLines(replay, theme, 80).length).toBe(600);
    const { overlay } = makeTranscript(replay);
    await tick();
    expect(overlay.eventCount).toBe(600);
    let plain = overlay.render(80).map(strip);
    expect(plain.some((l) => l.includes("step-599"))).toBe(true); // auto-follow at bottom
    expect(plain.some((l) => l.includes("step-0 ") || l.trim().endsWith("step-0"))).toBe(false);
    overlay.handleInput("g");
    plain = overlay.render(80).map(strip);
    expect(plain.some((l) => /✓ step-0\s*$/.test(l))).toBe(true);
    overlay.handleInput("G");
    plain = overlay.render(80).map(strip);
    expect(plain.some((l) => l.includes("step-599"))).toBe(true);
  });

  test("live events append after replay, dedupe by seq, ignore other tasks, follow only at bottom", async () => {
    const replay = Array.from({ length: 30 }, (_, i) => ev(i + 1, "agent.tool", { id: `t${i}`, name: `s${i}`, status: "completed" }));
    const { overlay, calls } = makeTranscript(replay);
    await tick();
    overlay.render(80);
    calls.emit!({ ...ev(30, "agent.text_delta", { text: "dupe" }) });
    calls.emit!({ ...ev(31, "agent.text_delta", { text: "other" }, "t-other") });
    calls.emit!({ ...ev(32, "agent.text_delta", { text: "live!" }) });
    expect(overlay.eventCount).toBe(31);
    expect(overlay.render(80).map(strip).some((l) => l.includes("live!"))).toBe(true);
    overlay.handleInput(KEY.up);
    overlay.handleInput(KEY.up);
    const before = overlay.render(80).map(strip);
    calls.emit!({ ...ev(33, "agent.error", { error: "late" }) });
    const after = overlay.render(80).map(strip);
    expect(after.slice(2, -1)).toEqual(before.slice(2, -1)); // scrolled up: viewport stays put
  });

  test("live events arriving before replay resolves are kept, after replay, in order", async () => {
    const order: string[] = [];
    const overlay = new AgentTranscriptOverlay({
      theme,
      runId: "run-a",
      taskId: "t-1",
      title: "w",
      startWatch: async (onEvent) => {
        onEvent(ev(41, "agent.text_delta", { text: "LIVE\n" }));
        await tick();
        return { replay: Array.from({ length: 40 }, (_, i) => ev(i + 1, "agent.text_delta", { text: `r${i}\n` })), stop: () => {} };
      },
      onClose: () => order.push("close"),
      requestRender: () => {},
      viewportRows: 100,
    });
    await tick(10);
    expect(overlay.eventCount).toBe(41);
    const plain = overlay.render(80).map(strip).map((l) => l.trim());
    expect(plain.indexOf("r0")).toBeLessThan(plain.indexOf("r39"));
    expect(plain.indexOf("r39")).toBeLessThan(plain.indexOf("LIVE"));
    for (const w of [8, 30]) for (const l of overlay.render(w)) expect(visibleWidth(l)).toBeLessThanOrEqual(w);
  });

  test("non-navigation keys do nothing; Esc stops the watch then closes", async () => {
    const replay = Array.from({ length: 5 }, (_, i) => ev(i + 1, "agent.text_delta", { text: `line ${i}\n` }));
    const { overlay, calls } = makeTranscript(replay);
    await tick();
    const snapshot = overlay.render(80);
    const renders = calls.renders;
    for (const k of ["a", "hello", KEY.enter, "r", "x", "w", "/", KEY.tab, " ", "q"]) overlay.handleInput(k);
    expect(calls.renders).toBe(renders);
    expect(calls.order).toEqual([]);
    expect(overlay.render(80)).toEqual(snapshot);
    overlay.handleInput(KEY.esc);
    await tick();
    expect(calls.order).toEqual(["stop", "close"]);
  });
});
