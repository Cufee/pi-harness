import { clamp, fit } from "./text.js";
import type { Theme } from "./tokens.js";

export const ENABLE_MOUSE_WHEEL_SEQ = "\x1b[?1000h\x1b[?1006h";
export const DISABLE_MOUSE_WHEEL_SEQ = "\x1b[?1000l\x1b[?1006l";

const SGR_MOUSE_RX = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Extracts net wheel delta (negative = up, positive = down) from SGR mouse sequences. */
export function parseMouseWheel(data: string): { delta: number; hadMouse: boolean } {
  let delta = 0;
  let hadMouse = false;
  SGR_MOUSE_RX.lastIndex = 0;
  for (const m of data.matchAll(SGR_MOUSE_RX)) {
    hadMouse = true;
    const btn = Number(m[1]);
    if (btn === 64) delta -= 3;
    else if (btn === 65) delta += 3;
  }
  return { delta, hadMouse };
}

/**
 * Reusable scrollable viewport state for overlays, inspectors, lists, and transcripts.
 * Works natively on `TuiMainScreen` (no alt-screen required), supports follow mode,
 * keep-selected-visible, PgUp/PgDn, mouse wheel, and renders a 1-column scrollbar gutter.
 */
export class Viewport {
  offset = 0;
  follow = false;
  lastHeight = 10;
  lastTotal = 0;

  constructor(opts?: { follow?: boolean }) {
    this.follow = Boolean(opts?.follow);
  }

  private maxOffset(total = this.lastTotal, height = this.lastHeight): number {
    return Math.max(0, total - Math.max(1, height));
  }

  clampOffset(total = this.lastTotal, height = this.lastHeight): void {
    const max = this.maxOffset(total, height);
    if (this.follow) {
      this.offset = max;
    } else {
      this.offset = Math.max(0, Math.min(this.offset, max));
    }
  }

  scrollBy(delta: number): void {
    if (delta === 0) return;
    if (delta < 0) this.follow = false;
    this.offset = Math.max(0, Math.min(this.offset + delta, this.maxOffset()));
    if (this.offset >= this.maxOffset() && delta > 0) {
      // Re-stick at bottom if caller originally wanted follow
    }
  }

  pageUp(): void {
    this.follow = false;
    this.scrollBy(-Math.max(1, this.lastHeight - 2));
  }

  pageDown(): void {
    this.scrollBy(Math.max(1, this.lastHeight - 2));
  }

  scrollToTop(): void {
    this.follow = false;
    this.offset = 0;
  }

  scrollToBottom(enableFollow = false): void {
    this.offset = this.maxOffset();
    if (enableFollow) this.follow = true;
  }

  ensureVisible(lineIndex: number, height = this.lastHeight): void {
    const h = Math.max(1, height);
    if (lineIndex < this.offset) {
      this.offset = Math.max(0, lineIndex);
      this.follow = false;
    } else if (lineIndex >= this.offset + h) {
      this.offset = Math.max(0, lineIndex - h + 1);
    }
  }

  render(lines: string[], width: number, height: number, theme: Theme): string[] {
    const w = Math.max(1, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    this.lastHeight = h;
    this.lastTotal = lines.length;
    this.clampOffset(lines.length, h);

    const needsScrollbar = lines.length > h && w >= 6;
    const bodyWidth = needsScrollbar ? w - 2 : w;
    const slice = lines.slice(this.offset, this.offset + h);

    if (!needsScrollbar) {
      return slice.map((l) => clamp(l, w));
    }

    const maxOff = Math.max(1, lines.length - h);
    const thumbSize = Math.max(1, Math.round((h / lines.length) * h));
    const thumbTop = Math.min(h - thumbSize, Math.round((this.offset / maxOff) * (h - thumbSize)));

    const out: string[] = [];
    for (let i = 0; i < h; i++) {
      const content = fit(slice[i] ?? "", bodyWidth);
      const isThumb = i >= thumbTop && i < thumbTop + thumbSize;
      const bar = isThumb ? theme.accent(theme.glyphs.scrollThumb) : theme.muted(theme.glyphs.scrollTrack);
      out.push(`${content} ${bar}`);
    }
    return out;
  }

  /** Concise position indicator (`1-20/84` or `all` when everything fits). */
  statusText(): string {
    if (this.lastTotal <= this.lastHeight) return "";
    const from = this.offset + 1;
    const to = Math.min(this.lastTotal, this.offset + this.lastHeight);
    return `${from}-${to}/${this.lastTotal}`;
  }
}
