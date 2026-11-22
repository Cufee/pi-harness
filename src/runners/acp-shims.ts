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
    // Never hand Claude Code a company prefix (`anthropic/claude-opus-5-5` -> `claude-opus-5-5`)
    const nativeModel = opts.model ? stripSingleVendorPrefix(adapter, opts.model) : null;
    if (nativeModel) claudeOptions.model = nativeModel;
    if (opts.effort) claudeOptions.effort = opts.effort;

    params._meta = {
      claudeCode: {
        options: claudeOptions,
      },
    };

    if (sessionCaps.options) {
      const cfg: Array<{ configId: string; value: string }> = [];
      if (nativeModel) cfg.push({ configId: "model", value: nativeModel });
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

export interface NativeModelCandidate {
  value: string;
  name?: string;
}

interface AcpConfigOption {
  id: string;
  category?: string;
  currentValue?: unknown;
  options?: Array<{ value: string; name?: string }>;
}

/** Vendor prefixes each single-vendor adapter never accepts on the wire. */
const SINGLE_VENDOR_PREFIXES: Partial<Record<AcpAdapterKind, string[]>> = {
  claude: ["anthropic/"],
  codex: ["openai/"],
  gemini: ["google/"],
};

/** `google-vertex/gemini-4-carbon` -> `gemini-4-carbon` */
export function stripVendorPrefix(model: string): string {
  return model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
}

/** Strips only the company prefix a single-vendor adapter can never accept (`openai/` for Codex, etc.). */
export function stripSingleVendorPrefix(adapter: AcpAdapterKind, model: string): string {
  const prefix = SINGLE_VENDOR_PREFIXES[adapter]?.find((p) => model.toLowerCase().startsWith(p));
  return prefix ? model.slice(prefix.length) : model;
}

/** `Claude Opus 5.5` / `claude-opus-5.5` / `opus-5-5` -> `opus-5-5` */
function normalizeModelName(raw: string): string {
  return stripVendorPrefix(raw)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^claude-/, "");
}

const CLAUDE_FAMILIES = ["opus", "sonnet", "haiku", "fable"];

/** `claude-opus-5-5` / `opus` / `Opus 5.5` -> `opus` */
function modelFamily(raw: string): string | null {
  const norm = normalizeModelName(raw);
  return CLAUDE_FAMILIES.find((f) => norm === f || norm.startsWith(`${f}-`)) ?? null;
}

/**
 * Resolves a requested model (canonical `vendor/name`, bare, or wire ID) to the adapter's native option value.
 * Priority: exact value; bare name on both sides; normalized name; Claude family alias (`claude-opus-*` <-> `opus`);
 * then, for single-vendor adapters, the requested ID with its company prefix stripped. Returns null when a
 * multi-vendor adapter (generic/amp) advertises nothing that matches.
 */
export function resolveNativeModelOption(
  adapter: AcpAdapterKind,
  requested: string,
  candidates: NativeModelCandidate[],
): string | null {
  const exact = candidates.find((c) => c.value === requested);
  if (exact) return exact.value;

  const bare = stripVendorPrefix(requested).toLowerCase();
  const bareMatch = candidates.find((c) => stripVendorPrefix(c.value).toLowerCase() === bare);
  if (bareMatch) return bareMatch.value;

  const norm = normalizeModelName(requested);
  const normMatch = candidates.find(
    (c) => normalizeModelName(c.value) === norm || (c.name !== undefined && normalizeModelName(c.name) === norm),
  );
  if (normMatch) return normMatch.value;

  const family = modelFamily(requested);
  if (family) {
    const familyMatch =
      candidates.find((c) => normalizeModelName(c.value) === family) ??
      candidates.find((c) => modelFamily(c.value) === family) ??
      candidates.find((c) => c.name !== undefined && modelFamily(c.name) === family);
    if (familyMatch) return familyMatch.value;
  }

  return SINGLE_VENDOR_PREFIXES[adapter] ? stripSingleVendorPrefix(adapter, requested) : null;
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
  const configOptions = (newSessionResponse.configOptions ?? []) as AcpConfigOption[];
  const legacyModels = newSessionResponse.models as
    | { currentModelId?: string; availableModels?: Array<{ modelId: string; name?: string }> }
    | undefined;

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

  const modelOpt = configOptions.find((c) => c.category === "model" || c.id === "model");
  const effortOpt = configOptions.find(
    (c) => c.category === "thought_level" || c.id === "reasoning_effort" || c.id === "effort",
  );

  // Model selection: reconcile the requested ID against what the adapter advertises
  if (opts.model) {
    const candidates: NativeModelCandidate[] = [
      ...(modelOpt?.options ?? []),
      ...(legacyModels?.availableModels ?? []).map((m) => ({ value: m.modelId, name: m.name })),
    ];
    const advertised = new Set(candidates.map((c) => c.value));
    const resolved = resolveNativeModelOption(adapter, opts.model, candidates);
    const current = modelOpt?.currentValue ?? legacyModels?.currentModelId;

    if (adapter === "gemini") {
      // gemini --acp only honors the legacy session/set_model
      if (resolved && resolved !== current) {
        actions.push({ method: "session/set_model", params: { sessionId, modelId: resolved } });
      }
    } else if (adapter === "claude") {
      // Initial model went via _meta on session/new; only correct it to an advertised native option
      if (modelOpt && resolved && advertised.has(resolved) && resolved !== current) {
        actions.push({
          method: "session/set_config_option",
          params: { sessionId, configId: modelOpt.id, value: resolved },
        });
      }
    } else if (adapter === "codex" || modelOpt) {
      // Codex does not apply initial session.options on session/new — set model first, then reasoning_effort.
      // When options are advertised, only send one of them; otherwise trust the resolved/requested ID.
      const value = candidates.length > 0 ? (resolved && advertised.has(resolved) ? resolved : null) : (resolved ?? opts.model);
      if (value && value !== current) {
        actions.push({
          method: "session/set_config_option",
          params: { sessionId, configId: modelOpt?.id ?? "model", value },
        });
      }
    } else if (resolved && resolved !== current) {
      actions.push({ method: "session/set_model", params: { sessionId, modelId: resolved } });
    }
  }

  // Effort selection: only send a value the adapter advertises; skip cleanly otherwise
  if (opts.effort) {
    const wanted = opts.effort.toLowerCase();
    if (effortOpt?.options?.length) {
      const match = effortOpt.options.find(
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
