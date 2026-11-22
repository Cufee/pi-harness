import { accessSync, constants, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

const AMP_READ_ONLY_DISABLED_TOOLS = [
  "edit_file",
  "create_file",
  "delete_file",
  "apply_patch",
  "Task",
  "create_thread",
  "send_thread_message",
  "wait_for_threads",
  "finder",
  "oracle",
  "librarian",
];

const AMP_READ_ONLY_SHELL_REJECT_PATTERNS = [
  "*>*",
  "*;*",
  "*&&*",
  "*||*",
  "*$(*",
  "*`*",
  "*\n*",
  "*--output*",
  "*-exec*",
  "*-ok*",
  "*-delete*",
  "*-fprint*",
  "*-fls*",
  "*sed *-i*",
  "*sed *--in-place*",
  "*-U*",
  "*--update-all*",
  "*--rewrite*",
  "*--interactive*",
  "*branch -d*",
  "*branch -D*",
  "*branch -m*",
  "*branch -M*",
  "*branch -c*",
  "*branch -C*",
  "*branch --delete*",
  "*branch --move*",
  "*branch --copy*",
  "*branch --edit*",
  "*branch --set-*",
  "*| *sh *",
  "*| *sh",
  "*|sh *",
  "*|sh",
  "*| *bash*",
  "*|bash*",
  "*| *zsh*",
  "*|zsh*",
  "*| *tee *",
  "*|tee *",
  "*| *xargs*",
  "*|xargs*",
  "*| *dd *",
  "*|dd *",
  "*| *rm *",
  "*|rm *",
  "*| *mv *",
  "*|mv *",
  "*| *cp *",
  "*|cp *",
  "*| *chmod*",
  "*|chmod*",
  "*| *chown*",
  "*|chown*",
  "*| *python*",
  "*|python*",
  "*| *node*",
  "*|node*",
  "*| *bun*",
  "*|bun*",
  "*| *perl*",
  "*|perl*",
  "*| *ruby*",
  "*|ruby*",
  "*| *awk*",
  "*|awk*",
  "*| *sqlite3*",
  "*|sqlite3*",
];

const AMP_READ_ONLY_SHELL_ALLOW_PATTERNS = [
  "rg",
  "rg *",
  "sg *",
  "ast-grep *",
  "cat *",
  "head *",
  "tail *",
  "nl *",
  "sed -n *",
  "wc *",
  "ls",
  "ls *",
  "find *",
  "tree",
  "tree *",
  "stat *",
  "file *",
  "pwd",
  "which *",
  "readlink *",
  "realpath *",
  "basename *",
  "dirname *",
  "grep *",
  "diff *",
  "cmp *",
  "md5 *",
  "shasum *",
  "sha256sum *",
  "jq *",
  "sort *",
  "uniq *",
  "cut *",
  "tr *",
  "git status",
  "git status *",
  "git log",
  "git log *",
  "git show",
  "git show *",
  "git diff",
  "git diff *",
  "git rev-parse *",
  "git ls-files",
  "git ls-files *",
  "git ls-tree *",
  "git grep *",
  "git blame *",
  "git describe *",
  "git tag",
  "git tag -l*",
  "git tag --list*",
  "git branch",
  "git branch -l*",
  "git branch --list*",
  "git branch -a*",
  "git branch -r*",
  "git branch -v*",
  "git branch --show-current*",
  "git remote -v*",
  "git cat-file *",
  "git merge-base *",
  "git shortlog*",
  "git rev-list *",
  "sqlite3 -readonly *",
];

function isExecutableBinary(filePath: string): boolean {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinaryInDirs(binaryName: string, dirs: Iterable<string>): string | null {
  const candidates = process.platform === "win32" ? [binaryName, `${binaryName}.exe`] : [binaryName];
  const seen = new Set<string>();
  for (const rawDir of dirs) {
    const dir = rawDir.trim();
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    for (const name of candidates) {
      const full = join(dir, name);
      if (isExecutableBinary(full)) return full;
    }
  }
  return null;
}

/**
 * Checks whether `codex-code-mode-host` is discoverable on `PATH` or alongside the Codex ACP binary
 * (including the binary's resolved symlink target directory).
 */
export function hasCodexCodeModeHost(command: string, env: Record<string, string | undefined>): boolean {
  const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  const searchDirs: string[] = [];

  const trimmed = command.trim();
  if (trimmed) {
    let resolvedCmd: string | null = null;
    if (trimmed.includes("/") || trimmed.includes("\\")) {
      searchDirs.push(dirname(trimmed));
      if (isExecutableBinary(trimmed)) resolvedCmd = trimmed;
    } else {
      resolvedCmd = findBinaryInDirs(trimmed, pathDirs);
      if (resolvedCmd) searchDirs.push(dirname(resolvedCmd));
    }
    if (resolvedCmd) {
      try {
        const real = realpathSync(resolvedCmd);
        searchDirs.push(dirname(real));
      } catch {
        // ignore symlink resolution errors
      }
    }
  }

  searchDirs.push(...pathDirs);
  return findBinaryInDirs("codex-code-mode-host", searchDirs) !== null;
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
    const hasExplicitCodeModeHost =
      existingFeatures.code_mode_host !== undefined ||
      args.some((a) => /(?:^|\s)features\.code_mode_host\s*=/.test(a));
    const disableCodeModeHost = !hasExplicitCodeModeHost && !hasCodexCodeModeHost(profile.command, env);
    if (disableCodeModeHost) {
      // Codex CLI 0.170+ fails closed on MCP tools if `codex-code-mode-host` is absent and code_mode_host stays enabled.
      args.push("-c", "features.code_mode_host=false");
    }
    env.CODEX_CONFIG = JSON.stringify({
      ...existingCodexCfg,
      features: {
        ...existingFeatures,
        multi_agent: false,
        ...(disableCodeModeHost ? { code_mode_host: false } : {}),
      },
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
    if (
      opts.toolPolicy === "read_write_workspace" &&
      !args.some((a) => a === "--yolo" || a === "-y" || a.startsWith("--approval-mode"))
    ) {
      args.push("--approval-mode=yolo");
    }
  } else {
    prependSystemPromptToTurn1 = true;
    // Amp ACP (`amp-acp`) never sends `session/request_permission` callbacks; configure unattended permissions
    // and control-plane / read-only boundaries cleanly via a temporary AMP_SETTINGS_FILE!
    if (isAmpAcpProfile(profile)) {
      const dir = mkdtempSync(join(tmpdir(), "pi-harness-amp-"));
      tempDirs.push(dir);
      const settingsPath = join(dir, "settings.json");
      const ampSettings: Record<string, unknown> =
        opts.toolPolicy === "read_write_workspace"
          ? {
              "amp.dangerouslyAllowAll": true,
            }
          : opts.toolPolicy === "control_plane_only"
            ? {
                "amp.dangerouslyAllowAll": false,
                "amp.tools.enable": ["mcp__harness__*"],
                "amp.tools.disable": [
                  "Bash",
                  "shell_command",
                  "shell_command_status",
                  "shell_command_kill",
                  "Read",
                  "Grep",
                  "glob",
                  ...AMP_READ_ONLY_DISABLED_TOOLS,
                ],
                "amp.permissions": [{ tool: "mcp__harness__*", action: "allow" }],
              }
            : opts.allowShellInReadOnly
              ? {
                  // Disposable verification checkout (verify / Done-Review): keep shell and harness MCP unrestricted
                  // for tests/linters/tmux while hiding and rejecting file-editing and subagent tools.
                  "amp.dangerouslyAllowAll": false,
                  "amp.tools.disable": AMP_READ_ONLY_DISABLED_TOOLS,
                  "amp.permissions": [
                    { tool: "mcp__harness__*", action: "allow" },
                    ...AMP_READ_ONLY_DISABLED_TOOLS.map((tool) => ({ tool, action: "reject" })),
                    { tool: "shell_command", action: "allow" },
                    { tool: "Bash", action: "allow" },
                  ],
                }
              : {
                  // Modern Amp CLI exposes no native Read/Grep/glob tools — file inspection goes through `shell_command`.
                  // Instead of disabling `shell_command` (which blinds read-only Amp agents, see esc-19/esc-20), keep
                  // write/subagent tools disabled/rejected and enforce a strict read-only `amp.permissions` allowlist for shell tools.
                  "amp.dangerouslyAllowAll": false,
                  "amp.tools.disable": AMP_READ_ONLY_DISABLED_TOOLS,
                  "amp.permissions": [
                    { tool: "mcp__harness__*", action: "allow" },
                    ...AMP_READ_ONLY_DISABLED_TOOLS.map((tool) => ({ tool, action: "reject" })),
                    { tool: "shell_command", action: "reject", matches: { command: AMP_READ_ONLY_SHELL_REJECT_PATTERNS } },
                    { tool: "shell_command", action: "allow", matches: { command: AMP_READ_ONLY_SHELL_ALLOW_PATTERNS } },
                    { tool: "shell_command", action: "reject" },
                    { tool: "Bash", action: "reject", matches: { cmd: AMP_READ_ONLY_SHELL_REJECT_PATTERNS } },
                    { tool: "Bash", action: "allow", matches: { cmd: AMP_READ_ONLY_SHELL_ALLOW_PATTERNS } },
                    { tool: "Bash", action: "reject" },
                  ],
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
      disallowed.push("Read", "Grep", "Glob", "WebFetch", "WebSearch", "Skill");
      if (!disallowed.includes("Bash")) disallowed.push("Bash");
    }
    const effectiveEffort =
      opts.effort && opts.effort.toLowerCase() !== "default" ? opts.effort : undefined;
    const hasHarnessMcp = opts.mcpServers.some((s) => s.name === "harness");
    const claudeOptions: Record<string, unknown> = {
      disallowedTools: disallowed,
      ...(hasHarnessMcp ? { allowedTools: ["ToolSearch", "mcp__harness__*"] } : {}),
      ...(opts.toolPolicy !== "read_write_workspace" ? {
        settingSources: [],
        strictMcpConfig: true,
        allowDangerouslySkipPermissions: false,
      } : {}),
      // Keep ToolSearch available in control_plane_only so Claude Code can load deferred MCP tools (mcp__harness__*)!
      ...(opts.toolPolicy === "control_plane_only" ? {
        tools: ["ToolSearch"],
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
  method: "session/set_config_option" | "session/set_model" | "session/set_mode";
  params: Record<string, unknown>;
  /** Prompting is unsafe unless this setter succeeds for the exact wire ID. */
  requiredModel?: string;
}

interface SelectValue { value: string; name?: string; description?: string }

const CLAUDE_VERSIONED_MODEL_RE = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:[.-]\d+)*)(?:-\d{8})?$/i;
const CLAUDE_EXPLICIT_METADATA_ID_RE = /\b(?:anthropic\/)?(claude-(opus|sonnet|haiku|fable)-(\d+(?:[.-]\d+)*)(?:-\d{8})?)\b/i;
const CLAUDE_OPTION_NAME_VERSION_RE = /\b(?:claude\s+)?(opus|sonnet|haiku|fable)\s+(\d+(?:[.-]\d+)*)\b/i;

/**
 * Checks whether a Claude ACP configOption entry (`{ value: "opus", name: "Opus 5.5" }`)
 * proves exact compatibility with a specific requested wire model ID (`"claude-opus-5-5"`).
 * Never matches an unversioned display name (`"Opus"`) or a different version (`"Opus 5.0"`).
 */
export function claudeOptionMatchesExactModel(opt: SelectValue, requestedModel: string): boolean {
  if (opt.value === requestedModel) return true;
  const reqMatch = requestedModel.trim().match(CLAUDE_VERSIONED_MODEL_RE);
  if (!reqMatch) return false;
  const reqFamily = reqMatch[1]!.toLowerCase();
  const reqVer = reqMatch[2]!.replace(/\./g, "-");
  for (const field of [opt.description, opt.name]) {
    if (!field) continue;
    const explicit = field.match(CLAUDE_EXPLICIT_METADATA_ID_RE);
    if (explicit) {
      const expFamily = explicit[2]!.toLowerCase();
      const expVer = explicit[3]!.replace(/\./g, "-");
      if (expFamily === reqFamily && expVer === reqVer) return true;
    }
  }
  if (!opt.name) return false;
  const optMatch = opt.name.match(CLAUDE_OPTION_NAME_VERSION_RE);
  if (!optMatch) return false;
  const optFamily = optMatch[1]!.toLowerCase();
  const optVer = optMatch[2]!.replace(/\./g, "-");
  return reqFamily === optFamily && reqVer === optVer;
}

/** Checks whether a reported current model value satisfies `requestedModel` given advertised options. */
export function reportedModelSatisfies(
  adapter: AcpAdapterKind,
  state: AcpModelState,
  reportedValue: unknown,
  requestedModel: string,
  fallbackState?: AcpModelState,
): boolean {
  if (reportedValue === requestedModel) return true;
  if (adapter !== "claude" || typeof reportedValue !== "string") return false;
  const findOpt = (st?: AcpModelState) =>
    selectValues(st?.configOptions?.find((c) => c.category === "model" || c.id === "model"))?.find(
      (o) => o.value === reportedValue,
    );
  const opt = findOpt(state) ?? findOpt(fallbackState);
  return opt ? claudeOptionMatchesExactModel(opt, requestedModel) : false;
}

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
  models?: { currentModelId?: string; availableModels?: Array<{ modelId: string; name?: string; description?: string }> };
  modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name?: string }> };
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
  const configOptionsList = selectValues(modelOpt);
  const configIds = configOptionsList?.map((o) => o.value);
  const legacyIds = legacyModels?.availableModels?.map((m) => m.modelId);
  const advertised = useConfig ? configIds ?? legacyIds : legacyIds ?? configIds;
  const claudeExactOptionMatch =
    adapter === "claude" && useConfig && configOptionsList
      ? configOptionsList.some((o) => claudeOptionMatchesExactModel(o, model))
      : false;
  if (advertised && !advertised.includes(model) && !claudeExactOptionMatch) {
    throw new Error(`${adapter}: requested model '${model}' is not advertised by this session`);
  }
  const current = reportedModels(newSessionResponse, modelConfigIds);
  if (!current.length || current.some((value) => !reportedModelSatisfies(adapter, newSessionResponse, value, model))) {
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

  // Unattended approval / yolo mode for writable workers (`read_write_workspace`):
  // if the ACP adapter advertises a `mode` option with a yolo/bypass value (Claude, Gemini, Antigravity, Codex),
  // switch into it automatically so unattended runs never stall waiting on manual permission prompts.
  if (opts.toolPolicy === "read_write_workspace") {
    const YOLO_PRIORITY = ["bypasspermissions", "yolo", "full-access", "full_access", "dontask", "auto"];
    const modeOpt = configOptions.find((c) => c.category === "mode" || c.id === "mode");
    const modeValues = selectValues(modeOpt);
    if (modeOpt && modeValues?.length) {
      const currentMode = String(modeOpt.currentValue ?? "").toLowerCase();
      if (!YOLO_PRIORITY.includes(currentMode)) {
        const picked = YOLO_PRIORITY.map((p) => modeValues.find((o) => o.value.toLowerCase() === p)).find(Boolean);
        if (picked && picked.value !== modeOpt.currentValue) {
          actions.push({
            method: "session/set_config_option",
            params: { sessionId, configId: modeOpt.id, value: picked.value },
          });
        }
      }
    } else if (newSessionResponse.modes?.availableModes?.length) {
      const currentMode = String(newSessionResponse.modes.currentModeId ?? "").toLowerCase();
      if (!YOLO_PRIORITY.includes(currentMode)) {
        const picked = YOLO_PRIORITY.map((p) =>
          newSessionResponse.modes!.availableModes!.find((m) => m.id.toLowerCase() === p),
        ).find(Boolean);
        if (picked && picked.id !== newSessionResponse.modes.currentModeId) {
          actions.push({
            method: "session/set_mode",
            params: { sessionId, modeId: picked.id },
          });
        }
      }
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
