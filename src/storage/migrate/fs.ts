import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { isDirectorTaskContainer } from "../../control-plane/ids.js";
import {
  canonicalPath,
  ensureDirsUnderRoot,
  hashFileSha256Sync,
  isEqualOrWithin,
  isRealDirUnderRoot,
  isRealFileUnderRoot,
  isWithin,
} from "../data-dir/fs-utils.js";
import {
  type DiscoveredLegacyUnit,
  orderedProjectChatNames,
  type StorageUnitKind,
  unitDataDirDestination,
} from "../data-dir/units.js";
import type { OwnerRef, StoragePaths } from "../paths.js";

/** Maximum file size hashed during migration verification (1 TiB, safely within MAX_SAFE_INTEGER). */
const MAX_MIGRATE_HASH_BYTES = 1024 * 1024 * 1024 * 1024;
const COPY_CHUNK_BYTES = 65_536;
const MIGRATION_STATE_FILE = "migration-state.json";
export const MIGRATION_STAGING_DIR = ".migration-staging";
export const STAGE_MANIFEST_FILE = "manifest.jsonl";
const SAFE_STAGING_OP_ID_RE = /^[a-zA-Z0-9_-]{8,128}$/;

export interface StageManifestEntry {
  /** POSIX-style relative path within the unit (`""` for single-file units). */
  relPath: string;
  /** Source byte size as decimal string (lossless bigint). */
  size: string;
  /** Source `lstat.mtimeNs` as decimal string. */
  mtimeNs: string;
  /** Source `lstat.ino` as decimal string. */
  ino: string;
  /** Source `lstat.dev` as decimal string. */
  dev?: string;
  /** Verified SHA-256 hex digest of the staged file. */
  sha256: string;
}

export interface StagedCopyResult {
  manifest: Map<string, StageManifestEntry>;
  dirs: string[];
}

export interface FileIdentity {
  ino: string;
  size: string;
  mtimeNs: string;
}

export interface LegacyDeleteResult {
  /** True when every verified entry was removed and `legacyPath` no longer exists. */
  fullyDeleted: boolean;
  /** Number of unverified/modified entries left untouched at `legacyPath`. */
  leftoverEntries: number;
}

export interface MergeBothExistResult {
  shadowed: ShadowedFileRecord[];
  /** True when all legacy files were verified+unlinked and `legacyPath` was removed. */
  fullyMerged: boolean;
}

/** Fsyncs a directory so metadata updates (file creations, renames, unlinks) are durable before deleting sources. */
export function fsyncDir(dirPath: string): void {
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
        // Ignore close error.
      }
    }
  }
}

/** Fsyncs staged payload directories (deepest-first) and the private stage directory itself. */
export function fsyncStageTree(
  stageDir: string,
  payloadPath: string,
  isDir: boolean,
  dirs: readonly string[] = [],
): void {
  if (isDir) {
    const deepestFirst = [...dirs].sort((a, b) => b.split("/").length - a.split("/").length);
    for (const relDir of deepestFirst) {
      fsyncDir(join(payloadPath, ...relDir.split("/")));
    }
    fsyncDir(payloadPath);
  }
  fsyncDir(stageDir);
}

export const LEGACY_HARNESS_DIR = ".harness";

export class BudgetExceededError extends Error {
  constructor() {
    super("Storage migration wall-clock budget exceeded");
    this.name = "BudgetExceededError";
  }
}

export interface PendingMigrationMember {
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  legacyPath: string;
  destinationPath: string;
  /** Recorded private staging operation ID under `<projectDir>/.migration-staging/<opId>`. */
  stagingOpId?: string;
}

export interface PendingMigrationUnit {
  unitKey: string;
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  /** Canonical repository root recorded when the pending entry was created (optional in older state files). */
  repoRoot?: string;
  /** Owning chat session ID recorded when the pending entry was created (optional in older state files). */
  ownerChat?: string | null;
  members: PendingMigrationMember[];
}

export interface RecordedBridgeEntry {
  legacyPath: string;
  target: string;
  createdAt: number;
}

export interface MigrationStateFile {
  version: 1;
  reportedUnknownEntries: string[];
  pendingUnits: PendingMigrationUnit[];
  /** Provenance records for unit-level migration bridges created or adopted by the engine. */
  bridges?: RecordedBridgeEntry[];
}

export interface ShadowedFileRecord {
  canonicalPath: string;
  preservedPath: string;
}

export interface WalkedDirEntry {
  relPath: string;
  absPath: string;
  mode: number;
}

export interface WalkedDir {
  /** POSIX-style relative paths of subdirectories, parent before child. */
  dirs: string[];
  /** Regular files sorted deterministically by POSIX relPath. */
  files: WalkedDirEntry[];
}

/** `lstatSync` returning null only for ENOENT/ENOTDIR; permission and I/O errors propagate. */
export function safeLstat(absPath: string): Stats | null {
  try {
    return lstatSync(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/** BigInt `lstatSync` returning null only for ENOENT/ENOTDIR; permission and I/O errors propagate. */
export function safeLstatBigInt(absPath: string): BigIntStats | null {
  try {
    return lstatSync(absPath, { bigint: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw err;
  }
}

/** Walks a real directory strictly without swallowing EACCES or following symlinks. */
export function walkDirStrict(rootDir: string, prefix = "", checkBudget?: () => void): WalkedDir {
  checkBudget?.();
  const dirs: string[] = [];
  const files: WalkedDirEntry[] = [];
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (let i = 0; i < entries.length; i++) {
    if ((i & 31) === 0) checkBudget?.();
    const entry = entries[i]!;
    const abs = join(rootDir, entry.name);
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to migrate symlink inside unit directory: ${abs}`);
    }
    if (st.isDirectory()) {
      dirs.push(rel);
      const nested = walkDirStrict(abs, rel, checkBudget);
      dirs.push(...nested.dirs);
      files.push(...nested.files);
    } else if (st.isFile()) {
      files.push({ relPath: rel, absPath: abs, mode: st.mode & 0o777 });
    } else {
      throw new Error(`Refusing to migrate non-regular entry inside unit directory: ${abs}`);
    }
  }
  return { dirs, files };
}

/** Verifies every directory and regular file in a legacy unit is readable before moving or renaming. */
export function verifyUnitReadable(legacyPath: string, isDir: boolean, checkBudget?: () => void): void {
  checkBudget?.();
  const st = lstatSync(legacyPath);
  if (st.isSymbolicLink()) {
    throw new Error(`Expected real ${isDir ? "directory" : "file"} at ${legacyPath}, found symlink`);
  }
  if (isDir) {
    if (!st.isDirectory()) {
      throw new Error(`Expected directory at ${legacyPath}`);
    }
    const walked = walkDirStrict(legacyPath, "", checkBudget);
    for (let i = 0; i < walked.files.length; i++) {
      if ((i & 31) === 0) checkBudget?.();
      const file = walked.files[i]!;
      const fd = openSync(file.absPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      closeSync(fd);
    }
  } else {
    if (!st.isFile()) {
      throw new Error(`Expected regular file at ${legacyPath}`);
    }
    const fd = openSync(legacyPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    closeSync(fd);
  }
}

/** Hashes a regular file synchronously using pinned O_NOFOLLOW with optional chunk-level budget checks, returning its identity. */
function hashRegularFileWithIdentity(
  absPath: string,
  checkBudget?: () => void,
): { sha256: string; bytes: number; identity: FileIdentity } {
  let fd: number | null = null;
  try {
    const resolved = resolve(absPath);
    const preStat = lstatSync(resolved, { bigint: true });
    if (preStat.isSymbolicLink() || !preStat.isFile()) {
      throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
    }
    if (realpathSync(resolved) !== resolved) {
      throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
    }
    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fdStat = fstatSync(fd, { bigint: true });
    if (!fdStat.isFile()) {
      throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
    }
    const pathStat = lstatSync(resolved, { bigint: true });
    if (
      pathStat.isSymbolicLink() ||
      fdStat.dev !== pathStat.dev ||
      fdStat.ino !== pathStat.ino ||
      realpathSync(resolved) !== resolved
    ) {
      throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
    }
    if (fdStat.size > BigInt(MAX_MIGRATE_HASH_BYTES)) {
      throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let total = 0;
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_MIGRATE_HASH_BYTES) {
        throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
      }
      hash.update(chunk.subarray(0, bytesRead));
      if (bytesRead === chunk.length) {
        checkBudget?.();
      }
    }
    return {
      sha256: hash.digest("hex"),
      bytes: total,
      identity: {
        ino: fdStat.ino.toString(),
        size: fdStat.size.toString(),
        mtimeNs: fdStat.mtimeNs.toString(),
      },
    };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/** Hashes a regular file synchronously using pinned O_NOFOLLOW with optional chunk-level budget checks; throws on failure. */
export function hashRegularFileStrict(absPath: string, checkBudget?: () => void): { sha256: string; bytes: number } {
  if (!checkBudget) {
    const res = hashFileSha256Sync(absPath, { maxBytes: MAX_MIGRATE_HASH_BYTES });
    if (!res) {
      throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
    }
    return res;
  }
  const { sha256, bytes } = hashRegularFileWithIdentity(absPath, checkBudget);
  return { sha256, bytes };
}

/** Copies a regular file to an exclusive new destination path without following symlinks, returning source identity and SHA-256. */
function copyFileAndHashExclusive(
  srcPath: string,
  dstPath: string,
  mode?: number,
  checkBudget?: () => void,
): { sha256: string; bytes: number; size: string; mtimeNs: string; ino: string; dev: string } {
  const srcFd = openSync(srcPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let dstFd: number | null = null;
  let created = false;
  try {
    const srcStat = fstatSync(srcFd, { bigint: true });
    if (!srcStat.isFile()) {
      throw new Error(`Refusing to copy non-regular file: ${srcPath}`);
    }
    // Ensure owner read+write bits so verification and future cleanup always work on the copy.
    const fileMode = ((mode ?? Number(srcStat.mode)) & 0o777) | 0o600;
    dstFd = openSync(
      dstPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      fileMode,
    );
    created = true;
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
    let totalBytes = 0;
    while (true) {
      let bytesRead: number;
      try {
        bytesRead = readSync(srcFd, buf, 0, buf.length, null);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EINTR" || code === "EAGAIN") continue;
        throw err;
      }
      if (bytesRead === 0) break;
      hash.update(buf.subarray(0, bytesRead));
      totalBytes += bytesRead;
      let writtenTotal = 0;
      while (writtenTotal < bytesRead) {
        let written: number;
        try {
          written = writeSync(dstFd, buf, writtenTotal, bytesRead - writtenTotal);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EINTR" || code === "EAGAIN") continue;
          throw err;
        }
        if (written <= 0) throw new Error(`Short write while copying ${srcPath} to ${dstPath}`);
        writtenTotal += written;
      }
      if (bytesRead === buf.length) {
        checkBudget?.();
      }
    }
    fsyncSync(dstFd);
    return {
      sha256: hash.digest("hex"),
      bytes: totalBytes,
      size: srcStat.size.toString(),
      mtimeNs: srcStat.mtimeNs.toString(),
      ino: srcStat.ino.toString(),
      dev: srcStat.dev.toString(),
    };
  } catch (err) {
    if (dstFd !== null) {
      try {
        closeSync(dstFd);
      } catch {
        // Keep original copy error.
      }
      dstFd = null;
    }
    if (created) {
      try {
        rmSync(dstPath, { force: true });
      } catch {
        // Keep original copy error.
      }
    }
    throw err;
  } finally {
    try {
      closeSync(srcFd);
    } catch {
      // Ignore close error on read descriptor.
    }
    if (dstFd !== null) {
      closeSync(dstFd);
    }
  }
}

/** Copies a regular file to an exclusive new destination path without following symlinks. */
export function copyFileExclusive(srcPath: string, dstPath: string, mode?: number, checkBudget?: () => void): void {
  copyFileAndHashExclusive(srcPath, dstPath, mode, checkBudget);
}

/** Ensures parent directories of `targetPath` under `trustedRoot` exist segment-wise without following symlinks. */
export function ensureParentDirsUnderRoot(trustedRoot: string, targetPath: string): void {
  const parent = dirname(targetPath);
  if (parent === trustedRoot) return;
  if (!isWithin(trustedRoot, parent)) {
    throw new Error(`Destination parent ${parent} is outside trusted root ${trustedRoot}`);
  }
  const rel = relative(trustedRoot, parent);
  const segments = rel.split(sep).filter((s) => s.length > 0 && s !== ".");
  ensureDirsUnderRoot(trustedRoot, segments, (badPath) => {
    return new Error(`Refusing to traverse symlink or non-directory while creating destination: ${badPath}`);
  });
}

/** Generates a cryptographically random staging operation ID. */
export function generateStagingOpId(): string {
  return randomBytes(16).toString("hex");
}

/** True when `opId` is a safe single-segment staging operation ID. */
export function isValidStagingOpId(opId: unknown): opId is string {
  return typeof opId === "string" && SAFE_STAGING_OP_ID_RE.test(opId);
}

/** Returns `<projectDir>/.migration-staging/<opId>` after validating `opId`. */
export function privateStageDir(projectDir: string, opId: string): string {
  if (!isValidStagingOpId(opId)) {
    throw new Error(`Invalid staging operation ID: ${String(opId)}`);
  }
  return join(projectDir, MIGRATION_STAGING_DIR, opId);
}

/** Returns `<projectDir>/.migration-staging/<opId>/payload` after validating `opId`. */
export function privateStagePayloadPath(projectDir: string, opId: string): string {
  return join(privateStageDir(projectDir, opId), "payload");
}

/** Ensures `<projectDir>/.migration-staging/<opId>` exists as real directories without following symlinks. */
export function ensurePrivateStageDir(projectDir: string, opId: string): string {
  if (!isValidStagingOpId(opId)) {
    throw new Error(`Invalid staging operation ID: ${String(opId)}`);
  }
  const stageDir = ensureDirsUnderRoot(projectDir, [MIGRATION_STAGING_DIR, opId], (badPath) => {
    return new Error(`Refusing to traverse symlink or non-directory while creating private stage: ${badPath}`);
  });
  if (!stageDir) {
    throw new Error(`Failed to create private stage directory for opId ${opId}`);
  }
  return stageDir;
}

/**
 * Removes ONLY a private stage directory `<projectDir>/.migration-staging/<opId>` that was recorded in
 * `migration-state.json`. Never follows symlinks and never touches unrecorded sibling directories.
 */
export function removeRecordedStageDir(projectDir: string, opId: string): void {
  if (!isValidStagingOpId(opId)) return;
  if (!isRealDirUnderRoot(projectDir, [MIGRATION_STAGING_DIR])) return;
  const stagingRoot = join(projectDir, MIGRATION_STAGING_DIR);
  const stageDir = join(stagingRoot, opId);
  const st = safeLstat(stageDir);
  if (st && !st.isSymbolicLink()) {
    rmSync(stageDir, { recursive: true, force: true });
  }
  tryRmdirIfEmpty(stagingRoot);
}

/**
 * Lists entries inside `<projectDir>/.migration-staging/` that are not named by any pending unit record in `state`.
 * Read-only; never removes or mutates anything.
 */
export function listUnrecordedStagingEntries(projectDir: string, state: MigrationStateFile): string[] {
  if (!isRealDirUnderRoot(projectDir, [MIGRATION_STAGING_DIR])) return [];
  const recordedOpIds = new Set<string>();
  for (const unit of state.pendingUnits) {
    for (const member of unit.members) {
      if (isValidStagingOpId(member.stagingOpId)) {
        recordedOpIds.add(member.stagingOpId);
      }
    }
  }
  const stagingRoot = join(projectDir, MIGRATION_STAGING_DIR);
  try {
    return readdirSync(stagingRoot)
      .filter((name) => !recordedOpIds.has(name))
      .sort()
      .map((name) => join(stagingRoot, name));
  } catch {
    return [];
  }
}

/** Reads valid manifest entries from `<stageDir>/manifest.jsonl`. Ignores any truncated trailing line. */
export function readStageManifest(stageDir: string): Map<string, StageManifestEntry> {
  const out = new Map<string, StageManifestEntry>();
  const manifestPath = join(stageDir, STAGE_MANIFEST_FILE);
  const st = safeLstat(manifestPath);
  if (!st || st.isSymbolicLink() || !st.isFile()) return out;
  let text: string;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<StageManifestEntry>;
      if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.relPath === "string" &&
        typeof parsed.size === "string" &&
        typeof parsed.mtimeNs === "string" &&
        typeof parsed.ino === "string" &&
        typeof parsed.sha256 === "string"
      ) {
        out.set(parsed.relPath, {
          relPath: parsed.relPath,
          size: parsed.size,
          mtimeNs: parsed.mtimeNs,
          ino: parsed.ino,
          ...(typeof parsed.dev === "string" ? { dev: parsed.dev } : {}),
          sha256: parsed.sha256,
        });
      }
    } catch {
      // Ignore truncated line left by an interrupted append.
    }
  }
  return out;
}

function appendStageManifestEntry(stageDir: string, entry: StageManifestEntry): void {
  const manifestPath = join(stageDir, STAGE_MANIFEST_FILE);
  const fd = openSync(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
  try {
    const buf = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    let offset = 0;
    while (offset < buf.length) {
      const n = writeSync(fd, buf, offset, buf.length - offset);
      if (n <= 0) throw new Error(`Short write appending stage manifest at ${manifestPath}`);
      offset += n;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function sourceMatchesManifestEntry(srcStat: BigIntStats, entry: StageManifestEntry): boolean {
  return (
    entry.ino === srcStat.ino.toString() &&
    entry.size === srcStat.size.toString() &&
    entry.mtimeNs === srcStat.mtimeNs.toString()
  );
}

/**
 * Resumable staged copy from `legacyPath` into `<stageDir>/payload`, backed by `<stageDir>/manifest.jsonl`.
 * Keeps staged files across passes: a later pass trusts a manifest entry when the source `lstat` identity
 * `(ino, size, mtimeNs)` is unchanged and the staged file has the recorded size, and continues with the next file.
 */
export function copyToStaging(
  legacyPath: string,
  stageDir: string,
  isDir: boolean,
  checkBudget: () => void,
): StagedCopyResult {
  const payloadPath = join(stageDir, "payload");
  const manifestPath = join(stageDir, STAGE_MANIFEST_FILE);
  const existingPayload = safeLstat(payloadPath);

  // If an existing payload has the wrong file/dir type (e.g. reused after corruption), reset the private stage.
  if (
    existingPayload &&
    (existingPayload.isSymbolicLink() || (isDir ? !existingPayload.isDirectory() : !existingPayload.isFile()))
  ) {
    rmSync(payloadPath, { recursive: true, force: true });
    rmSync(manifestPath, { force: true });
  }

  const manifest = readStageManifest(stageDir);

  if (!isDir) {
    checkBudget();
    const srcStat = lstatSync(legacyPath, { bigint: true });
    if (srcStat.isSymbolicLink() || !srcStat.isFile()) {
      throw new Error(`Expected regular file at ${legacyPath}`);
    }
    const prev = manifest.get("");
    const dstStat = safeLstatBigInt(payloadPath);
    if (
      prev &&
      sourceMatchesManifestEntry(srcStat, prev) &&
      dstStat &&
      !dstStat.isSymbolicLink() &&
      dstStat.isFile() &&
      dstStat.size.toString() === prev.size
    ) {
      return { manifest, dirs: [] };
    }
    if (dstStat) {
      rmSync(payloadPath, { force: true });
    }
    const copied = copyFileAndHashExclusive(legacyPath, payloadPath, Number(srcStat.mode) & 0o777, checkBudget);
    const verified = hashRegularFileStrict(payloadPath, checkBudget);
    if (verified.sha256 !== copied.sha256 || verified.bytes !== copied.bytes) {
      rmSync(payloadPath, { force: true });
      throw new Error(`SHA-256 mismatch while staging file ${legacyPath}`);
    }
    const entry: StageManifestEntry = {
      relPath: "",
      size: copied.size,
      mtimeNs: copied.mtimeNs,
      ino: copied.ino,
      dev: copied.dev,
      sha256: copied.sha256,
    };
    appendStageManifestEntry(stageDir, entry);
    manifest.set("", entry);
    return { manifest, dirs: [] };
  }

  const walked = walkDirStrict(legacyPath, "", checkBudget);
  checkBudget();
  if (!safeLstat(payloadPath)) {
    mkdirSync(payloadPath);
  }
  for (const relDir of walked.dirs) {
    checkBudget();
    const segs = relDir.split("/").filter((s) => s.length > 0);
    ensureDirsUnderRoot(payloadPath, segs, (badPath) => {
      return new Error(`Invalid directory segment while staging copy: ${badPath}`);
    });
  }

  const expectedFileSet = new Set(walked.files.map((f) => f.relPath));
  for (let i = 0; i < walked.files.length; i++) {
    if ((i & 31) === 0) checkBudget();
    const file = walked.files[i]!;
    const srcStat = lstatSync(file.absPath, { bigint: true });
    if (srcStat.isSymbolicLink() || !srcStat.isFile()) {
      throw new Error(`Refusing to migrate non-regular entry inside unit directory: ${file.absPath}`);
    }
    const dstFile = join(payloadPath, ...file.relPath.split("/"));
    const prev = manifest.get(file.relPath);
    const dstStat = safeLstatBigInt(dstFile);
    if (
      prev &&
      sourceMatchesManifestEntry(srcStat, prev) &&
      dstStat &&
      !dstStat.isSymbolicLink() &&
      dstStat.isFile() &&
      dstStat.size.toString() === prev.size
    ) {
      continue;
    }
    checkBudget();
    if (dstStat) {
      rmSync(dstFile, { recursive: true, force: true });
    }
    const copied = copyFileAndHashExclusive(file.absPath, dstFile, file.mode, checkBudget);
    const verified = hashRegularFileStrict(dstFile, checkBudget);
    if (verified.sha256 !== copied.sha256 || verified.bytes !== copied.bytes) {
      rmSync(dstFile, { force: true });
      throw new Error(`SHA-256 mismatch while staging file ${file.absPath}`);
    }
    const entry: StageManifestEntry = {
      relPath: file.relPath,
      size: copied.size,
      mtimeNs: copied.mtimeNs,
      ino: copied.ino,
      dev: copied.dev,
      sha256: copied.sha256,
    };
    appendStageManifestEntry(stageDir, entry);
    manifest.set(file.relPath, entry);
  }

  // Drop manifest keys for files no longer in source (and clean any obsolete staged files inside our private payload).
  for (const key of [...manifest.keys()]) {
    if (!expectedFileSet.has(key)) {
      manifest.delete(key);
      if (key) {
        rmSync(join(payloadPath, ...key.split("/")), { recursive: true, force: true });
      }
    }
  }

  return { manifest, dirs: walked.dirs };
}

/**
 * Verifies every regular file in `legacyPath` matches `targetPath`.
 * When `manifest` is provided (from `copyToStaging`, where every file was hashed and read-back verified
 * before appending to `manifest.jsonl`), entries whose source lstat identity is unchanged and whose target
 * file has the recorded size are verified without re-hashing the whole tree, keeping multi-pass progress bounded.
 */
export function verifyCopyMatches(
  legacyPath: string,
  targetPath: string,
  isDir: boolean,
  checkBudget?: () => void,
  manifest?: ReadonlyMap<string, StageManifestEntry>,
): void {
  if (!isDir) {
    checkBudget?.();
    if (manifest) {
      const entry = manifest.get("");
      const srcStat = lstatSync(legacyPath, { bigint: true });
      const dstStat = lstatSync(targetPath, { bigint: true });
      if (
        entry &&
        !srcStat.isSymbolicLink() &&
        srcStat.isFile() &&
        !dstStat.isSymbolicLink() &&
        dstStat.isFile() &&
        sourceMatchesManifestEntry(srcStat, entry) &&
        dstStat.size.toString() === entry.size
      ) {
        return;
      }
    }
    const legHash = hashRegularFileStrict(legacyPath, checkBudget);
    const dstHash = hashRegularFileStrict(targetPath, checkBudget);
    if (legHash.sha256 !== dstHash.sha256 || legHash.bytes !== dstHash.bytes) {
      throw new Error(`SHA-256 verification mismatch between ${legacyPath} and ${targetPath}`);
    }
    return;
  }

  const legacyWalked = walkDirStrict(legacyPath, "", checkBudget);
  const targetWalked = walkDirStrict(targetPath, "", checkBudget);
  const targetDirSet = new Set(targetWalked.dirs);
  for (const relDir of legacyWalked.dirs) {
    checkBudget?.();
    if (!targetDirSet.has(relDir)) {
      throw new Error(`Verification failed: subdirectory ${relDir} missing at ${targetPath}`);
    }
  }
  const targetSet = new Set(targetWalked.files.map((f) => f.relPath));
  for (let i = 0; i < legacyWalked.files.length; i++) {
    if ((i & 31) === 0) checkBudget?.();
    const file = legacyWalked.files[i]!;
    if (!targetSet.has(file.relPath)) {
      throw new Error(`Verification failed: ${file.relPath} missing at ${targetPath}`);
    }
    const dstFile = join(targetPath, ...file.relPath.split("/"));
    if (manifest) {
      const entry = manifest.get(file.relPath);
      const srcStat = lstatSync(file.absPath, { bigint: true });
      const dstStat = lstatSync(dstFile, { bigint: true });
      if (
        entry &&
        !srcStat.isSymbolicLink() &&
        srcStat.isFile() &&
        !dstStat.isSymbolicLink() &&
        dstStat.isFile() &&
        sourceMatchesManifestEntry(srcStat, entry) &&
        dstStat.size.toString() === entry.size
      ) {
        continue;
      }
    }
    checkBudget?.();
    const legHash = hashRegularFileStrict(file.absPath, checkBudget);
    const dstHash = hashRegularFileStrict(dstFile, checkBudget);
    if (legHash.sha256 !== dstHash.sha256 || legHash.bytes !== dstHash.bytes) {
      throw new Error(`SHA-256 verification mismatch for ${file.relPath} between ${legacyPath} and ${targetPath}`);
    }
  }
}

/** Unlinks `absPath` ONLY if its current `lstat` identity `(ino, size, mtimeNs)` equals `expected`. */
function unlinkIfIdentityMatches(absPath: string, expected: FileIdentity): boolean {
  const st = safeLstatBigInt(absPath);
  if (!st) return true;
  if (
    !st.isSymbolicLink() &&
    st.isFile() &&
    st.ino.toString() === expected.ino &&
    st.size.toString() === expected.size &&
    st.mtimeNs.toString() === expected.mtimeNs
  ) {
    unlinkSync(absPath);
    return true;
  }
  return false;
}

/**
 * Deletes from `legacyPath` ONLY the manifest entries whose current `lstat` identity `(ino, size, mtimeNs)`
 * equals the verified one, and rmdirs ONLY empty verified subdirectories.
 * Any new file, replaced file, or new dir that arrived after verification is left intact and `fullyDeleted` is false.
 */
export function deleteVerifiedLegacy(
  legacyPath: string,
  isDir: boolean,
  manifest: ReadonlyMap<string, StageManifestEntry>,
  verifiedDirs: readonly string[] = [],
): LegacyDeleteResult {
  if (!isDir) {
    const entry = manifest.get("");
    if (!entry) return { fullyDeleted: false, leftoverEntries: 1 };
    const st = safeLstatBigInt(legacyPath);
    if (!st) return { fullyDeleted: true, leftoverEntries: 0 };
    if (st.isSymbolicLink() || !st.isFile()) {
      return { fullyDeleted: false, leftoverEntries: 1 };
    }
    if (sourceMatchesManifestEntry(st, entry)) {
      unlinkSync(legacyPath);
      return { fullyDeleted: true, leftoverEntries: 0 };
    }
    return { fullyDeleted: false, leftoverEntries: 1 };
  }

  const st = safeLstatBigInt(legacyPath);
  if (!st) return { fullyDeleted: true, leftoverEntries: 0 };
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return { fullyDeleted: false, leftoverEntries: 1 };
  }

  let leftoverEntries = 0;
  for (const [relPath, entry] of manifest) {
    if (!relPath) continue;
    const abs = join(legacyPath, ...relPath.split("/"));
    const unlinked = unlinkIfIdentityMatches(abs, {
      ino: entry.ino,
      size: entry.size,
      mtimeNs: entry.mtimeNs,
    });
    if (!unlinked) {
      leftoverEntries++;
    }
  }

  const dirsDeepestFirst = [...verifiedDirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const relDir of dirsDeepestFirst) {
    const dirAbs = join(legacyPath, ...relDir.split("/"));
    try {
      rmdirSync(dirAbs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        leftoverEntries++;
        continue;
      }
      throw err;
    }
  }

  try {
    rmdirSync(legacyPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { fullyDeleted: true, leftoverEntries: 0 };
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
      return { fullyDeleted: false, leftoverEntries: Math.max(1, leftoverEntries) };
    }
    throw err;
  }

  return { fullyDeleted: true, leftoverEntries: 0 };
}

/** Places a newly created temp file at `destFile` without overwriting an existing file. Returns false on EEXIST. */
function linkTempWithoutOverwrite(tempPath: string, destFile: string): boolean {
  try {
    linkSync(tempPath, destFile);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS") {
      try {
        copyFileExclusive(tempPath, destFile);
        return true;
      } catch (wxErr) {
        if ((wxErr as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw wxErr;
      }
    }
    throw err;
  }
}

/** Picks a crash-safe `.pre-merge-<8hex>` sibling path for a shadowed destination file. */
function preserveShadowedDestination(
  destFile: string,
  destHash: { sha256: string; bytes: number },
  checkBudget?: () => void,
): string {
  const shortHex = destHash.sha256.slice(0, 8);
  const baseCandidate = `${destFile}.pre-merge-${shortHex}`;
  let candidate = baseCandidate;
  let suffix = 2;

  while (true) {
    checkBudget?.();
    const existing = safeLstat(candidate);
    if (existing) {
      if (!existing.isSymbolicLink() && existing.isFile()) {
        const existingHash = hashRegularFileStrict(candidate, checkBudget);
        if (existingHash.sha256 === destHash.sha256 && existingHash.bytes === destHash.bytes) {
          // Already preserved with identical content (idempotent resume after crash).
          return candidate;
        }
      }
      candidate = `${baseCandidate}.${suffix}`;
      suffix++;
      continue;
    }

    const temp = join(dirname(destFile), `.${basename(destFile)}.pre-merge.${randomUUID()}.tmp`);
    copyFileExclusive(destFile, temp, undefined, checkBudget);
    try {
      const tempHash = hashRegularFileStrict(temp, checkBudget);
      if (tempHash.sha256 !== destHash.sha256 || tempHash.bytes !== destHash.bytes) {
        throw new Error(`SHA-256 verification failed while preserving shadowed file ${destFile}`);
      }
      if (!linkTempWithoutOverwrite(temp, candidate)) {
        continue;
      }
      fsyncDir(dirname(candidate));
    } finally {
      rmSync(temp, { force: true });
    }
    const verified = hashRegularFileStrict(candidate, checkBudget);
    if (verified.sha256 !== destHash.sha256 || verified.bytes !== destHash.bytes) {
      throw new Error(`Post-link verification failed for shadowed file ${candidate}`);
    }
    return candidate;
  }
}

/**
 * Moves a colliding destination entry (a directory where legacy has a file, or a file where legacy has a directory)
 * to a non-colliding `.pre-merge-<8hex>` sibling via atomic rename. Nothing is deleted.
 */
function preserveCollidingDestinationEntry(destEntry: string, checkBudget?: () => void): string {
  const st = lstatSync(destEntry);
  if (st.isSymbolicLink()) {
    throw new Error(`Refusing to relocate symlink destination entry during merge: ${destEntry}`);
  }
  let shortHex: string;
  if (st.isFile()) {
    shortHex = hashRegularFileStrict(destEntry, checkBudget).sha256.slice(0, 8);
  } else if (st.isDirectory()) {
    const hash = createHash("sha256");
    hash.update("dir\0");
    const walked = walkDirStrict(destEntry, "", checkBudget);
    for (const relDir of walked.dirs) {
      hash.update(`d:${relDir}\0`);
    }
    for (const file of walked.files) {
      checkBudget?.();
      const fh = hashRegularFileStrict(file.absPath, checkBudget);
      hash.update(`f:${file.relPath}:${fh.sha256}\0`);
    }
    shortHex = hash.digest("hex").slice(0, 8);
  } else {
    throw new Error(`Refusing to relocate non-regular/non-directory destination entry during merge: ${destEntry}`);
  }

  const baseCandidate = `${destEntry}.pre-merge-${shortHex}`;
  let candidate = baseCandidate;
  let suffix = 2;
  while (safeLstat(candidate) !== null) {
    checkBudget?.();
    candidate = `${baseCandidate}.${suffix}`;
    suffix++;
  }
  renameSync(destEntry, candidate);
  fsyncDir(dirname(destEntry));
  return candidate;
}

/**
 * Merges one real legacy file into `destFile`:
 * - missing at dest: copy without overwrite, verify, fsync parent, delete legacy only if identity unchanged
 * - dest is a real dir (type collision): rename dest dir to `.pre-merge-<8hex>`, then install legacy file
 * - same hash: delete legacy only if identity unchanged
 * - different content: preserve dest as `<name>.pre-merge-<8hex>`, replace canonical name with legacy, fsync parent,
 *   verify, delete legacy only if identity unchanged
 */
function mergeSingleFile(
  legacyFile: string,
  destFile: string,
  checkBudget?: () => void,
): { shadowed: ShadowedFileRecord | null; unlinked: boolean } {
  const legacyHash = hashRegularFileWithIdentity(legacyFile, checkBudget);
  let destStat = safeLstat(destFile);
  let preservedCollision: ShadowedFileRecord | null = null;

  if (destStat !== null && !destStat.isSymbolicLink() && destStat.isDirectory()) {
    const preservedPath = preserveCollidingDestinationEntry(destFile, checkBudget);
    preservedCollision = { canonicalPath: destFile, preservedPath };
    destStat = safeLstat(destFile);
  }

  if (destStat === null) {
    const temp = join(dirname(destFile), `.${basename(destFile)}.merge-tmp.${randomUUID()}.tmp`);
    copyFileExclusive(legacyFile, temp, undefined, checkBudget);
    try {
      const tempHash = hashRegularFileStrict(temp, checkBudget);
      if (tempHash.sha256 !== legacyHash.sha256 || tempHash.bytes !== legacyHash.bytes) {
        throw new Error(`SHA-256 mismatch while staging merge of ${legacyFile}`);
      }
      const placed = linkTempWithoutOverwrite(temp, destFile);
      if (!placed) {
        // Concurrent creation at destFile; re-run conflict path.
        rmSync(temp, { force: true });
        return mergeSingleFile(legacyFile, destFile, checkBudget);
      }
      fsyncDir(dirname(destFile));
    } finally {
      rmSync(temp, { force: true });
    }
    const verified = hashRegularFileStrict(destFile, checkBudget);
    if (verified.sha256 !== legacyHash.sha256 || verified.bytes !== legacyHash.bytes) {
      throw new Error(`Post-merge verification failed for ${destFile}`);
    }
    const unlinked = unlinkIfIdentityMatches(legacyFile, legacyHash.identity);
    return { shadowed: preservedCollision, unlinked };
  }

  if (destStat.isSymbolicLink() || !destStat.isFile()) {
    throw new Error(`Cannot merge regular file ${legacyFile} into non-file destination ${destFile}`);
  }

  const destHash = hashRegularFileStrict(destFile, checkBudget);
  if (destHash.sha256 === legacyHash.sha256 && destHash.bytes === legacyHash.bytes) {
    const unlinked = unlinkIfIdentityMatches(legacyFile, legacyHash.identity);
    return { shadowed: null, unlinked };
  }

  // Conflict: preserve shadowed dest file first, then atomically replace canonical name with legacy content.
  const preservedPath = preserveShadowedDestination(destFile, destHash, checkBudget);
  const legacyTemp = join(dirname(destFile), `.${basename(destFile)}.merge-tmp.${randomUUID()}.tmp`);
  copyFileExclusive(legacyFile, legacyTemp, undefined, checkBudget);
  try {
    const tempHash = hashRegularFileStrict(legacyTemp, checkBudget);
    if (tempHash.sha256 !== legacyHash.sha256 || tempHash.bytes !== legacyHash.bytes) {
      throw new Error(`SHA-256 mismatch while staging conflict winner ${legacyFile}`);
    }
    renameSync(legacyTemp, destFile);
    fsyncDir(dirname(destFile));
  } finally {
    rmSync(legacyTemp, { force: true });
  }
  const verifiedDest = hashRegularFileStrict(destFile, checkBudget);
  if (verifiedDest.sha256 !== legacyHash.sha256 || verifiedDest.bytes !== legacyHash.bytes) {
    throw new Error(`Post-conflict verification failed for ${destFile}`);
  }
  const unlinked = unlinkIfIdentityMatches(legacyFile, legacyHash.identity);
  return { shadowed: { canonicalPath: destFile, preservedPath }, unlinked };
}

/**
 * Merges a real legacy path into an existing real destination path without losing any file.
 * Deletes legacy files only after their content is SHA-256 verified at the destination and their
 * `lstat` identity `(ino, size, mtimeNs)` is unchanged.
 */
export function mergeBothExist(
  legacyPath: string,
  destPath: string,
  isDir: boolean,
  checkBudget: () => void,
): MergeBothExistResult {
  checkBudget();
  const legStat = lstatSync(legacyPath);
  const dstStat = lstatSync(destPath);
  if (legStat.isSymbolicLink() || dstStat.isSymbolicLink()) {
    throw new Error(`Cannot merge symlinks: ${legacyPath} -> ${destPath}`);
  }
  if (!isDir) {
    if (!legStat.isFile() || !dstStat.isFile()) {
      throw new Error(`Type mismatch merging file unit ${legacyPath} -> ${destPath}`);
    }
    checkBudget();
    const res = mergeSingleFile(legacyPath, destPath, checkBudget);
    return {
      shadowed: res.shadowed ? [res.shadowed] : [],
      fullyMerged: res.unlinked && safeLstat(legacyPath) === null,
    };
  }

  if (!legStat.isDirectory() || !dstStat.isDirectory()) {
    throw new Error(`Type mismatch merging directory unit ${legacyPath} -> ${destPath}`);
  }

  const walked = walkDirStrict(legacyPath, "", checkBudget);
  const shadowed: ShadowedFileRecord[] = [];
  for (const relDir of walked.dirs) {
    checkBudget();
    const segs = relDir.split("/").filter((s) => s.length > 0);
    let cur = destPath;
    for (const seg of segs) {
      if (seg === "." || seg === ".." || seg.includes("\0")) {
        throw new Error(`Invalid directory segment during merge: ${join(cur, seg)}`);
      }
      cur = join(cur, seg);
      const st = safeLstat(cur);
      if (st === null) {
        mkdirSync(cur);
        fsyncDir(dirname(cur));
      } else if (st.isSymbolicLink()) {
        throw new Error(`Refusing to traverse symlink during merge: ${cur}`);
      } else if (st.isFile()) {
        const preservedPath = preserveCollidingDestinationEntry(cur, checkBudget);
        shadowed.push({ canonicalPath: cur, preservedPath });
        mkdirSync(cur);
        fsyncDir(dirname(cur));
      } else if (!st.isDirectory()) {
        throw new Error(`Refusing to traverse non-directory during merge: ${cur}`);
      }
    }
  }

  let anyLeftover = false;
  for (const file of walked.files) {
    checkBudget();
    const dstFile = join(destPath, ...file.relPath.split("/"));
    const res = mergeSingleFile(file.absPath, dstFile, checkBudget);
    if (res.shadowed) shadowed.push(res.shadowed);
    if (!res.unlinked) anyLeftover = true;
  }

  // Remove now-empty verified legacy subdirectories bottom-up, then legacyPath itself;
  // leave anything non-empty intact so the next pass merges new/modified entries.
  const dirsDeepestFirst = [...walked.dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const relDir of dirsDeepestFirst) {
    const dirAbs = join(legacyPath, ...relDir.split("/"));
    try {
      rmdirSync(dirAbs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        anyLeftover = true;
        continue;
      }
      throw err;
    }
  }
  try {
    rmdirSync(legacyPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR") {
        anyLeftover = true;
      } else {
        throw err;
      }
    }
  }
  return { shadowed, fullyMerged: !anyLeftover && safeLstat(legacyPath) === null };
}

/** Creates a unit-level migration bridge symlink at `legacyPath` pointing to `destinationPath`. */
export function createBridgeSymlink(legacyPath: string, destinationPath: string, canonRepo: string): void {
  const existing = safeLstat(legacyPath);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const target = readlinkSync(legacyPath);
      const resolvedTarget = resolve(dirname(legacyPath), target);
      if (resolvedTarget === destinationPath) return;
      throw new Error(`Existing symlink at ${legacyPath} points to ${resolvedTarget}, expected ${destinationPath}`);
    }
    throw new Error(`Refusing to replace existing non-symlink at ${legacyPath} with migration bridge`);
  }
  ensureParentDirsUnderRoot(canonRepo, legacyPath);
  symlinkSync(destinationPath, legacyPath);
}

/**
 * Computes the exact set of valid destination paths for a unit:
 * - owner chat destination
 * - `chats/legacy` destination (or `projectNotesDir` for notes)
 * - existing data-dir location returned by `findExistingDataDirUnit` for the same `(kind, id, taskId)`.
 */
export function computeAllowedUnitDestinations(
  storage: StoragePaths,
  canonRepo: string,
  kind: StorageUnitKind,
  id: string,
  taskId: string | undefined,
  ownerChat: string | null,
): Set<string> {
  const allowed = new Set<string>();
  if (storage.layout !== "data-dir") return allowed;
  try {
    allowed.add(
      unitDataDirDestination(storage, {
        kind,
        repoRoot: canonRepo,
        id,
        ...(taskId !== undefined ? { taskId } : {}),
        chatSessionId: ownerChat,
      }),
    );
  } catch {
    // Invalid unit id.
  }
  try {
    allowed.add(
      unitDataDirDestination(storage, {
        kind,
        repoRoot: canonRepo,
        id,
        ...(taskId !== undefined ? { taskId } : {}),
        chatSessionId: null,
      }),
    );
  } catch {
    // Invalid unit id.
  }
  const existing = findExistingDataDirUnit(storage, canonRepo, kind, id, taskId, ownerChat);
  if (existing) allowed.add(existing);
  return allowed;
}

/**
 * Returns the resolved target if and only if `bridgeTarget` equals an exact destination computed for this unit
 * (owner chat location, `chats/legacy` location, or `findExistingDataDirUnit` for the same kind and id).
 */
export function isValidBridgeTarget(
  storage: StoragePaths,
  canonRepo: string,
  legacyPath: string,
  bridgeTarget: string | null,
  unit: { kind: StorageUnitKind; id: string; taskId?: string; ownerChat: string | null },
): string | null {
  if (!bridgeTarget || storage.layout !== "data-dir") return null;
  const resolved = resolve(dirname(legacyPath), bridgeTarget);
  const allowed = computeAllowedUnitDestinations(
    storage,
    canonRepo,
    unit.kind,
    unit.id,
    unit.taskId,
    unit.ownerChat,
  );
  return allowed.has(resolved) ? resolved : null;
}

/** Finds an existing real copy of a unit anywhere in `<projectDir>` (owner chat first, then legacy, then other chats). */
export function findExistingDataDirUnit(
  storage: StoragePaths,
  canonRepo: string,
  kind: StorageUnitKind,
  id: string,
  taskId: string | undefined,
  ownerChat: string | null,
): string | null {
  if (storage.layout !== "data-dir" || !storage.dataRoot) return null;
  const key = storage.projectKey(canonRepo);
  const projectDir = storage.projectDir(canonRepo);

  if (kind === "note") {
    const parts = id.split("/").filter((s) => s.length > 0 && s !== ".");
    if (parts.length === 0 || parts.some((s) => s === "..")) return null;
    if (isRealFileUnderRoot(storage.dataRoot, ["projects", key, "notes", ...parts])) {
      return join(storage.dataRoot, "projects", key, "notes", ...parts);
    }
    return null;
  }

  const chatOrder = orderedProjectChatNames(projectDir, storage.chatSegment(ownerChat));
  for (const chat of chatOrder) {
    if (kind === "flat_artifact") {
      if (isRealFileUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, "artifacts", id])) {
        return join(storage.dataRoot, "projects", key, "chats", chat, "artifacts", id);
      }
    } else if (kind === "goal") {
      if (isRealDirUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, "goals", id])) {
        return join(storage.dataRoot, "projects", key, "chats", chat, "goals", id);
      }
    } else if (kind === "run") {
      if (isRealDirUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, "artifacts", id])) {
        return join(storage.dataRoot, "projects", key, "chats", chat, "artifacts", id);
      }
    } else if (kind === "bucket_task" && taskId) {
      if (isRealDirUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, "artifacts", id, taskId])) {
        return join(storage.dataRoot, "projects", key, "chats", chat, "artifacts", id, taskId);
      }
    }
  }
  return null;
}

/** Computes the legacy path under `<canonRepo>/.harness` for a unit reference. */
export function legacyPathForUnit(canonRepo: string, kind: StorageUnitKind, id: string, taskId?: string): string {
  switch (kind) {
    case "goal":
      return join(canonRepo, LEGACY_HARNESS_DIR, "goals", id);
    case "run":
      return join(canonRepo, LEGACY_HARNESS_DIR, "artifacts", id);
    case "bucket_task":
      if (!taskId) throw new Error(`bucket_task requires taskId (run: ${id})`);
      return join(canonRepo, LEGACY_HARNESS_DIR, "artifacts", id, taskId);
    case "flat_artifact":
      return join(canonRepo, LEGACY_HARNESS_DIR, "artifacts", id);
    case "note":
      return join(canonRepo, LEGACY_HARNESS_DIR, "notes", ...id.split("/").filter((s) => s.length > 0));
  }
}

/** True when `candidatePath` equals, contains, or lies inside any path in `excludedRoots`. Pure path check. */
export function overlapsAnyPath(candidatePath: string, excludedRoots: readonly string[]): boolean {
  if (excludedRoots.length === 0) return false;
  const resolvedCandidate = resolve(candidatePath);
  for (const root of excludedRoots) {
    if (isEqualOrWithin(root, resolvedCandidate) || isEqualOrWithin(resolvedCandidate, root)) {
      return true;
    }
  }
  return false;
}

/** True when `candidatePath` equals or lies inside any path in `roots`. Pure path check. */
export function isEqualOrWithinAny(candidatePath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  const resolvedCandidate = resolve(candidatePath);
  for (const root of roots) {
    if (isEqualOrWithin(root, resolvedCandidate)) {
      return true;
    }
  }
  return false;
}

function tryRmdirIfEmpty(dirPath: string, excludedRoots?: readonly string[]): boolean {
  if (excludedRoots && excludedRoots.length > 0 && overlapsAnyPath(dirPath, excludedRoots)) {
    return false;
  }
  const st = safeLstat(dirPath);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  try {
    const entries = readdirSync(dirPath);
    if (entries.length > 0) return false;
    rmdirSync(dirPath);
    return true;
  } catch {
    return false;
  }
}

function pruneEmptySubdirsBottomUp(
  rootDir: string,
  removed: string[],
  checkBudget?: () => void,
  excludedRoots?: readonly string[],
): void {
  checkBudget?.();
  if (excludedRoots && excludedRoots.length > 0 && isEqualOrWithinAny(rootDir, excludedRoots)) {
    return;
  }
  const st = safeLstat(rootDir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    checkBudget?.();
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const child = join(rootDir, entry.name);
    if (excludedRoots && excludedRoots.length > 0 && isEqualOrWithinAny(child, excludedRoots)) {
      continue;
    }
    pruneEmptySubdirsBottomUp(child, removed, checkBudget, excludedRoots);
    if (tryRmdirIfEmpty(child, excludedRoots)) {
      removed.push(child);
    }
  }
}

/**
 * Removes ONLY empty container directories under `<canonRepo>/.harness`:
 * - empty subdirectories of `.harness/notes` (never unit dirs)
 * - empty `director-tasks-*` bucket container dirs directly under `.harness/artifacts` (never entering bucket task dirs)
 * - `.harness/goals`, `.harness/artifacts`, `.harness/notes`, `.harness/worktrees`, and `.harness` when empty.
 * Never enters or removes any goal dir, run dir, bucket task dir, or anything below one.
 */
export function cleanupEmptyLegacyDirs(
  canonRepo: string,
  checkBudget?: () => void,
  excludedWorktreeRoots?: readonly string[],
): string[] {
  const removed: string[] = [];
  if (!isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR])) return removed;

  // 1. goals: never enter or remove goal unit dirs; only rmdir the goals container when empty.
  checkBudget?.();
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "goals"])) {
    const goalsDir = join(canonRepo, LEGACY_HARNESS_DIR, "goals");
    if (tryRmdirIfEmpty(goalsDir, excludedWorktreeRoots)) removed.push(goalsDir);
  }

  // 2. artifacts: never enter or remove run dirs or bucket task dirs; only rmdir empty director-tasks-* buckets and artifacts container.
  checkBudget?.();
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "artifacts"])) {
    const artifactsDir = join(canonRepo, LEGACY_HARNESS_DIR, "artifacts");
    let entries: Array<{ name: string; isSymbolicLink(): boolean; isDirectory(): boolean }> = [];
    try {
      entries = readdirSync(artifactsDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      checkBudget?.();
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      if (!isDirectorTaskContainer(entry.name)) continue;
      const bucketDir = join(artifactsDir, entry.name);
      if (tryRmdirIfEmpty(bucketDir, excludedWorktreeRoots)) removed.push(bucketDir);
    }
    if (tryRmdirIfEmpty(artifactsDir, excludedWorktreeRoots)) removed.push(artifactsDir);
  }

  // 3. notes: subdirs under notes are containers (note units are individual files); prune empty subdirs bottom-up.
  checkBudget?.();
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "notes"])) {
    const notesDir = join(canonRepo, LEGACY_HARNESS_DIR, "notes");
    pruneEmptySubdirsBottomUp(notesDir, removed, checkBudget, excludedWorktreeRoots);
    if (tryRmdirIfEmpty(notesDir, excludedWorktreeRoots)) removed.push(notesDir);
  }

  // 4. worktrees: never descend; remove only when empty.
  checkBudget?.();
  const worktreesDir = join(canonRepo, LEGACY_HARNESS_DIR, "worktrees");
  if (tryRmdirIfEmpty(worktreesDir)) removed.push(worktreesDir);

  // 5. .harness root: remove only when empty.
  checkBudget?.();
  const harnessDir = join(canonRepo, LEGACY_HARNESS_DIR);
  if (tryRmdirIfEmpty(harnessDir)) removed.push(harnessDir);

  return removed;
}

/** Reads `<projectDir>/migration-state.json` without creating or writing anything. */
export function readMigrationState(projectDir: string): MigrationStateFile {
  const empty: MigrationStateFile = { version: 1, reportedUnknownEntries: [], pendingUnits: [], bridges: [] };
  const filePath = join(projectDir, MIGRATION_STATE_FILE);
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return empty;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<MigrationStateFile>;
    const reportedUnknownEntries = Array.isArray(raw.reportedUnknownEntries)
      ? raw.reportedUnknownEntries.filter((x): x is string => typeof x === "string")
      : [];
    const pendingUnits = Array.isArray(raw.pendingUnits)
      ? raw.pendingUnits
          .filter(
            (u): u is PendingMigrationUnit =>
              Boolean(u) &&
              typeof u === "object" &&
              typeof u.unitKey === "string" &&
              typeof u.kind === "string" &&
              typeof u.id === "string" &&
              Array.isArray(u.members),
          )
          .map((u) => ({
            unitKey: u.unitKey,
            kind: u.kind,
            id: u.id,
            ...(typeof u.taskId === "string" ? { taskId: u.taskId } : {}),
            ...(typeof u.repoRoot === "string" ? { repoRoot: u.repoRoot } : {}),
            ...(typeof u.ownerChat === "string" || u.ownerChat === null ? { ownerChat: u.ownerChat } : {}),
            members: u.members
              .filter(
                (m): m is PendingMigrationMember =>
                  Boolean(m) &&
                  typeof m === "object" &&
                  typeof m.kind === "string" &&
                  typeof m.id === "string" &&
                  typeof m.legacyPath === "string" &&
                  typeof m.destinationPath === "string",
              )
              .map((m) => ({
                kind: m.kind,
                id: m.id,
                ...(typeof m.taskId === "string" ? { taskId: m.taskId } : {}),
                legacyPath: m.legacyPath,
                destinationPath: m.destinationPath,
                ...(isValidStagingOpId(m.stagingOpId) ? { stagingOpId: m.stagingOpId } : {}),
              })),
          }))
      : [];
    const bridges = Array.isArray(raw.bridges)
      ? raw.bridges
          .filter(
            (b): b is RecordedBridgeEntry =>
              Boolean(b) &&
              typeof b === "object" &&
              typeof b.legacyPath === "string" &&
              typeof b.target === "string" &&
              typeof b.createdAt === "number" &&
              Number.isFinite(b.createdAt),
          )
          .map((b) => ({
            legacyPath: b.legacyPath,
            target: b.target,
            createdAt: b.createdAt,
          }))
      : [];
    return { version: 1, reportedUnknownEntries, pendingUnits, bridges };
  } catch {
    return empty;
  }
}

/** Writes `<projectDir>/migration-state.json` atomically via fsynced temp file + rename + directory fsync. Never touches `project.json`. */
export function writeMigrationStateAtomic(projectDir: string, state: MigrationStateFile): void {
  const target = join(projectDir, MIGRATION_STATE_FILE);
  const existing = safeLstat(target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`Refusing to overwrite non-file migration state path: ${target}`);
  }
  const dedupBridges = new Map<string, RecordedBridgeEntry>();
  for (const b of state.bridges ?? []) {
    if (typeof b.legacyPath === "string" && typeof b.target === "string" && Number.isFinite(b.createdAt)) {
      dedupBridges.set(b.legacyPath, { legacyPath: b.legacyPath, target: b.target, createdAt: b.createdAt });
    }
  }
  const normalized: MigrationStateFile = {
    version: 1,
    reportedUnknownEntries: [...new Set(state.reportedUnknownEntries)].sort(),
    pendingUnits: state.pendingUnits,
    bridges: [...dedupBridges.values()].sort((a, b) => a.legacyPath.localeCompare(b.legacyPath)),
  };
  const payload = Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  const temp = join(projectDir, `.${MIGRATION_STATE_FILE}.${randomUUID()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    let offset = 0;
    while (offset < payload.length) {
      const n = writeSync(fd, payload, offset, payload.length - offset);
      if (n <= 0) throw new Error(`Short write persisting migration state ${temp}`);
      offset += n;
    }
    fsyncSync(fd);
  } catch (err) {
    try {
      closeSync(fd);
    } catch {
      // Keep original error.
    }
    rmSync(temp, { force: true });
    throw err;
  }
  closeSync(fd);
  try {
    renameSync(temp, target);
    fsyncDir(projectDir);
  } finally {
    rmSync(temp, { force: true });
  }
}

function readBridgeTargetSafe(absPath: string): string | null {
  try {
    return readlinkSync(absPath);
  } catch {
    return null;
  }
}

/**
 * Fault-tolerant enumeration of legacy units under `<canonRepo>/.harness`:
 * prefers `storage.enumerateLegacyUnits`, and falls back to per-entry guarded scanning if a chmod-000 subdirectory
 * makes full enumeration throw, reporting the unreadable path without losing other units.
 * Any candidate path that equals, contains, or lies inside `excludedWorktreeRoots` is never returned as a unit;
 * it is collected in `worktreeOverlaps` so it is reported as an unknown leftover and left untouched.
 */
export function enumerateLegacyUnitsSafe(
  storage: StoragePaths,
  canonRepo: string,
  checkBudget?: () => void,
  excludedWorktreeRoots?: readonly string[],
): {
  units: DiscoveredLegacyUnit[];
  worktreeOverlaps: string[];
  errors: Array<{ path: string; message: string }>;
} {
  checkBudget?.();
  const hasExcluded = Boolean(excludedWorktreeRoots && excludedWorktreeRoots.length > 0);
  if (!checkBudget && !hasExcluded) {
    try {
      return { units: storage.enumerateLegacyUnits(canonRepo), worktreeOverlaps: [], errors: [] };
    } catch {
      // Fall back to guarded per-subtree scanning so one unreadable dir never hides readable units.
    }
  }

  const units: DiscoveredLegacyUnit[] = [];
  const worktreeOverlaps: string[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  if (!isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR])) {
    return { units, worktreeOverlaps, errors };
  }

  const makeDest = (kind: StorageUnitKind, id: string, taskId?: string) => (owner?: OwnerRef) =>
    unitDataDirDestination(storage, {
      kind,
      repoRoot: canonRepo,
      id,
      ...(taskId !== undefined ? { taskId } : {}),
      chatSessionId: owner?.chatSessionId ?? null,
    });

  // 1. goals
  checkBudget?.();
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "goals"])) {
    const goalsRoot = join(canonRepo, LEGACY_HARNESS_DIR, "goals");
    if (hasExcluded && isEqualOrWithinAny(goalsRoot, excludedWorktreeRoots!)) {
      worktreeOverlaps.push(goalsRoot);
    } else {
      try {
        const entries = readdirSync(goalsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < entries.length; i++) {
          if ((i & 31) === 0) checkBudget?.();
          const entry = entries[i]!;
          const legacyPath = join(goalsRoot, entry.name);
          const isBridge = entry.isSymbolicLink();
          if (!isBridge && !entry.isDirectory()) continue;
          if (hasExcluded && overlapsAnyPath(legacyPath, excludedWorktreeRoots!)) {
            worktreeOverlaps.push(legacyPath);
            continue;
          }
          units.push({
            kind: "goal",
            repoRoot: canonRepo,
            id: entry.name,
            legacyPath,
            isBridge,
            bridgeTarget: isBridge ? readBridgeTargetSafe(legacyPath) : null,
            destinationFor: makeDest("goal", entry.name),
          });
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        errors.push({ path: goalsRoot, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // 2. artifacts
  checkBudget?.();
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "artifacts"])) {
    const artifactsRoot = join(canonRepo, LEGACY_HARNESS_DIR, "artifacts");
    if (hasExcluded && isEqualOrWithinAny(artifactsRoot, excludedWorktreeRoots!)) {
      worktreeOverlaps.push(artifactsRoot);
    } else {
      try {
        const entries = readdirSync(artifactsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (let i = 0; i < entries.length; i++) {
          if ((i & 31) === 0) checkBudget?.();
          const entry = entries[i]!;
          const entryPath = join(artifactsRoot, entry.name);
          const isBridge = entry.isSymbolicLink();
          if (isDirectorTaskContainer(entry.name)) {
            if (!isBridge && entry.isDirectory()) {
              if (hasExcluded && isEqualOrWithinAny(entryPath, excludedWorktreeRoots!)) {
                worktreeOverlaps.push(entryPath);
                continue;
              }
              try {
                const taskEntries = readdirSync(entryPath, { withFileTypes: true }).sort((a, b) =>
                  a.name.localeCompare(b.name),
                );
                for (let j = 0; j < taskEntries.length; j++) {
                  if ((j & 31) === 0) checkBudget?.();
                  const taskEntry = taskEntries[j]!;
                  const taskPath = join(entryPath, taskEntry.name);
                  const taskBridge = taskEntry.isSymbolicLink();
                  if (!taskBridge && !taskEntry.isDirectory()) continue;
                  if (hasExcluded && overlapsAnyPath(taskPath, excludedWorktreeRoots!)) {
                    worktreeOverlaps.push(taskPath);
                    continue;
                  }
                  units.push({
                    kind: "bucket_task",
                    repoRoot: canonRepo,
                    id: entry.name,
                    taskId: taskEntry.name,
                    legacyPath: taskPath,
                    isBridge: taskBridge,
                    bridgeTarget: taskBridge ? readBridgeTargetSafe(taskPath) : null,
                    destinationFor: makeDest("bucket_task", entry.name, taskEntry.name),
                  });
                }
              } catch (err) {
                if (err instanceof BudgetExceededError) throw err;
                errors.push({ path: entryPath, message: err instanceof Error ? err.message : String(err) });
              }
            }
            continue;
          }
          if (hasExcluded && overlapsAnyPath(entryPath, excludedWorktreeRoots!)) {
            worktreeOverlaps.push(entryPath);
            continue;
          }
          if (entry.isDirectory()) {
            units.push({
              kind: "run",
              repoRoot: canonRepo,
              id: entry.name,
              legacyPath: entryPath,
              isBridge: false,
              bridgeTarget: null,
              destinationFor: makeDest("run", entry.name),
            });
          } else if (entry.isFile()) {
            units.push({
              kind: "flat_artifact",
              repoRoot: canonRepo,
              id: entry.name,
              legacyPath: entryPath,
              isBridge: false,
              bridgeTarget: null,
              destinationFor: makeDest("flat_artifact", entry.name),
            });
          } else if (isBridge) {
            const bridgeTarget = readBridgeTargetSafe(entryPath);
            let isDirTarget = false;
            if (bridgeTarget) {
              try {
                isDirTarget = lstatSync(resolve(dirname(entryPath), bridgeTarget)).isDirectory();
              } catch {
                isDirTarget = !/\.[a-zA-Z0-9_-]{1,16}$/.test(entry.name);
              }
            }
            const kind: StorageUnitKind = isDirTarget ? "run" : "flat_artifact";
            units.push({
              kind,
              repoRoot: canonRepo,
              id: entry.name,
              legacyPath: entryPath,
              isBridge: true,
              bridgeTarget,
              destinationFor: makeDest(kind, entry.name),
            });
          }
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        errors.push({ path: artifactsRoot, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  // 3. notes
  checkBudget?.();
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "notes"])) {
    const notesRoot = join(canonRepo, LEGACY_HARNESS_DIR, "notes");
    if (hasExcluded && isEqualOrWithinAny(notesRoot, excludedWorktreeRoots!)) {
      worktreeOverlaps.push(notesRoot);
    } else {
      const walkNotes = (dir: string, prefix: string) => {
        checkBudget?.();
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        } catch (err) {
          errors.push({ path: dir, message: err instanceof Error ? err.message : String(err) });
          return;
        }
        for (let i = 0; i < entries.length; i++) {
          if ((i & 31) === 0) checkBudget?.();
          const entry = entries[i]!;
          const entryPath = join(dir, entry.name);
          const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
          const isBridge = entry.isSymbolicLink();
          if (!isBridge && entry.isDirectory()) {
            if (hasExcluded && isEqualOrWithinAny(entryPath, excludedWorktreeRoots!)) {
              worktreeOverlaps.push(entryPath);
              continue;
            }
            walkNotes(entryPath, rel);
          } else if (isBridge || entry.isFile()) {
            if (hasExcluded && overlapsAnyPath(entryPath, excludedWorktreeRoots!)) {
              worktreeOverlaps.push(entryPath);
              continue;
            }
            units.push({
              kind: "note",
              repoRoot: canonRepo,
              id: rel,
              legacyPath: entryPath,
              isBridge,
              bridgeTarget: isBridge ? readBridgeTargetSafe(entryPath) : null,
              destinationFor: makeDest("note", rel),
            });
          }
        }
      };
      walkNotes(notesRoot, "");
    }
  }

  return { units, worktreeOverlaps, errors };
}

export { canonicalPath, isEqualOrWithin, isRealDirUnderRoot, isRealFileUnderRoot, isWithin };
