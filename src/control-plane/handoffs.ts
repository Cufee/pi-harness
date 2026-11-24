import { REJECTIONS } from "../advisories/rejections.js";
import {
  buildMinimalFallbackResultJson,
  formatFallbackSummary,
  SUMMARY_LIMIT,
  type ControlPlaneDb,
  type EscalationRecord,
  type FallbackGitSummary,
  type TaskKind,
  type TaskRecord,
} from "./db.js";

export { formatFallbackSummary, SUMMARY_LIMIT, type FallbackGitSummary };

export function isReadOnlyKind(kind: string): kind is "research" | "plan" | "verify" {
  return kind === "research" || kind === "plan" || kind === "verify";
}

type TaskSource = { path: string; lines?: string; symbol?: string; note?: string };

export interface ExternalDeliverableInput {
  ref: string;
  sha?: string;
  note?: string;
}

export interface ExternalDeliverableRecord extends ExternalDeliverableInput {
  worktree_head: string | null;
  unmerged_commits: string[];
  archive_ref?: string;
}

/**
 * Synchronously settles a task to a terminal status. For non-Tier-1 tasks, writes a minimal
 * partial fallback payload (`partial: true`, reason, and already-indexed artifact paths) in the
 * same DB update that sets the terminal status, so parents never observe a bare terminal row.
 * Tier 1 tasks retain their bare status/summary update unchanged.
 */
export function settleTaskMinimalFallback(
  db: ControlPlaneDb,
  task: Pick<TaskRecord, "id" | "runId" | "tier">,
  status: "failed" | "cancelled" | "blocked",
  summary: string,
  reason: string,
): void {
  if (task.tier === 1) {
    db.updateTask(task.id, { status, summary });
    return;
  }
  const run = db.getRun(task.runId);
  if (!run) {
    db.updateTask(task.id, { status, summary });
    return;
  }
  let artifactPaths: string[] = [];
  try {
    artifactPaths = db.listArtifacts(run.id, task.id, 50).map((a) => a.path).slice(0, 20);
  } catch {
    artifactPaths = [];
  }
  db.updateTask(task.id, {
    status,
    summary,
    resultJson: buildMinimalFallbackResultJson({
      repoRoot: run.repoRoot,
      status,
      reason,
      artifactPaths,
    }),
  });
}

export function validateTaskHandoff(kind: TaskKind, args: Record<string, unknown>) {
  const fullSummary = args.summary;
  if (typeof fullSummary !== "string") throw new Error("return_task requires a summary string");
  const partial = args.partial === true;
  const artifactPaths = args.artifact_paths === undefined ? [] : args.artifact_paths;
  if (!Array.isArray(artifactPaths) || !artifactPaths.every((path) => typeof path === "string")) {
    throw new Error("return_task artifact_paths must be an array of strings");
  }
  const rawSources = args.sources === undefined ? [] : args.sources;
  if (
    !Array.isArray(rawSources) ||
    (isReadOnlyKind(kind) && rawSources.length === 0 && !(partial && artifactPaths.length > 0))
  ) {
    throw REJECTIONS.handoffSources(kind);
  }
  const sources: TaskSource[] = rawSources.map((source) => {
    const { path, lines, symbol, note } = source ?? {};
    if (typeof path !== "string" || !path.trim() || [lines, symbol, note].some((v) => v !== undefined && typeof v !== "string")) {
      throw new Error("return_task sources require a non-empty path and optional string lines, symbol, and note");
    }
    return { path, lines, symbol, note };
  });
  let externalDeliverable: ExternalDeliverableInput | undefined;
  if (args.external_deliverable !== undefined) {
    if (kind !== "worker") {
      throw new Error("return_task external_deliverable is only supported for Tier 2 workers.");
    }
    if (args.status !== undefined && args.status !== "completed") {
      throw new Error(
        `return_task external_deliverable is only supported with status 'completed' (got '${String(args.status)}'). Use status 'completed' to settle an external deliverable, or omit external_deliverable when returning '${String(args.status)}'.`,
      );
    }
    const raw = args.external_deliverable;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("return_task external_deliverable must be an object with a non-empty string ref");
    }
    const { ref, sha, note } = raw as Record<string, unknown>;
    if (typeof ref !== "string" || !ref.trim()) {
      throw new Error("return_task external_deliverable requires a non-empty string ref");
    }
    if (sha !== undefined && typeof sha !== "string") {
      throw new Error("return_task external_deliverable sha must be a string when provided");
    }
    if (note !== undefined && typeof note !== "string") {
      throw new Error("return_task external_deliverable note must be a string when provided");
    }
    externalDeliverable = {
      ref,
      ...(sha !== undefined ? { sha } : {}),
      ...(note !== undefined ? { note } : {}),
    };
  }
  return {
    summary: fullSummary,
    sources,
    artifactPaths,
    partial,
    ...(externalDeliverable ? { externalDeliverable } : {}),
  };
}

function matchRecordedArtifactPath(pointerPath: string, artifactPaths: unknown): string | null {
  if (!Array.isArray(artifactPaths) || artifactPaths.length === 0) return null;
  const trimmed = pointerPath.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (!trimmed || trimmed.split("/").includes("..")) return null;
  const isRel = !trimmed.startsWith("/");
  for (const raw of artifactPaths) {
    if (typeof raw !== "string") continue;
    const candidate = raw.trim().replaceAll("\\", "/").replace(/^\.\//, "");
    if (!candidate) continue;
    if (candidate === trimmed || (isRel && candidate.endsWith(`/${trimmed}`))) {
      return raw;
    }
  }
  return null;
}

export function compactTaskHandoff(task: TaskRecord, escalations: EscalationRecord[] = []) {
  const result = task.resultJson ? JSON.parse(task.resultJson) : null;
  const paused = task.status === "paused_quota" || task.summary?.startsWith("Paused (quota):");
  const unstructured = typeof result?.text === "string" && typeof result?.summary !== "string";
  // Harness-synthesized handoff for a non-orchestrator task that ended without return_task.
  const fallback = typeof result?.fallback?.summary === "string" && task.kind !== "orchestrator" ? result.fallback : null;
  let summary = task.summary?.slice(0, SUMMARY_LIMIT) ?? null;
  if (paused) {
    const reason = task.summary?.startsWith("Paused (quota):") ? task.summary.slice("Paused (quota):".length).trim() : task.summary?.trim() ?? "";
    summary =
      `Task ${task.id} in run ${task.runId} is paused on provider quota (${reason || `cause not recorded; inspect with \`pi-harness tree ${task.runId}\``}). ` +
      `Not a failure; its work and handoff are kept and it continues in place when run ${task.runId} resumes. ` +
      "The run resumes by itself only if the harness scheduled an automatic quota resume; otherwise the Director " +
      `(resume_run) or the operator (\`pi-harness resume ${task.runId}\`) resumes it, so escalate if you need it sooner. ` +
      "Do not respawn or cancel it.";
  }
  else if (fallback) summary = fallback.summary.slice(0, SUMMARY_LIMIT);
  else if (unstructured) {
    // Tier 1 orchestrators have no return_task; their natural final reply is the handoff.
    const reply = task.kind === "orchestrator" ? result.text.trim() : "";
    summary = reply
      ? reply.slice(0, SUMMARY_LIMIT)
      : task.kind === "orchestrator"
        ? "Task ended without a structured handoff or a final reply."
        : "Task ended without a structured handoff.";
  }
  const artifactPaths = paused ? [] : result?.artifact_paths ?? result?.artifactPaths ?? fallback?.artifact_paths ?? [];
  let overflow: { path: string; next_offset: number; total_chars?: number } | null = null;
  if (!paused) {
    const meta = result?.summary_overflow;
    if (meta && typeof meta === "object" && typeof meta.path === "string" && meta.path) {
      overflow = {
        path: meta.path,
        next_offset: typeof meta.next_offset === "number" && Number.isFinite(meta.next_offset) ? meta.next_offset : 0,
        ...(typeof meta.total_chars === "number" && Number.isFinite(meta.total_chars) ? { total_chars: meta.total_chars } : {}),
      };
    } else if (fallback) {
      if (fallback.output_truncated !== false) {
        const m = /\n\[Full output: ([^\]]+)\]$/.exec(fallback.summary);
        const matched = m?.[1] ? matchRecordedArtifactPath(m[1], artifactPaths) : null;
        if (matched) overflow = { path: matched, next_offset: 0 };
      }
    } else if (typeof task.summary === "string") {
      const m = /\n\n\[Full summary: ([^\]]+)\]$/.exec(task.summary);
      const matched = m?.[1] ? matchRecordedArtifactPath(m[1], artifactPaths) : null;
      if (matched) overflow = { path: matched, next_offset: 0 };
    }
  }
  const externalDeliverable =
    !paused &&
    result?.external_deliverable &&
    typeof result.external_deliverable === "object" &&
    !Array.isArray(result.external_deliverable) &&
    typeof result.external_deliverable.ref === "string"
      ? (result.external_deliverable as ExternalDeliverableRecord)
      : undefined;
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    status: task.status,
    ...(task.goalVersion != null ? { goalVersion: task.goalVersion } : {}),
    summary,
    ...(!paused && (result?.partial === true || result?.fallback?.partial === true) ? { partial: true as const } : {}),
    ...(overflow
      ? {
          truncated: true as const,
          full_summary: {
            path: overflow.path,
            next_offset: overflow.next_offset,
            ...(overflow.total_chars !== undefined ? { total_chars: overflow.total_chars } : {}),
            read_with: "artifact_read { path, offset: next_offset, task_id }",
          },
        }
      : {}),
    sources: paused ? [] : result?.sources ?? [],
    artifact_paths: artifactPaths,
    ...(externalDeliverable ? { external_deliverable: externalDeliverable } : {}),
    escalations: escalations.filter((entry) => entry.fromTaskId === task.id),
  };
}
