import {
  Input,
  matchesKey,
  SelectList,
  SettingsList,
  type Component,
  type Focusable,
  type SelectItem,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { ACP_PROFILE_PRESETS, type AcpProfileConfig, type HarnessConfig, type RunnerProfileConfig } from "../config.js";
import type { DaemonClient } from "../daemon/remote.js";
import { ModelConfigOverlay } from "./overlays.js";
import { clampLine, fitWidth, type HarnessTheme } from "./primitives/index.js";

class InlinePromptSubmenu implements Component, Focusable {
  private input: Input;
  private _focused = true;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly title: string,
    private readonly hint: string,
    initialValue: string,
    private readonly onDone: (val?: string) => void,
    private readonly rerender: () => void,
  ) {
    this.input = new Input();
    this.input.setValue(initialValue);
    this.input.focused = true;
    this.input.onSubmit = (v) => this.onDone(v.trim());
    this.input.onEscape = () => this.onDone(undefined);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(val: boolean) {
    this._focused = val;
    this.input.focused = val;
  }

  handleInput(data: string): void {
    this.input.handleInput(data);
    this.rerender();
  }

  invalidate(): void {
    this.input.invalidate();
  }

  render(width: number): readonly string[] {
    const inputLines = this.input.render(Math.max(8, width - 2));
    return [
      fitWidth(this.theme.bold(this.title), width),
      fitWidth(this.theme.muted(this.hint), width),
      "",
      ...inputLines.map((l) => fitWidth(`${this.theme.accentBold("›")} ${l}`, width)),
      "",
      fitWidth(this.theme.dim("Enter: save · Esc: cancel"), width),
    ];
  }
}

/**
 * Interactive External Harness CLI Manager submenu:
 * - Toggle existing ACP / pi profiles on or off
 * - Add preset ACP CLIs (`claude`, `codex`, `gemini`, `opencode`, `amp`)
 * - Add custom external ACP CLI (`<id> <command> [args...]`)
 * - Remove a profile
 * All mutations persist to `~/.pi-harness/config.json` and hot-reload inside `harnessd`.
 */
class ExternalCliManagerSubmenu implements Component, Focusable {
  private select: SelectList;
  private customPrompt: InlinePromptSubmenu | null = null;
  private statusMsg = "";
  private statusTone: "success" | "warning" | "error" = "success";
  private _focused = true;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly client: DaemonClient,
    private config: HarnessConfig,
    private readonly onConfigChanged: (cfg: HarnessConfig) => void,
    private readonly onDone: (summary?: string) => void,
    private readonly rerender: () => void,
  ) {
    this.select = this.buildSelect();
  }

  private probeProfileLive(profileId: string, prefix: string): void {
    this.statusTone = "warning";
    this.statusMsg = `${prefix} — probing ACP models…`;
    this.rerender();
    void this.client
      .request<{ id: string; models: Array<{ wireModelId: string }> }>("profiles.probe", { id: profileId })
      .then(
        (res) => {
          if (res.models.length > 0) {
            this.statusTone = "success";
            this.statusMsg = `✓ ${profileId}: ${res.models.length} model(s) ready — open /model to select!`;
          } else {
            this.statusTone = "warning";
            this.statusMsg = `⚠ ${profileId}: connected, but reported 0 models`;
          }
          this.rerender();
        },
        (err) => {
          this.statusTone = "error";
          const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "probe failed";
          this.statusMsg = `✗ ${profileId}: ${msg}`;
          this.rerender();
        },
      );
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(val: boolean) {
    this._focused = val;
    if (this.customPrompt) this.customPrompt.focused = val;
  }

  private buildSelect(): SelectList {
    const items: SelectItem[] = [
      ...this.config.profiles.map((p) => ({
        value: `toggle:${p.id}`,
        label: `[${p.enabled !== false ? "ON " : "OFF"}] ${p.id}`,
        description:
          p.kind === "acp"
            ? `(${p.billing}) ${p.command} ${(p.args ?? []).join(" ")}`
            : `(${p.billing}) pi provider: ${p.provider}`,
      })),
      ...Object.keys(ACP_PROFILE_PRESETS)
        .filter((k) => !this.config.profiles.some((p) => p.id === `acp:${k}`))
        .map((k) => ({
          value: `preset:${k}`,
          label: `+ acp:${k}`,
          description: `Add preset: ${ACP_PROFILE_PRESETS[k]!.command} ${(ACP_PROFILE_PRESETS[k]!.args ?? []).join(" ")}`,
        })),
      {
        value: "add:custom",
        label: "+ custom ACP CLI…",
        description: "Format: <id> <command> [args...] (e.g. acp:mycli mycli --acp)",
      },
      ...this.config.profiles.map((p) => ({
        value: `remove:${p.id}`,
        label: `× remove ${p.id}`,
        description: "Delete from ~/.pi-harness/config.json",
      })),
    ];

    const list = new SelectList(items, 12, this.theme.toSelectListTheme());
    list.onCancel = () => this.onDone(`${this.config.profiles.filter((p) => p.enabled !== false).length} enabled`);
    list.onSelect = (item) => void this.handleAction(item.value);
    return list;
  }

  private async handleAction(val: string): Promise<void> {
    try {
      if (val.startsWith("toggle:")) {
        const id = val.slice("toggle:".length);
        const cur = this.config.profiles.find((p) => p.id === id);
        if (!cur) return;
        const updated: RunnerProfileConfig = { ...cur, enabled: cur.enabled === false };
        const nextCfg = await this.client.request<HarnessConfig>("profiles.upsert", { profile: updated });
        this.config = nextCfg;
        this.onConfigChanged(nextCfg);
        this.select = this.buildSelect();
        if (updated.enabled) {
          this.probeProfileLive(id, `Enabled ${id}`);
        } else {
          this.statusTone = "success";
          this.statusMsg = `Disabled ${id} (catalog cache invalidated)`;
          this.rerender();
        }
      } else if (val.startsWith("preset:")) {
        const key = val.slice("preset:".length);
        const preset = ACP_PROFILE_PRESETS[key];
        if (!preset) return;
        const profile: AcpProfileConfig = { id: `acp:${key}`, ...preset };
        const nextCfg = await this.client.request<HarnessConfig>("profiles.upsert", { profile });
        this.config = nextCfg;
        this.onConfigChanged(nextCfg);
        this.select = this.buildSelect();
        this.probeProfileLive(profile.id, `Added ${profile.id}`);
      } else if (val === "add:custom") {
        this.customPrompt = new InlinePromptSubmenu(
          this.theme,
          "Add Custom External ACP CLI",
          "Format: <profile-id> <command> [args...]  (e.g. acp:mycli mycli --acp)",
          "",
          (raw) => {
            this.customPrompt = null;
            if (!raw) {
              this.rerender();
              return;
            }
            const parts = raw.split(/\s+/).filter(Boolean);
            if (parts.length < 2) {
              this.statusTone = "warning";
              this.statusMsg = "Need at least <profile-id> and <command>";
              this.rerender();
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
            void this.client.request<HarnessConfig>("profiles.upsert", { profile }).then((nextCfg) => {
              this.config = nextCfg;
              this.onConfigChanged(nextCfg);
              this.select = this.buildSelect();
              this.probeProfileLive(profile.id, `Added ${profile.id}`);
            });
          },
          this.rerender,
        );
        this.rerender();
      } else if (val.startsWith("remove:")) {
        const id = val.slice("remove:".length);
        const nextCfg = await this.client.request<HarnessConfig>("profiles.remove", { id });
        this.config = nextCfg;
        this.onConfigChanged(nextCfg);
        this.statusTone = "success";
        this.statusMsg = `Removed ${id} (catalog cache invalidated)`;
        this.select = this.buildSelect();
        this.rerender();
      }
    } catch (err) {
      this.statusTone = "error";
      this.statusMsg = `Error: ${err instanceof Error ? err.message : String(err)}`;
      this.rerender();
    }
  }

  handleInput(data: string): void {
    if (this.customPrompt) {
      this.customPrompt.handleInput(data);
      return;
    }
    this.select.handleInput(data);
    this.rerender();
  }

  invalidate(): void {
    this.select.invalidate();
    this.customPrompt?.invalidate();
  }

  render(width: number): readonly string[] {
    if (this.customPrompt) return this.customPrompt.render(width);
    const statusPaint =
      this.statusTone === "error"
        ? this.theme.error
        : this.statusTone === "warning"
          ? this.theme.warning
          : this.theme.success;
    const out: string[] = [
      fitWidth(this.theme.bold("External Harness CLIs & Profiles"), width),
      ...(this.statusMsg ? [fitWidth(statusPaint(this.statusMsg), width)] : []),
      "",
      ...this.select.render(width).map((l) => clampLine(l, width)),
    ];
    return out;
  }
}

/**
 * Interactive Settings content wrapped inside `Panel` by `OverlayManager`.
 * Opens via `/settings` or `Ctrl+,`.
 */
export class SettingsOverlay implements Component {
  private list: SettingsList;

  constructor(
    private readonly theme: HarnessTheme,
    private readonly client: DaemonClient,
    private config: HarnessConfig,
    private readonly onConfigChanged: (cfg: HarnessConfig) => void,
    private readonly onClose: () => void,
    private readonly rerender: () => void,
    private readonly repoRoot: string = process.cwd(),
  ) {
    this.list = this.buildList();
  }

  private enabledModelsSummary(): string {
    const mode = this.config.catalog.modelFilterMode ?? "all";
    if (mode === "allowlist") {
      const n = (this.config.catalog.enabledModels ?? []).length;
      return n === 0 ? "0 selected (all off)" : `${n} selected`;
    }
    const disabled = (this.config.catalog.disabledModels ?? []).length;
    return disabled > 0 ? `all minus ${disabled}` : "all (ranked)";
  }

  private buildList(): SettingsList {
    const enabledIds = this.config.profiles.filter((p) => p.enabled !== false).map((p) => p.id);
    const profileChoices = enabledIds.length > 0 ? enabledIds : ["acp:claude"];

    const items: SettingItem[] = [
      {
        id: "profiles",
        label: "External Harness CLIs & Profiles",
        description: "Add, toggle, or remove external ACP CLIs (Claude, Codex, Gemini, OpenCode, Amp, Custom)",
        currentValue: `${enabledIds.length} enabled`,
        submenu: (_cur, done) =>
          new ExternalCliManagerSubmenu(
            this.theme,
            this.client,
            this.config,
            (nextCfg) => {
              this.config = nextCfg;
              this.onConfigChanged(nextCfg);
            },
            (summary) => {
              done(summary);
              // Rebuild SettingsList immediately so Default Director/Worker/Task CLI pickers include new/removed profiles!
              this.list = this.buildList();
              this.rerender();
            },
            this.rerender,
          ),
      },
      {
        id: "enabledModels",
        label: "Configure Enabled Models",
        description: "Toggle ranked models ON/OFF individually, or toggle all OFF to pick just a few",
        currentValue: this.enabledModelsSummary(),
        submenu: (_cur, done) =>
          new ModelConfigOverlay(
            this.theme,
            this.client,
            this.repoRoot,
            this.config,
            (nextCfg) => {
              this.config = nextCfg;
              this.onConfigChanged(nextCfg);
            },
            (summary) => {
              done(summary);
              this.list = this.buildList();
              this.rerender();
            },
            this.rerender,
          ),
      },
      {
        id: "defaultOrchestratorProfile",
        label: "Default Director / Orchestrator CLI",
        description: "Profile used for Tier 0 Director Chat and Tier 1 Orchestrators",
        currentValue: this.config.defaultOrchestratorProfile ?? profileChoices[0]!,
        values: profileChoices,
      },
      {
        id: "defaultWorkerProfile",
        label: "Default Tier 2 Worker CLI",
        description: "Default profile when Orchestrator spawns a feature Worker",
        currentValue: this.config.defaultWorkerProfile ?? profileChoices[0]!,
        values: profileChoices,
      },
      {
        id: "defaultTaskProfile",
        label: "Default Tier 3 Task CLI",
        description: "Default profile for fast/focused Tier 3 Task Agents",
        currentValue: this.config.defaultTaskProfile ?? profileChoices[0]!,
        values: profileChoices,
      },
      {
        id: "quotaEndpointUrl",
        label: "Quota Endpoint URL (ProtoJSON/Protobuf)",
        description: "Optional HTTP(S) or unix:// endpoint implementing proto/quota.proto",
        currentValue: this.config.quotaEndpoint?.url ?? "(none)",
        submenu: (cur, done) =>
          new InlinePromptSubmenu(
            this.theme,
            "Configure Quota Endpoint URL",
            "e.g. http://127.0.0.1:9090/v1/quota  or  unix:///tmp/quota.sock#/v1/quota  (blank to clear)",
            cur === "(none)" ? "" : cur,
            (val) => {
              if (val === undefined) {
                done();
                this.rerender();
                return;
              }
              void this.patchConfig({ quotaEndpoint: val ? { ...(this.config.quotaEndpoint ?? {}), url: val } : null });
              done(val || "(none)");
              this.rerender();
            },
            this.rerender,
          ),
      },
      {
        id: "quotaFormat",
        label: "Quota Endpoint Wire Format",
        description: "protojson (default) or binary protobuf",
        currentValue: this.config.quotaEndpoint?.format ?? "protojson",
        values: ["protojson", "protobuf"],
      },
      {
        id: "quotaNativeRetryTimeout",
        label: "Quota Native Retry Timeout",
        description: "How long to let ACP CLIs retry 429s natively (e.g. sub pool switching) before pausing",
        currentValue: `${Math.round((this.config.quotaRetry?.nativeRetryTimeoutMs ?? 45_000) / 1000)}s`,
        values: ["15s", "30s", "45s", "60s", "90s", "120s"],
      },
      {
        id: "quotaAutoResume",
        label: "Quota Auto-Resume (when reset known)",
        description: "Automatically restart paused runs once Quota Endpoint / reset time indicates capacity",
        currentValue: this.config.quotaRetry?.autoResumeEnabled !== false ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "orchestratorThreshold",
        label: "Orchestrator Rollover Threshold",
        description: "Context utilization triggering Clean Relay Rollover before compaction",
        currentValue: `${Math.round(this.config.rollover.orchestratorThreshold * 100)}%`,
        values: ["60%", "65%", "72%", "75%", "80%"],
      },
      {
        id: "workerThreshold",
        label: "Worker Rollover Threshold",
        description: "Context utilization triggering clean git-worktree Worker rollover",
        currentValue: `${Math.round(this.config.rollover.workerThreshold * 100)}%`,
        values: ["65%", "70%", "75%", "78%", "82%", "85%"],
      },
      {
        id: "maxConcurrentWorkers",
        label: "Max Concurrent Worktree Workers",
        description: "Parallel git worktree cap per run",
        currentValue: String(this.config.worktree.maxConcurrentWorkers ?? 4),
        values: ["1", "2", "4", "6", "8"],
      },
      {
        id: "preferSubscription",
        label: "Catalog: Prefer Subscription Routes",
        description: "Prefer $0 marginal subscription CLIs over API billing in list_models",
        currentValue: this.config.catalog.preferSubscription !== false ? "on" : "off",
        values: ["on", "off"],
      },
    ];

    return new SettingsList(
      items,
      12,
      this.theme.toSettingsListTheme(),
      (id, newValue) => {
        void this.handleChange(id, newValue);
      },
      () => this.onClose(),
      { enableSearch: true },
    );
  }

  private async patchConfig(patch: Record<string, unknown>): Promise<void> {
    const next = await this.client.request<HarnessConfig>("config.update", { patch });
    this.config = next;
    this.onConfigChanged(next);
    this.rerender();
  }

  private async handleChange(id: string, newValue: string): Promise<void> {
    if (id === "defaultOrchestratorProfile" || id === "defaultWorkerProfile" || id === "defaultTaskProfile") {
      await this.patchConfig({ [id]: newValue });
    } else if (id === "quotaFormat" && this.config.quotaEndpoint?.url) {
      await this.patchConfig({ quotaEndpoint: { ...this.config.quotaEndpoint, format: newValue } });
    } else if (id === "quotaNativeRetryTimeout") {
      const sec = Number(newValue.replace(/s$/i, ""));
      if (Number.isFinite(sec) && sec > 0) {
        await this.patchConfig({ quotaRetry: { ...this.config.quotaRetry, nativeRetryTimeoutMs: sec * 1000 } });
      }
    } else if (id === "quotaAutoResume") {
      await this.patchConfig({ quotaRetry: { ...this.config.quotaRetry, autoResumeEnabled: newValue === "on" } });
    } else if (id === "orchestratorThreshold") {
      await this.patchConfig({
        rollover: { ...this.config.rollover, orchestratorThreshold: Number(newValue.replace("%", "")) / 100 },
      });
    } else if (id === "workerThreshold") {
      await this.patchConfig({
        rollover: { ...this.config.rollover, workerThreshold: Number(newValue.replace("%", "")) / 100 },
      });
    } else if (id === "maxConcurrentWorkers") {
      await this.patchConfig({ worktree: { ...this.config.worktree, maxConcurrentWorkers: Number(newValue) } });
    } else if (id === "preferSubscription") {
      await this.patchConfig({ catalog: { ...this.config.catalog, preferSubscription: newValue === "on" } });
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+,")) {
      this.onClose();
      return;
    }
    this.list.handleInput(data);
    this.rerender();
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): readonly string[] {
    return this.list.render(width).map((l) => clampLine(l, width));
  }
}
