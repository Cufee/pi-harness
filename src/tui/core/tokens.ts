import type { EditorTheme, MarkdownTheme } from "@earendil-works/pi-tui";

export type Tone = "default" | "accent" | "info" | "ok" | "warn" | "danger" | "muted" | "dim";

export interface Glyphs {
  ascii: boolean;
  prompt: string;
  bullet: string;
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
  barH: string;
  barV: string;
  scrollTrack: string;
  scrollThumb: string;
  slots: readonly string[];
}

const UNICODE_GLYPHS: Glyphs = {
  ascii: false,
  prompt: "›",
  bullet: "•",
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
  barH: "─",
  barV: "│",
  scrollTrack: "┆",
  scrollThumb: "┃",
  slots: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
};

const ASCII_GLYPHS: Glyphs = {
  ascii: true,
  prompt: ">",
  bullet: "*",
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
  barH: "-",
  barV: "|",
  scrollTrack: ":",
  scrollThumb: "#",
  slots: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
};

const RESET = "\x1b[0m";

export interface Theme {
  color: boolean;
  glyphs: Glyphs;
  paint: (tone: Tone, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  muted: (text: string) => string;
  accent: (text: string) => string;
  accentBold: (text: string) => string;
  info: (text: string) => string;
  ok: (text: string) => string;
  warn: (text: string) => string;
  danger: (text: string) => string;
  border: (text: string) => string;
  selectedBg: (text: string) => string;
  toEditorTheme: () => EditorTheme;
  toMarkdownTheme: () => MarkdownTheme;
}

const ANSI_TONE: Record<Tone, string> = {
  default: "",
  accent: "\x1b[36m",
  info: "\x1b[34m",
  ok: "\x1b[32m",
  warn: "\x1b[33m",
  danger: "\x1b[31m",
  muted: "\x1b[90m",
  dim: "\x1b[2m",
};

export function createTheme(opts?: { color?: boolean; ascii?: boolean }): Theme {
  const color = opts?.color ?? (process.env.NO_COLOR === undefined && process.env.TERM !== "dumb");
  const ascii = opts?.ascii ?? Boolean(process.env.PI_HARNESS_ASCII || process.env.TERM === "dumb");
  const glyphs = ascii ? ASCII_GLYPHS : UNICODE_GLYPHS;

  const wrapCode = (code: string) => (text: string) => (color && code && text ? `${code}${text}${RESET}` : text);
  const paint = (tone: Tone, text: string) => wrapCode(ANSI_TONE[tone])(text);
  const bold = wrapCode("\x1b[1m");
  const dim = wrapCode("\x1b[2m");
  const muted = wrapCode("\x1b[90m");
  const accent = wrapCode("\x1b[36m");
  const accentBold = wrapCode("\x1b[1;36m");
  const info = wrapCode("\x1b[34m");
  const ok = wrapCode("\x1b[32m");
  const warn = wrapCode("\x1b[33m");
  const danger = wrapCode("\x1b[31m");
  const border = wrapCode("\x1b[90m");
  const selectedBg = wrapCode("\x1b[7m");

  return {
    color,
    glyphs,
    paint,
    bold,
    dim,
    muted,
    accent,
    accentBold,
    info,
    ok,
    warn,
    danger,
    border,
    selectedBg,
    toEditorTheme(): EditorTheme {
      return {
        borderColor: border,
        selectList: {
          selectedPrefix: accentBold,
          selectedText: selectedBg,
          description: muted,
          scrollInfo: muted,
          noMatch: muted,
        },
      };
    },
    toMarkdownTheme(): MarkdownTheme {
      return {
        heading: accentBold,
        link: info,
        linkUrl: muted,
        code: accent,
        codeBlock: (s) => s,
        codeBlockBorder: border,
        quote: muted,
        quoteBorder: border,
        hr: border,
        listBullet: accent,
        bold,
        italic: wrapCode("\x1b[3m"),
        strikethrough: wrapCode("\x1b[9m"),
        underline: wrapCode("\x1b[4m"),
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
      return "ok";
    case "executing":
    case "active":
    case "running":
    case "verifying":
    case "reviewing":
    case "merging":
    case "draining":
    case "in_progress":
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
      return g.check;
    case "failed":
    case "conflict":
    case "ci_failed":
    case "cancelled":
    case "stopped":
    case "error":
      return g.cross;
    case "awaiting_human":
    case "blocked":
    case "bounced":
    case "returned_for_rescope":
    case "p0":
    case "p1":
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
      return g.running;
    default:
      return g.pending;
  }
}
