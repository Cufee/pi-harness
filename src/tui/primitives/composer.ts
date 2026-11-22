import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  type SlashCommand,
  type TUI,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type { HarnessTheme } from "./theme.js";
import { clampLine, fitWidth } from "./width.js";

export interface ComposerOptions {
  placeholder?: string;
  slashCommands?: SlashCommand[];
  cwd?: string;
  autocompleteMaxVisible?: number;
  maxRows?: (width: number) => number;
}

/**
 * Rich multiline input composer built on `pi-tui`'s `Editor`:
 * - Prompt chevron (`› `) inside the left padding (exact width preserved)
 * - Dimmed placeholder when empty
 * - Native `/` slash-command and `@` workspace-file autocomplete via `CombinedAutocompleteProvider`
 * - Prompt history (`Up`/`Down`), multiline (`Shift+Enter`), paste folding, undo, and kill-ring
 */
export class Composer extends Editor {
  private placeholder: string;
  private sourceRows?: number[];
  private selectedLine = "";

  constructor(
    tui: TUI,
    private readonly harnessTheme: HarnessTheme,
    private readonly opts: ComposerOptions = {},
  ) {
    const editorTheme = harnessTheme.toEditorTheme();
    super(tui, editorTheme, {
      paddingX: 2,
      autocompleteMaxVisible: opts.autocompleteMaxVisible ?? 6,
    });
    // Locate the native selection in the rendered rows without interpreting
    // its arrow, ANSI colors, or the editor's private picker state.
    const paintSelected = editorTheme.selectList.selectedText;
    editorTheme.selectList.selectedText = (text) => (this.selectedLine = paintSelected(text));
    this.placeholder = opts.placeholder ?? "";

    if (opts.slashCommands || opts.cwd) {
      this.setAutocompleteProvider(
        new CombinedAutocompleteProvider(opts.slashCommands ?? [], opts.cwd ?? process.cwd()),
      );
    }
  }

  setPlaceholder(text: string): void {
    this.placeholder = text;
    this.tui.requestRender();
  }

  clear(): void {
    this.setText("");
  }

  isAutocompleteOpen(): boolean {
    return this.isShowingAutocomplete();
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    const paint = this.focused ? this.harnessTheme.borderFocused : this.harnessTheme.border;
    if (hiddenLineCount > 0) {
      const label = ` ↑ ${hiddenLineCount} more `;
      const rem = Math.max(0, width - 2 - label.length);
      return clampLine(paint("──") + this.harnessTheme.dim(label) + paint("─".repeat(rem)), width);
    }
    return paint("─".repeat(width));
  }

  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    const paint = this.harnessTheme.border;
    if (hiddenLineCount > 0) {
      const label = ` ↓ ${hiddenLineCount} more `;
      const rem = Math.max(0, width - 2 - label.length);
      return clampLine(paint("──") + this.harnessTheme.dim(label) + paint("─".repeat(rem)), width);
    }
    return paint("─".repeat(width));
  }

  override render(width: number): string[] {
    this.sourceRows = undefined;
    this.selectedLine = "";
    if (width <= 0) return [""];
    let lines = super.render(width);
    if (lines.length < 3) {
      return lines.map((l) => clampLine(l, width));
    }

    const rows = Math.max(this.isShowingAutocomplete() ? 2 : 1, this.opts.maxRows?.(width) ?? lines.length);
    if (lines.length > rows) {
      const cursor = Math.max(1, lines.findIndex((line) => line.includes(CURSOR_MARKER)));
      const selected = this.selectedLine ? lines.findLastIndex((line) => line.includes(this.selectedLine)) : -1;
      if (selected > cursor) {
        // Pin the edit cursor; spend the remaining rows around the native selection.
        const count = Math.min(rows - 1, lines.length - cursor - 1);
        const start = Math.max(cursor + 1, Math.min(selected - Math.floor((count - 1) / 2), lines.length - count));
        this.sourceRows = [cursor, ...Array.from({ length: count }, (_, i) => start + i)];
      } else {
        const start = Math.max(1, Math.min(cursor - Math.floor(rows / 2), lines.length - 1 - rows));
        this.sourceRows = Array.from({ length: rows }, (_, i) => start + i);
      }
      lines = this.sourceRows.map((i) => lines[i]!);
    }
    const firstInput = this.sourceRows ? 0 : 1;
    const chevron = this.focused ? this.harnessTheme.accentBold("›") : this.harnessTheme.muted("›");
    const isEmpty = this.getText().length === 0;

    if (isEmpty && !this.isShowingAutocomplete() && this.placeholder && width >= 10) {
      const marker = this.focused ? CURSOR_MARKER : "";
      const cursor = this.focused ? "\x1b[7m \x1b[27m" : " ";
      const availForPlaceholder = Math.max(0, width - 6);
      const hint = availForPlaceholder > 2 ? this.harnessTheme.dim(this.placeholder) : "";
      const content = `${chevron} ${marker}${cursor}${hint}`;
      lines[firstInput] = fitWidth(content, width);
    } else if (lines[firstInput]!.startsWith("  ")) {
      // Replace the 2-column left padding on the first visual line with `› ` (identical visible width = 2)
      lines[firstInput] = clampLine(`${chevron} ${lines[firstInput]!.slice(2)}`, width);
    }

    return lines.map((l) => clampLine(l, width));
  }

  override handleMouse(event: TuiMouseEvent) {
    return super.handleMouse({ ...event, y: this.sourceRows?.[event.y] ?? event.y });
  }
}
