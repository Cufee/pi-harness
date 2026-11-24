#!/usr/bin/env bun
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { DaemonClient } from "../src/daemon/remote.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { installAutoReconnect, type AutoReconnectHandle } from "../src/tui/reconnect.js";
import {
  cleanTestEnv,
  cleanupSandbox,
  initTempRepo,
  isPidAlive,
  readRecordedFakePids,
  rpc,
  waitForPing,
  writeHarnessHome,
} from "../test/helpers/hot-update-fixture.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_HOME = homedir();
const HOST_PI_HARNESS = resolve(HOST_HOME, ".pi-harness");
const HOST_LOCAL_BIN = resolve(HOST_HOME, ".local", "bin");

function resolveWithExistingAncestor(target: string): string {
  const abs = resolve(target);
  if (existsSync(abs)) return realpathSync(abs);
  const parts: string[] = [];
  let cur = abs;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return abs;
    parts.unshift(basename(cur));
    cur = parent;
  }
  return join(realpathSync(cur), ...parts);
}

function assertStrictlyUnderRoot(label: string, targetPath: string, root: string): string {
  const canonicalRoot = realpathSync(root);
  const resolved = resolveWithExistingAncestor(targetPath);
  if (resolved === canonicalRoot || !resolved.startsWith(canonicalRoot + sep)) {
    throw new Error(`SAFETY ABORT: ${label} (${resolved}) is outside temp root (${canonicalRoot})`);
  }
  if (resolved === HOST_PI_HARNESS || resolved.startsWith(HOST_PI_HARNESS + sep)) {
    throw new Error(`SAFETY ABORT: ${label} (${resolved}) resolves inside host ${HOST_PI_HARNESS}`);
  }
  if (resolved === HOST_LOCAL_BIN || resolved.startsWith(HOST_LOCAL_BIN + sep)) {
    throw new Error(`SAFETY ABORT: ${label} (${resolved}) resolves inside host ${HOST_LOCAL_BIN}`);
  }
  return resolved;
}

function seedInstallCacheReadOnly(installDir: string): string[] {
  const hostInstall = join(HOST_PI_HARNESS, "install");
  const seeded: string[] = [];
  if (!existsSync(hostInstall)) return seeded;

  // Symlink individual binaries inside freshly created temp dirs so install.sh writes (such as bunx) stay in temp.
  const hostBunRoot = join(hostInstall, "bun");
  if (existsSync(hostBunRoot)) {
    for (const entry of readdirSync(hostBunRoot)) {
      const srcBun = join(hostBunRoot, entry, "bin", "bun");
      if (!existsSync(srcBun)) continue;
      const dstBinDir = join(installDir, "bun", entry, "bin");
      mkdirSync(dstBinDir, { recursive: true });
      symlinkSync(srcBun, join(dstBinDir, "bun"));
      seeded.push(`bun/${entry}/bin/bun (symlink)`);
    }
  }

  const hostOctofsRoot = join(hostInstall, "tools", "octofs");
  if (existsSync(hostOctofsRoot)) {
    for (const entry of readdirSync(hostOctofsRoot)) {
      const srcBin = join(hostOctofsRoot, entry, "bin", "octofs");
      if (!existsSync(srcBin)) continue;
      const dstBinDir = join(installDir, "tools", "octofs", entry, "bin");
      mkdirSync(dstBinDir, { recursive: true });
      symlinkSync(srcBin, join(dstBinDir, "octofs"));
      seeded.push(`tools/octofs/${entry}/bin/octofs (symlink)`);
    }
  }

  const hostDownloads = join(hostInstall, "cache", "downloads");
  if (existsSync(hostDownloads)) {
    const dstDownloads = join(installDir, "cache", "downloads");
    mkdirSync(dstDownloads, { recursive: true });
    for (const entry of readdirSync(hostDownloads)) {
      symlinkSync(join(hostDownloads, entry), join(dstDownloads, entry));
    }
    seeded.push("cache/downloads/* (symlink)");
  }

  // Copy cache/bun so `bun install` never writes back into ~/.pi-harness/install/cache/bun.
  const hostBunCache = join(hostInstall, "cache", "bun");
  if (existsSync(hostBunCache)) {
    const dstBunCache = join(installDir, "cache", "bun");
    cpSync(hostBunCache, dstBunCache, { recursive: true });
    seeded.push("cache/bun (copy)");
  }

  return seeded;
}

async function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: Record<string, string>; label: string },
): Promise<{ code: number; stdout: string; stderr: string }> {
  console.log(`\n$ ${opts.label}`);
  console.log(`  cwd: ${opts.cwd}`);
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: cleanTestEnv(opts.env),
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
  console.log(`  exit: ${result.code}`);
  if (result.stdout.trim()) {
    console.log("  stdout:");
    for (const line of result.stdout.trimEnd().split(/\r?\n/)) {
      console.log(`    ${line}`);
    }
  }
  if (result.stderr.trim()) {
    console.log("  stderr:");
    for (const line of result.stderr.trimEnd().split(/\r?\n/)) {
      console.log(`    ${line}`);
    }
  }
  return result;
}

async function pollUntil<T>(
  fn: () => Promise<T | null | undefined | false> | T | null | undefined | false,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const val = await fn();
      if (val) return val;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${label}` +
      (lastErr ? ` (lastErr: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})` : ""),
  );
}

function queryDb<T>(dbPath: string, fn: (db: Database) => T): T {
  const raw = new Database(dbPath, { readonly: true });
  try {
    return fn(raw);
  } finally {
    raw.close();
  }
}

function listLingeringProcessesForRoot(root: string): string[] {
  const psOut = execFileSync("ps", ["-Ao", "pid=,args="], { encoding: "utf8", timeout: 5_000 });
  const matches: string[] = [];
  for (const line of psOut.split(/\r?\n/)) {
    if (!line.includes(root)) continue;
    const m = line.trim().match(/^(\d+)\s+/);
    const pid = m ? Number(m[1]) : NaN;
    if (pid === process.pid) continue;
    matches.push(line.trim());
  }
  return matches;
}

function pass(label: string, detail?: string): void {
  console.log(`[PASS] ${label}${detail ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hu-install-")));
  const homeDir = join(root, "home");
  const installDir = join(root, "install");
  const binDir = join(root, "bin");
  const fakeDir = join(root, "fake");
  const repoDir = join(root, "repo");
  const srcCopyDir = join(root, "checkout-v2");
  const socketPath = join(root, "d.sock");

  const extraDaemonPids: number[] = [];
  let reconnectHandle: AutoReconnectHandle | null = null;
  let tuiClient: DaemonClient | null = null;
  let cleanedUp = false;

  const doCleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      reconnectHandle?.dispose();
    } catch {
      // ignore
    }
    try {
      tuiClient?.close();
    } catch {
      // ignore
    }
    await cleanupSandbox({
      socketPath,
      homeDir,
      fakeDir,
      extraDaemonPids,
      tempDirs: [root],
    });
  };

  console.log("=== Goal-16 c2 real-installer hot-update check ===");
  console.log(`timestamp: ${new Date().toISOString()}`);
  console.log(`checkout:  ${REPO_ROOT}`);
  console.log(`temp root: ${root}`);

  try {
    // 1. Safety guard: verify every path resolves inside the temp root before doing anything.
    assertStrictlyUnderRoot("PI_HARNESS_HOME", homeDir, root);
    assertStrictlyUnderRoot("PI_HARNESS_INSTALL_DIR", installDir, root);
    assertStrictlyUnderRoot("PI_HARNESS_BIN_DIR", binDir, root);
    assertStrictlyUnderRoot("socketPath", socketPath, root);
    assertStrictlyUnderRoot("fakeDir", fakeDir, root);
    assertStrictlyUnderRoot("repoDir", repoDir, root);
    assertStrictlyUnderRoot("srcCopyDir", srcCopyDir, root);
    pass("Safety check: all temp paths and socketPath resolve inside temp root", `socketPath=${socketPath}`);

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    initTempRepo(repoDir);

    const seeded = seedInstallCacheReadOnly(installDir);
    console.log(`seeded offline caches (read-only from ~/.pi-harness/install): ${seeded.length > 0 ? seeded.join(", ") : "none"}`);

    // 2. Write isolated config.json with explicit short temp socketPath and fake ACP agent.
    writeHarnessHome(homeDir, {
      socketPath,
      fakeDir,
      hotUpdate: { mode: "auto", drainTimeoutSec: 20, minIntervalSec: 0 },
    });
    const writtenCfg = JSON.parse(readFileSync(join(homeDir, "config.json"), "utf8")) as { socketPath?: string };
    assert.equal(writtenCfg.socketPath, socketPath);
    assertStrictlyUnderRoot("config.json socketPath", writtenCfg.socketPath, root);
    pass("Wrote isolated config.json with explicit temp socketPath", socketPath);

    const baseEnv: Record<string, string> = {
      PI_HARNESS_HOME: homeDir,
      PI_HARNESS_INSTALL_DIR: installDir,
      PI_HARNESS_BIN_DIR: binDir,
      XDG_RUNTIME_DIR: root,
    };

    // 3. First install from checkout while no daemon is running.
    const install1 = await runCommand("sh", ["install.sh"], {
      cwd: REPO_ROOT,
      env: baseEnv,
      label: `PI_HARNESS_HOME=${homeDir} PI_HARNESS_INSTALL_DIR=${installDir} PI_HARNESS_BIN_DIR=${binDir} sh install.sh`,
    });
    assert.equal(install1.code, 0, `first install failed with exit ${install1.code}`);
    assert.ok(
      install1.stdout.includes("harnessd is not running"),
      `expected 'harnessd is not running' in first install stdout`,
    );
    assert.equal(existsSync(socketPath), false, "install.sh must never start a daemon when none is running");

    const currentLink1 = readlinkSync(join(installDir, "current"));
    const relId1 = basename(currentLink1);
    assert.ok(currentLink1.startsWith("releases/"), `unexpected current symlink: ${currentLink1}`);
    assert.ok(relId1.length === 12, `expected 12-char release ID, got ${relId1}`);
    pass("First install succeeded without starting a daemon", `current -> ${currentLink1}`);

    const auditPath = join(homeDir, "install-audit.log");
    const auditLines1 = readFileSync(auditPath, "utf8").trim().split(/\r?\n/);
    assert.equal(auditLines1.length, 1, `expected 1 line in install-audit.log, got ${auditLines1.length}`);
    assert.ok(auditLines1[0]!.includes(`release=${relId1}`), `audit line 1 missing release=${relId1}`);
    pass("install-audit.log recorded first activation", auditLines1[0]);

    // 4. Start the daemon through the temp launcher.
    const launcherPath = join(binDir, "pi-harness");
    assert.ok(existsSync(launcherPath), `expected launcher at ${launcherPath}`);
    const daemonLogPath = join(dirname(socketPath), "daemon.log");
    console.log(`\n$ ${launcherPath} daemon serve (detached -> ${daemonLogPath})`);
    const logFd = openSync(daemonLogPath, "a");
    try {
      const child = spawn(launcherPath, ["daemon", "serve"], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        cwd: dirname(socketPath),
        env: cleanTestEnv(baseEnv),
      });
      child.unref();
    } finally {
      closeSync(logFd);
    }

    const ping1 = await waitForPing(socketPath, (p) => typeof p?.pid === "number" && p.pid > 0, 15_000);
    const pid1 = ping1.pid as number;
    extraDaemonPids.push(pid1);
    assert.equal(ping1.releaseId, relId1, `expected ping1.releaseId=${relId1}, got ${ping1.releaseId}`);
    assert.equal(ping1.restartSafe, true, "expected ping1.restartSafe === true");
    assert.equal(ping1.reload?.state, "idle", `expected ping1.reload.state === 'idle', got ${ping1.reload?.state}`);
    pass("Temp daemon started through temp launcher", `pid=${pid1} releaseId=${ping1.releaseId}`);

    // 5. Create a run using the fake ACP agent's orchestrator role.
    console.log(`\n$ rpc run.create { goal: "FAKE_ROLE=orchestrator ...", repoRoot: "${repoDir}" }`);
    const created = await rpc<{ run: { id: string }; rootTask: { id: string } }>(socketPath, "run.create", {
      goal: "FAKE_ROLE=orchestrator verify real-installer hot-update",
      repoRoot: repoDir,
    });
    const runId = created.run.id;
    const dbPath = join(homeDir, "control-plane.sqlite");

    const preState = await pollUntil(
      async () => {
        const runGet = await rpc<{
          run: { status: string };
          tasks: Array<{ id: string; tier: number; status: string; generation: number }>;
        }>(socketPath, "run.get", { runId });
        const orch = runGet.tasks.find((t) => t.tier === 1);
        const child = runGet.tasks.find((t) => t.tier === 3);
        const timers = orch
          ? queryDb(
              dbPath,
              (db) =>
                db.prepare("SELECT id, status FROM timers WHERE owner_id = ?").all(orch.id) as Array<{
                  id: string;
                  status: string;
                }>,
            )
          : [];
        const pids = readRecordedFakePids(fakeDir);
        if (!orch || !child || child.status !== "running") return null;
        const pendingTimer = timers.find((t) => t.status === "pending");
        if (!pendingTimer) return null;
        if (pids.length < 2) return null;
        return {
          orchId: orch.id,
          orchGen: orch.generation,
          childId: child.id,
          taskIds: runGet.tasks.map((t) => t.id).sort(),
          timerId: pendingTimer.id,
          pidsBeforeReload: pids,
        };
      },
      20_000,
      "orchestrator spawned child (running), scheduled pending timer, and recorded fake PIDs",
    );
    pass(
      "Run active before second install",
      `runId=${runId} orch=${preState.orchId} (gen=${preState.orchGen}) child=${preState.childId} timer=${preState.timerId} fakePids=[${preState.pidsBeforeReload.join(",")}]`,
    );

    // 6. Attach a DaemonClient with installAutoReconnect before the second install.
    tuiClient = new DaemonClient(socketPath);
    await tuiClient.connect();
    await tuiClient.request("tui.register", { kind: "run" });
    await tuiClient.request("attach", { runId, control: "view" });

    let restored = false;
    let restoredReleaseId: string | undefined;
    let sawReloadEvent = false;
    const eventsAfterRestore: DaemonEventFrame[] = [];
    tuiClient.onEvent((ev) => {
      if (ev.type === "daemon.reload") sawReloadEvent = true;
      reconnectHandle?.noteDaemonEvent(ev);
      if (restored) eventsAfterRestore.push(ev);
    });
    reconnectHandle = installAutoReconnect({
      client: tuiClient,
      isStopped: () => false,
      spawnDaemon: () => {},
      resync: async (ping) => {
        restoredReleaseId = ping.releaseId;
        await tuiClient!.request("tui.register", { kind: "run" });
        await tuiClient!.request("attach", { runId, control: "view" });
      },
      onStatus: (s) => {
        if (s.phase === "restored") restored = true;
      },
    });
    pass("Attached DaemonClient with installAutoReconnect", `runId=${runId}`);

    // 7. Copy runtime files + install.sh to a temp checkout and append a comment so the release ID changes.
    mkdirSync(srcCopyDir, { recursive: true });
    for (const item of ["src", "proto", "package.json", "bun.lock", "tsconfig.json", "install.sh"]) {
      cpSync(join(REPO_ROOT, item), join(srcCopyDir, item), { recursive: true });
    }
    const bumpedFile = join(srcCopyDir, "src", "daemon", "release.ts");
    appendFileSync(bumpedFile, `\n// hot-update-install-check release bump ${Date.now()}\n`, "utf8");
    console.log(`\nprepared modified checkout copy at ${srcCopyDir} (appended comment to src/daemon/release.ts)`);

    // 8. Run second install with PI_HARNESS_RELOAD_WAIT=1.
    const install2 = await runCommand("sh", ["install.sh"], {
      cwd: srcCopyDir,
      env: { ...baseEnv, PI_HARNESS_RELOAD_WAIT: "1" },
      label: `PI_HARNESS_RELOAD_WAIT=1 PI_HARNESS_HOME=${homeDir} PI_HARNESS_INSTALL_DIR=${installDir} PI_HARNESS_BIN_DIR=${binDir} sh install.sh`,
    });
    assert.equal(install2.code, 0, `second install failed with exit ${install2.code}`);
    pass("Second install exited 0", `exit=${install2.code}`);

    // 9. Verify release switch, daemon PID change, and reconnected client.
    const currentLink2 = readlinkSync(join(installDir, "current"));
    const relId2 = basename(currentLink2);
    assert.ok(currentLink2.startsWith("releases/"), `unexpected current symlink: ${currentLink2}`);
    assert.notEqual(relId2, relId1, `expected release ID to change from ${relId1}`);
    pass("current symlink moved to new release", `${currentLink1} -> ${currentLink2}`);

    const ping2 = await rpc<{ pid: number; releaseId: string; reload?: { previousReleaseId?: string } }>(socketPath, "ping");
    const pid2 = ping2.pid;
    extraDaemonPids.push(pid2);
    assert.equal(ping2.releaseId, relId2, `expected ping.releaseId=${relId2}, got ${ping2.releaseId}`);
    assert.notEqual(ping2.releaseId, relId1, "ping.releaseId must differ from first release");
    assert.notEqual(pid2, pid1, `expected daemon PID to change from ${pid1}`);
    assert.equal(ping2.reload?.previousReleaseId, relId1, `expected previousReleaseId=${relId1}`);
    pass(
      "Daemon moved to new release with new PID",
      `pid ${pid1} (${relId1}) -> pid ${pid2} (${ping2.releaseId})`,
    );

    await pollUntil(() => restored, 10_000, "reconnecting DaemonClient reached restored phase");
    assert.equal(sawReloadEvent, true, "attached client must observe daemon.reload event");
    assert.equal(restoredReleaseId, relId2, `expected restored client on release ${relId2}, got ${restoredReleaseId}`);
    pass("DaemonClient with installAutoReconnect restored", `releaseId=${restoredReleaseId} sawReloadEvent=${sawReloadEvent}`);

    // 10. Wait for preserved timer to fire and steer orchestrator exactly once.
    await pollUntil(
      () => {
        const row = queryDb(
          dbPath,
          (db) => db.prepare("SELECT status FROM timers WHERE id = ?").get(preState.timerId) as { status: string } | null,
        );
        if (row?.status !== "fired") return null;
        const steers = queryDb(
          dbPath,
          (db) =>
            db
              .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
              .all(runId) as Array<{ payload_json: string }>,
        ).filter((e) => e.payload_json.includes(preState.timerId));
        return steers.length >= 1 ? steers : null;
      },
      15_000,
      "preserved timer fired and steered orchestrator",
    );

    const midTimerSteers = queryDb(
      dbPath,
      (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
          .all(runId) as Array<{ payload_json: string }>,
    ).filter((e) => e.payload_json.includes(preState.timerId));
    assert.equal(midTimerSteers.length, 1, `expected timer ${preState.timerId} to fire once, got ${midTimerSteers.length}`);
    pass("Pending timer fired and steered orchestrator exactly once", `timerId=${preState.timerId}`);

    // 11. Check mid-run invariants (task IDs, generation, no failed/cancelled events, old fake PIDs dead).
    const midRun = await rpc<{
      run: { status: string };
      tasks: Array<{ id: string; tier: number; status: string; generation: number }>;
    }>(socketPath, "run.get", { runId });
    assert.equal(midRun.run.status, "active", `expected active run after reload, got ${midRun.run.status}`);
    assert.deepEqual(
      midRun.tasks.map((t) => t.id).sort(),
      preState.taskIds,
      "task ID set changed across reload",
    );
    const midOrch = midRun.tasks.find((t) => t.id === preState.orchId);
    assert.ok(midOrch, "orchestrator task missing after reload");
    assert.equal(midOrch.generation, preState.orchGen, "orchestrator generation changed across reload");
    pass(
      "Task IDs and orchestrator generation preserved",
      `tasks=[${preState.taskIds.join(",")}] orchGen=${midOrch.generation}`,
    );

    await pollUntil(
      () => preState.pidsBeforeReload.every((pid) => !isPidAlive(pid)),
      5_000,
      "all pre-reload fake agent PIDs reaped",
    );
    pass("Pre-reload fake agent processes reaped", `dead=[${preState.pidsBeforeReload.join(",")}]`);

    // 12. Release the child by creating the go file and wait for the run to complete.
    const goFile = join(fakeDir, "go");
    console.log(`\n$ write ${goFile}`);
    writeFileSync(goFile, "go\n", "utf8");
    await pollUntil(
      async () => {
        const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId });
        return r.run.status === "completed";
      },
      20_000,
      "run completed after creating go file",
    );
    pass("Run completed after creating go file", `runId=${runId} status=completed`);

    await pollUntil(() => eventsAfterRestore.length > 0, 5_000, "reconnected client received post-restore events");
    pass("Restored DaemonClient received post-reload events", `count=${eventsAfterRestore.length}`);

    // 13. Final assertions on task set, status events, timer count, sessions.log, and install-audit.log.
    const finalRun = await rpc<{
      run: { status: string };
      tasks: Array<{ id: string; generation: number; status: string }>;
    }>(socketPath, "run.get", { runId });
    assert.deepEqual(
      finalRun.tasks.map((t) => t.id).sort(),
      preState.taskIds,
      "final task ID set changed",
    );
    assert.equal(
      finalRun.tasks.find((t) => t.id === preState.orchId)?.generation,
      preState.orchGen,
      "final orchestrator generation changed",
    );
    pass("Final task ID set and orchestrator generation unchanged", `tasks=[${preState.taskIds.join(",")}] gen=${preState.orchGen}`);

    const statusEvents = queryDb(
      dbPath,
      (db) =>
        db
          .prepare("SELECT task_id, payload_json FROM events WHERE run_id = ? AND type = 'task.status'")
          .all(runId) as Array<{ task_id: string | null; payload_json: string }>,
    );
    for (const ev of statusEvents) {
      const payload = JSON.parse(ev.payload_json) as { to?: string; status?: string };
      const to = payload.to ?? payload.status;
      assert.notEqual(to, "failed", `unexpected failed task.status event: ${ev.payload_json}`);
      assert.notEqual(to, "cancelled", `unexpected cancelled task.status event: ${ev.payload_json}`);
    }
    pass("No task.status event transitioned to failed or cancelled", `checked=${statusEvents.length} events`);

    const finalTimerSteers = queryDb(
      dbPath,
      (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
          .all(runId) as Array<{ payload_json: string }>,
    ).filter((e) => e.payload_json.includes(preState.timerId));
    assert.equal(finalTimerSteers.length, 1, `expected timer steer count 1 after completion, got ${finalTimerSteers.length}`);
    pass("Timer fired and steered exactly once through completion", `timerId=${preState.timerId} count=1`);

    const sessionsLog = await pollUntil(
      () => {
        const p = join(fakeDir, "sessions.log");
        if (!existsSync(p)) return null;
        const txt = readFileSync(p, "utf8");
        return txt.includes("orchestrator resumed spawned=0") ? txt : null;
      },
      5_000,
      "sessions.log records resumed orchestrator with spawned=0",
    );
    assert.ok(sessionsLog.includes("orchestrator fresh spawned=1"), `sessions.log missing fresh orchestrator:\n${sessionsLog}`);
    assert.ok(sessionsLog.includes("orchestrator resumed spawned=0"), `sessions.log missing resumed orchestrator:\n${sessionsLog}`);
    console.log("\nsessions.log:");
    for (const line of sessionsLog.trim().split(/\r?\n/)) {
      console.log(`  ${line}`);
    }
    pass("sessions.log confirms resumed orchestrator spawned nothing", "orchestrator resumed spawned=0");

    const auditLines2 = readFileSync(auditPath, "utf8").trim().split(/\r?\n/);
    assert.equal(auditLines2.length, 2, `expected 2 lines in install-audit.log, got ${auditLines2.length}`);
    assert.ok(auditLines2[0]!.includes(`release=${relId1}`), `audit line 1 missing release=${relId1}`);
    assert.ok(auditLines2[1]!.includes(`release=${relId2}`), `audit line 2 missing release=${relId2}`);
    console.log("\ninstall-audit.log:");
    for (const line of auditLines2) {
      console.log(`  ${line}`);
    }
    pass("install-audit.log has two lines", `releases=${relId1}, ${relId2}`);

    // 14. Clean up sandbox and confirm zero lingering processes from temp root.
    await doCleanup();
    const lingering = listLingeringProcessesForRoot(root);
    assert.equal(lingering.length, 0, `lingering processes from temp root:\n${lingering.join("\n")}`);
    assert.equal(existsSync(root), false, `temp root ${root} still exists after cleanup`);
    pass("Cleanup verified: no process from temp root remains and temp root removed", `root=${root}`);

    console.log("\n=== ALL CHECKS PASSED ===");
  } finally {
    await doCleanup();
  }
}

main().catch((err) => {
  console.error(`\n[FAIL] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
