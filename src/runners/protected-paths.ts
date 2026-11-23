import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Write-protection predicate for harness-mediated structured writes (ACP fs/write_text_file and
 * edit/delete/move permission requests; usable by Director tools). Pure and synchronous.
 *
 * `path` is a write target and `root` the allowed root that admitted it. Callers check both the
 * lexical target (requested path resolved against `root`) and its canonical form before any side
 * effect. A target is protected when, case-insensitively:
 *  - any segment of its absolute path is `.git` (repository metadata and linked-worktree pointer
 *    files; no legitimate workspace sits below such a segment), or
 *  - relative to `root`, it contains the consecutive segments `.harness/worktrees` (sibling task
 *    checkouts). This rule is root-relative because every task workspace itself lives under
 *    `<repo>/.harness/worktrees`.
 * A custom `worktree.dir` is not covered by the second rule, and agents with shell access are not
 * contained by this check.
 */
export function isProtectedWritePath(root: string, path: string): boolean {
  const absolute = resolve(root, path);
  if (absolute.split(sep).some((segment) => segment.toLowerCase() === ".git")) return true;
  const rel = relative(resolve(root), absolute);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  const segments = rel.split(sep).map((segment) => segment.toLowerCase());
  return segments.some((segment, i) => segment === ".harness" && segments[i + 1] === "worktrees");
}
