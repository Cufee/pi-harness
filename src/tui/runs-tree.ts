import { decodeKittyPrintable, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { RunQuotaPauseStatus } from "../control-plane/orchestrator.js";
import type { EscalationRecord, RunRecord, TaskRecord } from "../control-plane/db.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import { formatResetCountdown } from "./overlays.js";
import { badge, fillLineBg, fitWidth, parseMouseWheel, type HarnessTheme, type SemanticTone } from "./primitives/index.js";

/** One entry of the `runs.trees` RPC result (contract.runs-watch-commands.v1). */
export interface RunsTreeEntry {
  run: RunRecord;
  /** ALL tasks of the run, any status, flat (hierarchy via parentId + tier). */
  tasks: TaskRecord[];
  /** Open escalations. */
  escalations: EscalationRecord[];
  quotaPause: RunQuotaPauseStatus | null;
}

export interface RunsTreesResult {
  generatedAt: number;
  runs: RunsTreeEntry[];
}

/** Live frame from a `watch.start` subscription; `watchId` is the optional extra field. */
export type WatchEventFrame = DaemonEventFrame & { watchId?: string };

export type RunsFilter = "running_recent" | "running" | "failed" | "all";

export const RUNS_FILTERS: readonly RunsFilter[] = ["running_recent", "running", "failed", "all"];

const FILTER_LABELS: Record<RunsFilter, string> = {
  running_recent: "Running+Recent",
  running: "Running",
  failed: "Failed",
  all: "All",
};

export const DEFAULT_RECENT_MS = 24 * 60 * 60 * 1000;

export interface RunsTreeRow {
  kind: "run" | "task";
  /** Stable selection key: run id for run rows, `runId/taskId` for task rows. */
  key: string;
  runId: string;
  entry: RunsTreeEntry;
  task?: TaskRecord;
  /** Tree depth: 0 for runs, 1 for top-level tasks, … */
  depth: number;
  /** Connector prefix (`│  ├─ ` …), empty for run rows. */
  connector: string;
  /** Open escalations raised by this task (task rows) or the whole run (run rows). */
  openEscalations: number;
  /** Run rows only. */
  collapsed?: boolean;
}

const ACTIVE_TASK_STATUSES = new Set<TaskRecord["status"]>([
  "running",
  "draining",
  "waiting_children",
  "merging",
  "blocked",
  "paused_quota",
]);

const LIVE_TASK_STATUSES = new Set<TaskRecord["status"]>(["running", "draining", "waiting_children", "merging"]);
const IN_FLIGHT_TASK_STATUSES = new Set<TaskRecord["status"]>([
  "pending",
  "ready",
  "running",
  "draining",
  "waiting_children",
  "merging",
]);

/** Dynamically derives a run's displayed status from live task states so it never contradicts active tasks. */
export function effectiveRunStatus(entry: RunsTreeEntry): RunRecord["status"] {
  const { run, tasks } = entry;
  if (tasks.some((t) => LIVE_TASK_STATUSES.has(t.status))) return "active";
  if (tasks.length === 0) return run.status;
  if (tasks.some((t) => t.status === "paused_quota")) return run.status === "stopped" ? "stopped" : "paused_quota";
  if (run.status === "stopped") return "stopped";
  if (tasks.some((t) => IN_FLIGHT_TASK_STATUSES.has(t.status))) return run.status;

  // All tasks are terminal — never keep displaying ACTIVE!
  const realOrch = tasks.find((t) => t.tier === 1 && t.profileId !== "director");
  if (realOrch) {
    if (realOrch.status === "failed") return "failed";
    if (realOrch.status === "cancelled") return "stopped";
    if (realOrch.status === "completed") return "completed";
  }
  const realTasks = tasks.filter((t) => t.profileId !== "director");
  if (realTasks.length === 0) return run.status === "active" ? "completed" : run.status;
  if (realTasks.some((t) => t.status === "failed")) return "failed";
  if (realTasks.every((t) => t.status === "cancelled")) return "stopped";
  return "completed";
}

function isActiveRun(entry: RunsTreeEntry): boolean {
  const st = effectiveRunStatus(entry);
  return st === "active" || st === "paused_quota";
}

function isFailedRun(entry: RunsTreeEntry): boolean {
  return effectiveRunStatus(entry) === "failed";
}

function taskKey(runId: string, taskId: string): string {
  return `${runId}/${taskId}`;
}

function openEscalationsByTask(entry: RunsTreeEntry): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of entry.escalations) {
    if (e.status !== "open") continue;
    m.set(e.fromTaskId, (m.get(e.fromTaskId) ?? 0) + 1);
  }
  return m;
}

/**
 * Pure tree builder: applies filter + search, then emits a Run → T1 → T2 → T3 DFS ordering
 * (children by parentId; tasks whose parent is missing attach to the run) with tree connectors.
 * `matched` counts runs shown, `hidden` counts runs filtered out.
 */
export function buildRunsTreeRows(
  trees: RunsTreesResult | RunsTreeEntry[],
  opts: { filter: RunsFilter; query: string; collapsed: Set<string>; now: number; recentMs?: number },
): { rows: RunsTreeRow[]; matched: number; hidden: number } {
  const entries = Array.isArray(trees) ? trees : trees.runs;
  const recentCutoff = opts.now - (opts.recentMs ?? DEFAULT_RECENT_MS);
  const q = opts.query.trim().toLowerCase();
  const rows: RunsTreeRow[] = [];
  let matched = 0;

  for (const entry of entries) {
    const { run } = entry;
    const escByTask = openEscalationsByTask(entry);

    const taskPasses = (t: TaskRecord): boolean => {
      switch (opts.filter) {
        case "all":
          return true;
        case "running":
          return ACTIVE_TASK_STATUSES.has(t.status);
        case "running_recent":
          return ACTIVE_TASK_STATUSES.has(t.status) || t.updatedAt >= recentCutoff;
        case "failed":
          return t.status === "failed" || t.status === "returned_for_rescope" || (escByTask.get(t.id) ?? 0) > 0;
      }
    };
    const runPasses = (): boolean => {
      switch (opts.filter) {
        case "all":
          return true;
        case "running":
          return isActiveRun(entry);
        case "running_recent":
          return isActiveRun(entry) || run.updatedAt >= recentCutoff;
        case "failed":
          return isFailedRun(entry) || entry.escalations.some((e) => e.status === "open");
      }
    };

    const filterTasks = entry.tasks.filter(taskPasses);
    if (!runPasses() && filterTasks.length === 0) continue;

    // Search: a run-level match keeps all filter-passing tasks; otherwise only matching tasks.
    let shownTasks = filterTasks;
    if (q) {
      const runMatch = [run.goal, run.id, effectiveRunStatus(entry)].some((s) => s.toLowerCase().includes(q));
      if (!runMatch) {
        shownTasks = filterTasks.filter((t) =>
          [t.id, t.title, t.status, t.model ?? "", t.profileId].some((s) => s.toLowerCase().includes(q)),
        );
        if (shownTasks.length === 0) continue;
      }
    }

    // Keep ancestors so the hierarchy stays intact.
    const byId = new Map(entry.tasks.map((t) => [t.id, t]));
    const visible = new Set<string>();
    for (const t of shownTasks) {
      let cur: TaskRecord | undefined = t;
      while (cur && !visible.has(cur.id)) {
        visible.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
    }

    matched++;
    const collapsed = opts.collapsed.has(run.id);
    rows.push({
      kind: "run",
      key: run.id,
      runId: run.id,
      entry,
      depth: 0,
      connector: "",
      openEscalations: entry.escalations.filter((e) => e.status === "open").length,
      collapsed,
    });
    if (collapsed) continue;

    const children = new Map<string | null, TaskRecord[]>();
    for (const t of entry.tasks) {
      if (!visible.has(t.id)) continue;
      const parent = t.parentId && visible.has(t.parentId) ? t.parentId : null;
      const list = children.get(parent) ?? [];
      list.push(t);
      children.set(parent, list);
    }
    for (const list of children.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    const seen = new Set<string>();
    const visit = (parentId: string | null, depth: number, lead: string) => {
      const list = children.get(parentId) ?? [];
      list.forEach((t, i) => {
        if (seen.has(t.id)) return;
        seen.add(t.id);
        const last = i === list.length - 1;
        rows.push({
          kind: "task",
          key: taskKey(run.id, t.id),
          runId: run.id,
          entry,
          task: t,
          depth,
          connector: `${lead}${last ? "└─ " : "├─ "}`,
          openEscalations: escByTask.get(t.id) ?? 0,
        });
        visit(t.id, depth + 1, `${lead}${last ? "   " : "│  "}`);
      });
    };
    visit(null, 1, "");
  }

  return { rows, matched, hidden: entries.length - matched };
}

function taskTone(status: TaskRecord["status"]): SemanticTone {
  if (status === "completed") return "success";
  if (status === "failed" || status === "cancelled") return "error";
  if (status === "paused_quota" || status === "blocked" || status === "returned_for_rescope") return "warning";
  if (ACTIVE_TASK_STATUSES.has(status)) return "accent";
  return "neutral";
}

function runTone(status: RunRecord["status"]): SemanticTone {
  if (status === "completed") return "success";
  if (status === "failed" || status === "stopped") return "error";
  if (status === "paused_quota") return "warning";
  if (status === "active") return "accent";
  return "neutral";
}

export function tierLabel(task: TaskRecord): string {
  return task.kind === "verify" ? "Reviewer" : `T${task.tier}`;
}

function statusLabel(status: string): string {
  return status === "paused_quota" ? "PAUSED QUOTA" : status.replace(/_/g, " ").toUpperCase();
}

function firstLine(s: string): string {
  return s.split("\n")[0] ?? s;
}

export interface RunsTreeOverlayOptions {
  theme: HarnessTheme;
  fetchTrees: () => Promise<RunsTreesResult>;
  /** Starts a `scope: 'runs'` watch and returns its stop function. */
  subscribe: (onEvent: (ev: WatchEventFrame) => void) => Promise<() => void>;
  onOpenTranscript: (row: { runId: string; taskId: string; title: string }) => void;
  onAction: (action: "resume" | "wait" | "stop", runId: string) => void;
  onClose: () => void;
  requestRender: () => void;
  /** Visible tree rows (defaults to the terminal height minus chrome). */
  viewportRows?: number;
  recentMs?: number;
  now?: () => number;
  /** Debounce for event-driven refetches (default 150ms). */
  refetchDebounceMs?: number;
}

/**
 * `/runs` overlay: unified, filterable Run → T1 → T2 → T3 tree with live updates.
 * State (selection, filter, query, collapsed) survives transcript popups opened on top of it.
 */
export class RunsTreeOverlay implements Component {
  private trees: RunsTreesResult | null = null;
  private loadError: string | null = null;
  private watchError: string | null = null;
  private lastIndex = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private filter: RunsFilter = "running_recent";
  private query = "";
  private searching = false;
  private collapsed = new Set<string>();
  private selectedKey: string | null = null;
  private scrollTop = 0;
  private stopWatch: (() => void) | null = null;
  private refetchTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private fetchSeq = 0;

  constructor(private readonly opts: RunsTreeOverlayOptions) {
    void this.refetch();
    void this.opts
      .subscribe((ev) => this.onEvent(ev))
      .then((stop) => {
        if (this.disposed) stop();
        else this.stopWatch = stop;
      })
      .catch((err) => {
        this.watchError = `Live updates unavailable: ${err instanceof Error ? err.message : String(err)}`;
        this.opts.requestRender();
      });
  }

  /** Current filter / search / selection state (for tests and integration). */
  get state(): { filter: RunsFilter; query: string; searching: boolean; selectedKey: string | null; collapsed: string[] } {
    return {
      filter: this.filter,
      query: this.query,
      searching: this.searching,
      selectedKey: this.selectedKey,
      collapsed: [...this.collapsed],
    };
  }

  async refetch(): Promise<void> {
    const seq = ++this.fetchSeq;
    try {
      const trees = await this.opts.fetchTrees();
      if (this.disposed || seq !== this.fetchSeq) return;
      this.trees = trees;
      this.loadError = null;
      this.syncTicker();
    } catch (err) {
      if (this.disposed || seq !== this.fetchSeq) return;
      this.loadError = err instanceof Error ? err.message : String(err);
    }
    this.opts.requestRender();
  }

  /** Keeps quota countdowns ticking while any run is quota-paused. */
  private syncTicker(): void {
    const paused = this.trees?.runs.some((e) => e.quotaPause) ?? false;
    if (paused && !this.ticker) this.ticker = setInterval(() => this.opts.requestRender(), 1000);
    else if (!paused && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private onEvent(_ev: WatchEventFrame): void {
    if (this.disposed) return;
    if (this.refetchTimer) clearTimeout(this.refetchTimer);
    this.refetchTimer = setTimeout(() => {
      this.refetchTimer = null;
      void this.refetch();
    }, this.opts.refetchDebounceMs ?? 150);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.refetchTimer) clearTimeout(this.refetchTimer);
    this.refetchTimer = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    const stop = this.stopWatch;
    this.stopWatch = null;
    stop?.();
  }

  private build(): { rows: RunsTreeRow[]; matched: number; hidden: number } {
    if (!this.trees) return { rows: [], matched: 0, hidden: 0 };
    return buildRunsTreeRows(this.trees, {
      filter: this.filter,
      query: this.query,
      collapsed: this.collapsed,
      now: this.opts.now?.() ?? Date.now(),
      recentMs: this.opts.recentMs,
    });
  }

  /** Resolves the selection by id; falls back to the nearest surviving row (or the first). */
  private selectedIndex(rows: RunsTreeRow[]): number {
    if (rows.length === 0) return -1;
    let idx = this.selectedKey ? rows.findIndex((r) => r.key === this.selectedKey) : -1;
    if (idx === -1 && this.selectedKey) {
      const runId = this.selectedKey.split("/")[0];
      idx = rows.findIndex((r) => r.kind === "run" && r.runId === runId);
    }
    if (idx === -1) idx = Math.min(this.lastIndex, rows.length - 1);
    this.lastIndex = idx;
    return idx;
  }

  private select(rows: RunsTreeRow[], i: number): void {
    this.lastIndex = Math.max(0, Math.min(rows.length - 1, i));
    this.selectedKey = rows[this.lastIndex]!.key;
  }

  private viewportRows(): number {
    return this.opts.viewportRows ?? Math.max(6, (process.stdout.rows ?? 30) - 12);
  }

  handleInput(data: string): void {
    const mouse = parseMouseWheel(data, 1);
    if (mouse.isMouse) {
      if (mouse.deltaLines !== 0) {
        const { rows } = this.build();
        if (rows.length > 0) {
          const idx = this.selectedIndex(rows);
          this.select(rows, idx + mouse.deltaLines);
          this.opts.requestRender();
        }
      }
      return;
    }
    if (this.searching) {
      this.handleSearchInput(data);
      return;
    }
    const { rows } = this.build();
    const idx = this.selectedIndex(rows);
    const row = idx >= 0 ? rows[idx] : undefined;

    if (matchesKey(data, "escape")) {
      if (this.query) {
        this.query = "";
        this.opts.requestRender();
      } else {
        this.dispose();
        this.opts.onClose();
      }
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      if (rows.length) this.select(rows, idx - 1);
    } else if (matchesKey(data, "down") || data === "j") {
      if (rows.length) this.select(rows, idx + 1);
    } else if (matchesKey(data, "tab") || data === "f") {
      this.filter = RUNS_FILTERS[(RUNS_FILTERS.indexOf(this.filter) + 1) % RUNS_FILTERS.length]!;
    } else if (data.length === 1 && data >= "1" && data <= "4") {
      this.filter = RUNS_FILTERS[Number(data) - 1]!;
    } else if (data === "/") {
      this.searching = true;
    } else if (matchesKey(data, "space") || matchesKey(data, "left") || matchesKey(data, "right")) {
      if (!row) return;
      const runId = row.runId;
      const collapse = matchesKey(data, "left") ? true : matchesKey(data, "right") ? false : !this.collapsed.has(runId);
      if (collapse) {
        this.collapsed.add(runId);
        this.selectedKey = runId;
      } else {
        this.collapsed.delete(runId);
      }
    } else if (matchesKey(data, "enter")) {
      if (!row) return;
      if (row.kind === "task" && row.task) {
        this.opts.onOpenTranscript({ runId: row.runId, taskId: row.task.id, title: row.task.title });
        return;
      }
      if (this.collapsed.has(row.runId)) this.collapsed.delete(row.runId);
      else this.collapsed.add(row.runId);
    } else if (data === "r" || data === "w" || data === "x") {
      if (!row) return;
      this.opts.onAction(data === "r" ? "resume" : data === "w" ? "wait" : "stop", row.runId);
      return;
    } else {
      return;
    }
    this.opts.requestRender();
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.query = "";
      this.searching = false;
    } else if (matchesKey(data, "enter") || matchesKey(data, "down") || matchesKey(data, "tab")) {
      this.searching = false;
    } else if (matchesKey(data, "backspace")) {
      this.query = this.query.slice(0, -1);
    } else {
      const ch = decodeKittyPrintable(data) ?? data;
      // Accept printable text (incl. pastes); ignore control / escape sequences.
      if (!ch || /[\x00-\x1f\x7f]/.test(ch)) return;
      this.query += ch;
    }
    this.opts.requestRender();
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    const t = this.opts.theme;
    const lines: string[] = [];
    const tabs = RUNS_FILTERS.map((f, i) => {
      const label = `${i + 1} ${FILTER_LABELS[f]}`;
      return f === this.filter ? t.accentBold(`[${label}]`) : t.muted(` ${label} `);
    }).join(" ");
    lines.push(fitWidth(tabs, width));

    const { rows, matched, hidden } = this.build();
    const counts = t.dim(`${matched} matched · ${hidden} hidden`);
    const search = this.searching
      ? `${t.accentBold("/")} ${this.query}${t.accent("▏")}`
      : this.query
        ? `${t.accentBold("/")} ${this.query} ${t.dim("(Esc clears)")}`
        : t.dim("/ search");
    lines.push(fitWidth(`${search}  ${counts}`, width));
    lines.push(t.border("─".repeat(Math.max(0, width))));

    if (!this.trees) {
      lines.push(fitWidth(this.loadError ? t.error(`Failed to load runs: ${this.loadError}`) : t.muted("Loading runs…"), width));
      return lines;
    }
    if (this.loadError) lines.push(fitWidth(t.warning(`Refresh failed: ${this.loadError}`), width));
    if (this.watchError) lines.push(fitWidth(t.warning(this.watchError), width));
    if (rows.length === 0) {
      lines.push(
        fitWidth(
          t.muted(
            this.trees.runs.length === 0
              ? "No autonomous runs yet. Launch a Goal in Director Chat or via `pi-harness run`."
              : "No runs match this filter. Press 4 for All or Esc to clear search.",
          ),
          width,
        ),
      );
      return lines;
    }

    const idx = this.selectedIndex(rows);
    if (idx >= 0) this.selectedKey = rows[idx]!.key;
    const vp = this.viewportRows();
    if (idx < this.scrollTop) this.scrollTop = idx;
    if (idx >= this.scrollTop + vp) this.scrollTop = idx - vp + 1;
    this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, rows.length - vp)));

    for (let i = this.scrollTop; i < Math.min(rows.length, this.scrollTop + vp); i++) {
      const row = rows[i]!;
      const active = i === idx;
      const text = this.renderRow(row, active);
      lines.push(active ? fillLineBg(text, width, t.badgeBg) : fitWidth(text, width));
    }
    if (rows.length > vp) {
      lines.push(fitWidth(t.dim(`  ${idx + 1}/${rows.length} rows`), width));
    }
    lines.push(
      fitWidth(
        t.dim("↑↓ move · Space/←→ fold · Enter transcript · Tab/f/1-4 filter · / search · r resume · w wait · x stop · Esc close"),
        width,
      ),
    );
    return lines;
  }

  private renderRow(row: RunsTreeRow, active: boolean): string {
    const t = this.opts.theme;
    const marker = active ? t.accentBold("▸ ") : "  ";
    const id = (s: string) => (active ? t.accentBold(s) : t.bold(s));
    const esc = row.openEscalations > 0 ? ` ${badge(`⚑${row.openEscalations}`, "warning", t)}` : "";
    const qp = row.entry.quotaPause;

    if (row.kind === "run") {
      const run = row.entry.run;
      const effStatus = effectiveRunStatus(row.entry);
      const fold = row.collapsed ? "▸" : "▾";
      const n = row.entry.tasks.length;
      const quota = qp
        ? ` ${badge(`⏸ ${qp.resumeAt ? `resume ${formatResetCountdown(qp.resumeAt)}` : "quota paused"}`, "warning", t)}`
        : "";
      return `${marker}${t.muted(fold)} ${badge("RUN", "info", t)} ${badge(statusLabel(effStatus), runTone(effStatus), t)} ${id(run.id)} ${firstLine(run.goal)} ${t.dim(`(${n} agent${n === 1 ? "" : "s"})`)}${esc}${quota}`;
    }

    const task = row.task!;
    const tier = tierLabel(task);
    const tierBadge = badge(tier, task.kind === "verify" ? "info" : "accent", t);
    const ctx = task.contextSize > 0 ? ` ${Math.round((task.contextUsed / task.contextSize) * 100)}%` : "";
    const model = task.model ? `${task.model} · ${task.profileId}` : task.profileId;
    const quota =
      task.status === "paused_quota" && qp?.resumeAt ? ` ${t.warning(`⏱ ${formatResetCountdown(qp.resumeAt)}`)}` : "";
    return `${marker}${t.dim(row.connector)}${tierBadge} ${badge(statusLabel(task.status), taskTone(task.status), t)} ${id(task.id)} ${task.title} ${t.dim(`(${model}${ctx})`)}${esc}${quota}`;
  }
}
