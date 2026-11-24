import type { EscalationRecord } from "../control-plane/db.js";
import type { GoalRecord } from "../goals/engine.js";
import type { ChatControlEvent } from "../protocol/chat-events.js";

export type GoalGate = {
  gate: "awaiting_human" | "blocking_escalation";
  escalations: EscalationRecord[];
};

export type GateActivityChatEvent = Extract<ChatControlEvent, { kind: "goal.gate_activity" }>;

export interface GitPush {
  command: string;
  remote?: string;
  refs: string[];
  confirmed: boolean;
}

export interface WorkerSpawnedDetails {
  runId: string;
  taskId: string;
  taskTier: number;
  title?: string;
}

export interface RemotePushDetails {
  runId: string;
  taskId: string;
  taskTier: number;
  command: string;
  remote?: string;
  refs?: string[];
  confirmed: boolean;
  toolCallId?: string;
}

/**
 * Returns the active human gate for a goal, or `null` when the goal is not gated.
 * `awaiting_human` takes precedence when both hold; terminal goals (`achieved`, `cancelled`) are never gated.
 */
export function goalGateState(
  goal: Pick<GoalRecord, "status">,
  escalations: readonly EscalationRecord[],
): GoalGate | null {
  if (goal.status === "achieved" || goal.status === "cancelled") return null;
  const human = escalations
    .filter((e) => e.blocking && e.status !== "resolved" && e.toTaskId === null)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (goal.status === "awaiting_human") {
    return { gate: "awaiting_human", escalations: human };
  }
  if (human.length > 0) {
    return { gate: "blocking_escalation", escalations: human };
  }
  return null;
}

const SHELL_TOOL_KINDS = new Set(["execute", "shell", "bash", "terminal"]);
const SHELL_TOOL_NAME_RE =
  /^(?:bash|sh|zsh|shell|shell_command|run_shell_command|execute|exec|exec_command|terminal|run_command|command|cmd|computer_bash)$/i;
const SHELL_TITLE_PREFIX_RE = /^(?:bash|sh|zsh|shell|terminal|execute)\s*:/i;

/**
 * Returns true only when an `agent.tool` payload represents a shell/execute tool call rather than a file/read/search tool.
 */
export function isShellToolEvent(payload: { kind?: unknown; name?: unknown; title?: unknown }): boolean {
  if (typeof payload.kind === "string" && payload.kind.trim()) {
    return SHELL_TOOL_KINDS.has(payload.kind.trim().toLowerCase());
  }
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (name && (SHELL_TOOL_NAME_RE.test(name) || SHELL_TITLE_PREFIX_RE.test(name))) return true;
  if (title && (SHELL_TOOL_NAME_RE.test(title) || SHELL_TITLE_PREFIX_RE.test(title))) return true;
  if (title && /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:\/\S*\/)?git)\s/.test(title)) return true;
  return false;
}

const REF_UPDATE_LINE_RE =
  /^\s*([+*!= -]?)\s*(\S+?\.\.\.?\S+|\[new (?:branch|tag|reference)\]|\[deleted\])\s+(\S+)\s+->\s+(\S+)/;
const REF_DELETE_LINE_RE = /^\s*-\s+\[deleted\]\s+(\S+)(?:\s+\([^)]*\))?\s*$/;
const PORCELAIN_REF_UPDATE_LINE_RE =
  /^([+* -])\t(\S*):(\S+)\t(\S+?\.\.\.?\S+|\[new (?:branch|tag|reference)\]|\[deleted\])/;
const REMOTE_TO_LINE_RE = /^\s*To\s+(\S+)/;
const REMOTE_FROM_LINE_RE = /^\s*From\s+(\S+)/;
const NO_PUSH_RESULT_RE = /(?:Everything up-to-date|\[up to date\]|\[rejected\]|^\s*(?:error|fatal):)/im;

const PUSH_FLAGS_WITH_VALUE = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
  "--recurse-submodules",
]);

const GIT_GLOBAL_FLAGS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);

const COMMAND_JSON_KEYS = ["command", "cmd", "script", "argv", "args", "input"] as const;
const SHELL_LEADING_KEYWORDS = new Set(["if", "then", "elif", "else", "do", "time", "!", "{"]);
const SHELL_BIN_RE = /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:sh|bash|zsh|dash|ksh)$/;
const ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

function shellQuoteArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function extractCommandStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 0 && value.every((item) => typeof item === "string")) {
      const joined = (value as string[]).map(shellQuoteArg).join(" ");
      if (joined.trim()) out.push(joined);
      return;
    }
    for (const item of value) extractCommandStrings(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of COMMAND_JSON_KEYS) {
    if (key in obj) {
      extractCommandStrings(obj[key], out);
    }
  }
}

function extractResultStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) extractResultStringValues(item, out);
    return;
  }
  for (const val of Object.values(value as Record<string, unknown>)) {
    extractResultStringValues(val, out);
  }
}

function extractCommandCandidates(raw: string): string[] {
  const candidates: string[] = [];
  const trimmed = raw.trim();
  if (!trimmed) return candidates;

  const tryParseJson = (s: string): boolean => {
    if (!s.startsWith("{") && !s.startsWith("[") && !s.startsWith('"')) return false;
    try {
      const parsed: unknown = JSON.parse(s);
      extractCommandStrings(parsed, candidates);
      return true;
    } catch {
      return false;
    }
  };

  if (!tryParseJson(trimmed)) {
    // Handle multi-line input where lines may include a header (e.g. "Bash") followed by JSON args, or a multi-line script.
    const lines = trimmed.split(/\r?\n/);
    const plainLines: string[] = [];
    for (const line of lines) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed) {
        if (plainLines.length > 0) plainLines.push("");
        continue;
      }
      if (tryParseJson(lineTrimmed)) {
        continue;
      }
      if (lineTrimmed.startsWith("{")) {
        // Handle truncated JSON tool previews such as `{"command":"git push origin main","desc":"...`
        const cmdMatch = /"(?:command|cmd|script)"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/.exec(lineTrimmed);
        if (cmdMatch?.[1]) {
          candidates.push(cmdMatch[1].replace(/\\(["\\/])/g, "$1").replace(/\\n/g, "\n"));
        }
        continue;
      }
      plainLines.push(line);
    }
    const plainScript = plainLines.join("\n").trim();
    if (plainScript) candidates.push(plainScript);
  }

  return candidates;
}

/** Strips heredoc bodies so literal text inside `<<EOF ... EOF` is not treated as executed commands. */
function stripHeredocs(script: string): string {
  const lines = script.split(/\r?\n/);
  const kept: string[] = [];
  const activeDelimiters: Array<{ delim: string; stripTabs: boolean }> = [];
  for (const line of lines) {
    if (activeDelimiters.length > 0) {
      const cur = activeDelimiters[0]!;
      const compare = cur.stripTabs ? line.replace(/^\t+/, "") : line;
      if (compare === cur.delim) {
        activeDelimiters.shift();
      }
      continue;
    }
    kept.push(line);
    // Scan only unquoted portions of the line for `<<` or `<<-` heredoc markers (excluding `<<<`).
    let quote: "'" | '"' | null = null;
    let escaped = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && quote !== "'") {
        escaped = true;
        continue;
      }
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) break;
      if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
        const rest = line.slice(i + 2);
        const m = /^(-?)\s*(?:'([^']+)'|"([^"]+)"|\\?([A-Za-z_][A-Za-z0-9_-]*))/.exec(rest);
        if (m) {
          const delim = m[2] ?? m[3] ?? m[4];
          if (delim) activeDelimiters.push({ delim, stripTabs: m[1] === "-" });
          i += 1 + m[0].length;
        }
      }
    }
  }
  return kept.join("\n");
}

interface ShellSegment {
  raw: string;
  substitutions: string[];
}

/** Splits a shell script into unquoted command segments and collects `$(...)` / backtick command substitutions. */
function splitShellSegments(script: string): ShellSegment[] {
  const cleaned = stripHeredocs(script);
  const segments: ShellSegment[] = [];
  let segStart = 0;
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let subs: string[] = [];

  const flush = (endIdx: number) => {
    const raw = cleaned.slice(segStart, endIdx).trim();
    if (raw || subs.length > 0) {
      segments.push({ raw, substitutions: subs });
    }
    subs = [];
  };

  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    // Command substitutions execute inside both unquoted text and double quotes.
    if (ch === "$" && cleaned[i + 1] === "(" && cleaned[i + 2] !== "(") {
      let depth = 1;
      let j = i + 2;
      let innerQuote: "'" | '"' | null = null;
      let innerEsc = false;
      for (; j < cleaned.length && depth > 0; j++) {
        const c = cleaned[j]!;
        if (innerEsc) {
          innerEsc = false;
          continue;
        }
        if (c === "\\" && innerQuote !== "'") {
          innerEsc = true;
          continue;
        }
        if (innerQuote) {
          if (c === innerQuote) innerQuote = null;
          continue;
        }
        if (c === "'" || c === '"') {
          innerQuote = c;
        } else if (c === "(") {
          depth++;
        } else if (c === ")") {
          depth--;
        }
      }
      if (depth === 0) {
        subs.push(cleaned.slice(i + 2, j - 1));
        i = j - 1;
        continue;
      }
    }
    if (ch === "`") {
      let j = i + 1;
      let innerEsc = false;
      for (; j < cleaned.length; j++) {
        const c = cleaned[j]!;
        if (innerEsc) {
          innerEsc = false;
          continue;
        }
        if (c === "\\") {
          innerEsc = true;
          continue;
        }
        if (c === "`") break;
      }
      if (j < cleaned.length && cleaned[j] === "`") {
        subs.push(cleaned.slice(i + 1, j));
        i = j;
        continue;
      }
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    // Unquoted `#` at start of word starts a shell comment to end of line.
    if (ch === "#" && (i === segStart || /\s/.test(cleaned[i - 1]!))) {
      flush(i);
      const nl = cleaned.indexOf("\n", i);
      if (nl < 0) {
        segStart = cleaned.length;
        break;
      }
      i = nl;
      segStart = nl + 1;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r" || ch === "(" || ch === ")") {
      flush(i);
      if ((ch === "&" || ch === "|") && cleaned[i + 1] === ch) {
        i++;
      }
      segStart = i + 1;
    }
  }
  flush(cleaned.length);
  return segments;
}

interface ShellToken {
  value: string;
  start: number;
}

function tokenizeShellSegment(segment: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  let i = 0;
  while (i < segment.length) {
    while (i < segment.length && /\s/.test(segment[i]!)) i++;
    if (i >= segment.length) break;
    if (segment[i] === "#") break;
    const start = i;
    let value = "";
    let quote: "'" | '"' | null = null;
    while (i < segment.length) {
      const ch = segment[i]!;
      if (quote === "'") {
        if (ch === "'") {
          quote = null;
        } else {
          value += ch;
        }
        i++;
        continue;
      }
      if (quote === '"') {
        if (ch === "\\") {
          const next = segment[i + 1];
          if (next !== undefined) {
            value += next;
            i += 2;
            continue;
          }
        }
        if (ch === '"') {
          quote = null;
        } else {
          value += ch;
        }
        i++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "'" || ch === '"') {
        quote = ch;
        i++;
        continue;
      }
      if (ch === "\\") {
        const next = segment[i + 1];
        if (next !== undefined) {
          value += next;
          i += 2;
          continue;
        }
      }
      value += ch;
      i++;
    }
    tokens.push({ value, start });
  }
  return tokens;
}

function hasDryRunPushFlag(pushArgs: string[]): boolean {
  let skipNext = false;
  for (const tok of pushArgs) {
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (tok === "--") break;
    if (tok === "--dry-run") return true;
    if (PUSH_FLAGS_WITH_VALUE.has(tok)) {
      skipNext = true;
      continue;
    }
    if (tok.startsWith("-") && !tok.startsWith("--") && tok.length >= 2) {
      // Short option cluster such as `-n`, `-nu`, `-un`, `-fn`. Stop at `-o` since `-o<val>` takes an attached value.
      for (let i = 1; i < tok.length; i++) {
        const flag = tok[i]!;
        if (flag === "o") break;
        if (flag === "n") return true;
      }
    }
  }
  return false;
}

function unwrapCommandStartIndex(tokens: ShellToken[]): number {
  let idx = 0;
  // Strip leading shell keywords, env assignments, and command wrappers (`env`, `command`, `exec`, `nohup`, `sudo`).
  while (idx < tokens.length) {
    const tok = tokens[idx]!.value;
    if (SHELL_LEADING_KEYWORDS.has(tok) || ENV_ASSIGN_RE.test(tok)) {
      idx++;
      continue;
    }
    if (tok === "command" || tok === "exec" || tok === "nohup") {
      idx++;
      while (idx < tokens.length && tokens[idx]!.value.startsWith("-")) idx++;
      continue;
    }
    if (tok === "env") {
      idx++;
      while (idx < tokens.length) {
        const t = tokens[idx]!.value;
        if (t === "-u" || t === "-C" || t === "-S") {
          idx += 2;
          continue;
        }
        if (t.startsWith("-") || ENV_ASSIGN_RE.test(t)) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }
    if (tok === "sudo") {
      idx++;
      while (idx < tokens.length) {
        const t = tokens[idx]!.value;
        if (t === "-u" || t === "-g" || t === "-C") {
          idx += 2;
          continue;
        }
        if (t.startsWith("-")) {
          idx++;
          continue;
        }
        break;
      }
      continue;
    }
    break;
  }
  return idx;
}

function findGitSubcommandIndex(tokens: ShellToken[], gitIdx: number): number {
  let subIdx = gitIdx + 1;
  while (subIdx < tokens.length) {
    const t = tokens[subIdx]!.value;
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(t)) {
      subIdx += 2;
      continue;
    }
    if (t.startsWith("-")) {
      subIdx++;
      continue;
    }
    break;
  }
  return subIdx;
}

function findGitPushInScript(script: string, depth: number): string | null {
  if (depth > 4) return null;
  for (const seg of splitShellSegments(script)) {
    for (const sub of seg.substitutions) {
      const subHit = findGitPushInScript(sub, depth + 1);
      if (subHit) return subHit;
    }
    if (!seg.raw) continue;
    const tokens = tokenizeShellSegment(seg.raw);
    const idx = unwrapCommandStartIndex(tokens);

    if (idx >= tokens.length) continue;
    const cmdToken = tokens[idx]!;
    const cmd = cmdToken.value;

    // Inspect inline shell invocations such as `sh -c "..."` / `bash -lc '...'`.
    if (SHELL_BIN_RE.test(cmd)) {
      for (let i = idx + 1; i < tokens.length; i++) {
        const t = tokens[i]!.value;
        if (t === "--") break;
        if (!t.startsWith("-")) break;
        if (/^-[a-zA-Z]*c$/.test(t) && tokens[i + 1]) {
          const nested = findGitPushInScript(tokens[i + 1]!.value, depth + 1);
          if (nested) return nested;
          break;
        }
      }
      continue;
    }

    if (cmd !== "git" && !cmd.endsWith("/git")) continue;

    const subIdx = findGitSubcommandIndex(tokens, idx);
    if (subIdx >= tokens.length || tokens[subIdx]!.value !== "push") continue;
    const pushArgs = tokens.slice(subIdx + 1).map((t) => t.value);
    if (hasDryRunPushFlag(pushArgs)) continue;

    return seg.raw.slice(cmdToken.start).replace(/\s+/g, " ").trim();
  }
  return null;
}

function hasGitFetchOrPullInScript(script: string, depth: number): boolean {
  if (depth > 4) return false;
  for (const seg of splitShellSegments(script)) {
    for (const sub of seg.substitutions) {
      if (hasGitFetchOrPullInScript(sub, depth + 1)) return true;
    }
    if (!seg.raw) continue;
    const tokens = tokenizeShellSegment(seg.raw);
    const idx = unwrapCommandStartIndex(tokens);
    if (idx >= tokens.length) continue;
    const cmd = tokens[idx]!.value;

    if (SHELL_BIN_RE.test(cmd)) {
      for (let i = idx + 1; i < tokens.length; i++) {
        const t = tokens[i]!.value;
        if (t === "--") break;
        if (!t.startsWith("-")) break;
        if (/^-[a-zA-Z]*c$/.test(t) && tokens[i + 1]) {
          if (hasGitFetchOrPullInScript(tokens[i + 1]!.value, depth + 1)) return true;
          break;
        }
      }
      continue;
    }

    if (cmd !== "git" && !cmd.endsWith("/git")) continue;
    const subIdx = findGitSubcommandIndex(tokens, idx);
    const sub = tokens[subIdx]?.value;
    if (sub === "fetch" || sub === "pull") return true;
  }
  return false;
}

function hasGitFetchOrPull(text: string): boolean {
  for (const candidate of extractCommandCandidates(text)) {
    if (hasGitFetchOrPullInScript(candidate, 0)) return true;
  }
  return false;
}

function extractGitPushSegment(text: string): string | null {
  for (const candidate of extractCommandCandidates(text)) {
    const segment = findGitPushInScript(candidate, 0);
    if (segment) return segment;
  }
  return null;
}

function extractRemoteFromCommand(segment: string): string | undefined {
  const tokens = tokenizeShellSegment(segment).map((t) => t.value);
  let subIdx = 1;
  while (subIdx < tokens.length) {
    const t = tokens[subIdx]!;
    if (GIT_GLOBAL_FLAGS_WITH_VALUE.has(t)) {
      subIdx += 2;
      continue;
    }
    if (t.startsWith("-")) {
      subIdx++;
      continue;
    }
    break;
  }
  if (tokens[subIdx] !== "push") return undefined;
  const pushTokens = tokens.slice(subIdx + 1);
  let skipNext = false;
  let afterDoubleDash = false;
  for (let i = 0; i < pushTokens.length; i++) {
    const tok = pushTokens[i]!;
    if (skipNext) {
      skipNext = false;
      continue;
    }
    if (!afterDoubleDash) {
      if (tok === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (tok.startsWith("--repo=")) {
        const val = tok.slice("--repo=".length).trim();
        if (val) return val.slice(0, 200);
        continue;
      }
      if (tok === "--repo") {
        const next = pushTokens[i + 1];
        if (next) return next.slice(0, 200);
        continue;
      }
      if (PUSH_FLAGS_WITH_VALUE.has(tok)) {
        skipNext = true;
        continue;
      }
      if (tok.startsWith("-")) continue;
    }
    if (tok) return tok.slice(0, 200);
  }
  return undefined;
}

function normalizeResultText(resultText: string): string {
  const trimmed = resultText.trim();
  if (!trimmed) return "";
  if (trimmed.startsWith("{") || trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const parts: string[] = [];
      extractResultStringValues(parsed, parts);
      return parts.join("\n");
    } catch {
      return trimmed.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    }
  }
  return resultText;
}

/** Fast check for whether tool command text contains an executed non-dry-run `git push` command. */
export function looksLikeGitPush(text: string): boolean {
  return extractGitPushSegment(text) !== null;
}

/**
 * Inspects a tool's command text and optional result preview for a remote `git push`.
 * Returns `null` when the command is not a push, is a dry-run, or the output shows nothing was pushed.
 */
export function detectGitPush(commandText: string, resultText: string | undefined): GitPush | null {
  const segment = extractGitPushSegment(commandText);
  if (!segment) return null;
  const command = segment.slice(0, 200);
  const cmdRemote = extractRemoteFromCommand(segment);

  if (resultText === undefined || !resultText.trim()) {
    return {
      command,
      ...(cmdRemote ? { remote: cmdRemote } : {}),
      refs: [],
      confirmed: false,
    };
  }

  const normalized = normalizeResultText(resultText);
  const lines = normalized.split(/\r?\n/);
  const hasToHeader = lines.some((line) => REMOTE_TO_LINE_RE.test(line));
  const allowHeaderlessRefs = !hasToHeader && !hasGitFetchOrPull(commandText);

  let section: "unknown" | "from" | "to" = "unknown";
  let remoteFromOutput: string | undefined;
  let remoteWithPush: string | undefined;
  let currentToRemote: string | undefined;
  const refs: string[] = [];

  for (const line of lines) {
    if (REMOTE_FROM_LINE_RE.test(line)) {
      section = "from";
      currentToRemote = undefined;
      continue;
    }
    const toMatch = REMOTE_TO_LINE_RE.exec(line);
    if (toMatch) {
      section = "to";
      currentToRemote = toMatch[1]?.trim().slice(0, 200) || undefined;
      if (currentToRemote) remoteFromOutput = currentToRemote;
      continue;
    }

    const inPushOutput = section === "to" || (allowHeaderlessRefs && section === "unknown");
    if (!inPushOutput || refs.length >= 5) continue;

    const refMatch = REF_UPDATE_LINE_RE.exec(line);
    if (refMatch) {
      const flag = refMatch[1] ?? "";
      if (flag === "!" || flag === "=") continue;
      const summary = refMatch[2]!;
      const fromRef = refMatch[3]!;
      const toRef = refMatch[4]!;
      refs.push(`${summary} ${fromRef} -> ${toRef}`.slice(0, 200));
      if (currentToRemote && !remoteWithPush) remoteWithPush = currentToRemote;
      continue;
    }

    const delMatch = REF_DELETE_LINE_RE.exec(line);
    if (delMatch) {
      const deletedRef = delMatch[1]!;
      refs.push(`[deleted] ${deletedRef}`.slice(0, 200));
      if (currentToRemote && !remoteWithPush) remoteWithPush = currentToRemote;
      continue;
    }

    const pMatch = PORCELAIN_REF_UPDATE_LINE_RE.exec(line);
    if (pMatch) {
      const fromRef = pMatch[2] || "(deleted)";
      const toRef = pMatch[3]!;
      const summary = pMatch[4]!;
      refs.push(`${summary} ${fromRef} -> ${toRef}`.slice(0, 200));
      if (currentToRemote && !remoteWithPush) remoteWithPush = currentToRemote;
    }
  }

  const remote = remoteWithPush || remoteFromOutput || cmdRemote;

  if (refs.length > 0) {
    return {
      command,
      ...(remote ? { remote } : {}),
      refs,
      confirmed: true,
    };
  }

  if (NO_PUSH_RESULT_RE.test(normalized)) {
    return null;
  }

  return {
    command,
    ...(remote ? { remote } : {}),
    refs: [],
    confirmed: false,
  };
}

export function buildGateActivityEvent(
  goal: Pick<GoalRecord, "id" | "version" | "title">,
  gate: GoalGate,
  activity: "worker_spawned",
  details: WorkerSpawnedDetails,
): GateActivityChatEvent;
export function buildGateActivityEvent(
  goal: Pick<GoalRecord, "id" | "version" | "title">,
  gate: GoalGate,
  activity: "remote_push",
  details: RemotePushDetails,
): GateActivityChatEvent;
export function buildGateActivityEvent(
  goal: Pick<GoalRecord, "id" | "version" | "title">,
  gate: GoalGate,
  activity: "worker_spawned" | "remote_push",
  details: WorkerSpawnedDetails | RemotePushDetails,
): GateActivityChatEvent {
  const escalationIds = gate.escalations.slice(0, 5).map((e) => e.id);
  const base = {
    kind: "goal.gate_activity" as const,
    goalId: goal.id,
    goalVersion: goal.version,
    goalTitle: goal.title,
    runId: details.runId,
    gate: gate.gate,
    escalationIds,
    openBlockingEscalations: gate.escalations.length,
    taskId: details.taskId,
    taskTier: details.taskTier,
  };

  if (activity === "worker_spawned") {
    const d = details as WorkerSpawnedDetails;
    const title = d.title?.replace(/\s+/g, " ").trim().slice(0, 160);
    return {
      ...base,
      activity: "worker_spawned",
      ...(title ? { title } : {}),
    };
  }

  const d = details as RemotePushDetails;
  const command = d.command.replace(/\s+/g, " ").trim().slice(0, 200);
  const remote = d.remote?.trim().slice(0, 200);
  const toolCallId = d.toolCallId?.trim().slice(0, 120);
  const refs = (d.refs ?? [])
    .map((r) => r.replace(/\s+/g, " ").trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 5);
  return {
    ...base,
    activity: "remote_push",
    ...(command ? { command } : {}),
    ...(remote ? { remote } : {}),
    ...(refs.length > 0 ? { refs } : {}),
    confirmed: d.confirmed,
    ...(toolCallId ? { toolCallId } : {}),
  };
}
