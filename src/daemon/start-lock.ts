import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function acquireStartLock(
  dir: string,
  opts?: { waitMs?: number; staleMs?: number },
): Promise<{ release(): void }> {
  const waitMs = opts?.waitMs ?? 5000;
  const staleMs = opts?.staleMs ?? 30_000;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, "daemon.start.lock");
  const deadline = Date.now() + waitMs;
  let lastPid = 0;

  for (;;) {
    const content = `${process.pid} ${Date.now()}\n`;
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, content);
      } finally {
        closeSync(fd);
      }
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
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    let raw: string | null = null;
    try {
      raw = readFileSync(lockPath, "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
    }

    let pid = 0;
    let ts = NaN;
    if (raw) {
      const parts = raw.split(/\s+/);
      pid = Number(parts[0]);
      ts = Number(parts[1]);
    }
    if (Number.isInteger(pid) && pid > 0) lastPid = pid;

    const stale = !isPidAlive(pid) || !Number.isFinite(ts) || Date.now() - ts > staleMs;
    if (stale) {
      try {
        unlinkSync(lockPath);
      } catch {
        // another process may have removed or replaced it
      }
      continue;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Another harnessd is starting (pid ${lastPid || "?"})`);
    }
    await new Promise((r) => setTimeout(r, Math.min(100, remaining)));
  }
}
