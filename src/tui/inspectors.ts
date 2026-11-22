import { matchesKey } from "@earendil-works/pi-tui";
import type {
  ArtifactRecord,
  EscalationRecord,
  MergeQueueRecord,
  MessageRecord,
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
  divider,
  type TuiEntityRef as EntityRef,
  firstLine,
  formatAge,
  formatBytes,
  formatClock,
  formatCountdown,
  formatDuration,
  Frame,
  type Hint,
  kvRow,
  ListView,
  middleEllipsis,
  parseDurationMs,
  parseMouseWheel,
  sanitizeLine,
  sanitizeText,
  type Screen,
  type ScreenContext,
  splitRow,
  statusBadge,
  tag,
  type Theme,
  Viewport,
  wrap,
  yankText,
} from "./core/index.js";
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
      ctx.navigator.push(new LiveTranscriptScreen(ref.runId ?? ref.id, ref.id !== ref.runId ? ref.id : undefined, deps));
      return;
    default:
      ctx.navigator.push(new GenericDetailScreen(ref));
      return;
  }
}

function handleViewportScrollKeys(data: string, viewport: Viewport): boolean {
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
  if (data === "g" || matchesKey(data, "home")) {
    viewport.scrollToTop();
    return true;
  }
  if (data === "G" || matchesKey(data, "end")) {
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

class EscalationInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
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
      { key: "Esc", label: "back" },
    ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Work", "Escalations", this.escalationId],
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
          kvRow("From Task", `${esc.fromTaskId}${this.data?.fromTask ? ` (${this.data.fromTask.status} · ${sanitizeLine(this.data.fromTask.title)})` : ""}`, innerW, theme),
          ...(this.data?.goal ? [kvRow("Goal", `${this.data.goal.id} v${this.data.goal.version}: ${sanitizeLine(this.data.goal.title)}`, innerW, theme)] : []),
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
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
      return;
    }
    const esc = this.data?.escalation ?? this.deps.store.getEscalation(this.escalationId);
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
        label: "Acknowledge note (stays open)",
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

    if (data === "g" && this.data?.goal) {
      ctx.navigator.push(new GoalInspectorScreen(this.data.goal.id, this.deps));
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
      return;
    }
  }
}

/* ───────────────────────────── Goal Inspector ─────────────────────────────── */

class GoalInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private readonly viewport = new Viewport();
  private activeTab: "overview" | "tasks" | "reviews" | "revisions" = "overview";
  private subList = new ListView<{ ref: EntityRef }>();
  private unsub: (() => void) | null = null;

  constructor(
    private readonly goalId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = goalId;
  }

  onShow(ctx: ScreenContext): void {
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

  private rebuildSubList(): void {
    const entry = this.getEntry();
    if (!entry) return;
    const run = entry.goal.linkedRunId ? this.deps.store.getRunEntry(entry.goal.linkedRunId) : undefined;

    if (this.activeTab === "tasks") {
      const tasks = run?.tasks ?? [];
      this.subList.emptyText = "No tasks yet for this goal.";
      this.subList.setItems(
        tasks.map((t) => ({
          id: t.id,
          value: { ref: { kind: "task", id: t.id, runId: t.runId, goalId: this.goalId, label: `${t.id} ${t.title}` } },
          searchText: `${t.id} ${t.status} ${t.kind} ${t.title}`,
          render: (w, _sel, theme) =>
            splitRow(
              `${statusBadge(t.status, theme)} ${theme.bold(t.id)} ${tag(`T${t.tier}/${t.kind}`, "muted", theme)} ${sanitizeLine(t.title)}`,
              theme.muted(formatAge(t.updatedAt)),
              w,
            ),
        })),
      );
    } else if (this.activeTab === "reviews") {
      const reviews = entry.reviews ?? [];
      this.subList.emptyText = "No reviews recorded yet.";
      this.subList.setItems(
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
          render: (w, _sel, theme) =>
            splitRow(
              `${statusBadge(rev.verdict, theme)} ${theme.bold(`#${rev.cycle}`)} v${rev.goalVersion} ${firstLine(rev.summary, 70)}`,
              theme.muted(formatAge(rev.createdAt)),
              w,
            ),
        })),
      );
    } else if (this.activeTab === "revisions") {
      const revs = entry.revisions ?? [];
      this.subList.emptyText = "No revision history.";
      this.subList.setItems(
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
          render: (w, _sel, theme) =>
            splitRow(
              `${theme.accentBold(`v${rev.version}`)} ${sanitizeLine(rev.rationale || rev.title)}`,
              theme.muted(formatAge(rev.createdAt)),
              w,
            ),
        })),
      );
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const entry = this.getEntry();
    const g = entry?.goal;
    const run = g?.linkedRunId ? this.deps.store.getRunEntry(g.linkedRunId) : undefined;
    const openEscs = run ? run.escalations.filter((e) => e.status === "open") : [];

    const tabs = [
      { id: "overview", label: "Overview" },
      { id: "tasks", label: "Tasks", count: run?.tasks.length ?? 0 },
      { id: "reviews", label: "Reviews", count: entry?.reviews.length ?? 0 },
      { id: "revisions", label: "Revisions", count: entry?.revisions.length ?? 0 },
    ];

    const hints: Hint[] = [
      { key: "1-4", label: "tab" },
      ...(g?.status === "draft" ? [{ key: "c", label: "commit" }] : []),
      { key: "v", label: "review" },
      { key: "m", label: "amend" },
      ...(g?.status === "paused" || g?.status === "awaiting_human" ? [{ key: "u", label: "resume" }] : [{ key: "p", label: "pause" }]),
      ...(run ? [{ key: "R", label: "run" }] : []),
      ...(openEscs.length > 0 ? [{ key: "e", label: `esc(${openEscs.length})` }] : []),
      { key: "x", label: "cancel" },
      { key: "Esc", label: "back" },
    ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Work", "Goals", this.goalId],
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
          kvRow("Updated", `${formatClock(g.updatedAt)} (${formatAge(g.updatedAt)})`, innerW, theme),
          ...(openEscs.length > 0
            ? [kvRow("Open Escalations", theme.danger(`${openEscs.length} open — press 'e' to inspect`), innerW, theme)]
            : []),
          "",
          divider(innerW, theme, "Description"),
          ...wrap(sanitizeText(g.description || g.title), innerW),
        ];

        if (g.criteria.length > 0) {
          lines.push("", divider(innerW, theme, `Acceptance Criteria (${g.criteria.length})`));
          for (const c of g.criteria) {
            const req = c.required ? theme.accent("*") : theme.muted("·");
            const cmd = c.command ? theme.muted(`  $ ${sanitizeLine(c.command)}`) : "";
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
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }

    const tabOrder: Array<"overview" | "tasks" | "reviews" | "revisions"> = ["overview", "tasks", "reviews", "revisions"];
    if (data >= "1" && data <= "4") {
      this.activeTab = tabOrder[Number(data) - 1]!;
      this.rebuildSubList();
      ctx.requestRender();
      return;
    }
    if (matchesKey(data, "tab")) {
      const next = (tabOrder.indexOf(this.activeTab) + 1) % tabOrder.length;
      this.activeTab = tabOrder[next]!;
      this.rebuildSubList();
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
          await this.deps.client.request("goal.commit", { goalId: g.id });
          this.frame.setNotice(`Committed ${g.id}`, "ok");
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

    if (data === "p") {
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

    if (data === "u") {
      this.frame.askPrompt({
        label: "Resume note (optional)",
        initialValue: "Resumed from TUI",
        onSubmit: async (note) => {
          await this.deps.client.request("goal.resume", { goalId: g.id, note });
          this.frame.setNotice(`Resumed ${g.id}`, "ok");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "x") {
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
      const firstOpen = run.escalations.find((e) => e.status === "open");
      if (firstOpen) ctx.navigator.push(new EscalationInspectorScreen(firstOpen.id, this.deps));
      return;
    }
  }
}

/* ────────────────────────────── Run Inspector ─────────────────────────────── */

class RunInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private readonly taskList = new ListView<TaskRecord>({ emptyText: "No tasks in this run." });
  private unsub: (() => void) | null = null;

  constructor(
    private readonly runId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = runId;
  }

  onShow(ctx: ScreenContext): void {
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
    const ordered: Array<{ task: TaskRecord; depth: number }> = [];
    const visit = (parentId: string, depth: number) => {
      for (const child of byParent.get(parentId) ?? []) {
        ordered.push({ task: child, depth });
        visit(child.id, depth + 1);
      }
    };
    visit("__root__", 0);
    // Include any orphans whose parent wasn't found
    const seen = new Set(ordered.map((o) => o.task.id));
    for (const t of entry.tasks) {
      if (!seen.has(t.id)) ordered.push({ task: t, depth: 0 });
    }

    this.taskList.setItems(
      ordered.map(({ task, depth }) => ({
        id: task.id,
        value: task,
        searchText: `${task.id} ${task.status} ${task.kind} ${task.title} ${task.profileId ?? ""}`,
        render: (w, _sel, theme) => {
          const indent = depth > 0 ? `${"  ".repeat(Math.min(depth, 4))}${theme.muted(theme.glyphs.branchEnd)} ` : "";
          const left = `${indent}${statusBadge(task.status, theme)} ${theme.bold(task.id)} ${tag(`T${task.tier}/${task.kind}`, "muted", theme)} ${sanitizeLine(task.title)}`;
          const right = theme.muted(formatAge(task.updatedAt));
          return splitRow(left, right, w);
        },
      })),
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const entry = this.deps.store.getRunEntry(this.runId);
    const run = entry?.run;
    const hints: Hint[] = [
      { key: "Enter", label: "inspect task" },
      { key: "L", label: "live log" },
      { key: "u", label: "resume" },
      { key: "s", label: "schedule" },
      { key: "p", label: "stop" },
      ...(this.deps.onAttachRun ? [{ key: "A", label: "attach" }] : []),
      { key: "Esc", label: "back" },
    ];

    const sub = run
      ? `branch ${run.baseBranch}${entry?.goalId ? ` · ${entry.goalId}` : ""}${entry?.quotaPause ? ` · quota paused (${formatCountdown(entry.quotaPause.resumeAtMs)})` : ""}`
      : undefined;

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Work", "Runs", this.runId],
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
    if (matchesKey(data, "escape") || data === "q") {
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
    if (data === "u") {
      this.frame.askPrompt({
        label: "Resume guidance (optional)",
        initialValue: "Continue",
        onSubmit: async (message) => {
          await this.deps.client.request("run.resume", { runId: this.runId, message });
          this.frame.setNotice(`Resumed ${this.runId}`, "ok");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }
    if (data === "s") {
      this.frame.askPrompt({
        label: "Schedule resume in (e.g. 15m, 1h30m)",
        initialValue: "15m",
        onSubmit: async (raw) => {
          const delayMs = parseDurationMs(raw);
          if (!delayMs) throw new Error(`Invalid duration: ${raw}`);
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
        message: `Stop run ${this.runId} and all its active agents?`,
        onConfirm: async () => {
          await this.deps.client.request("run.stop", { runId: this.runId, reason: "Stopped from TUI" });
          this.frame.setNotice(`Stopped ${this.runId}`, "warn");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }
  }
}

/* ────────────────────────────── Task Inspector ────────────────────────────── */

interface TaskDetailData {
  task: TaskRecord;
  handoff: Record<string, unknown> | null;
  run: RunRecord | null;
  escalations: EscalationRecord[];
  artifacts: ArtifactRecord[];
  worktree: WorktreeRecord | null;
  merges: MergeQueueRecord[];
  messages: MessageRecord[];
  children: TaskRecord[];
  writeScopes: string[];
}

class TaskInspectorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
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
      { key: "s", label: "steer" },
      { key: "u", label: "resume" },
      { key: "L", label: "live log" },
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
      breadcrumbs: ["Work", t?.runId ?? "Run", this.taskId],
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
          lines.push("", divider(innerW, theme, "Merges"));
          for (const m of this.data.merges) {
            lines.push(clamp(`  ${statusBadge(m.status, theme)} ${m.id} ${m.branch}`, innerW));
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
    if (matchesKey(data, "escape") || data === "q") {
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
          await this.deps.client.request("task.steer", { taskId: t.id, message });
          this.frame.setNotice(`Steered ${t.id}`, "ok");
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
        onSubmit: async (message) => {
          await this.deps.client.request("task.resume", { taskId: t.id, message });
          this.frame.setNotice(`Resumed ${t.id}`, "ok");
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
      const target = this.data.escalations.find((e) => e.status === "open") ?? this.data.escalations[0]!;
      ctx.navigator.push(new EscalationInspectorScreen(target.id, this.deps));
      return;
    }

    if (data === "a" && this.data.artifacts.length > 0) {
      const first = this.data.artifacts[0]!;
      ctx.navigator.push(new ArtifactInspectorScreen(t.runId, first.path, this.deps));
      return;
    }

    if (data === "w" && this.data.worktree) {
      ctx.navigator.push(new WorktreeInspectorScreen(this.data.worktree.id, this.deps));
      return;
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
    const right = total != null ? theme.muted(`${formatBytes(this.offset)}..${formatBytes(this.offset + (this.result?.content.length ?? 0))} / ${formatBytes(total)}`) : undefined;

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Work", "Artifact", this.title],
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
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }
    if (handleViewportScrollKeys(data, this.viewport)) {
      ctx.requestRender();
      return;
    }
    if (data === "n" && (this.result?.hasMore || this.result?.truncated)) {
      this.offset += this.pageSize;
      void this.load(ctx);
      return;
    }
    if (data === "p" && this.offset > 0) {
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

  constructor(
    private readonly timerId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = timerId;
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
      breadcrumbs: ["Work", "Timers", this.timerId],
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
    if (matchesKey(data, "escape") || data === "q") {
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
      { key: "x", label: "archive & remove" },
      { key: "Esc", label: "back" },
    ];
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Work", "Worktrees", this.worktreeId],
      rightHeader: wt ? statusBadge(wt.status, theme) : undefined,
      hints,
      renderBody: (innerW, bodyH) => {
        if (this.loading && !wt) return [theme.muted("Loading worktree...")];
        if (!wt) return [theme.muted("Worktree not found.")];
        const lines: string[] = [
          kvRow("Worktree ID", wt.id, innerW, theme),
          kvRow("Status", statusBadge(wt.status, theme), innerW, theme),
          kvRow("Branch", wt.branch, innerW, theme),
          kvRow("Path", middleEllipsis(wt.path, Math.max(16, innerW - 16)), innerW, theme),
          kvRow("On Disk", this.data?.existsOnDisk ? theme.ok("yes") : theme.muted("no"), innerW, theme),
          kvRow("Run / Task", `${wt.runId} / ${wt.taskId}`, innerW, theme),
          ...(this.data?.gitStatus ? ["", divider(innerW, theme, "git status --short"), ...wrap(sanitizeText(this.data.gitStatus), innerW)] : []),
          ...(this.data?.diffStat ? ["", divider(innerW, theme, "git diff --stat"), ...wrap(sanitizeText(this.data.diffStat), innerW)] : []),
        ];
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (matchesKey(data, "escape") || data === "q") {
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
    if (data === "x") {
      this.frame.askConfirm({
        message: `Archive branch ${wt.branch} and remove worktree ${wt.id}?`,
        onConfirm: async () => {
          await this.deps.client.request("worktrees.clean", { repoRoot: this.deps.repoRoot, worktreeId: wt.id });
          this.frame.setNotice(`Archived & removed ${wt.id}`, "ok");
          await this.deps.store.refresh();
          ctx.navigator.pop();
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
  private readonly viewport = new Viewport();

  constructor(
    private readonly mergeId: string,
    private readonly deps: InspectorDeps,
  ) {
    this.title = mergeId;
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
      breadcrumbs: ["Work", "Merges", this.mergeId],
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
    if (matchesKey(data, "escape") || data === "q") {
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

class LiveTranscriptScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private readonly viewport = new Viewport({ follow: true });
  private watchId: string | null = null;
  private detach: (() => void) | null = null;
  private rawLines: string[] = [];
  private textBuf = "";

  constructor(
    private readonly runId: string,
    private readonly taskId: string | undefined,
    private readonly deps: InspectorDeps,
  ) {
    this.title = taskId ? `Live ${taskId}` : `Live ${runId}`;
  }

  onShow(ctx: ScreenContext): void {
    this.detach = this.deps.client.onEvent((ev) => this.onEvent(ev, ctx));
    void this.deps.client
      .request<{ watchId: string; replay?: DaemonEventFrame[] }>("watch.start", {
        runId: this.runId,
        ...(this.taskId ? { taskId: this.taskId } : {}),
        limit: 200,
      })
      .then((res) => {
        this.watchId = res.watchId;
        for (const ev of res.replay ?? []) this.ingestEvent(ev);
        ctx.requestRender();
      })
      .catch((err) => {
        this.rawLines.push(`Failed to start live watch: ${err instanceof Error ? err.message : String(err)}`);
        ctx.requestRender();
      });
  }

  onClose(): void {
    this.detach?.();
    this.detach = null;
    if (this.watchId) {
      const id = this.watchId;
      this.watchId = null;
      void this.deps.client.request("watch.stop", { watchId: id }).catch(() => {});
    }
  }

  private onEvent(ev: DaemonEventFrame, ctx: ScreenContext): void {
    if (!this.watchId || ev.watchId !== this.watchId) return;
    this.ingestEvent(ev);
    ctx.requestRender();
  }

  private ingestEvent(ev: DaemonEventFrame): void {
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === "agent.text_delta") {
      const delta = String(p.text ?? p.delta ?? "");
      this.textBuf += delta;
      const parts = this.textBuf.split(/\r?\n/);
      this.textBuf = parts.pop() ?? "";
      for (const line of parts) this.rawLines.push(sanitizeLine(line));
    } else if (ev.type === "agent.tool_start" || ev.type === "agent.tool_end") {
      const name = String(p.toolName ?? p.name ?? p.title ?? "tool");
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ${ev.type === "agent.tool_start" ? "▶" : "✓"} ${sanitizeLine(name)}`);
    } else if (ev.type !== "agent.thought_delta") {
      const summary = p.summary ?? p.status ?? p.title ?? p.message ?? "";
      this.rawLines.push(`[${formatClock(ev.createdAt)}] ${ev.type}${summary ? ` · ${sanitizeLine(String(summary))}` : ""}`);
    }
    if (this.rawLines.length > 2000) this.rawLines.splice(0, this.rawLines.length - 1500);
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const hints: Hint[] = [
      { key: "f", label: this.viewport.follow ? "follow:on" : "follow:off" },
      { key: "y", label: "copy" },
      { key: "Esc", label: "close" },
    ];
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Work", this.runId, this.taskId ?? "Live Log"],
      rightHeader: this.viewport.follow ? theme.ok("● live") : theme.muted(this.viewport.statusText()),
      hints,
      renderBody: (innerW, bodyH) => {
        const all = this.textBuf ? [...this.rawLines, sanitizeLine(this.textBuf)] : this.rawLines;
        if (all.length === 0) return [theme.muted("Waiting for live events...")];
        const wrapped = all.flatMap((l) => wrap(l, innerW));
        return this.viewport.render(wrapped, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (matchesKey(data, "escape") || data === "q") {
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
      yankText(this.rawLines.join("\n"), ctx.writeTerminal);
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
  private readonly viewport = new Viewport();

  constructor(private readonly ref: EntityRef) {
    this.title = middleEllipsis(ref.label || ref.id, 30);
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Inspect", this.ref.kind, this.title],
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
    if (matchesKey(data, "escape") || data === "q") {
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
