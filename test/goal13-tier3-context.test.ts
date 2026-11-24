import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import {
  DEFAULT_TASK_COMPACTION_THRESHOLD,
  type AcpProfileConfig,
  type PiProfileConfig,
} from "../src/config.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { buildNewSessionParams, prepareAcpSpawn } from "../src/runners/acp-shims.js";
import { PiRunner, resolvePiCompactionThreshold } from "../src/runners/pi-runner.js";
import type { RunAgentRequest } from "../src/runners/types.js";

interface RecordedChatRequest {
  messages: Array<{
    role: string;
    content?: string | Array<{ type?: string; text?: string }>;
    tool_calls?: Array<{ id: string; function?: { name: string; arguments: string } }>;
    tool_call_id?: string;
  }>;
  tools?: unknown[];
}

interface MockTurnResponse {
  status?: number;
  errorBody?: string;
  text?: string;
  toolCall?: { id: string; name: string; args: Record<string, unknown> };
  promptTokens?: number;
  completionTokens?: number;
}

function encodeSseTurn(res: MockTurnResponse): string {
  const chunks: string[] = [];
  const base = {
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "test-model",
  };

  if (res.text) {
    chunks.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: res.text }, finish_reason: null }],
      })}\n\n`,
    );
  }

  if (res.toolCall) {
    chunks.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: res.toolCall.id,
                  type: "function",
                  function: {
                    name: res.toolCall.name,
                    arguments: JSON.stringify(res.toolCall.args),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
  }

  const finishReason = res.toolCall ? "tool_calls" : "stop";
  chunks.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    })}\n\n`,
  );

  const promptTokens = res.promptTokens ?? 100;
  const completionTokens = res.completionTokens ?? 20;
  chunks.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    })}\n\n`,
  );
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

function messageText(msg: RecordedChatRequest["messages"][number]): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => p.text ?? "").join("\n");
  }
  return "";
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];

function startFakeOpenAiServer(handler: (body: RecordedChatRequest, index: number) => MockTurnResponse) {
  const requests: RecordedChatRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as RecordedChatRequest;
      const idx = requests.length;
      requests.push(body);
      const reply = handler(body, idx);
      if (reply.status && reply.status >= 400) {
        return new Response(
          reply.errorBody ?? JSON.stringify({ error: { message: "mock server error", type: "server_error" } }),
          { status: reply.status, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(encodeSseTurn(reply), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });
  servers.push(server);
  const profile: PiProfileConfig = {
    id: "pi:test-local",
    kind: "pi",
    provider: "local-test",
    api: "openai-completions",
    baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`,
    billing: "local",
    models: ["test-model"],
  };
  return { server, profile, requests };
}

function makeRequest(overrides: Partial<RunAgentRequest>): RunAgentRequest {
  return {
    runId: "run-test",
    taskId: "t-test",
    tier: 3,
    kind: "research",
    cwd: process.cwd(),
    toolPolicy: "read_only_workspace",
    systemPrompt: "You are a bounded research agent.",
    initialPrompt: "Answer the single research question by reading all chunks.",
    model: "test-model",
    contextWindow: 10_000,
    tools: [
      {
        name: "read_chunk",
        description: "Read a numbered chunk",
        inputSchema: {
          type: "object",
          properties: { chunk: { type: "number" } },
          required: ["chunk"],
        },
      },
    ],
    executeTool: async (_name, args) => {
      const chunk = Number(args.chunk ?? 0);
      if (chunk === 1) return `CHUNK_1_MARKER:${"A".repeat(4_000)}`;
      if (chunk === 2) return `CHUNK_2_MARKER:short-findings`;
      return `CHUNK_${chunk}_MARKER:ok`;
    },
    signal: new AbortController().signal,
    callbacks: {},
    ...overrides,
  };
}

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()!.stop(true);
  }
});

describe("goal-13 Tier 3 in-place compaction on PiRunner", () => {
  it("resolves default 0.78 compaction threshold for Tier 3, honors req.rolloverThreshold, and leaves Tier 1/2 undefined", () => {
    assert.equal(DEFAULT_TASK_COMPACTION_THRESHOLD, 0.78);
    assert.equal(resolvePiCompactionThreshold({ tier: 3, rolloverThreshold: undefined }), 0.78);
    assert.equal(resolvePiCompactionThreshold({ tier: 3, rolloverThreshold: 0.55 }), 0.55);
    assert.equal(resolvePiCompactionThreshold({ tier: 2, rolloverThreshold: 0.78 }), undefined);
    assert.equal(resolvePiCompactionThreshold({ tier: 2, rolloverThreshold: undefined }), undefined);
    assert.equal(resolvePiCompactionThreshold({ tier: 1, rolloverThreshold: 0.72 }), undefined);
  });

  it("compacts Tier 3 history in place at default 0.78 threshold without rolling over or requesting request_rollover", async () => {
    let agentTurn = 0;
    let compactionCalls = 0;
    const { profile, requests } = startFakeOpenAiServer((body) => {
      const isCompactionCall = !body.tools || body.tools.length === 0;
      if (isCompactionCall) {
        compactionCalls += 1;
        return {
          text: "SUMMARY_FROM_MODEL: Inspected chunk 1 (CHUNK_1_MARKER) and noted key symbol foo.",
          promptTokens: 300,
          completionTokens: 40,
        };
      }
      agentTurn += 1;
      if (agentTurn === 1) {
        return {
          text: "Reading chunk 1.",
          toolCall: { id: "call-1", name: "read_chunk", args: { chunk: 1 } },
          promptTokens: 4_800,
          completionTokens: 200, // 50% < 78% -> no compaction yet
        };
      }
      if (agentTurn === 2) {
        return {
          text: "Reading chunk 2.",
          toolCall: { id: "call-2", name: "read_chunk", args: { chunk: 2 } },
          promptTokens: 7_700,
          completionTokens: 200, // 79% >= 78% -> compact in place before turn 3
        };
      }
      return {
        text: "FINAL_TIER3_ANSWER",
        promptTokens: 1_200,
        completionTokens: 100,
      };
    });

    const runner = new PiRunner(profile);
    const result = await runner.run(makeRequest({ tier: 3, rolloverThreshold: undefined }));

    assert.equal(result.stopReason, "completed");
    assert.equal(result.text, "FINAL_TIER3_ANSWER");
    assert.equal(compactionCalls, 1);
    assert.equal(agentTurn, 3);

    // Inspect the post-compaction agent turn (last request).
    const postCompactReq = requests[requests.length - 1]!;
    const serialized = JSON.stringify(postCompactReq.messages);
    assert.ok(serialized.includes("Answer the single research question by reading all chunks."));
    assert.ok(serialized.includes("[Compacted earlier progress (compaction #1)"));
    assert.ok(serialized.includes("SUMMARY_FROM_MODEL: Inspected chunk 1"));
    assert.ok(!serialized.includes("A".repeat(1_000)), "large compacted turn-1 payload should be dropped");
    assert.ok(serialized.includes("CHUNK_2_MARKER:short-findings"), "recent turn-2 tool result should be preserved");
    assert.ok(!serialized.includes("request_rollover"), "Tier 3 must never be told to call request_rollover");

    // Verify valid message sequence: leading user prompt+summary followed by paired assistant tool_call -> tool result.
    const nonSystem = postCompactReq.messages.filter((m) => m.role !== "system");
    assert.equal(nonSystem[0]!.role, "user");
    assert.equal(nonSystem[1]!.role, "assistant");
    assert.equal(nonSystem[1]!.tool_calls?.[0]?.id, "call-2");
    assert.equal(nonSystem[2]!.role, "tool");
    assert.equal(nonSystem[2]!.tool_call_id, "call-2");
  });

  it("honors an explicit req.rolloverThreshold for Tier 3 in-place compaction", async () => {
    let agentTurn = 0;
    let compactionCalls = 0;
    const { profile, requests } = startFakeOpenAiServer((body) => {
      if (!body.tools || body.tools.length === 0) {
        compactionCalls += 1;
        return { text: "CUSTOM_THRESHOLD_SUMMARY", promptTokens: 200, completionTokens: 20 };
      }
      agentTurn += 1;
      if (agentTurn === 1) {
        return {
          text: "Reading chunk 1.",
          toolCall: { id: "call-1", name: "read_chunk", args: { chunk: 1 } },
          promptTokens: 5_100,
          completionTokens: 100, // 52% >= explicit 50% threshold (and < default 78%)
        };
      }
      return { text: "DONE_AT_CUSTOM_THRESHOLD", promptTokens: 800, completionTokens: 50 };
    });

    const runner = new PiRunner(profile);
    const result = await runner.run(makeRequest({ tier: 3, rolloverThreshold: 0.5 }));

    assert.equal(result.stopReason, "completed");
    assert.equal(result.text, "DONE_AT_CUSTOM_THRESHOLD");
    assert.equal(compactionCalls, 1);

    const turn2 = requests[requests.length - 1]!;
    const nonSystem = turn2.messages.filter((m) => m.role !== "system");
    assert.equal(nonSystem.length, 1);
    assert.equal(nonSystem[0]!.role, "user");
    assert.ok(messageText(nonSystem[0]!).includes("CUSTOM_THRESHOLD_SUMMARY"));
  });

  it("falls back deterministically when compaction summary fails and recovers in place from provider context overflow", async () => {
    let agentTurn = 0;
    let summaryFailures = 0;
    let injectedOverflow = false;
    const { profile, requests } = startFakeOpenAiServer((body) => {
      if (!body.tools || body.tools.length === 0) {
        summaryFailures += 1;
        return {
          status: 500,
          errorBody: JSON.stringify({ error: { message: "transient compaction summary error" } }),
        };
      }
      agentTurn += 1;
      if (agentTurn === 1) {
        return {
          text: "Inspecting chunk 1.",
          toolCall: { id: "call-overflow-1", name: "read_chunk", args: { chunk: 1 } },
          promptTokens: 3_000,
          completionTokens: 100, // 31% < 78%, but chunk 1 toolResult is huge
        };
      }
      if (!injectedOverflow) {
        injectedOverflow = true;
        return {
          status: 400,
          errorBody: JSON.stringify({
            error: { message: "prompt is too long: 11200 tokens > 10000 maximum" },
          }),
        };
      }
      return {
        text: "RECOVERED_FROM_OVERFLOW",
        promptTokens: 900,
        completionTokens: 50,
      };
    });

    const runner = new PiRunner(profile);
    const result = await runner.run(makeRequest({ tier: 3, rolloverThreshold: undefined }));

    assert.equal(result.stopReason, "completed");
    assert.equal(result.text, "RECOVERED_FROM_OVERFLOW");
    assert.equal(summaryFailures, 1);
    assert.equal(injectedOverflow, true);

    const retriedTurn = requests[requests.length - 1]!;
    const serialized = JSON.stringify(retriedTurn.messages);
    assert.ok(serialized.includes("[Compacted earlier progress (compaction #1)"));
    assert.ok(serialized.includes("read_chunk"), "deterministic summary should preserve tool call trace");
    assert.ok(!serialized.includes("A".repeat(1_000)), "oversized raw tool output should be compacted away");
  });

  it("leaves Tier 1 and Tier 2 rollover behavior unchanged", async () => {
    // Tier 2 with rolloverThreshold 0.78: soft warning at 70%, hard rollover_requested at 80%, zero compaction calls.
    let t2Turn = 0;
    let t2CompactionCalls = 0;
    const t2Server = startFakeOpenAiServer((body) => {
      if (!body.tools || body.tools.length === 0) {
        t2CompactionCalls += 1;
        return { text: "SHOULD_NOT_HAPPEN" };
      }
      t2Turn += 1;
      if (t2Turn === 1) {
        return {
          text: "Worker step 1.",
          toolCall: { id: "w-1", name: "read_chunk", args: { chunk: 2 } },
          promptTokens: 6_900,
          completionTokens: 100, // 70% >= soft warn 66%, < 78%
        };
      }
      return {
        text: "Worker step 2.",
        toolCall: { id: "w-2", name: "read_chunk", args: { chunk: 2 } },
        promptTokens: 7_900,
        completionTokens: 100, // 80% >= 78% -> rollover_requested
      };
    });

    const t2Runner = new PiRunner(t2Server.profile);
    const t2Result = await t2Runner.run(
      makeRequest({
        tier: 2,
        kind: "worker",
        toolPolicy: "read_write_workspace",
        rolloverThreshold: 0.78,
      }),
    );

    assert.equal(t2Result.stopReason, "rollover_requested");
    assert.equal(t2CompactionCalls, 0);
    assert.equal(t2Turn, 2);
    const t2SecondReq = JSON.stringify(t2Server.requests[1]!.messages);
    assert.ok(t2SecondReq.includes("request_rollover"), "Tier 2 should still receive the soft rollover warning");

    // Tier 1 with rolloverThreshold 0.72: exits with rollover_requested at 75%.
    const t1Server = startFakeOpenAiServer(() => ({
      text: "Orchestrator step 1.",
      toolCall: { id: "o-1", name: "read_chunk", args: { chunk: 2 } },
      promptTokens: 7_400,
      completionTokens: 100, // 75% >= 72%
    }));
    const t1Runner = new PiRunner(t1Server.profile);
    const t1Result = await t1Runner.run(
      makeRequest({
        tier: 1,
        kind: "orchestrator",
        toolPolicy: "control_plane_only",
        rolloverThreshold: 0.72,
      }),
    );
    assert.equal(t1Result.stopReason, "rollover_requested");

    // Tier 2 with rolloverThreshold undefined: neither compacts nor rolls over.
    let t2NoThreshTurn = 0;
    const t2NoThreshServer = startFakeOpenAiServer(() => {
      t2NoThreshTurn += 1;
      if (t2NoThreshTurn === 1) {
        return {
          text: "No-threshold step 1.",
          toolCall: { id: "w-nt-1", name: "read_chunk", args: { chunk: 1 } },
          promptTokens: 8_500,
          completionTokens: 100, // 86%
        };
      }
      return { text: "NO_THRESH_DONE", promptTokens: 8_700, completionTokens: 50 };
    });
    const t2NoThreshRunner = new PiRunner(t2NoThreshServer.profile);
    const t2NoThreshResult = await t2NoThreshRunner.run(
      makeRequest({
        tier: 2,
        kind: "worker",
        toolPolicy: "read_write_workspace",
        rolloverThreshold: undefined,
      }),
    );
    assert.equal(t2NoThreshResult.stopReason, "completed");
    assert.equal(t2NoThreshServer.requests.length, 2);
    assert.ok(
      JSON.stringify(t2NoThreshServer.requests[1]!.messages).includes("CHUNK_1_MARKER"),
      "Tier 2 without rolloverThreshold must not run Tier 3 compaction",
    );
  });
});

describe("goal-13 Tier 3 native compaction on Claude ACP runner", () => {
  const claudeProfile: AcpProfileConfig = {
    id: "acp:claude",
    kind: "acp",
    adapter: "claude",
    command: "noop",
    billing: "subscription",
  };

  it("leaves DISABLE_COMPACT unset for Claude Tier 3 (even if inherited) while keeping it set for Tier 1, Tier 2, and omitted tier", () => {
    const prev = process.env.DISABLE_COMPACT;
    process.env.DISABLE_COMPACT = "1";
    try {
      const t3 = prepareAcpSpawn(claudeProfile, {
        systemPrompt: "Bounded research task",
        toolPolicy: "read_only_workspace",
        tier: 3,
      });
      assert.equal(t3.env.DISABLE_COMPACT, undefined);
      t3.cleanup();

      const t3Exec = prepareAcpSpawn(claudeProfile, {
        systemPrompt: "Bounded execute task",
        toolPolicy: "read_write_workspace",
        tier: 3,
      });
      assert.equal(t3Exec.env.DISABLE_COMPACT, undefined);
      t3Exec.cleanup();

      const t1 = prepareAcpSpawn(claudeProfile, {
        systemPrompt: "Orchestrator",
        toolPolicy: "read_only_workspace",
        tier: 1,
      });
      assert.equal(t1.env.DISABLE_COMPACT, "1");
      t1.cleanup();

      const t2 = prepareAcpSpawn(claudeProfile, {
        systemPrompt: "Worker",
        toolPolicy: "read_write_workspace",
        tier: 2,
      });
      assert.equal(t2.env.DISABLE_COMPACT, "1");
      t2.cleanup();

      const omitted = prepareAcpSpawn(claudeProfile, {
        systemPrompt: "Default caller",
        toolPolicy: "read_write_workspace",
      });
      assert.equal(omitted.env.DISABLE_COMPACT, "1");
      omitted.cleanup();
    } finally {
      if (prev === undefined) delete process.env.DISABLE_COMPACT;
      else process.env.DISABLE_COMPACT = prev;
    }
  });

  it("omits autoCompactEnabled:false in buildNewSessionParams for Claude Tier 3 and keeps it for Tier 1, Tier 2, and omitted tier", () => {
    const getClaudeOptions = (params: Record<string, unknown>) =>
      ((params._meta as Record<string, unknown> | undefined)?.claudeCode as { options?: Record<string, unknown> } | undefined)
        ?.options;

    for (const toolPolicy of ["read_only_workspace", "read_write_workspace"] as const) {
      const { params } = buildNewSessionParams("claude", {
        cwd: process.cwd(),
        systemPrompt: "Tier 3 task",
        toolPolicy,
        tier: 3,
        model: "sonnet",
        mcpServers: [],
      });
      const opts = getClaudeOptions(params);
      assert.ok(opts);
      assert.equal(opts.settings, undefined);
      assert.equal(opts.model, "sonnet");
    }

    for (const tier of [1, 2, undefined] as const) {
      const { params } = buildNewSessionParams("claude", {
        cwd: process.cwd(),
        systemPrompt: `Tier ${tier ?? "default"}`,
        toolPolicy: tier === 1 ? "read_only_workspace" : "read_write_workspace",
        tier,
        model: "opus",
        mcpServers: [],
      });
      const opts = getClaudeOptions(params);
      assert.deepEqual(opts?.settings, { autoCompactEnabled: false });
    }
  });

  it("forwards req.tier from AcpRunner.run into Claude session/new and never triggers anchored rollover for Tier 3", async () => {
    const runClaudeWithMock = async (
      reqOverrides: Partial<RunAgentRequest>,
      mode: "usage_update" | "prompt_usage_only" = "usage_update",
    ) => {
      let seenSessionNewParams: Record<string, unknown> | undefined;
      let cancelReceived = false;
      const steerMessages: string[] = [];

      const mockAgent = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.109.0" },
          agentCapabilities: { sessionCapabilities: { systemPrompt: {}, options: {} } },
          _meta: { steering: { supported: true } },
        } as never))
        .onRequest("session/new", async ({ params }) => {
          seenSessionNewParams = params as unknown as Record<string, unknown>;
          return {
            sessionId: "sess-claude-tier",
            models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
          } as never;
        })
        .onRequest("session/set_mode", async () => ({}))
        .onNotification("session/cancel", async () => {
          cancelReceived = true;
        })
        .onRequest("*", async ({ method, params }) => {
          if (method === "_session/steering") {
            steerMessages.push(JSON.stringify(params));
            return {};
          }
          return {};
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          if (mode === "usage_update") {
            // Soft warning band (70% for 0.78 threshold), then hard rollover band (85%).
            await acpClient.notify("session/update", {
              sessionId: "sess-claude-tier",
              update: { sessionUpdate: "usage_update", used: 70_000, size: 100_000 },
            } as never);
            await acpClient.notify("session/update", {
              sessionId: "sess-claude-tier",
              update: { sessionUpdate: "usage_update", used: 85_000, size: 100_000 },
            } as never);
            await new Promise((r) => setTimeout(r, 20));
          }
          return {
            stopReason: cancelReceived ? "cancelled" : "end_turn",
            usage: { totalTokens: 85_000, inputTokens: 84_000, outputTokens: 1_000 },
          } as never;
        });

      const runner = new AcpRunner(claudeProfile);
      const result = await runner.run(
        makeRequest({
          model: "opus",
          contextWindow: 100_000,
          tools: [],
          ...reqOverrides,
        }),
        mockAgent,
      );
      const claudeOpts = (
        (seenSessionNewParams?._meta as Record<string, unknown> | undefined)?.claudeCode as
          | { options?: Record<string, unknown> }
          | undefined
      )?.options;
      return { result, claudeOpts, cancelReceived, steerMessages };
    };

    // Tier 3 with undefined rolloverThreshold (orchestrator default): compaction enabled, completes cleanly.
    const t3Default = await runClaudeWithMock({
      tier: 3,
      kind: "research",
      toolPolicy: "read_only_workspace",
      rolloverThreshold: undefined,
    });
    assert.equal(t3Default.claudeOpts?.settings, undefined);
    assert.equal(t3Default.cancelReceived, false);
    assert.equal(t3Default.steerMessages.length, 0);
    assert.equal(t3Default.result.stopReason, "completed");

    // Tier 3 even if a caller passes rolloverThreshold (via usage_update or PromptResponse.usage fallback):
    // still ignores anchored rollover and keeps native compaction.
    for (const mode of ["usage_update", "prompt_usage_only"] as const) {
      const t3Explicit = await runClaudeWithMock(
        {
          tier: 3,
          kind: "execute",
          toolPolicy: "read_write_workspace",
          rolloverThreshold: 0.78,
        },
        mode,
      );
      assert.equal(t3Explicit.claudeOpts?.settings, undefined);
      assert.equal(t3Explicit.cancelReceived, false);
      assert.equal(t3Explicit.steerMessages.length, 0);
      assert.equal(t3Explicit.result.stopReason, "completed");
    }

    // Tier 1 keeps autoCompactEnabled:false and triggers anchored rollover_requested.
    const t1 = await runClaudeWithMock({
      tier: 1,
      kind: "orchestrator",
      toolPolicy: "read_only_workspace",
      rolloverThreshold: 0.72,
    });
    assert.deepEqual(t1.claudeOpts?.settings, { autoCompactEnabled: false });
    assert.equal(t1.cancelReceived, true);
    assert.equal(t1.result.stopReason, "rollover_requested");

    // Tier 2 keeps autoCompactEnabled:false, receives soft rollover steer, and triggers anchored rollover_requested.
    const t2 = await runClaudeWithMock({
      tier: 2,
      kind: "worker",
      toolPolicy: "read_write_workspace",
      rolloverThreshold: 0.78,
    });
    assert.deepEqual(t2.claudeOpts?.settings, { autoCompactEnabled: false });
    assert.ok(t2.steerMessages.some((m) => m.includes("request_rollover")));
    assert.equal(t2.cancelReceived, true);
    assert.equal(t2.result.stopReason, "rollover_requested");
  });
});
