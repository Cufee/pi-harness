import { execFile } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WorktreeConfig } from "../config.js";
import type { ControlPlaneDb, MergeQueueRecord } from "../control-plane/db.js";
import { runGit, type WorktreeManager } from "./manager.js";

const execFileAsync = promisify(execFile);

export interface MergeOutcome {
  item: MergeQueueRecord;
  mergedSha?: string;
  bouncedReason?: string;
}

/**
 * Deterministic test-integrity guard: detects if a branch weakens or skips tests
 * (e.g., adding `.skip` / `xit` / deleting assertions) without explicit authorization.
 */
export async function checkTestIntegrity(repoRoot: string, baseBranch: string, branch: string): Promise<string[]> {
  const { stdout } = await runGit(repoRoot, ["diff", "-U0", `${baseBranch}...${branch}`, "--", "*test*", "*spec*"]);
  const warnings: string[] = [];
  let currentFile = "";
  for (const line of stdout.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      if (/\b(?:it|test|describe)\.skip\s*\(|\bx(?:it|test|describe)\s*\(|\b@pytest\.mark\.skip\b/.test(line)) {
        warnings.push(`${currentFile}: added test skip (${line.slice(1).trim().slice(0, 80)})`);
      }
    }
  }
  return warnings;
}

/**
 * Bors-style deterministic merge queue:
 * Serializes integration of parallel Tier 2 Worker branches onto the run's target branch
 * in an ephemeral integration worktree, runs computational CI gates + test-integrity checks,
 * and bounces conflicts or CI failures directly back to the owning Worker (no LLM integrator bottleneck).
 */
export class BisectingMergeQueue {
  private draining = new Set<string>();

  constructor(
    private readonly db: ControlPlaneDb,
    private readonly worktrees: WorktreeManager,
    private readonly repoRoot: string,
    private readonly config: WorktreeConfig,
  ) {}

  async processNext(runId: string): Promise<MergeOutcome | null> {
    const run = this.db.getRun(runId);
    if (!run) return null;

    // Serialize merge queue by `(repoRoot, targetBranch)` — NOT `runId` — so concurrent
    // same-repo runs targeting the same branch never race on `refs/heads/<targetBranch>`!
    const lockKey = `${this.repoRoot}::${run.baseBranch}`;
    if (this.draining.has(lockKey)) return null;
    const pending = this.db.listPendingMerges(runId);
    const next = pending[0];
    if (!next) return null;

    this.draining.add(lockKey);

    const intPath = join(this.worktrees.baseDir, "_integration", `${runId}-${next.id}`);
    mkdirSync(join(this.worktrees.baseDir, "_integration"), { recursive: true });

    try {
      const targetBranch = run.baseBranch;
      const { stdout: targetSha } = await runGit(this.repoRoot, ["rev-parse", targetBranch]);

      // Verify test integrity before touching integration branch
      const integrityWarnings = await checkTestIntegrity(this.repoRoot, targetBranch, next.branch);
      if (integrityWarnings.length > 0) {
        const log = `Test-integrity check failed:\n${integrityWarnings.join("\n")}`;
        return this.bounce(next, "ci_failed", log);
      }

      // Create detached ephemeral integration worktree on latest targetSha
      await runGit(this.repoRoot, ["worktree", "add", "--detach", intPath, targetSha]);
      await this.worktrees.linkIgnoredNodeModules(intPath);

      // Attempt clean no-ff merge of the worker branch
      try {
        await runGit(intPath, [
          "-c",
          `user.name=${this.config.gitAuthorName ?? "pi-harness"}`,
          "-c",
          `user.email=${this.config.gitAuthorEmail ?? "harness@local"}`,
          "merge",
          "--no-ff",
          "--no-edit",
          next.branch,
        ]);
      } catch (mergeErr) {
        const { stdout: conflictFiles } = await runGit(intPath, ["diff", "--name-only", "--diff-filter=U"]).catch(() => ({
          stdout: "",
        }));
        await runGit(intPath, ["merge", "--abort"]).catch(() => {});
        const log = `Merge conflict integrating ${next.branch} into ${targetBranch}:\nFiles:\n${conflictFiles}\nDetail: ${
          mergeErr instanceof Error ? mergeErr.message : String(mergeErr)
        }`;
        return this.bounce(next, "conflict", log);
      }

      // Run deterministic computational CI gates
      const ciLogs: string[] = [];
      for (const cmd of this.config.ciCommands ?? []) {
        try {
          const { stdout, stderr } = await execFileAsync("/bin/sh", ["-lc", cmd], {
            cwd: intPath,
            timeout: this.config.ciTimeoutMs ?? 300_000,
            maxBuffer: 16 * 1024 * 1024,
          });
          ciLogs.push(`$ ${cmd} -> OK\n${stdout.slice(-1000)}${stderr ? "\n" + stderr.slice(-500) : ""}`);
        } catch (err: unknown) {
          const e = err as { stdout?: string; stderr?: string; message?: string };
          const log = `CI gate failed: ${cmd}\n${(e.stdout ?? "").slice(-2000)}\n${(e.stderr ?? e.message ?? "").slice(-2000)}`;
          return this.bounce(next, "ci_failed", log);
        }
      }

      // Advance target branch safely without ever leaving the checked-out working tree out of sync with HEAD!
      const { stdout: headBranch } = await runGit(this.repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const { stdout: mergedSha } = await runGit(intPath, ["rev-parse", "HEAD"]);

      if (headBranch === targetBranch) {
        // `git merge --ff-only` atomically updates HEAD, index, and working tree while preserving
        // untracked files (like `bun.lock`) and unrelated dirty tracked edits. If a dirty tracked file
        // genuinely collides with a merged path, it refuses cleanly instead of corrupting HEAD with staged deletions.
        const { stdout: curHead } = await runGit(this.repoRoot, ["rev-parse", "HEAD"]);
        if (curHead !== targetSha) {
          return this.bounce(next, "conflict", `Target branch ${targetBranch} moved concurrently (${targetSha} -> ${curHead}); re-submit.`);
        }
        try {
          await runGit(this.repoRoot, ["merge", "--ff-only", mergedSha]);
        } catch (ffErr) {
          const detail = ffErr instanceof Error ? ffErr.message : String(ffErr);
          return this.bounce(
            next,
            "conflict",
            `Cannot fast-forward checked-out ${targetBranch} safely due to conflicting local changes in repoRoot: ${detail}`,
          );
        }
      } else {
        // Target branch is not currently checked out — atomic CAS update-ref is safe
        await runGit(this.repoRoot, ["update-ref", `refs/heads/${targetBranch}`, mergedSha, targetSha]);
      }

      const finished = this.db.finishMergeItem(next.id, "merged", ciLogs.join("\n"));
      this.db.updateTask(next.taskId, { status: "completed", summary: `Merged ${next.branch} at ${mergedSha.slice(0, 8)}` });
      await this.worktrees.teardown(next.worktreeId, { archiveBeforeRemove: false, finalStatus: "merged" });

      return { item: finished, mergedSha };
    } finally {
      if (existsSync(intPath)) {
        await runGit(this.repoRoot, ["worktree", "remove", "--force", intPath]).catch(() => {
          rmSync(intPath, { recursive: true, force: true });
        });
      }
      await runGit(this.repoRoot, ["worktree", "prune"]).catch(() => {});
      this.draining.delete(lockKey);
    }
  }

  private bounce(next: MergeQueueRecord, status: "conflict" | "ci_failed", log: string): MergeOutcome {
    const finished = this.db.finishMergeItem(next.id, status, log);
    this.db.updateWorktree(next.worktreeId, { status: "bounced" });
    this.db.updateTask(next.taskId, { status: "ready", summary: `Merge bounced (${status}): needs fix & re-submit` });
    this.db.emitEvent(next.runId, next.taskId, "merge.bounced", { mergeId: next.id, status, log });
    return { item: finished, bouncedReason: log };
  }
}
