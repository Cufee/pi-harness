import { Input, matchesKey } from "@earendil-works/pi-tui";
import { type Hint, renderHintBar } from "./keymap.js";
import { clamp, fillLineBg, fit, sanitizeLine, splitRow, visibleWidth } from "./text.js";
import type { Theme, Tone } from "./tokens.js";
import {
  beginScrollbarCapture,
  endScrollbarCapture,
  type ScrollbarCapture,
  stripScrollbarTags,
} from "./viewport.js";

export interface FrameTab {
  id: string;
  label: string;
  count?: number;
  tone?: Tone;
}

export interface FrameConfirm {
  message: string;
  confirmLabel?: string;
  onConfirm: () => void | Promise<void>;
}

export interface FramePrompt {
  label: string;
  placeholder?: string;
  initialValue?: string;
  /** When true, submitting an empty string invokes `onSubmit("")` (e.g. clearing Quota Endpoint URL). */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void | Promise<void>;
}

/**
 * Unified tab navigation helper shared by every tabbed screen (Work Navigator, Settings, Model Picker, Goal Inspector).
 * Supports Left/Right arrows (`←`/`→`), `Tab` / `Shift+Tab`, and `1`..`9` direct selection.
 * Callers MUST NOT invoke this while a list's `/` filter or an inline prompt/confirm is active!
 */
export function handleTabKeys<T extends string>(
  data: string,
  tabs: readonly T[],
  active: T,
  onSelect: (next: T) => void,
  opts?: { allowTab?: boolean; allowArrows?: boolean; allowNumbers?: boolean },
): boolean {
  if (tabs.length <= 1) return false;
  const allowTab = opts?.allowTab !== false;
  const allowArrows = opts?.allowArrows !== false;
  const allowNumbers = opts?.allowNumbers !== false;

  if (allowNumbers && data.length === 1 && data >= "1" && data <= "9") {
    const idx = Number(data) - 1;
    if (idx < tabs.length) {
      const target = tabs[idx]!;
      if (target !== active) onSelect(target);
      return true;
    }
  }
  if ((allowArrows && matchesKey(data, "right")) || (allowTab && matchesKey(data, "tab"))) {
    const next = tabs[(tabs.indexOf(active) + 1) % tabs.length]!;
    onSelect(next);
    return true;
  }
  if ((allowArrows && matchesKey(data, "left")) || (allowTab && matchesKey(data, "shift+tab"))) {
    const prev = tabs[(tabs.indexOf(active) - 1 + tabs.length) % tabs.length]!;
    onSelect(prev);
    return true;
  }
  return false;
}

/**
 * Single uniform chrome primitive for every sheet, inspector, and picker dialog.
 * - Rounded cyan `borderFocused` frame (`╭─╮│╰─╯`) with opaque `surfaceBg` surface fill
 * - Generous 2-column horizontal inner padding (`paddingX: 2`) and 1-row breathing space above/below body
 * - Distinct styled tab strip (no harsh `\x1b[7m` reverse video; clean NO_COLOR `[tab]` fallback)
 * - Explicit `├───┤` rule above the footer HintBar
 * - Inline confirm / prompt (with optional `allowEmpty`) + status notice
 * - Guarantees every rendered line <= `width` and total rows <= `maxHeight`.
 */
export interface FrameBodyRect {
  row: number;
  col: number;
  width: number;
  height: number;
}

export interface FrameTextRegion {
  col: number;
  width: number;
  rows: number[];
  bodyRows: number[];
  /** Per-line selectable width overrides derived from rendered Viewport/ListView scrollbar geometry. */
  rowWidths?: ReadonlyMap<number, number>;
}

let capturedFrame: Frame | null = null;
let capturingFrame = false;

/** Begins capturing the last `Frame` whose `render()` runs during a synchronous overlay render. */
export function beginFrameCapture(): void {
  capturedFrame = null;
  capturingFrame = true;
}

/** Ends frame capture and returns the captured `Frame`, if any. */
export function endFrameCapture(): Frame | null {
  const frame = capturedFrame;
  capturedFrame = null;
  capturingFrame = false;
  return frame;
}

export class Frame {
  private confirmState: FrameConfirm | null = null;
  private promptState: { spec: FramePrompt; input: Input } | null = null;
  private notice: { text: string; tone: Tone } | null = null;
  /** Overlay-local bounds of the rendered body area from the most recent `render()`. */
  bodyRect: FrameBodyRect | null = null;
  /** Overlay-local selectable text rows (header, subtitle, body, inline/notice) from the most recent `render()`. */
  textRegion: FrameTextRegion | null = null;

  get hasInlineModal(): boolean {
    return this.confirmState !== null || this.promptState !== null;
  }

  askConfirm(spec: FrameConfirm): void {
    this.promptState = null;
    this.confirmState = spec;
  }

  askPrompt(spec: FramePrompt): void {
    this.confirmState = null;
    const input = new Input();
    if (spec.initialValue) {
      input.setValue(spec.initialValue);
      // pi-tui Input.setValue keeps cursor at 0; move cursor to end so Backspace / Ctrl+U work immediately!
      input.handleInput("\x05");
    }
    this.promptState = { spec, input };
  }

  setNotice(text: string, tone: Tone = "info"): void {
    this.notice = text ? { text: sanitizeLine(text), tone } : null;
  }

  clearInline(): void {
    this.confirmState = null;
    this.promptState = null;
  }

  /** Intercepts input when an inline confirm or prompt is open. Returns true if consumed. */
  handleInlineInput(data: string, requestRender: () => void): boolean {
    if (this.confirmState) {
      if (matchesKey(data, "escape") || data === "n" || data === "N") {
        this.confirmState = null;
        requestRender();
        return true;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "y" || data === "Y") {
        const fn = this.confirmState.onConfirm;
        this.confirmState = null;
        requestRender();
        void Promise.resolve(fn()).catch((err) => {
          this.setNotice(err instanceof Error ? err.message : String(err), "danger");
          requestRender();
        });
        return true;
      }
      return true;
    }

    if (this.promptState) {
      if (matchesKey(data, "escape")) {
        this.promptState = null;
        requestRender();
        return true;
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        const val = this.promptState.input.getValue().trim();
        const { onSubmit, allowEmpty } = this.promptState.spec;
        this.promptState = null;
        requestRender();
        if (val || allowEmpty) {
          void Promise.resolve(onSubmit(val)).catch((err) => {
            this.setNotice(err instanceof Error ? err.message : String(err), "danger");
            requestRender();
          });
        }
        return true;
      }
      this.promptState.input.handleInput(data);
      requestRender();
      return true;
    }

    return false;
  }

  /** Computes exact available body height inside this frame given `maxHeight`. */
  bodyHeight(
    maxHeight: number,
    opts?: { hasTabs?: boolean; hasSubtitle?: boolean; padY?: boolean },
  ): number {
    // top(1) + header(1) + [sub(1)] + [tabs(1)] + midRule(1) + [topPad(1)+botPad(1)] + [inline/notice(1)] + footRule(1) + footer(1) + bot(1)
    const maxH = Math.floor(maxHeight);
    let chrome = 6;
    if (opts?.hasSubtitle) chrome += 1;
    if (opts?.hasTabs) chrome += 1;
    const hasInline = Boolean(this.confirmState || this.promptState);
    if (hasInline || this.notice) chrome += 1;
    const usePadY = opts?.padY ?? maxH >= chrome + 5;
    if (usePadY) chrome += 2;
    const natural = maxH - chrome;
    if (!hasInline) {
      return Math.max(2, natural);
    }
    if (natural >= 2) return natural;
    const headerRows = 2 + (opts?.hasSubtitle ? 1 : 0) + (opts?.hasTabs ? 1 : 0);
    const maxBodyToKeepInline = Math.max(0, maxH - headerRows - 2);
    return Math.min(Math.max(1, natural), maxBodyToKeepInline);
  }

  render(opts: {
    width: number;
    maxHeight: number;
    theme: Theme;
    breadcrumbs: string[];
    rightHeader?: string;
    subtitle?: string;
    tabs?: FrameTab[];
    activeTabId?: string;
    hints: Hint[];
    renderBody: (innerWidth: number, bodyHeight: number) => string[];
  }): string[] {
    const w = Math.max(12, Math.floor(opts.width));
    const maxH = Math.max(6, Math.floor(opts.maxHeight));
    const padX = w >= 20 ? 2 : 1;
    const innerW = Math.max(4, w - 2 - padX * 2);
    const padStr = " ".repeat(padX);
    const theme = opts.theme;
    const g = theme.glyphs;

    const bdr = theme.borderFocused;
    const topBorder = fillLineBg(bdr(`${g.boxTL}${g.barH.repeat(Math.max(1, w - 2))}${g.boxTR}`), w, theme.surfaceBg);
    const midBorder = fillLineBg(bdr(`${g.boxML}${g.barH.repeat(Math.max(1, w - 2))}${g.boxMR}`), w, theme.surfaceBg);
    const subtleRule = fillLineBg(
      `${bdr(g.boxML)}${theme.border(g.barH.repeat(Math.max(1, w - 2)))}${bdr(g.boxMR)}`,
      w,
      theme.surfaceBg,
    );
    const botBorder = fillLineBg(bdr(`${g.boxBL}${g.barH.repeat(Math.max(1, w - 2))}${g.boxBR}`), w, theme.surfaceBg);

    const boxRow = (content: string) =>
      fillLineBg(`${bdr(g.barV)}${padStr}${fit(stripScrollbarTags(content), innerW)}${padStr}${bdr(g.barV)}`, w, theme.surfaceBg);

    const crumbText = opts.breadcrumbs
      .map((c, i) => (i === opts.breadcrumbs.length - 1 ? theme.accentBold(c) : theme.muted(c)))
      .join(theme.muted(` ${g.crumb} `));
    const headerLine = splitRow(crumbText, opts.rightHeader ?? "", innerW);

    const out: string[] = [topBorder, boxRow(headerLine)];
    const textRows: number[] = [1];

    const hasSubtitle = Boolean(opts.subtitle);
    const hasTabs = Boolean(opts.tabs && opts.tabs.length > 0);
    const hasInline = Boolean(this.confirmState || this.promptState);

    if (opts.subtitle) {
      textRows.push(out.length);
      out.push(boxRow(theme.muted(sanitizeLine(opts.subtitle))));
    }

    if (opts.tabs && opts.tabs.length > 0) {
      const parts = opts.tabs.map((tab, idx) => {
        const active = tab.id === opts.activeTabId;
        const badge = tab.count != null && tab.count > 0 ? ` (${tab.count})` : "";
        const num = idx < 9 ? `${idx + 1}:` : "";
        const raw = `${num}${tab.label}${badge}`;
        if (active) return theme.tabActive(raw);
        if (tab.count && tab.count > 0 && tab.tone) return theme.paint(tab.tone, raw);
        return theme.muted(raw);
      });
      out.push(boxRow(clamp(parts.join("  "), innerW)));
    }

    const baseChrome = 6 + (hasSubtitle ? 1 : 0) + (hasTabs ? 1 : 0) + (hasInline || this.notice ? 1 : 0);
    const padY = maxH >= baseChrome + 5;
    const availBody = this.bodyHeight(maxH, { hasTabs, hasSubtitle, padY });
    const showMidBorder = !hasInline || availBody > 0;

    if (showMidBorder) out.push(midBorder);
    if (padY) out.push(boxRow(""));

    const bodyRow = out.length;
    const bodyRows: number[] = [];
    const rowWidths = new Map<number, number>();
    let bodyLineCount = 0;
    if (availBody > 0) {
      beginScrollbarCapture();
      let scrollbarCapture: ScrollbarCapture | undefined;
      try {
        let rawBodyLines: string[];
        try {
          rawBodyLines = opts.renderBody(innerW, availBody);
        } finally {
          scrollbarCapture = endScrollbarCapture();
        }
        const bodyLines = rawBodyLines.slice(0, availBody);
        bodyLineCount = bodyLines.length;
        for (const rawLine of bodyLines) {
          const { line, contentWidth } = scrollbarCapture
            ? scrollbarCapture.consume(rawLine)
            : { line: stripScrollbarTags(rawLine), contentWidth: undefined };
          const idx = out.length;
          out.push(boxRow(line));
          textRows.push(idx);
          bodyRows.push(idx);
          if (contentWidth !== undefined) {
            rowWidths.set(idx, Math.max(1, Math.min(innerW, contentWidth)));
          }
        }
        if (bodyLines.length === 0) out.push(boxRow(""));
      } finally {
        scrollbarCapture?.cleanup();
      }
    }

    this.bodyRect = {
      row: bodyRow,
      col: 1 + padX,
      width: innerW,
      height: Math.min(bodyLineCount, Math.max(0, maxH - bodyRow)),
    };

    if (padY) out.push(boxRow(""));

    const showSubtleRule = !hasInline || out.length + 2 < maxH;
    const footerRowIdx = out.length + 1 + (showSubtleRule ? 1 : 0);
    const inlineNotice =
      hasInline && this.notice
        ? clamp(theme.paint(this.notice.tone, this.notice.text), Math.max(1, innerW))
        : "";
    const noticeOnInline = Boolean(inlineNotice) && footerRowIdx >= maxH;

    if (this.confirmState) {
      const label = this.confirmState.confirmLabel ?? "y/Enter confirm · n/Esc cancel";
      const confirmLine = theme.warn(`${g.warn} ${sanitizeLine(this.confirmState.message)}  [${label}]`);
      textRows.push(out.length);
      out.push(boxRow(noticeOnInline ? splitRow(confirmLine, inlineNotice, innerW, 2) : confirmLine));
    } else if (this.promptState) {
      const lbl = theme.accentBold(`${this.promptState.spec.label}: `);
      const placeholder =
        !this.promptState.input.getValue() && this.promptState.spec.placeholder
          ? ` ${theme.dim(this.promptState.spec.placeholder)}`
          : "";
      const noticeReserve = noticeOnInline ? visibleWidth(inlineNotice) + 2 : 0;
      const promptBudget = Math.max(4, innerW - noticeReserve);
      const reserve = visibleWidth(lbl) + visibleWidth(placeholder);
      const inpW = Math.max(4, promptBudget - reserve);
      const rendered = (this.promptState.input.render(inpW)[0] ?? "").replace(/^>\s?/, "").trimEnd();
      const promptLine = clamp(`${lbl}${rendered}${placeholder}`, promptBudget);
      textRows.push(out.length);
      out.push(boxRow(noticeOnInline ? splitRow(promptLine, inlineNotice, innerW, 2) : promptLine));
    } else if (this.notice) {
      textRows.push(out.length);
      out.push(boxRow(theme.paint(this.notice.tone, this.notice.text)));
    }

    if (showSubtleRule) out.push(subtleRule);

    const footerHints = this.confirmState
      ? [
          { key: "y/Enter", label: "confirm" },
          { key: "n/Esc", label: "cancel" },
        ]
      : this.promptState
        ? [
            { key: "Enter", label: "submit" },
            { key: "Esc", label: "cancel" },
          ]
        : opts.hints;

    if (inlineNotice && !noticeOnInline) {
      const hintsW = innerW - visibleWidth(inlineNotice) - 2;
      const footerLine =
        hintsW >= 4
          ? splitRow(renderHintBar(footerHints, hintsW, theme), inlineNotice, innerW, 2)
          : inlineNotice;
      out.push(boxRow(footerLine));
    } else {
      out.push(boxRow(renderHintBar(footerHints, innerW, theme)));
    }
    out.push(botBorder);
    const rendered = out.slice(0, maxH);
    const visibleRowWidths = new Map<number, number>();
    for (const [lineIdx, wOverride] of rowWidths) {
      if (lineIdx < rendered.length) visibleRowWidths.set(lineIdx, wOverride);
    }
    this.textRegion = {
      col: 1 + padX,
      width: innerW,
      rows: textRows.filter((r) => r < rendered.length),
      bodyRows: bodyRows.filter((r) => r < rendered.length),
      ...(visibleRowWidths.size > 0 ? { rowWidths: visibleRowWidths } : {}),
    };
    if (capturingFrame) {
      capturedFrame = this;
    }
    return rendered;
  }
}
