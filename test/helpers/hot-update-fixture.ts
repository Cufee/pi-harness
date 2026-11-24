import { execFileSync, spawn } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelCatalogCompiler } from "../../src/catalog/compiler.js";
import { DEFAULT_HOT_UPDATE_CONFIG, resolveConfig, type AcpProfileConfig, type HotUpdateConfig } from "../../src/config.js";
import { killProcessGroups, listChildProcessGroups } from "../../src/daemon/reap.js";
import { readReleaseAt, type ReleaseTarget } from "../../src/daemon/release.js";
import { DaemonClient } from "../../src/daemon/remote.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FAKE_AGENT_PATH = resolve(REPO_ROOT, "test", "fixtures", "fake-acp-agent.ts");

/** Builds a child env stripped of inherited PI_HARNESS_* vars so tests stay isolated from any host daemon. */
export function cleanTestEnv(overrides: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v !== "string") continue;
    if (k.startsWith("PI_HARNESS_")) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(overrides)) {
    out[k] = v;
  }
  return out;
}

export function buildReleaseDir(root: string, id: string, opts?: { brokenServe?: boolean }): ReleaseTarget {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  cpSync(join(REPO_ROOT, "src"), join(dir, "src"), { recursive: true });
  cpSync(join(REPO_ROOT, "proto"), join(dir, "proto"), { recursive: true });
  cpSync(join(REPO_ROOT, "package.json"), join(dir, "package.json"));
  cpSync(join(REPO_ROOT, "tsconfig.json"), join(dir, "tsconfig.json"));
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  symlinkSync(process.execPath, join(dir, ".bun"));
  writeFileSync(join(dir, "release.json"), JSON.stringify({ id }, null, 2) + "\n", "utf8");

  if (opts?.brokenServe) {
    const checkoutCliPath = join(REPO_ROOT, "src", "cli.ts");
    const brokenCli = `#!/usr/bin/env bun
if (process.argv.includes("serve")) {
  console.error("[brokenServe] simulated startup failure for release ${id}");
  process.exit(1);
}
const proc = Bun.spawnSync([process.execPath, ${JSON.stringify(checkoutCliPath)}, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit"],
  env: process.env,
});
process.exit(proc.exitCode ?? 1);
`;
    writeFileSync(join(dir, "src", "cli.ts"), brokenCli, "utf8");
  }

  const parsed = readReleaseAt(dir);
  if (!parsed) throw new Error(`Failed to read built release at ${dir}`);
  return {
    releaseId: parsed.releaseId,
    releaseDir: parsed.releaseDir,
    bunPath: parsed.bunPath,
    cliPath: parsed.cliPath,
  };
}

export function writeHarnessHome(
  home: string,
  o: { socketPath: string; fakeDir: string; hotUpdate?: Partial<HotUpdateConfig> },
): void {
  mkdirSync(home, { recursive: true });
  mkdirSync(o.fakeDir, { recursive: true });

  const fakeProfile: AcpProfileConfig = {
    id: "acp:fake",
    kind: "acp",
    adapter: "generic",
    command: process.execPath,
    args: [FAKE_AGENT_PATH],
    env: { FAKE_DIR: o.fakeDir },
    billing: "local",
    models: ["fake-model"],
    enabled: true,
  };

  const hotUpdate: HotUpdateConfig = {
    ...DEFAULT_HOT_UPDATE_CONFIG,
    ...o.hotUpdate,
  };

  const rawCfg = {
    socketPath: o.socketPath,
    profiles: [fakeProfile],
    defaultOrchestratorProfile: fakeProfile.id,
    defaultWorkerProfile: fakeProfile.id,
    defaultTaskProfile: fakeProfile.id,
    codeMode: "off",
    catalog: { ttlHours: 24 },
    hotUpdate,
  };
  writeFileSync(join(home, "config.json"), JSON.stringify(rawCfg, null, 2) + "\n", "utf8");

  const resolved = resolveConfig(rawCfg, {}, { stateDir: home, socketPath: o.socketPath });
  const compiler = new ModelCatalogCompiler(resolved);
  const catalog = compiler.compileFromData({
    enabledProfiles: resolved.profiles,
    inventory: new Map([[fakeProfile.id, [{ wireModelId: "fake-model" }]]]),
    profileStatuses: [{ profileId: fakeProfile.id, status: "ok", modelCount: 1 }],
    modelsDev: [],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [],
    sources: [],
  });
  writeFileSync(compiler.cachePath, JSON.stringify(catalog), "utf8");
}

function readConfiguredSocketPath(home: string): string {
  const cfgPath = join(home, "config.json");
  const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as { socketPath?: unknown };
  if (typeof parsed.socketPath !== "string" || !parsed.socketPath.trim()) {
    throw new Error(`Test safety violation: ${cfgPath} must specify an explicit temp socketPath`);
  }
  return parsed.socketPath;
}

export async function startDaemon(rel: ReleaseTarget, env: Record<string, string>): Promise<{ pid: number }> {
  if (!env.PI_HARNESS_HOME || !env.PI_HARNESS_INSTALL_DIR) {
    throw new Error("Test safety violation: startDaemon requires temp PI_HARNESS_HOME and PI_HARNESS_INSTALL_DIR");
  }
  const socketPath = readConfiguredSocketPath(env.PI_HARNESS_HOME);
  const logDir = dirname(socketPath);
  mkdirSync(logDir, { recursive: true });
  const logFd = openSync(join(logDir, "daemon.log"), "a");
  try {
    const child = spawn(rel.bunPath, [rel.cliPath, "daemon", "serve"], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      cwd: logDir,
      env: cleanTestEnv(env),
    });
    child.unref();
  } finally {
    closeSync(logFd);
  }
  const ping = await waitForPing(socketPath, (p) => typeof p?.pid === "number" && p.pid > 0, 15_000);
  return { pid: ping.pid as number };
}

export async function rpc<T>(socketPath: string, op: string, params?: Record<string, unknown>): Promise<T> {
  const client = new DaemonClient(socketPath);
  try {
    await client.connect();
    return await client.request<T>(op as never, params);
  } finally {
    client.close();
  }
}

export async function waitForPing(socketPath: string, pred: (p: any) => boolean, timeoutMs: number): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let lastPing: any = null;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const p = await rpc<any>(socketPath, "ping");
      lastPing = p;
      if (pred(p)) return p;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ping predicate on ${socketPath} (lastPing=${JSON.stringify(lastPing)}, lastErr=${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
  );
}

export async function runCli(
  rel: ReleaseTarget,
  args: string[],
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!env.PI_HARNESS_HOME || !env.PI_HARNESS_INSTALL_DIR) {
    throw new Error("Test safety violation: runCli requires temp PI_HARNESS_HOME and PI_HARNESS_INSTALL_DIR");
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(rel.bunPath, [rel.cliPath, ...args], {
      cwd: rel.releaseDir,
      env: cleanTestEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    });
    child.once("error", rejectPromise);
    child.once("close", (code, signal) => {
      resolvePromise({ code: code ?? (signal ? 1 : 0), stdout, stderr });
    });
  });
}

export function initTempRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# hot-update test repo\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return realpathSync(dir);
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readRecordedFakePids(fakeDir: string): number[] {
  const pidsDir = join(fakeDir, "pids");
  if (!existsSync(pidsDir)) return [];
  const out: number[] = [];
  for (const name of readdirSync(pidsDir)) {
    const pid = Number(name);
    if (Number.isInteger(pid) && pid > 0) out.push(pid);
  }
  return out;
}

/**
 * Kills every temp daemon, supervisor, and fake agent started for one test sandbox, then removes its temp dirs.
 * Only targets PIDs belonging to this sandbox's temp socket, daemon.pid, and fakeDir/pids.
 */
export async function cleanupSandbox(opts: {
  socketPath: string;
  homeDir: string;
  fakeDir: string;
  extraDaemonPids?: number[];
  tempDirs: string[];
}): Promise<void> {
  const daemonPids = new Set<number>(opts.extraDaemonPids ?? []);
  try {
    const ping = await rpc<{ pid?: number }>(opts.socketPath, "ping");
    if (typeof ping?.pid === "number" && ping.pid > 0) daemonPids.add(ping.pid);
  } catch {
    // daemon may already be down
  }
  const pidFile = join(opts.homeDir, "daemon.pid");
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) daemonPids.add(pid);
  }

  // Try graceful shutdown first if listening
  try {
    await rpc(opts.socketPath, "daemon.shutdown");
  } catch {
    // ignore
  }

  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && [...daemonPids].some(isPidAlive)) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // Reap child process groups of temp daemons only, then SIGKILL any surviving temp daemon PIDs
  for (const dpid of daemonPids) {
    const pgids = listChildProcessGroups(dpid);
    if (pgids.length > 0) {
      await killProcessGroups(pgids, 500);
    }
    if (isPidAlive(dpid)) {
      try {
        process.kill(dpid, "SIGKILL");
      } catch {
        // already dead
      }
    }
  }

  // Kill any surviving fake agent PIDs recorded by this sandbox
  for (const fpid of readRecordedFakePids(opts.fakeDir)) {
    if (isPidAlive(fpid)) {
      try {
        process.kill(-fpid, "SIGKILL");
      } catch {
        try {
          process.kill(fpid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  }

  // Kill any surviving --supervise process specifically carrying this sandbox's temp socketPath
  try {
    const psOut = execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8", timeout: 3000 });
    for (const line of psOut.split(/\r?\n/)) {
      if (!line.includes("--supervise") || !line.includes(opts.socketPath)) continue;
      const m = line.trim().match(/^(\d+)\s+/);
      const pid = m ? Number(m[1]) : NaN;
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }

  for (const dir of opts.tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
