import { clamp, fillLineBg, visibleWidth } from "../core/text.js";
import type { Theme } from "../core/tokens.js";
import { asInt, asRecord, sanitizeField, statusPaint, type ToolDisplayPayload } from "./types.js";

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

/**
 * Native `run_activity` UI card: renders subagent & run telemetry (phase, models used,
 * files edited, and per-subagent live action / tool count / duration).
 */
export function renderRunActivity(display: ToolDisplayPayload, width: number, theme: Theme): string[] | null {
  const data = asRecord(display.data);
  const runId = sanitizeField(data?.runId);
  if (!data || !runId) return null;

  const g = theme.glyphs;
  const phase = sanitizeField(data.phase) || "active";
  const elapsedMs = asInt(data.elapsedMs);
  const filesEdited = asInt(data.filesEdited);
  const openEsc = asInt(data.openEscalations);
  const models = Array.isArray(data.modelsUsed) ? data.modelsUsed.map((m) => sanitizeField(m)).filter(Boolean) : [];
  const tasks = Array.isArray(data.tasks)
    ? data.tasks.map(asRecord).filter((r): r is Record<string, unknown> => r !== null)
    : [];

  const out: string[] = [];
  const rail = `${theme.border(g.barV)} `;
  const innerW = Math.max(1, width - 2);
  const row = (content: string) => out.push(clamp(`${rail}${clamp(content, innerW)}`, width));

  const headerTag = `${theme.accent(g.diamond)} ${theme.bold(runId)}  ${statusPaint(phase, theme)(`${g.running} ${phase}`)}`;
  const topLabel = ` ${headerTag} `;
  const topFill = Math.max(0, width - 2 - visibleWidth(topLabel));
  out.push(clamp(`${theme.border(`${g.boxTL}${g.barH}`)}${topLabel}${theme.border(g.barH.repeat(topFill))}`, width));

  const metaParts = [`${tasks.length} agent${tasks.length === 1 ? "" : "s"}`, fmtElapsed(elapsedMs)];
  if (filesEdited > 0) metaParts.push(`${filesEdited} file${filesEdited === 1 ? "" : "s"} edited`);
  if (openEsc > 0) metaParts.push(`${openEsc} open escalation${openEsc === 1 ? "" : "s"}`);
  if (models.length > 0 && width >= 68) metaParts.push(`models: ${models.slice(0, 3).join(", ")}`);
  out.push(fillLineBg(`${rail}${theme.dim(metaParts.join(` ${g.sep} `))}`, width, theme.surfaceBg));

  if (tasks.length === 0) {
    row(theme.muted("No subagents launched yet."));
  } else {
    for (const t of tasks.slice(0, 12)) {
      const status = sanitizeField(t.status) || "unknown";
      const kind = sanitizeField(t.kind) || "task";
      const tier = asInt(t.tier, 2);
      const title = sanitizeField(t.title) || sanitizeField(t.id) || "(agent)";
      const model = sanitizeField(t.model) || sanitizeField(t.profileId);
      const effort = sanitizeField(t.effort);
      const action = sanitizeField(t.currentAction);
      const tools = asInt(t.toolCalls);
      const edited = asInt(t.filesEdited);
      const dur = fmtElapsed(asInt(t.elapsedMs));

      const icon =
        status === "completed"
          ? theme.ok(g.check)
          : status === "failed" || status === "cancelled"
            ? theme.danger(g.cross)
            : status === "paused_quota"
              ? theme.warn(g.pause)
              : theme.accent(g.running);
      const roleTag = theme.bold(`T${tier}/${kind}`);
      const modelTag = model ? ` ${theme.accent(`[${model}${effort ? ` (${effort})` : ""}]`)}` : "";
      const stats: string[] = [dur];
      if (tools > 0) stats.push(`${tools}t`);
      if (edited > 0) stats.push(`${edited}f`);
      const actionStr = action ? ` ${theme.muted(action)}` : "";
      row(`${icon} ${roleTag}${modelTag} ${title}${actionStr} ${theme.dim(`(${stats.join(" · ")})`)}`);
    }
    if (tasks.length > 12) {
      row(theme.dim(`… ${tasks.length - 12} more subagent(s)`));
    }
  }

  out.push(clamp(theme.border(`${g.boxBL}${g.barH.repeat(Math.max(0, width - 1))}`), width));
  return out;
}
