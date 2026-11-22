import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ModelCatalogCompiler } from "../catalog/compiler.js";
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
import type { AnchoredHandoff } from "./prompts.js";

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
  scheduleRollover: (taskId: string, handoff: AnchoredHandoff, target?: { profileId?: string; model?: string; effort?: string }) => void;
  getWorktreeManager: (repoRoot: string) => WorktreeManager;
  getMergeQueue: (repoRoot: string) => BisectingMergeQueue;
}

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
    description: "Get full metadata, summary, artifacts, and open escalations for a specific task ID.",
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
      "List currently enabled latest-per-family models ranked by coding quality with cost/task, time/task, and live subscription quota availability.",
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
      required: ["title", "objective", "write_scopes"],
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
    tiers: [2],
    description:
      "Spawn a small, zero-compaction Tier 3 Task Agent (research, plan, execute, or verify) inside this Worker's worktree.",
    inputSchema: {
      type: "object",
      required: ["kind", "title", "objective"],
      properties: {
        kind: { type: "string", enum: ["research", "plan", "execute", "verify"] },
        title: { type: "string" },
        objective: { type: "string" },
        criteria: { type: "string" },
        read_only: { type: "boolean", description: "Force strict read-only sandbox (default true for research/plan/verify)" },
        profile_id: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        max_turns: { type: "number" },
        depends_on: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "wait_children",
    tiers: [1, 2],
    description: "Wait for spawned child tasks to finish, escalate, or return_for_rescope.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        mode: { type: "string", enum: ["any", "all"] },
        timeout_s: { type: "number" },
      },
    },
  },
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
  {
    name: "cancel_child",
    tiers: [1, 2],
    description: "Cancel a running child task cleanly and release its write leases.",
    inputSchema: {
      type: "object",
      required: ["task_id", "reason"],
      properties: {
        task_id: { type: "string" },
        reason: { type: "string" },
      },
    },
  },
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
        summary: { type: "string" },
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
    description: "Read a previously written artifact by path or list indexed artifacts for a task.",
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
    private readonly catalog: ModelCatalogCompiler,
    private readonly hooks: ToolRuntimeHooks,
  ) {}

  async execute(runId: string, taskId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const task = this.db.getTask(taskId);
    if (!task || task.runId !== runId) {
      throw new Error(`Task ${taskId} not found in run ${runId}`);
    }
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    if (name === "__list_tools") {
      return toolsForTier(task.tier);
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
            summary: t.summary,
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
          task: target,
          artifacts: this.db.listArtifacts(runId, target.id, 30),
          escalations: this.db.listEscalations(runId).filter((e) => e.fromTaskId === target.id || e.toTaskId === target.id),
        };
      }

      case "list_models": {
        const compiled = await this.catalog.getCatalog({
          cwd: run.repoRoot,
          role: typeof args.role === "string" ? args.role : undefined,
          maxApiEquivUsd: typeof args.max_api_equiv_usd === "number" ? args.max_api_equiv_usd : undefined,
          excludeExhausted: Boolean(args.exclude_exhausted),
        });
        return {
          syncedAt: compiled.syncedAt,
          sources: compiled.sources,
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
          profileId: typeof args.profile_id === "string" ? args.profile_id : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          effort: typeof args.effort === "string" ? args.effort : undefined,
          dependsOn: Array.isArray(args.depends_on) ? (args.depends_on as string[]) : [],
          writeScopes,
        });
        return { spawned: created.id, status: created.status, worktreeId: created.worktreeId };
      }

      case "spawn_task": {
        const kind = String(args.kind) as TaskKind;
        const defaultReadOnly = kind !== "execute";
        const readOnly = args.read_only === undefined ? defaultReadOnly : Boolean(args.read_only);
        const created = await this.hooks.spawnAndStartTask({
          runId,
          parentId: taskId,
          tier: 3,
          kind,
          title: String(args.title),
          objective: String(args.objective),
          criteria: typeof args.criteria === "string" ? args.criteria : "",
          readOnly,
          profileId: typeof args.profile_id === "string" ? args.profile_id : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          effort: typeof args.effort === "string" ? args.effort : undefined,
          maxTurns: typeof args.max_turns === "number" ? args.max_turns : undefined,
          dependsOn: Array.isArray(args.depends_on) ? (args.depends_on as string[]) : [],
        });
        return { spawned: created.id, kind: created.kind, readOnly: created.readOnly, status: created.status };
      }

      case "wait_children": {
        const ids = Array.isArray(args.ids) ? (args.ids as string[]) : undefined;
        const mode = args.mode === "any" ? "any" : "all";
        const timeoutMs = (typeof args.timeout_s === "number" ? args.timeout_s : 300) * 1000;
        const settled = await this.hooks.waitForChildren(taskId, ids, mode, timeoutMs);
        return {
          children: settled.map((c) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            summary: c.summary,
            result: c.resultJson ? JSON.parse(c.resultJson) : null,
          })),
        };
      }

      case "steer_child": {
        const ok = await this.hooks.steerTask(String(args.task_id), String(args.message));
        return { steered: ok };
      }

      case "cancel_child": {
        await this.hooks.cancelTask(String(args.task_id), String(args.reason));
        return { cancelled: String(args.task_id) };
      }

      case "return_task": {
        const status = String(args.status);
        const summary = String(args.summary);
        const artifactPaths = Array.isArray(args.artifact_paths) ? (args.artifact_paths as string[]) : [];

        if (status === "scope_too_large") {
          const evidencePaths = Array.isArray(args.evidence_paths) ? (args.evidence_paths as string[]) : artifactPaths;
          const suggestedSplits = Array.isArray(args.suggested_splits) ? (args.suggested_splits as string[]) : [];
          const esc = this.db.createEscalation({
            runId,
            fromTaskId: taskId,
            toTaskId: task.parentId,
            severity: task.tier === 2 ? "P1" : "P2",
            category: "scope_too_large",
            title: `Scope too large for ${task.title}: ${summary.slice(0, 140)}`,
            evidencePaths,
            suggestedSplits,
            blocking: true,
          });
          this.db.updateTask(taskId, {
            status: "returned_for_rescope",
            summary,
            resultJson: JSON.stringify({ status, summary, artifactPaths, escalationId: esc.id, suggestedSplits }),
          });
          return { returned: true, status: "returned_for_rescope", escalationId: esc.id };
        }

        if (status === "blocked") {
          this.db.updateTask(taskId, {
            status: "blocked",
            summary,
            resultJson: JSON.stringify({ status, summary, artifactPaths }),
          });
          return { returned: true, status: "blocked" };
        }

        // Settlement gate: Tier 2 cannot complete while children are still running or worktree is dirty
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
          if (wt && wt.status === "active") {
            const dirty = await this.hooks.getWorktreeManager(run.repoRoot).isDirty(wt.path);
            if (dirty) {
              throw new Error(
                `Settlement gate rejected completion: worktree ${wt.path} has uncommitted changes. Commit and call submit_for_merge first.`,
              );
            }
          }
        }

        this.db.updateTask(taskId, {
          status: "completed",
          summary,
          resultJson: JSON.stringify({ status: "completed", summary, artifactPaths }),
        });
        return { returned: true, status: "completed" };
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
        const updated = this.db.ackEscalation(String(args.escalation_id), String(args.resolution), true);
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
        this.db.updateTask(taskId, { status: "draining", handoffJson: JSON.stringify(handoff) });
        this.hooks.scheduleRollover(taskId, handoff, {
          profileId: typeof args.target_profile_id === "string" ? args.target_profile_id : undefined,
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
        const safeName = basename(String(args.name)).replace(/[^a-zA-Z0-9._-]/g, "_");
        const dir = join(run.repoRoot, ".harness", "artifacts", runId, taskId);
        mkdirSync(dir, { recursive: true });
        const fullPath = join(dir, safeName);
        writeFileSync(fullPath, String(args.content), "utf8");
        const art = this.db.recordArtifact({
          runId,
          taskId,
          kind: "dossier",
          path: fullPath,
          summary: String(args.summary),
        });
        return { artifactId: art.id, path: fullPath };
      }

      case "artifact_read": {
        if (typeof args.path === "string" && args.path) {
          const target = resolve(args.path);
          if (!existsSync(target)) throw new Error(`Artifact not found: ${target}`);
          const raw = readFileSync(target, "utf8");
          const max = typeof args.max_chars === "number" ? args.max_chars : 8000;
          return { path: target, truncated: raw.length > max, content: raw.slice(0, max) };
        }
        const filterTask = typeof args.task_id === "string" ? args.task_id : undefined;
        return { artifacts: this.db.listArtifacts(runId, filterTask, 50) };
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
        const msg = this.db.replyMessage(String(args.message_id), String(args.answer));
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
        return { entries: this.db.kb.getMany(ids) };
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
}
