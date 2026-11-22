import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { ModalScreen } from "./modal-screen.js";
import { DISABLE_MOUSE_WHEEL_SEQ, ENABLE_MOUSE_WHEEL_SEQ } from "./mouse.js";
import { Panel, type PanelOptions } from "./panel.js";
import type { HarnessTheme } from "./theme.js";

interface OverlayEntry {
  handle: OverlayHandle;
  panel: Panel;
  previousFocus: Component | null;
  onClose?: () => void;
  captureMouseWheel?: boolean;
}

/**
 * LIFO overlay stack manager built on `TuiMainScreen.showOverlay(...)`.
 * Automatically wraps overlay content in an ANSI-safe opaque `Panel`,
 * restores focus cleanly on pop, exposes `requestRender()` for async updates,
 * and reference-counts SGR mouse-wheel tracking for scrollable overlays so native
 * terminal scrollback stays untouched whenever no scrollable overlay is open.
 */
export class OverlayManager {
  private stack: OverlayEntry[] = [];
  private mouseCaptureCount = 0;

  constructor(
    private readonly tui: TUI,
    private readonly theme: HarnessTheme,
    private readonly defaultFocus: Component,
  ) {}

  private writeTermSeq(seq: string): void {
    if (this.tui instanceof ModalScreen) return;
    try {
      const term = (this.tui as unknown as { terminal?: { write?: (s: string) => void } }).terminal;
      term?.write?.(seq);
    } catch {
      // ignore if terminal is already closed or mocked without write
    }
  }

  private acquireMouseWheel(): void {
    if (this.mouseCaptureCount === 0) {
      this.writeTermSeq(ENABLE_MOUSE_WHEEL_SEQ);
    }
    this.mouseCaptureCount++;
  }

  private releaseMouseWheel(): void {
    if (this.mouseCaptureCount <= 0) return;
    this.mouseCaptureCount--;
    if (this.mouseCaptureCount === 0) {
      this.writeTermSeq(DISABLE_MOUSE_WHEEL_SEQ);
    }
  }

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  get depth(): number {
    return this.stack.length;
  }

  push(
    panelOpts: PanelOptions,
    content: Component,
    opts?: { width?: `${number}%` | number; onClose?: () => void; captureMouseWheel?: boolean },
  ): { close: () => void; rerender: () => void; updatePanel: (p: Partial<PanelOptions>) => void } {
    const panel = new Panel(this.theme, panelOpts, content);
    const previousFocus = this.stack.length > 0 ? this.stack[this.stack.length - 1]!.panel : this.defaultFocus;
    const handle = this.tui.showOverlay(panel, {
      width: opts?.width ?? "88%",
      anchor: "center",
    });
    const captureMouseWheel = Boolean(opts?.captureMouseWheel);
    const entry: OverlayEntry = { handle, panel, previousFocus, onClose: opts?.onClose, captureMouseWheel };
    this.stack.push(entry);
    if (captureMouseWheel) this.acquireMouseWheel();
    this.tui.setFocus(panel);
    this.tui.requestRender();

    const close = () => {
      const idx = this.stack.indexOf(entry);
      if (idx === -1) return;
      this.stack.splice(idx, 1);
      if (entry.captureMouseWheel) this.releaseMouseWheel();
      entry.handle.hide();
      entry.onClose?.();
      const nextFocus = this.stack.length > 0 ? this.stack[this.stack.length - 1]!.panel : this.defaultFocus;
      this.tui.setFocus(nextFocus);
      this.tui.requestRender();
    };

    return {
      close,
      rerender: () => {
        panel.invalidate();
        this.tui.requestRender();
      },
      updatePanel: (patch) => {
        panel.setOptions(patch);
        panel.invalidate();
        this.tui.requestRender();
      },
    };
  }

  pop(): boolean {
    const top = this.stack.pop();
    if (!top) return false;
    if (top.captureMouseWheel) this.releaseMouseWheel();
    top.handle.hide();
    top.onClose?.();
    const nextFocus = this.stack.length > 0 ? this.stack[this.stack.length - 1]!.panel : this.defaultFocus;
    this.tui.setFocus(nextFocus);
    this.tui.requestRender();
    return true;
  }

  closeAll(): void {
    while (this.stack.length > 0) {
      const top = this.stack.pop()!;
      if (top.captureMouseWheel) this.releaseMouseWheel();
      top.handle.hide();
      top.onClose?.();
    }
    if (this.mouseCaptureCount > 0) {
      this.mouseCaptureCount = 0;
      this.writeTermSeq(DISABLE_MOUSE_WHEEL_SEQ);
    }
    this.tui.setFocus(this.defaultFocus);
    this.tui.requestRender();
  }
}
