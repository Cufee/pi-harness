import { clamp, fit, padLeft, visibleWidth } from "../core/text.js";
import type { Theme } from "../core/tokens.js";
import { asInt, asIntOrNull, asRecord, sanitizeField, statusPaint, type ToolDisplayPayload } from "./types.js";

interface GoalRow {
  id: string;
  version: number;
  status: string;
  title: string;
  linkedRunId: string | null;
  reviewCycle: number;
  maxReviewCycles: number | null;
  verificationLabel: string | null;
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
    const id = sanitizeField(g?.id);
    if (!g || !id) {
      skipped++;
      continue;
    }
    rows.push({
      id,
      version: asInt(g.version, 1),
      status: sanitizeField(g.status) || "unknown",
      title: sanitizeField(g.title) || "(untitled)",
      linkedRunId: sanitizeField(g.linkedRunId) || null,
      reviewCycle: asInt(g.reviewCycle),
      maxReviewCycles: asIntOrNull(g.maxReviewCycles),
      verificationLabel: sanitizeField(g.verificationLabel) || null,
      criteriaTotal: asInt(g.criteriaTotal),
      criteriaPassed: asIntOrNull(g.criteriaPassed),
      openEscalations: asInt(g.openEscalations),
    });
  }
  return { rows, skipped };
}

function reviewText(r: GoalRow, check: string): string {
  const base =
    r.verificationLabel ??
    (r.maxReviewCycles !== null && r.maxReviewCycles > 0
      ? `${r.reviewCycle}/${r.maxReviewCycles}`
      : r.reviewCycle > 0
        ? `${r.reviewCycle} rev`
        : "—");
  if (r.criteriaPassed === null) return base;
  return base === "—" ? `${r.criteriaPassed}/${r.criteriaTotal}${check}` : `${base} · ${r.criteriaPassed}/${r.criteriaTotal}${check}`;
}

function statusText(r: GoalRow, mode: StatusMode, dot: string): string {
  if (mode === "dot") return dot;
  return mode === "full" ? `${dot} ${r.status}` : r.status;
}

/**
 * `goals_table` renderer. Columns: Goal · Status · Title (flex) · Run · Review · Esc.
 * Gracefully degrades low-priority columns on narrow viewports while keeping Title readable.
 */
export function renderGoalsTable(display: ToolDisplayPayload, width: number, theme: Theme): string[] | null {
  const parsed = parseGoals(display.data);
  if (!parsed) return null;
  const { rows, skipped } = parsed;
  const g = theme.glyphs;

  const heading = sanitizeField(display.title) || "Goals";
  const escTotal = rows.reduce((n, r) => n + r.openEscalations, 0);
  const summary = ` ${g.sep} ${rows.length} goal${rows.length === 1 ? "" : "s"}`;
  let headLine = `${INDENT}${theme.accent(g.diamond)} ${theme.bold(heading)}${theme.dim(summary)}`;
  if (escTotal > 0) headLine += theme.warn(` ${g.sep} ${escTotal} open escalation${escTotal === 1 ? "" : "s"}`);
  const head = [clamp(headLine, width)];

  if (rows.length === 0) {
    return [...head, clamp(`${INDENT}${theme.dim("No goals yet — describe an objective in chat to draft one.")}`, width)];
  }

  const cells = rows.map((r) => ({
    goal: `${r.id} v${r.version}`,
    run: r.linkedRunId ?? "—",
    review: reviewText(r, g.check),
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
      : Math.min(mode === "label" ? STATUS_LABEL_MAX : Infinity, natural("Status", rows.map((r) => statusText(r, mode, g.running))));

  const show = { run: true, review: true, esc: true };
  let statusMode = "full" as StatusMode;
  const fixedWidth = () => {
    const widths = [goalW, statusW(statusMode)];
    if (show.run) widths.push(runW);
    if (show.review) widths.push(reviewW);
    if (show.esc) widths.push(escW);
    return INDENT.length + widths.reduce((a, b) => a + b, 0) + widths.length * GAP.length;
  };
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
  const cell = (k: ColumnKey, plain: string, paint: (s: string) => string) => {
    const sized = alignRight(k) ? padLeft(plain, colWidth[k]) : fit(plain, colWidth[k]);
    return sized.replace(/^( *)(.*?)( *)$/, (_m, lead: string, text: string, trail: string) => lead + paint(text) + trail);
  };

  const headers: Record<ColumnKey, string> = {
    goal: "Goal",
    status: statusMode === "dot" ? "" : "Status",
    title: "Title",
    run: "Run",
    review: "Review",
    esc: "Esc",
  };
  const headerPaint = (s: string) => theme.muted(theme.bold(s));
  const join = (parts: string[]) => clamp(INDENT + parts.join(GAP), width);
  const tableWidth = order.reduce((n, k) => n + colWidth[k], 0) + GAP.length * (order.length - 1);

  const out = [...head, join(order.map((k) => cell(k, headers[k], headerPaint)))];
  out.push(clamp(INDENT + theme.border(g.barH.repeat(Math.max(0, Math.min(tableWidth, width - INDENT.length)))), width));

  rows.forEach((r, i) => {
    const c = cells[i]!;
    const statusColor = statusPaint(r.status, theme);
    const reviewPaint =
      r.criteriaPassed === null || r.criteriaTotal === 0
        ? theme.muted
        : r.criteriaPassed >= r.criteriaTotal
          ? theme.ok
          : theme.warn;
    const parts = order.map((k) => {
      switch (k) {
        case "goal":
          return cell(k, c.goal, theme.bold);
        case "status":
          return cell(k, statusText(r, statusMode, g.running), statusColor);
        case "title":
          return cell(k, r.title, theme.text);
        case "run":
          return cell(k, c.run, r.linkedRunId ? theme.accent : theme.dim);
        case "review":
          return cell(k, c.review, reviewPaint);
        case "esc":
          return cell(k, c.esc, r.openEscalations > 0 ? (s) => theme.warn(theme.bold(s)) : theme.dim);
      }
    });
    out.push(join(parts));
  });

  if (skipped > 0) {
    out.push(clamp(`${INDENT}${theme.dim(`(${skipped} malformed row${skipped === 1 ? "" : "s"} skipped)`)}`, width));
  }
  return out;
}
