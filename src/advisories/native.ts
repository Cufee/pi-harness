import { isAbsolute, relative, resolve } from "node:path";
import type { ToolEventLike } from "./types.js";

export interface MergedEvent {
  id?: string;
  name: string;
  kind?: string;
  status: "completed" | "failed";
  args: Record<string, unknown> | undefined;
  paths: string[];
  harnessTool: string | null;
  viaCodeExec: boolean;
  nativeClass: "read" | "search" | "edit" | "shell" | "fetch" | "other";
  denied?: string;
}

const MAX_PENDING_CACHE = 256;

const SINGLE_PATH_KEYS = [
  "path",
  "file_path",
  "filePath",
  "target_file",
  "notebook_path",
  "old_path",
  "new_path",
  "source",
  "destination",
] as const;

const PATCH_LINE_RE = /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;

const HARNESS_TITLE_RE =
  /(?:^|[^a-z0-9/\\])(?:mcp(?:__|_|\/|\.|:))?harness(?:__|_|\/|\.|:|\s)+([a-z][a-z0-9_]*)(?=$|[^a-z0-9_./\\])/i;

const EDIT_WORDS = new Set(["edit", "write", "create", "patch", "replace", "delete", "move", "rename"]);
const READ_WORDS = new Set(["read", "view", "cat", "open"]);
const SEARCH_WORDS = new Set(["grep", "glob", "search", "find", "list"]);
const SHELL_WORDS = new Set(["bash", "shell", "exec", "execute", "run"]);

/** The harness tool an event title names, or null. */
export function harnessToolFromTitle(title: string, names: ReadonlySet<string>): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  if (names.has(trimmed)) return trimmed;
  const lower = trimmed.toLowerCase();
  if (names.has(lower)) return lower;
  const match = HARNESS_TITLE_RE.exec(trimmed);
  if (match?.[1]) {
    const candidate = match[1].toLowerCase();
    if (names.has(candidate)) return candidate;
  }
  return null;
}

function splitIdentifierWords(token: string): string[] {
  return token
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function classifyWords(words: string[]): MergedEvent["nativeClass"] | null {
  for (const w of words) {
    if (EDIT_WORDS.has(w)) return "edit";
  }
  for (const w of words) {
    if (READ_WORDS.has(w)) return "read";
  }
  for (const w of words) {
    if (SEARCH_WORDS.has(w)) return "search";
  }
  for (const w of words) {
    if (SHELL_WORDS.has(w)) return "shell";
  }
  for (const w of words) {
    if (w === "fetch") return "fetch";
  }
  return null;
}

export function classifyNative(kind: string | undefined, title: string): MergedEvent["nativeClass"] {
  const normalizedKind = kind?.trim().toLowerCase();
  if (normalizedKind) {
    if (normalizedKind === "read") return "read";
    if (normalizedKind === "search") return "search";
    if (normalizedKind === "edit" || normalizedKind === "delete" || normalizedKind === "move") return "edit";
    if (normalizedKind === "execute") return "shell";
    if (normalizedKind === "fetch") return "fetch";
    if (normalizedKind === "think") return "other";
  }

  const trimmed = title.trim();
  if (!trimmed) return "other";
  const parts = trimmed.split(/\s+/);
  const first = parts[0];
  if (first) {
    const cls = classifyWords(splitIdentifierWords(first));
    if (cls) return cls;
  }
  // Check non-path leading words (for example "Apply patch src/a.ts") without matching filenames.
  for (let i = 1; i < Math.min(parts.length, 3); i++) {
    const part = parts[i]!;
    if (part.includes("/") || part.includes("\\") || part.includes(".")) break;
    const cls = classifyWords(splitIdentifierWords(part));
    if (cls) return cls;
  }
  return "other";
}

function stripLineSuffix(raw: string): string {
  const match = /^(.*):(\d+(?:-\d+)?)$/.exec(raw);
  if (match && match[1] && match[1].length > 1) {
    return match[1];
  }
  return raw;
}

function addPathUnique(out: string[], seen: Set<string>, raw: string): void {
  const trimmed = stripLineSuffix(raw.trim());
  if (!trimmed || seen.has(trimmed)) return;
  seen.add(trimmed);
  out.push(trimmed);
}

function extractPatchPaths(text: string, out: string[], seen: Set<string>): void {
  PATCH_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PATCH_LINE_RE.exec(text)) !== null) {
    if (match[1]) addPathUnique(out, seen, match[1]);
  }
}

/** Paths named by tool arguments, in order, without duplicates. */
export function pathsFromArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const key of SINGLE_PATH_KEYS) {
    const val = args[key];
    if (typeof val === "string") {
      addPathUnique(out, seen, val);
    }
  }

  if (Array.isArray(args.paths)) {
    for (const entry of args.paths) {
      if (typeof entry === "string") {
        addPathUnique(out, seen, entry);
      }
    }
  }

  if (args.changes && typeof args.changes === "object" && !Array.isArray(args.changes)) {
    for (const key of Object.keys(args.changes as Record<string, unknown>)) {
      addPathUnique(out, seen, key);
    }
  }

  for (const val of Object.values(args)) {
    if (typeof val === "string" && val.includes("*** ")) {
      extractPatchPaths(val, out, seen);
    }
  }

  return out;
}

function decodeJsonStringFragment(fragment: string): string {
  return fragment
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function parseRawArgs(raw: string | undefined): Record<string, unknown> | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Truncated JSON preview (e.g. cut at 512 chars): fall back to key-value extraction.
  }

  const out: Record<string, unknown> = {};

  const strRe = /"([A-Za-z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  for (const m of trimmed.matchAll(strRe)) {
    const key = m[1];
    const rawVal = m[2];
    if (!key || rawVal === undefined) continue;
    try {
      out[key] = JSON.parse(`"${rawVal}"`);
    } catch {
      out[key] = decodeJsonStringFragment(rawVal);
    }
  }

  // Also capture an unterminated trailing string value (e.g. truncated apply_patch input).
  const tailRe = /"([A-Za-z0-9_]+)"\s*:\s*"((?:\\.|[^"\\])*)$/;
  const tailMatch = tailRe.exec(trimmed);
  if (tailMatch?.[1] && tailMatch[2] !== undefined && !(tailMatch[1] in out)) {
    out[tailMatch[1]] = decodeJsonStringFragment(tailMatch[2]);
  }

  const pathsArrMatch = /"paths"\s*:\s*\[([^\]]*)\]/.exec(trimmed);
  if (pathsArrMatch?.[1] !== undefined) {
    try {
      const parsedPaths = JSON.parse(`[${pathsArrMatch[1]}]`);
      if (Array.isArray(parsedPaths)) {
        out.paths = parsedPaths.filter((p): p is string => typeof p === "string");
      }
    } catch {
      const items: string[] = [];
      for (const m of pathsArrMatch[1].matchAll(/"((?:\\.|[^"\\])*)"/g)) {
        if (m[1] !== undefined) items.push(decodeJsonStringFragment(m[1]));
      }
      if (items.length > 0) out.paths = items;
    }
  }

  const changesIdx = trimmed.indexOf('"changes"');
  if (changesIdx !== -1) {
    const braceIdx = trimmed.indexOf("{", changesIdx);
    if (braceIdx !== -1) {
      const slice = trimmed.slice(braceIdx + 1);
      const changesObj: Record<string, unknown> = {};
      for (const m of slice.matchAll(/"([^"]+)"\s*:/g)) {
        const k = m[1];
        if (k && (k.includes("/") || k.includes("."))) {
          changesObj[k] = true;
        }
      }
      if (Object.keys(changesObj).length > 0) {
        out.changes = changesObj;
      }
    }
  }

  if (Object.keys(out).length === 0 && trimmed.includes("*** ")) {
    out.patch = trimmed;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeArgs(
  prev: Record<string, unknown> | undefined,
  next: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!prev) return next ? { ...next } : undefined;
  if (!next) return { ...prev };
  const merged: Record<string, unknown> = { ...prev };
  for (const [key, value] of Object.entries(next)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function mergeUniqueStrings(prev: string[] | undefined, next: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const list of [prev, next]) {
    if (!list) continue;
    for (const item of list) {
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function normalizePath(rawPath: string, absRoot: string): string | null {
  const cleaned = stripLineSuffix(rawPath.trim());
  if (!cleaned) return null;
  if (cleaned === "~" || cleaned.startsWith("~/")) return cleaned;
  const slashPath = cleaned.replaceAll("\\", "/");
  const absPath = isAbsolute(slashPath) ? resolve(slashPath) : resolve(absRoot, slashPath);
  const rel = relative(absRoot, absPath).replaceAll("\\", "/");
  if (rel === "") return ".";
  if (!rel.startsWith("..") && !isAbsolute(rel)) {
    return rel;
  }
  return absPath.replaceAll("\\", "/");
}

interface PendingEntry {
  name: string;
  title?: string;
  kind?: string;
  args: Record<string, unknown> | undefined;
  paths: string[];
  viaCodeExec: boolean;
  denied?: string;
}

/** Stateful per subject and generation. */
export class NativeEventParser {
  private readonly absRoot: string;
  private readonly harnessToolNames: ReadonlySet<string>;
  private readonly pending = new Map<string, PendingEntry>();

  constructor(opts: { workspaceRoot: string; harnessToolNames: ReadonlySet<string> }) {
    this.absRoot = resolve(opts.workspaceRoot);
    this.harnessToolNames = opts.harnessToolNames;
  }

  /**
   * pending / in_progress: caches args, kind, title, and paths under ev.id and returns null.
   * completed / failed: merges the cached fields with this event, deletes the cache entry, returns the merged event.
   * An event with no id is parsed by itself. The cache holds at most 256 calls and drops the oldest.
   */
  push(ev: ToolEventLike): MergedEvent | null {
    const parsedArgs = parseRawArgs(ev.args);
    const evPaths = ev.paths && ev.paths.length > 0 ? ev.paths : undefined;
    const status = ev.status === "pending" ? "in_progress" : ev.status;

    if (status === "in_progress") {
      if (ev.id) {
        const prev = this.pending.get(ev.id);
        if (!prev && this.pending.size >= MAX_PENDING_CACHE) {
          const oldest = this.pending.keys().next().value;
          if (oldest !== undefined) this.pending.delete(oldest);
        }
        this.pending.set(ev.id, {
          name: ev.name || prev?.name || "tool",
          title: ev.title ?? prev?.title,
          kind: ev.kind ?? prev?.kind,
          args: mergeArgs(prev?.args, parsedArgs),
          paths: mergeUniqueStrings(prev?.paths, evPaths),
          viaCodeExec: prev?.viaCodeExec === true || ev.via === "code_exec",
          denied: ev.denied ?? prev?.denied,
        });
      }
      return null;
    }

    if (status !== "completed" && status !== "failed") {
      return null;
    }

    const cached = ev.id ? this.pending.get(ev.id) : undefined;
    if (ev.id) this.pending.delete(ev.id);

    const name = ev.name && ev.name !== "tool" ? ev.name : (cached?.name ?? ev.name ?? "tool");
    const title = ev.title && ev.title !== "tool" ? ev.title : (cached?.title ?? ev.title ?? name);
    const kind = ev.kind ?? cached?.kind;
    const mergedArgs = mergeArgs(cached?.args, parsedArgs);
    const viaCodeExec = ev.via === "code_exec" || cached?.viaCodeExec === true;
    const denied = ev.denied ?? cached?.denied;

    const eventPaths = mergeUniqueStrings(cached?.paths, evPaths);
    const rawPaths = eventPaths.length > 0 ? eventPaths : mergedArgs ? pathsFromArgs(mergedArgs) : [];
    const normalizedPaths: string[] = [];
    const seenPaths = new Set<string>();
    for (const p of rawPaths) {
      const norm = normalizePath(p, this.absRoot);
      if (norm && !seenPaths.has(norm)) {
        seenPaths.add(norm);
        normalizedPaths.push(norm);
      }
    }

    let harnessTool =
      harnessToolFromTitle(title, this.harnessToolNames) ??
      harnessToolFromTitle(name, this.harnessToolNames);

    if (
      !harnessTool &&
      mergedArgs &&
      mergedArgs.server === "harness" &&
      typeof mergedArgs.tool === "string" &&
      this.harnessToolNames.has(mergedArgs.tool)
    ) {
      harnessTool = mergedArgs.tool;
    }

    const nativeClass = classifyNative(kind, title);

    return {
      ...(ev.id !== undefined ? { id: ev.id } : {}),
      name: title || name,
      ...(kind !== undefined ? { kind } : {}),
      status,
      args: mergedArgs,
      paths: normalizedPaths,
      harnessTool,
      viaCodeExec,
      nativeClass,
      ...(denied !== undefined ? { denied } : {}),
    };
  }
}
