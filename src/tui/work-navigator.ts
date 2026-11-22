import { matchesKey } from "@earendil-works/pi-tui";
import type { InboxItem } from "../protocol/daemon-rpc.js";
import {
  type TuiEntityRef as EntityRef,
  firstLine,
  formatAge,
  formatCountdown,
  Frame,
  type FrameTab,
  type Hint,
  ListView,
  middleEllipsis,
  sanitizeLine,
  type Screen,
  type ScreenContext,
  splitRow,
  statusBadge,
  tag,
  type Theme,
} from "./core/index.js";
import { type InspectorDeps, openEntityInspector } from "./inspectors.js";

export type WorkTabId = "inbox" | "goals" | "runs" | "escalations" | "timers" | "worktrees";

const TAB_ORDER: WorkTabId[] = ["inbox", "goals", "runs", "escalations", "timers", "worktrees"];

/**
 * Single unified Work Navigator (`Ctrl+G`).
 * Surfaces every object in the harness across 6 tabbed lists with live badges,
 * `/` fuzzy filter, and `Enter` drill-down into the Entity Inspector stack.
 */
export class WorkNavigatorScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Work";
  private readonly frame = new Frame();
  private readonly list = new ListView<{ ref: EntityRef; quickResolveEscId?: string }>();
  private activeTab: WorkTabId;
  private openEscalationsOnly = true;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly deps: InspectorDeps,
    initialTab?: WorkTabId,
  ) {
    this.activeTab =
      initialTab ?? (deps.store.state.inbox.length > 0 ? "inbox" : "goals");
  }

  onShow(ctx: ScreenContext): void {
    this.unsub = this.deps.store.subscribe(() => {
      this.rebuildList();
      ctx.requestRender();
    });
    this.rebuildList();
    void this.deps.store.refresh();
  }

  onClose(): void {
    this.unsub?.();
    this.unsub = null;
  }

  setTab(tab: WorkTabId): void {
    this.activeTab = tab;
    this.list.clearFilter();
    this.rebuildList();
  }

  private rebuildList(): void {
    const snap = this.deps.store.state;

    if (this.activeTab === "inbox") {
      this.list.emptyText = "Inbox clear — no escalations, paused runs, or pending decisions.";
      this.list.setItems(
        snap.inbox.map((item: InboxItem) => ({
          id: item.id,
          value: {
            ref: {
              kind: item.ref.kind,
              id: item.ref.id,
              runId: item.ref.runId,
              goalId: item.ref.goalId,
              label: item.ref.label ?? item.title,
            },
            quickResolveEscId: item.kind === "escalation" ? item.ref.id : undefined,
          },
          searchText: `${item.severity} ${item.kind} ${item.title} ${item.detail} ${item.goalId ?? ""} ${item.runId ?? ""}`,
          render: (w, _sel, theme) => {
            const sevTone = item.severity === "P0" ? "danger" : item.severity === "P1" ? "warn" : "info";
            const cleanTitle = sanitizeLine(item.title).replace(/^\[P[0-2]\/[^\]]+\]\s*/i, "");
            const left = `${tag(item.severity, sevTone, theme)} ${theme.bold(cleanTitle)} ${theme.muted(`· ${firstLine(item.detail, 55)}`)}`;
            const right = theme.muted(formatAge(item.createdAt));
            return splitRow(left, right, w);
          },
        })),
      );
      return;
    }

    if (this.activeTab === "goals") {
      this.list.emptyText = "No goals yet. Ask the Director to plan work or create a goal.";
      this.list.setItems(
        snap.goals.map(({ goal, reviews }) => {
          const run = goal.linkedRunId ? this.deps.store.getRunEntry(goal.linkedRunId) : undefined;
          const openEsc = run ? run.escalations.filter((e) => e.status === "open").length : 0;
          const running = run ? run.tasks.filter((t) => t.status === "running").length : 0;
          return {
            id: goal.id,
            value: {
              ref: { kind: "goal", id: goal.id, runId: goal.linkedRunId ?? undefined, label: `${goal.id} ${goal.title}` },
            },
            searchText: `${goal.id} ${goal.status} ${goal.title} ${goal.linkedRunId ?? ""}`,
            render: (w, _sel, theme) => {
              const escTag = openEsc > 0 ? ` ${tag(`!${openEsc} esc`, "danger", theme)}` : "";
              const runTag = running > 0 ? ` ${tag(`${running} active`, "accent", theme)}` : "";
              const revTag = reviews.length > 0 ? ` ${theme.muted(`r#${reviews.length}`)}` : "";
              const left = `${statusBadge(goal.status, theme)} ${theme.bold(goal.id)} ${theme.muted(`v${goal.version}`)} ${sanitizeLine(goal.title)}${escTag}${runTag}${revTag}`;
              const right = theme.muted(formatAge(goal.updatedAt));
              return splitRow(left, right, w);
            },
          };
        }),
      );
      return;
    }

    if (this.activeTab === "runs") {
      this.list.emptyText = "No runs recorded.";
      this.list.setItems(
        snap.runs.map((entry) => {
          const r = entry.run;
          const running = entry.tasks.filter((t) => t.status === "running").length;
          const openEsc = entry.escalations.filter((e) => e.status === "open").length;
          return {
            id: r.id,
            value: { ref: { kind: "run", id: r.id, goalId: entry.goalId ?? undefined, label: r.id } },
            searchText: `${r.id} ${r.status} ${entry.goalId ?? ""} ${r.goal}`,
            render: (w, _sel, theme) => {
              const goalTag = entry.goalId ? ` ${tag(entry.goalId, "info", theme)}` : "";
              const escTag = openEsc > 0 ? ` ${tag(`!${openEsc}`, "danger", theme)}` : "";
              const counts = theme.muted(`${running}/${entry.tasks.length} tasks`);
              const left = `${statusBadge(r.status, theme)} ${theme.bold(r.id)}${goalTag}${escTag} ${firstLine(r.goal, 48)}`;
              const right = `${counts} ${theme.muted(formatAge(r.updatedAt))}`;
              return splitRow(left, right, w);
            },
          };
        }),
      );
      return;
    }

    if (this.activeTab === "escalations") {
      const items = this.openEscalationsOnly
        ? snap.escalations.filter((e) => e.status === "open")
        : snap.escalations;
      this.list.emptyText = this.openEscalationsOnly
        ? "No open escalations. Press 'a' to show resolved escalations."
        : "No escalations recorded.";
      this.list.setItems(
        items.map((e) => ({
          id: e.id,
          value: {
            ref: { kind: "escalation", id: e.id, runId: e.runId, label: `${e.id} ${e.title}` },
            quickResolveEscId: e.status === "open" ? e.id : undefined,
          },
          searchText: `${e.id} ${e.severity} ${e.category} ${e.status} ${e.title} ${e.runId} ${e.fromTaskId}`,
          render: (w, _sel, theme) => {
            const sevTone = e.severity === "P0" ? "danger" : e.severity === "P1" ? "warn" : "info";
            const blk = e.blocking ? ` ${tag("BLK", "danger", theme)}` : "";
            const left = `${statusBadge(e.status, theme)} ${tag(e.severity, sevTone, theme)} ${theme.bold(e.id)}${blk} ${sanitizeLine(e.title)} ${theme.muted(`(${e.runId})`)}`;
            const right = theme.muted(formatAge(e.createdAt));
            return splitRow(left, right, w);
          },
        })),
      );
      return;
    }

    if (this.activeTab === "timers") {
      this.list.emptyText = "No timers scheduled.";
      this.list.setItems(
        snap.timers.map((t) => ({
          id: t.id,
          value: { ref: { kind: "timer", id: t.id, runId: t.runId ?? undefined, label: `${t.id} ${t.reason}` } },
          searchText: `${t.id} ${t.status} ${t.reason} ${t.ownerId} ${t.runId ?? ""}`,
          render: (w, _sel, theme) => {
            const when = t.status === "pending" ? theme.accent(formatCountdown(t.wakeAt)) : theme.muted(t.status);
            const left = `${statusBadge(t.status, theme)} ${theme.bold(t.id)} ${firstLine(t.reason, 60)}`;
            return splitRow(left, when, w);
          },
        })),
      );
      return;
    }

    // worktrees + merges tab
    this.list.emptyText = "No active worktrees or merge queue items.";
    const combined = [
      ...snap.worktrees.map((wt) => ({
        id: `wt:${wt.id}`,
        value: { ref: { kind: "worktree" as const, id: wt.id, runId: wt.runId, label: `${wt.id} ${wt.branch}` } },
        searchText: `worktree ${wt.id} ${wt.branch} ${wt.status} ${wt.runId} ${wt.taskId}`,
        render: (w: number, _sel: boolean, theme: Theme) =>
          splitRow(
            `${statusBadge(wt.status, theme)} ${tag("wt", "info", theme)} ${theme.bold(wt.id)} ${middleEllipsis(wt.branch, 36)}`,
            theme.muted(wt.taskId),
            w,
          ),
      })),
      ...snap.merges.map((m) => ({
        id: `merge:${m.id}`,
        value: { ref: { kind: "merge" as const, id: m.id, runId: m.runId, label: `${m.id} ${m.branch}` } },
        searchText: `merge ${m.id} ${m.branch} ${m.status} ${m.runId} ${m.taskId}`,
        render: (w: number, _sel: boolean, theme: Theme) =>
          splitRow(
            `${statusBadge(m.status, theme)} ${tag("merge", "accent", theme)} ${theme.bold(m.id)} ${middleEllipsis(m.branch, 36)}`,
            theme.muted(formatAge(m.finishedAt ?? m.createdAt)),
            w,
          ),
      })),
    ];
    this.list.setItems(combined);
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const snap = this.deps.store.state;
    const tabs: FrameTab[] = [
      { id: "inbox", label: "Inbox", count: snap.inbox.length, tone: snap.inbox.length > 0 ? "danger" : undefined },
      { id: "goals", label: "Goals", count: snap.goals.length },
      { id: "runs", label: "Runs", count: snap.runs.length },
      { id: "escalations", label: "Escalations", count: this.deps.store.openEscalationsCount, tone: this.deps.store.openEscalationsCount > 0 ? "danger" : undefined },
      { id: "timers", label: "Timers", count: this.deps.store.pendingTimersCount },
      { id: "worktrees", label: "Worktrees", count: snap.worktrees.length + snap.merges.length },
    ];

    const hints: Hint[] = [
      { key: "Enter", label: "inspect" },
      { key: "1-6/Tab", label: "tabs" },
      { key: "/", label: "filter" },
      ...(this.activeTab === "escalations"
        ? [{ key: "a", label: this.openEscalationsOnly ? "show all" : "open only" }]
        : []),
      ...(this.activeTab === "worktrees" ? [{ key: "C", label: "sweep stale" }] : []),
      { key: "r", label: "refresh" },
      { key: "Esc", label: "close" },
    ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Work"],
      rightHeader: snap.generatedAt > 0 ? theme.muted(`updated ${formatAge(snap.generatedAt)}`) : undefined,
      tabs,
      activeTabId: this.activeTab,
      hints,
      renderBody: (innerW, bodyH) => this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    // When filtering, let ListView consume Escape / typing first
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") {
        const sel = this.list.selectedItem();
        if (sel) openEntityInspector(sel.value.ref, this.deps, ctx);
        return;
      }
      ctx.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }

    if (data >= "1" && data <= "6") {
      this.setTab(TAB_ORDER[Number(data) - 1]!);
      ctx.requestRender();
      return;
    }

    if (matchesKey(data, "tab")) {
      const next = (TAB_ORDER.indexOf(this.activeTab) + 1) % TAB_ORDER.length;
      this.setTab(TAB_ORDER[next]!);
      ctx.requestRender();
      return;
    }

    if (matchesKey(data, "shift+tab")) {
      const prev = (TAB_ORDER.indexOf(this.activeTab) + TAB_ORDER.length - 1) % TAB_ORDER.length;
      this.setTab(TAB_ORDER[prev]!);
      ctx.requestRender();
      return;
    }

    if (data === "r") {
      this.frame.setNotice("Refreshing snapshot...", "info");
      ctx.requestRender();
      void this.deps.store.refresh().then(() => {
        this.frame.setNotice("", "info");
        ctx.requestRender();
      });
      return;
    }

    if (data === "a" && this.activeTab === "escalations") {
      this.openEscalationsOnly = !this.openEscalationsOnly;
      this.rebuildList();
      ctx.requestRender();
      return;
    }

    if (data === "C" && this.activeTab === "worktrees") {
      this.frame.askConfirm({
        message: "Sweep finished & orphaned worktrees for this repo?",
        onConfirm: async () => {
          const res = await this.deps.client.request<{ removed?: string[] }>("worktrees.clean", {
            repoRoot: this.deps.repoRoot,
          });
          this.frame.setNotice(`Swept ${res.removed?.length ?? 0} worktree(s)`, "ok");
          await this.deps.store.refresh();
        },
      });
      ctx.requestRender();
      return;
    }

    const res = this.list.handleInput(data);
    if (res === "select") {
      const sel = this.list.selectedItem();
      if (sel) openEntityInspector(sel.value.ref, this.deps, ctx);
      return;
    }
    if (res === "handled") {
      ctx.requestRender();
    }
  }
}
