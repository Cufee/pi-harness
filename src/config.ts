import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CodeMode } from "./code-mode/sdk.js";

export type AcpAdapterKind = "claude" | "codex" | "gemini" | "generic";

export interface AcpProfileConfig {
  id: string;
  kind: "acp";
  adapter: AcpAdapterKind;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  billing: "subscription" | "api" | "local";
  enabled?: boolean;
  /** Optional model ID override list if user wants to pin/skip probing */
  models?: string[];
  /** Optional extra CLI args appended when running strictly read-only */
  readOnlyArgs?: string[];
}

export interface PiProfileConfig {
  id: string;
  kind: "pi";
  provider: string;
  api?: "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
  baseUrl?: string;
  apiKeyEnv?: string;
  billing: "api" | "subscription" | "local";
  enabled?: boolean;
  models?: string[];
}

export type RunnerProfileConfig = AcpProfileConfig | PiProfileConfig;

export interface QuotaEndpointConfig {
  /** HTTP(S) URL or `unix:///path/to/sock#/quota` endpoint returning ProtoJSON or binary QuotaSnapshot */
  url: string;
  /** Optional HTTP headers (supports `${ENV_VAR}` interpolation) */
  headers?: Record<string, string>;
  /** Poll interval in seconds (default 60) */
  pollIntervalSec?: number;
  /** Request timeout in ms (default 5000) */
  timeoutMs?: number;
  /** Wire format: protojson (default) or protobuf */
  format?: "protojson" | "protobuf";
}

export interface WorktreeConfig {
  /** Base dir relative to repo root (default `.harness/worktrees`) */
  dir?: string;
  /** Optional fast bootstrap command run inside newly created worktree */
  setupCommand?: string;
  /** Deterministic CI gate commands run by the bisecting merge queue */
  ciCommands?: string[];
  /** Days to retain safety archive git refs before GC (default 7) */
  archiveRetentionDays?: number;
  /** Max concurrent active Tier 2 worker worktrees (default 4) */
  maxConcurrentWorkers?: number;
}

export interface RolloverConfig {
  /** Context ratio triggering Tier 1 Orchestrator clean relay (default 0.60) */
  orchestratorThreshold: number;
  /** Context ratio triggering Tier 2 Worker clean worktree rollover (default 0.65) */
  workerThreshold: number;
  /** Hard turn cap for Tier 3 Task Agents (default 20) */
  taskMaxTurns: number;
  /** Tool output byte threshold above which output is externalized to artifact file (default 2048) */
  externalizeBytes: number;
}

export interface CatalogConfig {
  /** Cache TTL in hours (default 24) */
  ttlHours: number;
  /** Optional Artificial Analysis Pro API key env var name (default `ARTIFICIAL_ANALYSIS_API_KEY`) */
  artificialAnalysisKeyEnv?: string;
  /** Allow -preview models to beat older GA versions in same family (default true) */
  allowPreview?: boolean;
  /** Prefer subscription routes over API routes for same canonical model (default true) */
  preferSubscription?: boolean;
  /**
   * User model filter mode:
   * - `"all"` (default): all ranked catalog models enabled except those in `disabledModels`.
   * - `"allowlist"`: only models listed in `enabledModels` are active (used after "Toggle All Off").
   */
  modelFilterMode?: "all" | "allowlist";
  /** Canonical model IDs disabled when `modelFilterMode === "all"`. */
  disabledModels?: string[];
  /** Canonical model IDs enabled when `modelFilterMode === "allowlist"`. */
  enabledModels?: string[];
}

export interface QuotaRetryConfig {
  /**
   * How long to let an ACP/pi runner natively retry 429 / rate-limit errors (e.g. while a
   * subscription pool proxy switches accounts) before stopping the agent cleanly (default 45_000 ms).
   */
  nativeRetryTimeoutMs: number;
  /**
   * Fallback cooldown in seconds when neither Quota Endpoint nor passive headers report a reset time.
   * Exponentially backs off across consecutive auto-resumes up to maxCooldownSec (default 60s).
   */
  fallbackCooldownSec: number;
  /** Maximum fallback backoff cooldown in seconds (default 900s = 15m). */
  maxCooldownSec: number;
  /** Automatically restart quota-paused runs once quota becomes available (default true). */
  autoResumeEnabled: boolean;
  /** While paused on quota, poll interval (ms) to detect early recovery from Quota Endpoint (default 30_000 ms). */
  earlyWakePollMs: number;
}

export interface HarnessConfig {
  stateDir: string;
  socketPath: string;
  profiles: RunnerProfileConfig[];
  codeMode: CodeMode;
  codeExec?: { defaultTimeoutMs?: number; maxTimeoutMs?: number; maxOutputChars?: number };
  defaultOrchestratorProfile?: string;
  defaultWorkerProfile?: string;
  defaultTaskProfile?: string;
  rollover: RolloverConfig;
  worktree: WorktreeConfig;
  catalog: CatalogConfig;
  quotaRetry: QuotaRetryConfig;
  quotaEndpoint?: QuotaEndpointConfig;
}

export function defaultStateDir(): string {
  return process.env.PI_HARNESS_HOME || join(homedir(), ".pi-harness");
}

export function defaultSocketPath(stateDir: string): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && existsSync(runtime)) {
    return join(runtime, "pi-harness", "daemon.sock");
  }
  // Keep Unix socket paths short (<104 bytes on macOS)
  const candidate = join(stateDir, "daemon.sock");
  if (candidate.length < 96) return candidate;
  return join(tmpdir(), `pi-harness-${process.getuid?.() ?? "u"}.sock`);
}

export function defaultProfiles(): RunnerProfileConfig[] {
  return [
    {
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "npx",
      args: ["-y", "@agentclientprotocol/claude-agent-acp"],
      billing: "subscription",
      enabled: true,
    },
    {
      id: "acp:codex",
      kind: "acp",
      adapter: "codex",
      command: "npx",
      args: ["-y", "@agentclientprotocol/codex-acp"],
      billing: "subscription",
      enabled: true,
    },
    {
      id: "acp:gemini",
      kind: "acp",
      adapter: "gemini",
      command: "gemini",
      args: ["--acp"],
      billing: "subscription",
      enabled: false,
    },
  ];
}

function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name: string) => process.env[name] ?? "");
}

export function loadConfig(repoRoot?: string): HarnessConfig {
  const stateDir = resolve(defaultStateDir());
  mkdirSync(stateDir, { recursive: true });

  const globalCfg = readJsonIfExists(join(stateDir, "config.json")) ?? {};
  const repoCfg = repoRoot ? readJsonIfExists(join(repoRoot, ".pi-harness.json")) ?? {} : {};

  const merged = { ...globalCfg, ...repoCfg } as Partial<HarnessConfig>;
  const rollover: RolloverConfig = {
    orchestratorThreshold: 0.72,
    workerThreshold: 0.78,
    taskMaxTurns: 40,
    externalizeBytes: 2048,
    ...(globalCfg.rollover as Partial<RolloverConfig> | undefined),
    ...(repoCfg.rollover as Partial<RolloverConfig> | undefined),
  };

  const worktree: WorktreeConfig = {
    dir: ".harness/worktrees",
    archiveRetentionDays: 7,
    maxConcurrentWorkers: 4,
    ...(globalCfg.worktree as Partial<WorktreeConfig> | undefined),
    ...(repoCfg.worktree as Partial<WorktreeConfig> | undefined),
  };

  const catalog: CatalogConfig = {
    ttlHours: 24,
    artificialAnalysisKeyEnv: "ARTIFICIAL_ANALYSIS_API_KEY",
    allowPreview: true,
    preferSubscription: true,
    modelFilterMode: "all",
    disabledModels: [],
    enabledModels: [],
    ...(globalCfg.catalog as Partial<CatalogConfig> | undefined),
    ...(repoCfg.catalog as Partial<CatalogConfig> | undefined),
  };

  const quotaRetry: QuotaRetryConfig = {
    nativeRetryTimeoutMs: 45_000,
    fallbackCooldownSec: 60,
    maxCooldownSec: 900,
    autoResumeEnabled: true,
    earlyWakePollMs: 30_000,
    ...(globalCfg.quotaRetry as Partial<QuotaRetryConfig> | undefined),
    ...(repoCfg.quotaRetry as Partial<QuotaRetryConfig> | undefined),
  };

  const profiles = (merged.profiles && merged.profiles.length > 0 ? merged.profiles : defaultProfiles());

  const codeMode = merged.codeMode ?? "collapsed";
  if (!["collapsed", "hybrid", "off"].includes(codeMode)) throw new Error(`Unknown codeMode: ${codeMode}`);
  return {
    stateDir,
    socketPath: merged.socketPath ? resolve(merged.socketPath) : defaultSocketPath(stateDir),
    profiles,
    codeMode,
    codeExec: {
      defaultTimeoutMs: 60_000, maxTimeoutMs: 600_000,
      ...(globalCfg.codeExec as HarnessConfig["codeExec"]),
      ...(repoCfg.codeExec as HarnessConfig["codeExec"]),
    },
    defaultOrchestratorProfile: merged.defaultOrchestratorProfile ?? profiles.find((p) => p.enabled !== false)?.id,
    defaultWorkerProfile: merged.defaultWorkerProfile ?? profiles.find((p) => p.enabled !== false)?.id,
    defaultTaskProfile: merged.defaultTaskProfile ?? profiles.find((p) => p.enabled !== false)?.id,
    rollover,
    worktree,
    catalog,
    quotaRetry,
    quotaEndpoint: merged.quotaEndpoint,
  };
}

/**
 * Persists mutable user settings & external harness CLI profiles to `~/.pi-harness/config.json`
 * so changes made in the `/settings` TUI overlay survive restarts and hot-reload inside `harnessd`.
 */
export function saveGlobalConfig(config: HarnessConfig): string {
  mkdirSync(config.stateDir, { recursive: true });
  const filePath = join(config.stateDir, "config.json");
  const serialized = {
    profiles: config.profiles,
    codeMode: config.codeMode,
    codeExec: config.codeExec,
    defaultOrchestratorProfile: config.defaultOrchestratorProfile,
    defaultWorkerProfile: config.defaultWorkerProfile,
    defaultTaskProfile: config.defaultTaskProfile,
    rollover: config.rollover,
    worktree: config.worktree,
    catalog: config.catalog,
    quotaRetry: config.quotaRetry,
    ...(config.quotaEndpoint ? { quotaEndpoint: config.quotaEndpoint } : {}),
  };
  writeFileSync(filePath, JSON.stringify(serialized, null, 2) + "\n", "utf8");
  return filePath;
}

export const ACP_PROFILE_PRESETS: Record<string, Omit<AcpProfileConfig, "id">> = {
  claude: {
    kind: "acp",
    adapter: "claude",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp"],
    billing: "subscription",
    enabled: true,
  },
  codex: {
    kind: "acp",
    adapter: "codex",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp"],
    billing: "subscription",
    enabled: true,
  },
  gemini: {
    kind: "acp",
    adapter: "gemini",
    command: "gemini",
    args: ["--acp"],
    billing: "subscription",
    enabled: true,
  },
  opencode: {
    kind: "acp",
    adapter: "generic",
    command: "opencode",
    args: ["acp"],
    billing: "subscription",
    enabled: true,
  },
  amp: {
    kind: "acp",
    adapter: "generic",
    command: "npx",
    args: ["-y", "amp-acp"],
    billing: "subscription",
    enabled: true,
  },
  antigravity: {
    kind: "acp",
    adapter: "generic",
    command: "agy",
    args: ["acp"],
    billing: "subscription",
    enabled: true,
  },
};
