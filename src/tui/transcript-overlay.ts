import { matchesKey, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { EventRecord } from "../control-plane/db.js";
import { formatResetCountdown } from "./overlays.js";
import { fitWidth, formatAgentError, parseMouseWheel, type HarnessTheme } from "./primitives/index.js";

/** Replay rows and live frames share these fields. */
export type TranscriptEvent = Pick<EventRecord, "seq" | "type" | "payload"> & Partial<EventRecord>;

function wrap(text: string, width: number, paint: (s: string) => string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    if (!raw) {
      out.push("");
      continue;
    }
    for (const l of wrapTextWithAnsi(paint(raw), Math.max(1, width))) out.push(l);
  }
  return out;
}

function noticeFor(ev: TranscriptEvent): { text: string; tone: "muted" | "warning" | "success" | "info" } | null {
  const p = (ev.payload ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "task.status":
      return { text: `● status ${String(p.from ?? "?")} → ${String(p.to ?? "?")}${p.summary ? ` — ${String(p.summary)}` : ""}`, tone: "muted" };
    case "agent.rollover":
      return { text: `↻ clean rollover gen ${String(p.fromGen ?? "?")} → ${String(p.toGen ?? "?")}${p.reason ? ` (${String(p.reason)})` : ""}`, tone: "info" };
    case "quota.agent_retrying":
      return { text: `⏳ Rate-limited (${String(p.reason ?? "429")}) — CLI retrying natively…`, tone: "muted" };
    case "quota.agent_recovered":
      return { text: `✓ Recovered after ${String(p.retryCount ?? 1)} transient retry(ies).`, tone: "success" };
    case "quota.agent_paused":
      return {
        text: `⏸ Stopped early due to quota (${String(p.reason ?? "quota")}${p.resetAt ? ` · reset ${formatResetCountdown(String(p.resetAt))}` : ""}) — worktree & WIP preserved.`,
        tone: "warning",
      };
    case "quota.run_paused":
      return {
        text: `⏸ Run paused on quota${typeof p.resumeAt === "string" ? ` · auto-resume ${formatResetCountdown(p.resumeAt)}` : ""}.`,
        tone: "warning",
      };
    case "quota.run_scheduled":
      return { text: `⏱ Auto-resume scheduled ${formatResetCountdown(String(p.resumeAt ?? ""))}.`, tone: "info" };
    case "quota.run_resumed":
      return { text: `▶ Run resumed (${String(p.trigger ?? "manual")}).`, tone: "success" };
    default:
      if (ev.type.startsWith("quota.")) return { text: `${ev.type}${p.reason ? ` — ${String(p.reason)}` : ""}`, tone: "warning" };
      return null;
  }
}

/**
 * Pure transcript renderer: consecutive text/thought deltas coalesce into paragraphs, each tool call
 * is one status line (updated in place by later events with the same id), errors are red, and
 * status / rollover / quota events are notices. Every event is rendered; nothing is truncated.
 */
export function renderTranscriptLines(events: readonly TranscriptEvent[], theme: HarnessTheme, width: number): string[] {
  type Block =
    | { kind: "text" | "thought"; text: string }
    | { kind: "tool"; label: string; status: string }
    | { kind: "lines"; lines: string[] };
  const blocks: Block[] = [];
  const tools = new Map<string, Extract<Block, { kind: "tool" }>>();

  for (const ev of events) {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === "agent.text_delta" || ev.type === "agent.thought_delta") {
      const kind = ev.type === "agent.text_delta" ? "text" : "thought";
      const text = String(p.text ?? "");
      if (!text) continue;
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.text += text;
      else blocks.push({ kind, text });
    } else if (ev.type === "agent.tool") {
      const label = String(p.title ?? p.name ?? "tool")
        .replace(/^mcp[._/]harness[._/]+/i, "harness:")
        .replace(/^mcp__harness__/i, "harness:");
      const status = String(p.status ?? "running");
      const existing = p.id ? tools.get(String(p.id)) : undefined;
      if (existing) {
        existing.status = status;
        if (p.title || p.name) existing.label = label;
      } else {
        const block = { kind: "tool" as const, label, status };
        blocks.push(block);
        if (p.id) tools.set(String(p.id), block);
      }
    } else if (ev.type === "agent.error") {
      const f = formatAgentError(String(p.error ?? p.message ?? "Agent error"));
      const lines = [`✗ ${f.headline}`, ...(f.detail ? [f.detail] : [])];
      blocks.push({ kind: "lines", lines: lines.flatMap((l) => wrap(l, width, theme.error)) });
    } else {
      const n = noticeFor(ev);
      if (!n) continue;
      const paint = n.tone === "warning" ? theme.warning : n.tone === "success" ? theme.success : n.tone === "info" ? theme.info : theme.muted;
      blocks.push({ kind: "lines", lines: wrap(n.text, width, paint) });
    }
  }

  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text" || b.kind === "thought") {
      out.push(...wrap(b.text, width, b.kind === "text" ? theme.text : (s) => theme.dim(theme.italic(s))));
    } else if (b.kind === "tool") {
      const icon =
        b.status === "completed" ? theme.success("✓") : b.status === "failed" ? theme.error("✗") : theme.accent("⚙");
      const detail = b.status === "completed" ? "" : b.status === "failed" ? theme.error(" failed") : theme.dim(" running…");
      out.push(...wrap(`${icon} ${b.label}${detail}`, width, (s) => s));
    } else if (b.kind === "lines") out.push(...b.lines);
  }
  return out;
}

export interface AgentTranscriptOverlayOptions {
  theme: HarnessTheme;
  runId: string;
  taskId: string;
  title: string;
  model?: string | null;
  profileId?: string | null;
  effort?: string | null;
  startWatch: (
    onEvent: (ev: TranscriptEvent) => void,
    onReplay: (ev: EventRecord) => void,
  ) => Promise<{ replay: EventRecord[]; stop: () => Promise<void> | void }>;
  onClose: () => void;
  requestRender: () => void;
  /** Visible transcript lines (defaults to the terminal height minus chrome). */
  viewportRows?: number;
}

/**
 * Strictly read-only live transcript of one agent: replay then live events, scrollable,
 * auto-following while scrolled to the bottom. There is no input box or steering.
 */
export class AgentTranscriptOverlay implements Component {
  private events: TranscriptEvent[] = [];
  private pending: TranscriptEvent[] = [];
  private replayed = false;
  private lastSeq = -Infinity;
  private stopFn: (() => Promise<void> | void) | null = null;
  private closed = false;
  private loadError: string | null = null;
  private scrollTop = 0;
  private follow = true;
  private cache: { count: number; width: number; lines: string[] } | null = null;
  private lastWidth = 80;

  constructor(private readonly opts: AgentTranscriptOverlayOptions) {
    void this.opts
      .startWatch((ev) => this.onLive(ev), (ev) => {
        if (this.closed) return;
        this.push(ev);
        this.opts.requestRender();
      })
      .then(({ replay, stop }) => {
        if (this.closed) {
          void stop();
          return;
        }
        this.stopFn = stop;
        for (const ev of replay) this.push(ev);
        this.replayed = true;
        for (const ev of this.pending) this.push(ev);
        this.pending = [];
        this.opts.requestRender();
      })
      .catch((err) => {
        this.loadError = err instanceof Error ? err.message : String(err);
        this.opts.requestRender();
      });
  }

  /** Number of events held (never truncated). */
  get eventCount(): number {
    return this.events.length;
  }

  private push(ev: TranscriptEvent): void {
    if (ev.seq <= this.lastSeq) return; // dedupe replay/live overlap
    this.lastSeq = ev.seq;
    this.events.push(ev);
  }

  private onLive(ev: TranscriptEvent): void {
    if (this.closed) return;
    if (ev.taskId != null && ev.taskId !== this.opts.taskId) return;
    if (!this.replayed) {
      this.pending.push(ev);
      return;
    }
    this.push(ev);
    this.opts.requestRender();
  }

  private allLines(width: number): string[] {
    if (!this.cache || this.cache.count !== this.events.length || this.cache.width !== width) {
      this.cache = { count: this.events.length, width, lines: renderTranscriptLines(this.events, this.opts.theme, width) };
    }
    return this.cache.lines;
  }

  private viewportRows(): number {
    return this.opts.viewportRows ?? Math.max(6, (process.stdout.rows ?? 30) - 10);
  }

  private maxTop(): number {
    return Math.max(0, this.allLines(this.lastWidth).length - this.viewportRows());
  }

  private scrollTo(top: number): void {
    const max = this.maxTop();
    this.scrollTop = Math.max(0, Math.min(max, top));
    this.follow = this.scrollTop >= max;
    this.opts.requestRender();
  }

  handleInput(data: string): void {
    if (this.closed) return;
    const page = Math.max(1, this.viewportRows() - 1);
    if (this.follow) this.scrollTop = this.maxTop(); // catch up to the live bottom first
    const mouse = parseMouseWheel(data, 3);
    if (mouse.isMouse) {
      if (mouse.deltaLines !== 0) this.scrollTo(this.scrollTop + mouse.deltaLines);
      return;
    }
    if (matchesKey(data, "escape")) {
      this.closed = true;
      const stop = this.stopFn;
      this.stopFn = null;
      // Stop first, but never let a hung daemon keep the overlay open.
      try {
        void Promise.resolve(stop?.()).catch(() => {});
      } catch {}
      this.opts.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") this.scrollTo(this.scrollTop - 1);
    else if (matchesKey(data, "down") || data === "j") this.scrollTo(this.scrollTop + 1);
    else if (matchesKey(data, "pageUp")) this.scrollTo(this.scrollTop - page);
    else if (matchesKey(data, "pageDown")) this.scrollTo(this.scrollTop + page);
    else if (data === "g" || matchesKey(data, "home")) this.scrollTo(0);
    else if (data === "G" || matchesKey(data, "end")) this.scrollTo(Number.MAX_SAFE_INTEGER);
  }

  invalidate(): void {
    this.cache = null;
  }

  render(width: number): readonly string[] {
    const t = this.opts.theme;
    this.lastWidth = width;
    const modelBase = this.opts.model || this.opts.profileId || "";
    const modelStr = modelBase
      ? this.opts.effort
        ? `${modelBase} (${this.opts.effort})`
        : modelBase
      : "";
    const modelPart = modelStr ? ` ${t.accent(`[${modelStr}]`)}` : "";
    const header = fitWidth(
      `${t.accentBold(this.opts.taskId)} ${this.opts.title}${modelPart} ${t.dim(`· ${this.opts.runId} · read-only`)}`,
      width,
    );
    const out = [header, t.border("─".repeat(Math.max(0, width)))];
    const vp = this.viewportRows();
    if (this.loadError) {
      out.push(fitWidth(t.error(`Failed to open transcript: ${this.loadError}`), width));
      return out;
    }
    if (!this.replayed && !this.events.length) {
      out.push(fitWidth(t.muted("Loading transcript…"), width));
      return out;
    }
    const lines = this.allLines(width);
    const hasScrollbar = lines.length > vp && width >= 20;
    const contentWidth = hasScrollbar ? width - 2 : width;
    const renderedLines = hasScrollbar ? this.allLines(contentWidth) : lines;
    if (renderedLines.length === 0) out.push(fitWidth(t.muted("No output from this agent yet."), width));
    const max = Math.max(0, renderedLines.length - vp);
    if (this.follow) this.scrollTop = max;
    this.scrollTop = Math.min(this.scrollTop, max);

    const visibleSlice = renderedLines.slice(this.scrollTop, this.scrollTop + vp);
    if (hasScrollbar && renderedLines.length > vp) {
      const thumbSize = Math.max(1, Math.round((vp * vp) / renderedLines.length));
      const thumbTop = max > 0 ? Math.round((this.scrollTop / max) * (vp - thumbSize)) : 0;
      for (let i = 0; i < visibleSlice.length; i++) {
        const isThumb = i >= thumbTop && i < thumbTop + thumbSize;
        const bar = isThumb ? t.accent("┃") : t.dim("│");
        out.push(`${bar} ${fitWidth(visibleSlice[i]!, contentWidth)}`);
      }
    } else {
      for (const l of visibleSlice) out.push(fitWidth(l, width));
    }

    const pct = max > 0 ? Math.round((this.scrollTop / max) * 100) : 100;
    const pos =
      renderedLines.length > vp
        ? `${this.scrollTop + 1}-${Math.min(renderedLines.length, this.scrollTop + vp)}/${renderedLines.length} (${pct}%)`
        : `${renderedLines.length}/${renderedLines.length}`;
    const hint =
      width >= 96
        ? `${pos} · ${this.follow ? "following" : "paused"} · mouse wheel/↑↓/jk scroll · PgUp/PgDn · g/G top/bottom · Esc close`
        : `${pos} · ${this.follow ? "following" : "paused"} · wheel/↑↓ scroll · g/G · Esc close`;
    out.push(fitWidth(t.dim(hint), width));
    return out;
  }
}
