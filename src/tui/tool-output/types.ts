import type { HarnessTheme } from "../primitives/theme.js";

/**
 * Local structural copy of the frozen `contract/tool-display-v1` wire shape.
 * Intentionally NOT imported from `src/protocol/tool-display.ts` so this module stays self-contained;
 * any object of the protocol type is assignable to this one.
 */
export interface ToolDisplayPayload {
  kind: string;
  title?: string;
  /** Untrusted: renderers must validate before use. */
  data: unknown;
}

/**
 * Renders a display into lines no wider than `width`.
 * Return `null` when `display.data` is malformed; the registry then renders a compact fallback line.
 * Lines are clamped to `width` by the registry, but renderers should lay out for `width` themselves.
 */
export type ToolOutputRenderer = (display: ToolDisplayPayload, width: number, theme: HarnessTheme) => string[] | null;

export type UnknownRecord = Record<string, unknown>;

export function asRecord(v: unknown): UnknownRecord | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as UnknownRecord) : null;
}

/** Strips ANSI escape sequences and control characters from untrusted text so it cannot corrupt layout. */
export function sanitizeText(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .trim();
}

export function asInt(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : fallback;
}

export function asIntOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null;
}

/** Themed paint for a goal/task status label. Unknown statuses render muted. */
export function statusPaint(status: string, theme: HarnessTheme): (s: string) => string {
  switch (status) {
    case "achieved":
      return theme.success;
    case "executing":
      return theme.accent;
    case "verifying":
    case "reviewing":
      return theme.info;
    case "awaiting_human":
    case "paused":
      return theme.warning;
    case "cancelled":
      return theme.dim;
    case "failed":
      return theme.error;
    default:
      return theme.muted;
  }
}
