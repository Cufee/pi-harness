import { TuiMainScreen, type Terminal, type TuiStopOptions } from "@earendil-works/pi-tui";
import { DISABLE_MOUSE_WHEEL_SEQ, dispatchLeftPresses, ENABLE_MOUSE_WHEEL_SEQ } from "./mouse.js";

const FAINT = "\x1b[2m";
// Reset (`0`/empty) and normal-intensity (`22`) SGRs would end the faint attribute mid-line.
const INTENSITY_RESET = /\x1b\[(?:0|22)?m/g;

function dimLine(line: string): string {
  // Image escape sequences must stay untouched at the line start.
  if (!line || line.includes("\x1b_G") || line.includes("\x1b]1337;File=")) return line;
  return FAINT + line.replace(INTENSITY_RESET, (sgr) => sgr + FAINT);
}

/**
 * Main-screen TUI that dims the visible frame beneath any open overlay on every redraw,
 * so every modal (palette, runs, settings, transcript…) shares one steady backdrop.
 * Scrollback above the viewport is left untouched, and dismissal restores the base lines.
 */
export class ModalScreen extends TuiMainScreen {
  constructor(terminal: Terminal) {
    super(terminal);
    this.addInputListener((data) => {
      if (this.hasOverlay()) return;
      const rest = dispatchLeftPresses(data, (x, y) => this.clickTranscript(x, y));
      if (rest !== data) return rest ? { data: rest } : { consume: true };
    });
  }

  private clickTranscript(x: number, y: number): void {
    const { previousLines, previousWidth, previousHeight, previousViewportTop } = this.captureRenderState();
    if (previousWidth !== this.terminal.columns || previousHeight !== this.terminal.rows) return;
    if (x < 0 || x >= previousWidth || y < 0 || y >= previousHeight) return;
    const result = this.handleMouse({
      type: "click", button: "left", x, y: y + previousViewportTop, screenX: x, screenY: y,
      width: previousWidth, height: previousLines.length, shift: false, alt: false, ctrl: false,
    });
    if (result?.handled && result.render !== false) this.requestRender();
  }

  protected override afterTerminalStart(): void {
    super.afterTerminalStart();
    this.terminal.write(ENABLE_MOUSE_WHEEL_SEQ);
  }

  protected override beforeTerminalStop(options: TuiStopOptions): void {
    this.terminal.write(DISABLE_MOUSE_WHEEL_SEQ);
    super.beforeTerminalStop(options);
  }

  protected override getExitRestorePrefix(): string {
    return DISABLE_MOUSE_WHEEL_SEQ + super.getExitRestorePrefix();
  }

  protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
    if (!this.hasOverlay()) return super.compositeOverlays(lines, termWidth, termHeight);
    const viewportStart = Math.max(0, lines.length - termHeight);
    const dimmed = lines.map((line, i) => (i >= viewportStart ? dimLine(line) : line));
    return super.compositeOverlays(dimmed, termWidth, termHeight);
  }
}
