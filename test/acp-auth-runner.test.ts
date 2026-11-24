import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { agent } from "@agentclientprotocol/sdk/unstable";
import type { AcpProfileConfig } from "../src/config.js";
import { AcpProfileError } from "../src/runners/acp-profile-error.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import type { PassiveQuotaSignal, RunAgentRequest } from "../src/runners/types.js";

function makeProfile(overrides: Partial<AcpProfileConfig> = {}): AcpProfileConfig {
  return {
    id: "acp:gemini",
    kind: "acp",
    adapter: "gemini",
    command: "/usr/local/bin/gemini",
    args: ["--acp"],
    billing: "subscription",
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RunAgentRequest> = {}): RunAgentRequest {
  return {
    runId: "run-auth-test",
    taskId: "t-auth-test",
    tier: 2,
    kind: "execute",
    cwd: process.cwd(),
    toolPolicy: "read_only_workspace",
    model: "fixture",
    systemPrompt: "System",
    initialPrompt: "Do the task",
    tools: [
      { name: "return_task", description: "Return task", inputSchema: {} },
      { name: "spawn_task", description: "Spawn task", inputSchema: {} },
    ],
    executeTool: async () => ({}),
    signal: new AbortController().signal,
    callbacks: {},
    ...overrides,
  };
}

describe("AcpRunner auth classification, authOk, and tools-missing fail-fast", () => {
  it("classifies session/new RequestError.authRequired() as AcpProfileError(auth_required) and emits passive signal", async () => {
    const signals: PassiveQuotaSignal[] = [];
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => {
        throw RequestError.authRequired();
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:gemini", command: "/opt/bin/gemini" }));
    let caught: unknown;
    try {
      await runner.run(
        makeRequest({
          callbacks: {
            onPassiveQuota: (sig) => signals.push(sig),
          },
        }),
        mockAgent,
      );
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof AcpProfileError, `expected AcpProfileError, got ${String(caught)}`);
    assert.equal(caught.kind, "auth_required");
    assert.equal(caught.profileId, "acp:gemini");
    assert.match(caught.message, /acp:gemini/);
    assert.match(caught.message, /Log in/);
    assert.match(caught.message, /\(gemini\)/);

    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.profileId, "acp:gemini");
    assert.equal(signals[0]!.model, null);
    assert.equal(signals[0]!.raw.sessionFailure, "auth_required");
    assert.match(String(signals[0]!.raw.detail), /Authentication required/i);
  });

  it("classifies Claude logged-out text with no tool calls as auth_required without emitting authOk or wrap-up", async () => {
    const signals: PassiveQuotaSignal[] = [];
    let promptCalls = 0;
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-claude-logged-out",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        promptCalls++;
        await acpClient.notify("session/update", {
          sessionId: "sess-claude-logged-out",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Invalid API key · Please run /login" },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:claude", adapter: "claude", command: "claude" }));
    let caught: unknown;
    try {
      await runner.run(
        makeRequest({
          missingReturnWrapUpPrompt: "Please call return_task",
          callbacks: {
            onPassiveQuota: (sig) => signals.push(sig),
          },
        }),
        mockAgent,
      );
    } catch (err) {
      caught = err;
    }

    assert.equal(promptCalls, 1);
    assert.ok(caught instanceof AcpProfileError, `expected AcpProfileError, got ${String(caught)}`);
    assert.equal(caught.kind, "auth_required");
    assert.equal(caught.profileId, "acp:claude");
    assert.match(caught.message, /acp:claude/);
    assert.match(caught.message, /Log in/);
    assert.match(caught.message, /Invalid API key/);

    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.raw.sessionFailure, "auth_required");
    assert.equal(signals.some((s) => s.raw.authOk === true), false);
  });

  it("does not trigger auth heuristic on long prose (>= 400 chars) and emits authOk once", async () => {
    const signals: PassiveQuotaSignal[] = [];
    const longText = `We investigated the CLI message "Invalid API key · Please run /login". ${"details ".repeat(60)}`;
    assert.ok(longText.trim().length >= 400);

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-long-prose",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        // session/new alone must not have emitted authOk yet.
        assert.equal(signals.length, 0);
        await acpClient.notify("session/update", {
          sessionId: "sess-long-prose",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: longText },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:claude", adapter: "claude", command: "claude" }));
    const res = await runner.run(
      makeRequest({
        callbacks: {
          onPassiveQuota: (sig) => signals.push(sig),
        },
      }),
      mockAgent,
    );

    assert.equal(res.stopReason, "completed");
    const authOkSignals = signals.filter((s) => s.raw.authOk === true);
    assert.equal(authOkSignals.length, 1);
    assert.equal(authOkSignals[0]!.profileId, "acp:claude");
    assert.equal(authOkSignals[0]!.model, null);
  });

  it("emits onPassiveQuota authOk:true exactly once when a successful agent emits a tool_call", async () => {
    const signals: PassiveQuotaSignal[] = [];
    let authOkCountDuringPrompt = -1;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-tool-ok",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        // Not emitted after session/new alone.
        assert.equal(signals.filter((s) => s.raw.authOk === true).length, 0);

        await acpClient.notify("session/update", {
          sessionId: "sess-tool-ok",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "read_file",
            status: "in_progress",
          },
        } as never);
        await acpClient.notify("session/update", {
          sessionId: "sess-tool-ok",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-1",
            title: "read_file",
            status: "completed",
          },
        } as never);
        await acpClient.notify("session/update", {
          sessionId: "sess-tool-ok",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-2",
            title: "return_task",
            status: "completed",
          },
        } as never);
        // Yield a microtask so notifications are processed before sampling count.
        await new Promise((r) => setTimeout(r, 10));
        authOkCountDuringPrompt = signals.filter((s) => s.raw.authOk === true).length;

        await acpClient.notify("session/update", {
          sessionId: "sess-tool-ok",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Done." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:gemini" }));
    const res = await runner.run(
      makeRequest({
        callbacks: {
          onPassiveQuota: (sig) => signals.push(sig),
        },
      }),
      mockAgent,
    );

    assert.equal(res.stopReason, "completed");
    assert.equal(authOkCountDuringPrompt, 1);
    const authOkSignals = signals.filter((s) => s.raw.authOk === true);
    assert.equal(authOkSignals.length, 1);
    assert.equal(authOkSignals[0]!.profileId, "acp:gemini");
    assert.equal(authOkSignals[0]!.model, null);
  });

  it("fails fast with AcpProfileError(tools_missing) before first prompt when harness tools are never listed", async () => {
    let promptCalls = 0;
    const seenSinceMs: number[] = [];
    const signals: PassiveQuotaSignal[] = [];

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-no-tools",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async () => {
        promptCalls++;
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:gemini" }));
    const beforeMs = Date.now();
    let caught: unknown;
    try {
      await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: (sinceMs) => {
            seenSinceMs.push(sinceMs);
            return false;
          },
          harnessToolsGraceMs: 200,
          callbacks: {
            onPassiveQuota: (sig) => signals.push(sig),
          },
        }),
        mockAgent,
      );
    } catch (err) {
      caught = err;
    }

    assert.equal(promptCalls, 0);
    assert.ok(seenSinceMs.length >= 2, `expected multiple polls, saw ${seenSinceMs.length}`);
    assert.ok(seenSinceMs[0]! >= beforeMs);
    assert.ok(caught instanceof AcpProfileError, `expected AcpProfileError, got ${String(caught)}`);
    assert.equal(caught.kind, "tools_missing");
    assert.equal(caught.profileId, "acp:gemini");
    assert.match(caught.message, /acp:gemini/);
    assert.match(caught.message, /200 ms/);
    assert.match(caught.message, /return_task/);
    assert.equal(signals.length, 0);
  });

  it("completes normally when harnessToolsListedSince returns true (control)", async () => {
    let promptCalls = 0;
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-tools-ok",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        promptCalls++;
        await acpClient.notify("session/update", {
          sessionId: "sess-tools-ok",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Tools available." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:gemini" }));
    const res = await runner.run(
      makeRequest({
        daemonSocketPath: "/tmp/dummy-harness.sock",
        mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
        harnessToolsListedSince: () => true,
        harnessToolsGraceMs: 200,
      }),
      mockAgent,
    );

    assert.equal(promptCalls, 1);
    assert.equal(res.stopReason, "completed");
    assert.equal(res.text, "Tools available.");
  });

  it("disables tools-missing check when harnessToolsGraceMs is 0 or PI_HARNESS_TOOLS_GRACE_MS is '0'", async () => {
    let promptCalls = 0;
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-grace-zero",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async () => {
        promptCalls++;
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:gemini" }));
    const resExplicitZero = await runner.run(
      makeRequest({
        daemonSocketPath: "/tmp/dummy-harness.sock",
        mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
        harnessToolsListedSince: () => false,
        harnessToolsGraceMs: 0,
      }),
      mockAgent,
    );
    assert.equal(resExplicitZero.stopReason, "completed");
    assert.equal(promptCalls, 1);

    const prevEnv = process.env.PI_HARNESS_TOOLS_GRACE_MS;
    process.env.PI_HARNESS_TOOLS_GRACE_MS = "0";
    try {
      const resEnvZero = await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: () => false,
        }),
        mockAgent,
      );
      assert.equal(resEnvZero.stopReason, "completed");
      assert.equal(promptCalls, 2);
    } finally {
      if (prevEnv === undefined) delete process.env.PI_HARNESS_TOOLS_GRACE_MS;
      else process.env.PI_HARNESS_TOOLS_GRACE_MS = prevEnv;
    }
  });

  it("aborts tools-missing poll early on req.signal without throwing tools_missing", async () => {
    let promptCalls = 0;
    const controller = new AbortController();
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-abort-poll",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async () => {
        promptCalls++;
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:gemini" }));
    const startedAt = Date.now();
    setTimeout(() => controller.abort(), 50);

    const res = await runner.run(
      makeRequest({
        daemonSocketPath: "/tmp/dummy-harness.sock",
        mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
        harnessToolsListedSince: () => false,
        harnessToolsGraceMs: 5_000,
        signal: controller.signal,
      }),
      mockAgent,
    );

    const elapsedMs = Date.now() - startedAt;
    assert.equal(res.stopReason, "cancelled");
    assert.equal(promptCalls, 0);
    assert.ok(elapsedMs < 1_500, `expected early abort, took ${elapsedMs}ms`);
  });
});
