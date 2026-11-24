import { isAbsolute, relative, resolve } from "node:path";
import type { ScopeFinding, ScopeSignalSource } from "../advisories/types.js";

/**
 * Pure, I/O-free scope-check signal source for Tier 3 tasks.
 *
 * Watches completed tool calls and reports structured scope findings through `evaluate()` when
 * activity indicates that the assignment is widening across multiple deliverables or spinning
 * without progress. Raw turn counts, token counts, file counts, and context sizes are never
 * inputs: a long bounded read for one question stays silent.
 *
 * ## Observed inputs
 * Only `status === "completed"` calls are scored (`in_progress` calls are cached by `id` so
 * runners that emit arguments on start and omit them on completion still supply their paths and
 * queries). Calls with neither a workspace/external path nor a search query (for example
 * `artifact_write`, `return_task`, or control-plane bookkeeping) are ignored.
 *
 * - **Path extraction**: reads `path`, `file_path`, `filePath`, `directory`, `dir`, `cwd`,
 *   `target_file`, `notebook_path`, `SearchPath`, `search_path`, and `paths[]`; splits `octofs`
 *   `a|b` multi-path syntax; reads `glob` when it contains `/`, and `pattern` when it contains `/`
 *   for file/glob searches. Truncated JSON previews (512 chars) fall back to key-value extraction.
 * - **Area bucketing**: paths inside `workspaceRoot` are bucketed to the first `areaDepth`
 *   directory segments (default `2`, e.g. `"src/runners"`, `"cloud/modules"`). Files directly at
 *   `workspaceRoot` bucket to `"."`. Paths outside `workspaceRoot` bucket to `"ext:"` plus their
 *   first 3 absolute segments.
 * - **Search topics**: for search-like calls (name/kind matches `grep|rg|search|find|glob`, or
 *   args carry a query/pattern/regex/symbol/term, or `content` on non-write tools), extracts
 *   lowercase identifier tokens of at least 4 characters. Queries that share any token belong to
 *   the same topic cluster.
 *
 * ## Signals and thresholds
 * - **W (widening)**: `distinctAreas.length >= 8` AND at least `6` of the last `12` path-bearing
 *   calls entered an area first seen within that 12-call window (`newAreasInWindow >= 6`).
 * - **T (topic spread)**: `searchTopics.length >= 4` distinct search topic clusters.
 * - **S (spinning / no progress)**: the same `(tool + path + range + verbatim query + verbatim argv/op)`
 *   call completed `3` or more times consecutively (`repeatStreak >= 3`), OR `12` consecutive
 *   scored calls added no new `(tool + path + range + verbatim query + verbatim argv/op)` key and no
 *   new search topic (`staleStreak >= 12`). Literal query/pattern and command/argv strings stay
 *   verbatim for repeat and progress identity; queries are normalized only for topic clustering.
 *   Calls whose inputs cannot distinguish operations (for example `cwd` alone without a path, query,
 *   or complete `argv`/`command`, or truncated distinguishing inputs) are skipped rather than scored
 *   as repeats or lack of progress.
 *
 * ## Evaluation
 * - `evaluate()` reports a `ScopeFinding` when `(W && T) || S`. `W` alone never fires, so a
 *   bounded single-topic search across many areas (e.g. finding every caller of one symbol)
 *   stays silent. Cadence and notice formatting live in `src/advisories/rules.ts`.
 */

export interface ScopeToolCall {
  id?: string;
  name: string;
  kind?: string;
  status: "in_progress" | "completed" | "failed";
  args?: string | Record<string, unknown>;
}

export interface ScopeNudgeOptions {
  workspaceRoot: string;
  /** Leading directory segments that define an area inside `workspaceRoot` (default 2). */
  areaDepth?: number;
}

export interface ScopeSignals {
  distinctAreas: string[];
  newAreasInWindow: number;
  searchTopics: string[];
  repeatStreak: number;
  staleStreak: number;
}

const SINGLE_PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "directory",
  "dir",
  "cwd",
  "target_file",
  "notebook_path",
  "SearchPath",
  "search_path",
] as const;

const DIR_ONLY_KEYS = new Set(["directory", "dir", "cwd", "SearchPath", "search_path"]);

const RANGE_KEYS = [
  "start_line",
  "startLine",
  "end_line",
  "endLine",
  "offset",
  "limit",
  "max_bytes",
  "maxBytes",
  "max_chars",
  "maxChars",
  "lines",
  "line",
  "range",
  "view_range",
  "from",
  "to",
] as const;

const DISTINGUISHING_STRING_KEYS = [
  "command",
  "cmd",
  "glob",
  "include",
  "exclude",
  "type",
  "file_type",
  "task_id",
  "action",
  "mode",
] as const;

const DISTINGUISHING_ARRAY_KEYS = ["path_globs", "ids"] as const;

const TRUNCATION_SENSITIVE_STRING_KEYS = [
  "command",
  "cmd",
  "query",
  "pattern",
  "regex",
  "symbol",
  "term",
  "glob",
] as const;

const IGNORED_TOOLS = new Set([
  "code_exec",
  "tool_search",
  "return_task",
  "artifact_write",
  "report_issue",
  "report_goal_progress",
  "blackboard_get",
  "blackboard_set",
  "request_rollover",
  "wait_children",
  "wait_tasks",
  "spawn_task",
  "spawn_worker",
  "list_models",
  "tree_view",
  "cancel_child",
  "cancel_task",
  "steer_child",
  "steer_task",
  "ack_escalation",
  "schedule_timer",
  "cancel_timer",
  "list_timers",
  "wait_timer",
]);

const SEARCH_NAME_RE = /(grep|rg|search|find|glob)/i;
const GLOB_NAME_RE = /\b(glob|find|list|files)\b/i;
const WRITE_NAME_RE = /(write|edit|create|patch|replace|append|artifact|note|return_task)/i;
const FILE_EXT_RE = /\.[A-Za-z0-9_-]{1,12}$/;
const REGEX_META_RE = /[\\()^$|+]/;
const GLOB_META_RE = /[*?[{]/;

const WIDENING_MIN_AREAS = 8;
const WIDENING_WINDOW = 12;
const WIDENING_MIN_NEW_IN_WINDOW = 6;
const TOPIC_MIN_COUNT = 4;
const REPEAT_THRESHOLD = 3;
const STALE_THRESHOLD = 12;
const MAX_PENDING_CACHE = 256;

interface ParsedArgsResult {
  args: Record<string, unknown>;
  incompleteDistinguishing: boolean;
}

function parseJsonStringArray(rawArrayBody: string): string[] | null {
  try {
    const parsed = JSON.parse(`[${rawArrayBody}]`);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")) {
      return parsed.map((item) => String(item));
    }
  } catch {
    // Incomplete or malformed array literal.
  }
  return null;
}

function parseArgsObject(raw: string | Record<string, unknown> | undefined): ParsedArgsResult | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { args: raw, incompleteDistinguishing: false };
  }
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, incompleteDistinguishing: false };
    }
  } catch {
    // Truncated JSON preview (toolEventPreview cuts at 512 chars): fall back to key-value extraction.
  }
  const out: Record<string, unknown> = {};
  let incompleteDistinguishing = false;

  const strRe = /"([A-Za-z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const m of trimmed.matchAll(strRe)) {
    const key = m[1];
    const rawVal = m[2];
    if (!key || rawVal === undefined) continue;
    try {
      out[key] = JSON.parse(`"${rawVal}"`);
    } catch {
      out[key] = rawVal.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
  }
  const numRe = /"([A-Za-z0-9_]+)"\s*:\s*(-?\d+(?:\.\d+)?)(?=[,\s}\]])/g;
  for (const m of trimmed.matchAll(numRe)) {
    const key = m[1];
    const numVal = m[2];
    if (key && numVal !== undefined && !(key in out)) {
      out[key] = Number(numVal);
    }
  }
  for (const arrKey of ["argv", "paths", "path_globs", "ids"] as const) {
    const closedMatch = new RegExp(`"${arrKey}"\\s*:\\s*\\[([^\\]]*)\\]`).exec(trimmed);
    if (closedMatch?.[1] !== undefined) {
      const items = parseJsonStringArray(closedMatch[1]);
      if (items) {
        out[arrKey] = items;
      } else {
        incompleteDistinguishing = true;
      }
    } else if (new RegExp(`"${arrKey}"\\s*:\\s*\\[`).test(trimmed)) {
      incompleteDistinguishing = true;
    }
  }
  for (const key of TRUNCATION_SENSITIVE_STRING_KEYS) {
    if (!(key in out) && new RegExp(`"${key}"\\s*:\\s*"`).test(trimmed)) {
      incompleteDistinguishing = true;
    }
  }
  if (Object.keys(out).length === 0 && !incompleteDistinguishing) return null;
  return { args: out, incompleteDistinguishing };
}

function mergeDefinedArgs(
  prev: string | Record<string, unknown> | undefined,
  next: string | Record<string, unknown> | undefined,
): string | Record<string, unknown> | undefined {
  if (next === undefined) return prev;
  if (typeof next === "string") return next.trim() ? next : prev;
  if (prev === undefined) return next;
  if (typeof prev === "object" && !Array.isArray(prev) && typeof next === "object" && !Array.isArray(next)) {
    const merged: Record<string, unknown> = { ...prev };
    for (const [key, value] of Object.entries(next)) {
      if (value !== undefined) merged[key] = value;
    }
    return merged;
  }
  if (typeof prev === "string" && typeof next === "object" && !Array.isArray(next)) {
    const definedEntries = Object.entries(next).filter(([, value]) => value !== undefined);
    if (definedEntries.length === 0) return prev;
    const parsedPrev = parseArgsObject(prev);
    if (parsedPrev && !parsedPrev.incompleteDistinguishing) {
      const merged: Record<string, unknown> = { ...parsedPrev.args };
      for (const [key, value] of definedEntries) merged[key] = value;
      return merged;
    }
  }
  return next;
}

function stripGlobWildcardTail(pattern: string): string | null {
  const normalized = pattern.replaceAll("\\", "/").trim();
  if (!normalized.includes("/")) return null;
  const segments = normalized.split("/");
  const kept: string[] = [];
  for (const seg of segments) {
    if (GLOB_META_RE.test(seg)) break;
    kept.push(seg);
  }
  const prefix = kept.join("/").replace(/\/+$/, "");
  return prefix && prefix !== "." ? prefix : null;
}

function stripLineSuffix(raw: string): { path: string; lineSuffix?: string } {
  const m = /^(.*):(\d+(?:-\d+)?)$/.exec(raw);
  if (m && m[1] && m[1].length > 1) {
    return { path: m[1], lineSuffix: m[2] };
  }
  return { path: raw };
}

interface ExtractedPath {
  path: string;
  isDirHint: boolean;
  fromCwd?: boolean;
  lineSuffix?: string;
}

function extractPaths(
  call: ScopeToolCall,
  kind: string | undefined,
  args: Record<string, unknown>,
): ExtractedPath[] {
  const results: ExtractedPath[] = [];
  const pushRaw = (val: unknown, isDirHint: boolean, fromCwd = false) => {
    if (typeof val !== "string") return;
    for (const part of val.split("|")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const { path, lineSuffix } = stripLineSuffix(trimmed);
      if (path) results.push({ path, isDirHint: isDirHint || path.endsWith("/"), fromCwd, lineSuffix });
    }
  };

  for (const key of SINGLE_PATH_KEYS) {
    if (key in args) pushRaw(args[key], DIR_ONLY_KEYS.has(key), key === "cwd");
  }
  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) pushRaw(entry, false);
  }
  if (typeof args.glob === "string" && args.glob.includes("/")) {
    const prefix = stripGlobWildcardTail(args.glob);
    if (prefix) results.push({ path: prefix, isDirHint: true });
  }
  if (typeof args.pattern === "string" && args.pattern.includes("/")) {
    const isGlobLike =
      GLOB_NAME_RE.test(call.name) ||
      GLOB_NAME_RE.test(kind ?? "") ||
      (results.length === 0 && !REGEX_META_RE.test(args.pattern));
    if (isGlobLike) {
      const prefix = stripGlobWildcardTail(args.pattern);
      if (prefix) results.push({ path: prefix, isDirHint: true });
    }
  }
  return results;
}

interface ExtractedQuery {
  identityKey: string;
  topicText: string;
}

function extractQuery(
  call: ScopeToolCall,
  kind: string | undefined,
  args: Record<string, unknown>,
): ExtractedQuery | null {
  const isWriteTool = WRITE_NAME_RE.test(call.name) || WRITE_NAME_RE.test(kind ?? "");
  const isSearchTool = SEARCH_NAME_RE.test(call.name) || SEARCH_NAME_RE.test(kind ?? "");
  const isGlobTool = GLOB_NAME_RE.test(call.name) || GLOB_NAME_RE.test(kind ?? "");

  const identityEntries: Array<[string, string]> = [];
  const topicCandidates: string[] = [];
  const pushStr = (key: string, v: unknown) => {
    if (typeof v === "string" && v.length > 0) {
      identityEntries.push([key, v]);
      if (v.trim()) topicCandidates.push(v.trim());
    }
  };

  pushStr("query", args.query);
  pushStr("regex", args.regex);
  pushStr("symbol", args.symbol);
  pushStr("term", args.term);
  pushStr("q", args.q);
  pushStr("search", args.search);
  if (!isWriteTool) {
    pushStr("content", args.content);
  }
  if (typeof args.pattern === "string" && args.pattern.length > 0) {
    const p = args.pattern.trim();
    if (isGlobTool && p.includes("/") && GLOB_META_RE.test(p)) {
      identityEntries.push(["pattern", args.pattern]);
      // Only tokenize the filename portion of a path glob so directory names do not invent fake topics.
      const base = p.replaceAll("\\", "/").split("/").pop() ?? "";
      if (base) topicCandidates.push(base);
    } else if (!isWriteTool || isSearchTool) {
      identityEntries.push(["pattern", args.pattern]);
      if (p) topicCandidates.push(p);
    }
  }

  if (identityEntries.length === 0) return null;
  return {
    identityKey: JSON.stringify(identityEntries),
    topicText: topicCandidates.join(" "),
  };
}

function extractTopicTokens(query: string): string[] {
  const matches = query.toLowerCase().match(/[a-z0-9_]{4,}/g);
  if (!matches) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of matches) {
    if (!seen.has(tok)) {
      seen.add(tok);
      out.push(tok);
    }
  }
  return out;
}

function extractRangeKey(args: Record<string, unknown>, lineSuffixes: string[]): string {
  const parts: string[] = [];
  for (const key of RANGE_KEYS) {
    const v = args[key];
    if (v !== undefined && v !== null) {
      parts.push(`${key}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
    }
  }
  if (lineSuffixes.length > 0) parts.push(`lines=${lineSuffixes.join(",")}`);
  return parts.join("&");
}

function extractOperationKey(args: Record<string, unknown>): string {
  const entries: Array<[string, unknown]> = [];
  if (Array.isArray(args.argv) && args.argv.length > 0) {
    const verbatim = args.argv
      .filter((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean")
      .map((item) => String(item));
    if (verbatim.length === args.argv.length) {
      entries.push(["argv", verbatim]);
    }
  }
  for (const key of DISTINGUISHING_STRING_KEYS) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      entries.push([key, v]);
    }
  }
  for (const key of DISTINGUISHING_ARRAY_KEYS) {
    const v = args[key];
    if (Array.isArray(v) && v.length > 0) {
      const normalized = v
        .filter((item) => typeof item === "string" || typeof item === "number")
        .map((item) => String(item))
        .sort();
      if (normalized.length > 0) {
        entries.push([key, normalized]);
      }
    }
  }
  return entries.length > 0 ? JSON.stringify(entries) : "";
}

function hasParentTraversalComponent(p: string): boolean {
  return p.replaceAll("\\", "/").split("/").includes("..");
}

export class ScopeNudgeMonitor implements ScopeSignalSource {
  private readonly workspaceRoot: string;
  private readonly areaDepth: number;

  private readonly pendingById = new Map<string, { args?: string | Record<string, unknown>; kind?: string }>();
  private readonly areaFirstSeenAt = new Map<string, number>();
  private readonly recentPathCalls: Array<{ areas: string[] }> = [];
  private readonly topicClusters: Array<{ label: string; tokens: Set<string> }> = [];
  private readonly seenProgressKeys = new Set<string>();

  private pathCallCount = 0;
  private scoredCallCount = 0;
  private lastCallKey: string | null = null;
  private lastToolName = "";
  private repeatStreak = 0;
  private staleStreak = 0;

  constructor(opts: ScopeNudgeOptions) {
    this.workspaceRoot = resolve(opts.workspaceRoot);
    this.areaDepth = Math.max(1, opts.areaDepth ?? 2);
  }

  observe(call: ScopeToolCall): void {
    if (call.status === "in_progress") {
      if (call.id && (call.args !== undefined || call.kind !== undefined)) {
        const existing = this.pendingById.get(call.id);
        if (!existing && this.pendingById.size >= MAX_PENDING_CACHE) {
          const oldest = this.pendingById.keys().next().value;
          if (oldest !== undefined) this.pendingById.delete(oldest);
        }
        this.pendingById.set(call.id, {
          args: mergeDefinedArgs(existing?.args, call.args),
          kind: call.kind !== undefined ? call.kind : existing?.kind,
        });
      }
      return;
    }

    const cached = call.id ? this.pendingById.get(call.id) : undefined;
    if (call.id) this.pendingById.delete(call.id);

    if (call.status !== "completed") return;

    const toolName = call.name.trim();
    if (!toolName || IGNORED_TOOLS.has(toolName.toLowerCase())) return;

    const kind = call.kind ?? cached?.kind;
    const rawArgs = mergeDefinedArgs(cached?.args, call.args);
    const parsed = parseArgsObject(rawArgs);
    if (!parsed || parsed.incompleteDistinguishing) return;
    const parsedArgs = parsed.args;

    const extractedPaths = extractPaths(call, kind, parsedArgs);
    const query = extractQuery(call, kind, parsedArgs);
    const topicTokens = query?.topicText ? extractTopicTokens(query.topicText) : [];
    const opKey = extractOperationKey(parsedArgs);
    const hasNonCwdPath = extractedPaths.some((p) => !p.fromCwd);

    // Skip calls whose inputs cannot distinguish operations (for example cwd alone with no path, query, or argv/op).
    if (!hasNonCwdPath && !query && !opKey) return;

    const addedNewTopic = topicTokens.length > 0 ? this.recordTopic(topicTokens) : false;

    const normalizedPaths: string[] = [];
    const lineSuffixes: string[] = [];
    const callAreas: string[] = [];
    const callAreaSet = new Set<string>();

    for (const item of extractedPaths) {
      const normalizedPath = this.normalizePathKey(item.path);
      normalizedPaths.push(normalizedPath);
      if (item.lineSuffix) lineSuffixes.push(item.lineSuffix);
      const area = this.toArea(item.path, item.isDirHint);
      if (!callAreaSet.has(area)) {
        callAreaSet.add(area);
        callAreas.push(area);
      }
    }

    const toolKey = toolName.toLowerCase();
    const pathKey = [...normalizedPaths].sort().join("|");
    const rangeKey = extractRangeKey(parsedArgs, lineSuffixes);
    const queryKey = query ? query.identityKey : "";

    const callKey = JSON.stringify([toolKey, pathKey, rangeKey, queryKey, opKey]);
    if (this.lastCallKey === callKey) {
      this.repeatStreak += 1;
    } else {
      this.lastCallKey = callKey;
      this.repeatStreak = 1;
    }
    this.lastToolName = toolName;
    this.scoredCallCount += 1;

    if (callAreas.length > 0) {
      const callIndex = this.pathCallCount;
      this.pathCallCount += 1;
      for (const area of callAreas) {
        if (!this.areaFirstSeenAt.has(area)) {
          this.areaFirstSeenAt.set(area, callIndex);
        }
      }
      this.recentPathCalls.push({ areas: callAreas });
      if (this.recentPathCalls.length > WIDENING_WINDOW) {
        this.recentPathCalls.shift();
      }
    }

    const isNewProgress = !this.seenProgressKeys.has(callKey);
    if (isNewProgress) this.seenProgressKeys.add(callKey);
    if (isNewProgress || addedNewTopic) {
      this.staleStreak = 0;
    } else {
      this.staleStreak += 1;
    }
  }

  evaluate(): ScopeFinding | null {
    const sig = this.signals();
    const widening = sig.distinctAreas.length >= WIDENING_MIN_AREAS && sig.newAreasInWindow >= WIDENING_MIN_NEW_IN_WINDOW;
    const topicSpread = sig.searchTopics.length >= TOPIC_MIN_COUNT;
    const wideAndMultiTopic = widening && topicSpread;

    const repeatedNow = this.repeatStreak >= REPEAT_THRESHOLD;
    const staleNow = this.staleStreak >= STALE_THRESHOLD;

    if (!wideAndMultiTopic && !repeatedNow && !staleNow) return null;

    const finding: ScopeFinding = {};
    if (wideAndMultiTopic) {
      finding.widening = {
        areas: sig.distinctAreas,
        topics: sig.searchTopics,
      };
    }
    if (repeatedNow) {
      finding.repeated = {
        tool: this.lastToolName || "tool",
        times: this.repeatStreak,
      };
    }
    if (staleNow) {
      finding.stale = {
        reads: this.staleStreak,
      };
    }
    return finding;
  }

  marks(): { areas: number; scoredCalls: number } {
    return {
      areas: this.areaFirstSeenAt.size,
      scoredCalls: this.scoredCallCount,
    };
  }

  resetStale(): void {
    this.staleStreak = 0;
  }

  signals(): ScopeSignals {
    const windowStart = Math.max(0, this.pathCallCount - WIDENING_WINDOW);
    let newAreasInWindow = 0;
    for (const entry of this.recentPathCalls) {
      if (entry.areas.some((a) => (this.areaFirstSeenAt.get(a) ?? -1) >= windowStart)) {
        newAreasInWindow += 1;
      }
    }
    return {
      distinctAreas: [...this.areaFirstSeenAt.keys()],
      newAreasInWindow,
      searchTopics: this.topicClusters.map((c) => c.label),
      repeatStreak: this.repeatStreak,
      staleStreak: this.staleStreak,
    };
  }

  private recordTopic(tokens: string[]): boolean {
    const matchingIndices: number[] = [];
    for (let i = 0; i < this.topicClusters.length; i++) {
      const cluster = this.topicClusters[i]!;
      if (tokens.some((tok) => cluster.tokens.has(tok))) {
        matchingIndices.push(i);
      }
    }
    if (matchingIndices.length === 0) {
      this.topicClusters.push({ label: tokens[0]!, tokens: new Set(tokens) });
      return true;
    }
    const target = this.topicClusters[matchingIndices[0]!]!;
    for (const tok of tokens) target.tokens.add(tok);
    for (let i = matchingIndices.length - 1; i >= 1; i--) {
      const idx = matchingIndices[i]!;
      for (const tok of this.topicClusters[idx]!.tokens) target.tokens.add(tok);
      this.topicClusters.splice(idx, 1);
    }
    return false;
  }

  private normalizePathKey(rawPath: string): string {
    const slash = rawPath.replaceAll("\\", "/").trim();
    const abs = isAbsolute(slash) ? resolve(slash) : resolve(this.workspaceRoot, slash);
    const rel = relative(this.workspaceRoot, abs).replaceAll("\\", "/");
    if (!rel || rel === ".") return ".";
    if (hasParentTraversalComponent(rel) || isAbsolute(rel)) return abs.replaceAll("\\", "/");
    return rel;
  }

  private toArea(rawPath: string, isDirHint: boolean): string {
    const slash = rawPath.replaceAll("\\", "/").trim();
    const abs = isAbsolute(slash) ? resolve(slash) : resolve(this.workspaceRoot, slash);
    const rel = relative(this.workspaceRoot, abs).replaceAll("\\", "/");

    if (!rel || rel === ".") return ".";

    if (hasParentTraversalComponent(rel) || isAbsolute(rel)) {
      const segs = abs.replaceAll("\\", "/").split("/").filter(Boolean);
      const dirSegs = !isDirHint && segs.length > 1 && FILE_EXT_RE.test(segs[segs.length - 1]!)
        ? segs.slice(0, -1)
        : segs;
      return `ext:${dirSegs.slice(0, 3).join("/")}`;
    }

    const segs = rel.split("/").filter(Boolean);
    if (segs.length === 0) return ".";
    if (segs.length === 1) {
      // A single-segment file at workspaceRoot buckets to "."; an explicit dir/cwd stays as its segment.
      return isDirHint && !FILE_EXT_RE.test(segs[0]!) ? segs[0]! : ".";
    }
    const last = segs[segs.length - 1]!;
    const dirSegs = !isDirHint && FILE_EXT_RE.test(last) ? segs.slice(0, -1) : segs;
    if (dirSegs.length === 0) return ".";
    return dirSegs.slice(0, this.areaDepth).join("/");
  }
}
