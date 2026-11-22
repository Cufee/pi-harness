import type { Component, Focusable, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "./theme.js";
import { renderFlexRow } from "./layout.js";
import { clampLine, fillLineBg, fitWidth } from "./width.js";

export interface PanelOptions {
  title: string;
  subtitle?: string;
  footer?: string;
  paddingX?: number;
  rounded?: boolean;
  opaque?: boolean;
  focused?: boolean;
}

/**
 * Exact-width, ANSI-safe framed box component (`╭─╮│╰─╯`).
 * Guaranteed to never overflow `width`, never break alignment on ANSI escapes or emojis,
 * and paints an opaque surface fill so overlay panels never bleed underlying chat text.
 */
export class Panel implements Component, Focusable {
  private child: Component;
  private _focused = false;

  constructor(
    private readonly theme: HarnessTheme,
    private opts: PanelOptions,
    child: Component,
  ) {
    this.child = child;
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(val: boolean) {
    this._focused = val;
    if ("focused" in this.child) {
      (this.child as Component & Focusable).focused = val;
    }
  }

  setOptions(patch: Partial<PanelOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  handleInput(data: string): void {
    this.child.handleInput?.(data);
  }

  handleMouse(ev: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.child.handleMouse?.(ev);
  }

  invalidate(): void {
    this.child.invalidate();
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [""];
    const borderPaint = this.opts.focused !== false ? this.theme.borderFocused : this.theme.border;
    const bgFn = this.opts.opaque !== false ? this.theme.surfaceBg : undefined;

    // Graceful narrow-terminal fallback (never throws on width < 12)
    if (width < 12) {
      const innerLines = this.child.render(width);
      return [fitWidth(this.theme.bold(this.opts.title), width), ...innerLines.map((l) => clampLine(l, width))];
    }

    const padX = Math.min(this.opts.paddingX ?? 1, Math.floor((width - 6) / 2));
    const inner = Math.max(1, width - 2 - padX * 2);
    const padStr = " ".repeat(padX);

    const tl = this.opts.rounded !== false ? "╭" : "┌";
    const tr = this.opts.rounded !== false ? "╮" : "┐";
    const bl = this.opts.rounded !== false ? "╰" : "└";
    const br = this.opts.rounded !== false ? "╯" : "┘";

    const paintRow = (content: string) => {
      const raw = `${borderPaint("│")}${padStr}${fitWidth(content, inner)}${padStr}${borderPaint("│")}`;
      return bgFn ? fillLineBg(raw, width, bgFn) : clampLine(raw, width);
    };

    const hr = (left: string, right: string) => {
      const raw = borderPaint(`${left}${"─".repeat(width - 2)}${right}`);
      return bgFn ? fillLineBg(raw, width, bgFn) : clampLine(raw, width);
    };

    const lines: string[] = [];
    lines.push(hr(tl, tr));

    const headerContent = renderFlexRow(
      this.theme.accentBold(this.opts.title),
      this.opts.subtitle ? this.theme.muted(this.opts.subtitle) : "",
      inner,
      { minGap: 2, priority: "left" },
    );
    lines.push(paintRow(headerContent));
    lines.push(hr("├", "┤"));

    const bodyLines = this.child.render(inner);
    for (const row of bodyLines) {
      lines.push(paintRow(row));
    }

    if (this.opts.footer) {
      lines.push(hr("├", "┤"));
      lines.push(paintRow(this.theme.dim(this.opts.footer)));
    }

    lines.push(hr(bl, br));
    return lines;
  }
}
