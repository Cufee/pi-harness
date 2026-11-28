import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getCapabilities, type OverlayHandle, setCapabilities, type Terminal } from "@earendil-works/pi-tui";
import type { EventRecord } from "../src/control-plane/db.js";
import type { DaemonClient } from "../src/daemon/remote.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { parseSlashCommand, renderHelp } from "../src/tui/commands.js";
import {
  clamp,
  createTheme,
  dimLine,
  DISABLE_MOUSE_SEQ,
  ENABLE_MOUSE_SEQ,
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
import { type InspectorDeps, LiveTranscriptScreen } from "../src/tui/inspectors.js";
import type { WorkStore } from "../src/tui/store.js";
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

    // Scroll down with SGR mouse wheel (viewport scrolls freely AND selection clamps into view so Enter acts on a visible row!)
    table.handleInput("\x1b[<65;10;5M\x1b[<65;10;5M");
    const afterWheel = table.render(50, 7, theme);
    assert.equal(table.selectedIndex, 6);
    assert.equal(afterWheel.some((l) => stripTerminalSequences(l).includes("Item number 1 ")), false);
    assert.ok(afterWheel.some((l) => stripTerminalSequences(l).includes("Item number 7")));

    // Keyboard down advances from visible clamped selection cleanly
    table.handleInput("j");
    assert.equal(table.selectedIndex, 7);
    const afterKey = table.render(50, 7, theme);
    assert.ok(afterKey.some((l) => stripTerminalSequences(l).includes("Item number 8")));

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
    assert.equal(writes.some((w) => w.includes(ENABLE_MOUSE_SEQ)), false);

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
    assert.ok(writes.includes(ENABLE_MOUSE_SEQ));

    const prevWrites = writes.length;
    nav.push({ ...dummyScreen, title: "Child" });
    assert.deepEqual(nav.breadcrumbs, ["TestSheet", "Child"]);
    assert.equal(writes.slice(prevWrites).includes(ENABLE_MOUSE_SEQ), false);

    nav.pop();
    assert.equal(nav.isOpen, true);
    assert.equal(writes.includes(DISABLE_MOUSE_SEQ), false);

    nav.pop();
    assert.equal(nav.isOpen, false);
    assert.ok(writes.includes(DISABLE_MOUSE_SEQ));
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

  it("keeps ImmutableTranscript blocks frozen (including Tool-Output cards), FixedDock height strictly constant, and UndoableEditor undo working", async () => {
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

    // 2. FixedDock: constant row count across idle, active/blocked work row, busy spinner, queued, and transient hint
    const dock = new FixedDock(tui, theme, {
      onSubmit: () => {},
      initialState: {
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
      work: { active: 2, blocked: 1, blockedLabel: "goal-2 needs your input" },
      busy: true,
      phaseText: "Running goal_get...",
      queuedCount: 3,
    });
    const busyLines = dock.render(80);
    assert.equal(busyLines.length, idleH, `FixedDock height must stay constant (idle=${idleH}, busy=${busyLines.length})`);
    assert.ok(busyLines.some((l) => stripTerminalSequences(l).includes("2 active")));
    assert.ok(busyLines.some((l) => stripTerminalSequences(l).includes("1 blocked")));

    dock.update({ transientHint: "Press Esc again to stop active turn" });
    assert.equal(dock.render(80).length, idleH, "Transient hint must not change dock height");

    // 3. UndoableEditor delegates Ctrl+Z to base Editor native undo (coalesced words undo all the way to "" and preserve paste payloads)
    dock.editor.handleInput("h");
    dock.editor.handleInput("i");
    dock.editor.handleInput(" ");
    dock.editor.handleInput("y");
    assert.equal(dock.editor.getText(), "hi y");
    dock.editor.handleInput("\x1a"); // Ctrl+Z undoes " y"
    assert.equal(dock.editor.getText(), "hi");
    dock.editor.handleInput("\x1a"); // Ctrl+Z undoes "hi" back to ""
    assert.equal(dock.editor.getText(), "");

    // 3b. ImmutableTranscript mid-turn appendToolOutput freezes earlier live text in exact chronological order
    const trMid = new ImmutableTranscript(theme);
    trMid.liveTail.begin("gpt-6.2");
    trMid.liveTail.appendText("INTRO-SEGMENT");
    trMid.appendToolOutput({ kind: "goals_table", title: "Session Goals", data: { goals: [] } });
    trMid.liveTail.appendText("FINAL-SEGMENT");
    const midText = trMid.render(80).map(stripTerminalSequences).join("\n");
    assert.ok(midText.indexOf("INTRO-SEGMENT") < midText.indexOf("Goals"), "INTRO-SEGMENT must stay above mid-turn card");
    assert.ok(midText.indexOf("Goals") < midText.indexOf("FINAL-SEGMENT"), "FINAL-SEGMENT must render below mid-turn card");

    // 3c. Floating slash-command autocomplete keeps total line count constant (never shifts input up!) and emits 0 scrollback wipes
    const { terminal: acTerm, writes: acWrites } = makeFakeTerminal(80, 24);
    const acTui = new ModalScreen(acTerm);
    const acTranscript = new ImmutableTranscript(theme);
    for (let i = 0; i < 24; i++) acTranscript.appendLines([`History line ${i + 1}`]);
    const acDock = new FixedDock(acTui, theme, {
      autocomplete: {
        getSuggestions: async () => ({
          prefix: "/",
          items: [
            { value: "projects", label: "projects", description: "Manage projects" },
            { value: "work", label: "work", description: "Work Navigator" },
            { value: "settings", label: "settings", description: "Settings" },
          ],
        }),
        applyCompletion: (_lines, line, _col, item) => ({ lines: [`/${item.value} `], cursorLine: line, cursorCol: item.value.length + 2 }),
      },
      onSubmit: () => {},
      initialState: {
        idleBanner: "Ready",
        busy: false,
        phaseText: "Ready",
        rightStatus: "codex",
        queuedCount: 0,
        hints: [{ key: "Ctrl+P", label: "Projects" }],
      },
    });
    acDock.editor.floatAutocomplete = true;
    acTui.addChild(acTranscript);
    acTui.addChild(acDock);
    acTui.setFocus(acDock.editor);
    acTui.setFloatingPopupProvider((w) => {
      const ac = acDock.editor.getFloatingAutocompleteLines();
      return ac.length ? { lines: ac.map((l) => fit(l, w)), bottomOffset: acDock.renderedHeight } : null;
    });
    acTui.start();
    const linesBefore = acTui.render(80);
    (acTui as unknown as { doRender: () => void }).doRender();
    acWrites.length = 0;

    // Type `/` to open slash autocomplete
    acDock.editor.handleInput("/");
    await new Promise((r) => setTimeout(r, 20));
    const linesDuring = acTui.render(80);
    (acTui as unknown as { doRender: () => void }).doRender();
    assert.equal(linesDuring.length, linesBefore.length, "Slash autocomplete must NEVER grow line count or shift input up");
    assert.ok(linesDuring.map(stripTerminalSequences).join("\n").includes("projects"), "Floating popup must show suggestions");

    // Press Esc to dismiss slash autocomplete
    acDock.editor.handleInput("\x1b");
    const linesAfter = acTui.render(80);
    (acTui as unknown as { doRender: () => void }).doRender();
    assert.equal(linesAfter.length, linesBefore.length, "Dismissing slash autocomplete must keep exact line count");
    assert.equal(acWrites.filter((w) => w.includes("\x1b[3J")).length, 0, "Slash autocomplete open/close must emit 0 scrollback wipes");
    acTui.stop();

    // 4. RecentRefsRing & slash commands
    const ring = new RecentRefsRing(3);
    ring.push({ kind: "goal", id: "g1", label: "g1" });
    ring.push({ kind: "escalation", id: "e1", label: "e1" });
    assert.equal(ring.latest()?.id, "e1");
    assert.equal(parseSlashCommand("/goals")?.name, "work");
    assert.equal(parseSlashCommand("/tree")?.name, "work");
    assert.equal(parseSlashCommand("/stop urgent")?.name, "stop");
    assert.equal(parseSlashCommand("/stop urgent")?.args, "urgent");
    assert.equal(parseDurationMs("1h30m"), 5_400_000);
    assert.equal(parseDurationMs("-5m"), null);
    assert.equal(parseDurationMs("1h garbage"), null);
    const help = renderHelp("chat").join("\n");
    assert.ok(help.includes("Ctrl+G"));
    assert.ok(help.includes("Ctrl+,"));
    assert.ok(help.includes("Ctrl+X"));
    assert.ok(help.includes("/stop"));
  });

  it("preserves Markdown newlines, bullet lists, and code blocks in sanitizeText, LiveTurnTail, and ImmutableTranscript", () => {
    const raw = "## Plan\n\nLine 1\nLine 2\n\n- item A\n- item B\n\n```ts\nconst x = 1;\nconsole.log(x);\n```\n\x1b[31mred\x1b[0m\x07";
    const clean = sanitizeText(raw);
    assert.ok(clean.includes("\n\n"), "sanitizeText must preserve blank paragraph lines");
    assert.ok(clean.includes("- item A\n- item B"), "sanitizeText must preserve list item newlines");
    assert.ok(!clean.includes("\x1b"), "sanitizeText must still strip ANSI escapes");
    assert.ok(!clean.includes("\x07"), "sanitizeText must still strip bell/control chars");

    const theme = createTheme();
    const transcript = new ImmutableTranscript(theme);
    transcript.appendAssistantTurn(raw, "claude-opus-5-5");
    const frozenLines = transcript.render(80).map((l) => stripTerminalSequences(l).trimEnd());
    const idx1 = frozenLines.findIndex((l) => l.includes("Line 1"));
    const idx2 = frozenLines.findIndex((l) => l.includes("Line 2"));
    const idxA = frozenLines.findIndex((l) => l.includes("item A"));
    const idxB = frozenLines.findIndex((l) => l.includes("item B"));
    const idxCode1 = frozenLines.findIndex((l) => l.includes("const x = 1;"));
    const idxCode2 = frozenLines.findIndex((l) => l.includes("console.log(x);"));
    assert.ok(idx1 >= 0 && idx2 > idx1, "Line 1 and Line 2 must render on separate lines");
    assert.ok(idxA >= 0 && idxB > idxA, "Markdown list items must render on separate lines");
    assert.ok(idxCode1 >= 0 && idxCode2 > idxCode1, "Fenced code block lines must render on separate lines");

    // Truecolor fenced code blocks must emit clean SGR sequences without raw ANSI fragments
    // across frozen, streaming, and repeated highlightCode invocations at widths 40/80/120.
    const goCode = [
      "var Plan = fct.Plan{",
      '\tName: "hv-functional",',
      '\tSteps: []fct.Step{{Name: "boot"}},',
      "}",
    ].join("\n");
    const goMd = `\`\`\`go\n${goCode}\n\`\`\``;
    const prevCaps = getCapabilities();
    setCapabilities({ ...prevCaps, trueColor: true });
    try {
      const tcTheme = createTheme({ color: true, ascii: false });
      const rawFragmentRe = /38;2;|\d+;\d+;\d+m/;

      for (const width of [40, 80, 120]) {
        const frozen = new ImmutableTranscript(tcTheme);
        frozen.appendAssistantTurn(goMd);
        const lines = frozen.render(width);
        const joined = lines.join("\n");
        assert.ok(joined.includes("\x1b[38;2;166;154;255m"), `expected info truecolor SGR at width ${width}`);
        assert.ok(joined.includes("\x1b[38;2;110;224;145m"), `expected ok truecolor SGR at width ${width}`);
        for (const line of lines) {
          const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
          assert.ok(!rawFragmentRe.test(stripped), `unexpected raw ANSI fragment at width ${width}: ${JSON.stringify(line)}`);
        }

        // Streaming LiveTurnTail path
        const streaming = new ImmutableTranscript(tcTheme);
        streaming.liveTail.begin("test-model");
        for (const chunk of ["```go\nvar Plan = ", 'fct.Plan{\n\tName: "hv-functional",\n', '\tSteps: []fct.Step{{Name: "boot"}},\n}\n```']) {
          streaming.liveTail.appendText(chunk);
          for (const line of streaming.liveTail.render(width)) {
            const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
            assert.ok(!rawFragmentRe.test(stripped), `unexpected raw ANSI fragment while streaming at width ${width}: ${JSON.stringify(line)}`);
          }
        }
      }

      // highlightCode must be idempotent / ANSI-safe if invoked on already-highlighted lines
      const highlight = tcTheme.toMarkdownTheme().highlightCode!;
      const once = highlight(goCode, "go");
      const twice = highlight(once.join("\n"), "go");
      assert.deepEqual(twice, once, "highlightCode must be idempotent on already-highlighted lines");
      for (const line of twice) {
        const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
        assert.ok(!rawFragmentRe.test(stripped), `unexpected raw ANSI fragment on double highlight: ${JSON.stringify(line)}`);
      }
    } finally {
      setCapabilities(prevCaps);
    }
  });
});

function makeStubLiveDeps(initialReplay: EventRecord[] = []) {
  const listeners = new Set<(ev: DaemonEventFrame) => void>();
  let resolveWatchStart: (() => void) | null = null;
  const watchStarted = new Promise<void>((r) => {
    resolveWatchStart = r;
  });
  const client = {
    onEvent(cb: (ev: DaemonEventFrame) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async request(op: string) {
      if (op === "watch.start") {
        resolveWatchStart?.();
        return { watchId: "watch-test", throughSeq: initialReplay.length, replay: initialReplay };
      }
      if (op === "replay.page") {
        return { throughSeq: initialReplay.length, replay: [] };
      }
      if (op === "watch.stop") {
        return { stopped: true };
      }
      return {};
    },
  } as unknown as DaemonClient;
  const deps: InspectorDeps = {
    client,
    store: {} as WorkStore,
    repoRoot: "/repo",
  };
  let nextSeq = initialReplay.length + 1;
  const emit = (ev: Omit<DaemonEventFrame, "kind" | "watchId" | "seq">) => {
    const frame: DaemonEventFrame = { ...ev, kind: "event", seq: nextSeq++, watchId: "watch-test" };
    for (const cb of listeners) cb(frame);
  };
  const waitReady = async () => {
    await watchStarted;
    await new Promise<void>((r) => setImmediate(r));
  };
  return { deps, emit, waitReady };
}

describe("Transcript Unification Regressions", () => {
  // Local 12:34:56 on a non-DST date so formatClock() is deterministic across clocks and timezones.
  const FIXED_EVENT_TIME = new Date(2026, 0, 15, 12, 34, 56).getTime();

  it("renders LiveTranscriptScreen fenced code via the same Markdown truecolor path as ImmutableTranscript with zero raw SGR fragments at widths 100 and 60", async () => {
    const goCode = [
      "var Plan = fct.Plan{",
      '\tName: "hv-functional",',
      "\tCount: 987654,",
      '\tSteps: []fct.Step{{Name: "boot_long_wrapped_segment_for_narrow_width_check_final_token"}},',
      "}",
    ].join("\n");
    const goMd = `\`\`\`go\n${goCode}\n\`\`\``;
    const prevCaps = getCapabilities();
    setCapabilities({ ...prevCaps, trueColor: true });
    try {
      const tcTheme = createTheme({ color: true, ascii: false });
      const rawFragmentRe = /38;2;|\d+;\d+;\d+m/;

      const codeBlockRows = (lines: readonly string[]): string[] => {
        const start = lines.findIndex((l) => stripTerminalSequences(l).includes("```go"));
        assert.ok(start >= 0, "expected opening ```go fence row");
        const end = lines.findIndex((l, idx) => idx > start && /(?:^|\s)```(?:\s|$)/.test(stripTerminalSequences(l)));
        assert.ok(end > start, "expected closing ``` fence row");
        return lines.slice(start + 1, end);
      };

      const tokenFgSgr = (lines: readonly string[], token: string): string | null => {
        for (const line of lines) {
          let activeFg = "";
          let plain = "";
          const fgAtPlainIdx: string[] = [];
          let i = 0;
          while (i < line.length) {
            if (line[i] === "\x1b" && line[i + 1] === "[") {
              const end = line.indexOf("m", i + 2);
              if (end !== -1) {
                const seq = line.slice(i, end + 1);
                if (seq === "\x1b[0m" || seq === "\x1b[m" || seq === "\x1b[39m") activeFg = "";
                else if (/^\x1b\[38;2;\d+;\d+;\d+m$/.test(seq)) activeFg = seq;
                i = end + 1;
                continue;
              }
            }
            plain += line[i]!;
            fgAtPlainIdx.push(activeFg);
            i++;
          }
          const pos = plain.indexOf(token);
          if (pos >= 0) return fgAtPlainIdx[pos] ?? "";
        }
        return null;
      };

      const mainChat = new ImmutableTranscript(tcTheme);
      mainChat.appendAssistantTurn(goMd);
      const mainRows100 = mainChat.render(100);
      const mainCodeRows100 = codeBlockRows(mainRows100);
      const tokens = ["var", '"hv-functional"', "987654"];
      const mainTokenStyles = new Map<string, string>();
      for (const tok of tokens) {
        const sgr = tokenFgSgr(mainCodeRows100, tok);
        assert.ok(sgr && sgr.startsWith("\x1b[38;2;"), `expected truecolor SGR on token ${tok} in ImmutableTranscript`);
        mainTokenStyles.set(tok, sgr);
      }

      const { deps, emit, waitReady } = makeStubLiveDeps();
      const { terminal } = makeFakeTerminal(100, 24);
      const tui = new ModalScreen(terminal);
      const nav = new Navigator(tui, terminal, tcTheme);
      const screen = new LiveTranscriptScreen("run-1", "task-1", deps);
      nav.push(screen);
      await waitReady();

      emit({
        runId: "run-1",
        taskId: "task-1",
        type: "agent.text_delta",
        createdAt: FIXED_EVENT_TIME,
        payload: { delta: goMd },
      });

      const renderedByWidth = new Map<number, string[]>();
      for (const width of [100, 60]) {
        const rows = screen.render(width, 24, tcTheme);
        renderedByWidth.set(width, rows);
        const plainJoined = rows.map((r) => stripTerminalSequences(r)).join("\n");
        assert.ok(plainJoined.includes("final_token"), `wrapped long code line must retain final_token at width ${width}`);
        const codeRows = codeBlockRows(rows);
        for (const tok of tokens) {
          assert.equal(
            tokenFgSgr(codeRows, tok),
            mainTokenStyles.get(tok),
            `token ${tok} truecolor SGR must match ImmutableTranscript at width ${width}`,
          );
        }
        for (const row of rows) {
          assert.equal(visibleWidth(row), width, `row width mismatch at width ${width}`);
          const stripped = row.replace(/\x1b\[[0-9;]*m/g, "");
          assert.ok(!rawFragmentRe.test(stripped), `raw ANSI fragment at width ${width}: ${JSON.stringify(row)}`);
        }
      }
      assert.ok(
        renderedByWidth.get(60)!.length > renderedByWidth.get(100)!.length,
        "long code line must wrap into additional rows at width 60",
      );
      nav.closeAll();
    } finally {
      setCapabilities(prevCaps);
    }
  });

  it("copies plain text via OSC 52 on SGR mouse press/drag/release through Navigator with 0-based overlay bounds and no chrome glyphs", async () => {
    const theme = createTheme({ color: true, ascii: false });
    const { terminal, writes, sendInput } = makeFakeTerminal(100, 24);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const { deps, waitReady } = makeStubLiveDeps([
      {
        seq: 1,
        runId: "run-1",
        taskId: "task-1",
        type: "agent.text_delta",
        createdAt: FIXED_EVENT_TIME,
        payload: { delta: "Alpha bravo charlie delta\nSecond A界B 🚀 echo foxtrot" },
      },
    ]);
    const screen = new LiveTranscriptScreen("run-1", "task-1", deps);
    tui.start();
    nav.push(screen);
    await waitReady();

    const compositeVisible = () => {
      const composited = (
        tui as unknown as { compositeOverlays(l: string[], w: number, h: number): string[] }
      ).compositeOverlays(tui.render(100), 100, 24);
      const viewportTop = Math.max(0, composited.length - terminal.rows);
      return composited.slice(viewportTop);
    };

    const visible = compositeVisible();

    // Assert pi-tui OverlayHandle.getBounds() uses 0-based terminal coordinates matching the rendered frame top-left corner.
    const handle = (nav as unknown as { handle: OverlayHandle | null }).handle;
    const bounds = handle?.getBounds();
    assert.ok(bounds, "overlay bounds must be populated after TUI render");
    assert.equal(
      stripTerminalSequences(visible[bounds.row]!)[bounds.col],
      "╭",
      "getBounds() must return 0-based terminal coordinates",
    );

    const row1 = visible.findIndex((l) => stripTerminalSequences(l).includes("Alpha bravo charlie delta"));
    const row2 = visible.findIndex((l) => stripTerminalSequences(l).includes("Second A界B"));
    assert.ok(row1 >= 0 && row2 > row1, "both transcript lines must be visible inside overlay");

    const plain1 = stripTerminalSequences(visible[row1]!);
    const plain2 = stripTerminalSequences(visible[row2]!);
    const startX0 = visibleWidth(plain1.slice(0, plain1.indexOf("Alpha")));
    const rocketCol0 = visibleWidth(plain2.slice(0, plain2.indexOf("🚀")));
    assert.ok(startX0 >= 0 && rocketCol0 > 0);

    // Cross-row drag ending on the first cell of wide emoji 🚀 must snap outward to include the full emoji.
    writes.length = 0;
    sendInput(`\x1b[<0;${startX0 + 1};${row1 + 1}M`);
    sendInput(`\x1b[<32;${rocketCol0 + 1};${row2 + 1}M`);
    sendInput(`\x1b[<0;${rocketCol0 + 1};${row2 + 1}m`);

    const oscWrites1 = writes.filter((w) => w.includes("\x1b]52;c;"));
    assert.equal(oscWrites1.length, 1, "mouse release must emit exactly one OSC 52 clipboard write");
    const m1 = oscWrites1[0]!.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/);
    assert.ok(m1, "OSC 52 sequence must contain valid base64 payload");
    const decoded1 = Buffer.from(m1[1]!, "base64").toString("utf8");
    assert.equal(decoded1, "Alpha bravo charlie delta\nSecond A界B 🚀");
    assert.equal(/[╭╮╰╯│┃┆▸▎]/.test(decoded1), false, "copied text must exclude frame borders, gutter, and scrollbar");

    // Partial-cell drag starting on the second cell of wide glyph 界 through B must copy "界B" and paint "A界B".
    const jieCol0 = visibleWidth(plain2.slice(0, plain2.indexOf("界")));
    const bCol0 = visibleWidth(plain2.slice(0, plain2.indexOf("B")));
    writes.length = 0;
    sendInput(`\x1b[<0;${jieCol0 + 2};${row2 + 1}M`);
    sendInput(`\x1b[<32;${bCol0 + 1};${row2 + 1}M`);
    sendInput(`\x1b[<0;${bCol0 + 1};${row2 + 1}m`);

    const oscWrites2 = writes.filter((w) => w.includes("\x1b]52;c;"));
    assert.equal(oscWrites2.length, 1, "partial wide-glyph drag must emit exactly one OSC 52 write");
    const m2 = oscWrites2[0]!.match(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/);
    assert.ok(m2);
    assert.equal(Buffer.from(m2[1]!, "base64").toString("utf8"), "界B");
    const highlightedVisible = compositeVisible();
    const highlightedRow = highlightedVisible.find((l) => stripTerminalSequences(l).includes("Second "));
    assert.ok(highlightedRow, "highlighted row must still be visible after drag copy");
    assert.ok(
      stripTerminalSequences(highlightedRow).includes("A界B"),
      "highlighted row must preserve the full wide glyph without dropping it",
    );
    assert.ok(
      highlightedRow.includes(theme.badgeBg("界B")),
      "highlight background must wrap the snapped wide glyph and B together",
    );

    // Short transcript: clicking below the last drawn content row must not fold the last tool.
    nav.closeAll();
    const { deps: shortDeps, waitReady: waitShortReady } = makeStubLiveDeps([
      {
        seq: 1,
        runId: "run-1",
        taskId: "task-1",
        type: "agent.tool",
        createdAt: FIXED_EVENT_TIME,
        payload: {
          id: "call-short",
          name: "read_file",
          status: "completed",
          result: "SHORT_FIRST\nSHOULD_STAY_COLLAPSED",
        },
      },
    ]);
    const shortScreen = new LiveTranscriptScreen("run-1", "task-1", shortDeps);
    nav.push(shortScreen);
    await waitShortReady();
    const shortVisible = compositeVisible();
    assert.equal(
      shortVisible.map((l) => stripTerminalSequences(l)).join("\n").includes("SHOULD_STAY_COLLAPSED"),
      false,
      "short tool starts collapsed",
    );
    const shortBounds = (nav as unknown as { handle: OverlayHandle | null }).handle?.getBounds()!;
    const shortRect = (shortScreen as unknown as { frame: Frame }).frame.bodyRect!;
    const belowY1 = shortBounds.row + shortRect.row + shortRect.height + 2 + 1;
    const insideX1 = shortBounds.col + shortRect.col + 4 + 1;
    sendInput(`\x1b[<0;${insideX1};${belowY1}M`);
    sendInput(`\x1b[<0;${insideX1};${belowY1}m`);
    const afterClickVisible = compositeVisible();
    assert.equal(
      afterClickVisible.map((l) => stripTerminalSequences(l)).join("\n").includes("SHOULD_STAY_COLLAPSED"),
      false,
      "clicking below the last content row of a short transcript must leave the tool collapsed",
    );

    // Pressing on the 2-column cursor gutter or scrollbar reserve of a tool header must not fold it.
    const toolRow0 = shortVisible.findIndex((l) => stripTerminalSequences(l).includes("read_file"));
    assert.ok(toolRow0 >= 0, "tool header row must be visible");
    const toolY1 = toolRow0 + 1;
    const gutterX1 = shortBounds.col + shortRect.col + 1 + 1;
    sendInput(`\x1b[<0;${gutterX1};${toolY1}M`);
    sendInput(`\x1b[<0;${gutterX1};${toolY1}m`);
    assert.equal(
      compositeVisible().map((l) => stripTerminalSequences(l)).join("\n").includes("SHOULD_STAY_COLLAPSED"),
      false,
      "clicking a gutter column on a tool header must leave the tool collapsed",
    );
    const scrollbarX1 = shortBounds.col + shortRect.col + (shortRect.width - 2) + 1;
    sendInput(`\x1b[<0;${scrollbarX1};${toolY1}M`);
    sendInput(`\x1b[<0;${scrollbarX1};${toolY1}m`);
    assert.equal(
      compositeVisible().map((l) => stripTerminalSequences(l)).join("\n").includes("SHOULD_STAY_COLLAPSED"),
      false,
      "clicking a scrollbar column on a tool header must leave the tool collapsed",
    );

    nav.closeAll();
    tui.stop();
  });

  it("folds and unfolds tool blocks via Enter while keeping the top visible row stable when paused", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const longResult = Array.from({ length: 55 }, (_, i) => `RESULT_LINE_${String(i + 1).padStart(2, "0")}`).join("\n");
    const { deps, waitReady } = makeStubLiveDeps([
      {
        seq: 1,
        runId: "run-1",
        taskId: "task-1",
        type: "agent.text_delta",
        createdAt: FIXED_EVENT_TIME,
        payload: { delta: "INTRO_ONE\n\nINTRO_TWO\n\nUNIQUE_ANCHOR_ROW_ALPHA\n\nIntro trailing line" },
      },
      {
        seq: 2,
        runId: "run-1",
        taskId: "task-1",
        type: "agent.tool",
        createdAt: FIXED_EVENT_TIME + 1000,
        payload: {
          id: "call-1",
          name: "read_file",
          status: "completed",
          args: '{"path":"ARG_SECRET_PATH.ts"}',
          result: longResult,
        },
      },
      {
        seq: 3,
        runId: "run-1",
        taskId: "task-1",
        type: "agent.text_delta",
        createdAt: FIXED_EVENT_TIME + 2000,
        payload: { delta: Array.from({ length: 50 }, (_, i) => `Trailing line ${i + 1}`).join("\n\n") },
      },
    ]);

    const { terminal } = makeFakeTerminal(100, 82);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };
    const screen = new LiveTranscriptScreen("run-1", "task-1", deps);
    nav.push(screen);
    await waitReady();

    const bodyRow = (rows: string[]) => {
      const rect = (screen as unknown as { frame: Frame }).frame.bodyRect!;
      return stripTerminalSequences(rows[rect.row]!);
    };

    // Pause at top, then scroll down 6 rows (2 wheel steps) to pin the unique non-blank anchor row at the top.
    screen.render(100, 82, theme);
    screen.handleInput("g", ctx);
    screen.render(100, 82, theme);
    screen.handleInput("\x1b[<65;10;5M", ctx);
    screen.handleInput("\x1b[<65;10;5M", ctx);
    const beforeRows = screen.render(100, 82, theme);
    const beforeJoined = beforeRows.join("\n");
    assert.ok(beforeJoined.includes("read_file"), "collapsed tool header must be visible");
    assert.equal(beforeJoined.includes("RESULT_LINE_02"), false, "tool body must be hidden when collapsed");
    assert.equal(beforeJoined.includes("ARG_SECRET_PATH.ts"), false, "tool args must be hidden when collapsed");

    // Move cursor down until the gutter pointer sits on the read_file tool header row.
    const cursorOnTool = (rows: string[]) =>
      rows.some((r) => {
        const plain = stripTerminalSequences(r);
        return plain.includes("read_file") && plain.indexOf("▸") !== plain.lastIndexOf("▸");
      });
    for (let step = 0; step < 12; step++) {
      screen.handleInput("j", ctx);
      const curRows = screen.render(100, 82, theme);
      if (cursorOnTool(curRows)) break;
    }
    const preToggleRows = screen.render(100, 82, theme);
    const topBeforeToggle = bodyRow(preToggleRows);
    assert.ok(
      topBeforeToggle.includes("UNIQUE_ANCHOR_ROW_ALPHA"),
      `top row before toggle must be the unique non-blank anchor, got: ${JSON.stringify(topBeforeToggle)}`,
    );
    assert.ok(cursorOnTool(preToggleRows), "cursor must reach the tool block");

    // 1st Enter: collapsed -> expanded (clipped at 40 source lines).
    screen.handleInput("\r", ctx);
    const expandedRows = screen.render(100, 82, theme);
    const expandedJoined = expandedRows.join("\n");
    assert.ok(expandedJoined.includes("ARG_SECRET_PATH.ts"), "tool args must appear after first Enter");
    assert.ok(expandedJoined.includes("RESULT_LINE_02"), "clipped result lines must appear after first Enter");
    assert.ok(expandedJoined.includes("more lines"), "clip marker row must appear for >40-line section");
    assert.equal(expandedJoined.includes("RESULT_LINE_55"), false, "last result line must be absent while clipped");
    assert.equal(bodyRow(expandedRows), topBeforeToggle, "top visible row must stay unchanged when expanding below it");
    assert.equal(/\+\d+ new/.test(expandedJoined), false, "expanding a fold must not report '+N new'");

    // 2nd Enter: expanded (clipped) -> full.
    screen.handleInput("\r", ctx);
    const fullRows = screen.render(100, 82, theme);
    const fullJoined = fullRows.join("\n");
    assert.ok(fullJoined.includes("RESULT_LINE_55"), "last result line must appear in full fold state");
    assert.equal(fullJoined.includes("more lines"), false, "clip marker must disappear in full fold state");
    assert.equal(bodyRow(fullRows), topBeforeToggle, "top visible row must stay unchanged when switching to full");
    assert.equal(/\+\d+ new/.test(fullJoined), false, "showing full fold must not report '+N new'");

    // 3rd Enter: full -> collapsed.
    screen.handleInput("\r", ctx);
    const collapsedRows = screen.render(100, 82, theme);
    const collapsedJoined = collapsedRows.join("\n");
    assert.equal(collapsedJoined.includes("RESULT_LINE_02"), false, "tool body must hide after third Enter");
    assert.equal(collapsedJoined.includes("RESULT_LINE_55"), false, "last result line must hide after third Enter");
    assert.equal(collapsedJoined.includes("ARG_SECRET_PATH.ts"), false, "tool args must hide after third Enter");
    assert.equal(bodyRow(collapsedRows), topBeforeToggle, "top visible row must stay unchanged when collapsing below it");
    assert.equal(/\+\d+ new/.test(collapsedJoined), false, "collapsing a fold must not report '+N new'");

    nav.closeAll();
  });

  it("restores the exact top visible row across a 100 -> 60 -> 100 width resize while paused", async () => {
    const theme = createTheme({ color: false, ascii: false });
    const makeMultiRow = (tag: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${tag}_ROW_${String(i + 1).padStart(2, "0")} long_token_for_wrapping_between_widths`).join(
        "\n\n",
      );

    const { deps, emit, waitReady } = makeStubLiveDeps([
      { seq: 1, runId: "run-1", taskId: "task-a", type: "agent.text_delta", createdAt: FIXED_EVENT_TIME, payload: { delta: makeMultiRow("BLK_A", 8) } },
      { seq: 2, runId: "run-1", taskId: "task-b", type: "agent.text_delta", createdAt: FIXED_EVENT_TIME + 100, payload: { delta: makeMultiRow("BLK_B", 16) } },
      { seq: 3, runId: "run-1", taskId: "task-c", type: "agent.text_delta", createdAt: FIXED_EVENT_TIME + 200, payload: { delta: makeMultiRow("BLK_C", 16) } },
    ]);

    const { terminal } = makeFakeTerminal(100, 20);
    const tui = new ModalScreen(terminal);
    const nav = new Navigator(tui, terminal, theme);
    const ctx = { navigator: nav, theme, requestRender: () => {}, writeTerminal: () => {} };
    const screen = new LiveTranscriptScreen("run-1", undefined, deps);
    nav.push(screen);
    await waitReady();

    const topBodyRow = (width: number) => {
      const rows = screen.render(width, 20, theme);
      const rect = (screen as unknown as { frame: Frame }).frame.bodyRect!;
      return stripTerminalSequences(rows[rect.row]!);
    };

    // Start at top (paused), then scroll down to pin a specific interior row of BLK_B.
    topBodyRow(100);
    screen.handleInput("g", ctx);
    let topAt100 = topBodyRow(100);
    for (let i = 0; i < 40 && !topAt100.includes("BLK_B_ROW_06"); i++) {
      screen.handleInput("\x1b[<65;10;5M", ctx); // wheel down 3 rows
      topAt100 = topBodyRow(100);
      if (topAt100.includes("BLK_B_ROW_07") || topAt100.includes("BLK_B_ROW_08")) {
        break;
      }
    }
    assert.ok(
      /BLK_B_ROW_0[5-8]/.test(topAt100),
      `expected top row to be an interior row of BLK_B, got: ${JSON.stringify(topAt100)}`,
    );

    const topAt60 = topBodyRow(60);
    assert.ok(topAt60.includes("BLK_B"), `at width 60 top row must remain inside BLK_B, got: ${JSON.stringify(topAt60)}`);

    const topBackAt100 = topBodyRow(100);
    assert.equal(topBackAt100, topAt100, "returning to width 100 must restore the exact top visible row");

    // Stream more text into the anchored block (task-b) at the same width: top row must not drift.
    emit({
      runId: "run-1",
      taskId: "task-b",
      type: "agent.text_delta",
      createdAt: FIXED_EVENT_TIME + 300,
      payload: { delta: "\n\n" + makeMultiRow("BLK_B_STREAM", 20) },
    });
    assert.equal(
      topBodyRow(100),
      topAt100,
      "streaming more text into the anchored block must not shift the paused top row",
    );
    const topAt60AfterGrowth = topBodyRow(60);
    assert.ok(
      /BLK_B_ROW_0[5-8]/.test(topAt60AfterGrowth),
      `at width 60 after growth top row must belong to pinned BLK_B_ROW text, got: ${JSON.stringify(topAt60AfterGrowth)}`,
    );
    assert.equal(
      topBodyRow(100),
      topAt100,
      "returning to width 100 after growth must restore the exact top visible row",
    );

    // Stream more text into a block above the anchored block (task-a): top row must still not drift.
    emit({
      runId: "run-1",
      taskId: "task-a",
      type: "agent.text_delta",
      createdAt: FIXED_EVENT_TIME + 400,
      payload: { delta: "\n\n" + makeMultiRow("BLK_A_STREAM", 20) },
    });
    assert.equal(
      topBodyRow(100),
      topAt100,
      "streaming more text into a block above the anchored block must not shift the paused top row",
    );

    nav.closeAll();
  });
});
