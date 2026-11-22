import { clamp, fit, padLeft, visibleWidth } from "./text.js";
import { statusGlyph, statusTone, type Theme, type Tone } from "./tokens.js";

/** Compact status pill (`✓ achieved`, `! blocked`, `● running`). */
export function statusBadge(status: string, theme: Theme, label?: string): string {
  const tone = statusTone(status);
  const glyph = statusGlyph(status, theme.glyphs);
  return theme.paint(tone, `${glyph} ${label ?? status}`);
}

/** Compact bracketed tag (`[P0]`, `[v3]`, `[T2]`). */
export function tag(text: string, tone: Tone, theme: Theme): string {
  return theme.paint(tone, `[${text}]`);
}

/** Horizontal rule spanning `width` columns with optional left title. */
export function divider(width: number, theme: Theme, title?: string): string {
  const w = Math.max(1, Math.floor(width));
  const h = theme.glyphs.barH;
  if (!title) return theme.border(h.repeat(w));
  const head = `${theme.border(h + h)} ${theme.accentBold(title)} `;
  const rem = Math.max(0, w - visibleWidth(head));
  return clamp(head + theme.border(h.repeat(rem)), w);
}

/** Single key-value detail row with aligned label column. */
export function kvRow(label: string, value: string, width: number, theme: Theme, labelWidth = 14): string {
  const w = Math.max(1, Math.floor(width));
  const lw = Math.min(labelWidth, Math.max(6, Math.floor(w * 0.35)));
  const k = fit(theme.muted(label), lw);
  const v = clamp(value, Math.max(1, w - lw - 1));
  return clamp(`${k} ${v}`, w);
}

export interface ColumnSpec {
  key: string;
  header?: string;
  /** Fixed column width, or omit to take remaining flex space. */
  width?: number;
  minWidth?: number;
  align?: "left" | "right";
  /** Lower priority number stays visible longer on narrow terminals (0 = always kept). */
  priority?: number;
}

/**
 * Priority-aware column layout that cleanly drops low-priority columns on narrow terminals
 * and guarantees exact visual width safety (20..200+ cols).
 */
export function layoutColumns(
  specs: ColumnSpec[],
  rows: Array<Record<string, string>>,
  width: number,
  opts?: { gap?: number; headerStyle?: (s: string) => string; sepStyle?: (s: string) => string },
): string[] {
  const w = Math.max(1, Math.floor(width));
  const gap = opts?.gap ?? 2;

  // Drop highest-priority-number optional columns until minimum widths fit cleanly
  let active = [...specs];
  const minNeeded = (cols: ColumnSpec[]) =>
    cols.reduce((sum, c) => sum + (c.width ?? c.minWidth ?? 8), 0) + Math.max(0, cols.length - 1) * gap;
  while (active.length > 1 && minNeeded(active) > w) {
    let dropIdx = -1;
    let maxPrio = -1;
    for (let i = 0; i < active.length; i++) {
      const p = active[i]!.priority ?? 1;
      if (p > 0 && p >= maxPrio) {
        maxPrio = p;
        dropIdx = i;
      }
    }
    if (dropIdx < 0) break;
    active.splice(dropIdx, 1);
  }

  const fixedSum = active.reduce((s, c) => s + (c.width ?? 0), 0);
  const flexCols = active.filter((c) => c.width == null);
  const avail = Math.max(0, w - fixedSum - Math.max(0, active.length - 1) * gap);
  const widths = new Map<string, number>();
  let rem = avail;
  for (let i = 0; i < flexCols.length; i++) {
    const col = flexCols[i]!;
    const share = i === flexCols.length - 1 ? Math.max(1, rem) : Math.max(col.minWidth ?? 6, Math.floor(avail / flexCols.length));
    widths.set(col.key, share);
    rem -= share;
  }
  for (const col of active) {
    if (col.width != null) widths.set(col.key, col.width);
  }

  const formatRow = (cells: Record<string, string>, style?: (s: string) => string) => {
    const parts = active.map((col) => {
      const cw = Math.max(1, widths.get(col.key) ?? 8);
      const val = cells[col.key] ?? "";
      const rendered = col.align === "right" ? padLeft(val, cw) : fit(val, cw);
      return style ? style(rendered) : rendered;
    });
    return clamp(parts.join(" ".repeat(gap)), w);
  };

  const out: string[] = [];
  if (active.some((c) => c.header)) {
    const headerRow: Record<string, string> = {};
    for (const c of active) headerRow[c.key] = c.header ?? "";
    out.push(formatRow(headerRow, opts?.headerStyle));
    const rule = "─".repeat(w);
    out.push(opts?.sepStyle ? opts.sepStyle(rule) : rule);
  }
  for (const row of rows) {
    out.push(formatRow(row));
  }
  return out;
}
