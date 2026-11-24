import { REJECTIONS, type HarnessRejection } from "../advisories/rejections.js";
import type { Role } from "../advisories/types.js";
import type { ToolDefinition } from "../runners/types.js";

export type Schema = Record<string, unknown>;
export type PerRole<T> = { default: T } & Partial<Record<Role, T>>;

export interface ToolMention {
  tool: string;
  as: "parent" | "child" | "harness";
  roles?: readonly Role[];
}

export interface ToolEntry {
  name: string;
  roles: readonly Role[];
  /** Listing only. inspect_command is not listed for a writable execute task, but the call still runs (L20). */
  listed?: (ctx: { role: Role; readOnly: boolean }) => boolean;
  description: PerRole<string>;
  inputSchema: PerRole<Schema>;
  /** Sentences that say what the tool does, requires, or causes. Prompts and descriptions both take them from here. */
  facts?: Record<string, PerRole<string>>;
  /** L12 text for roles outside `roles`. */
  whenDenied?: Partial<Record<Role, { why: string; alternative: string }>>;
  /** Tools of another role that this entry's text may name, and in whose hands. The role-separation test honors it (NB5). */
  mentions?: ReadonlyArray<ToolMention>;
}

export const ALL_ROLES: readonly Role[] = [
  "director",
  "orchestrator",
  "worker",
  "research",
  "plan",
  "verify",
  "execute",
  "reviewer",
] as const;

export const DIRECTOR_ONLY_PHRASES = ["this chat", "another workspace", "goal contract"] as const;
export const WORKER_ONLY_PHRASES = ["write lease", "write leases", "merge queue", "your worktree", "this Worker"] as const;

const TIER3_ROLES: readonly Role[] = ["research", "plan", "verify", "execute"];
const TASK_ROLES: readonly Role[] = ["orchestrator", "worker", "research", "plan", "verify", "execute"];

const NO_COUNTS_FACT =
  "Do not state turn, tool-call, or token counts in the brief; tasks are never stopped by counts.";

const RETURN_TASK_SOURCES_DEFAULT_FACT =
  "Include structured sources (path and optional lines, symbol, note) for code you inspected.";

const RETURN_TASK_SOURCES_READ_ONLY_FACT =
  "List the files and lines you relied on; a handoff without sources is rejected unless you pass partial: true with artifact_paths.";

function returnTaskInputSchema(
  sourcesDescription: string,
  options?: { includeExternalDeliverable?: boolean },
): Schema {
  const properties: Record<string, unknown> = {
    status: { type: "string", enum: ["completed", "scope_too_large", "blocked"] },
    summary: { type: "string", description: "Compact handoff (up to 2,000 characters; longer summaries are saved as artifacts)." },
    partial: {
      type: "boolean",
      description:
        "Set true when handing back incomplete work, for example after a [harness advisory: scope-too-large] advisory. Summarize what is done, cite what you verified, list what remains.",
    },
    sources: {
      type: "array",
      description: sourcesDescription,
      items: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, lines: { type: "string" }, symbol: { type: "string" }, note: { type: "string" } },
      },
    },
    artifact_paths: { type: "array", items: { type: "string" } },
    evidence_paths: { type: "array", items: { type: "string" } },
    suggested_splits: { type: "array", items: { type: "string" } },
  };
  if (options?.includeExternalDeliverable) {
    properties.external_deliverable = {
      type: "object",
      required: ["ref"],
      description:
        "Worker-only; use when the deliverable is not meant for local main (pushed to another remote/branch, a PR URL, or an artifact/report). Completes without submit_for_merge.",
      properties: {
        ref: {
          type: "string",
          description: "Required; recorded verbatim: remote/branch, PR URL, or artifact path.",
        },
        sha: {
          type: "string",
          description: "Optional commit SHA pushed or produced, if any.",
        },
        note: {
          type: "string",
          description: "Optional note explaining why this deliverable is not merged into the base branch.",
        },
      },
    };
  }
  return {
    type: "object",
    required: ["status", "summary"],
    properties,
  };
}

const PARTIAL_RETURN_FACT =
  "A task may return early with a partial handoff and proposed splits after a [harness advisory: scope-too-large] advisory.";

const READ_ONLY_NO_SHELL_BASE =
  "Research, plan, and verify tasks have no shell. They can run only the read-only inspect_command allowlist (git reads, rg, file reads, bun test, bunx tsc --noEmit), so they cannot run builds, installs, package scripts, or other commands.";

const READ_ONLY_NO_SHELL_FACT: PerRole<string> = {
  default: `${READ_ONLY_NO_SHELL_BASE} Give that work to a Worker with spawn_worker.`,
  worker: `${READ_ONLY_NO_SHELL_BASE} Give that work to a writable kind execute task or run it yourself.`,
  director: `${READ_ONLY_NO_SHELL_BASE} Put that work in a goal.`,
};

const VERIFY_REF_DESC =
  "Branch, tag, origin/<branch> or SHA whose tree deterministic gates and the Done-Reviewer verify. Set it when the goal's work is pushed to a branch other than the run's base branch, which happens when workers push their own branch instead of merging through the queue. Resolves a local ref first, then origin/<ref>, fetching from origin if needed. Fails if it still does not resolve. Default: the run's base branch.";

const WAIT_EVENT_DRIVEN_FACT: PerRole<string> = {
  default: "Event-driven wait for child tasks (zero polling; wakes immediately on completion or escalation).",
  director:
    "Event-driven wait for child tasks (zero polling; wakes immediately on completion or escalation). Waits only within this turn; if you end your turn instead, the daemon wakes this chat only when events.wakeDirectorOnGoalSettle is enabled (default on) and the task completes, fails, blocks, or returns for re-scope (not on cancel or quota pause).",
};

const WAIT_CHILDREN_DESCRIPTION =
  "{fact:eventDriven} Optional fallback_interval_s configures a dead-agent watchdog wakeup (defaults to a long interval so you never thrash). A handoff with truncated: true carries full_summary.path/next_offset; page it with artifact_read.";

const WAIT_CHILDREN_SCHEMA: Schema = {
  type: "object",
  properties: {
    ids: { type: "array", items: { type: "string" } },
    mode: { type: "string", enum: ["any", "all"] },
    fallback_interval_s: {
      type: "number",
      description:
        "Optional fallback wakeup interval in seconds in case a child hangs or dies (default: config.events.fallbackWakeupIntervalSec, 600s).",
    },
    timeout_s: {
      type: "number",
      description: "Alias for fallback_interval_s.",
    },
  },
};

const CANCEL_CHILD_SCHEMA: Schema = {
  type: "object",
  required: ["task_id", "reason"],
  properties: {
    task_id: { type: "string" },
    reason: { type: "string" },
  },
};

const WAIT_DENIED: Partial<Record<Role, { why: string; alternative: string }>> = {
  research: {
    why: "Tier 3 tasks do not spawn child tasks, so there are no children to wait on.",
    alternative: "Complete your assignment and hand results back with return_task.",
  },
  plan: {
    why: "Tier 3 tasks do not spawn child tasks, so there are no children to wait on.",
    alternative: "Complete your assignment and hand results back with return_task.",
  },
  verify: {
    why: "Tier 3 tasks do not spawn child tasks, so there are no children to wait on.",
    alternative: "Complete your assignment and hand results back with return_task.",
  },
  execute: {
    why: "Tier 3 tasks do not spawn child tasks, so there are no children to wait on.",
    alternative: "Complete your assignment and hand results back with return_task.",
  },
  reviewer: {
    why: "Done-Reviewers do not spawn child tasks.",
    alternative: "Submit your verdict with submit_review_verdict.",
  },
};

const GOAL_TOOL_DENIED: Partial<Record<Role, { why: string; alternative: string }>> = {
  orchestrator: {
    why: "Goal lifecycle tools belong to the interactive Director.",
    alternative: "Use report_goal_progress to update your owning goal, or report_issue with severity P0 to reach the Director.",
  },
  worker: {
    why: "Goal lifecycle tools belong to the interactive Director.",
    alternative: "Use report_goal_progress for verified criteria, or return_task to report back to your Orchestrator.",
  },
  research: {
    why: "Goal lifecycle tools belong to the interactive Director.",
    alternative: "Put goal-level findings in return_task so your parent can report progress or escalate.",
  },
  plan: {
    why: "Goal lifecycle tools belong to the interactive Director.",
    alternative: "Put goal-level findings in return_task so your parent can report progress or escalate.",
  },
  verify: {
    why: "Goal lifecycle tools belong to the interactive Director.",
    alternative: "Put goal-level findings in return_task so your parent can report progress or escalate.",
  },
  execute: {
    why: "Goal lifecycle tools belong to the interactive Director.",
    alternative: "Put goal-level findings in return_task so your parent can report progress or escalate.",
  },
  reviewer: {
    why: "Goal lifecycle tools belong to the interactive Director.",
    alternative: "Record your review decision with submit_review_verdict.",
  },
};

const PRESENT_RESULT_DENIED: Partial<Record<Role, { why: string; alternative: string }>> = {
  orchestrator: {
    why: "Rendering chat cards is reserved for the interactive Director.",
    alternative: "Use report_goal_progress so the Goals view reflects your progress.",
  },
  worker: {
    why: "Rendering chat cards is reserved for the interactive Director.",
    alternative: "Use report_goal_progress or return_task to share structured results.",
  },
  research: {
    why: "Rendering chat cards is reserved for the interactive Director.",
    alternative: "Return your findings and artifact_paths through return_task.",
  },
  plan: {
    why: "Rendering chat cards is reserved for the interactive Director.",
    alternative: "Return your findings and artifact_paths through return_task.",
  },
  verify: {
    why: "Rendering chat cards is reserved for the interactive Director.",
    alternative: "Return your findings and artifact_paths through return_task.",
  },
  execute: {
    why: "Rendering chat cards is reserved for the interactive Director.",
    alternative: "Return your results through return_task.",
  },
  reviewer: {
    why: "Rendering chat cards is reserved for the interactive Director.",
    alternative: "Submit your structured verdict with submit_review_verdict.",
  },
};

const RAW_TOOL_REGISTRY: readonly ToolEntry[] = [
  // ---- Task tools (ALL_TOOL_DEFS, merged with Director shared variants) ----
  {
    name: "tree_view",
    roles: TASK_ROLES,
    description: {
      default: "Inspect the live hierarchical tree of tasks, statuses, models, context usage, and open escalations from SQLite.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          include_settled: { type: "boolean", description: "Include completed/cancelled tasks (default true)" },
        },
      },
    },
  },
  {
    name: "task_get",
    roles: TASK_ROLES,
    description: {
      default: "Get the compact handoff, indexed dossiers, and escalations for a task in this run.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["task_id"],
        properties: { task_id: { type: "string" } },
      },
    },
  },
  {
    name: "list_models",
    roles: ["director", "orchestrator", "worker"],
    description: {
      default:
        "List currently enabled latest-per-family models ranked by coding quality with cost/task, time/task, live subscription quota availability, recommendedByKind, and any per-session model selection context.",
      director:
        "Inspect enabled latest-per-family models with coding rankings, cost/time/task, live subscription quota capacity, recommendedByKind, and any per-session model selection context.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          role: { type: "string", description: "Optional role filter (orchestrator, worker_execution, codebase_research, independent_verifier)" },
          max_api_equiv_usd: { type: "number", description: "Optional upper bound on API-equivalent USD per task" },
          exclude_exhausted: { type: "boolean", description: "Hide models whose quota bucket is currently exhausted (default false)" },
        },
      },
      director: {
        type: "object",
        properties: { exclude_exhausted: { type: "boolean" } },
      },
    },
  },
  {
    name: "spawn_worker",
    roles: ["orchestrator"],
    facts: {
      noCounts: { default: NO_COUNTS_FACT },
    },
    description: {
      default:
        "Spawn a Tier 2 Worker in its own isolated git worktree with disjoint write_scopes. Workers dynamically manage sub-tasks and submit via the merge queue. {fact:noCounts}",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["objective", "write_scopes", "model"],
        properties: {
          title: { type: "string", description: "Short task title; derived from objective if omitted." },
          objective: { type: "string" },
          criteria: { type: "string" },
          write_scopes: { type: "array", items: { type: "string" }, description: "Disjoint glob patterns owned by this worker (e.g. ['src/auth/**'])" },
          profile_id: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
          position: {
            description: "Optional queue position if maxConcurrentWorkers is full: 1-based integer (1 = next up), 'front', or 'back' (default).",
          },
          force_start: {
            type: "boolean",
            description: "Emergency override: start immediately bypassing maxConcurrentWorkers. Do NOT abuse — use only for urgent blockers.",
          },
        },
      },
    },
    whenDenied: {
      worker: {
        why: "Only a Tier 1 Orchestrator creates isolated Worker worktrees and write leases.",
        alternative: "Use spawn_task for sub-tasks inside your worktree, or return_task with scope_too_large if the slice must split.",
      },
      research: {
        why: "Spawning Workers is reserved for a Tier 1 Orchestrator, which assigns worktrees and write leases.",
        alternative: "Describe the implementation slice you need in return_task so your parent can assign it.",
      },
      plan: {
        why: "Spawning Workers is reserved for a Tier 1 Orchestrator, which assigns worktrees and write leases.",
        alternative: "Describe the implementation slice you need in return_task so your parent can assign it.",
      },
      verify: {
        why: "Spawning Workers is reserved for a Tier 1 Orchestrator, which assigns worktrees and write leases.",
        alternative: "Describe the implementation slice you need in return_task so your parent can assign it.",
      },
      execute: {
        why: "Spawning Workers is reserved for a Tier 1 Orchestrator, which assigns worktrees and write leases.",
        alternative: "Describe the implementation slice you need in return_task so your parent can assign it.",
      },
      director: {
        why: "The Director launches implementation work through goals rather than spawning Workers directly.",
        alternative: "Create and commit a goal with goal_create and goal_commit, or use spawn_task for read-only lookups.",
      },
      reviewer: {
        why: "Done-Reviewers are read-only and do not spawn Workers.",
        alternative: "Record any missing work in submit_review_verdict.",
      },
    },
  },
  {
    name: "spawn_task",
    roles: ["director", "orchestrator", "worker"],
    facts: {
      noCounts: { default: NO_COUNTS_FACT },
      partialReturn: { default: PARTIAL_RETURN_FACT },
      readOnlyNoShell: READ_ONLY_NO_SHELL_FACT,
    },
    description: {
      default:
        "Spawn a read-only Tier 3 research, plan, or verify task sized to one bounded question or deliverable. Read its handoff with wait_children. {fact:readOnlyNoShell} {fact:noCounts} {fact:partialReturn}",
      worker:
        "Spawn a Tier 3 Task Agent (research, plan, execute, or verify) inside your worktree, sized to one bounded question or deliverable. Read its handoff with wait_children. Tasks compact context in place on Pi and Claude runners so long single-question reads continue, and one that ends without return_task still leaves a partial handoff. {fact:readOnlyNoShell} {fact:noCounts} {fact:partialReturn}",
      director:
        "Spawn a read-only Tier 3 research, plan, or verify task sized to one bounded question or deliverable. When your turn ends and events.wakeDirectorOnGoalSettle is enabled (default on), the daemon wakes this chat when a task you spawned completes, fails, blocks, or returns for re-scope (not on cancel or quota pause); results you already read with wait_tasks do not wake you again. {fact:readOnlyNoShell} {fact:noCounts} {fact:partialReturn}",
    },
    mentions: [{ tool: "inspect_command", as: "child" }],
    inputSchema: {
      default: {
        type: "object",
        required: ["kind", "objective", "model"],
        properties: {
          kind: { type: "string", enum: ["research", "plan", "verify"] },
          profile_id: { type: "string" },
          title: { type: "string", description: "Short task title; derived from objective if omitted." },
          objective: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
        },
      },
      worker: {
        type: "object",
        required: ["kind", "objective", "model"],
        properties: {
          kind: { type: "string", enum: ["research", "plan", "execute", "verify"] },
          title: { type: "string", description: "Short task title; derived from objective if omitted." },
          objective: { type: "string" },
          criteria: { type: "string" },
          read_only: { type: "boolean", description: "Opt an execute task into read-only access. Research, plan, and verify are always read-only." },
          profile_id: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          depends_on: { type: "array", items: { type: "string" } },
        },
      },
    },
    whenDenied: {
      research: {
        why: "Spawning is reserved for orchestrators and Workers, which hold the leases for child work.",
        alternative: "Describe the follow-up you need in return_task. Your parent decides whether to start it.",
      },
      plan: {
        why: "Spawning is reserved for orchestrators and Workers, which hold the leases for child work.",
        alternative: "Describe the follow-up you need in return_task. Your parent decides whether to start it.",
      },
      verify: {
        why: "Spawning is reserved for orchestrators and Workers, which hold the leases for child work.",
        alternative: "Describe the follow-up you need in return_task. Your parent decides whether to start it.",
      },
      execute: {
        why: "Spawning is reserved for orchestrators and Workers, which hold the leases for child work.",
        alternative: "Describe the follow-up you need in return_task. Your parent decides whether to start it.",
      },
      reviewer: {
        why: "Done-Reviewers are read-only and do not delegate sub-tasks.",
        alternative: "Inspect the checkout directly and submit your verdict with submit_review_verdict.",
      },
    },
  },
  {
    name: "wait_children",
    roles: ["director", "orchestrator", "worker"],
    facts: {
      eventDriven: WAIT_EVENT_DRIVEN_FACT,
    },
    description: {
      default: WAIT_CHILDREN_DESCRIPTION,
    },
    inputSchema: {
      default: WAIT_CHILDREN_SCHEMA,
    },
    whenDenied: WAIT_DENIED,
  },
  {
    name: "wait_tasks",
    roles: ["director", "orchestrator", "worker"],
    facts: {
      eventDriven: WAIT_EVENT_DRIVEN_FACT,
    },
    description: {
      default: WAIT_CHILDREN_DESCRIPTION,
    },
    inputSchema: {
      default: WAIT_CHILDREN_SCHEMA,
    },
    whenDenied: WAIT_DENIED,
  },
  {
    name: "steer_child",
    roles: ["orchestrator", "worker"],
    description: {
      default: "Send mid-turn steering guidance to a running child agent. Steering never restarts a settled child; spawn a new task for further work.",
      orchestrator:
        "Send mid-turn steering guidance to a running child agent. Steering never restarts a settled child; use resume_task with a note for that.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["task_id", "message"],
        properties: {
          task_id: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
  {
    name: "cancel_child",
    roles: ["orchestrator", "worker"],
    description: {
      default: "Cancel a running child task cleanly and release its write leases.",
    },
    inputSchema: {
      default: CANCEL_CHILD_SCHEMA,
    },
  },
  {
    name: "cancel_task",
    roles: ["director", "orchestrator"],
    description: {
      default: "Cancel a running child task cleanly and release its write leases.",
      director: "Cancel a running child task cleanly.",
    },
    inputSchema: {
      default: CANCEL_CHILD_SCHEMA,
    },
  },
  {
    name: "report_goal_progress",
    roles: ["director", "orchestrator", "worker"],
    description: {
      default:
        "Report live goal progress, verification status, and checked criteria results back to the owning Goal so the Goals table and cards reflect what agents are actually doing.",
      director:
        "Record live progress, verification status, or checked criterion results on a Goal so the Goals table and detail cards dynamically reflect actual work. Phase 'blocked' means the goal cannot proceed without a human: automatic verification is skipped when its run settles and the Director is woken with the summary and remediation; use it only for genuine blockers. verification_status 'failed' prevents automatic approval of this revision until progress is reported again.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["summary"],
        properties: {
          summary: { type: "string", description: "Concise live progress or verification update." },
          phase: {
            type: "string",
            description:
              "Short current phase label (e.g. 'planning', 'implementing', 'verifying'). Phase 'blocked' means you cannot proceed without a human: automatic verification is skipped when the run settles and the Director is woken with your summary and remediation. Use it only for genuine blockers.",
          },
          verification_status: {
            type: "string",
            enum: ["not_needed", "in_progress", "passed", "failed"],
            description:
              "Current verification state as decided/observed by the agent. 'failed' prevents automatic approval of this goal revision until you report again (passed, failed, or phase 'blocked').",
          },
          criteria_results: {
            type: "array",
            items: {
              type: "object",
              required: ["criterion_id", "passed", "evidence"],
              properties: {
                criterion_id: { type: "string" },
                passed: { type: "boolean" },
                evidence: { type: "string" },
                remediation: { type: "string" },
              },
            },
          },
        },
      },
      director: {
        type: "object",
        required: ["goal_id", "summary"],
        properties: {
          goal_id: { type: "string" },
          summary: { type: "string" },
          phase: { type: "string" },
          verification_status: { type: "string", enum: ["not_needed", "in_progress", "passed", "failed"] },
          criteria_results: {
            type: "array",
            items: {
              type: "object",
              required: ["criterion_id", "passed", "evidence"],
              properties: {
                criterion_id: { type: "string" },
                passed: { type: "boolean" },
                evidence: { type: "string" },
                remediation: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "return_task",
    roles: ["worker", "research", "plan", "verify", "execute"],
    facts: {
      summaryLimit: {
        default: "2,000 characters; a longer summary is saved as an artifact.",
      },
      sources: {
        default: RETURN_TASK_SOURCES_DEFAULT_FACT,
        research: RETURN_TASK_SOURCES_READ_ONLY_FACT,
        plan: RETURN_TASK_SOURCES_READ_ONLY_FACT,
        verify: RETURN_TASK_SOURCES_READ_ONLY_FACT,
      },
      verifyVerdict: {
        default:
          "A final verify returns status completed for a PASS. For a FAIL or changes-requested verdict, return status blocked with your findings in summary and sources: the task settles as completed and records a failed verification, and nothing is escalated. Only when verification could not run and no result exists, return blocked with partial: true.",
      },
      scopeSendBack: {
        default:
          "Status scope_too_large sends the task back for re-scoping; add suggested_splits, one per open area, when you can.",
        research:
          "Status scope_too_large sends the task back for re-scoping; pass sources, or partial: true with artifact_paths, and add suggested_splits, one per open area, when you can.",
        plan:
          "Status scope_too_large sends the task back for re-scoping; pass sources, or partial: true with artifact_paths, and add suggested_splits, one per open area, when you can.",
        verify:
          "Status scope_too_large sends the task back for re-scoping; pass sources, or partial: true with artifact_paths, and add suggested_splits, one per open area, when you can.",
      },
      externalDeliverable: {
        default:
          "When the deliverable is not meant for local main (pushed elsewhere or a report), pass external_deliverable {ref} instead of calling submit_for_merge.",
      },
    },
    description: {
      default: "Finish this task or send it back for re-scoping. {fact:scopeSendBack} Summary limit: {fact:summaryLimit} Sources: {fact:sources}",
      worker:
        "Finish this task or send it back for re-scoping. {fact:scopeSendBack} Summary limit: {fact:summaryLimit} Sources: {fact:sources} {fact:externalDeliverable}",
      verify:
        "Finish this task or send it back for re-scoping. {fact:scopeSendBack} Summary limit: {fact:summaryLimit} Sources: {fact:sources} {fact:verifyVerdict}",
    },
    inputSchema: {
      default: returnTaskInputSchema(RETURN_TASK_SOURCES_DEFAULT_FACT),
      worker: returnTaskInputSchema(RETURN_TASK_SOURCES_DEFAULT_FACT, { includeExternalDeliverable: true }),
      research: returnTaskInputSchema(RETURN_TASK_SOURCES_READ_ONLY_FACT),
      plan: returnTaskInputSchema(RETURN_TASK_SOURCES_READ_ONLY_FACT),
      verify: returnTaskInputSchema(RETURN_TASK_SOURCES_READ_ONLY_FACT),
    },
  },
  {
    name: "report_issue",
    roles: TASK_ROLES,
    facts: {
      blockingDefault: {
        default: "P0 and P1 end your task when the call returns unless you pass blocking: false.",
        research:
          "For read-only tasks, report_issue never blocks and your task keeps running regardless of severity or blocking flag; put findings in your return_task handoff (or call return_task with status blocked if you cannot produce a result).",
        plan:
          "For read-only tasks, report_issue never blocks and your task keeps running regardless of severity or blocking flag; put findings in your return_task handoff (or call return_task with status blocked if you cannot produce a result).",
        verify:
          "For read-only tasks, report_issue never blocks and your task keeps running regardless of severity or blocking flag; put findings in your return_task handoff (or call return_task with status blocked if you cannot produce a result).",
      },
      routing: {
        default: "P0 goes to the human, P1 and P2 to your parent.",
      },
    },
    description: {
      default:
        "Raise a discovered code defect, broken test, interface conflict, or ambiguity up the chain. {fact:routing} {fact:blockingDefault}",
      worker:
        "Raise a discovered code defect, broken test, interface conflict, or ambiguity up the chain (for scope send-backs use return_task with status scope_too_large). {fact:routing} {fact:blockingDefault}",
      execute:
        "Raise a discovered code defect, broken test, interface conflict, or ambiguity up the chain (for scope send-backs use return_task with status scope_too_large). {fact:routing} {fact:blockingDefault}",
      research:
        "Raise a discovered code defect, broken test, interface conflict, or ambiguity up the chain (for scope send-backs use return_task with status scope_too_large). {fact:routing} {fact:blockingDefault} Your parent closes findings with ack_escalation.",
      plan:
        "Raise a discovered code defect, broken test, interface conflict, or ambiguity up the chain (for scope send-backs use return_task with status scope_too_large). {fact:routing} {fact:blockingDefault} Your parent closes findings with ack_escalation.",
      verify:
        "Raise a discovered code defect, broken test, interface conflict, or ambiguity up the chain (for scope send-backs use return_task with status scope_too_large). {fact:routing} {fact:blockingDefault} Your parent closes findings with ack_escalation.",
    },
    mentions: [{ tool: "ack_escalation", as: "parent", roles: ["research", "plan", "verify"] }],
    inputSchema: {
      default: {
        type: "object",
        required: ["severity", "category", "evidence_paths"],
        properties: {
          severity: { type: "string", enum: ["P0", "P1", "P2"] },
          category: {
            type: "string",
            enum: [
              "scope_too_large",
              "code_defect",
              "broken_test",
              "interface_conflict",
              "ambiguous_spec",
              "blocked_dependency",
              "verification_failed",
              "budget_exhausted",
              "env_failure",
              "security_risk",
            ],
          },
          title: { type: "string", description: "Short issue title; derived from attempted, evidence_paths, or category if omitted." },
          evidence_paths: { type: "array", items: { type: "string" } },
          attempted: { type: "array", items: { type: "string" } },
          blocking: { type: "boolean" },
        },
      },
    },
  },
  {
    name: "ack_escalation",
    roles: ["orchestrator", "worker"],
    description: {
      default: "Acknowledge and resolve an open escalation or scope send-back from a child agent.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["escalation_id", "resolution"],
        properties: {
          escalation_id: { type: "string" },
          resolution: { type: "string" },
        },
      },
    },
  },
  {
    name: "request_rollover",
    roles: ["orchestrator", "worker"],
    facts: {
      progress: {
        default:
          "A rollover that follows another with nothing new in between (no commit, child change, newly read file, or added dossier content) stops the task.",
      },
    },
    description: {
      default:
        "Request a clean control-plane rollover to a fresh session (optionally switching model/effort) with an anchored handoff before context overflow. {fact:progress}",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_invariants", "next_actions"],
        properties: {
          goal_invariants: { type: "array", items: { type: "string" } },
          architectural_decisions: {
            type: "array",
            items: {
              type: "object",
              properties: { decision: { type: "string" }, rationale: { type: "string" } },
            },
          },
          active_risks: { type: "array", items: { type: "string" } },
          next_actions: { type: "array", items: { type: "string" } },
          target_profile_id: { type: "string" },
          target_model: { type: "string" },
          target_effort: { type: "string" },
        },
      },
    },
    whenDenied: {
      research: {
        why: "Tier 3 tasks do not call request_rollover; the harness or adapter manages context.",
        alternative: "Save findings with artifact_write and finish with return_task.",
      },
      plan: {
        why: "Tier 3 tasks do not call request_rollover; the harness or adapter manages context.",
        alternative: "Save findings with artifact_write and finish with return_task.",
      },
      verify: {
        why: "Tier 3 tasks do not call request_rollover; the harness or adapter manages context.",
        alternative: "Save findings with artifact_write and finish with return_task.",
      },
      execute: {
        why: "Tier 3 tasks do not call request_rollover; the harness or adapter manages context.",
        alternative: "Save findings with artifact_write and finish with return_task.",
      },
    },
  },
  {
    name: "query_predecessor",
    roles: ["orchestrator", "worker"],
    description: {
      default: "Search persisted SQLite event & artifact traces from predecessor generations (Seance) without loading old context.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
  },
  {
    name: "artifact_write",
    roles: TASK_ROLES,
    description: {
      default: "Write a durable research dossier, plan, or log artifact to disk and register it in the Deterministic Artifact Index.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["name", "content", "summary"],
        properties: {
          name: { type: "string" },
          content: { type: "string" },
          summary: { type: "string" },
        },
      },
    },
  },
  {
    name: "artifact_read",
    roles: ["director", ...TASK_ROLES],
    description: {
      default:
        "Read a dossier by path or list indexed artifacts for a task. Returns totalChars, hasMore and nextOffset for long files; call again with offset=nextOffset until hasMore is false.",
      orchestrator:
        "Read an indexed dossier in this run by path or list indexed artifacts for a task. Returns totalChars, hasMore and nextOffset for long files; call again with offset=nextOffset until hasMore is false.",
      worker:
        "Read a dossier by path or list indexed artifacts for a task in this run. Returns totalChars, hasMore and nextOffset for long files; call again with offset=nextOffset until hasMore is false.",
      director:
        "Read a dossier by path or list indexed artifacts for a task. Returns totalChars, hasMore and nextOffset for long files; call again with offset=nextOffset until hasMore is false. Pass task_id with path for a Director task from another workspace.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          path: { type: "string" },
          task_id: { type: "string" },
          max_chars: { type: "number" },
          offset: { type: "number", description: "Character offset for paginating large artifacts (default 0)." },
        },
      },
    },
  },
  {
    name: "inspect_command",
    roles: TIER3_ROLES,
    listed: ({ role, readOnly }) => role !== "execute" || readOnly,
    description: {
      default:
        "Run one read-only inspection command in your task workspace without a shell (no pipes, redirection, globbing, or chaining). Allowed: git status|log|diff|show|blame|rev-parse|rev-list|merge-base|ls-files|ls-tree|grep|cat-file|describe|shortlog|show-ref|for-each-ref|branch (list)|tag (list)|remote [-v|get-url]|fetch <remote> [<branch>...]|ls-remote <remote>; rg; ls, cat, head, tail, wc, nl, stat; bun test [files] [-t pattern]; bunx tsc --noEmit [-p tsconfig]. Paths must stay inside the workspace and configured read roots. Note: bun test and tsc execute repository code in the task workspace without an OS sandbox (and tsc --noEmit may write .tsbuildinfo when incremental/composite is enabled). Returns exit_code, stdout and stderr tails, and an artifact path holding the full output when it was cut. If your brief asks for a command outside this list, do what inspection allows and name the command and why it is needed in return_task so your parent can assign it to a writable task.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["argv"],
        properties: {
          argv: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: 'Command and arguments, e.g. ["git","log","-5","--oneline"].',
          },
          cwd: { type: "string", description: "Workspace-relative directory (default: workspace root)." },
          timeout_s: { type: "number", description: "Default 120; max 900 (bun test / tsc)." },
        },
      },
    },
  },
  {
    name: "blackboard_set",
    roles: ["orchestrator", "worker"],
    description: {
      default: "Publish a shared interface contract, schema, or architectural decision to the run Blackboard.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: { type: "string" },
          value: {},
        },
      },
    },
  },
  {
    name: "blackboard_get",
    roles: TASK_ROLES,
    description: {
      default: "Read one or all shared contracts/decisions from the run Blackboard.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: { key: { type: "string" } },
      },
    },
  },
  {
    name: "ask_agent",
    roles: ["orchestrator", "worker"],
    description: {
      default:
        "Send a bounded, control-plane-mediated question to another Tier 1 or Tier 2 agent in this run (no freeform chat loops). Tier 3 agents cannot reply; steer your own Tier 3 children instead.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["target_id", "question"],
        properties: {
          target_id: { type: "string" },
          question: { type: "string" },
        },
      },
    },
  },
  {
    name: "reply_agent",
    roles: ["orchestrator", "worker"],
    description: {
      default: "Reply to a mediated peer question received via `ask_agent`.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["message_id", "answer"],
        properties: {
          message_id: { type: "string" },
          answer: { type: "string" },
        },
      },
    },
  },
  {
    name: "worktree_status",
    roles: ["worker"],
    description: {
      default: "Inspect git branch, dirty state, and merge-queue status for this Worker's isolated worktree.",
    },
    inputSchema: {
      default: { type: "object", properties: {} },
    },
  },
  {
    name: "submit_for_merge",
    roles: ["worker"],
    description: {
      default: "Enqueue this Worker's committed worktree branch into the deterministic bisecting merge queue.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["summary"],
        properties: { summary: { type: "string" } },
      },
    },
    whenDenied: {
      orchestrator: {
        why: "Orchestrators are read-only planners without a Worker worktree.",
        alternative: "Assign code changes to a Worker with spawn_worker; the Worker calls submit_for_merge.",
      },
      research: {
        why: "This task is read-only and has no Worker worktree to merge.",
        alternative: "Report your findings in return_task so your parent can act on them.",
      },
      plan: {
        why: "This task is read-only and has no Worker worktree to merge.",
        alternative: "Report your findings in return_task so your parent can act on them.",
      },
      verify: {
        why: "This task is read-only and has no Worker worktree to merge.",
        alternative: "Report your findings in return_task so your parent can act on them.",
      },
      execute: {
        why: "Only the owning Worker merges commits from its worktree.",
        alternative: "Return your changes with return_task so your parent Worker can verify and submit them.",
      },
      director: {
        why: "The Director does not hold a Worker worktree or merge branches directly.",
        alternative: "Review and accept completed work through goal_trigger_review or goal_accept.",
      },
      reviewer: {
        why: "Done-Reviewers inspect a verification checkout and never merge code.",
        alternative: "Submit your verdict with submit_review_verdict.",
      },
    },
  },
  {
    name: "kb_search",
    roles: ["director", ...TASK_ROLES],
    description: {
      default: "Stage 1 KB discovery: search by FTS5 query and/or structured filters (path_globs, tags, kinds). Returns compact cards only.",
      director: "Search the workspace Knowledge Base for architectural invariants, decisions, and gotchas.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          query: { type: "string" },
          path_globs: { type: "array", items: { type: "string" } },
          tags: { type: "array", items: { type: "string" } },
          kinds: { type: "array", items: { type: "string", enum: ["invariant", "gotcha", "architecture", "decision", "convention"] } },
          include_candidates: { type: "boolean" },
          include_stale: { type: "boolean" },
          limit: { type: "number" },
        },
      },
      director: {
        type: "object",
        properties: { query: { type: "string" }, path_globs: { type: "array", items: { type: "string" } } },
      },
    },
  },
  {
    name: "kb_get",
    roles: TASK_ROLES,
    description: {
      default: "Stage 2 KB read: fetch full context_md and evidence_paths for specific KB entry IDs returned by kb_search.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["ids"],
        properties: { ids: { type: "array", items: { type: "string" } } },
      },
    },
  },
  {
    name: "kb_propose",
    roles: ["orchestrator", "worker"],
    description: {
      default:
        "Propose a high-leverage non-obvious finding as an unverified KB candidate with mandatory context_md and evidence_paths. Candidates stay hidden from default kb_search results until your orchestrator verifies them.",
      orchestrator:
        "Propose a high-leverage non-obvious finding as an unverified KB candidate with mandatory context_md and evidence_paths. Candidates stay hidden from default kb_search results until a Tier 1 Orchestrator verifies them with kb_promote.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["kind", "summary", "context_md", "evidence_paths"],
        properties: {
          kind: { type: "string", enum: ["invariant", "gotcha", "architecture", "decision", "convention"] },
          title: { type: "string", description: "Short entry title; derived from summary or context_md if omitted." },
          summary: { type: "string" },
          context_md: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          path_globs: { type: "array", items: { type: "string" } },
          evidence_paths: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  {
    name: "kb_flag_stale",
    roles: TASK_ROLES,
    description: {
      default: "Immediately flag an inaccurate or outdated KB entry as stale so other agents are not misled.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["id", "reason"],
        properties: { id: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
  {
    name: "kb_promote",
    roles: ["orchestrator"],
    description: {
      default: "Promote a candidate or stale KB entry in this repository to active/verified status.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          summary: { type: "string" },
          context_md: { type: "string" },
          verified_sha: { type: "string" },
        },
      },
    },
    whenDenied: {
      worker: {
        why: "Only a Tier 1 Orchestrator promotes KB candidates to verified status.",
        alternative: "Submit candidates with kb_propose so your Orchestrator can review and promote them.",
      },
    },
  },
  {
    name: "kb_archive",
    roles: ["orchestrator"],
    description: {
      default: "Archive an obsolete or superseded KB entry in this repository (bi-temporal; preserves history).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
          superseded_by: { type: "string" },
        },
      },
    },
  },
  {
    name: "list_peer_runs",
    roles: ["orchestrator"],
    description: {
      default: "Discover active sibling runs in harnessd, their coordination_group, repo_root, base_branch, and active write scopes.",
    },
    inputSchema: {
      default: { type: "object", properties: {} },
    },
  },
  {
    name: "contract_publish",
    roles: ["orchestrator"],
    description: {
      default: "Publish or freeze a versioned cross-run interface contract (single-writer, immutable versions, optimistic expected_version).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["namespace", "key", "payload", "summary"],
        properties: {
          namespace: { type: "string" },
          key: { type: "string" },
          payload: {},
          summary: { type: "string" },
          status: { type: "string", enum: ["draft", "frozen", "deprecated"] },
          expected_version: { type: "number" },
        },
      },
    },
  },
  {
    name: "contract_get",
    roles: ["orchestrator"],
    description: {
      default: "Read the latest or a pinned version of a cross-run contract.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["namespace", "key"],
        properties: { namespace: { type: "string" }, key: { type: "string" }, version: { type: "number" } },
      },
    },
  },
  {
    name: "peer_notify",
    roles: ["orchestrator"],
    description: {
      default: "Send a non-blocking advisory to another top-level run's Orchestrator (zero deadlock risk).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["to_run_id", "topic_key", "message"],
        properties: { to_run_id: { type: "string" }, topic_key: { type: "string" }, message: { type: "string" } },
      },
    },
  },
  {
    name: "peer_request",
    roles: ["orchestrator"],
    description: {
      default:
        "Send a bounded cross-run request to a coordinated sibling Orchestrator (enforces max_rounds=2 and DFS deadlock cycle detection).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["to_run_id", "topic_key", "message"],
        properties: {
          to_run_id: { type: "string" },
          topic_key: { type: "string" },
          message: { type: "string" },
          timeout_s: { type: "number" },
        },
      },
    },
  },
  {
    name: "peer_reply",
    roles: ["orchestrator"],
    description: {
      default: "Reply to an open cross-run peer_request and release its wait-graph edge.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["request_id", "reply"],
        properties: { request_id: { type: "string" }, reply: { type: "string" } },
      },
    },
  },
  {
    name: "wait_timer",
    roles: ["orchestrator", "worker"],
    description: {
      default:
        "Explicitly sleep with zero token burn for a duration (delay_seconds) or until an ISO timestamp (wake_at, e.g. a quota reset time), optionally waking early when a subscribed event occurs (child_settled, any). Work productively by default — use this when pacing around quota limits/resets per user/session instructions or waiting for a timed condition.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["reason"],
        properties: {
          delay_seconds: { type: "number", description: "Seconds to sleep before waking." },
          wake_at: { type: "string", description: "ISO-8601 UTC timestamp to wake at (e.g. a quota resetsAt value)." },
          reason: { type: "string", description: "Concise reason for sleeping (shown in live run telemetry)." },
          wake_on_event: {
            type: "string",
            enum: ["none", "child_settled", "any"],
            description: "Optional early-wake event trigger (default: 'none').",
          },
        },
      },
    },
  },
  {
    name: "schedule_timer",
    roles: ["director", "orchestrator", "worker"],
    description: {
      default:
        "Schedule a durable non-blocking timer (survives daemon restart) for a reminder without blocking the current turn. When it fires (or a child of yours settles, with wake_on_event child_settled/any), the reason is delivered as a steering message only if this task is still running, for example inside wait_children; it does not restart a finished task.",
      director:
        "Schedule a durable non-blocking timer (survives daemon restarts) to wake the Director after a delay or at an ISO timestamp (e.g. a model quota reset time), optionally pausing a Goal now and auto-resuming it when the timer fires. Work productively by default — use timers for self-pacing around usage/reset limits when instructed by the user or sessionModelContext, or for explicit reminders. End your turn after scheduling so the user stays unblocked.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["reason"],
        properties: {
          delay_seconds: { type: "number", description: "Seconds from now until the timer fires." },
          wake_at: { type: "string", description: "ISO-8601 UTC timestamp when the timer should fire." },
          reason: { type: "string", description: "Concise description of what to do when the timer fires." },
          wake_on_event: { type: "string", enum: ["none", "child_settled", "any"] },
        },
      },
      director: {
        type: "object",
        required: ["reason"],
        properties: {
          delay_seconds: { type: "number", description: "Seconds from now until the timer fires." },
          wake_at: { type: "string", description: "ISO-8601 UTC timestamp to wake at (e.g. quota resetsAt)." },
          reason: { type: "string", description: "Concise description of what to resume or check when the timer fires." },
          goal_id: {
            type: "string",
            description:
              "Goal ID (e.g. goal-1) this timer is bound to. Required for wake_on_event 'goal_settled' and for pause_goal/resume_goal. With 'any' it limits the goal-settlement trigger to this Goal.",
          },
          pause_goal: {
            type: "boolean",
            description: "If true (with goal_id), cleanly pause the Goal now while waiting for the timer.",
          },
          resume_goal: {
            type: "boolean",
            description: "If true (with goal_id), automatically resume the Goal's run when the timer fires.",
          },
          wake_on_event: {
            type: "string",
            enum: ["none", "user_message", "goal_settled", "any"],
            description:
              "Early cancel trigger (default: 'none'). 'user_message': a new user message supersedes the timer. 'goal_settled': requires goal_id; the timer is cancelled when that Goal's run settles, and settlement handling takes over. 'any': a user message, or goal_id settling; without goal_id, ANY Goal of this chat settling.",
          },
        },
      },
    },
  },
  {
    name: "list_timers",
    roles: ["director", "orchestrator", "worker"],
    description: {
      default: "List pending or recent durable timers owned by this task.",
      director: "List pending or recent durable timers for this Director session.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: { status: { type: "string", enum: ["pending", "fired", "cancelled"] } },
      },
    },
  },
  {
    name: "cancel_timer",
    roles: ["director", "orchestrator", "worker"],
    description: {
      default: "Cancel a pending durable timer by ID (e.g. timer-1).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["timer_id"],
        properties: { timer_id: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
  {
    name: "resume_task",
    roles: ["director", "orchestrator"],
    description: {
      default:
        "Resume a failed, crashed, blocked, or cancelled child task in-place with a recovery handoff instead of spawning a duplicate task. A Worker keeps its worktree and WIP commits when the worktree still exists; a cancelled Worker's worktree was archived, so it restarts in a fresh worktree from the base branch. Safe to repeat: when the task is already running, queued, waiting, or completed it returns its current state (outcome + message) without restarting anything.",
      director:
        "Resume a failed, crashed, cancelled, or stopped task in-place (same task ID, artifacts, and a deterministic recovery handoff) instead of spawning a new duplicate task. A Worker keeps its worktree and WIP commits while that worktree still exists; a cancelled Worker's worktree was archived, so it restarts on a fresh worktree from the base branch and the result message names the archived ref. Safe to repeat: a task that is already running, queued or completed returns its current state (`outcome`) and nothing is restarted. Resuming does not reset or impose any turn limit.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["task_id"],
        properties: {
          task_id: { type: "string", description: "Failed/crashed child task ID (e.g. t-2)." },
          note: { type: "string", description: "Optional guidance for the resumed generation." },
          model: { type: "string", description: "Optional replacement model ID from list_models." },
          effort: { type: "string", description: "Optional reasoning effort override." },
          profile_id: { type: "string", description: "Optional ACP/Pi profile override." },
        },
      },
      director: {
        type: "object",
        required: ["task_id"],
        properties: {
          task_id: { type: "string", description: "Task ID to resume (e.g. t-2)." },
          note: { type: "string", description: "Optional guidance for the resumed task." },
          model: { type: "string", description: "Optional replacement model ID from list_models." },
          effort: { type: "string", description: "Optional reasoning effort override." },
          profile_id: { type: "string", description: "Optional ACP/Pi profile override." },
        },
      },
    },
    whenDenied: {
      worker: {
        why: "Only the Director or a Tier 1 Orchestrator resumes settled tasks in place.",
        alternative: "Spawn a fresh child with spawn_task, or escalate to your Orchestrator with report_issue.",
      },
    },
  },
  {
    name: "queue_list",
    roles: ["director", "orchestrator", "worker"],
    description: {
      default: "Inspect the unified admission queue (queued goals & workers, 1-based positions, and active concurrency limits).",
      director: "Inspect the unified Goal & Worker admission queue (queued items, 1-based positions, active counts, and live concurrency limits).",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          lane: { type: "string", enum: ["goal", "worker"], description: "Optional lane filter ('goal' or 'worker')." },
        },
      },
    },
  },
  {
    name: "queue_reorder",
    roles: ["director", "orchestrator", "worker"],
    description: {
      default: "Move a queued worker (or goal) in the admission queue to any 1-based position ('front', 'back', or integer >= 1).",
      director: "Move a queued goal or worker to any 1-based position in the unified admission queue ('front', 'back', or integer >= 1).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["target_id", "position"],
        properties: {
          lane: { type: "string", enum: ["goal", "worker"], description: "Queue lane (defaults to 'worker' for t-* IDs, 'goal' for goal-* IDs)." },
          target_id: { type: "string", description: "Queued task ID (e.g. t-4) or goal ID (e.g. goal-2)." },
          position: { description: "Target position: 1-based integer (1 = next up), 'front', or 'back'." },
        },
      },
      director: {
        type: "object",
        required: ["target_id", "position"],
        properties: {
          lane: { type: "string", enum: ["goal", "worker"], description: "Queue lane (defaults to 'goal' for goal-* IDs, 'worker' for t-* IDs)." },
          target_id: { type: "string", description: "Queued goal ID (e.g. goal-3) or worker task ID (e.g. t-4)." },
          position: { description: "Target position: 1-based integer (1 = next up), 'front', or 'back'." },
        },
      },
    },
  },
  {
    name: "queue_force_start",
    roles: ["director", "orchestrator"],
    description: {
      default:
        "Emergency override: force-start a queued worker immediately bypassing maxConcurrentWorkers (and optionally bypassing a quota pause when bypass_quota=true). WARNING: Do NOT abuse this override — use only for urgent blockers or explicit user requests.",
      director:
        "Emergency override: force-start a queued goal or worker immediately bypassing maxConcurrentGoals/maxConcurrentWorkers (and optionally bypassing a quota pause when bypass_quota=true). WARNING: Do NOT abuse — use only for urgent high-priority work or explicit user requests.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["target_id"],
        properties: {
          target_id: { type: "string", description: "Queued or quota-paused worker task ID (e.g. t-4)." },
          bypass_quota: { type: "boolean", description: "If true, also force-resume even when paused on quota (use sparingly!)." },
          reason: { type: "string", description: "Brief justification for bypassing the limit." },
        },
      },
      director: {
        type: "object",
        required: ["target_id"],
        properties: {
          lane: { type: "string", enum: ["goal", "worker"], description: "Queue lane (auto-detected from goal-* vs t-* ID if omitted)." },
          target_id: { type: "string", description: "Goal ID (e.g. goal-3) or worker task ID (e.g. t-4)." },
          bypass_quota: { type: "boolean", description: "If true, also force-resume a quota-paused goal/worker despite quota exhaustion (use sparingly!)." },
          reason: { type: "string", description: "Brief justification for bypassing the concurrency or quota limit." },
        },
      },
    },
  },

  // ---- Director-only tools ----
  {
    name: "goal_create",
    roles: ["director"],
    description: {
      default:
        "Draft a structured, versioned Goal Contract with concrete deterministic check commands and behavioral/architectural acceptance criteria. " +
        "Deterministic criteria run as shell commands in a detached `_verify` git worktree that the harness creates and removes. " +
        "It checks out verify_ref when set, otherwise the linked run's base branch (the branch the primary checkout had when the run started). " +
        "Without a run or base branch, commands run in the primary checkout itself, and results say so. The primary checkout is never modified. " +
        "Commands get HARNESS_REPO_ROOT (primary checkout path), HARNESS_VERIFY_REF, HARNESS_VERIFY_SHA, HARNESS_GOAL_ID and HARNESS_GOAL_EVIDENCE_DIR. " +
        "Each gate result records the cwd, ref and SHA it ran at (goal_get reviews[].criteriaResults[].gate).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["title", "description", "criteria"],
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          criteria: {
            type: "array",
            items: {
              type: "object",
              required: ["description", "kind"],
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                kind: { type: "string", enum: ["deterministic", "behavioral", "architectural"] },
                command: { type: "string" },
                required: { type: "boolean" },
              },
            },
          },
          non_goals: { type: "array", items: { type: "string" } },
          max_review_cycles: { type: "number" },
          verification_mode: {
            type: "string",
            enum: ["auto", "none", "deterministic", "independent_review"],
            description:
              "Verification depth chosen by the agent based on risk (default 'auto': runs deterministic checks and only spawns an independent LLM reviewer if required behavioral/architectural criteria exist).",
          },
          verify_ref: { type: "string", description: VERIFY_REF_DESC },
          commit_immediately: { type: "boolean", description: "Start autonomous Tier 1 execution with the selected model" },
          model: { type: "string", minLength: 1, description: "Required for immediate commit. Select from list_models." },
          profile_id: { type: "string" },
          effort: { type: "string" },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "goal_commit",
    roles: ["director"],
    description: {
      default:
        "Commit a draft Goal Contract and launch its autonomous Tier 1 Run-Until-Done Orchestrator. If maxConcurrentGoals is full (and force_start is not set), enqueues the goal cleanly in the unified admission queue at `position` (defaults to back) and starts it automatically as soon as capacity opens. Safe to repeat and never creates a second run: a launching, running or queued goal returns its current state (`outcome`, `runId`, `goalStatus`), and a paused or stopped goal resumes its existing linked run in place.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id", "model"],
        properties: {
          goal_id: { type: "string" },
          profile_id: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          position: { description: "Optional queue position when at maxConcurrentGoals: 1-based integer (1 = front), 'front', or 'back'." },
          force_start: {
            type: "boolean",
            description: "Emergency override: start immediately bypassing maxConcurrentGoals. Do NOT abuse — use only for urgent work or explicit user requests.",
          },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "goal_accept",
    roles: ["director"],
    description: {
      default:
        "Explicit Director acceptance/override for a Goal based on verified evidence (e.g. when a review was obstructed or human approved). Requires a clear reason and concrete, readable evidence_paths (files or directories, e.g. under the goal's evidenceDir; .git, task worktrees and harness-internal state are refused). Required deterministic gates are re-run first and a failure rejects the accept unless override_deterministic is true. If the gate checkout cannot be prepared (e.g. base branch deleted), the accept proceeds and the audit records gatesNotRun. Recorded permanently with an audit trail in goal review history; auto-resolves open escalations.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id", "reason", "evidence_paths"],
        properties: {
          goal_id: { type: "string" },
          reason: { type: "string", minLength: 1, description: "Explicit rationale for accepting the goal." },
          evidence_paths: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description: "Concrete readable file/directory paths proving completion (repo-relative, absolute, or ~/).",
          },
          override_deterministic: {
            type: "boolean",
            description: "Accept even if required deterministic gates still fail (default false). The failing ids are recorded in the audit.",
          },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "steer_task",
    roles: ["director"],
    description: {
      default: "Deliver a live steering message to any running Tier 1/2/3 task across active Goal runs in this workspace.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["task_id", "message"],
        properties: {
          task_id: { type: "string" },
          message: { type: "string" },
        },
      },
    },
  },
  {
    name: "write_note",
    roles: ["director"],
    description: {
      default:
        "Logged Director note/report writer scoped strictly to `.harness/goals/`, `.harness/notes/`, or configured `extraWriteRoots` (never writes tracked repository source code).",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["path", "content", "reason"],
        properties: {
          path: { type: "string", description: "Destination file under .harness/goals/, .harness/notes/, or extraWriteRoots." },
          content: { type: "string", description: "Markdown/text content to write." },
          reason: { type: "string", description: "Concise logged reason for writing this note." },
        },
      },
    },
  },
  {
    name: "goal_amend",
    roles: ["director"],
    description: {
      default:
        "Amend an active or draft Goal Contract (vN -> vN+1), invalidating stale reviews and notifying the running Tier 1 Orchestrator with the exact delta. description REPLACES the entire description; use append_description to add instructions while keeping the existing text. add_criteria adds, update_criteria merges by id, remove_criteria_ids removes. Amending supersedes this goal's open verification_failed escalations only; other escalations stay open. Updating only verify_ref is a metadata change (does not bump version, change status, or steer running tasks); call goal_trigger_review to re-run gates.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id", "rationale"],
        properties: {
          goal_id: { type: "string" },
          rationale: { type: "string" },
          title: { type: "string" },
          description: {
            type: "string",
            description:
              "FULL REPLACEMENT of the goal description; anything not repeated here is discarded. A replacement shorter than the current description is rejected unless confirm_replace_description is true. To add instructions use append_description.",
          },
          append_description: {
            type: "string",
            description: "Text appended to the existing description after a blank line; the existing description is kept. Cannot be combined with description.",
          },
          confirm_replace_description: {
            type: "boolean",
            description: "Confirms that description intentionally replaces a longer existing description.",
          },
          add_criteria: { type: "array", items: { type: "object" } },
          update_criteria: {
            type: "array",
            description: "Partial updates merged into existing criteria by id; omitted fields keep their current values. An unknown id is rejected.",
            items: {
              type: "object",
              required: ["id"],
              properties: {
                id: { type: "string", description: "Id of an existing criterion, such as c1." },
                description: { type: "string" },
                kind: { type: "string", enum: ["deterministic", "behavioral", "architectural"] },
                command: { type: "string", description: "Shell command; required when the resulting kind is deterministic." },
                required: { type: "boolean" },
              },
            },
          },
          remove_criteria_ids: { type: "array", items: { type: "string" } },
          non_goals: { type: "array", items: { type: "string" } },
          verify_ref: {
            type: "string",
            description: `${VERIFY_REF_DESC} Pass "" to clear verify_ref and fall back to the run's base branch.`,
          },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "goal_list",
    roles: ["director"],
    description: {
      default:
        "List Goals in this workspace (or across all projects when all_projects is true) with their version, status, review cycles, and linked run IDs. Pass the returned presentation_id to present_result to show the Goals table.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          all_projects: { type: "boolean", description: "When true, list goals across all registered projects." },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "project_list",
    roles: ["director"],
    description: {
      default: "List all registered projects on this daemon host with their paths, git status/branch, and active session/goal counts.",
    },
    inputSchema: {
      default: { type: "object", properties: {} },
    },
  },
  {
    name: "project_switch",
    roles: ["director"],
    description: {
      default:
        "Rebind this chat session to another registered project (by project ID, name, or path), preserving conversation history while switching workspace cwd. Takes effect immediately for later tool calls in the same turn. Goals and delegated tasks created earlier stay with the project they were created in.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project ID (e.g. proj-1), name, or path on the daemon host." },
        },
        required: ["project"],
      },
    },
  },
  {
    name: "project_remove",
    roles: ["director"],
    description: {
      default:
        "Unregister a project from this daemon host's local project registry (by project ID, name, or path). Only the registry entry is removed: files, chat history, goals, runs and tasks are untouched and stay tied to the path. The project's name, description and default profile/model/effort are lost. The path is registered again (with a new ID) the next time a chat is opened or created there. Removing this chat's own project keeps the chat working in the same path.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          project: { type: "string", description: "Project ID (e.g. proj-1), name, or path on the daemon host." },
        },
        required: ["project"],
      },
    },
  },
  {
    name: "goal_get",
    roles: ["director"],
    description: {
      default:
        "Inspect a Goal. Default output is compact and always fits one tool result: goal header with a description excerpt and a path to the full text, " +
        "every criterion with its id, kind, required flag and latest status, a compact summary of the latest review, the run's tasks (summaries and artifact paths) and activity, and open escalations. " +
        "Narrow it with sections (goal, description, criteria, reviews, run, escalations); requesting a narrow section set (such as sections: ['criteria'] or ['reviews']) returns unclipped fields while within budget. " +
        "Page older reviews with reviews_limit (default 1, max 10; only the newest returned review includes criteriaResults) and reviews_before (pass reviewsPage.nextBefore). " +
        "Read the full description with read_file on description.path, or sections: ['description'] with description_offset (pages up to 30000 JSON chars). Read task handoff artifacts with read_file on tasks[].artifactPaths (use run_status for full run telemetry). " +
        "Pass the returned presentation_id to present_result to show the Goal detail card.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id"],
        properties: {
          goal_id: { type: "string" },
          sections: {
            type: "array",
            items: { type: "string", enum: ["goal", "description", "criteria", "reviews", "run", "escalations"] },
            description: "Sections to return. Default: goal, criteria, reviews, run, escalations (description is opt-in).",
          },
          reviews_limit: { type: "number", description: "Reviews to return, newest first. Default 1, max 10." },
          reviews_before: {
            type: "string",
            description: "Return reviews older than this review id (pass reviewsPage.nextBefore).",
          },
          description_offset: {
            type: "number",
            description: "Character offset into the full description when sections includes description. Default 0.",
          },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "present_result",
    roles: ["director"],
    description: {
      default:
        "Show one native card or table in the user's chat using a presentation_id from a result in this turn. Select the desired result from a batch and pass its ID directly. The original operation is already complete, and each ID can be used once.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["presentation_id"],
        properties: { presentation_id: { type: "string" } },
      },
    },
    whenDenied: PRESENT_RESULT_DENIED,
  },
  {
    name: "goal_wait",
    roles: ["director"],
    description: {
      default:
        "Event-driven wait for a Goal's linked autonomous run to settle (or raise a P0 escalation) without token polling. Only call when the user explicitly asks to block until completion — normally end your turn after goal_commit so the user stays unblocked and the daemon wakes you automatically. Any new user message immediately unblocks this wait without stopping background subagents.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id"],
        properties: {
          goal_id: { type: "string" },
          fallback_interval_s: {
            type: "number",
            description: "Optional fallback wakeup interval in seconds in case the run dies silently (default: config.events.fallbackWakeupIntervalSec, 600s).",
          },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "goal_trigger_review",
    roles: ["director"],
    description: {
      default:
        "Verify and settle a Goal at the chosen verification depth (defaults to the Goal's verification_mode: 'auto' runs deterministic checks and only spawns an independent LLM reviewer when required behavioral/architectural criteria exist; 'deterministic' runs checks only; 'none' approves directly). If the run's base branch was deleted and verify_ref is unset, gates fall back to the run's last merged commit (refs/harness/merged/<runId>); if neither exists, verification fails with remediation options.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id"],
        properties: {
          goal_id: { type: "string" },
          verification_mode: { type: "string", enum: ["auto", "none", "deterministic", "independent_review"] },
          summary: { type: "string", description: "Optional concise completion summary when verification_mode is 'none'." },
          override_review_budget: {
            type: "boolean",
            description:
              "Explicitly run an additional review cycle when budgets.maxReviewCycles is reached or a 'Max review cycles reached' escalation is open.",
          },
        },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "goal_pause",
    roles: ["director"],
    description: {
      default: "Pause an active Goal and stop its in-flight execution cleanly without discarding artifacts.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id"],
        properties: { goal_id: { type: "string" } },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "goal_cancel",
    roles: ["director"],
    description: {
      default: "Cancel a Goal permanently and stop its linked run.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id"],
        properties: { goal_id: { type: "string" } },
      },
    },
    whenDenied: GOAL_TOOL_DENIED,
  },
  {
    name: "resolve_escalation",
    roles: ["director"],
    description: {
      default:
        "Resolve one open or acknowledged escalation on a run owned by this chat's goals and record the reason in the audit trail. Works after the run settled or its orchestrator exited. Use it only when the finding is handled or no longer applies. The reason is steered to the run's live orchestrator and to the raising task when it is live; it does not resume the run.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["escalation_id", "reason"],
        properties: {
          escalation_id: { type: "string", description: "Escalation id, such as esc-29." },
          reason: { type: "string", description: "Why the escalation is handled or no longer applies." },
        },
      },
    },
  },
  {
    name: "read_file",
    roles: ["director"],
    facts: {
      paging: {
        default:
          "Returns one page (default 32768 bytes, up to 2097152 with max_bytes) that ends on a line boundary when possible. Select lines with start_line and end_line, or page by bytes with offset; when hasMore is true, call again with offset set to nextOffset to continue to end of file.",
      },
    },
    description: {
      default:
        "Read a UTF-8 text file: any workspace file, harness goals, notes, and artifacts, or any other file on this machine that the operator's account can read (absolute or ~/ path). {fact:paging} .git internals, task worktrees, and harness-internal state are refused. Binary files and directories are not supported.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "Workspace-relative, absolute, or ~/ path." },
          start_line: { type: "number", description: "1-based first line to return. Cannot be combined with offset." },
          end_line: { type: "number", description: "1-based last line to return, inclusive. Defaults to as many lines as fit in the page." },
          offset: {
            type: "number",
            description: "Byte offset to start from (default 0). Pass the previous result's nextOffset to continue. A negative value counts back from end of file.",
          },
          max_bytes: { type: "number", description: "Page size in bytes (default 32768, maximum 2097152)." },
          max_chars: { type: "number", description: "Optional: trim the page to at most this many UTF-16 characters (minimum 1; never splits a surrogate pair)." },
          exception_reason: { type: "string", description: "Optional note recorded with the read in the session log." },
        },
      },
    },
  },
  {
    name: "set_model_selection_context",
    roles: ["director"],
    description: {
      default:
        "Set or clear concise per-session model selection context based on the user's preferences (e.g. using a specific model for a kind of task or utilizing a model family more). Empty by default; returned to users and spawned agents when listing models.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["context"],
        properties: {
          context: {
            type: "string",
            description: "Concise per-session model routing guidance, or an empty string to clear.",
          },
        },
      },
    },
  },
  {
    name: "run_status",
    roles: ["director"],
    description: {
      default:
        "Inspect run and subagent telemetry. Pass the returned presentation_id to present_result to show the Run Activity card.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "Run ID to inspect." },
          goal_id: { type: "string", description: "Goal ID whose linked run should be inspected." },
        },
      },
    },
  },
  {
    name: "steer_run",
    roles: ["director"],
    description: {
      default: "Forward human steering guidance to an active Goal's Tier 1 Orchestrator.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["goal_id", "message"],
        properties: { goal_id: { type: "string" }, message: { type: "string" } },
      },
    },
  },
  {
    name: "resume_run",
    roles: ["director"],
    description: {
      default:
        "Resume a failed, crashed, stopped, or quota-paused run (or Goal's linked run) in-place, restarting the orchestrator and interrupted tasks with their preserved worktrees/handoffs while keeping completed work untouched. Tasks cancelled by a stop are not revived. Safe to repeat: an already running run returns its current state (`outcome`).",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          run_id: { type: "string", description: "Run ID to resume (e.g. run-1)." },
          goal_id: { type: "string", description: "Goal ID whose linked run should be resumed (e.g. goal-1)." },
          note: { type: "string", description: "Optional guidance for resumed tasks." },
        },
      },
    },
  },
  {
    name: "remote_list",
    roles: ["director"],
    description: {
      default: "List configured and connected remote peer hosts, their connection statuses, and queued outbound message counts.",
    },
    inputSchema: {
      default: { type: "object", properties: {} },
    },
  },
  {
    name: "session_list",
    roles: ["director"],
    description: {
      default:
        "List active Director chat sessions across this host AND all connected remote peer hosts. Each entry includes a unified `address` (`local:chat-1` or `gpu-box:chat-4`) usable directly in `session_send` and `session_read`.",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          host: { type: "string", description: "Optional filter: 'local' or a specific remote host alias." },
        },
      },
    },
  },
  {
    name: "session_create",
    roles: ["director"],
    description: {
      default:
        "Create a new Director chat session on this host or a connected remote peer host (optionally bound to a project on that host).",
    },
    inputSchema: {
      default: {
        type: "object",
        properties: {
          host: { type: "string", description: "Target host ('local' or a connected remote host alias; defaults to local)." },
          project: {
            type: "string",
            description: "Optional project ID, name, or path on the target host. A local session without one opens in this chat's current workspace.",
          },
          title: { type: "string", description: "Optional session title." },
        },
      },
    },
  },
  {
    name: "session_send",
    roles: ["director"],
    description: {
      default:
        "Unified cross-session messaging primitive. Send a message to another local session (`chat-2` or `local:chat-2`) or a remote peer host session (`gpu-box:chat-4`). Delivers immediately and wakes the recipient if online, or queues durably in SQLite if the remote host is offline.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["target", "message"],
        properties: {
          target: { type: "string", description: "Target session address: `chat-2`, `local:chat-2`, or `<remote-host>:<chat-id>`." },
          message: { type: "string", description: "Message body to deliver to the target session." },
          expect_reply: { type: "boolean", description: "Set to false when sending a final answer/update so the recipient does not ping-pong back." },
          reply_to_id: { type: "string", description: "Optional message ID being replied to." },
        },
      },
    },
  },
  {
    name: "session_read",
    roles: ["director"],
    description: {
      default: "Read recent transcript turns and peer message history from a local (`chat-2`) or remote (`gpu-box:chat-4`) session.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["target"],
        properties: {
          target: { type: "string", description: "Target session address: `chat-2`, `local:chat-2`, or `<remote-host>:<chat-id>`." },
          limit: { type: "number", description: "Max recent turns to return (default 12, max 50)." },
        },
      },
    },
  },

  // ---- Reviewer-only tool ----
  {
    name: "submit_review_verdict",
    roles: ["reviewer"],
    description: {
      default:
        "Submit the structured Independent Done-Review verdict. criteriaResults items are {criterionId, passed (boolean true only when verified), evidence, remediation?}; an invalid verdict is rejected with an error you can fix and resubmit.",
    },
    inputSchema: {
      default: {
        type: "object",
        required: ["verdict", "criteriaResults", "summary"],
        properties: {
          verdict: { type: "string", enum: ["approved", "changes_requested", "escalate_human"] },
          criteriaResults: {
            type: "array",
            items: {
              type: "object",
              required: ["criterionId", "passed", "evidence"],
              properties: {
                criterionId: { type: "string" },
                passed: { type: "boolean" },
                evidence: { type: "string" },
                remediation: { type: "string" },
              },
            },
          },
          blockingIssues: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        },
      },
    },
  },
];

const FACT_PLACEHOLDER_RE = /\{fact:([A-Za-z0-9_]+)\}/g;

function resolvePerRole<T>(perRole: PerRole<T>, role: Role): T {
  const override = perRole[role];
  return override !== undefined ? override : perRole.default;
}

function expandFacts(entry: ToolEntry, role: Role): string {
  const template = resolvePerRole(entry.description, role);
  return template.replace(FACT_PLACEHOLDER_RE, (_match, key: string) => {
    const fact = entry.facts?.[key];
    if (!fact) {
      throw new Error(`TOOL_REGISTRY: unknown fact "{fact:${key}}" in tool "${entry.name}" for role "${role}"`);
    }
    return resolvePerRole(fact, role);
  });
}

function validateRegistry(entries: readonly ToolEntry[]): {
  byName: ReadonlyMap<string, ToolEntry>;
  allNames: ReadonlySet<string>;
  allowedByRole: ReadonlyMap<Role, ReadonlySet<string>>;
} {
  const byName = new Map<string, ToolEntry>();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      throw new Error(`TOOL_REGISTRY: duplicate tool name "${entry.name}"`);
    }
    byName.set(entry.name, entry);
  }

  for (const entry of entries) {
    // Validate every {fact:key} placeholder in default and every role variant.
    for (const [variant, template] of Object.entries(entry.description)) {
      if (typeof template !== "string") continue;
      for (const match of template.matchAll(FACT_PLACEHOLDER_RE)) {
        const key = match[1];
        if (!key || !entry.facts?.[key]) {
          throw new Error(`TOOL_REGISTRY: unknown placeholder "{fact:${key ?? ""}}" in "${entry.name}".description.${variant}`);
        }
      }
    }
    // Validate every mentions item names a registry tool.
    if (entry.mentions) {
      for (const mention of entry.mentions) {
        if (!byName.has(mention.tool)) {
          throw new Error(`TOOL_REGISTRY: tool "${entry.name}" mentions unknown tool "${mention.tool}"`);
        }
      }
    }
  }

  const allowedByRole = new Map<Role, ReadonlySet<string>>();
  for (const role of ALL_ROLES) {
    allowedByRole.set(
      role,
      new Set(entries.filter((entry) => entry.roles.includes(role)).map((entry) => entry.name)),
    );
  }

  return {
    byName,
    allNames: new Set(byName.keys()),
    allowedByRole,
  };
}

const VALIDATED = validateRegistry(RAW_TOOL_REGISTRY);

export const TOOL_REGISTRY: readonly ToolEntry[] = RAW_TOOL_REGISTRY;

function defaultReadOnlyForRole(role: Role): boolean {
  return role !== "worker" && role !== "execute";
}

export function toolsForRole(role: Role, ctx?: { readOnly: boolean }): ToolDefinition[] {
  const readOnly = ctx?.readOnly ?? defaultReadOnlyForRole(role);
  const out: ToolDefinition[] = [];
  for (const entry of TOOL_REGISTRY) {
    if (!entry.roles.includes(role)) continue;
    if (entry.listed && !entry.listed({ role, readOnly })) continue;
    out.push({
      name: entry.name,
      description: expandFacts(entry, role),
      inputSchema: resolvePerRole(entry.inputSchema, role),
    });
  }
  return out;
}

/** All tools authorized for `role`, including tools hidden from discovery listing (e.g. inspect_command for writable execute). */
export function allowedToolsForRole(role: Role): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const entry of TOOL_REGISTRY) {
    if (!entry.roles.includes(role)) continue;
    out.push({
      name: entry.name,
      description: expandFacts(entry, role),
      inputSchema: resolvePerRole(entry.inputSchema, role),
    });
  }
  return out;
}

export function allowedToolNames(role: Role): ReadonlySet<string> {
  return VALIDATED.allowedByRole.get(role) ?? new Set<string>();
}

export function allToolNames(): ReadonlySet<string> {
  return VALIDATED.allNames;
}

export function describeTool(name: string, role: Role): string {
  const entry = VALIDATED.byName.get(name);
  if (!entry) {
    throw new Error(`describeTool: unknown tool "${name}"`);
  }
  if (!entry.roles.includes(role)) {
    throw new Error(`describeTool: tool "${name}" is not available to role "${role}"`);
  }
  return expandFacts(entry, role);
}

export function toolFact(role: Role, name: string, key: string): string {
  const entry = VALIDATED.byName.get(name);
  if (!entry || !entry.roles.includes(role)) {
    throw new Error(`toolFact: tool "${name}" is not available to role "${role}"`);
  }
  const fact = entry.facts?.[key];
  if (!fact) {
    throw new Error(`toolFact: unknown fact "${key}" on tool "${name}"`);
  }
  return resolvePerRole(fact, role);
}

export function notYourTool(name: string, role: Role): HarnessRejection {
  const entry = VALIDATED.byName.get(name);
  const denied = entry?.whenDenied?.[role];
  return REJECTIONS.notYourTool(name, role, denied);
}
