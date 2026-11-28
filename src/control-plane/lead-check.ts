import { openPlanSteps, type ThreadPlan, type ThreadRequestRecord } from "./thread-state.js";

/**
 * The turn-end check for a lead thread: a turn that ends is not a goal that is done.
 *
 * When a lead ends its turn, the harness compares what the thread itself recorded (plan, triage, questions) and
 * what git and the task tree show (children, worktree, merge) with the goal. Anything still open reopens the turn
 * with the exact list. The lead may end with open items only while it waits on the user, or after the same list
 * came back unchanged `maxUnchangedChecks` times; that last case is recorded on the task so the Director and the
 * Done-Review see it.
 *
 * Pure: every input is passed in, so the decision is testable without a runner.
 */

export interface LeadTurnEndState {
  /** Its `delivery` decides whether the work must be on the base branch (`merge`, the default). */
  plan: ThreadPlan | null;
  /** Requests the Director forwarded that the lead has not triaged. */
  untriagedRequests: ReadonlyArray<Pick<ThreadRequestRecord, "id" | "title">>;
  /** Questions this lead asked the user that have no answer yet. */
  openQuestions: ReadonlyArray<Pick<ThreadRequestRecord, "id" | "title">>;
  liveChildren: ReadonlyArray<{ id: string; title: string; status: string }>;
  /** Null when the lead has no worktree (read-only lead, or not a git repository). */
  worktree: { branch: string; dirty: boolean; unmergedCommits: boolean; mergeStatus: string } | null;
  baseBranch: string;
  /** Required criteria of the linked goal, with the latest reported result for each. Empty without a goal. */
  criteria: ReadonlyArray<{ id: string; description: string; reported: "passed" | "failed" | "none" }>;
}

export interface LeadTurnEndVerdict {
  /** What is still open, one line each. Empty when the lead may end. */
  open: string[];
  /** True when the only thing holding the goal is an answer from the user. */
  waitingOnUser: boolean;
  /** Changes whenever the open list or the plan changes. */
  fingerprint: string;
}

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

export function evaluateLeadTurnEnd(state: LeadTurnEndState): LeadTurnEndVerdict {
  const open: string[] = [];

  for (const r of state.untriagedRequests) {
    open.push(`Request ${r.id} ("${clip(r.title, 80)}") is not triaged. Decide it with triage_request: accept, delegate, answer, or decline.`);
  }

  if (state.liveChildren.length > 0) {
    const names = state.liveChildren.slice(0, 6).map((c) => `${c.id} (${c.status})`).join(", ");
    const more = state.liveChildren.length > 6 ? ` and ${state.liveChildren.length - 6} more` : "";
    open.push(`Child tasks are still running: ${names}${more}. Wait for them with wait_children, or cancel the ones you no longer need.`);
  }

  const openSteps = openPlanSteps(state.plan);
  if (!state.plan) {
    open.push("No plan is recorded. Record your scope and steps with update_plan, including the steps already done.");
  } else if (openSteps.length > 0) {
    const names = openSteps.slice(0, 8).map((s) => `${s.id} (${clip(s.title, 60)})`).join("; ");
    const more = openSteps.length > 8 ? `; and ${openSteps.length - 8} more` : "";
    open.push(
      `Plan steps are not finished: ${names}${more}. Finish them, or update_plan: mark a step done, or dropped with the reason.`,
    );
  }

  const delivery = state.plan?.delivery ?? "merge";
  if (state.worktree) {
    if (state.worktree.dirty) {
      open.push(`Your worktree (branch ${state.worktree.branch}) has uncommitted changes. Commit them, or discard the ones you do not want.`);
    }
    if (delivery === "merge") {
      if (state.worktree.mergeStatus === "bounced") {
        open.push(
          `Your last submit_for_merge bounced. Merge or rebase ${state.baseBranch} into your branch, fix what failed, and submit again.`,
        );
      } else if (state.worktree.unmergedCommits && !state.worktree.dirty) {
        open.push(
          `Branch ${state.worktree.branch} has commits that are not on ${state.baseBranch}. Call submit_for_merge. If this work is not meant for ${state.baseBranch}, set delivery to "external" in update_plan and say where it went.`,
        );
      }
    }
  }

  // Criteria come last and only once the thread considers its own steps finished.
  const stepsFinished = Boolean(state.plan) && openSteps.length === 0;
  if (stepsFinished && state.liveChildren.length === 0) {
    const failed = state.criteria.filter((c) => c.reported === "failed");
    const unreported = state.criteria.filter((c) => c.reported === "none");
    if (failed.length > 0) {
      open.push(
        `Required criteria last reported as failing: ${failed.map((c) => c.id).join(", ")}. Fix them and report the new result with report_goal_progress.`,
      );
    }
    if (unreported.length > 0) {
      open.push(
        `Required criteria with no reported result: ${unreported
          .slice(0, 8)
          .map((c) => `${c.id} (${clip(c.description, 60)})`)
          .join("; ")}. Check each one and record the result and its evidence with report_goal_progress.`,
      );
    }
  }

  const waitingOnUser = state.openQuestions.length > 0;
  const fingerprint = JSON.stringify([open, state.plan?.revision ?? 0, state.openQuestions.map((q) => q.id)]);
  return { open, waitingOnUser, fingerprint };
}

/** The text that reopens the lead's turn. */
export function formatLeadTurnEndMessage(
  verdict: LeadTurnEndVerdict,
  ctx: { openQuestions: ReadonlyArray<Pick<ThreadRequestRecord, "id" | "title">>; checksLeft: number },
): string {
  const lines = [
    "[harness: turn-end check]",
    "Your turn ended, but the goal is not finished. Still open:",
    ...verdict.open.map((item) => `- ${item}`),
    "",
  ];
  if (verdict.waitingOnUser) {
    const ids = ctx.openQuestions.map((q) => q.id).join(", ");
    lines.push(
      `You are waiting on the user (${ids}). Do everything above that does not depend on the answer now. If all of it depends on the answer, end your turn again: the harness resumes you when the user answers.`,
    );
  } else {
    lines.push(
      "Keep working until the list is empty. If an item needs a decision only the user can make, ask it with ask_user and continue with what does not depend on the answer. If an item is outside this goal, send it back with route_to_director and drop the step. Do not end your turn to report progress.",
    );
  }
  if (ctx.checksLeft <= 1) {
    lines.push(
      "This is the last check for this list. If you end your turn again without changing it, the thread ends with these items recorded as unfinished.",
    );
  }
  return lines.join("\n");
}

/** Suffix recorded on the lead's summary when it ended with open items. */
export function formatUnfinishedSummary(open: readonly string[]): string {
  if (open.length === 0) return "";
  return `[Ended with ${open.length} open item${open.length === 1 ? "" : "s"}: ${open.map((o) => clip(o, 140)).join(" | ")}]`;
}
