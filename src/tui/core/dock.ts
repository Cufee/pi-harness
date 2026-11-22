import {
  type AutocompleteProvider,
  type Component,
  Container,
  Editor,
  Markdown,
  matchesKey,
} from "@earendil-works/pi-tui";
import { type EntityRef, type Hint, renderHintBar } from "./keymap.js";
import { clamp, fit, sanitizeLine, sanitizeText, splitRow, visibleWidth, wrap } from "./text.js";
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

  constructor(private readonly theme: Theme) {}

  begin(): void {
    this.active = true;
    this.text = "";
    this.thought = "";
    this.tools = [];
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

  snapshot(): { text: string; thought: string; tools: LiveToolPill[] } {
    return { text: this.text, thought: this.thought, tools: [...this.tools] };
  }

  clear(): void {
    this.active = false;
    this.text = "";
    this.thought = "";
    this.tools = [];
  }

  get isActive(): boolean {
    return this.active;
  }

  render(width: number): string[] {
    if (!this.active) return [];
    const w = Math.max(8, Math.floor(width));
    const out: string[] = [];
    const g = this.theme.glyphs;

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

    if (this.thought.trim() && !this.text.trim()) {
      const last = sanitizeLine(this.thought.trim().split("\n").slice(-1)[0] ?? "");
      if (last) {
        out.push(clamp(this.theme.dim(`  … ${last}`), w));
      }
    }

    if (this.text.trim()) {
      const md = new Markdown(sanitizeText(this.text), 1, 0, this.theme.toMarkdownTheme());
      out.push(...md.render(w).map((l) => clamp(l, w)));
    }

    return out;
  }

  invalidate(): void {}
}

/**
 * Append-only transcript container. Every committed turn/receipt is immutable.
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

  appendUserTurn(text: string): void {
    const clean = sanitizeText(text).trim();
    if (!clean) return;
    const t = this.theme;
    this.frozenContainer.addChild(
      new FrozenBlock((w) => {
        const prefix = `${t.accentBold(t.glyphs.prompt)} `;
        const wrapped = wrap(clean, Math.max(4, w - 2));
        return ["", ...wrapped.map((line, i) => (i === 0 ? `${prefix}${t.bold(line)}` : `  ${t.bold(line)}`))];
      }),
    );
  }

  appendAssistantTurn(markdownText: string): void {
    const clean = sanitizeText(markdownText).trim();
    if (!clean) return;
    const mdTheme = this.theme.toMarkdownTheme();
    this.frozenContainer.addChild(
      new FrozenBlock((w) => {
        const md = new Markdown(clean, 1, 0, mdTheme);
        return ["", ...md.render(w)];
      }),
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
    const t = this.theme;
    const glyph = opts.glyph ?? t.glyphs.bullet;
    const tone = opts.tone ?? "muted";
    const cleanText = sanitizeLine(opts.text);
    const tagPart = opts.tag ? `${t.paint(tone, `[${sanitizeLine(opts.tag)}]`)} ` : "";
    const inspectHint = opts.ref ? t.muted("  (Ctrl+X inspect)") : "";
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
  rightStatus: string;
  queuedCount: number;
  /** Bottom hint strip (always 1 line). */
  hints: Hint[];
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Constant-height bottom dock!
 * Eliminates the 0..6 row height oscillation that caused viewport jumps in v1:
 *   Row 1: Attention / Active Goals strip (always 1 row)
 *   Row 2: Unified Status / Spinner / Model / Quota / Queue bar (always 1 row)
 *   Row 3+: Composer (`Editor`, steady border height; grows only while user types multiline)
 *   Last Row: Keybinding HintBar (always 1 row)
 */
export class FixedDock implements Component {
  readonly editor: Editor;
  private state: DockState;
  private spinnerIdx = 0;
  private undoStack: string[] = [];
  private lastUndoValue = "";

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
    this.editor = new Editor(tui as never, theme.toEditorTheme(), { paddingX: 1 });
    if (opts.autocomplete) this.editor.setAutocompleteProvider(opts.autocomplete);
    this.editor.onSubmit = (raw) => {
      this.undoStack = [];
      this.lastUndoValue = "";
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
    // Undo shortcut (`Ctrl+Z` / `Ctrl+-`) matching v1 composer ergonomics
    if (matchesKey(data, "ctrl+z") || matchesKey(data, "ctrl+-")) {
      const prev = this.undoStack.pop();
      if (prev !== undefined) {
        this.editor.setText(prev);
        this.lastUndoValue = prev;
      }
      return;
    }
    const before = this.editor.getText();
    this.editor.handleInput(data);
    const after = this.editor.getText();
    if (after !== before && before !== this.lastUndoValue) {
      this.undoStack.push(before);
      if (this.undoStack.length > 40) this.undoStack.shift();
      this.lastUndoValue = before;
    }
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
    for (const s of slots) {
      const tone = statusTone(s.status);
      const glyph = statusGlyph(s.status, g);
      const extra = s.badge ? ` ${t.paint(tone, s.badge)}` : "";
      const item = `${t.muted(`[${s.slot}]`)} ${t.paint(tone, `${glyph} ${sanitizeLine(s.label)}`)}${extra}`;
      const pw = visibleWidth(item);
      if (pieces.length > 0 && used + sepW + pw > width - 2) {
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
    const spin = this.state.busy
      ? t.accentBold(SPINNER_FRAMES[this.spinnerIdx]!)
      : t.ok(t.glyphs.check);
    const q = this.state.queuedCount > 0 ? `  ${t.warn(`+${this.state.queuedCount} queued`)}` : "";
    const left = ` ${spin} ${sanitizeLine(this.state.phaseText)}${q}`;
    const right = this.state.rightStatus ? `${this.state.rightStatus} ` : "";
    return splitRow(left, right, width);
  }

  render(width: number): string[] {
    const w = Math.max(12, Math.floor(width));
    const lines: string[] = [
      this.renderAttentionRow(w),
      this.renderStatusRow(w),
      ...this.editor.render(w).map((l) => clamp(l, w)),
      fit(` ${renderHintBar(this.state.hints, Math.max(1, w - 2), this.theme)}`, w),
    ];
    return lines;
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}
