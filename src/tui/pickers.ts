import { matchesKey } from "@earendil-works/pi-tui";
import type { CompiledModelCatalog, CompiledModelEntry } from "../catalog/compiler.js";
import type { HarnessConfig } from "../config.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { KbEntry } from "../kb/store.js";
import {
  clamp,
  divider,
  type TuiEntityRef as EntityRef,
  firstLine,
  formatAge,
  formatCountdown,
  formatUsd,
  Frame,
  kvRow,
  ListView,
  type RecentRefsRing,
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
} from "./core/index.js";
import { type InspectorDeps, openEntityInspector } from "./inspectors.js";
import type { AttachableSession } from "./store.js";

/* ─────────────────────────── Go-To-Anything (Ctrl+O) ──────────────────────── */

export interface QuickActionItem {
  id: string;
  label: string;
  detail: string;
  run: (ctx: ScreenContext) => void;
}

export class GoToPaletteScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Go To";
  private readonly frame = new Frame();
  private readonly list = new ListView<{ run: (ctx: ScreenContext) => void }>({
    emptyText: "Type to jump to any goal, escalation, task, run, timer, or command.",
  });

  constructor(
    private readonly deps: InspectorDeps,
    private readonly recentRefs: RecentRefsRing,
    private readonly extraActions: QuickActionItem[],
  ) {
    this.buildItems();
    this.list.startFilter();
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

    for (const item of snap.inbox) {
      const ref: EntityRef = {
        kind: item.ref.kind,
        id: item.ref.id,
        runId: item.ref.runId,
        goalId: item.ref.goalId,
        label: item.ref.label ?? item.title,
      };
      add({
        id: `inbox:${ref.kind}:${ref.id}`,
        searchText: `inbox ${item.severity} ${item.title} ${item.detail} ${ref.id}`,
        badge: item.severity,
        badgeTone: item.severity === "P0" ? "danger" : "warn",
        title: sanitizeLine(item.title),
        detail: firstLine(item.detail, 45),
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

    for (const ref of this.recentRefs.allNewestFirst()) {
      add({
        id: `ref:${ref.kind}:${ref.id}`,
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

    for (const e of snap.escalations) {
      const ref: EntityRef = { kind: "escalation", id: e.id, runId: e.runId, label: `${e.id} ${e.title}` };
      add({
        id: `esc:${e.id}`,
        searchText: `escalation ${e.id} ${e.severity} ${e.status} ${e.title} ${e.runId}`,
        badge: e.severity,
        badgeTone: e.status === "open" ? "danger" : "muted",
        title: `${e.id} ${sanitizeLine(e.title)}`,
        detail: `${e.status} · ${e.runId}`,
        run: (ctx) => {
          ctx.navigator.pop();
          openEntityInspector(ref, this.deps, ctx);
        },
      });
    }

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

    for (const act of this.extraActions) {
      add({
        id: `cmd:${act.id}`,
        searchText: `command ${act.label} ${act.detail}`,
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

    this.list.setItems(
      rows.map((r) => ({
        id: r.id,
        value: { run: r.run },
        searchText: r.searchText,
        render: (w, _sel, theme) =>
          splitRow(`${tag(r.badge, r.badgeTone, theme)} ${r.title}`, theme.muted(r.detail), w),
      })),
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Go To Anything"],
      hints: [
        { key: "Enter", label: "open" },
        { key: "↑↓", label: "move" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) => this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (matchesKey(data, "escape") && !this.list.query) {
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

export class ModelPickerScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Models";
  private readonly frame = new Frame();
  private readonly list = new ListView<CompiledModelEntry>({ emptyText: "No models available. Press 'r' to sync." });
  private catalog: CompiledModelCatalog | null = null;
  private loading = true;
  private selectedEffortIdx = 0;

  constructor(
    private readonly client: DaemonClient,
    private readonly opts: {
      chatSessionId?: string;
      cwd: string;
      currentProfileId?: string;
      currentModel?: string | null;
      currentEffort?: string | null;
      onSelected: (sel: { profileId: string; model: string; effort: string | null }) => void;
    },
  ) {}

  onShow(ctx: ScreenContext): void {
    void this.load(false, ctx);
  }

  private async load(forceSync: boolean, ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      const op = forceSync ? "models.sync" : "models.list";
      this.catalog = await this.client.request<CompiledModelCatalog>(op, {
        cwd: this.opts.cwd,
        ...(this.opts.chatSessionId ? { chatSessionId: this.opts.chatSessionId } : {}),
      });
      this.rebuild();
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  private rebuild(): void {
    const models = this.catalog?.models ?? [];
    this.list.setItems(
      models.map((m) => {
        const active = m.preferredRoute.wireModelId === this.opts.currentModel || m.id === this.opts.currentModel;
        const avail = m.quota?.exhausted ? "exhausted" : m.quota?.availabilityName ?? "available";
        return {
          id: `${m.preferredRoute.profileId}:${m.id}`,
          value: m,
          searchText: `${m.id} ${m.name} ${m.preferredRoute.profileId} ${m.preferredRoute.wireModelId}`,
          render: (w, _sel, theme) => {
            const star = active ? `${theme.ok("★")} ` : "";
            const score = m.codingScore != null ? theme.muted(` score:${Math.round(m.codingScore)}`) : "";
            const efforts = m.efforts.length > 0 ? theme.muted(` [${m.efforts.join(",")}]`) : "";
            const left = `${star}${theme.bold(m.id)} ${theme.muted(`via ${m.preferredRoute.profileId}`)}${score}${efforts}`;
            const right = statusBadge(avail, theme);
            return splitRow(left, right, w);
          },
        };
      }),
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const sel = this.list.selectedItem()?.value;
    const effortList = sel?.efforts ?? [];
    const chosenEffort = effortList.length > 0 ? effortList[this.selectedEffortIdx % effortList.length] : null;
    const sub = sel
      ? `Selected: ${sel.preferredRoute.profileId} / ${sel.preferredRoute.wireModelId}${chosenEffort ? ` · effort: ${chosenEffort} (e to cycle)` : ""}`
      : `Current: ${this.opts.currentProfileId ?? "auto"} / ${this.opts.currentModel ?? "default"}`;

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Models & Effort"],
      rightHeader: this.loading ? theme.accent("syncing...") : theme.muted(`${this.catalog?.models.length ?? 0} models`),
      subtitle: sub,
      hints: [
        { key: "Enter", label: "apply" },
        { key: "e", label: "cycle effort" },
        { key: "/", label: "filter" },
        { key: "r", label: "sync catalog" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) =>
        this.loading && !this.catalog ? [theme.muted("Loading model catalog...")] : this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") {
        this.applySelection(ctx);
        return;
      }
      ctx.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }
    if (data === "r") {
      void this.load(true, ctx);
      return;
    }
    if (data === "e") {
      this.selectedEffortIdx += 1;
      ctx.requestRender();
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      this.applySelection(ctx);
      return;
    }
    if (res === "handled") ctx.requestRender();
  }

  private applySelection(ctx: ScreenContext): void {
    const sel = this.list.selectedItem()?.value;
    if (!sel) return;
    const efforts = sel.efforts ?? [];
    const effort = efforts.length > 0 ? efforts[this.selectedEffortIdx % efforts.length]! : null;
    this.opts.onSelected({
      profileId: sel.preferredRoute.profileId,
      model: sel.preferredRoute.wireModelId,
      effort,
    });
    ctx.navigator.pop();
  }
}

/* ─────────────────────────── Quota & Cost Viewer ──────────────────────────── */

interface QuotaResponse {
  snapshot?: {
    models?: Array<{
      modelId?: string;
      profileId?: string;
      provider?: string;
      status?: string;
      remainingFraction?: number;
      resetAt?: string;
      reason?: string;
    }>;
  };
  configured?: boolean;
  coverage?: Record<string, { covered?: boolean; confidence?: string }>;
}

interface CostSummaryResponse {
  scope?: { kind: "chat" | "run"; id: string; label: string };
  available?: boolean;
  totals?: Array<{ currency: string; amount: number }>;
  byModel?: Array<{ model: string | null; currency: string; amount: number }>;
  coverage?: {
    complete: boolean;
    routes: Array<{ profileId: string; billing: string; invocations: number; running: number; status: string; note: string }>;
    unattributed: Array<{ currency: string; amount: number }>;
  };
}

function formatMoney(currency: string, amount: number): string {
  return currency.toUpperCase() === "USD" ? formatUsd(amount) : `${amount.toFixed(4)} ${currency}`;
}

export class QuotaCostScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Quota & Cost";
  private readonly frame = new Frame();
  private readonly viewport = new Viewport();
  private quota: QuotaResponse | null = null;
  private cost: CostSummaryResponse | null = null;
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly scope?: { chatSessionId?: string; runId?: string; repoRoot?: string },
  ) {}

  onShow(ctx: ScreenContext): void {
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
      this.cost = await this.client.request<CostSummaryResponse>("cost.get" as never, {
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
      breadcrumbs: ["Quota & Cost"],
      rightHeader: this.loading ? theme.accent("syncing...") : undefined,
      hints: [
        { key: "r", label: "sync now" },
        { key: "↑↓/PgUp/PgDn", label: "scroll" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) => {
        if (this.loading && !this.quota) return [theme.muted("Loading quota status...")];
        const lines: string[] = [];

        if (this.cost) {
          lines.push(divider(innerW, theme, `Reported Spend${this.cost.scope ? ` (${this.cost.scope.label})` : ""}`));
          if (!this.cost.available) {
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
            for (const row of (this.cost.byModel ?? []).slice(0, 12)) {
              lines.push(splitRow(`  ${row.model ?? "(unattributed)"}`, formatMoney(row.currency, row.amount), innerW));
            }
            for (const route of this.cost.coverage?.routes ?? []) {
              lines.push(
                splitRow(
                  `  ${statusBadge(route.status, theme)} ${route.profileId} (${route.invocations} inv${route.running > 0 ? `, ${route.running} running` : ""})`,
                  theme.muted(route.note),
                  innerW,
                ),
              );
            }
          }
          lines.push("");
        }

        lines.push(divider(innerW, theme, "Quota Capacity"));
        lines.push(kvRow("Quota Endpoint", this.quota?.configured ? theme.ok("configured") : theme.muted("local harvest only"), innerW, theme));

        const models = this.quota?.snapshot?.models ?? [];
        if (models.length === 0) {
          lines.push(theme.muted("  No quota windows harvested yet. Press 'r' to sync."));
        } else {
          for (const m of models) {
            const pct = m.remainingFraction != null ? `${Math.round(m.remainingFraction * 100)}% left` : "";
            const reset = m.resetAt ? ` · resets ${formatCountdown(m.resetAt)}` : "";
            const label = `${m.profileId ?? m.provider ?? "default"} / ${m.modelId ?? "*"}`;
            lines.push(
              splitRow(
                `  ${statusBadge(m.status ?? "available", theme)} ${sanitizeLine(label)}`,
                theme.muted(`${pct}${reset}`),
                innerW,
              ),
            );
          }
        }
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (matchesKey(data, "escape") || data === "q") {
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
    } else if (matchesKey(data, "pageUp")) {
      this.viewport.pageUp();
      ctx.requestRender();
    } else if (matchesKey(data, "pageDown")) {
      this.viewport.pageDown();
      ctx.requestRender();
    }
  }
}

/* ──────────────────────────────── KB Browser ──────────────────────────────── */

export class KbBrowserScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Knowledge Base";
  private readonly frame = new Frame();
  private readonly list = new ListView<KbEntry>({ emptyText: "No KB entries found for this repo." });
  private includeCandidates = true;
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly repoRoot: string,
  ) {}

  onShow(ctx: ScreenContext): void {
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      const entries = await this.client.request<KbEntry[]>("kb.search", {
        repoRoot: this.repoRoot,
        includeCandidates: this.includeCandidates,
        includeStale: true,
        limit: 80,
      });
      this.list.setItems(
        (entries ?? []).map((e) => ({
          id: e.id,
          value: e,
          searchText: `${e.id} ${e.kind} ${e.status} ${e.title} ${e.tags.join(" ")}`,
          render: (w, _sel, theme) =>
            splitRow(
              `${statusBadge(e.status, theme)} ${tag(e.kind, "info", theme)} ${theme.bold(sanitizeLine(e.title))}`,
              theme.muted(formatAge(e.updatedAt)),
              w,
            ),
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
      breadcrumbs: ["Knowledge Base"],
      hints: [
        { key: "Enter", label: "read" },
        { key: "/", label: "filter" },
        { key: "c", label: this.includeCandidates ? "hide candidates" : "show candidates" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) =>
        this.loading ? [theme.muted("Loading KB entries...")] : this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") this.openSelected(ctx);
      ctx.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }
    if (data === "c") {
      this.includeCandidates = !this.includeCandidates;
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
    ctx.navigator.push(new KbDetailScreen(sel));
  }
}

class KbDetailScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title: string;
  private readonly frame = new Frame();
  private readonly viewport = new Viewport();

  constructor(private readonly entry: KbEntry) {
    this.title = entry.id;
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["KB", this.entry.id],
      rightHeader: statusBadge(this.entry.status, theme),
      subtitle: sanitizeLine(this.entry.title),
      hints: [{ key: "Esc", label: "back" }],
      renderBody: (innerW, bodyH) => {
        const lines = [
          kvRow("Kind", this.entry.kind, innerW, theme),
          kvRow("Status", statusBadge(this.entry.status, theme), innerW, theme),
          kvRow("Tags", this.entry.tags.join(", ") || "—", innerW, theme),
          kvRow("Path Globs", this.entry.pathGlobs.join(", ") || "—", innerW, theme),
          "",
          divider(innerW, theme, "Context"),
          ...wrap(sanitizeText(this.entry.contextMd), innerW),
        ];
        return this.viewport.render(lines, innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }
    if (matchesKey(data, "up") || data === "k") this.viewport.scrollBy(-1);
    else if (matchesKey(data, "down") || data === "j") this.viewport.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.viewport.pageUp();
    else if (matchesKey(data, "pageDown")) this.viewport.pageDown();
    ctx.requestRender();
  }
}

/* ──────────────────────────── Session Switcher ────────────────────────────── */

export class SessionSwitcherScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Sessions";
  private readonly frame = new Frame();
  private readonly list = new ListView<AttachableSession>({ emptyText: "No sessions found." });
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly currentId: string,
    private readonly onPick: (session: AttachableSession) => void,
  ) {}

  onShow(ctx: ScreenContext): void {
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      const sessions = await this.client.request<AttachableSession[]>("sessions.list");
      this.list.setItems(
        (sessions ?? []).map((s) => ({
          id: `${s.kind}:${s.id}`,
          value: s,
          searchText: `${s.kind} ${s.id} ${s.title} ${s.status} ${s.repoRoot}`,
          render: (w, _sel, theme) => {
            const cur = s.id === this.currentId ? `${theme.ok("★")} ` : "";
            const left = `${cur}${tag(s.kind, s.kind === "chat" ? "accent" : "info", theme)} ${theme.bold(s.id)} ${firstLine(s.title, 40)}`;
            const right = `${statusBadge(s.status, theme)} ${theme.muted(formatAge(s.updatedAt))}`;
            return splitRow(left, right, w);
          },
        })),
      );
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
      breadcrumbs: ["Switch Session"],
      hints: [
        { key: "Enter", label: "switch" },
        { key: "/", label: "filter" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) =>
        this.loading ? [theme.muted("Loading sessions...")] : this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") {
        const s = this.list.selectedItem()?.value;
        if (s) {
          ctx.navigator.closeAll();
          this.onPick(s);
        }
        return;
      }
      ctx.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      const s = this.list.selectedItem()?.value;
      if (s) {
        ctx.navigator.closeAll();
        this.onPick(s);
      }
      return;
    }
    if (res === "handled") ctx.requestRender();
  }
}

/* ───────────────────────────── Settings Screen ────────────────────────────── */

interface SettingRow {
  key: string;
  label: string;
  value: string;
  editable: boolean;
}

export class SettingsScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Settings";
  private readonly frame = new Frame();
  private readonly list = new ListView<SettingRow>({ emptyText: "Loading config..." });
  private config: HarnessConfig | null = null;

  constructor(private readonly client: DaemonClient) {}

  onShow(ctx: ScreenContext): void {
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext): Promise<void> {
    try {
      this.config = await this.client.request<HarnessConfig>("config.get");
      this.rebuild();
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    }
    ctx.requestRender();
  }

  private rebuild(): void {
    if (!this.config) return;
    const c = this.config;
    const rows: SettingRow[] = [
      { key: "defaultOrchestratorProfile", label: "Orchestrator Profile", value: c.defaultOrchestratorProfile ?? "auto", editable: true },
      { key: "defaultWorkerProfile", label: "Worker Profile", value: c.defaultWorkerProfile ?? "auto", editable: true },
      { key: "defaultTaskProfile", label: "Task Profile", value: c.defaultTaskProfile ?? "auto", editable: true },
      { key: "profiles", label: "Configured Profiles", value: c.profiles.map((p) => p.id).join(", "), editable: false },
    ];
    this.list.setItems(
      rows.map((r) => ({
        id: r.key,
        value: r,
        searchText: `${r.key} ${r.label} ${r.value}`,
        render: (w, _sel, theme) =>
          clamp(splitRow(theme.bold(r.label), r.editable ? theme.accent(r.value) : theme.muted(r.value), w), w),
      })),
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: ["Settings"],
      hints: [
        { key: "Enter", label: "edit" },
        { key: "Esc", label: "close" },
      ],
      renderBody: (innerW, bodyH) => this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;
    if (matchesKey(data, "escape") || data === "q") {
      ctx.navigator.pop();
      return;
    }
    const res = this.list.handleInput(data);
    if (res === "select") {
      const sel = this.list.selectedItem()?.value;
      if (sel && sel.editable) {
        this.frame.askPrompt({
          label: sel.label,
          initialValue: sel.value,
          onSubmit: async (nextVal) => {
            const parsed = sel.key === "maxConcurrentWorkers" ? Number(nextVal) : nextVal;
            await this.client.request("config.update", { patch: { [sel.key]: parsed } });
            this.frame.setNotice(`Updated ${sel.label}`, "ok");
            await this.load(ctx);
          },
        });
        ctx.requestRender();
      }
      return;
    }
    if (res === "handled") ctx.requestRender();
  }
}
