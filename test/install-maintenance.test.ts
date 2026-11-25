import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { prepareDaemonLogForSpawn, readDaemonLogTail } from "../src/daemon/launch.js";
import {
  cleanStaleStagingDirs,
  cleanupOctofsVersions,
  listUserProcessCmdlines,
  parsePinnedOctofsVersion,
  pruneInstallReleases,
  RECENT_RELEASE_WINDOW_MS,
  recordRollbackPair,
  rotateLogIfOversized,
  runInstallMaintenance,
  STAGING_MAX_AGE_MS,
} from "../src/install/maintenance.js";
import { ensureOctofs, OCTOFS_VERSION } from "../src/tools/native-tools.js";

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function createRelease(
  installDir: string,
  id: string,
  mtimeMs: number,
  octofsVersion: string | null = OCTOFS_VERSION,
): string {
  const relDir = join(installDir, "releases", id);
  mkdirSync(join(relDir, "src", "tools"), { recursive: true });
  writeFileSync(join(relDir, ".installed"), "");
  if (octofsVersion !== null) {
    writeFileSync(
      join(relDir, "src", "tools", "native-tools.ts"),
      `export const OCTOFS_VERSION = "${octofsVersion}";\n`,
    );
  }
  const t = new Date(mtimeMs);
  utimesSync(relDir, t, t);
  return relDir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("install release pruning", () => {
  const NOW = 1_750_000_000_000;
  const HOUR = 60 * 60 * 1000;

  it("keeps all releases at exactly N and prunes the oldest at N+1", () => {
    const root = makeTempRoot("pi-maint-bound-");
    const installDir = join(root, "install");
    createRelease(installDir, "r1", NOW - 4 * HOUR);
    createRelease(installDir, "r2", NOW - 3 * HOUR);
    createRelease(installDir, "r3", NOW - 2 * HOUR);
    recordRollbackPair(installDir, "r3", "r2");

    const atN = pruneInstallReleases({
      installDir,
      current: "r3",
      keepCount: 3,
      listProcesses: () => [],
      now: () => NOW,
    });
    assert.equal(atN.skipped, null);
    assert.deepEqual(atN.removed, []);
    assert.deepEqual(atN.kept.sort(), ["r1", "r2", "r3"]);

    createRelease(installDir, "r4", NOW - 1 * HOUR);
    recordRollbackPair(installDir, "r4", "r3");
    const atNPlus1 = pruneInstallReleases({
      installDir,
      current: "r4",
      keepCount: 3,
      listProcesses: () => [],
      now: () => NOW,
    });
    assert.equal(atNPlus1.skipped, null);
    assert.deepEqual(atNPlus1.removed, ["r1"]);
    assert.equal(existsSync(join(installDir, "releases", "r1")), false);
    assert.deepEqual(atNPlus1.kept.sort(), ["r2", "r3", "r4"]);
  });

  it("keeps the previous release when present on disk even if it is the oldest", () => {
    const root = makeTempRoot("pi-maint-prev-");
    const installDir = join(root, "install");
    createRelease(installDir, "r1", NOW - 5 * HOUR);
    createRelease(installDir, "r2", NOW - 4 * HOUR);
    createRelease(installDir, "r3", NOW - 3 * HOUR);
    createRelease(installDir, "r4", NOW - 2 * HOUR);

    const res = pruneInstallReleases({
      installDir,
      current: "r4",
      previous: "r1",
      keepCount: 3,
      listProcesses: () => [],
      now: () => NOW,
    });
    assert.equal(res.skipped, null);
    assert.deepEqual(res.removed, ["r2"]);
    assert.deepEqual(res.kept.sort(), ["r1", "r3", "r4"]);
    assert.equal(existsSync(join(installDir, "releases", "r1")), true);
    assert.equal(existsSync(join(installDir, "releases", "r2")), false);
  });

  it("keeps every in-use release beyond retention.installReleases", () => {
    const root = makeTempRoot("pi-maint-inuse-");
    const installDir = join(root, "install");
    const r1 = createRelease(installDir, "r1", NOW - 6 * HOUR);
    const r2 = createRelease(installDir, "r2", NOW - 5 * HOUR);
    const r3 = createRelease(installDir, "r3", NOW - 4 * HOUR);
    createRelease(installDir, "r4", NOW - 3 * HOUR);
    createRelease(installDir, "r5", NOW - 2 * HOUR);
    recordRollbackPair(installDir, "r5", "r3");

    const res = pruneInstallReleases({
      installDir,
      current: "r5",
      keepCount: 2,
      listProcesses: () => [
        `/usr/bin/bun ${r1}/src/cli.ts daemon serve`,
        `/usr/bin/bun ${r2}/src/runners/mcp-bridge.ts`,
        `/usr/bin/bun ${r3}/src/cli.ts chat`,
      ],
      now: () => NOW,
    });
    assert.equal(res.skipped, null);
    assert.deepEqual(res.removed, ["r4"]);
    assert.deepEqual(res.kept.sort(), ["r1", "r2", "r3", "r5"]);
  });

  it("keeps releases modified within the last 10 minutes beyond keepCount", () => {
    const root = makeTempRoot("pi-maint-recent-");
    const installDir = join(root, "install");
    createRelease(installDir, "old-pruned", NOW - RECENT_RELEASE_WINDOW_MS - 1_000);
    createRelease(installDir, "recent-edge", NOW - RECENT_RELEASE_WINDOW_MS);
    createRelease(installDir, "recent-fresh", NOW - 60_000);
    createRelease(installDir, "current-rel", NOW - 2 * HOUR);
    recordRollbackPair(installDir, "current-rel", "recent-fresh");

    const res = pruneInstallReleases({
      installDir,
      current: "current-rel",
      keepCount: 2,
      listProcesses: () => [],
      now: () => NOW,
    });
    assert.equal(res.skipped, null);
    assert.deepEqual(res.removed, ["old-pruned"]);
    assert.deepEqual(res.kept.sort(), ["current-rel", "recent-edge", "recent-fresh"]);
  });

  it("prunes nothing when the process list cannot be read", () => {
    const root = makeTempRoot("pi-maint-noproc-");
    const installDir = join(root, "install");
    createRelease(installDir, "r1", NOW - 5 * HOUR);
    createRelease(installDir, "r2", NOW - 4 * HOUR);
    createRelease(installDir, "r3", NOW - 3 * HOUR);
    createRelease(installDir, "r4", NOW - 2 * HOUR);

    const resNull = pruneInstallReleases({
      installDir,
      current: "r4",
      keepCount: 1,
      listProcesses: () => null,
      now: () => NOW,
    });
    assert.equal(resNull.skipped, "process_list_unreadable");
    assert.deepEqual(resNull.removed, []);
    assert.equal(existsSync(join(installDir, "releases", "r1")), true);

    const resThrow = pruneInstallReleases({
      installDir,
      current: "r4",
      keepCount: 1,
      listProcesses: () => {
        throw new Error("proc unavailable");
      },
      now: () => NOW,
    });
    assert.equal(resThrow.skipped, "process_list_unreadable");
    assert.deepEqual(resThrow.removed, []);
    assert.equal(existsSync(join(installDir, "releases", "r1")), true);
  });

  it("skips pruning without removing the lock when installDir/.lock is held", () => {
    const root = makeTempRoot("pi-maint-lock-");
    const installDir = join(root, "install");
    const stateDir = join(root, "state");
    createRelease(installDir, "r1", NOW - 5 * HOUR);
    createRelease(installDir, "r2", NOW - 4 * HOUR);
    createRelease(installDir, "r3", NOW - 3 * HOUR);
    const unusedOctofs = join(installDir, "tools", "octofs", "0.20.0-x86_64-unknown-linux-musl");
    mkdirSync(unusedOctofs, { recursive: true });
    const lockDir = join(installDir, ".lock");
    mkdirSync(lockDir, { recursive: true });

    const res = pruneInstallReleases({
      installDir,
      current: "r3",
      keepCount: 1,
      listProcesses: () => [],
      now: () => NOW,
    });
    assert.equal(res.skipped, "lock_held");
    assert.deepEqual(res.removed, []);
    assert.equal(existsSync(lockDir), true);
    assert.equal(existsSync(join(installDir, "releases", "r1")), true);

    const octofsRes = cleanupOctofsVersions({
      installDir,
      stateDir,
      listProcesses: () => [],
    });
    assert.equal(octofsRes.skipped, "lock_held");
    assert.deepEqual(octofsRes.removed, []);
    assert.equal(existsSync(lockDir), true);
    assert.equal(existsSync(unusedOctofs), true);
  });
});

describe("audit log and daemon.log rotation", () => {
  it("rotates install-audit.log strictly above the byte limit and replaces an older .1", () => {
    const root = makeTempRoot("pi-maint-audit-");
    const logPath = join(root, "install-audit.log");
    const limit = 16;

    writeFileSync(logPath, "a".repeat(limit));
    assert.equal(rotateLogIfOversized(logPath, limit), false);
    assert.equal(existsSync(logPath), true);
    assert.equal(existsSync(`${logPath}.1`), false);

    writeFileSync(`${logPath}.1`, "older-backup");
    writeFileSync(logPath, "b".repeat(limit + 1));
    assert.equal(rotateLogIfOversized(logPath, limit), true);
    assert.equal(existsSync(logPath), false);
    assert.equal(readFileSync(`${logPath}.1`, "utf8"), "b".repeat(limit + 1));
  });

  it("rotates daemon.log at spawn and still returns the new daemon tail on startup failure", () => {
    const root = makeTempRoot("pi-maint-daemonlog-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ retention: { logMaxBytes: 32 } }));

    const logPath = join(root, "daemon.log");
    writeFileSync(logPath, "old-line-".repeat(10)); // 90 bytes > 32

    const logStart = prepareDaemonLogForSpawn(logPath, stateDir);
    assert.equal(logStart, 0);
    assert.equal(existsSync(logPath), false);
    assert.equal(existsSync(`${logPath}.1`), true);

    appendFileSync(logPath, "fatal: new daemon failed to bind socket\n");
    const tail = readDaemonLogTail(logPath, logStart, 2000);
    assert.equal(tail, "fatal: new daemon failed to bind socket");
  });

  it("returns the new daemon tail even if rotation occurs after a previous offset snapshot", () => {
    const root = makeTempRoot("pi-maint-tailrot-");
    const logPath = join(root, "daemon.log");
    writeFileSync(logPath, "x".repeat(500));
    const staleOffset = 500;

    assert.equal(rotateLogIfOversized(logPath, 100), true);
    writeFileSync(logPath, "boot error after rotation\n");

    const tail = readDaemonLogTail(logPath, staleOffset, 2000);
    assert.equal(tail, "boot error after rotation");
  });

  it("never throws when logPath is missing or limit is invalid", () => {
    const root = makeTempRoot("pi-maint-missing-");
    assert.equal(rotateLogIfOversized(join(root, "does-not-exist.log"), 1024), false);
    assert.equal(rotateLogIfOversized(join(root, "does-not-exist.log"), 0), false);
    assert.equal(prepareDaemonLogForSpawn(join(root, "does-not-exist.log"), join(root, "no-state")), 0);
  });
});

describe("tools staging and octofs cleanup", () => {
  const NOW = 1_750_000_000_000;

  it("removes tools/.staging entries strictly older than one day and keeps newer ones", () => {
    const root = makeTempRoot("pi-maint-staging-");
    const stateDir = join(root, "state");
    const stagingDir = join(stateDir, "tools", ".staging");
    mkdirSync(stagingDir, { recursive: true });

    const exactBoundary = join(stagingDir, "octofs-boundary");
    const tooOld = join(stagingDir, "octofs-stale");
    const fresh = join(stagingDir, "octofs-fresh");
    mkdirSync(exactBoundary);
    mkdirSync(tooOld);
    mkdirSync(fresh);

    utimesSync(exactBoundary, new Date(NOW - STAGING_MAX_AGE_MS), new Date(NOW - STAGING_MAX_AGE_MS));
    utimesSync(tooOld, new Date(NOW - STAGING_MAX_AGE_MS - 1_000), new Date(NOW - STAGING_MAX_AGE_MS - 1_000));
    utimesSync(fresh, new Date(NOW - 60_000), new Date(NOW - 60_000));

    const removed = cleanStaleStagingDirs(stateDir, { now: () => NOW });
    assert.deepEqual(removed, ["octofs-stale"]);
    assert.equal(existsSync(tooOld), false);
    assert.equal(existsSync(exactBoundary), true);
    assert.equal(existsSync(fresh), true);
  });

  it("ensureOctofs cleans stale staging entries without removing octofs version directories", async () => {
    const root = makeTempRoot("pi-maint-ensure-");
    const stateDir = join(root, "state");
    const stagingStale = join(stateDir, "tools", ".staging", "octofs-old");
    const stagingFresh = join(stateDir, "tools", ".staging", "octofs-fresh");
    const oldOctofsDir = join(stateDir, "tools", "octofs", "0.20.0-x86_64-unknown-linux-musl");
    mkdirSync(stagingStale, { recursive: true });
    mkdirSync(stagingFresh, { recursive: true });
    mkdirSync(oldOctofsDir, { recursive: true });

    const oldTime = new Date(Date.now() - STAGING_MAX_AGE_MS - 60_000);
    utimesSync(stagingStale, oldTime, oldTime);

    // Put a fake current octofs binary in stateDir so ensureOctofs never hits the network.
    const currentBin = join(stateDir, "tools", "octofs", `${OCTOFS_VERSION}-x86_64-unknown-linux-musl`, "bin", "octofs");
    const currentArmBin = join(stateDir, "tools", "octofs", `${OCTOFS_VERSION}-aarch64-unknown-linux-musl`, "bin", "octofs");
    const currentMacArmBin = join(stateDir, "tools", "octofs", `${OCTOFS_VERSION}-aarch64-apple-darwin`, "bin", "octofs");
    const currentMacX64Bin = join(stateDir, "tools", "octofs", `${OCTOFS_VERSION}-x86_64-apple-darwin`, "bin", "octofs");
    for (const bin of [currentBin, currentArmBin, currentMacArmBin, currentMacX64Bin]) {
      mkdirSync(join(bin, ".."), { recursive: true });
      writeFileSync(bin, "#!/bin/sh\n");
    }

    await ensureOctofs(stateDir);
    assert.equal(existsSync(stagingStale), false);
    assert.equal(existsSync(stagingFresh), true);
    assert.equal(existsSync(oldOctofsDir), true);
  });

  it("keeps octofs versions pinned by any kept release or running process, and removes unused ones", () => {
    const root = makeTempRoot("pi-maint-octofs-");
    const installDir = join(root, "install");
    const stateDir = join(root, "state");
    createRelease(installDir, "r-new", NOW, "0.26.0");
    createRelease(installDir, "r-prev", NOW, "0.25.0");

    const installPinnedNew = join(installDir, "tools", "octofs", "0.26.0-x86_64-unknown-linux-musl");
    const installPinnedPrev = join(installDir, "tools", "octofs", "0.25.0-x86_64-unknown-linux-musl");
    const installUnused = join(installDir, "tools", "octofs", "0.24.0-x86_64-unknown-linux-musl");
    const stateInUse = join(stateDir, "tools", "octofs", "0.23.0-x86_64-unknown-linux-musl");
    const stateUnused = join(stateDir, "tools", "octofs", "0.22.0-x86_64-unknown-linux-musl");
    for (const d of [installPinnedNew, installPinnedPrev, installUnused, stateInUse, stateUnused]) {
      mkdirSync(join(d, "bin"), { recursive: true });
    }

    const res = cleanupOctofsVersions({
      installDir,
      stateDir,
      listProcesses: () => [`${stateInUse}/bin/octofs mcp`],
    });
    assert.equal(res.skipped, null);
    assert.deepEqual(res.pinnedVersions.sort(), ["0.25.0", "0.26.0"]);
    assert.equal(existsSync(installPinnedNew), true);
    assert.equal(existsSync(installPinnedPrev), true);
    assert.equal(existsSync(stateInUse), true);
    assert.equal(existsSync(installUnused), false);
    assert.equal(existsSync(stateUnused), false);
  });

  it("removes no octofs versions when any kept release cannot be parsed", () => {
    const root = makeTempRoot("pi-maint-unparse-");
    const installDir = join(root, "install");
    const stateDir = join(root, "state");
    createRelease(installDir, "r-good", NOW, "0.26.0");
    createRelease(installDir, "r-bad", NOW, null);
    writeFileSync(join(installDir, "releases", "r-bad", "src", "tools", "native-tools.ts"), "// no pin here\n");

    const unused = join(installDir, "tools", "octofs", "0.20.0-x86_64-unknown-linux-musl");
    mkdirSync(unused, { recursive: true });

    const res = cleanupOctofsVersions({
      installDir,
      stateDir,
      listProcesses: () => [],
    });
    assert.equal(res.skipped, "unparseable_release");
    assert.deepEqual(res.removed, []);
    assert.equal(existsSync(unused), true);
    assert.equal(parsePinnedOctofsVersion('export const OCTOFS_VERSION = "0.26.0";'), "0.26.0");
    assert.equal(parsePinnedOctofsVersion("const other = 1;"), null);
  });
});

describe("maintenance orchestrator and CLI entry", () => {
  const NOW = 1_750_000_000_000;
  const HOUR = 60 * 60 * 1000;

  it("reads retention config from stateDir/config.json and runs all steps independently", () => {
    const root = makeTempRoot("pi-maint-full-");
    const installDir = join(root, "install");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({ retention: { installReleases: 2, logMaxBytes: 10 } }),
    );
    writeFileSync(join(stateDir, "install-audit.log"), "0123456789abcdef");

    createRelease(installDir, "r1", NOW - 4 * HOUR, "0.24.0");
    createRelease(installDir, "r2", NOW - 3 * HOUR, "0.25.0");
    createRelease(installDir, "r3", NOW - 2 * HOUR, "0.26.0");
    recordRollbackPair(installDir, "r3", "r2");

    const octofsOld = join(installDir, "tools", "octofs", "0.24.0-x86_64-unknown-linux-musl");
    const octofsKept = join(installDir, "tools", "octofs", "0.25.0-x86_64-unknown-linux-musl");
    mkdirSync(octofsOld, { recursive: true });
    mkdirSync(octofsKept, { recursive: true });

    const staleStage = join(stateDir, "tools", ".staging", "octofs-old");
    mkdirSync(staleStage, { recursive: true });
    utimesSync(staleStage, new Date(NOW - STAGING_MAX_AGE_MS - 1_000), new Date(NOW - STAGING_MAX_AGE_MS - 1_000));

    const res = runInstallMaintenance({
      installDir,
      stateDir,
      current: "r3",
      listProcesses: () => [],
      now: () => NOW,
    });
    assert.deepEqual(res.releases.removed, ["r1"]);
    assert.equal(res.auditLogRotated, true);
    assert.equal(existsSync(join(stateDir, "install-audit.log.1")), true);
    assert.deepEqual(res.stagingRemoved, ["octofs-old"]);
    assert.equal(existsSync(octofsOld), false);
    assert.equal(existsSync(octofsKept), true);
  });

  it("CLI entry always exits 0 even with missing arguments", () => {
    const scriptPath = join(process.cwd(), "src", "install", "maintenance.ts");
    const res = spawnSync(process.execPath, [scriptPath], { encoding: "utf8", timeout: 10_000 });
    assert.equal(res.status, 0);
    assert.ok(res.stderr.includes("missing required arguments"));
  });

  it("listUserProcessCmdlines reads running user processes on this host", () => {
    const cmdlines = listUserProcessCmdlines();
    assert.ok(Array.isArray(cmdlines));
    assert.ok(cmdlines.length > 0);
  });

  it("fails closed on unreadable same-user /proc entry, logs once to audit log, and still runs rotation and tools cleanup (I2)", () => {
    if (process.platform !== "linux") return;
    const root = makeTempRoot("pi-maint-proc-failclosed-");
    const installDir = join(root, "install");
    const stateDir = join(root, "state");
    const procRoot = join(root, "proc");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(join(procRoot, "1001"), { recursive: true });
    mkdirSync(join(procRoot, "1003"), { recursive: true });
    writeFileSync(
      join(stateDir, "config.json"),
      JSON.stringify({ retention: { installReleases: 1, logMaxBytes: 10 } }),
    );
    createRelease(installDir, "r1", NOW - 4 * HOUR, "0.25.0");
    const r2Dir = createRelease(installDir, "r2", NOW - 3 * HOUR, "0.26.0");
    createRelease(installDir, "r3", NOW - 2 * HOUR, "0.26.0");
    recordRollbackPair(installDir, "r3", "r2");
    // 1001 is readable and references r2; 1003 has no cmdline (ENOENT, simulates a process that exited mid-scan).
    writeFileSync(join(procRoot, "1001", "cmdline"), `/usr/bin/bun\0${r2Dir}/src/cli.ts\0`, "utf8");

    // First pass: ENOENT on 1003 is tolerated (process gone), so r1 is pruned and nothing is written to install-audit.log.
    const okRes = runInstallMaintenance({
      installDir,
      stateDir,
      current: "r3",
      now: () => NOW,
      procRoot,
    });
    assert.equal(okRes.releases.skipped, null);
    assert.deepEqual(okRes.releases.removed, ["r1"]);
    assert.equal(existsSync(join(stateDir, "install-audit.log")), false);

    // Add an old unused release r0 that would be pruned if process inventory succeeded,
    // plus same-user process 1002 whose cmdline fails with EACCES (or EISDIR if running as root).
    createRelease(installDir, "r0", NOW - 5 * HOUR, "0.25.0");
    const blockedCmdline = join(procRoot, "1002", "cmdline");
    mkdirSync(join(procRoot, "1002"), { recursive: true });
    const isRoot = process.getuid?.() === 0;
    if (isRoot) {
      mkdirSync(blockedCmdline, { recursive: true });
    } else {
      writeFileSync(blockedCmdline, "/usr/bin/bun\0r0\0", "utf8");
      chmodSync(blockedCmdline, 0o000);
    }

    try {
      const auditLogPath = join(stateDir, "install-audit.log");
      writeFileSync(auditLogPath, "0123456789abcdef\n", "utf8");

      const staleStage = join(stateDir, "tools", ".staging", "octofs-stale");
      mkdirSync(staleStage, { recursive: true });
      utimesSync(staleStage, new Date(NOW - STAGING_MAX_AGE_MS - 1_000), new Date(NOW - STAGING_MAX_AGE_MS - 1_000));

      const res = runInstallMaintenance({
        installDir,
        stateDir,
        current: "r3",
        now: () => NOW,
        procRoot,
      });

      assert.equal(res.releases.skipped, "process_list_unreadable");
      assert.deepEqual(res.releases.removed, []);
      assert.equal(existsSync(join(installDir, "releases", "r0")), true, "r0 must not be pruned when inventory fails");
      assert.equal(res.auditLogRotated, true, "audit log rotation must still run");
      assert.equal(existsSync(`${auditLogPath}.1`), true);
      assert.deepEqual(res.stagingRemoved, ["octofs-stale"], "tools staging cleanup must still run");

      const auditLines = readFileSync(auditLogPath, "utf8").trim().split(/\r?\n/);
      assert.equal(auditLines.length, 1, `expected exactly 1 audit line for skipped pruning, got:\n${auditLines.join("\n")}`);
      assert.ok(auditLines[0]!.includes("1002"), `audit line should name failing pid: ${auditLines[0]}`);
      assert.ok(
        auditLines[0]!.includes(isRoot ? "EISDIR" : "EACCES"),
        `audit line should include error code: ${auditLines[0]}`,
      );
    } finally {
      if (!isRoot) {
        try {
          chmodSync(blockedCmdline, 0o600);
        } catch {
          // ignore
        }
      }
    }
  });
});
