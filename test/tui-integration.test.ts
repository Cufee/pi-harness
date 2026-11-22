import { describe, expect, test } from "bun:test";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { RunRecord, TaskRecord } from "../src/control-plane/db.js";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { isWatchFrame, openRunsOverlay } from "../src/tui/app.js";
import { createTheme, OverlayManager } from "../src/tui/primitives/index.js";
import type { RunsTreesResult } from "../src/tui/runs-tree.js";
import { AgentTranscriptOverlay } from "../src/tui/transcript-overlay.js";

const theme = createTheme();
const NOW = Date.now();
const KEY = { down: "\x1b[B", enter: "\r", esc: "\x1b" };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

const runRec: RunRecord = {
  id: "run-a",
  goal: "Rework /runs",
  repoRoot: "/repo",
  baseBranch: "main",
  baseSha: "abc",
  coordinationGroup: null,
  isolationMode: "standalone",
  status: "active",
  createdAt: NOW - 1000,
  updatedAt: NOW,
};

function taskRec(id: string, tier: 1 | 2 | 3, parentId: string | null): TaskRecord {
  return {
    id,
    runId: "run-a",
    parentId,
    tier,
    kind: tier === 1 ? "orchestrator" : "worker",
    title: `title ${id}`,
    objective: "",
    criteria: "",
    readOnly: false,
    profileId: "acp:amp",
    model: null,
    effort: null,
    status: "running",
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
    createdAt: NOW - 1000,
    updatedAt: NOW,
  } as TaskRecord;
}

const trees: RunsTreesResult = {
  generatedAt: NOW,
  runs: [{ run: runRec, tasks: [taskRec("t-1", 1, null), taskRec("t-2", 2, "t-1")], escalations: [], quotaPause: null }],
};

/** Fake DaemonClient: records every request and lets the test push frames to `onEvent` listeners. */
function fakeClient() {
  const calls: Array<{ op: string; params?: Record<string, unknown> }> = [];
  const listeners = new Set<(ev: DaemonEventFrame) => void>();
  let nextWatch = 0;
  const client = {
    request: async (op: string, params?: Record<string, unknown>) => {
      calls.push({ op, params });
      if (op === "runs.trees") return trees;
      if (op === "watch.start") {
        const replay =
          params?.scope === "task"
            ? [{ seq: 1, runId: "run-a", taskId: params.taskId, type: "agent.text_delta", payload: { text: "REPLAYED" }, createdAt: NOW }]
            : [];
        return { watchId: `w${++nextWatch}`, replay, lastSeq: 1 };
      }
      if (op === "watch.stop") return { stopped: true };
      return {};
    },
    onEvent: (fn: (ev: DaemonEventFrame) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  } as unknown as Pick<DaemonClient, "request" | "onEvent">;
  const emit = (ev: DaemonEventFrame) => {
    for (const fn of [...listeners]) fn(ev);
  };
  return { client, calls, emit, ops: () => calls.map((c) => c.op) };
}

/** Minimal TUI for OverlayManager: tracks visible overlays and focus so keys reach the top overlay. */
function fakeTui() {
  const shown: Component[] = [];
  let focus: Component | null = null;
  const tui = {
    showOverlay: (c: Component) => {
      shown.push(c);
      return { hide: () => shown.splice(shown.indexOf(c), 1) };
    },
    setFocus: (c: Component) => (focus = c),
    requestRender: () => {},
  } as unknown as TUI;
  return { tui, shown, press: (key: string) => focus?.handleInput?.(key), focused: () => focus };
}

function setup() {
  const daemon = fakeClient();
  const term = fakeTui();
  const composer: Component = { render: () => [], invalidate: () => {} };
  const overlays = new OverlayManager(term.tui, theme, composer);
  const actions: Array<[string, string]> = [];
  const runs = openRunsOverlay({
    client: daemon.client,
    theme,
    overlays,
    requestRender: () => {},
    onAction: (a, runId) => actions.push([a, runId]),
  });
  return { ...daemon, ...term, overlays, runs, actions, composer };
}

describe("/runs integration", () => {
  test("opening /runs issues runs.trees + watch.start(runs) and never attach/detach", async () => {
    const s = setup();
    await tick();
    expect(s.ops()).toEqual(["runs.trees", "watch.start"]);
    expect(s.calls[1]!.params).toEqual({ scope: "runs" });
    expect(s.ops()).not.toContain("attach");
    expect(s.ops()).not.toContain("detach");
    expect(s.overlays.depth).toBe(1);
  });

  test("Enter opens a stacked transcript with watch.start(task); Esc stops it and restores the tree state", async () => {
    const s = setup();
    await tick();
    s.press("2"); // non-default filter must survive the popup
    s.press(KEY.down);
    s.press(KEY.down); // run-a → t-1 → t-2
    const before = s.runs.state;
    expect(before.selectedKey).toBe("run-a/t-2");

    s.press(KEY.enter);
    await tick();
    expect(s.overlays.depth).toBe(2);
    const taskStart = s.calls.filter((c) => c.op === "watch.start")[1];
    expect(taskStart?.params).toEqual({ scope: "task", runId: "run-a", taskId: "t-2" });
    expect(s.shown.at(-1)!.render(100).join("\n")).toContain("REPLAYED");

    s.press(KEY.esc);
    await tick();
    expect(s.calls.filter((c) => c.op === "watch.stop").map((c) => c.params)).toEqual([{ watchId: "w2" }]);
    expect(s.overlays.depth).toBe(1);
    expect(s.runs.state).toEqual(before);
    expect(s.ops()).not.toContain("attach");

    // Esc on the tree closes /runs and stops the runs watch.
    s.press(KEY.esc);
    await tick();
    expect(s.overlays.depth).toBe(0);
    expect(s.focused()).toBe(s.composer);
    expect(s.calls.filter((c) => c.op === "watch.stop").map((c) => c.params)).toEqual([{ watchId: "w2" }, { watchId: "w1" }]);
  });

  test("closing overlays without Esc (Ctrl+T pop) still stops their watches", async () => {
    const s = setup();
    await tick();
    s.press(KEY.down);
    s.press(KEY.enter);
    await tick();
    s.overlays.closeAll();
    await tick();
    expect(
      s.calls
        .filter((c) => c.op === "watch.stop")
        .map((c) => c.params?.watchId)
        .sort(),
    ).toEqual(["w1", "w2"]);
  });

  test("watch frames reach only their overlay, never the chat transcript listener", async () => {
    const s = setup();
    await tick();
    const chatSeen: DaemonEventFrame[] = [];
    s.client.onEvent((ev) => {
      if (isWatchFrame(ev)) return; // same guard as the Director Chat / attached-run listeners
      chatSeen.push(ev);
    });
    s.press(KEY.down);
    s.press(KEY.enter);
    await tick();
    const live = { kind: "event", seq: 2, runId: "run-a", taskId: "t-1", type: "agent.text_delta", payload: { text: "LIVE-WATCH" }, createdAt: NOW } as const;
    s.emit({ ...live, watchId: "w2" });
    s.emit({ ...live, seq: 3, payload: { text: "OTHER-WATCH" }, watchId: "w1" });
    expect(chatSeen).toEqual([]);
    const transcript = s.shown.at(-1)!.render(100).join("\n");
    expect(transcript).toContain("LIVE-WATCH");
    expect(transcript).not.toContain("OTHER-WATCH");

    s.emit({ ...live, seq: 4, payload: { text: "ATTACHED" } });
    expect(chatSeen.map((e) => e.seq)).toEqual([4]);
  });

  test("r / w / x in the tree route resume, wait, stop for the selected run", async () => {
    const s = setup();
    await tick();
    s.press("r");
    s.press("w");
    s.press("x");
    expect(s.actions).toEqual([
      ["resume", "run-a"],
      ["wait", "run-a"],
      ["stop", "run-a"],
    ]);
    expect(AgentTranscriptOverlay).toBeDefined();
  });
});
