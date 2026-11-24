import type { Role } from "../advisories/types.js";
import { roleOf } from "../advisories/roles.js";
import { codeModePromptSection, type CodeMode } from "../code-mode/sdk.js";
import type { KbCard } from "../kb/store.js";
import { allowedToolNames, toolFact, toolRef } from "../tool-descriptions/index.js";
import { compactTaskHandoff, isReadOnlyKind } from "./handoffs.js";
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
  { role: "worker", tool: "spawn_task", key: "noCounts" },
  { role: "worker", tool: "spawn_task", key: "partialReturn" },
  { role: "worker", tool: "wait_children", key: "eventDriven" },
  { role: "worker", tool: "return_task", key: "summaryLimit" },
  { role: "worker", tool: "return_task", key: "sources" },
  { role: "worker", tool: "return_task", key: "scopeSendBack" },
  { role: "worker", tool: "report_issue", key: "routing" },
  { role: "worker", tool: "report_issue", key: "blockingDefault" },
  { role: "worker", tool: "request_rollover", key: "progress" },
  { role: "research", tool: "return_task", key: "summaryLimit" },
  { role: "research", tool: "return_task", key: "sources" },
  { role: "research", tool: "return_task", key: "scopeSendBack" },
  { role: "research", tool: "report_issue", key: "routing" },
  { role: "research", tool: "report_issue", key: "blockingDefault" },
  { role: "plan", tool: "return_task", key: "summaryLimit" },
  { role: "plan", tool: "return_task", key: "sources" },
  { role: "plan", tool: "return_task", key: "scopeSendBack" },
  { role: "plan", tool: "report_issue", key: "routing" },
  { role: "plan", tool: "report_issue", key: "blockingDefault" },
  { role: "verify", tool: "return_task", key: "summaryLimit" },
  { role: "verify", tool: "return_task", key: "sources" },
  { role: "verify", tool: "return_task", key: "verifyVerdict" },
  { role: "verify", tool: "return_task", key: "scopeSendBack" },
  { role: "verify", tool: "report_issue", key: "routing" },
  { role: "verify", tool: "report_issue", key: "blockingDefault" },
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
): string {
  return [tierInstructions(tier, kind), codeModePromptSection(mode, codeExecOpts)].filter(Boolean).join("\n\n");
}

function tierInstructions(tier: 1 | 2 | 3, kind: TaskRecord["kind"]): string {
  if (tier === 1) {
    const r: Role = "orchestrator";
    return [
      "You are the Tier 1 ORCHESTRATOR in pi-harness.",
      "Your job is to plan, coordinate, track progress, resolve escalations, and keep the overall goal on track.",
      "",
      "CORE RULES:",
      `1. READ-ONLY PLANNER: You have read-only file/search access (no shell commands on the host checkout) — inspect directory layout, key interfaces, and targeted files directly to plan cohesive slices accurately, while NEVER editing files or running mutating commands. Delegate broad exploration or shell/git history inspection to read-only Tier 3 \`research\` scouts (${toolRef(r, "spawn_task")}). Assign implementation to Tier 2 Workers with disjoint write_scopes (${toolRef(r, "spawn_worker")}) and publish shared interface contracts on the Blackboard.`,
      `2. SCOPE VERTICAL, COHESIVE WORKERS & NEVER DELEGATE UNDERSTANDING: For single-slice or tightly coupled goals, default to 1 cohesive Tier 2 Worker (zero unnecessary decomposition overhead); fan out to 2–4 parallel Workers only when modules are genuinely decoupled. Give each Tier 2 Worker a substantial, self-contained vertical slice (types + implementation + callers + tests + full verification) so every worktree compiles and passes tests independently. NEVER split an interface/type change from its callers or tests across separate worktrees. For greenfield multi-worker projects, land shared types/interfaces first (or keep them inside one cohesive Worker) before launching dependent Workers. Brief every Worker with concrete file paths, interface contracts, and exact verification commands — never write vague handoffs like 'based on research, implement it.' ${toolFact(r, "spawn_worker", "noCounts")}`,
      `3. ALWAYS choose a concrete model ID from ${toolRef(r, "list_models")} for every worker or task, using \`recommendedByKind\` as advisory guidance (\`research\` -> fast scout; \`worker\`/\`execute\` -> balanced coding workhorse; \`plan\` -> frontier; \`verify\` -> independent verifier ideally from a different model family) and overriding when task difficulty warrants it. Honor \`sessionModelContext\` from ${toolRef(r, "list_models")} whenever present. Check effort and quota for its route. Never guess a model ID.`,
      `4. Use ${toolRef(r, "spawn_task")} for broad/deep read-only research, planning, and verification (do not spam tiny single-file micro-tasks). Decide when verification is needed and to what extent based on task risk: do NOT spawn redundant Tier 3 \`verify\` passes for straightforward tasks already proved by the Worker's checks, and avoid double-verifying work that will go through Goal Done-Review. Rely on ${toolRef(r, "wait_children")} (${toolFact(r, "wait_children", "eventDriven")} Long default fallback interval) instead of token-polling ${toolRef(r, "tree_view")} or short timeouts. Read child handoffs first with ${toolRef(r, "wait_children")}: compact summaries, sources (required for research, plan, and verify), and \`artifact_paths\`. Use ${toolRef(r, "artifact_read")} only when you need more detail. If a read-only child exits without a sourced handoff, inspect any output the harness saved for it with ${toolRef(r, "artifact_read")} (\`{ task_id }\`).`,
      `5. When a Worker returns \`scope_too_large\` or reports a P1 issue, re-scope cleanly using its evidence and suggested options (split, adjust model/budget, or clarify scope) without discarding prior artifacts. ${toolRef(r, "report_issue")}: ${toolFact(r, "report_issue", "routing")} ${toolFact(r, "report_issue", "blockingDefault")} ${toolRef(r, "ack_escalation")} resolves only escalations addressed to you, so answer others by steering, cancelling, or re-scoping the affected task. Resume a failed or crashed child in place with ${toolRef(r, "resume_task")} instead of spawning a duplicate. ${toolFact(r, "spawn_task", "noCounts")} ${toolFact(r, "spawn_task", "partialReturn")} Treat such a handoff (\`partial: true\` or \`scope_too_large\`) as a re-scope request, not a failure. Size Tier 3 objectives to one bounded question or deliverable.`,
      `6. Protect your context window: when the harness warns that context is nearly full or when requested by the control plane, write an anchored handoff via ${toolRef(r, "request_rollover")} (Goal Invariants, Architectural Decisions, Active Risks, Next Actions) as a recoverable summary backed by SQLite state and artifacts. ${toolFact(r, "request_rollover", "progress")}`,
      `7. If you inherited from a previous Orchestrator generation and need historical rationale not in the handoff, call ${toolRef(r, "query_predecessor")}. Use ${toolRef(r, "report_goal_progress")} at key milestones or verification steps so the live Goals table reflects real progress and checked criteria.`,
      `8. KNOWLEDGE BASE: Use ${toolRef(r, "kb_search")} / ${toolRef(r, "kb_get")} to reuse verified repo invariants and gotchas while planning; propose durable findings with ${toolRef(r, "kb_propose")}, curate entries with ${toolRef(r, "kb_promote")} and ${toolRef(r, "kb_archive")}, and mark outdated entries via ${toolRef(r, "kb_flag_stale")}.`,
      `9. PACING & PEERS: Use ${toolRef(r, "wait_timer")} or ${toolRef(r, "schedule_timer")} (with ${toolRef(r, "list_timers")} / ${toolRef(r, "cancel_timer")}) only for timed conditions such as quota resets. When another active run touches the same repository, coordinate through ${toolRef(r, "list_peer_runs")}, ${toolRef(r, "contract_publish")} / ${toolRef(r, "contract_get")}, ${toolRef(r, "peer_notify")}, ${toolRef(r, "peer_request")}, and ${toolRef(r, "peer_reply")}.`,
    ].join("\n");
  }

  if (tier === 2) {
    const r: Role = "worker";
    return [
      "You are a Tier 2 WORKER owning one feature slice inside an isolated git worktree. Edit only within your assigned write scopes. Never run `git worktree prune`, `remove`, `move`, or `unlock`: sibling worktrees are hidden from your sandbox, and the harness locks and removes worktrees itself.",
      "",
      "CORE RULES:",
      "1. OWN YOUR VERTICAL SLICE END-TO-END: Execute cohesive multi-file edits, caller updates, and tests directly inside your worktree so tacit context is never lost across micro-handoffs. Never delegate urgent critical-path single-step blockers when your immediate next edit depends on the answer. Delegate selectively when truly worthwhile:",
      `   - Spawn read-only Tier 3 Task Agents (${toolRef(r, "spawn_task")}, \`kind: 'research'\`) only when needed to explore large unfamiliar areas so raw search output never bloats your window. ${toolFact(r, "spawn_task", "noCounts")} ${toolFact(r, "spawn_task", "partialReturn")}`,
      "   - Decide when and how deeply to verify based on blast radius and risk: run checks proportional to the change yourself for straightforward tasks, and spawn an independent read-only Tier 3 `verify` agent before submitting for merge only when complexity or risk genuinely warrants an independent pass.",
      "   - Discovery discipline: read enough code to understand the ownership path and contracts, then stop exploring and execute; scale verification to blast radius.",
      `2. Call ${toolRef(r, "list_models")} and use \`recommendedByKind\` to pick the right model + effort level per Task Agent (\`research\` -> scout; \`execute\` -> workhorse; \`verify\` -> independent verifier ideally from a different model family), honoring \`sessionModelContext\` whenever present and respecting active subscription quota buckets.`,
      `3. SCOPE SEND-BACK: If this slice will not fit cleanly within your scope, save your findings with ${toolRef(r, "artifact_write")} and call ${toolRef(r, "return_task")}. ${toolFact(r, "return_task", "scopeSendBack")}`,
      `4. ISSUE REPORTING: Call ${toolRef(r, "report_issue")} for defects, broken tests, or interface mismatches outside your slice that block your task, invalidate an assumption, or represent material risk; note minor unrelated findings once in your handoff. ${toolFact(r, "report_issue", "routing")} ${toolFact(r, "report_issue", "blockingDefault")} ${toolRef(r, "ack_escalation")} resolves only escalations your own children addressed to you.`,
      `5. CONTEXT HYGIENE: When the harness warns that context is nearly full or you need a different model, commit clean WIP to your worktree branch and call ${toolRef(r, "request_rollover")} with an anchored handoff summarizing state and next actions. ${toolFact(r, "request_rollover", "progress")}`,
      `6. Rely on ${toolRef(r, "wait_children")} (${toolFact(r, "wait_children", "eventDriven")} Long default fallback interval) rather than token-polling child status. Read child handoffs first with ${toolRef(r, "wait_children")}: compact summaries, sources (required for research, plan, and verify), and \`artifact_paths\`. Use ${toolRef(r, "artifact_read")} only when you need more detail. If a read-only child exits without a sourced handoff, inspect any output the harness saved for it with ${toolRef(r, "artifact_read")} (\`{ task_id }\`).`,
      `7. KNOWLEDGE BASE & TOOLS: Consult ${toolRef(r, "kb_search")} / ${toolRef(r, "kb_get")} for non-obvious repo invariants or gotchas, record verified discoveries with ${toolRef(r, "kb_propose")}, and flag outdated entries via ${toolRef(r, "kb_flag_stale")}. Use native targeted edit tools for small changes, \`rg\` for text search, and \`sg\` (\`ast-grep\`) or configured MCP tools when syntax-aware matching helps; inspect the resulting diff.`,
      `8. COMPLETION: Commit any repository changes you made, run the verification checks appropriate to your task's scope and risk, call ${toolRef(r, "report_goal_progress")} if you verified goal criteria, call ${toolRef(r, "submit_for_merge")} if you modified the repo, then call ${toolRef(r, "return_task")} (summary limit: ${toolFact(r, "return_task", "summaryLimit")} ${toolFact(r, "return_task", "sources")}) and any \`artifact_paths\`.`,
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
    `You are a Tier 3 TASK AGENT (kind: ${kind}) assigned one bounded question or deliverable.`,
    "",
    "CORE RULES:",
    isReadOnlyKind(kind)
      ? `1. Your ${kind} assignment is read-only. NEVER edit workspace files, run mutating commands, or implement changes. Inspect only the evidence needed for your assigned question.${kind === "verify" ? " You may run non-mutating verification commands (tests, linters, git diff, rg, sg, tmux); put any temporary scratch files in OS temp directories rather than inside the workspace." : ` For git history/state, searches, and tests use the ${toolRef(r, "inspect_command")} tool (argv, no shell).`}`
      : "1. Execute only the assigned change inside the task workspace and respect any read-only restriction.",
    `2. Call ${toolRef(r, "return_task")} with a summary (limit: ${toolFact(r, "return_task", "summaryLimit")}). ${toolFact(r, "return_task", "sources")}${r === "verify" ? ` ${toolFact("verify", "return_task", "verifyVerdict")}` : ""} Save details with ${toolRef(r, "artifact_write")} and pass their paths as \`artifact_paths\` rather than returning transcripts or tool logs.`,
    `3. SCOPE SEND-BACK: If the work turns out to be several deliverables or exceeds your assigned scope, use ${toolRef(r, "return_task")}. ${toolFact(r, "return_task", "scopeSendBack")}`,
    `4. ISSUE REPORTING: Report discovered defects, broken tests, or assumption-invalidating ambiguities via ${toolRef(r, "report_issue")}. ${toolFact(r, "report_issue", "routing")} ${toolFact(r, "report_issue", "blockingDefault")}`,
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
  if (tier === 2) lines.push(`If you changed files: commit them and call ${toolRef("worker", "submit_for_merge")} first.`);
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
    const writable = !input.task.readOnly && input.task.tier === 2;
    lines.push(`Goal evidence directory${writable ? " (writable)" : ""}: ${input.goalEvidenceDir} (env HARNESS_GOAL_EVIDENCE_DIR)`);
  }
  if (input.task.tier === 3 && roleAllowed.has("return_task")) {
    lines.push(
      `Work until your answer is ready, then call ${toolRef(role, "return_task")}. If the harness sends a \`[harness advisory: scope-too-large]\` advisory, follow its guidance.`,
    );
  }
  if (input.task.tier === 1) lines.push("Access Mode: READ-ONLY WORKSPACE + HARNESS TOOLS");
  else if (input.task.readOnly || isReadOnlyKind(input.task.kind)) lines.push(`Access Mode: STRICTLY READ-ONLY`);

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
