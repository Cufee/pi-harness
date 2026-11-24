import { fuzzyFilter, Input, matchesKey } from "@earendil-works/pi-tui";
import { type ColumnSpec, computeColumnLayout, formatColumnRow } from "./layout.js";
import { clamp, fillLineBg, fit, sanitizeLine, visibleWidth } from "./text.js";
import type { Theme } from "./tokens.js";
import { parseMouseWheel, replaceScrollbarRange, Viewport } from "./viewport.js";

export interface ListItem<T> {
  id: string;
  value: T;
  /** Searchable text used by `/` fuzzy filter. */
  searchText: string;
  /** Optional structured cells used when `columns` are configured on the list/table. */
  cells?: (selected: boolean, theme: Theme) => Record<string, string>;
  /** Custom row renderer (used when `columns` are not set). */
  render?: (width: number, selected: boolean, theme: Theme) => string;
}

export interface TableListItem<T> {
  id: string;
  value: T;
  searchText: string;
  cells: (selected: boolean, theme: Theme) => Record<string, string>;
}

/**
 * Uniform keyboard + mouse-wheel list & aligned-table component used across Work Navigator tabs,
 * Go-To-Anything palette, Settings, Model/Session/KB pickers, and drill-down sub-lists.
 *
 * Features:
 *  - Optional `columns: ColumnSpec[]` renders a sticky header + `─` rule above the scrollable viewport
 *    with priority-shedding aligned columns per row.
 *  - Full-width calibrated `badgeBg` highlight (`fillLineBg`) on the selected row alongside `▸ `.
 *  - Decoupled mouse-wheel scrolling so wheel scrolling never snaps back on render until a key moves selection.
 *  - Layered `/` fuzzy filter (`Esc` clears active filter before closing the screen).
 */
export class ListView<T> {
  private allItems: ListItem<T>[] = [];
  private filtered: ListItem<T>[] = [];
  private selectedIdx = 0;
  readonly viewport = new Viewport();
  private filterActive = false;
  private filterInput = new Input();
  private filterQuery = "";
  private wheelScrolled = false;
  private columns: ColumnSpec[] | null = null;
  private columnGap = 2;
  emptyText = "Nothing here.";

  constructor(opts?: { emptyText?: string; columns?: ColumnSpec[]; gap?: number }) {
    if (opts?.emptyText) this.emptyText = opts.emptyText;
    if (opts?.columns) this.columns = opts.columns;
    if (opts?.gap != null) this.columnGap = opts.gap;
  }

  setColumns(columns: ColumnSpec[] | null, gap = 2): void {
    this.columns = columns;
    this.columnGap = gap;
  }

  setItems(items: ListItem<T>[], preserveSelectionId?: string): void {
    const prevId = preserveSelectionId ?? this.selectedItem()?.id;
    this.allItems = items;
    this.recomputeFilter(prevId);
  }

  get items(): readonly ListItem<T>[] {
    return this.filtered;
  }

  get totalCount(): number {
    return this.allItems.length;
  }

  get selectedIndex(): number {
    return this.selectedIdx;
  }

  get isFiltering(): boolean {
    return this.filterActive;
  }

  get query(): string {
    return this.filterQuery;
  }

  startFilter(): void {
    this.filterActive = true;
    this.filterInput.setValue(this.filterQuery);
    if (this.filterQuery) this.filterInput.handleInput("\x05");
  }

  /** Pre-populates a filter query (e.g. from `/kb <query>`) without grabbing typing focus unless requested. */
  setInitialFilter(query: string, activate = false): void {
    const clean = sanitizeLine(query);
    this.filterQuery = clean;
    this.filterInput.setValue(clean);
    if (clean) this.filterInput.handleInput("\x05");
    this.filterActive = activate;
    this.wheelScrolled = false;
    this.recomputeFilter();
  }

  clearFilter(): void {
    this.filterActive = false;
    this.filterQuery = "";
    this.filterInput.setValue("");
    this.wheelScrolled = false;
    this.recomputeFilter(this.selectedItem()?.id);
  }

  /** Layered Escape handler: closes/clears filter if active or non-empty; returns true if consumed. */
  handleEscape(): boolean {
    if (this.filterActive) {
      if (this.filterQuery) this.clearFilter();
      else this.filterActive = false;
      return true;
    }
    if (this.filterQuery) {
      this.clearFilter();
      return true;
    }
    return false;
  }

  selectedItem(): ListItem<T> | undefined {
    return this.filtered[this.selectedIdx];
  }

  selectById(id: string): boolean {
    const idx = this.filtered.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.selectedIdx = idx;
    this.wheelScrolled = false;
    this.viewport.ensureVisible(idx);
    return true;
  }

  private recomputeFilter(preserveId?: string): void {
    const q = this.filterQuery.trim();
    this.filtered = q ? fuzzyFilter(this.allItems, q, (it) => it.searchText) : [...this.allItems];
    if (preserveId) {
      const idx = this.filtered.findIndex((i) => i.id === preserveId);
      if (idx >= 0) {
        this.selectedIdx = idx;
        if (!this.wheelScrolled) this.viewport.ensureVisible(idx);
        return;
      }
    }
    this.selectedIdx = Math.max(0, Math.min(this.selectedIdx, Math.max(0, this.filtered.length - 1)));
    if (!this.wheelScrolled) this.viewport.ensureVisible(this.selectedIdx);
  }

  move(delta: number): void {
    if (this.filtered.length === 0) return;
    this.selectedIdx = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIdx + delta));
    this.wheelScrolled = false;
    this.viewport.ensureVisible(this.selectedIdx);
  }

  /**
   * Handles list navigation and optional `/` fuzzy filtering.
   * Returns `"select"` when Enter is pressed on an item, `"handled"` if consumed, or `"ignored"`.
   */
  handleInput(data: string): "select" | "handled" | "ignored" {
    const wheel = parseMouseWheel(data);
    if (wheel.hadMouse) {
      if (wheel.delta !== 0) {
        this.wheelScrolled = true;
        this.viewport.scrollBy(wheel.delta);
        if (this.filtered.length > 0 && this.viewport.lastHeight > 0) {
          const minVis = this.viewport.offset;
          const maxVis = Math.min(this.filtered.length - 1, this.viewport.offset + this.viewport.lastHeight - 1);
          if (this.selectedIdx < minVis) this.selectedIdx = minVis;
          else if (this.selectedIdx > maxVis) this.selectedIdx = maxVis;
        }
      }
      return "handled";
    }

    if (this.filterActive) {
      if (matchesKey(data, "escape")) {
        if (this.filterQuery) {
          this.clearFilter();
        } else {
          this.filterActive = false;
        }
        return "handled";
      }
      if (matchesKey(data, "enter") || matchesKey(data, "return")) {
        this.filterActive = false;
        return this.filtered.length > 0 ? "select" : "handled";
      }
      if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
        this.move(-1);
        return "handled";
      }
      if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
        this.move(1);
        return "handled";
      }
      this.filterInput.handleInput(data);
      const nextQ = sanitizeLine(this.filterInput.getValue());
      if (nextQ !== this.filterQuery) {
        this.filterQuery = nextQ;
        this.wheelScrolled = false;
        this.recomputeFilter();
      }
      return "handled";
    }

    if (data === "/") {
      this.startFilter();
      return "handled";
    }
    if (matchesKey(data, "up") || data === "k" || matchesKey(data, "ctrl+p")) {
      this.move(-1);
      return "handled";
    }
    if (matchesKey(data, "down") || data === "j" || matchesKey(data, "ctrl+n")) {
      this.move(1);
      return "handled";
    }
    if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.move(-Math.max(1, this.viewport.lastHeight - 2));
      return "handled";
    }
    if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.move(Math.max(1, this.viewport.lastHeight - 2));
      return "handled";
    }
    if (data === "g" || matchesKey(data, "home")) {
      this.selectedIdx = 0;
      this.wheelScrolled = false;
      this.viewport.scrollToTop();
      return "handled";
    }
    if (data === "G" || matchesKey(data, "end")) {
      this.selectedIdx = Math.max(0, this.filtered.length - 1);
      this.wheelScrolled = false;
      this.viewport.ensureVisible(this.selectedIdx);
      return "handled";
    }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) {
      return this.filtered.length > 0 ? "select" : "handled";
    }
    return "ignored";
  }

  render(width: number, height: number, theme: Theme): string[] {
    const w = Math.max(4, Math.floor(width));
    const h = Math.max(1, Math.floor(height));
    const out: string[] = [];

    let bodyHeight = h;
    if (this.filterActive || this.filterQuery) {
      bodyHeight = Math.max(1, h - 1);
      if (this.filterActive) {
        const countTag = this.filterQuery ? ` ${theme.dim(`(${this.filtered.length}/${this.allItems.length})`)}` : "";
        const inpW = Math.max(4, w - 3 - visibleWidth(countTag));
        const rendered = (this.filterInput.render(inpW)[0] ?? "").replace(/^>\s?/, "").trimEnd();
        out.push(clamp(`${theme.accentBold("/ ")}${rendered}${countTag}`, w));
      } else {
        out.push(
          clamp(
            `${theme.accentBold("/ ")}${this.filterQuery} ${theme.muted(`(${this.filtered.length}/${this.allItems.length}) · Esc clear`)}`,
            w,
          ),
        );
      }
    }

    const hasColumns = Boolean(this.columns && this.columns.length > 0);
    const hasHeader = hasColumns && this.columns!.some((c) => c.header) && bodyHeight >= 3;

    // Reserve scrollbar gutter width consistently between sticky header and rows
    const estRowsHeight = hasHeader ? Math.max(1, bodyHeight - 2) : bodyHeight;
    const needsScrollbar = this.filtered.length > estRowsHeight && w >= 6;
    const viewportBodyW = needsScrollbar ? w - 2 : w;
    const contentWidth = Math.max(1, viewportBodyW - 2); // 2-col pointer prefix ("▸ " / "  ")

    const colLayout = hasColumns ? computeColumnLayout(this.columns!, contentWidth, this.columnGap) : null;

    if (hasHeader && colLayout) {
      bodyHeight = Math.max(1, bodyHeight - 2);
      const hdrCells: Record<string, string> = {};
      for (const c of colLayout.active) hdrCells[c.key] = c.header ?? "";
      const hdrLine = formatColumnRow(colLayout, hdrCells, (s) => theme.dim(theme.bold(s)));
      out.push(clamp(`  ${hdrLine}`, w));
      out.push(theme.border(theme.glyphs.barH.repeat(w)));
    }

    if (this.filtered.length === 0) {
      const msg = this.filterQuery ? `No matches for "${this.filterQuery}".` : this.emptyText;
      out.push(fit(theme.muted(`  ${msg}`), w));
      return out;
    }

    const rows = this.filtered.map((item, idx) => {
      const selected = idx === this.selectedIdx;
      const prefix = selected ? theme.accentBold(`${theme.glyphs.pointer} `) : "  ";
      let content: string;
      if (colLayout && item.cells) {
        content = formatColumnRow(colLayout, item.cells(selected, theme));
      } else if (item.render) {
        content = item.render(contentWidth, selected, theme);
      } else {
        content = fit(sanitizeLine(item.searchText), contentWidth);
      }
      const row = `${prefix}${content}`;
      return selected ? fillLineBg(row, viewportBodyW, theme.badgeBg) : clamp(row, viewportBodyW);
    });

    if (!this.wheelScrolled) {
      this.viewport.ensureVisible(this.selectedIdx, bodyHeight);
    }
    const vpStart = out.length;
    const vpLines = this.viewport.render(rows, w, bodyHeight, theme);
    out.push(...vpLines);
    if (this.viewport.lastScrollbarWidth > 0 && vpLines.length > 0) {
      replaceScrollbarRange(vpLines, {
        lines: out,
        start: vpStart,
        count: vpLines.length,
        contentWidth: this.viewport.lastBodyWidth,
      });
    }
    return out;
  }
}

/**
 * Convenience typed alias/subclass of `ListView<T>` configured with sticky aligned columns.
 */
export class TableListView<T> extends ListView<T> {
  constructor(opts: { columns: ColumnSpec[]; emptyText?: string; gap?: number }) {
    super(opts);
  }

  setTableItems(items: TableListItem<T>[], preserveSelectionId?: string): void {
    this.setItems(items, preserveSelectionId);
  }
}
