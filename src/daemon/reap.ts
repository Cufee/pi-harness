import { execFileSync } from "node:child_process";

/** Lists PGIDs of direct child processes that lead their own process group (detached ACP/agent children). */
export function listChildProcessGroups(parentPid: number): number[] {
  if (process.platform === "win32") {
    console.error(`[harnessd ${new Date().toISOString()}] reap: skipped on win32`);
    return [];
  }
  let stdout = "";
  try {
    stdout = execFileSync("ps", ["-Ao", "pid=,ppid=,pgid="], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch (err) {
    console.error(
      `[harnessd ${new Date().toISOString()}] reap: ps failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  const pgids = new Set<number>();
  for (const rawLine of stdout.split(/\r?\n/)) {
    const parts = rawLine.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const pgid = Number(parts[2]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid)) continue;
    if (ppid === parentPid && pgid === pid && pgid > 0 && pgid !== process.pid && pgid !== parentPid) {
      pgids.add(pgid);
    }
  }
  return [...pgids];
}

function isProcessGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EPERM";
  }
}

/**
 * Sends SIGTERM to every given process group, waits up to graceMs, then SIGKILLs survivors
 * and waits until the killed groups are gone (bounded); returns SIGKILL count.
 */
export async function killProcessGroups(pgids: number[], graceMs: number): Promise<number> {
  if (process.platform === "win32" || pgids.length === 0) return 0;
  const unique = new Set<number>();
  for (const pgid of pgids) {
    if (Number.isInteger(pgid) && pgid > 0 && pgid !== process.pid) {
      unique.add(pgid);
    }
  }
  const remaining = new Set<number>();
  for (const pgid of unique) {
    try {
      process.kill(-pgid, "SIGTERM");
      remaining.add(pgid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        remaining.add(pgid);
      }
    }
  }
  if (remaining.size === 0) return 0;

  const deadline = Date.now() + Math.max(0, graceMs);
  while (remaining.size > 0) {
    for (const pgid of [...remaining]) {
      if (!isProcessGroupAlive(pgid)) remaining.delete(pgid);
    }
    if (remaining.size === 0 || Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, deadline - Date.now()))));
  }

  let killed = 0;
  const killedGroups = new Set<number>();
  for (const pgid of remaining) {
    if (!isProcessGroupAlive(pgid)) continue;
    try {
      process.kill(-pgid, "SIGKILL");
      killed++;
      killedGroups.add(pgid);
    } catch {
      // already gone or inaccessible
    }
  }

  if (killedGroups.size > 0) {
    const killDeadline = Date.now() + Math.min(2000, Math.max(500, graceMs));
    while (killedGroups.size > 0) {
      for (const pgid of [...killedGroups]) {
        if (!isProcessGroupAlive(pgid)) killedGroups.delete(pgid);
      }
      if (killedGroups.size === 0 || Date.now() >= killDeadline) break;
      await new Promise((r) => setTimeout(r, Math.min(25, Math.max(1, killDeadline - Date.now()))));
    }
  }

  return killed;
}

export async function reapChildProcessGroups(
  parentPid = process.pid,
  graceMs = 2000,
  extraPgids: Iterable<number> = [],
): Promise<number> {
  const pgids = new Set<number>(extraPgids);
  for (const pgid of listChildProcessGroups(parentPid)) {
    pgids.add(pgid);
  }
  pgids.delete(process.pid);
  pgids.delete(parentPid);
  return killProcessGroups([...pgids], graceMs);
}
