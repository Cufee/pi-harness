import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { cleanTestEnv } from "../../../test/helpers/hot-update-fixture.js";

const HOST_HOME = homedir();
const HOST_PI_HARNESS = resolve(HOST_HOME, ".pi-harness");
const HOST_LOCAL_BIN = resolve(HOST_HOME, ".local", "bin");

function resolveWithExistingAncestor(target: string): string {
  const abs = resolve(target);
  if (existsSync(abs)) return realpathSync(abs);
  const parts: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    parts.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...parts);
}

export function assertStrictlyUnderRoot(label: string, targetPath: string, root: string): string {
  const canonicalRoot = realpathSync(root);
  const resolved = resolveWithExistingAncestor(targetPath);
  if (resolved === canonicalRoot || !resolved.startsWith(canonicalRoot + sep)) {
    throw new Error(`SAFETY ABORT: ${label} (${resolved}) is outside temp root (${canonicalRoot})`);
  }
  if (resolved === HOST_PI_HARNESS || resolved.startsWith(HOST_PI_HARNESS + sep)) {
    throw new Error(`SAFETY ABORT: ${label} (${resolved}) resolves inside host ${HOST_PI_HARNESS}`);
  }
  if (resolved === HOST_LOCAL_BIN || resolved.startsWith(HOST_LOCAL_BIN + sep)) {
    throw new Error(`SAFETY ABORT: ${label} (${resolved}) resolves inside host ${HOST_LOCAL_BIN}`);
  }
  return resolved;
}

export function seedInstallCacheReadOnly(installDir: string): string[] {
  const hostInstall = join(HOST_PI_HARNESS, "install");
  const seeded: string[] = [];
  if (!existsSync(hostInstall)) return seeded;

  // Symlink individual binaries inside freshly created temp dirs so install.sh writes (such as bunx) stay in temp.
  const hostBunRoot = join(hostInstall, "bun");
  if (existsSync(hostBunRoot)) {
    for (const entry of readdirSync(hostBunRoot)) {
      const srcBun = join(hostBunRoot, entry, "bin", "bun");
      if (!existsSync(srcBun)) continue;
      const dstBinDir = join(installDir, "bun", entry, "bin");
      mkdirSync(dstBinDir, { recursive: true });
      symlinkSync(srcBun, join(dstBinDir, "bun"));
      seeded.push(`bun/${entry}/bin/bun (symlink)`);
    }
  }

  const hostOctofsRoot = join(hostInstall, "tools", "octofs");
  if (existsSync(hostOctofsRoot)) {
    for (const entry of readdirSync(hostOctofsRoot)) {
      const srcBin = join(hostOctofsRoot, entry, "bin", "octofs");
      if (!existsSync(srcBin)) continue;
      const dstBinDir = join(installDir, "tools", "octofs", entry, "bin");
      mkdirSync(dstBinDir, { recursive: true });
      symlinkSync(srcBin, join(dstBinDir, "octofs"));
      seeded.push(`tools/octofs/${entry}/bin/octofs (symlink)`);
    }
  }

  const hostDownloads = join(hostInstall, "cache", "downloads");
  if (existsSync(hostDownloads)) {
    const dstDownloads = join(installDir, "cache", "downloads");
    mkdirSync(dstDownloads, { recursive: true });
    for (const entry of readdirSync(hostDownloads)) {
      symlinkSync(join(hostDownloads, entry), join(dstDownloads, entry));
    }
    seeded.push("cache/downloads/* (symlink)");
  }

  // Copy cache/bun so `bun install` never writes back into ~/.pi-harness/install/cache/bun.
  const hostBunCache = join(hostInstall, "cache", "bun");
  if (existsSync(hostBunCache)) {
    const dstBunCache = join(installDir, "cache", "bun");
    cpSync(hostBunCache, dstBunCache, { recursive: true });
    seeded.push("cache/bun (copy)");
  }

  return seeded;
}

export async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; label: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  console.log(`\n$ ${opts.label}`);
  console.log(`  cwd: ${opts.cwd}`);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: cleanTestEnv(opts.env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
  console.log(`  exit: ${result.code}`);
  if (result.stdout.trim()) {
    console.log("  stdout:");
    for (const line of result.stdout.trimEnd().split(/\r?\n/)) {
      console.log(`    ${line}`);
    }
  }
  if (result.stderr.trim()) {
    console.log("  stderr:");
    for (const line of result.stderr.trimEnd().split(/\r?\n/)) {
      console.log(`    ${line}`);
    }
  }
  return result;
}

export async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}` +
      (lastErr ? ` (lastErr: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : ""),
  );
}

export function queryDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

export function listLingeringProcessesForRoot(root: string): string[] {
  const psOut = execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8", timeout: 5_000 });
  const matches: string[] = [];
  for (const line of psOut.split(/\r?\n/)) {
    if (!line.includes(root)) continue;
    const m = line.trim().match(/^(\d+)\s+/);
    const pid = m ? Number(m[1]) : NaN;
    if (pid === process.pid) continue;
    matches.push(line.trim());
  }
  return matches;
}

export function pass(label: string, detail?: string): void {
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
}

export function fail(label: string, detail?: string): void {
  console.error(`[FAIL] ${label}${detail ? ` — ${detail}` : ""}`);
}

export type PrevMode = "auto" | "origin" | "head";

export interface PrevRefResolution {
  ref: string;
  sha: string;
  rule:
    | "env:STORAGE_UPGRADE_PREV_REF"
    | "flag:--prev"
    | "origin/main"
    | "parent-of-src/storage/paths.ts"
    | "explicit:HEAD"
    | "fallback:HEAD";
  hasStorageModule: boolean;
}

function refHasFile(repoRoot: string, ref: string, relPath: string): boolean {
  try {
    const out = execFileSync("git", ["ls-tree", "--name-only", ref, "--", relPath], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function tryRevParseCommit(repoRoot: string, ref: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export function resolvePrevRef(repoRoot: string, explicitFlag?: string): PrevRefResolution {
  const flagRaw = explicitFlag?.trim();
  const envRef = process.env.STORAGE_UPGRADE_PREV_REF?.trim();
  const envMode = process.env.STORAGE_UPGRADE_PREV_MODE?.trim();
  const requested = flagRaw || envRef || envMode || "auto";

  if (requested === "head" || requested === "HEAD") {
    const sha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return {
      ref: "HEAD",
      sha,
      rule: "explicit:HEAD",
      hasStorageModule: refHasFile(repoRoot, "HEAD", "src/storage/paths.ts"),
    };
  }

  if (requested !== "auto" && requested !== "origin") {
    const sha = execFileSync("git", ["rev-parse", "--verify", `${requested}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return {
      ref: requested,
      sha,
      rule: flagRaw ? "flag:--prev" : "env:STORAGE_UPGRADE_PREV_REF",
      hasStorageModule: refHasFile(repoRoot, requested, "src/storage/paths.ts"),
    };
  }

  // Config (a): origin/main when present and predating src/storage/paths.ts, else parent of commit adding paths.ts.
  const originSha = tryRevParseCommit(repoRoot, "origin/main");
  if (originSha && !refHasFile(repoRoot, "origin/main", "src/storage/paths.ts")) {
    return {
      ref: "origin/main",
      sha: originSha,
      rule: "origin/main",
      hasStorageModule: false,
    };
  }

  const logOut = execFileSync("git", ["log", "--diff-filter=A", "--format=%H", "--", "src/storage/paths.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (logOut.length > 0) {
    const oldestAddCommit = logOut[logOut.length - 1]!;
    const parentRef = `${oldestAddCommit}^`;
    const sha = execFileSync("git", ["rev-parse", "--verify", `${parentRef}^{commit}`], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    return {
      ref: parentRef,
      sha,
      rule: "parent-of-src/storage/paths.ts",
      hasStorageModule: refHasFile(repoRoot, parentRef, "src/storage/paths.ts"),
    };
  }

  const sha = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  return {
    ref: "HEAD",
    sha,
    rule: "fallback:HEAD",
    hasStorageModule: refHasFile(repoRoot, "HEAD", "src/storage/paths.ts"),
  };
}

/**
 * In PREV=HEAD + NEW=data-dir mode, pins the disposable temp copy under `checkoutPrevDir` (never REPO_ROOT)
 * so it acts as a pre-flip legacy-only binary: it ignores PI_HARNESS_STORAGE_LAYOUT while preserving it in
 * process.env across supervisor handover to NEW, and runs legacy on Phase 8 rollback.
 */
export function pinCheckoutPrevToLegacyLayout(checkoutPrevDir: string, root: string): boolean {
  const pathsTs = join(checkoutPrevDir, "src", "storage", "paths.ts");
  assertStrictlyUnderRoot("checkoutPrevDir/src/storage/paths.ts", pathsTs, root);
  if (!existsSync(pathsTs)) return false;
  const orig = readFileSync(pathsTs, "utf8");
  const target = "return parseStorageLayout(processStorageLayoutRaw, ENV_STORAGE_LAYOUT);";
  if (!orig.includes(target)) {
    throw new Error(`Expected parseStorageLayout call not found in temp ${pathsTs}`);
  }
  const patched = orig.replace(
    target,
    'return "legacy"; // storage-upgrade-check: disposable checkout-prev pinned to pre-flip legacy layout',
  );
  writeFileSync(pathsTs, patched, "utf8");
  return true;
}

export function materializeRefWithGitArchive(repoRoot: string, ref: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  const archive = execFileSync(
    "git",
    ["archive", ref, "--", "src", "proto", "package.json", "bun.lock", "tsconfig.json", "install.sh"],
    { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 },
  );
  execFileSync("tar", ["-xf", "-", "-C", destDir], { input: archive });
}

/** Computes the exact 12-hex release ID used by install.sh. */
export function computeInstallReleaseId(srcDir: string): string {
  const script = [
    'if command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$@"; }',
    'else sha256() { shasum -a 256 "$@"; }; fi',
    'FILES="src proto package.json bun.lock tsconfig.json"',
    'find $FILES -type f | LC_ALL=C sort | while IFS= read -r f; do sha256 "$f"; done | sha256 | cut -c1-12',
  ].join("\n");
  return execFileSync("sh", ["-c", script], { cwd: srcDir, encoding: "utf8" }).trim();
}

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export interface SnapshotFileEntry {
  relPath: string;
  absPath: string;
  sha256: string;
}

/** Walks `<repoDir>/.harness` excluding `worktrees` contents and hashes every file. */
export function snapshotHarnessTree(repoDir: string): SnapshotFileEntry[] {
  const harnessRoot = join(repoDir, ".harness");
  const out: SnapshotFileEntry[] = [];
  if (!existsSync(harnessRoot)) return out;

  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(harnessRoot, full);
      if (rel === "worktrees" || rel.startsWith(`worktrees${sep}`)) continue;
      const st = lstatSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        out.push({ relPath: rel, absPath: full, sha256: sha256File(full) });
      }
    }
  };
  walk(harnessRoot);
  return out;
}

export function readRecordedFakePidsForTasks(fakeDir: string, taskIds: Iterable<string>): number[] {
  const wanted = new Set(taskIds);
  const pidsDir = join(fakeDir, "pids");
  if (!existsSync(pidsDir)) return [];
  const out: number[] = [];
  for (const name of readdirSync(pidsDir)) {
    const pid = Number(name);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      const token = readFileSync(join(pidsDir, name), "utf8").trim();
      const baseTaskId = token.split("@")[0] ?? token;
      if (wanted.has(baseTaskId)) out.push(pid);
    } catch {
      // ignore races
    }
  }
  return out;
}

export interface TreeSnapshot {
  files: Record<string, string>;
  symlinks: Record<string, string>;
  dirs: string[];
}

/**
 * Walks `rootDir` without following symlinks and returns sorted maps of relative paths to sha256 hashes (files),
 * symlink targets (symlinks), and directory paths.
 */
export function snapshotTree(rootDir: string, opts?: { excludeTopLevel?: readonly string[] }): TreeSnapshot {
  const files: Record<string, string> = {};
  const symlinks: Record<string, string> = {};
  const dirs: string[] = [];
  if (!existsSync(rootDir)) return { files, symlinks, dirs };
  const excluded = new Set(opts?.excludeTopLevel ?? []);

  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(rootDir, full).replaceAll("\\", "/");
      const top = rel.split("/")[0] ?? "";
      if (excluded.has(top)) continue;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        symlinks[rel] = readlinkSync(full);
      } else if (st.isDirectory()) {
        dirs.push(rel);
        walk(full);
      } else if (st.isFile()) {
        files[rel] = sha256File(full);
      }
    }
  };
  walk(rootDir);
  return { files, symlinks, dirs };
}

/** Captures exact raw bytes (base64) of every `.gitignore` file under `repoRoot` (excluding `.git` and `.harness/worktrees`). */
export function snapshotGitignoreBytes(repoRoot: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(repoRoot, full).replaceAll("\\", "/");
      if (rel === ".git" || rel === ".harness/worktrees") continue;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile() && entry.name === ".gitignore") {
        out[rel] = readFileSync(full).toString("base64");
      }
    }
  };
  walk(repoRoot);
  return out;
}

export function getLogFileSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

export interface MigrationSummaryLine {
  raw: string;
  moved: number;
  deferred: number;
  errors: number;
  budgetHit: boolean;
  rowsRewritten: number;
  bridgesRemoved: number;
  remaining: number;
  elapsedMs: number;
}

export interface ParsedMigrationLog {
  summaryLines: MigrationSummaryLine[];
  failureLines: string[];
  rawText: string;
}

export function parseMigrationLogSection(logPath: string, fromByteOffset: number): ParsedMigrationLog {
  if (!existsSync(logPath)) return { summaryLines: [], failureLines: [], rawText: "" };
  const buf = readFileSync(logPath);
  const start = buf.length < fromByteOffset ? 0 : fromByteOffset;
  const rawText = buf.subarray(start).toString("utf8");
  const summaryLines: MigrationSummaryLine[] = [];
  const failureLines: string[] = [];

  const readInt = (body: string, key: string): number => {
    const m = new RegExp(`(?:^|\\s)${key}=(\\d+)`).exec(body);
    return m ? Number(m[1]) : 0;
  };

  for (const line of rawText.split(/\r?\n/)) {
    const sumMatch = /\[harnessd [^\]]+\] storage migration: (.+)$/.exec(line);
    if (sumMatch) {
      const body = sumMatch[1]!;
      summaryLines.push({
        raw: line,
        moved: readInt(body, "moved"),
        deferred: readInt(body, "deferred"),
        errors: readInt(body, "errors"),
        budgetHit: /(?:^|\s)budgetHit=true/.test(body),
        rowsRewritten: readInt(body, "rowsRewritten"),
        bridgesRemoved: readInt(body, "bridgesRemoved"),
        remaining: readInt(body, "remaining"),
        elapsedMs: readInt(body, "elapsedMs"),
      });
      continue;
    }
    if (/\[harnessd [^\]]+\] storage migration failed:/.test(line)) {
      failureLines.push(line);
    }
  }
  return { summaryLines, failureLines, rawText };
}

export interface PhaseResult {
  id: number;
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
  durationMs: number;
  detail?: string;
}

export function formatSummaryTable(phases: PhaseResult[], totalMs: number): string {
  const headers = ["Phase", "Name", "Status", "Duration"];
  const rows = phases.map((p) => [
    String(p.id),
    p.name,
    p.status,
    p.status === "SKIP" ? "-" : `${(p.durationMs / 1000).toFixed(2)}s`,
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const sepLine = `+-${widths.map((w) => "-".repeat(w)).join("-+-")}-+`;
  const fmtRow = (cols: string[]) => `| ${cols.map((c, i) => c.padEnd(widths[i]!)).join(" | ")} |`;
  return [
    sepLine,
    fmtRow(headers),
    sepLine,
    ...rows.map(fmtRow),
    sepLine,
    `Total wall-clock duration: ${(totalMs / 1000).toFixed(2)}s`,
  ].join("\n");
}
