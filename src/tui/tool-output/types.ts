import { sanitizeLine } from "../core/text.js";
import type { Theme } from "../core/tokens.js";

/**
 * Local structural copy of the frozen `contract/tool-display-v1` wire shape.
 */
export interface ToolDisplayPayload {
  kind: string;
  title?: string;
  /** Untrusted: renderers must validate before use. */
  data: unknown;
}

export type ToolOutputRenderer = (display: ToolDisplayPayload, width: number, theme: Theme) => string[] | null;

export type UnknownRecord = Record<string, unknown>;

export function asRecord(v: unknown): UnknownRecord | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as UnknownRecord) : null;
}

export function sanitizeField(v: unknown): string {
  return typeof v === "string" ? sanitizeLine(v) : "";
}

export function asInt(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

export function asIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null;
}

/** Validates an untrusted `{ kind, title?, data }` object. Returns a normalized copy or `null`. */
export function parseToolDisplay(value: unknown): ToolDisplayPayload | null {
  const d = asRecord(value);
  if (!d || typeof d.kind !== "string" || d.kind.trim() === "") return null;
  const out: ToolDisplayPayload = { kind: d.kind, data: d.data };
  if (typeof d.title === "string" && d.title.trim() !== "") out.title = d.title;
  return out;
}

/** Extracts the structured display carried by a `chat.tool` event payload, or `null` if none/invalid. */
export function extractDisplay(chatToolPayload: unknown): ToolDisplayPayload | null {
  return parseToolDisplay(asRecord(chatToolPayload)?.display);
}

/** Themed paint for a goal/task status label. */
export function statusPaint(status: string, theme: Theme): (s: string) => string {
  switch (status) {
    case "achieved":
    case "completed":
      return theme.ok;
    case "executing":
    case "active":
    case "running":
      return theme.accent;
    case "verifying":
    case "reviewing":
      return theme.info;
    case "awaiting_human":
    case "paused":
    case "paused_quota":
      return theme.warn;
    case "cancelled":
      return theme.dim;
    case "failed":
      return theme.danger;
    default:
      return theme.muted;
  }
}
