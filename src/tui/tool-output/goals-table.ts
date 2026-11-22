import { visibleWidth } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "../primitives/theme.js";
import { clampLine, fitWidth } from "../primitives/width.js";
import {
  asInt,
  asIntOrNull,
  asRecord,
  sanitizeText,
  statusPaint,
  type ToolDisplayPayload,
} from "./types.js";

interface GoalRow {
  id: string;
  version: number;
  status: string;
  title: string;
  linkedRunId: string | null;
  reviewCycle: number;
  maxReviewCycles: number;
  criteriaTotal: number;
  criteriaPassed: number | null;
  openEscalations: number;
}

const INDENT = "  ";
const GAP = "  ";
const TITLE_MIN = 8;
const TITLE_COMFORT = 20;
const STATUS_LABEL_MAX = 10;

type ColumnKey = "goal" | "status" | "title" | "run" | "review" | "esc";
type StatusMode = "full" | "label" | "dot";

function parseGoals(data: unknown): { rows: GoalRow[]; skipped: number } | null {
  const goals = asRecord(data)?.goals;
  if (!Array.isArray(goals)) return null;
  const rows: GoalRow[] = [];
  let skipped = 0;
  for (const raw of goals) {
    const g = asRecord(raw);
    const id = sanitizeText(g?.id);
    if (!g || !id) {
      skipped++;
      continue;
    }
    rows.push({
      id,
      version: asInt(g.version, 1),
      status: sanitizeText(g.status) || "unknown",
      title: sanitizeText(g.title) || "(untitled)",
      linkedRunId: sanitizeText(g.linkedRunId) || null,
      reviewCycle: asInt(g.reviewCycle),
      maxReviewCycles: asInt(g.maxReviewCycles),
      criteriaTotal: asInt(g.criteriaTotal),
      criteriaPassed: asIntOrNull(g.criteriaPassed),
      openEscalations: asInt(g.openEscalations),
    });
  }
  return { rows, skipped };
}

function reviewText(r: GoalRow): string {
  const cycle = `${r.reviewCycle}/${r.maxReviewCycles}`;
  return r.criteriaPassed === null ? cycle : `${cycle} · ${r.criteriaPassed}/${r.criteriaTotal}✓`;
}

function statusText(r: GoalRow, mode: StatusMode): string {
  if (mode === "dot") return "●";
  return mode === "full" ? `● ${r.status}` : r.status;
}

/**
 * `goals_table` renderer. Columns: Goal · Status · Title (flex) · Run · Review · Esc.
 * As width shrinks it drops Run, then Review (once Title would drop below 20 columns), then shortens
 * Status, drops Esc, and reduces Status to a colored dot (once Title would drop below 8).
 * Title always absorbs the remaining space and truncates with an ellipsis.
 */
export function renderGoalsTable(display: ToolDisplayPayload, width: number, theme: HarnessTheme): string[] | null {
  const parsed = parseGoals(display.data);
  if (!parsed) return null;
  const { rows, skipped } = parsed;

  const heading = sanitizeText(display.title) || "Goals";
  const escTotal = rows.reduce((n, r) => n + r.openEscalations, 0);
  const summary = ` · ${rows.length} goal${rows.length === 1 ? "" : "s"}`;
  const head = [`${INDENT}${theme.accent("◆")} ${theme.bold(heading)}${theme.dim(summary)}`];
  if (escTotal > 0) head[0] += theme.warning(` · ${escTotal} open escalation${escTotal === 1 ? "" : "s"}`);
  head[0] = clampLine(head[0]!, width);

  if (rows.length === 0) {
    return [...head, clampLine(`${INDENT}${theme.dim("No goals yet — describe an objective in chat to draft one.")}`, width)];
  }

  const cells = rows.map((r) => ({
    goal: `${r.id} v${r.version}`,
    run: r.linkedRunId ?? "—",
    review: reviewText(r),
    esc: String(r.openEscalations),
  }));
  const natural = (header: string, values: string[]) => Math.max(visibleWidth(header), ...values.map(visibleWidth));

  let goalW = natural("Goal", cells.map((c) => c.goal));
  const runW = natural("Run", cells.map((c) => c.run));
  const reviewW = natural("Review", cells.map((c) => c.review));
  const escW = natural("Esc", cells.map((c) => c.esc));
  const titleNatural = natural("Title", rows.map((r) => r.title));
  const statusW = (mode: StatusMode) =>
    mode === "dot"
      ? 1
      : Math.min(mode === "label" ? STATUS_LABEL_MAX : Infinity, natural("Status", rows.map((r) => statusText(r, mode))));

  const show = { run: true, review: true, esc: true };
  let statusMode = "full" as StatusMode;
  const fixedWidth = () => {
    const widths = [goalW, statusW(statusMode)];
    if (show.run) widths.push(runW);
    if (show.review) widths.push(reviewW);
    if (show.esc) widths.push(escW);
    // indent + fixed columns + one gap before each column after the first (title included)
    return INDENT.length + widths.reduce((a, b) => a + b, 0) + widths.length * GAP.length;
  };
  // Each step applies only while Title would be narrower than its threshold: Run/Review go before Title
  // gets cramped; Status/Esc shrink only when Title would otherwise be unreadable.
  const degrade: Array<[number, () => void]> = [
    [TITLE_COMFORT, () => (show.run = false)],
    [TITLE_COMFORT, () => (show.review = false)],
    [TITLE_MIN, () => (statusMode = "label")],
    [TITLE_MIN, () => (show.esc = false)],
    [TITLE_MIN, () => (statusMode = "dot")],
  ];
  for (const [minTitle, step] of degrade) {
    if (fixedWidth() + Math.min(minTitle, titleNatural) > width) step();
  }
  if (fixedWidth() + TITLE_MIN > width) {
    goalW = Math.max(4, goalW - (fixedWidth() + TITLE_MIN - width));
  }
  const titleW = Math.max(1, Math.min(titleNatural, width - fixedWidth()));

  const order: ColumnKey[] = ["goal", "status", "title"];
  if (show.run) order.push("run");
  if (show.review) order.push("review");
  if (show.esc) order.push("esc");
  const colWidth: Record<ColumnKey, number> = {
    goal: goalW,
    status: statusW(statusMode),
    title: titleW,
    run: runW,
    review: reviewW,
    esc: escW,
  };
  const alignRight = (k: ColumnKey) => k === "esc";
  // Paint only the cell text, keeping alignment padding unstyled.
  const cell = (k: ColumnKey, plain: string, paint: (s: string) => string) =>
    fitWidth(plain, colWidth[k], { align: alignRight(k) ? "right" : "left" }).replace(
      /^( *)(.*?)( *)$/,
      (_m, lead: string, text: string, trail: string) => lead + paint(text) + trail,
    );

  const headers: Record<ColumnKey, string> = {
    goal: "Goal",
    status: statusMode === "dot" ? "" : "Status",
    title: "Title",
    run: "Run",
    review: "Review",
    esc: "Esc",
  };
  const headerPaint = (s: string) => theme.muted(theme.bold(s));
  const join = (parts: string[]) => clampLine(INDENT + parts.join(GAP), width);
  const tableWidth = order.reduce((n, k) => n + colWidth[k], 0) + GAP.length * (order.length - 1);

  const out = [...head, join(order.map((k) => cell(k, headers[k], headerPaint)))];
  out.push(clampLine(INDENT + theme.border("─".repeat(Math.max(0, Math.min(tableWidth, width - INDENT.length)))), width));

  rows.forEach((r, i) => {
    const c = cells[i]!;
    const statusColor = statusPaint(r.status, theme);
    const reviewPaint =
      r.criteriaPassed === null || r.criteriaTotal === 0
        ? theme.muted
        : r.criteriaPassed >= r.criteriaTotal
          ? theme.success
          : theme.warning;
    const parts = order.map((k) => {
      switch (k) {
        case "goal":
          return cell(k, c.goal, theme.bold);
        case "status":
          return cell(k, statusText(r, statusMode), statusColor);
        case "title":
          return cell(k, r.title, theme.text);
        case "run":
          return cell(k, c.run, r.linkedRunId ? theme.accent : theme.dim);
        case "review":
          return cell(k, c.review, reviewPaint);
        case "esc":
          return cell(k, c.esc, r.openEscalations > 0 ? (s) => theme.warning(theme.bold(s)) : theme.dim);
      }
    });
    out.push(join(parts));
  });

  if (skipped > 0) {
    out.push(clampLine(`${INDENT}${theme.dim(`(${skipped} malformed row${skipped === 1 ? "" : "s"} skipped)`)}`, width));
  }
  return out;
}
