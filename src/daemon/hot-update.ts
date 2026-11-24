import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HotUpdateConfig } from "../config.js";
import type { DaemonReloadParams, DaemonReloadReply, ReloadStatus } from "../protocol/daemon-rpc.js";
import { currentRelease, installedCurrent, readReleaseAt, releaseTargetForDir, type ReleaseIdentity, type ReleaseTarget } from "./release.js";
import { DaemonClient } from "./remote.js";

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

export async function waitForDaemonReload(opts: {
  socketPath: string;
  targetReleaseId: string;
  oldPid?: number;
  deadlineAt: number;
}): Promise<number> {
  const bootTimeoutMs = parsePositiveEnvMs(process.env.PI_HARNESS_SUPERVISE_BOOT_TIMEOUT_MS) ?? DEFAULT_BOOT_TIMEOUT_MS;
  const waitDeadline = opts.deadlineAt + STOP_BUDGET_MS + 2 * bootTimeoutMs + WAIT_SLACK_MS;

  while (Date.now() < waitDeadline) {
    await new Promise((r) => setTimeout(r, 150));
    const ping = await probePing(opts.socketPath, 2000);
    if (!ping) continue;
    if (opts.oldPid !== undefined && ping.pid === opts.oldPid) continue;
    if (ping.reload?.lastError?.targetReleaseId === opts.targetReleaseId) {
      console.error(
        `reload failed: harnessd could not start release ${opts.targetReleaseId} (${ping.reload.lastError.error}) and is back on release ${ping.releaseId ?? "unknown"} (pid ${ping.pid ?? "?"}).`,
      );
      return 3;
    }
    if (ping.releaseId === opts.targetReleaseId) {
      console.log(`reloaded harnessd to release ${ping.releaseId} (pid ${ping.pid ?? "?"}).`);
      return 0;
    }
  }

  console.error(`Timed out waiting for harnessd to reload to release ${opts.targetReleaseId}.`);
  return 4;
}

export interface DaemonReloadCliOptions {
  socketPath: string;
  targetDir?: string;
  explicitTarget?: ReleaseTarget;
  allowCheckout?: boolean;
  fromInstall?: boolean;
  now?: boolean;
  wait?: boolean;
  force?: boolean;
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
    if (info.releaseId === target.releaseId && !opts.force) {
      console.log(`already running release ${target.releaseId}`);
      return 0;
    }
    // Seam for slice 4a-2: --legacy path plugs in here before the no-reload notice.
    if (info.reload === undefined) {
      console.log(
        [
          `harnessd (pid ${info.pid ?? "?"}, ${info.liveWork || "idle"}) does not support hot update and was not restarted.`,
          `Release ${target.releaseId} is installed and is used on the next daemon start.`,
          `To restart it now and resume its work in place, run from a terminal (not from an agent):`,
          `  pi-harness daemon recover --dry-run`,
          `  pi-harness daemon reload --legacy`,
        ].join("\n"),
      );
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
 * If a local daemon with `ping.reload` is listening, runs an immediate forced reload with `--wait`
 * and returns its exit code. Returns `null` when no daemon is running or it lacks `ping.reload`,
 * so `daemon restart` falls back to `stopLocalDaemon` + `ensureLocalDaemon`.
 */
export async function tryReloadForDaemonRestart(socketPath: string): Promise<number | null> {
  const ping = await probePing(socketPath, 2000);
  if (!ping || ping.reload === undefined) return null;
  const self = currentRelease();
  const target = installedCurrent(self) ?? self;
  return await runDaemonReloadCli({
    socketPath,
    explicitTarget: target,
    allowCheckout: true,
    now: true,
    force: true,
    wait: true,
  });
}
