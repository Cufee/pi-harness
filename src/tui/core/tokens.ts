import {
  backgroundAnsi,
  foregroundAnsi,
  getTerminalColorMode,
  rgbColor,
  type EditorTheme,
  type MarkdownTheme,
} from "@earendil-works/pi-tui";

export type Tone = "default" | "accent" | "info" | "ok" | "warn" | "danger" | "muted" | "dim";

export interface Glyphs {
  ascii: boolean;
  prompt: string;
  bullet: string;
  diamond: string;
  rail: string;
  sep: string;
  crumb: string;
  pointer: string;
  check: string;
  cross: string;
  warn: string;
  pause: string;
  running: string;
  pending: string;
  foldOpen: string;
  foldClosed: string;
  branchMid: string;
  branchEnd: string;
  branchCont: string;
  barH: string;
  barV: string;
  boxTL: string;
  boxTR: string;
  boxBL: string;
  boxBR: string;
  boxML: string;
  boxMR: string;
  barFull: string;
  barEmpty: string;
  scrollTrack: string;
  scrollThumb: string;
  slots: readonly string[];
}

const UNICODE_GLYPHS: Glyphs = {
  ascii: false,
  prompt: "›",
  bullet: "•",
  diamond: "◆",
  rail: "▎",
  sep: "·",
  crumb: "▸",
  pointer: "▸",
  check: "✓",
  cross: "✗",
  warn: "!",
  pause: "⏸",
  running: "●",
  pending: "○",
  foldOpen: "▾",
  foldClosed: "▸",
  branchMid: "├─",
  branchEnd: "└─",
  branchCont: "│ ",
  barH: "─",
  barV: "│",
  boxTL: "╭",
  boxTR: "╮",
  boxBL: "╰",
  boxBR: "╯",
  boxML: "├",
  boxMR: "┤",
  barFull: "█",
  barEmpty: "░",
  scrollTrack: "┆",
  scrollThumb: "┃",
  slots: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
};

const ASCII_GLYPHS: Glyphs = {
  ascii: true,
  prompt: ">",
  bullet: "*",
  diamond: "*",
  rail: "|",
  sep: "|",
  crumb: ">",
  pointer: ">",
  check: "v",
  cross: "x",
  warn: "!",
  pause: "||",
  running: "*",
  pending: "o",
  foldOpen: "v",
  foldClosed: ">",
  branchMid: "|-",
  branchEnd: "`-",
  branchCont: "| ",
  barH: "-",
  barV: "|",
  boxTL: "+",
  boxTR: "+",
  boxBL: "+",
  boxBR: "+",
  boxML: "+",
  boxMR: "+",
  barFull: "#",
  barEmpty: ".",
  scrollTrack: ":",
  scrollThumb: "#",
  slots: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
};

export interface Theme {
  color: boolean;
  glyphs: Glyphs;
  text: (text: string) => string;
  paint: (tone: Tone, text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  dim: (text: string) => string;
  muted: (text: string) => string;
  accent: (text: string) => string;
  accentBold: (text: string) => string;
  info: (text: string) => string;
  ok: (text: string) => string;
  warn: (text: string) => string;
  danger: (text: string) => string;
  code: (text: string) => string;
  border: (text: string) => string;
  borderFocused: (text: string) => string;
  surfaceBg: (text: string) => string;
  userBg: (text: string) => string;
  statusBg: (text: string) => string;
  badgeBg: (text: string) => string;
  selectedBg: (text: string) => string;
  tabActive: (text: string) => string;
  toEditorTheme: () => EditorTheme;
  toMarkdownTheme: () => MarkdownTheme;
}

function makeFg(color: boolean, r: number, g: number, b: number, fallback256: number): (s: string) => string {
  if (!color) return (s) => s;
  const mode = getTerminalColorMode();
  const code =
    mode === "truecolor"
      ? foregroundAnsi(rgbColor(r, g, b), "truecolor")
      : `\x1b[38;5;${fallback256}m`;
  return (s: string) => (s ? `${code}${s}\x1b[39m` : "");
}

function makeBg(color: boolean, r: number, g: number, b: number, fallback256: number): (s: string) => string {
  if (!color) return (s) => s;
  const mode = getTerminalColorMode();
  const code =
    mode === "truecolor"
      ? backgroundAnsi(rgbColor(r, g, b), "truecolor")
      : `\x1b[48;5;${fallback256}m`;
  return (s: string) => `${code}${s}\x1b[49m`;
}

const CODE_TOKEN_RE =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(import|export|from|const|let|var|function|async|await|return|if|else|for|while|switch|case|break|continue|class|interface|type|enum|extends|implements|new|try|catch|finally|throw|def|fn|pub|struct|impl|match|use|mod|package|func|go|defer|SELECT|FROM|WHERE|INSERT|UPDATE|CREATE|TABLE)\b|\b\d+(?:\.\d+)?\b/g;

/** Fast, zero-dependency syntax highlighter for fenced code blocks inside Markdown. */
function highlightCodeLines(
  code: string,
  color: boolean,
  c: {
    ok: (s: string) => string;
    warn: (s: string) => string;
    info: (s: string) => string;
    dim: (s: string) => string;
  },
): string[] {
  if (!color) return code.split("\n");

  return code.split("\n").map((line) => {
    if (line.includes("\x1b")) return line;
    const trimmed = line.trimStart();
    if (trimmed.startsWith("//") || trimmed.startsWith("#") || trimmed.startsWith("--")) {
      return c.dim(line);
    }
    return line.replace(CODE_TOKEN_RE, (match, str: string | undefined, kw: string | undefined) => {
      if (str !== undefined) return c.ok(match);
      if (kw !== undefined) return c.info(match);
      return c.warn(match);
    });
  });
}

export function createTheme(opts?: { color?: boolean; ascii?: boolean }): Theme {
  const color = opts?.color ?? (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
  const ascii = opts?.ascii ?? Boolean(process.env.PI_HARNESS_ASCII || process.env.TERM === "dumb");
  const glyphs = ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;

  // Calibrated truecolor / 256-color palette from v1 with selective SGR resets (\x1b[39m / \x1b[49m)
  const accent = makeFg(color, 110, 200, 255, 81);
  const muted = makeFg(color, 145, 152, 166, 245);
  const dim = makeFg(color, 102, 108, 122, 240);
  const ok = makeFg(color, 110, 224, 145, 114);
  const warn = makeFg(color, 245, 198, 105, 221);
  const danger = makeFg(color, 255, 118, 118, 203);
  const info = makeFg(color, 166, 154, 255, 147);
  const code = makeFg(color, 235, 196, 130, 222);
  const border = makeFg(color, 78, 84, 98, 238);
  const borderFocused = makeFg(color, 110, 200, 255, 81);

  const surfaceBg = makeBg(color, 26, 29, 36, 235);
  const userBg = makeBg(color, 34, 39, 49, 236);
  const statusBg = makeBg(color, 24, 27, 34, 234);
  const badgeBg = makeBg(color, 44, 51, 64, 237);

  const bold = (s: string) => (color && s ? `\x1b[1m${s}\x1b[22m` : s);
  const italic = (s: string) => (color && s ? `\x1b[3m${s}\x1b[23m` : s);
  const underline = (s: string) => (color && s ? `\x1b[4m${s}\x1b[24m` : s);
  const strikethrough = (s: string) => (color && s ? `\x1b[9m${s}\x1b[29m` : s);
  const accentBold = (s: string) => bold(accent(s));

  const paint = (tone: Tone, text: string): string => {
    switch (tone) {
      case "accent":
        return accent(text);
      case "info":
        return info(text);
      case "ok":
        return ok(text);
      case "warn":
        return warn(text);
      case "danger":
        return danger(text);
      case "muted":
        return muted(text);
      case "dim":
        return dim(text);
      default:
        return text;
    }
  };

  // Distinct active tab pill: subtle lifted badge surface + accentBold in color mode, `[label]` in NO_COLOR
  const tabActive = (label: string) =>
    color ? badgeBg(` ${accentBold(label)} `) : `[${label}]`;

  // Selection highlight uses calibrated badgeBg rather than harsh \x1b[7m reverse video
  const selectedBg = (text: string) => (color ? badgeBg(accentBold(text)) : text);

  return {
    color,
    glyphs,
    text: (s) => s,
    paint,
    bold,
    italic,
    dim,
    muted,
    accent,
    accentBold,
    info,
    ok,
    warn,
    danger,
    code,
    border,
    borderFocused,
    surfaceBg,
    userBg,
    statusBg,
    badgeBg,
    selectedBg,
    tabActive,
    toEditorTheme(): EditorTheme {
      return {
        borderColor: borderFocused,
        selectList: {
          selectedPrefix: accentBold,
          selectedText: accentBold,
          description: muted,
          scrollInfo: dim,
          noMatch: warn,
        },
      };
    },
    toMarkdownTheme(): MarkdownTheme {
      return {
        heading: accentBold,
        link: (t) => underline(accent(t)),
        linkUrl: dim,
        code,
        codeBlock: (s) => s,
        codeBlockBorder: border,
        quote: (t) => italic(muted(t)),
        quoteBorder: border,
        hr: border,
        listBullet: accent,
        bold,
        italic,
        strikethrough,
        underline,
        highlightCode: (src, _lang) => highlightCodeLines(src, color, { ok, warn, info, dim }),
      };
    },
  };
}

/** Single canonical status -> tone mapping used across Dock, Work Navigator, Inspectors, and Transcript. */
export function statusTone(status: string): Tone {
  switch (status.toLowerCase()) {
    case "achieved":
    case "completed":
    case "merged":
    case "approved":
    case "passed":
    case "resolved":
    case "fired":
    case "ok":
    case "available":
    case "reported":
    case "active":
      return "ok";
    case "executing":
    case "running":
    case "verifying":
    case "reviewing":
    case "merging":
    case "draining":
    case "in_progress":
    case "busy":
      return "accent";
    case "awaiting_human":
    case "paused":
    case "paused_quota":
    case "blocked":
    case "returned_for_rescope":
    case "changes_requested":
    case "bounced":
    case "throttled":
    case "stale":
    case "waiting_children":
    case "partial":
    case "candidate":
    case "p1":
    case "acked":
    case "open":
      return "warn";
    case "failed":
    case "conflict":
    case "ci_failed":
    case "exhausted":
    case "error":
    case "p0":
    case "escalate_human":
      return "danger";
    case "ready":
    case "queued":
    case "pending":
    case "draft":
    case "p2":
      return "info";
    default:
      return "muted";
  }
}

/** Single canonical status -> compact glyph mapping. */
export function statusGlyph(status: string, g: Glyphs): string {
  switch (status.toLowerCase()) {
    case "achieved":
    case "completed":
    case "merged":
    case "approved":
    case "passed":
    case "resolved":
    case "reported":
      return g.check;
    case "failed":
    case "conflict":
    case "ci_failed":
    case "cancelled":
    case "stopped":
    case "error":
    case "exhausted":
      return g.cross;
    case "awaiting_human":
    case "blocked":
    case "bounced":
    case "returned_for_rescope":
    case "p0":
    case "p1":
    case "open":
    case "acked":
      return g.warn;
    case "paused":
    case "paused_quota":
      return g.pause;
    case "executing":
    case "active":
    case "running":
    case "verifying":
    case "reviewing":
    case "merging":
    case "in_progress":
    case "busy":
      return g.running;
    default:
      return g.pending;
  }
}
