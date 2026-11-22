import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { WorktreeConfig } from "../config.js";
import type { ControlPlaneDb, WorktreeRecord } from "../control-plane/db.js";

export function canonicalPath(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
}

export async function runGit(cwd: string, args: string[], timeoutMs = 30_000): Promise<GitResult> {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

export interface LiveWorktreeInfo {
  record: WorktreeRecord | null;
  path: string;
  branch: string | null;
  head: string | null;
  existsOnDisk: boolean;
  dirty: boolean;
  orphaned: boolean;
}

export interface CleanupReport {
  removed: string[];
  archivedRefs: string[];
  prunedAdminEntries: boolean;
  expiredArchiveRefs: string[];
  errors: Array<{ target: string; error: string }>;
}

export class WorktreeManager {
  constructor(
    private readonly db: ControlPlaneDb,
    private readonly repoRoot: string,
    private readonly config: WorktreeConfig,
  ) {}

  get baseDir(): string {
    return resolve(canonicalPath(this.repoRoot), this.config.dir ?? ".harness/worktrees");
  }

  async resolveRepoInfo(): Promise<{ baseBranch: string; baseSha: string }> {
    const [branchRes, shaRes] = await Promise.all([
      runGit(this.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]),
      runGit(this.repoRoot, ["rev-parse", "HEAD"]),
    ]);
    if (branchRes.stdout === "HEAD") {
      throw new Error("Cannot start harness run from detached HEAD; checkout a branch first.");
    }
    return { baseBranch: branchRes.stdout, baseSha: shaRes.stdout };
  }

  async bootstrapWorktree(wtPath: string): Promise<void> {
    // Optional fast workspace setup hook (e.g., APFS clone-on-write node_modules)
    if (this.config.setupCommand) {
      await execFileAsync("/bin/sh", ["-lc", this.config.setupCommand], {
        cwd: wtPath,
        env: { ...process.env, HARNESS_REPO_ROOT: this.repoRoot, HARNESS_WORKTREE_PATH: wtPath },
        timeout: 120_000,
      });
    } else {
      await this.linkIgnoredNodeModules(wtPath);
    }
  }

  async createForWorker(runId: string, taskId: string, baseSha?: string): Promise<WorktreeRecord> {
    const repoCanon = canonicalPath(this.repoRoot);
    const active = this.db.listWorktrees().filter((w) => {
      if (w.status !== "active" && w.status !== "queued" && w.status !== "bounced") return false;
      const run = this.db.getRun(w.runId);
      if (run && canonicalPath(run.repoRoot) !== repoCanon) return false;
      const ownerTask = this.db.getTask(w.taskId);
      if (ownerTask && (ownerTask.status === "failed" || ownerTask.status === "cancelled" || ownerTask.status === "completed")) {
        return false;
      }
      return existsSync(w.path);
    });
    const limit = this.config.maxConcurrentWorkers ?? 4;
    if (active.length >= limit) {
      throw new Error(`Worktree concurrency cap reached (${active.length}/${limit}). Finish or clean a worker first.`);
    }

    const run = this.db.getRun(runId);
    const sha =
      baseSha ??
      (run?.baseBranch
        ? await runGit(this.repoRoot, ["rev-parse", "--verify", `${run.baseBranch}^{commit}`])
            .then((r) => r.stdout)
            .catch(async () => (await runGit(this.repoRoot, ["rev-parse", "HEAD"])).stdout)
        : (await runGit(this.repoRoot, ["rev-parse", "HEAD"])).stdout);
    const baseBranchName = `harness/${runId}/${taskId}`;
    let branch = baseBranchName;
    let suffix = 1;
    while (
      await runGit(this.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).then(
        () => true,
        () => false,
      )
    ) {
      suffix++;
      branch = `${baseBranchName}-${suffix}`;
    }
    const wtPath = join(this.baseDir, runId, suffix === 1 ? taskId : `${taskId}-${suffix}`);

    mkdirSync(join(this.baseDir, runId), { recursive: true });
    await runGit(this.repoRoot, ["worktree", "add", "-b", branch, wtPath, sha]);

    try {
      await this.bootstrapWorktree(wtPath);
    } catch (err) {
      try {
        await runGit(this.repoRoot, ["worktree", "remove", "--force", wtPath]);
      } catch {
        rmSync(wtPath, { recursive: true, force: true });
      }
      await runGit(this.repoRoot, ["branch", "-D", branch]).catch(() => {});
      await runGit(this.repoRoot, ["worktree", "prune"]).catch(() => {});
      throw err;
    }

    return this.db.recordWorktree({ runId, taskId, path: wtPath, branch, baseSha: sha });
  }

  /**
   * Automatically symlinks `<repoRoot>/node_modules` into a fresh worktree when gitignored,
   * so workers and CI gates (`tsc`, `bun test`) work on turn 1 without redundant installs.
   */
  async linkIgnoredNodeModules(wtPath: string): Promise<void> {
    const srcNm = join(this.repoRoot, "node_modules");
    const dstNm = join(wtPath, "node_modules");
    if (!existsSync(srcNm) || existsSync(dstNm)) return;
    try {
      await runGit(this.repoRoot, ["check-ignore", "-q", "node_modules"]);
      symlinkSync(srcNm, dstNm, "dir");
      // If `.gitignore` uses `node_modules/` (directory-only), git treats a symlink named `node_modules`
      // as untracked (`?? node_modules`)! Add `/node_modules` to local `.git/info/exclude` (untracked)
      // so the worktree stays 100% clean for `git status` and `submit_for_merge`.
      const isIgnoredInWt = await runGit(wtPath, ["check-ignore", "-q", "node_modules"]).then(
        () => true,
        () => false,
      );
      if (!isIgnoredInWt) {
        const { stdout: commonDir } = await runGit(this.repoRoot, ["rev-parse", "--git-common-dir"]);
        const excludePath = resolve(this.repoRoot, commonDir, "info", "exclude");
        mkdirSync(resolve(excludePath, ".."), { recursive: true });
        const existing = existsSync(excludePath) ? readFileSync(excludePath, "utf8") : "";
        if (!existing.split("\n").some((line) => line.trim() === "/node_modules" || line.trim() === "node_modules")) {
          const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
          appendFileSync(excludePath, `${prefix}/node_modules\n`, "utf8");
        }
      }
    } catch {
      // Not gitignored or symlink unsupported — leave untouched
    }
  }

  async isDirty(wtPath: string, opts?: { ignoreHarnessDir?: boolean }): Promise<boolean> {
    if (!existsSync(wtPath)) return false;
    const args = opts?.ignoreHarnessDir ? ["status", "--porcelain", "--", ".", ":!.harness"] : ["status", "--porcelain"];
    const { stdout } = await runGit(wtPath, args);
    return stdout.length > 0;
  }

  /**
   * Captures any uncommitted or unmerged commits into a lightweight safety git ref
   * before tearing down a worktree so agent work is never silently lost.
   */
  async snapshotToArchiveRef(wt: WorktreeRecord): Promise<string | null> {
    if (!existsSync(wt.path)) return null;
    const ref = `refs/harness/archive/${wt.runId}/${wt.taskId}`;
    try {
      const dirty = await this.isDirty(wt.path);
      if (dirty) {
        await runGit(wt.path, ["add", "-A"]);
        const { stdout: treeSha } = await runGit(wt.path, ["write-tree"]);
        const { stdout: headSha } = await runGit(wt.path, ["rev-parse", "HEAD"]);
        const { stdout: commitSha } = await runGit(wt.path, [
          "commit-tree",
          treeSha,
          "-p",
          headSha,
          "-m",
          `harness safety snapshot for ${wt.runId}/${wt.taskId}`,
        ]);
        await runGit(this.repoRoot, ["update-ref", ref, commitSha]);
      } else {
        const { stdout: headSha } = await runGit(wt.path, ["rev-parse", "HEAD"]);
        if (headSha === wt.baseSha) return null; // nothing to archive
        await runGit(this.repoRoot, ["update-ref", ref, headSha]);
      }
      this.db.updateWorktree(wt.id, { archiveRef: ref });
      return ref;
    } catch {
      return null;
    }
  }

  async teardown(worktreeId: string, opts?: { archiveBeforeRemove?: boolean; finalStatus?: WorktreeRecord["status"] }): Promise<string | null> {
    const wt = this.db.getWorktree(worktreeId);
    if (!wt) return null;

    let archiveRef: string | null = wt.archiveRef;
    if (opts?.archiveBeforeRemove) {
      archiveRef = await this.snapshotToArchiveRef(wt);
    }

    if (existsSync(wt.path)) {
      try {
        await runGit(this.repoRoot, ["worktree", "remove", "--force", wt.path]);
      } catch {
        rmSync(wt.path, { recursive: true, force: true });
      }
    }

    // Delete temporary working branch (best-effort)
    try {
      await runGit(this.repoRoot, ["branch", "-D", wt.branch]);
    } catch {
      // Branch may already be deleted
    }

    await runGit(this.repoRoot, ["worktree", "prune"]);
    this.db.updateWorktree(wt.id, {
      status: opts?.finalStatus ?? "removed",
      archiveRef,
      cleanedAt: Date.now(),
    });
    this.db.emitEvent(wt.runId, wt.taskId, "worktree.removed", { worktreeId: wt.id, branch: wt.branch, archiveRef });
    return archiveRef;
  }

  async listLive(runId?: string): Promise<LiveWorktreeInfo[]> {
    const dbRecords = this.db.listWorktrees(runId);
    const byPath = new Map(dbRecords.map((r) => [canonicalPath(r.path), r]));
    const base = canonicalPath(this.baseDir);

    const { stdout } = await runGit(this.repoRoot, ["worktree", "list", "--porcelain"]);
    const entries = parsePorcelainWorktrees(stdout);
    const results: LiveWorktreeInfo[] = [];

    const verifyPrefix = canonicalPath(join(this.baseDir, "_verify"));
    const intPrefix = canonicalPath(join(this.baseDir, "_integration"));
    for (const entry of entries) {
      const abs = canonicalPath(entry.path);
      if (!abs.startsWith(base)) continue;
      // Never treat active ephemeral verification or merge integration worktrees as orphans during sweep
      if (abs.startsWith(verifyPrefix) || abs.startsWith(intPrefix)) continue;
      const rec = byPath.get(abs) ?? null;
      const existsOnDisk = existsSync(abs);
      const dirty = existsOnDisk ? await this.isDirty(abs) : false;
      const task = rec ? this.db.getTask(rec.taskId) : null;
      const orphaned =
        !rec ||
        rec.status === "removed" ||
        rec.status === "merged" ||
        (task != null && ["completed", "failed", "cancelled"].includes(task.status));

      results.push({
        record: rec,
        path: abs,
        branch: entry.branch,
        head: entry.head,
        existsOnDisk,
        dirty,
        orphaned,
      });
    }
    return results;
  }

  /**
   * Sweeps orphaned/settled worktrees, removes stale git admin metadata,
   * and expires old safety archive refs past retention window.
   */
  async sweep(opts?: { runId?: string; forceAll?: boolean }): Promise<CleanupReport> {
    const report: CleanupReport = {
      removed: [],
      archivedRefs: [],
      prunedAdminEntries: false,
      expiredArchiveRefs: [],
      errors: [],
    };

    const live = await this.listLive(opts?.runId);
    for (const item of live) {
      if (!opts?.forceAll && !item.orphaned) continue;
      try {
        if (item.record) {
          const ref = await this.teardown(item.record.id, {
            archiveBeforeRemove: item.dirty || item.record.status !== "merged",
            finalStatus: item.record.status === "merged" ? "merged" : "archived",
          });
          if (ref) report.archivedRefs.push(ref);
          report.removed.push(item.path);
        } else {
          try {
            await runGit(this.repoRoot, ["worktree", "remove", "--force", item.path]);
          } catch {
            rmSync(item.path, { recursive: true, force: true });
          }
          if (item.branch) {
            await runGit(this.repoRoot, ["branch", "-D", item.branch]).catch(() => {});
          }
          report.removed.push(item.path);
        }
      } catch (err) {
        report.errors.push({ target: item.path, error: err instanceof Error ? err.message : String(err) });
      }
    }

    // Reconcile DB worktree rows whose directory no longer exists on disk (existing orphaned dirs were torn down above)
    const repoCanon = canonicalPath(this.repoRoot);
    for (const rec of this.db.listWorktrees(opts?.runId)) {
      if (rec.status !== "active" && rec.status !== "queued" && rec.status !== "bounced") continue;
      const run = this.db.getRun(rec.runId);
      if (run && canonicalPath(run.repoRoot) !== repoCanon) continue;
      if (!existsSync(rec.path)) {
        this.db.updateWorktree(rec.id, {
          status: "removed",
          cleanedAt: Date.now(),
        });
      }
    }

    try {
      await runGit(this.repoRoot, ["worktree", "prune"]);
      report.prunedAdminEntries = true;
    } catch (err) {
      report.errors.push({ target: "git worktree prune", error: err instanceof Error ? err.message : String(err) });
    }

    // Delete stale local `harness/*` branches with no active/queued/bounced DB record and not checked out
    try {
      const [{ stdout: branchesOut }, { stdout: wtListOut }] = await Promise.all([
        runGit(this.repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/harness"]),
        runGit(this.repoRoot, ["worktree", "list", "--porcelain"]),
      ]);
      const checkedOutBranches = new Set(
        parsePorcelainWorktrees(wtListOut)
          .map((e) => e.branch)
          .filter((b): b is string => Boolean(b)),
      );
      const activeDbBranches = new Set(
        this.db
          .listWorktrees()
          .filter((w) => w.status === "active" || w.status === "queued" || w.status === "bounced")
          .map((w) => w.branch),
      );
      const runPrefix = opts?.runId ? `harness/${opts.runId}/` : null;

      for (const raw of branchesOut.split("\n")) {
        const branch = raw.trim();
        if (!branch) continue;
        if (runPrefix && !branch.startsWith(runPrefix)) continue;
        if (activeDbBranches.has(branch) || checkedOutBranches.has(branch)) continue;
        try {
          await runGit(this.repoRoot, ["branch", "-D", branch]);
        } catch (err) {
          report.errors.push({ target: branch, error: err instanceof Error ? err.message : String(err) });
        }
      }
    } catch (err) {
      report.errors.push({ target: "refs/heads/harness", error: err instanceof Error ? err.message : String(err) });
    }

    // Expire old safety archive refs past retentionDays
    const retentionMs = (this.config.archiveRetentionDays ?? 7) * 86_400_000;
    const cutoffSec = Math.floor((Date.now() - retentionMs) / 1000);
    try {
      const { stdout } = await runGit(this.repoRoot, [
        "for-each-ref",
        "--format=%(refname) %(committerdate:unix)",
        "refs/harness/archive",
      ]);
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const [ref, tsStr] = line.trim().split(/\s+/);
        if (!ref) continue;
        const ts = Number(tsStr ?? 0);
        if (opts?.forceAll || (ts > 0 && ts < cutoffSec)) {
          await runGit(this.repoRoot, ["update-ref", "-d", ref]);
          report.expiredArchiveRefs.push(ref);
        }
      }
    } catch {
      // No archive refs yet
    }

    return report;
  }
}

function parsePorcelainWorktrees(stdout: string): Array<{ path: string; head: string | null; branch: string | null }> {
  const blocks = stdout.split(/\n\n+/).filter((b) => b.trim().length > 0);
  return blocks.map((block) => {
    let path = "";
    let head: string | null = null;
    let branch: string | null = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
    return { path, head, branch };
  });
}
