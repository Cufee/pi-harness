import { TuiMainScreen } from "@earendil-works/pi-tui";

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
  protected override compositeOverlays(lines: string[], termWidth: number, termHeight: number): string[] {
    if (!this.hasOverlay()) return super.compositeOverlays(lines, termWidth, termHeight);
    const viewportStart = Math.max(0, lines.length - termHeight);
    const dimmed = lines.map((line, i) => (i >= viewportStart ? dimLine(line) : line));
    return super.compositeOverlays(dimmed, termWidth, termHeight);
  }
}
