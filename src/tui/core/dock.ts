import {
  type AutocompleteProvider,
  type Component,
  Container,
  Editor,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { type ChatQueueItem, formatQueueItemState } from "../chat-queue.js";
import type { ToolDisplayPayload } from "../tool-output/index.js";
import { firstLine } from "./format.js";
import { type EntityRef, type Hint, renderHintBar } from "./keymap.js";
import { clamp, fillLineBg, fit, middleEllipsis, sanitizeLine, sanitizeText, splitRow, visibleWidth, wrap } from "./text.js";
import type { Theme, Tone } from "./tokens.js";
import { renderTranscriptBlock, type TranscriptBlock } from "./transcript-blocks.js";

/**
 * Immutable transcript block: once rendered at `width`, its lines NEVER mutate.
 * Because nothing above the viewport changes, `pi-tui` never wipes terminal scrollback.
 */
export class FrozenBlock implements Component {
  private cachedWidth = -1;
  private cachedLines: string[] = [];

  constructor(private readonly renderFn: (width: number) => string[]) {}

  render(width: number): string[] {
    if (this.cachedWidth === width) return this.cachedLines;
    this.cachedWidth = width;
    this.cachedLines = this.renderFn(width).map((l) => clamp(l, width));
    return this.cachedLines;
  }

  invalidate(): void {
    this.cachedWidth = -1;
    this.cachedLines = [];
  }
}

export interface LiveToolPill {
  id: string;
  label: string;
  status: "running" | "ok" | "error";
  detail?: string;
}

const TIMESTAMP_GROUP_GAP_MS = 5 * 60_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function normalizeTimestampMs(ts: number | null | undefined): number | null {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  return Math.floor(ts);
}

function isSameLocalDay(aMs: number, bMs: number): boolean {
  const a = new Date(aMs);
  const b = new Date(bMs);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatLocalClockMinute(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatGroupedTimestampLabel(tsMs: number, prevTsMs: number | null, sep: string): string | null {
  if (prevTsMs === null || !isSameLocalDay(prevTsMs, tsMs)) {
    const d = new Date(tsMs);
    return `${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()} ${sep} ${formatLocalClockMinute(d)}`;
  }
  if (Math.abs(tsMs - prevTsMs) >= TIMESTAMP_GROUP_GAP_MS) {
    return formatLocalClockMinute(new Date(tsMs));
  }
  return null;
}

function renderTimestampDivider(label: string, width: number, theme: Theme): string {
  const w = Math.max(1, Math.floor(width));
  const g = theme.glyphs;
  const clean = sanitizeLine(label);
  const text = ` ${clean} `;
  const textW = visibleWidth(text);
  if (w < textW + 6) {
    return clamp(` ${theme.muted(clean)}`, w);
  }
  const available = w - 2 - textW;
  const leftLen = Math.floor(available / 2);
  const rightLen = available - leftLen;
  const line = ` ${theme.border(g.barH.repeat(leftLen))}${theme.muted(text)}${theme.border(g.barH.repeat(rightLen))} `;
  return clamp(line, w);
}

/**
 * Strictly-bottom-only streaming tail for the active assistant turn.
 * Renders only while a turn is live; when the turn finishes, its final content is frozen into
 * `ImmutableTranscript` and this tail resets to empty.
 */
export class LiveTurnTail implements Component {
  private text = "";
  private thought = "";
  private tools: LiveToolPill[] = [];
  private active = false;
  private modelLabel: string | undefined;
  private textTimestampMs: number | null = null;
  private activityTimestampMs: number | null = null;

  constructor(
    private readonly theme: Theme,
    private readonly resolveDividerLabel?: (tsMs: number | null) => string | null,
  ) {}

  begin(modelLabel?: string): void {
    this.active = true;
    this.text = "";
    this.thought = "";
    this.tools = [];
    this.modelLabel = modelLabel;
    this.textTimestampMs = null;
    this.activityTimestampMs = null;
  }

  /**
   * Resets the streaming tail on reconnect. `seedText` is the daemon's post-flush `activePartial`,
   * which is authoritative for the current segment and is always kept.
   */
  reseed(seedText: string, modelLabel?: string): void {
    this.active = true;
    this.text = seedText;
    this.thought = "";
    this.tools = [];
    this.modelLabel = modelLabel;
    this.textTimestampMs = null;
    this.activityTimestampMs = null;
  }

  appendText(delta: string, timestampMs?: number | null): void {
    this.active = true;
    this.text += delta;
    const ts = normalizeTimestampMs(timestampMs);
    if (ts !== null && this.textTimestampMs === null && this.text.trim()) {
      this.textTimestampMs = ts;
    }
  }

  appendThought(delta: string, timestampMs?: number | null): void {
    this.active = true;
    this.thought += delta;
    const ts = normalizeTimestampMs(timestampMs);
    if (ts !== null) this.activityTimestampMs = ts;
  }

  upsertTool(pill: LiveToolPill, timestampMs?: number | null): void {
    this.active = true;
    const idx = this.tools.findIndex((t) => t.id === pill.id);
    if (idx >= 0) this.tools[idx] = pill;
    else this.tools.push(pill);
    const ts = normalizeTimestampMs(timestampMs);
    if (ts !== null) this.activityTimestampMs = ts;
  }

  snapshot(): {
    text: string;
    thought: string;
    tools: LiveToolPill[];
    modelLabel?: string;
    textTimestampMs: number | null;
  } {
    return {
      text: this.text,
      thought: this.thought,
      tools: [...this.tools],
      modelLabel: this.modelLabel,
      textTimestampMs: this.textTimestampMs,
    };
  }

  clear(): void {
    this.active = false;
    this.text = "";
    this.thought = "";
    this.tools = [];
    this.modelLabel = undefined;
    this.textTimestampMs = null;
    this.activityTimestampMs = null;
  }

  get isActive(): boolean {
    return this.active;
  }

  render(width: number): string[] {
    if (!this.active) return [];
    const w = Math.max(8, Math.floor(width));
    const out: string[] = [];
    const g = this.theme.glyphs;

    if (this.text.trim()) {
      out.push(
        ...renderTranscriptBlock(
          { kind: "assistant", text: this.text, meta: this.modelLabel },
          w,
          this.theme,
          "expanded",
        ),
      );
    } else if (this.thought.trim()) {
      const last = sanitizeLine(this.thought.trim().split("\n").slice(-1)[0] ?? "");
      if (last) {
        out.push(clamp(this.theme.dim(`  … ${last}`), w));
      }
    }

    // Volatile live tool pills render strictly BELOW live text so status transitions never shift prior lines.
    if (this.tools.length > 0) {
      const recent = this.tools.slice(-4);
      const hidden = this.tools.length - recent.length;
      const parts = recent.map((t) => {
        const icon = t.status === "running" ? g.running : t.status === "ok" ? g.check : g.cross;
        const tone: Tone = t.status === "running" ? "accent" : t.status === "ok" ? "ok" : "danger";
        const suffix = t.detail ? ` ${sanitizeLine(t.detail)}` : "";
        return this.theme.paint(tone, `${icon} ${t.label}${suffix}`);
      });
      const prefix = hidden > 0 ? this.theme.muted(`+${hidden} `) : "";
      out.push(clamp(`  ${prefix}${parts.join(this.theme.muted(` ${g.sep} `))}`, w));
    }

    if (out.length === 0) return [];

    const effectiveTs = this.text.trim() ? this.textTimestampMs : this.activityTimestampMs;
    const label = this.resolveDividerLabel?.(effectiveTs) ?? null;
    if (label) {
      out.unshift("", renderTimestampDivider(label, w, this.theme));
    }

    return out;
  }

  /** Consumes and returns accumulated live text before a daemon flush point. */
  takeText(): { text: string; modelLabel: string; timestampMs: number | null } {
    const text = this.text;
    const hasText = Boolean(text.trim());
    const modelLabel = hasText ? (this.modelLabel ?? "") : "";
    const timestampMs = this.textTimestampMs;
    this.text = "";
    this.thought = "";
    if (hasText) {
      this.modelLabel = undefined;
    }
    this.textTimestampMs = null;
    this.activityTimestampMs = null;
    return { text, modelLabel, timestampMs };
  }

  invalidate(): void {}
}

export interface AppendReceiptOptions {
  glyph?: string;
  tone?: Tone;
  tag?: string;
  text: string;
  ref?: EntityRef;
  timestampMs?: number | null;
}

/**
 * Append-only transcript container. Every committed turn, tool-output card, and receipt is immutable.
 */
export class ImmutableTranscript extends Container {
  readonly liveTail: LiveTurnTail;
  private readonly frozenContainer = new Container();
  private lastTimestampMs: number | null = null;

  constructor(private readonly theme: Theme) {
    super();
    this.liveTail = new LiveTurnTail(theme, (tsMs) => this.computeTimestampLabel(tsMs));
    this.addChild(this.frozenContainer);
    this.addChild(this.liveTail);
  }

  private computeTimestampLabel(tsMs: number | null | undefined): string | null {
    const ts = normalizeTimestampMs(tsMs);
    if (ts === null) return null;
    return formatGroupedTimestampLabel(ts, this.lastTimestampMs, this.theme.glyphs.sep);
  }

  private maybeAppendTimestampDivider(timestampMs?: number | null): void {
    const ts = normalizeTimestampMs(timestampMs);
    if (ts === null) return;
    const label = formatGroupedTimestampLabel(ts, this.lastTimestampMs, this.theme.glyphs.sep);
    this.lastTimestampMs = ts;
    if (!label) return;
    const t = this.theme;
    this.frozenContainer.addChild(
      new FrozenBlock((w) => ["", renderTimestampDivider(label, w, t)]),
    );
  }

  appendBlank(): void {
    this.frozenContainer.addChild(new FrozenBlock(() => [""]));
  }

  appendLines(lines: string[]): void {
    const copy = [...lines];
    this.frozenContainer.addChild(new FrozenBlock((w) => copy.flatMap((l) => wrap(l, w))));
  }

  /** Compact session header rendered once at the top of scrollback. */
  appendBanner(title: string, subtitle: string, hint?: string): void {
    const t = this.theme;
    const g = t.glyphs;
    this.frozenContainer.addChild(
      new FrozenBlock((w) => {
        const head = splitRow(
          ` ${t.accentBold(g.diamond)} ${t.bold(sanitizeLine(title))}`,
          `${t.muted(sanitizeLine(subtitle))} `,
          w,
        );
        const hintLines = hint
          ? wrap(t.dim(sanitizeLine(hint)), Math.max(1, w - 2)).map((l) => clamp(` ${l}`, w))
          : [];
        return [head, ...hintLines, t.border(g.barH.repeat(w))];
      }),
    );
  }

  /**
   * Generous immutable UserCard: left accent rail (`▎`), `› ` cue, inset padding,
   * and subtle calibrated `userBg` surface fill.
   */
  appendUserTurn(text: string, timestampMs?: number | null): void {
    if (!sanitizeText(text).trim()) return;
    this.maybeAppendTimestampDivider(timestampMs);
    const t = this.theme;
    const block: TranscriptBlock = { kind: "user", text };
    this.frozenContainer.addChild(new FrozenBlock((w) => renderTranscriptBlock(block, w, t)));
  }

  /**
   * Immutable AssistantCard: optional `◆ <model>` attribution header + syntax-highlighted Markdown.
   */
  appendAssistantTurn(markdownText: string, meta?: string, timestampMs?: number | null): void {
    if (!sanitizeText(markdownText).replace(/^\n+|\n+$/g, "").trim()) return;
    this.maybeAppendTimestampDivider(timestampMs);
    const t = this.theme;
    const block: TranscriptBlock = { kind: "assistant", text: markdownText, meta };
    this.frozenContainer.addChild(new FrozenBlock((w) => renderTranscriptBlock(block, w, t, "expanded")));
  }

  /** Starts a new live assistant turn. */
  beginLiveTurn(modelLabel?: string): void {
    this.liveTail.begin(modelLabel);
  }

  /** Reseeds the live turn on reconnect with the daemon's post-flush `activePartial`. */
  resyncLiveTurn(opts: {
    modelLabel?: string;
    seedText?: string;
  }): void {
    this.liveTail.reseed(opts.seedText ?? "", opts.modelLabel);
  }

  /**
   * Freezes any streamed live text into an immutable AssistantCard before a daemon flush point
   * (mid-turn tool card or accepted steer). Returns the frozen text when non-empty, else `null`.
   */
  freezeLiveText(fallbackTimestampMs?: number | null): string | null {
    if (!this.liveTail.isActive) return null;
    const { text, modelLabel, timestampMs } = this.liveTail.takeText();
    if (!text.trim()) return null;
    this.appendAssistantTurn(text, modelLabel || undefined, timestampMs ?? fallbackTimestampMs);
    return text;
  }

  /**
   * Settles the active live turn using the daemon's final persisted assistant segment.
   * Because every mid-turn TUI freeze coincides with a daemon flush, `finalText` (with a fresh seq)
   * is authoritative for the current segment and replaces the unfrozen live text. Callers suppress
   * already-rendered persisted rows by seq via `discardLiveText: true`.
   */
  settleLiveTurn(opts?: {
    finalText?: string;
    modelLabel?: string;
    timestampMs?: number | null;
    discardLiveText?: boolean;
  }): { tools: LiveToolPill[]; appendedText: string; textTimestampMs: number | null } {
    const snap = this.liveTail.snapshot();
    let toAppend = "";
    if (!opts?.discardLiveText) {
      toAppend = typeof opts?.finalText === "string" ? opts.finalText : snap.text;
    }

    this.liveTail.clear();

    const assistantTs = snap.textTimestampMs ?? opts?.timestampMs;
    if (toAppend.trim()) {
      this.appendAssistantTurn(toAppend, snap.modelLabel ?? opts?.modelLabel, assistantTs);
    }

    return {
      tools: snap.tools,
      appendedText: toAppend,
      textTimestampMs: snap.textTimestampMs,
    };
  }

  /**
   * Immutable structured Tool-Output Card (`goals_table`, `goal_detail`, `run_activity`).
   * Identical layout both live (from `chat.tool`) and replayed (from `turn.role === "tool_output"`).
   * Pass `{ freeze: false }` when replaying persisted history so live tail state is untouched.
   */
  appendToolOutput(display: ToolDisplayPayload, timestampMs?: number | null, opts?: { freeze?: boolean }): void {
    if (opts?.freeze !== false) {
      this.freezeLiveText(timestampMs);
    }
    this.maybeAppendTimestampDivider(timestampMs);
    const t = this.theme;
    const block: TranscriptBlock = { kind: "tool_output", display };
    this.frozenContainer.addChild(new FrozenBlock((w) => renderTranscriptBlock(block, w, t)));
  }

  /** Compact dim note for a persisted `tool_output` turn lacking a valid structured display. */
  appendToolOutputNote(text: string, timestampMs?: number | null): void {
    this.maybeAppendTimestampDivider(timestampMs);
    const t = this.theme;
    const block: TranscriptBlock = { kind: "tool_note", text };
    this.frozenContainer.addChild(new FrozenBlock((w) => renderTranscriptBlock(block, w, t)));
  }

  /**
   * Appends a single-line immutable receipt immediately above any streaming live tail without
   * freezing live text. Never mutates later; users open full details via `Ctrl+X` or `Ctrl+G`.
   */
  appendReceipt(opts: AppendReceiptOptions): void {
    this.maybeAppendTimestampDivider(opts.timestampMs);
    const t = this.theme;
    const g = t.glyphs;
    if (opts.tone === "dim") {
      const glyph = opts.glyph ?? g.bullet;
      const cleanText = sanitizeLine(opts.text);
      const tagPart = opts.tag ? `[${sanitizeLine(opts.tag)}] ` : "";
      const hintPart = opts.ref ? t.dim("  (Ctrl+X inspect)") : "";
      this.frozenContainer.addChild(
        new FrozenBlock((w) => [splitRow(`  ${t.dim(`${glyph} ${tagPart}${cleanText}`)}`, hintPart, w)]),
      );
      return;
    }
    const block: TranscriptBlock = {
      kind: "receipt",
      glyph: opts.glyph,
      tone: opts.tone,
      tag: opts.tag,
      text: opts.text,
      hint: opts.ref ? "(Ctrl+X inspect)" : undefined,
    };
    this.frozenContainer.addChild(new FrozenBlock((w) => renderTranscriptBlock(block, w, t)));
  }

  clearAll(): void {
    this.frozenContainer.clear();
    this.liveTail.clear();
    this.lastTimestampMs = null;
  }
}

/** Live work counts shown in the dock's single work row. */
export interface DockWorkSummary {
  /** Agents running right now. */
  active: number;
  /** Goals, runs, and agents that are blocked (waiting on a person, quota, or a rescope). */
  blocked: number;
  /** Short label of the first blocked item, such as `goal-12 needs your input: …`. */
  blockedLabel?: string | null;
}

export interface PinnedAttentionItem {
  glyph?: string;
  tone?: Tone;
  tag?: string;
  text: string;
}

export interface DockState {
  /** Idle line shown in the work row when nothing is active or blocked. */
  idleBanner: string;
  /** Live active / blocked counts for the work row (defaults to none). */
  work?: DockWorkSummary;
  /** Status row: left phase/action + spinner; right model/quota/queue summary. */
  busy: boolean;
  phaseText: string;
  /** Non-null when attached to a remote host — renders a prominent `[REMOTE: <host>]` badge on the status bar. */
  remoteHost?: string | null;
  /** Optional transient Ctrl+C or double-Esc confirmation hint shown in status row without changing height. */
  transientHint?: string | null;
  rightStatus: string;
  queuedCount: number;
  /** Pinned human-audience alerts that arrived while a live turn was streaming (cleared on next user submit/command). */
  pinnedAlerts?: readonly PinnedAttentionItem[];
  /** Pinned pending/sending user messages rendered directly above the composer. */
  queuedItems?: readonly ChatQueueItem[];
  /** Whether the queue strip supports explicit send-now steering (default true). */
  canSteerQueued?: boolean;
  /** Bottom hint strip (always 1 line). */
  hints: Hint[];
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Editor subclass that maps `Ctrl+Z` to base `Editor`'s native undo (preserving multi-paste payloads,
 * clearing on submit, and undoing cleanly back to `""`) and renders a `› ` prompt cue inside its
 * 2-column horizontal padding without shifting cursor geometry.
 */
export class UndoableEditor extends Editor {
  private lastAutocompleteLines: string[] = [];
  floatAutocomplete = false;

  constructor(
    tui: TUI,
    private readonly harnessTheme: Theme,
  ) {
    super(tui, harnessTheme.toEditorTheme(), { paddingX: 2 });
  }

  clearUndoHistory(): void {
    // Base Editor manages and clears its own undoStack on submit/setText.
  }

  getFloatingAutocompleteLines(): string[] {
    return this.lastAutocompleteLines;
  }

  override handleInput(data: string): void {
    if (matchesKey(data, "ctrl+z")) {
      // Delegate to pi-tui Editor's native undo (Ctrl+- / \x1f) which restores `{ state, pastes, pasteCounter }`.
      super.handleInput("\x1f");
      return;
    }
    super.handleInput(data);
  }

  override render(width: number): string[] {
    const lines = super.render(width);
    const acCount = this.isShowingAutocomplete()
      ? Number((this as unknown as { renderedAutocompleteHeight?: number }).renderedAutocompleteHeight ?? 0)
      : 0;
    if (acCount > 0 && this.floatAutocomplete && lines.length > acCount) {
      this.lastAutocompleteLines = lines.slice(lines.length - acCount);
      lines.length = lines.length - acCount;
    } else {
      this.lastAutocompleteLines = [];
    }
    // With paddingX: 2, line[0] is the top border and line[1] starts with 2 spaces;
    // swap those 2 spaces for the 2-col prompt cue `› ` so cursor alignment stays exact.
    if (lines.length >= 2 && lines[1]!.startsWith("  ")) {
      const cue = `${this.harnessTheme.accentBold(this.harnessTheme.glyphs.prompt)} `;
      lines[1] = `${cue}${lines[1]!.slice(2)}`;
    }
    return lines;
  }
}

/**
 * Constant-height bottom dock!
 *   Row 1: Top separator rule (always 1 row)
 *   Row 2: Work row: active agents, blocked items, and the first blocked item (always 1 row)
 *   Row 3: Unified Status / Spinner / Model / Queue bar with `statusBg` fill (always 1 row)
 *   Row 4+: Composer (`UndoableEditor` with `paddingX: 2` & `› ` prompt cue)
 *   Last Row: Keybinding HintBar (always 1 row)
 */
export class FixedDock implements Component {
  readonly editor: UndoableEditor;
  private readonly tuiRef: Component & { requestRender: () => void; terminal?: { rows?: number } };
  private state: DockState;
  private spinnerIdx = 0;

  constructor(
    tui: Component & { requestRender: () => void; terminal?: { rows?: number } },
    private readonly theme: Theme,
    opts: {
      autocomplete?: AutocompleteProvider;
      onSubmit: (text: string) => void;
      initialState: DockState;
    },
  ) {
    this.tuiRef = tui;
    this.state = opts.initialState;
    this.editor = new UndoableEditor(tui as unknown as TUI, theme);
    if (opts.autocomplete) this.editor.setAutocompleteProvider(opts.autocomplete);
    this.editor.onSubmit = (raw) => {
      this.editor.clearUndoHistory();
      opts.onSubmit(raw);
    };
    this.lastRenderedHeight = 7;
  }

  update(patch: Partial<DockState>): void {
    this.state = { ...this.state, ...patch };
  }

  tickSpinner(): boolean {
    if (!this.state.busy) return false;
    this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
    return true;
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  /** One constant-height row: active agents, blocked items, and the first blocked item's name. */
  private renderWorkRow(width: number): string {
    const t = this.theme;
    const g = t.glyphs;
    const w = this.state.work ?? { active: 0, blocked: 0 };
    const right = `${t.dim("Ctrl+G work")} `;
    let left: string;
    if (w.active === 0 && w.blocked === 0) {
      left = ` ${t.muted(sanitizeLine(this.state.idleBanner))}`;
    } else {
      const parts: string[] = [];
      parts.push(w.active > 0 ? t.ok(`${g.running} ${w.active} active`) : t.dim("0 active"));
      if (w.blocked > 0) parts.push(t.danger(`${g.warn} ${w.blocked} blocked`));
      const label = w.blocked > 0 && w.blockedLabel ? ` ${t.dim(g.sep)} ${t.warn(sanitizeLine(w.blockedLabel))}` : "";
      left = ` ${t.muted("Work:")} ${parts.join(t.dim(` ${g.sep} `))}${label}`;
    }
    if (visibleWidth(left) + 2 + visibleWidth(right) <= width) return splitRow(left, right, width);
    return fit(left, width);
  }

  private renderStatusRow(width: number): string {
    const t = this.theme;
    const g = t.glyphs;
    const shortHost = this.state.remoteHost ? middleEllipsis(sanitizeLine(this.state.remoteHost), 16) : "";
    const remoteBadge = shortHost ? `${t.warn(`[REMOTE: ${shortHost}]`)} ` : "";
    const right = this.state.rightStatus ? `${t.muted(this.state.rightStatus)} ` : "";
    const compose = (left: string) => {
      // Prioritize left status (remote badge + Ctrl+C / Esc confirmation hint + spinner) over right status on narrow widths
      if (right && visibleWidth(left) + 2 + visibleWidth(right) <= width) {
        return fillLineBg(splitRow(left, right, width), width, t.statusBg);
      }
      return fillLineBg(fit(left, width), width, t.statusBg);
    };
    if (this.state.transientHint) {
      const left = ` ${remoteBadge}${t.warn(g.warn)} ${t.warn(sanitizeLine(this.state.transientHint))}`;
      return compose(left);
    }
    const spin = this.state.busy
      ? t.accentBold(SPINNER_FRAMES[this.spinnerIdx]!)
      : t.ok(g.check);
    const q = this.state.queuedCount > 0 ? `  ${t.warn(`+${this.state.queuedCount} queued`)}` : "";
    const left = ` ${remoteBadge}${spin} ${sanitizeLine(this.state.phaseText)}${q}`;
    return compose(left);
  }

  /** Uses available terminal rows above the baseline dock while reserving space for the transcript. */
  private dynamicStripBudget(): number {
    const rows = this.tuiRef.terminal?.rows ?? 30;
    const baseDockRows = 7;
    return Math.max(1, rows - baseDockRows - 6);
  }

  private renderPinnedAlertsRows(width: number, maxRows: number): string[] {
    const items = this.state.pinnedAlerts;
    if (!items || items.length === 0) return [];
    const t = this.theme;
    const g = t.glyphs;
    const boundedMax = Math.max(1, Math.min(3, maxRows));
    const singleRowOverflow = boundedMax === 1 && items.length > 1;
    const visibleCap =
      items.length <= boundedMax
        ? items.length
        : singleRowOverflow
          ? 1
          : Math.max(1, boundedMax - 1);
    const shown = items.slice(0, visibleCap);
    const hidden = Math.max(0, items.length - shown.length);
    const out: string[] = [];

    for (let i = 0; i < shown.length; i += 1) {
      const item = shown[i]!;
      const tone: Tone = item.tone ?? "warn";
      const glyph = item.glyph ?? g.warn;
      const tagPart = item.tag ? `[${sanitizeLine(item.tag)}] ` : "";
      const cleanText = firstLine(sanitizeLine(item.text), Math.max(20, width));
      const prefix = ` ${t.paint(tone, `${glyph} ${tagPart}`)}`;
      const right = singleRowOverflow && hidden > 0 ? `${t.muted(`+${hidden} more`)} ` : "";
      if (right && visibleWidth(prefix) + 12 + visibleWidth(right) <= width) {
        const avail = width - visibleWidth(prefix) - visibleWidth(right) - 2;
        out.push(splitRow(`${prefix}${clamp(cleanText, avail)}`, right, width));
      } else {
        out.push(fit(`${prefix}${cleanText}`, width));
      }
    }

    if (!singleRowOverflow && hidden > 0) {
      out.push(fit(`  ${t.muted(`+${hidden} more`)}`, width));
    }

    return out;
  }

  private renderQueueStripRows(width: number, maxRows: number): string[] {
    const items = this.state.queuedItems;
    if (!items || items.length === 0) return [];
    const t = this.theme;
    const g = t.glyphs;
    const visibleCap = items.length <= maxRows ? items.length : Math.max(1, maxRows - 1);
    const shown = items.slice(0, visibleCap);
    const hidden = Math.max(0, items.length - shown.length);
    const canSteer = this.state.canSteerQueued !== false;
    const keyHint = canSteer
      ? width >= 88
        ? `${t.dim("Alt+S /now · Ctrl+R edit · Alt+Q drop")} `
        : width >= 72
          ? `${t.dim("/now · Ctrl+R edit · Alt+Q drop")} `
          : width >= 48
            ? `${t.dim("Alt+S · Ctrl+R · Alt+Q")} `
            : ""
      : width >= 72
        ? `${t.dim("Ctrl+R edit · Alt+Q drop")} `
        : width >= 48
          ? `${t.dim("Ctrl+R · Alt+Q")} `
          : "";
    const out: string[] = [];

    for (let i = 0; i < shown.length; i += 1) {
      const item = shown[i]!;
      const glyph =
        item.state === "sending" ? g.running : item.state === "unconfirmed" ? g.warn : g.ascii ? "~" : "⧗";
      const tone: Tone = item.state === "sending" ? "accent" : item.state === "unconfirmed" ? "danger" : "warn";
      const statusText = formatQueueItemState(item);
      const preview = firstLine(sanitizeLine(item.text), Math.max(20, width));
      const prefix = ` ${t.paint(tone, `${glyph} ${i + 1} ${statusText}`)} ${t.dim(g.sep)} `;
      const isLastRow = i === shown.length - 1 && hidden === 0;
      const right = isLastRow ? keyHint : "";
      if (right) {
        const prefixW = visibleWidth(prefix);
        const rightW = visibleWidth(right);
        const availForPreview = width - prefixW - rightW - 2;
        if (availForPreview >= 16) {
          const left = `${prefix}${clamp(preview, availForPreview)}`;
          out.push(splitRow(left, right, width));
          continue;
        }
      }
      out.push(fit(`${prefix}${preview}`, width));
    }

    if (hidden > 0) {
      const left = `  ${t.muted(`+${hidden} more · /queue`)}`;
      const right = keyHint || `${t.dim("/queue")} `;
      out.push(visibleWidth(left) + 2 + visibleWidth(right) <= width ? splitRow(left, right, width) : fit(left, width));
    }

    return out;
  }

  private lastRenderedHeight = 9;

  /** Last rendered row count of the FixedDock (used to anchor floating slash-autocomplete above the dock). */
  get renderedHeight(): number {
    return this.lastRenderedHeight;
  }

  render(width: number): string[] {
    const w = Math.max(12, Math.floor(width));
    const budget = this.dynamicStripBudget();
    const alertRows = this.renderPinnedAlertsRows(w, budget);
    const queueRows = this.renderQueueStripRows(w, Math.max(1, budget - alertRows.length));
    const lines: string[] = [
      this.theme.border(this.theme.glyphs.barH.repeat(w)),
      this.renderWorkRow(w),
      this.renderStatusRow(w),
      ...alertRows,
      ...queueRows,
      ...this.editor.render(w).map((l) => clamp(l, w)),
      fit(` ${renderHintBar(this.state.hints, Math.max(1, w - 2), this.theme)}`, w),
    ];
    this.lastRenderedHeight = lines.length;
    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}
