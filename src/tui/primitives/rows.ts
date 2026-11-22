import type { HarnessTheme } from "./theme.js";
import { fitWidth } from "./width.js";

/** Lifecycle state shared by every transcript entry that reports progress (tool calls, runs, events). */
export type RowStatus = "running" | "ok" | "error" | "called";

/** Blank row that separates one transcript block from the previous one. */
export const SPACER = "";

/** One-column status icon: `✓` ok, `✗` error, `·` called (finished without a result), `●` running. */
export function statusGlyph(theme: HarnessTheme, status: RowStatus): string {
  switch (status) {
    case "ok":
      return theme.success("✓");
    case "error":
      return theme.error("✗");
    case "called":
      return theme.muted("·");
    case "running":
      return theme.accent("●");
  }
}

/** Disclosure triangle: `▾` when the entry shows its body, `▸` when collapsed. */
export function disclosureGlyph(theme: HarnessTheme, open: boolean): string {
  return theme.muted(open ? "▾" : "▸");
}

/** Secondary text shown after a title: counts, ids, arguments and results. */
export function secondary(theme: HarnessTheme, text: string): string {
  return theme.muted(text);
}

type RowTitle = { glyph: string; title: string; detail?: string };

export function titleText(theme: HarnessTheme, { glyph, title, detail }: RowTitle): string {
  return `${glyph} ${theme.bold(title)}${detail ? `  ${secondary(theme, detail)}` : ""}`;
}

export function titleRow(theme: HarnessTheme, opts: RowTitle & { indent?: number }, width: number): string {
  return fitWidth(`${" ".repeat(opts.indent ?? 2)}${titleText(theme, opts)}`, width);
}

/** Collapses untrusted multi-line text (control sequences and newlines) into one trimmed line. */
export function flattenText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\s]+/g, " ")
    .trim();
}
