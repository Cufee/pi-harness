import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../src/daemon/remote.js";
import {
  createTheme,
  extractSelectionText,
  Frame,
  highlightCells,
  isPopKey,
  kvRow,
  ModalScreen,
  Navigator,
  normalizeSelection,
  type Screen,
  type ScreenContext,
  snapCellRange,
  stripTerminalSequences,
  TableListView,
  Viewport,
  visibleWidth,
} from "../src/tui/core/index.js";
import {
  EscalationInspectorScreen,
  type InspectorDeps,
  TaskInspectorScreen,
} from "../src/tui/inspectors.js";
import type { WorkStore } from "../src/tui/store.js";

function makeFakeTerminal(cols = 100, rows = 26) {
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

function compositeVisible(tui: ModalScreen, terminal: Terminal): string[] {
  const composited = (
    tui as unknown as { compositeOverlays(l: string[], w: number, h: number): string[] }
  ).compositeOverlays(tui.render(terminal.columns), terminal.columns, terminal.rows);
  const viewportTop = Math.max(0, composited.length - terminal.rows);
  return composited.slice(viewportTop);
}

function extractOsc52Payloads(writes: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of writes) {
    const m = w.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/);
    if (m) out.push(Buffer.from(m[1]!, "base64").toString("utf8"));
  }
  return out;
}

function dragCells(
  sendInput: (data: string) => void,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): void {
  sendInput(`\x1b[<0;${x0 + 1};${y0 + 1}M`);
  sendInput(`\x1b[<32;${x1 + 1};${y1 + 1}M`);
  sendInput(`\x1b[<0;${x1 + 1};${y1 + 1}m`);
}

function colOf(plainLine: string, needle: string): number {
  const idx = plainLine.indexOf(needle);
  assert.ok(idx >= 0, `Expected to find ${JSON.stringify(needle)} in ${JSON.stringify(plainLine)}`);
  return visibleWidth(plainLine.slice(0, idx));
}

describe("Shared selection primitives (src/tui/core/selection.ts)", () => {
  it("normalizes reverse selections, snaps wide graphemes, trims row spacers and common col-0 indent, and highlights cells", () => {
    const revRow = normalizeSelection("cell", { row: 4, col: 2 }, { row: 1, col: 9 });
    assert.deepEqual(revRow, { mode: "cell", startRow: 1, endRow: 4, startCol: 9, endCol: 2 });

    const revCol = normalizeSelection("cell", { row: 2, col: 8 }, { row: 2, col: 3 });
    assert.deepEqual(revCol, { mode: "cell", startRow: 2, endRow: 2, startCol: 3, endCol: 8 });

    // "A界B 🚀" -> cols: A=0, 界=1..2, B=3, ' '=4, 🚀=5..6
    const wideLine = "A界B 🚀";
    assert.deepEqual(snapCellRange(wideLine, 2, 3, 20), { c0: 1, c1: 3 });
    assert.deepEqual(snapCellRange(wideLine, 3, 5, 20), { c0: 3, c1: 6 });

    // Cell mode: preserves relative code indent while stripping common col-0 indent; keeps ANSI out.
    const rows = [
      "",
      "  \x1b[32malpha()\x1b[39m   ",
      "    beta(1)  ",
      "  gamma()  ",
      "",
    ];
    const cellSel = normalizeSelection("cell", { row: 1, col: 0 }, { row: 3, col: 19 });
    assert.equal(
      extractSelectionText(cellSel, (i) => rows[i] ?? "", 20),
      "alpha()\n  beta(1)\ngamma()",
    );

    // Row mode: trims leading and trailing blank spacer rows.
    const rowSel = normalizeSelection("row", { row: 0, col: 0 }, { row: 4, col: 0 });
    assert.equal(
      extractSelectionText(rowSel, (i) => rows[i] ?? "", 20),
      "alpha()\n  beta(1)\ngamma()",
    );

    const theme = createTheme({ color: true, ascii: false });
    const hl = highlightCells("hello world", 6, 10, 11, theme.badgeBg);
    assert.equal(stripTerminalSequences(hl), "hello world");
    assert.ok(hl.includes(theme.badgeBg("world")));
  });
});

describe("Shared Navigator overlay text selection", () => {
  it("drag-copies across subtitle and wide-glyph kv rows with highlight and notice, and ignores plain clicks", () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(90, 22);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const frame = new Frame();
    const receivedInputs: string[] = [];

    const screen: Screen = {
      title: "SampleDialog",
      variant: "dialog",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["Dialog", "Sample"],
          subtitle: "SubHeader alpha",
          hints: [{ key: "Esc", label: "close" }],
          renderBody: (innerW) => [
            kvRow("Name", "worker-alpha", innerW, t),
            kvRow("Tag", "A界B 🚀 ok", innerW, t),
          ],
        });
      },
      handleInput(data, ctx) {
        receivedInputs.push(data);
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };

    tui.start();
    nav.push(screen);
    const before = compositeVisible(tui, terminal);

    const subY = before.findIndex((l) => stripTerminalSequences(l).includes("SubHeader alpha"));
    const tagY = before.findIndex((l) => stripTerminalSequences(l).includes("A界B"));
    assert.ok(subY >= 0 && tagY > subY, "subtitle and wide-glyph body row must be visible");

    const plainSub = stripTerminalSequences(before[subY]!);
    const plainTag = stripTerminalSequences(before[tagY]!);
    const startX = colOf(plainSub, "alpha");
    // End on first cell of 🚀 so outward grapheme snap captures the entire emoji.
    const endX = colOf(plainTag, "🚀");

    writes.length = 0;
    dragCells(sendInput, startX, subY, endX, tagY);

    const copied = extractOsc52Payloads(writes);
    assert.equal(copied.length, 1, "release after drag must emit exactly one OSC 52 write");
    const expected = "alpha\nName              worker-alpha\nTag               A界B 🚀";
    assert.equal(copied[0], expected);
    assert.equal(/[╭╮╰╯│─┃┆]/.test(copied[0]!), false, "copied text must exclude frame and scrollbar chrome");

    const after = compositeVisible(tui, terminal);
    const afterPlain = after.map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(
      afterPlain.includes(`Copied ${expected.length} chars`),
      `Expected notice "Copied ${expected.length} chars" in:\n${afterPlain}`,
    );
    const highlightedTag = after.find((l) => stripTerminalSequences(l).includes("A界B"));
    assert.ok(highlightedTag, "wide-glyph row must remain visible");
    assert.ok(highlightedTag.includes(theme.badgeBg("Tag               A界B 🚀")));

    // Plain click (press + release on the same cell) writes no OSC and does not call screen.handleInput.
    writes.length = 0;
    receivedInputs.length = 0;
    sendInput(`\x1b[<0;${startX + 1};${subY + 1}M`);
    sendInput(`\x1b[<0;${startX + 1};${subY + 1}m`);
    assert.equal(extractOsc52Payloads(writes).length, 0, "plain click must not copy");
    assert.equal(receivedInputs.length, 0, "plain click must not invoke screen.handleInput");

    nav.closeAll();
    tui.stop();
  });

  it("strips Viewport scrollbar glyphs on full-width drags", () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(80, 16);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const frame = new Frame();
    const viewport = new Viewport();
    const bodyLines = Array.from({ length: 30 }, (_, i) => `ROW_${String(i + 1).padStart(2, "0")} payload text`);

    const screen: Screen = {
      title: "ScrollSheet",
      variant: "sheet",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["ScrollSheet"],
          hints: [{ key: "Esc", label: "close" }],
          renderBody: (innerW, bodyH) => viewport.render(bodyLines, innerW, bodyH, t),
        });
      },
      handleInput(data, ctx) {
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };

    tui.start();
    nav.push(screen);
    const visible = compositeVisible(tui, terminal);

    const r1Y = visible.findIndex((l) => stripTerminalSequences(l).includes("ROW_01 payload text"));
    const r3Y = visible.findIndex((l) => stripTerminalSequences(l).includes("ROW_03 payload text"));
    assert.ok(r1Y >= 0 && r3Y > r1Y);

    const plain1 = stripTerminalSequences(visible[r1Y]!);
    const plain3 = stripTerminalSequences(visible[r3Y]!);
    assert.ok(plain1.includes("┃") || plain1.includes("┆"), "overflowing viewport must render scrollbar");
    const x0 = colOf(plain1, "ROW_01");
    // Drag all the way onto the scrollbar glyph itself.
    const scrollbarIdx = Math.max(plain3.lastIndexOf("┃"), plain3.lastIndexOf("┆"));
    const x1 = visibleWidth(plain3.slice(0, scrollbarIdx));

    writes.length = 0;
    dragCells(sendInput, x0, r1Y, x1, r3Y);

    const copied = extractOsc52Payloads(writes);
    assert.equal(copied.length, 1);
    assert.equal(copied[0], "ROW_01 payload text\nROW_02 payload text\nROW_03 payload text");
    assert.equal(/[┃┆]/.test(copied[0]!), false, "scrollbar glyphs must be stripped");

    nav.closeAll();
    tui.stop();
  });

  it("handles Esc clearing before pop, preserves list navigation and wheel with active selection, and leaves Frame.askPrompt intact", () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(90, 18);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const frame = new Frame();
    const list = new TableListView<{ id: string }>({
      columns: [
        { key: "id", header: "ID", width: 10 },
        { key: "title", header: "TITLE" },
      ],
    });
    list.setItems(
      Array.from({ length: 20 }, (_, i) => ({
        id: `item-${i + 1}`,
        value: { id: `item-${i + 1}` },
        searchText: `item-${i + 1} entry ${i + 1}`,
        cells: () => ({ id: `item-${i + 1}`, title: `Entry number ${i + 1}` }),
      })),
    );
    let submittedPrompt: string | null = null;

    const screen: Screen = {
      title: "ListScreen",
      variant: "sheet",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["ListScreen"],
          hints: [{ key: "Esc", label: "close" }],
          renderBody: (innerW, bodyH) => list.render(innerW, bodyH, t),
        });
      },
      handleInput(data, ctx) {
        if (frame.handleInlineInput(data, ctx.requestRender)) return;
        if (data === "p") {
          frame.askPrompt({
            label: "Note",
            onSubmit: (v) => {
              submittedPrompt = v;
            },
          });
          ctx.requestRender();
          return;
        }
        if (list.handleInput(data) !== "ignored") {
          ctx.requestRender();
          return;
        }
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };

    tui.start();
    nav.push(screen);
    const visible = compositeVisible(tui, terminal);

    const rowY = visible.findIndex((l) => stripTerminalSequences(l).includes("item-2"));
    assert.ok(rowY >= 0);
    const plainRow = stripTerminalSequences(visible[rowY]!);
    const x0 = colOf(plainRow, "item-2");
    const x1 = colOf(plainRow, "Entry number 2") + "Entry number 2".length - 1;

    // 1) Drag select -> first Esc clears selection without popping, second Esc pops.
    const expectedRowText = "item-2      Entry number 2";
    writes.length = 0;
    dragCells(sendInput, x0, rowY, x1, rowY);
    assert.deepEqual(extractOsc52Payloads(writes), [expectedRowText]);
    assert.ok(
      compositeVisible(tui, terminal).some((l) => l.includes(theme.badgeBg(expectedRowText))),
      "active selection should be highlighted before Esc",
    );

    sendInput("\x1b");
    assert.equal(nav.isOpen, true, "first Esc must clear selection without popping screen");
    assert.equal(
      compositeVisible(tui, terminal)
        .find((l) => stripTerminalSequences(l).includes("item-2"))
        ?.includes(theme.badgeBg(expectedRowText)),
      false,
      "highlight must be cleared after first Esc",
    );

    sendInput("\x1b");
    assert.equal(nav.isOpen, false, "second Esc must pop screen");

    // 2) Re-open: j clears active selection and moves list selection; wheel clears and scrolls list.
    nav.push(screen);
    compositeVisible(tui, terminal);
    assert.equal(list.selectedItem()?.value.id, "item-1");

    dragCells(sendInput, x0, rowY, x1, rowY);
    sendInput("j");
    assert.equal(list.selectedItem()?.value.id, "item-2", "'j' must pass through to TableListView");
    assert.equal(nav.isOpen, true);

    const beforeScroll = list.viewport.offset;
    dragCells(sendInput, x0, rowY, x1, rowY);
    sendInput(`\x1b[<65;${x0 + 1};${rowY + 1}M`);
    assert.ok(list.viewport.offset > beforeScroll, "mouse wheel must scroll list even after selection");

    // 3) Frame.askPrompt: typed keys reach prompt; Esc without selection cancels prompt without popping.
    sendInput("p");
    assert.equal(frame.hasInlineModal, true);
    sendInput("h");
    sendInput("i");
    const promptRendered = compositeVisible(tui, terminal).map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(promptRendered.includes("Note:") && promptRendered.includes("hi"), "typed keys must reach prompt");
    sendInput("\x1b");
    assert.equal(frame.hasInlineModal, false, "Esc without selection must cancel prompt");
    assert.equal(nav.isOpen, true, "cancelling prompt must not pop screen");
    assert.equal(submittedPrompt, null);

    nav.closeAll();
    tui.stop();
  });

  it("drag-copies the task id from a real TaskInspectorScreen (worker card) and shows the copy notice", async () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(100, 26);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);

    const now = Date.now();
    const deps: InspectorDeps = {
      repoRoot: "/tmp/repo",
      store: {} as unknown as WorkStore,
      client: {
        async request(method: string) {
          assert.equal(method, "task.get");
          return {
            task: {
              id: "t-512",
              runId: "run-34",
              parentId: "t-507",
              tier: 2,
              kind: "worker",
              title: "goal-41: shared overlay text selection",
              status: "executing",
              profileId: "gemini-cli",
              model: "google/gemini-4-neon",
              generation: 1,
              turnsUsed: 4,
              summary: "Implementing shared overlay selection.",
              createdAt: now - 60_000,
              updatedAt: now - 5_000,
            },
            handoff: null,
            run: null,
            escalations: [],
            artifacts: [],
            worktree: null,
            merges: [],
            messages: [],
            children: [],
            writeScopes: ["src/tui/core/navigator.ts"],
          };
        },
      } as unknown as DaemonClient,
    };

    const screen = new TaskInspectorScreen("t-512", deps);
    tui.start();
    nav.push(screen);
    await new Promise((r) => setTimeout(r, 0));

    const visible = compositeVisible(tui, terminal);
    const taskRowY = visible.findIndex((l) => {
      const p = stripTerminalSequences(l);
      return p.includes("Task") && p.includes("t-512 (Tier 2");
    });
    assert.ok(taskRowY >= 0, "TaskInspectorScreen must render the Task kv row");

    const plainTaskRow = stripTerminalSequences(visible[taskRowY]!);
    const startX = colOf(plainTaskRow, "t-512");
    const endX = startX + "t-512".length - 1;

    writes.length = 0;
    dragCells(sendInput, startX, taskRowY, endX, taskRowY);

    const copied = extractOsc52Payloads(writes);
    assert.equal(copied.length, 1, "drag-select on TaskInspectorScreen must emit one OSC 52 write");
    assert.equal(copied[0], "t-512");

    const afterPlain = compositeVisible(tui, terminal).map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(afterPlain.includes("Copied 5 chars"), `Expected "Copied 5 chars" notice in:\n${afterPlain}`);

    nav.closeAll();
    tui.stop();
  });

  it("drag-copies text from a real EscalationInspectorScreen (non-transcript modal)", async () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(100, 26);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);

    const now = Date.now();
    const deps: InspectorDeps = {
      repoRoot: "/tmp/repo",
      store: {
        getEscalation: () => undefined,
      } as unknown as WorkStore,
      client: {
        async request(method: string) {
          assert.equal(method, "escalation.get");
          return {
            escalation: {
              id: "esc-42",
              runId: "run-34",
              fromTaskId: "t-512",
              toTaskId: "t-507",
              severity: "P1",
              category: "interface_mismatch",
              title: "Need schema alignment",
              summary: "Schema fields differ.",
              blocking: true,
              status: "open",
              resolution: null,
              evidencePaths: ["src/tui/core/frame.ts"],
              attempted: [],
              suggestedSplits: [],
              createdAt: now - 10_000,
              updatedAt: now - 2_000,
            },
            fromTask: null,
            goal: null,
          };
        },
      } as unknown as DaemonClient,
    };

    const screen = new EscalationInspectorScreen("esc-42", deps);
    tui.start();
    nav.push(screen);
    await new Promise((r) => setTimeout(r, 0));

    const visible = compositeVisible(tui, terminal);
    const idRowY = visible.findIndex((l) => {
      const p = stripTerminalSequences(l);
      return p.includes("Escalation ID") && p.includes("esc-42");
    });
    assert.ok(idRowY >= 0, "EscalationInspectorScreen must render the Escalation ID row");

    const plainIdRow = stripTerminalSequences(visible[idRowY]!);
    const startX = colOf(plainIdRow, "esc-42");
    const endX = startX + "esc-42".length - 1;

    writes.length = 0;
    dragCells(sendInput, startX, idRowY, endX, idRowY);

    const copied = extractOsc52Payloads(writes);
    assert.equal(copied.length, 1);
    assert.equal(copied[0], "esc-42");

    const afterPlain = compositeVisible(tui, terminal).map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(afterPlain.includes("Copied 6 chars"), `Expected "Copied 6 chars" notice in:\n${afterPlain}`);

    nav.closeAll();
    tui.stop();
  });
});
