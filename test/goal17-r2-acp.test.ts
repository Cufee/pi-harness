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

describe("goal-17 r2 ACP: correlated steer receipt and Amp soft rollover warning", () => {
  it("Item 2: adapter-generated agent_message_chunk or tool_call_update before pre-model rejection is not live", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g17-r2-item2-notice-"));
    try {
      // Case A: replacement emits adapter notice ('MCP server unavailable') as agent_message_chunk
      // after turn 1 settles, then rejects before a model runs -> steer must return false.
      {
        let resolveTurn1!: (res: { stopReason: string }) => void;
        const turn1Ready = Promise.withResolvers<void>();
        let promptCalls = 0;

        const noticeRejectAgent = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: "S-r2-notice-reject",
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            resolveTurn1?.({ stopReason: "cancelled" });
          })
          .onRequest("session/prompt", async ({ client: acpClient }) => {
            promptCalls += 1;
            if (promptCalls === 1) {
              turn1Ready.resolve();
              return (await new Promise<{ stopReason: string }>((r) => {
                resolveTurn1 = r;
              })) as never;
            }
            // Wait a tick so turn 1 has fully settled (priorTurnSettled = true) before the adapter notice arrives.
            await Bun.sleep(15);
            await acpClient.notify("session/update", {
              sessionId: "S-r2-notice-reject",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "MCP server unavailable" },
              },
            } as never);
            await Bun.sleep(15);
            throw new Error("pre-model prompt rejection");
          });

        let handle: RunnerExecutionHandle | undefined;
        const runner = new AcpRunner(AMP_PROFILE);
        const runPromise = runner.run(
          {
            runId: "r-r2-notice",
            taskId: "t-r2-notice",
            tier: 2,
            kind: "worker",
            cwd,
            toolPolicy: "read_write_workspace",
            systemPrompt: "Worker",
            initialPrompt: "Initial work",
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
          noticeRejectAgent,
        );
        runPromise.catch(() => {});

        await turn1Ready.promise;
        assert.ok(handle);
        const live = await handle.steer("STOP: goal amended to v2");
        assert.equal(live, false, "adapter-generated agent_message_chunk followed by rejection must not ack live");
        await assert.rejects(runPromise, /pre-model prompt rejection/);
      }

      // Case B: late tool_call_update after turn 1 settles followed by rejection must not ack live.
      {
        let resolveTurn1!: (res: { stopReason: string }) => void;
        const turn1Ready = Promise.withResolvers<void>();
        let promptCalls = 0;

        const toolUpdateRejectAgent = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: "S-r2-tc-update",
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            resolveTurn1?.({ stopReason: "cancelled" });
          })
          .onRequest("session/prompt", async ({ client: acpClient }) => {
            promptCalls += 1;
            if (promptCalls === 1) {
              await acpClient.notify("session/update", {
                sessionId: "S-r2-tc-update",
                update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "shell", status: "in_progress" },
              } as never);
              await acpClient.notify("session/update", {
                sessionId: "S-r2-tc-update",
                update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" },
              } as never);
              turn1Ready.resolve();
              return (await new Promise<{ stopReason: string }>((r) => {
                resolveTurn1 = r;
              })) as never;
            }
            await Bun.sleep(15);
            await acpClient.notify("session/update", {
              sessionId: "S-r2-tc-update",
              update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "failed" },
            } as never);
            await Bun.sleep(15);
            throw new Error("rejected after stale tool_call_update");
          });

        let handle: RunnerExecutionHandle | undefined;
        const runner = new AcpRunner(AMP_PROFILE);
        const runPromise = runner.run(
          {
            runId: "r-r2-tc",
            taskId: "t-r2-tc",
            tier: 2,
            kind: "worker",
            cwd,
            toolPolicy: "read_write_workspace",
            systemPrompt: "Worker",
            initialPrompt: "Initial work",
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
          toolUpdateRejectAgent,
        );
        runPromise.catch(() => {});

        await turn1Ready.promise;
        assert.ok(handle);
        const live = await handle.steer("STOP: goal amended to v2");
        assert.equal(live, false, "tool_call_update followed by rejection must not ack live");
        await assert.rejects(runPromise, /rejected after stale tool_call_update/);
      }

      // Case C: MCP notice alone does not settle steer, then matched user_message_chunk confirms live=true mid-turn.
      {
        let resolveTurn1!: (res: { stopReason: string }) => void;
        const turn1Ready = Promise.withResolvers<void>();
        const noticeSent = Promise.withResolvers<void>();
        const allowEcho = Promise.withResolvers<void>();
        const releaseTurn2 = Promise.withResolvers<void>();
        let promptCalls = 0;

        const noticeThenEchoAgent = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: "S-r2-notice-echo",
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            resolveTurn1?.({ stopReason: "cancelled" });
          })
          .onRequest("session/prompt", async ({ params, client: acpClient }) => {
            promptCalls += 1;
            const text = ((params as { prompt?: Array<{ text?: string }> }).prompt ?? []).map((b) => b.text ?? "").join("");
            if (promptCalls === 1) {
              turn1Ready.resolve();
              return (await new Promise<{ stopReason: string }>((r) => {
                resolveTurn1 = r;
              })) as never;
            }
            await Bun.sleep(15);
            await acpClient.notify("session/update", {
              sessionId: "S-r2-notice-echo",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "MCP server unavailable" },
              },
            } as never);
            noticeSent.resolve();
            await allowEcho.promise;
            await acpClient.notify("session/update", {
              sessionId: "S-r2-notice-echo",
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text },
              },
            } as never);
            await releaseTurn2.promise;
            return { stopReason: "end_turn" } as never;
          });

        let handle: RunnerExecutionHandle | undefined;
        const runner = new AcpRunner(AMP_PROFILE);
        const runPromise = runner.run(
          {
            runId: "r-r2-notice-echo",
            taskId: "t-r2-notice-echo",
            tier: 2,
            kind: "worker",
            cwd,
            toolPolicy: "read_write_workspace",
            systemPrompt: "Worker",
            initialPrompt: "Initial work",
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
          noticeThenEchoAgent,
        );

        await turn1Ready.promise;
        assert.ok(handle);
        let steerSettled = false;
        const steerPromise = handle.steer("STOP: goal amended to v3").then((v) => {
          steerSettled = true;
          return v;
        });

        await noticeSent.promise;
        await Bun.sleep(25);
        assert.equal(steerSettled, false, "steer must remain pending after adapter-generated agent_message_chunk");

        allowEcho.resolve();
        const live = await steerPromise;
        assert.equal(live, true, "matched user_message_chunk echo should confirm live delivery");

        releaseTurn2.resolve();
        const res = await runPromise;
        assert.equal(res.stopReason, "completed");
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Item 2: replacement prompt with missing or unknown stopReason never defaults to live=true", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g17-r2-item2-stop-"));
    try {
      const runWithReplacementResponse = async (
        turn2Response: Record<string, unknown>,
        opts?: { emitNotice?: boolean },
      ) => {
        let resolveTurn1!: (res: { stopReason: string }) => void;
        const turn1Ready = Promise.withResolvers<void>();
        let promptCalls = 0;

        const stopAgent = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: "S-r2-stop",
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            resolveTurn1?.({ stopReason: "cancelled" });
          })
          .onRequest("session/prompt", async ({ client: acpClient }) => {
            promptCalls += 1;
            if (promptCalls === 1) {
              turn1Ready.resolve();
              return (await new Promise<{ stopReason: string }>((r) => {
                resolveTurn1 = r;
              })) as never;
            }
            if (opts?.emitNotice) {
              await Bun.sleep(15);
              await acpClient.notify("session/update", {
                sessionId: "S-r2-stop",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: "MCP server unavailable" },
                },
              } as never);
            }
            return turn2Response as never;
          });

        let handle: RunnerExecutionHandle | undefined;
        const runner = new AcpRunner(AMP_PROFILE);
        const runPromise = runner.run(
          {
            runId: "r-r2-stop",
            taskId: "t-r2-stop",
            tier: 2,
            kind: "worker",
            cwd,
            toolPolicy: "read_write_workspace",
            systemPrompt: "Worker",
            initialPrompt: "Initial work",
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
          stopAgent,
        );

        await turn1Ready.promise;
        assert.ok(handle);
        const live = await handle.steer("STOP: goal amended to v2");
        await runPromise;
        return live;
      };

      assert.equal(
        await runWithReplacementResponse({}),
        false,
        "missing stopReason must not default to end_turn / live=true",
      );
      assert.equal(
        await runWithReplacementResponse({ stopReason: "unknown_status" }, { emitNotice: true }),
        false,
        "unknown stopReason must not settle steer as live=true",
      );
      assert.equal(
        await runWithReplacementResponse({ stopReason: "error" }),
        false,
        "error stopReason must not settle steer as live=true",
      );
      assert.equal(
        await runWithReplacementResponse({ stopReason: "end_turn" }),
        true,
        "explicit allowlisted stopReason end_turn confirms live delivery",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("Item 5: restores Amp T1/T2 soft rollover warning without probing _amp/session/steer (local CLI and non-cancel fallback)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g17-r2-item5-rollover-"));
    try {
      const runAmpSoftWarning = async (opts: {
        tier: 1 | 2 | 3;
        kind: "orchestrator" | "worker" | "research";
        extraEnv?: Record<string, string>;
        settledBeforeTurnEnd?: boolean;
      }) => {
        const seenPrompts: string[] = [];
        let cancelCount = 0;
        let ampSteerRpcCalls = 0;
        let resolveTurn1!: (res: { stopReason: string }) => void;
        let settled = false;

        const fakeAmpAgent = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: `S-r2-warn-t${opts.tier}`,
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
              // Emit 70% usage (>= soft warn 66%, < hard rollover 78%), then a second 72% usage to verify dedupe.
              await acpClient.notify("session/update", {
                sessionId: `S-r2-warn-t${opts.tier}`,
                update: { sessionUpdate: "usage_update", used: 70_000, size: 100_000 },
              } as never);
              await acpClient.notify("session/update", {
                sessionId: `S-r2-warn-t${opts.tier}`,
                update: { sessionUpdate: "usage_update", used: 72_000, size: 100_000 },
              } as never);
              return (await new Promise<{ stopReason: string }>((r) => {
                resolveTurn1 = r;
                // On non-cancel modes (or Tier 3), turn 1 finishes naturally shortly after usage_update.
                setTimeout(() => {
                  if (opts.settledBeforeTurnEnd) settled = true;
                  r({ stopReason: "end_turn" });
                }, 40);
              })) as never;
            }
            await acpClient.notify("session/update", {
              sessionId: `S-r2-warn-t${opts.tier}`,
              update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "warning-received" } },
            } as never);
            return { stopReason: "end_turn" } as never;
          })
          .onRequest("*", async ({ method }) => {
            if (method === "_amp/session/steer") {
              ampSteerRpcCalls += 1;
              return { outcome: "queued" } as never;
            }
            throw new Error(`Unexpected method ${method}`);
          });

        const runner = new AcpRunner(AMP_PROFILE);
        const res = await runner.run(
          {
            runId: `r-r2-warn-t${opts.tier}`,
            taskId: `t-r2-warn-t${opts.tier}`,
            tier: opts.tier,
            kind: opts.kind,
            cwd,
            toolPolicy: opts.tier === 2 ? "read_write_workspace" : "read_only_workspace",
            systemPrompt: "Agent",
            initialPrompt: "Do work",
            model: "anthropic/claude-opus-5-5",
            contextWindow: 100_000,
            rolloverThreshold: 0.78,
            extraEnv: opts.extraEnv,
            tools: [],
            executeTool: async () => ({}),
            isTaskSettled: () => settled,
            signal: new AbortController().signal,
            callbacks: {},
          },
          fakeAmpAgent,
        );
        return { res, seenPrompts, cancelCount, ampSteerRpcCalls };
      };

      // Case A: Local CLI Amp T2 worker with explicit AMP_ACP_CANCEL_MODE=steer delivers soft rollover warning mid-turn via cancel-then-prompt, never _amp/session/steer.
      const t2Local = await runAmpSoftWarning({
        tier: 2,
        kind: "worker",
        extraEnv: { AMP_ACP_CANCEL_MODE: "steer" },
      });
      assert.equal(t2Local.res.stopReason, "completed");
      assert.equal(t2Local.ampSteerRpcCalls, 0, "must never probe mutating _amp/session/steer");
      assert.equal(t2Local.cancelCount, 1, "local CLI Amp with AMP_ACP_CANCEL_MODE=steer should deliver soft warning via cancel-then-prompt steer");
      assert.equal(t2Local.seenPrompts.length, 2, "warning should fire exactly once");
      assert.equal(t2Local.seenPrompts[1], contextWarningText(2, 70, 78));

      // Case B: Local CLI Amp T1 orchestrator with explicit AMP_ACP_CANCEL_MODE=steer delivers T1 soft rollover warning without _amp/session/steer.
      const t1Local = await runAmpSoftWarning({
        tier: 1,
        kind: "orchestrator",
        extraEnv: { AMP_ACP_CANCEL_MODE: "steer" },
      });
      assert.equal(t1Local.res.stopReason, "completed");
      assert.equal(t1Local.ampSteerRpcCalls, 0, "must never probe mutating _amp/session/steer");
      assert.equal(t1Local.cancelCount, 1);
      assert.equal(t1Local.seenPrompts.length, 2);
      assert.equal(t1Local.seenPrompts[1], contextWarningText(1, 70, 78));

      // Case C: Non-cancel Amp mode (Orb / SDK / kill) delivers soft rollover warning on next-turn continuation without cancel or _amp/session/steer.
      const t2Orb = await runAmpSoftWarning({
        tier: 2,
        kind: "worker",
        extraEnv: { AMP_ACP_EXECUTOR: "orb" },
      });
      assert.equal(t2Orb.res.stopReason, "completed");
      assert.equal(t2Orb.ampSteerRpcCalls, 0, "must never probe mutating _amp/session/steer on orb");
      assert.equal(t2Orb.cancelCount, 0, "orb executor must not invoke CLI-only cancel-then-prompt");
      assert.equal(t2Orb.seenPrompts.length, 2, "queued soft warning should deliver on next-turn continuation");
      assert.equal(t2Orb.seenPrompts[1], contextWarningText(2, 70, 78));

      // Case D: Settled task on non-cancel mode does not open a spurious continuation turn for a queued warning.
      const t2OrbSettled = await runAmpSoftWarning({
        tier: 2,
        kind: "worker",
        extraEnv: { AMP_ACP_TRANSPORT: "sdk" },
        settledBeforeTurnEnd: true,
      });
      assert.equal(t2OrbSettled.res.stopReason, "completed");
      assert.equal(t2OrbSettled.ampSteerRpcCalls, 0);
      assert.equal(t2OrbSettled.cancelCount, 0);
      assert.equal(t2OrbSettled.seenPrompts.length, 1, "settled task should not reopen for soft warning");

      // Case E: Tier 3 task agents do not receive T1/T2 rollover warnings.
      const t3Control = await runAmpSoftWarning({ tier: 3, kind: "research" });
      assert.equal(t3Control.res.stopReason, "completed");
      assert.equal(t3Control.ampSteerRpcCalls, 0);
      assert.equal(t3Control.cancelCount, 0);
      assert.equal(t3Control.seenPrompts.length, 1);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
