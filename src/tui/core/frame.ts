import { Input, matchesKey } from "@earendil-works/pi-tui";
import { type Hint, renderHintBar } from "./keymap.js";
import { clamp, fit, sanitizeLine, splitRow, visibleWidth } from "./text.js";
import type { Theme, Tone } from "./tokens.js";

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
  onSubmit: (value: string) => void | Promise<void>;
}

/**
 * Single uniform chrome primitive for every sheet, inspector, and picker dialog.
 * Provides breadcrumbs, optional tab bar, bounded body height, inline confirm/prompt footer,
 * status toast, and a 1-line HintBar. Guarantees every rendered line <= `width` and total rows <= `maxHeight`.
 */
export class Frame {
  private confirmState: FrameConfirm | null = null;
  private promptState: { spec: FramePrompt; input: Input } | null = null;
  private notice: { text: string; tone: Tone } | null = null;

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
    if (spec.initialValue) input.setValue(spec.initialValue);
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
        const fn = this.promptState.spec.onSubmit;
        this.promptState = null;
        requestRender();
        if (val) {
          void Promise.resolve(fn(val)).catch((err) => {
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
  bodyHeight(maxHeight: number, opts?: { hasTabs?: boolean; hasSubtitle?: boolean }): number {
    // top border (1) + header (1) + optional subtitle (1) + optional tabs (1) + sep (1) + footer (1) + bottom border (1)
    let chrome = 5;
    if (opts?.hasSubtitle) chrome += 1;
    if (opts?.hasTabs) chrome += 1;
    if (this.confirmState || this.promptState || this.notice) chrome += 1;
    return Math.max(3, Math.floor(maxHeight) - chrome);
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
    const innerW = Math.max(4, w - 4);
    const theme = opts.theme;
    const g = theme.glyphs;

    const topBorder = theme.border(`┌${g.barH.repeat(Math.max(1, w - 2))}┐`);
    const midBorder = theme.border(`├${g.barH.repeat(Math.max(1, w - 2))}┤`);
    const botBorder = theme.border(`└${g.barH.repeat(Math.max(1, w - 2))}┘`);
    const boxRow = (content: string) => `${theme.border(g.barV)} ${fit(content, innerW)} ${theme.border(g.barV)}`;

    const crumbText = opts.breadcrumbs
      .map((c, i) => (i === opts.breadcrumbs.length - 1 ? theme.accentBold(c) : theme.muted(c)))
      .join(theme.muted(` ${g.crumb} `));
    const headerLine = splitRow(crumbText, opts.rightHeader ?? "", innerW);

    const out: string[] = [topBorder, boxRow(headerLine)];

    if (opts.subtitle) {
      out.push(boxRow(theme.muted(sanitizeLine(opts.subtitle))));
    }

    if (opts.tabs && opts.tabs.length > 0) {
      const parts = opts.tabs.map((tab, idx) => {
        const active = tab.id === opts.activeTabId;
        const badge = tab.count != null && tab.count > 0 ? ` (${tab.count})` : "";
        const num = idx < 9 ? `${idx + 1}:` : "";
        const raw = `${num}${tab.label}${badge}`;
        if (active) return theme.selectedBg(` ${raw} `);
        if (tab.count && tab.count > 0 && tab.tone) return theme.paint(tab.tone, raw);
        return theme.muted(raw);
      });
      out.push(boxRow(clamp(parts.join("  "), innerW)));
    }

    out.push(midBorder);

    const availBody = this.bodyHeight(opts.maxHeight, {
      hasTabs: Boolean(opts.tabs && opts.tabs.length > 0),
      hasSubtitle: Boolean(opts.subtitle),
    });
    const bodyLines = opts.renderBody(innerW, availBody).slice(0, availBody);
    for (const line of bodyLines) {
      out.push(boxRow(line));
    }
    // Keep stable height at least 1 line
    if (bodyLines.length === 0) out.push(boxRow(""));

    if (this.confirmState) {
      const label = this.confirmState.confirmLabel ?? "y/Enter confirm · n/Esc cancel";
      out.push(boxRow(theme.warn(`${g.warn} ${sanitizeLine(this.confirmState.message)}  [${label}]`)));
    } else if (this.promptState) {
      const lbl = theme.accentBold(`${this.promptState.spec.label}: `);
      const inpW = Math.max(4, innerW - visibleWidth(lbl) - 1);
      const rendered = this.promptState.input.render(inpW)[0] ?? "";
      out.push(boxRow(clamp(`${lbl}${rendered}`, innerW)));
    } else if (this.notice) {
      out.push(boxRow(theme.paint(this.notice.tone, this.notice.text)));
    }

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

    out.push(boxRow(renderHintBar(footerHints, innerW, theme)));
    out.push(botBorder);
    return out.slice(0, Math.max(4, opts.maxHeight));
  }
}
