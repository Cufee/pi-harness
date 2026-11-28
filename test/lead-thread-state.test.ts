import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { evaluateLeadTurnEnd, formatLeadTurnEndMessage, formatUnfinishedSummary, type LeadTurnEndState } from "../src/control-plane/lead-check.js";
import { parsePlanSteps, type ThreadPlan } from "../src/control-plane/thread-state.js";
import {
  collectDirectorOpenItems,
  formatDirectorOpenItemsBanner,
  formatWaitingOnUserFooter,
  shouldAppendWaitingFooter,
} from "../src/director/requests.js";

function plan(steps: Array<{ id: string; status: "pending" | "in_progress" | "done" | "dropped" }>, extra?: Partial<ThreadPlan>): ThreadPlan {
  return {
    taskId: "t-1",
    runId: "run-1",
    scope: "s",
    delivery: "merge",
    deliveryNote: null,
    steps: steps.map((s) => ({ id: s.id, title: `step ${s.id}`, status: s.status, owner: "self", criteria: [], note: s.status === "dropped" ? "why" : null })),
    revision: 1,
    updatedAt: 0,
    ...extra,
  };
}

const cleanState = (over: Partial<LeadTurnEndState>): LeadTurnEndState => ({
  plan: plan([{ id: "s1", status: "done" }]),
  untriagedRequests: [],
  openQuestions: [],
  liveChildren: [],
  worktree: { branch: "b", dirty: false, unmergedCommits: false, mergeStatus: "active" },
  baseBranch: "main",
  criteria: [],
  ...over,
});

describe("lead thread plan", () => {
  it("rejects a dropped step without a reason and a duplicate id, and defaults status and owner", () => {
    assert.throws(() => parsePlanSteps([{ title: "a", status: "dropped" }]), /dropped; say why/);
    assert.throws(() => parsePlanSteps([{ id: "x", title: "a" }, { id: "x", title: "b" }]), /used twice/);
    assert.throws(() => parsePlanSteps([]), /at least one step/);
    assert.throws(() => parsePlanSteps([{ title: "a", status: "finished" }]), /not one of/);
    const [first, second] = parsePlanSteps([{ title: "a" }, { title: "b", owner: "t-9", criteria: ["c2"], status: "done" }]);
    assert.deepEqual({ id: first!.id, status: first!.status, owner: first!.owner }, { id: "s1", status: "pending", owner: "self" });
    assert.deepEqual({ id: second!.id, owner: second!.owner, criteria: second!.criteria }, { id: "s2", owner: "t-9", criteria: ["c2"] });
  });

  it("keeps scope and delivery across step-only updates, bumps the revision, and requires a note for external delivery", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const first = db.threads.setPlan({ taskId: "t-1", runId: "run-1", scope: "only the parser", steps: parsePlanSteps([{ title: "a" }]) });
      assert.equal(first.revision, 1);
      assert.equal(first.delivery, "merge");
      const second = db.threads.setPlan({ taskId: "t-1", runId: "run-1", steps: parsePlanSteps([{ title: "a", status: "done" }]) });
      assert.equal(second.revision, 2);
      assert.equal(second.scope, "only the parser");
      assert.throws(
        () => db.threads.setPlan({ taskId: "t-1", runId: "run-1", delivery: "external", steps: second.steps }),
        /delivery_note/,
      );
      const third = db.threads.setPlan({ taskId: "t-1", runId: "run-1", delivery: "external", deliveryNote: "origin/feature", steps: second.steps });
      assert.equal(third.delivery, "external");
      assert.equal(db.threads.getPlan("t-2"), null);
    } finally {
      db.close();
    }
  });
});

describe("request ledger", () => {
  it("resolves a request once, only with an outcome of its own kind", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const question = db.threads.createRequest({ kind: "user_question", runId: "run-1", taskId: "t-1", chatSessionId: "chat-1", title: "Which?", body: "Which?" });
      assert.equal(question.status, "open");
      // "declined" belongs to a forwarded request, not to a question for the user.
      assert.throws(() => db.threads.resolveRequest(question.id, { outcome: "declined" }), /does not apply to a user_question/);
      const answered = db.threads.resolveRequest(question.id, { outcome: "user_answered", resolution: "the second" });
      assert.deepEqual([answered.status, answered.outcome, answered.resolution], ["resolved", "user_answered", "the second"]);
      assert.throws(() => db.threads.resolveRequest(question.id, { outcome: "withdrawn" }), /already resolved/);
      assert.throws(() => db.threads.resolveRequest("req-999", { outcome: "withdrawn" }), /Unknown request/);
      assert.deepEqual(db.threads.listRequests({ chatSessionId: "chat-1", status: "open" }), []);
    } finally {
      db.close();
    }
  });
});

describe("lead turn-end check", () => {
  it("lets a finished lead end and reopens the turn for each kind of open item", () => {
    assert.deepEqual(evaluateLeadTurnEnd(cleanState({})).open, []);

    const noPlan = evaluateLeadTurnEnd(cleanState({ plan: null }));
    assert.equal(noPlan.open.length, 1);
    assert.match(noPlan.open[0]!, /No plan is recorded/);

    const busy = evaluateLeadTurnEnd(
      cleanState({
        plan: plan([{ id: "s1", status: "done" }, { id: "s2", status: "in_progress" }, { id: "s3", status: "dropped" }]),
        untriagedRequests: [{ id: "req-4", title: "also add a flag" }],
        liveChildren: [{ id: "t-7", title: "scout", status: "running" }],
        worktree: { branch: "lead", dirty: true, unmergedCommits: true, mergeStatus: "active" },
      }),
    );
    const text = busy.open.join("\n");
    assert.match(text, /req-4.*triage_request/);
    assert.match(text, /t-7 \(running\).*wait_children/);
    // Only the open step is listed: done and dropped steps are finished.
    assert.match(text, /Plan steps are not finished: s2 /);
    assert.doesNotMatch(text, /s1|s3/);
    assert.match(text, /uncommitted changes/);
    // Unmerged commits are reported only once the tree is clean, so the lead is not told to merge a dirty tree.
    assert.doesNotMatch(text, /submit_for_merge/);
  });

  it("requires the work on the base branch only for merge delivery", () => {
    const unmerged = { branch: "lead", dirty: false, unmergedCommits: true, mergeStatus: "active" };
    const merge = evaluateLeadTurnEnd(cleanState({ worktree: unmerged }));
    assert.equal(merge.open.length, 1);
    assert.match(merge.open[0]!, /not on main.*submit_for_merge/);

    const external = evaluateLeadTurnEnd(
      cleanState({ worktree: unmerged, plan: plan([{ id: "s1", status: "done" }], { delivery: "external", deliveryNote: "origin/x" }) }),
    );
    assert.deepEqual(external.open, []);

    const bounced = evaluateLeadTurnEnd(cleanState({ worktree: { ...unmerged, mergeStatus: "bounced" } }));
    assert.match(bounced.open[0]!, /bounced/);
    // No worktree (read-only lead or no git): nothing about git is checked.
    assert.deepEqual(evaluateLeadTurnEnd(cleanState({ worktree: null })).open, []);
  });

  it("checks required criteria only after the lead's own steps are finished", () => {
    const criteria = [
      { id: "c1", description: "tests pass", reported: "passed" as const },
      { id: "c2", description: "docs updated", reported: "none" as const },
      { id: "c3", description: "no regressions", reported: "failed" as const },
    ];
    const midway = evaluateLeadTurnEnd(cleanState({ criteria, plan: plan([{ id: "s1", status: "pending" }]) }));
    assert.equal(midway.open.length, 1);
    assert.doesNotMatch(midway.open.join("\n"), /criteria/);

    const finished = evaluateLeadTurnEnd(cleanState({ criteria })).open.join("\n");
    assert.match(finished, /last reported as failing: c3\./);
    assert.match(finished, /no reported result: c2 \(docs updated\)\./);
    assert.doesNotMatch(finished, /c1/);
  });

  it("changes its fingerprint when the plan or the list changes, and marks a lead that waits on the user", () => {
    const a = evaluateLeadTurnEnd(cleanState({ plan: plan([{ id: "s1", status: "pending" }]) }));
    const sameAgain = evaluateLeadTurnEnd(cleanState({ plan: plan([{ id: "s1", status: "pending" }]) }));
    const revised = evaluateLeadTurnEnd(cleanState({ plan: plan([{ id: "s1", status: "pending" }], { revision: 2 }) }));
    assert.equal(a.fingerprint, sameAgain.fingerprint);
    assert.notEqual(a.fingerprint, revised.fingerprint);
    assert.equal(a.waitingOnUser, false);

    const waiting = evaluateLeadTurnEnd(
      cleanState({ plan: plan([{ id: "s1", status: "pending" }]), openQuestions: [{ id: "req-2", title: "Which provider?" }] }),
    );
    assert.equal(waiting.waitingOnUser, true);
    const message = formatLeadTurnEndMessage(waiting, { openQuestions: [{ id: "req-2", title: "Which provider?" }], checksLeft: 1 });
    assert.match(message, /waiting on the user \(req-2\)/);
    assert.match(message, /does not depend on the answer/);
    const pushing = formatLeadTurnEndMessage(a, { openQuestions: [], checksLeft: 3 });
    assert.match(pushing, /Keep working until the list is empty/);
    assert.doesNotMatch(pushing, /last check/);
    assert.match(formatLeadTurnEndMessage(a, { openQuestions: [], checksLeft: 1 }), /last check/);
    assert.equal(formatUnfinishedSummary([]), "");
    assert.match(formatUnfinishedSummary(a.open), /^\[Ended with 1 open item: Plan steps are not finished/);
  });
});

describe("director open items", () => {
  it("lists what waits on the user and re-asks on every reply to the user until it is answered", () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "g", repoRoot: "/tmp/x", baseBranch: "main", baseSha: "abc", chatSessionId: "chat-1" });
      const lead = db.createTask({ runId: run.id, tier: 1, kind: "orchestrator", title: "Lead", objective: "o", profileId: "p", readOnly: false });
      const goals = [{ id: "goal-1", linkedRunId: run.id, status: "executing" }];
      assert.equal(formatDirectorOpenItemsBanner(collectDirectorOpenItems(db, "chat-1", goals)), "");
      assert.equal(shouldAppendWaitingFooter(collectDirectorOpenItems(db, "chat-1", goals), { isUserTurn: true }), false);

      const question = db.threads.createRequest({
        kind: "user_question", runId: run.id, taskId: lead.id, chatSessionId: "chat-1", goalId: "goal-1",
        title: "Which provider?", body: "Which provider?\n\nOptions:\n1. A\n2. B",
      });
      const routed = db.threads.createRequest({
        kind: "routed_work", runId: run.id, taskId: lead.id, chatSessionId: "chat-1", goalId: "goal-1", title: "Fix the flaky CI job", body: "It fails 1 in 5.",
      });
      db.threads.createRequest({ kind: "user_question", runId: run.id, taskId: lead.id, chatSessionId: "chat-2", title: "Other chat", body: "Other chat" });
      db.createEscalation({
        runId: run.id, fromTaskId: lead.id, toTaskId: null, severity: "P0", category: "blocked_dependency",
        title: "Needs a production token", evidencePaths: ["README.md"], attempted: [], blocking: true,
      });
      db.createEscalation({
        runId: run.id, fromTaskId: lead.id, toTaskId: null, severity: "P0", category: "code_defect",
        title: "Informational only", evidencePaths: ["README.md"], attempted: [], blocking: false,
      });

      const items = collectDirectorOpenItems(db, "chat-1", goals);
      assert.deepEqual(items.questions.map((q) => q.id), [question.id]);
      assert.deepEqual(items.routed.map((r) => r.id), [routed.id]);
      assert.deepEqual(items.escalations.map((e) => e.title), ["Needs a production token"]);

      const banner = formatDirectorOpenItemsBanner(items);
      assert.match(banner, new RegExp(`${question.id} \\[goal-1, not shown to the user yet\\]`));
      assert.match(banner, /Routed back to you to place/);
      assert.doesNotMatch(banner, /Other chat|Informational only/);

      const footer = formatWaitingOnUserFooter(items);
      assert.match(footer, /^Waiting on you:\n- \[req-\d+, goal-1\] Which provider\?\n  Options:\n  1\. A\n  2\. B\n- \[esc-\d+, goal-1\] Needs a production token$/);
      // Routed work waits on the Director, not on the user, so it never appears in the footer.
      assert.doesNotMatch(footer, /flaky/);

      // A wake turn shows a question once; replies to the user show it every time.
      assert.equal(shouldAppendWaitingFooter(items, { isUserTurn: false }), true);
      db.threads.markPrompted([question.id]);
      const shown = collectDirectorOpenItems(db, "chat-1", goals);
      assert.equal(shown.questions[0]!.promptCount, 1);
      assert.equal(shouldAppendWaitingFooter(shown, { isUserTurn: false }), false);
      assert.equal(shouldAppendWaitingFooter(shown, { isUserTurn: true }), true);
      assert.match(formatDirectorOpenItemsBanner(shown), /shown to the user 1x/);

      db.threads.resolveRequest(question.id, { outcome: "user_answered", resolution: "B" });
      const after = collectDirectorOpenItems(db, "chat-1", goals);
      assert.deepEqual(after.questions, []);
      // The blocking escalation still waits on the user.
      assert.equal(shouldAppendWaitingFooter(after, { isUserTurn: true }), true);
      // A finished goal's escalations no longer wait on anyone.
      assert.deepEqual(collectDirectorOpenItems(db, "chat-1", [{ ...goals[0]!, status: "achieved" }]).escalations, []);
    } finally {
      db.close();
    }
  });
});
