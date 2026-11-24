import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EscalationRecord, TaskRecord } from "../src/control-plane/db.js";
import type { RunActivitySummary } from "../src/control-plane/telemetry.js";
import {
  buildGoalGetResult,
  buildGoalListResult,
  GOAL_GET_LIMITS,
  GOAL_GET_SECTIONS,
  GOAL_GET_TOOL,
  GOAL_LIST_LIMITS,
  GOAL_LIST_TOOL,
  parseGoalGetOptions,
  parseGoalListOptions,
  type GoalGetDetailInput,
  type GoalListSummaryInput,
} from "../src/director/goal-get.js";
import type { GoalCriterion, GoalRecord, GoalReviewVerdict, GoalStatus } from "../src/goals/engine.js";
import { serializeToolResult } from "../src/runners/mcp-bridge.js";

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
              ? {
                  cwd: "/tmp/verify",
                  ref: "main",
                  sha: "abc1234",
                  isolated: true,
                  source: "run_base_branch",
                  note: "Verified in detached worktree",
                }
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
      const res = buildGoalGetResult(detail, parseGoalGetOptions({}), {
        evidenceDir,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });

      const wireLen = serializeToolResult({ ...res, presentation_id: "00000000-0000-0000-0000-000000000001" }).length;
      assert.ok(wireLen < 50_000, `expected < 50000 chars, got ${wireLen}`);
      assert.ok(wireLen <= GOAL_GET_LIMITS.budgetChars, `expected <= 40000 wire chars, got ${wireLen}`);

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
      const reviews = res.reviews as Array<{ id: string; cycle: number; criteriaResults?: unknown[]; stale: boolean }>;
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0]!.cycle, 12);
      assert.equal(reviews[0]!.stale, false);
      assert.equal(reviews[0]!.criteriaResults?.length, 17);
      assert.deepEqual(res.reviewsPage, { total: 13, returned: 1, nextBefore: "rev-12" });

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

  it("pages older reviews with reviews_before cursor and reviews_limit (only newest returned includes criteriaResults)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-page-"));
    try {
      const detail = makeSynthesizedDetail({ repoRoot: tmpRepo });
      // Default single call checks reviewsPage = { total: 12, returned: 1, nextBefore: "rev-12" }.
      const first = buildGoalGetResult(detail, parseGoalGetOptions({}), { evidenceDir: null, repoRoot: tmpRepo });
      assert.deepEqual(first.reviewsPage, { total: 12, returned: 1, nextBefore: "rev-12" });
      assert.equal((first.reviews as Array<{ criteriaResults?: unknown[] }>)[0]!.criteriaResults?.length, 18);

      // Page 5 older reviews before rev-12.
      const opts = parseGoalGetOptions({ reviews_before: "rev-12", reviews_limit: 5 });
      const res = buildGoalGetResult(detail, opts, { evidenceDir: null, repoRoot: tmpRepo });
      const reviews = res.reviews as Array<{
        id: string;
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
      assert.deepEqual(res.reviewsPage, { total: 12, returned: 5, nextBefore: "rev-7" });
      assert.ok(JSON.stringify(res).length <= GOAL_GET_LIMITS.budgetChars);

      // Clamp reviews_limit to [1, 10].
      assert.equal(parseGoalGetOptions({ reviews_limit: 0 }).reviewsLimit, 1);
      assert.equal(parseGoalGetOptions({ reviews_limit: 99 }).reviewsLimit, 10);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("orders and pages multi-version reviews after amendment without skipping equal-cycle reviews (P1-a)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-ver-"));
    try {
      const detail = makeSynthesizedDetail({ repoRoot: tmpRepo, goalVersion: 2, reviewsCount: 0, criteriaCount: 2 });
      detail.goal.reviewCycle = 2;
      const makeRev = (id: string, goalVersion: number, cycle: number, createdAt: number): GoalReviewVerdict => ({
        id,
        goalId: detail.goal.id,
        goalVersion,
        cycle,
        verdict: "changes_requested",
        criteriaResults: [{ criterionId: "c1", passed: true, evidence: `v${goalVersion}c${cycle}` }],
        blockingIssues: [],
        summary: `Review v${goalVersion}c${cycle}`,
        progressFingerprint: `fp-${id}`,
        createdAt,
        source: "review",
      });
      // Unordered input mixing v1c1, v1c11, v2c1, v2c2 (note v1c11 has higher cycle than v2c1, and v1c1 == v2c1 cycle).
      detail.reviews = [
        makeRev("rev-v1c1", 1, 1, 1_000),
        makeRev("rev-v1c11", 1, 11, 2_000),
        makeRev("rev-v2c1", 2, 1, 3_000),
        makeRev("rev-v2c2", 2, 2, 4_000),
      ];

      // Walk 1 review at a time using reviewsPage.nextBefore and assert exact total order with zero skipped items.
      const walked: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 6; i++) {
        const res = buildGoalGetResult(
          detail,
          parseGoalGetOptions({ sections: ["reviews"], reviews_limit: 1, ...(cursor ? { reviews_before: cursor } : {}) }),
          { evidenceDir: null, repoRoot: tmpRepo },
        );
        const revs = res.reviews as Array<{ id: string }>;
        for (const r of revs) walked.push(r.id);
        const page = res.reviewsPage as { total: number; returned: number; nextBefore: string | null };
        assert.equal(page.total, 4);
        cursor = page.nextBefore;
        if (!cursor) break;
      }
      assert.deepEqual(walked, ["rev-v2c2", "rev-v2c1", "rev-v1c11", "rev-v1c1"]);
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

  it("exports GOAL_GET_TOOL with presentation_id wording, cursor paging schema, and accurate handoff guidance", () => {
    assert.equal(GOAL_GET_TOOL.name, "goal_get");
    assert.match(GOAL_GET_TOOL.description, /presentation_id to present_result/);
    assert.doesNotMatch(GOAL_GET_TOOL.description, /Full task handoffs:\s*run_status/);
    assert.match(GOAL_GET_TOOL.description, /artifactPaths/);
    const props = (GOAL_GET_TOOL.inputSchema as { properties: Record<string, unknown> }).properties;
    assert.ok("goal_id" in props);
    assert.ok("sections" in props);
    assert.ok("reviews_limit" in props);
    assert.ok("reviews_before" in props);
    assert.ok(!("reviews_before_cycle" in props));
    assert.ok("description_offset" in props);
    assert.ok("criteria_offset" in props);
    assert.match(GOAL_GET_TOOL.description, /criteria_offset/);
    assert.match(GOAL_GET_TOOL.description, /recentlyResolvedEscalations/);
  });

  it("bounds wire JSON <= 40,000 chars for 150 open escalations, huge diagnostics, and quote/newline-heavy descriptions (P1-b)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-bound-"));
    try {
      const detail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 40_000,
        criteriaCount: 18,
        reviewsCount: 12,
        workerTaskCount: 40,
      });
      detail.openEscalations = Array.from({ length: 150 }, (_, i) => ({
        id: `esc-${i + 1}`,
        runId: "run-20",
        fromTaskId: "t-1",
        toTaskId: null,
        severity: "P0" as const,
        category: "ambiguous_spec" as const,
        title: `Escalation ${i + 1}: `.padEnd(200, "E"),
        evidencePaths: [],
        attempted: [],
        suggestedSplits: [],
        blocking: true,
        status: "open" as const,
        resolution: null,
        createdAt: 10_000 + i,
        ackedAt: null,
      }));
      const bigDiag = {
        reviewerTaskId: "t-rev",
        runId: "run-20",
        profileId: "p1",
        model: "openai/gpt-6.2-astra",
        attempts: 2,
        stopReason: "submitted" as const,
        contextPct: 42,
        turnsUsed: 4,
        attemptFailures: ["failure ".repeat(100)],
        rawOutputPaths: [".harness/goals/goal-20/raw.txt"],
        transcript: "T".repeat(30_000),
        goalVersion: detail.goal.version,
        at: 50_000,
      };
      detail.goal.lastReviewerFailure = bigDiag;
      detail.reviews[detail.reviews.length - 1]!.diagnostics = bigDiag;

      const res = buildGoalGetResult(detail, parseGoalGetOptions({}), { evidenceDir: null, repoRoot: tmpRepo });
      const size = JSON.stringify(res).length;
      assert.ok(size <= GOAL_GET_LIMITS.budgetChars, `expected <= 40000 chars with 150 escalations + big diagnostics, got ${size}`);
      const escPage = res.escalationsPage as { total: number; returned: number; omitted: number };
      assert.equal(escPage.total, 150);
      assert.ok(escPage.returned <= GOAL_GET_LIMITS.escalationsMax);
      assert.equal(escPage.omitted, 150 - escPage.returned);
      const criteria = res.criteria as Array<{ id: string; status: string }>;
      assert.equal(criteria.length, 18);

      // Quote/newline-heavy 30,000-char description: every page <= 40,000 JSON chars and walking nextOffset reconstructs verbatim.
      const escapedHeavy = '"\n'.repeat(15_000);
      assert.equal(escapedHeavy.length, 30_000);
      detail.goal.description = escapedHeavy;
      let rebuilt = "";
      let offset: number | null = 0;
      let pages = 0;
      while (offset !== null) {
        const pageRes = buildGoalGetResult(
          detail,
          parseGoalGetOptions({ sections: ["description"], description_offset: offset }),
          { evidenceDir: null, repoRoot: tmpRepo },
        );
        const pageJsonLen = JSON.stringify(pageRes).length;
        assert.ok(pageJsonLen <= GOAL_GET_LIMITS.budgetChars, `description page ${pages} exceeded 40k: ${pageJsonLen}`);
        const dp = pageRes.descriptionPage as { offset: number; text: string; chars: number; nextOffset: number | null };
        assert.equal(dp.offset, offset);
        assert.equal(dp.chars, 30_000);
        rebuilt += dp.text;
        offset = dp.nextOffset;
        pages++;
        assert.ok(pages <= 5, "should complete in a few pages");
      }
      assert.equal(rebuilt, escapedHeavy);
      assert.ok(pages >= 2, "quote/newline-heavy 30k text must split across >=2 pages to stay under JSON budget");
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("returns unclipped criteria and latest review fields for narrow explicit sections while within budget (P2-f)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-unclip-"));
    try {
      const detail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        criteriaCount: 3,
        criterionDescChars: 600,
        reviewsCount: 2,
        workerTaskCount: 2,
      });
      detail.goal.criteria[0]!.command = "bun test " + "--flag ".repeat(45); // > 200 chars
      detail.tasks[1]!.resultJson = JSON.stringify({
        summary: "Full worker summary: " + "W".repeat(500),
        artifact_paths: [".harness/artifacts/run-20/t-2/report.md"],
      });

      const critRes = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["criteria"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      assert.deepEqual(critRes.truncated, []);
      const crit0 = (critRes.criteria as Array<{ description: string; command?: string; evidence?: string }>)[0]!;
      assert.equal(crit0.description, detail.goal.criteria[0]!.description);
      assert.equal(crit0.command, detail.goal.criteria[0]!.command);
      assert.equal(crit0.evidence, detail.reviews[1]!.criteriaResults[0]!.evidence);

      const revRes = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["reviews"], reviews_limit: 1 }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      assert.deepEqual(revRes.truncated, []);
      const rev0 = (revRes.reviews as Array<{
        summary: string;
        blockingIssues: string[];
        criteriaResults: Array<{
          evidence?: string;
          remediation?: string;
          gate?: { cwd: string; ref: string; sha: string; isolated: boolean; source: string; note?: string };
        }>;
      }>)[0]!;
      assert.equal(rev0.summary, detail.reviews[1]!.summary);
      assert.deepEqual(rev0.blockingIssues, detail.reviews[1]!.blockingIssues);
      assert.equal(rev0.criteriaResults[0]!.evidence, detail.reviews[1]!.criteriaResults[0]!.evidence);
      assert.equal(rev0.criteriaResults[1]!.remediation, detail.reviews[1]!.criteriaResults[1]!.remediation);
      // P2: gate provenance includes cwd, ref, sha, isolated, source, and note (matching goal_create docs).
      assert.deepEqual(rev0.criteriaResults[0]!.gate, {
        cwd: "/tmp/verify",
        ref: "main",
        sha: "abc1234",
        isolated: true,
        source: "run_base_branch",
        note: "Verified in detached worktree",
      });

      // Default (non-narrow) goal_get also retains gate cwd/ref/sha/isolated/source/note when within budget.
      const defaultRes = buildGoalGetResult(detail, parseGoalGetOptions({}), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      const defaultRev0 = (defaultRes.reviews as typeof revRes.reviews as Array<{
        criteriaResults: Array<{
          gate?: { cwd: string; ref: string; sha: string; isolated: boolean; source: string; note?: string };
        }>;
      }>)[0]!;
      assert.deepEqual(defaultRev0.criteriaResults[0]!.gate, {
        cwd: "/tmp/verify",
        ref: "main",
        sha: "abc1234",
        isolated: true,
        source: "run_base_branch",
        note: "Verified in detached worktree",
      });

      const runRes = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["run"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      const workerOut = (runRes.tasks as Array<{ id: string; summary: string | null; artifactPaths?: string[] }>).find(
        (t) => t.id === "t-2",
      )!;
      assert.deepEqual(workerOut.artifactPaths, [".harness/artifacts/run-20/t-2/report.md"]);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("bounds serializeToolResult (indented MCP/ACP wire format) <= 40,000 chars for the 30-task/3-artifact re-review fixture (P1)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-p1-wire-"));
    try {
      const detail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 40_000,
        criteriaCount: 18,
        reviewsCount: 12,
        workerTaskCount: 29,
      });
      // Match re-review fixture: short review evidence, 116-char task summaries, 3 artifact paths per task.
      for (const rev of detail.reviews) {
        for (const cr of rev.criteriaResults) {
          cr.evidence = `ok ${cr.criterionId}`;
          cr.remediation = undefined;
        }
      }
      for (const t of detail.tasks) {
        t.resultJson = JSON.stringify({
          summary: `Task ${t.id} completed cleanly `.padEnd(116, "x"),
          artifact_paths: [
            `.harness/artifacts/run-20/${t.id}/plan.md`,
            `.harness/artifacts/run-20/${t.id}/report.md`,
            `.harness/artifacts/run-20/${t.id}/verify.md`,
          ],
        });
      }
      const res = buildGoalGetResult(detail, parseGoalGetOptions({}), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      const wire = serializeToolResult({ ...res, presentation_id: "00000000-0000-0000-0000-000000000001" });
      assert.ok(wire.length <= GOAL_GET_LIMITS.budgetChars, `expected wire <= 40,000 chars, got ${wire.length}`);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("clips oversized verifyRef/header scalars before dropping rows and preserves/pages large criterion lists (P2)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-p2-scalars-"));
    try {
      const presId = "00000000-0000-0000-0000-000000000001";

      // 1. 51,000-char verifyRef (even with zero criteria/reviews/tasks) must stay <= 40,000 wire chars.
      const emptyDetail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 500,
        criteriaCount: 0,
        reviewsCount: 0,
        workerTaskCount: 0,
      });
      emptyDetail.goal.verifyRef = "r".repeat(51_000);
      emptyDetail.goal.title = "t".repeat(51_000);
      emptyDetail.goal.liveProgress = {
        phase: "p".repeat(51_000),
        summary: "ok",
        updatedAt: 50_000,
      };
      const emptyRes = buildGoalGetResult(emptyDetail, parseGoalGetOptions({}), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      const emptyWire = serializeToolResult({ ...emptyRes, presentation_id: presId });
      assert.ok(emptyWire.length <= GOAL_GET_LIMITS.budgetChars, `expected <= 40,000 wire chars, got ${emptyWire.length}`);
      assert.ok((emptyRes.truncated as string[]).includes("goal.header"));
      const emptyGoal = emptyRes.goal as { verifyRef: string; title: string };
      assert.ok(emptyGoal.verifyRef.length <= 240);
      assert.ok(emptyGoal.title.length <= 240);

      // 2. 51,000-char verifyRef on a normal goal clips the header WITHOUT dropping criteria or tasks.
      const normalDetail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 500,
        criteriaCount: 5,
        criterionDescChars: 60,
        reviewsCount: 1,
        workerTaskCount: 3,
      });
      normalDetail.goal.verifyRef = "v".repeat(51_000);
      normalDetail.reviews[0]!.criteriaResults[0]!.gate = {
        cwd: "/tmp/verify",
        ref: "v".repeat(51_000),
        sha: "abc1234",
        isolated: true,
        source: "verify_ref",
      };
      const normalRes = buildGoalGetResult(normalDetail, parseGoalGetOptions({}), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      assert.ok(serializeToolResult({ ...normalRes, presentation_id: presId }).length <= GOAL_GET_LIMITS.budgetChars);
      assert.equal((normalRes.criteria as unknown[]).length, 5);
      assert.equal((normalRes.tasks as unknown[]).length, 4);

      // 3. 340 short criteria: ALL 340 IDs + statuses survive in one response via compact {id, status} floor.
      const detail340 = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 200,
        criteriaCount: 340,
        criterionDescChars: 30,
        reviewsCount: 1,
        workerTaskCount: 0,
      });
      const res340 = buildGoalGetResult(detail340, parseGoalGetOptions({}), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      const wire340 = serializeToolResult({ ...res340, presentation_id: presId });
      assert.ok(wire340.length <= GOAL_GET_LIMITS.budgetChars, `expected 340 criteria <= 40,000 wire chars, got ${wire340.length}`);
      const crit340 = res340.criteria as Array<{ id: string; status: string }>;
      assert.equal(crit340.length, 340);
      assert.deepEqual(
        crit340.map((c) => c.id),
        detail340.goal.criteria.map((c) => c.id),
      );
      assert.deepEqual(res340.criteriaPage, {
        offset: 0,
        total: 340,
        returned: 340,
        omitted: 0,
        nextOffset: null,
      });

      // 4. 900 short criteria (exceeding 40k even in minimal {id, status} form): pages cleanly via criteria_offset + criteriaPage.nextOffset.
      const detail900 = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 200,
        criteriaCount: 900,
        criterionDescChars: 20,
        reviewsCount: 0,
        workerTaskCount: 0,
      });
      const seenCritIds = new Set<string>();
      let cOffset: number | null = 0;
      let cPages = 0;
      while (cOffset !== null) {
        const pageRes = buildGoalGetResult(
          detail900,
          parseGoalGetOptions({ sections: ["criteria"], criteria_offset: cOffset }),
          { evidenceDir: null, repoRoot: tmpRepo, reserveChars: 120 },
        );
        const pageWire = serializeToolResult({ ...pageRes, presentation_id: presId });
        assert.ok(pageWire.length <= GOAL_GET_LIMITS.budgetChars, `criteria page ${cPages} exceeded 40k: ${pageWire.length}`);
        const cp = pageRes.criteriaPage as {
          offset: number;
          total: number;
          returned: number;
          omitted: number;
          nextOffset: number | null;
        };
        assert.equal(cp.offset, cOffset);
        assert.equal(cp.total, 900);
        const items = pageRes.criteria as Array<{ id: string; status: string }>;
        assert.equal(items.length, cp.returned);
        for (const item of items) {
          assert.ok(!seenCritIds.has(item.id), `duplicate criterion id ${item.id}`);
          seenCritIds.add(item.id);
          assert.ok(["passed", "failed", "not_evaluated"].includes(item.status));
        }
        cOffset = cp.nextOffset;
        cPages++;
        assert.ok(cPages <= 10, "900 criteria paging must converge");
      }
      assert.ok(cPages >= 2, "900 criteria should span >= 2 pages under 40k wire budget");
      assert.equal(seenCritIds.size, 900);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("marks tasks with null goalVersion as stale on amended goals (v2+) and current on v1 (P2-g)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-nullver-"));
    try {
      const detailV1 = makeSynthesizedDetail({ repoRoot: tmpRepo, goalVersion: 1, workerTaskCount: 1, reviewsCount: 0 });
      detailV1.tasks[1]!.goalVersion = null;
      const resV1 = buildGoalGetResult(detailV1, parseGoalGetOptions({ sections: ["run"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      const taskV1 = (resV1.tasks as Array<{ id: string; goalVersion: number | null; staleGoalVersion: boolean }>).find(
        (t) => t.id === "t-2",
      )!;
      assert.equal(taskV1.goalVersion, null);
      assert.equal(taskV1.staleGoalVersion, false);

      const detailV2 = makeSynthesizedDetail({ repoRoot: tmpRepo, goalVersion: 2, workerTaskCount: 1, reviewsCount: 0 });
      detailV2.tasks[1]!.goalVersion = null;
      const resV2 = buildGoalGetResult(detailV2, parseGoalGetOptions({ sections: ["run"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
      });
      const taskV2 = (resV2.tasks as Array<{ id: string; goalVersion: number | null; staleGoalVersion: boolean }>).find(
        (t) => t.id === "t-2",
      )!;
      assert.equal(taskV2.goalVersion, null);
      assert.equal(taskV2.staleGoalVersion, true);
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  it("includes capped escalation history with status, clipped resolution, resolvedAt, and omitted count (v3 escalation-history)", () => {
    const tmpRepo = mkdtempSync(join(tmpdir(), "pi-harness-goal20-eschist-"));
    try {
      const presId = "00000000-0000-0000-0000-000000000001";
      const detail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 1_000,
        criteriaCount: 4,
        reviewsCount: 1,
        workerTaskCount: 1,
      });
      // Add an acked escalation alongside the open one.
      detail.openEscalations.push({
        id: "esc-acked",
        runId: "run-20",
        fromTaskId: "t-2",
        toTaskId: "t-1",
        severity: "P1",
        category: "code_defect",
        title: "Acked defect",
        evidencePaths: [],
        attempted: [],
        suggestedSplits: [],
        blocking: false,
        status: "acked",
        resolution: "Acknowledged note: ".padEnd(400, "a"),
        createdAt: 4_000,
        ackedAt: 4_500,
      });
      // 14 resolved escalations (input has newest 12 or full 14, total = 14); default caps to newest 10 with omitted: 4.
      const longResolution = "Resolved via goal_accept override: ".padEnd(500, "z");
      detail.recentlyResolvedEscalations = Array.from({ length: 12 }, (_, i) => ({
        id: `esc-res-${i + 1}`,
        fromTaskId: "t-1",
        severity: i % 2 === 0 ? "P0" : "P1",
        category: "verification_failed",
        title: `Resolved issue ${i + 1}`,
        resolution: i === 11 ? longResolution : `Fixed item ${i + 1}`,
        resolvedAt: 10_000 + i * 1_000,
      }));
      detail.resolvedEscalationsTotal = 14;

      // 1. Default compact goal_get: newest 10 resolved, status/resolution/resolvedAt present, resolution clipped, omitted = 4.
      const compact = buildGoalGetResult(detail, parseGoalGetOptions({}), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      assert.ok(serializeToolResult({ ...compact, presentation_id: presId }).length <= GOAL_GET_LIMITS.budgetChars);
      const compactOpen = compact.openEscalations as Array<{
        id: string;
        status: string;
        resolution?: string;
        ackedAt?: number;
      }>;
      const ackedEntry = compactOpen.find((e) => e.id === "esc-acked")!;
      assert.equal(ackedEntry.status, "acked");
      assert.equal(ackedEntry.ackedAt, 4_500);
      assert.ok(ackedEntry.resolution && ackedEntry.resolution.length <= GOAL_GET_LIMITS.escalationResolution);

      const compactResolved = compact.recentlyResolvedEscalations as Array<{
        id: string;
        status: string;
        resolution: string;
        resolvedAt: number | null;
      }>;
      assert.equal(compactResolved.length, 10);
      assert.equal(compactResolved[0]!.id, "esc-res-12");
      assert.equal(compactResolved[0]!.status, "resolved");
      assert.equal(compactResolved[0]!.resolvedAt, 21_000);
      assert.ok(compactResolved[0]!.resolution.length <= GOAL_GET_LIMITS.escalationResolution);
      assert.equal(compactResolved[9]!.id, "esc-res-3");
      assert.deepEqual(compact.recentlyResolvedEscalationsPage, { total: 14, returned: 10, omitted: 4 });

      // 2. Full sections form includes escalation history too.
      const full = buildGoalGetResult(detail, parseGoalGetOptions({ sections: [...GOAL_GET_SECTIONS] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      assert.ok(serializeToolResult({ ...full, presentation_id: presId }).length <= GOAL_GET_LIMITS.budgetChars);
      assert.equal((full.recentlyResolvedEscalations as unknown[]).length, 10);
      assert.deepEqual(full.recentlyResolvedEscalationsPage, { total: 14, returned: 10, omitted: 4 });

      // 3. Narrow sections: ['escalations'] returns unclipped resolution when within budget.
      const narrow = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["escalations"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      const narrowResolved = narrow.recentlyResolvedEscalations as Array<{ id: string; resolution: string }>;
      assert.equal(narrowResolved[0]!.resolution, longResolution);

      // 4. Adversarial huge resolutions stay strictly <= 40,000 wire chars.
      const hugeDetail = makeSynthesizedDetail({
        repoRoot: tmpRepo,
        descriptionChars: 1_000,
        criteriaCount: 2,
        reviewsCount: 0,
        workerTaskCount: 0,
      });
      hugeDetail.recentlyResolvedEscalations = Array.from({ length: 10 }, (_, i) => ({
        id: `esc-huge-${i + 1}`,
        fromTaskId: "t-1",
        severity: "P0",
        category: "verification_failed",
        title: `Huge ${i + 1}: `.padEnd(6_000, "t"),
        resolution: `Resolution ${i + 1}: `.padEnd(10_000, "r"),
        resolvedAt: 20_000 + i * 100,
      }));
      const hugeNarrow = buildGoalGetResult(hugeDetail, parseGoalGetOptions({ sections: ["escalations"] }), {
        evidenceDir: null,
        repoRoot: tmpRepo,
        reserveChars: 120,
      });
      const hugeWire = serializeToolResult({ ...hugeNarrow, presentation_id: presId });
      assert.ok(hugeWire.length <= GOAL_GET_LIMITS.budgetChars, `expected <= 40,000 wire chars, got ${hugeWire.length}`);
      assert.ok((hugeNarrow.truncated as string[]).includes("escalations.compact"));
    } finally {
      rmSync(tmpRepo, { recursive: true, force: true });
    }
  });
});

describe("goal-20 compact goal_list", () => {
  function makeGoalSummary(
    idx: number,
    opts?: {
      status?: GoalStatus;
      version?: number;
      title?: string;
      updatedAt?: number;
      openEscalations?: number;
      reviews?: GoalReviewVerdict[];
    },
  ): GoalListSummaryInput {
    const version = opts?.version ?? (idx % 2) + 1;
    const id = `goal-${String(idx).padStart(3, "0")}`;
    const reviews: GoalReviewVerdict[] = opts?.reviews ?? [
      {
        id: `rev-${idx}-v1-c3`,
        goalId: id,
        goalVersion: 1,
        cycle: 3,
        verdict: "changes_requested",
        criteriaResults: [],
        blockingIssues: ["old blocking issue".padEnd(400, "x")],
        summary: "Old v1 review ".padEnd(1_000, "r"),
        progressFingerprint: `fp-${idx}-1`,
        createdAt: 1_700_000_000_000 + idx * 100,
      },
      {
        id: `rev-${idx}-v${version}-c1`,
        goalId: id,
        goalVersion: version,
        cycle: 1,
        verdict: idx % 3 === 0 ? "approved" : "changes_requested",
        criteriaResults: [],
        blockingIssues: [],
        summary: "Latest review ".padEnd(1_000, "l"),
        progressFingerprint: `fp-${idx}-2`,
        createdAt: 1_700_000_100_000 + idx * 100,
      },
    ];
    const goal: GoalRecord = {
      id,
      chatSessionId: "chat-1",
      repoRoot: "/tmp/repo",
      version,
      title: opts?.title ?? `Goal ${idx}: ` + "T".repeat(220),
      description: `Huge description for ${id} `.padEnd(40_000, "D"),
      criteria: [
        { id: "c1", description: "Criterion ".padEnd(500, "c"), kind: "behavioral", required: true },
      ],
      nonGoals: ["non-goal".padEnd(300, "n")],
      budgets: { maxReviewCycles: 10, maxNoProgressCycles: 3 },
      verificationMode: "auto",
      verifyRef: "main",
      liveProgress: null,
      status: opts?.status ?? "executing",
      linkedRunId: `run-${idx}`,
      reviewCycle: reviews.length,
      noProgressStreak: 0,
      lastProgressFingerprint: null,
      lastReviewSummary: "Very long review summary ".padEnd(2_000, "s"),
      lastReviewerFailure: null,
      createdAt: 1_700_000_000_000,
      updatedAt: opts?.updatedAt ?? 1_700_000_000_000 + idx * 1_000,
    };
    return {
      goal,
      openEscalations: opts?.openEscalations ?? (idx % 4),
      reviews,
    };
  }

  it("GOAL_LIST_TOOL documents compact default, filters, paging, and goal_get", () => {
    assert.equal(GOAL_LIST_TOOL.name, "goal_list");
    assert.match(GOAL_LIST_TOOL.description, /compact/i);
    assert.match(GOAL_LIST_TOOL.description, /status/i);
    assert.match(GOAL_LIST_TOOL.description, /default 30.*max 100/i);
    assert.match(GOAL_LIST_TOOL.description, /page\.nextCursor/);
    assert.match(GOAL_LIST_TOOL.description, /use goal_get for full detail/i);
    assert.match(GOAL_LIST_TOOL.description, /presentation_id to present_result/);

    assert.deepEqual(parseGoalListOptions({}), {
      allProjects: false,
      status: null,
      limit: GOAL_LIST_LIMITS.limitDefault,
      cursor: null,
    });
    assert.equal(parseGoalListOptions({ limit: 0 }).limit, 1);
    assert.equal(parseGoalListOptions({ limit: 500 }).limit, GOAL_LIST_LIMITS.limitMax);
    assert.equal(parseGoalListOptions({ status: "awaiting_human", cursor: " goal-12 " }).status, "awaiting_human");
    assert.equal(parseGoalListOptions({ cursor: " goal-12 " }).cursor, "goal-12");
    assert.throws(() => parseGoalListOptions({ status: "bogus" }), /Unknown goal_list status/);
  });

  it("returns < 20,000 wire chars (serializeToolResult) for 30 goals with 40KB descriptions, 160-quote titles, and limit=100 (P1)", () => {
    const presId = "00000000-0000-0000-0000-000000000001";
    const summaries = Array.from({ length: 30 }, (_, i) => makeGoalSummary(i + 1));
    const res = buildGoalListResult(summaries, parseGoalListOptions({}), { reserveChars: 120 });
    const serialized = serializeToolResult({ ...res, presentation_id: presId });
    assert.ok(serialized.length <= GOAL_LIST_LIMITS.budgetChars, `expected <= 20,000 wire chars, got ${serialized.length}`);
    assert.deepEqual(res.page, { total: 30, returned: 30, nextCursor: null });

    const ids = new Set(res.goals.map((g) => g.id));
    assert.equal(ids.size, 30);
    for (const item of res.goals) {
      assert.equal("description" in item, false, "description text must not appear in goal_list items");
      assert.ok(item.title.length <= GOAL_LIST_LIMITS.titleMax);
      assert.ok(item.latestReview, `expected latestReview on ${item.id}`);
      if (item.version === 2) {
        assert.equal(item.latestReview.goalVersion, 2);
        assert.equal(item.latestReview.cycle, 1);
      } else {
        assert.equal(item.latestReview.goalVersion, 1);
        assert.equal(item.latestReview.cycle, 3);
      }
    }

    // Re-review P1 fixture: 30 goals with 40KB descriptions and 160-quote titles must stay <= 20,000 wire chars.
    const quotedSummaries = Array.from({ length: 30 }, (_, i) =>
      makeGoalSummary(i + 1, { title: '"'.repeat(160) }),
    );
    const quotedRes = buildGoalListResult(quotedSummaries, parseGoalListOptions({}), { reserveChars: 120 });
    const quotedWire = serializeToolResult({ ...quotedRes, presentation_id: presId });
    assert.ok(
      quotedWire.length <= GOAL_LIST_LIMITS.budgetChars,
      `expected 30 quoted-title goals <= 20,000 wire chars, got ${quotedWire.length}`,
    );
    assert.equal(quotedRes.page.returned, 30);

    // Re-review P1 fixture: limit=100 with ordinary titles must stay <= 20,000 wire chars and set nextCursor.
    const ordinary100 = Array.from({ length: 100 }, (_, i) =>
      makeGoalSummary(i + 1, { title: `Ordinary goal title ${i + 1}` }),
    );
    const page100 = buildGoalListResult(ordinary100, parseGoalListOptions({ limit: 100 }), { reserveChars: 120 });
    const wire100 = serializeToolResult({ ...page100, presentation_id: presId });
    assert.ok(
      wire100.length <= GOAL_LIST_LIMITS.budgetChars,
      `expected limit=100 <= 20,000 wire chars, got ${wire100.length}`,
    );
    assert.ok(page100.page.returned < 100 && page100.page.nextCursor !== null);
  });

  it("filters by status and pages 120 goals (with equal timestamps and size-guard caps) without duplicates or skips", () => {
    const statuses: GoalStatus[] = ["draft", "executing", "awaiting_human", "achieved"];
    // Deliberately reuse updatedAt across buckets to verify deterministic tie-breaking by id.
    const summaries = Array.from({ length: 120 }, (_, i) =>
      makeGoalSummary(i + 1, {
        status: statuses[i % statuses.length],
        updatedAt: 1_700_000_000_000 + Math.floor(i / 5) * 1_000,
      }),
    );

    // Status filter
    const awaiting = buildGoalListResult(summaries, parseGoalListOptions({ status: "awaiting_human" }));
    assert.equal(awaiting.page.total, 30);
    assert.equal(awaiting.page.returned, 30);
    assert.equal(awaiting.page.nextCursor, null);
    assert.ok(awaiting.goals.every((g) => g.status === "awaiting_human"));

    // Default paging (limit=30) visits every one of the 120 goals exactly once.
    const seenDefault = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const pageRes = buildGoalListResult(summaries, parseGoalListOptions(cursor ? { cursor } : {}), {
        reserveChars: 120,
      });
      assert.ok(JSON.stringify(pageRes).length < GOAL_LIST_LIMITS.budgetChars);
      assert.equal(pageRes.page.total, 120);
      for (const g of pageRes.goals) {
        assert.ok(!seenDefault.has(g.id), `duplicate goal id ${g.id}`);
        seenDefault.add(g.id);
      }
      cursor = pageRes.page.nextCursor;
      pages++;
      assert.ok(pages <= 10, "default paging should complete in 4 pages");
    } while (cursor !== null);
    assert.equal(seenDefault.size, 120);
    assert.equal(pages, 4);

    // Aggressive limit=100 with long titles hits the 20,000-char size guard: shrinks titles, trims page size, and still visits all 120 once.
    const seenMax = new Set<string>();
    cursor = null;
    pages = 0;
    let sawSizeGuardTrim = false;
    do {
      const pageRes = buildGoalListResult(
        summaries,
        parseGoalListOptions(cursor ? { limit: 100, cursor } : { limit: 100 }),
        { reserveChars: 120 },
      );
      assert.ok(serializeToolResult(pageRes).length <= GOAL_LIST_LIMITS.budgetChars - 120);
      if (pageRes.page.nextCursor !== null && pageRes.page.returned < 100) {
        sawSizeGuardTrim = true;
      }
      for (const g of pageRes.goals) {
        assert.ok(!seenMax.has(g.id), `duplicate goal id ${g.id} under size-guard paging`);
        seenMax.add(g.id);
      }
      cursor = pageRes.page.nextCursor;
      pages++;
      assert.ok(pages <= 20, "size-guarded paging must converge");
    } while (cursor !== null);
    assert.equal(seenMax.size, 120);
    assert.ok(sawSizeGuardTrim, "expected limit=100 with 120 goals to trigger 20k size guard and set nextCursor");
  });
});
