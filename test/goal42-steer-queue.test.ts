import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { contextWarningText } from "../src/advisories/message.js";
import type { AcpProfileConfig } from "../src/config.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import type { RunnerExecutionHandle } from "../src/runners/types.js";

const AMP_PROFILE: AcpProfileConfig = {
  id: "acp:amp",
  kind: "acp",
  adapter: "generic",
  command: "npx",
  args: ["-y", "amp-acp"],
  billing: "subscription",
};

async function withUnsetEnv<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = process.env[key];
  delete process.env[key];
  try {
    return await fn();
  } finally {
    if (prev !== undefined) process.env[key] = prev;
  }
}

describe("goal-42: Amp ACP steer queueing, default off, and explicit cancel", () => {
  it("(a) never sends session/cancel for steers while a tool call is in flight even with AMP_ACP_CANCEL_MODE=steer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-inflight-"));
    try {
      const seenPrompts: string[] = [];
      let cancelCount = 0;
      const toolStarted = Promise.withResolvers<void>();
      const releaseTool = Promise.withResolvers<void>();
      const harnessQueue: string[] = [];

      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-inflight",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCount += 1;
        })
        .onRequest("session/prompt", async ({ params, client: acpClient }) => {
          const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
          seenPrompts.push(text);
          if (seenPrompts.length === 1) {
            await acpClient.notify("session/update", {
              sessionId: "S-g42-inflight",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-code-exec-1",
                title: "code_exec",
                status: "in_progress",
              },
            } as never);
            toolStarted.resolve();
            await releaseTool.promise;
            await acpClient.notify("session/update", {
              sessionId: "S-g42-inflight",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tc-code-exec-1",
                status: "completed",
                rawOutput: { ok: true },
              },
            } as never);
            return { stopReason: "end_turn" } as never;
          }
          await acpClient.notify("session/update", {
            sessionId: "S-g42-inflight",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "queued-steer-received" } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      let handle: RunnerExecutionHandle | undefined;
      const runner = new AcpRunner(AMP_PROFILE);
      const runPromise = runner.run(
        {
          runId: "r-g42-inflight",
          taskId: "t-g42-inflight",
          tier: 1,
          kind: "orchestrator",
          cwd,
          toolPolicy: "control_plane_only",
          systemPrompt: "Orchestrator",
          initialPrompt: "Run wait_timer inside code_exec",
          model: "anthropic/claude-opus-5-5",
          extraEnv: { AMP_ACP_CANCEL_MODE: "steer" },
          tools: [],
          executeTool: async () => ({}),
          drainPendingSteers: () => harnessQueue.splice(0),
          signal: new AbortController().signal,
          onHandle: (h) => {
            handle = h;
          },
          callbacks: {},
        },
        fakeAmp,
      );

      await toolStarted.promise;
      assert.ok(handle, "expected runner handle");

      // Steer arrives while code_exec is in flight: must NOT send session/cancel and must report false so orchestrator queues it.
      const nativeDelivered = await handle.steer("Goal amended while tool call in flight");
      assert.equal(nativeDelivered, false, "steer during in-flight tool call must not deliver natively");
      assert.equal(cancelCount, 0, "steer during in-flight tool call must send zero session/cancel notifications");

      // Orchestrator queues the steer; when turn 1 completes, runner drains and delivers it on turn 2.
      harnessQueue.push("Goal amended while tool call in flight");
      releaseTool.resolve();

      const res = await runPromise;
      assert.equal(res.stopReason, "completed");
      assert.equal(cancelCount, 0, "no session/cancel should ever have been sent");
      assert.equal(seenPrompts.length, 2, "queued steer should run as turn 2");
      assert.ok(seenPrompts[1]?.includes("Goal amended while tool call in flight"));
      assert.ok(res.text.includes("queued-steer-received"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("(a) also blocks soft rollover cancel-steer while a tool call is in flight", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-rollover-inflight-"));
    try {
      const seenPrompts: string[] = [];
      let cancelCount = 0;

      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-rollover",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCount += 1;
        })
        .onRequest("session/prompt", async ({ params, client: acpClient }) => {
          const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
          seenPrompts.push(text);
          if (seenPrompts.length === 1) {
            await acpClient.notify("session/update", {
              sessionId: "S-g42-rollover",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-rollover-1",
                title: "code_exec",
                status: "in_progress",
              },
            } as never);
            await acpClient.notify("session/update", {
              sessionId: "S-g42-rollover",
              update: { sessionUpdate: "usage_update", used: 70_000, size: 100_000 },
            } as never);
            await Bun.sleep(25);
            await acpClient.notify("session/update", {
              sessionId: "S-g42-rollover",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tc-rollover-1",
                status: "completed",
                rawOutput: { ok: true },
              },
            } as never);
            return { stopReason: "end_turn" } as never;
          }
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(AMP_PROFILE);
      const res = await runner.run(
        {
          runId: "r-g42-rollover",
          taskId: "t-g42-rollover",
          tier: 1,
          kind: "orchestrator",
          cwd,
          toolPolicy: "control_plane_only",
          systemPrompt: "Orchestrator",
          initialPrompt: "Work",
          model: "anthropic/claude-opus-5-5",
          contextWindow: 100_000,
          rolloverThreshold: 0.78,
          extraEnv: { AMP_ACP_CANCEL_MODE: "steer" },
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fakeAmp,
      );

      assert.equal(res.stopReason, "completed");
      assert.equal(cancelCount, 0, "soft rollover warning during in-flight tool call must not send session/cancel");
      assert.equal(seenPrompts.length, 2, "queued soft rollover warning must be delivered on next turn");
      assert.equal(seenPrompts[1], contextWarningText(1, 70, 78));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("(d) explicit handle.cancel and signal abort still send session/cancel promptly even with a tool in flight", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-explicit-cancel-"));
    try {
      await withUnsetEnv("AMP_ACP_CANCEL_MODE", async () => {
        const runExplicitCancel = async (mode: "handle_cancel" | "signal_abort") => {
          let cancelCount = 0;
          let resolveTurn1!: (res: { stopReason: string }) => void;
          const toolStarted = Promise.withResolvers<void>();
          const cancelSeen = Promise.withResolvers<void>();

          const fakeAmp = agent()
            .onRequest("initialize", async () => ({
              protocolVersion: 1,
              agentInfo: { name: "amp-acp", version: "0.12.0" },
              agentCapabilities: { sessionCapabilities: {} },
            } as never))
            .onRequest("session/new", async () => ({
              sessionId: `S-g42-cancel-${mode}`,
              models: {
                currentModelId: "anthropic/claude-opus-5-5",
                availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
              },
            } as never))
            .onNotification("session/cancel", async () => {
              cancelCount += 1;
              cancelSeen.resolve();
              resolveTurn1?.({ stopReason: "cancelled" });
            })
            .onRequest("session/prompt", async ({ client: acpClient }) => {
              await acpClient.notify("session/update", {
                sessionId: `S-g42-cancel-${mode}`,
                update: {
                  sessionUpdate: "tool_call",
                  toolCallId: "tc-long-wait",
                  title: "wait_timer",
                  status: "in_progress",
                },
              } as never);
              toolStarted.resolve();
              return (await new Promise<{ stopReason: string }>((r) => {
                resolveTurn1 = r;
              })) as never;
            });

          const ac = new AbortController();
          let handle: RunnerExecutionHandle | undefined;
          const runner = new AcpRunner(AMP_PROFILE);
          const runPromise = runner.run(
            {
              runId: `r-g42-cancel-${mode}`,
              taskId: `t-g42-cancel-${mode}`,
              tier: 2,
              kind: "worker",
              cwd,
              toolPolicy: "read_write_workspace",
              systemPrompt: "Worker",
              initialPrompt: "Wait forever",
              model: "anthropic/claude-opus-5-5",
              tools: [],
              executeTool: async () => ({}),
              signal: ac.signal,
              onHandle: (h) => {
                handle = h;
              },
              callbacks: {},
            },
            fakeAmp,
          );

          await toolStarted.promise;
          assert.ok(handle);

          const t0 = Date.now();
          if (mode === "handle_cancel") {
            await handle.cancel("user");
          } else {
            ac.abort(new Error("user stopped task"));
          }
          await cancelSeen.promise;
          const res = await runPromise;
          const elapsedMs = Date.now() - t0;

          assert.equal(cancelCount, 1, `explicit ${mode} must send session/cancel immediately`);
          assert.equal(res.stopReason, "cancelled");
          assert.equal(res.errorCode, undefined, "explicit cancel must not be tagged as acp_executor_lost");
          assert.ok(elapsedMs < 2000, `explicit ${mode} should settle promptly, took ${elapsedMs}ms`);
        };

        await runExplicitCancel("handle_cancel");
        await runExplicitCancel("signal_abort");
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("(e) defaults AMP_ACP_CANCEL_MODE to off (queued delivery without session/cancel)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-default-off-"));
    try {
      await withUnsetEnv("AMP_ACP_CANCEL_MODE", async () => {
        const seenPrompts: string[] = [];
        let cancelCount = 0;
        let finishTurn1!: (res: { stopReason: string }) => void;
        const turn1Ready = Promise.withResolvers<void>();
        const harnessQueue: string[] = [];

        const fakeAmp = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: "S-g42-default-off",
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            cancelCount += 1;
            finishTurn1?.({ stopReason: "cancelled" });
          })
          .onRequest("session/prompt", async ({ params }) => {
            const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
            seenPrompts.push(text);
            if (seenPrompts.length === 1) {
              turn1Ready.resolve();
              return (await new Promise<{ stopReason: string }>((r) => {
                finishTurn1 = r;
              })) as never;
            }
            return { stopReason: "end_turn" } as never;
          });

        let handle: RunnerExecutionHandle | undefined;
        const runner = new AcpRunner(AMP_PROFILE);
        const runPromise = runner.run(
          {
            runId: "r-g42-default-off",
            taskId: "t-g42-default-off",
            tier: 2,
            kind: "worker",
            cwd,
            toolPolicy: "read_write_workspace",
            systemPrompt: "Worker",
            initialPrompt: "Initial turn with no tool call",
            model: "anthropic/claude-opus-5-5",
            tools: [],
            executeTool: async () => ({}),
            drainPendingSteers: () => harnessQueue.splice(0),
            signal: new AbortController().signal,
            onHandle: (h) => {
              handle = h;
            },
            callbacks: {},
          },
          fakeAmp,
        );

        await turn1Ready.promise;
        assert.ok(handle);

        // Even with NO tool call in flight, default AMP_ACP_CANCEL_MODE is off -> steer returns false and sends no session/cancel.
        const nativeDelivered = await handle.steer("Queued steer under default off mode");
        assert.equal(nativeDelivered, false, "default AMP_ACP_CANCEL_MODE=off must return false from handle.steer");
        assert.equal(cancelCount, 0, "default AMP_ACP_CANCEL_MODE=off must send zero session/cancel notifications");

        harnessQueue.push("Queued steer under default off mode");
        finishTurn1({ stopReason: "end_turn" });

        const res = await runPromise;
        assert.equal(res.stopReason, "completed");
        assert.equal(cancelCount, 0);
        assert.equal(seenPrompts.length, 2);
        assert.ok(seenPrompts[1]?.includes("Queued steer under default off mode"));
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("P1-2: defers steer ack-timeout cancel while replacement prompt has an in-flight tool call", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-p1-2-"));
    try {
      const seenPrompts: string[] = [];
      let cancelCount = 0;
      let resolveTurn1!: (res: { stopReason: string }) => void;
      const turn1Ready = Promise.withResolvers<void>();
      const replToolStarted = Promise.withResolvers<void>();
      const releaseReplTool = Promise.withResolvers<void>();

      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-p1-2",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCount += 1;
          // Hold turn 1 open on cancel #1 so replacement prompt starts code_exec before prior prompt settles.
          if (cancelCount >= 2) {
            resolveTurn1?.({ stopReason: "cancelled" });
            releaseReplTool.resolve();
          }
        })
        .onRequest("session/prompt", async ({ params, client: acpClient }) => {
          const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
          seenPrompts.push(text);
          if (seenPrompts.length === 1) {
            turn1Ready.resolve();
            return (await new Promise<{ stopReason: string }>((r) => {
              resolveTurn1 = r;
            })) as never;
          }
          // Replacement starts code_exec before turn 1 settles and without echoing user_message_chunk.
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-2",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tc-p1-2-code-exec",
              title: "code_exec",
              status: "in_progress",
            },
          } as never);
          replToolStarted.resolve();
          await releaseReplTool.promise;
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-2",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-p1-2-code-exec",
              status: "completed",
              rawOutput: { ok: true },
            },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-2",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "p1-2-done" } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      let handle: RunnerExecutionHandle | undefined;
      const runner = new AcpRunner(AMP_PROFILE, { steerAckTimeoutMs: 60 });
      const runPromise = runner.run(
        {
          runId: "r-g42-p1-2",
          taskId: "t-g42-p1-2",
          tier: 1,
          kind: "orchestrator",
          cwd,
          toolPolicy: "control_plane_only",
          systemPrompt: "Orchestrator",
          initialPrompt: "Idle turn",
          model: "anthropic/claude-opus-5-5",
          extraEnv: { AMP_ACP_CANCEL_MODE: "steer" },
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          onHandle: (h) => {
            handle = h;
          },
          callbacks: {},
        },
        fakeAmp,
      );

      await turn1Ready.promise;
      assert.ok(handle);

      let steerSettled = false;
      const steerPromise = handle.steer("Steer while idle").then((v) => {
        steerSettled = true;
        return v;
      });

      await replToolStarted.promise;
      // Wait well past steerAckTimeoutMs (60ms) while code_exec is still running.
      await Bun.sleep(130);
      assert.equal(cancelCount, 1, "ack timeout must not send a second session/cancel while code_exec is in flight");
      assert.equal(steerSettled, false, "ack timeout fallback must be deferred while code_exec is in flight");

      // Now prior turn settles and replacement code_exec finishes cleanly.
      resolveTurn1({ stopReason: "cancelled" });
      await Bun.sleep(20);
      releaseReplTool.resolve();

      const live = await steerPromise;
      const res = await runPromise;
      assert.equal(live, true);
      assert.equal(cancelCount, 1, "no second session/cancel should be sent");
      assert.equal(res.stopReason, "completed");
      assert.ok(res.text.includes("p1-2-done"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("P1-3: preserves replacement in-flight tool IDs across old-prompt settlement so a second steer does not cancel it", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-p1-3-"));
    try {
      const seenPrompts: string[] = [];
      let cancelCount = 0;
      let resolveTurn1!: (res: { stopReason: string }) => void;
      const turn1Ready = Promise.withResolvers<void>();
      const releaseReplTool = Promise.withResolvers<void>();
      const harnessQueue: string[] = [];

      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-p1-3",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCount += 1;
          if (cancelCount >= 2) {
            releaseReplTool.resolve();
          }
        })
        .onRequest("session/prompt", async ({ params, client: acpClient }) => {
          const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
          seenPrompts.push(text);
          if (seenPrompts.length === 1) {
            turn1Ready.resolve();
            return (await new Promise<{ stopReason: string }>((r) => {
              resolveTurn1 = r;
            })) as never;
          }
          if (seenPrompts.length === 2) {
            // Replacement starts code_exec and echoes steer BEFORE old turn 1 settles.
            await acpClient.notify("session/update", {
              sessionId: "S-g42-p1-3",
              update: {
                sessionUpdate: "tool_call",
                toolCallId: "tc-p1-3-repl-tool",
                title: "code_exec",
                status: "in_progress",
              },
            } as never);
            await acpClient.notify("session/update", {
              sessionId: "S-g42-p1-3",
              update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
            } as never);
            await releaseReplTool.promise;
            await acpClient.notify("session/update", {
              sessionId: "S-g42-p1-3",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tc-p1-3-repl-tool",
                status: "completed",
                rawOutput: { ok: true },
              },
            } as never);
            return { stopReason: "end_turn" } as never;
          }
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-3",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second-steer-queued-ok" } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      let handle: RunnerExecutionHandle | undefined;
      const runner = new AcpRunner(AMP_PROFILE);
      const runPromise = runner.run(
        {
          runId: "r-g42-p1-3",
          taskId: "t-g42-p1-3",
          tier: 1,
          kind: "orchestrator",
          cwd,
          toolPolicy: "control_plane_only",
          systemPrompt: "Orchestrator",
          initialPrompt: "Idle turn",
          model: "anthropic/claude-opus-5-5",
          extraEnv: { AMP_ACP_CANCEL_MODE: "steer" },
          tools: [],
          executeTool: async () => ({}),
          drainPendingSteers: () => harnessQueue.splice(0),
          signal: new AbortController().signal,
          onHandle: (h) => {
            handle = h;
          },
          callbacks: {},
        },
        fakeAmp,
      );

      await turn1Ready.promise;
      assert.ok(handle);

      // First steer starts while idle; replacement starts code_exec and acks via echo before turn 1 settles.
      const firstLive = await handle.steer("FIRST_STEER");
      assert.equal(firstLive, true);
      assert.equal(cancelCount, 1);

      // Now old prompt 1 settles while replacement's code_exec is still running.
      resolveTurn1({ stopReason: "cancelled" });
      await Bun.sleep(25);

      // A second steer arriving now MUST see tc-p1-3-repl-tool still in flight and refuse native cancel-steer.
      const secondLive = await handle.steer("SECOND_STEER");
      assert.equal(secondLive, false, "second steer while replacement tool is in flight must return false");
      assert.equal(cancelCount, 1, "second steer must not send session/cancel while replacement tool is in flight");

      harnessQueue.push("SECOND_STEER");
      releaseReplTool.resolve();

      const res = await runPromise;
      assert.equal(res.stopReason, "completed");
      assert.equal(cancelCount, 1);
      assert.equal(seenPrompts.length, 3);
      assert.ok(seenPrompts[2]?.includes("SECOND_STEER"));
      assert.ok(res.text.includes("second-steer-queued-ok"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("P2-1: status-less tool_call_update after completion preserves terminal state and does not block subsequent steer", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-p2-1-"));
    try {
      const seenPrompts: string[] = [];
      const toolEvents: Array<{ id?: string; status?: string }> = [];
      let cancelCount = 0;
      let resolveTurn1!: (res: { stopReason: string }) => void;
      const metaUpdateSent = Promise.withResolvers<void>();

      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-p2-1",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          cancelCount += 1;
          resolveTurn1?.({ stopReason: "cancelled" });
        })
        .onRequest("session/prompt", async ({ params, client: acpClient }) => {
          const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
          seenPrompts.push(text);
          if (seenPrompts.length === 1) {
            await acpClient.notify("session/update", {
              sessionId: "S-g42-p2-1",
              update: { sessionUpdate: "tool_call", toolCallId: "tc-meta-1", title: "Read", status: "in_progress" },
            } as never);
            await acpClient.notify("session/update", {
              sessionId: "S-g42-p2-1",
              update: { sessionUpdate: "tool_call_update", toolCallId: "tc-meta-1", status: "completed", rawOutput: "ok" },
            } as never);
            // Status-less metadata-only update (locations only) after completion must NOT resurrect tc-meta-1 as in_progress.
            await acpClient.notify("session/update", {
              sessionId: "S-g42-p2-1",
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: "tc-meta-1",
                locations: [{ path: join(cwd, "README.md") }],
              },
            } as never);
            metaUpdateSent.resolve();
            return (await new Promise<{ stopReason: string }>((r) => {
              resolveTurn1 = r;
            })) as never;
          }
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p2-1",
            update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      let handle: RunnerExecutionHandle | undefined;
      const runner = new AcpRunner(AMP_PROFILE);
      const runPromise = runner.run(
        {
          runId: "r-g42-p2-1",
          taskId: "t-g42-p2-1",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Read file",
          model: "anthropic/claude-opus-5-5",
          extraEnv: { AMP_ACP_CANCEL_MODE: "steer" },
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          onHandle: (h) => {
            handle = h;
          },
          callbacks: {
            onToolEvent: (ev) => {
              toolEvents.push({ id: ev.id, status: ev.status });
            },
          },
        },
        fakeAmp,
      );

      await metaUpdateSent.promise;
      await Bun.sleep(20);
      assert.ok(handle);

      const metaEvent = toolEvents[2];
      assert.equal(metaEvent?.id, "tc-meta-1");
      assert.equal(metaEvent?.status, "completed", "status-less metadata update after completion must preserve completed status");

      const live = await handle.steer("Steer after completed tool metadata update");
      assert.equal(live, true, "native steer must not be blocked by a metadata-only update on an already-completed tool");
      assert.equal(cancelCount, 1);

      const res = await runPromise;
      assert.equal(res.stopReason, "completed");
      assert.equal(seenPrompts.length, 2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
