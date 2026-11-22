import {
  type AutocompleteProvider,
  type Component,
  Container,
  Editor,
  Markdown,
  matchesKey,
  type TUI,
} from "@earendil-works/pi-tui";
import { renderToolOutput, type ToolDisplayPayload } from "../tool-output/index.js";
import { type EntityRef, type Hint, renderHintBar } from "./keymap.js";
import { clamp, fillLineBg, fit, sanitizeLine, sanitizeText, splitRow, visibleWidth, wrap } from "./text.js";
import { statusGlyph, statusTone, type Theme, type Tone } from "./tokens.js";

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

  constructor(private readonly theme: Theme) {}

  begin(modelLabel?: string): void {
    this.active = true;
    this.text = "";
    this.thought = "";
    this.tools = [];
    this.modelLabel = modelLabel;
  }

  appendText(delta: string): void {
    this.active = true;
    this.text += delta;
  }

  appendThought(delta: string): void {
    this.active = true;
    this.thought += delta;
  }

  upsertTool(pill: LiveToolPill): void {
    this.active = true;
    const idx = this.tools.findIndex((t) => t.id === pill.id);
    if (idx >= 0) this.tools[idx] = pill;
    else this.tools.push(pill);
  }

  snapshot(): { text: string; thought: string; tools: LiveToolPill[]; modelLabel?: string } {
    return { text: this.text, thought: this.thought, tools: [...this.tools], modelLabel: this.modelLabel };
  }

  clear(): void {
    this.active = false;
    this.text = "";
    this.thought = "";
    this.tools = [];
    this.modelLabel = undefined;
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
      out.push("");
      if (this.modelLabel) {
        out.push(clamp(` ${this.theme.accent(g.diamond)} ${this.theme.muted(sanitizeLine(this.modelLabel))}`, w));
      }
      const md = new Markdown(sanitizeText(this.text).trim(), 1, 0, this.theme.toMarkdownTheme());
      out.push(...md.render(w).map((l) => clamp(l, w)));
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

    return out;
  }

  /** Consumes and returns accumulated live text (preserving active state/tools/model for continued streaming). */
  takeText(): { text: string; modelLabel: string } {
    const text = this.text;
    const modelLabel = this.modelLabel ?? "";
    this.text = "";
    this.thought = "";
    this.modelLabel = undefined;
    return { text, modelLabel };
  }

  invalidate(): void {}
}

/**
 * Append-only transcript container. Every committed turn, tool-output card, and receipt is immutable.
 */
export class ImmutableTranscript extends Container {
  readonly liveTail: LiveTurnTail;
  private readonly frozenContainer = new Container();

  constructor(private readonly theme: Theme) {
    super();
    this.liveTail = new LiveTurnTail(theme);
    this.addChild(this.frozenContainer);
    this.addChild(this.liveTail);
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
  appendUserTurn(text: string): void {
    const clean = sanitizeText(text).trim();
    if (!clean) return;
    const t = this.theme;
    const g = t.glyphs;
    this.frozenContainer.addChild(
      new FrozenBlock((w) => {
        const inner = Math.max(4, w - 5);
        const wrapped = wrap(clean, inner);
        const bar = t.accent(g.rail);
        const out: string[] = [""];
        for (let i = 0; i < wrapped.length; i++) {
          const prefix = i === 0 ? `${bar} ${t.accentBold(g.prompt)} ` : `${bar}   `;
          out.push(fillLineBg(`${prefix}${t.bold(wrapped[i]!)}`, w, t.userBg));
        }
        return out;
      }),
    );
  }

  /**
   * Immutable AssistantCard: optional `◆ <model>` attribution header + syntax-highlighted Markdown.
   */
  appendAssistantTurn(markdownText: string, meta?: string): void {
    const clean = sanitizeText(markdownText).trim();
    if (!clean) return;
    const t = this.theme;
    const g = t.glyphs;
    const mdTheme = t.toMarkdownTheme();
    const cleanMeta = meta ? sanitizeLine(meta) : "";
    this.frozenContainer.addChild(
      new FrozenBlock((w) => {
        const md = new Markdown(clean, 1, 0, mdTheme);
        const out: string[] = [""];
        if (cleanMeta) {
          out.push(clamp(` ${t.accent(g.diamond)} ${t.muted(cleanMeta)}`, w));
        }
        out.push(...md.render(w));
        return out;
      }),
    );
  }

  /**
   * Freezes any streamed live text into an immutable AssistantCard before appending a mid-turn card or receipt,
   * preserving exact chronological order and avoiding scrollback wipes.
   */
  freezeLiveText(): boolean {
    if (!this.liveTail.isActive) return false;
    const { text, modelLabel } = this.liveTail.takeText();
    if (!text.trim()) return false;
    this.appendAssistantTurn(text, modelLabel || undefined);
    return true;
  }

  /**
   * Immutable structured Tool-Output Card (`goals_table`, `goal_detail`, `run_activity`).
   * Identical layout both live (from `chat.tool`) and replayed (from `turn.role === "tool_output"`).
   */
  appendToolOutput(display: ToolDisplayPayload): void {
    this.freezeLiveText();
    const t = this.theme;
    this.frozenContainer.addChild(
      new FrozenBlock((w) => ["", ...renderToolOutput(display, w, t)]),
    );
  }

  /** Compact dim note for a persisted `tool_output` turn lacking a valid structured display. */
  appendToolOutputNote(text: string): void {
    const clean = sanitizeLine(text) || "tool output";
    const t = this.theme;
    this.frozenContainer.addChild(
      new FrozenBlock((w) => [clamp(`  ${t.ok(t.glyphs.check)} ${t.muted(clean)}`, w)]),
    );
  }

  /**
   * Appends a single-line immutable receipt for an event, tool summary, or entity notification.
   * Never mutates later; users open full details in the Inspector via `Ctrl+X` or `Ctrl+G`.
   */
  appendReceipt(opts: {
    glyph?: string;
    tone?: Tone;
    tag?: string;
    text: string;
    ref?: EntityRef;
  }): void {
    this.freezeLiveText();
    const t = this.theme;
    const glyph = opts.glyph ?? t.glyphs.bullet;
    const tone = opts.tone ?? "muted";
    const cleanText = sanitizeLine(opts.text);
    const tagPart = opts.tag ? `${t.paint(tone, `[${sanitizeLine(opts.tag)}]`)} ` : "";
    const inspectHint = opts.ref ? t.dim("  (Ctrl+X inspect)") : "";
    this.frozenContainer.addChild(
      new FrozenBlock((w) => {
        const left = `  ${t.paint(tone, glyph)} ${tagPart}${cleanText}`;
        return [splitRow(left, inspectHint, w)];
      }),
    );
  }

  clearAll(): void {
    this.frozenContainer.clear();
    this.liveTail.clear();
  }
}

export interface AttentionSlot {
  slot: number;
  label: string;
  status: string;
  badge?: string;
  ref: EntityRef;
}

export interface DockState {
  /** Numbered active goal / blocking escalation slots for row 1 (always rendered on 1 line). */
  slots: AttentionSlot[];
  idleBanner: string;
  /** Row 2: left phase/action + spinner; right model/quota/queue summary. */
  busy: boolean;
  phaseText: string;
  /** Optional transient Ctrl+C or double-Esc confirmation hint shown in status row without changing height. */
  transientHint?: string | null;
  rightStatus: string;
  queuedCount: number;
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
 *   Row 2: Attention / Active Goals strip with `Alt+1`..`Alt+5` badges (always 1 row)
 *   Row 3: Unified Status / Spinner / Model / Quota / Queue bar with `statusBg` fill (always 1 row)
 *   Row 4+: Composer (`UndoableEditor` with `paddingX: 2` & `› ` prompt cue)
 *   Last Row: Keybinding HintBar (always 1 row)
 */
export class FixedDock implements Component {
  readonly editor: UndoableEditor;
  private state: DockState;
  private spinnerIdx = 0;

  constructor(
    tui: Component & { requestRender: () => void },
    private readonly theme: Theme,
    opts: {
      autocomplete?: AutocompleteProvider;
      onSubmit: (text: string) => void;
      initialState: DockState;
    },
  ) {
    this.state = opts.initialState;
    this.editor = new UndoableEditor(tui as unknown as TUI, theme);
    if (opts.autocomplete) this.editor.setAutocompleteProvider(opts.autocomplete);
    this.editor.onSubmit = (raw) => {
      this.editor.clearUndoHistory();
      opts.onSubmit(raw);
    };
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

  private renderAttentionRow(width: number): string {
    const t = this.theme;
    const g = t.glyphs;
    const slots = this.state.slots;
    if (slots.length === 0) {
      return fit(t.muted(` ${this.state.idleBanner}`), width);
    }
    const sep = t.muted(` ${g.sep} `);
    const sepW = visibleWidth(sep);
    const pieces: string[] = [];
    let used = 1;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      const tone = statusTone(s.status);
      const glyph = statusGlyph(s.status, g);
      const extra = s.badge ? ` ${t.paint(tone, s.badge)}` : "";
      const keyTag = i === 0 ? `Alt+${s.slot}` : `${s.slot}`;
      const item = `${t.dim(`[${keyTag}]`)} ${t.paint(tone, `${glyph} ${sanitizeLine(s.label)}`)}${extra}`;
      const pw = visibleWidth(item);
      if (pieces.length > 0 && used + sepW + pw > width - 3) {
        pieces.push(t.muted(`+${slots.length - pieces.length}`));
        break;
      }
      pieces.push(item);
      used += (pieces.length > 1 ? sepW : 0) + pw;
    }
    return fit(` ${pieces.join(sep)}`, width);
  }

  private renderStatusRow(width: number): string {
    const t = this.theme;
    const g = t.glyphs;
    if (this.state.transientHint) {
      const left = ` ${t.warn(g.warn)} ${t.warn(sanitizeLine(this.state.transientHint))}`;
      const right = this.state.rightStatus ? `${t.muted(this.state.rightStatus)} ` : "";
      return fillLineBg(splitRow(left, right, width), width, t.statusBg);
    }
    const spin = this.state.busy
      ? t.accentBold(SPINNER_FRAMES[this.spinnerIdx]!)
      : t.ok(g.check);
    const q = this.state.queuedCount > 0 ? `  ${t.warn(`+${this.state.queuedCount} queued`)}` : "";
    const left = ` ${spin} ${sanitizeLine(this.state.phaseText)}${q}`;
    const right = this.state.rightStatus ? `${t.muted(this.state.rightStatus)} ` : "";
    return fillLineBg(splitRow(left, right, width), width, t.statusBg);
  }

  private lastRenderedHeight = 7;

  /** Last rendered row count of the FixedDock (used to anchor floating slash-autocomplete above the dock). */
  get renderedHeight(): number {
    return this.lastRenderedHeight;
  }

  render(width: number): string[] {
    const w = Math.max(12, Math.floor(width));
    const lines: string[] = [
      this.theme.border(this.theme.glyphs.barH.repeat(w)),
      this.renderAttentionRow(w),
      this.renderStatusRow(w),
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
