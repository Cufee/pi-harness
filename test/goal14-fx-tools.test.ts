import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { codeExecCallableNames, createCodeExecIpcServer } from "../src/code-mode/runner.js";
import { sandboxAvailable } from "../src/code-mode/sandbox.js";
import { loadConfig, type PiProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { buildImmutableSystemPrompt } from "../src/control-plane/prompts.js";
import { allowedToolsForTask, toolsForTask } from "../src/control-plane/tools.js";
import { QuotaClient } from "../src/quota/client.js";
import { PiRunner } from "../src/runners/pi-runner.js";
import { allowedToolNames } from "../src/tool-descriptions/registry.js";
import { runGit } from "../src/worktree/manager.js";

const BLOCKED_SHAPE = /^\[harness blocked: [\w-]+\] .+ Why: .+ Allowed: .+/;

const activeServers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => {
  while (activeServers.length > 0) {
    activeServers.pop()?.stop(true);
  }
});

interface MockChatBody {
  tools?: Array<{ function?: { name?: string } }>;
  messages: Array<{ role: string; content?: string | Array<{ type?: string; text?: string }>; tool_call_id?: string }>;
}

function encodeOpenAiSse(turn: { text?: string; toolCall?: { id: string; name: string; args: Record<string, unknown> } }): string {
  const base = { id: "chatcmpl-fxt", object: "chat.completion.chunk", created: 1700000000, model: "test-model" };
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

function extractToolText(msg: MockChatBody["messages"][number] | undefined): string {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((p) => p.text ?? "").join("\n");
  return "";
}

async function setupWritableExecuteTask() {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-fxt-repo-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-fxt-state-"));
  await runGit(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "README.md"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();

  const db = new ControlPlaneDb(":memory:");
  const config = { ...loadConfig(repoRoot), stateDir, codeMode: "off" as const };
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const orch = new HarnessOrchestrator(db, config, catalog, quota);

  const run = db.createRun({ goal: "FX-TOOLS test", repoRoot, baseBranch: "main", baseSha });
  const parent = db.createTask({
    runId: run.id,
    tier: 2,
    kind: "worker",
    title: "Parent worker",
    objective: "Own slice",
    readOnly: false,
    profileId: "pi:test-local",
  });
  db.updateTask(parent.id, { status: "running" });

  const execTask = db.createTask({
    runId: run.id,
    parentId: parent.id,
    tier: 3,
    kind: "execute",
    title: "Writable execute",
    objective: "Edit slice",
    readOnly: false,
    profileId: "pi:test-local",
  });
  db.updateTask(execTask.id, { status: "running" });

  const cleanup = () => {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  };

  return { repoRoot, stateDir, db, orch, run, execTask, cleanup };
}

function makeMockPiServer(turns: Array<{ text?: string; toolCall?: { id: string; name: string; args: Record<string, unknown> } }>) {
  const seenRequests: MockChatBody[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = (await request.json()) as MockChatBody;
      const idx = seenRequests.length;
      seenRequests.push(body);
      const turn = turns[idx] ?? { text: "Done." };
      return new Response(encodeOpenAiSse(turn), {
        status: 200,
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      });
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

  return { profile, seenRequests };
}

async function withCodeExecIpcClient(
  names: ReadonlySet<string>,
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>,
  fn: (send: (req: { id: number; name: string; args: Record<string, unknown> }) => Promise<{ id: number; ok: boolean; error?: string; value?: unknown }>) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "cm-fxt-"));
  const sockPath = join(dir, "ipc");
  const sockets = new Set<Socket>();
  const abort = new AbortController();
  let stopped = false;

  const server = createCodeExecIpcServer({
    names,
    sockets,
    isStopped: () => stopped,
    stop: () => {
      stopped = true;
      for (const s of sockets) s.destroy();
    },
    onOutput: () => {},
    onSandboxDenial: () => {},
    onToolCall: () => {},
    callTool,
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

    const send = (req: { id: number; name: string; args: Record<string, unknown> }) =>
      new Promise<{ id: number; ok: boolean; error?: string; value?: unknown }>((resolve, reject) => {
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
        client.write(`${JSON.stringify(req)}\n`);
      });

    try {
      await fn(send);
    } finally {
      client.destroy();
    }
  } finally {
    for (const s of sockets) s.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("goal-14 fix FX-TOOLS", () => {
  it("FXT-6a: Pi dispatch accepts inspect_command for writable execute and rejects disallowed tools with not-your-tool", async () => {
    const { repoRoot, orch, run, execTask, cleanup } = await setupWritableExecuteTask();
    try {
      // Listed set (and MCP __list_tools) omits inspect_command for writable execute
      const listed = orch.toolExecutor.tools(execTask);
      assert.ok(!listed.some((t) => t.name === "inspect_command"));
      const mcpListed = (await orch.toolExecutor.execute(run.id, execTask.id, "__list_tools", {})) as Array<{ name: string }>;
      assert.ok(!mcpListed.some((t) => t.name === "inspect_command"));

      const { profile, seenRequests } = makeMockPiServer([
        { toolCall: { id: "call_inspect_1", name: "inspect_command", args: { argv: ["cat", "README.md"] } } },
        { toolCall: { id: "call_denied_1", name: "spawn_worker", args: { title: "forbidden" } } },
        { text: "Done." },
      ]);

      const dispatched: string[] = [];
      const events: Array<{ name: string; status: string; error?: string }> = [];

      const res = await new PiRunner(profile).run({
        runId: run.id,
        taskId: execTask.id,
        tier: 3,
        kind: "execute",
        cwd: repoRoot,
        toolPolicy: "read_write_workspace",
        systemPrompt: buildImmutableSystemPrompt(3, "execute", "off"),
        initialPrompt: "Inspect README",
        model: "test-model",
        tools: listed,
        executeTool: async (name, args) => {
          dispatched.push(name);
          return orch.toolExecutor.execute(run.id, execTask.id, name, args);
        },
        signal: new AbortController().signal,
        callbacks: {
          onToolEvent: (ev) => {
            if (ev.status === "completed" || ev.status === "failed") {
              events.push({ name: ev.name, status: ev.status, error: ev.error });
            }
          },
        },
      });

      assert.equal(res.stopReason, "completed");
      // Discoverability: inspect_command was NOT listed in the schema sent to the model
      const advertisedNames = (seenRequests[0]?.tools ?? []).map((t) => t.function?.name);
      assert.ok(!advertisedNames.includes("inspect_command"));

      // Authorization: inspect_command ran; spawn_worker never reached executeTool
      assert.deepEqual(dispatched, ["inspect_command"]);
      assert.equal(events.length, 2);
      assert.equal(events[0]?.name, "inspect_command");
      assert.equal(events[0]?.status, "completed");

      // Tool result for inspect_command carries real stdout
      const inspectMsg = seenRequests[1]?.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_inspect_1");
      const inspectPayload = JSON.parse(extractToolText(inspectMsg)) as { exit_code: number; stdout: string };
      assert.equal(inspectPayload.exit_code, 0);
      assert.equal(inspectPayload.stdout, "hello\n");

      // Disallowed tool rejected with [harness blocked: not-your-tool]
      assert.equal(events[1]?.name, "spawn_worker");
      assert.equal(events[1]?.status, "failed");
      assert.match(events[1]?.error ?? "", BLOCKED_SHAPE);
      assert.match(events[1]?.error ?? "", /^\[harness blocked: not-your-tool\] /);
      const deniedMsg = seenRequests[2]?.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_denied_1");
      const deniedText = extractToolText(deniedMsg);
      assert.match(deniedText, BLOCKED_SHAPE);
      assert.match(deniedText, /^\[harness blocked: not-your-tool\] /);
    } finally {
      cleanup();
    }
  });

  it("FXT-6b: Code Mode callable set for writable execute includes inspect_command while keeping listed set separate", async () => {
    const { orch, run, execTask, cleanup } = await setupWritableExecuteTask();
    try {
      const listed = toolsForTask(execTask);
      const callableTools = allowedToolsForTask(execTask);
      const callableNames = codeExecCallableNames({ tools: callableTools });
      const separatedNames = codeExecCallableNames({ tools: listed, allowedToolNames: allowedToolNames("execute") });

      assert.ok(!listed.some((t) => t.name === "inspect_command"));
      assert.ok(callableTools.some((t) => t.name === "inspect_command"));
      assert.ok(callableNames.has("inspect_command"));
      assert.ok(separatedNames.has("inspect_command"));
      assert.ok(!callableNames.has("spawn_worker"));
      assert.deepEqual([...callableNames].sort(), [...allowedToolNames("execute")].sort());

      const executed: string[] = [];
      await withCodeExecIpcClient(
        callableNames,
        async (name, args) => {
          executed.push(name);
          return orch.toolExecutor.execute(run.id, execTask.id, name, args);
        },
        async (send) => {
          const okReply = await send({ id: 1, name: "inspect_command", args: { argv: ["cat", "README.md"] } });
          assert.equal(okReply.ok, true);
          const value = okReply.value as { exit_code: number; stdout: string };
          assert.equal(value.exit_code, 0);
          assert.equal(value.stdout, "hello\n");

          const deniedReply = await send({ id: 2, name: "spawn_worker", args: {} });
          assert.equal(deniedReply.ok, false);
          assert.match(deniedReply.error ?? "", BLOCKED_SHAPE);
          assert.match(deniedReply.error ?? "", /^\[harness blocked: not-your-tool\] /);
        },
      );
      assert.deepEqual(executed, ["inspect_command"]);

      if (sandboxAvailable()) {
        // End-to-end sandboxed Code Mode execution on macOS
        const { runCodeExec } = await import("../src/code-mode/runner.js");
        const cmRes = await runCodeExec({
          code: 'import { inspect_command } from "harness"; output(await inspect_command({ argv: ["cat", "README.md"] }));',
          tools: listed,
          allowedToolNames: allowedToolNames("execute"),
          artifactsDir: join(tmpdir(), "cm-fxt-artifacts"),
          callTool: (name, args) => orch.toolExecutor.execute(run.id, execTask.id, name, args),
        });
        assert.equal(cmRes.ok, true, cmRes.error);
        const out = cmRes.output as { exit_code: number; stdout: string };
        assert.equal(out.exit_code, 0);
        assert.equal(out.stdout, "hello\n");
      }
    } finally {
      cleanup();
    }
  });

  it("FXT-6c: mutating argv and escaped cwd on inspect_command are still rejected on both Pi and Code Mode routes", async () => {
    const { repoRoot, orch, run, execTask, cleanup } = await setupWritableExecuteTask();
    try {
      const readmePath = join(repoRoot, "README.md");

      // 1. Pi dispatch route
      const { profile, seenRequests } = makeMockPiServer([
        { toolCall: { id: "call_mut_1", name: "inspect_command", args: { argv: ["rm", "-f", "README.md"] } } },
        { toolCall: { id: "call_cwd_1", name: "inspect_command", args: { argv: ["cat", "README.md"], cwd: "/tmp" } } },
        { text: "Stopped." },
      ]);

      const piFailed: Array<{ name: string; error?: string }> = [];
      const res = await new PiRunner(profile).run({
        runId: run.id,
        taskId: execTask.id,
        tier: 3,
        kind: "execute",
        cwd: repoRoot,
        toolPolicy: "read_write_workspace",
        systemPrompt: buildImmutableSystemPrompt(3, "execute", "off"),
        initialPrompt: "Try mutating inspect_command",
        model: "test-model",
        tools: orch.toolExecutor.tools(execTask),
        executeTool: (name, args) => orch.toolExecutor.execute(run.id, execTask.id, name, args),
        signal: new AbortController().signal,
        callbacks: {
          onToolEvent: (ev) => {
            if (ev.status === "failed") piFailed.push({ name: ev.name, error: ev.error });
          },
        },
      });

      assert.equal(res.stopReason, "completed");
      assert.equal(piFailed.length, 2);
      assert.match(piFailed[0]?.error ?? "", /^\[harness blocked: read-only-argv\] .+ Why: .+ Allowed: .+/);
      assert.match(piFailed[1]?.error ?? "", /^\[harness blocked: inspect-cwd\] .+ Why: .+ Allowed: .+/);
      assert.match(
        extractToolText(seenRequests[1]?.messages.find((m) => m.role === "tool" && m.tool_call_id === "call_mut_1")),
        /^\[harness blocked: read-only-argv\] /,
      );
      assert.equal(existsSync(readmePath), true);
      assert.equal(readFileSync(readmePath, "utf8"), "hello\n");

      // 2. Code Mode IPC route
      const callableNames = codeExecCallableNames({ tools: allowedToolsForTask(execTask) });
      await withCodeExecIpcClient(
        callableNames,
        (name, args) => orch.toolExecutor.execute(run.id, execTask.id, name, args),
        async (send) => {
          const mutReply = await send({ id: 1, name: "inspect_command", args: { argv: ["rm", "-f", "README.md"] } });
          assert.equal(mutReply.ok, false);
          assert.match(mutReply.error ?? "", /^\[harness blocked: read-only-argv\] .+ Why: .+ Allowed: .+/);

          const cwdReply = await send({ id: 2, name: "inspect_command", args: { argv: ["cat", "README.md"], cwd: "/tmp" } });
          assert.equal(cwdReply.ok, false);
          assert.match(cwdReply.error ?? "", /^\[harness blocked: inspect-cwd\] .+ Why: .+ Allowed: .+/);
        },
      );
      assert.equal(existsSync(readmePath), true);
      assert.equal(readFileSync(readmePath, "utf8"), "hello\n");
    } finally {
      cleanup();
    }
  });

  it("FXT-7a: read-only Tier 3 prompts contain no instruction to edit files while writable execute keeps targeted-edit guidance", () => {
    for (const mode of ["off", "collapsed"] as const) {
      for (const kind of ["verify", "research", "plan"] as const) {
        const prompt = buildImmutableSystemPrompt(3, kind, mode);
        assert.ok(prompt.includes("NEVER edit workspace files"), `${kind} (${mode}) must keep read-only prohibition`);
        assert.ok(
          !prompt.includes("Use native targeted edit tools"),
          `${kind} (${mode}) must not tell a read-only agent to use edit tools`,
        );
        const withoutProhibition = prompt.replace("NEVER edit workspace files", "");
        assert.ok(
          !/\bedit(?:s|ing)?\b/i.test(withoutProhibition),
          `${kind} (${mode}) prompt still mentions editing outside the NEVER-edit prohibition: ${withoutProhibition}`,
        );
      }

      const verifyPrompt = buildImmutableSystemPrompt(3, "verify", mode);
      assert.ok(verifyPrompt.includes("`rg` for text search"), `verify (${mode}) should keep search tool guidance`);

      const executePrompt = buildImmutableSystemPrompt(3, "execute", mode);
      assert.ok(
        executePrompt.includes("Use native targeted edit tools for small edits"),
        `execute (${mode}) must keep targeted-edit guidance`,
      );
    }
  });
});
