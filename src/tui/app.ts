import { randomUUID } from "node:crypto";
import { matchesKey, type Terminal } from "@earendil-works/pi-tui";
import type { RunRecord } from "../control-plane/db.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../director/session.js";
import { formatChatEventSummary, parseChatControlEvent } from "../protocol/chat-events.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import { createCommandAutocomplete, parseSlashCommand, renderHelp, type TuiMode } from "./commands.js";
import {
  createTheme,
  type TuiEntityRef as EntityRef,
  FixedDock,
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
  GoToPaletteScreen,
  KbBrowserScreen,
  ModelPickerScreen,
  type QuickActionItem,
  QuotaCostScreen,
  SessionSwitcherScreen,
  SettingsScreen,
} from "./pickers.js";
import { WorkStore } from "./store.js";
import { WorkNavigatorScreen, type WorkTabId } from "./work-navigator.js";

export type TuiExitAction =
  | { kind: "exit" }
  | { kind: "switch"; targetKind: "chat" | "run"; targetId: string };

export interface DirectorChatTuiOptions {
  client: DaemonClient;
  repoRoot: string;
  chatSessionId?: string;
  preferLastGlobal?: boolean;
  terminal?: Terminal;
}

export interface NativeScrollbackTuiOptions {
  client: DaemonClient;
  runId: string;
  initialTaskId?: string | null;
  terminal?: Terminal;
}

interface ChatOpenResult {
  session: ChatSessionRecord;
  history: ChatTurnRecord[];
  activeTurnId: string | null;
  activeText: string;
  activePartial: string;
  tookOver: boolean;
  busy: boolean;
}

interface AttachRunResult {
  attachmentId: string;
  attached: boolean;
  tookOver: boolean;
  run: RunRecord | null;
  events?: DaemonEventFrame[];
}

interface SharedShellContext {
  mode: TuiMode;
  client: DaemonClient;
  repoRoot: string;
  sessionId: string;
  chatSessionId?: string;
  runId?: string;
  terminal?: Terminal;
  getRightStatus: () => string;
  getIdleBanner: () => string;
  onUserSubmit: (text: string) => Promise<void>;
  onCancelActiveTurn: () => Promise<boolean>;
  onModelUpdated?: (sel: { profileId: string; model: string; effort: string | null }) => Promise<void>;
  getCurrentModel?: () => { profileId?: string; model?: string | null; effort?: string | null };
  onClear?: () => void;
}

/**
 * Unified interactive TUI shell shared by both Director Chat mode and Attached Run mode.
 *
 * Guarantees:
 *  - Strictly append-only immutable transcript above the live tail (never triggers pi-tui scrollback wipes).
 *  - Constant-height dock (attention strip + status bar + composer + 1-line hint strip).
 *  - Zero main-screen mouse tracking (native terminal scrollback & mouse-drag copy always work).
 *  - Every surfaced entity (escalations, goals, runs, tasks, timers, worktrees, tool calls) is directly
 *    reachable via `Ctrl+G`, `Ctrl+O`, `Ctrl+X`, or `Alt+1..5`.
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
  const queuedMessages: string[] = [];

  const session = new TerminalSession({
    terminal: spec.terminal,
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
  });

  const transcript = new ImmutableTranscript(theme);
  const navigator = new Navigator(session.tui, session.terminal, theme, {
    onChange: () => {
      if (!navigator.isOpen) {
        session.tui.setFocus(dock.editor);
      }
    },
  });

  const switchTo = (targetKind: "chat" | "run", targetId: string) => {
    exitAction = { kind: "switch", targetKind, targetId };
    session.stop();
  };

  const inspectorDeps: InspectorDeps = {
    client: spec.client,
    store,
    repoRoot: spec.repoRoot,
    onAttachRun: (runId) => switchTo("run", runId),
  };

  const openWork = (tab?: WorkTabId) => {
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
          void spec.onModelUpdated?.(sel);
        },
      }),
    );
  };

  const openQuota = () => {
    navigator.push(
      new QuotaCostScreen(spec.client, { chatSessionId: spec.chatSessionId, runId: spec.runId, repoRoot: spec.repoRoot }),
    );
  };

  const openKb = () => {
    navigator.push(new KbBrowserScreen(spec.client, spec.repoRoot));
  };

  const openSessions = () => {
    navigator.push(
      new SessionSwitcherScreen(spec.client, spec.sessionId, (picked) => {
        switchTo(picked.kind, picked.id);
      }),
    );
  };

  const openSettings = () => {
    navigator.push(new SettingsScreen(spec.client));
  };

  const stopAllAgents = async (reason?: string) => {
    try {
      await spec.onCancelActiveTurn();
      const res = await spec.client.request<{ stoppedRuns?: string[]; stoppedCount?: number }>("runs.stop_all", {
        reason: reason || "Stopped by user (/stop)",
      });
      const count = res.stoppedRuns?.length ?? res.stoppedCount ?? 0;
      transcript.appendReceipt({
        glyph: theme.glyphs.cross,
        tone: "warn",
        tag: "stop",
        text: count > 0 ? `Stopped ${count} active run(s) and all running agents.` : "Stopped active turn; no active runs were running.",
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
      { id: "work", label: "/work", detail: "Open Work Navigator", run: () => openWork() },
      { id: "inbox", label: "/inbox", detail: "Open Inbox (escalations & blockers)", run: () => openWork("inbox") },
      { id: "escalations", label: "/escalations", detail: "Open Escalations tab", run: () => openWork("escalations") },
      { id: "goals", label: "/goals", detail: "Open Goals tab", run: () => openWork("goals") },
      { id: "runs", label: "/runs", detail: "Open Runs tab", run: () => openWork("runs") },
      { id: "timers", label: "/timers", detail: "Open Timers tab", run: () => openWork("timers") },
      { id: "worktrees", label: "/worktrees", detail: "Open Worktrees & Merges tab", run: () => openWork("worktrees") },
      ...(spec.onModelUpdated ? [{ id: "model", label: "/model", detail: "Select Model & Effort", run: () => openModels() }] : []),
      { id: "quota", label: "/quota", detail: "View Quota & Spend", run: () => openQuota() },
      { id: "kb", label: "/kb", detail: "Browse Knowledge Base", run: () => openKb() },
      { id: "sessions", label: "/sessions", detail: "Switch Chat / Run Session", run: () => openSessions() },
      { id: "settings", label: "/settings", detail: "Edit Harness Settings", run: () => openSettings() },
      { id: "stop", label: "/stop", detail: "Stop ALL active runs & agents", run: () => void stopAllAgents() },
    ];
    navigator.push(new GoToPaletteScreen(inspectorDeps, recentRefs, actions));
  };

  const dockHints: Hint[] = [
    { key: "Ctrl+G", label: "Work" },
    { key: "Ctrl+O", label: "Go" },
    { key: "Ctrl+X", label: "Inspect" },
    { key: "Alt+1..5", label: "Slot" },
    { key: "/stop", label: "Stop all" },
    { key: "/help", label: "Help" },
  ];

  const handleSlash = async (raw: string): Promise<boolean> => {
    const parsed = parseSlashCommand(raw);
    if (!parsed) return false;
    switch (parsed.name) {
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
      case "effort":
        if (parsed.name === "effort" && parsed.args && spec.onModelUpdated) {
          const cur = spec.getCurrentModel?.() ?? {};
          if (cur.profileId && cur.model) {
            await spec.onModelUpdated({ profileId: cur.profileId, model: cur.model, effort: parsed.args });
            return true;
          }
        }
        openModels();
        return true;
      case "quota":
      case "cost":
        openQuota();
        return true;
      case "kb":
        openKb();
        return true;
      case "sessions":
        openSessions();
        return true;
      case "new":
        switchTo("chat", "__new__");
        return true;
      case "settings":
        openSettings();
        return true;
      case "status": {
        await store.refresh();
        const s = store.state;
        const activeGoals = s.goals.filter((g) => ["executing", "verifying", "reviewing", "awaiting_human"].includes(g.goal.status)).length;
        const openEsc = store.openEscalationsCount;
        const activeRuns = s.runs.filter((r) => r.run.status === "active" || r.run.status === "paused_quota").length;
        transcript.appendReceipt({
          glyph: theme.glyphs.bullet,
          tone: openEsc > 0 ? "warn" : "info",
          tag: "status",
          text: `${activeGoals} active goal(s) · ${activeRuns} active run(s) · ${openEsc} open escalation(s) · ${s.inbox.length} inbox item(s) — press Ctrl+G to open Work Navigator`,
        });
        session.tui.requestRender();
        return true;
      }
      case "steer": {
        const m = parsed.args.match(/^(\S+)\s+([\s\S]+)$/);
        if (!m) {
          transcript.appendReceipt({ tone: "warn", tag: "steer", text: "Usage: /steer <task-id> <message>" });
        } else {
          await spec.client.request("task.steer", { taskId: m[1], message: m[2] });
          transcript.appendReceipt({ tone: "ok", tag: "steer", text: `Steered ${m[1]}` });
        }
        session.tui.requestRender();
        return true;
      }
      case "resume": {
        if (!spec.runId) {
          openWork("runs");
          return true;
        }
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
          await spec.client.request("run.resume", { runId: spec.runId, message: parsed.args || undefined });
          transcript.appendReceipt({ tone: "ok", tag: "resume", text: `Resumed ${spec.runId}` });
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
        session.stop();
        return true;
      default:
        transcript.appendReceipt({ tone: "warn", tag: "cmd", text: `Unknown command /${parsed.name}. Try /help.` });
        session.tui.requestRender();
        return true;
    }
  };

  const dock = new FixedDock(session.tui, theme, {
    autocomplete: createCommandAutocomplete(spec.mode),
    initialState: {
      slots: [],
      idleBanner: spec.getIdleBanner(),
      busy: false,
      phaseText: "Ready",
      rightStatus: spec.getRightStatus(),
      queuedCount: 0,
      hints: dockHints,
    },
    onSubmit: (raw) => {
      const text = raw.trim();
      if (!text) return;
      if (text.startsWith("/")) {
        void handleSlash(text);
        return;
      }
      void spec.onUserSubmit(text);
    },
  });

  const syncDock = () => {
    dock.update({
      slots: store.buildAttentionSlots(5),
      idleBanner: spec.getIdleBanner(),
      busy,
      phaseText,
      rightStatus: spec.getRightStatus(),
      queuedCount: queuedMessages.length,
    });
    session.tui.requestRender();
  };

  session.tui.addChild(transcript);
  session.tui.addChild(dock);
  session.tui.setFocus(dock.editor);

  const unsubStore = store.subscribe(syncDock);

  // Spinner interval (only renders when busy)
  const spinTimer = setInterval(() => {
    if (dock.tickSpinner()) session.tui.requestRender();
  }, 120);
  spinTimer.unref?.();

  // Global keyboard shortcuts when no overlay is open
  session.start((data) => {
    if (navigator.isOpen) return undefined;

    if (matchesKey(data, "ctrl+g")) {
      openWork();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+o")) {
      openPalette();
      return { consume: true };
    }
    if (matchesKey(data, "ctrl+x")) {
      const latest = recentRefs.latest();
      if (latest) openEntity(latest);
      else openWork();
      return { consume: true };
    }
    // Alt+1..Alt+5 jump straight into numbered dock attention slot
    if (data.length === 2 && data[0] === "\x1b" && data[1]! >= "1" && data[1]! <= "5") {
      const slotIdx = Number(data[1]) - 1;
      const slot = dock.slots[slotIdx];
      if (slot) {
        openEntity(slot.ref);
        return { consume: true };
      }
    }
    // Forward undo / composer keys
    if (matchesKey(data, "ctrl+z") || matchesKey(data, "ctrl+-")) {
      dock.handleInput(data);
      session.tui.requestRender();
      return { consume: true };
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
      unsubStore();
      store.dispose();
      return exitAction;
    },
  };
}

/* ───────────────────────────── Director Chat TUI ──────────────────────────── */

export async function runDirectorChatTui(opts: DirectorChatTuiOptions): Promise<TuiExitAction> {
  const opened = await opts.client.request<ChatOpenResult>("chat.open", {
    repoRoot: opts.repoRoot,
    ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
    ...(opts.preferLastGlobal ? { preferLastGlobal: true } : {}),
  });

  let chatSession = opened.session;
  let activeTurnId: string | null = opened.activeTurnId;
  let sending = opened.busy;

  const modelBadge = () => {
    const m = chatSession.model ?? "auto";
    const e = chatSession.effort ? ` (${chatSession.effort})` : "";
    return `${chatSession.profileId ?? "director"} · ${m}${e}`;
  };

  let shell!: ReturnType<typeof createSharedShell>;

  const dispatchPrompt = async (text: string): Promise<void> => {
    if (sending) {
      shell.queuedMessages.push(text);
      shell.syncDock();
      return;
    }
    sending = true;
    const turnId = `turn-${randomUUID().slice(0, 8)}`;
    activeTurnId = turnId;
    shell.transcript.appendUserTurn(text);
    shell.transcript.liveTail.begin();
    shell.setStatus(true, "Director thinking...");

    try {
      await opts.client.request("chat.send", {
        chatSessionId: chatSession.id,
        message: text,
        turnId,
      });
    } catch (err) {
      shell.transcript.liveTail.clear();
      shell.transcript.appendReceipt({
        glyph: shell.theme.glyphs.cross,
        tone: "danger",
        tag: "error",
        text: err instanceof Error ? err.message : String(err),
      });
      sending = false;
      activeTurnId = null;
      shell.setStatus(false, "Ready");
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
    repoRoot: chatSession.repoRoot || opts.repoRoot,
    sessionId: chatSession.id,
    chatSessionId: chatSession.id,
    terminal: opts.terminal,
    getRightStatus: modelBadge,
    getIdleBanner: () => `${chatSession.id} · ${sanitizeLine(chatSession.title || "Director Chat")} (Ctrl+G Work · Ctrl+O Go)`,
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
        text: `Switched to ${sel.profileId} / ${sel.model}${sel.effort ? ` (${sel.effort})` : ""}`,
      });
      shell.syncDock();
    },
  });

  // Hydrate existing chat history cleanly as immutable blocks
  for (const turn of opened.history ?? []) {
    if (turn.role === "user") {
      shell.transcript.appendUserTurn(turn.content);
    } else if (turn.role === "assistant") {
      shell.transcript.appendAssistantTurn(turn.content);
    } else if (turn.role === "system_notice") {
      const parsed = turn.event ? parseChatControlEvent(turn.event) : null;
      const summary = parsed ? formatChatEventSummary(parsed) : turn.content;
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

  if (opened.busy && (opened.activeText || opened.activePartial)) {
    shell.transcript.liveTail.begin();
    shell.transcript.liveTail.appendText(opened.activeText || opened.activePartial);
    shell.setStatus(true, "Director responding...");
  }

  // Subscribe to live daemon frames
  const detachEvents = opts.client.onEvent((ev: DaemonEventFrame) => {
    if (ev.watchId) return;
    const p = (ev.payload ?? {}) as Record<string, unknown>;

    if (ev.type === "session.taken_over") {
      shell.transcript.appendReceipt({
        tone: "warn",
        tag: "session",
        text: "Another client took over this session — detaching.",
      });
      shell.session.stop();
      return;
    }

    if (ev.type === "chat.turn.start") {
      sending = true;
      activeTurnId = typeof p.turnId === "string" ? p.turnId : activeTurnId;
      shell.transcript.liveTail.begin();
      shell.setStatus(true, "Director responding...");
      return;
    }

    if (ev.type === "chat.delta") {
      const delta = String(p.delta ?? "");
      if (delta) {
        shell.transcript.liveTail.appendText(delta);
        shell.session.tui.requestRender();
      }
      return;
    }

    if (ev.type === "chat.tool") {
      const id = String(p.id ?? p.toolCallId ?? randomUUID().slice(0, 8));
      const label = formatToolLabel(String(p.name ?? p.title ?? "tool"));
      const rawStatus = String(p.status ?? "running");
      const status = rawStatus === "completed" || rawStatus === "ok" ? "ok" : rawStatus === "error" || rawStatus === "failed" ? "error" : "running";
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
      const snap = shell.transcript.liveTail.snapshot();
      const assistantTurn = p.assistantTurn as ChatTurnRecord | undefined;
      const finalText = assistantTurn?.content ?? snap.text;
      shell.transcript.liveTail.clear();

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
      if (finalText.trim()) {
        shell.transcript.appendAssistantTurn(finalText);
      }
      if (typeof p.error === "string" && p.error) {
        shell.transcript.appendReceipt({ glyph: shell.theme.glyphs.cross, tone: "danger", tag: "error", text: p.error });
      }
      sending = false;
      activeTurnId = null;
      shell.setStatus(false, "Ready");
      void shell.store.refresh();
      drainQueue();
      return;
    }

    // Surface high-signal live escalations right into the transcript with a direct Inspector ref!
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
  });

  const detachClose = opts.client.onClose(() => {
    shell.session.stop();
  });

  await shell.store.refresh();
  const action = await shell.waitAndCleanup();
  detachEvents();
  detachClose();
  return action;
}

/* ──────────────────────────── Attached Run TUI ────────────────────────────── */

export async function runNativeScrollbackTui(opts: NativeScrollbackTuiOptions): Promise<TuiExitAction> {
  const attached = await opts.client.request<AttachRunResult>("attach", {
    runId: opts.runId,
    ...(opts.initialTaskId ? { taskId: opts.initialTaskId } : {}),
  });

  const repoRoot = attached.run?.repoRoot ?? process.cwd();
  let shell!: ReturnType<typeof createSharedShell>;

  shell = createSharedShell({
    mode: "run",
    client: opts.client,
    repoRoot,
    sessionId: opts.runId,
    runId: opts.runId,
    terminal: opts.terminal,
    getRightStatus: () => `run ${opts.runId}${opts.initialTaskId ? ` / ${opts.initialTaskId}` : ""}`,
    getIdleBanner: () => `${opts.runId} (${attached.run?.status ?? "active"}) · Ctrl+G Work · /resume · /stop`,
    onUserSubmit: async (text) => {
      shell.transcript.appendUserTurn(text);
      if (opts.initialTaskId) {
        await opts.client.request("task.steer", { taskId: opts.initialTaskId, message: text });
        shell.transcript.appendReceipt({ tone: "ok", tag: "steered", text: `Sent to ${opts.initialTaskId}` });
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

  const renderEventToTranscript = (ev: DaemonEventFrame) => {
    if (ev.runId !== opts.runId) return;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (ev.type === "agent.text_delta") {
      const txt = String(p.text ?? p.delta ?? "");
      if (txt) {
        shell.transcript.liveTail.appendText(txt);
        shell.session.tui.requestRender();
      }
      return;
    }
    if (ev.type === "agent.turn_end" || ev.type === "task.status") {
      const snap = shell.transcript.liveTail.snapshot();
      if (snap.text.trim()) {
        shell.transcript.liveTail.clear();
        shell.transcript.appendAssistantTurn(snap.text);
      }
    }
    if (ev.type === "escalation.created") {
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
    } else if (ev.type === "task.status" || ev.type === "run.status") {
      const id = ev.taskId ?? ev.runId;
      const status = String(p.to ?? p.status ?? "");
      const ref: EntityRef = ev.taskId
        ? { kind: "task", id: ev.taskId, runId: ev.runId, label: ev.taskId }
        : { kind: "run", id: ev.runId, label: ev.runId };
      shell.recordRef(ref);
      shell.transcript.appendReceipt({
        tone: status === "failed" || status === "blocked" ? "danger" : status === "completed" ? "ok" : "info",
        tag: id,
        text: `${ev.type}: ${status}${p.summary ? ` — ${sanitizeLine(String(p.summary))}` : ""}`,
        ref,
      });
    }
    shell.session.tui.requestRender();
  };

  for (const ev of attached.events ?? []) renderEventToTranscript(ev);

  const detachEvents = opts.client.onEvent((ev) => {
    if (ev.type === "session.taken_over") {
      shell.session.stop();
      return;
    }
    renderEventToTranscript(ev);
  });

  const detachClose = opts.client.onClose(() => shell.session.stop());

  await shell.store.refresh();
  const action = await shell.waitAndCleanup();
  detachEvents();
  detachClose();
  return action;
}
