import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import { DEFAULT_TASK_COMPACTION_THRESHOLD, type PiProfileConfig } from "../src/config.js";
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
