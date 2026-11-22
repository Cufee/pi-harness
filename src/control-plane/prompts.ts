import type { KbCard } from "../kb/store.js";
import type { ArtifactRecord, EscalationRecord, TaskRecord } from "./db.js";

/**
 * KV-cache-safe immutable system prompts per tier.
 * NEVER embed live timestamps, dynamic tree dumps, or mutable counters here—
 * dynamic state is injected in turn messages or fetched via deterministic tools.
 */
export function buildImmutableSystemPrompt(tier: 1 | 2 | 3, kind: TaskRecord["kind"]): string {
  if (tier === 1) {
    return [
      "You are the Tier 1 ORCHESTRATOR in pi-harness.",
      "Your job is to plan, coordinate, track progress, resolve escalations, and keep the overall goal on track.",
      "",
      "CORE RULES:",
      "1. Never implement repo code directly. Decompose work into disjoint Tier 2 Worker feature slices with explicit non-overlapping `write_scopes`.",
      "2. Before choosing models or efforts for Workers, call `list_models` to inspect live coding rankings, cost/time per task, and current subscription quota availability.",
      "3. Use `spawn_task` for read-only research, planning, and verification instead of reading workspace files yourself. Read child handoffs first with `wait_children`: compact summaries, sources (required for research, plan, and verify), and `artifact_paths`. Use `artifact_read` only when you need more detail.",
      "4. When a Worker returns `scope_too_large` or reports a P1 issue, re-scope the DAG cleanly using its evidence and suggested splits without discarding prior artifacts.",
      "5. Protect your context window: when context approaches 60% or when requested by the control plane, write a crisp anchored handoff via `request_rollover` (Goal Invariants, Architectural Decisions, Active Risks, Next Actions) and let the control plane boot your successor.",
      "6. If you inherited from a previous Orchestrator generation and need historical rationale not in the handoff, call `query_predecessor`.",
    ].join("\n");
  }

  if (tier === 2) {
    return [
      "You are a Tier 2 WORKER owning one feature slice inside an isolated git worktree.",
      "",
      "CORE RULES:",
      "1. Delegate DYNAMICALLY based on task structure:",
      "   - Spawn read-only Tier 3 Task Agents (`kind: 'research'`) in parallel to explore unfamiliar codebases so raw search output never bloats your window.",
      "   - Spawn Tier 3 `plan` / `execute` agents for cleanly separable sub-steps with exact interface contracts.",
      "   - Execute tightly-coupled multi-file edits directly in your worktree when splitting would lose tacit context or waste cold-start latency.",
      "   - For non-trivial changes, spawn an independent read-only Tier 3 `verify` agent before submitting for merge.",
      "2. Call `list_models` to pick the best model + effort level per Task Agent, respecting active subscription quota buckets.",
      "3. SCOPE SEND-BACK: If this slice is significantly larger, riskier, or more tangled than contracted, save your findings as an artifact and call `return_task` with status `scope_too_large`, evidence paths, and at least two suggested splits.",
      "4. ISSUE REPORTING: Whenever you uncover pre-existing code defects, broken tests, or interface mismatches outside your slice, call `report_issue` immediately.",
      "5. CONTEXT HYGIENE: Never rely on lossy compaction. If your context nears 65% or you need a different model, commit clean WIP to your worktree branch and call `request_rollover`.",
      "6. Read child handoffs first with `wait_children`: compact summaries, sources (required for research, plan, and verify), and `artifact_paths`. Use `artifact_read` only when you need more detail.",
      "7. COMPLETION: Commit your changes, run verification checks, and call `submit_for_merge`, then `return_task` with a summary of at most 2,000 characters, structured sources, and any `artifact_paths`.",
    ].join("\n");
  }

  return [
    `You are a Tier 3 TASK AGENT (kind: ${kind}) operating inside a small, zero-compaction context window.`,
    "",
    "CORE RULES:",
    "1. Stay laser-focused on your exact objective and acceptance criteria. Do NOT expand scope.",
    "2. Call `return_task` with a summary of at most 2,000 characters and structured `sources` (`path` and optional `lines`, `symbol`, `note`); research, plan, and verify tasks must include at least one source. Save details with `artifact_write` and pass their paths as `artifact_paths` rather than returning transcripts or tool logs.",
    "3. SCOPE SEND-BACK: If the task will not fit your turn or context budget, use status `scope_too_large` in your handoff and include evidence paths and at least two suggested splits.",
    "4. ISSUE REPORTING: If you find any bug, broken test, architectural violation, or ambiguity in the codebase, ALWAYS raise it up the chain via `report_issue`.",
    "5. Never attempt to spawn subagents or bypass your tool/write boundaries.",
  ].join("\n");
}

export interface AnchoredHandoff {
  goalInvariants: string[];
  architecturalDecisions: Array<{ decision: string; rationale: string }>;
  activeRisks: string[];
  nextActions: string[];
}

/**
 * Hydrates a fresh Orchestrator or Worker generation strictly from durable SQLite state
 * + the predecessor's anchored handoff (never trusting LLM prose for task statuses or file lists).
 */
export function buildHydrationTurn(input: {
  task: TaskRecord;
  handoff?: AnchoredHandoff | null;
  tasksSnapshot: TaskRecord[];
  artifacts: ArtifactRecord[];
  openEscalations: EscalationRecord[];
  blackboard: Record<string, { value: unknown; authorTaskId: string }>;
  scopedKbHints?: KbCard[];
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  quotaResumeNote?: { reason?: string; userMessage?: string | null } | null;
}): string {
  const lines: string[] = [
    `# Task Assignment (${input.task.id}, tier=${input.task.tier}, gen=${input.task.generation})`,
    `Title: ${input.task.title}`,
    `Objective: ${input.task.objective}`,
  ];
  if (input.task.criteria) lines.push(`Acceptance Criteria: ${input.task.criteria}`);
  if (input.worktreePath) lines.push(`Worktree: ${input.worktreePath} (branch: ${input.worktreeBranch ?? "unknown"})`);
  if (input.task.readOnly) lines.push(`Access Mode: STRICTLY READ-ONLY`);

  if (input.quotaResumeNote) {
    lines.push("", "## Resumed After Quota Pause");
    lines.push(
      `This task was paused early due to quota/rate limits (${input.quotaResumeNote.reason ?? "quota limit"}). Your git worktree, uncommitted WIP, and prior artifacts were preserved intact — inspect current files/git status and continue seamlessly without redoing completed work.`,
    );
    if (input.quotaResumeNote.userMessage) {
      lines.push(`Human Resume Instruction: ${input.quotaResumeNote.userMessage}`);
    }
  }

  if (input.handoff) {
    lines.push("", "## Predecessor Anchored Handoff (use `query_predecessor` if deeper rationale is needed)");
    lines.push(`- Goal Invariants: ${JSON.stringify(input.handoff.goalInvariants)}`);
    lines.push(`- Architectural Decisions: ${JSON.stringify(input.handoff.architecturalDecisions)}`);
    lines.push(`- Active Risks: ${JSON.stringify(input.handoff.activeRisks)}`);
    lines.push(`- Next Actions: ${JSON.stringify(input.handoff.nextActions)}`);
  }

  if (input.tasksSnapshot.length > 0) {
    lines.push("", "## Authoritative Task Tree (from SQLite DB)");
    for (const t of input.tasksSnapshot) {
      lines.push(
        `- [${t.status}] ${t.id} (T${t.tier}/${t.kind}) "${t.title}" model=${t.model ?? t.profileId}${
          t.summary ? ` — ${t.summary.slice(0, 140)}` : ""
        }`,
      );
    }
  }

  if (input.openEscalations.length > 0) {
    lines.push("", "## Open Escalations / Scope Send-Backs");
    for (const e of input.openEscalations) {
      lines.push(
        `- [${e.severity}/${e.category}] ${e.id} from ${e.fromTaskId}: ${e.title} (evidence: ${e.evidencePaths.join(", ")}${
          e.suggestedSplits.length ? `; splits: ${e.suggestedSplits.join(" | ")}` : ""
        })`,
      );
    }
  }

  if (input.artifacts.length > 0) {
    lines.push("", "## Deterministic Artifact Index (recent)");
    for (const a of input.artifacts.slice(0, 30)) {
      lines.push(`- [${a.kind}] ${a.path} (by ${a.taskId}): ${a.summary.slice(0, 120)}`);
    }
  }

  const bbKeys = Object.keys(input.blackboard);
  if (bbKeys.length > 0) {
    lines.push("", "## Shared Decision Blackboard");
    for (const k of bbKeys) {
      lines.push(`- ${k}: ${JSON.stringify(input.blackboard[k]?.value)}`);
    }
  }

  if (input.scopedKbHints && input.scopedKbHints.length > 0) {
    lines.push("", "## Scoped Knowledge Hints (call `kb_get` for full context)");
    for (const h of input.scopedKbHints.slice(0, 5)) {
      const sha = h.verifiedSha ? `@${h.verifiedSha.slice(0, 7)}` : "";
      lines.push(`- [${h.id} | ${h.kind} ${sha}] ${h.title}`);
    }
  }

  return lines.join("\n");
}
