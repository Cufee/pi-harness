import { matchesKey } from "@earendil-works/pi-tui";
import { type Hint, yankText } from "./keymap.js";
import type { ScreenContext } from "./navigator.js";
import { clamp, fillLineBg, fit, sliceByColumn, stripTerminalSequences, visibleWidth } from "./text.js";
import type { Theme, Tone } from "./tokens.js";
import {
  blockSourceText,
  defaultFold,
  type FoldState,
  isFoldable,
  nextFold,
  renderTranscriptBlock,
  type TranscriptBlock,
} from "./transcript-blocks.js";
import { parseMouseWheel, type ScreenMouseEvent, Viewport } from "./viewport.js";

export interface ViewBlock {
  id: number;
  rev: number;
  open?: boolean;
  block: TranscriptBlock;
  payload?: unknown;
}

export type BodyMouseEvent = ScreenMouseEvent;

export interface TranscriptViewOptions {
  follow?: boolean;
  emptyText?: string;
  notify?: (text: string, tone: Tone) => void;
  onInspect?: (block: ViewBlock) => void;
}

interface CachedBlockRows {
  rev: number;
  width: number;
  fold: FoldState;
  color: boolean;
  rows: string[];
}

interface LayoutEntry {
  block: ViewBlock;
  fold: FoldState;
  rows: string[];
  start: number;
}

interface BlockPos {
  blockId: number;
  row: number;
}

interface CellPos extends BlockPos {
  col: number;
}

interface ReadAnchor {
  blockId: number;
  row: number;
  rowsAtCapture: number;
  widthAtCapture: number;
}

interface NormalizedSelection {
  mode: "row" | "cell";
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Snaps inclusive cell range `[c0, c1]` outward to whole grapheme boundaries on `row`. */
function snapCellRange(row: string, c0: number, c1: number, contentW: number): { c0: number; c1: number } {
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

export class TranscriptView {
  private readonly viewport: Viewport;
  private readonly followCapable: boolean;
  private readonly emptyText: string;
  private readonly notify?: (text: string, tone: Tone) => void;
  private readonly onInspect?: (block: ViewBlock) => void;

  private readonly rowCache = new Map<number, CachedBlockRows>();
  private readonly folds = new Map<number, FoldState>();

  private entries: LayoutEntry[] = [];
  private indexById = new Map<number, number>();
  private totalRows = 0;

  private lastInnerWidth = 0;
  private lastContentWidth = 0;
  private lastBodyHeight = 10;
  private lastDrawnRows = 0;

  private cursor: BlockPos | null = null;
  private selMode: "none" | "row" | "cell" = "none";
  private selAnchor: CellPos | null = null;
  private selHead: CellPos | null = null;
  private dragging = false;
  private dragStart: { x: number; y: number } | null = null;

  private readAnchor: ReadAnchor | null = null;
  private pausedAtRows = 0;
  private revealBlockId: number | null = null;

  constructor(
    private readonly source: () => readonly ViewBlock[],
    opts?: TranscriptViewOptions,
  ) {
    this.followCapable = Boolean(opts?.follow);
    this.viewport = new Viewport({ follow: this.followCapable });
    this.emptyText = opts?.emptyText ?? "Empty";
    this.notify = opts?.notify;
    this.onInspect = opts?.onInspect;
  }

  get hasSelection(): boolean {
    return this.selMode !== "none" && this.selAnchor !== null && this.selHead !== null;
  }

  scrollToTop(): void {
    this.clearSelection();
    this.cursor = null;
    this.readAnchor = null;
    this.viewport.scrollToTop();
  }

  /** "live", "paused 12-31/84", "+N new · End resumes ...", shortened to fit `room`. */
  status(theme: Theme, room: number): string {
    const budget = Math.max(4, Math.floor(room));
    if (!this.followCapable) {
      const st = this.viewport.statusText();
      return st ? theme.muted(clamp(st, budget)) : "";
    }
    if (this.viewport.follow) {
      return theme.ok(`${theme.glyphs.running} live`);
    }
    const newRows = Math.max(0, this.totalRows - this.pausedAtRows);
    const st = this.viewport.statusText();
    const variants = [
      newRows > 0 ? `+${newRows} new · End resumes${st ? ` ${st}` : ""}` : st ? `paused ${st}` : "paused",
      newRows > 0 ? `+${newRows} new · End` : st ? `paused ${st}` : "paused",
      newRows > 0 ? `+${newRows} new` : "paused",
    ];
    const text = variants.find((v) => visibleWidth(v) <= budget) ?? variants[variants.length - 1]!;
    return newRows > 0 ? theme.warn(text) : theme.muted(text);
  }

  hints(): Hint[] {
    const hasFoldable = this.entries.some((e) => isFoldable(e.block.block));
    return [
      { key: "Esc", label: this.hasSelection ? "clear" : "close" },
      { key: "drag", label: "copy" },
      { key: "y", label: "copy" },
      ...(hasFoldable || this.followCapable ? [{ key: "⏎", label: "fold" }] : []),
      { key: "↑↓", label: "cursor" },
      ...(this.onInspect ? [{ key: "Ctrl+X", label: "inspect" }] : []),
      ...(this.followCapable
        ? [{ key: "f/End", label: this.viewport.follow ? "follow:on" : "follow:off" }]
        : []),
      { key: "v/⇧↑↓", label: this.hasSelection ? "selecting" : "select" },
      { key: "PgUp/PgDn/wheel", label: "scroll" },
      { key: "Y", label: "copy all" },
    ];
  }

  /* ── position & range helpers ── */

  private entryById(blockId: number): LayoutEntry | undefined {
    const idx = this.indexById.get(blockId);
    return idx !== undefined ? this.entries[idx] : undefined;
  }

  private globalRowToPos(globalRow: number): BlockPos | null {
    if (this.entries.length === 0 || this.totalRows === 0) return null;
    const clamped = Math.max(0, Math.min(this.totalRows - 1, globalRow));
    let lo = 0;
    let hi = this.entries.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.entries[mid]!.start <= clamped) lo = mid;
      else hi = mid - 1;
    }
    const entry = this.entries[lo]!;
    return {
      blockId: entry.block.id,
      row: Math.max(0, Math.min(entry.rows.length - 1, clamped - entry.start)),
    };
  }

  private posToGlobalRow(pos: BlockPos | null): number {
    if (!pos) return -1;
    const entry = this.entryById(pos.blockId);
    if (!entry) return -1;
    return entry.start + Math.max(0, Math.min(entry.rows.length - 1, pos.row));
  }

  private rawRowAt(globalRow: number): string {
    const pos = this.globalRowToPos(globalRow);
    if (!pos) return "";
    return this.entryById(pos.blockId)?.rows[pos.row] ?? "";
  }

  private clearSelection(): void {
    this.selMode = "none";
    this.selAnchor = null;
    this.selHead = null;
    this.dragStart = null;
  }

  private normalizedSelection(): NormalizedSelection | null {
    if (this.selMode === "none" || !this.selAnchor || !this.selHead) return null;
    const aRow = this.posToGlobalRow(this.selAnchor);
    const hRow = this.posToGlobalRow(this.selHead);
    if (aRow < 0 || hRow < 0) return null;
    if (aRow < hRow || (aRow === hRow && this.selAnchor.col <= this.selHead.col)) {
      return {
        mode: this.selMode,
        startRow: aRow,
        endRow: hRow,
        startCol: this.selAnchor.col,
        endCol: this.selHead.col,
      };
    }
    return {
      mode: this.selMode,
      startRow: hRow,
      endRow: aRow,
      startCol: this.selHead.col,
      endCol: this.selAnchor.col,
    };
  }

  private rowSelectionCols(
    row: string,
    globalRow: number,
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
    } else if (globalRow === sel.startRow) {
      rawStart = Math.min(sel.startCol, maxCol);
      rawEnd = maxCol;
    } else if (globalRow === sel.endRow) {
      rawStart = 0;
      rawEnd = Math.min(sel.endCol, maxCol);
    } else {
      return { c0: 0, c1: maxCol };
    }
    return snapCellRange(row, rawStart, rawEnd, contentW);
  }

  /* ── read anchor & follow ── */

  private captureAnchor(): void {
    const pos = this.globalRowToPos(this.viewport.offset);
    if (!pos) return;
    const entry = this.entryById(pos.blockId);
    if (!entry || entry.rows.length === 0) return;
    this.readAnchor = {
      blockId: pos.blockId,
      row: pos.row,
      rowsAtCapture: entry.rows.length,
      widthAtCapture: this.lastContentWidth,
    };
  }

  private restoreAnchor(): void {
    const anchor = this.readAnchor;
    if (!anchor || this.entries.length === 0) return;
    const entry = this.entryById(anchor.blockId);
    if (entry) {
      const count = entry.rows.length;
      if (this.lastContentWidth === anchor.widthAtCapture) {
        anchor.rowsAtCapture = count;
        this.viewport.offset = entry.start + Math.max(0, Math.min(count - 1, anchor.row));
        return;
      }
      const mapped =
        count === anchor.rowsAtCapture
          ? Math.min(count - 1, anchor.row)
          : Math.min(count - 1, Math.floor((anchor.row * count) / Math.max(1, anchor.rowsAtCapture)));
      this.viewport.offset = entry.start + Math.max(0, mapped);
      return;
    }
    // Missing (trimmed) block: fall back to the nearest surviving later block's row 0.
    const nextEntry = this.entries.find((e) => e.block.id > anchor.blockId);
    this.viewport.offset = nextEntry ? nextEntry.start : 0;
  }

  private pause(): void {
    if (!this.viewport.follow) return;
    this.viewport.follow = false;
    this.pausedAtRows = this.totalRows;
  }

  private resume(): void {
    if (!this.followCapable) return;
    this.viewport.follow = true;
    this.viewport.scrollToBottom(true);
    this.readAnchor = null;
    if (!this.hasSelection) this.cursor = null;
  }

  private revealRange(start: number, end: number, height: number): void {
    const h = Math.max(1, height);
    if (start < this.viewport.offset) {
      this.viewport.offset = Math.max(0, start);
    } else if (end >= this.viewport.offset + h) {
      this.viewport.offset = Math.max(0, Math.min(start, end - h + 1));
    }
  }

  private revealBlock(blockId: number, height: number): void {
    const entry = this.entryById(blockId);
    if (!entry) return;
    this.revealRange(entry.start, entry.start + entry.rows.length - 1, height);
  }

  /* ── folding & selection copy ── */

  private toggleBlockFold(vb: ViewBlock): void {
    const cur = this.folds.get(vb.id) ?? defaultFold(vb.block);
    const next = nextFold(vb.block, cur);
    if (next === cur) return;
    this.folds.set(vb.id, next);
    if (
      this.selMode === "cell" &&
      (this.selAnchor?.blockId === vb.id || this.selHead?.blockId === vb.id)
    ) {
      this.clearSelection();
    }
    if (this.cursor?.blockId === vb.id) {
      this.cursor = { blockId: vb.id, row: 0 };
    }
    if (!this.viewport.follow && this.readAnchor?.blockId === vb.id) {
      this.readAnchor = {
        blockId: vb.id,
        row: 0,
        rowsAtCapture: 1,
        widthAtCapture: this.lastContentWidth,
      };
    }
    this.revealBlockId = vb.id;
  }

  private extractSelectionText(): string {
    const sel = this.normalizedSelection();
    if (!sel) return "";
    const contentW = Math.max(1, this.lastContentWidth);
    const pieces: Array<{ text: string; fromCol0: boolean }> = [];

    for (let g = sel.startRow; g <= sel.endRow; g++) {
      const row = this.rawRowAt(g);
      const { c0, c1 } = this.rowSelectionCols(row, g, sel, contentW);
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

  private allSourceText(): string {
    return this.source()
      .map((vb) => blockSourceText(vb.block))
      .filter((t) => t.length > 0)
      .join("\n\n");
  }

  /* ── rendering ── */

  /** Body rows: 2-column gutter + block rows + scrollbar, exactly as Frame.renderBody expects. */
  render(width: number, height: number, theme: Theme): string[] {
    const innerW = Math.max(4, Math.floor(width));
    const bodyH = Math.max(1, Math.floor(height));
    // Reserve the 2-column scrollbar gutter up front so rows never re-wrap when the scrollbar appears.
    const rowW = innerW >= 6 ? innerW - 2 : innerW;
    const contentW = Math.max(1, rowW - 2);

    const widthChanged = this.lastContentWidth > 0 && this.lastContentWidth !== contentW;
    if (widthChanged) {
      if (this.selMode === "cell" || this.dragging) {
        this.clearSelection();
      }
      this.dragging = false;
      this.dragStart = null;
    }
    this.lastInnerWidth = innerW;
    this.lastContentWidth = contentW;
    this.lastBodyHeight = bodyH;

    const blocks = this.source();
    if (blocks.length === 0) {
      this.entries = [];
      this.indexById.clear();
      this.totalRows = 0;
      this.lastDrawnRows = 0;
      this.rowCache.clear();
      this.folds.clear();
      return [clamp(theme.muted(this.emptyText), innerW)];
    }

    const seenIds = new Set<number>();
    const entries: LayoutEntry[] = [];
    const indexById = new Map<number, number>();
    let totalRows = 0;
    let foldRowDelta = 0;

    for (const vb of blocks) {
      seenIds.add(vb.id);
      const fold = this.folds.get(vb.id) ?? defaultFold(vb.block);
      const prev = this.rowCache.get(vb.id);
      let cached = prev;
      if (
        !cached ||
        cached.rev !== vb.rev ||
        cached.width !== contentW ||
        cached.fold !== fold ||
        cached.color !== theme.color
      ) {
        const rows = renderTranscriptBlock(vb.block, contentW, theme, fold);
        if (prev && prev.width === contentW && prev.fold !== fold) {
          const prevLen =
            prev.rev === vb.rev
              ? prev.rows.length
              : renderTranscriptBlock(vb.block, contentW, theme, prev.fold).length;
          foldRowDelta += rows.length - prevLen;
        }
        cached = { rev: vb.rev, width: contentW, fold, color: theme.color, rows };
        this.rowCache.set(vb.id, cached);
      }
      if (cached.rows.length === 0) continue;
      indexById.set(vb.id, entries.length);
      entries.push({ block: vb, fold, rows: cached.rows, start: totalRows });
      totalRows += cached.rows.length;
    }

    for (const id of this.rowCache.keys()) {
      if (!seenIds.has(id)) {
        this.rowCache.delete(id);
        this.folds.delete(id);
      }
    }

    this.entries = entries;
    this.indexById = indexById;
    this.totalRows = totalRows;

    if (totalRows === 0) {
      this.lastDrawnRows = 0;
      return [clamp(theme.muted(this.emptyText), innerW)];
    }

    if (!this.viewport.follow) {
      if (widthChanged) {
        this.pausedAtRows = totalRows;
      } else if (foldRowDelta !== 0) {
        this.pausedAtRows += foldRowDelta;
      }
    }

    // Clamp cursor / selection endpoints if blocks shrunk or vanished.
    if (this.cursor) {
      const e = this.entryById(this.cursor.blockId);
      if (!e) {
        this.cursor = null;
        this.clearSelection();
      } else if (this.cursor.row >= e.rows.length) {
        this.cursor = { blockId: e.block.id, row: e.rows.length - 1 };
      }
    }
    if (this.selAnchor && !this.entryById(this.selAnchor.blockId)) this.clearSelection();
    if (this.selHead && !this.entryById(this.selHead.blockId)) this.clearSelection();

    // Restore read position before viewport slicing (never re-capture after restore to avoid resize drift).
    if (!this.viewport.follow) {
      if (this.readAnchor) {
        this.restoreAnchor();
      }
      if (this.revealBlockId !== null) {
        const beforeReveal = this.viewport.offset;
        this.revealBlock(this.revealBlockId, bodyH);
        if (this.viewport.offset !== beforeReveal) {
          this.captureAnchor();
        }
      }
    }
    this.revealBlockId = null;

    const cursorGlobal = this.posToGlobalRow(this.cursor);
    const sel = this.normalizedSelection();
    const g = theme.glyphs;

    const displayRows: string[] = [];
    for (const entry of entries) {
      for (let r = 0; r < entry.rows.length; r++) {
        const globalRow = entry.start + r;
        const raw = entry.rows[r]!;
        const isCursor = globalRow === cursorGlobal;
        const inSel = sel !== null && globalRow >= sel.startRow && globalRow <= sel.endRow;
        const gutter = isCursor
          ? `${theme.accent(g.pointer)} `
          : inSel
            ? `${theme.accent(g.rail)} `
            : "  ";

        if (inSel && sel.mode === "cell") {
          if (!theme.color) {
            displayRows.push(clamp(gutter + raw, rowW));
          } else {
            const { c0, c1 } = this.rowSelectionCols(raw, globalRow, sel, contentW);
            const padded = fit(raw, contentW);
            const before = c0 > 0 ? sliceByColumn(padded, 0, c0, true) : "";
            const selected = sliceByColumn(padded, c0, Math.max(0, c1 - c0 + 1), true);
            const after = c1 + 1 < contentW ? sliceByColumn(padded, c1 + 1, contentW - (c1 + 1), true) : "";
            const styled = `${before}\x1b[0m${theme.badgeBg(stripTerminalSequences(selected))}${after}`;
            displayRows.push(clamp(gutter + styled, rowW));
          }
        } else if (inSel || isCursor) {
          displayRows.push(fillLineBg(gutter + raw, rowW, theme.badgeBg));
        } else {
          displayRows.push(clamp(gutter + raw, rowW));
        }
      }
    }

    const rendered = this.viewport.render(displayRows, innerW, bodyH, theme);
    this.lastDrawnRows = rendered.length;
    return rendered;
  }

  /* ── keyboard input ── */

  private moveCursor(delta: number, extend: boolean): void {
    if (this.totalRows === 0) return;
    let cur = this.posToGlobalRow(this.cursor);
    const fresh = cur < 0;
    if (fresh) {
      if (this.viewport.follow || delta < 0) {
        cur = Math.min(this.totalRows - 1, this.viewport.offset + this.lastBodyHeight - 1);
      } else {
        cur = Math.min(this.totalRows - 1, this.viewport.offset);
      }
    }
    if (extend) {
      if (this.selMode !== "row") {
        const anchorPos = this.globalRowToPos(cur)!;
        this.selMode = "row";
        this.selAnchor = { ...anchorPos, col: 0 };
      }
    } else if (this.selMode === "cell") {
      this.clearSelection();
    }

    if (!fresh) {
      cur = Math.max(0, Math.min(this.totalRows - 1, cur + delta));
    }

    // Skip blank spacer rows when stepping so cursor lands on real content.
    const dir = delta < 0 ? -1 : 1;
    let next = cur;
    while (stripTerminalSequences(this.rawRowAt(next)).trim() === "" && next + dir >= 0 && next + dir < this.totalRows) {
      next += dir;
    }
    if (stripTerminalSequences(this.rawRowAt(next)).trim() !== "") {
      cur = next;
    }

    const pos = this.globalRowToPos(cur);
    if (!pos) return;
    this.cursor = pos;
    if (this.selMode === "row") {
      this.selHead = { ...pos, col: 0 };
    }
    this.pause();
    this.revealRange(cur, cur, this.lastBodyHeight);
    this.captureAnchor();
  }

  /** True when the key was consumed. Esc clears a selection before the screen pops. */
  handleKey(data: string, ctx: ScreenContext): boolean {
    if (matchesKey(data, "escape")) {
      if (this.hasSelection) {
        this.clearSelection();
        return true;
      }
      return false;
    }

    const wheel = parseMouseWheel(data);
    if (wheel.hadMouse) {
      if (wheel.delta < 0) this.pause();
      if (wheel.delta !== 0 && !this.viewport.follow) {
        this.viewport.scrollBy(wheel.delta);
        this.captureAnchor();
      }
      return true;
    }

    const extend = matchesKey(data, "shift+up") || matchesKey(data, "shift+down") || data === "K" || data === "J";
    const up = extend ? matchesKey(data, "shift+up") || data === "K" : matchesKey(data, "up") || data === "k";
    if (extend || up || matchesKey(data, "down") || data === "j") {
      this.moveCursor(up ? -1 : 1, extend);
      return true;
    }

    if (data === "v") {
      if (this.hasSelection) {
        this.clearSelection();
      } else if (this.totalRows > 0) {
        if (this.posToGlobalRow(this.cursor) < 0) {
          this.moveCursor(0, false);
        }
        if (this.cursor) {
          this.selMode = "row";
          this.selAnchor = { ...this.cursor, col: 0 };
          this.selHead = { ...this.cursor, col: 0 };
        }
      }
      return true;
    }

    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.pause();
      this.viewport.pageUp();
      this.captureAnchor();
      return true;
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      if (!this.viewport.follow) {
        this.viewport.pageDown();
        this.captureAnchor();
      }
      return true;
    }
    if (matchesKey(data, "home") || data === "g") {
      this.pause();
      this.viewport.scrollToTop();
      this.captureAnchor();
      return true;
    }
    if (matchesKey(data, "end") || data === "G") {
      if (this.followCapable) {
        this.resume();
      } else {
        this.viewport.scrollToBottom(false);
        this.captureAnchor();
      }
      return true;
    }
    if (data === "f" && this.followCapable) {
      if (this.viewport.follow) {
        this.pause();
        this.captureAnchor();
      } else {
        this.resume();
      }
      return true;
    }

    if (matchesKey(data, "enter") || matchesKey(data, "return") || data === " ") {
      const entry = this.cursor ? this.entryById(this.cursor.blockId) : undefined;
      if (!entry || !isFoldable(entry.block.block)) {
        this.notify?.("Move the cursor (↑↓) onto a tool, thinking, or assistant block to fold", "info");
      } else {
        this.toggleBlockFold(entry.block);
      }
      return true;
    }

    if (matchesKey(data, "ctrl+x") && this.onInspect) {
      const entry = this.cursor
        ? this.entryById(this.cursor.blockId)
        : this.entries[this.entries.length - 1];
      if (entry) {
        this.onInspect(entry.block);
      } else {
        this.notify?.("No block to inspect", "info");
      }
      return true;
    }

    if (data === "y") {
      if (this.hasSelection) {
        const text = this.extractSelectionText();
        if (text) {
          yankText(text, ctx.writeTerminal);
          this.notify?.(`Copied ${text.length} char${text.length === 1 ? "" : "s"}`, "ok");
        }
        return true;
      }
      const entry = this.cursor ? this.entryById(this.cursor.blockId) : undefined;
      if (entry) {
        const text = blockSourceText(entry.block.block);
        if (text) {
          yankText(text, ctx.writeTerminal);
          this.notify?.(`Copied ${text.length} char${text.length === 1 ? "" : "s"}`, "ok");
        }
        return true;
      }
      const all = this.allSourceText();
      if (all) {
        yankText(all, ctx.writeTerminal);
        this.notify?.("Copied transcript", "ok");
      }
      return true;
    }

    if (data === "Y") {
      const all = this.allSourceText();
      if (all) {
        yankText(all, ctx.writeTerminal);
        this.notify?.("Copied transcript", "ok");
      }
      return true;
    }

    return false;
  }

  /* ── mouse input ── */

  private toContentCol(x: number): number {
    const maxCol = Math.max(0, this.lastContentWidth - 1);
    return Math.max(0, Math.min(maxCol, x - 2));
  }

  private bodyRowToPos(y: number): BlockPos | null {
    if (this.totalRows === 0) return null;
    const clampedY = Math.max(0, Math.min(this.lastBodyHeight - 1, y));
    const globalRow = Math.max(0, Math.min(this.totalRows - 1, this.viewport.offset + clampedY));
    return this.globalRowToPos(globalRow);
  }

  /** Coordinates are relative to the top-left cell of the last rendered body. */
  handleMouse(ev: BodyMouseEvent, ctx: ScreenContext): void {
    if (ev.type === "wheel") {
      if (ev.wheelDelta < 0) this.pause();
      if (ev.wheelDelta !== 0 && !this.viewport.follow) {
        this.viewport.scrollBy(ev.wheelDelta);
        this.captureAnchor();
      }
      return;
    }

    if (this.totalRows === 0) return;

    if (ev.type === "press") {
      if (ev.button !== "left") return;
      const contentEnd = Math.min(this.lastInnerWidth, 2 + this.lastContentWidth);
      if (ev.y < 0 || ev.y >= this.lastDrawnRows || ev.x < 2 || ev.x >= contentEnd) return;
      const globalRow = this.viewport.offset + ev.y;
      if (globalRow < 0 || globalRow >= this.totalRows) return;
      const pos = this.globalRowToPos(globalRow);
      if (!pos) return;
      this.clearSelection();
      const col = this.toContentCol(ev.x);
      this.dragging = true;
      this.dragStart = { x: ev.x, y: ev.y };
      this.cursor = { blockId: pos.blockId, row: pos.row };
      this.selAnchor = { blockId: pos.blockId, row: pos.row, col };
      this.selHead = { blockId: pos.blockId, row: pos.row, col };
      return;
    }

    if (ev.type === "drag") {
      if (!this.dragging || !this.selAnchor) return;
      if (this.viewport.follow) {
        this.pause();
        this.captureAnchor();
      }
      if (ev.y < 0) {
        this.pause();
        this.viewport.scrollBy(-1);
        this.captureAnchor();
      } else if (ev.y >= this.lastBodyHeight) {
        this.pause();
        this.viewport.scrollBy(1);
        this.captureAnchor();
      }
      const pos = this.bodyRowToPos(ev.y);
      if (!pos) return;
      const col = this.toContentCol(ev.x);
      this.selHead = { blockId: pos.blockId, row: pos.row, col };
      this.cursor = { blockId: pos.blockId, row: pos.row };
      if (
        this.selHead.blockId !== this.selAnchor.blockId ||
        this.selHead.row !== this.selAnchor.row ||
        this.selHead.col !== this.selAnchor.col ||
        (this.dragStart !== null && (ev.x !== this.dragStart.x || ev.y !== this.dragStart.y))
      ) {
        this.selMode = "cell";
      }
      return;
    }

    if (ev.type === "release") {
      if (!this.dragging || !this.selAnchor) return;
      const dragStart = this.dragStart;
      this.dragging = false;
      this.dragStart = null;
      const pos = this.bodyRowToPos(ev.y);
      if (pos) {
        const col = this.toContentCol(ev.x);
        this.selHead = { blockId: pos.blockId, row: pos.row, col };
        this.cursor = { blockId: pos.blockId, row: pos.row };
      }
      const head = this.selHead ?? this.selAnchor;
      const moved =
        head.blockId !== this.selAnchor.blockId ||
        head.row !== this.selAnchor.row ||
        head.col !== this.selAnchor.col ||
        (dragStart !== null && (ev.x !== dragStart.x || ev.y !== dragStart.y));

      if (moved) {
        this.selMode = "cell";
        const text = this.extractSelectionText();
        if (text) {
          yankText(text, ctx.writeTerminal);
          this.notify?.(`Copied ${text.length} char${text.length === 1 ? "" : "s"}`, "ok");
        }
        return;
      }

      // Click (press and release on the same cell): toggle fold on a foldable block's header row only.
      this.clearSelection();
      const entry = this.entryById(head.blockId);
      if (entry && isFoldable(entry.block.block)) {
        const headerRow = entry.rows[0] === "" && entry.rows.length > 1 ? 1 : 0;
        if (head.row === headerRow) {
          this.toggleBlockFold(entry.block);
          return;
        }
      }
      // Click elsewhere keeps cursor there and pauses follow if live.
      if (this.viewport.follow) {
        this.pause();
        this.captureAnchor();
      }
    }
  }
}
