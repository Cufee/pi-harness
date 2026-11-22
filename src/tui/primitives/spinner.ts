import type { Component, TUI } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "./theme.js";
import { fitWidth } from "./width.js";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Compact 1-line animated braille spinner with live elapsed seconds (`⠋ Thinking… 2.4s · Esc to cancel`).
 * Strictly 1 line (no extra blank rows) and always stopped cleanly during teardown.
 */
export class TimedSpinner implements Component {
  private active = false;
  private label = "";
  private hint = "Esc to cancel";
  private startedAt = 0;
  private frameIdx = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly tui: TUI,
    private readonly theme: HarnessTheme,
  ) {}

  get isActive(): boolean {
    return this.active;
  }

  start(label: string, hint = "Esc to cancel"): void {
    this.label = label;
    this.hint = hint;
    this.startedAt = Date.now();
    this.frameIdx = 0;
    this.active = true;
    this.clearTimer();
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length;
      this.tui.requestRender();
    }, 80);
    this.timer.unref?.();
    this.tui.requestRender();
  }

  setLabel(label: string): void {
    this.label = label;
    if (this.active) this.tui.requestRender();
  }

  stop(): void {
    this.active = false;
    this.clearTimer();
    this.tui.requestRender();
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (!this.active || width <= 0) return [];
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const frame = FRAMES[this.frameIdx]!;
    const line = ` ${this.theme.accent(frame)} ${this.theme.text(this.label)} ${this.theme.dim(`${elapsed}s`)} ${this.theme.dim("·")} ${this.theme.muted(this.hint)}`;
    return [fitWidth(line, width)];
  }
}
