#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type AcpProfileConfig } from "./config.js";
import { DaemonClient, runStdioSocketBridge } from "./daemon/remote.js";
import { currentDaemonBuildId, DAEMON_PROTOCOL_REV, HarnessDaemon } from "./daemon/server.js";
import { runDirectorChatTui, runNativeScrollbackTui, type TuiExitAction } from "./tui/app.js";
import { parseDurationMs, type AttachableSession } from "./tui/overlays.js";

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[arg.slice(2)] = next;
          i++;
        } else {
          flags[arg.slice(2)] = true;
        }
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
    const info = (await probe.request("ping")) as { pid?: number; protocolRev?: number; buildId?: string };
    if (info.protocolRev === DAEMON_PROTOCOL_REV && info.buildId === expectedBuildId) {
      // Reuse the live socket directly — avoids a redundant connect/close handshake on every TUI launch!
      return probe;
    }
    probe.close();
    needsRestart = true;
    // Gracefully stop outdated daemon so newly built code takes over immediately
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

async function connectClient(configSocketPath: string, remote?: string): Promise<DaemonClient> {
  if (!remote) {
    return await ensureLocalDaemon(configSocketPath);
  }
  const client = new DaemonClient(remote);
  await client.connect();
  return client;
}

function printHelp(): void {
  console.log(`pi-harness — CLI-first, daemonized interactive Director + 3-tier multi-agent coding harness

Usage:
  pi-harness [--remote ssh://host]                  Resume last session for this repo (takes over if attached elsewhere)
  pi-harness attach [session-or-run-id]             Attach to & take over last active session (or specific chat-/run- ID)
  pi-harness sessions [--json]                      List all Director Chat & autonomous run sessions
  pi-harness chat [--remote ssh://host]             Explicitly open Tier 0 Interactive Director Chat
  pi-harness goals [list | review <id> | pause <id> | cancel <id>]
  pi-harness profiles [list | add <id> <cmd> [args...] | remove <id> | probe <id>]
  pi-harness daemon serve | status | stop | restart
  pi-harness run "<goal>" [--profile id] [--model id] [--effort level] [--detach] [--remote ssh://host]
  pi-harness runs [--remote ssh://host]
  pi-harness tree <run-id> [--remote ssh://host]
  pi-harness steer <task-id> "<message>" [--remote ssh://host]
  pi-harness resume <run-id> [--in 15m] [--message "<msg>"] [--remote ssh://host]
  pi-harness stop <run-id> [--remote ssh://host]
  pi-harness models [list | sync] [--role name] [--remote ssh://host]
  pi-harness quota [show | sync] [--remote ssh://host]
  pi-harness worktrees [list | clean [--all]] [--remote ssh://host]
  pi-harness bridge                                 (stdio <-> local Unix socket bridge for remote SSH attach)
`);
}

async function runInteractiveSessionLoop(
  client: DaemonClient,
  initial:
    | { kind: "chat"; repoRoot: string; chatSessionId?: string; preferLastGlobal?: boolean }
    | { kind: "run"; repoRoot: string; runId: string; initialTaskId?: string | null },
): Promise<void> {
  let current = initial;
  while (true) {
    let action: TuiExitAction;
    if (current.kind === "chat") {
      action = await runDirectorChatTui({
        client,
        repoRoot: current.repoRoot,
        chatSessionId: current.chatSessionId,
        preferLastGlobal: current.preferLastGlobal,
      });
    } else {
      action = await runNativeScrollbackTui({
        client,
        runId: current.runId,
        initialTaskId: current.initialTaskId,
      });
    }
    if (action.kind === "exit") return;
    if (action.targetKind === "run") {
      current = { kind: "run", repoRoot: current.repoRoot, runId: action.targetId };
    } else if (action.targetId === "__new__") {
      const created = await client.request<{ session: { id: string; repoRoot: string } }>("chat.create", {
        repoRoot: current.repoRoot,
      });
      current = { kind: "chat", repoRoot: created.session.repoRoot, chatSessionId: created.session.id };
    } else {
      current = { kind: "chat", repoRoot: current.repoRoot, chatSessionId: action.targetId };
    }
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd === "help" || flags.help || flags.h) {
    printHelp();
    return;
  }

  const rawRepoRoot = typeof flags.repo === "string" ? flags.repo : process.cwd();
  let repoRoot: string;
  try {
    repoRoot = realpathSync(rawRepoRoot);
  } catch {
    repoRoot = resolve(rawRepoRoot);
  }
  const config = loadConfig(repoRoot);
  const remote = typeof flags.remote === "string" ? flags.remote : undefined;

  // Zero-arg default on a TTY: resume last session for this workspace (taking over if attached elsewhere)!
  if (!cmd || cmd === "chat") {
    if (!process.stdout.isTTY) {
      printHelp();
      return;
    }
    const client = await connectClient(config.socketPath, remote);
    await runInteractiveSessionLoop(client, { kind: "chat", repoRoot });
    return;
  }

  if (cmd === "daemon") {
    const sub = positional[1] ?? "status";
    if (sub === "serve") {
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
      const stopped = await stopLocalDaemon(config.socketPath);
      console.log(stopped ? "Stopped harnessd." : "harnessd was not running.");
      return;
    }
    if (sub === "restart") {
      await stopLocalDaemon(config.socketPath);
      const c = await ensureLocalDaemon(config.socketPath);
      c.close();
      console.log("Restarted harnessd.");
      return;
    }
    const client = await connectClient(config.socketPath, remote);
    const res = await client.request("status");
    console.log(JSON.stringify(res, null, 2));
    client.close();
    return;
  }

  if (cmd === "bridge") {
    const c = await ensureLocalDaemon(config.socketPath);
    c.close();
    await runStdioSocketBridge(config.socketPath);
    return;
  }

  const client = await connectClient(config.socketPath, remote);
  try {
    switch (cmd) {
      case "run": {
        const goal = positional.slice(1).join(" ").trim();
        if (!goal) throw new Error('Usage: pi-harness run "<goal>"');
        const created = (await client.request("run.create", {
          goal,
          repoRoot,
          profileId: typeof flags.profile === "string" ? flags.profile : undefined,
          model: typeof flags.model === "string" ? flags.model : undefined,
          effort: typeof flags.effort === "string" ? flags.effort : undefined,
        })) as { run: { id: string } };
        if (flags.detach || !process.stdout.isTTY) {
          console.log(JSON.stringify(created, null, 2));
          client.close();
          return;
        }
        await runInteractiveSessionLoop(client, { kind: "run", repoRoot, runId: created.run.id });
        return;
      }

      case "attach": {
        const targetId = positional[1];
        if (!targetId) {
          // Default to last active/most-recent session globally (taking it over if attached elsewhere)
          const sessions = await client.request<AttachableSession[]>("sessions.list");
          const best = sessions[0];
          if (best?.kind === "run" && best.running) {
            await runInteractiveSessionLoop(client, {
              kind: "run",
              repoRoot: best.repoRoot,
              runId: best.id,
              initialTaskId: typeof flags.task === "string" ? flags.task : null,
            });
          } else {
            await runInteractiveSessionLoop(client, {
              kind: "chat",
              repoRoot: best?.repoRoot ?? repoRoot,
              chatSessionId: best?.kind === "chat" ? best.id : undefined,
              preferLastGlobal: true,
            });
          }
          return;
        }
        if (targetId.startsWith("run-")) {
          await runInteractiveSessionLoop(client, {
            kind: "run",
            repoRoot,
            runId: targetId,
            initialTaskId: typeof flags.task === "string" ? flags.task : null,
          });
        } else {
          await runInteractiveSessionLoop(client, {
            kind: "chat",
            repoRoot,
            chatSessionId: targetId,
          });
        }
        return;
      }

      case "sessions": {
        const sessions = await client.request<AttachableSession[]>("sessions.list");
        if (flags.json) {
          console.log(JSON.stringify(sessions, null, 2));
        } else if (sessions.length === 0) {
          console.log("No sessions found.");
        } else {
          console.log("SESSION          TYPE  STATE          ATTACHED  WORKSPACE / TITLE");
          for (const s of sessions) {
            const att = s.attached ? "yes" : "no";
            const dir = s.repoRoot.split("/").filter(Boolean).pop() ?? s.repoRoot;
            console.log(`${s.id.padEnd(16)} ${s.kind.padEnd(5)} ${s.status.padEnd(14)} ${att.padEnd(9)} ${s.title} (${dir})`);
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
        const runs = await client.request("run.list");
        console.log(JSON.stringify(runs, null, 2));
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
        })) as {
          syncedAt: string;
          sources: string[];
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
    client.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
