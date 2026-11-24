import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import type { AcpProfileConfig } from "../src/config.js";
import * as acpRunnerMod from "../src/runners/acp-runner.js";
import * as runnerTypes from "../src/runners/types.js";

const { AcpRunner } = acpRunnerMod;
const EXPECTED_EXECUTOR_LOST_CODE = "acp_executor_lost";

const AMP_PROFILE: AcpProfileConfig = {
  id: "acp:amp",
  kind: "acp",
  adapter: "generic",
  command: "npx",
  args: ["-y", "amp-acp"],
  billing: "subscription",
};

describe("goal-42: broken ACP session detection (executor lost & unsolicited cancel)", () => {
  it("(c) marks session broken with acp_executor_lost when a tool result reports 'No executor is connected'", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-executor-lost-"));
    try {
      const cases: Array<{
        name: string;
        update: Record<string, unknown>;
      }> = [
        {
          name: "failed MCP tool_call_update with rawOutput.error",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-mcp-1",
            title: "mcp__harness__tree_view",
            status: "failed",
            rawOutput: { error: "No executor is connected to run mcp__harness__tree_view. Try again later." },
          },
        },
        {
          name: "completed MCP tool_call_update with content text",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-mcp-2",
            title: "mcp__harness__blackboard_get",
            status: "completed",
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "No executor is connected to run mcp__harness__blackboard_get. Try again later.",
                },
              },
            ],
          },
        },
        {
          name: "code_exec failure with stack trace containing Uncaught Error: No executor is connected",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "tc-code-exec-1",
            title: "code_exec",
            status: "failed",
            rawOutput:
              "Running step 1...\n" +
              "Uncaught Error: No executor is connected to run mcp__harness__spawn_task. Try again later.\n" +
              "    at callTool (code_exec:4:12)\n" +
              "x".repeat(600),
          },
        },
      ];

      for (const tc of cases) {
        let cancelCount = 0;
        const fakeAmp = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: `S-g42-lost-${tc.name}`,
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onNotification("session/cancel", async () => {
            cancelCount += 1;
          })
          .onRequest("session/prompt", async ({ client: acpClient }) => {
            await acpClient.notify("session/update", {
              sessionId: `S-g42-lost-${tc.name}`,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: tc.update.toolCallId,
                title: tc.update.title,
                status: "in_progress",
              },
            } as never);
            await acpClient.notify("session/update", {
              sessionId: `S-g42-lost-${tc.name}`,
              update: tc.update,
            } as never);
            // Even if the model tries to explain and finish with end_turn (like in t-497),
            // AcpRunner must classify the session as broken instead of completed.
            await acpClient.notify("session/update", {
              sessionId: `S-g42-lost-${tc.name}`,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "My tools are gone; ending turn." },
              },
            } as never);
            return { stopReason: "end_turn" } as never;
          });

        const runner = new AcpRunner(AMP_PROFILE);
        const res = await runner.run(
          {
            runId: "r-g42-lost",
            taskId: "t-g42-lost",
            tier: 1,
            kind: "orchestrator",
            cwd,
            toolPolicy: "control_plane_only",
            systemPrompt: "Orchestrator",
            initialPrompt: "Check tree",
            model: "anthropic/claude-opus-5-5",
            tools: [],
            executeTool: async () => ({}),
            signal: new AbortController().signal,
            callbacks: {},
          },
          fakeAmp,
        );

        assert.equal(res.stopReason, "error", `${tc.name}: expected stopReason='error'`);
        assert.equal(
          res.errorCode,
          EXPECTED_EXECUTOR_LOST_CODE,
          `${tc.name}: expected errorCode='${EXPECTED_EXECUTOR_LOST_CODE}'`,
        );
        assert.equal(acpRunnerMod.ACP_EXECUTOR_LOST_ERROR_CODE, EXPECTED_EXECUTOR_LOST_CODE);
        assert.equal(runnerTypes.ACP_EXECUTOR_LOST_ERROR_CODE, EXPECTED_EXECUTOR_LOST_CODE);
        assert.ok(res.text.includes("No executor is connected"), `${tc.name}: expected diagnostic detail in text`);
        assert.ok(cancelCount >= 1, `${tc.name}: expected session/cancel to terminate the broken turn`);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("(c) reports acp_executor_lost on an unsolicited 'cancelled' stopReason (including after a prior tool failure)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-unsolicited-cancel-"));
    try {
      const runUnsolicited = async (withPriorFailedTool: boolean) => {
        let promptCalls = 0;
        const fakeAmp = agent()
          .onRequest("initialize", async () => ({
            protocolVersion: 1,
            agentInfo: { name: "amp-acp", version: "0.12.0" },
            agentCapabilities: { sessionCapabilities: {} },
          } as never))
          .onRequest("session/new", async () => ({
            sessionId: `S-g42-unsolicited-${withPriorFailedTool}`,
            models: {
              currentModelId: "anthropic/claude-opus-5-5",
              availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
            },
          } as never))
          .onRequest("session/prompt", async ({ client: acpClient }) => {
            promptCalls += 1;
            if (withPriorFailedTool) {
              await acpClient.notify("session/update", {
                sessionId: `S-g42-unsolicited-${withPriorFailedTool}`,
                update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title: "shell", status: "in_progress" },
              } as never);
              await acpClient.notify("session/update", {
                sessionId: `S-g42-unsolicited-${withPriorFailedTool}`,
                update: {
                  sessionUpdate: "tool_call_update",
                  toolCallId: "tc-1",
                  status: "failed",
                  rawOutput: "ordinary failure",
                },
              } as never);
            }
            return { stopReason: "cancelled" } as never;
          });

        const runner = new AcpRunner(AMP_PROFILE);
        const res = await runner.run(
          {
            runId: "r-g42-unsolicited",
            taskId: "t-g42-unsolicited",
            tier: 1,
            kind: "orchestrator",
            cwd,
            toolPolicy: "control_plane_only",
            systemPrompt: "Orchestrator",
            initialPrompt: "Run turn",
            model: "anthropic/claude-opus-5-5",
            tools: [],
            executeTool: async () => ({}),
            signal: new AbortController().signal,
            callbacks: {},
          },
          fakeAmp,
        );
        return { res, promptCalls };
      };

      const clean = await runUnsolicited(false);
      assert.equal(clean.res.stopReason, "cancelled");
      assert.equal(clean.res.errorCode, EXPECTED_EXECUTOR_LOST_CODE);
      assert.equal(clean.promptCalls, 1);

      const afterToolFail = await runUnsolicited(true);
      assert.equal(afterToolFail.res.stopReason, "cancelled");
      assert.equal(afterToolFail.res.errorCode, EXPECTED_EXECUTOR_LOST_CODE);
      assert.equal(afterToolFail.promptCalls, 1, "unsolicited cancel must not trigger silent-failure re-prompt loop");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not falsely mark healthy file reads or failing test output mentioning the phrase as broken", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-no-false-pos-"));
    try {
      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-healthy",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          // 1. Reading source code that contains the regex string
          await acpClient.notify("session/update", {
            sessionId: "S-g42-healthy",
            update: { sessionUpdate: "tool_call", toolCallId: "tc-read", title: "Read", status: "in_progress" },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-healthy",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-read",
              status: "completed",
              rawOutput: "821 | const EXECUTOR_LOST_RE = /No executor is connected/i;\n",
            },
          } as never);
          // 2. Failing test run mentioning the phrase in an assertion
          await acpClient.notify("session/update", {
            sessionId: "S-g42-healthy",
            update: { sessionUpdate: "tool_call", toolCallId: "tc-test", title: "shell_command", status: "in_progress" },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-healthy",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-test",
              status: "failed",
              rawOutput: 'bun test: AssertionError: expected "No executor is connected" to set acp_executor_lost',
            },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-healthy",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Finished reading source and inspecting test output." },
            },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const runner = new AcpRunner(AMP_PROFILE);
      const res = await runner.run(
        {
          runId: "r-g42-healthy",
          taskId: "t-g42-healthy",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Read acp-runner.ts and run tests",
          model: "anthropic/claude-opus-5-5",
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fakeAmp,
      );

      assert.equal(res.stopReason, "completed");
      assert.equal(res.errorCode, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
