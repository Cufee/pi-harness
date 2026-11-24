import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Database } from "bun:sqlite";
import type { HotUpdateConfig } from "../config.js";
import { classifyInterruptedTasks, formatRecoveryPlan, type RecoveryPlan } from "../control-plane/restart-recovery.js";
import type { DaemonReloadParams, DaemonReloadReply, ReloadStatus } from "../protocol/daemon-rpc.js";
import { ensureLocalDaemon, stopLocalDaemon } from "./launch.js";
import { currentRelease, installedCurrent, readReleaseAt, releaseTargetForDir, type ReleaseIdentity, type ReleaseTarget } from "./release.js";
import { DaemonClient } from "./remote.js";
import { spawnSupervisorDetached } from "./supervise.js";

const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
const STOP_BUDGET_MS = 45_000;
const WAIT_SLACK_MS = 10_000;
const DRAIN_POLL_MS = 250;
const REPLY_FLUSH_MS = 25;

export interface HotUpdateHost {
  config(): HotUpdateConfig;
  startedAt: number;
  self: ReleaseIdentity;
  liveAgents(): { tier12: string[]; other: string[]; chats: string[]; reviews: number };
  liveWorkDescription(): string;
  enterDraining(): void;
  steerTask(taskId: string, text: string): Promise<unknown>;
  steerChat(chatId: string, text: string): Promise<unknown>;
  broadcast(payload: Record<string, unknown>): void;
  stopAndHandOver(target: ReleaseTarget): Promise<void>;
  log(line: string): void;
  now?: () => number;
}

function formatTier12SteerText(drainTimeoutSec: number): string {
  const sec = Math.max(1, Math.round(drainTimeoutSec));
  return `[harness:daemon-restart] The daemon restarts for an update within ${sec} seconds. Do not start new work. Workers: leave your worktree as it is. Edits and commits are preserved. Call request_rollover now. In next_actions state what is done, what is in flight including the child task IDs you wait on, and the exact next step. Pending timers stay scheduled and steer you after the restart. Do not recreate them. You resume as the same task with that handoff. If you do nothing, your session ends at the deadline and you resume from a harness-built recovery handoff.`;
}

function formatDirectorSteerText(deadlineAt: number): string {
  return `[harness:daemon-restart] The daemon restarts for an update at ${new Date(deadlineAt).toISOString()}. If you read this before that time, end your turn now. Goal, timer and message events are delivered after the restart.`;
}

function validateTarget(target: ReleaseTarget, allowCheckout: boolean): void {
  if (!target || typeof target !== "object") {
    throw new Error("Invalid reload target: expected target object.");
  }
  if (typeof target.releaseId !== "string" || !target.releaseId.trim()) {
    throw new Error("Invalid reload target: releaseId is required.");
  }
  if (typeof target.releaseDir !== "string" || !target.releaseDir.trim()) {
    throw new Error("Invalid reload target: releaseDir is required.");
  }
  if (typeof target.bunPath !== "string" || !target.bunPath.trim() || !existsSync(target.bunPath)) {
    throw new Error(`Invalid reload target: bun binary not found at ${target.bunPath}`);
  }
  if (typeof target.cliPath !== "string" || !target.cliPath.trim() || !existsSync(target.cliPath)) {
    throw new Error(`Invalid reload target: CLI entrypoint not found at ${target.cliPath}`);
  }
  const releaseJsonPath = join(target.releaseDir, "release.json");
  if (existsSync(releaseJsonPath)) {
    const parsed = readReleaseAt(target.releaseDir);
    if (!parsed) {
      throw new Error(`Invalid reload target: failed to parse ${releaseJsonPath}`);
    }
    if (parsed.releaseId !== target.releaseId) {
      throw new Error(
        `Invalid reload target: release.json id "${parsed.releaseId}" does not match target releaseId "${target.releaseId}"`,
      );
    }
  } else if (!allowCheckout) {
    throw new Error(`Invalid reload target: ${target.releaseDir} has no release.json and allowCheckout is not set.`);
  }
}

export class HotUpdateController {
  private state: "idle" | "scheduled" | "draining" = "idle";
  private target: ReleaseTarget | null = null;
  private dueAt: number | undefined;
  private deadlineAt: number | undefined;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private wakePoll: (() => void) | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly host: HotUpdateHost) {
    this.now = host.now ?? (() => Date.now());
  }

  request(p: DaemonReloadParams): DaemonReloadReply {
    if (this.disposed) {
      throw new Error("DAEMON_RELOADING: harnessd is stopping. Your request was not started.");
    }
    const target = p.target ?? installedCurrent(this.host.self);
    if (!target) {
      throw new Error("Cannot resolve installed current release; pass an explicit target.");
    }
    validateTarget(target, Boolean(p.allowCheckout));

    if (target.releaseId === this.host.self.releaseId && !p.force) {
      return { action: "noop", reason: "already_current", releaseId: this.host.self.releaseId };
    }

    if (this.state === "draining" && this.target && this.deadlineAt !== undefined) {
      return {
        action: "draining",
        targetReleaseId: this.target.releaseId,
        deadlineAt: this.deadlineAt,
        liveWork: this.host.liveWorkDescription(),
      };
    }

    const cfg = this.host.config();
    if (p.source === "install" && cfg.mode === "manual") {
      this.host.log(`reload: skipped install trigger for ${target.releaseId} (hotUpdate.mode=manual)`);
      return { action: "skipped", reason: "mode_manual" };
    }

    const liveWork = this.host.liveWorkDescription();
    const agents = this.host.liveAgents();
    const hasLiveAgents =
      agents.tier12.length > 0 || agents.other.length > 0 || agents.chats.length > 0 || agents.reviews > 0;
    const nowMs = this.now();
    const minIntervalMs = Math.max(0, cfg.minIntervalSec) * 1000;
    const computedDueAt = this.host.startedAt + minIntervalMs;

    if (p.source === "install" && !p.now && hasLiveAgents && minIntervalMs > 0 && nowMs < computedDueAt) {
      const dueAt = this.state === "scheduled" && this.dueAt !== undefined ? this.dueAt : computedDueAt;
      const coalesced = this.state === "scheduled";
      this.state = "scheduled";
      this.target = target;
      this.dueAt = dueAt;
      if (!this.scheduleTimer) {
        this.scheduleTimer = setTimeout(() => {
          this.scheduleTimer = null;
          if (this.disposed || this.state !== "scheduled" || !this.target) return;
          this.startDrain(this.target);
        }, Math.max(0, dueAt - nowMs));
        this.scheduleTimer.unref?.();
      }
      this.host.broadcast({
        phase: "scheduled",
        fromReleaseId: this.host.self.releaseId,
        toReleaseId: target.releaseId,
        dueAt,
      });
      this.host.log(
        `reload: ${coalesced ? "coalesced" : "scheduled"} ${this.host.self.releaseId} -> ${target.releaseId} for ${new Date(dueAt).toISOString()} (${liveWork})`,
      );
      return { action: "scheduled", targetReleaseId: target.releaseId, dueAt, liveWork };
    }

    const deadlineAt = this.startDrain(target);
    return { action: "draining", targetReleaseId: target.releaseId, deadlineAt, liveWork };
  }

  status(): ReloadStatus {
    return {
      state: this.state,
      ...(this.target ? { targetReleaseId: this.target.releaseId } : {}),
      ...(this.dueAt !== undefined ? { dueAt: this.dueAt } : {}),
      ...(this.deadlineAt !== undefined ? { deadlineAt: this.deadlineAt } : {}),
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    const wake = this.wakePoll;
    this.wakePoll = null;
    wake?.();
  }

  private startDrain(target: ReleaseTarget): number {
    if (this.scheduleTimer) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    const cfg = this.host.config();
    const drainTimeoutSec = cfg.drainTimeoutSec > 0 ? cfg.drainTimeoutSec : 90;
    const startedDrainAt = this.now();
    const deadlineAt = startedDrainAt + drainTimeoutSec * 1000;

    this.state = "draining";
    this.target = target;
    this.dueAt = undefined;
    this.deadlineAt = deadlineAt;

    this.host.enterDraining();
    this.host.broadcast({
      phase: "draining",
      fromReleaseId: this.host.self.releaseId,
      toReleaseId: target.releaseId,
      deadlineAt,
    });

    const initialAgents = this.host.liveAgents();
    this.host.log(
      `reload: drain started ${this.host.self.releaseId} -> ${target.releaseId} (tier12=${initialAgents.tier12.length}, chats=${initialAgents.chats.length}, other=${initialAgents.other.length}, reviews=${initialAgents.reviews}, deadline=${new Date(deadlineAt).toISOString()})`,
    );

    void this.runDrain(target, initialAgents, startedDrainAt, deadlineAt, drainTimeoutSec);
    return deadlineAt;
  }

  private sleepPoll(ms: number): Promise<void> {
    if (this.disposed || ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        if (this.wakePoll === done) this.wakePoll = null;
        if (this.pollTimer) {
          clearTimeout(this.pollTimer);
          this.pollTimer = null;
        }
        resolve();
      };
      this.wakePoll = done;
      this.pollTimer = setTimeout(done, ms);
      this.pollTimer.unref?.();
    });
  }

  private async runDrain(
    target: ReleaseTarget,
    initialAgents: { tier12: string[]; other: string[]; chats: string[]; reviews: number },
    startedDrainAt: number,
    deadlineAt: number,
    drainTimeoutSec: number,
  ): Promise<void> {
    const trackedTier12 = new Set(initialAgents.tier12);
    if (initialAgents.tier12.length > 0 || initialAgents.chats.length > 0) {
      const tier12Text = formatTier12SteerText(drainTimeoutSec);
      const directorText = formatDirectorSteerText(deadlineAt);
      await Promise.allSettled([
        ...initialAgents.tier12.map((taskId) => this.host.steerTask(taskId, tier12Text).catch(() => {})),
        ...initialAgents.chats.map((chatId) => this.host.steerChat(chatId, directorText).catch(() => {})),
      ]);

      while (!this.disposed) {
        const cur = this.host.liveAgents();
        const activeTier12 = new Set(cur.tier12);
        for (const id of [...trackedTier12]) {
          if (!activeTier12.has(id)) {
            trackedTier12.delete(id);
            this.host.log(`reload: task ${id} handed off`);
          }
        }
        if (cur.tier12.length === 0 && cur.chats.length === 0) break;
        const remaining = deadlineAt - this.now();
        if (remaining <= 0) break;
        await this.sleepPoll(Math.min(DRAIN_POLL_MS, remaining));
      }
    }

    // Give the RPC response frame a tick to flush to the caller before stop() ends client sockets.
    const elapsed = this.now() - startedDrainAt;
    if (!this.disposed && elapsed < REPLY_FLUSH_MS) {
      await this.sleepPoll(REPLY_FLUSH_MS - elapsed);
    }

    if (this.disposed) return;

    const remaining = this.host.liveAgents();
    this.host.log(
      `reload: drain finished (remaining tier12=${remaining.tier12.length}, chats=${remaining.chats.length}); restarting to ${target.releaseId}`,
    );
    this.host.broadcast({
      phase: "restarting",
      fromReleaseId: this.host.self.releaseId,
      toReleaseId: target.releaseId,
    });
    await this.host.stopAndHandOver(target);
  }
}

export interface DaemonPingInfo {
  pong?: boolean;
  pid?: number;
  protocolRev?: number;
  releaseId?: string;
  releaseDir?: string;
  lifecycle?: string;
  restartSafe?: boolean;
  running?: boolean;
  liveWork?: string;
  reload?: ReloadStatus;
}

export function parsePositiveEnvMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function probePing(socketPath: string, timeoutMs = 2000): Promise<DaemonPingInfo | null> {
  const client = new DaemonClient(socketPath);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      client.connect(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("connect timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const info = await Promise.race([
      client.request<DaemonPingInfo>("ping"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ping timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
    return info;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isPidAlive(pid);
}

export function formatLegacyBootstrapNotice(info: DaemonPingInfo, targetReleaseId: string): string {
  const workLabel = info.liveWork || (info.running === false ? "idle" : "active work");
  return [
    `harnessd (pid ${info.pid ?? "?"}, ${workLabel}) does not support hot update and was not restarted.`,
    `Release ${targetReleaseId} is installed and is used on the next daemon start.`,
    `To restart it now and resume its work in place, run from a terminal (not from an agent):`,
    `  pi-harness daemon recover --dry-run`,
    `  pi-harness daemon reload --legacy`,
  ].join("\n");
}

function resolveFallbackFromProc(pid: number): ReleaseTarget | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`);
    const argv = raw
      .toString("utf8")
      .split("\0")
      .filter((s) => s.length > 0);
    if (argv.length < 2) return null;
    const argv0 = argv[0]!;
    const argv1 = argv[1]!;
    const resolvedArgv1 = isAbsolute(argv1)
      ? argv1
      : (() => {
          const procCwd = resolveCwdFromProc(pid);
          return procCwd ? resolve(procCwd, argv1) : null;
        })();
    if (!resolvedArgv1 || (!resolvedArgv1.endsWith("/src/cli.ts") && !resolvedArgv1.endsWith("\\src\\cli.ts"))) return null;
    const dir = resolve(dirname(resolvedArgv1), "..");
    if (!existsSync(join(dir, "src", "cli.ts"))) return null;
    const base = releaseTargetForDir(dir);
    const bunCandidate = join(base.releaseDir, ".bun");
    if (!existsSync(bunCandidate) && argv0 && existsSync(argv0)) {
      return { ...base, bunPath: argv0 };
    }
    return base;
  } catch {
    return null;
  }
}

function resolveCwdFromProc(pid: number): string | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const cwd = realpathSync(`/proc/${pid}/cwd`);
    return existsSync(cwd) ? cwd : null;
  } catch {
    return null;
  }
}

async function printFallbackFileIfPresent(socketPath: string, waitForFile: boolean): Promise<void> {
  const fallbackFilePath = join(dirname(socketPath), "reload-fallback.txt");
  if (waitForFile && !existsSync(fallbackFilePath)) {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && !existsSync(fallbackFilePath)) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  if (!existsSync(fallbackFilePath)) return;
  try {
    const text = readFileSync(fallbackFilePath, "utf8").trim();
    if (text) console.error(text);
  } catch {
    // ignore read error
  }
}

export async function waitForDaemonReload(opts: {
  socketPath: string;
  targetReleaseId: string;
  oldPid?: number;
  deadlineAt: number;
  legacy?: boolean;
  expectFallbackFile?: boolean;
  hasAffectedRuns?: boolean;
}): Promise<number> {
  const bootTimeoutMs = parsePositiveEnvMs(process.env.PI_HARNESS_SUPERVISE_BOOT_TIMEOUT_MS) ?? DEFAULT_BOOT_TIMEOUT_MS;
  const waitDeadline = opts.deadlineAt + STOP_BUDGET_MS + bootTimeoutMs + DEFAULT_BOOT_TIMEOUT_MS + WAIT_SLACK_MS;

  while (Date.now() < waitDeadline) {
    await new Promise((r) => setTimeout(r, 150));
    const ping = await probePing(opts.socketPath, 2000);
    if (!ping) continue;
    if (opts.oldPid !== undefined && ping.pid === opts.oldPid) continue;
    if (ping.releaseId === opts.targetReleaseId) {
      console.log(`reloaded harnessd to release ${ping.releaseId} (pid ${ping.pid ?? "?"}).`);
      return 0;
    }
    const waitForFallbackFile =
      Boolean(opts.expectFallbackFile) || (Boolean(opts.hasAffectedRuns) && ping.restartSafe !== true);
    if (ping.reload?.lastError?.targetReleaseId === opts.targetReleaseId) {
      console.error(
        `reload failed: harnessd could not start release ${opts.targetReleaseId} (${ping.reload.lastError.error}) and is back on release ${ping.releaseId ?? "unknown"} (pid ${ping.pid ?? "?"}).`,
      );
      await printFallbackFileIfPresent(opts.socketPath, waitForFallbackFile);
      return 3;
    }
    if (opts.legacy) {
      console.error(
        `reload failed: harnessd could not start release ${opts.targetReleaseId} and is back on release ${ping.releaseId ?? "pre-feature"} (pid ${ping.pid ?? "?"}).`,
      );
      await printFallbackFileIfPresent(opts.socketPath, waitForFallbackFile);
      return 3;
    }
  }

  console.error(`Timed out waiting for harnessd to reload to release ${opts.targetReleaseId}.`);
  return 4;
}

export interface DaemonReloadCliOptions {
  socketPath: string;
  stateDir?: string;
  targetDir?: string;
  previousDir?: string;
  dbPath?: string;
  explicitTarget?: ReleaseTarget;
  allowCheckout?: boolean;
  legacy?: boolean;
  yes?: boolean;
  fromInstall?: boolean;
  now?: boolean;
  wait?: boolean;
  force?: boolean;
}

async function promptLegacyConfirmation(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question("Restart harnessd now? [y/N] ")).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } catch {
    return false;
  } finally {
    rl.close();
  }
}

async function runLegacyReloadCli(params: {
  opts: DaemonReloadCliOptions;
  self: ReleaseIdentity;
  target: ReleaseTarget;
  allowCheckout: boolean;
  info: DaemonPingInfo;
}): Promise<number> {
  const { opts, self, target, allowCheckout, info } = params;

  if (info.reload !== undefined) {
    console.error("This daemon supports hot update. Run pi-harness daemon reload.");
    return 1;
  }

  try {
    validateTarget(target, allowCheckout);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (typeof info.pid !== "number" || !Number.isInteger(info.pid) || info.pid <= 0) {
    console.error("Running harnessd did not report a valid PID; cannot run legacy reload.");
    return 1;
  }

  // Step 1: read-only dry run against SQLite (same classification as `daemon recover --dry-run`).
  const rawDb = opts.dbPath?.trim() ?? "";
  const dbPath = rawDb
    ? resolve(rawDb === "~" || rawDb.startsWith("~/") ? join(homedir(), rawDb.slice(1)) : rawDb)
    : join(opts.stateDir ?? dirname(opts.socketPath), "control-plane.sqlite");

  let plan: RecoveryPlan;
  try {
    if (!existsSync(dbPath)) {
      throw new Error(`Database not found: ${dbPath}`);
    }
    const raw = new Database(dbPath, { readonly: true });
    try {
      plan = classifyInterruptedTasks(raw);
    } finally {
      raw.close();
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`dry run failed: ${msg}. Nothing was changed.`);
    return 1;
  }
  console.log(formatRecoveryPlan(plan));

  // Step 2: resolve fallback release (--previous, else ping.releaseDir, else /proc/<pid>/cmdline, else none).
  let previous: ReleaseTarget | null = null;
  if (opts.previousDir) {
    const prevDir = resolve(opts.previousDir);
    if (!existsSync(prevDir)) {
      console.error(`Invalid --previous directory: ${prevDir} does not exist.`);
      return 1;
    }
    previous = releaseTargetForDir(prevDir);
    if (!existsSync(previous.cliPath)) {
      console.error(`Invalid --previous directory: CLI entrypoint not found at ${previous.cliPath}`);
      return 1;
    }
    if (!existsSync(previous.bunPath)) {
      console.error(`Invalid --previous directory: bun binary not found at ${previous.bunPath}`);
      return 1;
    }
  } else if (info.releaseDir && existsSync(join(info.releaseDir, "src", "cli.ts"))) {
    previous = releaseTargetForDir(info.releaseDir);
  } else {
    previous = resolveFallbackFromProc(info.pid);
  }

  const affectedRunIds = [...new Set(plan.relaunch.map((t) => t.runId))];
  const runningReleaseLabel = info.releaseId
    ? `${info.releaseId}${info.releaseDir ? ` (${info.releaseDir})` : ""}`
    : "pre-feature";
  const fallbackLabel = previous ? `${previous.releaseId} (${previous.releaseDir})` : "no fallback release found";
  const restartSafeLabel = info.restartSafe === true ? "yes" : "no";

  console.log(
    [
      "",
      "Legacy reload plan:",
      `  Running daemon: pid ${info.pid}, release ${runningReleaseLabel}, restart-safe: ${restartSafeLabel}`,
      `  Target release: ${target.releaseId} (${target.releaseDir})`,
      `  Fallback release: ${fallbackLabel}`,
      `  Affected runs: ${affectedRunIds.length > 0 ? affectedRunIds.join(", ") : "none"}`,
      "",
      "Not preserved on first activation against a pre-feature daemon:",
      "  - Attached old-release TUIs exit.",
      "  - An in-flight Director turn is aborted and its unflushed tail is lost (no tool list or continuation turn).",
      "  - Queued Director wakeups are lost.",
      "  - Agents write no rollover handoffs; interrupted tasks resume from harness-built recovery handoffs.",
      "  - In-flight merges, Done-Reviews, and verification gates run again.",
      "  - Active PTYs, code_exec scripts, and in-memory quota --in timers are lost.",
      "  - wait_timer rows cancelled by the old daemon during shutdown are revived to pending by the new daemon.",
    ].join("\n"),
  );

  // Step 3: confirmation (TTY prompt or --yes; non-TTY without --yes exits 2).
  if (!opts.yes) {
    if (!process.stdin.isTTY) {
      console.error("Not confirmed. Pass --yes to run without a prompt.");
      return 2;
    }
    const confirmed = await promptLegacyConfirmation();
    if (!confirmed) {
      console.error("Not confirmed. Nothing was changed.");
      return 2;
    }
  }

  // Step 4: hand off to the detached supervisor.
  let cwd = dirname(opts.socketPath);
  const procCwd = resolveCwdFromProc(info.pid);
  if (procCwd) {
    cwd = procCwd;
  } else {
    try {
      const curCwd = process.cwd();
      if (existsSync(curCwd)) cwd = curCwd;
    } catch {
      // keep socket dir fallback
    }
  }

  spawnSupervisorDetached(
    self,
    {
      socketPath: opts.socketPath,
      target,
      previous,
      stopPid: info.pid,
      stopRestartSafe: info.restartSafe === true,
      ...(info.releaseId ? { fromReleaseId: info.releaseId } : {}),
      ...(affectedRunIds.length > 0 ? { affectedRunIds } : {}),
    },
    cwd,
  );

  const logPath = join(dirname(opts.socketPath), "daemon.log");
  console.log(`restart handed to supervisor, see ${logPath}`);

  if (!opts.wait) return 0;

  const expectFallbackFile = Boolean(
    previous && affectedRunIds.length > 0 && (readReleaseAt(previous.releaseDir) === null || info.restartSafe !== true),
  );
  return await waitForDaemonReload({
    socketPath: opts.socketPath,
    targetReleaseId: target.releaseId,
    oldPid: info.pid,
    deadlineAt: Date.now(),
    legacy: true,
    expectFallbackFile,
    hasAffectedRuns: affectedRunIds.length > 0,
  });
}

export async function runDaemonReloadCli(opts: DaemonReloadCliOptions): Promise<number> {
  const self = currentRelease();
  let target: ReleaseTarget;
  let allowCheckout: boolean;

  if (opts.explicitTarget) {
    target = opts.explicitTarget;
    allowCheckout = Boolean(opts.allowCheckout);
  } else if (opts.targetDir) {
    target = releaseTargetForDir(resolve(opts.targetDir));
    allowCheckout = true;
  } else {
    const cur = installedCurrent(self);
    if (!cur) {
      if (self.kind === "checkout") {
        console.error(
          "This CLI runs from a source checkout. Pass --target <release or checkout dir>, or run the installed pi-harness.",
        );
      } else {
        console.error("No installed current release found. Pass --target <release dir>.");
      }
      return 1;
    }
    target = cur;
    allowCheckout = false;
  }

  const client = new DaemonClient(opts.socketPath);
  try {
    await client.connect();
  } catch {
    client.close();
    console.log(`harnessd is not running. Release ${target.releaseId} is used on next start.`);
    return 0;
  }

  let info: DaemonPingInfo;
  let reply: DaemonReloadReply;
  try {
    info = await client.request<DaemonPingInfo>("ping");
    if (opts.legacy) {
      // Close the probe socket before running dry-run / prompt / supervisor stop.
      client.close();
      return await runLegacyReloadCli({ opts, self, target, allowCheckout, info });
    }
    if (info.releaseId === target.releaseId && !opts.force) {
      console.log(`already running release ${target.releaseId}`);
      return 0;
    }
    if (info.reload === undefined) {
      console.log(formatLegacyBootstrapNotice(info, target.releaseId));
      return 0;
    }
    const source: "install" | "cli" = opts.fromInstall ? "install" : "cli";
    const params: DaemonReloadParams = {
      target,
      allowCheckout,
      source,
      ...(opts.now ? { now: true } : {}),
      ...(opts.force ? { force: true } : {}),
    };
    reply = await client.request<DaemonReloadReply>("daemon.reload", params as unknown as Record<string, unknown>);
  } finally {
    client.close();
  }

  switch (reply.action) {
    case "noop":
      console.log(`already running release ${reply.releaseId}`);
      return 0;
    case "skipped":
      console.log(`reload skipped (${reply.reason}). Run "pi-harness daemon reload" to apply manually.`);
      return 0;
    case "scheduled":
      console.log(
        `reload scheduled for ${new Date(reply.dueAt).toISOString()} (rate limit). Run "pi-harness daemon reload" to apply now.`,
      );
      return 0;
    case "draining": {
      const drainSec = Math.max(1, Math.round((reply.deadlineAt - Date.now()) / 1000));
      console.log(
        `reload: harnessd pid ${info.pid ?? "?"} release ${info.releaseId ?? "unknown"} -> ${reply.targetReleaseId}, draining up to ${drainSec}s (${reply.liveWork || "idle"})`,
      );
      if (!opts.wait) return 0;
      return await waitForDaemonReload({
        socketPath: opts.socketPath,
        targetReleaseId: reply.targetReleaseId,
        oldPid: info.pid,
        deadlineAt: reply.deadlineAt,
      });
    }
  }
}

/**
 * Handles `pi-harness daemon restart` against a running local daemon:
 * - With `ping.reload`: immediate forced reload with `--wait`.
 * - Without `ping.reload` and busy (`running !== false`): prints the legacy notice and returns 1 without stopping.
 * - Without `ping.reload` and idle (`running === false`): stops, waits for the old PID to exit, spawns and verifies a new PID.
 * Returns `null` when no daemon is currently listening so the caller can start a fresh one.
 */
export async function tryReloadForDaemonRestart(socketPath: string): Promise<number | null> {
  const ping = await probePing(socketPath, 2000);
  if (!ping) return null;
  const self = currentRelease();
  const target = installedCurrent(self) ?? self;
  if (ping.reload !== undefined) {
    return await runDaemonReloadCli({
      socketPath,
      explicitTarget: target,
      allowCheckout: true,
      now: true,
      force: true,
      wait: true,
    });
  }
  if (ping.running !== false) {
    console.log(formatLegacyBootstrapNotice(ping, target.releaseId));
    return 1;
  }
  const oldPid = typeof ping.pid === "number" && ping.pid > 0 ? ping.pid : undefined;
  await stopLocalDaemon(socketPath);
  if (oldPid !== undefined) {
    const exitTimeoutMs = ping.restartSafe ? 30_000 : 10_000;
    const exited = await waitForPidExit(oldPid, exitTimeoutMs);
    if (!exited) {
      console.error(`Timed out waiting for old harnessd (pid ${oldPid}) to exit; not restarting.`);
      return 1;
    }
  }
  const c = await ensureLocalDaemon(socketPath);
  try {
    const after = await c.request<DaemonPingInfo>("ping");
    if (oldPid !== undefined && after.pid === oldPid) {
      console.error(`Old harnessd (pid ${oldPid}) is still serving after stop; restart failed.`);
      return 1;
    }
  } finally {
    c.close();
  }
  console.log("Restarted harnessd.");
  return 0;
}
