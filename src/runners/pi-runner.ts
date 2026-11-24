import { toolEventPreview } from "../protocol/tool-display.js";
import {
  createModels,
  createProvider,
  getSupportedThinkingLevels,
  isContextOverflow,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Provider,
  type UserMessage,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { DEFAULT_TASK_COMPACTION_THRESHOLD, type PiProfileConfig } from "../config.js";
import { detectQuotaErrorText } from "./quota-detect.js";
import { MAX_RUNNER_STEER_CONTINUATIONS, validateRunPolicy } from "./types.js";
import type { ProbedModelInfo, RunAgentRequest, RunAgentResult, RunnerUsage } from "./types.js";

const BUILTIN_PROVIDERS = new Map<string, [() => Provider<Api>, string]>([
  ["openai", [openaiProvider as () => Provider<Api>, "OPENAI_API_KEY"]],
  ["anthropic", [anthropicProvider as () => Provider<Api>, "ANTHROPIC_API_KEY"]],
  ["google", [googleProvider as () => Provider<Api>, "GEMINI_API_KEY"]],
]);

const API_FACTORIES = new Map([
  ["openai-completions", openAICompletionsApi],
  ["openai-responses", openAIResponsesApi],
  ["anthropic-messages", anthropicMessagesApi],
  ["google-generative-ai", googleGenerativeAIApi],
]);

const EMPTY_USAGE: AssistantMessage["usage"] = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Resolves the context utilization threshold that triggers in-place compaction on PiRunner.
 * Tier 3 task agents compact in place (defaulting to `DEFAULT_TASK_COMPACTION_THRESHOLD` when
 * `req.rolloverThreshold` is unset); Tier 1/2 keep anchored rollover via `req.rolloverThreshold`.
 */
export function resolvePiCompactionThreshold(
  req: Pick<RunAgentRequest, "tier" | "rolloverThreshold">,
): number | undefined {
  if (req.tier !== 3) return undefined;
  if (req.rolloverThreshold !== undefined) {
    return req.rolloverThreshold > 0 ? req.rolloverThreshold : undefined;
  }
  return DEFAULT_TASK_COMPACTION_THRESHOLD;
}

function truncateCompactionText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 32) return text.slice(0, maxChars);
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head - 24;
  return `${text.slice(0, head)}\n...[truncated ${text.length - head - Math.max(0, tail)} chars]...\n${tail > 0 ? text.slice(-tail) : ""}`;
}

function extractTextContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      if (block.text.trim()) parts.push(block.text);
    } else if (block.type === "toolCall") {
      let argsStr = "";
      try {
        argsStr = JSON.stringify(block.arguments ?? {});
      } catch {
        argsStr = "{}";
      }
      parts.push(`[toolCall ${block.name}(${truncateCompactionText(argsStr, 240)})]`);
    } else if (block.type === "image") {
      parts.push("[image]");
    }
  }
  return parts.join("\n");
}

function estimateMessagesTokens(msgs: readonly Message[]): number {
  let chars = 0;
  for (const msg of msgs) {
    if (typeof msg.content === "string") {
      chars += msg.content.length;
    } else {
      for (const block of msg.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") {
          let argsLen = 16;
          try {
            argsLen = JSON.stringify(block.arguments ?? {}).length;
          } catch {
            // ignore
          }
          chars += block.name.length + argsLen;
        } else if (block.type === "image") {
          chars += 4800;
        }
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

interface MessageGroup {
  kind: "turn" | "other";
  messages: Message[];
}

function partitionMessagesForCompaction(
  messages: readonly Message[],
  contextWindow: number,
  aggressive: boolean,
): { dropped: Message[]; kept: Message[]; trailingUsers: UserMessage[] } | null {
  if (messages.length <= 1) return null;

  // Preserve unanswered trailing user messages (steering / wrap-up prompts) verbatim.
  let tailUserStart = messages.length;
  while (tailUserStart > 1 && messages[tailUserStart - 1]!.role === "user") {
    tailUserStart -= 1;
  }
  const trailingUsers = messages.slice(tailUserStart) as UserMessage[];
  const middle = messages.slice(1, tailUserStart);
  if (middle.length === 0) return null;

  // Group each assistant message with its immediately following toolResult messages so
  // compaction never splits a toolCall from its matching toolResult.
  const groups: MessageGroup[] = [];
  for (let i = 0; i < middle.length; ) {
    const msg = middle[i]!;
    if (msg.role === "assistant") {
      const turnMsgs: Message[] = [msg];
      let j = i + 1;
      while (j < middle.length && middle[j]!.role === "toolResult") {
        turnMsgs.push(middle[j]!);
        j += 1;
      }
      groups.push({ kind: "turn", messages: turnMsgs });
      i = j;
    } else {
      groups.push({ kind: "other", messages: [msg] });
      i += 1;
    }
  }

  const turnIndices = groups
    .map((g, idx) => (g.kind === "turn" ? idx : -1))
    .filter((idx) => idx >= 0);

  let keepStart = groups.length;
  if (!aggressive && turnIndices.length >= 2) {
    const candidateStart = turnIndices[turnIndices.length - 1]!;
    const candidateTail = groups.slice(candidateStart).flatMap((g) => g.messages);
    const maxKeptTokens = Math.max(1, Math.floor(contextWindow * 0.35));
    if (estimateMessagesTokens(candidateTail) <= maxKeptTokens) {
      keepStart = candidateStart;
    }
  }

  const dropped = groups.slice(0, keepStart).flatMap((g) => g.messages);
  const kept = groups.slice(keepStart).flatMap((g) => g.messages);
  if (dropped.length === 0) return null;
  return { dropped, kept, trailingUsers };
}

function formatMessagesForCompaction(
  previousSummary: string,
  dropped: readonly Message[],
  maxChars: number,
): string {
  const sections: string[] = [];
  if (previousSummary.trim()) {
    sections.push(`Prior compacted summary:\n${truncateCompactionText(previousSummary.trim(), Math.floor(maxChars * 0.4))}`);
  }
  const perMsgCap = Math.max(240, Math.min(2_400, Math.floor(maxChars / Math.max(1, dropped.length))));
  for (const msg of dropped) {
    if (msg.role === "assistant") {
      const text = extractTextContent(msg.content).trim();
      if (text) sections.push(`Assistant: ${truncateCompactionText(text, perMsgCap)}`);
    } else if (msg.role === "toolResult") {
      const text = extractTextContent(msg.content).trim();
      const status = msg.isError ? "ERROR" : "OK";
      sections.push(`ToolResult(${msg.toolName}, ${status}): ${truncateCompactionText(text, perMsgCap)}`);
    } else if (msg.role === "user") {
      const text = extractTextContent(msg.content).trim();
      if (text) sections.push(`User: ${truncateCompactionText(text, perMsgCap)}`);
    }
  }
  return truncateCompactionText(sections.join("\n\n"), maxChars);
}

function buildDeterministicCompactionSummary(
  previousSummary: string,
  dropped: readonly Message[],
  maxSummaryChars: number,
): string {
  const lines: string[] = [];
  if (previousSummary.trim()) {
    lines.push(truncateCompactionText(previousSummary.trim(), Math.floor(maxSummaryChars * 0.45)));
  }
  const perEntryCap = Math.max(120, Math.min(400, Math.floor(maxSummaryChars / Math.max(2, dropped.length))));
  for (const msg of dropped) {
    if (msg.role === "assistant") {
      const textParts: string[] = [];
      const calls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          textParts.push(block.text.trim());
        } else if (block.type === "toolCall") {
          let argsStr = "";
          try {
            argsStr = JSON.stringify(block.arguments ?? {});
          } catch {
            argsStr = "{}";
          }
          calls.push(`${block.name}(${truncateCompactionText(argsStr, 140)})`);
        }
      }
      if (textParts.length > 0) {
        lines.push(`- Assistant note: ${truncateCompactionText(textParts.join(" "), perEntryCap)}`);
      }
      if (calls.length > 0) {
        lines.push(`- Tool calls: ${calls.join("; ")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = extractTextContent(msg.content).replace(/\s+/g, " ").trim();
      const tag = msg.isError ? "error" : "ok";
      lines.push(`- Result [${msg.toolName}/${tag}]: ${truncateCompactionText(text, perEntryCap)}`);
    } else if (msg.role === "user") {
      const text = extractTextContent(msg.content).replace(/\s+/g, " ").trim();
      if (text) lines.push(`- Steering/User: ${truncateCompactionText(text, perEntryCap)}`);
    }
  }
  return truncateCompactionText(lines.join("\n"), maxSummaryChars);
}

function isOverflowErrorMessage(
  errorMessage: string,
  api: Api,
  provider: string,
  modelId: string,
  contextWindow: number,
): boolean {
  const synthetic: AssistantMessage = {
    role: "assistant",
    content: [],
    api,
    provider,
    model: modelId,
    usage: EMPTY_USAGE,
    stopReason: "error",
    errorMessage,
    timestamp: Date.now(),
  };
  return isContextOverflow(synthetic, contextWindow);
}

/**
 * Native `@earendil-works/pi-ai` lane for direct API keys & local OpenAI-compatible servers.
 * Executes harness tools directly in-process with zero MCP subprocess overhead, strict
 * rollover threshold checking, and exact normalized token usage tracking.
 */
export class PiRunner {
  constructor(private readonly profile: PiProfileConfig) {}

  probeModels(): ProbedModelInfo[] {
    if (this.profile.enabled === false) return [];
    const builtin = BUILTIN_PROVIDERS.get(this.profile.provider);
    if (this.profile.billing !== "local") {
      const keyEnv = this.profile.apiKeyEnv ?? (!this.profile.baseUrl ? builtin?.[1] : undefined);
      if (keyEnv && !process.env[keyEnv]?.trim()) {
        return [];
      }
    }
    if (this.profile.models && this.profile.models.length > 0) {
      return this.profile.models.map((wireModelId) => ({ wireModelId }));
    }
    if (!builtin) return [];
    const catalog = builtin[0]();
    return catalog.getModels().map((m) => ({
      wireModelId: m.id,
      name: m.name,
      supportedEfforts: getSupportedThinkingLevels(m),
    }));
  }

  async run(req: RunAgentRequest): Promise<RunAgentResult> {
    validateRunPolicy(req);
    if (this.profile.enabled === false) throw new Error(`Pi profile ${this.profile.id} is disabled`);
    const modelId = req.model;
    const builtin = BUILTIN_PROVIDERS.get(this.profile.provider);
    const catalog = builtin?.[0]();
    const builtinModel = catalog?.getModels().find((m) => m.id === modelId);
    if (!(this.profile.models?.length ? this.profile.models.includes(modelId) : builtinModel)) {
      throw new Error(`Model ${modelId} is unavailable on Pi profile ${this.profile.id}. Select a current catalog route.`);
    }
    const baseUrl = this.profile.baseUrl ?? catalog?.baseUrl;
    if (!baseUrl) {
      throw new Error(`Custom pi profile ${this.profile.id} requires baseUrl`);
    }

    // Strict credential isolation: never leak vendor keys to custom baseUrl endpoints
    const keyEnv = this.profile.apiKeyEnv ?? (!this.profile.baseUrl ? builtin?.[1] : undefined);
    const apiKey = keyEnv ? process.env[keyEnv] : undefined;
    if (keyEnv && !apiKey && this.profile.billing !== "local") {
      throw new Error(`Missing API credential in env var ${keyEnv} for profile ${this.profile.id}`);
    }

    const apiName = this.profile.api ?? builtinModel?.api ?? "openai-completions";
    const apiFactory = API_FACTORIES.get(apiName);
    if (!apiFactory) {
      throw new Error(`Unsupported pi wire API: ${apiName}`);
    }

    const contextWindow = builtinModel?.contextWindow ?? req.contextWindow ?? 128_000;
    const model = {
      name: modelId,
      input: ["text"] as ("text" | "image")[],
      reasoning: builtinModel?.reasoning ?? false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...builtinModel,
      id: modelId,
      provider: this.profile.provider,
      api: apiName,
      baseUrl,
      contextWindow,
      maxTokens: builtinModel?.maxTokens ?? 8192,
    };

    const models = createModels();
    models.setProvider(
      createProvider({
        id: this.profile.provider,
        baseUrl,
        api: apiFactory(),
        models: [model as never],
        auth: {
          apiKey: {
            name: keyEnv ?? "local",
            resolve: async () => ({ auth: { apiKey: apiKey ?? "local" } }),
          },
        },
      }),
    );

    const resolvedModel = models.getModel(this.profile.provider, modelId);
    if (!resolvedModel) {
      throw new Error(`Failed to resolve model ${this.profile.provider}/${modelId}`);
    }

    const messages: Message[] = [{ role: "user", content: req.initialPrompt, timestamp: Date.now() }];
    const steeringQueue: string[] = [];
    const runAbort = new AbortController();
    const onReqAbort = () => runAbort.abort(req.signal.reason);
    if (req.signal.aborted) {
      runAbort.abort(req.signal.reason);
    } else {
      req.signal.addEventListener("abort", onReqAbort, { once: true });
    }
    let cancelled = false;
    let cancelReason: string | undefined;
    let rolloverWarningSent = false;
    let lastText = "";
    let lastUsage: RunnerUsage | undefined;
    const idleTimeoutMs = Math.max(0, req.idleTimeoutMs ?? 600_000);
    const effectiveEffort =
      req.effort && req.effort.toLowerCase() !== "default" ? req.effort : undefined;
    const tier3CompactionThreshold = resolvePiCompactionThreshold(req);
    const rolloverThreshold = req.tier === 3 ? undefined : req.rolloverThreshold;
    let compactedSummary = "";
    let compactionCount = 0;
    let needsCompaction = false;
    let lastCompactedTurn: number | null = null;

    const cancelledStopReason = (): RunAgentResult["stopReason"] =>
      cancelReason === "clean_rollover" ? "rollover_requested" : "cancelled";

    const summarizeForCompaction = async (
      previousSummary: string,
      dropped: readonly Message[],
      maxSummaryChars: number,
    ): Promise<string> => {
      const fallback = () => buildDeterministicCompactionSummary(previousSummary, dropped, maxSummaryChars);
      const inputBudget = Math.min(80_000, Math.max(1_500, Math.floor(contextWindow * 2)));
      const serialized = formatMessagesForCompaction(previousSummary, dropped, inputBudget);
      if (!serialized.trim()) return fallback();

      const compactAbort = new AbortController();
      const onCompactRunAbort = () => compactAbort.abort(runAbort.signal.reason);
      if (runAbort.signal.aborted) {
        compactAbort.abort(runAbort.signal.reason);
        return fallback();
      }
      runAbort.signal.addEventListener("abort", onCompactRunAbort, { once: true });

      const compactTimeoutMs = idleTimeoutMs > 0 ? Math.min(idleTimeoutMs, 60_000) : 0;
      let compactTimer: ReturnType<typeof setTimeout> | null = null;
      const resetCompactTimer = () => {
        if (compactTimer) {
          clearTimeout(compactTimer);
          compactTimer = null;
        }
        if (compactTimeoutMs > 0) {
          compactTimer = setTimeout(() => {
            compactAbort.abort(new Error(`Pi compaction timed out after ${compactTimeoutMs}ms`));
          }, compactTimeoutMs);
          compactTimer.unref?.();
        }
      };

      try {
        resetCompactTimer();
        const compactContext: Context = {
          systemPrompt:
            "You are compacting earlier working history for an in-progress task. " +
            "Produce a concise, high-signal factual summary so the agent can continue without repeating completed reads. " +
            "Preserve exact file paths, line ranges, symbol names, queries, tool outcomes, findings, and remaining work. " +
            "Do not invent facts or call tools.",
          messages: [
            {
              role: "user",
              content:
                `Original task:\n${truncateCompactionText(req.initialPrompt, 2_000)}\n\n` +
                `Earlier progress to compact:\n${serialized}\n\n` +
                "Write a concise bulleted summary of completed reads, verified findings with file/symbol references, and remaining work.",
              timestamp: Date.now(),
            },
          ],
          tools: [],
        };
        const stream = models.streamSimple(resolvedModel, compactContext, {
          apiKey: apiKey ?? "local",
          signal: compactAbort.signal,
          maxTokens: Math.min(model.maxTokens, 2_048),
        });
        for await (const _ev of stream) {
          resetCompactTimer();
        }
        const summaryMsg = await stream.result();
        if (summaryMsg.usage) {
          const compactUsed =
            (summaryMsg.usage.input ?? 0) +
            (summaryMsg.usage.output ?? 0) +
            (summaryMsg.usage.cacheRead ?? 0) +
            (summaryMsg.usage.cacheWrite ?? 0);
          if (compactUsed > 0) {
            req.callbacks.onUsage?.({
              used: compactUsed,
              size: contextWindow,
              inputTokens: summaryMsg.usage.input,
              outputTokens: summaryMsg.usage.output,
              cachedReadTokens: summaryMsg.usage.cacheRead,
              cachedWriteTokens: summaryMsg.usage.cacheWrite,
              cost: summaryMsg.usage.cost?.totalFromProvider
                ? {
                    amount: summaryMsg.usage.cost.total,
                    currency: "USD",
                    basis: "delta",
                    model: summaryMsg.responseModel ?? summaryMsg.model,
                    chargeId: summaryMsg.responseId ?? `compact-${compactionCount + 1}`,
                  }
                : undefined,
            });
          }
        }
        if (summaryMsg.stopReason === "error" || summaryMsg.stopReason === "aborted") {
          return fallback();
        }
        const summaryText = summaryMsg.content
          .filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { text: string }) => c.text)
          .join("\n")
          .trim();
        return summaryText ? truncateCompactionText(summaryText, maxSummaryChars) : fallback();
      } catch {
        return fallback();
      } finally {
        if (compactTimer) {
          clearTimeout(compactTimer);
          compactTimer = null;
        }
        runAbort.signal.removeEventListener("abort", onCompactRunAbort);
      }
    };

    const compactInPlace = async (aggressive: boolean): Promise<boolean> => {
      const partition = partitionMessagesForCompaction(messages, contextWindow, aggressive);
      if (!partition) {
        if (aggressive && compactedSummary.length > 400) {
          compactedSummary = truncateCompactionText(compactedSummary, Math.floor(compactedSummary.length / 2));
          compactionCount += 1;
          const banner =
            `[Compacted earlier progress (compaction #${compactionCount}) — continue the task without repeating completed reads]\n` +
            compactedSummary;
          const trailingTexts = messages
            .slice(1)
            .map((m) => extractTextContent(m.content).trim())
            .filter(Boolean);
          messages.splice(0, messages.length, {
            role: "user",
            content: [req.initialPrompt, banner, ...trailingTexts].join("\n\n"),
            timestamp: Date.now(),
          });
          return true;
        }
        return false;
      }

      const maxSummaryChars = aggressive
        ? Math.max(600, Math.min(8_000, Math.floor(contextWindow * 0.4)))
        : Math.max(800, Math.min(12_000, Math.floor(contextWindow * 0.6)));
      const nextSummary = await summarizeForCompaction(compactedSummary, partition.dropped, maxSummaryChars);
      if (cancelled || runAbort.signal.aborted) return false;

      compactedSummary = nextSummary;
      compactionCount += 1;
      const banner =
        `[Compacted earlier progress (compaction #${compactionCount}) — continue the task without repeating completed reads]\n` +
        compactedSummary;
      const trailingTexts = partition.trailingUsers
        .map((u) => extractTextContent(u.content).trim())
        .filter(Boolean);
      const rebuilt: Message[] =
        partition.kept.length > 0
          ? [
              { role: "user", content: `${req.initialPrompt}\n\n${banner}`, timestamp: Date.now() },
              ...partition.kept,
              ...partition.trailingUsers,
            ]
          : [
              {
                role: "user",
                content: [req.initialPrompt, banner, ...trailingTexts].join("\n\n"),
                timestamp: Date.now(),
              },
            ];
      messages.splice(0, messages.length, ...rebuilt);
      return true;
    };

    // One missing-return wrap-up prompt when the agent stops without settling its task, then at most 3 more turns.
    let wrapUpAttempted = false;
    let wrapUpTurnsLeft = 0;
    // Set once the run can take no more turns: a steer arriving then is refused instead of being acknowledged and dropped.
    let runEnded = false;
    // Loop guard for turns opened only to deliver queued steering (runner-wide budget).
    let steerContinuations = 0;
    // Both budgets bound a steering turn: the runner-wide continuation cap and the three-turn wrap-up window.
    const canScheduleSteeringTurn = () =>
      steerContinuations < MAX_RUNNER_STEER_CONTINUATIONS && (!wrapUpAttempted || wrapUpTurnsLeft > 1);

    req.onHandle?.({
      steer: async (msg: string) => {
        // No later turn can deliver this message (final wrap-up turn running, or the steering budget spent).
        if (runEnded || !canScheduleSteeringTurn()) return false;
        steeringQueue.push(msg);
        return true;
      },
      cancel: async (reason?: string) => {
        cancelled = true;
        cancelReason = reason;
        if (!runAbort.signal.aborted) {
          runAbort.abort(reason ? new Error(reason) : undefined);
        }
      },
    });

    const piTools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as never,
    }));

    try {
      // The loop ends only when the agent stops calling tools.
      let preWrapUpText = "";
      // Distinct substantive text of each wrap-up turn, in order, so intermediate findings survive a closing "ok".
      const wrapUpTexts: string[] = [];
      for (let turn = 0; ; turn++) {
        req.callbacks.onTurn?.(turn + 1);
        if (cancelled || runAbort.signal.aborted) {
          return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
        }

        if (steeringQueue.length > 0) {
          const injected = steeringQueue.splice(0, steeringQueue.length).join("\n\n");
          messages.push({ role: "user", content: `[Steering Update]\n${injected}`, timestamp: Date.now() });
        }

        if (needsCompaction) {
          needsCompaction = false;
          const aggressive = lastCompactedTurn !== null && turn - lastCompactedTurn <= 1;
          if (await compactInPlace(aggressive)) {
            lastCompactedTurn = turn;
          }
          if (cancelled || runAbort.signal.aborted) {
            return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
          }
        }

        const context: Context = {
          systemPrompt: req.systemPrompt,
          messages,
          tools: piTools,
        };

        const quotaTimeoutMs = Math.max(0, req.quotaRetryTimeoutMs ?? 45_000);
        const retryStartMs = Date.now();
        let retryCount = 0;
        let overflowCompactedThisTurn = false;
        let finalMsg: Awaited<ReturnType<ReturnType<typeof models.streamSimple>["result"]>> | null = null;

        while (true) {
          const attemptAbort = new AbortController();
          const onRunAbort = () => attemptAbort.abort(runAbort.signal.reason);
          if (runAbort.signal.aborted) {
            attemptAbort.abort(runAbort.signal.reason);
          } else {
            runAbort.signal.addEventListener("abort", onRunAbort, { once: true });
          }
          let idleTimedOut = false;
          let idleTimer: ReturnType<typeof setTimeout> | null = null;
          const resetIdleTimer = () => {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
            if (idleTimeoutMs > 0) {
              idleTimer = setTimeout(() => {
                idleTimedOut = true;
                attemptAbort.abort(new Error(`Pi stream timed out after ${idleTimeoutMs}ms of inactivity`));
              }, idleTimeoutMs);
              idleTimer.unref?.();
            }
          };

          try {
            resetIdleTimer();
            const s = models.streamSimple(resolvedModel, context, {
              apiKey: apiKey ?? "local",
              signal: attemptAbort.signal,
              reasoning: (effectiveEffort as never) ?? undefined,
            });

            for await (const ev of s) {
              resetIdleTimer();
              if (ev.type === "text_delta") {
                req.callbacks.onTextDelta?.(ev.delta);
              } else if (ev.type === "thinking_delta") {
                req.callbacks.onThoughtDelta?.(ev.delta);
              }
            }

            finalMsg = await s.result();
            if (idleTimedOut) {
              throw new Error(`Pi runner (${this.profile.id}) timed out after ${idleTimeoutMs}ms of inactivity`);
            }
            if (
              req.tier === 3 &&
              !overflowCompactedThisTurn &&
              (finalMsg.stopReason === "error" || finalMsg.stopReason === "length") &&
              isContextOverflow(finalMsg, contextWindow)
            ) {
              overflowCompactedThisTurn = true;
              const compacted = await compactInPlace(true);
              if (cancelled || runAbort.signal.aborted) {
                return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
              }
              if (compacted) {
                lastCompactedTurn = turn;
                continue;
              }
            }
            if (finalMsg.stopReason === "error") {
              throw new Error(finalMsg.errorMessage || `Pi provider rejected the request for ${modelId}`);
            }
            if (finalMsg.stopReason === "aborted") {
              return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
            }
            if (retryCount > 0) {
              req.callbacks.onQuotaRetryState?.({
                state: "recovered",
                retryCount,
                timeoutMs: quotaTimeoutMs,
              });
            }
            break;
          } catch (err) {
            if (idleTimedOut) {
              throw new Error(`Pi runner (${this.profile.id}) timed out after ${idleTimeoutMs}ms of inactivity`);
            }
            if (cancelled || runAbort.signal.aborted) {
              return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
            }
            const msg = err instanceof Error ? err.message : String(err);
            const detected = detectQuotaErrorText(msg);
            if (!detected.isQuota) {
              if (
                req.tier === 3 &&
                !overflowCompactedThisTurn &&
                isOverflowErrorMessage(msg, apiName, this.profile.provider, modelId, contextWindow)
              ) {
                overflowCompactedThisTurn = true;
                const compacted = await compactInPlace(true);
                if (cancelled || runAbort.signal.aborted) {
                  return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
                }
                if (compacted) {
                  lastCompactedTurn = turn;
                  continue;
                }
              }
              throw err;
            }

            retryCount += 1;
            const elapsed = Date.now() - retryStartMs;
            const remaining = quotaTimeoutMs - elapsed;
            // For transient 429s (e.g. subscription pool rotation), retry within quotaTimeoutMs
            if (!detected.isHardExhaustion && remaining > 500) {
              if (retryCount === 1) {
                req.callbacks.onQuotaRetryState?.({
                  state: "retrying",
                  retryCount,
                  timeoutMs: quotaTimeoutMs,
                  reason: detected.summary,
                  resetAt: detected.resetAtIso ?? null,
                });
              }
              const delayMs = Math.min(remaining, Math.min(8_000, 1_000 * 2 ** (retryCount - 1)));
              await new Promise<void>((resolve) => {
                if (runAbort.signal.aborted) {
                  resolve();
                  return;
                }
                const onSleepAbort = () => {
                  clearTimeout(t);
                  resolve();
                };
                const t = setTimeout(() => {
                  runAbort.signal.removeEventListener("abort", onSleepAbort);
                  resolve();
                }, delayMs);
                t.unref?.();
                runAbort.signal.addEventListener("abort", onSleepAbort, { once: true });
              });
              if (cancelled || runAbort.signal.aborted) {
                return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
              }
              continue;
            }

            req.callbacks.onPassiveQuota?.({
              profileId: this.profile.id,
              model: modelId,
              raw: {
                sessionFailure: detected.isHardExhaustion ? "quota_exhausted" : "rate_limited",
                ...(detected.resetAtIso ? { resetAt: detected.resetAtIso } : {}),
              },
              observedAt: Date.now(),
            });
            return {
              text: lastText,
              stopReason: "quota_paused",
              usage: lastUsage,
              quotaPause: {
                reason: detected.summary,
                resetAt: detected.resetAtIso ?? null,
                retryCount,
                watchdogTimedOut: !detected.isHardExhaustion && remaining <= 500,
                isHardExhaustion: detected.isHardExhaustion,
              },
            };
          } finally {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
            runAbort.signal.removeEventListener("abort", onRunAbort);
          }
        }

        if (!finalMsg) {
          return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
        }
        messages.push(finalMsg);

        const used =
          (finalMsg.usage?.input ?? 0) +
          (finalMsg.usage?.output ?? 0) +
          (finalMsg.usage?.cacheRead ?? 0) +
          (finalMsg.usage?.cacheWrite ?? 0);
        lastUsage = {
          used,
          size: contextWindow,
          inputTokens: finalMsg.usage?.input,
          outputTokens: finalMsg.usage?.output,
          cachedReadTokens: finalMsg.usage?.cacheRead,
          cachedWriteTokens: finalMsg.usage?.cacheWrite,
          // Only a provider-billed total (OpenRouter) is a reported cost; catalog estimates are not.
          cost: finalMsg.usage?.cost?.totalFromProvider
            ? {
                amount: finalMsg.usage.cost.total,
                currency: "USD",
                basis: "delta",
                model: finalMsg.responseModel ?? finalMsg.model,
                chargeId: finalMsg.responseId ?? `turn-${turn}`,
              }
            : undefined,
        };
        req.callbacks.onUsage?.(lastUsage);

        const textParts = finalMsg.content
          .filter((c: { type: string }): c is { type: "text"; text: string } => c.type === "text")
          .map((c: { text: string }) => c.text);
        if (textParts.length > 0) {
          const turnText = textParts.join("\n");
          // Wrap-up turns add to the answer that triggered the wrap-up; an acknowledgement never replaces it.
          if (!wrapUpAttempted) lastText = turnText;
          else {
            const t = turnText.trim();
            if (t && t !== preWrapUpText.trim() && !wrapUpTexts.some((w) => w.trim() === t)) wrapUpTexts.push(turnText);
            lastText = [preWrapUpText, ...wrapUpTexts].filter((x) => x.trim()).join("\n\n");
          }
        }

        const toolCalls = finalMsg.content.filter((c) => c.type === "toolCall");

        // Execute harness tool calls directly in-process BEFORE checking rolloverThreshold so
        // terminal tools (return_task, request_rollover, submit_for_merge) on the threshold turn run cleanly.
        for (const call of toolCalls) {
          req.callbacks.onToolEvent?.({
            id: call.id,
            name: call.name,
            status: "in_progress",
            args: toolEventPreview(call.arguments ?? {}),
          });
          try {
            if (!piTools.some((tool) => tool.name === call.name)) {
              throw new Error(`Tool ${call.name} is unavailable to this agent.`);
            }
            const out = await req.executeTool(call.name, call.arguments ?? {});
            req.callbacks.onToolEvent?.({
              id: call.id,
              name: call.name,
              status: "completed",
              result: toolEventPreview(out),
            });
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }],
              isError: false,
              timestamp: Date.now(),
            });
          } catch (err) {
            req.callbacks.onToolEvent?.({
              id: call.id,
              name: call.name,
              status: "failed",
              error: toolEventPreview(err instanceof Error ? err.message : String(err)),
            });
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
              isError: true,
              timestamp: Date.now(),
            });
          }
        }

        if (cancelled || runAbort.signal.aborted) {
          return { text: lastText, stopReason: cancelledStopReason(), usage: lastUsage };
        }

        const ratio = contextWindow > 0 ? used / contextWindow : 0;

        if (tier3CompactionThreshold && contextWindow > 0 && ratio >= tier3CompactionThreshold) {
          // Tier 3 tasks compact in place before the next turn instead of rolling over across generations.
          needsCompaction = true;
        } else if (rolloverThreshold && contextWindow > 0 && ratio >= rolloverThreshold) {
          // Check clean rollover threshold before starting another turn (Tier 1/2).
          return { text: lastText, stopReason: "rollover_requested", usage: lastUsage };
        }

        if (toolCalls.length === 0) {
          // Every wrap-up turn counts against the three-turn bound, steering continuations included; once the
          // current turn is the last one allowed, nothing is drained that could not run.
          if (canScheduleSteeringTurn()) {
            const late = req.drainPendingSteers?.() ?? [];
            if (late.length > 0) steeringQueue.push(...late);
            if (steeringQueue.length > 0) {
              // Steering that arrived during the turn opens the next one instead of being dropped.
              steerContinuations += 1;
              if (wrapUpAttempted) wrapUpTurnsLeft -= 1;
              continue;
            }
          }
          if (!wrapUpAttempted && req.missingReturnWrapUpPrompt && !req.isTaskSettled?.()) {
            wrapUpAttempted = true;
            wrapUpTurnsLeft = 3;
            preWrapUpText = lastText;
            messages.push({ role: "user", content: req.missingReturnWrapUpPrompt, timestamp: Date.now() });
            continue;
          }
          return { text: lastText, stopReason: "completed", usage: lastUsage, ...(wrapUpAttempted ? { wrapUpAttempted: true } : {}) };
        }
        if (wrapUpAttempted && (req.isTaskSettled?.() || --wrapUpTurnsLeft <= 0)) {
          return { text: lastText, stopReason: "completed", usage: lastUsage, wrapUpAttempted: true };
        }

        // Inject soft rollover warning once when approaching rolloverThreshold (Tier 1/2 only).
        const softWarnThreshold = rolloverThreshold ? Math.max(0.5, rolloverThreshold - 0.12) : undefined;
        if (
          !rolloverWarningSent &&
          softWarnThreshold &&
          rolloverThreshold &&
          ratio >= softWarnThreshold &&
          ratio < rolloverThreshold
        ) {
          rolloverWarningSent = true;
          const pct = Math.round(ratio * 100);
          const limitPct = Math.round(rolloverThreshold * 100);
          steeringQueue.push(
            `Context usage is at ${pct}% (hard rollover at ${limitPct}%). Finish your current atomic step and call \`request_rollover\` with a thorough anchored handoff (goal_invariants, architectural_decisions, active_risks, next_actions) so no context is lost.`,
          );
        }
      }
    } finally {
      runEnded = true;
      req.signal.removeEventListener("abort", onReqAbort);
    }
  }
}
