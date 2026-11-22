import { matchesKey } from "@earendil-works/pi-tui";
import {
  type CompiledModelCatalog,
  type CompiledModelEntry,
  isModelEnabledInCatalog,
} from "../catalog/compiler.js";
import {
  ACP_PROFILE_PRESETS,
  type AcpProfileConfig,
  type HarnessConfig,
  type RunnerProfileConfig,
} from "../config.js";
import type { DaemonClient } from "../daemon/remote.js";
import {
  clamp,
  type ColumnSpec,
  Frame,
  type FrameTab,
  handleTabKeys,
  type Hint,
  isPopKey,
  type Navigator,
  sanitizeLine,
  type Screen,
  type ScreenContext,
  TableListView,
  tag,
  type Theme,
} from "./core/index.js";

export type SettingsTabId = "clis" | "models" | "runtime";

const SETTINGS_TABS: readonly SettingsTabId[] = ["clis", "models", "runtime"];

const CLI_COLUMNS: ColumnSpec[] = [
  { key: "status", header: "STATUS", width: 8, priority: 0 },
  { key: "profile", header: "PROFILE", width: 16, priority: 0 },
  { key: "billing", header: "BILLING", width: 12, priority: 2 },
  { key: "command", header: "COMMAND", minWidth: 16, priority: 1 },
];

const MODEL_COLUMNS: ColumnSpec[] = [
  { key: "on", header: "ON", width: 5, priority: 0 },
  { key: "model", header: "MODEL", minWidth: 18, priority: 0 },
  { key: "provider", header: "PROVIDER", width: 12, priority: 2 },
  { key: "route", header: "ROUTE", width: 16, priority: 1 },
  { key: "score", header: "SCORE", width: 7, align: "right", priority: 2 },
];

const RUNTIME_COLUMNS: ColumnSpec[] = [
  { key: "setting", header: "SETTING", width: 32, priority: 0 },
  { key: "value", header: "VALUE", width: 22, priority: 0 },
  { key: "note", header: "OPTIONS / DESCRIPTION", minWidth: 16, priority: 2 },
];

interface RuntimeSettingRow {
  id: string;
  label: string;
  value: string;
  note: string;
  kind: "cycle" | "prompt";
  values?: string[];
  allowEmpty?: boolean;
  placeholder?: string;
}

/**
 * Dialog for adding a preset ACP CLI (`claude`, `codex`, `gemini`, `opencode`, `amp`, `antigravity`)
 * or a custom external ACP CLI (`<id> <cmd> [args...]`).
 */
class AddCliDialogScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Add ACP CLI";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<{ kind: "preset"; key: string } | { kind: "custom" }>({
    columns: [
      { key: "id", header: "PROFILE", width: 18, priority: 0 },
      { key: "cmd", header: "COMMAND", minWidth: 18, priority: 1 },
    ],
  });

  constructor(
    private readonly existingIds: Set<string>,
    private readonly onAdd: (profile: AcpProfileConfig) => Promise<void>,
  ) {
    const presetRows = Object.entries(ACP_PROFILE_PRESETS)
      .filter(([key]) => !this.existingIds.has(`acp:${key}`))
      .map(([key, preset]) => ({
        id: `preset:${key}`,
        value: { kind: "preset" as const, key },
        searchText: `acp:${key} ${preset.command} ${(preset.args ?? []).join(" ")}`,
        cells: (sel: boolean, theme: Theme) => ({
          id: sel ? theme.accentBold(`+ acp:${key}`) : theme.ok(`+ acp:${key}`),
          cmd: theme.muted(`${preset.command} ${(preset.args ?? []).join(" ")}`.trim()),
        }),
      }));

    this.list.setTableItems([
      ...presetRows,
      {
        id: "add:custom",
        value: { kind: "custom" as const },
        searchText: "custom acp cli command args",
        cells: (sel: boolean, theme: Theme) => ({
          id: sel ? theme.accentBold("+ Custom ACP CLI…") : theme.accent("+ Custom ACP CLI…"),
          cmd: theme.muted("<id> <command> [args...]  (e.g. acp:mycli mycli --acp)"),
        }),
      },
    ]);
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Settings", "Add ACP CLI"],
      subtitle: "Select a preset ACP CLI or add a custom executable",
      hints: [
        { key: "Enter", label: "add" },
        { key: "Esc", label: "cancel" },
      ],
      renderBody: (innerW, bodyH) => this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    if (isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }

    const res = this.list.handleInput(data);
    if (res === "select") {
      const sel = this.list.selectedItem()?.value;
      if (!sel) return;
      if (sel.kind === "preset") {
        const preset = ACP_PROFILE_PRESETS[sel.key];
        if (!preset) return;
        const profile: AcpProfileConfig = { id: `acp:${sel.key}`, ...preset };
        void this.onAdd(profile)
          .then(() => ctx.navigator.pop())
          .catch((err) => {
            this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
            ctx.requestRender();
          });
        return;
      }
      this.frame.askPrompt({
        label: "Custom CLI (<id> <cmd> [args...])",
        placeholder: "acp:mycli mycli --acp",
        onSubmit: async (raw) => {
          const parts = raw.split(/\s+/).filter(Boolean);
          if (parts.length < 2) {
            this.frame.setNotice("Need at least <id> and <command>", "warn");
            ctx.requestRender();
            return;
          }
          const [id, command, ...args] = parts;
          const profile: AcpProfileConfig = {
            id: id!,
            kind: "acp",
            adapter: "generic",
            command: command!,
            args,
            billing: "subscription",
            enabled: true,
          };
          await this.onAdd(profile);
          ctx.navigator.pop();
        },
      });
      ctx.requestRender();
      return;
    }
    if (res === "handled") ctx.requestRender();
  }
}

/**
 * Full-parity 3-tab Settings screen (`/settings`, `Ctrl+,`):
 *  - Tab 1: ACP CLIs & Profiles (`profiles.upsert`, `profiles.probe`, `profiles.remove`, presets + custom)
 *  - Tab 2: Enabled Models (`models.list({ includeDisabled: true })`, Space/Enter toggle, `x` Toggle All Off, `a` Enable All)
 *  - Tab 3: Defaults & Runtime (validated enum cycle controls + Quota Endpoint URL with `allowEmpty: true` clear)
 */
export class SettingsScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Settings";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private activeTab: SettingsTabId;
  private config: HarnessConfig | null = null;
  private allModels: CompiledModelEntry[] = [];
  private loadingConfig = true;
  private loadingModels = false;
  private modelsLoaded = false;

  private readonly cliList = new TableListView<RunnerProfileConfig>({
    columns: CLI_COLUMNS,
    emptyText: "No profiles configured. Press 'a' to add an ACP CLI.",
  });
  private readonly modelList = new TableListView<CompiledModelEntry>({
    columns: MODEL_COLUMNS,
    emptyText: "No models found in catalog. Press 'r' to sync or enable an ACP CLI in Tab 1.",
  });
  private readonly runtimeList = new TableListView<RuntimeSettingRow>({
    columns: RUNTIME_COLUMNS,
    emptyText: "Loading settings...",
  });

  constructor(
    private readonly client: DaemonClient,
    private readonly opts?: {
      repoRoot?: string;
      initialTab?: SettingsTabId;
      onConfigChanged?: (cfg: HarnessConfig) => void;
    },
  ) {
    this.activeTab = opts?.initialTab ?? "clis";
  }

  get currentTab(): SettingsTabId {
    return this.activeTab;
  }

  private get repoRoot(): string {
    return this.opts?.repoRoot ?? process.cwd();
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.loadConfig(ctx);
    if (this.activeTab === "models") {
      void this.loadModels(ctx);
    }
  }

  private async loadConfig(ctx: ScreenContext): Promise<void> {
    this.loadingConfig = true;
    ctx.requestRender();
    try {
      this.config = await this.client.request<HarnessConfig>("config.get");
      this.rebuildCliList();
      this.rebuildRuntimeList();
      if (this.modelsLoaded) this.rebuildModelList();
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loadingConfig = false;
      ctx.requestRender();
    }
  }

  private async loadModels(ctx: ScreenContext, forceSync = false): Promise<void> {
    this.loadingModels = true;
    ctx.requestRender();
    try {
      const cat = await this.client.request<CompiledModelCatalog>(forceSync ? "models.sync" : "models.list", {
        cwd: this.repoRoot,
        includeDisabled: true,
      });
      this.allModels = cat.models ?? [];
      this.modelsLoaded = true;
      this.rebuildModelList();
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loadingModels = false;
      ctx.requestRender();
    }
  }

  private isModelEnabled(modelId: string): boolean {
    return isModelEnabledInCatalog(modelId, this.config?.catalog);
  }

  private enabledModelCount(): number {
    return this.allModels.filter((m) => this.isModelEnabled(m.id)).length;
  }

  private rebuildCliList(): void {
    if (!this.config) return;
    this.cliList.setTableItems(
      this.config.profiles.map((p) => {
        const enabled = p.enabled !== false;
        const cmd =
          p.kind === "acp"
            ? `${p.command} ${(p.args ?? []).join(" ")}`.trim()
            : `pi provider: ${p.provider}`;
        return {
          id: p.id,
          value: p,
          searchText: `${p.id} ${p.kind} ${p.billing} ${enabled ? "on" : "off"} ${cmd}`,
          cells: (sel, theme) => ({
            status: enabled ? tag("ON", "ok", theme) : tag("OFF", "muted", theme),
            profile: sel ? theme.accentBold(p.id) : enabled ? theme.bold(p.id) : theme.dim(p.id),
            billing: theme.muted(p.billing),
            command: enabled ? theme.muted(cmd) : theme.dim(cmd),
          }),
        };
      }),
    );
  }

  private rebuildModelList(): void {
    this.modelList.setTableItems(
      this.allModels.map((m) => {
        const on = this.isModelEnabled(m.id);
        const provider = m.id.includes("/") ? m.id.split("/")[0]! : m.preferredRoute.profileId;
        const routes = [m.preferredRoute, ...(m.alternateRoutes ?? [])]
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

  private rebuildRuntimeList(): void {
    if (!this.config) return;
    const c = this.config;
    const enabledProfiles = c.profiles.filter((p) => p.enabled !== false).map((p) => p.id);
    const profileChoices = enabledProfiles.length > 0 ? enabledProfiles : c.profiles.map((p) => p.id);
    const retrySec = `${Math.round((c.quotaRetry?.nativeRetryTimeoutMs ?? 45_000) / 1000)}s`;
    const orchPct = `${Math.round((c.rollover?.orchestratorThreshold ?? 0.72) * 100)}%`;
    const workerPct = `${Math.round((c.rollover?.workerThreshold ?? 0.78) * 100)}%`;

    const rows: RuntimeSettingRow[] = [
      {
        id: "defaultOrchestratorProfile",
        label: "Default Director / Orchestrator CLI",
        value: c.defaultOrchestratorProfile ?? profileChoices[0] ?? "(none)",
        note: `cycles enabled CLIs (${profileChoices.join(", ") || "none"})`,
        kind: "cycle",
        values: profileChoices,
      },
      {
        id: "defaultWorkerProfile",
        label: "Default Worker CLI",
        value: c.defaultWorkerProfile ?? profileChoices[0] ?? "(none)",
        note: "Tier 2 feature worker profile",
        kind: "cycle",
        values: profileChoices,
      },
      {
        id: "defaultTaskProfile",
        label: "Default Task CLI",
        value: c.defaultTaskProfile ?? profileChoices[0] ?? "(none)",
        note: "Tier 3 focused task agent profile",
        kind: "cycle",
        values: profileChoices,
      },
      {
        id: "codeMode",
        label: "Code Mode",
        value: c.codeMode ?? "collapsed",
        note: "collapsed | hybrid | off",
        kind: "cycle",
        values: ["collapsed", "hybrid", "off"],
      },
      {
        id: "quotaEndpointUrl",
        label: "Quota Endpoint URL",
        value: c.quotaEndpoint?.url ?? "(none)",
        note: "HTTP(S) or unix:// URL (submit blank to clear)",
        kind: "prompt",
        allowEmpty: true,
        placeholder: "http://127.0.0.1:9090/v1/quota (blank to clear)",
      },
      {
        id: "quotaFormat",
        label: "Quota Wire Format",
        value: c.quotaEndpoint?.format ?? "protojson",
        note: "protojson | protobuf",
        kind: "cycle",
        values: ["protojson", "protobuf"],
      },
      {
        id: "quotaNativeRetryTimeout",
        label: "Quota Native Retry Timeout",
        value: retrySec,
        note: "15s | 30s | 45s | 60s | 90s | 120s",
        kind: "cycle",
        values: ["15s", "30s", "45s", "60s", "90s", "120s"],
      },
      {
        id: "quotaAutoResume",
        label: "Quota Auto-Resume",
        value: c.quotaRetry?.autoResumeEnabled !== false ? "on" : "off",
        note: "auto-restart paused runs when quota recovers",
        kind: "cycle",
        values: ["on", "off"],
      },
      {
        id: "orchestratorThreshold",
        label: "Orchestrator Rollover Threshold",
        value: orchPct,
        note: "60% | 65% | 72% | 75% | 80%",
        kind: "cycle",
        values: ["60%", "65%", "72%", "75%", "80%"],
      },
      {
        id: "workerThreshold",
        label: "Worker Rollover Threshold",
        value: workerPct,
        note: "65% | 70% | 75% | 78% | 82% | 85%",
        kind: "cycle",
        values: ["65%", "70%", "75%", "78%", "82%", "85%"],
      },
      {
        id: "maxConcurrentWorkers",
        label: "Max Concurrent Workers",
        value: String(c.worktree?.maxConcurrentWorkers ?? 4),
        note: "1 | 2 | 3 | 4 | 5 | 6 | 7 | 8",
        kind: "cycle",
        values: ["1", "2", "3", "4", "5", "6", "7", "8"],
      },
      {
        id: "preferSubscription",
        label: "Prefer Subscription Routes",
        value: c.catalog?.preferSubscription !== false ? "on" : "off",
        note: "prefer $0 subscription CLIs over API routes",
        kind: "cycle",
        values: ["on", "off"],
      },
    ];

    this.runtimeList.setTableItems(
      rows.map((r) => ({
        id: r.id,
        value: r,
        searchText: `${r.id} ${r.label} ${r.value} ${r.note}`,
        cells: (sel, theme) => ({
          setting: sel ? theme.accentBold(r.label) : theme.bold(r.label),
          value: r.value === "(none)" ? theme.dim(r.value) : sel ? theme.warn(theme.bold(r.value)) : theme.accent(r.value),
          note: theme.muted(r.note),
        }),
      })),
    );
  }

  private activeList() {
    if (this.activeTab === "clis") return this.cliList;
    if (this.activeTab === "models") return this.modelList;
    return this.runtimeList;
  }

  private setTab(next: SettingsTabId, ctx: ScreenContext): void {
    this.activeTab = next;
    if (next === "models" && !this.modelsLoaded && !this.loadingModels) {
      void this.loadModels(ctx);
    }
  }

  private async patchConfig(patch: Record<string, unknown>, notice: string, ctx: ScreenContext): Promise<void> {
    try {
      const next = await this.client.request<HarnessConfig>("config.update", { patch });
      this.config = next;
      this.opts?.onConfigChanged?.(next);
      this.rebuildCliList();
      this.rebuildRuntimeList();
      if (this.modelsLoaded) this.rebuildModelList();
      this.frame.setNotice(notice, "ok");
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    }
    ctx.requestRender();
  }

  private probeProfileLive(profileId: string, prefix: string, ctx: ScreenContext): void {
    this.frame.setNotice(`${prefix} — probing ${profileId}…`, "info");
    ctx.requestRender();
    void this.client
      .request<{ id: string; models: Array<{ wireModelId?: string }> }>("profiles.probe", {
        id: profileId,
        cwd: this.repoRoot,
      })
      .then(
        (res) => {
          const n = res.models?.length ?? 0;
          this.frame.setNotice(
            n > 0 ? `${profileId}: ${n} model(s) ready` : `${profileId}: connected, 0 models reported`,
            n > 0 ? "ok" : "warn",
          );
          ctx.requestRender();
        },
        (err) => {
          const msg = sanitizeLine(err instanceof Error ? err.message : String(err));
          this.frame.setNotice(`Probe ${profileId} failed: ${msg}`, "danger");
          ctx.requestRender();
        },
      );
  }

  private async toggleCliProfile(profile: RunnerProfileConfig, ctx: ScreenContext): Promise<void> {
    const updated: RunnerProfileConfig = { ...profile, enabled: profile.enabled === false };
    try {
      const next = await this.client.request<HarnessConfig>("profiles.upsert", { profile: updated });
      this.config = next;
      this.opts?.onConfigChanged?.(next);
      this.rebuildCliList();
      this.rebuildRuntimeList();
      this.modelsLoaded = false; // Catalog invalidated when profiles change
      if (updated.enabled) {
        this.probeProfileLive(profile.id, `Enabled ${profile.id}`, ctx);
      } else {
        this.frame.setNotice(`Disabled ${profile.id}`, "ok");
        ctx.requestRender();
      }
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
      ctx.requestRender();
    }
  }

  private saveModelFilter(
    patch: { modelFilterMode: "all" | "allowlist"; enabledModels: string[]; disabledModels: string[] },
    note: string,
    ctx: ScreenContext,
  ): void {
    if (!this.config) return;
    const nextCatalog = { ...this.config.catalog, ...patch };
    // Optimistic local update for snappy toggles
    this.config = { ...this.config, catalog: nextCatalog };
    this.rebuildModelList();
    this.frame.setNotice(note, "info");
    ctx.requestRender();
    void this.patchConfig({ catalog: nextCatalog }, note, ctx);
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

  private applyRuntimeValue(row: RuntimeSettingRow, nextValue: string, ctx: ScreenContext): void {
    if (!this.config) return;
    const c = this.config;
    switch (row.id) {
      case "defaultOrchestratorProfile":
      case "defaultWorkerProfile":
      case "defaultTaskProfile":
        void this.patchConfig({ [row.id]: nextValue }, `${row.label} → ${nextValue}`, ctx);
        return;
      case "codeMode":
        void this.patchConfig({ codeMode: nextValue }, `Code Mode → ${nextValue}`, ctx);
        return;
      case "quotaEndpointUrl":
        void this.patchConfig(
          { quotaEndpoint: nextValue ? { ...(c.quotaEndpoint ?? {}), url: nextValue } : null },
          nextValue ? `Quota Endpoint → ${nextValue}` : "Cleared Quota Endpoint URL",
          ctx,
        );
        return;
      case "quotaFormat":
        if (!c.quotaEndpoint?.url) {
          this.frame.setNotice("Set Quota Endpoint URL first before changing wire format", "warn");
          ctx.requestRender();
          return;
        }
        void this.patchConfig(
          { quotaEndpoint: { ...c.quotaEndpoint, format: nextValue } },
          `Quota Wire Format → ${nextValue}`,
          ctx,
        );
        return;
      case "quotaNativeRetryTimeout": {
        const sec = Number(nextValue.replace(/s$/i, ""));
        if (Number.isFinite(sec) && sec > 0) {
          void this.patchConfig(
            { quotaRetry: { ...c.quotaRetry, nativeRetryTimeoutMs: sec * 1000 } },
            `Quota Native Retry Timeout → ${nextValue}`,
            ctx,
          );
        }
        return;
      }
      case "quotaAutoResume":
        void this.patchConfig(
          { quotaRetry: { ...c.quotaRetry, autoResumeEnabled: nextValue === "on" } },
          `Quota Auto-Resume → ${nextValue}`,
          ctx,
        );
        return;
      case "orchestratorThreshold":
        void this.patchConfig(
          { rollover: { ...c.rollover, orchestratorThreshold: Number(nextValue.replace("%", "")) / 100 } },
          `Orchestrator Rollover → ${nextValue}`,
          ctx,
        );
        return;
      case "workerThreshold":
        void this.patchConfig(
          { rollover: { ...c.rollover, workerThreshold: Number(nextValue.replace("%", "")) / 100 } },
          `Worker Rollover → ${nextValue}`,
          ctx,
        );
        return;
      case "maxConcurrentWorkers":
        void this.patchConfig(
          { worktree: { ...c.worktree, maxConcurrentWorkers: Number(nextValue) } },
          `Max Concurrent Workers → ${nextValue}`,
          ctx,
        );
        return;
      case "preferSubscription":
        void this.patchConfig(
          { catalog: { ...c.catalog, preferSubscription: nextValue === "on" } },
          `Prefer Subscription Routes → ${nextValue}`,
          ctx,
        );
        return;
    }
  }

  private activateRuntimeRow(row: RuntimeSettingRow, ctx: ScreenContext): void {
    if (row.kind === "prompt") {
      this.frame.askPrompt({
        label: row.label,
        initialValue: row.value === "(none)" ? "" : row.value,
        placeholder: row.placeholder,
        allowEmpty: row.allowEmpty,
        onSubmit: async (val) => {
          this.applyRuntimeValue(row, val, ctx);
        },
      });
      ctx.requestRender();
      return;
    }
    const vals = row.values ?? [];
    if (vals.length === 0) return;
    const idx = vals.indexOf(row.value);
    const next = vals[(idx + 1 + vals.length) % vals.length]!;
    this.applyRuntimeValue(row, next, ctx);
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const enabledClis = this.config ? this.config.profiles.filter((p) => p.enabled !== false).length : 0;
    const tabs: FrameTab[] = [
      { id: "clis", label: "ACP CLIs & Profiles", count: enabledClis },
      { id: "models", label: "Enabled Models", count: this.modelsLoaded ? this.enabledModelCount() : undefined },
      { id: "runtime", label: "Defaults & Runtime" },
    ];

    const hints: Hint[] =
      this.activeTab === "clis"
        ? [
            { key: "Space/Enter", label: "toggle" },
            { key: "a", label: "add CLI" },
            { key: "p", label: "probe" },
            { key: "x", label: "remove" },
            { key: "←→/Tab/1-3", label: "tabs" },
            { key: "Esc", label: "close" },
          ]
        : this.activeTab === "models"
          ? [
              { key: "Space/Enter", label: "toggle" },
              { key: "x", label: "all off" },
              { key: "a", label: "enable all" },
              { key: "/", label: "filter" },
              { key: "←→/Tab/1-3", label: "tabs" },
              { key: "Esc", label: "close" },
            ]
          : [
              { key: "Enter/Space", label: "change" },
              { key: "/", label: "filter" },
              { key: "←→/Tab/1-3", label: "tabs" },
              { key: "Esc", label: "close" },
            ];

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Settings"],
      rightHeader:
        this.loadingConfig || this.loadingModels
          ? theme.accent("loading...")
          : this.activeTab === "models" && this.modelsLoaded
            ? theme.muted(`${this.enabledModelCount()}/${this.allModels.length} enabled`)
            : undefined,
      tabs,
      activeTabId: this.activeTab,
      hints,
      renderBody: (innerW, bodyH) => {
        if (this.loadingConfig && !this.config) return [theme.muted("Loading configuration...")];

        if (this.activeTab === "clis") {
          return this.cliList.render(innerW, bodyH, theme);
        }

        if (this.activeTab === "models") {
          if (this.loadingModels && !this.modelsLoaded) return [theme.muted("Loading model catalog...")];
          const out: string[] = [];
          let listH = bodyH;
          const isAllowlistEmpty =
            this.config?.catalog?.modelFilterMode === "allowlist" &&
            (this.config.catalog.enabledModels?.length ?? 0) === 0;
          if (isAllowlistEmpty) {
            out.push(
              clamp(
                theme.warn(
                  `${theme.glyphs.warn} Allowlist is empty (0 models enabled) — press Space/Enter to enable models or 'a' to enable all.`,
                ),
                innerW,
              ),
            );
            listH = Math.max(1, bodyH - 1);
          }
          out.push(...this.modelList.render(innerW, listH, theme));
          return out;
        }

        return this.runtimeList.render(innerW, bodyH, theme);
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    const list = this.activeList();
    if (list.isFiltering) {
      const res = list.handleInput(data);
      if (res === "select") {
        this.handleSelect(ctx);
        return;
      }
      ctx.requestRender();
      return;
    }

    if (matchesKey(data, "escape") && list.handleEscape()) {
      ctx.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+,") || isPopKey(data, ctx)) {
      ctx.navigator.pop();
      return;
    }

    if (
      handleTabKeys(data, SETTINGS_TABS, this.activeTab, (next) => {
        this.setTab(next, ctx);
      })
    ) {
      ctx.requestRender();
      return;
    }

    if (this.activeTab === "clis") {
      if (matchesKey(data, "space")) {
        const sel = this.cliList.selectedItem()?.value;
        if (sel) void this.toggleCliProfile(sel, ctx);
        return;
      }
      if (data === "a" && this.config) {
        const existing = new Set(this.config.profiles.map((p) => p.id));
        ctx.navigator.push(
          new AddCliDialogScreen(existing, async (profile) => {
            const next = await this.client.request<HarnessConfig>("profiles.upsert", { profile });
            this.config = next;
            this.opts?.onConfigChanged?.(next);
            this.rebuildCliList();
            this.rebuildRuntimeList();
            this.modelsLoaded = false;
            this.probeProfileLive(profile.id, `Added ${profile.id}`, ctx);
          }),
        );
        return;
      }
      if (data === "p") {
        const sel = this.cliList.selectedItem()?.value;
        if (sel) this.probeProfileLive(sel.id, "Probing", ctx);
        return;
      }
      if (data === "x") {
        const sel = this.cliList.selectedItem()?.value;
        if (sel) {
          this.frame.askConfirm({
            message: `Remove profile ${sel.id} from config?`,
            onConfirm: async () => {
              const next = await this.client.request<HarnessConfig>("profiles.remove", { id: sel.id });
              this.config = next;
              this.opts?.onConfigChanged?.(next);
              this.rebuildCliList();
              this.rebuildRuntimeList();
              this.modelsLoaded = false;
              this.frame.setNotice(`Removed ${sel.id}`, "ok");
              ctx.requestRender();
            },
          });
          ctx.requestRender();
        }
        return;
      }
    } else if (this.activeTab === "models") {
      if (matchesKey(data, "space")) {
        const sel = this.modelList.selectedItem()?.value;
        if (sel) this.toggleModel(sel.id, ctx);
        return;
      }
      if (data === "x" || data === "X" || matchesKey(data, "ctrl+x")) {
        this.saveModelFilter(
          { modelFilterMode: "allowlist", enabledModels: [], disabledModels: [] },
          "All models turned OFF — press Space/Enter to pick models or 'a' to enable all.",
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
      if (data === "r" || matchesKey(data, "ctrl+r")) {
        void this.loadModels(ctx, true);
        return;
      }
    } else if (this.activeTab === "runtime") {
      if (matchesKey(data, "space")) {
        const sel = this.runtimeList.selectedItem()?.value;
        if (sel) this.activateRuntimeRow(sel, ctx);
        return;
      }
    }

    const res = list.handleInput(data);
    if (res === "select") {
      this.handleSelect(ctx);
      return;
    }
    if (res === "handled") ctx.requestRender();
  }

  private handleSelect(ctx: ScreenContext): void {
    if (this.activeTab === "clis") {
      const sel = this.cliList.selectedItem()?.value;
      if (sel) void this.toggleCliProfile(sel, ctx);
    } else if (this.activeTab === "models") {
      const sel = this.modelList.selectedItem()?.value;
      if (sel) this.toggleModel(sel.id, ctx);
    } else {
      const sel = this.runtimeList.selectedItem()?.value;
      if (sel) this.activateRuntimeRow(sel, ctx);
    }
  }
}
