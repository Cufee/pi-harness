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
  openEntityInspector,
  TaskInspectorScreen,
} from "../src/tui/inspectors.js";
import { KbDetailScreen } from "../src/tui/pickers.js";
import type { WorkStore } from "../src/tui/store.js";

function makeFakeTerminal(cols = 100, rows = 26) {
  const writes: string[] = [];
  let onDataCb: ((data: string) => void) | null = null;
  let curCols = cols;
  let curRows = rows;
  const terminal: Terminal = {
    get columns() {
      return curCols;
    },
    get rows() {
      return curRows;
    },
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
    setSize: (nextCols: number, nextRows: number) => {
      curCols = nextCols;
      curRows = nextRows;
    },
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

  it("uses live height on height-only grow, cancels selection on height resize, and bounds copy to visible rows", () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput, setSize } = makeFakeTerminal(80, 16);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const frame = new Frame();
    const viewport = new Viewport();
    const bodyLines = Array.from({ length: 40 }, (_, i) => `row${String(i).padStart(2, "0")} item`);

    const screen: Screen = {
      title: "ResizeSheet",
      variant: "sheet",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["ResizeSheet"],
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
    const initial = compositeVisible(tui, terminal);
    const row0Y = initial.findIndex((l) => stripTerminalSequences(l).includes("row00 item"));
    assert.ok(row0Y >= 0);
    const row0X = colOf(stripTerminalSequences(initial[row0Y]!), "row00");

    // Select row00 before resizing height.
    dragCells(sendInput, row0X, row0Y, row0X + 4, row0Y);
    assert.ok(
      compositeVisible(tui, terminal).some((l) => l.includes(theme.badgeBg("row00"))),
      "row00 must be highlighted before height resize",
    );

    // Grow terminal height only (80x16 -> 80x28): selection must clear and compositor must show newly fitting rows.
    setSize(80, 28);
    const grown = compositeVisible(tui, terminal);
    assert.equal(
      grown.some((l) => l.includes(theme.badgeBg("row00"))),
      false,
      "height-only resize must cancel active selection",
    );

    // At rows=28, computeOverlayHeight(28, false) = floor(28 * 0.88) = 24.
    // With the notice row present: chrome = 6 + 1 (notice) + 2 (padY) = 9 -> 15 body rows (row00..row14).
    const plainGrown = grown.map((l) => stripTerminalSequences(l));
    assert.ok(
      plainGrown.some((l) => l.includes("row14 item")),
      "compositor must use live height after height-only grow so row14 becomes visible",
    );
    assert.equal(
      plainGrown.some((l) => l.includes("row15 item")),
      false,
      "row15 must remain scrolled off while notice occupies 1 row",
    );

    // Clear notice so body holds 16 rows (row00..row15), then drag from row15 past the bottom of the terminal.
    frame.setNotice("");
    const plainNoNotice = compositeVisible(tui, terminal).map((l) => stripTerminalSequences(l));
    assert.ok(plainNoNotice.some((l) => l.includes("row15 item")));
    assert.equal(plainNoNotice.some((l) => l.includes("row16 item")), false);
    const lastVisibleTag = "row15 item";
    const lastVisibleY = plainNoNotice.findIndex((l) => l.includes(lastVisibleTag));
    const startX = colOf(plainNoNotice[lastVisibleY]!, lastVisibleTag);

    // Drag from the last visible row all the way past the bottom of the terminal: must copy only that visible row.
    writes.length = 0;
    dragCells(sendInput, startX, lastVisibleY, startX + lastVisibleTag.length - 1, terminal.rows - 1);
    assert.deepEqual(extractOsc52Payloads(writes), [lastVisibleTag]);

    nav.closeAll();
    tui.stop();
  });

  it("invalidates selection when selected row text changes or captured frame disappears, while keeping unrelated repaints", () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(80, 18);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const frame = new Frame();
    let rows = ["row00 alpha", "row01 beta"];
    let useFrame = true;

    const screen: Screen = {
      title: "RefreshSheet",
      variant: "sheet",
      render(width, maxHeight, t) {
        if (!useFrame) return rows.slice(0, maxHeight);
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["RefreshSheet"],
          hints: [{ key: "Esc", label: "close" }],
          renderBody: () => rows,
        });
      },
      handleInput(data, ctx) {
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };

    tui.start();
    nav.push(screen);
    const visible = compositeVisible(tui, terminal);
    const row0Y = visible.findIndex((l) => stripTerminalSequences(l).includes("row00 alpha"));
    assert.ok(row0Y >= 0);
    const row0X = colOf(stripTerminalSequences(visible[row0Y]!), "row00");

    writes.length = 0;
    dragCells(sendInput, row0X, row0Y, row0X + 4, row0Y);
    assert.deepEqual(extractOsc52Payloads(writes), ["row00"]);

    // Unrelated row update preserves highlight.
    rows = ["row00 alpha", "row01 changed"];
    assert.ok(
      compositeVisible(tui, terminal).some((l) => l.includes(theme.badgeBg("row00"))),
      "unrelated repaint must preserve selection highlight",
    );

    // Changing selected row's text invalidates highlight and stops stale state from consuming Esc.
    rows = ["new00 alpha", "row01 changed"];
    const afterRefresh = compositeVisible(tui, terminal);
    assert.equal(
      afterRefresh.some((l) => l.includes(theme.badgeBg("new00"))),
      false,
      "refreshed text on selected row must not inherit stale highlight",
    );
    sendInput("\x1b");
    assert.equal(nav.isOpen, false, "Esc must pop immediately after selection was invalidated by refresh");

    // Re-open, select, then drop Frame capture: stale selection must not consume Esc.
    nav.push(screen);
    const visible2 = compositeVisible(tui, terminal);
    const new0Y = visible2.findIndex((l) => stripTerminalSequences(l).includes("new00 alpha"));
    const new0X = colOf(stripTerminalSequences(visible2[new0Y]!), "new00");
    dragCells(sendInput, new0X, new0Y, new0X + 4, new0Y);
    useFrame = false;
    compositeVisible(tui, terminal);
    sendInput("\x1b");
    assert.equal(nav.isOpen, false, "Esc must pop when captured frame disappears");

    // Unrelated change elsewhere on the same row (e.g. updating rightHeader) during drag must NOT cancel the copy.
    let rightHeader = "updated 1";
    const liveHeaderScreen: Screen = {
      title: "Worker t-17",
      variant: "sheet",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["Worker t-17"],
          rightHeader,
          hints: [{ key: "Esc", label: "close" }],
          renderBody: () => ["body line"],
        });
      },
      handleInput(data, ctx) {
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };
    nav.push(liveHeaderScreen);
    const hdrVisible = compositeVisible(tui, terminal);
    const hdrY = hdrVisible.findIndex((l) => stripTerminalSequences(l).includes("Worker t-17"));
    assert.ok(hdrY >= 0);
    const hdrX = colOf(stripTerminalSequences(hdrVisible[hdrY]!), "Worker");
    writes.length = 0;
    sendInput(`\x1b[<0;${hdrX + 1};${hdrY + 1}M`);
    sendInput(`\x1b[<32;${hdrX + "Worker".length};${hdrY + 1}M`);
    rightHeader = "updated 2";
    compositeVisible(tui, terminal);
    sendInput(`\x1b[<0;${hdrX + "Worker".length};${hdrY + 1}m`);
    assert.deepEqual(extractOsc52Payloads(writes), ["Worker"]);

    nav.closeAll();
    tui.stop();
  });

  it("lets default overlay selection drag subtitles on loaded ArtifactInspectorScreen and KbDetailScreen while keeping body drags on TranscriptView", async () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(100, 24);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);

    const artifactDeps: InspectorDeps = {
      repoRoot: "/tmp/repo",
      store: {} as unknown as WorkStore,
      client: {
        async request(method: string) {
          assert.equal(method, "artifact.read");
          return {
            content: "Artifact body first line\nArtifact body second line",
            totalChars: 50,
            hasMore: false,
          };
        },
      } as unknown as DaemonClient,
    };

    tui.start();
    openEntityInspector(
      { kind: "artifact", id: "artifacts/report.md", label: "report.md", runId: "run-34" },
      artifactDeps,
      {
        navigator: nav,
        theme,
        requestRender: () => nav.requestRender(),
        writeTerminal: (seq) => terminal.write(seq),
      },
    );
    await new Promise((r) => setTimeout(r, 0));

    const artVisible = compositeVisible(tui, terminal);
    const artSubY = artVisible.findIndex((l) => stripTerminalSequences(l).includes("artifacts/report.md"));
    assert.ok(artSubY >= 0, "ArtifactInspectorScreen subtitle must be visible");
    const artSubPlain = stripTerminalSequences(artVisible[artSubY]!);
    const artX0 = colOf(artSubPlain, "artifacts/report.md");
    const artX1 = artX0 + "artifacts/report.md".length - 1;

    writes.length = 0;
    dragCells(sendInput, artX0, artSubY, artX1, artSubY);
    assert.deepEqual(extractOsc52Payloads(writes), ["artifacts/report.md"]);

    // Body drag starting inside TranscriptView and dragging up onto subtitle stays owned by TranscriptView.
    const artBodyY = artVisible.findIndex((l) => stripTerminalSequences(l).includes("Artifact body first line"));
    assert.ok(artBodyY > artSubY);
    const artBodyPlain = stripTerminalSequences(artVisible[artBodyY]!);
    const bodyX0 = colOf(artBodyPlain, "Artifact");
    writes.length = 0;
    dragCells(sendInput, bodyX0 + 7, artBodyY, bodyX0, artSubY);
    assert.deepEqual(extractOsc52Payloads(writes), ["Artifact"]);

    // Subsequent subtitle drag (default owner) must clear TranscriptView's body highlight and prevent 'y' from recopying the stale body selection.
    const afterBodyDrag = compositeVisible(tui, terminal);
    const subY2 = afterBodyDrag.findIndex((l) => stripTerminalSequences(l).includes("artifacts/report.md"));
    const bodyY2 = afterBodyDrag.findIndex((l) => stripTerminalSequences(l).includes("Artifact body first line"));
    assert.ok(subY2 >= 0 && bodyY2 > subY2);
    assert.equal(
      afterBodyDrag[bodyY2]!.includes(theme.badgeBg("Artifact")),
      true,
      "body cell selection highlight should be active before subtitle drag",
    );
    const subX0 = colOf(stripTerminalSequences(afterBodyDrag[subY2]!), "artifacts/report.md");
    writes.length = 0;
    dragCells(sendInput, subX0, subY2, subX0 + "artifacts/report.md".length - 1, subY2);
    assert.deepEqual(extractOsc52Payloads(writes), ["artifacts/report.md"]);
    const afterHandoff = compositeVisible(tui, terminal);
    const bodyRowAfter = afterHandoff.find((l) => stripTerminalSequences(l).includes("Artifact body first line")) ?? "";
    const subRowAfter = afterHandoff.find((l) => stripTerminalSequences(l).includes("artifacts/report.md")) ?? "";
    assert.equal(
      bodyRowAfter.includes(theme.badgeBg("Artifact")),
      false,
      "body cell selection highlight must clear when subtitle drag takes ownership",
    );
    assert.equal(
      subRowAfter.includes(theme.badgeBg("artifacts/report.md")),
      true,
      "subtitle selection highlight must be active after handoff",
    );
    writes.length = 0;
    sendInput("y");
    assert.deepEqual(
      extractOsc52Payloads(writes),
      ["Artifact body first line\nArtifact body second line"],
      "'y' must not recopy the stale body cell selection after subtitle drag",
    );

    nav.pop();

    // KbDetailScreen loaded subtitle drag.
    const kbClient = {
      async request(method: string) {
        assert.equal(method, "kb.get");
        return [
          {
            id: "kb-7",
            kind: "invariant",
            title: "Gateway timeout fix",
            summary: "Retry on transient 504.",
            contextMd: "Details about gateway timeouts.",
            status: "active",
            confidence: "verified",
            tags: ["net"],
            pathGlobs: ["src/**"],
            hitCount: 3,
            evidencePaths: [],
          },
        ];
      },
    } as unknown as DaemonClient;
    const kbScreen = new KbDetailScreen(kbClient, {
      id: "kb-7",
      kind: "invariant",
      title: "Gateway timeout fix",
      summary: "Retry on transient 504.",
      status: "active",
      confidence: "verified",
      tags: ["net"],
      pathGlobs: ["src/**"],
      hitCount: 3,
      repoScope: "repo",
      verifiedSha: null,
    });
    nav.push(kbScreen);
    await new Promise((r) => setTimeout(r, 0));

    const kbVisible = compositeVisible(tui, terminal);
    const kbSubY = kbVisible.findIndex((l) => stripTerminalSequences(l).includes("Gateway timeout fix"));
    assert.ok(kbSubY >= 0, "KbDetailScreen subtitle must be visible");
    const kbSubPlain = stripTerminalSequences(kbVisible[kbSubY]!);
    const kbX0 = colOf(kbSubPlain, "Gateway timeout fix");
    const kbX1 = kbX0 + "Gateway timeout fix".length - 1;

    writes.length = 0;
    dragCells(sendInput, kbX0, kbSubY, kbX1, kbSubY);
    assert.deepEqual(extractOsc52Payloads(writes), ["Gateway timeout fix"]);

    nav.closeAll();
    tui.stop();
  });

  it("uses rendered Viewport geometry for scrollbars: keeps literal ASCII #/: suffixes and strips 1-row overflowing scrollbars", () => {
    const theme = createTheme({ color: true, ascii: true });
    const { terminal, writes, sendInput } = makeFakeTerminal(70, 16);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const frame = new Frame();

    // 1) Non-scrolling ASCII lines whose last two columns are literally " #" and " :" must NOT be stripped.
    const literalScreen: Screen = {
      title: "AsciiLiteral",
      variant: "dialog",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["AsciiLiteral"],
          hints: [{ key: "Esc", label: "close" }],
          renderBody: (innerW) => [
            `${"alpha".padEnd(innerW - 2)} #`,
            `${"beta".padEnd(innerW - 2)} :`,
          ],
        });
      },
      handleInput(data, ctx) {
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };

    tui.start();
    nav.push(literalScreen);
    const litVisible = compositeVisible(tui, terminal);
    const aY = litVisible.findIndex((l) => stripTerminalSequences(l).includes("alpha"));
    const bY = litVisible.findIndex((l) => stripTerminalSequences(l).includes("beta"));
    assert.ok(aY >= 0 && bY === aY + 1);
    const plainA = stripTerminalSequences(litVisible[aY]!);
    const plainB = stripTerminalSequences(litVisible[bY]!);
    const startX = colOf(plainA, "alpha");
    const endX = visibleWidth(plainB.slice(0, plainB.lastIndexOf(":")));

    writes.length = 0;
    dragCells(sendInput, startX, aY, endX, bY);
    const copiedLit = extractOsc52Payloads(writes);
    assert.equal(copiedLit.length, 1);
    assert.equal(copiedLit[0]!.split("\n")[0]!.endsWith(" #"), true, `Expected trailing " #" preserved, got ${JSON.stringify(copiedLit[0])}`);
    assert.equal(copiedLit[0]!.split("\n")[1]!.endsWith(" :"), true, `Expected trailing " :" preserved, got ${JSON.stringify(copiedLit[0])}`);

    nav.pop();

    // 2) Banner + 1-row overflowing Viewport in ASCII must strip the scrollbar "#" on the viewport row.
    const viewport = new Viewport();
    const oneRowScreen: Screen = {
      title: "BannerOneRow",
      variant: "dialog",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["BannerOneRow"],
          hints: [{ key: "Esc", label: "close" }],
          renderBody: (innerW) => [
            "Banner header",
            ...viewport.render(["item-one", "item-two", "item-three"], innerW, 1, t),
          ],
        });
      },
      handleInput(data, ctx) {
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };

    nav.push(oneRowScreen);
    const oneVisible = compositeVisible(tui, terminal);
    const banY = oneVisible.findIndex((l) => stripTerminalSequences(l).includes("Banner header"));
    const itemY = oneVisible.findIndex((l) => stripTerminalSequences(l).includes("item-one"));
    assert.ok(banY >= 0 && itemY === banY + 1);
    const plainBan = stripTerminalSequences(oneVisible[banY]!);
    const plainItem = stripTerminalSequences(oneVisible[itemY]!);
    assert.ok(plainItem.includes("#"), "1-row overflowing ASCII viewport must render '#' thumb");
    const bStartX = colOf(plainBan, "Banner");
    const hashX = visibleWidth(plainItem.slice(0, plainItem.lastIndexOf("#")));

    writes.length = 0;
    dragCells(sendInput, bStartX, banY, hashX, itemY);
    assert.deepEqual(extractOsc52Payloads(writes), ["Banner header\nitem-one"]);

    nav.pop();

    // 3) Overflowing 1-row ASCII/NO_COLOR Viewport followed by an identical literal row ending in " #":
    // only the real scrollbar row loses " #"; the identical literal row keeps its " #" suffix.
    const noColorAscii = createTheme({ color: false, ascii: true });
    const dupTerm = makeFakeTerminal(40, 14);
    const dupTui = new ModalScreen(dupTerm.terminal);
    const dupNav = new Navigator(dupTui, dupTerm.terminal, noColorAscii);
    const dupFrame = new Frame();
    const dupViewport = new Viewport();
    let capturedInnerW = 0;
    const dupScreen: Screen = {
      title: "DupRow",
      variant: "dialog",
      render(width, maxHeight, t) {
        return dupFrame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["DupRow"],
          hints: [{ key: "Esc", label: "close" }],
          renderBody: (innerW) => {
            capturedInnerW = innerW;
            return [
              ...dupViewport.render(["same-row", "second-row"], innerW, 1, t),
              `${"same-row".padEnd(innerW - 2)} #`,
            ];
          },
        });
      },
      handleInput(data, ctx) {
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };
    dupTui.start();
    dupNav.push(dupScreen);
    const dupVisible = compositeVisible(dupTui, dupTerm.terminal);
    const dupRows = dupVisible
      .map((l, idx) => ({ idx, plain: stripTerminalSequences(l) }))
      .filter((r) => r.plain.includes("same-row"));
    assert.equal(dupRows.length, 2);
    const vpRowY = dupRows[0]!.idx;
    const litRowY = dupRows[1]!.idx;
    const dupStartX = colOf(dupRows[0]!.plain, "same-row");
    const dupEndX = visibleWidth(dupRows[1]!.plain.slice(0, dupRows[1]!.plain.lastIndexOf("#")));
    dupTerm.writes.length = 0;
    dragCells(dupTerm.sendInput, dupStartX, vpRowY, dupEndX, litRowY);
    assert.deepEqual(extractOsc52Payloads(dupTerm.writes), [
      `same-row\n${"same-row".padEnd(capturedInnerW - 2)} #`,
    ]);
    dupNav.closeAll();
    dupTui.stop();

    nav.closeAll();
    tui.stop();
  });

  it("shows copy notice alongside active inline confirm and prompt without breaking confirmation or input", () => {
    const theme = createTheme({ color: false, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(90, 18);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const frame = new Frame();
    let confirmed = false;
    let submitted: string | null = null;

    const screen: Screen = {
      title: "InlineNotice",
      variant: "dialog",
      render(width, maxHeight, t) {
        return frame.render({
          width,
          maxHeight,
          theme: t,
          breadcrumbs: ["InlineNotice"],
          hints: [{ key: "Esc", label: "close" }],
          renderBody: () => ["Body copyable line"],
        });
      },
      handleInput(data, ctx) {
        if (frame.handleInlineInput(data, ctx.requestRender)) return;
        if (isPopKey(data, ctx)) ctx.navigator.pop();
      },
    };

    tui.start();
    nav.push(screen);

    // 1) Active confirm: dragging confirm label copies and renders "Copied 4 chars" alongside confirm; 'y' still confirms.
    frame.askConfirm({
      message: "Delete worker t-99?",
      onConfirm: () => {
        confirmed = true;
      },
    });
    const confirmVisible = compositeVisible(tui, terminal);
    const confirmY = confirmVisible.findIndex((l) => stripTerminalSequences(l).includes("Delete worker t-99?"));
    assert.ok(confirmY >= 0);
    const confirmX0 = colOf(stripTerminalSequences(confirmVisible[confirmY]!), "t-99");

    writes.length = 0;
    dragCells(sendInput, confirmX0, confirmY, confirmX0 + 3, confirmY);
    assert.deepEqual(extractOsc52Payloads(writes), ["t-99"]);

    const afterConfirmCopy = compositeVisible(tui, terminal).map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(afterConfirmCopy.includes("Delete worker t-99?"), "confirm message must remain visible");
    assert.ok(afterConfirmCopy.includes("Copied 4 chars"), `Expected "Copied 4 chars" alongside confirm in:\n${afterConfirmCopy}`);

    sendInput("y");
    assert.equal(confirmed, true, "'y' must still confirm after copying");
    assert.equal(frame.hasInlineModal, false);

    // 2) Active prompt: dragging body text copies and renders notice alongside prompt; typing + Enter still submits.
    frame.askPrompt({
      label: "Reason",
      onSubmit: (v) => {
        submitted = v;
      },
    });
    const promptVisible = compositeVisible(tui, terminal);
    const bodyY = promptVisible.findIndex((l) => stripTerminalSequences(l).includes("Body copyable line"));
    assert.ok(bodyY >= 0);
    const bodyX0 = colOf(stripTerminalSequences(promptVisible[bodyY]!), "copyable");

    writes.length = 0;
    dragCells(sendInput, bodyX0, bodyY, bodyX0 + "copyable".length - 1, bodyY);
    assert.deepEqual(extractOsc52Payloads(writes), ["copyable"]);

    const afterPromptCopy = compositeVisible(tui, terminal).map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(afterPromptCopy.includes("Reason:"), "prompt must remain visible");
    assert.ok(afterPromptCopy.includes("Copied 8 chars"), `Expected "Copied 8 chars" alongside prompt in:\n${afterPromptCopy}`);

    sendInput("o");
    sendInput("k");
    sendInput("\r");
    assert.equal(submitted, "ok", "typing and Enter must still submit prompt after copying");
    assert.equal(frame.hasInlineModal, false);

    // 3) Short dialog (maxHeight 7 with two body rows): both active prompt and copy notice remain visible.
    const shortFrame = new Frame();
    shortFrame.askPrompt({ label: "Reason", onSubmit: () => {} });
    shortFrame.setNotice("Copied 8 chars", "ok");
    const shortRendered = shortFrame.render({
      width: 72,
      maxHeight: 7,
      theme,
      breadcrumbs: ["ShortDialog"],
      hints: [{ key: "Esc", label: "close" }],
      renderBody: () => ["Body line 1", "Body line 2"],
    });
    assert.ok(shortRendered.length <= 7);
    const shortPlain = shortRendered.map((l) => stripTerminalSequences(l)).join("\n");
    assert.ok(shortPlain.includes("Reason:"), `Expected prompt visible at maxHeight 7 in:\n${shortPlain}`);
    assert.ok(shortPlain.includes("Copied 8 chars"), `Expected copy notice visible at maxHeight 7 in:\n${shortPlain}`);

    nav.closeAll();
    tui.stop();
  });
});
