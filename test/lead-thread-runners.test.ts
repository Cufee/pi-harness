import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import type { AcpProfileConfig, PiProfileConfig } from "../src/config.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { PiRunner } from "../src/runners/pi-runner.js";

// The turn-end check is the hook the lead's goal-driving rests on: when the agent stops calling tools, the runner
// asks the harness whether the turn may end, and a non-null answer opens the next turn with that text.

const CHECK_TEXT = "[Turn-end check] 1 open item: plan step 'wire the parser' is still open.";
const STEER_TEXT = "The user added: also cover the empty-input case.";

const activeServers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  while (activeServers.length > 0) {
    activeServers.pop()?.stop(true);
  }
});

interface MockChatBody {
  messages: Array<{ role: string; content?: string | Array<{ type?: string; text?: string }> }>;
}

function textSse(text: string): string {
  const base = { id: "chatcmpl-lead", object: "chat.completion.chunk", created: 1700000000, model: "test-model" };
  return [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
}

function userTexts(body: MockChatBody): string[] {
  return body.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((part) => part.text ?? "").join("")));
}

function mockPiServer(seen: MockChatBody[]): PiProfileConfig {
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      seen.push((await request.json()) as MockChatBody);
      return new Response(textSse(`reply ${seen.length}`), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
    },
  });
  activeServers.push(server);
  return {
    id: "pi:test-local",
    kind: "pi",
    provider: "local-test",
    api: "openai-completions",
    baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`,
    billing: "local",
    models: ["test-model"],
  };
}

const ACP_PROFILE: AcpProfileConfig = {
  id: "acp:amp",
  kind: "acp",
  adapter: "generic",
  command: "npx",
  args: ["-y", "amp-acp"],
  billing: "subscription",
};

function fakeAcpAgent(seenPrompts: string[]) {
  return agent()
    .onRequest("initialize", async () => ({
      protocolVersion: 1,
      agentInfo: { name: "amp-acp", version: "0.12.0" },
      agentCapabilities: { sessionCapabilities: {} },
    } as never))
    .onRequest("session/new", async () => ({
      sessionId: "S-lead",
      models: {
        currentModelId: "anthropic/claude-opus-5-5",
        availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
      },
    } as never))
    .onRequest("session/prompt", async ({ params }) => {
      seenPrompts.push(((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join(""));
      return { stopReason: "end_turn" } as never;
    });
}

describe("lead turn-end check in the runners", () => {
  it("PiRunner reopens the turn with the check's text and ends once the check allows it", async () => {
    const seen: MockChatBody[] = [];
    const profile = mockPiServer(seen);
    const answers: Array<string | null> = [CHECK_TEXT, null];
    let checks = 0;

    const res = await new PiRunner(profile).run({
      runId: "r-lead-pi",
      taskId: "t-lead-pi",
      tier: 1,
      kind: "orchestrator",
      cwd: process.cwd(),
      toolPolicy: "control_plane_only",
      systemPrompt: "Lead",
      initialPrompt: "Deliver the goal",
      model: "test-model",
      tools: [],
      executeTool: async () => ({}),
      turnEndCheck: async () => {
        checks += 1;
        return answers.shift() ?? null;
      },
      signal: new AbortController().signal,
      callbacks: {},
    });

    assert.equal(res.stopReason, "completed");
    assert.equal(checks, 2, "the check runs at every turn end until it allows the turn to end");
    assert.equal(seen.length, 2, "one extra model turn, opened by the check");
    assert.ok(!userTexts(seen[0]!).some((text) => text.includes(CHECK_TEXT)));
    assert.ok(userTexts(seen[1]!).some((text) => text.includes(CHECK_TEXT)), "turn 2 carries the open items");
    assert.equal(res.text, "reply 2");
  });

  it("PiRunner delivers queued steering before it asks the check", async () => {
    const seen: MockChatBody[] = [];
    const profile = mockPiServer(seen);
    const pendingSteers = [STEER_TEXT];
    const order: string[] = [];

    const res = await new PiRunner(profile).run({
      runId: "r-lead-pi-steer",
      taskId: "t-lead-pi-steer",
      tier: 1,
      kind: "orchestrator",
      cwd: process.cwd(),
      toolPolicy: "control_plane_only",
      systemPrompt: "Lead",
      initialPrompt: "Deliver the goal",
      model: "test-model",
      tools: [],
      executeTool: async () => ({}),
      drainPendingSteers: () => {
        const drained = pendingSteers.splice(0);
        if (drained.length > 0) order.push("steer");
        return drained;
      },
      turnEndCheck: async () => {
        order.push("check");
        return null;
      },
      signal: new AbortController().signal,
      callbacks: {},
    });

    assert.equal(res.stopReason, "completed");
    assert.deepEqual(order, ["steer", "check"], "the check judges the turn that already saw the steer");
    assert.equal(seen.length, 2);
    assert.ok(userTexts(seen[1]!).some((text) => text.includes(STEER_TEXT)));
  });

  it("PiRunner ends the turn when the check itself fails", async () => {
    const seen: MockChatBody[] = [];
    const profile = mockPiServer(seen);

    const res = await new PiRunner(profile).run({
      runId: "r-lead-pi-throw",
      taskId: "t-lead-pi-throw",
      tier: 1,
      kind: "orchestrator",
      cwd: process.cwd(),
      toolPolicy: "control_plane_only",
      systemPrompt: "Lead",
      initialPrompt: "Deliver the goal",
      model: "test-model",
      tools: [],
      executeTool: async () => ({}),
      turnEndCheck: async () => {
        throw new Error("state store unavailable");
      },
      signal: new AbortController().signal,
      callbacks: {},
    });

    assert.equal(res.stopReason, "completed");
    assert.equal(seen.length, 1, "a broken check must not trap the agent in its turn");
  });

  it("AcpRunner reopens the turn with the check's text and ends once the check allows it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-lead-acp-check-"));
    try {
      const seenPrompts: string[] = [];
      const answers: Array<string | null> = [CHECK_TEXT, null];
      let checks = 0;

      const res = await new AcpRunner(ACP_PROFILE).run(
        {
          runId: "r-lead-acp",
          taskId: "t-lead-acp",
          tier: 1,
          kind: "orchestrator",
          cwd,
          toolPolicy: "control_plane_only",
          systemPrompt: "Lead",
          initialPrompt: "Deliver the goal",
          model: "anthropic/claude-opus-5-5",
          tools: [],
          executeTool: async () => ({}),
          turnEndCheck: async () => {
            checks += 1;
            return answers.shift() ?? null;
          },
          signal: new AbortController().signal,
          callbacks: {},
        },
        fakeAcpAgent(seenPrompts),
      );

      assert.equal(res.stopReason, "completed");
      assert.equal(checks, 2);
      assert.equal(seenPrompts.length, 2);
      assert.ok(!seenPrompts[0]!.includes(CHECK_TEXT));
      assert.equal(seenPrompts[1], CHECK_TEXT);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("AcpRunner delivers queued steering before it asks the check", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-lead-acp-steer-"));
    try {
      const seenPrompts: string[] = [];
      const pendingSteers = [STEER_TEXT];
      const order: string[] = [];

      const res = await new AcpRunner(ACP_PROFILE).run(
        {
          runId: "r-lead-acp-steer",
          taskId: "t-lead-acp-steer",
          tier: 1,
          kind: "orchestrator",
          cwd,
          toolPolicy: "control_plane_only",
          systemPrompt: "Lead",
          initialPrompt: "Deliver the goal",
          model: "anthropic/claude-opus-5-5",
          tools: [],
          executeTool: async () => ({}),
          drainPendingSteers: () => {
            const drained = pendingSteers.splice(0);
            if (drained.length > 0) order.push("steer");
            return drained;
          },
          turnEndCheck: async () => {
            order.push("check");
            return null;
          },
          signal: new AbortController().signal,
          callbacks: {},
        },
        fakeAcpAgent(seenPrompts),
      );

      assert.equal(res.stopReason, "completed");
      assert.deepEqual(order, ["steer", "check"]);
      assert.equal(seenPrompts.length, 2);
      assert.ok(seenPrompts[1]!.includes(STEER_TEXT));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
