import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { HARNESS_TEXT_COUNT_PATTERN } from "../src/advisories/rules.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { providePython } from "../src/code-mode/python.js";
import { codeExecTimeoutError, createCodeExecIpcServer, runCodeExec } from "../src/code-mode/runner.js";
import { sandboxAvailable } from "../src/code-mode/sandbox.js";
import { loadConfig, type PiProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { validateTaskHandoff } from "../src/control-plane/handoffs.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { GoalEngine } from "../src/goals/engine.js";
import { QuotaClient } from "../src/quota/client.js";
import { PiRunner } from "../src/runners/pi-runner.js";

const BLOCKED_SHAPE = /^\[harness blocked: [\w-]+\] .+ Why: .+ Allowed: .+/;

const activeServers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  while (activeServers.length > 0) {
    activeServers.pop()?.stop(true);
  }
});

interface MockChatBody {
  messages: Array<{ role: string; content?: string | Array<{ type?: string; text?: string }>; tool_call_id?: string }>;
}

function encodeOpenAiSse(turn: { text?: string; toolCall?: { id: string; name: string; args: Record<string, unknown> } }): string {
  const base = { id: "chatcmpl-t52t", object: "chat.completion.chunk", created: 1700000000, model: "test-model" };
  const chunks: string[] = [];
  if (turn.text) {
    chunks.push(
      `data: ${JSON.stringify({
        ...base,
        choices: [{ index: 0, delta: { role: "assistant", content: turn.text }, finish_reason: null }],
      })}\n\n`,
    );
  }
  if (turn.toolCall) {
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
                  id: turn.toolCall.id,
                  type: "function",
                  function: { name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      })}\n\n`,
    );
  }
  chunks.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: turn.toolCall ? "tool_calls" : "stop" }],
    })}\n\n`,
  );
  chunks.push(
    `data: ${JSON.stringify({
      ...base,
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
    })}\n\n`,
  );
  chunks.push("data: [DONE]\n\n");
  return chunks.join("");
}

describe("slice T explanatory rejection texts (T5-2t, T5-6t)", () => {
  it("T5-2t: missing sources on read-only return_task uses handoff-sources blocked shape and leaves task unsettled", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-t52t-handoff-"));
    const db = new ControlPlaneDb(":memory:");
    try {
      const config = { ...loadConfig(repoRoot), stateDir: repoRoot };
      const quota = new QuotaClient();
      const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota);
      const run = db.createRun({ goal: "T5-2t handoff", repoRoot, baseBranch: "main", baseSha: "abc" });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Parent",
        objective: "Coordinate",
        profileId: "acp:codex",
      });
      const child = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Research",
        objective: "Inspect",
        profileId: "acp:codex",
      });

      let caught: unknown;
      try {
        await orch.toolExecutor.execute(run.id, child.id, "return_task", {
          status: "completed",
          summary: "Findings without sources",
        });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught instanceof Error);
      assert.match(caught.message, BLOCKED_SHAPE);
      assert.match(caught.message, /^\[harness blocked: handoff-sources\] /);
      assert.equal(db.getTask(child.id)?.status, "ready");
      assert.equal(db.getTask(child.id)?.resultJson, null);
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("T5-2t: Code Mode timeout, IPC size limit, and unknown-tool errors use the blocked shape", async () => {
    // 1. Timeout rejection shape (L7)
    const timeoutErr = codeExecTimeoutError(150);
    assert.match(timeoutErr.message, BLOCKED_SHAPE);
    assert.match(timeoutErr.message, /^\[harness blocked: code-exec-timeout\] /);

    // 2. IPC server limits: unknown tool (L12), oversized reply (L7), and oversized incoming frame (L7)
    const dir = mkdtempSync(join(tmpdir(), "cm-t52t-"));
    const sockPath = join(dir, "ipc");
    const sockets = new Set<Socket>();
    const abort = new AbortController();
    let stoppedReason: string | undefined;
    let outputValue: unknown;
    let calledTools: string[] = [];

    const server = createCodeExecIpcServer({
      names: new Set(["huge_tool"]),
      sockets,
      isStopped: () => stoppedReason !== undefined,
      stop: (reason) => {
        if (stoppedReason !== undefined) return;
        stoppedReason = reason;
        for (const s of sockets) s.destroy();
      },
      onOutput: (v) => {
        outputValue = v;
      },
      onSandboxDenial: () => {},
      onToolCall: () => {},
      callTool: async (name) => {
        calledTools.push(name);
        if (name === "huge_tool") return "x".repeat(17 * 1024 * 1024);
        return {};
      },
      signal: abort.signal,
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(sockPath, resolve);
      });

      const client = createConnection(sockPath);
      await new Promise<void>((resolve, reject) => {
        client.once("connect", resolve);
        client.once("error", reject);
      });
      client.setEncoding("utf8");

      const readReply = (): Promise<{ id: number; ok: boolean; error?: string; value?: unknown }> =>
        new Promise((resolve, reject) => {
          let buf = "";
          const onData = (chunk: string) => {
            buf += chunk;
            const idx = buf.indexOf("\n");
            if (idx >= 0) {
              client.off("data", onData);
              client.off("error", onErr);
              resolve(JSON.parse(buf.slice(0, idx)));
            }
          };
          const onErr = (err: Error) => {
            client.off("data", onData);
            reject(err);
          };
          client.on("data", onData);
          client.once("error", onErr);
        });

      // Unknown tool inside Code Mode -> not-your-tool; callTool is NOT called
      const unknownReplyPromise = readReply();
      client.write(`${JSON.stringify({ id: 1, name: "spawn_worker", args: {} })}\n`);
      const unknownReply = await unknownReplyPromise;
      assert.equal(unknownReply.ok, false);
      assert.match(unknownReply.error ?? "", BLOCKED_SHAPE);
      assert.match(unknownReply.error ?? "", /^\[harness blocked: not-your-tool\] /);
      assert.deepEqual(calledTools, []);

      // Oversized tool reply (>16 MiB) -> code-exec-ipc
      const hugeReplyPromise = readReply();
      client.write(`${JSON.stringify({ id: 2, name: "huge_tool", args: {} })}\n`);
      const hugeReply = await hugeReplyPromise;
      assert.equal(hugeReply.ok, false);
      assert.match(hugeReply.error ?? "", BLOCKED_SHAPE);
      assert.match(hugeReply.error ?? "", /^\[harness blocked: code-exec-ipc\] /);

      // Oversized incoming IPC frame (>16 MiB) -> stops with code-exec-ipc and records no output
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      client.write(`{"id":3,"kind":"output","value":"${"a".repeat(17 * 1024 * 1024)}"}\n`);
      await closed;
      assert.match(stoppedReason ?? "", BLOCKED_SHAPE);
      assert.match(stoppedReason ?? "", /^\[harness blocked: code-exec-ipc\] /);
      assert.equal(outputValue, undefined);

      // On macOS where OS sandbox is available, also verify end-to-end runCodeExec timeout and IPC frame limit
      if (sandboxAvailable()) {
        const artifactsDir = join(dir, "artifacts");
        const timedOutRes = await runCodeExec({
          code: "while (true) {}",
          tools: [],
          timeoutMs: 150,
          artifactsDir,
          callTool: async () => ({}),
        });
        assert.equal(timedOutRes.ok, false);
        assert.equal(timedOutRes.timedOut, true);
        assert.match(timedOutRes.error ?? "", BLOCKED_SHAPE);
        assert.match(timedOutRes.error ?? "", /^\[harness blocked: code-exec-timeout\] /);

        const ipcRes = await runCodeExec({
          code: 'output("界".repeat(6 * 1024 * 1024))',
          tools: [],
          artifactsDir,
          callTool: async () => ({}),
        });
        assert.equal(ipcRes.ok, false);
        assert.match(ipcRes.error ?? "", BLOCKED_SHAPE);
        assert.match(ipcRes.error ?? "", /^\[harness blocked: code-exec-ipc\] /);
      }
    } finally {
      for (const s of sockets) s.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T5-2t: Python package cap (>32 packages) returns python-packages blocked shape and creates no cache", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-harness-t52t-py-"));
    const cacheDir = join(dir, "never-created-py-cache");
    const packages = Array.from({ length: 33 }, (_, i) => `pkg-${i}==1.0.0`);
    try {
      let caught: unknown;
      try {
        await providePython(packages, cacheDir);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof Error);
      assert.match(caught.message, BLOCKED_SHAPE);
      assert.match(caught.message, /^\[harness blocked: python-packages\] /);
      assert.equal(existsSync(cacheDir), false);

      // Through runCodeExec, HarnessRejection is surfaced without wrapping prefix
      const result = await runCodeExec({
        language: "python",
        packages,
        pythonCacheDir: cacheDir,
        code: "output(1)",
        tools: [],
        artifactsDir: join(dir, "artifacts"),
        callTool: async () => ({}),
      });
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", BLOCKED_SHAPE);
      assert.match(result.error ?? "", /^\[harness blocked: python-packages\] /);
      assert.equal(existsSync(cacheDir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("T5-2t: Pi unknown tool uses not-your-tool blocked shape and does not execute the tool", async () => {
    const seenRequests: MockChatBody[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const body = (await request.json()) as MockChatBody;
        const turnIdx = seenRequests.length;
        seenRequests.push(body);
        const sse =
          turnIdx === 0
            ? encodeOpenAiSse({ toolCall: { id: "call_unknown_1", name: "spawn_worker", args: { title: "nope" } } })
            : encodeOpenAiSse({ text: "Understood, using allowed tools." });
        return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8" } });
      },
    });
    activeServers.push(server);

    const profile: PiProfileConfig = {
      id: "pi:test-local",
      kind: "pi",
      provider: "local-test",
      api: "openai-completions",
      baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`,
      billing: "local",
      models: ["test-model"],
    };

    const executedTools: string[] = [];
    const failedEvents: Array<{ name: string; error?: string }> = [];

    const res = await new PiRunner(profile).run({
      runId: "r-pi-t52t",
      taskId: "t-pi-t52t",
      tier: 3,
      kind: "research",
      cwd: process.cwd(),
      toolPolicy: "read_only_workspace",
      systemPrompt: "Researcher",
      initialPrompt: "Inspect",
      model: "test-model",
      tools: [{ name: "return_task", description: "Return handoff", inputSchema: { type: "object", properties: {} } }],
      executeTool: async (name) => {
        executedTools.push(name);
        return { ok: true };
      },
      signal: new AbortController().signal,
      callbacks: {
        onToolEvent: (ev) => {
          if (ev.status === "failed") failedEvents.push({ name: ev.name, error: ev.error });
        },
      },
    });

    assert.equal(res.stopReason, "completed");
    assert.deepEqual(executedTools, []);
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0]!.name, "spawn_worker");
    assert.match(failedEvents[0]!.error ?? "", BLOCKED_SHAPE);
    assert.match(failedEvents[0]!.error ?? "", /^\[harness blocked: not-your-tool\] /);

    // The toolResult fed back to the model on turn 2 carries the full blocked message
    assert.equal(seenRequests.length, 2);
    const toolResultMsg = seenRequests[1]!.messages.find((m) => m.role === "tool");
    const toolResultText =
      typeof toolResultMsg?.content === "string"
        ? toolResultMsg.content
        : Array.isArray(toolResultMsg?.content)
          ? toolResultMsg.content.map((p) => p.text ?? "").join("\n")
          : "";
    assert.match(toolResultText, BLOCKED_SHAPE);
    assert.match(toolResultText, /^\[harness blocked: not-your-tool\] /);
    assert.ok(toolResultText.includes("spawn_worker is not available to a research task"));
  });

  it("T5-6t: validateTaskHandoff accepts partial: true with artifact_paths and no sources, and never sets partial implicitly", () => {
    for (const kind of ["research", "plan", "verify"] as const) {
      const accepted = validateTaskHandoff(kind, {
        summary: "Partial findings saved",
        partial: true,
        artifact_paths: [".harness/artifacts/notes.md"],
      });
      assert.deepEqual(accepted, {
        summary: "Partial findings saved",
        sources: [],
        artifactPaths: [".harness/artifacts/notes.md"],
        partial: true,
      });

      // Without partial: true, artifact_paths alone still rejects with handoff-sources
      assert.throws(
        () =>
          validateTaskHandoff(kind, {
            summary: "Missing sources without partial",
            artifact_paths: [".harness/artifacts/notes.md"],
          }),
        { message: /^\[harness blocked: handoff-sources\] .+ Why: .+ Allowed: .+/ },
      );
    }
  });
});

describe("goal-14 slice Z3 reviewer prompt (T5-4g)", () => {
  it("T5-4g: buildReviewerPrompt states no turn/tool-call/token count and keeps the wall-clock sentence", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-t54g-"));
    const db = new ControlPlaneDb(":memory:");
    try {
      const goals = new GoalEngine(db.db);
      const goal = goals.createGoal({
        repoRoot,
        title: "Verify reviewer prompt",
        description: "Ensure buildReviewerPrompt emits no turn, tool-call, or token count.",
        criteria: [
          { id: "c1", description: "Typecheck passes", kind: "deterministic", command: "bun x tsc --noEmit", required: true },
          { id: "c2", description: "Behavior matches spec", kind: "behavioral", required: true },
        ],
        nonGoals: ["Unrelated refactoring"],
      });
      const prompt = goals.buildReviewerPrompt(
        goal,
        {
          allPassed: true,
          results: [{ criterionId: "c1", passed: true, evidence: "tsc exited 0" }],
          diffHash: "deadbeef",
          location: { cwd: repoRoot, ref: "main", sha: "deadbeef", isolated: true, source: "run_base_branch" },
        },
        " src/goals/engine.ts | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
        "diff --git a/src/goals/engine.ts b/src/goals/engine.ts\n--- a/src/goals/engine.ts\n+++ b/src/goals/engine.ts",
        {
          reviewerMaxTurns: 30,
          contractPath: join(repoRoot, ".harness", "goals", goal.id, "contract-v1.md"),
          diffRange: "main..HEAD",
          evidence: {
            goalEvidenceDir: join(repoRoot, ".harness", "goals", goal.id),
            goalsDir: join(repoRoot, ".harness", "goals"),
            artifactsDir: join(repoRoot, ".harness", "artifacts"),
            runArtifactsDir: join(repoRoot, ".harness", "artifacts", "run-1"),
          },
          coordinatorFailure: {
            source: "coordinator",
            summary: "Prior run flagged c2",
            criteriaResults: [{ criterionId: "c2", passed: false, evidence: "missing check" }],
            claimedAt: 1700000000000,
          },
        },
      );
      assert.ok(
        !HARNESS_TEXT_COUNT_PATTERN.test(prompt),
        `buildReviewerPrompt matched HARNESS_TEXT_COUNT_PATTERN: ${prompt.match(HARNESS_TEXT_COUNT_PATTERN)?.[0]}`,
      );
      assert.ok(prompt.includes("wall-clock"), "buildReviewerPrompt must retain the wall-clock limit sentence");
    } finally {
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
