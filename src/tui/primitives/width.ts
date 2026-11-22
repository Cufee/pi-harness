import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function sanitizeSingleLine(s: string): string {
  return s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1 || s.indexOf("\t") !== -1
    ? s.replace(/[\r\n\t]+/g, " ")
    : s;
}

/**
 * Guarantees a rendered line NEVER exceeds `width` visible columns and NEVER contains raw newlines
 * that could tear a `Panel` / `Table` / `StatusBar` border.
 * Makes `TuiMainScreen`'s hard width-overflow crash mathematically impossible.
 */
export function clampLine(line: string, width: number): string {
  if (width <= 0) return "";
  const clean = sanitizeSingleLine(line);
  if (visibleWidth(clean) <= width) return clean;
  return sliceByColumn(clean, 0, width, true);
}

/**
 * Truncates (with ellipsis) and pads an ANSI-styled string to EXACTLY `width` visible columns.
 * Never uses UTF-16 `.length` or `.padEnd()`.
 */
export function fitWidth(
  text: string,
  width: number,
  opts?: { align?: "left" | "right" | "center"; ellipsis?: string },
): string {
  if (width <= 0) return "";
  const clean = sanitizeSingleLine(text);
  const align = opts?.align ?? "left";
  const ellipsis = opts?.ellipsis ?? "…";
  const w = visibleWidth(clean);

  if (w > width) {
    return clampLine(truncateToWidth(clean, width, ellipsis, true), width);
  }
  const pad = width - w;
  if (pad === 0) return clean;
  if (align === "right") return " ".repeat(pad) + clean;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    return " ".repeat(left) + clean + " ".repeat(pad - left);
  }
  return clean + " ".repeat(pad);
}

/** Wraps an ANSI-styled line with a full-width background fill, ensuring exact `width`. */
export function fillLineBg(line: string, width: number, bgFn: (s: string) => string): string {
  const fitted = fitWidth(line, width);
  // Re-apply bg after any SGR reset `\x1b[0m` inside the line so background stays solid across styled spans
  const bgPrefix = bgFn("").replace(/\x1b\[49m$/, "");
  if (!bgPrefix) return fitted;
  const painted = bgPrefix + fitted.replace(/\x1b\[0m/g, `\x1b[0m${bgPrefix}`) + "\x1b[0m";
  return clampLine(painted, width);
}
