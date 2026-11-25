import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
import { dirname, join, posix, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, it } from "bun:test";
import { formatHelp } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { GoalEngine } from "../src/goals/engine.js";
import type { StorageMigrationPlan, StorageMigrationReport } from "../src/storage/migrate.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");
const INITIAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];
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
  writeFileSync(join(repoDir, "README.md"), "# Storage Migrate CLI Test\n", "utf8");
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

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  opts: { stateDir: string; cwd: string; layout?: "legacy" | "data-dir" },
): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_HARNESS_HOME: opts.stateDir,
    };
    delete env.XDG_RUNTIME_DIR;
    if (opts.layout === undefined) {
      delete env.PI_HARNESS_STORAGE_LAYOUT;
    } else {
      env.PI_HARNESS_STORAGE_LAYOUT = opts.layout;
    }

    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

function seedFixtureRepo(stateDir: string, repoDir: string, baseSha: string) {
  const dbPath = join(stateDir, "control-plane.sqlite");
  const legacy = createLegacyStoragePaths({ stateDir });
  const cpDb = new ControlPlaneDb(dbPath);
  const goals = new GoalEngine(cpDb.db);

  const gDone = goals.createGoal({
    repoRoot: repoDir,
    chatSessionId: "chat-cli-1",
    title: "CLI terminal goal",
    description: "Ready to migrate",
    criteria: [{ id: "c1", description: "Done", kind: "behavioral" }],
  });
  const rDone = cpDb.createRun({
    goal: gDone.title,
    repoRoot: repoDir,
    baseBranch: "main",
    baseSha,
    chatSessionId: "chat-cli-1",
  });
  goals.linkRunAndStart(gDone.id, rDone.id);
  const tDone = cpDb.createTask({
    runId: rDone.id,
    tier: 1,
    kind: "orchestrator",
    title: "Done T1",
    objective: "Done",
    profileId: "fixture",
  });
  cpDb.updateTask(tDone.id, { status: "completed", summary: "ok" });
  cpDb.updateRunStatus(rDone.id, "completed");
  goals.setStatus(gDone.id, "achieved");

  const gLive = goals.createGoal({
    repoRoot: repoDir,
    chatSessionId: "chat-cli-2",
    title: "CLI in-flight goal",
    description: "Must be deferred",
    criteria: [{ id: "c1", description: "Running", kind: "behavioral" }],
  });
  const rLive = cpDb.createRun({
    goal: gLive.title,
    repoRoot: repoDir,
    baseBranch: "main",
    baseSha,
    chatSessionId: "chat-cli-2",
  });
  goals.linkRunAndStart(gLive.id, rLive.id);
  const tLive = cpDb.createTask({
    runId: rLive.id,
    tier: 3,
    kind: "research",
    title: "Live T3",
    objective: "Running",
    profileId: "fixture",
  });
  cpDb.updateTask(tLive.id, { status: "pending" });

  const doneEvDir = legacy.goalEvidenceDir({ id: gDone.id, repoRoot: repoDir, chatSessionId: "chat-cli-1" });
  const doneRunDir = legacy.runArtifactsDir({ id: rDone.id, repoRoot: repoDir, chatSessionId: "chat-cli-1" });
  const doneDossier = join(doneRunDir, tDone.id, "summary.md");
  writeFile(join(doneEvDir, "evidence.txt"), "cli terminal evidence\n");
  writeFile(doneDossier, "# cli terminal dossier\n");
  const doneArt = cpDb.recordArtifact({
    runId: rDone.id,
    taskId: tDone.id,
    kind: "dossier",
    path: doneDossier,
    summary: "CLI terminal dossier",
  });

  const liveEvDir = legacy.goalEvidenceDir({ id: gLive.id, repoRoot: repoDir, chatSessionId: "chat-cli-2" });
  const liveRunDir = legacy.runArtifactsDir({ id: rLive.id, repoRoot: repoDir, chatSessionId: "chat-cli-2" });
  writeFile(join(liveEvDir, "wip.txt"), "cli live evidence\n");
  writeFile(join(liveRunDir, tLive.id, "wip.md"), "# cli live dossier\n");

  const notePath = join(legacy.projectNotesDir(repoDir), "design.md");
  writeFile(notePath, "# note content\n");

  cpDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  cpDb.db.close(true);
  return {
    dbPath,
    gDone,
    rDone,
    tDone,
    doneArt,
    doneEvDir,
    doneRunDir,
    gLive,
    rLive,
    liveEvDir,
    liveRunDir,
    notePath,
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

describe("pi-harness migrate-storage CLI", () => {
  it("lists migrate-storage in help text", () => {
    assert.ok(formatHelp().includes("pi-harness migrate-storage [--dry-run] [--json]"));
  });

  it("--dry-run prints every unit with its action, changes nothing on disk or in the DB, and works while a daemon is running", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-cli-dry-repo-");
    const stateDir = makeTempDir("pi-mig-cli-dry-state-");
    const fx = seedFixtureRepo(stateDir, repoDir, baseSha);

    const repoHashesBefore = hashTree(repoDir);
    const dbBytesBefore = sha256(readFileSync(fx.dbPath));
    const nonWalEntries = (dir: string) =>
      readdirSync(dir)
        .filter((name) => name !== "control-plane.sqlite-wal" && name !== "control-plane.sqlite-shm")
        .sort();
    const stateEntriesBefore = nonWalEntries(stateDir);

    // 1. Offline --dry-run (text + --json)
    const dryText = await runCli(["migrate-storage", "--dry-run"], {
      stateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.equal(dryText.code, 0, `stderr: ${dryText.stderr}`);
    assert.ok(dryText.stdout.includes(`[migrate] goal ${fx.gDone.id}`), dryText.stdout);
    assert.ok(dryText.stdout.includes(`[defer] goal ${fx.gLive.id}`), dryText.stdout);
    assert.ok(dryText.stdout.includes(`[migrate] note design.md`), dryText.stdout);

    const dryJson = await runCli(["migrate-storage", "--dry-run", "--json"], {
      stateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.equal(dryJson.code, 0, `stderr: ${dryJson.stderr}`);
    const plan = JSON.parse(dryJson.stdout) as StorageMigrationPlan;
    assert.equal(plan.layout, "data-dir");
    assert.equal(plan.noop, false);
    assert.equal(plan.totals.migrate, 2);
    assert.equal(plan.totals.deferred, 1);

    // Disk and DB bytes are strictly identical; no data dir or daemon socket was created.
    assertHashMapEqual(hashTree(repoDir), repoHashesBefore, "repo after offline --dry-run");
    assert.equal(sha256(readFileSync(fx.dbPath)), dbBytesBefore, "DB file bytes changed during --dry-run");
    assert.deepEqual(nonWalEntries(stateDir), stateEntriesBefore, "stateDir entries changed during --dry-run");

    // 2. --dry-run while a daemon is running on the same stateDir (daemon in legacy mode keeps legacy files intact).
    const socketPath = join(stateDir, "daemon.sock");
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ socketPath }), "utf8");
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
    resetStoragePathsForTest();
    const daemonCfg = withFixtureCatalog({
      ...loadConfig(repoDir),
      codeMode: "off",
      goals: { ...loadConfig(repoDir).goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath,
    });
    const daemon = new HarnessDaemon(daemonCfg);
    activeDaemons.push(daemon);
    await daemon.start();

    const repoHashesWithDaemon = hashTree(repoDir);
    const dryWhileRunning = await runCli(["migrate-storage", "--dry-run"], {
      stateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.equal(dryWhileRunning.code, 0, `stderr: ${dryWhileRunning.stderr}`);
    assert.ok(dryWhileRunning.stdout.includes(`[migrate] goal ${fx.gDone.id}`), dryWhileRunning.stdout);
    assert.ok(dryWhileRunning.stdout.includes(`[migrate] note design.md`), dryWhileRunning.stdout);
    assertHashMapEqual(hashTree(repoDir), repoHashesWithDaemon, "repo after --dry-run with running daemon");
    assert.equal(existsSync(join(stateDir, "data")), false, "--dry-run must not create data dir");

    // 3. --dry-run when DB does not exist exits 0 without creating stateDir.
    const missingStateDir = join(makeTempDir("pi-mig-cli-missing-"), "nonexistent-state");
    const dryMissing = await runCli(["migrate-storage", "--dry-run"], {
      stateDir: missingStateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.equal(dryMissing.code, 0, `stderr: ${dryMissing.stderr}`);
    assert.match(dryMissing.stdout, /Database not found/i);
    assert.equal(existsSync(missingStateDir), false, "--dry-run must not create missing stateDir");
  });

  it("refuses without --dry-run when a daemon is running, names the restart command, and moves nothing", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-cli-live-repo-");
    const stateDir = makeTempDir("pi-mig-cli-live-state-");
    seedFixtureRepo(stateDir, repoDir, baseSha);

    const socketPath = join(stateDir, "daemon.sock");
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ socketPath }), "utf8");

    // Start daemon in legacy layout so all legacy units remain unmigrated while daemon is live.
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
    resetStoragePathsForTest();
    const daemonCfg = withFixtureCatalog({
      ...loadConfig(repoDir),
      codeMode: "off",
      goals: { ...loadConfig(repoDir).goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath,
    });
    const daemon = new HarnessDaemon(daemonCfg);
    activeDaemons.push(daemon);
    await daemon.start();

    const repoHashesBefore = hashTree(repoDir);
    const res = await runCli(["migrate-storage"], {
      stateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.notEqual(res.code, 0, "expected non-zero exit when daemon is running");
    assert.ok(res.stderr.includes("pi-harness daemon restart"), `expected restart hint in stderr, got: ${res.stderr}`);
    assert.match(res.stderr, /next start/i);
    assertHashMapEqual(hashTree(repoDir), repoHashesBefore, "nothing moved while daemon is running");
    assert.equal(existsSync(join(stateDir, "data")), false);
  });

  it("migrates eligible units when no daemon is running and reports nothing to do on a second run", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-cli-run-repo-");
    const stateDir = makeTempDir("pi-mig-cli-run-state-");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const legacy = createLegacyStoragePaths({ stateDir });

    // Seed only eligible units (terminal goal + note) so second run has literally nothing to do.
    const cpDb = new ControlPlaneDb(dbPath);
    const goals = new GoalEngine(cpDb.db);
    const gDone = goals.createGoal({
      repoRoot: repoDir,
      chatSessionId: "chat-run-1",
      title: "Offline migrate goal",
      description: "Migrated by CLI",
      criteria: [{ id: "c1", description: "Done", kind: "behavioral" }],
    });
    const rDone = cpDb.createRun({
      goal: gDone.title,
      repoRoot: repoDir,
      baseBranch: "main",
      baseSha,
      chatSessionId: "chat-run-1",
    });
    goals.linkRunAndStart(gDone.id, rDone.id);
    const tDone = cpDb.createTask({
      runId: rDone.id,
      tier: 1,
      kind: "orchestrator",
      title: "Done T1",
      objective: "Done",
      profileId: "fixture",
    });
    cpDb.updateTask(tDone.id, { status: "completed", summary: "ok" });
    cpDb.updateRunStatus(rDone.id, "completed");
    goals.setStatus(gDone.id, "achieved");

    const doneEvDir = legacy.goalEvidenceDir({ id: gDone.id, repoRoot: repoDir, chatSessionId: "chat-run-1" });
    const doneRunDir = legacy.runArtifactsDir({ id: rDone.id, repoRoot: repoDir, chatSessionId: "chat-run-1" });
    const doneDossier = join(doneRunDir, tDone.id, "out.md");
    writeFile(join(doneEvDir, "check.txt"), "offline evidence\n");
    writeFile(doneDossier, "# offline dossier\n");
    const doneArt = cpDb.recordArtifact({
      runId: rDone.id,
      taskId: tDone.id,
      kind: "dossier",
      path: doneDossier,
      summary: "Offline dossier",
    });
    cpDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    cpDb.db.close(true);

    const notePath = join(legacy.projectNotesDir(repoDir), "spec.md");
    writeFile(notePath, "# offline note\n");

    const evHashBefore = hashTree(doneEvDir);
    const runHashBefore = hashTree(doneRunDir);
    const noteShaBefore = sha256(readFileSync(notePath));

    // Run #1: migrates units offline under start lock.
    const run1 = await runCli(["migrate-storage"], {
      stateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.equal(run1.code, 0, `stderr: ${run1.stderr}`);
    assert.match(run1.stdout, /moved=2\b/, run1.stdout);
    assert.equal(existsSync(join(stateDir, "daemon.start.lock")), false, "start lock must be released");

    const dataStorage = storagePaths({ stateDir }, { layout: "data-dir" });
    const destEvDir = join(dataStorage.goalsDir({ repoRoot: repoDir, chatSessionId: "chat-run-1" }), gDone.id);
    const destRunDir = join(dataStorage.artifactsDir({ repoRoot: repoDir, chatSessionId: "chat-run-1" }), rDone.id);
    const destNote = join(dataStorage.projectNotesDir(repoDir), "spec.md");

    assertHashMapEqual(hashTree(destEvDir), evHashBefore, "migrated evidence dir");
    assertHashMapEqual(hashTree(destRunDir), runHashBefore, "migrated run dir");
    assert.equal(sha256(readFileSync(destNote)), noteShaBefore);
    assert.equal(lstatSync(doneEvDir).isSymbolicLink(), true);
    assert.equal(readlinkSync(doneEvDir), destEvDir);
    assert.equal(lstatSync(doneRunDir).isSymbolicLink(), true);
    assert.equal(readlinkSync(doneRunDir), destRunDir);
    assert.equal(lstatSync(notePath).isSymbolicLink(), true);
    assert.equal(readlinkSync(notePath), destNote);

    const checkDb = new Database(dbPath, { readonly: true });
    try {
      const row = checkDb.prepare("SELECT path FROM artifacts WHERE id = ?").get(doneArt.id) as { path: string };
      assert.equal(row.path, join(destRunDir, tDone.id, "out.md"));
    } finally {
      checkDb.close();
    }

    // Run #2: idempotent, reports nothing to do.
    const run2 = await runCli(["migrate-storage"], {
      stateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.equal(run2.code, 0, `stderr: ${run2.stderr}`);
    assert.match(run2.stdout, /Nothing to migrate/i, run2.stdout);

    const run2Json = await runCli(["migrate-storage", "--json"], {
      stateDir,
      cwd: repoDir,
      layout: "data-dir",
    });
    assert.equal(run2Json.code, 0, `stderr: ${run2Json.stderr}`);
    const report2 = JSON.parse(run2Json.stdout) as StorageMigrationReport;
    assert.equal(report2.totals.migrated, 0);
    assert.equal(report2.totals.errors, 0);
    assert.equal(report2.totals.bridgesKept, 2);
  });

  it("reports legacy layout and moves nothing for both --dry-run and live forms under default legacy layout", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-mig-cli-leg-repo-");
    const stateDir = makeTempDir("pi-mig-cli-leg-state-");
    seedFixtureRepo(stateDir, repoDir, baseSha);

    const repoHashesBefore = hashTree(repoDir);

    const dryRes = await runCli(["migrate-storage", "--dry-run"], {
      stateDir,
      cwd: repoDir,
      layout: undefined, // default legacy
    });
    assert.equal(dryRes.code, 0, `stderr: ${dryRes.stderr}`);
    assert.match(dryRes.stdout, /legacy/i, dryRes.stdout);

    const liveRes = await runCli(["migrate-storage"], {
      stateDir,
      cwd: repoDir,
      layout: undefined, // default legacy
    });
    assert.equal(liveRes.code, 0, `stderr: ${liveRes.stderr}`);
    assert.match(liveRes.stdout, /legacy/i, liveRes.stdout);
    assert.match(liveRes.stdout, /nothing will move/i, liveRes.stdout);

    assertHashMapEqual(hashTree(repoDir), repoHashesBefore, "legacy CLI runs must not move anything");
    assert.equal(existsSync(join(stateDir, "data")), false);
  });
});
