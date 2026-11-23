import {
  type Component,
  isKeyRelease,
  matchesKey,
  type OverlayHandle,
  ProcessTerminal,
  type Terminal,
  TuiMainScreen,
} from "@earendil-works/pi-tui";
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
  handleMouse?(ev: OverlayMouseEvent, ctx: ScreenContext): void;
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

function computeOverlayHeight(termRows: number, isDialog: boolean): number {
  const rows = Math.max(8, Math.floor(termRows || 30));
  const maxByMargin = Math.max(6, rows - 2);
  const desired = isDialog ? Math.min(26, Math.floor(rows * 0.78)) : Math.floor(rows * 0.88);
  return Math.max(6, Math.min(maxByMargin, desired));
}
export class Navigator {
  private stack: Screen[] = [];
  private handle: OverlayHandle | null = null;
  private mouseEnabled = false;
  private readonly hostComponent: Component;
  private readonly onChange?: () => void;

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
        const maxH = computeOverlayHeight(this.terminal.rows || 30, top.variant === "dialog");
        return top.render(width, maxH, this.theme);
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (isKeyRelease(data)) return;
        const top = this.current;
        if (!top) return;
        const mouseEvents = parseMouseEvents(data);
        if (mouseEvents.length > 0) {
          if (top.handleMouse) {
            const bounds = this.handle?.getBounds();
            const offX = bounds?.col ?? 0;
            const offY = bounds?.row ?? 0;
            const ctx = this.makeContext();
            for (const ev of mouseEvents) {
              top.handleMouse({ ...ev, x: ev.x - offX, y: ev.y - offY }, ctx);
            }
            this.requestRender();
            return;
          }
          if (!mouseEvents.some((e) => e.type === "wheel")) {
            return;
          }
        }
        top.handleInput(data, this.makeContext());
      },
    };
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
    const maxH = computeOverlayHeight(this.terminal.rows || 30, isDialog);
    if (this.handle) {
      this.handle.hide();
      this.handle = null;
    }
    this.handle = this.tui.showOverlay(this.hostComponent, {
      anchor: isDialog ? "center" : "bottom-center",
      width: isDialog ? "80%" : "96%",
      minWidth: isDialog ? 46 : 54,
      maxHeight: maxH,
      margin: { top: 1, bottom: 1, left: 1, right: 1 },
    });
    this.onChange?.();
    this.tui.requestRender();
  }

  push(screen: Screen): void {
    this.stack.push(screen);
    screen.onShow?.(this.makeContext());
    this.syncOverlay();
  }

  replace(screen: Screen): void {
    const prev = this.stack.pop();
    prev?.onClose?.();
    this.stack.push(screen);
    screen.onShow?.(this.makeContext());
    this.syncOverlay();
  }

  pop(): void {
    const prev = this.stack.pop();
    prev?.onClose?.();
    this.syncOverlay();
  }

  closeAll(): void {
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
