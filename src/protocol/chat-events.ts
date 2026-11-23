/**
 * Typed control-plane events surfaced in the Director chat transcript and TUI.
 *
 * The TUI switches strictly on `event.kind` (never parsing string prefixes like `[Event]`).
 * Conversion to text happens only at the LLM prompt/history boundary via `formatChatEventForModel`
 * and `formatChatEventSummary`.
 */

export type ChatControlEvent =
  | {
      kind: "goal.settled";
      goalId: string;
      goalVersion: number;
      goalTitle: string;
      runId: string;
      runStatus: "completed" | "failed" | "stopped";
      openEscalations: number;
      detail?: string;
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
    }
  | {
      kind: "director.read_file";
      path: string;
      bytes: number;
      reason: string;
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
      };
    }
    case "director.read_file": {
      if (typeof r.path !== "string" || typeof r.bytes !== "number" || typeof r.reason !== "string") {
        return null;
      }
      return {
        kind: "director.read_file",
        path: r.path,
        bytes: r.bytes,
        reason: r.reason,
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
    case "goal.settled":
      return `Goal ${event.goalId} v${event.goalVersion} ("${event.goalTitle}") run ${event.runId} ${event.runStatus}${event.openEscalations ? ` (${event.openEscalations} open escalation(s))` : ""}.`;
    case "goal.committed":
      return `Goal ${event.goalId} v${event.goalVersion} started autonomous run ${event.runId} (${event.criteriaCount} criteria).`;
    case "goal.amended":
      return `Goal ${event.goalId} v${event.fromVersion}->v${event.toVersion} amended (${event.rationale}); stale reviews invalidated.`;
    case "goal.reviewed":
      return `Goal ${event.goalId} v${event.goalVersion} review #${event.cycle} (${event.status}): ${event.summary}`;
    case "director.read_file":
      return `Director read_file: ${event.path} (${event.bytes} bytes${event.offset && event.offset > 0 ? ` at offset ${event.offset}` : ""}). Reason: ${event.reason}`;
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
    case "goal.settled":
      return [
        summary,
        event.runStatus === "completed"
          ? `The autonomous run (${event.runId}) for Goal ${event.goalId} finished. Inspect/settle the goal with \`goal_trigger_review\` (using the appropriate \`verification_mode\` for this task) or report the outcome concisely to the user.`
          : `The autonomous run (${event.runId}) for Goal ${event.goalId} ended with status '${event.runStatus}'. Inspect the goal via \`goal_get\` and report the status, any blockers, and recommended next steps to the user.`,
      ].join("\n");
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
