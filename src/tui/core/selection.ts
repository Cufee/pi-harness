import { fit, sliceByColumn, stripTerminalSequences, visibleWidth } from "./text.js";

export interface CellPoint {
  row: number;
  col: number;
}

export interface NormalizedSelection {
  mode: "row" | "cell";
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Orders anchor/head into a normalized forward selection range. */
export function normalizeSelection(
  mode: "row" | "cell",
  anchor: CellPoint,
  head: CellPoint,
): NormalizedSelection {
  if (anchor.row < head.row || (anchor.row === head.row && anchor.col <= head.col)) {
    return {
      mode,
      startRow: anchor.row,
      endRow: head.row,
      startCol: anchor.col,
      endCol: head.col,
    };
  }
  return {
    mode,
    startRow: head.row,
    endRow: anchor.row,
    startCol: head.col,
    endCol: anchor.col,
  };
}

/** Snaps inclusive cell range `[c0, c1]` outward to whole grapheme boundaries on `row`. */
export function snapCellRange(row: string, c0: number, c1: number, contentW: number): { c0: number; c1: number } {
  const maxCol = Math.max(0, contentW - 1);
  let start = Math.max(0, Math.min(maxCol, c0));
  let end = Math.max(start, Math.min(maxCol, c1));
  const plain = stripTerminalSequences(row);
  if (!plain || !/[^\x20-\x7e]/.test(plain)) {
    return { c0: start, c1: end };
  }
  let col = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(plain)) {
    const w = visibleWidth(segment);
    if (w > 0) {
      const gStart = col;
      const gEnd = col + w - 1;
      if (start >= gStart && start <= gEnd) start = gStart;
      if (end >= gStart && end <= gEnd) end = Math.min(maxCol, gEnd);
    }
    col += w;
    if (col > end) break;
  }
  return { c0: start, c1: end };
}

/** Computes the inclusive, grapheme-snapped column range `[c0, c1]` selected on `rowIdx`. */
export function rowSelectionCols(
  row: string,
  rowIdx: number,
  sel: NormalizedSelection,
  contentW: number,
): { c0: number; c1: number } {
  const maxCol = Math.max(0, contentW - 1);
  if (sel.mode !== "cell") return { c0: 0, c1: maxCol };
  let rawStart = 0;
  let rawEnd = maxCol;
  if (sel.startRow === sel.endRow) {
    rawStart = Math.min(sel.startCol, maxCol);
    rawEnd = Math.min(sel.endCol, maxCol);
  } else if (rowIdx === sel.startRow) {
    rawStart = Math.min(sel.startCol, maxCol);
    rawEnd = maxCol;
  } else if (rowIdx === sel.endRow) {
    rawStart = 0;
    rawEnd = Math.min(sel.endCol, maxCol);
  } else {
    return { c0: 0, c1: maxCol };
  }
  return snapCellRange(row, rawStart, rawEnd, contentW);
}

/** Extracts plain text across `sel`, trimming row-mode spacer rows and common col-0 indentation. */
export function extractSelectionText(
  sel: NormalizedSelection,
  rowAt: (rowIdx: number) => string,
  contentW: number,
): string {
  const w = Math.max(1, contentW);
  const pieces: Array<{ text: string; fromCol0: boolean }> = [];

  for (let r = sel.startRow; r <= sel.endRow; r++) {
    const row = rowAt(r);
    const { c0, c1 } = rowSelectionCols(row, r, sel, w);
    const text = stripTerminalSequences(sliceByColumn(row, c0, Math.max(0, c1 - c0 + 1), true)).trimEnd();
    pieces.push({ text, fromCol0: c0 === 0 });
  }

  // Trim trailing/leading blank spacer rows on whole-row selections only.
  if (sel.mode === "row") {
    while (pieces.length > 1 && pieces[0]!.text === "") pieces.shift();
    while (pieces.length > 1 && pieces[pieces.length - 1]!.text === "") pieces.pop();
  }

  // Remove the common leading indent of rows selected from column 0 (drops Markdown padding, keeps code indent).
  let minIndent = Infinity;
  for (const p of pieces) {
    if (p.fromCol0 && p.text.length > 0) {
      const indent = p.text.length - p.text.trimStart().length;
      if (indent < minIndent) minIndent = indent;
    }
  }
  if (minIndent > 0 && Number.isFinite(minIndent)) {
    for (const p of pieces) {
      if (p.fromCol0 && p.text.length >= minIndent) {
        p.text = p.text.slice(minIndent);
      }
    }
  }

  return pieces.map((p) => p.text).join("\n");
}

/** Highlights inclusive column range `[c0, c1]` of `line` (fitted to `totalW`) with `bg`. */
export function highlightCells(
  line: string,
  c0: number,
  c1: number,
  totalW: number,
  bg: (s: string) => string,
): string {
  const w = Math.max(1, Math.floor(totalW));
  const maxCol = w - 1;
  const start = Math.max(0, Math.min(maxCol, c0));
  const end = Math.max(start, Math.min(maxCol, c1));
  const padded = fit(line, w);
  const before = start > 0 ? sliceByColumn(padded, 0, start, true) : "";
  const selected = sliceByColumn(padded, start, Math.max(0, end - start + 1), true);
  const after = end + 1 < w ? sliceByColumn(padded, end + 1, w - (end + 1), true) : "";
  return `${before}\x1b[0m${bg(stripTerminalSequences(selected))}${after}`;
}
