import { runGit } from "../worktree/manager.js";
import type { KbEntry, KnowledgeBaseStore } from "./store.js";

export interface MaintainerTriggerConfig {
  /** Spawn maintainer once candidate count reaches threshold (default 8) */
  candidateCountThreshold?: number;
  /** Spawn maintainer once queued candidate bytes reach threshold (default 12000) */
  candidateBytesThreshold?: number;
  /** Soft active entry cap triggering GC compression (default 150) */
  activeSoftCap?: number;
  /** Zero-hit entry age in days before flagging for decay review (default 30) */
  unusedDecayDays?: number;
}

export interface DirtyEntryDiff {
  entry: KbEntry;
  changeKind: "deleted" | "modified";
  changedFiles: string[];
  diffExcerpt: string;
}

export interface MaintainerPreCheckReport {
  repoRoot: string;
  headSha: string;
  shouldSpawnMaintainer: boolean;
  staleMarked: number;
  candidatesPending: number;
  reasons: string[];
  candidates: KbEntry[];
  dirtyEntries: DirtyEntryDiff[];
  flaggedStale: KbEntry[];
  decayCandidates: KbEntry[];
  duplicateClusters: Array<{ anchorId: string; similarIds: string[] }>;
}

interface ParsedDiffFile {
  deleted: boolean;
  files: string[];
}

function normalizeRelPath(raw: string): string {
  return raw.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function matchesWatchedPattern(normFile: string, rawPattern: string, ignoreWildcards: boolean): boolean {
  const norm = normalizeRelPath(rawPattern);
  if (!norm) return false;
  if (ignoreWildcards && (norm === "*" || norm === "**" || norm === "**/*")) return false;
  if (normFile === norm || normFile.startsWith(`${norm}/`)) return true;
  if (/[*?[{]/.test(norm)) {
    return new Bun.Glob(norm).match(normFile);
  }
  return false;
}

/**
 * Deterministic $0-token pre-check pipeline for the Knowledge Maintainer / GC Agent.
 * Inspects git diffs against each active entry's `verified_sha` & `evidence_paths` (or `path_globs`),
 * auto-marks modified/deleted evidence as `stale`, pre-clusters duplicates via FTS5, and detects
 * unused decaying entries — spawning an LLM Maintainer ONLY when real curation work exists.
 */
export class KnowledgeMaintainer {
  constructor(
    private readonly kb: KnowledgeBaseStore,
    private readonly cfg: MaintainerTriggerConfig = {},
  ) {}

  async runDeterministicPreCheck(
    repoRoot: string,
    repoScope = repoRoot,
    headRef = "HEAD",
  ): Promise<MaintainerPreCheckReport> {
    let headSha = "";
    try {
      const { stdout } = await runGit(repoRoot, ["rev-parse", headRef]);
      headSha = stdout.trim();
    } catch {
      // Non-git, shallow, or unborn-HEAD repo — skip git diff inspection gracefully
      headSha = "";
    }

    const candidates = this.kb.listByStatus(repoScope, "candidate");
    const active = this.kb.listByStatus(repoScope, "active");
    const alreadyStale = this.kb.listByStatus(repoScope, "stale");
    const stats = this.kb.stats(repoScope);

    const dirtyEntries: DirtyEntryDiff[] = [];
    const newlyFlaggedStale: KbEntry[] = [...alreadyStale];
    let staleMarked = 0;

    if (headSha) {
      const diffCache = new Map<string, ParsedDiffFile[] | null>();

      const getDiffFiles = async (verifiedSha: string): Promise<ParsedDiffFile[] | null> => {
        if (diffCache.has(verifiedSha)) return diffCache.get(verifiedSha) ?? null;
        try {
          const { stdout: nameStatus } = await runGit(repoRoot, [
            "-c",
            "core.quotepath=false",
            "diff",
            "--name-status",
            `${verifiedSha}..${headSha}`,
          ]);
          const parsed: ParsedDiffFile[] = [];
          for (const line of nameStatus.split("\n").filter(Boolean)) {
            const parts = line.split(/\t+/);
            const status = parts[0] ?? "";
            const files = parts.slice(1).map(normalizeRelPath).filter(Boolean);
            if (files.length === 0) continue;
            parsed.push({ deleted: status.startsWith("D"), files });
          }
          diffCache.set(verifiedSha, parsed);
          return parsed;
        } catch {
          // Ignore invalid/shallow SHA errors gracefully
          diffCache.set(verifiedSha, null);
          return null;
        }
      };

      for (const entry of active) {
        // Only auto-stale on explicit `evidencePaths` (never broad `pathGlobs` like `src/**`, which stale on routine merges).
        const useEvidence = true;
        const watchedPatterns = entry.evidencePaths;
        if (!entry.verifiedSha || watchedPatterns.length === 0) continue;
        if (entry.lastCheckedSha === headSha) continue;

        if (entry.verifiedSha === headSha) {
          this.kb.markCheckedClean(entry.id, headSha);
          continue;
        }

        const diffFiles = await getDiffFiles(entry.verifiedSha);
        if (diffFiles === null) continue;

        const deletedSet = new Set<string>();
        const changedSet = new Set<string>();
        for (const item of diffFiles) {
          for (const file of item.files) {
            if (watchedPatterns.some((p) => matchesWatchedPattern(file, p, !useEvidence))) {
              changedSet.add(file);
              if (item.deleted) deletedSet.add(file);
            }
          }
        }

        if (changedSet.size === 0) {
          // Evidence completely untouched since verified_sha — mark clean at $0 token cost
          this.kb.markCheckedClean(entry.id, headSha);
          continue;
        }

        const deletedFiles = [...deletedSet];
        const changedFiles = [...changedSet];

        if (deletedFiles.length > 0) {
          const updated = this.kb.flagStale(entry.id, `evidence_deleted: ${deletedFiles.join(", ")}`);
          newlyFlaggedStale.push(updated);
          staleMarked++;
          dirtyEntries.push({
            entry: updated,
            changeKind: "deleted",
            changedFiles,
            diffExcerpt: `Deleted evidence files: ${deletedFiles.join(", ")}`,
          });
        } else {
          const { stdout: diff } = await runGit(repoRoot, [
            "diff",
            "-U2",
            `${entry.verifiedSha}..${headSha}`,
            "--",
            ...changedFiles,
          ]).catch(() => ({ stdout: "" }));
          const updated = this.kb.flagStale(entry.id, `evidence_modified: ${changedFiles.join(", ")}`);
          newlyFlaggedStale.push(updated);
          staleMarked++;
          dirtyEntries.push({
            entry: updated,
            changeKind: "modified",
            changedFiles,
            diffExcerpt: diff.split("\n").slice(0, 120).join("\n"),
          });
        }
      }
    }

    // Zero-hit decay detection
    const decayCutoff = Date.now() - (this.cfg.unusedDecayDays ?? 30) * 86_400_000;
    const decayCandidates = active.filter((e) => e.hitCount === 0 && e.createdAt < decayCutoff);

    // FTS5 duplicate pre-clustering across candidates & active entries
    const duplicateClusters: Array<{ anchorId: string; similarIds: string[] }> = [];
    for (const c of candidates) {
      const hits = this.kb
        .search({ query: c.title, repoScope, kinds: [c.kind], includeCandidates: true, limit: 4 })
        .filter((h) => h.id !== c.id);
      if (hits.length > 0) {
        duplicateClusters.push({ anchorId: c.id, similarIds: hits.map((h) => h.id) });
      }
    }

    const reasons: string[] = [];
    if (candidates.length >= (this.cfg.candidateCountThreshold ?? 8)) {
      reasons.push(`candidate_count (${candidates.length})`);
    }
    if (stats.candidateBytes >= (this.cfg.candidateBytesThreshold ?? 12_000)) {
      reasons.push(`candidate_volume (${stats.candidateBytes}B)`);
    }
    if (dirtyEntries.length > 0) reasons.push(`dirty_evidence (${dirtyEntries.length})`);
    if (newlyFlaggedStale.length > 0) reasons.push(`stale_entries (${newlyFlaggedStale.length})`);
    if (stats.active > (this.cfg.activeSoftCap ?? 150)) reasons.push(`active_over_cap (${stats.active})`);
    if (decayCandidates.length > 0) reasons.push(`unused_decay (${decayCandidates.length})`);

    return {
      repoRoot,
      headSha,
      shouldSpawnMaintainer: reasons.length > 0,
      staleMarked,
      candidatesPending: candidates.length,
      reasons,
      candidates,
      dirtyEntries,
      flaggedStale: newlyFlaggedStale,
      decayCandidates,
      duplicateClusters,
    };
  }

  /** Builds the compact review packet passed to a read-only Knowledge Maintainer Task Agent. */
  buildMaintainerPrompt(report: MaintainerPreCheckReport): string {
    const headLabel = report.headSha ? report.headSha.slice(0, 10) : "unknown";
    const lines: string[] = [
      `# Knowledge Base Maintenance Pass (HEAD=${headLabel})`,
      `Triggers: ${report.reasons.join(", ")}`,
      "",
      "You are the read-only Knowledge Maintainer. Curate, verify against actual code at HEAD, deduplicate, and garbage-collect.",
      "Tools: `kb_search`, `kb_get`, `kb_promote`, `kb_flag_stale`, `kb_archive`.",
      "Rules:",
      "- Inspect full details via `kb_get` and check for duplicates via `kb_search` before mutating entries.",
      "- Verify evidence files at HEAD before calling `kb_promote`; never promote unverified guesses to active `invariant` entries.",
      "- Use `kb_flag_stale` for entries needing follow-up and `kb_archive` (with `superseded_by` when replacing) for obsolete or lint-enforceable rules.",
    ];

    if (report.candidates.length > 0) {
      lines.push("", `## Candidate Entries to Verify/Merge (${report.candidates.length})`);
      for (const c of report.candidates) {
        lines.push(`- ${c.id} [${c.kind}] "${c.title}" | evidence=${c.evidencePaths.join(",")} | summary=${c.summary}`);
      }
    }

    if (report.dirtyEntries.length > 0) {
      lines.push("", `## Active Entries With Modified/Deleted Evidence (${report.dirtyEntries.length})`);
      for (const d of report.dirtyEntries) {
        lines.push(`- ${d.entry.id} (${d.changeKind}: ${d.changedFiles.join(", ")}) "${d.entry.title}"`);
        lines.push("```diff\n" + d.diffExcerpt.slice(0, 1200) + "\n```");
      }
    }

    if (report.duplicateClusters.length > 0) {
      lines.push("", "## Potential Duplicate Clusters");
      for (const cl of report.duplicateClusters) {
        lines.push(`- ${cl.anchorId} overlaps: ${cl.similarIds.join(", ")}`);
      }
    }

    if (report.decayCandidates.length > 0) {
      lines.push("", `## Zero-Hit Decay Candidates (${report.decayCandidates.length})`);
      for (const e of report.decayCandidates) {
        lines.push(`- ${e.id} [${e.kind}] "${e.title}" (0 hits since ${new Date(e.createdAt).toISOString().slice(0, 10)})`);
      }
    }

    return lines.join("\n");
  }
}
