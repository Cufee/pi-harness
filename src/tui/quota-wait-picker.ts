import { matchesKey } from "@earendil-works/pi-tui";
import type { DaemonClient } from "../daemon/remote.js";
import {
  formatCountdown,
  formatDuration,
  Frame,
  isPopKey,
  type Navigator,
  parseDurationMs,
  sanitizeLine,
  type Screen,
  type ScreenContext,
  TableListView,
  type Theme,
} from "./core/index.js";

interface WaitChoice {
  id: string;
  label: string;
  description: string;
  delayMs?: number;
}

const WAIT_CHOICES: readonly WaitChoice[] = [
  { id: "now", label: "Resume now", description: "Reset quota state machine & restart paused tasks immediately" },
  { id: "5m", label: "Wait 5 minutes", description: "Auto-resume in 5m (good for short rate-limit windows)", delayMs: 5 * 60_000 },
  { id: "15m", label: "Wait 15 minutes", description: "Auto-resume in 15m", delayMs: 15 * 60_000 },
  { id: "30m", label: "Wait 30 minutes", description: "Auto-resume in 30m", delayMs: 30 * 60_000 },
  { id: "1h", label: "Wait 1 hour", description: "Auto-resume in 1h", delayMs: 60 * 60_000 },
  { id: "2h", label: "Wait 2 hours", description: "Auto-resume in 2h", delayMs: 2 * 60 * 60_000 },
  { id: "custom", label: "Custom wait…", description: "Enter any duration (e.g. 90s, 10m, 1h30m, 4h)" },
];

/**
 * 1-key preset Quota Wait Picker (`w` on quota-paused runs):
 * Restores v1 `QuotaWaitPickerOverlay` with aligned options and custom duration input.
 */
export class QuotaWaitPickerScreen implements Screen {
  readonly variant = "dialog" as const;
  readonly title = "Quota Wait";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<WaitChoice>({
    columns: [
      { key: "key", header: "#", width: 3, priority: 0 },
      { key: "label", header: "ACTION", width: 18, priority: 0 },
      { key: "desc", header: "DETAILS", minWidth: 16, priority: 1 },
    ],
  });

  constructor(
    private readonly client: DaemonClient,
    private readonly opts: {
      runId: string;
      reason?: string | null;
      resumeAt?: number | string | null;
      onDone?: (notice: string) => void | Promise<void>;
    },
  ) {
    this.list.setTableItems(
      WAIT_CHOICES.map((c, idx) => ({
        id: c.id,
        value: c,
        searchText: `${c.id} ${c.label} ${c.description}`,
        cells: (sel, theme) => ({
          key: theme.dim(String(idx + 1)),
          label: sel ? theme.accentBold(c.label) : c.id === "now" ? theme.ok(c.label) : theme.bold(c.label),
          desc: sel ? theme.text(c.description) : theme.muted(c.description),
        }),
      })),
    );
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
  }

  private async applyChoice(choice: WaitChoice, ctx: ScreenContext): Promise<void> {
    if (choice.id === "custom") {
      this.frame.askPrompt({
        label: "Wait duration (e.g. 90s, 15m, 1h30m)",
        placeholder: "15m",
        onSubmit: async (raw) => {
          const delayMs = parseDurationMs(raw);
          if (!delayMs) {
            this.frame.setNotice(`Invalid duration "${raw}" — try 90s, 15m, or 1h30m`, "warn");
            ctx.requestRender();
            return;
          }
          await this.client.request("run.schedule_resume", { runId: this.opts.runId, delayMs });
          const msg = `Scheduled ${this.opts.runId} to resume in ${formatDuration(delayMs)}`;
          await this.opts.onDone?.(msg);
          ctx.navigator.pop();
        },
      });
      ctx.requestRender();
      return;
    }

    try {
      if (choice.id === "now") {
        await this.client.request("run.resume", { runId: this.opts.runId });
        await this.opts.onDone?.(`Resumed ${this.opts.runId}`);
      } else if (choice.delayMs) {
        await this.client.request("run.schedule_resume", { runId: this.opts.runId, delayMs: choice.delayMs });
        await this.opts.onDone?.(`Scheduled ${this.opts.runId} to resume in ${formatDuration(choice.delayMs)}`);
      }
      ctx.navigator.pop();
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const parts: string[] = [this.opts.runId];
    if (this.opts.resumeAt) parts.push(`scheduled ${formatCountdown(this.opts.resumeAt)}`);
    if (this.opts.reason) parts.push(sanitizeLine(this.opts.reason));

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Quota Wait"],
      subtitle: parts.join(" · "),
      hints: [
        { key: "Enter / 1-7", label: "choose" },
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

    // 1-key quick selection (1..7)
    if (data.length === 1 && data >= "1" && data <= String(WAIT_CHOICES.length)) {
      const choice = WAIT_CHOICES[Number(data) - 1]!;
      void this.applyChoice(choice, ctx);
      return;
    }

    const res = this.list.handleInput(data);
    if (res === "select") {
      const sel = this.list.selectedItem()?.value;
      if (sel) void this.applyChoice(sel, ctx);
      return;
    }
    if (res === "handled" || matchesKey(data, "up") || matchesKey(data, "down")) {
      ctx.requestRender();
    }
  }
}
