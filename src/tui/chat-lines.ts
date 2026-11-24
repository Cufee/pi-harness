import type {
  EscalationCategory,
  EscalationRecord,
  EscalationSeverity,
  RunRecord,
} from "../control-plane/db.js";
import type { ChatTurnRecord } from "../director/session.js";
import type { GoalStatus } from "../goals/engine.js";
import {
  type ChatControlEvent,
  formatChatEventSummary,
  parseChatControlEvent,
} from "../protocol/chat-events.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import {
  type AttentionCandidate,
  type AttentionQuotaPause,
  evaluateAttentionVerdict,
} from "../visibility/index.js";
import {
  firstLine,
  formatCountdown,
  sanitizeLine,
  type Tone,
  type TuiEntityRef as EntityRef,
} from "./core/index.js";

export type ChatLineAudience = "human" | "internal";

export type ChatLineGlyph = "diamond" | "warn" | "pause" | "check" | "cross" | "bullet";

export interface ClassifiedChatLine {
  audience: ChatLineAudience;
  tag: string;
  text: string;
  tone: Tone;
  glyph?: ChatLineGlyph;
  ref?: EntityRef;
}

export type ChatLineInput =
  | { source: "live"; event: DaemonEventFrame }
  | { source: "replay"; turn: Pick<ChatTurnRecord, "content" | "event" | "createdAt"> };

const RAW_EVENT_TYPE_RE = /^[a-z_]+\.[a-z_.]+$/;

const RAW_TOKEN_REPLACEMENTS: ReadonlyArray<[RegExp, string]> = [
  [/\bchanges_requested\b/gi, "changes requested"],
  [/\bawaiting_human\b/gi, "awaiting review"],
  [/\bblocking_escalation\b/gi, "blocking escalation"],
  [/\bpaused_quota\b/gi, "paused on quota"],
  [/\breturned_for_rescope\b/gi, "returned for rescope"],
  [/\bauto_timer\b/gi, "automatic timer"],
  [/\buser_timer\b/gi, "scheduled timer"],
  [/\bdaemon_restart\b/gi, "daemon restart"],
  [/\bexplicit_stop\b/gi, "explicit stop"],
  [/\brun_failed\b/gi, "run failed"],
  [/\bverification_error\b/gi, "verification error"],
  [/\bgates_failed\b/gi, "gates failed"],
  [/\bworker_spawned\b/gi, "worker spawned"],
  [/\bremote_push\b/gi, "remote push"],
];

const ESCALATION_CATEGORIES = new Set<EscalationCategory>([
  "scope_too_large",
  "code_defect",
  "broken_test",
  "interface_conflict",
  "ambiguous_spec",
  "blocked_dependency",
  "verification_failed",
  "budget_exhausted",
  "env_failure",
  "security_risk",
]);

const HUMAN_REVIEW_GOAL_STATUSES: ReadonlySet<string> = new Set<GoalStatus>([
  "achieved",
  "awaiting_human",
  "cancelled",
]);

export type LiveAttentionInput =
  | {
      kind: "escalation";
      runId?: string;
      id?: unknown;
      escalationId?: unknown;
      fromTaskId?: unknown;
      toTaskId?: unknown;
      severity?: unknown;
      category?: unknown;
      title?: unknown;
      blocking?: unknown;
      status?: unknown;
      createdAt?: unknown;
    }
  | {
      kind: "quota";
      eventType: string;
      runId?: string;
      mode?: unknown;
      reason?: unknown;
      resumeAt?: unknown;
      createdAt?: unknown;
    };

function parseEscalationSeverity(raw: unknown): EscalationSeverity {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (s === "P0" || s === "P1" || s === "P2") return s;
  return "P1";
}

function parseEscalationCategory(raw: unknown): EscalationCategory {
  const s = typeof raw === "string" ? raw.trim() : "";
  return ESCALATION_CATEGORIES.has(s as EscalationCategory) ? (s as EscalationCategory) : "blocked_dependency";
}

function parseEscalationStatus(raw: unknown): EscalationRecord["status"] {
  if (raw === "acked" || raw === "resolved") return raw;
  return "open";
}

/** Builds a typed `AttentionCandidate` from a live `escalation.created` or `quota.*` frame payload. */
export function toAttentionCandidate(input: LiveAttentionInput): AttentionCandidate {
  if (input.kind === "escalation") {
    const rawToTaskId = input.toTaskId;
    const toTaskId =
      rawToTaskId == null
        ? null
        : typeof rawToTaskId === "string"
          ? rawToTaskId.trim() || null
          : String(rawToTaskId);
    const createdAt = asNumber(input.createdAt) ?? 0;
    const escalation: EscalationRecord = {
      id: asString(input.id) || asString(input.escalationId) || "esc-live",
      runId: input.runId ?? "",
      fromTaskId: asString(input.fromTaskId),
      toTaskId,
      severity: parseEscalationSeverity(input.severity),
      category: parseEscalationCategory(input.category),
      title: asString(input.title),
      evidencePaths: [],
      attempted: [],
      suggestedSplits: [],
      blocking: input.blocking === true || input.blocking === 1,
      status: parseEscalationStatus(input.status),
      resolution: null,
      createdAt,
      ackedAt: null,
    };
    return { kind: "escalation", escalation };
  }

  const isRunPaused = input.eventType === "quota.run_paused";
  const mode = asString(input.mode);
  const reason = asString(input.reason);
  const resumeAt =
    typeof input.resumeAt === "number" || typeof input.resumeAt === "string" ? input.resumeAt : null;
  const createdAt = asNumber(input.createdAt) ?? 0;
  const run: RunRecord = {
    id: input.runId ?? "",
    goal: "",
    repoRoot: "",
    baseBranch: "",
    baseSha: "",
    coordinationGroup: null,
    isolationMode: "standalone",
    status: isRunPaused ? "paused_quota" : "active",
    createdAt,
    updatedAt: createdAt,
  };
  const quotaPause: AttentionQuotaPause | null = isRunPaused && mode ? { mode, reason, resumeAt } : null;
  return { kind: "quota_paused", run, quotaPause };
}

/**
 * Evaluates escalation and quota live-frame visibility through goal-33's shared
 * `evaluateAttentionVerdict` policy.
 * - `audience === "human"` (undismissed) -> `"human"`
 * - agent-addressed escalations (`reason === "agent_addressed"`) -> `"drop"`
 * - `"orchestrator"`, `"director"`, and `"none"` -> `"internal"`
 */
export function classifyAttentionAudience(input: LiveAttentionInput): "human" | "internal" | "drop" {
  const verdict = evaluateAttentionVerdict(toAttentionCandidate(input));
  if (verdict.audience === "human" && !verdict.reason) return "human";
  if (verdict.reason === "agent_addressed") return "drop";
  return "internal";
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function humanizeTokens(raw: string): string {
  let out = sanitizeLine(raw);
  for (const [re, replacement] of RAW_TOKEN_REPLACEMENTS) {
    out = out.replace(re, replacement);
  }
  return out.trim();
}

function humanizeVerdict(verdict: string, status: string): string {
  const v = verdict.toLowerCase();
  if (v === "approve" || v === "approved") return "Approved";
  if (v === "changes_requested") return "Changes requested";
  if (v === "reject" || v === "rejected") return "Rejected";
  const s = status.toLowerCase();
  if (s === "achieved") return "Achieved";
  if (s === "awaiting_human") return "Needs review";
  if (s === "executing") return "In progress";
  if (v) return humanizeTokens(verdict.replace(/_/g, " "));
  if (s) return humanizeTokens(status.replace(/_/g, " "));
  return "Review recorded";
}

function isHumanGoalReview(status: string, source?: string): boolean {
  if (source === "user") return true;
  const normalized = status.trim().toLowerCase();
  return normalized.length > 0 && HUMAN_REVIEW_GOAL_STATUSES.has(normalized);
}

function formatPersistedEscalationNotice(raw: string): string {
  const stripped = raw.replace(/\s*\(close with resolve_escalation\)\.?\s*$/i, "").trim();
  const match = stripped.match(/^Escalation\s+(\S+)\s+\[([^\]/]+)(?:\/([^\]]+))?\]([\s\S]*)$/i);
  if (!match) return stripped;
  const [, escId, rawSeverity, rawCategory, rest] = match;
  const sev = sanitizeLine(rawSeverity!).toUpperCase();
  const cat = rawCategory ? humanizeTokens(rawCategory.trim().toLowerCase().replace(/_/g, " ")) : "";
  const meta = sev && cat ? `(${sev}, ${cat})` : sev ? `(${sev})` : cat ? `(${cat})` : "";
  const tail = rest ?? "";
  return meta ? `Escalation ${escId} ${meta}${tail}` : `Escalation ${escId}${tail}`;
}

function ensureSafeTag(rawTag: string, fallback: string, forbiddenType?: string): string {
  const cleaned = sanitizeLine(rawTag);
  if (!cleaned) return fallback;
  if (RAW_EVENT_TYPE_RE.test(cleaned)) return fallback;
  if (forbiddenType && cleaned.includes(forbiddenType)) return fallback;
  return cleaned;
}

function ensureSafeText(rawText: string, fallback: string, forbiddenType?: string): string {
  let cleaned = humanizeTokens(rawText);
  if (forbiddenType && cleaned.includes(forbiddenType)) {
    cleaned = cleaned.split(forbiddenType).join("").replace(/\s+/g, " ").trim();
  }
  if (!cleaned || RAW_EVENT_TYPE_RE.test(cleaned)) return fallback;
  return cleaned;
}

function goalIdFromPayload(p: Record<string, unknown>): string {
  const g = asString(p.goalId) || asString(p.id);
  return g && !RAW_EVENT_TYPE_RE.test(g) ? g : "";
}

function goalRef(goalId: string, runId?: string): EntityRef | undefined {
  return goalId ? { kind: "goal", id: goalId, ...(runId ? { runId } : {}), label: goalId } : undefined;
}

export function classifyControlEvent(
  event: ChatControlEvent,
  opts?: { remoteHost?: string | null },
): ClassifiedChatLine | null {
  switch (event.kind) {
    case "goal.settled": {
      const internal = event.cause === "daemon_restart" || event.cause === "blocked_escalation";
      const summary = ensureSafeText(
        formatChatEventSummary(event, { remoteHost: opts?.remoteHost }),
        `Goal ${event.goalId} settled`,
        event.kind,
      );
      return {
        audience: internal ? "internal" : "human",
        tag: ensureSafeTag(event.goalId, "goal", event.kind),
        text: summary,
        tone: internal ? "dim" : event.runStatus === "completed" ? "ok" : "warn",
        glyph: "diamond",
        ref: goalRef(event.goalId, event.runId),
      };
    }

    case "goal.escalated": {
      // Director wake record for P0s carrying no addressee; human-addressed escalations arrive via escalation.created and Inbox.
      const title = ensureSafeText(event.title, "Escalation raised", event.kind);
      return {
        audience: "internal",
        tag: ensureSafeTag(event.goalId, "escalation", event.kind),
        text: `${event.severity} escalation ${event.escalationId}: ${title}`,
        tone: "dim",
        glyph: "warn",
        ref: {
          kind: "escalation",
          id: event.escalationId,
          runId: event.runId,
          label: `${event.escalationId} ${title}`,
        },
      };
    }

    case "goal.committed": {
      const title = ensureSafeText(event.goalTitle, "", event.kind);
      const criteriaPart = event.criteriaCount > 0 ? ` (${event.criteriaCount} criteria)` : "";
      const text = title
        ? `Started v${event.goalVersion}: ${title}${criteriaPart}`
        : `Started v${event.goalVersion} on ${event.runId}${criteriaPart}`;
      return {
        audience: "human",
        tag: ensureSafeTag(event.goalId, "goal", event.kind),
        text,
        tone: "info",
        glyph: "diamond",
        ref: goalRef(event.goalId, event.runId),
      };
    }

    case "goal.amended": {
      const isHuman = event.source === "user" || event.source === "external";
      const rationale = ensureSafeText(event.rationale, "", event.kind);
      const text = rationale
        ? `Updated v${event.fromVersion} to v${event.toVersion}: ${rationale}`
        : `Updated v${event.fromVersion} to v${event.toVersion}`;
      return {
        audience: isHuman ? "human" : "internal",
        tag: ensureSafeTag(event.goalId, "goal", event.kind),
        text,
        tone: isHuman ? "info" : "dim",
        glyph: "diamond",
        ref: goalRef(event.goalId),
      };
    }

    case "goal.reviewed": {
      const isHuman = isHumanGoalReview(event.status, event.source);
      const verdictText = humanizeVerdict(event.verdict, event.status);
      const summary = ensureSafeText(event.summary, "", event.kind);
      const tone: Tone = !isHuman
        ? "dim"
        : event.status === "achieved" || event.verdict.toLowerCase() === "approve"
          ? "ok"
          : event.verdict.toLowerCase() === "changes_requested" || event.verdict.toLowerCase() === "rejected"
            ? "warn"
            : "info";
      const text = summary
        ? summary.toLowerCase().startsWith(verdictText.toLowerCase())
          ? summary
          : `${verdictText} (review #${event.cycle}): ${summary}`
        : `${verdictText} (review #${event.cycle})`;
      return {
        audience: isHuman ? "human" : "internal",
        tag: ensureSafeTag(event.goalId, "goal", event.kind),
        text,
        tone,
        glyph: "diamond",
        ref: goalRef(event.goalId),
      };
    }

    case "goal.gate_activity": {
      const summary = ensureSafeText(
        formatChatEventSummary(event, { remoteHost: opts?.remoteHost }),
        `Activity on ${event.goalId} while gated`,
        event.kind,
      );
      return {
        audience: "internal",
        tag: ensureSafeTag(event.goalId, "goal", event.kind),
        text: summary,
        tone: "dim",
        glyph: "diamond",
        ref: goalRef(event.goalId, event.runId),
      };
    }

    case "goal.events_batch": {
      const classified = event.events
        .map((sub) => classifyControlEvent(sub, opts))
        .filter((x): x is ClassifiedChatLine => x !== null);
      if (classified.length === 0) return null;
      const humanItems = classified.filter((x) => x.audience === "human");
      const chosen = humanItems.length > 0 ? humanItems : classified;
      const uniqueTags = [...new Set(chosen.map((c) => c.tag))];
      const tag = uniqueTags.length === 1 ? uniqueTags[0]! : "goals";
      const text = chosen
        .map((c) => (uniqueTags.length === 1 ? c.text : `${c.tag}: ${c.text}`))
        .join("; ");
      return {
        audience: humanItems.length > 0 ? "human" : "internal",
        tag: ensureSafeTag(tag, "goals", event.kind),
        text: ensureSafeText(text, `${chosen.length} goal updates`, event.kind),
        tone: humanItems.length > 0 ? chosen[0]!.tone : "dim",
        glyph: "diamond",
        ref: chosen.length === 1 ? chosen[0]!.ref : undefined,
      };
    }

    case "director.read_file": {
      const reason = event.reason ? ` (${ensureSafeText(event.reason, "", event.kind)})` : "";
      return {
        audience: "internal",
        tag: "read",
        text: `Director read ${sanitizeLine(event.path)} (${event.bytes} bytes)${reason}`,
        tone: "dim",
        glyph: "bullet",
      };
    }

    case "timer.scheduled": {
      const reason = ensureSafeText(event.reason, "scheduled check", event.kind);
      return {
        audience: "internal",
        tag: ensureSafeTag(event.goalId ?? "", "timer", event.kind),
        text: `Scheduled check: ${reason}`,
        tone: "dim",
        glyph: "bullet",
        ref: event.goalId ? goalRef(event.goalId) : undefined,
      };
    }

    case "timer.fired": {
      const reason = ensureSafeText(event.reason, "scheduled check", event.kind);
      return {
        audience: "internal",
        tag: ensureSafeTag(event.goalId ?? "", "timer", event.kind),
        text: `Timer fired: ${reason}`,
        tone: "dim",
        glyph: "bullet",
        ref: event.goalId ? goalRef(event.goalId) : undefined,
      };
    }

    case "task.settled": {
      const title = ensureSafeText(event.title, "task", event.kind);
      const status = humanizeTokens(event.status);
      const summary = ensureSafeText(event.summary, "", event.kind);
      return {
        audience: "internal",
        tag: ensureSafeTag(event.taskId, "task", event.kind),
        text: `Task "${title}" ${status}${summary ? `: ${summary}` : ""}`,
        tone: "dim",
        glyph: "bullet",
        ref: { kind: "task", id: event.taskId, runId: event.runId, label: event.taskId },
      };
    }

    case "session.message_received": {
      const origin = `${sanitizeLine(event.fromHost)}:${sanitizeLine(event.fromSessionId)}${event.fromProjectName ? ` [${sanitizeLine(event.fromProjectName)}]` : ""}`;
      const preview = firstLine(sanitizeLine(event.body), 120) || "(empty message)";
      const tripped = Boolean(event.circuitBreakerTripped);
      return {
        audience: "human",
        tag: tripped ? "peer paused" : "peer",
        text: `${origin}: ${preview}${tripped ? " (auto-wakeup paused: hop limit reached)" : ""}`,
        tone: tripped ? "warn" : "info",
        glyph: "bullet",
      };
    }
  }
}

function classifyLiveGoalEvent(
  ev: DaemonEventFrame,
  p: Record<string, unknown>,
  opts?: { remoteHost?: string | null },
): ClassifiedChatLine | null {
  const parsed = parseChatControlEvent(p);
  if (parsed) return classifyControlEvent(parsed, opts);

  const goalId = goalIdFromPayload(p);
  const tag = ensureSafeTag(goalId, "goal", ev.type);
  const ref = goalRef(goalId, ev.runId || undefined);

  switch (ev.type) {
    case "goal.committed": {
      const version = asNumber(p.version) ?? asNumber(p.goalVersion);
      const title = ensureSafeText(asString(p.title) || asString(p.goalTitle), "", ev.type);
      const vPart = version !== null ? ` v${version}` : "";
      const hasReadable = Boolean(goalId || title || version !== null);
      const text = title ? `Started${vPart}: ${title}` : `Goal started${vPart}`;
      return {
        audience: hasReadable ? "human" : "internal",
        tag,
        text,
        tone: hasReadable ? "info" : "dim",
        glyph: "diamond",
        ref,
      };
    }

    case "goal.reviewed": {
      const verdict = asString(p.verdict);
      const status = asString(p.status);
      const source = asString(p.source);
      const cycle = asNumber(p.cycle);
      const summary = ensureSafeText(asString(p.summary), "", ev.type);
      const verdictLabel = humanizeVerdict(verdict, status);
      const cyclePart = cycle !== null ? ` (review #${cycle})` : "";
      const isHuman = isHumanGoalReview(status, source);
      const text = summary
        ? summary.toLowerCase().startsWith(verdictLabel.toLowerCase())
          ? summary
          : `${verdictLabel}${cyclePart}: ${summary}`
        : `${verdictLabel}${cyclePart}`;
      const tone: Tone = !isHuman
        ? "dim"
        : status === "achieved" || verdict.toLowerCase() === "approve"
          ? "ok"
          : verdict.toLowerCase() === "changes_requested" || verdict.toLowerCase() === "rejected"
            ? "warn"
            : "info";
      return {
        audience: isHuman ? "human" : "internal",
        tag,
        text: ensureSafeText(text, "Review recorded", ev.type),
        tone,
        glyph: "diamond",
        ref,
      };
    }

    case "goal.amended": {
      const source = asString(p.source);
      const isHuman = source === "user" || source === "external";
      const delta = (p.delta && typeof p.delta === "object" ? p.delta : {}) as Record<string, unknown>;
      const fromV = asNumber(delta.fromVersion) ?? asNumber(p.fromVersion);
      const toV = asNumber(delta.toVersion) ?? asNumber(p.toVersion) ?? asNumber(p.version);
      const rationale = ensureSafeText(asString(delta.rationale) || asString(p.rationale) || asString(p.summary), "", ev.type);
      const verPart = fromV !== null && toV !== null ? ` v${fromV} to v${toV}` : toV !== null ? ` to v${toV}` : "";
      const text = rationale ? `Updated${verPart}: ${rationale}` : `Goal updated${verPart}`;
      return {
        audience: isHuman ? "human" : "internal",
        tag,
        text: ensureSafeText(text, "Goal updated", ev.type),
        tone: isHuman ? "info" : "dim",
        glyph: "diamond",
        ref,
      };
    }

    case "goal.settled": {
      const cause = asString(p.cause);
      const internal = cause === "daemon_restart" || cause === "blocked_escalation";
      const detail = ensureSafeText(asString(p.detail) || asString(p.summary) || asString(p.title), "", ev.type);
      const runStatus = humanizeTokens(asString(p.runStatus) || asString(p.status));
      const text = detail
        ? runStatus
          ? `Goal ${runStatus}: ${detail}`
          : detail
        : runStatus
          ? `Goal ${runStatus}`
          : "Goal settled";
      const hasReadable = Boolean(detail || runStatus);
      return {
        audience: internal || !hasReadable ? "internal" : "human",
        tag,
        text: ensureSafeText(text, "Goal settled", ev.type),
        tone: internal || !hasReadable ? "dim" : runStatus === "completed" ? "ok" : "warn",
        glyph: "diamond",
        ref,
      };
    }

    case "goal.escalated": {
      const title = ensureSafeText(asString(p.title) || asString(p.summary), "", ev.type);
      const escId = asString(p.escalationId) || asString(p.id);
      const text = title
        ? escId
          ? `Escalation ${escId}: ${title}`
          : title
        : "Escalation raised";
      return {
        audience: "internal",
        tag,
        text: ensureSafeText(text, "Escalation raised", ev.type),
        tone: "dim",
        glyph: "warn",
        ref,
      };
    }

    case "goal.progress": {
      const phase = humanizeTokens(asString(p.phase));
      const summary = ensureSafeText(asString(p.summary), "", ev.type);
      const text = phase && summary ? `${phase}: ${summary}` : summary || (phase ? `Phase: ${phase}` : "Progress update");
      return { audience: "internal", tag, text, tone: "dim", glyph: "diamond", ref };
    }

    case "goal.gate_activity": {
      const activity = humanizeTokens(asString(p.activity));
      const taskId = asString(p.taskId);
      const title = ensureSafeText(asString(p.title), "", ev.type);
      const detail = [activity, taskId, title].filter(Boolean).join(" · ");
      return {
        audience: "internal",
        tag,
        text: ensureSafeText(detail ? `Gated activity: ${detail}` : "", "Activity while gated", ev.type),
        tone: "dim",
        glyph: "diamond",
        ref,
      };
    }

    case "goal.amendment_task": {
      const toV = asNumber(p.toVersion);
      const action = humanizeTokens(asString(p.action));
      const taskId = asString(p.taskId);
      const parts = [toV !== null ? `v${toV}` : "", action, taskId ? `for ${taskId}` : ""].filter(Boolean);
      return {
        audience: "internal",
        tag,
        text: ensureSafeText(parts.length > 0 ? `Amendment ${parts.join(" ")}` : "", "Task amendment update", ev.type),
        tone: "dim",
        glyph: "diamond",
        ref,
      };
    }

    case "goal.amendment_undelivered": {
      const version = asNumber(p.version);
      const reason = ensureSafeText(asString(p.reason), "", ev.type);
      const vPart = version !== null ? ` v${version}` : "";
      const text = reason ? `Amendment${vPart} not delivered: ${reason}` : `Amendment${vPart} pending delivery`;
      return { audience: "internal", tag, text, tone: "dim", glyph: "diamond", ref };
    }

    case "goal.accept_rejected": {
      const failed = Array.isArray(p.failedCriteria) ? p.failedCriteria.length : 0;
      const text = failed > 0 ? `Acceptance blocked (${failed} failing check${failed === 1 ? "" : "s"})` : "Acceptance blocked by failing checks";
      return { audience: "internal", tag, text, tone: "dim", glyph: "diamond", ref };
    }

    case "goal.accept_gates_skipped": {
      const reason = ensureSafeText(asString(p.reason), "", ev.type);
      const text = reason ? `Acceptance checks skipped: ${reason}` : "Acceptance checks skipped";
      return { audience: "internal", tag, text, tone: "dim", glyph: "diamond", ref };
    }

    case "goal.review_stale": {
      const revV = asNumber(p.reviewedVersion);
      const curV = asNumber(p.currentVersion);
      const detail = revV !== null && curV !== null ? ` (v${revV} vs v${curV})` : "";
      return { audience: "internal", tag, text: `Stale review ignored${detail}`, tone: "dim", glyph: "diamond", ref };
    }

    case "goal.reviewer_failed": {
      const message = ensureSafeText(asString(p.message), "", ev.type);
      const text = message ? `Reviewer failed: ${message}` : "Reviewer failed";
      return { audience: "internal", tag, text, tone: "dim", glyph: "diamond", ref };
    }

    case "goal.review_superseded": {
      const fromV = asNumber(p.fromVersion);
      const toV = asNumber(p.toVersion);
      const detail = fromV !== null && toV !== null ? ` (v${fromV} to v${toV})` : "";
      return { audience: "internal", tag, text: `Review superseded${detail}`, tone: "dim", glyph: "diamond", ref };
    }

    default: {
      const readable = ensureSafeText(
        asString(p.summary) || asString(p.title) || asString(p.message),
        "Goal update",
        ev.type,
      );
      return { audience: "internal", tag, text: readable, tone: "dim", glyph: "diamond", ref };
    }
  }
}

function classifyLiveQuotaEvent(ev: DaemonEventFrame, p: Record<string, unknown>): ClassifiedChatLine {
  const audience = classifyAttentionAudience({
    kind: "quota",
    eventType: ev.type,
    runId: ev.runId || asString(p.runId),
    mode: p.mode,
    reason: p.reason,
    resumeAt: p.resumeAt,
    createdAt: ev.createdAt,
  });
  const effectiveAudience: ChatLineAudience = audience === "human" ? "human" : "internal";
  const reason = ensureSafeText(asString(p.reason), "", ev.type);
  const wake =
    p.resumeAt && (typeof p.resumeAt === "number" || typeof p.resumeAt === "string")
      ? ` · resumes ${formatCountdown(p.resumeAt)}`
      : "";
  const runPrefix = ev.runId ? `${ev.runId}: ` : "";
  const ref: EntityRef | undefined = ev.runId ? { kind: "run", id: ev.runId, label: ev.runId } : undefined;

  let text: string;
  let tone: Tone = effectiveAudience === "human" ? "warn" : "dim";

  switch (ev.type) {
    case "quota.run_paused":
      text =
        effectiveAudience === "human"
          ? `${runPrefix}Paused for quota${reason ? `: ${reason}` : ""} (manual resume required)`
          : `${runPrefix}Paused for quota${reason ? `: ${reason}` : ""}${wake}`;
      break;
    case "quota.run_scheduled":
      text = `${runPrefix}Quota resume scheduled${wake}`;
      break;
    case "quota.run_resumed":
      text = `${runPrefix}Resumed after quota pause`;
      if (effectiveAudience === "human") tone = "ok";
      break;
    case "quota.agent_paused":
      text = `${runPrefix}Agent paused on quota${reason ? `: ${reason}` : ""}`;
      break;
    case "quota.agent_retrying":
      text = `${runPrefix}Retrying after quota limit${reason ? `: ${reason}` : ""}`;
      break;
    case "quota.agent_recovered":
      text = `${runPrefix}Agent recovered from quota limit`;
      break;
    default:
      text = `${runPrefix}Quota update${reason ? `: ${reason}` : ""}${wake}`;
      break;
  }

  return {
    audience: effectiveAudience,
    tag: "quota",
    text: ensureSafeText(text, "Quota update", ev.type),
    tone,
    glyph: "pause",
    ref,
  };
}

function classifyLiveEscalationEvent(ev: DaemonEventFrame, p: Record<string, unknown>): ClassifiedChatLine | null {
  const audience = classifyAttentionAudience({
    kind: "escalation",
    runId: ev.runId || asString(p.runId),
    id: p.id,
    escalationId: p.escalationId,
    fromTaskId: p.fromTaskId ?? ev.taskId,
    toTaskId: p.toTaskId,
    severity: p.severity,
    category: p.category,
    title: p.title,
    blocking: p.blocking,
    status: p.status,
    createdAt: p.createdAt ?? ev.createdAt,
  });
  if (audience === "drop") return null;

  const escId = asString(p.id) || asString(p.escalationId);
  const title = ensureSafeText(asString(p.title), "Escalation raised", ev.type);
  const sev = asString(p.severity) || "P1";
  const ref: EntityRef | undefined = escId
    ? { kind: "escalation", id: escId, runId: ev.runId, label: `${escId} ${title}` }
    : undefined;
  return {
    audience,
    tag: ensureSafeTag(escId ? `${sev} ${escId}` : `${sev} escalation`, "escalation", ev.type),
    text: title,
    tone: audience === "internal" ? "dim" : sev === "P0" ? "danger" : "warn",
    glyph: "warn",
    ref,
  };
}

function classifyLivePeerMessage(ev: DaemonEventFrame, p: Record<string, unknown>): ClassifiedChatLine {
  const fromHost = sanitizeLine(asString(p.fromHost) || "peer");
  const fromSid = sanitizeLine(asString(p.fromSessionId) || "session");
  const fromProj = asString(p.fromProjectName) ? ` [${sanitizeLine(asString(p.fromProjectName))}]` : "";
  const bodyText = firstLine(sanitizeLine(asString(p.body)), 100) || "(empty message)";
  const tripped = Boolean(p.circuitBreakerTripped);
  return {
    audience: "human",
    tag: tripped ? "peer paused" : "peer",
    text: `${fromHost}:${fromSid}${fromProj}: ${bodyText}${tripped ? " (auto-wakeup paused by hop breaker)" : ""}`,
    tone: tripped ? "warn" : "info",
    glyph: "bullet",
  };
}

function classifyPlainSystemNotice(rawContent: string): ClassifiedChatLine | null {
  const content = rawContent.trim();
  if (!content) return null;

  // Interrupted-turn notice from daemon restart: one clean human line, hide tool list.
  if (content.startsWith("[harness] The daemon restarted while this turn was running.")) {
    return {
      audience: "human",
      tag: "daemon",
      text: "Previous turn was interrupted by a daemon restart; partial text is saved above.",
      tone: "muted",
      glyph: "bullet",
    };
  }

  // Audit notices written by Director tools
  if (content.startsWith("Director write_note:")) {
    return {
      audience: "internal",
      tag: "note",
      text: ensureSafeText(content, "Director wrote note"),
      tone: "dim",
      glyph: "bullet",
    };
  }
  if (content.startsWith("Director read_file:")) {
    return {
      audience: "internal",
      tag: "read",
      text: ensureSafeText(content, "Director read file"),
      tone: "dim",
      glyph: "bullet",
    };
  }

  // Peer message circuit-breaker notice
  if (content.startsWith("[PEER MESSAGE")) {
    const cleaned = content.replace(/^\[PEER MESSAGE\s+from\s+([^\]]+)\]\s*/i, "From $1: ");
    return {
      audience: "human",
      tag: "peer paused",
      text: ensureSafeText(cleaned, "Peer message received"),
      tone: "warn",
      glyph: "bullet",
    };
  }

  // Bucket escalation notice for Director
  if (/^Escalation\s+\S+.*\(close with resolve_escalation\)\.?$/is.test(content)) {
    return {
      audience: "internal",
      tag: "escalation",
      text: ensureSafeText(formatPersistedEscalationNotice(content), "Escalation notice"),
      tone: "dim",
      glyph: "bullet",
    };
  }

  // Escalation resolved notice: hide when resolved by director, show human confirmation otherwise.
  const resolvedMatch = content.match(/^Escalation\s+\S+.*\bresolved by\s+([^:]+):/is);
  if (resolvedMatch) {
    const resolver = resolvedMatch[1]!.trim().toLowerCase();
    const isDirector = resolver === "director" || resolver.startsWith("director ");
    return {
      audience: isDirector ? "internal" : "human",
      tag: "escalation",
      text: ensureSafeText(formatPersistedEscalationNotice(content), "Escalation resolved"),
      tone: isDirector ? "dim" : "ok",
      glyph: "bullet",
    };
  }

  if (content.startsWith("Registered project ") || content.startsWith("Switched session project")) {
    return {
      audience: "human",
      tag: "project",
      text: ensureSafeText(content, "Project updated"),
      tone: "info",
      glyph: "bullet",
    };
  }

  if (content.startsWith("Migrated session model ")) {
    return {
      audience: "human",
      tag: "model",
      text: ensureSafeText(content, "Model updated"),
      tone: "info",
      glyph: "bullet",
    };
  }

  const singleLine = humanizeTokens(firstLine(content, 240));
  if (!singleLine || RAW_EVENT_TYPE_RE.test(singleLine)) {
    return {
      audience: "internal",
      tag: "notice",
      text: "System notice",
      tone: "dim",
      glyph: "bullet",
    };
  }

  return {
    audience: "human",
    tag: "notice",
    text: singleLine,
    tone: "info",
    glyph: "bullet",
  };
}

/**
 * Classifies a live daemon event frame or a replayed `system_notice` turn into a human-worded
 * chat line with an `audience` (`human` vs `internal`), or `null` to drop it.
 */
export function classifyChatLine(
  input: ChatLineInput,
  opts?: { remoteHost?: string | null },
): ClassifiedChatLine | null {
  if (input.source === "replay") {
    const parsed = input.turn.event ? parseChatControlEvent(input.turn.event) : null;
    if (parsed) return classifyControlEvent(parsed, opts);
    return classifyPlainSystemNotice(input.turn.content);
  }

  const ev = input.event;
  const p = (ev.payload ?? {}) as Record<string, unknown>;

  if (ev.type === "session.message_received") {
    return classifyLivePeerMessage(ev, p);
  }
  if (ev.type === "escalation.created") {
    return classifyLiveEscalationEvent(ev, p);
  }
  if (ev.type.startsWith("goal.")) {
    return classifyLiveGoalEvent(ev, p, opts);
  }
  if (ev.type.startsWith("quota.")) {
    return classifyLiveQuotaEvent(ev, p);
  }
  return null;
}
