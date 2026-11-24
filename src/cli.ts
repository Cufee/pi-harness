#!/usr/bin/env bun
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import type { Terminal } from "@earendil-works/pi-tui";
import { ControlPlaneDb, type EscalationRecord } from "./control-plane/db.js";
import { findProjectContainingPath, type ProjectBrowseResult, type ProjectSummary } from "./control-plane/projects.js";
import { classifyInterruptedTasks, formatRecoveryPlan } from "./control-plane/restart-recovery.js";
import { ensureTempDir, loadConfig, type AcpProfileConfig } from "./config.js";
import { loadOrCreateNodeId } from "./control-plane/session-messages.js";
import { qualifyRemoteCliHints } from "./protocol/chat-events.js";
import { ensureLocalDaemon, stopLocalDaemon } from "./daemon/launch.js";
import { runDaemonReloadCli, tryReloadForDaemonRestart } from "./daemon/hot-update.js";
import type { RemoteHostStatus } from "./daemon/peer.js";
import { DaemonClient, runStdioSocketBridge } from "./daemon/remote.js";
import { HarnessDaemon } from "./daemon/server.js";
import { runSupervisor, type SuperviseOptions } from "./daemon/supervise.js";
import { runDirectorChatTui, runNativeScrollbackTui, type TuiExitAction } from "./tui/app.js";
import { parseDurationMs } from "./tui/core/index.js";
import { type FederatedProjectSummary, pickProjectTui } from "./tui/projects.js";
import type { AttachableSession } from "./tui/store.js";

export { ensureLocalDaemon };

const BOOLEAN_SHORT_FLAGS = new Set(["h"]);
const BOOLEAN_LONG_FLAGS = new Set([
  "help",
  "json",
  "init",
  "detach",
  "all",
  "no-reply",
  "expect-reply",
  "no-connect",
  "no-auto-connect",
  "no-create",
  "exclude-exhausted",
  "direct",
  "dry-run",
  "resume",
  "now",
  "wait",
  "check",
  "from-install",
  "legacy",
  "yes",
  "supervise",
]);

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** Index in `positional` of the first argument that followed a literal `--`; null when argv had no `--`. */
  doubleDashAt: number | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  let doubleDashAt: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      doubleDashAt = positional.length;
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_LONG_FLAGS.has(key) && next && !next.startsWith("-")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (/^-[A-Za-z]$/.test(arg)) {
      const key = arg.slice(1);
      const next = argv[i + 1];
      if (!BOOLEAN_SHORT_FLAGS.has(key) && next && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, doubleDashAt };
}

function requireStringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.trim()) {
    throw new Error(`Flag --${name} requires a value`);
  }
  return v.trim();
}

// Canonical legacy IDs match verbatim (even all-digit ones); other 8-hex spellings need a hex letter so they cannot shadow friendly numeric IDs.
const RUN_CANONICAL_LEGACY_HEX_ID_RE = /^run-[0-9a-f]{8}$/;
const RUN_ALPHA_LEGACY_HEX_ID_RE = /^run[-_](?=[0-9a-f]*[a-f])([0-9a-f]{8})$/i;
const RUN_NUMERIC_ID_RE = /^run[_\s-]+(\d+)$/i;

/** Canonical run ID for a token that names a run (legacy 8-hex or friendly numeric form), else null. */
function matchRunIdToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (RUN_CANONICAL_LEGACY_HEX_ID_RE.test(trimmed)) return trimmed;
  const alphaLegacy = RUN_ALPHA_LEGACY_HEX_ID_RE.exec(trimmed);
  if (alphaLegacy) return `run-${alphaLegacy[1]!.toLowerCase()}`;
  const numeric = RUN_NUMERIC_ID_RE.exec(trimmed);
  if (numeric) return `run-${numeric[1]!.replace(/^0+(?=\d)/, "")}`;
  return null;
}

/** Normalizes an attach target token to a canonical run ID if it names a run (case-insensitive), else null. */
export function normalizeAttachRunId(raw: string): string | null {
  const trimmed = raw.trim();
  const normalized = trimmed.replace(/^run[-_]/i, "run-");
  const matched = matchRunIdToken(normalized);
  if (matched) return matched;
  if (normalized.startsWith("run-") && normalized.length > 4) {
    return normalized;
  }
  return null;
}

const RUN_CREATE_ONLY_FLAGS = ["profile", "model", "effort"] as const;
const RUN_RESUME_USAGE = [
  'Usage: pi-harness run resume <run-id> [--in 15m | --message "<msg>"]',
  'To start a new run whose goal begins with "resume", quote a multi-word goal or use: pi-harness run -- resume ...',
].join("\n");

/**
 * Returns the run ID when argv is `run resume <run-id>`, null when argv is an ordinary `run <goal...>`.
 * Throws a usage Error when a resume was evidently intended but the command is malformed, so an
 * attempted resume never falls through to creating a new run.
 */
export function resolveRunResumeAlias(parsed: ParsedArgs): string | null {
  const { positional, flags, doubleDashAt } = parsed;
  if (positional[0] !== "run" || positional[1] !== "resume") return null;
  if (doubleDashAt !== null && doubleDashAt <= 1) return null;
  const rest = positional.slice(2);
  const first = rest[0]?.trim() ?? "";
  const matchedRunId = rest.length > 0 ? matchRunIdToken(first) : null;
  const hasResumeFlag = flags.in !== undefined || flags.message !== undefined;
  if (!matchedRunId || rest.length !== 1) {
    const allBlank = rest.every((t) => !t.trim());
    const isBareNumber = rest.length === 1 && /^#?\d+$/.test(first);
    const hasDoubleDashThenId =
      rest.length > 1 &&
      rest[0] === "--" &&
      rest.slice(1).some((t) => {
        const trimmed = t.trim();
        return matchRunIdToken(trimmed) !== null || /^#?\d+$/.test(trimmed);
      });
    if (allBlank || hasResumeFlag || matchedRunId !== null || isBareNumber || hasDoubleDashThenId) {
      throw new Error(RUN_RESUME_USAGE);
    }
    return null;
  }
  const conflicting = RUN_CREATE_ONLY_FLAGS.filter((k) => flags[k] !== undefined);
  if (conflicting.length > 0) {
    throw new Error(
      `${conflicting.map((k) => `--${k}`).join(", ")} cannot be used with \`pi-harness run resume\`: ${conflicting.length > 1 ? "they apply" : "it applies"} only when creating a new run.`,
    );
  }
  return matchedRunId;
}

async function handleResumeCommand(
  client: Pick<DaemonClient, "request">,
  runId: string | undefined,
  flags: Record<string, string | boolean>,
  remoteSelector?: string | null,
): Promise<void> {
  const trimmedRunId = runId?.trim();
  if (!trimmedRunId) throw new Error('Usage: pi-harness resume <run-id> [--in 15m | --message "<msg>"]');
  const delaySpec = requireStringFlag(flags, "in");
  const message = requireStringFlag(flags, "message");
  if (delaySpec && message) {
    throw new Error("--in and --message cannot be combined: scheduled resumes do not accept a message.");
  }
  if (delaySpec) {
    const delayMs = parseDurationMs(delaySpec);
    if (!delayMs) throw new Error(`Invalid duration for --in: ${delaySpec} (examples: 30s, 15m, 1h30m)`);
    console.log(JSON.stringify(await client.request("run.schedule_resume", { runId: trimmedRunId, delayMs }), null, 2));
    return;
  }
  const res = await client.request<Record<string, unknown>>("run.resume", { runId: trimmedRunId, message });
  // Lead with the idempotent outcome and its message (resumed, already_active, already_completed, nothing_to_resume).
  const { outcome, message: rawMessage, ...rest } = res ?? {};
  // Hints in the daemon's message name its own CLI; qualify them so they reach the same remote daemon.
  const resultMessage = typeof rawMessage === "string" ? qualifyRemoteCliHints(rawMessage, remoteSelector) : rawMessage;
  console.log(JSON.stringify({ ...(outcome !== undefined ? { outcome, message: resultMessage } : {}), ...rest }, null, 2));
}

function resolveRemoteSpec(
  rawRemote: string | undefined,
  remotes: ReadonlyArray<{ name: string; sshTarget: string; bridgeCommand?: string }> | undefined,
): { target?: string; bridgeCommand?: string; hostLabel: string | null; selector: string | null } {
  // `hostLabel` is for display; `selector` is what `--remote` must be given to reconnect to the same daemon.
  if (!rawRemote || rawRemote.trim().toLowerCase() === "local") {
    return { target: undefined, hostLabel: null, selector: null };
  }
  const trimmed = rawRemote.trim();
  const saved = remotes?.find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  if (saved) {
    return { target: saved.sshTarget, bridgeCommand: saved.bridgeCommand, hostLabel: saved.name, selector: saved.name };
  }
  if (trimmed.startsWith("ssh://")) {
    try {
      const u = new URL(trimmed);
      return { target: trimmed, hostLabel: u.hostname || trimmed, selector: trimmed };
    } catch {
      return { target: trimmed, hostLabel: trimmed, selector: trimmed };
    }
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("./")) {
    return { target: trimmed, hostLabel: trimmed, selector: trimmed };
  }
  return {
    target: `ssh://${trimmed}`,
    hostLabel: trimmed.includes("@") ? trimmed.split("@")[1]! : trimmed,
    selector: trimmed,
  };
}

type ReconcileResult = ReturnType<ControlPlaneDb["reconcileSettledGoalEscalations"]>;

/** Reconciles settled-goal escalations straight against a control-plane SQLite file, without a daemon. */
function reconcileEscalationsDirect(dbPath: string): ReconcileResult {
  // ControlPlaneDb creates missing files, so check first.
  if (!existsSync(dbPath)) throw new Error(`Control-plane database not found at ${dbPath}`);
  const db = new ControlPlaneDb(dbPath);
  try {
    return db.reconcileSettledGoalEscalations();
  } finally {
    db.close();
  }
}

function printReconcileResult(out: { mode: string } & ReconcileResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`Reconciled ${out.resolved} escalation(s) across ${out.goals} goal(s) and ${out.runs} run(s) [mode: ${out.mode}].`);
  for (const item of out.items) {
    console.log(`  ${item.escalationId}  run=${item.runId}  goal=${item.goalId} (${item.goalStatus})  was ${item.previousStatus}`);
  }
}

async function connectClient(configSocketPath: string, remoteTarget?: string, bridgeCommand?: string): Promise<DaemonClient> {
  if (!remoteTarget) {
    return await ensureLocalDaemon(configSocketPath);
  }
  const client = new DaemonClient(remoteTarget, bridgeCommand);
  await client.connect();
  return client;
}

function printHelp(): void {
  console.log(`pi-harness — CLI-first, daemonized interactive Director + 3-tier multi-agent coding harness

Usage:
  pi-harness [--resume] [-p <project>] [--remote <alias|ssh://host>]
                                                    Open the project picker; --resume opens the local project containing
                                                    the current directory; -p/--repo open directly; --remote always picks
  pi-harness remotes | remote [list | add <name> <ssh> | rm <name> | connect <name> | disconnect <name>]
                                                    Manage remote SSH peer hosts
  pi-harness projects [--host <name>] [--json]      List local & connected remote projects
  pi-harness project list [--host <name>] [--json]  List registered projects
  pi-harness project add <path> [--name n] [--host <name>] [--init] [--clone <url>]
                                                    Register or create a project folder/repo (~ expands on target host)
  pi-harness project use <[host:]name|id|path> [--host <name>]
                                                    Open Director Chat bound to a project
  pi-harness project rm <name|id> [--host <name>]   Unregister a project (never deletes files on disk)
  pi-harness project browse [path] [--host <name>]  Browse directories on local or remote host
  pi-harness attach [session-or-run-id]             Attach to & take input control of last active session (or specific chat-/run- ID)
  pi-harness sessions [--host <name>] [--json]      List local & connected remote Director Chat & run sessions
  pi-harness chat [--resume] [-p <project>] [--remote <alias|ssh://host>]
  pi-harness chat send <target> "<message>" [--from <chat-id>] [--no-reply]
                                                    Send a message to any local (chat-1) or remote (gpu-box:chat-4) chat
  pi-harness goals [list | review <id> | pause <id> | cancel <id>]
  pi-harness escalations [list] [--status open|acked|resolved|all] [--run <run-id>] [--limit <n>] [--json] [--remote <alias|ssh://host>]
  pi-harness escalations reconcile [--direct [--db <path>]] [--json] [--remote <alias|ssh://host>]
  pi-harness escalations resolve <escalation-id> --reason "<text>" [--json] [--remote <alias|ssh://host>]
  pi-harness profiles [list | add <id> <cmd> [args...] | remove <id> | probe <id>]
  pi-harness daemon serve | status | stop | restart [--remote <alias|ssh://host>]
  pi-harness daemon reload [--now] [--wait] [--check] [--target <dir>] [--from-install]
  pi-harness daemon reload --legacy [--yes] [--wait] [--previous <dir>] [--target <dir>] [--db <path>]
  pi-harness daemon recover --dry-run [--db <path>] [--json]
  pi-harness run "<goal>" [-p <project>] [--profile id] [--model id] [--effort level] [--detach] [--remote <alias|ssh://host>]
  pi-harness run resume <run-id> [--in 15m | --message "<msg>"] [--remote <alias|ssh://host>]
                                                    Alias for \`pi-harness resume\`; to start a new run whose goal begins
                                                    with "resume", quote a multi-word goal or use \`pi-harness run -- resume ...\`
  pi-harness runs [--json] [--remote <alias|ssh://host>]
  pi-harness tree <run-id> [--remote <alias|ssh://host>]
  pi-harness steer <task-id> "<message>" [--remote <alias|ssh://host>]
  pi-harness resume <run-id> [--in 15m | --message "<msg>"] [--remote <alias|ssh://host>]
  pi-harness stop <run-id> [--remote <alias|ssh://host>]
  pi-harness models [list | sync] [--role name] [--remote <alias|ssh://host>]
  pi-harness quota [show | sync] [--remote <alias|ssh://host>]
  pi-harness worktrees [list | clean [--all]] [--remote <alias|ssh://host>]
  pi-harness bridge                                 (stdio <-> local Unix socket bridge for remote SSH attach)
`);
}

type ChatStart = {
  kind: "chat";
  repoRoot?: string;
  projectId?: string;
  chatSessionId?: string;
  preferLastGlobal?: boolean;
  preferLastProject?: boolean;
};

type StartNotice = { tone: "info" | "warn" | "danger" | "ok"; text: string };
type PickerStart = { kind: "picker"; repoRoot?: string; notice?: StartNotice };

export function resolveLocalStartup(input: {
  cwd: string;
  explicitRepoRoot?: string;
  projectFlag?: string;
  resume: boolean;
  projects: ReadonlyArray<{ id: string; rootPath: string }>;
}): ChatStart | PickerStart {
  if (input.explicitRepoRoot) {
    return {
      kind: "chat",
      repoRoot: input.explicitRepoRoot,
      ...(input.projectFlag ? { projectId: input.projectFlag } : {}),
    };
  }
  if (input.projectFlag) {
    return { kind: "chat", projectId: input.projectFlag };
  }
  if (input.resume) {
    const match = findProjectContainingPath(input.projects, input.cwd);
    if (match) {
      return { kind: "chat", projectId: match.id, repoRoot: match.rootPath };
    }
    return {
      kind: "picker",
      notice: {
        tone: "warn",
        text: `--resume: no registered project contains ${input.cwd}. Pick a project, or press n to add one.`,
      },
    };
  }
  return { kind: "picker" };
}

/**
 * Lets the user pick one of the daemon host's own projects. Always opens the picker
 * (even when empty so the user can add or browse); resolves to `null` when cancelled.
 */
export async function chooseRemoteProject(
  client: DaemonClient,
  hostLabel: string | null,
  opts?: { terminal?: Terminal },
): Promise<ChatStart | null> {
  await client.request("tui.register").catch(() => {});
  const projects = await client.request<FederatedProjectSummary[]>("project.list", { includeRemotes: false });
  const picked = await pickProjectTui({
    client,
    currentHost: hostLabel,
    initialProjects: projects,
    includeRemotes: false,
    ...(opts?.terminal ? { terminal: opts.terminal } : {}),
  });
  return picked ? { kind: "chat", projectId: picked.id, repoRoot: picked.rootPath } : null;
}

export async function probeHostSwitchClient(opts: {
  connect: () => Promise<DaemonClient>;
  targetHostLabel: string;
  expectedNodeId?: string | null;
}): Promise<DaemonClient> {
  const nextClient = await opts.connect();
  try {
    if (opts.expectedNodeId) {
      const info = await nextClient.request<{ nodeId?: string }>("ping");
      if (info.nodeId && info.nodeId !== opts.expectedNodeId) {
        throw new Error(
          `Remote "${opts.targetHostLabel}" resolved to node ${info.nodeId}, expected ${opts.expectedNodeId} (alias mismatch)`,
        );
      }
    }
    return nextClient;
  } catch (err) {
    // Never send session.leave on a failed unregistered probe; an idle auto-quit daemon on the wrong host could shut down.
    nextClient.close();
    throw err;
  }
}

async function runInteractiveSessionLoop(
  initialClient: DaemonClient,
  initial: ChatStart | PickerStart | { kind: "run"; repoRoot?: string; runId: string; initialTaskId?: string | null },
  hostCtx: {
    localSocketPath: string;
    localNodeId: string;
    remoteHost: string | null;
    remoteSelector?: string | null;
    getRemotes: () => ReadonlyArray<{ name: string; sshTarget: string; bridgeCommand?: string }> | undefined;
  },
): Promise<void> {
  let client = initialClient;
  let current = initial;
  let currentRemoteHost = hostCtx.remoteHost;
  let currentRemoteSelector = hostCtx.remoteSelector ?? hostCtx.remoteHost;
  let pendingNotice: StartNotice | null = initial.kind === "picker" ? initial.notice ?? null : null;

  try {
    while (true) {
      const localRemotes = hostCtx.getRemotes() ?? [];
      const noticeForTurn = pendingNotice;
      pendingNotice = null;
      let action: TuiExitAction;
      if (current.kind === "picker") {
        await client.request("tui.register").catch(() => {});
        const picked = await pickProjectTui({
          client,
          currentHost: currentRemoteHost,
          includeRemotes: !currentRemoteHost,
          initialNotice: noticeForTurn,
        });
        if (!picked) {
          await client.request("session.leave").catch(() => {});
          return;
        }
        const pickedHost = picked.host && picked.host !== "local" ? picked.host : undefined;
        action = {
          kind: "switch",
          targetKind: "chat",
          targetId: "__project__",
          projectId: picked.id,
          repoRoot: picked.rootPath,
          ...(pickedHost ? { targetHost: pickedHost } : {}),
          ...(picked.nodeId ? { targetNodeId: picked.nodeId } : {}),
        };
      } else if (current.kind === "chat") {
        action = await runDirectorChatTui({
          client,
          remoteHost: currentRemoteHost,
          remoteSelector: currentRemoteSelector,
          localRemotes,
          initialNotice: noticeForTurn,
          repoRoot: current.repoRoot,
          projectId: current.projectId,
          chatSessionId: current.chatSessionId,
          preferLastGlobal: current.preferLastGlobal,
          preferLastProject: current.preferLastProject,
        });
      } else {
        action = await runNativeScrollbackTui({
          client,
          remoteHost: currentRemoteHost,
          remoteSelector: currentRemoteSelector,
          localRemotes,
          initialNotice: noticeForTurn,
          runId: current.runId,
          initialTaskId: current.initialTaskId,
        });
      }
      if (action.kind === "exit") return;

      // Handle cross-host switch (local <-> saved remote peer host) safely:
      //  - Map any row belonging to our own local nodeId back to "local"
      //  - Only permit "local" or an explicitly configured local remote alias (never execute arbitrary daemon-supplied strings!)
      //  - Connect BEFORE closing the current client so failures keep the user safely inside the TUI
      let hostStart: ChatStart | null = null;
      const effectiveTargetHost =
        action.targetNodeId && action.targetNodeId === hostCtx.localNodeId ? "local" : action.targetHost;
      if (effectiveTargetHost) {
        const remotesNow = hostCtx.getRemotes() ?? [];
        const isLocal = effectiveTargetHost.trim().toLowerCase() === "local";
        const matchedRemote = remotesNow.find((r) => r.name.toLowerCase() === effectiveTargetHost.trim().toLowerCase());
        if (!isLocal && !matchedRemote) {
          pendingNotice = {
            tone: "danger",
            text: `Cannot switch to unknown host "${effectiveTargetHost}" — add it to your local remotes first (/remotes).`,
          };
          continue;
        }
        const nextHostLabel = isLocal ? null : matchedRemote!.name;
        const nextTarget = isLocal ? undefined : matchedRemote!.sshTarget;
        const nextBridgeCommand = isLocal ? undefined : matchedRemote!.bridgeCommand;
        let nextClient: DaemonClient | null = null;
        try {
          if (nextHostLabel !== currentRemoteHost) {
            nextClient = await probeHostSwitchClient({
              connect: () => connectClient(hostCtx.localSocketPath, nextTarget, nextBridgeCommand),
              targetHostLabel: effectiveTargetHost,
              expectedNodeId: action.targetNodeId,
            });
          }
          // Cancelling the remote project picker keeps the current connection and session
          if (action.targetId === "__host__" && nextHostLabel) {
            hostStart = await chooseRemoteProject(nextClient ?? client, nextHostLabel);
            if (!hostStart) {
              if (nextClient) {
                await nextClient.request("session.leave").catch(() => {});
                nextClient.close();
              }
              continue;
            }
          }
          if (nextClient) {
            await client.request("session.leave").catch(() => {});
            client.close();
            client = nextClient;
            currentRemoteHost = nextHostLabel;
            currentRemoteSelector = nextHostLabel;
          }
        } catch (err) {
          if (nextClient) {
            // Close without session.leave; daemon disconnect cleanup releases registered sockets without stopping unregistered idle hosts.
            nextClient.close();
          }
          pendingNotice = {
            tone: "danger",
            text: `Failed to connect to "${effectiveTargetHost}": ${err instanceof Error ? err.message : String(err)}`,
          };
          continue;
        }
      }

      if (action.targetKind === "run") {
        current = { kind: "run", repoRoot: action.repoRoot ?? current.repoRoot, runId: action.targetId, initialTaskId: action.taskId };
      } else if (action.targetId === "__host__") {
        current = hostStart ?? { kind: "chat", preferLastGlobal: true };
      } else if (action.targetId === "__project__" && action.projectId) {
        current = { kind: "chat", projectId: action.projectId, repoRoot: action.repoRoot };
      } else if (action.targetId === "__new__") {
        const created = await client.request<{ session: { id: string; repoRoot: string; projectId?: string | null } }>("chat.create", {
          ...(current.kind === "chat" && current.projectId ? { projectId: current.projectId } : {}),
          ...(current.repoRoot ? { repoRoot: current.repoRoot } : {}),
          ...(action.title ? { title: action.title } : {}),
        });
        current = {
          kind: "chat",
          repoRoot: created.session.repoRoot,
          projectId: created.session.projectId ?? undefined,
          chatSessionId: created.session.id,
        };
      } else {
        current = {
          kind: "chat",
          repoRoot: action.repoRoot ?? current.repoRoot,
          projectId: action.projectId,
          chatSessionId: action.targetId,
        };
      }
    }
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const { positional, flags } = parsed;
  const cmd = positional[0];
  if (cmd === "help" || flags.help || flags.h) {
    printHelp();
    return;
  }
  if (cmd === "daemon" && positional[1] === "reload" && flags.supervise === true) {
    const rawOpts = requireStringFlag(flags, "options-json");
    if (!rawOpts) throw new Error("Missing --options-json for --supervise");
    const supOpts = JSON.parse(rawOpts) as SuperviseOptions;
    const code = await runSupervisor(supOpts);
    process.exit(code);
  }

  const rawRemote = requireStringFlag(flags, "remote");
  const hostFlag = requireStringFlag(flags, "host");
  if (Object.prototype.hasOwnProperty.call(flags, "p") && (typeof flags.p !== "string" || !flags.p.trim())) {
    throw new Error("Flag -p requires a project name/id/path");
  }
  const projectFlag = requireStringFlag(flags, "project") ?? (typeof flags.p === "string" ? flags.p.trim() : undefined);
  const explicitRepoFlag = requireStringFlag(flags, "repo");
  let overlayRootEnv: string | undefined;
  let socketPathEnv: string | undefined;
  if (cmd === "daemon" && positional[1] === "serve") {
    overlayRootEnv = process.env.PI_HARNESS_OVERLAY_ROOT?.trim() || undefined;
    delete process.env.PI_HARNESS_OVERLAY_ROOT;
    socketPathEnv = process.env.PI_HARNESS_SOCKET_PATH?.trim() || undefined;
    delete process.env.PI_HARNESS_SOCKET_PATH;
  }
  const rawRepoRoot = explicitRepoFlag ?? overlayRootEnv ?? process.cwd();
  let repoRoot: string;
  try {
    repoRoot = realpathSync(rawRepoRoot);
  } catch {
    repoRoot = resolve(rawRepoRoot);
  }
  const config = loadConfig(repoRoot, socketPathEnv ? { socketPath: resolve(socketPathEnv) } : undefined);
  const remoteSpec = resolveRemoteSpec(rawRemote, config.remotes);
  const hostCtx = {
    localSocketPath: config.socketPath,
    localNodeId: loadOrCreateNodeId(config.stateDir),
    remoteHost: remoteSpec.hostLabel,
    remoteSelector: remoteSpec.selector,
    getRemotes: () => loadConfig(repoRoot).remotes,
  };

  // `pi-harness chat send <target> "<message>"` — non-interactive cross-session / remote message delivery
  if (cmd === "chat" && positional[1] === "send") {
    const target = positional[2];
    const body = positional.slice(3).join(" ").trim();
    if (!target || !body) {
      throw new Error('Usage: pi-harness chat send <chat-id|host:chat-id> "<message>" [--from <chat-id>] [--no-reply]');
    }
    const client = await connectClient(config.socketPath, remoteSpec.target, remoteSpec.bridgeCommand);
    try {
      const explicitFrom = typeof flags.from === "string" && flags.from.trim() ? flags.from.trim() : null;
      const fromSessionId = explicitFrom ?? "cli";
      // Default `expectReply: false` for one-shot CLI sends without `--from <chatId>` so the recipient isn't told to reply to `<host>:cli`
      const expectReply = flags["no-reply"] ? false : Boolean(flags["expect-reply"] || explicitFrom);
      const res = await client.request("session.send_message", {
        fromSessionId,
        target,
        body,
        expectReply,
      });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      client.close();
    }
    return;
  }

  // Zero-arg default on a TTY:
  //  - Local: show project picker (--resume opens deepest registered project containing cwd; -p/--repo open directly)
  //  - Remote SSH without --repo/--project: pick a remote project (never send local Mac cwd to remote host!)
  if (!cmd || cmd === "chat") {
    if (!process.stdout.isTTY) {
      printHelp();
      return;
    }
    const client = await connectClient(config.socketPath, remoteSpec.target, remoteSpec.bridgeCommand);
    let initial: ChatStart | PickerStart;
    if (remoteSpec.target) {
      initial = {
        kind: "chat",
        repoRoot: explicitRepoFlag ? repoRoot : projectFlag ? undefined : repoRoot,
        ...(projectFlag ? { projectId: projectFlag } : {}),
      };
      if (!explicitRepoFlag && !projectFlag) {
        let picked: ChatStart | null;
        try {
          picked = await chooseRemoteProject(client, remoteSpec.hostLabel);
        } catch (err) {
          await client.request("session.leave").catch(() => {});
          client.close();
          throw err;
        }
        if (!picked) {
          await client.request("session.leave").catch(() => {});
          client.close();
          return;
        }
        initial = picked;
      }
    } else {
      const resumeFlag = flags.resume === true;
      let projects: ProjectSummary[] = [];
      if (resumeFlag && !explicitRepoFlag && !projectFlag) {
        try {
          projects = await client.request<ProjectSummary[]>("project.list", { includeRemotes: false });
        } catch (err) {
          client.close();
          throw err;
        }
      }
      initial = resolveLocalStartup({
        cwd: repoRoot,
        explicitRepoRoot: explicitRepoFlag ? repoRoot : undefined,
        projectFlag,
        resume: resumeFlag,
        projects,
      });
    }
    await runInteractiveSessionLoop(client, initial, hostCtx);
    return;
  }

  if (cmd === "daemon") {
    const sub = positional[1] ?? "status";
    if (sub === "serve") {
      if (remoteSpec.target) {
        throw new Error(`\`daemon serve\` only runs locally; omit --remote (got --remote ${rawRemote}).`);
      }
      // Never allow stray subprocess pipe errors (`EPIPE`) to crash `harnessd` and drop client TUIs
      process.on("uncaughtException", (err) => {
        console.error(`[harnessd ${new Date().toISOString()}] uncaughtException:`, err);
      });
      process.on("unhandledRejection", (reason) => {
        console.error(`[harnessd ${new Date().toISOString()}] unhandledRejection:`, reason);
      });
      ensureTempDir();
      const disableReloadRpc = process.env.PI_HARNESS_TEST_NO_RELOAD === "1";
      delete process.env.PI_HARNESS_TEST_NO_RELOAD;
      const daemon = new HarnessDaemon(config, {
        autoQuitWhenIdle: true,
        repoRoot,
        overlayRoot: repoRoot,
        reapChildrenOnStop: true,
        disableReloadRpc,
      });
      const sock = await daemon.start();
      try {
        writeFileSync(join(config.stateDir, "daemon.pid"), `${process.pid}\n`, "utf8");
      } catch {
        // ignore pid write failure
      }
      process.on("SIGTERM", () => void daemon.shutdownAndExit({ reason: "SIGTERM" }));
      process.on("SIGINT", () => void daemon.shutdownAndExit({ reason: "SIGINT" }));
      console.error(`[harnessd ${new Date().toISOString()}] listening on ${sock} (pid ${process.pid})`);
      return;
    }
    if (sub === "reload") {
      if (remoteSpec.target) {
        throw new Error(`\`daemon reload\` only runs locally; omit --remote (got --remote ${rawRemote}).`);
      }
      const targetDir = requireStringFlag(flags, "target");
      const previousDir = requireStringFlag(flags, "previous");
      const dbPath = requireStringFlag(flags, "db");
      const code = await runDaemonReloadCli({
        socketPath: config.socketPath,
        stateDir: config.stateDir,
        targetDir,
        previousDir,
        dbPath,
        legacy: flags.legacy === true,
        yes: flags.yes === true,
        fromInstall: flags["from-install"] === true,
        now: flags.now === true,
        wait: flags.wait === true,
        check: flags.check === true,
      });
      if (code !== 0) process.exit(code);
      return;
    }
    if (sub === "stop") {
      if (remoteSpec.target) {
        const client = await connectClient(config.socketPath, remoteSpec.target, remoteSpec.bridgeCommand);
        try {
          const res = await client.request<{ pid?: number }>("daemon.shutdown");
          console.log(`Stopped remote harnessd on ${remoteSpec.hostLabel ?? rawRemote} (pid ${res.pid ?? "?"}).`);
        } finally {
          client.close();
        }
        return;
      }
      const stopped = await stopLocalDaemon(config.socketPath);
      console.log(stopped ? "Stopped harnessd." : "harnessd was not running.");
      return;
    }
    if (sub === "restart") {
      if (remoteSpec.target) {
        const stopClient = await connectClient(config.socketPath, remoteSpec.target, remoteSpec.bridgeCommand);
        try {
          await stopClient.request("daemon.shutdown").catch(() => {});
        } finally {
          stopClient.close();
        }
        await new Promise((r) => setTimeout(r, 300));
        // Reconnecting via `pi-harness bridge` triggers `ensureLocalDaemon` on the remote host
        const restartClient = await connectClient(config.socketPath, remoteSpec.target, remoteSpec.bridgeCommand);
        try {
          const info = await restartClient.request<{ pid?: number }>("ping");
          console.log(`Restarted remote harnessd on ${remoteSpec.hostLabel ?? rawRemote} (pid ${info.pid ?? "?"}).`);
        } finally {
          restartClient.close();
        }
        return;
      }
      const reloadCode = await tryReloadForDaemonRestart(config.socketPath);
      if (reloadCode !== null) {
        if (reloadCode !== 0) process.exit(reloadCode);
        return;
      }
      const c = await ensureLocalDaemon(config.socketPath);
      c.close();
      console.log("Restarted harnessd.");
      return;
    }
    if (sub === "recover") {
      if (flags["dry-run"] !== true) {
        throw new Error("Only --dry-run is supported. Recovery runs when the daemon starts.");
      }
      const rawDb = typeof flags.db === "string" ? flags.db.trim() : "";
      const dbPath = rawDb
        ? resolve(rawDb === "~" || rawDb.startsWith("~/") ? join(homedir(), rawDb.slice(1)) : rawDb)
        : join(config.stateDir, "control-plane.sqlite");
      if (!existsSync(dbPath)) {
        throw new Error(`Database not found: ${dbPath}`);
      }
      const raw = new Database(dbPath, { readonly: true });
      try {
        const plan = classifyInterruptedTasks(raw);
        if (flags.json === true) {
          console.log(JSON.stringify(plan, null, 2));
        } else {
          console.log(formatRecoveryPlan(plan));
        }
      } finally {
        raw.close();
      }
      return;
    }
    const client = await connectClient(config.socketPath, remoteSpec.target, remoteSpec.bridgeCommand);
    try {
      const res = await client.request("status");
      console.log(JSON.stringify(res, null, 2));
    } finally {
      client.close();
    }
    return;
  }

  if (cmd === "bridge") {
    const c = await ensureLocalDaemon(config.socketPath);
    c.close();
    await runStdioSocketBridge(config.socketPath);
    return;
  }

  // Validate every escalations invocation before connectClient, so malformed ones never open a DB or start a daemon.
  if (cmd === "escalations") {
    const hasFlag = (k: string) => Object.prototype.hasOwnProperty.call(flags, k);
    const sub = positional[1] ?? "list";
    if (sub !== "list" && sub !== "reconcile" && sub !== "resolve") {
      throw new Error(`Unknown escalations subcommand: ${sub}. Expected list, reconcile, or resolve.`);
    }
    const common = ["json", "remote", "repo", "project", "p"];
    const allowed = new Set([
      ...common,
      ...(sub === "list" ? ["status", "run", "limit"] : sub === "reconcile" ? ["direct", "db"] : ["reason"]),
    ]);
    if (hasFlag("direct")) {
      if (sub !== "reconcile") throw new Error("--direct is only supported for 'escalations reconcile'");
      if (flags.direct !== true) throw new Error("--direct does not take a value");
      if (hasFlag("remote")) throw new Error("--direct uses the local SQLite file and cannot be combined with --remote");
    }
    if (hasFlag("db")) {
      if (sub !== "reconcile" || flags.direct !== true) throw new Error("--db can only be used with 'escalations reconcile --direct'");
      if (typeof flags.db !== "string" || !flags.db.trim()) throw new Error("--db requires a non-empty file path");
    }
    if (hasFlag("json") && flags.json !== true) throw new Error("--json does not take a value");
    for (const key of Object.keys(flags)) {
      if (!allowed.has(key)) throw new Error(`Flag --${key} is not supported for 'escalations ${sub}'`);
    }
    if (sub === "list") {
      const listUsage = "Usage: pi-harness escalations [list] [--status open|acked|resolved|all] [--run <run-id>] [--limit <n>] [--json]";
      if (positional.length > 2) throw new Error(listUsage);
      if (hasFlag("status") && !(typeof flags.status === "string" && ["open", "acked", "resolved", "all"].includes(flags.status))) {
        throw new Error(listUsage);
      }
      if (hasFlag("run") && !(typeof flags.run === "string" && flags.run.trim().length > 0)) {
        throw new Error(`--run requires a run id. ${listUsage}`);
      }
      if (hasFlag("limit") && !(typeof flags.limit === "string" && /^[1-9]\d*$/.test(flags.limit.trim()))) {
        throw new Error(`--limit must be a positive integer. ${listUsage}`);
      }
    } else if (sub === "reconcile") {
      if (positional.length > 2) throw new Error("Usage: pi-harness escalations reconcile [--direct [--db <path>]] [--json]");
    } else if (
      !(
        positional.length === 3 &&
        Boolean(positional[2]?.trim()) &&
        typeof flags.reason === "string" &&
        flags.reason.trim().length > 0
      )
    ) {
      throw new Error('Usage: pi-harness escalations resolve <escalation-id> --reason "<text>" [--json]');
    }

    if (sub === "reconcile" && flags.direct === true) {
      const rawDb = typeof flags.db === "string" ? flags.db.trim() : "";
      const dbPath = rawDb
        ? resolve(rawDb === "~" || rawDb.startsWith("~/") ? join(homedir(), rawDb.slice(1)) : rawDb)
        : join(config.stateDir, "control-plane.sqlite");
      printReconcileResult({ mode: "direct", ...reconcileEscalationsDirect(dbPath) }, flags.json === true);
      return;
    }
  }

  const client = await connectClient(config.socketPath, remoteSpec.target, remoteSpec.bridgeCommand);
  let handoffClientToTui = false;
  try {
    switch (cmd) {
      case "remotes":
      case "remote": {
        const sub = positional[1] ?? "list";
        if (sub === "list" || sub === "status") {
          const remotes = await client.request<RemoteHostStatus[]>("remote.list");
          if (flags.json) {
            console.log(JSON.stringify(remotes, null, 2));
          } else if (remotes.length === 0) {
            console.log("No remote hosts configured. Add one with: pi-harness remote add <name> <user@host>");
          } else {
            console.log("HOST             STATUS        LINK      QUEUED  TARGET");
            for (const r of remotes) {
              const note = r.lastError ? `${r.sshTarget} (${r.lastError})` : r.sshTarget;
              console.log(
                `${r.name.padEnd(16)} ${r.status.padEnd(13)} ${r.direction.padEnd(9)} ${String(r.queuedMessages).padEnd(7)} ${note}`,
              );
            }
          }
          break;
        }
        if (sub === "add") {
          const name = positional[2];
          const sshTarget = positional[3];
          if (!name || !sshTarget) {
            throw new Error("Usage: pi-harness remote add <name> <user@host|ssh://host> [--bridge <cmd>] [--no-connect]");
          }
          const added = await client.request<RemoteHostStatus>("remote.add", {
            name,
            sshTarget,
            bridgeCommand: typeof flags.bridge === "string" ? flags.bridge : undefined,
            autoConnect: !flags["no-auto-connect"],
            connectNow: !flags["no-connect"],
          });
          console.log(JSON.stringify(added, null, 2));
          break;
        }
        if (sub === "rm" || sub === "remove") {
          const name = positional[2];
          if (!name) throw new Error("Usage: pi-harness remote rm <name>");
          console.log(JSON.stringify(await client.request("remote.remove", { name }), null, 2));
          break;
        }
        if (sub === "connect") {
          const name = positional[2];
          if (!name) throw new Error("Usage: pi-harness remote connect <name>");
          console.log(JSON.stringify(await client.request("remote.connect", { name }), null, 2));
          break;
        }
        if (sub === "disconnect") {
          const name = positional[2];
          if (!name) throw new Error("Usage: pi-harness remote disconnect <name>");
          console.log(JSON.stringify(await client.request("remote.disconnect", { name }), null, 2));
          break;
        }
        throw new Error(`Unknown remote subcommand "${sub}". Expected: list | add | rm | connect | disconnect`);
      }

      case "projects":
      case "project": {
        const sub = positional[1] ?? "list";
        if (sub === "list") {
          const projects = await client.request<Array<ProjectSummary & { host?: string }>>("project.list", {
            includeRemotes: !hostFlag,
            ...(hostFlag ? { host: hostFlag } : {}),
          });
          if (flags.json) {
            console.log(JSON.stringify(projects, null, 2));
          } else if (projects.length === 0) {
            console.log("No projects registered. Add one with: pi-harness project add <path> [--name <name>] [--init] [--clone <url>]");
          } else {
            console.log("HOST\tID\tNAME\tWORKSPACE\tSESSIONS\tGOALS\tPATH");
            for (const p of projects) {
              const ws = !p.exists ? "missing" : p.isGit ? `git:${p.gitBranch ?? "HEAD"}` : "folder";
              const displayHost = p.host === "local" && remoteSpec.hostLabel ? remoteSpec.hostLabel : (p.host ?? "local");
              console.log(`${displayHost}\t${p.id}\t${p.name}\t${ws}\t${p.sessionCount}\t${p.activeGoalCount}\t${p.rootPath}`);
            }
          }
          break;
        }
        if (sub === "add" || sub === "create") {
          const targetPath = positional[2];
          if (!targetPath) throw new Error("Usage: pi-harness project add <path> [--name <name>] [--host <name>] [--init] [--clone <url>]");
          const created = await client.request<ProjectSummary>("project.create", {
            path: targetPath,
            name: typeof flags.name === "string" ? flags.name : undefined,
            description: typeof flags.description === "string" ? flags.description : undefined,
            createDir: !flags["no-create"],
            gitInit: Boolean(flags.init),
            cloneUrl: typeof flags.clone === "string" ? flags.clone : undefined,
            ...(hostFlag ? { host: hostFlag } : {}),
          });
          console.log(JSON.stringify(created, null, 2));
          break;
        }
        if (sub === "use" || sub === "open") {
          let ref = positional[2];
          if (!ref) throw new Error("Usage: pi-harness project use <[host:]name|id|path> [--host <name>]");
          // `<host>:<ref>` selects a project on a configured remote when --host is not given explicitly.
          let useHost = hostFlag;
          const colon = ref.indexOf(":");
          if (!useHost && colon > 0) {
            const prefix = ref.slice(0, colon).toLowerCase();
            const alias = config.remotes?.find((r) => r.name.toLowerCase() === prefix);
            const matchesRemote = Boolean(remoteSpec.target && remoteSpec.hostLabel?.toLowerCase() === prefix);
            if ((alias || matchesRemote) && ref.slice(colon + 1).trim()) {
              useHost = alias?.name ?? remoteSpec.hostLabel ?? undefined;
              ref = ref.slice(colon + 1).trim();
            }
          }
          if (useHost && remoteSpec.target) {
            if (useHost.toLowerCase() !== (remoteSpec.hostLabel ?? "").toLowerCase()) {
              throw new Error(`Cannot combine --remote ${rawRemote} with --host ${useHost} on \`project use\`; specify one target host.`);
            }
            // Already connected to that daemon: the client-side alias need not be the remote's own host name.
            useHost = undefined;
          }
          const proj = await client.request<ProjectSummary & { host?: string; nodeId?: string | null }>("project.get", {
            projectId: ref,
            ...(useHost ? { host: useHost } : {}),
          });
          if (!process.stdout.isTTY) {
            console.log(JSON.stringify(proj, null, 2));
            break;
          }
          let targetClient = client;
          let targetHostLabel = remoteSpec.hostLabel;
          let targetSelector = remoteSpec.selector;
          if (useHost && useHost.toLowerCase() !== "local" && !remoteSpec.target) {
            const spec = resolveRemoteSpec(useHost, config.remotes);
            client.close();
            targetClient = await connectClient(config.socketPath, spec.target, spec.bridgeCommand);
            targetHostLabel = spec.hostLabel;
            targetSelector = spec.selector;
          }
          // The project ID is numbered per daemon: open it only on the node that owns it.
          if (proj.nodeId) {
            const info = await targetClient.request<{ nodeId?: string }>("ping");
            if (info.nodeId !== proj.nodeId) {
              if (targetClient !== client) targetClient.close();
              throw new Error(
                info.nodeId
                  ? `Host "${targetHostLabel ?? "local"}" resolved to node ${info.nodeId}, but project ${proj.id} belongs to node ${proj.nodeId} (alias mismatch); not opening it.`
                  : `Host "${targetHostLabel ?? "local"}" did not report its node ID, so it cannot be confirmed as node ${proj.nodeId}, which owns project ${proj.id}; not opening it.`,
              );
            }
          }
          handoffClientToTui = true;
          await runInteractiveSessionLoop(
            targetClient,
            { kind: "chat", projectId: proj.id, repoRoot: proj.rootPath },
            { ...hostCtx, remoteHost: targetHostLabel, remoteSelector: targetSelector },
          );
          return;
        }
        if (sub === "rm" || sub === "remove") {
          const ref = positional[2];
          if (!ref) throw new Error("Usage: pi-harness project rm <name|id> [--host <name>]");
          console.log(
            JSON.stringify(
              await client.request("project.remove", { projectId: ref, ...(hostFlag ? { host: hostFlag } : {}) }),
              null,
              2,
            ),
          );
          break;
        }
        if (sub === "browse") {
          const dir = positional[2];
          const res = await client.request<ProjectBrowseResult>("project.browse", {
            ...(dir ? { path: dir } : {}),
            ...(hostFlag ? { host: hostFlag } : {}),
          });
          if (flags.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            console.log(`Directory (${hostFlag ?? remoteSpec.hostLabel ?? "local"}): ${res.path}`);
            for (const e of res.entries) {
              console.log(`  ${e.isGit ? "[git]" : "[dir]"} ${e.name}\t${e.path}`);
            }
          }
          break;
        }
        throw new Error(`Unknown project subcommand "${sub}". Expected: list | add | use | rm | browse`);
      }

      case "run": {
        const resumeRunId = resolveRunResumeAlias(parsed);
        if (resumeRunId) {
          await handleResumeCommand(client, resumeRunId, flags, remoteSpec.selector);
          break;
        }
        const goal = positional.slice(1).join(" ").trim();
        if (!goal) throw new Error('Usage: pi-harness run "<goal>"');
        let targetRepoRoot = repoRoot;
        if (projectFlag) {
          const proj = await client.request<ProjectSummary>("project.get", { projectId: projectFlag });
          targetRepoRoot = proj.rootPath;
        }
        const created = (await client.request("run.create", {
          goal,
          repoRoot: targetRepoRoot,
          profileId: typeof flags.profile === "string" ? flags.profile : undefined,
          model: typeof flags.model === "string" ? flags.model : undefined,
          effort: typeof flags.effort === "string" ? flags.effort : undefined,
        })) as { run: { id: string } };
        if (flags.detach || !process.stdout.isTTY) {
          console.log(JSON.stringify(created, null, 2));
          client.close();
          return;
        }
        handoffClientToTui = true;
        await runInteractiveSessionLoop(client, { kind: "run", repoRoot: targetRepoRoot, runId: created.run.id }, hostCtx);
        return;
      }

      case "attach": {
        const targetId = positional[1];
        if (!targetId) {
          // Default to last active/most-recent session globally (taking it over if attached elsewhere)
          const sessions = await client.request<AttachableSession[]>("sessions.list");
          const best = sessions[0];
          handoffClientToTui = true;
          if (best?.kind === "run" && best.running) {
            await runInteractiveSessionLoop(
              client,
              {
                kind: "run",
                repoRoot: best.repoRoot,
                runId: best.id,
                initialTaskId: typeof flags.task === "string" ? flags.task : null,
              },
              hostCtx,
            );
          } else {
            await runInteractiveSessionLoop(
              client,
              {
                kind: "chat",
                repoRoot: best?.repoRoot ?? repoRoot,
                chatSessionId: best?.kind === "chat" ? best.id : undefined,
                preferLastGlobal: true,
              },
              hostCtx,
            );
          }
          return;
        }
        handoffClientToTui = true;
        const attachRunId = normalizeAttachRunId(targetId);
        if (attachRunId) {
          await runInteractiveSessionLoop(
            client,
            {
              kind: "run",
              repoRoot,
              runId: attachRunId,
              initialTaskId: typeof flags.task === "string" ? flags.task : null,
            },
            hostCtx,
          );
        } else {
          await runInteractiveSessionLoop(
            client,
            {
              kind: "chat",
              repoRoot,
              chatSessionId: targetId,
            },
            hostCtx,
          );
        }
        return;
      }

      case "sessions": {
        const sessions = await client.request<AttachableSession[]>("sessions.list", {
          includeRemotes: !hostFlag,
          ...(hostFlag ? { host: hostFlag } : {}),
        });
        if (flags.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else if (sessions.length === 0) {
          console.log("No sessions found.");
        } else {
          console.log("HOST          SESSION          TYPE  STATE          ATTACHED  WORKSPACE / TITLE");
          for (const s of sessions) {
            const rawHost = s.host === "local" && remoteSpec.hostLabel ? remoteSpec.hostLabel : (s.host ?? remoteSpec.hostLabel ?? "local");
            const hostCol = rawHost.padEnd(13);
            const att = s.attached ? "yes" : "no";
            const dir = s.repoRoot.split("/").filter(Boolean).pop() ?? s.repoRoot;
            console.log(`${hostCol} ${s.id.padEnd(16)} ${s.kind.padEnd(5)} ${s.status.padEnd(14)} ${att.padEnd(9)} ${s.title} (${dir})`);
          }
        }
        break;
      }

      case "goals": {
        const sub = positional[1] ?? "list";
        if (sub === "review") {
          console.log(JSON.stringify(await client.request("goal.review", { goalId: positional[2] }), null, 2));
        } else if (sub === "pause") {
          console.log(JSON.stringify(await client.request("goal.pause", { goalId: positional[2] }), null, 2));
        } else if (sub === "cancel") {
          console.log(JSON.stringify(await client.request("goal.cancel", { goalId: positional[2] }), null, 2));
        } else {
          console.log(JSON.stringify(await client.request("goal.list", { repoRoot }), null, 2));
        }
        break;
      }

      case "escalations": {
        const sub = positional[1] ?? "list";
        if (sub === "list") {
          const status = flags.status;
          const limit = typeof flags.limit === "string" ? Math.max(1, Math.min(1000, Number(flags.limit))) : 500;
          const params: Record<string, unknown> = { limit };
          if (typeof flags.run === "string" && flags.run.trim()) params.runId = flags.run.trim();
          let items: EscalationRecord[];
          let truncated: boolean;
          if (status === undefined) {
            // Unresolved = open + acked. Query each status separately so the row limit applies after the status
            // filter (resolved rows never crowd them out), on every daemon version.
            const [open, acked] = await Promise.all([
              client.request<EscalationRecord[]>("escalation.list", { ...params, status: "open" }),
              client.request<EscalationRecord[]>("escalation.list", { ...params, status: "acked" }),
            ]);
            const byId = new Map<string, EscalationRecord>();
            for (const e of [...open, ...acked]) byId.set(e.id, e);
            const combined = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
            // Older daemons cap each page at 100 rows regardless of the requested limit.
            const openCapped = open.length >= limit || (limit > 100 && open.length === 100);
            const ackedCapped = acked.length >= limit || (limit > 100 && acked.length === 100);
            truncated = combined.length > limit || openCapped || ackedCapped;
            items = combined.slice(0, limit);
          } else {
            if (status === "open" || status === "acked" || status === "resolved") params.status = status;
            const raw = await client.request<EscalationRecord[]>("escalation.list", params);
            // Older daemons cap each page at 100 rows regardless of the requested limit.
            truncated = raw.length >= limit || (limit > 100 && raw.length === 100);
            items = raw.slice(0, limit);
          }
          if (flags.json) {
            console.log(JSON.stringify(items, null, 2));
          } else if (items.length === 0) {
            console.log("No escalations found.");
          } else {
            for (const e of items) {
              console.log(`${e.id}  ${e.severity}  ${e.category}  ${e.status}  ${e.runId}  ${e.title}`);
            }
            if (truncated) {
              console.log(`(showing first ${items.length} matching escalation(s); narrow with --run or raise --limit)`);
            }
          }
        } else if (sub === "reconcile") {
          let out: { mode: string } & ReconcileResult;
          try {
            out = { mode: "daemon", ...(await client.request<ReconcileResult>("escalation.reconcile")) };
          } catch (err) {
            if (!/Unknown daemon op/.test(err instanceof Error ? err.message : String(err))) throw err;
            if (remoteSpec.target) throw new Error("remote daemon predates escalation.reconcile");
            out = { mode: "direct_fallback", ...reconcileEscalationsDirect(join(config.stateDir, "control-plane.sqlite")) };
          }
          printReconcileResult(out, Boolean(flags.json));
        } else if (sub === "resolve") {
          const escalationId = positional[2]!.trim();
          const reason = (flags.reason as string).trim();
          const res = await client.request<{ alreadyResolved?: boolean; remainingOpen?: number }>("escalation.resolve", {
            escalationId,
            reason,
          });
          if (flags.json) {
            console.log(JSON.stringify(res, null, 2));
          } else {
            const head = res.alreadyResolved ? `Escalation ${escalationId} was already resolved.` : `Resolved escalation ${escalationId}.`;
            console.log(typeof res.remainingOpen === "number" ? `${head} ${res.remainingOpen} open escalation(s) remain.` : head);
          }
        }
        break;
      }

      case "profiles": {
        const sub = positional[1] ?? "list";
        if (sub === "add") {
          const id = positional[2];
          const command = positional[3];
          const args = positional.slice(4);
          if (!id || !command) throw new Error("Usage: pi-harness profiles add <id> <command> [args...]");
          const profile: AcpProfileConfig = {
            id,
            kind: "acp",
            adapter: typeof flags.adapter === "string" ? (flags.adapter as AcpProfileConfig["adapter"]) : "generic",
            command,
            args,
            billing: typeof flags.billing === "string" ? (flags.billing as AcpProfileConfig["billing"]) : "subscription",
            enabled: true,
          };
          console.log(JSON.stringify(await client.request("profiles.upsert", { profile }), null, 2));
        } else if (sub === "remove") {
          console.log(JSON.stringify(await client.request("profiles.remove", { id: positional[2] }), null, 2));
        } else if (sub === "probe") {
          console.log(JSON.stringify(await client.request("profiles.probe", { id: positional[2], cwd: repoRoot }), null, 2));
        } else {
          const cfg = await client.request<{ profiles: unknown[] }>("config.get");
          console.log(JSON.stringify(cfg.profiles, null, 2));
        }
        break;
      }

      case "runs": {
        const runs = (await client.request<
          Array<{ id: string; status: string; repoRoot: string; goal: string; updatedAt: number }>
        >("run.list")) ?? [];
        if (flags.json) {
          console.log(JSON.stringify(runs, null, 2));
        } else if (runs.length === 0) {
          console.log("No runs found.");
        } else {
          const maxW = Math.max(80, process.stdout.columns || 120);
          const goalW = Math.max(16, maxW - 73);
          console.log("RUN              STATUS        UPDATED (UTC)         WORKSPACE         GOAL");
          for (const r of runs) {
            const ws = (r.repoRoot.split("/").filter(Boolean).pop() ?? r.repoRoot).slice(0, 16);
            const firstLine = (r.goal.split("\n")[0] ?? "").trim().slice(0, goalW);
            const ts = `${new Date(r.updatedAt).toISOString().replace("T", " ").slice(0, 19)}Z`;
            console.log(`${r.id.padEnd(16)} ${r.status.padEnd(13)} ${ts.padEnd(21)} ${ws.padEnd(17)} ${firstLine}`);
          }
        }
        break;
      }

      case "tree": {
        const runId = positional[1];
        if (!runId) throw new Error("Usage: pi-harness tree <run-id>");
        const tree = await client.request("tree.get", { runId });
        console.log(JSON.stringify(tree, null, 2));
        break;
      }

      case "steer": {
        const taskId = positional[1];
        const message = positional.slice(2).join(" ");
        if (!taskId || !message) throw new Error('Usage: pi-harness steer <task-id> "<message>"');
        console.log(JSON.stringify(await client.request("task.steer", { taskId, message }), null, 2));
        break;
      }

      case "stop": {
        const runId = positional[1];
        if (!runId) throw new Error("Usage: pi-harness stop <run-id>");
        console.log(JSON.stringify(await client.request("run.stop", { runId }), null, 2));
        break;
      }

      case "resume": {
        await handleResumeCommand(client, positional[1], flags, remoteSpec.selector);
        break;
      }

      case "models": {
        const sub = positional[1] ?? "list";
        const op = sub === "sync" ? "models.sync" : "models.list";
        const out = (await client.request(op, {
          cwd: repoRoot,
          role: typeof flags.role === "string" ? flags.role : undefined,
          excludeExhausted: Boolean(flags["exclude-exhausted"]),
          chatSessionId: typeof flags.chat === "string" ? flags.chat : undefined,
        })) as {
          syncedAt: string;
          sources: string[];
          sessionModelContext?: string | null;
          profileStatuses?: Array<{ profileId: string; status: "ok" | "error"; modelCount: number; error?: string }>;
          models: Array<{
            codingRank: number | null;
            id: string;
            codingScore: number | null;
            scoreSource: string | null;
            costPerTaskUsd: number | null;
            apiEquivCostUsd: number | null;
            timePerTaskSeconds: number | null;
            preferredRoute: { profileId: string; billing: string };
            quota?: { availabilityName?: string; effectiveRemainingRatio?: number | null; exhausted?: boolean } | null;
          }>;
        };
        if (flags.json) {
          console.log(JSON.stringify(out, null, 2));
        } else {
          console.log(`Models (${out.models.length}) · synced ${out.syncedAt} · sources: ${out.sources.join(", ") || "none"}`);
          if (out.sessionModelContext) {
            console.log(`  Session model context: ${out.sessionModelContext}`);
          }
          for (const st of out.profileStatuses ?? []) {
            if (st.status === "error") {
              console.log(`  ⚠ ${st.profileId}: ${st.error ?? "probe failed"}`);
            }
          }
          console.log("RANK  MODEL                         SCORE             COST/TASK          TIME     QUOTA / ROUTE");
          for (const m of out.models) {
            const score = m.codingScore != null ? `${m.codingScore.toFixed(1)} (${m.scoreSource ?? "?"})` : "-";
            const cost =
              m.preferredRoute.billing === "subscription"
                ? `$0 (api:$${m.apiEquivCostUsd?.toFixed(2) ?? "?"})`
                : `$${m.costPerTaskUsd?.toFixed(2) ?? "?"}`;
            const time = m.timePerTaskSeconds != null ? `${Math.round(m.timePerTaskSeconds / 60)}m` : "-";
            const q = m.quota
              ? m.quota.exhausted
                ? "EXHAUSTED"
                : `${m.quota.availabilityName}${m.quota.effectiveRemainingRatio != null ? ` ${Math.round(m.quota.effectiveRemainingRatio * 100)}%` : ""}`
              : m.preferredRoute.billing;
            console.log(
              `${String(m.codingRank ?? "-").padEnd(5)} ${m.id.padEnd(29)} ${score.padEnd(17)} ${cost.padEnd(18)} ${time.padEnd(8)} ${q} (${m.preferredRoute.profileId})`,
            );
          }
        }
        break;
      }

      case "quota": {
        const sub = positional[1] ?? "show";
        const op = sub === "sync" ? "quota.sync" : "quota.get";
        console.log(JSON.stringify(await client.request(op), null, 2));
        break;
      }

      case "worktrees": {
        const sub = positional[1] ?? "list";
        if (sub === "clean") {
          console.log(
            JSON.stringify(
              await client.request("worktrees.clean", {
                repoRoot,
                runId: typeof flags.run === "string" ? flags.run : undefined,
                forceAll: Boolean(flags.all),
              }),
              null,
              2,
            ),
          );
        } else {
          console.log(
            JSON.stringify(
              await client.request("worktrees.list", {
                repoRoot,
                runId: typeof flags.run === "string" ? flags.run : undefined,
              }),
              null,
              2,
            ),
          );
        }
        break;
      }

      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  } finally {
    if (!handoffClientToTui) client.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
