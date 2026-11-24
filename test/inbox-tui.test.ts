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

describe("WorkNavigatorScreen inbox defaults and actions", () => {
  it("opens on goals even with a non-empty inbox, keeps Inbox count synced to snap.inbox, toggles internal items with 'i', and sends dismiss/restore/clear_stale", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal } = makeFakeTerminal(120, 30);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };

    const now = Date.now();
    const shownItem: InboxItem = {
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
      inbox: [shownItem],
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

    // 2. Press "1" to switch to Inbox tab; Inbox tab count matches snap.inbox.length (1)
    workNav.handleInput("1", ctx);
    assert.equal(workNav.currentTab, "inbox");
    const inboxDefaultRender = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(inboxDefaultRender.includes("1:Inbox (1)"), "Inbox tab count must equal snap.inbox.length");
    assert.ok(inboxDefaultRender.includes("run-stale failed"));
    assert.equal(inboxDefaultRender.includes("Old worker"), false, "Internal rows must be hidden by default");
    assert.ok(inboxDefaultRender.includes("d dismiss") && inboxDefaultRender.includes("D clear stale") && inboxDefaultRender.includes("i show internal"));

    // 3. Press "d" on the selected shown item -> sends inbox.dismiss
    workNav.handleInput("d", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const dismissCall = mock.calls.find((c) => c.op === "inbox.dismiss");
    assert.deepEqual(dismissCall?.params, {
      itemId: shownItem.id,
      itemCreatedAt: shownItem.createdAt,
    });

    // 4. Press "i" -> reveals internal rows with hidden reason in DETAIL; tab count stays 1; state lives on WorkStore
    workNav.handleInput("i", ctx);
    assert.equal(store.showInternal, true);
    const withInternalRender = workNav.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(withInternalRender.includes("1:Inbox (1)"), "Tab count must remain snap.inbox.length when internal items are shown");
    assert.ok(withInternalRender.includes("Old worker"));
    assert.ok(withInternalRender.includes("[run_live"));
    assert.ok(withInternalRender.includes("[dismissed"));
    assert.ok(withInternalRender.includes("i hide internal"));

    // 5. Move down to the dismissed row and press "d" -> sends inbox.restore
    workNav.handleInput("j", ctx); // -> internalTask
    workNav.handleInput("j", ctx); // -> dismissedItem
    workNav.handleInput("d", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const restoreCall = mock.calls.find((c) => c.op === "inbox.restore");
    assert.deepEqual(restoreCall?.params, { itemId: dismissedItem.id });

    // 6. Press "D" -> confirm with "y" -> sends inbox.clear_stale with store scope
    workNav.handleInput("D", ctx);
    workNav.handleInput("y", ctx);
    await new Promise((r) => setTimeout(r, 20));
    const clearCall = mock.calls.find((c) => c.op === "inbox.clear_stale");
    assert.deepEqual(clearCall?.params, { chatSessionId: "chat-1", repoRoot: "/repo" });

    // 7. Reopening WorkNavigatorScreen preserves showInternal on WorkStore; empty state mentions "i" when hidden internal items exist
    nav.pop();
    store.showInternal = false;
    currentSnap = { ...currentSnap, inbox: [] };
    await store.refresh();
    const reopened = new WorkNavigatorScreen(deps, "inbox");
    nav.push(reopened);
    const emptyRender = reopened.render(120, 24, theme).map(stripTerminalSequences).join("\n");
    assert.ok(emptyRender.includes("press 'i' to show"), "Empty inbox text must mention 'i' when internal items exist");

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
