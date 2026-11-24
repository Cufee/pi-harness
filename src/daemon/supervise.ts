import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnDaemonDetached } from "./launch.js";
import { killProcessGroups, listChildProcessGroups } from "./reap.js";
import { readReleaseAt, type ReleaseTarget } from "./release.js";
import { DaemonClient } from "./remote.js";
import { parsePositiveEnvMs, type DaemonPingInfo } from "./hot-update.js";

const DEFAULT_BOOT_TIMEOUT_MS = 20_000;
const WAIT_OLD_PID_TIMEOUT_MS = 5_000;
const LEGACY_STOP_TIMEOUT_DEFAULT_MS = 10_000;
const LEGACY_STOP_TIMEOUT_RESTART_SAFE_MS = 30_000;
const LEGACY_SIGKILL_WAIT_MS = 5_000;
const LEGACY_REAP_GRACE_MS = 2_500;

export interface SuperviseOptions {
  socketPath: string;
  target: ReleaseTarget;
  previous: ReleaseTarget | null;
  waitPid?: number;
  stopPid?: number;
  stopRestartSafe?: boolean;
  overlayRoot?: string;
  fromReleaseId?: string;
  affectedRunIds?: string[];
  bootTimeoutMs?: number;
}

function logSupervisor(msg: string): void {
  console.error(`[supervisor ${new Date().toISOString()}] ${msg}`);
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

async function probeDaemonPing(socketPath: string, timeoutMs = 1500): Promise<DaemonPingInfo | null> {
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
    return await Promise.race([
      client.request<DaemonPingInfo>("ping"),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("ping timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}

async function sendShutdownRpc(socketPath: string, timeoutMs = 2000): Promise<void> {
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
    await Promise.race([
      client.request("daemon.shutdown", { restart: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("shutdown timeout")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Pre-feature daemon may not recognize daemon.shutdown or may already be closing.
  } finally {
    if (timer) clearTimeout(timer);
    client.close();
  }
}

interface BootAttemptResult {
  ok: boolean;
  ping?: DaemonPingInfo;
  error?: string;
  childPid?: number;
  childExited: boolean;
}

async function startAndWaitForRelease(
  release: ReleaseTarget,
  socketPath: string,
  env: Record<string, string>,
  bootTimeoutMs: number,
  expectedReleaseId: string | null,
  oldPid?: number,
): Promise<BootAttemptResult> {
  let exitStatus: string | null = null;
  const child = spawnDaemonDetached(release, socketPath, env);
  child.once("exit", (code, signal) => {
    exitStatus = signal ?? String(code);
  });
  child.once("error", (err) => {
    exitStatus = err.message;
  });

  const matches = (ping: DaemonPingInfo | null): ping is DaemonPingInfo =>
    Boolean(
      ping &&
        (oldPid === undefined || ping.pid !== oldPid) &&
        (expectedReleaseId === null || ping.releaseId === expectedReleaseId),
    );

  const deadline = Date.now() + bootTimeoutMs;
  while (Date.now() < deadline) {
    const ping = await probeDaemonPing(socketPath, Math.min(1500, Math.max(200, deadline - Date.now())));
    if (matches(ping)) {
      return { ok: true, ping, childPid: child.pid, childExited: exitStatus !== null };
    }
    if (exitStatus !== null && !existsSync(socketPath)) {
      // Child exited and nothing is listening on the socket; fail fast instead of waiting out bootTimeoutMs.
      return {
        ok: false,
        error: `release ${release.releaseId} exited (${exitStatus}) before listening`,
        childPid: child.pid,
        childExited: true,
      };
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // Final check at deadline before declaring timeout.
  const finalPing = await probeDaemonPing(socketPath, 500);
  if (matches(finalPing)) {
    return { ok: true, ping: finalPing, childPid: child.pid, childExited: exitStatus !== null };
  }

  return {
    ok: false,
    error:
      exitStatus !== null
        ? `release ${release.releaseId} exited (${exitStatus}) before serving`
        : `timed out after ${bootTimeoutMs}ms waiting for release ${release.releaseId} to serve`,
    childPid: child.pid,
    childExited: exitStatus !== null,
  };
}

export function spawnSupervisorDetached(self: ReleaseTarget, o: SuperviseOptions, cwd: string): void {
  const logDir = dirname(o.socketPath);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "daemon.log");
  const logFd = openSync(logPath, "a");
  const spawnCwd = existsSync(cwd) ? cwd : logDir;
  try {
    const child = spawn(
      self.bunPath,
      [self.cliPath, "daemon", "reload", "--supervise", "--options-json", JSON.stringify(o)],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: spawnCwd,
        env: { ...process.env },
      },
    );
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

export async function runSupervisor(o: SuperviseOptions): Promise<number> {
  // Ensure process.cwd() points to an existing directory so spawnDaemonDetached inherits a valid cwd.
  let cwdValid = false;
  try {
    cwdValid = existsSync(process.cwd());
  } catch {
    cwdValid = false;
  }
  if (!cwdValid) {
    const safeDir = o.overlayRoot && existsSync(o.overlayRoot) ? o.overlayRoot : dirname(o.socketPath);
    mkdirSync(safeDir, { recursive: true });
    process.chdir(safeDir);
  }

  const targetBootTimeoutMs =
    o.bootTimeoutMs ?? parsePositiveEnvMs(process.env.PI_HARNESS_SUPERVISE_BOOT_TIMEOUT_MS) ?? DEFAULT_BOOT_TIMEOUT_MS;
  const fallbackFilePath = join(dirname(o.socketPath), "reload-fallback.txt");
  try {
    rmSync(fallbackFilePath, { force: true });
  } catch {
    // ignore
  }

  // Scrub handover env vars so spawned daemons only receive what this supervisor explicitly sets.
  delete process.env.PI_HARNESS_RELOAD_FROM;
  delete process.env.PI_HARNESS_RELOAD_FAILED;
  delete process.env.PI_HARNESS_OVERLAY_ROOT;
  delete process.env.PI_HARNESS_LEGACY_STOP_AT;

  const oldPid = o.waitPid ?? o.stopPid;
  let legacyStopAt: number | undefined;

  if (o.waitPid && o.waitPid > 0) {
    logSupervisor(`waiting up to ${WAIT_OLD_PID_TIMEOUT_MS}ms for old daemon pid ${o.waitPid} to exit`);
    const exited = await waitForPidExit(o.waitPid, WAIT_OLD_PID_TIMEOUT_MS);
    if (!exited) {
      logSupervisor(`old daemon pid ${o.waitPid} still alive after ${WAIT_OLD_PID_TIMEOUT_MS}ms; continuing handover`);
    } else {
      logSupervisor(`old daemon pid ${o.waitPid} exited`);
    }
  } else if (o.stopPid && o.stopPid > 0) {
    const recordedPgids = listChildProcessGroups(o.stopPid);
    legacyStopAt = Date.now();
    const stopTimeoutMs = o.stopRestartSafe ? LEGACY_STOP_TIMEOUT_RESTART_SAFE_MS : LEGACY_STOP_TIMEOUT_DEFAULT_MS;
    logSupervisor(
      `legacy stop: pid=${o.stopPid}, restartSafe=${Boolean(o.stopRestartSafe)}, timeout=${stopTimeoutMs}ms, recordedPgids=[${recordedPgids.join(",")}], legacyStopAt=${legacyStopAt}`,
    );

    if (isPidAlive(o.stopPid)) {
      await sendShutdownRpc(o.socketPath);
      await new Promise((r) => setTimeout(r, 150));
      if (isPidAlive(o.stopPid)) {
        try {
          process.kill(o.stopPid, "SIGTERM");
        } catch {
          // already exited
        }
      }
      const exited = await waitForPidExit(o.stopPid, stopTimeoutMs);
      if (!exited) {
        logSupervisor(`legacy stop: pid ${o.stopPid} still alive after ${stopTimeoutMs}ms; sending SIGKILL`);
        try {
          process.kill(o.stopPid, "SIGKILL");
        } catch {
          // already exited
        }
        const killedExit = await waitForPidExit(o.stopPid, LEGACY_SIGKILL_WAIT_MS);
        logSupervisor(`legacy stop: pid ${o.stopPid} after SIGKILL exited=${killedExit}`);
      } else {
        logSupervisor(`legacy stop: pid ${o.stopPid} exited`);
      }
    } else {
      logSupervisor(`legacy stop: pid ${o.stopPid} already exited`);
    }

    if (recordedPgids.length > 0) {
      const sigkilled = await killProcessGroups(recordedPgids, LEGACY_REAP_GRACE_MS);
      logSupervisor(`legacy stop: reaped ${recordedPgids.length} recorded process group(s) (sigkill=${sigkilled})`);
    }
  }

  const targetEnv: Record<string, string> = {};
  if (o.fromReleaseId) targetEnv.PI_HARNESS_RELOAD_FROM = o.fromReleaseId;
  if (o.overlayRoot) targetEnv.PI_HARNESS_OVERLAY_ROOT = o.overlayRoot;
  if (legacyStopAt !== undefined) targetEnv.PI_HARNESS_LEGACY_STOP_AT = String(legacyStopAt);

  logSupervisor(`starting target release ${o.target.releaseId} (${o.target.releaseDir}), timeout=${targetBootTimeoutMs}ms`);
  const targetAttempt = await startAndWaitForRelease(
    o.target,
    o.socketPath,
    targetEnv,
    targetBootTimeoutMs,
    o.target.releaseId,
    oldPid,
  );
  if (targetAttempt.ok) {
    logSupervisor(`target release ${o.target.releaseId} is serving (pid ${targetAttempt.ping?.pid ?? "?"})`);
    return 0;
  }

  const errorMsg = targetAttempt.error ?? `failed to start release ${o.target.releaseId}`;
  logSupervisor(`target release ${o.target.releaseId} failed to boot: ${errorMsg}`);

  if (targetAttempt.childPid && !targetAttempt.childExited) {
    await killProcessGroups([targetAttempt.childPid], 1000);
  }

  if (!o.previous) {
    logSupervisor("no previous release configured for fallback; exiting 1");
    return 1;
  }

  const prevRead = readReleaseAt(o.previous.releaseDir);
  const prev = prevRead ?? o.previous;
  const prevHasReleaseJson = prevRead !== null;
  const fallbackEnv: Record<string, string> = {
    PI_HARNESS_RELOAD_FAILED: JSON.stringify({
      targetReleaseId: o.target.releaseId,
      error: errorMsg,
    }),
  };
  if (o.overlayRoot) fallbackEnv.PI_HARNESS_OVERLAY_ROOT = o.overlayRoot;

  // Fallback always gets the default 20s boot timeout even when PI_HARNESS_SUPERVISE_BOOT_TIMEOUT_MS is set (A10).
  logSupervisor(`falling back to previous release ${prev.releaseId} (${prev.releaseDir}), timeout=${DEFAULT_BOOT_TIMEOUT_MS}ms`);
  const fallbackAttempt = await startAndWaitForRelease(
    prev,
    o.socketPath,
    fallbackEnv,
    DEFAULT_BOOT_TIMEOUT_MS,
    prevHasReleaseJson ? prev.releaseId : null,
    oldPid,
  );
  if (fallbackAttempt.ok) {
    const isPreFeatureFallback = !prevHasReleaseJson || fallbackAttempt.ping?.restartSafe !== true;
    if (isPreFeatureFallback && o.affectedRunIds && o.affectedRunIds.length > 0) {
      const resumeLines = o.affectedRunIds.map((runId) => `pi-harness resume ${runId}`);
      const content = [
        `# Fallback release (${prev.releaseId}) is not restart-safe; resume affected runs with:`,
        ...resumeLines,
        "",
      ].join("\n");
      try {
        writeFileSync(fallbackFilePath, content, "utf8");
        logSupervisor(`wrote fallback resume commands to ${fallbackFilePath}`);
      } catch (err) {
        logSupervisor(`failed to write ${fallbackFilePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
      for (const line of resumeLines) {
        logSupervisor(line);
      }
    }
    logSupervisor(`fallback release ${prev.releaseId} is serving (pid ${fallbackAttempt.ping?.pid ?? "?"}); exiting 3`);
    return 3;
  }

  if (fallbackAttempt.childPid && !fallbackAttempt.childExited) {
    await killProcessGroups([fallbackAttempt.childPid], 1000);
  }
  logSupervisor(`fallback release ${prev.releaseId} also failed to boot: ${fallbackAttempt.error ?? "unknown error"}; exiting 1`);
  return 1;
}
