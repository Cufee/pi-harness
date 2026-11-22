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
  fillLineBg,
  fit,
  FixedDock,
  Frame,
  handleTabKeys,
  ImmutableTranscript,
  layoutColumns,
  ListView,
  middleEllipsis,
  ModalScreen,
  Navigator,
  parseDurationMs,
  parseMouseWheel,
  RecentRefsRing,
  renderProgressBar,
  sanitizeLine,
  sanitizeText,
  type Screen,
  stripTerminalSequences,
  TableListView,
  TerminalSession,
  Viewport,
  visibleWidth,
  wrap,
} from "../src/tui/core/index.js";
import { renderToolOutput, type ToolDisplayPayload } from "../src/tui/tool-output/index.js";

function makeFakeTerminal(cols = 100, rows = 30) {
  const writes: string[] = [];
  let drainCalls = 0;
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
    async drainInput() {
      drainCalls += 1;
    },
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
    getDrainCalls: () => drainCalls,
    sendInput: (data: string) => onDataCb?.(data),
  };
}

describe("TUI v2 Core Primitives", () => {
  it("sanitizes terminal escape injection and enforces strict width safety across 20..200 cols", () => {
    const theme = createTheme({ color: true, ascii: false });
    const malicious = "\x1b]52;c;ZWF2aWw=\x07Hello\x1b[2J\x1b[31mWorld\r\nNext\x07Line";
    const clean = sanitizeText(malicious);
    assert.equal(clean.includes("\x1b"), false);
    assert.equal(clean.includes("\x07"), false);
    assert.ok(clean.includes("Hello"));
    assert.ok(clean.includes("Next"));
    assert.equal(sanitizeLine("  foo\nbar\tbaz  "), "foo bar baz");

    for (const width of [20, 40, 60, 80, 120, 200]) {
      assert.ok(visibleWidth(fit("a very long string that should never overflow the terminal width", width)) <= width);
      assert.ok(visibleWidth(clamp(theme.accentBold("styled overflow test ".repeat(8)), width)) <= width);
      assert.equal(visibleWidth(fillLineBg(theme.ok("surface text"), width, theme.surfaceBg)), width);
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

    // Progress bar & NO_COLOR fallback
    assert.ok(stripTerminalSequences(renderProgressBar(0.75, theme, { barWidth: 8 })).includes("75%"));
    const noColor = createTheme({ color: false, ascii: true });
    assert.equal(noColor.accentBold("plain").includes("\x1b"), false);
    assert.equal(noColor.tabActive("Goals"), "[Goals]");
  });

  it("preserves dimLine faint SGR styling across standalone and compound SGR resets and dims ModalScreen backdrops", () => {
    const dimmed1 = dimLine("\x1b[32mgreen\x1b[0m plain");
    assert.ok(dimmed1.includes("\x1b[0m\x1b[2m"));
    const dimmed2 = dimLine("\x1b[1;36mcyan\x1b[0;32mgreen\x1b[22;39mnormal");
    assert.ok(dimmed2.includes("\x1b[0;32m\x1b[2m"));
    assert.ok(dimmed2.includes("\x1b[22;39m\x1b[2m"));

    // Verify ModalScreen.compositeOverlays dims visible viewport beneath open overlays
    const theme = createTheme({ color: true, ascii: false });
    const { terminal } = makeFakeTerminal(80, 10);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    nav.push({
      title: "Modal",
      variant: "dialog",
      render: () => ["overlay line"],
      handleInput() {},
    });
    const baseLines = Array.from({ length: 14 }, (_, i) => `Base line ${i + 1}`);
    const composited = (tui as unknown as { compositeOverlays(l: string[], w: number, h: number): string[] }).compositeOverlays(
      baseLines,
      80,
      10,
    );
    // Scrollback above viewport (rows 0..3) untouched; visible viewport rows dimmed with \x1b[2m
    assert.equal(composited[0], "Base line 1");
    assert.ok(composited[4]!.startsWith("\x1b[2m"), "Visible viewport behind overlay must be dimmed");
    nav.closeAll();
  });

  it("handles Viewport scrolling, SGR mouse wheel (without snapping back), aligned TableListView, and fuzzy filter", () => {
    const theme = createTheme({ color: true, ascii: false });
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

    // TableListView sticky header + badgeBg highlight + wheel scroll NOT snapping back to selectedIdx=0
    const table = new TableListView<number>({
      columns: [
        { key: "id", header: "ID", width: 8, priority: 0 },
        { key: "name", header: "NAME", minWidth: 16, priority: 0 },
      ],
    });
    table.setTableItems(
      Array.from({ length: 20 }, (_, i) => ({
        id: `row-${i + 1}`,
        value: i + 1,
        searchText: `row-${i + 1} item ${i + 1}`,
        cells: (sel, t) => ({
          id: sel ? t.accentBold(`row-${i + 1}`) : t.bold(`row-${i + 1}`),
          name: `Item number ${i + 1}`,
        }),
      })),
    );
    const initial = table.render(50, 7, theme);
    assert.ok(stripTerminalSequences(initial[0]!).includes("ID") && stripTerminalSequences(initial[0]!).includes("NAME"));
    assert.ok(initial[2]!.includes("\x1b[48;"), "Selected row must paint full-width badgeBg surface");
    assert.equal(initial.some((l) => l.includes("\x1b[7m")), false, "Must not use harsh reverse video");

    // Scroll down with SGR mouse wheel (selection stays at index 0, viewport scrolls freely!)
    table.handleInput("\x1b[<65;10;5M\x1b[<65;10;5M");
    const afterWheel = table.render(50, 7, theme);
    assert.equal(table.selectedIndex, 0);
    assert.equal(afterWheel.some((l) => stripTerminalSequences(l).includes("Item number 1 ")), false);
    assert.ok(afterWheel.some((l) => stripTerminalSequences(l).includes("Item number 7")));

    // Keyboard down snaps back cleanly
    table.handleInput("j");
    assert.equal(table.selectedIndex, 1);
    const afterKey = table.render(50, 7, theme);
    assert.ok(afterKey.some((l) => stripTerminalSequences(l).includes("Item number 2")));

    // Fuzzy filter + layered Escape
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
    // Esc clears lingering filter query before popping screen
    assert.equal(list.handleEscape(), true);
    assert.equal(list.query, "");
    assert.equal(list.handleEscape(), false);
  });

  it("renders rounded Frame chrome with paddingX=2, surfaceBg, footer rule, Left/Right tab helper, and allowEmpty prompt", async () => {
    const theme = createTheme({ color: true, ascii: false });
    const frame = new Frame();

    // Test unified tab helper (Left/Right, Tab/Shift+Tab, 1-3)
    const tabs = ["a", "b", "c"] as const;
    let active: (typeof tabs)[number] = "a";
    assert.equal(handleTabKeys("\x1b[C", tabs, active, (n) => (active = n)), true);
    assert.equal(active, "b");
    assert.equal(handleTabKeys("\x1b[D", tabs, active, (n) => (active = n)), true);
    assert.equal(active, "a");
    assert.equal(handleTabKeys("3", tabs, active, (n) => (active = n)), true);
    assert.equal(active, "c");

    // Test allowEmpty inline prompt (clearing Quota Endpoint URL)
    let submitted: string | undefined;
    frame.askPrompt({
      label: "Quota Endpoint URL",
      allowEmpty: true,
      onSubmit: (v) => {
        submitted = v;
      },
    });
    const rendered = frame.render({
      width: 72,
      maxHeight: 16,
      theme,
      breadcrumbs: ["Settings"],
      tabs: [
        { id: "a", label: "CLIs", count: 2 },
        { id: "b", label: "Models" },
      ],
      activeTabId: "a",
      hints: [{ key: "Esc", label: "close" }],
      renderBody: () => Array.from({ length: 30 }, (_, i) => `Body line ${i}`),
    });
    assert.ok(rendered.length <= 16, `Frame exceeded maxHeight: ${rendered.length}`);
    for (const l of rendered) assert.equal(visibleWidth(l), 72);
    assert.ok(stripTerminalSequences(rendered[0]!).startsWith("╭"));
    assert.ok(stripTerminalSequences(rendered[rendered.length - 1]!).startsWith("╰"));
    // Explicit rule above footer hints
    assert.ok(stripTerminalSequences(rendered[rendered.length - 3]!).startsWith("├"));
    assert.equal(frame.handleInlineInput("\r", () => {}), true);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(submitted, "");
  });

  it("never enables mouse tracking on main screen and scopes mouse wheel strictly to Navigator overlays", () => {
    const theme = createTheme({ color: false });
    const { terminal, writes } = makeFakeTerminal();
    const tui = new ModalScreen(terminal);
    tui.start();
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
    assert.equal(writes.slice(prevWrites).includes(ENABLE_MOUSE_WHEEL_SEQ), false);

    nav.pop();
    assert.equal(nav.isOpen, true);
    assert.equal(writes.includes(DISABLE_MOUSE_WHEEL_SEQ), false);

    nav.pop();
    assert.equal(nav.isOpen, false);
    assert.ok(writes.includes(DISABLE_MOUSE_WHEEL_SEQ));
    tui.stop();
  });

  it("enforces bulletproof TerminalSession lifecycle: drainInput, Ctrl+C draft clear/2x exit, Ctrl+D empty idle exit, and double-Esc cancel", async () => {
    // 1. Ctrl+C clears draft -> double Ctrl+C exits -> drainInput called before stop
    {
      const { terminal, getDrainCalls, sendInput } = makeFakeTerminal();
      let draft = "unsent draft";
      let beforeExitCalled = false;
      const hints: Array<string | null> = [];
      const ts = new TerminalSession({
        terminal,
        getComposerText: () => draft,
        clearComposerText: () => {
          draft = "";
        },
        isOverlayOpen: () => false,
        isBusy: () => false,
        onTransientHint: (m) => hints.push(m),
        onBeforeExit: async () => {
          beforeExitCalled = true;
        },
      });
      ts.start();
      sendInput("\x03"); // First Ctrl+C clears unsent draft
      assert.equal(draft, "");
      assert.ok(hints.some((h) => h?.includes("Draft cleared")));
      sendInput("\x03"); // Second Ctrl+C exits cleanly
      await ts.done;
      assert.equal(getDrainCalls(), 1, "drainInput must run before tui.stop()");
      assert.equal(beforeExitCalled, true);
    }

    // 2. Ctrl+D on empty idle input exits cleanly
    {
      const { terminal, sendInput } = makeFakeTerminal();
      const ts = new TerminalSession({
        terminal,
        getComposerText: () => "",
        isOverlayOpen: () => false,
        isBusy: () => false,
      });
      ts.start();
      sendInput("\x04");
      await ts.done;
    }

    // 3. Double-Esc cancel confirmation while busy
    {
      const { terminal, sendInput } = makeFakeTerminal();
      let cancelled = 0;
      const hints: Array<string | null> = [];
      const ts = new TerminalSession({
        terminal,
        getComposerText: () => "",
        isOverlayOpen: () => false,
        isBusy: () => true,
        onCancelActiveTurn: () => {
          cancelled += 1;
        },
        onTransientHint: (m) => hints.push(m),
      });
      ts.start();
      sendInput("\x1b"); // First Esc arms confirm
      assert.equal(cancelled, 0);
      assert.ok(hints.some((h) => h?.includes("Press Esc again")));
      sendInput("\x1b"); // Second Esc cancels turn
      assert.equal(cancelled, 1);
      await ts.stop();
    }
  });

  it("keeps ImmutableTranscript blocks frozen (including Tool-Output cards), FixedDock height strictly constant, and UndoableEditor undo working", () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal } = makeFakeTerminal();
    const tui = new ModalScreen(terminal);

    // 1. ImmutableTranscript: UserCard, AssistantCard, Tool-Output cards (goals_table, goal_detail, run_activity)
    const tr = new ImmutableTranscript(theme);
    tr.appendBanner("pi-harness · chat-1", "acp:codex · gpt-6.2");
    tr.appendUserTurn("Build the new TUI");

    const goalsDisplay: ToolDisplayPayload = {
      kind: "goals_table",
      title: "Session Goals",
      data: {
        goals: [
          {
            id: "goal-1",
            version: 2,
            status: "executing",
            title: "Craft Pass 2 TUI",
            linkedRunId: "run-1",
            reviewCycle: 1,
            maxReviewCycles: 4,
            criteriaTotal: 2,
            criteriaPassed: 1,
            openEscalations: 1,
          },
        ],
      },
    };
    const detailDisplay: ToolDisplayPayload = {
      kind: "goal_detail",
      data: {
        goal: { id: "goal-1", version: 2, status: "executing", title: "Craft Pass 2 TUI", linkedRunId: "run-1" },
        criteria: [{ id: "c1", description: "Typecheck passes", lastResult: "pass", command: "bun run typecheck" }],
        tasks: [{ id: "t1", tier: 2, kind: "worker", status: "running", title: "Polish dock", model: "gpt-6.2", toolCalls: 4, elapsedMs: 12000 }],
        openEscalations: [{ id: "esc-1", taskId: "t1", summary: "Need approval" }],
      },
    };
    const runDisplay: ToolDisplayPayload = {
      kind: "run_activity",
      data: {
        runId: "run-1",
        phase: "active",
        elapsedMs: 42000,
        filesEdited: 3,
        modelsUsed: ["gpt-6.2"],
        tasks: [{ id: "t1", tier: 2, kind: "worker", status: "running", title: "Polish dock", toolCalls: 5, filesEdited: 2, elapsedMs: 20000 }],
      },
    };

    for (const disp of [goalsDisplay, detailDisplay, runDisplay]) {
      for (const w of [60, 80, 120]) {
        const cardLines = renderToolOutput(disp, w, theme);
        assert.ok(cardLines.length >= 2);
        for (const l of cardLines) assert.ok(visibleWidth(l) <= w, `${disp.kind} overflowed ${w}`);
      }
      tr.appendToolOutput(disp);
    }

    tr.appendAssistantTurn("All goals are **on track**.\n```ts\nconst x = 42;\n```", "acp:codex · gpt-6.2");
    tr.appendReceipt({ tag: "esc-1", tone: "danger", text: "Blocking migration error" });

    const before = tr.render(80);
    assert.ok(before.some((l) => stripTerminalSequences(l).includes("▎ › Build the new TUI")));
    assert.ok(before.some((l) => stripTerminalSequences(l).includes("◆ acp:codex · gpt-6.2")));
    assert.ok(before.some((l) => stripTerminalSequences(l).includes("Craft Pass 2 TUI")));

    tr.liveTail.begin("acp:codex · gpt-6.2");
    tr.liveTail.appendText("Streaming reply...");
    const during = tr.render(80);
    assert.deepEqual(during.slice(0, before.length), before, "Frozen blocks above tail must NEVER mutate");

    // 2. FixedDock: constant row count across idle, 5 attention slots, busy spinner, queued, and transient hint
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
    const idleLines = dock.render(80);
    const idleH = idleLines.length;
    assert.ok(idleLines.some((l) => stripTerminalSequences(l).startsWith("› ")), "Composer must show › prompt cue");

    dock.update({
      slots: [
        { slot: 1, label: "esc-1", status: "p0", badge: "P0", ref: { kind: "escalation", id: "esc-1", label: "esc-1" } },
        { slot: 2, label: "goal-2", status: "executing", badge: "2w", ref: { kind: "goal", id: "goal-2", label: "goal-2" } },
      ],
      busy: true,
      phaseText: "Running goal_get...",
      queuedCount: 3,
    });
    const busyLines = dock.render(80);
    assert.equal(busyLines.length, idleH, `FixedDock height must stay constant (idle=${idleH}, busy=${busyLines.length})`);
    assert.ok(busyLines.some((l) => stripTerminalSequences(l).includes("[Alt+1]")));

    dock.update({ transientHint: "Press Esc again to stop active turn" });
    assert.equal(dock.render(80).length, idleH, "Transient hint must not change dock height");

    // 3. UndoableEditor directly captures normal typing sent to dock.editor
    dock.editor.handleInput("h");
    dock.editor.handleInput("i");
    assert.equal(dock.editor.getText(), "hi");
    dock.editor.handleInput("\x1a"); // Ctrl+Z
    assert.equal(dock.editor.getText(), "h");

    // 4. RecentRefsRing & slash commands
    const ring = new RecentRefsRing(3);
    ring.push({ kind: "goal", id: "g1", label: "g1" });
    ring.push({ kind: "escalation", id: "e1", label: "e1" });
    assert.equal(ring.latest()?.id, "e1");
    assert.equal(parseSlashCommand("/esc")?.name, "escalations");
    assert.equal(parseSlashCommand("/stop urgent")?.name, "stop");
    assert.equal(parseSlashCommand("/stop urgent")?.args, "urgent");
    assert.equal(parseDurationMs("1h30m"), 5_400_000);
    assert.equal(parseDurationMs("-5m"), null);
    assert.equal(parseDurationMs("1h garbage"), null);
    const help = renderHelp("chat").join("\n");
    assert.ok(help.includes("Ctrl+G"));
    assert.ok(help.includes("Ctrl+T"));
    assert.ok(help.includes("Ctrl+,"));
    assert.ok(help.includes("Ctrl+O"));
    assert.ok(help.includes("Ctrl+X"));
    assert.ok(help.includes("/stop"));
  });
});
