import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { DaemonEventFrame, InboxItem } from "../src/protocol/daemon-rpc.js";
import { createTheme, ModalScreen, Navigator, stripTerminalSequences } from "../src/tui/core/index.js";
import { WorkStore, type WorkSnapshot } from "../src/tui/store.js";
import { WorkNavigatorScreen } from "../src/tui/work-navigator.js";

function makeFakeTerminal(cols = 120, rows = 30): { terminal: Terminal } {
  const terminal: Terminal = {
    start() {},
    stop() {},
    async drainInput() {},
    write() {},
    get columns() {
      return cols;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
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
  return { terminal };
}

function makeMockClient(handler: (op: string, params: Record<string, unknown>) => Promise<unknown>) {
  const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
  const client = {
    isRemote: false,
    connected: true,
    onEvent: (_fn: (ev: DaemonEventFrame) => void) => () => {},
    onClose: () => () => {},
    close() {},
    async request<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ op, params });
      return (await handler(op, params)) as T;
    },
  } as unknown as DaemonClient;
  return { client, calls };
}

function parseInboxRender(lines: string[]): { badgeCount: number; rows: string[]; text: string } {
  const plain = lines.map(stripTerminalSequences);
  const tabLine = plain.find((l) => l.includes("1:Inbox"));
  assert.ok(tabLine, "Rendered frame must include the 1:Inbox tab");
  const badgeMatch = tabLine.match(/1:Inbox(?: \((\d+)\))?/);
  const badgeCount = badgeMatch?.[1] ? Number(badgeMatch[1]) : 0;

  const headerIdx = plain.findIndex((l) => l.includes("SEV") && l.includes("KIND") && l.includes("TITLE"));
  assert.ok(headerIdx >= 0, "Rendered Inbox tab must include table header");
  const rows: string[] = [];
  for (let i = headerIdx + 2; i < plain.length; i++) {
    const line = plain[i]!;
    if (line.startsWith("├") || line.startsWith("└")) break;
    const inner = line.replace(/^│/, "").replace(/│$/, "").trim();
    if (!inner || inner.startsWith("Inbox clear")) break;
    rows.push(inner);
  }
  return { badgeCount, rows, text: plain.join("\n") };
}

describe("WorkNavigatorScreen inbox defaults and actions", () => {
  it("opens on goals even with a non-empty inbox, keeps Inbox count equal to rendered rows across snapshot changes, toggles/persists internal items, and confirms clear_stale", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(120, 30);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };

    const now = Date.now();
    const shownEsc: InboxItem = {
      id: "inbox:esc:esc-human",
      severity: "P0",
      kind: "escalation",
      title: "[P0/blocked_dependency] Need production sign-off",
      detail: "from t-1 in run-1 · blocking",
      ref: { kind: "escalation", id: "esc-human", runId: "run-1", label: "esc-human Need production sign-off" },
      runId: "run-1",
      taskId: "t-1",
      createdAt: now - 2_000,
    };
    const shownRun: InboxItem = {
      id: "inbox:run:run-stale",
      severity: "P1",
      kind: "run_failed",
      title: "run-stale failed",
      detail: "Ad-hoc failed run",
      ref: { kind: "run", id: "run-stale", label: "run-stale" },
      runId: "run-stale",
      createdAt: now - 5_000,
    };
    const internalTask: InboxItem = {
      id: "inbox:task:t-old",
      severity: "P2",
      kind: "task_failed",
      title: "t-old (failed): Old worker",
      detail: "run-1 · T2/worker",
      ref: { kind: "task", id: "t-old", runId: "run-1", label: "t-old Old worker" },
      runId: "run-1",
      taskId: "t-old",
      createdAt: now - 10_000,
      audience: "orchestrator",
      hiddenReason: "run_live",
    };
    const dismissedItem: InboxItem = {
      id: "inbox:run:run-prev",
      severity: "P1",
      kind: "run_failed",
      title: "run-prev failed",
      detail: "Previously dismissed",
      ref: { kind: "run", id: "run-prev", label: "run-prev" },
      runId: "run-prev",
      createdAt: now - 20_000,
      audience: "human",
      hiddenReason: "dismissed",
    };

    let currentSnap: WorkSnapshot = {
      generatedAt: now,
      latestSeq: 1,
      goals: [],
      runs: [],
      escalations: [],
      timers: [],
      merges: [],
      worktrees: [],
      messages: [],
      inbox: [shownEsc, shownRun],
      internalAttention: [internalTask, dismissedItem],
    };

    const mock = makeMockClient(async (op) => {
      if (op === "work.snapshot") return currentSnap;
      if (op === "inbox.dismiss") return { dismissed: true };
      if (op === "inbox.restore") return { restored: true };
      if (op === "inbox.clear_stale") return { dismissed: 1 };
      return {};
    });

    const store = new WorkStore(mock.client, { chatSessionId: "chat-1", repoRoot: "/repo" });
    await store.refresh();
    const deps = { client: mock.client, store, repoRoot: "/repo" };

    // 1. Default tab with non-empty inbox and no initialTab is "goals"
    const workNav = new WorkNavigatorScreen(deps);
    nav.push(workNav);
    assert.equal(workNav.currentTab, "goals");

    // 2. Press "1" to switch to Inbox tab; badge count equals rendered rows (2)
    workNav.handleInput("1", ctx);
    assert.equal(workNav.currentTab, "inbox");
    const renderTwo = parseInboxRender(workNav.render(120, 24, theme));
    assert.equal(renderTwo.badgeCount, 2);
    assert.equal(renderTwo.rows.length, renderTwo.badgeCount);
    assert.ok(renderTwo.rows[0]!.includes("Need production sign-off"));
    assert.ok(renderTwo.rows[1]!.includes("run-stale failed"));
    assert.equal(renderTwo.text.includes("Old worker"), false, "Internal rows must be hidden by default");
    assert.ok(renderTwo.text.includes("d dismiss") && renderTwo.text.includes("D clear stale") && renderTwo.text.includes("i show internal"));

    // 3. Press "d" on the selected shown item -> sends inbox.dismiss
    workNav.handleInput("d", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const dismissCall = mock.calls.find((c) => c.op === "inbox.dismiss");
    assert.deepEqual(dismissCall?.params, {
      itemId: shownEsc.id,
      itemCreatedAt: shownEsc.createdAt,
    });

    // 4. Snapshot shrinks to 1 human row -> badge count and rendered row count update together to 1
    currentSnap = { ...currentSnap, latestSeq: 2, inbox: [shownRun] };
    await store.refresh();
    const renderOne = parseInboxRender(workNav.render(120, 24, theme));
    assert.equal(renderOne.badgeCount, 1);
    assert.equal(renderOne.rows.length, renderOne.badgeCount);
    assert.ok(renderOne.rows[0]!.includes("run-stale failed"));
    assert.equal(renderOne.text.includes("Need production sign-off"), false);

    // 5. Press "i" -> reveals internal rows with hidden reason in DETAIL; tab count stays 1; state lives on WorkStore
    workNav.handleInput("i", ctx);
    assert.equal(store.showInternal, true);
    const withInternal = parseInboxRender(workNav.render(120, 24, theme));
    assert.equal(withInternal.badgeCount, 1, "Tab count must remain snap.inbox.length when internal items are shown");
    assert.equal(withInternal.rows.length, 3);
    assert.ok(withInternal.rows[0]!.includes("run-stale failed"));
    assert.ok(withInternal.rows[1]!.includes("Old worker") && withInternal.rows[1]!.includes("[run_live"));
    assert.ok(withInternal.rows[2]!.includes("run-prev failed") && withInternal.rows[2]!.includes("[dismissed"));
    assert.ok(withInternal.text.includes("i hide internal"));

    // 6. Move down to the dismissed row and press "d" -> sends inbox.restore
    workNav.handleInput("j", ctx); // -> internalTask
    workNav.handleInput("j", ctx); // -> dismissedItem
    workNav.handleInput("d", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const restoreCall = mock.calls.find((c) => c.op === "inbox.restore");
    assert.deepEqual(restoreCall?.params, { itemId: dismissedItem.id });

    // 7. Press "D" -> no RPC before confirmation, none after cancel, sends inbox.clear_stale only after confirm
    workNav.handleInput("D", ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mock.calls.filter((c) => c.op === "inbox.clear_stale").length, 0, "D must not clear before confirm");
    workNav.handleInput("n", ctx);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mock.calls.filter((c) => c.op === "inbox.clear_stale").length, 0, "Cancelling D must not call inbox.clear_stale");

    workNav.handleInput("D", ctx);
    workNav.handleInput("y", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const clearCalls = mock.calls.filter((c) => c.op === "inbox.clear_stale");
    assert.equal(clearCalls.length, 1);
    assert.deepEqual(clearCalls[0]?.params, { chatSessionId: "chat-1", repoRoot: "/repo" });

    // 8. Reopening a new WorkNavigatorScreen on the same store preserves showInternal=true
    nav.pop();
    const reopened = new WorkNavigatorScreen(deps, "inbox");
    nav.push(reopened);
    assert.equal(store.showInternal, true);
    const reopenedWithInternal = parseInboxRender(reopened.render(120, 24, theme));
    assert.equal(reopenedWithInternal.rows.length, 3);
    assert.ok(reopenedWithInternal.text.includes("Old worker"));
    assert.ok(reopenedWithInternal.text.includes("i hide internal"));

    // 9. Toggling internal off and emptying inbox drops badge and rendered rows to 0 and shows the 'i' hint
    reopened.handleInput("i", ctx);
    assert.equal(store.showInternal, false);
    currentSnap = { ...currentSnap, latestSeq: 3, inbox: [] };
    await store.refresh();
    const emptyRender = parseInboxRender(reopened.render(120, 24, theme));
    assert.equal(emptyRender.badgeCount, 0);
    assert.equal(emptyRender.rows.length, 0);
    assert.ok(emptyRender.text.includes("press 'i' to show"), "Empty inbox text must mention 'i' when internal items exist");

    store.dispose();
  });

  it("handles older daemons without internalAttention and surfaces Unknown daemon op as a frame notice", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(120, 30);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };

    const now = Date.now();
    const mock = makeMockClient(async (op) => {
      if (op === "work.snapshot") {
        // Older daemon omits internalAttention
        return {
          generatedAt: now,
          latestSeq: 1,
          goals: [],
          runs: [],
          escalations: [],
          timers: [],
          merges: [],
          worktrees: [],
          messages: [],
          inbox: [
            {
              id: "inbox:run:run-1",
              severity: "P1",
              kind: "run_failed",
              title: "run-1 failed",
              detail: "boom",
              ref: { kind: "run", id: "run-1", label: "run-1" },
              runId: "run-1",
              createdAt: now,
            },
          ],
        } satisfies WorkSnapshot;
      }
      if (op === "inbox.dismiss") {
        throw new Error("Unknown daemon op: inbox.dismiss");
      }
      return {};
    });

    const store = new WorkStore(mock.client, { repoRoot: "/repo" });
    await store.refresh();
    const workNav = new WorkNavigatorScreen({ client: mock.client, store, repoRoot: "/repo" }, "inbox");
    nav.push(workNav);

    // Toggling internal with undefined internalAttention does not crash
    workNav.handleInput("i", ctx);
    workNav.handleInput("i", ctx);

    // Pressing 'd' against older daemon surfaces frame notice instead of crashing
    workNav.handleInput("d", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const rendered = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(rendered.includes("Unknown daemon op: inbox.dismiss"));

    store.dispose();
  });
});
