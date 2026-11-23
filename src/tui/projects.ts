import { matchesKey, type Terminal } from "@earendil-works/pi-tui";
import type { ProjectBrowseEntry, ProjectBrowseResult, ProjectRecord, ProjectSummary } from "../control-plane/projects.js";
import type { DaemonClient } from "../daemon/remote.js";
import {
  type ColumnSpec,
  createTheme,
  Frame,
  type Hint,
  isPopKey,
  middleEllipsis,
  Navigator,
  sanitizeLine,
  type Screen,
  type ScreenContext,
  TableListView,
  TerminalSession,
  type Theme,
} from "./core/index.js";

const PROJECT_COLUMNS: ColumnSpec[] = [
  { key: "cur", header: " ", width: 2, priority: 0 },
  { key: "host", header: "HOST", width: 12, priority: 0 },
  { key: "name", header: "PROJECT", width: 18, priority: 0 },
  { key: "git", header: "WORKSPACE", width: 15, priority: 1 },
  { key: "path", header: "PATH", minWidth: 14, priority: 0 },
  { key: "counts", header: "ACTIVITY", width: 14, align: "right", priority: 2 },
];

export type FederatedProjectSummary = ProjectSummary & { host?: string; nodeId?: string | null };

const BROWSE_COLUMNS: ColumnSpec[] = [
  { key: "kind", header: "TYPE", width: 6, priority: 1 },
  { key: "name", header: "DIRECTORY", minWidth: 18, priority: 0 },
  { key: "path", header: "PATH", minWidth: 16, priority: 2 },
];

/**
 * Interactive daemon-host folder browser (`b` inside ProjectsScreen).
 * Designed specifically for SSH usage: browse directories on the remote host without leaving the TUI,
 * drill in with `Enter`, go up with `Backspace`/`..`, and press `a` to register any folder as a Project.
 */
class RemoteBrowseDialog implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Browse Folders";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<{ kind: "up"; path: string } | { kind: "dir"; entry: ProjectBrowseEntry }>({
    columns: BROWSE_COLUMNS,
    emptyText: "No subdirectories here. Press 'a' to register this directory as a project.",
  });
  private currentPath: string | undefined;
  private browseData: ProjectBrowseResult | null = null;
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly onPickDir: (dirPath: string) => Promise<void>,
    initialPath?: string,
  ) {
    this.currentPath = initialPath;
  }

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    void this.load(this.currentPath, ctx);
  }

  private async load(targetPath: string | undefined, ctx: ScreenContext): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      this.browseData = await this.client.request<ProjectBrowseResult>("project.browse", {
        ...(targetPath ? { path: targetPath } : {}),
      });
      this.currentPath = this.browseData.path;
      const rows: Array<{ kind: "up"; path: string } | { kind: "dir"; entry: ProjectBrowseEntry }> = [];
      if (this.browseData.parentPath) {
        rows.push({ kind: "up", path: this.browseData.parentPath });
      }
      for (const entry of this.browseData.entries) {
        rows.push({ kind: "dir", entry });
      }
      this.list.setTableItems(
        rows.map((r) =>
          r.kind === "up"
            ? {
                id: `up:${r.path}`,
                value: r,
                searchText: ".. parent up",
                cells: (sel, theme) => ({
                  kind: theme.muted("up"),
                  name: sel ? theme.accentBold("..") : theme.muted(".."),
                  path: theme.dim(middleEllipsis(r.path, 38)),
                }),
              }
            : {
                id: r.entry.path,
                value: r,
                searchText: `${r.entry.name} ${r.entry.path} ${r.entry.isGit ? "git" : "dir"}`,
                cells: (sel, theme) => ({
                  kind: r.entry.isGit ? theme.ok("git") : theme.muted("dir"),
                  name: sel ? theme.accentBold(sanitizeLine(r.entry.name)) : theme.bold(sanitizeLine(r.entry.name)),
                  path: theme.dim(middleEllipsis(r.entry.path, 38)),
                }),
              },
        ),
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
      breadcrumbs: this.nav?.breadcrumbs ?? ["Projects", "Browse Folders"],
      subtitle: this.currentPath ? `Host dir: ${this.currentPath}` : "Loading host directory…",
      hints: [
        { key: "Enter", label: "open dir" },
        { key: "a", label: "add selected/current as project" },
        { key: "p", label: "jump to path" },
        { key: "/", label: "filter" },
        { key: "Esc", label: "back" },
      ],
      renderBody: (innerW, bodyH) =>
        this.loading && !this.browseData ? [theme.muted("Loading remote directories…")] : this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") this.enterSelected(ctx);
      else ctx.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || data === "q") {
      if (this.list.query) {
        this.list.clearFilter();
        ctx.requestRender();
        return;
      }
      ctx.navigator.pop();
      return;
    }

    if (matchesKey(data, "backspace") && this.browseData?.parentPath) {
      void this.load(this.browseData.parentPath, ctx);
      return;
    }

    if (data === "p") {
      this.frame.askPrompt({
        label: "Jump to directory",
        placeholder: "~/projects",
        initialValue: this.currentPath,
        onSubmit: async (raw) => {
          await this.load(raw, ctx);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "a") {
      const sel = this.list.selectedItem()?.value;
      const target = sel?.kind === "dir" ? sel.entry.path : this.currentPath;
      if (!target) return;
      void this.onPickDir(target)
        .then(() => {
          if (ctx.navigator.current === this) ctx.navigator.pop();
        })
        .catch((err) => {
          this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
          ctx.requestRender();
        });
      return;
    }

    const res = this.list.handleInput(data);
    if (res === "select") {
      this.enterSelected(ctx);
      return;
    }
    if (res === "handled") ctx.requestRender();
  }

  private enterSelected(ctx: ScreenContext): void {
    const sel = this.list.selectedItem()?.value;
    if (!sel) return;
    if (sel.kind === "up") void this.load(sel.path, ctx);
    else void this.load(sel.entry.path, ctx);
  }
}

/**
 * Unified Projects Manager & Picker (`/projects`, `/project`, `Ctrl+P`).
 *
 * Works identically locally and over SSH (paths expand & directories are created/cloned on the daemon host):
 *  - `Enter`: Open project (switches to that project's chat session, or creates one bound to it)
 *  - `s`: Switch THIS session into the selected project in-place (keeps conversation history)
 *  - `n`: Add / create a project at a path (auto-creates directory if missing)
 *  - `g`: Create a new git-initialized project at a path
 *  - `c`: Clone a git repository into a new project path
 *  - `b`: Browse remote daemon directories to pick a folder
 *  - `x`: Unregister project (files on disk are never deleted)
 */
export class ProjectsScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Projects";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<FederatedProjectSummary>({
    columns: PROJECT_COLUMNS,
    emptyText: "No projects registered yet. Press 'n' to add/create a project or 'b' to browse folders.",
  });
  private projects: FederatedProjectSummary[] = [];
  private loading = true;

  constructor(
    private readonly client: DaemonClient,
    private readonly opts: {
      currentHost?: string | null;
      currentProjectId?: string | null;
      currentRepoRoot?: string | null;
      canSwitchCurrentSession?: boolean;
      onOpenProject: (project: FederatedProjectSummary) => void | Promise<void>;
      onSwitchCurrentSession?: (project: FederatedProjectSummary) => void | Promise<void>;
      onOpenRemotes?: () => void;
      includeRemotes?: boolean;
      initialProjects?: FederatedProjectSummary[];
      initialNotice?: { tone: "info" | "warn" | "danger" | "ok"; text: string } | null;
      cancelLabel?: string;
    },
  ) {}

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    if (this.opts.initialNotice) {
      this.frame.setNotice(this.opts.initialNotice.text, this.opts.initialNotice.tone);
    }
    if (this.opts.initialProjects) {
      this.projects = this.opts.initialProjects;
      this.loading = false;
      this.rebuild();
      return;
    }
    void this.load(ctx);
  }

  private async load(ctx: ScreenContext, selectId?: string): Promise<void> {
    this.loading = true;
    ctx.requestRender();
    try {
      this.projects = await this.client.request<FederatedProjectSummary[]>("project.list", {
        includeRemotes: this.opts.includeRemotes ?? true,
      });
      this.rebuild(selectId);
    } catch (err) {
      this.frame.setNotice(err instanceof Error ? err.message : String(err), "danger");
    } finally {
      this.loading = false;
      ctx.requestRender();
    }
  }

  private isCurrent(p: FederatedProjectSummary): boolean {
    if (p.host && p.host !== "local") return false;
    if (this.opts.currentProjectId && p.id === this.opts.currentProjectId) return true;
    if (this.opts.currentRepoRoot && p.rootPath === this.opts.currentRepoRoot) return true;
    return false;
  }

  private rebuild(selectId?: string): void {
    const currentHostLabel = this.opts.currentHost?.trim() || "local";
    this.list.setTableItems(
      this.projects.map((p) => {
        const cur = this.isCurrent(p);
        const isRemoteRow = p.host != null && p.host !== "local";
        const hostName = isRemoteRow ? p.host! : currentHostLabel;
        const wsLabel = !p.exists
          ? "missing"
          : p.isGit
            ? `git:${p.gitBranch ?? "HEAD"}`
            : "folder";
        const activity = `${p.sessionCount}ch · ${p.activeGoalCount}g`;
        const rowId = `${p.host ?? "local"}:${p.id}`;
        return {
          id: rowId,
          value: p,
          searchText: `${hostName} ${p.id} ${p.name} ${p.rootPath} ${p.gitBranch ?? ""} ${p.description ?? ""}`,
          cells: (sel, theme) => ({
            cur: cur ? theme.ok(theme.glyphs.ascii ? "*" : "★") : "",
            host: isRemoteRow || currentHostLabel !== "local"
              ? theme.warn(sanitizeLine(hostName))
              : theme.muted("local"),
            name: sel ? theme.accentBold(sanitizeLine(p.name)) : cur ? theme.ok(sanitizeLine(p.name)) : theme.bold(sanitizeLine(p.name)),
            git: !p.exists ? theme.danger(wsLabel) : p.isGit ? theme.info(wsLabel) : theme.muted(wsLabel),
            path: sel ? theme.text(middleEllipsis(p.rootPath, 38)) : theme.muted(middleEllipsis(p.rootPath, 38)),
            counts: p.activeGoalCount > 0 ? theme.accent(activity) : theme.muted(activity),
          }),
        };
      }),
      selectId ? (selectId.includes(":") ? selectId : `local:${selectId}`) : undefined,
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    const hints: Hint[] = [
      { key: "Enter", label: "open" },
      ...(this.opts.canSwitchCurrentSession ? [{ key: "s", label: "switch here" }] : []),
      { key: "n", label: "new" },
      { key: "g", label: "git init" },
      { key: "c", label: "clone" },
      { key: "b", label: "browse" },
      ...(this.opts.onOpenRemotes ? [{ key: "m", label: "remotes" }] : []),
      { key: "x", label: "remove" },
      { key: "/", label: "filter" },
      { key: "Esc", label: this.opts.cancelLabel ?? "close" },
    ];
    const sel = this.list.selectedItem()?.value;
    const hostDisplay = sel?.host && sel.host !== "local" ? sel.host : this.opts.currentHost || "local";
    const sub = sel
      ? `[${hostDisplay}] ${sel.id} · ${sel.rootPath}${sel.description ? ` · ${sanitizeLine(sel.description)}` : ""}`
      : "Paths resolve on the target host (~ expands remotely over SSH)";

    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Projects"],
      rightHeader: this.loading ? theme.accent("loading…") : theme.muted(`${this.projects.length} project${this.projects.length === 1 ? "" : "s"}`),
      subtitle: sub,
      hints,
      renderBody: (innerW, bodyH) =>
        this.loading && this.projects.length === 0 ? [theme.muted("Loading projects…")] : this.list.render(innerW, bodyH, theme),
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") this.openSelected(ctx);
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

    if (data === "n") {
      this.frame.askPrompt({
        label: "Project path [optional name]",
        placeholder: "~/projects/my-app my-app",
        onSubmit: async (raw) => {
          const parts = raw.trim().split(/\s+/);
          const path = parts[0]!;
          const name = parts.slice(1).join("-") || undefined;
          const created = await this.client.request<ProjectSummary>("project.create", {
            path,
            name,
            createDir: true,
          });
          this.frame.setNotice(`Added project ${created.name} (${created.rootPath})`, "ok");
          await this.load(ctx, created.id);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "g") {
      this.frame.askPrompt({
        label: "New git project path [optional name]",
        placeholder: "~/projects/new-repo",
        onSubmit: async (raw) => {
          const parts = raw.trim().split(/\s+/);
          const path = parts[0]!;
          const name = parts.slice(1).join("-") || undefined;
          const created = await this.client.request<ProjectSummary>("project.create", {
            path,
            name,
            createDir: true,
            gitInit: true,
          });
          this.frame.setNotice(`Initialized git project ${created.name}`, "ok");
          await this.load(ctx, created.id);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "c") {
      this.frame.askPrompt({
        label: "Clone (<git-url> <dest-path> [name])",
        placeholder: "git@github.com:org/repo.git ~/projects/repo",
        onSubmit: async (raw) => {
          const parts = raw.trim().split(/\s+/);
          if (parts.length < 2) {
            this.frame.setNotice("Provide both <git-url> and <dest-path>", "warn");
            ctx.requestRender();
            return;
          }
          const [cloneUrl, path, ...rest] = parts;
          const name = rest.join("-") || undefined;
          this.frame.setNotice(`Cloning ${cloneUrl}…`, "info");
          ctx.requestRender();
          const created = await this.client.request<ProjectSummary>("project.create", {
            path: path!,
            cloneUrl: cloneUrl!,
            name,
            createDir: true,
          });
          this.frame.setNotice(`Cloned project ${created.name}`, "ok");
          await this.load(ctx, created.id);
        },
      });
      ctx.requestRender();
      return;
    }

    if (data === "b") {
      ctx.navigator.push(
        new RemoteBrowseDialog(
          this.client,
          async (dirPath) => {
            const created = await this.client.request<ProjectSummary>("project.create", {
              path: dirPath,
              createDir: false,
            });
            this.frame.setNotice(`Registered project ${created.name}`, "ok");
            await this.load(ctx, created.id);
          },
          this.opts.currentRepoRoot ?? undefined,
        ),
      );
      return;
    }

    if (data === "m" && this.opts.onOpenRemotes) {
      this.opts.onOpenRemotes();
      return;
    }

    if (data === "s" && this.opts.canSwitchCurrentSession && this.opts.onSwitchCurrentSession) {
      const sel = this.list.selectedItem()?.value;
      if (!sel) return;
      if (sel.host && sel.host !== "local") {
        this.frame.setNotice(`"${sel.name}" lives on remote host "${sel.host}" — press Enter to open it on ${sel.host}`, "warn");
        ctx.requestRender();
        return;
      }
      ctx.navigator.closeAll();
      void Promise.resolve(this.opts.onSwitchCurrentSession(sel)).catch(() => {});
      return;
    }

    if (data === "x") {
      const sel = this.list.selectedItem()?.value;
      if (!sel) return;
      const hostSuffix = sel.host && sel.host !== "local" ? ` on ${sel.host}` : "";
      this.frame.askConfirm({
        message: `Unregister project "${sel.name}"${hostSuffix}? (Files at ${sel.rootPath} will NOT be deleted)`,
        onConfirm: async () => {
          await this.client.request("project.remove", {
            projectId: sel.id,
            ...(sel.host && sel.host !== "local" ? { host: sel.host } : {}),
          });
          this.frame.setNotice(`Removed project ${sel.name}`, "warn");
          await this.load(ctx);
        },
      });
      ctx.requestRender();
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
    ctx.navigator.closeAll();
    void Promise.resolve(this.opts.onOpenProject(sel)).catch(() => {});
  }
}

/**
 * Standalone full-terminal project picker used before any chat session is opened.
 * Resolves to the project chosen with `Enter`, or `null` when the picker is cancelled
 * (`Esc`, `q`, `Ctrl+C`, `Ctrl+]`) or the daemon connection closes.
 */
export async function pickProjectTui(opts: {
  client: DaemonClient;
  currentHost?: string | null;
  initialProjects?: FederatedProjectSummary[];
  initialNotice?: { tone: "info" | "warn" | "danger" | "ok"; text: string } | null;
  includeRemotes?: boolean;
  terminal?: Terminal;
}): Promise<FederatedProjectSummary | null> {
  let picked: FederatedProjectSummary | null = null;
  let navigator!: Navigator;
  const session = new TerminalSession({
    terminal: opts.terminal,
    isOverlayOpen: () => navigator?.isOpen ?? false,
    onInterrupt: () => {
      navigator.closeAll();
      return "consumed";
    },
  });
  // `closeAll()` fires `onChange` before `onOpenProject`; `picked` is still set synchronously before `stop()` resolves `done`.
  navigator = new Navigator(session.tui, session.terminal, createTheme(), {
    onChange: () => {
      if (!navigator.isOpen) void session.stop();
    },
  });
  const detachClose = opts.client.onClose(() => {
    picked = null;
    void session.stop();
  });
  session.start();
  navigator.push(
    new ProjectsScreen(opts.client, {
      currentHost: opts.currentHost,
      includeRemotes: opts.includeRemotes,
      initialProjects: opts.initialProjects,
      initialNotice: opts.initialNotice,
      cancelLabel: "cancel",
      onOpenProject: (project) => {
        picked = project;
      },
    }),
  );
  await session.done;
  detachClose();
  return picked;
}
