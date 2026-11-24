import { basename, isAbsolute, relative, resolve } from "node:path";
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

function isOutsideWorkspacePath(p: string): boolean {
  return !p || p === "." || p === "~" || p.startsWith("~/") || p.startsWith("..") || isAbsolute(p);
}

function isUnderRoot(targetAbs: string, rootAbs: string): boolean {
  const rel = relative(rootAbs, targetAbs);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
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

function formatScopeList(scopes: readonly string[]): string {
  const cleaned = scopes.map((s) => s.trim()).filter(Boolean);
  if (cleaned.length <= 3) return cleaned.join(", ");
  return `${cleaned.slice(0, 2).join(", ")}, +${cleaned.length - 2}`;
}

function formatSampleList(items: readonly string[], compact: boolean): string {
  const cleaned = items.map((item) => item.trim()).filter(Boolean);
  if (compact) {
    const tokens = cleaned.slice(0, 2).map((s) => s.replace(/\s+/g, "-"));
    if (cleaned.length > 2) tokens.push(`+${cleaned.length - 2}`);
    return tokens.join(",");
  }
  const kept: string[] = [];
  let words = 0;
  for (const item of cleaned) {
    if (kept.length >= 3) break;
    const itemWords = item.split(/\s+/).filter(Boolean);
    const clipped = itemWords.slice(0, 2).join(" ");
    const wCount = Math.min(itemWords.length, 2);
    if (words + wCount > 3 && kept.length > 0) break;
    kept.push(clipped);
    words += wCount;
  }
  if (cleaned.length > kept.length) {
    kept.push(`+${cleaned.length - kept.length}`);
  }
  return kept.join(", ");
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
  if (!rel || rel === "." || rel.startsWith("..") || isAbsolute(rel)) return null;
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
      if (!relHint || relHint.startsWith("..") || isAbsolute(relHint)) continue;
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
    return {
      key: target,
      what: `${target} is outside your write scopes (${formatScopeList(subject.writeScopes)}).`,
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
}

const scopeTooLargeRule: AdvisoryRule<ScopeRuleState> = {
  id: "scope-too-large",
  roles: ["research", "plan", "verify", "execute"],
  surface: "event",
  priority: 80,
  init: () => ({ hasFired: false, areasAtFire: 0, scoredCallsAtFire: 0, lastFinding: null }),
  observe(state, _subject, _call, ctx): Finding | null {
    if (!ctx.scope) return null;
    const finding = ctx.scope.evaluate();
    state.lastFinding = finding;
    if (!finding) return null;

    const reasonKeys: Array<"widening" | "repeated" | "stale"> = [];
    if (finding.widening) reasonKeys.push("widening");
    if (finding.repeated) reasonKeys.push("repeated");
    if (finding.stale) reasonKeys.push("stale");
    if (reasonKeys.length === 0) return null;

    const activeReasons = reasonKeys.slice(0, 2);
    const compactWidening = activeReasons.length > 1;
    const sentences: string[] = [];

    for (const reason of activeReasons) {
      if (reason === "widening" && finding.widening) {
        const areas = formatSampleList(finding.widening.areas, compactWidening);
        const topics = formatSampleList(finding.widening.topics, compactWidening);
        sentences.push(
          `You have opened ${finding.widening.areas.length} areas (${areas}) and searched ${finding.widening.topics.length} unrelated topics (${topics}).`,
        );
      } else if (reason === "repeated" && finding.repeated) {
        const tool = finding.repeated.tool.trim().split(/\s+/)[0] || "tool";
        sentences.push(`You repeated the same ${tool} call ${finding.repeated.times} times.`);
      } else if (reason === "stale" && finding.stale) {
        sentences.push(`Your last ${finding.stale.reads} reads found nothing new.`);
      }
    }

    return {
      key: "scope",
      what: sentences.join(" "),
      why: "This usually means the task is larger than one bounded assignment.",
      alternative:
        "If you are still answering one bounded question, continue. Otherwise save your findings with artifact_write, then call return_task with status scope_too_large and suggested_splits, one per open area.",
      data: {
        reasons: activeReasons,
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

    return {
      key: "read-only-finding-escalation",
      what: `Your finding was recorded as non-blocking escalation ${esc} for your parent, and this task continues.`,
      why: "A read-only task delivers findings in its handoff, and its parent decides what blocks.",
      alternative:
        "Put the finding and its evidence in return_task. Pass blocking: true to report_issue only when something stops you from finishing, such as a broken environment.",
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
    const matchText = compactMatchSnippet(matched);

    return {
      key: childId,
      what: `The brief for ${childId} states a count as a limit ("${matchText}").`,
      why: "The harness never stops a task on a count, and a stated count makes a child cut bounded work short.",
      alternative: `Tell ${childId} with ${steerTool} that the count is not a limit. In later briefs, describe the deliverable instead of a count.`,
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
    if (rel === ".harness" || rel.startsWith(".harness/")) return null;
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

export const ALL_RULES: readonly AdvisoryRule<any>[] = [
  workerEditOutsideScopeRule,
  scopeTooLargeRule,
  readOnlyFindingEscalationRule,
  briefCountLimitRule,
  directorSelfReadingRule,
  statusPollingRule,
];
