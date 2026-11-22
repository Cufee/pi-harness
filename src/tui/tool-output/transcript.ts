import type { Component } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "../primitives/theme.js";
import { ToolOutputCard, ToolOutputNote } from "./card.js";
import { asRecord, type ToolDisplayPayload } from "./types.js";

/** Structural subset of `ChatTurnRecord` (src/director/session.ts) this module reads. */
export interface ToolOutputTurnLike {
  role: string;
  content?: unknown;
  toolName?: unknown;
  display?: unknown;
}

/** Validates an untrusted `{ kind, title?, data }` object. Returns a normalized copy or `null`. */
export function parseToolDisplay(value: unknown): ToolDisplayPayload | null {
  const d = asRecord(value);
  if (!d || typeof d.kind !== "string" || d.kind.trim() === "") return null;
  const out: ToolDisplayPayload = { kind: d.kind, data: d.data };
  if (typeof d.title === "string" && d.title.trim() !== "") out.title = d.title;
  return out;
}

/**
 * Returns the structured display carried by a `chat.tool` event payload, or `null` when the event has
 * none (or it is invalid) — in which case the caller keeps the existing compact `ToolPill` path.
 */
export function extractDisplay(chatToolPayload: unknown): ToolDisplayPayload | null {
  return parseToolDisplay(asRecord(chatToolPayload)?.display);
}

/**
 * Transcript component for a persisted history turn: a `ToolOutputCard` for `tool_output` turns with a
 * valid display, a compact dim note for `tool_output` turns without one, and `null` for every other
 * role (the caller renders user/assistant/system turns as before).
 */
export function componentForHistoryTurn(turn: ToolOutputTurnLike, theme: HarnessTheme): Component | null {
  if (turn.role !== "tool_output") return null;
  const display = parseToolDisplay(turn.display);
  if (display) return new ToolOutputCard(theme, display);
  const content = typeof turn.content === "string" ? turn.content : "";
  const toolName = typeof turn.toolName === "string" ? turn.toolName : "";
  return new ToolOutputNote(theme, content || toolName);
}
