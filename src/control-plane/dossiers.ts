import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ControlPlaneDb, RunRecord } from "./db.js";
import { writeUniqueFile } from "./ids.js";

export function dossierDirectory(repoRoot: string, ...parts: string[]): string {
  let path = realpathSync(repoRoot);
  for (const part of [".harness", "artifacts", ...parts]) {
    path = join(path, part);
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
    if (!lstatSync(path).isDirectory()) throw new Error(`ENOTDIR: expected a non-symlink artifact directory: ${path}`);
  }
  return join(repoRoot, ".harness", "artifacts", ...parts);
}

export function writeTaskDossier(db: ControlPlaneDb, run: RunRecord, taskId: string, name: string, content: string, summary: string) {
  const dir = dossierDirectory(run.repoRoot, run.id, taskId);
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
  return db.recordArtifact({ runId: run.id, taskId, kind: "dossier", path, summary });
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

/** Writes Code Mode output to a new, never-overwritten `<stem>-<n><ext>` file under .harness/artifacts and indexes it. */
export function writeCodeOutput(db: ControlPlaneDb, run: RunRecord, taskId: string, name: string, json: string) {
  const dir = dossierDirectory(run.repoRoot);
  const { stem, ext } = codeOutputName(name);
  const path = join(dir, writeUniqueFile(dir, stem, ext, json));
  try {
    return db.recordArtifact({ runId: run.id, taskId, kind: "dossier", path, summary: "Code Mode output" }).path;
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

/**
 * Lexical repo-relative path (`.harness/artifacts/...`) of abs, accepting either the raw or the canonical
 * form of repoRoot above `.harness`. Nothing below the repo root is canonicalized.
 */
function artifactRel(repoRoot: string, abs: string): string | null {
  const rawRoot = resolve(repoRoot);
  let realRoot: string;
  try {
    realRoot = realpathSync(rawRoot);
  } catch {
    return null;
  }
  const marker = `${sep}.harness${sep}artifacts${sep}`;
  for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
    const prefix = abs.slice(0, idx) || sep;
    let matches = prefix === rawRoot;
    if (!matches) {
      try {
        matches = realpathSync(prefix) === realRoot;
      } catch {
        matches = false;
      }
    }
    if (!matches) continue;
    const rel = abs.slice(idx + 1);
    if (rel.length <= marker.length - 1 || rel.includes("\0")) return null;
    return rel;
  }
  return null;
}

/** Maps any alias (relative, raw-root absolute, or canonical-root absolute) of a dossier path to its index row. */
export function findRunDossier(
  db: ControlPlaneDb,
  run: RunRecord,
  requested: string,
): { recordedPath: string; rel: string | null } | null {
  const rawRoot = resolve(run.repoRoot);
  const abs = resolve(rawRoot, requested);
  const rel = artifactRel(rawRoot, abs);
  const candidates = [abs];
  if (rel !== null) {
    candidates.push(join(rawRoot, rel));
    try {
      candidates.push(join(realpathSync(rawRoot), rel));
    } catch {
      // Unresolvable root: only the lexical candidates apply.
    }
  }
  for (const candidate of new Set(candidates)) {
    if (db.hasDossier(run.id, candidate)) return { recordedPath: candidate, rel };
  }
  return null;
}

function readArtifact(
  path: string,
  maxChars: unknown,
  offset?: unknown,
  opts?: { label?: string; pinned?: boolean; nonSymlinkError?: string },
) {
  const label = opts?.label ?? path;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP" && opts?.nonSymlinkError) throw new Error(opts.nonSymlinkError);
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
      if (!same) throw new Error(opts.nonSymlinkError ?? `Dossier must be a non-symlink path under .harness/artifacts: ${label}`);
    }
    const raw = readFileSync(fd, "utf8");
    const max = typeof maxChars === "number" && Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 8000;
    const hasOffset = typeof offset === "number" && Number.isFinite(offset);
    const start = hasOffset ? Math.max(0, Math.floor(offset)) : 0;
    const content = raw.slice(start, start + max);
    const hasMore = start + max < raw.length;
    if (hasOffset || hasMore) {
      return { path: label, offset: start, totalChars: raw.length, truncated: hasMore, hasMore, content };
    }
    return { path: label, truncated: false, content };
  } finally {
    closeSync(fd);
  }
}

export function readRunDossier(db: ControlPlaneDb, run: RunRecord, args: Record<string, unknown>) {
  if (typeof args.path !== "string" || !args.path) {
    const taskId = typeof args.task_id === "string" ? args.task_id : undefined;
    return { artifacts: db.listArtifacts(run.id, taskId, 50, "dossier") };
  }
  const found = findRunDossier(db, run, args.path);
  const shown = found?.recordedPath ?? resolve(run.repoRoot, args.path);
  if (!found) throw new Error(`No indexed dossier in this run: ${shown}`);
  const nonSymlink = `Dossier must be a non-symlink path under .harness/artifacts: ${shown}`;
  if (found.rel === null) throw new Error(nonSymlink);
  // Built from the requested path, not from realpath(target): equality below holds only when no component
  // from .harness down to the file is a symlink.
  const expected = join(realpathSync(run.repoRoot), found.rel);
  if (lstatSync(expected).isSymbolicLink() || realpathSync(expected) !== expected) throw new Error(nonSymlink);
  return readArtifact(expected, args.max_chars, args.offset, { label: shown, pinned: true, nonSymlinkError: nonSymlink });
}

export function readWorkspaceArtifact(root: string, requested: string, maxChars: unknown, offset?: unknown) {
  const path = realpathSync(resolve(root, requested));
  const rel = relative(realpathSync(root), path);
  const parts = rel.toLowerCase().split(sep);
  if (isAbsolute(rel) || parts[0] === ".." || parts.includes(".git") || parts.includes(".harness")) {
    throw new Error(`Artifact outside the task workspace: ${requested}`);
  }
  return readArtifact(path, maxChars, offset);
}
