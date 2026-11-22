import type { ToolDefinition } from "../runners/types.js";
import { runCodeExec, timeoutMs, type CodeExecOptions, type CodeExecToolEvent } from "./runner.js";
import { sandboxAvailable, sandboxUnavailableReason } from "./sandbox.js";
import { CODE_EXEC_TOOL_NAME, TOOL_SEARCH_TOOL_NAME, exposedTools, toolSearch, type CodeMode } from "./sdk.js";

export * from "./sdk.js";
export { runCodeExec, type CodeExecOptions, type CodeExecResult, type CodeExecToolEvent } from "./runner.js";
export { sandboxUnavailableReason } from "./sandbox.js";

type Context = Omit<CodeExecOptions, "code" | "timeoutMs">;

function dispatch(name: string, args: Record<string, unknown>, ctx: Context, defaultMs?: number, maxMs?: number): Promise<unknown> | undefined {
  if (name !== TOOL_SEARCH_TOOL_NAME && name !== CODE_EXEC_TOOL_NAME) return undefined;
  if (!sandboxAvailable()) return Promise.reject(new Error(sandboxUnavailableReason() ?? "Code Mode sandbox unavailable on this host"));
  if (name === TOOL_SEARCH_TOOL_NAME) {
    if ((args.query !== undefined && typeof args.query !== "string") ||
        (args.names !== undefined && !(Array.isArray(args.names) && args.names.every(n => typeof n === "string")))) {
      return Promise.reject(new Error("tool_search expects query: string or names: string[]"));
    }
    return Promise.resolve(toolSearch(ctx.tools, args));
  }
  if (typeof args.code !== "string") return Promise.reject(new Error("code_exec expects a code string"));
  if (args.timeout_s !== undefined && (typeof args.timeout_s !== "number" || !Number.isFinite(args.timeout_s) || args.timeout_s <= 0)) {
    return Promise.reject(new Error("timeout_s must be a positive number"));
  }
  const maxSec = (maxMs ?? 1_800_000) / 1000;
  const ms = args.timeout_s === undefined ? defaultMs : Math.min(maxSec, args.timeout_s as number) * 1000;
  return runCodeExec({ ...ctx, code: args.code, timeoutMs: timeoutMs(ms, maxMs) });
}

export function handleCodeModeTool(name: string, args: Record<string, unknown>, ctx: Context): Promise<unknown> | undefined {
  return dispatch(name, args, ctx);
}

export interface CodeModeExecutorOptions {
  mode: CodeMode;
  allowedTools: () => ToolDefinition[];
  execute: CodeExecOptions["callTool"];
  artifactsDir: string;
  saveOutput?: CodeExecOptions["saveOutput"];
  signal?: AbortSignal;
  defaultTimeoutMs?: number; maxTimeoutMs?: number; maxOutputChars?: number;
  onToolEvent?: (ev: CodeExecToolEvent) => void;
}

export function createCodeModeExecutor(opts: CodeModeExecutorOptions) {
  return {
    tools: () => exposedTools(opts.allowedTools(), opts.mode),
    async execute(name: string, args: Record<string, unknown>): Promise<unknown> {
      if (opts.mode !== "off" && (name === CODE_EXEC_TOOL_NAME || name === TOOL_SEARCH_TOOL_NAME)) {
        return dispatch(name, args, {
          tools: opts.allowedTools(), callTool: opts.execute, artifactsDir: opts.artifactsDir,
          saveOutput: opts.saveOutput, signal: opts.signal, maxOutputChars: opts.maxOutputChars, onToolEvent: opts.onToolEvent,
        }, opts.defaultTimeoutMs, opts.maxTimeoutMs);
      }
      return opts.execute(name, args);
    },
  };
}
