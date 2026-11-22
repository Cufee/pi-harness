import { isKeyRelease, matchesKey, ProcessTerminal, TuiMainScreen } from "@earendil-works/pi-tui";
import type { OverlayManager } from "./overlay-stack.js";
import type { TimedSpinner } from "./spinner.js";
import type { FooterHint } from "./status-bar.js";

export interface TerminalSessionCallbacks {
  getComposerText: () => string;
  clearComposerText: () => void;
  isAutocompleteOpen: () => boolean;
  isBusy: () => boolean;
  onAbortGeneration: (key: "escape" | "ctrl+c") => void;
  onSteer?: () => void;
  onRecallQueued?: () => boolean;
  onOpenSettings?: () => void;
  onOpenPalette?: () => void;
  onOpenTree?: () => void;
  /** Optional async resolver invoked on normal exit (Ctrl+C/Ctrl+D/Ctrl+]) to decide the exit note (e.g. via `session.leave`). */
  onResolveExitNote?: () => string | Promise<string>;
  onShutdownCleanup?: () => void | Promise<void>;
}

/**
 * Bulletproof native-scrollback terminal session manager.
 * Guarantees:
 *  1. `Ctrl+C` ALWAYS works cleanly (closes overlay -> clears non-empty input -> aborts busy turn -> double-Ctrl+C exits).
 *  2. `Ctrl+D` on empty idle input exits cleanly; on non-empty input deletes forward.
 *  3. `Ctrl+]` detaches immediately (leaving `harnessd` running).
 *  4. `Esc` closes autocomplete / overlay / aborts active turn without exiting.
 *  5. Always calls `await terminal.drainInput(300, 60)` BEFORE `tui.stop()` so Kitty/DA1 replies (`7u1;2c`) NEVER leak into zsh!
 */
export class TerminalSession {
  readonly terminal: ProcessTerminal;
  readonly tui: TuiMainScreen;

  private shuttingDown = false;
  private ctrlCArmedUntil = 0;
  private ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  private exitResolve: (() => void) | null = null;
  private readonly exitPromise: Promise<void>;
  private readonly signalHandlers: Array<[NodeJS.Signals, () => void]> = [];

  constructor() {
    // Avoid unnecessary OSC 7501 capability query traffic when unused
    process.env.PI_PROGRAM_STATUS ??= "0";
    this.terminal = new ProcessTerminal();
    this.tui = new TuiMainScreen(this.terminal);
    this.exitPromise = new Promise<void>((resolve) => {
      this.exitResolve = resolve;
    });
  }

  get closed(): Promise<void> {
    return this.exitPromise;
  }

  bindControls(opts: {
    overlays: OverlayManager;
    spinner: TimedSpinner;
    footerHint: FooterHint;
    callbacks: TerminalSessionCallbacks;
    detachBanner: string;
  }): void {
    const { overlays, spinner, footerHint, callbacks, detachBanner } = opts;

    const disarmCtrlC = () => {
      this.ctrlCArmedUntil = 0;
      if (this.ctrlCTimer) {
        clearTimeout(this.ctrlCTimer);
        this.ctrlCTimer = null;
      }
      footerHint.clear();
    };

    this.tui.addInputListener((data) => {
      // Never react to Kitty key-release events
      if (isKeyRelease(data)) return undefined;

      // Ctrl+] (0x1d): instant tmux-style detach/exit
      if (data === "\x1d" || matchesKey(data, "ctrl+]")) {
        void this.shutdown(detachBanner, {
          overlays,
          spinner,
          resolveNote: callbacks.onResolveExitNote,
          cleanup: callbacks.onShutdownCleanup,
        });
        return { consume: true };
      }

      // Ctrl+, : toggle Settings overlay
      if (matchesKey(data, "ctrl+,") && callbacks.onOpenSettings) {
        disarmCtrlC();
        if (overlays.isOpen) overlays.pop();
        else callbacks.onOpenSettings();
        return { consume: true };
      }

      // Ctrl+O : Command Palette (Amp-style quick command launcher without losing draft text!)
      if ((data === "\x0f" || matchesKey(data, "ctrl+o")) && callbacks.onOpenPalette) {
        disarmCtrlC();
        if (overlays.isOpen) overlays.pop();
        else callbacks.onOpenPalette();
        return { consume: true };
      }

      // Ctrl+T : Agent Tree switcher
      if ((data === "\x14" || matchesKey(data, "ctrl+t")) && callbacks.onOpenTree) {
        disarmCtrlC();
        if (overlays.isOpen) overlays.pop();
        else callbacks.onOpenTree();
        return { consume: true };
      }

      // Ctrl+C (\x03 or Kitty ctrl+c): NEVER dead/ignored!
      if (data === "\x03" || matchesKey(data, "ctrl+c")) {
        const now = Date.now();
        // Second Ctrl+C within 1.5s ALWAYS exits immediately even if an overlay is open
        if (now < this.ctrlCArmedUntil) {
          disarmCtrlC();
          void this.shutdown(detachBanner, {
            overlays,
            spinner,
            resolveNote: callbacks.onResolveExitNote,
            cleanup: callbacks.onShutdownCleanup,
          });
          return { consume: true };
        }
        if (overlays.isOpen) {
          overlays.pop();
          this.armCtrlC(footerHint, "Overlay closed · press Ctrl+C again to exit", () => {
            footerHint.clear();
            this.tui.requestRender();
          });
          this.tui.requestRender();
          return { consume: true };
        }
        if (callbacks.getComposerText().length > 0) {
          callbacks.clearComposerText();
          this.armCtrlC(footerHint, "Input cleared · press Ctrl+C again to exit", () => {
            footerHint.clear();
            this.tui.requestRender();
          });
          this.tui.requestRender();
          return { consume: true };
        }
        if (callbacks.isBusy()) {
          callbacks.onAbortGeneration("ctrl+c");
          this.armCtrlC(footerHint, "Stopping · press Ctrl+C again to exit", () => {
            footerHint.clear();
            this.tui.requestRender();
          });
          this.tui.requestRender();
          return { consume: true };
        }
        this.armCtrlC(footerHint, "Press Ctrl+C again (or Ctrl+D) to detach & exit", () => {
          footerHint.clear();
          this.tui.requestRender();
        });
        this.tui.requestRender();
        return { consume: true };
      }

      // Ctrl+D (\x04): immediate clean exit when idle & empty
      if (data === "\x04" || matchesKey(data, "ctrl+d")) {
        if (!overlays.isOpen && !callbacks.isBusy() && callbacks.getComposerText().length === 0) {
          disarmCtrlC();
          void this.shutdown(detachBanner, {
            overlays,
            spinner,
            resolveNote: callbacks.onResolveExitNote,
            cleanup: callbacks.onShutdownCleanup,
          });
          return { consume: true };
        }
        return undefined; // Let Editor handle deleteCharForward when text is present
      }

      if (!overlays.isOpen && callbacks.isBusy()) {
        if (matchesKey(data, "ctrl+s") && callbacks.onSteer) {
          disarmCtrlC();
          callbacks.onSteer();
          return { consume: true };
        }
        if (matchesKey(data, "ctrl+r") && callbacks.onRecallQueued?.()) {
          disarmCtrlC();
          return { consume: true };
        }
      }

      // Esc: autocomplete -> overlay -> abort busy turn
      if (data === "\x1b" || matchesKey(data, "escape")) {
        disarmCtrlC();
        if (overlays.isOpen) {
          // Let topmost overlay handle inner submenu Escape if it wants; if unhandled, overlay calls pop()
          return undefined;
        }
        if (callbacks.isAutocompleteOpen()) {
          return undefined; // Let Editor dismiss autocomplete
        }
        if (callbacks.isBusy()) {
          callbacks.onAbortGeneration("escape");
          return { consume: true };
        }
        return undefined;
      }

      // Any other key clears the Ctrl+C arm banner
      if (this.ctrlCArmedUntil > 0) {
        disarmCtrlC();
      }
      return undefined;
    });

    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as NodeJS.Signals[]) {
      const handler = () => {
        void this.shutdown(detachBanner, {
          overlays,
          spinner,
          resolveNote: callbacks.onResolveExitNote,
          cleanup: callbacks.onShutdownCleanup,
        });
      };
      process.on(sig, handler);
      this.signalHandlers.push([sig, handler]);
    }
  }

  private armCtrlC(footerHint: FooterHint, msg: string, onExpire: () => void): void {
    this.ctrlCArmedUntil = Date.now() + 1500;
    footerHint.set(msg, "warning");
    if (this.ctrlCTimer) clearTimeout(this.ctrlCTimer);
    this.ctrlCTimer = setTimeout(() => {
      this.ctrlCArmedUntil = 0;
      onExpire();
    }, 1500);
    this.ctrlCTimer.unref?.();
  }

  start(): void {
    this.tui.start();
  }

  async shutdown(
    note?: string,
    parts?: {
      overlays?: OverlayManager;
      spinner?: TimedSpinner;
      resolveNote?: () => string | Promise<string>;
      cleanup?: () => void | Promise<void>;
    },
  ): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.ctrlCTimer) {
      clearTimeout(this.ctrlCTimer);
      this.ctrlCTimer = null;
    }
    for (const [sig, fn] of this.signalHandlers) {
      process.off(sig, fn);
    }
    this.signalHandlers.length = 0;

    parts?.spinner?.stop();
    parts?.overlays?.closeAll();

    // Drain any in-flight Kitty keyboard / DA1 capability replies (`7u1;2c`) BEFORE restoring cooked mode!
    try {
      await this.terminal.drainInput(300, 60);
    } catch {
      // ignore if terminal already closed
    }

    // Call tui.stop() WITHOUT preserveScreen:true so cursor advances cleanly below UI while keeping scrollback!
    try {
      this.tui.stop();
    } catch {
      // ignore
    }

    let finalNote = note;
    if (parts?.resolveNote) {
      try {
        finalNote = await parts.resolveNote();
      } catch {
        // keep fallback note
      }
    }

    if (finalNote) {
      process.stdout.write(`${finalNote}\n`);
    }

    try {
      await parts?.cleanup?.();
    } catch {
      // ignore
    }

    this.exitResolve?.();
  }
}
