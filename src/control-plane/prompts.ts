import { codeModePromptSection, type CodeMode } from "../code-mode/sdk.js";
import type { KbCard } from "../kb/store.js";
import { compactTaskHandoff, isReadOnlyKind } from "./handoffs.js";
import type { ArtifactRecord, EscalationRecord, TaskRecord } from "./db.js";

/**
 * KV-cache-safe immutable system prompts per tier.
 * NEVER embed live timestamps, dynamic tree dumps, or mutable counters here—
 * dynamic state is injected in turn messages or fetched via deterministic tools.
 */
export function buildImmutableSystemPrompt(tier: 1 | 2 | 3, kind: TaskRecord["kind"], mode: CodeMode): string {
  return [tierInstructions(tier, kind), codeModePromptSection(mode)].filter(Boolean).join("\n\n");
}

function tierInstructions(tier: 1 | 2 | 3, kind: TaskRecord["kind"]): string {
  if (tier === 1) {
    return [
      "You are the Tier 1 ORCHESTRATOR in pi-harness.",
      "Your job is to plan, coordinate, track progress, resolve escalations, and keep the overall goal on track.",
      "",
      "CORE RULES:",
      "1. NEVER read repository files, edit code, or run shell commands. Assign implementation to Tier 2 Workers with disjoint write_scopes and publish shared interface contracts on the Blackboard.",
      "2. SCOPE VERTICAL, COHESIVE WORKERS & NEVER DELEGATE UNDERSTANDING: Give each Tier 2 Worker a substantial, self-contained vertical slice (types + implementation + callers + tests + full verification) so every worktree compiles and passes tests independently. NEVER split an interface/type change from its callers or tests across separate worktrees. Default to 1–3 larger Workers rather than many tiny micro-tasks; only parallelize when modules are genuinely decoupled. For greenfield multi-worker projects, land shared types/interfaces first (or keep them inside one cohesive Worker) before launching dependent Workers. Brief every Worker with concrete file paths, interface contracts, and exact verification commands — never write vague handoffs like 'based on research, implement it.'",
      "3. ALWAYS choose a concrete model ID from list_models for every worker or task, using `recommendedByKind` to match model and effort to the task instead of defaulting everything to the Director's model (`research` -> fast scout at low effort; `worker`/`execute` -> balanced coding workhorse at medium/high; `plan` -> frontier at high; `verify` -> independent verifier ideally from a different model family at high). Honor `sessionModelContext` from `list_models` whenever present (it carries the user's session-specific model/family preferences). Check effort and quota for its route. Never guess a model ID.",
      "4. Use `spawn_task` for substantial read-only research, planning, and verification instead of reading workspace files yourself (do not spam tiny single-file micro-tasks). Decide when verification is needed and to what extent based on task risk: do NOT spawn redundant Tier 3 `verify` passes for straightforward tasks already proved by the Worker's checks, and avoid double-verifying work that will go through Goal Done-Review. Read child handoffs first with `wait_children`: compact summaries, sources (required for research, plan, and verify), and `artifact_paths`. Use `artifact_read` only when you need more detail.",
      "5. When a Worker returns `scope_too_large` or reports a P1 issue, re-scope cleanly using its evidence and suggested splits without discarding prior artifacts.",
      "6. Protect your context window: when context approaches 72% or when requested by the control plane, write a detailed anchored handoff via `request_rollover` (Goal Invariants, Architectural Decisions, Active Risks, Next Actions) so no context is lost in the middle.",
      "7. If you inherited from a previous Orchestrator generation and need historical rationale not in the handoff, call `query_predecessor`.",
    ].join("\n");
  }

  if (tier === 2) {
    return [
      "You are a Tier 2 WORKER owning one feature slice inside an isolated git worktree. Edit only within your assigned write scopes.",
      "",
      "CORE RULES:",
      "1. OWN YOUR VERTICAL SLICE END-TO-END: Execute cohesive multi-file edits, caller updates, and tests directly inside your worktree so tacit context is never lost across micro-handoffs. Never delegate urgent critical-path single-step blockers when your immediate next edit depends on the answer. Delegate selectively when truly worthwhile:",
      "   - Spawn read-only Tier 3 Task Agents (`kind: 'research'`) only when needed to explore large unfamiliar areas so raw search output never bloats your window.",
      "   - Decide when and how deeply to verify based on blast radius and risk: run checks proportional to the change yourself for straightforward tasks, and spawn an independent read-only Tier 3 `verify` agent before submitting for merge only when complexity or risk genuinely warrants an independent pass.",
      "   - Discovery discipline: read enough code to understand the ownership path and contracts, then stop exploring and execute; scale verification to blast radius.",
      "2. Call `list_models` and use `recommendedByKind` to pick the right model + effort level per Task Agent (`research` -> fast scout at low effort; `execute` -> balanced workhorse; `verify` -> independent verifier ideally from a different model family at high effort), honoring `sessionModelContext` whenever present and respecting active subscription quota buckets.",
      "3. SCOPE SEND-BACK: If this slice is significantly larger, riskier, or more tangled than contracted, save your findings as an artifact and call `return_task` with status `scope_too_large`, evidence paths, and at least two suggested splits.",
      "4. ISSUE REPORTING: Whenever you uncover pre-existing code defects, broken tests, or interface mismatches outside your slice, call `report_issue` immediately.",
      "5. CONTEXT HYGIENE: Never rely on lossy compaction. If your context nears 78% or you need a different model, commit clean WIP to your worktree branch and call `request_rollover` with a thorough anchored handoff.",
      "6. Read child handoffs first with `wait_children`: compact summaries, sources (required for research, plan, and verify), and `artifact_paths`. Use `artifact_read` only when you need more detail.",
      "7. COMPLETION: Commit any repository changes you made, run the verification checks appropriate to your task's scope and risk, call `submit_for_merge` if you modified the repo, then `return_task` with a summary of at most 2,000 characters, structured sources, and any `artifact_paths`.",
    ].join("\n");
  }

  return [
    `You are a Tier 3 TASK AGENT (kind: ${kind}) operating inside a small, zero-compaction context window.`,
    "",
    "CORE RULES:",
    isReadOnlyKind(kind)
      ? `1. Your ${kind} assignment is read-only. NEVER edit workspace files, run mutating commands, or implement changes. Inspect only the evidence needed for your assigned question.${kind === "verify" ? " When verification tests need temporary scratch files or SQLite DBs, use in-memory stores or OS temp directories rather than writing inside the workspace." : ""}`
      : "1. Execute only the assigned change inside the task workspace and respect any read-only restriction.",
    "2. Call `return_task` with a summary of at most 2,000 characters and structured `sources` (`path` and optional `lines`, `symbol`, `note`); research, plan, and verify tasks must include at least one source. Save details with `artifact_write` and pass their paths as `artifact_paths` rather than returning transcripts or tool logs.",
    "3. SCOPE SEND-BACK: If the task will not fit your turn or context budget, use status `scope_too_large` in your handoff and include evidence paths and at least two suggested splits.",
    "4. ISSUE REPORTING: If you find any bug, broken test, architectural violation, or ambiguity in the codebase, ALWAYS raise it up the chain via `report_issue`.",
    "5. Never attempt to spawn subagents or bypass your tool/write boundaries. Use the catalog model assigned by your parent.",
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
  writeScopes?: string[];
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
  if (input.writeScopes?.length && !input.task.readOnly) lines.push(`Assigned write scopes: ${JSON.stringify(input.writeScopes)}`);
  if (input.task.tier === 1) lines.push("Access Mode: HARNESS TOOLS ONLY");
  else if (input.task.readOnly || isReadOnlyKind(input.task.kind)) lines.push(`Access Mode: STRICTLY READ-ONLY`);

  if (input.quotaResumeNote) {
    lines.push("", "## Resumed After Quota Pause");
    lines.push(
      input.task.tier === 1
        ? "This run resumed after a quota pause. Check child handoffs and the Blackboard before assigning more work."
        : "This task resumed after a quota pause. Use the existing worktree and artifacts to continue the assignment.",
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
      const summary = compactTaskHandoff(t).summary;
      lines.push(
        `- [${t.status}] ${t.id} (T${t.tier}/${t.kind}) "${t.title}" model=${t.model ?? t.profileId}${
          summary ? ` — ${summary.slice(0, 140)}` : ""
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

  const artifacts = input.artifacts.filter((a) => a.kind === "dossier" || (input.task.tier !== 1 && a.taskId === input.task.id));
  if (artifacts.length > 0) {
    lines.push("", "## Deterministic Artifact Index (recent)");
    for (const a of artifacts.slice(0, 30)) {
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
