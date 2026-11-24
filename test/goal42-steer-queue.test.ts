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
});
