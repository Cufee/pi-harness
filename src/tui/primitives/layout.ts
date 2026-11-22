import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "./theme.js";
import { clampLine, fillLineBg, fitWidth } from "./width.js";

export type SemanticTone = "neutral" | "accent" | "success" | "warning" | "error" | "info";

export function badge(label: string, tone: SemanticTone, theme: HarnessTheme): string {
  const paint =
    tone === "accent"
      ? theme.accentBold
      : tone === "success"
        ? theme.success
        : tone === "warning"
          ? theme.warning
          : tone === "error"
            ? theme.error
            : tone === "info"
              ? theme.info
              : theme.muted;
  return `${paint(label)}\x1b[0m`;
}

export function statusDot(tone: SemanticTone, theme: HarnessTheme): string {
  return badge("●", tone, theme);
}

export function keyHint(key: string, desc: string, theme: HarnessTheme): string {
  return `${theme.muted(key)} ${theme.dim(desc)}`;
}

export function renderProgressBar(
  remainingRatio: number | null | undefined,
  theme: HarnessTheme,
  opts?: { barWidth?: number; showPercent?: boolean },
): string {
  const barWidth = opts?.barWidth ?? 10;
  const showPercent = opts?.showPercent !== false;
  if (remainingRatio == null || !Number.isFinite(remainingRatio)) {
    return theme.dim("░".repeat(barWidth)) + (showPercent ? theme.dim(" --%") : "");
  }
  const clamped = Math.max(0, Math.min(1, remainingRatio));
  const filled = Math.round(clamped * barWidth);
  const paint = clamped <= 0.1 ? theme.error : clamped <= 0.25 ? theme.warning : theme.success;
  const bar = paint("█".repeat(filled)) + theme.dim("░".repeat(barWidth - filled));
  const pct = showPercent ? ` ${String(Math.round(clamped * 100)).padStart(3)}%` : "";
  return `${bar}${pct}\x1b[0m`;
}

/** Renders a single strict 1-line left/right flex row that NEVER wraps or overflows `width`. */
export function renderFlexRow(
  left: string,
  right: string,
  width: number,
  opts?: { minGap?: number; priority?: "left" | "right"; bgFn?: (s: string) => string },
): string {
  if (width <= 0) return "";
  const minGap = opts?.minGap ?? 2;
  const priority = opts?.priority ?? "left";
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);

  let line: string;
  if (!right) {
    line = fitWidth(left, width);
  } else if (lw + minGap + rw <= width) {
    line = left + " ".repeat(width - lw - rw) + right;
  } else if (priority === "left") {
    const keepLeft = Math.min(lw, width);
    const remRight = width - keepLeft - minGap;
    if (remRight >= 6) {
      line = fitWidth(left, keepLeft) + " ".repeat(minGap) + fitWidth(right, remRight, { align: "right" });
    } else {
      line = fitWidth(left, width);
    }
  } else {
    const keepRight = Math.min(rw, width);
    const remLeft = width - keepRight - minGap;
    if (remLeft >= 6) {
      line = fitWidth(left, remLeft) + " ".repeat(minGap) + fitWidth(right, keepRight, { align: "right" });
    } else {
      line = fitWidth(right, width, { align: "right" });
    }
  }

  return opts?.bgFn ? fillLineBg(line, width, opts.bgFn) : clampLine(line, width);
}

/** 1-line horizontal divider (`─`) with optional embedded title. */
export class Rule implements Component {
  constructor(
    private readonly theme: HarnessTheme,
    private title = "",
  ) {}

  setTitle(title: string): void {
    this.title = title;
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (width <= 0) return [""];
    if (!this.title) {
      return [this.theme.border("─".repeat(width))];
    }
    const label = ` ${this.title} `;
    const lw = visibleWidth(label);
    if (lw + 4 >= width) {
      return [fitWidth(this.theme.muted(this.title), width)];
    }
    const rightLen = Math.max(0, width - 2 - lw);
    return [clampLine(this.theme.border("──") + this.theme.muted(label) + this.theme.border("─".repeat(rightLen)), width)];
  }
}

export interface TableColumn<T> {
  header: string;
  width?: number | "flex";
  minWidth?: number;
  align?: "left" | "right";
  priority?: number; // lower = kept longer on narrow viewports
  render: (row: T) => string;
}

/** Responsive ANSI-safe table renderer that drops low-priority columns cleanly on narrow widths. */
export function renderTable<T>(rows: T[], columns: TableColumn<T>[], width: number, theme: HarnessTheme): string[] {
  if (width <= 0) return [];
  const gap = 2;

  // Select columns that fit by priority
  let active = [...columns];
  const minRequired = (cols: TableColumn<T>[]) =>
    cols.reduce((acc, c) => acc + (typeof c.width === "number" ? c.width : (c.minWidth ?? 8)), 0) +
    Math.max(0, cols.length - 1) * gap;

  while (active.length > 1 && minRequired(active) > width) {
    let dropIdx = active.length - 1;
    let maxPrio = -Infinity;
    for (let i = 0; i < active.length; i++) {
      const p = active[i]!.priority ?? i;
      if (p >= maxPrio) {
        maxPrio = p;
        dropIdx = i;
      }
    }
    active.splice(dropIdx, 1);
  }

  // Allocate exact column widths
  const fixedTotal =
    active.reduce((acc, c) => acc + (typeof c.width === "number" ? c.width : 0), 0) +
    Math.max(0, active.length - 1) * gap;
  const flexCols = active.filter((c) => c.width === "flex" || c.width === undefined);
  const flexAvail = Math.max(0, width - fixedTotal);
  const perFlex = flexCols.length > 0 ? Math.max(4, Math.floor(flexAvail / flexCols.length)) : 0;

  const widths = active.map((c) => (typeof c.width === "number" ? c.width : perFlex));
  const sep = " ".repeat(gap);

  const headerLine = active
    .map((c, i) => fitWidth(theme.dim(c.header), widths[i]!, { align: c.align }))
    .join(sep);

  const out: string[] = [clampLine(headerLine, width), theme.border("─".repeat(width))];
  for (const row of rows) {
    const line = active
      .map((c, i) => fitWidth(c.render(row), widths[i]!, { align: c.align }))
      .join(sep);
    out.push(clampLine(line, width));
  }
  return out;
}
