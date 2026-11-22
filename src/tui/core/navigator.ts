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
import { DISABLE_MOUSE_WHEEL_SEQ, ENABLE_MOUSE_WHEEL_SEQ } from "./viewport.js";

const FAINT = "\x1b[2m";
const RESET = "\x1b[0m";
const SGR_RX = /\x1b\[([0-9;]*)m/g;

/**
 * Applies dim styling across a line while re-applying FAINT after standalone (`\x1b[0m`, `\x1b[m`,
 * `\x1b[22m`) and compound (`\x1b[0;32m`, `\x1b[22;39m`) SGR resets so dimmed backdrops stay dimmed.
 */
export function dimLine(line: string): string {
  const reapplied = line.replace(SGR_RX, (match, rawParams: string) => {
    const codes = rawParams.split(";");
    const resetsFaint = codes.some((c) => c === "" || c === "0" || c === "22");
    return resetsFaint ? `${match}${FAINT}` : match;
  });
  return `${FAINT}${reapplied}${RESET}`;
}

/**
 * Main-screen TUI wrapper. Deliberately NEVER enables terminal mouse tracking on the main screen
 * so native terminal scrollback and mouse-drag selection work seamlessly. Mouse wheel capture
 * is scoped strictly to open overlays via `Navigator`.
 */
export class ModalScreen extends TuiMainScreen {
  constructor(terminal: Terminal) {
    super(terminal);
  }

  override render(width: number): string[] {
    return [...super.render(width)];
  }

  getExitRestorePrefix(): string {
    return DISABLE_MOUSE_WHEEL_SEQ;
  }
}

export interface ScreenContext {
  navigator: Navigator;
  theme: Theme;
  requestRender: () => void;
  writeTerminal: (seq: string) => void;
}

export interface Screen {
  readonly id?: string;
  readonly title: string;
  /** `"sheet"` = wide full-height inspector/navigator; `"dialog"` = compact centered picker. */
  readonly variant?: "sheet" | "dialog";
  render(width: number, maxHeight: number, theme: Theme): string[];
  handleInput(data: string, ctx: ScreenContext): void;
  onShow?(ctx: ScreenContext): void;
  onClose?(): void;
}

/**
 * Single modal/sheet stack manager with breadcrumbs and overlay-only mouse-wheel capture.
 * Replaces all ad-hoc `OverlayManager` / multi-backdrop / duplicated modal plumbing.
 */
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
        const rows = Math.max(10, this.terminal.rows || 30);
        const maxH = top.variant === "dialog" ? Math.min(22, Math.max(10, rows - 6)) : Math.max(12, rows - 4);
        return top.render(width, maxH, this.theme);
      },
      invalidate: () => {},
      handleInput: (data: string) => {
        if (isKeyRelease(data)) return;
        const top = this.current;
        if (!top) return;
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
          this.terminal.write(DISABLE_MOUSE_WHEEL_SEQ);
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
        this.terminal.write(ENABLE_MOUSE_WHEEL_SEQ);
      } catch {
        // ignore
      }
    }

    const isDialog = top.variant === "dialog";
    if (this.handle) {
      this.handle.hide();
      this.handle = null;
    }
    this.handle = this.tui.showOverlay(this.hostComponent, {
      anchor: isDialog ? "center" : "bottom-center",
      width: isDialog ? "76%" : "96%",
      minWidth: isDialog ? 44 : 52,
      maxHeight: isDialog ? "75%" : "86%",
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
  onInterrupt?: () => "consumed" | "exit";
  onExit?: () => void;
}

/**
 * Bulletproof terminal lifecycle wrapper: owns ProcessTerminal, ModalScreen,
 * global Ctrl+C / Ctrl+D / Ctrl+] exit safety, and clean shutdown restore.
 */
export class TerminalSession {
  readonly terminal: Terminal;
  readonly tui: ModalScreen;
  private started = false;
  private stopped = false;
  private lastCtrlC = 0;
  private cleanupInputListener: (() => void) | null = null;
  private resolveDone: (() => void) | null = null;
  readonly done: Promise<void>;

  constructor(private readonly opts: TerminalSessionOptions = {}) {
    this.terminal = opts.terminal ?? new ProcessTerminal();
    this.tui = new ModalScreen(this.terminal);
    this.done = new Promise<void>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  start(inputInterceptor?: (data: string) => { data?: string; consume?: boolean } | undefined): void {
    if (this.started) return;
    this.started = true;
    this.cleanupInputListener = this.tui.addInputListener((data) => {
      if (isKeyRelease(data)) return undefined;
      if (matchesKey(data, "ctrl+]")) {
        this.stop();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+c")) {
        const res = this.opts.onInterrupt?.() ?? "exit";
        if (res === "exit") {
          this.stop();
          return { consume: true };
        }
        const now = Date.now();
        if (now - this.lastCtrlC < 900) {
          this.stop();
          return { consume: true };
        }
        this.lastCtrlC = now;
        return { consume: true };
      }
      return inputInterceptor?.(data);
    });
    this.tui.start();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanupInputListener?.();
    this.cleanupInputListener = null;
    try {
      this.terminal.write(this.tui.getExitRestorePrefix());
    } catch {
      // ignore
    }
    try {
      this.tui.stop();
    } catch {
      // ignore
    }
    this.opts.onExit?.();
    this.resolveDone?.();
  }
}
