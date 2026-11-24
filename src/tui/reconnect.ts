import { spawnDaemonDetached } from "../daemon/launch.js";
import { currentRelease, installedCurrent } from "../daemon/release.js";
import type { DaemonClient } from "../daemon/remote.js";
import { DAEMON_PROTOCOL_REV, type DaemonEventFrame } from "../protocol/daemon-rpc.js";

export interface ReconnectPing {
  protocolRev?: number;
  releaseId?: string;
  pid?: number;
}

export interface ReconnectStatus {
  phase: "reconnecting" | "waiting_stopped" | "restored" | "incompatible";
  attempt: number;
  message: string;
}

export interface AutoReconnectOptions {
  client: DaemonClient;
  isStopped: () => boolean;
  resync: (ping: ReconnectPing) => Promise<void>;
  onStatus: (s: ReconnectStatus) => void;
  spawnDaemon?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface AutoReconnectHandle {
  dispose(): void;
  noteDaemonEvent(ev: DaemonEventFrame): void;
  readonly offline: boolean;
  readonly expectingRestart: boolean;
}

const BACKOFF_MS = [100, 200, 400, 800, 1600, 2000] as const;
const LONG_OFFLINE_THRESHOLD_MS = 60_000;
const LONG_OFFLINE_DELAY_MS = 5000;
const DEFAULT_SPAWN_AFTER_MS = 20_000;
const RESTART_SPAWN_AFTER_MS = 30_000;
const SPAWN_REPEAT_INTERVAL_MS = 30_000;
const MAX_LIVE_RESYNC_FAILURES = 3;

function nextDelayMs(attempt: number, offlineMs: number, random: () => number): number {
  const base =
    offlineMs >= LONG_OFFLINE_THRESHOLD_MS
      ? LONG_OFFLINE_DELAY_MS
      : BACKOFF_MS[Math.min(Math.max(0, attempt - 1), BACKOFF_MS.length - 1)]!;
  // +/-20% jitter
  const jitter = 0.8 + random() * 0.4;
  return Math.max(1, Math.round(base * jitter));
}

export function installAutoReconnect(o: AutoReconnectOptions): AutoReconnectHandle {
  let disposed = false;
  let loopRunning = false;
  let offline = false;
  let expectingRestart = false;
  let explicitStop = false;
  let restartStopping = false;
  let reloadDeadlineAt: number | null = null;
  let wakeSleep: (() => void) | null = null;

  const now = o.now ?? (() => Date.now());
  const random = o.random ?? (() => Math.random());
  const sleep =
    o.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          if (wakeSleep === done) wakeSleep = null;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, ms);
        timer.unref?.();
        wakeSleep = done;
      }));

  const shouldStop = () => disposed || o.isStopped() || o.client.closedByUser;
  const canSpawnLocal = !o.client.isRemote && (Boolean(o.spawnDaemon) || Boolean(o.client.localSocketPath));
  const doSpawn =
    o.spawnDaemon ??
    (() => {
      const sock = o.client.localSocketPath;
      if (sock) spawnDaemonDetached(installedCurrent() ?? currentRelease(), sock);
    });

  const detachClose = o.client.onClose(() => {
    if (shouldStop() || loopRunning) return;
    offline = true;
    loopRunning = true;
    void runLoop();
  });

  const runLoop = async (): Promise<void> => {
    const closedAt = now();
    let nextSpawnAt = explicitStop
      ? Number.POSITIVE_INFINITY
      : restartStopping
        ? closedAt + RESTART_SPAWN_AFTER_MS
        : reloadDeadlineAt !== null
          ? Math.max(closedAt + DEFAULT_SPAWN_AFTER_MS, reloadDeadlineAt + RESTART_SPAWN_AFTER_MS)
          : closedAt + DEFAULT_SPAWN_AFTER_MS;
    let attempt = 0;
    let liveResyncFailures = 0;

    try {
      while (!shouldStop()) {
        attempt += 1;
        o.onStatus(
          explicitStop
            ? {
                phase: "waiting_stopped",
                attempt,
                message: "harnessd was stopped. Waiting for it to start · Ctrl+C quit",
              }
            : {
                phase: "reconnecting",
                attempt,
                message: `RECONNECTING to harnessd (attempt ${attempt}) · Ctrl+C quit`,
              },
        );

        const delayMs = nextDelayMs(attempt, Math.max(0, now() - closedAt), random);
        await sleep(delayMs);
        if (shouldStop()) return;

        const currentNow = now();
        if (canSpawnLocal && !explicitStop && currentNow >= nextSpawnAt) {
          nextSpawnAt = currentNow + SPAWN_REPEAT_INTERVAL_MS;
          try {
            doSpawn();
          } catch {
            // Keep reconnecting even if spawning fails.
          }
        }

        try {
          if (!o.client.connected) {
            await o.client.connect();
          }
          if (shouldStop()) return;

          const ping = await o.client.request<ReconnectPing>("ping");
          if (shouldStop()) return;

          if (ping?.protocolRev !== DAEMON_PROTOCOL_REV) {
            disposed = true;
            detachClose();
            const remoteRev = ping?.protocolRev ?? "unknown";
            o.onStatus({
              phase: "incompatible",
              attempt,
              message: `harnessd was updated to an incompatible version (protocol ${remoteRev}, this terminal speaks ${DAEMON_PROTOCOL_REV}). Start pi-harness again to continue. Your session is saved.`,
            });
            return;
          }

          try {
            await o.resync(ping);
          } catch (resyncErr) {
            if (shouldStop()) return;
            if (!o.client.connected) {
              liveResyncFailures = 0;
              continue;
            }
            liveResyncFailures += 1;
            if (liveResyncFailures >= MAX_LIVE_RESYNC_FAILURES) {
              disposed = true;
              detachClose();
              const errText = resyncErr instanceof Error ? resyncErr.message : String(resyncErr);
              o.onStatus({
                phase: "incompatible",
                attempt,
                message: errText,
              });
              return;
            }
            continue;
          }

          if (shouldStop()) return;
          offline = false;
          expectingRestart = false;
          explicitStop = false;
          restartStopping = false;
          reloadDeadlineAt = null;
          loopRunning = false;
          o.onStatus({ phase: "restored", attempt, message: "" });
          return;
        } catch {
          if (shouldStop()) return;
          if (!o.client.connected) {
            liveResyncFailures = 0;
          }
        }
      }
    } finally {
      loopRunning = false;
    }
  };

  return {
    dispose() {
      disposed = true;
      detachClose();
      wakeSleep?.();
    },
    noteDaemonEvent(ev: DaemonEventFrame) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.type === "daemon.reload") {
        const phase = typeof p.phase === "string" ? p.phase : "";
        if (phase === "draining" || phase === "restarting") {
          expectingRestart = true;
        }
        if (typeof p.deadlineAt === "number" && Number.isFinite(p.deadlineAt)) {
          reloadDeadlineAt = p.deadlineAt;
        }
      } else if (ev.type === "daemon.stopping") {
        expectingRestart = true;
        if (p.restart === false) {
          explicitStop = true;
          restartStopping = false;
        } else if (p.restart === true) {
          explicitStop = false;
          restartStopping = true;
        }
      }
    },
    get offline() {
      return offline;
    },
    get expectingRestart() {
      return expectingRestart;
    },
  };
}
