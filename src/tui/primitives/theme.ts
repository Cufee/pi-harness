import {
  backgroundAnsi,
  foregroundAnsi,
  getTerminalColorMode,
  rgbColor,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
  type SettingsListTheme,
} from "@earendil-works/pi-tui";

const RESET = "\x1b[0m";

function fg(r: number, g: number, b: number, fallback256?: number): (s: string) => string {
  const mode = getTerminalColorMode();
  const code =
    mode === "truecolor"
      ? foregroundAnsi(rgbColor(r, g, b), "truecolor")
      : fallback256 !== undefined
        ? `\x1b[38;5;${fallback256}m`
        : foregroundAnsi(rgbColor(r, g, b), mode);
  return (s: string) => (s ? `${code}${s}\x1b[39m` : "");
}

function bg(r: number, g: number, b: number, fallback256?: number): (s: string) => string {
  const mode = getTerminalColorMode();
  const code =
    mode === "truecolor"
      ? backgroundAnsi(rgbColor(r, g, b), "truecolor")
      : fallback256 !== undefined
        ? `\x1b[48;5;${fallback256}m`
        : backgroundAnsi(rgbColor(r, g, b), mode);
  return (s: string) => `${code}${s}\x1b[49m`;
}

export interface HarnessTheme {
  text: (s: string) => string;
  muted: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
  italic: (s: string) => string;
  accent: (s: string) => string;
  accentBold: (s: string) => string;
  success: (s: string) => string;
  warning: (s: string) => string;
  error: (s: string) => string;
  info: (s: string) => string;
  border: (s: string) => string;
  borderFocused: (s: string) => string;
  code: (s: string) => string;
  surfaceBg: (s: string) => string;
  userBg: (s: string) => string;
  statusBg: (s: string) => string;
  badgeBg: (s: string) => string;
  toMarkdownTheme: () => MarkdownTheme;
  toSelectListTheme: () => SelectListTheme;
  toSettingsListTheme: () => SettingsListTheme;
  toEditorTheme: () => EditorTheme;
}

export function createTheme(): HarnessTheme {
  const accentFn = fg(110, 200, 255, 81);
  const mutedFn = fg(145, 152, 166, 245);
  const dimFn = fg(102, 108, 122, 240);
  const successFn = fg(110, 224, 145, 114);
  const warningFn = fg(245, 198, 105, 221);
  const errorFn = fg(255, 118, 118, 203);
  const infoFn = fg(166, 154, 255, 147);
  const borderFn = fg(78, 84, 98, 238);
  const borderFocusedFn = fg(110, 200, 255, 81);
  const codeFn = fg(235, 196, 130, 222);

  const surfaceBg = bg(26, 29, 36, 235);
  const userBg = bg(34, 39, 49, 236);
  const statusBg = bg(24, 27, 34, 234);
  const badgeBg = bg(44, 51, 64, 237);

  const bold = (s: string) => (s ? `\x1b[1m${s}\x1b[22m` : "");
  const italic = (s: string) => (s ? `\x1b[3m${s}\x1b[23m` : "");
  const underline = (s: string) => (s ? `\x1b[4m${s}\x1b[24m` : "");
  const strikethrough = (s: string) => (s ? `\x1b[9m${s}\x1b[29m` : "");
  const accentBold = (s: string) => bold(accentFn(s));

  const toSelectListTheme = (): SelectListTheme => ({
    selectedPrefix: (t) => accentBold(t),
    selectedText: (t) => accentBold(t),
    description: (t) => mutedFn(t),
    scrollInfo: (t) => dimFn(t),
    noMatch: (t) => warningFn(t),
  });

  const toSettingsListTheme = (): SettingsListTheme => ({
    label: (t, selected) => (selected ? accentBold(t) : t),
    value: (t, selected) => (selected ? warningFn(bold(t)) : mutedFn(t)),
    description: (t) => mutedFn(t),
    cursor: accentBold("▸ "),
    hint: (t) => dimFn(t),
  });

  const toEditorTheme = (): EditorTheme => ({
    borderColor: (t) => borderFocusedFn(t),
    selectList: toSelectListTheme(),
  });

  const toMarkdownTheme = (): MarkdownTheme => ({
    heading: (t) => accentBold(t),
    link: (t) => underline(accentFn(t)),
    linkUrl: (t) => dimFn(t),
    code: (t) => codeFn(t),
    codeBlock: (t) => t,
    codeBlockBorder: (t) => borderFn(t),
    quote: (t) => italic(mutedFn(t)),
    quoteBorder: (t) => borderFn(t),
    hr: (t) => borderFn(t),
    listBullet: (t) => accentFn(t),
    bold,
    italic,
    strikethrough,
    underline,
    highlightCode: (code, lang) => highlightCodeLines(code, lang, { accentFn, successFn, warningFn, infoFn, dimFn }),
  });

  return {
    text: (s) => s,
    muted: mutedFn,
    dim: dimFn,
    bold,
    italic,
    accent: accentFn,
    accentBold,
    success: successFn,
    warning: warningFn,
    error: errorFn,
    info: infoFn,
    border: borderFn,
    borderFocused: borderFocusedFn,
    code: codeFn,
    surfaceBg,
    userBg,
    statusBg,
    badgeBg,
    toMarkdownTheme,
    toSelectListTheme,
    toSettingsListTheme,
    toEditorTheme,
  };
}

/** Fast, zero-dependency syntax highlighter for fenced code blocks inside Markdown. */
function highlightCodeLines(
  code: string,
  _lang: string | undefined,
  c: {
    accentFn: (s: string) => string;
    successFn: (s: string) => string;
    warningFn: (s: string) => string;
    infoFn: (s: string) => string;
    dimFn: (s: string) => string;
  },
): string[] {
  const KEYWORDS =
    /\b(import|export|from|const|let|var|function|async|await|return|if|else|for|while|switch|case|break|continue|class|interface|type|enum|extends|implements|new|try|catch|finally|throw|def|fn|pub|struct|impl|match|use|mod|package|func|go|defer|SELECT|FROM|WHERE|INSERT|UPDATE|CREATE|TABLE)\b/g;

  return code.split("\n").map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--")) {
      return c.dimFn(line);
    }
    return (
      line
        .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, (m) => c.successFn(m))
        .replace(KEYWORDS, (m) => c.infoFn(m))
        .replace(/\b(\d+(?:\.\d+)?)\b/g, (m) => c.warningFn(m)) + RESET
    );
  });
}
