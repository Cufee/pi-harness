import {
  CombinedAutocompleteProvider,
  CURSOR_MARKER,
  Editor,
  type SlashCommand,
  type TUI,
} from "@earendil-works/pi-tui";
import type { HarnessTheme } from "./theme.js";
import { clampLine, fitWidth } from "./width.js";

export interface ComposerOptions {
  placeholder?: string;
  slashCommands?: SlashCommand[];
  cwd?: string;
  autocompleteMaxVisible?: number;
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

  constructor(
    tui: TUI,
    private readonly harnessTheme: HarnessTheme,
    opts: ComposerOptions = {},
  ) {
    super(tui, harnessTheme.toEditorTheme(), {
      paddingX: 2,
      autocompleteMaxVisible: opts.autocompleteMaxVisible ?? 6,
    });
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
    if (width <= 0) return [""];
    const lines = super.render(width);
    if (lines.length < 3) {
      return lines.map((l) => clampLine(l, width));
    }

    const chevron = this.focused ? this.harnessTheme.accentBold("›") : this.harnessTheme.muted("›");
    const isEmpty = this.getText().length === 0;

    if (isEmpty && !this.isShowingAutocomplete() && this.placeholder && width >= 10) {
      const marker = this.focused ? CURSOR_MARKER : "";
      const cursor = this.focused ? "\x1b[7m \x1b[27m" : " ";
      const availForPlaceholder = Math.max(0, width - 6);
      const hint = availForPlaceholder > 2 ? this.harnessTheme.dim(this.placeholder) : "";
      const content = `${chevron} ${marker}${cursor}${hint}`;
      lines[1] = fitWidth(content, width);
    } else if (lines[1]!.startsWith("  ")) {
      // Replace the 2-column left padding on the first visual line with `› ` (identical visible width = 2)
      lines[1] = clampLine(`${chevron} ${lines[1]!.slice(2)}`, width);
    }

    return lines.map((l) => clampLine(l, width));
  }
}
