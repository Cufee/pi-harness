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
  remoteHost?: string | null;
  isStopped: () => boolean;
  resync: (ping: ReconnectPing) => Promise<void>;
  onStatus: (s: ReconnectStatus) => void;
  spawnDaemon?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  pingTimeoutMs?: number;
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
const DEFAULT_PING_TIMEOUT_MS = 5_000;

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
  let closeEpoch = 0;
  let wakeSleep: (() => void) | null = null;

  const now = o.now ?? (() => Date.now());
  const random = o.random ?? (() => Math.random());
  const pingTimeoutMs = o.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
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

  const emitRemoteStopped = (attempt: number) => {
    disposed = true;
    offline = true;
    detachClose();
    const hostLabel = o.remoteHost || o.client.remoteHost || "remote host";
    o.onStatus({
      phase: "incompatible",
      attempt,
      message: `harnessd on ${hostLabel} was stopped. Start pi-harness again to reconnect.`,
    });
  };

  const captureConnEpoch = () => ({
    closeEpoch,
    clientEpoch: o.client.connectionEpoch ?? 0,
  });

  const isSameConnection = (snap: { closeEpoch: number; clientEpoch: number }) =>
    o.client.connected && closeEpoch === snap.closeEpoch && (o.client.connectionEpoch ?? 0) === snap.clientEpoch;

  const pingWithTimeout = async (): Promise<ReconnectPing> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        o.client.request<ReconnectPing>("ping"),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Reconnect ping timed out")), pingTimeoutMs);
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === "Reconnect ping timed out" && o.client.connected) {
        o.client.disconnect?.();
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const detachClose = o.client.onClose(() => {
    closeEpoch += 1;
    if (shouldStop()) return;
    // Remote SSH bridges auto-start the remote daemon on connect(), so an explicit stop must exit instead of reconnecting.
    if (explicitStop && o.client.isRemote) {
      emitRemoteStopped(0);
      return;
    }
    if (loopRunning) return;
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
        if (explicitStop && o.client.isRemote) {
          emitRemoteStopped(attempt);
          return;
        }
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
        if (explicitStop && o.client.isRemote) {
          emitRemoteStopped(attempt);
          return;
        }

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
          if (shouldStop()) {
            if (o.client.connected) o.client.disconnect?.();
            return;
          }

          const connSnap = captureConnEpoch();
          const ping = await pingWithTimeout();
          if (shouldStop()) return;
          if (!isSameConnection(connSnap)) {
            liveResyncFailures = 0;
            continue;
          }

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
            if (!isSameConnection(connSnap)) {
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
          if (!isSameConnection(connSnap)) {
            liveResyncFailures = 0;
            continue;
          }

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
