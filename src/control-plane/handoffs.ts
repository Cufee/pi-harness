import type { EscalationRecord, TaskKind, TaskRecord } from "./db.js";

export function isReadOnlyKind(kind: string): kind is "research" | "plan" | "verify" {
  return kind === "research" || kind === "plan" || kind === "verify";
}

export const SUMMARY_LIMIT = 2000;
type TaskSource = { path: string; lines?: string; symbol?: string; note?: string };

export function validateTaskHandoff(kind: TaskKind, args: Record<string, unknown>) {
  const fullSummary = args.summary;
  if (typeof fullSummary !== "string") throw new Error("return_task requires a summary string");
  const artifactPaths = args.artifact_paths === undefined ? [] : args.artifact_paths;
  if (!Array.isArray(artifactPaths) || !artifactPaths.every((path) => typeof path === "string")) {
    throw new Error("return_task artifact_paths must be an array of strings");
  }
  const rawSources = args.sources === undefined ? [] : args.sources;
  if (!Array.isArray(rawSources) || (isReadOnlyKind(kind) && rawSources.length === 0)) {
    throw new Error(`return_task requires a non-empty sources array for ${kind} tasks (each source needs a path)`);
  }
  const sources: TaskSource[] = rawSources.map((source) => {
    const { path, lines, symbol, note } = source ?? {};
    if (typeof path !== "string" || !path.trim() || [lines, symbol, note].some((v) => v !== undefined && typeof v !== "string")) {
      throw new Error("return_task sources require a non-empty path and optional string lines, symbol, and note");
    }
    return { path, lines, symbol, note };
  });
  return { summary: fullSummary, sources, artifactPaths };
}

export function compactTaskHandoff(task: TaskRecord, escalations: EscalationRecord[] = []) {
  const result = task.resultJson ? JSON.parse(task.resultJson) : null;
  const paused = task.status === "paused_quota" || task.summary?.startsWith("Paused (quota):");
  const unstructured = typeof result?.text === "string" && typeof result?.summary !== "string";
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
  else if (unstructured) {
    // Tier 1 orchestrators have no return_task; their natural final reply is the handoff.
    const reply = task.kind === "orchestrator" ? result.text.trim() : "";
    summary = reply
      ? reply.slice(0, SUMMARY_LIMIT)
      : task.kind === "orchestrator"
        ? "Task ended without a structured handoff or a final reply."
        : "Task ended without a structured handoff.";
  }
  return {
    id: task.id,
    title: task.title,
    kind: task.kind,
    status: task.status,
    summary,
    sources: paused ? [] : result?.sources ?? [],
    artifact_paths: paused ? [] : result?.artifact_paths ?? result?.artifactPaths ?? [],
    escalations: escalations.filter((entry) => entry.fromTaskId === task.id),
  };
}
