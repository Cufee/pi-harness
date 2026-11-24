import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { DaemonClient } from "../src/daemon/remote.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { installAutoReconnect, type AutoReconnectHandle } from "../src/tui/reconnect.js";
import {
  buildReleaseDir,
  cleanupSandbox,
  initTempRepo,
  isPidAlive,
  readRecordedFakePids,
  rpc,
  runCli,
  startDaemon,
  waitForPing,
  writeHarnessHome,
} from "./helpers/hot-update-fixture.js";

interface ActiveSandbox {
  socketPath: string;
  homeDir: string;
  fakeDir: string;
  extraDaemonPids: number[];
  tempDirs: string[];
  cleanupHandles: Array<() => void>;
}

let activeSandbox: ActiveSandbox | null = null;

function createSandbox(prefix: string): {
  root: string;
  homeDir: string;
  installDir: string;
  releasesDir: string;
  fakeDir: string;
  repoDir: string;
  socketPath: string;
  env: Record<string, string>;
  sandbox: ActiveSandbox;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const homeDir = join(root, "home");
  const installDir = join(root, "install");
  const releasesDir = join(installDir, "releases");
  const fakeDir = join(root, "fake");
  const repoDir = initTempRepo(join(root, "repo"));
  const socketPath = join(root, "d.sock");
  const env: Record<string, string> = {
    PI_HARNESS_HOME: homeDir,
    PI_HARNESS_INSTALL_DIR: installDir,
  };
  const sandbox: ActiveSandbox = {
    socketPath,
    homeDir,
    fakeDir,
    extraDaemonPids: [],
    tempDirs: [root],
    cleanupHandles: [],
  };
  activeSandbox = sandbox;
  return { root, homeDir, installDir, releasesDir, fakeDir, repoDir, socketPath, env, sandbox };
}

async function pollUntil<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, timeoutMs: number, label: string): Promise<T> {
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

afterEach(async () => {
  const sb = activeSandbox;
  activeSandbox = null;
  if (!sb) return;
  for (const fn of sb.cleanupHandles) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
  await cleanupSandbox({
    socketPath: sb.socketPath,
    homeDir: sb.homeDir,
    fakeDir: sb.fakeDir,
    extraDaemonPids: sb.extraDaemonPids,
    tempDirs: sb.tempDirs,
  });
});

describe("daemon hot-update subprocess e2e", () => {
  it(
    "case 1: reload moves the daemon to release B and resumes the run in place",
    async () => {
      const { homeDir, releasesDir, fakeDir, repoDir, socketPath, env, sandbox } = createSandbox("hu-c1-");
      const relA = buildReleaseDir(releasesDir, "rel-a");
      const relB = buildReleaseDir(releasesDir, "rel-b");
      writeHarnessHome(homeDir, {
        socketPath,
        fakeDir,
        hotUpdate: { mode: "auto", drainTimeoutSec: 20, minIntervalSec: 0 },
      });

      const { pid: pidA } = await startDaemon(relA, env);
      sandbox.extraDaemonPids.push(pidA);

      const pingA = await rpc<any>(socketPath, "ping");
      assert.equal(pingA.releaseId, "rel-a");
      assert.equal(pingA.restartSafe, true);
      assert.equal(pingA.reload?.state, "idle");

      const created = await rpc<{ run: { id: string }; rootTask: { id: string } }>(socketPath, "run.create", {
        goal: "FAKE_ROLE=orchestrator verify hot-update reload",
        repoRoot: repoDir,
      });
      const runId = created.run.id;
      const dbPath = join(homeDir, "control-plane.sqlite");

      // Wait until the child task is running and the 3s durable timer is pending.
      let lastPreSnapshot = "";
      const preState = await pollUntil(
        async () => {
          const runGet = await rpc<{ run: { status: string }; tasks: Array<{ id: string; tier: number; status: string; generation: number; summary?: string | null }> }>(
            socketPath,
            "run.get",
            { runId },
          );
          const orch = runGet.tasks.find((t) => t.tier === 1);
          const child = runGet.tasks.find((t) => t.tier === 3);
          const timers = orch
            ? queryDb(dbPath, (db) =>
                db.prepare("SELECT id, status FROM timers WHERE owner_id = ?").all(orch.id) as Array<{ id: string; status: string }>,
              )
            : [];
          const pids = readRecordedFakePids(fakeDir);
          lastPreSnapshot = JSON.stringify({ tasks: runGet.tasks.map((t) => ({ id: t.id, tier: t.tier, status: t.status, summary: t.summary })), timers, pids });
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
        15_000,
        "child running, timer pending, and fake agent PIDs recorded",
      ).catch((err) => {
        throw new Error(`${err instanceof Error ? err.message : String(err)}; snapshot=${lastPreSnapshot}`);
      });

      // Attach a real reconnecting client (exercises TUI reconnect AND the stopInner reconnect-during-flush fix).
      const tuiClient = new DaemonClient(socketPath);
      await tuiClient.connect();
      await tuiClient.request("tui.register", { kind: "run" });
      await tuiClient.request("attach", { runId, control: "view" });

      let restored = false;
      let sawReloadEvent = false;
      const eventsAfterRestore: DaemonEventFrame[] = [];
      let reconnectHandle: AutoReconnectHandle | null = null;
      tuiClient.onEvent((ev) => {
        if (ev.type === "daemon.reload") sawReloadEvent = true;
        reconnectHandle?.noteDaemonEvent(ev);
        if (restored) eventsAfterRestore.push(ev);
      });
      reconnectHandle = installAutoReconnect({
        client: tuiClient,
        isStopped: () => false,
        spawnDaemon: () => {},
        resync: async () => {
          const p = await tuiClient.request<{ releaseId?: string }>("ping");
          assert.equal(p.releaseId, "rel-b");
          await tuiClient.request("tui.register", { kind: "run" });
          await tuiClient.request("attach", { runId, control: "view" });
        },
        onStatus: (s) => {
          if (s.phase === "restored") restored = true;
        },
      });
      sandbox.cleanupHandles.push(() => {
        reconnectHandle?.dispose();
        tuiClient.close();
      });

      const reloadRes = await runCli(relB, ["daemon", "reload", "--target", relB.releaseDir, "--wait"], env);
      assert.equal(reloadRes.code, 0, `reload failed (code=${reloadRes.code}): stdout=${reloadRes.stdout} stderr=${reloadRes.stderr}`);

      const pingB = await rpc<any>(socketPath, "ping");
      assert.equal(pingB.releaseId, "rel-b");
      assert.notEqual(pingB.pid, pidA);
      assert.equal(pingB.reload?.previousReleaseId, "rel-a");
      sandbox.extraDaemonPids.push(pingB.pid);

      // Reconnecting client must reach restored phase and have observed daemon.reload broadcast.
      await pollUntil(() => restored, 10_000, "reconnecting client restored");
      assert.equal(sawReloadEvent, true, "attached TUI client must receive daemon.reload event");

      // Wait for the preserved 3s timer to fire on daemon B and steer the orchestrator once.
      await pollUntil(
        () => {
          const row = queryDb(dbPath, (db) =>
            db.prepare("SELECT status FROM timers WHERE id = ?").get(preState.timerId) as { status: string } | null,
          );
          if (row?.status !== "fired") return null;
          const steerEvents = queryDb(dbPath, (db) =>
            db
              .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
              .all(runId) as Array<{ payload_json: string }>,
          );
          const timerSteers = steerEvents.filter((e) => e.payload_json.includes(preState.timerId));
          return timerSteers.length >= 1 ? timerSteers : null;
        },
        15_000,
        "preserved timer fired and steered orchestrator",
      );

      // Check post-reload invariants while the run is still active.
      const midRun = await rpc<{ run: { status: string }; tasks: Array<{ id: string; tier: number; status: string; generation: number }> }>(
        socketPath,
        "run.get",
        { runId },
      );
      assert.equal(midRun.run.status, "active");
      assert.deepEqual(
        midRun.tasks.map((t) => t.id).sort(),
        preState.taskIds,
        "task ID set must stay identical across reload",
      );
      const midOrch = midRun.tasks.find((t) => t.id === preState.orchId);
      assert.ok(midOrch);
      assert.equal(midOrch.generation, preState.orchGen, "orchestrator generation must not bump across reload");

      const statusEvents = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT task_id, payload_json FROM events WHERE run_id = ? AND type = 'task.status'")
          .all(runId) as Array<{ task_id: string | null; payload_json: string }>,
      );
      for (const ev of statusEvents) {
        const payload = JSON.parse(ev.payload_json) as { to?: string; status?: string };
        const to = payload.to ?? payload.status;
        assert.notEqual(to, "failed", `unexpected failed status event: ${ev.payload_json}`);
        assert.notEqual(to, "cancelled", `unexpected cancelled status event: ${ev.payload_json}`);
      }

      const timerSteerEvents = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
          .all(runId) as Array<{ payload_json: string }>,
      ).filter((e) => e.payload_json.includes(preState.timerId));
      assert.equal(timerSteerEvents.length, 1, `expected exactly one agent.steered for ${preState.timerId}, got ${timerSteerEvents.length}`);

      // Every fake agent PID recorded before the reload must be dead.
      await pollUntil(
        () => preState.pidsBeforeReload.every((pid) => !isPidAlive(pid)),
        5_000,
        "all pre-reload agent PIDs dead",
      );

      // daemon.log must contain reload: and recovery: lines.
      const logPath = join(dirname(socketPath), "daemon.log");
      assert.ok(existsSync(logPath), `expected daemon.log at ${logPath}`);
      const daemonLog = readFileSync(logPath, "utf8");
      assert.ok(daemonLog.includes("reload:"), "daemon.log must contain reload: lines");
      assert.ok(daemonLog.includes("recovery:"), "daemon.log must contain recovery: lines");

      // Release the child and verify the run completes cleanly and the restored client receives events.
      writeFileSync(join(fakeDir, "go"), "go\n", "utf8");
      await pollUntil(
        async () => {
          const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId });
          return r.run.status === "completed";
        },
        15_000,
        "run completed after go file",
      );

      await pollUntil(() => eventsAfterRestore.length > 0, 5_000, "restored client received post-reload event");

      // Re-check final task set, generation, failed/cancelled events, and sessions.log.
      const finalRun = await rpc<{ run: { status: string }; tasks: Array<{ id: string; generation: number; status: string }> }>(
        socketPath,
        "run.get",
        { runId },
      );
      assert.deepEqual(
        finalRun.tasks.map((t) => t.id).sort(),
        preState.taskIds,
      );
      assert.equal(finalRun.tasks.find((t) => t.id === preState.orchId)?.generation, preState.orchGen);

      const finalStatusEvents = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'task.status'")
          .all(runId) as Array<{ payload_json: string }>,
      );
      for (const ev of finalStatusEvents) {
        const payload = JSON.parse(ev.payload_json) as { to?: string; status?: string };
        const to = payload.to ?? payload.status;
        assert.notEqual(to, "failed", `unexpected failed status event after go: ${ev.payload_json}`);
        assert.notEqual(to, "cancelled", `unexpected cancelled status event after go: ${ev.payload_json}`);
      }

      const sessionsLog = await pollUntil(
        () => {
          const p = join(fakeDir, "sessions.log");
          if (!existsSync(p)) return null;
          const txt = readFileSync(p, "utf8");
          return txt.includes("orchestrator resumed spawned=0") ? txt : null;
        },
        5_000,
        "sessions.log shows resumed orchestrator with spawned=0",
      );
      assert.ok(sessionsLog.includes("orchestrator resumed spawned=0"), `unexpected sessions.log:\n${sessionsLog}`);
      assert.ok(sessionsLog.includes("orchestrator fresh spawned=1"), `unexpected sessions.log:\n${sessionsLog}`);

      // Confirm timer still only steered once even after run completion.
      const finalTimerSteers = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
          .all(runId) as Array<{ payload_json: string }>,
      ).filter((e) => e.payload_json.includes(preState.timerId));
      assert.equal(finalTimerSteers.length, 1);
    },
    45_000,
  );

  it(
    "case 2: a release that fails to boot falls back with exit 3",
    async () => {
      const { homeDir, releasesDir, fakeDir, repoDir, socketPath, env, sandbox } = createSandbox("hu-c2-");
      const relB = buildReleaseDir(releasesDir, "rel-b");
      const relC = buildReleaseDir(releasesDir, "rel-c", { brokenServe: true });
      writeHarnessHome(homeDir, {
        socketPath,
        fakeDir,
        hotUpdate: { mode: "auto", drainTimeoutSec: 20, minIntervalSec: 0 },
      });

      const bootEnv = { ...env, PI_HARNESS_SUPERVISE_BOOT_TIMEOUT_MS: "3000" };
      const { pid: pidB } = await startDaemon(relB, bootEnv);
      sandbox.extraDaemonPids.push(pidB);

      const created = await rpc<{ run: { id: string } }>(socketPath, "run.create", {
        goal: "FAKE_ROLE=orchestrator verify fallback on broken release",
        repoRoot: repoDir,
      });
      const runId = created.run.id;

      const preTaskIds = await pollUntil(
        async () => {
          const r = await rpc<{ tasks: Array<{ id: string; tier: number; status: string }> }>(socketPath, "run.get", { runId });
          const child = r.tasks.find((t) => t.tier === 3);
          return child?.status === "running" ? r.tasks.map((t) => t.id).sort() : null;
        },
        15_000,
        "child running before broken reload",
      );

      const reloadRes = await runCli(relB, ["daemon", "reload", "--target", relC.releaseDir, "--wait"], bootEnv);
      assert.equal(reloadRes.code, 3, `expected exit 3 on fallback, got ${reloadRes.code}: stdout=${reloadRes.stdout} stderr=${reloadRes.stderr}`);

      const pingFallback = await waitForPing(socketPath, (p) => p?.releaseId === "rel-b" && p?.pid !== pidB, 10_000);
      sandbox.extraDaemonPids.push(pingFallback.pid);
      assert.equal(pingFallback.releaseId, "rel-b");
      assert.equal(pingFallback.reload?.lastError?.targetReleaseId, "rel-c");
      assert.ok(typeof pingFallback.reload?.lastError?.error === "string" && pingFallback.reload.lastError.error.length > 0);

      const afterFallback = await rpc<{ run: { status: string }; tasks: Array<{ id: string; status: string; summary?: string | null }> }>(
        socketPath,
        "run.get",
        { runId },
      );
      assert.deepEqual(
        afterFallback.tasks.map((t) => t.id).sort(),
        preTaskIds,
      );
      for (const t of afterFallback.tasks) {
        assert.notEqual(t.status, "failed", `task ${t.id} failed after fallback: ${t.summary}`);
        assert.notEqual(t.status, "cancelled", `task ${t.id} cancelled after fallback: ${t.summary}`);
      }

      writeFileSync(join(fakeDir, "go"), "go\n", "utf8");
      await pollUntil(
        async () => {
          const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId });
          return r.run.status === "completed";
        },
        15_000,
        "run completed after fallback",
      );
    },
    45_000,
  );

  it(
    "case 4: a daemon without reload support gets the notice and is not restarted",
    async () => {
      const { homeDir, releasesDir, fakeDir, socketPath, env, sandbox } = createSandbox("hu-c4-");
      const relA = buildReleaseDir(releasesDir, "rel-a");
      const relB = buildReleaseDir(releasesDir, "rel-b");
      writeHarnessHome(homeDir, {
        socketPath,
        fakeDir,
        hotUpdate: { mode: "auto", drainTimeoutSec: 20, minIntervalSec: 0 },
      });

      const { pid: pidA } = await startDaemon(relA, { ...env, PI_HARNESS_TEST_NO_RELOAD: "1" });
      sandbox.extraDaemonPids.push(pidA);

      const pingBefore = await rpc<any>(socketPath, "ping");
      assert.equal(pingBefore.releaseId, "rel-a");
      assert.equal(pingBefore.reload, undefined, "daemon with PI_HARNESS_TEST_NO_RELOAD=1 must omit ping.reload");

      await assert.rejects(
        () => rpc(socketPath, "daemon.reload", { source: "cli", target: relB }),
        /Unknown daemon op/,
      );

      const reloadRes = await runCli(relB, ["daemon", "reload", "--from-install", "--target", relB.releaseDir], env);
      assert.equal(reloadRes.code, 0, `expected exit 0 notice, got ${reloadRes.code}: stderr=${reloadRes.stderr}`);
      assert.ok(reloadRes.stdout.includes("daemon reload --legacy"), `expected --legacy notice in stdout:\n${reloadRes.stdout}`);
      assert.ok(reloadRes.stdout.includes("does not support hot update"), `expected notice text in stdout:\n${reloadRes.stdout}`);

      // Verify the daemon was not restarted after 1 s.
      await new Promise((r) => setTimeout(r, 1000));
      const pingAfter = await rpc<any>(socketPath, "ping");
      assert.equal(pingAfter.pid, pidA);
      assert.equal(pingAfter.releaseId, "rel-a");
    },
    30_000,
  );

  it(
    "case 5: legacy reload needs a passing dry run and confirmation",
    async () => {
      const { root, homeDir, releasesDir, fakeDir, socketPath, env, sandbox } = createSandbox("hu-c5-");
      const relA = buildReleaseDir(releasesDir, "rel-a");
      const relB = buildReleaseDir(releasesDir, "rel-b");
      writeHarnessHome(homeDir, {
        socketPath,
        fakeDir,
        hotUpdate: { mode: "auto", drainTimeoutSec: 20, minIntervalSec: 0 },
      });

      const { pid: pidA } = await startDaemon(relA, { ...env, PI_HARNESS_TEST_NO_RELOAD: "1" });
      sandbox.extraDaemonPids.push(pidA);

      const pingBefore = await rpc<any>(socketPath, "ping");
      assert.equal(pingBefore.releaseId, "rel-a");
      assert.equal(pingBefore.reload, undefined);

      // Without --yes on non-TTY stdin, legacy reload must exit 2 and leave the daemon untouched.
      const noConfirmRes = await runCli(relB, ["daemon", "reload", "--legacy", "--target", relB.releaseDir], env);
      assert.equal(
        noConfirmRes.code,
        2,
        `expected exit 2 without confirmation, got ${noConfirmRes.code}: stdout=${noConfirmRes.stdout} stderr=${noConfirmRes.stderr}`,
      );
      assert.ok(noConfirmRes.stderr.includes("Not confirmed"), `expected confirmation message in stderr:\n${noConfirmRes.stderr}`);
      assert.ok(noConfirmRes.stdout.includes("Legacy reload plan:"), `expected plan in stdout:\n${noConfirmRes.stdout}`);

      const pingAfterNoConfirm = await rpc<any>(socketPath, "ping");
      assert.equal(pingAfterNoConfirm.pid, pidA);
      assert.equal(pingAfterNoConfirm.releaseId, "rel-a");

      // With --yes and --db pointing to a non-database file, dry run must fail with exit 1 and leave daemon untouched.
      const badDbPath = join(root, "not-a-db.txt");
      writeFileSync(badDbPath, "this is not a sqlite database\n", "utf8");
      const badDbRes = await runCli(
        relB,
        ["daemon", "reload", "--legacy", "--yes", "--db", badDbPath, "--target", relB.releaseDir],
        env,
      );
      assert.equal(
        badDbRes.code,
        1,
        `expected exit 1 on failed dry run, got ${badDbRes.code}: stdout=${badDbRes.stdout} stderr=${badDbRes.stderr}`,
      );
      assert.ok(
        `${badDbRes.stderr}\n${badDbRes.stdout}`.includes("dry run failed"),
        `expected "dry run failed" in output:\nstdout=${badDbRes.stdout}\nstderr=${badDbRes.stderr}`,
      );

      const pingAfterBadDb = await rpc<any>(socketPath, "ping");
      assert.equal(pingAfterBadDb.pid, pidA);
      assert.equal(pingAfterBadDb.releaseId, "rel-a");
    },
    30_000,
  );

  it(
    "case 6: legacy path restarts a daemon without reload support and resumes its run",
    async () => {
      const { homeDir, releasesDir, fakeDir, repoDir, socketPath, env, sandbox } = createSandbox("hu-c6-");
      const relA = buildReleaseDir(releasesDir, "rel-a");
      const relB = buildReleaseDir(releasesDir, "rel-b");
      writeHarnessHome(homeDir, {
        socketPath,
        fakeDir,
        hotUpdate: { mode: "auto", drainTimeoutSec: 20, minIntervalSec: 0 },
      });

      const { pid: pidA } = await startDaemon(relA, { ...env, PI_HARNESS_TEST_NO_RELOAD: "1" });
      sandbox.extraDaemonPids.push(pidA);

      const pingA = await rpc<any>(socketPath, "ping");
      assert.equal(pingA.releaseId, "rel-a");
      assert.equal(pingA.reload, undefined);

      const created = await rpc<{ run: { id: string }; rootTask: { id: string } }>(socketPath, "run.create", {
        goal: "FAKE_ROLE=orchestrator verify legacy hot-update reload",
        repoRoot: repoDir,
      });
      const runId = created.run.id;
      const dbPath = join(homeDir, "control-plane.sqlite");

      let lastPreSnapshot = "";
      const preState = await pollUntil(
        async () => {
          const runGet = await rpc<{
            run: { status: string };
            tasks: Array<{ id: string; tier: number; status: string; generation: number; summary?: string | null }>;
          }>(socketPath, "run.get", { runId });
          const orch = runGet.tasks.find((t) => t.tier === 1);
          const child = runGet.tasks.find((t) => t.tier === 3);
          const timers = orch
            ? queryDb(dbPath, (db) =>
                db.prepare("SELECT id, status FROM timers WHERE owner_id = ?").all(orch.id) as Array<{ id: string; status: string }>,
              )
            : [];
          const pids = readRecordedFakePids(fakeDir);
          lastPreSnapshot = JSON.stringify({
            tasks: runGet.tasks.map((t) => ({ id: t.id, tier: t.tier, status: t.status, summary: t.summary })),
            timers,
            pids,
          });
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
        15_000,
        "child running, timer pending, and fake agent PIDs recorded before legacy reload",
      ).catch((err) => {
        throw new Error(`${err instanceof Error ? err.message : String(err)}; snapshot=${lastPreSnapshot}`);
      });

      const tuiClient = new DaemonClient(socketPath);
      await tuiClient.connect();
      await tuiClient.request("tui.register", { kind: "run" });
      await tuiClient.request("attach", { runId, control: "view" });

      let restored = false;
      const eventsAfterRestore: DaemonEventFrame[] = [];
      let reconnectHandle: AutoReconnectHandle | null = null;
      tuiClient.onEvent((ev) => {
        reconnectHandle?.noteDaemonEvent(ev);
        if (restored) eventsAfterRestore.push(ev);
      });
      reconnectHandle = installAutoReconnect({
        client: tuiClient,
        isStopped: () => false,
        spawnDaemon: () => {},
        resync: async () => {
          const p = await tuiClient.request<{ releaseId?: string }>("ping");
          assert.equal(p.releaseId, "rel-b");
          await tuiClient.request("tui.register", { kind: "run" });
          await tuiClient.request("attach", { runId, control: "view" });
        },
        onStatus: (s) => {
          if (s.phase === "restored") restored = true;
        },
      });
      sandbox.cleanupHandles.push(() => {
        reconnectHandle?.dispose();
        tuiClient.close();
      });

      const reloadRes = await runCli(
        relB,
        ["daemon", "reload", "--legacy", "--yes", "--wait", "--target", relB.releaseDir],
        env,
      );
      assert.equal(
        reloadRes.code,
        0,
        `legacy reload failed (code=${reloadRes.code}): stdout=${reloadRes.stdout} stderr=${reloadRes.stderr}`,
      );
      assert.ok(reloadRes.stdout.includes("restart handed to supervisor"), `expected supervisor handoff line:\n${reloadRes.stdout}`);

      const pingB = await rpc<any>(socketPath, "ping");
      assert.equal(pingB.releaseId, "rel-b");
      assert.notEqual(pingB.pid, pidA);
      assert.equal(pingB.reload?.state, "idle");
      assert.equal(pingB.reload?.previousReleaseId, "rel-a");
      sandbox.extraDaemonPids.push(pingB.pid);

      await pollUntil(() => restored, 10_000, "reconnecting client restored after legacy reload");

      // Wait for the preserved 3s timer to fire on daemon B and steer the orchestrator once.
      await pollUntil(
        () => {
          const row = queryDb(dbPath, (db) =>
            db.prepare("SELECT status FROM timers WHERE id = ?").get(preState.timerId) as { status: string } | null,
          );
          if (row?.status !== "fired") return null;
          const steerEvents = queryDb(dbPath, (db) =>
            db
              .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
              .all(runId) as Array<{ payload_json: string }>,
          );
          const timerSteers = steerEvents.filter((e) => e.payload_json.includes(preState.timerId));
          return timerSteers.length >= 1 ? timerSteers : null;
        },
        15_000,
        "preserved timer fired and steered orchestrator after legacy reload",
      );

      // Post-reload invariants while the run is active.
      const midRun = await rpc<{
        run: { status: string };
        tasks: Array<{ id: string; tier: number; status: string; generation: number }>;
      }>(socketPath, "run.get", { runId });
      assert.equal(midRun.run.status, "active");
      assert.deepEqual(
        midRun.tasks.map((t) => t.id).sort(),
        preState.taskIds,
        "task ID set must stay identical across legacy reload",
      );
      const midOrch = midRun.tasks.find((t) => t.id === preState.orchId);
      assert.ok(midOrch);
      assert.equal(midOrch.generation, preState.orchGen, "orchestrator generation must not bump across legacy reload");

      // Legacy reload does not steer agents to call request_rollover; orchestrator must resume from a harness-built handoff.
      const rolloverEvents = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.rollover'")
          .all(runId) as Array<{ payload_json: string }>,
      );
      assert.equal(rolloverEvents.length, 0, "legacy reload must not trigger agent.rollover");
      const orchRow = queryDb(dbPath, (db) =>
        db.prepare("SELECT handoff_json FROM tasks WHERE id = ?").get(preState.orchId) as { handoff_json: string | null } | null,
      );
      assert.ok(orchRow?.handoff_json, "expected harness-built handoff_json on resumed orchestrator");
      assert.ok(
        !orchRow.handoff_json.includes("Preserve child task across daemon restart"),
        `expected harness-built handoff rather than fake agent rollover handoff: ${orchRow.handoff_json}`,
      );

      const statusEvents = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT task_id, payload_json FROM events WHERE run_id = ? AND type = 'task.status'")
          .all(runId) as Array<{ task_id: string | null; payload_json: string }>,
      );
      for (const ev of statusEvents) {
        const payload = JSON.parse(ev.payload_json) as { to?: string; status?: string };
        const to = payload.to ?? payload.status;
        assert.notEqual(to, "failed", `unexpected failed status event: ${ev.payload_json}`);
        assert.notEqual(to, "cancelled", `unexpected cancelled status event: ${ev.payload_json}`);
      }

      const timerSteerEvents = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
          .all(runId) as Array<{ payload_json: string }>,
      ).filter((e) => e.payload_json.includes(preState.timerId));
      assert.equal(timerSteerEvents.length, 1, `expected exactly one agent.steered for ${preState.timerId}, got ${timerSteerEvents.length}`);

      await pollUntil(
        () => preState.pidsBeforeReload.every((pid) => !isPidAlive(pid)),
        5_000,
        "all pre-reload agent PIDs dead after legacy reload",
      );

      const logPath = join(dirname(socketPath), "daemon.log");
      assert.ok(existsSync(logPath), `expected daemon.log at ${logPath}`);
      const daemonLog = readFileSync(logPath, "utf8");
      assert.ok(daemonLog.includes("legacy stop:"), "daemon.log must contain legacy stop: lines");
      assert.ok(daemonLog.includes("recovery:"), "daemon.log must contain recovery: lines");

      // Release the child and verify the run completes cleanly.
      writeFileSync(join(fakeDir, "go"), "go\n", "utf8");
      await pollUntil(
        async () => {
          const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId });
          return r.run.status === "completed";
        },
        15_000,
        "run completed after go file (legacy reload)",
      );

      await pollUntil(() => eventsAfterRestore.length > 0, 5_000, "restored client received post-reload event");

      const finalRun = await rpc<{ run: { status: string }; tasks: Array<{ id: string; generation: number; status: string }> }>(
        socketPath,
        "run.get",
        { runId },
      );
      assert.deepEqual(
        finalRun.tasks.map((t) => t.id).sort(),
        preState.taskIds,
      );
      assert.equal(finalRun.tasks.find((t) => t.id === preState.orchId)?.generation, preState.orchGen);

      const finalStatusEvents = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'task.status'")
          .all(runId) as Array<{ payload_json: string }>,
      );
      for (const ev of finalStatusEvents) {
        const payload = JSON.parse(ev.payload_json) as { to?: string; status?: string };
        const to = payload.to ?? payload.status;
        assert.notEqual(to, "failed", `unexpected failed status event after go: ${ev.payload_json}`);
        assert.notEqual(to, "cancelled", `unexpected cancelled status event after go: ${ev.payload_json}`);
      }

      const sessionsLog = await pollUntil(
        () => {
          const p = join(fakeDir, "sessions.log");
          if (!existsSync(p)) return null;
          const txt = readFileSync(p, "utf8");
          return txt.includes("orchestrator resumed spawned=0") ? txt : null;
        },
        5_000,
        "sessions.log shows resumed orchestrator with spawned=0",
      );
      assert.ok(sessionsLog.includes("orchestrator resumed spawned=0"), `unexpected sessions.log:\n${sessionsLog}`);
      assert.ok(sessionsLog.includes("orchestrator fresh spawned=1"), `unexpected sessions.log:\n${sessionsLog}`);

      const finalTimerSteers = queryDb(dbPath, (db) =>
        db
          .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
          .all(runId) as Array<{ payload_json: string }>,
      ).filter((e) => e.payload_json.includes(preState.timerId));
      assert.equal(finalTimerSteers.length, 1);
    },
    45_000,
  );
});
