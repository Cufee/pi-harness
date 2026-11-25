import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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
export const ROLLBACK_PAIR_FILENAME = "rollback-pair.json";

export interface RollbackPair {
  current: string;
  previous: string | null;
}

export type ReadRollbackPairResult =
  | { status: "ok"; pair: RollbackPair }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

export type RecordRollbackPairResult =
  | { status: "written"; pair: RollbackPair }
  | { status: "skipped_invalid"; reason: string }
  | { status: "skipped_missing"; reason: string };

export type ProcessCmdlineLister = () => string[] | null;
export type ClockFn = () => number;

export interface ProcessInventoryOptions {
  procRoot?: string;
  uid?: number;
  platform?: NodeJS.Platform;
}

export type ProcessInventoryResult =
  | { ok: true; cmdlines: string[] }
  | { ok: false; reason: string };

export interface PruneReleasesOptions {
  installDir: string;
  current: string;
  previous?: string;
  keepCount: number;
  listProcesses?: ProcessCmdlineLister;
  procRoot?: string;
  now?: ClockFn;
}

export interface PruneReleasesResult {
  skipped:
    | "no_releases_dir"
    | "lock_held"
    | "process_list_unreadable"
    | "rollback_pair_unreadable"
    | "rollback_pair_missing"
    | null;
  skipReason?: string;
  kept: string[];
  removed: string[];
}

export interface CleanupOctofsOptions {
  installDir: string;
  stateDir: string;
  listProcesses?: ProcessCmdlineLister;
  procRoot?: string;
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
  procRoot?: string;
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

function isProcessGoneError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "ESRCH";
}

function formatErrDetail(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null | undefined)?.code;
  const msg = err instanceof Error ? err.message : String(err);
  if (code && !msg.includes(code)) return `${code}: ${msg}`;
  return code || msg;
}

/**
 * Inspects running processes for this user, failing closed on any same-user read/stat error
 * other than `ENOENT` or `ESRCH` (process exited mid-scan).
 */
export function inspectUserProcessCmdlines(opts?: ProcessInventoryOptions): ProcessInventoryResult {
  const platform = opts?.platform ?? process.platform;
  if (platform === "linux") {
    const procRoot = opts?.procRoot ?? "/proc";
    const uid = opts?.uid !== undefined ? opts.uid : process.getuid?.();
    let entries: string[];
    try {
      entries = readdirSync(procRoot);
    } catch (err) {
      return { ok: false, reason: `readdir ${procRoot} failed (${formatErrDetail(err)})` };
    }
    const cmdlines: string[] = [];
    let sawSelfOrReadable = false;
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      const procDir = join(procRoot, entry);
      if (uid !== undefined) {
        try {
          if (statSync(procDir).uid !== uid) continue;
        } catch (err) {
          if (isProcessGoneError(err)) continue;
          return { ok: false, reason: `stat ${procDir} failed (${formatErrDetail(err)})` };
        }
      }
      const cmdlinePath = join(procDir, "cmdline");
      try {
        const raw = readFileSync(cmdlinePath, "utf8");
        sawSelfOrReadable = true;
        const cmd = raw.replace(/\0+/g, " ").trim();
        if (cmd) cmdlines.push(cmd);
      } catch (err) {
        if (isProcessGoneError(err)) continue;
        return { ok: false, reason: `read ${cmdlinePath} failed (${formatErrDetail(err)})` };
      }
    }
    if (!sawSelfOrReadable) {
      return { ok: false, reason: `no readable processes in ${procRoot}` };
    }
    return { ok: true, cmdlines };
  }

  try {
    const res = spawnSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8", timeout: 5000 });
    if (res.error) {
      return { ok: false, reason: `ps failed (${formatErrDetail(res.error)})` };
    }
    if (res.status !== 0 || typeof res.stdout !== "string") {
      return { ok: false, reason: `ps exited ${res.status ?? "null"}` };
    }
    const cmdlines: string[] = [];
    for (const line of res.stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*\d+\s+(.+)$/);
      if (match?.[1]) cmdlines.push(match[1].trim());
    }
    if (cmdlines.length === 0) {
      return { ok: false, reason: "ps returned no processes" };
    }
    return { ok: true, cmdlines };
  } catch (err) {
    return { ok: false, reason: `ps failed (${formatErrDetail(err)})` };
  }
}

/**
 * Returns command lines of running processes for this user, or `null` when the process table cannot be read.
 * Linux reads `/proc/<pid>/cmdline`; other platforms run `ps -Ao pid=,args=`.
 */
export function listUserProcessCmdlines(opts?: ProcessInventoryOptions): string[] | null {
  const res = inspectUserProcessCmdlines(opts);
  return res.ok ? res.cmdlines : null;
}

function safeInspectProcesses(
  lister?: ProcessCmdlineLister,
  procOpts?: ProcessInventoryOptions,
): ProcessInventoryResult {
  if (!lister) {
    return inspectUserProcessCmdlines(procOpts);
  }
  try {
    const list = lister();
    return Array.isArray(list) ? { ok: true, cmdlines: list } : { ok: false, reason: "process list unavailable" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[pi-harness maintenance] process list error: ${detail}`);
    return { ok: false, reason: detail };
  }
}

function sanitizeAuditValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/"/g, "'").trim();
}

function appendAuditLogLine(stateDir: string, nowMs: number, message: string): void {
  try {
    const resolvedStateDir = resolve(stateDir);
    mkdirSync(resolvedStateDir, { recursive: true });
    const auditLogPath = join(resolvedStateDir, "install-audit.log");
    const ts = new Date(nowMs).toISOString();
    appendFileSync(auditLogPath, `${ts} ${message}\n`, "utf8");
  } catch (err) {
    console.error(
      `[pi-harness maintenance] failed to append install-audit.log: ${err instanceof Error ? err.message : String(err)}`,
    );
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

function isValidReleaseId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function readCurrentSymlinkReleaseId(installDir: string): string | null {
  try {
    const target = readlinkSync(join(installDir, "current")).replace(/\/+$/, "");
    const id = basename(target);
    return isValidReleaseId(id) ? id : null;
  } catch {
    return null;
  }
}

function fsyncDir(dirPath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(dirPath, constants.O_RDONLY);
    fsyncSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EROFS" && code !== "EBADF") {
      throw err;
    }
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

function hasOtherReleaseDirectory(installDir: string, currentId: string): boolean | null {
  const releasesDir = join(installDir, "releases");
  let entries;
  try {
    entries = readdirSync(releasesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    return null;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === currentId) continue;
    const dir = join(releasesDir, entry.name);
    try {
      const st = lstatSync(dir);
      if (st.isDirectory()) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return null;
    }
  }
  return false;
}

export function rollbackPairPath(installDir: string): string {
  return join(resolve(installDir), ROLLBACK_PAIR_FILENAME);
}

/**
 * Reads `<installDir>/rollback-pair.json`.
 * Returns `missing` when absent (e.g. first upgrade from an older installer), `ok` when valid,
 * or `invalid` when present on disk but unreadable or malformed.
 */
export function readRollbackPair(installDir: string): ReadRollbackPairResult {
  const filePath = rollbackPairPath(installDir);
  try {
    const st = lstatSync(filePath);
    if (!st.isFile()) {
      return { status: "invalid", reason: `${ROLLBACK_PAIR_FILENAME} is not a regular file` };
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid", reason: formatErrDetail(err) };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (err) {
    return { status: "invalid", reason: formatErrDetail(err) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return { status: "invalid", reason: "root value is not a JSON object" };
    }
    if (!isValidReleaseId(parsed.current)) {
      return { status: "invalid", reason: "invalid current release id" };
    }
    const prev = parsed.previous;
    if (prev !== null && (!isValidReleaseId(prev) || prev === parsed.current)) {
      return { status: "invalid", reason: "invalid previous release id" };
    }
    return { status: "ok", pair: { current: parsed.current, previous: prev } };
  } catch (err) {
    return { status: "invalid", reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Atomically updates `<installDir>/rollback-pair.json` at release activation (caller holds `<installDir>/.lock`).
 * Preserves the recorded `previous` when reinstalling the same release id.
 * Keeps an existing unreadable or malformed record untouched, and refuses to synthesize a `previous: null`
 * record when the record is missing and another release directory already exists.
 */
export function recordRollbackPair(
  installDir: string,
  currentId: string,
  priorCurrentId?: string | null,
): RecordRollbackPairResult {
  if (!isValidReleaseId(currentId)) {
    throw new Error(`Invalid release id: ${String(currentId)}`);
  }
  const resolvedInstallDir = resolve(installDir);
  const existingRes = readRollbackPair(resolvedInstallDir);
  if (existingRes.status === "invalid") {
    return {
      status: "skipped_invalid",
      reason: `unreadable ${ROLLBACK_PAIR_FILENAME} (${existingRes.reason})`,
    };
  }
  const existing = existingRes.status === "ok" ? existingRes.pair : null;
  const prior =
    priorCurrentId !== undefined
      ? isValidReleaseId(priorCurrentId)
        ? priorCurrentId
        : null
      : readCurrentSymlinkReleaseId(resolvedInstallDir);

  let previous: string | null = null;
  if (prior && prior !== currentId) {
    previous = prior;
  } else if (existing && existing.current !== currentId) {
    previous = existing.current;
  } else if (existing?.previous && existing.previous !== currentId) {
    previous = existing.previous;
  }

  if (existingRes.status === "missing" && previous === null) {
    const otherRelease = hasOtherReleaseDirectory(resolvedInstallDir, currentId);
    if (otherRelease !== false) {
      return {
        status: "skipped_missing",
        reason:
          otherRelease === null
            ? `missing ${ROLLBACK_PAIR_FILENAME} and unable to inspect releases directory`
            : `missing ${ROLLBACK_PAIR_FILENAME} on reinstall of ${currentId} while other release directories exist`,
      };
    }
  }

  const pair: RollbackPair = { current: currentId, previous };
  const targetPath = rollbackPairPath(resolvedInstallDir);
  const tmpPath = join(resolvedInstallDir, `.${ROLLBACK_PAIR_FILENAME}.tmp.${process.pid}.${Date.now()}`);
  mkdirSync(resolvedInstallDir, { recursive: true });
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "w", 0o644);
    writeFileSync(fd, `${JSON.stringify(pair, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, targetPath);
    fsyncDir(resolvedInstallDir);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // ignore temp cleanup failure
    }
    throw err;
  }
  return { status: "written", pair };
}

/**
 * Prunes old release directories under `<installDir>/releases` while holding `<installDir>/.lock`.
 * Keeps the durable rollback pair (`<installDir>/rollback-pair.json`), the target of `current`,
 * releases referenced by any running process, releases modified within the last 10 minutes,
 * and the newest remaining releases up to `keepCount`.
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
    const rollbackPairRes = readRollbackPair(installDir);
    if (rollbackPairRes.status === "invalid") {
      return {
        skipped: "rollback_pair_unreadable",
        skipReason: rollbackPairRes.reason,
        kept: [],
        removed: [],
      };
    }

    const procRes = safeInspectProcesses(opts.listProcesses, opts.procRoot ? { procRoot: opts.procRoot } : undefined);
    if (!procRes.ok) {
      return { skipped: "process_list_unreadable", skipReason: procRes.reason, kept: [], removed: [] };
    }
    const cmdlines = procRes.cmdlines;

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
    const currentSymlinkId = readCurrentSymlinkReleaseId(installDir);
    if (rollbackPairRes.status === "missing") {
      const effectiveCurrent = currentSymlinkId ?? opts.current;
      const hasOtherRelease = releases.some((r) => r.id !== effectiveCurrent);
      const hasExplicitDistinctPrevious =
        isValidReleaseId(opts.previous) &&
        opts.previous !== opts.current &&
        (!currentSymlinkId || (currentSymlinkId === opts.current && opts.previous !== currentSymlinkId));
      if (hasOtherRelease && !hasExplicitDistinctPrevious) {
        return {
          skipped: "rollback_pair_missing",
          skipReason: `missing ${ROLLBACK_PAIR_FILENAME} while other release directories exist`,
          kept: [],
          removed: [],
        };
      }
    }

    const keep = new Set<string>();

    if (currentSymlinkId && existingIds.has(currentSymlinkId)) {
      keep.add(currentSymlinkId);
    }
    if (rollbackPairRes.status === "ok") {
      if (existingIds.has(rollbackPairRes.pair.current)) {
        keep.add(rollbackPairRes.pair.current);
      }
      if (rollbackPairRes.pair.previous && existingIds.has(rollbackPairRes.pair.previous)) {
        keep.add(rollbackPairRes.pair.previous);
      }
    } else {
      if (opts.current && existingIds.has(opts.current)) {
        keep.add(opts.current);
      }
      if (opts.previous && existingIds.has(opts.previous)) {
        keep.add(opts.previous);
      }
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

    const procRes = safeInspectProcesses(opts.listProcesses, opts.procRoot ? { procRoot: opts.procRoot } : undefined);
    if (!procRes.ok) {
      return { skipped: "process_list_unreadable", pinnedVersions: [...pinnedVersions], removed: [] };
    }
    const cmdlines = procRes.cmdlines;

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
      procRoot: opts.procRoot,
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

  if (
    releases.skipped === "process_list_unreadable" ||
    releases.skipped === "rollback_pair_unreadable" ||
    releases.skipped === "rollback_pair_missing"
  ) {
    const reason = sanitizeAuditValue(releases.skipReason ?? releases.skipped);
    const nowMs = (opts.now ?? Date.now)();
    console.error(`[pi-harness maintenance] skipping release pruning: ${reason}`);
    appendAuditLogLine(
      opts.stateDir,
      nowMs,
      `maintenance=prune_skipped skipped=${releases.skipped} reason="${reason}"`,
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
      procRoot: opts.procRoot,
    });
  } catch (err) {
    console.error(
      `[pi-harness maintenance] octofs cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { releases, auditLogRotated, stagingRemoved, octofs };
}

function parseCliArgs(argv: string[]): {
  recordRollbackPair?: boolean;
  installDir?: string;
  stateDir?: string;
  current?: string;
  previous?: string;
  priorCurrent?: string;
} {
  const out: {
    recordRollbackPair?: boolean;
    installDir?: string;
    stateDir?: string;
    current?: string;
    previous?: string;
    priorCurrent?: string;
  } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--record-rollback-pair") {
      out.recordRollbackPair = true;
    } else if (arg === "--install-dir" && next !== undefined) {
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
    } else if (arg === "--prior-current" && next !== undefined) {
      out.priorCurrent = next;
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
  const cliArgs = process.argv.slice(2);
  const parsed = parseCliArgs(cliArgs);
  if (parsed.recordRollbackPair) {
    try {
      if (!parsed.installDir || !parsed.current) {
        console.error(
          "[pi-harness maintenance] --record-rollback-pair requires --install-dir and --current",
        );
        process.exitCode = 1;
      } else {
        const res = recordRollbackPair(parsed.installDir, parsed.current, parsed.priorCurrent);
        if (res.status !== "written") {
          console.error(`[pi-harness maintenance] skipping rollback pair update (${res.status}): ${res.reason}`);
        }
        process.exitCode = 0;
      }
    } catch (err) {
      console.error(
        `[pi-harness maintenance] failed to record rollback pair: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exitCode = 1;
    }
  } else {
    runMaintenanceCli(cliArgs);
    process.exitCode = 0;
  }
}
