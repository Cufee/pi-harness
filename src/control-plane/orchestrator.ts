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
  readonly toolExecutor: ControlPlaneToolExecutor;

  constructor(
    readonly db: ControlPlaneDb,
    readonly config: HarnessConfig,
    readonly catalog: ModelCatalogCompiler,
    readonly quota: QuotaClient,
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
        for (const rt of readyTasks) {
          if (!this.active.has(rt.id)) {
            this.launchTaskLoop(rt.id);
          }
        }
      }
    });
    this.active.set(taskId, entry);
  }

  private async runTaskWithRollovers(taskId: string, exec: ActiveTaskExecution): Promise<void> {
    while (!exec.abort.signal.aborted) {
      const task = this.db.getTask(taskId);
      if (!task) return;
      if (["completed", "cancelled", "failed", "returned_for_rescope"].includes(task.status)) return;

      const run = this.db.getRun(task.runId);
      if (!run) return;

      const wt = task.worktreeId ? this.db.getWorktree(task.worktreeId) : null;
      const cwd = wt?.path ?? run.repoRoot;
      const profile = this.resolveProfile(task.profileId, task.tier);

      this.db.updateTask(task.id, { status: "running" });

      const handoff = task.handoffJson ? (JSON.parse(task.handoffJson) as AnchoredHandoff) : null;
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

        // If task already transitioned via `return_task`, keep that status
        if (["completed", "returned_for_rescope", "blocked", "cancelled"].includes(latest.status)) {
          if (latest.tier === 1 && latest.status === "completed") {
            this.db.updateRunStatus(run.id, "completed");
          }
          return;
        }

        if (res.stopReason === "cancelled" || exec.abort.signal.aborted) {
          this.db.updateTask(task.id, { status: "cancelled", summary: "Cancelled" });
          return;
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

    const terminal = new Set(["completed", "failed", "cancelled", "returned_for_rescope", "blocked"]);
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
