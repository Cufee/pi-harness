import { isAbsolute, relative, resolve, sep } from "node:path";
import { legacyStoragePaths } from "../storage/paths.js";

/**
 * @deprecated Use `StoragePaths.isProtectedWorktreePath` instead.
 * Write-protection predicate for harness-mediated structured writes (ACP fs/write_text_file and
 * edit/delete/move permission requests; usable by Director tools). Pure and synchronous.
 *
 * `path` is a write target and `root` the allowed root that admitted it. Callers check both the
 * lexical target (requested path resolved against `root`) and its canonical form before any side
 * effect. A target is protected when, case-insensitively:
 *  - any segment of its absolute path is `.git` (repository metadata and linked-worktree pointer
 *    files; no legitimate workspace sits below such a segment), or
 *  - relative to `root`, it enters the legacy sibling-worktree directory tree.
 */
export function isProtectedWritePath(root: string, path: string): boolean {
  const resolvedRoot = resolve(root);
  const absolute = resolve(resolvedRoot, path);
  const rel = relative(resolvedRoot, absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return absolute.split(sep).some((segment) => segment.toLowerCase() === ".git");
  }
  return legacyStoragePaths.isProtectedWorktreePath(absolute, resolvedRoot);
}
