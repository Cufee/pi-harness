import { Markdown, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ChatControlEvent } from "../../protocol/chat-events.js";
import type { FormattedAgentError } from "./error-format.js";
import type { HarnessTheme } from "./theme.js";
import { flattenText, secondary, SPACER, statusGlyph, titleRow, titleText, type RowStatus } from "./rows.js";
import { clampLine, fillLineBg, fitWidth } from "./width.js";

/** Immutable compact session header rendered once at the top of scrollback. */
export class BannerCard implements Component {
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    private readonly title: string,
    private readonly subtitle: string,
    private readonly hint = "",
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;
    const inner = Math.max(1, width - 2);
    const l1 = titleRow(this.theme, { glyph: this.theme.accentBold("◆"), title: this.title, detail: this.subtitle, indent: 1 }, width);
    const hintLines = this.hint ? wrapTextWithAnsi(this.theme.dim(this.hint), inner).map((l) => clampLine(` ${l}`, width)) : [];
    this.cachedWidth = width;
    this.cachedLines = [
      l1,
      ...hintLines,
      this.theme.border("─".repeat(width)),
    ];
    return this.cachedLines;
  }
}

/**
 * Immutable user prompt card with subtle lifted background + accent left bar (`▎`).
 * Memoized by width so `TuiMainScreen`'s Container skips it in O(1) during streaming.
 */
export class UserCard implements Component {
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    private readonly text: string,
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;

    const inner = Math.max(1, width - 4);
    const wrapped = wrapTextWithAnsi(this.text, inner);
    const bar = this.theme.accent("▎");
    const out: string[] = [SPACER];
    for (let i = 0; i < wrapped.length; i++) {
      const prefix = i === 0 ? `${bar} ${this.theme.accentBold("›")} ` : `${bar}   `;
      out.push(fillLineBg(`${prefix}${wrapped[i]!}`, width, this.theme.userBg));
    }
    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }
}

/**
 * Assistant Markdown segment, cached between text updates.
 * Code blocks have NO right border so native terminal mouse-drag copy is 100% clean.
 */
export class AssistantCard implements Component {
  private readonly md: Markdown;
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    markdownText: string,
    private readonly meta?: string,
  ) {
    this.md = new Markdown(markdownText, 1, 0, theme.toMarkdownTheme());
  }

  setText(text: string): void {
    this.md.setText(text);
    this.cachedWidth = -1;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.md.invalidate();
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;
    const out: string[] = [SPACER];
    if (this.meta) {
      out.push(clampLine(` ${this.theme.accent("◆")} ${this.theme.muted(this.meta)}`, width));
    }
    for (const line of this.md.render(width)) {
      out.push(clampLine(line, width));
    }
    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }
}

/** One tool call, with a three-row budget at the terminal width. */
export class ToolPill implements Component {
  private args: string;
  private result = "";
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    public status: RowStatus,
    private readonly name: string,
    args = "",
  ) {
    this.args = flattenText(args);
  }

  update(status: RowStatus, result?: string, args?: string): void {
    this.status = status;
    if (args !== undefined) this.args = flattenText(args);
    if (result !== undefined) this.result = flattenText(result);
    this.invalidate();
  }

  finishCall(): void {
    if (this.status === "running") this.update("called");
  }

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = [
      titleRow(this.theme, { glyph: statusGlyph(this.theme, this.status), title: flattenText(this.name), indent: 4 }, width),
      ...(this.args ? [fitWidth(`      ${secondary(this.theme, `Args: ${this.args}`)}`, width)] : []),
      ...(this.result ? [fitWidth(`      ${this.status === "error" ? this.theme.error(`Error: ${this.result}`) : secondary(this.theme, `Result: ${this.result}`)}`, width)] : []),
    ];
    return this.cachedLines;
  }
}

/** Immutable subtle system / milestone card (for review scorecards, goal transitions, info notes). */
export class SystemCard implements Component {
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    private readonly lines: string[],
    private readonly tone: "muted" | "success" | "warning" | "info" = "muted",
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;
    const barPaint =
      this.tone === "success"
        ? this.theme.success
        : this.tone === "warning"
          ? this.theme.warning
          : this.tone === "info"
            ? this.theme.info
            : this.theme.border;
    const bar = barPaint("│");
    const inner = Math.max(1, width - 3);
    const out: string[] = [];
    for (const raw of this.lines) {
      for (const wrapped of wrapTextWithAnsi(raw, inner)) {
        out.push(clampLine(` ${bar} ${wrapped}`, width));
      }
    }
    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }
}

/** Clean human-readable ErrorCard (never vomits raw stderr inline; links saved error log). */
export class ErrorCard implements Component {
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    private readonly formatted: FormattedAgentError,
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;
    const bar = this.theme.error("▎");
    const inner = Math.max(1, width - 4);
    const out: string[] = [SPACER];

    const headLines = wrapTextWithAnsi(`${this.theme.error("✗")} ${this.theme.bold(this.formatted.headline)}`, inner);
    for (const l of headLines) out.push(clampLine(` ${bar} ${l}`, width));

    if (this.formatted.detail) {
      for (const l of wrapTextWithAnsi(this.theme.muted(this.formatted.detail), inner)) {
        out.push(clampLine(` ${bar}   ${l}`, width));
      }
    }
    if (this.formatted.logPath) {
      out.push(clampLine(` ${bar}   ${this.theme.dim(`Details: ${this.formatted.logPath}`)}`, width));
    }

    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }
}

export class GoalNotice implements Component {
  constructor(private readonly theme: HarnessTheme, private readonly text: string) {}

  invalidate(): void {}

  render(width: number): readonly string[] {
    return width > 0 ? [clampLine(secondary(this.theme, `  ${this.text}`), width)] : [];
  }
}

/** Typed control-plane event in the chat transcript. */
export class EventCard implements Component {
  private cachedWidth = -1;
  private cachedLines: readonly string[] = [];

  constructor(
    private readonly theme: HarnessTheme,
    private readonly event: ChatControlEvent,
  ) {}

  invalidate(): void {
    this.cachedWidth = -1;
  }

  render(width: number): readonly string[] {
    if (width <= 0) return [];
    if (this.cachedWidth === width) return this.cachedLines;

    const event = this.event;
    const cacheNotice = (text: string): readonly string[] => {
      const lines = new GoalNotice(this.theme, text).render(width);
      this.cachedWidth = width;
      this.cachedLines = lines;
      return lines;
    };
    if (event.kind === "goal.committed") return cacheNotice(`${event.goalId} started`);
    if (event.kind === "goal.settled" && event.runStatus === "completed" && event.openEscalations === 0) {
      return cacheNotice(`${event.goalId} completed`);
    }
    if (event.kind === "goal.reviewed" && event.status === "achieved" && !event.circuitBreakerTripped) {
      return cacheNotice(`${event.goalId} achieved`);
    }
    const { icon, status, badge, headline, detail, tone } = this.describe(event);
    const paint =
      tone === "success"
        ? this.theme.success
        : tone === "error"
          ? this.theme.error
          : tone === "warning"
            ? this.theme.warning
            : this.theme.info;
    const gutter = paint("┃");
    const tag = paint(titleText(this.theme, { glyph: status ? statusGlyph(this.theme, status) : paint(icon), title: badge }));
    const inner = Math.max(1, width - 4);
    const out: string[] = [SPACER];

    const headLines = wrapTextWithAnsi(`${tag}  ${headline}`, inner);
    for (let i = 0; i < headLines.length; i++) {
      const line = i === 0 ? ` ${gutter} ${headLines[i]!}` : ` ${gutter}   ${headLines[i]!}`;
      out.push(fillLineBg(fitWidth(line, width), width, this.theme.surfaceBg));
    }
    if (detail) {
      for (const l of wrapTextWithAnsi(secondary(this.theme, detail), inner)) {
        out.push(fillLineBg(fitWidth(` ${gutter}   ${l}`, width), width, this.theme.surfaceBg));
      }
    }

    this.cachedWidth = width;
    this.cachedLines = out;
    return out;
  }

  private describe(ev: Exclude<ChatControlEvent, { kind: "goal.committed" }>): {
    icon: string;
    status?: RowStatus;
    badge: string;
    headline: string;
    detail?: string;
    tone: "info" | "success" | "warning" | "error";
  } {
    switch (ev.kind) {
      case "goal.settled": {
        const tone = ev.runStatus === "completed" ? "success" : ev.runStatus === "failed" ? "error" : "warning";
        const status = ev.runStatus === "completed" ? "ok" : ev.runStatus === "failed" ? "error" : undefined;
        const badge = ev.runStatus === "completed" ? "EVENT · GOAL RUN COMPLETED" : `EVENT · GOAL RUN ${ev.runStatus.toUpperCase()}`;
        const escNote = ev.openEscalations > 0 ? ` · ${ev.openEscalations} open escalation(s)` : "";
        return {
          icon: "■",
          status,
          badge,
          headline: `${this.theme.bold(`${ev.goalId} v${ev.goalVersion}`)} "${ev.goalTitle}" ${this.theme.dim(`(${ev.runId}${escNote})`)}`,
          tone,
        };
      }
      case "goal.amended":
        return {
          icon: "↻",
          badge: "EVENT · GOAL AMENDED",
          headline: `${this.theme.bold(ev.goalId)} v${ev.fromVersion} → v${ev.toVersion}`,
          detail: ev.rationale,
          tone: "warning",
        };
      case "goal.reviewed": {
        const tone =
          ev.status === "achieved" ? "success" : ev.status === "awaiting_human" ? "error" : "warning";
        const icon = ev.status === "achieved" ? "✓" : ev.status === "awaiting_human" ? "!" : "◆";
        const badge =
          ev.status === "achieved"
            ? "EVENT · GOAL ACHIEVED"
            : ev.status === "awaiting_human"
              ? `EVENT · HUMAN REVIEW NEEDED${ev.circuitBreakerTripped ? ` (${ev.circuitBreakerTripped})` : ""}`
              : `EVENT · REVIEW #${ev.cycle} CHANGES REQUESTED`;
        return {
          icon,
          badge,
          headline: `${this.theme.bold(`${ev.goalId} v${ev.goalVersion}`)}`,
          detail: ev.summary,
          tone,
        };
      }
      case "director.read_file":
        return {
          icon: "◇",
          badge: "EVENT · FILE EXCEPTION",
          headline: `${this.theme.bold(ev.path)} ${this.theme.dim(`(${ev.bytes} bytes)`)}`,
          detail: ev.reason,
          tone: "info",
        };
      case "timer.scheduled": {
        const at = new Date(ev.wakeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const extras: string[] = [`wakes ${at}`];
        if (ev.goalId) extras.push(ev.goalId);
        if (ev.pausedGoal) extras.push("paused goal");
        if (ev.wakeOnEvent && ev.wakeOnEvent !== "none") extras.push(`early wake: ${ev.wakeOnEvent}`);
        return {
          icon: "⏰",
          badge: "EVENT · TIMER SCHEDULED",
          headline: `${this.theme.bold(ev.timerId)} ${this.theme.dim(`(${extras.join(" · ")})`)}`,
          detail: ev.reason,
          tone: "info",
        };
      }
      case "timer.fired": {
        const extras: string[] = [ev.wakeReason];
        if (ev.goalId) extras.push(ev.goalId);
        if (ev.resumedGoal) extras.push("resumed goal");
        return {
          icon: "⏰",
          badge: "EVENT · TIMER FIRED",
          headline: `${this.theme.bold(ev.timerId)} ${this.theme.dim(`(${extras.join(" · ")})`)}`,
          detail: ev.reason,
          tone: "success",
        };
      }
    }
  }
}
