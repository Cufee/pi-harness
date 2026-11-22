#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectBrowseResult, ProjectSummary } from "./control-plane/projects.js";
import { loadConfig, type AcpProfileConfig } from "./config.js";
import type { RemoteHostStatus } from "./daemon/peer.js";
import { DaemonClient, runStdioSocketBridge } from "./daemon/remote.js";
import { currentDaemonBuildId, DAEMON_PROTOCOL_REV, HarnessDaemon } from "./daemon/server.js";
import { runDirectorChatTui, runNativeScrollbackTui, type TuiExitAction } from "./tui/app.js";
import { parseDurationMs } from "./tui/core/index.js";
import type { AttachableSession } from "./tui/store.js";

const BOOLEAN_SHORT_FLAGS = new Set(["h"]);

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("-")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
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
  return { positional, flags };
}

async function stopLocalDaemon(socketPath: string): Promise<boolean> {
  const probe = new DaemonClient(socketPath);
  try {
    await probe.connect();
    const info = (await probe.request("ping")) as { pid?: number };
    await probe.request("daemon.shutdown").catch(() => {});
    probe.close();
    // Fallback SIGTERM if older daemon didn't recognize `daemon.shutdown`
    if (typeof info.pid === "number" && info.pid > 0) {
      await new Promise((r) => setTimeout(r, 120));
      try {
        process.kill(info.pid, "SIGTERM");
      } catch {
        // already exited
      }
    }
    return true;
  } catch {
    probe.close();
    return false;
  }
}

async function ensureLocalDaemon(socketPath: string): Promise<DaemonClient> {
  const expectedBuildId = currentDaemonBuildId();
  const probe = new DaemonClient(socketPath);
  let needsRestart = false;
  try {
    await probe.connect();
    const info = (await probe.request("ping")) as {
      pid?: number;
      protocolRev?: number;
      buildId?: string;
      running?: boolean;
      liveWork?: string;
    };
    if (info.protocolRev === DAEMON_PROTOCOL_REV && info.buildId === expectedBuildId) {
      // Reuse the live socket directly — avoids a redundant connect/close handshake on every TUI launch!
      return probe;
    }
    if (info.protocolRev !== DAEMON_PROTOCOL_REV && info.running) {
      probe.close();
      throw new Error(
        `Live harnessd (pid ${info.pid ?? "?"}, protocol rev ${info.protocolRev ?? "?"}) has active work (${info.liveWork ?? "active"}) and will not be stopped automatically for protocol rev ${DAEMON_PROTOCOL_REV}. Wait for work to finish or run \`pi-harness daemon restart\` explicitly.`,
      );
    }
    if (info.protocolRev === DAEMON_PROTOCOL_REV && info.running) {
      // Never kill an active daemon with running agents/timers just because source file mtime changed
      console.error(
        `[pi-harness] Reusing live harnessd (pid ${info.pid ?? "?"}) despite build change because work is active (${info.liveWork ?? "active"}).`,
      );
      return probe;
    }
    probe.close();
    needsRestart = true;
    // Gracefully stop idle outdated daemon so newly built code takes over immediately
    await stopLocalDaemon(socketPath);
  } catch {
    probe.close();
  }

  if (needsRestart) {
    await new Promise((r) => setTimeout(r, 150));
  }

  // Spawn detached persistent `harnessd` so closing any terminal never stops running agents.
  // Redirect daemon output to `<stateDir>/daemon.log` so diagnostics are always preserved.
  const cliPath = fileURLToPath(import.meta.url);
  const logDir = dirname(socketPath);
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, "daemon.log");
  const logFd = openSync(logPath, "a");
  try {
    const child = spawn(process.execPath, [cliPath, "daemon", "serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 80));
    if (!existsSync(socketPath)) continue;
    const check = new DaemonClient(socketPath);
    try {
      await check.connect();
      const info = (await check.request("ping")) as { buildId?: string };
      if (info.buildId === expectedBuildId) return check;
      check.close();
    } catch {
      check.close();
    }
  }
  throw new Error(`Timed out waiting for harnessd to listen on ${socketPath}`);
}

function resolveRemoteSpec(
  rawRemote: string | undefined,
  remotes: ReadonlyArray<{ name: string; sshTarget: string }> | undefined,
): { target?: string; hostLabel: string | null } {
  if (!rawRemote || rawRemote.trim().toLowerCase() === "local") {
    return { target: undefined, hostLabel: null };
  }
  const trimmed = rawRemote.trim();
  const saved = remotes?.find((r) => r.name.toLowerCase() === trimmed.toLowerCase());
  if (saved) {
    return { target: saved.sshTarget, hostLabel: saved.name };
  }
  if (trimmed.startsWith("ssh://")) {
    try {
      const u = new URL(trimmed);
      return { target: trimmed, hostLabel: u.hostname || trimmed };
    } catch {
      return { target: trimmed, hostLabel: trimmed };
    }
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("./")) {
    return { target: trimmed, hostLabel: trimmed };
  }
  return { target: `ssh://${trimmed}`, hostLabel: trimmed.includes("@") ? trimmed.split("@")[1]! : trimmed };
}

async function connectClient(configSocketPath: string, remoteTarget?: string): Promise<DaemonClient> {
  if (!remoteTarget) {
    return await ensureLocalDaemon(configSocketPath);
  }
  const client = new DaemonClient(remoteTarget);
  await client.connect();
  return client;
}

function printHelp(): void {
  console.log(`pi-harness — CLI-first, daemonized interactive Director + 3-tier multi-agent coding harness

Usage:
  pi-harness [-p <project>] [--remote <alias|ssh://host>]
                                                    Resume last session for project/workspace (remote uses last remote project)
  pi-harness remotes | remote [list | add <name> <ssh> | rm <name> | connect <name> | disconnect <name>]
                                                    Manage remote SSH peer hosts
  pi-harness projects [--host <name>] [--json]      List local & connected remote projects
  pi-harness project list [--host <name>] [--json]  List registered projects
  pi-harness project add <path> [--name n] [--host <name>] [--init] [--clone <url>]
                                                    Register or create a project folder/repo (~ expands on target host)
  pi-harness project use <name|id|path> [--host <name>]
                                                    Open Director Chat bound to a project
  pi-harness project rm <name|id> [--host <name>]   Unregister a project (never deletes files on disk)
  pi-harness project browse [path] [--host <name>]  Browse directories on local or remote host
  pi-harness attach [session-or-run-id]             Attach to & take over last active session (or specific chat-/run- ID)
  pi-harness sessions [--host <name>] [--json]      List local & connected remote Director Chat & run sessions
  pi-harness chat [-p <project>] [--remote <alias|ssh://host>]
  pi-harness chat send <target> "<message>" [--from <chat-id>] [--no-reply]
                                                    Send a message to any local (chat-1) or remote (gpu-box:chat-4) chat
  pi-harness goals [list | review <id> | pause <id> | cancel <id>]
  pi-harness profiles [list | add <id> <cmd> [args...] | remove <id> | probe <id>]
  pi-harness daemon serve | status | stop | restart [--remote <alias|ssh://host>]
  pi-harness run "<goal>" [-p <project>] [--profile id] [--model id] [--effort level] [--detach] [--remote <alias|ssh://host>]
  pi-harness runs [--json] [--remote <alias|ssh://host>]
  pi-harness tree <run-id> [--remote <alias|ssh://host>]
  pi-harness steer <task-id> "<message>" [--remote <alias|ssh://host>]
  pi-harness resume <run-id> [--in 15m] [--message "<msg>"] [--remote <alias|ssh://host>]
  pi-harness stop <run-id> [--remote <alias|ssh://host>]
  pi-harness models [list | sync] [--role name] [--remote <alias|ssh://host>]
  pi-harness quota [show | sync] [--remote <alias|ssh://host>]
  pi-harness worktrees [list | clean [--all]] [--remote <alias|ssh://host>]
  pi-harness bridge                                 (stdio <-> local Unix socket bridge for remote SSH attach)
`);
}

async function runInteractiveSessionLoop(
  initialClient: DaemonClient,
  initial:
    | { kind: "chat"; repoRoot?: string; projectId?: string; chatSessionId?: string; preferLastGlobal?: boolean; preferLastProject?: boolean }
    | { kind: "run"; repoRoot?: string; runId: string; initialTaskId?: string | null },
  hostCtx: {
    localSocketPath: string;
    remoteHost: string | null;
    getRemotes: () => ReadonlyArray<{ name: string; sshTarget: string }> | undefined;
  },
): Promise<void> {
  let client = initialClient;
  let current = initial;
  let currentRemoteHost = hostCtx.remoteHost;

  try {
    while (true) {
      let action: TuiExitAction;
      if (current.kind === "chat") {
        action = await runDirectorChatTui({
          client,
          remoteHost: currentRemoteHost,
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
          runId: current.runId,
          initialTaskId: current.initialTaskId,
        });
      }
      if (action.kind === "exit") return;

      // Handle cross-host switch (local <-> remote peer host) seamlessly!
      if (action.targetHost) {
        const nextSpec = resolveRemoteSpec(action.targetHost, hostCtx.getRemotes());
        if (nextSpec.hostLabel !== currentRemoteHost) {
          client.close();
          client = await connectClient(hostCtx.localSocketPath, nextSpec.target);
          currentRemoteHost = nextSpec.hostLabel;
        }
      }

      if (action.targetKind === "run") {
        current = { kind: "run", repoRoot: action.repoRoot ?? current.repoRoot, runId: action.targetId, initialTaskId: action.taskId };
      } else if (action.targetId === "__host__") {
        current = { kind: "chat", preferLastProject: Boolean(currentRemoteHost), preferLastGlobal: !currentRemoteHost };
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
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd === "help" || flags.help || flags.h) {
    printHelp();
    return;
  }

  const rawRemote = typeof flags.remote === "string" ? flags.remote : undefined;
  const hostFlag = typeof flags.host === "string" ? flags.host : undefined;
  const projectFlag =
    typeof flags.project === "string"
      ? flags.project
      : typeof flags.p === "string"
        ? flags.p
        : undefined;
  const explicitRepoFlag = typeof flags.repo === "string" ? flags.repo : undefined;
  const rawRepoRoot = explicitRepoFlag ?? process.cwd();
  let repoRoot: string;
  try {
    repoRoot = realpathSync(rawRepoRoot);
  } catch {
    repoRoot = resolve(rawRepoRoot);
  }
  const config = loadConfig(repoRoot);
  const remoteSpec = resolveRemoteSpec(rawRemote, config.remotes);
  const hostCtx = {
    localSocketPath: config.socketPath,
    remoteHost: remoteSpec.hostLabel,
    getRemotes: () => loadConfig(repoRoot).remotes,
  };

  // `pi-harness chat send <target> "<message>"` — non-interactive cross-session / remote message delivery
  if (cmd === "chat" && positional[1] === "send") {
    const target = positional[2];
    const body = positional.slice(3).join(" ").trim();
    if (!target || !body) {
      throw new Error('Usage: pi-harness chat send <chat-id|host:chat-id> "<message>" [--from <chat-id>] [--no-reply]');
    }
    const client = await connectClient(config.socketPath, remoteSpec.target);
    try {
      const fromSessionId = typeof flags.from === "string" && flags.from.trim() ? flags.from.trim() : "cli";
      const res = await client.request("session.send_message", {
        fromSessionId,
        target,
        body,
        expectReply: !flags["no-reply"],
      });
      console.log(JSON.stringify(res, null, 2));
    } finally {
      client.close();
    }
    return;
  }

  // Zero-arg default on a TTY:
  //  - Local: resume last session for the current directory (or --project)
  //  - Remote SSH without --repo/--project: open last used remote project (never send local Mac cwd to remote host!)
  if (!cmd || cmd === "chat") {
    if (!process.stdout.isTTY) {
      printHelp();
      return;
    }
    const client = await connectClient(config.socketPath, remoteSpec.target);
    const preferRemoteLast = Boolean(remoteSpec.target && !explicitRepoFlag && !projectFlag);
    await runInteractiveSessionLoop(
      client,
      {
        kind: "chat",
        ...(preferRemoteLast ? { preferLastProject: true } : { repoRoot: explicitRepoFlag ? repoRoot : projectFlag ? undefined : repoRoot }),
        ...(projectFlag ? { projectId: projectFlag } : {}),
      },
      hostCtx,
    );
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
      const daemon = new HarnessDaemon(config, { autoQuitWhenIdle: true });
      const sock = await daemon.start();
      try {
        writeFileSync(join(config.stateDir, "daemon.pid"), `${process.pid}\n`, "utf8");
      } catch {
        // ignore pid write failure
      }
      process.on("SIGTERM", () => void daemon.stop().then(() => process.exit(0)));
      process.on("SIGINT", () => void daemon.stop().then(() => process.exit(0)));
      console.error(`[harnessd ${new Date().toISOString()}] listening on ${sock} (pid ${process.pid})`);
      return;
    }
    if (sub === "stop") {
      if (remoteSpec.target) {
        const client = await connectClient(config.socketPath, remoteSpec.target);
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
        const stopClient = await connectClient(config.socketPath, remoteSpec.target);
        try {
          await stopClient.request("daemon.shutdown").catch(() => {});
        } finally {
          stopClient.close();
        }
        await new Promise((r) => setTimeout(r, 300));
        // Reconnecting via `pi-harness bridge` triggers `ensureLocalDaemon` on the remote host
        const restartClient = await connectClient(config.socketPath, remoteSpec.target);
        try {
          const info = await restartClient.request<{ pid?: number }>("ping");
          console.log(`Restarted remote harnessd on ${remoteSpec.hostLabel ?? rawRemote} (pid ${info.pid ?? "?"}).`);
        } finally {
          restartClient.close();
        }
        return;
      }
      await stopLocalDaemon(config.socketPath);
      const c = await ensureLocalDaemon(config.socketPath);
      c.close();
      console.log("Restarted harnessd.");
      return;
    }
    const client = await connectClient(config.socketPath, remoteSpec.target);
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

  const client = await connectClient(config.socketPath, remoteSpec.target);
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
            autoConnect: !flags["no-connect"],
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
              console.log(`${p.host ?? "local"}\t${p.id}\t${p.name}\t${ws}\t${p.sessionCount}\t${p.activeGoalCount}\t${p.rootPath}`);
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
          const ref = positional[2];
          if (!ref) throw new Error("Usage: pi-harness project use <name|id|path> [--host <name>]");
          const proj = await client.request<ProjectSummary & { host?: string }>("project.get", {
            projectId: ref,
            ...(hostFlag ? { host: hostFlag } : {}),
          });
          if (!process.stdout.isTTY) {
            console.log(JSON.stringify(proj, null, 2));
            break;
          }
          let targetClient = client;
          let targetHostLabel = remoteSpec.hostLabel;
          if (hostFlag && hostFlag.toLowerCase() !== "local" && !remoteSpec.target) {
            const spec = resolveRemoteSpec(hostFlag, config.remotes);
            client.close();
            targetClient = await connectClient(config.socketPath, spec.target);
            targetHostLabel = spec.hostLabel;
          }
          handoffClientToTui = true;
          await runInteractiveSessionLoop(
            targetClient,
            { kind: "chat", projectId: proj.id, repoRoot: proj.rootPath },
            { ...hostCtx, remoteHost: targetHostLabel },
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
        if (targetId.startsWith("run-")) {
          await runInteractiveSessionLoop(
            client,
            {
              kind: "run",
              repoRoot,
              runId: targetId,
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
            const hostCol = (s.host ?? remoteSpec.hostLabel ?? "local").padEnd(13);
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
          console.log("RUN              STATUS        UPDATED              WORKSPACE         GOAL");
          for (const r of runs) {
            const ws = (r.repoRoot.split("/").filter(Boolean).pop() ?? r.repoRoot).slice(0, 16);
            const firstLine = (r.goal.split("\n")[0] ?? "").trim().slice(0, 64);
            const ts = new Date(r.updatedAt).toISOString().replace("T", " ").slice(0, 19);
            console.log(`${r.id.padEnd(16)} ${r.status.padEnd(13)} ${ts.padEnd(20)} ${ws.padEnd(17)} ${firstLine}`);
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
        const runId = positional[1];
        if (!runId) throw new Error('Usage: pi-harness resume <run-id> [--in 15m] [--message "<msg>"]');
        if (typeof flags.in === "string") {
          const delayMs = parseDurationMs(flags.in);
          if (!delayMs) throw new Error(`Invalid duration for --in: ${flags.in} (examples: 30s, 15m, 1h30m)`);
          console.log(JSON.stringify(await client.request("run.schedule_resume", { runId, delayMs }), null, 2));
        } else {
          console.log(
            JSON.stringify(
              await client.request("run.resume", {
                runId,
                message: typeof flags.message === "string" ? flags.message : undefined,
              }),
              null,
              2,
            ),
          );
        }
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
