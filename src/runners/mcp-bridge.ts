#!/usr/bin/env bun
/**
 * Standalone stdio MCP bridge spawned by ACP CLIs (`mcpServers: [{ name: "harness", ... }]`).
 * Proxies `tools/list` and `tools/call` over the local `harnessd` Unix domain socket so
 * external ACP CLIs receive the exact same role-scoped deterministic tools as native `pi` agents.
 */
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { attachDaemonReader, writeNdjson } from "../protocol/frames.js";
import type { RpcRequest, RpcResponse } from "../protocol/daemon-rpc.js";

async function daemonCall(socketPath: string, op: RpcRequest["op"], params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const sock = createConnection(socketPath);
    const detach = attachDaemonReader(sock, {
      onMessage(msg) {
        const frame = msg as RpcResponse;
        if (frame.kind === "res" && frame.id === id) {
          detach();
          sock.end();
          if (frame.ok) resolve(frame.result);
          else reject(new Error(frame.error ?? "Daemon RPC error"));
        }
      },
      onError(err) {
        detach();
        sock.destroy();
        reject(err);
      },
    });
    sock.once("connect", () => {
      writeNdjson(sock, { kind: "req", id, op, params } satisfies RpcRequest);
    });
    sock.once("error", reject);
  });
}

export async function startStdioMcpBridge(opts?: { socketPath?: string; runId?: string; taskId?: string }): Promise<void> {
  const socketPath = opts?.socketPath ?? process.env.PI_HARNESS_SOCKET;
  const runId = opts?.runId ?? process.env.PI_HARNESS_RUN_ID;
  const taskId = opts?.taskId ?? process.env.PI_HARNESS_TASK_ID;
  if (!socketPath || !runId || !taskId) {
    throw new Error("Missing PI_HARNESS_SOCKET, PI_HARNESS_RUN_ID, or PI_HARNESS_TASK_ID");
  }

  const server = new Server(
    { name: "pi-harness", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = (await daemonCall(socketPath, "tool.call", {
      runId,
      taskId,
      name: "__list_tools",
      args: {},
    })) as Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;

    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema as never,
      })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await daemonCall(socketPath, "tool.call", {
        runId,
        taskId,
        name,
        args: (args ?? {}) as Record<string, unknown>,
      });
      return {
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run directly when executed as MCP child process
const invokedDirectly = process.argv[1]?.endsWith("mcp-bridge.js") || process.argv[1]?.endsWith("mcp-bridge.ts");
if (invokedDirectly) {
  startStdioMcpBridge().catch((err) => {
    process.stderr.write(`pi-harness mcp-bridge error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
