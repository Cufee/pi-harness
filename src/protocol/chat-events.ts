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
      /** Cause category: "explicit_stop", "run_failed", "quota_paused", "escalation", or "verification_error". */
      cause?: string;
      /** Who caused the settlement; director-originated events do not wake the Director. */
      source?: ChatEventSource;
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
    };

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
      return {
        kind: "goal.settled",
        goalId: r.goalId,
        goalVersion: r.goalVersion,
        goalTitle: r.goalTitle,
        runId: r.runId,
        runStatus,
        openEscalations: typeof r.openEscalations === "number" ? r.openEscalations : 0,
        ...(typeof r.detail === "string" && r.detail ? { detail: r.detail } : {}),
        ...(typeof r.cause === "string" && r.cause ? { cause: r.cause } : {}),
        ...parseEventSource(r.source),
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
    default:
      return null;
  }
}

/** Concise plain-text summary stored in `chat_turns.content` for history context and plain-text logs. */
export function formatChatEventSummary(event: ChatControlEvent): string {
  switch (event.kind) {
    case "goal.settled": {
      const head = `Goal ${event.goalId} v${event.goalVersion} ("${event.goalTitle}")`;
      const esc = event.openEscalations ? ` (${event.openEscalations} open escalation(s))` : "";
      if (event.runStatus === "completed") {
        const detail = event.detail?.trim();
        return `${head} run ${event.runId} completed${esc}${detail ? `: ${detail}` : ""}.`;
      }
      const recovery =
        `Nothing restarts automatically. Continue it in place with \`pi-harness resume ${event.runId}\`, ` +
        `inspect it with \`pi-harness tree ${event.runId}\`, or send a new request.`;
      const quotaReason = settledQuotaReason(event);
      if (quotaReason !== null) {
        return (
          `${head}: run ${event.runId} paused on provider quota: ${quotaReason}${esc}. No quota reset time is known, so it will not resume by itself. ` +
          `Continue it in place with \`pi-harness resume ${event.runId}\` once quota is back, inspect it with \`pi-harness tree ${event.runId}\`, or send a new request.`
        );
      }
      if (event.cause === "escalation") {
        return `${head}: run ${event.runId} needs human input: ${settledCauseText(event)}${esc}. Inspect it with \`pi-harness tree ${event.runId}\` and answer the escalation, or send a new request.`;
      }
      const verb = event.runStatus === "stopped" ? "was stopped" : "failed";
      return `${head}: run ${event.runId} ${verb}: ${settledCauseText(event)}${esc}. ${recovery}`;
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
      if (event.runStatus === "completed") {
        return [
          summary,
          `The autonomous run (${event.runId}) for Goal ${event.goalId} finished. Inspect/settle the goal with \`goal_trigger_review\` (using the appropriate \`verification_mode\` for this task) or report the outcome concisely to the user.`,
        ].join("\n");
      }
      const resume = `resume_run({ goal_id: "${event.goalId}" })`;
      const noCause = event.detail
        ? ""
        : ` No cause was recorded; inspect with run_status({ run_id: "${event.runId}" }) (operator: \`pi-harness tree ${event.runId}\`).`;
      let guidance: string;
      if (settledQuotaReason(event) !== null) {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} is paused on provider quota. Nothing was lost; paused tasks keep their worktrees and handoffs. ` +
          `It will not resume by itself because no quota reset time is known. Tell the user, then call ${resume} once quota is back (or schedule_timer with resume_goal). Do not create a new goal.`;
      } else if (event.runStatus === "stopped") {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} was explicitly stopped; this is not a failure and not a turn or budget limit. Do not restart it yourself. ` +
          `If the user asks to continue, call ${resume} or goal_commit; both continue the same run in place without creating a second run.${noCause}`;
      } else if (event.cause === "escalation") {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} raised an escalation that needs human input. Surface it to the user with actionable options; ` +
          `once it is resolved, ${resume} continues the same run in place.`;
      } else {
        guidance =
          `Run ${event.runId} for Goal ${event.goalId} failed. Inspect it with run_status({ goal_id: "${event.goalId}" }). ` +
          `If it is recoverable, ${resume} or resume_task for one task continues it in place; otherwise report the cause and options to the user.${noCause}`;
      }
      return [summary, guidance].join("\n");
    }
    case "timer.fired":
      return [
        summary,
        event.goalId
          ? `Your scheduled timer (${event.timerId}) for Goal ${event.goalId} has fired (${event.wakeReason}). Check live quota/models via \`list_models\` if needed and continue or resume the planned work.`
          : `Your scheduled timer (${event.timerId}) has fired (${event.wakeReason}). Continue the planned action or update the user concisely.`,
      ].join("\n");
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

/** The recorded cause, or an explicit notice that none was recorded naming the inspect command. */
function settledCauseText(event: Extract<ChatControlEvent, { kind: "goal.settled" }>): string {
  return event.detail?.trim() || `no cause was recorded; inspect with \`pi-harness tree ${event.runId}\``;
}
