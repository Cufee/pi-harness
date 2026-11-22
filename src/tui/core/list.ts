import { fuzzyFilter, Input, matchesKey } from "@earendil-works/pi-tui";
import { clamp, fit, sanitizeLine } from "./text.js";
import type { Theme } from "./tokens.js";
import { parseMouseWheel, Viewport } from "./viewport.js";

export interface ListItem<T> {
  id: string;
  value: T;
  /** Searchable text used by `/` fuzzy filter. */
  searchText: string;
  /** Render the row to fit `width` columns (`selected` indicates active cursor). */
  render: (width: number, selected: boolean, theme: Theme) => string;
}

/**
 * Uniform keyboard + mouse-wheel list component used across Work Navigator tabs,
 * Go-To-Anything palette, model/session/KB pickers, and drill-down sub-lists.
 */
export class ListView<T> {
  private allItems: ListItem<T>[] = [];
  private filtered: ListItem<T>[] = [];
  private selectedIdx = 0;
  readonly viewport = new Viewport();
  private filterActive = false;
  private filterInput = new Input();
  private filterQuery = "";
  emptyText = "Nothing here.";

  constructor(opts?: { emptyText?: string }) {
    if (opts?.emptyText) this.emptyText = opts.emptyText;
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

  get isFiltering(): boolean {
    return this.filterActive;
  }

  get query(): string {
    return this.filterQuery;
  }

  startFilter(): void {
    this.filterActive = true;
    this.filterInput.setValue(this.filterQuery);
  }

  clearFilter(): void {
    this.filterActive = false;
    this.filterQuery = "";
    this.filterInput.setValue("");
    this.recomputeFilter(this.selectedItem()?.id);
  }

  selectedItem(): ListItem<T> | undefined {
    return this.filtered[this.selectedIdx];
  }

  selectById(id: string): boolean {
    const idx = this.filtered.findIndex((i) => i.id === id);
    if (idx < 0) return false;
    this.selectedIdx = idx;
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
        this.viewport.ensureVisible(idx);
        return;
      }
    }
    this.selectedIdx = Math.max(0, Math.min(this.selectedIdx, Math.max(0, this.filtered.length - 1)));
    this.viewport.ensureVisible(this.selectedIdx);
  }

  move(delta: number): void {
    if (this.filtered.length === 0) return;
    this.selectedIdx = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIdx + delta));
    this.viewport.ensureVisible(this.selectedIdx);
  }

  /**
   * Handles list navigation and optional `/` fuzzy filtering.
   * Returns `"select"` when Enter is pressed on an item, `"handled"` if consumed, or `"ignored"`.
   */
  handleInput(data: string): "select" | "handled" | "ignored" {
    const wheel = parseMouseWheel(data);
    if (wheel.hadMouse) {
      if (wheel.delta !== 0) this.viewport.scrollBy(wheel.delta);
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
      if (matchesKey(data, "up")) {
        this.move(-1);
        return "handled";
      }
      if (matchesKey(data, "down")) {
        this.move(1);
        return "handled";
      }
      this.filterInput.handleInput(data);
      const nextQ = sanitizeLine(this.filterInput.getValue());
      if (nextQ !== this.filterQuery) {
        this.filterQuery = nextQ;
        this.recomputeFilter();
      }
      return "handled";
    }

    if (data === "/") {
      this.startFilter();
      return "handled";
    }
    if (matchesKey(data, "up") || data === "k") {
      this.move(-1);
      return "handled";
    }
    if (matchesKey(data, "down") || data === "j") {
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
      this.viewport.scrollToTop();
      return "handled";
    }
    if (data === "G" || matchesKey(data, "end")) {
      this.selectedIdx = Math.max(0, this.filtered.length - 1);
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
      const prefix = theme.accentBold("/ ");
      if (this.filterActive) {
        const rendered = this.filterInput.render(Math.max(4, w - 3))[0] ?? "";
        out.push(clamp(`${prefix}${rendered}`, w));
      } else {
        out.push(clamp(`${prefix}${this.filterQuery} ${theme.muted(`(${this.filtered.length}/${this.allItems.length})`)}`, w));
      }
    }

    if (this.filtered.length === 0) {
      const msg = this.filterQuery ? `No matches for "${this.filterQuery}".` : this.emptyText;
      out.push(fit(theme.muted(`  ${msg}`), w));
      return out;
    }

    const rowWidth = this.filtered.length > bodyHeight && w >= 6 ? w - 4 : w - 2;
    const rows = this.filtered.map((item, idx) => {
      const selected = idx === this.selectedIdx;
      const prefix = selected ? theme.accentBold(`${theme.glyphs.pointer} `) : "  ";
      const content = item.render(Math.max(1, rowWidth), selected, theme);
      return selected ? `${prefix}${content}` : `${prefix}${content}`;
    });

    this.viewport.ensureVisible(this.selectedIdx, bodyHeight);
    out.push(...this.viewport.render(rows, w, bodyHeight, theme));
    return out;
  }
}
