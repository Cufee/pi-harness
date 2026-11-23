import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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
  /** Durable artifact dossier dir relative to repo root (default `.harness/artifacts`) */
  artifactsDir?: string;
  /** Optional fast bootstrap command run inside newly created worktree */
  setupCommand?: string;
  /** Deterministic CI gate commands run by the bisecting merge queue */
  ciCommands?: string[];
  /** Per-command CI timeout in ms for the merge queue (default 300_000) */
  ciTimeoutMs?: number;
  /** Git author name used for automated merge commits (default `pi-harness`) */
  gitAuthorName?: string;
  /** Git author email used for automated merge commits (default `harness@local`) */
  gitAuthorEmail?: string;
  /** Days to retain safety archive git refs before GC (default 7) */
  archiveRetentionDays?: number;
  /** Max concurrent active Tier 2 worker worktrees (default 4) */
  maxConcurrentWorkers?: number;
  /** Additional host directories readable by read-only agents, reviewers, and workers (e.g. `~/vanolyze-work`). */
  extraReadRoots?: string[];
  /** Additional host directories writable by workers and Director notes (e.g. `~/vanolyze-work`). */
  extraWriteRoots?: string[];
}

export interface GoalsConfig {
  /** Default max review cycles before escalating to human (default 4) */
  defaultMaxReviewCycles: number;
  /** Default max consecutive no-progress review cycles before escalating (default 2) */
  defaultMaxNoProgressCycles: number;
  /** Timeout in ms for each deterministic goal verification shell gate (default 180_000) */
  gateTimeoutMs: number;
  /** Automatically run deterministic gates + independent Done-Review when a Goal's linked run settles completed (default true). */
  autoVerifyOnSettle?: boolean;
  /** Max concurrent in-progress goals per repository (default 4; additional committed goals wait in the admission queue). */
  maxConcurrentGoals?: number;
}

export interface EventsConfig {
  /**
   * Fallback wakeup interval (seconds) for event-driven waits (`wait_children`, `wait_tasks`, `goal_wait`)
   * in case a child agent process hangs or dies without emitting a terminal event.
   * Default is intentionally long (600s = 10m) so agents rely on events and never thrash/token-poll.
   */
  fallbackWakeupIntervalSec: number;
  /** Automatically wake an idle Director chat session when one of its Goal runs settles (default true). */
  wakeDirectorOnGoalSettle: boolean;
}

export interface RolloverConfig {
  /** Context ratio triggering Tier 1 Orchestrator clean relay (default 0.72) */
  orchestratorThreshold: number;
  /** Context ratio triggering Tier 2 Worker clean worktree rollover (default 0.78) */
  workerThreshold: number;
  /** Hard turn cap for Tier 1 Orchestrators (default 200) */
  orchestratorMaxTurns: number;
  /** Hard turn cap for Tier 2 Workers (default 120) */
  workerMaxTurns: number;
  /** Hard turn cap for Tier 3 Task Agents (default 40) */
  taskMaxTurns: number;
  /** Hard turn cap for Goal Done-Review agents (default 12) */
  reviewerMaxTurns: number;
  /** Tool output byte threshold above which output is externalized to artifact file (default 2048) */
  externalizeBytes: number;
  /** Hard generation cap per task to prevent unbounded rollover loops (default 12) */
  maxGenerations?: number;
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

export interface ExternalMcpServerConfig {
  /** Stable MCP server name exposed to all ACP agents (e.g. `ast-grep`, `octofs`, `serena`) */
  name: string;
  /** Executable command (e.g. `uvx`, `npx`, `octofs`, `/path/to/bin`) */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Set false to disable without removing */
  enabled?: boolean;
}

export interface RemoteHostConfig {
  /** Short unique alias for this remote host (e.g. `gpu-box`, `dev-linux`). */
  name: string;
  /** SSH target (`ssh://[user@]host[:port]` or local socket path for tests). */
  sshTarget: string;
  /** Optional remote bridge command override (defaults to `pi-harness bridge`). */
  bridgeCommand?: string;
  /** Whether the local daemon auto-connects a persistent PeerLink on startup (default: true). */
  autoConnect?: boolean;
  /**
   * Reverse peer capability policy for RPCs initiated by this remote host back to us:
   * - `"messages"` (default): allow session messaging, read-only project/session discovery, and outbox sync only.
   * - `"full"`: also allow remote-initiated `project.create/update/remove/browse` and `chat.create` on this machine.
   */
  reverseAccess?: "messages" | "full";
}

export interface HarnessConfig {
  stateDir: string;
  socketPath: string;
  profiles: RunnerProfileConfig[];
  /** Configured remote harnessd hosts for federated projects, remote sessions, and bidirectional peering. */
  remotes?: RemoteHostConfig[];
  /** Optional external stdio MCP servers forwarded automatically to shell-enabled ACP agents (Tier 2 workers, Tier 3 verify/execute, and isolated Done-Reviewers). */
  externalMcpServers?: ExternalMcpServerConfig[];
  codeMode: CodeMode;
  codeExec?: { defaultTimeoutMs?: number; maxTimeoutMs?: number; maxOutputChars?: number };
  defaultOrchestratorProfile?: string;
  defaultWorkerProfile?: string;
  defaultTaskProfile?: string;
  rollover: RolloverConfig;
  worktree: WorktreeConfig;
  goals: GoalsConfig;
  events: EventsConfig;
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
  // Keep Unix socket paths short (<104 bytes on macOS) while avoiding world-writable /tmp root races
  const candidate = join(stateDir, "daemon.sock");
  if (candidate.length < 96) return candidate;
  const uidDir = join(tmpdir(), `pi-harness-${process.getuid?.() ?? "u"}`);
  mkdirSync(uidDir, { recursive: true, mode: 0o700 });
  return join(uidDir, "daemon.sock");
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

export function normalizeWorktreeRoots(worktree: unknown) {
  const fields = worktree as Record<string, unknown> | undefined;
  const invalid: string[] = [];
  function roots(key: "extraReadRoots" | "extraWriteRoots"): string[] | undefined {
    const value = fields?.[key];
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      invalid.push(key);
      return undefined;
    }
    const valid = value.filter((root): root is string =>
      typeof root === "string" && root === root.trim() && !root.includes("\0") &&
      (isAbsolute(root) || root === "~" || root.startsWith("~/")),
    );
    if (valid.length !== value.length) invalid.push(key);
    return valid;
  }
  const normalized = { extraReadRoots: roots("extraReadRoots"), extraWriteRoots: roots("extraWriteRoots") };
  return { roots: normalized, warning: invalid.length ? `Invalid worktree roots in ${invalid.join(", ")}` : undefined };
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
    orchestratorMaxTurns: 200,
    workerMaxTurns: 120,
    taskMaxTurns: 40,
    reviewerMaxTurns: 30,
    externalizeBytes: 2048,
    maxGenerations: 12,
    ...(globalCfg.rollover as Partial<RolloverConfig> | undefined),
    ...(repoCfg.rollover as Partial<RolloverConfig> | undefined),
  };

  // Only the operator's config may grant access to additional host directories.
  const { roots, warning } = normalizeWorktreeRoots(globalCfg.worktree);
  if (warning) console.error(`[harness] ${warning}; ignoring invalid entries`);
  const worktree: WorktreeConfig = {
    dir: ".harness/worktrees",
    artifactsDir: ".harness/artifacts",
    ciTimeoutMs: 300_000,
    gitAuthorName: "pi-harness",
    gitAuthorEmail: "harness@local",
    archiveRetentionDays: 7,
    maxConcurrentWorkers: 4,
    ...(globalCfg.worktree as Partial<WorktreeConfig> | undefined),
    ...(repoCfg.worktree as Partial<WorktreeConfig> | undefined),
    ...roots,
  };

  const goals: GoalsConfig = {
    defaultMaxReviewCycles: 4,
    defaultMaxNoProgressCycles: 2,
    gateTimeoutMs: 180_000,
    autoVerifyOnSettle: true,
    maxConcurrentGoals: 4,
    ...(globalCfg.goals as Partial<GoalsConfig> | undefined),
    ...(repoCfg.goals as Partial<GoalsConfig> | undefined),
  };

  const events: EventsConfig = {
    fallbackWakeupIntervalSec: 600,
    wakeDirectorOnGoalSettle: true,
    ...(globalCfg.events as Partial<EventsConfig> | undefined),
    ...(repoCfg.events as Partial<EventsConfig> | undefined),
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

  // Security: `remotes` (SSH peer trust & auto-connect targets) MUST only come from trusted user global config,
  // never from untrusted repository `.pi-harness.json`.
  const globalRemotes = Array.isArray(globalCfg.remotes) ? (globalCfg.remotes as RemoteHostConfig[]) : undefined;

  const codeMode = merged.codeMode ?? "collapsed";
  if (!["collapsed", "hybrid", "off"].includes(codeMode)) throw new Error(`Unknown codeMode: ${codeMode}`);
  return {
    stateDir,
    socketPath: merged.socketPath ? resolve(merged.socketPath) : defaultSocketPath(stateDir),
    profiles,
    ...(globalRemotes?.length ? { remotes: globalRemotes } : {}),
    ...(merged.externalMcpServers?.length ? { externalMcpServers: merged.externalMcpServers } : {}),
    codeMode,
    codeExec: {
      defaultTimeoutMs: 300_000, maxTimeoutMs: 1_800_000,
      ...(globalCfg.codeExec as HarnessConfig["codeExec"]),
      ...(repoCfg.codeExec as HarnessConfig["codeExec"]),
    },
    defaultOrchestratorProfile: merged.defaultOrchestratorProfile ?? profiles.find((p) => p.enabled !== false)?.id,
    defaultWorkerProfile: merged.defaultWorkerProfile ?? profiles.find((p) => p.enabled !== false)?.id,
    defaultTaskProfile: merged.defaultTaskProfile ?? profiles.find((p) => p.enabled !== false)?.id,
    rollover,
    worktree,
    goals,
    events,
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
    ...(config.remotes?.length ? { remotes: config.remotes } : {}),
    ...(config.externalMcpServers?.length ? { externalMcpServers: config.externalMcpServers } : {}),
    codeMode: config.codeMode,
    codeExec: config.codeExec,
    defaultOrchestratorProfile: config.defaultOrchestratorProfile,
    defaultWorkerProfile: config.defaultWorkerProfile,
    defaultTaskProfile: config.defaultTaskProfile,
    rollover: config.rollover,
    worktree: config.worktree,
    goals: config.goals,
    events: config.events,
    catalog: config.catalog,
    quotaRetry: config.quotaRetry,
    ...(config.socketPath !== defaultSocketPath(config.stateDir) ? { socketPath: config.socketPath } : {}),
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

/** Optional presets for battle-tested external MCP code tools forwarded to all non-control-plane ACP agents. */
export const EXTERNAL_MCP_PRESETS: Record<string, ExternalMcpServerConfig> = {
  octofs: {
    name: "octofs",
    command: "octofs",
    args: ["mcp"],
    enabled: true,
  },
  "ast-grep": {
    name: "ast-grep",
    command: "uvx",
    args: ["--from", "git+https://github.com/ast-grep/ast-grep-mcp", "ast-grep-server"],
    enabled: true,
  },
};
