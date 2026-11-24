import { contextWarningText, formatNotice } from "../advisories/message.js";
import { deniedNotice, HarnessRejection, REJECTIONS } from "../advisories/rejections.js";
import { toolEventPreview } from "../protocol/tool-display.js";
import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream, PROTOCOL_VERSION, type AgentApp, type ClientConnection } from "@agentclientprotocol/sdk/unstable";
import { interpolateEnv, type AcpProfileConfig } from "../config.js";
import {
  buildNewSessionParams,
  buildPostSessionActions,
  extractArtifactsFromToolUpdate,
  isAmpAcpProfile,
  isReadOnlyExternalMcpTool,
  isSafeReadOnlyShellCommand,
  prepareAcpSpawn,
  reportedModels,
  reportedModelSatisfies,
  selectValues,
  type AcpModelState,
  type AcpConfigOption,
  type AcpMcpServerEntry,
} from "./acp-shims.js";
import {
  ACP_AUTH_TEXT_RE,
  AcpProfileError,
  acpProfileLoginHint,
  isAcpAuthError,
  isStandaloneAcpAuthDiagnostic,
  isStructuredAuthFailureCode,
} from "./acp-profile-error.js";
export {
  ACP_AUTH_TEXT_RE,
  AcpProfileError,
  acpProfileLoginHint,
  isAcpAuthError,
  isStandaloneAcpAuthDiagnostic,
  isStructuredAuthFailureCode,
  type AcpProfileErrorKind,
} from "./acp-profile-error.js";
import { isProtectedWritePath } from "./protected-paths.js";
import { detectQuotaErrorText } from "./quota-detect.js";
import { ACP_EXECUTOR_LOST_ERROR_CODE, MAX_RUNNER_STEER_CONTINUATIONS, validateRunPolicy } from "./types.js";
import type {
  ProbedModelInfo,
  QuotaPauseInfo,
  RunAgentRequest,
  RunAgentResult,
  RunnerCost,
  RunnerErrorCode,
  RunnerUsage,
  ToolPolicy,
} from "./types.js";
export { ACP_EXECUTOR_LOST_ERROR_CODE, type RunnerErrorCode } from "./types.js";

/** Returns an accurate, human-readable description of the active tool policy and permissions. */
export function describeToolPolicyMode(toolPolicy: ToolPolicy, allowShellInReadOnly = false): string {
  if (toolPolicy === "control_plane_only") {
    return "control-plane-only (harness MCP tools only; no workspace reads, writes, or shell)";
  }
  if (toolPolicy === "read_only_workspace") {
    return allowShellInReadOnly
      ? "read-only workspace with verification shell (no file writes)"
      : "read-only workspace (no file writes or shell)";
  }
  return "read-write workspace";
}

const CODEX_CODE_MODE_UNAVAILABLE_RE = /code\s+mode\s+is\s+unavailable|codex-code-mode-host/i;

/** Detects Codex 0.170+ fail-closed MCP breakage caused by a missing `codex-code-mode-host` binary. */
export function detectCodexCodeModeMisconfig(text: string): string | null {
  if (!CODEX_CODE_MODE_UNAVAILABLE_RE.test(text)) return null;
  return (
    "Profile misconfigured: Codex Code Mode is unavailable (`codex-code-mode-host` is missing or failed closed), " +
    "blocking the harness MCP tool bridge. Install `codex-code-mode-host` alongside `codex-acp` on PATH, " +
    "or disable it with `features.code_mode_host=false` (CLI `-c features.code_mode_host=false` or `CODEX_CONFIG`)."
  );
}

const terminatingChildren = new WeakSet<ChildProcess>();

function terminateChild(child: ChildProcess | null | undefined): void {
  if (!child) return;
  if (terminatingChildren.has(child)) return;
  terminatingChildren.add(child);

  const pid = child.pid;
  const signalGroupOrChild = (sig: NodeJS.Signals) => {
    if (process.platform !== "win32" && pid) {
      try {
        process.kill(-pid, sig);
        return;
      } catch {
        // Group may already be gone (ESRCH) or not a process group leader; fall through to direct child
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    }
  };

  signalGroupOrChild("SIGTERM");
  // Keep the SIGKILL grace timer active even if the leader (e.g. `npx`) already exited,
  // so SIGTERM-ignoring descendants in the same process group are reliably reaped.
  const killTimer = setTimeout(() => {
    signalGroupOrChild("SIGKILL");
  }, 2000);
  killTimer.unref?.();
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      onTimeout?.();
      rejectPromise(new Error(message));
    }, ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      },
    );
  });
}

function requireWorkspacePath(root: string, path: string): void {
  const rel = relative(root, path);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    throw REJECTIONS.outsideRoots(path, root);
  }
}

async function workspaceTarget(root: string, requested: string, allowNew: boolean) {
  const realRoot = await realpath(root);
  const absolute = resolve(realRoot, requested);
  try {
    const path = await realpath(absolute);
    requireWorkspacePath(realRoot, path);
    return { path, exists: true };
  } catch (error) {
    if (!allowNew || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  // Walk up parent directories until an existing ancestor is found, ensuring no intermediate
  // symlink escapes `realRoot` and no dangling symlink occupies the target path.
  const missingSegments: string[] = [];
  let cursor = absolute;
  let existingAncestor: string | null = null;
  while (true) {
    const entry = await lstat(cursor).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry) {
      if (missingSegments.length === 0) {
        // A dangling symlink is an existing directory entry, not a new workspace file.
        throw new Error("ACP filesystem target is not a new workspace file");
      }
      existingAncestor = await realpath(cursor);
      requireWorkspacePath(realRoot, existingAncestor);
      break;
    }
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw REJECTIONS.outsideRoots(requested, realRoot);
    }
    missingSegments.unshift(basename(cursor));
    cursor = parent;
  }

  const path = resolve(existingAncestor, ...missingSegments);
  requireWorkspacePath(realRoot, path);
  if (await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  })) throw new Error("ACP filesystem target is not a new workspace file");
  return { path, exists: false };
}

async function resolveExtraRoots(rawRoots: string[] | undefined): Promise<string[]> {
  if (!rawRoots?.length) return [];
  const out: string[] = [];
  for (const raw of rawRoots) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? resolve(homedir(), trimmed.slice(2)) : resolve(trimmed);
    try {
      out.push(await realpath(expanded));
    } catch {
      out.push(expanded);
    }
  }
  return out;
}

/**
 * Which allowed roots veto reads of `.git` and `.harness/worktrees` (same predicate as writes):
 * `extra` only the extra roots, `all` the primary root too.
 */
type ReadProtection = "none" | "extra" | "all";

async function resolveAllowedTarget(
  primaryRoot: string,
  extraRoots: string[],
  requested: string,
  allowNew: boolean,
  protectWrites = false,
  protectReads: ReadProtection = "none",
): Promise<{ path: string; exists: boolean; root: string }> {
  let firstErr: unknown;
  for (const root of [primaryRoot, ...extraRoots]) {
    const readProtected = protectReads === "all" || (protectReads === "extra" && root !== primaryRoot);
    // Refuse protected targets before any side effect, checking the lexical path first and the canonical
    // path once resolved. A protected hit is final and never falls through to later roots.
    if (protectWrites && isProtectedWritePath(root, requested)) throw PROTECTED_WRITE_ERROR(requested, root);
    if (readProtected && isProtectedWritePath(root, requested)) throw PROTECTED_READ_ERROR(requested, root);
    let target: { path: string; exists: boolean };
    try {
      target = await workspaceTarget(root, requested, allowNew);
    } catch (err) {
      if (!firstErr) firstErr = err;
      continue;
    }
    if (protectWrites && isProtectedWritePath(root, target.path)) throw PROTECTED_WRITE_ERROR(target.path, root);
    if (readProtected && isProtectedWritePath(root, target.path)) throw PROTECTED_READ_ERROR(target.path, root);
    return { ...target, root };
  }
  throw firstErr ?? REJECTIONS.outsideRoots(requested, primaryRoot);
}

const PROTECTED_WRITE_ERROR = (path: string, root: string) => REJECTIONS.protectedPath(path, root);
const PROTECTED_READ_ERROR = (path: string, root: string) => REJECTIONS.protectedPath(path, root);

/**
 * Read protection for a policy: writers keep unrestricted reads; read-only agents never read `.git` or
 * `.harness/worktrees` through extra roots, nor through the primary root unless the workspace is itself a
 * linked git worktree (a task or `_verify` checkout, whose `.git` is a file) so a reviewer can inspect its own
 * checkout.
 */
async function readProtectionFor(workspace: string, canWrite: boolean): Promise<ReadProtection> {
  if (canWrite) return "none";
  const dotGit = await lstat(resolve(workspace, ".git")).catch(() => undefined);
  return dotGit?.isFile() ? "extra" : "all";
}

async function openWorkspaceFile(
  primaryRoot: string,
  extraRoots: string[],
  requested: string,
  write: boolean,
  protectReads: ReadProtection = "none",
) {
  const { path: target, exists, root } = await resolveAllowedTarget(primaryRoot, extraRoots, requested, write, write, protectReads);
  if (write && !exists) {
    await mkdir(dirname(target), { recursive: true });
    const actualParent = await realpath(dirname(target));
    requireWorkspacePath(root, actualParent);
  }
  const flags = (write ? constants.O_WRONLY : constants.O_RDONLY) | constants.O_NOFOLLOW |
    constants.O_NONBLOCK | (exists ? 0 : constants.O_CREAT | constants.O_EXCL);
  const file = await open(target, flags);
  try {
    const actual = await realpath(target);
    requireWorkspacePath(root, actual);
    if (write && isProtectedWritePath(root, actual)) throw PROTECTED_WRITE_ERROR(actual, root);
    if (!write && (protectReads === "all" || (protectReads === "extra" && root !== primaryRoot)) &&
        isProtectedWritePath(root, actual)) throw PROTECTED_READ_ERROR(actual, root);
    const opened = await file.stat();
    const current = await stat(actual);
    if (!opened.isFile() || (write && opened.nlink !== 1) || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error("ACP filesystem request requires a regular workspace file");
    }
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

/** Flattens JSON-RPC RequestError.data (the ACP SDK wraps thrown agent errors as -32603 `{ details }`, or as the parsed object when the message was JSON). Walks `cause` so re-wrapped errors keep their detail. */
function acpErrorDetail(err: unknown): string {
  return acpErrorParts(err).join(" | ").slice(0, 1000);
}

/** The individual diagnostic strings acpErrorDetail joins, in walk order. */
function acpErrorParts(err: unknown): string[] {
  const parts: string[] = [];
  // True when `v` carries detail, even if an earlier hop already recorded the same text.
  const push = (v: unknown): boolean => {
    if (typeof v !== "string") return false;
    const s = v.trim();
    if (!s) return false;
    if (!parts.includes(s)) parts.push(s);
    return true;
  };
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 3; depth++) {
    // Throwing getters or cyclic data end the walk instead of escaping from error reporting.
    try {
      const data = (cur as { data?: unknown }).data;
      if (typeof data === "string") push(data);
      else if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        const found = [
          push(d.details),
          push(d.message),
          push(typeof d.error === "string" ? d.error : (d.error as { message?: unknown } | undefined)?.message),
        ].some(Boolean);
        if (!found && Object.keys(d).length > 0) push(JSON.stringify(d));
      }
      cur = (cur as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return parts;
}

/**
 * The specific JSON-RPC code an outer error wraps (data.code, data.error.code, or a `cause` chain), skipping the
 * generic internal-error -32603 that SDK wrappers add. Structured codes are authoritative; diagnostic prose never is.
 */
function nestedRpcCode(err: unknown): number | undefined {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 4; depth++) {
    try {
      const candidates: unknown[] = [];
      if (depth > 0) candidates.push((cur as { code?: unknown }).code);
      const data = (cur as { data?: unknown }).data;
      if (data && typeof data === "object") {
        candidates.push((data as { code?: unknown }).code, ((data as { error?: unknown }).error as { code?: unknown } | undefined)?.code);
      }
      for (const c of candidates) if (typeof c === "number" && c !== -32603) return c;
      cur = (cur as { cause?: unknown }).cause;
    } catch {
      break;
    }
  }
  return undefined;
}

/** Last whole stderr lines that fit in `max` chars, without Node process warnings (never the failure reason). */
function stderrTail(buf: string, max = 500): string {
  const lines = buf
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^\(node:\d+\)\s/.test(l) && !/^\(Use `node --trace-/.test(l));
  let out = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = out ? `${lines[i]}\n${out}` : lines[i]!;
    if (next.length > max) break;
    out = next;
  }
  return out || (lines.at(-1)?.slice(-max) ?? "");
}

const EXECUTOR_LOST_RE = /No executor is connected/i;
const EXECUTOR_LOST_LINE_RE =
  /^\s*(?:Uncaught\s+)?(?:(?:Tool|MCP|RPC)[^:\n]*:\s*)?(?:Error:\s*)?No executor is connected\b/im;
const EXECUTOR_LOST_TEST_NOISE_RE = /\b(?:AssertionError|bun test)\b|^\s*\d+\s*\|/m;

function collectToolUpdateOutputText(update: Record<string, unknown>): string {
  const parts: string[] = [];
  const collect = (val: unknown, depth = 0): void => {
    if (depth > 4 || val == null) return;
    if (typeof val === "string") {
      if (val.trim()) parts.push(val);
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) collect(item, depth + 1);
      return;
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      for (const key of ["text", "error", "message", "stderr", "output", "result", "content"]) {
        if (key in obj) collect(obj[key], depth + 1);
      }
    }
  };
  collect(update.rawOutput);
  collect(update.content);
  return parts.join("\n").trim();
}

function detectExecutorLostToolUpdate(update: Record<string, unknown>, status: string): string | null {
  const text = collectToolUpdateOutputText(update);
  if (!text || !EXECUTOR_LOST_RE.test(text)) return null;
  const lineMatch = text.match(EXECUTOR_LOST_LINE_RE);
  if (lineMatch) {
    const start = lineMatch.index ?? 0;
    return text.slice(start, start + 220).trim();
  }
  const rawOut = update.rawOutput;
  const rawOutIsError = Boolean(
    rawOut &&
      typeof rawOut === "object" &&
      ((rawOut as { isError?: unknown }).isError === true ||
        typeof (rawOut as { error?: unknown }).error === "string"),
  );
  const isErrorShape = status === "failed" || rawOutIsError;
  // Require an error-shaped short result without test-runner or code-listing noise so normal
  // file reads, greps, or failing test logs mentioning this phrase never abort a healthy session.
  if (isErrorShape && text.length <= 500 && !EXECUTOR_LOST_TEST_NOISE_RE.test(text)) {
    return text.slice(0, 220);
  }
  return null;
}

function extractToolErrorSnippet(update: Record<string, unknown>): string | undefined {
  const rawOut = update.rawOutput;
  if (typeof rawOut === "string" && rawOut.trim()) return rawOut.trim().slice(0, 220);
  if (rawOut && typeof rawOut === "object") {
    const obj = rawOut as Record<string, unknown>;
    const msg = obj.error ?? obj.message ?? obj.stderr ?? obj.output;
    if (typeof msg === "string" && msg.trim()) return msg.trim().slice(0, 220);
  }
  const content = update.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item && typeof item === "object") {
        const c = item as Record<string, unknown>;
        const inner = (c.content && typeof c.content === "object" ? (c.content as Record<string, unknown>).text : c.text) as
          | string
          | undefined;
        if (typeof inner === "string" && inner.trim()) return inner.trim().slice(0, 220);
      }
    }
  }
  return undefined;
}

const MAX_CONSECUTIVE_SILENT_RECOVERIES = 4;
const MAX_TOTAL_RECOVERY_CONTINUATIONS = 10;
/** Wall-clock cap on the single missing-return wrap-up turn. */
const WRAP_UP_TIMEOUT_MS = 180_000;
const IDENTICAL_FAILURE_BREAKER = 6;
const DEFAULT_QUOTA_RETRY_TIMEOUT_MS = 45_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const DEFAULT_STEER_ACK_TIMEOUT_MS = 15_000;
const DEFAULT_TOOLS_GRACE_MS = 20_000;
const DEFAULT_TOOLS_CEILING_MS = 120_000;
const TOOLS_POLL_INTERVAL_MS = 100;
const HARNESS_PREFIXED_TOOL_RE =
  /^(?:mcp(?:__|_|\/|\.|:))?harness(?:__|_|\/|\.|:\s*)([a-z][a-z0-9_]*)$/i;
const AMBIGUOUS_NATIVE_TOOL_NAMES = new Set(["code_exec", "tool_search", "read_file", "write_note"]);
const ACCEPTED_STEER_STOP_REASONS = new Set(["end_turn", "max_tokens", "max_turn_requests"]);

function resolveToolsGraceMs(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override)) {
    return Math.max(0, override);
  }
  const rawEnv = process.env.PI_HARNESS_TOOLS_GRACE_MS?.trim();
  if (rawEnv !== undefined && rawEnv !== "") {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_TOOLS_GRACE_MS;
}

function resolveToolsCeilingMs(toolsGraceMs: number): number {
  const rawEnv = process.env.PI_HARNESS_TOOLS_CEILING_MS?.trim();
  if (rawEnv !== undefined && rawEnv !== "") {
    const parsed = Number(rawEnv);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed === 0 ? 0 : Math.max(parsed, toolsGraceMs);
    }
  }
  return Math.max(DEFAULT_TOOLS_CEILING_MS, toolsGraceMs);
}

export interface AcpRunnerOptions {
  steerAckTimeoutMs?: number;
}

export class AcpRunner {
  constructor(
    private readonly profile: AcpProfileConfig,
    private readonly opts?: AcpRunnerOptions,
  ) {}

  /**
   * Executes an agent turn over ACP v1 (with unstable extensions for usage_update,
   * systemPrompt, configOptions, mcpServers, and _session/steering).
   * Features:
   *  - Subscription-pool-aware soft quota watchdog (lets native 429 retries succeed across pool
   *    rotations, disarms on any forward progress, and cleanly returns `quota_paused` on timeout)
   *  - Automatic tool-failure continuation recovery so agents keep thinking after a failed/denied tool
   * Accepts an optional in-process `testAgent` for deterministic unit testing.
   */
  async run(req: RunAgentRequest, testAgent?: AgentApp): Promise<RunAgentResult> {
    validateRunPolicy(req);
    if (this.profile.models?.length && !this.profile.models.includes(req.model)) {
      throw new Error(`Model ${req.model} is unavailable on ACP profile ${this.profile.id}`);
    }
    const workspace = await realpath(req.cwd);
    const extraWriteRoots = await resolveExtraRoots(req.extraWriteRoots);
    const extraReadRoots = await resolveExtraRoots([...(req.extraReadRoots ?? []), ...(req.extraWriteRoots ?? [])]);
    const controlOnly = req.toolPolicy === "control_plane_only";
    const canWrite = req.toolPolicy === "read_write_workspace";
    const allowShell = canWrite || (req.toolPolicy === "read_only_workspace" && Boolean(req.allowShellInReadOnly));
    const readProtection = await readProtectionFor(workspace, canWrite);
    const policyModeDesc = describeToolPolicyMode(req.toolPolicy, Boolean(req.allowShellInReadOnly));
    const prepared = prepareAcpSpawn(this.profile, {
      systemPrompt: req.systemPrompt,
      toolPolicy: req.toolPolicy,
      allowShellInReadOnly: Boolean(req.allowShellInReadOnly),
      tier: req.tier,
    });
    if ((allowShell || !controlOnly) && req.extraPathDirs?.length) {
      const existingPath = prepared.env.PATH ?? process.env.PATH ?? "";
      prepared.env.PATH = [...req.extraPathDirs, existingPath].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
    }
    for (const [key, value] of Object.entries(req.extraEnv ?? {})) {
      if (typeof value === "string" && !/^path$/i.test(key)) prepared.env[key] = value;
    }
    const isAmpProfile = isAmpAcpProfile(this.profile);
    const ampExecutorIsOrb = prepared.env.AMP_ACP_EXECUTOR?.trim().toLowerCase() === "orb";
    const ampTransportIsSdk = prepared.env.AMP_ACP_TRANSPORT?.trim().toLowerCase() === "sdk";
    // Default AMP_ACP_CANCEL_MODE to off (queued delivery): sending session/cancel to Amp mid-turn can
    // drop Amp's MCP tool executor for the rest of the session ("No executor is connected").
    // Cancel-then-prompt steering stays available only via explicit AMP_ACP_CANCEL_MODE=steer opt-in.
    const ampCancelMode = prepared.env.AMP_ACP_CANCEL_MODE?.trim().toLowerCase() ?? "off";
    const ampCancelSteerEnabled =
      isAmpProfile &&
      ampCancelMode === "steer" &&
      !ampExecutorIsOrb &&
      !ampTransportIsSdk;

    const child = testAgent
      ? null
      : spawn(prepared.command, prepared.args, {
          cwd: req.cwd,
          env: prepared.env,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });

    let spawnErr: Error | null = null;
    if (child) {
      child.on("error", (err) => {
        spawnErr = err;
      });
      // Prevent unhandled EPIPE / stream errors from crashing `harnessd` when an ACP CLI exits early
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
    }

    const hasHarnessBridge = Boolean(req.daemonSocketPath && req.mcpBridgeEntrypoint);
    const harnessToolNames = new Set(req.tools.map(({ name }) => name));
    const claudeToolNames = new Set(req.tools.map(({ name }) => `mcp__harness__${name}`));
    const externalMcpEntries: AcpMcpServerEntry[] = [];
    if (!controlOnly && req.externalMcpServers?.length) {
      const seen = new Set<string>(["harness"]);
      for (const ext of req.externalMcpServers) {
        const name = typeof ext?.name === "string" ? ext.name.trim() : "";
        const normalized = name.toLowerCase();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        if (ext.enabled === false || typeof ext.command !== "string" || !ext.command.trim()) continue;
        const mountName = normalized === "octofs" ? "octofs" : name;
        externalMcpEntries.push({
          name: mountName,
          command: ext.command.trim(),
          args: ext.args ?? [],
          env: Object.entries(ext.env ?? {}).map(([envName, val]) => ({ name: envName, value: interpolateEnv(val) })),
        });
      }
    }
    const externalMcpNames = new Set(externalMcpEntries.map((s) => s.name));
    const codexHarnessCalls = new Set<string>();
    const codexExternalCalls = new Set<string>();
    const quotaTimeoutMs = Math.max(0, req.quotaRetryTimeoutMs ?? DEFAULT_QUOTA_RETRY_TIMEOUT_MS);
    const startupTimeoutMs = Math.max(0, req.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
    const idleTimeoutMs = Math.max(0, req.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

    let accumulatedText = "";
    let turnText = "";
    let textSinceLastTool = "";
    let needsParagraphBreak = false;
    let lastUsage: RunnerUsage | undefined;
    // A cost is delivered once its turn ends so a turn that several models contributed to is not credited to one.
    let pendingCost: RunnerCost | undefined;
    const flushCost = (turnModelCount = 0) => {
      if (!pendingCost || !lastUsage) return;
      lastUsage = {
        ...lastUsage,
        cost: turnModelCount > 1 ? { ...pendingCost, model: undefined } : pendingCost,
      };
      pendingCost = undefined;
      req.callbacks.onUsage?.(lastUsage);
    };
    // Tier 3 task agents compact in place rather than using anchored multi-generation rollover.
    const rolloverThreshold = req.tier === 3 ? undefined : req.rolloverThreshold;
    let rolloverTriggered = false;
    let rolloverWarningSent = false;
    let pendingRolloverWarning: string | null = null;
    let promptInFlight = false;
    let wrapUpAttempted = false;
    let wrapUpTimedOut = false;
    let wrapUpTimer: ReturnType<typeof setTimeout> | null = null;
    let turnsUsed = 0;
    let completedToolInWave = false;
    const inFlightToolCalls = new Set<string>();
    let anonymousInFlightToolCalls = 0;
    const hasInFlightToolCall = () => inFlightToolCalls.size > 0 || anonymousInFlightToolCalls > 0;
    let harnessCancelIssuedForTurn = false;
    let steerAckTimedOut = false;
    let brokenSessionCode: RunnerErrorCode | null = null;
    let brokenSessionDetail = "";
    const seenToolCallIds = new Set<string>();
    let sessionId: string | undefined;
    let steeringSupported = false;
    let activeConnection: ClientConnection | null = null;
    const toolTitlesById = new Map<string, string>();

    type SteerHandoffState = {
      turnPromise: Promise<Record<string, unknown>>;
      priorTurnSettled: boolean;
      abortedBeforeSend: boolean;
      replacementSent: boolean;
      ackSettled: boolean;
      ackLive: boolean;
      message: string;
      userEchoText: string;
      settleAck: (live: boolean) => void;
    };
    const steerHandoff: {
      pending: SteerHandoffState | null;
      ack: SteerHandoffState | null;
      cancelIssuedForTurn: boolean;
    } = {
      pending: null,
      ack: null,
      cancelIssuedForTurn: false,
    };
    const extractUpdateText = (content: unknown): string => {
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((b) =>
            b && typeof b === "object" && (b as { type?: unknown }).type === "text" && typeof (b as { text?: unknown }).text === "string"
              ? (b as { text: string }).text
              : "",
          )
          .join("");
      }
      if (content && typeof content === "object") {
        const c = content as { type?: unknown; text?: unknown };
        if (c.type === "text" && typeof c.text === "string") return c.text;
      }
      return "";
    };

    // Inactivity watchdog + bounded cancellation grace timer for active `session/prompt` calls
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let resolveActivePromptOnGrace: ((val: Record<string, unknown>) => void) | null = null;
    let rejectActivePromptOnIdle: ((err: Error) => void) | null = null;
    const clearIdleWatchdog = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (cancelGraceTimer) {
        clearTimeout(cancelGraceTimer);
        cancelGraceTimer = null;
      }
      if (childExitFlushTimer) {
        clearTimeout(childExitFlushTimer);
        childExitFlushTimer = null;
      }
      resolveActivePromptOnGrace = null;
      rejectActivePromptOnIdle = null;
      rejectActivePromptOnChildExit = null;
    };

    // Child exit/close + PID liveness detection: a dead ACP child fails the active turn promptly instead of
    // waiting out the idle watchdog (which an in-flight tool call stretches to 30 minutes).
    let rejectActivePromptOnChildExit: ((err: Error) => void) | null = null;
    let childExitFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let childGoneError: Error | null = null;
    // Recorded even after the prompt settled, so a transport EOF that wins the race can still report the exit status.
    let childExitInfo: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    const childExitMessage = (code: number | null, signal: NodeJS.Signals | null) =>
      `ACP agent process exited during an active turn (code=${code ?? "null"}, signal=${signal ?? "null"})`;
    const onChildGone = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!childExitInfo && (code !== null || signal !== null)) childExitInfo = { code, signal };
      steerHandoff.ack?.settleAck(false);
      // Abort, rollover, idle timeout, and cancel grace terminate the child on purpose.
      if (req.signal.aborted || rolloverTriggered || idleTimedOut || cancelGraceTimer) return;
      if (!rejectActivePromptOnChildExit) return;
      const rejectNow = () => {
        const cb = rejectActivePromptOnChildExit;
        if (!cb || req.signal.aborted || rolloverTriggered || idleTimedOut || cancelGraceTimer) return;
        childGoneError = new Error(childExitMessage(code ?? child?.exitCode ?? null, signal ?? child?.signalCode ?? null));
        clearIdleWatchdog();
        terminateChild(child);
        cb(childGoneError);
      };
      // Exit and close only mean the process and its OS pipes are gone, not that the stream adapter and SDK have
      // delivered every buffered message. Give a final JSON-RPC response (success or error) already on stdout a bounded
      // moment to settle the prompt; settling clears this timer. Keep an armed timer instead of resetting it.
      if (childExitFlushTimer) return;
      childExitFlushTimer = setTimeout(() => {
        childExitFlushTimer = null;
        rejectNow();
      }, 250);
      childExitFlushTimer.unref?.();
    };
    const onChildExit = (code: number | null, signal: NodeJS.Signals | null) => onChildGone(code, signal);
    let livenessTimer: ReturnType<typeof setInterval> | null = null;
    if (child) {
      child.once("exit", onChildExit);
      child.once("close", onChildExit);
      livenessTimer = setInterval(() => {
        if (child.exitCode !== null || child.signalCode !== null) {
          onChildGone(child.exitCode, child.signalCode);
        } else if (typeof child.pid === "number") {
          try {
            process.kill(child.pid, 0);
          } catch (err) {
            // EPERM means the PID exists but belongs to someone else: treat as alive.
            if ((err as NodeJS.ErrnoException).code === "ESRCH") onChildGone(child.exitCode, child.signalCode);
          }
        }
      }, 5_000);
      livenessTimer.unref?.();
    }
    const armCancelGraceTimer = (stopReason: string) => {
      if (cancelGraceTimer || !resolveActivePromptOnGrace) return;
      const graceMs = idleTimeoutMs > 0 ? Math.min(5_000, Math.max(100, idleTimeoutMs * 2)) : 5_000;
      cancelGraceTimer = setTimeout(() => {
        cancelGraceTimer = null;
        const cb = resolveActivePromptOnGrace;
        clearIdleWatchdog();
        terminateChild(child);
        cb?.({ stopReason });
      }, graceMs);
      cancelGraceTimer.unref?.();
    };
    const resetIdleWatchdog = () => {
      if (!rejectActivePromptOnIdle || idleTimeoutMs <= 0 || idleTimedOut) return;
      if (idleTimer) clearTimeout(idleTimer);
      // When an acknowledged tool call (e.g. `wait_children`, `wait_timer`, `submit_for_merge`) is in flight,
      // give it a generous ceiling instead of tripping the short model-inactivity timer.
      const effectiveMs = hasInFlightToolCall() ? Math.max(idleTimeoutMs, 1_800_000) : idleTimeoutMs;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (quotaWatchdogTriggered || rolloverTriggered || req.signal.aborted) return;
        idleTimedOut = true;
        steerHandoff.ack?.settleAck(false);
        const cb = rejectActivePromptOnIdle;
        clearIdleWatchdog();
        if (sessionId && activeConnection) {
          void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
        }
        terminateChild(child);
        cb?.(new Error(`ACP session timed out after ${effectiveMs}ms of inactivity`));
      }, effectiveMs);
      idleTimer.unref?.();
    };

    const canStartSteerHandoff = (conn: ClientConnection | null = activeConnection) =>
      Boolean(sessionId) &&
      Boolean(conn) &&
      activeConnection === conn &&
      !req.signal.aborted &&
      !rolloverTriggered &&
      !quotaWatchdogTriggered &&
      !quotaRejected &&
      !idleTimedOut &&
      !wrapUpAttempted &&
      !wrapUpTimedOut &&
      !brokenSessionCode &&
      !childGoneError &&
      !(child && (child.exitCode !== null || child.signalCode !== null)) &&
      !req.isTaskSettled?.();

    const startAmpCancelSteer = async (message: string, opts: { waitForAck: boolean }): Promise<boolean> => {
      const conn = activeConnection;
      if (
        !sessionId ||
        !conn ||
        !ampCancelSteerEnabled ||
        !promptInFlight ||
        hasInFlightToolCall() ||
        steerHandoff.pending !== null ||
        steerHandoff.ack !== null ||
        !canStartSteerHandoff(conn)
      ) {
        return false;
      }

      let resolveTurn!: (res: Record<string, unknown>) => void;
      let rejectTurn!: (err: unknown) => void;
      const turnPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
        resolveTurn = resolve;
        rejectTurn = reject;
      });
      turnPromise.catch(() => {});

      let resolveAck!: (live: boolean) => void;
      const ackPromise = new Promise<boolean>((resolve) => {
        resolveAck = resolve;
      });
      let ackTimer: ReturnType<typeof setTimeout> | null = null;
      const onAckAbort = () => state.settleAck(false);

      const state: SteerHandoffState = {
        turnPromise,
        priorTurnSettled: false,
        abortedBeforeSend: false,
        replacementSent: false,
        ackSettled: false,
        ackLive: false,
        message,
        userEchoText: "",
        settleAck: (live: boolean) => {
          if (state.ackSettled) return;
          state.ackSettled = true;
          state.ackLive = live;
          if (ackTimer) {
            clearTimeout(ackTimer);
            ackTimer = null;
          }
          req.signal.removeEventListener("abort", onAckAbort);
          if (steerHandoff.ack === state) steerHandoff.ack = null;
          resolveAck(live);
        },
      };

      steerHandoff.pending = state;
      if (opts.waitForAck) {
        steerHandoff.ack = state;
      }
      steerHandoff.cancelIssuedForTurn = true;
      harnessCancelIssuedForTurn = true;
      req.signal.addEventListener("abort", onAckAbort, { once: true });

      try {
        await conn.agent.notify("session/cancel", { sessionId });
      } catch {
        state.abortedBeforeSend = true;
        state.settleAck(false);
        resolveTurn({ stopReason: "cancelled" });
        if (steerHandoff.pending === state) steerHandoff.pending = null;
        return false;
      }

      // Re-check abort, rollover, quota, child exit, and task settlement after awaiting cancel.
      if (!canStartSteerHandoff(conn)) {
        state.abortedBeforeSend = true;
        state.settleAck(false);
        resolveTurn({ stopReason: "cancelled" });
        if (steerHandoff.pending === state) steerHandoff.pending = null;
        return false;
      }

      if (opts.waitForAck) {
        const ackTimeoutMs = Math.max(0, this.opts?.steerAckTimeoutMs ?? DEFAULT_STEER_ACK_TIMEOUT_MS);
        if (ackTimeoutMs > 0) {
          ackTimer = setTimeout(() => {
            ackTimer = null;
            if (state.ackSettled) return;
            // Cancel the unacknowledged replacement so it cannot deliver later alongside harness fallback.
            if (sessionId && activeConnection === conn) {
              steerAckTimedOut = true;
              harnessCancelIssuedForTurn = true;
              void conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
              armCancelGraceTimer("cancelled");
            }
            state.settleAck(false);
          }, ackTimeoutMs);
          ackTimer.unref?.();
        }
      }

      state.replacementSent = true;
      let nextPrompt: Promise<Record<string, unknown>>;
      try {
        nextPrompt = conn.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: message }],
        } as never) as unknown as Promise<Record<string, unknown>>;
      } catch (err) {
        state.settleAck(false);
        rejectTurn(err);
        return false;
      }

      nextPrompt.then(
        (res) => {
          const stop = typeof res?.stopReason === "string" ? res.stopReason : "";
          const resMeta = (res?._meta ?? {}) as Record<string, unknown>;
          const hasAirFailure = Boolean(
            ((resMeta.jetbrains as Record<string, unknown> | undefined)?.air as Record<string, unknown> | undefined)
              ?.sessionFailure,
          );
          if (!state.ackSettled) {
            const accepted =
              ACCEPTED_STEER_STOP_REASONS.has(stop) &&
              !hasAirFailure &&
              !req.signal.aborted &&
              !rolloverTriggered &&
              !quotaWatchdogTriggered &&
              !quotaRejected &&
              !idleTimedOut &&
              !childGoneError &&
              !req.isTaskSettled?.();
            state.settleAck(accepted);
          }
          resolveTurn(res);
        },
        (err) => {
          state.settleAck(false);
          rejectTurn(err);
        },
      );

      if (!opts.waitForAck) {
        return true;
      }
      return await ackPromise;
    };

    // Deliver a soft rollover warning through live _session/steering, or on Amp via single-owner cancel-then-prompt
    // (falling back to a local next-turn continuation when cancel-then-prompt is disabled or busy). Never probes _amp/session/steer.
    const sendSteeringText = (text: string) => {
      if (!sessionId || !activeConnection) return;
      if (steeringSupported) {
        void activeConnection.agent
          .request("_session/steering", { sessionId, prompt: [{ type: "text", text }] })
          .catch(() => {});
      } else if (isAmpProfile) {
        if (
          ampCancelSteerEnabled &&
          promptInFlight &&
          !hasInFlightToolCall() &&
          steerHandoff.pending === null &&
          steerHandoff.ack === null &&
          canStartSteerHandoff()
        ) {
          void startAmpCancelSteer(text, { waitForAck: false }).then((started) => {
            if (!started && !rolloverTriggered && !req.signal.aborted && !req.isTaskSettled?.()) {
              pendingRolloverWarning = text;
            }
          });
        } else {
          pendingRolloverWarning = text;
        }
      }
    };
    const advanceTurnWaveIfNeeded = () => {
      if (!completedToolInWave || hasInFlightToolCall()) return;
      completedToolInWave = false;
      turnsUsed += 1;
      req.callbacks.onTurn?.(turnsUsed);
    };

    // Per-turn & cumulative tool-failure / read-only-denial tracking (for continuation recovery + robust circuit breaker)
    let turnFailedTools: Array<{ title: string; detail?: string }> = [];
    let turnDeniedTools: string[] = [];
    let turnSucceededTools = 0;
    let turnToolCalls = 0;
    let turnHarnessToolCallObserved = false;
    const allToolFailures: string[] = [];
    let authOkSent = false;
    let authFailed = false;
    let sessionStartMs = 0;
    let firstPromptStartMs = 0;
    const toolsGraceMs = resolveToolsGraceMs(req.harnessToolsGraceMs);
    const toolsCeilingMs = resolveToolsCeilingMs(toolsGraceMs);
    const toolsCheckEnabled = hasHarnessBridge && Boolean(req.harnessToolsListedSince) && toolsGraceMs > 0;
    let toolsCheckPassed = !toolsCheckEnabled;
    let toolsNotYetListed = false;
    let harnessToolCallObserved = false;
    const harnessToolCallIds = new Set<string>();
    let toolsMissingError: AcpProfileError | null = null;
    let toolsGraceTimer: ReturnType<typeof setTimeout> | null = null;
    let toolsCeilingTimer: ReturnType<typeof setTimeout> | null = null;
    let toolsPollTimer: ReturnType<typeof setInterval> | null = null;
    let toolsCancelGraceTimer: ReturnType<typeof setTimeout> | null = null;

    const clearToolsWatchers = () => {
      if (toolsGraceTimer) {
        clearTimeout(toolsGraceTimer);
        toolsGraceTimer = null;
      }
      if (toolsCeilingTimer) {
        clearTimeout(toolsCeilingTimer);
        toolsCeilingTimer = null;
      }
      if (toolsPollTimer) {
        clearInterval(toolsPollTimer);
        toolsPollTimer = null;
      }
      if (toolsCancelGraceTimer) {
        clearTimeout(toolsCancelGraceTimer);
        toolsCancelGraceTimer = null;
      }
    };
    const makeToolsMissingError = (reason: "timeout" | "turn_ended"): AcpProfileError =>
      new AcpProfileError(
        "tools_missing",
        this.profile.id,
        reason === "timeout"
          ? `ACP profile ${this.profile.id} started a session without the harness MCP tools: ` +
            `the harness bridge was never asked for its tool list within ${toolsCeilingMs} ms of the first prompt, ` +
            `so return_task and spawn_task are unavailable. Check that the profile's CLI supports and loads MCP servers; ` +
            `respawn or retry on another profile.`
          : `ACP profile ${this.profile.id} completed its ${wrapUpAttempted ? "wrap-up turn" : "first turn"} without the harness MCP tools: ` +
            `the harness bridge was never asked for its tool list and no harness tool call was observed, ` +
            `so return_task and spawn_task are unavailable. Check that the profile's CLI supports and loads MCP servers; ` +
            `respawn or retry on another profile.`,
      );
    const checkHarnessToolsReady = (): boolean => {
      if (toolsCheckPassed) return true;
      if (harnessToolCallObserved || (sessionStartMs > 0 && req.harnessToolsListedSince?.(sessionStartMs))) {
        toolsCheckPassed = true;
        toolsNotYetListed = false;
        toolsMissingError = null;
        clearToolsWatchers();
        return true;
      }
      return false;
    };
    const markHarnessToolObserved = () => {
      harnessToolCallObserved = true;
      turnHarnessToolCallObserved = true;
      toolsNotYetListed = false;
      toolsMissingError = null;
      if (!toolsCheckPassed) {
        toolsCheckPassed = true;
        clearToolsWatchers();
      }
    };
    const isHarnessToolUpdate = (
      update: Record<string, unknown>,
      resolvedTitle: string,
      callId: string | undefined,
    ): boolean => {
      if (callId && (harnessToolCallIds.has(callId) || codexHarnessCalls.has(callId))) {
        return true;
      }
      const meta = update._meta as
        | {
            claudeCode?: { toolName?: string; mcpServer?: { name?: string } };
            "gemini-cli"?: { mcp?: { server_name?: string; tool_name?: string } };
          }
        | undefined;
      const claudeMeta = meta?.claudeCode;
      if (
        claudeMeta &&
        (claudeMeta.mcpServer?.name === "harness" ||
          (typeof claudeMeta.toolName === "string" && claudeToolNames.has(claudeMeta.toolName)))
      ) {
        return true;
      }
      const geminiMcp = meta?.["gemini-cli"]?.mcp;
      if (geminiMcp?.server_name === "harness" && geminiMcp.tool_name && harnessToolNames.has(geminiMcp.tool_name)) {
        return true;
      }
      const rawInput = update.rawInput as { server?: unknown; tool?: unknown } | undefined;
      if (
        rawInput &&
        rawInput.server === "harness" &&
        typeof rawInput.tool === "string" &&
        harnessToolNames.has(rawInput.tool)
      ) {
        return true;
      }
      const candidates = [
        resolvedTitle,
        typeof update.title === "string" ? update.title : "",
        typeof update.name === "string" ? update.name : "",
      ];
      for (const raw of candidates) {
        const token = raw.trim().split(/\s+/)[0] ?? "";
        if (!token) continue;
        const prefixed = HARNESS_PREFIXED_TOOL_RE.exec(token);
        if (prefixed?.[1] && harnessToolNames.has(prefixed[1].toLowerCase())) {
          return true;
        }
        const lower = token.toLowerCase();
        if (harnessToolNames.has(lower) && !AMBIGUOUS_NATIVE_TOOL_NAMES.has(lower)) {
          return true;
        }
      }
      return false;
    };
    const shouldStopToolsWatch = (): boolean =>
      req.signal.aborted ||
      rolloverTriggered ||
      quotaWatchdogTriggered ||
      idleTimedOut ||
      Boolean(childGoneError) ||
      authFailed;
    const startToolsGraceWatch = () => {
      if (!toolsCheckEnabled || toolsCheckPassed || firstPromptStartMs > 0) return;
      firstPromptStartMs = Date.now();
      if (checkHarnessToolsReady()) return;

      toolsPollTimer = setInterval(() => {
        if (shouldStopToolsWatch()) {
          clearToolsWatchers();
          return;
        }
        checkHarnessToolsReady();
      }, TOOLS_POLL_INTERVAL_MS);
      toolsPollTimer.unref?.();

      toolsGraceTimer = setTimeout(() => {
        toolsGraceTimer = null;
        if (shouldStopToolsWatch()) {
          clearToolsWatchers();
          return;
        }
        if (checkHarnessToolsReady()) return;
        toolsNotYetListed = true;
        if (toolsCeilingMs <= 0 && toolsPollTimer) {
          clearInterval(toolsPollTimer);
          toolsPollTimer = null;
        }
      }, toolsGraceMs);
      toolsGraceTimer.unref?.();

      if (toolsCeilingMs > 0) {
        toolsCeilingTimer = setTimeout(() => {
          toolsCeilingTimer = null;
          if (toolsPollTimer) {
            clearInterval(toolsPollTimer);
            toolsPollTimer = null;
          }
          if (shouldStopToolsWatch()) return;
          if (checkHarnessToolsReady()) return;

          toolsMissingError = makeToolsMissingError("timeout");
          steerHandoff.ack?.settleAck(false);
          if (sessionId && activeConnection) {
            void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
          }
          const cancelGraceMs = Math.min(1_000, Math.max(100, toolsCeilingMs));
          toolsCancelGraceTimer = setTimeout(() => {
            toolsCancelGraceTimer = null;
            const cb = resolveActivePromptOnGrace;
            clearIdleWatchdog();
            cb?.({ stopReason: "cancelled" });
            terminateChild(child);
          }, cancelGraceMs);
          toolsCancelGraceTimer.unref?.();
        }, toolsCeilingMs);
        toolsCeilingTimer.unref?.();
      }
    };
    const emitAuthOk = () => {
      if (authOkSent || authFailed) return;
      authOkSent = true;
      req.callbacks.onPassiveQuota?.({
        profileId: this.profile.id,
        model: null,
        raw: { authOk: true },
        observedAt: Date.now(),
      });
    };
    const failAuthRequired = (detailText: string): never => {
      authFailed = true;
      authOkSent = true;
      clearToolsWatchers();
      const detail = detailText.trim();
      const loginHint = acpProfileLoginHint(this.profile.id, {
        adapter: this.profile.adapter,
        isAmp: isAmpProfile,
      });
      req.callbacks.onPassiveQuota?.({
        profileId: this.profile.id,
        model: null,
        raw: { sessionFailure: "auth_required", detail: detail.slice(0, 300) },
        observedAt: Date.now(),
      });
      throw new AcpProfileError(
        "auth_required",
        this.profile.id,
        `ACP profile ${this.profile.id} is not authenticated (${detail.slice(0, 200)}). ` +
          `To re-authenticate ${this.profile.id}, ${loginHint} and retry, or choose another model. ` +
          `The harness skips this profile when it recommends or auto-routes models until a cooldown expires or a session succeeds.`,
      );
    };
    // Per-turn fail-fast auth classification: evaluate only the current turn's full assistant
    // reply and turn-local tool activity so a standalone auth diagnostic on turn 1 fails fast
    // without wrap-up, and a standalone diagnostic on a later turn (such as wrap-up) overrides
    // earlier authOk instead of being masked by prior turns' text or tool calls.
    const matchesAuthTextHeuristic = (sessionFailed = false): boolean => {
      if (turnSucceededTools !== 0 || turnHarnessToolCallObserved) return false;
      if (!sessionFailed && (turnFailedTools.length > 0 || turnDeniedTools.length > 0 || turnToolCalls > 0)) return false;
      return isStandaloneAcpAuthDiagnostic(turnText);
    };
    let lastIdenticalFailureKey = "";
    let identicalFailureStreak = 0;
    let identicalFailureBreakerTripped = false;

    // Soft subscription-pool quota retry watchdog state
    let quotaWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
    let quotaWatchdogTriggered = false;
    let quotaRetrying = false;
    let quotaRetryHits = 0;
    let quotaRejected = false;
    let textSinceQuotaRejection = "";
    let lastQuotaReason = "";
    let lastQuotaDetail = "";
    let lastQuotaResetAt: string | null = null;
    let lastQuotaHard = false;

    const disarmQuotaWatchdog = (recovered: boolean) => {
      if (quotaWatchdogTimer) {
        clearTimeout(quotaWatchdogTimer);
        quotaWatchdogTimer = null;
      }
      if (quotaRetrying && recovered && !quotaWatchdogTriggered) {
        quotaRetrying = false;
        req.callbacks.onQuotaRetryState?.({
          state: "recovered",
          retryCount: quotaRetryHits,
          timeoutMs: quotaTimeoutMs,
        });
      } else {
        quotaRetrying = false;
      }
    };

    const noteQuotaSignal = (info: { reason: string; detail?: string; resetAt?: string | null; isHardExhaustion?: boolean }) => {
      if (quotaWatchdogTriggered || rolloverTriggered || req.signal.aborted) return;
      quotaRetryHits += 1;
      if (info.reason) lastQuotaReason = info.reason;
      if (info.detail) lastQuotaDetail = info.detail;
      if (info.resetAt) lastQuotaResetAt = info.resetAt;
      if (info.isHardExhaustion) lastQuotaHard = true;

      if (!quotaRetrying) {
        quotaRetrying = true;
        req.callbacks.onQuotaRetryState?.({
          state: "retrying",
          retryCount: quotaRetryHits,
          timeoutMs: quotaTimeoutMs,
          reason: lastQuotaReason,
          resetAt: lastQuotaResetAt,
        });
      }

      // Arm once per stall episode (do NOT reset timer on repeated 429s so a tight retry loop cannot hang forever)
      if (!quotaWatchdogTimer && quotaTimeoutMs > 0) {
        quotaWatchdogTimer = setTimeout(() => {
          quotaWatchdogTimer = null;
          if (rolloverTriggered || req.signal.aborted) return;
          quotaWatchdogTriggered = true;
          steerHandoff.ack?.settleAck(false);
          if (sessionId && activeConnection) {
            void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
          }
          if (child) {
            setTimeout(() => {
              terminateChild(child);
            }, 350).unref?.();
          }
        }, quotaTimeoutMs);
        quotaWatchdogTimer.unref?.();
      }
    };

    let stderrBuf = "";
    let stderrLineBuf = "";
    let stderrPartialMatched = false;
    const inspectStderrText = (text: string): boolean => {
      const detected = detectQuotaErrorText(text);
      if (detected.isQuota) {
        noteQuotaSignal({
          reason: detected.summary,
          detail: detected.detail,
          resetAt: detected.resetAtIso ?? null,
          isHardExhaustion: detected.isHardExhaustion,
        });
        return true;
      }
      return false;
    };
    child?.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderrBuf = (stderrBuf + chunk).slice(-4096);
      stderrLineBuf += chunk;
      const lines = stderrLineBuf.split(/\r?\n/);
      stderrLineBuf = lines.pop() ?? "";
      if (lines.length > 0) {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]!;
          if (i === 0 && stderrPartialMatched) {
            stderrPartialMatched = false;
            if (!quotaWatchdogTriggered && !rolloverTriggered && !req.signal.aborted) {
              const fullDetected = detectQuotaErrorText(line);
              if (fullDetected.isQuota) {
                if (fullDetected.summary) lastQuotaReason = fullDetected.summary;
                if (fullDetected.detail) lastQuotaDetail = fullDetected.detail;
                if (fullDetected.resetAtIso) lastQuotaResetAt = fullDetected.resetAtIso;
                if (fullDetected.isHardExhaustion) lastQuotaHard = true;
              }
            }
            continue;
          }
          if (line.trim()) inspectStderrText(line);
        }
        stderrPartialMatched = false;
      }
      if (!stderrPartialMatched && stderrLineBuf.trim()) {
        stderrPartialMatched = inspectStderrText(stderrLineBuf);
      }
      if (stderrLineBuf.length > 4096) {
        stderrLineBuf = stderrLineBuf.slice(-512);
        stderrPartialMatched = false;
      }
    });
    child?.stderr?.on("end", () => {
      if (!stderrPartialMatched && stderrLineBuf.trim()) {
        inspectStderrText(stderrLineBuf);
      }
      stderrLineBuf = "";
      stderrPartialMatched = false;
    });

    const app = client()
      .onNotification("session/update", ({ params }) => {
        const update = (params as unknown as { update?: Record<string, unknown> }).update;
        if (params.sessionId !== sessionId || !update || typeof update !== "object") return;
        resetIdleWatchdog();
        const kind = String(update.sessionUpdate ?? "");
        const canAckReplacement = () =>
          Boolean(
            steerHandoff.ack &&
              steerHandoff.ack.replacementSent &&
              !steerHandoff.ack.ackSettled &&
              !req.signal.aborted &&
              !rolloverTriggered &&
              !quotaWatchdogTriggered &&
              !quotaRejected &&
              !idleTimedOut &&
              !req.isTaskSettled?.(),
          );

        if (kind === "user_message_chunk" || kind === "user_message") {
          if (canAckReplacement() && steerHandoff.ack) {
            const echoedChunk = extractUpdateText(update.content);
            if (echoedChunk) {
              steerHandoff.ack.userEchoText += echoedChunk;
              const expected = steerHandoff.ack.message.trim();
              const echoed = steerHandoff.ack.userEchoText.trim();
              if (expected.length > 0 && (echoed === expected || echoed.includes(expected))) {
                steerHandoff.ack.settleAck(true);
              }
            }
          }
        } else if (kind === "agent_message_chunk") {
          advanceTurnWaveIfNeeded();
          const content = update.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && typeof content.text === "string") {
            if (quotaRejected) {
              textSinceQuotaRejection += content.text;
            }
            if (content.text.trim().length > 0) {
              // Forward progress! Subscription-pool rotation succeeded — disarm any pending 429 watchdog
              // unless the assistant text itself is a rate-limit / quota exhaustion explanation.
              const quotaCheckText = quotaRejected ? textSinceQuotaRejection : content.text;
              if (!detectQuotaErrorText(quotaCheckText).isQuota) {
                disarmQuotaWatchdog(true);
              }
            }
            let chunk = content.text;
            if (needsParagraphBreak && accumulatedText.length > 0 && !accumulatedText.endsWith("\n") && !chunk.startsWith("\n")) {
              chunk = "\n\n" + chunk;
            }
            needsParagraphBreak = false;
            accumulatedText += chunk;
            turnText += content.text;
            textSinceLastTool += content.text;
            req.callbacks.onTextDelta?.(chunk);
          }
        } else if (kind === "agent_thought_chunk") {
          advanceTurnWaveIfNeeded();
          const content = update.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && typeof content.text === "string") {
            if (canAckReplacement() && steerHandoff.ack?.priorTurnSettled && content.text.trim().length > 0) {
              steerHandoff.ack.settleAck(true);
            }
            req.callbacks.onThoughtDelta?.(content.text);
          }
        } else if (kind === "usage_update") {
          const used = Number(update.used ?? 0);
          const rawSize = Number(update.size ?? 0);
          // Some adapters (e.g. amp-acp) report a default 200k size even for 1M-context models;
          // prefer the larger of adapter-reported size and catalog contextWindow when available.
          const size = Math.max(rawSize > 0 ? rawSize : 0, req.contextWindow ?? 0);
          const costObj = update.cost as { amount?: unknown; currency?: unknown } | null | undefined;
          const updateMeta = (update._meta ?? {}) as Record<string, unknown>;
          if (typeof costObj?.amount === "number" && typeof costObj.currency === "string") {
            pendingCost = {
              amount: costObj.amount,
              currency: costObj.currency,
              basis: "session_cumulative",
              model: typeof updateMeta["_claude/model"] === "string" ? updateMeta["_claude/model"] : undefined,
            };
          }
          lastUsage = { used, size, cost: lastUsage?.cost };
          req.callbacks.onUsage?.(lastUsage);

          // Harvest live passive subscription quota signals (`_claude/rateLimit`, generic `rateLimit`/`rateLimits`)
          const rlPayload = (updateMeta["_claude/rateLimit"] ?? updateMeta.rateLimit) as Record<string, unknown> | undefined;
          if (rlPayload && typeof rlPayload === "object") {
            req.callbacks.onPassiveQuota?.({
              profileId: this.profile.id,
              model: typeof updateMeta["_claude/model"] === "string" ? updateMeta["_claude/model"] : req.model,
              raw: rlPayload,
              observedAt: Date.now(),
            });
            if (rlPayload.status === "rejected" || rlPayload.overageStatus === "rejected") {
              quotaRejected = true;
              textSinceQuotaRejection = "";
              const resetIso =
                typeof rlPayload.resetsAt === "number" ? new Date(rlPayload.resetsAt * 1000).toISOString() : null;
              noteQuotaSignal({
                reason: `Rate limit rejected (${String(rlPayload.rateLimitType ?? "quota")})`,
                resetAt: resetIso,
                isHardExhaustion: true,
              });
            } else if (rlPayload.status !== undefined || rlPayload.overageStatus !== undefined) {
              quotaRejected = false;
              textSinceQuotaRejection = "";
            }
          }
          const codexRl = (updateMeta["_codex/rateLimits"] ?? updateMeta.rateLimits) as Record<string, unknown> | undefined;
          if (codexRl && typeof codexRl === "object") {
            req.callbacks.onPassiveQuota?.({
              profileId: this.profile.id,
              model: req.model,
              raw: { codexRateLimits: codexRl },
              observedAt: Date.now(),
            });
          }

          const ratio = size > 0 ? used / size : 0;
          const softWarnThreshold = rolloverThreshold ? Math.max(0.5, rolloverThreshold - 0.12) : undefined;
          if (
            !rolloverWarningSent &&
            !rolloverTriggered &&
            softWarnThreshold &&
            rolloverThreshold &&
            ratio >= softWarnThreshold &&
            ratio < rolloverThreshold &&
            sessionId &&
            activeConnection &&
            (steeringSupported || isAmpProfile)
          ) {
            rolloverWarningSent = true;
            const pct = Math.round(ratio * 100);
            const limitPct = Math.round(rolloverThreshold * 100);
            sendSteeringText(contextWarningText(req.tier, pct, limitPct));
          }

          if (
            !rolloverTriggered &&
            rolloverThreshold &&
            size > 0 &&
            ratio >= rolloverThreshold &&
            sessionId &&
            activeConnection
          ) {
            rolloverTriggered = true;
            steerHandoff.ack?.settleAck(false);
            void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
            armCancelGraceTimer("cancelled");
          }
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          turnToolCalls += 1;
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          textSinceLastTool = "";
          const callId = update.toolCallId ? String(update.toolCallId) : update.id ? String(update.id) : undefined;
          const status = String(update.status ?? "in_progress");
          const isNewToolCall = kind === "tool_call" && (!callId || !seenToolCallIds.has(callId));
          if (callId) seenToolCallIds.add(callId);
          if (
            isNewToolCall &&
            status !== "cancelled" &&
            status !== "failed" &&
            canAckReplacement() &&
            steerHandoff.ack?.priorTurnSettled
          ) {
            steerHandoff.ack.settleAck(true);
          }
          if (kind === "tool_call") {
            advanceTurnWaveIfNeeded();
            if (status !== "completed" && status !== "failed" && status !== "cancelled") {
              if (callId) inFlightToolCalls.add(callId);
              else anonymousInFlightToolCalls += 1;
            }
          } else if (status !== "completed" && status !== "failed" && status !== "cancelled") {
            if (callId) inFlightToolCalls.add(callId);
          }
          const rawTitle = update.title ? String(update.title) : update.name ? String(update.name) : undefined;
          if (callId && rawTitle) {
            toolTitlesById.set(callId, rawTitle);
          }
          const resolvedTitle = rawTitle ?? (callId ? toolTitlesById.get(callId) : undefined) ?? "tool";
          if (this.profile.adapter === "codex" && callId && kind === "tool_call") {
            const meta = update._meta as { is_mcp_tool_call?: boolean } | undefined;
            const input = update.rawInput as { server?: string; tool?: string } | undefined;
            codexHarnessCalls.delete(callId);
            codexExternalCalls.delete(callId);
            if (update.kind === "execute" && meta?.is_mcp_tool_call === true && input?.server && input.tool) {
              if (input.server === "harness" && harnessToolNames.has(input.tool)) {
                codexHarnessCalls.add(callId);
              } else if (externalMcpNames.has(input.server) && (canWrite || isReadOnlyExternalMcpTool(input.server, input.tool))) {
                codexExternalCalls.add(callId);
              }
            }
          }
          const isHarnessCall = isHarnessToolUpdate(update, resolvedTitle, callId);
          if (callId && isHarnessCall) {
            harnessToolCallIds.add(callId);
          }
          if (
            this.profile.adapter === "codex" &&
            callId &&
            (update.status === "completed" || update.status === "failed" || update.status === "cancelled")
          ) {
            codexHarnessCalls.delete(callId);
            codexExternalCalls.delete(callId);
          }
          const wasInFlight = Boolean(callId && inFlightToolCalls.has(callId));
          const executorLostSnippet = detectExecutorLostToolUpdate(update, status);
          if (executorLostSnippet && !brokenSessionCode) {
            brokenSessionCode = ACP_EXECUTOR_LOST_ERROR_CODE;
            brokenSessionDetail = executorLostSnippet;
            steerHandoff.ack?.settleAck(false);
            steerHandoff.pending?.settleAck(false);
            if (sessionId && activeConnection && !req.signal.aborted && !rolloverTriggered) {
              harnessCancelIssuedForTurn = true;
              void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
              armCancelGraceTimer("cancelled");
            }
          }
          if (status === "completed") {
            if (callId) {
              inFlightToolCalls.delete(callId);
              harnessToolCallIds.delete(callId);
            } else {
              anonymousInFlightToolCalls = Math.max(0, anonymousInFlightToolCalls - 1);
            }
            resetIdleWatchdog();
            completedToolInWave = true;
            if (!executorLostSnippet) {
              quotaRejected = false;
              textSinceQuotaRejection = "";
              disarmQuotaWatchdog(true);
              turnSucceededTools += 1;
              if (kind === "tool_call" || wasInFlight) {
                emitAuthOk();
              }
              if (isHarnessCall) {
                markHarnessToolObserved();
              }
              // Any successful tool call resets the identical-failure streak so exploratory debugging never trips the breaker
              identicalFailureStreak = 0;
              lastIdenticalFailureKey = "";
            } else {
              allToolFailures.push(`${resolvedTitle}: ${executorLostSnippet}`);
            }
          } else if (status === "failed") {
            if (callId) {
              inFlightToolCalls.delete(callId);
              harnessToolCallIds.delete(callId);
            } else {
              anonymousInFlightToolCalls = Math.max(0, anonymousInFlightToolCalls - 1);
            }
            resetIdleWatchdog();
            completedToolInWave = true;
            const detail = extractToolErrorSnippet(update);
            turnFailedTools.push({ title: resolvedTitle, detail });
            allToolFailures.push(detail ? `${resolvedTitle}: ${detail}` : resolvedTitle);
            const failKey = `${resolvedTitle.toLowerCase()}::${(detail ?? "").toLowerCase().slice(0, 120)}`;
            if (failKey === lastIdenticalFailureKey) {
              identicalFailureStreak += 1;
            } else {
              lastIdenticalFailureKey = failKey;
              identicalFailureStreak = 1;
            }
            if (!brokenSessionCode && identicalFailureStreak >= IDENTICAL_FAILURE_BREAKER && !identicalFailureBreakerTripped && sessionId && activeConnection) {
              identicalFailureBreakerTripped = true;
              harnessCancelIssuedForTurn = true;
              void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
            }
          } else if (status === "cancelled") {
            if (callId) {
              inFlightToolCalls.delete(callId);
              harnessToolCallIds.delete(callId);
            } else {
              anonymousInFlightToolCalls = Math.max(0, anonymousInFlightToolCalls - 1);
            }
          }
          const eventPaths = Array.isArray(update.locations)
            ? update.locations
                .map((loc) => (loc && typeof loc === "object" ? (loc as { path?: unknown }).path : undefined))
                .filter((locPath): locPath is string => typeof locPath === "string" && locPath.trim().length > 0)
            : [];
          req.callbacks.onToolEvent?.({
            id: callId,
            name: resolvedTitle,
            status,
            kind: update.kind ? String(update.kind) : undefined,
            title: resolvedTitle,
            args: toolEventPreview(update.rawInput),
            ...(eventPaths.length > 0 ? { paths: eventPaths } : {}),
            ...(status === "failed" ? { error: toolEventPreview(update.rawOutput) } : { result: toolEventPreview(update.rawOutput) }),
          });
          for (const art of extractArtifactsFromToolUpdate(update)) {
            req.callbacks.onArtifact?.(art);
          }
        }
      })
      .onRequest("session/request_permission", async ({ params }) => {
        if (sessionId && params.sessionId === sessionId) resetIdleWatchdog();
        const p = params as unknown as {
          _meta?: { is_mcp_tool_approval?: boolean };
          toolCall?: {
            toolCallId?: string; title?: string; name?: string; kind?: string;
            rawInput?: Record<string, unknown>;
            locations?: Array<{ path: string }>;
            _meta?: {
              claudeCode?: { toolName?: string; mcpServer?: { name?: string; source?: string } };
              "gemini-cli"?: { mcp?: { server_name?: string; tool_name?: string } };
            };
          };
          options?: Array<{ optionId: string; kind: string }>;
        };
        const callId = p.toolCall?.toolCallId ? String(p.toolCall.toolCallId) : undefined;
        const title = String(p.toolCall?.title ?? p.toolCall?.name ?? (callId ? toolTitlesById.get(callId) : "") ?? "");
        const toolKind = p.toolCall?.kind;
        const rawInput = (p.toolCall?.rawInput && typeof p.toolCall.rawInput === "object" ? p.toolCall.rawInput : undefined) as
          | Record<string, unknown>
          | undefined;
        const options = p.options ?? [];

        const allowOpt =
          options.find((o) => o.kind === "allow_once") ??
          options.find((o) => o.kind === "allow_always");
        const denyOpt = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");

        const extractExternalMcp = (
          rawName: string,
        ): { server: string; tool: string } | null => {
          const firstToken = rawName.trim().split(/\s+/)[0] ?? "";
          if (!firstToken) return null;
          for (const srv of externalMcpNames) {
            const escaped = srv.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(`^(?:mcp(?:__|_|\\.|/|:))?${escaped}(?:__|_|\\.|/|:)(.+)$`);
            const m = firstToken.match(re);
            if (m?.[1]) return { server: srv, tool: m[1] };
          }
          return null;
        };

        // Normalize MCP tool names emitted by Gemini / Antigravity / Codex / generic ACP adapters across ALL separators:
        // e.g. `mcp__harness__code_exec`, `mcp_harness_goal_list`, `mcp.harness.tool_search`, `harness:code_exec`, `harness/code_exec`, `harness.code_exec`
        const rawCandidateName = p.toolCall?.name ?? p.toolCall?.title ?? title;
        const normalizedHarnessTool = rawCandidateName
          .trim()
          .split(/\s+/)[0]
          ?.replace(/^mcp(?:__|_|\/|\.|:)harness(?:__|_|\/|\.|:)/, "")
          .replace(/^harness(?:__|_|\/|\.|:)/, "") ?? "";
        const nonFileToolKind =
          toolKind !== "read" && toolKind !== "edit" && toolKind !== "delete" && toolKind !== "move";
        const noFileLocations = !p.toolCall?.locations?.length;
        const matchesNormalizedHarness =
          nonFileToolKind &&
          noFileLocations &&
          normalizedHarnessTool.length > 0 &&
          harnessToolNames.has(normalizedHarnessTool);
        const normalizedExt = nonFileToolKind ? extractExternalMcp(rawCandidateName) : null;
        const matchesNormalizedExternal =
          normalizedExt !== null &&
          (canWrite || isReadOnlyExternalMcpTool(normalizedExt.server, normalizedExt.tool));

        const claude = p.toolCall?._meta?.claudeCode;
        // Adapter 0.109 sends `_meta.claudeCode` only for MCP/subagent calls; native tools carry the name in `toolCall.name`.
        const claudeToolName =
          claude?.toolName ??
          (this.profile.adapter === "claude" && typeof p.toolCall?.name === "string" ? p.toolCall.name : undefined);
        const claudeUntrustedSource =
          claude?.mcpServer?.source === "project" ||
          claude?.mcpServer?.source === "user" ||
          claude?.mcpServer?.source === "local";
        const claudeExtParsed = claudeToolName ? extractExternalMcp(claudeToolName) : null;
        const claudeExternalMcp =
          this.profile.adapter === "claude" &&
          claude?.mcpServer?.name !== undefined &&
          !claudeUntrustedSource &&
          externalMcpNames.has(claude.mcpServer.name) &&
          (canWrite ||
            isReadOnlyExternalMcpTool(
              claude.mcpServer.name,
              claudeExtParsed?.tool ?? claudeToolName ?? "",
            ));
        // Allow Claude's built-in ToolSearch (required to load deferred MCP tools) and harness MCP calls across
        // any non-user/project/local MCP server source (`dynamic`, `sdk`, `acp`, `inline`, etc.) and any toolKind.
        const claudeToolSearch =
          this.profile.adapter === "claude" &&
          claudeToolName === "ToolSearch" &&
          (hasHarnessBridge || externalMcpNames.size > 0);
        const claudeHarnessMcp =
          this.profile.adapter === "claude" &&
          !claudeUntrustedSource &&
          claudeToolName !== undefined &&
          claudeToolNames.has(claudeToolName) &&
          (claude?.mcpServer === undefined || claude.mcpServer.name === "harness");

        const codexRawServer = typeof rawInput?.server === "string" ? rawInput.server : undefined;
        const codexRawTool = typeof rawInput?.tool === "string" ? rawInput.tool : undefined;
        const codexDirectHarness = Boolean(codexRawServer === "harness" && codexRawTool && harnessToolNames.has(codexRawTool));
        const codexDirectExternal = Boolean(
          codexRawServer &&
            codexRawTool &&
            externalMcpNames.has(codexRawServer) &&
            (canWrite || isReadOnlyExternalMcpTool(codexRawServer, codexRawTool)),
        );
        const codexTrackedHarness =
          toolKind === "execute" &&
          p._meta?.is_mcp_tool_approval === true &&
          callId !== undefined &&
          codexHarnessCalls.has(callId);
        const codexTrackedExternal =
          toolKind === "execute" &&
          p._meta?.is_mcp_tool_approval === true &&
          callId !== undefined &&
          codexExternalCalls.has(callId);
        const codexHarnessMcp =
          this.profile.adapter === "codex" &&
          ((toolKind === "execute" && p._meta?.is_mcp_tool_approval === true && codexDirectHarness) ||
            codexTrackedHarness ||
            matchesNormalizedHarness);
        const codexExternalMcp =
          this.profile.adapter === "codex" &&
          ((toolKind === "execute" && p._meta?.is_mcp_tool_approval === true && codexDirectExternal) ||
            codexTrackedExternal ||
            matchesNormalizedExternal);

        const geminiMcp = p.toolCall?._meta?.["gemini-cli"]?.mcp;
        const geminiExternalMcp =
          this.profile.adapter === "gemini" &&
          ((geminiMcp?.server_name !== undefined &&
            externalMcpNames.has(geminiMcp.server_name) &&
            (canWrite || isReadOnlyExternalMcpTool(geminiMcp.server_name, geminiMcp.tool_name ?? ""))) ||
            matchesNormalizedExternal);
        const geminiHarnessMcp =
          this.profile.adapter === "gemini" &&
          ((geminiMcp?.server_name === "harness" &&
            geminiMcp.tool_name !== undefined &&
            harnessToolNames.has(geminiMcp.tool_name)) ||
            matchesNormalizedHarness);

        const genericHarnessMcp = this.profile.adapter === "generic" && matchesNormalizedHarness;
        const genericExternalMcp = this.profile.adapter === "generic" && matchesNormalizedExternal;

        const harnessMcpAllowed =
          hasHarnessBridge && (claudeHarnessMcp || codexHarnessMcp || geminiHarnessMcp || genericHarnessMcp);
        const externalMcpAllowed =
          !controlOnly && (claudeExternalMcp || codexExternalMcp || geminiExternalMcp || genericExternalMcp);

        let readDenialRule: "protected-path" | "outside-roots" | undefined;
        const validateReadLocations = async (): Promise<boolean> => {
          const paths: string[] = [];
          for (const loc of p.toolCall?.locations ?? []) {
            if (loc?.path) paths.push(loc.path);
          }
          if (rawInput) {
            for (const key of ["path", "file_path", "filePath", "directory", "dir", "cwd", "target_file", "SearchPath"]) {
              const val = rawInput[key];
              if (typeof val === "string" && val.trim()) paths.push(val.trim());
            }
          }
          // The literal directory before the first glob metacharacter (`src/**/*.ts` -> `src`); a rooted glob
          // keeps `/` so it can never collapse to the workspace.
          const extractGlobPrefix = (raw: string): string => {
            const globIdx = raw.search(/[*?[{]/);
            if (globIdx < 0) return raw;
            const prefix = raw.slice(0, globIdx);
            const stripped = prefix.replace(/\/+$/, "");
            return stripped || (prefix.startsWith("/") ? "/" : ".");
          };
          const hasGlob = (s: string) => /[*?[{]/.test(s);
          // The tool resolves relative paths against the workspace, so bind them there before validation;
          // otherwise a relative path that escapes the workspace could match a nonexistent path under an extra
          // read root.
          const bindToWorkspace = (raw: string): string => (isAbsolute(raw) ? raw : resolve(workspace, raw));
          for (const rawPath of paths) {
            if (rawPath.startsWith("~")) return false; // never expanded here, so its target is unprovable
            if (hasGlob(rawPath) && /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(rawPath)) return false;
            try {
              await resolveAllowedTarget(workspace, extraReadRoots, bindToWorkspace(extractGlobPrefix(rawPath)), true, false, readProtection);
            } catch (err) {
              if (err instanceof HarnessRejection && err.notice.rule === "protected-path") {
                readDenialRule = "protected-path";
              }
              return false;
            }
          }
          // Glob's pattern can name its own root (`/etc/**`, `{/etc,src}/**`, `**/../..`); Grep's pattern is a
          // regex, so only Glob is checked.
          if (p.toolCall?.name === "Glob") {
            if (typeof rawInput?.pattern !== "string") return false;
            const pattern = rawInput.pattern.trim();
            if (!pattern || pattern.includes("\0")) return false;
            // Braces may only alternate file names or extensions after the final `/`; a brace that selects a
            // directory, or a malformed one, could make the search root differ from the validated prefix.
            if (pattern.includes("{") || pattern.includes("}")) {
              const lastSlash = pattern.lastIndexOf("/");
              const dirPart = lastSlash >= 0 ? pattern.slice(0, lastSlash + 1) : "";
              const filePart = lastSlash >= 0 ? pattern.slice(lastSlash + 1) : pattern;
              if (dirPart.includes("{") || dirPart.includes("}")) return false;
              if (!/^(?:[^{}]|\{(?:(?!\.\.)[^{}/\\,])+(?:,(?:(?!\.\.)[^{}/\\,])+)+\})+$/.test(filePart)) return false;
            }
            if (/(?:^|[{,])\s*~/.test(pattern)) return false;
            if (/(?:^|[\\/{,])\.\.(?:[\\/},]|$)/.test(pattern)) return false;
            if (/[{,]\s*\//.test(pattern)) return false;
            const baseValues = ["path", "directory", "dir", "cwd", "SearchPath"]
              .map((key) => rawInput[key])
              .filter((v) => v !== undefined);
            if (baseValues.length > 1) return false; // several bases could disagree about where Glob searches
            try {
              let effectiveBase = workspace;
              if (baseValues.length === 1) {
                const base = baseValues[0];
                if (typeof base !== "string" || !base.trim() || base.trim().startsWith("~")) return false;
                effectiveBase = (
                  await resolveAllowedTarget(workspace, extraReadRoots, bindToWorkspace(base.trim()), true, false, readProtection)
                ).path;
              }
              const prefix = extractGlobPrefix(pattern);
              await resolveAllowedTarget(
                workspace,
                extraReadRoots,
                isAbsolute(prefix) ? prefix : resolve(effectiveBase, prefix),
                true,
                false,
                readProtection,
              );
            } catch (err) {
              if (err instanceof HarnessRejection && err.notice.rule === "protected-path") {
                readDenialRule = "protected-path";
              }
              return false;
            }
          }
          return true;
        };

        const unwrapShellArgv = (argv: string[]): string => {
          if (argv.length >= 3) {
            // Only a system shell wrapper in plain or login mode counts as transparent (other startup flags, such
            // as interactive mode, change parsing); anything else is validated as a command.
            if (/^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)$/.test(argv[0]!) && /^-l?c$/.test(argv[1]!)) {
              return argv[2]!;
            }
          }
          // A direct argv runs without a shell: single-quote each element so the validator sees the exact vector.
          return argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
        };

        // Only the command the adapter will actually run is validated. The display title is adapter-rendered
        // text that is not tied to the executed command, so a call without a command field is denied.
        const extractShellCommand = (): string => {
          const fields = ["command", "cmd", "argv"].filter((key) => rawInput?.[key] !== undefined);
          if (fields.length !== 1) return ""; // none, or several that could disagree about what runs
          const value = rawInput![fields[0]!];
          if (typeof value === "string" && fields[0] !== "argv") return value;
          if (Array.isArray(value) && value.length > 0 && value.every((a) => typeof a === "string")) return unwrapShellArgv(value);
          return "";
        };

        // The shell's working directory: the workspace unless the call names one, which must itself be inside
        // an allowed read root. Returns undefined when the named directory is not provably inside.
        const resolveShellCwd = async (): Promise<string | undefined> => {
          const named = ["cwd", "workdir", "directory", "dir"].map((key) => rawInput?.[key]).filter((v) => v !== undefined);
          if (named.length === 0) return workspace;
          if (named.length > 1 || typeof named[0] !== "string" || !named[0]) return undefined;
          try {
            const target = await resolveAllowedTarget(workspace, extraReadRoots, named[0], false, false, readProtection);
            return (await stat(target.path)).isDirectory() ? target.path : undefined;
          } catch {
            return undefined;
          }
        };

        const READ_ONLY_OTHER_TOOL_RE =
          /^(?:read|read_file|view_file|view_file_outline|view_code_item|list_dir|list_directory|list_files|find_by_name|find_files|glob|grep|grep_search|search|search_files|codebase_search|ast_grep|view_signatures|extract_lines)\b/i;

        const isRead = toolKind === "read" || toolKind === "search";
        const isWrite = toolKind === "edit" || toolKind === "delete" || toolKind === "move";
        const isExecute = toolKind === "execute";
        let workspaceCall = false;
        let writeDenialRule: "protected-path" | "outside-roots" | undefined;
        // Allow native workspace reads/searches, read-only shell inspection commands, writes (when canWrite),
        // and full shell commands (when allowShell) for non-control-plane agents.
        if (!controlOnly && !claude?.mcpServer && !p._meta?.is_mcp_tool_approval && !geminiMcp) {
          if (isRead) {
            workspaceCall = await validateReadLocations();
          } else if (canWrite && isWrite) {
            try {
              // Check every reported target: locations plus any path the tool input names, since either may be
              // what the adapter writes. Non-string path values are unprovable and deny.
              const targets = (p.toolCall?.locations ?? []).map((location) => location.path as unknown);
              for (const key of ["path", "file_path", "filePath", "target_file", "notebook_path", "old_path", "new_path", "source", "destination"]) {
                if (rawInput?.[key] !== undefined) targets.push(rawInput[key]);
              }
              for (const target of targets) {
                if (typeof target !== "string" || !target.trim()) throw new Error("unprovable write target");
                await resolveAllowedTarget(workspace, extraWriteRoots, target, toolKind === "edit" || toolKind === "move", true);
              }
              workspaceCall = targets.length > 0;
            } catch (err) {
              if (err instanceof HarnessRejection && (err.notice.rule === "protected-path" || err.notice.rule === "outside-roots")) {
                writeDenialRule = err.notice.rule;
              }
              workspaceCall = false;
            }
          } else if (isExecute) {
            if (allowShell) {
              workspaceCall = true;
            } else {
              const cmd = extractShellCommand();
              const shellCwd = cmd.length > 0 ? await resolveShellCwd() : undefined;
              workspaceCall =
                shellCwd !== undefined &&
                isSafeReadOnlyShellCommand(cmd, {
                  cwd: shellCwd,
                  readRoots: [workspace, ...extraReadRoots],
                  protectedRoots:
                    readProtection === "all" ? [workspace, ...extraReadRoots] : readProtection === "extra" ? extraReadRoots.filter((root) => root !== workspace) : [],
                });
            }
          } else if (toolKind === "think") {
            workspaceCall = true;
          } else if (canWrite && (toolKind === "fetch" || toolKind === "other" || toolKind === undefined)) {
            workspaceCall = true;
          } else if ((toolKind === "other" || toolKind === undefined) && READ_ONLY_OTHER_TOOL_RE.test(rawCandidateName.trim())) {
            workspaceCall = await validateReadLocations();
          }
        }
        if (!sessionId || params.sessionId !== sessionId || !(workspaceCall || claudeToolSearch || harnessMcpAllowed || externalMcpAllowed)) {
          const deniedLabel = title || toolKind || "native tool";
          const deniedPaths = (p.toolCall?.locations ?? [])
            .map((loc) => loc?.path)
            .filter((locPath): locPath is string => typeof locPath === "string" && locPath.trim().length > 0);
          const deniedExternalMcp: { server: string; tool: string } | null =
            !controlOnly
              ? this.profile.adapter === "claude" &&
                claude?.mcpServer?.name !== undefined &&
                !claudeUntrustedSource &&
                externalMcpNames.has(claude.mcpServer.name)
                ? { server: claude.mcpServer.name, tool: claudeExtParsed?.tool ?? claudeToolName ?? deniedLabel }
                : this.profile.adapter === "codex" && codexRawServer && codexRawTool && externalMcpNames.has(codexRawServer)
                  ? { server: codexRawServer, tool: codexRawTool }
                  : this.profile.adapter === "gemini" &&
                      geminiMcp?.server_name !== undefined &&
                      externalMcpNames.has(geminiMcp.server_name)
                    ? { server: geminiMcp.server_name, tool: geminiMcp.tool_name ?? deniedLabel }
                    : normalizedExt
              : null;
          let deniedRule: string;
          let deniedArgs: Record<string, unknown> = { ...(rawInput ?? {}) };
          if (deniedExternalMcp) {
            deniedRule = "read-only-mcp";
            deniedArgs = { ...deniedArgs, server: deniedExternalMcp.server, tool: deniedExternalMcp.tool };
          } else if (!controlOnly && !claude?.mcpServer && !p._meta?.is_mcp_tool_approval && !geminiMcp && isExecute) {
            deniedRule = "read-only-shell";
            const shellCmd = extractShellCommand();
            if (shellCmd) deniedArgs = { ...deniedArgs, command: shellCmd };
          } else if (!controlOnly && !claude?.mcpServer && !p._meta?.is_mcp_tool_approval && !geminiMcp && isWrite) {
            deniedRule = canWrite ? (writeDenialRule ?? "protected-path") : "read-only-write";
          } else if (
            !controlOnly &&
            !claude?.mcpServer &&
            !p._meta?.is_mcp_tool_approval &&
            !geminiMcp &&
            (isRead || ((toolKind === "other" || toolKind === undefined) && READ_ONLY_OTHER_TOOL_RE.test(rawCandidateName.trim())))
          ) {
            deniedRule = readDenialRule ?? "outside-roots";
          } else {
            deniedRule = "tool-policy";
            deniedArgs = { ...deniedArgs, mode: req.toolPolicy };
          }
          const deniedText = formatNotice(
            deniedNotice(
              { denied: deniedRule, name: deniedLabel, args: deniedArgs, paths: deniedPaths },
              { workspaceRoot: workspace },
            ),
          );
          turnDeniedTools.push(deniedText);
          allToolFailures.push(deniedText);
          req.callbacks.onToolEvent?.({
            id: callId,
            name: deniedLabel,
            status: "failed",
            kind: toolKind,
            title: deniedLabel,
            args: toolEventPreview(Object.keys(deniedArgs).length > 0 ? deniedArgs : undefined),
            ...(deniedPaths.length > 0 ? { paths: deniedPaths } : {}),
            error: deniedText,
            denied: deniedRule,
          });
          return (
            denyOpt
              ? { outcome: { outcome: "selected", optionId: denyOpt.optionId } }
              : { outcome: { outcome: "cancelled" } }
          ) as never;
        }

        if (allowOpt) {
          return { outcome: { outcome: "selected", optionId: allowOpt.optionId } } as never;
        }
        return { outcome: { outcome: "cancelled" } } as never;
      })
      .onRequest("fs/read_text_file", async ({ params }) => {
        if (sessionId && params.sessionId === sessionId) resetIdleWatchdog();
        if (!sessionId || params.sessionId !== sessionId || controlOnly) {
          throw new Error(`Read denied: agent is running in ${policyModeDesc} mode`);
        }
        const p = params as unknown as { path: string; line?: number; limit?: number };
        const file = await openWorkspaceFile(workspace, extraReadRoots, p.path, false, readProtection);
        let raw: string;
        try {
          raw = await file.readFile("utf8");
        } finally {
          await file.close();
        }
        req.callbacks.onArtifact?.({
          kind: "read",
          path: p.path,
          summary: "fs/read_text_file",
          gitSha: null,
          exitCode: null,
        });
        if (p.line || p.limit) {
          const lines = raw.split("\n");
          const start = Math.max(0, (p.line ?? 1) - 1);
          const slice = p.limit ? lines.slice(start, start + p.limit) : lines.slice(start);
          return { content: slice.join("\n") };
        }
        return { content: raw };
      })
      .onRequest("fs/write_text_file", async ({ params }) => {
        if (sessionId && params.sessionId === sessionId) resetIdleWatchdog();
        const p = params as unknown as { path: string; content: string };
        if (!sessionId || params.sessionId !== sessionId || !canWrite) {
          throw REJECTIONS.readOnlyWrite(typeof p?.path === "string" && p.path.trim() ? p.path : workspace);
        }
        const file = await openWorkspaceFile(workspace, extraWriteRoots, p.path, true);
        try {
          await file.truncate(0);
          await file.writeFile(p.content, "utf8");
        } finally {
          await file.close();
        }
        req.callbacks.onArtifact?.({
          kind: "write",
          path: p.path,
          summary: "fs/write_text_file",
          gitSha: null,
          exitCode: null,
        });
        return {};
      });

    const conn = testAgent
      ? app.connect(testAgent)
      : app.connect(
          ndJsonStream(
            Writable.toWeb(child!.stdin!) as unknown as WritableStream<Uint8Array>,
            Readable.toWeb(child!.stdout!) as unknown as ReadableStream<Uint8Array>,
          ),
        );
    activeConnection = conn;

    const onAbort = () => {
      clearToolsWatchers();
      steerHandoff.ack?.settleAck(false);
      if (sessionId) {
        void conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
      }
      terminateChild(child);
    };
    req.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const initRes = (await withTimeout(
        conn.agent.request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          clientInfo: { name: "pi-harness", version: "0.1.0" },
          clientCapabilities: {
            fs: { readTextFile: !controlOnly, writeTextFile: canWrite },
            ...(this.profile.adapter === "claude" ? {} : {
              _meta: { jetbrains: { air: { capabilities: ["sessionFailure"] } } },
            }),
          },
        } as never),
        startupTimeoutMs,
        `ACP initialize timed out after ${startupTimeoutMs}ms`,
        () => terminateChild(child),
      )) as unknown as Record<string, unknown>;

      const initMeta = (initRes._meta ?? {}) as Record<string, unknown>;
      const steeringMeta = initMeta.steering as { supported?: boolean } | undefined;
      steeringSupported = Boolean(steeringMeta?.supported);
      const agentCapabilities = (initRes.agentCapabilities ?? {}) as Record<string, unknown>;
      const sessionCaps = (agentCapabilities.sessionCapabilities ?? {}) as Record<string, unknown>;

      // Wire Harness MCP server via stdio when daemonSocketPath + bridge are configured,
      // plus any user-configured external MCP servers (e.g. ast-grep-mcp, octofs, serena) for non-control-plane agents.
      const mcpServers: AcpMcpServerEntry[] = [];
      if (req.daemonSocketPath && req.mcpBridgeEntrypoint) {
        mcpServers.push({
          name: "harness",
          command: process.execPath,
          args: [req.mcpBridgeEntrypoint],
          env: [
            { name: "PI_HARNESS_SOCKET", value: req.daemonSocketPath },
            { name: "PI_HARNESS_RUN_ID", value: req.runId },
            // `<taskId>@g<generation>` is an execution token the bridge forwards verbatim, so the daemon refuses tool
            // calls from this bridge once that generation is no longer the task's live one.
            { name: "PI_HARNESS_TASK_ID", value: req.taskGeneration !== undefined ? `${req.taskId}@g${req.taskGeneration}${req.daemonInstanceNonce ? `@${req.daemonInstanceNonce}` : ""}` : req.taskId },
          ],
        });
      }
      mcpServers.push(...externalMcpEntries);

      const { params: newSessionParams, needsTurn1SystemPrompt } = buildNewSessionParams(this.profile.adapter, {
        cwd: req.cwd,
        systemPrompt: req.systemPrompt,
        toolPolicy: req.toolPolicy,
        allowShellInReadOnly: Boolean(req.allowShellInReadOnly),
        tier: req.tier,
        model: req.model,
        effort: req.effort,
        mcpServers,
        agentCapabilities,
        additionalDirectories: [...new Set([...extraReadRoots, ...extraWriteRoots])],
      });

      sessionStartMs = Date.now();
      const newSessionRes = (await withTimeout(
        conn.agent.request("session/new", newSessionParams as never),
        startupTimeoutMs,
        `ACP session/new timed out after ${startupTimeoutMs}ms`,
        () => terminateChild(child),
      )) as AcpModelState & { sessionId: string };
      sessionId = String(newSessionRes.sessionId);
      req.callbacks.onSessionId?.(sessionId);

      const modelConfigIds = new Set(["model"]);
      const postActions = buildPostSessionActions(this.profile.adapter, sessionId, newSessionRes, {
        toolPolicy: req.toolPolicy,
        model: req.model,
        effort: req.effort,
      }, modelConfigIds);
      for (const action of postActions) {
        let reply: AcpModelState;
        try {
          reply = await conn.agent.request(action.method as never, action.params as never);
        } catch (err) {
          if (action.requiredModel) {
            throw new Error(
              `Could not select model ${action.requiredModel}: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            );
          }
          continue; // Effort is optional.
        }
        const currentModels = reportedModels(reply, modelConfigIds);
        // session/set_model acknowledges the selected ID with an empty success response.
        const acknowledgedLegacyModel = action.method === "session/set_model" &&
          newSessionRes.models?.availableModels?.some(({ modelId }) => modelId === req.model);
        if (action.requiredModel && !currentModels.length && !acknowledgedLegacyModel) {
          throw new Error(`Could not select model ${req.model}: ${action.method} returned no current model`);
        }
        for (const current of currentModels) {
          if (!reportedModelSatisfies(this.profile.adapter, reply, current, req.model, newSessionRes)) {
            throw new Error(`Could not select model ${req.model}: ${action.method} reported ${current}`);
          }
        }
      }

      req.onHandle?.({
        steer: async (message: string) => {
          if (!sessionId) return false;
          if (steeringSupported) {
            if (req.signal.aborted || rolloverTriggered || quotaWatchdogTriggered || idleTimedOut || req.isTaskSettled?.()) {
              return false;
            }
            try {
              await conn.agent.request("_session/steering", {
                sessionId,
                prompt: [{ type: "text", text: message }],
              });
              return !req.signal.aborted && !rolloverTriggered && !quotaWatchdogTriggered && !idleTimedOut && !req.isTaskSettled?.();
            } catch {
              return false;
            }
          }
          if (isAmpProfile) {
            // Never cancel-steer while a tool call is in flight: sending session/cancel to Amp mid-tool
            // can drop Amp's MCP executor. Return false so the orchestrator queues delivery (queued_turn).
            if (hasInFlightToolCall()) return false;
            // Pick one delivery owner before sending: never probe the mutating _amp/session/steer next-turn queue.
            // With explicit AMP_ACP_CANCEL_MODE=steer on local CLI sessions (and no tool in flight), hand off one
            // mid-turn steer via session/cancel + replacement session/prompt and confirm only on correlated receipt.
            // Otherwise return false immediately so the harness queue owns delivery without duplication.
            return await startAmpCancelSteer(message, { waitForAck: true });
          }
          return false;
        },
        cancel: async (reason?: string) => {
          steerHandoff.ack?.settleAck(false);
          if (reason === "clean_rollover") {
            rolloverTriggered = true;
          }
          if (sessionId) {
            harnessCancelIssuedForTurn = true;
            await conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
          }
          if (reason === "clean_rollover") {
            armCancelGraceTimer("cancelled");
          }
        },
        turnOpen: () => promptInFlight,
      });

      const shouldPrependSystemPrompt =
        needsTurn1SystemPrompt || (prepared.prependSystemPromptToTurn1 && !sessionCaps.systemPrompt);
      const initialPromptText = shouldPrependSystemPrompt
        ? `${req.systemPrompt}\n\n---\n\n${req.initialPrompt}`
        : req.initialPrompt;

      let nextPromptText = initialPromptText;
      let promptRes: Record<string, unknown> = {};
      let rawStop = "end_turn";
      let airFailureCode = "";
      let consecutiveSilentRecoveries = 0;
      let breakerExplainedOnce = false;
      // Upstream adapter request limit (rawStop "max_turn_requests"): the harness has no turn limit, so a
      // productive turn is re-prompted on the same session; a limit hit with zero progress ends with an error.
      let upstreamLimitStalled = false;
      let steerContinuations = 0;
      let pendingSteerTurnPromise: Promise<Record<string, unknown>> | null = null;

      for (let recoveryAttempt = 0; recoveryAttempt <= MAX_TOTAL_RECOVERY_CONTINUATIONS; recoveryAttempt++) {
        turnsUsed += 1;
        req.callbacks.onTurn?.(turnsUsed);
        completedToolInWave = false;
        inFlightToolCalls.clear();
        anonymousInFlightToolCalls = 0;
        turnFailedTools = [];
        turnDeniedTools = [];
        turnSucceededTools = 0;
        turnToolCalls = 0;
        turnHarnessToolCallObserved = false;
        turnText = "";
        textSinceLastTool = "";
        steerHandoff.cancelIssuedForTurn = false;
        harnessCancelIssuedForTurn = false;

        promptInFlight = true;
        try {
          const promptPromise =
            pendingSteerTurnPromise ??
            (conn.agent.request("session/prompt", {
              sessionId,
              prompt: [{ type: "text", text: nextPromptText }],
            } as never) as unknown as Promise<Record<string, unknown>>);
          pendingSteerTurnPromise = null;
          if (turnsUsed === 1) {
            startToolsGraceWatch();
          }

          promptRes = await new Promise<Record<string, unknown>>((resolvePrompt, rejectPromptRaw) => {
            resolveActivePromptOnGrace = resolvePrompt;
            // When the harness cut the wrap-up turn off at its time cap (or handed off via cancel-then-prompt
            // steering, or cancelled turn 1 on tools_missing grace expiry), an adapter that answers session/cancel
            // by rejecting the pending prompt ("Request cancelled") ends that turn cleanly. Abort, rollover, idle
            // timeout, child death, auth, quota and other RPC errors still reject.
            const rejectPrompt = (err: unknown) => {
              const steerCancelled = steerHandoff.pending !== null || steerHandoff.cancelIssuedForTurn;
              const toolsCancelled = toolsMissingError !== null;
              const brokenCancelled = brokenSessionCode !== null;
              const expectedCancel = wrapUpTimedOut || steerCancelled || toolsCancelled || brokenCancelled;
              if (expectedCancel && !req.signal.aborted && !rolloverTriggered && !idleTimedOut && !(childGoneError && err === childGoneError)) {
                const detail = `${err instanceof Error ? err.message : String(err)} ${acpErrorDetail(err)}`;
                const code = (err as { code?: unknown } | null)?.code;
                const name = err instanceof Error ? err.name : "";
                // Only a complete diagnostic field counts: a cancellation phrase quoted inside a longer error is prose.
                const wholeCancel = /^(?:(?:request|operation|prompt|turn)\s+)?(?:cancell?ed|aborted)(?:\s+by\s+(?:user|client))?\.?$/i;
                const explicitCancel = [err instanceof Error ? err.message : String(err), ...acpErrorParts(err)].some((f) =>
                  wholeCancel.test(f.trim()),
                );
                // Structured codes decide first: -32800 (plain or wrapped by an internal error) is a cancellation and any
                // other specific code, however its prose reads, is a genuine RPC error. Only a wrapper with no specific
                // code falls back to a whole-phrase "request cancelled", or a code-less abort.
                const nested = code === undefined || code === -32603 || typeof code !== "number" ? nestedRpcCode(err) : undefined;
                const isCancelled =
                  code === -32800 ||
                  (typeof nested === "number" && nested === -32800) ||
                  (nested === undefined && code === -32603 && explicitCancel) ||
                  (nested === undefined && typeof code !== "number" && (name === "AbortError" || explicitCancel));
                if (isCancelled && !detectQuotaErrorText(detail).isQuota && !isAcpAuthError(err, detail)) {
                  resolvePrompt({ stopReason: steerCancelled || toolsCancelled || brokenCancelled ? "cancelled" : "end_turn" });
                  return;
                }
              }
              rejectPromptRaw(err);
            };
            rejectActivePromptOnChildExit = rejectPrompt;
            if (child && (child.exitCode !== null || child.signalCode !== null)) {
              // The child died before this prompt started: fail now rather than wait on a dead pipe.
              childGoneError = new Error(childExitMessage(child.exitCode, child.signalCode));
              clearIdleWatchdog();
              promptPromise.catch(() => {});
              rejectPrompt(childGoneError);
              return;
            }
            if (idleTimeoutMs > 0) {
              rejectActivePromptOnIdle = rejectPrompt;
              resetIdleWatchdog();
            }
            promptPromise.then(
              (val) => {
                clearIdleWatchdog();
                resolvePrompt(val);
              },
              (err) => {
                clearIdleWatchdog();
                rejectPrompt(err);
              },
            );
          });
        } finally {
          promptInFlight = false;
          if (toolsCancelGraceTimer) {
            clearTimeout(toolsCancelGraceTimer);
            toolsCancelGraceTimer = null;
          }
          if (steerHandoff.pending) steerHandoff.pending.priorTurnSettled = true;
          if (steerHandoff.ack) steerHandoff.ack.priorTurnSettled = true;
        }

        // Harvest passive quota & terminal sessionFailure signals
        const promptMeta = (promptRes._meta ?? {}) as Record<string, unknown>;
        const airFailure = (((promptMeta.jetbrains as Record<string, unknown> | undefined)?.air as Record<string, unknown> | undefined)
          ?.sessionFailure ??
          promptMeta.sessionFailure) as Record<string, unknown> | string | undefined;
        if (airFailure) {
          const code = typeof airFailure === "string" ? airFailure : String(airFailure.code ?? airFailure.reason ?? "");
          if (code) {
            airFailureCode = code;
            if (isStructuredAuthFailureCode(code)) {
              const detailMsg =
                typeof airFailure === "object" && airFailure !== null
                  ? String(airFailure.message ?? airFailure.detail ?? airFailure.reason ?? code)
                  : code;
              failAuthRequired(detailMsg.trim() || code);
            }
            req.callbacks.onPassiveQuota?.({
              profileId: this.profile.id,
              model: req.model,
              raw: { sessionFailure: code, ...(lastQuotaResetAt ? { resetAt: lastQuotaResetAt } : {}) },
              observedAt: Date.now(),
            });
          }
        }

        // Merge PromptResponse.usage if available, and run fallback rollover evaluation when usage_update was omitted
        const promptUsage = promptRes.usage as Record<string, unknown> | undefined;
        if (promptUsage) {
          const hadUsageUpdate = lastUsage !== undefined;
          const totalFromParts =
            Number(promptUsage.inputTokens ?? 0) +
            Number(promptUsage.outputTokens ?? 0) +
            Number(promptUsage.cachedReadTokens ?? 0) +
            Number(promptUsage.cachedWriteTokens ?? 0);
          const fallbackUsed =
            promptUsage.totalTokens != null ? Number(promptUsage.totalTokens) : totalFromParts;
          const used = lastUsage?.used ?? fallbackUsed;
          const size = (lastUsage?.size && lastUsage.size > 0 ? lastUsage.size : undefined) ?? req.contextWindow ?? 0;
          lastUsage = {
            used,
            size,
            inputTokens: Number(promptUsage.inputTokens ?? 0),
            outputTokens: Number(promptUsage.outputTokens ?? 0),
            cachedReadTokens: promptUsage.cachedReadTokens == null ? undefined : Number(promptUsage.cachedReadTokens),
            cachedWriteTokens: promptUsage.cachedWriteTokens == null ? undefined : Number(promptUsage.cachedWriteTokens),
            thoughtTokens: promptUsage.thoughtTokens == null ? undefined : Number(promptUsage.thoughtTokens),
            cost: lastUsage?.cost,
          };
          if (!hadUsageUpdate) {
            req.callbacks.onUsage?.(lastUsage);
            if (!rolloverTriggered && rolloverThreshold && size > 0 && used / size >= rolloverThreshold) {
              rolloverTriggered = true;
            }
          }
        }
        const turnModels = (promptMeta.quota as { model_usage?: unknown[] } | undefined)?.model_usage;
        flushCost(Array.isArray(turnModels) ? turnModels.length : 0);

        rawStop = String(promptRes.stopReason ?? "end_turn");
        if (wrapUpTimer) {
          clearTimeout(wrapUpTimer);
          wrapUpTimer = null;
        }
        // A wrap-up turn the harness cut off at its time cap ends as a normal turn end, not a self-cancel.
        if (wrapUpTimedOut && rawStop === "cancelled") rawStop = "end_turn";

        const turnQuotaDetected = detectQuotaErrorText(quotaRejected ? textSinceQuotaRejection || accumulatedText : accumulatedText);
        // Require either a real rejection/rate-limit signal OR a short hard-exhaustion message with 0 successful tools,
        // so ordinary prose mentioning "rate limiting" never falsely pauses healthy turns while text-only caps still pause.
        const shortHardQuotaText =
          turnSucceededTools === 0 &&
          accumulatedText.trim().length > 0 &&
          accumulatedText.trim().length <= 600 &&
          turnQuotaDetected.isHardExhaustion;
        const turnQuotaFalseCompletion =
          (quotaRejected && (textSinceQuotaRejection.trim().length === 0 || turnQuotaDetected.isQuota)) ||
          (quotaRetryHits > 0 && turnSucceededTools === 0 && turnQuotaDetected.isQuota) ||
          shortHardQuotaText;

        // Never continue if rollover, quota watchdog, quota rejection, broken session, user abort, or quota failure occurred
        if (
          rolloverTriggered ||
          quotaWatchdogTriggered ||
          turnQuotaFalseCompletion ||
          brokenSessionCode !== null ||
          req.signal.aborted ||
          ["quota_exhausted", "rate_limited", "budget_exhausted"].includes(airFailureCode)
        ) {
          clearToolsWatchers();
          if (steerHandoff.pending) {
            steerHandoff.pending.settleAck(false);
            steerHandoff.pending = null;
          }
          break;
        }

        if (matchesAuthTextHeuristic(Boolean(toolsMissingError))) {
          failAuthRequired(turnText);
        }
        if (toolsMissingError && !checkHarnessToolsReady()) {
          clearToolsWatchers();
          throw toolsMissingError;
        }
        const toolsReadyNow = !toolsCheckEnabled || checkHarnessToolsReady();
        if (rawStop !== "cancelled" && !airFailureCode && toolsReadyNow) {
          const hasSuccessSignal =
            turnSucceededTools > 0 ||
            accumulatedText.trim().length > 0 ||
            (turnFailedTools.length === 0 && turnDeniedTools.length === 0 && turnToolCalls === 0);
          if (hasSuccessSignal) {
            emitAuthOk();
          }
        }

        // A cancel-then-prompt steer hand-off replaced this turn: continue by awaiting the replacement prompt.
        if (steerHandoff.pending) {
          const handoff = steerHandoff.pending;
          steerHandoff.pending = null;
          if (handoff.abortedBeforeSend || req.isTaskSettled?.()) {
            handoff.settleAck(false);
            if (req.isTaskSettled?.() && sessionId) {
              harnessCancelIssuedForTurn = true;
              void conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
            }
            break;
          }
          if (!(handoff.ackSettled && !handoff.ackLive && rawStop !== "cancelled")) {
            pendingSteerTurnPromise = handoff.turnPromise;
            if (accumulatedText.length > 0) needsParagraphBreak = true;
            recoveryAttempt -= 1;
            continue;
          }
        }

        // The wrap-up turn is final: no breaker, silent-recovery or adapter-limit continuation after it.
        if (wrapUpAttempted) break;

        if (rawStop === "max_turn_requests") {
          if (turnSucceededTools === 0) {
            upstreamLimitStalled = true;
            break;
          }
          nextPromptText =
            "The agent runtime ended that turn at its own request limit; the harness has no turn limit. Continue from where you left off.";
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          // Productive continuation: does not consume the failure-recovery budget.
          recoveryAttempt -= 1;
          continue;
        }

        // If the identical-failure circuit breaker tripped (6+ consecutive identical failures with zero
        // intervening successes), give the model ONE clean chance to stop retrying and explain the blocker.
        if (identicalFailureBreakerTripped && !breakerExplainedOnce && recoveryAttempt < MAX_TOTAL_RECOVERY_CONTINUATIONS) {
          breakerExplainedOnce = true;
          identicalFailureBreakerTripped = false;
          identicalFailureStreak = 0;
          lastIdenticalFailureKey = "";
          const lastFail = turnFailedTools[turnFailedTools.length - 1];
          nextPromptText = [
            `Circuit breaker triggered: tool "${lastFail?.title ?? "tool"}" failed ${IDENTICAL_FAILURE_BREAKER} consecutive times with the same error${lastFail?.detail ? ` (${lastFail.detail})` : ""} and no successful tool calls in between.`,
            "Do NOT retry the exact same failing call again. Either switch to a genuinely different approach, or clearly report that you are unable to complete this action and explain why.",
          ].join("\n");
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          continue;
        }

        // Any successful tool call resets the silent-recovery streak so normal multi-step exploration never trips!
        if (turnSucceededTools > 0) {
          consecutiveSilentRecoveries = 0;
        }

        // Tool-Failure Continuation Recovery:
        // If a tool call failed or was denied and the agent stopped immediately without producing
        // any reasoning/response after the failure, prompt it to continue thinking on the same session.
        // If the model DOES emit text (e.g. explaining it cannot do something), we accept it immediately!
        const hadToolProblem = turnFailedTools.length > 0 || turnDeniedTools.length > 0;
        const stoppedSilentAfterTool =
          hadToolProblem &&
          ((rawStop !== "cancelled" && textSinceLastTool.trim().length === 0) ||
            (rawStop === "cancelled" && turnDeniedTools.length > 0));
        if (
          stoppedSilentAfterTool &&
          consecutiveSilentRecoveries < MAX_CONSECUTIVE_SILENT_RECOVERIES &&
          recoveryAttempt < MAX_TOTAL_RECOVERY_CONTINUATIONS
        ) {
          consecutiveSilentRecoveries += 1;
          const failureSummary = [
            ...turnFailedTools.map((f) => `- Tool "${f.title}" failed${f.detail ? `: ${f.detail}` : ""}`),
            ...turnDeniedTools.map((d) => `- ${d}`),
          ].join("\n");
          nextPromptText = [
            "Your previous tool call did not succeed and your turn ended before you finished responding:",
            failureSummary,
            "",
            "Do NOT silently stop here. Figure out an allowed alternative approach if possible — OR if this task/action genuinely cannot be completed, clearly report that you are unable to do it and explain the blocker.",
          ].join("\n");
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          continue;
        }
        // Steering queued while the agent could not take it natively opens the next turn (before any wrap-up).
        if (rawStop !== "cancelled" && !req.isTaskSettled?.() && steerContinuations < MAX_RUNNER_STEER_CONTINUATIONS) {
          const steers = req.drainPendingSteers?.() ?? [];
          if (steers.length > 0) {
            steerContinuations += 1;
            nextPromptText = `[Steering Update]\n${steers.join("\n\n")}`;
            if (accumulatedText.length > 0) needsParagraphBreak = true;
            // Does not consume the failure-recovery budget.
            recoveryAttempt -= 1;
            continue;
          }
        }
        if (rawStop !== "cancelled" && !req.isTaskSettled?.() && pendingRolloverWarning) {
          nextPromptText = pendingRolloverWarning;
          pendingRolloverWarning = null;
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          // Does not consume the failure-recovery budget.
          recoveryAttempt -= 1;
          continue;
        }
        if (
          rawStop !== "cancelled" &&
          req.missingReturnWrapUpPrompt &&
          !wrapUpAttempted &&
          !req.isTaskSettled?.()
        ) {
          wrapUpAttempted = true;
          nextPromptText = req.missingReturnWrapUpPrompt;
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          wrapUpTimer = setTimeout(() => {
            wrapUpTimer = null;
            wrapUpTimedOut = true;
            if (sessionId) void conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
            armCancelGraceTimer("end_turn");
          }, WRAP_UP_TIMEOUT_MS);
          wrapUpTimer.unref?.();
          // Does not consume the failure-recovery budget.
          recoveryAttempt -= 1;
          continue;
        }
        break;
      }

      const finalQuotaDetected = detectQuotaErrorText(quotaRejected ? textSinceQuotaRejection || accumulatedText : accumulatedText);
      const finalShortHardQuota =
        turnSucceededTools === 0 &&
        accumulatedText.trim().length > 0 &&
        accumulatedText.trim().length <= 600 &&
        finalQuotaDetected.isHardExhaustion;
      const quotaFalseCompletion =
        (quotaRejected && (textSinceQuotaRejection.trim().length === 0 || finalQuotaDetected.isQuota)) ||
        (quotaRetryHits > 0 && turnSucceededTools === 0 && finalQuotaDetected.isQuota) ||
        finalShortHardQuota;

      if (
        quotaWatchdogTriggered ||
        quotaFalseCompletion ||
        ["quota_exhausted", "rate_limited", "budget_exhausted"].includes(airFailureCode)
      ) {
        const isHard =
          lastQuotaHard ||
          finalQuotaDetected.isHardExhaustion ||
          airFailureCode === "quota_exhausted" ||
          airFailureCode === "budget_exhausted";
        const reason =
          lastQuotaReason ||
          (finalQuotaDetected.isQuota ? finalQuotaDetected.summary : "") ||
          (airFailureCode ? `ACP sessionFailure: ${airFailureCode}` : `Rate-limit retry timed out after ${Math.round(quotaTimeoutMs / 1000)}s`);
        const detail =
          lastQuotaDetail ||
          (finalQuotaDetected.isQuota ? finalQuotaDetected.detail : "") ||
          reason;
        const resetAt = lastQuotaResetAt ?? finalQuotaDetected.resetAtIso ?? null;
        req.callbacks.onPassiveQuota?.({
          profileId: this.profile.id,
          model: req.model,
          raw: {
            sessionFailure: isHard ? "quota_exhausted" : "rate_limited",
            ...(resetAt ? { resetAt } : {}),
          },
          observedAt: Date.now(),
        });
        const quotaPause: QuotaPauseInfo = {
          reason,
          detail,
          resetAt,
          retryCount: Math.max(1, quotaRetryHits),
          watchdogTimedOut: quotaWatchdogTriggered,
          isHardExhaustion: isHard,
        };
        return {
          text: accumulatedText,
          stopReason: "quota_paused",
          usage: lastUsage,
          sessionId,
          quotaPause,
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
        };
      }

      if (this.profile.adapter === "codex" && turnSucceededTools === 0) {
        const codexMisconfig = detectCodexCodeModeMisconfig(`${stderrBuf}\n${allToolFailures.join("\n")}`);
        if (codexMisconfig) {
          const tail = stderrTail(stderrBuf);
          const detail = tail ? ` (stderr: ${tail})` : "";
          throw new Error(`ACP runner (${this.profile.id}): ${codexMisconfig}${detail}`);
        }
      }

      if (upstreamLimitStalled && !rolloverTriggered && !req.signal.aborted) {
        const msg =
          `ACP runner (${this.profile.id}): the upstream agent adapter ended a turn at its own request limit (max_turn_requests) ` +
          "without any successful tool call. This is an adapter limit, not a harness turn limit; the harness stopped re-prompting to avoid a hot loop.";
        return {
          text: accumulatedText ? `${accumulatedText}\n\n${msg}` : msg,
          stopReason: "error",
          usage: lastUsage,
          sessionId,
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
        };
      }

      if (brokenSessionCode && !rolloverTriggered && !req.signal.aborted) {
        const msg = brokenSessionDetail
          ? `ACP session broken (${brokenSessionCode}): ${brokenSessionDetail}`
          : `ACP session broken (${brokenSessionCode})`;
        return {
          text: accumulatedText ? `${accumulatedText}\n\n${msg}` : msg,
          stopReason: "error",
          errorCode: brokenSessionCode,
          usage: lastUsage,
          sessionId,
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
          ...(wrapUpAttempted ? { wrapUpAttempted: true } : {}),
        };
      }

      if (
        toolsCheckEnabled &&
        !checkHarnessToolsReady() &&
        !rolloverTriggered &&
        !req.signal.aborted &&
        rawStop !== "cancelled"
      ) {
        clearToolsWatchers();
        if (!wrapUpAttempted && !toolsNotYetListed && firstPromptStartMs > 0) {
          const deadline = firstPromptStartMs + toolsGraceMs;
          while (
            !checkHarnessToolsReady() &&
            !req.signal.aborted &&
            !rolloverTriggered &&
            Date.now() < deadline
          ) {
            const remaining = deadline - Date.now();
            await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, remaining))));
          }
        }
        if (!checkHarnessToolsReady() && !rolloverTriggered && !req.signal.aborted) {
          throw makeToolsMissingError("turn_ended");
        }
        if (checkHarnessToolsReady() && !airFailureCode) {
          const hasSuccessSignal =
            turnSucceededTools > 0 ||
            accumulatedText.trim().length > 0 ||
            (turnFailedTools.length === 0 && turnDeniedTools.length === 0 && turnToolCalls === 0);
          if (hasSuccessSignal) {
            emitAuthOk();
          }
        }
      }

      const stopReason: RunAgentResult["stopReason"] = rolloverTriggered
        ? "rollover_requested"
        : rawStop === "cancelled" || req.signal.aborted
          ? "cancelled"
          : "completed";
      const unsolicitedCancel =
        stopReason === "cancelled" &&
        !rolloverTriggered &&
        !req.signal.aborted &&
        !harnessCancelIssuedForTurn &&
        !steerAckTimedOut &&
        turnDeniedTools.length === 0;

      return {
        text: accumulatedText,
        stopReason,
        ...(unsolicitedCancel ? { errorCode: ACP_EXECUTOR_LOST_ERROR_CODE } : {}),
        usage: lastUsage,
        sessionId,
        toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
        ...(wrapUpAttempted ? { wrapUpAttempted: true } : {}),
      };
    } catch (err) {
      if (err instanceof AcpProfileError) throw err;
      if (this.profile.adapter === "codex" && turnSucceededTools === 0) {
        const primaryMsg = (spawnErr ?? err) instanceof Error ? (spawnErr ?? err as Error).message : String(spawnErr ?? err);
        const codexMisconfig = detectCodexCodeModeMisconfig(`${primaryMsg}\n${stderrBuf}\n${allToolFailures.join("\n")}`);
        if (codexMisconfig) {
          if (primaryMsg.includes(codexMisconfig)) throw (spawnErr ?? err);
          const tail = stderrTail(stderrBuf);
          const detail = tail ? ` (stderr: ${tail})` : "";
          throw new Error(`ACP runner (${this.profile.id}): ${codexMisconfig}${detail}`);
        }
      }
      if (rolloverTriggered) {
        return {
          text: accumulatedText,
          stopReason: "rollover_requested",
          usage: lastUsage,
          sessionId,
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
        };
      }
      if (brokenSessionCode && !req.signal.aborted) {
        const msg = brokenSessionDetail
          ? `ACP session broken (${brokenSessionCode}): ${brokenSessionDetail}`
          : `ACP session broken (${brokenSessionCode})`;
        return {
          text: accumulatedText ? `${accumulatedText}\n\n${msg}` : msg,
          stopReason: "error",
          errorCode: brokenSessionCode,
          usage: lastUsage,
          sessionId,
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
          ...(wrapUpAttempted ? { wrapUpAttempted: true } : {}),
        };
      }
      if (idleTimedOut && !quotaWatchdogTriggered) {
        throw new Error(`ACP runner (${this.profile.id}) timed out after ${idleTimeoutMs}ms of inactivity`);
      }
      let primary = spawnErr ?? err;
      const childDied = Boolean(childGoneError && primary === childGoneError);
      // Normal pipe closure rejects the prompt with a transport EOF before the exit flush timer fires. Reconcile it
      // with the child's exit (bounded wait) so the outcome does not depend on which event arrived first. A JSON-RPC
      // error response from the agent carries a numeric code and is never treated as transport closure.
      if (!childDied && child && sessionId && !spawnErr && !req.signal.aborted && typeof (primary as { code?: unknown } | null)?.code !== "number") {
        if (!childExitInfo && child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolveWait) => {
            const done = () => {
              clearTimeout(waitTimer);
              child.off("exit", done);
              resolveWait();
            };
            const waitTimer = setTimeout(done, 250);
            child.once("exit", done);
          });
        }
        const info = childExitInfo as { code: number | null; signal: NodeJS.Signals | null } | null;
        const code = info?.code ?? child.exitCode;
        const signal = info?.signal ?? child.signalCode;
        if (code !== null || signal !== null) {
          primary = childGoneError = new Error(childExitMessage(code, signal));
        }
      }
      const baseMsg = primary instanceof Error ? primary.message : String(primary);
      const errDetail = acpErrorDetail(primary);
      const errMsg = errDetail && !baseMsg.includes(errDetail) ? `${baseMsg}: ${errDetail}` : baseMsg;
      if (isAcpAuthError(primary, errMsg)) {
        failAuthRequired(errMsg);
      }
      if (matchesAuthTextHeuristic(true)) {
        failAuthRequired(turnText);
      }
      // Harvest structured `rateLimit` info from ACP JSON-RPC error data (e.g. Claude `turnErrorData` when refused before first usage)
      const rawData =
        (primary as { data?: unknown } | null)?.data ?? (primary as { cause?: { data?: unknown } } | null)?.cause?.data;
      const errData = rawData && typeof rawData === "object" ? (rawData as Record<string, unknown>) : undefined;
      const errRateLimit =
        errData && typeof errData === "object" && errData.rateLimit && typeof errData.rateLimit === "object"
          ? (errData.rateLimit as Record<string, unknown>)
          : null;
      if (errRateLimit) {
        req.callbacks.onPassiveQuota?.({
          profileId: this.profile.id,
          model: req.model,
          raw: errRateLimit,
          observedAt: Date.now(),
        });
        if (typeof errRateLimit.resetsAt === "number" && !lastQuotaResetAt) {
          lastQuotaResetAt = new Date(errRateLimit.resetsAt * 1000).toISOString();
        }
      }
      const combined = `${errMsg}\n${stderrBuf}`;
      // For a child death the stderr tail is history (live stderr quota lines already drive quotaRetrying), so only
      // the error itself is scanned.
      const isChildExit = Boolean(childGoneError && primary === childGoneError);
      const detected = detectQuotaErrorText(isChildExit ? errMsg : combined);

      // A child death (including transport EOF reconciled with the exit above) is classified from quota state that is
      // still unresolved now (quotaRetrying clears on forward progress), never from lifetime retry history: a recovered
      // worker that later crashes fails instead of pausing. Any other error, such as an explicit JSON-RPC error from a
      // live agent, pauses only when the error itself signals quota.
      const quotaSignal =
        quotaWatchdogTriggered ||
        (isChildExit && quotaRetrying) ||
        detected.isQuota ||
        errData?.errorKind === "rate_limit" ||
        Boolean(errRateLimit);
      if (quotaSignal) {
        const reason = lastQuotaReason || detected.summary || errMsg;
        const detail = lastQuotaDetail || detected.detail || reason;
        const resetAt = lastQuotaResetAt ?? detected.resetAtIso ?? null;
        const isHard = lastQuotaHard || detected.isHardExhaustion;
        req.callbacks.onPassiveQuota?.({
          profileId: this.profile.id,
          model: req.model,
          raw: {
            sessionFailure: isHard ? "quota_exhausted" : "rate_limited",
            ...(resetAt ? { resetAt } : {}),
          },
          observedAt: Date.now(),
        });
        return {
          text: accumulatedText,
          stopReason: "quota_paused",
          usage: lastUsage,
          sessionId,
          quotaPause: {
            reason,
            detail,
            resetAt,
            retryCount: Math.max(1, quotaRetryHits),
            watchdogTimedOut: quotaWatchdogTriggered,
            isHardExhaustion: isHard,
          },
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
        };
      }

      if (toolsMissingError && !checkHarnessToolsReady()) {
        throw toolsMissingError;
      }

      const tail = stderrTail(stderrBuf);
      const detail = tail ? ` (stderr: ${tail})` : "";
      if (this.profile.adapter === "codex") {
        const codexMisconfig = detectCodexCodeModeMisconfig(combined);
        if (codexMisconfig) {
          if (errMsg.includes(codexMisconfig)) throw new Error(errMsg);
          throw new Error(`ACP runner (${this.profile.id}): ${codexMisconfig}${detail}`);
        }
      }
      throw new Error(`ACP runner (${this.profile.id}) failed: ${errMsg}${detail}`);
    } finally {
      steerHandoff.ack?.settleAck(false);
      steerHandoff.pending?.settleAck(false);
      steerHandoff.pending = null;
      flushCost();
      clearToolsWatchers();
      clearIdleWatchdog();
      if (livenessTimer) clearInterval(livenessTimer);
      if (wrapUpTimer) clearTimeout(wrapUpTimer);
      child?.off("exit", onChildExit);
      child?.off("close", onChildExit);
      disarmQuotaWatchdog(false);
      req.signal.removeEventListener("abort", onAbort);
      try {
        await Promise.resolve(conn.close()).catch(() => {});
      } catch {
        // ignore close error on already-exited pipe
      }
      terminateChild(child);
      prepared.cleanup();
    }
  }

  /**
   * Probes an ACP CLI out-of-band to discover its currently runnable models & effort options
   * for the automated Model Catalog compiler.
   */
  async probeModels(cwd: string, timeoutMs = 15_000, testAgent?: AgentApp): Promise<ProbedModelInfo[]> {
    if (this.profile.models && this.profile.models.length > 0) {
      return this.profile.models.map((wireModelId) => ({ wireModelId }));
    }

    const child = testAgent
      ? null
      : spawn(this.profile.command, this.profile.args ?? [], {
          cwd,
          env: { ...process.env, ...(this.profile.env ?? {}) },
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
    if (child) {
      child.on("error", () => {});
      child.stdin?.on("error", () => {});
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
    }

    const app = client();
    const conn = testAgent
      ? app.connect(testAgent)
      : app.connect(
          ndJsonStream(
            Writable.toWeb(child!.stdin!) as unknown as WritableStream<Uint8Array>,
            Readable.toWeb(child!.stdout!) as unknown as ReadableStream<Uint8Array>,
          ),
        );

    const timer = setTimeout(() => {
      try {
        void Promise.resolve(conn.close()).catch(() => {});
      } catch {
        // ignore
      }
      terminateChild(child);
    }, timeoutMs);
    timer.unref?.();

    try {
      await conn.agent.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "pi-harness-probe", version: "0.1.0" },
        clientCapabilities: {},
      } as never);

      const res = (await conn.agent.request("session/new", {
        cwd,
        mcpServers: [],
      } as never)) as unknown as Record<string, unknown>;

      const results: ProbedModelInfo[] = [];
      const configOptions = (res.configOptions ?? []) as AcpConfigOption[];
      const effortOpt = configOptions.find(
        (c) => c.category === "thought_level" || c.id === "effort" || c.id === "reasoning_effort",
      );
      const supportedEfforts = selectValues(effortOpt)?.map((o) => o.value);

      const legacyModels = (
        res.models as { availableModels?: Array<{ modelId: string; name?: string; description?: string }> } | undefined
      )?.availableModels;
      const legacyById = new Map((legacyModels ?? []).map((m) => [m.modelId, m]));
      const explicitClaudeByFamily = new Map<string, string | null>();
      for (const m of legacyModels ?? []) {
        const match = m.modelId.match(/^(?:anthropic\/)?(claude-(opus|sonnet|haiku|fable)-\d+(?:[.-]\d+)*(?:-\d{8})?)$/i);
        if (match) {
          const family = match[2]!.toLowerCase();
          const prev = explicitClaudeByFamily.get(family);
          if (prev === undefined) {
            explicitClaudeByFamily.set(family, match[1]!);
          } else if (prev !== match[1]!) {
            // Multiple distinct versions in the same family -> ambiguous; do not guess
            explicitClaudeByFamily.set(family, null);
          }
        }
      }

      const modelOpt = configOptions.find((c) => c.category === "model" || c.id === "model");
      for (const opt of selectValues(modelOpt) ?? []) {
        const legacy = legacyById.get(opt.value);
        const bareClaude = opt.value.trim().match(/^(?:anthropic\/)?(?:claude-)?(opus|sonnet|haiku|fable)$/i);
        const candidateExplicit = bareClaude ? explicitClaudeByFamily.get(bareClaude[1]!.toLowerCase()) : undefined;
        const explicitModelId = candidateExplicit ?? undefined;
        results.push({
          wireModelId: opt.value,
          name: opt.name ?? legacy?.name,
          ...(opt.description ?? legacy?.description ? { description: opt.description ?? legacy?.description } : {}),
          ...(explicitModelId ? { explicitModelId } : {}),
          supportedEfforts,
        });
      }

      // Legacy fallback (gemini --acp `models.availableModels`)
      if (results.length === 0 && legacyModels) {
        for (const m of legacyModels) {
          results.push({
            wireModelId: m.modelId,
            name: m.name,
            ...(m.description ? { description: m.description } : {}),
          });
        }
      }

      return results;
    } finally {
      clearTimeout(timer);
      try {
        await Promise.resolve(conn.close()).catch(() => {});
      } catch {
        // ignore
      }
      terminateChild(child);
    }
  }
}
