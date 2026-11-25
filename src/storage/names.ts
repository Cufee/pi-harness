import { resolveStorageLayout, type StorageLayout } from "./paths.js";

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

const LEGACY_ARCHIVE_PREFIX = "refs/harness/archive/";
const LEGACY_ARCHIVE_RE = /^refs\/harness\/archive\/([^/]+)\/([^/]+)$/;

function assertLegacyLayout(override?: StorageLayout): StorageLayout {
  const layout = resolveStorageLayout(override);
  if (layout === "data-dir") {
    throw new Error('Storage layout "data-dir" is not implemented yet');
  }
  return layout;
}

/** Base branch name for a worker task checkout (callers append any collision suffix). */
export function taskBranchName(run: RunNameRef, taskId: string, layout?: StorageLayout): string {
  assertLegacyLayout(layout);
  return `harness/${run.id}/${taskId}`;
}

/** Safety archive git ref for a worktree snapshot. */
export function archiveRef(run: RunNameRef, taskId: string, layout?: StorageLayout): string {
  assertLegacyLayout(layout);
  return `refs/harness/archive/${run.id}/${taskId}`;
}

/** Primary git ref storing the latest merged commit for a run. */
export function mergedRef(run: RunNameRef, layout?: StorageLayout): string {
  assertLegacyLayout(layout);
  return `refs/harness/merged/${run.id}`;
}

/** Candidate merged git refs for a run in reader preference order. */
export function mergedRefCandidates(run: RunNameRef, layout?: StorageLayout): string[] {
  return [mergedRef(run, layout)];
}

/** Git `for-each-ref` ref prefixes covering safety archive refs, optionally scoped to one run. */
export function archiveRefPatterns(run?: RunNameRef | string, layout?: StorageLayout): string[] {
  assertLegacyLayout(layout);
  if (!run) return ["refs/harness/archive"];
  const runId = typeof run === "string" ? run : run.id;
  return [`refs/harness/archive/${runId}`];
}

/** Parses a harness safety archive ref into its run and task identifiers, or returns null when it is not one. */
export function parseArchiveRef(ref: string): ParsedArchiveRef | null {
  const match = LEGACY_ARCHIVE_RE.exec(ref);
  if (!match) return null;
  return { runId: match[1]!, taskId: match[2]! };
}

/** True when `ref` is a harness safety archive ref (and matches `runId` when supplied). */
export function isArchiveRef(ref: string, runId?: string): boolean {
  const parsed = parseArchiveRef(ref);
  if (!parsed) return false;
  if (runId !== undefined && parsed.runId !== runId) return false;
  return ref.startsWith(LEGACY_ARCHIVE_PREFIX);
}

/** Returns the owning run ID of a harness safety archive ref, or null when `ref` is not an archive ref. */
export function archiveRefRunId(ref: string): string | null {
  return parseArchiveRef(ref)?.runId ?? null;
}

/** Display template for a run's merged ref in tool descriptions and prompts. */
export function describeMergedRefTemplate(layout?: StorageLayout): string {
  assertLegacyLayout(layout);
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
