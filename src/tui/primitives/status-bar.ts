import type { Component } from "@earendil-works/pi-tui";
import type { GoalRecord } from "../../goals/engine.js";
import { sanitizeText, statusPaint } from "../tool-output/types.js";
import { badge, keyHint, renderFlexRow, statusDot, type SemanticTone } from "./layout.js";
import type { HarnessTheme } from "./theme.js";
import { fitWidth } from "./width.js";

/** Workspace goals remain next to the composer as the transcript scrolls. */
export class GoalHeader implements Component {
  private goals: GoalRecord[] = [];

  constructor(private readonly theme: HarnessTheme) {}

  update(goals: GoalRecord[]): void {
    const active = (g: GoalRecord) => ["executing", "reviewing", "verifying"].includes(g.status);
    this.goals = [...goals].sort((a, b) =>
      Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    );
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    return this.goals.slice(0, 2).map((goal, index) => {
      const overflow = index === 1 && this.goals.length > 2 ? `  +${this.goals.length - 2} more` : "";
      const status = goal.status.replaceAll("_", " ");
      const titleWidth = Math.max(0, width - status.length - overflow.length - 4);
      const title = fitWidth(sanitizeText(goal.title || goal.description), titleWidth);
      return fitWidth(` ${statusPaint(goal.status, this.theme)(status)} · ${title}${this.theme.dim(overflow)}`, width);
    });
  }
}

export interface StatusBarState {
  tone: SemanticTone;
  modeLabel: string;
  modelLabel: string;
  effortLabel?: string | null;
  goalsSummary: string;
  alertText?: string | null;
  rightHints?: Array<[string, string]>;
}

/**
 * Strict 1-line responsive flex status bar.
 * Progressively sheds secondary hints on narrow widths — NEVER wraps onto 2 ragged lines.
 */
export class StatusBar implements Component {
  private state: StatusBarState;
  private version = 0;
  private cachedVersion = -1;
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    initial: StatusBarState,
  ) {
    this.state = initial;
  }

  update(patch: Partial<StatusBarState>): void {
    this.state = { ...this.state, ...patch };
    this.version++;
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [""];
    if (this.cachedWidth === width && this.cachedVersion === this.version) {
      return this.cachedLines;
    }
    const s = this.state;
    const dot = statusDot(s.tone, this.theme);
    const modelStr = s.effortLabel
      ? `${this.theme.bold(s.modelLabel)}${this.theme.dim(`·${s.effortLabel}`)}`
      : this.theme.bold(s.modelLabel);

    const leftParts = [` ${dot} ${this.theme.muted(s.modeLabel)}`, modelStr];
    if (width >= 68 && s.goalsSummary) leftParts.push(this.theme.muted(s.goalsSummary));
    if (s.alertText) leftParts.push(badge(s.alertText, "error", this.theme));
    const left = leftParts.join(this.theme.dim(" │ "));

    const hints = s.rightHints ?? [
      ["Ctrl+O", "cmd"],
      ["Ctrl+,", "settings"],
      ["Ctrl+C", "exit"],
    ];
    let right = "";
    if (width >= 105) {
      right = hints.map(([k, d]) => keyHint(k, d, this.theme)).join(this.theme.dim(" · ")) + " ";
    } else if (width >= 76) {
      right = hints.slice(0, 2).map(([k, d]) => keyHint(k, d, this.theme)).join(this.theme.dim(" · ")) + " ";
    }

    this.cachedWidth = width;
    this.cachedVersion = this.version;
    this.cachedLines = [renderFlexRow(left, right, width, { minGap: 2, priority: "left", bgFn: this.theme.statusBg })];
    return this.cachedLines;
  }
}

/** Transient 0-or-1-line footer hint (e.g., "Press Ctrl+C again to exit"). */
export class FooterHint implements Component {
  private text = "";
  private tone: SemanticTone = "neutral";

  constructor(private readonly theme: HarnessTheme) {}

  set(text: string, tone: SemanticTone = "warning"): void {
    this.text = text;
    this.tone = tone;
  }

  clear(): void {
    this.text = "";
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (!this.text || width <= 0) return [];
    const paint =
      this.tone === "warning"
        ? this.theme.warning
        : this.tone === "error"
          ? this.theme.error
          : this.tone === "success"
            ? this.theme.success
            : this.theme.muted;
    return [fitWidth(` ${paint(this.text)}`, width)];
  }
}
