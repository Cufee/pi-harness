import { Container, Markdown, Spacer, type SlashCommand } from "@earendil-works/pi-tui";
import type { CompiledModelCatalog } from "../catalog/compiler.js";
import type { HarnessConfig } from "../config.js";
import type { EscalationRecord, RunRecord, TaskRecord } from "../control-plane/db.js";
import type { RunQuotaPauseStatus } from "../control-plane/orchestrator.js";
import type { DaemonClient } from "../daemon/remote.js";
import type { ChatSessionRecord, ChatTurnRecord } from "../director/session.js";
import type { GoalRecord, GoalReviewVerdict } from "../goals/engine.js";
import type { KbCard } from "../kb/store.js";
import type { DaemonEventFrame } from "../protocol/daemon-rpc.js";
import type { LiveWorktreeInfo } from "../worktree/manager.js";
import {
  CliPickerOverlay,
  CommandPaletteOverlay,
  EffortPickerOverlay,
  formatGoalDetailCard,
  formatGoalReviewCard,
  formatResetCountdown,
  GoalsOverlay,
  KbOverlay,
  ModelPickerOverlay,
  parseDurationMs,
  QuotaOverlay,
  QuotaWaitPickerOverlay,
  RunsOverlay,
  SessionsOverlay,
  TreeOverlay,
  WorktreesOverlay,
  type AttachableSession,
  type PaletteCommand,
} from "./overlays.js";
import {
  AssistantCard,
  BannerCard,
  Composer,
  createTheme,
  ErrorCard,
  FooterHint,
  formatAgentError,
  OverlayManager,
  StatusBar,
  SystemCard,
  TerminalSession,
  TimedSpinner,
  ToolPill,
  UserCard,
} from "./primitives/index.js";
import { SettingsOverlay } from "./settings-overlay.js";

export type TuiExitAction =
  | { kind: "exit" }
  | { kind: "switch"; targetId: string; targetKind: "chat" | "run" };

const DIRECTOR_SLASH_COMMANDS: SlashCommand[] = [
  { name: "attach", description: "Switch to & take over another session (detaches other terminal)", argumentHint: "[session-id]" },
  { name: "sessions", description: "Alias for /attach — list & switch active sessions" },
  { name: "new", description: "Start a new concurrent Director Chat session", argumentHint: "[title]" },
  { name: "model", description: "Searchable ranked model & ACP route picker (Tab switches CLI)" },
  { name: "models", description: "Alias for /model" },
  { name: "cli", description: "Switch active ACP CLI (codex / claude / amp / antigravity)", argumentHint: "[profile]" },
  { name: "acp", description: "Alias for /cli — switch active ACP CLI" },
  { name: "effort", description: "Pick reasoning effort (low / medium / high / xhigh / max / ultra)", argumentHint: "[level]" },
  { name: "quota", description: "Visual subscription & API quota buckets with reset countdowns" },
  { name: "goals", description: "Interactive Goal Dashboard (inspect, review, pause, cancel)" },
  { name: "runs", description: "Interactive autonomous runs dashboard (inspect, resume, schedule wait, stop)" },
  { name: "resume", description: "Resume a quota-paused run now or pick a wait timer", argumentHint: "[run-id] [now|15m]" },
  { name: "review", description: "Run deterministic gates + Independent Skeptical Done-Review", argumentHint: "<goal-id>" },
  { name: "worktrees", description: "List & clean stale/orphaned git worktrees" },
  { name: "kb", description: "Browse 2-stage Knowledge Base (cards → full context)", argumentHint: "[query]" },
  { name: "settings", description: "Configure defaults, Quota Endpoint & External ACP CLIs (Ctrl+,)" },
  { name: "profiles", description: "Alias for /settings" },
  { name: "status", description: "Show daemon, active model/effort, CLIs, and goals summary" },
  { name: "clear", description: "Clear local transcript" },
  { name: "help", description: "List commands & keyboard shortcuts" },
  { name: "detach", description: "Detach (or quit fully if nothing is running) (Ctrl+])" },
];

const RUN_SLASH_COMMANDS: SlashCommand[] = [
  { name: "attach", description: "Switch to & take over another chat or run session", argumentHint: "[session-id]" },
  { name: "sessions", description: "Alias for /attach" },
  { name: "tree", description: "Open Agent Tree Switcher (Ctrl+T)" },
  { name: "resume", description: "Resume quota-paused run now or pick a wait duration", argumentHint: "[now|15m]" },
  { name: "stop", description: "Stop this autonomous run" },
  { name: "detach", description: "Detach (or quit fully if nothing is running) (Ctrl+])" },
  { name: "help", description: "Show attached-run commands" },
];

async function resolveLeaveNote(client: DaemonClient): Promise<string> {
  try {
    const res = await client.request<{ daemonWillQuit: boolean; running: boolean; activeWorkSummary?: string }>(
      "session.leave",
    );
    if (res.daemonWillQuit) {
      return "[Exited — no background agents running; harnessd stopped.]";
    }
    const detail = res.activeWorkSummary ? ` (${res.activeWorkSummary})` : "";
    return `[Detached — background work${detail} continues in harnessd. Reattach with: pi-harness attach]`;
  } catch {
    return "[Exited.]";
  }
}

/**
 * Primary zero-arg interactive TUI: Persistent Tier 0 Director Chat on native terminal scrollback
 * (`@earendil-works/pi-tui` `TuiMainScreen`) built on `src/tui/primitives/`:
 *   - Bulletproof `Ctrl+C` / `Ctrl+D` / `Esc` / `Ctrl+]` / `Ctrl+,` / `Ctrl+O` controls
 *   - Zero `7u1;2c` shell escape leaks on exit (`drainInput` before `tui.stop()`)
 *   - Immutable width-memoized scrollback cards + memoized 1-line `StatusBar`
 *   - Live `ToolPill` + streaming `Markdown` during turns + follow-up turn queueing
 *   - Clean `ErrorCard` with full raw stderr persisted to `~/.pi-harness/logs/errors/`
 */
export async function runDirectorChatTui(opts: {
  client: DaemonClient;
  repoRoot: string;
  chatSessionId?: string;
  preferLastGlobal?: boolean;
}): Promise<TuiExitAction> {
  type ChatOpenPayload = {
    session: ChatSessionRecord;
    history: ChatTurnRecord[];
    goals: GoalRecord[];
    config: HarnessConfig;
    tookOver?: boolean;
    busy?: boolean;
  };

  // Handshake BEFORE touching terminal raw mode so a failed RPC never leaves escape sequences in zsh!
  const opened = await opts.client.request<ChatOpenPayload>("chat.open", {
    repoRoot: opts.repoRoot,
    ...(opts.chatSessionId ? { chatSessionId: opts.chatSessionId } : {}),
    ...(opts.preferLastGlobal ? { preferLastGlobal: true } : {}),
  });

  let session: ChatSessionRecord = opened.session;
  let activeRepoRoot: string = opened.session.repoRoot;
  let config: HarnessConfig = opened.config;
  let goals: GoalRecord[] = opened.goals;
  let cachedCatalog: CompiledModelCatalog | null = null;
  let streamingText = "";
  let busy = Boolean(opened.busy);
  let activeRequestId = 0;
  let exitAction: TuiExitAction = { kind: "exit" };
  let evictedByTakeover = false;
  const queuedMessages: string[] = [];
  const activeToolPills = new Map<string, ToolPill>();

  const theme = createTheme();
  const term = new TerminalSession();
  const tui = term.tui;

  const chatContainer = new Container();
  const pendingToolsContainer = new Container();
  const pendingMarkdownContainer = new Container();
  const pendingMarkdown = new Markdown("", 1, 0, theme.toMarkdownTheme());
  const spinner = new TimedSpinner(tui, theme);
  const statusBar = new StatusBar(theme, {
    tone: "success",
    modeLabel: "director",
    modelLabel: session.model ?? session.profileId,
    effortLabel: session.effort,
    goalsSummary: `${goals.length} goals`,
  });
  const composer = new Composer(tui, theme, {
    placeholder: "Ask Director to design or launch a Goal…  (/help · Ctrl+O commands · Ctrl+C exit)",
    slashCommands: DIRECTOR_SLASH_COMMANDS,
    cwd: opts.repoRoot,
  });
  const footerHint = new FooterHint(theme);
  const overlays = new OverlayManager(tui, theme, composer);

  const seedTranscript = (payload: ChatOpenPayload, notice?: string) => {
    chatContainer.clear();
    const dirLabel = payload.session.repoRoot.split("/").filter(Boolean).pop() ?? payload.session.repoRoot;
    chatContainer.addChild(
      new BannerCard(theme, "pi-harness", `${payload.session.title} · ${payload.session.id} (${dirLabel})`),
    );
    for (const t of payload.history) {
      if (t.role === "user") {
        chatContainer.addChild(new UserCard(theme, t.content));
      } else if (t.role === "assistant") {
        chatContainer.addChild(new AssistantCard(theme, t.content, payload.session.model ?? payload.session.profileId));
      } else {
        chatContainer.addChild(new SystemCard(theme, [t.content], "muted"));
      }
    }
    if (payload.tookOver) {
      chatContainer.addChild(
        new SystemCard(theme, [`Took over ${payload.session.id} (previous terminal was detached).`], "info"),
      );
    }
    if (notice) {
      chatContainer.addChild(new SystemCard(theme, [notice], "success"));
    }
  };

  seedTranscript(opened);

  tui.addChild(chatContainer);
  tui.addChild(pendingToolsContainer);
  tui.addChild(pendingMarkdownContainer);
  tui.addChild(new Spacer(1));
  tui.addChild(spinner);
  tui.addChild(statusBar);
  tui.addChild(composer);
  tui.addChild(footerHint);
  tui.setFocus(composer);

  const refreshQueueHint = () => {
    if (queuedMessages.length > 0) {
      const next = queuedMessages[0]!;
      const preview = next.length > 54 ? `${next.slice(0, 54)}…` : next;
      footerHint.set(`↳ Queued (${queuedMessages.length}): ${preview}  (Esc to cancel)`, "info");
    } else {
      footerHint.clear();
    }
  };

  const activeModelDisplay = () => {
    const shortCli = session.profileId.replace(/^acp:/, "");
    if (!session.model) return session.profileId;
    const bareModel = session.model.includes("/") ? session.model.slice(session.model.indexOf("/") + 1) : session.model;
    return `${shortCli}:${bareModel}`;
  };

  const refreshStatus = () => {
    const activeGoals = goals.filter((g) => ["executing", "verifying", "reviewing"].includes(g.status));
    const humanNeeded = goals.filter((g) => g.status === "awaiting_human").length;
    const goalSummary =
      activeGoals.length > 0
        ? activeGoals
            .map((g) => `${g.id}[${g.status}]`)
            .slice(0, 2)
            .join(" ")
        : `${goals.length} goal${goals.length === 1 ? "" : "s"}`;

    statusBar.update({
      tone: humanNeeded > 0 ? "error" : busy ? "accent" : "success",
      modeLabel: busy ? "thinking" : "director",
      modelLabel: activeModelDisplay(),
      effortLabel: session.effort,
      goalsSummary: goalSummary,
      alertText: humanNeeded > 0 ? `${humanNeeded} P0!` : null,
    });
  };

  const appendSystem = (lines: string[], tone: "muted" | "success" | "warning" | "info" = "muted") => {
    chatContainer.addChild(new SystemCard(theme, lines, tone));
    tui.requestRender();
  };

  const appendError = (err: unknown, context: string) => {
    const formatted = formatAgentError(err, { stateDir: config.stateDir, context });
    chatContainer.addChild(new ErrorCard(theme, formatted));
    tui.requestRender();
  };

  const clearPending = () => {
    streamingText = "";
    activeToolPills.clear();
    pendingToolsContainer.clear();
    pendingMarkdownContainer.clear();
  };

  const refreshGoals = async () => {
    try {
      goals = await opts.client.request<GoalRecord[]>("goal.list", { repoRoot: activeRepoRoot });
      refreshStatus();
      tui.requestRender();
    } catch {
      // ignore transient refresh errors
    }
  };

  const switchToChatSessionInPlace = (targetSessionId: string) => {
    void opts.client
      .request<ChatOpenPayload>("chat.open", { repoRoot: activeRepoRoot, chatSessionId: targetSessionId })
      .then((next) => {
        activeRequestId++;
        session = next.session;
        activeRepoRoot = next.session.repoRoot;
        goals = next.goals;
        config = next.config;
        busy = Boolean(next.busy);
        queuedMessages.length = 0;
        clearPending();
        if (busy) spinner.start(`Thinking (${session.model ?? session.profileId})…`);
        else spinner.stop();
        seedTranscript(next, next.tookOver ? undefined : `Attached to ${next.session.id}.`);
        refreshStatus();
        refreshQueueHint();
        tui.requestRender(true);
      })
      .catch((err) => appendError(err, `attach:${targetSessionId}`));
  };

  const createNewChatSession = (title?: string) => {
    void opts.client
      .request<ChatOpenPayload>("chat.create", { repoRoot: activeRepoRoot, title })
      .then((next) => {
        activeRequestId++;
        session = next.session;
        activeRepoRoot = next.session.repoRoot;
        goals = next.goals;
        config = next.config;
        busy = false;
        queuedMessages.length = 0;
        spinner.stop();
        clearPending();
        seedTranscript(next, `Started new session ${next.session.id}.`);
        refreshStatus();
        refreshQueueHint();
        tui.requestRender(true);
      })
      .catch((err) => appendError(err, "chat.create"));
  };

  const switchToTarget = (targetId: string) => {
    if (targetId === session.id) {
      appendSystem([`Already attached to ${targetId}.`], "muted");
      return;
    }
    if (targetId.startsWith("run-")) {
      exitAction = { kind: "switch", targetId, targetKind: "run" };
      void term.shutdown(undefined, { overlays, spinner, cleanup: detachListenersOnly });
      return;
    }
    switchToChatSessionInPlace(targetId);
  };

  const openSessionsPicker = () => {
    void opts.client
      .request<AttachableSession[]>("sessions.list")
      .then((sessions) => {
        let handle: ReturnType<OverlayManager["push"]> | null = null;
        const comp = new SessionsOverlay(
          theme,
          sessions,
          (chosen) => switchToTarget(chosen.id),
          () => createNewChatSession(),
          () => handle?.close(),
          () => handle?.rerender(),
        );
        handle = overlays.push(
          {
            title: "Sessions & Attach Switcher",
            subtitle: `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
            footer: "Enter attach & take over · n new chat · Esc close",
          },
          comp,
          { width: "92%" },
        );
      })
      .catch((err) => appendError(err, "sessions.list"));
  };

  const openEffortPicker = (efforts?: string[]) => {
    const activeModel = cachedCatalog?.models.find(
      (m) => m.id === session.model || m.preferredRoute.wireModelId === session.model,
    );
    const available = efforts ?? activeModel?.efforts ?? ["low", "medium", "high", "xhigh", "max"];
    let handle: ReturnType<OverlayManager["push"]> | null = null;
    const comp = new EffortPickerOverlay(
      theme,
      available,
      session.effort,
      (effort) => {
        void opts.client
          .request<ChatSessionRecord>("chat.update", { chatSessionId: session.id, effort })
          .then((updated) => {
            session = updated;
            appendSystem([`Active reasoning effort set to ${theme.bold(effort)}`], "success");
            refreshStatus();
            tui.requestRender();
          })
          .catch((err) => appendError(err, "effort.update"));
      },
      () => handle?.close(),
      () => handle?.rerender(),
    );
    handle = overlays.push(
      {
        title: "Reasoning Effort",
        subtitle: session.model ?? session.profileId,
        footer: "↑/↓ move · Enter apply · Esc cancel",
      },
      comp,
      { width: "68%" },
    );
  };

  const switchCliProfile = (targetIdOrShort: string) => {
    const enabled = config.profiles.filter((p) => p.enabled !== false);
    const q = targetIdOrShort.toLowerCase();
    const match =
      enabled.find((p) => p.id.toLowerCase() === q) ??
      enabled.find((p) => p.id.toLowerCase() === `acp:${q}`) ??
      enabled.find((p) => p.id.toLowerCase().includes(q));
    if (!match) {
      appendSystem([`No enabled CLI matching "${targetIdOrShort}". Enabled: ${enabled.map((p) => p.id).join(", ")}`], "warning");
      return;
    }
    void opts.client
      .request<ChatSessionRecord>("chat.update", { chatSessionId: session.id, profileId: match.id, model: null })
      .then((updated) => {
        session = updated;
        appendSystem([`Switched active ACP CLI to ${theme.bold(match.id)} (using CLI default model; run /model to pin a specific model)`], "success");
        refreshStatus();
        tui.requestRender();
      })
      .catch((err) => appendError(err, "cli.switch"));
  };

  const openCliPicker = () => {
    let handle: ReturnType<OverlayManager["push"]> | null = null;
    const comp = new CliPickerOverlay(
      theme,
      config.profiles,
      session.profileId,
      cachedCatalog?.profileStatuses,
      (chosen) => switchCliProfile(chosen.id),
      () => handle?.close(),
      () => handle?.rerender(),
    );
    handle = overlays.push(
      {
        title: "Switch ACP CLI",
        subtitle: `active: ${session.profileId}`,
        footer: "↑/↓ move · Enter switch CLI · Esc close",
      },
      comp,
      { width: "80%" },
    );
  };

  const openModelPicker = () => {
    spinner.start("Loading model catalog…", "Esc to cancel");
    void opts.client
      .request<CompiledModelCatalog>("models.list", { cwd: activeRepoRoot })
      .then((cat) => {
        spinner.stop();
        cachedCatalog = cat;
        let handle: ReturnType<OverlayManager["push"]> | null = null;
        const comp = new ModelPickerOverlay(
          theme,
          opts.client,
          activeRepoRoot,
          cat,
          session.model ?? null,
          session.profileId,
          (entry, route) => {
            void opts.client
              .request<ChatSessionRecord>("chat.update", {
                chatSessionId: session.id,
                profileId: route.profileId,
                model: route.wireModelId,
              })
              .then((updated) => {
                session = updated;
                appendSystem(
                  [
                    `Selected ${theme.bold(entry.id)} via ${theme.accent(route.profileId)} (score: ${entry.codingScore?.toFixed(1) ?? "-"})`,
                  ],
                  "success",
                );
                refreshStatus();
                const routeEfforts = route.supportedEfforts ?? entry.efforts;
                if (routeEfforts.length > 1) {
                  openEffortPicker(routeEfforts);
                } else {
                  tui.requestRender();
                }
              })
              .catch((err) => appendError(err, "model.select"));
          },
          () => handle?.close(),
          () => handle?.rerender(),
        );
        handle = overlays.push(
          {
            title: "Model Catalog & ACP Route Picker",
            subtitle: `${cat.models.length} models · synced ${cat.syncedAt.slice(0, 16).replace("T", " ")}`,
            footer: "Type to filter · Tab switch CLI route · Enter select · Ctrl+R sync · Esc close",
          },
          comp,
          { width: "92%" },
        );
      })
      .catch((err) => {
        spinner.stop();
        appendError(err, "models.list");
      });
  };

  const openSettings = () => {
    let handle: ReturnType<OverlayManager["push"]> | null = null;
    const comp = new SettingsOverlay(
      theme,
      opts.client,
      config,
      (nextCfg) => {
        config = nextCfg;
        refreshStatus();
        tui.requestRender();
      },
      () => handle?.close(),
      () => handle?.rerender(),
    );
    handle = overlays.push(
      {
        title: "Settings & External Harness CLIs",
        subtitle: "~/.pi-harness/config.json",
        footer: "↑/↓ move · Enter edit/toggle · Esc back/close",
      },
      comp,
      { width: "90%" },
    );
  };

  const openQuota = () => {
    void opts.client
      .request<{ configured: boolean; snapshot: Record<string, unknown> | null }>("quota.get")
      .then((data) => {
        let handle: ReturnType<OverlayManager["push"]> | null = null;
        const comp = new QuotaOverlay(
          theme,
          opts.client,
          data,
          () => handle?.close(),
          () => handle?.rerender(),
        );
        handle = overlays.push(
          {
            title: "Live Subscription & API Quotas",
            subtitle: data.configured ? "endpoint active" : "passive ACP mode",
            footer: "r refresh now · Esc close",
          },
          comp,
          { width: "88%" },
        );
      })
      .catch((err) => appendError(err, "quota.get"));
  };

  const resumeRunNow = (runId: string) => {
    void opts.client
      .request<{ resumed: boolean; resumedTaskIds: string[] }>("run.resume", { runId })
      .then((res) => {
        if (res.resumed) {
          appendSystem([`Resumed ${theme.bold(runId)} (${res.resumedTaskIds.length} task(s) restarted; quota state reset).`], "success");
        } else {
          appendSystem([`Run ${runId} had no quota-paused tasks.`], "muted");
        }
      })
      .catch((err) => appendError(err, `run.resume:${runId}`));
  };

  const scheduleRunWait = (runId: string, delayMs: number) => {
    void opts.client
      .request<RunQuotaPauseStatus>("run.schedule_resume", { runId, delayMs })
      .then((st) => {
        appendSystem(
          [
            `Scheduled ${theme.bold(runId)} to auto-resume ${formatResetCountdown(st.resumeAt)} (${st.resumeAt ?? ""}).`,
            theme.dim(`Run /resume ${runId} now anytime to override and resume immediately.`),
          ],
          "info",
        );
      })
      .catch((err) => appendError(err, `run.schedule_resume:${runId}`));
  };

  const openQuotaWaitPicker = (runId: string, reason = "Paused due to quota limit", currentResumeAt: string | null = null) => {
    let handle: ReturnType<OverlayManager["push"]> | null = null;
    const comp = new QuotaWaitPickerOverlay(
      theme,
      runId,
      reason,
      currentResumeAt,
      (choice) => {
        if (choice.kind === "now") resumeRunNow(runId);
        else scheduleRunWait(runId, choice.delayMs);
      },
      () => handle?.close(),
      () => handle?.rerender(),
    );
    handle = overlays.push(
      {
        title: "Quota Pause — Resume or Schedule Wait",
        subtitle: runId,
        footer: "↑/↓ move · Enter apply · Esc keep paused",
      },
      comp,
      { width: "80%" },
    );
  };

  const handleResumeSlashCommand = (argStr: string) => {
    const tokens = argStr.trim().split(/\s+/).filter(Boolean);
    let targetRunId = tokens[0]?.startsWith("run-") ? tokens.shift()! : "";
    const rest = tokens.join(" ");

    const proceed = (runId: string, reason?: string, resumeAt?: string | null) => {
      if (!rest) {
        openQuotaWaitPicker(runId, reason ?? "Paused due to quota limit", resumeAt ?? null);
        return;
      }
      if (rest.toLowerCase() === "now") {
        resumeRunNow(runId);
        return;
      }
      const ms = parseDurationMs(rest);
      if (ms) {
        scheduleRunWait(runId, ms);
      } else {
        void opts.client
          .request<{ resumed: boolean; resumedTaskIds: string[] }>("run.resume", { runId, message: rest })
          .then((res) => {
            appendSystem(
              res.resumed
                ? [`Resumed ${theme.bold(runId)} with instruction (${res.resumedTaskIds.length} task(s)).`]
                : [`Run ${runId} had no quota-paused tasks.`],
              res.resumed ? "success" : "muted",
            );
          })
          .catch((err) => appendError(err, `run.resume:${runId}`));
      }
    };

    if (targetRunId) {
      void opts.client
        .request<{ quotaPause?: RunQuotaPauseStatus | null }>("run.get", { runId: targetRunId })
        .then((d) => proceed(targetRunId, d.quotaPause?.reason, d.quotaPause?.resumeAt))
        .catch(() => proceed(targetRunId));
      return;
    }

    void opts.client
      .request<RunRecord[]>("run.list", { limit: 20 })
      .then((runs) => {
        const paused = runs.find((r) => r.status === "paused_quota");
        if (!paused) {
          appendSystem(["No quota-paused runs found. Open /runs to inspect all runs."], "muted");
          return;
        }
        void opts.client
          .request<{ quotaPause?: RunQuotaPauseStatus | null }>("run.get", { runId: paused.id })
          .then((d) => proceed(paused.id, d.quotaPause?.reason, d.quotaPause?.resumeAt))
          .catch(() => proceed(paused.id));
      })
      .catch((err) => appendError(err, "run.list"));
  };

  const openRuns = () => {
    void opts.client
      .request<RunRecord[]>("run.list", { limit: 20 })
      .then((runs) => {
        let handle: ReturnType<OverlayManager["push"]> | null = null;
        const comp = new RunsOverlay(
          theme,
          runs,
          (action, run) => {
            if (action === "stop") {
              void opts.client
                .request("run.stop", { runId: run.id })
                .then(() => appendSystem([`Stopped run ${theme.bold(run.id)}.`], "warning"))
                .catch((err) => appendError(err, "run.stop"));
            } else if (action === "resume") {
              resumeRunNow(run.id);
            } else if (action === "wait") {
              void opts.client
                .request<{ quotaPause?: RunQuotaPauseStatus | null }>("run.get", { runId: run.id })
                .then((d) => openQuotaWaitPicker(run.id, d.quotaPause?.reason ?? "Paused due to quota", d.quotaPause?.resumeAt ?? null))
                .catch(() => openQuotaWaitPicker(run.id));
            } else {
              void opts.client
                .request<{ run: RunRecord; tasks: TaskRecord[]; escalations: EscalationRecord[]; quotaPause?: RunQuotaPauseStatus | null }>(
                  "tree.get",
                  { runId: run.id },
                )
                .then((detail) => {
                  const lines = [
                    `${theme.bold(`Run ${detail.run.id}`)} [${detail.run.status.toUpperCase()}] — ${detail.run.goal.split("\n")[0]}`,
                    theme.dim(`Repo: ${detail.run.repoRoot} │ Attach: pi-harness attach ${detail.run.id}`),
                    ...(detail.quotaPause
                      ? [
                          theme.warning(
                            `Quota pause (${detail.quotaPause.mode}): ${detail.quotaPause.reason}${
                              detail.quotaPause.resumeAt ? ` · resumes ${formatResetCountdown(detail.quotaPause.resumeAt)}` : " · run /resume to restart or set wait"
                            }`,
                          ),
                        ]
                      : []),
                    ...detail.tasks.map(
                      (t) =>
                        `${"  ".repeat(t.tier - 1)}• [T${t.tier}:${t.status}] ${theme.accent(t.id)} ${t.title} (${t.model ?? t.profileId})`,
                    ),
                  ];
                  if (detail.escalations.length > 0) {
                    lines.push(theme.warning(`Open escalations: ${detail.escalations.length}`));
                  }
                  appendSystem(lines, "info");
                })
                .catch((err) => appendError(err, "tree.get"));
            }
          },
          () => handle?.close(),
          () => handle?.rerender(),
        );
        handle = overlays.push(
          {
            title: "Autonomous Runs",
            subtitle: `${runs.length} recent`,
            footer: "Enter inspect · r resume now · w schedule wait · x stop · Esc close",
          },
          comp,
          { width: "90%" },
        );
      })
      .catch((err) => appendError(err, "run.list"));
  };

  const openWorktrees = () => {
    void opts.client
      .request<LiveWorktreeInfo[]>("worktrees.list", { repoRoot: opts.repoRoot })
      .then((list) => {
        let handle: ReturnType<OverlayManager["push"]> | null = null;
        const comp = new WorktreesOverlay(
          theme,
          opts.client,
          opts.repoRoot,
          list,
          () => handle?.close(),
          () => handle?.rerender(),
        );
        handle = overlays.push(
          {
            title: "Git Worktrees Manager",
            subtitle: `${list.length} active`,
            footer: "c clean stale/orphaned · r refresh · Esc close",
          },
          comp,
          { width: "88%" },
        );
      })
      .catch((err) => appendError(err, "worktrees.list"));
  };

  const openKb = (query: string) => {
    void opts.client
      .request<KbCard[]>("kb.search", { repoRoot: opts.repoRoot, query: query || undefined, includeCandidates: true })
      .then((cards) => {
        let handle: ReturnType<OverlayManager["push"]> | null = null;
        const comp = new KbOverlay(
          theme,
          opts.client,
          cards,
          () => handle?.close(),
          () => handle?.rerender(),
        );
        handle = overlays.push(
          {
            title: "Knowledge Base",
            subtitle: query ? `query: "${query}"` : `${cards.length} cards`,
            footer: "Enter open full context (Stage 2) · Esc close",
          },
          comp,
          { width: "90%" },
        );
      })
      .catch((err) => appendError(err, "kb.search"));
  };

  const triggerGoalReview = (goalId: string) => {
    spinner.start(`Reviewing ${goalId} (deterministic gates + Skeptical Done-Review)…`);
    void opts.client
      .request<{ goal: GoalRecord; review: GoalReviewVerdict; circuitBreakerTripped?: string }>("goal.review", { goalId })
      .then(
        (res) => {
          spinner.stop();
          const tone =
            res.review.verdict === "approved"
              ? "success"
              : res.review.verdict === "escalate_human"
                ? "warning"
                : "info";
          appendSystem(formatGoalReviewCard(res, theme), tone);
          void refreshGoals();
        },
        (err) => {
          spinner.stop();
          appendError(err, `goal.review:${goalId}`);
        },
      );
  };

  const openGoals = () => {
    let handle: ReturnType<OverlayManager["push"]> | null = null;
    const comp = new GoalsOverlay(
      theme,
      () => goals,
      (action, g) => {
        if (action === "review") {
          triggerGoalReview(g.id);
        } else if (action === "pause" || action === "cancel") {
          void opts.client
            .request(action === "pause" ? "goal.pause" : "goal.cancel", { goalId: g.id })
            .then(() => {
              appendSystem([`Goal ${theme.bold(g.id)} ${action === "pause" ? "paused" : "cancelled"}.`], "info");
              void refreshGoals();
            })
            .catch((err) => appendError(err, `goal.${action}`));
        } else {
          void opts.client
            .request<{ goal: GoalRecord; reviews: GoalReviewVerdict[] }>("goal.get", { goalId: g.id })
            .then((detail) => appendSystem(formatGoalDetailCard(detail.goal, detail.reviews, theme), "info"))
            .catch((err) => appendError(err, "goal.get"));
        }
      },
      () => handle?.close(),
      () => handle?.rerender(),
    );
    handle = overlays.push(
      {
        title: "Goals Dashboard",
        subtitle: `${goals.length} total`,
        footer: "Enter inspect · r review · p pause · x cancel · Esc close",
      },
      comp,
      { width: "90%" },
    );
  };

  const showStatusCard = () => {
    void opts.client
      .request<{ pid: number; uptimeMs: number; profiles: Array<{ id: string; enabled: boolean }> }>("status")
      .then((st) => {
        const enabled = st.profiles
          .filter((p) => p.enabled)
          .map((p) => p.id)
          .join(", ");
        appendSystem(
          [
            `${theme.bold("Harness Status")} · daemon pid ${st.pid} (up ${Math.round(st.uptimeMs / 1000)}s)`,
            `Chat: ${theme.accent(session.id)} │ Model: ${theme.bold(session.model ?? session.profileId)} │ Effort: ${session.effort ?? "default"}`,
            `Enabled CLIs: ${enabled || "(none)"}`,
            `Goals: ${goals.length} total (${goals.filter((g) => g.status === "executing").length} executing, ${goals.filter((g) => g.status === "achieved").length} achieved)`,
          ],
          "info",
        );
      })
      .catch((err) => appendError(err, "status"));
  };

  const showHelpCard = () => {
    appendSystem(
      [
        theme.bold("Commands & Shortcuts"),
        `${theme.accent("/attach")} [id]          Switch to & take over another session (detaches other terminal)`,
        `${theme.accent("/new")} [title]          Start a new concurrent Director Chat session`,
        `${theme.accent("/model")} (/models)      Searchable model & ACP route picker (Tab switches CLI route)`,
        `${theme.accent("/cli")} [name] (/acp)    Switch active ACP CLI (codex / claude / amp / antigravity)`,
        `${theme.accent("/effort")} [level]       Pick reasoning effort (low / medium / high / xhigh / max / ultra)`,
        `${theme.accent("/quota")}                Subscription & API quota buckets with reset timers`,
        `${theme.accent("/goals")}                Goal Dashboard (inspect, review, pause, cancel)`,
        `${theme.accent("/runs")}                 Autonomous Runs Dashboard (inspect, resume, wait, stop)`,
        `${theme.accent("/resume")} [id] [wait]   Resume quota-paused run now or pick a wait timer (e.g. /resume 15m)`,
        `${theme.accent("/review")} <goal-id>     Run deterministic gates + Skeptical Done-Review`,
        `${theme.accent("/worktrees")}            List & clean stale/orphaned git worktrees`,
        `${theme.accent("/kb")} [query]           Browse 2-stage Knowledge Base`,
        `${theme.accent("/settings")} (Ctrl+,)    Configure defaults, Quota Endpoint & External ACP CLIs`,
        `${theme.accent("Ctrl+O")}                Open Command Palette without clearing your draft`,
        `${theme.accent("Ctrl+C")} / ${theme.accent("Ctrl+D")}       Clear input / cancel turn / detach & exit cleanly`,
        `${theme.accent("Ctrl+]")} (/detach)      Instant tmux-style detach (agents keep running in harnessd)`,
      ],
      "info",
    );
  };

  const openCommandPalette = () => {
    const commands: PaletteCommand[] = [
      { id: "attach", label: "Attach / Switch Session", shortcut: "/attach", description: "Take over another chat or run session", run: openSessionsPicker },
      { id: "new", label: "New Chat Session", shortcut: "/new", description: "Start a new concurrent Director chat", run: () => createNewChatSession() },
      { id: "model", label: "Select Model & Route", shortcut: "/model", description: "Ranked catalog + Tab to pick ACP CLI route", run: openModelPicker },
      { id: "cli", label: "Switch ACP CLI", shortcut: "/cli", description: "Switch active CLI (codex / claude / amp / agy)", run: openCliPicker },
      { id: "effort", label: "Reasoning Effort", shortcut: "/effort", description: "Adjust reasoning budget", run: () => openEffortPicker() },
      { id: "quota", label: "View Quotas", shortcut: "/quota", description: "Live subscription & API bucket bars", run: openQuota },
      { id: "goals", label: "Goals Dashboard", shortcut: "/goals", description: "Inspect, review, pause, or cancel goals", run: () => void refreshGoals().then(openGoals) },
      { id: "runs", label: "Autonomous Runs", shortcut: "/runs", description: "Inspect, resume, schedule wait, or stop runs", run: openRuns },
      { id: "resume", label: "Resume / Schedule Quota Wait", shortcut: "/resume", description: "Resume a quota-paused run now or pick wait timer", run: () => handleResumeSlashCommand("") },
      { id: "settings", label: "Settings & CLIs", shortcut: "Ctrl+,", description: "Configure CLIs, defaults & quota endpoint", run: openSettings },
      { id: "worktrees", label: "Git Worktrees", shortcut: "/worktrees", description: "List & sweep stale/orphaned worktrees", run: openWorktrees },
      { id: "kb", label: "Knowledge Base", shortcut: "/kb", description: "Browse 2-stage curated learnings", run: () => openKb("") },
      { id: "status", label: "Harness Status", shortcut: "/status", description: "Daemon health, CLIs, and goals summary", run: showStatusCard },
      { id: "help", label: "Help & Shortcuts", shortcut: "/help", description: "List slash commands & keybindings", run: showHelpCard },
      {
        id: "clear",
        label: "Clear Screen",
        shortcut: "/clear",
        description: "Clear local scrollback cards",
        run: () => {
          chatContainer.clear();
          chatContainer.addChild(new BannerCard(theme, "pi-harness", `Director Chat · ${session.id}`));
          tui.requestRender(true);
        },
      },
      {
        id: "detach",
        label: "Detach / Quit",
        shortcut: "Ctrl+]",
        description: "Detach (or quit harnessd if nothing is running)",
        run: () =>
          void term.shutdown(undefined, {
            overlays,
            spinner,
            resolveNote: () => resolveLeaveNote(opts.client),
            cleanup: cleanupFullExit,
          }),
      },
    ];

    let handle: ReturnType<OverlayManager["push"]> | null = null;
    const comp = new CommandPaletteOverlay(
      theme,
      commands,
      () => handle?.close(),
      () => handle?.rerender(),
    );
    handle = overlays.push(
      {
        title: "Command Palette",
        subtitle: `${commands.length} commands`,
        footer: "↑/↓ move · Enter run · Esc close",
      },
      comp,
      { width: "80%" },
    );
  };

  let unsubEvent = () => {};
  let unsubClose = () => {};

  const detachListenersOnly = () => {
    unsubEvent();
    unsubClose();
  };

  const cleanupFullExit = () => {
    detachListenersOnly();
    opts.client.close();
  };

  const dispatchChatTurn = (text: string) => {
    busy = true;
    const reqId = ++activeRequestId;
    chatContainer.addChild(new UserCard(theme, text));
    clearPending();
    refreshStatus();
    refreshQueueHint();
    spinner.start(`Thinking (${session.model ?? session.profileId})…`);

    void opts.client
      .request<{ assistantTurn: ChatTurnRecord }>("chat.send", { chatSessionId: session.id, text })
      .then(
        (res) => {
          if (reqId !== activeRequestId) return;
          busy = false;
          spinner.stop();
          // Preserve finalized tool pills into immutable scrollback before clearing pending
          for (const pill of activeToolPills.values()) {
            chatContainer.addChild(pill);
          }
          clearPending();
          chatContainer.addChild(
            new AssistantCard(theme, res.assistantTurn.content, session.model ?? session.profileId),
          );
          refreshStatus();
          tui.requestRender();
          void refreshGoals();
          const nextQueued = queuedMessages.shift();
          refreshQueueHint();
          if (nextQueued) dispatchChatTurn(nextQueued);
        },
        (err) => {
          if (reqId !== activeRequestId) return;
          busy = false;
          spinner.stop();
          clearPending();
          appendError(err, `chat.send:${session.profileId}`);
          refreshStatus();
          refreshQueueHint();
          tui.requestRender();
        },
      );
  };

  term.bindControls({
    overlays,
    spinner,
    footerHint,
    detachBanner: "[Exited.]",
    callbacks: {
      getComposerText: () => composer.getText(),
      clearComposerText: () => composer.clear(),
      isAutocompleteOpen: () => composer.isAutocompleteOpen(),
      isBusy: () => busy,
      onAbortGeneration: () => {
        if (!busy) return;
        activeRequestId++;
        busy = false;
        queuedMessages.length = 0;
        spinner.stop();
        void opts.client.request("chat.cancel", { chatSessionId: session.id }).catch(() => {});
        if (streamingText.trim()) {
          chatContainer.addChild(new AssistantCard(theme, streamingText, `${session.model ?? session.profileId} · cancelled`));
        }
        clearPending();
        refreshQueueHint();
        appendSystem(["Cancelled current response."], "warning");
        refreshStatus();
        tui.requestRender();
      },
      onOpenSettings: openSettings,
      onOpenPalette: openCommandPalette,
      onResolveExitNote: () => resolveLeaveNote(opts.client),
      onShutdownCleanup: cleanupFullExit,
    },
  });

  composer.onSubmit = (raw) => {
    const text = raw.trim();
    composer.clear();
    if (!text) return;
    composer.addToHistory(text);

    if (text === "/detach" || text === "/q" || text === "/quit" || text === "/exit") {
      void term.shutdown(undefined, {
        overlays,
        spinner,
        resolveNote: () => resolveLeaveNote(opts.client),
        cleanup: cleanupFullExit,
      });
      return;
    }
    if (text === "/attach" || text === "/sessions") return openSessionsPicker();
    if (text.startsWith("/attach ")) return switchToTarget(text.slice("/attach ".length).trim());
    if (text === "/new" || text.startsWith("/new ")) {
      createNewChatSession(text.slice("/new".length).trim() || undefined);
      return;
    }
    if (text === "/settings" || text === "/profiles") return openSettings();
    if (text === "/cli" || text === "/acp" || text === "/profile") return openCliPicker();
    if (text.startsWith("/cli ") || text.startsWith("/acp ") || text.startsWith("/profile ")) {
      switchCliProfile(text.slice(text.indexOf(" ") + 1).trim());
      return;
    }
    if (text === "/model" || text === "/models") return openModelPicker();
    if (text === "/effort" || text.startsWith("/effort ")) {
      const direct = text.slice("/effort".length).trim();
      if (direct) {
        void opts.client
          .request<ChatSessionRecord>("chat.update", { chatSessionId: session.id, effort: direct })
          .then((updated) => {
            session = updated;
            appendSystem([`Active reasoning effort set to ${theme.bold(direct)}`], "success");
            refreshStatus();
            tui.requestRender();
          })
          .catch((err) => appendError(err, "effort.update"));
      } else {
        openEffortPicker();
      }
      return;
    }
    if (text === "/quota") return openQuota();
    if (text === "/goals") {
      void refreshGoals().then(openGoals);
      return;
    }
    if (text === "/runs") return openRuns();
    if (text === "/resume" || text.startsWith("/resume ")) {
      handleResumeSlashCommand(text.slice("/resume".length).trim());
      return;
    }
    if (text === "/worktrees") return openWorktrees();
    if (text === "/kb" || text.startsWith("/kb ")) return openKb(text.slice("/kb".length).trim());
    if (text === "/status") return showStatusCard();
    if (text.startsWith("/review ")) return triggerGoalReview(text.slice("/review ".length).trim());
    if (text === "/clear") {
      chatContainer.clear();
      chatContainer.addChild(new BannerCard(theme, "pi-harness", `Director Chat · ${session.id}`));
      tui.requestRender(true);
      return;
    }
    if (text === "/help") return showHelpCard();

    if (busy) {
      queuedMessages.push(text);
      refreshQueueHint();
      tui.requestRender();
      return;
    }

    dispatchChatTurn(text);
  };

  unsubEvent = opts.client.onEvent((ev) => {
    if (ev.type === "session.taken_over") {
      evictedByTakeover = true;
      const p = ev.payload as { sessionId?: string; reason?: string };
      void term.shutdown(
        `[Detached — session ${p.sessionId ?? session.id} was taken over by another terminal.]`,
        { overlays, spinner, cleanup: cleanupFullExit },
      );
      return;
    }
    if (ev.type === "chat.delta" && busy) {
      const delta = String((ev.payload as { delta?: string })?.delta ?? "");
      if (!delta) return;
      streamingText += delta;
      if (pendingMarkdownContainer.children.length === 0) {
        pendingMarkdownContainer.addChild(pendingMarkdown);
      }
      pendingMarkdown.setText(streamingText);
      tui.requestRender();
    } else if (ev.type === "chat.tool" && busy) {
      const p = ev.payload as { id?: string; name?: string; status?: string; title?: string };
      const rawLabel = p.title ?? p.name ?? "tool";
      const displayLabel = rawLabel.replace(/^mcp[._/]harness[._/]+/i, "harness:").replace(/^mcp__harness__/i, "harness:");
      const key = p.id || displayLabel;
      const st = p.status === "completed" ? "ok" : p.status === "failed" ? "error" : "running";
      const detail = st === "ok" ? "" : st === "error" ? "failed" : "running…";
      const existing = activeToolPills.get(key);
      if (existing) {
        existing.update(st, detail);
      } else {
        const pill = new ToolPill(theme, st, displayLabel, detail);
        activeToolPills.set(key, pill);
        pendingToolsContainer.addChild(pill);
      }
      tui.requestRender();
    } else if (ev.type === "goal.reviewed") {
      const p = ev.payload as { goalId: string; version: number; cycle: number; verdict: string; status: string; summary: string };
      appendSystem(
        [`[${p.goalId} v${p.version}] Review #${p.cycle}: ${p.verdict.toUpperCase()} (${p.status}) — ${p.summary}`],
        p.verdict === "approved" ? "success" : "warning",
      );
      void refreshGoals();
    } else if (ev.type === "goal.amended") {
      const p = ev.payload as { goalId: string; delta: { fromVersion: number; toVersion: number; rationale: string } };
      appendSystem([`[${p.goalId}] Amended v${p.delta.fromVersion} → v${p.delta.toVersion}: ${p.delta.rationale}`], "info");
      void refreshGoals();
    } else if (ev.type === "goal.committed") {
      const p = ev.payload as { goalId: string; version: number; title: string };
      appendSystem([`[${p.goalId} v${p.version}] Autonomous execution started: ${p.title}`], "success");
      void refreshGoals();
    } else if (ev.type === "quota.agent_paused") {
      const p = ev.payload as {
        runId: string;
        taskId: string;
        tier: number;
        title: string;
        profileId: string;
        model?: string | null;
        reason: string;
        resetAt?: string | null;
      };
      const eta = p.resetAt ? ` (reset ${formatResetCountdown(p.resetAt)})` : "";
      appendSystem(
        [
          `${theme.bold(`⏸ Agent paused early (quota)`)} · ${theme.accent(p.taskId)} [T${p.tier}] "${p.title}" (${p.model ?? p.profileId})`,
          `${p.reason}${eta} — worktree & WIP preserved; healthy sibling tasks continue.`,
        ],
        "warning",
      );
    } else if (ev.type === "quota.run_paused") {
      const p = ev.payload as {
        runId: string;
        pausedTaskIds: string[];
        mode: "auto_timer" | "user_timer" | "manual";
        source: string;
        resumeAt?: string | null;
        reason: string;
      };
      const actionLine =
        p.mode === "auto_timer" && p.resumeAt
          ? `Auto-resume scheduled ${formatResetCountdown(p.resumeAt)} (${p.source}). Run /resume ${p.runId} now to override or pick a wait timer.`
          : `No Quota Endpoint / reset time wired — paused cleanly. Run /resume ${p.runId} to resume now or pick how long to wait (e.g. /resume 15m).`;
      appendSystem(
        [
          `${theme.bold(`⏸ Run ${p.runId} paused (quota)`)} — all active workers exited (${p.pausedTaskIds.length} task(s) waiting)`,
          actionLine,
        ],
        "warning",
      );
    } else if (ev.type === "quota.run_scheduled") {
      const p = ev.payload as { runId: string; resumeAt: string };
      appendSystem(
        [`⏱ Run ${theme.bold(p.runId)} scheduled to auto-resume ${formatResetCountdown(p.resumeAt)} (${p.resumeAt}).`],
        "info",
      );
    } else if (ev.type === "quota.run_resumed") {
      const p = ev.payload as { runId: string; trigger: string; resumedTaskIds: string[] };
      appendSystem(
        [`▶ Run ${theme.bold(p.runId)} resumed (${p.trigger}) — restarted ${p.resumedTaskIds.length} task(s).`],
        "success",
      );
    }
  });

  unsubClose = opts.client.onClose(() => {
    if (evictedByTakeover) return;
    void term.shutdown("[Connection to harnessd closed — check ~/.pi-harness/daemon.log if unexpected.]", {
      overlays,
      spinner,
      cleanup: cleanupFullExit,
    });
  });

  if (busy) spinner.start(`Thinking (${session.model ?? session.profileId})…`);
  refreshStatus();
  term.start();
  tui.requestRender();
  await term.closed;
  return exitAction;
}

/**
 * Focused Run Stream TUI (`pi-harness attach <run-id>`) with `Ctrl+T` Agent Tree Switcher.
 */
export async function runNativeScrollbackTui(opts: {
  client: DaemonClient;
  runId: string;
  initialTaskId?: string | null;
}): Promise<TuiExitAction> {
  // Handshake BEFORE touching terminal raw mode
  const snap = await opts.client.request<{
    run: RunRecord;
    tasks: TaskRecord[];
    escalations: EscalationRecord[];
    quotaPause?: RunQuotaPauseStatus | null;
  }>("tree.get", { runId: opts.runId });

  let focusedTaskId: string | null = opts.initialTaskId ?? null;
  let lastSeq = 0;
  let run: RunRecord = snap.run;
  let tasks: TaskRecord[] = snap.tasks;
  let escalations: EscalationRecord[] = snap.escalations;
  let quotaPause: RunQuotaPauseStatus | null = snap.quotaPause ?? null;
  let streamingBuffer = "";
  let exitAction: TuiExitAction = { kind: "exit" };
  let evictedByTakeover = false;
  const activeRunToolPills = new Map<string, ToolPill>();

  const theme = createTheme();
  const term = new TerminalSession();
  const tui = term.tui;

  const streamContainer = new Container();
  const pendingContainer = new Container();
  const pendingMarkdown = new Markdown("", 1, 0, theme.toMarkdownTheme());
  const spinner = new TimedSpinner(tui, theme);
  const statusBar = new StatusBar(theme, {
    tone: "accent",
    modeLabel: opts.runId,
    modelLabel: focusedTaskId ?? "ALL",
    goalsSummary: `${tasks.filter((t) => t.status === "running").length} running`,
    rightHints: [
      ["Ctrl+T", "tree"],
      ["Ctrl+]", "detach"],
      ["Ctrl+C", "exit"],
    ],
  });
  const composer = new Composer(tui, theme, {
    placeholder: "Steer focused agent…  (Ctrl+T agent tree · /stop · Ctrl+] detach)",
    slashCommands: RUN_SLASH_COMMANDS,
  });
  const footerHint = new FooterHint(theme);
  const overlays = new OverlayManager(tui, theme, composer);

  streamContainer.addChild(
    new BannerCard(
      theme,
      `pi-harness run ${opts.runId}`,
      `status: ${run.status} · focus: ${focusedTaskId ?? "ALL"}`,
      "Type to steer focused agent · Ctrl+T agent tree · /stop · Ctrl+] detach · Ctrl+C exit",
    ),
  );

  tui.addChild(streamContainer);
  tui.addChild(pendingContainer);
  tui.addChild(new Spacer(1));
  tui.addChild(spinner);
  tui.addChild(statusBar);
  tui.addChild(composer);
  tui.addChild(footerHint);
  tui.setFocus(composer);

  const refreshStatus = () => {
    const running = tasks.filter((t) => t.status === "running").length;
    const pausedQuota = tasks.filter((t) => t.status === "paused_quota").length;
    const isQuotaPaused = run.status === "paused_quota" || (running === 0 && pausedQuota > 0);
    const quotaAlert = isQuotaPaused
      ? quotaPause?.resumeAt
        ? `⏸ quota (${formatResetCountdown(quotaPause.resumeAt)})`
        : "⏸ quota (/resume)"
      : null;

    statusBar.update({
      tone: escalations.length > 0 ? "error" : isQuotaPaused ? "warning" : running > 0 ? "accent" : "success",
      modeLabel: `${opts.runId} (${run.status})`,
      modelLabel: `focus:${focusedTaskId ?? "ALL"}`,
      goalsSummary: isQuotaPaused ? `${pausedQuota} paused` : `${running} running`,
      alertText: escalations.length > 0 ? `${escalations.length} esc` : quotaAlert,
    });
  };

  const flushStreaming = () => {
    if (streamingBuffer) {
      streamContainer.addChild(new AssistantCard(theme, streamingBuffer));
      streamingBuffer = "";
      pendingContainer.clear();
    }
  };

  const openTree = () => {
    let handle: ReturnType<OverlayManager["push"]> | null = null;
    const comp = new TreeOverlay(
      theme,
      () => tasks,
      () => escalations,
      (selectedTaskId) => {
        focusedTaskId = selectedTaskId;
        streamContainer.addChild(new SystemCard(theme, [`Switched stream focus to ${focusedTaskId ?? "ALL"}`], "info"));
        refreshStatus();
        tui.requestRender();
      },
      () => handle?.close(),
      () => handle?.rerender(),
    );
    handle = overlays.push(
      {
        title: "Agent Tree Switcher",
        subtitle: `${tasks.length} tasks`,
        footer: "↑/↓ move · Enter focus · Esc/Ctrl+T close",
      },
      comp,
      { width: "86%" },
    );
  };

  const appendEvent = (ev: DaemonEventFrame) => {
    if (ev.type === "session.taken_over") {
      evictedByTakeover = true;
      const p = ev.payload as { sessionId?: string };
      void term.shutdown(
        `[Detached — session ${p.sessionId ?? opts.runId} was taken over by another terminal.]`,
        { overlays, spinner, cleanup: cleanupFullExit },
      );
      return;
    }
    if (ev.seq > lastSeq) lastSeq = ev.seq;
    if (focusedTaskId && ev.taskId && ev.taskId !== focusedTaskId) return;

    if (ev.type === "agent.text_delta") {
      const text = String((ev.payload as { text?: string })?.text ?? "");
      if (!text) return;
      streamingBuffer += text;
      if (pendingContainer.children.length === 0) pendingContainer.addChild(pendingMarkdown);
      pendingMarkdown.setText(streamingBuffer);
      tui.requestRender();
      return;
    }

    flushStreaming();
    const prefix = ev.taskId ? `[${ev.taskId}]` : `[run]`;

    if (ev.type === "agent.tool") {
      const p = ev.payload as { id?: string; name?: string; status?: string; title?: string };
      const rawLabel = p.title ?? p.name ?? "tool";
      const displayLabel = rawLabel.replace(/^mcp[._/]harness[._/]+/i, "harness:").replace(/^mcp__harness__/i, "harness:");
      const key = p.id ? `${ev.taskId ?? ""}:${p.id}` : `${ev.taskId ?? ""}:${displayLabel}`;
      const st = p.status === "completed" ? "ok" : p.status === "failed" ? "error" : "running";
      const detail = st === "ok" ? "" : st === "error" ? "failed" : "running…";
      const existing = activeRunToolPills.get(key);
      if (existing) {
        existing.update(st, detail);
      } else {
        const pill = new ToolPill(theme, st, `${prefix} ${displayLabel}`, detail);
        activeRunToolPills.set(key, pill);
        streamContainer.addChild(pill);
      }
    } else if (ev.type === "agent.error") {
      const formatted = formatAgentError(String((ev.payload as { error?: string })?.error ?? "Agent error"));
      streamContainer.addChild(new ErrorCard(theme, formatted));
    } else if (
      ev.type === "quota.agent_retrying" ||
      ev.type === "quota.agent_recovered" ||
      ev.type === "quota.agent_paused" ||
      ev.type === "quota.run_paused" ||
      ev.type === "quota.run_scheduled" ||
      ev.type === "quota.run_resumed"
    ) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      if (ev.type === "quota.agent_retrying") {
        streamContainer.addChild(
          new SystemCard(
            theme,
            [
              `${prefix} Rate-limited (${String(p.reason ?? "429")}) — letting CLI retry natively (watchdog ${Math.round(Number(p.timeoutMs ?? 45000) / 1000)}s)…`,
            ],
            "muted",
          ),
        );
      } else if (ev.type === "quota.agent_recovered") {
        streamContainer.addChild(
          new SystemCard(theme, [`${prefix} Recovered after ${String(p.retryCount ?? 1)} transient 429 retry(ies).`], "success"),
        );
      } else if (ev.type === "quota.agent_paused") {
        const eta = p.resetAt ? ` · reset ${formatResetCountdown(String(p.resetAt))}` : "";
        streamContainer.addChild(
          new SystemCard(
            theme,
            [`${prefix} ⏸ Stopped early due to quota (${String(p.reason ?? "quota")}${eta}) — worktree & WIP preserved.`],
            "warning",
          ),
        );
      } else if (ev.type === "quota.run_paused") {
        const resumeAt = typeof p.resumeAt === "string" ? p.resumeAt : null;
        const mode = String(p.mode ?? "manual");
        const msg =
          mode === "auto_timer" && resumeAt
            ? `⏸ All workers exited — run paused on quota. Auto-resuming ${formatResetCountdown(resumeAt)}. Send any message or run /resume to override.`
            : `⏸ All workers exited — run paused on quota (no Quota Endpoint wired). Send any message to resume now, or run /resume to pick a wait timer.`;
        streamContainer.addChild(new SystemCard(theme, [msg], "warning"));
      } else if (ev.type === "quota.run_scheduled") {
        streamContainer.addChild(
          new SystemCard(
            theme,
            [`⏱ Auto-resume scheduled ${formatResetCountdown(String(p.resumeAt ?? ""))} (${String(p.resumeAt ?? "")}). Send any message to resume sooner.`],
            "info",
          ),
        );
      } else if (ev.type === "quota.run_resumed") {
        quotaPause = null;
        streamContainer.addChild(
          new SystemCard(
            theme,
            [`▶ Run resumed (${String(p.trigger ?? "manual")}) — restarted ${Array.isArray(p.resumedTaskIds) ? p.resumedTaskIds.length : 0} task(s).`],
            "success",
          ),
        );
      }
      void opts.client
        .request<{
          run: RunRecord;
          tasks: TaskRecord[];
          escalations: EscalationRecord[];
          quotaPause?: RunQuotaPauseStatus | null;
        }>("tree.get", { runId: opts.runId })
        .then((fresh) => {
          run = fresh.run;
          tasks = fresh.tasks;
          escalations = fresh.escalations;
          quotaPause = fresh.quotaPause ?? null;
          refreshStatus();
          tui.requestRender();
        })
        .catch(() => {});
    } else if (
      ev.type === "task.created" ||
      ev.type === "task.status" ||
      ev.type === "agent.rollover" ||
      ev.type === "escalation.created" ||
      ev.type === "merge.finished" ||
      ev.type === "goal.reviewed" ||
      ev.type === "goal.amended"
    ) {
      const p = (ev.payload ?? {}) as Record<string, unknown>;
      const detail =
        ev.type === "task.created"
          ? `spawned T${p.tier} "${p.title}" (${p.model ?? p.profileId})`
          : ev.type === "task.status"
            ? `${p.from} → ${p.to}${p.summary ? ` — ${p.summary}` : ""}`
            : ev.type === "agent.rollover"
              ? `clean rollover gen ${p.fromGen} → ${p.toGen} (${p.reason})`
              : ev.type === "escalation.created"
                ? `[${p.severity}/${p.category}] ${p.title}`
                : ev.type === "merge.finished"
                  ? `branch ${p.branch} → ${p.status}`
                  : String(p.summary ?? ev.type);
      const tone = ev.type === "escalation.created" ? "warning" : ev.type === "merge.finished" ? "success" : "muted";
      streamContainer.addChild(new SystemCard(theme, [`${prefix} ${detail}`], tone));
      void opts.client
        .request<{ run: RunRecord; tasks: TaskRecord[]; escalations: EscalationRecord[] }>("tree.get", { runId: opts.runId })
        .then((fresh) => {
          run = fresh.run;
          tasks = fresh.tasks;
          escalations = fresh.escalations;
          refreshStatus();
          tui.requestRender();
        })
        .catch(() => {});
    }

    refreshStatus();
    tui.requestRender();
  };

  let unsubEvent = () => {};
  let unsubClose = () => {};

  const detachListenersOnly = () => {
    unsubEvent();
    unsubClose();
  };

  const cleanupFullExit = () => {
    detachListenersOnly();
    opts.client.close();
  };

  const openRunSessionsPicker = () => {
    void opts.client.request<AttachableSession[]>("sessions.list").then((sessions) => {
      let handle: ReturnType<OverlayManager["push"]> | null = null;
      const comp = new SessionsOverlay(
        theme,
        sessions,
        (chosen) => {
          exitAction = { kind: "switch", targetId: chosen.id, targetKind: chosen.kind };
          void term.shutdown(undefined, { overlays, spinner, cleanup: detachListenersOnly });
        },
        () => {
          exitAction = { kind: "switch", targetId: "__new__", targetKind: "chat" };
          void term.shutdown(undefined, { overlays, spinner, cleanup: detachListenersOnly });
        },
        () => handle?.close(),
        () => handle?.rerender(),
      );
      handle = overlays.push(
        {
          title: "Sessions & Attach Switcher",
          subtitle: `${sessions.length} session${sessions.length === 1 ? "" : "s"}`,
          footer: "Enter attach & take over · n new chat · Esc close",
        },
        comp,
        { width: "92%" },
      );
    });
  };

  term.bindControls({
    overlays,
    spinner,
    footerHint,
    detachBanner: "[Exited.]",
    callbacks: {
      getComposerText: () => composer.getText(),
      clearComposerText: () => composer.clear(),
      isAutocompleteOpen: () => composer.isAutocompleteOpen(),
      isBusy: () => false,
      onAbortGeneration: () => {},
      onOpenTree: openTree,
      onResolveExitNote: () => resolveLeaveNote(opts.client),
      onShutdownCleanup: cleanupFullExit,
    },
  });

  composer.onSubmit = (raw) => {
    const text = raw.trim();
    composer.clear();
    if (!text) return;
    composer.addToHistory(text);

    if (text === "/detach" || text === "/q" || text === "/quit" || text === "/exit") {
      void term.shutdown(undefined, {
        overlays,
        spinner,
        resolveNote: () => resolveLeaveNote(opts.client),
        cleanup: cleanupFullExit,
      });
      return;
    }
    if (text === "/attach" || text === "/sessions") return openRunSessionsPicker();
    if (text.startsWith("/attach ")) {
      const targetId = text.slice("/attach ".length).trim();
      exitAction = { kind: "switch", targetId, targetKind: targetId.startsWith("run-") ? "run" : "chat" };
      void term.shutdown(undefined, { overlays, spinner, cleanup: detachListenersOnly });
      return;
    }
    if (text === "/tree") return openTree();
    if (text === "/resume" || text.startsWith("/resume ")) {
      const arg = text.slice("/resume".length).trim();
      if (!arg) {
        let handle: ReturnType<OverlayManager["push"]> | null = null;
        const comp = new QuotaWaitPickerOverlay(
          theme,
          opts.runId,
          quotaPause?.reason ?? "Paused due to quota limit",
          quotaPause?.resumeAt ?? null,
          (choice) => {
            if (choice.kind === "now") {
              void opts.client.request("run.resume", { runId: opts.runId }).catch(() => {});
            } else {
              void opts.client.request("run.schedule_resume", { runId: opts.runId, delayMs: choice.delayMs }).catch(() => {});
            }
          },
          () => handle?.close(),
          () => handle?.rerender(),
        );
        handle = overlays.push(
          {
            title: "Quota Pause — Resume or Schedule Wait",
            subtitle: opts.runId,
            footer: "↑/↓ move · Enter apply · Esc keep paused",
          },
          comp,
          { width: "80%" },
        );
        return;
      }
      if (arg.toLowerCase() === "now") {
        void opts.client.request("run.resume", { runId: opts.runId }).catch(() => {});
        return;
      }
      const delayMs = parseDurationMs(arg);
      if (delayMs) {
        void opts.client.request("run.schedule_resume", { runId: opts.runId, delayMs }).catch(() => {});
        return;
      }
      void opts.client.request("run.resume", { runId: opts.runId, message: arg }).catch(() => {});
      return;
    }
    if (text === "/stop") {
      void opts.client.request("run.stop", { runId: opts.runId }).then(() => {
        void term.shutdown(undefined, {
          overlays,
          spinner,
          resolveNote: () => resolveLeaveNote(opts.client),
          cleanup: cleanupFullExit,
        });
      });
      return;
    }
    if (text === "/help") {
      streamContainer.addChild(
        new SystemCard(
          theme,
          [
            "Commands: /attach [id] · /tree (Ctrl+T) · /resume [now|15m] · /stop · /detach (Ctrl+]) · type text to steer (or resume if quota-paused)",
          ],
          "info",
        ),
      );
      tui.requestRender();
      return;
    }

    // Sending ANY message while the run is paused on quota manually resumes & resets the quota state machine!
    const hasPausedTasks = tasks.some((t) => t.status === "paused_quota");
    if (run.status === "paused_quota" || (hasPausedTasks && !tasks.some((t) => t.status === "running"))) {
      void opts.client
        .request<{ resumed: boolean; resumedTaskIds: string[] }>("run.resume", { runId: opts.runId, message: text })
        .then((res) => {
          streamContainer.addChild(new UserCard(theme, `[▶ resume] ${text}`));
          if (!res.resumed) {
            streamContainer.addChild(new SystemCard(theme, ["No quota-paused tasks remained to resume."], "muted"));
          }
          tui.requestRender();
        });
      return;
    }

    const targetId = focusedTaskId ?? tasks.find((t) => t.tier === 1)?.id;
    if (!targetId) {
      streamContainer.addChild(new SystemCard(theme, ["No active task to steer."], "warning"));
      tui.requestRender();
      return;
    }
    void opts.client.request("task.steer", { taskId: targetId, message: text }).then(() => {
      streamContainer.addChild(new UserCard(theme, `[→ ${targetId}] ${text}`));
      tui.requestRender();
    });
  };

  unsubEvent = opts.client.onEvent(appendEvent);
  unsubClose = opts.client.onClose(() => {
    if (evictedByTakeover) return;
    void term.shutdown("[Connection to harnessd closed.]", { overlays, spinner, cleanup: cleanupFullExit });
  });

  const attached = await opts.client.request<{
    tookOver?: boolean;
    replay?: Array<{
      seq: number;
      runId: string;
      taskId: string | null;
      type: string;
      payload: unknown;
      createdAt: number;
    }>;
  }>("attach", {
    runId: opts.runId,
    taskId: focusedTaskId,
    sinceSeq: lastSeq,
  });

  for (const ev of attached.replay ?? []) {
    appendEvent({ kind: "event", ...ev });
  }
  flushStreaming();
  if (attached.tookOver) {
    streamContainer.addChild(
      new SystemCard(theme, [`Took over ${opts.runId} (previous terminal was detached).`], "info"),
    );
  }

  refreshStatus();
  term.start();
  tui.requestRender();
  await term.closed;
  return exitAction;
}
