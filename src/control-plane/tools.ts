import { realpathSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { recommendModelsByTaskKind, type ModelCatalogCompiler } from "../catalog/compiler.js";
import { CODE_EXEC_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, createCodeModeExecutor, effectiveCodeMode, exposedTools } from "../code-mode/index.js";
import type { HarnessConfig } from "../config.js";
import { codeExecEventSink } from "../protocol/tool-display.js";
import { checkReadOnlyArgv, isSafeGitRemoteUrl, parseReadOnlyGitNetworkCommand } from "../runners/acp-shims.js";
import { isProtectedWritePath } from "../runners/protected-paths.js";
import type { RunnerCallbacks, ToolDefinition } from "../runners/types.js";
import { filterTrustedPath, resolveGateEnv, resolveTrustedBinary, runArgv } from "../tools/gate-env.js";
import type { KbKind } from "../kb/store.js";
import type { BisectingMergeQueue } from "../worktree/merge-queue.js";
import { runGit, type WorktreeManager } from "../worktree/manager.js";
import type { AdmissionLane, QueuePositionInput } from "./admission-queue.js";
import { directorTaskRunOwner, isDirectorTaskContainer } from "./ids.js";
import {
  deriveTitle,
  type AgentTier,
  type ControlPlaneDb,
  type EscalationCategory,
  type EscalationSeverity,
  type RunRecord,
  type TaskKind,
  type TaskRecord,
} from "./db.js";
import { findRunDossier, readRunDossier, readWorkspaceArtifact, spillSummaryOverflow, writeCodeOutput, writeTaskDossier, writeUniqueTaskDossier } from "./dossiers.js";
import { compactTaskHandoff, isReadOnlyKind, settleTaskMinimalFallback, SUMMARY_LIMIT, validateTaskHandoff } from "./handoffs.js";
import { expandHomePath } from "./projects.js";
import type { AnchoredHandoff } from "./prompts.js";
import { spawnDuplicateAdvisory } from "./restart-recovery.js";
import {
  type DroppedProgressEntry,
  filterProgressPatch,
  mergeGoalLiveProgress,
  type GoalLiveProgress,
  type GoalProgressSource,
} from "../goals/live-progress.js";
import type { SteerTaskResult } from "./orchestrator.js";
import { REJECTIONS } from "../advisories/rejections.js";
import { roleOf } from "../advisories/roles.js";
import { allowedToolNames, notYourTool, toolsForRole } from "../tool-descriptions/index.js";

export { readRunDossier } from "./dossiers.js";
export { compactTaskHandoff, isReadOnlyKind, validateTaskHandoff } from "./handoffs.js";

export interface WaitForChildrenResult {
  children: TaskRecord[];
  wakeReason: "already_settled" | "event" | "escalation" | "steered" | "fallback_interval" | "child_inactive";
  inactiveTaskIds: string[];
}

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
    position?: QueuePositionInput;
    forceStart?: boolean;
    signal?: AbortSignal;
  }) => Promise<TaskRecord>;
  waitForChildren: (
    parentId: string,
    ids: string[] | undefined,
    mode: "any" | "all",
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<WaitForChildrenResult>;
  steerTask: (taskId: string, message: string) => Promise<boolean>;
  /** Structured steering outcome (preferred over steerTask when available). */
  steerTaskDetailed?: (taskId: string, message: string) => Promise<SteerTaskResult>;
  /** Takes the steering queued for a task; wait_children delivers it in its result. */
  drainPendingSteers?: (taskId: string) => string[];
  cancelTask: (taskId: string, reason: string) => Promise<void>;
  stopTaskForBlockingIssue?: (taskId: string, reason: string) => void;
  scheduleRollover: (taskId: string, handoff: AnchoredHandoff, target?: { profileId?: string; model?: string; effort?: string }) => Promise<void>;
  getWorktreeManager: (repoRoot: string) => WorktreeManager;
  getMergeQueue: (repoRoot: string) => BisectingMergeQueue;
  getTaskSignal: (taskId: string) => AbortSignal | undefined;
  /** Recorded cause of a run's current state (stop reason, quota pause, P0), or null when none was recorded. */
  describeRunCause?: (runId: string) => string | null;
  /** True task cancellation signal (does NOT fire on clean rollover, so in-flight merges aren't aborted). */
  getTaskCancelSignal?: (taskId: string) => AbortSignal | undefined;
  resumeTask?: (
    taskId: string,
    opts?: {
      note?: string;
      profileId?: string;
      model?: string;
      effort?: string;
      allowCompleted?: boolean;
      position?: QueuePositionInput;
      forceStart?: boolean;
    },
  ) => Promise<TaskRecord>;
  /** Idempotent resume with a structured outcome (preferred over resumeTask when available). */
  resumeTaskDetailed?: (
    taskId: string,
    opts?: { note?: string; profileId?: string; model?: string; effort?: string },
  ) => Promise<{ task: TaskRecord; outcome: string; message: string; queuePosition?: number; noteDelivered?: boolean }>;
  forceStartWorker?: (taskId: string, opts?: { bypassQuota?: boolean; reason?: string }) => Promise<unknown>;
  /** Generation-fenced inner tool event observer (e.g. for Code Mode inner calls). */
  onTaskToolEvent?: (
    runId: string,
    taskId: string,
    expectedGeneration: number,
    ev: Parameters<NonNullable<RunnerCallbacks["onToolEvent"]>>[0],
  ) => void;
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

function derivedTitleNote(title: string): string {
  return `title was missing; derived '${title}'. Pass a short title next time.`;
}

export type TaskToolSubject = Pick<TaskRecord, "runId" | "tier" | "kind" | "profileId" | "title" | "readOnly">;

const READ_ONLY_FINDING_CATEGORIES = new Set<EscalationCategory>([
  "verification_failed",
  "code_defect",
  "broken_test",
]);

export function toolsForTask(task: TaskToolSubject): ToolDefinition[] {
  return toolsForRole(roleOf(task), { readOnly: task.readOnly || isReadOnlyKind(task.kind) });
}

export function toolsForTier(tier: AgentTier): ToolDefinition[] {
  if (tier === 1) return toolsForRole("orchestrator");
  if (tier === 2) return toolsForRole("worker");
  return toolsForRole("execute", { readOnly: true });
}

export class ControlPlaneToolExecutor {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly getCatalogCompiler: () => ModelCatalogCompiler,
    private readonly hooks: ToolRuntimeHooks,
    private readonly config: HarnessConfig,
  ) {}

  tools(target: AgentTier | TaskToolSubject): ToolDefinition[] {
    const raw = typeof target === "number" ? toolsForTier(target) : toolsForTask(target);
    return exposedTools(raw, this.config.codeMode);
  }

  /** Creates the Code Mode inner-event sink fenced to one task generation. */
  createCodeExecEventSink(runId: string, taskId: string, expectedGeneration: number) {
    return codeExecEventSink((ev) => {
      if (this.hooks.onTaskToolEvent) {
        this.hooks.onTaskToolEvent(runId, taskId, expectedGeneration, ev);
      } else {
        this.db.emitEvent(runId, taskId, "agent.tool", ev);
      }
    });
  }

  /**
   * `callerSignal` is the calling turn's abort signal (e.g. a Director chat turn). Unlike `scriptSignal`
   * it does not imply code_exec, so it never trips the active-generation gate for synthetic owners.
   */
  async execute(
    runId: string,
    taskId: string,
    name: string,
    args: Record<string, unknown>,
    scriptSignal?: AbortSignal,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    const task = this.db.getTask(taskId);
    if (!task || task.runId !== runId) {
      throw new Error(`Task ${taskId} not found in run ${runId}`);
    }
    const inScript = scriptSignal !== undefined;
    const callerGeneration = task.generation;
    const callerTaskSignal = this.hooks.getTaskSignal(taskId);
    const mode = effectiveCodeMode(this.config.codeMode);
    if (inScript || (name === CODE_EXEC_TOOL_NAME && mode !== "off")) {
      const taskSignal = callerTaskSignal;
      const signal = scriptSignal ?? taskSignal;
      if (
        !signal ||
        signal.aborted ||
        !taskSignal ||
        taskSignal.aborted ||
        ["completed", "cancelled", "failed", "returned_for_rescope", "paused_quota"].includes(task.status)
      ) {
        // Name the actual cause (whole-run stop first, then this task's cancellation) instead of a bare refusal.
        const runStatus = this.db.getRun(runId)?.status;
        const why =
          runStatus === "stopped" && !isDirectorTaskContainer(runId)
            ? `run ${runId} is stopped (${
                (this.hooks.describeRunCause?.(runId) ?? this.db.getLastRunStatusReason(runId))?.trim() ||
                `no cause was recorded; inspect with \`pi-harness tree ${runId}\``
              })`
            : task.status === "cancelled"
              ? `task ${taskId} was cancelled (${task.summary?.trim() || "no reason recorded"})`
              : signal?.aborted || taskSignal?.aborted
                ? `the calling turn of ${taskId} was cancelled`
                : `task ${taskId} is ${task.status}`;
        throw new Error(`code_exec requires an active task generation for ${taskId}: ${why}. Nothing was executed.`);
      }
    }
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Run ${runId} not found`);

    if (name === "__list_tools") {
      return this.tools(task);
    }
    if (mode !== "off" && (name === CODE_EXEC_TOOL_NAME || name === TOOL_SEARCH_TOOL_NAME)) {
      const signal = callerTaskSignal;
      const res = await createCodeModeExecutor({
        ...this.config.codeExec,
        mode,
        allowedTools: () => toolsForTask(task),
        execute: (inner, input, execSignal) => {
          if (
            signal?.aborted ||
            (signal && this.hooks.getTaskSignal(taskId) !== signal) ||
            this.db.getTask(taskId)?.generation !== callerGeneration
          ) {
            throw new Error(
              `Stale code_exec call for task ${taskId} generation ${callerGeneration}: caller is no longer the active execution.`,
            );
          }
          return this.execute(runId, taskId, inner, input, execSignal ?? signal);
        },
        artifactsDir: resolve(run.repoRoot, this.config.worktree.artifactsDir ?? ".harness/artifacts"),
        pythonCacheDir: join(this.config.stateDir, "code-mode", "python"),
        saveOutput: (name, json) => writeCodeOutput(this.db, run, taskId, name, json),
        signal,
        onToolEvent: this.createCodeExecEventSink(runId, taskId, callerGeneration),
      }).execute(name, args);
      return inScript ? res : this.attachPendingSteers(taskId, res, callerGeneration, signal);
    }

    const role = roleOf(task);
    if (!allowedToolNames(role).has(name)) {
      throw notYourTool(name, role);
    }

    const result = await this.executeTool(runId, taskId, task, run, name, args, scriptSignal, callerSignal);
    return inScript ? result : this.attachPendingSteers(taskId, result, callerGeneration, callerTaskSignal);
  }

  /** Appends any queued steering messages (oldest first) onto an outer model-visible tool result. */
  private attachPendingSteers(
    taskId: string,
    result: unknown,
    expectedGeneration?: number,
    expectedSignal?: AbortSignal,
  ): unknown {
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    if (expectedSignal?.aborted) return result;
    const liveSignal = this.hooks.getTaskSignal(taskId);
    if (liveSignal?.aborted) return result;
    if (expectedSignal && liveSignal !== expectedSignal) return result;
    if (expectedGeneration !== undefined && this.db.getTask(taskId)?.generation !== expectedGeneration) return result;
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.steeringMessages) && obj.steeringMessages.length > 0) return result;
    const steeringMessages = this.hooks.drainPendingSteers?.(taskId) ?? [];
    if (steeringMessages.length === 0) return result;
    return {
      ...obj,
      steeringMessages,
      ...(obj.hint === undefined
        ? { hint: "Steering received (steeringMessages, oldest first). Apply it before continuing." }
        : {}),
    };
  }

  private async executeTool(
    runId: string,
    taskId: string,
    task: TaskRecord,
    run: RunRecord,
    name: string,
    args: Record<string, unknown>,
    scriptSignal?: AbortSignal,
    callerSignal?: AbortSignal,
  ): Promise<unknown> {
    switch (name) {
      case "tree_view": {
        const includeSettled = args.include_settled !== false;
        const tasks = this.db
          .listTasks(runId)
          .filter((t) => includeSettled || !["completed", "cancelled", "failed"].includes(t.status));
        const escalations = this.db.listEscalations(runId, "open");
        const pendingMsgs = this.db.listOpenMessages(taskId);
        const answeredMsgs = this.db.listAnsweredMessagesFrom(taskId);
        const openPeerRequests = task.tier === 1 ? this.db.listOpenPeerExchangesForRun(runId) : [];
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
            goalVersion: t.goalVersion ?? null,
            ctxPct: t.contextSize > 0 ? Math.round((t.contextUsed / t.contextSize) * 100) : null,
            summary: compactTaskHandoff(t).summary,
          })),
          openEscalations: escalations,
          inboxMessages: pendingMsgs.map((m) => ({
            id: m.id,
            from: m.fromTaskId,
            question: `<untrusted_peer_input>${m.question}</untrusted_peer_input>`,
          })),
          ...(answeredMsgs.length > 0 ? { answeredMessages: answeredMsgs } : {}),
          ...(openPeerRequests.length > 0 ? { openPeerRequests } : {}),
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
            ...(m.alternateRoutes.length > 0
              ? {
                  alternateRoutes: m.alternateRoutes.map((r) => ({
                    profile: r.profileId,
                    wireModel: r.wireModelId,
                    billing: r.billing,
                  })),
                }
              : {}),
          })),
        };
      }

      case "spawn_worker": {
        if (task.status === "draining") {
          throw REJECTIONS.draining("spawn_worker");
        }
        const writeScopes = Array.isArray(args.write_scopes) ? (args.write_scopes as string[]) : [];
        if (writeScopes.length === 0) throw REJECTIONS.writeScopesRequired();
        // Avoid starving sibling runs with a blanket repo-root wildcard when other active runs share this target branch
        const hasBlanketWildcard = writeScopes.some((s) => {
          const n = s.trim().replace(/^\.\//, "").replace(/\/+$/, "");
          return n === "" || n === "." || n === "*" || n === "**" || n === "**/*";
        });
        if (hasBlanketWildcard) {
          const otherActiveSameBranch = this.db
            .listRuns(100)
            .some((r) => r.id !== runId && r.status === "active" && r.repoRoot === run.repoRoot && r.baseBranch === run.baseBranch);
          if (otherActiveSameBranch) {
            throw REJECTIONS.writeScopesBlanket(writeScopes, run.baseBranch);
          }
        }
        const objective = typeof args.objective === "string" ? args.objective : "";
        const { title, derived } = deriveTitle(args.title, [objective, args.criteria], "Untitled worker task");
        const posArg = args.position as QueuePositionInput | undefined;
        const created = await this.hooks.spawnAndStartTask({
          runId,
          parentId: taskId,
          tier: 2,
          kind: "worker",
          title,
          objective,
          criteria: typeof args.criteria === "string" ? args.criteria : "",
          readOnly: false,
          profileId: optionalProfile(args.profile_id),
          model: requiredModel(args),
          effort: typeof args.effort === "string" ? args.effort : undefined,
          dependsOn: Array.isArray(args.depends_on) ? (args.depends_on as string[]) : [],
          writeScopes,
          ...(posArg !== undefined ? { position: posArg } : {}),
          ...(args.force_start !== undefined ? { forceStart: Boolean(args.force_start) } : {}),
          signal: callerSignal ?? scriptSignal ?? this.hooks.getTaskCancelSignal?.(taskId),
        });
        const qEntry = this.db.admissionQueue.get("worker", created.id);
        const warning = spawnDuplicateAdvisory(this.db, task, created.id, created.title);
        return {
          spawned: created.id,
          status: created.status,
          worktreeId: created.worktreeId,
          ...(qEntry ? { queued: true, queuePosition: qEntry.position } : {}),
          ...(warning ? { warning } : {}),
          ...(derived ? { note: derivedTitleNote(created.title) } : {}),
        };
      }

      case "queue_list": {
        const lane = args.lane === "goal" || args.lane === "worker" ? (args.lane as AdmissionLane) : undefined;
        const entries = this.db.admissionQueue.list({ lane, repoRoot: run.repoRoot });
        return {
          repoRoot: run.repoRoot,
          limits: {
            maxConcurrentGoals: this.config.goals.maxConcurrentGoals ?? 4,
            maxConcurrentWorkers: this.config.worktree.maxConcurrentWorkers ?? 4,
          },
          entries,
        };
      }

      case "queue_reorder": {
        const targetId = String(args.target_id ?? "").trim();
        if (!targetId) throw new Error("target_id is required");
        const lane: AdmissionLane =
          args.lane === "goal" || args.lane === "worker"
            ? args.lane
            : targetId.startsWith("goal-")
              ? "goal"
              : "worker";
        const position = args.position as QueuePositionInput;
        const updated = this.db.admissionQueue.reorder(lane, targetId, position);
        return { reordered: updated, queue: this.db.admissionQueue.list({ lane, repoRoot: updated.repoRoot }) };
      }

      case "queue_force_start": {
        if (!this.hooks.forceStartWorker) throw new Error("queue_force_start is not available in this runtime");
        const targetId = String(args.target_id ?? "").trim();
        if (!targetId) throw new Error("target_id is required");
        return await this.hooks.forceStartWorker(targetId, {
          bypassQuota: Boolean(args.bypass_quota),
          reason: typeof args.reason === "string" ? args.reason : undefined,
        });
      }

      case "spawn_task": {
        const kind = String(args.kind);
        const readOnlyKind = isReadOnlyKind(kind);
        const fromOrchestrator = task.tier === 1;
        if (fromOrchestrator && kind === "execute") {
          throw REJECTIONS.spawnExecuteNeedsWorker();
        }
        if (!readOnlyKind && kind !== "execute") throw new Error(`Unknown spawn_task kind: ${kind}`);
        if (task.status === "draining") throw REJECTIONS.draining("spawn_task");

        const objective = typeof args.objective === "string" ? args.objective : "";
        const { title, derived } = deriveTitle(args.title, [objective, args.criteria], `Untitled ${kind} task`);
        const created = await this.hooks.spawnAndStartTask({
          runId,
          parentId: taskId,
          tier: 3,
          kind,
          title,
          objective,
          criteria: typeof args.criteria === "string" ? args.criteria : "",
          readOnly: readOnlyKind || args.read_only === true,
          profileId: optionalProfile(args.profile_id),
          model: requiredModel(args),
          effort: typeof args.effort === "string" ? args.effort : undefined,
          dependsOn: Array.isArray(args.depends_on) ? (args.depends_on as string[]) : [],
          signal: callerSignal ?? scriptSignal ?? this.hooks.getTaskCancelSignal?.(taskId),
        });
        const warning = spawnDuplicateAdvisory(this.db, task, created.id, created.title);
        return {
          spawned: created.id,
          kind: created.kind,
          readOnly: created.readOnly,
          status: created.status,
          ...(warning ? { warning } : {}),
          ...(derived ? { note: derivedTitleNote(created.title) } : {}),
        };
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
        const waitSig = scriptSignal ?? this.hooks.getTaskSignal(taskId);
        const waitRes = await this.hooks.waitForChildren(taskId, ids, mode, timeoutMs, waitSig);
        const settled = waitRes.children;
        const escalations = this.db.listEscalations(runId);
        const stillRunning = settled.filter((c) => ["running", "ready", "pending", "draining", "waiting_children", "merging"].includes(c.status));
        const steeringMessages =
          scriptSignal ||
          this.hooks.getTaskSignal(taskId)?.aborted ||
          this.db.getTask(taskId)?.generation !== task.generation
            ? []
            : (this.hooks.drainPendingSteers?.(taskId) ?? []);
        const steering = steeringMessages.length > 0
          ? {
              wakeReason: "steered",
              steeringMessages,
              hint: "Steering received while you waited (steeringMessages, oldest first). Apply it before waiting again.",
            }
          : {};
        return {
          children: settled.map((child) => compactTaskHandoff(child, escalations)),
          ...(waitRes.wakeReason !== "event" && waitRes.wakeReason !== "already_settled"
            ? {
                wakeReason: waitRes.wakeReason,
                ...(waitRes.inactiveTaskIds.length > 0 ? { inactiveTaskIds: waitRes.inactiveTaskIds } : {}),
                ...(waitRes.wakeReason === "child_inactive"
                  ? { hint: `Inactive child task(s) detected: ${waitRes.inactiveTaskIds.join(", ")}. Inspect, then ${task.tier === 1 ? "resume_task or " : ""}cancel_child.` }
                  : waitRes.wakeReason === "escalation"
                    ? { hint: "Woke on a new escalation. Use ack_escalation only for escalations addressed to you; P0 escalations go to the human. Otherwise steer, cancel, or re-scope the affected child before waiting again." }
                    : waitRes.wakeReason === "steered"
                      ? { hint: "Woke on incoming steering or goal amendment; check Blackboard/goal state." }
                      : stillRunning.length > 0
                        ? { hint: "Fallback wakeup fired while child task(s) are still in progress; wait again with wait_children rather than short-polling." }
                        : {}),
              }
            : mode === "all" && stillRunning.length > 0
              ? {
                  wakeReason: "fallback_interval",
                  hint: "Fallback wakeup fired while child task(s) are still in progress; wait again with wait_children rather than short-polling.",
                }
              : {}),
          ...steering,
        };
      }

      case "steer_child":
      case "cancel_task":
      case "cancel_child": {
        const childId = String(args.task_id);
        const child = this.db.getTask(childId);
        if (!child || child.runId !== runId || child.parentId !== taskId) throw new Error(`Unknown child task ${childId}`);
        if (name === "steer_child") {
          return this.hooks.steerTaskDetailed
            ? await this.hooks.steerTaskDetailed(child.id, String(args.message))
            : { steered: await this.hooks.steerTask(child.id, String(args.message)) };
        }
        await this.hooks.cancelTask(child.id, String(args.reason));
        return { cancelled: child.id };
      }

      case "report_goal_progress": {
        const updated = this.updateLinkedGoalProgress(runId, taskId, {
          summary: String(args.summary ?? "").trim() || undefined,
          phase: typeof args.phase === "string" ? args.phase.trim() || undefined : undefined,
          verificationStatus:
            typeof args.verification_status === "string" &&
            ["not_needed", "in_progress", "passed", "failed"].includes(args.verification_status)
              ? (args.verification_status as "not_needed" | "in_progress" | "passed" | "failed")
              : undefined,
          criteriaResults: Array.isArray(args.criteria_results)
            ? (args.criteria_results as Array<Record<string, unknown>>)
                .filter((r) => typeof r?.criterion_id === "string")
                .map((r) => ({
                  criterionId: String(r.criterion_id),
                  passed: Boolean(r.passed),
                  evidence: String(r.evidence ?? ""),
                  ...(typeof r.remediation === "string" ? { remediation: r.remediation } : {}),
                }))
            : undefined,
        });
        return updated;
      }

      case "return_task": {
        const status = String(args.status);
        if (status !== "completed" && status !== "blocked" && status !== "scope_too_large") {
          throw new Error("return_task requires status completed, blocked, or scope_too_large");
        }
        // Capture the task's generation signal separately from Code Mode's per-script abort signal:
        // only generationSignal identifies the active execution, while all signals are checked for abort.
        const generationSignal = this.hooks.getTaskSignal(taskId);
        const cancelSignal = this.hooks.getTaskCancelSignal?.(taskId);
        const assertReturnStillValid = () => {
          const current = this.db.getTask(taskId);
          if (!current || current.generation !== task.generation) {
            throw new Error(
              `Stale return_task for task ${taskId} generation ${task.generation}` +
                (current ? ` (current generation ${current.generation})` : "") +
                ": task generation moved on before settlement.",
            );
          }
          if (scriptSignal?.aborted || generationSignal?.aborted || cancelSignal?.aborted || callerSignal?.aborted) {
            throw new Error(`return_task aborted for task ${taskId}: task execution was cancelled or superseded.`);
          }
          if ((generationSignal && this.hooks.getTaskSignal(taskId) !== generationSignal) || (scriptSignal && !generationSignal)) {
            throw new Error(`Stale return_task for task ${taskId}: caller is no longer the active execution.`);
          }
          const invalidStatus = generationSignal || scriptSignal
            ? !["running", "waiting_children", "draining"].includes(current.status)
            : ["completed", "cancelled", "failed", "returned_for_rescope", "blocked", "paused_quota"].includes(current.status);
          if (invalidStatus) {
            throw new Error(`return_task rejected for task ${taskId}: task is already ${current.status}.`);
          }
        };

        const { summary: fullSummary, sources, artifactPaths, partial } = validateTaskHandoff(task.kind, args);
        let summary = partial && !fullSummary.startsWith("[Partial]") ? `[Partial] ${fullSummary}` : fullSummary;

        assertReturnStillValid();

        if (status === "completed") {
          const activeKids = this.db
            .listTasks(runId, { parentId: taskId })
            .filter((c) => ["running", "ready", "pending", "waiting_children", "merging"].includes(c.status));
          if (activeKids.length > 0) {
            throw REJECTIONS.settlementLiveChildren(
              activeKids.map((k) => k.id),
              activeKids.length,
            );
          }
          if (task.tier === 2 && task.worktreeId) {
            const wt = this.db.getWorktree(task.worktreeId);
            if (wt && !wt.cleanedAt) {
              const wtMgr = this.hooks.getWorktreeManager(run.repoRoot);
              if (await wtMgr.isDirty(wt.path)) {
                throw REJECTIONS.settlementDirtyWorktree();
              }
              if (wt.status === "queued" || wt.status === "bounced") {
                throw REJECTIONS.settlementUnmerged(`worktree merge status is '${wt.status}'`, run.baseBranch);
              }
              // Verify any commits on the worker's HEAD are actually contained in targetBranch (catches unmerged commits
              // AND post-merge commits added after an earlier submit_for_merge!).
              const wtHead = await runGit(wt.path, ["rev-parse", "HEAD"]).then((r) => r.stdout).catch(() => null);
              if (wtHead && wtHead !== wt.baseSha) {
                const contained = await runGit(run.repoRoot, ["merge-base", "--is-ancestor", wtHead, run.baseBranch]).then(
                  () => true,
                  () => false,
                );
                if (!contained) {
                  throw REJECTIONS.settlementUnmerged(
                    `worktree HEAD (${wtHead.slice(0, 8)}) has unmerged commits`,
                    run.baseBranch,
                  );
                }
              }
            }
          }
        }

        // Revalidate caller generation, live status, and cancellation after awaited worktree checks
        // and before spilling summary overflow or committing settlement.
        assertReturnStillValid();

        const paths = [...artifactPaths];
        let overflowPath: string | undefined;
        let summaryOverflow: { path: string; next_offset: number; total_chars: number } | undefined;
        if (summary.length > SUMMARY_LIMIT) {
          const spill = spillSummaryOverflow(this.db, run, taskId, summary);
          summary = spill.summary;
          overflowPath = spill.overflowPath;
          if (overflowPath) {
            paths.push(overflowPath);
            summaryOverflow = {
              path: overflowPath,
              next_offset: spill.keptChars ?? 0,
              total_chars: spill.totalChars ?? fullSummary.length,
            };
          }
        }
        const taskStatus = status === "scope_too_large" ? "returned_for_rescope" : status;
        let committed = false;
        try {
          const result = this.db.transaction(() => {
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
                tool: "return_task",
              }).id;
            }
            if (overflowPath) {
              this.db.recordArtifact({ runId, taskId, kind: "dossier", path: overflowPath, summary: "Full task summary" });
            }
            let staleGoalVersion: { bound: number; current: number } | undefined;
            let amendmentNotice: string | undefined;
            try {
              const gRow = this.db.db
                .prepare("SELECT id, version FROM goals WHERE linked_run_id = ? ORDER BY updated_at DESC LIMIT 1")
                .get(runId) as { id: string; version: number } | undefined;
              const latestTask = this.db.getTask(taskId) ?? task;
              if (gRow && latestTask.goalVersion != null && latestTask.goalVersion < Number(gRow.version)) {
                const currentVersion = Number(gRow.version);
                staleGoalVersion = { bound: latestTask.goalVersion, current: currentVersion };
                amendmentNotice =
                  `Goal ${gRow.id} was amended to v${currentVersion} while task ${taskId} was bound to v${latestTask.goalVersion}. ` +
                  `Handoff accepted and recorded as answering v${latestTask.goalVersion}.`;
              }
            } catch {
              // goals table may not exist in standalone ControlPlaneDb unit tests
            }
            this.db.updateTask(taskId, {
              status: taskStatus,
              summary,
              resultJson: JSON.stringify({
                status,
                summary,
                ...(partial ? { partial: true } : {}),
                sources,
                artifact_paths: paths,
                ...(summaryOverflow ? { summary_overflow: summaryOverflow } : {}),
                ...(staleGoalVersion ? { staleGoalVersion } : {}),
                escalationId,
                suggestedSplits,
              }),
            });
            // Automatically reflect verify task outcomes onto any linked Goal without requiring extra model calls.
            // An intermediate verify (a partial handoff, a Tier 3 probe, or a failed verify while other work is live)
            // only updates the summary: its pass/fail is not the run's final verification and must not gate settlement.
            if (task.kind === "verify") {
              const liveStatuses = ["running", "waiting_children", "ready", "pending", "draining", "merging"];
              const otherLive = this.db.listTasks(runId).some((t) => t.id !== taskId && liveStatuses.includes(t.status));
              const intermediate = partial || (task.tier === 3 && otherLive) || (taskStatus !== "completed" && otherLive);
              this.updateLinkedGoalProgress(
                runId,
                taskId,
                intermediate
                  ? { summary: summary.slice(0, 300) }
                  : { verificationStatus: taskStatus === "completed" ? "passed" : "failed", summary: summary.slice(0, 300) },
                "verify_task",
              );
            }
            const splitsMissing = status === "scope_too_large" && (suggestedSplits?.length ?? 0) < 2;
            return {
              returned: true,
              status: taskStatus,
              ...(escalationId ? { escalationId } : {}),
              ...(splitsMissing ? { splitsMissing: true } : {}),
              ...(amendmentNotice ? { amendmentNotice, staleGoalVersion } : {}),
            };
          });
          committed = true;
          return result;
        } catch (error) {
          if (overflowPath) rmSync(overflowPath, { force: true });
          throw error;
        } finally {
          // Tear down a merged Tier 2 worktree once the worker settles via return_task
          if (committed && status === "completed" && task.tier === 2 && task.worktreeId) {
            const wt = this.db.getWorktree(task.worktreeId);
            if (wt && wt.status === "merged" && !wt.cleanedAt) {
              void this.hooks
                .getWorktreeManager(run.repoRoot)
                .teardown(wt.id, { archiveBeforeRemove: false, finalStatus: "merged" })
                .catch(() => {});
            }
          }
        }
      }

      case "report_issue": {
        const severity = String(args.severity) as EscalationSeverity;
        const category = String(args.category) as EscalationCategory;
        const evidencePaths = Array.isArray(args.evidence_paths) ? (args.evidence_paths as string[]) : [];
        const attempted = Array.isArray(args.attempted) ? (args.attempted as string[]) : [];
        const role = roleOf(task);
        const readOnlyFinding =
          (role === "research" || role === "plan" || role === "verify") &&
          READ_ONLY_FINDING_CATEGORIES.has(category);
        const blocking =
          args.blocking === undefined
            ? readOnlyFinding
              ? false
              : severity !== "P2"
            : Boolean(args.blocking);

        const toTaskId = readOnlyFinding && !blocking ? task.parentId : severity === "P0" ? null : task.parentId;
        const { title, derived } = deriveTitle(
          args.title,
          [args.summary, args.body, ...attempted, evidencePaths[0]],
          `Untitled ${category} issue`,
        );
        const esc = this.db.createEscalation({
          runId,
          fromTaskId: taskId,
          toTaskId,
          severity,
          category,
          title,
          evidencePaths,
          attempted,
          blocking,
          tool: "report_issue",
        });
        if (blocking) {
          const blockedSummary = `Blocked on ${esc.id}: ${esc.title}`;
          settleTaskMinimalFallback(this.db, task, "blocked", blockedSummary, `blocked: ${esc.id} (${esc.title.slice(0, 160)})`);
          this.hooks.stopTaskForBlockingIssue?.(taskId, blockedSummary);
        }
        return {
          escalationId: esc.id,
          severity: esc.severity,
          routedTo: toTaskId ?? "human",
          blocking,
          ...(derived ? { note: derivedTitleNote(esc.title) } : {}),
        };
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
        const rawQuery = String(args.query ?? "").trim();
        const q = rawQuery.toLowerCase();
        const limit = typeof args.limit === "number" && Number.isFinite(args.limit) ? Math.max(1, Math.min(50, Math.floor(args.limit))) : 12;
        const matches = this.db.searchPredecessorHistory(runId, taskId, rawQuery, limit);
        const tokens = q.split(/\s+/).filter(Boolean);
        const arts = this.db
          .listArtifacts(runId, taskId, 100)
          .filter((a) => {
            const hay = `${a.path} ${a.summary}`.toLowerCase();
            return tokens.length > 0 && tokens.some((tok) => hay.includes(tok));
          })
          .slice(0, limit);
        return { matchingEvents: matches, matchingArtifacts: arts };
      }

      case "artifact_write": {
        const art = writeTaskDossier(this.db, run, taskId, String(args.name), String(args.content), String(args.summary));
        return { artifactId: art.id, path: art.path };
      }

      case "artifact_read": {
        if (task.tier === 1 || typeof args.path !== "string" || !args.path || findRunDossier(this.db, run, args.path) !== null) {
          return readRunDossier(this.db, run, args);
        }
        const root = task.worktreeId ? this.db.getWorktree(task.worktreeId)?.path : run.repoRoot;
        if (!root) throw new Error("Task worktree unavailable");
        return readWorkspaceArtifact(root, args.path, args.max_chars, args.offset);
      }

      case "inspect_command": {
        if (!Array.isArray(args.argv) || args.argv.length === 0 || !args.argv.every((a) => typeof a === "string")) {
          throw new Error("inspect_command requires argv as a non-empty array of strings");
        }
        if (args.cwd !== undefined && typeof args.cwd !== "string") {
          throw new Error("inspect_command cwd must be a string");
        }
        const argv = args.argv as string[];
        const root = task.worktreeId ? this.db.getWorktree(task.worktreeId)?.path : run.repoRoot;
        if (!root) throw new Error("Task workspace unavailable");
        const realRoot = realpathSync(root);
        const requestedCwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : ".";
        let cwd: string;
        try {
          cwd = realpathSync(resolve(realRoot, requestedCwd));
        } catch {
          throw REJECTIONS.inspectCwd(requestedCwd);
        }
        const relCwd = relative(realRoot, cwd);
        if (
          isAbsolute(relCwd) ||
          relCwd === ".." ||
          relCwd.startsWith(`..${sep}`) ||
          isProtectedWritePath(realRoot, cwd) ||
          !statSync(cwd).isDirectory()
        ) {
          throw REJECTIONS.inspectCwd(requestedCwd);
        }
        // Only operator global config (config.worktree.extraReadRoots) may authorize external read roots;
        // repository-configurable artifactsDir and dossier symlinks outside realRoot are never promoted.
        const resolvedExtraReadRoots: string[] = [];
        for (const raw of this.config.worktree.extraReadRoots ?? []) {
          const trimmed = raw.trim();
          if (!trimmed) continue;
          const expanded = resolve(expandHomePath(trimmed));
          let canonical = expanded;
          try {
            canonical = realpathSync(expanded);
          } catch {
            // Non-existent root stays at expanded path.
          }
          if (!resolvedExtraReadRoots.includes(canonical)) resolvedExtraReadRoots.push(canonical);
        }
        const readRoots = [realRoot, ...resolvedExtraReadRoots.filter((r) => r !== realRoot)];
        const verdict = checkReadOnlyArgv(argv, { cwd, readRoots, protectedRoots: readRoots });
        if (!verdict.ok) {
          throw REJECTIONS.readOnlyArgv(argv[0] ?? "", verdict.reason);
        }
        const rawTimeout = args.timeout_s === undefined ? 120 : Number(args.timeout_s);
        if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
          throw new Error("inspect_command timeout_s must be a positive number");
        }
        const timeoutMs = Math.min(900, rawTimeout) * 1000;
        const signal = callerSignal ?? scriptSignal ?? this.hooks.getTaskSignal(taskId);
        const bin = argv[0]!;
        const isGateRunner = bin === "bun" || bin === "bunx";
        let executable: string;
        let env: NodeJS.ProcessEnv;
        if (isGateRunner) {
          const resolved = await resolveGateEnv({
            cwd,
            config: {
              gateShell: this.config.goals.gateShell,
              gateEnv: this.config.goals.gateEnv,
              stateDir: this.config.stateDir,
            },
            signal,
          });
          env = {
            ...resolved.env,
            GIT_PAGER: "cat",
            PAGER: "cat",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            NO_COLOR: "1",
            CI: "1",
          };
          delete env.GIT_EXTERNAL_DIFF;
          executable = bin;
        } else {
          const workspaceRoots = [root, realRoot, run.repoRoot];
          try {
            executable = await resolveTrustedBinary(bin, { disallowInsideRoots: workspaceRoots });
          } catch (err) {
            throw new Error(`inspect_command rejected: ${err instanceof Error ? err.message : String(err)}`);
          }
          const trustedPath = await filterTrustedPath(process.env.PATH, workspaceRoots);
          env = {
            ...(trustedPath ? { PATH: trustedPath } : {}),
            ...(process.env.HOME !== undefined ? { HOME: process.env.HOME } : {}),
            ...(process.env.LANG !== undefined ? { LANG: process.env.LANG } : {}),
            ...(process.env.LC_ALL !== undefined ? { LC_ALL: process.env.LC_ALL } : {}),
            GIT_PAGER: "cat",
            PAGER: "cat",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            NO_COLOR: "1",
            CI: "1",
          };
        }
        const gitSafePrefix = [
          "--no-pager",
          "-c", "core.fsmonitor=false",
          "-c", "diff.external=",
          "-c", "core.hooksPath=/dev/null",
          "-c", "protocol.ext.allow=never",
          "-c", "protocol.file.allow=never",
        ];
        const gitNetworkSafePrefix = [
          "-c", "core.sshCommand=ssh",
          "-c", "core.gitProxy=",
          "-c", "credential.helper=",
        ];
        let isGitNetwork = false;
        if (bin === "git") {
          let g = 1;
          while (g < argv.length && (argv[g] === "--no-pager" || argv[g] === "-P" || argv[g] === "--no-optional-locks")) {
            g++;
          }
          const gitSub = argv[g];
          if (gitSub === "fetch" || gitSub === "ls-remote") {
            isGitNetwork = true;
            const parsed = parseReadOnlyGitNetworkCommand(gitSub, argv.slice(g + 1));
            if (!parsed) {
              throw new Error(`inspect_command rejected: git ${gitSub} arguments are not allowed in read-only mode`);
            }
            const probeTimeoutMs = Math.min(timeoutMs, 15_000);
            const remotesRes = await runArgv(executable, [...gitSafePrefix, "remote"], {
              cwd,
              env,
              timeoutMs: probeTimeoutMs,
              maxOutputBytes: 256 * 1024,
              signal,
            });
            if (remotesRes.stopped || remotesRes.exitCode !== 0) {
              throw new Error("inspect_command rejected: failed to list configured git remotes");
            }
            const configuredRemotes = remotesRes.stdout
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean);
            let remotesToCheck: string[];
            if (parsed.allRemotes) {
              remotesToCheck = configuredRemotes;
            } else {
              if (!configuredRemotes.includes(parsed.remote)) {
                throw new Error(`inspect_command rejected: git remote '${parsed.remote}' is not a configured remote`);
              }
              remotesToCheck = [parsed.remote];
            }
            for (const remoteName of remotesToCheck) {
              const escapedRemote = remoteName.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
              const vcsRes = await runArgv(
                executable,
                [...gitSafePrefix, "config", "--get-regexp", "--", `^remote\\.${escapedRemote}\\.vcs$`],
                {
                  cwd,
                  env,
                  timeoutMs: probeTimeoutMs,
                  maxOutputBytes: 256 * 1024,
                  signal,
                },
              );
              if (vcsRes.stopped || (vcsRes.exitCode !== 0 && vcsRes.exitCode !== 1)) {
                throw new Error(`inspect_command rejected: failed to inspect git config for remote '${remoteName}'`);
              }
              if (vcsRes.exitCode === 0) {
                throw new Error(
                  `inspect_command rejected: remote helper selection via remote.${remoteName}.vcs is not allowed`,
                );
              }
              const urlRes = await runArgv(executable, [...gitSafePrefix, "remote", "get-url", "--all", "--", remoteName], {
                cwd,
                env,
                timeoutMs: probeTimeoutMs,
                maxOutputBytes: 256 * 1024,
                signal,
              });
              if (urlRes.stopped || urlRes.exitCode !== 0) {
                throw new Error(`inspect_command rejected: failed to resolve URL for git remote '${remoteName}'`);
              }
              const urls = urlRes.stdout
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean);
              if (urls.length === 0 || urls.some((u) => !isSafeGitRemoteUrl(u))) {
                throw new Error(
                  `inspect_command rejected: git remote '${remoteName}' URL must use https://, ssh://, or user@host:path`,
                );
              }
            }
          }
        }
        const execArgs = bin === "git"
          ? [...gitSafePrefix, ...(isGitNetwork ? gitNetworkSafePrefix : []), ...argv.slice(1)]
          : argv.slice(1);
        let execEnv = env;
        if (isGitNetwork) {
          execEnv = {
            ...env,
            ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
          };
          delete execEnv.GIT_SSH;
          delete execEnv.GIT_SSH_COMMAND;
          delete execEnv.GIT_PROXY_COMMAND;
          delete execEnv.GIT_ASKPASS;
          delete execEnv.SSH_ASKPASS;
        }
        const r = await runArgv(executable, execArgs, {
          cwd,
          env: execEnv,
          timeoutMs,
          maxOutputBytes: 8 * 1024 * 1024,
          signal,
        });
        const MAX_STREAM_CHARS = 20_000;
        const keepTail = bin === "bun" || bin === "bunx";
        const truncated = r.stdout.length > MAX_STREAM_CHARS || r.stderr.length > MAX_STREAM_CHARS;
        const clip = (s: string) =>
          s.length <= MAX_STREAM_CHARS
            ? s
            : keepTail
              ? s.slice(s.length - MAX_STREAM_CHARS)
              : s.slice(0, MAX_STREAM_CHARS);
        let outputPath: string | undefined;
        if (truncated) {
          const fullOutput = [
            `$ ${argv.join(" ")}`,
            `cwd: ${relCwd || "."}`,
            `exit_code: ${r.exitCode ?? "null"}${r.stopped ? ` (stopped: ${r.stopped})` : ""}`,
            "",
            "=== STDOUT ===",
            r.stdout,
            ...(r.stderr ? ["", "=== STDERR ===", r.stderr] : []),
          ].join("\n");
          outputPath = writeUniqueTaskDossier(
            this.db,
            run,
            taskId,
            "inspect-output",
            ".txt",
            fullOutput,
            "inspect_command output",
          ).path;
        }
        return {
          argv,
          cwd: relCwd || ".",
          exit_code: r.exitCode,
          ...(r.stopped ? { stopped: r.stopped } : {}),
          stdout: clip(r.stdout),
          stderr: clip(r.stderr),
          truncated,
          ...(outputPath ? { output_path: outputPath } : {}),
          ...(r.stopped || truncated
            ? {
                hint: "Output was cut. Narrow the command with a path, a glob, or a match limit, or page the saved output with artifact_read.",
              }
            : {}),
        };
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
        if (target.tier === 3) throw new Error(`Task ${targetId} is a Tier 3 agent without reply_agent; use steer_child for your own Tier 3 children.`);
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
        void this.hooks
          .steerTask(
            msg.fromTaskId,
            `Peer answer to your message ${msg.id} from ${taskId}:\n${msg.answer ?? ""}`,
          )
          .catch(() => {});
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
          throw REJECTIONS.submitDirtyWorktree();
        }
        const item = this.db.enqueueMerge({ runId, taskId, worktreeId: wt.id, branch: wt.branch });
        // Use the true task cancellation signal (not generation/rollover signal) so an auto-rollover never aborts an in-flight merge.
        const mergeSig = this.hooks.getTaskCancelSignal?.(taskId);
        const outcome = await this.hooks
          .getMergeQueue(run.repoRoot)
          .submitAndDrain(runId, item.id, { preserveLiveTask: true, signal: mergeSig });
        return {
          mergeId: item.id,
          status: outcome.item.status,
          mergedSha: outcome.mergedSha,
          bouncedReason: outcome.bouncedReason,
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
        const headSha = await runGit(run.repoRoot, ["rev-parse", "HEAD"])
          .then((r) => r.stdout || run.baseSha)
          .catch(() => run.baseSha);
        const kind = String(args.kind) as KbKind;
        const evidencePaths = Array.isArray(args.evidence_paths) ? (args.evidence_paths as string[]) : [];
        const { title, derived } = deriveTitle(
          args.title,
          [args.summary, args.context_md, args.body, args.content, evidencePaths[0]],
          `Untitled ${kind} entry`,
        );
        const entry = this.db.kb.propose({
          repoScope: run.repoRoot,
          kind,
          title,
          summary: String(args.summary),
          contextMd: String(args.context_md),
          tags: Array.isArray(args.tags) ? (args.tags as string[]) : [],
          pathGlobs: Array.isArray(args.path_globs) ? (args.path_globs as string[]) : [],
          evidencePaths,
          verifiedSha: headSha,
          sourceRunId: runId,
          sourceTaskId: taskId,
        });
        return {
          id: entry.id,
          status: entry.status,
          ...(derived ? { note: derivedTitleNote(entry.title) } : {}),
        };
      }

      case "kb_flag_stale": {
        const id = String(args.id);
        const existing = this.db.kb.getRaw(id);
        if (!existing || existing.repoScope !== run.repoRoot) {
          throw new Error(`KB entry ${id} not found in repository scope ${run.repoRoot}`);
        }
        return this.db.kb.flagStale(existing.id, String(args.reason));
      }

      case "kb_promote": {
        const id = String(args.id);
        const existing = this.db.kb.getRaw(id);
        if (!existing || existing.repoScope !== run.repoRoot) {
          throw new Error(`KB entry ${id} not found in repository scope ${run.repoRoot}`);
        }
        const verifiedSha =
          typeof args.verified_sha === "string" && args.verified_sha.trim()
            ? args.verified_sha.trim()
            : await runGit(run.repoRoot, ["rev-parse", "HEAD"])
                .then((r) => r.stdout || run.baseSha)
                .catch(() => run.baseSha);
        return this.db.kb.promote(existing.id, {
          title: typeof args.title === "string" ? args.title : undefined,
          summary: typeof args.summary === "string" ? args.summary : undefined,
          contextMd: typeof args.context_md === "string" ? args.context_md : undefined,
          verifiedSha,
        });
      }

      case "kb_archive": {
        const id = String(args.id);
        const existing = this.db.kb.getRaw(id);
        if (!existing || existing.repoScope !== run.repoRoot) {
          throw new Error(`KB entry ${id} not found in repository scope ${run.repoRoot}`);
        }
        const supersededBy =
          typeof args.superseded_by === "string" && args.superseded_by.trim() ? args.superseded_by.trim() : undefined;
        if (supersededBy) {
          const sup = this.db.kb.getRaw(supersededBy);
          if (!sup || sup.repoScope !== run.repoRoot) {
            throw new Error(`Superseding KB entry ${supersededBy} not found in repository scope ${run.repoRoot}`);
          }
        }
        return this.db.kb.archive(existing.id, {
          reason: typeof args.reason === "string" ? args.reason : undefined,
          supersededBy,
        });
      }

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

      case "wait_timer": {
        const timer = this.db.timers.schedule({
          ownerKind: "task",
          ownerId: taskId,
          runId,
          delaySeconds: typeof args.delay_seconds === "number" ? args.delay_seconds : undefined,
          wakeAtIso: typeof args.wake_at === "string" ? args.wake_at : undefined,
          reason: String(args.reason ?? "Timed wait"),
          wakeOnEvent:
            args.wake_on_event === "child_settled" || args.wake_on_event === "any" ? args.wake_on_event : "none",
        });
        this.db.emitEvent(runId, taskId, "agent.timer_sleep", {
          timerId: timer.id,
          wakeAt: timer.wakeAt,
          reason: timer.reason,
          wakeOnEvent: timer.wakeOnEvent,
        });
        const sig = scriptSignal ?? this.hooks.getTaskSignal(taskId);
        const res = await this.db.timers.waitForTimer(timer.id, sig);
        return {
          timerId: res.timer.id,
          status: res.timer.status,
          wakeReason: res.wakeReason,
          reason: res.timer.reason,
          sleptMs: Math.max(0, Date.now() - timer.createdAt),
        };
      }

      case "schedule_timer": {
        const timer = this.db.timers.schedule({
          ownerKind: "task",
          ownerId: taskId,
          runId,
          delaySeconds: typeof args.delay_seconds === "number" ? args.delay_seconds : undefined,
          wakeAtIso: typeof args.wake_at === "string" ? args.wake_at : undefined,
          reason: String(args.reason ?? "Scheduled reminder"),
          wakeOnEvent:
            args.wake_on_event === "child_settled" || args.wake_on_event === "any"
              ? args.wake_on_event
              : "none",
        });
        this.db.emitEvent(runId, taskId, "timer.scheduled", timer);
        return { timer };
      }

      case "list_timers": {
        const status =
          args.status === "pending" || args.status === "fired" || args.status === "cancelled" ? args.status : undefined;
        return { timers: this.db.timers.list({ ownerKind: "task", ownerId: taskId, status }) };
      }

      case "cancel_timer": {
        const id = String(args.timer_id);
        const existing = this.db.timers.get(id);
        if (!existing || existing.ownerKind !== "task" || existing.ownerId !== taskId) {
          throw new Error(`Unknown timer ${id} for task ${taskId}`);
        }
        const cancelled = this.db.timers.cancel(
          existing.id,
          typeof args.reason === "string" ? args.reason : "cancelled_by_agent",
        );
        if (!cancelled) throw new Error(`Unknown timer ${id}`);
        return { timer: cancelled };
      }

      case "resume_task": {
        if (!this.hooks.resumeTask) throw new Error("resume_task hook is not available");
        const target = this.db.getTask(String(args.task_id));
        if (!target || target.runId !== runId || target.parentId !== taskId) {
          throw new Error(`Unknown child task ${args.task_id}`);
        }
        const resumeOpts = {
          note: typeof args.note === "string" ? args.note : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          effort: typeof args.effort === "string" ? args.effort : undefined,
          profileId: optionalProfile(args.profile_id),
        };
        if (this.hooks.resumeTaskDetailed) {
          const res = await this.hooks.resumeTaskDetailed(target.id, resumeOpts);
          return {
            task: res.task,
            resumed: res.outcome === "resumed",
            outcome: res.outcome,
            message: res.message,
            ...(res.queuePosition !== undefined ? { queuePosition: res.queuePosition } : {}),
            ...(res.noteDelivered !== undefined ? { noteDelivered: res.noteDelivered } : {}),
          };
        }
        const resumed = await this.hooks.resumeTask(target.id, resumeOpts);
        return { task: resumed, resumed: true };
      }

      default:
        throw new Error(`Unhandled tool: ${name}`);
    }
  }

  private updateLinkedGoalProgress(
    runId: string,
    taskId: string,
    patch: {
      summary?: string;
      phase?: string;
      verificationStatus?: "not_needed" | "in_progress" | "passed" | "failed";
      criteriaResults?: Array<{ criterionId: string; passed: boolean; evidence: string; remediation?: string }>;
    },
    source?: GoalProgressSource,
  ): { recorded: boolean; goalId: string | null; dropped?: DroppedProgressEntry[]; note?: string } {
    try {
      const row = this.db.db
        .prepare(
          "SELECT id, version, review_cycle, criteria_json, live_progress_json FROM goals WHERE linked_run_id = ? ORDER BY updated_at DESC LIMIT 1",
        )
        .get(runId) as
        | { id: string; version: number; review_cycle: number | null; criteria_json?: string | null; live_progress_json?: string | null }
        | undefined;
      if (!row) return { recorded: false, goalId: null };

      const criterionIds = new Set<string>();
      if (typeof row.criteria_json === "string" && row.criteria_json.trim()) {
        try {
          const parsed = JSON.parse(row.criteria_json) as Array<{ id?: unknown }>;
          if (Array.isArray(parsed)) {
            for (const c of parsed) {
              if (typeof c?.id === "string" && c.id) criterionIds.add(c.id);
            }
          }
        } catch {
          // ignore unparseable criteria_json
        }
      }

      const task = this.db.getTask(taskId);
      const claimSource: GoalProgressSource = source ?? (task?.tier === 1 ? "coordinator" : "worker");
      const boundVersion =
        claimSource === "director" || claimSource === "system" ? null : (task?.goalVersion ?? 0);
      const currentVersion = Number(row.version);
      const filtered = filterProgressPatch(patch, {
        goalId: row.id,
        criterionIds,
        boundVersion,
        currentVersion,
      });

      const hasRemaining =
        filtered.patch.summary !== undefined ||
        filtered.patch.phase !== undefined ||
        filtered.patch.verificationStatus !== undefined ||
        filtered.patch.criteriaResults !== undefined;
      if (filtered.dropped.length > 0 && !hasRemaining) {
        return {
          recorded: false,
          goalId: row.id,
          dropped: filtered.dropped,
          note: filtered.note,
        };
      }

      let prev: GoalLiveProgress | null = null;
      if (typeof row.live_progress_json === "string" && row.live_progress_json.trim()) {
        try {
          prev = JSON.parse(row.live_progress_json) as GoalLiveProgress;
        } catch {
          prev = null;
        }
      }
      const now = Date.now();
      const next = mergeGoalLiveProgress(prev, { ...filtered.patch, reportedByTaskId: taskId }, {
        goalVersion: currentVersion,
        reporterGoalVersion: boundVersion,
        runId,
        reviewCycle: Number(row.review_cycle ?? 0),
        source: claimSource,
        now,
      });
      this.db.db
        .prepare("UPDATE goals SET live_progress_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(next), now, row.id);
      this.db.emitEvent(runId, taskId, "goal.progress", { goalId: row.id, ...next });
      return {
        recorded: true,
        goalId: row.id,
        ...(filtered.dropped.length > 0 ? { dropped: filtered.dropped, note: filtered.note } : {}),
      };
    } catch {
      return { recorded: false, goalId: null };
    }
  }

  private resolveSessionModelContext(runId: string): string | null {
    try {
      let chatSessionId: string | null = null;
      if (isDirectorTaskContainer(runId)) {
        chatSessionId = directorTaskRunOwner(runId);
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
