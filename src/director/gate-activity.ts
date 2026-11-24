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

// Matches `git [global-options...] push` at a command boundary, excluding subcommands like `git stash push` or `git log --grep push`.
const GIT_PUSH_RE =
  /(?:^|[\s;&|(`"'])git(?:\s+(?:-[Cc]\s*(?:"[^"]*"|'[^']*'|\S+)|--[a-z-]+(?:=(?:"[^"]*"|'[^']*'|\S+))?))*\s+push\b/g;

const DRY_RUN_RE = /(?:^|\s)(?:--dry-run|-n)(?=\s|$)/;
const REF_UPDATE_RE =
  /^\s*([+*!= -]?)\s*(\S+?\.\.\.?\S+|\[new (?:branch|tag)\]|\[deleted\])\s+(\S+)\s+->\s+(\S+)/gm;
const REMOTE_TO_RE = /^\s*To\s+(\S+)/m;
const NO_PUSH_RESULT_RE = /(?:Everything up-to-date|\[rejected\]|^\s*(?:error|fatal):)/im;

const PUSH_FLAGS_WITH_VALUE = new Set([
  "-o",
  "--push-option",
  "--repo",
  "--receive-pack",
  "--exec",
  "--recurse-submodules",
]);

function extractStringValues(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    if (value.trim()) out.push(value);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) extractStringValues(item, out);
    return;
  }
  const obj = value as Record<string, unknown>;
  const priorityKeys = ["command", "cmd", "script", "input"];
  const seen = new Set<string>();
  for (const key of priorityKeys) {
    if (key in obj) {
      seen.add(key);
      extractStringValues(obj[key], out);
    }
  }
  for (const [key, val] of Object.entries(obj)) {
    if (!seen.has(key)) extractStringValues(val, out);
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
      extractStringValues(parsed, candidates);
      return true;
    } catch {
      return false;
    }
  };

  if (!tryParseJson(trimmed)) {
    for (const line of trimmed.split(/\r?\n/)) {
      const lineTrimmed = line.trim();
      if (!lineTrimmed) continue;
      if (!tryParseJson(lineTrimmed)) {
        // Handle truncated JSON tool previews such as `{"command":"git push origin main","desc":"...`
        const cmdMatch = /"(?:command|cmd|script)"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/.exec(lineTrimmed);
        if (cmdMatch?.[1]) {
          candidates.push(cmdMatch[1].replace(/\\(["\\/])/g, "$1").replace(/\\n/g, "\n"));
        }
        candidates.push(lineTrimmed);
      }
    }
  }

  return candidates;
}

/** Slices from the start of a `git ... push` match to the end of its shell command segment. */
function sliceCommandSegment(text: string, startIdx: number): string {
  const outerQuote = startIdx > 0 && (text[startIdx - 1] === '"' || text[startIdx - 1] === "'") ? text[startIdx - 1] : null;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i]!;
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
    if (outerQuote && ch === outerQuote) {
      return text.slice(startIdx, i);
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n" || ch === "\r" || ch === "`" || ch === ")") {
      return text.slice(startIdx, i);
    }
  }
  const raw = text.slice(startIdx);
  // Strip a single unmatched trailing quote inherited from an enclosing wrapper like `sh -c "a && git push origin main"`.
  if (quote && raw.endsWith(quote)) {
    return raw.slice(0, -1);
  }
  return raw;
}

function extractGitPushSegment(text: string): string | null {
  for (const candidate of extractCommandCandidates(text)) {
    GIT_PUSH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = GIT_PUSH_RE.exec(candidate)) !== null) {
      const matchText = m[0];
      const gitOffset = matchText.indexOf("git");
      const segmentStart = m.index + gitOffset;
      const segment = sliceCommandSegment(candidate, segmentStart).replace(/\s+/g, " ").trim();
      const pushWordIdx = segment.search(/\bpush\b/);
      const pushTail = pushWordIdx >= 0 ? segment.slice(pushWordIdx + 4) : "";
      if (DRY_RUN_RE.test(pushTail)) continue;
      return segment;
    }
  }
  return null;
}

function tokenizeSimple(s: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return tokens;
}

function extractRemoteFromCommand(segment: string): string | undefined {
  const pushWordIdx = segment.search(/\bpush\b/);
  if (pushWordIdx < 0) return undefined;
  const tokens = tokenizeSimple(segment.slice(pushWordIdx + 4));
  let skipNext = false;
  let afterDoubleDash = false;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
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
        const next = tokens[i + 1];
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
      extractStringValues(parsed, parts);
      return parts.join("\n");
    } catch {
      return trimmed.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").replace(/\\t/g, "\t");
    }
  }
  return resultText;
}

/** Fast check for whether tool title/args text contains a non-dry-run `git push` command. */
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
  const remoteMatch = REMOTE_TO_RE.exec(normalized);
  const remote = remoteMatch?.[1]?.trim().slice(0, 200) || cmdRemote;

  const refs: string[] = [];
  REF_UPDATE_RE.lastIndex = 0;
  let refMatch: RegExpExecArray | null;
  while ((refMatch = REF_UPDATE_RE.exec(normalized)) !== null) {
    const flag = refMatch[1] ?? "";
    if (flag === "!") continue;
    const summary = refMatch[2]!;
    const fromRef = refMatch[3]!;
    const toRef = refMatch[4]!;
    refs.push(`${summary} ${fromRef} -> ${toRef}`.slice(0, 200));
    if (refs.length >= 5) break;
  }

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
  };
}
