import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { ModelCatalogCompiler } from "../catalog/compiler.js";
import {
  diffHarnessConfig,
  findMisplacedConfigKeys,
  isPlainObject,
  normalizeWorktreeRoots,
  readRepoConfig,
  resolveConfig,
  saveGlobalConfig,
  serializeGlobalConfig,
  stableEqual,
  validateConfigRaw,
  type GoalsConfig,
  type HarnessConfig,
  type MisplacedConfigKey,
  type RemoteHostConfig,
  type RunnerProfileConfig,
} from "../config.js";
import { ControlPlaneDb, type ReplayCursor, type EventRecord, type RunRecord } from "../control-plane/db.js";
import { readRunDossier, readWorkspaceArtifact, type WorkspaceArtifactPolicy } from "../control-plane/dossiers.js";
import { compactTaskHandoff } from "../control-plane/handoffs.js";
import { directorTaskRunOwner } from "../control-plane/ids.js";
import { canonicalProjectPath, type ProjectRecord } from "../control-plane/projects.js";
import type { ChatSessionRecord } from "../director/session.js";
import { deriveRunStatus, HarnessOrchestrator, isDirectorTaskContainer, type CustomRunnerFactory } from "../control-plane/orchestrator.js";
import {
  getLastRecoveryFailures,
  listInterruptedReviewGoals,
  replayInterruptedReviews,
} from "../control-plane/restart-recovery.js";
import { loadOrCreateNodeId, parseSessionAddress, type SessionMessageRecord } from "../control-plane/session-messages.js";
import { buildRunActivitySummary } from "../control-plane/telemetry.js";
import { summarizeCost } from "../cost/ledger.js";
import { GOAL_VERIFICATION_IDLE_NOTE } from "../director/goal-get.js";
import { DirectorRuntime, StaleWakeEventError } from "../director/runtime.js";
import { parseGoalCriterionPatches, type GoalCriterion } from "../goals/engine.js";
import {
  coalesceGoalEvents,
  formatChatEventSummary,
  isGoalLifecycleEvent,
  isReviewInvalidated,
  type ChatControlEvent,
} from "../protocol/chat-events.js";
import {
  DAEMON_PROTOCOL_REV,
  type DaemonEventFrame,
  type DaemonLifecycle,
  type DaemonOp,
  type DaemonReloadParams,
  type ReloadStatus,
  type RpcRequest,
  type RpcResponse,
  type SessionAttachControl,
  type SessionControlPayload,
  type SessionControlReason,
  type SessionControlState,
  type SnapshotWorktreeEntry,
} from "../protocol/daemon-rpc.js";
import { attachDaemonReader, writeDaemonMessage } from "../protocol/frames.js";
import { buildGoalDetailDisplay, buildGoalsTableDisplay, reconcileGoalWithLiveRun, summarizeToolDisplay } from "../protocol/tool-display.js";
import { QuotaClient } from "../quota/client.js";
import { ensureOctofs, resolveExternalMcpServers, shouldStageOctofs } from "../tools/native-tools.js";
import { AcpRunner } from "../runners/acp-runner.js";
import { PiRunner } from "../runners/pi-runner.js";
import { runStorageMigrationPass } from "../storage/migrate.js";
import { storagePaths, type RunRef, type StoragePaths } from "../storage/paths.js";
import { canonicalPath, runGit } from "../worktree/manager.js";
import { classifyAttention } from "../visibility/index.js";
import { HotUpdateController } from "./hot-update.js";
import { parseValidatedSshTarget, PeerManager, type PeerIdentity, type PeerLink, type RemoteHostStatus } from "./peer.js";
import { PtyHost } from "./pty-host.js";
import { listChildProcessGroups, reapChildProcessGroups } from "./reap.js";
import { currentRelease, type ReleaseTarget } from "./release.js";
import { acquireStartLock } from "./start-lock.js";
import { computeStartPassBudget, MIN_START_PASS_BUDGET_MS } from "./start-pass-budget.js";
import { spawnSupervisorDetached } from "./supervise.js";
import { WakeupStore, type PendingWake } from "./wakeup-store.js";

export { DAEMON_PROTOCOL_REV };

function isInProcessTestRunner(): boolean {
  return (
    process.env.NODE_ENV === "test" &&
    typeof Bun !== "undefined" &&
    /(?:\.|_)(?:test|spec)\.[cm]?[jt]sx?$/.test(Bun.main)
  );
}

function parseAttachControl(raw: unknown): SessionAttachControl {
  if (raw === undefined) return "take";
  if (raw === "take" || raw === "view") return raw;
  throw new Error(`Invalid control mode "${String(raw)}". Expected "take" or "view".`);
}

const SESSION_READ_ONLY_ERROR =
  "Session is read-only here: another terminal has control. Take control first (Ctrl+Y or /take).";

const WORK_STARTING_OPS = new Set<DaemonOp>([
  "chat.send",
  "chat.steer",
  "goal.commit",
  "goal.resume",
  "goal.review",
  "goal.accept",
  "run.create",
  "run.resume",
  "task.resume",
  "run.schedule_resume",
]);

interface TrackedTurnTool {
  name: string;
  status: string;
  args: string;
}

interface ActiveChatTurn {
  id: string;
  text: string;
  cancelling: boolean;
  startedAt: number;
  tools: Map<string, TrackedTurnTool>;
  toolCounter: number;
  settled: Promise<void>;
  markSettled: () => void;
  isSettled: boolean;
  detached: boolean;
}

function createActiveChatTurn(id: string): ActiveChatTurn {
  const { promise: settled, resolve: markSettled } = Promise.withResolvers<void>();
  return {
    id,
    text: "",
    cancelling: false,
    startedAt: Date.now(),
    tools: new Map(),
    toolCounter: 0,
    settled,
    markSettled,
    isSettled: false,
    detached: false,
  };
}

function trackTurnTool(
  turn: ActiveChatTurn,
  ev: { id?: string; name: string; status: string; args?: string },
): void {
  const key = ev.id ? ev.id : `${ev.name}#${turn.toolCounter++}`;
  const normArgs = typeof ev.args === "string" ? ev.args.replace(/\s+/g, " ").trim().slice(0, 160) : "";
  const prev = turn.tools.get(key);
  turn.tools.set(key, {
    name: ev.name,
    status: ev.status,
    args: normArgs || prev?.args || "",
  });
}

function formatInterruptedTurnDetails(
  tools: TrackedTurnTool[],
  tasks: Array<{ id: string; title: string; status: string }>,
): string {
  if (tools.length === 0 && tasks.length === 0) {
    return "No tool calls were recorded for the interrupted turn.";
  }
  const lines: string[] = [];
  if (tools.length > 0) {
    lines.push("Tool calls of the interrupted turn:");
    const completed: TrackedTurnTool[] = [];
    const failed: TrackedTurnTool[] = [];
    const inFlight: TrackedTurnTool[] = [];
    for (const t of tools) {
      if (/^(completed|done|success|ok)$/i.test(t.status)) completed.push(t);
      else if (/^(failed|error|cancelled)$/i.test(t.status)) failed.push(t);
      else inFlight.push(t);
    }
    for (const t of completed) lines.push(`- completed: ${t.name}${t.args ? ` ${t.args}` : ""}`);
    for (const t of failed) lines.push(`- failed: ${t.name}${t.args ? ` ${t.args}` : ""}`);
    for (const t of inFlight) lines.push(`- in flight when cancelled (outcome unknown): ${t.name}${t.args ? ` ${t.args}` : ""}`);
  }
  if (tasks.length > 0) {
    lines.push(
      `Tasks delegated during the turn (they exist, do not spawn them again): ${tasks
        .map((t) => `${t.id} "${t.title}" (${t.status})`)
        .join(", ")}`,
    );
  }
  return lines.join("\n");
}

function formatInterruptedTurnNotice(
  tools: TrackedTurnTool[],
  tasks: Array<{ id: string; title: string; status: string }>,
): string {
  return [
    "[harness] The daemon restarted while this turn was running. The turn was cancelled and its text so far is saved above.",
    formatInterruptedTurnDetails(tools, tasks),
  ].join("\n");
}

function formatContinuationTurnPrompt(
  tools: TrackedTurnTool[],
  tasks: Array<{ id: string; title: string; status: string }>,
): string {
  return [
    "Your previous turn was interrupted by a daemon restart. Its saved text is in the history above.",
    formatInterruptedTurnDetails(tools, tasks),
    "Continue from there. Do not repeat tool calls listed as completed. For calls listed as in flight, check their effect first (goal list, task tree) and repeat only what did not happen.",
  ].join("\n");
}

interface ClientAttachment {
  id: string;
  boundAtSeq: number;
  throughSeq: number;
  pendingSeq?: number;
  next?: ReplayCursor;
  socket: Socket;
  runId: string;
  taskId: string | null;
}

/** Read-only event subscription; never binds or evicts the socket's chat/run session. */
type ClientWatch = { throughSeq: number; pendingSeq?: number; next?: ReplayCursor; id: string; lastSeq: number; buffer: DaemonEventFrame[] | null } & (
  | { scope: "runs"; chatSessionId?: string; runIds?: Set<string> }
  | { scope: "run"; runId: string; taskId: null }
  | { scope: "task"; runId: string; taskId: string }
);

function chatSelection(params: Record<string, unknown>) {
  const { repoRoot, profileId, model, effort } = params;
  if (profileId != null && typeof profileId !== "string") throw new Error("Expected a profile ID");
  if (model != null && typeof model !== "string") throw new Error("Expected a model ID");
  return {
    repoRoot: String(repoRoot ?? process.cwd()),
    profileId: profileId ?? undefined,
    model,
    effort: typeof effort === "string" ? effort : null,
  };
}

function isRunsWatchEvent(type: string): boolean {
  return (
    type.startsWith("run.") ||
    type.startsWith("task.") ||
    type.startsWith("quota.") ||
    type.startsWith("escalation.") ||
    type === "agent.rollover"
  );
}

/**
 * Shallow-merges a validated `config.update` goals patch. A `gateEnv` map replaces the previous one whole;
 * `gateShell: null | ""` and `gateEnv: null` remove the key instead of storing null.
 */
function patchGoals(prev: GoalsConfig, patch: Record<string, unknown>): GoalsConfig {
  const next = { ...prev, ...patch } as Record<string, unknown>;
  if (next.gateShell === null || next.gateShell === "") delete next.gateShell;
  if (next.gateEnv === null) delete next.gateEnv;
  return next as unknown as GoalsConfig;
}

/** Top-level fields `config.update` applies; profiles and remotes have dedicated ops, runtime paths are fixed. */
const CONFIG_UPDATE_FIELDS: ReadonlySet<string> = new Set([
  "defaultOrchestratorProfile",
  "defaultWorkerProfile",
  "defaultTaskProfile",
  "codeMode",
  "rollover",
  "worktree",
  "goals",
  "events",
  "catalog",
  "quotaRetry",
  "quotaEndpoint",
  "hotUpdate",
]);

/** Warning lines for known config keys found at unsupported locations; built from schema names only, never values. */
function formatMisplacedConfigWarnings(fileLabel: "config.json" | ".pi-harness.json", items: MisplacedConfigKey[]): string[] {
  return items.map((m) => `${fileLabel}: "${m.path}" is ignored; supported location: ${m.supported}`);
}

export const MAX_PEER_MESSAGE_HOPS = 10;

/** Single positive allowlist enforced identically on inbound peer links, reverse peer calls, and `peer.proxy`. */
const PEER_ALLOWED_OPS: ReadonlySet<DaemonOp> = new Set<DaemonOp>([
  "ping",
  "project.list",
  "project.get",
  "project.create",
  "project.update",
  "project.remove",
  "project.browse",
  "sessions.list",
  "chat.create",
  "session.deliver_message",
  "session.list_messages",
  "session.read",
  "peer.sync_outbox",
]);

/** Default safe reverse-direction allowlist when a remote host calls back into an initiating daemon (`reverseAccess !== "full"`). */
const REVERSE_MESSAGES_ONLY_OPS: ReadonlySet<DaemonOp> = new Set<DaemonOp>([
  "ping",
  "project.list",
  "project.get",
  "sessions.list",
  "session.deliver_message",
  "session.list_messages",
  "session.read",
  "peer.sync_outbox",
]);

const OUTBOX_TTL_MS = 24 * 60 * 60_000;
const PEER_HOP_WINDOW_MS = 30 * 60_000;

export async function probeUnixSocketState(sockPath: string, timeoutMs = 250): Promise<"live" | "stale" | "unknown"> {
  return await new Promise<"live" | "stale" | "unknown">((resolve) => {
    let settled = false;
    const done = (state: "live" | "stale" | "unknown") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        probe.destroy();
      } catch {
        // ignore
      }
      resolve(state);
    };
    const probe = createConnection(sockPath);
    const timer = setTimeout(() => done("unknown"), timeoutMs);
    timer.unref?.();
    probe.once("connect", () => done("live"));
    probe.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        done("stale");
      } else {
        done("unknown");
      }
    });
  });
}

/**
 * `harnessd`: persistent headless daemon owning SQLite state, running agents,
 * worktree GC, model catalog + quota sync, and optional raw PTY shells.
 * Closing any terminal simply disconnects its socket — agents continue running uninterrupted.
 */
export class HarnessDaemon {
  readonly db: ControlPlaneDb;
  readonly nodeId: string;
  readonly peers: PeerManager;
  quota: QuotaClient;
  catalog: ModelCatalogCompiler;
  readonly orchestrator: HarnessOrchestrator;
  readonly director: DirectorRuntime;
  readonly ptyHost = new PtyHost();
  readonly instanceNonce = randomBytes(6).toString("hex");
  recovered: Promise<void> = Promise.resolve();

  private server: Server | null = null;
  private boundSocketIno: number | null = null;
  private lifecycle: DaemonLifecycle = "serving";
  private dbClosed = false;
  private recoveryDegraded: { failedTaskIds: string[]; errors: string[] } | undefined;
  private activeSweep: Promise<void> | null = null;
  private wakesGated = true;
  private restartExpected = false;
  private stopPromise: Promise<void> | null = null;
  private handoverPromise: Promise<void> | null = null;
  private capturedStopChildPgids = new Set<number>();
  private reapChildrenOnStop = false;
  private recoveryStaggerMs = 300;
  private readonly overlayRoot: string | undefined;
  private readonly disableReloadRpc: boolean;
  private readonly onExit: (code: number) => void;
  private readonly hotUpdate: HotUpdateController;
  private reloadFrom: string | undefined;
  private reloadLastError: { targetReleaseId: string; error: string } | undefined;
  private wakeups: WakeupStore;
  private allSockets = new Set<Socket>();
  private clientIds = new WeakMap<Socket, string>();
  private attachments = new Map<Socket, ClientAttachment>();
  /** Per-run controller socket (at most one controller per run; viewers live in `attachments`). */
  private runBindings = new Map<string, Socket>();
  /** Per-chat controller socket (at most one controller per chat; viewers live in `socketToChatId`). */
  private chatBindings = new Map<string, Socket>();
  /** Monotonic per-session ownership sequence (`chat:<id>` or `run:<id>`), incremented on every control change. */
  private controlSeqs = new Map<string, number>();
  private chatTurns = new Map<string, ActiveChatTurn>();
  private pendingWakeups = new Map<string, ChatControlEvent[]>();
  /** The goal's review invalidation epoch when a review-derived event was raised; a later epoch means the goal moved past it. */
  private eventReviewEpochs = new WeakMap<ChatControlEvent, number>();
  /** The review cycle a review-derived failure settlement was raised under; a later committed cycle supersedes it. */
  private eventReviewCycles = new WeakMap<ChatControlEvent, number>();
  private socketToChatId = new Map<Socket, string>();
  private chatSubscribers = new Set<Socket>();
  private tuiSockets = new Set<Socket>();
  private ptyDetachFns = new Map<Socket, Map<string, () => void>>();
  private watches = new Map<Socket, Map<string, ClientWatch>>();
  private flushingPeers = new Set<string>();
  private pendingFlushPeers = new Set<string>();
  private flushRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsubEvents: (() => void) | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private idleShutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private configWatcher: FSWatcher | null = null;
  private configReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private lastConfigRaw = "";
  /** Repository overlay snapshotted at startup; reloads layer `config.json` beneath it. */
  private readonly repoOverlay: Record<string, unknown>;
  /** Misplaced keys in the startup repo overlay; fixed for the daemon lifetime. */
  private readonly repoConfigWarnings: string[];
  /** Misplaced keys in the `config.json` text the effective config was last built from. */
  private globalConfigWarnings: string[] = [];
  /** Without a repo root, the constructor config is the layer beneath `config.json` on reload. */
  private readonly reloadBase: HarnessConfig | undefined;
  private autoQuitWhenIdle = false;
  private hasCustomRunner = false;
  private startedAt = Date.now();
  private readonly getBootUptimeMs: () => number;

  constructor(
    public config: HarnessConfig,
    opts?: {
      dbPath?: string;
      customRunnerFactory?: CustomRunnerFactory;
      autoQuitWhenIdle?: boolean;
      hostName?: string;
      repoRoot?: string;
      overlayRoot?: string;
      reapChildrenOnStop?: boolean;
      recoveryStaggerMs?: number;
      disableReloadRpc?: boolean;
      onExit?: (code: number) => void;
      bootUptimeMs?: () => number;
    },
  ) {
    this.overlayRoot = opts?.overlayRoot ?? opts?.repoRoot;
    this.disableReloadRpc = Boolean(opts?.disableReloadRpc);
    this.onExit = opts?.onExit ?? ((code) => process.exit(code));
    this.getBootUptimeMs =
      opts?.bootUptimeMs ??
      (() => (isInProcessTestRunner() ? Date.now() - this.startedAt : process.uptime() * 1000));
    this.repoOverlay = readRepoConfig(opts?.repoRoot);
    this.repoConfigWarnings = formatMisplacedConfigWarnings(
      ".pi-harness.json",
      findMisplacedConfigKeys(this.repoOverlay, "repo"),
    );
    // Cloned because the orchestrator mutates the constructor config in place.
    this.reloadBase = opts?.repoRoot ? undefined : structuredClone(config);
    this.autoQuitWhenIdle = Boolean(opts?.autoQuitWhenIdle);
    this.hasCustomRunner = Boolean(opts?.customRunnerFactory);
    this.reapChildrenOnStop = Boolean(opts?.reapChildrenOnStop);
    this.recoveryStaggerMs = opts?.recoveryStaggerMs ?? (this.hasCustomRunner ? 0 : 300);
    const dbPath = opts?.dbPath ?? join(config.stateDir, "control-plane.sqlite");
    this.db = new ControlPlaneDb(dbPath);
    this.wakeups = new WakeupStore(this.db.db);
    this.nodeId = dbPath === ":memory:" ? `node-${randomBytes(6).toString("hex")}` : loadOrCreateNodeId(config.stateDir);
    this.quota = new QuotaClient(config.quotaEndpoint);
    this.catalog = new ModelCatalogCompiler(config, this.quota);
    this.orchestrator = new HarnessOrchestrator(this.db, config, this.catalog, this.quota, opts?.customRunnerFactory);
    this.orchestrator.setInstanceNonce(this.instanceNonce);
    this.director = new DirectorRuntime(this.db, config, this.catalog, this.quota, this.orchestrator, opts?.customRunnerFactory);
    this.orchestrator.setQuotaResumeGate((runId, opts) => this.director.admitQuotaResume(runId, opts));
    this.peers = new PeerManager(
      this.nodeId,
      DAEMON_PROTOCOL_REV,
      (op, params, peer) => this.dispatchPeerRequest(op, params, peer),
      (peer) => {
        void this.flushOutboxForPeer(peer);
      },
      opts?.hostName,
    );
    this.director.setWakeHandler((chatSessionId, event) => {
      this.scheduleDirectorWakeup(chatSessionId, event);
    });
    this.director.setPeerBridge({
      listRemotes: () => this.listRemoteStatuses(),
      listSessions: async (host) =>
        (await this.listFederatedSessions(null, { includeRemotes: true, host })).filter((s) => s.kind === "chat"),
      createSession: (input) => this.createSessionOnHost(input),
      sendMessage: (input) => this.sendSessionMessage(input),
      readSession: (input) => this.readSessionOnHost(input),
    });
    this.hotUpdate = new HotUpdateController({
      config: () => this.config.hotUpdate,
      startedAt: this.startedAt,
      self: currentRelease(),
      liveAgents: () => this.getHotUpdateLiveAgents(),
      liveWorkDescription: () => this.getLiveWorkSummary().description,
      enterDraining: () => this.enterQuiesce("draining"),
      steerTask: async (taskId, text) => {
        try {
          return await this.orchestrator.steerTaskDetailed(taskId, text);
        } catch {
          return null;
        }
      },
      steerChat: async (chatId, text) => {
        try {
          return await this.director.steerChat(chatId, text, { role: "system_notice" });
        } catch {
          return false;
        }
      },
      broadcast: (payload) => this.broadcastDaemonEvent("daemon.reload", payload),
      stopAndHandOver: (target) => this.stopAndHandOver(target),
      log: (line) => console.error(`[harnessd ${new Date().toISOString()}] ${line}`),
    });
  }

  private get storage(): StoragePaths {
    return storagePaths(this.config);
  }

  private runRef(run: RunRecord): RunRecord & RunRef {
    const chatSessionId = run.chatSessionId ?? this.db.getRunChatSessionId(run.id);
    return chatSessionId === run.chatSessionId ? run : { ...run, chatSessionId };
  }

  /**
   * Transitions the daemon into `draining` or `stopping` once: gates new work and Director wakes,
   * and suspends timers without cancelling pending rows. Idempotent.
   */
  enterQuiesce(phase: "draining" | "stopping"): void {
    if (this.lifecycle !== "stopping") {
      this.lifecycle = phase;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.orchestrator.beginQuiesce();
    this.wakesGated = true;
    this.db.timers.suspend();
  }

  /**
   * Event-driven wakeup for Tier 0 Director when a typed control-plane event fires
   * (e.g. `goal.settled`, `timer.fired`) — zero polling, zero string-prefix parsing.
   */
  private scheduleDirectorWakeup(chatSessionId: string, event: ChatControlEvent): void {
    // The Director caused this goal event itself (e.g. its own goal_accept); waking it would be a self-wake.
    if (isDirectorSourcedGoalEvent(event)) return;
    this.stampReviewEpoch(event);
    if (event.kind === "goal.reviewed" && this.isStaleQueuedEvent(event)) return;
    if (this.wakesGated) {
      const q = this.pendingWakeups.get(chatSessionId) ?? [];
      q.push(event);
      this.pendingWakeups.set(chatSessionId, q);
      return;
    }
    const activeTurn = this.chatTurns.get(chatSessionId);
    if (activeTurn) {
      // Queue background goal/timer/peer events until the active Director turn finishes instead of interrupting mid-turn!
      const q = this.pendingWakeups.get(chatSessionId) ?? [];
      q.push(event);
      this.pendingWakeups.set(chatSessionId, q);
      return;
    }
    void this.runDirectorWakeupTurn(chatSessionId, event);
  }

  /**
   * Starts the next wake turn from the queue. A goal lifecycle event at the head takes every queued goal lifecycle
   * event with it, coalesced into one turn; other events keep their order. Each queued event is delivered, dropped as
   * stale, or left queued exactly once.
   */
  private drainPendingWakeup(chatSessionId: string): void {
    if (this.wakesGated) return;
    if (this.chatTurns.has(chatSessionId)) return;
    const queued = this.pendingWakeups.get(chatSessionId);
    if (!queued || queued.length === 0) {
      this.pendingWakeups.delete(chatSessionId);
      return;
    }
    const q = queued.flatMap((e): ChatControlEvent[] => (e.kind === "goal.events_batch" ? e.events : [e]));
    const persist = (a: ChatControlEvent[]) => {
      if (a.length > 0) this.pendingWakeups.set(chatSessionId, a);
      else this.pendingWakeups.delete(chatSessionId);
    };
    const head = q[0]!;
    if (!isGoalLifecycleEvent(head)) {
      q.shift();
      persist(q);
      if (this.isStaleQueuedEvent(head)) return this.drainPendingWakeup(chatSessionId);
      void this.runDirectorWakeupTurn(chatSessionId, head);
      return;
    }
    const goalEvents = q.filter(isGoalLifecycleEvent);
    // The only place the remainder is written back.
    persist(q.filter((e) => !isGoalLifecycleEvent(e)));
    const live = coalesceGoalEvents(goalEvents.filter((e) => !this.isStaleQueuedEvent(e)));
    if (live.length === 0) return this.drainPendingWakeup(chatSessionId);
    void this.runDirectorWakeupTurn(chatSessionId, live.length === 1 ? live[0]! : { kind: "goal.events_batch", events: live });
  }

  /** Records the invalidation epoch a review-derived event was raised under, once, so later invalidations (incl. pause then resume) are detectable. */
  private stampReviewEpoch(event: ChatControlEvent): void {
    if (event.kind === "goal.events_batch") {
      for (const e of event.events) this.stampReviewEpoch(e);
      return;
    }
    if (
      event.kind === "goal.reviewed" ||
      (event.kind === "goal.settled" && (event.cause === "verification_error" || event.cause === "gates_failed"))
    ) {
      if (!this.eventReviewEpochs.has(event)) {
        this.eventReviewEpochs.set(event, this.director.getReviewInvalidationEpoch(event.goalId));
      }
      if (event.kind === "goal.settled" && !this.eventReviewCycles.has(event)) {
        const g = this.director.goals.getGoal(event.goalId);
        if (g) this.eventReviewCycles.set(event, g.reviewCycle);
      }
    }
  }

  private isReviewEpochStale(event: ChatControlEvent, goalId: string): boolean {
    const epoch = this.eventReviewEpochs.get(event);
    return epoch !== undefined && this.director.getReviewInvalidationEpoch(goalId) !== epoch;
  }

  /** The still-live part of a wake event after asynchronous preparation: a batch keeps its live members; null when nothing is left. */
  private revalidateWakeEvent(event: ChatControlEvent): ChatControlEvent | null {
    if (event.kind === "goal.events_batch") {
      const live = event.events.filter((e) => !this.isStaleQueuedEvent(e));
      if (live.length === 0) return null;
      return live.length === 1 ? live[0]! : { kind: "goal.events_batch", events: live };
    }
    return this.isStaleQueuedEvent(event) ? null : event;
  }

  /** A queued event the goal or run has since moved past, or one the Director caused itself. */
  private isStaleQueuedEvent(next: ChatControlEvent): boolean {
    // Drop stale queued `goal.settled` snapshots whose run has since been resumed/reactivated
    // or whose goal has already reached a newer terminal/reviewing state.
    if (next.kind === "goal.settled") {
      const curRun = this.db.getRun(next.runId);
      const curGoal = this.director.goals.getGoal(next.goalId);
      if (curRun?.status === "active") return true;
      // A review failure of a goal the user has since paused is not reported, as when it is raised (notifyAutoVerifyFailure).
      if (curGoal?.status === "paused" && (next.cause === "verification_error" || next.cause === "gates_failed")) return true;
      if ((next.cause === "verification_error" || next.cause === "gates_failed") && this.isReviewEpochStale(next, next.goalId)) return true;
      if (next.cause === "verification_error" || next.cause === "gates_failed") {
        const recordedCycle = this.eventReviewCycles.get(next);
        if (curGoal && recordedCycle !== undefined && curGoal.reviewCycle !== recordedCycle) return true;
      }
      if (curGoal && ["achieved", "cancelled", "reviewing", "verifying"].includes(curGoal.status)) return true;
      // An amended goal produces its own events; a settlement of the older version is stale.
      if (curGoal && curGoal.version !== next.goalVersion) return true;
    } else if (next.kind === "goal.escalated") {
      // Escalations are raised on live runs too, so an active run never drops them; only a disposed one does.
      if (this.db.getEscalation(next.escalationId)?.status !== "open") return true;
      const curGoal = this.director.goals.getGoal(next.goalId);
      if (curGoal && ["achieved", "cancelled"].includes(curGoal.status)) return true;
    }
    if (isDirectorSourcedGoalEvent(next)) return true;
    // Drop queued review notices the goal has since moved past: amended, paused, cancelled, re-reviewed, accepted, or resumed.
    if (next.kind === "goal.reviewed") {
      const curGoal = this.director.goals.getGoal(next.goalId);
      if (!curGoal || isReviewInvalidated(curGoal, next) || curGoal.status !== next.status) return true;
      if (this.isReviewEpochStale(next, next.goalId)) return true;
    }
    return false;
  }

  private async runDirectorWakeupTurn(chatSessionId: string, event: ChatControlEvent): Promise<void> {
    if (this.wakesGated) {
      const q = this.pendingWakeups.get(chatSessionId) ?? [];
      q.push(event);
      this.pendingWakeups.set(chatSessionId, q);
      return;
    }
    if (this.chatTurns.has(chatSessionId)) {
      const q = this.pendingWakeups.get(chatSessionId) ?? [];
      q.push(event);
      this.pendingWakeups.set(chatSessionId, q);
      return;
    }
    if (!this.director.chats.getSession(chatSessionId)) return;
    this.stampReviewEpoch(event);
    const liveEvent = this.revalidateWakeEvent(event);
    if (!liveEvent) {
      this.drainPendingWakeup(chatSessionId);
      return;
    }
    event = liveEvent;
    const id = `wake-${randomBytes(4).toString("hex")}`;
    const turn = createActiveChatTurn(id);
    this.chatTurns.set(chatSessionId, turn);
    this.sendChatEvent(chatSessionId, id, "chat.turn.start", {
      reason: event.kind,
      event,
      summary: formatChatEventSummary(event),
    });
    try {
      const result = await this.director.sendChatMessage(
        chatSessionId,
        "",
        (delta) => {
          if (turn.detached || this.dbClosed) return;
          turn.text += delta;
          this.sendChatEvent(chatSessionId, id, "chat.delta", { delta });
        },
        (tool) => {
          if (turn.detached || this.dbClosed) return;
          trackTurnTool(turn, tool);
          this.sendChatEvent(chatSessionId, id, "chat.tool", tool);
        },
        { event, revalidateEvent: (ev) => this.revalidateWakeEvent(ev) },
      );
      if (!turn.detached && !this.dbClosed) {
        this.sendChatEvent(chatSessionId, id, "chat.turn.end", {
          assistantTurn: result.assistantTurn,
          cancelled: turn.cancelling,
        });
        if (event.kind === "session.message_received") {
          this.db.sessionMessages.markWakeStatus(event.messageId, "done");
        }
      }
    } catch (err) {
      if (!turn.detached && !this.dbClosed) {
        if (err instanceof StaleWakeEventError) {
          this.sendChatEvent(chatSessionId, id, "chat.turn.end", {
            assistantTurn: null,
            cancelled: turn.cancelling,
          });
        } else {
          this.sendChatEvent(chatSessionId, id, "chat.turn.end", {
            error: err instanceof Error ? err.message : String(err),
            cancelled: turn.cancelling,
          });
        }
      }
    } finally {
      if (this.chatTurns.get(chatSessionId) === turn) {
        this.chatTurns.delete(chatSessionId);
      }
      turn.isSettled = true;
      turn.markSettled();
      if (!turn.detached && !this.dbClosed) {
        this.drainPendingWakeup(chatSessionId);
      }
    }
  }

  private async runContinuationTurn(chatSessionId: string, text: string, opts?: { bypassGate?: boolean }): Promise<void> {
    if ((!opts?.bypassGate && this.wakesGated) || this.chatTurns.has(chatSessionId)) return;
    if (!this.director.chats.getSession(chatSessionId)) return;
    const id = `continue-${randomBytes(4).toString("hex")}`;
    const turn = createActiveChatTurn(id);
    this.chatTurns.set(chatSessionId, turn);
    this.sendChatEvent(chatSessionId, id, "chat.turn.start", {
      reason: "daemon.restart",
      summary: "Continuing after daemon restart",
    });
    try {
      const result = await this.director.sendChatMessage(
        chatSessionId,
        text,
        (delta) => {
          if (turn.detached || this.dbClosed) return;
          turn.text += delta;
          this.sendChatEvent(chatSessionId, id, "chat.delta", { delta });
        },
        (tool) => {
          if (turn.detached || this.dbClosed) return;
          trackTurnTool(turn, tool);
          this.sendChatEvent(chatSessionId, id, "chat.tool", tool);
        },
        { turnRole: "system_notice" },
      );
      if (!turn.detached && !this.dbClosed) {
        this.sendChatEvent(chatSessionId, id, "chat.turn.end", {
          assistantTurn: result.assistantTurn,
          cancelled: turn.cancelling,
        });
      }
    } catch (err) {
      if (!turn.detached && !this.dbClosed) {
        this.sendChatEvent(chatSessionId, id, "chat.turn.end", {
          error: err instanceof Error ? err.message : String(err),
          cancelled: turn.cancelling,
        });
      }
    } finally {
      if (this.chatTurns.get(chatSessionId) === turn) {
        this.chatTurns.delete(chatSessionId);
      }
      turn.isSettled = true;
      turn.markSettled();
      if (!turn.detached && !this.dbClosed) {
        this.drainPendingWakeup(chatSessionId);
      }
    }
  }

  /** Points default profiles that are unset, unknown, or disabled at the first enabled profile, when one exists. */
  private normalizeDefaultProfiles(config: HarnessConfig): HarnessConfig {
    const enabledIds = (Array.isArray(config.profiles) ? config.profiles : [])
      .filter(
        (p): p is RunnerProfileConfig =>
          Boolean(p) &&
          typeof p === "object" &&
          typeof (p as { id?: unknown }).id === "string" &&
          (p as { id: string }).id.length > 0 &&
          p.enabled !== false,
      )
      .map((p) => p.id);
    const fallback = enabledIds[0];
    if (!fallback) return config;
    let next = config;
    for (const key of ["defaultOrchestratorProfile", "defaultWorkerProfile", "defaultTaskProfile"] as const) {
      const id = next[key];
      if (!id || !enabledIds.includes(id)) next = { ...next, [key]: fallback };
    }
    return next;
  }

  private applyConfigMutation(
    next: HarnessConfig,
    opts?: { profilesChanged?: boolean; skipSave?: boolean },
  ): HarnessConfig {
    // Keep default profile pointers valid if a profile was removed or disabled
    next = this.normalizeDefaultProfiles(next);

    const prevEndpoint = JSON.stringify(this.config.quotaEndpoint ?? null);
    const nextEndpoint = JSON.stringify(next.quotaEndpoint ?? null);
    const prevRemotes = JSON.stringify(this.config.remotes ?? []);
    const nextRemotes = JSON.stringify(next.remotes ?? []);
    const prevExternalMcp = JSON.stringify(this.config.externalMcpServers ?? []);
    const nextExternalMcp = JSON.stringify(next.externalMcpServers ?? []);
    this.config = next;
    if (prevEndpoint !== nextEndpoint) {
      this.quota = new QuotaClient(next.quotaEndpoint);
    }
    this.catalog = new ModelCatalogCompiler(next, this.quota);
    // Live-propagate into Orchestrator (WorktreeManagers + MergeQueues + worker queue wakeup) and Director (GoalEngine + goal queue drain)
    this.orchestrator.updateConfig(next, this.catalog, this.quota);
    this.director.updateConfig(next, this.catalog, this.quota);
    if (prevRemotes !== nextRemotes) {
      this.peers.syncRemotes(next.remotes ?? []);
    }
    if (!this.hasCustomRunner && prevExternalMcp !== nextExternalMcp && shouldStageOctofs(next.externalMcpServers)) {
      void ensureOctofs(next.stateDir).catch(() => {});
    }

    if (!opts?.skipSave) this.persistConfig();

    if (opts?.profilesChanged) {
      this.catalog.invalidateCache();
      // Warm up the newly enabled/changed CLI catalog in the background immediately
      void this.catalog.sync(process.cwd()).catch(() => {});
    }
    return next;
  }

  /** Saves the effective config and records the written text so the watcher ignores the daemon's own write. */
  private persistConfig(): void {
    const serialized = serializeGlobalConfig(this.config);
    saveGlobalConfig(this.config);
    this.lastConfigRaw = serialized;
    this.setGlobalConfigWarnings(JSON.parse(serialized), false);
  }

  /** Stores the misplaced-key warnings for a parsed `config.json`; logs them when announced or changed. */
  private setGlobalConfigWarnings(parsed: unknown, announce: boolean): void {
    const next = formatMisplacedConfigWarnings("config.json", findMisplacedConfigKeys(parsed, "global"));
    const changed = !stableEqual(this.globalConfigWarnings, next);
    this.globalConfigWarnings = next;
    if (next.length > 0 && (announce || changed)) {
      for (const w of next) console.error(`[harnessd ${new Date().toISOString()}] config warning: ${w}`);
    } else if (next.length === 0 && changed) {
      console.error(
        `[harnessd ${new Date().toISOString()}] config warnings cleared: ${join(this.config.stateDir, "config.json")}`,
      );
    }
  }

  /**
   * Rebuilds the config from `config.json` + the startup repo overlay (or the constructor config) and applies it.
   * Missing, empty, or unchanged files are ignored; invalid files are rejected and the previous settings kept.
   */
  private reloadConfigFromDisk(): void {
    const cfgFile = join(this.config.stateDir, "config.json");
    let raw: string;
    try {
      raw = readFileSync(cfgFile, "utf8");
    } catch {
      return;
    }
    if (!raw.trim() || raw === this.lastConfigRaw) return;
    this.lastConfigRaw = raw;
    let parsed: unknown;
    let errors: string[];
    try {
      parsed = JSON.parse(raw);
      errors = validateConfigRaw(parsed);
    } catch {
      // Never log the parser message: it can quote fragments of the file, which may hold credentials.
      errors = ["Invalid JSON syntax"];
    }
    if (errors.length > 0) {
      console.error(
        `[harnessd ${new Date().toISOString()}] config reload rejected ${cfgFile} (keeping previous settings): ${errors.join("; ")}`,
      );
      return;
    }
    // Snapshot: until the first mutation, this.config is the object the orchestrator updates in place.
    const prev = structuredClone(this.config);
    const next = this.normalizeDefaultProfiles(
      resolveConfig(
        parsed as Record<string, unknown>,
        this.repoOverlay,
        { stateDir: prev.stateDir, socketPath: prev.socketPath },
        this.reloadBase,
      ),
    );
    if (diffHarnessConfig(prev, next).length > 0) {
      const applied = this.applyConfigMutation(next, {
        profilesChanged: !stableEqual(next.profiles, prev.profiles),
        skipSave: true,
      });
      const changes = diffHarnessConfig(prev, applied);
      if (changes.length > 0) {
        console.error(`[harnessd ${new Date().toISOString()}] config reload applied ${cfgFile} changes=${JSON.stringify(changes)}`);
      }
    }
    this.setGlobalConfigWarnings(parsed, true);
  }

  private stopConfigWatcher(): void {
    if (this.configReloadTimer) {
      clearTimeout(this.configReloadTimer);
      this.configReloadTimer = null;
    }
    if (this.configWatcher) {
      try {
        this.configWatcher.close();
      } catch {
        // ignore
      }
      this.configWatcher = null;
    }
  }

  /** Watches `<stateDir>/config.json` so edits on disk apply live without restarting `harnessd`. */
  private startConfigWatcher(): void {
    const stateDir = this.config.stateDir;
    const cfgFile = join(stateDir, "config.json");
    try {
      mkdirSync(stateDir, { recursive: true });
      if (existsSync(cfgFile)) {
        this.lastConfigRaw = readFileSync(cfgFile, "utf8");
      }
    } catch {
      return;
    }
    if (this.lastConfigRaw.trim()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.lastConfigRaw);
      } catch {
        // Invalid JSON yields no warnings; the next valid edit goes through the reload path.
      }
      this.setGlobalConfigWarnings(parsed, true);
    }

    try {
      this.configWatcher = watch(stateDir, (_eventType, filename) => {
        if (filename && filename !== "config.json") return;
        if (this.configReloadTimer) clearTimeout(this.configReloadTimer);
        this.configReloadTimer = setTimeout(() => {
          this.configReloadTimer = null;
          this.reloadConfigFromDisk();
        }, 120);
        this.configReloadTimer.unref?.();
      });
      this.configWatcher.on("error", (err) => {
        console.error(
          `[harnessd ${new Date().toISOString()}] config watcher stopped for ${cfgFile}: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.stopConfigWatcher();
      });
      this.configWatcher.unref?.();
    } catch {
      // ignore unsupported fs.watch environments
    }
  }

  async start(): Promise<string> {
    // Keep TimerManager suspended until Phase B finishes so early triggers (child_settled/any)
    // cannot consume pending rows before their held owners are relaunched.
    this.db.timers.suspendForStartup();
    await this.ptyHost.init();
    const sockPath = this.config.socketPath;
    mkdirSync(dirname(sockPath), { recursive: true, mode: 0o700 });
    const startLock = await acquireStartLock(dirname(sockPath));
    try {
      if (existsSync(sockPath)) {
        const sockState = await probeUnixSocketState(sockPath);
        if (sockState === "live") {
          throw new Error(`Refusing to start harnessd: another live daemon is already listening on ${sockPath}`);
        }
        if (sockState === "unknown") {
          throw new Error(`Refusing to unlink ${sockPath}: socket liveness could not be confirmed (timed out or inaccessible)`);
        }
        try {
          unlinkSync(sockPath);
        } catch {
          // ignore stale socket removal error
        }
      }

      this.unsubEvents = this.db.onEvent((ev) => this.fanoutEvent(ev));

      this.server = createServer((socket) => this.handleConnection(socket));
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(sockPath, () => {
          try {
            chmodSync(sockPath, 0o600);
          } catch {
            // ignore on unsupported filesystems
          }
          try {
            this.boundSocketIno = statSync(sockPath).ino;
          } catch {
            this.boundSocketIno = null;
          }
          resolve();
        });
      });
    } finally {
      startLock.release();
    }

    // Run one synchronous budgeted migration pass before reconcileStaleRunsOnStartup so
    // previously-live tasks still look live in the DB and their units stay safely deferred.
    try {
      const storage = this.storage;
      const startPass = computeStartPassBudget({
        uptimeMs: this.getBootUptimeMs(),
        env: process.env,
      });
      if (storage.layout !== "legacy" && startPass.skip) {
        console.error(
          `[harnessd ${new Date().toISOString()}] storage migration skipped: uptimeMs=${Math.round(startPass.uptimeMs)} bootWindowMs=${startPass.bootTimeoutMs} remainingWindowMs=${Math.round(startPass.remainingWindowMs)} (below ${MIN_START_PASS_BUDGET_MS}ms minimum; will retry at next start)`,
        );
      } else {
        const report = runStorageMigrationPass(
          {
            sqlite: this.db.db,
            storage,
            log: (line) => {
              if (storage.layout !== "legacy") {
                console.error(`[harnessd ${new Date().toISOString()}] ${line}`);
              }
            },
          },
          startPass.skip ? undefined : { budgetMs: startPass.budgetMs },
        );
        const t = report.totals;
        const moved = t.migrated + t.merged + t.finished;
        const removedEmptyDirs = report.repos.reduce((n, r) => n + r.removedEmptyDirs.length, 0);
        const isNoop =
          report.skipped ||
          (moved === 0 &&
            t.rowsRewritten === 0 &&
            t.bridgesRemoved === 0 &&
            t.deferred === 0 &&
            t.remaining === 0 &&
            t.newUnknownEntries === 0 &&
            t.errors === 0 &&
            removedEmptyDirs === 0 &&
            !report.budgetExceeded);
        if (!isNoop) {
          const parts = [
            `moved=${moved}`,
            `deferred=${t.deferred}`,
            `errors=${t.errors}`,
            `budgetHit=${report.budgetExceeded}`,
          ];
          if (t.rowsRewritten > 0) parts.push(`rowsRewritten=${t.rowsRewritten}`);
          if (t.bridgesRemoved > 0) parts.push(`bridgesRemoved=${t.bridgesRemoved}`);
          if (t.remaining > 0) parts.push(`remaining=${t.remaining}`);
          if (t.newUnknownEntries > 0) parts.push(`newUnknown=${t.newUnknownEntries}`);
          if (removedEmptyDirs > 0) parts.push(`removedEmptyDirs=${removedEmptyDirs}`);
          parts.push(`elapsedMs=${report.elapsedMs}`);
          console.error(`[harnessd ${new Date().toISOString()}] storage migration: ${parts.join(" ")}`);
        }
      }
    } catch (err) {
      console.error(
        `[harnessd ${new Date().toISOString()}] storage migration failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Reconcile stale runs/goals AFTER the daemon socket is bound,
    // so immediate wakeups / MCP bridges can connect without racing socket creation!
    const interruptedReviewGoals = listInterruptedReviewGoals(this.db.db);
    const legacyStopAtRaw = Number(process.env.PI_HARNESS_LEGACY_STOP_AT);
    delete process.env.PI_HARNESS_LEGACY_STOP_AT;
    const legacyStopAt = Number.isFinite(legacyStopAtRaw) && legacyStopAtRaw > 0 ? legacyStopAtRaw : undefined;
    const reloadFrom = process.env.PI_HARNESS_RELOAD_FROM;
    delete process.env.PI_HARNESS_RELOAD_FROM;
    this.reloadFrom = reloadFrom && reloadFrom.trim() ? reloadFrom.trim() : undefined;
    const reloadFailedRaw = process.env.PI_HARNESS_RELOAD_FAILED;
    delete process.env.PI_HARNESS_RELOAD_FAILED;
    delete process.env.PI_HARNESS_OVERLAY_ROOT;
    if (reloadFailedRaw) {
      try {
        const parsed = JSON.parse(reloadFailedRaw) as { targetReleaseId?: unknown; error?: unknown };
        if (typeof parsed?.targetReleaseId === "string" && typeof parsed?.error === "string") {
          this.reloadLastError = { targetReleaseId: parsed.targetReleaseId, error: parsed.error };
        }
      } catch {
        // Ignore malformed reload-failed payload
      }
    }
    const heldTaskIds = this.orchestrator.reconcileStaleRunsOnStartup(
      legacyStopAt !== undefined ? { legacyStopAt } : undefined,
    );
    this.director.goals.reconcileStaleGoalsOnStartup();
    try {
      // Escalations left open on runs whose goals all settled (achieved/cancelled) are resolved once at startup.
      this.db.reconcileSettledGoalEscalations();
    } catch {
      // Best effort; the escalations stay listable and resolvable.
    }
    // Register saved continuation turns synchronously before ungating wakes and before any RPC runs (A1).
    const savedWakeups = this.wakeups.takeAll();
    const chatsToDrain = new Set<string>();
    for (const row of savedWakeups) {
      if (row.kind !== "continue") continue;
      if (!this.director.chats.getSession(row.chatSessionId)) continue;
      const p = (row.payload ?? {}) as {
        tools?: TrackedTurnTool[];
        tasks?: Array<{ id: string; title: string; status: string }>;
      };
      const text = formatContinuationTurnPrompt(
        Array.isArray(p.tools) ? p.tools : [],
        Array.isArray(p.tasks) ? p.tasks : [],
      );
      void this.runContinuationTurn(row.chatSessionId, text, { bypassGate: true });
    }
    for (const row of savedWakeups) {
      if (row.kind !== "event" || !row.payload || typeof row.payload !== "object") continue;
      if (!this.director.chats.getSession(row.chatSessionId)) continue;
      const q = this.pendingWakeups.get(row.chatSessionId) ?? [];
      q.push(row.payload as ChatControlEvent);
      this.pendingWakeups.set(row.chatSessionId, q);
      chatsToDrain.add(row.chatSessionId);
    }

    replayInterruptedReviews(
      this.db,
      {
        getGoal: (id) => this.director.goals.getGoal(id),
        setGoalExecuting: (id) => this.director.goals.setStatus(id, "executing"),
        startReview: (goalId, opts) => this.director.verifyAndReviewGoal(goalId, undefined, opts),
        queueFallbackWake: (goal, runId, runStatus, detail) => {
          if (!goal.chatSessionId || this.lifecycle !== "serving" || this.dbClosed) return;
          this.scheduleDirectorWakeup(goal.chatSessionId, {
            kind: "goal.settled",
            goalId: goal.id,
            goalVersion: goal.version,
            goalTitle: goal.title,
            runId,
            runStatus,
            openEscalations: this.db.listEscalations(runId, "unresolved").length,
            detail: `Goal review was interrupted by daemon restart (${detail})`,
            cause: "verification_error",
          });
        },
        isStopping: () => this.lifecycle !== "serving" || this.dbClosed,
      },
      interruptedReviewGoals,
    );

    if (this.lifecycle === "serving") {
      this.wakesGated = false;
      for (const chatId of new Set([...chatsToDrain, ...this.pendingWakeups.keys()])) {
        if (!this.chatTurns.has(chatId)) this.drainPendingWakeup(chatId);
      }
    }

    // Non-blocking startup orphan worktree sweep + periodic hourly sweep across known repos
    if (this.lifecycle === "serving") {
      this.startRepoSweep();
      this.sweepTimer = setInterval(() => {
        if (this.lifecycle !== "serving") {
          if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = null;
          }
          return;
        }
        this.startRepoSweep();
      }, 3_600_000);
      this.sweepTimer.unref();
    }

    // Non-blocking initial quota sync (endpoint if configured + passive local CLI harvest)
    try {
      this.quota.harvestLocal(this.config.profiles, { force: true });
    } catch {
      // ignore local harvest errors on startup
    }
    void this.quota.sync(false).catch(() => {});

    // Non-blocking background staging of native `octofs` MCP binary on real (non-test) daemons
    if (!this.hasCustomRunner && shouldStageOctofs(this.config.externalMcpServers)) {
      void ensureOctofs(this.config.stateDir).catch(() => {});
    }

    // Start auto-connect peer links for any configured remote hosts
    this.peers.syncRemotes(this.config.remotes ?? []);

    // Live-watch `<stateDir>/config.json` so external edits apply immediately without restart
    this.startConfigWatcher();
    for (const w of this.repoConfigWarnings) {
      console.error(`[harnessd ${new Date().toISOString()}] config warning: ${w}`);
    }

    this.recovered = this.finishRecovery(heldTaskIds, reloadFrom).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.recoveryDegraded = {
        failedTaskIds: this.recoveryDegraded?.failedTaskIds ?? [],
        errors: [...(this.recoveryDegraded?.errors ?? []), msg],
      };
      console.error(`[harnessd ${new Date().toISOString()}] recovery: degraded (${msg})`);
      if (this.lifecycle === "serving" && !this.dbClosed) {
        try {
          this.db.timers.restorePending();
        } catch {
          // best effort
        }
      }
    });

    return sockPath;
  }

  private async finishRecovery(heldTaskIds: string[], reloadFrom?: string): Promise<void> {
    if (this.lifecycle !== "serving" || this.dbClosed) return;
    let phaseBError: string | null = null;
    if (heldTaskIds.length > 0) {
      const reason = reloadFrom
        ? `update to release ${currentRelease().releaseId}`
        : "daemon restart";
      try {
        await this.orchestrator.recoverInterruptedTasks(heldTaskIds, reason, this.recoveryStaggerMs);
      } catch (err) {
        phaseBError = err instanceof Error ? err.message : String(err);
      }
    }
    if (this.lifecycle !== "serving" || this.dbClosed) return;

    const failures = heldTaskIds.length > 0 ? getLastRecoveryFailures(this.db) : [];
    if (failures.length > 0 || phaseBError) {
      const failedTaskIds = failures.map((f) => f.id);
      const errors = [
        ...failures.map((f) => `${f.id}: ${f.error}`),
        ...(phaseBError ? [phaseBError] : []),
      ];
      this.recoveryDegraded = { failedTaskIds, errors };
      const detail = [
        failedTaskIds.length > 0 ? `failed tasks: ${failedTaskIds.join(", ")}` : null,
        phaseBError ? `phase B error: ${phaseBError}` : null,
      ]
        .filter(Boolean)
        .join("; ");
      console.error(`[harnessd ${new Date().toISOString()}] recovery: degraded (${detail})`);
    }

    try {
      this.db.timers.restorePending();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[harnessd ${new Date().toISOString()}] recovery: failed to restore pending timers: ${msg}`);
    }

    if (this.lifecycle !== "serving" || this.dbClosed) return;

    // Recover any durable inbound peer wakeups that were persisted before a crash/restart
    for (const pending of this.db.sessionMessages.listPendingInboundWakes()) {
      if (this.lifecycle !== "serving" || this.dbClosed) return;
      if (!this.director.chats.getSession(pending.toSessionId)) {
        this.db.sessionMessages.markWakeStatus(pending.id, "done");
        continue;
      }
      this.scheduleDirectorWakeup(pending.toSessionId, {
        kind: "session.message_received",
        messageId: pending.id,
        fromHost: pending.fromHost,
        fromSessionId: pending.fromSessionId,
        fromProjectName: pending.fromProjectName,
        body: pending.body,
        expectReply: pending.expectReply,
        hopCount: pending.hopCount,
      });
    }
  }

  private getHotUpdateLiveAgents(): { tier12: string[]; other: string[]; chats: string[]; reviews: number } {
    const tier12: string[] = [];
    const other: string[] = [];
    for (const id of this.orchestrator.executingTaskIds()) {
      const task = this.db.getTask(id);
      // Tier 1/2 tasks still in `ready` are waiting on admission/lease/routing (not running a session yet)
      // and cannot answer request_rollover. Keep them in `other` so rate-limiting still counts them as live.
      if (task && (task.tier === 1 || task.tier === 2) && task.status !== "ready") {
        tier12.push(id);
      } else {
        other.push(id);
      }
    }
    return {
      tier12,
      other,
      chats: [...this.chatTurns.keys()],
      reviews: this.director.activeReviewCount(),
    };
  }

  private getReloadStatus(): ReloadStatus {
    const base = this.hotUpdate.status();
    return {
      ...base,
      ...(this.reloadFrom ? { previousReleaseId: this.reloadFrom } : {}),
      ...(this.reloadLastError ? { lastError: this.reloadLastError } : {}),
    };
  }

  /**
   * Single exit owner for daemon.shutdown, SIGTERM/SIGINT, and idle auto-quit (A11).
   * If a hot-update handover is already in progress, awaits handover so the supervisor
   * is always spawned before process exit.
   */
  async shutdownAndExit(opts?: { reason?: string }): Promise<void> {
    if (this.handoverPromise) {
      await this.handoverPromise;
      return;
    }
    try {
      await this.stop(opts);
    } finally {
      if (this.handoverPromise) {
        await this.handoverPromise;
      } else {
        this.onExit(0);
      }
    }
  }

  stopAndHandOver(target: ReleaseTarget): Promise<void> {
    return (this.handoverPromise ??= this.stopAndHandOverInner(target));
  }

  private async stopAndHandOverInner(target: ReleaseTarget): Promise<void> {
    this.restartExpected = true;
    const self = currentRelease();
    if (this.reapChildrenOnStop) {
      for (const pgid of listChildProcessGroups(process.pid)) {
        this.capturedStopChildPgids.add(pgid);
      }
    }
    let cwd = this.config.stateDir;
    try {
      const currentCwd = process.cwd();
      if (existsSync(currentCwd)) cwd = currentCwd;
    } catch {
      // fall back to stateDir when cwd was removed
    }
    let supervisorSpawned = false;
    const spawnOnce = () => {
      if (supervisorSpawned) return;
      supervisorSpawned = true;
      if (this.reapChildrenOnStop) {
        for (const pgid of listChildProcessGroups(process.pid)) {
          this.capturedStopChildPgids.add(pgid);
        }
      }
      const fallbackFilePath = join(dirname(this.config.socketPath), "reload-fallback.txt");
      try {
        if (existsSync(fallbackFilePath)) unlinkSync(fallbackFilePath);
      } catch {
        // ignore stale fallback cleanup error
      }
      const childPgids = [...this.capturedStopChildPgids];
      console.error(`[harnessd ${new Date().toISOString()}] reload: spawning supervisor for ${target.releaseId}`);
      spawnSupervisorDetached(
        self,
        {
          socketPath: this.config.socketPath,
          stateDir: this.config.stateDir,
          target,
          previous: self,
          previousRestartSafe: true,
          waitPid: process.pid,
          ...(childPgids.length > 0 ? { childPgids } : {}),
          overlayRoot: this.overlayRoot,
          fromReleaseId: self.releaseId,
        },
        cwd,
      );
    };

    const watchdog = setTimeout(() => {
      console.error(`[harnessd ${new Date().toISOString()}] reload: stop watchdog (45s) expired; forcing supervisor handover`);
      spawnOnce();
      this.onExit(1);
    }, 45_000);
    watchdog.unref?.();

    try {
      await this.stop({ reason: `reload:${target.releaseId}` });
    } catch (err) {
      console.error(
        `[harnessd ${new Date().toISOString()}] reload: stop error during handover: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(watchdog);
      spawnOnce();
    }
    this.onExit(0);
  }

  stop(opts?: { reason?: string }): Promise<void> {
    return (this.stopPromise ??= this.stopInner(opts));
  }

  private async stopInner(_opts?: { reason?: string }): Promise<void> {
    this.enterQuiesce("stopping");
    this.hotUpdate.dispose();
    if (this.reapChildrenOnStop) {
      for (const pgid of listChildProcessGroups(process.pid)) {
        this.capturedStopChildPgids.add(pgid);
      }
    }
    let recTimer: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      this.recovered.catch(() => {}),
      new Promise<void>((r) => {
        recTimer = setTimeout(r, 5000);
        recTimer.unref?.();
      }),
    ]);
    if (recTimer) clearTimeout(recTimer);
    if (this.activeSweep) {
      let sweepWaitTimer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        this.activeSweep.catch(() => {}),
        new Promise<void>((r) => {
          sweepWaitTimer = setTimeout(r, 1000);
          sweepWaitTimer.unref?.();
        }),
      ]);
      if (sweepWaitTimer) clearTimeout(sweepWaitTimer);
    }
    if (this.reapChildrenOnStop) {
      for (const pgid of listChildProcessGroups(process.pid)) {
        this.capturedStopChildPgids.add(pgid);
      }
    }
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.stopConfigWatcher();
    for (const t of this.flushRetryTimers.values()) clearTimeout(t);
    this.flushRetryTimers.clear();
    this.flushingPeers.clear();
    this.pendingFlushPeers.clear();
    this.peers.dispose();

    const activeChats = [...this.chatTurns.entries()];
    if (activeChats.length > 0) {
      for (const [, turn] of activeChats) {
        turn.cancelling = true;
      }
      let chatTimer: ReturnType<typeof setTimeout> | null = null;
      await Promise.race([
        Promise.allSettled(
          activeChats.map(async ([chatId, turn]) => {
            await this.director.cancelChat(chatId).catch(() => {});
            await turn.settled;
          }),
        ),
        new Promise<void>((r) => {
          chatTimer = setTimeout(r, 5000);
          chatTimer.unref?.();
        }),
      ]);
      if (chatTimer) clearTimeout(chatTimer);

      // Detach any stragglers still active at the shared deadline so late callbacks cannot touch the DB.
      for (const [chatId, turn] of activeChats) {
        if (!turn.isSettled) {
          this.sendChatEvent(chatId, turn.id, "chat.turn.end", {
            assistantTurn: null,
            cancelled: true,
          });
          turn.detached = true;
          if (this.chatTurns.get(chatId) === turn) {
            this.chatTurns.delete(chatId);
          }
        }
      }
    }

    const continueRows: PendingWake[] = [];
    for (const [chatId, turn] of activeChats) {
      const tools = [...turn.tools.values()];
      const tasks: Array<{ id: string; title: string; status: string }> = [];
      for (const run of this.orchestrator.listDirectorTaskRuns(chatId)) {
        for (const t of this.db.listTasks(run.id)) {
          if (t.profileId !== "director" && t.createdAt >= turn.startedAt) {
            tasks.push({ id: t.id, title: t.title, status: t.status });
          }
        }
      }
      try {
        this.director.chats.appendTurn(chatId, "system_notice", formatInterruptedTurnNotice(tools, tasks));
      } catch {
        // ignore if session disappeared
      }
      continueRows.push({
        chatSessionId: chatId,
        kind: "continue",
        payload: { tools, tasks },
      });
    }

    await this.orchestrator.shutdownAndWait(10_000);
    this.director.dispose();
    this.unsubEvents?.();
    this.ptyHost.closeAll();

    // Snapshot pending wakeups after orchestrator/director unwind so late-queued wakes are not lost (A2).
    const wakeupSnapshot: PendingWake[] = [...continueRows];
    for (const [chatId, events] of this.pendingWakeups.entries()) {
      for (const ev of events) {
        const flat = ev.kind === "goal.events_batch" ? ev.events : [ev];
        for (const item of flat) {
          if (item.kind === "session.message_received") continue;
          wakeupSnapshot.push({ chatSessionId: chatId, kind: "event", payload: item });
        }
      }
    }
    try {
      this.wakeups.append(wakeupSnapshot);
      this.pendingWakeups.clear();
    } catch (err) {
      console.error(
        `[harnessd ${new Date().toISOString()}] stop: failed to persist ${wakeupSnapshot.length} pending wakeup(s): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (this.reapChildrenOnStop) {
      await reapChildProcessGroups(process.pid, 2000, this.capturedStopChildPgids);
    }

    this.broadcastDaemonEvent("daemon.stopping", { restart: this.restartExpected });

    // Close the listener BEFORE snapshotting sockets so reconnecting TUIs cannot be accepted
    // after the snapshot and hang server.close() indefinitely.
    const srv = this.server;
    this.server = null;
    const serverClosePromise = srv
      ? new Promise<void>((resolve) => {
          try {
            srv.close(() => resolve());
          } catch {
            resolve();
          }
        })
      : null;

    const openSockets = [...this.allSockets].filter((s) => !s.destroyed);
    if (openSockets.length > 0) {
      await new Promise<void>((resolve) => {
        let remaining = openSockets.length;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          for (const s of openSockets) {
            if (!s.destroyed) s.destroy();
          }
          done();
        }, 200);
        timer.unref?.();
        for (const s of openSockets) {
          s.once("close", () => {
            remaining--;
            if (remaining <= 0) done();
          });
          try {
            s.end();
          } catch {
            s.destroy();
          }
        }
      });
    }
    // Destroy any socket still tracked in allSockets so server.close() always settles.
    for (const s of this.allSockets) {
      if (!s.destroyed) s.destroy();
    }
    this.allSockets.clear();
    this.attachments.clear();
    this.chatBindings.clear();
    this.runBindings.clear();
    this.controlSeqs.clear();
    this.socketToChatId.clear();
    this.chatSubscribers.clear();
    this.tuiSockets.clear();
    this.watches.clear();
    if (serverClosePromise) {
      await Promise.race([serverClosePromise, new Promise<void>((r) => setTimeout(r, 1000))]);
    }
    if (this.boundSocketIno !== null && existsSync(this.config.socketPath)) {
      try {
        if (statSync(this.config.socketPath).ino === this.boundSocketIno) {
          unlinkSync(this.config.socketPath);
        }
      } catch {
        // ignore
      }
    }
    this.boundSocketIno = null;
    this.dbClosed = true;
    this.db.close();
  }

  private broadcastDaemonEvent(type: string, payload: Record<string, unknown>): void {
    const frame: DaemonEventFrame = {
      kind: "event",
      seq: 0,
      runId: "",
      taskId: null,
      type,
      payload,
      createdAt: Date.now(),
    };
    for (const sock of this.tuiSockets) {
      if (!sock.destroyed) writeDaemonMessage(sock, frame);
    }
  }

  private startRepoSweep(): void {
    if (this.lifecycle !== "serving" || this.dbClosed || this.activeSweep) return;
    const p = this.sweepAllKnownRepos()
      .catch(() => {})
      .finally(() => {
        if (this.activeSweep === p) this.activeSweep = null;
      });
    this.activeSweep = p;
  }

  private async sweepAllKnownRepos(): Promise<void> {
    if (this.lifecycle !== "serving" || this.dbClosed) return;
    const repos = new Set(this.db.listRuns(100).map((r) => canonicalPath(r.repoRoot)));
    for (const repo of repos) {
      if (this.lifecycle !== "serving" || this.dbClosed) return;
      try {
        await this.orchestrator.getWorktreeManager(repo).sweep();
      } catch {
        // One missing or failing repo must not stop the sweep of the others.
      }
    }
  }

  private getRunIdsForChatSession(chatSessionId: string): string[] {
    const ids = new Set<string>();
    for (const g of this.director.goals.listGoals({ chatSessionId })) {
      if (g.linkedRunId) ids.add(g.linkedRunId);
    }
    for (const run of this.orchestrator.listDirectorTaskRuns(chatSessionId)) ids.add(run.id);
    return [...ids];
  }

  private getChatSessionIdForRun(runId: string): string | null {
    if (isDirectorTaskContainer(runId)) return directorTaskRunOwner(runId);
    const row = this.db.db
      .prepare("SELECT chat_session_id FROM goals WHERE linked_run_id = ? AND chat_session_id IS NOT NULL ORDER BY updated_at DESC LIMIT 1")
      .get(runId) as { chat_session_id?: string | null } | undefined;
    return row?.chat_session_id ? String(row.chat_session_id) : null;
  }

  private assembleWorkSnapshotScope(scope: { chatSessionId?: string; repoRoot?: string; runId?: string }) {
    const { chatSessionId, repoRoot, runId: filterRunId } = scope;
    const goals = this.director.goals.listGoals({ repoRoot, chatSessionId }).map(reconcileGoalWithLiveRun);
    const goalByRunId = new Map(goals.filter((g) => g.linkedRunId).map((g) => [g.linkedRunId!, g]));
    const runIds = filterRunId
      ? [filterRunId]
      : chatSessionId
        ? this.getRunIdsForChatSession(chatSessionId)
        : this.db
            .listRuns(500)
            .filter((r) => !repoRoot || r.repoRoot === repoRoot)
            .slice(0, 50)
            .map((r) => r.id);
    const runEntries = runIds
      .map((id) => this.db.getRun(id))
      .filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((raw) => {
        // Read-only projection: derive the status in memory; never persist it from a snapshot.
        const tasks = this.db.listTasks(raw.id);
        const status = deriveRunStatus(raw, tasks, this.orchestrator.isRunActiveInMemory(raw.id));
        const run = status === raw.status ? raw : { ...raw, status };
        const escalations = this.db.listEscalations(run.id);
        const lead = tasks.find((t) => t.tier === 1 && t.profileId !== "director");
        return {
          run,
          goalId: goalByRunId.get(run.id)?.id ?? null,
          tasks,
          escalations,
          // The lead thread's plan and the requests still open between it, the Director, and the user.
          leadPlan: lead ? this.db.threads.getPlan(lead.id) : null,
          requests: this.db.threads.listRequests({ runId: run.id, status: "open", limit: 50 }),
          quotaPause: this.orchestrator.getRunQuotaStatus(run.id),
          activity: buildRunActivitySummary(this.db, run.id),
        };
      });
    const merges = this.db.listMergeQueue({ runIds, limit: 100 });
    const messages = runIds.flatMap((id) => this.db.listMessagesForRun(id, 50));
    const dismissals = this.db.listInboxDismissals();
    const { inbox, internalAttention } = classifyAttention({
      goals,
      runs: runEntries,
      merges,
      messages,
      dismissals,
    });
    return { goals, runIds, runEntries, merges, messages, inbox, internalAttention };
  }

  private fanoutEvent(ev: EventRecord): void {
    const frame: DaemonEventFrame = {
      kind: "event",
      seq: ev.seq,
      runId: ev.runId,
      taskId: ev.taskId,
      type: ev.type,
      payload: ev.payload,
      createdAt: ev.createdAt,
    };
    for (const att of this.attachments.values()) {
      if (att.runId !== ev.runId) continue;
      if (att.taskId && ev.taskId && att.taskId !== ev.taskId) continue;
      if (att.next) att.pendingSeq = ev.seq;
      else writeDaemonMessage(att.socket, frame);
    }
    const owningChatId = this.getChatSessionIdForRun(ev.runId);
    if (
      ev.type.startsWith("goal.") ||
      ev.type.startsWith("escalation.") ||
      ev.type.startsWith("merge.") ||
      ev.type.startsWith("timer.") ||
      ev.type.startsWith("thread.") ||
      ev.type === "run.status" ||
      ev.type === "run.created" ||
      ev.type === "task.created" ||
      ev.type === "task.status" ||
      ev.type === "task.resumed" ||
      ev.type === "worktree.created" ||
      ev.type === "worktree.removed" ||
      ev.type === "quota.agent_paused" ||
      ev.type === "quota.agent_retrying" ||
      ev.type === "quota.run_paused" ||
      ev.type === "quota.run_scheduled" ||
      ev.type === "quota.run_resumed" ||
      ev.type === "agent.timer_sleep" ||
      ev.type === "agent.rollover"
    ) {
      const evRepoRoot = this.db.getRun(ev.runId)?.repoRoot ?? null;
      for (const sock of this.chatSubscribers) {
        if (this.attachments.has(sock)) continue;
        const boundChatId = this.socketToChatId.get(sock);
        if (owningChatId && boundChatId && owningChatId !== boundChatId) continue;
        if (!owningChatId && boundChatId && evRepoRoot) {
          const boundRepo = this.director.chats.getSession(boundChatId)?.repoRoot;
          if (boundRepo && boundRepo !== evRepoRoot) {
            const norm = (p: string) => {
              try {
                return realpathSync(p);
              } catch {
                return p;
              }
            };
            if (norm(boundRepo) !== norm(evRepoRoot)) continue;
          }
        }
        writeDaemonMessage(sock, frame);
      }
    }
    for (const [sock, map] of this.watches) {
      for (const w of map.values()) {
        if (ev.seq <= w.lastSeq) continue;
        if (w.scope === "runs") {
          if (!isRunsWatchEvent(ev.type)) continue;
          if (w.runIds && !w.runIds.has(ev.runId)) continue;
          if (w.chatSessionId && owningChatId !== w.chatSessionId) continue;
        } else if (w.scope === "run") {
          if (ev.runId !== w.runId) continue;
        } else if (ev.runId !== w.runId || ev.taskId !== w.taskId) {
          continue;
        }
        if (w.next) {
          w.pendingSeq = ev.seq;
          continue;
        }
        w.lastSeq = ev.seq;
        const watchFrame: DaemonEventFrame = { ...frame, watchId: w.id };
        if (w.buffer) w.buffer.push(watchFrame);
        else writeDaemonMessage(sock, watchFrame);
      }
    }
  }

  private startWatch(socket: Socket, p: Record<string, unknown>): unknown {
    const id = `watch-${randomBytes(4).toString("hex")}`;
    let watch: ClientWatch;
    let result: Record<string, unknown>;
    if (p.scope === "runs") {
      const lastSeq = this.db.getLatestEventSeq();
      const chatSessionId = typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : undefined;
      const runIds = Array.isArray(p.runIds) ? new Set((p.runIds as unknown[]).map((x) => String(x))) : undefined;
      watch = { id, scope: "runs", chatSessionId, runIds, throughSeq: lastSeq, lastSeq, buffer: [] };
      result = { watchId: id, replay: [], lastSeq };
    } else if (p.scope === "run") {
      const runId = String(p.runId);
      const sinceSeq = typeof p.sinceSeq === "number" ? p.sinceSeq : 0;
      const lastSeq = Math.max(sinceSeq, this.db.getLatestEventSeq());
      const page = this.db.getReplayPage(runId, null, { sinceSeq, payloadOffset: 0 }, lastSeq);
      watch = { id, scope: "run", runId, taskId: null, throughSeq: lastSeq, lastSeq, next: page.next, buffer: [] };
      result = {
        watchId: id,
        ...page,
        lastSeq,
        run: this.db.getRun(runId) ?? undefined,
      };
    } else if (p.scope === "task") {
      const runId = String(p.runId);
      const taskId = String(p.taskId);
      const sinceSeq = typeof p.sinceSeq === "number" ? p.sinceSeq : 0;
      const lastSeq = Math.max(sinceSeq, this.db.getLatestEventSeq());
      const page = this.db.getReplayPage(runId, taskId, { sinceSeq, payloadOffset: 0 }, lastSeq);
      watch = { id, scope: "task", runId, taskId, throughSeq: lastSeq, lastSeq, next: page.next, buffer: [] };
      result = {
        watchId: id,
        ...page,
        lastSeq,
        run: this.db.getRun(runId) ?? undefined,
        task: this.db.getTask(taskId) ?? undefined,
      };
    } else {
      throw new Error(`Unknown watch scope: ${String(p.scope)}`);
    }
    let map = this.watches.get(socket);
    if (!map) {
      map = new Map();
      this.watches.set(socket, map);
    }
    map.set(id, watch);
    // Live events emitted before the RPC response is written are buffered, then flushed after it,
    // so the client always sees the replay first and every live frame exactly once.
    setImmediate(() => {
      const buffered = watch.buffer ?? [];
      watch.buffer = null;
      if (this.watches.get(socket)?.get(id) !== watch) return;
      for (const f of buffered) writeDaemonMessage(socket, f);
    });
    return result;
  }

  private cancelIdleShutdown(): void {
    if (this.idleShutdownTimer) {
      clearTimeout(this.idleShutdownTimer);
      this.idleShutdownTimer = null;
    }
  }

  private getLiveWorkSummary(): {
    running: boolean;
    activeChats: number;
    activeTasks: number;
    scheduledQuotaResumes: number;
    pendingTimers: number;
    pendingWakeups: number;
    queuedPeerMessages: number;
    activeReviews: number;
    activePtys: number;
    otherTuiClients: number;
    description: string;
  } {
    const activeChats = this.director.activeChatCount();
    const activeTasks = this.orchestrator.activeTaskCount();
    const scheduledQuotaResumes = this.orchestrator.scheduledQuotaResumeCount();
    const pendingTimers = this.db.timers.list({ status: "pending" }).length;
    const pendingWakeups = [...this.pendingWakeups.values()].reduce((sum, q) => sum + q.length, 0);
    this.db.sessionMessages.expireStaleOutbound(OUTBOX_TTL_MS);
    const knownPeers = this.peers.getKnownPeerSets();
    const queuedPeerMessages = this.db.sessionMessages.countQueuedOutboundForKnownPeers(knownPeers.hosts, knownPeers.nodes);
    const activeReviews = this.director.activeReviewCount();
    const activePtys = this.ptyHost.activePtyCount();
    const otherTuiClients = this.tuiSockets.size;
    const parts: string[] = [];
    if (activeTasks > 0) parts.push(`${activeTasks} active agent task${activeTasks === 1 ? "" : "s"}`);
    if (scheduledQuotaResumes > 0) parts.push(`${scheduledQuotaResumes} scheduled quota resume${scheduledQuotaResumes === 1 ? "" : "s"}`);
    if (pendingTimers > 0) parts.push(`${pendingTimers} pending timer${pendingTimers === 1 ? "" : "s"}`);
    if (pendingWakeups > 0) parts.push(`${pendingWakeups} pending wakeup${pendingWakeups === 1 ? "" : "s"}`);
    if (queuedPeerMessages > 0) parts.push(`${queuedPeerMessages} queued peer message${queuedPeerMessages === 1 ? "" : "s"}`);
    if (activeChats > 0) parts.push(`${activeChats} in-flight chat${activeChats === 1 ? "" : "s"}`);
    if (activeReviews > 0) parts.push(`${activeReviews} goal review${activeReviews === 1 ? "" : "s"}`);
    if (activePtys > 0) parts.push(`${activePtys} open shell${activePtys === 1 ? "" : "s"}`);
    if (otherTuiClients > 0) parts.push(`${otherTuiClients} other attached terminal${otherTuiClients === 1 ? "" : "s"}`);
    const running =
      activeChats +
        activeTasks +
        scheduledQuotaResumes +
        pendingTimers +
        pendingWakeups +
        queuedPeerMessages +
        activeReviews +
        activePtys +
        otherTuiClients >
      0;
    return {
      running,
      activeChats,
      activeTasks,
      scheduledQuotaResumes,
      pendingTimers,
      pendingWakeups,
      queuedPeerMessages,
      activeReviews,
      activePtys,
      otherTuiClients,
      description: parts.join(", "),
    };
  }

  private resolveChatSessionId(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    try {
      return this.director.chats.getSession(trimmed)?.id ?? trimmed;
    } catch {
      return trimmed;
    }
  }

  private resolveRunId(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return trimmed;
    try {
      return this.db.getRun(trimmed)?.id ?? trimmed;
    } catch {
      return trimmed;
    }
  }

  private controlKey(kind: "chat" | "run", sessionId: string): string {
    return `${kind}:${sessionId}`;
  }

  private bumpControlSeq(kind: "chat" | "run", sessionId: string): number {
    const key = this.controlKey(kind, sessionId);
    const next = (this.controlSeqs.get(key) ?? 0) + 1;
    this.controlSeqs.set(key, next);
    return next;
  }

  private currentControlSeq(kind: "chat" | "run", sessionId: string): number {
    return this.controlSeqs.get(this.controlKey(kind, sessionId)) ?? 0;
  }

  private clientId(socket: Socket): string {
    let id = this.clientIds.get(socket);
    if (!id) {
      id = `cli-${randomBytes(4).toString("hex")}`;
      this.clientIds.set(socket, id);
    }
    return id;
  }

  private chatViewers(chatSessionId: string): Socket[] {
    const out: Socket[] = [];
    for (const [sock, cid] of this.socketToChatId.entries()) {
      if (cid === chatSessionId) out.push(sock);
    }
    return out;
  }

  private runViewers(runId: string): Socket[] {
    const out: Socket[] = [];
    for (const att of this.attachments.values()) {
      if (att.runId === runId) out.push(att.socket);
    }
    return out;
  }

  private controlState(socket: Socket, kind: "chat" | "run", sessionId: string): SessionControlState {
    const id = kind === "chat" ? this.resolveChatSessionId(sessionId) : this.resolveRunId(sessionId);
    const myId = this.clientId(socket);
    const controller = kind === "chat" ? this.chatBindings.get(id) : this.runBindings.get(id);
    return {
      sessionId: id,
      kind,
      clientId: myId,
      controllerClientId: controller ? this.clientId(controller) : null,
      hasControl: controller === socket,
      controlSeq: this.currentControlSeq(kind, id),
    };
  }

  private broadcastControl(
    kind: "chat" | "run",
    sessionId: string,
    reason: SessionControlReason,
    except?: Socket,
  ): void {
    const id = kind === "chat" ? this.resolveChatSessionId(sessionId) : this.resolveRunId(sessionId);
    const controller = kind === "chat" ? this.chatBindings.get(id) : this.runBindings.get(id);
    const payload: SessionControlPayload = {
      sessionId: id,
      kind,
      controllerClientId: controller ? this.clientId(controller) : null,
      reason,
      controlSeq: this.currentControlSeq(kind, id),
    };
    const frame: DaemonEventFrame = {
      kind: "event",
      seq: 0,
      runId: id,
      taskId: id,
      type: "session.control_changed",
      payload,
      createdAt: Date.now(),
    };
    const viewers = kind === "chat" ? this.chatViewers(id) : this.runViewers(id);
    for (const viewer of viewers) {
      if (viewer !== except) writeDaemonMessage(viewer, frame);
    }
  }

  private requireChatControlIfViewer(socket: Socket, chatSessionId: string): void {
    const id = this.resolveChatSessionId(chatSessionId);
    if (this.socketToChatId.get(socket) === id && this.chatBindings.get(id) !== socket) {
      throw new Error(SESSION_READ_ONLY_ERROR);
    }
  }

  private requireRunControlIfViewer(socket: Socket, runId: string): void {
    const id = this.resolveRunId(runId);
    if (this.attachments.get(socket)?.runId === id && this.runBindings.get(id) !== socket) {
      throw new Error(SESSION_READ_ONLY_ERROR);
    }
  }

  private unbindSocketSession(socket: Socket, reason: "released" | "disconnected" = "released"): void {
    const oldChat = this.socketToChatId.get(socket);
    if (oldChat) {
      this.socketToChatId.delete(socket);
      if (this.chatBindings.get(oldChat) === socket) {
        this.chatBindings.delete(oldChat);
        this.bumpControlSeq("chat", oldChat);
        this.broadcastControl("chat", oldChat, reason);
      }
    }
    const oldAtt = this.attachments.get(socket);
    if (oldAtt) {
      this.attachments.delete(socket);
      if (this.runBindings.get(oldAtt.runId) === socket) {
        this.runBindings.delete(oldAtt.runId);
        this.bumpControlSeq("run", oldAtt.runId);
        this.broadcastControl("run", oldAtt.runId, reason);
      }
    }
  }

  private requireChatOwner(socket: Socket, chatSessionId: string): void {
    const id = this.resolveChatSessionId(chatSessionId);
    if (this.chatBindings.get(id) !== socket) throw new Error(SESSION_READ_ONLY_ERROR);
  }

  private chatHistoryThrough(chatSessionId: string): number {
    const row = this.db.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS historyThrough FROM chat_turns WHERE chat_session_id = ?")
      .get(chatSessionId) as { historyThrough: number };
    return row.historyThrough;
  }

  private sendChatEvent(
    chatSessionId: string,
    turnId: string,
    type: string,
    payload: Record<string, unknown>,
    except?: Socket,
  ): void {
    if (this.dbClosed) return;
    if (this.chatTurns.get(chatSessionId)?.id !== turnId) return;
    const viewers = this.chatViewers(chatSessionId);
    if (viewers.length === 0) return;
    const extra = type === "chat.turn.end" ? { historyThrough: this.chatHistoryThrough(chatSessionId) } : {};
    const frame: DaemonEventFrame = {
      kind: "event",
      seq: 0,
      runId: chatSessionId,
      taskId: chatSessionId,
      type,
      payload: { ...payload, ...extra, chatSessionId, turnId },
      createdAt: Date.now(),
    };
    for (const target of viewers) {
      if (target !== except) writeDaemonMessage(target, frame);
    }
  }

  private chatHistoryPage(chatSessionId: string, afterSeq: number, historyThrough: number) {
    const sizes = this.db.db.prepare(`
      SELECT seq, length(CAST(content AS BLOB)) + coalesce(length(CAST(display_json AS BLOB)), 0) AS bytes
      FROM chat_turns WHERE chat_session_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT 100
    `).all(chatSessionId, afterSeq, historyThrough) as { seq: number; bytes: number }[];
    let bytes = 0;
    let count = 0;
    for (const row of sizes) {
      if (count && bytes + row.bytes > 512 * 1024) break;
      bytes += row.bytes;
      count++;
    }
    const history = this.director.chats.getHistory(chatSessionId, afterSeq, count);
    const last = history.at(-1)?.seq ?? historyThrough;
    return { history, historyNext: last < historyThrough ? last : null, historyThrough };
  }

  private bindChatSocket(
    socket: Socket,
    chatSessionId: string,
    control: SessionAttachControl = "take",
  ): { tookOver: boolean } {
    if (socket.destroyed) throw new Error("Chat connection closed");
    const id = this.resolveChatSessionId(chatSessionId);
    this.cancelIdleShutdown();
    const curChat = this.socketToChatId.get(socket);
    if (curChat !== id) {
      this.unbindSocketSession(socket);
    }
    const prev = this.chatBindings.get(id);
    let tookOver = false;
    if (control === "take") {
      tookOver = Boolean(prev && prev !== socket);
      this.chatBindings.set(id, socket);
    }
    this.socketToChatId.set(socket, id);
    this.chatSubscribers.add(socket);
    this.tuiSockets.add(socket);
    if (control === "take") {
      this.director.chats.touchSession(id);
      if (prev !== socket) {
        this.bumpControlSeq("chat", id);
        this.broadcastControl("chat", id, "attached", socket);
      }
    }
    return { tookOver };
  }

  private bindRunSocket(
    socket: Socket,
    runId: string,
    taskId: string | null,
    control: SessionAttachControl = "take",
  ): { tookOver: boolean } {
    if (socket.destroyed) throw new Error("Run connection closed");
    const id = this.resolveRunId(runId);
    this.cancelIdleShutdown();
    const curAtt = this.attachments.get(socket);
    if (!curAtt || curAtt.runId !== id) {
      this.unbindSocketSession(socket);
    }
    const prev = this.runBindings.get(id);
    let tookOver = false;
    if (control === "take") {
      tookOver = Boolean(prev && prev !== socket);
      this.runBindings.set(id, socket);
    }
    const boundAtSeq = this.db.getLatestEventSeq();
    this.attachments.set(socket, { id: randomBytes(8).toString("hex"), boundAtSeq, throughSeq: boundAtSeq, socket, runId: id, taskId });
    this.tuiSockets.add(socket);
    if (control === "take" && prev !== socket) {
      this.bumpControlSeq("run", id);
      this.broadcastControl("run", id, "attached", socket);
    }
    return { tookOver };
  }

  private handleConnection(socket: Socket): void {
    if (this.lifecycle === "stopping") {
      socket.destroy();
      return;
    }
    this.allSockets.add(socket);
    this.clientIds.set(socket, `cli-${randomBytes(4).toString("hex")}`);
    this.cancelIdleShutdown();
    const detach = attachDaemonReader(socket, {
      onMessage: (raw) => {
        // Once upgraded via `peer.hello`, a socket is strictly a peer link:
        //  - `res` frames complete our outbound reverse requests on that link
        //  - `req` frames ONLY execute through the strict positive-allowlist `dispatchPeerRequest`
        const inboundPeer = this.peers.getInboundLinkForSocket(socket);
        if (inboundPeer) {
          const kind = (raw as { kind?: string })?.kind;
          if (kind === "res") {
            inboundPeer.handleWireFrame(raw);
            return;
          }
          if (kind === "req") {
            const req = raw as RpcRequest;
            void this.dispatchPeerRequest(req.op, req.params ?? {}, inboundPeer).then(
              (result) => writeDaemonMessage(socket, { kind: "res", id: req.id, ok: true, result } satisfies RpcResponse),
              (err) =>
                writeDaemonMessage(socket, {
                  kind: "res",
                  id: req.id,
                  ok: false,
                  error: err instanceof Error ? err.message : String(err),
                } satisfies RpcResponse),
            );
          }
          return;
        }
        const req = raw as RpcRequest;
        if (req?.kind !== "req") return;
        void this.dispatch(socket, req).then(
          (result) => writeDaemonMessage(socket, { kind: "res", id: req.id, ok: true, result } satisfies RpcResponse),
          (err) =>
            writeDaemonMessage(socket, {
              kind: "res",
              id: req.id,
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            } satisfies RpcResponse),
        );
      },
      onEnd: () => this.cleanupSocket(socket),
      onError: () => this.cleanupSocket(socket),
    });

    socket.once("close", () => {
      detach();
      this.cleanupSocket(socket);
    });
  }

  private cleanupSocket(socket: Socket): void {
    this.allSockets.delete(socket);
    const wasTui = this.tuiSockets.delete(socket);
    this.unbindSocketSession(socket, "disconnected");
    this.chatSubscribers.delete(socket);
    this.watches.delete(socket);
    const ptyMap = this.ptyDetachFns.get(socket);
    if (ptyMap) {
      for (const fn of ptyMap.values()) fn();
      this.ptyDetachFns.delete(socket);
    }

    // If the last interactive TUI disconnected abruptly (e.g. terminal window closed) and nothing is running, quit cleanly
    if (this.autoQuitWhenIdle && wasTui && this.lifecycle === "serving") {
      const work = this.getLiveWorkSummary();
      if (!work.running) {
        this.cancelIdleShutdown();
        this.idleShutdownTimer = setTimeout(() => {
          this.idleShutdownTimer = null;
          if (this.lifecycle === "serving" && !this.getLiveWorkSummary().running) {
            void this.shutdownAndExit({ reason: "idle_disconnect" });
          }
        }, 1200);
        this.idleShutdownTimer.unref();
      }
    }
  }

  private listRemoteStatuses(): RemoteHostStatus[] {
    return this.peers.listStatuses(this.db.sessionMessages.queuedCountsByHost());
  }

  private isLocalHostTarget(host: string | null | undefined): boolean {
    if (!host) return true;
    const h = host.trim();
    if (!h || h.toLowerCase() === "local" || h === this.nodeId) return true;
    // Only match localHostName if no configured, live, or previously observed remote peer uses that name
    if (
      h.toLowerCase() === this.peers.localHostName.toLowerCase() &&
      !this.peers.findLink(h) &&
      !this.peers.getRemoteConfig(h) &&
      !this.peers.getKnownNodeId(h)
    ) {
      return true;
    }
    return false;
  }

  private async listFederatedProjects(opts?: { includeRemotes?: boolean; host?: string }): Promise<Array<Record<string, unknown>>> {
    const requestedHost = opts?.host?.trim();
    if (requestedHost && !this.isLocalHostTarget(requestedHost)) {
      const remoteProjects = (await this.peers.callRemote<Array<Record<string, unknown>>>(
        requestedHost,
        "project.list",
        { includeRemotes: false },
        10_000,
      )) ?? [];
      const remoteNodeId = this.peers.findLink(requestedHost)?.remoteIdentity?.nodeId ?? this.peers.getKnownNodeId(requestedHost);
      return remoteProjects.map((pr) => ({ ...pr, host: requestedHost, nodeId: remoteNodeId ?? null }));
    }

    const local = (await this.db.projects.listProjects()).map((pr) => ({ ...pr, host: "local", nodeId: this.nodeId }));
    if (!opts?.includeRemotes || (requestedHost && this.isLocalHostTarget(requestedHost))) {
      return local;
    }

    const links = this.peers.connectedLinks();
    if (links.length === 0) return local;
    const settled = await Promise.allSettled(
      links.map(async (link) => {
        const items = (await link.request<Array<Record<string, unknown>>>("project.list", { includeRemotes: false }, 5_000)) ?? [];
        const hostName = link.alias;
        const nodeId = link.remoteIdentity?.nodeId ?? null;
        return items.map((pr) => ({ ...pr, host: hostName, nodeId }));
      }),
    );
    const out: Array<Record<string, unknown>> = [...local];
    for (const s of settled) {
      if (s.status === "fulfilled") out.push(...s.value);
    }
    return out;
  }

  private async listLocalSessions(socket: Socket | null) {
    const allProjects = await this.db.projects.listProjects();
    const projById = new Map(allProjects.map((pr) => [pr.id, pr]));
    const projByPath = new Map(allProjects.map((pr) => [pr.rootPath, pr]));
    const chats = this.director.chats.listSessions(25).map((c) => {
      const bound = this.chatBindings.get(c.id);
      const busy = this.director.isChatBusy(c.id);
      const activeGoals = this.director.goals
        .listGoals({ chatSessionId: c.id })
        .filter((g) => ["executing", "verifying", "reviewing"].includes(g.status)).length;
      const proj = (c.projectId ? projById.get(c.projectId) : undefined) ?? projByPath.get(c.repoRoot);
      return {
        id: c.id,
        host: "local",
        address: `local:${c.id}`,
        kind: "chat" as const,
        title: c.title,
        projectId: proj?.id ?? c.projectId ?? null,
        projectName: proj?.name ?? null,
        repoRoot: c.repoRoot,
        status: busy ? "busy" : activeGoals > 0 ? `${activeGoals} active goal${activeGoals === 1 ? "" : "s"}` : "idle",
        running: busy || activeGoals > 0,
        attached: Boolean(bound),
        attachedByMe: socket !== null && bound === socket,
        model: c.model ?? c.profileId,
        effort: c.effort,
        updatedAt: c.updatedAt,
      };
    });
    const runs = this.db.listRuns(20).map((raw) => {
      const r = this.orchestrator.getEffectiveRun(raw.id) ?? raw;
      const bound = this.runBindings.get(r.id);
      const live = this.orchestrator.isRunActiveInMemory(r.id);
      const quotaSt = this.orchestrator.getRunQuotaStatus(r.id);
      const proj = projByPath.get(r.repoRoot);
      return {
        id: r.id,
        host: "local",
        address: `local:${r.id}`,
        kind: "run" as const,
        title: (r.goal.split("\n")[0] ?? r.goal).slice(0, 80),
        projectId: proj?.id ?? null,
        projectName: proj?.name ?? null,
        repoRoot: r.repoRoot,
        status: live ? "running" : quotaSt ? (quotaSt.resumeAt ? "quota (timer)" : "paused_quota") : r.status,
        running: live || Boolean(quotaSt),
        attached: Boolean(bound),
        attachedByMe: socket !== null && bound === socket,
        model: null,
        effort: null,
        updatedAt: r.updatedAt,
      };
    });
    return [...chats, ...runs].sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt);
  }

  private async listFederatedSessions(
    socket: Socket | null,
    opts?: { includeRemotes?: boolean; host?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const requestedHost = opts?.host?.trim();
    if (requestedHost && !this.isLocalHostTarget(requestedHost)) {
      const remote = (await this.peers.callRemote<Array<Record<string, unknown>>>(
        requestedHost,
        "sessions.list",
        { includeRemotes: false },
        10_000,
      )) ?? [];
      const remoteNodeId = this.peers.findLink(requestedHost)?.remoteIdentity?.nodeId ?? this.peers.getKnownNodeId(requestedHost);
      return remote.map((s) => ({
        ...s,
        host: requestedHost,
        nodeId: remoteNodeId ?? null,
        address: `${requestedHost}:${String(s.id)}`,
        attachedByMe: false,
      }));
    }

    const local = (await this.listLocalSessions(socket)).map((s) => ({ ...s, nodeId: this.nodeId }));
    if (!opts?.includeRemotes || (requestedHost && this.isLocalHostTarget(requestedHost))) {
      return local;
    }

    const links = this.peers.connectedLinks();
    if (links.length === 0) return local;
    const settled = await Promise.allSettled(
      links.map(async (link) => {
        const items = (await link.request<Array<Record<string, unknown>>>("sessions.list", { includeRemotes: false }, 5_000)) ?? [];
        const hostName = link.alias;
        const nodeId = link.remoteIdentity?.nodeId ?? null;
        return items.map((s) => ({
          ...s,
          host: hostName,
          nodeId,
          address: `${hostName}:${String(s.id)}`,
          attachedByMe: false,
        }));
      }),
    );
    const out: Array<Record<string, unknown>> = [...local];
    for (const s of settled) {
      if (s.status === "fulfilled") out.push(...s.value);
    }
    return out.sort(
      (a, b) => Number(Boolean(b.running)) - Number(Boolean(a.running)) || Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0),
    );
  }

  private async createSessionOnHost(input: {
    host?: string;
    project?: string;
    title?: string;
    localFallbackRepoRoot?: string;
  }): Promise<Record<string, unknown>> {
    const targetHost = input.host?.trim();
    if (targetHost && !this.isLocalHostTarget(targetHost)) {
      const res = await this.peers.callRemote<{
        session: { id: string; repoRoot: string; title: string };
        project?: unknown;
        projectRegistered?: boolean;
      }>(
        targetHost,
        "chat.create",
        { projectId: input.project, title: input.title, headless: true },
        15_000,
      );
      return {
        host: targetHost,
        address: `${targetHost}:${res.session.id}`,
        session: res.session,
        project: res.project ?? null,
        ...(res.projectRegistered ? { projectRegistered: true } : {}),
      };
    }

    const explicitProject = input.project ? this.db.projects.resolveProject(input.project) : null;
    if (input.project && !explicitProject) {
      throw new Error(`Unknown project "${input.project}"`);
    }
    const created = await this.director.createChatDetailed({
      repoRoot: explicitProject?.rootPath ?? input.localFallbackRepoRoot ?? process.cwd(),
      projectId: explicitProject?.id ?? undefined,
      title: input.title,
    });
    const { session } = created;
    const { project: boundProject, registered } = this.ensureChatProject(session);
    return {
      host: "local",
      address: `local:${session.id}`,
      session,
      project: boundProject,
      ...(created.projectRegistered || registered ? { projectRegistered: true } : {}),
    };
  }

  /**
   * The chat's project, registering its path when the chat has none (e.g. its project was removed earlier).
   * `registered` is true only when this call inserted the project, which is then noted once in the chat.
   */
  private ensureChatProject(session: ChatSessionRecord): { project: ProjectRecord; registered: boolean } {
    const bound = session.projectId ? this.db.projects.getById(session.projectId) : null;
    if (bound) return { project: bound, registered: false };
    const { project, created } = this.db.projects.ensureProjectForPathWithStatus(session.repoRoot);
    if (created) this.director.noteProjectRegistered(session.id, project);
    return { project, registered: created };
  }

  private readLocalSession(sessionId: string, limit = 12): Record<string, unknown> {
    const bounded = Math.min(50, Math.max(1, limit));
    const session = this.director.chats.getSession(sessionId);
    if (!session) throw new Error(`Unknown chat session: ${sessionId}`);
    const project = session.projectId ? this.db.projects.getById(session.projectId) : null;
    const recentHistory = this.director.chats.getRecentHistory(session.id, bounded);
    const turns = recentHistory.map((t) => ({
      seq: t.seq,
      role: t.role,
      content: t.content,
      createdAt: t.createdAt,
    }));
    const messages = this.db.sessionMessages.listForSession(session.id, 20);
    return {
      host: "local",
      address: `local:${session.id}`,
      session: {
        id: session.id,
        title: session.title,
        projectId: session.projectId,
        projectName: project?.name ?? null,
        repoRoot: session.repoRoot,
        model: session.model ?? session.profileId,
        busy: this.director.isChatBusy(session.id),
      },
      turns,
      messages,
    };
  }

  private async readSessionOnHost(input: { target: string; limit?: number }): Promise<Record<string, unknown>> {
    const { host, sessionId } = parseSessionAddress(input.target);
    const limit = Math.min(50, Math.max(1, input.limit ?? 12));
    if (host && !this.isLocalHostTarget(host)) {
      const res = await this.peers.callRemote<Record<string, unknown>>(
        host,
        "session.read",
        { target: sessionId, limit },
        15_000,
      );
      const canonicalId = (res?.session as { id?: string } | undefined)?.id ?? sessionId;
      return { ...res, host, address: `${host}:${canonicalId}` };
    }
    return this.readLocalSession(sessionId, limit);
  }

  private lastUserTurnTimestamp(chatSessionId: string): number {
    const row = this.db.db
      .prepare("SELECT COALESCE(MAX(created_at), 0) AS ts FROM chat_turns WHERE chat_session_id = ? AND role = 'user'")
      .get(chatSessionId) as { ts: number } | undefined;
    return Number(row?.ts ?? 0);
  }

  private deliverLocalSessionMessage(input: {
    id: string;
    fromNode: string;
    fromHost: string;
    fromSessionId: string;
    fromProjectName?: string | null;
    toSessionId: string;
    body: string;
    replyToId?: string | null;
    expectReply?: boolean;
    hopCount?: number;
  }): { record: SessionMessageRecord; duplicate: boolean; woke: boolean; circuitBreakerTripped: boolean } {
    const targetSession = this.director.chats.getSession(input.toSessionId);
    if (!targetSession) {
      throw new Error(`Unknown target chat session "${input.toSessionId}" on host "${this.peers.localHostName}"`);
    }
    const toSessionId = targetSession.id;

    const { record, inserted } = this.db.sessionMessages.recordInbound({
      id: input.id,
      fromNode: input.fromNode,
      fromHost: input.fromHost,
      fromSessionId: input.fromSessionId,
      fromProjectName: input.fromProjectName ?? null,
      toNode: this.nodeId,
      toHost: this.peers.localHostName,
      toSessionId,
      body: input.body,
      replyToId: input.replyToId ?? null,
      expectReply: input.expectReply !== false,
      hopCount: input.hopCount ?? 1,
    });

    if (!inserted) {
      return { record, duplicate: true, woke: false, circuitBreakerTripped: false };
    }

    const sinceUser = this.lastUserTurnTimestamp(toSessionId);
    // Bound anti-loop window to 30m since last user turn so headless sessions without user turns aren't muted forever
    const hopWindowStart = Math.max(sinceUser, Date.now() - PEER_HOP_WINDOW_MS);
    const inboundInWindow = this.db.sessionMessages.countInboundSince(toSessionId, hopWindowStart);
    const hopCount = Math.max(record.hopCount, inboundInWindow);
    const circuitBreakerTripped = hopCount > MAX_PEER_MESSAGE_HOPS;

    // Emit live event to all attached TUI viewers so users immediately see peer traffic
    const viewers = this.chatViewers(toSessionId);
    if (viewers.length > 0) {
      const msgFrame: DaemonEventFrame = {
        kind: "event",
        seq: 0,
        runId: toSessionId,
        taskId: toSessionId,
        type: "session.message_received",
        payload: {
          messageId: record.id,
          fromHost: record.fromHost,
          fromSessionId: record.fromSessionId,
          fromProjectName: record.fromProjectName,
          toSessionId: record.toSessionId,
          body: record.body,
          expectReply: record.expectReply,
          hopCount,
          circuitBreakerTripped,
        },
        createdAt: Date.now(),
      };
      for (const viewer of viewers) writeDaemonMessage(viewer, msgFrame);
    }

    if (circuitBreakerTripped) {
      this.db.sessionMessages.markWakeStatus(record.id, "tripped");
      this.director.chats.appendTurn(
        toSessionId,
        "system_notice",
        `[PEER MESSAGE from ${record.fromHost}:${record.fromSessionId}] Auto-wakeup paused by anti-loop circuit breaker (${hopCount}/${MAX_PEER_MESSAGE_HOPS} consecutive peer hops without human input). Message: ${record.body}`,
      );
      return { record, duplicate: false, woke: false, circuitBreakerTripped: true };
    }

    const event: ChatControlEvent = {
      kind: "session.message_received",
      messageId: record.id,
      fromHost: record.fromHost,
      fromSessionId: record.fromSessionId,
      fromProjectName: record.fromProjectName,
      body: record.body,
      expectReply: record.expectReply,
      hopCount,
    };
    this.scheduleDirectorWakeup(toSessionId, event);
    return { record, duplicate: false, woke: true, circuitBreakerTripped: false };
  }

  private async sendSessionMessage(input: {
    fromSessionId: string;
    target: string;
    body: string;
    expectReply?: boolean;
    replyToId?: string;
  }): Promise<Record<string, unknown>> {
    const { host, sessionId: toSessionId } = parseSessionAddress(input.target);
    if (!toSessionId) throw new Error(`Invalid target session address: "${input.target}"`);

    const fromSess = this.director.chats.getSession(input.fromSessionId);
    const fromSessionId = fromSess?.id ?? input.fromSessionId;
    const fromProject = fromSess?.projectId ? this.db.projects.getById(fromSess.projectId) : null;
    const prevMsg = input.replyToId ? this.db.sessionMessages.getById(input.replyToId) : null;
    const hopCount = prevMsg ? prevMsg.hopCount + 1 : 1;

    // Unified local delivery (same host, same or different project)
    if (this.isLocalHostTarget(host)) {
      const id = `smsg-${randomUUID()}`;
      const delivered = this.deliverLocalSessionMessage({
        id,
        fromNode: this.nodeId,
        fromHost: "local",
        fromSessionId,
        fromProjectName: fromProject?.name ?? null,
        toSessionId,
        body: input.body,
        replyToId: input.replyToId ?? null,
        expectReply: input.expectReply !== false,
        hopCount,
      });
      return {
        messageId: delivered.record.id,
        target: `local:${delivered.record.toSessionId}`,
        status: "delivered",
        woke: delivered.woke,
        circuitBreakerTripped: delivered.circuitBreakerTripped,
      };
    }

    // Remote delivery: validate target host is a configured or previously observed peer so typos never pin auto-quit
    const targetHost = host!;
    const link = this.peers.findLink(targetHost);
    const resolvedToNode =
      link?.remoteIdentity?.nodeId ??
      this.peers.getKnownNodeId(targetHost) ??
      (prevMsg && prevMsg.fromHost.toLowerCase() === targetHost.toLowerCase() ? prevMsg.fromNode : null) ??
      this.db.sessionMessages.findKnownNodeForHost(targetHost);
    if (!link && !this.peers.isKnownPeer(targetHost) && !resolvedToNode) {
      throw new Error(`Unknown remote host "${targetHost}". Add it first with \`pi-harness remote add ${targetHost} <ssh-target>\` or /remotes.`);
    }

    const record = this.db.sessionMessages.enqueueOutbound({
      fromNode: this.nodeId,
      fromHost: this.peers.localHostName,
      fromSessionId,
      fromProjectName: fromProject?.name ?? null,
      toNode: resolvedToNode,
      toHost: targetHost,
      toSessionId,
      body: input.body,
      replyToId: input.replyToId ?? null,
      expectReply: input.expectReply !== false,
      hopCount,
    });

    if (!link) {
      return {
        messageId: record.id,
        target: `${targetHost}:${toSessionId}`,
        status: "queued",
        woke: false,
        note: `Remote host "${targetHost}" is offline; message queued durably and will auto-deliver on reconnect.`,
      };
    }

    try {
      const res = await link.request<{ record?: { toSessionId?: string }; woke?: boolean; circuitBreakerTripped?: boolean }>(
        "session.deliver_message",
        {
          id: record.id,
          fromNode: record.fromNode,
          fromHost: record.fromHost,
          fromSessionId: record.fromSessionId,
          fromProjectName: record.fromProjectName,
          toSessionId: record.toSessionId,
          body: record.body,
          replyToId: record.replyToId,
          expectReply: record.expectReply,
          hopCount: record.hopCount,
        },
        15_000,
      );
      this.db.sessionMessages.markDelivered(record.id);
      const deliveredTo = typeof res?.record?.toSessionId === "string" && res.record.toSessionId ? res.record.toSessionId : toSessionId;
      return {
        messageId: record.id,
        target: `${targetHost}:${deliveredTo}`,
        status: "delivered",
        woke: Boolean(res?.woke),
        circuitBreakerTripped: Boolean(res?.circuitBreakerTripped),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/Unknown target chat session|Conflicting session message envelope/i.test(msg)) {
        this.db.sessionMessages.markFailed(record.id, msg);
        throw new Error(msg);
      }
      // Schedule a bounded retry on the still-live peer link so transient timeouts never stall the outbox
      this.scheduleOutboxRetry(link);
      return {
        messageId: record.id,
        target: `${targetHost}:${toSessionId}`,
        status: "queued",
        woke: false,
        note: `Delivery deferred (${msg}); message remains queued and will retry automatically.`,
      };
    }
  }

  private scheduleOutboxRetry(peer: PeerLink, delayMs = 3_000): void {
    const key = peer.remoteIdentity?.nodeId ?? peer.alias.toLowerCase();
    if (this.flushRetryTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.flushRetryTimers.delete(key);
      if (peer.isOpen) void this.flushOutboxForPeer(peer);
    }, delayMs);
    timer.unref?.();
    this.flushRetryTimers.set(key, timer);
  }

  private async flushOutboxForPeer(peer: PeerLink): Promise<number> {
    const key = peer.remoteIdentity?.nodeId ?? peer.alias.toLowerCase();
    if (this.flushingPeers.has(key)) {
      this.pendingFlushPeers.add(key);
      return 0;
    }
    this.flushingPeers.add(key);
    let flushed = 0;
    try {
      do {
        this.pendingFlushPeers.delete(key);
        this.db.sessionMessages.expireStaleOutbound(OUTBOX_TTL_MS);
        const configuredAliases = new Set((this.config.remotes ?? []).map((r) => r.name.toLowerCase()));
        const queued = this.db.sessionMessages.listQueuedOutboundForPeer({
          alias: peer.alias,
          direction: peer.direction,
          hostName: peer.remoteIdentity?.hostName ?? null,
          nodeId: peer.remoteIdentity?.nodeId ?? null,
          configuredAliases,
        });
        let hadTransientFailure = false;
        for (const msg of queued) {
          if (!peer.isOpen) break;
          if (Date.now() - msg.createdAt > OUTBOX_TTL_MS) {
            this.db.sessionMessages.markFailed(msg.id, "Expired in outbox after delivery TTL");
            continue;
          }
          try {
            await peer.request(
              "session.deliver_message",
              {
                id: msg.id,
                fromNode: msg.fromNode,
                fromHost: msg.fromHost,
                fromSessionId: msg.fromSessionId,
                fromProjectName: msg.fromProjectName,
                toSessionId: msg.toSessionId,
                body: msg.body,
                replyToId: msg.replyToId,
                expectReply: msg.expectReply,
                hopCount: msg.hopCount,
              },
              15_000,
            );
            this.db.sessionMessages.markDelivered(msg.id);
            flushed++;
          } catch (err) {
            const text = err instanceof Error ? err.message : String(err);
            if (/Unknown target chat session|Conflicting session message envelope/i.test(text)) {
              this.db.sessionMessages.markFailed(msg.id, text);
            } else {
              hadTransientFailure = true;
              continue; // Don't let one transient timeout permanently block unrelated messages; retry shortly
            }
          }
        }
        if (hadTransientFailure && peer.isOpen) {
          this.scheduleOutboxRetry(peer);
        }
      } while (this.pendingFlushPeers.has(key) && peer.isOpen);
    } finally {
      this.flushingPeers.delete(key);
      if (this.pendingFlushPeers.has(key)) {
        const replacement = this.peers.findLink(key);
        if (replacement && replacement.isOpen) {
          setImmediate(() => void this.flushOutboxForPeer(replacement));
        }
      }
    }
    return flushed;
  }

  /**
   * Strict positive-allowlist local-only handler for ALL peer-originated RPCs (both inbound sockets
   * after `peer.hello` and reverse RPCs over outbound links). Never forwards to a third host, enforces
   * reverse capability policy (`reverseAccess: "messages"` default vs `"full"`), and always derives
   * sender identity from the authenticated `PeerLink`.
   */
  private async dispatchPeerRequest(op: DaemonOp, p: Record<string, unknown>, peer: PeerLink): Promise<unknown> {
    if (!PEER_ALLOWED_OPS.has(op)) {
      throw new Error(`RPC "${op}" is not permitted over a peer link`);
    }
    if (peer.direction === "outbound") {
      const cfg = this.peers.getRemoteConfig(peer.alias);
      if (cfg?.reverseAccess !== "full" && !REVERSE_MESSAGES_ONLY_OPS.has(op)) {
        throw new Error(`Reverse RPC "${op}" requires reverseAccess: "full" on remote "${peer.alias}"`);
      }
    }
    switch (op) {
      case "ping": {
        const live = this.getLiveWorkSummary();
        return {
          pong: true,
          pid: process.pid,
          nodeId: this.nodeId,
          hostName: this.peers.localHostName,
          protocolRev: DAEMON_PROTOCOL_REV,
          running: live.running,
        };
      }
      case "project.list":
        return await this.db.projects.listProjects();
      case "project.get": {
        const ref = String(p.projectId ?? p.id ?? p.name ?? p.path ?? "");
        const proj = this.db.projects.resolveProject(ref);
        if (!proj) throw new Error(`Unknown project: ${ref}`);
        const all = await this.db.projects.listProjects();
        return { ...(all.find((x) => x.id === proj.id) ?? proj), nodeId: this.nodeId };
      }
      case "project.create": {
        const cloneUrl = typeof p.cloneUrl === "string" && p.cloneUrl.trim() ? p.cloneUrl.trim() : undefined;
        if (cloneUrl && (cloneUrl.startsWith("-") || !/^(?:https:\/\/|ssh:\/\/|git@)/i.test(cloneUrl))) {
          throw new Error(`Invalid clone URL "${cloneUrl}" (must use https://, ssh://, or git@)`);
        }
        const created = await this.db.projects.createProject({
          path: String(p.path ?? ""),
          name: typeof p.name === "string" ? p.name : undefined,
          description: typeof p.description === "string" ? p.description : undefined,
          createDir: p.createDir === undefined ? true : Boolean(p.createDir),
          gitInit: Boolean(p.gitInit),
          cloneUrl,
          defaultProfileId: typeof p.defaultProfileId === "string" ? p.defaultProfileId : undefined,
          defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : undefined,
          defaultEffort: typeof p.defaultEffort === "string" ? p.defaultEffort : undefined,
        });
        const all = await this.db.projects.listProjects();
        return all.find((x) => x.id === created.id) ?? created;
      }
      case "project.update": {
        const ref = String(p.projectId ?? p.id ?? "");
        const updated = this.db.projects.updateProject(ref, {
          name: typeof p.name === "string" ? p.name : undefined,
          description: p.description === null ? null : typeof p.description === "string" ? p.description : undefined,
          defaultProfileId: p.defaultProfileId === null ? null : typeof p.defaultProfileId === "string" ? p.defaultProfileId : undefined,
          defaultModel: p.defaultModel === null ? null : typeof p.defaultModel === "string" ? p.defaultModel : undefined,
          defaultEffort: p.defaultEffort === null ? null : typeof p.defaultEffort === "string" ? p.defaultEffort : undefined,
        });
        const all = await this.db.projects.listProjects();
        return all.find((x) => x.id === updated.id) ?? updated;
      }
      case "project.remove": {
        const ref = String(p.projectId ?? p.id ?? "");
        return this.db.projects.removeProject(ref);
      }
      case "project.browse":
        return this.db.projects.browseDirectory(typeof p.path === "string" ? p.path : undefined);
      case "sessions.list":
        return await this.listLocalSessions(null);
      case "chat.create":
        return await this.createSessionOnHost({
          project: typeof p.projectId === "string" ? p.projectId : undefined,
          title: typeof p.title === "string" ? p.title : undefined,
        });
      case "session.deliver_message": {
        // Always derive sender node & host from the authenticated PeerLink (using our configured alias on outbound links)
        const authNode = peer.remoteIdentity?.nodeId;
        if (!authNode) throw new Error("Unauthenticated peer link");
        const authHost = peer.direction === "outbound" ? peer.alias : (peer.remoteIdentity?.hostName || peer.alias);
        return this.deliverLocalSessionMessage({
          id: String(p.id),
          fromNode: authNode,
          fromHost: authHost,
          fromSessionId: String(p.fromSessionId),
          fromProjectName: typeof p.fromProjectName === "string" ? p.fromProjectName : null,
          toSessionId: String(p.toSessionId),
          body: String(p.body ?? ""),
          replyToId: typeof p.replyToId === "string" ? p.replyToId : null,
          expectReply: p.expectReply === undefined ? true : Boolean(p.expectReply),
          hopCount: typeof p.hopCount === "number" ? p.hopCount : 1,
        });
      }
      case "session.list_messages": {
        const { host, sessionId } = parseSessionAddress(String(p.sessionId ?? p.target ?? ""));
        if (host && !this.isLocalHostTarget(host)) throw new Error("Cross-host forwarding is not permitted over a peer link");
        return this.db.sessionMessages.listForSession(
          this.resolveChatSessionId(sessionId),
          typeof p.limit === "number" ? p.limit : 50,
        );
      }
      case "session.read": {
        const rawTarget = String(p.target ?? p.sessionId ?? "").trim();
        const { host, sessionId } = parseSessionAddress(rawTarget);
        if ((host && !this.isLocalHostTarget(host)) || sessionId.includes(":")) {
          throw new Error("Cross-host forwarding is not permitted over a peer link");
        }
        return this.readLocalSession(sessionId, typeof p.limit === "number" ? p.limit : 12);
      }
      case "peer.sync_outbox": {
        const flushed = await this.flushOutboxForPeer(peer);
        return { flushed };
      }
      default:
        throw new Error(`RPC "${op}" is not permitted over a peer link`);
    }
  }

  private async dispatch(socket: Socket, req: RpcRequest): Promise<unknown> {
    if (this.lifecycle !== "serving" && WORK_STARTING_OPS.has(req.op)) {
      const action = this.lifecycle === "draining" || this.restartExpected ? "harnessd is restarting for an update" : "harnessd is stopping";
      throw new Error(`DAEMON_RELOADING: ${action}. Your request was not started. It is safe to retry after reconnect.`);
    }
    const p = req.params ?? {};

    switch (req.op) {
      case "ping": {
        const live = this.getLiveWorkSummary();
        const release = currentRelease();
        return {
          pong: true,
          pid: process.pid,
          nodeId: this.nodeId,
          hostName: this.peers.localHostName,
          uptimeMs: Date.now() - this.startedAt,
          protocolRev: DAEMON_PROTOCOL_REV,
          releaseId: release.releaseId,
          releaseDir: release.releaseDir,
          lifecycle: this.lifecycle,
          restartSafe: true,
          ...(this.disableReloadRpc ? {} : { reload: this.getReloadStatus() }),
          running: live.running,
          liveWork: live.description,
          remotes: this.listRemoteStatuses(),
        };
      }

      case "daemon.shutdown":
        if (p.restart === true) this.restartExpected = true;
        setTimeout(() => {
          void this.shutdownAndExit({ reason: "daemon.shutdown" });
        }, 25).unref();
        return { shuttingDown: true, pid: process.pid };

      case "daemon.reload":
        if (this.disableReloadRpc) {
          throw new Error(`Unknown daemon op: ${req.op}`);
        }
        return this.hotUpdate.request(p as unknown as DaemonReloadParams);

      case "status": {
        const release = currentRelease();
        return {
          pid: process.pid,
          nodeId: this.nodeId,
          hostName: this.peers.localHostName,
          uptimeMs: Date.now() - this.startedAt,
          protocolRev: DAEMON_PROTOCOL_REV,
          releaseId: release.releaseId,
          releaseDir: release.releaseDir,
          lifecycle: this.lifecycle,
          ...(this.recoveryDegraded ? { recoveryDegraded: this.recoveryDegraded } : {}),
          restartSafe: true,
          ...(this.disableReloadRpc ? {} : { reload: this.getReloadStatus() }),
          socketPath: this.config.socketPath,
          configPath: join(this.config.stateDir, "config.json"),
          configWarnings: [...this.globalConfigWarnings, ...this.repoConfigWarnings],
          effectiveLimits: {
            maxConcurrentGoals: this.config.goals.maxConcurrentGoals ?? 4,
            maxConcurrentWorkers: this.config.worktree.maxConcurrentWorkers ?? 4,
            reviewerMaxTurns: this.config.rollover.reviewerMaxTurns,
            extraReadRoots: this.config.worktree.extraReadRoots ?? [],
            extraWriteRoots: this.config.worktree.extraWriteRoots ?? [],
          },
          effectiveExternalMcpServers: resolveExternalMcpServers(
            this.config.stateDir,
            this.orchestrator.config.externalMcpServers,
          ).map((s) => ({ name: s.name, enabled: s.enabled !== false })),
          hasLibghosttyVt: this.ptyHost.hasLibghosttyVt,
          runs: this.db.listRuns(20),
          goals: this.director.goals.listGoals(),
          profiles: this.config.profiles.map((pr) => ({ id: pr.id, kind: pr.kind, billing: pr.billing, enabled: pr.enabled !== false })),
          remotes: this.listRemoteStatuses(),
        };
      }

      case "remote.list":
        return this.listRemoteStatuses();

      case "remote.add": {
        const name = String(p.name ?? "").trim();
        if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
          throw new Error("Remote host name must be non-empty alphanumeric (letters, digits, '.', '_', '-')");
        }
        if (name.toLowerCase() === "local") {
          throw new Error('Remote host name cannot be "local"');
        }
        const rawTarget = String(p.sshTarget ?? p.target ?? "").trim();
        if (!rawTarget) throw new Error("sshTarget is required (e.g. 'ssh://user@gpu-box' or 'user@gpu-box')");
        const sshTarget =
          rawTarget.startsWith("ssh://") || rawTarget.startsWith("/") || rawTarget.startsWith("./")
            ? rawTarget
            : `ssh://${rawTarget}`;
        const bridgeCommand = typeof p.bridgeCommand === "string" && p.bridgeCommand.trim() ? p.bridgeCommand.trim() : undefined;
        if (sshTarget.startsWith("ssh://")) {
          parseValidatedSshTarget(sshTarget, bridgeCommand);
        }
        const reverseAccess = p.reverseAccess === "full" ? "full" : p.reverseAccess === "messages" ? "messages" : undefined;
        const entry: RemoteHostConfig = {
          name,
          sshTarget,
          ...(bridgeCommand ? { bridgeCommand } : {}),
          autoConnect: p.autoConnect === undefined ? true : Boolean(p.autoConnect),
          ...(reverseAccess ? { reverseAccess } : {}),
        };
        const existing = (this.config.remotes ?? []).filter((r) => r.name.toLowerCase() !== name.toLowerCase());
        const nextRemotes = [...existing, entry];
        this.config = { ...this.config, remotes: nextRemotes };
        this.orchestrator.updateConfig(this.config, this.catalog, this.quota);
        this.director.updateConfig(this.config, this.catalog, this.quota);
        this.persistConfig();
        this.peers.syncRemotes(nextRemotes, p.connectNow === false ? { skipConnectNames: new Set([name.toLowerCase()]) } : undefined);
        if (p.connectNow !== false) {
          try {
            return await this.peers.connectRemote(name);
          } catch {
            // Return status with lastError populated instead of failing remote.add when host is asleep/offline
          }
        }
        return this.listRemoteStatuses().find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? entry;
      }

      case "remote.remove": {
        const name = String(p.name ?? "").trim();
        if (!name) throw new Error("Remote name is required");
        const before = this.config.remotes ?? [];
        const nextRemotes = before.filter((r) => r.name.toLowerCase() !== name.toLowerCase());
        if (nextRemotes.length === before.length) throw new Error(`Unknown remote host: ${name}`);
        const knownNodeId = this.peers.getKnownNodeId(name);
        const { remotes: _removed, ...rest } = this.config;
        this.config = nextRemotes.length > 0 ? { ...rest, remotes: nextRemotes } : rest;
        this.orchestrator.updateConfig(this.config, this.catalog, this.quota);
        this.director.updateConfig(this.config, this.catalog, this.quota);
        this.persistConfig();
        this.peers.syncRemotes(nextRemotes);
        const failedQueued = this.db.sessionMessages.failQueuedForHost(name, knownNodeId, `Remote host "${name}" was removed`);
        return { removed: name, failedQueued };
      }

      case "remote.connect": {
        const name = String(p.name ?? "").trim();
        if (!name) throw new Error("Remote name is required");
        return await this.peers.connectRemote(name);
      }

      case "remote.disconnect": {
        const name = String(p.name ?? "").trim();
        if (!name) throw new Error("Remote name is required");
        return this.peers.disconnectRemote(name);
      }

      case "peer.hello": {
        const identity: PeerIdentity = {
          nodeId: String(p.nodeId ?? ""),
          hostName: String(p.hostName ?? "remote"),
          protocolRev: Number(p.protocolRev ?? 0),
        };
        if (!identity.nodeId) throw new Error("peer.hello requires nodeId");
        this.peers.registerInboundSocket(socket, identity);
        return {
          nodeId: this.nodeId,
          hostName: this.peers.localHostName,
          protocolRev: DAEMON_PROTOCOL_REV,
        } satisfies PeerIdentity;
      }

      case "peer.proxy": {
        const host = String(p.host ?? "").trim();
        const op = String(p.op ?? "") as DaemonOp;
        const params = (p.params ?? {}) as Record<string, unknown>;
        if (!host) throw new Error("host is required");
        if (!op) throw new Error("op is required");
        if (!PEER_ALLOWED_OPS.has(op)) {
          throw new Error(`Op "${op}" cannot be proxied`);
        }
        return await this.peers.callRemote(host, op, params, typeof p.timeoutMs === "number" ? p.timeoutMs : 30_000);
      }

      case "peer.sync_outbox": {
        const inbound = this.peers.getInboundLinkForSocket(socket);
        if (inbound) {
          const flushed = await this.flushOutboxForPeer(inbound);
          return { flushed };
        }
        let total = 0;
        for (const link of this.peers.connectedLinks()) {
          total += await this.flushOutboxForPeer(link);
        }
        return { flushed: total };
      }

      case "config.get":
        return this.config;

      case "config.update": {
        if (p.patch === null || (p.patch !== undefined && !isPlainObject(p.patch))) {
          throw new Error("Invalid config patch: config must be a JSON object");
        }
        const patch = (p.patch ?? {}) as Record<string, unknown>;
        const unsupported = Object.keys(patch).filter((key) => !CONFIG_UPDATE_FIELDS.has(key));
        if (unsupported.length > 0) {
          throw new Error(`Invalid config patch: unsupported config.update field: ${unsupported.join(", ")}`);
        }
        const misplaced = findMisplacedConfigKeys(patch, "global");
        if (misplaced.length > 0) {
          throw new Error(
            `Invalid config patch: ${misplaced.map((m) => `"${m.path}" is not supported; supported location: ${m.supported}`).join("; ")}`,
          );
        }
        const patchErrors = validateConfigRaw(patch);
        if (patchErrors.length > 0) throw new Error(`Invalid config patch: ${patchErrors.join("; ")}`);
        const { roots } = normalizeWorktreeRoots(patch.worktree);
        const next: HarnessConfig = {
          ...this.config,
          ...(typeof patch.defaultOrchestratorProfile === "string"
            ? { defaultOrchestratorProfile: patch.defaultOrchestratorProfile }
            : {}),
          ...(typeof patch.defaultWorkerProfile === "string" ? { defaultWorkerProfile: patch.defaultWorkerProfile } : {}),
          ...(typeof patch.defaultTaskProfile === "string" ? { defaultTaskProfile: patch.defaultTaskProfile } : {}),
          ...(patch.codeMode === "collapsed" || patch.codeMode === "hybrid" || patch.codeMode === "off"
            ? { codeMode: patch.codeMode }
            : {}),
          ...(patch.rollover ? { rollover: { ...this.config.rollover, ...(patch.rollover as HarnessConfig["rollover"]) } } : {}),
          ...(patch.worktree ? { worktree: {
            ...this.config.worktree,
            ...(patch.worktree as HarnessConfig["worktree"]),
            ...(roots.extraReadRoots !== undefined ? { extraReadRoots: roots.extraReadRoots } : {}),
            ...(roots.extraWriteRoots !== undefined ? { extraWriteRoots: roots.extraWriteRoots } : {}),
          } } : {}),
          ...(patch.goals ? { goals: patchGoals(this.config.goals, patch.goals as Record<string, unknown>) } : {}),
          ...(patch.events ? { events: { ...this.config.events, ...(patch.events as HarnessConfig["events"]) } } : {}),
          ...(patch.catalog ? { catalog: { ...this.config.catalog, ...(patch.catalog as HarnessConfig["catalog"]) } } : {}),
          ...(patch.quotaRetry
            ? { quotaRetry: { ...this.config.quotaRetry, ...(patch.quotaRetry as HarnessConfig["quotaRetry"]) } }
            : {}),
          ...(patch.hotUpdate
            ? { hotUpdate: { ...this.config.hotUpdate, ...(patch.hotUpdate as HarnessConfig["hotUpdate"]) } }
            : {}),
          ...("quotaEndpoint" in patch
            ? { quotaEndpoint: (patch.quotaEndpoint as HarnessConfig["quotaEndpoint"] | null) ?? undefined }
            : {}),
        };
        return this.applyConfigMutation(next);
      }

      case "profiles.upsert": {
        const profile = p.profile as RunnerProfileConfig;
        if (!profile?.id) throw new Error("profile.id is required");
        const idx = this.config.profiles.findIndex((x) => x.id === profile.id);
        const nextProfiles = [...this.config.profiles];
        if (idx >= 0) nextProfiles[idx] = profile;
        else nextProfiles.push(profile);
        return this.applyConfigMutation({ ...this.config, profiles: nextProfiles }, { profilesChanged: true });
      }

      case "profiles.remove": {
        const id = String(p.id);
        return this.applyConfigMutation(
          {
            ...this.config,
            profiles: this.config.profiles.filter((x) => x.id !== id),
          },
          { profilesChanged: true },
        );
      }

      case "profiles.probe": {
        const id = String(p.id);
        const profile = this.config.profiles.find((x) => x.id === id);
        if (!profile) throw new Error(`Unknown profile ${id}`);
        const cwd = String(p.cwd ?? process.cwd());
        const models =
          profile.kind === "pi" ? new PiRunner(profile).probeModels() : await new AcpRunner(profile).probeModels(cwd);
        return { id, models };
      }

      case "project.list":
        return await this.listFederatedProjects({
          includeRemotes: Boolean(p.includeRemotes),
          host: typeof p.host === "string" ? p.host : undefined,
        });

      case "project.get": {
        const host = typeof p.host === "string" ? p.host.trim() : undefined;
        if (host && !this.isLocalHostTarget(host)) {
          const remote = (await this.peers.callRemote<Record<string, unknown>>(host, "project.get", { ...p, host: undefined })) ?? {};
          const remoteNodeId =
            this.peers.findLink(host)?.remoteIdentity?.nodeId ?? this.peers.getKnownNodeId(host) ??
            (typeof remote.nodeId === "string" ? remote.nodeId : null);
          return { ...remote, host, nodeId: remoteNodeId ?? null };
        }
        const ref = String(p.projectId ?? p.id ?? p.name ?? p.path ?? "");
        const proj = this.db.projects.resolveProject(ref);
        if (!proj) throw new Error(`Unknown project: ${ref}`);
        const all = await this.db.projects.listProjects();
        return { ...(all.find((x) => x.id === proj.id) ?? proj), host: "local", nodeId: this.nodeId };
      }

      case "project.create": {
        const host = typeof p.host === "string" ? p.host.trim() : undefined;
        if (host && !this.isLocalHostTarget(host)) {
          const remote = (await this.peers.callRemote<Record<string, unknown>>(host, "project.create", { ...p, host: undefined })) ?? {};
          return { ...remote, host };
        }
        const created = await this.db.projects.createProject({
          path: String(p.path ?? ""),
          name: typeof p.name === "string" ? p.name : undefined,
          description: typeof p.description === "string" ? p.description : undefined,
          createDir: p.createDir === undefined ? true : Boolean(p.createDir),
          gitInit: Boolean(p.gitInit),
          cloneUrl: typeof p.cloneUrl === "string" && p.cloneUrl.trim() ? p.cloneUrl.trim() : undefined,
          defaultProfileId: typeof p.defaultProfileId === "string" ? p.defaultProfileId : undefined,
          defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : undefined,
          defaultEffort: typeof p.defaultEffort === "string" ? p.defaultEffort : undefined,
        });
        const all = await this.db.projects.listProjects();
        return { ...(all.find((x) => x.id === created.id) ?? created), host: "local" };
      }

      case "project.update": {
        const host = typeof p.host === "string" ? p.host.trim() : undefined;
        if (host && !this.isLocalHostTarget(host)) {
          const remote = (await this.peers.callRemote<Record<string, unknown>>(host, "project.update", { ...p, host: undefined })) ?? {};
          return { ...remote, host };
        }
        const ref = String(p.projectId ?? p.id ?? "");
        const updated = this.db.projects.updateProject(ref, {
          name: typeof p.name === "string" ? p.name : undefined,
          description: p.description === null ? null : typeof p.description === "string" ? p.description : undefined,
          defaultProfileId: p.defaultProfileId === null ? null : typeof p.defaultProfileId === "string" ? p.defaultProfileId : undefined,
          defaultModel: p.defaultModel === null ? null : typeof p.defaultModel === "string" ? p.defaultModel : undefined,
          defaultEffort: p.defaultEffort === null ? null : typeof p.defaultEffort === "string" ? p.defaultEffort : undefined,
        });
        const all = await this.db.projects.listProjects();
        return { ...(all.find((x) => x.id === updated.id) ?? updated), host: "local" };
      }

      case "project.remove": {
        const host = typeof p.host === "string" ? p.host.trim() : undefined;
        if (host && !this.isLocalHostTarget(host)) {
          return await this.peers.callRemote(host, "project.remove", { ...p, host: undefined });
        }
        const ref = String(p.projectId ?? p.id ?? "");
        return this.db.projects.removeProject(ref);
      }

      case "project.browse": {
        const host = typeof p.host === "string" ? p.host.trim() : undefined;
        if (host && !this.isLocalHostTarget(host)) {
          return await this.peers.callRemote(host, "project.browse", { path: typeof p.path === "string" ? p.path : undefined });
        }
        return this.db.projects.browseDirectory(typeof p.path === "string" ? p.path : undefined);
      }

      case "chat.set_project": {
        const chatSessionId = this.resolveChatSessionId(String(p.chatSessionId));
        this.requireChatControlIfViewer(socket, chatSessionId);
        const projectRef = String(p.projectId ?? p.project ?? "");
        const { session, project } = this.director.switchChatProject(chatSessionId, projectRef);
        return { session, project };
      }

      case "chat.open": {
        const control = parseAttachControl(p.control);
        const requestedProjectRef = typeof p.projectId === "string" && p.projectId.trim() ? p.projectId.trim() : undefined;
        const explicitProject = requestedProjectRef ? this.db.projects.resolveProject(requestedProjectRef) : null;
        if (requestedProjectRef && !explicitProject) {
          throw new Error(`Unknown project "${requestedProjectRef}". Add it first with \`pi-harness project add <path>\` or /projects.`);
        }

        let session =
          typeof p.chatSessionId === "string" && p.chatSessionId
            ? this.director.chats.getSession(p.chatSessionId)
            : explicitProject
              ? this.director.chats.getProjectSession(explicitProject.id) ??
                this.director.chats.getWorkspaceSession(explicitProject.rootPath)
              : p.preferLastGlobal
                ? this.director.chats.getMostRecentSession()
                : null;

        if (typeof p.chatSessionId === "string" && p.chatSessionId && !session) {
          throw new Error(`Unknown chat session: ${p.chatSessionId}`);
        }

        let targetProject = explicitProject;
        let projectRegistered = false;
        if (!session) {
          if (!targetProject && p.preferLastProject) {
            targetProject = this.db.projects.getMostRecent();
          }
          const sel = chatSelection({
            ...p,
            repoRoot: targetProject?.rootPath ?? (typeof p.repoRoot === "string" && p.repoRoot ? p.repoRoot : process.cwd()),
          });
          const opened = await this.director.openDefaultChatDetailed({
            ...sel,
            projectId: targetProject?.id ?? undefined,
          });
          session = opened.session;
          projectRegistered = opened.projectRegistered;
        }
        const ensured = this.ensureChatProject(session);
        const boundProject = ensured.project;
        if (ensured.registered) projectRegistered = true;
        if (boundProject && session.projectId !== boundProject.id) {
          session = this.director.chats.updateSession(session.id, { projectId: boundProject.id });
        }
        if (boundProject) this.db.projects.touchProject(boundProject.id);
        session = await this.director.resolveOrMigrateSessionModel(session);

        const { tookOver } = this.bindChatSocket(socket, session.id, control);
        const turn = this.chatTurns.get(session.id);
        const historyThrough = this.chatHistoryThrough(session.id);
        return {
          session,
          project: boundProject,
          ...(projectRegistered ? { projectRegistered: true } : {}),
          ...this.chatHistoryPage(session.id, 0, historyThrough),
          activeTurnId: turn?.id ?? null,
          activeText: turn?.text ?? "",
          activePartial: turn ? this.director.getChatPartial(session.id) : "",
          goals: this.director.goals.listGoals({ chatSessionId: session.id }),
          config: this.config,
          tookOver,
          control: this.controlState(socket, "chat", session.id),
          busy: Boolean(turn),
        };
      }

      case "chat.create": {
        const requestedProjectRef = typeof p.projectId === "string" && p.projectId.trim() ? p.projectId.trim() : undefined;
        const explicitProject = requestedProjectRef ? this.db.projects.resolveProject(requestedProjectRef) : null;
        if (requestedProjectRef && !explicitProject) {
          throw new Error(`Unknown project "${requestedProjectRef}"`);
        }
        const created = await this.director.createChatDetailed({
          ...chatSelection({
            ...p,
            repoRoot: explicitProject?.rootPath ?? (typeof p.repoRoot === "string" && p.repoRoot ? p.repoRoot : process.cwd()),
          }),
          projectId: explicitProject?.id ?? undefined,
          title: typeof p.title === "string" ? p.title : undefined,
        });
        const { session } = created;
        const { project: boundProject, registered } = this.ensureChatProject(session);
        if (!p.headless) {
          this.bindChatSocket(socket, session.id);
        }
        const { historyThrough } = this.db.db.prepare(
          "SELECT COALESCE(MAX(seq), 0) AS historyThrough FROM chat_turns WHERE chat_session_id = ?",
        ).get(session.id) as { historyThrough: number };
        return {
          session,
          project: boundProject,
          ...(created.projectRegistered || registered ? { projectRegistered: true } : {}),
          ...this.chatHistoryPage(session.id, 0, historyThrough),
          activeTurnId: null,
          activeText: "",
          activePartial: "",
          goals: this.director.goals.listGoals({ chatSessionId: session.id }),
          config: this.config,
          tookOver: false,
          ...(!p.headless ? { control: this.controlState(socket, "chat", session.id) } : {}),
          busy: false,
        };
      }

      case "sessions.list":
        return await this.listFederatedSessions(socket, {
          includeRemotes: Boolean(p.includeRemotes),
          host: typeof p.host === "string" ? p.host : undefined,
        });

      case "session.send_message": {
        const boundChatId = this.socketToChatId.get(socket);
        if (boundChatId) this.requireChatControlIfViewer(socket, boundChatId);
        const boundAtt = this.attachments.get(socket);
        if (boundAtt) this.requireRunControlIfViewer(socket, boundAtt.runId);
        const rawFrom = String(p.fromSessionId ?? boundChatId ?? "").trim();
        if (!rawFrom) throw new Error("fromSessionId is required");
        const fromSessionId = this.resolveChatSessionId(rawFrom);
        this.requireChatControlIfViewer(socket, fromSessionId);
        const target = String(p.target ?? "").trim();
        const body = String(p.body ?? p.message ?? "").trim();
        if (!target) throw new Error("target is required");
        if (!body) throw new Error("body is required");
        return await this.sendSessionMessage({
          fromSessionId,
          target,
          body,
          expectReply: p.expectReply === undefined ? true : Boolean(p.expectReply),
          replyToId: typeof p.replyToId === "string" ? p.replyToId : undefined,
        });
      }

      case "session.deliver_message": {
        const inboundPeer = this.peers.getInboundLinkForSocket(socket);
        return this.deliverLocalSessionMessage({
          id: String(p.id),
          fromNode: String(p.fromNode ?? inboundPeer?.remoteIdentity?.nodeId ?? "unknown"),
          fromHost: String(p.fromHost ?? inboundPeer?.alias ?? "remote"),
          fromSessionId: String(p.fromSessionId),
          fromProjectName: typeof p.fromProjectName === "string" ? p.fromProjectName : null,
          toSessionId: String(p.toSessionId),
          body: String(p.body ?? ""),
          replyToId: typeof p.replyToId === "string" ? p.replyToId : null,
          expectReply: p.expectReply === undefined ? true : Boolean(p.expectReply),
          hopCount: typeof p.hopCount === "number" ? p.hopCount : 1,
        });
      }

      case "session.list_messages": {
        const target = String(p.target ?? p.sessionId ?? this.socketToChatId.get(socket) ?? "").trim();
        if (!target) throw new Error("sessionId or target is required");
        const { host, sessionId } = parseSessionAddress(target);
        const limit = typeof p.limit === "number" ? p.limit : 50;
        if (host && !this.isLocalHostTarget(host)) {
          return await this.peers.callRemote(host, "session.list_messages", { sessionId, limit });
        }
        return this.db.sessionMessages.listForSession(this.resolveChatSessionId(sessionId), limit);
      }

      case "session.read": {
        const target = String(p.target ?? p.sessionId ?? "").trim();
        if (!target) throw new Error("target is required");
        return await this.readSessionOnHost({
          target,
          limit: typeof p.limit === "number" ? p.limit : undefined,
        });
      }

      case "session.leave": {
        this.tuiSockets.delete(socket);
        this.unbindSocketSession(socket);
        this.chatSubscribers.delete(socket);
        const work = this.getLiveWorkSummary();
        const daemonWillQuit = this.autoQuitWhenIdle && this.lifecycle === "serving" && !work.running;
        if (daemonWillQuit) {
          this.cancelIdleShutdown();
          setTimeout(() => {
            if (this.lifecycle === "serving" && !this.getLiveWorkSummary().running) {
              void this.shutdownAndExit({ reason: "session.leave" });
            }
          }, 35).unref();
        }
        return {
          daemonWillQuit,
          running: work.running,
          activeWorkSummary: work.description,
        };
      }

      case "session.take_control": {
        const chatId = this.socketToChatId.get(socket);
        const att = this.attachments.get(socket);
        const kind: "chat" | "run" | null = chatId ? "chat" : att ? "run" : null;
        const sessionId = chatId ?? att?.runId ?? null;
        if (!kind || !sessionId) throw new Error("Not attached to a session");
        const requestedRaw = typeof p.sessionId === "string" && p.sessionId.trim() ? p.sessionId.trim() : null;
        const requestedId = requestedRaw
          ? kind === "chat"
            ? this.resolveChatSessionId(requestedRaw)
            : this.resolveRunId(requestedRaw)
          : null;
        if (requestedId && requestedId !== sessionId) {
          throw new Error(`Not attached to ${requestedRaw}`);
        }
        const bindings = kind === "chat" ? this.chatBindings : this.runBindings;
        const prev = bindings.get(sessionId);
        const tookOver = prev !== socket;
        if (tookOver) {
          bindings.set(sessionId, socket);
          this.bumpControlSeq(kind, sessionId);
          if (kind === "chat") this.director.chats.touchSession(sessionId);
          this.broadcastControl(kind, sessionId, "taken", socket);
        }
        return { ...this.controlState(socket, kind, sessionId), tookOver };
      }

      case "tui.register": {
        if (socket.destroyed) throw new Error("TUI connection closed");
        this.cancelIdleShutdown();
        this.tuiSockets.add(socket);
        return { registered: true };
      }

      case "chat.send": {
        const chatSessionId = this.resolveChatSessionId(String(p.chatSessionId));
        this.requireChatOwner(socket, chatSessionId);
        if (this.chatTurns.has(chatSessionId)) throw new Error("Director is already responding");
        const id = typeof p.turnId === "string" && p.turnId ? p.turnId : req.id;
        const turn = createActiveChatTurn(id);
        this.chatTurns.set(chatSessionId, turn);
        this.sendChatEvent(chatSessionId, id, "chat.turn.start", { reason: "user", text: String(p.text) }, socket);
        try {
          const result = await this.director.sendChatMessage(
            chatSessionId, String(p.text),
            (delta) => {
              if (turn.detached || this.dbClosed) return;
              turn.text += delta;
              this.sendChatEvent(chatSessionId, id, "chat.delta", { delta });
            },
            (tool) => {
              if (turn.detached || this.dbClosed) return;
              trackTurnTool(turn, tool);
              this.sendChatEvent(chatSessionId, id, "chat.tool", tool);
            },
          );
          if (!turn.detached && !this.dbClosed) {
            this.sendChatEvent(chatSessionId, id, "chat.turn.end", { assistantTurn: result.assistantTurn, cancelled: turn.cancelling });
          }
          return result;
        } catch (err) {
          if (!turn.detached && !this.dbClosed) {
            this.sendChatEvent(chatSessionId, id, "chat.turn.end", {
              error: err instanceof Error ? err.message : String(err), cancelled: turn.cancelling,
            });
          }
          throw err;
        } finally {
          if (this.chatTurns.get(chatSessionId) === turn) {
            this.chatTurns.delete(chatSessionId);
          }
          turn.isSettled = true;
          turn.markSettled();
          if (!turn.detached && !this.dbClosed) {
            this.drainPendingWakeup(chatSessionId);
          }
        }
      }

      case "chat.steer": {
        const chatSessionId = this.resolveChatSessionId(String(p.chatSessionId));
        this.requireChatOwner(socket, chatSessionId);
        const turn = this.chatTurns.get(chatSessionId);
        if (!turn || turn.id !== p.turnId || turn.cancelling) return { steered: false, cancelled: false };
        const message = String(p.message);
        if (await this.director.steerChat(chatSessionId, message, { role: "user" })) {
          this.sendChatEvent(
            chatSessionId,
            turn.id,
            "chat.steered",
            { message, role: "user", originClientId: this.clientId(socket) },
            socket,
          );
          return { steered: true };
        }
        return { steered: false, cancelled: false };
      }

      case "chat.cancel": {
        const chatSessionId = this.resolveChatSessionId(String(p.chatSessionId));
        this.requireChatOwner(socket, chatSessionId);
        const turn = this.chatTurns.get(chatSessionId);
        if (!turn || turn.id !== p.turnId || turn.cancelling) return { steered: false, cancelled: false };
        turn.cancelling = true;
        try {
          return { steered: false, cancelled: await this.director.cancelChat(chatSessionId) };
        } finally {
          turn.cancelling = false;
        }
      }

      case "chat.history": {
        const chatSessionId = this.resolveChatSessionId(String(p.chatSessionId));
        if (typeof p.afterSeq === "number" && typeof p.throughSeq === "number") {
          return this.chatHistoryPage(chatSessionId, p.afterSeq, p.throughSeq);
        }
        return this.director.chats.getHistory(
          chatSessionId,
          typeof p.sinceSeq === "number" ? p.sinceSeq : 0,
          Math.min(100, Math.max(1, Number(p.limit) || 100)),
        );
      }

      case "chat.update": {
        const chatSessionId = this.resolveChatSessionId(String(p.chatSessionId));
        this.requireChatControlIfViewer(socket, chatSessionId);
        return this.director.chats.updateSession(chatSessionId, {
          profileId: typeof p.profileId === "string" ? p.profileId : undefined,
          model: p.model === null ? null : typeof p.model === "string" ? p.model : undefined,
          effort: p.effort === null ? null : typeof p.effort === "string" ? p.effort : undefined,
          title: typeof p.title === "string" ? p.title : undefined,
          modelSelectionContext:
            p.modelSelectionContext === null
              ? null
              : typeof p.modelSelectionContext === "string"
                ? p.modelSelectionContext
                : undefined,
        });
      }

      case "chat.list":
        return this.director.chats.listSessions();

      case "kb.search":
        return this.db.kb.search({
          query: typeof p.query === "string" ? p.query : undefined,
          repoScope: typeof p.repoRoot === "string" ? p.repoRoot : undefined,
          includeCandidates: Boolean(p.includeCandidates),
          includeStale: Boolean(p.includeStale),
          limit: typeof p.limit === "number" ? p.limit : 20,
        });

      case "kb.get":
        return this.db.kb.getMany(Array.isArray(p.ids) ? (p.ids as string[]) : []);

      case "goal.create":
        return this.director.goals.createGoal({
          repoRoot: String(p.repoRoot ?? process.cwd()),
          chatSessionId: typeof p.chatSessionId === "string" ? p.chatSessionId : null,
          title: String(p.title),
          description: String(p.description ?? p.title),
          criteria: (p.criteria as Array<Omit<GoalCriterion, "id" | "required">>) ?? [],
          nonGoals: Array.isArray(p.nonGoals) ? (p.nonGoals as string[]) : [],
          verificationMode:
            typeof p.verificationMode === "string" &&
            ["auto", "none", "deterministic", "independent_review"].includes(p.verificationMode)
              ? (p.verificationMode as "auto" | "none" | "deterministic" | "independent_review")
              : undefined,
        });

      case "goal.commit": {
        // One shared start-or-resume contract (it also clears the previous epoch's claims on an in-place resume);
        // the Director's detailed result, read after that clear, is returned as is.
        const res = await this.director.commitGoalDetailed(String(p.goalId), {
          profileId: typeof p.profileId === "string" ? p.profileId : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
          effort: typeof p.effort === "string" ? p.effort : undefined,
        });
        return {
          ...res.goal,
          outcome: res.outcome,
          message: res.message,
          ...(res.runStatus ? { runStatus: res.runStatus } : {}),
          ...(res.resumedTaskIds ? { resumedTaskIds: res.resumedTaskIds } : {}),
          ...(res.queuePosition !== undefined ? { queuePosition: res.queuePosition } : {}),
        };
      }

      case "goal.amend": {
        const goalId = String(p.goalId);
        const rationale = String(p.rationale ?? "Amended by user");
        const hasMaxReviewCycles = p.maxReviewCycles !== undefined;
        const hasMaxNoProgressCycles = p.maxNoProgressCycles !== undefined;
        const hasBudgetPatch = hasMaxReviewCycles || hasMaxNoProgressCycles;
        const budgetPatch = {
          ...(hasMaxReviewCycles
            ? { maxReviewCycles: typeof p.maxReviewCycles === "number" ? p.maxReviewCycles : Number.NaN }
            : {}),
          ...(hasMaxNoProgressCycles
            ? {
                maxNoProgressCycles:
                  typeof p.maxNoProgressCycles === "number" ? p.maxNoProgressCycles : Number.NaN,
              }
            : {}),
        };
        const updateCriteria = parseGoalCriterionPatches(p.updateCriteria);
        const hasContractPatch =
          typeof p.title === "string" ||
          typeof p.description === "string" ||
          typeof p.appendDescription === "string" ||
          (Array.isArray(p.addCriteria) && p.addCriteria.length > 0) ||
          (updateCriteria !== undefined && updateCriteria.length > 0) ||
          (Array.isArray(p.removeCriteriaIds) && p.removeCriteriaIds.length > 0) ||
          Array.isArray(p.nonGoals);
        if (hasBudgetPatch && !hasContractPatch) {
          return await this.director.amendGoalBudgets(goalId, budgetPatch, rationale, { source: "user" });
        }
        return await this.director.amendGoal(
          goalId,
          {
            rationale,
            title: typeof p.title === "string" ? p.title : undefined,
            description: typeof p.description === "string" ? p.description : undefined,
            appendDescription: typeof p.appendDescription === "string" ? p.appendDescription : undefined,
            confirmReplaceDescription: p.confirmReplaceDescription === true ? true : undefined,
            addCriteria: Array.isArray(p.addCriteria) ? (p.addCriteria as GoalCriterion[]) : undefined,
            updateCriteria,
            removeCriteriaIds: Array.isArray(p.removeCriteriaIds) ? (p.removeCriteriaIds as string[]) : undefined,
            nonGoals: Array.isArray(p.nonGoals) ? (p.nonGoals as string[]) : undefined,
          },
          {
            source: "user",
            ...(hasBudgetPatch ? { budgets: budgetPatch } : {}),
          },
        );
      }

      case "goal.list":
        return this.director.goals
          .listGoals({
            repoRoot: typeof p.repoRoot === "string" ? p.repoRoot : undefined,
            chatSessionId: typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : undefined,
          })
          .map(reconcileGoalWithLiveRun);

      case "goal.get": {
        const stored = this.director.goals.getGoal(String(p.goalId));
        if (!stored) throw new Error(`Unknown goal ${p.goalId}`);
        const g = reconcileGoalWithLiveRun(stored);
        const reviews = this.director.goals.listReviews(g.id);
        const tasks = g.linkedRunId ? this.db.listTasks(g.linkedRunId) : [];
        const escalations = g.linkedRunId ? this.db.listEscalations(g.linkedRunId, "open") : [];
        const activity = g.linkedRunId ? buildRunActivitySummary(this.db, g.linkedRunId) : null;
        const display = buildGoalDetailDisplay({ goal: g, reviews, tasks, openEscalations: escalations, activity });
        if (typeof p.persistChatSessionId === "string" && p.persistChatSessionId) {
          this.director.chats.appendTurn(
            p.persistChatSessionId,
            "tool_output",
            summarizeToolDisplay("goal_get", display),
            { toolName: "goal_get", display },
          );
        }
        const acceptOverrides = reviews.filter((r) => r.source === "director_accept_override");
        const activeVerification = this.director.getActiveVerification(g.id);
        const verificationNote =
          (g.status === "verifying" || g.status === "reviewing") && activeVerification === null
            ? GOAL_VERIFICATION_IDLE_NOTE
            : undefined;
        return {
          goal: g,
          reviews,
          acceptOverrides,
          tasks,
          escalations,
          activity,
          activeVerification,
          ...(verificationNote !== undefined ? { verificationNote } : {}),
          display,
        };
      }

      case "goal.table_display": {
        const goals = this.director.goals
          .listGoals({
            repoRoot: typeof p.repoRoot === "string" ? p.repoRoot : undefined,
            chatSessionId: typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : undefined,
          })
          .map(reconcileGoalWithLiveRun);
        const display = buildGoalsTableDisplay(
          goals.map((goal) => ({
            goal,
            reviews: this.director.goals.listReviews(goal.id),
            tasks: goal.linkedRunId ? this.db.listTasks(goal.linkedRunId) : [],
            activity: goal.linkedRunId ? buildRunActivitySummary(this.db, goal.linkedRunId) : null,
            openEscalations: goal.linkedRunId ? this.db.listEscalations(goal.linkedRunId, "open") : [],
          })),
        );
        if (typeof p.persistChatSessionId === "string" && p.persistChatSessionId) {
          this.director.chats.appendTurn(
            p.persistChatSessionId,
            "tool_output",
            summarizeToolDisplay("goal_list", display),
            { toolName: "goal_list", display },
          );
        }
        return { goals, display };
      }

      case "goal.revisions":
        return this.director.goals.listRevisions(String(p.goalId));

      case "goal.resume": {
        if (!this.director.goals.getGoal(String(p.goalId))) throw new Error(`Unknown goal ${p.goalId}`);
        // Delegated once to the shared contract; never re-derives or overwrites a newer pause after the await.
        const res = await this.director.resumeGoalDetailed(String(p.goalId), {
          note: typeof p.note === "string" ? p.note : undefined,
        });
        const resumed = res.outcome === "resumed" || res.outcome === "started";
        return {
          resumed,
          goal: res.goal,
          resumedTaskIds: res.resumedTaskIds ?? [],
          outcome: res.outcome,
          ...(res.runStatus ? { runStatus: res.runStatus } : {}),
          ...(res.queuePosition !== undefined ? { queuePosition: res.queuePosition } : {}),
          message: res.message,
          ...(resumed ? {} : { reason: res.message }),
        };
      }

      case "goal.accept": {
        const evidencePaths = Array.isArray(p.evidencePaths) ? p.evidencePaths.map(String) : [];
        return await this.director.acceptGoalOverride(String(p.goalId), {
          reason: String(p.reason ?? ""),
          evidencePaths,
          overrideDeterministic: p.overrideDeterministic === true,
          source: "user",
        });
      }

      case "goal.review":
        return await this.director.verifyAndReviewGoal(String(p.goalId), undefined, {
          verificationMode:
            typeof p.verificationMode === "string" &&
            ["auto", "none", "deterministic", "independent_review"].includes(p.verificationMode)
              ? (p.verificationMode as "auto" | "none" | "deterministic" | "independent_review")
              : undefined,
          summary: typeof p.summary === "string" ? p.summary : undefined,
        });

      case "goal.pause":
        // Also cancels earlier resume_goal timers and wins over a launch or resume already in flight.
        return await this.director.pauseGoal(String(p.goalId), "Paused by user");

      case "goal.cancel":
        return await this.director.pauseGoal(String(p.goalId), "Cancelled by user", "cancelled");

      case "run.create":
        return await this.orchestrator.startRun({
          goal: String(p.goal),
          repoRoot: String(p.repoRoot ?? process.cwd()),
          profileId: typeof p.profileId === "string" ? p.profileId : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
          effort: typeof p.effort === "string" ? p.effort : undefined,
        });

      case "run.list": {
        const limit = typeof p.limit === "number" ? p.limit : 20;
        if (typeof p.chatSessionId === "string" && p.chatSessionId) {
          return this.getRunIdsForChatSession(p.chatSessionId)
            .map((id) => this.orchestrator.getEffectiveRun(id))
            .filter((r): r is NonNullable<typeof r> => r !== null)
            .sort((a, b) => b.createdAt - a.createdAt)
            .slice(0, limit);
        }
        return this.db.listRuns(limit).map((r) => this.orchestrator.getEffectiveRun(r.id) ?? r);
      }

      case "run.get": {
        const runId = this.resolveRunId(String(p.runId));
        return {
          run: this.orchestrator.getEffectiveRun(runId),
          tasks: this.db.listTasks(runId),
          escalations: this.db.listEscalations(runId),
          worktrees: this.db.listWorktrees(runId),
          quotaPause: this.orchestrator.getRunQuotaStatus(runId),
        };
      }

      case "run.stop": {
        const runId = this.resolveRunId(String(p.runId));
        this.requireRunControlIfViewer(socket, runId);
        const reason = typeof p.reason === "string" ? p.reason : "Stopped by user";
        let cancelledChat = false;
        if (isDirectorTaskContainer(runId)) {
          // Stop the chat's live turn first so it cannot delegate again, then cancel the container's children.
          cancelledChat = await this.director.cancelChat(directorTaskRunOwner(runId) ?? "");
        }
        this.director.invalidateQueuedResumeForRun(runId, reason);
        await this.orchestrator.stopRun(runId, reason);
        return { stopped: true, ...(cancelledChat ? { cancelledChat } : {}) };
      }

      case "runs.stop_all": {
        const reason = typeof p.reason === "string" && p.reason.trim() ? p.reason.trim() : "Stopped by user (/stop)";
        const repoFilter = typeof p.repoRoot === "string" && p.repoRoot.trim() ? canonicalProjectPath(p.repoRoot.trim()) : undefined;
        const inScope = (repoRoot: string | null | undefined) =>
          !repoFilter || (repoRoot ? canonicalProjectPath(repoRoot) === repoFilter : false);
        // An explicit stop wins over every older in-flight resume or launch, in this repo only when filtered.
        if (repoFilter) this.orchestrator.bumpRepoStopEpoch(repoFilter);
        else this.orchestrator.bumpGlobalStopEpoch();
        // Abort live Director turns, reviews and goal-resume timers FIRST (scoped to the repo) so none can delegate
        // or resume after the stop; the Director counts what it actually cancelled.
        const { cancelledChats, cancelledReviews, cancelledTimers } = await this.director.cancelAllActive(
          reason,
          repoFilter ? { repoRoot: repoFilter } : undefined,
        );
        // Pending wakeups of chats outside the filter stay queued.
        for (const chatId of [...this.pendingWakeups.keys()]) {
          if (inScope(this.director.chatRepoRoot(chatId))) this.pendingWakeups.delete(chatId);
        }
        // Queued goals leave the queue, so stopping a linked run below cannot drain it and start new work.
        let dequeuedGoals = 0;
        for (const entry of this.db.admissionQueue.list({ lane: "goal" })) {
          if (inScope(entry.repoRoot) && this.db.admissionQueue.remove("goal", entry.targetId)) dequeuedGoals++;
        }
        if (dequeuedGoals > 0) this.director.syncQueuedGoalProgress();
        // Every active or quota-paused run (no row cap), plus runs whose tasks are live in memory.
        const candidates = new Map<string, RunRecord>();
        for (const r of this.db.listActiveOrQuotaPausedRuns()) candidates.set(r.id, r);
        for (const id of this.orchestrator.liveRunIds()) {
          const r = this.db.getRun(id);
          if (r) candidates.set(r.id, r);
        }
        const runs = [...candidates.values()].filter((r) => {
          if (!inScope(r.repoRoot)) return false;
          const eff = this.orchestrator.getEffectiveRun(r.id);
          return eff?.status === "active" || eff?.status === "paused_quota";
        });
        const stoppedRunIds: string[] = [];
        for (const r of runs) {
          // Director delegation containers only have their children cancelled; they are never poisoned to "stopped".
          await this.orchestrator.stopRun(r.id, reason);
          stoppedRunIds.push(r.id);
        }
        return {
          stopped: true,
          stoppedRunIds,
          cancelledChats,
          cancelledReviews,
          cancelledTimers,
          dequeuedGoals,
        };
      }

      case "run.resume": {
        const runId = this.resolveRunId(String(p.runId));
        this.requireRunControlIfViewer(socket, runId);
        return await this.director.resumeRunDetailed(runId, {
          trigger: "manual",
          userMessage: typeof p.message === "string" && p.message.trim() ? p.message.trim() : undefined,
          note: typeof p.note === "string" && p.note.trim() ? p.note.trim() : undefined,
        });
      }

      case "task.resume": {
        const taskId = String(p.taskId);
        const taskBefore = this.db.getTask(taskId);
        if (taskBefore) {
          this.requireRunControlIfViewer(socket, taskBefore.runId);
        }
        const res = await this.director.resumeTaskForCaller(taskId, {
          note: typeof p.note === "string" ? p.note : undefined,
          model: typeof p.model === "string" ? p.model : undefined,
          effort: typeof p.effort === "string" ? p.effort : undefined,
          profileId: typeof p.profileId === "string" ? p.profileId : undefined,
        });
        return {
          resumed: res.outcome === "resumed",
          task: res.task,
          outcome: res.outcome,
          message: res.message,
          runStatus: this.orchestrator.getEffectiveRun(res.task.runId)?.status ?? null,
          ...(res.queuePosition !== undefined ? { queuePosition: res.queuePosition } : {}),
          ...(res.noteDelivered !== undefined ? { noteDelivered: res.noteDelivered } : {}),
          ...(res.noteDelivery ? { noteDelivery: res.noteDelivery } : {}),
          ...(res.goalId ? { goalId: res.goalId, goalStatus: res.goalStatus } : {}),
        };
      }

      case "run.schedule_resume": {
        const runId = this.resolveRunId(String(p.runId));
        this.requireRunControlIfViewer(socket, runId);
        const delayMs = Number(p.delayMs);
        if (!Number.isFinite(delayMs) || delayMs <= 0) {
          throw new Error("delayMs must be a positive number of milliseconds");
        }
        return this.orchestrator.scheduleRunQuotaResume(runId, delayMs);
      }

      case "attach": {
        const control = parseAttachControl(p.control);
        const rawRunId = String(p.runId);
        const run = this.db.getRun(rawRunId);
        const runId = run?.id ?? rawRunId.trim();
        const rawTaskId = typeof p.taskId === "string" && p.taskId.trim() ? p.taskId.trim() : null;
        const taskId = rawTaskId ? (this.db.getTask(rawTaskId)?.id ?? rawTaskId) : null;
        const sinceSeq = typeof p.sinceSeq === "number" ? p.sinceSeq : 0;
        const { tookOver } = this.bindRunSocket(socket, runId, taskId, control);
        const attachment = this.attachments.get(socket)!;
        const page = this.db.getReplayPage(runId, taskId, { sinceSeq, payloadOffset: 0 }, attachment.boundAtSeq);
        attachment.next = page.next;
        return {
          attachmentId: attachment.id,
          attached: true,
          tookOver,
          control: this.controlState(socket, "run", runId),
          run,
          taskId,
          tasks: this.db.listTasks(runId),
          escalations: this.db.listEscalations(runId, "open"),
          quotaPause: this.orchestrator.getRunQuotaStatus(runId),
          ...page,
        };
      }

      case "replay.page": {
        const attachment = this.attachments.get(socket);
        const watch = this.watches.get(socket)?.get(String(p.watchId));
        const target =
          watch && (watch.scope === "task" || watch.scope === "run")
            ? watch
            : attachment && attachment.id === p.attachmentId
              ? attachment
              : undefined;
        if (!target?.next) throw new Error("Replay expired or complete");
        const page = this.db.getReplayPage(target.runId, target.taskId, target.next, target.throughSeq,
          "boundAtSeq" in target ? target.boundAtSeq : undefined);
        // Finish each snapshot before advancing the watermark to matching live events.
        if (!page.next && target.pendingSeq !== undefined) {
          page.next = { sinceSeq: target.throughSeq, payloadOffset: 0 };
          target.throughSeq = target.pendingSeq;
          target.pendingSeq = undefined;
        }
        target.next = page.next;
        if (watch && (watch.scope === "task" || watch.scope === "run")) watch.lastSeq = target.throughSeq;
        return page;
      }

      case "detach":
        this.unbindSocketSession(socket);
        return { detached: true };

      case "tree.get": {
        const runId = this.resolveRunId(String(p.runId));
        return {
          run: this.db.getRun(runId),
          tasks: this.db.listTasks(runId),
          escalations: this.db.listEscalations(runId, "open"),
          worktrees: this.db.listWorktrees(runId),
          quotaPause: this.orchestrator.getRunQuotaStatus(runId),
        };
      }

      case "runs.trees": {
        const limit = typeof p.limit === "number" ? Math.min(50, Math.max(1, Math.floor(p.limit))) : 50;
        const before = p.before as { id: string; createdAt: number } | undefined;
        const scopedChatId = typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : null;
        const runs = Array.isArray(p.runIds)
          ? (p.runIds as unknown[]).map((id) => this.db.getRun(String(id))).filter((r) => r !== null)
          : scopedChatId
            ? this.getRunIdsForChatSession(scopedChatId)
                .map((id) => this.db.getRun(id))
                .filter((r) => r !== null)
                .sort((a, b) => b.createdAt - a.createdAt)
            : this.db.listRuns(limit + 1, before);
        const hasMore = !Array.isArray(p.runIds) && !scopedChatId && runs.length > limit;
        if (hasMore) runs.pop();
        const last = runs.at(-1);
        return {
          next: hasMore && last ? { id: last.id, createdAt: last.createdAt } : undefined,
          generatedAt: Date.now(),
          runs: runs.map((raw) => {
            const run = this.orchestrator.getEffectiveRun(raw.id) ?? raw;
            return {
              run,
              tasks: this.db.listTasks(run.id),
              escalations: this.db.listEscalations(run.id, "open"),
              quotaPause: this.orchestrator.getRunQuotaStatus(run.id),
              activity: buildRunActivitySummary(this.db, run.id),
            };
          }),
        };
      }

      case "work.snapshot": {
        const chatSessionId = typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : undefined;
        const repoRoot = typeof p.repoRoot === "string" && p.repoRoot ? p.repoRoot : undefined;
        const filterRunId = typeof p.runId === "string" && p.runId ? p.runId : undefined;
        const { goals, runIds, runEntries, merges, messages, inbox, internalAttention } =
          this.assembleWorkSnapshotScope({ chatSessionId, repoRoot, runId: filterRunId });
        const runIdSet = new Set(runIds);
        // Always include all open/acked escalations without recency truncation, then append recent resolved ones
        const openEscs = this.db.listAllEscalations({ runIds, status: "open", limit: 500 });
        const ackedEscs = this.db.listAllEscalations({ runIds, status: "acked", limit: 500 });
        const recentEscs = this.db.listAllEscalations({ runIds, limit: 150 });
        const escMap = new Map(openEscs.map((e) => [e.id, e]));
        for (const e of ackedEscs) escMap.set(e.id, e);
        for (const e of recentEscs) if (!escMap.has(e.id)) escMap.set(e.id, e);
        const escalations = [...escMap.values()].sort((a, b) => b.createdAt - a.createdAt);

        const repoChatIds = repoRoot
          ? new Set(this.director.chats.listSessions(200).filter((c) => c.repoRoot === repoRoot).map((c) => c.id))
          : null;
        const timers = this.db.timers
          .list({})
          .filter((t) => {
            if (filterRunId) return t.runId === filterRunId;
            if (chatSessionId) {
              if (t.ownerKind === "chat") return t.ownerId === chatSessionId;
              return t.runId != null && runIdSet.has(t.runId);
            }
            if (repoChatIds) {
              if (t.ownerKind === "chat") return repoChatIds.has(t.ownerId);
              return t.runId != null && runIdSet.has(t.runId);
            }
            return true;
          })
          .slice(0, 100);
        const rawLiveWorktrees = repoRoot
          ? await this.orchestrator.getWorktreeManager(repoRoot).listLive(filterRunId).catch(() => [])
          : [];
        const worktrees: SnapshotWorktreeEntry[] = rawLiveWorktrees
          .filter((wt) => {
            if (wt.orphaned) return true;
            if (!chatSessionId && !filterRunId) return true;
            return wt.record ? runIdSet.has(wt.record.runId) : true;
          })
          .map((wt) => ({
            id: wt.record?.id ?? null,
            runId: wt.record?.runId ?? null,
            taskId: wt.record?.taskId ?? null,
            status: wt.record?.status ?? (wt.orphaned ? "orphaned" : "active"),
            branch: wt.branch ?? "(detached)",
            path: wt.path,
            existsOnDisk: wt.existsOnDisk,
            dirty: wt.dirty,
            orphaned: wt.orphaned,
            archiveRef: wt.record?.archiveRef ?? null,
          }));

        return {
          generatedAt: Date.now(),
          latestSeq: this.db.getLatestEventSeq(),
          goals: goals.map((goal) => ({
            goal,
            reviews: this.director.goals.listReviews(goal.id),
            revisions: this.director.goals.listRevisions(goal.id),
            activeVerification: this.director.getActiveVerification(goal.id),
          })),
          runs: runEntries,
          escalations,
          timers,
          merges,
          worktrees,
          messages,
          inbox,
          internalAttention,
        };
      }

      case "inbox.dismiss": {
        const itemId = typeof p.itemId === "string" ? p.itemId.trim() : "";
        const itemCreatedAt = typeof p.itemCreatedAt === "number" ? p.itemCreatedAt : Number.NaN;
        if (!itemId || !Number.isFinite(itemCreatedAt)) {
          throw new Error("inbox.dismiss requires itemId and numeric itemCreatedAt");
        }
        this.db.dismissInboxItem(itemId, itemCreatedAt);
        return { dismissed: true };
      }

      case "inbox.restore": {
        const itemId = typeof p.itemId === "string" ? p.itemId.trim() : "";
        if (!itemId) {
          throw new Error("inbox.restore requires itemId");
        }
        const restored = this.db.restoreInboxItem(itemId);
        return { restored };
      }

      case "inbox.clear_stale": {
        const chatSessionId = typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : undefined;
        const repoRoot = typeof p.repoRoot === "string" && p.repoRoot ? p.repoRoot : undefined;
        const filterRunId = typeof p.runId === "string" && p.runId ? p.runId : undefined;
        const { inbox } = this.assembleWorkSnapshotScope({ chatSessionId, repoRoot, runId: filterRunId });
        let dismissed = 0;
        const now = Date.now();
        for (const item of inbox) {
          if (item.kind === "run_failed" || item.kind === "merge_bounced") {
            this.db.dismissInboxItem(item.id, item.createdAt, now);
            dismissed += 1;
          }
        }
        return { dismissed };
      }

      case "watch.start":
        return this.startWatch(socket, p);

      case "watch.stop": {
        const map = this.watches.get(socket);
        const stopped = map?.delete(String(p.watchId)) ?? false;
        if (map && map.size === 0) this.watches.delete(socket);
        return { stopped };
      }

      case "task.get": {
        const task = this.db.getTask(String(p.taskId));
        if (!task) throw new Error(`Unknown task ${p.taskId}`);
        const run = this.db.getRun(task.runId);
        const escalations = this.db.listEscalations(task.runId).filter((e) => e.fromTaskId === task.id || e.toTaskId === task.id);
        const artifacts = this.db.listArtifacts(task.runId, task.id, 100);
        const worktree = task.worktreeId ? this.db.getWorktree(task.worktreeId) : null;
        const merges = this.db.listMergeQueue({ runId: task.runId, limit: 50 }).filter((m) => m.taskId === task.id);
        const messages = this.db.listMessagesForRun(task.runId, 50).filter((m) => m.fromTaskId === task.id || m.toTaskId === task.id);
        const children = this.db.listTasks(task.runId, { parentId: task.id });
        const writeScopes = this.db.listAssignedWriteScopes(task.runId, task.id);
        const effectiveRun = run ? (this.orchestrator.getEffectiveRun(run.id) ?? run) : null;
        const handoffStorageCtx = effectiveRun
          ? {
              repoRoot: effectiveRun.repoRoot,
              chatSessionId: this.runRef(effectiveRun).chatSessionId,
              storage: this.storage,
            }
          : undefined;
        return {
          task,
          handoff: compactTaskHandoff(task, escalations, handoffStorageCtx),
          run: effectiveRun,
          escalations,
          artifacts,
          worktree,
          merges,
          messages,
          children,
          writeScopes,
        };
      }

      case "task.steer": {
        const taskId = String(p.taskId);
        const task = this.db.getTask(taskId);
        if (task) this.requireRunControlIfViewer(socket, task.runId);
        return await this.orchestrator.steerTaskDetailed(taskId, String(p.message));
      }

      case "task.cancel": {
        const taskId = String(p.taskId);
        const task = this.db.getTask(taskId);
        if (task) this.requireRunControlIfViewer(socket, task.runId);
        const reason = String(p.reason ?? "Cancelled by user");
        this.director.invalidateQueuedResumeForTask(taskId, reason);
        await this.orchestrator.cancelTask(taskId, reason);
        return { cancelled: true };
      }

      case "escalation.list": {
        const chatSessionId = typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : undefined;
        const runId = typeof p.runId === "string" && p.runId ? p.runId : undefined;
        const status =
          p.status === "open" || p.status === "acked" || p.status === "resolved" || p.status === "unresolved"
            ? p.status
            : undefined;
        const limit =
          typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.max(1, Math.min(1000, Math.floor(p.limit))) : 100;
        const runIds = runId ? [runId] : chatSessionId ? this.getRunIdsForChatSession(chatSessionId) : undefined;
        return this.db.listAllEscalations({ runIds, status, limit });
      }

      case "escalation.get": {
        const esc = this.db.getEscalation(String(p.escalationId));
        if (!esc) throw new Error(`Unknown escalation ${p.escalationId}`);
        const run = this.db.getRun(esc.runId);
        const fromTask = this.db.getTask(esc.fromTaskId);
        const goal = this.director.goals.listGoals().find((g) => g.linkedRunId === esc.runId) ?? null;
        return { escalation: esc, run, fromTask, goal };
      }

      case "escalation.ack": {
        const resolveFlag = p.resolve === undefined ? false : Boolean(p.resolve);
        const resolution = String(p.resolution ?? (resolveFlag ? "Resolved" : "Acknowledged"));
        return this.db.ackEscalation(String(p.escalationId), resolution, resolveFlag);
      }

      case "escalation.resolve": {
        const escalationId = String(p.escalationId ?? "");
        const rawReason = p.reason !== undefined ? p.reason : p.resolution;
        if (typeof rawReason !== "string" || rawReason.trim().length === 0) {
          throw new Error("reason must be a non-empty string");
        }
        let chatSessionId: string | undefined;
        let repoRoot: string | undefined;
        if (p.chatSessionId !== undefined) {
          // A provided session must be real, so a blank or unknown ID never bypasses workspace scoping.
          if (typeof p.chatSessionId !== "string" || p.chatSessionId.trim().length === 0) {
            throw new Error("chatSessionId must be a non-empty string when provided");
          }
          chatSessionId = p.chatSessionId;
          const sess = this.director.chats.getSession(chatSessionId);
          if (!sess) throw new Error(`Unknown chat session ${chatSessionId}`);
          repoRoot = sess.repoRoot;
        }
        return await this.director.resolveEscalation({
          escalationId,
          reason: rawReason,
          chatSessionId,
          repoRoot,
          resolvedBy: "operator",
        });
      }

      case "escalation.reconcile":
        return { mode: "daemon", ...this.db.reconcileSettledGoalEscalations() };

      case "artifact.list": {
        const runId = String(p.runId);
        const taskId = typeof p.taskId === "string" && p.taskId ? p.taskId : undefined;
        return this.db.listArtifacts(runId, taskId, typeof p.limit === "number" ? p.limit : 100);
      }

      case "artifact.read": {
        const run = this.db.getRun(String(p.runId));
        if (!run) throw new Error(`Unknown run ${p.runId}`);
        const runRef = this.runRef(run);
        const storage = this.storage;
        const reqPath = typeof p.path === "string" && p.path ? p.path : undefined;
        const maxChars = typeof p.maxChars === "number" ? p.maxChars : 16_000;
        const offset = typeof p.offset === "number" ? p.offset : 0;
        try {
          return readRunDossier(
            this.db,
            runRef,
            {
              path: reqPath,
              task_id: typeof p.taskId === "string" ? p.taskId : undefined,
              max_chars: maxChars,
              offset,
            },
            storage,
          );
        } catch (err) {
          if (!reqPath) throw err;
          // Allow reading any indexed non-dossier artifact belonging to this run safely within its workspace
          const indexed = this.db.listArtifacts(run.id, typeof p.taskId === "string" ? p.taskId : undefined, 200);
          const match = indexed.find((a) => a.path === reqPath);
          if (!match) throw err;
          const task = this.db.getTask(match.taskId);
          const wt = task?.worktreeId ? this.db.getWorktree(task.worktreeId) : null;
          const root = wt && existsSync(wt.path) ? wt.path : run.repoRoot;
          if (storage.layout === "data-dir") {
            if (match.kind === "dossier") throw err;
            const deniedRoots = [
              ...(this.config.stateDir?.trim() ? [canonicalPath(this.config.stateDir)] : []),
              ...(storage.dataRoot ? [storage.dataRoot] : []),
            ];
            const policy: WorkspaceArtifactPolicy = {
              deniedRoots: [...new Set(deniedRoots)],
            };
            return readWorkspaceArtifact(root, reqPath, maxChars, offset, storage, policy);
          }
          return readWorkspaceArtifact(root, reqPath, maxChars, offset, storage);
        }
      }

      case "timer.list": {
        const status =
          p.status === "pending" || p.status === "fired" || p.status === "cancelled" ? p.status : undefined;
        const ownerKind = p.ownerKind === "chat" || p.ownerKind === "task" ? p.ownerKind : undefined;
        const ownerId = typeof p.ownerId === "string" && p.ownerId ? p.ownerId : undefined;
        const limit = typeof p.limit === "number" ? p.limit : 100;
        return this.db.timers.list({ ownerKind, ownerId, status }).slice(0, limit);
      }

      case "timer.cancel": {
        const cancelled = this.db.timers.cancel(
          String(p.timerId),
          typeof p.reason === "string" ? p.reason : "cancelled_by_user",
        );
        if (!cancelled) throw new Error(`Unknown timer ${p.timerId}`);
        return { timer: cancelled };
      }

      case "merge.list": {
        const runId = typeof p.runId === "string" && p.runId ? p.runId : undefined;
        const chatSessionId = typeof p.chatSessionId === "string" && p.chatSessionId ? p.chatSessionId : undefined;
        const runIds = !runId && chatSessionId ? this.getRunIdsForChatSession(chatSessionId) : undefined;
        return this.db.listMergeQueue({ runId, runIds, limit: typeof p.limit === "number" ? p.limit : 100 });
      }

      case "messages.list": {
        const runId = String(p.runId);
        return this.db.listMessagesForRun(runId, typeof p.limit === "number" ? p.limit : 50);
      }

      case "event.get": {
        const seq = Number(p.seq);
        if (!Number.isFinite(seq) || seq <= 0) throw new Error("event.get requires a positive seq number");
        const ev = this.db.getEventBySeq(seq);
        if (!ev) throw new Error(`Unknown event seq ${seq}`);
        return ev;
      }

      case "models.list": {
        this.quota.harvestLocal(this.config.profiles);
        const chatSessionId =
          typeof p.chatSessionId === "string" && p.chatSessionId
            ? p.chatSessionId
            : (this.socketToChatId.get(socket) ?? null);
        const catalog = await this.catalog.getCatalog({
          cwd: typeof p.cwd === "string" ? p.cwd : process.cwd(),
          role: typeof p.role === "string" ? p.role : undefined,
          excludeExhausted: Boolean(p.excludeExhausted),
          includeDisabled: Boolean(p.includeDisabled),
        });
        const sessionModelContext = chatSessionId ? this.director.chats.getModelSelectionContext(chatSessionId) : null;
        return { ...catalog, sessionModelContext };
      }

      case "models.sync": {
        this.quota.harvestLocal(this.config.profiles, { force: true });
        const chatSessionId =
          typeof p.chatSessionId === "string" && p.chatSessionId
            ? p.chatSessionId
            : (this.socketToChatId.get(socket) ?? null);
        const catalog = await this.catalog.sync(typeof p.cwd === "string" ? p.cwd : process.cwd());
        const sessionModelContext = chatSessionId ? this.director.chats.getModelSelectionContext(chatSessionId) : null;
        return { ...catalog, sessionModelContext };
      }

      case "quota.get":
        this.quota.harvestLocal(this.config.profiles);
        await this.quota.sync(false).catch(() => {});
        return {
          snapshot: this.quota.getEffectiveSnapshotJson(),
          configured: Boolean(this.config.quotaEndpoint?.url),
          coverage: this.quota.getProfileQuotaCoverage(this.config.profiles),
        };

      case "quota.sync":
        this.quota.harvestLocal(this.config.profiles, { force: true });
        if (this.config.quotaEndpoint?.url) {
          await this.quota.sync(true);
        }
        return {
          snapshot: this.quota.getEffectiveSnapshotJson(),
          configured: Boolean(this.config.quotaEndpoint?.url),
          coverage: this.quota.getProfileQuotaCoverage(this.config.profiles),
        };

      case "cost.get": {
        const runId = typeof p.runId === "string" && p.runId ? p.runId : null;
        const chatSessionId =
          typeof p.chatSessionId === "string" && p.chatSessionId
            ? p.chatSessionId
            : runId
              ? this.getChatSessionIdForRun(runId)
              : (this.socketToChatId.get(socket) ?? null);
        if (chatSessionId) {
          const session = this.director.chats.getSession(chatSessionId);
          if (!session) throw new Error(`Unknown chat session: ${chatSessionId}`);
          return summarizeCost(
            this.db,
            { chatSessionId, runIds: this.getRunIdsForChatSession(chatSessionId), snapshotScope: { kind: "chat", id: chatSessionId, label: session.title } },
            this.config.profiles,
          );
        }
        const run = runId ? this.db.getRun(runId) : null;
        if (!runId || !run) throw new Error(`Unknown run: ${runId ?? "(none)"}`);
        return summarizeCost(this.db, { chatSessionId: null, runIds: [runId], snapshotScope: { kind: "run", id: runId, label: run.goal } }, this.config.profiles);
      }

      case "worktrees.list": {
        const repoRoot = String(p.repoRoot ?? process.cwd());
        return await this.orchestrator.getWorktreeManager(repoRoot).listLive(typeof p.runId === "string" ? p.runId : undefined);
      }

      case "worktrees.get": {
        const wt = this.db.getWorktree(String(p.worktreeId));
        if (!wt) throw new Error(`Unknown worktree ${p.worktreeId}`);
        const run = this.db.getRun(wt.runId);
        const task = this.db.getTask(wt.taskId);
        let statusOut = "";
        let diffStat = "";
        if (existsSync(wt.path)) {
          statusOut = await runGit(wt.path, ["status", "--short"]).then((r) => r.stdout).catch(() => "");
          diffStat = await runGit(wt.path, ["diff", "--stat", wt.baseSha]).then((r) => r.stdout).catch(() => "");
        }
        return { worktree: wt, run, task, existsOnDisk: existsSync(wt.path), gitStatus: statusOut, diffStat };
      }

      case "worktrees.clean": {
        const repoRoot = String(p.repoRoot ?? process.cwd());
        const mgr = this.orchestrator.getWorktreeManager(repoRoot);
        if (typeof p.worktreeId === "string" && p.worktreeId) {
          const wt = this.db.getWorktree(p.worktreeId);
          if (!wt) throw new Error(`Unknown worktree ${p.worktreeId}`);
          const run = this.db.getRun(wt.runId);
          if (!run) throw new Error(`Worktree ${p.worktreeId} has no owning run`);
          if (canonicalPath(run.repoRoot) !== canonicalPath(repoRoot)) {
            throw new Error(`Worktree ${p.worktreeId} belongs to ${run.repoRoot}, not ${repoRoot}`);
          }
          const task = this.db.getTask(wt.taskId);
          const settled = Boolean(task && ["completed", "failed", "cancelled"].includes(task.status));
          if (!settled && !Boolean(p.force)) {
            throw new Error(
              task
                ? `Cannot remove worktree ${p.worktreeId}: task ${task.id} is still ${task.status}`
                : `Cannot remove worktree ${p.worktreeId}: owning task ${wt.taskId} record is missing`,
            );
          }
          const wasCleaned = wt.cleanedAt != null;
          if (!settled && !wasCleaned && !existsSync(wt.path)) {
            throw new Error(`Cannot remove offline active worktree ${p.worktreeId}: checkout directory is missing; left in place`);
          }
          const ref = await mgr.teardown(p.worktreeId, {
            archiveBeforeRemove: true,
            requireArchive: true,
            finalStatus: "archived",
          });
          return {
            removed: wasCleaned ? [] : [p.worktreeId],
            archivedRefs: ref ? [ref] : [],
            expiredArchiveRefs: [],
            skipped: [],
            errors: [],
          };
        }
        return await mgr.sweep({
          runId: typeof p.runId === "string" ? p.runId : undefined,
          forceAll: Boolean(p.forceAll),
        });
      }

      case "pty.open": {
        const cwd = String(p.cwd ?? process.cwd());
        const info = this.ptyHost.open({
          cwd,
          cols: typeof p.cols === "number" ? p.cols : undefined,
          rows: typeof p.rows === "number" ? p.rows : undefined,
        });
        const { snapshot, detach } = this.ptyHost.attach(info.id, (chunk) => {
          writeDaemonMessage(socket, {
            kind: "event",
            seq: 0,
            runId: "pty",
            taskId: info.id,
            type: "pty.output",
            payload: { chunk },
            createdAt: Date.now(),
          } satisfies DaemonEventFrame);
        });
        let map = this.ptyDetachFns.get(socket);
        if (!map) {
          map = new Map();
          this.ptyDetachFns.set(socket, map);
        }
        map.set(info.id, detach);
        return { info, snapshot };
      }

      case "pty.input":
        this.ptyHost.write(String(p.ptyId), String(p.data));
        return { ok: true };

      case "pty.resize":
        this.ptyHost.resize(String(p.ptyId), Number(p.cols), Number(p.rows));
        return { ok: true };

      case "pty.close":
        this.ptyHost.close(String(p.ptyId));
        return { ok: true };

      case "tool.call": {
        // An orchestrator task's bridge sends `<taskId>@g<generation>@<nonce>` (see AcpRunner).
        const rawTaskId = String(p.taskId);
        const token = /^(.+?)@g(\d+)(?:@([0-9a-f]+))?$/.exec(rawTaskId);
        if (token && token[3] !== this.instanceNonce) {
          throw new Error(
            `Stale tool call for task ${token[1]}: this agent session belongs to a previous harnessd process (the daemon restarted). Nothing was executed. The task continues in a new session. End this session.`,
          );
        }
        const taskId = token ? token[1]! : rawTaskId;
        const expectedGeneration = p.expectedGeneration ?? (token ? Number(token[2]) : undefined);
        const name = String(p.name);
        const args = (p.args ?? {}) as Record<string, unknown>;
        if (taskId.startsWith("chat-")) {
          return await this.director.executeDirectorMcpTool(taskId, name, args);
        }
        if (this.director.hasActiveReviewer(taskId)) {
          return await this.director.executeReviewerMcpTool(taskId, name, args);
        }
        // A bridge started for an older generation (evicted, cancelled, rolled over or resumed runner) is refused.
        if (expectedGeneration !== undefined && expectedGeneration !== null) {
          this.orchestrator.assertCurrentToolGeneration(taskId, Number(expectedGeneration));
        }
        return await this.orchestrator.toolExecutor.execute(String(p.runId), taskId, name, args);
      }

      default:
        throw new Error(`Unknown daemon op: ${req.op}`);
    }
  }
}

/** Goal lifecycle events the Director itself caused; they never wake (or re-wake) the Director. */
function isDirectorSourcedGoalEvent(event: ChatControlEvent): boolean {
  return (event.kind === "goal.settled" || event.kind === "goal.reviewed") && event.source === "director";
}
