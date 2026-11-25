import { legacyStoragePaths, resolveStorageLayout, type StorageLayout } from "./paths.js";

/** Minimal run descriptor accepted by git-name builders (`RunRecord` and `RunRef` satisfy it structurally). */
export interface RunNameRef {
  id: string;
  chatSessionId?: string | null;
}

export interface ParsedArchiveRef {
  runId: string;
  taskId: string;
  chatSessionId?: string | null;
}

const LEGACY_ARCHIVE_RE = /^refs\/harness\/archive\/([^/]+)\/([^/]+)$/;
const CHAT_ARCHIVE_RE = /^refs\/harness\/([^/]+)\/archive\/([^/]+)\/([^/]+)$/;

function chatSegmentFor(run: RunNameRef): string {
  return legacyStoragePaths.chatSegment(run.chatSessionId);
}

/** Base branch name for a worker task checkout (callers append any collision suffix). */
export function taskBranchName(run: RunNameRef, taskId: string, layout?: StorageLayout): string {
  if (resolveStorageLayout(layout) === "data-dir") {
    return `harness/${chatSegmentFor(run)}/${run.id}/${taskId}`;
  }
  return `harness/${run.id}/${taskId}`;
}

/** Safety archive git ref for a worktree snapshot. */
export function archiveRef(run: RunNameRef, taskId: string, layout?: StorageLayout): string {
  if (resolveStorageLayout(layout) === "data-dir") {
    return `refs/harness/${chatSegmentFor(run)}/archive/${run.id}/${taskId}`;
  }
  return `refs/harness/archive/${run.id}/${taskId}`;
}

/** Primary git ref storing the latest merged commit for a run. */
export function mergedRef(run: RunNameRef, layout?: StorageLayout): string {
  if (resolveStorageLayout(layout) === "data-dir") {
    return `refs/harness/${chatSegmentFor(run)}/merged/${run.id}`;
  }
  return `refs/harness/merged/${run.id}`;
}

/** Candidate merged git refs for a run in reader preference order. */
export function mergedRefCandidates(run: RunNameRef, layout?: StorageLayout): string[] {
  if (resolveStorageLayout(layout) === "data-dir") {
    return [mergedRef(run, "data-dir"), mergedRef(run, "legacy")];
  }
  return [mergedRef(run, "legacy")];
}

/** Git `for-each-ref` patterns covering both legacy and chat-scoped safety archive refs, optionally scoped to one run. */
export function archiveRefPatterns(run?: RunNameRef | string, layout?: StorageLayout): string[] {
  resolveStorageLayout(layout);
  if (!run) {
    return ["refs/harness/archive/*/*", "refs/harness/*/archive/*/*"];
  }
  const runId = typeof run === "string" ? run : run.id;
  return [`refs/harness/archive/${runId}/*`, `refs/harness/*/archive/${runId}/*`];
}

/** Parses a harness safety archive ref (legacy or chat-scoped) into its identifiers, or returns null when it is not one. */
export function parseArchiveRef(ref: string): ParsedArchiveRef | null {
  const chatMatch = CHAT_ARCHIVE_RE.exec(ref);
  if (chatMatch) {
    return {
      runId: chatMatch[2]!,
      taskId: chatMatch[3]!,
      chatSessionId: chatMatch[1]!,
    };
  }
  const legacyMatch = LEGACY_ARCHIVE_RE.exec(ref);
  if (legacyMatch) {
    // Disambiguate against `refs/harness/<chat>/merged/<run>` when `<chat>` is literally `"archive"`.
    if (legacyMatch[1] === "merged") return null;
    return {
      runId: legacyMatch[1]!,
      taskId: legacyMatch[2]!,
    };
  }
  return null;
}

/** True when `ref` is a harness safety archive ref (and matches `runId` when supplied). */
export function isArchiveRef(ref: string, runId?: string): boolean {
  const parsed = parseArchiveRef(ref);
  if (!parsed) return false;
  if (runId !== undefined && parsed.runId !== runId) return false;
  return true;
}

/** Returns the owning run ID of a harness safety archive ref, or null when `ref` is not an archive ref. */
export function archiveRefRunId(ref: string): string | null {
  return parseArchiveRef(ref)?.runId ?? null;
}

/** Display template for a run's merged ref in tool descriptions and prompts. */
export function describeMergedRefTemplate(layout?: StorageLayout): string {
  if (resolveStorageLayout(layout) === "data-dir") {
    return "refs/harness/<chat>/merged/<runId>";
  }
  return "refs/harness/merged/<runId>";
}

/** Fallback description sentence for `goal_trigger_review` naming the merged ref. */
export function describeMergedRefFallback(layout?: StorageLayout): string {
  return `If the run's base branch was deleted and verify_ref is unset, gates fall back to the run's last merged commit (${describeMergedRefTemplate(layout)}); if neither exists, verification fails with remediation options.`;
}

/** Diagnostic fragment when verification cannot resolve a run's merged ref. */
export function describeMissingMergedRef(
  run: RunNameRef,
  latestMergedSha?: string | null,
  layout?: StorageLayout,
): string {
  const ref = mergedRef(run, layout);
  return latestMergedSha
    ? `has no merged ref (${ref}; latest promoted commit was ${latestMergedSha.slice(0, 7)})`
    : `has no merged commit (${ref})`;
}
