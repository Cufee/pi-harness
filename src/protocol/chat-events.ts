/**
 * Typed control-plane events surfaced in the Director chat transcript and TUI.
 *
 * The TUI switches strictly on `event.kind` (never parsing string prefixes like `[Event]`).
 * Conversion to text happens only at the LLM prompt/history boundary via `formatChatEventForModel`
 * and `formatChatEventSummary`.
 */

export type ChatEventSource = "director" | "user" | "system";

function parseEventSource(v: unknown): { source?: ChatEventSource } {
  return v === "director" || v === "user" || v === "system" ? { source: v } : {};
}

export type ChatControlEvent =
  | {
      kind: "goal.settled";
      goalId: string;
      goalVersion: number;
      goalTitle: string;
      runId: string;
      runStatus: "completed" | "failed" | "stopped";
      openEscalations: number;
      /** Recorded cause text (stop reason, quota reason, escalation title, verification error). */
      detail?: string;
      /**
       * Cause category: "explicit_stop", "run_failed", "quota_paused", "escalation", "verification_error", "gates_failed",
       * "daemon_restart" (interrupted, resumable) or "blocked_escalation" (blocked on open escalations, recoverable).
       */
      cause?: string;
      /** Who caused the settlement; director-originated events do not wake the Director. */
      source?: ChatEventSource;
    }
  | {
      kind: "goal.escalated";
      goalId: string;
      goalVersion: number;
      goalTitle: string;
      runId: string;
      /** Informational DB run status at the time of the escalation (active, paused_quota, completed, ...). */
      runStatus: string;
      escalationId: string;
      severity: "P0";
      title: string;
      openEscalations: number;
    }
  | {
      kind: "goal.committed";
      goalId: string;
      goalVersion: number;
      goalTitle: string;
      runId: string;
      criteriaCount: number;
    }
  | {
      kind: "goal.amended";
      goalId: string;
      fromVersion: number;
      toVersion: number;
      rationale: string;
      /** Who amended the goal. */
      source?: "director" | "user" | "external";
    }
  | {
      kind: "goal.reviewed";
      goalId: string;
      goalVersion: number;
      cycle: number;
      verdict: string;
      status: string;
      summary: string;
      circuitBreakerTripped?: string;
      /** Who caused the review (e.g. a director or user accept override). */
      source?: ChatEventSource;
    }
  | {
      kind: "director.read_file";
      path: string;
      bytes: number;
      reason?: string;
      offset?: number;
    }
  | {
      kind: "timer.scheduled";
      timerId: string;
      wakeAt: number;
      reason: string;
      goalId?: string | null;
      wakeOnEvent?: string;
      pausedGoal?: boolean;
    }
  | {
      kind: "timer.fired";
      timerId: string;
      reason: string;
      wakeReason: string;
      goalId?: string | null;
      resumedGoal?: boolean;
    }
  | {
      kind: "session.message_received";
      messageId: string;
      fromHost: string;
      fromSessionId: string;
      fromProjectName?: string | null;
      body: string;
      expectReply?: boolean;
      hopCount: number;
      circuitBreakerTripped?: boolean;
    }
  | {
      kind: "task.settled";
      taskId: string;
      generation: number;
      runId: string;
      title: string;
      status: "completed" | "failed" | "blocked" | "returned_for_rescope";
      summary: string;
      partial?: boolean;
    }
  | {
      kind: "goal.gate_activity";
      goalId: string;
      goalVersion: number;
      goalTitle: string;
      runId: string;
      /** Why the goal is gated: awaiting_human wins when both hold. */
      gate: "awaiting_human" | "blocking_escalation";
      /** Open or acked blocking escalations routed to the human (toTaskId null), newest first, max 5 ids. */
      escalationIds: string[];
      openBlockingEscalations: number;
      activity: "worker_spawned" | "remote_push";
      /** The spawned worker (worker_spawned) or the task whose shell pushed (remote_push). */
      taskId: string;
      taskTier: number;
      /** worker_spawned: worker title (<=160 chars). */
      title?: string;
      /** remote_push: command text (<=200 chars), remote ("To <url>" or the remote arg), ref updates (<=5, e.g. "e38b213..a3328cf HEAD -> main"). */
      command?: string;
      remote?: string;
      refs?: string[];
      /** remote_push: true when the tool output shows a ref update; false when only the command was seen. */
      confirmed?: boolean;
      /** remote_push: tool call / occurrence id used to keep distinct pushes separate when coalescing. */
      toolCallId?: string;
    }
  | {
      /**
       * A lead thread's request changed state. phase "created": the lead asked the user a question (user_question)
       * or sent work back as outside its goal (routed_work). phase "triaged": the lead decided a request the Director
       * forwarded (user_request).
       */
      kind: "thread.request";
      requestId: string;
      requestKind: "user_request" | "user_question" | "routed_work";
      phase: "created" | "triaged";
      /** phase "triaged": accepted, delegated, answered, or declined. */
      outcome?: "accepted" | "delegated" | "answered" | "declined";
      goalId: string | null;
      runId: string;
      taskId: string;
      title: string;
      /** The question, the routed work, or the forwarded request (<=2,000 chars). */
      body: string;
      /** phase "triaged": the lead's note or answer (<=2,000 chars). */
      resolution?: string;
      /** outcome "declined": the routed_work request the Director must reschedule or drop. */
      routedRequestId?: string;
    }
  | {
      /** Goal lifecycle events queued during a busy Director turn, coalesced and delivered in one turn (oldest first). */
      kind: "goal.events_batch";
      events: GoalLifecycleChatEvent[];
    };

/** Goal and delegated-task lifecycle events that may be coalesced into one `goal.events_batch` wake. */
export type GoalLifecycleChatEvent = Extract<
  ChatControlEvent,
  { kind: "goal.settled" | "goal.committed" | "goal.amended" | "goal.reviewed" | "goal.gate_activity" | "task.settled" }
>;

const GOAL_LIFECYCLE_KINDS = new Set<string>([
  "goal.settled",
  "goal.committed",
  "goal.amended",
  "goal.reviewed",
  "goal.gate_activity",
  "task.settled",
]);

export function isGoalLifecycleEvent(e: ChatControlEvent): e is GoalLifecycleChatEvent {
  return GOAL_LIFECYCLE_KINDS.has(e.kind);
}

/**
 * One event per (goalId, kind) or taskId: the last occurrence wins and keeps its position. Coalesced amendments keep
 * the earliest fromVersion so the delivered event spans every version change.
 */
export function coalesceGoalEvents(events: GoalLifecycleChatEvent[]): GoalLifecycleChatEvent[] {
  const keyOf = (e: GoalLifecycleChatEvent) =>
    e.kind === "task.settled"
      ? `task:${e.taskId}`
      : e.kind === "goal.gate_activity"
        ? e.toolCallId
          ? `gate:${e.runId}:${e.activity}:${e.taskId}:call:${e.toolCallId}`
          : `gate:${e.runId}:${e.activity}:${e.taskId}:${(e.refs ?? []).join(",")}:${e.command ?? ""}`
        : `${e.goalId}\u0000${e.kind}`;
  const last = new Map<string, number>();
  const firstFrom = new Map<string, number>();
  events.forEach((e, i) => {
    const key = keyOf(e);
    last.set(key, i);
    if (e.kind === "goal.amended" && !firstFrom.has(key)) firstFrom.set(key, e.fromVersion);
  });
  const out: GoalLifecycleChatEvent[] = [];
  events.forEach((e, i) => {
    const key = keyOf(e);
    if (last.get(key) !== i) return;
    out.push(e.kind === "goal.amended" ? { ...e, fromVersion: Math.min(e.fromVersion, firstFrom.get(key) ?? e.fromVersion) } : e);
  });
  return out;
}

/** A recorded review stops being current once its goal is amended, paused or cancelled, or a later review or accept is recorded. */
export function isReviewInvalidated(
  goal: { version: number; reviewCycle: number; status: string },
  review: { goalVersion: number; cycle: number },
): boolean {
  return (
    goal.version !== review.goalVersion ||
    goal.reviewCycle !== review.cycle ||
    goal.status === "paused" ||
    goal.status === "cancelled"
  );
}

/** Validates an untrusted wire or SQLite JSON value into a typed `ChatControlEvent` or `null`. */
export function parseChatControlEvent(raw: unknown): ChatControlEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  switch (r.kind) {
    case "goal.settled": {
      const runStatus = r.runStatus;
      if (
        typeof r.goalId !== "string" ||
        typeof r.goalVersion !== "number" ||
        typeof r.goalTitle !== "string" ||
        typeof r.runId !== "string" ||
        (runStatus !== "completed" && runStatus !== "failed" && runStatus !== "stopped")
      ) {
        return null;
      }
      const detail = typeof r.detail === "string" ? r.detail.trim().slice(0, 500) : "";
      return {
        kind: "goal.settled",
        goalId: r.goalId,
        goalVersion: r.goalVersion,
        goalTitle: r.goalTitle,
        runId: r.runId,
        runStatus,
        openEscalations: typeof r.openEscalations === "number" ? r.openEscalations : 0,
        ...(detail ? { detail } : {}),
        ...(typeof r.cause === "string" && r.cause ? { cause: r.cause } : {}),
        ...parseEventSource(r.source),
      };
    }
    case "goal.escalated": {
      if (
        typeof r.goalId !== "string" ||
        typeof r.goalVersion !== "number" ||
        typeof r.goalTitle !== "string" ||
        typeof r.runId !== "string" ||
        typeof r.escalationId !== "string" ||
        typeof r.title !== "string" ||
        r.severity !== "P0"
      ) {
        return null;
      }
      return {
        kind: "goal.escalated",
        goalId: r.goalId,
        goalVersion: r.goalVersion,
        goalTitle: r.goalTitle,
        runId: r.runId,
        runStatus: typeof r.runStatus === "string" && r.runStatus.trim() ? r.runStatus.trim() : "unknown",
        escalationId: r.escalationId,
        severity: "P0",
        title: r.title,
        openEscalations: typeof r.openEscalations === "number" ? r.openEscalations : 0,
      };
    }
    case "goal.committed": {
      if (
        typeof r.goalId !== "string" ||
        typeof r.goalVersion !== "number" ||
        typeof r.goalTitle !== "string" ||
        typeof r.runId !== "string"
      ) {
        return null;
      }
      return {
        kind: "goal.committed",
        goalId: r.goalId,
        goalVersion: r.goalVersion,
        goalTitle: r.goalTitle,
        runId: r.runId,
        criteriaCount: typeof r.criteriaCount === "number" ? r.criteriaCount : 0,
      };
    }
    case "goal.amended": {
      if (
        typeof r.goalId !== "string" ||
        typeof r.fromVersion !== "number" ||
        typeof r.toVersion !== "number" ||
        typeof r.rationale !== "string"
      ) {
        return null;
      }
      return {
        kind: "goal.amended",
        goalId: r.goalId,
        fromVersion: r.fromVersion,
        toVersion: r.toVersion,
        rationale: r.rationale,
        ...(r.source === "director" || r.source === "user" || r.source === "external" ? { source: r.source } : {}),
      };
    }
    case "goal.reviewed": {
      if (
        typeof r.goalId !== "string" ||
        typeof r.goalVersion !== "number" ||
        typeof r.cycle !== "number" ||
        typeof r.verdict !== "string" ||
        typeof r.status !== "string" ||
        typeof r.summary !== "string"
      ) {
        return null;
      }
      return {
        kind: "goal.reviewed",
        goalId: r.goalId,
        goalVersion: r.goalVersion,
        cycle: r.cycle,
        verdict: r.verdict,
        status: r.status,
        summary: r.summary,
        ...(typeof r.circuitBreakerTripped === "string" ? { circuitBreakerTripped: r.circuitBreakerTripped } : {}),
        ...parseEventSource(r.source),
      };
    }
    case "director.read_file": {
      if (typeof r.path !== "string" || typeof r.bytes !== "number") {
        return null;
      }
      return {
        kind: "director.read_file",
        path: r.path,
        bytes: r.bytes,
        ...(typeof r.reason === "string" && r.reason ? { reason: r.reason } : {}),
        ...(typeof r.offset === "number" && Number.isFinite(r.offset) && r.offset > 0 ? { offset: r.offset } : {}),
      };
    }
    case "timer.scheduled": {
      if (typeof r.timerId !== "string" || typeof r.wakeAt !== "number" || typeof r.reason !== "string") {
        return null;
      }
      return {
        kind: "timer.scheduled",
        timerId: r.timerId,
        wakeAt: r.wakeAt,
        reason: r.reason,
        ...(typeof r.goalId === "string" ? { goalId: r.goalId } : {}),
        ...(typeof r.wakeOnEvent === "string" ? { wakeOnEvent: r.wakeOnEvent } : {}),
        ...(typeof r.pausedGoal === "boolean" ? { pausedGoal: r.pausedGoal } : {}),
      };
    }
    case "timer.fired": {
      if (typeof r.timerId !== "string" || typeof r.reason !== "string" || typeof r.wakeReason !== "string") {
        return null;
      }
      return {
        kind: "timer.fired",
        timerId: r.timerId,
        reason: r.reason,
        wakeReason: r.wakeReason,
        ...(typeof r.goalId === "string" ? { goalId: r.goalId } : {}),
        ...(typeof r.resumedGoal === "boolean" ? { resumedGoal: r.resumedGoal } : {}),
      };
    }
    case "session.message_received": {
      if (
        typeof r.messageId !== "string" ||
        typeof r.fromHost !== "string" ||
        typeof r.fromSessionId !== "string" ||
        typeof r.body !== "string"
      ) {
        return null;
      }
      return {
        kind: "session.message_received",
        messageId: r.messageId,
        fromHost: r.fromHost,
        fromSessionId: r.fromSessionId,
        ...(typeof r.fromProjectName === "string" ? { fromProjectName: r.fromProjectName } : {}),
        body: r.body,
        ...(typeof r.expectReply === "boolean" ? { expectReply: r.expectReply } : {}),
        hopCount: typeof r.hopCount === "number" ? r.hopCount : 1,
        ...(typeof r.circuitBreakerTripped === "boolean" ? { circuitBreakerTripped: r.circuitBreakerTripped } : {}),
      };
    }
    case "task.settled": {
      const status = r.status;
      if (
        typeof r.taskId !== "string" ||
        typeof r.generation !== "number" ||
        typeof r.runId !== "string" ||
        typeof r.title !== "string" ||
        (status !== "completed" && status !== "failed" && status !== "blocked" && status !== "returned_for_rescope")
      ) {
        return null;
      }
      const summary = typeof r.summary === "string" ? r.summary.replace(/\s+/g, " ").trim().slice(0, 300) : "";
      return {
        kind: "task.settled",
        taskId: r.taskId,
        generation: r.generation,
        runId: r.runId,
        title: r.title,
        status,
        summary,
        ...(r.partial === true ? { partial: true } : {}),
      };
    }
    case "thread.request": {
      const requestKind = r.requestKind;
      const phase = r.phase;
      if (
        typeof r.requestId !== "string" ||
        typeof r.runId !== "string" ||
        typeof r.taskId !== "string" ||
        typeof r.title !== "string" ||
        (requestKind !== "user_request" && requestKind !== "user_question" && requestKind !== "routed_work") ||
        (phase !== "created" && phase !== "triaged")
      ) {
        return null;
      }
      const outcome = r.outcome;
      return {
        kind: "thread.request",
        requestId: r.requestId,
        requestKind,
        phase,
        ...(outcome === "accepted" || outcome === "delegated" || outcome === "answered" || outcome === "declined" ? { outcome } : {}),
        goalId: typeof r.goalId === "string" ? r.goalId : null,
        runId: r.runId,
        taskId: r.taskId,
        title: r.title.replace(/\s+/g, " ").trim().slice(0, 200),
        body: typeof r.body === "string" ? r.body.trim().slice(0, 2000) : "",
        ...(typeof r.resolution === "string" && r.resolution.trim() ? { resolution: r.resolution.trim().slice(0, 2000) } : {}),
        ...(typeof r.routedRequestId === "string" ? { routedRequestId: r.routedRequestId } : {}),
      };
    }
    case "goal.gate_activity": {
      const gate = r.gate;
      const activity = r.activity;
      if (
        typeof r.goalId !== "string" ||
        typeof r.goalVersion !== "number" ||
        !Number.isFinite(r.goalVersion) ||
        typeof r.goalTitle !== "string" ||
        typeof r.runId !== "string" ||
        (gate !== "awaiting_human" && gate !== "blocking_escalation") ||
        (activity !== "worker_spawned" && activity !== "remote_push") ||
        typeof r.taskId !== "string" ||
        typeof r.taskTier !== "number" ||
        !Number.isFinite(r.taskTier)
      ) {
        return null;
      }
      const escalationIds = Array.isArray(r.escalationIds)
        ? r.escalationIds
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((s) => s.trim().slice(0, 120))
            .slice(0, 5)
        : [];
      const openBlockingEscalations =
        typeof r.openBlockingEscalations === "number" && Number.isFinite(r.openBlockingEscalations)
          ? Math.max(0, Math.floor(r.openBlockingEscalations))
          : escalationIds.length;
      const title = typeof r.title === "string" ? r.title.replace(/\s+/g, " ").trim().slice(0, 160) : "";
      const command = typeof r.command === "string" ? r.command.replace(/\s+/g, " ").trim().slice(0, 200) : "";
      const remote = typeof r.remote === "string" ? r.remote.trim().slice(0, 200) : "";
      const toolCallId = typeof r.toolCallId === "string" ? r.toolCallId.trim().slice(0, 120) : "";
      const refs = Array.isArray(r.refs)
        ? r.refs
            .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
            .map((s) => s.replace(/\s+/g, " ").trim().slice(0, 200))
            .slice(0, 5)
        : [];
      return {
        kind: "goal.gate_activity",
        goalId: r.goalId,
        goalVersion: r.goalVersion,
        goalTitle: r.goalTitle,
        runId: r.runId,
        gate,
        escalationIds,
        openBlockingEscalations,
        activity,
        taskId: r.taskId,
        taskTier: r.taskTier,
        ...(title ? { title } : {}),
        ...(command ? { command } : {}),
        ...(remote ? { remote } : {}),
        ...(refs.length > 0 ? { refs } : {}),
        ...(typeof r.confirmed === "boolean" ? { confirmed: r.confirmed } : {}),
        ...(toolCallId ? { toolCallId } : {}),
      };
    }
    case "goal.events_batch": {
      if (!Array.isArray(r.events)) return null;
      const events = r.events
        .map((e) => parseChatControlEvent(e))
        .filter((e): e is GoalLifecycleChatEvent => e !== null && isGoalLifecycleEvent(e));
      return events.length > 0 ? { kind: "goal.events_batch", events } : null;
    }
    default:
      return null;
  }
}

/**
 * Concise plain-text summary stored in `chat_turns.content` for history context and plain-text logs.
 * `remoteHost` (a client attached to a remote daemon) qualifies cited CLI commands with `--remote <host>`.
 */
export function formatChatEventSummary(event: ChatControlEvent, opts?: { remoteHost?: string | null }): string {
  switch (event.kind) {
    case "goal.settled": {
      const head = `Goal ${event.goalId} v${event.goalVersion} ("${event.goalTitle}")`;
      const esc = event.openEscalations ? ` (${event.openEscalations} open escalation(s))` : "";
      const treeCmd = cliCommand("tree", event.runId, opts?.remoteHost);
      const resumeCmd = cliCommand("resume", event.runId, opts?.remoteHost);
      const verificationError = settledVerificationError(event);
      if (verificationError !== null) {
        if (event.runStatus === "stopped") {
          return `${head}: run ${event.runId} is stopped, and automatic goal verification failed to run: ${verificationError}${esc}. Goal ${event.goalId} is awaiting_human. Inspect the goal (goal_get) or run (${treeCmd}); nothing restarts automatically.`;
        }
        if (event.runStatus === "failed") {
          return `${head}: run ${event.runId} failed, and automatic goal verification also failed to run: ${verificationError}${esc}. Goal ${event.goalId} is awaiting_human. Inspect the goal (goal_get) or run (${treeCmd}), fix the verification issue, or continue in place with ${resumeCmd}.`;
        }
        return (
          `${head}: run ${event.runId} completed, but goal verification failed to run: ${verificationError}${esc}. The run itself did not fail. ` +
          `Re-run verification (Director: goal_trigger_review) or inspect the goal (goal_get); inspect the run with ${treeCmd}.`
        );
      }
      if (event.runStatus === "completed") {
        const detail = event.detail?.replace(/\s+/g, " ").trim();
        return `${head} run ${event.runId} completed${esc}${detail ? `: ${detail}` : ""}.`;
      }
      if (event.cause === "daemon_restart") {
        return `${head}: run ${event.runId} was interrupted by a daemon restart (resumable, not a failure).`;
      }
      if (event.cause === "blocked_escalation") {
        const detail = event.detail?.replace(/\s+/g, " ").trim();
        return `${head}: run ${event.runId} is blocked on ${event.openEscalations} open escalation(s)${detail ? `: ${detail}` : ""}`;
      }
      const recovery = `Nothing restarts automatically. Continue it in place with ${resumeCmd}, inspect it with ${treeCmd}, or send a new request.`;
      const quotaReason = settledQuotaReason(event);
      if (quotaReason !== null) {
        return (
          `${head}: run ${event.runId} paused on provider quota: ${quotaReason}${esc}. Automatic resume is not scheduled (manual quota mode), so it will not resume by itself. ` +
          `Continue it in place with ${resumeCmd} once quota is back, inspect it with ${treeCmd}, or send a new request.`
        );
      }
      if (event.cause === "escalation") {
        return `${head}: run ${event.runId} needs human input: ${settledCauseText(event, treeCmd)}${esc}. Inspect it with ${treeCmd} and answer the escalation, or send a new request.`;
      }
      if (event.cause === "gates_failed") {
        return `${head}: run ${event.runId} failed and required deterministic gates still fail: ${settledCauseText(event, treeCmd)}${esc}. ${recovery}`;
      }
      if (event.runStatus === "stopped") {
        if (isExplicitStop(event)) return `${head}: run ${event.runId} was stopped: ${event.detail!.trim()}${esc}. ${recovery}`;
        return `${head}: run ${event.runId} is stopped: ${settledCauseText(event, treeCmd, "no explicit stop was recorded")}${esc}. ${recovery}`;
      }
      return `${head}: run ${event.runId} failed: ${settledCauseText(event, treeCmd)}${esc}. ${recovery}`;
    }
    case "goal.escalated": {
      const esc = event.openEscalations ? ` (${event.openEscalations} open escalation(s))` : "";
      const title = event.title.replace(/\s+/g, " ").trim();
      return `Goal ${event.goalId} v${event.goalVersion} ("${event.goalTitle}") run ${event.runId} (${event.runStatus}): ${event.severity} escalation ${event.escalationId} raised — ${title}${esc}.`;
    }
    case "goal.committed":
      return `Goal ${event.goalId} v${event.goalVersion} started autonomous run ${event.runId} (${event.criteriaCount} criteria).`;
    case "goal.amended":
      return `Goal ${event.goalId} v${event.fromVersion}->v${event.toVersion} amended (${event.rationale}); stale reviews invalidated.`;
    case "goal.reviewed": {
      const by = event.source === "director" || event.source === "user" ? event.source : null;
      const override = by ? (/override/i.test(event.summary) ? ` [${by} override]` : ` [by ${by}]`) : "";
      return `Goal ${event.goalId} v${event.goalVersion} review #${event.cycle} (${event.status})${override}: ${event.summary}`;
    }
    case "director.read_file":
      return `Director read_file: ${event.path} (${event.bytes} bytes${event.offset && event.offset > 0 ? ` at offset ${event.offset}` : ""})${event.reason ? `. Reason: ${event.reason}` : "."}`;
    case "timer.scheduled":
      return `Scheduled timer ${event.timerId} for ${new Date(event.wakeAt).toISOString()}${event.goalId ? ` (${event.goalId})` : ""}: ${event.reason}`;
    case "timer.fired":
      return `Timer ${event.timerId} fired (${event.wakeReason})${event.goalId ? ` for ${event.goalId}` : ""}: ${event.reason}`;
    case "task.settled": {
      const title = event.title.replace(/\s+/g, " ").trim();
      const partial = event.partial ? " (partial)" : "";
      const detail = event.summary.replace(/\s+/g, " ").trim();
      return `Delegated task ${event.taskId} ("${title}") ${event.status}${partial}${detail ? `: ${detail}` : ""}.`;
    }
    case "goal.gate_activity": {
      const escList = event.escalationIds.length > 0 ? event.escalationIds.join(", ") : "";
      const gatePhrase =
        event.gate === "awaiting_human"
          ? event.openBlockingEscalations > 0
            ? `is awaiting_human (${event.openBlockingEscalations} blocking escalation(s)${escList ? `: ${escList}` : ""})`
            : "is awaiting_human"
          : `has ${event.openBlockingEscalations || event.escalationIds.length} blocking escalation(s)${escList ? ` (${escList})` : ""}`;
      if (event.activity === "worker_spawned") {
        const titlePart = event.title ? ` ("${event.title.replace(/\s+/g, " ").trim()}")` : "";
        return `Goal ${event.goalId} v${event.goalVersion} ${gatePhrase}, but run ${event.runId} spawned worker ${event.taskId}${titlePart}.`;
      }
      const remotePart = event.remote ? ` to ${event.remote}` : "";
      const pushDetail =
        event.refs && event.refs.length > 0
          ? `: ${event.refs.join(", ")}`
          : event.command
            ? ` (${event.confirmed === false ? "unconfirmed: " : ""}${event.command})`
            : event.confirmed === false
              ? " (unconfirmed)"
              : "";
      return `Goal ${event.goalId} v${event.goalVersion} ${gatePhrase}, but task ${event.taskId} pushed${remotePart}${pushDetail}.`;
    }
    case "thread.request": {
      const where = event.goalId ? `Goal ${event.goalId}` : `Run ${event.runId}`;
      const title = event.title.replace(/\s+/g, " ").trim();
      if (event.requestKind === "user_question") return `${where} asks the user (${event.requestId}): ${title}`;
      if (event.requestKind === "routed_work") return `${where} sent work back as outside its goal (${event.requestId}): ${title}`;
      const note = event.resolution ? `: ${event.resolution.replace(/\s+/g, " ").trim().slice(0, 300)}` : "";
      return `${where} ${event.outcome ?? "triaged"} request ${event.requestId} ("${title}")${note}`;
    }
    case "goal.events_batch":
      return `${event.events.length} goal updates: ${event.events.map((e) => formatChatEventSummary(e, opts)).join("; ")}`;
    case "session.message_received": {
      const origin = `${event.fromHost}:${event.fromSessionId}${event.fromProjectName ? ` [${event.fromProjectName}]` : ""}`;
      const preview = event.body.replace(/\s+/g, " ").trim().slice(0, 160);
      return `Message from ${origin}: ${preview}${event.circuitBreakerTripped ? " (auto-wakeup paused: hop limit reached)" : ""}`;
    }
  }
}

/**
 * Formats a typed `ChatControlEvent` into model-facing prompt text (LLM boundary only).
 */
export function formatChatEventForModel(event: ChatControlEvent): string {
  const summary = formatChatEventSummary(event);
  switch (event.kind) {
    case "goal.settled": {
      const escNote =
        event.openEscalations > 0
          ? " Open escalations stay open until disposed; close any handled finding with `resolve_escalation({ escalation_id, reason })`."
          : "";
      const resume = `resume_run({ goal_id: "${event.goalId}" })`;
      if (settledVerificationError(event) !== null && event.runStatus === "stopped") {
        return [
          summary,
          `Run ${event.runId} for Goal ${event.goalId} is stopped, and automatic goal verification failed to run; Goal ${event.goalId} is awaiting_human. Do not restart the run yourself. Inspect the goal with goal_get({ goal_id: "${event.goalId}" }) and report the verification error and stop status to the user.${escNote}`,
        ].join("\n");
      }
      if (settledVerificationError(event) !== null && event.runStatus === "failed") {
        return [
          summary,
          `Run ${event.runId} for Goal ${event.goalId} failed, and automatic goal verification also failed to run; Goal ${event.goalId} is awaiting_human. Inspect the goal with goal_get({ goal_id: "${event.goalId}" }) and the run with run_status({ goal_id: "${event.goalId}" }); fix the verification issue, resume in place with ${resume} if recoverable, or report to the user.${escNote}`,
        ].join("\n");
      }
      if (settledVerificationError(event) !== null) {
        return [
          summary,
          `Run ${event.runId} for Goal ${event.goalId} completed; goal verification failed to run, so Goal ${event.goalId} is awaiting_human. Do not resume or restart the run for it. ` +
            `Fix the cause above (for example select an enabled reviewer profile), inspect the goal with goal_get({ goal_id: "${event.goalId}" }), then re-run verification with goal_trigger_review, or report the verification error to the user.${escNote}`,
        ].join("\n");
      }
      if (event.runStatus === "completed" && event.detail?.trim().toLowerCase().startsWith("blocked:")) {
        return [
          summary,
          `The autonomous run (${event.runId}) for Goal ${event.goalId} finished blocked and needs human input; do not call \`goal_trigger_review\` for it. ` +
            `Inspect the blocker and any open escalation (goal_get({ goal_id: "${event.goalId}" })), surface it to the user with actionable options, then resolve it, ` +
            `amend the goal with \`goal_amend\` if the blocker shows the goal is wrong, or call resume_run({ goal_id: "${event.goalId}" }) once it is unblocked.${escNote}`,
        ].join("\n");
      }
      if (event.runStatus === "completed") {
        return [
          summary,
          `The autonomous run (${event.runId}) for Goal ${event.goalId} finished. Inspect/settle the goal with \`goal_trigger_review\` (using the appropriate \`verification_mode\` for this task) or report the outcome concisely to the user.${escNote}`,
        ].join("\n");
      }
      const inspect = `run_status({ run_id: "${event.runId}" }) (operator: \`pi-harness tree ${event.runId}\`)`;
      const noCause = event.detail ? "" : ` No cause was recorded; inspect with ${inspect}.`;
      let guidance: string;
      if (event.cause === "daemon_restart") {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} was interrupted by a daemon restart. Nothing failed: its work, worktrees and handoffs are preserved. ` +
          `Call ${resume} to continue it in place. Do not create a new goal or report a failure.`;
      } else if (event.cause === "blocked_escalation") {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} is blocked on open escalation(s); this is a recoverable blocker, not a terminal failure. ` +
          `Surface the open escalation(s) to the user or resolve them, then resume_task or ${resume} continues the run in place.`;
      } else if (settledQuotaReason(event) !== null) {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} is paused on provider quota. Nothing was lost; paused tasks keep their worktrees and handoffs. ` +
          `Automatic resume is not scheduled (manual quota mode: no reset time is known or auto-resume is off), so it will not resume by itself. ` +
          `Tell the user, then call ${resume} once quota is back (or schedule_timer with resume_goal). Do not create a new goal.`;
      } else if (event.cause === "escalation") {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} raised an escalation that needs human input. Surface it to the user with actionable options; ` +
          `once it is resolved, ${resume} continues the same run in place.`;
      } else if (event.cause === "gates_failed") {
        guidance = `Run ${event.runId} for Goal ${event.goalId} failed and required deterministic gates still fail; Goal ${event.goalId} is awaiting_human and nothing was retried automatically. Inspect via goal_get({ goal_id: "${event.goalId}" }), then call ${resume}, goal_amend, or report to the user.`;
      } else if (event.runStatus === "stopped" && isExplicitStop(event)) {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} was explicitly stopped; this is not a failure and not a turn or budget limit. Do not restart it yourself. ` +
          `If the user asks to continue, call ${resume} or goal_commit; both continue the same run in place without creating a second run.`;
      } else if (event.runStatus === "stopped") {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} is stopped, but no explicit stop by the operator was recorded; its tasks may have ended on their own. ` +
          `Inspect it with ${inspect} before reporting why. Do not restart it yourself; if the user asks to continue, ${resume} or goal_commit continues the same run in place.`;
      } else {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} failed. Inspect it with run_status({ goal_id: "${event.goalId}" }). ` +
          `If it is recoverable, ${resume} or resume_task for one task continues it in place; otherwise report the cause and options to the user.${noCause}`;
      }
      return [summary, guidance + escNote].join("\n");
    }
    case "goal.escalated":
      return [
        summary,
        `The run (${event.runId}) is '${event.runStatus}'; this is an escalation, not a run failure. Inspect with goal_get({ goal_id: "${event.goalId}" }). Answer it by steering or amending, resume a blocked task with resume_task, call resolve_escalation({ escalation_id: "${event.escalationId}", reason }) once handled, or ask the user if a human decision is needed.`,
      ].join("\n");
    case "timer.fired":
      return [
        summary,
        event.goalId
          ? `Your scheduled timer (${event.timerId}) for Goal ${event.goalId} has fired (${event.wakeReason}). Check live quota/models via \`list_models\` if needed and continue or resume the planned work.`
          : `Your scheduled timer (${event.timerId}) has fired (${event.wakeReason}). Continue the planned action or update the user concisely.`,
      ].join("\n");
    case "task.settled":
      return [
        summary,
        `Read its handoff with wait_tasks({ ids: ["${event.taskId}"] }) (returns immediately), open artifacts with artifact_read if needed, then answer the user or continue.`,
      ].join("\n");
    case "goal.gate_activity":
      return [
        summary,
        `The orchestrator keeps working while the goal waits on a human. Decide whether this matches the open decision: let it continue, steer it with steer_task / steer_run, pause it with goal_pause, or tell the user. Inspect with goal_get({ goal_id: "${event.goalId}" }).`,
      ].join("\n");
    case "thread.request": {
      const where = event.goalId ? `goal ${event.goalId}` : `run ${event.runId}`;
      if (event.requestKind === "user_question") {
        return [
          `The lead thread of ${where} needs an answer from the user (${event.requestId}):`,
          event.body,
          "",
          `Ask the user this question in your reply, in their terms, with the options and the lead's recommendation. The thread keeps working on what does not depend on it. When the user answers, call resolve_request({ request_id: "${event.requestId}", outcome: "user_answered", note: "<their answer>" }). Do not answer for the user; if the conversation already contains their answer, pass that.`,
        ].join("\n");
      }
      if (event.requestKind === "routed_work") {
        return [
          `The lead thread of ${where} sent this work back as outside its goal (${event.requestId}): ${event.title}`,
          event.body,
          "",
          `It is yours to place: create a goal for it, add it to another goal with send_request, or ask the user when it is unclear whether they want it. Then call resolve_request({ request_id: "${event.requestId}", outcome: "rescheduled" | "dropped", note }). Tell the user what you did with it.`,
        ].join("\n");
      }
      const head = `The lead thread of ${where} ${event.outcome ?? "triaged"} request ${event.requestId} ("${event.title}").`;
      if (event.outcome === "answered") {
        return [head, `Its answer: ${event.resolution ?? ""}`, "", "Relay the answer to the user in your own words."].join("\n");
      }
      if (event.outcome === "declined") {
        return [
          head,
          `Its reason: ${event.resolution ?? ""}`,
          "",
          `The request is not lost: it is now routed work${event.routedRequestId ? ` ${event.routedRequestId}` : ""} for you to place. Create a goal for it, send it to a goal it fits, or ask the user; then call resolve_request({ request_id: "${event.routedRequestId ?? "<routed id>"}", outcome: "rescheduled" | "dropped", note }). Tell the user where their request went.`,
        ].join("\n");
      }
      return [head, event.resolution ? `Its note: ${event.resolution}` : ""].filter(Boolean).join("\n");
    }
    case "goal.events_batch":
      return ["Handle these goal updates together in one turn:", ...event.events.map((e) => formatChatEventForModel(e))].join("\n\n");
    case "session.message_received": {
      const replyTarget = `${event.fromHost}:${event.fromSessionId}`;
      return [
        `Peer message (messageId=${event.messageId} | hop=${event.hopCount}) from ${replyTarget}${event.fromProjectName ? ` [${event.fromProjectName}]` : ""}:`,
        event.body,
        "",
        event.expectReply === false
          ? "The sender marked this as informational (no reply needed). Update the user or act on the information; do NOT send an acknowledgment reply."
          : `Act on the message and reply via \`session_send({ target: "${replyTarget}", reply_to_id: "${event.messageId}", message: "...", expect_reply: false })\` ONLY when a substantive answer, result, or follow-up is needed — never send pure acknowledgment loops.`,
      ].join("\n");
    }
    default:
      return summary;
  }
}

const MANUAL_QUOTA_PREFIX = "paused_quota (manual): ";

/** The provider quota reason when a goal.settled event reports a manual quota pause, else null. */
function settledQuotaReason(event: Extract<ChatControlEvent, { kind: "goal.settled" }>): string | null {
  const detail = event.detail?.trim();
  if (detail?.startsWith(MANUAL_QUOTA_PREFIX)) return detail.slice(MANUAL_QUOTA_PREFIX.length).trim() || "quota limit reached";
  if (event.cause === "quota_paused") return detail || "quota limit reached";
  return null;
}

const VERIFICATION_ERROR_PREFIX = "verification_error:";

/** The verification error when a goal.settled event reports a failed post-completion verification, else null. */
function settledVerificationError(event: Extract<ChatControlEvent, { kind: "goal.settled" }>): string | null {
  const detail = event.detail?.trim() ?? "";
  if (detail.startsWith(VERIFICATION_ERROR_PREFIX)) return detail.slice(VERIFICATION_ERROR_PREFIX.length).trim() || "unknown error";
  if (event.cause === "verification_error") return detail || "unknown error";
  return null;
}

/** True only when the stop was recorded as explicit and carries its recorded reason. */
function isExplicitStop(event: Extract<ChatControlEvent, { kind: "goal.settled" }>): boolean {
  return event.cause === "explicit_stop" && Boolean(event.detail?.trim());
}

/** A cited CLI command, qualified with `--remote <host>` when the reader is attached to a remote daemon. */
function cliCommand(verb: "resume" | "tree", runId: string, remoteHost?: string | null): string {
  return `\`pi-harness ${verb} ${runId}${remoteHost ? ` --remote ${remoteHost}` : ""}\``;
}

/** Appends `--remote <selector>` to each `pi-harness tree|resume <run-id>` hint in `text` that lacks one. */
export function qualifyRemoteCliHints(text: string, selector: string | null | undefined): string {
  if (!selector) return text;
  return text.replace(/pi-harness (?:tree|resume) [\w-]+/g, (cmd, offset: number, all: string) =>
    all.startsWith(" --remote", offset + cmd.length) ? cmd : `${cmd} --remote ${selector}`,
  );
}

/** The recorded cause, or an explicit notice that none was recorded naming the inspect command. */
function settledCauseText(
  event: Extract<ChatControlEvent, { kind: "goal.settled" }>,
  treeCmd: string,
  missing = "no cause was recorded",
): string {
  return event.detail?.trim() || `${missing}; inspect with ${treeCmd}`;
}
