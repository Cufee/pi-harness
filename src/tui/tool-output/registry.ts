import { truncateToWidth } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "../primitives/theme.js";
import { clampLine } from "../primitives/width.js";
import { renderGoalDetail } from "./goal-detail.js";
import { renderGoalsTable } from "./goals-table.js";
import { sanitizeText, type ToolDisplayPayload, type ToolOutputRenderer } from "./types.js";

const renderers = new Map<string, ToolOutputRenderer>([
  ["goals_table", renderGoalsTable],
  ["goal_detail", renderGoalDetail],
]);

/**
 * Registers (or replaces) the renderer for a display `kind`.
 * Returns a disposer that restores whatever renderer was registered before.
 */
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
  theme: HarnessTheme,
  note = "unsupported display",
): string {
  const label = sanitizeText(display.title) || sanitizeText(display.kind) || "tool output";
  return clampLine(truncateToWidth(`  ${theme.muted("◇")} ${theme.bold(label)} ${theme.dim(`· (${note})`)}`, width, "…"), width);
}

/**
 * Renders a structured tool display into width-safe lines (every line `visibleWidth <= width`).
 * Unknown kinds, malformed data, and throwing renderers all degrade to a single fallback line.
 */
export function renderToolOutput(display: ToolDisplayPayload, width: number, theme: HarnessTheme): string[] {
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
  return lines.map((l) => clampLine(String(l), width));
}
