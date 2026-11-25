import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  type Stats,
  symlinkSync,
  unlinkSync,
  writeFileSync,
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
}

export interface PendingMigrationUnit {
  unitKey: string;
  kind: StorageUnitKind;
  id: string;
  taskId?: string;
  members: PendingMigrationMember[];
}

export interface MigrationStateFile {
  version: 1;
  reportedUnknownEntries: string[];
  pendingUnits: PendingMigrationUnit[];
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

/** Walks a real directory strictly without swallowing EACCES or following symlinks. */
export function walkDirStrict(rootDir: string, prefix = ""): WalkedDir {
  const dirs: string[] = [];
  const files: WalkedDirEntry[] = [];
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const abs = join(rootDir, entry.name);
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to migrate symlink inside unit directory: ${abs}`);
    }
    if (st.isDirectory()) {
      dirs.push(rel);
      const nested = walkDirStrict(abs, rel);
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
export function verifyUnitReadable(legacyPath: string, isDir: boolean): void {
  const st = lstatSync(legacyPath);
  if (st.isSymbolicLink()) {
    throw new Error(`Expected real ${isDir ? "directory" : "file"} at ${legacyPath}, found symlink`);
  }
  if (isDir) {
    if (!st.isDirectory()) {
      throw new Error(`Expected directory at ${legacyPath}`);
    }
    const walked = walkDirStrict(legacyPath);
    for (const file of walked.files) {
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

/** Hashes a regular file synchronously using pinned O_NOFOLLOW; throws if hashing fails. */
export function hashRegularFileStrict(absPath: string): { sha256: string; bytes: number } {
  const res = hashFileSha256Sync(absPath, { maxBytes: MAX_MIGRATE_HASH_BYTES });
  if (!res) {
    throw new Error(`Failed to verify SHA-256 hash of regular file: ${absPath}`);
  }
  return res;
}

/** Copies a regular file to an exclusive new destination path without following symlinks. */
export function copyFileExclusive(srcPath: string, dstPath: string, mode?: number): void {
  const srcFd = openSync(srcPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let dstFd: number | null = null;
  let created = false;
  try {
    const srcStat = fstatSync(srcFd);
    if (!srcStat.isFile()) {
      throw new Error(`Refusing to copy non-regular file: ${srcPath}`);
    }
    // Ensure owner read+write bits so verification and future cleanup always work on the copy.
    const fileMode = ((mode ?? srcStat.mode) & 0o777) | 0o600;
    dstFd = openSync(
      dstPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      fileMode,
    );
    created = true;
    const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
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
    }
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

/** Removes a stale `<dest>.migrating` path if present (never follows symlinks). */
export function removeStaleStaging(stagingPath: string): void {
  const st = safeLstat(stagingPath);
  if (!st) return;
  rmSync(stagingPath, { recursive: true, force: true });
}

/**
 * Copies `legacyPath` (file or directory) to `stagingPath`, checking `checkBudget` between files.
 * Removes any stale `stagingPath` before starting.
 */
export function copyToStaging(
  legacyPath: string,
  stagingPath: string,
  isDir: boolean,
  checkBudget: () => void,
): void {
  removeStaleStaging(stagingPath);
  if (!isDir) {
    checkBudget();
    const st = lstatSync(legacyPath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Expected regular file at ${legacyPath}`);
    }
    copyFileExclusive(legacyPath, stagingPath, st.mode & 0o777);
    return;
  }

  const walked = walkDirStrict(legacyPath);
  checkBudget();
  mkdirSync(stagingPath);
  for (const relDir of walked.dirs) {
    const segs = relDir.split("/").filter((s) => s.length > 0);
    ensureDirsUnderRoot(stagingPath, segs, (badPath) => {
      return new Error(`Invalid directory segment while staging copy: ${badPath}`);
    });
  }
  for (const file of walked.files) {
    checkBudget();
    const dstFile = join(stagingPath, ...file.relPath.split("/"));
    copyFileExclusive(file.absPath, dstFile, file.mode);
  }
}

/** Verifies every regular file in `legacyPath` matches `targetPath` by SHA-256 and byte length. */
export function verifyCopyMatches(legacyPath: string, targetPath: string, isDir: boolean): void {
  if (!isDir) {
    const legHash = hashRegularFileStrict(legacyPath);
    const dstHash = hashRegularFileStrict(targetPath);
    if (legHash.sha256 !== dstHash.sha256 || legHash.bytes !== dstHash.bytes) {
      throw new Error(`SHA-256 verification mismatch between ${legacyPath} and ${targetPath}`);
    }
    return;
  }

  const legacyWalked = walkDirStrict(legacyPath);
  const targetWalked = walkDirStrict(targetPath);
  const targetDirSet = new Set(targetWalked.dirs);
  for (const relDir of legacyWalked.dirs) {
    if (!targetDirSet.has(relDir)) {
      throw new Error(`Verification failed: subdirectory ${relDir} missing at ${targetPath}`);
    }
  }
  const targetSet = new Set(targetWalked.files.map((f) => f.relPath));
  for (const file of legacyWalked.files) {
    if (!targetSet.has(file.relPath)) {
      throw new Error(`Verification failed: ${file.relPath} missing at ${targetPath}`);
    }
    const dstFile = join(targetPath, ...file.relPath.split("/"));
    const legHash = hashRegularFileStrict(file.absPath);
    const dstHash = hashRegularFileStrict(dstFile);
    if (legHash.sha256 !== dstHash.sha256 || legHash.bytes !== dstHash.bytes) {
      throw new Error(`SHA-256 verification mismatch for ${file.relPath} between ${legacyPath} and ${targetPath}`);
    }
  }
}

/** Deletes a legacy file or directory strictly (only regular files + bottom-up rmdir, never blind recursive rm). */
export function deleteVerifiedLegacy(legacyPath: string, isDir: boolean): void {
  if (!isDir) {
    const st = safeLstat(legacyPath);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Refusing to delete unexpected legacy entry at ${legacyPath}`);
    }
    unlinkSync(legacyPath);
    return;
  }

  const st = safeLstat(legacyPath);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`Refusing to delete unexpected legacy directory at ${legacyPath}`);
  }
  const walked = walkDirStrict(legacyPath);
  for (const file of walked.files) {
    unlinkSync(file.absPath);
  }
  const dirsDeepestFirst = [...walked.dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const relDir of dirsDeepestFirst) {
    rmdirSync(join(legacyPath, ...relDir.split("/")));
  }
  rmdirSync(legacyPath);
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
function preserveShadowedDestination(destFile: string, destHash: { sha256: string; bytes: number }): string {
  const shortHex = destHash.sha256.slice(0, 8);
  const baseCandidate = `${destFile}.pre-merge-${shortHex}`;
  let candidate = baseCandidate;
  let suffix = 2;

  while (true) {
    const existing = safeLstat(candidate);
    if (existing) {
      if (!existing.isSymbolicLink() && existing.isFile()) {
        const existingHash = hashRegularFileStrict(candidate);
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
    copyFileExclusive(destFile, temp);
    try {
      const tempHash = hashRegularFileStrict(temp);
      if (tempHash.sha256 !== destHash.sha256 || tempHash.bytes !== destHash.bytes) {
        throw new Error(`SHA-256 verification failed while preserving shadowed file ${destFile}`);
      }
      if (!linkTempWithoutOverwrite(temp, candidate)) {
        continue;
      }
    } finally {
      rmSync(temp, { force: true });
    }
    const verified = hashRegularFileStrict(candidate);
    if (verified.sha256 !== destHash.sha256 || verified.bytes !== destHash.bytes) {
      throw new Error(`Post-link verification failed for shadowed file ${candidate}`);
    }
    return candidate;
  }
}

/**
 * Merges one real legacy file into `destFile`:
 * - missing at dest: copy without overwrite, verify, delete legacy
 * - same hash: delete legacy
 * - different content: preserve dest as `<name>.pre-merge-<8hex>`, replace canonical name with legacy, verify, delete legacy
 */
function mergeSingleFile(legacyFile: string, destFile: string): ShadowedFileRecord | null {
  const legacyHash = hashRegularFileStrict(legacyFile);
  const destStat = safeLstat(destFile);

  if (destStat === null) {
    const temp = join(dirname(destFile), `.${basename(destFile)}.migrating.${randomUUID()}.tmp`);
    copyFileExclusive(legacyFile, temp);
    try {
      const tempHash = hashRegularFileStrict(temp);
      if (tempHash.sha256 !== legacyHash.sha256 || tempHash.bytes !== legacyHash.bytes) {
        throw new Error(`SHA-256 mismatch while staging merge of ${legacyFile}`);
      }
      const placed = linkTempWithoutOverwrite(temp, destFile);
      if (!placed) {
        // Concurrent creation at destFile; re-run conflict path.
        rmSync(temp, { force: true });
        return mergeSingleFile(legacyFile, destFile);
      }
    } finally {
      rmSync(temp, { force: true });
    }
    const verified = hashRegularFileStrict(destFile);
    if (verified.sha256 !== legacyHash.sha256 || verified.bytes !== legacyHash.bytes) {
      throw new Error(`Post-merge verification failed for ${destFile}`);
    }
    unlinkSync(legacyFile);
    return null;
  }

  if (destStat.isSymbolicLink() || !destStat.isFile()) {
    throw new Error(`Cannot merge regular file ${legacyFile} into non-file destination ${destFile}`);
  }

  const destHash = hashRegularFileStrict(destFile);
  if (destHash.sha256 === legacyHash.sha256 && destHash.bytes === legacyHash.bytes) {
    unlinkSync(legacyFile);
    return null;
  }

  // Conflict: preserve shadowed dest file first, then atomically replace canonical name with legacy content.
  const preservedPath = preserveShadowedDestination(destFile, destHash);
  const legacyTemp = join(dirname(destFile), `.${basename(destFile)}.migrating.${randomUUID()}.tmp`);
  copyFileExclusive(legacyFile, legacyTemp);
  try {
    const tempHash = hashRegularFileStrict(legacyTemp);
    if (tempHash.sha256 !== legacyHash.sha256 || tempHash.bytes !== legacyHash.bytes) {
      throw new Error(`SHA-256 mismatch while staging conflict winner ${legacyFile}`);
    }
    renameSync(legacyTemp, destFile);
  } finally {
    rmSync(legacyTemp, { force: true });
  }
  const verifiedDest = hashRegularFileStrict(destFile);
  if (verifiedDest.sha256 !== legacyHash.sha256 || verifiedDest.bytes !== legacyHash.bytes) {
    throw new Error(`Post-conflict verification failed for ${destFile}`);
  }
  unlinkSync(legacyFile);
  return { canonicalPath: destFile, preservedPath };
}

/**
 * Merges a real legacy path into an existing real destination path without losing any file.
 * Deletes legacy files only after their content is SHA-256 verified at the destination.
 */
export function mergeBothExist(
  legacyPath: string,
  destPath: string,
  isDir: boolean,
  checkBudget: () => void,
): ShadowedFileRecord[] {
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
    const shadowed = mergeSingleFile(legacyPath, destPath);
    return shadowed ? [shadowed] : [];
  }

  if (!legStat.isDirectory() || !dstStat.isDirectory()) {
    throw new Error(`Type mismatch merging directory unit ${legacyPath} -> ${destPath}`);
  }

  const walked = walkDirStrict(legacyPath);
  for (const relDir of walked.dirs) {
    const segs = relDir.split("/").filter((s) => s.length > 0);
    ensureDirsUnderRoot(destPath, segs, (badPath) => {
      return new Error(`Refusing to traverse non-directory during merge: ${badPath}`);
    });
  }

  const shadowed: ShadowedFileRecord[] = [];
  for (const file of walked.files) {
    checkBudget();
    const dstFile = join(destPath, ...file.relPath.split("/"));
    const record = mergeSingleFile(file.absPath, dstFile);
    if (record) shadowed.push(record);
  }

  // Remove now-empty legacy subdirectories bottom-up, then legacyPath itself.
  const dirsDeepestFirst = [...walked.dirs].sort((a, b) => b.split("/").length - a.split("/").length);
  for (const relDir of dirsDeepestFirst) {
    rmdirSync(join(legacyPath, ...relDir.split("/")));
  }
  rmdirSync(legacyPath);
  return shadowed;
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

/** True when `bridgeTarget` points inside this repo's data-dir project storage (notes or chats). */
export function isValidBridgeTarget(storage: StoragePaths, canonRepo: string, legacyPath: string, bridgeTarget: string | null): string | null {
  if (!bridgeTarget || storage.layout !== "data-dir") return null;
  const resolved = resolve(dirname(legacyPath), bridgeTarget);
  const projectDir = storage.projectDir(canonRepo);
  if (!isWithin(projectDir, resolved)) return null;
  const rel = relative(projectDir, resolved).split(sep);
  if (rel[0] === "notes" && rel.length >= 2) return resolved;
  if (rel[0] === "chats" && rel.length >= 4 && Boolean(rel[1]) && (rel[2] === "goals" || rel[2] === "artifacts")) {
    return resolved;
  }
  return null;
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

function tryRmdirIfEmpty(dirPath: string): boolean {
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

function pruneEmptySubdirsBottomUp(rootDir: string, removed: string[]): void {
  const st = safeLstat(rootDir);
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return;
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const child = join(rootDir, entry.name);
    pruneEmptySubdirsBottomUp(child, removed);
    if (tryRmdirIfEmpty(child)) {
      removed.push(child);
    }
  }
}

/**
 * Removes empty subdirectories inside `.harness/{goals,artifacts,notes}`, then removes `.harness/{goals,artifacts,notes}`,
 * `.harness/worktrees` (only when empty, never recursing into worktrees), and `.harness` (only when empty).
 * Never uses recursive deletion and never touches tracked files.
 */
export function cleanupEmptyLegacyDirs(canonRepo: string): string[] {
  const removed: string[] = [];
  if (!isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR])) return removed;

  for (const sub of ["goals", "artifacts", "notes"] as const) {
    const subDir = join(canonRepo, LEGACY_HARNESS_DIR, sub);
    if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, sub])) {
      pruneEmptySubdirsBottomUp(subDir, removed);
      if (tryRmdirIfEmpty(subDir)) removed.push(subDir);
    }
  }

  const worktreesDir = join(canonRepo, LEGACY_HARNESS_DIR, "worktrees");
  if (tryRmdirIfEmpty(worktreesDir)) removed.push(worktreesDir);

  const harnessDir = join(canonRepo, LEGACY_HARNESS_DIR);
  if (tryRmdirIfEmpty(harnessDir)) removed.push(harnessDir);

  return removed;
}

/** Reads `<projectDir>/migration-state.json` without creating or writing anything. */
export function readMigrationState(projectDir: string): MigrationStateFile {
  const empty: MigrationStateFile = { version: 1, reportedUnknownEntries: [], pendingUnits: [] };
  const filePath = join(projectDir, MIGRATION_STATE_FILE);
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) return empty;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as Partial<MigrationStateFile>;
    const reportedUnknownEntries = Array.isArray(raw.reportedUnknownEntries)
      ? raw.reportedUnknownEntries.filter((x): x is string => typeof x === "string")
      : [];
    const pendingUnits = Array.isArray(raw.pendingUnits)
      ? raw.pendingUnits.filter(
          (u): u is PendingMigrationUnit =>
            Boolean(u) &&
            typeof u === "object" &&
            typeof u.unitKey === "string" &&
            typeof u.kind === "string" &&
            typeof u.id === "string" &&
            Array.isArray(u.members),
        )
      : [];
    return { version: 1, reportedUnknownEntries, pendingUnits };
  } catch {
    return empty;
  }
}

/** Writes `<projectDir>/migration-state.json` atomically via temp file + rename. Never touches `project.json`. */
export function writeMigrationStateAtomic(projectDir: string, state: MigrationStateFile): void {
  const target = join(projectDir, MIGRATION_STATE_FILE);
  const existing = safeLstat(target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`Refusing to overwrite non-file migration state path: ${target}`);
  }
  const normalized: MigrationStateFile = {
    version: 1,
    reportedUnknownEntries: [...new Set(state.reportedUnknownEntries)].sort(),
    pendingUnits: state.pendingUnits,
  };
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  const temp = join(projectDir, `.${MIGRATION_STATE_FILE}.${randomUUID()}.tmp`);
  writeFileSync(temp, payload, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temp, target);
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
 */
export function enumerateLegacyUnitsSafe(
  storage: StoragePaths,
  canonRepo: string,
): { units: DiscoveredLegacyUnit[]; errors: Array<{ path: string; message: string }> } {
  try {
    return { units: storage.enumerateLegacyUnits(canonRepo), errors: [] };
  } catch {
    // Fall back to guarded per-subtree scanning so one unreadable dir never hides readable units.
  }

  const units: DiscoveredLegacyUnit[] = [];
  const errors: Array<{ path: string; message: string }> = [];
  if (!isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR])) {
    return { units, errors };
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
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "goals"])) {
    const goalsRoot = join(canonRepo, LEGACY_HARNESS_DIR, "goals");
    try {
      const entries = readdirSync(goalsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const legacyPath = join(goalsRoot, entry.name);
        const isBridge = entry.isSymbolicLink();
        if (!isBridge && !entry.isDirectory()) continue;
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
      errors.push({ path: goalsRoot, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // 2. artifacts
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "artifacts"])) {
    const artifactsRoot = join(canonRepo, LEGACY_HARNESS_DIR, "artifacts");
    try {
      const entries = readdirSync(artifactsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const entryPath = join(artifactsRoot, entry.name);
        const isBridge = entry.isSymbolicLink();
        if (isDirectorTaskContainer(entry.name)) {
          if (!isBridge && entry.isDirectory()) {
            try {
              const taskEntries = readdirSync(entryPath, { withFileTypes: true }).sort((a, b) =>
                a.name.localeCompare(b.name),
              );
              for (const taskEntry of taskEntries) {
                const taskPath = join(entryPath, taskEntry.name);
                const taskBridge = taskEntry.isSymbolicLink();
                if (!taskBridge && !taskEntry.isDirectory()) continue;
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
              errors.push({ path: entryPath, message: err instanceof Error ? err.message : String(err) });
            }
          }
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
      errors.push({ path: artifactsRoot, message: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3. notes
  if (isRealDirUnderRoot(canonRepo, [LEGACY_HARNESS_DIR, "notes"])) {
    const notesRoot = join(canonRepo, LEGACY_HARNESS_DIR, "notes");
    const walkNotes = (dir: string, prefix: string) => {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      } catch (err) {
        errors.push({ path: dir, message: err instanceof Error ? err.message : String(err) });
        return;
      }
      for (const entry of entries) {
        const entryPath = join(dir, entry.name);
        const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
        const isBridge = entry.isSymbolicLink();
        if (!isBridge && entry.isDirectory()) {
          walkNotes(entryPath, rel);
        } else if (isBridge || entry.isFile()) {
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

  return { units, errors };
}

export { canonicalPath, isEqualOrWithin, isRealDirUnderRoot, isRealFileUnderRoot, isWithin };
