import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "../primitives/theme.js";
import { clampLine } from "../primitives/width.js";
import { asInt, asRecord, sanitizeText, statusPaint, type ToolDisplayPayload } from "./types.js";

const INDENT = "  ";
const SUB = "    ";
const MAX_CRITERIA = 12;
const MAX_ESCALATIONS = 5;
const MAX_SUMMARY_LINES = 3;

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(asRecord).filter((r): r is Record<string, unknown> => r !== null) : [];
}

/**
 * `goal_detail` renderer: header (id, version, status, title), a meta line (run, review cycle, criteria
 * tally, tasks), criteria with ✓/✗/○ markers, open escalations, and the last review summary.
 */
export function renderGoalDetail(display: ToolDisplayPayload, width: number, theme: HarnessTheme): string[] | null {
  const data = asRecord(display.data);
  const goal = asRecord(data?.goal);
  const id = sanitizeText(goal?.id);
  if (!data || !goal || !id) return null;

  const version = asInt(goal.version, 1);
  const status = sanitizeText(goal.status) || "unknown";
  const title = sanitizeText(goal.title) || "(untitled)";
  const runId = sanitizeText(goal.linkedRunId);
  const criteria = records(data.criteria);
  const tasks = records(data.tasks);
  const escalations = records(data.openEscalations);
  const lastReview = asRecord(data.lastReview);

  const out: string[] = [];
  const line = (s: string) => out.push(clampLine(truncateToWidth(s, width, "…"), width));
  const wrapped = (prefix: string, text: string, paint: (s: string) => string, maxLines = Infinity) => {
    const inner = Math.max(1, width - prefix.length);
    const parts = wrapTextWithAnsi(text, inner);
    const shown = parts.slice(0, maxLines);
    if (parts.length > shown.length && shown.length > 0) shown[shown.length - 1] += "…";
    for (const p of shown) line(prefix + paint(p));
  };

  line(
    `${INDENT}${theme.accent("◆")} ${theme.bold(`${id} v${version}`)}  ${statusPaint(status, theme)(`● ${status}`)}  ${title}`,
  );

  const description = sanitizeText(goal.description);
  if (description) wrapped(SUB, description, theme.muted, 2);

  const passed = criteria.filter((c) => c.lastResult === "pass").length;
  const meta = [
    `Run ${runId || "—"}`,
    `Review ${asInt(goal.reviewCycle)}/${asInt(goal.maxReviewCycles)}`,
    `Criteria ${passed}/${criteria.length} passed`,
  ];
  if (tasks.length > 0) meta.push(`Tasks ${tasks.length}`);
  line(`${SUB}${theme.dim(meta.join(" · "))}`);

  if (criteria.length > 0) {
    line(`${INDENT}${theme.muted(theme.bold("Criteria"))}`);
    for (const c of criteria.slice(0, MAX_CRITERIA)) {
      const marker =
        c.lastResult === "pass" ? theme.success("✓") : c.lastResult === "fail" ? theme.error("✗") : theme.dim("○");
      const desc = sanitizeText(c.description) || sanitizeText(c.id) || "(criterion)";
      const optional = c.required === false ? theme.dim(" (optional)") : "";
      line(`${SUB}${marker} ${desc}${optional}`);
    }
    if (criteria.length > MAX_CRITERIA) line(`${SUB}${theme.dim(`… ${criteria.length - MAX_CRITERIA} more`)}`);
  }

  if (escalations.length > 0) {
    line(`${INDENT}${theme.warning(theme.bold(`Open escalations (${escalations.length})`))}`);
    for (const e of escalations.slice(0, MAX_ESCALATIONS)) {
      const task = sanitizeText(e.taskId);
      const summary = sanitizeText(e.summary) || sanitizeText(e.id) || "(escalation)";
      line(`${SUB}${theme.warning("!")} ${task ? theme.dim(`[${task}] `) : ""}${summary}`);
    }
    if (escalations.length > MAX_ESCALATIONS) {
      line(`${SUB}${theme.dim(`… ${escalations.length - MAX_ESCALATIONS} more`)}`);
    }
  }

  if (lastReview) {
    const verdict = sanitizeText(lastReview.verdict) || "unknown";
    const verdictPaint = verdict === "approved" ? theme.success : theme.warning;
    line(
      `${INDENT}${theme.muted(theme.bold(`Last review #${asInt(lastReview.cycle)}`))} ${verdictPaint(verdict.toUpperCase())}`,
    );
    const summary = sanitizeText(lastReview.summary);
    if (summary) wrapped(SUB, summary, theme.muted, MAX_SUMMARY_LINES);
  }
  return out;
}
