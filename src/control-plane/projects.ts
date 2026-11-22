import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Database } from "bun:sqlite";
import { friendlyIdCandidates, nextFriendlyId } from "./ids.js";

const execFileAsync = promisify(execFile);

export interface ProjectRecord {
  id: string;
  name: string;
  rootPath: string;
  description: string | null;
  defaultProfileId: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number;
}

export interface ProjectSummary extends ProjectRecord {
  exists: boolean;
  isGit: boolean;
  gitBranch: string | null;
  sessionCount: number;
  activeGoalCount: number;
  activeRunCount: number;
}

export interface ProjectBrowseEntry {
  name: string;
  path: string;
  isGit: boolean;
}

export interface ProjectBrowseResult {
  path: string;
  parentPath: string | null;
  entries: ProjectBrowseEntry[];
}

export const PROJECTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE,
  root_path TEXT NOT NULL UNIQUE,
  description TEXT,
  default_profile_id TEXT,
  default_model TEXT,
  default_effort TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_last_used ON projects(last_used_at DESC);
`;

/** Expands leading `~` or `~/` using the daemon host's home directory (critical over SSH). */
export function expandHomePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return homedir();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homedir(), trimmed.slice(2));
  }
  return trimmed;
}

/** Resolves a path to its canonical realpath when it exists on disk, or an absolute resolved path otherwise. */
export function canonicalProjectPath(rawPath: string): string {
  const expanded = expandHomePath(rawPath);
  const abs = resolve(expanded);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** Fast synchronous check for whether `dirPath` is inside a git repository. */
export function isGitDirectory(dirPath: string): boolean {
  if (!dirPath || !existsSync(dirPath)) return false;
  let cur = dirPath;
  for (let depth = 0; depth < 32; depth++) {
    if (existsSync(join(cur, ".git"))) return true;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return false;
}

async function detectGitBranch(dirPath: string): Promise<string | null> {
  if (!isGitDirectory(dirPath)) return null;
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: dirPath,
      timeout: 3_000,
    });
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

function sanitizeProjectName(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, "-").replace(/[^a-zA-Z0-9._-]/g, "");
  return cleaned || "project";
}

/**
 * Persistent registry of user projects on the daemon host.
 *
 * A project can point to any directory on the daemon host — either a main git repo checkout
 * (where Tier 2 workers allocate isolated worktrees) or a plain workspace folder.
 * Sessions bind to a project by default and can switch between projects at any time.
 */
export class ProjectStore {
  private lastTs = 0;

  constructor(private readonly db: Database) {
    this.db.exec(PROJECTS_SCHEMA);
  }

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastTs = now > this.lastTs ? now : this.lastTs + 1;
    return this.lastTs;
  }

  private mapRow(r: Record<string, unknown>): ProjectRecord {
    return {
      id: String(r.id),
      name: String(r.name),
      rootPath: String(r.root_path),
      description: r.description ? String(r.description) : null,
      defaultProfileId: r.default_profile_id ? String(r.default_profile_id) : null,
      defaultModel: r.default_model ? String(r.default_model) : null,
      defaultEffort: r.default_effort ? String(r.default_effort) : null,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      lastUsedAt: Number(r.last_used_at),
    };
  }

  private pickUniqueName(desired: string): string {
    const base = sanitizeProjectName(desired);
    let candidate = base;
    let suffix = 2;
    while (this.getByName(candidate)) {
      candidate = `${base}-${suffix++}`;
    }
    return candidate;
  }

  getById(id: string): ProjectRecord | null {
    for (const candidate of friendlyIdCandidates(id, "proj")) {
      const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(candidate) as
        | Record<string, unknown>
        | undefined;
      if (row) return this.mapRow(row);
    }
    return null;
  }

  getByName(name: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ? COLLATE NOCASE").get(name.trim()) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  getByPath(rawPath: string): ProjectRecord | null {
    const canon = canonicalProjectPath(rawPath);
    const row = this.db.prepare("SELECT * FROM projects WHERE root_path = ?").get(canon) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  /** Resolves a project by ID (`proj-1` / `1`), name (case-insensitive), or filesystem path. */
  resolveProject(ref: string): ProjectRecord | null {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    return this.getById(trimmed) ?? this.getByName(trimmed) ?? this.getByPath(trimmed);
  }

  getMostRecent(): ProjectRecord | null {
    const row = this.db
      .prepare("SELECT * FROM projects ORDER BY last_used_at DESC, updated_at DESC, rowid DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  touchProject(id: string): void {
    const existing = this.getById(id);
    if (!existing) return;
    this.db.prepare("UPDATE projects SET last_used_at = ? WHERE id = ?").run(this.nextTimestamp(), existing.id);
  }

  /**
   * Registers (and optionally creates, initializes, or clones) a project directory on the daemon host.
   * If a project is already registered at that canonical path, updates optional metadata and returns it.
   */
  async createProject(input: {
    path: string;
    name?: string;
    description?: string;
    createDir?: boolean;
    gitInit?: boolean;
    cloneUrl?: string;
    defaultProfileId?: string | null;
    defaultModel?: string | null;
    defaultEffort?: string | null;
  }): Promise<ProjectRecord> {
    const raw = input.path?.trim();
    if (!raw) throw new Error("Project path is required");
    const expanded = resolve(expandHomePath(raw));

    if (input.cloneUrl?.trim()) {
      if (existsSync(expanded) && readdirSync(expanded).length > 0) {
        throw new Error(`Cannot clone into non-empty directory: ${expanded}`);
      }
      mkdirSync(dirname(expanded), { recursive: true });
      await execFileAsync("git", ["clone", input.cloneUrl.trim(), expanded], { timeout: 180_000 });
    } else if (!existsSync(expanded)) {
      if (input.createDir === false) {
        throw new Error(`Directory does not exist: ${expanded}`);
      }
      mkdirSync(expanded, { recursive: true });
    } else {
      const st = statSync(expanded);
      if (!st.isDirectory()) {
        throw new Error(`Project path is not a directory: ${expanded}`);
      }
    }

    if (input.gitInit && !isGitDirectory(expanded)) {
      await execFileAsync("git", ["init", "-b", "main"], { cwd: expanded, timeout: 15_000 });
    }

    const canon = canonicalProjectPath(expanded);
    const existingByPath = this.getByPath(canon);
    if (existingByPath) {
      this.touchProject(existingByPath.id);
      if (input.name || input.description !== undefined || input.defaultProfileId !== undefined) {
        return this.updateProject(existingByPath.id, {
          ...(input.name ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.defaultProfileId !== undefined ? { defaultProfileId: input.defaultProfileId } : {}),
          ...(input.defaultModel !== undefined ? { defaultModel: input.defaultModel } : {}),
          ...(input.defaultEffort !== undefined ? { defaultEffort: input.defaultEffort } : {}),
        });
      }
      return this.getById(existingByPath.id)!;
    }

    const desiredName = input.name?.trim() ? sanitizeProjectName(input.name) : this.pickUniqueName(basename(canon));
    if (input.name?.trim() && this.getByName(desiredName)) {
      throw new Error(`A project named "${desiredName}" already exists`);
    }

    const id = nextFriendlyId(this.db, "proj", "projects");
    const now = this.nextTimestamp();
    this.db
      .prepare(
        `INSERT INTO projects(id, name, root_path, description, default_profile_id, default_model, default_effort, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        desiredName,
        canon,
        input.description?.trim() || null,
        input.defaultProfileId ?? null,
        input.defaultModel ?? null,
        input.defaultEffort ?? null,
        now,
        now,
        now,
      );
    return this.getById(id)!;
  }

  /** Ensures a path has a registered ProjectRecord (used transparently when opening local workspaces). */
  ensureProjectForPath(rawPath: string): ProjectRecord {
    const canon = canonicalProjectPath(rawPath);
    const existing = this.getByPath(canon);
    if (existing) {
      this.touchProject(existing.id);
      return this.getById(existing.id)!;
    }
    const name = this.pickUniqueName(basename(canon));
    const id = nextFriendlyId(this.db, "proj", "projects");
    const now = this.nextTimestamp();
    this.db
      .prepare(
        `INSERT INTO projects(id, name, root_path, description, default_profile_id, default_model, default_effort, created_at, updated_at, last_used_at)
         VALUES (?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(id, name, canon, now, now, now);
    return this.getById(id)!;
  }

  updateProject(
    idOrRef: string,
    patch: Partial<{
      name: string;
      description: string | null;
      defaultProfileId: string | null;
      defaultModel: string | null;
      defaultEffort: string | null;
    }>,
  ): ProjectRecord {
    const existing = this.resolveProject(idOrRef);
    if (!existing) throw new Error(`Unknown project: ${idOrRef}`);
    const nextName = patch.name?.trim() ? sanitizeProjectName(patch.name) : existing.name;
    if (nextName.toLowerCase() !== existing.name.toLowerCase() && this.getByName(nextName)) {
      throw new Error(`A project named "${nextName}" already exists`);
    }
    const now = this.nextTimestamp();
    this.db
      .prepare(
        `UPDATE projects
         SET name = ?, description = ?, default_profile_id = ?, default_model = ?, default_effort = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        nextName,
        patch.description !== undefined ? (patch.description?.trim() || null) : existing.description,
        patch.defaultProfileId !== undefined ? patch.defaultProfileId : existing.defaultProfileId,
        patch.defaultModel !== undefined ? patch.defaultModel : existing.defaultModel,
        patch.defaultEffort !== undefined ? patch.defaultEffort : existing.defaultEffort,
        now,
        existing.id,
      );
    return this.getById(existing.id)!;
  }

  /** Unregisters a project from the daemon database. Never deletes any files on disk. */
  removeProject(idOrRef: string): { removed: boolean; project: ProjectRecord } {
    const existing = this.resolveProject(idOrRef);
    if (!existing) throw new Error(`Unknown project: ${idOrRef}`);
    // Clear foreign-key references on chat_sessions while preserving their repo_root and history
    try {
      this.db.prepare("UPDATE chat_sessions SET project_id = NULL WHERE project_id = ?").run(existing.id);
    } catch {
      // ignore if chat_sessions not yet created
    }
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(existing.id);
    return { removed: true, project: existing };
  }

  async listProjects(): Promise<ProjectSummary[]> {
    const rows = this.db
      .prepare("SELECT * FROM projects ORDER BY last_used_at DESC, updated_at DESC, rowid DESC")
      .all() as Record<string, unknown>[];

    // Pre-aggregate session/goal/run counts safely
    const sessionCounts = new Map<string, number>();
    try {
      const sRows = this.db
        .prepare("SELECT project_id, repo_root, COUNT(*) AS cnt FROM chat_sessions GROUP BY project_id, repo_root")
        .all() as Array<{ project_id: string | null; repo_root: string; cnt: number }>;
      for (const r of sRows) {
        if (r.project_id) sessionCounts.set(r.project_id, (sessionCounts.get(r.project_id) ?? 0) + Number(r.cnt));
        sessionCounts.set(`path:${r.repo_root}`, (sessionCounts.get(`path:${r.repo_root}`) ?? 0) + Number(r.cnt));
      }
    } catch {
      // ignore
    }

    const goalCounts = new Map<string, number>();
    try {
      const gRows = this.db
        .prepare(
          "SELECT repo_root, COUNT(*) AS cnt FROM goals WHERE status IN ('executing','verifying','reviewing','awaiting_human','paused') GROUP BY repo_root",
        )
        .all() as Array<{ repo_root: string; cnt: number }>;
      for (const r of gRows) goalCounts.set(r.repo_root, Number(r.cnt));
    } catch {
      // ignore
    }

    const runCounts = new Map<string, number>();
    try {
      const rRows = this.db
        .prepare("SELECT repo_root, COUNT(*) AS cnt FROM runs WHERE status IN ('active','paused_quota') GROUP BY repo_root")
        .all() as Array<{ repo_root: string; cnt: number }>;
      for (const r of rRows) runCounts.set(r.repo_root, Number(r.cnt));
    } catch {
      // ignore
    }

    return Promise.all(
      rows.map(async (raw) => {
        const rec = this.mapRow(raw);
        const exists = existsSync(rec.rootPath);
        const isGit = exists && isGitDirectory(rec.rootPath);
        const gitBranch = isGit ? await detectGitBranch(rec.rootPath) : null;
        return {
          ...rec,
          exists,
          isGit,
          gitBranch,
          sessionCount: Math.max(sessionCounts.get(rec.id) ?? 0, sessionCounts.get(`path:${rec.rootPath}`) ?? 0),
          activeGoalCount: goalCounts.get(rec.rootPath) ?? 0,
          activeRunCount: runCounts.get(rec.rootPath) ?? 0,
        };
      }),
    );
  }

  /** Lists subdirectories on the daemon host for SSH-friendly remote directory browsing. */
  browseDirectory(rawPath?: string): ProjectBrowseResult {
    const target = canonicalProjectPath(rawPath?.trim() || homedir());
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      throw new Error(`Not a directory: ${target}`);
    }
    const parent = dirname(target);
    const entries: ProjectBrowseEntry[] = [];
    for (const dirent of readdirSync(target, { withFileTypes: true })) {
      if (dirent.name.startsWith(".")) continue;
      if (!dirent.isDirectory()) continue;
      const full = join(target, dirent.name);
      entries.push({
        name: dirent.name,
        path: full,
        isGit: existsSync(join(full, ".git")),
      });
    }
    entries.sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name));
    return {
      path: target,
      parentPath: parent !== target ? parent : null,
      entries: entries.slice(0, 100),
    };
  }
}
