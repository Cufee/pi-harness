import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAEMON_PROTOCOL_REV } from "../protocol/daemon-rpc.js";
import { currentRelease, installedCurrent, type ReleaseTarget } from "./release.js";
import { DaemonClient } from "./remote.js";

export function spawnDaemonDetached(
  target: ReleaseTarget,
  socketPath: string,
  env?: Record<string, string>,
): ChildProcess {
  const logDir = dirname(socketPath);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "daemon.log");
  const logFd = openSync(logPath, "a");
  let cwd = logDir;
  try {
    const currentCwd = process.cwd();
    if (existsSync(currentCwd)) cwd = currentCwd;
  } catch {
    // Current directory may have been removed (e.g. a deleted worktree); fall back to socket dir.
  }
  try {
    const child = spawn(target.bunPath, [target.cliPath, "daemon", "serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd,
      env: env ? { ...process.env, ...env } : { ...process.env },
    });
    child.unref();
    return child;
  } finally {
    closeSync(logFd);
  }
}

export async function stopLocalDaemon(socketPath: string): Promise<boolean> {
  const probe = new DaemonClient(socketPath);
  try {
    await probe.connect();
    const info = (await probe.request("ping")) as { pid?: number };
    await probe.request("daemon.shutdown").catch(() => {});
    probe.close();
    // Fallback SIGTERM if older daemon didn't recognize `daemon.shutdown`
    if (typeof info.pid === "number" && info.pid > 0) {
      await new Promise((r) => setTimeout(r, 120));
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
    return true;
  } catch {
    probe.close();
    return false;
  }
}

export async function ensureLocalDaemon(socketPath: string): Promise<DaemonClient> {
  const selfRelease = currentRelease();
  const probe = new DaemonClient(socketPath);
  let needsRestart = false;
  let mismatchError: Error | null = null;
  try {
    await probe.connect();
    const info = (await probe.request("ping")) as {
      pid?: number;
      protocolRev?: number;
      releaseId?: string;
      running?: boolean;
      liveWork?: string;
    };
    if (info.protocolRev === DAEMON_PROTOCOL_REV) {
      if ((!info.releaseId || info.releaseId !== selfRelease.releaseId) && process.stderr.isTTY) {
        console.error(
          `[pi-harness] harnessd runs release ${info.releaseId || "unknown"}, this CLI is ${selfRelease.releaseId}. Run \`pi-harness daemon restart\` to apply the installed release.`,
        );
      }
      return probe;
    }
    if (typeof info.protocolRev === "number" && info.protocolRev > DAEMON_PROTOCOL_REV) {
      probe.close();
      mismatchError = new Error(
        `This CLI (protocol rev ${DAEMON_PROTOCOL_REV}) is older than the running harnessd (pid ${info.pid ?? "?"}, protocol rev ${info.protocolRev}). Start a new \`pi-harness\` to connect.`,
      );
    } else if (info.running !== false) {
      probe.close();
      mismatchError = new Error(
        `Live harnessd (pid ${info.pid ?? "?"}, protocol rev ${info.protocolRev ?? "?"}) has active or unknown work (${info.liveWork ?? "active"}) and will not be stopped automatically for protocol rev ${DAEMON_PROTOCOL_REV}. Wait for work to finish or run \`pi-harness daemon restart\` explicitly.`,
      );
    } else {
      probe.close();
      needsRestart = true;
      await stopLocalDaemon(socketPath);
    }
  } catch {
    probe.close();
  }

  if (mismatchError) {
    throw mismatchError;
  }

  if (needsRestart) {
    await new Promise((r) => setTimeout(r, 150));
  }

  const target = installedCurrent(selfRelease) ?? selfRelease;
  const logDir = dirname(socketPath);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "daemon.log");
  let logStart = 0;
  try {
    logStart = statSync(logPath).size;
  } catch {
    // daemon.log does not exist yet
  }
  let exitStatus: string | null = null;
  const child = spawnDaemonDetached(target, socketPath);
  child.once("exit", (code, signal) => {
    exitStatus = signal ?? String(code);
  });
  child.once("error", (err) => {
    exitStatus = err.message;
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 80));
    if (existsSync(socketPath)) {
      const check = new DaemonClient(socketPath);
      try {
        await check.connect();
        const info = (await check.request("ping")) as { protocolRev?: number };
        if (info.protocolRev === DAEMON_PROTOCOL_REV) return check;
        check.close();
      } catch {
        check.close();
      }
    }
    // A socket file means another daemon may still be coming up, so keep polling after our spawn exits.
    if (exitStatus !== null && !existsSync(socketPath)) throw exitError(exitStatus);
  }
  if (exitStatus !== null) throw exitError(exitStatus);
  throw new Error(`Timed out waiting for harnessd to listen on ${socketPath}`);

  function exitError(status: string): Error {
    let logged = "";
    try {
      const fd = openSync(logPath, "r");
      try {
        const end = fstatSync(fd).size;
        const start = Math.max(logStart, end - 16384);
        const buf = Buffer.alloc(Math.max(0, end - start));
        logged = buf.subarray(0, readSync(fd, buf, 0, buf.length, start)).toString("utf8").trim().slice(-2000);
      } finally {
        closeSync(fd);
      }
    } catch {
      // An unreadable log must not hide the exit status.
    }
    return new Error(`harnessd exited (${status}) before listening on ${socketPath}: ${logged || `no output in ${logPath}`}`);
  }
}
