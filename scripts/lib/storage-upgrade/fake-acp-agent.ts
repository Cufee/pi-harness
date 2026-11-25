#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fakeDir = process.env.FAKE_DIR;
if (!fakeDir) {
  process.stderr.write("storage-upgrade fake-acp-agent: FAKE_DIR env is required\n");
  process.exit(1);
}

interface McpServerSpec {
  name?: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

let mcpClient: Client | null = null;
let taskIdToken = "unknown";
let ownTaskId = "unknown";
let sawRestartSteer = false;
let cancelled = false;
let currentRole = "unknown";
let currentMode: "fresh" | "resumed" = "fresh";
let spawnedCount = 0;
let sessionLogged = false;
let wakeSleeper: (() => void) | null = null;

async function connectHarnessMcp(harnessServer: McpServerSpec): Promise<void> {
  if (mcpClient || !harnessServer.command) return;
  const serverEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") serverEnv[k] = v;
  }
  for (const entry of harnessServer.env ?? []) {
    serverEnv[entry.name] = entry.value;
  }
  const transport = new StdioClientTransport({
    command: harnessServer.command,
    args: harnessServer.args ?? [],
    env: serverEnv,
    stderr: "ignore",
  });
  mcpClient = new Client({ name: "storage-upgrade-fake-acp-agent", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);
  await mcpClient.listTools();
}

function logSessionOnce(): void {
  if (sessionLogged || currentRole === "unknown") return;
  sessionLogged = true;
  try {
    mkdirSync(fakeDir!, { recursive: true });
    appendFileSync(
      join(fakeDir!, "sessions.log"),
      `${taskIdToken} ${currentRole} ${currentMode} spawned=${spawnedCount}\n`,
      "utf8",
    );
  } catch {
    // ignore log failures during abrupt teardown
  }
}

function sleepWakeable(ms: number): Promise<void> {
  if (cancelled || sawRestartSteer) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      if (wakeSleeper === done) wakeSleeper = null;
      clearTimeout(timer);
      resolve();
    };
    wakeSleeper = done;
    const timer = setTimeout(done, ms);
    timer.unref?.();
  });
}

function wake(): void {
  const fn = wakeSleeper;
  wakeSleeper = null;
  fn?.();
}

async function callMcp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!mcpClient) throw new Error(`MCP client not connected for tool ${name}`);
  const res = await mcpClient.callTool({ name, arguments: args });
  const content = Array.isArray(res.content) ? res.content : [];
  const text = content
    .map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
  if (res.isError) {
    throw new Error(`MCP tool ${name} failed: ${text}`);
  }
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { text };
  }
}

function extractPromptText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) =>
      block && typeof block === "object" && "text" in block && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : "",
    )
    .join("\n");
}

function detectRole(objectiveLine: string): string {
  const match = objectiveLine.match(/FAKE_ROLE=([a-zA-Z0-9_]+)/);
  return match?.[1] ?? "unknown";
}

process.on("SIGTERM", () => {
  cancelled = true;
  wake();
  logSessionOnce();
  void mcpClient?.close().catch(() => {}).finally(() => process.exit(0));
});

process.on("SIGINT", () => {
  cancelled = true;
  wake();
  logSessionOnce();
  void mcpClient?.close().catch(() => {}).finally(() => process.exit(0));
});

const app = agent()
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "storage-upgrade-fake-acp-agent", version: "1.0.0" },
    _meta: { steering: { supported: true } },
  }))
  .onRequest("session/new", async ({ params }) => {
    const rawServers = (params as { mcpServers?: McpServerSpec[] }).mcpServers ?? [];
    const harnessServer = rawServers.find((s) => s.name === "harness");
    if (harnessServer && harnessServer.command) {
      const taskEntry = (harnessServer.env ?? []).find((entry) => entry.name === "PI_HARNESS_TASK_ID");
      const rawTaskId = taskEntry?.value ?? process.env.PI_HARNESS_TASK_ID;
      if (rawTaskId) {
        taskIdToken = rawTaskId;
        ownTaskId = taskIdToken.split("@")[0] ?? taskIdToken;
      }
      await connectHarnessMcp(harnessServer);
    }

    mkdirSync(join(fakeDir, "pids"), { recursive: true });
    writeFileSync(join(fakeDir, "pids", String(process.pid)), `${taskIdToken}\n`, "utf8");

    return {
      sessionId: `fake-session-${process.pid}`,
      models: {
        currentModelId: "fake-model",
        availableModels: [{ modelId: "fake-model", name: "Fake Model" }],
      },
    };
  })
  .onNotification("session/cancel", async () => {
    cancelled = true;
    wake();
  })
  .onRequest("session/prompt", async ({ client, params }) => {
    const promptText = extractPromptText(params.prompt);
    const sessionId = params.sessionId;
    const isResumed =
      promptText.includes("Resumed Task Context") || promptText.includes("Predecessor Anchored Handoff");
    currentMode = isResumed ? "resumed" : "fresh";
    const objectiveLine = promptText.match(/^Objective:\s*(.+)$/m)?.[1] ?? promptText;
    currentRole = detectRole(objectiveLine);

    const requestRollover = async (nextAction: string) => {
      try {
        await callMcp("request_rollover", {
          goal_invariants: [`Preserve ${currentRole} state across daemon restart`],
          next_actions: [nextAction],
        });
      } catch {
        // Session may already be cancelling or rolling over.
      }
    };

    try {
      if (currentRole === "g0_orchestrator") {
        await callMcp("artifact_write", {
          name: "g0-dossier.md",
          content: "# G0 Legacy Dossier\nCreated by g0_orchestrator before storage upgrade.\n",
          summary: "G0 legacy dossier written before upgrade",
        });
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "G0 dossier written and completed." },
          },
        });
        return { stopReason: "end_turn" };
      }

      if (currentRole === "g1_orchestrator" || currentRole === "r2_orchestrator") {
        const isG1 = currentRole === "g1_orchestrator";
        let childIds: string[] = [];

        if (!isResumed) {
          if (isG1) {
            await callMcp("artifact_write", {
              name: "g1-dossier.md",
              content: "# G1 Live Goal Dossier\nCreated by g1_orchestrator before storage upgrade.\n",
              summary: "G1 orchestrator dossier before upgrade",
            });
            const spawned = await callMcp("spawn_worker", {
              title: "G1 legacy worktree worker",
              objective: "FAKE_ROLE=g1_worker wait for go-g1 signal",
              write_scopes: ["README.md"],
              model: "fake-model",
            });
            spawnedCount += 1;
            const cid =
              typeof spawned.spawned === "string"
                ? spawned.spawned
                : typeof spawned.taskId === "string"
                  ? spawned.taskId
                  : typeof spawned.id === "string"
                    ? spawned.id
                    : "";
            if (cid) childIds.push(cid);

            await callMcp("schedule_timer", {
              delay_seconds: 6,
              reason: "storage-upgrade-g1-timer",
            });
          } else {
            const spawned = await callMcp("spawn_task", {
              kind: "research",
              title: "R2 rollback child",
              objective: "FAKE_ROLE=r2_child wait for go-r2 signal",
              model: "fake-model",
            });
            spawnedCount += 1;
            const cid =
              typeof spawned.taskId === "string"
                ? spawned.taskId
                : typeof spawned.id === "string"
                  ? spawned.id
                  : "";
            if (cid) childIds.push(cid);
          }
        } else {
          const tree = await callMcp("tree_view", { include_settled: true });
          const tasks = Array.isArray(tree.tasks)
            ? (tree.tasks as Array<{ id?: string; tier?: number; parentId?: string }>)
            : [];
          const expectedTier = isG1 ? 2 : 3;
          childIds = tasks
            .filter((t) => typeof t.id === "string" && (t.parentId === ownTaskId || t.tier === expectedTier))
            .map((t) => t.id!);
        }

        const rolloverMsg = `Wait for child task ${childIds.length > 0 ? childIds.join(", ") : "child"} to complete`;

        while (!cancelled) {
          if (sawRestartSteer) {
            await requestRollover(rolloverMsg);
            return { stopReason: "end_turn" };
          }

          let waitRes: Record<string, unknown>;
          try {
            waitRes = await callMcp("wait_children", {
              ...(childIds.length > 0 ? { ids: childIds } : {}),
              mode: "all",
              fallback_interval_s: 30,
            });
          } catch {
            if (cancelled) return { stopReason: "cancelled" };
            if (sawRestartSteer) {
              await requestRollover(rolloverMsg);
              return { stopReason: "end_turn" };
            }
            return { stopReason: "cancelled" };
          }

          const steers = Array.isArray(waitRes.steeringMessages)
            ? (waitRes.steeringMessages as unknown[]).filter((s): s is string => typeof s === "string")
            : [];
          if (steers.some((s) => s.includes("[harness:daemon-restart]"))) {
            sawRestartSteer = true;
          }
          if (sawRestartSteer) {
            await requestRollover(rolloverMsg);
            return { stopReason: "end_turn" };
          }

          const children = Array.isArray(waitRes.children)
            ? (waitRes.children as Array<{ id?: string; status?: string }>)
            : [];
          if (childIds.length === 0 && children.length > 0) {
            childIds = children.map((c) => c.id).filter((id): id is string => typeof id === "string");
          }
          if (children.length > 0 && children.every((c) => c.status === "completed")) {
            await client.notify("session/update", {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `${currentRole} finished after all children completed.` },
              },
            });
            return { stopReason: "end_turn" };
          }
        }
        return { stopReason: "cancelled" };
      }

      if (currentRole === "g1_worker") {
        const goFile = join(fakeDir, "go-g1");
        while (!cancelled && !sawRestartSteer && !existsSync(goFile)) {
          await sleepWakeable(200);
        }
        if (sawRestartSteer) {
          await requestRollover("Wait for go-g1 signal in preserved worktree and return_task completed");
          return { stopReason: "end_turn" };
        }
        if (cancelled) return { stopReason: "cancelled" };
        await callMcp("return_task", {
          status: "completed",
          summary: "G1 worker completed after go-g1 signal",
          sources: [{ path: "README.md", note: "verified go-g1 signal" }],
        });
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "G1 worker completed." },
          },
        });
        return { stopReason: "end_turn" };
      }

      if (currentRole === "r2_child") {
        const goFile = join(fakeDir, "go-r2");
        while (!cancelled && !existsSync(goFile)) {
          await sleepWakeable(200);
        }
        if (cancelled) return { stopReason: "cancelled" };
        await callMcp("return_task", {
          status: "completed",
          summary: "R2 child completed after go-r2 signal",
          sources: [{ path: "README.md", note: "verified go-r2 signal" }],
        });
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "R2 child completed." },
          },
        });
        return { stopReason: "end_turn" };
      }

      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" },
        },
      });
      return { stopReason: "end_turn" };
    } finally {
      logSessionOnce();
      await mcpClient?.close().catch(() => {});
      mcpClient = null;
    }
  })
  .onRequest("*", async ({ method, params }) => {
    if (method === "_session/steering") {
      const p = (params ?? {}) as Record<string, unknown>;
      const text = extractPromptText(p.prompt);
      if (text.includes("[harness:daemon-restart]")) {
        sawRestartSteer = true;
        wake();
      }
    }
    return {};
  });

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
  Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
);
app.connect(stream);
