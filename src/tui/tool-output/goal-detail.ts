import { renderProgressBar } from "../core/layout.js";
import { clamp, fillLineBg, visibleWidth, wrap } from "../core/text.js";
import type { Theme } from "../core/tokens.js";
import { asInt, asIntOrNull, asRecord, sanitizeField, statusPaint, type ToolDisplayPayload } from "./types.js";

const MAX_CRITERIA = 12;
const MAX_ESCALATIONS = 5;
const MAX_NON_GOALS = 5;
const MAX_SUMMARY_LINES = 3;

function records(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.map(asRecord).filter((r): r is Record<string, unknown> => r !== null) : [];
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => sanitizeField(x)).filter(Boolean) : [];
}

/**
 * Native `goal_detail` UI card: framed header, shaded title surface, metadata & progress bar,
 * criteria with check/cross/pending markers, non-goals, subagent breakdown, open escalations,
 * and latest review verdict.
 */
export function renderGoalDetail(display: ToolDisplayPayload, width: number, theme: Theme): string[] | null {
  const data = asRecord(display.data);
  const goal = asRecord(data?.goal);
  const id = sanitizeField(goal?.id);
  if (!data || !goal || !id) return null;

  const g = theme.glyphs;
  const version = asInt(goal.version, 1);
  const status = sanitizeField(goal.status) || "unknown";
  const title = sanitizeField(goal.title) || "(untitled)";
  const runId = sanitizeField(goal.linkedRunId);
  const nonGoals = strings(goal.nonGoals);
  const criteria = records(data.criteria);
  const tasks = records(data.tasks);
  const escalations = records(data.openEscalations);
  const lastReview = asRecord(data.lastReview);

  const out: string[] = [];
  const rail = `${theme.border(g.barV)} `;
  const innerW = Math.max(1, width - 2);
  const row = (content: string) => out.push(clamp(`${rail}${clamp(content, innerW)}`, width));
  const subRow = (content: string) => {
    const subW = Math.max(1, innerW - 2);
    out.push(clamp(`${rail}  ${clamp(content, subW)}`, width));
  };
  const wrappedSub = (text: string, paint: (s: string) => string, maxLines = Infinity) => {
    const subW = Math.max(1, innerW - 2);
    const parts = wrap(text, subW);
    const shown = parts.slice(0, maxLines);
    if (parts.length > shown.length && shown.length > 0) shown[shown.length - 1] += "…";
    for (const p of shown) out.push(clamp(`${rail}  ${paint(p)}`, width));
  };

  const headerTag = `${theme.accent(g.diamond)} ${theme.bold(`${id} v${version}`)}  ${statusPaint(status, theme)(`${g.running} ${status}`)}`;
  const topLabel = ` ${headerTag} `;
  const topFill = Math.max(0, width - 2 - visibleWidth(topLabel));
  out.push(clamp(`${theme.border(`${g.boxTL}${g.barH}`)}${topLabel}${theme.border(g.barH.repeat(topFill))}`, width));

  const titleLines = wrap(title, Math.max(1, innerW));
  for (const tl of titleLines) {
    out.push(fillLineBg(`${rail}${theme.bold(tl)}`, width, theme.surfaceBg));
  }

  const description = sanitizeField(goal.description);
  if (description) wrappedSub(description, theme.muted, 2);

  const passed = criteria.filter((c) => c.lastResult === "pass").length;
  const maxCycles = asIntOrNull(goal.maxReviewCycles);
  const verifyLabel = sanitizeField(goal.verificationLabel);
  const reviewMeta = verifyLabel
    ? `Verify ${verifyLabel}`
    : maxCycles !== null && maxCycles > 0
      ? `Review ${asInt(goal.reviewCycle)}/${maxCycles}`
      : asInt(goal.reviewCycle) > 0
        ? `Reviews ${asInt(goal.reviewCycle)}`
        : "Verify —";
  const meta = [`Run ${runId || "—"}`, reviewMeta, `Criteria ${passed}/${criteria.length} passed`];
  if (tasks.length > 0) meta.push(`Tasks ${tasks.length}`);
  const metaText = theme.muted(meta.join(` ${g.sep} `));
  if (criteria.length > 0 && width >= 88) {
    const bar = renderProgressBar(passed / criteria.length, theme, { barWidth: 8 });
    subRow(`${metaText}  ${bar}`);
  } else {
    subRow(metaText);
  }

  const liveSummary = sanitizeField(goal.liveSummary);
  if (liveSummary && !lastReview) {
    wrappedSub(`Progress: ${liveSummary}`, theme.info, 2);
  }

  if (tasks.length > 0) {
    const counts = new Map<string, number>();
    for (const t of tasks) {
      const st = sanitizeField(t.status) || "unknown";
      counts.set(st, (counts.get(st) ?? 0) + 1);
    }
    const breakdown = [...counts.entries()].map(([st, n]) => `${n} ${st}`).join(` ${g.sep} `);
    if (breakdown) subRow(`${theme.dim("Task states:")} ${theme.muted(breakdown)}`);
    const richTasks = tasks.filter((t) => sanitizeField(t.model) || sanitizeField(t.currentAction));
    if (richTasks.length > 0) {
      row(theme.muted(theme.bold("Subagents")));
      for (const t of richTasks.slice(0, 6)) {
        const st = sanitizeField(t.status) || "unknown";
        const icon =
          st === "completed"
            ? theme.ok(g.check)
            : st === "failed" || st === "cancelled"
              ? theme.danger(g.cross)
              : st === "paused_quota"
                ? theme.warn(g.pause)
                : theme.accent(g.running);
        const kind = sanitizeField(t.kind) || `T${asInt(t.tier, 2)}`;
        const model = sanitizeField(t.model);
        const effort = sanitizeField(t.effort);
        const modelStr = model ? ` ${theme.accent(`[${model}${effort ? ` (${effort})` : ""}]`)}` : "";
        const action = sanitizeField(t.currentAction);
        const tools = asInt(t.toolCalls);
        const durS = Math.round(asInt(t.elapsedMs) / 1000);
        const stat =
          tools > 0 || durS > 0
            ? ` ${theme.dim(`(${[tools > 0 ? `${tools}t` : "", durS > 0 ? `${durS}s` : ""].filter(Boolean).join(" · ")})`)}`
            : "";
        const desc = action || sanitizeField(t.title) || sanitizeField(t.id);
        subRow(`${icon} ${theme.bold(`T${asInt(t.tier, 2)}/${kind}`)}${modelStr} ${desc}${stat}`);
      }
      if (richTasks.length > 6) subRow(theme.dim(`… ${richTasks.length - 6} more subagent(s)`));
    }
  }

  if (criteria.length > 0) {
    row(theme.muted(theme.bold("Criteria")));
    for (const c of criteria.slice(0, MAX_CRITERIA)) {
      const marker =
        c.lastResult === "pass" ? theme.ok(g.check) : c.lastResult === "fail" ? theme.danger(g.cross) : theme.dim(g.pending);
      const desc = sanitizeField(c.description) || sanitizeField(c.id) || "(criterion)";
      const cmd = sanitizeField(c.command);
      const cmdHint = cmd && width >= 72 ? ` ${theme.code(`$ ${cmd}`)}` : "";
      const optional = c.required === false ? theme.dim(" (optional)") : "";
      subRow(`${marker} ${desc}${optional}${cmdHint}`);
    }
    if (criteria.length > MAX_CRITERIA) subRow(theme.dim(`… ${criteria.length - MAX_CRITERIA} more`));
  }

  if (nonGoals.length > 0) {
    row(theme.muted(theme.bold("Non-goals")));
    for (const ng of nonGoals.slice(0, MAX_NON_GOALS)) {
      subRow(`${theme.dim(g.sep)} ${theme.muted(ng)}`);
    }
    if (nonGoals.length > MAX_NON_GOALS) subRow(theme.dim(`… ${nonGoals.length - MAX_NON_GOALS} more`));
  }

  if (escalations.length > 0) {
    row(theme.warn(theme.bold(`Open escalations (${escalations.length})`)));
    for (const e of escalations.slice(0, MAX_ESCALATIONS)) {
      const task = sanitizeField(e.taskId);
      const summary = sanitizeField(e.summary) || sanitizeField(e.id) || "(escalation)";
      subRow(`${theme.warn(g.warn)} ${task ? theme.dim(`[${task}] `) : ""}${summary}`);
    }
    if (escalations.length > MAX_ESCALATIONS) subRow(theme.dim(`… ${escalations.length - MAX_ESCALATIONS} more`));
  }

  if (lastReview) {
    const verdict = sanitizeField(lastReview.verdict) || "unknown";
    const verdictPaint = verdict === "approved" ? theme.ok : theme.warn;
    row(`${theme.muted(theme.bold(`Last review #${asInt(lastReview.cycle)}`))} ${verdictPaint(verdict.toUpperCase())}`);
    const summary = sanitizeField(lastReview.summary);
    if (summary) wrappedSub(summary, theme.muted, MAX_SUMMARY_LINES);
  }

  out.push(clamp(theme.border(`${g.boxBL}${g.barH.repeat(Math.max(0, width - 1))}`), width));
  return out;
}
