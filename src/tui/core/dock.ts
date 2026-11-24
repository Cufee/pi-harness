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
import { statusGlyph, statusTone, type Theme, type Tone } from "./tokens.js";
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
 * Strips an already-frozen text prefix from a full assistant turn string.
 * Returns `{ matched: true, remainder }` when `fullText` begins with `frozenText` (exact or trimmed),
 * or `{ matched: false, remainder: "" }` when `fullText` does not begin with `frozenText`.
 */
export function stripFrozenPrefix(fullText: string, frozenText: string): { matched: boolean; remainder: string } {
  if (!frozenText) return { matched: false, remainder: fullText };
  if (fullText.startsWith(frozenText)) {
    return { matched: true, remainder: fullText.slice(frozenText.length) };
  }
  const trimmedFrozen = frozenText.trim();
  if (trimmedFrozen.length > 0) {
    const trimmedFullStart = fullText.trimStart();
    if (trimmedFullStart.startsWith(trimmedFrozen)) {
      return { matched: true, remainder: trimmedFullStart.slice(trimmedFrozen.length) };
    }
  }
  return { matched: false, remainder: "" };
}

/**
 * Strictly-bottom-only streaming tail for the active assistant turn.
 * Renders only while a turn is live; when the turn finishes, its final content is frozen into
 * `ImmutableTranscript` and this tail resets to empty. Also records any text already frozen
 * mid-turn so settlement and reconnect resync never render the same reply twice.
 */
export class LiveTurnTail implements Component {
  private text = "";
  private thought = "";
  private tools: LiveToolPill[] = [];
  private active = false;
  private modelLabel: string | undefined;
  private textTimestampMs: number | null = null;
  private activityTimestampMs: number | null = null;
  private frozenText = "";
  private frozenSegmentCount = 0;

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
    this.frozenText = "";
    this.frozenSegmentCount = 0;
  }

  /**
   * Resets the streaming tail on reconnect while optionally preserving already-frozen text
   * from the same in-flight turn so previously rendered segments are stripped from `seedText`.
   */
  reseed(seedText: string, modelLabel?: string, preserveFrozen = false): void {
    const prevFrozen = preserveFrozen ? this.frozenText : "";
    const prevCount = preserveFrozen ? this.frozenSegmentCount : 0;
    this.active = true;
    this.text = "";
    this.thought = "";
    this.tools = [];
    this.modelLabel = modelLabel;
    this.textTimestampMs = null;
    this.activityTimestampMs = null;
    this.frozenText = prevFrozen;
    this.frozenSegmentCount = prevCount;
    if (seedText) {
      if (this.frozenSegmentCount > 0) {
        const stripped = stripFrozenPrefix(seedText, this.frozenText);
        this.text = stripped.matched ? stripped.remainder : seedText;
      } else {
        this.text = seedText;
      }
    }
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
    frozenText: string;
    frozenSegmentCount: number;
  } {
    return {
      text: this.text,
      thought: this.thought,
      tools: [...this.tools],
      modelLabel: this.modelLabel,
      textTimestampMs: this.textTimestampMs,
      frozenText: this.frozenText,
      frozenSegmentCount: this.frozenSegmentCount,
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
    this.frozenText = "";
    this.frozenSegmentCount = 0;
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

  /** Consumes and returns accumulated live text, recording any non-empty frozen segment on the tail. */
  takeText(): { text: string; modelLabel: string; timestampMs: number | null } {
    const text = this.text;
    const hasText = Boolean(text.trim());
    const modelLabel = hasText ? (this.modelLabel ?? "") : "";
    const timestampMs = this.textTimestampMs;
    this.text = "";
    this.thought = "";
    if (hasText) {
      this.modelLabel = undefined;
      this.frozenText += text;
      this.frozenSegmentCount += 1;
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
  /**
   * Controls interaction with an active streaming live turn:
   * - `"immediate"` (default): appends without freezing live text.
   * - `"passive"`: held until the live turn settles so passive events never split or shift an in-flight reply.
   * - `"freeze"`: freezes live text first so turn-ordered receipts stay in exact chronological position.
   */
  mode?: "immediate" | "passive" | "freeze";
}

/**
 * Append-only transcript container. Every committed turn, tool-output card, and receipt is immutable.
 */
export class ImmutableTranscript extends Container {
  readonly liveTail: LiveTurnTail;
  private readonly frozenContainer = new Container();
  private readonly heldPassiveReceipts: AppendReceiptOptions[] = [];
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

  /** Starts a new live assistant turn, resetting frozen-text tracking for the turn. */
  beginLiveTurn(modelLabel?: string): void {
    this.liveTail.begin(modelLabel);
  }

  /** Reseeds the live turn on reconnect, preserving already-frozen text when staying on the same turn. */
  resyncLiveTurn(opts: { modelLabel?: string; seedText?: string; preserveFrozen?: boolean }): void {
    this.liveTail.reseed(opts.seedText ?? "", opts.modelLabel, opts.preserveFrozen ?? false);
  }

  /**
   * Freezes any streamed live text into an immutable AssistantCard before appending a mid-turn card or steer,
   * preserving exact chronological order and avoiding scrollback wipes.
   */
  freezeLiveText(fallbackTimestampMs?: number | null): boolean {
    if (!this.liveTail.isActive) return false;
    const { text, modelLabel, timestampMs } = this.liveTail.takeText();
    if (!text.trim()) return false;
    this.appendAssistantTurn(text, modelLabel || undefined, timestampMs ?? fallbackTimestampMs);
    return true;
  }

  /**
   * Settles the active live turn using the daemon's final reply text.
   * Appends only the portion not already frozen during this turn (finalText minus the already-frozen prefix,
   * or only what remains in the live tail when finalText does not begin with the frozen prefix).
   */
  settleLiveTurn(opts?: {
    finalText?: string;
    modelLabel?: string;
    timestampMs?: number | null;
    discardLiveText?: boolean;
    flushHeld?: boolean;
  }): { tools: LiveToolPill[]; appendedText: string; textTimestampMs: number | null } {
    const snap = this.liveTail.snapshot();
    let toAppend = "";
    if (!opts?.discardLiveText) {
      if (snap.frozenSegmentCount === 0) {
        toAppend = opts?.finalText ?? snap.text;
      } else if (typeof opts?.finalText === "string") {
        const stripped = stripFrozenPrefix(opts.finalText, snap.frozenText);
        toAppend = stripped.matched ? stripped.remainder : snap.text;
      } else {
        toAppend = snap.text;
      }
    }

    this.liveTail.clear();

    const assistantTs = snap.textTimestampMs ?? opts?.timestampMs;
    if (toAppend.trim()) {
      this.appendAssistantTurn(toAppend, snap.modelLabel ?? opts?.modelLabel, assistantTs);
    }

    if (opts?.flushHeld !== false) {
      this.flushHeldReceipts();
    }

    return {
      tools: snap.tools,
      appendedText: toAppend,
      textTimestampMs: snap.textTimestampMs,
    };
  }

  /** Flushes passive receipts that were held while an assistant turn was streaming. */
  flushHeldReceipts(): void {
    if (this.heldPassiveReceipts.length === 0) return;
    for (const receipt of this.heldPassiveReceipts.splice(0)) {
      this.appendReceiptBlock(receipt);
    }
  }

  /**
   * Immutable structured Tool-Output Card (`goals_table`, `goal_detail`, `run_activity`).
   * Identical layout both live (from `chat.tool`) and replayed (from `turn.role === "tool_output"`).
   */
  appendToolOutput(display: ToolDisplayPayload, timestampMs?: number | null): void {
    this.freezeLiveText(timestampMs);
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

  private appendReceiptBlock(opts: AppendReceiptOptions): void {
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

  /**
   * Appends a single-line immutable receipt for an event, tool summary, or entity notification.
   * Never mutates later; users open full details in the Inspector via `Ctrl+X` or `Ctrl+G`.
   */
  appendReceipt(opts: AppendReceiptOptions): void {
    if (opts.mode === "passive" && this.liveTail.isActive) {
      this.heldPassiveReceipts.push({ ...opts });
      return;
    }
    if (opts.mode === "freeze") {
      this.freezeLiveText(opts.timestampMs);
    }
    this.appendReceiptBlock(opts);
  }

  clearAll(): void {
    this.frozenContainer.clear();
    this.liveTail.clear();
    this.heldPassiveReceipts.length = 0;
    this.lastTimestampMs = null;
  }
}

export interface AttentionSlot {
  slot: number;
  label: string;
  status: string;
  badge?: string;
  ref: EntityRef;
}

export interface AgentStateCounts {
  /** Tasks in `running` | `draining` | `merging`. */
  active: number;
  /** Tasks in `waiting_children`. */
  waiting: number;
  /** Tasks in `blocked` | `returned_for_rescope`. */
  blocked: number;
  /** Tasks in `paused_quota` (plus any quota-paused runs without a `paused_quota` task). */
  paused: number;
  /** Tasks in `pending` | `ready`. */
  queued: number;
  /** Tasks in `failed` on live/non-terminal runs. */
  failed: number;
  /** Open escalations needing attention. */
  openEscalations: number;
  /** Pending/active/conflicted merges (`queued` | `running` | `conflict` | `ci_failed`). */
  activeMerges: number;
  /** Conflicted or CI-failed merges (used to highlight merges in danger tone). */
  bouncedMerges?: number;
}

export interface LiveHudItem {
  /** Quick-jump Alt+1..5 slot index when mapped in `slots`. */
  slot?: number;
  kind: "escalation" | "goal" | "run" | "task";
  id: string;
  status: string;
  title: string;
  badge?: string;
  /** Live description of what is happening right now. */
  activity?: string;
  ref: EntityRef;
}

export interface DockState {
  /** Numbered active goal / blocking escalation slots for Alt+1..5 quick-jump. */
  slots: AttentionSlot[];
  idleBanner: string;
  /** Live counts of agents across states + escalations/merges (defaults to all zeros). */
  agentCounts?: AgentStateCounts;
  /** Live goals / escalations / runs shown in the always-visible compact HUD rows. */
  hudItems?: LiveHudItem[];
  /** Optional secondary detail line for HUD row 2 when a single item is active (e.g. live worker activity). */
  hudSecondaryLine?: string | null;
  /** Total active/in-flight goals count. */
  activeGoalsCount?: number;
  /** Status row: left phase/action + spinner; right model/quota/queue summary. */
  busy: boolean;
  phaseText: string;
  /** Non-null when attached to a remote host — renders a prominent `[REMOTE: <host>]` badge on the status bar. */
  remoteHost?: string | null;
  /** Optional transient Ctrl+C or double-Esc confirmation hint shown in status row without changing height. */
  transientHint?: string | null;
  rightStatus: string;
  queuedCount: number;
  /** Pinned pending/sending user messages rendered directly above the composer. */
  queuedItems?: readonly ChatQueueItem[];
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
 *   Row 2-3: Compact Live Goals & Activity HUD with `Alt+1`..`Alt+5` badges (always 2 rows; 1 row on ultra-short <18-row terminals)
 *   Row 4: Live Agent State Counts strip (active / waiting / blocked / paused / queued + esc / merges, always 1 row)
 *   Row 5: Unified Status / Spinner / Model / Queue bar with `statusBg` fill (always 1 row)
 *   Row 6+: Composer (`UndoableEditor` with `paddingX: 2` & `› ` prompt cue)
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
    this.lastRenderedHeight = this.hudRowCount() + 7;
  }

  update(patch: Partial<DockState>): void {
    this.state = { ...this.state, ...patch };
  }

  tickSpinner(): boolean {
    if (!this.state.busy) return false;
    this.spinnerIdx = (this.spinnerIdx + 1) % SPINNER_FRAMES.length;
    return true;
  }

  get slots(): readonly AttentionSlot[] {
    return this.state.slots;
  }

  handleInput(data: string): void {
    this.editor.handleInput(data);
  }

  /** Constant HUD row count for a given terminal height (never varies with goal/agent count). */
  private hudRowCount(): number {
    const rows = this.tuiRef.terminal?.rows ?? 30;
    return rows < 18 ? 1 : 2;
  }

  private effectiveHudItems(): LiveHudItem[] {
    if (this.state.hudItems !== undefined) return this.state.hudItems;
    return this.state.slots.map((s) => ({
      slot: s.slot,
      kind: s.ref.kind === "escalation" ? "escalation" : s.ref.kind === "run" ? "run" : "goal",
      id: s.label,
      status: s.status,
      title: "",
      badge: s.badge,
      activity: "",
      ref: s.ref,
    }));
  }

  private renderHudItemRow(item: LiveHudItem, width: number, rightTag = ""): string {
    const t = this.theme;
    const g = t.glyphs;
    const tone = statusTone(item.status);
    const glyph = statusGlyph(item.status, g);
    const slotTag =
      item.slot != null ? `${t.dim(`[${item.slot === 1 ? `Alt+${item.slot}` : String(item.slot)}]`)} ` : "";
    const idPart = t.paint(tone, `${glyph} ${sanitizeLine(item.id)}`);
    const cleanTitle = sanitizeLine(item.title);
    const cleanActivity = sanitizeLine(item.activity ?? "");
    const titleMax = cleanActivity
      ? width < 68
        ? 12
        : width < 96
          ? 18
          : 26
      : width < 68
        ? 24
        : width < 96
          ? 38
          : 56;
    const titlePart = cleanTitle ? ` ${t.bold(clamp(cleanTitle, titleMax))}` : "";
    const badgePart = item.badge ? ` ${t.paint(tone, `[${sanitizeLine(item.badge)}]`)}` : "";
    let actPart = "";
    if (cleanActivity) {
      const stLower = item.status.toLowerCase();
      const actTone: Tone =
        stLower === "p0" || stLower === "failed"
          ? "danger"
          : stLower === "blocked" || stLower === "awaiting_human" || stLower === "paused" || stLower === "paused_quota"
            ? "warn"
            : "muted";
      actPart = ` ${t.dim(g.sep)} ${t.paint(actTone, cleanActivity)}`;
    }
    const left = ` ${slotTag}${idPart}${titlePart}${badgePart}${actPart}`;
    return rightTag ? splitRow(left, rightTag, width) : fit(left, width);
  }

  private renderHudRows(width: number, rowCount: number): string[] {
    const t = this.theme;
    const g = t.glyphs;
    const items = this.effectiveHudItems();

    if (items.length === 0) {
      const row0 = fit(t.muted(` ${sanitizeLine(this.state.idleBanner)}`), width);
      if (rowCount <= 1) return [row0];
      const left1 = ` ${t.dim("Goals:")} ${t.dim(`no active goals ${g.sep} idle`)}`;
      const right1 = width >= 60 ? `${t.dim(`/goals ${g.sep} Ctrl+G`)} ` : "";
      const row1 = right1 ? splitRow(left1, right1, width) : fit(left1, width);
      return [row0, row1];
    }

    if (items.length === 1) {
      const row0 = this.renderHudItemRow(items[0]!, width);
      if (rowCount <= 1) return [row0];
      const secondary = sanitizeLine(this.state.hudSecondaryLine ?? "");
      if (secondary) {
        const right1 = width >= 88 ? `${t.dim("/goals")} ` : "";
        const left1 = `  ${t.dim(g.branchEnd)} ${t.muted(secondary)}`;
        const row1 = right1 && visibleWidth(left1) + 2 + visibleWidth(right1) <= width
          ? splitRow(left1, right1, width)
          : fit(left1, width);
        return [row0, row1];
      }
      const left1 = `  ${t.dim(g.branchEnd)} ${t.dim(sanitizeLine(this.state.idleBanner))}`;
      const right1 = width >= 72 ? `${t.dim(`/goals ${g.sep} Ctrl+G`)} ` : "";
      const row1 = right1 ? splitRow(left1, right1, width) : fit(left1, width);
      return [row0, row1];
    }

    const out: string[] = [];
    const shown = Math.min(rowCount, items.length);
    const hidden = Math.max(0, items.length - shown);
    for (let i = 0; i < shown; i++) {
      const isLast = i === shown - 1;
      const rightTag =
        isLast && hidden > 0
          ? width < 72
            ? `${t.muted(`+${hidden} (/goals)`)} `
            : `${t.muted(`+${hidden} more (/goals)`)} `
          : "";
      out.push(this.renderHudItemRow(items[i]!, width, rightTag));
    }
    return out;
  }

  private renderAgentCountsRow(width: number): string {
    const t = this.theme;
    const g = t.glyphs;
    const c: AgentStateCounts = this.state.agentCounts ?? {
      active: 0,
      waiting: 0,
      blocked: 0,
      paused: 0,
      queued: 0,
      failed: 0,
      openEscalations: 0,
      activeMerges: 0,
      bouncedMerges: 0,
    };
    const sep = t.dim(` ${g.sep} `);
    const mergeGlyph = g.ascii ? "M" : "⇄";
    const activeGoals = this.state.activeGoalsCount ?? 0;

    const totalSignal =
      c.active + c.waiting + c.blocked + c.paused + c.queued + c.failed + c.openEscalations + c.activeMerges;

    if (totalSignal === 0) {
      const left = ` ${t.muted("Agents:")} ${t.dim(`0 active ${g.sep} idle`)}`;
      const right =
        activeGoals > 0
          ? `${t.accent(`${activeGoals} active ${activeGoals === 1 ? "goal" : "goals"}`)} `
          : `${t.dim("Ctrl+T Runs")} `;
      return visibleWidth(left) + 2 + visibleWidth(right) <= width
        ? splitRow(left, right, width)
        : fit(left, width);
    }

    const buildLine = (mode: "full" | "compact" | "micro"): string => {
      const parts: string[] = [];
      if (mode === "full") {
        if (c.active > 0) parts.push(t.ok(`${g.running} ${c.active} active`));
        if (c.waiting > 0) parts.push(t.warn(`${g.pending} ${c.waiting} waiting`));
        if (c.blocked > 0) parts.push(t.danger(`${g.warn} ${c.blocked} blocked`));
        if (c.paused > 0) parts.push(t.warn(`${g.pause} ${c.paused} paused`));
        if (c.queued > 0) parts.push(t.warn(`${c.queued} queued`));
        if (c.failed > 0) parts.push(t.danger(`${g.cross} ${c.failed} failed`));
        if (c.openEscalations > 0) parts.push(t.danger(`${g.warn} ${c.openEscalations} esc`));
        if (c.activeMerges > 0) {
          const mTone: Tone = (c.bouncedMerges ?? 0) > 0 ? "danger" : "info";
          parts.push(t.paint(mTone, `${mergeGlyph} ${c.activeMerges} ${c.activeMerges === 1 ? "merge" : "merges"}`));
        }
        return ` ${t.muted("Agents:")} ${parts.join(sep)}`;
      }
      if (mode === "compact") {
        if (c.active > 0) parts.push(t.ok(`${g.running} ${c.active} act`));
        if (c.waiting > 0) parts.push(t.warn(`${c.waiting} wait`));
        if (c.blocked > 0) parts.push(t.danger(`${g.warn} ${c.blocked} blk`));
        if (c.paused > 0) parts.push(t.warn(`${g.pause} ${c.paused} psd`));
        if (c.queued > 0) parts.push(t.warn(`${c.queued} q`));
        if (c.failed > 0) parts.push(t.danger(`${c.failed} fail`));
        if (c.openEscalations > 0) parts.push(t.danger(`${g.warn} ${c.openEscalations} esc`));
        if (c.activeMerges > 0) {
          const mTone: Tone = (c.bouncedMerges ?? 0) > 0 ? "danger" : "info";
          parts.push(t.paint(mTone, `${mergeGlyph} ${c.activeMerges}m`));
        }
        return ` ${t.muted("Agents:")} ${parts.join(sep)}`;
      }
      if (c.active > 0) parts.push(t.ok(`${c.active}a`));
      if (c.waiting > 0) parts.push(t.warn(`${c.waiting}w`));
      if (c.blocked > 0) parts.push(t.danger(`${c.blocked}b`));
      if (c.paused > 0) parts.push(t.warn(`${c.paused}p`));
      if (c.queued > 0) parts.push(t.warn(`${c.queued}q`));
      if (c.failed > 0) parts.push(t.danger(`${c.failed}f`));
      if (c.openEscalations > 0) parts.push(t.danger(`!${c.openEscalations}`));
      if (c.activeMerges > 0) {
        const mTone: Tone = (c.bouncedMerges ?? 0) > 0 ? "danger" : "info";
        parts.push(t.paint(mTone, `${mergeGlyph}${c.activeMerges}`));
      }
      return ` ${t.muted("Agents:")} ${parts.join(t.dim(g.sep))}`;
    };

    const full = buildLine("full");
    const chosen =
      visibleWidth(full) <= width
        ? full
        : (() => {
            const compact = buildLine("compact");
            return visibleWidth(compact) <= width ? compact : buildLine("micro");
          })();

    const right =
      activeGoals > 0
        ? `${t.accent(`${activeGoals} ${activeGoals === 1 ? "goal" : "goals"}`)} `
        : "";
    if (right && visibleWidth(chosen) + 2 + visibleWidth(right) <= width) {
      return splitRow(chosen, right, width);
    }
    return fit(chosen, width);
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

  private queueStripCap(): number {
    const rows = this.tuiRef.terminal?.rows ?? 30;
    if (rows < 18) return 1;
    if (rows < 24) return 3;
    return 5;
  }

  private renderQueueStripRows(width: number): string[] {
    const items = this.state.queuedItems;
    if (!items || items.length === 0) return [];
    const t = this.theme;
    const g = t.glyphs;
    const cap = this.queueStripCap();
    const shown = items.slice(0, cap);
    const hidden = Math.max(0, items.length - shown.length);
    const keyHint = width >= 72 ? `${t.dim("Ctrl+R edit · Alt+Q drop")} ` : width >= 48 ? `${t.dim("Ctrl+R · Alt+Q")} ` : "";
    const out: string[] = [];

    for (let i = 0; i < shown.length; i += 1) {
      const item = shown[i]!;
      const glyph = item.state === "sending" ? g.running : g.ascii ? "~" : "⧗";
      const tone: Tone = item.state === "sending" ? "accent" : "warn";
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
      const left = `  ${t.muted(`+${hidden} more queued`)}`;
      const right = keyHint || `${t.dim("/drop")} `;
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
    const hudRows = this.renderHudRows(w, this.hudRowCount());
    const queueRows = this.renderQueueStripRows(w);
    const lines: string[] = [
      this.theme.border(this.theme.glyphs.barH.repeat(w)),
      ...hudRows,
      this.renderAgentCountsRow(w),
      this.renderStatusRow(w),
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
