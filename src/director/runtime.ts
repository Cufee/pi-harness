import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelCatalogCompiler } from "../catalog/compiler.js";
import type { HarnessConfig, RunnerProfileConfig } from "../config.js";
import type { ControlPlaneDb } from "../control-plane/db.js";
import type { CustomRunnerFactory, HarnessOrchestrator } from "../control-plane/orchestrator.js";
import {
  GoalEngine,
  type CriterionEvaluation,
  type GoalCriterion,
  type GoalRecord,
  type GoalReviewVerdict,
} from "../goals/engine.js";
import type { QuotaClient } from "../quota/client.js";
import { AcpRunner } from "../runners/acp-runner.js";
import { PiRunner } from "../runners/pi-runner.js";
import type { ToolDefinition } from "../runners/types.js";
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
        commit_immediately: { type: "boolean", description: "Start autonomous Tier 1 execution right away" },
      },
    },
  },
  {
    name: "goal_commit",
    description: "Commit a draft Goal Contract and launch its autonomous Tier 1 Run-Until-Done Orchestrator.",
    inputSchema: {
      type: "object",
      required: ["goal_id"],
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
    description: "List all Goals for this workspace with their version, status, review cycles, and linked run ID.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "goal_get",
    description: "Inspect a Goal's full criteria, latest review scorecard, linked run tree, and open escalations.",
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
  {
    name: "read_file",
    description: "Read-only inspection of a file in the repository to answer design or codebase questions directly.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: { path: { type: "string" }, max_chars: { type: "number" } },
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

/**
 * Tier 0 Interactive Director Runtime + Independent Goal Verification & Done-Review Coordinator.
 * Keeps conversational human UX completely decoupled from Tier 1 autonomous DAG rollovers.
 */
export class DirectorRuntime {
  readonly chats: DirectorSessionStore;
  readonly goals: GoalEngine;
  private activeChatAborts = new Map<string, AbortController>();
  private activeReviewGoalIds = new Set<string>();

  constructor(
    private readonly db: ControlPlaneDb,
    private config: HarnessConfig,
    private readonly catalog: ModelCatalogCompiler,
    private readonly quota: QuotaClient,
    private readonly orchestrator: HarnessOrchestrator,
    private readonly customRunnerFactory?: CustomRunnerFactory,
  ) {
    this.chats = new DirectorSessionStore(db.db);
    this.goals = new GoalEngine(db.db);
  }

  updateConfig(next: HarnessConfig): void {
    this.config = next;
  }

  activeChatCount(): number {
    return this.activeChatAborts.size;
  }

  activeReviewCount(): number {
    return this.activeReviewGoalIds.size;
  }

  isChatBusy(chatSessionId: string): boolean {
    return this.activeChatAborts.has(chatSessionId);
  }

  private resolveProfile(profileId?: string): RunnerProfileConfig {
    const wanted = profileId ?? this.config.defaultOrchestratorProfile;
    const found =
      (wanted ? this.config.profiles.find((p) => p.id === wanted) : undefined) ??
      this.config.profiles.find((p) => p.enabled !== false);
    if (!found) throw new Error("No enabled runner profile configured. Open /settings to add an ACP CLI or pi profile.");
    return found;
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
  async verifyAndReviewGoal(goalId: string): Promise<{
    goal: GoalRecord;
    review: GoalReviewVerdict;
    circuitBreakerTripped?: string;
  }> {
    this.activeReviewGoalIds.add(goalId);
    try {
      return await this.verifyAndReviewGoalInner(goalId);
    } finally {
      this.activeReviewGoalIds.delete(goalId);
    }
  }

  private async verifyAndReviewGoalInner(goalId: string): Promise<{
    goal: GoalRecord;
    review: GoalReviewVerdict;
    circuitBreakerTripped?: string;
  }> {
    const goal = this.goals.getGoal(goalId);
    if (!goal) throw new Error(`Unknown goal ${goalId}`);

    const run = goal.linkedRunId ? this.db.getRun(goal.linkedRunId) : null;
    const gateResult = await this.goals.runDeterministicGates(goal.id, run?.baseSha);

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
    this.goals.setStatus(goal.id, "reviewing");
    let diffStat = "";
    try {
      diffStat = (await runGit(goal.repoRoot, run?.baseSha ? ["diff", "--stat", `${run.baseSha}..HEAD`] : ["status", "--short"])).stdout;
    } catch {
      diffStat = "";
    }

    const reviewerPrompt = this.goals.buildReviewerPrompt(goal, gateResult, diffStat);
    const profile = this.resolveProfile(this.config.defaultOrchestratorProfile);
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
    const reviewerTask = run
      ? this.db.createTask({
          runId: run.id,
          parentId: this.db.listTasks(run.id).find((t) => t.tier === 1)?.id ?? null,
          tier: 3,
          kind: "verify",
          title: `Done-Review: ${goal.title} (cycle ${cycle})`,
          objective: reviewerPrompt,
          readOnly: true,
          profileId: profile.id,
          maxTurns: 12,
        })
      : null;
    if (reviewerTask) this.db.updateTask(reviewerTask.id, { status: "running" });
    const emit = (type: string, payload: unknown) => {
      if (run && reviewerTask) this.db.emitEvent(run.id, reviewerTask.id, type, payload);
    };

    const failReviewer = (msg: string) => {
      if (!reviewerTask || this.db.getTask(reviewerTask.id)?.status !== "running") return;
      emit("agent.error", { error: msg });
      this.db.updateTask(reviewerTask.id, { status: "failed", summary: msg });
    };

    let outcome: ReturnType<GoalEngine["recordReviewVerdict"]>;
    try {
      const res = await runner.run({
        runId: goal.linkedRunId ?? goal.id,
        taskId: reviewerTask?.id ?? `reviewer-${goal.id}-c${cycle}`,
        tier: 3,
        kind: "verify",
        cwd: goal.repoRoot,
        readOnly: true,
        systemPrompt:
          "You are an independent, skeptical code reviewer. Inspect actual code and test outputs; call submit_review_verdict if available or return the requested strict JSON verdict with concrete evidence for every required criterion.",
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
        signal: new AbortController().signal,
        callbacks: {
          onTextDelta: (text) => emit("agent.text_delta", { text }),
          onThoughtDelta: (text) => emit("agent.thought_delta", { text }),
          onToolEvent: (ev) => emit("agent.tool", ev),
        },
      });
      if (res.stopReason === "error" || res.stopReason === "cancelled") {
        failReviewer(res.text || `Reviewer stopped: ${res.stopReason}`);
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

      outcome = this.goals.recordReviewVerdict(goal.id, {
        verdict: submittedVerdict?.verdict ?? "changes_requested",
        criteriaResults: mergedResults,
        blockingIssues:
          submittedVerdict?.blockingIssues ?? (submittedVerdict ? [] : ["Reviewer did not return a structured verdict"]),
        summary: submittedVerdict?.summary ?? (res.text.slice(0, 300) || "Incomplete review output"),
        diffHash: gateResult.diffHash,
      });
      if (reviewerTask && this.db.getTask(reviewerTask.id)?.status === "running") {
        this.db.updateTask(reviewerTask.id, {
          status: "completed",
          summary: `${outcome.review.verdict}: ${outcome.review.summary}`.slice(0, 500),
        });
      }
    } catch (err) {
      failReviewer(err instanceof Error ? err.message : String(err));
      throw err;
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
  cancelChat(chatSessionId: string): boolean {
    const ctrl = this.activeChatAborts.get(chatSessionId);
    if (!ctrl) return false;
    ctrl.abort();
    this.activeChatAborts.delete(chatSessionId);
    return true;
  }

  /** Bridges stdio MCP `tool.call` from external ACP Directors (Codex/Claude/Antigravity) to `DIRECTOR_TOOLS`. */
  async executeDirectorMcpTool(chatSessionId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (name === "__list_tools") return DIRECTOR_TOOLS;
    const session = this.chats.getSession(chatSessionId);
    if (!session) throw new Error(`Unknown chat session ${chatSessionId}`);
    return await this.executeDirectorTool(session.id, session.repoRoot, name, args);
  }

  /** Executes a single interactive Tier 0 conversational turn and persists both user & assistant messages. */
  async sendChatMessage(
    chatSessionId: string,
    userMessage: string,
    onDelta?: (delta: string) => void,
    onToolEvent?: (ev: { id?: string; name: string; status: string; kind?: string; title?: string }) => void,
  ): Promise<{ userTurn: ChatTurnRecord; assistantTurn: ChatTurnRecord }> {
    const session = this.chats.getSession(chatSessionId);
    if (!session) throw new Error(`Unknown chat session ${chatSessionId}`);

    const userTurn = this.chats.appendTurn(chatSessionId, "user", userMessage);
    const history = this.chats.getHistory(chatSessionId, 0, 40);
    const activeGoals = this.goals.listGoals({ repoRoot: session.repoRoot });

    const contextTranscript = history
      .slice(0, -1)
      .map((t) => `${t.role === "user" ? "User" : t.role === "assistant" ? "Director" : "System"}: ${t.content}`)
      .join("\n\n");

    const goalBanner =
      activeGoals.length > 0
        ? `\n\nActive/Recent Goals:\n${activeGoals
            .slice(0, 8)
            .map((g) => `- ${g.id} v${g.version} [${g.status}] "${g.title}" (review ${g.reviewCycle}/${g.budgets.maxReviewCycles})`)
            .join("\n")}`
        : "";

    const prompt = `${contextTranscript ? `Prior conversation:\n${contextTranscript}\n\n` : ""}Workspace: ${session.repoRoot}${goalBanner}\n\nUser: ${userMessage}`;

    const profile = this.resolveProfile(session.profileId);
    const runner = this.customRunnerFactory
      ? this.customRunnerFactory(profile)
      : profile.kind === "acp"
        ? new AcpRunner(profile)
        : new PiRunner(profile);

    const abort = new AbortController();
    this.activeChatAborts.set(chatSessionId, abort);
    const mcpBridgeEntrypoint = join(dirname(fileURLToPath(import.meta.url)), "..", "runners", "mcp-bridge.ts");

    try {
      const res = await runner.run({
        runId: chatSessionId,
        taskId: chatSessionId,
        tier: 1,
        kind: "orchestrator",
        cwd: session.repoRoot,
        readOnly: true,
        systemPrompt: buildDirectorSystemPrompt(),
        initialPrompt: prompt,
        model: session.model,
        effort: session.effort,
        maxTurns: 12,
        quotaRetryTimeoutMs: this.config.quotaRetry.nativeRetryTimeoutMs,
        tools: DIRECTOR_TOOLS,
        executeTool: (name, args) => this.executeDirectorTool(session.id, session.repoRoot, name, args),
        daemonSocketPath: this.config.socketPath,
        mcpBridgeEntrypoint,
        signal: abort.signal,
        callbacks: {
          onTextDelta: onDelta,
          onToolEvent,
          onPassiveQuota: (sig) => this.quota.ingestPassiveSignal(sig),
        },
      });

      let content = res.text.trim();
      if (res.stopReason === "quota_paused") {
        const qp = res.quotaPause;
        const resetNote = qp?.resetAt ? ` · estimated reset: ${qp.resetAt}` : "";
        const pauseLine = `Paused early due to quota / rate limit (${qp?.reason ?? "quota exhausted"}${resetNote}). Send another message anytime to retry or switch models with /model.`;
        content = content ? `${content}\n\n${pauseLine}` : pauseLine;
      } else if (!content && res.toolFailures?.length) {
        content = `Stopped after tool failure without a final response:\n${res.toolFailures.map((f) => `- ${f}`).join("\n")}`;
      } else if (!content) {
        content = "(done)";
      }

      const assistantTurn = this.chats.appendTurn(chatSessionId, "assistant", content);
      return { userTurn, assistantTurn };
    } finally {
      if (this.activeChatAborts.get(chatSessionId) === abort) {
        this.activeChatAborts.delete(chatSessionId);
      }
    }
  }

  private async executeDirectorTool(
    chatSessionId: string,
    repoRoot: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    switch (name) {
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
          return await this.commitGoal(created.id);
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

      case "goal_list":
        return { goals: this.goals.listGoals({ repoRoot }) };

      case "goal_get": {
        const g = this.goals.getGoal(String(args.goal_id));
        if (!g) throw new Error(`Unknown goal ${args.goal_id}`);
        return {
          goal: g,
          reviews: this.goals.listReviews(g.id),
          tasks: g.linkedRunId ? this.db.listTasks(g.linkedRunId) : [],
          openEscalations: g.linkedRunId ? this.db.listEscalations(g.linkedRunId, "open") : [],
        };
      }

      case "goal_trigger_review":
        return await this.verifyAndReviewGoal(String(args.goal_id));

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
        const target = resolve(repoRoot, String(args.path));
        if (!existsSync(target)) throw new Error(`File not found: ${target}`);
        const raw = readFileSync(target, "utf8");
        const max = typeof args.max_chars === "number" ? args.max_chars : 8000;
        return { path: target, truncated: raw.length > max, content: raw.slice(0, max) };
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
