import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { Panel, type PanelOptions } from "./panel.js";
import type { HarnessTheme } from "./theme.js";

interface OverlayEntry {
  handle: OverlayHandle;
  panel: Panel;
  previousFocus: Component | null;
  onClose?: () => void;
}

/**
 * LIFO overlay stack manager built on `TuiMainScreen.showOverlay(...)`.
 * Automatically wraps overlay content in an ANSI-safe opaque `Panel`,
 * restores focus cleanly on pop, and exposes `requestRender()` for async updates.
 */
export class OverlayManager {
  private stack: OverlayEntry[] = [];

  constructor(
    private readonly tui: TUI,
    private readonly theme: HarnessTheme,
    private readonly defaultFocus: Component,
  ) {}

  get isOpen(): boolean {
    return this.stack.length > 0;
  }

  get depth(): number {
    return this.stack.length;
  }

  push(
    panelOpts: PanelOptions,
    content: Component,
    opts?: { width?: `${number}%` | number; onClose?: () => void },
  ): { close: () => void; rerender: () => void; updatePanel: (p: Partial<PanelOptions>) => void } {
    const panel = new Panel(this.theme, panelOpts, content);
    const previousFocus = this.stack.length > 0 ? this.stack[this.stack.length - 1]!.panel : this.defaultFocus;
    const handle = this.tui.showOverlay(panel, {
      width: opts?.width ?? "88%",
      anchor: "center",
    });
    const entry: OverlayEntry = { handle, panel, previousFocus, onClose: opts?.onClose };
    this.stack.push(entry);
    this.tui.setFocus(panel);
    this.tui.requestRender();

    const close = () => {
      const idx = this.stack.indexOf(entry);
      if (idx === -1) return;
      this.stack.splice(idx, 1);
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
      top.handle.hide();
      top.onClose?.();
    }
    this.tui.setFocus(this.defaultFocus);
    this.tui.requestRender();
  }
}
