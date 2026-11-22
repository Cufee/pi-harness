import {
  replaceControlCharacters,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/**
 * Single boundary sanitizer for all untrusted text (LLM output, git logs, paths, escalation titles).
 * Strips terminal escape sequences (CSI/OSC/DCS) and normalizes raw control bytes once at entry.
 */
export function sanitizeText(raw: string): string {
  if (!raw) return "";
  return replaceControlCharacters(stripTerminalSequences(raw.replace(/\r\n?/g, "\n")));
}

/** Single-line sanitized text (collapses newlines/tabs into single spaces). */
export function sanitizeLine(raw: string): string {
  return sanitizeText(raw).replace(/\s+/g, " ").trim();
}

/** Hard-clamps any line (preserving valid ANSI styling) to <= `width` terminal columns. */
export function clamp(line: string, width: number): string {
  const w = Math.max(1, Math.floor(width));
  if (visibleWidth(line) <= w) return line;
  return truncateToWidth(line, w, "…");
}

/** Truncates or right-pads a line to exactly `width` terminal columns. */
export function fit(line: string, width: number): string {
  const w = Math.max(1, Math.floor(width));
  const clamped = clamp(line, w);
  const pad = w - visibleWidth(clamped);
  return pad > 0 ? clamped + " ".repeat(pad) : clamped;
}

/** Left-pads (right-aligns) a line to `width` columns. */
export function padLeft(line: string, width: number): string {
  const w = Math.max(1, Math.floor(width));
  const clamped = clamp(line, w);
  const pad = w - visibleWidth(clamped);
  return pad > 0 ? " ".repeat(pad) + clamped : clamped;
}

/**
 * Wraps an ANSI-styled line with a full-width background surface fill, ensuring exact `width`.
 * Re-applies the background sequence after any full SGR reset (`\x1b[0m`, `\x1b[m`) or background
 * reset (`\x1b[49m`) inside the line so the surface remains solid across styled spans.
 * In NO_COLOR mode (`bgFn("")` is empty), cleanly returns `fit(line, width)`.
 */
export function fillLineBg(line: string, width: number, bgFn: (s: string) => string): string {
  const fitted = fit(line, width);
  const bgPrefix = bgFn("").replace(/\x1b\[49m$/, "");
  if (!bgPrefix) return fitted;
  const painted =
    bgPrefix +
    fitted.replace(/\x1b\[(0|49|)m/g, (match) => `${match}${bgPrefix}`) +
    "\x1b[49m";
  return clamp(painted, width);
}

/** Middle-ellipsis clamp for file paths, branches, and long IDs (preserves prefix & filename). */
export function middleEllipsis(raw: string, maxWidth: number): string {
  const text = sanitizeLine(raw);
  const w = Math.max(1, Math.floor(maxWidth));
  if (visibleWidth(text) <= w) return text;
  if (w <= 3) return sliceByColumn(text, 0, w, true);
  const tailLen = Math.max(1, Math.floor((w - 1) * 0.55));
  const headLen = Math.max(1, w - 1 - tailLen);
  const total = visibleWidth(text);
  const head = sliceByColumn(text, 0, headLen, true);
  const tail = sliceByColumn(text, Math.max(0, total - tailLen), tailLen, true);
  return `${head}…${tail}`;
}

/** ANSI-safe word wrap that guarantees every output line fits strictly within `width` columns. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  if (!text) return [""];
  const out: string[] = [];
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!rawLine) {
      out.push("");
      continue;
    }
    for (const wrapped of wrapTextWithAnsi(rawLine, w)) {
      out.push(clamp(wrapped, w));
    }
  }
  return out.length > 0 ? out : [""];
}

/** Joins left and right aligned strings onto one line of exact width `width`. */
export function splitRow(left: string, right: string, width: number, gap = 1): string {
  const w = Math.max(1, Math.floor(width));
  const rightW = visibleWidth(right);
  if (!right || rightW >= w) return fit(left, w);
  const maxLeft = Math.max(1, w - rightW - Math.max(1, gap));
  const clampedLeft = clamp(left, maxLeft);
  const pad = Math.max(1, w - visibleWidth(clampedLeft) - rightW);
  return clamp(clampedLeft + " ".repeat(pad) + right, w);
}

export { visibleWidth, sliceByColumn, stripTerminalSequences };
