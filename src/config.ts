import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
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
  /**
   * Absolute path of the shell that runs verification gates with `-c` (default `/bin/sh`).
   * Global `config.json` / `config.update` only; ignored in repo `.pi-harness.json`. Invalid values fail gates closed.
   */
  gateShell?: string;
  /**
   * Extra environment for verification gates (goal criteria, merge-queue CI, worktree setup).
   * Global `config.json` / `config.update` only; ignored in repo `.pi-harness.json`. `PATH` is prepended to the
   * resolved PATH, never a replacement. `HARNESS_*` names are reserved. Invalid values fail gates closed.
   */
  gateEnv?: Record<string, string>;
}

export interface EventsConfig {
  /**
   * Fallback wakeup interval (seconds) for event-driven waits (`wait_children`, `wait_tasks`, `goal_wait`)
   * in case a child agent process hangs or dies without emitting a terminal event.
   * Default is intentionally long (600s = 10m) so agents rely on events and never thrash/token-poll.
   */
  fallbackWakeupIntervalSec: number;
  /** Automatically wake an idle Director chat session when one of its Goal runs or Director-spawned tasks settles (default true). */
  wakeDirectorOnGoalSettle: boolean;
}

/**
 * Default context utilization ratio triggering in-place compaction for Tier 3 task agents
 * on the Pi runner when no explicit `rolloverThreshold` is supplied on the request.
 */
export const DEFAULT_TASK_COMPACTION_THRESHOLD = 0.78;

export interface RolloverConfig {
  /** Context ratio triggering Tier 1 Orchestrator clean relay (default 0.72) */
  orchestratorThreshold: number;
  /** Context ratio triggering Tier 2 Worker clean worktree rollover (default 0.78) */
  workerThreshold: number;
  /** Deprecated; no effect: tasks are never stopped or reminded by turn count. */
  orchestratorMaxTurns: number;
  /** Deprecated; no effect: tasks are never stopped or reminded by turn count. */
  workerMaxTurns: number;
  /** Deprecated; no effect: tasks are never stopped or reminded by turn count. */
  taskMaxTurns: number;
  /** Deprecated; no effect: tasks are never stopped or reminded by turn count. */
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

export interface HotUpdateConfig {
  mode: "auto" | "manual";
  drainTimeoutSec: number;
  minIntervalSec: number;
}

export interface StorageConfig {
  /** Root directory for harness-managed project and chat data (default `<stateDir>/data`). Applies at daemon start only. */
  dataDir: string;
}

export interface RetentionConfig {
  /** Number of installed releases kept during post-install pruning, counting current (positive integer, default 3). */
  installReleases: number;
  /** Maximum byte size for `daemon.log` and `install-audit.log` before rotating to `.1` (positive integer, default 10485760). */
  logMaxBytes: number;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  installReleases: 3,
  logMaxBytes: 10_485_760,
};

export function defaultDataDir(stateDir: string): string {
  return resolve(join(stateDir, "data"));
}

function expandHomePath(rawPath: string): string {
  if (rawPath === "~") return homedir();
  if (rawPath.startsWith("~/")) return join(homedir(), rawPath.slice(2));
  return rawPath;
}

export function normalizeStorageConfig(
  raw: unknown,
  fallback: StorageConfig,
): { config: StorageConfig; warnings: string[] } {
  const warnings: string[] = [];
  const baseDir = resolve(expandHomePath(fallback.dataDir));
  const base: StorageConfig = { dataDir: baseDir };

  if (raw === undefined) return { config: base, warnings };
  if (!isPlainObject(raw)) {
    warnings.push("storage must be an object; using defaults");
    return { config: base, warnings };
  }

  let dataDir = base.dataDir;
  if ("dataDir" in raw && raw.dataDir !== undefined) {
    if (typeof raw.dataDir === "string" && raw.dataDir.trim().length > 0 && !raw.dataDir.includes("\0")) {
      dataDir = resolve(expandHomePath(raw.dataDir.trim()));
    } else {
      warnings.push("storage.dataDir must be a non-empty path string; using default");
    }
  }
  return { config: { dataDir }, warnings };
}

export function normalizeRetentionConfig(
  raw: unknown,
  fallback: RetentionConfig = DEFAULT_RETENTION_CONFIG,
): { config: RetentionConfig; warnings: string[] } {
  const warnings: string[] = [];
  const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
  const base: RetentionConfig = {
    installReleases: isPosInt(fallback.installReleases)
      ? fallback.installReleases
      : DEFAULT_RETENTION_CONFIG.installReleases,
    logMaxBytes: isPosInt(fallback.logMaxBytes) ? fallback.logMaxBytes : DEFAULT_RETENTION_CONFIG.logMaxBytes,
  };

  if (raw === undefined) return { config: base, warnings };
  if (!isPlainObject(raw)) {
    warnings.push("retention must be an object; using defaults");
    return { config: base, warnings };
  }

  let installReleases = base.installReleases;
  if ("installReleases" in raw && raw.installReleases !== undefined) {
    if (isPosInt(raw.installReleases)) {
      installReleases = raw.installReleases;
    } else {
      warnings.push(`retention.installReleases must be a positive integer; using ${base.installReleases}`);
    }
  }

  let logMaxBytes = base.logMaxBytes;
  if ("logMaxBytes" in raw && raw.logMaxBytes !== undefined) {
    if (isPosInt(raw.logMaxBytes)) {
      logMaxBytes = raw.logMaxBytes;
    } else {
      warnings.push(`retention.logMaxBytes must be a positive integer; using ${base.logMaxBytes}`);
    }
  }

  return { config: { installReleases, logMaxBytes }, warnings };
}

export const HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC = 5;
export const HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC = 600;
export const HOT_UPDATE_MIN_INTERVAL_MIN_SEC = 0;
export const HOT_UPDATE_MIN_INTERVAL_MAX_SEC = 86_400;

export const DEFAULT_HOT_UPDATE_CONFIG: HotUpdateConfig = {
  mode: "auto",
  drainTimeoutSec: 90,
  minIntervalSec: 900,
};

export function normalizeHotUpdateConfig(
  raw: unknown,
  fallback: HotUpdateConfig = DEFAULT_HOT_UPDATE_CONFIG,
): { config: HotUpdateConfig; warnings: string[] } {
  const warnings: string[] = [];
  const baseMode: "auto" | "manual" =
    fallback.mode === "auto" || fallback.mode === "manual" ? fallback.mode : DEFAULT_HOT_UPDATE_CONFIG.mode;
  const clampNum = (v: unknown, min: number, max: number, dflt: number): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
  const baseDrain = clampNum(
    fallback.drainTimeoutSec,
    HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC,
    HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC,
    DEFAULT_HOT_UPDATE_CONFIG.drainTimeoutSec,
  );
  const baseMinInterval = clampNum(
    fallback.minIntervalSec,
    HOT_UPDATE_MIN_INTERVAL_MIN_SEC,
    HOT_UPDATE_MIN_INTERVAL_MAX_SEC,
    DEFAULT_HOT_UPDATE_CONFIG.minIntervalSec,
  );
  const base: HotUpdateConfig = { mode: baseMode, drainTimeoutSec: baseDrain, minIntervalSec: baseMinInterval };

  if (raw === undefined) return { config: base, warnings };
  if (!isPlainObject(raw)) {
    warnings.push("hotUpdate must be an object; using defaults");
    return { config: base, warnings };
  }

  let mode: "auto" | "manual" = base.mode;
  if ("mode" in raw && raw.mode !== undefined) {
    if (raw.mode === "auto" || raw.mode === "manual") {
      mode = raw.mode;
    } else {
      warnings.push(`hotUpdate.mode must be "auto" or "manual"; using "${base.mode}"`);
    }
  }

  let drainTimeoutSec = base.drainTimeoutSec;
  if ("drainTimeoutSec" in raw && raw.drainTimeoutSec !== undefined) {
    if (typeof raw.drainTimeoutSec === "number" && Number.isFinite(raw.drainTimeoutSec)) {
      if (raw.drainTimeoutSec < HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC) {
        drainTimeoutSec = HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC;
        warnings.push(
          `hotUpdate.drainTimeoutSec out of range (${HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC}..${HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC}); clamped to ${drainTimeoutSec}`,
        );
      } else if (raw.drainTimeoutSec > HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC) {
        drainTimeoutSec = HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC;
        warnings.push(
          `hotUpdate.drainTimeoutSec out of range (${HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC}..${HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC}); clamped to ${drainTimeoutSec}`,
        );
      } else {
        drainTimeoutSec = raw.drainTimeoutSec;
      }
    } else {
      warnings.push(
        `hotUpdate.drainTimeoutSec must be a finite number in ${HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC}..${HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC}; using ${base.drainTimeoutSec}`,
      );
    }
  }

  let minIntervalSec = base.minIntervalSec;
  if ("minIntervalSec" in raw && raw.minIntervalSec !== undefined) {
    if (typeof raw.minIntervalSec === "number" && Number.isFinite(raw.minIntervalSec)) {
      if (raw.minIntervalSec < HOT_UPDATE_MIN_INTERVAL_MIN_SEC) {
        minIntervalSec = HOT_UPDATE_MIN_INTERVAL_MIN_SEC;
        warnings.push(
          `hotUpdate.minIntervalSec out of range (${HOT_UPDATE_MIN_INTERVAL_MIN_SEC}..${HOT_UPDATE_MIN_INTERVAL_MAX_SEC}); clamped to ${minIntervalSec}`,
        );
      } else if (raw.minIntervalSec > HOT_UPDATE_MIN_INTERVAL_MAX_SEC) {
        minIntervalSec = HOT_UPDATE_MIN_INTERVAL_MAX_SEC;
        warnings.push(
          `hotUpdate.minIntervalSec out of range (${HOT_UPDATE_MIN_INTERVAL_MIN_SEC}..${HOT_UPDATE_MIN_INTERVAL_MAX_SEC}); clamped to ${minIntervalSec}`,
        );
      } else {
        minIntervalSec = raw.minIntervalSec;
      }
    } else {
      warnings.push(
        `hotUpdate.minIntervalSec must be a finite number in ${HOT_UPDATE_MIN_INTERVAL_MIN_SEC}..${HOT_UPDATE_MIN_INTERVAL_MAX_SEC}; using ${base.minIntervalSec}`,
      );
    }
  }

  return { config: { mode, drainTimeoutSec, minIntervalSec }, warnings };
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
  hotUpdate: HotUpdateConfig;
  storage: StorageConfig;
  retention: RetentionConfig;
  /** @internal Effective legacy `worktree.dir` preserved from an existing config file; never exposed as a setting. */
  [LEGACY_WORKTREE_DIR]?: string;
  /** @internal Global-layer legacy `worktree.dir` preserved verbatim for `serializeGlobalConfig`. */
  [LEGACY_GLOBAL_WORKTREE_DIR]?: string;
}

/** @internal Internal symbol carrying the effective legacy `worktree.dir` read from an existing config file. */
export const LEGACY_WORKTREE_DIR: unique symbol = Symbol("pi-harness.legacyWorktreeDir");

/** @internal Internal symbol carrying the global `config.json` legacy `worktree.dir` value for verbatim re-serialization. */
const LEGACY_GLOBAL_WORKTREE_DIR: unique symbol = Symbol("pi-harness.legacyGlobalWorktreeDir");

type InternalConfigSymbols = typeof LEGACY_WORKTREE_DIR | typeof LEGACY_GLOBAL_WORKTREE_DIR;

/** @internal Reads the internal legacy `worktree.dir` preserved from an existing config file, if any. */
export function getLegacyWorktreeDir(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  const val = (config as { [LEGACY_WORKTREE_DIR]?: unknown })[LEGACY_WORKTREE_DIR];
  return typeof val === "string" && val.length > 0 ? val : undefined;
}

function getLegacyGlobalWorktreeDir(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  if (LEGACY_GLOBAL_WORKTREE_DIR in config) {
    const val = (config as { [LEGACY_GLOBAL_WORKTREE_DIR]?: unknown })[LEGACY_GLOBAL_WORKTREE_DIR];
    return typeof val === "string" && val.length > 0 ? val : undefined;
  }
  return getLegacyWorktreeDir(config);
}

/** Top-level keys whose value is a nested section (neither a string nor a list). */
type ConfigSection = {
  [K in Exclude<keyof HarnessConfig, InternalConfigSymbols>]-?: NonNullable<HarnessConfig[K]> extends string | readonly unknown[] ? never : K;
}[Exclude<keyof HarnessConfig, InternalConfigSymbols>];

/** Every key each section supports. Adding or removing a key in a section interface fails typecheck here. */
const CONFIG_SECTION_KEYS: { [S in ConfigSection]: { [K in keyof NonNullable<HarnessConfig[S]>]-?: true } } = {
  codeExec: { defaultTimeoutMs: true, maxTimeoutMs: true, maxOutputChars: true },
  rollover: {
    orchestratorThreshold: true,
    workerThreshold: true,
    orchestratorMaxTurns: true,
    workerMaxTurns: true,
    taskMaxTurns: true,
    reviewerMaxTurns: true,
    externalizeBytes: true,
    maxGenerations: true,
  },
  worktree: {
    setupCommand: true,
    ciCommands: true,
    ciTimeoutMs: true,
    gitAuthorName: true,
    gitAuthorEmail: true,
    archiveRetentionDays: true,
    maxConcurrentWorkers: true,
    extraReadRoots: true,
    extraWriteRoots: true,
  },
  goals: {
    defaultMaxReviewCycles: true,
    defaultMaxNoProgressCycles: true,
    gateTimeoutMs: true,
    autoVerifyOnSettle: true,
    maxConcurrentGoals: true,
    gateShell: true,
    gateEnv: true,
  },
  events: { fallbackWakeupIntervalSec: true, wakeDirectorOnGoalSettle: true },
  catalog: {
    ttlHours: true,
    artificialAnalysisKeyEnv: true,
    allowPreview: true,
    preferSubscription: true,
    modelFilterMode: true,
    disabledModels: true,
    enabledModels: true,
  },
  quotaRetry: {
    nativeRetryTimeoutMs: true,
    fallbackCooldownSec: true,
    maxCooldownSec: true,
    autoResumeEnabled: true,
    earlyWakePollMs: true,
  },
  quotaEndpoint: { url: true, headers: true, pollIntervalSec: true, timeoutMs: true, format: true },
  hotUpdate: { mode: true, drainTimeoutSec: true, minIntervalSec: true },
  storage: { dataDir: true },
  retention: { installReleases: true, logMaxBytes: true },
};

/** Top-level keys a config file may set; stateDir always comes from the environment. */
const CONFIG_TOP_LEVEL_KEYS: { [K in Exclude<keyof HarnessConfig, "stateDir" | InternalConfigSymbols>]-?: true } = {
  socketPath: true,
  profiles: true,
  remotes: true,
  externalMcpServers: true,
  codeMode: true,
  codeExec: true,
  defaultOrchestratorProfile: true,
  defaultWorkerProfile: true,
  defaultTaskProfile: true,
  rollover: true,
  worktree: true,
  goals: true,
  events: true,
  catalog: true,
  quotaRetry: true,
  quotaEndpoint: true,
  hotUpdate: true,
  storage: true,
  retention: true,
};

/** Honored only in the global config.json; resolveConfig strips these from the repo layer. */
const GLOBAL_ONLY_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "remotes",
  "worktree.extraReadRoots",
  "worktree.extraWriteRoots",
  "goals.gateShell",
  "goals.gateEnv",
  "hotUpdate",
  "storage",
  "retention",
]);

/** Removed config keys that may still appear in existing config files; ignored silently without warnings. */
const KNOWN_REMOVED_CONFIG_KEYS: ReadonlySet<string> = new Set([
  "worktree.dir",
  "worktree.artifactsDir",
]);

const CONFIG_SECTIONS = Object.keys(CONFIG_SECTION_KEYS) as ConfigSection[];
const SECTION_KEY_SETS: Record<ConfigSection, ReadonlySet<string>> = Object.fromEntries(
  CONFIG_SECTIONS.map((section) => [section, new Set(Object.keys(CONFIG_SECTION_KEYS[section]))]),
) as unknown as Record<ConfigSection, ReadonlySet<string>>;
const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(Object.keys(CONFIG_TOP_LEVEL_KEYS));
/** Each nested key mapped to its one section; keys with two homes or equal to a top-level key are left out. */
const SECTION_OF_KEY: ReadonlyMap<string, ConfigSection> = (() => {
  const map = new Map<string, ConfigSection>();
  const ambiguous = new Set<string>();
  for (const section of CONFIG_SECTIONS) {
    for (const key of Object.keys(CONFIG_SECTION_KEYS[section])) {
      if (map.has(key) || TOP_LEVEL_KEYS.has(key)) ambiguous.add(key);
      else map.set(key, section);
    }
  }
  for (const key of ambiguous) map.delete(key);
  return map;
})();

/** Every key any section supports. */
const ALL_SECTION_KEYS: ReadonlySet<string> = new Set(CONFIG_SECTIONS.flatMap((s) => Object.keys(CONFIG_SECTION_KEYS[s])));

/** Case-insensitive optimal string alignment distance (insert, delete, substitute, swap adjacent). */
function keyDistance(a: string, b: string): number {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const d = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
      }
    }
  }
  return d[a.length]![b.length]!;
}

/** Closest known key path to an unknown key, or undefined when none is within the typo threshold. */
function suggestConfigKey(key: string, section?: ConfigSection): string | undefined {
  const nested = (s: ConfigSection) => [...SECTION_KEY_SETS[s]].map((k) => `${s}.${k}`);
  const candidates = [
    ...(section ? nested(section) : []),
    ...TOP_LEVEL_KEYS,
    ...CONFIG_SECTIONS.filter((s) => s !== section).flatMap(nested),
  ];
  let best: string | undefined;
  let bestDist = (key.length <= 4 ? 1 : 2) + 1;
  for (const path of candidates) {
    const name = path.slice(path.lastIndexOf(".") + 1);
    if (Math.abs(key.length - name.length) >= bestDist) continue;
    const dist = keyDistance(key, name);
    if (dist < bestDist) {
      best = path;
      bestDist = dist;
    }
  }
  return best;
}

export interface MisplacedConfigKey {
  /** Where the key was found, such as `extraReadRoots` or `goals.maxConcurrentWorkers`. */
  path: string;
  /** Where the key is supported, as display text. */
  supported: string;
  /** Closest known key when the key is unknown (a likely typo). */
  suggestion?: string;
}

/** Known config keys found where they are not supported, and unknown keys (with a did-you-mean suggestion). Never reads or returns values. */
export function findMisplacedConfigKeys(raw: unknown, layer: "global" | "repo"): MisplacedConfigKey[] {
  if (!isPlainObject(raw)) return [];
  const out: MisplacedConfigKey[] = [];
  const isGlobalOnly = (target: string) =>
    GLOBAL_ONLY_CONFIG_KEYS.has(target) || GLOBAL_ONLY_CONFIG_KEYS.has(target.split(".")[0]!);
  const supported = (target: string) =>
    layer === "repo" && isGlobalOnly(target) ? `"${target}" in the global config.json` : `"${target}"`;
  const unknown = (path: string, key: string, section?: ConfigSection): MisplacedConfigKey => {
    const suggestion = suggestConfigKey(key, section);
    return suggestion
      ? { path, supported: `none (unknown key; did you mean ${supported(suggestion)}?)`, suggestion }
      : { path, supported: "none (unknown key)" };
  };
  for (const key of Object.keys(raw)) {
    const home = SECTION_OF_KEY.get(key);
    if (home !== undefined) {
      out.push({ path: key, supported: supported(`${home}.${key}`) });
    } else if (layer === "repo" && TOP_LEVEL_KEYS.has(key) && GLOBAL_ONLY_CONFIG_KEYS.has(key)) {
      out.push({ path: key, supported: supported(key) });
    } else if (key === "stateDir") {
      out.push({ path: key, supported: "none (set the PI_HARNESS_HOME environment variable instead)" });
    } else if (!TOP_LEVEL_KEYS.has(key) && !ALL_SECTION_KEYS.has(key)) {
      out.push(unknown(key, key));
    }
  }
  for (const section of CONFIG_SECTIONS) {
    const value = raw[section];
    if (!Object.hasOwn(raw, section) || !isPlainObject(value)) continue;
    for (const key of Object.keys(value)) {
      const path = `${section}.${key}`;
      if (KNOWN_REMOVED_CONFIG_KEYS.has(path)) continue;
      if (SECTION_KEY_SETS[section].has(key)) {
        if (layer === "repo" && GLOBAL_ONLY_CONFIG_KEYS.has(path)) out.push({ path, supported: supported(path) });
        continue;
      }
      const home = SECTION_OF_KEY.get(key);
      if (home !== undefined) {
        out.push({ path, supported: supported(`${home}.${key}`) });
      } else if (TOP_LEVEL_KEYS.has(key)) {
        out.push({ path, supported: supported(key) });
      } else if (!ALL_SECTION_KEYS.has(key)) {
        out.push(unknown(path, key, section));
      }
    }
  }
  return out;
}

/** Copy of a raw layer whose sections keep only keys the section supports; omits `quotaEndpoint` when stripping empties it. */
function dropUnsupportedSectionKeys(raw: Record<string, unknown>): Record<string, unknown> {
  let out = raw;
  for (const section of CONFIG_SECTIONS) {
    const sec = raw[section];
    if (!Object.hasOwn(raw, section) || !isPlainObject(sec)) continue;
    if (!Object.keys(sec).some((key) => !SECTION_KEY_SETS[section].has(key))) continue;
    const remaining = Object.entries(sec).filter(([key]) => SECTION_KEY_SETS[section].has(key));
    if (section === "quotaEndpoint" && remaining.length === 0) {
      out = Object.fromEntries(Object.entries(out).filter(([k]) => k !== section));
    } else {
      out = { ...out, [section]: Object.fromEntries(remaining) };
    }
  }
  return out;
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
  const uidDir = join(ensureTempDir(), `pi-harness-${process.getuid?.() ?? "u"}`);
  mkdirSync(uidDir, { recursive: true, mode: 0o700 });
  return join(uidDir, "daemon.sock");
}

/** Resolves this host's writable temp directory and exports it as TMPDIR so child processes inherit it. */
export function ensureTempDir(): string {
  const names = ["TMPDIR", "TMP", "TEMP"] as const;
  const saved = names.map((name) => process.env[name]);
  const restore = (name: (typeof names)[number], value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const candidates = saved.filter((value): value is string => !!value?.trim());
  // Bun's tmpdir() reads TMPDIR, TMP and TEMP and returns blank values verbatim, so all three are cleared to get the platform default.
  for (const name of names) delete process.env[name];
  try {
    candidates.push(tmpdir());
  } finally {
    restore("TMP", saved[1]);
    restore("TEMP", saved[2]);
  }
  const failures: string[] = [];
  for (const dir of new Set(candidates)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      accessSync(dir, constants.W_OK | constants.X_OK);
    } catch (err) {
      failures.push(`${dir}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    process.env.TMPDIR = dir;
    if (failures.length) console.error(`[pi-harness] TMPDIR ${failures.join("; ")}; using ${dir} instead.`);
    return dir;
  }
  restore("TMPDIR", saved[0]);
  throw new Error(`No usable temp directory (${failures.join("; ")}). Set TMPDIR to a writable directory.`);
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

/** Reads a JSON object file; a missing file or a non-object root (number, string, array, null) yields `undefined`. */
function readJsonIfExists(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return isPlainObject(parsed) ? parsed : undefined;
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

const GATE_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GATE_CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_GATE_ENV_VALUE_BYTES = 32 * 1024;

/**
 * Pure validation of `goals.gateShell` / `goals.gateEnv` (contract pi-harness/goals-gate-config-v1).
 * `null` / missing (and `""` for gateShell) mean unset. Issues name offending keys only, never values.
 */
export function normalizeGateConfig(goals: unknown): {
  gateShell?: string;
  gateEnv?: Record<string, string>;
  issues: string[];
} {
  const issues: string[] = [];
  const out: { gateShell?: string; gateEnv?: Record<string, string>; issues: string[] } = { issues };
  if (!goals || typeof goals !== "object") return out;
  const { gateShell, gateEnv } = goals as Record<string, unknown>;

  if (gateShell !== undefined && gateShell !== null && gateShell !== "") {
    if (
      typeof gateShell === "string" &&
      gateShell.trim() === gateShell &&
      !GATE_CONTROL_RE.test(gateShell) &&
      isAbsolute(gateShell)
    ) {
      out.gateShell = gateShell;
    } else {
      issues.push("goals.gateShell must be an absolute path string");
    }
  }

  if (gateEnv !== undefined && gateEnv !== null) {
    if (!isPlainObject(gateEnv)) {
      issues.push("goals.gateEnv must be an object of string values");
    } else {
      const clean: Record<string, string> = {};
      const bad: string[] = [];
      for (const [key, val] of Object.entries(gateEnv)) {
        const name = GATE_ENV_NAME_RE.test(key) ? key : JSON.stringify(key.slice(0, 64));
        if (!GATE_ENV_NAME_RE.test(key)) bad.push(`${name} (invalid name)`);
        else if (key === "__proto__") bad.push(`${name} (reserved name)`);
        else if (key.startsWith("HARNESS_")) bad.push(`${name} (HARNESS_* names are reserved)`);
        else if (typeof val !== "string" || val.includes("\0")) bad.push(`${name} (value must be a string without NUL)`);
        else if (Buffer.byteLength(val, "utf8") > MAX_GATE_ENV_VALUE_BYTES) bad.push(`${name} (value exceeds 32 KiB)`);
        else if (
          key === "PATH" &&
          (val === "" || val.split(delimiter).some((seg) => !seg || !isAbsolute(seg) || GATE_CONTROL_RE.test(seg)))
        ) {
          bad.push(`${name} (must be absolute directories joined by '${delimiter}')`);
        } else clean[key] = val;
      }
      if (bad.length > 0) issues.push(`goals.gateEnv has invalid entries: ${bad.join(", ")}`);
      else out.gateEnv = clean;
    }
  }
  return out;
}

/** Reads the repository overlay `<repoRoot>/.pi-harness.json`, or `{}` when absent. */
export function readRepoConfig(repoRoot?: string): Record<string, unknown> {
  return (repoRoot ? readJsonIfExists(join(repoRoot, ".pi-harness.json")) : undefined) ?? {};
}

export function loadConfig(repoRoot?: string, runtimeOverrides?: { socketPath?: string }): HarnessConfig {
  const stateDir = resolve(defaultStateDir());
  mkdirSync(stateDir, { recursive: true });
  return resolveConfig(readJsonIfExists(join(stateDir, "config.json")) ?? {}, readRepoConfig(repoRoot), {
    stateDir,
    ...(runtimeOverrides?.socketPath ? { socketPath: runtimeOverrides.socketPath } : {}),
  });
}

/**
 * Builds the effective config from layers: `base` (or built-in defaults) < global `config.json` < repo `.pi-harness.json`.
 * Nested sections merge per key; arrays and scalars replace whole. `remotes` and worktree access roots never come
 * from the repo layer. When `base` is given it replaces the built-in defaults, so a removed global key falls back
 * to the base value. Keys a section does not support, misplaced or unknown, are dropped, never honored.
 */
export function resolveConfig(
  globalCfg: Record<string, unknown>,
  repoCfg: Record<string, unknown>,
  runtime: { stateDir: string; socketPath?: string },
  base?: HarnessConfig,
): HarnessConfig {
  // Startup stays tolerant of non-object roots; the reload and config.update boundaries reject them.
  if (!isPlainObject(globalCfg)) globalCfg = {};
  if (!isPlainObject(repoCfg)) repoCfg = {};
  // Capture removed `worktree.dir` literally (no trim, no `~` expansion) before dropping unsupported keys,
  // so storage can still recognize/protect existing checkouts, honor legacy layout under the emergency lever,
  // and preserve an existing global `worktree.dir` verbatim across config saves without adding one when absent.
  const rawGlobalLegacyWorktreeDir =
    isPlainObject(globalCfg.worktree) && typeof globalCfg.worktree.dir === "string"
      ? globalCfg.worktree.dir
      : base
        ? getLegacyGlobalWorktreeDir(base)
        : undefined;
  const legacyGlobalWorktreeDir =
    rawGlobalLegacyWorktreeDir && rawGlobalLegacyWorktreeDir.length > 0 ? rawGlobalLegacyWorktreeDir : undefined;
  const rawLegacyWorktreeDir =
    isPlainObject(repoCfg.worktree) && typeof repoCfg.worktree.dir === "string"
      ? repoCfg.worktree.dir
      : isPlainObject(globalCfg.worktree) && typeof globalCfg.worktree.dir === "string"
        ? globalCfg.worktree.dir
        : base
          ? getLegacyWorktreeDir(base)
          : undefined;
  const legacyWorktreeDir =
    rawLegacyWorktreeDir && rawLegacyWorktreeDir.length > 0 ? rawLegacyWorktreeDir : undefined;
  globalCfg = dropUnsupportedSectionKeys(globalCfg);
  repoCfg = dropUnsupportedSectionKeys(repoCfg);
  const stateDir = runtime.stateDir;
  const merged = { ...globalCfg, ...repoCfg } as Partial<HarnessConfig>;
  const rollover: RolloverConfig = {
    ...(base
      ? base.rollover
      : {
          orchestratorThreshold: 0.72,
          workerThreshold: 0.78,
          orchestratorMaxTurns: 200,
          workerMaxTurns: 120,
          taskMaxTurns: 40,
          reviewerMaxTurns: 30,
          externalizeBytes: 2048,
          maxGenerations: 12,
        }),
    ...(globalCfg.rollover as Partial<RolloverConfig> | undefined),
    ...(repoCfg.rollover as Partial<RolloverConfig> | undefined),
  };

  // Only the operator's config may grant access to additional host directories.
  const globalWorktree = globalCfg.worktree as Partial<WorktreeConfig> | undefined;
  const { extraReadRoots: _repoRead, extraWriteRoots: _repoWrite, ...repoWorktree } =
    (repoCfg.worktree as Partial<WorktreeConfig> | undefined) ?? {};
  const { roots, warning } = normalizeWorktreeRoots(globalWorktree);
  if (warning) console.error(`[harness] ${warning}; ignoring invalid entries`);
  const worktree: WorktreeConfig = base
    ? {
        ...base.worktree,
        ...globalWorktree,
        ...repoWorktree,
        extraReadRoots:
          globalWorktree && "extraReadRoots" in globalWorktree ? roots.extraReadRoots : base.worktree.extraReadRoots,
        extraWriteRoots:
          globalWorktree && "extraWriteRoots" in globalWorktree ? roots.extraWriteRoots : base.worktree.extraWriteRoots,
      }
    : {
        ciTimeoutMs: 300_000,
        gitAuthorName: "pi-harness",
        gitAuthorEmail: "harness@local",
        archiveRetentionDays: 7,
        maxConcurrentWorkers: 4,
        ...globalWorktree,
        ...repoWorktree,
        ...roots,
      };

  // Security: gate shell/env run commands with operator credentials, so they MUST only come from trusted user
  // global config, never from untrusted repository `.pi-harness.json`. They are file-authoritative: `base` never
  // supplies them, so removing them from `config.json` clears them on reload. Invalid values are kept here and fail
  // gates closed at run time (no throw: loadConfig runs for every CLI command).
  const globalGoals = globalCfg.goals as Record<string, unknown> | undefined;
  const { gateShell: globalShell, gateEnv: globalEnv, ...globalGoalsRest } = globalGoals ?? {};
  const { gateShell: _repoShell, gateEnv: _repoEnv, ...repoGoals } =
    (repoCfg.goals as Record<string, unknown> | undefined) ?? {};
  const { gateShell: _baseShell, gateEnv: _baseEnv, ...baseGoals } = base?.goals ?? ({} as Partial<GoalsConfig>);
  const goals: GoalsConfig = {
    ...(base
      ? (baseGoals as GoalsConfig)
      : {
          defaultMaxReviewCycles: 4,
          defaultMaxNoProgressCycles: 2,
          gateTimeoutMs: 180_000,
          autoVerifyOnSettle: true,
          maxConcurrentGoals: 4,
        }),
    ...(globalGoalsRest as Partial<GoalsConfig>),
    ...(repoGoals as Partial<GoalsConfig>),
  };
  if (globalShell !== undefined && globalShell !== null && globalShell !== "") goals.gateShell = globalShell as string;
  if (globalEnv !== undefined && globalEnv !== null) goals.gateEnv = globalEnv as Record<string, string>;

  const events: EventsConfig = {
    ...(base ? base.events : { fallbackWakeupIntervalSec: 600, wakeDirectorOnGoalSettle: true }),
    ...(globalCfg.events as Partial<EventsConfig> | undefined),
    ...(repoCfg.events as Partial<EventsConfig> | undefined),
  };

  const catalog: CatalogConfig = {
    ...(base
      ? base.catalog
      : {
          ttlHours: 24,
          artificialAnalysisKeyEnv: "ARTIFICIAL_ANALYSIS_API_KEY",
          allowPreview: true,
          preferSubscription: true,
          modelFilterMode: "all" as const,
          disabledModels: [],
          enabledModels: [],
        }),
    ...(globalCfg.catalog as Partial<CatalogConfig> | undefined),
    ...(repoCfg.catalog as Partial<CatalogConfig> | undefined),
  };

  const quotaRetry: QuotaRetryConfig = {
    ...(base
      ? base.quotaRetry
      : {
          nativeRetryTimeoutMs: 45_000,
          fallbackCooldownSec: 60,
          maxCooldownSec: 900,
          autoResumeEnabled: true,
          earlyWakePollMs: 30_000,
        }),
    ...(globalCfg.quotaRetry as Partial<QuotaRetryConfig> | undefined),
    ...(repoCfg.quotaRetry as Partial<QuotaRetryConfig> | undefined),
  };

  // Hot-update policy is operator-controlled and global-only.
  const { config: hotUpdate, warnings: hotUpdateWarnings } = normalizeHotUpdateConfig(
    globalCfg.hotUpdate,
    base ? base.hotUpdate : DEFAULT_HOT_UPDATE_CONFIG,
  );
  for (const w of hotUpdateWarnings) {
    console.error(`[harness] ${w}`);
  }

  // Storage location and retention policy are operator-controlled and global-only.
  const { config: storage, warnings: storageWarnings } = normalizeStorageConfig(
    globalCfg.storage,
    base ? base.storage : { dataDir: defaultDataDir(stateDir) },
  );
  for (const w of storageWarnings) {
    console.error(`[harness] ${w}`);
  }
  const { config: retention, warnings: retentionWarnings } = normalizeRetentionConfig(
    globalCfg.retention,
    base ? base.retention : DEFAULT_RETENTION_CONFIG,
  );
  for (const w of retentionWarnings) {
    console.error(`[harness] ${w}`);
  }

  const profiles =
    Array.isArray(merged.profiles) && merged.profiles.length > 0 ? merged.profiles : (base?.profiles ?? defaultProfiles());

  // Security: `remotes` (SSH peer trust & auto-connect targets) MUST only come from trusted user global config,
  // never from untrusted repository `.pi-harness.json`.
  const rawRemotes = "remotes" in globalCfg ? globalCfg.remotes : base?.remotes;
  const remotes = Array.isArray(rawRemotes) ? (rawRemotes as RemoteHostConfig[]) : undefined;
  // An explicit `[]` clears servers inherited from `base`.
  const rawExternalMcp = "externalMcpServers" in merged ? merged.externalMcpServers : base?.externalMcpServers;
  const externalMcpServers = Array.isArray(rawExternalMcp) ? rawExternalMcp : undefined;

  const codeMode = merged.codeMode ?? base?.codeMode ?? "collapsed";
  if (!["collapsed", "hybrid", "off"].includes(codeMode)) throw new Error(`Unknown codeMode: ${codeMode}`);
  const firstEnabledProfileId = profiles.find(
    (p) =>
      Boolean(p) &&
      typeof p === "object" &&
      typeof (p as { id?: unknown }).id === "string" &&
      (p as { id: string }).id.length > 0 &&
      p.enabled !== false,
  )?.id;
  return {
    stateDir,
    socketPath: runtime.socketPath ?? (merged.socketPath ? resolve(merged.socketPath) : defaultSocketPath(stateDir)),
    profiles,
    ...(remotes?.length ? { remotes } : {}),
    ...(externalMcpServers?.length ? { externalMcpServers } : {}),
    codeMode,
    codeExec: {
      ...(base ? base.codeExec : { defaultTimeoutMs: 300_000, maxTimeoutMs: 1_800_000 }),
      ...(globalCfg.codeExec as HarnessConfig["codeExec"]),
      ...(repoCfg.codeExec as HarnessConfig["codeExec"]),
    },
    defaultOrchestratorProfile: merged.defaultOrchestratorProfile ?? base?.defaultOrchestratorProfile ?? firstEnabledProfileId,
    defaultWorkerProfile: merged.defaultWorkerProfile ?? base?.defaultWorkerProfile ?? firstEnabledProfileId,
    defaultTaskProfile: merged.defaultTaskProfile ?? base?.defaultTaskProfile ?? firstEnabledProfileId,
    rollover,
    worktree,
    goals,
    events,
    catalog,
    quotaRetry,
    quotaEndpoint:
      "quotaEndpoint" in merged
        ? ((merged.quotaEndpoint as QuotaEndpointConfig | null | undefined) ?? undefined)
        : base?.quotaEndpoint,
    hotUpdate,
    storage,
    retention,
    // Always define both symbols as own enumerable properties (even when undefined) so Object.assign
    // in orchestrator.updateConfig overwrites/clears them consistently and StoragePaths trusts them authoritatively.
    [LEGACY_WORKTREE_DIR]: legacyWorktreeDir,
    [LEGACY_GLOBAL_WORKTREE_DIR]: legacyGlobalWorktreeDir,
  };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Deep JSON equality: plain-object member order is ignored, array order is significant, and members whose value is
 * `undefined` count as absent (as in `JSON.stringify`).
 */
export function stableEqual(a: unknown, b: unknown): boolean {
  if (a === b || Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => stableEqual(x, b[i]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a).filter((k) => a[k] !== undefined);
  const keysB = Object.keys(b).filter((k) => b[k] !== undefined);
  return keysA.length === keysB.length && keysA.every((k) => b[k] !== undefined && stableEqual(a[k], b[k]));
}

/**
 * Validates the shape of a global `config.json` document or a `config.update` patch. Unknown top-level keys are ignored;
 * unsupported section keys are dropped before validation.
 * Returns one message per problem, naming the path and expectation; values are never echoed (they may be secrets).
 */
export function validateConfigRaw(raw: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(raw)) return ["config must be a JSON object"];
  const doc = dropUnsupportedSectionKeys(raw);

  const isString = (v: unknown) => typeof v === "string";
  const isNonEmptyString = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const isBoolean = (v: unknown) => typeof v === "boolean";
  const isStringArray = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const isStringRecord = (v: unknown) => isPlainObject(v) && Object.values(v).every((x) => typeof x === "string");
  const isPositiveInt = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v > 0;
  const isFiniteNonNegative = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const isFinitePositive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  const oneOf = (...values: string[]) => (v: unknown) => typeof v === "string" && values.includes(v);

  type Rule = [check: (v: unknown) => boolean, expectation: string];
  const STRING: Rule = [isString, "a string"];
  const NON_EMPTY: Rule = [isNonEmptyString, "a non-empty string"];
  const BOOLEAN: Rule = [isBoolean, "a boolean"];
  const STRINGS: Rule = [isStringArray, "an array of strings"];
  const STRING_MAP: Rule = [isStringRecord, "an object of string values"];
  const POS_INT: Rule = [isPositiveInt, "a positive integer"];
  const NON_NEG: Rule = [isFiniteNonNegative, "a finite number >= 0"];
  const POSITIVE: Rule = [isFinitePositive, "a finite number > 0"];

  const checkFields = (obj: Record<string, unknown>, path: string, rules: Record<string, Rule>, required = false) => {
    for (const [key, [check, expectation]] of Object.entries(rules)) {
      if (!required && !(key in obj)) continue;
      if (!check(obj[key])) errors.push(`${path}.${key} must be ${expectation}`);
    }
  };
  const section = (key: string, rules: Record<string, Rule>): Record<string, unknown> | undefined => {
    if (!(key in doc)) return undefined;
    const value = doc[key];
    if (!isPlainObject(value)) {
      errors.push(`${key} must be an object`);
      return undefined;
    }
    checkFields(value, key, rules);
    return value;
  };
  const list = (key: string): unknown[] | undefined => {
    if (!(key in doc)) return undefined;
    if (!Array.isArray(doc[key])) {
      errors.push(`${key} must be an array`);
      return undefined;
    }
    return doc[key] as unknown[];
  };

  checkFields(doc, "config", { stateDir: NON_EMPTY, socketPath: NON_EMPTY });

  const profileIds = new Set<string>();
  list("profiles")?.forEach((profile, i) => {
    const path = `profiles[${i}]`;
    if (!isPlainObject(profile)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(profile.id)) errors.push(`${path}.id must be a non-empty string`);
    else if (profileIds.has(profile.id as string)) errors.push(`${path}.id must be unique`);
    else profileIds.add(profile.id as string);
    checkFields(profile, path, { billing: [oneOf("subscription", "api", "local"), '"subscription", "api", or "local"'] }, true);
    checkFields(profile, path, { enabled: BOOLEAN, models: STRINGS });
    if (profile.kind === "acp") {
      checkFields(
        profile,
        path,
        {
          adapter: [oneOf("claude", "codex", "gemini", "generic"), '"claude", "codex", "gemini", or "generic"'],
          command: NON_EMPTY,
        },
        true,
      );
      checkFields(profile, path, {
        args: STRINGS,
        readOnlyArgs: STRINGS,
        env: STRING_MAP,
      });
    } else if (profile.kind === "pi") {
      checkFields(profile, path, { provider: NON_EMPTY }, true);
      checkFields(profile, path, {
        api: [
          oneOf("openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"),
          "a supported pi api",
        ],
        baseUrl: STRING,
        apiKeyEnv: STRING,
      });
    } else {
      errors.push(`${path}.kind must be "acp" or "pi"`);
    }
  });

  const remoteNames = new Set<string>();
  list("remotes")?.forEach((remote, i) => {
    const path = `remotes[${i}]`;
    if (!isPlainObject(remote)) {
      errors.push(`${path} must be an object`);
      return;
    }
    const name = remote.name;
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) {
      errors.push(`${path}.name must contain only letters, digits, '.', '_', or '-'`);
    } else if (name.toLowerCase() === "local") {
      errors.push(`${path}.name must not be "local"`);
    } else if (remoteNames.has(name.toLowerCase())) {
      errors.push(`${path}.name must be unique (case-insensitive)`);
    } else {
      remoteNames.add(name.toLowerCase());
    }
    if (!isNonEmptyString(remote.sshTarget)) errors.push(`${path}.sshTarget must be a non-empty string`);
    checkFields(remote, path, {
      bridgeCommand: STRING,
      autoConnect: BOOLEAN,
      reverseAccess: [oneOf("messages", "full"), '"messages" or "full"'],
    });
  });

  list("externalMcpServers")?.forEach((server, i) => {
    const path = `externalMcpServers[${i}]`;
    if (!isPlainObject(server)) {
      errors.push(`${path} must be an object`);
      return;
    }
    if (!isNonEmptyString(server.name)) errors.push(`${path}.name must be a non-empty string`);
    checkFields(server, path, { enabled: BOOLEAN, args: STRINGS, env: STRING_MAP });
    if (server.enabled === false) checkFields(server, path, { command: STRING });
    else if (!isNonEmptyString(server.command)) errors.push(`${path}.command must be a non-empty string`);
  });

  checkFields(doc, "config", {
    codeMode: [oneOf("collapsed", "hybrid", "off"), '"collapsed", "hybrid", or "off"'],
    defaultOrchestratorProfile: NON_EMPTY,
    defaultWorkerProfile: NON_EMPTY,
    defaultTaskProfile: NON_EMPTY,
  });
  section("codeExec", { defaultTimeoutMs: POS_INT, maxTimeoutMs: POS_INT, maxOutputChars: POS_INT });
  const ratio: Rule = [(v) => typeof v === "number" && v > 0 && v <= 1, "a number in (0, 1]"];
  section("rollover", {
    orchestratorThreshold: ratio,
    workerThreshold: ratio,
    orchestratorMaxTurns: POS_INT,
    workerMaxTurns: POS_INT,
    taskMaxTurns: POS_INT,
    reviewerMaxTurns: POS_INT,
    externalizeBytes: POS_INT,
    maxGenerations: POS_INT,
  });
  const worktree = section("worktree", {
    gitAuthorName: NON_EMPTY,
    gitAuthorEmail: NON_EMPTY,
    setupCommand: STRING,
    ciCommands: STRINGS,
    ciTimeoutMs: POS_INT,
    maxConcurrentWorkers: POS_INT,
    archiveRetentionDays: NON_NEG,
  });
  if (worktree) {
    const { warning } = normalizeWorktreeRoots(worktree);
    if (warning) errors.push(warning);
  }
  const goalsSection = section("goals", {
    defaultMaxReviewCycles: POS_INT,
    defaultMaxNoProgressCycles: POS_INT,
    gateTimeoutMs: POS_INT,
    maxConcurrentGoals: POS_INT,
    autoVerifyOnSettle: BOOLEAN,
  });
  if (goalsSection) errors.push(...normalizeGateConfig(goalsSection).issues);
  section("events", { fallbackWakeupIntervalSec: POSITIVE, wakeDirectorOnGoalSettle: BOOLEAN });
  section("catalog", {
    ttlHours: NON_NEG,
    artificialAnalysisKeyEnv: STRING,
    allowPreview: BOOLEAN,
    preferSubscription: BOOLEAN,
    modelFilterMode: [oneOf("all", "allowlist"), '"all" or "allowlist"'],
    disabledModels: STRINGS,
    enabledModels: STRINGS,
  });
  section("quotaRetry", {
    nativeRetryTimeoutMs: NON_NEG,
    fallbackCooldownSec: NON_NEG,
    maxCooldownSec: NON_NEG,
    earlyWakePollMs: POSITIVE,
    autoResumeEnabled: BOOLEAN,
  });
  section("hotUpdate", {
    mode: [oneOf("auto", "manual"), '"auto" or "manual"'],
    drainTimeoutSec: [
      (v) =>
        typeof v === "number" &&
        Number.isFinite(v) &&
        v >= HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC &&
        v <= HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC,
      `a finite number in ${HOT_UPDATE_DRAIN_TIMEOUT_MIN_SEC}..${HOT_UPDATE_DRAIN_TIMEOUT_MAX_SEC}`,
    ],
    minIntervalSec: [
      (v) =>
        typeof v === "number" &&
        Number.isFinite(v) &&
        v >= HOT_UPDATE_MIN_INTERVAL_MIN_SEC &&
        v <= HOT_UPDATE_MIN_INTERVAL_MAX_SEC,
      `a finite number in ${HOT_UPDATE_MIN_INTERVAL_MIN_SEC}..${HOT_UPDATE_MIN_INTERVAL_MAX_SEC}`,
    ],
  });
  section("storage", {
    dataDir: [(v) => isNonEmptyString(v) && !(v as string).includes("\0"), "a non-empty path string"],
  });
  section("retention", {
    installReleases: POS_INT,
    logMaxBytes: POS_INT,
  });
  if ("quotaEndpoint" in doc && doc.quotaEndpoint !== null) {
    const endpoint = doc.quotaEndpoint;
    if (!isPlainObject(endpoint)) {
      errors.push("quotaEndpoint must be an object or null");
    } else {
      if (!isNonEmptyString(endpoint.url)) errors.push("quotaEndpoint.url must be a non-empty string");
      checkFields(endpoint, "quotaEndpoint", {
        headers: STRING_MAP,
        pollIntervalSec: POSITIVE,
        timeoutMs: POSITIVE,
        format: [oneOf("protojson", "protobuf"), '"protojson" or "protobuf"'],
      });
    }
  }
  return errors;
}

/** One secret-safe difference between two effective configs. List entries carry ids/names only, never values. */
export interface ConfigChange {
  path: string;
  from?: unknown;
  to?: unknown;
  added?: string[];
  removed?: string[];
  changed?: string[];
}

/**
 * Reports what changed between two configs without exposing secret-bearing values (env, args, commands, URLs, headers).
 * Tolerates malformed data on either side (e.g. a startup config holding `[null]`), reporting a path-level change
 * instead of throwing, so a valid replacement can always be applied.
 */
export function diffHarnessConfig(prev: HarnessConfig, next: HarnessConfig): ConfigChange[] {
  const changes: ConfigChange[] = [];
  const isPrintable = (v: unknown) => v === undefined || typeof v === "number" || typeof v === "boolean";

  for (const key of ["codeMode", "defaultOrchestratorProfile", "defaultWorkerProfile", "defaultTaskProfile"] as const) {
    const a: unknown = prev[key];
    const b: unknown = next[key];
    if (stableEqual(a, b)) continue;
    const showValues = [a, b].every((v) => isPrintable(v) || typeof v === "string");
    changes.push(showValues ? { path: key, from: a, to: b } : { path: key });
  }

  for (const key of [
    "codeExec",
    "rollover",
    "worktree",
    "goals",
    "events",
    "catalog",
    "quotaRetry",
    "hotUpdate",
    "storage",
    "retention",
  ] as const) {
    const rawA: unknown = prev[key] ?? {};
    const rawB: unknown = next[key] ?? {};
    if (!isPlainObject(rawA) || !isPlainObject(rawB)) {
      if (!stableEqual(rawA, rawB)) changes.push({ path: key });
      continue;
    }
    for (const sub of new Set([...Object.keys(rawA), ...Object.keys(rawB)])) {
      if (stableEqual(rawA[sub], rawB[sub])) continue;
      const path = `${key}.${sub}`;
      const neverShowValues = path === "goals.gateShell" || path === "goals.gateEnv";
      const showValues =
        !neverShowValues &&
        ((isPrintable(rawA[sub]) && isPrintable(rawB[sub])) ||
          ((path === "catalog.modelFilterMode" || path === "hotUpdate.mode") &&
            typeof rawA[sub] !== "object" &&
            typeof rawB[sub] !== "object"));
      changes.push(showValues ? { path, from: rawA[sub], to: rawB[sub] } : { path });
    }
  }

  const diffList = (path: string, a: unknown, b: unknown, key: string) => {
    const entries = (list: unknown) => {
      const map = new Map<string, unknown>();
      if (Array.isArray(list)) {
        for (const item of list) {
          if (isPlainObject(item) && typeof item[key] === "string") map.set(item[key] as string, item);
        }
      }
      return map;
    };
    const before = entries(a);
    const after = entries(b);
    const added = [...after.keys()].filter((k) => !before.has(k));
    const removed = [...before.keys()].filter((k) => !after.has(k));
    const changed = [...after.keys()].filter((k) => before.has(k) && !stableEqual(before.get(k), after.get(k)));
    if (added.length || removed.length || changed.length) changes.push({ path, added, removed, changed });
    else if (!stableEqual(a ?? [], b ?? [])) changes.push({ path, changed: [] }); // order, duplicate, or malformed entries
  };
  diffList("profiles", prev.profiles, next.profiles, "id");
  diffList("remotes", prev.remotes, next.remotes, "name");
  diffList("externalMcpServers", prev.externalMcpServers, next.externalMcpServers, "name");

  const pe: unknown = prev.quotaEndpoint;
  const ne: unknown = next.quotaEndpoint;
  const pePresent = pe !== undefined && pe !== null;
  const nePresent = ne !== undefined && ne !== null;
  if (pePresent !== nePresent) {
    changes.push({ path: "quotaEndpoint", from: pePresent ? "set" : "unset", to: nePresent ? "set" : "unset" });
  } else if (pePresent && nePresent && !stableEqual(pe, ne)) {
    if (isPlainObject(pe) && isPlainObject(ne)) {
      const keys = new Set([...Object.keys(pe), ...Object.keys(ne)]);
      const changed = [...keys].filter((k) => !stableEqual(pe[k], ne[k]));
      changes.push({ path: "quotaEndpoint", changed });
    } else {
      changes.push({ path: "quotaEndpoint", changed: [] });
    }
  }
  return changes;
}

/**
 * Persists mutable user settings & external harness CLI profiles to `~/.pi-harness/config.json`
 * so changes made in the `/settings` TUI overlay survive restarts and hot-reload inside `harnessd`.
 */
export function saveGlobalConfig(config: HarnessConfig): string {
  mkdirSync(config.stateDir, { recursive: true });
  const filePath = join(config.stateDir, "config.json");
  writeFileSync(filePath, serializeGlobalConfig(config), "utf8");
  return filePath;
}

/** The exact `config.json` text `saveGlobalConfig` writes for `config`. */
export function serializeGlobalConfig(config: HarnessConfig): string {
  const hotUpdateOut: Partial<HotUpdateConfig> = {};
  if (config.hotUpdate.mode !== DEFAULT_HOT_UPDATE_CONFIG.mode) hotUpdateOut.mode = config.hotUpdate.mode;
  if (config.hotUpdate.drainTimeoutSec !== DEFAULT_HOT_UPDATE_CONFIG.drainTimeoutSec) {
    hotUpdateOut.drainTimeoutSec = config.hotUpdate.drainTimeoutSec;
  }
  if (config.hotUpdate.minIntervalSec !== DEFAULT_HOT_UPDATE_CONFIG.minIntervalSec) {
    hotUpdateOut.minIntervalSec = config.hotUpdate.minIntervalSec;
  }
  const storageOut: Partial<StorageConfig> = {};
  if (config.storage.dataDir !== defaultDataDir(config.stateDir)) {
    storageOut.dataDir = config.storage.dataDir;
  }
  const retentionOut: Partial<RetentionConfig> = {};
  if (config.retention.installReleases !== DEFAULT_RETENTION_CONFIG.installReleases) {
    retentionOut.installReleases = config.retention.installReleases;
  }
  if (config.retention.logMaxBytes !== DEFAULT_RETENTION_CONFIG.logMaxBytes) {
    retentionOut.logMaxBytes = config.retention.logMaxBytes;
  }
  const { dir: _removedDir, artifactsDir: _removedArtifactsDir, ...worktreeOut } =
    config.worktree as Record<string, unknown>;
  const legacyGlobalWorktreeDir = getLegacyGlobalWorktreeDir(config);
  if (legacyGlobalWorktreeDir !== undefined) {
    worktreeOut.dir = legacyGlobalWorktreeDir;
  }
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
    worktree: worktreeOut,
    goals: config.goals,
    events: config.events,
    catalog: config.catalog,
    quotaRetry: config.quotaRetry,
    ...(Object.keys(hotUpdateOut).length > 0 ? { hotUpdate: hotUpdateOut } : {}),
    ...(Object.keys(storageOut).length > 0 ? { storage: storageOut } : {}),
    ...(Object.keys(retentionOut).length > 0 ? { retention: retentionOut } : {}),
    ...(config.socketPath !== defaultSocketPath(config.stateDir) ? { socketPath: config.socketPath } : {}),
    ...(config.quotaEndpoint ? { quotaEndpoint: config.quotaEndpoint } : {}),
  };
  return JSON.stringify(serialized, null, 2) + "\n";
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
