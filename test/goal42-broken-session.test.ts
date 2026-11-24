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

  it("P1-1: does not trigger acp_executor_lost on successful Read/Grep log output or non-Amp profiles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-p1-1-"));
    try {
      // Case A: Amp profile Read & Grep succeeding with a line starting "Error: No executor is connected..."
      let ampCancelCount = 0;
      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-p1-1-amp",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          ampCancelCount += 1;
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-amp",
            update: { sessionUpdate: "tool_call", toolCallId: "tc-read-log", title: "Read", kind: "read", status: "in_progress" },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-amp",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-read-log",
              status: "completed",
              rawOutput:
                "2026-11-24 incident log\n" +
                "Error: No executor is connected to run mcp__harness__tree_view. Try again later.\n" +
                "end of log\n",
            },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-amp",
            update: { sessionUpdate: "tool_call", toolCallId: "tc-grep-log", title: "Grep", kind: "search", status: "in_progress" },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-amp",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-grep-log",
              status: "completed",
              content: [
                {
                  type: "content",
                  content: {
                    type: "text",
                    text: "Error: No executor is connected to run mcp__harness__tree_view. Try again later.",
                  },
                },
              ],
            },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-amp",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reviewed incident log." } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const ampRunner = new AcpRunner(AMP_PROFILE);
      const ampRes = await ampRunner.run(
        {
          runId: "r-g42-p1-1-amp",
          taskId: "t-g42-p1-1-amp",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Read incident log",
          model: "anthropic/claude-opus-5-5",
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fakeAmp,
      );
      assert.equal(ampCancelCount, 0, "successful Read/Grep of incident log must not send session/cancel");
      assert.equal(ampRes.stopReason, "completed");
      assert.equal(ampRes.errorCode, undefined);

      // Case B: Non-Amp profile (Claude) must not trigger Amp executor-lost detection.
      const claudeProfile: AcpProfileConfig = {
        id: "acp:claude",
        kind: "acp",
        adapter: "claude",
        command: "npx",
        args: ["-y", "@zed-industries/claude-code-acp"],
        billing: "subscription",
      };
      let claudeCancelCount = 0;
      const fakeClaude = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "claude-code-acp", version: "0.1.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-p1-1-claude",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onNotification("session/cancel", async () => {
          claudeCancelCount += 1;
        })
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-claude",
            update: { sessionUpdate: "tool_call", toolCallId: "tc-claude-1", title: "mcp__harness__tree_view", status: "in_progress" },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-claude",
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "tc-claude-1",
              status: "failed",
              rawOutput: { error: "No executor is connected to run mcp__harness__tree_view. Try again later." },
            },
          } as never);
          await acpClient.notify("session/update", {
            sessionId: "S-g42-p1-1-claude",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Continued after error." } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const claudeRunner = new AcpRunner(claudeProfile);
      const claudeRes = await claudeRunner.run(
        {
          runId: "r-g42-p1-1-claude",
          taskId: "t-g42-p1-1-claude",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Check tree",
          model: "anthropic/claude-opus-5-5",
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fakeClaude,
      );
      assert.equal(claudeCancelCount, 0, "non-Amp profile must not trigger Amp executor-lost cancellation");
      assert.equal(claudeRes.stopReason, "completed");
      assert.equal(claudeRes.errorCode, undefined);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("P2-2: does not classify cancelled turn as acp_executor_lost when permission request offered only reject_once", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-g42-p2-2-"));
    try {
      let promptCalls = 0;
      let observedPermOutcome: unknown;
      const fakeAmp = agent()
        .onRequest("initialize", async () => ({
          protocolVersion: 1,
          agentInfo: { name: "amp-acp", version: "0.12.0" },
          agentCapabilities: { sessionCapabilities: {} },
        } as never))
        .onRequest("session/new", async () => ({
          sessionId: "S-g42-p2-2",
          models: {
            currentModelId: "anthropic/claude-opus-5-5",
            availableModels: [{ modelId: "anthropic/claude-opus-5-5", name: "Opus" }],
          },
        } as never))
        .onRequest("session/prompt", async ({ client: acpClient }) => {
          promptCalls += 1;
          observedPermOutcome = await acpClient.request("session/request_permission", {
            sessionId: "S-g42-p2-2",
            toolCall: {
              toolCallId: "tc-perm-only-reject",
              title: "Read",
              kind: "read",
              rawInput: { path: join(cwd, "README.md") },
            },
            options: [{ optionId: "deny", name: "Reject once", kind: "reject_once" }],
          } as never);
          return { stopReason: "cancelled" } as never;
        });

      const runner = new AcpRunner(AMP_PROFILE);
      const res = await runner.run(
        {
          runId: "r-g42-p2-2",
          taskId: "t-g42-p2-2",
          tier: 2,
          kind: "worker",
          cwd,
          toolPolicy: "read_write_workspace",
          systemPrompt: "Worker",
          initialPrompt: "Read workspace file",
          model: "anthropic/claude-opus-5-5",
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fakeAmp,
      );

      assert.deepEqual(observedPermOutcome, { outcome: { outcome: "cancelled" } });
      assert.equal(promptCalls, 1);
      assert.equal(res.stopReason, "cancelled");
      assert.equal(res.errorCode, undefined, "permission-cancelled turn must not be tagged as acp_executor_lost");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
