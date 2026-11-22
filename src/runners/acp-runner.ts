import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION, type AgentApp, type ClientConnection } from "@agentclientprotocol/sdk/unstable";
import type { AcpProfileConfig } from "../config.js";
import {
  buildNewSessionParams,
  buildPostSessionActions,
  extractArtifactsFromToolUpdate,
  prepareAcpSpawn,
  type AcpMcpServerEntry,
} from "./acp-shims.js";
import type { ProbedModelInfo, RunAgentRequest, RunAgentResult, RunnerUsage } from "./types.js";

function isHarnessMcpTool(titleOrName: string): boolean {
  const lower = titleOrName.toLowerCase();
  return (
    lower.includes("mcp__harness__") ||
    lower.includes("mcp.harness.") ||
    lower.includes("mcp/harness/") ||
    lower.includes("harness__") ||
    lower.startsWith("harness:") ||
    lower.startsWith("harness/") ||
    lower.startsWith("harness.")
  );
}

function isMutatingToolKind(kind: string | undefined): boolean {
  return kind === "edit" || kind === "delete" || kind === "move" || kind === "execute";
}

export class AcpRunner {
  constructor(private readonly profile: AcpProfileConfig) {}

  /**
   * Executes an agent turn over ACP v1 (with unstable extensions for usage_update,
   * systemPrompt, configOptions, mcpServers, and _session/steering).
   * Accepts an optional in-process `testAgent` for deterministic unit testing.
   */
  async run(req: RunAgentRequest, testAgent?: AgentApp): Promise<RunAgentResult> {
    const prepared = prepareAcpSpawn(this.profile, {
      systemPrompt: req.systemPrompt,
      readOnly: req.readOnly,
    });

    const child = testAgent
      ? null
      : spawn(prepared.command, prepared.args, {
          cwd: req.cwd,
          env: prepared.env,
          stdio: ["pipe", "pipe", "pipe"],
        });

    let spawnErr: Error | null = null;
    if (child) {
      child.on("error", (err) => {
        spawnErr = err;
      });
      // Prevent unhandled EPIPE / stream errors from crashing `harnessd` when an ACP CLI exits early
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
    }

    let stderrBuf = "";
    child?.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-4096);
    });

    let accumulatedText = "";
    let needsParagraphBreak = false;
    let lastUsage: RunnerUsage | undefined;
    let rolloverTriggered = false;
    let sessionId: string | undefined;
    let steeringSupported = false;
    let activeConnection: ClientConnection | null = null;
    const toolTitlesById = new Map<string, string>();

    const app = client()
      .onNotification("session/update", ({ params }) => {
        const update = (params as unknown as { update?: Record<string, unknown> }).update;
        if (!update || typeof update !== "object") return;
        const kind = String(update.sessionUpdate ?? "");

        if (kind === "agent_message_chunk") {
          const content = update.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && typeof content.text === "string") {
            let chunk = content.text;
            if (needsParagraphBreak && accumulatedText.length > 0 && !accumulatedText.endsWith("\n") && !chunk.startsWith("\n")) {
              chunk = "\n\n" + chunk;
            }
            needsParagraphBreak = false;
            accumulatedText += chunk;
            req.callbacks.onTextDelta?.(chunk);
          }
        } else if (kind === "agent_thought_chunk") {
          const content = update.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && typeof content.text === "string") {
            req.callbacks.onThoughtDelta?.(content.text);
          }
        } else if (kind === "usage_update") {
          const used = Number(update.used ?? 0);
          const size = Number(update.size ?? 0);
          const costObj = update.cost as { amount?: number } | null | undefined;
          lastUsage = {
            used,
            size,
            costUsd: typeof costObj?.amount === "number" ? costObj.amount : undefined,
          };
          req.callbacks.onUsage?.(lastUsage);

          // Harvest live passive subscription quota signal (e.g. Claude ACP `_claude/rateLimit`)
          const updateMeta = (update._meta ?? {}) as Record<string, unknown>;
          if (updateMeta["_claude/rateLimit"] && typeof updateMeta["_claude/rateLimit"] === "object") {
            req.callbacks.onPassiveQuota?.({
              profileId: this.profile.id,
              model: typeof updateMeta["_claude/model"] === "string" ? updateMeta["_claude/model"] : req.model,
              raw: updateMeta["_claude/rateLimit"] as Record<string, unknown>,
              observedAt: Date.now(),
            });
          }

          if (
            !rolloverTriggered &&
            req.rolloverThreshold &&
            size > 0 &&
            used / size >= req.rolloverThreshold &&
            sessionId &&
            activeConnection
          ) {
            rolloverTriggered = true;
            void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
          }
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          const callId = update.toolCallId ? String(update.toolCallId) : update.id ? String(update.id) : undefined;
          const rawTitle = update.title ? String(update.title) : update.name ? String(update.name) : undefined;
          if (callId && rawTitle) {
            toolTitlesById.set(callId, rawTitle);
          }
          const resolvedTitle = rawTitle ?? (callId ? toolTitlesById.get(callId) : undefined) ?? "tool";
          req.callbacks.onToolEvent?.({
            id: callId,
            name: resolvedTitle,
            status: String(update.status ?? "in_progress"),
            kind: update.kind ? String(update.kind) : undefined,
            title: resolvedTitle,
          });
          for (const art of extractArtifactsFromToolUpdate(update)) {
            req.callbacks.onArtifact?.(art);
          }
        }
      })
      .onRequest("session/request_permission", ({ params }) => {
        const p = params as unknown as {
          toolCall?: { toolCallId?: string; title?: string; name?: string; kind?: string; rawInput?: unknown };
          options?: Array<{ optionId: string; kind: string }>;
        };
        const callId = p.toolCall?.toolCallId ? String(p.toolCall.toolCallId) : undefined;
        const title = String(p.toolCall?.title ?? p.toolCall?.name ?? (callId ? toolTitlesById.get(callId) : "") ?? "");
        const toolKind = p.toolCall?.kind;
        const options = p.options ?? [];

        const allowOpt = options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
        const denyOpt = options.find((o) => o.kind === "reject_once" || o.kind === "reject_always");

        // Always allow our own harness MCP tools (even in read-only Director / Orchestrator / Verifier sessions)
        if (isHarnessMcpTool(title) && allowOpt) {
          return { outcome: { outcome: "selected", optionId: allowOpt.optionId } } as never;
        }

        // Hard-deny mutating or shell actions in read-only mode
        if (req.readOnly && isMutatingToolKind(toolKind)) {
          return (
            denyOpt
              ? { outcome: { outcome: "selected", optionId: denyOpt.optionId } }
              : { outcome: { outcome: "cancelled" } }
          ) as never;
        }

        if (allowOpt) {
          return { outcome: { outcome: "selected", optionId: allowOpt.optionId } } as never;
        }
        return { outcome: { outcome: "cancelled" } } as never;
      })
      .onRequest("fs/read_text_file", async ({ params }) => {
        const p = params as unknown as { path: string; line?: number; limit?: number };
        const raw = await readFile(p.path, "utf8");
        req.callbacks.onArtifact?.({
          kind: "read",
          path: p.path,
          summary: "fs/read_text_file",
          gitSha: null,
          exitCode: null,
        });
        if (p.line || p.limit) {
          const lines = raw.split("\n");
          const start = Math.max(0, (p.line ?? 1) - 1);
          const slice = p.limit ? lines.slice(start, start + p.limit) : lines.slice(start);
          return { content: slice.join("\n") };
        }
        return { content: raw };
      })
      .onRequest("fs/write_text_file", async ({ params }) => {
        if (req.readOnly) {
          throw new Error("Write denied: agent is running in strictly read-only mode");
        }
        const p = params as unknown as { path: string; content: string };
        const { writeFile } = await import("node:fs/promises");
        await writeFile(p.path, p.content, "utf8");
        req.callbacks.onArtifact?.({
          kind: "write",
          path: p.path,
          summary: "fs/write_text_file",
          gitSha: null,
          exitCode: null,
        });
        return {};
      });

    const conn = testAgent
      ? app.connect(testAgent)
      : app.connect(
          ndJsonStream(
            Writable.toWeb(child!.stdin!) as unknown as WritableStream<Uint8Array>,
            Readable.toWeb(child!.stdout!) as unknown as ReadableStream<Uint8Array>,
          ),
        );
    activeConnection = conn;

    const onAbort = () => {
      if (sessionId) {
        void conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
      }
      child?.kill("SIGTERM");
    };
    req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const initRes = (await conn.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "pi-harness", version: "0.1.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: !req.readOnly },
          _meta: {
            jetbrains: { air: { capabilities: ["sessionFailure"] } },
          },
        },
      } as never)) as unknown as Record<string, unknown>;

      const initMeta = (initRes._meta ?? {}) as Record<string, unknown>;
      const steeringMeta = initMeta.steering as { supported?: boolean } | undefined;
      steeringSupported = Boolean(steeringMeta?.supported);

      // Wire Harness MCP server via stdio when daemonSocketPath + bridge are configured
      const mcpServers: AcpMcpServerEntry[] = [];
      if (req.daemonSocketPath && req.mcpBridgeEntrypoint) {
        mcpServers.push({
          name: "harness",
          command: process.execPath,
          args: [req.mcpBridgeEntrypoint],
          env: [
            { name: "PI_HARNESS_SOCKET", value: req.daemonSocketPath },
            { name: "PI_HARNESS_RUN_ID", value: req.runId },
            { name: "PI_HARNESS_TASK_ID", value: req.taskId },
          ],
        });
      }

      const { params: newSessionParams, needsTurn1SystemPrompt } = buildNewSessionParams(this.profile.adapter, {
        cwd: req.cwd,
        systemPrompt: req.systemPrompt,
        readOnly: req.readOnly,
        model: req.model,
        effort: req.effort,
        mcpServers,
        agentCapabilities: (initRes.agentCapabilities ?? {}) as Record<string, unknown>,
      });

      const newSessionRes = (await conn.agent.request(
        "session/new",
        newSessionParams as never,
      )) as unknown as Record<string, unknown>;
      sessionId = String(newSessionRes.sessionId);
      req.callbacks.onSessionId?.(sessionId);

      // Apply adapter-specific post-session actions (Codex model/effort/read-only, Gemini set_model/plan)
      const postActions = buildPostSessionActions(this.profile.adapter, sessionId, newSessionRes, {
        readOnly: req.readOnly,
        model: req.model,
        effort: req.effort,
      });
      for (const action of postActions) {
        try {
          await conn.agent.request(action.method as never, action.params as never);
        } catch {
          // Non-fatal if an adapter rejects an optional mode/effort value
        }
      }

      req.onHandle?.({
        steer: async (message: string) => {
          if (!sessionId) return false;
          if (steeringSupported) {
            try {
              await conn.agent.request("_session/steering", {
                sessionId,
                prompt: [{ type: "text", text: message }],
              });
              return true;
            } catch {
              return false;
            }
          }
          return false;
        },
        cancel: async () => {
          if (sessionId) {
            await conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
          }
        },
      });

      const promptText =
        prepared.prependSystemPromptToTurn1 || needsTurn1SystemPrompt
          ? `${req.systemPrompt}\n\n---\n\n${req.initialPrompt}`
          : req.initialPrompt;

      const promptRes = (await conn.agent.request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: promptText }],
      } as never)) as unknown as Record<string, unknown>;

      // Harvest passive quota & terminal sessionFailure signals
      const promptMeta = (promptRes._meta ?? {}) as Record<string, unknown>;
      const airFailure = ((promptMeta.jetbrains as Record<string, unknown> | undefined)?.air as Record<string, unknown> | undefined)
        ?.sessionFailure as Record<string, unknown> | string | undefined;
      if (airFailure) {
        const code = typeof airFailure === "string" ? airFailure : String(airFailure.code ?? airFailure.reason ?? "");
        if (code) {
          req.callbacks.onPassiveQuota?.({
            profileId: this.profile.id,
            model: req.model,
            raw: { sessionFailure: code },
            observedAt: Date.now(),
          });
        }
      }

      // Merge PromptResponse.usage if available
      const promptUsage = promptRes.usage as Record<string, unknown> | undefined;
      if (promptUsage) {
        lastUsage = {
          used: lastUsage?.used ?? Number(promptUsage.totalTokens ?? 0),
          size: lastUsage?.size ?? 0,
          inputTokens: Number(promptUsage.inputTokens ?? 0),
          outputTokens: Number(promptUsage.outputTokens ?? 0),
          cachedReadTokens: promptUsage.cachedReadTokens == null ? undefined : Number(promptUsage.cachedReadTokens),
          cachedWriteTokens: promptUsage.cachedWriteTokens == null ? undefined : Number(promptUsage.cachedWriteTokens),
          thoughtTokens: promptUsage.thoughtTokens == null ? undefined : Number(promptUsage.thoughtTokens),
          costUsd: lastUsage?.costUsd,
        };
      }

      const rawStop = String(promptRes.stopReason ?? "end_turn");
      const stopReason: RunAgentResult["stopReason"] = rolloverTriggered
        ? "rollover_requested"
        : rawStop === "cancelled" || req.signal.aborted
          ? "cancelled"
          : "completed";

      return {
        text: accumulatedText,
        stopReason,
        usage: lastUsage,
        sessionId,
      };
    } catch (err) {
      if (rolloverTriggered) {
        return { text: accumulatedText, stopReason: "rollover_requested", usage: lastUsage, sessionId };
      }
      const primary = spawnErr ?? err;
      const detail = stderrBuf.trim() ? ` (stderr: ${stderrBuf.trim().slice(-500)})` : "";
      throw new Error(`ACP runner (${this.profile.id}) failed: ${primary instanceof Error ? primary.message : String(primary)}${detail}`);
    } finally {
      req.signal.removeEventListener("abort", onAbort);
      try {
        await Promise.resolve(conn.close()).catch(() => {});
      } catch {
        // ignore close error on already-exited pipe
      }
      if (child && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
      prepared.cleanup();
    }
  }

  /**
   * Probes an ACP CLI out-of-band to discover its currently runnable models & effort options
   * for the automated Model Catalog compiler.
   */
  async probeModels(cwd: string, timeoutMs = 15_000): Promise<ProbedModelInfo[]> {
    if (this.profile.models && this.profile.models.length > 0) {
      return this.profile.models.map((wireModelId) => ({ wireModelId }));
    }

    const child = spawn(this.profile.command, this.profile.args ?? [], {
      cwd,
      env: { ...process.env, ...(this.profile.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.on("error", () => {});
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});

    const app = client();
    const conn = app.connect(
      ndJsonStream(
        Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      ),
    );

    const timer = setTimeout(() => {
      try {
        void Promise.resolve(conn.close()).catch(() => {});
      } catch {
        // ignore
      }
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, timeoutMs);

    try {
      await conn.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "pi-harness-probe", version: "0.1.0" },
        clientCapabilities: {},
      } as never);

      const res = (await conn.agent.request("session/new", {
        cwd,
        mcpServers: [],
      } as never)) as unknown as Record<string, unknown>;

      const results: ProbedModelInfo[] = [];
      const configOptions = (res.configOptions ?? []) as Array<{
        id: string;
        category?: string;
        options?: Array<{ value: string; name?: string }>;
      }>;

      const effortOpt = configOptions.find(
        (c) => c.category === "thought_level" || c.id === "effort" || c.id === "reasoning_effort",
      );
      const supportedEfforts = effortOpt?.options?.map((o) => o.value);

      const modelOpt = configOptions.find((c) => c.category === "model" || c.id === "model");
      if (modelOpt?.options) {
        for (const opt of modelOpt.options) {
          results.push({ wireModelId: opt.value, name: opt.name, supportedEfforts });
        }
      }

      // Legacy fallback (gemini --acp `models.availableModels`)
      const legacyModels = (res.models as { availableModels?: Array<{ modelId: string; name?: string }> } | undefined)
        ?.availableModels;
      if (results.length === 0 && legacyModels) {
        for (const m of legacyModels) {
          results.push({ wireModelId: m.modelId, name: m.name });
        }
      }

      return results;
    } finally {
      clearTimeout(timer);
      try {
        await Promise.resolve(conn.close()).catch(() => {});
      } catch {
        // ignore
      }
      if (!child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
      }
    }
  }
}
