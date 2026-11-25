import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { REJECTIONS } from "../advisories/rejections.js";
import type { WorktreeConfig } from "../config.js";
import { isDirectorTaskContainer } from "../control-plane/ids.js";
import {
  canonicalPath,
  ensureDirsUnderRoot,
  expandHome,
  hashFileSha256,
  hashFileSha256Sync,
  isEqualOrWithin,
  isRealDirUnderRoot,
  isRealFileUnderRoot,
  isSafeSegment,
  isWithin,
  writeProjectJsonOnce,
} from "./data-dir/fs-utils.js";
import {
  type DiscoveredLegacyUnit,
  enumerateLegacyUnits,
  listLegacyUnknownEntries,
  listUnitFiles,
  orderedProjectChatNames,
  type ResolvedUnitFile,
  resolveUnitFile,
  type StorageUnitKind,
  type StorageUnitRef,
  type UnionUnitFileEntry,
  unitDataDirDestination,
} from "./data-dir/units.js";

export {
  type DiscoveredLegacyUnit,
  enumerateLegacyUnits,
  hashFileSha256,
  hashFileSha256Sync,
  listLegacyUnknownEntries,
  listUnitFiles,
  type ResolvedUnitFile,
  resolveUnitFile,
  type StorageUnitKind,
  type StorageUnitRef,
  type UnionUnitFileEntry,
  unitDataDirDestination,
};

export interface DataDirArtifactInfo {
  trustedRoot: string;
  projectKey: string;
  chatSegment: string;
  /** Path relative to `<chat>/artifacts/`, using platform separators. */
  subPath: string;
  /** Canonical lexical path `<dataRoot>/projects/<key>/chats/<chat>/artifacts/<subPath>`. */
  canonicalPath: string;
}

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

function hasGitSegment(absPath: string): boolean {
  return absPath.split(sep).some((segment) => segment.toLowerCase() === ".git");
}

function hasWorktreeSegmentPair(segments: readonly string[]): boolean {
  return segments.some((segment, i) => segment === HARNESS_DIR && segments[i + 1] === "worktrees");
}

function isValidGoalId(id: string): boolean {
  return GOAL_ID_SEGMENT.test(id) && id !== "." && id !== "..";
}

function normalizeChatSegment(chatSessionId?: string | null): string {
  if (typeof chatSessionId === "string" && isSafeSegment(chatSessionId)) {
    return chatSessionId;
  }
  return "legacy";
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
  if (!config.stateDir?.trim()) return null;
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
  private readonly stateDirCanon: string | null;

  constructor(
    private readonly config: StoragePathsConfig,
    readonly layout: StorageLayout,
  ) {
    if (layout === "data-dir" && !config.stateDir?.trim()) {
      throw new Error('Storage layout "data-dir" requires config.stateDir');
    }
    this.stateDirCanon = config.stateDir?.trim() ? canonicalPath(config.stateDir) : null;
    this.pinnedDataRoot = pinDataRootForConfig(config);
  }

  /** Pinned data root directory when `config.stateDir` was supplied, otherwise null. */
  get dataRoot(): string | null {
    return this.pinnedDataRoot;
  }

  /** Normalizes a chat session id into a safe single path segment, or `"legacy"` when missing or unsafe. */
  chatSegment(chatSessionId?: string | null): string {
    return normalizeChatSegment(chatSessionId);
  }

  private requireDataRoot(): string {
    if (!this.pinnedDataRoot) {
      throw new Error('Storage layout "data-dir" requires config.stateDir');
    }
    return this.pinnedDataRoot;
  }

  /**
   * True when a configured extra root (`worktree.extraReadRoots` / `extraWriteRoots`) is empty or,
   * after `~` expansion and canonicalization, equals or lies inside the canonical state dir or data root.
   * Ancestors of the state dir (such as `~`) return false so they stay allowed outside state-dir/data-dir,
   * where the more specific denied root refuses state-dir internals and non-granted data-dir paths.
   */
  private isBlockedConfiguredRoot(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return true;
    const canon = canonicalPath(expandHome(trimmed));
    if (this.stateDirCanon && isEqualOrWithin(this.stateDirCanon, canon)) return true;
    if (this.pinnedDataRoot && isEqualOrWithin(this.pinnedDataRoot, canon)) return true;
    return false;
  }

  private filterConfiguredExtraRoots(roots: readonly string[] | undefined): string[] {
    if (!roots?.length) return [];
    return roots.filter((r) => !this.isBlockedConfiguredRoot(r));
  }

  /** Finds an existing real directory under `<projectDir>/chats/<chat>/<subSegments>` in priority order. */
  private findExistingChatDir(repoRoot: string, ownerChat: string, subSegments: readonly string[]): { chat: string; path: string } | null {
    const dataRoot = this.requireDataRoot();
    const key = this.projectKey(repoRoot);
    const projDir = join(dataRoot, "projects", key);
    for (const chat of orderedProjectChatNames(projDir, ownerChat)) {
      if (isRealDirUnderRoot(dataRoot, ["projects", key, "chats", chat, ...subSegments])) {
        return { chat, path: join(dataRoot, "projects", key, "chats", chat, ...subSegments) };
      }
    }
    return null;
  }

  /** Finds an existing real file under `<projectDir>/chats/<chat>/<subSegments>` in priority order. */
  private findExistingChatFile(repoRoot: string, ownerChat: string, subSegments: readonly string[]): { chat: string; path: string } | null {
    const dataRoot = this.requireDataRoot();
    const key = this.projectKey(repoRoot);
    const projDir = join(dataRoot, "projects", key);
    for (const chat of orderedProjectChatNames(projDir, ownerChat)) {
      if (isRealFileUnderRoot(dataRoot, ["projects", key, "chats", chat, ...subSegments])) {
        return { chat, path: join(dataRoot, "projects", key, "chats", chat, ...subSegments) };
      }
    }
    return null;
  }

  /** Ensures `<dataRoot>/projects/<key>` exists (refusing symlinks below `dataRoot`) and writes `project.json` once. */
  private ensureDataProjectDirInternal(
    repoRoot: string,
    onInvalid: (badPath: string) => Error | null,
  ): { dataRoot: string; key: string; projectDir: string } | null {
    const dataRoot = this.requireDataRoot();
    mkdirSync(dataRoot, { recursive: true });
    const key = this.projectKey(repoRoot);
    const projDir = ensureDirsUnderRoot(dataRoot, ["projects", key], onInvalid);
    if (!projDir) return null;
    writeProjectJsonOnce(projDir, repoRoot, key);
    return { dataRoot, key, projectDir: projDir };
  }

  /** Stable per-project key `<basename>-<12 hex sha256(canonical root)>`. */
  projectKey(repoRoot: string): string {
    const canon = canonicalPath(repoRoot);
    const rawBase = basename(canon).replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+$/, "");
    const label = rawBase || "repo";
    const hash = createHash("sha256").update(canon).digest("hex").slice(0, 12);
    return `${label}-${hash}`;
  }

  /** Project storage root directory. Legacy: `<repo>/.harness`; data-dir: `<dataRoot>/projects/<projectKey>`. */
  projectDir(repoRoot: string): string {
    if (this.layout === "data-dir") {
      return join(this.requireDataRoot(), "projects", this.projectKey(repoRoot));
    }
    return join(canonicalPath(repoRoot), HARNESS_DIR);
  }

  /**
   * Ensures the project storage directory exists and writes `project.json` once in data-dir layout.
   * No-op in legacy layout.
   */
  ensureProjectDir(repoRoot: string): string {
    if (this.layout === "legacy") {
      return this.projectDir(repoRoot);
    }
    const ensured = this.ensureDataProjectDirInternal(repoRoot, (badPath) => REJECTIONS.dossierInvalidDirectory(badPath));
    return ensured!.projectDir;
  }

  /** Chat-scoped storage root directory. Legacy: `<repo>/.harness`; data-dir: `<projectDir>/chats/<chat|legacy>`. */
  chatDir(owner: OwnerRef): string {
    if (this.layout === "data-dir") {
      return join(this.projectDir(owner.repoRoot), "chats", normalizeChatSegment(owner.chatSessionId));
    }
    return this.projectDir(owner.repoRoot);
  }

  /** Goals root directory for the owner. */
  goalsDir(owner: OwnerRef): string {
    return join(this.chatDir(owner), "goals");
  }

  /** Per-goal evidence directory; throws when `goal.id` is not a single safe path segment. */
  goalEvidenceDir(goal: GoalRef): string {
    if (!isValidGoalId(goal.id)) {
      throw new Error(`Invalid goal id for evidence directory: ${JSON.stringify(goal.id)}`);
    }
    if (this.layout === "legacy") {
      return join(this.goalsDir(goal), goal.id);
    }
    const canonRepo = canonicalPath(goal.repoRoot);
    if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "goals", goal.id])) {
      return join(canonRepo, HARNESS_DIR, "goals", goal.id);
    }
    const found = this.findExistingChatDir(canonRepo, normalizeChatSegment(goal.chatSessionId), ["goals", goal.id]);
    if (found) return found.path;
    return join(this.goalsDir(goal), goal.id);
  }

  /** Creates the goal evidence directory segment by segment, refusing symlinks and non-directories; returns null on failure. */
  ensureGoalEvidenceDir(goal: GoalRef): string | null {
    try {
      if (!isValidGoalId(goal.id)) return null;
      const canonRepo = canonicalPath(goal.repoRoot);
      if (this.layout === "legacy") {
        return ensureDirsUnderRoot(canonRepo, [HARNESS_DIR, "goals", goal.id], () => null);
      }
      // Per-unit rule: real legacy directory stays legacy (bridge symlinks are not real dirs).
      if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "goals", goal.id])) {
        return join(canonRepo, HARNESS_DIR, "goals", goal.id);
      }
      const ownerChat = normalizeChatSegment(goal.chatSessionId);
      const existing = this.findExistingChatDir(canonRepo, ownerChat, ["goals", goal.id]);
      const targetChat = existing?.chat ?? ownerChat;
      const proj = this.ensureDataProjectDirInternal(canonRepo, () => null);
      if (!proj) return null;
      return ensureDirsUnderRoot(proj.dataRoot, ["projects", proj.key, "chats", targetChat, "goals", goal.id], () => null);
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
    if (this.layout === "legacy") {
      return join(this.artifactsDir(run), run.id);
    }
    const canonRepo = canonicalPath(run.repoRoot);
    const ownerChat = normalizeChatSegment(run.chatSessionId);
    // Director bucket runs have task-level units, not run-level units; the run dir itself lives in data-dir.
    if (!isDirectorTaskContainer(run.id) && run.id && isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "artifacts", run.id])) {
      return join(canonRepo, HARNESS_DIR, "artifacts", run.id);
    }
    if (run.id) {
      const found = this.findExistingChatDir(canonRepo, ownerChat, ["artifacts", run.id]);
      if (found) return found.path;
    }
    return join(this.artifactsDir(run), run.id);
  }

  /** Task dossier directory inside the run's artifacts directory. */
  taskDossierDir(run: RunRef, taskId: string): string {
    if (this.layout === "legacy") {
      return join(this.runArtifactsDir(run), taskId);
    }
    if (isDirectorTaskContainer(run.id)) {
      const canonRepo = canonicalPath(run.repoRoot);
      if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "artifacts", run.id, taskId])) {
        return join(canonRepo, HARNESS_DIR, "artifacts", run.id, taskId);
      }
      const ownerChat = normalizeChatSegment(run.chatSessionId);
      const found = this.findExistingChatDir(canonRepo, ownerChat, ["artifacts", run.id, taskId]);
      if (found) return found.path;
      return join(this.artifactsDir(run), run.id, taskId);
    }
    return join(this.runArtifactsDir(run), taskId);
  }

  /**
   * Ensures a dossier directory under the run's artifacts root segment by segment, refusing symlinks and non-directories.
   * Throws `REJECTIONS.dossierInvalidDirectory` when a conflicting file or symlink exists.
   */
  ensureDossierDir(run: RunRef, ...parts: string[]): string {
    const subSegments = parts.flatMap((p) => p.split(/[\\/]/).filter((s) => s.length > 0 && s !== "."));
    if (this.layout === "legacy") {
      const segments = [HARNESS_DIR, "artifacts", ...subSegments];
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

    const onInvalid = (badPath: string) => REJECTIONS.dossierInvalidDirectory(badPath);
    const realRepo = realpathSync(run.repoRoot);
    for (const seg of subSegments) {
      if (seg === ".." || seg.includes("\0")) {
        throw REJECTIONS.dossierInvalidDirectory(join(realRepo, seg));
      }
    }

    const ownerChat = normalizeChatSegment(run.chatSessionId);
    let useLegacy = false;
    let targetChat = ownerChat;

    if (subSegments.length === 0) {
      // Flat spill / code-output file: next to runArtifactsDir(run) for run-level units, artifactsDir(owner) for bucket runs.
      if (run.id && !isDirectorTaskContainer(run.id)) {
        if (isRealDirUnderRoot(realRepo, [HARNESS_DIR, "artifacts", run.id])) {
          useLegacy = true;
        } else {
          const found = this.findExistingChatDir(realRepo, ownerChat, ["artifacts", run.id]);
          if (found) targetChat = found.chat;
        }
      }
    } else if (isDirectorTaskContainer(subSegments[0]!)) {
      if (subSegments.length >= 2) {
        if (isRealDirUnderRoot(realRepo, [HARNESS_DIR, "artifacts", subSegments[0]!, subSegments[1]!])) {
          useLegacy = true;
        } else {
          const found = this.findExistingChatDir(realRepo, ownerChat, ["artifacts", subSegments[0]!, subSegments[1]!]);
          if (found) targetChat = found.chat;
        }
      } else {
        const found = this.findExistingChatDir(realRepo, ownerChat, ["artifacts", subSegments[0]!]);
        if (found) targetChat = found.chat;
      }
    } else {
      const runId = subSegments[0]!;
      if (isRealDirUnderRoot(realRepo, [HARNESS_DIR, "artifacts", runId])) {
        useLegacy = true;
      } else {
        const found = this.findExistingChatDir(realRepo, ownerChat, ["artifacts", runId]);
        if (found) targetChat = found.chat;
      }
    }

    if (useLegacy) {
      return ensureDirsUnderRoot(realRepo, [HARNESS_DIR, "artifacts", ...subSegments], onInvalid)!;
    }

    const proj = this.ensureDataProjectDirInternal(realRepo, onInvalid)!;
    return ensureDirsUnderRoot(
      proj.dataRoot,
      ["projects", proj.key, "chats", targetChat, "artifacts", ...subSegments],
      onInvalid,
    )!;
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

  /**
   * Parses an absolute path under `<dataRoot>/projects/<key>/chats/<chat>/artifacts/<subPath>` for `run`'s project.
   * Nothing below `dataRoot` is followed as a symlink; returns null when outside the project's data-dir artifacts.
   */
  dataDirArtifactInfo(run: RunRef, absPath: string): DataDirArtifactInfo | null {
    if (this.layout !== "data-dir" || !this.pinnedDataRoot) return null;
    if (!isAbsolute(absPath) || absPath.includes("\0")) return null;
    const key = this.projectKey(run.repoRoot);
    const projDir = join(this.pinnedDataRoot, "projects", key);
    const abs = resolve(absPath);

    let relFromProj: string | null = null;
    if (isWithin(projDir, abs)) {
      relFromProj = relative(projDir, abs);
    } else {
      const marker = `${sep}projects${sep}${key}${sep}`;
      for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
        const prefix = abs.slice(0, idx) || sep;
        if (canonicalPath(prefix) === this.pinnedDataRoot) {
          relFromProj = abs.slice(idx + marker.length);
          break;
        }
      }
    }
    if (!relFromProj || relFromProj.includes("\0")) return null;
    const parts = relFromProj.split(sep);
    if (parts[0] !== "chats" || parts.length < 4 || !parts[1] || parts[2] !== "artifacts") return null;
    if (parts.some((p) => !p || p === "." || p === "..")) return null;
    const chatSegment = parts[1]!;
    const subParts = parts.slice(3);
    const subPath = join(...subParts);
    return {
      trustedRoot: this.pinnedDataRoot,
      projectKey: key,
      chatSegment,
      subPath,
      canonicalPath: join(projDir, "chats", chatSegment, "artifacts", ...subParts),
    };
  }

  /**
   * Extracts the path segment below `artifacts/` from either a legacy artifact path or a data-dir artifact path
   * belonging to `run`'s project, or returns null.
   */
  artifactSubPath(run: RunRef, absPath: string): string | null {
    const dataInfo = this.dataDirArtifactInfo(run, absPath);
    if (dataInfo) return dataInfo.subPath;
    const legacyRel = this.artifactRel(run, absPath);
    if (legacyRel) {
      const prefix = `${HARNESS_DIR}${sep}artifacts${sep}`;
      return legacyRel.startsWith(prefix) ? legacyRel.slice(prefix.length) : null;
    }
    return null;
  }

  /** Builds the repo-relative legacy artifact path (`.harness/artifacts/<subPath>`) from a subpath below `artifacts/`. */
  legacyArtifactRel(subPath: string): string {
    return join(HARNESS_DIR, "artifacts", subPath);
  }

  /**
   * Resolves a file inside an artifacts unit (run-level, bucket task-level, or flat spill) under the both-exist rule:
   * legacy real unit wins over data-dir, and data-dir-only files remain visible. Never follows symlinks.
   */
  resolveArtifactFile(run: RunRef, artifactSubPath: string): ResolvedUnitFile | null {
    const normalized = artifactSubPath.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!normalized || normalized.includes("\0")) return null;
    const parts = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
    if (parts.length === 0 || parts.some((s) => s === "..")) return null;

    if (parts.length === 1) {
      return resolveUnitFile(this, {
        kind: "flat_artifact",
        repoRoot: run.repoRoot,
        id: parts[0]!,
        chatSessionId: run.chatSessionId,
      });
    }

    const first = parts[0]!;
    if (isDirectorTaskContainer(first)) {
      if (parts.length < 3) return null;
      return resolveUnitFile(
        this,
        {
          kind: "bucket_task",
          repoRoot: run.repoRoot,
          id: first,
          taskId: parts[1]!,
          chatSessionId: run.chatSessionId,
        },
        parts.slice(2).join("/"),
      );
    }

    return resolveUnitFile(
      this,
      {
        kind: "run",
        repoRoot: run.repoRoot,
        id: first,
        chatSessionId: run.chatSessionId,
      },
      parts.slice(1).join("/"),
    );
  }

  /** Resolves a file inside any storage unit under the both-exist union rule (legacy wins over data-dir). */
  resolveUnitFile(unit: StorageUnitRef, relPath = ""): ResolvedUnitFile | null {
    return resolveUnitFile(this, unit, relPath);
  }

  /** Lists all regular files in a storage unit as the union of legacy and data-dir copies (legacy wins on conflict). */
  listUnitFiles(unit: StorageUnitRef): UnionUnitFileEntry[] {
    return listUnitFiles(this, unit);
  }

  /** Enumerates all legacy units under `<repo>/.harness/` for migration planning and execution. */
  enumerateLegacyUnits(repoRoot: string): DiscoveredLegacyUnit[] {
    return enumerateLegacyUnits(this, repoRoot);
  }

  /** Computes the data-dir destination path for a storage unit without inspecting legacy existence. */
  unitDataDirDestination(unit: StorageUnitRef): string {
    return unitDataDirDestination(this, unit);
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

  /** Path for a worker worktree checkout. Always under data-dir in `data-dir` layout. */
  worktreePath(run: RunRef, dirName: string): string {
    if (this.layout === "data-dir") {
      return join(this.chatDir(run), "worktrees", run.id, dirName);
    }
    return join(this.legacyWorktreeBaseDir(run.repoRoot), run.id, dirName);
  }

  /** Path for a detached scratch worktree (`_verify` or `_integration`). Always under data-dir in `data-dir` layout. */
  scratchPath(repoRoot: string, kind: ScratchKind, name: string): string {
    if (this.layout === "data-dir") {
      return join(this.projectDir(repoRoot), "scratch", kind, name);
    }
    return join(this.legacyWorktreeBaseDir(repoRoot), kind, name);
  }

  /** Every root directory under which harness-managed worktrees for `repoRoot` may be registered. First entry is for new trees. */
  managedWorktreeRoots(repoRoot: string): string[] {
    if (this.layout === "legacy") {
      return [this.legacyWorktreeBaseDir(repoRoot)];
    }
    const canonRepo = canonicalPath(repoRoot);
    const roots: string[] = [this.projectDir(canonRepo), join(canonRepo, HARNESS_DIR, "worktrees")];
    if (this.config.worktree?.dir?.trim()) {
      const custom = resolve(canonRepo, this.config.worktree.dir.trim());
      if (!roots.includes(custom)) roots.push(custom);
    }
    return roots;
  }

  /** Computes the runner request fragment (read/write roots, env, denied/protected roots) for a task. */
  taskGrants(input: TaskGrantsInput): TaskGrants {
    const { run, goal, writable } = input;
    if (this.layout === "legacy") {
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

    const canonRepo = canonicalPath(run.repoRoot);
    const isBucket = isDirectorTaskContainer(run.id);

    // Addendum A4 pinning: when either legacy half of a goal unit exists as a real directory, create the other
    // legacy half (segment-wise, refusing symlinks/non-dirs) so later calls that see only one half agree from disk.
    if (goal && run.id && !isBucket) {
      const validGoal = isValidGoalId(goal.id);
      const legacyGoalExists = validGoal && isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "goals", goal.id]);
      const legacyRunExists = isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "artifacts", run.id]);
      if (legacyGoalExists && !legacyRunExists) {
        try {
          ensureDirsUnderRoot(canonRepo, [HARNESS_DIR, "artifacts", run.id], () => null);
        } catch {
          // Fail closed without throwing out of taskGrants.
        }
      } else if (legacyRunExists && !legacyGoalExists && validGoal) {
        try {
          ensureDirsUnderRoot(canonRepo, [HARNESS_DIR, "goals", goal.id], () => null);
        } catch {
          // Fail closed without throwing out of taskGrants.
        }
      }
    }

    const goalEvDir = goal ? this.ensureGoalEvidenceDir(goal) : null;
    const envGoalsDir = goal
      ? goalEvDir
        ? dirname(goalEvDir)
        : isValidGoalId(goal.id)
          ? dirname(this.goalEvidenceDir(goal))
          : this.goalsDir(run)
      : this.goalsDir(run);
    const runArtDir = run.id && !isBucket ? this.runArtifactsDir(run) : null;
    const envArtifactsDir = runArtDir ? dirname(runArtDir) : this.artifactsDir(run);

    const legacyOwner: OwnerRef = { repoRoot: canonRepo, chatSessionId: null };
    const legacyGoalsRoot = join(canonRepo, HARNESS_DIR, "goals");
    const legacyArtifactsRoot = join(canonRepo, HARNESS_DIR, "artifacts");
    const hasLegacyGoals = isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "goals"]);
    const hasLegacyArtifacts = isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "artifacts"]);

    const readRoots: string[] = [
      this.goalsDir(run),
      this.artifactsDir(run),
      this.notesDir(run),
      this.projectNotesDir(canonRepo),
      this.goalsDir(legacyOwner),
      this.artifactsDir(legacyOwner),
      this.notesDir(legacyOwner),
    ];
    if (hasLegacyGoals) readRoots.push(legacyGoalsRoot);
    if (hasLegacyArtifacts) readRoots.push(legacyArtifactsRoot);
    // If the goal or run lives in another chat (e.g. transferred ownership), grant only that specific unit dir.
    if (goalEvDir && !readRoots.some((r) => isEqualOrWithin(r, goalEvDir))) {
      readRoots.push(goalEvDir);
    }
    if (runArtDir && existsSync(runArtDir) && !readRoots.some((r) => isEqualOrWithin(r, runArtDir))) {
      readRoots.push(runArtDir);
    }
    readRoots.push(...this.filterConfiguredExtraRoots(this.config.worktree?.extraReadRoots));
    const extraReadRoots = [...new Set(readRoots)];

    const configuredWriteRoots = this.filterConfiguredExtraRoots(this.config.worktree?.extraWriteRoots);
    const extraWriteRoots = goal
      ? writable
        ? [...new Set([...(goalEvDir ? [goalEvDir] : []), ...configuredWriteRoots])]
        : undefined
      : [
          ...new Set([
            this.goalsDir(run),
            ...(hasLegacyGoals ? [legacyGoalsRoot] : []),
            ...configuredWriteRoots,
          ]),
        ];

    const extraEnv = goal
      ? {
          ...(goalEvDir ? { HARNESS_GOAL_EVIDENCE_DIR: goalEvDir } : {}),
          HARNESS_GOAL_ID: goal.id,
          HARNESS_GOALS_DIR: envGoalsDir,
          HARNESS_ARTIFACTS_DIR: envArtifactsDir,
        }
      : undefined;

    const stateCanon = this.stateDirCanon!;
    const dataCanon = this.requireDataRoot();
    const deniedRoots =
      dataCanon !== stateCanon && !isWithin(stateCanon, dataCanon) ? [stateCanon, dataCanon] : [stateCanon];

    return {
      extraReadRoots,
      extraWriteRoots,
      extraEnv,
      deniedRoots,
      protectedRoots: [],
    };
  }

  /** Canonical repo root and writable note roots for the Director's `write_note` tool. */
  directorNoteRoots(owner: OwnerRef): DirectorNoteRoots {
    if (this.layout === "legacy") {
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
    const root = canonicalPath(owner.repoRoot);
    const allowed: string[] = [
      this.goalsDir(owner),
      this.notesDir(owner),
      this.projectNotesDir(root),
    ];
    if (isRealDirUnderRoot(root, [HARNESS_DIR, "goals"])) {
      allowed.push(join(root, HARNESS_DIR, "goals"));
    }
    if (isRealDirUnderRoot(root, [HARNESS_DIR, "notes"])) {
      allowed.push(join(root, HARNESS_DIR, "notes"));
    }
    allowed.push(...resolvedExtraWriteRoots(this.config).filter((r) => !this.isBlockedConfiguredRoot(r)));
    return {
      root,
      allowedWriteRoots: [...new Set(allowed)],
    };
  }

  /** Evaluates whether the Director may read `absPath` relative to `repoRoot`. */
  directorReadPolicy(repoRoot: string, absPath: string): DirectorReadDecision {
    const root = canonicalPath(repoRoot);
    const target = canonicalPath(absPath);

    if (this.layout === "data-dir") {
      if (hasGitSegment(target)) {
        return { ok: false, reason: ".git internals are protected" };
      }
      const dataCanon = this.requireDataRoot();
      if (target === dataCanon) {
        return { ok: false, reason: "harness data-dir root and metadata are protected" };
      }
      if (isWithin(dataCanon, target)) {
        const parts = relative(dataCanon, target).split(sep);
        if (hasWorktreeSegmentPair(parts.map((p) => p.toLowerCase()))) {
          return { ok: false, reason: "task worktrees are protected" };
        }
        // Addendum A6: allow projects/<any>/notes and projects/<any>/chats/<any>/{goals,artifacts,notes}.
        if (parts[0] === "projects" && parts.length >= 3 && Boolean(parts[1]) && parts[2] === "notes") {
          return { ok: true };
        }
        if (
          parts[0] === "projects" &&
          parts.length >= 5 &&
          Boolean(parts[1]) &&
          parts[2] === "chats" &&
          Boolean(parts[3]) &&
          LEGACY_DATA_SUBDIRS.has(parts[4]!)
        ) {
          return { ok: true };
        }
        if (parts[0] === "projects" && (parts[2] === "scratch" || (parts[2] === "chats" && parts[4] === "worktrees"))) {
          return { ok: false, reason: "task worktrees and scratch checkouts are protected" };
        }
        return { ok: false, reason: "harness data-dir internals and metadata are protected" };
      }
      if (this.stateDirCanon && (target === this.stateDirCanon || isWithin(this.stateDirCanon, target))) {
        return { ok: false, reason: "harness state-dir internals are protected" };
      }
    }

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
    const absCanon = canonicalPath(absPath);
    if (hasGitSegment(absolute) || hasGitSegment(absCanon)) return true;

    if (ownWorkspace !== undefined) {
      const ownCanon = canonicalPath(ownWorkspace);
      const relCanon = relative(ownCanon, absCanon);
      if (relCanon === "") return false;
      if (!isAbsolute(relCanon) && relCanon !== ".." && !relCanon.startsWith(`..${sep}`)) {
        const segments = relCanon.split(sep).map((segment) => segment.toLowerCase());
        return hasWorktreeSegmentPair(segments);
      }
    }

    const segments = absolute.split(sep).map((segment) => segment.toLowerCase());
    if (hasWorktreeSegmentPair(segments)) return true;
    const canonSegments = absCanon.split(sep).map((segment) => segment.toLowerCase());
    if (hasWorktreeSegmentPair(canonSegments)) return true;

    if (this.layout === "data-dir" && this.pinnedDataRoot && isWithin(this.pinnedDataRoot, absCanon)) {
      const parts = relative(this.pinnedDataRoot, absCanon).split(sep);
      if (
        parts[0] === "projects" &&
        parts.length >= 5 &&
        Boolean(parts[1]) &&
        parts[2] === "chats" &&
        Boolean(parts[3]) &&
        parts[4] === "worktrees"
      ) {
        return true;
      }
      if (parts[0] === "projects" && parts.length >= 3 && Boolean(parts[1]) && parts[2] === "scratch") {
        return true;
      }
    }

    return false;
  }

  /** True when `absPath` targets harness state-dir internals (root, DB, config, install, tools, logs). */
  isStateInternalPath(absPath: string): boolean {
    if (!this.stateDirCanon) return false;
    const target = canonicalPath(absPath);
    if (target === this.stateDirCanon) return true;
    if (!isWithin(this.stateDirCanon, target)) return false;
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
   * Maps a workspace-relative `.harness/{goals,notes,artifacts}/...` path, an absolute `<repo>/.harness/...` path,
   * or (in `data-dir` layout) an already-current data-dir path inside this project's allowed data dirs to its current
   * absolute location, or returns `null` if `rawPath` is not a data path for `repoRoot`.
   */
  resolveLegacyPath(repoRoot: string, rawPath: string, owner?: OwnerRef): string | null {
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes("\0") || trimmed === "~" || trimmed.startsWith("~/")) return null;
    const rawRoot = resolve(repoRoot);
    const realRoot = canonicalPath(repoRoot);

    // In data-dir layout, accept paths that are already inside this project's allowed data directories.
    if (this.layout === "data-dir" && isAbsolute(trimmed) && this.pinnedDataRoot) {
      const abs = resolve(trimmed);
      const key = this.projectKey(realRoot);
      const projDir = join(this.pinnedDataRoot, "projects", key);
      let relFromProj: string | null = null;
      if (isWithin(projDir, abs)) {
        relFromProj = relative(projDir, abs);
      } else {
        const marker = `${sep}projects${sep}${key}${sep}`;
        for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
          const prefix = abs.slice(0, idx) || sep;
          if (canonicalPath(prefix) === this.pinnedDataRoot) {
            relFromProj = abs.slice(idx + marker.length);
            break;
          }
        }
      }
      if (relFromProj !== null) {
        const parts = relFromProj.split(sep);
        if (parts.some((p) => !p || p === "." || p === "..")) return null;
        if (parts[0] === "notes") {
          return join(projDir, ...parts);
        }
        if (parts[0] === "chats" && parts.length >= 3 && Boolean(parts[1]) && LEGACY_DATA_SUBDIRS.has(parts[2]!)) {
          return join(projDir, ...parts);
        }
        return null;
      }
    }

    // Parse legacy `.harness/{goals,notes,artifacts}/...` path (relative, absolute, or symlinked repo root spelling).
    let legacyParts: string[] | null = null;
    if (!isAbsolute(trimmed)) {
      const abs = resolve(rawRoot, trimmed);
      const rel = relative(rawRoot, abs);
      if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
      const parts = rel.split(sep);
      if (parts[0] !== HARNESS_DIR || !LEGACY_DATA_SUBDIRS.has(parts[1] ?? "")) return null;
      legacyParts = parts;
    } else {
      const abs = resolve(trimmed);
      for (const root of [realRoot, rawRoot]) {
        const rel = relative(root, abs);
        if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) continue;
        const parts = rel.split(sep);
        if (parts[0] !== HARNESS_DIR || !LEGACY_DATA_SUBDIRS.has(parts[1] ?? "")) return null;
        legacyParts = parts;
        break;
      }
      if (!legacyParts) {
        const marker = `${sep}${HARNESS_DIR}${sep}`;
        for (let idx = abs.indexOf(marker); idx !== -1; idx = abs.indexOf(marker, idx + 1)) {
          const prefix = abs.slice(0, idx) || sep;
          if (canonicalPath(prefix) !== realRoot) continue;
          const parts = abs.slice(idx + 1).split(sep);
          if (parts[0] !== HARNESS_DIR || !LEGACY_DATA_SUBDIRS.has(parts[1] ?? "")) return null;
          legacyParts = parts;
          break;
        }
      }
    }

    if (!legacyParts) return null;
    if (this.layout === "legacy") {
      return join(realRoot, ...legacyParts);
    }

    // Map legacy path in data-dir layout per Addendum A5.
    const kind = legacyParts[1]!;
    const rest = legacyParts.slice(2);
    const ownerRef: OwnerRef = { repoRoot: realRoot, chatSessionId: owner?.chatSessionId ?? null };
    const ownerChat = normalizeChatSegment(ownerRef.chatSessionId);

    if (kind === "notes") {
      if (rest.length === 0) {
        return isRealDirUnderRoot(realRoot, [HARNESS_DIR, "notes"])
          ? join(realRoot, HARNESS_DIR, "notes")
          : this.projectNotesDir(realRoot);
      }
      if (
        isRealFileUnderRoot(realRoot, [HARNESS_DIR, "notes", ...rest]) ||
        isRealDirUnderRoot(realRoot, [HARNESS_DIR, "notes", ...rest])
      ) {
        return join(realRoot, HARNESS_DIR, "notes", ...rest);
      }
      return join(this.projectNotesDir(realRoot), ...rest);
    }

    if (kind === "goals") {
      if (rest.length === 0) {
        return isRealDirUnderRoot(realRoot, [HARNESS_DIR, "goals"])
          ? join(realRoot, HARNESS_DIR, "goals")
          : this.goalsDir(ownerRef);
      }
      const goalId = rest[0]!;
      const subPath = rest.slice(1);
      if (isRealDirUnderRoot(realRoot, [HARNESS_DIR, "goals", goalId])) {
        return join(realRoot, HARNESS_DIR, "goals", goalId, ...subPath);
      }
      const found = this.findExistingChatDir(realRoot, ownerChat, ["goals", goalId]);
      if (found) return join(found.path, ...subPath);
      return join(this.goalsDir(ownerRef), goalId, ...subPath);
    }

    // kind === "artifacts"
    if (rest.length === 0) {
      return isRealDirUnderRoot(realRoot, [HARNESS_DIR, "artifacts"])
        ? join(realRoot, HARNESS_DIR, "artifacts")
        : this.artifactsDir(ownerRef);
    }

    if (rest.length === 1) {
      const entry = rest[0]!;
      if (isRealFileUnderRoot(realRoot, [HARNESS_DIR, "artifacts", entry])) {
        return join(realRoot, HARNESS_DIR, "artifacts", entry);
      }
      if (!isDirectorTaskContainer(entry) && isRealDirUnderRoot(realRoot, [HARNESS_DIR, "artifacts", entry])) {
        return join(realRoot, HARNESS_DIR, "artifacts", entry);
      }
      const foundFile = this.findExistingChatFile(realRoot, ownerChat, ["artifacts", entry]);
      if (foundFile) return foundFile.path;
      const foundDir = this.findExistingChatDir(realRoot, ownerChat, ["artifacts", entry]);
      if (foundDir) return foundDir.path;
      return join(this.artifactsDir(ownerRef), entry);
    }

    const runId = rest[0]!;
    const subPath = rest.slice(1);
    if (isDirectorTaskContainer(runId)) {
      const taskId = subPath[0]!;
      const taskSub = subPath.slice(1);
      if (
        isRealDirUnderRoot(realRoot, [HARNESS_DIR, "artifacts", runId, taskId]) ||
        (taskSub.length === 0 && isRealFileUnderRoot(realRoot, [HARNESS_DIR, "artifacts", runId, taskId]))
      ) {
        return join(realRoot, HARNESS_DIR, "artifacts", runId, ...subPath);
      }
      const foundDir = this.findExistingChatDir(realRoot, ownerChat, ["artifacts", runId, taskId]);
      if (foundDir) return join(foundDir.path, ...taskSub);
      if (taskSub.length === 0) {
        const foundFile = this.findExistingChatFile(realRoot, ownerChat, ["artifacts", runId, taskId]);
        if (foundFile) return foundFile.path;
      }
      return join(this.artifactsDir(ownerRef), runId, ...subPath);
    }

    if (isRealDirUnderRoot(realRoot, [HARNESS_DIR, "artifacts", runId])) {
      return join(realRoot, HARNESS_DIR, "artifacts", runId, ...subPath);
    }
    const foundRun = this.findExistingChatDir(realRoot, ownerChat, ["artifacts", runId]);
    if (foundRun) return join(foundRun.path, ...subPath);
    return join(this.artifactsDir(ownerRef), runId, ...subPath);
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
