import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTheme } from "../src/tui/primitives/index.js";
import {
  componentForHistoryTurn,
  extractDisplay,
  registerToolOutputRenderer,
  renderToolOutput,
  ToolOutputCard,
  type ToolDisplayPayload,
} from "../src/tui/tool-output/index.js";

const theme = createTheme();
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

function assertSafe(lines: readonly string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    expect(line).not.toContain("\n");
    // Every escape must belong to a complete SGR sequence (nothing cut mid-sequence).
    expect(strip(line)).not.toContain("\x1b");
  }
}

const LONG_TITLE =
  "Add structured rich tool output rendering in the TUI with an extensible registry and terminal-width-aware tables";

function goal(over: Record<string, unknown>) {
  return {
    id: "goal-7ee072db",
    version: 1,
    status: "executing",
    title: "Short title",
    linkedRunId: "run-3c2cbf3e",
    reviewCycle: 1,
    maxReviewCycles: 3,
    criteriaTotal: 4,
    criteriaPassed: 2,
    openEscalations: 0,
    ...over,
  };
}

const table: ToolDisplayPayload = {
  kind: "goals_table",
  title: "Goals",
  data: {
    goals: [
      goal({ title: LONG_TITLE }),
      goal({ id: "goal-aaaa1111", version: 3, status: "awaiting_human", linkedRunId: null, criteriaPassed: null, openEscalations: 2 }),
      goal({ id: "goal-bbbb2222", status: "achieved", criteriaPassed: 4 }),
      goal({ id: "goal-cccc3333", status: "draft", linkedRunId: null, reviewCycle: 0, criteriaPassed: null }),
    ],
  },
};

describe("tool-output: goals_table", () => {
  test("wide layout shows every column with aligned rows and truncated long title", () => {
    const lines = renderToolOutput(table, 140, theme);
    assertSafe(lines, 140);
    const plain = lines.map(strip);
    expect(plain[0]).toContain("Goals · 4 goals · 2 open escalations");
    for (const h of ["Goal", "Status", "Title", "Run", "Review", "Esc"]) expect(plain[1]).toContain(h);
    const rows = plain.slice(3);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("goal-7ee072db v1");
    expect(rows[0]).toContain("● executing");
    expect(rows[0]).toContain("…");
    expect(rows[0]).not.toContain(LONG_TITLE);
    expect(rows[0]).toContain("run-3c2cbf3e");
    expect(rows[0]).toContain("1/3 · 2/4✓");
    expect(rows[1]).toContain("goal-aaaa1111 v3");
    expect(rows[1]).toContain("—");
    expect(rows[1]).toMatch(/1\/3\s+2$/); // review without criteria tally, escalations count last
    expect(rows[3]).toContain("● draft");
    // Columns align: the Run column starts at the same offset on every row.
    const header = plain[1]!;
    const runCol = header.indexOf("Run");
    expect(rows[0]!.slice(runCol).startsWith("run-3c2cbf3e")).toBe(true);
    expect(rows[2]!.slice(runCol).startsWith("run-3c2cbf3e")).toBe(true);
    // Escalation count is highlighted only when > 0.
    expect(lines[4]).toContain(theme.warning(theme.bold("2")));
  });

  test("narrow layout drops low-priority columns and never overflows", () => {
    for (const width of [20, 32, 40, 60, 80]) assertSafe(renderToolOutput(table, width, theme), width);
    const plain = renderToolOutput(table, 40, theme).map(strip);
    expect(plain[1]).toContain("Goal");
    expect(plain[1]).toContain("Title");
    expect(plain[1]).not.toContain("Run");
    expect(plain[1]).not.toContain("Review");
    expect(plain[3]).toContain("goal-7ee072db v1");
    expect(plain[3]).toContain("…");
    expect(plain[4]).toContain("awaiting_…");
  });

  test("empty state", () => {
    for (const width of [40, 140]) {
      const lines = renderToolOutput({ kind: "goals_table", data: { goals: [] } }, width, theme);
      assertSafe(lines, width);
      expect(lines).toHaveLength(2);
      expect(strip(lines[1]!)).toContain("No goals yet");
    }
  });

  test("hostile strings in data cannot inject escapes", () => {
    const lines = renderToolOutput(
      { kind: "goals_table", data: { goals: [goal({ title: "evil\x1b[2J\x1b]8;;http://x\x07title\nnext" })] } },
      80,
      theme,
    );
    assertSafe(lines, 80);
    expect(lines.join("")).not.toContain("\x1b[2J");
    expect(strip(lines[3]!)).toContain("evil");
  });
});

describe("tool-output: goal_detail", () => {
  const detail: ToolDisplayPayload = {
    kind: "goal_detail",
    title: "Goal goal-7ee072db v1",
    data: {
      goal: {
        id: "goal-7ee072db",
        version: 1,
        status: "reviewing",
        title: LONG_TITLE,
        description: "Render tool results as rich tables.",
        linkedRunId: "run-3c2cbf3e",
        reviewCycle: 2,
        maxReviewCycles: 3,
        nonGoals: [],
      },
      criteria: [
        { id: "c1", kind: "test", description: "typecheck passes", required: true, lastResult: "pass" },
        { id: "c2", kind: "test", description: "full suite passes", required: true, lastResult: "fail" },
        { id: "c3", kind: "manual", description: "looks good", required: false, lastResult: null },
      ],
      tasks: [{ id: "t-1", title: "x", status: "running", tier: 2 }],
      openEscalations: [{ id: "e1", taskId: "t-1", summary: "needs a decision on column order" }],
      lastReview: { cycle: 1, verdict: "changes_requested", summary: "Fix the failing suite and rerun." },
    },
  };

  test("renders header, criteria markers, escalations, and last review within width", () => {
    for (const width of [40, 140]) {
      const lines = renderToolOutput(detail, width, theme);
      assertSafe(lines, width);
      const text = lines.map(strip).join("\n");
      expect(text).toContain("goal-7ee072db v1");
      expect(text).toContain("● reviewing");
      expect(text).toContain("✓ typecheck passes");
      expect(text).toContain("✗ full suite passes");
      expect(text).toContain("○ looks good");
      expect(text).toContain("Open escalations (1)");
      expect(text).toContain("CHANGES_REQUESTED");
    }
    const wide = renderToolOutput(detail, 140, theme).map(strip).join("\n");
    expect(wide).toContain("Run run-3c2cbf3e · Review 2/3 · Criteria 1/3 passed · Tasks 1");
    expect(wide).toContain("[t-1] needs a decision on column order");
    expect(wide).toContain("Fix the failing suite and rerun.");
  });
});

describe("tool-output: fallbacks and registry", () => {
  test("unknown kind renders one compact line without JSON", () => {
    const lines = renderToolOutput({ kind: "mystery_kind", title: "Mystery", data: { secret: [1, 2, 3] } }, 80, theme);
    expect(lines).toHaveLength(1);
    assertSafe(lines, 80);
    expect(strip(lines[0]!)).toContain("Mystery · (unsupported display)");
    expect(lines[0]).not.toContain("{");
    expect(strip(renderToolOutput({ kind: "mystery_kind", data: null }, 80, theme)[0]!)).toContain("mystery_kind");
  });

  test("malformed data for known kinds falls back to one line", () => {
    for (const data of [null, "nope", { goals: "x" }, { goal: { id: 42 } }, []]) {
      for (const kind of ["goals_table", "goal_detail"]) {
        const lines = renderToolOutput({ kind, data }, 60, theme);
        expect(lines).toHaveLength(1);
        assertSafe(lines, 60);
        expect(strip(lines[0]!)).toContain("(invalid display data)");
      }
    }
  });

  test("registry is extensible and throwing renderers degrade", () => {
    const dispose = registerToolOutputRenderer("custom_kind", (d, width) => [`custom:${String(d.data)}:${width}`]);
    expect(renderToolOutput({ kind: "custom_kind", data: "hi" }, 30, theme)).toEqual(["custom:hi:30"]);
    dispose();
    expect(strip(renderToolOutput({ kind: "custom_kind", data: "hi" }, 60, theme)[0]!)).toContain("unsupported");

    const disposeThrow = registerToolOutputRenderer("boom", () => {
      throw new Error("x");
    });
    expect(strip(renderToolOutput({ kind: "boom", data: 1 }, 60, theme)[0]!)).toContain("invalid display data");
    disposeThrow();
  });

  test("ToolOutputCard re-lays out per width", () => {
    const card = new ToolOutputCard(theme, table);
    const wide = card.render(140);
    const narrow = card.render(40);
    assertSafe(narrow, 40);
    expect(wide[0]).toBe("");
    expect(strip(wide[2]!)).toContain("Review");
    expect(strip(narrow[2]!)).not.toContain("Review");
  });
});

describe("tool-output: transcript helpers", () => {
  test("extractDisplay returns display for chat.tool payloads and null for plain tool events", () => {
    const display = { kind: "goals_table", title: "Goals", data: { goals: [] } };
    expect(extractDisplay({ id: "display-1", name: "goal_list", status: "completed", display })).toEqual(display);
    expect(extractDisplay({ id: "call-1", name: "read_file", status: "completed" })).toBeNull();
    expect(extractDisplay({ id: "x", display: { title: "no kind" } })).toBeNull();
    expect(extractDisplay(null)).toBeNull();
    expect(extractDisplay("chat.tool")).toBeNull();
  });

  test("componentForHistoryTurn restores tool_output turns and ignores other roles", () => {
    const base = { seq: 1, chatSessionId: "c1", createdAt: 0 };
    const card = componentForHistoryTurn(
      { ...base, role: "tool_output", content: "goal_list → Goals table (4 goals)", toolName: "goal_list", display: table },
      theme,
    );
    expect(card).toBeInstanceOf(ToolOutputCard);
    expect(card!.render(80).map(strip).join("\n")).toContain("goal-7ee072db v1");

    const note = componentForHistoryTurn(
      { ...base, role: "tool_output", content: "goal_list → Goals table (0 goals)", toolName: "goal_list", display: null },
      theme,
    );
    expect(note).not.toBeNull();
    expect(note).not.toBeInstanceOf(ToolOutputCard);
    const noteLines = note!.render(30);
    expect(noteLines).toHaveLength(1);
    assertSafe(noteLines, 30);
    expect(strip(noteLines[0]!)).toContain("goal_list");

    for (const role of ["user", "assistant", "system_notice"]) {
      expect(componentForHistoryTurn({ ...base, role, content: "hi" }, theme)).toBeNull();
    }
  });
});
