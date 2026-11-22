import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { HarnessConfig, RunnerProfileConfig } from "../config.js";
import type { ModelCatalogCompiler } from "../catalog/compiler.js";
import type { QuotaClient } from "../quota/client.js";
import { AcpRunner } from "../runners/acp-runner.js";
import { PiRunner } from "../runners/pi-runner.js";
import type { RunAgentRequest, RunAgentResult, RunnerExecutionHandle } from "../runners/types.js";
import { BisectingMergeQueue } from "../worktree/merge-queue.js";
import { WorktreeManager } from "../worktree/manager.js";
import type { AgentTier, ControlPlaneDb, RunRecord, TaskKind, TaskRecord } from "./db.js";
import { buildHydrationTurn, buildImmutableSystemPrompt, type AnchoredHandoff } from "./prompts.js";
import { ControlPlaneToolExecutor, toolsForTier } from "./tools.js";

interface ActiveTaskExecution {
  taskId: string;
  abort: AbortController;
  handle?: RunnerExecutionHandle;
  promise: Promise<void>;
}

interface TaskQuotaPauseMeta {
  profileId: string;
  model: string | null;
  reason: string;
  resetAt: string | null;
  pausedAt: number;
}

export interface RunQuotaPauseStatus {
  runId: string;
  pausedTaskIds: string[];
  mode: "auto_timer" | "user_timer" | "manual";
  source: "quota_endpoint" | "passive_reset" | "user_timer" | "none";
  resumeAt: string | null;
  reason: string;
  pausedAt: number;
}

interface InternalRunQuotaState extends RunQuotaPauseStatus {
  timer: ReturnType<typeof setTimeout> | null;
  earlyWakePoller: ReturnType<typeof setInterval> | null;
}

export type CustomRunnerFactory = (profile: RunnerProfileConfig) => {
  run: (req: RunAgentRequest) => Promise<RunAgentResult>;
};

export class HarnessOrchestrator {
  private active = new Map<string, ActiveTaskExecution>();
  private worktreeManagers = new Map<string, WorktreeManager>();
  private mergeQueues = new Map<string, BisectingMergeQueue>();
  private pendingRollovers = new Map<
    string,
    { handoff: AnchoredHandoff; target?: { profileId?: string; model?: string; effort?: string } }
  >();
  private taskQuotaHints = new Map<string, TaskQuotaPauseMeta>();
  private taskResumeNotes = new Map<string, { reason?: string; userMessage?: string | null }>();
  private runQuotaStates = new Map<string, InternalRunQuotaState>();
  private quiescenceCheckPending = new Set<string>();
  readonly toolExecutor: ControlPlaneToolExecutor;

  constructor(
    readonly db: ControlPlaneDb,
    readonly config: HarnessConfig,
    readonly catalog: ModelCatalogCompiler,
    public quota: QuotaClient,
    private readonly customRunnerFactory?: CustomRunnerFactory,
  ) {
    this.toolExecutor = new ControlPlaneToolExecutor(db, catalog, {
      spawnAndStartTask: (input) => this.spawnAndStartTask(input),
      waitForChildren: (parentId, ids, mode, timeoutMs) => this.waitForChildren(parentId, ids, mode, timeoutMs),
      steerTask: (taskId, message) => this.steerTask(taskId, message),
      cancelTask: (taskId, reason) => this.cancelTask(taskId, reason),
      scheduleRollover: (taskId, handoff, target) => {
        this.pendingRollovers.set(taskId, { handoff, target });
        const exec = this.active.get(taskId);
        if (exec?.handle) {
          void exec.handle.cancel("clean_rollover").catch(() => {});
        }
      },
      getWorktreeManager: (repoRoot) => this.getWorktreeManager(repoRoot),
      getMergeQueue: (repoRoot) => this.getMergeQueue(repoRoot),
    });
  }

  activeTaskCount(): number {
    return this.active.size;
  }

  /** Number of runs currently holding an armed auto-resume or user-scheduled quota timer. */
  scheduledQuotaResumeCount(): number {
    let n = 0;
    for (const st of this.runQuotaStates.values()) {
      if (st.timer || st.earlyWakePoller) n++;
    }
    return n;
  }

  getRunQuotaStatus(runId: string): RunQuotaPauseStatus | null {
    const st = this.runQuotaStates.get(runId);
    if (!st) return null;
    return {
      runId: st.runId,
      pausedTaskIds: [...st.pausedTaskIds],
      mode: st.mode,
      source: st.source,
      resumeAt: st.resumeAt,
      reason: st.reason,
      pausedAt: st.pausedAt,
    };
  }

  listQuotaPausedRuns(): RunQuotaPauseStatus[] {
    return [...this.runQuotaStates.values()].map((st) => ({
      runId: st.runId,
      pausedTaskIds: [...st.pausedTaskIds],
      mode: st.mode,
      source: st.source,
      resumeAt: st.resumeAt,
      reason: st.reason,
      pausedAt: st.pausedAt,
    }));
  }

  dispose(): void {
    for (const runId of [...this.runQuotaStates.keys()]) {
      this.clearRunQuotaTimers(runId);
    }
    this.runQuotaStates.clear();
  }

  private clearRunQuotaTimers(runId: string): void {
    const st = this.runQuotaStates.get(runId);
    if (!st) return;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.earlyWakePoller) {
      clearInterval(st.earlyWakePoller);
      st.earlyWakePoller = null;
    }
  }

  isRunActiveInMemory(runId: string): boolean {
    for (const taskId of this.active.keys()) {
      const t = this.db.getTask(taskId);
      if (t?.runId === runId) return true;
    }
    return false;
  }

  getWorktreeManager(repoRoot: string): WorktreeManager {
    let mgr = this.worktreeManagers.get(repoRoot);
    if (!mgr) {
      mgr = new WorktreeManager(this.db, repoRoot, this.config.worktree);
      this.worktreeManagers.set(repoRoot, mgr);
    }
    return mgr;
  }

  getMergeQueue(repoRoot: string): BisectingMergeQueue {
    let mq = this.mergeQueues.get(repoRoot);
    if (!mq) {
      mq = new BisectingMergeQueue(this.db, this.getWorktreeManager(repoRoot), repoRoot, this.config.worktree);
      this.mergeQueues.set(repoRoot, mq);
    }
    return mq;
  }

  private resolveProfile(profileId?: string, tier?: AgentTier): RunnerProfileConfig {
    const wanted =
      profileId ??
      (tier === 1
        ? this.config.defaultOrchestratorProfile
        : tier === 2
          ? this.config.defaultWorkerProfile
          : this.config.defaultTaskProfile);
    const found =
      (wanted ? this.config.profiles.find((p) => p.id === wanted) : undefined) ??
      this.config.profiles.find((p) => p.enabled !== false);
    if (!found) {
      throw new Error(`No enabled runner profile found (requested: ${wanted ?? "default"})`);
    }
    return found;
  }

  async startRun(input: {
    goal: string;
    repoRoot: string;
    profileId?: string;
    model?: string;
    effort?: string;
  }): Promise<{ run: RunRecord; orchestratorTask: TaskRecord }> {
    const wtMgr = this.getWorktreeManager(input.repoRoot);
    const { baseBranch, baseSha } = await wtMgr.resolveRepoInfo();
    const run = this.db.createRun({ goal: input.goal, repoRoot: input.repoRoot, baseBranch, baseSha });

    const profile = this.resolveProfile(input.profileId, 1);
    const orchestratorTask = this.db.createTask({
      runId: run.id,
      parentId: null,
      tier: 1,
      kind: "orchestrator",
      title: `Orchestrator: ${(input.goal.split("\n")[0] ?? input.goal).slice(0, 72)}`,
      objective: input.goal,
      criteria: "Decompose into disjoint Tier 2 Workers, resolve escalations, verify integration on base branch.",
      readOnly: true,
      profileId: profile.id,
      model: input.model ?? null,
      effort: input.effort ?? null,
      maxTurns: 200,
    });

    this.launchTaskLoop(orchestratorTask.id);
    return { run, orchestratorTask };
  }

  async spawnAndStartTask(input: {
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
  }): Promise<TaskRecord> {
    const run = this.db.getRun(input.runId);
    if (!run) throw new Error(`Unknown run ${input.runId}`);
    const profile = this.resolveProfile(input.profileId, input.tier);

    const task = this.db.createTask({
      runId: input.runId,
      parentId: input.parentId,
      tier: input.tier,
      kind: input.kind,
      title: input.title,
      objective: input.objective,
      criteria: input.criteria,
      readOnly: input.readOnly,
      profileId: profile.id,
      model: input.model ?? null,
      effort: input.effort ?? null,
      maxTurns: input.maxTurns ?? (input.tier === 3 ? this.config.rollover.taskMaxTurns : 120),
      dependsOn: input.dependsOn,
      writeScopes: input.writeScopes,
    });

    // Tier 2 Workers get their own isolated git worktree automatically
    if (task.tier === 2) {
      const wtMgr = this.getWorktreeManager(run.repoRoot);
      await wtMgr.createForWorker(run.id, task.id);
    } else if (task.tier === 3 && input.parentId) {
      // Tier 3 Task Agents inherit their parent Worker's worktree
      const parent = this.db.getTask(input.parentId);
      if (parent?.worktreeId) {
        this.db.updateTask(task.id, { worktreeId: parent.worktreeId });
      }
    }

    const updated = this.db.getTask(task.id)!;
    if (updated.status === "ready") {
      this.launchTaskLoop(updated.id);
    }
    return updated;
  }

  launchTaskLoop(taskId: string): void {
    if (this.active.has(taskId)) return;
    const abort = new AbortController();
    const entry: ActiveTaskExecution = {
      taskId,
      abort,
      promise: Promise.resolve(),
    };
    entry.promise = this.runTaskWithRollovers(taskId, entry).finally(() => {
      this.active.delete(taskId);
      // Kick any newly unblocked dependent tasks in the same run
      const t = this.db.getTask(taskId);
      if (t) {
        const readyTasks = this.db.listTasks(t.runId, { status: "ready" });
        let launchedAny = false;
        for (const rt of readyTasks) {
          if (!this.active.has(rt.id)) {
            this.launchTaskLoop(rt.id);
            launchedAny = true;
          }
        }
        // Quiescence barrier: once ALL active tasks in this run have exited and at least one
        // task was stopped early due to quota, pause the run & arm timer (if quota data exists).
        if (!launchedAny && !this.isRunActiveInMemory(t.runId)) {
          void this.checkRunQuotaQuiescence(t.runId).catch(() => {});
        }
      }
    });
    this.active.set(taskId, entry);
  }

  /**
   * Quiescence Barrier: called when 0 tasks are actively running in `runId`.
   * If any tasks are in `paused_quota`:
   *  - Transitions the run to `paused_quota`.
   *  - If a Quota Endpoint is wired OR passive ACP rate-limit data provided a concrete reset time
   *    (and `autoResumeEnabled` is true): arms an automatic daemon timer (+ early-wakeup poller).
   *  - Otherwise (no Quota Endpoint & no reset time): stops cleanly and waits for the user to
   *    resume manually or pick a wait duration!
   */
  private async checkRunQuotaQuiescence(runId: string): Promise<void> {
    if (this.quiescenceCheckPending.has(runId)) return;
    const run = this.db.getRun(runId);
    if (!run || ["stopped", "cancelled", "completed", "failed"].includes(run.status)) return;
    if (this.isRunActiveInMemory(runId)) return;

    const tasks = this.db.listTasks(runId);
    const pausedTasks = tasks.filter((t) => t.status === "paused_quota");
    if (pausedTasks.length === 0) return;

    this.quiescenceCheckPending.add(runId);
    try {
      // Query quota status for tasks that actually hit quota (excluding parents paused only to wait on children)
      const directlyQuotaPaused = pausedTasks.filter((t) => this.taskQuotaHints.has(t.id));
      const queryTargets = directlyQuotaPaused.length > 0 ? directlyQuotaPaused : pausedTasks;
      const queries = queryTargets.map((t) => {
        const hint = this.taskQuotaHints.get(t.id);
        const profile = this.config.profiles.find((p) => p.id === t.profileId);
        const provider =
          profile?.kind === "pi"
            ? profile.provider
            : profile?.adapter && profile.adapter !== "generic"
              ? profile.adapter
              : t.profileId;
        return {
          profileId: t.profileId,
          provider,
          wireModelId: t.model ?? "*",
          canonicalModelId: t.model ?? undefined,
          hintResetAt: hint?.resetAt ?? null,
        };
      });

      const schedule = await this.quota.resolveResumeSchedule(queries, { forceSync: true });

      // Ensure run wasn't manually resumed or stopped while we queried the Quota Endpoint
      const freshRun = this.db.getRun(runId);
      if (!freshRun || freshRun.status === "stopped" || this.isRunActiveInMemory(runId)) return;
      const stillPaused = this.db.listTasks(runId).filter((t) => t.status === "paused_quota");
      if (stillPaused.length === 0) return;

      this.clearRunQuotaTimers(runId);
      this.db.updateRunStatus(runId, "paused_quota");

      const firstReason =
        stillPaused.map((t) => this.taskQuotaHints.get(t.id)?.reason ?? t.summary).find(Boolean) ?? "Quota limit reached";
      const autoEnabled = this.config.quotaRetry.autoResumeEnabled !== false;
      const canAutoSchedule = autoEnabled && schedule.resumeAtMs !== null;

      const state: InternalRunQuotaState = {
        runId,
        pausedTaskIds: stillPaused.map((t) => t.id),
        mode: canAutoSchedule ? "auto_timer" : "manual",
        source: canAutoSchedule ? (schedule.source === "unknown" ? "none" : schedule.source) : "none",
        resumeAt: canAutoSchedule && schedule.resumeAtMs ? new Date(schedule.resumeAtMs).toISOString() : null,
        reason: firstReason,
        pausedAt: Date.now(),
        timer: null,
        earlyWakePoller: null,
      };

      if (canAutoSchedule && schedule.resumeAtMs) {
        const delayMs = Math.max(250, schedule.resumeAtMs - Date.now());
        state.timer = setTimeout(() => {
          void this.resumeRunFromQuota(runId, { trigger: "auto_timer" }).catch(() => {});
        }, delayMs);
        state.timer.unref?.();

        // If a Quota Endpoint is wired and the wait is long, also poll periodically to wake up early if quota returns!
        const pollMs = Math.max(5_000, this.config.quotaRetry.earlyWakePollMs ?? 30_000);
        if (this.quota.isConfigured() && delayMs > pollMs) {
          state.earlyWakePoller = setInterval(() => {
            void this.quota
              .resolveResumeSchedule(queries, { forceSync: true })
              .then((check) => {
                if (check.availableNow && this.runQuotaStates.has(runId)) {
                  void this.resumeRunFromQuota(runId, { trigger: "quota_recovered" }).catch(() => {});
                }
              })
              .catch(() => {});
          }, pollMs);
          state.earlyWakePoller.unref?.();
        }
      }

      this.runQuotaStates.set(runId, state);
      this.db.emitEvent(runId, null, "quota.run_paused", {
        runId,
        pausedTaskIds: state.pausedTaskIds,
        mode: state.mode,
        source: state.source,
        resumeAt: state.resumeAt,
        reason: state.reason,
        hasQuotaEndpoint: this.quota.isConfigured(),
        detail: canAutoSchedule
          ? schedule.detail
          : "No Quota Endpoint or reset time available — paused cleanly. Resume anytime or choose a wait duration.",
      });
    } finally {
      this.quiescenceCheckPending.delete(runId);
    }
  }

  /**
   * Lets the user choose how long to wait before automatically resuming a quota-paused run
   * (especially useful when no Quota Endpoint is wired up!).
   */
  scheduleRunQuotaResume(runId: string, delayMs: number): RunQuotaPauseStatus {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const pausedTasks = this.db.listTasks(runId).filter((t) => t.status === "paused_quota");
    if (pausedTasks.length === 0 && run.status !== "paused_quota") {
      throw new Error(`Run ${runId} has no quota-paused tasks to schedule`);
    }

    const clampedMs = Math.max(1_000, Math.min(delayMs, 24 * 60 * 60 * 1000));
    this.clearRunQuotaTimers(runId);
    const prev = this.runQuotaStates.get(runId);
    const resumeAtIso = new Date(Date.now() + clampedMs).toISOString();

    const state: InternalRunQuotaState = {
      runId,
      pausedTaskIds: pausedTasks.map((t) => t.id),
      mode: "user_timer",
      source: "user_timer",
      resumeAt: resumeAtIso,
      reason: prev?.reason ?? pausedTasks[0]?.summary ?? "Quota limit reached",
      pausedAt: prev?.pausedAt ?? Date.now(),
      timer: null,
      earlyWakePoller: null,
    };

    state.timer = setTimeout(() => {
      void this.resumeRunFromQuota(runId, { trigger: "user_timer" }).catch(() => {});
    }, clampedMs);
    state.timer.unref?.();

    this.runQuotaStates.set(runId, state);
    if (run.status !== "paused_quota") {
      this.db.updateRunStatus(runId, "paused_quota");
    }
    this.db.emitEvent(runId, null, "quota.run_scheduled", {
      runId,
      pausedTaskIds: state.pausedTaskIds,
      resumeAt: resumeAtIso,
      delayMs: clampedMs,
      source: "user_timer",
    });
    return this.getRunQuotaStatus(runId)!;
  }

  /**
   * Resumes a quota-paused run (manually, via user-chosen wait timer, via Quota Endpoint timer,
   * or early wakeup) and COMPLETELY RESETS the quota pause state machine.
   * If no quota is actually available when resumed, the restarted tasks naturally walk through
   * the exact same states (native retry up to timeout -> paused_quota -> quiescence -> pause again).
   */
  async resumeRunFromQuota(
    runId: string,
    opts?: { trigger?: "manual" | "auto_timer" | "quota_recovered" | "user_timer"; userMessage?: string },
  ): Promise<{ resumed: boolean; resumedTaskIds: string[]; run: RunRecord }> {
    const run = this.db.getRun(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);

    const trigger = opts?.trigger ?? "manual";
    this.clearRunQuotaTimers(runId);
    this.runQuotaStates.delete(runId);

    const tasks = this.db.listTasks(runId);
    const pausedTasks = tasks.filter((t) => t.status === "paused_quota");
    if (pausedTasks.length === 0) {
      if (run.status === "paused_quota") {
        this.db.updateRunStatus(runId, "active");
      }
      return { resumed: false, resumedTaskIds: [], run: this.db.getRun(runId)! };
    }

    // Reset passive quota exhaustion state for all affected profiles so the state machine starts fresh!
    const affectedProfiles = new Set(pausedTasks.map((t) => t.profileId));
    for (const pid of affectedProfiles) {
      this.quota.clearPassiveExhaustion(pid);
    }

    this.db.updateRunStatus(runId, "active");
    const resumedTaskIds: string[] = [];

    for (const t of pausedTasks) {
      const hint = this.taskQuotaHints.get(t.id);
      this.taskQuotaHints.delete(t.id);
      this.taskResumeNotes.set(t.id, {
        reason: hint?.reason ?? t.summary ?? "quota limit",
        userMessage: opts?.userMessage ?? null,
      });
      this.db.updateTask(t.id, {
        status: "ready",
        sessionId: null,
      });
      resumedTaskIds.push(t.id);
    }

    this.db.emitEvent(runId, null, "quota.run_resumed", {
      runId,
      trigger,
      resumedTaskIds,
      userMessage: opts?.userMessage ?? null,
    });

    for (const id of resumedTaskIds) {
      this.launchTaskLoop(id);
    }

    return { resumed: true, resumedTaskIds, run: this.db.getRun(runId)! };
  }

  private async runTaskWithRollovers(taskId: string, exec: ActiveTaskExecution): Promise<void> {
    while (!exec.abort.signal.aborted) {
      const task = this.db.getTask(taskId);
      if (!task) return;
      if (["completed", "cancelled", "failed", "returned_for_rescope", "paused_quota"].includes(task.status)) return;

      const run = this.db.getRun(task.runId);
      if (!run) return;

      const wt = task.worktreeId ? this.db.getWorktree(task.worktreeId) : null;
      const cwd = wt?.path ?? run.repoRoot;
      const profile = this.resolveProfile(task.profileId, task.tier);

      this.db.updateTask(task.id, { status: "running" });

      const handoff = task.handoffJson ? (JSON.parse(task.handoffJson) as AnchoredHandoff) : null;
      const quotaResumeNote = this.taskResumeNotes.get(task.id) ?? null;
      if (quotaResumeNote) this.taskResumeNotes.delete(task.id);

      const systemPrompt = buildImmutableSystemPrompt(task.tier, task.kind);
      const scopedKbHints =
        task.tier === 2 ? this.db.kb.getScopedAmbientIndex(run.repoRoot, this.db.listActiveWriteScopes(run.id), 5) : [];

      const initialPrompt = buildHydrationTurn({
        task,
        handoff,
        tasksSnapshot: this.db.listTasks(run.id),
        artifacts: this.db.listArtifacts(run.id, task.tier === 1 ? undefined : task.id, 30),
        openEscalations: this.db.listEscalations(run.id, "open"),
        blackboard: this.db.blackboardGet(run.id),
        scopedKbHints,
        worktreePath: wt?.path ?? null,
        worktreeBranch: wt?.branch ?? null,
        quotaResumeNote,
      });

      const rolloverThreshold =
        task.tier === 1
          ? this.config.rollover.orchestratorThreshold
          : task.tier === 2
            ? this.config.rollover.workerThreshold
            : undefined;

      const mcpBridgeEntrypoint = join(dirname(fileURLToPath(import.meta.url)), "..", "runners", "mcp-bridge.ts");

      const runnerReq: RunAgentRequest = {
        runId: run.id,
        taskId: task.id,
        tier: task.tier,
        kind: task.kind,
        cwd,
        readOnly: task.readOnly,
        systemPrompt,
        initialPrompt,
        model: task.model,
        effort: task.effort,
        maxTurns: task.maxTurns,
        rolloverThreshold,
        quotaRetryTimeoutMs: this.config.quotaRetry.nativeRetryTimeoutMs,
        tools: toolsForTier(task.tier),
        executeTool: (name, args) => this.toolExecutor.execute(run.id, task.id, name, args),
        daemonSocketPath: this.config.socketPath,
        mcpBridgeEntrypoint,
        signal: exec.abort.signal,
        onHandle: (h) => {
          exec.handle = h;
        },
        callbacks: {
          onSessionId: (sessionId) => {
            this.db.updateTask(task.id, { sessionId });
          },
          onTextDelta: (text) => {
            this.db.emitEvent(run.id, task.id, "agent.text_delta", { text });
          },
          onThoughtDelta: (text) => {
            this.db.emitEvent(run.id, task.id, "agent.thought_delta", { text });
          },
          onUsage: (usage) => {
            this.db.updateTask(task.id, { contextUsed: usage.used, contextSize: usage.size });
            this.db.emitEvent(run.id, task.id, "agent.usage", usage);
          },
          onArtifact: (art) => {
            this.db.recordArtifact({ runId: run.id, taskId: task.id, ...art });
          },
          onPassiveQuota: (sig) => {
            this.quota.ingestPassiveSignal(sig);
            this.db.emitEvent(run.id, task.id, "quota.passive_signal", sig);
          },
          onQuotaRetryState: (ev) => {
            this.db.emitEvent(run.id, task.id, ev.state === "retrying" ? "quota.agent_retrying" : "quota.agent_recovered", {
              ...ev,
              profileId: task.profileId,
              model: task.model,
              title: task.title,
            });
          },
          onToolEvent: (ev) => {
            this.db.emitEvent(run.id, task.id, "agent.tool", ev);
          },
        },
      };

      try {
        const runner = this.customRunnerFactory
          ? this.customRunnerFactory(profile)
          : profile.kind === "acp"
            ? new AcpRunner(profile)
            : new PiRunner(profile);

        const res = await runner.run(runnerReq);
        const latest = this.db.getTask(task.id)!;

        // Clean rollover requested either via explicit `request_rollover` tool OR automatic 60/65% threshold
        const explicitRollover = this.pendingRollovers.get(task.id);
        if (explicitRollover || res.stopReason === "rollover_requested") {
          this.pendingRollovers.delete(task.id);
          const nextGen = latest.generation + 1;
          const nextHandoff: AnchoredHandoff = explicitRollover?.handoff ?? {
            goalInvariants: [latest.objective],
            architecturalDecisions: [],
            activeRisks: ["Auto-rollover triggered by context threshold"],
            nextActions: ["Resume from authoritative SQLite Task Tree and Artifact Index"],
          };
          this.db.updateTask(task.id, {
            status: "ready",
            generation: nextGen,
            contextUsed: 0,
            sessionId: null,
            profileId: explicitRollover?.target?.profileId ?? latest.profileId,
            model: explicitRollover?.target?.model ?? latest.model,
            effort: explicitRollover?.target?.effort ?? latest.effort,
            handoffJson: JSON.stringify(nextHandoff),
          });
          this.db.emitEvent(run.id, task.id, "agent.rollover", {
            fromGen: latest.generation,
            toGen: nextGen,
            reason: explicitRollover ? "explicit_handoff" : "context_threshold",
          });
          continue; // Immediately boot generation N+1 cleanly!
        }

        // Agent stopped early due to quota / rate-limit timeout: preserve worktree & WIP, do NOT fail!
        if (res.stopReason === "quota_paused") {
          const qp = res.quotaPause;
          const reason = qp?.reason ?? "Quota / rate limit reached";
          this.taskQuotaHints.set(task.id, {
            profileId: latest.profileId,
            model: latest.model,
            reason,
            resetAt: qp?.resetAt ?? null,
            pausedAt: Date.now(),
          });
          this.db.updateTask(task.id, {
            status: "paused_quota",
            summary: `Paused (quota): ${reason}`.slice(0, 1000),
          });
          this.db.emitEvent(run.id, task.id, "quota.agent_paused", {
            runId: run.id,
            taskId: task.id,
            tier: latest.tier,
            title: latest.title,
            profileId: latest.profileId,
            model: latest.model,
            reason,
            resetAt: qp?.resetAt ?? null,
            retryCount: qp?.retryCount ?? 1,
            watchdogTimedOut: Boolean(qp?.watchdogTimedOut),
          });
          return;
        }

        // If task already transitioned via `return_task`, keep that status
        if (["completed", "returned_for_rescope", "blocked", "cancelled"].includes(latest.status)) {
          if (latest.tier === 1 && latest.status === "completed") {
            const hasPausedChildren = this.db.listTasks(run.id).some((t) => t.id !== latest.id && t.status === "paused_quota");
            if (hasPausedChildren) {
              this.db.updateTask(task.id, {
                status: "paused_quota",
                summary: "Waiting for quota-paused child task(s) to resume",
              });
            } else {
              this.db.updateRunStatus(run.id, "completed");
            }
          }
          return;
        }

        if (res.stopReason === "cancelled" || exec.abort.signal.aborted) {
          this.db.updateTask(task.id, { status: "cancelled", summary: "Cancelled" });
          return;
        }

        // If Tier 1 exited while child tasks are paused on quota, pause Tier 1 too instead of closing the run!
        if (latest.tier === 1) {
          const hasPausedChildren = this.db.listTasks(run.id).some((t) => t.id !== latest.id && t.status === "paused_quota");
          if (hasPausedChildren) {
            this.db.updateTask(task.id, {
              status: "paused_quota",
              summary: "Waiting for quota-paused child task(s) to resume",
            });
            return;
          }
        }

        // Agent finished its turn naturally without calling `return_task`
        this.db.updateTask(task.id, {
          status: "completed",
          summary: res.text.slice(0, 1000) || "Completed",
          resultJson: JSON.stringify({ status: "completed", text: res.text }),
        });
        if (latest.tier === 1) {
          this.db.updateRunStatus(run.id, "completed");
        }
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.db.updateTask(task.id, { status: "failed", summary: msg.slice(0, 1000) });
        this.db.emitEvent(run.id, task.id, "agent.error", { error: msg });
        if (task.tier === 1) {
          this.db.updateRunStatus(run.id, "failed");
        }
        return;
      }
    }
  }

  async steerTask(taskId: string, message: string): Promise<boolean> {
    const exec = this.active.get(taskId);
    if (!exec?.handle) return false;
    const ok = await exec.handle.steer(message);
    const task = this.db.getTask(taskId);
    if (task) {
      this.db.emitEvent(task.runId, taskId, "agent.steered", { message, accepted: ok });
    }
    return ok;
  }

  async cancelTask(taskId: string, reason: string): Promise<void> {
    const exec = this.active.get(taskId);
    if (exec) {
      await exec.handle?.cancel(reason).catch(() => {});
      exec.abort.abort(new Error(reason));
    }
    const task = this.db.getTask(taskId);
    if (task && !["completed", "cancelled", "failed"].includes(task.status)) {
      this.db.updateTask(taskId, { status: "cancelled", summary: `Cancelled: ${reason}` });
    }
  }

  async stopRun(runId: string, reason = "Stopped by user"): Promise<void> {
    this.clearRunQuotaTimers(runId);
    this.runQuotaStates.delete(runId);
    const tasks = this.db.listTasks(runId);
    await Promise.all(tasks.map((t) => this.cancelTask(t.id, reason)));
    this.db.updateRunStatus(runId, "stopped");
  }

  async waitForChildren(
    parentId: string,
    ids: string[] | undefined,
    mode: "any" | "all",
    timeoutMs: number,
  ): Promise<TaskRecord[]> {
    const parent = this.db.getTask(parentId);
    if (!parent) throw new Error(`Unknown parent task ${parentId}`);

    const terminal = new Set(["completed", "failed", "cancelled", "returned_for_rescope", "blocked", "paused_quota"]);
    const deadline = Date.now() + timeoutMs;

    const getTargets = () => {
      const kids = this.db.listTasks(parent.runId, { parentId });
      return ids?.length ? kids.filter((k) => ids.includes(k.id)) : kids;
    };

    const isDone = (targets: TaskRecord[]) => {
      if (targets.length === 0) return true;
      return mode === "any" ? targets.some((t) => terminal.has(t.status)) : targets.every((t) => terminal.has(t.status));
    };

    let targets = getTargets();
    if (isDone(targets)) return targets;

    this.db.updateTask(parentId, { status: "waiting_children" });
    return new Promise((resolve) => {
      const check = () => {
        targets = getTargets();
        if (isDone(targets) || Date.now() >= deadline) {
          unsub();
          clearTimeout(timer);
          this.db.updateTask(parentId, { status: "running" });
          resolve(targets);
        }
      };
      const unsub = this.db.onEvent((ev) => {
        if (ev.runId === parent.runId && (ev.type === "task.status" || ev.type === "escalation.created")) {
          check();
        }
      });
      const timer = setTimeout(check, Math.max(50, deadline - Date.now()));
    });
  }
}
