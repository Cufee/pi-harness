import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import { RequestError } from "@agentclientprotocol/sdk";
import { agent } from "@agentclientprotocol/sdk/unstable";
import type { AcpProfileConfig } from "../src/config.js";
import { attachDaemonReader, writeNdjson } from "../src/protocol/frames.js";
import type { RpcRequest } from "../src/protocol/daemon-rpc.js";
import { QuotaClient } from "../src/quota/client.js";
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
    assert.match(caught.message, /log in to the agent behind profile acp:gemini/i);
    assert.doesNotMatch(caught.message, /\(gemini\)/);

    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.profileId, "acp:gemini");
    assert.equal(signals[0]!.model, null);
    assert.equal(signals[0]!.raw.sessionFailure, "auth_required");
    assert.match(String(signals[0]!.raw.detail), /Authentication required/i);
  });

  it("uses profile-specific login hints and never suggests wrapper executables like npx", async () => {
    const cases: Array<{
      profile: Partial<AcpProfileConfig>;
      expectedHint: RegExp;
    }> = [
      {
        profile: { id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] },
        expectedHint: /run 'amp login'/,
      },
      {
        profile: {
          id: "acp:claude",
          adapter: "claude",
          command: "npx",
          args: ["-y", "@agentclientprotocol/claude-agent-acp"],
        },
        expectedHint: /run 'claude' then \/login/,
      },
      {
        profile: { id: "acp:custom", adapter: "generic", command: "npx", args: ["-y", "custom-acp"] },
        expectedHint: /log in to the agent behind profile acp:custom/,
      },
    ];

    for (const tc of cases) {
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => {
          throw RequestError.authRequired();
        });
      const runner = new AcpRunner(makeProfile(tc.profile));
      let caught: unknown;
      try {
        await runner.run(makeRequest(), mockAgent);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof AcpProfileError);
      assert.equal(caught.kind, "auth_required");
      assert.match(caught.message, new RegExp(tc.profile.id!));
      assert.match(caught.message, tc.expectedHint);
      assert.doesNotMatch(caught.message, /\bnpx\b/i);
    }
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
    assert.match(caught.message, /run 'claude' then \/login/);
    assert.match(caught.message, /Invalid API key/);

    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.raw.sessionFailure, "auth_required");
    assert.equal(signals.some((s) => s.raw.authOk === true), false);
  });

  it("classifies standalone Amp and Claude login diagnostics on tool-free turns", async () => {
    const diagnostics = [
      "Please run /login",
      "Run /login to continue.",
      "Please run /login first.",
      "Run /login and try again.",
      "Not logged in · Please run /login",
      "Not logged in. Run 'amp login' to sign in.",
      "Invalid or missing API key. Run 'amp login'",
    ];

    for (const diagnostic of diagnostics) {
      const signals: PassiveQuotaSignal[] = [];
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-diag",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await acpClient.notify("session/update", {
            sessionId: "sess-diag",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: diagnostic },
            },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      let caught: unknown;
      try {
        await runner.run(
          makeRequest({
            callbacks: { onPassiveQuota: (sig) => signals.push(sig) },
          }),
          mockAgent,
        );
      } catch (err) {
        caught = err;
      }

      assert.ok(caught instanceof AcpProfileError, `expected auth_required for "${diagnostic}", got ${String(caught)}`);
      assert.equal(caught.kind, "auth_required");
      assert.equal(signals.length, 1);
      assert.equal(signals[0]!.raw.sessionFailure, "auth_required");
    }
  });

  it("completes short legitimate prose mentioning login without auth_required or cooldown", async () => {
    const proseCases = [
      "The client should show a login form when the user is not logged in.",
      "Run /login only if the user asks to switch accounts.",
      "Authentication required. We added middleware to return 401 on that route.",
      "Not logged in. That is the expected initial state before sign-in.",
    ];

    for (const shortProse of proseCases) {
      const quota = new QuotaClient();
      const signals: PassiveQuotaSignal[] = [];

      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-short-prose",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await acpClient.notify("session/update", {
            sessionId: "sess-short-prose",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: shortProse },
            },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      const res = await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: () => true,
          harnessToolsGraceMs: 200,
          callbacks: {
            onPassiveQuota: (sig) => {
              signals.push(sig);
              quota.ingestPassiveSignal(sig);
            },
          },
        }),
        mockAgent,
      );

      assert.equal(res.stopReason, "completed", `expected completed for "${shortProse}"`);
      assert.equal(res.text, shortProse);
      assert.equal(quota.authStatus("acp:amp"), null, `expected no cooldown for "${shortProse}"`);
      assert.equal(
        signals.some((s) => s.raw.sessionFailure !== undefined),
        false,
        `expected no sessionFailure signal for "${shortProse}"`,
      );
      assert.equal(signals.filter((s) => s.raw.authOk === true).length, 1);
    }
  });

  it("settles structured _meta.jetbrains.air.sessionFailure.code=auth_required once without authOk, wrap-up, or completion", async () => {
    const quota = new QuotaClient();
    const signals: PassiveQuotaSignal[] = [];
    let promptCalls = 0;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-structured-auth",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async () => {
        promptCalls++;
        return {
          stopReason: "end_turn",
          _meta: {
            jetbrains: {
              air: {
                sessionFailure: { code: "auth_required" },
              },
            },
          },
        } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
    let caught: unknown;
    try {
      await runner.run(
        makeRequest({
          missingReturnWrapUpPrompt: "Please call return_task",
          callbacks: {
            onPassiveQuota: (sig) => {
              signals.push(sig);
              quota.ingestPassiveSignal(sig);
            },
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
    assert.equal(caught.profileId, "acp:amp");
    assert.match(caught.message, /run 'amp login'/);
    assert.equal(signals.length, 1);
    assert.equal(signals[0]!.raw.sessionFailure, "auth_required");
    assert.equal(signals.some((s) => s.raw.authOk === true), false);
    assert.ok(quota.authStatus("acp:amp") !== null, "expected real QuotaClient to record auth cooldown");
  });

  it("lets structured auth_required override an earlier authOk in the same turn", async () => {
    const quota = new QuotaClient();
    const signals: PassiveQuotaSignal[] = [];

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-struct-beats-ok",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        await acpClient.notify("session/update", {
          sessionId: "sess-struct-beats-ok",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-1",
            title: "read_file",
            status: "completed",
          },
        } as never);
        await new Promise((r) => setTimeout(r, 10));
        return {
          stopReason: "end_turn",
          _meta: { jetbrains: { air: { sessionFailure: { code: "auth_required" } } } },
        } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
    let caught: unknown;
    try {
      await runner.run(
        makeRequest({
          callbacks: {
            onPassiveQuota: (sig) => {
              signals.push(sig);
              quota.ingestPassiveSignal(sig);
            },
          },
        }),
        mockAgent,
      );
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof AcpProfileError);
    assert.equal(caught.kind, "auth_required");
    assert.equal(signals.filter((s) => s.raw.sessionFailure === "auth_required").length, 1);
    assert.ok(quota.authStatus("acp:amp") !== null, "structured auth_required must leave QuotaClient in cooldown");
  });

  it("passes tools check when a harness tool call completes even if harnessToolsListedSince stays false", async () => {
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-harness-tool-call",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        await acpClient.notify("session/update", {
          sessionId: "sess-harness-tool-call",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-ret",
            title: "mcp__harness__return_task",
            status: "completed",
          },
        } as never);
        await new Promise((r) => setTimeout(r, 250));
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
    const res = await runner.run(
      makeRequest({
        daemonSocketPath: "/tmp/dummy-harness.sock",
        mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
        harnessToolsListedSince: () => false,
        harnessToolsGraceMs: 120,
      }),
      mockAgent,
    );

    assert.equal(res.stopReason, "completed");
  });

  it("does not emit authOk on failed or cancelled tool_call notifications", async () => {
    const signals: PassiveQuotaSignal[] = [];
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-failed-tool",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        await acpClient.notify("session/update", {
          sessionId: "sess-failed-tool",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-fail",
            title: "read_file",
            status: "failed",
          },
        } as never);
        await acpClient.notify("session/update", {
          sessionId: "sess-failed-tool",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tc-cancel",
            title: "read_file",
            status: "cancelled",
          },
        } as never);
        await new Promise((r) => setTimeout(r, 10));
        return { stopReason: "cancelled" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:gemini" }));
    const res = await runner.run(
      makeRequest({
        callbacks: { onPassiveQuota: (sig) => signals.push(sig) },
      }),
      mockAgent,
    );

    assert.equal(res.stopReason, "cancelled");
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

  it("does not cancel on grace expiry, but cancels on tools ceiling timeout and throws tools_missing naming the profile", async () => {
    let promptCalls = 0;
    let cancelCalls = 0;
    let cancelElapsedMs = 0;
    const seenSinceMs: number[] = [];
    const signals: PassiveQuotaSignal[] = [];
    let promptStartedAt = 0;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-no-tools",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onNotification("session/cancel", async () => {
        cancelCalls++;
        cancelElapsedMs = Date.now() - promptStartedAt;
      })
      .onRequest("session/prompt", async () => {
        promptCalls++;
        promptStartedAt = Date.now();
        // Hold the turn open longer than PI_HARNESS_TOOLS_CEILING_MS so the ceiling timer cancels it.
        await new Promise((r) => setTimeout(r, 1_500));
        return { stopReason: cancelCalls > 0 ? "cancelled" : "end_turn" } as never;
      });

    const prevCeiling = process.env.PI_HARNESS_TOOLS_CEILING_MS;
    process.env.PI_HARNESS_TOOLS_CEILING_MS = "320";
    try {
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
            harnessToolsGraceMs: 100,
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
      assert.ok(cancelCalls >= 1, `expected session/cancel on ceiling expiry, got ${cancelCalls}`);
      assert.ok(cancelElapsedMs >= 250, `expected cancel after ceiling (320 ms), not grace (100 ms); got ${cancelElapsedMs} ms`);
      assert.ok(seenSinceMs.length >= 2, `expected multiple polls, saw ${seenSinceMs.length}`);
      assert.ok(seenSinceMs[0]! >= beforeMs);
      assert.ok(caught instanceof AcpProfileError, `expected AcpProfileError, got ${String(caught)}`);
      assert.equal(caught.kind, "tools_missing");
      assert.equal(caught.profileId, "acp:gemini");
      assert.match(caught.message, /acp:gemini/);
      assert.match(caught.message, /320 ms/);
      assert.match(caught.message, /return_task/);
      assert.equal(signals.length, 0);
    } finally {
      if (prevCeiling === undefined) delete process.env.PI_HARNESS_TOOLS_CEILING_MS;
      else process.env.PI_HARNESS_TOOLS_CEILING_MS = prevCeiling;
    }
  });

  it("handles lazy tool discovery across eager, wrap-up/grace, and post-grace turns without false tools_missing", async () => {
    // Case 1: listed before 10 ms answer -> completed, no cancel
    {
      let cancelCalls = 0;
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-lazy-1",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCalls++;
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await new Promise((r) => setTimeout(r, 10));
          await acpClient.notify("session/update", {
            sessionId: "sess-lazy-1",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Quick answer." } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      const res = await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: () => true,
          harnessToolsGraceMs: 100,
        }),
        mockAgent,
      );
      assert.equal(res.stopReason, "completed");
      assert.equal(cancelCalls, 0);
    }

    // Case 2a: answer at 10 ms, lazy client lists on wrap-up prompt at ~90 ms -> completed, not tools_missing
    {
      let promptCalls = 0;
      let cancelCalls = 0;
      let listedAt = 0;
      let startedAt = 0;
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-lazy-2a",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCalls++;
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          promptCalls++;
          if (promptCalls === 1) {
            startedAt = Date.now();
            await new Promise((r) => setTimeout(r, 10));
            await acpClient.notify("session/update", {
              sessionId: "sess-lazy-2a",
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Turn 1 prose." } },
            } as never);
            return { stopReason: "end_turn" } as never;
          }
          const remainingTo90 = Math.max(0, 90 - (Date.now() - startedAt));
          if (remainingTo90 > 0) await new Promise((r) => setTimeout(r, remainingTo90));
          listedAt = Date.now();
          await acpClient.notify("session/update", {
            sessionId: "sess-lazy-2a",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Wrap-up listed tools." } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      const res = await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: (sinceMs) => listedAt >= sinceMs,
          harnessToolsGraceMs: 100,
          missingReturnWrapUpPrompt: "Please call return_task",
        }),
        mockAgent,
      );
      assert.equal(promptCalls, 2);
      assert.equal(cancelCalls, 0);
      assert.equal(res.stopReason, "completed");
    }

    // Case 2b: answer at 10 ms without wrap-up prompt, time-based list becomes available at 90 ms (< 100 ms grace) -> completed
    {
      let cancelCalls = 0;
      let listedAt = 0;
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-lazy-2b",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCalls++;
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          setTimeout(() => {
            listedAt = Date.now();
          }, 90).unref?.();
          await new Promise((r) => setTimeout(r, 10));
          await acpClient.notify("session/update", {
            sessionId: "sess-lazy-2b",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Fast answer." } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      const res = await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: (sinceMs) => listedAt >= sinceMs,
          harnessToolsGraceMs: 100,
        }),
        mockAgent,
      );
      assert.equal(cancelCalls, 0);
      assert.equal(res.stopReason, "completed");
    }

    // Case 3: 180 ms turn with list at 150 ms and grace 100 ms -> no cancel, completed
    {
      let cancelCalls = 0;
      let listedAt = 0;
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-lazy-3",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCalls++;
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await new Promise((r) => setTimeout(r, 150));
          listedAt = Date.now();
          await new Promise((r) => setTimeout(r, 30));
          await acpClient.notify("session/update", {
            sessionId: "sess-lazy-3",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Late list succeeded." } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      const res = await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: (sinceMs) => listedAt >= sinceMs,
          harnessToolsGraceMs: 100,
        }),
        mockAgent,
      );
      assert.equal(cancelCalls, 0);
      assert.equal(res.stopReason, "completed");
      assert.equal(res.text, "Late list succeeded.");
    }
  });

  it("lets wrap-up run after tool-free turn 1 and fails tools_missing only if wrap-up also ends without tools", async () => {
    let promptCalls = 0;
    const signals: PassiveQuotaSignal[] = [];

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-uninstrumented-end",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        promptCalls++;
        await acpClient.notify("session/update", {
          sessionId: "sess-uninstrumented-end",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Finished without MCP tools." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
    let caught: unknown;
    try {
      await runner.run(
        makeRequest({
          daemonSocketPath: "/tmp/dummy-harness.sock",
          mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
          harnessToolsListedSince: () => false,
          harnessToolsGraceMs: 5_000,
          missingReturnWrapUpPrompt: "Please call return_task",
          callbacks: { onPassiveQuota: (sig) => signals.push(sig) },
        }),
        mockAgent,
      );
    } catch (err) {
      caught = err;
    }

    assert.equal(promptCalls, 2);
    assert.ok(caught instanceof AcpProfileError, `expected AcpProfileError, got ${String(caught)}`);
    assert.equal(caught.kind, "tools_missing");
    assert.equal(caught.profileId, "acp:amp");
    assert.match(caught.message, /acp:amp/);
    assert.equal(signals.length, 0);
  });

  it("succeeds when tools are listed after first session/prompt arrives (on_prompt / amp-acp behavior)", async () => {
    let listed = false;
    let promptCalls = 0;

    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-on-prompt",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onRequest("session/prompt", async ({ client: acpClient }) => {
        promptCalls++;
        // Simulate amp-acp: MCP transport starts and lists tools only after session/prompt arrives.
        await new Promise((r) => setTimeout(r, 40));
        listed = true;
        // Continue running past harnessToolsGraceMs to confirm the timer was disarmed.
        await new Promise((r) => setTimeout(r, 250));
        await acpClient.notify("session/update", {
          sessionId: "sess-on-prompt",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Listed on prompt." },
          },
        } as never);
        return { stopReason: "end_turn" } as never;
      });

    const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
    const res = await runner.run(
      makeRequest({
        daemonSocketPath: "/tmp/dummy-harness.sock",
        mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
        harnessToolsListedSince: () => listed,
        harnessToolsGraceMs: 150,
      }),
      mockAgent,
    );

    assert.equal(promptCalls, 1);
    assert.equal(res.stopReason, "completed");
    assert.equal(res.text, "Listed on prompt.");
  });

  it("lets auth errors (RPC, structured, and diagnostic text) take precedence over tools_missing", async () => {
    // 1. RPC -32000 during prompt
    {
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-auth-rpc",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onRequest("session/prompt", async () => {
          throw RequestError.authRequired();
        });
      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      let caught: unknown;
      try {
        await runner.run(
          makeRequest({
            daemonSocketPath: "/tmp/dummy-harness.sock",
            mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
            harnessToolsListedSince: () => false,
            harnessToolsGraceMs: 5_000,
          }),
          mockAgent,
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof AcpProfileError);
      assert.equal(caught.kind, "auth_required");
    }

    // 2. Structured auth_required on end_turn
    {
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-auth-struct",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onRequest("session/prompt", async () => ({
          stopReason: "end_turn",
          _meta: { jetbrains: { air: { sessionFailure: { code: "auth_required" } } } },
        } as never));
      const runner = new AcpRunner(makeProfile({ id: "acp:amp", adapter: "generic", command: "npx", args: ["-y", "amp-acp"] }));
      let caught: unknown;
      try {
        await runner.run(
          makeRequest({
            daemonSocketPath: "/tmp/dummy-harness.sock",
            mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
            harnessToolsListedSince: () => false,
            harnessToolsGraceMs: 5_000,
          }),
          mockAgent,
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof AcpProfileError);
      assert.equal(caught.kind, "auth_required");
    }

    // 3. Standalone diagnostic text on turn 1
    {
      const mockAgent = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
        .onRequest("session/new", async () => ({
          sessionId: "sess-auth-text",
          models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
        } as never))
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await acpClient.notify("session/update", {
            sessionId: "sess-auth-text",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Invalid API key · Please run /login" },
            },
          } as never);
          return { stopReason: "end_turn" } as never;
        });
      const runner = new AcpRunner(makeProfile({ id: "acp:claude", adapter: "claude", command: "npx" }));
      let caught: unknown;
      try {
        await runner.run(
          makeRequest({
            daemonSocketPath: "/tmp/dummy-harness.sock",
            mcpBridgeEntrypoint: "/tmp/dummy-mcp-bridge.js",
            harnessToolsListedSince: () => false,
            harnessToolsGraceMs: 5_000,
          }),
          mockAgent,
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof AcpProfileError);
      assert.equal(caught.kind, "auth_required");
    }
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

  it("aborts tools-missing watch early on req.signal without throwing tools_missing", async () => {
    let promptCalls = 0;
    let resolvePendingPrompt: (() => void) | null = null;
    const controller = new AbortController();
    const mockAgent = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1 } as never))
      .onRequest("session/new", async () => ({
        sessionId: "sess-abort-poll",
        models: { currentModelId: "fixture", availableModels: [{ modelId: "fixture", name: "Fixture" }] },
      } as never))
      .onNotification("session/cancel", async () => {
        resolvePendingPrompt?.();
      })
      .onRequest("session/prompt", async () => {
        promptCalls++;
        await new Promise<void>((r) => {
          resolvePendingPrompt = r;
          setTimeout(r, 5_000);
        });
        return { stopReason: "cancelled" } as never;
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
    assert.equal(promptCalls, 1);
    assert.ok(elapsedMs < 1_500, `expected early abort, took ${elapsedMs}ms`);
  });

  it("handles FAKE_ACP_LIST_TOOLS=eager, on_prompt, on_wrap_up, and never end-to-end via fake-acp-agent + mcp-bridge", async () => {
    const repoRoot = resolve(import.meta.dir, "..");
    const fakeAgentPath = resolve(repoRoot, "test", "fixtures", "fake-acp-agent.ts");
    const mcpBridgePath = resolve(repoRoot, "src", "runners", "mcp-bridge.ts");

    async function runFakeAgentMode(
      mode: "eager" | "on_prompt" | "on_wrap_up" | "never",
      opts: {
        promptDelayMs?: number;
        listDelayMs?: number;
        graceMs?: number;
        ceilingMs?: number;
        missingReturnWrapUpPrompt?: string;
      } = {},
    ) {
      const dir = mkdtempSync(join(tmpdir(), `pi-acp-list-${mode}-`));
      const socketPath = join(dir, "daemon.sock");
      let listedAt = 0;

      const server = createServer((sock) => {
        attachDaemonReader(sock, {
          onMessage(raw) {
            const req = raw as RpcRequest;
            if (req.kind !== "req") return;
            if (req.op === "tool.call" && req.params?.name === "__list_tools") {
              listedAt = Date.now();
              writeNdjson(sock, {
                kind: "res",
                id: req.id,
                ok: true,
                result: [{ name: "return_task", description: "Return task", inputSchema: { type: "object" } }],
              });
              return;
            }
            writeNdjson(sock, { kind: "res", id: req.id, ok: true, result: { ok: true } });
          },
          onError() {},
          onEnd() {},
        });
      });

      const prevCeiling = process.env.PI_HARNESS_TOOLS_CEILING_MS;
      if (opts.ceilingMs !== undefined) {
        process.env.PI_HARNESS_TOOLS_CEILING_MS = String(opts.ceilingMs);
      }
      await new Promise<void>((r) => server.listen(socketPath, r));
      try {
        const runner = new AcpRunner(
          makeProfile({
            id: `acp:fake-${mode}`,
            adapter: "generic",
            command: process.execPath,
            args: [fakeAgentPath],
            env: {
              FAKE_DIR: dir,
              FAKE_ACP_LIST_TOOLS: mode,
              ...(opts.promptDelayMs && opts.promptDelayMs > 0 ? { FAKE_ACP_PROMPT_DELAY_MS: String(opts.promptDelayMs) } : {}),
              ...(opts.listDelayMs && opts.listDelayMs > 0 ? { FAKE_ACP_LIST_DELAY_MS: String(opts.listDelayMs) } : {}),
            },
          }),
        );
        return await runner.run(
          makeRequest({
            model: "fake-model",
            daemonSocketPath: socketPath,
            mcpBridgeEntrypoint: mcpBridgePath,
            harnessToolsListedSince: (sinceMs) => listedAt >= sinceMs,
            harnessToolsGraceMs: opts.graceMs ?? 1_200,
            missingReturnWrapUpPrompt: opts.missingReturnWrapUpPrompt,
          }),
        );
      } finally {
        if (opts.ceilingMs !== undefined) {
          if (prevCeiling === undefined) delete process.env.PI_HARNESS_TOOLS_CEILING_MS;
          else process.env.PI_HARNESS_TOOLS_CEILING_MS = prevCeiling;
        }
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(dir, { recursive: true, force: true });
      }
    }

    // eager: lists during session/new -> completes cleanly
    const eagerRes = await runFakeAgentMode("eager");
    assert.equal(eagerRes.stopReason, "completed");

    // on_prompt: lists after grace expires during a longer turn -> no cancel, completes cleanly
    const onPromptRes = await runFakeAgentMode("on_prompt", {
      graceMs: 100,
      listDelayMs: 250,
      promptDelayMs: 400,
    });
    assert.equal(onPromptRes.stopReason, "completed");

    // on_wrap_up: turn 1 answers quickly without listing, wrap-up prompt triggers list -> completes cleanly
    const onWrapUpRes = await runFakeAgentMode("on_wrap_up", {
      graceMs: 100,
      promptDelayMs: 10,
      missingReturnWrapUpPrompt: "Please call return_task",
    });
    assert.equal(onWrapUpRes.stopReason, "completed");

    // never (delayed): ceiling expires -> cancels and fails tools_missing naming the profile
    let caughtDelayed: unknown;
    try {
      await runFakeAgentMode("never", {
        promptDelayMs: 5_000,
        graceMs: 200,
        ceilingMs: 800,
      });
    } catch (err) {
      caughtDelayed = err;
    }
    assert.ok(caughtDelayed instanceof AcpProfileError, `expected AcpProfileError, got ${String(caughtDelayed)}`);
    assert.equal(caughtDelayed.kind, "tools_missing");
    assert.equal(caughtDelayed.profileId, "acp:fake-never");
    assert.match(caughtDelayed.message, /acp:fake-never/);

    // never (fast end_turn with wrap-up): both turn 1 and wrap-up end without listing -> fails tools_missing
    let caughtFast: unknown;
    try {
      await runFakeAgentMode("never", {
        promptDelayMs: 0,
        graceMs: 1_200,
        missingReturnWrapUpPrompt: "Please call return_task",
      });
    } catch (err) {
      caughtFast = err;
    }
    assert.ok(caughtFast instanceof AcpProfileError, `expected AcpProfileError, got ${String(caughtFast)}`);
    assert.equal(caughtFast.kind, "tools_missing");
    assert.equal(caughtFast.profileId, "acp:fake-never");
    assert.match(caughtFast.message, /acp:fake-never/);
  }, 30_000);
});
