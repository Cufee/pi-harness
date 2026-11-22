import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "../primitives/theme.js";
import { secondary } from "../primitives/rows.js";
import { renderProgressBar } from "../primitives/layout.js";
import { clampLine, fillLineBg, fitWidth } from "../primitives/width.js";
import { asInt, asIntOrNull, asRecord, sanitizeText, statusPaint, type ToolDisplayPayload } from "./types.js";

const MAX_CRITERIA = 12;
const MAX_ESCALATIONS = 5;
const MAX_NON_GOALS = 5;
const MAX_SUMMARY_LINES = 3;

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(asRecord).filter((r): r is Record<string, unknown> => r !== null) : [];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => sanitizeText(x)).filter(Boolean) : [];
}

/**
 * Native `goal_detail` UI card: framed header (id, version, status, title), metadata & progress bar,
 * criteria with ✓/✗/○ markers (+ deterministic commands), non-goals, task breakdown, open escalations,
 * and latest review verdict. Used both when models return goals and when users print a goal from `/goals`.
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
  const nonGoals = strings(goal.nonGoals);
  const criteria = records(data.criteria);
  const tasks = records(data.tasks);
  const escalations = records(data.openEscalations);
  const lastReview = asRecord(data.lastReview);

  const out: string[] = [];
  const rail = `${theme.border("│")} `;
  const innerW = Math.max(1, width - 2);
  const row = (content: string) => out.push(clampLine(`${rail}${truncateToWidth(content, innerW, "…")}`, width));
  const subRow = (content: string) => {
    const subW = Math.max(1, innerW - 2);
    out.push(clampLine(`${rail}  ${truncateToWidth(content, subW, "…")}`, width));
  };
  const wrappedSub = (text: string, paint: (s: string) => string, maxLines = Infinity) => {
    const subW = Math.max(1, innerW - 2);
    const parts = wrapTextWithAnsi(text, subW);
    const shown = parts.slice(0, maxLines);
    if (parts.length > shown.length && shown.length > 0) shown[shown.length - 1] += "…";
    for (const p of shown) out.push(clampLine(`${rail}  ${paint(p)}`, width));
  };

  // Framed top rule + shaded header strip so printed Goals stand out cleanly from chat prose
  const headerTag = `${theme.accent("◆")} ${theme.bold(`${id} v${version}`)}  ${statusPaint(status, theme)(`● ${status}`)}`;
  const topLabel = ` ${headerTag} `;
  const topFill = Math.max(0, width - 2 - visibleWidth(topLabel));
  out.push(clampLine(`${theme.border("╭─")}${topLabel}${theme.border("─".repeat(topFill))}`, width));

  const titleLines = wrapTextWithAnsi(title, Math.max(1, innerW));
  for (const tl of titleLines) {
    const lineText = `${rail}${theme.bold(tl)}`;
    out.push(fillLineBg(fitWidth(lineText, width), width, theme.surfaceBg));
  }

  const description = sanitizeText(goal.description);
  if (description) wrappedSub(description, theme.muted, 2);

  const passed = criteria.filter((c) => c.lastResult === "pass").length;
  const maxCycles = asIntOrNull(goal.maxReviewCycles);
  const verifyLabel = sanitizeText(goal.verificationLabel);
  const reviewMeta = verifyLabel
    ? `Verify ${verifyLabel}`
    : maxCycles !== null && maxCycles > 0
      ? `Review ${asInt(goal.reviewCycle)}/${maxCycles}`
      : asInt(goal.reviewCycle) > 0
        ? `Reviews ${asInt(goal.reviewCycle)}`
        : "Verify —";
  const meta = [
    `Run ${runId || "—"}`,
    reviewMeta,
    `Criteria ${passed}/${criteria.length} passed`,
  ];
  if (tasks.length > 0) meta.push(`Tasks ${tasks.length}`);
  const metaText = secondary(theme, meta.join(" · "));
  if (criteria.length > 0 && width >= 88) {
    const bar = renderProgressBar(passed / criteria.length, theme, { barWidth: 8 });
    subRow(`${metaText}  ${bar}`);
  } else {
    subRow(metaText);
  }

  const liveSummary = sanitizeText(goal.liveSummary);
  if (liveSummary && !lastReview) {
    wrappedSub(`Progress: ${liveSummary}`, theme.info, 2);
  }

  if (tasks.length > 0) {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      const st = sanitizeText(t.status) || "unknown";
      counts.set(st, (counts.get(st) ?? 0) + 1);
    }
    const breakdown = [...counts.entries()].map(([st, n]) => `${n} ${st}`).join(" · ");
    if (breakdown) subRow(`${theme.dim("Task states:")} ${theme.muted(breakdown)}`);
    const richTasks = tasks.filter((t) => sanitizeText(t.model) || sanitizeText(t.currentAction));
    if (richTasks.length > 0) {
      row(theme.muted(theme.bold("Subagents")));
      for (const t of richTasks.slice(0, 6)) {
        const st = sanitizeText(t.status) || "unknown";
        const icon =
          st === "completed"
            ? theme.success("✓")
            : st === "failed" || st === "cancelled"
              ? theme.error("✗")
              : st === "paused_quota"
                ? theme.warning("⏸")
                : theme.accent("⚙");
        const kind = sanitizeText(t.kind) || `T${asInt(t.tier, 2)}`;
        const model = sanitizeText(t.model);
        const effort = sanitizeText(t.effort);
        const modelStr = model ? ` ${theme.accent(`[${model}${effort ? ` (${effort})` : ""}]`)}` : "";
        const action = sanitizeText(t.currentAction);
        const tools = asInt(t.toolCalls);
        const durS = Math.round(asInt(t.elapsedMs) / 1000);
        const stat = tools > 0 || durS > 0 ? ` ${theme.dim(`(${[tools > 0 ? `${tools}t` : "", durS > 0 ? `${durS}s` : ""].filter(Boolean).join(" · ")})`)}` : "";
        const desc = action || sanitizeText(t.title) || sanitizeText(t.id);
        subRow(`${icon} ${theme.bold(`T${asInt(t.tier, 2)}/${kind}`)}${modelStr} ${desc}${stat}`);
      }
      if (richTasks.length > 6) subRow(theme.dim(`… ${richTasks.length - 6} more subagent(s)`));
    }
  }

  if (criteria.length > 0) {
    row(theme.muted(theme.bold("Criteria")));
    for (const c of criteria.slice(0, MAX_CRITERIA)) {
      const marker =
        c.lastResult === "pass" ? theme.success("✓") : c.lastResult === "fail" ? theme.error("✗") : theme.dim("○");
      const desc = sanitizeText(c.description) || sanitizeText(c.id) || "(criterion)";
      const cmd = sanitizeText(c.command);
      const cmdHint = cmd && width >= 72 ? ` ${theme.code(`$ ${cmd}`)}` : "";
      const optional = c.required === false ? theme.dim(" (optional)") : "";
      subRow(`${marker} ${desc}${optional}${cmdHint}`);
    }
    if (criteria.length > MAX_CRITERIA) subRow(theme.dim(`… ${criteria.length - MAX_CRITERIA} more`));
  }

  if (nonGoals.length > 0) {
    row(theme.muted(theme.bold("Non-goals")));
    for (const ng of nonGoals.slice(0, MAX_NON_GOALS)) {
      subRow(`${theme.dim("·")} ${theme.muted(ng)}`);
    }
    if (nonGoals.length > MAX_NON_GOALS) subRow(theme.dim(`… ${nonGoals.length - MAX_NON_GOALS} more`));
  }

  if (escalations.length > 0) {
    row(theme.warning(theme.bold(`Open escalations (${escalations.length})`)));
    for (const e of escalations.slice(0, MAX_ESCALATIONS)) {
      const task = sanitizeText(e.taskId);
      const summary = sanitizeText(e.summary) || sanitizeText(e.id) || "(escalation)";
      subRow(`${theme.warning("!")} ${task ? theme.dim(`[${task}] `) : ""}${summary}`);
    }
    if (escalations.length > MAX_ESCALATIONS) {
      subRow(theme.dim(`… ${escalations.length - MAX_ESCALATIONS} more`));
    }
  }

  if (lastReview) {
    const verdict = sanitizeText(lastReview.verdict) || "unknown";
    const verdictPaint = verdict === "approved" ? theme.success : theme.warning;
    row(`${theme.muted(theme.bold(`Last review #${asInt(lastReview.cycle)}`))} ${verdictPaint(verdict.toUpperCase())}`);
    const summary = sanitizeText(lastReview.summary);
    if (summary) wrappedSub(summary, theme.muted, MAX_SUMMARY_LINES);
  }

  out.push(clampLine(theme.border(`╰${"─".repeat(Math.max(0, width - 1))}`), width));
  return out;
}
