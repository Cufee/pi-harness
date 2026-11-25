import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import {
  computeStartPassBudget,
  MIN_START_PASS_BUDGET_MS,
  START_PASS_BOOT_RESERVE_MS,
} from "../src/daemon/start-pass-budget.js";
import { DEFAULT_BOOT_TIMEOUT_MS, SUPERVISE_BOOT_TIMEOUT_ENV } from "../src/daemon/supervise.js";
import { DEFAULT_MIGRATION_BUDGET_MS } from "../src/storage/migrate.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const INITIAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;
const INITIAL_BOOT_TIMEOUT_ENV = process.env[SUPERVISE_BOOT_TIMEOUT_ENV];
const INITIAL_RELOAD_FAILED_ENV = process.env.PI_HARNESS_RELOAD_FAILED;

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
  writeFileSync(join(repoDir, "README.md"), "# Start Pass Budget Test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
  return { repoDir, baseSha };
}

function writeFile(absPath: string, content: string): void {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, content, "utf8");
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

function restoreEnvVar(name: string, initial: string | undefined): void {
  if (initial === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = initial;
  }
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
  restoreEnvVar("PI_HARNESS_STORAGE_LAYOUT", INITIAL_LAYOUT_ENV);
  restoreEnvVar(SUPERVISE_BOOT_TIMEOUT_ENV, INITIAL_BOOT_TIMEOUT_ENV);
  restoreEnvVar("PI_HARNESS_RELOAD_FAILED", INITIAL_RELOAD_FAILED_ENV);
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("computeStartPassBudget (D11)", () => {
  it("(a) returns the full configured budget on a fresh boot", () => {
    const res = computeStartPassBudget({ uptimeMs: 0, env: {} });
    assert.equal(res.skip, false);
    assert.equal(res.budgetMs, DEFAULT_MIGRATION_BUDGET_MS);
    assert.equal(res.bootTimeoutMs, DEFAULT_BOOT_TIMEOUT_MS);
    assert.equal(res.remainingWindowMs, DEFAULT_BOOT_TIMEOUT_MS - START_PASS_BOOT_RESERVE_MS);

    const warm = computeStartPassBudget({ uptimeMs: 250, env: {} });
    assert.equal(warm.skip, false);
    assert.equal(warm.budgetMs, DEFAULT_MIGRATION_BUDGET_MS);
  });

  it("(b) caps the budget to 2000ms at 8s uptime in a 20s boot window and respects the 500ms floor", () => {
    const res = computeStartPassBudget({ uptimeMs: 8_000, env: {} });
    assert.equal(res.skip, false);
    assert.equal(res.budgetMs, 2_000);
    assert.equal(res.bootTimeoutMs, 20_000);

    const exactMin = computeStartPassBudget({ uptimeMs: 9_500, env: {} });
    assert.equal(exactMin.skip, false);
    assert.equal(exactMin.budgetMs, MIN_START_PASS_BUDGET_MS);

    const belowMin = computeStartPassBudget({ uptimeMs: 9_501, env: {} });
    assert.equal(belowMin.skip, true);
    assert.equal(belowMin.budgetMs, null);
  });

  it("(c) skips the pass at 12s uptime in a 20s boot window", () => {
    const res = computeStartPassBudget({ uptimeMs: 12_000, env: {} });
    assert.equal(res.skip, true);
    assert.equal(res.budgetMs, null);
    assert.equal(res.bootTimeoutMs, 20_000);
    assert.equal(res.uptimeMs, 12_000);
    assert.equal(res.remainingWindowMs, -2_000);
  });

  it("(d) honors a 60s PI_HARNESS_SUPERVISE_BOOT_TIMEOUT_MS override, ignores invalid values, and caps fallback boots to 20s", () => {
    const env60s = { [SUPERVISE_BOOT_TIMEOUT_ENV]: "60000" };

    const at12s = computeStartPassBudget({ uptimeMs: 12_000, env: env60s });
    assert.equal(at12s.skip, false);
    assert.equal(at12s.bootTimeoutMs, 60_000);
    assert.equal(at12s.budgetMs, DEFAULT_MIGRATION_BUDGET_MS);

    const at48s = computeStartPassBudget({ uptimeMs: 48_000, env: env60s });
    assert.equal(at48s.skip, false);
    assert.equal(at48s.bootTimeoutMs, 60_000);
    assert.equal(at48s.budgetMs, 2_000);

    const at52s = computeStartPassBudget({ uptimeMs: 52_000, env: env60s });
    assert.equal(at52s.skip, true);
    assert.equal(at52s.budgetMs, null);

    // Invalid env values fall back to DEFAULT_BOOT_TIMEOUT_MS (20s).
    for (const bad of ["0", "-5000", "not-a-number", ""]) {
      const invalid = computeStartPassBudget({
        uptimeMs: 12_000,
        env: { [SUPERVISE_BOOT_TIMEOUT_ENV]: bad },
      });
      assert.equal(invalid.bootTimeoutMs, DEFAULT_BOOT_TIMEOUT_MS);
      assert.equal(invalid.skip, true);
    }

    // Supervisor fallback boots always get DEFAULT_BOOT_TIMEOUT_MS even when env override is set.
    const fallback = computeStartPassBudget({
      uptimeMs: 12_000,
      env: { ...env60s, PI_HARNESS_RELOAD_FAILED: JSON.stringify({ targetReleaseId: "r2", error: "timeout" }) },
    });
    assert.equal(fallback.bootTimeoutMs, DEFAULT_BOOT_TIMEOUT_MS);
    assert.equal(fallback.skip, true);
  });
});

describe("HarnessDaemon.start start-pass budget enforcement (D11)", () => {
  it("skips the migration pass and logs uptime and window when injected uptime leaves no window, then migrates on next start", async () => {
    const { repoDir, baseSha } = initTempGitRepo("pi-start-budget-repo-");
    const stateDir = makeTempDir("pi-start-budget-state-");
    const dbPath = join(stateDir, "control-plane.sqlite");
    const legacy = createLegacyStoragePaths({ stateDir });

    // Seed a repo row in the DB and a migratable legacy note on disk.
    const cpDb = new ControlPlaneDb(dbPath);
    const run = cpDb.createRun({
      goal: "Seed repo for start-pass budget test",
      repoRoot: repoDir,
      baseBranch: "main",
      baseSha,
      chatSessionId: "chat-budget",
    });
    cpDb.updateRunStatus(run.id, "completed");
    cpDb.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    cpDb.db.close(true);

    const legacyNotePath = join(legacy.projectNotesDir(repoDir), "budget-check.md");
    writeFile(legacyNotePath, "should not move when boot window is exhausted\n");

    delete process.env[SUPERVISE_BOOT_TIMEOUT_ENV];
    delete process.env.PI_HARNESS_RELOAD_FAILED;
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    const baseCfg = loadConfig(repoDir);
    const cfg = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: join(stateDir, "d.sock"),
    });
    const dataStorage = storagePaths(cfg);
    const destNotePath = join(dataStorage.projectNotesDir(repoDir), "budget-check.md");

    // Start #1: injected uptime 12s leaves no window (20s - 12s - 10s = -2s < 500ms).
    const logCap = captureConsoleError();
    const daemon1 = new HarnessDaemon(cfg, {
      bootUptimeMs: () => 12_000,
    });
    activeDaemons.push(daemon1);
    let sockPath: string;
    try {
      sockPath = await daemon1.start();
    } finally {
      logCap.restore();
    }

    // Daemon started and serves ping.
    const client = new DaemonClient(sockPath);
    await client.connect();
    try {
      const ping = await client.request<{ pid: number }>("ping");
      assert.equal(ping.pid, process.pid);
    } finally {
      client.close();
    }

    // Migration pass was NOT called: legacy file stayed a real file, destination was not created, data dir not created.
    assert.equal(lstatSync(legacyNotePath).isFile(), true, "legacy note must remain a real file when pass is skipped");
    assert.equal(lstatSync(legacyNotePath).isSymbolicLink(), false, "legacy note must not be bridged when pass is skipped");
    assert.equal(existsSync(destNotePath), false, "destination note must not exist when pass is skipped");
    assert.equal(existsSync(join(stateDir, "data")), false, "data dir must not be created when pass is skipped");

    // One skip line naming uptime and window; no pass summary or [storage-migrate] log lines.
    const skipLines = logCap.lines.filter((l) => l.includes("storage migration skipped"));
    assert.equal(skipLines.length, 1, `Expected 1 skip log line, got: ${JSON.stringify(logCap.lines)}`);
    assert.match(skipLines[0]!, /12000/);
    assert.match(skipLines[0]!, /20000/);
    assert.deepEqual(
      logCap.lines.filter((l) => l.includes("storage migration:") || l.includes("[storage-migrate]")),
      [],
      "skipped pass must not run or log a migration summary",
    );

    await daemon1.stop();
    activeDaemons.pop();

    // Start #2: fresh boot uptime -> migration pass runs and moves the note.
    resetStoragePathsForTest();
    const daemon2 = new HarnessDaemon(cfg, {
      bootUptimeMs: () => 100,
    });
    activeDaemons.push(daemon2);
    await daemon2.start();

    assert.equal(lstatSync(legacyNotePath).isSymbolicLink(), true, "next start with fresh uptime should migrate the note");
    assert.equal(readlinkSync(legacyNotePath), destNotePath);
    assert.equal(readFileSync(destNotePath, "utf8"), "should not move when boot window is exhausted\n");
  });
});
