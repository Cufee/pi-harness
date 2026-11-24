import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import type { EscalationRecord } from "../src/control-plane/db.js";
import {
  buildGateActivityEvent,
  detectGitPush,
  goalGateState,
  looksLikeGitPush,
} from "../src/director/gate-activity.js";
import type { GoalRecord } from "../src/goals/engine.js";
import {
  coalesceGoalEvents,
  formatChatEventForModel,
  formatChatEventSummary,
  isGoalLifecycleEvent,
  parseChatControlEvent,
  type GoalLifecycleChatEvent,
} from "../src/protocol/chat-events.js";

function makeGoal(status: GoalRecord["status"]): GoalRecord {
  return {
    id: "goal-1",
    chatSessionId: "chat-1",
    repoRoot: "/tmp/repo",
    version: 8,
    title: "Ship feature X",
    description: "Description",
    criteria: [],
    nonGoals: [],
    budgets: { maxReviewCycles: 5, maxNoProgressCycles: 3 },
    status,
    linkedRunId: "run-1",
    reviewCycle: 2,
    noProgressStreak: 0,
    lastProgressFingerprint: null,
    lastReviewSummary: null,
    createdAt: 1_000,
    updatedAt: 2_000,
  };
}

function makeEscalation(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: "esc-1",
    runId: "run-1",
    fromTaskId: "t-1",
    toTaskId: null,
    severity: "P0",
    category: "ambiguous_spec",
    title: "Need decision on API shape",
    evidencePaths: [],
    attempted: [],
    suggestedSplits: [],
    blocking: true,
    status: "open",
    resolution: null,
    createdAt: 1_000,
    ackedAt: null,
    ...overrides,
  };
}

describe("detectGitPush and looksLikeGitPush", () => {
  it("extracts remote URL, ref updates, and confirmed=true from standard git push output", () => {
    const cmd = "git push origin HEAD:refs/heads/main";
    const out = "To https://github.com/x/y.git\n   e38b213..a3328cf  HEAD -> main";
    assert.equal(looksLikeGitPush(cmd), true);
    const detected = detectGitPush(cmd, out);
    assert.deepEqual(detected, {
      command: "git push origin HEAD:refs/heads/main",
      remote: "https://github.com/x/y.git",
      refs: ["e38b213..a3328cf HEAD -> main"],
      confirmed: true,
    });
  });

  it("matches global options (-C) and [new branch] ref updates", () => {
    const cmd = "git -C /w push -u origin feat";
    const out = " * [new branch]      feat -> feat";
    assert.equal(looksLikeGitPush(cmd), true);
    const detected = detectGitPush(cmd, out);
    assert.deepEqual(detected, {
      command: "git -C /w push -u origin feat",
      remote: "origin",
      refs: ["[new branch] feat -> feat"],
      confirmed: true,
    });
  });

  it("matches chained commands and JSON-encoded tool args", () => {
    assert.equal(looksLikeGitPush("bun test && git push"), true);
    const chained = detectGitPush("bun test && git push", "To origin\n   1111111..2222222  main -> main");
    assert.deepEqual(chained, {
      command: "git push",
      remote: "origin",
      refs: ["1111111..2222222 main -> main"],
      confirmed: true,
    });

    const jsonArgs = JSON.stringify({ command: "git push origin main" });
    assert.equal(looksLikeGitPush(jsonArgs), true);
    const fromJson = detectGitPush(
      `Bash\n${jsonArgs}`,
      JSON.stringify({ stderr: "To origin\n   abc1234..def5678  main -> main" }),
    );
    assert.deepEqual(fromJson, {
      command: "git push origin main",
      remote: "origin",
      refs: ["abc1234..def5678 main -> main"],
      confirmed: true,
    });
  });

  it("rejects non-push git subcommands and dry-runs", () => {
    for (const cmd of [
      "git stash push -m x",
      "git log --grep push",
      "git push --dry-run origin main",
      "git push -n origin main",
    ]) {
      assert.equal(looksLikeGitPush(cmd), false, `expected looksLikeGitPush false for: ${cmd}`);
      assert.equal(detectGitPush(cmd, "To origin\n   abc..def  main -> main"), null, `expected null for: ${cmd}`);
    }
  });

  it("returns null when output indicates nothing was pushed", () => {
    assert.equal(detectGitPush("git push origin main", "Everything up-to-date\n"), null);
    assert.equal(
      detectGitPush(
        "git push origin main",
        "To origin\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'origin'",
      ),
      null,
    );
    assert.equal(detectGitPush("git push origin main", "fatal: could not read Username"), null);
  });

  it("returns confirmed=false when result output is missing or truncated without ref lines", () => {
    const missing = detectGitPush("git push origin main", undefined);
    assert.deepEqual(missing, {
      command: "git push origin main",
      remote: "origin",
      refs: [],
      confirmed: false,
    });

    const partial = detectGitPush("git push origin main", "Enumerating objects: 5, done.");
    assert.deepEqual(partial, {
      command: "git push origin main",
      remote: "origin",
      refs: [],
      confirmed: false,
    });
  });
});

describe("goalGateState", () => {
  it("returns awaiting_human when goal status is awaiting_human (taking precedence over blocking_escalation)", () => {
    const esc = makeEscalation({ id: "esc-2", createdAt: 2_000 });
    assert.deepEqual(goalGateState(makeGoal("awaiting_human"), []), {
      gate: "awaiting_human",
      escalations: [],
    });
    assert.deepEqual(goalGateState(makeGoal("awaiting_human"), [esc]), {
      gate: "awaiting_human",
      escalations: [esc],
    });
  });

  it("returns blocking_escalation for unresolved blocking human-routed escalations, newest first", () => {
    const older = makeEscalation({ id: "esc-old", status: "open", createdAt: 1_000 });
    const newer = makeEscalation({ id: "esc-new", status: "acked", createdAt: 3_000 });
    const res = goalGateState(makeGoal("executing"), [older, newer]);
    assert.deepEqual(res, {
      gate: "blocking_escalation",
      escalations: [newer, older],
    });
  });

  it("returns null for task-routed, non-blocking, resolved escalations, and terminal goals", () => {
    assert.equal(
      goalGateState(makeGoal("executing"), [makeEscalation({ toTaskId: "t-1", blocking: true, status: "open" })]),
      null,
    );
    assert.equal(
      goalGateState(makeGoal("executing"), [makeEscalation({ toTaskId: null, blocking: false, status: "open" })]),
      null,
    );
    assert.equal(
      goalGateState(makeGoal("executing"), [makeEscalation({ toTaskId: null, blocking: true, status: "resolved" })]),
      null,
    );
    assert.equal(goalGateState(makeGoal("achieved"), [makeEscalation()]), null);
    assert.equal(goalGateState(makeGoal("cancelled"), [makeEscalation()]), null);
  });
});

describe("goal.gate_activity chat event parsing, coalescing, and formatting", () => {
  it("builds and round-trips worker_spawned and remote_push events and rejects invalid values", () => {
    const goal = makeGoal("awaiting_human");
    const gate = goalGateState(goal, [
      makeEscalation({ id: "esc-1", createdAt: 1 }),
      makeEscalation({ id: "esc-2", createdAt: 2 }),
      makeEscalation({ id: "esc-3", createdAt: 3 }),
      makeEscalation({ id: "esc-4", createdAt: 4 }),
      makeEscalation({ id: "esc-5", createdAt: 5 }),
      makeEscalation({ id: "esc-6", createdAt: 6 }),
    ])!;

    const spawnEv = buildGateActivityEvent(goal, gate, "worker_spawned", {
      runId: "run-1",
      taskId: "t-130",
      taskTier: 2,
      title: "X".repeat(220),
    });
    assert.equal(spawnEv.escalationIds.length, 5);
    assert.equal(spawnEv.escalationIds[0], "esc-6");
    assert.equal(spawnEv.openBlockingEscalations, 6);
    assert.equal(spawnEv.title?.length, 160);
    assert.equal(isGoalLifecycleEvent(spawnEv), true);
    assert.deepEqual(parseChatControlEvent(JSON.parse(JSON.stringify(spawnEv))), spawnEv);

    const pushEv = buildGateActivityEvent(goal, gate, "remote_push", {
      runId: "run-1",
      taskId: "t-130",
      taskTier: 2,
      command: "git push origin HEAD:refs/heads/main",
      remote: "origin",
      refs: ["e38b213..a3328cf HEAD -> main"],
      confirmed: true,
    });
    assert.deepEqual(parseChatControlEvent(JSON.parse(JSON.stringify(pushEv))), pushEv);

    // Reject bad activity / gate / missing fields.
    assert.equal(parseChatControlEvent({ ...pushEv, activity: "bogus_activity" }), null);
    assert.equal(parseChatControlEvent({ ...pushEv, gate: "other_gate" }), null);
    assert.equal(parseChatControlEvent({ ...pushEv, taskTier: "2" }), null);
    assert.equal(parseChatControlEvent({ ...pushEv, taskId: 123 }), null);

    // Round-trips inside goal.events_batch.
    const batch = parseChatControlEvent({ kind: "goal.events_batch", events: [spawnEv, pushEv] });
    assert.deepEqual(batch, { kind: "goal.events_batch", events: [spawnEv, pushEv] });
  });

  it("coalesceGoalEvents keeps distinct pushes from different tasks and collapses exact duplicates", () => {
    const goal = makeGoal("awaiting_human");
    const gate = { gate: "awaiting_human" as const, escalations: [] };
    const push1 = buildGateActivityEvent(goal, gate, "remote_push", {
      runId: "run-1",
      taskId: "t-10",
      taskTier: 2,
      command: "git push origin main",
      remote: "origin",
      refs: ["aaa..bbb main -> main"],
      confirmed: true,
    });
    const push2 = buildGateActivityEvent(goal, gate, "remote_push", {
      runId: "run-1",
      taskId: "t-11",
      taskTier: 2,
      command: "git push origin main",
      remote: "origin",
      refs: ["bbb..ccc main -> main"],
      confirmed: true,
    });
    const spawn1 = buildGateActivityEvent(goal, gate, "worker_spawned", {
      runId: "run-1",
      taskId: "t-12",
      taskTier: 2,
      title: "Fix tests",
    });

    const coalesced = coalesceGoalEvents([push1, push2, push1, spawn1] as GoalLifecycleChatEvent[]);
    assert.equal(coalesced.length, 3);
    assert.deepEqual(
      coalesced.map((e) => (e.kind === "goal.gate_activity" ? `${e.activity}:${e.taskId}` : e.kind)),
      ["remote_push:t-11", "remote_push:t-10", "worker_spawned:t-12"],
    );
  });

  it("formats summary and model prompt text with steer/pause/inspect guidance", () => {
    const goal = makeGoal("awaiting_human");
    const gate = { gate: "awaiting_human" as const, escalations: [] };
    const spawnEv = buildGateActivityEvent(goal, gate, "worker_spawned", {
      runId: "run-1",
      taskId: "t-130",
      taskTier: 2,
      title: "Refactor auth",
    });
    const spawnSummary = formatChatEventSummary(spawnEv);
    assert.match(spawnSummary, /Goal goal-1 v8 is awaiting_human, but run run-1 spawned worker t-130 \("Refactor auth"\)\./);

    const pushEv = buildGateActivityEvent(goal, gate, "remote_push", {
      runId: "run-1",
      taskId: "t-130",
      taskTier: 2,
      command: "git push origin HEAD:refs/heads/main",
      remote: "origin",
      refs: ["e38b213..a3328cf HEAD -> main"],
      confirmed: true,
    });
    const pushSummary = formatChatEventSummary(pushEv);
    assert.match(
      pushSummary,
      /Goal goal-1 v8 is awaiting_human, but task t-130 pushed to origin: e38b213\.\.a3328cf HEAD -> main\./,
    );

    const modelText = formatChatEventForModel(pushEv);
    assert.match(modelText, /steer_task/);
    assert.match(modelText, /steer_run/);
    assert.match(modelText, /goal_pause/);
    assert.match(modelText, /goal_get\(\{ goal_id: "goal-1" \}\)/);
  });
});
