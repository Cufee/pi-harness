import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;
export const DEFAULT_MAX_HASH_BYTES = 32 * 1024 * 1024;

/** Resolves `p` to its canonical real path, resolving the deepest existing ancestor when the leaf does not exist yet. */
export function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(canonicalPath(parent), basename(abs));
  }
}

/** Expands a leading `~` or `~/` to the current user's home directory and resolves to an absolute path. */
export function expandHome(raw: string): string {
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return resolve(homedir(), raw.slice(2));
  return resolve(raw);
}

/** True when `child` is strictly inside `parent` (not equal to `parent`). */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** True when `child` equals `parent` or is inside `parent`. */
export function isEqualOrWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** True when `seg` is a single safe path segment (no slashes, NUL, whitespace, `.`, or `..`). */
export function isSafeSegment(seg: string): boolean {
  return SAFE_SEGMENT_RE.test(seg) && seg !== "." && seg !== "..";
}

/**
 * True when every segment below `trustedRoot` exists as a real directory (not a symlink or file).
 * Never follows symlinks below `trustedRoot`.
 */
export function isRealDirUnderRoot(trustedRoot: string, segments: readonly string[]): boolean {
  let cur = trustedRoot;
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.includes("\0")) return false;
    cur = join(cur, seg);
    try {
      const st = lstatSync(cur);
      if (st.isSymbolicLink() || !st.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * True when every parent segment below `trustedRoot` is a real directory and the final segment is a real regular file
 * (not a symlink or directory). Never follows symlinks below `trustedRoot`.
 */
export function isRealFileUnderRoot(trustedRoot: string, segments: readonly string[]): boolean {
  if (segments.length === 0) return false;
  if (segments.length > 1 && !isRealDirUnderRoot(trustedRoot, segments.slice(0, -1))) return false;
  const leafSeg = segments[segments.length - 1]!;
  if (!leafSeg || leafSeg === "." || leafSeg === ".." || leafSeg.includes("\0")) return false;
  const leafPath = join(trustedRoot, ...segments);
  try {
    const st = lstatSync(leafPath);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

/**
 * Creates `segments` under `trustedRoot` one segment at a time, refusing any symlink or non-directory at or below
 * `trustedRoot`. Calls `onInvalid(path)` on conflict; if it returns an Error it is thrown, else null is returned.
 */
export function ensureDirsUnderRoot(
  trustedRoot: string,
  segments: readonly string[],
  onInvalid: (badPath: string) => Error | null,
): string | null {
  let cur = trustedRoot;
  for (const segment of segments) {
    if (!segment || segment === ".." || segment.includes("\0")) {
      const err = onInvalid(join(cur, segment));
      if (err) throw err;
      return null;
    }
    cur = join(cur, segment);
    try {
      mkdirSync(cur);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const st = lstatSync(cur);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      const err = onInvalid(cur);
      if (err) throw err;
      return null;
    }
  }
  return cur;
}

/**
 * Writes `<projectDir>/project.json` with `{ root, key, createdAt }` once, atomically, and never rewrites it if it
 * already exists. Uses hard-link commit from an exclusive temp file so concurrent callers never clobber each other.
 */
export function writeProjectJsonOnce(projectDir: string, repoRoot: string, key: string): void {
  const target = join(projectDir, "project.json");
  if (existsSync(target)) return;
  try {
    // Also skip if a symlink or other entry already exists at target.
    lstatSync(target);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  const payload = `${JSON.stringify({ root: canonicalPath(repoRoot), key, createdAt: new Date().toISOString() }, null, 2)}\n`;
  const temp = join(projectDir, `.project.json.${randomUUID()}.tmp`);
  writeFileSync(temp, payload, { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(temp, target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return;
      if (code === "EXDEV" || code === "EPERM" || code === "ENOTSUP" || code === "ENOSYS") {
        try {
          writeFileSync(target, payload, { flag: "wx", mode: 0o600 });
        } catch (wxErr) {
          if ((wxErr as NodeJS.ErrnoException).code !== "EEXIST") throw wxErr;
        }
        return;
      }
      throw err;
    }
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Safely hashes a regular file asynchronously using O_NOFOLLOW + O_NONBLOCK and pinned inode/realpath checks.
 * Returns null for missing, symlink, non-regular, or oversized files without blocking or throwing.
 */
export async function hashFileSha256(
  absPath: string,
  opts?: { maxBytes?: number },
): Promise<{ sha256: string; bytes: number } | null> {
  try {
    const resolved = resolve(absPath);
    const preStat = await lstat(resolved, { bigint: true });
    if (preStat.isSymbolicLink() || !preStat.isFile()) return null;
    if ((await realpath(resolved)) !== resolved) return null;

    const maxBytes =
      typeof opts?.maxBytes === "number" && Number.isFinite(opts.maxBytes) && opts.maxBytes >= 0
        ? Math.floor(opts.maxBytes)
        : DEFAULT_MAX_HASH_BYTES;

    const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const fdStat = await handle.stat({ bigint: true });
      if (!fdStat.isFile()) return null;
      const pathStat = await lstat(resolved, { bigint: true });
      if (
        pathStat.isSymbolicLink() ||
        fdStat.dev !== pathStat.dev ||
        fdStat.ino !== pathStat.ino ||
        (await realpath(resolved)) !== resolved
      ) {
        return null;
      }
      if (fdStat.size > BigInt(maxBytes)) return null;

      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(Math.min(65_536, Math.max(1, maxBytes)));
      let total = 0;
      while (true) {
        const remaining = maxBytes - total;
        const toRead = Math.min(chunk.length, remaining + 1);
        const { bytesRead } = await handle.read(chunk, 0, toRead, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maxBytes) return null;
        hash.update(chunk.subarray(0, bytesRead));
      }
      return { sha256: hash.digest("hex"), bytes: total };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Synchronous SHA-256 hash of a regular file using O_NOFOLLOW + O_NONBLOCK and pinned inode/realpath checks.
 * Intended for synchronous migration verification passes. Returns null for missing, symlink, non-regular, or oversized files.
 */
export function hashFileSha256Sync(
  absPath: string,
  opts?: { maxBytes?: number },
): { sha256: string; bytes: number } | null {
  let fd: number | null = null;
  try {
    const resolved = resolve(absPath);
    const preStat = lstatSync(resolved, { bigint: true });
    if (preStat.isSymbolicLink() || !preStat.isFile()) return null;
    if (realpathSync(resolved) !== resolved) return null;

    const maxBytes =
      typeof opts?.maxBytes === "number" && Number.isFinite(opts.maxBytes) && opts.maxBytes >= 0
        ? Math.floor(opts.maxBytes)
        : DEFAULT_MAX_HASH_BYTES;

    fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const fdStat = fstatSync(fd, { bigint: true });
    if (!fdStat.isFile()) return null;
    const pathStat = lstatSync(resolved, { bigint: true });
    if (
      pathStat.isSymbolicLink() ||
      fdStat.dev !== pathStat.dev ||
      fdStat.ino !== pathStat.ino ||
      realpathSync(resolved) !== resolved
    ) {
      return null;
    }
    if (fdStat.size > BigInt(maxBytes)) return null;

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(Math.min(65_536, Math.max(1, maxBytes)));
    let total = 0;
    while (true) {
      const remaining = maxBytes - total;
      const toRead = Math.min(chunk.length, remaining + 1);
      const bytesRead = readSync(fd, chunk, 0, toRead, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) return null;
      hash.update(chunk.subarray(0, bytesRead));
    }
    return { sha256: hash.digest("hex"), bytes: total };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Ignore close errors after read completion.
      }
    }
  }
}
