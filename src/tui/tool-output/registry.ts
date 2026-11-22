import { clamp } from "../core/text.js";
import type { Theme } from "../core/tokens.js";
import { renderGoalDetail } from "./goal-detail.js";
import { renderGoalsTable } from "./goals-table.js";
import { renderRunActivity } from "./run-activity.js";
import { sanitizeField, type ToolDisplayPayload, type ToolOutputRenderer } from "./types.js";

const renderers = new Map<string, ToolOutputRenderer>([
  ["goals_table", renderGoalsTable],
  ["goal_detail", renderGoalDetail],
  ["run_activity", renderRunActivity],
]);

export function registerToolOutputRenderer(kind: string, renderer: ToolOutputRenderer): () => void {
  const previous = renderers.get(kind);
  renderers.set(kind, renderer);
  return () => {
    if (renderers.get(kind) !== renderer) return;
    if (previous) renderers.set(kind, previous);
    else renderers.delete(kind);
  };
}

export function hasToolOutputRenderer(kind: string): boolean {
  return renderers.has(kind);
}

/** One compact themed line, used for unknown kinds and malformed data. Never dumps raw data. */
export function renderFallbackLine(
  display: Pick<ToolDisplayPayload, "kind" | "title">,
  width: number,
  theme: Theme,
  note = "unsupported display",
): string {
  const label = sanitizeField(display.title) || sanitizeField(display.kind) || "tool output";
  return clamp(`  ${theme.muted(theme.glyphs.diamond)} ${theme.bold(label)} ${theme.dim(`${theme.glyphs.sep} (${note})`)}`, width);
}

/**
 * Renders a structured tool display into width-safe lines (every line `visibleWidth <= width`).
 * Unknown kinds, malformed data, and throwing renderers degrade to a single fallback line.
 */
export function renderToolOutput(display: ToolDisplayPayload, width: number, theme: Theme): string[] {
  if (width <= 0) return [];
  const renderer = renderers.get(display.kind);
  if (!renderer) return [renderFallbackLine(display, width, theme)];
  let lines: string[] | null;
  try {
    lines = renderer(display, width, theme);
  } catch {
    lines = null;
  }
  if (!Array.isArray(lines)) return [renderFallbackLine(display, width, theme, "invalid display data")];
  return lines.map((l) => clamp(String(l), width));
}
