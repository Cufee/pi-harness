import { randomBytes } from "node:crypto";
import { closeSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_CORRUPT_STALE_MS = 3_000;

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function parseLockContent(raw: string): { pid: number; ts: number } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return null;
  const pid = Number(parts[0]);
  const ts = Number(parts[1]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(ts) || ts <= 0) return null;
  return { pid, ts };
}

function inspectLockFile(path: string, corruptStaleMs: number): { exists: boolean; stale: boolean; pid: number } {
  try {
    const st = statSync(path);
    const raw = readFileSync(path, "utf8");
    const parsed = parseLockContent(raw);
    if (parsed !== null) {
      // Never evict a live owner by age alone; stale only when the recorded PID no longer exists.
      return { exists: true, stale: !isPidAlive(parsed.pid), pid: parsed.pid };
    }
    return {
      exists: true,
      stale: Date.now() - st.mtimeMs >= corruptStaleMs,
      pid: 0,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, stale: false, pid: 0 };
    }
    return { exists: true, stale: false, pid: 0 };
  }
}

export async function acquireStartLock(
  dir: string,
  opts?: { waitMs?: number; staleMs?: number },
): Promise<{ release(): void }> {
  const waitMs = opts?.waitMs ?? 5000;
  const corruptStaleMs = opts?.staleMs ?? DEFAULT_CORRUPT_STALE_MS;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, "daemon.start.lock");
  const deadline = Date.now() + waitMs;
  let lastPid = 0;

  for (;;) {
    const token = randomBytes(8).toString("hex");
    const content = `${process.pid} ${Date.now()} ${token}\n`;
    const tmpPath = join(dir, `.daemon.start.lock.${process.pid}.${token}.tmp`);

    // Publish the lock atomically with its complete owner metadata so peers never observe an empty file.
    const fd = openSync(tmpPath, "wx", 0o600);
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }

    let linked = false;
    try {
      linkSync(tmpPath, lockPath);
      linked = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore temp cleanup failure
      }
    }

    if (linked) {
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          try {
            const current = readFileSync(lockPath, "utf8");
            if (current === content) unlinkSync(lockPath);
          } catch {
            // already removed
          }
        },
      };
    }

    const info = inspectLockFile(lockPath, corruptStaleMs);
    if (!info.exists) continue;
    if (info.pid > 0) lastPid = info.pid;

    if (info.stale) {
      // Serialize stale-lock eviction by renaming to a unique path first and re-checking before unlinking.
      const claimPath = join(dir, `.daemon.start.lock.stale.${process.pid}.${randomBytes(6).toString("hex")}`);
      let claimed = false;
      try {
        renameSync(lockPath, claimPath);
        claimed = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      }

      if (claimed) {
        const recheck = inspectLockFile(claimPath, corruptStaleMs);
        if (!recheck.exists || recheck.stale) {
          try {
            unlinkSync(claimPath);
          } catch {
            // already removed
          }
          continue;
        }
        // A live starter replaced lockPath before our rename; restore it immediately without deleting.
        if (recheck.pid > 0) lastPid = recheck.pid;
        try {
          linkSync(claimPath, lockPath);
        } catch {
          // another starter already linked a lockPath
        }
        try {
          unlinkSync(claimPath);
        } catch {
          // ignore
        }
      }
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Another harnessd is starting (pid ${lastPid || "?"})`);
    }
    await new Promise((r) => setTimeout(r, Math.min(100, remaining)));
  }
}
