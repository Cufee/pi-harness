import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Database } from "bun:sqlite";
import { runGit } from "../worktree/manager.js";

function canonicalRepoPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

async function runGate(command: string, cwd: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  signal?.throwIfAborted();
  const child = spawn("/bin/sh", ["-lc", command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stopped: Error | undefined;
  const stop = (reason: Error) => {
    if (stopped) return;
    stopped = reason;
    // Gate commands can start additional processes. Terminate the shell's whole process group.
    if (child.pid) {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== "ESRCH") child.kill("SIGKILL"); }
    }
  };
  const abort = () => stop(new Error("Verification gate cancelled"));
  const timeout = setTimeout(() => stop(new Error("Verification gate timed out")), 180_000);
  signal?.addEventListener("abort", abort, { once: true });
  const collect = (stream: NodeJS.ReadableStream, chunks: Buffer[]) => {
    let bytes = 0;
    stream.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) stop(new Error("Verification gate exceeded its output limit"));
      else chunks.push(chunk);
    });
  };
  collect(child.stdout, stdout);
  collect(child.stderr, stderr);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (stopped) throw stopped;
    const output = { stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
    if (code !== 0) throw new Error(output.stderr.trim() || output.stdout.trim() || `Gate exited with status ${code}`);
    return output;
  } finally {
    signal?.removeEventListener("abort", abort);
    clearTimeout(timeout);
  }
}

export type GoalStatus =
  | "draft"
  | "executing"
  | "verifying"
  | "reviewing"
  | "awaiting_human"
  | "achieved"
  | "paused"
  | "cancelled";

export type CriterionKind = "deterministic" | "behavioral" | "architectural";

export interface GoalCriterion {
  id: string;
  description: string;
  kind: CriterionKind;
  /** Runnable shell command for `deterministic` criteria (executed at $0 LLM cost) */
  command?: string;
  required: boolean;
}

export interface GoalBudgets {
  maxReviewCycles: number;
  maxNoProgressCycles: number;
  maxWallClockMin?: number;
  maxApiEquivUsd?: number;
}

export interface GoalRecord {
  id: string;
  chatSessionId: string | null;
  repoRoot: string;
  version: number;
  title: string;
  description: string;
  criteria: GoalCriterion[];
  nonGoals: string[];
  budgets: GoalBudgets;
  status: GoalStatus;
  linkedRunId: string | null;
  reviewCycle: number;
  noProgressStreak: number;
  lastProgressFingerprint: string | null;
  lastReviewSummary: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface GoalAmendmentDelta {
  fromVersion: number;
  toVersion: number;
  rationale: string;
  addedCriteria: GoalCriterion[];
  removedCriteriaIds: string[];
  modifiedCriteria: GoalCriterion[];
  descriptionChanged: boolean;
  nonGoalsChanged: boolean;
}

export interface CriterionEvaluation {
  criterionId: string;
  passed: boolean;
  evidence: string;
  remediation?: string;
}

export interface GoalReviewVerdict {
  id: string;
  goalId: string;
  goalVersion: number;
  cycle: number;
  verdict: "approved" | "changes_requested" | "escalate_human";
  criteriaResults: CriterionEvaluation[];
  blockingIssues: string[];
  summary: string;
  progressFingerprint: string;
  createdAt: number;
}

export interface DeterministicGateResult {
  allPassed: boolean;
  results: CriterionEvaluation[];
  diffHash: string;
}

export const GOALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  chat_session_id TEXT,
  repo_root TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  non_goals_json TEXT NOT NULL DEFAULT '[]',
  budgets_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  linked_run_id TEXT,
  review_cycle INTEGER NOT NULL DEFAULT 0,
  no_progress_streak INTEGER NOT NULL DEFAULT 0,
  last_progress_fingerprint TEXT,
  last_review_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goals_repo_status ON goals(repo_root, status);

CREATE TABLE IF NOT EXISTS goal_revisions (
  goal_id TEXT NOT NULL REFERENCES goals(id),
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  non_goals_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  delta_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (goal_id, version)
);

CREATE TABLE IF NOT EXISTS goal_reviews (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  goal_version INTEGER NOT NULL,
  cycle INTEGER NOT NULL,
  verdict TEXT NOT NULL,
  criteria_results_json TEXT NOT NULL,
  blocking_issues_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  progress_fingerprint TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_reviews_goal ON goal_reviews(goal_id, cycle);
`;

function goalId(): string {
  return `goal-${randomBytes(4).toString("hex")}`;
}

function reviewId(): string {
  return `rev-${randomBytes(4).toString("hex")}`;
}

/**
 * Dynamic "Run-Until-Done" Goal Engine:
 * - Versioned Goal Contracts (`v1 -> v2 -> ...`) with explicit deterministic & behavioral criteria
 * - $0-token deterministic verification gates (`check_cmds`)
 * - Strict mechanical validation of Independent Skeptical Done-Review verdicts (blocks premature approval!)
 * - Anti-spin circuit breakers (`maxReviewCycles` + `noProgressStreak` diff-hash/failure fingerprint)
 */
export class GoalEngine {
  constructor(private readonly db: Database, private readonly onReviewInvalidated?: (goalId: string) => void) {
    this.db.exec(GOALS_SCHEMA);
  }

  private mapGoal(r: Record<string, unknown>): GoalRecord {
    return {
      id: String(r.id),
      chatSessionId: r.chat_session_id ? String(r.chat_session_id) : null,
      repoRoot: String(r.repo_root),
      version: Number(r.version),
      title: String(r.title),
      description: String(r.description),
      criteria: JSON.parse(String(r.criteria_json)) as GoalCriterion[],
      nonGoals: JSON.parse(String(r.non_goals_json)) as string[],
      budgets: JSON.parse(String(r.budgets_json)) as GoalBudgets,
      status: String(r.status) as GoalStatus,
      linkedRunId: r.linked_run_id ? String(r.linked_run_id) : null,
      reviewCycle: Number(r.review_cycle),
      noProgressStreak: Number(r.no_progress_streak),
      lastProgressFingerprint: r.last_progress_fingerprint ? String(r.last_progress_fingerprint) : null,
      lastReviewSummary: r.last_review_summary ? String(r.last_review_summary) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }

  createGoal(input: {
    repoRoot: string;
    chatSessionId?: string | null;
    title: string;
    description: string;
    criteria: Array<Omit<GoalCriterion, "id" | "required"> & { id?: string; required?: boolean }>;
    nonGoals?: string[];
    budgets?: Partial<GoalBudgets>;
  }): GoalRecord {
    if (!input.title.trim()) throw new Error("Goal title is required");
    if (input.criteria.length === 0) throw new Error("Goal requires at least one acceptance criterion");

    const id = goalId();
    const now = Date.now();
    const criteria: GoalCriterion[] = input.criteria.map((c, idx) => ({
      id: c.id ?? `c${idx + 1}`,
      description: c.description,
      kind: c.kind,
      command: c.command,
      required: c.required !== false,
    }));
    const nonGoals = input.nonGoals ?? [];
    const budgets: GoalBudgets = {
      maxReviewCycles: input.budgets?.maxReviewCycles ?? 4,
      maxNoProgressCycles: input.budgets?.maxNoProgressCycles ?? 2,
      maxWallClockMin: input.budgets?.maxWallClockMin,
      maxApiEquivUsd: input.budgets?.maxApiEquivUsd,
    };

    this.db
      .prepare(
        `INSERT INTO goals(
          id, chat_session_id, repo_root, version, title, description,
          criteria_json, non_goals_json, budgets_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
      )
      .run(
        id,
        input.chatSessionId ?? null,
        canonicalRepoPath(input.repoRoot),
        input.title.trim(),
        input.description.trim(),
        JSON.stringify(criteria),
        JSON.stringify(nonGoals),
        JSON.stringify(budgets),
        now,
        now,
      );

    this.db
      .prepare(
        `INSERT INTO goal_revisions(goal_id, version, title, description, criteria_json, non_goals_json, rationale, created_at)
         VALUES (?, 1, ?, ?, ?, ?, 'Initial goal contract', ?)`,
      )
      .run(id, input.title.trim(), input.description.trim(), JSON.stringify(criteria), JSON.stringify(nonGoals), now);

    return this.getGoal(id)!;
  }

  getGoal(id: string): GoalRecord | null {
    const r = this.db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return r ? this.mapGoal(r) : null;
  }

  listGoals(opts?: { repoRoot?: string; status?: GoalStatus }): GoalRecord[] {
    let sql = "SELECT * FROM goals WHERE 1=1";
    const params: string[] = [];
    if (opts?.repoRoot) {
      sql += " AND repo_root = ?";
      params.push(canonicalRepoPath(opts.repoRoot));
    }
    if (opts?.status) {
      sql += " AND status = ?";
      params.push(opts.status);
    }
    sql += " ORDER BY updated_at DESC";
    return (this.db.prepare(sql).all(...params) as Record<string, unknown>[]).map((r) => this.mapGoal(r));
  }

  linkRunAndStart(goalIdStr: string, runId: string): GoalRecord {
    const g = this.getGoal(goalIdStr);
    if (!g) throw new Error(`Unknown goal ${goalIdStr}`);
    this.db
      .prepare("UPDATE goals SET linked_run_id = ?, status = 'executing', updated_at = ? WHERE id = ?")
      .run(runId, Date.now(), goalIdStr);
    return this.getGoal(goalIdStr)!;
  }

  setStatus(goalIdStr: string, status: GoalStatus, summary?: string): GoalRecord {
    const g = this.getGoal(goalIdStr);
    if (!g) throw new Error(`Unknown goal ${goalIdStr}`);
    this.db
      .prepare("UPDATE goals SET status = ?, last_review_summary = COALESCE(?, last_review_summary), updated_at = ? WHERE id = ?")
      .run(status, summary ?? null, Date.now(), goalIdStr);
    if (status === "paused" || status === "cancelled") this.onReviewInvalidated?.(goalIdStr);
    return this.getGoal(goalIdStr)!;
  }

  /**
   * Dynamic Mid-Flight Goal Mutation (`vN -> vN+1`):
   * Computes an exact structured Amendment Delta (`added`/`removed`/`modified`),
   * resets stale `reviewing`/`achieved`/`awaiting_human` states back to `executing`
   * (preserving `draft` if not yet committed), and resets `noProgressStreak` because
   * requirements genuinely changed.
   */
  amendGoal(
    goalIdStr: string,
    patch: {
      title?: string;
      description?: string;
      addCriteria?: Array<Omit<GoalCriterion, "id" | "required"> & { id?: string; required?: boolean }>;
      removeCriteriaIds?: string[];
      updateCriteria?: GoalCriterion[];
      nonGoals?: string[];
      rationale: string;
    },
  ): { goal: GoalRecord; delta: GoalAmendmentDelta } {
    const cur = this.getGoal(goalIdStr);
    if (!cur) throw new Error(`Unknown goal ${goalIdStr}`);
    if (cur.status === "cancelled") throw new Error("Cannot amend a cancelled goal");

    const removedSet = new Set(patch.removeCriteriaIds ?? []);
    let nextCriteria = cur.criteria.filter((c) => !removedSet.has(c.id));

    const modifiedCriteria: GoalCriterion[] = [];
    for (const upd of patch.updateCriteria ?? []) {
      const idx = nextCriteria.findIndex((c) => c.id === upd.id);
      if (idx >= 0) {
        nextCriteria[idx] = upd;
        modifiedCriteria.push(upd);
      }
    }

    const addedCriteria: GoalCriterion[] = (patch.addCriteria ?? []).map((c, idx) => ({
      id: c.id ?? `c${cur.version + 1}_${idx + 1}`,
      description: c.description,
      kind: c.kind,
      command: c.command,
      required: c.required !== false,
    }));
    nextCriteria = [...nextCriteria, ...addedCriteria];

    if (nextCriteria.length === 0) {
      throw new Error("Goal amendment cannot remove all acceptance criteria");
    }

    const nextVersion = cur.version + 1;
    const nextTitle = patch.title?.trim() ?? cur.title;
    const nextDesc = patch.description?.trim() ?? cur.description;
    const nextNonGoals = patch.nonGoals ?? cur.nonGoals;
    const nextStatus: GoalStatus =
      cur.status === "draft" || cur.status === "paused" ? cur.status : "executing";

    const delta: GoalAmendmentDelta = {
      fromVersion: cur.version,
      toVersion: nextVersion,
      rationale: patch.rationale,
      addedCriteria,
      removedCriteriaIds: [...removedSet],
      modifiedCriteria,
      descriptionChanged: nextDesc !== cur.description,
      nonGoalsChanged: JSON.stringify(nextNonGoals) !== JSON.stringify(cur.nonGoals),
    };

    const now = Date.now();
    this.db
      .prepare(
        `UPDATE goals
         SET version = ?, title = ?, description = ?, criteria_json = ?, non_goals_json = ?,
             status = ?, no_progress_streak = 0, last_progress_fingerprint = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextVersion,
        nextTitle,
        nextDesc,
        JSON.stringify(nextCriteria),
        JSON.stringify(nextNonGoals),
        nextStatus,
        now,
        goalIdStr,
      );

    this.db
      .prepare(
        `INSERT INTO goal_revisions(goal_id, version, title, description, criteria_json, non_goals_json, rationale, delta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        goalIdStr,
        nextVersion,
        nextTitle,
        nextDesc,
        JSON.stringify(nextCriteria),
        JSON.stringify(nextNonGoals),
        patch.rationale,
        JSON.stringify(delta),
        now,
      );

    this.onReviewInvalidated?.(goalIdStr);
    return { goal: this.getGoal(goalIdStr)!, delta };
  }

  /** Executes all `deterministic` criteria commands at $0 LLM cost and hashes repo diff for progress tracking. */
  async runDeterministicGates(goalIdStr: string, baseSha?: string, signal?: AbortSignal): Promise<DeterministicGateResult> {
    const goal = this.getGoal(goalIdStr);
    if (!goal) throw new Error(`Unknown goal ${goalIdStr}`);
    this.setStatus(goalIdStr, "verifying");

    const results: CriterionEvaluation[] = [];
    let allPassed = true;

    for (const c of goal.criteria) {
      if (c.kind !== "deterministic" || !c.command) continue;
      try {
        const { stdout, stderr } = await runGate(c.command, goal.repoRoot, signal);
        results.push({
          criterionId: c.id,
          passed: true,
          evidence: `$ ${c.command} -> exit 0${stdout.trim() ? `: ${stdout.trim().slice(-300)}` : stderr.trim() ? `: ${stderr.trim().slice(-200)}` : ""}`,
        });
      } catch (err: unknown) {
        signal?.throwIfAborted();
        const message = err instanceof Error ? err.message : String(err);
        if (c.required) allPassed = false;
        results.push({
          criterionId: c.id,
          passed: false,
          evidence: `$ ${c.command} -> FAILED\n${message.slice(-600)}`,
          remediation: `Fix failures in deterministic check: ${c.command}`,
        });
      }
    }

    let diffText = "";
    try {
      const args = baseSha ? ["diff", `${baseSha}..HEAD`] : ["rev-parse", "HEAD"];
      diffText = (await runGit(goal.repoRoot, args)).stdout;
    } catch {
      diffText = String(Date.now());
    }
    const diffHash = createHash("sha256").update(diffText).digest("hex").slice(0, 16);

    return { allPassed, results, diffHash };
  }

  /**
   * Records an Independent Done-Review verdict with **strict mechanical validation**
   * and **anti-spin circuit breakers**:
   *  - Mechanically rejects `verdict: "approved"` if ANY `required` criterion is missing, `passed: false`, or lacks evidence!
   *  - Computes progress fingerprint `sha256(diffHash + failedIds)`: trips circuit breaker to `awaiting_human`
   *    when `noProgressStreak >= maxNoProgressCycles` OR `reviewCycle >= maxReviewCycles`.
   */
  recordReviewVerdict(
    goalIdStr: string,
    input: {
      verdict: "approved" | "changes_requested" | "escalate_human";
      criteriaResults: CriterionEvaluation[];
      blockingIssues?: string[];
      summary: string;
      diffHash: string;
    },
  ): { goal: GoalRecord; review: GoalReviewVerdict; circuitBreakerTripped?: string } {
    const goal = this.getGoal(goalIdStr);
    if (!goal) throw new Error(`Unknown goal ${goalIdStr}`);

    const byId = new Map(input.criteriaResults.map((r) => [r.criterionId, r]));
    const unmetRequired: string[] = [];
    for (const c of goal.criteria) {
      if (!c.required) continue;
      const ev = byId.get(c.id);
      if (!ev || !ev.passed || !ev.evidence.trim()) {
        unmetRequired.push(c.id);
      }
    }

    // Mechanical anti-sycophancy guard: cannot approve while required criteria are unmet or unevidenced
    let effectiveVerdict = input.verdict;
    const blockingIssues = [...(input.blockingIssues ?? [])];
    if (effectiveVerdict === "approved" && unmetRequired.length > 0) {
      effectiveVerdict = "changes_requested";
      blockingIssues.push(`Mechanical gate rejected premature approval; unmet/unevidenced required criteria: ${unmetRequired.join(", ")}`);
    }

    const nextCycle = goal.reviewCycle + 1;
    const failedIds = input.criteriaResults
      .filter((r) => !r.passed)
      .map((r) => r.criterionId)
      .concat(unmetRequired)
      .sort();
    const fingerprint = createHash("sha256")
      .update(`${goal.version}|${input.diffHash}|${[...new Set(failedIds)].join(",")}`)
      .digest("hex")
      .slice(0, 16);

    const sameAsLast = goal.lastProgressFingerprint !== null && goal.lastProgressFingerprint === fingerprint;
    const priorReviews = this.listReviews(goal.id).filter((r) => r.goalVersion === goal.version);
    const seenOscillation =
      effectiveVerdict !== "approved" && priorReviews.some((r) => r.progressFingerprint === fingerprint && !sameAsLast);
    const nextNoProgress = effectiveVerdict === "approved" ? 0 : sameAsLast ? goal.noProgressStreak + 1 : 0;

    let nextStatus: GoalStatus = "executing";
    let circuitBreakerTripped: string | undefined;

    if (effectiveVerdict === "approved") {
      nextStatus = "achieved";
    } else if (effectiveVerdict === "escalate_human") {
      nextStatus = "awaiting_human";
      circuitBreakerTripped = "Reviewer requested human decision";
    } else if (seenOscillation) {
      nextStatus = "awaiting_human";
      circuitBreakerTripped = `Oscillation circuit breaker tripped (repeated earlier diff/failure state fingerprint=${fingerprint})`;
    } else if (nextNoProgress >= goal.budgets.maxNoProgressCycles) {
      nextStatus = "awaiting_human";
      circuitBreakerTripped = `No-progress circuit breaker tripped (${nextNoProgress} identical diff/failure cycles, fingerprint=${fingerprint})`;
    } else if (nextCycle >= goal.budgets.maxReviewCycles) {
      nextStatus = "awaiting_human";
      circuitBreakerTripped = `Max review cycles reached (${nextCycle}/${goal.budgets.maxReviewCycles})`;
    } else {
      nextStatus = "executing";
    }

    const revId = reviewId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO goal_reviews(
          id, goal_id, goal_version, cycle, verdict, criteria_results_json,
          blocking_issues_json, summary, progress_fingerprint, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        revId,
        goal.id,
        goal.version,
        nextCycle,
        effectiveVerdict,
        JSON.stringify(input.criteriaResults),
        JSON.stringify(blockingIssues),
        input.summary,
        fingerprint,
        now,
      );

    this.db
      .prepare(
        `UPDATE goals
         SET status = ?, review_cycle = ?, no_progress_streak = ?,
             last_progress_fingerprint = ?, last_review_summary = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextStatus,
        nextCycle,
        nextNoProgress,
        fingerprint,
        circuitBreakerTripped ? `${circuitBreakerTripped} — ${input.summary}` : input.summary,
        now,
        goal.id,
      );

    const review: GoalReviewVerdict = {
      id: revId,
      goalId: goal.id,
      goalVersion: goal.version,
      cycle: nextCycle,
      verdict: effectiveVerdict,
      criteriaResults: input.criteriaResults,
      blockingIssues,
      summary: input.summary,
      progressFingerprint: fingerprint,
      createdAt: now,
    };

    return { goal: this.getGoal(goal.id)!, review, circuitBreakerTripped };
  }

  listReviews(goalIdStr: string): GoalReviewVerdict[] {
    const rows = this.db
      .prepare("SELECT * FROM goal_reviews WHERE goal_id = ? ORDER BY cycle ASC")
      .all(goalIdStr) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      goalId: String(r.goal_id),
      goalVersion: Number(r.goal_version),
      cycle: Number(r.cycle),
      verdict: String(r.verdict) as GoalReviewVerdict["verdict"],
      criteriaResults: JSON.parse(String(r.criteria_results_json)) as CriterionEvaluation[],
      blockingIssues: JSON.parse(String(r.blocking_issues_json)) as string[],
      summary: String(r.summary),
      progressFingerprint: String(r.progress_fingerprint),
      createdAt: Number(r.created_at),
    }));
  }

  buildReviewerPrompt(goal: GoalRecord, gateResult: DeterministicGateResult, diffStat: string): string {
    const lines = [
      `# Independent Skeptical Done-Review (Goal ${goal.id} v${goal.version}, Cycle ${goal.reviewCycle + 1}/${goal.budgets.maxReviewCycles})`,
      `Title: ${goal.title}`,
      `Description: ${goal.description}`,
      "",
      "You are an INDEPENDENT, SKEPTICAL REVIEWER — NOT the generator.",
      "Inspect actual code, diffs, and test outputs. Never approve stubbed implementations, missing edge cases, or unverified claims.",
      "",
      "## Acceptance Criteria (EVERY required criterion must have concrete evidence)",
      ...goal.criteria.map(
        (c) => `- [${c.id}] (${c.kind}${c.required ? ", REQUIRED" : ", optional"}): ${c.description}${c.command ? ` [cmd: ${c.command}]` : ""}`,
      ),
    ];
    if (goal.nonGoals.length > 0) {
      lines.push("", "## Non-Goals (Out of Scope)", ...goal.nonGoals.map((ng) => `- ${ng}`));
    }
    lines.push("", "## Deterministic Gate Results");
    for (const r of gateResult.results) {
      lines.push(`- [${r.criterionId}] ${r.passed ? "PASS" : "FAIL"}: ${r.evidence}`);
    }
    lines.push("", "## Git Diff Summary", diffStat || "(no diff)");
    lines.push(
      "",
      "Return a strict JSON verdict matching:",
      `{ "verdict": "approved" | "changes_requested" | "escalate_human", "criteriaResults": [{ "criterionId": "...", "passed": true|false, "evidence": "...", "remediation": "..." }], "blockingIssues": [], "summary": "..." }`,
    );
    return lines.join("\n");
  }
}
