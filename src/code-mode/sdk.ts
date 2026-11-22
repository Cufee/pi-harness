import type { ToolDefinition } from "../runners/types.js";

import { sandboxAvailable } from "./sandbox.js";

export type CodeMode = "collapsed" | "hybrid" | "off";

export function effectiveCodeMode(requested: CodeMode): CodeMode {
  return requested !== "off" && sandboxAvailable() ? requested : "off";
}

export const CODE_EXEC_TOOL_NAME = "code_exec";
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export const CODE_EXEC_TOOL: ToolDefinition = {
  name: CODE_EXEC_TOOL_NAME,
  description: 'Chain allowed tools in a Bun TypeScript script with top-level await. Use import { ... } from "harness" and output(value) to return JSON. Find signatures with tool_search. Each serialized IPC message must fit in 16 MiB. Cancellation stops the script, not tool actions already started.',
  inputSchema: {
    type: "object",
    required: ["code"],
    properties: {
      code: { type: "string", description: "TypeScript source with top-level await and output(value) support." },
      timeout_s: { type: "number", description: "Execution timeout in seconds. Omit to use the configured default." },
    },
  },
};

export const TOOL_SEARCH_TOOL: ToolDefinition = {
  name: TOOL_SEARCH_TOOL_NAME,
  description: "Find allowed harness tools and return their TypeScript signatures for code_exec. Omit filters to list all script tools.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords to match against tool names and descriptions." },
      names: { type: "array", items: { type: "string" }, description: "Exact tool names to look up." },
    },
  },
};

export function exposedTools(allowed: ToolDefinition[], mode: CodeMode): ToolDefinition[] {
  if (effectiveCodeMode(mode) === "off") return allowed;
  if (mode === "collapsed") return [TOOL_SEARCH_TOOL, CODE_EXEC_TOOL];
  return [...allowed.filter((tool) => !isCodeModeTool(tool.name)), TOOL_SEARCH_TOOL, CODE_EXEC_TOOL];
}

function isCodeModeTool(name: string): boolean {
  return name === CODE_EXEC_TOOL_NAME || name === TOOL_SEARCH_TOOL_NAME;
}

// Function declarations need a strict-mode binding name, not just a JS property name.
const reservedBindings = new Set(
  ("abstract arguments await break case catch class const continue debugger default delete do else enum eval export extends " +
    "false finally for function if implements import in instanceof interface let new null package private protected public " +
    "return static super switch this throw true try typeof var void while with yield").split(" "),
);

function scriptTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.filter(({ name }) =>
    !isCodeModeTool(name) && name !== "output" && /^[A-Za-z_$][\w$]*$/.test(name) && !reservedBindings.has(name),
  );
}

function schemaObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function comment(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return `/** ${value.replace(/[\r\n\u2028\u2029]+/g, " ").replaceAll("*/", "* /")} */ `;
}

function quote(value: string): string {
  return JSON.stringify(value).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function schemaType(value: unknown): string {
  const schema = schemaObject(value);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map((item) => {
      if (typeof item === "string") return quote(item);
      if (item === null || typeof item === "boolean" || Number.isFinite(item)) return String(item);
      return "unknown";
    }).join(" | ");
  }
  switch (schema.type) {
    case "string":
    case "boolean":
    case "null":
    case "number": return schema.type;
    case "integer": return "number";
    case "array": return `Array<${schemaType(schema.items)}>`;
    case "object": {
      const properties = schemaObject(schema.properties);
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const keys = [...new Set([...Object.keys(properties), ...[...required].filter((key) => typeof key === "string")])];
      if (!keys.length) return "Record<string, unknown>";
      const fields = keys.map((key) => {
        const property = Object.hasOwn(properties, key) ? schemaObject(properties[key]) : {};
        const name = /^[A-Za-z_$][\w$]*$/.test(key) ? key : quote(key);
        return `${comment(property.description)}${name}${required.has(key) ? "" : "?"}: ${schemaType(property)};`;
      });
      return `{ ${fields.join(" ")} }`;
    }
    default: return "unknown";
  }
}

export function generateSdkDeclarations(tools: ToolDefinition[]): string {
  const signatures = scriptTools(tools).map((tool) =>
    `  ${comment(tool.description)}export function ${tool.name}(input: ${schemaType(tool.inputSchema)}): Promise<unknown>;`,
  );
  return ['declare module "harness" {', ...signatures, "  export function output(value: unknown): void;", "}", ""].join("\n");
}

export function toolSearch(allowed: ToolDefinition[], args: { query?: string; names?: string[] }): { signatures: string; matched: string[] } {
  const terms = args.query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  const names = new Set(args.names);
  const tools = scriptTools(allowed).filter((tool) => {
    const text = `${tool.name} ${tool.description}`.toLowerCase();
    return (!names.size || names.has(tool.name)) && terms.every((term) => text.includes(term));
  });
  return { signatures: generateSdkDeclarations(tools), matched: tools.map(({ name }) => name) };
}

export function codeModePromptSection(mode: CodeMode): string {
  if (effectiveCodeMode(mode) === "off") return "";
  return [
    "## Code Mode",
    mode === "hybrid" ? "Call harness tools directly for single calls, or use code_exec to combine calls in a script." :
      "Use code_exec to call harness tools from a script.",
    'Find allowed tools with tool_search. In code_exec, use `import { ... } from "harness"`, top-level await, and output(value) for the final JSON result.',
    "Set timeout_s for long waits (default 60s, maximum 600s unless configured lower). Results over the inline limit (default 20,000 characters) return a preview and artifact path.",
  ].join("\n\n");
}
