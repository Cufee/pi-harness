import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { recommendModelsByTaskKind, type ModelCatalogCompiler } from "../catalog/compiler.js";
import { CODE_EXEC_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, createCodeModeExecutor, effectiveCodeMode, exposedTools } from "../code-mode/index.js";
import type { HarnessConfig } from "../config.js";
import { codeExecEventSink } from "../protocol/tool-display.js";
import type { ToolDefinition } from "../runners/types.js";
import type { KbKind } from "../kb/store.js";
import type { BisectingMergeQueue } from "../worktree/merge-queue.js";
import type { WorktreeManager } from "../worktree/manager.js";
import type {
  AgentTier,
  ControlPlaneDb,
  EscalationCategory,
  EscalationSeverity,
  TaskKind,
  TaskRecord,
} from "./db.js";
import { dossierDirectory, readRunDossier, readWorkspaceArtifact, writeCodeOutput, writeTaskDossier } from "./dossiers.js";
import { compactTaskHandoff, isReadOnlyKind, SUMMARY_LIMIT, validateTaskHandoff } from "./handoffs.js";
import type { AnchoredHandoff } from "./prompts.js";

export { readRunDossier } from "./dossiers.js";
export { compactTaskHandoff, isReadOnlyKind, validateTaskHandoff } from "./handoffs.js";

export interface ToolRuntimeHooks {
  spawnAndStartTask: (input: {
    runId: string;
    parentId: string;
    tier: AgentTier;
    kind: TaskKind;
    title: string;
    objective: string;
    criteria?: string;
    readOnly: boolean;
    profileId?: string;
    model?: string;
    effort?: string;
    maxTurns?: number;
    dependsOn?: string[];
    writeScopes?: string[];
  }) => Promise<TaskRecord>;
  waitForChildren: (parentId: string, ids: string[] | undefined, mode: "any" | "all", timeoutMs: number) => Promise<TaskRecord[]>;
  steerTask: (taskId: string, message: string) => Promise<boolean>;
  cancelTask: (taskId: string, reason: string) => Promise<void>;
  scheduleRollover: (taskId: string, handoff: AnchoredHandoff, target?: { profileId?: string; model?: string; effort?: string }) => Promise<void>;
  getWorktreeManager: (repoRoot: string) => WorktreeManager;
  getMergeQueue: (repoRoot: string) => BisectingMergeQueue;
  getTaskSignal: (taskId: string) => AbortSignal | undefined;
}

function requiredModel(args: Record<string, unknown>) {
  if (typeof args.model !== "string" || !args.model.trim()) throw new Error("Choose a nonblank model from list_models.");
  return args.model.trim();
}

function optionalProfile(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("Select an enabled runner profile.");
  return value;
}

const waitChildrenTool: ToolDefinition = {
  name: "wait_children",
  description:
    "Event-driven wait for child tasks (zero polling; wakes immediately on completion or escalation). Optional fallback_interval_s configures a dead-agent watchdog wakeup (defaults to a long interval so you never thrash).",
  inputSchema: {
    type: "object",
    properties: {
      ids: { type: "array", items: { type: "string" } },
      mode: { type: "string", enum: ["any", "all"] },
      fallback_interval_s: {
        type: "number",
        description: "Optional fallback wakeup interval in seconds in case a child hangs or dies (default: config.events.fallbackWakeupIntervalSec, 600s).",
      },
      timeout_s: {
        type: "number",
        description: "Alias for fallback_interval_s.",
      },
    },
  },
};

const cancelChildTool: ToolDefinition = {
  name: "cancel_child",
  description: "Cancel a running child task cleanly and release its write leases.",
  inputSchema: {
    type: "object",
    required: ["task_id", "reason"],
    properties: {
      task_id: { type: "string" },
      reason: { type: "string" },
    },
  },
};

const ALL_TOOL_DEFS: Array<ToolDefinition & { tiers: AgentTier[] }> = [
  {
    name: "tree_view",
    tiers: [1, 2, 3],
    description: "Inspect the live hierarchical tree of tasks, statuses, models, context usage, and open escalations from SQLite.",
    inputSchema: {
      type: "object",
      properties: {
        include_settled: { type: "boolean", description: "Include completed/cancelled tasks (default true)" },
      },
    },
  },
  {
    name: "task_get",
    tiers: [1, 2, 3],
    description: "Get the compact handoff, indexed dossiers, and escalations for a task in this run.",
    inputSchema: {
      type: "object",
      required: ["task_id"],
      properties: { task_id: { type: "string" } },
    },
  },
  {
    name: "list_models",
    tiers: [1, 2],
    description:
      "List currently enabled latest-per-family models ranked by coding quality with cost/task, time/task, live subscription quota availability, recommendedByKind, and any per-session model selection context.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", description: "Optional role filter (orchestrator, worker_execution, codebase_research, independent_verifier)" },
        max_api_equiv_usd: { type: "number", description: "Optional upper bound on API-equivalent USD per task" },
        exclude_exhausted: { type: "boolean", description: "Hide models whose quota bucket is currently exhausted (default false)" },
      },
    },
  },
  {
    name: "spawn_worker",
    tiers: [1],
    description:
      "Spawn a Tier 2 Worker in its own isolated git worktree with disjoint write_scopes. Workers dynamically manage sub-tasks and submit via the merge queue.",
    inputSchema: {
      type: "object",
      required: ["title", "objective", "write_scopes", "model"],
      properties: {
        title: { type: "string" },
        objective: { type: "string" },
        criteria: { type: "string" },
        write_scopes: { type: "array", items: { type: "string" }, description: "Disjoint glob patterns owned by this worker (e.g. ['src/auth/**'])" },
        profile_id: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        depends_on: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "spawn_task",
    tiers: [1],
    description: "Spawn a read-only Tier 3 research, plan, or verify task. Read its handoff with wait_children.",
    inputSchema: {
      type: "object",
      required: ["kind", "title", "objective", "model"],
      properties: {
        kind: { type: "string", enum: ["research", "plan", "verify"] },
        profile_id: { type: "string" },
        title: { type: "string" },
        objective: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
      },
    },
  },
  {
    name: "spawn_task",
    tiers: [2],
    description:
      "Spawn a small, zero-compaction Tier 3 Task Agent (research, plan, execute, or verify) inside this Worker's worktree.",
    inputSchema: {
      type: "object",
      required: ["kind", "title", "objective", "model"],
      properties: {
        kind: { type: "string", enum: ["research", "plan", "execute", "verify"] },
        title: { type: "string" },
        objective: { type: "string" },
        criteria: { type: "string" },
        read_only: { type: "boolean", description: "Opt an execute task into read-only access. Research, plan, and verify are always read-only." },
        profile_id: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        max_turns: { type: "number" },
        depends_on: { type: "array", items: { type: "string" } },
      },
    },
  },
  { ...waitChildrenTool, tiers: [1, 2] },
  { ...waitChildrenTool, name: "wait_tasks", tiers: [1, 2] },
  {
    name: "steer_child",
    tiers: [1, 2],
    description: "Send mid-turn steering guidance to a running child agent.",
    inputSchema: {
      type: "object",
      required: ["task_id", "message"],
      properties: {
        task_id: { type: "string" },
        message: { type: "string" },
      },
    },
  },
  { ...cancelChildTool, tiers: [1, 2] },
  { ...cancelChildTool, name: "cancel_task", tiers: [1] },
  {
    name: "return_task",
    tiers: [2, 3],
    description:
      "Finish this task OR send it back up the chain if scope is too large (`scope_too_large` requires evidence_paths and >= 2 suggested_splits).",
    inputSchema: {
      type: "object",
      required: ["status", "summary"],
      properties: {
        status: { type: "string", enum: ["completed", "scope_too_large", "blocked"] },
        summary: { type: "string", description: "Compact handoff (up to 2,000 characters; longer summaries are saved as artifacts)." },
        sources: {
          type: "array",
          description: "Evidence references. Required and non-empty for research, plan, and verify tasks.",
          items: {
            type: "object",
            required: ["path"],
            properties: { path: { type: "string" }, lines: { type: "string" }, symbol: { type: "string" }, note: { type: "string" } },
          },
        },
        artifact_paths: { type: "array", items: { type: "string" } },
        evidence_paths: { type: "array", items: { type: "string" } },
        suggested_splits: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "report_issue",
    tiers: [1, 2, 3],
    description: "Raise a discovered code defect, broken test, interface conflict, or ambiguity up the chain.",
    inputSchema: {
      type: "object",
      required: ["severity", "category", "title", "evidence_paths"],
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
        title: { type: "string" },
        evidence_paths: { type: "array", items: { type: "string" } },
        attempted: { type: "array", items: { type: "string" } },
        blocking: { type: "boolean" },
      },
    },
  },
  {
    name: "ack_escalation",
    tiers: [1, 2],
    description: "Acknowledge and resolve an open escalation or scope send-back from a child agent.",
    inputSchema: {
      type: "object",
      required: ["escalation_id", "resolution"],
      properties: {
        escalation_id: { type: "string" },
        resolution: { type: "string" },
      },
    },
  },
  {
    name: "request_rollover",
    tiers: [1, 2],
    description:
      "Request a clean control-plane rollover to a fresh session (optionally switching model/effort) with an anchored handoff before context overflow.",
    inputSchema: {
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
  {
    name: "query_predecessor",
    tiers: [1, 2],
    description: "Search persisted SQLite event & artifact traces from predecessor generations (Seance) without loading old context.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: {
        query: { type: "string" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "artifact_write",
    tiers: [1, 2, 3],
    description: "Write a durable research dossier, plan, or log artifact to disk and register it in the Deterministic Artifact Index.",
    inputSchema: {
      type: "object",
      required: ["name", "content", "summary"],
      properties: {
        name: { type: "string" },
        content: { type: "string" },
        summary: { type: "string" },
      },
    },
  },
  {
    name: "artifact_read",
    tiers: [1, 2, 3],
    description: "Read a dossier by path (Tier 1: indexed dossiers in this run only) or list indexed artifacts for a task.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        task_id: { type: "string" },
        max_chars: { type: "number" },
      },
    },
  },
  {
    name: "blackboard_set",
    tiers: [1, 2],
    description: "Publish a shared interface contract, schema, or architectural decision to the run Blackboard.",
    inputSchema: {
      type: "object",
      required: ["key", "value"],
      properties: {
        key: { type: "string" },
        value: {},
      },
    },
  },
  {
    name: "blackboard_get",
    tiers: [1, 2, 3],
    description: "Read one or all shared contracts/decisions from the run Blackboard.",
    inputSchema: {
      type: "object",
      properties: { key: { type: "string" } },
    },
  },
  {
    name: "ask_agent",
    tiers: [1, 2],
    description: "Send a bounded, control-plane-mediated question to another agent in this run (no freeform chat loops).",
    inputSchema: {
      type: "object",
      required: ["target_id", "question"],
      properties: {
        target_id: { type: "string" },
        question: { type: "string" },
      },
    },
  },
  {
    name: "reply_agent",
    tiers: [1, 2],
    description: "Reply to a mediated peer question received via `ask_agent`.",
    inputSchema: {
      type: "object",
      required: ["message_id", "answer"],
      properties: {
        message_id: { type: "string" },
        answer: { type: "string" },
      },
    },
  },
  {
    name: "worktree_status",
    tiers: [2],
    description: "Inspect git branch, dirty state, and merge-queue status for this Worker's isolated worktree.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "submit_for_merge",
    tiers: [2],
    description: "Enqueue this Worker's committed worktree branch into the deterministic bisecting merge queue.",
    inputSchema: {
      type: "object",
      required: ["summary"],
      properties: { summary: { type: "string" } },
    },
  },
  // ---- Curated Knowledge Base (2-stage progressive disclosure) ----
  {
    name: "kb_search",
    tiers: [1, 2, 3],
    description: "Stage 1 KB discovery: search by FTS5 query and/or structured filters (path_globs, tags, kinds). Returns compact cards only.",
    inputSchema: {
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
  },
  {
    name: "kb_get",
    tiers: [1, 2, 3],
    description: "Stage 2 KB read: fetch full context_md and evidence_paths for specific KB entry IDs returned by kb_search.",
    inputSchema: {
      type: "object",
      required: ["ids"],
      properties: { ids: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "kb_propose",
    tiers: [1, 2],
    description:
      "Propose a high-leverage non-obvious finding as a KB candidate with mandatory context_md and evidence_paths for the Knowledge Maintainer.",
    inputSchema: {
      type: "object",
      required: ["kind", "title", "summary", "context_md", "evidence_paths"],
      properties: {
        kind: { type: "string", enum: ["invariant", "gotcha", "architecture", "decision", "convention"] },
        title: { type: "string" },
        summary: { type: "string" },
        context_md: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        path_globs: { type: "array", items: { type: "string" } },
        evidence_paths: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "kb_flag_stale",
    tiers: [1, 2, 3],
    description: "Immediately flag an inaccurate or outdated KB entry as stale so other agents are not misled.",
    inputSchema: {
      type: "object",
      required: ["id", "reason"],
      properties: { id: { type: "string" }, reason: { type: "string" } },
    },
  },
  // ---- Cross-Run Coordination (strictly Tier 1 Orchestrator-to-Orchestrator) ----
  {
    name: "list_peer_runs",
    tiers: [1],
    description: "Discover active sibling runs in harnessd, their coordination_group, repo_root, base_branch, and active write scopes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "contract_publish",
    tiers: [1],
    description: "Publish or freeze a versioned cross-run interface contract (single-writer, immutable versions, optimistic expected_version).",
    inputSchema: {
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
  {
    name: "contract_get",
    tiers: [1],
    description: "Read the latest or a pinned version of a cross-run contract.",
    inputSchema: {
      type: "object",
      required: ["namespace", "key"],
      properties: { namespace: { type: "string" }, key: { type: "string" }, version: { type: "number" } },
    },
  },
  {
    name: "peer_notify",
    tiers: [1],
    description: "Send a non-blocking advisory to another top-level run's Orchestrator (zero deadlock risk).",
    inputSchema: {
      type: "object",
      required: ["to_run_id", "topic_key", "message"],
      properties: { to_run_id: { type: "string" }, topic_key: { type: "string" }, message: { type: "string" } },
    },
  },
  {
    name: "peer_request",
    tiers: [1],
    description:
      "Send a bounded cross-run request to a coordinated sibling Orchestrator (enforces max_rounds=2 and DFS deadlock cycle detection).",
    inputSchema: {
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
  {
    name: "peer_reply",
    tiers: [1],
    description: "Reply to an open cross-run peer_request and release its wait-graph edge.",
    inputSchema: {
      type: "object",
      required: ["request_id", "reply"],
      properties: { request_id: { type: "string" }, reply: { type: "string" } },
    },
  },
];

export function toolsForTier(tier: AgentTier): ToolDefinition[] {
  return ALL_TOOL_DEFS.filter((t) => t.tiers.includes(tier)).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
}

export class ControlPlaneToolExecutor {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly getCatalogCompiler: () => ModelCatalogCompiler,
    private readonly hooks: ToolRuntimeHooks,
    private readonly config: HarnessConfig,
  ) {}

  tools(tier: AgentTier): ToolDefinition[] {
    return exposedTools(toolsForTier(tier), this.config.codeMode);
  }

  async execute(runId: string, taskId: string, name: string, args: Record<string, unknown>, scriptSignal?: AbortSignal): Promise<unknown> {
    const task = this.db.getTask(taskId);
    if (!task || task.runId !== runId) {
      throw new Error(`Task ${taskId} not found in run ${runId}`);
    }
    const mode = effectiveCodeMode(this.config.codeMode);
    if (scriptSignal || (name === CODE_EXEC_TOOL_NAME && mode !== "off")) {
      const signal = scriptSignal ?? this.hooks.getTaskSignal(taskId);
      if (!signal || signal.aborted || ["completed", "cancelled", "failed", "returned_for_rescope", "paused_quota"].includes(task.status)) {
        throw new Error(`code_exec requires an active task generation for ${taskId}`);
      }
    }
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    if (name === "__list_tools") {
      return this.tools(task.tier);
    }
    if (mode !== "off" && (name === CODE_EXEC_TOOL_NAME || name === TOOL_SEARCH_TOOL_NAME)) {
      const signal = this.hooks.getTaskSignal(taskId);
      return createCodeModeExecutor({
        ...this.config.codeExec,
        mode,
        allowedTools: () => toolsForTier(task.tier),
        execute: (inner, input) => this.execute(runId, taskId, inner, input, signal),
        artifactsDir: resolve(run.repoRoot, this.config.worktree.artifactsDir ?? ".harness/artifacts"),
        saveOutput: (name, json) => writeCodeOutput(this.db, run, taskId, name, json),
        signal,
        onToolEvent: codeExecEventSink((ev) => this.db.emitEvent(runId, taskId, "agent.tool", ev)),
      }).execute(name, args);
    }

    const allowed = new Set(toolsForTier(task.tier).map((t) => t.name));
    if (!allowed.has(name)) {
      throw new Error(`Tool '${name}' is not permitted for Tier ${task.tier} agent ${taskId}`);
    }

    switch (name) {
      case "tree_view": {
        const includeSettled = args.include_settled !== false;
        const tasks = this.db
          .listTasks(runId)
          .filter((t) => includeSettled || !["completed", "cancelled", "failed"].includes(t.status));
        const escalations = this.db.listEscalations(runId, "open");
        const pendingMsgs = this.db.listOpenMessages(taskId);
        return {
          run: { id: run.id, goal: run.goal, status: run.status, baseBranch: run.baseBranch },
          tasks: tasks.map((t) => ({
            id: t.id,
            parentId: t.parentId,
            tier: t.tier,
            kind: t.kind,
            title: t.title,
            status: t.status,
            model: t.model ?? t.profileId,
            effort: t.effort,
            gen: t.generation,
            ctxPct: t.contextSize > 0 ? Math.round((t.contextUsed / t.contextSize) * 100) : null,
            summary: compactTaskHandoff(t).summary,
          })),
          openEscalations: escalations,
          inboxMessages: pendingMsgs.map((m) => ({
            id: m.id,
            from: m.fromTaskId,
            question: `<untrusted_peer_input>${m.question}</untrusted_peer_input>`,
          })),
        };
      }

      case "task_get": {
        const target = this.db.getTask(String(args.task_id));
        if (!target || target.runId !== runId) throw new Error(`Unknown task ${args.task_id}`);
        return {
          task: compactTaskHandoff(target),
          artifacts: this.db.listArtifacts(runId, target.id, 30, "dossier"),
          escalations: this.db.listEscalations(runId).filter((e) => e.fromTaskId === target.id || e.toTaskId === target.id),
        };
      }

      case "list_models": {
        const compiled = await this.getCatalogCompiler().getCatalog({
          cwd: run.repoRoot,
          role: typeof args.role === "string" ? args.role : undefined,
          maxApiEquivUsd: typeof args.max_api_equiv_usd === "number" ? args.max_api_equiv_usd : undefined,
          excludeExhausted: Boolean(args.exclude_exhausted),
        });
        return {
          syncedAt: compiled.syncedAt,
          sources: compiled.sources,
          sessionModelContext: this.resolveSessionModelContext(runId),
          recommendedByKind: recommendModelsByTaskKind(compiled.models, { avoidModelId: task.model }),
          models: compiled.models.map((m) => ({
            id: m.id,
            family: m.family,
            rank: m.codingRank,
            codingScore: m.codingScore,
            profile: m.preferredRoute.profileId,
            wireModel: m.preferredRoute.wireModelId,
            billing: m.preferredRoute.billing,
            efforts: m.efforts,
            contextK: m.contextK,
            costPerTaskUsd: m.costPerTaskUsd,
            apiEquivCostUsd: m.apiEquivCostUsd,
            timePerTaskS: m.timePerTaskSeconds,
            quota: m.quota
              ? {
                  availability: m.quota.availabilityName,
                  exhausted: m.quota.exhausted,
                  remainingPct:
                    m.quota.effectiveRemainingRatio === null ? null : Math.round(m.quota.effectiveRemainingRatio * 100),
                  bucket: m.quota.bindingBucketId,
                  nextAvailableAt: m.quota.nextAvailableAt,
                }
              : null,
            recommendedFor: m.recommendedFor,
          })),
        };
      }

      case "spawn_worker": {
        if (task.status === "draining") {
          throw new Error("Orchestrator is DRAINING for rollover — finish handoff instead of spawning new workers.");
        }
        const writeScopes = Array.isArray(args.write_scopes) ? (args.write_scopes as string[]) : [];
        if (writeScopes.length === 0) throw new Error("spawn_worker requires non-empty write_scopes");
        const created = await this.hooks.spawnAndStartTask({
          runId,
          parentId: taskId,
          tier: 2,
          kind: "worker",
          title: String(args.title),
          objective: String(args.objective),
          criteria: typeof args.criteria === "string" ? args.criteria : "",
          readOnly: false,
          profileId: optionalProfile(args.profile_id),
          model: requiredModel(args),
          effort: typeof args.effort === "string" ? args.effort : undefined,
          dependsOn: Array.isArray(args.depends_on) ? (args.depends_on as string[]) : [],
          writeScopes,
        });
        return { spawned: created.id, status: created.status, worktreeId: created.worktreeId };
      }

      case "spawn_task": {
        const kind = String(args.kind);
        const readOnlyKind = isReadOnlyKind(kind);
        const fromOrchestrator = task.tier === 1;
        if (fromOrchestrator && !readOnlyKind) {
          throw new Error("Tier 1 spawn_task only permits research, plan, and verify; use spawn_worker for implementation.");
        }
        if (!readOnlyKind && kind !== "execute") throw new Error(`Unknown spawn_task kind: ${kind}`);
        if (task.status === "draining") throw new Error("Cannot spawn tasks while draining for rollover.");

        const created = await this.hooks.spawnAndStartTask({
          runId,
          parentId: taskId,
          tier: 3,
          kind,
          title: String(args.title),
          objective: String(args.objective),
          criteria: !fromOrchestrator && typeof args.criteria === "string" ? args.criteria : "",
          readOnly: readOnlyKind || args.read_only === true,
          profileId: optionalProfile(args.profile_id),
          model: requiredModel(args),
          effort: typeof args.effort === "string" ? args.effort : undefined,
          maxTurns: !fromOrchestrator && typeof args.max_turns === "number" ? args.max_turns : undefined,
          dependsOn: !fromOrchestrator && Array.isArray(args.depends_on) ? (args.depends_on as string[]) : [],
        });
        return { spawned: created.id, kind: created.kind, readOnly: created.readOnly, status: created.status };
      }

      case "wait_tasks":
      case "wait_children": {
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : undefined;
        const mode = args.mode === "any" ? "any" : "all";
        const defaultSec = this.config.events?.fallbackWakeupIntervalSec ?? 600;
        const requestedSec =
          typeof args.fallback_interval_s === "number"
            ? args.fallback_interval_s
            : typeof args.timeout_s === "number"
              ? args.timeout_s
              : defaultSec;
        const timeoutMs = Math.max(1, requestedSec) * 1000;
        const settled = await this.hooks.waitForChildren(taskId, ids, mode, timeoutMs);
        const escalations = this.db.listEscalations(runId);
        const stillRunning = settled.filter((c) => ["running", "ready", "pending", "draining", "waiting_children", "merging"].includes(c.status));
        return {
          children: settled.map((child) => compactTaskHandoff(child, escalations)),
          ...(stillRunning.length > 0
            ? {
                wakeReason: "fallback_interval",
                hint: "Fallback wakeup fired while child task(s) are still in progress; wait again with wait_children rather than short-polling.",
              }
            : {}),
        };
      }

      case "steer_child":
      case "cancel_task":
      case "cancel_child": {
        const childId = String(args.task_id);
        const child = this.db.getTask(childId);
        if (!child || child.runId !== runId || child.parentId !== taskId) throw new Error(`Unknown child task ${childId}`);
        if (name === "steer_child") return { steered: await this.hooks.steerTask(childId, String(args.message)) };
        await this.hooks.cancelTask(childId, String(args.reason));
        return { cancelled: childId };
      }

      case "return_task": {
        const status = String(args.status);
        if (status !== "completed" && status !== "blocked" && status !== "scope_too_large") {
          throw new Error("return_task requires status completed, blocked, or scope_too_large");
        }
        const { summary: fullSummary, sources, artifactPaths } = validateTaskHandoff(task.kind, args);
        let summary = fullSummary;

        if (status === "completed") {
          const activeKids = this.db
            .listTasks(runId, { parentId: taskId })
            .filter((c) => ["running", "ready", "pending", "waiting_children", "merging"].includes(c.status));
          if (activeKids.length > 0) {
            throw new Error(
              `Settlement gate rejected completion: ${activeKids.length} child task(s) are still active (${activeKids.map((k) => k.id).join(", ")}).`,
            );
          }
          if (task.tier === 2 && task.worktreeId) {
            const wt = this.db.getWorktree(task.worktreeId);
            if (wt && wt.status === "active" && await this.hooks.getWorktreeManager(run.repoRoot).isDirty(wt.path)) {
              throw new Error(`Settlement gate rejected completion: worktree ${wt.path} has uncommitted changes. Commit and call submit_for_merge first.`);
            }
          }
        }

        const paths = [...artifactPaths];
        let overflowPath: string | undefined;
        if (summary.length > SUMMARY_LIMIT) {
          const artifactPath = `.harness/artifacts/${taskId}-summary-${randomUUID()}.md`;
          overflowPath = resolve(run.repoRoot, artifactPath);
          dossierDirectory(run.repoRoot);
          writeFileSync(overflowPath, summary, { encoding: "utf8", flag: "wx" });
          paths.push(overflowPath);
          const pointer = `\n\n[Full summary: ${artifactPath}]`;
          summary = summary.slice(0, SUMMARY_LIMIT - pointer.length).trimEnd() + pointer;
        }
        const taskStatus = status === "scope_too_large" ? "returned_for_rescope" : status;
        try {
          return this.db.transaction(() => {
            let escalationId: string | undefined;
            let suggestedSplits: string[] | undefined;
            if (status === "scope_too_large") {
              suggestedSplits = Array.isArray(args.suggested_splits) ? (args.suggested_splits as string[]) : [];
              escalationId = this.db.createEscalation({
                runId,
                fromTaskId: taskId,
                toTaskId: task.parentId,
                severity: task.tier === 2 ? "P1" : "P2",
                category: "scope_too_large",
                title: `Scope too large for ${task.title}: ${fullSummary.slice(0, 140)}`,
                evidencePaths: Array.isArray(args.evidence_paths) ? (args.evidence_paths as string[]) : paths,
                suggestedSplits,
                blocking: true,
              }).id;
            }
            if (overflowPath) {
              this.db.recordArtifact({ runId, taskId, kind: "dossier", path: overflowPath, summary: "Full task summary" });
            }
            this.db.updateTask(taskId, {
              status: taskStatus,
              summary,
              resultJson: JSON.stringify({ status, summary, sources, artifact_paths: paths, escalationId, suggestedSplits }),
            });
            return { returned: true, status: taskStatus, ...(escalationId ? { escalationId } : {}) };
          });
        } catch (error) {
          if (overflowPath) rmSync(overflowPath, { force: true });
          throw error;
        }
      }

      case "report_issue": {
        const severity = String(args.severity) as EscalationSeverity;
        const category = String(args.category) as EscalationCategory;
        const evidencePaths = Array.isArray(args.evidence_paths) ? (args.evidence_paths as string[]) : [];
        const attempted = Array.isArray(args.attempted) ? (args.attempted as string[]) : [];
        const blocking = args.blocking === undefined ? severity !== "P2" : Boolean(args.blocking);

        const toTaskId = severity === "P0" ? null : task.parentId;
        const esc = this.db.createEscalation({
          runId,
          fromTaskId: taskId,
          toTaskId,
          severity,
          category,
          title: String(args.title),
          evidencePaths,
          attempted,
          blocking,
        });
        if (blocking && severity !== "P0") {
          this.db.updateTask(taskId, { status: "blocked", summary: `Blocked on ${esc.id}: ${esc.title}` });
        }
        return { escalationId: esc.id, severity: esc.severity, routedTo: toTaskId ?? "human" };
      }

      case "ack_escalation": {
        const id = String(args.escalation_id);
        if (!this.db.listEscalations(runId, "open").some((e) => e.id === id && e.toTaskId === taskId)) {
          throw new Error(`Unknown incoming escalation ${id}`);
        }
        const updated = this.db.ackEscalation(id, String(args.resolution), true);
        return { escalation: updated };
      }

      case "request_rollover": {
        const handoff: AnchoredHandoff = {
          goalInvariants: Array.isArray(args.goal_invariants) ? (args.goal_invariants as string[]) : [],
          architecturalDecisions: Array.isArray(args.architectural_decisions)
            ? (args.architectural_decisions as Array<{ decision: string; rationale: string }>)
            : [],
          activeRisks: Array.isArray(args.active_risks) ? (args.active_risks as string[]) : [],
          nextActions: Array.isArray(args.next_actions) ? (args.next_actions as string[]) : [],
        };
        await this.hooks.scheduleRollover(taskId, handoff, {
          profileId: optionalProfile(args.target_profile_id),
          model: typeof args.target_model === "string" ? args.target_model : undefined,
          effort: typeof args.target_effort === "string" ? args.target_effort : undefined,
        });
        return { rolloverScheduled: true, nextGeneration: task.generation + 1 };
      }

      case "query_predecessor": {
        const q = String(args.query).toLowerCase();
        const limit = typeof args.limit === "number" ? args.limit : 20;
        const allEvents = this.db.getEventsSince(runId, 0, taskId, 2000);
        const matches = allEvents
          .filter((e) => JSON.stringify(e.payload).toLowerCase().includes(q) || e.type.toLowerCase().includes(q))
          .slice(-limit);
        const arts = this.db
          .listArtifacts(runId, taskId, 100)
          .filter((a) => a.path.toLowerCase().includes(q) || a.summary.toLowerCase().includes(q))
          .slice(0, limit);
        return { matchingEvents: matches, matchingArtifacts: arts };
      }

      case "artifact_write": {
        const art = writeTaskDossier(this.db, run, taskId, String(args.name), String(args.content), String(args.summary));
        return { artifactId: art.id, path: art.path };
      }

      case "artifact_read": {
        if (task.tier === 1 || typeof args.path !== "string" || !args.path || this.db.hasDossier(runId, resolve(run.repoRoot, args.path))) {
          return readRunDossier(this.db, run, args);
        }
        const root = task.worktreeId ? this.db.getWorktree(task.worktreeId)?.path : run.repoRoot;
        if (!root) throw new Error("Task worktree unavailable");
        return readWorkspaceArtifact(root, args.path, args.max_chars);
      }

      case "blackboard_set": {
        this.db.blackboardSet(runId, String(args.key), args.value, taskId);
        return { ok: true, key: String(args.key) };
      }

      case "blackboard_get": {
        return this.db.blackboardGet(runId, typeof args.key === "string" ? args.key : undefined);
      }

      case "ask_agent": {
        const targetId = String(args.target_id);
        const target = this.db.getTask(targetId);
        if (!target || target.runId !== runId) throw new Error(`Unknown target task ${targetId}`);
        const msg = this.db.createMessage(runId, taskId, targetId, String(args.question));
        // Best-effort steer notification to target agent
        void this.hooks
          .steerTask(
            targetId,
            `You received mediated peer question ${msg.id} from ${taskId}:\n<untrusted_peer_input>${msg.question}</untrusted_peer_input>\nUse reply_agent({ message_id: "${msg.id}", answer: "..." }) if appropriate.`,
          )
          .catch(() => {});
        return { messageId: msg.id, status: msg.status };
      }

      case "reply_agent": {
        const id = String(args.message_id);
        if (!this.db.listOpenMessages(taskId).some((message) => message.id === id)) throw new Error(`Unknown incoming message ${id}`);
        const msg = this.db.replyMessage(id, String(args.answer));
        return { messageId: msg.id, status: msg.status };
      }

      case "worktree_status": {
        if (!task.worktreeId) throw new Error("This task has no assigned worktree");
        const wt = this.db.getWorktree(task.worktreeId);
        if (!wt) throw new Error(`Worktree ${task.worktreeId} missing`);
        const mgr = this.hooks.getWorktreeManager(run.repoRoot);
        const dirty = await mgr.isDirty(wt.path);
        return { worktree: wt, dirty };
      }

      case "submit_for_merge": {
        if (!task.worktreeId) throw new Error("This task has no assigned worktree");
        const wt = this.db.getWorktree(task.worktreeId);
        if (!wt) throw new Error(`Worktree ${task.worktreeId} missing`);
        const mgr = this.hooks.getWorktreeManager(run.repoRoot);
        if (await mgr.isDirty(wt.path)) {
          throw new Error("Cannot submit_for_merge while worktree has uncommitted changes. Commit first.");
        }
        const item = this.db.enqueueMerge({ runId, taskId, worktreeId: wt.id, branch: wt.branch });
        const outcome = await this.hooks.getMergeQueue(run.repoRoot).processNext(runId);
        return {
          mergeId: item.id,
          status: outcome?.item.status ?? item.status,
          mergedSha: outcome?.mergedSha,
          bouncedReason: outcome?.bouncedReason,
        };
      }

      case "kb_search":
        return {
          cards: this.db.kb.search({
            query: typeof args.query === "string" ? args.query : undefined,
            repoScope: run.repoRoot,
            pathGlobs: Array.isArray(args.path_globs) ? (args.path_globs as string[]) : undefined,
            tags: Array.isArray(args.tags) ? (args.tags as string[]) : undefined,
            kinds: Array.isArray(args.kinds) ? (args.kinds as KbKind[]) : undefined,
            includeCandidates: Boolean(args.include_candidates),
            includeStale: Boolean(args.include_stale),
            limit: typeof args.limit === "number" ? args.limit : 10,
          }),
        };

      case "kb_get": {
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : [];
        const visible = ids.filter((id) => {
          const scope = this.db.kb.getRaw(id)?.repoScope;
          return scope === run.repoRoot || scope === "global";
        });
        return { entries: this.db.kb.getMany(visible) };
      }

      case "kb_propose": {
        const entry = this.db.kb.propose({
          repoScope: run.repoRoot,
          kind: String(args.kind) as KbKind,
          title: String(args.title),
          summary: String(args.summary),
          contextMd: String(args.context_md),
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          pathGlobs: Array.isArray(args.path_globs) ? (args.path_globs as string[]) : [],
          evidencePaths: Array.isArray(args.evidence_paths) ? (args.evidence_paths as string[]) : [],
          verifiedSha: run.baseSha,
          sourceRunId: runId,
          sourceTaskId: taskId,
        });
        return { id: entry.id, status: entry.status };
      }

      case "kb_flag_stale":
        return this.db.kb.flagStale(String(args.id), String(args.reason));

      case "list_peer_runs": {
        const peers = this.db
          .listRuns(50)
          .filter((r) => r.id !== runId && r.status === "active")
          .map((r) => ({
            id: r.id,
            goal: r.goal,
            repoRoot: r.repoRoot,
            baseBranch: r.baseBranch,
            coordinationGroup: r.coordinationGroup,
            isolationMode: r.isolationMode,
            activeWriteScopes: this.db.listActiveWriteScopes(r.id),
          }));
        return { peerRuns: peers };
      }

      case "contract_publish":
        return this.db.publishContract({
          namespace: String(args.namespace),
          key: String(args.key),
          ownerRunId: runId,
          payload: args.payload,
          summary: String(args.summary),
          status: typeof args.status === "string" ? (args.status as "draft" | "frozen" | "deprecated") : "draft",
          expectedVersion: typeof args.expected_version === "number" ? args.expected_version : undefined,
        });

      case "contract_get":
        return {
          contract: this.db.getContract(
            String(args.namespace),
            String(args.key),
            typeof args.version === "number" ? args.version : undefined,
          ),
        };

      case "peer_notify":
        return this.db.sendPeerAdvisory(runId, String(args.to_run_id), String(args.topic_key), String(args.message));

      case "peer_request":
        return this.db.createPeerRequest({
          fromRunId: runId,
          toRunId: String(args.to_run_id),
          topicKey: String(args.topic_key),
          message: String(args.message),
          timeoutSec: typeof args.timeout_s === "number" ? args.timeout_s : 120,
        });

      case "peer_reply":
        return this.db.replyPeerRequest(String(args.request_id), runId, String(args.reply));

      default:
        throw new Error(`Unhandled tool: ${name}`);
    }
  }

  private resolveSessionModelContext(runId: string): string | null {
    try {
      let chatSessionId: string | null = null;
      if (runId.startsWith("director-tasks-")) {
        chatSessionId = runId.slice("director-tasks-".length) || null;
      } else {
        const row = this.db.db
          .prepare(
            "SELECT chat_session_id FROM goals WHERE linked_run_id = ? AND chat_session_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
          )
          .get(runId) as { chat_session_id: string } | undefined;
        chatSessionId = row?.chat_session_id ?? null;
      }
      if (!chatSessionId) return null;
      const sess = this.db.db
        .prepare("SELECT model_selection_context FROM chat_sessions WHERE id = ?")
        .get(chatSessionId) as { model_selection_context: string | null } | undefined;
      const ctx = typeof sess?.model_selection_context === "string" ? sess.model_selection_context.trim() : "";
      return ctx || null;
    } catch {
      return null;
    }
  }
}
