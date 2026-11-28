import type { ControlPlaneDb, EscalationRecord } from "../control-plane/db.js";
import type { ThreadRequestRecord } from "../control-plane/thread-state.js";

/**
 * What a Director chat still owes someone, read from the request ledger and the escalation table.
 *
 * The Director is the only agent that talks to the user, so the harness, not the model's memory, keeps the list of
 * what waits on the user. Every Director turn sees the list, and every reply to the user ends with what is still
 * unanswered (`formatWaitingOnUserFooter`), so a question cannot be relayed once and then forgotten.
 */
export interface DirectorOpenItems {
  /** Questions lead threads asked the user. */
  questions: ThreadRequestRecord[];
  /** Blocking escalations addressed to the human on this chat's goal runs. */
  escalations: Array<Pick<EscalationRecord, "id" | "title" | "severity" | "category" | "runId"> & { goalId: string | null }>;
  /** Work lead threads sent back for the Director to reschedule or drop. */
  routed: ThreadRequestRecord[];
  /** Requests the Director forwarded that a lead has not triaged yet. */
  forwarded: ThreadRequestRecord[];
}

export function collectDirectorOpenItems(
  db: ControlPlaneDb,
  chatSessionId: string,
  goals: ReadonlyArray<{ id: string; linkedRunId?: string | null; status: string }>,
): DirectorOpenItems {
  const open = db.threads.listRequests({ chatSessionId, status: "open" });
  const escalations: DirectorOpenItems["escalations"] = [];
  for (const goal of goals) {
    if (!goal.linkedRunId || goal.status === "achieved" || goal.status === "cancelled") continue;
    let rows: EscalationRecord[] = [];
    try {
      rows = db.listEscalations(goal.linkedRunId, "open");
    } catch {
      rows = [];
    }
    for (const e of rows) {
      if (e.toTaskId === null && e.blocking) {
        escalations.push({ id: e.id, title: e.title, severity: e.severity, category: e.category, runId: e.runId, goalId: goal.id });
      }
    }
  }
  return {
    questions: open.filter((r) => r.kind === "user_question"),
    escalations,
    routed: open.filter((r) => r.kind === "routed_work"),
    forwarded: open.filter((r) => r.kind === "user_request"),
  };
}

const flat = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
};

const origin = (r: { goalId: string | null; runId: string }): string => r.goalId ?? r.runId;

/** The open-items block of a Director turn prompt, or "" when nothing is open. */
export function formatDirectorOpenItemsBanner(items: DirectorOpenItems): string {
  const lines: string[] = [];
  if (items.questions.length > 0 || items.escalations.length > 0) {
    lines.push(
      "Waiting on the user (the harness appends these to your reply, so do not repeat them word for word; when the user's message answers one, close it first):",
    );
    for (const q of items.questions) {
      const asked = q.promptCount > 0 ? `, shown to the user ${q.promptCount}x` : ", not shown to the user yet";
      lines.push(`- ${q.id} [${origin(q)}${asked}]: ${flat(q.body, 600)} -> resolve_request({ request_id: "${q.id}", outcome: "user_answered", note })`);
    }
    for (const e of items.escalations) {
      lines.push(`- ${e.id} [${e.goalId ?? e.runId}, ${e.severity} ${e.category}]: ${flat(e.title, 300)} -> resolve_escalation({ escalation_id: "${e.id}", reason })`);
    }
  }
  if (items.routed.length > 0) {
    lines.push("Routed back to you to place (create or amend a goal, or ask the user; then resolve_request with rescheduled or dropped):");
    for (const r of items.routed) lines.push(`- ${r.id} [from ${origin(r)}]: ${flat(r.title, 160)} — ${flat(r.body, 400)}`);
  }
  if (items.forwarded.length > 0) {
    lines.push("Forwarded to lead threads, not triaged yet (nothing to do; you are woken when a lead answers or declines):");
    for (const r of items.forwarded) lines.push(`- ${r.id} [to ${origin(r)}]: ${flat(r.title, 160)}`);
  }
  return lines.length > 0 ? `Open requests:\n${lines.join("\n")}` : "";
}

/**
 * The block appended to a Director reply while something waits on the user, or "" when nothing does.
 * Deterministic: it does not depend on the model remembering to ask again.
 */
export function formatWaitingOnUserFooter(items: Pick<DirectorOpenItems, "questions" | "escalations">): string {
  if (items.questions.length === 0 && items.escalations.length === 0) return "";
  const lines = ["Waiting on you:"];
  for (const q of items.questions) {
    const body = q.body.trim().split("\n").map((l) => l.trimEnd());
    lines.push(`- [${q.id}, ${origin(q)}] ${body[0] ?? q.title}`);
    for (const extra of body.slice(1)) if (extra.trim()) lines.push(`  ${extra}`);
  }
  for (const e of items.escalations) {
    lines.push(`- [${e.id}, ${e.goalId ?? e.runId}] ${flat(e.title, 300)}`);
  }
  return lines.join("\n");
}

/** Whether this reply should carry the footer: always on a reply to the user, otherwise only for something not shown yet. */
export function shouldAppendWaitingFooter(
  items: Pick<DirectorOpenItems, "questions" | "escalations">,
  turn: { isUserTurn: boolean },
): boolean {
  if (items.questions.length === 0 && items.escalations.length === 0) return false;
  return turn.isUserTurn || items.questions.some((q) => q.promptCount === 0);
}

/** The steering or resume text that hands a forwarded user request to a lead thread. */
export function formatForwardedRequest(request: Pick<ThreadRequestRecord, "id" | "body">): string {
  return [
    `[Request ${request.id} from the user, forwarded by the Director]`,
    "<user_request>",
    request.body,
    "</user_request>",
    `Decide it before you continue with triage_request({ request_id: "${request.id}", decision, note }): accept it and amend your plan, delegate it to a child task, answer it, or decline it as outside this goal.`,
  ].join("\n");
}

/** The steering or resume text that delivers the user's answer to the lead that asked. */
export function formatUserAnswer(request: Pick<ThreadRequestRecord, "id" | "title">, answer: string): string {
  return [
    `[The user answered your question ${request.id}]`,
    `Question: ${flat(request.title, 400)}`,
    "<user_answer>",
    answer.trim(),
    "</user_answer>",
    "Continue with the work that waited on it, and amend your plan if the answer changes it.",
  ].join("\n");
}
