import { Markdown } from "@earendil-works/pi-tui";
import { renderToolOutput, type ToolDisplayPayload } from "../tool-output/index.js";
import { firstLine } from "./format.js";
import { clamp, fillLineBg, sanitizeLine, sanitizeText, splitRow, wrap } from "./text.js";
import type { Theme, Tone } from "./tokens.js";

export type FoldState = "collapsed" | "expanded" | "full";
export type ToolStatus = "running" | "ok" | "error";

export type TranscriptBlock =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; meta?: string }
  | { kind: "thought"; text: string; meta?: string }
  | {
      kind: "tool";
      label: string;
      status: ToolStatus;
      meta?: string;
      args?: string;
      result?: string;
      error?: string;
    }
  | { kind: "tool_output"; display: ToolDisplayPayload }
  | { kind: "tool_note"; text: string }
  | { kind: "receipt"; text: string; glyph?: string; tone?: Tone; tag?: string; hint?: string }
  | { kind: "text"; text: string; format: "markdown" | "code" | "plain"; lang?: string }
  | { kind: "rows"; render: (width: number, theme: Theme) => string[]; copy: string };

export const TOOL_SECTION_CLIP_LINES = 40;

/** Re-indents valid JSON text without parsing values, so large integer tokens stay exact. */
function indentJson(text: string): string {
  let out = "";
  let depth = 0;
  let inString = false;
  const nl = () => "\n" + "  ".repeat(depth);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "{" || c === "[") {
      const close = c === "{" ? "}" : "]";
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] === close) {
        out += c + close;
        i = j;
      } else {
        depth++;
        out += c + nl();
      }
    } else if (c === "}" || c === "]") {
      depth--;
      out += nl() + c;
    } else if (c === ",") {
      out += c + nl();
    } else if (c === ":") {
      out += ": ";
    } else if (!/\s/.test(c)) {
      out += c;
    }
  }
  return out;
}

/** Pretty-prints valid JSON payloads; non-JSON (including truncated previews) stays verbatim. */
function prepareToolSection(raw: string): { lines: string[]; lang: string; text: string } {
  let text = raw;
  let lang = "";
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      text = indentJson(trimmed);
      lang = "json";
    } catch {
      // keep raw
    }
  }
  const clean = sanitizeText(text);
  return { lines: clean.split("\n"), lang, text: clean };
}

/** Returns a backtick fence at least one backtick longer than the longest backtick run in `text`. */
function makeFence(text: string): string {
  let maxRun = 2;
  for (const m of text.matchAll(/`+/g)) {
    if (m[0].length > maxRun) maxRun = m[0].length;
  }
  return "`".repeat(maxRun + 1);
}

function toolSections(block: Extract<TranscriptBlock, { kind: "tool" }>): Array<{ label: string; value: string; isError: boolean }> {
  const out: Array<{ label: string; value: string; isError: boolean }> = [];
  if (block.args !== undefined) out.push({ label: "args", value: block.args, isError: false });
  if (block.result !== undefined) out.push({ label: "result", value: block.result, isError: false });
  if (block.error !== undefined) out.push({ label: "error", value: block.error, isError: true });
  return out;
}

function toolExceedsClip(block: Extract<TranscriptBlock, { kind: "tool" }>): boolean {
  for (const sec of toolSections(block)) {
    if (prepareToolSection(sec.value).lines.length > TOOL_SECTION_CLIP_LINES) return true;
  }
  return false;
}

export function isFoldable(block: TranscriptBlock): boolean {
  return block.kind === "tool" || block.kind === "thought" || block.kind === "assistant";
}

export function defaultFold(block: TranscriptBlock): FoldState {
  return block.kind === "tool" || block.kind === "thought" ? "collapsed" : "expanded";
}

/** Cycles collapsed -> expanded -> full (only when a tool section exceeds the clip) -> collapsed. */
export function nextFold(block: TranscriptBlock, fold: FoldState): FoldState {
  if (!isFoldable(block)) return fold;
  if (fold === "collapsed") return "expanded";
  if (fold === "expanded") {
    return block.kind === "tool" && toolExceedsClip(block) ? "full" : "collapsed";
  }
  return "collapsed";
}

/** Exact clipboard text for a whole block: raw source text without pretty-printing or sanitization. */
export function blockSourceText(block: TranscriptBlock): string {
  switch (block.kind) {
    case "user":
    case "assistant":
    case "thought":
    case "text":
      return block.text;
    case "tool": {
      const meta = block.meta ? `[${block.meta}] ` : "";
      const parts = [`${meta}${block.label} (${block.status})`];
      for (const sec of toolSections(block)) {
        parts.push(`${sec.label}:\n${sec.value}`);
      }
      return parts.join("\n");
    }
    case "tool_output":
      return JSON.stringify(block.display, null, 2);
    case "tool_note":
      return block.text || "tool output";
    case "receipt": {
      const tag = block.tag ? `[${block.tag}] ` : "";
      return `${tag}${block.text}`.trim();
    }
    case "rows":
      return block.copy;
  }
}

/** Rows for one block at `width`. Every row is at most `width` columns and contains only complete SGR sequences. */
export function renderTranscriptBlock(
  block: TranscriptBlock,
  width: number,
  theme: Theme,
  fold?: FoldState,
): string[] {
  const w = Math.max(1, Math.floor(width));
  const g = theme.glyphs;
  const effectiveFold = fold ?? defaultFold(block);

  switch (block.kind) {
    case "user": {
      const clean = sanitizeText(block.text).trim();
      if (!clean) return [];
      const inner = Math.max(4, w - 5);
      const wrapped = wrap(clean, inner);
      const bar = theme.accent(g.rail);
      const out: string[] = [""];
      for (let i = 0; i < wrapped.length; i++) {
        const prefix = i === 0 ? `${bar} ${theme.accentBold(g.prompt)} ` : `${bar}   `;
        out.push(fillLineBg(`${prefix}${theme.bold(wrapped[i]!)}`, w, theme.userBg));
      }
      return out;
    }

    case "assistant": {
      const clean = sanitizeText(block.text).replace(/^\n+|\n+$/g, "");
      if (!clean.trim()) return [];
      const cleanMeta = block.meta ? sanitizeLine(block.meta) : "";
      const mdTheme = theme.toMarkdownTheme();
      const md = new Markdown(clean, 1, 0, mdTheme);
      if (effectiveFold === "collapsed") {
        const totalRows = md.render(w).length;
        const preview = firstLine(clean, 90);
        const metaPart = cleanMeta ? ` ${theme.muted(cleanMeta)}` : "";
        const previewPart = preview ? ` ${theme.muted("—")} ${theme.muted(preview)}` : "";
        const countPart = ` ${theme.dim(`(+${totalRows} rows)`)}`;
        return ["", clamp(` ${theme.accent(g.diamond)}${metaPart}${previewPart}${countPart}`, w)];
      }
      const out: string[] = [""];
      if (cleanMeta) {
        out.push(clamp(` ${theme.accent(g.diamond)} ${theme.muted(cleanMeta)}`, w));
      }
      for (const line of md.render(w)) {
        out.push(clamp(line, w));
      }
      return out;
    }

    case "thought": {
      const clean = sanitizeText(block.text).replace(/^\n+|\n+$/g, "");
      if (!clean.trim()) return [];
      const cleanMeta = block.meta ? sanitizeLine(block.meta) : "";
      const metaPart = cleanMeta ? ` ${g.sep} ${cleanMeta}` : "";
      if (effectiveFold === "collapsed") {
        const nonEmpty = clean
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        const last = sanitizeLine(nonEmpty[nonEmpty.length - 1] ?? "");
        const tail = last ? ` — ${last}` : "";
        return [clamp(theme.dim(`  … thinking${metaPart}${tail}`), w)];
      }
      const header = clamp(theme.dim(theme.italic(`  ${g.foldOpen} thinking${metaPart}`)), w);
      const md = new Markdown(clean, 2, 0, theme.toMarkdownTheme(), { color: theme.dim, italic: true });
      const out = [header];
      for (const line of md.render(w)) {
        out.push(clamp(line, w));
      }
      return out;
    }

    case "tool": {
      const tone: Tone = block.status === "ok" ? "ok" : block.status === "error" ? "danger" : "accent";
      const icon = block.status === "ok" ? g.check : block.status === "error" ? g.cross : g.running;
      const foldGlyph = effectiveFold === "collapsed" ? g.foldClosed : g.foldOpen;
      const cleanLabel = sanitizeLine(block.label);
      const cleanMeta = block.meta ? sanitizeLine(block.meta) : "";
      const right = cleanMeta ? theme.dim(cleanMeta) : "";

      if (effectiveFold === "collapsed") {
        const previewSrc = block.error ?? block.result ?? block.args;
        const preview = previewSrc ? firstLine(previewSrc, 90) : "";
        const previewPart = preview ? theme.muted(` — ${preview}`) : "";
        const left = `  ${theme.paint(tone, `${foldGlyph} ${icon} ${cleanLabel}`)}${previewPart}`;
        return [right ? splitRow(left, right, w) : clamp(left, w)];
      }

      const left = `  ${theme.paint(tone, `${foldGlyph} ${icon} ${cleanLabel}`)}`;
      const out: string[] = [right ? splitRow(left, right, w) : clamp(left, w)];
      const sections = toolSections(block);
      if (sections.length === 0) {
        out.push(clamp(theme.muted("    no args or output reported"), w));
        return out;
      }

      const mdTheme = theme.toMarkdownTheme();
      for (const sec of sections) {
        out.push(clamp(`    ${sec.isError ? theme.danger(sec.label) : theme.muted(sec.label)}`, w));
        const prepared = prepareToolSection(sec.value);
        const clip = effectiveFold === "expanded" && prepared.lines.length > TOOL_SECTION_CLIP_LINES;
        const shownLines = clip ? prepared.lines.slice(0, TOOL_SECTION_CLIP_LINES) : prepared.lines;
        const body = shownLines.join("\n");
        const fence = makeFence(body);
        const md = new Markdown(`${fence}${prepared.lang}\n${body}\n${fence}`, 3, 0, mdTheme);
        for (const line of md.render(w)) {
          out.push(clamp(line, w));
        }
        if (clip) {
          const remaining = prepared.lines.length - TOOL_SECTION_CLIP_LINES;
          out.push(clamp(`    ${theme.dim(`… +${remaining} more lines ${g.sep} Enter shows all`)}`, w));
        }
      }
      return out;
    }

    case "tool_output":
      return ["", ...renderToolOutput(block.display, w, theme).map((l) => clamp(l, w))];

    case "tool_note": {
      const clean = sanitizeLine(block.text) || "tool output";
      return [clamp(`  ${theme.ok(g.check)} ${theme.muted(clean)}`, w)];
    }

    case "receipt": {
      const glyph = block.glyph ?? g.bullet;
      const tone = block.tone ?? "muted";
      const cleanText = sanitizeLine(block.text);
      const tagPart = block.tag ? `${theme.paint(tone, `[${sanitizeLine(block.tag)}]`)} ` : "";
      const hintPart = block.hint ? theme.dim(`  ${sanitizeLine(block.hint)}`) : "";
      const left = `  ${theme.paint(tone, glyph)} ${tagPart}${cleanText}`;
      return [splitRow(left, hintPart, w)];
    }

    case "text": {
      if (block.format === "plain") {
        return wrap(sanitizeText(block.text), w).map((l) => clamp(l, w));
      }
      if (block.format === "code") {
        const clean = sanitizeText(block.text).replace(/\n+$/, "");
        if (!clean.length) return [];
        const lang = block.lang ? sanitizeLine(block.lang) : "";
        const fence = makeFence(clean);
        const md = new Markdown(`${fence}${lang}\n${clean}\n${fence}`, 1, 0, theme.toMarkdownTheme());
        return md.render(w).map((l) => clamp(l, w));
      }
      const clean = sanitizeText(block.text).replace(/^\n+|\n+$/g, "");
      if (!clean.trim()) return [];
      const md = new Markdown(clean, 1, 0, theme.toMarkdownTheme());
      return md.render(w).map((l) => clamp(l, w));
    }

    case "rows":
      return block.render(w, theme).map((l) => clamp(l, w));
  }
}
