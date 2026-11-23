import { matchesKey } from "@earendil-works/pi-tui";
import type {
  ArtifactRecord,
  EscalationRecord,
  EventRecord,
  MergeQueueRecord,
  MessageRecord,
  ReplayPage,
  RunRecord,
  TaskRecord,
  WorktreeRecord,
} from "../control-plane/db.js";
import type { TimerRecord } from "../control-plane/timers.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { GoalRecord, GoalReviewVerdict, GoalRevisionRecord } from "../goals/engine.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import {
  clamp,
  type ColumnSpec,
  divider,
  type TuiEntityRef as EntityRef,
  firstLine,
  formatAge,
  formatBytes,
  formatClock,
  formatCountdown,
  formatDuration,
  formatToolLabel,
  Frame,
  handleTabKeys,
  type Hint,
  isPopKey,
  kvRow,
  middleEllipsis,
  type Navigator,
  parseDurationMs,
  parseMouseWheel,
  sanitizeLine,
  sanitizeText,
  type Screen,
  type ScreenContext,
  statusBadge,
  TableListView,
  tag,
  type Theme,
  Viewport,
  wrap,
  yankText,
} from "./core/index.js";
import { QuotaWaitPickerScreen } from "./quota-wait-picker.js";
import { consumeReplay } from "./replay.js";
import type { WorkStore } from "./store.js";

export interface InspectorDeps {
  client: DaemonClient;
  store: WorkStore;
  repoRoot: string;
  onAttachRun?: (runId: string, taskId?: string | null) => void;
  onToast?: (msg: string) => void;
}

/**
 * Single entry point to inspect ANY entity surfaced anywhere in the harness.
 * Pushes a drill-down `Screen` onto the `Navigator` breadcrumb stack.
 */
export function openEntityInspector(ref: EntityRef, deps: InspectorDeps, ctx: ScreenContext): void {
  switch (ref.kind) {
    case "escalation":
      ctx.navigator.push(new EscalationInspectorScreen(ref.id, deps));
      return;
    case "goal":
      ctx.navigator.push(new GoalInspectorScreen(ref.id, deps));
      return;
    case "run":
      ctx.navigator.push(new RunInspectorScreen(ref.id, deps));
      return;
    case "task":
      ctx.navigator.push(new TaskInspectorScreen(ref.id, deps));
      return;
    case "artifact":
      ctx.navigator.push(new ArtifactInspectorScreen(ref.runId ?? "", ref.id, deps));
      return;
    case "timer":
      ctx.navigator.push(new TimerInspectorScreen(ref.id, deps));
      return;
    case "worktree":
      ctx.navigator.push(new WorktreeInspectorScreen(ref.id, deps));
      return;
    case "merge":
      ctx.navigator.push(new MergeInspectorScreen(ref.id, deps));
      return;
    case "transcript":
      ctx.navigator.push(
        new LiveTranscriptScreen(ref.runId ?? ref.id, ref.id !== ref.runId ? ref.id : undefined, deps),
      );
      return;
    default:
      ctx.navigator.push(new GenericDetailScreen(ref));
      return;
  }
}

function handleViewportScrollKeys(
  data: string,
  viewport: Viewport,
  opts?: { allowG?: boolean },
): boolean {
  const wheel = parseMouseWheel(data);
  if (wheel.hadMouse) {
    if (wheel.delta !== 0) viewport.scrollBy(wheel.delta);
    return true;
  }
  if (matchesKey(data, "up") || data === "k") {
    viewport.scrollBy(-1);
    return true;
  }
  if (matchesKey(data, "down") || data === "j") {
    viewport.scrollBy(1);
    return true;
  }
  if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
    viewport.pageUp();
    return true;
  }
  if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
    viewport.pageDown();
    return true;
  }
  if (matchesKey(data, "home") || (opts?.allowG !== false && data === "g")) {
    viewport.scrollToTop();
    return true;
  }
  if (matchesKey(data, "end") || (opts?.allowG !== false && data === "G")) {
    viewport.scrollToBottom();
    return true;
  }
  return false;
}

/* ─────────────────────────── Escalation Inspector ─────────────────────────── */

interface EscalationDetailData {
  escalation: EscalationRecord;
  run: RunRecord | null;
  fromTask: TaskRecord | null;
  goal: GoalRecord | null;
}

export class EscalationInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();
  private data: EscalationDetailData | null = null;
  private loading = true;
  private error: string | null = null;

  constructor(
    private readonly escalationId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = escalationId;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    this.error = null;
    ctx.requestRender();
    try {
      this.data = await this.deps.client.request<EscalationDetailData>("escalation.get", {
        escalationId: this.escalationId,
      });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const esc = this.data?.escalation ?? this.deps.store.getEscalation(this.escalationId);
    const hints: Hint[] = [
      { key: "r", label: "resolve" },
      { key: "a", label: "ack" },
      { key: "t", label: "task" },
      ...(this.data?.goal ? [{ key: "g", label: "goal" }] : []),
      { key: "y", label: "copy" },
      { key: "Home/End", label: "top/bot" },
      { key: "Esc", label: "back" },
    ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [this.escalationId],
      rightHeader: esc ? statusBadge(esc.status, theme) : undefined,
      hints,
      renderBody: (innerW, bodyH) => {
        if (this.loading && !esc) return [theme.muted("Loading escalation...")];
        if (this.error && !esc) return [theme.danger(`Failed to load: ${this.error}`)];
        if (!esc) return [theme.muted("Escalation not found.")];

        const lines: string[] = [
          `${tag(esc.severity, esc.severity === "P0" ? "danger" : "warn", theme)} ${tag(esc.category, "info", theme)} ${esc.blocking ? tag("BLOCKING", "danger", theme) : ""}`,
          theme.bold(sanitizeLine(esc.title)),
          "",
          kvRow("Escalation ID", esc.id, innerW, theme),
          kvRow("Status", statusBadge(esc.status, theme), innerW, theme),
          kvRow("Run", esc.runId, innerW, theme),
          kvRow(
            "From Task",
            `${esc.fromTaskId}${this.data?.fromTask ? ` (${this.data.fromTask.status} · ${sanitizeLine(this.data.fromTask.title)})` : ""}`,
            innerW,
            theme,
          ),
          ...(this.data?.goal
            ? [kvRow("Goal", `${this.data.goal.id} v${this.data.goal.version}: ${sanitizeLine(this.data.goal.title)}`, innerW, theme)]
            : []),
          kvRow("Created", `${formatClock(esc.createdAt)} (${formatAge(esc.createdAt)})`, innerW, theme),
          ...(esc.resolution ? [kvRow("Resolution", theme.ok(sanitizeLine(esc.resolution)), innerW, theme)] : []),
          ...(esc.evidencePaths.length > 0
            ? ["", divider(innerW, theme, "Evidence Paths"), ...esc.evidencePaths.map((p) => clamp(`  - ${sanitizeLine(p)}`, innerW))]
            : []),
          ...(esc.attempted.length > 0
            ? ["", divider(innerW, theme, "Attempted"), ...esc.attempted.flatMap((a) => wrap(`  - ${sanitizeText(a)}`, innerW))]
            : []),
          ...(esc.suggestedSplits.length > 0
            ? ["", divider(innerW, theme, "Suggested Splits"), ...esc.suggestedSplits.flatMap((s) => wrap(`  - ${sanitizeText(s)}`, innerW))]
            : []),
        ];

        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }

    const esc = this.data?.escalation ?? this.deps.store.getEscalation(this.escalationId);

    // Bind `g` to open linked Goal BEFORE viewport scroll (Home/End handles top/bottom scroll)
    if (data === "g" && this.data?.goal) {
      ctx.navigator.push(new GoalInspectorScreen(this.data.goal.id, this.deps));
      return;
    }

    if (handleViewportScrollKeys(data, this.viewport, { allowG: false })) {
      ctx.requestRender();
      return;
    }

    if (!esc) return;

    if (data === "r") {
      this.frame.askPrompt({
        label: "Resolution note",
        initialValue: "Resolved by user",
        onSubmit: async (note) => {
          await this.deps.client.request("escalation.ack", {
            escalationId: esc.id,
            resolution: note,
            resolve: true,
          });
          this.frame.setNotice(`Resolved ${esc.id}`, "ok");
          await Promise.all([this.load(ctx), this.deps.store.refresh()]);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "a") {
      this.frame.askPrompt({
        label: "Acknowledge note (stays unresolved)",
        initialValue: "Acknowledged by user",
        onSubmit: async (note) => {
          await this.deps.client.request("escalation.ack", {
            escalationId: esc.id,
            resolution: note,
            resolve: false,
          });
          this.frame.setNotice(`Acknowledged ${esc.id}`, "info");
          await Promise.all([this.load(ctx), this.deps.store.refresh()]);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "t" && esc.fromTaskId) {
      ctx.navigator.push(new TaskInspectorScreen(esc.fromTaskId, this.deps));
      return;
    }

    if (data === "y") {
      const text = [
        `${esc.id} [${esc.severity}/${esc.category}] ${esc.title}`,
        `Run: ${esc.runId} · Task: ${esc.fromTaskId} · Status: ${esc.status}`,
        ...(esc.evidencePaths.length > 0 ? [`Evidence: ${esc.evidencePaths.join(", ")}`] : []),
        ...(esc.attempted.length > 0 ? [`Attempted:\n- ${esc.attempted.join("\n- ")}`] : []),
        ...(esc.suggestedSplits.length > 0 ? [`Suggested Splits:\n- ${esc.suggestedSplits.join("\n- ")}`] : []),
        ...(esc.resolution ? [`Resolution: ${esc.resolution}`] : []),
      ].join("\n");
      const ok = yankText(text, ctx.writeTerminal);
      this.frame.setNotice(ok ? "Copied escalation to clipboard" : "Clipboard unavailable", ok ? "ok" : "warn");
      ctx.requestRender();
    }
  }
}

/* ───────────────────────────── Goal Inspector ─────────────────────────────── */

type GoalTabId = "overview" | "tasks" | "reviews" | "revisions";
const GOAL_TABS: readonly GoalTabId[] = ["overview", "tasks", "reviews", "revisions"];

const GOAL_SUB_COLUMNS: Record<Exclude<GoalTabId, "overview">, ColumnSpec[]> = {
  tasks: [
    { key: "status", header: "STATUS", width: 13, priority: 0 },
    { key: "id", header: "TASK", width: 12, priority: 0 },
    { key: "tier", header: "TIER", width: 12, priority: 2 },
    { key: "title", header: "TITLE", minWidth: 16, priority: 0 },
    { key: "age", header: "UPDATED", width: 8, align: "right", priority: 1 },
  ],
  reviews: [
    { key: "verdict", header: "VERDICT", width: 16, priority: 0 },
    { key: "cycle", header: "CYCLE", width: 8, priority: 0 },
    { key: "summary", header: "SUMMARY", minWidth: 18, priority: 0 },
    { key: "age", header: "AGE", width: 8, align: "right", priority: 1 },
  ],
  revisions: [
    { key: "ver", header: "VER", width: 6, priority: 0 },
    { key: "rationale", header: "RATIONALE / TITLE", minWidth: 20, priority: 0 },
    { key: "age", header: "AGE", width: 8, align: "right", priority: 1 },
  ],
};

/**
 * Notice for an idempotent resume/commit result: started or resumed (or a legacy reply with
 * `resumed: true`) is ok; already running/queued/completed is informational; an error is danger;
 * anything else, including an absent or empty reply, is a warning with its reason.
 */
function resumeNotice(
  res: { resumed?: boolean; reason?: string; outcome?: string; message?: string; error?: string } | null | undefined,
  okText: string,
  failText: string,
): [string, "ok" | "info" | "warn" | "danger"] {
  const outcome = res?.outcome;
  // "executing" is the goal status a legacy goal.commit reply reports as its outcome.
  if (outcome === "resumed" || outcome === "started" || outcome === "executing" || (outcome === undefined && res?.resumed === true)) {
    return [res?.message || okText, "ok"];
  }
  if (outcome && ["already_active", "already_queued", "queued", "waiting", "already_completed", "already_settled"].includes(outcome)) {
    return [res?.message || res?.reason || okText, "info"];
  }
  if (outcome === "error" || res?.error) return [res?.message || res?.error || res?.reason || failText, "danger"];
  return [res?.message || res?.reason || failText, "warn"];
}

function isGoalResumable(g: GoalRecord, linkedRunStatus?: string | null): boolean {
  if (g.status === "achieved" || g.status === "cancelled") return false;
  if (g.status === "draft" || g.status === "paused" || g.status === "awaiting_human") return true;
  return linkedRunStatus === "paused_quota" || linkedRunStatus === "stopped";
}

export class GoalInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();
  private activeTab: GoalTabId = "overview";
  private readonly subList = new TableListView<{ ref: EntityRef }>({ columns: GOAL_SUB_COLUMNS.tasks });
  private unsub: (() => void) | null = null;

  constructor(
    private readonly goalId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = goalId;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    this.unsub = this.deps.store.subscribe(() => {
      this.rebuildSubList();
      ctx.requestRender();
    });
    this.rebuildSubList();
    void this.deps.store.refresh();
  }

  onClose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private getEntry() {
    return this.deps.store.getGoalEntry(this.goalId);
  }

  private setTab(next: GoalTabId): void {
    this.activeTab = next;
    this.subList.clearFilter();
    this.rebuildSubList();
  }

  private rebuildSubList(): void {
    const entry = this.getEntry();
    if (!entry) return;
    const run = entry.goal.linkedRunId ? this.deps.store.getRunEntry(entry.goal.linkedRunId) : undefined;

    if (this.activeTab === "tasks") {
      this.subList.setColumns(GOAL_SUB_COLUMNS.tasks);
      const tasks = run?.tasks ?? [];
      this.subList.emptyText = "No tasks yet for this goal.";
      this.subList.setTableItems(
        tasks.map((t) => ({
          id: t.id,
          value: { ref: { kind: "task", id: t.id, runId: t.runId, goalId: this.goalId, label: `${t.id} ${t.title}` } },
          searchText: `${t.id} ${t.status} ${t.kind} ${t.title}`,
          cells: (sel, theme) => ({
            status: statusBadge(t.status, theme),
            id: sel ? theme.accentBold(t.id) : theme.bold(t.id),
            tier: tag(`T${t.tier}/${t.kind}`, "muted", theme),
            title: sanitizeLine(t.title),
            age: theme.dim(formatAge(t.updatedAt)),
          }),
        })),
      );
    } else if (this.activeTab === "reviews") {
      this.subList.setColumns(GOAL_SUB_COLUMNS.reviews);
      const reviews = entry.reviews ?? [];
      this.subList.emptyText = "No reviews recorded yet.";
      this.subList.setTableItems(
        reviews.map((rev: GoalReviewVerdict) => ({
          id: rev.id,
          value: {
            ref: {
              kind: "review",
              id: rev.id,
              goalId: this.goalId,
              label: `Review #${rev.cycle} (v${rev.goalVersion})`,
              payload: rev,
            },
          },
          searchText: `${rev.id} ${rev.verdict} ${rev.summary}`,
          cells: (sel, theme) => ({
            verdict: statusBadge(rev.verdict, theme),
            cycle: sel ? theme.accentBold(`#${rev.cycle} v${rev.goalVersion}`) : theme.bold(`#${rev.cycle} v${rev.goalVersion}`),
            summary: firstLine(rev.summary, 70),
            age: theme.dim(formatAge(rev.createdAt)),
          }),
        })),
      );
    } else if (this.activeTab === "revisions") {
      this.subList.setColumns(GOAL_SUB_COLUMNS.revisions);
      const revs = entry.revisions ?? [];
      this.subList.emptyText = "No revision history.";
      this.subList.setTableItems(
        revs.map((rev: GoalRevisionRecord) => ({
          id: `v${rev.version}`,
          value: {
            ref: {
              kind: "revision",
              id: `${this.goalId}@v${rev.version}`,
              goalId: this.goalId,
              label: `${this.goalId} v${rev.version}`,
              payload: rev,
            },
          },
          searchText: `v${rev.version} ${rev.rationale} ${rev.title}`,
          cells: (sel, theme) => ({
            ver: sel ? theme.accentBold(`v${rev.version}`) : theme.accent(`v${rev.version}`),
            rationale: sanitizeLine(rev.rationale || rev.title),
            age: theme.dim(formatAge(rev.createdAt)),
          }),
        })),
      );
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const entry = this.getEntry();
    const g = entry?.goal;
    const run = g?.linkedRunId ? this.deps.store.getRunEntry(g.linkedRunId) : undefined;
    const openEscs = run ? run.escalations.filter((e) => e.status === "open" || e.status === "acked") : [];
    const canResume = g ? isGoalResumable(g, run?.run.status) : false;

    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "tasks", label: "Tasks", count: run?.tasks.length ?? 0 },
      { id: "reviews", label: "Reviews", count: entry?.reviews.length ?? 0 },
      { id: "revisions", label: "Revisions", count: entry?.revisions.length ?? 0 },
    ];

    const hints: Hint[] = [
      { key: "←→/Tab/1-4", label: "tabs" },
      ...(g?.status === "draft" ? [{ key: "c", label: "commit" }] : []),
      { key: "v", label: "review" },
      { key: "m", label: "amend" },
      ...(canResume
        ? [{ key: "u", label: "resume" }]
        : g && g.status !== "achieved" && g.status !== "cancelled"
          ? [{ key: "p", label: "pause" }]
          : []),
      ...(run ? [{ key: "R", label: "run" }] : []),
      ...(openEscs.length > 0 ? [{ key: "e", label: `esc(${openEscs.length})` }] : []),
      ...(g && g.status !== "achieved" && g.status !== "cancelled" ? [{ key: "x", label: "cancel" }] : []),
      { key: "Esc", label: "back" },
    ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [this.goalId],
      rightHeader: g ? `${statusBadge(g.status, theme)} ${theme.muted(`v${g.version}`)}` : undefined,
      subtitle: g ? sanitizeLine(g.title) : undefined,
      tabs,
      activeTabId: this.activeTab,
      hints,
      renderBody: (innerW, bodyH) => {
        if (!g) return [theme.muted("Goal not found in current snapshot.")];
        if (this.activeTab !== "overview") {
          return this.subList.render(innerW, bodyH, theme);
        }

        const lines: string[] = [
          kvRow("Goal", `${g.id} (v${g.version})`, innerW, theme),
          kvRow("Status", statusBadge(g.status, theme), innerW, theme),
          kvRow("Linked Run", g.linkedRunId ?? theme.muted("(none)"), innerW, theme),
          kvRow("Verification", g.verificationMode ?? "auto", innerW, theme),
          kvRow("Review Cycles", String(g.reviewCycle), innerW, theme),
          ...(g.liveProgress?.summary ? [kvRow("Progress", sanitizeLine(g.liveProgress.summary), innerW, theme)] : []),
          kvRow("Updated", `${formatClock(g.updatedAt)} (${formatAge(g.updatedAt)})`, innerW, theme),
          ...(openEscs.length > 0
            ? [kvRow("Unresolved Esc", theme.danger(`${openEscs.length} — press 'e' to inspect`), innerW, theme)]
            : []),
          "",
          divider(innerW, theme, "Description"),
          ...wrap(sanitizeText(g.description || g.title), innerW),
        ];

        if (g.criteria.length > 0) {
          lines.push("", divider(innerW, theme, `Acceptance Criteria (${g.criteria.length})`));
          for (const c of g.criteria) {
            const req = c.required ? theme.accent("*") : theme.muted("·");
            const cmd = c.command ? theme.code(`  $ ${sanitizeLine(c.command)}`) : "";
            lines.push(...wrap(`${req} ${theme.bold(c.id)}: ${sanitizeLine(c.description)}${cmd}`, innerW));
          }
        }

        if (g.nonGoals.length > 0) {
          lines.push("", divider(innerW, theme, "Non-Goals"));
          for (const ng of g.nonGoals) lines.push(...wrap(`- ${sanitizeLine(ng)}`, innerW));
        }

        if (g.lastReviewSummary) {
          lines.push("", divider(innerW, theme, "Latest Review Summary"), ...wrap(sanitizeText(g.lastReviewSummary), innerW));
        }

        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    // Check subList.isFiltering BEFORE Esc/q/tab keys!
    if (this.activeTab !== "overview" && this.subList.isFiltering) {
      const res = this.subList.handleInput(data);
      if (res === "select") {
        const item = this.subList.selectedItem();
        if (item) openEntityInspector(item.value.ref, this.deps, ctx);
        return;
      }
      ctx.requestRender();
      return;
    }

    if (this.activeTab !== "overview" && matchesKey(data, "escape") && this.subList.handleEscape()) {
      ctx.requestRender();
      return;
    }

    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }

    if (handleTabKeys(data, GOAL_TABS, this.activeTab, (next) => this.setTab(next))) {
      ctx.requestRender();
      return;
    }

    if (this.activeTab !== "overview") {
      const res = this.subList.handleInput(data);
      if (res === "select") {
        const item = this.subList.selectedItem();
        if (item) openEntityInspector(item.value.ref, this.deps, ctx);
        return;
      }
      if (res === "handled") {
        ctx.requestRender();
        return;
      }
    } else if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
      return;
    }

    const entry = this.getEntry();
    const g = entry?.goal;
    if (!g) return;
    const run = g.linkedRunId ? this.deps.store.getRunEntry(g.linkedRunId) : undefined;

    if (data === "c" && g.status === "draft") {
      this.frame.askConfirm({
        message: `Commit ${g.id} and launch autonomous run?`,
        onConfirm: async () => {
          const res = await this.deps.client.request<{ outcome?: string; message?: string } | null>("goal.commit", { goalId: g.id });
          this.frame.setNotice(...resumeNotice(res, `Committed ${g.id}`, `Could not commit ${g.id}`));
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "v") {
      this.frame.askConfirm({
        message: `Trigger verification & Done-Review for ${g.id}?`,
        onConfirm: async () => {
          this.frame.setNotice(`Review triggered for ${g.id}...`, "info");
          ctx.requestRender();
          void this.deps.client.request("goal.review", { goalId: g.id }).then(
            () => {
              this.frame.setNotice(`Review completed for ${g.id}`, "ok");
              void this.deps.store.refresh();
            },
            (err) => {
              this.frame.setNotice(`Review failed: ${err instanceof Error ? err.message : String(err)}`, "danger");
              ctx.requestRender();
            },
          );
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "m") {
      this.frame.askPrompt({
        label: "Amendment rationale / instruction",
        onSubmit: async (rationale) => {
          await this.deps.client.request("goal.amend", { goalId: g.id, rationale });
          this.frame.setNotice(`Amended ${g.id}`, "ok");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "p" && g.status !== "achieved" && g.status !== "cancelled") {
      this.frame.askConfirm({
        message: `Pause ${g.id} and stop its active run?`,
        onConfirm: async () => {
          await this.deps.client.request("goal.pause", { goalId: g.id });
          this.frame.setNotice(`Paused ${g.id}`, "warn");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "u" && isGoalResumable(g, run?.run.status)) {
      this.frame.askPrompt({
        label: "Resume note (optional)",
        initialValue: "Resumed from TUI",
        allowEmpty: true,
        onSubmit: async (note) => {
          const res = await this.deps.client.request<{ resumed?: boolean; reason?: string; outcome?: string; message?: string }>("goal.resume", {
            goalId: g.id,
            ...(note ? { note } : {}),
          });
          this.frame.setNotice(...resumeNotice(res, `Resumed ${g.id}`, `Could not resume ${g.id}`));
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "x" && g.status !== "achieved" && g.status !== "cancelled") {
      this.frame.askConfirm({
        message: `Cancel ${g.id} permanently?`,
        onConfirm: async () => {
          await this.deps.client.request("goal.cancel", { goalId: g.id });
          this.frame.setNotice(`Cancelled ${g.id}`, "danger");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "R" && g.linkedRunId) {
      ctx.navigator.push(new RunInspectorScreen(g.linkedRunId, this.deps));
      return;
    }

    if (data === "e" && run) {
      const firstOpen =
        run.escalations.find((e) => e.status === "open") ??
        run.escalations.find((e) => e.status === "acked");
      if (firstOpen) ctx.navigator.push(new EscalationInspectorScreen(firstOpen.id, this.deps));
    }
  }
}

/* ────────────────────────────── Run Inspector ─────────────────────────────── */

const RUN_TASK_COLUMNS: ColumnSpec[] = [
  { key: "tree", header: "TASK TREE", minWidth: 24, priority: 0 },
  { key: "status", header: "STATUS", width: 13, priority: 0 },
  { key: "tier", header: "TIER", width: 11, priority: 2 },
  { key: "updated", header: "UPDATED", width: 8, align: "right", priority: 1 },
];

export class RunInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly taskList = new TableListView<TaskRecord>({
    columns: RUN_TASK_COLUMNS,
    emptyText: "No tasks in this run.",
  });
  private unsub: (() => void) | null = null;

  constructor(
    private readonly runId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = runId;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    this.unsub = this.deps.store.subscribe(() => {
      this.rebuild();
      ctx.requestRender();
    });
    this.rebuild();
    void this.deps.store.refresh();
  }

  onClose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private rebuild(): void {
    const entry = this.deps.store.getRunEntry(this.runId);
    if (!entry) return;
    const byParent = new Map<string, TaskRecord[]>();
    for (const t of entry.tasks) {
      const key = t.parentId ?? "__root__";
      const arr = byParent.get(key) ?? [];
      arr.push(t);
      byParent.set(key, arr);
    }

    // Build accurate tree connectors (`├─` branchMid vs `└─` branchEnd + `│ ` vertical continuations)
    const ordered: Array<{ task: TaskRecord; guides: boolean[]; isLast: boolean; depth: number }> = [];
    const visit = (parentId: string, guides: boolean[], depth: number) => {
      const children = byParent.get(parentId) ?? [];
      children.forEach((child, idx) => {
        const isLast = idx === children.length - 1;
        ordered.push({ task: child, guides: [...guides], isLast, depth });
        visit(child.id, depth === 0 ? guides : [...guides, !isLast], depth + 1);
      });
    };
    visit("__root__", [], 0);

    const seen = new Set(ordered.map((o) => o.task.id));
    for (const t of entry.tasks) {
      if (!seen.has(t.id)) ordered.push({ task: t, guides: [], isLast: true, depth: 0 });
    }

    this.taskList.setTableItems(
      ordered.map(({ task, guides, isLast, depth }) => ({
        id: task.id,
        value: task,
        searchText: `${task.id} ${task.status} ${task.kind} ${task.title} ${task.profileId ?? ""}`,
        cells: (sel, theme) => {
          const g = theme.glyphs;
          let prefix = "";
          if (depth > 0) {
            const cont = guides.map((hasMore) => (hasMore ? g.branchCont : "  ")).join("");
            const branch = isLast ? g.branchEnd : g.branchMid;
            prefix = `${theme.muted(`${cont}${branch}`)} `;
          }
          return {
            tree: `${prefix}${sel ? theme.accentBold(task.id) : theme.bold(task.id)} ${sanitizeLine(task.title)}`,
            status: statusBadge(task.status, theme),
            tier: tag(`T${task.tier}/${task.kind}`, "muted", theme),
            updated: theme.dim(formatAge(task.updatedAt)),
          };
        },
      })),
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const entry = this.deps.store.getRunEntry(this.runId);
    const run = entry?.run;
    const hints: Hint[] = [
      { key: "Enter", label: "task" },
      { key: "L", label: "live log" },
      { key: "w", label: "quota wait" },
      { key: "u", label: "resume" },
      { key: "s", label: "schedule" },
      { key: "p", label: "stop" },
      ...(this.deps.onAttachRun ? [{ key: "A", label: "attach" }] : []),
      { key: "Esc", label: "back" },
    ];

    const sub = run
      ? `branch ${run.baseBranch}${entry?.goalId ? ` · ${entry.goalId}` : ""}${entry?.quotaPause ? ` · quota paused (${formatCountdown(entry.quotaPause.resumeAt)})` : ""}`
      : undefined;

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [this.runId],
      rightHeader: run ? statusBadge(run.status, theme) : undefined,
      subtitle: sub,
      hints,
      renderBody: (innerW, bodyH) => {
        if (!entry || !run) return [theme.muted("Run not found.")];
        return this.taskList.render(innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    // Check taskList.isFiltering BEFORE Esc/q!
    if (this.taskList.isFiltering) {
      const res = this.taskList.handleInput(data);
      if (res === "select") {
        const sel = this.taskList.selectedItem();
        if (sel) ctx.navigator.push(new TaskInspectorScreen(sel.value.id, this.deps));
        return;
      }
      ctx.requestRender();
      return;
    }

    if (matchesKey(data, "escape") && this.taskList.handleEscape()) {
      ctx.requestRender();
      return;
    }

    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }

    const res = this.taskList.handleInput(data);
    if (res === "select") {
      const sel = this.taskList.selectedItem();
      if (sel) ctx.navigator.push(new TaskInspectorScreen(sel.value.id, this.deps));
      return;
    }
    if (res === "handled") {
      ctx.requestRender();
      return;
    }

    if (data === "L") {
      ctx.navigator.push(new LiveTranscriptScreen(this.runId, undefined, this.deps));
      return;
    }
    if (data === "A" && this.deps.onAttachRun) {
      ctx.navigator.closeAll();
      this.deps.onAttachRun(this.runId, this.taskList.selectedItem()?.value.id);
      return;
    }
    if (data === "w") {
      const entry = this.deps.store.getRunEntry(this.runId);
      ctx.navigator.push(
        new QuotaWaitPickerScreen(this.deps.client, {
          runId: this.runId,
          reason: entry?.quotaPause?.reason,
          resumeAt: entry?.quotaPause?.resumeAt,
          onDone: async (msg) => {
            this.frame.setNotice(msg, "ok");
            await this.deps.store.refresh();
          },
        }),
      );
      return;
    }
    if (data === "u") {
      this.frame.askPrompt({
        label: "Resume guidance (optional)",
        initialValue: "Continue",
        allowEmpty: true,
        onSubmit: async (message) => {
          const res = await this.deps.client.request<{ resumed?: boolean; reason?: string; outcome?: string; message?: string }>(
            "run.resume",
            { runId: this.runId, ...(message ? { message } : {}) },
          );
          this.frame.setNotice(...resumeNotice(res, `Resumed ${this.runId}`, `Could not resume ${this.runId}`));
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }
    if (data === "s") {
      this.frame.askPrompt({
        label: "Schedule resume in (e.g. 15m, 1h30m)",
        placeholder: "15m",
        onSubmit: async (raw) => {
          const delayMs = parseDurationMs(raw);
          if (!delayMs) {
            this.frame.setNotice(`Invalid duration: ${raw}`, "warn");
            ctx.requestRender();
            return;
          }
          await this.deps.client.request("run.schedule_resume", { runId: this.runId, delayMs });
          this.frame.setNotice(`Scheduled resume in ${formatDuration(delayMs)}`, "ok");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }
    if (data === "p") {
      this.frame.askConfirm({
        message: `Stop run ${this.runId}?`,
        onConfirm: async () => {
          await this.deps.client.request("run.stop", { runId: this.runId, reason: "Stopped from TUI" });
          this.frame.setNotice(`Stopped ${this.runId}`, "warn");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
    }
  }
}

/* ────────────────────────────── Task Inspector ────────────────────────────── */

interface TaskHandoffSummary {
  summary?: string | null;
  lastError?: string | null;
  openEscalations?: number;
  [k: string]: unknown;
}

interface TaskDetailData {
  task: TaskRecord;
  handoff?: TaskHandoffSummary | string | null;
  run: RunRecord | null;
  escalations: EscalationRecord[];
  artifacts: ArtifactRecord[];
  worktree: WorktreeRecord | null;
  merges: MergeQueueRecord[];
  messages: MessageRecord[];
  children: TaskRecord[];
  writeScopes: string[];
}

class ArtifactPickerScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Artifacts";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<ArtifactRecord>({
    columns: [
      { key: "kind", header: "KIND", width: 12, priority: 1 },
      { key: "path", header: "PATH", minWidth: 20, priority: 0 },
      { key: "summary", header: "SUMMARY", minWidth: 14, priority: 2 },
    ],
    emptyText: "No artifacts recorded.",
  });

  constructor(
    private readonly runId: string,
    private readonly artifacts: ArtifactRecord[],
    private readonly deps: InspectorDeps,
  ) {
    this.list.setTableItems(
      artifacts.map((a) => ({
        id: a.id || a.path,
        value: a,
        searchText: `${a.kind} ${a.path} ${a.summary ?? ""}`,
        cells: (sel, theme) => ({
          kind: tag(a.kind, "info", theme),
          path: sel ? theme.accentBold(middleEllipsis(a.path, 42)) : theme.bold(middleEllipsis(a.path, 42)),
          summary: theme.muted(firstLine(a.summary, 40) || "—"),
        }),
      })),
    );
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Artifacts"],
      subtitle: `${this.artifacts.length} artifact(s) in ${this.runId}`,
      hints: [
        { key: "Enter", label: "read" },
        { key: "/", label: "filter" },
        { key: "Esc", label: "back" },
      ],
      renderBody: (innerW, bodyH) => this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") {
        const sel = this.list.selectedItem()?.value;
        if (sel) ctx.navigator.push(new ArtifactInspectorScreen(this.runId, sel.path, this.deps));
        return;
      }
      ctx.requestRender();
      return;
    }
    if (matchesKey(data, "escape") && this.list.handleEscape()) {
      ctx.requestRender();
      return;
    }
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      const sel = this.list.selectedItem()?.value;
      if (sel) ctx.navigator.push(new ArtifactInspectorScreen(this.runId, sel.path, this.deps));
      return;
    }
    if (res === "handled") ctx.requestRender();
  }
}

export class TaskInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();
  private data: TaskDetailData | null = null;
  private loading = true;
  private error: string | null = null;

  constructor(
    private readonly taskId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = taskId;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    this.error = null;
    ctx.requestRender();
    try {
      this.data = await this.deps.client.request<TaskDetailData>("task.get", { taskId: this.taskId });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const t = this.data?.task;
    const hints: Hint[] = [
      { key: "L", label: "live log" },
      { key: "s", label: "steer" },
      { key: "u", label: "resume" },
      ...(this.data?.artifacts.length ? [{ key: "a", label: `artifacts(${this.data.artifacts.length})` }] : []),
      ...(this.data?.escalations.length ? [{ key: "e", label: `esc(${this.data.escalations.length})` }] : []),
      ...(this.data?.worktree ? [{ key: "w", label: "worktree" }] : []),
      { key: "x", label: "cancel" },
      { key: "Esc", label: "back" },
    ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [this.taskId],
      rightHeader: t ? statusBadge(t.status, theme) : undefined,
      subtitle: t ? sanitizeLine(t.title) : undefined,
      hints,
      renderBody: (innerW, bodyH) => {
        if (this.loading && !t) return [theme.muted("Loading task...")];
        if (this.error && !t) return [theme.danger(`Failed to load: ${this.error}`)];
        if (!t || !this.data) return [theme.muted("Task not found.")];

        const lines: string[] = [
          kvRow("Task", `${t.id} (Tier ${t.tier} · ${t.kind})`, innerW, theme),
          kvRow("Status", statusBadge(t.status, theme), innerW, theme),
          kvRow("Run", t.runId, innerW, theme),
          kvRow("Profile/Model", `${t.profileId ?? "auto"}${t.model ? ` / ${t.model}` : ""}`, innerW, theme),
          kvRow("Generation", `${t.generation} (turns: ${t.turnsUsed})`, innerW, theme),
          ...(this.data.worktree ? [kvRow("Worktree", `${this.data.worktree.id} (${this.data.worktree.branch})`, innerW, theme)] : []),
          ...(this.data.writeScopes.length > 0 ? [kvRow("Write Scopes", this.data.writeScopes.join(", "), innerW, theme)] : []),
          kvRow("Updated", `${formatClock(t.updatedAt)} (${formatAge(t.updatedAt)})`, innerW, theme),
        ];

        if (t.summary) {
          lines.push("", divider(innerW, theme, "Summary"), ...wrap(sanitizeText(t.summary), innerW));
        }

        if (this.data.handoff) {
          const handoffText =
            typeof this.data.handoff === "string"
              ? this.data.handoff
              : this.data.handoff.summary || JSON.stringify(this.data.handoff);
          if (handoffText && handoffText !== t.summary) {
            lines.push("", divider(innerW, theme, "Handoff"), ...wrap(sanitizeText(handoffText), innerW));
          }
        }

        if (this.data.children.length > 0) {
          lines.push("", divider(innerW, theme, `Child Tasks (${this.data.children.length})`));
          for (const ch of this.data.children.slice(0, 10)) {
            lines.push(clamp(`  ${statusBadge(ch.status, theme)} ${theme.bold(ch.id)} ${tag(`T${ch.tier}/${ch.kind}`, "muted", theme)} ${sanitizeLine(ch.title)}`, innerW));
          }
        }

        if (this.data.escalations.length > 0) {
          lines.push("", divider(innerW, theme, `Escalations (${this.data.escalations.length})`));
          for (const e of this.data.escalations) {
            lines.push(clamp(`  ${statusBadge(e.status, theme)} ${e.id} [${e.severity}] ${sanitizeLine(e.title)}`, innerW));
          }
        }

        if (this.data.artifacts.length > 0) {
          lines.push("", divider(innerW, theme, `Artifacts (${this.data.artifacts.length}) — press 'a' to read`));
          for (const a of this.data.artifacts.slice(0, 10)) {
            lines.push(clamp(`  ${theme.accent(a.path)} ${theme.muted(`(${a.kind})`)}`, innerW));
          }
        }

        if (this.data.merges.length > 0) {
          lines.push("", divider(innerW, theme, `Merges (${this.data.merges.length})`));
          for (const m of this.data.merges) {
            lines.push(clamp(`  ${statusBadge(m.status, theme)} ${m.id} ${m.branch}`, innerW));
          }
        }

        if (this.data.messages.length > 0) {
          lines.push("", divider(innerW, theme, `Messages (${this.data.messages.length})`));
          for (const m of this.data.messages.slice(-8)) {
            const ans = m.answer ? ` → ${sanitizeLine(m.answer)}` : "";
            lines.push(
              ...wrap(
                `  ${theme.dim(formatClock(m.createdAt))} ${theme.accent(`${m.fromTaskId} → ${m.toTaskId}`)} [${m.status}]: ${sanitizeLine(m.question)}${ans}`,
                innerW,
              ),
            );
          }
        }

        if (t.objective) {
          lines.push("", divider(innerW, theme, "Objective"), ...wrap(sanitizeText(t.objective), innerW));
        }
        if (t.criteria) {
          lines.push("", divider(innerW, theme, "Criteria"), ...wrap(sanitizeText(t.criteria), innerW));
        }

        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
      return;
    }
    const t = this.data?.task;
    if (!t || !this.data) return;

    if (data === "s") {
      this.frame.askPrompt({
        label: `Steer ${t.id}`,
        onSubmit: async (message) => {
          const res = await this.deps.client.request<{ steered?: boolean }>("task.steer", { taskId: t.id, message });
          this.frame.setNotice(
            res?.steered === false ? `${t.id} is not actively running (steer not delivered)` : `Steered ${t.id}`,
            res?.steered === false ? "warn" : "ok",
          );
          await this.load(ctx);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "u") {
      this.frame.askPrompt({
        label: `Resume ${t.id} with note`,
        initialValue: "Continue",
        allowEmpty: true,
        onSubmit: async (note) => {
          // Daemon `task.resume` reads `note`, NOT `message`!
          const res = await this.deps.client.request<{ resumed?: boolean; reason?: string; outcome?: string; message?: string }>(
            "task.resume",
            { taskId: t.id, ...(note ? { note } : {}) },
          );
          this.frame.setNotice(...resumeNotice(res, `Resumed ${t.id}`, `Could not resume ${t.id}`));
          await Promise.all([this.load(ctx), this.deps.store.refresh()]);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "x") {
      this.frame.askConfirm({
        message: `Cancel task ${t.id}?`,
        onConfirm: async () => {
          await this.deps.client.request("task.cancel", { taskId: t.id, reason: "Cancelled from TUI" });
          this.frame.setNotice(`Cancelled ${t.id}`, "warn");
          await Promise.all([this.load(ctx), this.deps.store.refresh()]);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "L") {
      ctx.navigator.push(new LiveTranscriptScreen(t.runId, t.id, this.deps));
      return;
    }

    if (data === "e" && this.data.escalations.length > 0) {
      const target =
        this.data.escalations.find((e) => e.status === "open") ??
        this.data.escalations.find((e) => e.status === "acked") ??
        this.data.escalations[0]!;
      ctx.navigator.push(new EscalationInspectorScreen(target.id, this.deps));
      return;
    }

    if (data === "a" && this.data.artifacts.length > 0) {
      if (this.data.artifacts.length === 1) {
        ctx.navigator.push(new ArtifactInspectorScreen(t.runId, this.data.artifacts[0]!.path, this.deps));
      } else {
        ctx.navigator.push(new ArtifactPickerScreen(t.runId, this.data.artifacts, this.deps));
      }
      return;
    }

    if (data === "w" && this.data.worktree) {
      ctx.navigator.push(new WorktreeInspectorScreen(this.data.worktree.id, this.deps));
    }
  }
}

/* ──────────────────────────── Artifact Inspector ──────────────────────────── */

interface ArtifactReadResult {
  path: string;
  content: string;
  truncated?: boolean;
  hasMore?: boolean;
  offset?: number;
  totalChars?: number;
}

class ArtifactInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();
  private result: ArtifactReadResult | null = null;
  private offset = 0;
  private loading = true;
  private error: string | null = null;
  private readonly pageSize = 16_000;

  constructor(
    private readonly runId: string,
    private readonly artifactPath: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = middleEllipsis(artifactPath, 28);
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    this.error = null;
    ctx.requestRender();
    try {
      this.result = await this.deps.client.request<ArtifactReadResult>("artifact.read", {
        runId: this.runId,
        path: this.artifactPath,
        maxChars: this.pageSize,
        offset: this.offset,
      });
      this.viewport.scrollToTop();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const hasMore = Boolean(this.result?.hasMore ?? this.result?.truncated);
    const hints: Hint[] = [
      ...(this.offset > 0 ? [{ key: "p", label: "prev page" }] : []),
      ...(hasMore ? [{ key: "n", label: "next page" }] : []),
      { key: "y", label: "copy" },
      { key: "Esc", label: "back" },
    ];
    const total = this.result?.totalChars;
    const right =
      total != null
        ? theme.muted(`${formatBytes(this.offset)}..${formatBytes(this.offset + (this.result?.content.length ?? 0))} / ${formatBytes(total)}`)
        : undefined;

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Artifact", this.title],
      rightHeader: right,
      subtitle: `${this.runId} · ${this.artifactPath}`,
      hints,
      renderBody: (innerW, bodyH) => {
        if (this.loading && !this.result) return [theme.muted("Loading artifact...")];
        if (this.error) return [theme.danger(this.error)];
        const lines = wrap(sanitizeText(this.result?.content ?? "(empty)"), innerW);
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
      return;
    }
    if (data === "n" && !this.loading && (this.result?.hasMore || this.result?.truncated)) {
      this.offset += this.pageSize;
      void this.load(ctx);
      return;
    }
    if (data === "p" && !this.loading && this.offset > 0) {
      this.offset = Math.max(0, this.offset - this.pageSize);
      void this.load(ctx);
      return;
    }
    if (data === "y" && this.result?.content) {
      const ok = yankText(this.result.content, ctx.writeTerminal);
      this.frame.setNotice(ok ? "Copied artifact content" : "Clipboard unavailable", ok ? "ok" : "warn");
      ctx.requestRender();
    }
  }
}

/* ───────────────────────────── Timer Inspector ────────────────────────────── */

class TimerInspectorScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;

  constructor(
    private readonly timerId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = timerId;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const timer = this.deps.store.getTimer(this.timerId);
    const hints: Hint[] = [
      ...(timer?.status === "pending" ? [{ key: "x", label: "cancel timer" }] : []),
      { key: "Esc", label: "back" },
    ];
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [this.timerId],
      rightHeader: timer ? statusBadge(timer.status, theme) : undefined,
      hints,
      renderBody: (innerW) => {
        if (!timer) return [theme.muted("Timer not found.")];
        return [
          kvRow("Timer ID", timer.id, innerW, theme),
          kvRow("Status", statusBadge(timer.status, theme), innerW, theme),
          kvRow("Owner", `${timer.ownerKind}:${timer.ownerId}`, innerW, theme),
          kvRow("Wake At", `${new Date(timer.wakeAt).toLocaleTimeString()} (${formatCountdown(timer.wakeAt)})`, innerW, theme),
          ...(timer.wakeOnEvent ? [kvRow("Wake Event", timer.wakeOnEvent, innerW, theme)] : []),
          ...(timer.runId ? [kvRow("Run", timer.runId, innerW, theme)] : []),
          "",
          divider(innerW, theme, "Reason"),
          ...wrap(sanitizeText(timer.reason), innerW),
        ];
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    const timer = this.deps.store.getTimer(this.timerId);
    if (data === "x" && timer?.status === "pending") {
      this.frame.askConfirm({
        message: `Cancel timer ${timer.id}?`,
        onConfirm: async () => {
          await this.deps.client.request("timer.cancel", { timerId: timer.id });
          this.frame.setNotice(`Cancelled ${timer.id}`, "warn");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
    }
  }
}

/* ──────────────────────────── Worktree Inspector ──────────────────────────── */

interface WorktreeDetailData {
  worktree: WorktreeRecord;
  run: RunRecord | null;
  task: TaskRecord | null;
  existsOnDisk: boolean;
  gitStatus: string;
  diffStat: string;
}

class WorktreeInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();
  private data: WorktreeDetailData | null = null;
  private loading = true;

  constructor(
    private readonly worktreeId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = worktreeId;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      this.data = await this.deps.client.request<WorktreeDetailData>("worktrees.get", { worktreeId: this.worktreeId });
    } catch {
      this.data = null;
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const wt = this.data?.worktree ?? this.deps.store.getWorktree(this.worktreeId);
    const hints: Hint[] = [
      ...(wt?.taskId ? [{ key: "t", label: "task" }] : []),
      ...(wt?.id ? [{ key: "x", label: "archive & remove" }] : []),
      { key: "Esc", label: "back" },
    ];
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [wt?.id ?? this.worktreeId],
      rightHeader: wt ? statusBadge(wt.status, theme) : undefined,
      hints,
      renderBody: (innerW, bodyH) => {
        if (this.loading && !wt) return [theme.muted("Loading worktree...")];
        if (!wt) return [theme.muted("Worktree not found.")];
        const onDisk = this.data?.existsOnDisk ?? ("existsOnDisk" in wt ? wt.existsOnDisk : false);
        const lines: string[] = [
          kvRow("Worktree ID", wt.id ?? "(untracked)", innerW, theme),
          kvRow("Status", statusBadge(wt.status, theme), innerW, theme),
          kvRow("Branch", wt.branch, innerW, theme),
          kvRow("Path", middleEllipsis(wt.path, Math.max(16, innerW - 18)), innerW, theme),
          kvRow("On Disk", onDisk ? theme.ok("yes") : theme.muted("no"), innerW, theme),
          kvRow("Run / Task", `${wt.runId ?? "—"} / ${wt.taskId ?? "—"}`, innerW, theme),
          ...(this.data?.gitStatus ? ["", divider(innerW, theme, "git status --short"), ...wrap(sanitizeText(this.data.gitStatus), innerW)] : []),
          ...(this.data?.diffStat ? ["", divider(innerW, theme, "git diff --stat"), ...wrap(sanitizeText(this.data.diffStat), innerW)] : []),
        ];
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
      return;
    }
    const wt = this.data?.worktree ?? this.deps.store.getWorktree(this.worktreeId);
    if (!wt) return;
    if (data === "t" && wt.taskId) {
      ctx.navigator.push(new TaskInspectorScreen(wt.taskId, this.deps));
      return;
    }
    if (data === "x" && wt.id) {
      const targetId = wt.id;
      this.frame.askConfirm({
        message: `Archive branch ${wt.branch} and remove worktree ${targetId}?`,
        onConfirm: async () => {
          await this.deps.client.request("worktrees.clean", { repoRoot: this.deps.repoRoot, worktreeId: targetId });
          this.frame.setNotice(`Archived & removed ${targetId}`, "ok");
          await this.deps.store.refresh();
          if (ctx.navigator.current === this) ctx.navigator.pop();
        },
      });
      ctx.requestRender();
    }
  }
}

/* ───────────────────────────── Merge Inspector ────────────────────────────── */

class MergeInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();

  constructor(
    private readonly mergeId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = mergeId;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const m = this.deps.store.getMerge(this.mergeId);
    const hints: Hint[] = [
      ...(m?.taskId ? [{ key: "t", label: "task" }] : []),
      { key: "y", label: "copy log" },
      { key: "Esc", label: "back" },
    ];
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [this.mergeId],
      rightHeader: m ? statusBadge(m.status, theme) : undefined,
      hints,
      renderBody: (innerW, bodyH) => {
        if (!m) return [theme.muted("Merge queue item not found.")];
        const lines: string[] = [
          kvRow("Merge ID", m.id, innerW, theme),
          kvRow("Status", statusBadge(m.status, theme), innerW, theme),
          kvRow("Branch", m.branch, innerW, theme),
          kvRow("Run / Task", `${m.runId} / ${m.taskId}`, innerW, theme),
          kvRow("Worktree", m.worktreeId, innerW, theme),
          "",
          divider(innerW, theme, "Merge Log"),
          ...wrap(sanitizeText(m.log ?? "(no log recorded)"), innerW),
        ];
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
      return;
    }
    const m = this.deps.store.getMerge(this.mergeId);
    if (!m) return;
    if (data === "t" && m.taskId) {
      ctx.navigator.push(new TaskInspectorScreen(m.taskId, this.deps));
      return;
    }
    if (data === "y" && m.log) {
      yankText(m.log, ctx.writeTerminal);
      this.frame.setNotice("Copied merge log", "ok");
      ctx.requestRender();
    }
  }
}

/* ─────────────────────────── Live Transcript Viewer ───────────────────────── */

/**
 * Read-only live transcript viewer backed by `watch.start` (`scope: "task"` or `"run"`) + `replay.page`.
 * Buffers early watch frames until `watchId` settles, drains paginated replay + fragments, handles
 * `agent.tool`, `agent.thought_delta`, `agent.rollover`, `agent.error`, and `quota.*`, and guards
 * `onClose()` so late-resolving watches are stopped immediately without leaking.
 */
export class LiveTranscriptScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport({ follow: true });
  private watchId: string | null = null;
  private closed = false;
  private detach: (() => void) | null = null;
  private earlyBuffer: DaemonEventFrame[] = [];
  private rawLines: string[] = [];
  private textBufByTask = new Map<string, string>();
  private thoughtBufByTask = new Map<string, string>();

  constructor(
    private readonly runId: string,
    private readonly taskId: string | undefined,
    private readonly deps: InspectorDeps,
  ) {
    this.title = taskId ? `Live ${taskId}` : `Live ${runId}`;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    this.closed = false;
    this.earlyBuffer = [];

    // Register listener BEFORE watch.start so zero frames are dropped during handshake
    this.detach = this.deps.client.onEvent((ev) => {
      if (!ev.watchId || this.closed) return;
      if (this.watchId === null) {
        this.earlyBuffer.push(ev);
        return;
      }
      if (ev.watchId !== this.watchId) return;
      this.ingestEvent(ev);
      ctx.requestRender();
    });

    const params = this.taskId
      ? { scope: "task" as const, runId: this.runId, taskId: this.taskId }
      : { scope: "run" as const, runId: this.runId };

    void this.deps.client
      .request<ReplayPage & { watchId: string }>("watch.start", params)
      .then(async (res) => {
        if (this.closed) {
          // Screen closed while watch.start was in-flight: stop immediately so no watch leaks!
          void this.deps.client.request("watch.stop", { watchId: res.watchId }).catch(() => {});
          return;
        }
        this.watchId = res.watchId;
        await consumeReplay(
          this.deps.client,
          res,
          { watchId: res.watchId },
          (ev) => this.ingestEvent(ev),
          () => this.closed,
        );
        if (this.closed) return;
        const buffered = this.earlyBuffer.splice(0);
        for (const ev of buffered) {
          if (ev.watchId === this.watchId) this.ingestEvent(ev);
        }
        ctx.requestRender();
      })
      .catch((err) => {
        if (this.closed) return;
        this.rawLines.push(`Failed to start live watch: ${err instanceof Error ? err.message : String(err)}`);
        ctx.requestRender();
      });
  }

  onClose(): void {
    this.closed = true;
    this.detach?.();
    this.detach = null;
    this.earlyBuffer.length = 0;
    if (this.watchId) {
      const id = this.watchId;
      this.watchId = null;
      void this.deps.client.request("watch.stop", { watchId: id }).catch(() => {});
    }
  }

  private flushPendingBuffers(taskKey?: string): void {
    const keys = taskKey !== undefined ? [taskKey] : [...new Set([...this.thoughtBufByTask.keys(), ...this.textBufByTask.keys()])];
    for (const k of keys) {
      const prefix = !this.taskId && k !== "__run__" ? `[${k}] ` : "";
      const th = this.thoughtBufByTask.get(k);
      if (th && th.trim()) {
        this.rawLines.push(`${prefix}… ${sanitizeLine(th)}`);
      }
      this.thoughtBufByTask.delete(k);
      const tx = this.textBufByTask.get(k);
      if (tx) {
        this.rawLines.push(`${prefix}${sanitizeLine(tx)}`);
      }
      this.textBufByTask.delete(k);
    }
  }

  private ingestEvent(ev: EventRecord | DaemonEventFrame): void {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const taskKey = ev.taskId ?? "__run__";
    const who = !this.taskId && ev.taskId ? `[${ev.taskId}] ` : "";

    if (ev.type === "agent.text_delta") {
      const th = this.thoughtBufByTask.get(taskKey);
      if (th && th.trim()) {
        this.rawLines.push(`${who}… ${sanitizeLine(th)}`);
        this.thoughtBufByTask.delete(taskKey);
      }
      const delta = String(p.text ?? p.delta ?? "");
      const combined = (this.textBufByTask.get(taskKey) ?? "") + delta;
      const parts = combined.split(/\r?\n/);
      const tail = parts.pop() ?? "";
      if (tail) this.textBufByTask.set(taskKey, tail);
      else this.textBufByTask.delete(taskKey);
      for (const line of parts) this.rawLines.push(`${who}${sanitizeLine(line)}`);
    } else if (ev.type === "agent.thought_delta") {
      const delta = String(p.text ?? p.delta ?? "");
      const combined = (this.thoughtBufByTask.get(taskKey) ?? "") + delta;
      const parts = combined.split(/\r?\n/);
      const tail = parts.pop() ?? "";
      if (tail) this.thoughtBufByTask.set(taskKey, tail);
      else this.thoughtBufByTask.delete(taskKey);
      for (const line of parts) {
        if (line.trim()) this.rawLines.push(`${who}… ${sanitizeLine(line)}`);
      }
    } else if (ev.type === "agent.tool") {
      this.flushPendingBuffers(taskKey);
      const name = formatToolLabel(String(p.title ?? p.name ?? p.toolName ?? "tool"));
      const st = String(p.status ?? "running");
      const icon = st === "completed" || st === "ok" ? "✓" : st === "failed" || st === "error" ? "✗" : "▶";
      const detail = p.error ?? p.result ?? p.args ?? "";
      const detailStr = detail ? ` — ${firstLine(typeof detail === "string" ? detail : JSON.stringify(detail), 90)}` : "";
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ${who}${icon} ${name}${detailStr}`);
    } else if (ev.type === "agent.tool_start" || ev.type === "agent.tool_end") {
      this.flushPendingBuffers();
      const name = formatToolLabel(String(p.toolName ?? p.name ?? p.title ?? "tool"));
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ${who}${ev.type === "agent.tool_start" ? "▶" : "✓"} ${name}`);
    } else if (ev.type === "agent.rollover") {
      this.flushPendingBuffers();
      const gen = p.generation ?? p.nextGeneration ?? "";
      const reason = p.reason ? ` (${sanitizeLine(String(p.reason))})` : "";
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ${who}↻ rollover${gen ? ` → gen ${gen}` : ""}${reason}`);
    } else if (ev.type === "agent.error") {
      this.flushPendingBuffers();
      const msg = sanitizeLine(String(p.message ?? p.error ?? "agent error"));
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ${who}✗ ERROR: ${msg}`);
    } else if (ev.type.startsWith("quota.")) {
      this.flushPendingBuffers();
      const reason = sanitizeLine(String(p.reason ?? p.mode ?? ""));
      const wake = p.resumeAt ? ` · resume ${formatCountdown(p.resumeAt as number | string)}` : "";
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ⏸ ${ev.type}${reason ? ` · ${reason}` : ""}${wake}`);
    } else {
      this.flushPendingBuffers();
      const summary = p.summary ?? p.status ?? p.to ?? p.title ?? p.message ?? "";
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ${who}${ev.type}${summary ? ` · ${sanitizeLine(String(summary))}` : ""}`);
    }

    if (this.rawLines.length > 2000) this.rawLines.splice(0, this.rawLines.length - 1500);
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const hints: Hint[] = [
      { key: "f", label: this.viewport.follow ? "follow:on" : "follow:off" },
      { key: "y", label: "copy" },
      { key: "↑↓/PgUp/PgDn/wheel", label: "scroll" },
      { key: "Esc", label: "close" },
    ];
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? [this.title],
      rightHeader: this.viewport.follow ? theme.ok(`${theme.glyphs.running} live`) : theme.muted(this.viewport.statusText()),
      hints,
      renderBody: (innerW, bodyH) => {
        const trailing: string[] = [];
        for (const [k, th] of this.thoughtBufByTask) {
          if (th.trim()) {
            const pfx = !this.taskId && k !== "__run__" ? `[${k}] ` : "";
            trailing.push(theme.dim(`${pfx}… ${sanitizeLine(th)}`));
          }
        }
        for (const [k, tx] of this.textBufByTask) {
          if (tx) {
            const pfx = !this.taskId && k !== "__run__" ? `[${k}] ` : "";
            trailing.push(`${pfx}${sanitizeLine(tx)}`);
          }
        }
        const all = [...this.rawLines, ...trailing];
        if (all.length === 0) return [theme.muted("Waiting for live events...")];
        const wrapped = all.flatMap((l) => wrap(l, innerW));
        return this.viewport.render(wrapped, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (data === "f") {
      this.viewport.follow = !this.viewport.follow;
      if (this.viewport.follow) this.viewport.scrollToBottom(true);
      ctx.requestRender();
      return;
    }
    if (data === "y") {
      const copyLines = [
        ...this.rawLines,
        ...[...this.textBufByTask.entries()].filter(([, tx]) => tx).map(([k, tx]) => `${!this.taskId && k !== "__run__" ? `[${k}] ` : ""}${sanitizeLine(tx)}`),
      ];
      yankText(copyLines.join("\n"), ctx.writeTerminal);
      this.frame.setNotice("Copied transcript lines", "ok");
      ctx.requestRender();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
    }
  }
}

/* ──────────────────────── Generic / ToolCall Inspector ────────────────────── */

class GenericDetailScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();

  constructor(private readonly ref: EntityRef) {
    this.title = middleEllipsis(ref.label || ref.id, 30);
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Inspect", this.ref.kind, this.title],
      hints: [
        { key: "y", label: "copy" },
        { key: "Esc", label: "back" },
      ],
      renderBody: (innerW, bodyH) => {
        const bodyText =
          typeof this.ref.payload === "string"
            ? this.ref.payload
            : this.ref.payload != null
              ? JSON.stringify(this.ref.payload, null, 2)
              : `${this.ref.kind}: ${this.ref.id}\n${this.ref.label}`;
        const lines = wrap(sanitizeText(bodyText), innerW);
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (data === "y") {
      const txt =
        typeof this.ref.payload === "string"
          ? this.ref.payload
          : JSON.stringify(this.ref.payload ?? this.ref, null, 2);
      yankText(txt, ctx.writeTerminal);
      this.frame.setNotice("Copied details", "ok");
      ctx.requestRender();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
    }
  }
}
