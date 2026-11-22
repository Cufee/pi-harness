import { describe, expect, test } from "bun:test";
import { Container } from "@earendil-works/pi-tui";
import type { ChatTurnRecord } from "../src/director/session.js";
import {
  applyChatToolEvent,
  historyTurnComponent,
  preservePendingTools,
  type PendingTools,
} from "../src/tui/app.js";
import { createTheme, ToolPill } from "../src/tui/primitives/index.js";
import { ToolOutputCard, ToolOutputNote } from "../src/tui/tool-output/index.js";

const theme = createTheme();
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const text = (c: Container) => strip(c.render(100).join("\n"));

const goalsDisplay = {
  kind: "goals_table",
  title: "Goals",
  data: {
    goals: [
      {
        id: "goal-7ee072db",
        version: 1,
        status: "executing",
        title: "Rich tool output",
        linkedRunId: "run-3c2cbf3e",
        reviewCycle: 1,
        maxReviewCycles: 3,
        criteriaTotal: 4,
        criteriaPassed: 2,
        openEscalations: 0,
      },
    ],
  },
};

function turn(over: Partial<ChatTurnRecord>): ChatTurnRecord {
  return { seq: 1, chatSessionId: "chat-1", role: "user", content: "", createdAt: "2026-11-22T00:00:00Z", ...over } as ChatTurnRecord;
}

describe("chat.tool wiring", () => {
  test("display events become cards, others stay pills, and scrollback keeps arrival order", () => {
    const pending: PendingTools = new Map();
    const area = new Container();
    applyChatToolEvent({ id: "t1", name: "read_file", status: "running" }, pending, area, theme);
    applyChatToolEvent({ id: "display-1", name: "goal_list", status: "completed", display: goalsDisplay }, pending, area, theme);
    applyChatToolEvent({ id: "t1", name: "read_file", status: "completed" }, pending, area, theme);
    // A duplicate display event for the same id must not add a second card.
    applyChatToolEvent({ id: "display-1", name: "goal_list", status: "completed", display: goalsDisplay }, pending, area, theme);

    expect(area.children.length).toBe(2);
    expect(area.children[0]).toBeInstanceOf(ToolPill);
    expect(area.children[1]).toBeInstanceOf(ToolOutputCard);
    expect(text(area)).toContain("goal-7ee072db");
    expect(text(area)).toContain("read_file");

    const scrollback = new Container();
    preservePendingTools(pending, scrollback);
    expect(scrollback.children).toEqual([area.children[0]!, area.children[1]!]);

    const cancelled = new Container();
    preservePendingTools(pending, cancelled, { cardsOnly: true });
    expect(cancelled.children).toEqual([area.children[1]!]);
  });

  test("invalid display falls back to the pill path", () => {
    const pending: PendingTools = new Map();
    const area = new Container();
    applyChatToolEvent({ id: "x", name: "goal_list", status: "completed", display: { data: {} } }, pending, area, theme);
    expect(area.children[0]).toBeInstanceOf(ToolPill);
  });
});

describe("history replay", () => {
  test("tool_output turns render as cards (or notes); other roles unchanged", () => {
    const card = historyTurnComponent(
      turn({ role: "tool_output", content: "goal_list → Goals table (1 goals)", toolName: "goal_list", display: goalsDisplay }),
      theme,
      "m",
    );
    expect(card).toBeInstanceOf(ToolOutputCard);
    expect(strip(card.render(100).join("\n"))).toContain("Rich tool output");

    const note = historyTurnComponent(turn({ role: "tool_output", content: "goal_list → Goals table", display: null }), theme, "m");
    expect(note).toBeInstanceOf(ToolOutputNote);

    expect(historyTurnComponent(turn({ role: "user", content: "hi" }), theme, "m")).not.toBeInstanceOf(ToolOutputCard);
    const sys = historyTurnComponent(turn({ role: "system_notice", content: "notice text" }), theme, "m");
    expect(strip(sys.render(100).join("\n"))).toContain("notice text");
  });
});
