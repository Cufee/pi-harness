import { basename, isAbsolute, relative, resolve } from "node:path";
import { legacyStoragePaths } from "../storage/paths.js";
import type { AdvisoryRule, Finding, ObservedCall, Role, RuleContext, ScopeFinding, Subject } from "./types.js";

export const SCOPE_ROLES: ReadonlySet<Role> = new Set<Role>(["research", "plan", "verify", "execute"]);

export const SCOPE_REARM_AREA_GROWTH = 6;
export const SCOPE_REARM_SPIN_CALLS = 12;

export const BRIEF_COUNT_PATTERNS: readonly RegExp[] = [
  /(?:\b(?:at most|no more than|max(?:imum)?(?: of)?|within|under|up to|limit(?:ed)? to|budget of|you have)\s+~?|~)\d[\d,.]*\s*k?\s*(?:tool[- ]calls?|turns?|tokens)\b/i,
  /\bturn budget:\s*\d/i,
  /\b(?:stop|return|finish|wrap up)\b[^.\n]{0,40}\b(?:after|before|by)\s+~?\d[\d,.]*\s*k?\s*(?:tool[- ]calls?|turns?|tokens)\b/i,
];

/** Pattern checked against every harness-written prompt and description (section 6.4 / T5-4). */
export const HARNESS_TEXT_COUNT_PATTERN = /\b\d[\d,]*\s*k?\s*(?:tool[- ]call\s+)?(?:turns|tokens)\b/i;

export const STATUS_TOOLS: ReadonlySet<string> = new Set([
  "goal_get",
  "run_status",
  "task_get",
  "tree_view",
  "queue_list",
  "list_timers",
]);

const WAIT_POLL_TOOLS: ReadonlySet<string> = new Set(["wait_children", "wait_tasks"]);

const READ_ONLY_FINDING_CATEGORIES: ReadonlySet<string> = new Set([
  "verification_failed",
  "code_defect",
  "broken_test",
]);

const OUTPUT_SIZE_WORDS: ReadonlySet<string> = new Set([
  "summary",
  "handoff",
  "output",
  "response",
  "reply",
  "answer",
  "report",
]);

const VOLATILE_RESULT_KEYS: ReadonlySet<string> = new Set([
  "harness_advisory",
  "updatedAt",
  "now",
  "elapsedMs",
]);

const MAX_DISPLAY_PATH_CHARS = 48;
const MAX_DISPLAY_SCOPE_CHARS = 32;
const MAX_DISPLAY_SAMPLE_CHARS = 32;
const MAX_DISPLAY_ID_CHARS = 32;
const MAX_DISPLAY_MATCH_CHARS = 48;

function hasParentTraversalComponent(p: string): boolean {
  return p.replaceAll("\\", "/").split("/").includes("..");
}

function isOutsideWorkspacePath(p: string): boolean {
  return !p || p === "." || p === "~" || p.startsWith("~/") || hasParentTraversalComponent(p) || isAbsolute(p);
}

function isUnderRoot(targetAbs: string, rootAbs: string): boolean {
  const rel = relative(rootAbs, targetAbs).replaceAll("\\", "/");
  return rel === "" || (!hasParentTraversalComponent(rel) && !isAbsolute(rel));
}

function isUnderAnyExtraRoot(workspaceRoot: string, relPath: string, extraRoots: readonly string[]): boolean {
  if (extraRoots.length === 0) return false;
  const targetAbs = resolve(workspaceRoot, relPath);
  for (const rawRoot of extraRoots) {
    if (!rawRoot.trim()) continue;
    const rootAbs = resolve(workspaceRoot, rawRoot);
    if (isUnderRoot(targetAbs, rootAbs)) return true;
  }
  return false;
}

function countSnippetWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function clipSnippet(raw: string, maxWords: number, maxChars: number): string {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  let clipped = words.length > maxWords ? `${words.slice(0, maxWords).join(" ")}…` : words.join(" ");
  if (clipped.length > maxChars) {
    const budget = Math.max(1, maxChars - 1);
    clipped = `${clipped.slice(0, budget).trimEnd()}…`;
  }
  return clipped;
}

function formatBoundedList(
  items: readonly string[],
  opts: { maxItems: number; maxWords: number; maxItemChars: number },
): string {
  const cleaned = items.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length === 0) return "";

  const canKeepAll = cleaned.length <= opts.maxItems && cleaned.length <= opts.maxWords;
  if (canKeepAll) {
    const charBounded = cleaned.map((item) => clipSnippet(item, opts.maxWords, opts.maxItemChars));
    const totalWords = charBounded.reduce((sum, s) => sum + countSnippetWords(s), 0);
    if (totalWords <= opts.maxWords) {
      return charBounded.join(", ");
    }
    const perItemWords = Math.max(1, Math.floor(opts.maxWords / cleaned.length));
    return cleaned.map((item) => clipSnippet(item, perItemWords, opts.maxItemChars)).join(", ");
  }

  // Reserve 1 word for "+N".
  const itemBudgetWords = Math.max(1, opts.maxWords - 1);
  const shownCount = Math.min(cleaned.length - 1, opts.maxItems, itemBudgetWords);
  const shown = cleaned.slice(0, shownCount);
  const perItemWords = Math.max(1, Math.floor(itemBudgetWords / shown.length));
  const formatted = shown.map((item) => clipSnippet(item, perItemWords, opts.maxItemChars));
  const omitted = cleaned.length - shown.length;
  return `${formatted.join(", ")}, +${omitted}`;
}

function formatScopeList(scopes: readonly string[]): string {
  return formatBoundedList(scopes, {
    maxItems: 3,
    maxWords: 3,
    maxItemChars: MAX_DISPLAY_SCOPE_CHARS,
  });
}

function formatSampleList(items: readonly string[]): string {
  return formatBoundedList(items, {
    maxItems: 3,
    maxWords: 4,
    maxItemChars: MAX_DISPLAY_SAMPLE_CHARS,
  });
}

function stripQuotedAndCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/"[^"\n]*"/g, " ")
    .replace(/(^|[\s([{-])'[^'\n]*'(?=$|[\s.,;:!?)\]}])/g, "$1 ");
}

function nearOutputSizeWord(text: string, start: number, end: number): boolean {
  const beforeWords = text
    .slice(0, start)
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean)
    .slice(-5);
  for (const w of beforeWords) {
    if (OUTPUT_SIZE_WORDS.has(w)) return true;
  }
  const afterWords = text
    .slice(end)
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter(Boolean)
    .slice(0, 5);
  for (const w of afterWords) {
    if (OUTPUT_SIZE_WORDS.has(w)) return true;
  }
  return false;
}

function compactMatchSnippet(raw: string): string {
  const words = raw.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 6) return words.join(" ");
  return `${words.slice(0, 2).join(" ")} ... ${words.slice(-3).join(" ")}`;
}

function areaOfWorkspaceFile(relPath: string): string {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length <= 1) return ".";
  return parts.slice(0, -1).slice(0, 2).join("/");
}

function normalizeWorkspaceFile(rawPath: string, workspaceRoot: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed === "~" || trimmed.startsWith("~/")) return null;
  const absRoot = resolve(workspaceRoot);
  const slashPath = trimmed.replaceAll("\\", "/");
  const absPath = isAbsolute(slashPath) ? resolve(slashPath) : resolve(absRoot, slashPath);
  const rel = relative(absRoot, absPath).replaceAll("\\", "/");
  if (!rel || rel === "." || hasParentTraversalComponent(rel) || isAbsolute(rel)) return null;
  return rel;
}

function matchesPathHints(relPath: string, hints: readonly string[], workspaceRoot: string): boolean {
  if (hints.length === 0) return false;
  const fileBase = basename(relPath);
  const absRoot = resolve(workspaceRoot);

  for (const rawHint of hints) {
    let hint = rawHint.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!hint) continue;
    if (isAbsolute(hint)) {
      const relHint = relative(absRoot, resolve(hint)).replaceAll("\\", "/");
      if (!relHint || hasParentTraversalComponent(relHint) || isAbsolute(relHint)) continue;
      hint = relHint;
    }
    const hintNoSlash = hint.replace(/\/+$/, "");
    if (!hintNoSlash) continue;
    if (relPath === hintNoSlash) return true;
    if (relPath.startsWith(`${hintNoSlash}/`)) return true;
    if (!hintNoSlash.includes("/") && fileBase === hintNoSlash) return true;
    if (hintNoSlash.includes("/") && relPath.endsWith(`/${hintNoSlash}`)) return true;
  }
  return false;
}

function stripVolatile(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(stripVolatile);
  const out: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>).sort();
  for (const key of keys) {
    if (VOLATILE_RESULT_KEYS.has(key)) continue;
    out[key] = stripVolatile((value as Record<string, unknown>)[key]);
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

// 1. worker-edit-outside-scope (6.1)
interface WorkerEditState {
  reported: Set<string>;
  lastPath: string | null;
}

const workerEditOutsideScopeRule: AdvisoryRule<WorkerEditState> = {
  id: "worker-edit-outside-scope",
  roles: ["worker", "execute"],
  surface: "event",
  priority: 100,
  init: () => ({ reported: new Set(), lastPath: null }),
  observe(state, subject, call, ctx): Finding | null {
    if (subject.readOnly) return null;
    if (call.status !== "completed" || call.surface !== "native" || call.nativeClass !== "edit" || call.inScript) {
      return null;
    }
    if (subject.writeScopes.length === 0 || call.paths.length === 0) return null;

    const candidates: string[] = [];
    for (const p of call.paths) {
      if (isOutsideWorkspacePath(p)) continue;
      if (isUnderAnyExtraRoot(subject.workspaceRoot, p, subject.writableExtraRoots)) continue;
      candidates.push(p);
    }
    if (candidates.length === 0) return null;

    const outside = ctx.filesOutsideWriteScopes(candidates, subject.writeScopes);
    if (outside.length === 0) return null;

    const target = outside.find((p) => !state.reported.has(p)) ?? outside[0]!;
    state.lastPath = target;
    const displayTarget = clipSnippet(target, 2, MAX_DISPLAY_PATH_CHARS) || target;
    return {
      key: target,
      what: `${displayTarget} is outside your write scopes (${formatScopeList(subject.writeScopes)}).`,
      why: "The merge queue rejects a branch that changes files outside its scopes, and another task may own this file.",
      alternative:
        "Revert the edit if it is not needed. If the change is required, call report_issue with category interface_conflict, or return_task with status scope_too_large, so your parent can widen the scope.",
      data: { path: target, writeScopes: subject.writeScopes },
    };
  },
  dedupe: {
    perKey: "subject",
    maxPerSubject: 3,
  },
  fired(state) {
    if (state.lastPath) state.reported.add(state.lastPath);
  },
};

// 2. scope-too-large (6.2)
interface ScopeRuleState {
  hasFired: boolean;
  areasAtFire: number;
  scoredCallsAtFire: number;
  lastFinding: ScopeFinding | null;
  seenNonEditCall: boolean;
  editIntervened: boolean;
  sawDifferentResult: boolean;
  lastRepeatCallSig: string | null;
  lastRepeatResultSig: string | null;
  sameCallStreak: number;
  sameResultStreak: number;
}

const scopeTooLargeRule: AdvisoryRule<ScopeRuleState> = {
  id: "scope-too-large",
  roles: ["research", "plan", "verify", "execute"],
  surface: "event",
  priority: 80,
  init: () => ({
    hasFired: false,
    areasAtFire: 0,
    scoredCallsAtFire: 0,
    lastFinding: null,
    seenNonEditCall: false,
    editIntervened: false,
    sawDifferentResult: false,
    lastRepeatCallSig: null,
    lastRepeatResultSig: null,
    sameCallStreak: 0,
    sameResultStreak: 0,
  }),
  observe(state, _subject, call, ctx): Finding | null {
    if (!ctx.scope) return null;

    if (call.status === "completed") {
      if (call.surface === "native" && call.nativeClass === "edit") {
        if (state.seenNonEditCall) {
          state.editIntervened = true;
        }
        state.sawDifferentResult = false;
        state.lastRepeatCallSig = null;
        state.lastRepeatResultSig = null;
        state.sameCallStreak = 0;
        state.sameResultStreak = 0;
      } else {
        state.seenNonEditCall = true;
        const callSig = `${call.surface}:${call.tool.toLowerCase()}:${stableStringify(call.args ?? {})}`;
        const resultSig = call.result !== undefined ? stableStringify(stripVolatile(call.result)) : null;
        if (callSig === state.lastRepeatCallSig) {
          state.sameCallStreak += 1;
          if (state.sameCallStreak >= 3) {
            state.editIntervened = false;
          }
          if (resultSig !== null) {
            if (state.lastRepeatResultSig === null || resultSig === state.lastRepeatResultSig) {
              state.lastRepeatResultSig = resultSig;
              state.sameResultStreak += 1;
              if (state.sameResultStreak >= 3) {
                state.sawDifferentResult = false;
              }
            } else {
              state.lastRepeatResultSig = resultSig;
              state.sameResultStreak = 1;
              state.sawDifferentResult = true;
            }
          }
        } else {
          state.lastRepeatCallSig = callSig;
          state.sameCallStreak = 1;
          state.lastRepeatResultSig = resultSig;
          state.sameResultStreak = resultSig !== null ? 1 : 0;
          state.sawDifferentResult = false;
        }
      }
    }

    const rawFinding = ctx.scope.evaluate();
    if (!rawFinding) {
      state.lastFinding = null;
      return null;
    }

    const suppressRepeated = state.editIntervened || state.sawDifferentResult;
    const finding: ScopeFinding = {
      ...(rawFinding.widening ? { widening: rawFinding.widening } : {}),
      ...(rawFinding.repeated && !suppressRepeated ? { repeated: rawFinding.repeated } : {}),
      ...(rawFinding.stale ? { stale: rawFinding.stale } : {}),
    };

    const reasonKeys: Array<"widening" | "repeated" | "stale"> = [];
    if (finding.widening) reasonKeys.push("widening");
    if (finding.repeated) reasonKeys.push("repeated");
    if (finding.stale) reasonKeys.push("stale");
    if (reasonKeys.length === 0) {
      state.lastFinding = null;
      return null;
    }
    state.lastFinding = finding;

    const primaryReason = reasonKeys[0]!;
    let what: string;
    if (primaryReason === "widening" && finding.widening) {
      const areas = formatSampleList(finding.widening.areas);
      const topics = formatSampleList(finding.widening.topics);
      what = `You have opened ${finding.widening.areas.length} areas (${areas}) and searched ${finding.widening.topics.length} unrelated topics (${topics}).`;
    } else if (primaryReason === "repeated" && finding.repeated) {
      const tool = clipSnippet(finding.repeated.tool, 1, MAX_DISPLAY_ID_CHARS) || "tool";
      what = `You repeated the same ${tool} call ${finding.repeated.times} times.`;
    } else {
      what = `Your last ${finding.stale!.reads} reads found nothing new.`;
    }

    return {
      key: "scope",
      what,
      why: "This usually means the task exceeds one bounded assignment.",
      alternative:
        "If you are still answering one bounded question, continue. Otherwise save findings with artifact_write, then call return_task with status scope_too_large, partial: true, artifact_paths, and suggested_splits, one per open area.",
      data: {
        reasons: reasonKeys,
        finding,
        signals: ctx.scope.signals(),
      },
    };
  },
  dedupe: {
    perKey: "generation",
    maxPerGeneration: 2,
    rearm(state, ctx) {
      if (!ctx.scope || !state.hasFired || !state.lastFinding) return false;
      const marks = ctx.scope.marks();
      const areaGrew =
        Boolean(state.lastFinding.widening) && marks.areas >= state.areasAtFire + SCOPE_REARM_AREA_GROWTH;
      const spunAgain =
        Boolean(state.lastFinding.repeated || state.lastFinding.stale) &&
        marks.scoredCalls >= state.scoredCallsAtFire + SCOPE_REARM_SPIN_CALLS;
      return areaGrew || spunAgain;
    },
  },
  fired(state, ctx) {
    if (!ctx.scope) return;
    const marks = ctx.scope.marks();
    state.areasAtFire = marks.areas;
    state.scoredCallsAtFire = marks.scoredCalls;
    state.hasFired = true;
    if (state.lastFinding?.stale) {
      ctx.scope.resetStale();
    }
  },
};

// 3. read-only-finding-escalation (6.3)
const readOnlyFindingEscalationRule: AdvisoryRule<null> = {
  id: "read-only-finding-escalation",
  roles: ["research", "plan", "verify"],
  surface: "result",
  priority: 70,
  init: () => null,
  observe(_state, _subject, call): Finding | null {
    if (call.status !== "completed" || call.surface !== "harness" || call.tool !== "report_issue") {
      return null;
    }
    const category = typeof call.args?.category === "string" ? call.args.category : "";
    if (!READ_ONLY_FINDING_CATEGORIES.has(category)) return null;
    if (!call.result || typeof call.result !== "object" || Array.isArray(call.result)) return null;
    const res = call.result as Record<string, unknown>;
    if (res.blocking !== false) return null;
    const esc = typeof res.escalationId === "string" && res.escalationId.trim() ? res.escalationId.trim() : "escalation";
    const displayEsc = clipSnippet(esc, 1, MAX_DISPLAY_ID_CHARS) || "escalation";
    const routedTo = typeof res.routedTo === "string" ? res.routedTo.trim() : "";
    const severity =
      typeof res.severity === "string"
        ? res.severity
        : typeof call.args?.severity === "string"
          ? call.args.severity
          : "";
    const toHuman = routedTo === "human" || (routedTo === "" && severity === "P0");
    const recipient = toHuman ? "the human" : "your parent";

    return {
      key: "read-only-finding-escalation",
      what: `Your finding was recorded as non-blocking escalation ${displayEsc} for ${recipient}, and this task continues.`,
      why: "Read-only tasks never block via report_issue and deliver findings in their handoff.",
      alternative:
        'Keep going and put the finding and its evidence in return_task, or call return_task with status "blocked" if you cannot produce a result.',
      data: { escalationId: esc, category },
    };
  },
  dedupe: {
    perKey: "subject",
    maxPerSubject: 1,
  },
};

// 4. brief-count-limit (6.4)
const briefCountLimitRule: AdvisoryRule<null> = {
  id: "brief-count-limit",
  roles: ["director", "orchestrator", "worker"],
  surface: "result",
  priority: 60,
  init: () => null,
  observe(_state, subject, call): Finding | null {
    if (
      call.status !== "completed" ||
      call.surface !== "harness" ||
      (call.tool !== "spawn_task" && call.tool !== "spawn_worker")
    ) {
      return null;
    }
    const args = call.args;
    if (!args) return null;
    const rawBrief = [args.title, args.objective, args.criteria]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join("\n");
    if (!rawBrief) return null;

    const cleaned = stripQuotedAndCode(rawBrief);
    let matched: string | null = null;

    for (const pattern of BRIEF_COUNT_PATTERNS) {
      const globalRe = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = globalRe.exec(cleaned)) !== null) {
        if (!nearOutputSizeWord(cleaned, m.index, m.index + m[0].length)) {
          matched = m[0];
          break;
        }
      }
      if (matched) break;
    }

    if (!matched) return null;

    const res =
      call.result && typeof call.result === "object" && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : undefined;
    const childId =
      typeof res?.spawned === "string" && res.spawned.trim()
        ? res.spawned.trim()
        : typeof res?.taskId === "string" && res.taskId.trim()
          ? res.taskId.trim()
          : "the child";
    const steerTool = subject.role === "director" ? "steer_task" : "steer_child";
    const displayChildId = clipSnippet(childId, 2, MAX_DISPLAY_ID_CHARS) || "the child";
    const matchText = clipSnippet(compactMatchSnippet(matched), 6, MAX_DISPLAY_MATCH_CHARS);

    return {
      key: childId,
      what: `The brief for ${displayChildId} states a count as a limit ("${matchText}").`,
      why: "The harness never stops a task on a count, and a stated count makes a child cut bounded work short.",
      alternative: `Tell ${displayChildId} with ${steerTool} that the count is not a limit. In later briefs, describe the deliverable instead of a count.`,
      data: { childId, match: matched, tool: call.tool },
    };
  },
  dedupe: {
    perKey: "subject",
    maxPerSubject: 2,
  },
};

// 5. director-self-reading (6.5)
interface DirectorReadState {
  spawned: boolean;
  files: Set<string>;
  areas: Set<string>;
}

const directorSelfReadingRule: AdvisoryRule<DirectorReadState> = {
  id: "director-self-reading",
  roles: ["director"],
  surface: "result",
  priority: 50,
  init: () => ({ spawned: false, files: new Set(), areas: new Set() }),
  observe(state, subject, call): Finding | null {
    if (call.status !== "completed" || call.surface !== "harness") return null;
    if (call.tool === "spawn_task") {
      state.spawned = true;
      return null;
    }
    if (state.spawned) return null;
    if (call.tool !== "read_file") return null;

    const rawPath =
      call.paths[0] ?? (typeof call.args?.path === "string" ? call.args.path : undefined);
    if (!rawPath) return null;

    const rel = normalizeWorkspaceFile(rawPath, subject.workspaceRoot);
    if (!rel) return null;
    if (legacyStoragePaths.isHarnessOwnedRelPath(rel)) return null;
    if (matchesPathHints(rel, subject.brief.pathHints, subject.workspaceRoot)) return null;

    state.files.add(rel);
    state.areas.add(areaOfWorkspaceFile(rel));

    if (state.files.size >= 12 && state.areas.size >= 3) {
      return {
        key: "director-self-reading",
        what: `You have opened ${state.files.size} source files across ${state.areas.size} areas in this turn.`,
        why: "Lookups that span many files fill this chat's context and keep the user waiting.",
        alternative:
          "Delegate the question with spawn_task to a research task and read its summary with wait_tasks. Keep reading files the user named.",
        data: { files: [...state.files], areas: [...state.areas] },
      };
    }
    return null;
  },
  dedupe: {
    perKey: "subject",
    maxPerSubject: 1,
  },
};

// 6. status-polling (6.6)
interface StatusPollingState {
  lastSignature: string | null;
  streak: number;
}

const statusPollingRule: AdvisoryRule<StatusPollingState> = {
  id: "status-polling",
  roles: ["director", "orchestrator", "worker"],
  surface: "result",
  priority: 20,
  init: () => ({ lastSignature: null, streak: 0 }),
  observe(state, subject, call): Finding | null {
    if (call.surface !== "harness" || call.status !== "completed") {
      state.lastSignature = null;
      state.streak = 0;
      return null;
    }

    let signature: string | null = null;

    if (STATUS_TOOLS.has(call.tool)) {
      signature = `status:${call.tool}:${stableStringify(call.args ?? {})}:${stableStringify(stripVolatile(call.result))}`;
    } else if (WAIT_POLL_TOOLS.has(call.tool)) {
      const interval =
        typeof call.args?.fallback_interval_s === "number"
          ? call.args.fallback_interval_s
          : typeof call.args?.timeout_s === "number"
            ? call.args.timeout_s
            : undefined;
      const wakeReason =
        call.result && typeof call.result === "object" && !Array.isArray(call.result)
          ? (call.result as Record<string, unknown>).wakeReason
          : undefined;
      if (interval !== undefined && interval < 60 && wakeReason === "fallback_interval") {
        signature = `wait:${call.tool}:${stableStringify(call.args ?? {})}:${stableStringify(stripVolatile(call.result))}`;
      }
    }

    if (!signature) {
      state.lastSignature = null;
      state.streak = 0;
      return null;
    }

    if (signature === state.lastSignature) {
      state.streak += 1;
    } else {
      state.lastSignature = signature;
      state.streak = 1;
    }

    if (state.streak < 3) return null;

    const isDirector = subject.role === "director";
    return {
      key: "status-polling",
      what: `You called ${call.tool} ${state.streak} times in a row and got the same result.`,
      why: isDirector
        ? "The daemon wakes this chat when a goal or a delegated task settles or escalates."
        : "The harness wakes you when a child changes state, so repeated checks only spend tokens.",
      alternative: isDirector
        ? "Tell the user what is running and end your turn."
        : "Call wait_children with the default interval.",
      data: { tool: call.tool, streak: state.streak },
    };
  },
  dedupe: {
    perKey: "subject",
    maxPerSubject: 1,
  },
};

// 7. read-only-brief-needs-shell
const READ_ONLY_GIT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "rev-list",
  "merge-base",
  "ls-files",
  "ls-tree",
  "grep",
  "cat-file",
  "describe",
  "shortlog",
  "show-ref",
  "for-each-ref",
  "remote",
  "fetch",
  "ls-remote",
]);

const ALLOWLISTED_SIMPLE_BINS: ReadonlySet<string> = new Set([
  "rg",
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "nl",
  "stat",
]);

const SUBCOMMAND_REQUIRED_BINS: Readonly<Record<string, ReadonlySet<string>>> = {
  bun: new Set([
    "run",
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "build",
    "upgrade",
    "update",
    "pm",
    "link",
    "unlink",
    "init",
    "create",
    "exec",
    "x",
    "dev",
    "start",
    "lint",
    "format",
    "typecheck",
    "check",
    "test",
  ]),
  npm: new Set([
    "run",
    "install",
    "i",
    "ci",
    "test",
    "t",
    "start",
    "build",
    "exec",
    "publish",
    "pack",
    "init",
    "update",
    "up",
    "uninstall",
    "remove",
    "rm",
    "audit",
    "link",
    "rebuild",
    "prune",
    "version",
    "ls",
    "outdated",
  ]),
  pnpm: new Set([
    "run",
    "install",
    "i",
    "add",
    "remove",
    "rm",
    "test",
    "start",
    "build",
    "exec",
    "dlx",
    "publish",
    "pack",
    "init",
    "update",
    "up",
    "audit",
    "link",
    "rebuild",
    "prune",
    "dev",
    "lint",
    "typecheck",
    "check",
  ]),
  yarn: new Set([
    "run",
    "install",
    "add",
    "remove",
    "test",
    "start",
    "build",
    "exec",
    "dlx",
    "publish",
    "pack",
    "init",
    "upgrade",
    "up",
    "audit",
    "link",
    "dev",
    "lint",
    "typecheck",
    "check",
    "workspace",
    "workspaces",
  ]),
  cargo: new Set([
    "build",
    "b",
    "test",
    "t",
    "run",
    "r",
    "check",
    "c",
    "clippy",
    "fmt",
    "install",
    "uninstall",
    "publish",
    "bench",
    "doc",
    "clean",
    "update",
    "add",
    "remove",
    "fix",
    "nextest",
    "miri",
    "tarpaulin",
  ]),
  go: new Set([
    "build",
    "test",
    "run",
    "vet",
    "generate",
    "mod",
    "get",
    "install",
    "fmt",
    "tool",
    "clean",
    "work",
  ]),
  deno: new Set([
    "run",
    "test",
    "task",
    "compile",
    "bundle",
    "bench",
    "check",
    "lint",
    "fmt",
    "install",
    "add",
    "remove",
    "cache",
    "serve",
  ]),
  docker: new Set([
    "build",
    "buildx",
    "run",
    "exec",
    "compose",
    "up",
    "down",
    "start",
    "stop",
    "restart",
    "push",
    "pull",
    "ps",
    "logs",
    "images",
    "rm",
    "rmi",
  ]),
  podman: new Set([
    "build",
    "run",
    "exec",
    "compose",
    "up",
    "down",
    "start",
    "stop",
    "restart",
    "push",
    "pull",
    "ps",
    "logs",
  ]),
  kubectl: new Set([
    "apply",
    "delete",
    "create",
    "get",
    "describe",
    "logs",
    "exec",
    "rollout",
    "scale",
    "port-forward",
    "patch",
    "edit",
  ]),
  helm: new Set(["install", "upgrade", "uninstall", "template", "lint", "package", "repo", "dependency"]),
  terraform: new Set(["init", "plan", "apply", "destroy", "validate", "fmt", "output", "state", "import"]),
  tofu: new Set(["init", "plan", "apply", "destroy", "validate", "fmt", "output", "state", "import"]),
  nix: new Set(["build", "develop", "run", "flake", "shell", "eval", "check", "fmt", "store"]),
  bundle: new Set(["exec", "install", "update", "check", "add", "remove"]),
  mix: new Set(["test", "compile", "deps", "deps.get", "phx.server", "ecto.migrate", "format", "release", "run"]),
  swift: new Set(["build", "test", "run", "package"]),
  fly: new Set(["deploy", "launch", "status", "logs", "ssh", "secrets", "apps", "machines"]),
  flyctl: new Set(["deploy", "launch", "status", "logs", "ssh", "secrets", "apps", "machines"]),
  dotnet: new Set(["build", "test", "run", "restore", "publish", "clean", "pack", "ef", "tool", "format"]),
  poetry: new Set(["install", "run", "build", "publish", "add", "remove", "update", "lock", "check"]),
  uv: new Set(["run", "sync", "pip", "build", "publish", "add", "remove", "lock", "venv", "tool"]),
  pip: new Set(["install", "uninstall", "freeze", "list", "check", "wheel", "download"]),
  pip3: new Set(["install", "uninstall", "freeze", "list", "check", "wheel", "download"]),
  composer: new Set(["install", "update", "require", "remove", "run-script", "dump-autoload", "test"]),
  git: new Set([
    "add",
    "apply",
    "checkout",
    "cherry-pick",
    "clean",
    "clone",
    "commit",
    "init",
    "merge",
    "mv",
    "pull",
    "push",
    "rebase",
    "reset",
    "restore",
    "revert",
    "rm",
    "stash",
    "switch",
    "branch",
    "tag",
    ...READ_ONLY_GIT_SUBCOMMANDS,
  ]),
};

const ARG_REQUIRED_STANDALONE_BINS: ReadonlySet<string> = new Set(["bunx", "npx", "pnpx"]);

const STANDALONE_SHELL_BINS: ReadonlySet<string> = new Set([
  "bunx",
  "npx",
  "pnpx",
  "tsx",
  "ts-node",
  "vite",
  "vitest",
  "jest",
  "mocha",
  "webpack",
  "esbuild",
  "rollup",
  "turbo",
  "nx",
  "eslint",
  "prettier",
  "biome",
  "oxlint",
  "playwright",
  "cypress",
  "storybook",
  "prisma",
  "tsc",
  "rustc",
  "rustup",
  "cmake",
  "ninja",
  "meson",
  "bazel",
  "buck",
  "buck2",
  "gradle",
  "gradlew",
  "mvn",
  "ant",
  "rake",
  "scons",
  "msbuild",
  "gcc",
  "g++",
  "clang",
  "clang++",
  "zig",
  "xcodebuild",
  "pytest",
  "pipenv",
  "pdm",
  "ruff",
  "mypy",
  "flake8",
  "tox",
  "nox",
  "rspec",
  "rails",
  "nix-build",
  "nix-shell",
  "nixos-rebuild",
  "docker-compose",
  "ansible",
  "pulumi",
  "vercel",
  "wrangler",
  "curl",
  "wget",
]);

const INTERPRETER_BINS: ReadonlySet<string> = new Set([
  "node",
  "python",
  "python3",
  "ruby",
  "php",
  "bash",
  "sh",
  "zsh",
]);

const MAKE_NON_TARGETS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "it",
  "this",
  "that",
  "sure",
  "sense",
  "changes",
  "edits",
  "up",
  "out",
  "any",
  "some",
  "no",
  "use",
]);

const CLI_PRECEDING_TOKENS: ReadonlySet<string> = new Set([
  "bun",
  "bunx",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "cargo",
  "go",
  "deno",
  "docker",
  "docker-compose",
  "podman",
  "nix",
  "make",
  "uv",
  "pip",
  "pip3",
  "poetry",
  "bundle",
  "mix",
  "swift",
  "fly",
  "flyctl",
  "kubectl",
  "helm",
  "terraform",
  "tofu",
  "gradle",
  "gradlew",
  "mvn",
  "dotnet",
  "composer",
  "run",
  "exec",
]);

const DETERMINER_PRECEDING_WORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "its",
  "our",
  "my",
  "your",
  "their",
  "each",
  "every",
  "any",
  "some",
  "failed",
  "failing",
  "broken",
  "local",
  "ci",
  "prod",
  "dev",
  "full",
  "clean",
]);

const UNQUOTED_STOP_WORDS: ReadonlySet<string> = new Set([
  "and",
  "then",
  "or",
  "so",
  "but",
  "if",
  "when",
  "while",
  "until",
  "before",
  "after",
  "because",
  "instead",
  "to",
  "for",
  "into",
  "onto",
  "from",
  "in",
  "on",
  "at",
  "against",
  "over",
  "without",
  "with",
]);

const FLAG_TAKING_VALUE: ReadonlySet<string> = new Set([
  "-p",
  "--project",
  "-t",
  "-f",
  "-m",
  "-c",
  "-k",
  "-o",
  "-C",
  "--cwd",
  "--filter",
  "--target",
  "--config",
]);

const SHELL_INSTRUCTION_VERB_RE =
  /\b(?:by\s+(?:running|executing)|run|re-?run|execute|exec|invoke|launch|start|build|compile|install|deploy)\b/gi;

const NEGATION_BEFORE_VERB_RE =
  /\b(?:do\s+not|don['’]t|does\s+not|doesn['’]t|did\s+not|didn['’]t|never|not\s+to|without|avoid|skip|skipping|refrain\s+from|instead\s+of|rather\s+than|no\s+need\s+to|cannot|can['’]t|must\s+not|mustn['’]t|should\s+not|shouldn['’]t|won['’]t|will\s+not|stop)\s+(?:trying\s+to\s+|attempting\s+to\s+|actually\s+|directly\s+|manually\s+)?$/i;

const META_CLAUSE_PREFIX_RE =
  /\b(?:(?:explain|describe|document|summarize|understand|investigate|analyze|analyse|figure\s+out|find\s+out|determine|check|see|verify|trace|inspect)\s+(?:why|how(?:\s+to)?|what|whether|if)|how\s+to|what\s+happens\s+(?:when|if)|why\s+(?:does|did|would|is|are))\b[^.!?\n;]*$/i;

const DESCRIPTIVE_PREDICATE_AFTER_RE =
  /^(?:is|are|was|were|does|do|did|fails?|failed|failing|breaks?|broke|broken|errors?|exits?|exited|returns?|returned|outputs?|prints?|produces?|throws?|threw|runs?|ran|takes?|took|uses?|used|works?|worked|hangs?|hung|needs?|requires?|depends?|means?|shows?|says?|contains?|exists?|defined|configured)\b/i;

const INSTRUCTIONAL_CODE_PREFIX_RE =
  /^(?:(?:[-*•]|\d+[.)])\s*)?(?:(?:then|and|next|finally|first|second|step\s*\d*|steps|command|cmd|run|execute|build|install|start|launch|deploy|verify)\s*:?\s*)?$/i;

const EXPLICIT_REL_SCRIPT_RE = /^\.\/[A-Za-z0-9._/-]+$/;
const BARE_SCRIPT_PATH_RE =
  /^(?:(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+\.(?:sh|bash|zsh|py|rb|pl|ps1|bat|cmd|mjs|cjs|ts|js)|[A-Za-z0-9._-]+\.(?:sh|bash|zsh|ps1|bat|cmd))$/;
const JS_TS_SCRIPT_RE = /^(?:\.\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:[cm]?[jt]s)$/;
const INTERPRETER_SCRIPT_RE =
  /^(?:\.\/)?(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:sh|bash|zsh|py|rb|php|[cm]?js|ts)$/;

function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "\n").replace(/~~~[\s\S]*?~~~/g, "\n");
}

function cleanCommandToken(raw: string): string {
  let token = raw.replace(/^["'(]+/, "").replace(/[,:;!?)\]]+$/, "");
  if (token.endsWith(".") && !token.endsWith("...") && token !== ".") {
    token = token.replace(/\.+$/, "");
  }
  return token;
}

function isAllowlistedInspectCommand(tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const bin = tokens[0]!.toLowerCase();
  const rest = tokens.slice(1);

  if (ALLOWLISTED_SIMPLE_BINS.has(bin)) return true;

  if (bin === "git") {
    let i = 0;
    while (i < rest.length && (rest[i] === "--no-pager" || rest[i] === "-P" || rest[i] === "--no-optional-locks")) {
      i++;
    }
    const sub = rest[i]?.toLowerCase();
    if (!sub) return true;
    if (READ_ONLY_GIT_SUBCOMMANDS.has(sub)) return true;
    if (sub === "branch") {
      const subArgs = rest.slice(i + 1);
      return !subArgs.some((a) => /^-[dDmMcC]$/.test(a) || a === "--delete" || a === "--move" || a === "--copy");
    }
    if (sub === "tag") {
      const subArgs = rest.slice(i + 1);
      return !subArgs.some((a) => /^-[dafsmu]$/.test(a) || a === "--delete" || a === "--annotate" || a === "--sign");
    }
    return false;
  }

  if (bin === "bun") {
    return rest[0]?.toLowerCase() === "test";
  }

  if (bin === "bunx") {
    return rest[0]?.toLowerCase() === "tsc" && rest.slice(1).includes("--noEmit");
  }

  if (bin === "tsc") {
    return rest.includes("--noEmit");
  }

  return false;
}

function isConcreteShellCommand(tokens: readonly string[], allowBareScriptPath: boolean, fromCodeSpan: boolean): boolean {
  if (tokens.length === 0) return false;
  const rawBin = tokens[0]!;
  const bin = rawBin.toLowerCase();
  const arg1 = tokens[1];
  const arg1Lower = arg1?.toLowerCase();

  if (EXPLICIT_REL_SCRIPT_RE.test(rawBin)) return true;
  if (allowBareScriptPath && BARE_SCRIPT_PATH_RE.test(rawBin)) return true;

  if (bin === "make") {
    if (!arg1) return fromCodeSpan;
    if (arg1.startsWith("-")) return true;
    return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(arg1) && !MAKE_NON_TARGETS.has(arg1Lower!);
  }

  if (Object.hasOwn(SUBCOMMAND_REQUIRED_BINS, bin)) {
    if (!arg1 || !arg1Lower) return false;
    if (bin === "bun" && JS_TS_SCRIPT_RE.test(arg1)) return true;
    if (bin === "git") {
      let i = 1;
      while (i < tokens.length && (tokens[i] === "--no-pager" || tokens[i] === "-P" || tokens[i] === "--no-optional-locks")) {
        i++;
      }
      const sub = tokens[i]?.toLowerCase();
      return Boolean(sub && SUBCOMMAND_REQUIRED_BINS.git!.has(sub));
    }
    return SUBCOMMAND_REQUIRED_BINS[bin]!.has(arg1Lower);
  }

  if (STANDALONE_SHELL_BINS.has(bin)) {
    if (ARG_REQUIRED_STANDALONE_BINS.has(bin)) {
      return Boolean(arg1 && /^[A-Za-z0-9@._/-]+$/.test(arg1));
    }
    return true;
  }

  if (INTERPRETER_BINS.has(bin)) {
    if (!arg1) return false;
    if (arg1.startsWith("-")) return true;
    if (bin === "php" && arg1Lower === "artisan") return true;
    return EXPLICIT_REL_SCRIPT_RE.test(arg1) || INTERPRETER_SCRIPT_RE.test(arg1);
  }

  return false;
}

function extractUnquotedCommandTokens(rest: string): string[] {
  const stopIdx = rest.search(/[,;\n()[\]—–]|\.(?:\s|$)/);
  const head = (stopIdx >= 0 ? rest.slice(0, stopIdx) : rest).trim();
  if (!head) return [];

  const rawTokens = head.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < rawTokens.length && out.length < 4; i++) {
    const cleaned = cleanCommandToken(rawTokens[i]!);
    if (!cleaned) break;
    const prev = out[out.length - 1];
    if (out.length >= 1 && !(prev && FLAG_TAKING_VALUE.has(prev)) && UNQUOTED_STOP_WORDS.has(cleaned.toLowerCase())) {
      break;
    }
    out.push(cleaned);
  }
  return out;
}

function firstDisallowedCommandInSpan(span: string, allowBareScriptPath: boolean): string | null {
  const cleanedSpan = span.trim().replace(/^\$\s+/, "");
  if (!cleanedSpan) return null;
  const segments = cleanedSpan.split(/\s*(?:&&|\|\||;|\|)\s*/);
  for (const seg of segments) {
    const tokens = seg
      .trim()
      .split(/\s+/)
      .map(cleanCommandToken)
      .filter(Boolean);
    if (tokens.length === 0) continue;
    if (!isConcreteShellCommand(tokens, allowBareScriptPath, true)) continue;
    if (isAllowlistedInspectCommand(tokens)) continue;
    return seg.trim();
  }
  return null;
}

function extractDisallowedCommandFromRest(rest: string, allowBareScriptPath: boolean): string | null {
  const trimmed = rest.trimStart();
  if (!trimmed) return null;

  const spanMatch = trimmed.match(/^(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)')/);
  if (spanMatch) {
    const inner = spanMatch[1] ?? spanMatch[2] ?? spanMatch[3] ?? "";
    const found = firstDisallowedCommandInSpan(inner, allowBareScriptPath);
    if (found) return found;
    // If the first quoted/backticked command was allowlisted, check an immediately chained span (e.g. `bun test` and `bun run build`).
    const tail = trimmed.slice(spanMatch[0].length);
    const chainedMatch = tail.match(/^(?:\s*(?:,|and|then|&&)\s*)(?:`([^`\n]+)`|"([^"\n]+)"|'([^'\n]+)')/i);
    if (chainedMatch) {
      const chainedInner = chainedMatch[1] ?? chainedMatch[2] ?? chainedMatch[3] ?? "";
      return firstDisallowedCommandInSpan(chainedInner, allowBareScriptPath);
    }
    return null;
  }

  const tokens = extractUnquotedCommandTokens(trimmed);
  if (tokens.length === 0) return null;
  if (!isConcreteShellCommand(tokens, allowBareScriptPath, false)) return null;
  if (isAllowlistedInspectCommand(tokens)) return null;
  return tokens.join(" ");
}

function isPrecededByWordIn(before: string, set: ReadonlySet<string>): boolean {
  const m = before.match(/([A-Za-z0-9._-]+)\s+$/);
  if (!m?.[1]) return false;
  return set.has(m[1].toLowerCase());
}

function detectBriefShellCommand(rawBrief: string): string | null {
  const withoutFences = stripFencedCodeBlocks(rawBrief);
  const clauses = withoutFences.split(/[\r\n;!?]+|\.(?=\s|$)/);

  for (const clause of clauses) {
    if (!clause.trim()) continue;

    // Path A: explicit execution/build instruction verb + concrete non-allowlisted command.
    const verbRe = new RegExp(SHELL_INSTRUCTION_VERB_RE.source, SHELL_INSTRUCTION_VERB_RE.flags);
    let vm: RegExpExecArray | null;
    while ((vm = verbRe.exec(clause)) !== null) {
      const start = vm.index;
      const end = start + vm[0].length;
      // Ignore matches embedded inside paths or hyphenated identifiers (e.g. scripts/build.ts, pre-build).
      if (start > 0 && /[/.\\_-]/.test(clause[start - 1]!)) continue;
      if (end < clause.length && /[/.\\_-]/.test(clause[end]!)) continue;

      const before = clause.slice(0, start);
      if (isPrecededByWordIn(before, CLI_PRECEDING_TOKENS)) continue;
      if (isPrecededByWordIn(before, DETERMINER_PRECEDING_WORDS)) continue;
      if (NEGATION_BEFORE_VERB_RE.test(before)) continue;
      if (META_CLAUSE_PREFIX_RE.test(before)) continue;

      const after = clause.slice(end);
      // Direct form: `<verb> <cmd>` or `<verb>: <cmd>`
      const directLead = after.match(/^(?:\s*:\s*|\s+)/);
      if (directLead) {
        const directRest = after.slice(directLead[0].length);
        const directFound = extractDisallowedCommandFromRest(directRest, true);
        if (directFound) return directFound;
      }

      // Indirect form: `<verb> <short object> with|using|via|by running|by executing <cmd>`
      const indirectLead = after.match(/^[^,\n]{1,48}?\b(?:with|using|via|by\s+running|by\s+executing)\s+/i);
      if (indirectLead) {
        const indirectRest = after.slice(indirectLead[0].length);
        const indirectFound = extractDisallowedCommandFromRest(indirectRest, true);
        if (indirectFound) return indirectFound;
      }
    }

    // Path B: bare command in an inline code span in an instructional position.
    const codeSpanRe = /`([^`\n]+)`/g;
    let cm: RegExpExecArray | null;
    while ((cm = codeSpanRe.exec(clause)) !== null) {
      const inner = cm[1] ?? "";
      const before = clause.slice(0, cm.index);
      const after = clause.slice(cm.index + cm[0].length).trim();

      if (NEGATION_BEFORE_VERB_RE.test(before)) continue;
      if (META_CLAUSE_PREFIX_RE.test(before)) continue;
      if (DESCRIPTIVE_PREDICATE_AFTER_RE.test(after)) continue;
      if (!INSTRUCTIONAL_CODE_PREFIX_RE.test(before.trim())) continue;

      const found = firstDisallowedCommandInSpan(inner, false);
      if (found) return found;
    }
  }

  return null;
}

const readOnlyBriefNeedsShellRule: AdvisoryRule<null> = {
  id: "read-only-brief-needs-shell",
  roles: ["director", "orchestrator", "worker"],
  surface: "result",
  priority: 55,
  init: () => null,
  observe(_state, subject, call): Finding | null {
    if (call.status !== "completed" || call.surface !== "harness" || call.tool !== "spawn_task") {
      return null;
    }
    const args = call.args;
    if (!args) return null;

    const kind = typeof args.kind === "string" ? args.kind.trim().toLowerCase() : "";
    const isReadOnlyChild =
      kind === "research" ||
      kind === "plan" ||
      kind === "verify" ||
      (kind === "execute" && args.read_only === true);
    if (!isReadOnlyChild) return null;

    const rawBrief = [args.title, args.objective, args.criteria]
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
      .join("\n");
    if (!rawBrief) return null;

    const matched = detectBriefShellCommand(rawBrief);
    if (!matched) return null;

    const res =
      call.result && typeof call.result === "object" && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : undefined;
    const childId =
      typeof res?.spawned === "string" && res.spawned.trim()
        ? res.spawned.trim()
        : typeof res?.taskId === "string" && res.taskId.trim()
          ? res.taskId.trim()
          : "the child";
    const displayChildId = clipSnippet(childId, 2, MAX_DISPLAY_ID_CHARS) || "the child";
    const matchText = clipSnippet(compactMatchSnippet(matched), 6, MAX_DISPLAY_MATCH_CHARS);
    const kindLabel = kind === "execute" ? "read-only execute" : kind;

    const alternative =
      subject.role === "director"
        ? `Put that run in a goal, or steer ${displayChildId} with steer_task to inspect only.`
        : subject.role === "worker"
          ? `Use a kind execute task or run it yourself, or steer ${displayChildId} with steer_child to inspect only.`
          : `Give that command to a Worker with spawn_worker, or steer ${displayChildId} with steer_child to inspect only.`;

    return {
      key: childId,
      what: `The brief for ${displayChildId} asks to run "${matchText}".`,
      why: `A ${kindLabel} task has no shell and can run only the read-only inspect_command allowlist.`,
      alternative,
      data: { childId, kind, readOnly: true, match: matched, tool: call.tool },
    };
  },
  dedupe: {
    perKey: "subject",
    maxPerSubject: 2,
  },
};

export const ALL_RULES: readonly AdvisoryRule<any>[] = [
  workerEditOutsideScopeRule,
  scopeTooLargeRule,
  readOnlyFindingEscalationRule,
  briefCountLimitRule,
  directorSelfReadingRule,
  statusPollingRule,
  readOnlyBriefNeedsShellRule,
];
