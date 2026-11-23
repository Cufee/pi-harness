import { randomUUID } from "node:crypto";
import { matchesKey, type Terminal } from "@earendil-works/pi-tui";
import type { ProjectRecord } from "../control-plane/projects.js";
import type { EventRecord, ReplayPage, RunRecord } from "../control-plane/db.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../director/session.js";
import { formatChatEventSummary, parseChatControlEvent } from "../protocol/chat-events.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import { createCommandAutocomplete, parseSlashCommand, renderHelp, type TuiMode } from "./commands.js";
import {
  createTheme,
  type TuiEntityRef as EntityRef,
  fillLineBg,
  firstLine,
  fit,
  FixedDock,
  formatCountdown,
  formatDuration,
  formatToolLabel,
  type Hint,
  ImmutableTranscript,
  Navigator,
  parseDurationMs,
  RecentRefsRing,
  sanitizeLine,
  TerminalSession,
} from "./core/index.js";
import { type InspectorDeps, openEntityInspector } from "./inspectors.js";
import {
  EffortPickerScreen,
  GoToPaletteScreen,
  KbBrowserScreen,
  ModelPickerScreen,
  type QuickActionItem,
  QuotaCostScreen,
  SessionSwitcherScreen,
  SettingsScreen,
} from "./pickers.js";
import { ProjectsScreen } from "./projects.js";
import { RemotesScreen } from "./remotes.js";
import { consumeReplay } from "./replay.js";
import { type AttachableSession, WorkStore } from "./store.js";
import { extractDisplay, parseToolDisplay } from "./tool-output/index.js";
import { WorkNavigatorScreen, type WorkTabId } from "./work-navigator.js";

export type TuiExitAction =
  | { kind: "exit" }
  | {
      kind: "switch";
      targetKind: "chat" | "run";
      targetId: string;
      targetHost?: string;
      targetNodeId?: string | null;
      taskId?: string | null;
      title?: string;
      projectId?: string;
      repoRoot?: string;
    };

export interface DirectorChatTuiOptions {
  client: DaemonClient;
  remoteHost?: string | null;
  localRemotes?: ReadonlyArray<{ name: string; sshTarget: string }>;
  initialNotice?: { tone: "info" | "warn" | "danger" | "ok"; text: string } | null;
  repoRoot?: string;
  projectId?: string;
  chatSessionId?: string;
  preferLastGlobal?: boolean;
  preferLastProject?: boolean;
  terminal?: Terminal;
}

export interface NativeScrollbackTuiOptions {
  client: DaemonClient;
  remoteHost?: string | null;
  localRemotes?: ReadonlyArray<{ name: string; sshTarget: string }>;
  initialNotice?: { tone: "info" | "warn" | "danger" | "ok"; text: string } | null;
  runId: string;
  initialTaskId?: string | null;
  terminal?: Terminal;
}

interface ChatOpenResult {
  session: ChatSessionRecord;
  project?: ProjectRecord | null;
  history: ChatTurnRecord[];
  historyNext?: number | null;
  historyThrough?: number;
  activeTurnId: string | null;
  activeText: string;
  activePartial: string;
  tookOver: boolean;
  busy: boolean;
}

interface AttachRunResult extends ReplayPage {
  attachmentId: string;
  attached: boolean;
  tookOver: boolean;
  run: RunRecord | null;
}

interface DaemonStatusResult {
  pid: number;
  uptimeMs: number;
  profiles?: Array<{ id: string; kind: string; billing: string; enabled: boolean }>;
}

interface SharedShellContext {
  mode: TuiMode;
  client: DaemonClient;
  remoteHost?: string | null;
  localRemotes?: ReadonlyArray<{ name: string; sshTarget: string }>;
  repoRoot: string;
  projectId?: string | null;
  getProject?: () => { id: string | null; name: string | null; repoRoot: string };
  onSwitchCurrentSessionProject?: (project: ProjectRecord) => Promise<void>;
  sessionId: string;
  chatSessionId?: string;
  runId?: string;
  terminal?: Terminal;
  getRightStatus: () => string;
  getIdleBanner: () => string;
  onUserSubmit: (text: string) => Promise<void>;
  onCancelActiveTurn: () => Promise<boolean>;
  onModelUpdated?: (sel: { profileId: string; model: string | null; effort: string | null }) => Promise<void>;
  onEffortUpdated?: (effort: string) => Promise<void>;
  getCurrentModel?: () => { profileId?: string; model?: string | null; effort?: string | null };
  onClear?: () => void;
}

/**
 * Unified interactive TUI shell shared by both Director Chat mode and Attached Run mode.
 *
 * Guarantees:
 *  - Strictly append-only immutable transcript above the live tail (never triggers pi-tui scrollback wipes).
 *  - Constant-height dock (separator + attention strip + status bar + UndoableEditor + 1-line hint strip).
 *  - Zero main-screen mouse tracking (native terminal scrollback & mouse-drag copy always work).
 *  - Every surfaced entity is directly reachable via `Ctrl+G`, `Ctrl+T`, `Ctrl+O`, `Ctrl+,`, `Ctrl+X`, or `Alt+1..5`.
 */
function createSharedShell(spec: SharedShellContext) {
  const theme = createTheme();
  const recentRefs = new RecentRefsRing(80);
  const store = new WorkStore(spec.client, {
    chatSessionId: spec.chatSessionId,
    repoRoot: spec.repoRoot,
    runId: spec.runId,
  });

  let exitAction: TuiExitAction = { kind: "exit" };
  let busy = false;
  let phaseText = "Ready";
  let transientHint: string | null = null;
  const queuedMessages: string[] = [];

  let dock!: FixedDock;
  let navigator!: Navigator;

  const session = new TerminalSession({
    terminal: spec.terminal,
    getComposerText: () => dock?.editor.getText() ?? "",
    clearComposerText: () => {
      dock?.editor.setText("");
      dock?.editor.clearUndoHistory();
      session.tui.requestRender();
    },
    isOverlayOpen: () => navigator?.isOpen ?? false,
    isBusy: () => busy,
    onInterrupt: () => {
      if (navigator.isOpen) {
        navigator.pop();
        return "consumed";
      }
      if (busy) {
        void spec.onCancelActiveTurn();
        return "consumed";
      }
      return "exit";
    },
    onCancelActiveTurn: () => {
      void spec.onCancelActiveTurn();
    },
    onTransientHint: (msg) => {
      transientHint = msg;
      if (dock) {
        dock.update({ transientHint });
        session.tui.requestRender();
      }
    },
    onBeforeExit: async () => {
      if (exitAction.kind === "exit") {
        await spec.client.request("session.leave").catch(() => {});
      }
    },
  });

  const transcript = new ImmutableTranscript(theme);
  navigator = new Navigator(session.tui, session.terminal, theme, {
    onChange: () => {
      if (!navigator.isOpen) {
        session.tui.setFocus(dock.editor);
      }
    },
  });

  const switchTo = (
    targetKind: "chat" | "run",
    targetId: string,
    extra?: { targetHost?: string; targetNodeId?: string | null; taskId?: string | null; title?: string; projectId?: string; repoRoot?: string },
  ) => {
    exitAction = {
      kind: "switch",
      targetKind,
      targetId,
      ...(extra?.targetHost ? { targetHost: extra.targetHost } : {}),
      ...(extra?.targetNodeId ? { targetNodeId: extra.targetNodeId } : {}),
      ...(extra?.taskId !== undefined ? { taskId: extra.taskId } : {}),
      ...(extra?.title ? { title: extra.title } : {}),
      ...(extra?.projectId ? { projectId: extra.projectId } : {}),
      ...(extra?.repoRoot ? { repoRoot: extra.repoRoot } : {}),
    };
    void session.stop();
  };

  const currentRepoRoot = () => spec.getProject?.().repoRoot ?? spec.repoRoot;

  const inspectorDeps: InspectorDeps = {
    client: spec.client,
    store,
    repoRoot: spec.repoRoot,
    onAttachRun: (runId, taskId) => switchTo("run", runId, { taskId }),
  };

  const openRemotes = () => {
    navigator.push(
      new RemotesScreen(spec.client, {
        currentHost: spec.remoteHost ?? null,
        localRemotes: spec.localRemotes,
        onSwitchHost: (host) => {
          switchTo("chat", "__host__", { targetHost: host });
        },
      }),
    );
  };

  const openProjects = () => {
    const cur = spec.getProject?.() ?? { id: spec.projectId ?? null, name: null, repoRoot: spec.repoRoot };
    navigator.push(
      new ProjectsScreen(spec.client, {
        currentHost: spec.remoteHost ?? null,
        currentProjectId: cur.id,
        currentRepoRoot: cur.repoRoot,
        canSwitchCurrentSession: Boolean(spec.onSwitchCurrentSessionProject),
        onOpenProject: (project) => {
          const targetHost = project.host && project.host !== "local" ? project.host : undefined;
          switchTo("chat", "__project__", {
            projectId: project.id,
            repoRoot: project.rootPath,
            ...(targetHost ? { targetHost } : {}),
            ...(project.nodeId ? { targetNodeId: project.nodeId } : {}),
          });
        },
        onSwitchCurrentSession: spec.onSwitchCurrentSessionProject
          ? async (project) => {
              await spec.onSwitchCurrentSessionProject!(project);
              inspectorDeps.repoRoot = project.rootPath;
              store.setScope({ chatSessionId: spec.chatSessionId, repoRoot: project.rootPath, runId: spec.runId });
              void store.refresh();
              syncDock();
            }
          : undefined,
        onOpenRemotes: () => openRemotes(),
      }),
    );
  };

  const openWork = (tab?: WorkTabId) => {
    inspectorDeps.repoRoot = currentRepoRoot();
    navigator.push(new WorkNavigatorScreen(inspectorDeps, tab));
  };

  const openEntity = (ref: EntityRef) => {
    openEntityInspector(ref, inspectorDeps, {
      navigator,
      theme,
      requestRender: () => session.tui.requestRender(),
      writeTerminal: (seq) => {
        try {
          session.terminal.write(seq);
        } catch {
          // ignore
        }
      },
    });
  };

  const openModels = () => {
    if (!spec.onModelUpdated) return;
    const cur = spec.getCurrentModel?.() ?? {};
    navigator.push(
      new ModelPickerScreen(spec.client, {
        chatSessionId: spec.chatSessionId,
        cwd: spec.repoRoot,
        currentProfileId: cur.profileId,
        currentModel: cur.model,
        currentEffort: cur.effort,
        onSelected: (sel) => {
          void spec.onModelUpdated?.(sel).catch((err) => {
            transcript.appendReceipt({
              tone: "danger",
              tag: "model",
              text: err instanceof Error ? err.message : String(err),
            });
            session.tui.requestRender();
          });
        },
      }),
    );
  };

  const openEffort = () => {
    if (!spec.onEffortUpdated) return;
    const cur = spec.getCurrentModel?.() ?? {};
    const label = `${cur.profileId ?? "auto"} · ${cur.model ?? "CLI default"}`;
    navigator.push(
      new EffortPickerScreen({
        currentEffort: cur.effort,
        modelLabel: label,
        onSelected: (effort) => {
          void spec.onEffortUpdated?.(effort).catch((err) => {
            transcript.appendReceipt({
              tone: "danger",
              tag: "effort",
              text: err instanceof Error ? err.message : String(err),
            });
            session.tui.requestRender();
          });
        },
      }),
    );
  };

  const openQuota = () => {
    navigator.push(
      new QuotaCostScreen(spec.client, {
        chatSessionId: spec.chatSessionId,
        runId: spec.runId,
        repoRoot: spec.repoRoot,
      }),
    );
  };

  const openKb = (initialQuery?: string) => {
    navigator.push(new KbBrowserScreen(spec.client, spec.repoRoot, initialQuery));
  };

  const openSessions = () => {
    navigator.push(
      new SessionSwitcherScreen(
        spec.client,
        spec.sessionId,
        (picked) =>
          switchTo(picked.kind, picked.id, {
            ...(picked.host && picked.host !== "local" ? { targetHost: picked.host } : {}),
            ...(picked.nodeId ? { targetNodeId: picked.nodeId } : {}),
            ...(picked.projectId ? { projectId: picked.projectId } : {}),
            ...(picked.repoRoot ? { repoRoot: picked.repoRoot } : {}),
          }),
        () => switchTo("chat", "__new__"),
      ),
    );
  };

  const openSettings = () => {
    navigator.push(new SettingsScreen(spec.client, { repoRoot: spec.repoRoot }));
  };

  const stopAllAgents = async (reason?: string) => {
    try {
      await spec.onCancelActiveTurn();
      const res = await spec.client.request<{
        stoppedRunIds?: string[];
        cancelledChats?: number;
        cancelledReviews?: number;
        cancelledTimers?: number;
      }>("runs.stop_all", {
        reason: reason || "Stopped by user (/stop)",
      });
      const runsStopped = res.stoppedRunIds?.length ?? 0;
      const chatsCancelled = res.cancelledChats ?? 0;
      const reviewsCancelled = res.cancelledReviews ?? 0;
      const timersCancelled = res.cancelledTimers ?? 0;
      const summaryParts: string[] = [];
      if (runsStopped > 0) {
        const ids = res.stoppedRunIds!.slice(0, 3).join(", ");
        summaryParts.push(runsStopped > 3 ? `${ids} and ${runsStopped - 3} more run(s)` : ids);
      }
      if (chatsCancelled > 0) summaryParts.push(`${chatsCancelled} chat turn(s)`);
      if (reviewsCancelled > 0) summaryParts.push(`${reviewsCancelled} review(s)`);
      if (timersCancelled > 0) summaryParts.push(`${timersCancelled} pending resume timer(s)`);
      transcript.appendReceipt({
        glyph: theme.glyphs.cross,
        tone: "warn",
        tag: "stop",
        text:
          summaryParts.length > 0
            ? `Stopped ${summaryParts.join(", ")}. Nothing restarts by itself; resume with \`pi-harness resume <run-id>${remoteFlag(spec.remoteHost)}\` or ask the Director to continue.`
            : "No active runs, chats, or reviews were running.",
      });
      await store.refresh();
    } catch (err) {
      transcript.appendReceipt({
        glyph: theme.glyphs.cross,
        tone: "danger",
        tag: "stop",
        text: `Failed to stop agents: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    session.tui.requestRender();
  };

  const openPalette = () => {
    const actions: QuickActionItem[] = [
      { id: "projects", label: "/projects", detail: "Select, Create, Clone or Switch Local & Remote Projects (Ctrl+P)", pinned: true, run: () => openProjects() },
      { id: "remotes", label: "/remotes", detail: "Manage Remote SSH Peer Hosts & Switch Host", pinned: true, run: () => openRemotes() },
      { id: "settings", label: "/settings", detail: "ACP CLIs, Enabled Models & Defaults (Ctrl+,)", pinned: true, run: () => openSettings() },
      ...(spec.onModelUpdated ? [{ id: "model", label: "/model", detail: "Select Model & Enable/Disable Models", pinned: true, run: () => openModels() }] : []),
      ...(spec.onEffortUpdated ? [{ id: "effort", label: "/effort", detail: "Set Reasoning Effort", pinned: true, run: () => openEffort() }] : []),
      { id: "work", label: "/work", detail: "Open Work Navigator (Ctrl+G)", pinned: true, run: () => openWork() },
      { id: "inbox", label: "/inbox", detail: "Open Inbox (escalations & blockers)", pinned: true, run: () => openWork("inbox") },
      { id: "escalations", label: "/escalations", detail: "Open Escalations tab", pinned: true, run: () => openWork("escalations") },
      { id: "quota", label: "/quota", detail: "View Quota Capacity & Spend", pinned: true, run: () => openQuota() },
      { id: "cost", label: "/cost", detail: "View Reported Spend Ledger", pinned: true, run: () => openQuota() },
      { id: "sessions", label: "/sessions", detail: "Switch Chat / Run Session", pinned: true, run: () => openSessions() },
      { id: "kb", label: "/kb", detail: "Browse Knowledge Base", pinned: true, run: () => openKb() },
      { id: "stop", label: "/stop", detail: "Stop ALL active runs & agents", pinned: true, run: () => void stopAllAgents() },
      { id: "goals", label: "/goals", detail: "Open Goals tab", pinned: false, run: () => openWork("goals") },
      { id: "runs", label: "/runs", detail: "Open Runs tab (Ctrl+T)", pinned: false, run: () => openWork("runs") },
      { id: "timers", label: "/timers", detail: "Open Timers tab", pinned: false, run: () => openWork("timers") },
      { id: "worktrees", label: "/worktrees", detail: "Open Worktrees & Merges tab", pinned: false, run: () => openWork("worktrees") },
    ];
    navigator.push(new GoToPaletteScreen(inspectorDeps, recentRefs, actions));
  };

  const dockHints: Hint[] = [
    { key: "Ctrl+P", label: "Projects" },
    { key: "Ctrl+G", label: "Work" },
    { key: "Ctrl+T", label: "Runs" },
    { key: "Ctrl+O", label: "Go" },
    { key: "Ctrl+,", label: "Settings" },
    { key: "Ctrl+X", label: "Inspect" },
    { key: "/stop", label: "Stop all" },
    { key: "/help", label: "Help" },
  ];

  const handleSlash = async (raw: string): Promise<boolean> => {
    const parsed = parseSlashCommand(raw);
    if (!parsed) return false;
    switch (parsed.name) {
      case "projects": {
        const arg = parsed.args.trim();
        if (!arg) {
          openProjects();
          return true;
        }
        const addMatch = arg.match(/^add\s+(\S+)(?:\s+(.+))?$/i);
        if (addMatch) {
          const created = await spec.client.request<ProjectRecord>("project.create", {
            path: addMatch[1]!,
            name: addMatch[2]?.trim() || undefined,
            createDir: true,
          });
          transcript.appendReceipt({
            glyph: theme.glyphs.check,
            tone: "ok",
            tag: "project",
            text: `Registered project ${created.name} (${created.rootPath}). Use /project ${created.name} to open it.`,
          });
          session.tui.requestRender();
          return true;
        }
        const swMatch = arg.match(/^switch\s+(.+)$/i);
        if (swMatch && spec.onSwitchCurrentSessionProject) {
          const target = await spec.client.request<ProjectRecord>("project.get", { projectId: swMatch[1]!.trim() });
          await spec.onSwitchCurrentSessionProject(target);
          inspectorDeps.repoRoot = target.rootPath;
          store.setScope({ chatSessionId: spec.chatSessionId, repoRoot: target.rootPath, runId: spec.runId });
          void store.refresh();
          syncDock();
          return true;
        }
        // `<host>:<project>` opens a project on a configured remote or connected peer host.
        const hostMatch = arg.match(/^([^:\s/]+):(.+)$/);
        if (hostMatch) {
          const wanted = hostMatch[1]!.toLowerCase();
          let host = spec.localRemotes?.find((r) => r.name.toLowerCase() === wanted)?.name;
          if (!host) {
            const peers = await spec.client.request<Array<{ name: string }>>("remote.list").catch(() => []);
            host = peers.find((r) => r.name.toLowerCase() === wanted)?.name;
          }
          if (host) {
            const remote = await spec.client.request<ProjectRecord & { nodeId?: string | null }>("project.get", {
              projectId: hostMatch[2]!.trim(),
              host,
            });
            switchTo("chat", "__project__", {
              projectId: remote.id,
              repoRoot: remote.rootPath,
              targetHost: host,
              ...(remote.nodeId ? { targetNodeId: remote.nodeId } : {}),
            });
            return true;
          }
        }
        const target = await spec.client.request<ProjectRecord>("project.get", { projectId: arg });
        switchTo("chat", "__project__", { projectId: target.id, repoRoot: target.rootPath });
        return true;
      }
      case "remotes": {
        const sub = parsed.args.trim();
        if (!sub) {
          openRemotes();
          return true;
        }
        const parts = sub.split(/\s+/);
        const verb = parts[0]!.toLowerCase();
        if (spec.remoteHost && ["add", "connect", "disconnect", "rm", "remove"].includes(verb)) {
          transcript.appendReceipt({
            tone: "warn",
            tag: "remote",
            text: `Switch to local (/remotes use local) before running /remotes ${verb}`,
          });
          session.tui.requestRender();
          return true;
        }
        if (verb === "add" && parts.length >= 3) {
          const [, name, sshTarget, ...bridgeRest] = parts;
          const added = await spec.client.request<{ name: string; status: string; lastError?: string | null }>("remote.add", {
            name,
            sshTarget,
            ...(bridgeRest.length > 0 ? { bridgeCommand: bridgeRest.join(" ") } : {}),
            autoConnect: true,
          });
          transcript.appendReceipt({
            tone: added.status === "connected" ? "ok" : "warn",
            tag: "remote",
            text:
              added.status === "connected"
                ? `Connected remote "${added.name}"`
                : `Saved remote "${added.name}" (${added.lastError ?? added.status})`,
          });
          session.tui.requestRender();
          return true;
        }
        if ((verb === "connect" || verb === "disconnect") && parts[1]) {
          const st = await spec.client.request<{ name: string; status: string }>(`remote.${verb}`, { name: parts[1] });
          transcript.appendReceipt({ tone: st.status === "connected" ? "ok" : "info", tag: "remote", text: `${st.name}: ${st.status}` });
          session.tui.requestRender();
          return true;
        }
        if ((verb === "rm" || verb === "remove") && parts[1]) {
          await spec.client.request("remote.remove", { name: parts[1] });
          transcript.appendReceipt({ tone: "warn", tag: "remote", text: `Removed remote "${parts[1]}"` });
          session.tui.requestRender();
          return true;
        }
        if (verb === "use" || verb === "switch") {
          const host = parts[1];
          if (host) {
            switchTo("chat", "__host__", { targetHost: host });
            return true;
          }
        }
        openRemotes();
        return true;
      }
      case "send": {
        const m = parsed.args.match(/^(\S+)\s+([\s\S]+)$/);
        if (!m) {
          transcript.appendReceipt({ tone: "warn", tag: "send", text: "Usage: /send <host:chat-id|chat-id> <message>" });
        } else {
          const res = await spec.client.request<{ target: string; status: string; woke?: boolean; note?: string }>(
            "session.send_message",
            {
              fromSessionId: spec.chatSessionId ?? spec.sessionId,
              target: m[1],
              body: m[2],
              expectReply: true,
            },
          );
          transcript.appendReceipt({
            tone: res.status === "delivered" ? "ok" : "warn",
            tag: "peer",
            text:
              res.status === "delivered"
                ? `Sent to ${res.target}${res.woke ? " (woke recipient)" : ""}`
                : res.note ?? `Queued for ${res.target}`,
          });
        }
        session.tui.requestRender();
        return true;
      }
      case "work": {
        const tab = (["inbox", "goals", "runs", "escalations", "timers", "worktrees"] as const).find(
          (t) => t === parsed.args.toLowerCase(),
        );
        openWork(tab);
        return true;
      }
      case "inbox":
        openWork("inbox");
        return true;
      case "escalations":
        openWork("escalations");
        return true;
      case "goals":
        openWork("goals");
        return true;
      case "runs":
        openWork("runs");
        return true;
      case "timers":
        openWork("timers");
        return true;
      case "worktrees":
        openWork("worktrees");
        return true;
      case "stop":
        await stopAllAgents(parsed.args || undefined);
        return true;
      case "model":
        openModels();
        return true;
      case "effort":
        if (parsed.args && spec.onEffortUpdated) {
          try {
            await spec.onEffortUpdated(parsed.args);
          } catch (err) {
            transcript.appendReceipt({
              tone: "danger",
              tag: "effort",
              text: err instanceof Error ? err.message : String(err),
            });
            session.tui.requestRender();
          }
          return true;
        }
        openEffort();
        return true;
      case "quota":
      case "cost":
        openQuota();
        return true;
      case "kb":
        openKb(parsed.args || undefined);
        return true;
      case "sessions": {
        if (parsed.args) {
          const targetId = parsed.args.trim();
          if (targetId === spec.sessionId) {
            transcript.appendReceipt({ tone: "info", tag: "sessions", text: `Already attached to ${targetId}` });
            session.tui.requestRender();
            return true;
          }
          try {
            const list = await spec.client.request<AttachableSession[]>("sessions.list");
            const found = (list ?? []).find((s) => s.id === targetId);
            if (found) {
              switchTo(found.kind, found.id);
              return true;
            }
          } catch {
            // fallback to prefix heuristic
          }
          const inferredKind = targetId.startsWith("run-") ? "run" : "chat";
          switchTo(inferredKind, targetId);
          return true;
        }
        openSessions();
        return true;
      }
      case "new":
        switchTo("chat", "__new__", parsed.args ? { title: parsed.args } : undefined);
        return true;
      case "settings":
        openSettings();
        return true;
      case "status": {
        const [daemonSt] = await Promise.all([
          spec.client.request<DaemonStatusResult>("status").catch(() => null),
          store.refresh(),
        ]);
        const s = store.state;
        const activeGoals = s.goals.filter((g) =>
          ["executing", "verifying", "reviewing", "awaiting_human"].includes(g.goal.status),
        ).length;
        const unresolvedEsc = store.unresolvedEscalationsCount;
        const activeRuns = s.runs.filter((r) => r.run.status === "active" || r.run.status === "paused_quota").length;
        const enabledClis = (daemonSt?.profiles ?? []).filter((p) => p.enabled).map((p) => p.id);
        const curModel = spec.getCurrentModel?.();
        const modelStr = curModel
          ? `${curModel.profileId ?? "auto"}/${curModel.model ?? "CLI default"}${curModel.effort ? ` (${curModel.effort})` : ""}`
          : spec.getRightStatus();
        const daemonLine = daemonSt
          ? `daemon PID ${daemonSt.pid} (up ${formatDuration(daemonSt.uptimeMs)}) · CLIs: ${enabledClis.join(", ") || "none"}`
          : "daemon connected";
        transcript.appendReceipt({
          glyph: theme.glyphs.diamond,
          tone: "info",
          tag: "daemon",
          text: `${daemonLine} · model: ${modelStr}`,
        });
        transcript.appendReceipt({
          glyph: theme.glyphs.bullet,
          tone: unresolvedEsc > 0 ? "warn" : "info",
          tag: "work",
          text: `${activeGoals} active goal(s) · ${activeRuns} active run(s) · ${unresolvedEsc} unresolved escalation(s) · ${s.inbox.length} inbox item(s) — Ctrl+G Work`,
        });
        session.tui.requestRender();
        return true;
      }
      case "steer": {
        const m = parsed.args.match(/^(\S+)\s+([\s\S]+)$/);
        if (!m) {
          transcript.appendReceipt({ tone: "warn", tag: "steer", text: "Usage: /steer <task-id> <message>" });
        } else {
          try {
            const res = await spec.client.request<{ steered?: boolean }>("task.steer", {
              taskId: m[1],
              message: m[2],
            });
            transcript.appendReceipt({
              tone: res?.steered ? "ok" : "warn",
              tag: "steer",
              text: res?.steered
                ? `Steered ${m[1]}`
                : `${m[1]} is not actively running (steer not delivered)`,
            });
          } catch (err) {
            transcript.appendReceipt({
              tone: "danger",
              tag: "steer",
              text: err instanceof Error ? err.message : String(err),
            });
          }
        }
        session.tui.requestRender();
        return true;
      }
      case "resume": {
        if (!spec.runId) {
          openWork("runs");
          return true;
        }
        try {
          const inMatch = parsed.args.match(/^in\s+(.+)$/i);
          if (inMatch) {
            const delayMs = parseDurationMs(inMatch[1]!);
            if (!delayMs) {
              transcript.appendReceipt({ tone: "warn", tag: "resume", text: `Invalid duration: ${inMatch[1]}` });
            } else {
              await spec.client.request("run.schedule_resume", { runId: spec.runId, delayMs });
              transcript.appendReceipt({ tone: "ok", tag: "resume", text: `Scheduled resume in ${formatDuration(delayMs)}` });
            }
          } else {
            const res = await spec.client.request<{ resumed?: boolean; outcome?: string; message?: string } | null>("run.resume", {
              runId: spec.runId,
              message: parsed.args || undefined,
            });
            transcript.appendReceipt({ ...resumeReceipt(res, spec.runId), tag: "resume" });
          }
        } catch (err) {
          transcript.appendReceipt({
            tone: "danger",
            tag: "resume",
            text: err instanceof Error ? err.message : String(err),
          });
        }
        session.tui.requestRender();
        return true;
      }
      case "clear":
        transcript.clearAll();
        spec.onClear?.();
        session.tui.requestRender();
        return true;
      case "help":
        transcript.appendLines(["", ...renderHelp(spec.mode), ""]);
        session.tui.requestRender();
        return true;
      case "quit":
        exitAction = { kind: "exit" };
        void session.stop();
        return true;
      default:
        transcript.appendReceipt({ tone: "warn", tag: "cmd", text: `Unknown command /${parsed.name}. Try /help.` });
        session.tui.requestRender();
        return true;
    }
  };

  const initialHud = store.buildLiveHud();
  dock = new FixedDock(session.tui, theme, {
    autocomplete: createCommandAutocomplete(spec.mode),
    initialState: {
      slots: initialHud.slots,
      agentCounts: initialHud.agentCounts,
      hudItems: initialHud.hudItems,
      hudSecondaryLine: initialHud.hudSecondaryLine,
      activeGoalsCount: initialHud.activeGoalsCount,
      idleBanner: spec.getIdleBanner(),
      busy: false,
      phaseText: "Ready",
      remoteHost: spec.remoteHost ?? null,
      transientHint: null,
      rightStatus: spec.getRightStatus(),
      queuedCount: 0,
      hints: dockHints,
    },
    onSubmit: (raw) => {
      const text = raw.trim();
      if (!text) return;
      if (text.startsWith("/")) {
        void handleSlash(text).catch((err) => {
          transcript.appendReceipt({
            tone: "danger",
            tag: "cmd",
            text: err instanceof Error ? err.message : String(err),
          });
          session.tui.requestRender();
        });
        return;
      }
      void spec.onUserSubmit(text).catch((err) => {
        transcript.appendReceipt({
          tone: "danger",
          tag: "error",
          text: err instanceof Error ? err.message : String(err),
        });
        session.tui.requestRender();
      });
    },
  });

  const syncDock = () => {
    const hud = store.buildLiveHud();
    dock.update({
      slots: hud.slots,
      agentCounts: hud.agentCounts,
      hudItems: hud.hudItems,
      hudSecondaryLine: hud.hudSecondaryLine,
      activeGoalsCount: hud.activeGoalsCount,
      idleBanner: spec.getIdleBanner(),
      busy,
      phaseText,
      remoteHost: spec.remoteHost ?? null,
      transientHint,
      rightStatus: spec.getRightStatus(),
      queuedCount: queuedMessages.length,
    });
    session.tui.requestRender();
  };

  session.tui.addChild(transcript);
  session.tui.addChild(dock);
  session.tui.setFocus(dock.editor);

  // Float slash-command autocomplete above the dock so typing `/` never shifts the input up or leaves blank rows below!
  dock.editor.floatAutocomplete = true;
  session.tui.setFloatingPopupProvider((width) => {
    const acLines = dock.editor.getFloatingAutocompleteLines();
    if (acLines.length === 0) return null;
    const w = Math.max(12, Math.floor(width));
    const g = theme.glyphs;
    const innerW = Math.max(4, w - 4);
    const bdr = theme.borderFocused;
    const framed: string[] = [
      fillLineBg(bdr(`${g.boxTL}${g.barH.repeat(Math.max(1, w - 2))}${g.boxTR}`), w, theme.surfaceBg),
      ...acLines.map((l) => fillLineBg(`${bdr(g.barV)} ${fit(l.trimEnd(), innerW)} ${bdr(g.barV)}`, w, theme.surfaceBg)),
      fillLineBg(bdr(`${g.boxBL}${g.barH.repeat(Math.max(1, w - 2))}${g.boxBR}`), w, theme.surfaceBg),
    ];
    return { lines: framed, bottomOffset: dock.renderedHeight };
  });

  const unsubStore = store.subscribe(syncDock);

  const spinTimer = setInterval(() => {
    if (dock.tickSpinner()) session.tui.requestRender();
  }, 120);
  spinTimer.unref?.();

  // Gentle live telemetry poll ONLY while goals/agents are in flight so currentAction stays fresh between status transitions.
  const hudPollTimer = setInterval(() => {
    if (store.hasLiveWork()) void store.refresh();
  }, 3000);
  hudPollTimer.unref?.();

  // Global keyboard shortcuts when no overlay is open
  session.start((data) => {
    if (navigator.isOpen) return undefined;

    if (matchesKey(data, "ctrl+p")) {
      openProjects();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+g")) {
      openWork();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+t")) {
      openWork("runs");
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      openPalette();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+,")) {
      openSettings();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+x")) {
      const latest = recentRefs.latest();
      if (latest) openEntity(latest);
      else openWork();
      return { consume: true };
    }

    // Queue follow-up draft while busy (`Ctrl+Q` or `Alt+Enter`)
    if (
      busy &&
      (data === "\x11" || data === "\x1b\r" || matchesKey(data, "ctrl+q") || matchesKey(data, "alt+enter"))
    ) {
      const draft = dock.editor.getText().trim();
      if (draft) {
        queuedMessages.push(draft);
        dock.editor.setText("");
        dock.editor.clearUndoHistory();
        transcript.appendReceipt({
          tone: "info",
          tag: "queued",
          text: `Queued (${queuedMessages.length}): ${firstLine(draft, 80)} — Ctrl+R to recall`,
        });
        syncDock();
        return { consume: true };
      }
    }

    // Recall latest queued draft back into composer (`Ctrl+R`)
    if (matchesKey(data, "ctrl+r") && queuedMessages.length > 0) {
      const recalled = queuedMessages.pop()!;
      dock.editor.setText(recalled);
      syncDock();
      return { consume: true };
    }

    // Alt+1..Alt+5 jump straight into numbered dock attention slot (supports legacy ESC+digit, Kitty CSI u, and modifyOtherKeys)
    const altKeys = ["alt+1", "alt+2", "alt+3", "alt+4", "alt+5"] as const;
    for (let i = 0; i < altKeys.length; i++) {
      if (matchesKey(data, altKeys[i]!)) {
        const slot = dock.slots[i];
        if (slot) {
          openEntity(slot.ref);
          return { consume: true };
        }
      }
    }

    return undefined;
  });

  const recordRef = (ref: EntityRef) => {
    recentRefs.push(ref);
  };

  return {
    theme,
    session,
    transcript,
    dock,
    navigator,
    store,
    recentRefs,
    queuedMessages,
    recordRef,
    openEntity,
    openWork,
    setStatus(nextBusy: boolean, nextPhase: string) {
      busy = nextBusy;
      phaseText = nextPhase;
      syncDock();
    },
    syncDock,
    async waitAndCleanup(): Promise<TuiExitAction> {
      await session.done;
      clearInterval(spinTimer);
      clearInterval(hudPollTimer);
      unsubStore();
      store.dispose();
      return exitAction;
    },
  };
}

/* ───────────────────────────── Director Chat TUI ──────────────────────────── */

async function loadAllChatHistory(client: DaemonClient, opened: ChatOpenResult): Promise<ChatTurnRecord[]> {
  const all = [...(opened.history ?? [])];
  let afterSeq = opened.historyNext;
  const throughSeq = opened.historyThrough;
  while (afterSeq != null && throughSeq != null) {
    const page = await client.request<{ history: ChatTurnRecord[]; historyNext?: number | null }>("chat.history", {
      chatSessionId: opened.session.id,
      afterSeq,
      throughSeq,
    });
    if (page.historyNext != null && page.historyNext <= afterSeq) break;
    for (const row of page.history ?? []) all.push(row);
    afterSeq = page.historyNext ?? null;
  }
  return all;
}

export async function runDirectorChatTui(opts: DirectorChatTuiOptions): Promise<TuiExitAction> {
  // Register event listener BEFORE chat.open so zero early frames are missed during handshake/pagination!
  const earlyBuffer: DaemonEventFrame[] = [];
  let buffering = true;
  let liveHandler: ((ev: DaemonEventFrame) => void) | null = null;
  const detachEvents = opts.client.onEvent((ev) => {
    if (buffering) earlyBuffer.push(ev);
    else liveHandler?.(ev);
  });

  let opened: ChatOpenResult;
  let fullHistory: ChatTurnRecord[];
  try {
    opened = await opts.client.request<ChatOpenResult>("chat.open", {
      ...(opts.repoRoot ? { repoRoot: opts.repoRoot } : {}),
      ...(opts.projectId ? { projectId: opts.projectId } : {}),
      ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
      ...(opts.preferLastGlobal ? { preferLastGlobal: true } : {}),
      ...(opts.preferLastProject ? { preferLastProject: true } : {}),
    });
    fullHistory = await loadAllChatHistory(opts.client, opened);
  } catch (err) {
    detachEvents();
    throw err;
  }

  let chatSession = opened.session;
  let activeProject: ProjectRecord | null = opened.project ?? null;
  let activeTurnId: string | null = opened.activeTurnId;
  let sending = opened.busy;
  let turnFrozeSegments = false;
  const frozenTextSet = new Set<string>();
  const settledTurns = new Set<string>();

  const modelBadge = () => {
    const m = chatSession.model ?? "CLI default";
    const e = chatSession.effort ? ` (${chatSession.effort})` : "";
    return `${chatSession.profileId ?? "director"} · ${m}${e}`;
  };

  let shell!: ReturnType<typeof createSharedShell>;

  const settleTurn = (turnId: string | null, optsSettle: { finalText?: string; error?: string; cancelled?: boolean }) => {
    if (turnId) {
      if (settledTurns.has(turnId)) return;
      settledTurns.add(turnId);
      if (settledTurns.size > 128) {
        const first = settledTurns.values().next().value;
        if (first) settledTurns.delete(first);
      }
      // Never let a stale turn clobber a newer active turn!
      if (activeTurnId && activeTurnId !== turnId) return;
    }

    let frozenSegments = 0;
    const snap = shell.transcript.liveTail.snapshot();
    // If mid-turn cards/steers already froze earlier streamed text, only append the post-card tail segment!
    const finalText = turnFrozeSegments
      ? snap.text.trim()
        ? snap.text
        : optsSettle.finalText && optsSettle.finalText.trim() && !frozenTextSet.has(optsSettle.finalText.trim())
          ? optsSettle.finalText
          : ""
      : (optsSettle.finalText ?? snap.text);
    shell.transcript.liveTail.clear();
    turnFrozeSegments = false;
    frozenTextSet.clear();
    frozenSegments = 0;
    void frozenSegments;

    // Append assistant turn BEFORE tool/error receipts so live tail freezes in place with zero scrollback wipe
    if (finalText.trim()) {
      shell.transcript.appendAssistantTurn(finalText, snap.modelLabel ?? modelBadge());
    }
    if (snap.tools.length > 0) {
      const ref: EntityRef = {
        kind: "tool_call",
        id: `tools-${Date.now()}`,
        label: `${snap.tools.length} tool call(s): ${snap.tools.map((t) => t.label).join(", ")}`,
        payload: snap.tools,
      };
      shell.recordRef(ref);
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.check,
        tone: snap.tools.some((t) => t.status === "error") ? "warn" : "muted",
        tag: "tools",
        text: `${snap.tools.length} call(s): ${snap.tools.map((t) => t.label).join(", ")}`,
        ref,
      });
    }
    if (optsSettle.error) {
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.cross,
        tone: "danger",
        tag: "error",
        text: optsSettle.error,
      });
    } else if (optsSettle.cancelled) {
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.warn,
        tone: "warn",
        tag: "cancelled",
        text: "Turn cancelled.",
      });
    }

    sending = false;
    activeTurnId = null;
    shell.setStatus(false, "Ready");
    void shell.store.refresh();
    drainQueue();
  };

  const dispatchPrompt = async (text: string): Promise<void> => {
    // Busy Enter calls `chat.steer` for live steering! (Ctrl+Q / Alt+Enter queues instead.)
    if (sending) {
      if (activeTurnId) {
        try {
          const res = await opts.client.request<{ steered?: boolean }>("chat.steer", {
            chatSessionId: chatSession.id,
            turnId: activeTurnId,
            message: text,
          });
          if (res?.steered) {
            if (shell.transcript.freezeLiveText()) {
              turnFrozeSegments = true;
            }
            shell.transcript.appendUserTurn(text);
            shell.transcript.appendReceipt({ tone: "info", tag: "steered", text: "Delivered live steering to Director" });
            shell.session.tui.requestRender();
            return;
          }
        } catch {
          // Fall through to queueing if steer fails
        }
      }
      shell.queuedMessages.push(text);
      shell.transcript.appendReceipt({
        tone: "info",
        tag: "queued",
        text: `Queued (${shell.queuedMessages.length}): ${firstLine(text, 80)}`,
      });
      shell.syncDock();
      // If the active turn ended or cancelled while `chat.steer` was in flight, drain immediately!
      if (!sending) drainQueue();
      return;
    }

    sending = true;
    turnFrozeSegments = false;
    frozenTextSet.clear();
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    activeTurnId = turnId;
    shell.transcript.appendUserTurn(text);
    shell.transcript.liveTail.begin(modelBadge());
    shell.setStatus(true, "Director thinking...");

    try {
      await opts.client.request("chat.send", {
        chatSessionId: chatSession.id,
        text,
        turnId,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("Director is already responding") && activeTurnId !== turnId) {
        // A wake turn started right before our send; queue our prompt so it runs right after!
        shell.queuedMessages.unshift(text);
        shell.transcript.appendReceipt({
          tone: "info",
          tag: "queued",
          text: `Director busy with background wake — queued: ${firstLine(text, 80)}`,
        });
        shell.syncDock();
        return;
      }
      // Idempotent settlement: if `chat.turn.end` already settled this turn, this is a safe no-op
      settleTurn(turnId, { error: msg });
    }
  };

  const drainQueue = () => {
    if (sending || shell.queuedMessages.length === 0) return;
    const next = shell.queuedMessages.shift()!;
    shell.syncDock();
    void dispatchPrompt(next);
  };

  shell = createSharedShell({
    mode: "chat",
    client: opts.client,
    remoteHost: opts.remoteHost ?? null,
    localRemotes: opts.localRemotes,
    repoRoot: chatSession.repoRoot || opts.repoRoot || process.cwd(),
    projectId: activeProject?.id ?? chatSession.projectId,
    getProject: () => ({
      id: activeProject?.id ?? chatSession.projectId,
      name: activeProject?.name ?? null,
      repoRoot: chatSession.repoRoot,
    }),
    onSwitchCurrentSessionProject: async (project) => {
      const res = await opts.client.request<{ session: ChatSessionRecord; project: ProjectRecord }>("chat.set_project", {
        chatSessionId: chatSession.id,
        projectId: project.id,
      });
      chatSession = res.session;
      activeProject = res.project;
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.check,
        tone: "ok",
        tag: "project",
        text: `Switched ${chatSession.id} → ${project.name} (${project.rootPath})`,
      });
      shell.syncDock();
    },
    sessionId: chatSession.id,
    chatSessionId: chatSession.id,
    terminal: opts.terminal,
    getRightStatus: modelBadge,
    getIdleBanner: () => {
      const pTag = activeProject ? `[${activeProject.name}] · ` : "";
      return `${pTag}${chatSession.id} · ${sanitizeLine(chatSession.title || "Director Chat")} (Ctrl+P Projects · Ctrl+G Work · Ctrl+O Go)`;
    },
    onUserSubmit: dispatchPrompt,
    onCancelActiveTurn: async () => {
      if (!activeTurnId) return false;
      const id = activeTurnId;
      await opts.client.request("chat.cancel", { chatSessionId: chatSession.id, turnId: id }).catch(() => {});
      return true;
    },
    getCurrentModel: () => ({
      profileId: chatSession.profileId,
      model: chatSession.model,
      effort: chatSession.effort,
    }),
    onModelUpdated: async (sel) => {
      const updated = await opts.client.request<ChatSessionRecord>("chat.update", {
        chatSessionId: chatSession.id,
        profileId: sel.profileId,
        model: sel.model,
        effort: sel.effort,
      });
      chatSession = updated;
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.check,
        tone: "ok",
        tag: "model",
        text: `Switched to ${sel.profileId} / ${sel.model ?? "CLI default"}${sel.effort ? ` (${sel.effort})` : ""}`,
      });
      shell.syncDock();
    },
    onEffortUpdated: async (effort) => {
      // Updates effort independently without changing model/profile (works on CLI-default sessions too!)
      const updated = await opts.client.request<ChatSessionRecord>("chat.update", {
        chatSessionId: chatSession.id,
        effort,
      });
      chatSession = updated;
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.check,
        tone: "ok",
        tag: "effort",
        text: `Reasoning effort set to ${effort} (${modelBadge()})`,
      });
      shell.syncDock();
    },
  });

  // Top session banner (prominently flags `[REMOTE: <host>]` whenever attached to a remote host)
  const remotePrefix = opts.remoteHost ? `[REMOTE: ${opts.remoteHost}] ` : "";
  const projectLabel = activeProject ? `${activeProject.name} (${chatSession.repoRoot})` : chatSession.repoRoot || opts.repoRoot || "";
  shell.transcript.appendBanner(
    `${remotePrefix}pi-harness · ${chatSession.id}${activeProject ? ` · [${activeProject.name}]` : ""}`,
    modelBadge(),
    `project: ${projectLabel}  ·  Ctrl+P Projects · /remotes · Ctrl+G Work · /help`,
  );
  if (opts.initialNotice) {
    shell.transcript.appendReceipt({ tone: opts.initialNotice.tone, tag: "host", text: opts.initialNotice.text });
  }

  // Hydrate ALL paginated chat history cleanly as immutable blocks
  for (const turn of fullHistory) {
    if (turn.role === "user") {
      shell.transcript.appendUserTurn(turn.content);
    } else if (turn.role === "assistant") {
      shell.transcript.appendAssistantTurn(turn.content);
    } else if (turn.role === "tool_output") {
      const display = parseToolDisplay(turn.display);
      if (display) {
        shell.transcript.appendToolOutput(display);
      } else {
        shell.transcript.appendToolOutputNote(turn.content || turn.toolName || "tool output");
      }
    } else if (turn.role === "system_notice") {
      const parsed = turn.event ? parseChatControlEvent(turn.event) : null;
      const summary = parsed ? settledReceiptText(parsed, opts.remoteHost) : turn.content;
      const ref: EntityRef | undefined =
        parsed && "goalId" in parsed && parsed.goalId
          ? { kind: "goal", id: parsed.goalId, label: `${parsed.goalId}` }
          : undefined;
      if (ref) shell.recordRef(ref);
      shell.transcript.appendReceipt({
        tone: parsed?.kind === "goal.reviewed" ? "ok" : "info",
        tag: parsed?.kind ?? "notice",
        text: summary,
        ref,
      });
    }
  }

  if (opened.busy) {
    sending = true;
    shell.transcript.liveTail.begin(modelBadge());
    // Seed from `activePartial` (only the unpersisted tail since last mid-turn flush) to avoid duplicating persisted turns!
    const seed = opened.activePartial || (opened.history.length === 0 ? opened.activeText : "");
    if (seed) shell.transcript.liveTail.appendText(seed);
    shell.setStatus(true, "Director responding...");
  }

  const handleChatEvent = (ev: DaemonEventFrame) => {
    if (ev.watchId) return;
    const p = (ev.payload ?? {}) as Record<string, unknown>;

    if (ev.type === "session.taken_over") {
      const sid = typeof p.sessionId === "string" ? p.sessionId : ev.runId;
      if (sid && sid !== chatSession.id) return;
      shell.transcript.appendReceipt({
        tone: "warn",
        tag: "session",
        text: "Another client took over this session — detaching.",
      });
      void shell.session.stop();
      return;
    }

    if (ev.type === "session.message_received" && ev.runId === chatSession.id) {
      const fromHost = String(p.fromHost ?? "peer");
      const fromSid = String(p.fromSessionId ?? "?");
      const fromProj = typeof p.fromProjectName === "string" && p.fromProjectName ? ` [${p.fromProjectName}]` : "";
      const bodyText = firstLine(String(p.body ?? ""), 100);
      const tripped = Boolean(p.circuitBreakerTripped);
      shell.transcript.appendReceipt({
        tone: tripped ? "warn" : "info",
        tag: tripped ? "peer-paused" : "peer",
        text: `${fromHost}:${fromSid}${fromProj}: ${bodyText}${tripped ? " (auto-wakeup paused by hop breaker)" : ""}`,
      });
      shell.session.tui.requestRender();
      return;
    }

    // Strict chatSessionId + turnId scoping for all chat.* frames
    if (ev.type.startsWith("chat.")) {
      const evChatId = typeof p.chatSessionId === "string" ? p.chatSessionId : ev.runId;
      if (evChatId !== chatSession.id) return;
      const evTurnId = typeof p.turnId === "string" ? p.turnId : null;

      if (ev.type === "chat.turn.start") {
        sending = true;
        turnFrozeSegments = false;
        frozenTextSet.clear();
        activeTurnId = evTurnId ?? activeTurnId;
        shell.transcript.liveTail.begin(modelBadge());
        shell.setStatus(true, "Director responding...");
        return;
      }

      if (activeTurnId && evTurnId && evTurnId !== activeTurnId) return;

      if (ev.type === "chat.delta") {
        const delta = String(p.delta ?? "");
        if (delta) {
          shell.transcript.liveTail.appendText(delta);
          shell.session.tui.requestRender();
        }
        return;
      }

      if (ev.type === "chat.steered") {
        const msg = typeof p.message === "string" ? firstLine(p.message, 80) : "";
        if (p.role !== "user" && msg) {
          const prevSnap = shell.transcript.liveTail.snapshot().text.trim();
          if (shell.transcript.freezeLiveText()) {
            turnFrozeSegments = true;
            if (prevSnap) frozenTextSet.add(prevSnap);
          }
          shell.transcript.appendReceipt({ tone: "info", tag: "steer", text: msg });
          shell.session.tui.requestRender();
        }
        return;
      }

      if (ev.type === "chat.tool") {
        // Structured tool-output cards (`present_result`, `goals_table`, `goal_detail`, `run_activity`)
        const display = extractDisplay(p);
        if (display) {
          const prevSnap = shell.transcript.liveTail.snapshot().text.trim();
          if (prevSnap) {
            turnFrozeSegments = true;
            frozenTextSet.add(prevSnap);
          }
          shell.transcript.appendToolOutput(display);
          shell.session.tui.requestRender();
          return;
        }

        const id = String(p.id ?? p.toolCallId ?? randomUUID().slice(0, 8));
        const label = formatToolLabel(String(p.name ?? p.title ?? "tool"));
        const rawStatus = String(p.status ?? "running");
        const status =
          rawStatus === "completed" || rawStatus === "ok"
            ? "ok"
            : rawStatus === "error" || rawStatus === "failed"
              ? "error"
              : "running";
        const detail = typeof p.summary === "string" ? p.summary : undefined;
        shell.transcript.liveTail.upsertTool({ id, label, status, detail });
        if (status !== "running") {
          shell.recordRef({
            kind: "tool_call",
            id,
            label: `${label}${detail ? `: ${detail}` : ""}`,
            payload: p,
          });
        }
        shell.setStatus(true, `Running ${label}...`);
        return;
      }

      if (ev.type === "chat.turn.end") {
        const assistantTurn = p.assistantTurn as ChatTurnRecord | undefined;
        settleTurn(evTurnId ?? activeTurnId, {
          finalText: assistantTurn?.content,
          error: typeof p.error === "string" && p.error ? p.error : undefined,
          cancelled: Boolean(p.cancelled),
        });
        return;
      }
      return;
    }

    // Live control-plane notices (escalations, goal lifecycle, quota pause/resume)
    if (ev.type === "escalation.created") {
      const escId = String(p.id ?? p.escalationId ?? "");
      const title = String(p.title ?? "Escalation raised");
      const sev = String(p.severity ?? "P1");
      const ref: EntityRef = {
        kind: "escalation",
        id: escId,
        runId: ev.runId,
        label: `${escId} ${title}`,
      };
      if (escId) shell.recordRef(ref);
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.warn,
        tone: sev === "P0" ? "danger" : "warn",
        tag: `${sev} ${escId || "escalation"}`,
        text: title,
        ref: escId ? ref : undefined,
      });
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type.startsWith("goal.")) {
      const parsed = parseChatControlEvent(p);
      const goalId = typeof p.goalId === "string" ? p.goalId : typeof p.id === "string" ? p.id : "";
      const ref: EntityRef | undefined = goalId ? { kind: "goal", id: goalId, runId: ev.runId || undefined, label: goalId } : undefined;
      if (ref) shell.recordRef(ref);
      const summary = parsed
        ? settledReceiptText(parsed, opts.remoteHost)
        : sanitizeLine(String(p.summary ?? p.title ?? p.status ?? ev.type));
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.diamond,
        tone: ev.type === "goal.reviewed" && p.status === "achieved" ? "ok" : "info",
        tag: goalId || ev.type,
        text: summary,
        ref,
      });
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type.startsWith("quota.")) {
      const reason = sanitizeLine(String(p.reason ?? p.mode ?? ev.type));
      const wake = p.resumeAt ? ` · resume ${formatCountdown(p.resumeAt as number | string)}` : "";
      const ref: EntityRef | undefined = ev.runId ? { kind: "run", id: ev.runId, label: ev.runId } : undefined;
      if (ref) shell.recordRef(ref);
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.pause,
        tone: ev.type === "quota.run_resumed" ? "ok" : "warn",
        tag: ev.type.replace(/^quota\./, "quota:"),
        text: `${ev.runId ? `${ev.runId}: ` : ""}${reason}${wake}`,
        ref,
      });
      shell.session.tui.requestRender();
    }
  };

  // Switch from buffering to live delivery and flush early events
  liveHandler = handleChatEvent;
  buffering = false;
  for (const ev of earlyBuffer.splice(0)) handleChatEvent(ev);

  const detachClose = opts.client.onClose(() => {
    void shell.session.stop();
  });

  await shell.store.refresh();
  const action = await shell.waitAndCleanup();
  detachEvents();
  detachClose();
  return action;
}

/* ──────────────────────────── Attached Run TUI ────────────────────────────── */

export async function runNativeScrollbackTui(opts: NativeScrollbackTuiOptions): Promise<TuiExitAction> {
  // Register event listener BEFORE attach so early frames are buffered cleanly!
  const earlyBuffer: DaemonEventFrame[] = [];
  let buffering = true;
  let liveHandler: ((ev: DaemonEventFrame) => void) | null = null;
  const detachEvents = opts.client.onEvent((ev) => {
    if (ev.watchId) return;
    if (buffering) earlyBuffer.push(ev);
    else liveHandler?.(ev);
  });

  let attached: AttachRunResult;
  try {
    attached = await opts.client.request<AttachRunResult>("attach", {
      runId: opts.runId,
      ...(opts.initialTaskId ? { taskId: opts.initialTaskId } : {}),
    });
  } catch (err) {
    detachEvents();
    throw err;
  }

  const repoRoot = attached.run?.repoRoot ?? process.cwd();
  let shell!: ReturnType<typeof createSharedShell>;

  shell = createSharedShell({
    mode: "run",
    client: opts.client,
    remoteHost: opts.remoteHost ?? null,
    localRemotes: opts.localRemotes,
    repoRoot,
    sessionId: opts.runId,
    runId: opts.runId,
    terminal: opts.terminal,
    getRightStatus: () => `run ${opts.runId}${opts.initialTaskId ? ` / ${opts.initialTaskId}` : ""}`,
    getIdleBanner: () => `${opts.runId} (${attached.run?.status ?? "active"}) · Ctrl+G Work · /resume · /stop`,
    onUserSubmit: async (text) => {
      shell.transcript.appendUserTurn(text);
      if (opts.initialTaskId) {
        const res = await opts.client.request<{ steered?: boolean }>("task.steer", {
          taskId: opts.initialTaskId,
          message: text,
        });
        shell.transcript.appendReceipt({
          tone: res?.steered ? "ok" : "warn",
          tag: "steered",
          text: res?.steered ? `Sent to ${opts.initialTaskId}` : `${opts.initialTaskId} is not actively running`,
        });
      } else {
        await opts.client.request("run.resume", { runId: opts.runId, message: text });
        shell.transcript.appendReceipt({ tone: "ok", tag: "run", text: `Sent guidance to ${opts.runId}` });
      }
      shell.session.tui.requestRender();
    },
    onCancelActiveTurn: async () => {
      await opts.client.request("run.stop", { runId: opts.runId, reason: "Stopped from TUI" }).catch(() => {});
      return true;
    },
  });

  const runRemotePrefix = opts.remoteHost ? `[REMOTE: ${opts.remoteHost}] ` : "";
  shell.transcript.appendBanner(
    `${runRemotePrefix}Attached Run · ${opts.runId}${opts.initialTaskId ? ` / ${opts.initialTaskId}` : ""}`,
    attached.run?.status ?? "active",
    `Ctrl+G Work · Ctrl+T Runs · /remotes · /resume · /stop`,
  );
  if (opts.initialNotice) {
    shell.transcript.appendReceipt({ tone: opts.initialNotice.tone, tag: "host", text: opts.initialNotice.text });
  }

  let liveTaskId: string | null = null;
  const flushRunTail = () => {
    const snap = shell.transcript.liveTail.snapshot();
    if (snap.text.trim()) {
      shell.transcript.liveTail.clear();
      shell.transcript.appendAssistantTurn(snap.text, snap.modelLabel || undefined);
    }
    liveTaskId = null;
  };

  const renderEventToTranscript = (ev: EventRecord | DaemonEventFrame) => {
    if ("watchId" in ev && ev.watchId) return;
    if (ev.runId !== opts.runId) return;
    if (opts.initialTaskId && ev.taskId && ev.taskId !== opts.initialTaskId) return;

    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const who = ev.taskId ?? ev.runId;

    if (ev.type === "agent.text_delta") {
      const txt = String(p.text ?? p.delta ?? "");
      if (txt) {
        if (liveTaskId && liveTaskId !== who) {
          flushRunTail();
        }
        if (!shell.transcript.liveTail.isActive) {
          shell.transcript.liveTail.begin(who);
        }
        liveTaskId = who;
        shell.transcript.liveTail.appendText(txt);
        shell.session.tui.requestRender();
      }
      return;
    }

    if (ev.type === "agent.thought_delta") {
      const txt = String(p.text ?? p.delta ?? "");
      if (txt) {
        shell.transcript.liveTail.appendThought(txt);
        shell.session.tui.requestRender();
      }
      return;
    }

    if (ev.type === "agent.tool") {
      const id = String(p.id ?? p.toolCallId ?? `${who}:${String(p.name ?? p.title ?? "tool")}`);
      const label = formatToolLabel(String(p.title ?? p.name ?? "tool"));
      const rawSt = String(p.status ?? "running");
      const status =
        rawSt === "completed" || rawSt === "ok"
          ? "ok"
          : rawSt === "failed" || rawSt === "error"
            ? "error"
            : "running";
      const detail =
        typeof p.error === "string"
          ? p.error
          : typeof p.result === "string"
            ? firstLine(p.result, 60)
            : typeof p.args === "string"
              ? firstLine(p.args, 60)
              : undefined;
      shell.transcript.liveTail.upsertTool({ id, label: `${who}: ${label}`, status, detail });
      if (status !== "running") {
        shell.recordRef({
          kind: "tool_call",
          id,
          runId: ev.runId,
          label: `${who} ${label}${detail ? `: ${detail}` : ""}`,
          payload: p,
        });
      }
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type === "agent.turn_end") {
      flushRunTail();
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type === "agent.rollover") {
      flushRunTail();
      const gen = p.generation ?? p.nextGeneration ?? "";
      shell.transcript.appendReceipt({
        tone: "info",
        tag: `${who} rollover`,
        text: `Clean rollover${gen ? ` → gen ${gen}` : ""}${p.reason ? ` (${sanitizeLine(String(p.reason))})` : ""}`,
      });
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type === "agent.error") {
      flushRunTail();
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.cross,
        tone: "danger",
        tag: `${who} error`,
        text: sanitizeLine(String(p.message ?? p.error ?? "Agent error")),
      });
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type.startsWith("quota.")) {
      flushRunTail();
      const reason = sanitizeLine(String(p.reason ?? p.mode ?? ev.type));
      const wake = p.resumeAt ? ` · resume ${formatCountdown(p.resumeAt as number | string)}` : "";
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.pause,
        tone: ev.type === "quota.run_resumed" ? "ok" : "warn",
        tag: ev.type.replace(/^quota\./, "quota:"),
        text: `${reason}${wake}`,
      });
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type === "escalation.created") {
      flushRunTail();
      const escId = String(p.id ?? p.escalationId ?? "");
      const ref: EntityRef = { kind: "escalation", id: escId, runId: ev.runId, label: `${escId} ${String(p.title ?? "")}` };
      if (escId) shell.recordRef(ref);
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.warn,
        tone: "danger",
        tag: escId || "escalation",
        text: String(p.title ?? "Escalation"),
        ref: escId ? ref : undefined,
      });
      shell.session.tui.requestRender();
      return;
    }

    if (ev.type === "task.status" || ev.type === "run.status") {
      flushRunTail();
      const status = String(p.to ?? p.status ?? "");
      const ref: EntityRef = ev.taskId
        ? { kind: "task", id: ev.taskId, runId: ev.runId, label: ev.taskId }
        : { kind: "run", id: ev.runId, label: ev.runId };
      shell.recordRef(ref);
      shell.transcript.appendReceipt({
        tone: status === "failed" || status === "blocked" ? "danger" : status === "completed" ? "ok" : "info",
        tag: who,
        text:
          `${ev.type}: ${status}${p.summary ? ` — ${sanitizeLine(String(p.summary))}` : ""}` +
          (ev.type === "run.status" && p.reason ? ` — ${sanitizeLine(String(p.reason))}` : "") +
          (ev.type === "run.status" && status === "stopped" ? ` (resume: pi-harness resume ${ev.runId}${remoteFlag(opts.remoteHost)})` : ""),
        ref,
      });
      shell.session.tui.requestRender();
    }
  };

  // Drain ALL paginated replay events (`attached.replay` + `replay.page` + fragments), aborting immediately on detach/close
  let closed = false;
  const detachClose = opts.client.onClose(() => {
    closed = true;
    void shell.session.stop();
  });
  void shell.session.done.then(() => {
    closed = true;
  });

  try {
    await consumeReplay(
      opts.client,
      attached,
      { attachmentId: attached.attachmentId },
      (ev) => renderEventToTranscript(ev),
      () => closed,
    );

    if (!closed) {
      liveHandler = (ev) => {
        if (ev.type === "session.taken_over") {
          const sid = typeof (ev.payload as Record<string, unknown> | undefined)?.sessionId === "string"
            ? String((ev.payload as Record<string, unknown>).sessionId)
            : ev.runId;
          if (sid && sid !== opts.runId) return;
          void shell.session.stop();
          return;
        }
        renderEventToTranscript(ev);
      };
      buffering = false;
      for (const ev of earlyBuffer.splice(0)) liveHandler(ev);
      await shell.store.refresh();
    }
    return await shell.waitAndCleanup();
  } catch (err) {
    closed = true;
    await shell.session.stop();
    await shell.waitAndCleanup().catch(() => {});
    throw err;
  } finally {
    closed = true;
    detachEvents();
    detachClose();
  }
}

/** Receipt text for a chat control event; CLI commands it cites target `remoteHost` when attached to one. */
function settledReceiptText(parsed: NonNullable<ReturnType<typeof parseChatControlEvent>>, remoteHost?: string | null): string {
  return sanitizeLine(formatChatEventSummary(parsed, { remoteHost }));
}

function remoteFlag(remoteHost?: string | null): string {
  return remoteHost ? ` --remote ${remoteHost}` : "";
}

/** Receipt for a run.resume reply: success only when the daemon reports it resumed something. */
function resumeReceipt(
  res: { resumed?: boolean; outcome?: string; message?: string } | null | undefined,
  runId: string,
): { tone: "ok" | "info" | "warn"; text: string } {
  const outcome = res?.outcome ?? (res?.resumed ? "resumed" : undefined);
  const message = res?.message?.trim();
  if (outcome === "resumed") return { tone: "ok", text: message || `Resumed ${runId}` };
  if (outcome === "already_active" || outcome === "already_queued" || outcome === "already_completed" || outcome === "waiting") {
    return { tone: "info", text: message || `${runId}: ${outcome.replace(/_/g, " ")}` };
  }
  return { tone: "warn", text: message || `${runId} was not resumed${outcome ? ` (${outcome.replace(/_/g, " ")})` : " (no reply from the daemon)"}` };
}
