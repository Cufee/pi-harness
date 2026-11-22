import type { ControlPlaneDb, TaskRecord } from "./db.js";

export interface TaskActivitySnapshot {
  id: string;
  parentId: string | null;
  tier: number;
  kind: TaskRecord["kind"];
  title: string;
  status: TaskRecord["status"];
  model: string | null;
  effort: string | null;
  profileId: string;
  generation: number;
  /** Automatically derived from latest `agent.tool` / `task.status` / `quota.*` event (no model reporting required). */
  currentAction: string | null;
  toolCalls: number;
  filesEdited: number;
  elapsedMs: number;
  ctxPct: number | null;
}

export type RunActivityPhase =
  | "researching"
  | "planning"
  | "implementing"
  | "verifying"
  | "merging"
  | "paused_quota"
  | "completed"
  | "failed"
  | "stopped"
  | "idle";

export interface RunActivitySummary {
  runId: string;
  phase: RunActivityPhase;
  elapsedMs: number;
  filesEdited: number;
  openEscalations: number;
  modelsUsed: string[];
  counts: {
    total: number;
    running: number;
    completed: number;
    failed: number;
    verifyRunning: number;
    verifyCompleted: number;
  };
  tasks: TaskActivitySnapshot[];
}

const LIVE_STATUSES = new Set<TaskRecord["status"]>(["running", "draining", "waiting_children", "merging"]);
const TERMINAL_STATUSES = new Set<TaskRecord["status"]>([
  "completed",
  "failed",
  "cancelled",
  "returned_for_rescope",
  "blocked",
]);

function cleanToolLabel(raw: string): string {
  return raw
    .replace(/^mcp[._/]harness[._/]+/i, "harness:")
    .replace(/^mcp__harness__/i, "harness:")
    .trim();
}

/**
 * Automatically projects structured live subagent & run telemetry directly from SQLite
 * (`tasks`, `events`, `artifacts`, `escalations`). Models do NOT need to call any extra
 * reporting tool — every tool call, file edit, verification task, rollover, and status
 * transition is captured mechanically by the control plane.
 */
export function buildRunActivitySummary(db: ControlPlaneDb, runId: string, now = Date.now()): RunActivitySummary {
  const run = db.getRun(runId);
  const allTasks = db.listTasks(runId).filter((t) => t.profileId !== "director");
  const escalations = db.listEscalations(runId, "open");

  // Single indexed query for artifact edit counts per task
  const editPathsByTask = new Map<string, Set<string>>();
  const allEditedPaths = new Set<string>();
  const artRows = db.db
    .prepare("SELECT task_id, path FROM artifacts WHERE run_id = ? AND kind IN ('edit', 'write')")
    .all(runId) as Array<{ task_id: string; path: string }>;
  for (const r of artRows) {
    allEditedPaths.add(r.path);
    let set = editPathsByTask.get(r.task_id);
    if (!set) {
      set = new Set();
      editPathsByTask.set(r.task_id, set);
    }
    set.add(r.path);
  }

  // Single indexed query for recent tool/quota events per task (capped so large runs stay O(1) fast)
  const toolCounts = new Map<string, number>();
  const latestActionByTask = new Map<string, string>();
  const seenCallIdsByTask = new Map<string, Set<string>>();
  const evRows = db.db
    .prepare(
      `SELECT task_id, type, payload_json FROM events
       WHERE run_id = ? AND task_id IS NOT NULL AND type IN ('agent.tool', 'agent.timer_sleep', 'quota.agent_retrying', 'quota.agent_paused', 'agent.rollover')
       ORDER BY seq DESC LIMIT 400`,
    )
    .all(runId) as Array<{ task_id: string; type: string; payload_json: string }>;

  for (const row of evRows) {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const tid = row.task_id;
    if (row.type === "agent.tool") {
      const callId = typeof payload.id === "string" && payload.id ? payload.id : null;
      if (callId) {
        let seen = seenCallIdsByTask.get(tid);
        if (!seen) {
          seen = new Set();
          seenCallIdsByTask.set(tid, seen);
        }
        if (!seen.has(callId)) {
          seen.add(callId);
          toolCounts.set(tid, (toolCounts.get(tid) ?? 0) + 1);
        }
      } else {
        toolCounts.set(tid, (toolCounts.get(tid) ?? 0) + 1);
      }
      // Also capture file edits emitted via native ACP tool calls (not just MCP artifacts)
      const toolName = String(payload.name ?? payload.title ?? "").toLowerCase();
      if (/(^|\b|_)(edit|write|patch|create_file|replace|str_replace|apply_patch)(\b|_|$)/.test(toolName)) {
        const input = payload.input && typeof payload.input === "object" ? (payload.input as Record<string, unknown>) : null;
        const candidatePaths: string[] = [];
        for (const key of ["path", "file_path", "filePath", "target_file", "filename"]) {
          const val = input?.[key];
          if (typeof val === "string" && val.trim()) candidatePaths.push(val.trim());
        }
        if (Array.isArray(payload.locations)) {
          for (const loc of payload.locations) {
            if (loc && typeof loc === "object" && typeof (loc as { path?: unknown }).path === "string") {
              candidatePaths.push((loc as { path: string }).path);
            }
          }
        }
        for (const p of candidatePaths) {
          allEditedPaths.add(p);
          let set = editPathsByTask.get(tid);
          if (!set) {
            set = new Set();
            editPathsByTask.set(tid, set);
          }
          set.add(p);
        }
      }
      if (!latestActionByTask.has(tid)) {
        const label = cleanToolLabel(String(payload.title ?? payload.name ?? "tool"));
        const st = String(payload.status ?? "in_progress");
        const prefix = st === "failed" ? "✗" : st === "completed" ? "✓" : "⚙";
        latestActionByTask.set(tid, `${prefix} ${label}`.slice(0, 72));
      }
    } else if (!latestActionByTask.has(tid)) {
      if (row.type === "agent.timer_sleep") {
        const wakeAt = typeof payload.wakeAt === "number" ? new Date(payload.wakeAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
        const reason = typeof payload.reason === "string" && payload.reason ? ` — ${payload.reason}` : "";
        latestActionByTask.set(tid, `⏰ sleeping${wakeAt ? ` until ${wakeAt}` : ""}${reason}`.slice(0, 72));
      } else if (row.type === "quota.agent_retrying") {
        latestActionByTask.set(tid, "⏳ retrying rate limit…");
      } else if (row.type === "quota.agent_paused") {
        latestActionByTask.set(tid, "⏸ paused (quota)");
      } else if (row.type === "agent.rollover") {
        latestActionByTask.set(tid, `↻ rolled over to gen ${String(payload.toGen ?? "?")}`);
      }
    }
  }

  const modelsSet = new Set<string>();
  let running = 0;
  let completed = 0;
  let failed = 0;
  let verifyRunning = 0;
  let verifyCompleted = 0;

  const taskSnapshots: TaskActivitySnapshot[] = allTasks.map((t) => {
    if (t.model) modelsSet.add(t.model);
    else if (t.profileId) modelsSet.add(t.profileId);

    const isLive = LIVE_STATUSES.has(t.status);
    const isTerminal = TERMINAL_STATUSES.has(t.status);
    if (isLive) running++;
    if (t.status === "completed") completed++;
    if (t.status === "failed") failed++;
    if (t.kind === "verify") {
      if (isLive || t.status === "ready" || t.status === "pending") verifyRunning++;
      else if (t.status === "completed") verifyCompleted++;
    }

    const fallbackAction =
      t.status === "waiting_children"
        ? "⏳ waiting on child agents"
        : t.status === "merging"
          ? "⇄ merging worktree"
          : t.status === "paused_quota"
            ? "⏸ paused (quota)"
            : t.status === "draining"
              ? "↻ rolling over"
              : null;

    const currentAction =
      isLive || t.status === "paused_quota"
        ? latestActionByTask.get(t.id) ?? fallbackAction
        : t.status === "failed"
          ? latestActionByTask.get(t.id) ?? (t.summary ? `✗ ${t.summary.slice(0, 64)}` : "✗ failed")
          : null;

    return {
      id: t.id,
      parentId: t.parentId,
      tier: t.tier,
      kind: t.kind,
      title: t.title,
      status: t.status,
      model: t.model,
      effort: t.effort,
      profileId: t.profileId,
      generation: t.generation,
      currentAction,
      toolCalls: toolCounts.get(t.id) ?? 0,
      filesEdited: editPathsByTask.get(t.id)?.size ?? 0,
      elapsedMs: Math.max(0, (isTerminal ? t.updatedAt : now) - t.createdAt),
      ctxPct: t.contextSize > 0 ? Math.round((t.contextUsed / t.contextSize) * 100) : null,
    };
  });

  // Automatically infer the current run phase from live tasks (zero LLM calls!)
  let phase: RunActivityPhase = "idle";
  const activeTasks = allTasks.filter((t) => LIVE_STATUSES.has(t.status));
  if (activeTasks.some((t) => t.status === "merging")) {
    phase = "merging";
  } else if (activeTasks.some((t) => t.kind === "verify")) {
    phase = "verifying";
  } else if (activeTasks.some((t) => t.kind === "worker" || t.kind === "execute")) {
    phase = "implementing";
  } else if (activeTasks.some((t) => t.kind === "research")) {
    phase = "researching";
  } else if (activeTasks.some((t) => t.kind === "plan" || t.kind === "orchestrator")) {
    phase = "planning";
  } else if (allTasks.some((t) => t.status === "paused_quota") || run?.status === "paused_quota") {
    phase = "paused_quota";
  } else if (run?.status === "completed") {
    phase = "completed";
  } else if (run?.status === "failed") {
    phase = "failed";
  } else if (run?.status === "stopped") {
    phase = "stopped";
  }

  const runTerminal = run ? ["completed", "failed", "stopped"].includes(run.status) && running === 0 : running === 0;
  const elapsedMs = run ? Math.max(0, (runTerminal ? run.updatedAt : now) - run.createdAt) : 0;

  return {
    runId,
    phase,
    elapsedMs,
    filesEdited: allEditedPaths.size,
    openEscalations: escalations.length,
    modelsUsed: [...modelsSet],
    counts: {
      total: allTasks.length,
      running,
      completed,
      failed,
      verifyRunning,
      verifyCompleted,
    },
    tasks: taskSnapshots,
  };
}
