import { matchesKey } from "@earendil-works/pi-tui";
import {
  type CompiledModelCatalog,
  type CompiledModelEntry,
  isModelEnabledInCatalog,
} from "../catalog/compiler.js";
import type { ModelRoute } from "../catalog/deduplicate.js";
import type { HarnessConfig, RunnerProfileConfig } from "../config.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { KbCard, KbEntry } from "../kb/store.js";
import type { CostSnapshot } from "../protocol/daemon-rpc.js";
import {
  clamp,
  type ColumnSpec,
  divider,
  type TuiEntityRef as EntityRef,
  fillLineBg,
  firstLine,
  formatAge,
  formatCountdown,
  formatDuration,
  formatUsd,
  Frame,
  type FrameTab,
  handleTabKeys,
  type Hint,
  isPopKey,
  kvRow,
  layoutColumns,
  middleEllipsis,
  type Navigator,
  parseMouseWheel,
  type RecentRefsRing,
  renderProgressBar,
  sanitizeLine,
  sanitizeText,
  type Screen,
  type ScreenContext,
  splitRow,
  statusBadge,
  TableListView,
  tag,
  type Theme,
  Viewport,
  wrap,
} from "./core/index.js";
import { type InspectorDeps, openEntityInspector } from "./inspectors.js";
import type { AttachableSession } from "./store.js";

export { QuotaWaitPickerScreen } from "./quota-wait-picker.js";
export { SettingsScreen, type SettingsTabId } from "./settings.js";

/* ─────────────────────────── Go-To-Anything (Ctrl+O) ──────────────────────── */

export interface QuickActionItem {
  id: string;
  label: string;
  detail: string;
  pinned?: boolean;
  run: (ctx: ScreenContext) => void;
}

const PALETTE_COLUMNS: ColumnSpec[] = [
  { key: "badge", header: "TYPE", width: 10, priority: 0 },
  { key: "title", header: "ITEM", minWidth: 18, priority: 0 },
  { key: "detail", header: "DETAIL", minWidth: 14, align: "right", priority: 1 },
];

export class GoToPaletteScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Go To";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<{ run: (ctx: ScreenContext) => void }>({
    columns: PALETTE_COLUMNS,
    emptyText: "Type to jump to any command, blocker, goal, run, escalation, timer, worktree, or task.",
  });

  constructor(
    private readonly deps: InspectorDeps,
    private readonly recentRefs: RecentRefsRing,
    private readonly extraActions: QuickActionItem[],
  ) {
    this.buildItems();
    this.list.startFilter();
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
  }

  private buildItems(): void {
    const snap = this.deps.store.state;
    const rows: Array<{
      id: string;
      searchText: string;
      badge: string;
      badgeTone: "danger" | "warn" | "accent" | "info" | "muted";
      title: string;
      detail: string;
      run: (ctx: ScreenContext) => void;
    }> = [];

    const seen = new Set<string>();
    const add = (row: (typeof rows)[number]) => {
      if (seen.has(row.id)) return;
      seen.add(row.id);
      rows.push(row);
    };

    // 1. Inbox blockers FIRST so urgent items are 1 keypress away
    for (const item of snap.inbox) {
      const ref: EntityRef = {
        kind: item.ref.kind,
        id: item.ref.id,
        runId: item.ref.runId,
        goalId: item.ref.goalId,
        label: item.ref.label ?? item.title,
      };
      add({
        id: `${ref.kind}:${ref.id}`,
        searchText: `inbox blocker ${item.severity} ${item.title} ${item.detail} ${ref.id}`,
        badge: item.severity,
        badgeTone: item.severity === "P0" ? "danger" : "warn",
        title: sanitizeLine(item.title).replace(/^\[P[0-2]\/[^\]]+\]\s*/i, ""),
        detail: firstLine(item.detail, 42),
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    // 2. Pinned Quick Commands right at the top (immediately visible on open!)
    const pinnedActs = this.extraActions.filter((a) => a.pinned !== false);
    const otherActs = this.extraActions.filter((a) => a.pinned === false);
    for (const act of pinnedActs) {
      add({
        id: `cmd:${act.id}`,
        searchText: `command ${act.id} ${act.label} ${act.detail}`,
        badge: "cmd",
        badgeTone: "accent",
        title: act.label,
        detail: act.detail,
        run: (ctx) => {
          ctx.navigator.pop();
          act.run(ctx);
        },
      });
    }

    // 3. Recent surfaced refs
    for (const ref of this.recentRefs.allNewestFirst()) {
      add({
        id: `${ref.kind}:${ref.id}`,
        searchText: `recent ${ref.kind} ${ref.id} ${ref.label}`,
        badge: ref.kind,
        badgeTone: "accent",
        title: sanitizeLine(ref.label),
        detail: ref.id,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    // 4. Goals
    for (const { goal } of snap.goals) {
      const ref: EntityRef = { kind: "goal", id: goal.id, runId: goal.linkedRunId ?? undefined, label: `${goal.id} ${goal.title}` };
      add({
        id: `goal:${goal.id}`,
        searchText: `goal ${goal.id} ${goal.status} ${goal.title}`,
        badge: "goal",
        badgeTone: "info",
        title: `${goal.id} ${sanitizeLine(goal.title)}`,
        detail: goal.status,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    // 5. Runs
    for (const entry of snap.runs) {
      const r = entry.run;
      const ref: EntityRef = { kind: "run", id: r.id, goalId: entry.goalId ?? undefined, label: r.id };
      add({
        id: `run:${r.id}`,
        searchText: `run ${r.id} ${r.status} ${entry.goalId ?? ""} ${r.goal}`,
        badge: "run",
        badgeTone: "info",
        title: `${r.id} ${firstLine(r.goal, 42)}`,
        detail: `${r.status} · ${entry.tasks.length}t`,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    // 6. Escalations
    for (const e of snap.escalations) {
      const ref: EntityRef = { kind: "escalation", id: e.id, runId: e.runId, label: `${e.id} ${e.title}` };
      add({
        id: `escalation:${e.id}`,
        searchText: `escalation ${e.id} ${e.severity} ${e.status} ${e.title} ${e.runId}`,
        badge: e.severity,
        badgeTone: e.status === "open" ? "danger" : e.status === "acked" ? "warn" : "muted",
        title: `${e.id} ${sanitizeLine(e.title)}`,
        detail: `${e.status} · ${e.runId}`,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    // 7. Timers
    for (const t of snap.timers) {
      const ref: EntityRef = { kind: "timer", id: t.id, runId: t.runId ?? undefined, label: `${t.id} ${t.reason}` };
      add({
        id: `timer:${t.id}`,
        searchText: `timer ${t.id} ${t.status} ${t.reason} ${t.ownerId}`,
        badge: "timer",
        badgeTone: t.status === "pending" ? "info" : "muted",
        title: `${t.id} ${firstLine(t.reason, 42)}`,
        detail: t.status === "pending" ? formatCountdown(t.wakeAt) : t.status,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    // 8. Worktrees & Merges
    for (const wt of snap.worktrees) {
      const key = wt.id ?? wt.path;
      const ref: EntityRef = { kind: "worktree", id: key, runId: wt.runId ?? undefined, label: `${wt.id ?? wt.branch} ${wt.branch}` };
      add({
        id: `worktree:${key}`,
        searchText: `worktree ${wt.id ?? ""} ${wt.branch} ${wt.status} ${wt.taskId ?? ""}`,
        badge: "wt",
        badgeTone: wt.orphaned ? "warn" : "muted",
        title: `${wt.id ?? "(untracked)"} ${middleEllipsis(wt.branch, 32)}`,
        detail: wt.status,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    for (const m of snap.merges) {
      const ref: EntityRef = { kind: "merge", id: m.id, runId: m.runId, label: `${m.id} ${m.branch}` };
      add({
        id: `merge:${m.id}`,
        searchText: `merge ${m.id} ${m.branch} ${m.status} ${m.runId} ${m.taskId}`,
        badge: "merge",
        badgeTone: m.status === "merged" ? "accent" : "warn",
        title: `${m.id} ${middleEllipsis(m.branch, 32)}`,
        detail: m.status,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    // 9. Tasks
    for (const entry of snap.runs) {
      for (const t of entry.tasks) {
        const ref: EntityRef = { kind: "task", id: t.id, runId: entry.run.id, goalId: entry.goalId ?? undefined, label: `${t.id} ${t.title}` };
        add({
          id: `task:${t.id}`,
          searchText: `task ${t.id} ${t.status} ${t.kind} ${t.title} ${entry.run.id}`,
          badge: `T${t.tier}`,
          badgeTone: "muted",
          title: `${t.id} ${sanitizeLine(t.title)}`,
          detail: `${t.status} · ${entry.run.id}`,
          run: (ctx) => {
            ctx.navigator.pop();
            openEntityInspector(ref, this.deps, ctx);
          },
        });
      }
    }

    for (const act of otherActs) {
      add({
        id: `cmd:${act.id}`,
        searchText: `command ${act.id} ${act.label} ${act.detail}`,
        badge: "cmd",
        badgeTone: "accent",
        title: act.label,
        detail: act.detail,
        run: (ctx) => {
          ctx.navigator.pop();
          act.run(ctx);
        },
      });
    }

    this.list.setTableItems(
      rows.map((r) => ({
        id: r.id,
        value: { run: r.run },
        searchText: r.searchText,
        cells: (sel, theme) => ({
          badge: tag(r.badge, r.badgeTone, theme),
          title: sel ? theme.accentBold(r.title) : theme.text(r.title),
          detail: theme.muted(r.detail),
        }),
      })),
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Go To Anything"],
      hints: [
        { key: "Enter", label: "open" },
        { key: "↑↓", label: "move" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) => this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (matchesKey(data, "escape")) {
      if (this.list.query) {
        this.list.clearFilter();
        this.list.startFilter();
        ctx.requestRender();
        return;
      }
      ctx.navigator.pop();
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      const sel = this.list.selectedItem();
      if (sel) sel.value.run(ctx);
      return;
    }
    if (res === "handled") ctx.requestRender();
  }
}

/* ─────────────────────────── Model & Effort Picker ────────────────────────── */

type ModelPickerTabId = "select" | "manage";
const MODEL_PICKER_TABS: readonly ModelPickerTabId[] = ["select", "manage"];

const MODEL_SELECT_COLUMNS: ColumnSpec[] = [
  { key: "rank", header: "#", width: 4, priority: 1 },
  { key: "model", header: "MODEL", minWidth: 18, priority: 0 },
  { key: "score", header: "SCORE", width: 13, priority: 1 },
  { key: "cost", header: "COST/TASK", width: 15, priority: 2 },
  { key: "time", header: "TIME", width: 6, align: "right", priority: 3 },
  { key: "route", header: "CLI / QUOTA", width: 18, priority: 0 },
];

const MODEL_MANAGE_COLUMNS: ColumnSpec[] = [
  { key: "on", header: "ON", width: 5, priority: 0 },
  { key: "model", header: "MODEL", minWidth: 18, priority: 0 },
  { key: "provider", header: "PROVIDER", width: 12, priority: 2 },
  { key: "route", header: "ROUTE", width: 16, priority: 1 },
  { key: "score", header: "SCORE", width: 7, align: "right", priority: 2 },
];

type ModelSelectRow =
  | { kind: "cli"; profile: RunnerProfileConfig }
  | { kind: "model"; entry: CompiledModelEntry };

function formatModelTimeSec(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  return formatDuration(seconds * 1000);
}

/**
 * Rich two-tab `/model` picker:
 *  - Tab 1 (`Select Model`): 6-column aligned table, per-CLI default rows (`model: null`),
 *    `r`/`Tab` route cycling across `alternateRoutes`, session model context banner,
 *    profile probe warning banner, pre-selected current model/profile/effort, and `e` effort cycle.
 *  - Tab 2 (`Enable/Disable Models`): full `ModelConfigOverlay` parity (`Space`/`Enter`, `x` All Off, `a` Enable All).
 */
export class ModelPickerScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Models";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private activeTab: ModelPickerTabId = "select";

  private readonly selectList = new TableListView<ModelSelectRow>({
    columns: MODEL_SELECT_COLUMNS,
    emptyText: "No enabled models. Switch to Tab 2 (→ or Ctrl+E) to enable models or press Ctrl+R to sync.",
  });
  private readonly manageList = new TableListView<CompiledModelEntry>({
    columns: MODEL_MANAGE_COLUMNS,
    emptyText: "No models discovered yet. Check ACP CLIs in /settings.",
  });

  private catalog: CompiledModelCatalog | null = null;
  private allModels: CompiledModelEntry[] = [];
  private config: HarnessConfig | null = null;
  private loading = true;
  private manageDirty = false;
  private routeIdxByModel = new Map<string, number>();
  private selectedEffort: string | null = null;

  constructor(
    private readonly client: DaemonClient,
    private readonly opts: {
      chatSessionId?: string;
      cwd: string;
      currentProfileId?: string;
      currentModel?: string | null;
      currentEffort?: string | null;
      initialTab?: ModelPickerTabId;
      onSelected: (sel: { profileId: string; model: string | null; effort: string | null }) => void;
    },
  ) {
    if (opts.initialTab) this.activeTab = opts.initialTab;
    this.selectedEffort = opts.currentEffort ?? null;
  }

  private resolveEffort(efforts: string[]): string | null {
    if (efforts.length === 0) return null;
    if (this.selectedEffort && efforts.includes(this.selectedEffort)) return this.selectedEffort;
    return efforts[0]!;
  }

  get currentTab(): ModelPickerTabId {
    return this.activeTab;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(false, ctx);
  }

  private allRoutes(m: CompiledModelEntry): ModelRoute[] {
    return [m.preferredRoute, ...(m.alternateRoutes ?? [])];
  }

  private activeRoute(m: CompiledModelEntry): { route: ModelRoute; idx: number; all: ModelRoute[] } {
    const all = this.allRoutes(m);
    const idx = Math.max(0, Math.min(this.routeIdxByModel.get(m.id) ?? 0, all.length - 1));
    return { route: all[idx]!, idx, all };
  }

  private async load(forceSync: boolean, ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      const [cfg, cat, fullCat] = await Promise.all([
        this.client.request<HarnessConfig>("config.get").catch(() => null),
        this.client.request<CompiledModelCatalog>(forceSync ? "models.sync" : "models.list", {
          cwd: this.opts.cwd,
          ...(this.opts.chatSessionId ? { chatSessionId: this.opts.chatSessionId } : {}),
        }),
        this.client
          .request<CompiledModelCatalog>("models.list", {
            cwd: this.opts.cwd,
            includeDisabled: true,
            ...(this.opts.chatSessionId ? { chatSessionId: this.opts.chatSessionId } : {}),
          })
          .catch(() => null),
      ]);
      if (cfg) this.config = cfg;
      this.catalog = cat;
      this.allModels = fullCat?.models ?? cat.models ?? [];
      this.manageDirty = false;
      this.rebuildSelect(true);
      this.rebuildManage();
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  private rebuildSelect(preselectCurrent = false): void {
    const enabledProfiles = (this.config?.profiles ?? []).filter((p) => p.enabled !== false);
    const statusById = new Map((this.catalog?.profileStatuses ?? []).map((st) => [st.profileId, st]));
    const models = this.catalog?.models ?? [];

    const cliRows = enabledProfiles.map((cli) => {
      const isCurrent = !this.opts.currentModel && cli.id === this.opts.currentProfileId;
      const st = statusById.get(cli.id);
      const stText = !st
        ? cli.billing
        : st.status === "ok"
          ? `${st.modelCount} models`
          : `err: ${firstLine(st.error, 14)}`;
      return {
        id: `cli:${cli.id}`,
        value: { kind: "cli" as const, profile: cli },
        searchText: `cli default ${cli.id} ${cli.billing}`,
        cells: (sel: boolean, theme: Theme) => ({
          rank: theme.dim("CLI"),
          model: `${isCurrent ? `${theme.ok("★")} ` : ""}${sel ? theme.accentBold(cli.id) : theme.bold(cli.id)} ${theme.muted("· CLI default")}`,
          score: theme.dim("auto"),
          cost: cli.billing === "subscription" ? theme.ok("$0 sub") : theme.muted(cli.billing),
          time: theme.dim("—"),
          route: st?.status === "error" ? theme.warn(stText) : theme.muted(stText),
        }),
      };
    });

    const modelRows = models.map((m) => {
      const { route, all } = this.activeRoute(m);
      const isCurrent =
        Boolean(this.opts.currentModel) &&
        (m.id === this.opts.currentModel || all.some((r) => r.wireModelId === this.opts.currentModel)) &&
        (!this.opts.currentProfileId || route.profileId === this.opts.currentProfileId);
      const rankStr = m.codingRank == null ? "—" : `#${m.codingRank}`;
      return {
        id: `model:${m.id}`,
        value: { kind: "model" as const, entry: m },
        searchText: `${m.id} ${m.name} ${all.map((r) => `${r.profileId} ${r.wireModelId}`).join(" ")} ${m.scoreSource ?? ""}`,
        cells: (sel: boolean, theme: Theme) => {
          const scoreStr =
            m.codingScore != null
              ? `${theme.ok(m.codingScore.toFixed(1))} ${theme.dim(m.scoreSource ?? "")}`
              : theme.dim("unscored");
          const costStr =
            route.billing === "subscription"
              ? `${theme.ok("$0 sub")}${m.apiEquivCostUsd != null ? ` ${theme.dim(`(${formatUsd(m.apiEquivCostUsd)})`)}` : ""}`
              : `${formatUsd(m.costPerTaskUsd)}/task`;
          const extra = all.length > 1 ? theme.accent(` +${all.length - 1}`) : "";
          const cliShort = route.profileId.replace(/^acp:/, "");
          let routeStr: string;
          if (m.quota && route.profileId === m.preferredRoute.profileId) {
            routeStr = m.quota.exhausted
              ? tag("EXHAUSTED", "danger", theme)
              : `${cliShort} ${Math.round((m.quota.effectiveRemainingRatio ?? 1) * 100)}%${extra}`;
          } else {
            routeStr = `${cliShort}${extra}`;
          }
          return {
            rank: sel ? theme.accentBold(rankStr) : theme.dim(rankStr),
            model: `${isCurrent ? `${theme.ok("★")} ` : ""}${sel ? theme.accentBold(m.id) : theme.text(m.id)}`,
            score: scoreStr,
            cost: costStr,
            time: theme.muted(formatModelTimeSec(m.timePerTaskSeconds)),
            route: sel ? theme.text(routeStr) : theme.muted(routeStr),
          };
        },
      };
    });

    let preselectId: string | undefined;
    if (preselectCurrent) {
      if (!this.opts.currentModel && this.opts.currentProfileId) {
        preselectId = `cli:${this.opts.currentProfileId}`;
      } else if (this.opts.currentModel) {
        const match = models.find(
          (m) => m.id === this.opts.currentModel || this.allRoutes(m).some((r) => r.wireModelId === this.opts.currentModel),
        );
        if (match) {
          preselectId = `model:${match.id}`;
          if (this.opts.currentProfileId) {
            const rIdx = this.allRoutes(match).findIndex((r) => r.profileId === this.opts.currentProfileId);
            if (rIdx >= 0) this.routeIdxByModel.set(match.id, rIdx);
          }
          if (this.opts.currentEffort) {
            this.selectedEffort = this.opts.currentEffort;
          }
        }
      }
    }

    this.selectList.setTableItems([...cliRows, ...modelRows], preselectId);
  }

  private isModelEnabled(modelId: string): boolean {
    return isModelEnabledInCatalog(modelId, this.config?.catalog);
  }

  private rebuildManage(): void {
    this.manageList.setTableItems(
      this.allModels.map((m) => {
        const on = this.isModelEnabled(m.id);
        const provider = m.id.includes("/") ? m.id.split("/")[0]! : m.preferredRoute.profileId;
        const routes = this.allRoutes(m)
          .map((r) => r.profileId.replace(/^acp:/, ""))
          .join(",");
        return {
          id: m.id,
          value: m,
          searchText: `${m.id} ${provider} ${routes} ${on ? "enabled on" : "disabled off"}`,
          cells: (sel, theme) => ({
            on: on ? theme.ok(`[${theme.glyphs.check}]`) : theme.dim("[ ]"),
            model: sel ? theme.accentBold(m.id) : on ? theme.text(m.id) : theme.dim(m.id),
            provider: theme.muted(provider),
            route: theme.dim(routes),
            score: m.codingScore != null ? theme.ok(m.codingScore.toFixed(1)) : theme.dim("—"),
          }),
        };
      }),
    );
  }

  private cycleSelectedRoute(delta: 1 | -1, ctx: ScreenContext): boolean {
    const sel = this.selectList.selectedItem()?.value;
    if (!sel || sel.kind !== "model") return false;
    const all = this.allRoutes(sel.entry);
    if (all.length <= 1) return false;
    const prev = this.routeIdxByModel.get(sel.entry.id) ?? 0;
    const next = (prev + delta + all.length) % all.length;
    this.routeIdxByModel.set(sel.entry.id, next);
    this.rebuildSelect(false);
    this.frame.setNotice(`Route for ${sel.entry.id} → ${all[next]!.profileId}`, "info");
    ctx.requestRender();
    return true;
  }

  private filterSaveSeq = 0;

  private saveModelFilter(
    patch: { modelFilterMode: "all" | "allowlist"; enabledModels: string[]; disabledModels: string[] },
    note: string,
    ctx: ScreenContext,
  ): void {
    if (!this.config) return;
    const seq = ++this.filterSaveSeq;
    const nextCatalog = { ...this.config.catalog, ...patch };
    this.config = { ...this.config, catalog: nextCatalog };
    this.manageDirty = true;
    this.rebuildManage();
    this.frame.setNotice(note, "info");
    ctx.requestRender();
    void this.client
      .request<HarnessConfig>("config.update", { patch: { catalog: nextCatalog } })
      .then((nextCfg) => {
        if (seq !== this.filterSaveSeq) return;
        this.config = nextCfg;
        this.rebuildManage();
        ctx.requestRender();
      })
      .catch((err) => {
        if (seq !== this.filterSaveSeq) return;
        this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
        ctx.requestRender();
      });
  }

  private toggleModel(modelId: string, ctx: ScreenContext): void {
    if (!this.config) return;
    const mode = this.config.catalog?.modelFilterMode ?? "all";
    const norm = modelId.toLowerCase();
    if (mode === "allowlist") {
      const prev = this.config.catalog?.enabledModels ?? [];
      const exists = prev.some((id) => id.toLowerCase() === norm);
      const enabledModels = exists ? prev.filter((id) => id.toLowerCase() !== norm) : [...prev, modelId];
      this.saveModelFilter(
        { modelFilterMode: "allowlist", enabledModels, disabledModels: [] },
        `${exists ? "Disabled" : "Enabled"} ${modelId} (${enabledModels.length} enabled)`,
        ctx,
      );
    } else {
      const prev = this.config.catalog?.disabledModels ?? [];
      const isDisabled = prev.some((id) => id.toLowerCase() === norm);
      const disabledModels = isDisabled ? prev.filter((id) => id.toLowerCase() !== norm) : [...prev, modelId];
      this.saveModelFilter(
        { modelFilterMode: "all", disabledModels, enabledModels: [] },
        `${isDisabled ? "Enabled" : "Disabled"} ${modelId}`,
        ctx,
      );
    }
  }

  private setTab(next: ModelPickerTabId, ctx: ScreenContext): void {
    this.activeTab = next;
    if (next === "select" && this.manageDirty) {
      void this.load(false, ctx);
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const enabledCount = this.allModels.filter((m) => this.isModelEnabled(m.id)).length;
    const tabs: FrameTab[] = [
      { id: "select", label: "Select Model", count: this.catalog?.models.length },
      { id: "manage", label: "Enable/Disable Models", count: enabledCount },
    ];

    const sel = this.selectList.selectedItem()?.value;
    let subtitle: string;
    if (this.activeTab === "manage") {
      subtitle = `${enabledCount}/${this.allModels.length} models enabled · Space/Enter toggle · x All Off · a Enable All`;
    } else if (sel?.kind === "cli") {
      subtitle = `CLI Default: ${sel.profile.id} (uses CLI's own default model; no model pinned)`;
    } else if (sel?.kind === "model") {
      const { route, all } = this.activeRoute(sel.entry);
      const efforts = route.supportedEfforts ?? sel.entry.efforts ?? [];
      const chosenEffort = this.resolveEffort(efforts);
      const routeHint = all.length > 1 ? ` · routes [${all.map((r) => r.profileId).join(" | ")}] (r/Tab)` : "";
      subtitle = `${route.profileId} / ${route.wireModelId}${chosenEffort ? ` · effort: ${chosenEffort} (e)` : ""}${routeHint}`;
    } else {
      subtitle = `Current: ${this.opts.currentProfileId ?? "auto"} / ${this.opts.currentModel ?? "CLI default"}${this.opts.currentEffort ? ` (${this.opts.currentEffort})` : ""}`;
    }

    const hints: Hint[] =
      this.activeTab === "select"
        ? [
            { key: "Enter", label: "apply" },
            { key: "r/Tab", label: "route" },
            { key: "e", label: "effort" },
            { key: "/", label: "filter" },
            { key: "←→/Ctrl+E", label: "enable/disable" },
            { key: "Ctrl+R", label: "sync" },
            { key: "Esc", label: "close" },
          ]
        : [
            { key: "Space/Enter", label: "toggle" },
            { key: "x", label: "all off" },
            { key: "a", label: "enable all" },
            { key: "/", label: "filter" },
            { key: "←→", label: "select model" },
            { key: "Esc", label: "close" },
          ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Models"],
      rightHeader: this.loading ? theme.accent("syncing...") : theme.muted(`${this.catalog?.models.length ?? 0} models`),
      subtitle,
      tabs,
      activeTabId: this.activeTab,
      hints,
      renderBody: (innerW, bodyH) => {
        if (this.loading && !this.catalog) return [theme.muted("Loading model catalog...")];

        const out: string[] = [];
        let listH = bodyH;

        if (this.activeTab === "select") {
          // Session model context banner
          const sessionCtx = this.catalog?.sessionModelContext?.trim();
          if (sessionCtx && listH >= 4) {
            const banner = fillLineBg(
              `${theme.accentBold(`${theme.glyphs.diamond} Session context:`)} ${sanitizeLine(sessionCtx)}`,
              innerW,
              theme.badgeBg,
            );
            out.push(banner);
            listH = Math.max(1, listH - 1);
          }

          // Profile probe warning banner
          const failedProbes = (this.catalog?.profileStatuses ?? []).filter((s) => s.status === "error");
          if (failedProbes.length > 0 && listH >= 4) {
            const fp = failedProbes[0]!;
            const more = failedProbes.length > 1 ? ` (+${failedProbes.length - 1} more)` : "";
            out.push(
              clamp(
                theme.warn(`${theme.glyphs.warn} ${fp.profileId}: ${sanitizeLine(fp.error ?? "probe failed")}${more}`),
                innerW,
              ),
            );
            listH = Math.max(1, listH - 1);
          }

          out.push(...this.selectList.render(innerW, listH, theme));
          return out;
        }

        const isAllowlistEmpty =
          this.config?.catalog?.modelFilterMode === "allowlist" &&
          (this.config.catalog.enabledModels?.length ?? 0) === 0;
        if (isAllowlistEmpty && listH >= 3) {
          out.push(
            clamp(
              theme.warn(`${theme.glyphs.warn} 0 models enabled — press Space/Enter on models to enable or 'a' to enable all.`),
              innerW,
            ),
          );
          listH = Math.max(1, listH - 1);
        }
        out.push(...this.manageList.render(innerW, listH, theme));
        return out;
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    const activeList = this.activeTab === "select" ? this.selectList : this.manageList;
    if (activeList.isFiltering) {
      const res = activeList.handleInput(data);
      if (res === "select") {
        if (this.activeTab === "select") this.applySelection(ctx);
        else {
          const m = this.manageList.selectedItem()?.value;
          if (m) this.toggleModel(m.id, ctx);
        }
        return;
      }
      ctx.requestRender();
      return;
    }

    if (matchesKey(data, "escape") && activeList.handleEscape()) {
      ctx.requestRender();
      return;
    }

    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }

    // Ctrl+E toggles directly between Select Model and Enable/Disable Models
    if (matchesKey(data, "ctrl+e")) {
      this.setTab(this.activeTab === "select" ? "manage" : "select", ctx);
      ctx.requestRender();
      return;
    }

    // Left / Right and 1 / 2 always switch tabs cleanly
    if (
      handleTabKeys(data, MODEL_PICKER_TABS, this.activeTab, (next) => this.setTab(next, ctx), {
        allowTab: false,
      })
    ) {
      ctx.requestRender();
      return;
    }

    if (this.activeTab === "select") {
      // Tab / Shift+Tab / r cycles alternateRoutes when current model has multiple routes
      if (data === "r" || matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        const delta: 1 | -1 = matchesKey(data, "shift+tab") ? -1 : 1;
        if (this.cycleSelectedRoute(delta, ctx)) return;
        if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
          this.setTab("manage", ctx);
          ctx.requestRender();
          return;
        }
      }
      if (matchesKey(data, "ctrl+r") || data === "S") {
        void this.load(true, ctx);
        return;
      }
      if (data === "e") {
        const sel = this.selectList.selectedItem()?.value;
        if (sel?.kind === "model") {
          const { route } = this.activeRoute(sel.entry);
          const efforts = route.supportedEfforts ?? sel.entry.efforts ?? [];
          if (efforts.length > 0) {
            const cur = this.resolveEffort(efforts);
            const idx = cur ? efforts.indexOf(cur) : -1;
            this.selectedEffort = efforts[(idx + 1) % efforts.length]!;
          }
        }
        ctx.requestRender();
        return;
      }
      const res = this.selectList.handleInput(data);
      if (res === "select") {
        this.applySelection(ctx);
        return;
      }
      if (res === "handled") ctx.requestRender();
      return;
    }

    // Tab 2: Enable / Disable Models
    if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.setTab("select", ctx);
      ctx.requestRender();
      return;
    }
    if (matchesKey(data, "space")) {
      const m = this.manageList.selectedItem()?.value;
      if (m) this.toggleModel(m.id, ctx);
      return;
    }
    if (data === "x" || data === "X" || matchesKey(data, "ctrl+x")) {
      this.saveModelFilter(
        { modelFilterMode: "allowlist", enabledModels: [], disabledModels: [] },
        "All models turned OFF — press Space/Enter to enable models or 'a' to enable all.",
        ctx,
      );
      return;
    }
    if (data === "a" || data === "A" || matchesKey(data, "ctrl+a")) {
      this.saveModelFilter(
        { modelFilterMode: "all", enabledModels: [], disabledModels: [] },
        "All ranked models enabled.",
        ctx,
      );
      return;
    }
    if (matchesKey(data, "ctrl+r")) {
      void this.load(true, ctx);
      return;
    }

    const res = this.manageList.handleInput(data);
    if (res === "select") {
      const m = this.manageList.selectedItem()?.value;
      if (m) this.toggleModel(m.id, ctx);
      return;
    }
    if (res === "handled") ctx.requestRender();
  }

  private applySelection(ctx: ScreenContext): void {
    const sel = this.selectList.selectedItem()?.value;
    if (!sel) return;
    if (sel.kind === "cli") {
      this.opts.onSelected({
        profileId: sel.profile.id,
        model: null,
        effort: null,
      });
      ctx.navigator.pop();
      return;
    }
    const { route } = this.activeRoute(sel.entry);
    const efforts = route.supportedEfforts ?? sel.entry.efforts ?? [];
    const effort = this.resolveEffort(efforts);
    this.opts.onSelected({
      profileId: route.profileId,
      model: route.wireModelId,
      effort,
    });
    ctx.navigator.pop();
  }
}

/* ──────────────────────────── Effort Picker (/effort) ─────────────────────── */

const EFFORT_DESCRIPTIONS: Record<string, string> = {
  off: "Disable extended reasoning (fastest)",
  minimal: "Lightest reasoning pass",
  low: "Fast & low token spend — scouts & quick Q&A",
  medium: "Balanced speed & coding depth",
  high: "Deep reasoning — recommended for Workers & planning",
  xhigh: "Extra-high reasoning budget for tough refactors",
  max: "Maximum reasoning depth — frontier architecture & hard bugs",
  ultra: "Ultra reasoning depth — hardest multi-file synthesis & debugging",
};

/**
 * Dedicated Reasoning Effort Picker (`/effort`):
 * Updates effort independently of model/profile (works cleanly even on CLI-default sessions where `model === null`).
 */
export class EffortPickerScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Effort";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<{ value: string; description: string }>({
    columns: [
      { key: "effort", header: "EFFORT", width: 12, priority: 0 },
      { key: "desc", header: "DESCRIPTION", minWidth: 18, priority: 1 },
    ],
  });

  constructor(
    private readonly opts: {
      efforts?: string[];
      currentEffort?: string | null;
      modelLabel?: string;
      onSelected: (effort: string) => void;
    },
  ) {
    const raw = opts.efforts ?? [];
    const choices =
      raw.length > 0 && !(raw.length === 1 && raw[0] === "default")
        ? raw
        : ["low", "medium", "high", "xhigh", "max"];
    this.list.setTableItems(
      choices.map((val) => {
        const desc = EFFORT_DESCRIPTIONS[val] ?? "Model reasoning effort level";
        const isCurrent = val === opts.currentEffort;
        return {
          id: val,
          value: { value: val, description: desc },
          searchText: `${val} ${desc}`,
          cells: (sel, theme) => ({
            effort: `${isCurrent ? `${theme.ok("★")} ` : ""}${sel ? theme.accentBold(val) : theme.bold(val)}`,
            desc: sel ? theme.text(desc) : theme.muted(desc),
          }),
        };
      }),
      opts.currentEffort ?? undefined,
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
      breadcrumbs: this.nav?.breadcrumbs ?? ["Reasoning Effort"],
      subtitle: this.opts.modelLabel ? `Session: ${this.opts.modelLabel}` : undefined,
      hints: [
        { key: "Enter", label: "apply" },
        { key: "Esc", label: "cancel" },
      ],
      renderBody: (innerW, bodyH) => this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") {
        const sel = this.list.selectedItem()?.value;
        if (sel) {
          this.opts.onSelected(sel.value);
          ctx.navigator.pop();
        }
        return;
      }
      ctx.requestRender();
      return;
    }
    if (isPopKey(data, ctx)) {
      if (this.list.query) {
        this.list.clearFilter();
        ctx.requestRender();
        return;
      }
      ctx.navigator.pop();
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      const sel = this.list.selectedItem()?.value;
      if (sel) {
        this.opts.onSelected(sel.value);
        ctx.navigator.pop();
      }
      return;
    }
    if (res === "handled") ctx.requestRender();
  }
}

/* ─────────────────────────── Quota & Cost Viewer ──────────────────────────── */

interface QuotaWindowProtoJson {
  windowId?: string;
  label?: string;
  remainingRatio?: number;
  usedPercent?: number;
  resetAt?: string;
}

interface QuotaBucketProtoJson {
  bucketId?: string;
  displayName?: string;
  provider?: string;
  windows?: QuotaWindowProtoJson[];
}

interface QuotaModelProtoJson {
  modelId?: string;
  profile?: string;
  provider?: string;
  availability?: string | number;
  exhausted?: boolean;
  effectiveRemainingRatio?: number;
  nextAvailableAt?: string;
  bucketBindings?: Array<{ bucketId?: string; multiplier?: number }>;
}

interface ProfileQuotaCoverage {
  profileId: string;
  adapter: string;
  hasData: boolean;
  source: string;
  note: string;
}

interface QuotaResponse {
  snapshot?: {
    generatedAt?: string;
    metadata?: Record<string, string>;
    buckets?: QuotaBucketProtoJson[];
    models?: QuotaModelProtoJson[];
  } | null;
  configured?: boolean;
  coverage?: ProfileQuotaCoverage[];
}

function formatMoney(currency: string, amount: number): string {
  return currency.toUpperCase() === "USD" ? formatUsd(amount) : `${amount.toFixed(4)} ${currency}`;
}

function availabilityLabel(m: QuotaModelProtoJson): string {
  if (m.exhausted) return "exhausted";
  if (typeof m.availability === "string" && m.availability) {
    return m.availability.replace(/^AVAILABILITY_/, "").toLowerCase();
  }
  return "available";
}

export class QuotaCostScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Quota & Cost";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();
  private quota: QuotaResponse | null = null;
  private cost: CostSnapshot | null = null;
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly scope?: { chatSessionId?: string; runId?: string; repoRoot?: string },
  ) {}

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(false, ctx);
  }

  private async load(forceSync: boolean, ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      this.quota = await this.client.request<QuotaResponse>(forceSync ? "quota.sync" : "quota.get");
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    }
    try {
      this.cost = await this.client.request<CostSnapshot>("cost.get", {
        ...(this.scope?.chatSessionId ? { chatSessionId: this.scope.chatSessionId } : {}),
        ...(this.scope?.runId ? { runId: this.scope.runId } : {}),
      });
    } catch {
      this.cost = null;
    }
    this.loading = false;
    ctx.requestRender();
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Quota & Cost"],
      rightHeader: this.loading ? theme.accent("syncing...") : this.viewport.statusText() ? theme.muted(this.viewport.statusText()) : undefined,
      hints: [
        { key: "r", label: "sync now" },
        { key: "↑↓/PgUp/PgDn/wheel", label: "scroll" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) => {
        if (this.loading && !this.quota && !this.cost) return [theme.muted("Loading quota & spend...")];
        const lines: string[] = [];

        // 1. Quota Capacity (REAL ProtoJSON buckets[].windows[], models[], and coverage[])
        lines.push(divider(innerW, theme, "Quota Capacity"));
        lines.push(
          kvRow(
            "Quota Source",
            this.quota?.configured
              ? theme.ok("External Quota Endpoint configured")
              : theme.muted("Local / passive ACP harvest (configure URL in /settings)"),
            innerW,
            theme,
          ),
        );

        const snap = this.quota?.snapshot;
        if (snap?.generatedAt) {
          const src = snap.metadata?.source ? ` · ${snap.metadata.source}` : "";
          lines.push(kvRow("Snapshot", theme.dim(`${snap.generatedAt}${src}`), innerW, theme));
        }

        const bucketRows: Array<Record<string, string>> = [];
        for (const b of snap?.buckets ?? []) {
          const wins = b.windows ?? [];
          for (let i = 0; i < wins.length; i++) {
            const w = wins[i]!;
            const ratio =
              typeof w.remainingRatio === "number"
                ? w.remainingRatio
                : typeof w.usedPercent === "number"
                  ? Math.max(0, 1 - w.usedPercent / 100)
                  : null;
            bucketRows.push({
              bucket: i === 0 ? theme.accent(sanitizeLine(b.displayName || b.bucketId || "bucket")) : "",
              window: theme.text(sanitizeLine(w.label || w.windowId || "window")),
              capacity: renderProgressBar(ratio, theme, { barWidth: 10 }),
              reset: theme.muted(formatCountdown(w.resetAt)),
            });
          }
        }

        if (bucketRows.length > 0) {
          lines.push("");
          lines.push(
            ...layoutColumns(
              [
                { key: "bucket", header: "BUCKET", minWidth: 14, priority: 0 },
                { key: "window", header: "WINDOW", width: 14, priority: 1 },
                { key: "capacity", header: "CAPACITY", width: 16, priority: 0 },
                { key: "reset", header: "RESET", width: 14, align: "right", priority: 2 },
              ],
              bucketRows,
              innerW,
              { headerStyle: (s) => theme.dim(theme.bold(s)), sepStyle: theme.border, sepChar: theme.glyphs.barH },
            ),
          );
        }

        const models = snap?.models ?? [];
        if (models.length > 0) {
          lines.push("");
          const modelRows = models.slice(0, 14).map((m) => {
            const state = availabilityLabel(m);
            const pct =
              typeof m.effectiveRemainingRatio === "number"
                ? `${Math.round(m.effectiveRemainingRatio * 100)}%`
                : "—";
            const reset = m.nextAvailableAt ? formatCountdown(m.nextAvailableAt) : "—";
            return {
              model: theme.bold(sanitizeLine(m.modelId || "*")),
              profile: theme.muted(sanitizeLine(m.profile || m.provider || "default")),
              state: statusBadge(state, theme),
              left: theme.muted(pct),
              next: theme.dim(reset),
            };
          });
          lines.push(
            ...layoutColumns(
              [
                { key: "model", header: "MODEL", minWidth: 16, priority: 0 },
                { key: "profile", header: "PROFILE", width: 14, priority: 1 },
                { key: "state", header: "STATE", width: 13, priority: 0 },
                { key: "left", header: "LEFT", width: 6, align: "right", priority: 2 },
                { key: "next", header: "NEXT AVAIL", width: 12, align: "right", priority: 3 },
              ],
              modelRows,
              innerW,
              { headerStyle: (s) => theme.dim(theme.bold(s)), sepStyle: theme.border, sepChar: theme.glyphs.barH },
            ),
          );
        }

        if (bucketRows.length === 0 && models.length === 0) {
          lines.push(theme.muted("  No quota windows harvested yet. Run a turn or press 'r' to sync."));
        }

        const coverage = Array.isArray(this.quota?.coverage) ? this.quota!.coverage : [];
        if (coverage.length > 0) {
          lines.push("", theme.dim("Profile telemetry coverage:"));
          for (const c of coverage) {
            const dot = c.hasData ? theme.ok(theme.glyphs.running) : theme.dim(theme.glyphs.pending);
            lines.push(
              clamp(`  ${dot} ${theme.bold(sanitizeLine(c.profileId))} ${theme.muted(`— ${sanitizeLine(c.note)}`)}`, innerW),
            );
          }
        }

        // 2. Reported Spend Ledger (cost.get)
        lines.push("", divider(innerW, theme, `Reported Spend${this.cost?.scope ? ` (${sanitizeLine(this.cost.scope.label)})` : ""}`));
        if (!this.cost) {
          lines.push(theme.muted("  Spend ledger unavailable for this scope."));
        } else if (!this.cost.available) {
          lines.push(theme.muted("  No non-subscription API/local charges recorded in this scope."));
        } else {
          const totalsStr =
            (this.cost.totals ?? []).length > 0
              ? this.cost.totals!.map((t) => formatMoney(t.currency, t.amount)).join(" · ")
              : "none reported yet";
          lines.push(kvRow("Total Spend", theme.bold(totalsStr), innerW, theme));
          lines.push(
            kvRow(
              "Coverage",
              this.cost.coverage?.complete ? theme.ok("complete") : theme.warn("partial / in-progress"),
              innerW,
              theme,
            ),
          );
          if ((this.cost.byModel ?? []).length > 0) {
            lines.push("");
            lines.push(
              ...layoutColumns(
                [
                  { key: "model", header: "MODEL", minWidth: 16, priority: 0 },
                  { key: "spend", header: "SPEND", width: 14, align: "right", priority: 0 },
                ],
                this.cost.byModel.slice(0, 14).map((row) => ({
                  model: theme.text(sanitizeLine(row.model ?? "(unattributed)")),
                  spend: theme.bold(formatMoney(row.currency, row.amount)),
                })),
                innerW,
                { headerStyle: (s) => theme.dim(theme.bold(s)), sepStyle: theme.border, sepChar: theme.glyphs.barH },
              ),
            );
          }
          if ((this.cost.coverage?.routes ?? []).length > 0) {
            lines.push("");
            for (const route of this.cost.coverage.routes) {
              lines.push(
                splitRow(
                  `  ${statusBadge(route.status, theme)} ${route.profileId} (${route.invocations} inv${route.running > 0 ? `, ${route.running} running` : ""})`,
                  theme.muted(route.note),
                  innerW,
                ),
              );
            }
          }
        }

        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    const wheel = parseMouseWheel(data);
    if (wheel.hadMouse) {
      if (wheel.delta !== 0) {
        this.viewport.scrollBy(wheel.delta);
        ctx.requestRender();
      }
      return;
    }
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (data === "r") {
      void this.load(true, ctx);
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.viewport.scrollBy(-1);
      ctx.requestRender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.viewport.scrollBy(1);
      ctx.requestRender();
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) {
      this.viewport.pageUp();
      ctx.requestRender();
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) {
      this.viewport.pageDown();
      ctx.requestRender();
    } else if (matchesKey(data, "home") || data === "g") {
      this.viewport.scrollToTop();
      ctx.requestRender();
    } else if (matchesKey(data, "end") || data === "G") {
      this.viewport.scrollToBottom();
      ctx.requestRender();
    }
  }
}

/* ──────────────────────────────── KB Browser ──────────────────────────────── */

const KB_COLUMNS: ColumnSpec[] = [
  { key: "status", header: "STATUS", width: 12, priority: 0 },
  { key: "kind", header: "KIND", width: 12, priority: 1 },
  { key: "id", header: "ID", width: 12, priority: 0 },
  { key: "title", header: "TITLE", minWidth: 18, priority: 0 },
  { key: "tags", header: "TAGS", width: 16, priority: 2 },
  { key: "hits", header: "HITS", width: 5, align: "right", priority: 3 },
];

export class KbBrowserScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Knowledge Base";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<KbCard>({
    columns: KB_COLUMNS,
    emptyText: "No KB entries found for this repo.",
  });
  private includeCandidates = true;
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly repoRoot: string,
    private readonly initialQuery?: string,
  ) {
    if (initialQuery?.trim()) {
      this.list.setInitialFilter(initialQuery.trim(), false);
    }
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      const cards = await this.client.request<KbCard[]>("kb.search", {
        repoRoot: this.repoRoot,
        includeCandidates: this.includeCandidates,
        includeStale: true,
        limit: 80,
      });
      this.list.setTableItems(
        (cards ?? []).map((c) => ({
          id: c.id,
          value: c,
          searchText: `${c.id} ${c.kind} ${c.status} ${c.title} ${c.summary ?? ""} ${(c.tags ?? []).join(" ")}`,
          cells: (sel, theme) => ({
            status: statusBadge(c.status, theme),
            kind: tag(c.kind, "info", theme),
            id: sel ? theme.accentBold(c.id) : theme.bold(c.id),
            title: sel ? theme.text(sanitizeLine(c.title)) : sanitizeLine(c.title),
            tags: theme.muted((c.tags ?? []).slice(0, 3).join(", ") || "—"),
            hits: theme.dim(String(c.hitCount ?? 0)),
          }),
        })),
      );
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Knowledge Base"],
      rightHeader: this.loading ? theme.accent("loading...") : theme.muted(`${this.list.items.length}/${this.list.totalCount} entries`),
      hints: [
        { key: "Enter", label: "read" },
        { key: "/", label: "filter" },
        { key: "c", label: this.includeCandidates ? "hide candidates" : "show candidates" },
        { key: "r", label: "refresh" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) =>
        this.loading && this.list.totalCount === 0
          ? [theme.muted("Loading KB entries...")]
          : this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") this.openSelected(ctx);
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
    if (data === "c") {
      this.includeCandidates = !this.includeCandidates;
      void this.load(ctx);
      return;
    }
    if (data === "r") {
      void this.load(ctx);
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      this.openSelected(ctx);
      return;
    }
    if (res === "handled") ctx.requestRender();
  }

  private openSelected(ctx: ScreenContext): void {
    const sel = this.list.selectedItem()?.value;
    if (!sel) return;
    ctx.navigator.push(new KbDetailScreen(this.client, sel));
  }
}

export class KbDetailScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly viewport = new Viewport();
  private entry: KbEntry | null = null;
  private loading = true;
  private error: string | null = null;

  constructor(
    private readonly client: DaemonClient,
    private readonly card: KbCard,
  ) {
    this.title = card.id;
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
      const entries = await this.client.request<KbEntry[]>("kb.get", { ids: [this.card.id] });
      this.entry = entries?.[0] ?? null;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const item = this.entry ?? this.card;
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Knowledge Base", this.card.id],
      rightHeader: statusBadge(item.status, theme),
      subtitle: sanitizeLine(item.title),
      hints: [
        { key: "↑↓/PgUp/PgDn/wheel", label: "scroll" },
        { key: "Esc", label: "back" },
      ],
      renderBody: (innerW, bodyH) => {
        const lines: string[] = [
          kvRow("ID", item.id, innerW, theme),
          kvRow("Kind", item.kind, innerW, theme),
          kvRow("Status", `${statusBadge(item.status, theme)} (${item.confidence})`, innerW, theme),
          kvRow("Tags", (item.tags ?? []).join(", ") || "—", innerW, theme),
          kvRow("Path Globs", (item.pathGlobs ?? []).join(", ") || "—", innerW, theme),
          kvRow("Hits", String(item.hitCount ?? 0), innerW, theme),
          ...(item.verifiedSha ? [kvRow("Verified SHA", item.verifiedSha, innerW, theme)] : []),
          ...(this.entry?.updatedAt ? [kvRow("Updated", formatAge(this.entry.updatedAt), innerW, theme)] : []),
        ];
        if (this.entry?.evidencePaths && this.entry.evidencePaths.length > 0) {
          lines.push("", divider(innerW, theme, "Evidence Paths"));
          for (const p of this.entry.evidencePaths) lines.push(clamp(`  - ${sanitizeLine(p)}`, innerW));
        }
        lines.push("", divider(innerW, theme, "Context"));
        if (this.loading && !this.entry) {
          lines.push(theme.muted("Loading full entry via kb.get..."));
        } else if (this.error && !this.entry) {
          lines.push(theme.danger(`Failed to load full entry: ${this.error}`));
          if (this.card.summary) lines.push(...wrap(sanitizeText(this.card.summary), innerW));
        } else {
          lines.push(...wrap(sanitizeText(this.entry?.contextMd || this.card.summary || "(empty)"), innerW));
        }
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    const wheel = parseMouseWheel(data);
    if (wheel.hadMouse) {
      if (wheel.delta !== 0) {
        this.viewport.scrollBy(wheel.delta);
        ctx.requestRender();
      }
      return;
    }
    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }
    if (matchesKey(data, "up") || data === "k") this.viewport.scrollBy(-1);
    else if (matchesKey(data, "down") || data === "j") this.viewport.scrollBy(1);
    else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) this.viewport.pageUp();
    else if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) this.viewport.pageDown();
    else if (matchesKey(data, "home") || data === "g") this.viewport.scrollToTop();
    else if (matchesKey(data, "end") || data === "G") this.viewport.scrollToBottom();
    else return;
    ctx.requestRender();
  }
}

/* ──────────────────────────── Session Switcher ────────────────────────────── */

const SESSION_COLUMNS: ColumnSpec[] = [
  { key: "session", header: "SESSION", width: 18, priority: 0 },
  { key: "type", header: "TYPE", width: 6, priority: 1 },
  { key: "state", header: "STATE", width: 22, priority: 0 },
  { key: "detail", header: "MODEL / WORKSPACE", minWidth: 16, priority: 1 },
];

export class SessionSwitcherScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Sessions";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<AttachableSession>({
    columns: SESSION_COLUMNS,
    emptyText: "No sessions found. Press 'n' to start a new Director chat.",
  });
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly currentId: string,
    private readonly onPick: (session: AttachableSession) => void,
    private readonly onCreateNew?: () => void,
  ) {}

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      const sessions = await this.client.request<AttachableSession[]>("sessions.list");
      const list = sessions ?? [];
      const firstOther = list.find((s) => !(s.attachedByMe || s.id === this.currentId));
      this.list.setTableItems(
        list.map((s) => {
          const isMe = Boolean(s.attachedByMe) || s.id === this.currentId;
          const projLabel = s.projectName || (s.repoRoot ? s.repoRoot.split("/").filter(Boolean).pop() ?? s.repoRoot : "");
          const modelStr = s.model ? `${s.model}${s.effort ? ` (${s.effort})` : ""}` : s.profileId ?? "";
          const detailParts = [projLabel ? `[${projLabel}]` : "", firstLine(s.title, 22), modelStr].filter(Boolean);
          return {
            id: `${s.kind}:${s.id}`,
            value: s,
            searchText: `${s.kind} ${s.id} ${s.title} ${s.status} ${s.repoRoot} ${s.model ?? ""}`,
            cells: (sel, theme) => {
              const star = isMe ? `${theme.ok("★")} ` : "";
              const att = isMe
                ? tag("YOU", "ok", theme)
                : s.attached
                  ? tag("OTHER", "warn", theme)
                  : "";
              const st = s.running ? statusBadge("running", theme, s.status) : theme.muted(s.status);
              return {
                session: `${star}${sel ? theme.accentBold(s.id) : theme.bold(s.id)}`,
                type: s.kind === "chat" ? theme.info("CHAT") : theme.accent("RUN"),
                state: att ? `${att} ${st}` : st,
                detail: theme.muted(detailParts.join(" · ")),
              };
            },
          };
        }),
        firstOther ? `${firstOther.kind}:${firstOther.id}` : undefined,
      );
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Switch Session"],
      rightHeader: this.loading ? theme.accent("loading...") : theme.muted(`${this.list.totalCount} sessions`),
      hints: [
        { key: "Enter", label: "switch" },
        ...(this.onCreateNew ? [{ key: "n", label: "new chat" }] : []),
        { key: "/", label: "filter" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) =>
        this.loading ? [theme.muted("Loading sessions...")] : this.list.render(innerW, bodyH, theme),
    });
  }

  private pickSelected(ctx: ScreenContext): void {
    const s = this.list.selectedItem()?.value;
    if (!s) return;
    if (s.attachedByMe || s.id === this.currentId) {
      this.frame.setNotice(`Already attached to ${s.id}`, "info");
      ctx.requestRender();
      return;
    }
    ctx.navigator.closeAll();
    this.onPick(s);
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") {
        this.pickSelected(ctx);
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
    if ((data === "n" || data === "N") && this.onCreateNew) {
      ctx.navigator.closeAll();
      this.onCreateNew();
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      this.pickSelected(ctx);
      return;
    }
    if (res === "handled") ctx.requestRender();
  }
}
