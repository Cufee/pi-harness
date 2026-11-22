import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import { CommandPaletteOverlay, EffortPickerOverlay, ModelPickerOverlay, RunsOverlay, SessionsOverlay, TreeOverlay } from "../src/tui/overlays.js";
import {
  AssistantCard,
  BannerCard,
  clampLine,
  createTheme,
  ErrorCard,
  fillLineBg,
  fitWidth,
  FooterHint,
  formatAgentError,
  Panel,
  renderFlexRow,
  renderProgressBar,
  renderTable,
  Rule,
  StatusBar,
  SystemCard,
  ToolPill,
  UserCard,
} from "../src/tui/primitives/index.js";

const WIDTHS = [8, 12, 20, 40, 80, 120];

function assertWidthSafe(lines: readonly string[], width: number, label: string): void {
  for (let i = 0; i < lines.length; i++) {
    const w = visibleWidth(lines[i]!);
    if (w > width) {
      throw new Error(`${label} overflowed width=${width} at line ${i}: visibleWidth=${w} raw=${JSON.stringify(lines[i])}`);
    }
  }
}

describe("TUI Primitives Library", () => {
  const theme = createTheme();

  test("width helpers never exceed target width with ANSI, emojis, and CJK", () => {
    const samples = [
      theme.accentBold("🚀 SuperLongUnbrokenIdentifier_with_ANSI_and_日本語_text_1234567890"),
      `\x1b[1;36mhello\x1b[0m ${theme.error("world")} ⚡🔥✨`,
      "multiline\ntitle\r\nwith\ttabs",
      "short",
      "",
    ];
    for (const width of WIDTHS) {
      for (const s of samples) {
        const clamped = clampLine(s, width);
        expect(visibleWidth(clamped)).toBeLessThanOrEqual(width);
        expect(clamped).not.toContain("\n");
        const fitted = fitWidth(s, width);
        expect(visibleWidth(fitted)).toBe(width);
        expect(fitted).not.toContain("\n");
        expect(visibleWidth(fitWidth(s, width, { align: "right" }))).toBe(width);
        expect(visibleWidth(fitWidth(s, width, { align: "center" }))).toBe(width);
        expect(visibleWidth(fillLineBg(s, width, theme.surfaceBg))).toBe(width);
      }
    }
  });

  test("renderFlexRow, Rule, ProgressBar, and responsive Table stay width-safe across all viewports", () => {
    const rows = [
      { name: "claude-opus-5-5", score: 89.4, ratio: 0.82, route: "acp:claude" },
      { name: "gpt-6.2-astra", score: 88.1, ratio: 0.15, route: "acp:codex" },
      { name: "gemini-4-carbon", score: 86.7, ratio: 0.04, route: "acp:gemini" },
    ];

    for (const width of WIDTHS) {
      const flexL = renderFlexRow(
        theme.accentBold("◆ pi-harness │ claude-opus-5-5·high"),
        theme.dim("Ctrl+O cmd · Ctrl+, settings · Ctrl+C exit"),
        width,
        { priority: "left", bgFn: theme.statusBg },
      );
      expect(visibleWidth(flexL)).toBeLessThanOrEqual(width);

      const flexR = renderFlexRow("Left side text", "Right priority badge", width, { priority: "right" });
      expect(visibleWidth(flexR)).toBeLessThanOrEqual(width);

      const rule = new Rule(theme, "Section Divider");
      assertWidthSafe(rule.render(width), width, "Rule");

      const tableLines = renderTable(
        rows,
        [
          { header: "MODEL", width: "flex", minWidth: 14, priority: 0, render: (r) => theme.bold(r.name) },
          { header: "SCORE", width: 8, align: "right", priority: 1, render: (r) => r.score.toFixed(1) },
          { header: "QUOTA", width: 16, priority: 1, render: (r) => renderProgressBar(r.ratio, theme, { barWidth: 10 }) },
          { header: "ROUTE", width: 12, priority: 2, render: (r) => theme.muted(r.route) },
        ],
        width,
        theme,
      );
      assertWidthSafe(tableLines, width, "renderTable");
    }
  });

  test("StatusBar ALWAYS renders strictly 1 line and never wraps", () => {
    const bar = new StatusBar(theme, {
      tone: "accent",
      modeLabel: "director",
      modelLabel: "claude-opus-5-5-extended-super-long-name",
      effortLabel: "xhigh",
      goalsSummary: "goal-1234[executing] goal-5678[verifying]",
      alertText: "2 P0!",
    });
    const hint = new FooterHint(theme);
    hint.set("Press Ctrl+C again (or Ctrl+D) to detach & exit", "warning");

    for (const width of WIDTHS) {
      const lines = bar.render(width);
      expect(lines.length).toBe(1);
      assertWidthSafe(lines, width, "StatusBar");

      const hintLines = hint.render(width);
      expect(hintLines.length).toBe(1);
      assertWidthSafe(hintLines, width, "FooterHint");
    }
  });

  test("Panel and all message cards stay width-safe across narrow and wide terminals", () => {
    const body: Component = {
      invalidate() {},
      render(w) {
        return [
          fitWidth(`${theme.success("✓")} Row with ANSI & emoji 🚀`, w),
          fitWidth("Another very long row that must cleanly truncate with ellipsis without breaking borders", w),
        ];
      },
    };
    const panel = new Panel(
      theme,
      {
        title: "Model Catalog & Picker",
        subtitle: "synced 2026-11-21 17:45",
        footer: "Enter select · s sync · Esc close",
      },
      body,
    );

    const cards: Array<[string, Component]> = [
      ["Panel", panel],
      ["BannerCard", new BannerCard(theme, "pi-harness", "Director Chat · chat-1234")],
      ["UserCard", new UserCard(theme, "Refactor auth middleware and add regression tests for OAuth token refresh 🚀")],
      [
        "AssistantCard",
        new AssistantCard(
          theme,
          "## Plan\n\nHere is a snippet:\n\n```ts\nconst answer = 42;\nexport async function run() { return answer; }\n```\n\n- Verified cleanly",
          "claude-opus-5-5",
        ),
      ],
      ["ToolPill", new ToolPill(theme, "ok", "run_tests", "13/13 passed in 280ms")],
      ["SystemCard", new SystemCard(theme, ["Goal g-1 approved ✓", "All deterministic gates passed"], "success")],
      [
        "ErrorCard",
        new ErrorCard(theme, {
          headline: "[acp:claude] You've hit your individual spend limit",
          detail: "Switch to another enabled CLI/model via /model or check /quota.",
          logPath: "/home/dev/.pi-harness/logs/errors/2026-11-21-ab12.log",
        }),
      ],
    ];

    for (const width of WIDTHS) {
      for (const [name, comp] of cards) {
        comp.invalidate();
        assertWidthSafe(comp.render(width), width, name);
      }
    }
  });

  test("CommandPaletteOverlay, ModelPickerOverlay, and RunsOverlay render fast & width-safe", () => {
    let ran = "";
    const palette = new CommandPaletteOverlay(
      theme,
      [
        { id: "model", label: "Select Model", shortcut: "/model", description: "Ranked catalog", run: () => (ran = "model") },
        { id: "quota", label: "View Quotas", shortcut: "/quota", description: "Live buckets", run: () => (ran = "quota") },
      ],
      () => {},
      () => {},
    );
    for (const width of [20, 40, 80, 120]) {
      assertWidthSafe(palette.render(width), width, "CommandPaletteOverlay");
    }
    palette.handleInput("q");
    palette.handleInput("u");
    palette.handleInput("\r");
    expect(ran).toBe("quota");

    let selectedId = "";
    const picker = new ModelPickerOverlay(
      theme,
      {} as never,
      "/tmp",
      {
        schemaVersion: 2,
        syncedAt: "2026-11-21T23:55:00Z",
        sources: ["vals_ai", "models.dev"],
        models: [
          {
            id: "openai/gpt-6.2-astra",
            family: "openai/gpt-astra",
            name: "GPT 6.2 Astra",
            codingRank: 1,
            codingScore: 63.1,
            scoreSource: "vals_tb4",
            benchmarks: { vals_tb4: 63.1 },
            contextK: 200,
            costPerTaskUsd: 0,
            apiEquivCostUsd: 4.69,
            timePerTaskSeconds: 2040,
            efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
            preferredRoute: { profileId: "acp:codex", runner: "acp", provider: "openai", wireModelId: "gpt-6.2-astra", billing: "subscription" },
            alternateRoutes: [],
            recommendedFor: ["orchestrator", "worker"],
            quota: null,
          },
          {
            id: "openai/gpt-6.2-sol",
            family: "openai/gpt-sol",
            name: "GPT 6.2 Sol",
            codingRank: 2,
            codingScore: 60.6,
            scoreSource: "vals_tb4",
            benchmarks: { vals_tb4: 60.6 },
            contextK: 200,
            costPerTaskUsd: 0,
            apiEquivCostUsd: 1.13,
            timePerTaskSeconds: 1380,
            efforts: ["low", "medium", "high"],
            preferredRoute: { profileId: "acp:codex", runner: "acp", provider: "openai", wireModelId: "gpt-6.2-sol", billing: "subscription" },
            alternateRoutes: [],
            recommendedFor: ["task"],
            quota: null,
          },
        ],
      },
      "openai/gpt-6.2-astra",
      (m) => (selectedId = m.id),
      () => {},
      () => {},
    );
    for (const width of [24, 48, 80, 110]) {
      assertWidthSafe(picker.render(width), width, "ModelPickerOverlay");
    }
    picker.handleInput("s");
    picker.handleInput("o");
    picker.handleInput("l");
    picker.handleInput("\r");
    expect(selectedId).toBe("openai/gpt-6.2-sol");

    const runs = new RunsOverlay(
      theme,
      [
        {
          id: "run-1",
          goal: "Build fast cron parser CLI",
          repoRoot: "/tmp/demo",
          baseBranch: "main",
          baseSha: "abc1234",
          coordinationGroup: "default",
          isolationMode: "standalone",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
      () => {},
      () => {},
      () => {},
    );
    for (const width of [24, 48, 80, 110]) {
      assertWidthSafe(runs.render(width), width, "RunsOverlay");
    }

    const effort = new EffortPickerOverlay(theme, ["low", "medium", "high", "ultra"], "medium", () => {}, () => {}, () => {});
    for (const width of [24, 48, 80, 110]) {
      assertWidthSafe(effort.render(width), width, "EffortPickerOverlay");
    }

    const sessionsOverlay = new SessionsOverlay(
      theme,
      [
        { id: "chat-aaaa1111", kind: "chat", title: "Director Chat", repoRoot: "/tmp/proj", status: "idle", running: false, attached: true, attachedByMe: true, model: "gpt-6.2-sol", effort: "medium", updatedAt: 2 },
        { id: "chat-bbbb2222", kind: "chat", title: "Second Session", repoRoot: "/tmp/proj", status: "busy", running: true, attached: true, attachedByMe: false, model: "claude-opus-5-5", effort: "high", updatedAt: 3 },
      ],
      () => {},
      () => {},
      () => {},
      () => {},
    );
    for (const width of [24, 48, 80, 110]) {
      assertWidthSafe(sessionsOverlay.render(width), width, "SessionsOverlay");
    }

    const tree = new TreeOverlay(
      theme,
      () => [
        { id: "t-1", runId: "r-1", parentId: null, tier: 1, kind: "orchestrator", title: "Orch\nSecondLine", objective: "x", criteria: "", readOnly: true, profileId: "acp:codex", model: "gpt-6.2-sol", effort: "medium", status: "running", generation: 1, maxTurns: 20, turnsUsed: 0, contextUsed: 100, contextSize: 1000, worktreeId: null, sessionId: null, summary: null, handoffJson: null, resultJson: null, createdAt: 1, updatedAt: 1 },
        { id: "t-2", runId: "r-1", parentId: "t-1", tier: 2, kind: "worker", title: "Worker A", objective: "x", criteria: "", readOnly: false, profileId: "acp:codex", model: "gpt-6.2-sol", effort: "medium", status: "completed", generation: 1, maxTurns: 20, turnsUsed: 0, contextUsed: 100, contextSize: 1000, worktreeId: null, sessionId: null, summary: null, handoffJson: null, resultJson: null, createdAt: 2, updatedAt: 2 },
        { id: "t-3", runId: "r-1", parentId: "t-1", tier: 2, kind: "worker", title: "Worker B", objective: "x", criteria: "", readOnly: false, profileId: "acp:codex", model: "gpt-6.2-sol", effort: "medium", status: "running", generation: 1, maxTurns: 20, turnsUsed: 0, contextUsed: 100, contextSize: 1000, worktreeId: null, sessionId: null, summary: null, handoffJson: null, resultJson: null, createdAt: 3, updatedAt: 3 },
        { id: "t-4", runId: "r-1", parentId: "t-2", tier: 3, kind: "verify", title: "Verify A", objective: "x", criteria: "", readOnly: true, profileId: "acp:codex", model: "gpt-6.2-astra", effort: "high", status: "completed", generation: 1, maxTurns: 20, turnsUsed: 0, contextUsed: 100, contextSize: 1000, worktreeId: null, sessionId: null, summary: null, handoffJson: null, resultJson: null, createdAt: 4, updatedAt: 4 },
      ],
      () => [],
      () => {},
      () => {},
      () => {},
    );
    const treeRendered = tree.render(100);
    assertWidthSafe(treeRendered, 100, "TreeOverlay");
    // Verify DFS nesting: Verify A (t-4, child of t-2) renders BEFORE Worker B (t-3)!
    const idxT4 = treeRendered.findIndex((l) => l.includes("t-4"));
    const idxT3 = treeRendered.findIndex((l) => l.includes("t-3"));
    expect(idxT4).toBeGreaterThan(0);
    expect(idxT4).toBeLessThan(idxT3);

    // Performance budget: 200 full frames at 120 cols of StatusBar + BannerCard + UserCard + AssistantCard < 40ms total
    const bar = new StatusBar(theme, { tone: "success", modeLabel: "director", modelLabel: "gpt-6.2-astra", effortLabel: "high", goalsSummary: "2 goals" });
    const banner = new BannerCard(theme, "pi-harness", "Director Chat · perf");
    const uCard = new UserCard(theme, "Build a fast CLI tool with unit tests");
    const aCard = new AssistantCard(theme, "Here is the plan:\n\n```ts\nexport const x = 1;\n```\n", "gpt-6.2-astra");
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) {
      bar.render(120);
      banner.render(120);
      uCard.render(120);
      aCard.render(120);
    }
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(40);
  });

  test("formatAgentError strips raw ACP stderr noise and persists full diagnostic log", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-err-"));
    try {
      const rawErr = new Error(
        "ACP runner (acp:claude) failed: Internal error: You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit (stderr: [session/create] sessionId=ceacd2ad phase=models durationMs=2 totalMs=936\n[session/create] phase=register durationMs=2 totalMs=944)",
      );
      const formatted = formatAgentError(rawErr, { stateDir: dir, context: "chat.send:acp:claude" });
      expect(formatted.headline).toBe(
        "[acp:claude] You've hit your individual spend limit · run /usage-credits to ask your admin for a higher limit",
      );
      expect(formatted.headline).not.toContain("[session/create]");
      expect(formatted.headline).not.toContain("stderr:");
      expect(formatted.detail).toContain("/model");
      expect(formatted.logPath).toBeDefined();
      expect(existsSync(formatted.logPath!)).toBe(true);
      const saved = readFileSync(formatted.logPath!, "utf8");
      expect(saved).toContain("phase=register");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
