import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpAdapterKind, AcpProfileConfig } from "../config.js";
import type { ArtifactRecord } from "../control-plane/db.js";
import type { ToolPolicy } from "./types.js";

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

export function isAmpAcpProfile(profile: Pick<AcpProfileConfig, "id" | "adapter" | "command" | "args">): boolean {
  if (profile.adapter !== "generic") return false;
  const hay = [profile.id, profile.command, ...(profile.args ?? [])].join(" ").toLowerCase();
  return hay.includes("amp-acp") || /\bamp\b/.test(profile.id.toLowerCase());
}

export function prepareAcpSpawn(
  profile: AcpProfileConfig,
  opts: {
    systemPrompt: string;
    toolPolicy: ToolPolicy;
    allowShellInReadOnly?: boolean;
  },
): PreparedAcpSpawn {
  if (profile.enabled === false) throw new Error(`Runner profile "${profile.id}" is disabled.`);
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
    // Block Codex's internal multi_agent subagents via BOTH CLI flag and CODEX_CONFIG JSON
    // (codex-acp v2.9+ reads features from CODEX_CONFIG and can otherwise shadow harness MCP from ~/.codex/config.toml).
    args.push("-c", "features.multi_agent=false");
    let existingCodexCfg: Record<string, unknown> = {};
    if (env.CODEX_CONFIG) {
      try {
        const parsed = JSON.parse(env.CODEX_CONFIG);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existingCodexCfg = parsed as Record<string, unknown>;
        }
      } catch {
        // ignore invalid user CODEX_CONFIG JSON
      }
    }
    const existingFeatures =
      existingCodexCfg.features && typeof existingCodexCfg.features === "object" && !Array.isArray(existingCodexCfg.features)
        ? (existingCodexCfg.features as Record<string, unknown>)
        : {};
    env.CODEX_CONFIG = JSON.stringify({
      ...existingCodexCfg,
      features: { ...existingFeatures, multi_agent: false },
    });
    env.DISABLE_MCP_CONFIG_FILTERING = "true";
    if (opts.toolPolicy !== "read_write_workspace") env.INITIAL_AGENT_MODE = "read-only";
  } else if (profile.adapter === "gemini") {
    // Shim 1: gemini --acp ignores NewSessionRequest.systemPrompt; use GEMINI_SYSTEM_MD
    const dir = mkdtempSync(join(tmpdir(), "pi-harness-gemini-"));
    tempDirs.push(dir);
    const mdPath = join(dir, "system.md");
    writeFileSync(mdPath, opts.systemPrompt, "utf8");
    env.GEMINI_SYSTEM_MD = mdPath;
  } else {
    prependSystemPromptToTurn1 = true;
    // Amp ACP (`amp-acp`) never sends `session/request_permission` callbacks; enforce control-plane / read-only
    // tool boundaries cleanly via a temporary AMP_SETTINGS_FILE!
    if (isAmpAcpProfile(profile) && opts.toolPolicy !== "read_write_workspace") {
      const dir = mkdtempSync(join(tmpdir(), "pi-harness-amp-"));
      tempDirs.push(dir);
      const settingsPath = join(dir, "settings.json");
      const ampSettings: Record<string, unknown> =
        opts.toolPolicy === "control_plane_only"
          ? {
              "amp.tools.enable": ["mcp__harness__*"],
              "amp.tools.disable": [
                "Bash",
                "shell_command",
                "Read",
                "Grep",
                "glob",
                "edit_file",
                "create_file",
                "delete_file",
                "Task",
                "finder",
                "oracle",
                "librarian",
              ],
            }
          : {
              // Allow shell execution (e.g. `rg`, `sg`/`ast-grep`, `git diff`, `bun test`, `tmux`) only when explicitly
              // permitted (verify/Done-Review in isolated checkouts); otherwise keep Tier 1/read-only shell-free on host repo.
              "amp.tools.disable": opts.allowShellInReadOnly
                ? ["edit_file", "create_file", "delete_file", "Task"]
                : ["Bash", "shell_command", "edit_file", "create_file", "delete_file", "Task"],
            };
      writeFileSync(settingsPath, JSON.stringify(ampSettings, null, 2), "utf8");
      env.AMP_SETTINGS_FILE = settingsPath;
    }
  }

  if (opts.toolPolicy !== "read_write_workspace" && profile.readOnlyArgs?.length) {
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
    toolPolicy: ToolPolicy;
    allowShellInReadOnly?: boolean;
    model: string;
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
    if (opts.toolPolicy !== "read_write_workspace") {
      disallowed.push("Write", "Edit", "MultiEdit", "NotebookEdit");
      if (!opts.allowShellInReadOnly) disallowed.push("Bash");
    }
    if (opts.toolPolicy === "control_plane_only") {
      disallowed.push("Read", "Grep", "Glob");
      if (!disallowed.includes("Bash")) disallowed.push("Bash");
    }
    const effectiveEffort =
      opts.effort && opts.effort.toLowerCase() !== "default" ? opts.effort : undefined;
    const claudeOptions: Record<string, unknown> = {
      disallowedTools: disallowed,
      ...(opts.toolPolicy !== "read_write_workspace" ? {
        settingSources: [],
        strictMcpConfig: true,
        allowDangerouslySkipPermissions: false,
      } : {}),
      ...(opts.toolPolicy === "control_plane_only" ? {
        tools: [],
      } : {}),
      settings: { autoCompactEnabled: false },
    };
    claudeOptions.model = opts.model;
    if (effectiveEffort) claudeOptions.effort = effectiveEffort;

    params._meta = {
      claudeCode: {
        options: claudeOptions,
      },
    };

    if (sessionCaps.options) {
      const cfg: Array<{ configId: string; value: string }> = [];
      cfg.push({ configId: "model", value: opts.model });
      if (effectiveEffort) cfg.push({ configId: "effort", value: effectiveEffort });
      if (cfg.length > 0) params.configOptions = cfg;
    }
  }

  if (adapter === "codex" && opts.mcpServers.length > 0) {
    // Ensure codex-acp awaits harness MCP bridge startup before Turn 1 instead of racing.
    const envAwait = Number(process.env.PI_HARNESS_MCP_AWAIT_MS);
    params._meta = {
      mcpStartupAwaitTimeoutMs: Number.isFinite(envAwait) && envAwait > 0 ? envAwait : 15_000,
    };
  }

  return { params, needsTurn1SystemPrompt };
}

export interface PostSessionAction {
  method: "session/set_config_option" | "session/set_model";
  params: Record<string, unknown>;
  /** Prompting is unsafe unless this setter succeeds for the exact wire ID. */
  requiredModel?: string;
}

interface SelectValue { value: string; name?: string }

export interface AcpConfigOption {
  id: string;
  category?: string;
  currentValue?: unknown;
  options?: Array<SelectValue | { options: SelectValue[] }>;
}

export function selectValues(option?: AcpConfigOption): SelectValue[] | undefined {
  return option?.options?.flatMap((item) => "options" in item ? item.options : [item]);
}

export interface AcpModelState {
  configOptions?: AcpConfigOption[];
  models?: { currentModelId?: string; availableModels?: Array<{ modelId: string }> };
}

export function reportedModels(state: AcpModelState, modelConfigIds = new Set(["model"])): unknown[] {
  for (const option of state.configOptions ?? []) {
    if (option.category === "model") modelConfigIds.add(option.id);
  }
  const values = state.configOptions
    ?.filter((option) => modelConfigIds.has(option.id))
    .map((option) => option.currentValue) ?? [];
  const legacyId = state.models?.currentModelId;
  // Codex legacy `models.currentModelId` appends `[effort]` (e.g. `gpt-6.2-astra[medium]`) while
  // `configOptions` reports the bare model ID (`gpt-6.2-astra`). Do not treat that as a mismatch.
  const normalizedLegacy =
    typeof legacyId === "string" && values.some((v) => typeof v === "string" && legacyId.startsWith(`${v}[`))
      ? undefined
      : legacyId;
  return [...values, normalizedLegacy].filter((value) => value !== undefined);
}

/**
 * Computes post-`session/new` configuration calls (model and effort)
 * tailored to each adapter's verified ACP behavior.
 */
export function buildPostSessionActions(
  adapter: AcpAdapterKind,
  sessionId: string,
  newSessionResponse: AcpModelState,
  opts: { toolPolicy: ToolPolicy; model: string; effort?: string | null },
  modelConfigIds = new Set(["model"]),
): PostSessionAction[] {
  const actions: PostSessionAction[] = [];
  const configOptions = newSessionResponse.configOptions ?? [];
  const legacyModels = newSessionResponse.models;

  const modelOpt = configOptions.find((c) => c.category === "model" || c.id === "model");
  const effortOpt = configOptions.find(
    (c) => c.category === "thought_level" || c.id === "reasoning_effort" || c.id === "effort",
  );

  const model = opts.model;
  if (!model?.trim()) throw new Error(`${adapter}: a nonblank wire model ID is required`);
  // Never translate the catalog's selected wire ID. Check the list belonging to
  // the setter we will use, not the union of two potentially different lists.
  const useConfig = modelOpt !== undefined || adapter === "codex" || (adapter === "claude" && !legacyModels);
  const configIds = selectValues(modelOpt)?.map((o) => o.value);
  const legacyIds = legacyModels?.availableModels?.map((m) => m.modelId);
  const advertised = useConfig ? configIds ?? legacyIds : legacyIds ?? configIds;
  if (advertised && !advertised.includes(model)) {
    throw new Error(`${adapter}: requested model '${model}' is not advertised by this session`);
  }
  const current = reportedModels(newSessionResponse, modelConfigIds);
  if (!current.length || current.some((value) => value !== model)) {
    actions.push(useConfig
      ? { method: "session/set_config_option", params: { sessionId, configId: modelOpt?.id ?? "model", value: model }, requiredModel: model }
      : { method: "session/set_model", params: { sessionId, modelId: model }, requiredModel: model });
  }

  // Effort selection: only send a value the adapter advertises; skip cleanly otherwise
  if (opts.effort && opts.effort.toLowerCase() !== "default") {
    const wanted = opts.effort.toLowerCase();
    const efforts = selectValues(effortOpt);
    if (effortOpt && efforts?.length) {
      const match = efforts.find(
        (o) => o.value.toLowerCase() === wanted || o.name?.toLowerCase() === wanted,
      );
      if (match && match.value !== effortOpt.currentValue) {
        actions.push({
          method: "session/set_config_option",
          params: { sessionId, configId: effortOpt.id, value: match.value },
        });
      }
    } else if (adapter === "codex") {
      // Codex advertises nothing to validate against before set_config_option: keep its verified config id
      actions.push({
        method: "session/set_config_option",
        params: { sessionId, configId: effortOpt?.id ?? "reasoning_effort", value: opts.effort },
      });
    }
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
