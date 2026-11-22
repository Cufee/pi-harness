import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAdapterKind, AcpProfileConfig } from "../config.js";
import type { ArtifactRecord } from "../control-plane/db.js";

export interface PreparedAcpSpawn {
  command: string;
  args: string[];
  env: Record<string, string>;
  cleanup: () => void;
  /** True if system prompt was NOT injected via env/native and must be prepended to turn 1 */
  prependSystemPromptToTurn1: boolean;
}

export interface AcpMcpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

/**
 * Implements the 4 verified per-adapter shims discovered in our live ACP audit:
 * 1. System prompt injection (Claude native, Codex append, Gemini GEMINI_SYSTEM_MD env shim)
 * 2. Model & effort selection (Claude session/new configOptions, Codex post-new set_config_option, Gemini set_model)
 * 3. Strict read-only & anti-subagent guards (Claude disallowedTools, Codex read-only + multi_agent=false, Gemini plan + fs proxy)
 * 4. Artifact indexing off kind + locations + content.diff (rawInput/rawOutput optional because Gemini omits them)
 */
export function prepareAcpSpawn(
  profile: AcpProfileConfig,
  opts: {
    systemPrompt: string;
    readOnly: boolean;
  },
): PreparedAcpSpawn {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  if (profile.env) {
    Object.assign(env, profile.env);
  }

  const args = [...(profile.args ?? [])];
  const tempDirs: string[] = [];
  let prependSystemPromptToTurn1 = false;

  if (profile.adapter === "claude") {
    // Prevent silent auto-compaction so harness controls clean rollover via usage_update
    env.DISABLE_COMPACT = "1";
  } else if (profile.adapter === "codex") {
    // Block Codex's internal multi_agent subagents so all subagents stay in our harness tree
    args.push("-c", "features.multi_agent=false");
    if (opts.readOnly) {
      env.INITIAL_AGENT_MODE = "read-only";
    }
  } else if (profile.adapter === "gemini") {
    // Shim 1: gemini --acp ignores NewSessionRequest.systemPrompt; use GEMINI_SYSTEM_MD
    const dir = mkdtempSync(join(tmpdir(), "pi-harness-gemini-"));
    tempDirs.push(dir);
    const mdPath = join(dir, "system.md");
    writeFileSync(mdPath, opts.systemPrompt, "utf8");
    env.GEMINI_SYSTEM_MD = mdPath;
  } else {
    prependSystemPromptToTurn1 = true;
  }

  if (opts.readOnly && profile.readOnlyArgs?.length) {
    args.push(...profile.readOnlyArgs);
  }

  return {
    command: profile.command,
    args,
    env,
    prependSystemPromptToTurn1,
    cleanup: () => {
      for (const dir of tempDirs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    },
  };
}

export function buildNewSessionParams(
  adapter: AcpAdapterKind,
  opts: {
    cwd: string;
    systemPrompt: string;
    readOnly: boolean;
    model?: string | null;
    effort?: string | null;
    mcpServers: AcpMcpServerEntry[];
    agentCapabilities?: Record<string, unknown>;
  },
): { params: Record<string, unknown>; needsTurn1SystemPrompt: boolean } {
  const params: Record<string, unknown> = {
    cwd: opts.cwd,
    mcpServers: opts.mcpServers,
  };

  const sessionCaps = (opts.agentCapabilities?.sessionCapabilities ?? {}) as Record<string, unknown>;
  let needsTurn1SystemPrompt = false;

  // Shim 1: System Prompt
  if (adapter === "claude" || adapter === "codex") {
    params.systemPrompt = {
      mode: "append",
      content: [{ type: "text", text: opts.systemPrompt }],
    };
  } else if (adapter === "generic") {
    if (sessionCaps.systemPrompt) {
      params.systemPrompt = {
        mode: "append",
        content: [{ type: "text", text: opts.systemPrompt }],
      };
    } else {
      needsTurn1SystemPrompt = true;
    }
  }

  // Shim 2 & 3 for Claude: initial configOptions + disallowedTools via _meta.claudeCode.options
  if (adapter === "claude") {
    const disallowed = ["Agent", "Task"];
    if (opts.readOnly) {
      disallowed.push("Write", "Edit", "MultiEdit", "NotebookEdit", "Bash");
    }
    const claudeOptions: Record<string, unknown> = {
      disallowedTools: disallowed,
      settings: { autoCompactEnabled: false },
    };
    if (opts.model) claudeOptions.model = opts.model;
    if (opts.effort) claudeOptions.effort = opts.effort;

    params._meta = {
      claudeCode: {
        options: claudeOptions,
      },
    };

    if (sessionCaps.options) {
      const cfg: Array<{ configId: string; value: string }> = [];
      if (opts.model) cfg.push({ configId: "model", value: opts.model });
      if (opts.effort) cfg.push({ configId: "effort", value: opts.effort });
      if (cfg.length > 0) params.configOptions = cfg;
    }
  }

  return { params, needsTurn1SystemPrompt };
}

export interface PostSessionAction {
  method: "session/set_mode" | "session/set_config_option" | "session/set_model";
  params: Record<string, unknown>;
}

/**
 * Computes post-`session/new` configuration calls (model, effort, read-only mode)
 * tailored to each adapter's verified ACP behavior.
 */
export function buildPostSessionActions(
  adapter: AcpAdapterKind,
  sessionId: string,
  newSessionResponse: Record<string, unknown>,
  opts: { readOnly: boolean; model?: string | null; effort?: string | null },
): PostSessionAction[] {
  const actions: PostSessionAction[] = [];
  const configOptions = (newSessionResponse.configOptions ?? []) as Array<{
    id: string;
    category?: string;
    options?: Array<{ value: string }>;
  }>;

  // Read-only mode selection (and automatic bypass permission for writable autonomous workers when supported, e.g. amp-acp)
  if (opts.readOnly) {
    if (adapter === "codex") {
      actions.push({ method: "session/set_mode", params: { sessionId, modeId: "read-only" } });
    } else if (adapter === "claude" || adapter === "gemini") {
      actions.push({ method: "session/set_mode", params: { sessionId, modeId: "plan" } });
    }
  } else {
    const permOpt = configOptions.find(
      (c) => c.id === "permission" && c.options?.some((o) => o.value === "bypass"),
    );
    if (permOpt) {
      actions.push({
        method: "session/set_config_option",
        params: { sessionId, configId: permOpt.id, value: "bypass" },
      });
    }
  }

  // Model & effort selection
  if (adapter === "gemini") {
    if (opts.model) {
      actions.push({ method: "session/set_model", params: { sessionId, modelId: opts.model } });
    }
    return actions;
  }

  const modelOpt = configOptions.find((c) => c.category === "model" || c.id === "model");
  const effortOpt = configOptions.find(
    (c) => c.category === "thought_level" || c.id === "reasoning_effort" || c.id === "effort",
  );

  // Codex does not apply initial session.options on session/new — set model first, then reasoning_effort
  if (opts.model && (adapter === "codex" || (adapter !== "claude" && modelOpt))) {
    // Resolve canonical catalog IDs like `"openai/gpt-6.2-astra"` to the adapter's exact option value (`"gpt-6.2-astra"`)
    let resolvedModel = opts.model;
    const bare = opts.model.includes("/") ? opts.model.slice(opts.model.indexOf("/") + 1) : opts.model;
    if (modelOpt?.options?.length) {
      const exact = modelOpt.options.find((o) => o.value === opts.model);
      const bareMatch = !exact ? modelOpt.options.find((o) => o.value === bare) : undefined;
      if (bareMatch) resolvedModel = bareMatch.value;
    } else if (adapter === "codex") {
      resolvedModel = bare;
    }
    actions.push({
      method: "session/set_config_option",
      params: { sessionId, configId: modelOpt?.id ?? "model", value: resolvedModel },
    });
  }
  if (opts.effort && (adapter === "codex" || (adapter !== "claude" && effortOpt))) {
    actions.push({
      method: "session/set_config_option",
      params: {
        sessionId,
        configId: effortOpt?.id ?? (adapter === "codex" ? "reasoning_effort" : "effort"),
        value: opts.effort,
      },
    });
  }

  return actions;
}

/**
 * Shim 4: Extracts deterministic Artifact Index entries from ACP tool_call / tool_call_update
 * strictly relying on `kind`, `locations`, and `content` (`diff`) — never requiring `rawInput`/`rawOutput`
 * (since `gemini --acp` omits both).
 */
export function extractArtifactsFromToolUpdate(
  update: Record<string, unknown>,
): Array<Omit<ArtifactRecord, "id" | "runId" | "taskId" | "createdAt">> {
  const results: Array<Omit<ArtifactRecord, "id" | "runId" | "taskId" | "createdAt">> = [];
  const status = String(update.status ?? "");
  if (status !== "completed" && status !== "failed") return results;

  const acpKind = String(update.kind ?? "other");
  const title = String(update.title ?? update.name ?? "tool");
  const locations = (update.locations ?? []) as Array<{ path?: string; line?: number }>;
  const content = (update.content ?? []) as Array<Record<string, unknown>>;

  const mappedKind: ArtifactRecord["kind"] | null =
    acpKind === "read" || acpKind === "search"
      ? "read"
      : acpKind === "edit" || acpKind === "move"
        ? "edit"
        : acpKind === "delete"
          ? "delete"
          : acpKind === "execute"
            ? "execute"
            : null;

  if (!mappedKind) return results;

  // Prefer structured diff content paths first
  const seenPaths = new Set<string>();
  for (const item of content) {
    if (item.type === "diff" && typeof item.path === "string" && item.path) {
      seenPaths.add(item.path);
      results.push({
        kind: "edit",
        path: item.path,
        summary: `${title} (${status})`,
        gitSha: null,
        exitCode: null,
      });
    }
  }

  for (const loc of locations) {
    if (typeof loc.path === "string" && loc.path && !seenPaths.has(loc.path)) {
      seenPaths.add(loc.path);
      results.push({
        kind: mappedKind,
        path: loc.path,
        summary: `${title}${loc.line ? `:${loc.line}` : ""} (${status})`,
        gitSha: null,
        exitCode: null,
      });
    }
  }

  if (mappedKind === "execute" && results.length === 0) {
    results.push({
      kind: "execute",
      path: title,
      summary: `${title} (${status})`,
      gitSha: null,
      exitCode: status === "completed" ? 0 : 1,
    });
  }

  return results;
}
