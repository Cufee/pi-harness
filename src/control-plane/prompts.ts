import type { Role } from "../advisories/types.js";
import { roleOf } from "../advisories/roles.js";
import { codeModePromptSection, type CodeMode } from "../code-mode/sdk.js";
import type { KbCard } from "../kb/store.js";
import { allowedToolNames, toolFact, toolRef } from "../tool-descriptions/index.js";
import { compactTaskHandoff, isReadOnlyKind } from "./handoffs.js";
import { formatPlanForPrompt, type ThreadPlan, type ThreadRequestRecord } from "./thread-state.js";
import type {
  ArtifactRecord,
  EscalationRecord,
  MessageRecord,
  PeerExchangeRecord,
  RecentlyResolvedEscalation,
  TaskRecord,
} from "./db.js";

/**
 * KV-cache-safe immutable system prompts per tier.
 * NEVER embed live timestamps, dynamic tree dumps, or mutable counters here—
 * dynamic state is injected in turn messages or fetched via deterministic tools.
 *
 * Registry rule: every tool name in these prompts goes through `toolRef` or `mentionRef`,
 * and every sentence stating what a tool does, requires, or causes goes through `toolFact`
 * and is listed in `PROMPT_FACT_USES` so prompts and tool descriptions cannot drift.
 */
export const PROMPT_FACT_USES: ReadonlyArray<{ role: Role; tool: string; key: string }> = [
  { role: "orchestrator", tool: "spawn_worker", key: "noCounts" },
  { role: "orchestrator", tool: "spawn_task", key: "noCounts" },
  { role: "orchestrator", tool: "spawn_task", key: "partialReturn" },
  { role: "orchestrator", tool: "wait_children", key: "eventDriven" },
  { role: "orchestrator", tool: "report_issue", key: "routing" },
  { role: "orchestrator", tool: "report_issue", key: "blockingDefault" },
  { role: "orchestrator", tool: "request_rollover", key: "progress" },
  { role: "orchestrator", tool: "update_plan", key: "survivesRollover" },
  { role: "orchestrator", tool: "update_plan", key: "turnEndCheck" },
  { role: "orchestrator", tool: "submit_for_merge", key: "leadResubmit" },
  { role: "orchestrator", tool: "ask_user", key: "reasked" },
  { role: "orchestrator", tool: "ask_user", key: "nonBlocking" },
  { role: "worker", tool: "update_plan", key: "survivesRollover" },
  { role: "worker", tool: "spawn_task", key: "noCounts" },
  { role: "worker", tool: "spawn_task", key: "partialReturn" },
  { role: "worker", tool: "wait_children", key: "eventDriven" },
  { role: "worker", tool: "return_task", key: "summaryLimit" },
  { role: "worker", tool: "return_task", key: "sources" },
  { role: "worker", tool: "return_task", key: "scopeSendBack" },
  { role: "worker", tool: "return_task", key: "externalDeliverable" },
  { role: "worker", tool: "report_issue", key: "routing" },
  { role: "worker", tool: "report_issue", key: "blockingDefault" },
  { role: "worker", tool: "request_rollover", key: "progress" },
  { role: "research", tool: "return_task", key: "summaryLimit" },
  { role: "research", tool: "return_task", key: "sources" },
  { role: "research", tool: "return_task", key: "scopeSendBack" },
  { role: "plan", tool: "return_task", key: "summaryLimit" },
  { role: "plan", tool: "return_task", key: "sources" },
  { role: "plan", tool: "return_task", key: "scopeSendBack" },
  { role: "verify", tool: "return_task", key: "summaryLimit" },
  { role: "verify", tool: "return_task", key: "sources" },
  { role: "verify", tool: "return_task", key: "verifyVerdict" },
  { role: "verify", tool: "return_task", key: "scopeSendBack" },
  { role: "execute", tool: "return_task", key: "summaryLimit" },
  { role: "execute", tool: "return_task", key: "sources" },
  { role: "execute", tool: "return_task", key: "scopeSendBack" },
  { role: "execute", tool: "report_issue", key: "routing" },
  { role: "execute", tool: "report_issue", key: "blockingDefault" },
];

export function buildImmutableSystemPrompt(
  tier: 1 | 2 | 3,
  kind: TaskRecord["kind"],
  mode: CodeMode,
  codeExecOpts?: { defaultTimeoutMs?: number; maxTimeoutMs?: number },
  opts?: { readOnlyLead?: boolean },
): string {
  return [tierInstructions(tier, kind, opts), codeModePromptSection(mode, codeExecOpts)].filter(Boolean).join("\n\n");
}

function tierInstructions(tier: 1 | 2 | 3, kind: TaskRecord["kind"], opts?: { readOnlyLead?: boolean }): string {
  if (tier === 1) {
    const r: Role = "orchestrator";
    const writable = !opts?.readOnlyLead;
    return [
      "You are a LEAD THREAD in pi-harness (Tier 1). The Director gave you one goal, and you own its outcome: its acceptance criteria met, the result on the base branch, and a report the Director can relay to the user.",
      writable
        ? "You work in your own git worktree: you can read, edit, run commands, and commit there. Never run `git worktree prune`, `remove`, `move`, or `unlock`; the harness manages worktrees."
        : "You are read-only in this run: you can read and search the workspace but not edit it or run shell commands, so every change goes to a Worker thread.",
      "",
      "HOW YOU WORK:",
      `1. SCOPE, THEN PLAN. Read the goal and enough of the code to know what done means here, and what is in and out of scope. Record that with ${toolRef(r, "update_plan")}: your scope in a sentence or two, and the steps, each naming the criteria it serves. A small goal needs two or three steps; do not pad the plan. Keep it current as you learn. ${toolFact(r, "update_plan", "survivesRollover")}`,
      writable
        ? `2. DECIDE HOW EACH STEP GETS DONE. Do the work yourself by default: you hold the context, and a brief never carries all of it. Hand a step to someone else only when it helps in one of these ways:`
        : `2. DECIDE WHO DOES EACH STEP. Keep the understanding yourself and hand out the changes:`,
      `   - Two or more steps can run at the same time because they do not touch the same files and do not need each other's results. Give each to a Worker thread with ${toolRef(r, "spawn_worker")}; a Worker has its own worktree and merges its own slice. Land shared types or interfaces first, or keep them in one thread. ${toolFact(r, "spawn_worker", "noCounts")}`,
      `   - A step would fill your context with output you only need the conclusion of: a broad search, a long investigation${writable ? ", a mechanical change across many files" : ""}. Give it to a subagent with ${toolRef(r, "spawn_task")}${writable ? " (kind research, plan, execute, or verify); it runs inside your worktree" : " (kind research, plan, or verify)"}.`,
      `   - A conclusion should be checked by someone who did not reach it. Use ${toolRef(r, "spawn_task")} with kind verify, and scale that to risk: do not verify twice what your own checks or the goal's review already cover.`,
      "   Complexity alone is not a reason to delegate, and nothing ever forces you to split work to make it fit: no thread is stopped by a turn, tool-call, or token count. Do not hand off one coherent change in pieces, a step you do not understand yet, or the check of a small change you made.",
      `3. BRIEF A CHILD AS A CAPABLE COLLEAGUE WHO HAS NOT SEEN THIS THREAD. Do the understanding yourself: give the goal and why it matters, the file paths and findings you already have, what is off limits, and the check that proves the work. Never write "based on your findings, implement it". Leave implementation choices open unless the task requires one. Choose a concrete model for every child from ${toolRef(r, "list_models")} (\`recommendedByKind\` is advice; honor \`sessionModelContext\` when present; check effort and quota for its route) and never guess a model ID.`,
      `4. YOU STILL OWN WHAT YOU DELEGATE. Wait with ${toolRef(r, "wait_children")} instead of polling ${toolRef(r, "tree_view")}. ${toolFact(r, "wait_children", "eventDriven")} Read handoffs first (summary, sources, \`artifact_paths\`) and open detail with ${toolRef(r, "artifact_read")} only when you need it. A child's conclusion is a report to assess, not proof: check what you will build on, resolve conflicts between children, and run the combined checks yourself. ${toolFact(r, "spawn_task", "partialReturn")} ${toolFact(r, "spawn_task", "noCounts")} Resume a failed or crashed child in place with ${toolRef(r, "resume_task")} instead of starting a duplicate. ${toolRef(r, "ack_escalation")} resolves only escalations addressed to you; answer others by steering (${toolRef(r, "steer_child")}), cancelling (${toolRef(r, "cancel_child")}), or re-scoping the child.`,
      writable
        ? `5. DELIVER. Commit in your worktree, run the checks that fit the change, and put it on the base branch with ${toolRef(r, "submit_for_merge")}. ${toolFact(r, "submit_for_merge", "leadResubmit")} ${toolRef(r, "worktree_status")} shows your branch and merge state. Record what you verified against each criterion with ${toolRef(r, "report_goal_progress")}, with the evidence.`
        : `5. DELIVER. Workers merge their own slices. Check the integrated result on the base branch and record what was verified against each criterion with ${toolRef(r, "report_goal_progress")}, with the evidence.`,
      `6. NEW INPUT WHILE YOU WORK. The Director forwards what the user asks for mid-flight as a request (\`req-N\`). Decide each one with ${toolRef(r, "triage_request")} before you go on: accept it and amend your plan when it belongs to this goal and you will do it; delegate it when it belongs to this goal and a child can take it; answer it when it is a question; decline it when it is outside this goal or would put the goal at risk, and say why. Declining is not failure: the Director reschedules the work, and a thread that absorbs unrelated work finishes late and is hard to review. Treat work you find yourself the same way: send what is outside the goal back with ${toolRef(r, "route_to_director")} instead of doing it or dropping it silently.`,
      `7. WHEN YOU NEED THE USER. Choose sensible defaults for reversible decisions and say which you chose. Ask with ${toolRef(r, "ask_user")} only when a wrong guess would be expensive to reverse or only the user can know the answer. ${toolFact(r, "ask_user", "reasked")} ${toolFact(r, "ask_user", "nonBlocking")} A blocker pauses only the work that depends on it. For defects, broken tests, or conflicts outside your goal that block it, use ${toolRef(r, "report_issue")}: ${toolFact(r, "report_issue", "routing")} ${toolFact(r, "report_issue", "blockingDefault")}`,
      `8. KEEP GOING UNTIL THE GOAL IS DONE. Do not end your turn to report progress or to ask whether to continue. ${toolFact(r, "update_plan", "turnEndCheck")} End your turn when the goal is done, or when everything that is left waits on the user. Your last reply is your report to the Director, in four parts: Result (what the work does now compared with the goal, and the evidence), Not done (parts skipped and assumptions the user may want to veto, or "nothing"), Where (commits and branch, and whether they are merged), Next (the exact action the user must take, or "nothing").`,
      `9. CONTEXT. When the harness warns that context is nearly full, write an anchored handoff with ${toolRef(r, "request_rollover")} (Goal Invariants, Architectural Decisions, Active Risks, Next Actions); your plan, open requests, and the task tree come back from the harness. ${toolFact(r, "request_rollover", "progress")} If you inherited this thread from an earlier generation and need rationale the handoff lacks, call ${toolRef(r, "query_predecessor")}.`,
      `10. KNOWLEDGE BASE. Use ${toolRef(r, "kb_search")} / ${toolRef(r, "kb_get")} to reuse verified repo invariants and gotchas; propose durable findings with ${toolRef(r, "kb_propose")}, curate entries with ${toolRef(r, "kb_promote")} and ${toolRef(r, "kb_archive")}, and mark outdated ones with ${toolRef(r, "kb_flag_stale")}.`,
      `11. PACING AND PEERS. Use ${toolRef(r, "wait_timer")} or ${toolRef(r, "schedule_timer")} (with ${toolRef(r, "list_timers")} / ${toolRef(r, "cancel_timer")}) only for timed conditions such as quota resets. When another active run touches the same repository, coordinate through ${toolRef(r, "list_peer_runs")}, ${toolRef(r, "contract_publish")} / ${toolRef(r, "contract_get")}, ${toolRef(r, "peer_notify")}, ${toolRef(r, "peer_request")}, and ${toolRef(r, "peer_reply")}.`,
    ].join("\n");
  }

  if (tier === 2) {
    const r: Role = "worker";
    return [
      "You are a Tier 2 WORKER owning one feature slice inside an isolated git worktree. Edit only within your assigned write scopes. Never run `git worktree prune`, `remove`, `move`, or `unlock`: sibling worktrees are hidden from your sandbox, and the harness locks and removes worktrees itself.",
      "",
      "CORE RULES:",
      `1. OWN YOUR SLICE END-TO-END: Do the work yourself by default: cohesive multi-file edits, caller updates, and tests directly inside your worktree, so context is never lost across handoffs. For a slice with more than a few steps, record them with ${toolRef(r, "update_plan")}. ${toolFact(r, "update_plan", "survivesRollover")} Nothing ever forces you to split work to make it fit. Delegate only when it helps:`,
      `   - Start a read-only subagent (${toolRef(r, "spawn_task")}, \`kind: 'research'\`) when exploring a large unfamiliar area would fill your context with output you only need the conclusion of. Never delegate a blocker your next edit depends on. ${toolFact(r, "spawn_task", "noCounts")} ${toolFact(r, "spawn_task", "partialReturn")}`,
      "   - Decide when and how deeply to verify based on blast radius and risk: run checks proportional to the change yourself for straightforward tasks, and start an independent read-only `verify` subagent before submitting for merge only when complexity or risk genuinely warrants an independent pass.",
      "   - Discovery discipline: read enough code to understand the ownership path and contracts, then stop exploring and execute; scale verification to blast radius.",
      `2. Call ${toolRef(r, "list_models")} and use \`recommendedByKind\` to pick the right model + effort level per subagent (\`research\` -> scout; \`execute\` -> workhorse; \`verify\` -> independent verifier ideally from a different model family), honoring \`sessionModelContext\` whenever present and respecting active subscription quota buckets.`,
      `3. WORK OUTSIDE YOUR SLICE: Finish your slice even when it is large. When you find work that does not belong to it (another thread's write scope, an unrelated deliverable), do not take it on: save your findings with ${toolRef(r, "artifact_write")} and name it in your ${toolRef(r, "return_task")} handoff so your lead can place it. ${toolFact(r, "return_task", "scopeSendBack")}`,
      `4. ISSUE REPORTING: Call ${toolRef(r, "report_issue")} for defects, broken tests, or interface mismatches outside your slice that block your task, invalidate an assumption, or represent material risk; note minor unrelated findings once in your handoff. ${toolFact(r, "report_issue", "routing")} ${toolFact(r, "report_issue", "blockingDefault")} ${toolRef(r, "ack_escalation")} resolves only escalations your own children addressed to you.`,
      `5. CONTEXT HYGIENE: When the harness warns that context is nearly full or you need a different model, commit clean WIP to your worktree branch and call ${toolRef(r, "request_rollover")} with an anchored handoff summarizing state and next actions. ${toolFact(r, "request_rollover", "progress")}`,
      `6. Rely on ${toolRef(r, "wait_children")} (${toolFact(r, "wait_children", "eventDriven")} Long default fallback interval) rather than token-polling child status. Read child handoffs first with ${toolRef(r, "wait_children")}: compact summaries, sources (required for research, plan, and verify), and \`artifact_paths\`. Use ${toolRef(r, "artifact_read")} only when you need more detail. If a read-only child exits without a sourced handoff, inspect any output the harness saved for it with ${toolRef(r, "artifact_read")} (\`{ task_id }\`).`,
      `7. KNOWLEDGE BASE & TOOLS: Consult ${toolRef(r, "kb_search")} / ${toolRef(r, "kb_get")} for non-obvious repo invariants or gotchas, record verified discoveries with ${toolRef(r, "kb_propose")}, and flag outdated entries via ${toolRef(r, "kb_flag_stale")}. Use native targeted edit tools for small changes, \`rg\` for text search, and \`sg\` (\`ast-grep\`) or configured MCP tools when syntax-aware matching helps; inspect the resulting diff.`,
      `8. COMPLETION: Commit any repository changes you made, run the verification checks appropriate to your task's scope and risk, call ${toolRef(r, "report_goal_progress")} if you verified goal criteria, call ${toolRef(r, "submit_for_merge")} if you modified the repo for the base branch, then call ${toolRef(r, "return_task")} (summary limit: ${toolFact(r, "return_task", "summaryLimit")} ${toolFact(r, "return_task", "sources")}) and any \`artifact_paths\`. ${toolFact(r, "return_task", "externalDeliverable")}`,
    ].join("\n");
  }

  const r: Role = kind;
  const toolGuidance =
    kind === "execute"
      ? " Use native targeted edit tools for small edits, `rg` for text search, and `sg` (`ast-grep`) or configured MCP tools when syntax-aware matching helps."
      : kind === "verify"
        ? " Use `rg` for text search and `sg` (`ast-grep`) or configured read-only MCP tools when syntax-aware matching helps."
        : "";
  return [
    `You are a SUBAGENT in pi-harness (Tier 3, kind: ${kind}). You see only your assignment, work alone, and hand back one result.`,
    "",
    "CORE RULES:",
    isReadOnlyKind(kind)
      ? `1. Your ${kind} assignment is read-only. NEVER edit workspace files, run mutating commands, or implement changes. Inspect only the evidence needed for your assigned question.${kind === "verify" ? " You may run non-mutating verification commands (tests, linters, git diff, rg, sg, tmux); put any temporary scratch files in OS temp directories rather than inside the workspace." : ` For git history/state, searches, and tests use the ${toolRef(r, "inspect_command")} tool (argv, no shell).`}`
      : "1. Execute only the assigned change inside the task workspace and respect any read-only restriction.",
    `2. Call ${toolRef(r, "return_task")} with a summary (limit: ${toolFact(r, "return_task", "summaryLimit")}). ${toolFact(r, "return_task", "sources")}${r === "verify" ? ` ${toolFact("verify", "return_task", "verifyVerdict")}` : ""} Save details with ${toolRef(r, "artifact_write")} and pass their paths as \`artifact_paths\` rather than returning transcripts or tool logs.`,
    `3. STAY ON YOUR ASSIGNMENT AND FINISH IT. Its size is never a reason to stop: your context is compacted in place and no count ends your task. Work the harness or your parent did not ask for is not yours: name it in your handoff instead of doing it. ${toolFact(r, "return_task", "scopeSendBack")}`,
    isReadOnlyKind(kind)
      ? `4. ISSUE REPORTING: Put discovered defects, broken tests, conflicts, and ambiguities in your ${toolRef(r, "return_task")} handoff. Calls to ${toolRef(r, "report_issue")} from a read-only task are always non-blocking and you keep working (P0 goes to the human, P1 and P2 to your parent). If you cannot produce a result, call ${toolRef(r, "return_task")} with status \`blocked\` and say what is missing.`
      : `4. ISSUE REPORTING: Report discovered defects, broken tests, or assumption-invalidating ambiguities via ${toolRef(r, "report_issue")}. ${toolFact(r, "report_issue", "routing")} ${toolFact(r, "report_issue", "blockingDefault")}`,
    `5. Never attempt to spawn subagents or bypass your tool/write boundaries. Use the catalog model assigned by your parent.${toolGuidance}`,
  ].join("\n");
}

/**
 * Wrap-up turn sent once when a non-Tier-1 agent ends its turn without return_task. Keyed on tier and kind,
 * never on req.tools: code mode hides return_task behind code_exec.
 */
export function buildMissingReturnWrapUpPrompt(tier: 1 | 2 | 3, kind: TaskRecord["kind"]): string {
  const role: Role = tier === 2 ? "worker" : tier === 3 ? kind : "worker";
  const lines = [
    `Your turn ended without calling ${toolRef(role, "return_task")}, so the harness has no handoff for this task yet.`,
    "Do not start any new work.",
  ];
  if (tier === 2) {
    lines.push(
      `If you changed files for the base branch: commit them and call ${toolRef("worker", "submit_for_merge")} first. ${toolFact("worker", "return_task", "externalDeliverable")}`,
    );
  }
  lines.push(
    `Call ${toolRef(role, "return_task")} now with status, a summary (limit: ${toolFact(role, "return_task", "summaryLimit")}), ${toolFact(role, "return_task", "sources")} Include any \`artifact_paths\`.`,
  );
  return lines.join("\n");
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
  recentlyResolvedEscalations?: ReadonlyArray<RecentlyResolvedEscalation | EscalationRecord>;
  blackboard: Record<string, { value: unknown; authorTaskId: string }>;
  scopedKbHints?: KbCard[];
  openPeerRequests?: PeerExchangeRecord[];
  answeredMessages?: MessageRecord[];
  writeScopes?: string[];
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  goalEvidenceDir?: string | null;
  quotaResumeNote?: { kind?: "quota" | "resume"; reason?: string; userMessage?: string | null } | null;
  /** The task's recorded plan, shown again on every hydration so a rollover or resume cannot lose it. */
  plan?: ThreadPlan | null;
  /** Open requests of this task: forwarded user requests it must triage, and questions it asked the user. */
  openRequests?: ReadonlyArray<ThreadRequestRecord>;
}): string {
  const role = roleOf(input.task);
  const roleAllowed = allowedToolNames(role);
  const lines: string[] = [
    `# Task Assignment (${input.task.id}, tier=${input.task.tier}, gen=${input.task.generation})`,
    `Title: ${input.task.title}`,
    `Objective: ${input.task.objective}`,
  ];
  if (input.task.criteria) lines.push(`Acceptance Criteria: ${input.task.criteria}`);
  if (input.worktreePath) lines.push(`Worktree: ${input.worktreePath} (branch: ${input.worktreeBranch ?? "unknown"})`);
  if (input.writeScopes?.length && !input.task.readOnly) lines.push(`Assigned write scopes: ${JSON.stringify(input.writeScopes)}`);
  if (input.goalEvidenceDir) {
    const writable = !input.task.readOnly && (input.task.tier === 1 || input.task.tier === 2);
    lines.push(`Goal evidence directory${writable ? " (writable)" : ""}: ${input.goalEvidenceDir} (env HARNESS_GOAL_EVIDENCE_DIR)`);
  }
  if (input.task.tier === 3 && roleAllowed.has("return_task")) {
    lines.push(`Work until your result is ready, then call ${toolRef(role, "return_task")}.`);
  }
  if (input.task.tier === 1 && input.task.readOnly) lines.push("Access Mode: READ-ONLY WORKSPACE + HARNESS TOOLS");
  else if (input.task.tier !== 1 && (input.task.readOnly || isReadOnlyKind(input.task.kind))) lines.push(`Access Mode: STRICTLY READ-ONLY`);

  if (input.plan && input.plan.steps.length > 0) {
    lines.push(
      "",
      roleAllowed.has("update_plan")
        ? `## Your Plan (revision ${input.plan.revision}; keep it current with ${toolRef(role, "update_plan")})`
        : `## Your Plan (revision ${input.plan.revision})`,
      ...formatPlanForPrompt(input.plan),
    );
  } else if (input.task.tier === 1 && roleAllowed.has("update_plan")) {
    lines.push("", `No plan is recorded yet. Scope the goal, then record your plan with ${toolRef(role, "update_plan")} before you start changing things.`);
  }

  const forwarded = (input.openRequests ?? []).filter((r) => r.kind === "user_request");
  if (forwarded.length > 0 && roleAllowed.has("triage_request")) {
    lines.push("", `## Requests From The User To Triage (decide each with ${toolRef(role, "triage_request")})`);
    for (const r of forwarded.slice(0, 10)) lines.push(`- [${r.id}] ${r.title}: <user_request>${r.body.slice(0, 1200)}</user_request>`);
  }
  const asked = (input.openRequests ?? []).filter((r) => r.kind === "user_question");
  if (asked.length > 0) {
    lines.push("", "## Your Questions Waiting On The User (the harness delivers each answer when it arrives)");
    for (const r of asked.slice(0, 10)) lines.push(`- [${r.id}] ${r.title}`);
  }

  if (input.quotaResumeNote) {
    const isQuota = input.quotaResumeNote.kind === "quota";
    lines.push("", isQuota ? "## Resumed After Quota Pause" : "## Resumed Task Context");
    lines.push(
      isQuota
        ? input.task.tier === 1
          ? "This run resumed after a quota pause. Check child handoffs and the Blackboard before assigning more work."
          : "This task resumed after a quota pause. Use the existing worktree and artifacts to continue the assignment."
        : input.task.tier === 1
          ? "This run resumed in-place. Inspect current Goal/Blackboard state and child handoffs without redoing completed work."
          : "This task resumed in-place. Continue from the preserved worktree, commits, and artifacts without redoing completed work.",
    );
    if (input.quotaResumeNote.userMessage) {
      lines.push(`Resume Instruction: ${input.quotaResumeNote.userMessage}`);
    }
  }

  if (input.handoff) {
    lines.push(
      "",
      roleAllowed.has("query_predecessor")
        ? `## Predecessor Anchored Handoff (use ${toolRef(role, "query_predecessor")} if deeper rationale is needed)`
        : "## Predecessor Anchored Handoff",
    );
    lines.push(`- Goal Invariants: ${JSON.stringify(input.handoff.goalInvariants)}`);
    lines.push(`- Architectural Decisions: ${JSON.stringify(input.handoff.architecturalDecisions)}`);
    lines.push(`- Active Risks: ${JSON.stringify(input.handoff.activeRisks)}`);
    lines.push(`- Next Actions: ${JSON.stringify(input.handoff.nextActions)}`);
  }

  if (input.tasksSnapshot.length > 0) {
    const MAX_SETTLED_IN_HYDRATION = 8;
    const isSettled = (t: TaskRecord) => t.status === "completed" || t.status === "cancelled";
    const settledIndexed = input.tasksSnapshot
      .map((t, idx) => ({ t, idx }))
      .filter(({ t }) => isSettled(t));
    settledIndexed.sort((a, b) => (b.t.updatedAt - a.t.updatedAt) || (b.idx - a.idx));
    const keptSettledIds = new Set(settledIndexed.slice(0, MAX_SETTLED_IN_HYDRATION).map(({ t }) => t.id));
    const omittedSettledCount = Math.max(0, settledIndexed.length - keptSettledIds.size);
    const visibleTasks = input.tasksSnapshot.filter((t) => !isSettled(t) || keptSettledIds.has(t.id));

    lines.push("", "## Authoritative Task Tree (from SQLite DB)");
    for (const t of visibleTasks) {
      const summary = compactTaskHandoff(t).summary;
      lines.push(
        `- [${t.status}] ${t.id} (T${t.tier}/${t.kind}) "${t.title}" model=${t.model ?? t.profileId}${
          summary ? ` — ${summary.slice(0, 140)}` : ""
        }`,
      );
    }
    if (omittedSettledCount > 0) {
      const detailHint =
        roleAllowed.has("tree_view") && roleAllowed.has("task_get")
          ? ` (use ${toolRef(role, "tree_view")} or ${toolRef(role, "task_get")} for details)`
          : "";
      lines.push(`... and ${omittedSettledCount} older settled tasks${detailHint}`);
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

  const resolvedEscalations = (input.recentlyResolvedEscalations ?? []).filter(
    (e) => typeof e.resolution === "string" && e.resolution.trim().length > 0,
  );
  if (resolvedEscalations.length > 0) {
    lines.push("", "## Recently resolved escalations (human or Director answers)");
    for (const e of resolvedEscalations.slice(0, 10)) {
      lines.push(
        `- [${e.severity}/${e.category}] ${e.id} from ${e.fromTaskId}: ${e.title} -> ${e.resolution!.slice(0, 500)}`,
      );
    }
  }

  if (input.openPeerRequests && input.openPeerRequests.length > 0) {
    lines.push(
      "",
      roleAllowed.has("peer_reply")
        ? `## Open Cross-Run Peer Requests (reply via ${toolRef(role, "peer_reply")})`
        : "## Open Cross-Run Peer Requests",
    );
    for (const req of input.openPeerRequests.slice(0, 10)) {
      lines.push(
        `- [${req.id}] from ${req.fromRunId} (topic=${req.topicKey}, round=${req.round}): <untrusted_peer_input>${req.message.slice(0, 240)}</untrusted_peer_input>`,
      );
    }
  }

  if (input.answeredMessages && input.answeredMessages.length > 0) {
    lines.push("", "## Answered Peer Messages");
    for (const msg of input.answeredMessages.slice(0, 10)) {
      lines.push(
        `- [${msg.id}] to ${msg.toTaskId}: Q="${msg.question.slice(0, 120)}" -> A=<untrusted_peer_input>${(msg.answer ?? "").slice(0, 240)}</untrusted_peer_input>`,
      );
    }
  }

  const artifacts = input.artifacts.filter((a) => a.kind === "dossier" || (input.task.tier !== 1 && a.taskId === input.task.id));
  if (artifacts.length > 0) {
    const MAX_ARTIFACTS_IN_HYDRATION = 30;
    lines.push("", "## Deterministic Artifact Index (recent)");
    for (const a of artifacts.slice(0, MAX_ARTIFACTS_IN_HYDRATION)) {
      lines.push(`- [${a.kind}] ${a.path} (by ${a.taskId}): ${a.summary.slice(0, 120)}`);
    }
    const omittedArtifacts = artifacts.length - MAX_ARTIFACTS_IN_HYDRATION;
    if (omittedArtifacts > 0) {
      lines.push(
        roleAllowed.has("artifact_read")
          ? `... and ${omittedArtifacts} more, read with ${toolRef(role, "artifact_read")}`
          : `... and ${omittedArtifacts} more`,
      );
    }
  }

  const bbKeys = Object.keys(input.blackboard);
  if (bbKeys.length > 0) {
    const MAX_BB_CHARS = 500;
    lines.push("", "## Shared Decision Blackboard");
    for (const k of bbKeys) {
      const serialized = JSON.stringify(input.blackboard[k]?.value) ?? "null";
      if (serialized.length > MAX_BB_CHARS) {
        const readHint = roleAllowed.has("blackboard_get")
          ? `; call ${toolRef(role, "blackboard_get")}({ key: ${JSON.stringify(k)} }) for full payload`
          : "";
        lines.push(`- ${k}: ${serialized.slice(0, MAX_BB_CHARS)}… [truncated ${serialized.length} chars${readHint}]`);
      } else {
        lines.push(`- ${k}: ${serialized}`);
      }
    }
  }

  if (input.scopedKbHints && input.scopedKbHints.length > 0) {
    lines.push(
      "",
      roleAllowed.has("kb_get")
        ? `## Scoped Knowledge Hints (call ${toolRef(role, "kb_get")} for full context)`
        : "## Scoped Knowledge Hints",
    );
    for (const h of input.scopedKbHints.slice(0, 5)) {
      const sha = h.verifiedSha ? `@${h.verifiedSha.slice(0, 7)}` : "";
      lines.push(`- [${h.id} | ${h.kind} ${sha}] ${h.title}`);
    }
  }

  return lines.join("\n");
}
