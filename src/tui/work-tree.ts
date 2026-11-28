import { matchesKey } from "@earendil-works/pi-tui";
import {
  clamp,
  type ColumnSpec,
  firstLine,
  formatAge,
  Frame,
  type Hint,
  isPopKey,
  type Navigator,
  sanitizeLine,
  type Screen,
  type ScreenContext,
  statusBadge,
  TableListView,
  type Theme,
  type Tone,
} from "./core/index.js";
import { type InspectorDeps, openEntityInspector } from "./inspectors.js";
import type { WorkState, WorkTreeNode } from "./store.js";

const COLUMNS: ColumnSpec[] = [
  { key: "item", header: "GOAL / AGENT", minWidth: 30, priority: 0 },
  { key: "status", header: "STATUS", width: 16, priority: 0 },
  { key: "agent", header: "AGENT", width: 22, priority: 2 },
  { key: "activity", header: "NOW", minWidth: 18, priority: 1 },
  { key: "updated", header: "UPDATED", width: 8, align: "right", priority: 3 },
];

const STATE_TONE: Record<WorkState, Tone> = { blocked: "danger", active: "ok", queued: "muted", done: "dim" };

interface TreeRow {
  node: WorkTreeNode;
  prefix: string;
}

/** Flattens the tree into rows, drawing `├─` / `└─` branches so each agent sits under its parent. */
function flatten(nodes: WorkTreeNode[], theme: Theme, lead: string | null = null, out: TreeRow[] = []): TreeRow[] {
  const g = theme.glyphs;
  nodes.forEach((node, i) => {
    const last = i === nodes.length - 1;
    const prefix = lead === null ? "" : `${lead}${last ? g.branchEnd : g.branchMid} `;
    out.push({ node, prefix });
    const childLead = lead === null ? "" : `${lead}${last ? "   " : `${g.branchCont} `}`;
    flatten(node.children, theme, childLead, out);
  });
  return out;
}

/**
 * The one work view (`Ctrl+G`): every goal, with the agents working on it nested underneath by parent.
 * By default it shows only active and blocked items; `a` shows everything, including finished work.
 * Answers to blocked items go to the Director in the chat, not here.
 */
export class WorkTreeScreen implements Screen {
  readonly variant = "sheet" as const;
  readonly title = "Work";
  private readonly frame = new Frame();
  private nav: Navigator | null = null;
  private readonly list = new TableListView<WorkTreeNode>({ columns: COLUMNS });
  private showAll = false;
  private theme: Theme | null = null;
  private unsub: (() => void) | null = null;

  constructor(private readonly deps: InspectorDeps) {}

  onShow(ctx: ScreenContext): void {
    this.nav = ctx.navigator;
    this.theme = ctx.theme;
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

  get showingAll(): boolean {
    return this.showAll;
  }

  private rebuild(): void {
    if (!this.theme) return;
    const store = this.deps.store;
    const tree = store.buildWorkTree({ all: this.showAll });
    this.list.emptyText = store.lastError
      ? "Unable to load work — press 'r' to retry."
      : this.showAll
        ? "No goals or agents yet. Ask the Director to plan work."
        : "Nothing active or blocked. Press 'a' to show all work.";
    this.list.setTableItems(
      flatten(tree, this.theme).map(({ node, prefix }) => ({
        id: `${node.kind}:${node.id}`,
        value: node,
        searchText: `${node.id} ${node.status} ${node.title} ${node.agent} ${node.activity}`,
        cells: (sel: boolean, theme: Theme) => {
          const tone = STATE_TONE[node.state];
          const id = node.kind === "task" ? theme.paint(tone, node.id) : theme.bold(theme.paint(tone, node.id));
          const title = sanitizeLine(node.title);
          return {
            item: `${theme.dim(prefix)}${id} ${sel ? theme.accentBold(title) : node.kind === "task" ? title : theme.bold(title)}`,
            status: statusBadge(node.status, theme),
            agent: theme.muted(node.agent),
            activity: node.state === "blocked" ? theme.danger(firstLine(node.activity, 80)) : theme.muted(firstLine(node.activity, 80)),
            updated: theme.dim(formatAge(node.updatedAt)),
          };
        },
      })),
    );
  }

  render(width: number, maxHeight: number, theme: Theme): string[] {
    if (this.theme !== theme) {
      this.theme = theme;
      this.rebuild();
    }
    const store = this.deps.store;
    const summary = store.workSummary();
    const hints: Hint[] = [
      { key: "Enter", label: "inspect" },
      { key: "a", label: this.showAll ? "active + blocked only" : "show all" },
      { key: "/", label: "filter" },
      { key: "r", label: "refresh" },
      { key: "Esc", label: "close" },
    ];
    const counts = `${summary.active} active · ${summary.blocked} blocked`;
    return this.frame.render({
      width,
      maxHeight,
      theme,
      breadcrumbs: this.nav?.breadcrumbs ?? ["Work"],
      subtitle: this.showAll ? `All work · ${counts}` : `Active + blocked · ${counts}`,
      rightHeader: store.lastError
        ? theme.danger(`${theme.glyphs.warn} sync error`)
        : store.state.generatedAt > 0
          ? theme.muted(`updated ${formatAge(store.state.generatedAt)}`)
          : undefined,
      hints,
      renderBody: (innerW, bodyH) => {
        const out: string[] = [];
        let listH = bodyH;
        if (store.lastError) {
          out.push(
            clamp(theme.danger(`${theme.glyphs.warn} Failed to refresh: ${sanitizeLine(store.lastError)} (press 'r' to retry)`), innerW),
          );
          listH = Math.max(1, bodyH - 1);
        }
        out.push(...this.list.render(innerW, listH, theme));
        return out;
      },
    });
  }

  handleInput(data: string, ctx: ScreenContext): void {
    if (this.frame.handleInlineInput(data, ctx.requestRender)) return;

    if (this.list.isFiltering) {
      const res = this.list.handleInput(data);
      if (res === "select") this.inspectSelected(ctx);
      else ctx.requestRender();
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

    if (data === "a") {
      this.showAll = !this.showAll;
      this.rebuild();
      ctx.requestRender();
      return;
    }

    if (data === "r") {
      this.frame.setNotice("Refreshing...", "info");
      ctx.requestRender();
      void this.deps.store.refresh().then(() => {
        const err = this.deps.store.lastError;
        this.frame.setNotice(err ? `Refresh failed: ${err}` : "", err ? "danger" : "info");
        ctx.requestRender();
      });
      return;
    }

    const res = this.list.handleInput(data);
    if (res === "select") this.inspectSelected(ctx);
    else if (res === "handled") ctx.requestRender();
  }

  private inspectSelected(ctx: ScreenContext): void {
    const node = this.list.selectedItem()?.value;
    if (node) openEntityInspector(node.ref, this.deps, ctx);
  }
}
