import type { RemoteHostStatus } from "../daemon/peer.js";
import type { DaemonClient } from "../daemon/remote.js";
import {
  type ColumnSpec,
  Frame,
  type Hint,
  isPopKey,
  middleEllipsis,
  type Navigator,
  sanitizeLine,
  type Screen,
  type ScreenContext,
  TableListView,
  type Theme,
  tag,
} from "./core/index.js";

const REMOTE_COLUMNS: ColumnSpec[] = [
  { key: "cur", header: " ", width: 2, priority: 0 },
  { key: "name", header: "HOST", width: 18, priority: 0 },
  { key: "status", header: "STATUS", width: 14, priority: 0 },
  { key: "dir", header: "LINK", width: 10, priority: 2 },
  { key: "queued", header: "QUEUE", width: 7, align: "right", priority: 2 },
  { key: "target", header: "TARGET / NOTE", minWidth: 16, priority: 1 },
];

export interface HostRowItem {
  name: string;
  isLocal: boolean;
  status: RemoteHostStatus["status"];
  direction: "local" | "outbound" | "inbound";
  queuedMessages: number;
  sshTarget: string;
  lastError: string | null;
}

/**
 * Interactive Remote Hosts Manager (`/remotes`, or `m` inside `/projects`).
 * Lets the user view, add, connect/disconnect, remove, and switch the active TUI directly onto any peered host.
 */
export class RemotesScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Remote Hosts";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<HostRowItem>({
    columns: REMOTE_COLUMNS,
    emptyText: "No remote hosts configured. Press 'a' to add one (e.g. gpu-box user@gpu-box).",
  });
  private rows: HostRowItem[] = [];
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly opts: {
      currentHost?: string | null;
      onSwitchHost?: (host: string) => void | Promise<void>;
    },
  ) {}

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext, selectName?: string): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      const remotes = (await this.client.request<RemoteHostStatus[]>("remote.list")) ?? [];
      const cur = this.opts.currentHost?.trim() || "local";
      const items: HostRowItem[] = [
        {
          name: "local",
          isLocal: true,
          status: "connected",
          direction: "local",
          queuedMessages: 0,
          sshTarget: "this machine's daemon",
          lastError: null,
        },
        ...remotes.map((r) => ({
          name: r.name,
          isLocal: false,
          status: r.status,
          direction: r.direction,
          queuedMessages: r.queuedMessages,
          sshTarget: r.sshTarget,
          lastError: r.lastError,
        })),
      ];
      this.rows = items;
      this.list.setTableItems(
        items.map((r) => {
          const isCur = r.name.toLowerCase() === cur.toLowerCase();
          return {
            id: r.name,
            value: r,
            searchText: `${r.name} ${r.status} ${r.direction} ${r.sshTarget} ${r.lastError ?? ""}`,
            cells: (sel, theme) => {
              const star = isCur ? theme.ok(theme.glyphs.ascii ? "*" : "★") : "";
              const nameCell = r.isLocal
                ? sel
                  ? theme.accentBold("local")
                  : theme.bold("local")
                : sel
                  ? theme.accentBold(sanitizeLine(r.name))
                  : theme.warn(sanitizeLine(r.name));
              const statusCell =
                r.status === "connected"
                  ? tag("ONLINE", "ok", theme)
                  : r.status === "connecting"
                    ? tag("SYNCING", "info", theme)
                    : r.status === "error"
                      ? tag("ERROR", "danger", theme)
                      : tag("OFFLINE", "muted", theme);
              const dirCell =
                r.direction === "local"
                  ? theme.muted("local")
                  : r.direction === "inbound"
                    ? theme.info("inbound")
                    : theme.muted("ssh");
              const queueCell = r.queuedMessages > 0 ? theme.warn(`${r.queuedMessages}q`) : theme.dim("0");
              const note = r.lastError
                ? theme.danger(middleEllipsis(sanitizeLine(r.lastError), 42))
                : theme.muted(middleEllipsis(sanitizeLine(r.sshTarget), 42));
              return {
                cur: star,
                name: nameCell,
                status: statusCell,
                dir: dirCell,
                queued: queueCell,
                target: note,
              };
            },
          };
        }),
        selectName ?? cur,
      );
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const hints: Hint[] = [
      ...(this.opts.onSwitchHost ? [{ key: "Enter", label: "switch TUI to host" }] : []),
      { key: "a", label: "add remote" },
      { key: "c", label: "connect/disconnect" },
      { key: "x", label: "remove" },
      { key: "r", label: "refresh" },
      { key: "/", label: "filter" },
      { key: "Esc", label: "close" },
    ];
    const sel = this.list.selectedItem()?.value;
    const connectedCount = this.rows.filter((r) => !r.isLocal && r.status === "connected").length;
    const totalRemotes = this.rows.filter((r) => !r.isLocal).length;
    const sub = sel
      ? sel.isLocal
        ? "Local daemon host · owns local projects, sessions, and outbound peer links"
        : `${sel.name} (${sel.sshTarget})${sel.lastError ? ` · error: ${sanitizeLine(sel.lastError)}` : ""}`
      : "Symmetric SSH peer links — no open ports required";

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Remote Hosts"],
      rightHeader: this.loading
        ? theme.accent("loading…")
        : theme.muted(`${connectedCount}/${totalRemotes} remote${totalRemotes === 1 ? "" : "s"} online`),
      subtitle: sub,
      hints,
      renderBody: (innerW, bodyH) =>
        this.loading && this.rows.length === 0 ? [theme.muted("Loading remote hosts…")] : this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") this.switchSelected(ctx);
      else ctx.requestRender();
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

    if (data === "a") {
      this.frame.askPrompt({
        label: "Add remote: <name> <user@host | ssh://...> [bridge cmd]",
        placeholder: "gpu-box vlad@gpu-box",
        onSubmit: async (raw) => {
          const parts = raw.trim().split(/\s+/);
          if (parts.length < 2) {
            this.frame.setNotice("Enter: <alias> <ssh-target> (e.g. gpu-box vlad@gpu-box)", "warn");
            return;
          }
          const [name, sshTarget, ...bridgeRest] = parts;
          const added = await this.client.request<RemoteHostStatus>("remote.add", {
            name,
            sshTarget,
            ...(bridgeRest.length > 0 ? { bridgeCommand: bridgeRest.join(" ") } : {}),
            autoConnect: true,
          });
          this.frame.setNotice(
            added.status === "connected"
              ? `Connected remote "${added.name}" (${added.remoteHostName ?? added.sshTarget})`
              : `Saved remote "${added.name}" (${added.lastError ?? added.status})`,
            added.status === "connected" ? "ok" : "warn",
          );
          await this.load(ctx, added.name);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "c") {
      const sel = this.list.selectedItem()?.value;
      if (!sel || sel.isLocal || sel.direction === "inbound") {
        this.frame.setNotice("Select an outbound configured remote to connect/disconnect", "muted");
        ctx.requestRender();
        return;
      }
      const op = sel.status === "connected" ? "remote.disconnect" : "remote.connect";
      this.frame.setNotice(`${sel.status === "connected" ? "Disconnecting" : "Connecting"} ${sel.name}…`, "info");
      ctx.requestRender();
      void this.client
        .request<RemoteHostStatus>(op, { name: sel.name })
        .then(async (st) => {
          this.frame.setNotice(`${sel.name}: ${st.status}`, st.status === "connected" ? "ok" : "muted");
          await this.load(ctx, sel.name);
        })
        .catch(async (err) => {
          this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
          await this.load(ctx, sel.name);
        });
      return;
    }

    if (data === "x") {
      const sel = this.list.selectedItem()?.value;
      if (!sel || sel.isLocal || sel.direction === "inbound") {
        this.frame.setNotice("Only outbound configured remotes can be removed", "muted");
        ctx.requestRender();
        return;
      }
      this.frame.askConfirm({
        message: `Remove remote "${sel.name}" (${sel.sshTarget})?`,
        onConfirm: async () => {
          await this.client.request("remote.remove", { name: sel.name });
          this.frame.setNotice(`Removed remote "${sel.name}"`, "ok");
          await this.load(ctx);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "r") {
      void this.load(ctx, this.list.selectedItem()?.value.name);
      return;
    }

    const res = this.list.handleInput(data);
    if (res === "select") {
      this.switchSelected(ctx);
      return;
    }
    ctx.requestRender();
  }

  private switchSelected(ctx: ScreenContext): void {
    const sel = this.list.selectedItem()?.value;
    if (!sel || !this.opts.onSwitchHost) return;
    if (!sel.isLocal && sel.direction === "inbound") {
      this.frame.setNotice("Inbound peer has no outbound SSH target configured; add it with 'a' to attach directly", "warn");
      ctx.requestRender();
      return;
    }
    ctx.navigator.pop();
    void this.opts.onSwitchHost(sel.name);
  }
}
