import {
  type Component,
  isKeyRelease,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
import { beginFrameCapture, endFrameCapture, type Frame, type FrameTextRegion } from "./frame.js";
import { yankText } from "./keymap.js";
import {
  type CellPoint,
  extractSelectionText,
  highlightCells,
  normalizeSelection,
  rowSelectionCols,
} from "./selection.js";
import { fillLineBg, sliceByColumn, stripTerminalSequences } from "./text.js";
import type { Theme } from "./tokens.js";
import { DISABLE_MOUSE_SEQ, ENABLE_MOUSE_SEQ, parseMouseEvents, type ScreenMouseEvent } from "./viewport.js";

const FAINT = "\x1b[2m";
const RESET = "\x1b[0m";
const SGR_RX = /\x1b\[([0-9;]*)m/g;

/**
 * Applies dim styling across a line while re-applying FAINT after standalone (`\x1b[0m`, `\x1b[m`,
 * `\x1b[22m`) and compound (`\x1b[0;32m`, `\x1b[22;39m`) SGR resets so dimmed backdrops stay dimmed.
 * Leaves inline terminal image escape sequences untouched.
 */
export function dimLine(line: string): string {
  if (!line || line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return line;
  const reapplied = line.replace(SGR_RX, (match, rawParams: string) => {
    const codes = rawParams.split(";");
    const resetsFaint = codes.some((c) => c === "" || c === "0" || c === "22");
    return resetsFaint ? `${match}${FAINT}` : match;
  });
  return `${FAINT}${reapplied}${RESET}`;
}

/**
 * Main-screen TUI wrapper.
 * - Deliberately NEVER enables terminal mouse tracking on the main screen so native terminal
 *   scrollback and mouse-drag selection work seamlessly.
 * - Mouse wheel capture is scoped strictly to open overlays via `Navigator`.
 * - Overrides `compositeOverlays` to dim the visible viewport beneath open modals while leaving
 *   scrollback above the viewport untouched.
 */
export type FloatingPopupProvider = (
  width: number,
  baseLineCount: number,
  termHeight: number,
) => { lines: string[]; bottomOffset: number } | null;

export class ModalScreen extends TuiMainScreen {
  private floatingPopupProvider: FloatingPopupProvider | null = null;
  private readonly hostTerminal: Terminal;

  constructor(terminal: Terminal) {
    super(terminal);
    this.hostTerminal = terminal;
  }

  /** Registers an optional non-focus-stealing popup (e.g. slash-command autocomplete floated above the dock). */
  setFloatingPopupProvider(provider: FloatingPopupProvider | null): void {
    this.floatingPopupProvider = provider;
  }

  override render(width: number): string[] {
    const lines = [...super.render(width)];
    if (!this.hasOverlay() && this.floatingPopupProvider) {
      const termHeight = Math.max(8, this.hostTerminal.rows || 30);
      const popup = this.floatingPopupProvider(width, lines.length, termHeight);
      if (popup && popup.lines.length > 0) {
        const prevTop = this.captureRenderState().previousViewportTop;
        const viewportStart = Math.max(0, lines.length - termHeight, prevTop);
        const maxAboveDock = Math.max(0, lines.length - popup.bottomOffset - viewportStart);
        if (maxAboveDock >= 2) {
          // Composite popup strictly inside visible rows above the dock so total line count never grows or shrinks!
          const clipped = popup.lines.slice(0, maxAboveDock);
          const startRow = lines.length - popup.bottomOffset - clipped.length;
          for (let i = 0; i < clipped.length; i++) {
            const idx = startRow + i;
            if (idx >= viewportStart && idx < lines.length) {
              lines[idx] = clipped[i]!;
            }
          }
        } else {
          // Brand-new short screen with room below: append inline without exceeding termHeight
          const roomBelow = Math.max(0, termHeight - lines.length);
          const clipped = popup.lines.slice(0, roomBelow);
          lines.push(...clipped);
        }
      }
    }
    return lines;
  }

  protected override getExitRestorePrefix(): string {
    return DISABLE_MOUSE_SEQ + super.getExitRestorePrefix();
  }

  /** Public helper used by `TerminalSession.stop()` to restore terminal state cleanly. */
  exitRestoreSequence(): string {
    return this.getExitRestorePrefix();
  }

  protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
    if (!this.hasOverlay()) return super.compositeOverlays(lines, termWidth, termHeight);
    const prevTop = this.captureRenderState().previousViewportTop;
    const minLen = prevTop + termHeight;
    const padded = lines.length < minLen ? [...lines, ...Array.from({ length: minLen - lines.length }, () => "")] : lines;
    const viewportStart = Math.max(0, padded.length - termHeight, prevTop);
    const dimmed = padded.map((line, i) => (i >= viewportStart ? dimLine(line) : line));
    return super.compositeOverlays(dimmed, termWidth, termHeight);
  }
}

export interface ScreenContext {
  navigator: Navigator;
  theme: Theme;
  requestRender: () => void;
  writeTerminal: (seq: string) => void;
}

export type OverlayMouseEvent = ScreenMouseEvent;

export interface Screen {
  readonly id?: string;
  readonly title: string;
  /** `"sheet"` = wide full-height inspector/navigator; `"dialog"` = compact centered picker. */
  readonly variant?: "sheet" | "dialog";
  render(width: number, maxHeight: number, theme: Theme): string[];
  handleInput(data: string, ctx: ScreenContext): void;
  /** Optional custom mouse handler. Return `false` to fall through to default overlay selection. */
  handleMouse?(ev: OverlayMouseEvent, ctx: ScreenContext): void | boolean;
  onShow?(ctx: ScreenContext): void;
  onClose?(): void;
}

/**
 * Standard "back / close" key check outside text inputs:
 * `Esc`, `q`, or `Backspace` when `ctx.navigator.depth > 1`.
 */
export function isPopKey(data: string, ctx: ScreenContext, opts?: { allowQ?: boolean }): boolean {
  if (matchesKey(data, "escape")) return true;
  if (opts?.allowQ !== false && data === "q") return true;
  if (ctx.navigator.depth > 1 && matchesKey(data, "backspace")) return true;
  return false;
}

interface SelectionRowSnapshot {
  row: number;
  lineIdx: number;
  rowWidth: number;
  plain: string;
}

interface SelectionSnapshot {
  frame: Frame;
  col: number;
  width: number;
  rows: SelectionRowSnapshot[];
}

interface OverlaySelectionState {
  anchor: CellPoint | null;
  head: CellPoint | null;
  dragging: boolean;
  moved: boolean;
  lines: string[];
  frame: Frame | null;
  width: number;
  termRows: number;
  termCols: number;
  snapshot: SelectionSnapshot | null;
}

function nearestTextRowIndex(rows: readonly number[], y: number): number {
  let bestIdx = 0;
  let bestDist = Math.abs(rows[0]! - y);
  for (let i = 1; i < rows.length; i++) {
    const dist = Math.abs(rows[i]! - y);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function selectableRowWidth(region: FrameTextRegion, lineIdx: number): number {
  const override = region.rowWidths?.get(lineIdx);
  return override !== undefined ? Math.max(1, Math.min(region.width, override)) : region.width;
}

function computeOverlayHeight(termRows: number, isDialog: boolean): number {
  const rows = Math.max(1, Math.floor(termRows || 30));
  const avail = Math.max(1, rows - 2);
  const desired = isDialog ? Math.min(26, Math.floor(rows * 0.78)) : Math.floor(rows * 0.88);
  return Math.min(avail, Math.max(6, desired));
}
export class Navigator {
  private stack: Screen[] = [];
  private handle: OverlayHandle | null = null;
  private mouseEnabled = false;
  private mouseGestureOwner: "custom" | "default" | null = null;
  private readonly hostComponent: Component;
  private readonly onChange?: () => void;
  private readonly overlaySel: OverlaySelectionState = {
    anchor: null,
    head: null,
    dragging: false,
    moved: false,
    lines: [],
    frame: null,
    width: 0,
    termRows: 0,
    termCols: 0,
    snapshot: null,
  };

  constructor(
    private readonly tui: ModalScreen,
    private readonly terminal: Terminal,
    private readonly theme: Theme,
    opts?: { onChange?: () => void },
  ) {
    this.onChange = opts?.onChange;
    this.hostComponent = {
      render: (width: number) => {
        const top = this.current;
        if (!top) return [];
        const termRows = this.terminal.rows || 30;
        const termCols = this.terminal.columns || width;
        if (
          (this.overlaySel.width !== 0 && this.overlaySel.width !== width) ||
          (this.overlaySel.termRows !== 0 && this.overlaySel.termRows !== termRows) ||
          (this.overlaySel.termCols !== 0 && this.overlaySel.termCols !== termCols)
        ) {
          this.clearOverlaySelection();
        }
        const maxH = computeOverlayHeight(termRows, top.variant === "dialog");
        beginFrameCapture();
        let rawLines: string[];
        let capturedFrame: Frame | null = null;
        try {
          rawLines = top.render(width, maxH, this.theme);
        } finally {
          capturedFrame = endFrameCapture();
        }
        if (this.overlaySel.anchor !== null && !this.matchesSelectionSnapshot(capturedFrame, rawLines)) {
          this.clearOverlaySelection();
        }
        this.overlaySel.lines = rawLines;
        this.overlaySel.frame = capturedFrame;
        this.overlaySel.width = width;
        this.overlaySel.termRows = termRows;
        this.overlaySel.termCols = termCols;

        if (!this.hasActiveSelection || !this.theme.color) {
          return rawLines;
        }
        const region = capturedFrame?.textRegion;
        if (!region || region.rows.length === 0 || region.width <= 0) {
          return rawLines;
        }
        const visibleRows = region.rows.filter((r) => r >= 0 && r < rawLines.length);
        const sel = normalizeSelection("cell", this.overlaySel.anchor!, this.overlaySel.head!);
        if (sel.startRow >= visibleRows.length) {
          return rawLines;
        }
        const out = [...rawLines];
        const lastRow = Math.min(sel.endRow, visibleRows.length - 1);
        for (let r = sel.startRow; r <= lastRow; r++) {
          const lineIdx = visibleRows[r]!;
          const line = out[lineIdx]!;
          const rowW = selectableRowWidth(region, lineIdx);
          const inner = sliceByColumn(line, region.col, rowW, true);
          const { c0, c1 } = rowSelectionCols(inner, r, sel, region.width);
          if (c0 >= rowW) continue;
          const hc1 = Math.min(c1, rowW - 1);
          const highlighted = highlightCells(line, region.col + c0, region.col + hc1, width, this.theme.badgeBg);
          out[lineIdx] = fillLineBg(highlighted, width, this.theme.surfaceBg);
        }
        return out;
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (isKeyRelease(data)) return;
        const top = this.current;
        if (!top) return;
        if (!data.includes("\x1b[200~")) {
          const mouseEvents = parseMouseEvents(data);
          if (mouseEvents.length > 0) {
            const bounds = this.handle?.getBounds();
            const ctx = this.makeContext();
            let hasUnhandledWheel = false;
            let needsRender = false;
            for (const ev of mouseEvents) {
              const localEv = bounds ? { ...ev, x: ev.x - bounds.col, y: ev.y - bounds.row } : null;
              if (ev.type === "wheel") {
                if (top.handleMouse) {
                  if (!localEv) return;
                  const res = top.handleMouse(localEv, ctx);
                  if (res !== false) {
                    if (this.hasActiveSelection) this.clearOverlaySelection();
                    needsRender = true;
                    continue;
                  }
                }
                if (this.hasActiveSelection) {
                  this.clearOverlaySelection();
                  needsRender = true;
                }
                hasUnhandledWheel = true;
                continue;
              }

              if (!localEv || !bounds) return;

              if (ev.type === "press") {
                this.mouseGestureOwner = null;
                if (top.handleMouse) {
                  const res = top.handleMouse(localEv, ctx);
                  if (res !== false) {
                    this.mouseGestureOwner = "custom";
                    if (this.hasActiveSelection || this.overlaySel.dragging) this.clearOverlaySelection();
                    needsRender = true;
                    continue;
                  }
                }
                this.mouseGestureOwner = "default";
                if (this.handleDefaultMouse(localEv, ctx, bounds)) {
                  needsRender = true;
                }
                continue;
              }

              const owner = this.mouseGestureOwner;
              if (ev.type === "release") {
                this.mouseGestureOwner = null;
              }

              if (owner === "default" || !top.handleMouse) {
                if (this.handleDefaultMouse(localEv, ctx, bounds)) {
                  needsRender = true;
                }
                continue;
              }

              const res = top.handleMouse(localEv, ctx);
              if (res !== false) {
                if (this.hasActiveSelection) this.clearOverlaySelection();
                needsRender = true;
                continue;
              }
              if (owner !== "custom" && this.handleDefaultMouse(localEv, ctx, bounds)) {
                needsRender = true;
              }
            }
            if (hasUnhandledWheel) {
              top.handleInput(data, ctx);
              if (needsRender) this.requestRender();
              return;
            }
            if (needsRender) {
              this.requestRender();
            }
            return;
          }
        }
        this.mouseGestureOwner = null;
        if (this.hasActiveSelection) {
          this.clearOverlaySelection();
          if (matchesKey(data, "escape")) {
            this.requestRender();
            return;
          }
          this.requestRender();
        } else if (this.overlaySel.dragging) {
          this.clearOverlaySelection();
        }
        top.handleInput(data, this.makeContext());
      },
    };
  }

  private get hasActiveSelection(): boolean {
    return this.overlaySel.moved && this.overlaySel.anchor !== null && this.overlaySel.head !== null;
  }

  private clearOverlaySelection(clearCache = false): void {
    this.overlaySel.anchor = null;
    this.overlaySel.head = null;
    this.overlaySel.dragging = false;
    this.overlaySel.moved = false;
    this.overlaySel.snapshot = null;
    if (clearCache) {
      this.mouseGestureOwner = null;
      this.overlaySel.lines = [];
      this.overlaySel.frame = null;
      this.overlaySel.width = 0;
      this.overlaySel.termRows = 0;
      this.overlaySel.termCols = 0;
    }
  }

  private captureSelectionSnapshot(frame: Frame, region: FrameTextRegion, visibleRows: readonly number[]): void {
    if (!this.overlaySel.anchor || !this.overlaySel.head) {
      this.overlaySel.snapshot = null;
      return;
    }
    const sel = normalizeSelection("cell", this.overlaySel.anchor, this.overlaySel.head);
    const lines = this.overlaySel.lines;
    const rows: SelectionRowSnapshot[] = [];
    const lastRow = Math.min(sel.endRow, visibleRows.length - 1);
    for (let r = sel.startRow; r <= lastRow; r++) {
      const lineIdx = visibleRows[r];
      if (lineIdx === undefined || lineIdx < 0 || lineIdx >= lines.length) continue;
      const rowWidth = selectableRowWidth(region, lineIdx);
      const plain = stripTerminalSequences(sliceByColumn(lines[lineIdx]!, region.col, rowWidth, true));
      rows.push({ row: r, lineIdx, rowWidth, plain });
    }
    this.overlaySel.snapshot = {
      frame,
      col: region.col,
      width: region.width,
      rows,
    };
  }

  private matchesSelectionSnapshot(capturedFrame: Frame | null, rawLines: readonly string[]): boolean {
    const snap = this.overlaySel.snapshot;
    if (!snap || !capturedFrame || capturedFrame !== snap.frame) return false;
    const region = capturedFrame.textRegion;
    if (!region || region.col !== snap.col || region.width !== snap.width) return false;
    if (snap.rows.length === 0) return false;
    for (const entry of snap.rows) {
      if (entry.row >= region.rows.length) return false;
      const lineIdx = region.rows[entry.row]!;
      if (lineIdx !== entry.lineIdx || lineIdx < 0 || lineIdx >= rawLines.length) return false;
      const rowWidth = selectableRowWidth(region, lineIdx);
      if (rowWidth !== entry.rowWidth) return false;
      const plain = stripTerminalSequences(sliceByColumn(rawLines[lineIdx]!, region.col, rowWidth, true));
      if (plain !== entry.plain) return false;
    }
    return true;
  }

  private handleDefaultMouse(
    ev: OverlayMouseEvent,
    ctx: ScreenContext,
    bounds: { height: number },
  ): boolean {
    const termRows = this.terminal.rows || 30;
    const termCols = this.terminal.columns || this.overlaySel.termCols;
    if (
      (this.overlaySel.termRows !== 0 && this.overlaySel.termRows !== termRows) ||
      (this.overlaySel.termCols !== 0 && this.overlaySel.termCols !== termCols)
    ) {
      this.clearOverlaySelection();
      return false;
    }
    const frame = this.overlaySel.frame;
    const region = frame?.textRegion;
    if (!frame || !region || region.rows.length === 0 || region.width <= 0) return false;
    const visibleHeight = Math.min(this.overlaySel.lines.length, Math.max(0, bounds.height));
    const visibleRows = region.rows.filter((r) => r >= 0 && r < visibleHeight);
    if (visibleRows.length === 0) return false;

    if (ev.type === "press") {
      if (ev.button !== "left") return false;
      const rowIdx = visibleRows.indexOf(ev.y);
      const inCols = ev.x >= region.col && ev.x < region.col + region.width;
      if (rowIdx < 0 || !inCols) {
        if (this.hasActiveSelection) {
          this.clearOverlaySelection();
          return true;
        }
        return false;
      }
      const hadActive = this.hasActiveSelection;
      const pt: CellPoint = { row: rowIdx, col: ev.x - region.col };
      this.overlaySel.anchor = pt;
      this.overlaySel.head = pt;
      this.overlaySel.dragging = true;
      this.overlaySel.moved = false;
      this.captureSelectionSnapshot(frame, region, visibleRows);
      return hadActive;
    }

    if (ev.type === "drag") {
      if (ev.button !== "left" || !this.overlaySel.dragging || !this.overlaySel.anchor) return false;
      const col = Math.max(0, Math.min(region.width - 1, ev.x - region.col));
      const rowIdx = nearestTextRowIndex(visibleRows, ev.y);
      const prevHead = this.overlaySel.head;
      const changed = !prevHead || prevHead.row !== rowIdx || prevHead.col !== col;
      this.overlaySel.head = { row: rowIdx, col };
      if (rowIdx !== this.overlaySel.anchor.row || col !== this.overlaySel.anchor.col) {
        this.overlaySel.moved = true;
      }
      this.captureSelectionSnapshot(frame, region, visibleRows);
      return changed;
    }

    if (ev.type === "release") {
      if (ev.button !== "left" || !this.overlaySel.dragging || !this.overlaySel.anchor) return false;
      this.overlaySel.dragging = false;
      const col = Math.max(0, Math.min(region.width - 1, ev.x - region.col));
      const rowIdx = nearestTextRowIndex(visibleRows, ev.y);
      this.overlaySel.head = { row: rowIdx, col };
      if (rowIdx !== this.overlaySel.anchor.row || col !== this.overlaySel.anchor.col) {
        this.overlaySel.moved = true;
      }
      if (!this.overlaySel.moved) {
        this.clearOverlaySelection();
        return false;
      }
      this.captureSelectionSnapshot(frame, region, visibleRows);
      const sel = normalizeSelection("cell", this.overlaySel.anchor, this.overlaySel.head);
      const lines = this.overlaySel.lines;
      const text = extractSelectionText(
        sel,
        (i) => {
          const lineIdx = visibleRows[i];
          if (lineIdx === undefined) return "";
          const line = lines[lineIdx] ?? "";
          const rowW = selectableRowWidth(region, lineIdx);
          return sliceByColumn(line, region.col, rowW, true);
        },
        region.width,
      );
      if (text) {
        yankText(text, ctx.writeTerminal);
        frame.setNotice(`Copied ${text.length} char${text.length === 1 ? "" : "s"}`, "ok");
      }
      return true;
    }

    return false;
  }

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  get current(): Screen | undefined {
    return this.stack[this.stack.length - 1];
  }

  get depth(): number {
    return this.stack.length;
  }

  get breadcrumbs(): string[] {
    return this.stack.map((s) => s.title);
  }

  private makeContext(): ScreenContext {
    return {
      navigator: this,
      theme: this.theme,
      requestRender: () => this.requestRender(),
      writeTerminal: (seq: string) => {
        try {
          this.terminal.write(seq);
        } catch {
          // ignore
        }
      },
    };
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  private syncOverlay(): void {
    const top = this.current;
    if (!top) {
      if (this.handle) {
        this.handle.hide();
        this.handle = null;
      }
      if (this.mouseEnabled) {
        this.mouseEnabled = false;
        try {
          this.terminal.write(DISABLE_MOUSE_SEQ);
        } catch {
          // ignore
        }
      }
      this.onChange?.();
      this.tui.requestRender();
      return;
    }

    if (!this.mouseEnabled) {
      this.mouseEnabled = true;
      try {
        this.terminal.write(ENABLE_MOUSE_SEQ);
      } catch {
        // ignore
      }
    }

    const isDialog = top.variant === "dialog";
    const terminal = this.terminal;
    if (this.handle) {
      this.handle.hide();
      this.handle = null;
    }
    this.handle = this.tui.showOverlay(this.hostComponent, {
      anchor: isDialog ? "center" : "bottom-center",
      width: isDialog ? "80%" : "96%",
      minWidth: isDialog ? 46 : 54,
      get maxHeight() {
        return computeOverlayHeight(terminal.rows || 30, isDialog);
      },
      margin: { top: 1, bottom: 1, left: 1, right: 1 },
    });
    this.onChange?.();
    this.tui.requestRender();
  }

  push(screen: Screen): void {
    this.clearOverlaySelection(true);
    this.stack.push(screen);
    screen.onShow?.(this.makeContext());
    this.syncOverlay();
  }

  replace(screen: Screen): void {
    this.clearOverlaySelection(true);
    const prev = this.stack.pop();
    prev?.onClose?.();
    this.stack.push(screen);
    screen.onShow?.(this.makeContext());
    this.syncOverlay();
  }

  pop(): void {
    this.clearOverlaySelection(true);
    const prev = this.stack.pop();
    prev?.onClose?.();
    this.syncOverlay();
  }

  closeAll(): void {
    this.clearOverlaySelection(true);
    while (this.stack.length > 0) {
      this.stack.pop()?.onClose?.();
    }
    this.syncOverlay();
  }
}

export interface TerminalSessionOptions {
  terminal?: Terminal;
  /** Inspect composer draft before Ctrl+C / Ctrl+D exit logic. */
  getComposerText?: () => string;
  clearComposerText?: () => void;
  isOverlayOpen?: () => boolean;
  isBusy?: () => boolean;
  /** Called on Ctrl+C (when not double-pressed) or confirmed Escape during busy turn. */
  onInterrupt?: () => "consumed" | "exit";
  /** Called on second confirmed Esc during an active turn. */
  onCancelActiveTurn?: () => void;
  /** Banner text updates for Ctrl+C arm / double-Esc confirmation (null clears). */
  onTransientHint?: (msg: string | null) => void;
  /** Async hook run after `tui.stop()` and before `done` resolves (e.g. `session.leave`). */
  onBeforeExit?: () => void | Promise<void>;
  onExit?: () => void;
  /** Duration of double-Esc cancel confirmation window in ms (default 2500). */
  escConfirmMs?: number;
}

/**
 * Bulletproof terminal lifecycle wrapper:
 * - Owns ProcessTerminal + ModalScreen
 * - Restores `await terminal.drainInput(300, 60)` before `tui.stop()` so Kitty/DA1 replies never leak
 * - Cleans up on `SIGINT`, `SIGTERM`, and `SIGHUP`
 * - `Ctrl+D` exits cleanly on empty idle input
 * - `Ctrl+C` closes overlay -> clears unsent draft -> aborts active turn -> press twice (within 1.5s) to exit
 * - Double-`Esc` cancel confirmation for active turns
 * - `Ctrl+]` detaches immediately
 */
export class TerminalSession {
  readonly terminal: Terminal;
  readonly tui: ModalScreen;
  private started = false;
  private stopping = false;
  private ctrlCArmedUntil = 0;
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  private escArmedUntil = 0;
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanupInputListener: (() => void) | null = null;
  private readonly signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  private resolveDone: (() => void) | null = null;
  readonly done: Promise<void>;

  constructor(private readonly opts: TerminalSessionOptions = {}) {
    process.env.PI_PROGRAM_STATUS ??= "0";
    this.terminal = opts.terminal ?? new ProcessTerminal();
    this.tui = new ModalScreen(this.terminal);
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  private disarmCtrlC(): void {
    const had = this.ctrlCArmedUntil > 0 || this.ctrlCTimer !== null;
    this.ctrlCArmedUntil = 0;
    if (this.ctrlCTimer) {
      clearTimeout(this.ctrlCTimer);
      this.ctrlCTimer = null;
    }
    if (had && this.escArmedUntil === 0) this.opts.onTransientHint?.(null);
  }

  private armCtrlC(message: string): void {
    this.ctrlCArmedUntil = Date.now() + 1500;
    this.opts.onTransientHint?.(message);
    if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
    this.ctrlCTimer = setTimeout(() => {
      this.ctrlCArmedUntil = 0;
      this.ctrlCTimer = null;
      if (this.escArmedUntil === 0) this.opts.onTransientHint?.(null);
    }, 1500);
    this.ctrlCTimer.unref?.();
  }

  private disarmEsc(): void {
    const had = this.escArmedUntil > 0 || this.escTimer !== null;
    this.escArmedUntil = 0;
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (had && this.ctrlCArmedUntil === 0) this.opts.onTransientHint?.(null);
  }

  private armEsc(): void {
    const ms = Math.max(250, this.opts.escConfirmMs ?? 2500);
    this.escArmedUntil = Date.now() + ms;
    this.opts.onTransientHint?.("Press Esc again to stop active turn");
    if (this.escTimer) clearTimeout(this.escTimer);
    this.escTimer = setTimeout(() => {
      this.escArmedUntil = 0;
      this.escTimer = null;
      if (this.ctrlCArmedUntil === 0) this.opts.onTransientHint?.(null);
    }, ms);
    this.escTimer.unref?.();
  }

  start(inputInterceptor?: (data: string) => { data?: string; consume?: boolean } | undefined): void {
    if (this.started) return;
    this.started = true;

    this.cleanupInputListener = this.tui.addInputListener((data) => {
      if (isKeyRelease(data)) return undefined;

      // Ctrl+]: immediate detach
      if (data === "\x1d" || matchesKey(data, "ctrl+]")) {
        this.disarmCtrlC();
        this.disarmEsc();
        void this.stop();
        return { consume: true };
      }

      // Ctrl+C: if an overlay is open, pop it cleanly without arming exit; otherwise clear draft -> stop turn -> 2x exit
      if (data === "\x03" || matchesKey(data, "ctrl+c")) {
        this.disarmEsc();
        if (this.opts.isOverlayOpen?.()) {
          this.disarmCtrlC();
          this.opts.onInterrupt?.();
          return { consume: true };
        }
        const now = Date.now();
        if (now < this.ctrlCArmedUntil) {
          this.disarmCtrlC();
          void this.stop();
          return { consume: true };
        }
        // Clear unsent draft first
        const hasDraft = (this.opts.getComposerText?.().length ?? 0) > 0;
        if (hasDraft) {
          this.opts.clearComposerText?.();
          this.armCtrlC("Draft cleared · press Ctrl+C again to exit");
          return { consume: true };
        }
        const res = this.opts.onInterrupt?.() ?? "exit";
        if (res === "exit") {
          if (this.opts.onTransientHint) {
            this.armCtrlC("Press Ctrl+C again (or Ctrl+D) to detach & exit");
            return { consume: true };
          }
          void this.stop();
          return { consume: true };
        }
        this.armCtrlC("Stopping · press Ctrl+C again to exit");
        return { consume: true };
      }

      // Ctrl+D: clean exit on empty idle main screen
      if (data === "\x04" || matchesKey(data, "ctrl+d")) {
        if (
          !this.opts.isOverlayOpen?.() &&
          !this.opts.isBusy?.() &&
          (this.opts.getComposerText?.().length ?? 0) === 0
        ) {
          this.disarmCtrlC();
          this.disarmEsc();
          void this.stop();
          return { consume: true };
        }
        return undefined;
      }

      // Esc on main screen while busy: double-Esc cancel confirmation
      if ((data === "\x1b" || matchesKey(data, "escape")) && !this.opts.isOverlayOpen?.()) {
        this.disarmCtrlC();
        if (this.opts.isBusy?.() && this.opts.onCancelActiveTurn) {
          if (Date.now() < this.escArmedUntil) {
            this.disarmEsc();
            this.opts.onCancelActiveTurn();
          } else {
            this.armEsc();
          }
          return { consume: true };
        }
        this.disarmEsc();
        return undefined;
      }

      // Any other key clears armed Ctrl+C / Esc confirmation hints
      if (this.escArmedUntil > 0) this.disarmEsc();
      if (this.ctrlCArmedUntil > 0) this.disarmCtrlC();

      return inputInterceptor?.(data);
    });

    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
      const handler = () => {
        void this.stop();
      };
      process.on(sig, handler);
      this.signalHandlers.push([sig, handler]);
    }

    this.tui.start();
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.done;
    this.stopping = true;

    this.disarmCtrlC();
    this.disarmEsc();
    this.cleanupInputListener?.();
    this.cleanupInputListener = null;

    for (const [sig, fn] of this.signalHandlers) {
      process.off(sig, fn);
    }
    this.signalHandlers.length = 0;

    // Drain any in-flight Kitty keyboard / DA1 replies BEFORE restoring terminal mode
    try {
      await this.terminal.drainInput(300, 60);
    } catch {
      // ignore
    }

    try {
      this.terminal.write(this.tui.exitRestoreSequence());
    } catch {
      // ignore
    }
    try {
      this.tui.stop();
    } catch {
      // ignore
    }

    try {
      await this.opts.onBeforeExit?.();
    } catch {
      // ignore
    }
    this.opts.onExit?.();
    this.resolveDone?.();
  }
}
