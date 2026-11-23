import { toolEventPreview } from "../protocol/tool-display.js";
import { randomUUID } from "node:crypto";
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
import { detectQuotaErrorText } from "./quota-detect.js";
import { validateRunPolicy } from "./types.js";
import type { ProbedModelInfo, QuotaPauseInfo, RunAgentRequest, RunAgentResult, RunnerCost, RunnerUsage, ToolPolicy } from "./types.js";

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
    throw new Error("ACP filesystem path is outside the task workspace");
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
      throw new Error("ACP filesystem path is outside the task workspace");
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

async function resolveAllowedTarget(
  primaryRoot: string,
  extraRoots: string[],
  requested: string,
  allowNew: boolean,
): Promise<{ path: string; exists: boolean; root: string }> {
  let firstErr: unknown;
  for (const root of [primaryRoot, ...extraRoots]) {
    try {
      const target = await workspaceTarget(root, requested, allowNew);
      return { ...target, root };
    } catch (err) {
      if (!firstErr) firstErr = err;
    }
  }
  throw firstErr ?? new Error("ACP filesystem path is outside allowed roots");
}

async function openWorkspaceFile(primaryRoot: string, extraRoots: string[], requested: string, write: boolean) {
  const { path: target, exists, root } = await resolveAllowedTarget(primaryRoot, extraRoots, requested, write);
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
const IDENTICAL_FAILURE_BREAKER = 6;
const DEFAULT_QUOTA_RETRY_TIMEOUT_MS = 45_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 45_000;
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;

export class AcpRunner {
  constructor(private readonly profile: AcpProfileConfig) {}

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
    const policyModeDesc = describeToolPolicyMode(req.toolPolicy, Boolean(req.allowShellInReadOnly));
    const prepared = prepareAcpSpawn(this.profile, {
      systemPrompt: req.systemPrompt,
      toolPolicy: req.toolPolicy,
      allowShellInReadOnly: Boolean(req.allowShellInReadOnly),
    });
    if ((allowShell || !controlOnly) && req.extraPathDirs?.length) {
      const existingPath = prepared.env.PATH ?? process.env.PATH ?? "";
      prepared.env.PATH = [...req.extraPathDirs, existingPath].filter(Boolean).join(process.platform === "win32" ? ";" : ":");
    }

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
    let rolloverTriggered = false;
    let rolloverWarningSent = false;
    let maxTurnsTriggered = false;
    let turnsUsed = 0;
    let completedToolInWave = false;
    const inFlightToolCalls = new Set<string>();
    let sessionId: string | undefined;
    let steeringSupported = false;
    const isAmpProfile = isAmpAcpProfile(this.profile);
    let activeConnection: ClientConnection | null = null;
    const toolTitlesById = new Map<string, string>();

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
      resolveActivePromptOnGrace = null;
      rejectActivePromptOnIdle = null;
    };
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
      const effectiveMs = inFlightToolCalls.size > 0 ? Math.max(idleTimeoutMs, 1_800_000) : idleTimeoutMs;
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (quotaWatchdogTriggered || rolloverTriggered || maxTurnsTriggered || req.signal.aborted) return;
        idleTimedOut = true;
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

    const advanceTurnWaveIfNeeded = () => {
      if (!completedToolInWave || inFlightToolCalls.size > 0 || maxTurnsTriggered) return;
      completedToolInWave = false;
      if (req.maxTurns > 0 && turnsUsed >= req.maxTurns) {
        maxTurnsTriggered = true;
        if (sessionId && activeConnection) {
          void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
        }
        armCancelGraceTimer("max_turn_requests");
        return;
      }
      turnsUsed += 1;
      req.callbacks.onTurn?.(turnsUsed);
    };

    // Per-turn & cumulative tool-failure / read-only-denial tracking (for continuation recovery + robust circuit breaker)
    let turnFailedTools: Array<{ title: string; detail?: string }> = [];
    let turnDeniedTools: string[] = [];
    let turnSucceededTools = 0;
    const allToolFailures: string[] = [];
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

    const noteQuotaSignal = (info: { reason: string; resetAt?: string | null; isHardExhaustion?: boolean }) => {
      if (quotaWatchdogTriggered || rolloverTriggered || req.signal.aborted) return;
      quotaRetryHits += 1;
      if (info.reason) lastQuotaReason = info.reason;
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

        if (kind === "agent_message_chunk") {
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
            textSinceLastTool += content.text;
            req.callbacks.onTextDelta?.(chunk);
          }
        } else if (kind === "agent_thought_chunk") {
          advanceTurnWaveIfNeeded();
          const content = update.content as { type?: string; text?: string } | undefined;
          if (content?.type === "text" && typeof content.text === "string") {
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
          const softWarnThreshold = req.rolloverThreshold ? Math.max(0.5, req.rolloverThreshold - 0.12) : undefined;
          if (
            !rolloverWarningSent &&
            !rolloverTriggered &&
            softWarnThreshold &&
            req.rolloverThreshold &&
            ratio >= softWarnThreshold &&
            ratio < req.rolloverThreshold &&
            sessionId &&
            activeConnection &&
            (steeringSupported || isAmpProfile)
          ) {
            rolloverWarningSent = true;
            const pct = Math.round(ratio * 100);
            const limitPct = Math.round(req.rolloverThreshold * 100);
            const warnMsg =
              `Context usage is at ${pct}% (hard rollover at ${limitPct}%). Finish your current atomic step and call \`request_rollover\` with a thorough anchored handoff (goal_invariants, architectural_decisions, active_risks, next_actions) so no context is lost.`;
            if (steeringSupported) {
              void activeConnection.agent
                .request("_session/steering", { sessionId, prompt: [{ type: "text", text: warnMsg }] })
                .catch(() => {});
            } else if (isAmpProfile) {
              void activeConnection.agent
                .request("_amp/session/steer", {
                  sessionId,
                  steerId: randomUUID(),
                  prompt: [{ type: "text", text: warnMsg }],
                })
                .catch(() => {});
            }
          }

          if (
            !rolloverTriggered &&
            req.rolloverThreshold &&
            size > 0 &&
            ratio >= req.rolloverThreshold &&
            sessionId &&
            activeConnection
          ) {
            rolloverTriggered = true;
            void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
            armCancelGraceTimer("cancelled");
          }
        } else if (kind === "tool_call" || kind === "tool_call_update") {
          if (accumulatedText.length > 0) needsParagraphBreak = true;
          textSinceLastTool = "";
          const callId = update.toolCallId ? String(update.toolCallId) : update.id ? String(update.id) : undefined;
          const status = String(update.status ?? "in_progress");
          if (kind === "tool_call") {
            advanceTurnWaveIfNeeded();
            if (callId && status !== "completed" && status !== "failed") {
              inFlightToolCalls.add(callId);
            }
          } else if (callId && (status === "in_progress" || status === "pending")) {
            inFlightToolCalls.add(callId);
          }
          if (this.profile.adapter === "codex" && callId) {
            const meta = update._meta as { is_mcp_tool_call?: boolean } | undefined;
            const input = update.rawInput as { server?: string; tool?: string } | undefined;
            if (kind === "tool_call") {
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
            if (update.status === "completed" || update.status === "failed") {
              codexHarnessCalls.delete(callId);
              codexExternalCalls.delete(callId);
            }
          }
          const rawTitle = update.title ? String(update.title) : update.name ? String(update.name) : undefined;
          if (callId && rawTitle) {
            toolTitlesById.set(callId, rawTitle);
          }
          const resolvedTitle = rawTitle ?? (callId ? toolTitlesById.get(callId) : undefined) ?? "tool";
          if (status === "completed") {
            if (callId) inFlightToolCalls.delete(callId);
            resetIdleWatchdog();
            completedToolInWave = true;
            quotaRejected = false;
            textSinceQuotaRejection = "";
            disarmQuotaWatchdog(true);
            turnSucceededTools += 1;
            // Any successful tool call resets the identical-failure streak so exploratory debugging never trips the breaker
            identicalFailureStreak = 0;
            lastIdenticalFailureKey = "";
          } else if (status === "failed") {
            if (callId) inFlightToolCalls.delete(callId);
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
            if (identicalFailureStreak >= IDENTICAL_FAILURE_BREAKER && !identicalFailureBreakerTripped && sessionId && activeConnection) {
              identicalFailureBreakerTripped = true;
              void activeConnection.agent.notify("session/cancel", { sessionId }).catch(() => {});
            }
          }
          req.callbacks.onToolEvent?.({
            id: callId,
            name: resolvedTitle,
            status,
            kind: update.kind ? String(update.kind) : undefined,
            title: resolvedTitle,
            args: toolEventPreview(update.rawInput),
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
        const claudeUntrustedSource =
          claude?.mcpServer?.source === "project" ||
          claude?.mcpServer?.source === "user" ||
          claude?.mcpServer?.source === "local";
        const claudeExtParsed = claude?.toolName ? extractExternalMcp(claude.toolName) : null;
        const claudeExternalMcp =
          this.profile.adapter === "claude" &&
          claude?.mcpServer?.name !== undefined &&
          !claudeUntrustedSource &&
          externalMcpNames.has(claude.mcpServer.name) &&
          (canWrite ||
            isReadOnlyExternalMcpTool(
              claude.mcpServer.name,
              claudeExtParsed?.tool ?? claude.toolName ?? "",
            ));
        // Allow Claude's built-in ToolSearch (required to load deferred MCP tools) and harness MCP calls across
        // any non-user/project/local MCP server source (`dynamic`, `sdk`, `acp`, `inline`, etc.) and any toolKind.
        const claudeToolSearch =
          this.profile.adapter === "claude" &&
          claude?.toolName === "ToolSearch" &&
          (hasHarnessBridge || externalMcpNames.size > 0);
        const claudeHarnessMcp =
          this.profile.adapter === "claude" &&
          !claudeUntrustedSource &&
          claude?.toolName !== undefined &&
          claudeToolNames.has(claude.toolName) &&
          (claude.mcpServer === undefined || claude.mcpServer.name === "harness");

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
          for (const rawPath of paths) {
            // Strip trailing glob segment (e.g. `src/**/*.ts` -> `src`) so search globs validate cleanly inside workspace
            const cleaned = rawPath.includes("*") || rawPath.includes("?") || rawPath.includes("[")
              ? (rawPath.split(/[*?[]/)[0]?.replace(/\/+$/, "") || ".")
              : rawPath;
            try {
              await resolveAllowedTarget(workspace, extraReadRoots, cleaned, true);
            } catch {
              return false;
            }
          }
          return true;
        };

        const unwrapShellArgv = (argv: string[]): string => {
          if (argv.length >= 3) {
            const firstBin = argv[0]!.includes("/") ? argv[0]!.split("/").pop()! : argv[0]!;
            if ((firstBin === "sh" || firstBin === "bash" || firstBin === "zsh") && /^-[a-zA-Z]*c$/.test(argv[1]!)) {
              return argv[2]!;
            }
          }
          return argv.join(" ");
        };

        const extractShellCommand = (): string => {
          if (rawInput) {
            if (typeof rawInput.command === "string") return rawInput.command;
            if (typeof rawInput.cmd === "string") return rawInput.cmd;
            if (Array.isArray(rawInput.command)) return unwrapShellArgv(rawInput.command.map(String));
            if (Array.isArray(rawInput.argv)) return unwrapShellArgv(rawInput.argv.map(String));
          }
          // Strip common adapter prefixes from title like `shell_command: git status` or `Run command: rg foo`
          const stripped = title.replace(/^(?:shell_command|bash|run_command|execute|terminal)\s*:\s*/i, "").trim();
          return stripped;
        };

        const READ_ONLY_OTHER_TOOL_RE =
          /^(?:read|read_file|view_file|view_file_outline|view_code_item|list_dir|list_directory|list_files|find_by_name|find_files|glob|grep|grep_search|search|search_files|codebase_search|ast_grep|view_signatures|extract_lines)\b/i;

        const isRead = toolKind === "read" || toolKind === "search";
        const isWrite = toolKind === "edit" || toolKind === "delete" || toolKind === "move";
        const isExecute = toolKind === "execute";
        let workspaceCall = false;
        // Allow native workspace reads/searches, read-only shell inspection commands, writes (when canWrite),
        // and full shell commands (when allowShell) for non-control-plane agents.
        if (!controlOnly && !claude?.mcpServer && !p._meta?.is_mcp_tool_approval && !geminiMcp) {
          if (isRead) {
            workspaceCall = await validateReadLocations();
          } else if (canWrite && isWrite) {
            try {
              const locations = p.toolCall?.locations ?? [];
              for (const location of locations) {
                await resolveAllowedTarget(workspace, extraWriteRoots, location.path, toolKind === "edit" || toolKind === "move");
              }
              workspaceCall = locations.length > 0;
            } catch {
              workspaceCall = false;
            }
          } else if (isExecute) {
            if (allowShell) {
              workspaceCall = true;
            } else {
              const cmd = extractShellCommand();
              workspaceCall = cmd.length > 0 && isSafeReadOnlyShellCommand(cmd);
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
          turnDeniedTools.push(deniedLabel);
          allToolFailures.push(`${deniedLabel} (blocked by ${policyModeDesc})`);
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
        const file = await openWorkspaceFile(workspace, extraReadRoots, p.path, false);
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
        if (!sessionId || params.sessionId !== sessionId || !canWrite) {
          throw new Error(`Write denied: agent is running in ${policyModeDesc} mode`);
        }
        const p = params as unknown as { path: string; content: string };
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
            { name: "PI_HARNESS_TASK_ID", value: req.taskId },
          ],
        });
      }
      mcpServers.push(...externalMcpEntries);

      const { params: newSessionParams, needsTurn1SystemPrompt } = buildNewSessionParams(this.profile.adapter, {
        cwd: req.cwd,
        systemPrompt: req.systemPrompt,
        toolPolicy: req.toolPolicy,
        allowShellInReadOnly: Boolean(req.allowShellInReadOnly),
        model: req.model,
        effort: req.effort,
        mcpServers,
        agentCapabilities,
      });

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
          if (action.requiredModel) throw new Error(`Could not select model ${action.requiredModel}: ${err}`);
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
            try {
              await conn.agent.request("_session/steering", {
                sessionId,
                prompt: [{ type: "text", text: message }],
              });
              return true;
            } catch {
              return false;
            }
          }
          if (isAmpProfile) {
            try {
              await conn.agent.request("_amp/session/steer", {
                sessionId,
                steerId: randomUUID(),
                prompt: [{ type: "text", text: message }],
              });
              return true;
            } catch {
              return false;
            }
          }
          return false;
        },
        cancel: async (reason?: string) => {
          if (reason === "clean_rollover") {
            rolloverTriggered = true;
          }
          if (sessionId) {
            await conn.agent.notify("session/cancel", { sessionId }).catch(() => {});
          }
          if (reason === "clean_rollover") {
            armCancelGraceTimer("cancelled");
          }
        },
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

      for (let recoveryAttempt = 0; recoveryAttempt <= MAX_TOTAL_RECOVERY_CONTINUATIONS; recoveryAttempt++) {
        if (recoveryAttempt > 0 && req.maxTurns > 0 && turnsUsed >= req.maxTurns) {
          maxTurnsTriggered = true;
          break;
        }
        turnsUsed += 1;
        req.callbacks.onTurn?.(turnsUsed);
        completedToolInWave = false;
        inFlightToolCalls.clear();
        turnFailedTools = [];
        turnDeniedTools = [];
        turnSucceededTools = 0;
        textSinceLastTool = "";

        const promptPromise = conn.agent.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text: nextPromptText }],
        } as never) as unknown as Promise<Record<string, unknown>>;

        promptRes = await new Promise<Record<string, unknown>>((resolvePrompt, rejectPrompt) => {
          resolveActivePromptOnGrace = resolvePrompt;
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

        // Harvest passive quota & terminal sessionFailure signals
        const promptMeta = (promptRes._meta ?? {}) as Record<string, unknown>;
        const airFailure = ((promptMeta.jetbrains as Record<string, unknown> | undefined)?.air as Record<string, unknown> | undefined)
          ?.sessionFailure as Record<string, unknown> | string | undefined;
        if (airFailure) {
          const code = typeof airFailure === "string" ? airFailure : String(airFailure.code ?? airFailure.reason ?? "");
          if (code) {
            airFailureCode = code;
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
            if (!rolloverTriggered && req.rolloverThreshold && size > 0 && used / size >= req.rolloverThreshold) {
              rolloverTriggered = true;
            }
          }
        }
        const turnModels = (promptMeta.quota as { model_usage?: unknown[] } | undefined)?.model_usage;
        flushCost(Array.isArray(turnModels) ? turnModels.length : 0);

        rawStop = String(promptRes.stopReason ?? "end_turn");

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

        // Never continue if rollover, maxTurns, quota watchdog, quota rejection, user abort, or quota failure occurred
        if (
          rolloverTriggered ||
          maxTurnsTriggered ||
          rawStop === "max_turn_requests" ||
          quotaWatchdogTriggered ||
          turnQuotaFalseCompletion ||
          req.signal.aborted ||
          ["quota_exhausted", "rate_limited", "budget_exhausted"].includes(airFailureCode)
        ) {
          break;
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
        const stoppedSilentAfterTool = hadToolProblem && (textSinceLastTool.trim().length === 0 || rawStop === "cancelled");
        if (
          stoppedSilentAfterTool &&
          consecutiveSilentRecoveries < MAX_CONSECUTIVE_SILENT_RECOVERIES &&
          recoveryAttempt < MAX_TOTAL_RECOVERY_CONTINUATIONS
        ) {
          consecutiveSilentRecoveries += 1;
          const failureSummary = [
            ...turnFailedTools.map((f) => `- Tool "${f.title}" failed${f.detail ? `: ${f.detail}` : ""}`),
            ...turnDeniedTools.map((d) =>
              canWrite
                ? `- Tool "${d}" was blocked: execution permission denied by harness policy (${policyModeDesc})`
                : `- Tool "${d}" was blocked by harness policy (${policyModeDesc})`,
            ),
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
          const detail = stderrBuf.trim() ? ` (stderr: ${stderrBuf.trim().slice(-500)})` : "";
          throw new Error(`ACP runner (${this.profile.id}): ${codexMisconfig}${detail}`);
        }
      }

      const stopReason: RunAgentResult["stopReason"] = rolloverTriggered
        ? "rollover_requested"
        : maxTurnsTriggered || rawStop === "max_turn_requests"
          ? "max_turns"
          : rawStop === "cancelled" || req.signal.aborted
            ? "cancelled"
            : "completed";

      return {
        text: accumulatedText,
        stopReason,
        usage: lastUsage,
        sessionId,
        toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
      };
    } catch (err) {
      if (this.profile.adapter === "codex" && turnSucceededTools === 0) {
        const primaryMsg = (spawnErr ?? err) instanceof Error ? (spawnErr ?? err as Error).message : String(spawnErr ?? err);
        const codexMisconfig = detectCodexCodeModeMisconfig(`${primaryMsg}\n${stderrBuf}\n${allToolFailures.join("\n")}`);
        if (codexMisconfig) {
          if (primaryMsg.includes(codexMisconfig)) throw (spawnErr ?? err);
          const detail = stderrBuf.trim() ? ` (stderr: ${stderrBuf.trim().slice(-500)})` : "";
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
      if (maxTurnsTriggered) {
        return {
          text: accumulatedText,
          stopReason: "max_turns",
          usage: lastUsage,
          sessionId,
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
        };
      }
      if (idleTimedOut && !quotaWatchdogTriggered) {
        throw new Error(`ACP runner (${this.profile.id}) timed out after ${idleTimeoutMs}ms of inactivity`);
      }
      const primary = spawnErr ?? err;
      const errMsg = primary instanceof Error ? primary.message : String(primary);
      // Harvest structured `rateLimit` info from ACP JSON-RPC error data (e.g. Claude `turnErrorData` when refused before first usage)
      const errData = (primary && typeof primary === "object" ? (primary as { data?: Record<string, unknown> }).data : undefined);
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
      const detected = detectQuotaErrorText(combined);

      if (quotaWatchdogTriggered || detected.isQuota || errData?.errorKind === "rate_limit" || Boolean(errRateLimit)) {
        const reason = lastQuotaReason || detected.summary || errMsg;
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
            resetAt,
            retryCount: Math.max(1, quotaRetryHits),
            watchdogTimedOut: quotaWatchdogTriggered,
            isHardExhaustion: isHard,
          },
          toolFailures: allToolFailures.length > 0 ? allToolFailures : undefined,
        };
      }

      const detail = stderrBuf.trim() ? ` (stderr: ${stderrBuf.trim().slice(-500)})` : "";
      if (this.profile.adapter === "codex") {
        const codexMisconfig = detectCodexCodeModeMisconfig(combined);
        if (codexMisconfig) {
          if (errMsg.includes(codexMisconfig)) throw new Error(errMsg);
          throw new Error(`ACP runner (${this.profile.id}): ${codexMisconfig}${detail}`);
        }
      }
      throw new Error(`ACP runner (${this.profile.id}) failed: ${errMsg}${detail}`);
    } finally {
      flushCost();
      clearIdleWatchdog();
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
