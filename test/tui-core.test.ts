import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { parseSlashCommand, renderHelp } from "../src/tui/commands.js";
import {
  clamp,
  createTheme,
  dimLine,
  DISABLE_MOUSE_WHEEL_SEQ,
  ENABLE_MOUSE_WHEEL_SEQ,
  fit,
  FixedDock,
  Frame,
  ImmutableTranscript,
  layoutColumns,
  ListView,
  middleEllipsis,
  ModalScreen,
  Navigator,
  parseDurationMs,
  parseMouseWheel,
  RecentRefsRing,
  sanitizeLine,
  sanitizeText,
  type Screen,
  Viewport,
  visibleWidth,
  wrap,
} from "../src/tui/core/index.js";

function makeFakeTerminal(cols = 100, rows = 30) {
  const writes: string[] = [];
  const terminal: Terminal = {
    columns: cols,
    rows,
    kittyProtocolActive: false,
    start() {},
    stop() {},
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
  return { terminal, writes };
}

describe("TUI v2 Core Primitives", () => {
  it("sanitizes terminal escape injection and enforces strict width safety across 20..200 cols", () => {
    const theme = createTheme({ color: true });
    const malicious = "\x1b]52;c;ZWF2aWw=\x07Hello\x1b[2J\x1b[31mWorld\r\nNext\x07Line";
    const clean = sanitizeText(malicious);
    assert.equal(clean.includes("\x1b"), false);
    assert.equal(clean.includes("\x07"), false);
    assert.ok(clean.includes("Hello"));
    assert.ok(clean.includes("Next"));
    assert.equal(sanitizeLine("  foo\nbar\tbaz  "), "foo bar baz");

    for (const width of [20, 40, 80, 120, 200]) {
      assert.ok(visibleWidth(fit("a very long string that should never overflow the terminal width", width)) <= width);
      assert.ok(visibleWidth(clamp(theme.accentBold("styled overflow test ".repeat(8)), width)) <= width);
      assert.ok(visibleWidth(middleEllipsis("/Users/dev/project/src/tui/deeply/nested/component.ts", width)) <= width);
      for (const l of wrap("Paragraph with\nmultiple lines and verylongidentifierwithoutspaces_".repeat(3), width)) {
        assert.ok(visibleWidth(l) <= width, `wrap overflowed ${width}: ${visibleWidth(l)}`);
      }
      const cols = layoutColumns(
        [
          { key: "id", header: "ID", width: 10, priority: 0 },
          { key: "title", header: "Title", minWidth: 10, priority: 0 },
          { key: "meta", header: "Updated", width: 14, priority: 2 },
        ],
        [{ id: "goal-123456", title: "Implement fresh TUI primitives cleanly", meta: "2m ago" }],
        width,
      );
      for (const l of cols) {
        assert.ok(visibleWidth(l) <= width, `layoutColumns overflowed ${width}: ${visibleWidth(l)}`);
      }
    }
  });

  it("preserves dimLine faint SGR styling across standalone and compound SGR resets", () => {
    const dimmed1 = dimLine("\x1b[32mgreen\x1b[0m plain");
    assert.ok(dimmed1.includes("\x1b[0m\x1b[2m"));
    const dimmed2 = dimLine("\x1b[1;36mcyan\x1b[0;32mgreen\x1b[22;39mnormal");
    assert.ok(dimmed2.includes("\x1b[0;32m\x1b[2m"));
    assert.ok(dimmed2.includes("\x1b[22;39m\x1b[2m"));
  });

  it("handles Viewport scrolling, SGR mouse wheel, and ListView fuzzy filter", () => {
    const theme = createTheme({ color: false });
    assert.deepEqual(parseMouseWheel("\x1b[<64;10;5M"), { delta: -3, hadMouse: true });
    assert.deepEqual(parseMouseWheel("\x1b[<65;10;5M\x1b[<65;10;5M"), { delta: 6, hadMouse: true });
    assert.deepEqual(parseMouseWheel("j"), { delta: 0, hadMouse: false });

    const vp = new Viewport({ follow: true });
    const lines = Array.from({ length: 30 }, (_, i) => `Row ${i + 1}`);
    const atBottom = vp.render(lines, 40, 5, theme);
    assert.ok(atBottom.some((l) => l.includes("Row 30")));
    vp.scrollBy(-10);
    assert.equal(vp.follow, false);
    const scrolled = vp.render(lines, 40, 5, theme);
    assert.equal(scrolled.some((l) => l.includes("Row 30")), false);

    const list = new ListView<string>();
    list.setItems([
      { id: "esc-1", value: "esc-1", searchText: "esc-1 P0 database migration timeout", render: (w) => fit("esc-1 migration", w) },
      { id: "goal-2", value: "goal-2", searchText: "goal-2 rewrite tui primitives", render: (w) => fit("goal-2 tui", w) },
    ]);
    list.handleInput("/");
    assert.equal(list.isFiltering, true);
    for (const ch of "tui") list.handleInput(ch);
    assert.equal(list.items.length, 1);
    assert.equal(list.selectedItem()?.id, "goal-2");
    assert.equal(list.handleInput("\r"), "select");
  });

  it("bounds Frame strictly to maxHeight and handles inline confirm & prompt", async () => {
    const theme = createTheme({ color: false });
    const frame = new Frame();
    let confirmed = false;
    frame.askConfirm({
      message: "Cancel goal-3?",
      onConfirm: () => {
        confirmed = true;
      },
    });
    const rendered = frame.render({
      width: 60,
      maxHeight: 12,
      theme,
      breadcrumbs: ["Work", "Goals", "goal-3"],
      hints: [{ key: "Esc", label: "back" }],
      renderBody: () => Array.from({ length: 40 }, (_, i) => `Body line ${i}`),
    });
    assert.ok(rendered.length <= 12, `Frame exceeded maxHeight: ${rendered.length}`);
    for (const l of rendered) assert.ok(visibleWidth(l) <= 60);
    assert.ok(rendered.some((l) => l.includes("Cancel goal-3?")));
    assert.equal(frame.handleInlineInput("y", () => {}), true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(confirmed, true);
  });

  it("never enables mouse tracking on main screen and scopes mouse wheel strictly to Navigator overlays", () => {
    const theme = createTheme({ color: false });
    const { terminal, writes } = makeFakeTerminal();
    const tui = new ModalScreen(terminal);
    tui.start();
    // Main screen MUST NOT emit mouse tracking enable sequence
    assert.equal(writes.some((w) => w.includes(ENABLE_MOUSE_WHEEL_SEQ)), false);

    const nav = new Navigator(tui, terminal, theme);
    const dummyScreen: Screen = {
      title: "TestSheet",
      variant: "sheet",
      render: () => ["ok"],
      handleInput() {},
    };
    nav.push(dummyScreen);
    assert.equal(nav.isOpen, true);
    assert.deepEqual(nav.breadcrumbs, ["TestSheet"]);
    assert.ok(writes.includes(ENABLE_MOUSE_WHEEL_SEQ));

    const prevWrites = writes.length;
    nav.push({ ...dummyScreen, title: "Child" });
    assert.deepEqual(nav.breadcrumbs, ["TestSheet", "Child"]);
    // Should not emit duplicate enable
    assert.equal(writes.slice(prevWrites).includes(ENABLE_MOUSE_WHEEL_SEQ), false);

    nav.pop();
    assert.equal(nav.isOpen, true);
    assert.equal(writes.includes(DISABLE_MOUSE_WHEEL_SEQ), false);

    nav.pop();
    assert.equal(nav.isOpen, false);
    assert.ok(writes.includes(DISABLE_MOUSE_WHEEL_SEQ));
    tui.stop();
  });

  it("keeps ImmutableTranscript blocks frozen and FixedDock height strictly constant", () => {
    const theme = createTheme({ color: false });
    const { terminal } = makeFakeTerminal();
    const tui = new ModalScreen(terminal);

    // 1. ImmutableTranscript: previously committed rows NEVER mutate when new turns/receipts arrive
    const tr = new ImmutableTranscript(theme);
    tr.appendUserTurn("Build the new TUI");
    tr.appendReceipt({ tag: "esc-1", tone: "danger", text: "Blocking migration error" });
    const before = tr.render(80);
    tr.liveTail.begin();
    tr.liveTail.appendText("Streaming reply...");
    const during = tr.render(80);
    assert.deepEqual(during.slice(0, before.length), before, "Frozen blocks above tail must NEVER mutate");

    // 2. FixedDock: constant row count across idle, 5 attention slots, busy spinner, and queued messages
    const dock = new FixedDock(tui, theme, {
      onSubmit: () => {},
      initialState: {
        slots: [],
        idleBanner: "Ready",
        busy: false,
        phaseText: "Ready",
        rightStatus: "codex · gpt-6.2",
        queuedCount: 0,
        hints: [{ key: "Ctrl+G", label: "Work" }],
      },
    });
    const idleH = dock.render(80).length;
    dock.update({
      slots: [
        { slot: 1, label: "esc-1", status: "p0", badge: "P0", ref: { kind: "escalation", id: "esc-1", label: "esc-1" } },
        { slot: 2, label: "goal-2", status: "executing", badge: "2w", ref: { kind: "goal", id: "goal-2", label: "goal-2" } },
      ],
      busy: true,
      phaseText: "Running goal_get...",
      queuedCount: 3,
    });
    const busyH = dock.render(80).length;
    assert.equal(busyH, idleH, `FixedDock height must stay constant (idle=${idleH}, busy=${busyH})`);

    // 3. RecentRefsRing & slash commands
    const ring = new RecentRefsRing(3);
    ring.push({ kind: "goal", id: "g1", label: "g1" });
    ring.push({ kind: "escalation", id: "e1", label: "e1" });
    assert.equal(ring.latest()?.id, "e1");
    assert.equal(parseSlashCommand("/esc")?.name, "escalations");
    assert.equal(parseSlashCommand("/stop urgent")?.name, "stop");
    assert.equal(parseSlashCommand("/stop urgent")?.args, "urgent");
    assert.equal(parseDurationMs("1h30m"), 5_400_000);
    const help = renderHelp("chat").join("\n");
    assert.ok(help.includes("Ctrl+G"));
    assert.ok(help.includes("Ctrl+O"));
    assert.ok(help.includes("Ctrl+X"));
    assert.ok(help.includes("/stop"));
  });
});
