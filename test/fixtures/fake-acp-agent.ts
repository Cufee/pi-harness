#!/usr/bin/env bun
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const fakeDir = process.env.FAKE_DIR;
if (!fakeDir) {
  process.stderr.write("fake-acp-agent: FAKE_DIR env is required\n");
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
    agentInfo: { name: "fake-acp-agent", version: "1.0.0" },
    _meta: { steering: { supported: true } },
  }))
  .onRequest("session/new", async ({ params }) => {
    const rawServers = (params as { mcpServers?: McpServerSpec[] }).mcpServers ?? [];
    const harnessServer = rawServers.find((s) => s.name === "harness");
    if (harnessServer && harnessServer.command) {
      const serverEnv: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === "string") serverEnv[k] = v;
      }
      for (const entry of harnessServer.env ?? []) {
        serverEnv[entry.name] = entry.value;
      }
      if (serverEnv.PI_HARNESS_TASK_ID) {
        taskIdToken = serverEnv.PI_HARNESS_TASK_ID;
        ownTaskId = taskIdToken.split("@")[0] ?? taskIdToken;
      }
      const transport = new StdioClientTransport({
        command: harnessServer.command,
        args: harnessServer.args ?? [],
        env: serverEnv,
        stderr: "ignore",
      });
      mcpClient = new Client({ name: "fake-acp-agent", version: "1.0.0" }, { capabilities: {} });
      await mcpClient.connect(transport);
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
    if (objectiveLine.includes("FAKE_ROLE=child")) {
      currentRole = "child";
    } else if (objectiveLine.includes("FAKE_ROLE=orchestrator")) {
      currentRole = "orchestrator";
    } else {
      currentRole = "unknown";
    }

    try {
      if (currentRole === "orchestrator") {
        let childIds: string[] = [];

        if (!isResumed) {
          const spawned = await callMcp("spawn_task", {
            kind: "research",
            title: "Fake child task",
            objective: "FAKE_ROLE=child wait for go signal",
            model: "fake-model",
          });
          spawnedCount += 1;
          const cid = typeof spawned.taskId === "string" ? spawned.taskId : typeof spawned.id === "string" ? spawned.id : "";
          if (cid) childIds.push(cid);

          await callMcp("schedule_timer", {
            delay_seconds: 3,
            reason: "hot-update-check-timer",
          });
        } else {
          const tree = await callMcp("tree_view", { include_settled: true });
          const tasks = Array.isArray(tree.tasks) ? (tree.tasks as Array<{ id?: string; tier?: number; parentId?: string }>) : [];
          childIds = tasks
            .filter((t) => typeof t.id === "string" && (t.parentId === ownTaskId || t.tier === 3))
            .map((t) => t.id!);
        }

        const requestRollover = async () => {
          const childDesc = childIds.length > 0 ? childIds.join(", ") : "child";
          try {
            await callMcp("request_rollover", {
              goal_invariants: ["Preserve child task across daemon restart"],
              next_actions: [`Wait for child task ${childDesc} to complete and finish the run`],
            });
          } catch {
            // If the session was already cancelling/rolling over, exit cleanly.
          }
        };

        while (!cancelled) {
          if (sawRestartSteer) {
            await requestRollover();
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
              await requestRollover();
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
            await requestRollover();
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
                content: { type: "text", text: "All child tasks completed." },
              },
            });
            return { stopReason: "end_turn" };
          }
        }
        return { stopReason: "cancelled" };
      }

      if (currentRole === "child") {
        const goFile = join(fakeDir, "go");
        while (!cancelled && !existsSync(goFile)) {
          await sleepWakeable(200);
        }
        if (cancelled) return { stopReason: "cancelled" };
        await callMcp("return_task", {
          status: "completed",
          summary: "Fake child completed after go signal",
          sources: [{ path: "README.md", detail: "verified go signal" }],
        });
        await client.notify("session/update", {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Fake child completed." },
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
