/**
 * Structured tool-output rendering for the TUI (`contract/tool-display-v1`).
 *
 * Wiring into src/tui/app.ts takes two small changes:
 *
 * 1. Live events — in the `chat.tool` branch, before the ToolPill logic:
 *
 *      const display = extractDisplay(ev.payload);
 *      if (display) {
 *        pendingToolsContainer.addChild(new ToolOutputCard(theme, display));
 *        tui.requestRender();
 *        return;
 *      }
 *      // …existing ToolPill path unchanged for events without a display
 *
 * 2. History replay — in `seedTranscript`, first thing inside the history loop:
 *
 *      const toolCard = componentForHistoryTurn(t, theme);
 *      if (toolCard) { chatContainer.addChild(toolCard); continue; }
 *
 * New display kinds: `registerToolOutputRenderer(kind, (display, width, theme) => lines | null)`.
 * Unknown kinds and malformed data render as one compact fallback line, never raw JSON.
 */
export { ToolOutputCard, ToolOutputNote } from "./card.js";
export { renderGoalDetail } from "./goal-detail.js";
export { renderGoalsTable } from "./goals-table.js";
export { hasToolOutputRenderer, registerToolOutputRenderer, renderFallbackLine, renderToolOutput } from "./registry.js";
export { componentForHistoryTurn, extractDisplay, parseToolDisplay, type ToolOutputTurnLike } from "./transcript.js";
export type { ToolDisplayPayload, ToolOutputRenderer } from "./types.js";
