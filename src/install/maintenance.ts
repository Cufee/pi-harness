import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  DEFAULT_RETENTION_CONFIG,
  defaultStateDir,
  isPlainObject,
  type RetentionConfig,
} from "../config.js";

export const RECENT_RELEASE_WINDOW_MS = 10 * 60 * 1000;
export const STAGING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ProcessCmdlineLister = () => string[] | null;
export type ClockFn = () => number;

export interface PruneReleasesOptions {
  installDir: string;
  current: string;
  previous?: string;
  keepCount: number;
  listProcesses?: ProcessCmdlineLister;
  now?: ClockFn;
}

export interface PruneReleasesResult {
  skipped: "no_releases_dir" | "lock_held" | "process_list_unreadable" | null;
  kept: string[];
  removed: string[];
}

export interface CleanupOctofsOptions {
  installDir: string;
  stateDir: string;
  listProcesses?: ProcessCmdlineLister;
}

export interface CleanupOctofsResult {
  skipped: "no_kept_releases" | "lock_held" | "unparseable_release" | "process_list_unreadable" | null;
  pinnedVersions: string[];
  removed: string[];
}

export interface InstallMaintenanceOptions {
  installDir: string;
  stateDir: string;
  current: string;
  previous?: string;
  retention?: Partial<RetentionConfig>;
  listProcesses?: ProcessCmdlineLister;
  now?: ClockFn;
}

export interface InstallMaintenanceResult {
  releases: PruneReleasesResult;
  auditLogRotated: boolean;
  stagingRemoved: string[];
  octofs: CleanupOctofsResult;
}

/** Reads `retention` settings from `<stateDir>/config.json`, falling back to defaults without throwing. */
export function readRetentionConfig(stateDir?: string): RetentionConfig {
  try {
    const resolvedStateDir = resolve(stateDir || defaultStateDir());
    const configPath = join(resolvedStateDir, "config.json");
    if (!existsSync(configPath)) return { ...DEFAULT_RETENTION_CONFIG };
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    if (!isPlainObject(parsed)) return { ...DEFAULT_RETENTION_CONFIG };
    const raw = parsed.retention;
    if (!isPlainObject(raw)) return { ...DEFAULT_RETENTION_CONFIG };
    const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
    return {
      installReleases: isPosInt(raw.installReleases)
        ? raw.installReleases
        : DEFAULT_RETENTION_CONFIG.installReleases,
      logMaxBytes: isPosInt(raw.logMaxBytes) ? raw.logMaxBytes : DEFAULT_RETENTION_CONFIG.logMaxBytes,
    };
  } catch {
    return { ...DEFAULT_RETENTION_CONFIG };
  }
}

/** Reads `retention.logMaxBytes` from `<stateDir>/config.json`, falling back to the default without throwing. */
export function readRetentionLogMaxBytes(stateDir?: string): number {
  return readRetentionConfig(stateDir).logMaxBytes;
}

/**
 * Renames `logPath` to `<logPath>.1` when it is a regular file strictly larger than `maxBytes`.
 * Replaces any older `.1` file. Never throws.
 */
export function rotateLogIfOversized(logPath: string, maxBytes: number): boolean {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return false;
  try {
    const st = lstatSync(logPath);
    if (!st.isFile() || st.size <= maxBytes) return false;
    renameSync(logPath, `${logPath}.1`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns command lines of running processes for this user, or `null` when the process table cannot be read.
 * Linux reads `/proc/<pid>/cmdline`; other platforms run `ps -Ao pid=,args=`.
 */
export function listUserProcessCmdlines(): string[] | null {
  if (process.platform === "linux") {
    try {
      const uid = process.getuid?.();
      const entries = readdirSync("/proc");
      const cmdlines: string[] = [];
      let sawSelfOrReadable = false;
      for (const entry of entries) {
        if (!/^\d+$/.test(entry)) continue;
        const procDir = `/proc/${entry}`;
        if (uid !== undefined) {
          try {
            if (statSync(procDir).uid !== uid) continue;
          } catch {
            continue;
          }
        }
        try {
          const raw = readFileSync(`${procDir}/cmdline`, "utf8");
          sawSelfOrReadable = true;
          const cmd = raw.replace(/\0+/g, " ").trim();
          if (cmd) cmdlines.push(cmd);
        } catch {
          // Process exited or permission denied between readdir and read.
        }
      }
      return sawSelfOrReadable ? cmdlines : null;
    } catch {
      return null;
    }
  }

  try {
    const res = spawnSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8", timeout: 5000 });
    if (res.error || res.status !== 0 || typeof res.stdout !== "string") return null;
    const cmdlines: string[] = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*\d+\s+(.+)$/);
      if (match?.[1]) cmdlines.push(match[1].trim());
    }
    return cmdlines.length > 0 ? cmdlines : null;
  } catch {
    return null;
  }
}

function safeListProcesses(lister: ProcessCmdlineLister): string[] | null {
  try {
    const list = lister();
    return Array.isArray(list) ? list : null;
  } catch (err) {
    console.error(`[pi-harness maintenance] process list error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function physicalPathOrResolve(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return resolve(targetPath);
  }
}

function cmdlinesReferencePath(cmdlines: string[], dirPath: string): boolean {
  const candidates = new Set<string>([resolve(dirPath), physicalPathOrResolve(dirPath)]);
  for (const base of candidates) {
    const clean = base.replace(/\/+$/, "");
    const withSlash = `${clean}/`;
    for (const cmd of cmdlines) {
      if (cmd.includes(withSlash)) return true;
    }
  }
  return false;
}

function readCurrentSymlinkReleaseId(installDir: string): string | null {
  try {
    const target = readlinkSync(join(installDir, "current")).replace(/\/+$/, "");
    const id = basename(target);
    return id && id !== "." && id !== ".." ? id : null;
  } catch {
    return null;
  }
}

/**
 * Prunes old release directories under `<installDir>/releases` while holding `<installDir>/.lock`.
 * Keeps current, previous (when present on disk), releases referenced by any running process,
 * releases modified within the last 10 minutes, and the newest remaining releases up to `keepCount`.
 */
export function pruneInstallReleases(opts: PruneReleasesOptions): PruneReleasesResult {
  const installDir = resolve(opts.installDir);
  const releasesDir = join(installDir, "releases");
  if (!existsSync(releasesDir)) {
    return { skipped: "no_releases_dir", kept: [], removed: [] };
  }

  const lockDir = join(installDir, ".lock");
  try {
    mkdirSync(lockDir);
  } catch {
    return { skipped: "lock_held", kept: [], removed: [] };
  }

  try {
    const listProcesses = opts.listProcesses ?? listUserProcessCmdlines;
    const cmdlines = safeListProcesses(listProcesses);
    if (cmdlines === null) {
      return { skipped: "process_list_unreadable", kept: [], removed: [] };
    }

    const nowMs = (opts.now ?? Date.now)();
    const entries = readdirSync(releasesDir, { withFileTypes: true });
    const releases: Array<{ id: string; dir: string; mtimeMs: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = join(releasesDir, entry.name);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory()) continue;
        releases.push({ id: entry.name, dir, mtimeMs: st.mtimeMs });
      } catch {
        // Skip entries that disappear or cannot be statted.
      }
    }

    const existingIds = new Set(releases.map((r) => r.id));
    const keep = new Set<string>();

    if (opts.current && existingIds.has(opts.current)) {
      keep.add(opts.current);
    }
    const currentSymlinkId = readCurrentSymlinkReleaseId(installDir);
    if (currentSymlinkId && existingIds.has(currentSymlinkId)) {
      keep.add(currentSymlinkId);
    }
    if (opts.previous && existingIds.has(opts.previous)) {
      keep.add(opts.previous);
    }

    for (const rel of releases) {
      if (nowMs - rel.mtimeMs <= RECENT_RELEASE_WINDOW_MS) {
        keep.add(rel.id);
      } else if (cmdlinesReferencePath(cmdlines, rel.dir)) {
        keep.add(rel.id);
      }
    }

    const targetKeepCount = Math.max(1, Math.floor(opts.keepCount));
    const remaining = releases
      .filter((r) => !keep.has(r.id))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.id.localeCompare(a.id));
    for (const rel of remaining) {
      if (keep.size >= targetKeepCount) break;
      keep.add(rel.id);
    }

    const removed: string[] = [];
    for (const rel of releases) {
      if (keep.has(rel.id)) continue;
      try {
        rmSync(rel.dir, { recursive: true, force: true });
        removed.push(rel.id);
      } catch (err) {
        console.error(
          `[pi-harness maintenance] failed to remove release ${rel.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return {
      skipped: null,
      kept: releases.filter((r) => keep.has(r.id)).map((r) => r.id),
      removed,
    };
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // ignore lock cleanup failure
    }
  }
}

/**
 * Removes entries under `<stateDir>/tools/.staging/` older than `maxAgeMs` (default 1 day).
 * Best effort; never throws.
 */
export function cleanStaleStagingDirs(
  stateDir: string,
  opts?: { now?: ClockFn; maxAgeMs?: number },
): string[] {
  const removed: string[] = [];
  const stagingRoot = join(resolve(stateDir), "tools", ".staging");
  const nowMs = (opts?.now ?? Date.now)();
  const maxAgeMs = opts?.maxAgeMs ?? STAGING_MAX_AGE_MS;
  let entries: string[];
  try {
    entries = readdirSync(stagingRoot);
  } catch {
    return removed;
  }

  for (const name of entries) {
    const entryPath = join(stagingRoot, name);
    try {
      const st = lstatSync(entryPath);
      if (nowMs - st.mtimeMs > maxAgeMs) {
        rmSync(entryPath, { recursive: true, force: true });
        removed.push(name);
      }
    } catch {
      // Best-effort cleanup; skip entries that vanish or cannot be removed.
    }
  }
  return removed;
}

/** Extracts `OCTOFS_VERSION` from a release's `src/tools/native-tools.ts` source. */
export function parsePinnedOctofsVersion(source: string): string | null {
  const match = source.match(/\bexport\s+const\s+OCTOFS_VERSION(?:\s*:\s*string)?\s*=\s*["']([^"'\s]+)["']/);
  return match?.[1] ?? null;
}

function matchesPinnedOctofsDir(dirName: string, pinnedVersions: ReadonlySet<string>): boolean {
  for (const version of pinnedVersions) {
    if (dirName === version || dirName.startsWith(`${version}-`)) return true;
  }
  return false;
}

/**
 * Removes `octofs` version directories under `<stateDir>/tools/octofs` and `<installDir>/tools/octofs`
 * that are neither pinned by any kept release nor referenced in a running process command line.
 * Takes `<installDir>/.lock` so a concurrent install staging a new binary is not disturbed.
 * If any kept release's `src/tools/native-tools.ts` cannot be parsed, or the process list cannot be read,
 * removes nothing.
 */
export function cleanupOctofsVersions(opts: CleanupOctofsOptions): CleanupOctofsResult {
  const installDir = resolve(opts.installDir);
  const stateDir = resolve(opts.stateDir);
  const releasesDir = join(installDir, "releases");

  if (!existsSync(releasesDir)) {
    return { skipped: "no_kept_releases", pinnedVersions: [], removed: [] };
  }

  const lockDir = join(installDir, ".lock");
  try {
    mkdirSync(lockDir);
  } catch {
    return { skipped: "lock_held", pinnedVersions: [], removed: [] };
  }

  try {
    let keptReleaseDirs: string[] = [];
    try {
      keptReleaseDirs = readdirSync(releasesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => join(releasesDir, entry.name));
    } catch {
      return { skipped: "no_kept_releases", pinnedVersions: [], removed: [] };
    }
    if (keptReleaseDirs.length === 0) {
      return { skipped: "no_kept_releases", pinnedVersions: [], removed: [] };
    }

    const pinnedVersions = new Set<string>();
    for (const releaseDir of keptReleaseDirs) {
      const nativeToolsPath = join(releaseDir, "src", "tools", "native-tools.ts");
      try {
        const src = readFileSync(nativeToolsPath, "utf8");
        const version = parsePinnedOctofsVersion(src);
        if (!version) {
          return { skipped: "unparseable_release", pinnedVersions: [], removed: [] };
        }
        pinnedVersions.add(version);
      } catch {
        return { skipped: "unparseable_release", pinnedVersions: [], removed: [] };
      }
    }

    const listProcesses = opts.listProcesses ?? listUserProcessCmdlines;
    const cmdlines = safeListProcesses(listProcesses);
    if (cmdlines === null) {
      return { skipped: "process_list_unreadable", pinnedVersions: [...pinnedVersions], removed: [] };
    }

    const octofsRoots = new Set<string>([
      resolve(join(stateDir, "tools", "octofs")),
      resolve(join(installDir, "tools", "octofs")),
    ]);
    const seenPhysicalRoots = new Set<string>();
    const removed: string[] = [];

    for (const root of octofsRoots) {
      const physRoot = physicalPathOrResolve(root);
      if (seenPhysicalRoots.has(physRoot)) continue;
      seenPhysicalRoots.add(physRoot);
      let entries;
      try {
        entries = readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        if (matchesPinnedOctofsDir(entry.name, pinnedVersions)) continue;
        const dirPath = join(root, entry.name);
        if (cmdlinesReferencePath(cmdlines, dirPath)) continue;
        try {
          rmSync(dirPath, { recursive: true, force: true });
          removed.push(dirPath);
        } catch (err) {
          console.error(
            `[pi-harness maintenance] failed to remove octofs dir ${dirPath}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    return { skipped: null, pinnedVersions: [...pinnedVersions], removed };
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // ignore lock cleanup failure
    }
  }
}

/**
 * Runs all post-install maintenance steps independently. Each step catches and logs errors to stderr
 * so one failure never aborts the remaining steps or the install.
 */
export function runInstallMaintenance(opts: InstallMaintenanceOptions): InstallMaintenanceResult {
  const configured = readRetentionConfig(opts.stateDir);
  const retention: RetentionConfig = {
    installReleases: opts.retention?.installReleases ?? configured.installReleases,
    logMaxBytes: opts.retention?.logMaxBytes ?? configured.logMaxBytes,
  };

  let releases: PruneReleasesResult = { skipped: null, kept: [], removed: [] };
  try {
    releases = pruneInstallReleases({
      installDir: opts.installDir,
      current: opts.current,
      previous: opts.previous?.trim() || undefined,
      keepCount: retention.installReleases,
      listProcesses: opts.listProcesses,
      now: opts.now,
    });
  } catch (err) {
    console.error(
      `[pi-harness maintenance] release pruning failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let auditLogRotated = false;
  try {
    const auditLogPath = join(resolve(opts.stateDir), "install-audit.log");
    auditLogRotated = rotateLogIfOversized(auditLogPath, retention.logMaxBytes);
  } catch (err) {
    console.error(
      `[pi-harness maintenance] audit log rotation failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let stagingRemoved: string[] = [];
  try {
    stagingRemoved = cleanStaleStagingDirs(opts.stateDir, { now: opts.now });
  } catch (err) {
    console.error(
      `[pi-harness maintenance] staging cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let octofs: CleanupOctofsResult = { skipped: null, pinnedVersions: [], removed: [] };
  try {
    octofs = cleanupOctofsVersions({
      installDir: opts.installDir,
      stateDir: opts.stateDir,
      listProcesses: opts.listProcesses,
    });
  } catch (err) {
    console.error(
      `[pi-harness maintenance] octofs cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { releases, auditLogRotated, stagingRemoved, octofs };
}

function parseCliArgs(argv: string[]): {
  installDir?: string;
  stateDir?: string;
  current?: string;
  previous?: string;
} {
  const out: { installDir?: string; stateDir?: string; current?: string; previous?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--install-dir" && next !== undefined) {
      out.installDir = next;
      i++;
    } else if (arg === "--state-dir" && next !== undefined) {
      out.stateDir = next;
      i++;
    } else if (arg === "--current" && next !== undefined) {
      out.current = next;
      i++;
    } else if (arg === "--previous" && next !== undefined) {
      out.previous = next;
      i++;
    }
  }
  return out;
}

export function runMaintenanceCli(argv: string[]): void {
  try {
    const parsed = parseCliArgs(argv);
    if (!parsed.installDir || !parsed.stateDir || !parsed.current) {
      console.error(
        "[pi-harness maintenance] missing required arguments (--install-dir, --state-dir, --current); skipping",
      );
      return;
    }
    runInstallMaintenance({
      installDir: parsed.installDir,
      stateDir: parsed.stateDir,
      current: parsed.current,
      previous: parsed.previous,
    });
  } catch (err) {
    console.error(`[pi-harness maintenance] unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

if (import.meta.main) {
  runMaintenanceCli(process.argv.slice(2));
  process.exitCode = 0;
}
