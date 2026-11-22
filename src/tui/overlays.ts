import {
  Input,
  matchesKey,
  SelectList,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import type { CompiledModelCatalog, CompiledModelEntry, ProfileProbeStatus } from "../catalog/compiler.js";
import type { ModelRoute } from "../catalog/deduplicate.js";
import type { RunnerProfileConfig } from "../config.js";
import type { EscalationRecord, RunRecord, TaskRecord } from "../control-plane/db.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { GoalRecord, GoalReviewVerdict } from "../goals/engine.js";
import type { KbCard, KbEntry } from "../kb/store.js";
import type { LiveWorktreeInfo } from "../worktree/manager.js";
import {
  badge,
  clampLine,
  fillLineBg,
  fitWidth,
  renderFlexRow,
  renderProgressBar,
  renderTable,
  type HarnessTheme,
} from "./primitives/index.js";

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "-";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hrs}h${rem}m` : `${hrs}h`;
}

export function formatResetCountdown(iso?: string | null): string {
  if (!iso) return "";
  const diffMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diffMs)) return "";
  if (diffMs <= 0) return "resetting now";
  const mins = Math.ceil(diffMs / 60_000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return `resets in ${hrs}h ${rem}m`;
  const days = Math.floor(hrs / 24);
  return `resets in ${days}d ${hrs % 24}h`;
}

/** Strips `pi-tui` Input's built-in `> ` prefix so search bars render cleanly with a single icon. */
function renderCleanSearchLine(input: Input, icon: string, placeholder: string, width: number, theme: HarnessTheme): string {
  const innerW = Math.max(4, width - 2);
  const raw = input.render(innerW)[0] ?? "";
  const stripped = raw.startsWith("> ") ? raw.slice(2) : raw;
  const val = input.getValue();
  if (!val && width >= 18) {
    // Keep cursor marker + fake cursor, show dimmed placeholder right after
    return fitWidth(`${theme.accentBold(icon)} ${stripped.trimEnd()} ${theme.dim(placeholder)}`, width);
  }
  return fitWidth(`${theme.accentBold(icon)} ${stripped}`, width);
}

export interface PaletteCommand {
  id: string;
  label: string;
  shortcut?: string;
  description: string;
  run: () => void;
}

/**
 * Amp-inspired `Ctrl+O` Command Palette:
 * Fuzzy-searchable, column-aligned launcher for every action/overlay without clearing the user's draft prompt.
 */
export class CommandPaletteOverlay implements Component, Focusable {
  private input: Input;
  private selected = 0;
  private filtered: PaletteCommand[];
  private _focused = false;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly commands: PaletteCommand[],
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {
    this.filtered = [...commands];
    this.input = new Input();
    this.input.focused = true;
    this.input.onEscape = () => this.onClose();
    this.input.onSubmit = () => {
      const cmd = this.filtered[this.selected];
      if (cmd) {
        this.onClose();
        cmd.run();
      }
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(val: boolean) {
    this._focused = val;
    this.input.focused = val;
  }

  private applyFilter(): void {
    const q = this.input.getValue().trim().toLowerCase();
    this.filtered = !q
      ? [...this.commands]
      : this.commands.filter(
          (c) =>
            c.label.toLowerCase().includes(q) ||
            c.description.toLowerCase().includes(q) ||
            (c.shortcut?.toLowerCase().includes(q) ?? false),
        );
    this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+o")) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.selected = Math.min(Math.max(0, this.filtered.length - 1), this.selected + 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "enter")) {
      const cmd = this.filtered[this.selected];
      if (cmd) {
        this.onClose();
        cmd.run();
      }
      return;
    }
    this.input.handleInput(data);
    this.applyFilter();
    this.rerender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): readonly string[] {
    const lines: string[] = [];
    lines.push(renderCleanSearchLine(this.input, "⌕", "Filter commands…", width, this.theme));
    lines.push(this.theme.border("─".repeat(width)));

    if (this.filtered.length === 0) {
      lines.push(fitWidth(this.theme.muted("  No matching commands."), width));
      return lines;
    }

    const maxRows = 10;
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), this.filtered.length - maxRows));
    const slice = this.filtered.slice(start, start + maxRows);

    const labelW = Math.min(26, Math.max(14, Math.floor(width * 0.32)));
    const keyW = width >= 54 ? 11 : 0;
    const descW = Math.max(0, width - 2 - labelW - (keyW > 0 ? keyW + 2 : 0) - 2);

    for (let i = 0; i < slice.length; i++) {
      const idx = start + i;
      const cmd = slice[i]!;
      const active = idx === this.selected;
      const marker = active ? this.theme.accentBold("▸ ") : "  ";
      const labelCell = fitWidth(active ? this.theme.accentBold(cmd.label) : this.theme.text(cmd.label), labelW);
      const keyCell = keyW > 0 ? "  " + fitWidth(this.theme.dim(cmd.shortcut ?? ""), keyW) : "";
      const descCell = descW >= 8 ? "  " + fitWidth(this.theme.muted(cmd.description), descW) : "";
      const row = `${marker}${labelCell}${keyCell}${descCell}`;
      lines.push(active ? fillLineBg(row, width, this.theme.badgeBg) : clampLine(row, width));
    }

    if (this.filtered.length > maxRows) {
      lines.push(fitWidth(this.theme.dim(`  ${this.selected + 1}/${this.filtered.length} commands`), width));
    }

    return lines;
  }
}

/**
 * Interactive Searchable Tabular Model & ACP Route Picker (`/model` or `/models`):
 * - Live fuzzy filter (type model name OR CLI like `codex`, `claude`, `amp` — auto-selects matching route!)
 * - `Tab` (or `←`/`→`) cycles the ACP CLI route when a model is offered by multiple CLIs
 * - Crisp aligned columns: RANK, MODEL, SCORE, COST/TASK, TIME, CLI / QUOTA
 * - Bottom inspector strip showing selectable routes, supported reasoning efforts & quota
 * - `Ctrl+R` runs live benchmark sync
 */
export class ModelPickerOverlay implements Component, Focusable {
  private input: Input;
  private selected = 0;
  private filtered: CompiledModelEntry[] = [];
  private routeIdxByModel = new Map<string, number>();
  private statusNote = "";
  private syncing = false;
  private _focused = true;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly client: DaemonClient,
    private readonly repoRoot: string,
    private catalog: CompiledModelCatalog,
    private readonly currentModel: string | null,
    private readonly currentProfileId: string | null,
    private readonly onSelectModel: (entry: CompiledModelEntry, route: ModelRoute) => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {
    this.input = new Input();
    this.input.focused = true;
    this.applyFilter();
    const curIdx = this.filtered.findIndex(
      (m) => this.currentModel && (m.id === this.currentModel || this.allRoutes(m).some((r) => r.wireModelId === this.currentModel)),
    );
    if (curIdx >= 0) {
      this.selected = curIdx;
      const m = this.filtered[curIdx]!;
      const routes = this.allRoutes(m);
      const rIdx = routes.findIndex((r) => r.profileId === this.currentProfileId);
      if (rIdx >= 0) this.routeIdxByModel.set(m.id, rIdx);
    }
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(val: boolean) {
    this._focused = val;
    this.input.focused = val;
  }

  private allRoutes(m: CompiledModelEntry): ModelRoute[] {
    return [m.preferredRoute, ...(m.alternateRoutes ?? [])];
  }

  private activeRoute(m: CompiledModelEntry): { route: ModelRoute; idx: number; all: ModelRoute[] } {
    const all = this.allRoutes(m);
    const idx = Math.max(0, Math.min(this.routeIdxByModel.get(m.id) ?? 0, all.length - 1));
    return { route: all[idx]!, idx, all };
  }

  private cycleRoute(delta: number): void {
    const cur = this.filtered[this.selected];
    if (!cur) return;
    const all = this.allRoutes(cur);
    if (all.length <= 1) return;
    const prev = this.routeIdxByModel.get(cur.id) ?? 0;
    const next = (prev + delta + all.length) % all.length;
    this.routeIdxByModel.set(cur.id, next);
    this.rerender();
  }

  private applyFilter(): void {
    const q = this.input.getValue().trim().toLowerCase();
    this.filtered = !q
      ? [...this.catalog.models]
      : this.catalog.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            this.allRoutes(m).some((r) => r.profileId.toLowerCase().includes(q)) ||
            (m.scoreSource?.toLowerCase().includes(q) ?? false),
        );
    // When user filters by a CLI name (e.g. `codex`, `claude`, `amp`), auto-select that matching route on each row!
    if (q) {
      for (const m of this.filtered) {
        const all = this.allRoutes(m);
        const matchIdx = all.findIndex((r) => r.profileId.toLowerCase().includes(q));
        if (matchIdx >= 0) {
          this.routeIdxByModel.set(m.id, matchIdx);
        }
      }
    }
    this.selected = Math.min(this.selected, Math.max(0, this.filtered.length - 1));
  }

  private triggerSync(): void {
    if (this.syncing) return;
    this.syncing = true;
    this.statusNote = "Syncing live benchmarks (Vals.ai, Harbor TB4, Epoch AI, models.dev, OpenRouter)…";
    this.rerender();
    void this.client.request<CompiledModelCatalog>("models.sync", { cwd: this.repoRoot }).then(
      (fresh) => {
        this.syncing = false;
        this.catalog = fresh;
        this.statusNote = `Synced ${fresh.models.length} latest-per-family models (${fresh.sources.join(", ")})`;
        this.applyFilter();
        this.rerender();
      },
      (err) => {
        this.syncing = false;
        this.statusNote = `Sync failed: ${err instanceof Error ? err.message : String(err)}`;
        this.rerender();
      },
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.input.getValue().length > 0) {
        this.input.setValue("");
        this.applyFilter();
        this.rerender();
      } else {
        this.onClose();
      }
      return;
    }
    if (matchesKey(data, "ctrl+r")) {
      this.triggerSync();
      return;
    }
    if (matchesKey(data, "tab")) {
      this.cycleRoute(1);
      return;
    }
    if (matchesKey(data, "shift+tab")) {
      this.cycleRoute(-1);
      return;
    }
    if (this.input.getValue().length === 0 && matchesKey(data, "right")) {
      this.cycleRoute(1);
      return;
    }
    if (this.input.getValue().length === 0 && matchesKey(data, "left")) {
      this.cycleRoute(-1);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "ctrl+p")) {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "ctrl+n")) {
      this.selected = Math.min(Math.max(0, this.filtered.length - 1), this.selected + 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "enter")) {
      const chosen = this.filtered[this.selected];
      if (chosen) {
        const { route } = this.activeRoute(chosen);
        this.onSelectModel(chosen, route);
      }
      this.onClose();
      return;
    }
    this.input.handleInput(data);
    this.applyFilter();
    this.rerender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): readonly string[] {
    const out: string[] = [];
    out.push(renderCleanSearchLine(this.input, "⌕", "Filter by model or CLI (codex/claude/amp)…  Tab switches CLI", width, this.theme));
    if (this.statusNote) {
      out.push(fitWidth(this.theme.warning(this.statusNote), width));
    }
    const failedProbes = (this.catalog.profileStatuses ?? []).filter((s) => s.status === "error");
    if (failedProbes.length > 0) {
      for (const fp of failedProbes.slice(0, 2)) {
        out.push(fitWidth(this.theme.warning(`⚠ ${fp.profileId}: ${fp.error ?? "probe failed"}`), width));
      }
    }
    out.push(this.theme.border("─".repeat(width)));

    if (this.filtered.length === 0) {
      out.push(fitWidth(this.theme.muted("  No models match. Press Ctrl+R to sync benchmarks or check /settings."), width));
      return out;
    }

    const maxRows = 10;
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), this.filtered.length - maxRows));
    const slice = this.filtered.slice(start, start + maxRows);

    // Responsive column widths
    const showRoute = width >= 86;
    const showTime = width >= 74;
    const showCost = width >= 62;
    const rankW = 4;
    const scoreW = 15;
    const costW = showCost ? 16 : 0;
    const timeW = showTime ? 6 : 0;
    const routeW = showRoute ? 16 : 0;
    const gaps = 2 * (2 + (showCost ? 1 : 0) + (showTime ? 1 : 0) + (showRoute ? 1 : 0));
    const modelW = Math.max(14, width - 2 - rankW - scoreW - costW - timeW - routeW - gaps);

    const hdrParts = [
      "  ",
      fitWidth(this.theme.dim("#"), rankW),
      fitWidth(this.theme.dim("MODEL"), modelW),
      fitWidth(this.theme.dim("CODING SCORE"), scoreW),
    ];
    if (showCost) hdrParts.push(fitWidth(this.theme.dim("COST / TASK"), costW));
    if (showTime) hdrParts.push(fitWidth(this.theme.dim("TIME"), timeW, { align: "right" }));
    if (showRoute) hdrParts.push(fitWidth(this.theme.dim("ACP CLI / QUOTA"), routeW));
    out.push(clampLine(hdrParts.join("  ").replace(/^  \s{2}/, "  "), width));
    out.push(this.theme.border("─".repeat(width)));

    for (let i = 0; i < slice.length; i++) {
      const idx = start + i;
      const m = slice[i]!;
      const active = idx === this.selected;
      const { route, all } = this.activeRoute(m);
      const isCurrent =
        Boolean(this.currentModel) &&
        (m.id === this.currentModel || route.wireModelId === this.currentModel) &&
        (!this.currentProfileId || route.profileId === this.currentProfileId);

      const marker = active ? this.theme.accentBold("▸ ") : isCurrent ? this.theme.success("★ ") : "  ";
      const rankCell = fitWidth(active ? this.theme.accentBold(`#${m.codingRank}`) : this.theme.dim(`#${m.codingRank}`), rankW);
      const modelLabel = isCurrent && active ? `★ ${m.id}` : m.id;
      const modelCell = fitWidth(active ? this.theme.accentBold(modelLabel) : this.theme.text(modelLabel), modelW);
      const scoreText =
        m.codingScore != null
          ? `${this.theme.success(m.codingScore.toFixed(1))} ${this.theme.dim(m.scoreSource ?? "")}`
          : this.theme.dim("unscored");
      const scoreCell = fitWidth(scoreText, scoreW);

      const cells = [rankCell, modelCell, scoreCell];
      if (showCost) {
        const costText =
          route.billing === "subscription"
            ? `${this.theme.success("$0 sub")} ${this.theme.dim(`($${m.apiEquivCostUsd?.toFixed(2) ?? "?"})`)}`
            : `$${m.costPerTaskUsd?.toFixed(2) ?? "?"}/task`;
        cells.push(fitWidth(costText, costW));
      }
      if (showTime) {
        cells.push(fitWidth(this.theme.muted(formatDuration(m.timePerTaskSeconds)), timeW, { align: "right" }));
      }
      if (showRoute) {
        const extra = all.length > 1 ? this.theme.accent(` +${all.length - 1}`) : "";
        const qText =
          m.quota && route.profileId === m.preferredRoute.profileId
            ? m.quota.exhausted
              ? badge("EXHAUSTED", "error", this.theme)
              : `${route.profileId.replace(/^acp:/, "")} ${Math.round((m.quota.effectiveRemainingRatio ?? 1) * 100)}%${extra}`
            : `${route.profileId}${extra}`;
        cells.push(fitWidth(active ? this.theme.text(qText) : this.theme.muted(qText), routeW));
      }

      const row = `${marker}${cells.join("  ")}`;
      out.push(active ? fillLineBg(row, width, this.theme.badgeBg) : clampLine(row, width));
    }

    // Inspector strip for currently highlighted model (with live route selector!)
    const cur = this.filtered[this.selected];
    if (cur) {
      out.push(this.theme.border("─".repeat(width)));
      const { route, all } = this.activeRoute(cur);
      const efforts = route.supportedEfforts ?? cur.efforts;
      const effortsStr = efforts.length > 0 ? efforts.join(" · ") : "default";
      const routesStr = all
        .map((r) => (r.profileId === route.profileId ? this.theme.accentBold(`[${r.profileId}]`) : this.theme.dim(r.profileId)))
        .join(" · ");
      const routeLabel = all.length > 1 ? `${this.theme.dim("CLI [Tab]:")} ${routesStr}` : `${this.theme.dim("CLI:")} ${routesStr}`;
      out.push(
        renderFlexRow(
          `${this.theme.dim("Efforts:")} ${this.theme.muted(effortsStr)}`,
          routeLabel,
          width,
          { minGap: 2, priority: "right" },
        ),
      );
    }

    return out;
  }
}

/**
 * Interactive ACP CLI Quick-Switcher (`/cli`, `/acp`, or `/profile`):
 * Switch your active Director Chat between enabled ACP CLIs (e.g. `acp:codex`, `acp:claude`, `acp:amp`)
 * in a single keypress without digging into `/settings`.
 */
export class CliPickerOverlay implements Component {
  private selected = 0;
  private readonly profiles: RunnerProfileConfig[];

  constructor(
    private readonly theme: HarnessTheme,
    profiles: RunnerProfileConfig[],
    private readonly currentProfileId: string | null,
    private readonly probeStatuses: ProfileProbeStatus[] | undefined,
    private readonly onSelectProfile: (profile: RunnerProfileConfig) => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {
    this.profiles = profiles.filter((p) => p.enabled !== false);
    const curIdx = this.profiles.findIndex((p) => p.id === currentProfileId);
    if (curIdx >= 0) this.selected = curIdx;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(Math.max(0, this.profiles.length - 1), this.selected + 1);
      this.rerender();
    } else if (matchesKey(data, "enter")) {
      const chosen = this.profiles[this.selected];
      this.onClose();
      if (chosen) this.onSelectProfile(chosen);
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (this.profiles.length === 0) {
      return [fitWidth(this.theme.muted("No enabled CLIs. Open /settings (Ctrl+,) to add or enable an ACP CLI."), width)];
    }

    const statusById = new Map((this.probeStatuses ?? []).map((s) => [s.profileId, s]));
    return renderTable(
      this.profiles.map((p, idx) => ({ p, idx })),
      [
        {
          header: "ACP CLI",
          width: 20,
          priority: 0,
          render: ({ p, idx }) => {
            const active = idx === this.selected;
            const isCur = p.id === this.currentProfileId;
            const marker = active ? this.theme.accentBold("▸ ") : isCur ? this.theme.success("★ ") : "  ";
            return `${marker}${active ? this.theme.accentBold(p.id) : this.theme.bold(p.id)}`;
          },
        },
        {
          header: "STATUS",
          width: 18,
          priority: 0,
          render: ({ p }) => {
            const st = statusById.get(p.id);
            if (!st) return this.theme.muted(p.billing);
            return st.status === "ok"
              ? badge(`${st.modelCount} models`, "success", this.theme)
              : badge(st.error ?? "probe error", "warning", this.theme);
          },
        },
        {
          header: "COMMAND",
          width: "flex",
          minWidth: 16,
          priority: 1,
          render: ({ p }) =>
            this.theme.dim(p.kind === "acp" ? `${p.command} ${(p.args ?? []).join(" ")}` : `pi:${p.provider}`),
        },
      ],
      width,
      this.theme,
    );
  }
}

/** Interactive Reasoning Effort Picker (`/effort`). */
export class EffortPickerOverlay implements Component {
  private selected = 0;
  private readonly items: Array<{ value: string; description: string }>;

  constructor(
    private readonly theme: HarnessTheme,
    efforts: string[],
    private readonly currentEffort: string | null,
    private readonly onSelectEffort: (effort: string) => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {
    const choices =
      efforts.length > 0 && !(efforts.length === 1 && efforts[0] === "default")
        ? efforts
        : ["low", "medium", "high", "xhigh", "max"];
    const descriptions: Record<string, string> = {
      off: "Disable extended reasoning (fastest)",
      minimal: "Lightest reasoning pass",
      low: "Fast & low token spend — scouts & quick Q&A",
      medium: "Balanced speed & coding depth",
      high: "Deep reasoning — recommended for Workers & planning",
      xhigh: "Extra-high reasoning budget for tough refactors",
      max: "Maximum reasoning depth — frontier architecture & hard bugs",
      ultra: "Ultra reasoning depth — hardest multi-file synthesis & debugging",
    };

    this.items = choices.map((e) => ({
      value: e,
      description: descriptions[e] ?? "Model reasoning effort level",
    }));

    const curIdx = this.items.findIndex((i) => i.value === currentEffort);
    if (curIdx >= 0) this.selected = curIdx;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(this.items.length - 1, this.selected + 1);
      this.rerender();
      return;
    }
    if (matchesKey(data, "enter")) {
      const chosen = this.items[this.selected];
      if (chosen) this.onSelectEffort(chosen.value);
      this.onClose();
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    const labelW = 10;
    const descW = Math.max(8, width - 2 - labelW - 2);
    return this.items.map((item, idx) => {
      const active = idx === this.selected;
      const isCurrent = item.value === this.currentEffort;
      const marker = active ? this.theme.accentBold("▸ ") : isCurrent ? this.theme.success("★ ") : "  ";
      const label = fitWidth(active ? this.theme.accentBold(item.value) : this.theme.bold(item.value), labelW);
      const desc = fitWidth(active ? this.theme.text(item.description) : this.theme.muted(item.description), descW);
      const row = `${marker}${label}  ${desc}`;
      return active ? fillLineBg(row, width, this.theme.badgeBg) : clampLine(row, width);
    });
  }
}

/** Visual Quota Dashboard (`/quota`): shared vs. separate buckets with bars & reset countdowns. */
export class QuotaOverlay implements Component {
  private note = "";

  constructor(
    private readonly theme: HarnessTheme,
    private readonly client: DaemonClient,
    private data: { configured: boolean; snapshot: Record<string, unknown> | null },
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (data === "r" || data === "R") {
      this.note = "Refreshing quota snapshot…";
      this.rerender();
      void this.client.request<{ configured: boolean; snapshot: Record<string, unknown> | null }>("quota.sync").then(
        (fresh) => {
          this.data = fresh;
          this.note = "Refreshed.";
          this.rerender();
        },
        (err) => {
          this.note = `Refresh failed: ${err instanceof Error ? err.message : String(err)}`;
          this.rerender();
        },
      );
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    const lines: string[] = [];
    if (this.note) {
      lines.push(fitWidth(this.theme.warning(this.note), width));
      lines.push("");
    }

    if (!this.data.configured) {
      lines.push(...wrapTextWithAnsi(this.theme.text("No external Quota Endpoint configured yet."), width));
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.muted("Open /settings (Ctrl+,) → 'Quota Endpoint URL' to connect your proto/quota.proto endpoint."),
          width,
        ),
      );
      lines.push(
        ...wrapTextWithAnsi(
          this.theme.dim("Passive ACP rate-limit signals (e.g. Claude _claude/rateLimit) are still harvested automatically."),
          width,
        ),
      );
      return lines.map((l) => clampLine(l, width));
    }

    if (!this.data.snapshot) {
      lines.push(fitWidth(this.theme.muted("Quota Endpoint configured, but no snapshot fetched yet. Press 'r' to sync."), width));
      return lines;
    }

    const snap = this.data.snapshot as {
      generatedAt?: string;
      buckets?: Array<{
        bucketId: string;
        displayName?: string;
        windows?: Array<{
          windowId: string;
          label?: string;
          remainingRatio?: number;
          usedPercent?: number;
          resetAt?: string;
        }>;
      }>;
      models?: Array<{
        modelId: string;
        exhausted?: boolean;
        bucketBindings?: Array<{ bucketId: string; multiplier?: number }>;
      }>;
    };

    if (snap.generatedAt) {
      lines.push(fitWidth(this.theme.dim(`Snapshot generated: ${snap.generatedAt}`), width));
      lines.push("");
    }

    const bucketRows: Array<{ bucket: string; window: string; ratio: number | null; reset: string }> = [];
    for (const b of snap.buckets ?? []) {
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
          bucket: i === 0 ? b.displayName || b.bucketId : "",
          window: w.label || w.windowId,
          ratio,
          reset: formatResetCountdown(w.resetAt),
        });
      }
    }

    if (bucketRows.length > 0) {
      lines.push(
        ...renderTable(
          bucketRows,
          [
            { header: "BUCKET", width: "flex", minWidth: 14, priority: 0, render: (r) => this.theme.accent(r.bucket) },
            { header: "WINDOW", width: 14, priority: 1, render: (r) => this.theme.text(r.window) },
            {
              header: "CAPACITY",
              width: 17,
              priority: 0,
              render: (r) => renderProgressBar(r.ratio, this.theme, { barWidth: 10 }),
            },
            { header: "RESET", width: 16, align: "right", priority: 2, render: (r) => this.theme.muted(r.reset) },
          ],
          width,
          this.theme,
        ),
      );
    }

    if (snap.models?.length) {
      lines.push("");
      lines.push(
        ...renderTable(
          snap.models.slice(0, 10),
          [
            { header: "MODEL", width: "flex", minWidth: 16, priority: 0, render: (m) => this.theme.bold(m.modelId) },
            {
              header: "STATE",
              width: 10,
              priority: 1,
              render: (m) => (m.exhausted ? badge("EXHAUSTED", "error", this.theme) : badge("OK", "success", this.theme)),
            },
            {
              header: "BOUND BUCKETS",
              width: "flex",
              minWidth: 14,
              priority: 2,
              render: (m) =>
                this.theme.muted(
                  (m.bucketBindings ?? [])
                    .map((bb) => `${bb.bucketId}${bb.multiplier !== undefined && bb.multiplier !== 1 ? ` (${bb.multiplier}x)` : ""}`)
                    .join(" ∩ "),
                ),
            },
          ],
          width,
          this.theme,
        ),
      );
    }

    return lines.map((l) => clampLine(l, width));
  }
}

export interface AttachableSession {
  id: string;
  kind: "chat" | "run";
  title: string;
  repoRoot: string;
  status: string;
  running: boolean;
  attached: boolean;
  attachedByMe: boolean;
  model: string | null;
  effort: string | null;
  updatedAt: number;
}

/**
 * Interactive Sessions & Attach Switcher (`/attach` or `/sessions`):
 * Lists all Director Chat sessions and Autonomous Runs across `harnessd`.
 * Pressing Enter moves you over to the selected session, taking it over and detaching any other terminal attached there.
 */
export class SessionsOverlay implements Component {
  private selected = 0;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly sessions: AttachableSession[],
    private readonly onAttach: (session: AttachableSession) => void,
    private readonly onCreateNew: () => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {
    const firstOther = sessions.findIndex((s) => !s.attachedByMe);
    if (firstOther >= 0) this.selected = firstOther;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (data === "n" || data === "N") {
      this.onClose();
      this.onCreateNew();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(Math.max(0, this.sessions.length - 1), this.selected + 1);
      this.rerender();
    } else if (matchesKey(data, "enter")) {
      const target = this.sessions[this.selected];
      this.onClose();
      if (target && !target.attachedByMe) {
        this.onAttach(target);
      }
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (this.sessions.length === 0) {
      return [fitWidth(this.theme.muted("No sessions yet. Press 'n' to start a new Director Chat session."), width)];
    }

    const maxRows = 12;
    const start = Math.max(0, Math.min(this.selected - Math.floor(maxRows / 2), this.sessions.length - maxRows));
    const slice = this.sessions.slice(start, start + maxRows);

    const out = renderTable(
      slice.map((s, i) => ({ s, idx: start + i })),
      [
        {
          header: "SESSION",
          width: 17,
          priority: 0,
          render: ({ s, idx }) => {
            const active = idx === this.selected;
            const marker = active ? this.theme.accentBold("▸ ") : s.attachedByMe ? this.theme.success("★ ") : "  ";
            return `${marker}${active ? this.theme.accentBold(s.id) : this.theme.bold(s.id)}`;
          },
        },
        {
          header: "TYPE",
          width: 6,
          priority: 1,
          render: ({ s }) => (s.kind === "chat" ? this.theme.info("CHAT") : this.theme.accent("RUN")),
        },
        {
          header: "STATE",
          width: 22,
          priority: 0,
          render: ({ s }) => {
            const attBadge = s.attachedByMe
              ? badge("YOU", "success", this.theme)
              : s.attached
                ? badge("OTHER TERM", "warning", this.theme)
                : "";
            const runBadge = s.running
              ? badge(s.status.toUpperCase(), "accent", this.theme)
              : this.theme.dim(s.status);
            return attBadge ? `${runBadge} ${attBadge}` : runBadge;
          },
        },
        {
          header: "TITLE / WORKSPACE",
          width: "flex",
          minWidth: 16,
          priority: 1,
          render: ({ s }) => {
            const dir = s.repoRoot.split("/").filter(Boolean).pop() ?? s.repoRoot;
            const meta = s.model ? `${s.model} · ${dir}` : dir;
            return `${this.theme.text(s.title)} ${this.theme.dim(`(${meta})`)}`;
          },
        },
      ],
      width,
      this.theme,
    );

    if (this.sessions.length > maxRows) {
      out.push(fitWidth(this.theme.dim(`  ${this.selected + 1}/${this.sessions.length} sessions`), width));
    }
    return out;
  }
}

/** Interactive Autonomous Runs Dashboard (`/runs`). */
export class RunsOverlay implements Component {
  private selected = 0;

  constructor(
    private readonly theme: HarnessTheme,
    private runs: RunRecord[],
    private readonly onAction: (action: "inspect" | "stop", run: RunRecord) => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(Math.max(0, this.runs.length - 1), this.selected + 1);
      this.rerender();
    } else if (this.runs[this.selected]) {
      const r = this.runs[this.selected]!;
      if (matchesKey(data, "enter")) {
        this.onAction("inspect", r);
        this.onClose();
      } else if (data === "x") {
        this.onAction("stop", r);
        this.onClose();
      }
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    if (this.runs.length === 0) {
      return [fitWidth(this.theme.muted("No autonomous runs yet. Launch a Goal in Director Chat or via `pi-harness run`."), width)];
    }

    return renderTable(
      this.runs.slice(0, 12).map((r, i) => ({ r, i })),
      [
        {
          header: "RUN",
          width: 16,
          priority: 0,
          render: ({ r, i }) => {
            const marker = i === this.selected ? this.theme.accentBold("▸ ") : "  ";
            return `${marker}${i === this.selected ? this.theme.accentBold(r.id) : this.theme.bold(r.id)}`;
          },
        },
        {
          header: "STATUS",
          width: 11,
          priority: 0,
          render: ({ r }) => {
            const tone =
              r.status === "completed"
                ? "success"
                : r.status === "failed" || r.status === "stopped"
                  ? "error"
                  : r.status === "active"
                    ? "accent"
                    : "neutral";
            return badge(r.status.toUpperCase(), tone, this.theme);
          },
        },
        {
          header: "OBJECTIVE",
          width: "flex",
          minWidth: 18,
          priority: 1,
          render: ({ r }) => this.theme.text(r.goal.split("\n")[0] ?? r.goal),
        },
      ],
      width,
      this.theme,
    );
  }
}

/** Interactive Worktrees Manager Overlay (`/worktrees`). */
export class WorktreesOverlay implements Component {
  private note = "";

  constructor(
    private readonly theme: HarnessTheme,
    private readonly client: DaemonClient,
    private readonly repoRoot: string,
    private worktrees: LiveWorktreeInfo[],
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (data === "c" || data === "C") {
      this.note = "Sweeping stale/orphaned worktrees (archiving any dirty WIP safely)…";
      this.rerender();
      void this.client
        .request<{ removed: string[]; archivedRefs: string[]; prunedAdminEntries: boolean }>("worktrees.clean", {
          repoRoot: this.repoRoot,
        })
        .then(async (res) => {
          this.note = `Cleaned ${res.removed.length} worktree(s), archived ${res.archivedRefs.length} safety ref(s).`;
          this.worktrees = await this.client.request<LiveWorktreeInfo[]>("worktrees.list", { repoRoot: this.repoRoot });
          this.rerender();
        });
    } else if (data === "r" || data === "R") {
      void this.client.request<LiveWorktreeInfo[]>("worktrees.list", { repoRoot: this.repoRoot }).then((list) => {
        this.worktrees = list;
        this.note = "Refreshed.";
        this.rerender();
      });
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    const lines: string[] = [];
    if (this.note) {
      lines.push(fitWidth(this.theme.success(this.note), width));
      lines.push("");
    }
    if (this.worktrees.length === 0) {
      lines.push(fitWidth(this.theme.muted("No active harness git worktrees."), width));
      return lines;
    }
    lines.push(
      ...renderTable(
        this.worktrees,
        [
          { header: "BRANCH", width: "flex", minWidth: 16, priority: 0, render: (w) => this.theme.bold(w.branch ?? "(detached)") },
          {
            header: "STATE",
            width: 16,
            priority: 1,
            render: (w) =>
              `${w.dirty ? badge("DIRTY", "warning", this.theme) : badge("clean", "success", this.theme)}${w.orphaned ? " " + badge("ORPHAN", "error", this.theme) : ""}`,
          },
          { header: "PATH", width: "flex", minWidth: 18, priority: 2, render: (w) => this.theme.dim(w.path) },
        ],
        width,
        this.theme,
      ),
    );
    return lines.map((l) => clampLine(l, width));
  }
}

/** Interactive 2-stage Knowledge Base Browser (`/kb [query]`). */
export class KbOverlay implements Component {
  private select: SelectList;
  private detail: KbEntry | null = null;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly client: DaemonClient,
    cards: KbCard[],
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {
    const items: SelectItem[] =
      cards.length > 0
        ? cards.map((c) => ({
            value: c.id,
            label: `[${c.kind}/${c.status}] ${c.title}`,
            description: `${c.summary} (hits:${c.hitCount} · globs:${c.pathGlobs.join(",") || "*"})`,
          }))
        : [{ value: "__empty__", label: "No KB entries matched", description: "Agents propose entries via kb_propose." }];

    this.select = new SelectList(items, 12, this.theme.toSelectListTheme());
    this.select.onCancel = () => this.onClose();
    this.select.onSelect = (item) => {
      if (item.value === "__empty__") return;
      void this.client.request<KbEntry[]>("kb.get", { ids: [item.value] }).then((entries) => {
        this.detail = entries[0] ?? null;
        this.rerender();
      });
    };
  }

  handleInput(data: string): void {
    if (this.detail) {
      if (matchesKey(data, "escape") || matchesKey(data, "enter") || data === "b") {
        this.detail = null;
        this.rerender();
      }
      return;
    }
    this.select.handleInput(data);
    this.rerender();
  }

  invalidate(): void {
    this.select.invalidate();
  }

  render(width: number): readonly string[] {
    if (this.detail) {
      const e = this.detail;
      const out: string[] = [
        fitWidth(`${this.theme.bold(e.title)}  ${this.theme.muted(`[${e.kind} · ${e.status} · ${e.confidence}]`)}`, width),
        fitWidth(this.theme.dim(`ID: ${e.id} │ SHA: ${e.verifiedSha?.slice(0, 8) ?? "-"} │ Hits: ${e.hitCount}`), width),
        fitWidth(this.theme.dim(`Globs: ${e.pathGlobs.join(", ") || "*"} │ Evidence: ${e.evidencePaths.join(", ") || "-"}`), width),
        "",
        ...wrapTextWithAnsi(`${this.theme.bold("Summary:")} ${e.summary}`, width),
        "",
        this.theme.bold("Context:"),
        ...wrapTextWithAnsi(e.contextMd, width),
      ];
      return out.map((l) => clampLine(l, width));
    }
    return this.select.render(width).map((l) => clampLine(l, width));
  }
}

/** Interactive Goals Dashboard (`/goals`). */
export class GoalsOverlay implements Component {
  private selected = 0;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly getGoals: () => GoalRecord[],
    private readonly onAction: (action: "review" | "pause" | "cancel" | "inspect", goal: GoalRecord) => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {}

  handleInput(data: string): void {
    const goals = this.getGoals();
    if (matchesKey(data, "escape") || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(Math.max(0, goals.length - 1), this.selected + 1);
      this.rerender();
    } else if (goals[this.selected]) {
      const g = goals[this.selected]!;
      if (data === "r") {
        this.onAction("review", g);
        this.onClose();
      } else if (data === "p") {
        this.onAction("pause", g);
        this.onClose();
      } else if (data === "x") {
        this.onAction("cancel", g);
        this.onClose();
      } else if (matchesKey(data, "enter")) {
        this.onAction("inspect", g);
        this.onClose();
      }
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    const goals = this.getGoals();
    if (goals.length === 0) {
      return [fitWidth(this.theme.muted("No goals yet. Chat with the Director to design & launch a Goal."), width)];
    }

    return renderTable(
      goals.map((g, i) => ({ g, i })),
      [
        {
          header: "GOAL",
          width: "flex",
          minWidth: 20,
          priority: 0,
          render: ({ g, i }) => {
            const marker = i === this.selected ? this.theme.accentBold("▸ ") : "  ";
            const label = i === this.selected ? this.theme.accentBold(`${g.id} v${g.version}`) : this.theme.bold(`${g.id} v${g.version}`);
            return `${marker}${label} ${g.title}`;
          },
        },
        {
          header: "STATUS",
          width: 14,
          priority: 0,
          render: ({ g }) => {
            const tone =
              g.status === "achieved"
                ? "success"
                : g.status === "awaiting_human" || g.status === "cancelled"
                  ? "error"
                  : g.status === "executing" || g.status === "verifying" || g.status === "reviewing"
                    ? "accent"
                    : "neutral";
            return badge(g.status.toUpperCase(), tone, this.theme);
          },
        },
        {
          header: "REVIEWS",
          width: 9,
          align: "right",
          priority: 2,
          render: ({ g }) => this.theme.muted(`${g.reviewCycle}/${g.budgets.maxReviewCycles}`),
        },
        {
          header: "CRITERIA",
          width: 8,
          align: "right",
          priority: 3,
          render: ({ g }) => this.theme.dim(String(g.criteria.length)),
        },
      ],
      width,
      this.theme,
    );
  }
}

/** Interactive Agent Tree Switcher (`Ctrl+T` / `/tree`) for attached runs. */
export class TreeOverlay implements Component {
  private selected = 0;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly getTasks: () => TaskRecord[],
    private readonly getEscalations: () => EscalationRecord[],
    private readonly onSelect: (taskId: string | null) => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
  ) {}

  /** Orders tasks in true parent-child DFS hierarchy so T3 agents nest directly beneath their owning T2 Worker. */
  private orderedTasks(): Array<{ task: TaskRecord; depth: number }> {
    const tasks = this.getTasks();
    const byParent = new Map<string | null, TaskRecord[]>();
    const idSet = new Set(tasks.map((t) => t.id));
    for (const t of tasks) {
      const parentKey = t.parentId && idSet.has(t.parentId) ? t.parentId : null;
      const list = byParent.get(parentKey) ?? [];
      list.push(t);
      byParent.set(parentKey, list);
    }
    const out: Array<{ task: TaskRecord; depth: number }> = [];
    const visit = (parentId: string | null, depth: number) => {
      for (const child of byParent.get(parentId) ?? []) {
        out.push({ task: child, depth });
        visit(child.id, depth + 1);
      }
    };
    visit(null, 0);
    return out;
  }

  handleInput(data: string): void {
    const ordered = this.orderedTasks();
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+t") || data === "q") {
      this.onClose();
      return;
    }
    if (matchesKey(data, "up") || data === "k") {
      this.selected = Math.max(0, this.selected - 1);
      this.rerender();
    } else if (matchesKey(data, "down") || data === "j") {
      this.selected = Math.min(ordered.length, this.selected + 1);
      this.rerender();
    } else if (matchesKey(data, "enter")) {
      if (this.selected === 0) this.onSelect(null);
      else this.onSelect(ordered[this.selected - 1]?.task.id ?? null);
      this.onClose();
    }
  }

  invalidate(): void {}

  render(width: number): readonly string[] {
    const ordered = this.orderedTasks();
    const escs = this.getEscalations();
    const lines: string[] = [];

    const allActive = this.selected === 0;
    const allRow = `${allActive ? this.theme.accentBold("▸ ") : "  "}${allActive ? this.theme.accentBold("[ALL] Entire Run Stream") : "[ALL] Entire Run Stream"}`;
    lines.push(allActive ? fillLineBg(allRow, width, this.theme.badgeBg) : fitWidth(allRow, width));

    const maxVisible = 12;
    const startIdx = Math.max(0, Math.min(this.selected - 1 - Math.floor(maxVisible / 2), ordered.length - maxVisible));
    const slice = ordered.slice(startIdx, startIdx + maxVisible);

    for (let i = 0; i < slice.length; i++) {
      const idx = startIdx + i;
      const { task: t, depth } = slice[i]!;
      const indent = depth === 0 ? "" : "  ".repeat(depth - 1) + this.theme.dim("└─ ");
      const active = this.selected === idx + 1;
      const marker = active ? this.theme.accentBold("▸ ") : "  ";
      const statusTone =
        t.status === "completed"
          ? "success"
          : t.status === "failed" || t.status === "cancelled"
            ? "error"
            : t.status === "running"
              ? "accent"
              : "neutral";
      const ctx = t.contextSize > 0 ? ` ${Math.round((t.contextUsed / t.contextSize) * 100)}%` : "";
      const row = `${marker}${indent}${badge(`T${t.tier}:${t.status}`, statusTone, this.theme)} ${active ? this.theme.accentBold(t.id) : this.theme.bold(t.id)} ${t.title} ${this.theme.dim(`(${t.model ?? t.profileId}${ctx})`)}`;
      lines.push(active ? fillLineBg(row, width, this.theme.badgeBg) : fitWidth(row, width));
    }

    if (ordered.length > maxVisible) {
      lines.push(fitWidth(this.theme.dim(`  ${Math.min(this.selected, ordered.length)}/${ordered.length} tasks`), width));
    }

    if (escs.length > 0) {
      lines.push("");
      lines.push(fitWidth(this.theme.warning(`Open Escalations (${escs.length}):`), width));
      for (const e of escs.slice(0, 5)) {
        lines.push(fitWidth(`  ${badge(`${e.severity}/${e.category}`, "error", this.theme)} ${e.id}: ${e.title}`, width));
      }
    }

    return lines;
  }
}

/** Clean human-readable Goal Review scorecard lines (for `SystemCard` in scrollback). */
export function formatGoalReviewCard(
  outcome: {
    goal: GoalRecord;
    review: GoalReviewVerdict;
    circuitBreakerTripped?: string;
  },
  theme: HarnessTheme,
): string[] {
  const { goal, review, circuitBreakerTripped } = outcome;
  const verdictBadge =
    review.verdict === "approved"
      ? badge("APPROVED ✓", "success", theme)
      : review.verdict === "escalate_human"
        ? badge("ESCALATE TO HUMAN", "error", theme)
        : badge("CHANGES REQUESTED", "warning", theme);

  const lines = [
    `${theme.bold(`Review #${review.cycle}`)} for ${theme.accent(goal.id)} v${goal.version} (${goal.title}): ${verdictBadge} → ${goal.status}`,
    theme.muted(review.summary),
  ];
  for (const c of review.criteriaResults) {
    const icon = c.passed ? theme.success("✓") : theme.error("✗");
    lines.push(`${icon} [${c.criterionId}] ${c.evidence}`);
    if (c.remediation) lines.push(`  → ${theme.warning("Fix:")} ${c.remediation}`);
  }
  for (const b of review.blockingIssues) {
    lines.push(`${theme.error("! Blocker:")} ${b}`);
  }
  if (circuitBreakerTripped) {
    lines.push(`${theme.error("⚡ Circuit Breaker:")} ${circuitBreakerTripped}`);
  }
  return lines;
}

/** Clean human-readable Goal Detail lines (for `SystemCard` in scrollback). */
export function formatGoalDetailCard(goal: GoalRecord, reviews: GoalReviewVerdict[], theme: HarnessTheme): string[] {
  const lines = [
    `${theme.bold(`Goal ${goal.id}`)} v${goal.version} [${badge(goal.status.toUpperCase(), "accent", theme)}]: ${goal.title}`,
    theme.muted(goal.description),
    theme.dim(`Review cycles: ${goal.reviewCycle}/${goal.budgets.maxReviewCycles} │ Run: ${goal.linkedRunId ?? "(draft)"}`),
    theme.bold("Criteria:"),
  ];
  const latestRev = reviews[reviews.length - 1];
  const revById = new Map((latestRev?.criteriaResults ?? []).map((r) => [r.criterionId, r]));
  for (const c of goal.criteria) {
    const res = revById.get(c.id);
    const icon = !res ? theme.dim("○") : res.passed ? theme.success("✓") : theme.error("✗");
    lines.push(
      `  ${icon} [${c.id}] (${c.kind}${c.required ? "*" : ""}) ${c.description}${c.command ? ` ${theme.code(c.command)}` : ""}`,
    );
  }
  if (goal.nonGoals.length > 0) {
    lines.push(`${theme.muted("Non-goals:")} ${goal.nonGoals.join("; ")}`);
  }
  if (goal.lastReviewSummary) {
    lines.push(`${theme.muted("Latest review:")} ${goal.lastReviewSummary}`);
  }
  return lines;
}
