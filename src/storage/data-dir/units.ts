import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { isDirectorTaskContainer } from "../../control-plane/ids.js";
import type { OwnerRef, StoragePaths } from "../paths.js";
import { canonicalPath, isRealDirUnderRoot, isRealFileUnderRoot } from "./fs-utils.js";

export type StorageUnitKind = "goal" | "run" | "bucket_task" | "note" | "flat_artifact";

export interface StorageUnitRef {
  kind: StorageUnitKind;
  repoRoot: string;
  /** Goal id (`goal`), run id (`run`, `bucket_task`), or relative path/filename (`note`, `flat_artifact`). */
  id: string;
  /** Task id, required when `kind === "bucket_task"`. */
  taskId?: string;
  chatSessionId?: string | null;
}

export interface DiscoveredLegacyUnit {
  kind: StorageUnitKind;
  repoRoot: string;
  id: string;
  taskId?: string;
  /** Absolute path to the legacy entry on disk (real dir/file or migration bridge symlink). */
  legacyPath: string;
  /** True when `legacyPath` is a symlink (migration bridge); false when it is a real dir or file. */
  isBridge: boolean;
  /** Raw symlink target when `isBridge` is true, else null. */
  bridgeTarget: string | null;
  /** Computes the data-dir destination path for this unit given an optional owner (defaults to `chats/legacy` or `projectNotesDir`). */
  destinationFor(owner?: OwnerRef): string;
}

export interface ResolvedUnitFile {
  /** Absolute path to the existing regular file (legacy preferred over data-dir when both exist). */
  path: string;
  source: "legacy" | "data-dir";
  /** Directory containing the unit (or parent directory for single-file units `note` / `flat_artifact`). */
  unitDir: string;
}

export interface UnionUnitFileEntry {
  /** POSIX-style relative path within the unit (or filename/relPath for single-file units). */
  relPath: string;
  /** Absolute path to the winning file (legacy wins when both exist). */
  path: string;
  source: "legacy" | "data-dir";
  /** Shadowed data-dir copies when a legacy file (or earlier copy) won on the same relative path. */
  shadowedPaths?: string[];
}

const HARNESS_DIR = ".harness";
const KNOWN_LEGACY_HARNESS_ENTRIES = new Set(["goals", "artifacts", "notes", "worktrees"]);

function splitSafeRel(relPath: string): string[] | null {
  const normalized = relPath.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("\0")) return null;
  const parts = normalized.split("/").filter((s) => s.length > 0 && s !== ".");
  if (parts.length === 0 || parts.some((s) => s === "..")) return null;
  return parts;
}

/** Lists all chat directory names under `<projectDir>/chats` in search priority: owner chat, `"legacy"`, then remaining sorted. */
export function orderedProjectChatNames(projectDir: string, ownerChat: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (name: string) => {
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  };
  add(ownerChat);
  add("legacy");
  const chatsDir = join(projectDir, "chats");
  try {
    const st = lstatSync(chatsDir);
    if (!st.isSymbolicLink() && st.isDirectory()) {
      const others = readdirSync(chatsDir, { withFileTypes: true })
        .filter((d) => !d.isSymbolicLink() && d.isDirectory() && !seen.has(d.name))
        .map((d) => d.name)
        .sort();
      for (const name of others) add(name);
    }
  } catch {
    // No chats directory yet.
  }
  return out;
}

/**
 * Computes the data-dir destination path for a unit given its owner (without consulting legacy existence).
 * Uses `chats/<chat|legacy>` for chat-scoped units and `projectNotesDir` for notes.
 */
export function unitDataDirDestination(storage: StoragePaths, unit: StorageUnitRef): string {
  const owner: OwnerRef = { repoRoot: unit.repoRoot, chatSessionId: unit.chatSessionId };
  switch (unit.kind) {
    case "goal":
      return join(storage.goalsDir(owner), unit.id);
    case "run":
      return join(storage.artifactsDir(owner), unit.id);
    case "bucket_task":
      if (!unit.taskId) throw new Error(`bucket_task unit requires taskId (run: ${unit.id})`);
      return join(storage.artifactsDir(owner), unit.id, unit.taskId);
    case "flat_artifact":
      return join(storage.artifactsDir(owner), unit.id);
    case "note": {
      const relParts = splitSafeRel(unit.id);
      if (!relParts) throw new Error(`Invalid note relative path: ${JSON.stringify(unit.id)}`);
      return join(storage.projectNotesDir(unit.repoRoot), ...relParts);
    }
  }
}

/**
 * Resolves a file inside a unit to the existing copy on disk under the both-exist rule:
 * legacy real unit wins over data-dir; if absent from legacy, falls back to data-dir.
 * Never follows symlinks and never modifies disk.
 */
export function resolveUnitFile(
  storage: StoragePaths,
  unit: StorageUnitRef,
  relPath = "",
): ResolvedUnitFile | null {
  const canonRepo = canonicalPath(unit.repoRoot);

  // Single-file units: note and flat_artifact
  if (unit.kind === "note") {
    const parts = splitSafeRel(relPath || unit.id);
    if (!parts) return null;
    if (isRealFileUnderRoot(canonRepo, [HARNESS_DIR, "notes", ...parts])) {
      return {
        path: join(canonRepo, HARNESS_DIR, "notes", ...parts),
        source: "legacy",
        unitDir: join(canonRepo, HARNESS_DIR, "notes"),
      };
    }
    if (storage.layout === "data-dir" && storage.dataRoot) {
      const key = storage.projectKey(canonRepo);
      if (isRealFileUnderRoot(storage.dataRoot, ["projects", key, "notes", ...parts])) {
        return {
          path: join(storage.dataRoot, "projects", key, "notes", ...parts),
          source: "data-dir",
          unitDir: join(storage.dataRoot, "projects", key, "notes"),
        };
      }
    }
    return null;
  }

  if (unit.kind === "flat_artifact") {
    const fileName = relPath || unit.id;
    const parts = splitSafeRel(fileName);
    if (!parts || parts.length !== 1) return null;
    if (isRealFileUnderRoot(canonRepo, [HARNESS_DIR, "artifacts", parts[0]!])) {
      return {
        path: join(canonRepo, HARNESS_DIR, "artifacts", parts[0]!),
        source: "legacy",
        unitDir: join(canonRepo, HARNESS_DIR, "artifacts"),
      };
    }
    if (storage.layout === "data-dir" && storage.dataRoot) {
      const key = storage.projectKey(canonRepo);
      const projDir = storage.projectDir(canonRepo);
      const ownerChat = storage.chatSegment(unit.chatSessionId);
      for (const chat of orderedProjectChatNames(projDir, ownerChat)) {
        if (isRealFileUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, "artifacts", parts[0]!])) {
          return {
            path: join(storage.dataRoot, "projects", key, "chats", chat, "artifacts", parts[0]!),
            source: "data-dir",
            unitDir: join(storage.dataRoot, "projects", key, "chats", chat, "artifacts"),
          };
        }
      }
    }
    return null;
  }

  // Directory units: goal, run, bucket_task
  const relParts = splitSafeRel(relPath);
  if (!relParts) return null;

  const unitSubSegments =
    unit.kind === "goal"
      ? ["goals", unit.id]
      : unit.kind === "run"
        ? ["artifacts", unit.id]
        : unit.taskId
          ? ["artifacts", unit.id, unit.taskId]
          : null;
  if (!unitSubSegments) return null;

  // 1. Legacy real unit directory first (legacy wins on conflict).
  if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, ...unitSubSegments])) {
    const legacyUnitDir = join(canonRepo, HARNESS_DIR, ...unitSubSegments);
    if (isRealFileUnderRoot(legacyUnitDir, relParts)) {
      return {
        path: join(legacyUnitDir, ...relParts),
        source: "legacy",
        unitDir: legacyUnitDir,
      };
    }
  }

  // 2. Data-dir unit directory copies (owner chat, then chats/legacy, then other chats).
  if (storage.layout === "data-dir" && storage.dataRoot) {
    const key = storage.projectKey(canonRepo);
    const projDir = storage.projectDir(canonRepo);
    const ownerChat = storage.chatSegment(unit.chatSessionId);
    for (const chat of orderedProjectChatNames(projDir, ownerChat)) {
      if (isRealDirUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, ...unitSubSegments])) {
        const dataUnitDir = join(storage.dataRoot, "projects", key, "chats", chat, ...unitSubSegments);
        if (isRealFileUnderRoot(dataUnitDir, relParts)) {
          return {
            path: join(dataUnitDir, ...relParts),
            source: "data-dir",
            unitDir: dataUnitDir,
          };
        }
      }
    }
  }

  return null;
}

function walkRegularFiles(rootDir: string, prefix = ""): Array<{ relPath: string; path: string }> {
  const out: Array<{ relPath: string; path: string }> = [];
  let entries;
  try {
    entries = readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = join(rootDir, entry.name);
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkRegularFiles(abs, rel));
    } else if (entry.isFile()) {
      out.push({ relPath: rel, path: abs });
    }
  }
  return out;
}

/**
 * Lists all regular files in a unit as the union of its legacy copy (if a real dir/file) and any data-dir copy,
 * with legacy winning on conflict. Shadowed copies are preserved on `shadowedPaths` for migration reconciliation.
 * Never follows symlinks and never modifies disk.
 */
export function listUnitFiles(storage: StoragePaths, unit: StorageUnitRef): UnionUnitFileEntry[] {
  const canonRepo = canonicalPath(unit.repoRoot);
  const byRel = new Map<string, UnionUnitFileEntry>();

  const record = (relPath: string, path: string, source: "legacy" | "data-dir") => {
    const existing = byRel.get(relPath);
    if (!existing) {
      byRel.set(relPath, { relPath, path, source });
      return;
    }
    if (existing.path === path) return;
    existing.shadowedPaths ??= [];
    if (!existing.shadowedPaths.includes(path)) {
      existing.shadowedPaths.push(path);
    }
  };

  if (unit.kind === "note") {
    const parts = splitSafeRel(unit.id);
    if (!parts) return [];
    const rel = parts.join("/");
    if (isRealFileUnderRoot(canonRepo, [HARNESS_DIR, "notes", ...parts])) {
      record(rel, join(canonRepo, HARNESS_DIR, "notes", ...parts), "legacy");
    }
    if (storage.layout === "data-dir" && storage.dataRoot) {
      const key = storage.projectKey(canonRepo);
      if (isRealFileUnderRoot(storage.dataRoot, ["projects", key, "notes", ...parts])) {
        record(rel, join(storage.dataRoot, "projects", key, "notes", ...parts), "data-dir");
      }
    }
    return [...byRel.values()];
  }

  if (unit.kind === "flat_artifact") {
    const parts = splitSafeRel(unit.id);
    if (!parts || parts.length !== 1) return [];
    const fileName = parts[0]!;
    if (isRealFileUnderRoot(canonRepo, [HARNESS_DIR, "artifacts", fileName])) {
      record(fileName, join(canonRepo, HARNESS_DIR, "artifacts", fileName), "legacy");
    }
    if (storage.layout === "data-dir" && storage.dataRoot) {
      const key = storage.projectKey(canonRepo);
      const projDir = storage.projectDir(canonRepo);
      const ownerChat = storage.chatSegment(unit.chatSessionId);
      for (const chat of orderedProjectChatNames(projDir, ownerChat)) {
        if (isRealFileUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, "artifacts", fileName])) {
          record(fileName, join(storage.dataRoot, "projects", key, "chats", chat, "artifacts", fileName), "data-dir");
        }
      }
    }
    return [...byRel.values()];
  }

  const unitSubSegments =
    unit.kind === "goal"
      ? ["goals", unit.id]
      : unit.kind === "run"
        ? ["artifacts", unit.id]
        : unit.taskId
          ? ["artifacts", unit.id, unit.taskId]
          : null;
  if (!unitSubSegments) return [];

  // 1. Legacy real unit directory first so legacy wins on conflict.
  if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, ...unitSubSegments])) {
    const legacyUnitDir = join(canonRepo, HARNESS_DIR, ...unitSubSegments);
    for (const file of walkRegularFiles(legacyUnitDir)) {
      record(file.relPath, file.path, "legacy");
    }
  }

  // 2. Data-dir unit directory copies.
  if (storage.layout === "data-dir" && storage.dataRoot) {
    const key = storage.projectKey(canonRepo);
    const projDir = storage.projectDir(canonRepo);
    const ownerChat = storage.chatSegment(unit.chatSessionId);
    for (const chat of orderedProjectChatNames(projDir, ownerChat)) {
      if (isRealDirUnderRoot(storage.dataRoot, ["projects", key, "chats", chat, ...unitSubSegments])) {
        const dataUnitDir = join(storage.dataRoot, "projects", key, "chats", chat, ...unitSubSegments);
        for (const file of walkRegularFiles(dataUnitDir)) {
          record(file.relPath, file.path, "data-dir");
        }
      }
    }
  }

  return [...byRel.values()].sort((a, b) => a.relPath.localeCompare(b.relPath));
}

function readBridgeTarget(absPath: string): string | null {
  try {
    return readlinkSync(absPath);
  } catch {
    return null;
  }
}

/**
 * Enumerates all legacy units under `<repo>/.harness/` (goals, runs, bucket task dirs, flat artifact files, and note
 * files), including migration bridge symlinks (`isBridge: true`). Read-only; never moves or deletes anything.
 */
export function enumerateLegacyUnits(storage: StoragePaths, repoRoot: string): DiscoveredLegacyUnit[] {
  const canonRepo = canonicalPath(repoRoot);
  if (!isRealDirUnderRoot(canonRepo, [HARNESS_DIR])) return [];

  const units: DiscoveredLegacyUnit[] = [];
  const makeDest = (kind: StorageUnitKind, id: string, taskId?: string) => (owner?: OwnerRef) =>
    unitDataDirDestination(storage, {
      kind,
      repoRoot: canonRepo,
      id,
      ...(taskId !== undefined ? { taskId } : {}),
      chatSessionId: owner?.chatSessionId ?? null,
    });

  // 1. Legacy goal dirs: .harness/goals/<goalId>
  if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "goals"])) {
    const goalsRoot = join(canonRepo, HARNESS_DIR, "goals");
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
        bridgeTarget: isBridge ? readBridgeTarget(legacyPath) : null,
        destinationFor: makeDest("goal", entry.name),
      });
    }
  }

  // 2. Legacy artifacts: .harness/artifacts/<runId | bucketRun/<taskId> | flatFile>
  if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "artifacts"])) {
    const artifactsRoot = join(canonRepo, HARNESS_DIR, "artifacts");
    const entries = readdirSync(artifactsRoot, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const entryPath = join(artifactsRoot, entry.name);
      const isBridge = entry.isSymbolicLink();
      if (isDirectorTaskContainer(entry.name)) {
        // Bucket run: task-level units inside .harness/artifacts/<bucketRun>/<taskId>.
        if (!isBridge && entry.isDirectory()) {
          const taskEntries = readdirSync(entryPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
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
              bridgeTarget: taskBridge ? readBridgeTarget(taskPath) : null,
              destinationFor: makeDest("bucket_task", entry.name, taskEntry.name),
            });
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
        // Determine whether a bridge symlink represents a run dir or a flat file by inspecting target or falling back to name.
        const bridgeTarget = readBridgeTarget(entryPath);
        let isDirTarget = false;
        if (bridgeTarget) {
          try {
            isDirTarget = lstatSync(resolve(dirname(entryPath), bridgeTarget)).isDirectory();
          } catch {
            // Broken bridge: infer from file extension (flat spills end in an extension like .md/.json).
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
  }

  // 3. Legacy notes: files (or bridge symlinks) under .harness/notes (walk real subdirs recursively without following symlinks).
  if (isRealDirUnderRoot(canonRepo, [HARNESS_DIR, "notes"])) {
    const notesRoot = join(canonRepo, HARNESS_DIR, "notes");
    const walkNotes = (dir: string, prefix: string) => {
      const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
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
            bridgeTarget: isBridge ? readBridgeTarget(entryPath) : null,
            destinationFor: makeDest("note", rel),
          });
        }
      }
    };
    walkNotes(notesRoot, "");
  }

  return units;
}

/** Lists top-level entries under `<repo>/.harness/` that are not part of the standard harness directories. */
export function listLegacyUnknownEntries(repoRoot: string): string[] {
  const canonRepo = canonicalPath(repoRoot);
  if (!isRealDirUnderRoot(canonRepo, [HARNESS_DIR])) return [];
  const harnessDir = join(canonRepo, HARNESS_DIR);
  try {
    return readdirSync(harnessDir)
      .filter((name) => !KNOWN_LEGACY_HARNESS_ENTRIES.has(name))
      .sort()
      .map((name) => join(harnessDir, name));
  } catch {
    return [];
  }
}
