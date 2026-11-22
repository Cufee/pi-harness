import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ControlPlaneDb, RunRecord } from "./db.js";

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

export function writeCodeOutput(db: ControlPlaneDb, run: RunRecord, taskId: string, name: string, json: string) {
  const path = join(dossierDirectory(run.repoRoot), basename(name));
  writeFileSync(path, json, { flag: "wx", mode: 0o600 });
  try {
    return db.recordArtifact({ runId: run.id, taskId, kind: "dossier", path, summary: "Code Mode output" }).path;
  } catch (error) {
    rmSync(path, { force: true });
    throw error;
  }
}

function readArtifact(path: string, maxChars: unknown, offset?: unknown) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Expected a regular artifact file: ${path}`);
    const raw = readFileSync(fd, "utf8");
    const max = typeof maxChars === "number" && Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 8000;
    const hasOffset = typeof offset === "number" && Number.isFinite(offset);
    const start = hasOffset ? Math.max(0, Math.floor(offset)) : 0;
    const content = raw.slice(start, start + max);
    const hasMore = start + max < raw.length;
    if (hasOffset || hasMore) {
      return { path, offset: start, totalChars: raw.length, truncated: hasMore, hasMore, content };
    }
    return { path, truncated: false, content };
  } finally {
    closeSync(fd);
  }
}

export function readRunDossier(db: ControlPlaneDb, run: RunRecord, args: Record<string, unknown>) {
  if (typeof args.path !== "string" || !args.path) {
    const taskId = typeof args.task_id === "string" ? args.task_id : undefined;
    return { artifacts: db.listArtifacts(run.id, taskId, 50, "dossier") };
  }
  const path = resolve(run.repoRoot, args.path);
  if (!db.hasDossier(run.id, path)) throw new Error(`No indexed dossier in this run: ${path}`);
  const rel = relative(run.repoRoot, path);
  if (!rel.startsWith(`.harness${sep}artifacts${sep}`) || realpathSync(path) !== resolve(realpathSync(run.repoRoot), rel)) {
    throw new Error(`Dossier must be a non-symlink path under .harness/artifacts: ${path}`);
  }
  return readArtifact(path, args.max_chars, args.offset);
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
