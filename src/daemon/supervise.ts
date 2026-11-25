import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readRetentionLogMaxBytes, rotateLogIfOversized } from "../install/maintenance.js";
import { prepareDaemonLogForSpawn, readDaemonLogTail, spawnDaemonDetached } from "./launch.js";
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
  stateDir?: string;
  target: ReleaseTarget;
  previous: ReleaseTarget | null;
  previousRestartSafe?: boolean;
  waitPid?: number;
  stopPid?: number;
  stopPidStartTime?: string;
  stopRestartSafe?: boolean;
  childPgids?: number[];
  overlayRoot?: string;
  fromReleaseId?: string;
  affectedRunIds?: string[];
  bootTimeoutMs?: number;
}

export function readProcStartTime(pid: number): string | null {
  if (process.platform !== "linux" || !Number.isInteger(pid) || pid <= 0) return null;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rparen = raw.lastIndexOf(")");
    if (rparen === -1) return null;
    const fields = raw.slice(rparen + 2).trim().split(/\s+/);
    const startTime = fields[19];
    return startTime && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatServeCommand(rel: ReleaseTarget, stateDir: string | undefined, socketPath: string, includeSocketEnv: boolean): string {
  const envParts: string[] = [];
  if (stateDir) {
    envParts.push(`PI_HARNESS_HOME=${shellQuote(stateDir)}`);
  }
  if (includeSocketEnv && (!stateDir || socketPath !== join(stateDir, "daemon.sock"))) {
    envParts.push(`PI_HARNESS_SOCKET_PATH=${shellQuote(socketPath)}`);
  }
  const cmd = `${shellQuote(rel.bunPath)} ${shellQuote(rel.cliPath)} daemon serve`;
  return envParts.length > 0 ? `${envParts.join(" ")} ${cmd}` : cmd;
}

function writeFallbackFileAtomically(fallbackFilePath: string, content: string): void {
  const tmpPath = `${fallbackFilePath}.tmp.${process.pid}`;
  try {
    mkdirSync(dirname(fallbackFilePath), { recursive: true });
    writeFileSync(tmpPath, content, "utf8");
    renameSync(tmpPath, fallbackFilePath);
  } catch {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore
    }
    try {
      writeFileSync(fallbackFilePath, content, "utf8");
    } catch (err) {
      logSupervisor(`failed to write ${fallbackFilePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function logAndWriteFallback(fallbackFilePath: string, lines: string[]): void {
  const content = `${lines.join("\n")}\n`;
  writeFallbackFileAtomically(fallbackFilePath, content);
  logSupervisor(`wrote recovery instructions to ${fallbackFilePath}`);
  for (const line of lines) {
    logSupervisor(line);
  }
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
  rotateLogIfOversized(logPath, readRetentionLogMaxBytes(o.stateDir));
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
  const logPath = join(dirname(o.socketPath), "daemon.log");
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
  delete process.env.PI_HARNESS_SOCKET_PATH;

  const oldPid = o.waitPid ?? o.stopPid;
  const oldPidTag = oldPid !== undefined ? String(oldPid) : "none";
  let legacyStopAt: number | undefined;

  const abortReload = (reason: string): number => {
    logAndWriteFallback(fallbackFilePath, [
      `# Reload aborted (exit 1): target=${o.target.releaseId} oldPid=${oldPidTag}`,
      reason,
      "No successor daemon was started.",
    ]);
    return 1;
  };

  if (o.waitPid && o.waitPid > 0) {
    const pgidsToReap = new Set<number>(o.childPgids ?? []);
    logSupervisor(`waiting up to ${WAIT_OLD_PID_TIMEOUT_MS}ms for old daemon pid ${o.waitPid} to exit`);
    let exited = await waitForPidExit(o.waitPid, WAIT_OLD_PID_TIMEOUT_MS);
    if (!exited) {
      for (const pgid of listChildProcessGroups(o.waitPid)) {
        pgidsToReap.add(pgid);
      }
      logSupervisor(`old daemon pid ${o.waitPid} still alive after ${WAIT_OLD_PID_TIMEOUT_MS}ms; sending SIGKILL`);
      try {
        process.kill(o.waitPid, "SIGKILL");
      } catch {
        // already exited
      }
      exited = await waitForPidExit(o.waitPid, LEGACY_SIGKILL_WAIT_MS);
      if (!exited) {
        return abortReload(
          `Old daemon pid ${o.waitPid} survived the wait (${WAIT_OLD_PID_TIMEOUT_MS}ms) and SIGKILL grace (${LEGACY_SIGKILL_WAIT_MS}ms).`,
        );
      }
      logSupervisor(`old daemon pid ${o.waitPid} exited after SIGKILL`);
    } else {
      logSupervisor(`old daemon pid ${o.waitPid} exited`);
    }
    if (pgidsToReap.size > 0) {
      const sigkilled = await killProcessGroups([...pgidsToReap], LEGACY_REAP_GRACE_MS);
      logSupervisor(`handover reap: checked ${pgidsToReap.size} captured process group(s) (sigkill=${sigkilled})`);
    }
  } else if (o.stopPid && o.stopPid > 0) {
    const startTimeMatches = (): boolean => {
      if (!o.stopPidStartTime) return true;
      const cur = readProcStartTime(o.stopPid!);
      return cur === null || cur === o.stopPidStartTime;
    };

    const preStopPing = await probeDaemonPing(o.socketPath, 1500);
    if (preStopPing !== null) {
      if (preStopPing.pid !== o.stopPid) {
        return abortReload(
          `Legacy stop refused: socket ${o.socketPath} is served by pid ${preStopPing.pid ?? "unknown"}, expected ${o.stopPid}. Nothing was stopped.`,
        );
      }
      if (preStopPing.reload !== undefined) {
        return abortReload(
          `Legacy stop refused: daemon pid ${o.stopPid} on ${o.socketPath} now reports hot-update support. Nothing was stopped.`,
        );
      }
    }

    if (isPidAlive(o.stopPid) && !startTimeMatches()) {
      return abortReload(
        `Legacy stop refused: pid ${o.stopPid} start time no longer matches the previewed daemon. Nothing was stopped.`,
      );
    }

    const pgidsToReap = new Set<number>(o.childPgids ?? []);
    if (isPidAlive(o.stopPid)) {
      for (const pgid of listChildProcessGroups(o.stopPid)) {
        pgidsToReap.add(pgid);
      }
    }
    const recordedPgids = [...pgidsToReap];
    legacyStopAt = Date.now();
    const stopTimeoutMs = o.stopRestartSafe ? LEGACY_STOP_TIMEOUT_RESTART_SAFE_MS : LEGACY_STOP_TIMEOUT_DEFAULT_MS;
    logSupervisor(
      `legacy stop: pid=${o.stopPid}, restartSafe=${Boolean(o.stopRestartSafe)}, timeout=${stopTimeoutMs}ms, recordedPgids=[${recordedPgids.join(",")}], legacyStopAt=${legacyStopAt}`,
    );

    if (isPidAlive(o.stopPid)) {
      if (preStopPing !== null) {
        await sendShutdownRpc(o.socketPath);
        await new Promise((r) => setTimeout(r, 150));
      }
      if (isPidAlive(o.stopPid)) {
        if (!startTimeMatches()) {
          return abortReload(
            `Legacy stop refused: pid ${o.stopPid} identity changed before SIGTERM. Nothing else was signalled.`,
          );
        }
        try {
          process.kill(o.stopPid, "SIGTERM");
        } catch {
          // already exited
        }
      }
      const exited = await waitForPidExit(o.stopPid, stopTimeoutMs);
      if (!exited) {
        logSupervisor(`legacy stop: pid ${o.stopPid} still alive after ${stopTimeoutMs}ms; sending SIGKILL`);
        if (!startTimeMatches()) {
          return abortReload(
            `Legacy stop refused: pid ${o.stopPid} identity changed before SIGKILL. No successor was started.`,
          );
        }
        try {
          process.kill(o.stopPid, "SIGKILL");
        } catch {
          // already exited
        }
        const killedExit = await waitForPidExit(o.stopPid, LEGACY_SIGKILL_WAIT_MS);
        logSupervisor(`legacy stop: pid ${o.stopPid} after SIGKILL exited=${killedExit}`);
        if (!killedExit) {
          return abortReload(
            `Old daemon pid ${o.stopPid} survived stop timeout (${stopTimeoutMs}ms) and SIGKILL grace (${LEGACY_SIGKILL_WAIT_MS}ms).`,
          );
        }
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

  // Never start a successor while the old daemon process is still alive.
  if (oldPid && oldPid > 0 && isPidAlive(oldPid)) {
    return abortReload(`Old daemon pid ${oldPid} is still alive before target start.`);
  }

  const targetEnv: Record<string, string> = {
    PI_HARNESS_SOCKET_PATH: o.socketPath,
  };
  if (o.stateDir) targetEnv.PI_HARNESS_HOME = o.stateDir;
  if (o.fromReleaseId) targetEnv.PI_HARNESS_RELOAD_FROM = o.fromReleaseId;
  if (o.overlayRoot) targetEnv.PI_HARNESS_OVERLAY_ROOT = o.overlayRoot;
  if (legacyStopAt !== undefined) targetEnv.PI_HARNESS_LEGACY_STOP_AT = String(legacyStopAt);

  logSupervisor(`starting target release ${o.target.releaseId} (${o.target.releaseDir}), timeout=${targetBootTimeoutMs}ms`);
  const targetLogStart = prepareDaemonLogForSpawn(logPath, o.stateDir);
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
  const bootLogTail = readDaemonLogTail(logPath, targetLogStart, 2000);
  logSupervisor(`target release ${o.target.releaseId} failed to boot: ${errorMsg}`);

  if (targetAttempt.childPid && (!targetAttempt.childExited || isPidAlive(targetAttempt.childPid))) {
    await killProcessGroups([targetAttempt.childPid], 1000);
    if (isPidAlive(targetAttempt.childPid)) {
      try {
        process.kill(targetAttempt.childPid, "SIGKILL");
      } catch {
        // already dead
      }
      await waitForPidExit(targetAttempt.childPid, 2000);
    }
  }

  const prevRead = o.previous ? readReleaseAt(o.previous.releaseDir) : null;
  const prev = prevRead ?? o.previous;
  const prevHasReleaseJson = prevRead !== null;
  const fallbackIsRestartSafe = Boolean(
    prev &&
      (o.previousRestartSafe === true ||
        (o.previousRestartSafe === undefined && prevHasReleaseJson && o.stopRestartSafe !== false)),
  );

  if (!prev || !fallbackIsRestartSafe) {
    const lines: string[] = [
      `# Reload failed (exit 3): target=${o.target.releaseId} oldPid=${oldPidTag}`,
      `Target release ${o.target.releaseId} (${o.target.releaseDir}) failed to boot: ${errorMsg}`,
      prev
        ? `No daemon was started because the only fallback release (${prev.releaseId}, ${prev.releaseDir}) is not restart-safe (starting it automatically would mark interrupted tasks failed).`
        : "No daemon was started because no fallback release was found.",
      "",
      "All work is intact in the database and will resume in place when a hot-update-capable release starts.",
    ];
    if (bootLogTail) {
      lines.push("", "Boot error log tail:", bootLogTail);
    }
    lines.push(
      "",
      "After fixing the target release, start it with:",
      `  ${formatServeCommand(o.target, o.stateDir, o.socketPath, true)}`,
    );
    if (prev) {
      lines.push(
        "",
        "LAST RESORT (WARNING: starting this pre-feature release marks every interrupted task failed and releases its leases):",
        `  ${formatServeCommand(prev, o.stateDir, o.socketPath, false)}`,
      );
      if (o.affectedRunIds && o.affectedRunIds.length > 0) {
        lines.push("Then resume every affected run with:");
        for (const runId of o.affectedRunIds) {
          lines.push(`  pi-harness resume ${runId}`);
        }
      }
    }
    logAndWriteFallback(fallbackFilePath, lines);
    return 3;
  }

  if (targetAttempt.childPid && isPidAlive(targetAttempt.childPid)) {
    return abortReload(
      `Failed target release ${o.target.releaseId} (pid ${targetAttempt.childPid}) is still alive after kill; refusing to start fallback.`,
    );
  }

  const fallbackEnv: Record<string, string> = {
    PI_HARNESS_SOCKET_PATH: o.socketPath,
    PI_HARNESS_RELOAD_FAILED: JSON.stringify({
      targetReleaseId: o.target.releaseId,
      error: errorMsg,
    }),
  };
  if (o.stateDir) fallbackEnv.PI_HARNESS_HOME = o.stateDir;
  if (o.overlayRoot) fallbackEnv.PI_HARNESS_OVERLAY_ROOT = o.overlayRoot;

  // Fallback always gets the default 20s boot timeout even when PI_HARNESS_SUPERVISE_BOOT_TIMEOUT_MS is set.
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
    logSupervisor(`fallback release ${prev.releaseId} is serving (pid ${fallbackAttempt.ping?.pid ?? "?"}); exiting 3`);
    return 3;
  }

  if (fallbackAttempt.childPid && !fallbackAttempt.childExited) {
    await killProcessGroups([fallbackAttempt.childPid], 1000);
  }
  return abortReload(
    `Target release ${o.target.releaseId} failed to boot (${errorMsg}), and fallback release ${prev.releaseId} also failed to boot (${fallbackAttempt.error ?? "unknown error"}).`,
  );
}
