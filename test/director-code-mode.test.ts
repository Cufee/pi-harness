import assert from "node:assert/strict";
import { it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CodeExecResult } from "../src/code-mode/index.js";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { RunAgentRequest, ToolDefinition } from "../src/runners/types.js";

async function withDirector(
  mode: HarnessConfig["codeMode"],
  script: (req: RunAgentRequest, bridge: DaemonClient) => Promise<void>,
  test: (daemon: HarnessDaemon, repoRoot: string, chatId: string) => Promise<void>,
): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), "director-code-"));
  const socketPath = join(repoRoot, "d.sock");
  const daemon = new HarnessDaemon({
    ...loadConfig(repoRoot), stateDir: repoRoot, socketPath, codeMode: mode, codeExec: { maxOutputChars: 12 },
  }, {
    dbPath: ":memory:",
    customRunnerFactory: () => ({
      run: async (req) => {
        await script(req, bridge);
        return { text: "done", stopReason: "completed" };
      },
    }),
  });
  const bridge = new DaemonClient(socketPath);
  try {
    await daemon.start();
    await bridge.connect();
    const profileId = daemon.config.profiles.find((p) => p.enabled !== false)!.id;
    const chat = daemon.director.chats.createSession({ repoRoot, profileId });
    await test(daemon, chat.repoRoot, chat.id);
  } finally {
    bridge.close();
    await daemon.stop();
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function callBridge(bridge: DaemonClient, req: RunAgentRequest, name: string, args: Record<string, unknown>) {
  return bridge.request("tool.call", { runId: req.runId, taskId: req.taskId, name, args });
}

for (const mode of ["collapsed", "hybrid", "off"] as const) {
  it(`exposes the same ${mode} Director tools to the runner and MCP`, async () => {
    await withDirector(mode, async (req, bridge) => {
      const tools = await callBridge(bridge, req, "__list_tools", {}) as ToolDefinition[];
      assert.deepEqual(tools, req.tools);
      const names = tools.map((tool) => tool.name);
      if (mode === "collapsed") assert.deepEqual(names, ["tool_search", "code_exec"]);
      else assert.ok(names.includes("goal_list"));
      if (mode === "off") {
        assert.ok(!names.includes("tool_search") && !names.includes("code_exec"));
        assert.doesNotMatch(req.systemPrompt, /## Code Mode/);
        await assert.rejects(req.executeTool("code_exec", { code: "" }), /Unknown Director tool/);
        await assert.rejects(callBridge(bridge, req, "tool_search", {}), /Unknown Director tool/);
      } else {
        assert.ok(names.includes("code_exec"));
        assert.match(req.systemPrompt, /import .* from "harness"/);
        const found = await callBridge(bridge, req, "tool_search", { names: ["read_file", "submit_review_verdict"] });
        assert.deepEqual((found as { matched: string[] }).matched, ["read_file"]);
      }
    }, async ({ director }, _, chatId) => { await director.sendChatMessage(chatId, "show tools"); });
  });
}

it("runs Director tools in the chat workspace and forwards nested MCP events", async () => {
  const events: { id?: string; name: string; status: string; via?: string }[] = [];
  await withDirector("collapsed", async (req, bridge) => {
    const code = 'import { read_file, output } from "harness"; output((await read_file({ path: "note.txt" })).content);';
    const result = await callBridge(bridge, req, "code_exec", { code }) as CodeExecResult;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.preview, '"Director wo');
    assert.ok(result.artifactPath);
    assert.equal(dirname(result.artifactPath), join(req.cwd, ".harness", "artifacts"));
    assert.equal(JSON.parse(readFileSync(result.artifactPath, "utf8")), "Director workspace note");
  }, async ({ director }, repoRoot, chatId) => {
    writeFileSync(join(repoRoot, "note.txt"), "Director workspace note");
    await director.sendChatMessage(chatId, "read note", undefined, (ev) => events.push(ev));
    assert.deepEqual(events.map(({ name, status, via }) => [name, status, via]), [
      ["read_file", "in_progress", "code_exec"], ["read_file", "completed", "code_exec"],
    ]);
    assert.ok(events[0]?.id);
    assert.equal(events[0].id, events[1]?.id);
  });
});

it("cancels both runner-local and MCP Code Mode calls with one chat cancellation", async () => {
  let completedCalls = 0;
  const startedIds = new Set<string>();
  await withDirector("collapsed", async (req, bridge) => {
    const code = 'import { kb_search } from "harness"; await kb_search({}); await Bun.sleep(60_000);';
    const args = { code, timeout_s: 3 };
    const results = await Promise.all([
      req.executeTool("code_exec", args),
      callBridge(bridge, req, "code_exec", args),
    ]) as CodeExecResult[];
    assert.equal(req.signal.aborted, true);
    assert.ok(results.every((result) => !result.ok && result.cancelled && !result.timedOut));
  }, async ({ director }, _, chatId) => {
    await director.sendChatMessage(chatId, "wait", undefined, ({ id, name, status }) => {
      if (name === "kb_search" && status === "in_progress" && id) startedIds.add(id);
      if (name === "kb_search" && status === "completed" && ++completedCalls === 2) director.cancelChat(chatId);
    });
    assert.equal(startedIds.size, 2);
    assert.equal(completedCalls, 2);
    assert.equal(director.isChatBusy(chatId), false);
  });
});

it("keeps the independent reviewer read-only with its native verdict tool in collapsed mode", async () => {
  await withDirector("collapsed", async (req) => {
    assert.equal(req.readOnly, true);
    assert.deepEqual(req.tools.map((tool) => tool.name), ["submit_review_verdict"]);
    assert.doesNotMatch(req.systemPrompt, /## Code Mode/);
    await req.executeTool("submit_review_verdict", {
      verdict: "approved", summary: "Verified", criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Observed" }],
    });
  }, async ({ director }, repoRoot, chatId) => {
    const goal = director.goals.createGoal({
      repoRoot, chatSessionId: chatId, title: "Review", description: "Check isolation",
      criteria: [{ id: "c1", kind: "behavioral", description: "Reviewer tools isolated" }],
    });
    const { review } = await director.verifyAndReviewGoal(goal.id);
    assert.equal(review.verdict, "approved");
  });
});
