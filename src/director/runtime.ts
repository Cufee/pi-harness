import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCatalogCompiler } from "../catalog/compiler.js";
import { createCodeModeExecutor, effectiveCodeMode } from "../code-mode/index.js";
import type { HarnessConfig } from "../config.js";
import { resolveLaunchRoute } from "../control-plane/launch-route.js";
import { compactTaskHandoff, toolsForTier } from "../control-plane/tools.js";
import { writeCodeOutput, writeTaskDossier } from "../control-plane/dossiers.js";
import type { ControlPlaneDb } from "../control-plane/db.js";
import type { CustomRunnerFactory, HarnessOrchestrator } from "../control-plane/orchestrator.js";
import {
  GoalEngine,
  type CriterionEvaluation,
  type GoalCriterion,
  type GoalRecord,
  type GoalReviewVerdict,
} from "../goals/engine.js";
import { buildGoalDetailDisplay, buildGoalsTableDisplay, codeExecEventSink, summarizeToolDisplay, type ToolDisplayPayload } from "../protocol/tool-display.js";
import type { QuotaClient } from "../quota/client.js";
import { AcpRunner } from "../runners/acp-runner.js";
import { PiRunner } from "../runners/pi-runner.js";
import type { RunnerCallbacks, RunnerExecutionHandle, ToolDefinition } from "../runners/types.js";
import { runGit } from "../worktree/manager.js";
import { buildDirectorSystemPrompt, DirectorSessionStore, type ChatTurnRecord } from "./session.js";

const DIRECTOR_TOOLS: ToolDefinition[] = [
  {
    name: "goal_create",
    description:
      "Draft a structured, versioned Goal Contract with concrete deterministic check commands and behavioral/architectural acceptance criteria.",
    inputSchema: {
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
        commit_immediately: { type: "boolean", description: "Start autonomous Tier 1 execution with the selected model" },
        model: { type: "string", minLength: 1, description: "Required for immediate commit. Select from list_models." },
        profile_id: { type: "string" },
        effort: { type: "string" },
      },
    },
  },
  {
    name: "goal_commit",
    description: "Commit a draft Goal Contract and launch its autonomous Tier 1 Run-Until-Done Orchestrator.",
    inputSchema: {
      type: "object",
      required: ["goal_id", "model"],
      properties: {
        goal_id: { type: "string" },
        profile_id: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
      },
    },
  },
  {
    name: "goal_amend",
    description:
      "Dynamically amend an active or draft Goal Contract (vN -> vN+1), invalidating stale reviews and notifying the running Tier 1 Orchestrator with the exact delta.",
    inputSchema: {
      type: "object",
      required: ["goal_id", "rationale"],
      properties: {
        goal_id: { type: "string" },
        rationale: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        add_criteria: { type: "array", items: { type: "object" } },
        remove_criteria_ids: { type: "array", items: { type: "string" } },
        non_goals: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "goal_list",
    description:
      "List all Goals for this workspace with their version, status, review cycles, and linked run ID. The result is rendered as a live Goals table directly in the user's UI: call this instead of printing or duplicating a Goals table in prose, and afterwards add only brief commentary.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "goal_get",
    description:
      "Inspect a Goal's full criteria, latest review scorecard, linked run tree, and open escalations. The result is rendered as a Goal detail card directly in the user's UI: do not re-print it in prose; add only brief commentary.",
    inputSchema: {
      type: "object",
      required: ["goal_id"],
      properties: { goal_id: { type: "string" } },
    },
  },
  {
    name: "goal_trigger_review",
    description: "Run deterministic verification gates followed by an Independent Skeptical Done-Review on a Goal.",
    inputSchema: {
      type: "object",
      required: ["goal_id"],
      properties: { goal_id: { type: "string" } },
    },
  },
  {
    name: "goal_pause",
    description: "Pause an active Goal and stop its in-flight execution cleanly without discarding artifacts.",
    inputSchema: {
      type: "object",
      required: ["goal_id"],
      properties: { goal_id: { type: "string" } },
    },
  },
  {
    name: "goal_cancel",
    description: "Cancel a Goal permanently and stop its linked run.",
    inputSchema: {
      type: "object",
      required: ["goal_id"],
      properties: { goal_id: { type: "string" } },
    },
  },
  ...toolsForTier(1).filter(tool => ["spawn_task", "wait_tasks", "wait_children", "cancel_task", "artifact_read"].includes(tool.name)),
  {
    name: "read_file",
    description: "Read up to 4096 bytes of workspace text as a logged exception. Delegate normal inspection to spawn_task.",
    inputSchema: {
      type: "object",
      required: ["path", "exception_reason"],
      properties: { path: { type: "string" }, exception_reason: { type: "string", minLength: 1 }, max_chars: { type: "number" } },
    },
  },
  {
    name: "kb_search",
    description: "Search the workspace Knowledge Base for architectural invariants, decisions, and gotchas.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, path_globs: { type: "array", items: { type: "string" } } },
    },
  },
  {
    name: "list_models",
    description: "Inspect enabled latest-per-family models with coding rankings, cost/time/task, and live subscription quota capacity.",
    inputSchema: { type: "object", properties: { exclude_exhausted: { type: "boolean" } } },
  },
  {
    name: "steer_run",
    description: "Forward human steering guidance to an active Goal's Tier 1 Orchestrator.",
    inputSchema: {
      type: "object",
      required: ["goal_id", "message"],
      properties: { goal_id: { type: "string" }, message: { type: "string" } },
    },
  },
];

interface ChatSelection {
  repoRoot: string;
  profileId?: string;
  model?: string | null;
  effort?: string | null;
  title?: string;
}

interface ActiveChat {
  abort: AbortController;
  settled: Promise<void>;
  partial: string;
  flushedText: string;
  handle?: RunnerExecutionHandle;
  executor: ReturnType<typeof createCodeModeExecutor>;
  onToolEvent: RunnerCallbacks["onToolEvent"];
}

/**
 * Tier 0 Interactive Director Runtime + Independent Goal Verification & Done-Review Coordinator.
 * Keeps conversational human UX completely decoupled from Tier 1 autonomous DAG rollovers.
 */
export class DirectorRuntime {
  readonly chats: DirectorSessionStore;
  readonly goals: GoalEngine;
  private activeChats = new Map<string, ActiveChat>();
  private activeReviews = new Map<string, AbortController>();

  constructor(
    private readonly db: ControlPlaneDb,
    private config: HarnessConfig,
    private catalog: ModelCatalogCompiler,
    private quota: QuotaClient,
    private readonly orchestrator: HarnessOrchestrator,
    private readonly customRunnerFactory?: CustomRunnerFactory,
  ) {
    this.chats = new DirectorSessionStore(db.db);
    this.goals = new GoalEngine(db.db, (id) => this.activeReviews.get(id)?.abort(new Error("Goal changed during review")));
  }

  updateConfig(next: HarnessConfig, catalog = this.orchestrator.catalog, quota = this.orchestrator.quota): void {
    this.config = next;
    this.catalog = catalog;
    this.quota = quota;
  }

  private async resolveChatSelection(input: ChatSelection) {
    const { profile, model } = await resolveLaunchRoute(this.config, {
      tier: 0, cwd: input.repoRoot, profileId: input.profileId, model: input.model, catalog: this.catalog, quota: this.quota,
    });
    return { ...input, profileId: profile.id, model };
  }

  async createChat(input: ChatSelection) {
    return this.chats.createSession(await this.resolveChatSelection(input));
  }

  async openDefaultChat(input: ChatSelection) {
    const existing = this.chats.getWorkspaceSession(input.repoRoot);
    if (existing) return existing;
    return this.chats.getOrCreateDefault(await this.resolveChatSelection(input));
  }

  activeChatCount(): number {
    return this.activeChats.size;
  }

  activeReviewCount(): number {
    return this.activeReviews.size;
  }

  isChatBusy(chatSessionId: string): boolean {
    return this.activeChats.has(chatSessionId);
  }

  async commitGoal(goalId: string, opts?: { profileId?: string; model?: string; effort?: string }): Promise<GoalRecord> {
    const goal = this.goals.getGoal(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}`);

    const criteriaSummary = goal.criteria
      .map((c) => `- [${c.id}] (${c.kind}${c.required ? "*" : ""}) ${c.description}${c.command ? ` [cmd: ${c.command}]` : ""}`)
      .join("\n");
    const runObjective = [
      `Goal ${goal.id} v${goal.version}: ${goal.title}`,
      goal.description,
      "",
      "Acceptance Criteria:",
      criteriaSummary,
      ...(goal.nonGoals.length ? ["", "Non-Goals:", ...goal.nonGoals.map((n) => `- ${n}`)] : []),
    ].join("\n");

    const { run } = await this.orchestrator.startRun({
      goal: runObjective,
      repoRoot: goal.repoRoot,
      profileId: opts?.profileId,
      model: opts?.model,
      effort: opts?.effort,
    });

    const started = this.goals.linkRunAndStart(goal.id, run.id);
    if (started.chatSessionId) {
      this.chats.appendTurn(
        started.chatSessionId,
        "system_notice",
        `[${started.id} v${started.version}] Started autonomous run ${run.id} (${started.criteria.length} criteria).`,
      );
    }
    this.db.emitEvent(run.id, null, "goal.committed", { goalId: started.id, version: started.version, title: started.title });
    return started;
  }

  async amendGoal(
    goalId: string,
    patch: Parameters<GoalEngine["amendGoal"]>[1],
  ): Promise<{ goal: GoalRecord; delta: ReturnType<GoalEngine["amendGoal"]>["delta"] }> {
    const { goal, delta } = this.goals.amendGoal(goalId, patch);

    if (goal.linkedRunId) {
      this.db.emitEvent(goal.linkedRunId, null, "goal.amended", { goalId: goal.id, delta });
      // Steer active Tier 1 Orchestrator with the structured vN -> vN+1 amendment delta!
      const orch = this.db.listTasks(goal.linkedRunId).find((t) => t.tier === 1);
      if (orch) {
        const steerMsg = [
          `[GOAL AMENDED: ${goal.id} v${delta.fromVersion} -> v${delta.toVersion}]`,
          `Rationale: ${delta.rationale}`,
          delta.addedCriteria.length
            ? `Added criteria: ${delta.addedCriteria.map((c) => `${c.id}: ${c.description}`).join("; ")}`
            : null,
          delta.removedCriteriaIds.length ? `Removed criteria: ${delta.removedCriteriaIds.join(", ")}` : null,
          delta.modifiedCriteria.length
            ? `Modified criteria: ${delta.modifiedCriteria.map((c) => `${c.id}: ${c.description}`).join("; ")}`
            : null,
          "Reconcile active Tier 2 Workers: KEEP unaffected workers, STEER adjustable workers, CANCEL_AND_REPLACE invalidated workers.",
        ]
          .filter(Boolean)
          .join("\n");
        await this.orchestrator.steerTask(orch.id, steerMsg).catch(() => {});
      }
    }

    if (goal.chatSessionId) {
      this.chats.appendTurn(
        goal.chatSessionId,
        "system_notice",
        `[${goal.id} v${delta.fromVersion}->v${delta.toVersion}] Amended (${delta.rationale}); stale reviews invalidated.`,
      );
    }

    return { goal, delta };
  }

  /**
   * Executes the full deterministic Verification Gates -> Independent Skeptical Done-Review pipeline.
   * Never lets the generator self-approve: invokes a fresh read-only Reviewer session (or fails fast at $0 LLM cost on deterministic gates).
   */
  async verifyAndReviewGoal(goalId: string, signal?: AbortSignal): Promise<{
    goal: GoalRecord;
    review: GoalReviewVerdict;
    circuitBreakerTripped?: string;
  }> {
    if (this.activeReviews.has(goalId)) throw new Error(`Review already in progress for ${goalId}`);
    const goal = this.goals.getGoal(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}`);
    if (goal.status === "paused" || goal.status === "cancelled") throw new Error(`Goal is ${goal.status}`);
    const abort = new AbortController();
    this.activeReviews.set(goalId, abort);
    const reviewSignal = signal ? AbortSignal.any([abort.signal, signal]) : abort.signal;
    const unsubscribe = this.db.onEvent(ev => {
      if (ev.runId !== goal.linkedRunId || ev.type !== "run.status") return;
      if ((ev.payload as { status: string }).status === "stopped") abort.abort(new Error("Run stopped during review"));
    });
    try {
      return await this.verifyAndReviewGoalInner(goal, reviewSignal);
    } catch (error) {
      const current = this.goals.getGoal(goalId);
      if (current?.version === goal.version && (current.status === "verifying" || current.status === "reviewing")) {
        this.goals.setStatus(goalId, goal.status);
      }
      throw error;
    } finally {
      unsubscribe();
      this.activeReviews.delete(goalId);
    }
  }

  private async verifyAndReviewGoalInner(goal: GoalRecord, signal: AbortSignal): Promise<{
    goal: GoalRecord;
    review: GoalReviewVerdict;
    circuitBreakerTripped?: string;
  }> {
    const run = goal.linkedRunId ? this.db.getRun(goal.linkedRunId) : null;
    const assertCurrent = () => {
      signal.throwIfAborted();
      const current = this.goals.getGoal(goal.id);
      if (current?.version !== goal.version || current.status === "paused" || current.status === "cancelled" ||
          (run && this.db.getRun(run.id)?.status === "stopped")) {
        throw new Error(`Goal ${goal.id} changed or stopped during review`);
      }
    };
    assertCurrent();
    const gateResult = await this.goals.runDeterministicGates(goal.id, run?.baseSha, signal);
    assertCurrent();

    // If deterministic gates failed, record immediately without burning LLM review tokens!
    if (!gateResult.allPassed) {
      const outcome = this.goals.recordReviewVerdict(goal.id, {
        verdict: "changes_requested",
        criteriaResults: gateResult.results,
        blockingIssues: gateResult.results.filter((r) => !r.passed).map((r) => r.evidence),
        summary: "Deterministic verification gates failed; bouncing back to Tier 1 before LLM review.",
        diffHash: gateResult.diffHash,
      });
      await this.handlePostReviewTransition(outcome);
      return outcome;
    }

    // All deterministic checks passed -> spawn fresh read-only Independent Skeptical Reviewer
    let diffStat = "";
    try {
      diffStat = (await runGit(goal.repoRoot, run?.baseSha ? ["diff", "--stat", `${run.baseSha}..HEAD`] : ["status", "--short"])).stdout;
    } catch {
      diffStat = "";
    }

    const reviewerPrompt = this.goals.buildReviewerPrompt(goal, gateResult, diffStat);
    const { profile, model, wireModel } = await resolveLaunchRoute(this.config, {
      tier: 3, cwd: goal.repoRoot, catalog: this.catalog, quota: this.quota, toolPolicy: "read_only_workspace",
    });
    const runner = this.customRunnerFactory
      ? this.customRunnerFactory(profile)
      : profile.kind === "acp"
        ? new AcpRunner(profile)
        : new PiRunner(profile);

    type SubmittedVerdict = {
      verdict: "approved" | "changes_requested" | "escalate_human";
      criteriaResults: CriterionEvaluation[];
      blockingIssues?: string[];
      summary: string;
    };
    const verdictBox: { value: SubmittedVerdict | null } = { value: null };

    const submitTool: ToolDefinition = {
      name: "submit_review_verdict",
      description: "Submit the structured Independent Done-Review verdict.",
      inputSchema: {
        type: "object",
        required: ["verdict", "criteriaResults", "summary"],
        properties: {
          verdict: { type: "string", enum: ["approved", "changes_requested", "escalate_human"] },
          criteriaResults: { type: "array", items: { type: "object" } },
          blockingIssues: { type: "array", items: { type: "string" } },
          summary: { type: "string" },
        },
      },
    };

    // Persist the reviewer as a Tier 3 verify task under the goal's linked run so it shows up in
    // runs.trees and its transcript is replayable / watchable like any orchestrator agent.
    const cycle = goal.reviewCycle + 1;
    const reviewRun = run ?? await this.orchestrator.ensureDirectorTaskRun(goal.chatSessionId ?? goal.id, goal.repoRoot);
    assertCurrent();
    this.goals.setStatus(goal.id, "reviewing");
    const reviewerTask = this.db.createTask({
      runId: reviewRun.id,
      parentId: this.db.listTasks(reviewRun.id).find((t) => t.tier === 1)?.id ?? null,
      tier: 3,
      kind: "verify",
      title: `Done-Review: ${goal.title} (cycle ${cycle})`,
      objective: reviewerPrompt,
      readOnly: true,
      profileId: profile.id,
      model,
      maxTurns: 12,
    });
    const abort = new AbortController();
    const reviewerSignal = AbortSignal.any([signal, abort.signal]);
    const unsubscribe = this.db.onEvent(ev => {
      if (ev.runId !== reviewRun.id) return;
      if ((ev.taskId === reviewerTask.id && ev.type === "task.status" && (ev.payload as { to: string }).to === "cancelled") ||
          (ev.type === "run.status" && (ev.payload as { status: string }).status === "stopped")) {
        abort.abort(new Error("Reviewer cancelled"));
      }
    });
    const emit = (type: string, payload: unknown) => {
      if (!reviewerSignal.aborted) this.db.emitEvent(reviewRun.id, reviewerTask.id, type, payload);
    };

    const failedSummary = "Independent reviewer failed before completing verification.";
    const failReviewer = (msg: string) => {
      if (this.db.getTask(reviewerTask.id)?.status !== "running") return;
      if (reviewerSignal.aborted) {
        this.db.updateTask(reviewerTask.id, { status: "cancelled", summary: "Reviewer cancelled" });
        return;
      }
      emit("agent.error", { error: msg });
      this.db.updateTask(reviewerTask.id, { status: "failed", summary: failedSummary });
    };

    let outcome: ReturnType<GoalEngine["recordReviewVerdict"]>;
    try {
      if (this.db.getTask(reviewerTask.id)?.status === "cancelled") abort.abort(new Error("Reviewer cancelled"));
      this.db.updateTask(reviewerTask.id, { status: reviewerSignal.aborted ? "cancelled" : "running" });
      reviewerSignal.throwIfAborted();
      const res = await runner.run({
        runId: reviewRun.id,
        taskId: reviewerTask.id,
        tier: 3,
        kind: "verify",
        cwd: goal.repoRoot,
        toolPolicy: "read_only_workspace",
        model: wireModel,
        systemPrompt:
          "You are an independent read-only Done-Reviewer. Inspect the implementation and verification evidence for each required criterion. Never edit files, run mutating commands, or delegate. Call submit_review_verdict if available, or return the requested JSON verdict with concrete sources for every required criterion.",
        initialPrompt: reviewerPrompt,
        maxTurns: 12,
        tools: [submitTool],
        executeTool: async (name, args) => {
          if (name === "submit_review_verdict") {
            verdictBox.value = {
              verdict: String(args.verdict) as SubmittedVerdict["verdict"],
              criteriaResults: Array.isArray(args.criteriaResults) ? (args.criteriaResults as CriterionEvaluation[]) : [],
              blockingIssues: Array.isArray(args.blockingIssues) ? (args.blockingIssues as string[]) : [],
              summary: String(args.summary ?? ""),
            };
            return { recorded: true };
          }
          throw new Error(`Unknown reviewer tool ${name}`);
        },
        signal: reviewerSignal,
        callbacks: {
          onTextDelta: (text) => emit("agent.text_delta", { text }),
          onThoughtDelta: (text) => emit("agent.thought_delta", { text }),
          onToolEvent: (ev) => emit("agent.tool", ev),
        },
      });
      reviewerSignal.throwIfAborted();
      assertCurrent();
      if (res.stopReason !== "completed" && res.stopReason !== "max_turns") {
        throw new Error(`Reviewer stopped: ${res.stopReason}. ${res.text}`);
      }

      // Fallback JSON parse if reviewer returned JSON text instead of calling submit_review_verdict
      if (!verdictBox.value) {
        try {
          const jsonMatch = res.text.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            verdictBox.value = JSON.parse(jsonMatch[0]) as SubmittedVerdict;
          }
        } catch {
          // handled below
        }
      }

      const submittedVerdict = verdictBox.value;

      // Merge deterministic gate pass results with reviewer evaluations so deterministic criteria stay evidenced
      const mergedResults: CriterionEvaluation[] = [...gateResult.results];
      for (const r of submittedVerdict?.criteriaResults ?? []) {
        if (!mergedResults.some((m) => m.criterionId === r.criterionId)) {
          mergedResults.push(r);
        }
      }

      outcome = this.db.transaction(() => {
        const recorded = this.goals.recordReviewVerdict(goal.id, {
          verdict: submittedVerdict?.verdict ?? "changes_requested",
          criteriaResults: mergedResults,
          blockingIssues:
            submittedVerdict?.blockingIssues ?? (submittedVerdict ? [] : ["Reviewer did not return a structured verdict"]),
          summary: submittedVerdict?.summary ?? "Incomplete review output",
          diffHash: gateResult.diffHash,
        });
        const summary = `${recorded.review.verdict}: ${recorded.review.summary}`.slice(0, 2000);
        const dossier = writeTaskDossier(this.db, reviewRun, reviewerTask.id, "review.json",
          JSON.stringify(recorded.review, null, 2), `Independent review of ${goal.id} v${goal.version}`);
        this.db.updateTask(reviewerTask.id, {
          status: "completed", summary,
          resultJson: JSON.stringify({
            summary, sources: [{ path: dossier.path, symbol: "criteriaResults" }], artifact_paths: [dossier.path],
          }),
        });
        return recorded;
      });
    } catch (err) {
      failReviewer(err instanceof Error ? err.message : String(err));
      reviewerSignal.throwIfAborted();
      throw new Error(failedSummary);
    } finally {
      unsubscribe();
    }

    await this.handlePostReviewTransition(outcome);
    return outcome;
  }

  private async handlePostReviewTransition(outcome: {
    goal: GoalRecord;
    review: GoalReviewVerdict;
    circuitBreakerTripped?: string;
  }): Promise<void> {
    const { goal, review, circuitBreakerTripped } = outcome;
    if (goal.linkedRunId) {
      this.db.emitEvent(goal.linkedRunId, null, "goal.reviewed", {
        goalId: goal.id,
        version: goal.version,
        cycle: review.cycle,
        verdict: review.verdict,
        status: goal.status,
        circuitBreakerTripped,
        summary: review.summary,
      });

      if (goal.status === "achieved") {
        this.db.updateRunStatus(goal.linkedRunId, "completed");
      } else if (goal.status === "awaiting_human") {
        const orch = this.db.listTasks(goal.linkedRunId).find((t) => t.tier === 1);
        if (orch) {
          this.db.createEscalation({
            runId: goal.linkedRunId,
            fromTaskId: orch.id,
            toTaskId: null,
            severity: "P0",
            category: "verification_failed",
            title: circuitBreakerTripped ?? `Goal ${goal.id} needs human review`,
            evidencePaths: [goal.repoRoot],
            blocking: true,
          });
        }
      } else if (goal.status === "executing") {
        // Wake / steer Tier 1 Orchestrator with concrete failed criteria remediations
        const orch = this.db.listTasks(goal.linkedRunId).find((t) => t.tier === 1);
        if (orch) {
          const unmet = review.criteriaResults.filter((c) => !c.passed);
          const msg = [
            `[INDEPENDENT REVIEW #${review.cycle}: CHANGES REQUESTED for ${goal.id} v${goal.version}]`,
            `Summary: ${review.summary}`,
            ...unmet.map((u) => `- ${u.criterionId}: ${u.evidence}${u.remediation ? ` | Fix: ${u.remediation}` : ""}`),
            ...review.blockingIssues.map((b) => `- Blocker: ${b}`),
          ].join("\n");
          await this.orchestrator.steerTask(orch.id, msg).catch(() => {});
        }
      }
    }

    if (goal.chatSessionId) {
      const badge =
        goal.status === "achieved"
          ? "ACHIEVED"
          : goal.status === "awaiting_human"
            ? `P0 HUMAN NEEDED (${circuitBreakerTripped ?? "escalated"})`
            : `REVIEW #${review.cycle} -> CHANGES REQUESTED`;
      this.chats.appendTurn(goal.chatSessionId, "system_notice", `[${goal.id} v${goal.version}] ${badge}: ${review.summary}`);
    }
  }

  /** Cancels an in-flight Tier 0 Director turn immediately (e.g. when user presses Esc). */
  async cancelChat(chatSessionId: string): Promise<boolean> {
    const active = this.activeChats.get(chatSessionId);
    if (!active) return false;
    active.abort.abort();
    await active.settled;
    return true;
  }

  async steerChat(chatSessionId: string, message: string): Promise<boolean> {
    const active = this.activeChats.get(chatSessionId);
    if (!active?.handle || active.abort.signal.aborted) return false;
    const accepted = await active.handle.steer(message);
    if (accepted && this.activeChats.get(chatSessionId) === active && !active.abort.signal.aborted) {
      this.flushChatPartial(chatSessionId, active);
      this.chats.appendTurn(chatSessionId, "user", message);
      return true;
    }
    return false;
  }

  getChatPartial(chatSessionId: string): string {
    return this.activeChats.get(chatSessionId)?.partial ?? "";
  }

  private flushChatPartial(chatSessionId: string, active: ActiveChat | undefined): ChatTurnRecord | null {
    if (!active?.partial) return null;
    const turn = this.chats.appendTurn(chatSessionId, "assistant", active.partial);
    active.flushedText += active.partial;
    active.partial = "";
    return turn;
  }

  private directorExecutor(session: { id: string; repoRoot: string }, signal: AbortSignal, onToolEvent?: RunnerCallbacks["onToolEvent"]) {
    return createCodeModeExecutor({
      ...this.config.codeExec,
      mode: effectiveCodeMode(this.config.codeMode),
      allowedTools: () => DIRECTOR_TOOLS,
      execute: (name, args) => this.executeDirectorTool(session.id, session.repoRoot, name, args, signal),
      artifactsDir: join(session.repoRoot, ".harness", "artifacts"),
      saveOutput: async (name, json) => {
        signal.throwIfAborted();
        const run = await this.orchestrator.ensureDirectorTaskRun(session.id, session.repoRoot);
        signal.throwIfAborted();
        const [coordinator] = this.db.listTasks(run.id, { parentId: null });
        return writeCodeOutput(this.db, run, coordinator!.id, name, json);
      },
      signal,
      onToolEvent: onToolEvent && codeExecEventSink(onToolEvent),
    });
  }

  /** Reuse the active turn's executor so MCP and in-process calls share cancellation and tool events. */
  async executeDirectorMcpTool(chatSessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    let executor = this.activeChats.get(chatSessionId)?.executor;
    if (!executor) {
      const session = this.chats.getSession(chatSessionId);
      if (!session) throw new Error(`Unknown chat session ${chatSessionId}`);
      // Idle chats support discovery and legacy direct calls, but cannot launch a script outside a turn.
      executor = this.directorExecutor(session, AbortSignal.abort());
    }
    return name === "__list_tools" ? executor.tools() : executor.execute(name, args);
  }

  /** Executes a single interactive Tier 0 conversational turn and persists both user & assistant messages. */
  async sendChatMessage(
    chatSessionId: string,
    userMessage: string,
    onDelta?: (delta: string) => void,
    onToolEvent?: RunnerCallbacks["onToolEvent"],
  ): Promise<{ userTurn: ChatTurnRecord; assistantTurn: ChatTurnRecord | null }> {
    const session = this.chats.getSession(chatSessionId);
    if (!session) throw new Error(`Unknown chat session ${chatSessionId}`);

    if (this.activeChats.has(chatSessionId)) throw new Error(`Chat ${chatSessionId} already has an active turn`);
    const userTurn = this.chats.appendTurn(chatSessionId, "user", userMessage);
    const history = this.chats.getRecentHistory(chatSessionId, 40);
    const activeGoals = this.goals.listGoals({ repoRoot: session.repoRoot });

    const contextTranscript = history
      .slice(0, -1)
      .map((t) => {
        const speaker = t.role === "user" ? "User" : t.role === "assistant" ? "Director" : t.role === "tool_output" ? "Tool output" : "System";
        // tool_output turns contribute only their short summary; the display JSON stays out of the model context.
        return `${speaker}: ${t.content}`;
      })
      .join("\n\n");

    const goalBanner =
      activeGoals.length > 0
        ? `\n\nActive/Recent Goals:\n${activeGoals
            .slice(0, 8)
            .map((g) => `- ${g.id} v${g.version} [${g.status}] "${g.title}" (review ${g.reviewCycle}/${g.budgets.maxReviewCycles})`)
            .join("\n")}`
        : "";

    const prompt = `${contextTranscript ? `Prior conversation:\n${contextTranscript}\n\n` : ""}Workspace: ${session.repoRoot}${goalBanner}\n\nUser: ${userMessage}`;

    const abort = new AbortController();
    const mode = effectiveCodeMode(this.config.codeMode);
    const executor = this.directorExecutor(session, abort.signal, onToolEvent);
    const { promise: settled, resolve: markSettled } = Promise.withResolvers<void>();
    const active: ActiveChat = { abort, executor, onToolEvent, settled, partial: "", flushedText: "" };
    this.activeChats.set(chatSessionId, active);
    const mcpBridgeEntrypoint = join(dirname(fileURLToPath(import.meta.url)), "..", "runners", "mcp-bridge.ts");

    const finishCancelled = () => ({
      userTurn, assistantTurn: this.flushChatPartial(chatSessionId, active),
    });
    try {
      const { profile, model, wireModel } = await resolveLaunchRoute(this.config, {
        tier: 0, cwd: session.repoRoot, profileId: session.profileId, model: session.model, catalog: this.catalog, quota: this.quota,
      });
      if (abort.signal.aborted) return finishCancelled();
      this.chats.updateSession(chatSessionId, { profileId: profile.id, model });
      const runner = this.customRunnerFactory
        ? this.customRunnerFactory(profile)
        : profile.kind === "acp" ? new AcpRunner(profile) : new PiRunner(profile);
      const res = await runner.run({
        runId: chatSessionId,
        taskId: chatSessionId,
        tier: 1,
        kind: "orchestrator",
        cwd: session.repoRoot,
        toolPolicy: "control_plane_only",
        systemPrompt: buildDirectorSystemPrompt(mode),
        initialPrompt: prompt,
        model: wireModel,
        effort: session.effort,
        maxTurns: 12,
        quotaRetryTimeoutMs: this.config.quotaRetry.nativeRetryTimeoutMs,
        tools: executor.tools(),
        executeTool: executor.execute,
        daemonSocketPath: this.config.socketPath,
        mcpBridgeEntrypoint,
        signal: abort.signal,
        onHandle: (handle) => { if (!(runner instanceof PiRunner)) active.handle = handle; },
        callbacks: {
          onTextDelta: (delta) => {
            if (abort.signal.aborted) return;
            active.partial += delta;
            onDelta?.(delta);
          },
          onToolEvent,
          onPassiveQuota: (sig) => this.quota.ingestPassiveSignal(sig),
        },
      });

      // ACP returns the whole turn. Pi can return only its last provider response.
      const finalSegment = res.text.startsWith(active.flushedText) ? res.text.slice(active.flushedText.length) : res.text;
      if (abort.signal.aborted || res.stopReason === "cancelled") {
        // On abort Pi can return the previous completed provider response while the
        // current response exists only in deltas. Only recover new text consistent with those deltas.
        const alreadyFlushed = active.flushedText.endsWith(res.text);
        if (res.stopReason !== "error" && !alreadyFlushed && finalSegment.startsWith(active.partial)) {
          active.partial = finalSegment;
        }
        return finishCancelled();
      }
      if (res.stopReason === "error") throw new Error(res.text.trim() || "Director runner failed");
      let content = (res.text ? finalSegment : active.partial).trim();
      if (res.stopReason === "quota_paused") {
        const pauseLine = "Paused for quota. Retry later or switch models with /model.";
        content = content ? `${content}\n\n${pauseLine}` : pauseLine;
      } else if (!content && res.toolFailures?.length) {
        content = `Stopped after tool failure without a final response:\n${res.toolFailures.map((f) => `- ${f}`).join("\n")}`;
      } else if (!content && !active.flushedText) {
        content = "(done)";
      }

      active.partial = content;
      const assistantTurn = this.flushChatPartial(chatSessionId, active);
      return { userTurn, assistantTurn };
    } catch (error) {
      if (abort.signal.aborted) return finishCancelled();
      this.flushChatPartial(chatSessionId, active);
      throw error;
    } finally {
      abort.abort();
      if (this.activeChats.get(chatSessionId) === active) {
        this.activeChats.delete(chatSessionId);
      }
      markSettled();
    }
  }

  /** Persists a tool_output turn and forwards the display to the chat's active UI sink, if any. */
  private emitToolDisplay(chatSessionId: string, toolName: string, display: ToolDisplayPayload): void {
    this.flushChatPartial(chatSessionId, this.activeChats.get(chatSessionId));
    this.chats.appendTurn(chatSessionId, "tool_output", summarizeToolDisplay(toolName, display), { toolName, display });
    this.activeChats.get(chatSessionId)?.onToolEvent?.({ id: `display-${randomUUID()}`, name: toolName, status: "completed", display });
  }

  private async executeDirectorTool(
    chatSessionId: string,
    repoRoot: string,
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    if (args.goal_id !== undefined) {
      const goal = this.goals.getGoal(String(args.goal_id));
      if (!goal || realpathSync(goal.repoRoot) !== realpathSync(repoRoot)) throw new Error("Unknown goal in this workspace");
    }
    if (name === "goal_commit" || (name === "goal_create" && args.commit_immediately)) {
      if (typeof args.model !== "string" || !args.model.trim()) throw new Error("Select a model from list_models to commit this goal");
      if (args.profile_id !== undefined && typeof args.profile_id !== "string") throw new Error("profile_id must be a string");
    }
    switch (name) {
      case "wait_children":
        return this.orchestrator.executeDirectorTaskTool(chatSessionId, repoRoot, "wait_tasks", args, signal);
      case "spawn_task":
      case "wait_tasks":
      case "cancel_task":
      case "artifact_read":
        return this.orchestrator.executeDirectorTaskTool(chatSessionId, repoRoot, name, args, signal);
      case "goal_create": {
        const criteria = (Array.isArray(args.criteria) ? args.criteria : []) as Array<
          Omit<GoalCriterion, "id" | "required"> & { id?: string; required?: boolean }
        >;
        const created = this.goals.createGoal({
          repoRoot,
          chatSessionId,
          title: String(args.title),
          description: String(args.description),
          criteria,
          nonGoals: Array.isArray(args.non_goals) ? (args.non_goals as string[]) : [],
          budgets:
            typeof args.max_review_cycles === "number" ? { maxReviewCycles: args.max_review_cycles } : undefined,
        });
        if (args.commit_immediately) {
          return await this.commitGoal(created.id, {
            model: String(args.model), profileId: args.profile_id as string | undefined,
            effort: typeof args.effort === "string" ? args.effort : undefined,
          });
        }
        return created;
      }

      case "goal_commit":
        return await this.commitGoal(String(args.goal_id), {
          profileId: typeof args.profile_id === "string" ? args.profile_id : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
          effort: typeof args.effort === "string" ? args.effort : undefined,
        });

      case "goal_amend":
        return await this.amendGoal(String(args.goal_id), {
          rationale: String(args.rationale),
          title: typeof args.title === "string" ? args.title : undefined,
          description: typeof args.description === "string" ? args.description : undefined,
          addCriteria: Array.isArray(args.add_criteria) ? (args.add_criteria as GoalCriterion[]) : undefined,
          removeCriteriaIds: Array.isArray(args.remove_criteria_ids) ? (args.remove_criteria_ids as string[]) : undefined,
          nonGoals: Array.isArray(args.non_goals) ? (args.non_goals as string[]) : undefined,
        });

      case "goal_list": {
        const goals = this.goals.listGoals({ repoRoot });
        this.emitToolDisplay(
          chatSessionId,
          name,
          buildGoalsTableDisplay(
            goals.map((goal) => ({
              goal,
              reviews: this.goals.listReviews(goal.id),
              openEscalations: goal.linkedRunId ? this.db.listEscalations(goal.linkedRunId, "open") : [],
            })),
          ),
        );
        return { goals, rendered_in_ui: "Goals table shown to the user; do not repeat it." };
      }

      case "goal_get": {
        const g = this.goals.getGoal(String(args.goal_id));
        if (!g) throw new Error(`Unknown goal ${args.goal_id}`);
        const detail = {
          goal: g,
          reviews: this.goals.listReviews(g.id),
          tasks: g.linkedRunId ? this.db.listTasks(g.linkedRunId) : [],
          openEscalations: g.linkedRunId ? this.db.listEscalations(g.linkedRunId, "open") : [],
        };
        this.emitToolDisplay(chatSessionId, name, buildGoalDetailDisplay(detail));
        return { ...detail, tasks: detail.tasks.map((t) => compactTaskHandoff(t, detail.openEscalations)), rendered_in_ui: "Goal detail shown to the user; do not repeat it." };
      }

      case "goal_trigger_review":
        return await this.verifyAndReviewGoal(String(args.goal_id), signal);

      case "goal_pause": {
        const g = this.goals.setStatus(String(args.goal_id), "paused", "Paused by Director");
        if (g.linkedRunId) await this.orchestrator.stopRun(g.linkedRunId, "Goal paused");
        return g;
      }

      case "goal_cancel": {
        const g = this.goals.setStatus(String(args.goal_id), "cancelled", "Cancelled by Director");
        if (g.linkedRunId) await this.orchestrator.stopRun(g.linkedRunId, "Goal cancelled");
        return g;
      }

      case "read_file": {
        const reason = typeof args.exception_reason === "string" ? args.exception_reason.trim() : "";
        if (!reason) throw new Error("read_file requires exception_reason");
        const root = realpathSync(repoRoot);
        const target = realpathSync(resolve(root, String(args.path)));
        const path = relative(root, target);
        if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path) ||
            path.split(sep).some(part => [".git", ".harness"].includes(part.toLowerCase()))) {
          throw new Error("File outside the permitted workspace");
        }
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile()) throw new Error("Expected a regular file");
          const bytes = Buffer.alloc(4096);
          const count = readSync(fd, bytes, 0, bytes.length, 0);
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, count), { stream: stat.size > count });
          const limit = typeof args.max_chars === "number" ? Math.min(4096, Math.max(0, args.max_chars)) : 4096;
          const content = text.slice(0, limit);
          this.chats.appendTurn(chatSessionId, "system_notice", `Director read_file: ${path} (${count} bytes). Reason: ${reason}`);
          return { path, truncated: stat.size > count || content.length < text.length, content };
        } finally {
          closeSync(fd);
        }
      }

      case "kb_search":
        return {
          cards: this.db.kb.search({
            query: typeof args.query === "string" ? args.query : undefined,
            repoScope: repoRoot,
            pathGlobs: Array.isArray(args.path_globs) ? (args.path_globs as string[]) : undefined,
          }),
        };

      case "list_models":
        return await this.catalog.getCatalog({
          cwd: repoRoot,
          excludeExhausted: Boolean(args.exclude_exhausted),
        });

      case "steer_run": {
        const g = this.goals.getGoal(String(args.goal_id));
        if (!g?.linkedRunId) throw new Error(`Goal ${args.goal_id} has no active run`);
        const orch = this.db.listTasks(g.linkedRunId).find((t) => t.tier === 1);
        if (!orch) throw new Error("Orchestrator task not found");
        return { steered: await this.orchestrator.steerTask(orch.id, String(args.message)) };
      }

      default:
        throw new Error(`Unknown Director tool: ${name}`);
    }
  }
}
