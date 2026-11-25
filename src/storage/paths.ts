import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { REJECTIONS } from "../advisories/rejections.js";
import type { WorktreeConfig } from "../config.js";

export type StorageLayout = "legacy" | "data-dir";

export interface OwnerRef {
  repoRoot: string;
  chatSessionId?: string | null;
}

export interface GoalRef extends OwnerRef {
  id: string;
}

export interface RunRef extends OwnerRef {
  id: string;
}

export type ScratchKind = "_verify" | "_integration";

export interface StoragePathsConfig {
  stateDir?: string;
  worktree?: Pick<WorktreeConfig, "dir" | "extraReadRoots" | "extraWriteRoots">;
  storage?: { dataDir?: string };
}

export interface StoragePathsOptions {
  layout?: StorageLayout;
}

export interface TaskGrantsInput {
  run: RunRef;
  goal?: GoalRef | null;
  writable: boolean;
  workspace?: string;
}

export interface TaskGrants {
  extraReadRoots: string[];
  extraWriteRoots?: string[];
  extraEnv?: Record<string, string>;
  deniedRoots: string[];
  protectedRoots: string[];
}

export interface DirectorNoteRoots {
  root: string;
  allowedWriteRoots: string[];
}

export type DirectorReadDecision = { ok: true } | { ok: false; reason: string };

const HARNESS_DIR = ".harness";
const GOAL_ID_SEGMENT = /^[a-zA-Z0-9._-]+$/;
const LEGACY_DATA_SUBDIRS = new Set(["goals", "notes", "artifacts"]);
const ENV_STORAGE_LAYOUT = "PI_HARNESS_STORAGE_LAYOUT";

let processStorageLayoutRaw: string | undefined = process.env[ENV_STORAGE_LAYOUT];
const pinnedDataRoots = new Map<string, string>();
let configCache = new WeakMap<StoragePathsConfig, Map<StorageLayout, StoragePaths>>();

function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function hasGitSegment(absPath: string): boolean {
  return absPath.split(sep).some((segment) => segment.toLowerCase() === ".git");
}

function hasWorktreeSegmentPair(segments: readonly string[]): boolean {
  return segments.some((segment, i) => segment === HARNESS_DIR && segments[i + 1] === "worktrees");
}

function resolvedExtraWriteRoots(config: StoragePathsConfig): string[] {
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const raw of config.worktree?.extraWriteRoots ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const expanded = expandHome(trimmed);
    const canonical = existsSync(expanded) ? realpathSync(expanded) : expanded;
    if (!seen.has(canonical)) {
      seen.add(canonical);
      resolved.push(canonical);
    }
  }
  return resolved;
}

function parseStorageLayout(raw: string | undefined, source: string): StorageLayout {
  const trimmed = raw?.trim();
  if (!trimmed) return "legacy";
  if (trimmed === "legacy" || trimmed === "data-dir") return trimmed;
  throw new Error(`Invalid storage layout from ${source}: ${JSON.stringify(raw)} (expected "legacy" or "data-dir")`);
}

/** Resolves the active storage layout from an explicit override or the process-start PI_HARNESS_STORAGE_LAYOUT env var. */
export function resolveStorageLayout(override?: StorageLayout): StorageLayout {
  if (override !== undefined) {
    return parseStorageLayout(override, "opts.layout");
  }
  return parseStorageLayout(processStorageLayoutRaw, ENV_STORAGE_LAYOUT);
}

/** Resets pinned data roots, config cache, and process-start layout capture. Intended for tests only. */
export function resetStoragePathsForTest(): void {
  pinnedDataRoots.clear();
  configCache = new WeakMap<StoragePathsConfig, Map<StorageLayout, StoragePaths>>();
  processStorageLayoutRaw = process.env[ENV_STORAGE_LAYOUT];
}

function pinDataRootForConfig(config: StoragePathsConfig): string | null {
  if (!config.stateDir) return null;
  const stateKey = canonicalPath(config.stateDir);
  const existing = pinnedDataRoots.get(stateKey);
  if (existing) return existing;
  const configuredDataDir = config.storage?.dataDir?.trim();
  const dataRoot = configuredDataDir ? canonicalPath(expandHome(configuredDataDir)) : join(stateKey, "data");
  pinnedDataRoots.set(stateKey, dataRoot);
  return dataRoot;
}

/** Owns every harness data path, policy predicate, legacy path mapping, and user-facing path description. */
export class StoragePaths {
  private readonly pinnedDataRoot: string | null;

  constructor(
    private readonly config: StoragePathsConfig,
    readonly layout: StorageLayout,
  ) {
    if (layout === "data-dir") {
      throw new Error('Storage layout "data-dir" is not implemented yet');
    }
    this.pinnedDataRoot = pinDataRootForConfig(config);
  }

  /** Stable per-project key `<basename>-<12 hex sha256(canonical root)>`. */
  projectKey(repoRoot: string): string {
    const canon = canonicalPath(repoRoot);
    const rawBase = basename(canon).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "");
    const label = rawBase || "repo";
    const hash = createHash("sha256").update(canon).digest("hex").slice(0, 12);
    return `${label}-${hash}`;
  }

  /** Project storage root directory. In legacy layout this is `<repo>/.harness`. */
  projectDir(repoRoot: string): string {
    return join(canonicalPath(repoRoot), HARNESS_DIR);
  }

  /** Chat-scoped storage root directory. In legacy layout all chats share `<repo>/.harness`. */
  chatDir(owner: OwnerRef): string {
    return this.projectDir(owner.repoRoot);
  }

  /** Goals root directory for the owner. */
  goalsDir(owner: OwnerRef): string {
    return join(this.chatDir(owner), "goals");
  }

  /** Per-goal evidence directory; throws when `goal.id` is not a single safe path segment. */
  goalEvidenceDir(goal: GoalRef): string {
    if (!GOAL_ID_SEGMENT.test(goal.id) || goal.id === "." || goal.id === "..") {
      throw new Error(`Invalid goal id for evidence directory: ${JSON.stringify(goal.id)}`);
    }
    return join(this.goalsDir(goal), goal.id);
  }

  /** Creates the goal evidence directory segment by segment, refusing symlinks and non-directories; returns null on failure. */
  ensureGoalEvidenceDir(goal: GoalRef): string | null {
    try {
      const target = this.goalEvidenceDir(goal);
      let p = canonicalPath(goal.repoRoot);
      for (const segment of [HARNESS_DIR, "goals", goal.id]) {
        p = join(p, segment);
        try {
          mkdirSync(p);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        }
        if (!lstatSync(p).isDirectory()) return null;
      }
      return target;
    } catch {
      return null;
    }
  }

  /** Artifacts root directory for the owner. Always uses the fixed legacy path (ignores `worktree.artifactsDir`). */
  artifactsDir(owner: OwnerRef): string {
    return join(this.chatDir(owner), "artifacts");
  }

  /** Run-scoped artifacts directory. */
  runArtifactsDir(run: RunRef): string {
    return join(this.artifactsDir(run), run.id);
  }

  /** Task dossier directory inside the run's artifacts directory. */
  taskDossierDir(run: RunRef, taskId: string): string {
    return join(this.runArtifactsDir(run), taskId);
  }

  /**
   * Ensures a dossier directory under the run's artifacts root segment by segment, refusing symlinks and non-directories.
   * Throws `REJECTIONS.dossierInvalidDirectory` when a conflicting file or symlink exists.
   */
  ensureDossierDir(run: RunRef, ...parts: string[]): string {
    const segments = [HARNESS_DIR, "artifacts", ...parts.flatMap((p) => p.split(/[\\/]/).filter((s) => s.length > 0 && s !== "."))];
    let path = realpathSync(run.repoRoot);
    for (const segment of segments) {
      if (segment === "..") throw REJECTIONS.dossierInvalidDirectory(join(path, segment));
      path = join(path, segment);
      try {
        mkdirSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      if (!lstatSync(path).isDirectory()) throw REJECTIONS.dossierInvalidDirectory(path);
    }
    return join(run.repoRoot, HARNESS_DIR, "artifacts", ...parts);
  }

  /**
   * Lexical repo-relative path (`.harness/artifacts/...`) of `absPath` under either the raw or canonical spelling of
   * `run.repoRoot`. Nothing below the repo root is canonicalized.
   */
  artifactRel(run: RunRef, absPath: string): string | null {
    const rawRoot = resolve(run.repoRoot);
    let realRoot: string;
    try {
      realRoot = realpathSync(rawRoot);
    } catch {
      return null;
    }
    const marker = `${sep}${HARNESS_DIR}${sep}artifacts${sep}`;
    for (let idx = absPath.indexOf(marker); idx !== -1; idx = absPath.indexOf(marker, idx + 1)) {
      const prefix = absPath.slice(0, idx) || sep;
      let matches = prefix === rawRoot;
      if (!matches) {
        try {
          matches = realpathSync(prefix) === realRoot;
        } catch {
          matches = false;
        }
      }
      if (!matches) continue;
      const rel = absPath.slice(idx + 1);
      if (rel.length <= marker.length - 1 || rel.includes("\0")) return null;
      return rel;
    }
    return null;
  }

  /** Chat notes directory for the owner. */
  notesDir(owner: OwnerRef): string {
    return join(this.chatDir(owner), "notes");
  }

  /** Project-level notes directory. */
  projectNotesDir(repoRoot: string): string {
    return join(this.projectDir(repoRoot), "notes");
  }

  private legacyWorktreeBaseDir(repoRoot: string): string {
    return resolve(canonicalPath(repoRoot), this.config.worktree?.dir ?? join(HARNESS_DIR, "worktrees"));
  }

  /** Path for a worker worktree checkout. */
  worktreePath(run: RunRef, dirName: string): string {
    return join(this.legacyWorktreeBaseDir(run.repoRoot), run.id, dirName);
  }

  /** Path for a detached scratch worktree (`_verify` or `_integration`). */
  scratchPath(repoRoot: string, kind: ScratchKind, name: string): string {
    return join(this.legacyWorktreeBaseDir(repoRoot), kind, name);
  }

  /** Every root directory under which harness-managed worktrees for `repoRoot` may be registered. */
  managedWorktreeRoots(repoRoot: string): string[] {
    return [this.legacyWorktreeBaseDir(repoRoot)];
  }

  /** Computes the runner request fragment (read/write roots, env, denied/protected roots) for a task. */
  taskGrants(input: TaskGrantsInput): TaskGrants {
    const { run, goal, writable } = input;
    const goalEvDir = goal ? this.ensureGoalEvidenceDir(goal) : null;
    const goalsRoot = this.goalsDir(run);
    const artifactsRoot = this.artifactsDir(run);
    const extraReadRoots = [...new Set([
      goalsRoot,
      artifactsRoot,
      ...(this.config.worktree?.extraReadRoots ?? []),
    ])];
    const extraWriteRoots = goal
      ? writable
        ? [...(goalEvDir ? [goalEvDir] : []), ...(this.config.worktree?.extraWriteRoots ?? [])]
        : undefined
      : [goalsRoot, ...(this.config.worktree?.extraWriteRoots ?? [])];
    const extraEnv = goal
      ? {
          ...(goalEvDir ? { HARNESS_GOAL_EVIDENCE_DIR: goalEvDir } : {}),
          HARNESS_GOAL_ID: goal.id,
          HARNESS_GOALS_DIR: goalsRoot,
          HARNESS_ARTIFACTS_DIR: artifactsRoot,
        }
      : undefined;
    return {
      extraReadRoots,
      extraWriteRoots,
      extraEnv,
      deniedRoots: [],
      protectedRoots: [],
    };
  }

  /** Canonical repo root and writable note roots for the Director's `write_note` tool. */
  directorNoteRoots(owner: OwnerRef): DirectorNoteRoots {
    const root = realpathSync(owner.repoRoot);
    return {
      root,
      allowedWriteRoots: [
        join(root, HARNESS_DIR, "goals"),
        join(root, HARNESS_DIR, "notes"),
        ...resolvedExtraWriteRoots(this.config),
      ],
    };
  }

  /** Evaluates whether the Director may read `absPath` relative to `repoRoot`. */
  directorReadPolicy(repoRoot: string, absPath: string): DirectorReadDecision {
    const root = canonicalPath(repoRoot);
    const target = canonicalPath(absPath);
    const relToRepo = relative(root, target);
    const inRepo = relToRepo !== ".." && !relToRepo.startsWith(`..${sep}`) && !isAbsolute(relToRepo);
    if (inRepo) {
      const parts = relToRepo === "" ? [] : relToRepo.split(sep).map((p) => p.toLowerCase());
      if (parts.includes(".git")) {
        return { ok: false, reason: ".git internals are protected" };
      }
      if (parts[0] === HARNESS_DIR && !LEGACY_DATA_SUBDIRS.has(parts[1] ?? "")) {
        return { ok: false, reason: "harness-internal state and worktrees are protected" };
      }
      return { ok: true };
    }
    const parts = target.split(sep).map((p) => p.toLowerCase());
    if (parts.includes(".git")) {
      return { ok: false, reason: ".git internals are protected" };
    }
    if (hasWorktreeSegmentPair(parts)) {
      return { ok: false, reason: "task worktrees are protected" };
    }
    return { ok: true };
  }

  /**
   * True when `absPath` targets `.git` metadata or a protected worktree path.
   * When `ownWorkspace` is given and `absPath` lies inside it, only segments below `ownWorkspace` trigger the
   * worktree-segment check so a task may access files inside its own worktree checkout.
   */
  isProtectedWorktreePath(absPath: string, ownWorkspace?: string): boolean {
    const absolute = resolve(absPath);
    if (hasGitSegment(absolute)) return true;
    if (ownWorkspace !== undefined) {
      const own = resolve(ownWorkspace);
      const rel = relative(own, absolute);
      if (rel === "") return false;
      if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
        const segments = rel.split(sep).map((segment) => segment.toLowerCase());
        return hasWorktreeSegmentPair(segments);
      }
    }
    const segments = absolute.split(sep).map((segment) => segment.toLowerCase());
    return hasWorktreeSegmentPair(segments);
  }

  /** True when `absPath` targets harness state-dir internals (root, DB, config, install, tools, logs). */
  isStateInternalPath(absPath: string): boolean {
    if (!this.config.stateDir) return false;
    const stateCanon = canonicalPath(this.config.stateDir);
    const target = canonicalPath(absPath);
    if (target === stateCanon) return true;
    if (!isWithin(stateCanon, target)) return false;
    if (this.pinnedDataRoot && isWithin(this.pinnedDataRoot, target)) {
      return false;
    }
    return true;
  }

  /** True when a repo-relative path points at or inside the harness-owned directory. */
  isHarnessOwnedRelPath(rel: string): boolean {
    const normalized = rel.replaceAll("\\", "/").replace(/^\.\//, "");
    return normalized === HARNESS_DIR || normalized.startsWith(`${HARNESS_DIR}/`);
  }

  /** True when any path segment of a relative path is the harness-owned directory name (case-insensitive). */
  containsHarnessDirSegment(rel: string): boolean {
    return rel
      .replaceAll("\\", "/")
      .toLowerCase()
      .split("/")
      .includes(HARNESS_DIR);
  }

  /** Git pathspec that excludes the harness-owned directory from dirty checks. */
  harnessDirtyPathspec(): string {
    return `:!${HARNESS_DIR}`;
  }

  /**
   * Maps a workspace-relative `.harness/{goals,notes,artifacts}/...` path or an absolute `<repo>/.harness/...` path
   * to its current absolute location, or returns `null` if `rawPath` is not a legacy data path for `repoRoot`.
   */
  resolveLegacyPath(repoRoot: string, rawPath: string): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes("\0") || trimmed === "~" || trimmed.startsWith("~/")) return null;
    const rawRoot = resolve(repoRoot);
    const realRoot = canonicalPath(repoRoot);

    if (!isAbsolute(trimmed)) {
      const abs = resolve(rawRoot, trimmed);
      const rel = relative(rawRoot, abs);
      if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
      const parts = rel.split(sep);
      if (parts[0] !== HARNESS_DIR || !LEGACY_DATA_SUBDIRS.has(parts[1] ?? "")) return null;
      return join(realRoot, ...parts);
    }

    const abs = resolve(trimmed);
    for (const root of [realRoot, rawRoot]) {
      const rel = relative(root, abs);
      if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
      const parts = rel.split(sep);
      if (parts[0] !== HARNESS_DIR || !LEGACY_DATA_SUBDIRS.has(parts[1] ?? "")) return null;
      return join(realRoot, ...parts);
    }

    // Also accept another symlink spelling of repoRoot above `.harness/`.
    const marker = `${sep}${HARNESS_DIR}${sep}`;
    for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
      const prefix = abs.slice(0, idx) || sep;
      if (canonicalPath(prefix) !== realRoot) continue;
      const parts = abs.slice(idx + 1).split(sep);
      if (parts[0] !== HARNESS_DIR || !LEGACY_DATA_SUBDIRS.has(parts[1] ?? "")) return null;
      return join(realRoot, ...parts);
    }
    return null;
  }

  /** Relative display label for the artifacts root directory. */
  describeArtifactsRoot(): string {
    return `${HARNESS_DIR}/artifacts`;
  }

  /** Display template for a goal's evidence directory in prompts. */
  describeGoalEvidenceDirTemplate(): string {
    return `<repo>/${HARNESS_DIR}/goals/<goalId>`;
  }

  /** Display text for allowed Director note locations in the Director system prompt. */
  describeDirectorNoteLocation(extraWriteRootsLabel: string): string {
    return `${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/, or a configured extra write root (${extraWriteRootsLabel})`;
  }

  /** Tool description for the Director `write_note` tool (static when `extraRoots` is omitted, dynamic when supplied). */
  describeWriteNoteTool(extraRoots?: readonly string[]): string {
    if (extraRoots === undefined) {
      return `Logged Director note/report writer scoped strictly to \`${HARNESS_DIR}/goals/\`, \`${HARNESS_DIR}/notes/\`, or configured \`extraWriteRoots\` (never writes tracked repository source code).`;
    }
    const hasRoots = extraRoots.length > 0;
    const extraText = hasRoots
      ? `or these configured extraWriteRoots: ${extraRoots.join(", ")}`
      : "no extraWriteRoots configured";
    return hasRoots
      ? `Logged Director note/report writer scoped strictly to \`${HARNESS_DIR}/goals/\`, \`${HARNESS_DIR}/notes/\`, ${extraText} (never writes tracked repository source code).`
      : `Logged Director note/report writer scoped strictly to \`${HARNESS_DIR}/goals/\`, \`${HARNESS_DIR}/notes/\` (${extraText}; never writes tracked repository source code).`;
  }

  /** Input-schema description for the `path` parameter of `write_note`. */
  describeWriteNotePathParam(extraRoots?: readonly string[]): string {
    if (extraRoots === undefined) {
      return `Destination file under ${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/, or extraWriteRoots.`;
    }
    const hasRoots = extraRoots.length > 0;
    const extraText = hasRoots
      ? `or these configured extraWriteRoots: ${extraRoots.join(", ")}`
      : "no extraWriteRoots configured";
    return hasRoots
      ? `Destination file under ${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/, ${extraText}.`
      : `Destination file under ${HARNESS_DIR}/goals/, ${HARNESS_DIR}/notes/ (${extraText}).`;
  }

  /** Alternative guidance text for `REJECTIONS.directorNoteRoot`. */
  describeDirectorNoteRootAlternative(): string {
    return `Write under ${HARNESS_DIR}/goals, ${HARNESS_DIR}/notes, or a configured worktree.extraWriteRoots path. Code changes go through goal_create and goal_commit.`;
  }

  /** Reason text for `REJECTIONS.dossierInvalidDirectory`. */
  describeDossierInvalidDirectoryReason(): string {
    return `Dossiers are stored only in regular directories under ${HARNESS_DIR}/artifacts to keep run artifacts confined.`;
  }

  /** Primary refusal message for `REJECTIONS.dossierSymlink`. */
  describeDossierSymlinkWhat(path: string): string {
    return `Dossier must be a non-symlink path under ${HARNESS_DIR}/artifacts: ${path}.`;
  }
}

/** Returns a `StoragePaths` instance cached per `config` object and layout. */
export function storagePaths(config: StoragePathsConfig, opts?: StoragePathsOptions): StoragePaths {
  const layout = resolveStorageLayout(opts?.layout);
  let byLayout = configCache.get(config);
  if (!byLayout) {
    byLayout = new Map();
    configCache.set(config, byLayout);
  }
  const existing = byLayout.get(layout);
  if (existing) return existing;
  const instance = new StoragePaths(config, layout);
  byLayout.set(layout, instance);
  return instance;
}

/** Creates an uncached legacy-layout `StoragePaths` instance with optional config. */
export function createLegacyStoragePaths(config?: StoragePathsConfig): StoragePaths {
  return new StoragePaths(config ?? {}, "legacy");
}

/** Config-free legacy-layout `StoragePaths` instance used by default parameters and deprecated wrappers. */
export const legacyStoragePaths: StoragePaths = createLegacyStoragePaths();
