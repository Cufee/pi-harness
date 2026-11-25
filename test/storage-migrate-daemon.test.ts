import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { GoalEngine } from "../src/goals/engine.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const INITIAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];
const restoreModes: Array<{ path: string; mode: number }> = [];
const activeDaemons: HarnessDaemon[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

function initTempGitRepo(prefix: string): { repoDir: string; baseSha: string } {
  const repoDir = makeTempDir(prefix);
  execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "ignore" });
  writeFileSync(join(repoDir, "README.md"), "# Storage Migrate Daemon Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  return { repoDir, baseSha };
}

function writeFile(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Recursively hashes regular files under `rootDir` (without following symlinks) keyed by POSIX relative path. */
function hashTree(rootDir: string, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(rootDir)) return out;
  const st = lstatSync(rootDir);
  if (st.isSymbolicLink()) return out;
  if (st.isFile()) {
    out.set(prefix || ".", sha256(readFileSync(rootDir)));
    return out;
  }
  for (const entry of readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const abs = join(rootDir, entry.name);
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      for (const [k, v] of hashTree(abs, rel)) out.set(k, v);
    } else if (entry.isFile()) {
      out.set(rel, sha256(readFileSync(abs)));
    }
  }
  return out;
}

function assertHashMapEqual(actual: Map<string, string>, expected: Map<string, string>, label: string): void {
  assert.deepEqual(
    [...actual.entries()].sort(([a], [b]) => a.localeCompare(b)),
    [...expected.entries()].sort(([a], [b]) => a.localeCompare(b)),
    `Hash map mismatch for ${label}`,
  );
}

function setLayoutEnv(layout: "legacy" | "data-dir" | undefined): void {
  if (layout === undefined) {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  } else {
    process.env.PI_HARNESS_STORAGE_LAYOUT = layout;
  }
  resetStoragePathsForTest();
}

function makeDaemonConfig(repoDir: string, stateDir: string) {
  const sockPath = join(stateDir, "d.sock");
  const baseCfg = loadConfig(repoDir);
  return withFixtureCatalog({
    ...baseCfg,
    codeMode: "off",
    goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
    stateDir,
    socketPath: sockPath,
  });
}

function captureConsoleError(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = orig;
    },
  };
}

afterEach(async () => {
  while (activeDaemons.length > 0) {
    const d = activeDaemons.pop()!;
    try {
      await d.stop();
    } catch {
      // ignore
    }
  }
  while (restoreModes.length > 0) {
    const item = restoreModes.pop()!;
    try {
      chmodSync(item.path, item.mode);
    } catch {
      // ignore
    }
  }
  if (INITIAL_LAYOUT_ENV === undefined) {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  } else {
    process.env.PI_HARNESS_STORAGE_LAYOUT = INITIAL_LAYOUT_ENV;
  }
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("daemon start storage migration pass", () => {
  it("migrates terminal goal units, preserves in-flight goal units byte-for-byte, and still reconciles stale runs in data-dir layout", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-d-repo-");
    const stateDir = makeTempDir("pi-mig-d-state-");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const legacy = createLegacyStoragePaths({ stateDir });

    // Seed DB while daemon is stopped.
    const cpDb = new ControlPlaneDb(dbPath);
    const goals = new GoalEngine(cpDb.db);

    const gDone = goals.createGoal({
      repoRoot: repoDir,
      chatSessionId: "chat-done",
      title: "Terminal goal",
      description: "Done goal to migrate",
      criteria: [{ id: "c1", description: "Done", kind: "behavioral" }],
    });
    const rDone = cpDb.createRun({
      goal: gDone.title,
      repoRoot: repoDir,
      baseBranch: "main",
      baseSha,
      chatSessionId: "chat-done",
    });
    goals.linkRunAndStart(gDone.id, rDone.id);
    const tDone = cpDb.createTask({
      runId: rDone.id,
      tier: 1,
      kind: "orchestrator",
      title: "Terminal T1",
      objective: "Finish",
      profileId: "fixture",
    });
    cpDb.updateTask(tDone.id, { status: "completed", summary: "ok" });
    cpDb.updateRunStatus(rDone.id, "completed");
    goals.setStatus(gDone.id, "achieved");

    const gLive = goals.createGoal({
      repoRoot: repoDir,
      chatSessionId: "chat-live",
      title: "In-flight goal",
      description: "Live goal that must be deferred",
      criteria: [{ id: "c1", description: "Still running", kind: "behavioral" }],
    });
    const rLive = cpDb.createRun({
      goal: gLive.title,
      repoRoot: repoDir,
      baseBranch: "main",
      baseSha,
      chatSessionId: "chat-live",
    });
    goals.linkRunAndStart(gLive.id, rLive.id);
    const tLive = cpDb.createTask({
      runId: rLive.id,
      tier: 3,
      kind: "research",
      title: "In-flight T3",
      objective: "Working",
      profileId: "fixture",
    });
    // Leave tLive pending on an active run so reconcileStaleRunsOnStartup settles both to 'failed' without relaunching.
    cpDb.updateTask(tLive.id, { status: "pending" });

    // Write legacy evidence & run dossier files and register artifacts rows.
    const doneEvDir = legacy.goalEvidenceDir({ id: gDone.id, repoRoot: repoDir, chatSessionId: "chat-done" });
    const doneRunDir = legacy.runArtifactsDir({ id: rDone.id, repoRoot: repoDir, chatSessionId: "chat-done" });
    const doneDossierPath = join(doneRunDir, tDone.id, "handoff.md");
    writeFile(join(doneEvDir, "proof.txt"), "terminal goal proof\n");
    writeFile(doneDossierPath, "# terminal handoff\n");
    const doneArt = cpDb.recordArtifact({
      runId: rDone.id,
      taskId: tDone.id,
      kind: "dossier",
      path: doneDossierPath,
      summary: "Terminal dossier",
    });

    const liveEvDir = legacy.goalEvidenceDir({ id: gLive.id, repoRoot: repoDir, chatSessionId: "chat-live" });
    const liveRunDir = legacy.runArtifactsDir({ id: rLive.id, repoRoot: repoDir, chatSessionId: "chat-live" });
    const liveDossierPath = join(liveRunDir, tLive.id, "wip.md");
    writeFile(join(liveEvDir, "partial.txt"), "in-flight evidence\n");
    writeFile(liveDossierPath, "# in-flight wip\n");
    const liveArt = cpDb.recordArtifact({
      runId: rLive.id,
      taskId: tLive.id,
      kind: "dossier",
      path: liveDossierPath,
      summary: "In-flight dossier",
    });
    cpDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    cpDb.db.close(true);

    const doneEvHashBefore = hashTree(doneEvDir);
    const doneRunHashBefore = hashTree(doneRunDir);
    const liveEvHashBefore = hashTree(liveEvDir);
    const liveRunHashBefore = hashTree(liveRunDir);

    setLayoutEnv("data-dir");
    const cfg = makeDaemonConfig(repoDir, stateDir);
    const dataStorage = storagePaths(cfg);

    const logCap = captureConsoleError();
    const daemon = new HarnessDaemon(cfg);
    activeDaemons.push(daemon);
    try {
      await daemon.start();
    } finally {
      logCap.restore();
    }

    // Terminal unit migrated to data-dir destination with rewritten artifact row and bridge symlinks.
    const doneDestEvDir = join(dataStorage.goalsDir({ repoRoot: repoDir, chatSessionId: "chat-done" }), gDone.id);
    const doneDestRunDir = join(dataStorage.artifactsDir({ repoRoot: repoDir, chatSessionId: "chat-done" }), rDone.id);
    assert.equal(lstatSync(doneDestEvDir).isDirectory(), true);
    assert.equal(lstatSync(doneDestRunDir).isDirectory(), true);
    assertHashMapEqual(hashTree(doneDestEvDir), doneEvHashBefore, "terminal evidence dir");
    assertHashMapEqual(hashTree(doneDestRunDir), doneRunHashBefore, "terminal run dir");

    assert.equal(lstatSync(doneEvDir).isSymbolicLink(), true, "legacy evidence path should be a bridge symlink");
    assert.equal(readlinkSync(doneEvDir), doneDestEvDir);
    assert.equal(lstatSync(doneRunDir).isSymbolicLink(), true, "legacy run path should be a bridge symlink");
    assert.equal(readlinkSync(doneRunDir), doneDestRunDir);

    const doneArtRow = daemon.db.db
      .prepare("SELECT path FROM artifacts WHERE id = ?")
      .get(doneArt.id) as { path: string };
    assert.equal(doneArtRow.path, join(doneDestRunDir, tDone.id, "handoff.md"));

    // In-flight unit stays untouched and byte-identical at legacy paths with unchanged artifact row.
    assert.equal(lstatSync(liveEvDir).isDirectory(), true, "in-flight evidence dir must stay a real directory");
    assert.equal(lstatSync(liveEvDir).isSymbolicLink(), false);
    assert.equal(lstatSync(liveRunDir).isDirectory(), true, "in-flight run dir must stay a real directory");
    assert.equal(lstatSync(liveRunDir).isSymbolicLink(), false);
    assertHashMapEqual(hashTree(liveEvDir), liveEvHashBefore, "in-flight evidence dir");
    assertHashMapEqual(hashTree(liveRunDir), liveRunHashBefore, "in-flight run dir");

    const liveDestEvDir = join(dataStorage.goalsDir({ repoRoot: repoDir, chatSessionId: "chat-live" }), gLive.id);
    const liveDestRunDir = join(dataStorage.artifactsDir({ repoRoot: repoDir, chatSessionId: "chat-live" }), rLive.id);
    assert.equal(existsSync(liveDestEvDir), false);
    assert.equal(existsSync(liveDestRunDir), false);

    const liveArtRow = daemon.db.db
      .prepare("SELECT path FROM artifacts WHERE id = ?")
      .get(liveArt.id) as { path: string };
    assert.equal(liveArtRow.path, liveDossierPath);

    // Stale run reconciliation still ran after the migration pass.
    const reconciledTask = daemon.db.getTask(tLive.id);
    assert.equal(reconciledTask?.status, "failed");
    const reconciledRun = daemon.db.getRun(rLive.id);
    assert.equal(reconciledRun?.status, "failed");

    // One summary line written to the daemon log.
    const summaryLines = logCap.lines.filter((l) => l.includes("storage migration:"));
    assert.equal(summaryLines.length, 1, `Expected 1 migration summary line, got: ${JSON.stringify(summaryLines)}`);
    assert.match(summaryLines[0]!, /moved=1\b/);
    assert.match(summaryLines[0]!, /deferred=1\b/);
    assert.match(summaryLines[0]!, /errors=0\b/);
    assert.match(summaryLines[0]!, /budgetHit=false\b/);
  });

  it("runs before reconcileStaleRunsOnStartup so tasks that look live at start are deferred until the next start", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-order-repo-");
    const stateDir = makeTempDir("pi-mig-order-state-");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const legacy = createLegacyStoragePaths({ stateDir });

    // Standalone run already marked failed, with a task still 'running':
    // before reconcile the task looks live (so migration defers); reconcileStaleRunsOnStartup settles it to 'failed'.
    const cpDb = new ControlPlaneDb(dbPath);
    const run = cpDb.createRun({
      goal: "Standalone stale run",
      repoRoot: repoDir,
      baseBranch: "main",
      baseSha,
      chatSessionId: "chat-order",
    });
    const task = cpDb.createTask({
      runId: run.id,
      tier: 3,
      kind: "research",
      title: "Live before reconcile",
      objective: "Verify pre-reconcile deferral",
      profileId: "fixture",
    });
    cpDb.updateTask(task.id, { status: "running" });
    cpDb.updateRunStatus(run.id, "failed");

    const legacyRunDir = legacy.runArtifactsDir({ id: run.id, repoRoot: repoDir, chatSessionId: "chat-order" });
    const legacyFile = join(legacyRunDir, task.id, "notes.md");
    writeFile(legacyFile, "pre-reconcile artifact\n");
    const art = cpDb.recordArtifact({
      runId: run.id,
      taskId: task.id,
      kind: "dossier",
      path: legacyFile,
      summary: "Pre-reconcile dossier",
    });
    cpDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    cpDb.db.close(true);

    const beforeHash = hashTree(legacyRunDir);

    setLayoutEnv("data-dir");
    const cfg1 = makeDaemonConfig(repoDir, stateDir);
    const dataStorage = storagePaths(cfg1);
    const destRunDir = join(dataStorage.artifactsDir({ repoRoot: repoDir, chatSessionId: "chat-order" }), run.id);

    // Start #1: pass runs before reconcile -> unit deferred, then reconcile settles task+run to 'failed'.
    const daemon1 = new HarnessDaemon(cfg1);
    activeDaemons.push(daemon1);
    await daemon1.start();

    assert.equal(lstatSync(legacyRunDir).isDirectory(), true, "unit must be deferred on start #1 (before reconcile)");
    assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), false);
    assert.equal(existsSync(destRunDir), false);
    assertHashMapEqual(hashTree(legacyRunDir), beforeHash, "deferred stale run on start #1");
    assert.equal(
      (daemon1.db.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string }).path,
      legacyFile,
    );
    assert.equal(daemon1.db.getTask(task.id)?.status, "failed");
    assert.equal(daemon1.db.getRun(run.id)?.status, "failed");

    await daemon1.stop();
    activeDaemons.pop();

    // Start #2: now that reconcile already settled the run to 'failed', migration moves it.
    resetStoragePathsForTest();
    const cfg2 = makeDaemonConfig(repoDir, stateDir);
    const daemon2 = new HarnessDaemon(cfg2);
    activeDaemons.push(daemon2);
    await daemon2.start();

    assert.equal(lstatSync(legacyRunDir).isSymbolicLink(), true, "settled run should migrate on start #2");
    assert.equal(readlinkSync(legacyRunDir), destRunDir);
    assertHashMapEqual(hashTree(destRunDir), beforeHash, "migrated settled run on start #2");
    assert.equal(
      (daemon2.db.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string }).path,
      join(destRunDir, task.id, "notes.md"),
    );
  });

  it("is a silent no-op in legacy layout (the default)", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-leg-repo-");
    const stateDir = makeTempDir("pi-mig-leg-state-");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const legacy = createLegacyStoragePaths({ stateDir });

    const cpDb = new ControlPlaneDb(dbPath);
    const goals = new GoalEngine(cpDb.db);
    const goal = goals.createGoal({
      repoRoot: repoDir,
      chatSessionId: "chat-leg",
      title: "Legacy terminal goal",
      description: "Should not move in legacy layout",
      criteria: [{ id: "c1", description: "Done", kind: "behavioral" }],
    });
    const run = cpDb.createRun({ goal: goal.title, repoRoot: repoDir, baseBranch: "main", baseSha });
    goals.linkRunAndStart(goal.id, run.id);
    const task = cpDb.createTask({
      runId: run.id,
      tier: 1,
      kind: "orchestrator",
      title: "Legacy T1",
      objective: "Done",
      profileId: "fixture",
    });
    cpDb.updateTask(task.id, { status: "completed", summary: "ok" });
    cpDb.updateRunStatus(run.id, "completed");
    goals.setStatus(goal.id, "achieved");

    const evDir = legacy.goalEvidenceDir({ id: goal.id, repoRoot: repoDir });
    const runDir = legacy.runArtifactsDir({ id: run.id, repoRoot: repoDir });
    const dossierPath = join(runDir, task.id, "report.md");
    writeFile(join(evDir, "ev.txt"), "legacy evidence\n");
    writeFile(dossierPath, "# legacy dossier\n");
    const art = cpDb.recordArtifact({
      runId: run.id,
      taskId: task.id,
      kind: "dossier",
      path: dossierPath,
      summary: "Legacy dossier",
    });
    cpDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    cpDb.db.close(true);

    const evBefore = hashTree(evDir);
    const runBefore = hashTree(runDir);

    setLayoutEnv("legacy");
    const cfg = makeDaemonConfig(repoDir, stateDir);
    const logCap = captureConsoleError();
    const daemon = new HarnessDaemon(cfg);
    activeDaemons.push(daemon);
    try {
      await daemon.start();
    } finally {
      logCap.restore();
    }

    assert.equal(lstatSync(evDir).isDirectory(), true);
    assert.equal(lstatSync(evDir).isSymbolicLink(), false);
    assert.equal(lstatSync(runDir).isDirectory(), true);
    assert.equal(lstatSync(runDir).isSymbolicLink(), false);
    assertHashMapEqual(hashTree(evDir), evBefore, "legacy evidence untouched");
    assertHashMapEqual(hashTree(runDir), runBefore, "legacy run untouched");
    assert.equal(existsSync(join(stateDir, "data")), false, "data dir must not be created in legacy layout");
    assert.equal(
      (daemon.db.db.prepare("SELECT path FROM artifacts WHERE id = ?").get(art.id) as { path: string }).path,
      dossierPath,
    );
    const migrationLogs = logCap.lines.filter((l) => l.includes("storage migration") || l.includes("[storage-migrate]"));
    assert.deepEqual(migrationLogs, [], "legacy no-op must not emit migration log lines");
  });

  it("does not fail daemon start when a legacy unit is unreadable", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-err-repo-");
    const stateDir = makeTempDir("pi-mig-err-state-");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const legacy = createLegacyStoragePaths({ stateDir });

    const cpDb = new ControlPlaneDb(dbPath);
    const goals = new GoalEngine(cpDb.db);
    const gBad = goals.createGoal({
      repoRoot: repoDir,
      chatSessionId: "chat-err",
      title: "Unreadable goal",
      description: "chmod 000 dir",
      criteria: [{ id: "c1", description: "Done", kind: "behavioral" }],
    });
    const rBad = cpDb.createRun({ goal: gBad.title, repoRoot: repoDir, baseBranch: "main", baseSha });
    goals.linkRunAndStart(gBad.id, rBad.id);
    cpDb.updateRunStatus(rBad.id, "completed");
    goals.setStatus(gBad.id, "achieved");
    cpDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    cpDb.db.close(true);

    const badEvDir = legacy.goalEvidenceDir({ id: gBad.id, repoRoot: repoDir });
    writeFile(join(badEvDir, "secret.txt"), "locked\n");
    const goodNote = join(legacy.projectNotesDir(repoDir), "good-note.md");
    writeFile(goodNote, "readable note\n");

    chmodSync(badEvDir, 0o000);
    restoreModes.push({ path: badEvDir, mode: 0o755 });

    setLayoutEnv("data-dir");
    const cfg = makeDaemonConfig(repoDir, stateDir);
    const dataStorage = storagePaths(cfg);
    const logCap = captureConsoleError();
    const daemon = new HarnessDaemon(cfg);
    activeDaemons.push(daemon);
    let sockPath: string;
    try {
      sockPath = await daemon.start();
    } finally {
      logCap.restore();
    }

    // Daemon started cleanly and serves RPCs despite the unreadable legacy dir.
    const client = new DaemonClient(sockPath);
    await client.connect();
    try {
      const ping = await client.request<{ pid: number }>("ping");
      assert.equal(ping.pid, process.pid);
    } finally {
      client.close();
    }

    // Readable note still migrated; unreadable goal stayed put and logged an error.
    assert.equal(lstatSync(goodNote).isSymbolicLink(), true);
    assert.equal(existsSync(join(dataStorage.projectNotesDir(repoDir), "good-note.md")), true);
    assert.equal(lstatSync(badEvDir).isSymbolicLink(), false);
    const summaryLines = logCap.lines.filter((l) => l.includes("storage migration:"));
    assert.equal(summaryLines.length, 1);
    assert.match(summaryLines[0]!, /moved=1\b/);
    assert.match(summaryLines[0]!, /errors=1\b/);
  });
});
