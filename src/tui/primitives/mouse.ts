/** Enable button/wheel tracking and SGR extended coordinates. */
export const ENABLE_MOUSE_WHEEL_SEQ = "\x1b[?1000h\x1b[?1006h";

/** Disable SGR extended coordinates + X10 mouse tracking (restores native terminal scrollback). */
export const DISABLE_MOUSE_WHEEL_SEQ = "\x1b[?1006l\x1b[?1000l";

export interface ParsedMouseInput {
  /** True if `data` contained one or more mouse escape sequences (even non-wheel clicks/releases). */
  isMouse: boolean;
  /** Signed vertical scroll delta in lines (< 0 = scroll up, > 0 = scroll down). */
  deltaLines: number;
}

const SGR_MOUSE_RX = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const X10_MOUSE_RX = /\x1b\[M([\s\S]{3})/g;

export function dispatchLeftPresses(data: string, onPress: (x: number, y: number) => void): string {
  return data.replace(SGR_MOUSE_RX, (_, button, col, row, kind) => {
    if (kind === "M" && Number(button) === 0) onPress(Number(col) - 1, Number(row) - 1);
    return "";
  }).replace(X10_MOUSE_RX, (_, bytes: string) => {
    if (bytes.charCodeAt(0) === 32) onPress(bytes.charCodeAt(1) - 33, bytes.charCodeAt(2) - 33);
    return "";
  });
}

/**
 * Parses SGR (`\x1b[<btn;col;rowM`) and X10 (`\x1b[Mcb cx cy`) mouse escape sequences,
 * summing coalesced wheel events (common on macOS trackpads) into a signed vertical line delta.
 */
export function parseMouseWheel(data: string, linesPerTick = 3): ParsedMouseInput {
  if (!data.includes("\x1b[<") && !data.includes("\x1b[M")) {
    return { isMouse: false, deltaLines: 0 };
  }

  let isMouse = false;
  let deltaLines = 0;

  SGR_MOUSE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SGR_MOUSE_RX.exec(data)) !== null) {
    isMouse = true;
    const btn = Number(m[1]);
    const kind = m[4];
    if (kind === "m") continue; // ignore button release
    const alt = (btn & 8) !== 0;
    const step = alt ? linesPerTick * 3 : linesPerTick;
    // Wheel bits: bit 6 (64) set; low 2 bits 0 = wheel up (64), 1 = wheel down (65)
    if ((btn & 64) !== 0) {
      const dir = btn & 3;
      if (dir === 0) deltaLines -= step;
      else if (dir === 1) deltaLines += step;
    }
  }

  X10_MOUSE_RX.lastIndex = 0;
  while ((m = X10_MOUSE_RX.exec(data)) !== null) {
    isMouse = true;
    const cb = m[1]!.charCodeAt(0) - 32;
    const alt = (cb & 8) !== 0;
    const step = alt ? linesPerTick * 3 : linesPerTick;
    if ((cb & 64) !== 0) {
      const dir = cb & 3;
      if (dir === 0) deltaLines -= step;
      else if (dir === 1) deltaLines += step;
    }
  }

  return { isMouse, deltaLines };
}
