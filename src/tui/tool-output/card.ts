import type { Component } from "@earendil-works/pi-tui";
import type { HarnessTheme } from "../primitives/theme.js";
import { clampLine } from "../primitives/width.js";
import { renderToolOutput } from "./registry.js";
import { sanitizeText, type ToolDisplayPayload } from "./types.js";

/**
 * Immutable transcript card for a structured tool display. Re-lays out on every new width
 * (memoized per width, like `AssistantCard`), so tables reflow when the terminal is resized.
 */
export class ToolOutputCard implements Component {
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    readonly display: ToolDisplayPayload,
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = ["", ...renderToolOutput(this.display, width, this.theme)];
    return this.cachedLines;
  }
}

/** Compact dim 1-line note for a persisted tool_output turn whose display is missing or invalid. */
export class ToolOutputNote implements Component {
  private readonly text: string;

  constructor(
    private readonly theme: HarnessTheme,
    text: string,
  ) {
    this.text = sanitizeText(text) || "tool output";
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    return [clampLine(`  ${this.theme.success("✓")} ${this.theme.dim(this.text)}`, width)];
  }
}
