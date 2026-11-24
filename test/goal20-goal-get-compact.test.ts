import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EscalationRecord, TaskRecord } from "../src/control-plane/db.js";
import type { RunActivitySummary } from "../src/control-plane/telemetry.js";
import {
  buildGoalGetResult,
  GOAL_GET_LIMITS,
  GOAL_GET_TOOL,
  parseGoalGetOptions,
  type GoalGetDetailInput,
} from "../src/director/goal-get.js";
import type { GoalCriterion, GoalRecord, GoalReviewVerdict } from "../src/goals/engine.js";

function makeSynthesizedDetail(opts: {
  repoRoot: string;
  descriptionChars?: number;
  criteriaCount?: number;
  criterionDescChars?: number;
  reviewsCount?: number;
  workerTaskCount?: number;
  goalVersion?: number;
  includeStaleReview?: boolean;
}): GoalGetDetailInput {
  const descriptionChars = opts.descriptionChars ?? 40_000;
  const criteriaCount = opts.criteriaCount ?? 18;
  const criterionDescChars = opts.criterionDescChars ?? 400;
  const reviewsCount = opts.reviewsCount ?? 12;
  const workerTaskCount = opts.workerTaskCount ?? 40;
  const goalVersion = opts.goalVersion ?? 3;

  const description = Array.from({ length: Math.ceil(descriptionChars / 50) }, (_, i) =>
    `Line ${String(i).padStart(4, "0")}: specification text for goal twenty. `.padEnd(50, "x"),
  )
    .join("")
    .slice(0, descriptionChars);

  const criteria: GoalCriterion[] = Array.from({ length: criteriaCount }, (_, i) => ({
    id: `c${i + 1}`,
    description: `Criterion ${i + 1} detailed requirement `.padEnd(criterionDescChars, "d"),
    kind: i % 3 === 0 ? "deterministic" : i % 3 === 1 ? "behavioral" : "architectural",
    command: i % 3 === 0 ? `bun test test/suite-${i + 1}.test.ts --verbose `.padEnd(150, "a") : undefined,
    required: i < 15,
  }));

  const goal: GoalRecord = {
    id: "goal-20",
    chatSessionId: "chat-1",
    repoRoot: opts.repoRoot,
    version: goalVersion,
    title: "Director visibility and compact goal_get",
    description,
    criteria,
    nonGoals: Array.from({ length: 12 }, (_, i) => `Non-goal ${i + 1}: `.padEnd(250, "n")),
    budgets: { maxReviewCycles: 50, maxNoProgressCycles: 5 },
    verificationMode: "auto",
    verifyRef: "main",
    liveProgress: {
      phase: "implementing",
      summary: "Working through criteria ".padEnd(700, "p"),
      verificationStatus: "in_progress",
      criteriaResults: criteria.map((c, i) => ({
        criterionId: c.id,
        passed: i % 2 === 0,
        evidence: "Live evidence ".padEnd(500, "l"),
      })),
      updatedAt: 50_000,
    },
    status: "executing",
    linkedRunId: "run-20",
    reviewCycle: reviewsCount,
    noProgressStreak: 1,
    lastProgressFingerprint: "fp-12",
    lastReviewSummary: "Latest review summary ".padEnd(2_000, "s"),
    createdAt: 1_000,
    updatedAt: 60_000,
  };

  // Stored in ascending cycle order, matching GoalEngine.listReviews().
  const reviews: GoalReviewVerdict[] = [];
  if (opts.includeStaleReview) {
    reviews.push({
      id: "rev-0",
      goalId: goal.id,
      goalVersion: goalVersion - 1,
      cycle: 0,
      verdict: "changes_requested",
      criteriaResults: criteria.map((c) => ({
        criterionId: c.id,
        passed: true,
        evidence: "Stale evidence from old version",
      })),
      blockingIssues: ["Old version issue"],
      summary: "Stale review from previous version",
      progressFingerprint: "fp-0",
      createdAt: 5_000,
      source: "review",
    });
  }
  for (let cycle = 1; cycle <= reviewsCount; cycle++) {
    reviews.push({
      id: `rev-${cycle}`,
      goalId: goal.id,
      goalVersion,
      cycle,
      verdict: "changes_requested",
      criteriaResults: criteria
        // Leave last criterion unevaluated in all current-version reviews when testing all 3 statuses.
        .filter((_, idx) => !(opts.includeStaleReview && idx === criteriaCount - 1))
        .map((c, idx) => ({
          criterionId: c.id,
          passed: (idx + cycle) % 2 === 0,
          evidence: `Cycle ${cycle} evidence for ${c.id}: `.padEnd(1_500, "e"),
          remediation: (idx + cycle) % 2 === 1 ? `Fix ${c.id} in cycle ${cycle}: `.padEnd(400, "r") : undefined,
          gate:
            c.kind === "deterministic"
              ? { cwd: "/tmp/verify", ref: "main", sha: "abc1234", isolated: true, source: "run_base_branch" }
              : undefined,
        })),
      blockingIssues: Array.from({ length: 15 }, (_, bi) => `Blocking issue ${cycle}.${bi + 1}: `.padEnd(400, "b")),
      summary: `Review cycle ${cycle} summary: `.padEnd(3_000, "m"),
      progressFingerprint: `fp-${cycle}`,
      createdAt: 10_000 + cycle * 1_000,
      source: "review",
    });
  }

  const tasks: TaskRecord[] = [
    {
      id: "t-1",
      runId: "run-20",
      parentId: null,
      tier: 1,
      kind: "orchestrator",
      title: "Orchestrator: Goal goal-20",
      objective: "Orchestrate",
      criteria: "",
      readOnly: true,
      profileId: "p1",
      model: "anthropic/claude-opus-5-5",
      effort: "high",
      status: "running",
      generation: 1,
      maxTurns: 50,
      turnsUsed: 5,
      contextUsed: 10_000,
      contextSize: 200_000,
      worktreeId: null,
      sessionId: null,
      summary: "Coordinating workers ".padEnd(2_000, "o"),
      handoffJson: null,
      resultJson: null,
      goalVersion,
      createdAt: 10_000,
      updatedAt: 55_000,
    },
    ...Array.from({ length: workerTaskCount }, (_, i): TaskRecord => ({
      id: `t-${i + 2}`,
      runId: "run-20",
      parentId: "t-1",
      tier: 2,
      kind: "worker",
      title: `Worker slice ${i + 1}: `.padEnd(160, "w"),
      objective: "Implement slice",
      criteria: "",
      readOnly: false,
      profileId: "p1",
      model: "google/gemini-4-neon",
      effort: "medium",
      status: i < 2 ? "running" : "completed",
      generation: 1,
      maxTurns: 30,
      turnsUsed: 12,
      contextUsed: 20_000,
      contextSize: 200_000,
      worktreeId: `wt-${i + 2}`,
      sessionId: null,
      summary: `Worker ${i + 1} handoff summary: `.padEnd(2_000, "t"),
      handoffJson: null,
      resultJson: null,
      goalVersion: i === 0 ? goalVersion - 1 : goalVersion,
      createdAt: 11_000 + i * 100,
      updatedAt: 20_000 + i * 100,
    })),
  ];

  const openEscalations: EscalationRecord[] = [
    {
      id: "esc-1",
      runId: "run-20",
      fromTaskId: "t-1",
      toTaskId: null,
      severity: "P0",
      category: "ambiguous_spec",
      title: "Confirm deployment target ".padEnd(260, "q"),
      evidencePaths: [".harness/artifacts/a.md"],
      attempted: ["Checked docs"],
      suggestedSplits: [],
      blocking: true,
      status: "open",
      resolution: null,
      createdAt: 40_000,
      ackedAt: null,
    },
  ];

  const activity: RunActivitySummary = {
    runId: "run-20",
    phase: "implementing",
    elapsedMs: 50_000,
    filesEdited: 12,
    openEscalations: 1,
    modelsUsed: ["anthropic/claude-opus-5-5", "google/gemini-4-neon"],
    counts: {
      total: tasks.length,
      running: 3,
      completed: workerTaskCount - 2,
      failed: 0,
      verifyRunning: 0,
      verifyCompleted: 0,
    },
    tasks: tasks.map((t) => ({
      id: t.id,
      parentId: t.parentId,
      tier: t.tier,
      kind: t.kind,
      title: t.title,
      status: t.status,
      model: t.model,
      effort: t.effort,
      profileId: t.profileId,
      generation: t.generation,
      goalVersion: t.goalVersion,
      lastAmendmentAction: t.id === "t-2" ? "queued" : null,
      currentAction: `Running step for ${t.id}: `.padEnd(200, "c"),
      toolCalls: 10,
      filesEdited: 2,
      elapsedMs: 5_000,
      ctxPct: 35,
    })),
  };

  return { goal, reviews, tasks, openEscalations, activity };
}

describe("buildGoalGetResult compact output and paging", () => {
  it("fits a large goal (40k desc, 18 criteria, 12 big reviews, 41 tasks) under 40k chars and writes full description file", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-get-"));
    try {
      const evidenceDir = join(tmpRepo, ".harness", "goals", "goal-20");
      const detail = makeSynthesizedDetail({ repoRoot: tmpRepo, includeStaleReview: true });
      const res = buildGoalGetResult(detail, parseGoalGetOptions({}), { evidenceDir, repoRoot: tmpRepo });

      const jsonLen = JSON.stringify(res).length;
      assert.ok(jsonLen < 50_000, `expected < 50000 chars, got ${jsonLen}`);
      assert.ok(jsonLen <= GOAL_GET_LIMITS.budgetChars, `expected <= 40000 chars, got ${jsonLen}`);

      // Criteria: all 18 ids with valid status; last criterion is not_evaluated despite stale v2 review passing it.
      const criteria = res.criteria as Array<{ id: string; status: string; evaluatedInCycle: number | null }>;
      assert.deepEqual(
        criteria.map((c) => c.id),
        detail.goal.criteria.map((c) => c.id),
      );
      for (const c of criteria) {
        assert.ok(c.status === "passed" || c.status === "failed" || c.status === "not_evaluated");
      }
      assert.equal(criteria[17]!.status, "not_evaluated");
      assert.equal(criteria[17]!.evaluatedInCycle, null);

      // Reviews: newest first, cycle 12 with criteriaResults, reviewsPage accurate (12 + 1 stale = 13 total).
      const reviews = res.reviews as Array<{ cycle: number; criteriaResults?: unknown[]; stale: boolean }>;
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]!.cycle, 12);
      assert.equal(reviews[0]!.stale, false);
      assert.equal(reviews[0]!.criteriaResults?.length, 17);
      assert.deepEqual(res.reviewsPage, { total: 13, returned: 1, nextBeforeCycle: 12 });

      // Goal description excerpt + repo-relative file containing exact full description.
      const goalOut = res.goal as {
        description: { chars: number; excerpt: string; path: string | null; more?: string };
      };
      assert.equal(goalOut.description.chars, 40_000);
      assert.equal(goalOut.description.path, ".harness/goals/goal-20/goal-description-v3.md");
      const fullPath = join(tmpRepo, goalOut.description.path!);
      assert.equal(readFileSync(fullPath, "utf8"), detail.goal.description);

      // Re-running skips rewriting when byte length matches.
      const mtimeBefore = statSync(fullPath).mtimeMs;
      buildGoalGetResult(detail, parseGoalGetOptions({}), { evidenceDir, repoRoot: tmpRepo });
      assert.equal(statSync(fullPath).mtimeMs, mtimeBefore);

      // Tasks capped and include goalVersion/staleGoalVersion.
      const tasks = res.tasks as Array<{ id: string; goalVersion: number | null; staleGoalVersion: boolean }>;
      assert.ok(tasks.length <= GOAL_GET_LIMITS.tasksMax);
      assert.equal((res.tasksPage as { total: number }).total, 41);
      const staleTask = tasks.find((t) => t.id === "t-2");
      assert.ok(staleTask, "active stale worker t-2 should be prioritized in tasks");
      assert.equal(staleTask!.goalVersion, 2);
      assert.equal(staleTask!.staleGoalVersion, true);

      // When evidenceDir is null, path is null and more points to description section.
      const noEvRes = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["goal"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      const noEvDesc = (noEvRes.goal as { description: { path: string | null; more?: string } }).description;
      assert.equal(noEvDesc.path, null);
      assert.match(noEvDesc.more ?? "", /sections:\['description'\]/);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("pages older reviews with reviews_before_cycle and reviews_limit (only newest returned includes criteriaResults)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-page-"));
    try {
      const detail = makeSynthesizedDetail({ repoRoot: tmpRepo });
      // Default single call checks reviewsPage = { total: 12, returned: 1, nextBeforeCycle: 12 }.
      const first = buildGoalGetResult(detail, parseGoalGetOptions({}), { evidenceDir: null, repoRoot: tmpRepo });
      assert.deepEqual(first.reviewsPage, { total: 12, returned: 1, nextBeforeCycle: 12 });
      assert.equal((first.reviews as Array<{ criteriaResults?: unknown[] }>)[0]!.criteriaResults?.length, 18);

      // Page 5 older reviews before cycle 12.
      const opts = parseGoalGetOptions({ reviews_before_cycle: 12, reviews_limit: 5 });
      const res = buildGoalGetResult(detail, opts, { evidenceDir: null, repoRoot: tmpRepo });
      const reviews = res.reviews as Array<{
        cycle: number;
        criteriaResults?: unknown[];
        passedCount?: number;
        failedCount?: number;
        failedCriteria?: string[];
      }>;
      assert.deepEqual(
        reviews.map((r) => r.cycle),
        [11, 10, 9, 8, 7],
      );
      assert.equal(reviews[0]!.criteriaResults?.length, 18);
      for (const older of reviews.slice(1)) {
        assert.equal(older.criteriaResults, undefined);
        assert.equal((older.passedCount ?? 0) + (older.failedCount ?? 0), 18);
        assert.equal(older.failedCriteria?.length, older.failedCount);
      }
      assert.deepEqual(res.reviewsPage, { total: 12, returned: 5, nextBeforeCycle: 7 });
      assert.ok(JSON.stringify(res).length <= GOAL_GET_LIMITS.budgetChars);

      // Clamp reviews_limit to [1, 10].
      assert.equal(parseGoalGetOptions({ reviews_limit: 0 }).reviewsLimit, 1);
      assert.equal(parseGoalGetOptions({ reviews_limit: 99 }).reviewsLimit, 10);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("pages the full description when sections includes description and omits unrequested sections", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-desc-"));
    try {
      const detail = makeSynthesizedDetail({ repoRoot: tmpRepo });
      const page1 = buildGoalGetResult(
        detail,
        parseGoalGetOptions({ sections: ["description"], description_offset: -50 }),
        { evidenceDir: null, repoRoot: tmpRepo },
      );
      assert.deepEqual(page1.descriptionPage, {
        offset: 0,
        text: detail.goal.description.slice(0, 30_000),
        chars: 40_000,
        nextOffset: 30_000,
      });

      const page2 = buildGoalGetResult(
        detail,
        parseGoalGetOptions({ sections: ["description"], description_offset: 30_000 }),
        { evidenceDir: null, repoRoot: tmpRepo },
      );
      assert.deepEqual(page2.descriptionPage, {
        offset: 30_000,
        text: detail.goal.description.slice(30_000),
        chars: 40_000,
        nextOffset: null,
      });
      assert.equal((page2.descriptionPage as { text: string }).text.length, 10_000);
      assert.equal("criteria" in page2, false);
      assert.equal("reviews" in page2, false);
      assert.equal("tasks" in page2, false);
      assert.equal("openEscalations" in page2, false);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("filters sections cleanly and throws on unknown sections listing allowed values", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-sec-"));
    try {
      const detail = makeSynthesizedDetail({ repoRoot: tmpRepo });
      const res = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["criteria"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      assert.deepEqual(res.goal, {
        id: detail.goal.id,
        version: detail.goal.version,
        title: detail.goal.title,
        status: detail.goal.status,
      });
      assert.equal((res.criteria as unknown[]).length, 18);
      assert.equal("reviews" in res, false);
      assert.equal("tasks" in res, false);
      assert.equal("openEscalations" in res, false);
      assert.equal("descriptionPage" in res, false);

      assert.throws(
        () => parseGoalGetOptions({ sections: ["bogus"] }),
        /goal.*description.*criteria.*reviews.*run.*escalations/,
      );
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("applies the shrink ladder for 150 tasks + 18 huge criteria while preserving never-dropped fields", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-shrink-"));
    try {
      const detail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        workerTaskCount: 150,
        criteriaCount: 18,
        criterionDescChars: 2_000,
        reviewsCount: 12,
      });
      const res = buildGoalGetResult(detail, parseGoalGetOptions({}), { evidenceDir: null, repoRoot: tmpRepo });
      const size = JSON.stringify(res).length;
      assert.ok(size <= GOAL_GET_LIMITS.budgetChars, `expected <= 40000 chars, got ${size}`);

      const truncated = res.truncated as string[];
      assert.ok(truncated.length > 0, "expected shrink ladder to record at least one truncation step");

      // Never-dropped invariants.
      const goalHeader = res.goal as { id: string; version: number; title: string; status: string };
      assert.equal(goalHeader.id, "goal-20");
      assert.equal(goalHeader.version, 3);
      assert.equal(goalHeader.status, "executing");

      const criteria = res.criteria as Array<{ id: string; status: string }>;
      assert.deepEqual(
        criteria.map((c) => c.id),
        detail.goal.criteria.map((c) => c.id),
      );
      assert.ok(criteria.every((c) => c.status === "passed" || c.status === "failed" || c.status === "not_evaluated"));

      const latestReview = (res.reviews as Array<{
        cycle: number;
        verdict: string;
        summary: string;
        criteriaResults: Array<{ criterionId: string; passed: boolean }>;
      }>)[0]!;
      assert.equal(latestReview.cycle, 12);
      assert.equal(latestReview.verdict, "changes_requested");
      assert.ok(latestReview.summary.length >= 300);
      assert.equal(latestReview.criteriaResults.length, 18);

      const escalations = res.openEscalations as Array<{ id: string }>;
      assert.deepEqual(
        escalations.map((e) => e.id),
        ["esc-1"],
      );
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("exports GOAL_GET_TOOL with presentation_id wording and paging schema", () => {
    assert.equal(GOAL_GET_TOOL.name, "goal_get");
    assert.match(GOAL_GET_TOOL.description, /presentation_id to present_result/);
    const props = (GOAL_GET_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok("goal_id" in props);
    assert.ok("sections" in props);
    assert.ok("reviews_limit" in props);
    assert.ok("reviews_before_cycle" in props);
    assert.ok("description_offset" in props);
  });
});
