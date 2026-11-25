import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ControlPlaneDb, RunRecord } from "./db.js";
import { SUMMARY_LIMIT } from "./handoffs.js";
import { scanMaxFileIndex, writeUniqueFile } from "./ids.js";
import { REJECTIONS } from "../advisories/rejections.js";
import { hashFileSha256, legacyStoragePaths, type StoragePaths } from "../storage/paths.js";

/**
 * @deprecated Use `StoragePaths.ensureDossierDir` instead.
 * Ensures a dossier directory under the legacy artifacts root and returns its path.
 */
export function dossierDirectory(repoRoot: string, ...parts: string[]): string {
  return legacyStoragePaths.ensureDossierDir({ repoRoot, id: "" }, ...parts);
}

export function writeTaskDossier(
  db: ControlPlaneDb,
  run: RunRecord,
  taskId: string,
  name: string,
  content: string,
  summary: string,
  storage: StoragePaths = legacyStoragePaths,
) {
  const dir = storage.ensureDossierDir(run, run.id, taskId);
  const safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!safeName || safeName === "." || safeName === "..") throw new Error("Invalid artifact name");
  const path = join(dir, safeName);
  const temp = join(dir, randomUUID());
  writeFileSync(temp, content, { flag: "wx", mode: 0o600 });
  try {
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
  return db.recordArtifact({ runId: run.id, taskId, kind: "dossier", path, summary, origin: "agent" });
}

/**
 * Writes harness-generated content to a new, never-overwritten `<stem>-<n><ext>` file in the task's dossier
 * directory (exclusive create, so a task's own artifact of any name is never replaced) and indexes it.
 */
export function writeUniqueTaskDossier(
  db: ControlPlaneDb,
  run: RunRecord,
  taskId: string,
  stem: string,
  ext: string,
  content: string,
  summary: string,
  storage: StoragePaths = legacyStoragePaths,
) {
  const dir = storage.ensureDossierDir(run, run.id, taskId);
  const path = join(dir, writeUniqueFile(dir, stem, ext, content));
  try {
    return db.recordArtifact({ runId: run.id, taskId, kind: "dossier", path, summary });
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/**
 * Bounds a task summary to SUMMARY_LIMIT. A longer text is written in full to a new, never-overwritten
 * `<taskId>-summary-<n>.md` file in the run's artifacts directory and the bounded text ends with a pointer to it.
 * The caller records `overflowPath` as a dossier artifact inside its own transaction.
 */
export function spillSummaryOverflow(
  db: ControlPlaneDb,
  run: RunRecord,
  taskId: string,
  fullText: string,
  storage: StoragePaths = legacyStoragePaths,
): { summary: string; overflowPath?: string; keptChars?: number; totalChars?: number } {
  if (fullText.length <= SUMMARY_LIMIT) return { summary: fullText };
  const artifactsDir = storage.ensureDossierDir(run);
  const stem = `${taskId}-summary`;
  const seqKey = `summary:${taskId}`;
  let allocateIndex: (() => number) | undefined;
  if (typeof db.nextArtifactSeq === "function") {
    if (typeof db.advanceArtifactSeqFloor === "function") {
      // Seed above indices already on disk or recorded in the index (including deleted files).
      const diskMax = scanMaxFileIndex(artifactsDir, stem, ".md");
      const dbMax = typeof db.maxIndexedArtifactSeq === "function" ? db.maxIndexedArtifactSeq(stem, ".md", taskId) : 0;
      db.advanceArtifactSeqFloor(seqKey, Math.max(diskMax, dbMax));
    }
    allocateIndex = () => db.nextArtifactSeq(seqKey);
  }
  const fileName = writeUniqueFile(artifactsDir, stem, ".md", fullText, allocateIndex);
  const overflowPath = resolve(artifactsDir, fileName);
  const isLegacyFile = storage.artifactRel(run, overflowPath) !== null;
  const rel = relative(resolve(run.repoRoot), overflowPath);
  const artifactPath =
    isLegacyFile && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)
      ? rel.split(sep).join("/")
      : overflowPath;
  const pointer = `\n\n[Full summary: ${artifactPath}]`;
  const kept = fullText.slice(0, SUMMARY_LIMIT - pointer.length).trimEnd();
  return {
    summary: kept + pointer,
    overflowPath,
    keptChars: kept.length,
    totalChars: fullText.length,
  };
}

/** Parses a suggested output name into a safe `<stem>`/`<ext>` pair; invalid names degrade to `code-exec`/`.json`. */
function codeOutputName(name: string): { stem: string; ext: string } {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  const rawExt = extname(base);
  const ext = /^\.[a-zA-Z0-9_-]{1,16}$/.test(rawExt) ? rawExt : ".json";
  let stem = base
    .slice(0, base.length - rawExt.length)
    .replace(/-\d+$/, "")
    .replace(/^\.+/, "")
    .slice(0, 96);
  if (!stem) stem = "code-exec";
  return { stem, ext };
}

/**
 * Writes Code Mode output to a new, never-overwritten `spill-<runTag>-<stem>-<n><ext>` file in the run's artifacts
 * directory and indexes it. runTag is a fixed-width hash of the run ID, so distinct runs never share a name prefix,
 * and the `spill-` prefix keeps other writers' names apart. n comes from one global durable sequence, seeded above
 * any index already on disk, and every attempted n is reserved before its file is created, so no name is ever reissued.
 */
export function writeCodeOutput(
  db: ControlPlaneDb,
  run: RunRecord,
  taskId: string,
  name: string,
  json: string,
  storage: StoragePaths = legacyStoragePaths,
) {
  const dir = storage.ensureDossierDir(run);
  const { stem, ext } = codeOutputName(name);
  const runTag = createHash("sha256").update(run.id).digest("hex").slice(0, 16);
  const scopedStem = `spill-${runTag}-${stem}`;
  let allocateIndex: (() => number) | undefined;
  if (typeof db.nextArtifactSeq === "function") {
    if (typeof db.advanceArtifactSeqFloor === "function") {
      // Seed above both files on disk and historical index rows whose files were deleted.
      const diskMax = scanMaxFileIndex(dir, scopedStem, ext);
      const dbMax = typeof db.maxIndexedArtifactSeq === "function" ? db.maxIndexedArtifactSeq(scopedStem, ext) : 0;
      db.advanceArtifactSeqFloor("code-output", Math.max(diskMax, dbMax));
    }
    allocateIndex = () => db.nextArtifactSeq("code-output");
  }
  const path = join(dir, writeUniqueFile(dir, scopedStem, ext, json, allocateIndex));
  try {
    return db.recordArtifact({ runId: run.id, taskId, kind: "dossier", path, summary: "Code Mode output" }).path;
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/** Maps any alias (relative, raw-root absolute, canonical-root absolute, or data-dir absolute) of a dossier path to its index row. */
export function findRunDossier(
  db: ControlPlaneDb,
  run: RunRecord,
  requested: string,
  storage: StoragePaths = legacyStoragePaths,
): { recordedPath: string; rel: string | null; candidates: string[]; artSub?: string | null } | null {
  const rawRoot = resolve(run.repoRoot);
  let realRoot: string | null = null;
  try {
    realRoot = realpathSync(rawRoot);
  } catch {
    realRoot = null;
  }

  // Map legacy paths through resolveLegacyPath first (before any symlink checks) so migrated files and bridges
  // resolve directly to their current data-dir location.
  const mapped = storage.layout === "data-dir" ? storage.resolveLegacyPath(run.repoRoot, requested, run) : null;
  const abs = resolve(rawRoot, requested);
  const directLegacyRel = storage.artifactRel(run, abs);
  const artSub =
    (mapped ? storage.artifactSubPath(run, mapped) : null) ??
    storage.artifactSubPath(run, abs);
  const rel = directLegacyRel ?? (artSub ? storage.legacyArtifactRel(artSub) : null);

  const candidates: string[] = [];
  if (mapped) candidates.push(mapped);
  candidates.push(abs);

  if (artSub && storage.layout === "data-dir") {
    const unionHit = storage.resolveArtifactFile(run, artSub);
    if (unionHit) candidates.push(unionHit.path);
  }
  if (rel !== null) {
    candidates.push(join(rawRoot, rel));
    if (realRoot !== null) {
      candidates.push(join(realRoot, rel));
    }
  }
  if (typeof db.listDistinctDossierPaths === "function" && (rel !== null || artSub !== null)) {
    // Other runs or pre-migration rows may have recorded this file under another root spelling or chat path.
    const suffix = rel !== null ? sep + rel : null;
    for (const path of db.listDistinctDossierPaths()) {
      if (suffix && realRoot !== null && path.endsWith(suffix)) {
        const prefix = path.slice(0, path.length - suffix.length) || sep;
        try {
          if (prefix === rawRoot || realpathSync(prefix) === realRoot) {
            candidates.push(path);
            continue;
          }
        } catch {
          // Unresolvable root spelling: cannot be the same file.
        }
      }
      if (storage.layout === "data-dir" && artSub !== null) {
        const info = storage.dataDirArtifactInfo(run, path);
        if (info && info.subPath === artSub) {
          candidates.push(path);
        }
      }
    }
  }
  const unique = [...new Set(candidates)];
  for (const candidate of unique) {
    if (db.hasDossier(run.id, candidate)) {
      return { recordedPath: candidate, rel, candidates: unique, artSub };
    }
  }
  return null;
}

function readArtifact(
  path: string,
  maxChars: unknown,
  offset?: unknown,
  opts?: { label?: string; pinned?: boolean; nonSymlinkRejection?: () => Error },
) {
  const label = opts?.label ?? path;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP" && opts?.nonSymlinkRejection) throw opts.nonSymlinkRejection();
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Expected a regular artifact file: ${label}`);
    if (opts?.pinned) {
      // Confirm the opened file is still the one at the verified, symlink-free path.
      let same = false;
      try {
        const fdStat = fstatSync(fd, { bigint: true });
        const pathStat = lstatSync(path, { bigint: true });
        same = !pathStat.isSymbolicLink() && fdStat.dev === pathStat.dev && fdStat.ino === pathStat.ino && realpathSync(path) === path;
      } catch {
        same = false;
      }
      if (!same) throw opts.nonSymlinkRejection ? opts.nonSymlinkRejection() : REJECTIONS.dossierSymlink(label);
    }
    const raw = readFileSync(fd, "utf8");
    const max = typeof maxChars === "number" && Number.isFinite(maxChars) ? Math.max(1, Math.floor(maxChars)) : 32000;
    const hasOffset = typeof offset === "number" && Number.isFinite(offset);
    const start = hasOffset ? Math.max(0, Math.floor(offset)) : 0;
    const content = raw.slice(start, start + max);
    const hasMore = start + max < raw.length;
    if (hasOffset || hasMore) {
      return {
        path: label,
        offset: start,
        totalChars: raw.length,
        truncated: hasMore,
        hasMore,
        nextOffset: hasMore ? start + content.length : null,
        content,
      };
    }
    return { path: label, truncated: false, content };
  } finally {
    closeSync(fd);
  }
}

function resolveVerifiedDossierTarget(
  run: RunRecord,
  found: { recordedPath: string; rel: string | null; artSub?: string | null },
  storage: StoragePaths,
): { expected: string; shown: string; realRoot: string } | null {
  const realRoot = realpathSync(run.repoRoot);
  if (storage.layout === "legacy") {
    if (found.rel === null) return null;
    return {
      expected: join(realRoot, found.rel),
      shown: found.recordedPath,
      realRoot,
    };
  }

  // Data-dir layout: resolve through the both-exist union helper first (legacy real unit wins over data-dir;
  // bridge symlinks are never followed).
  const artSub = found.artSub ?? storage.artifactSubPath(run, found.recordedPath);
  if (!artSub) return null;
  const unionHit = storage.resolveArtifactFile(run, artSub);
  if (unionHit) {
    return {
      expected: unionHit.path,
      shown: unionHit.source === "data-dir" ? unionHit.path : found.recordedPath,
      realRoot,
    };
  }

  // Not found as a regular file in either location (missing file or hostile symlink).
  // Fall back to the lexical path under the trusted root so symlink checks produce the exact refusal.
  const dataInfo = storage.dataDirArtifactInfo(run, found.recordedPath);
  if (dataInfo) {
    return {
      expected: dataInfo.canonicalPath,
      shown: dataInfo.canonicalPath,
      realRoot,
    };
  }
  const legacyRel = storage.artifactRel(run, found.recordedPath);
  if (legacyRel) {
    return {
      expected: join(realRoot, legacyRel),
      shown: found.recordedPath,
      realRoot,
    };
  }
  return null;
}

function hasAmbiguousDossierOwnership(
  db: ControlPlaneDb,
  run: RunRecord,
  found: { rel: string | null; artSub?: string | null; candidates: string[] },
  realRoot: string,
  expected: string,
  storage: StoragePaths,
): boolean {
  const ownerPaths = new Set(found.candidates);
  if (typeof db.listDistinctDossierPaths === "function") {
    const suffix = found.rel ? sep + found.rel : null;
    const rawRoot = resolve(run.repoRoot);
    let expectedStat: BigIntStats | null = null;
    try {
      expectedStat = lstatSync(expected, { bigint: true });
    } catch {
      expectedStat = null;
    }
    for (const p of db.listDistinctDossierPaths()) {
      if (suffix && p.endsWith(suffix)) {
        const prefix = p.slice(0, p.length - suffix.length) || sep;
        try {
          if (prefix === rawRoot || realpathSync(prefix) === realRoot) {
            ownerPaths.add(p);
            continue;
          }
        } catch {
          // Unresolvable prefix; still fall through to inode check below.
        }
      }
      if (storage.layout === "data-dir" && found.artSub) {
        const info = storage.dataDirArtifactInfo(run, p);
        if (info && info.subPath === found.artSub) {
          ownerPaths.add(p);
          continue;
        }
      }
      if (expectedStat !== null && !expectedStat.isSymbolicLink()) {
        try {
          const pStat = statSync(p, { bigint: true });
          if (pStat.dev === expectedStat.dev && pStat.ino === expectedStat.ino) ownerPaths.add(p);
        } catch {
          // Unresolvable spelling: cannot be the same file.
        }
      }
    }
  }
  return typeof db.countDossierOwners === "function" && db.countDossierOwners([...ownerPaths]) > 1;
}

export const DEFAULT_MAX_DOSSIER_HASH_BYTES = 32 * 1024 * 1024;

/**
 * Safely hashes an indexed dossier of `run` using pinned, non-blocking, symlink-free regular-file reads
 * with incremental chunked hashing and a byte bound. Returns null for missing, unindexed, symlink, FIFO,
 * non-regular, multi-run ambiguous, or oversized paths without blocking or throwing.
 */
export async function hashRunDossier(
  db: ControlPlaneDb,
  run: RunRecord,
  requested: string,
  opts?: { maxBytes?: number },
  storage: StoragePaths = legacyStoragePaths,
): Promise<{ sha256: string; bytes: number } | null> {
  try {
    const found = findRunDossier(db, run, requested, storage);
    if (!found) return null;
    const target = resolveVerifiedDossierTarget(run, found, storage);
    if (!target) return null;
    if (
      hasAmbiguousDossierOwnership(
        db,
        run,
        { rel: found.rel, artSub: found.artSub, candidates: found.candidates },
        target.realRoot,
        target.expected,
        storage,
      )
    ) {
      return null;
    }
    return await hashFileSha256(target.expected, { maxBytes: opts?.maxBytes ?? DEFAULT_MAX_DOSSIER_HASH_BYTES });
  } catch {
    return null;
  }
}

export function readRunDossier(
  db: ControlPlaneDb,
  run: RunRecord,
  args: Record<string, unknown>,
  storage: StoragePaths = legacyStoragePaths,
) {
  if (typeof args.path !== "string" || !args.path) {
    const rawTaskId = typeof args.task_id === "string" ? args.task_id.trim() : "";
    const taskId = rawTaskId
      ? typeof db.getTask === "function"
        ? (db.getTask(rawTaskId)?.id ?? rawTaskId)
        : rawTaskId
      : undefined;
    const artifacts = db.listArtifacts(run.id, taskId, 50, "dossier");
    if (storage.layout === "data-dir") {
      return {
        artifacts: artifacts.map((a) => ({
          ...a,
          path: storage.resolveLegacyPath(run.repoRoot, a.path, run) ?? a.path,
        })),
      };
    }
    return { artifacts };
  }
  const found = findRunDossier(db, run, args.path, storage);
  const fallbackShown =
    (storage.layout === "data-dir" ? storage.resolveLegacyPath(run.repoRoot, args.path, run) : null) ??
    resolve(run.repoRoot, args.path);
  if (!found) throw REJECTIONS.dossierNotIndexed(fallbackShown);

  const target = resolveVerifiedDossierTarget(run, found, storage);
  const shown = target?.shown ?? found.recordedPath;
  const nonSymlinkRejection = () => REJECTIONS.dossierSymlink(shown);
  if (!target) throw nonSymlinkRejection();

  // A path indexed by several runs (under any root spelling, or a case alias of the same file) cannot prove which
  // run's bytes it now holds.
  if (
    hasAmbiguousDossierOwnership(
      db,
      run,
      { rel: found.rel, artSub: found.artSub, candidates: found.candidates },
      target.realRoot,
      target.expected,
      storage,
    )
  ) {
    throw REJECTIONS.dossierAmbiguousOwner(shown);
  }
  if (lstatSync(target.expected).isSymbolicLink() || realpathSync(target.expected) !== target.expected) {
    throw nonSymlinkRejection();
  }
  return readArtifact(target.expected, args.max_chars, args.offset, { label: shown, pinned: true, nonSymlinkRejection });
}

export function readWorkspaceArtifact(
  root: string,
  requested: string,
  maxChars: unknown,
  offset?: unknown,
  storage: StoragePaths = legacyStoragePaths,
) {
  // In data-dir layout, map legacy/data-dir paths before resolving symlinks so migration bridges are never followed.
  if (storage.layout === "data-dir") {
    const mapped = storage.resolveLegacyPath(root, requested);
    if (mapped !== null) {
      throw REJECTIONS.artifactOutsideWorkspace(requested);
    }
  }
  const realRoot = realpathSync(root);
  const path = realpathSync(resolve(root, requested));
  const rel = relative(realRoot, path);
  const parts = rel.toLowerCase().split(sep);
  if (
    isAbsolute(rel) ||
    parts[0] === ".." ||
    parts.includes(".git") ||
    storage.containsHarnessDirSegment(rel) ||
    storage.isProtectedWorktreePath(path, realRoot)
  ) {
    throw REJECTIONS.artifactOutsideWorkspace(requested);
  }
  return readArtifact(path, maxChars, offset);
}
