import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { OCTOFS_VERSION } from "../src/tools/native-tools.js";

const REPO_ROOT = process.cwd();
const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function readPinFromInstallSh(name: string): string {
  const text = readFileSync(join(REPO_ROOT, "install.sh"), "utf8");
  const m = text.match(new RegExp(`^${name}=([^\\s#]+)`, "m"));
  assert.ok(m?.[1], `could not find ${name} in install.sh`);
  return m[1];
}

function seedOfflineInstallDir(installDir: string): void {
  const bunVersion = readPinFromInstallSh("BUN_VERSION");
  const octofsVersion = readPinFromInstallSh("OCTOFS_VERSION");
  const bunTargets = [
    "darwin-aarch64",
    "darwin-x64",
    "darwin-x64-baseline",
    "linux-aarch64",
    "linux-aarch64-musl",
    "linux-x64",
    "linux-x64-baseline",
    "linux-x64-musl",
    "linux-x64-musl-baseline",
  ];
  const bunWrapper = `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf '%s\\n' '${bunVersion}'
  exit 0
fi
if [ "\${1:-}" = "install" ]; then
  exit 0
fi
if [ -n "\${PI_HARNESS_TEST_ABORT_BEFORE_PAIR_WRITE:-}" ]; then
  for arg in "$@"; do
    if [ "$arg" = "--record-rollback-pair" ]; then
      exit 99
    fi
  done
fi
if [ -n "\${PI_HARNESS_TEST_ABORT_BEFORE_CURRENT_SWAP:-}" ]; then
  if [ "\${1:-}" = "-e" ] && printf '%s' "\${2:-}" | grep -q 'renameSync'; then
    exit 98
  fi
fi
if [ -n "\${PI_HARNESS_TEST_ABORT_BEFORE_FINALIZE:-}" ]; then
  has_record=0
  has_current=0
  for arg in "$@"; do
    [ "$arg" = "--record-rollback-pair" ] && has_record=1
    [ "$arg" = "--current" ] && has_current=1
  done
  if [ "$has_record" = 1 ] && [ "$has_current" = 1 ]; then
    exit 97
  fi
fi
exec '${process.execPath}' "$@"
`;
  for (const target of bunTargets) {
    const binDir = join(installDir, "bun", `${bunVersion}-${target}`, "bin");
    mkdirSync(binDir, { recursive: true });
    const bunPath = join(binDir, "bun");
    writeFileSync(bunPath, bunWrapper, "utf8");
    chmodSync(bunPath, 0o755);
  }

  const octofsTriples = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-unknown-linux-musl",
    "x86_64-unknown-linux-musl",
  ];
  for (const triple of octofsTriples) {
    const binDir = join(installDir, "tools", "octofs", `${octofsVersion}-${triple}`, "bin");
    mkdirSync(binDir, { recursive: true });
    const octofsPath = join(binDir, "octofs");
    writeFileSync(octofsPath, "#!/bin/sh\nexit 0\n", "utf8");
    chmodSync(octofsPath, 0o755);
  }
}

function makeMiniCheckout(dir: string, tag: string): void {
  mkdirSync(join(dir, "src", "install"), { recursive: true });
  mkdirSync(join(dir, "src", "tools"), { recursive: true });
  mkdirSync(join(dir, "proto"), { recursive: true });
  copyFileSync(join(REPO_ROOT, "install.sh"), join(dir, "install.sh"));
  copyFileSync(join(REPO_ROOT, "src", "config.ts"), join(dir, "src", "config.ts"));
  copyFileSync(join(REPO_ROOT, "src", "install", "maintenance.ts"), join(dir, "src", "install", "maintenance.ts"));
  writeFileSync(join(dir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
  writeFileSync(join(dir, "src", "cli.ts"), `// tag=${tag}\nprocess.exit(0);\n`, "utf8");
  writeFileSync(join(dir, "proto", "stub.proto"), `// ${tag}\n`, "utf8");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "pi-harness", type: "module" }) + "\n", "utf8");
  writeFileSync(join(dir, "bun.lock"), "{}\n", "utf8");
  writeFileSync(join(dir, "tsconfig.json"), "{}\n", "utf8");
}

function runInstallSh(checkoutDir: string, env: Record<string, string>): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("sh", [join(checkoutDir, "install.sh")], {
    cwd: checkoutDir,
    env: {
      ...process.env,
      PI_HARNESS_NO_RELOAD: "1",
      ...env,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

function backdateRelease(installDir: string, id: string, ageMs: number): void {
  const relDir = join(installDir, "releases", id);
  const t = new Date(Date.now() - ageMs);
  utimesSync(relDir, t, t);
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("durable rollback pair for release pruning (I1)", () => {
  it("upgrades cleanly without a prior record, preserves previous across same-id reinstall with retention=1, and honors the live record for delayed maintenance", () => {
    const root = makeTempRoot("pi-rollback-pair-");
    const stateDir = join(root, "state");
    const installDir = join(root, "install");
    const binDir = join(root, "bin");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    seedOfflineInstallDir(installDir);

    // Retention = 1: only pinned releases survive pruning once older than 10 minutes.
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ retention: { installReleases: 1 } }), "utf8");

    const env = {
      PI_HARNESS_HOME: stateDir,
      PI_HARNESS_INSTALL_DIR: installDir,
      PI_HARNESS_BIN_DIR: binDir,
    };

    // Simulate an install made by a previous release: R0 and R1 exist, current -> releases/R1,
    // and NO rollback-pair.json exists yet.
    const oldMs = 2 * 60 * 60 * 1000;
    const r0Id = "000000000000";
    const r1Id = "111111111111";
    for (const [id, age] of [
      [r0Id, 3 * 60 * 60 * 1000],
      [r1Id, oldMs],
    ] as const) {
      const relDir = join(installDir, "releases", id);
      mkdirSync(join(relDir, "src", "tools"), { recursive: true });
      writeFileSync(join(relDir, ".installed"), "");
      writeFileSync(join(relDir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
      backdateRelease(installDir, id, age);
    }
    symlinkSync(`releases/${r1Id}`, join(installDir, "current"));
    assert.equal(existsSync(join(installDir, "rollback-pair.json")), false);

    // 1. First install with new install.sh upgrades cleanly from the record-less install (R1 -> R2).
    const checkoutV2 = join(root, "checkout-v2");
    makeMiniCheckout(checkoutV2, "v2");
    const first = runInstallSh(checkoutV2, env);
    assert.equal(first.status, 0, `first install failed:\n${first.stdout}\n${first.stderr}`);
    const r2Id = basename(readlinkSync(join(installDir, "current")));
    assert.notEqual(r2Id, r1Id);

    const recordPath = join(installDir, "rollback-pair.json");
    assert.equal(existsSync(recordPath), true, "expected rollback-pair.json to be created at activation");
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), { current: r2Id, previous: r1Id });
    assert.equal(existsSync(join(installDir, "releases", r2Id)), true);
    assert.equal(existsSync(join(installDir, "releases", r1Id)), true, "previous release R1 must be kept");
    assert.equal(existsSync(join(installDir, "releases", r0Id)), false, "unpinned older release R0 should be pruned");

    // 2. Backdate R1 and R2 past the 10-minute recent window, then reinstall the SAME release R2.
    // With retention=1, the last distinct previous release R1 must NOT be deleted.
    backdateRelease(installDir, r1Id, oldMs);
    backdateRelease(installDir, r2Id, oldMs);
    const reinstall = runInstallSh(checkoutV2, env);
    assert.equal(reinstall.status, 0, `same-id reinstall failed:\n${reinstall.stdout}\n${reinstall.stderr}`);
    assert.equal(basename(readlinkSync(join(installDir, "current"))), r2Id);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), { current: r2Id, previous: r1Id });
    assert.equal(
      existsSync(join(installDir, "releases", r1Id)),
      true,
      "same-id reinstall with retention=1 must keep the last distinct previous release R1",
    );

    // 3. Upgrade to R3, backdate R1/R2/R3, and simulate delayed maintenance from an older install (R1).
    // Maintenance must read the live rollback-pair.json ({ current: R3, previous: R2 }) at prune time
    // and keep both R3 and R2 even when invoked with stale --current R1 --previous R0.
    const checkoutV3 = join(root, "checkout-v3");
    makeMiniCheckout(checkoutV3, "v3");
    const upgrade3 = runInstallSh(checkoutV3, env);
    assert.equal(upgrade3.status, 0, `upgrade to v3 failed:\n${upgrade3.stdout}\n${upgrade3.stderr}`);
    const r3Id = basename(readlinkSync(join(installDir, "current")));
    assert.notEqual(r3Id, r2Id);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), { current: r3Id, previous: r2Id });

    backdateRelease(installDir, r2Id, oldMs);
    backdateRelease(installDir, r3Id, oldMs);
    // Recreate R1 as an old unpinned release to confirm stale --current R1 does not override the live pair.
    const r1Dir = join(installDir, "releases", r1Id);
    mkdirSync(join(r1Dir, "src", "tools"), { recursive: true });
    writeFileSync(join(r1Dir, ".installed"), "");
    writeFileSync(join(r1Dir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, r1Id, 3 * 60 * 60 * 1000);

    const delayedMaint = spawnSync(
      process.execPath,
      [
        join(installDir, "releases", r3Id, "src", "install", "maintenance.ts"),
        "--install-dir",
        installDir,
        "--state-dir",
        stateDir,
        "--current",
        r1Id,
        "--previous",
        r0Id,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(delayedMaint.status, 0, delayedMaint.stderr);
    assert.equal(existsSync(join(installDir, "releases", r3Id)), true, "live current R3 must be kept");
    assert.equal(existsSync(join(installDir, "releases", r2Id)), true, "live previous R2 must be kept");
    assert.equal(existsSync(join(installDir, "releases", r1Id)), false, "stale R1 should be pruned once superseded");
  });

  it("keeps corrupt rollback-pair.json unchanged, keeps every release, and audits the skip on same-id reinstall with retention=1 (A10)", () => {
    const root = makeTempRoot("pi-rollback-corrupt-");
    const stateDir = join(root, "state");
    const installDir = join(root, "install");
    const binDir = join(root, "bin");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    seedOfflineInstallDir(installDir);

    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ retention: { installReleases: 1 } }), "utf8");

    const env = {
      PI_HARNESS_HOME: stateDir,
      PI_HARNESS_INSTALL_DIR: installDir,
      PI_HARNESS_BIN_DIR: binDir,
    };

    const oldMs = 2 * 60 * 60 * 1000;
    const r0Id = "000000000000";
    const r1Id = "111111111111";
    for (const [id, age] of [
      [r0Id, 3 * 60 * 60 * 1000],
      [r1Id, oldMs],
    ] as const) {
      const relDir = join(installDir, "releases", id);
      mkdirSync(join(relDir, "src", "tools"), { recursive: true });
      writeFileSync(join(relDir, ".installed"), "");
      writeFileSync(join(relDir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
      backdateRelease(installDir, id, age);
    }
    symlinkSync(`releases/${r1Id}`, join(installDir, "current"));

    const checkoutV2 = join(root, "checkout-v2");
    makeMiniCheckout(checkoutV2, "v2");
    const first = runInstallSh(checkoutV2, env);
    assert.equal(first.status, 0, `first install failed:\n${first.stdout}\n${first.stderr}`);
    const r2Id = basename(readlinkSync(join(installDir, "current")));

    // Recreate an extra old release R0 so we prove every release survives when pruning is skipped.
    const r0Dir = join(installDir, "releases", r0Id);
    mkdirSync(join(r0Dir, "src", "tools"), { recursive: true });
    writeFileSync(join(r0Dir, ".installed"), "");
    writeFileSync(join(r0Dir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, r0Id, 3 * 60 * 60 * 1000);
    backdateRelease(installDir, r1Id, oldMs);
    backdateRelease(installDir, r2Id, oldMs);

    const recordPath = join(installDir, "rollback-pair.json");
    const corruptRaw = "{corrupt-rollback-pair\n";
    writeFileSync(recordPath, corruptRaw, "utf8");

    const auditLogPath = join(stateDir, "install-audit.log");
    rmSync(auditLogPath, { force: true });

    const reinstall = runInstallSh(checkoutV2, env);
    assert.equal(reinstall.status, 0, `reinstall with corrupt pair failed:\n${reinstall.stdout}\n${reinstall.stderr}`);
    assert.equal(
      readFileSync(recordPath, "utf8"),
      corruptRaw,
      "corrupt rollback-pair.json must be kept untouched and never replaced with previous: null",
    );
    assert.equal(existsSync(join(installDir, "releases", r0Id)), true, "R0 must be kept when pruning is skipped");
    assert.equal(existsSync(join(installDir, "releases", r1Id)), true, "previous release R1 must be kept");
    assert.equal(existsSync(join(installDir, "releases", r2Id)), true, "current release R2 must be kept");

    const auditText = readFileSync(auditLogPath, "utf8");
    assert.ok(
      auditText.includes("maintenance=prune_skipped") && auditText.includes("skipped=rollback_pair_unreadable"),
      `expected install-audit.log to record rollback_pair_unreadable skip, got:\n${auditText}`,
    );
  });

  it("keeps the previous release when activation is interrupted before the pair write and then reinstalled with retention=1 (A10)", () => {
    const root = makeTempRoot("pi-rollback-interrupted-");
    const stateDir = join(root, "state");
    const installDir = join(root, "install");
    const binDir = join(root, "bin");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    seedOfflineInstallDir(installDir);

    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ retention: { installReleases: 1 } }), "utf8");

    const env = {
      PI_HARNESS_HOME: stateDir,
      PI_HARNESS_INSTALL_DIR: installDir,
      PI_HARNESS_BIN_DIR: binDir,
    };

    const oldMs = 2 * 60 * 60 * 1000;
    const r1Id = "111111111111";
    const r1Dir = join(installDir, "releases", r1Id);
    mkdirSync(join(r1Dir, "src", "tools"), { recursive: true });
    writeFileSync(join(r1Dir, ".installed"), "");
    writeFileSync(join(r1Dir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, r1Id, oldMs);
    symlinkSync(`releases/${r1Id}`, join(installDir, "current"));

    const checkoutV2 = join(root, "checkout-v2");
    makeMiniCheckout(checkoutV2, "v2");

    // 1. Interrupt activation right before --record-rollback-pair runs.
    // Because the pair write runs before the current swap, current stays on R1 (old state).
    const interrupted = runInstallSh(checkoutV2, {
      ...env,
      PI_HARNESS_TEST_ABORT_BEFORE_PAIR_WRITE: "1",
    });
    assert.notEqual(interrupted.status, 0, "expected interrupted activation to exit non-zero");

    const recordPath = join(installDir, "rollback-pair.json");
    assert.equal(existsSync(recordPath), false, "rollback-pair.json must not exist after abort before pair write");
    assert.equal(
      basename(readlinkSync(join(installDir, "current"))),
      r1Id,
      "interruption before the pair write must leave current pointing at the old release R1",
    );

    // Backdate all unpacked release dirs past the 10-minute recent window, then reinstall R2 with retention=1.
    for (const relId of readdirSync(join(installDir, "releases"))) {
      backdateRelease(installDir, relId, oldMs);
    }

    const reinstallAfterAbort = runInstallSh(checkoutV2, env);
    assert.equal(
      reinstallAfterAbort.status,
      0,
      `reinstall after interrupted activation failed:\n${reinstallAfterAbort.stdout}\n${reinstallAfterAbort.stderr}`,
    );
    const r2Id = basename(readlinkSync(join(installDir, "current")));
    assert.notEqual(r2Id, r1Id);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), { current: r2Id, previous: r1Id });
    assert.equal(existsSync(join(installDir, "releases", r1Id)), true, "previous release R1 must be kept");

    // 2. Also simulate an already-swapped activation that died without a rollback-pair.json
    // (current -> R2, releases/R1 and releases/R2 both exist and are old, record missing).
    // A same-id reinstall with retention=1 must derive nothing, skip pruning, audit the skip, and keep R1.
    rmSync(recordPath, { force: true });
    backdateRelease(installDir, r1Id, oldMs);
    backdateRelease(installDir, r2Id, oldMs);
    const auditLogPath = join(stateDir, "install-audit.log");
    rmSync(auditLogPath, { force: true });

    const sameIdMissing = runInstallSh(checkoutV2, env);
    assert.equal(
      sameIdMissing.status,
      0,
      `same-id reinstall with missing pair failed:\n${sameIdMissing.stdout}\n${sameIdMissing.stderr}`,
    );
    assert.equal(existsSync(recordPath), false, "missing pair on same-id reinstall must not write a previous: null record");
    assert.equal(existsSync(join(installDir, "releases", r1Id)), true, "previous release R1 must be kept when pair is missing");
    assert.equal(existsSync(join(installDir, "releases", r2Id)), true, "current release R2 must be kept");

    const auditText = readFileSync(auditLogPath, "utf8");
    assert.ok(
      auditText.includes("maintenance=prune_skipped") && auditText.includes("skipped=rollback_pair_missing"),
      `expected install-audit.log to record rollback_pair_missing skip, got:\n${auditText}`,
    );
  });

  it("keeps the real previous release when activation is interrupted after the pair write and before the current swap (F5)", () => {
    const root = makeTempRoot("pi-rollback-post-pair-abort-");
    const stateDir = join(root, "state");
    const installDir = join(root, "install");
    const binDir = join(root, "bin");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    seedOfflineInstallDir(installDir);

    const env = {
      PI_HARNESS_HOME: stateDir,
      PI_HARNESS_INSTALL_DIR: installDir,
      PI_HARNESS_BIN_DIR: binDir,
    };

    const HOUR = 60 * 60 * 1000;
    const relA = "aaaaaaaaaaaa";
    const relX = "xxxxxxxxxxxx";
    const relADir = join(installDir, "releases", relA);
    mkdirSync(join(relADir, "src", "tools"), { recursive: true });
    writeFileSync(join(relADir, ".installed"), "");
    writeFileSync(join(relADir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, relA, 5 * HOUR);
    symlinkSync(`releases/${relA}`, join(installDir, "current"));

    // Activate B from A so current -> B and rollback-pair.json is { current: B, previous: A }.
    const checkoutB = join(root, "checkout-b");
    makeMiniCheckout(checkoutB, "release-b");
    const installB = runInstallSh(checkoutB, env);
    assert.equal(installB.status, 0, `install B failed:\n${installB.stdout}\n${installB.stderr}`);
    const relB = basename(readlinkSync(join(installDir, "current")));
    const recordPath = join(installDir, "rollback-pair.json");
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), { current: relB, previous: relA });

    // Create another unpinned release X that is newer than A, and backdate A, X, B past the 10-minute recent window.
    const relXDir = join(installDir, "releases", relX);
    mkdirSync(join(relXDir, "src", "tools"), { recursive: true });
    writeFileSync(join(relXDir, ".installed"), "");
    writeFileSync(join(relXDir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, relA, 5 * HOUR);
    backdateRelease(installDir, relX, 4 * HOUR);
    backdateRelease(installDir, relB, 3 * HOUR);

    const auditLogPath = join(stateDir, "install-audit.log");
    rmSync(auditLogPath, { force: true });

    // Attempt to activate C, aborting after the pre-swap record write and before swapping current from B.
    const checkoutC = join(root, "checkout-c");
    makeMiniCheckout(checkoutC, "release-c");
    const interruptedC = runInstallSh(checkoutC, {
      ...env,
      PI_HARNESS_TEST_ABORT_BEFORE_CURRENT_SWAP: "1",
    });
    assert.notEqual(interruptedC.status, 0, "expected activation of C interrupted before current swap to fail");
    assert.equal(
      basename(readlinkSync(join(installDir, "current"))),
      relB,
      "current symlink must still point to B when aborted before swap",
    );

    const relC = readdirSync(join(installDir, "releases")).find((id) => id !== relA && id !== relB && id !== relX);
    assert.ok(relC, "expected C to be unpacked under releases/");
    backdateRelease(installDir, relC, 2 * HOUR);

    // Run maintenance with default keepCount=3 while the lock is free.
    const maint = spawnSync(
      process.execPath,
      [
        join(installDir, "releases", relB, "src", "install", "maintenance.ts"),
        "--install-dir",
        installDir,
        "--state-dir",
        stateDir,
        "--current",
        relB,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(maint.status, 0, maint.stderr);

    assert.equal(existsSync(join(installDir, "releases", relA)), true, "real previous release A must be kept");
    assert.equal(existsSync(join(installDir, "releases", relB)), true, "current release B must be kept");
    assert.equal(existsSync(join(installDir, "releases", relC)), true, "pending release C must be kept");
    assert.equal(existsSync(join(installDir, "releases", relX)), false, "unpinned release X should be pruned beyond keep=3");

    // Maintenance must not rewrite the interrupted activation record, and must audit one line.
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), {
      pending: relC,
      current: relB,
      previous: relA,
    });
    const auditLines = readFileSync(auditLogPath, "utf8").trim().split(/\r?\n/);
    assert.equal(auditLines.length, 1, `expected 1 audit line for interrupted activation, got:\n${auditLines.join("\n")}`);
    assert.ok(
      auditLines[0]!.includes("maintenance=interrupted_activation"),
      `expected interrupted_activation audit line, got: ${auditLines[0]}`,
    );

    // A later activation starts from the resolved current symlink (B) and the record's matching previous (A).
    const checkoutD = join(root, "checkout-d");
    makeMiniCheckout(checkoutD, "release-d");
    const interruptedD = runInstallSh(checkoutD, {
      ...env,
      PI_HARNESS_TEST_ABORT_BEFORE_CURRENT_SWAP: "1",
    });
    assert.notEqual(interruptedD.status, 0);
    const relD = readdirSync(join(installDir, "releases")).find((id) => id !== relA && id !== relB && id !== relC);
    assert.ok(relD, "expected D to be unpacked under releases/");
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), {
      pending: relD,
      current: relB,
      previous: relA,
    });

    // Interrupting D after the current swap and before finalize still pins D, B (real previous of D), and A.
    const interruptedDFinalize = runInstallSh(checkoutD, {
      ...env,
      PI_HARNESS_TEST_ABORT_BEFORE_FINALIZE: "1",
    });
    assert.notEqual(interruptedDFinalize.status, 0);
    assert.equal(basename(readlinkSync(join(installDir, "current"))), relD);
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), {
      pending: relD,
      current: relB,
      previous: relA,
    });
    const relY = "yyyyyyyyyyyy";
    const relYDir = join(installDir, "releases", relY);
    mkdirSync(join(relYDir, "src", "tools"), { recursive: true });
    writeFileSync(join(relYDir, ".installed"), "");
    writeFileSync(join(relYDir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, relA, 5 * HOUR);
    backdateRelease(installDir, relB, 4 * HOUR);
    backdateRelease(installDir, relC, 4 * HOUR);
    backdateRelease(installDir, relY, 3 * HOUR);
    backdateRelease(installDir, relD, 2 * HOUR);

    const maintAfterSwap = spawnSync(
      process.execPath,
      [
        join(installDir, "releases", relD, "src", "install", "maintenance.ts"),
        "--install-dir",
        installDir,
        "--state-dir",
        stateDir,
        "--current",
        relD,
      ],
      { encoding: "utf8", timeout: 15_000 },
    );
    assert.equal(maintAfterSwap.status, 0, maintAfterSwap.stderr);
    assert.equal(existsSync(join(installDir, "releases", relD)), true, "new current D must be kept");
    assert.equal(existsSync(join(installDir, "releases", relB)), true, "real previous B of D must be kept");
    assert.equal(existsSync(join(installDir, "releases", relA)), true, "recorded previous A must be kept");
    assert.equal(existsSync(join(installDir, "releases", relY)), false, "unpinned Y should be pruned beyond keep=3");
    assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), {
      pending: relD,
      current: relB,
      previous: relA,
    });

    // Completing D recovers B as D's previous and finalizes to the two-field record { current: D, previous: B }.
    const completedD = runInstallSh(checkoutD, env);
    assert.equal(completedD.status, 0, `completing D failed:\n${completedD.stdout}\n${completedD.stderr}`);
    assert.equal(basename(readlinkSync(join(installDir, "current"))), relD);
    const finalized = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(finalized, { current: relD, previous: relB });
    assert.equal("pending" in finalized, false);
  });

  it("finalizes to a two-field record on completed activation and prunes unpinned older releases as before (F5)", () => {
    const root = makeTempRoot("pi-rollback-completed-");
    const stateDir = join(root, "state");
    const installDir = join(root, "install");
    const binDir = join(root, "bin");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    seedOfflineInstallDir(installDir);

    const env = {
      PI_HARNESS_HOME: stateDir,
      PI_HARNESS_INSTALL_DIR: installDir,
      PI_HARNESS_BIN_DIR: binDir,
    };

    const HOUR = 60 * 60 * 1000;
    const relA = "aaaaaaaaaaaa";
    const relX = "xxxxxxxxxxxx";
    const relADir = join(installDir, "releases", relA);
    mkdirSync(join(relADir, "src", "tools"), { recursive: true });
    writeFileSync(join(relADir, ".installed"), "");
    writeFileSync(join(relADir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, relA, 5 * HOUR);
    symlinkSync(`releases/${relA}`, join(installDir, "current"));

    const checkoutB = join(root, "checkout-b");
    makeMiniCheckout(checkoutB, "release-b");
    const installB = runInstallSh(checkoutB, env);
    assert.equal(installB.status, 0, `install B failed:\n${installB.stdout}\n${installB.stderr}`);
    const relB = basename(readlinkSync(join(installDir, "current")));

    const relXDir = join(installDir, "releases", relX);
    mkdirSync(join(relXDir, "src", "tools"), { recursive: true });
    writeFileSync(join(relXDir, ".installed"), "");
    writeFileSync(join(relXDir, "src", "tools", "native-tools.ts"), `export const OCTOFS_VERSION = "${OCTOFS_VERSION}";\n`);
    backdateRelease(installDir, relA, 5 * HOUR);
    backdateRelease(installDir, relX, 4 * HOUR);
    backdateRelease(installDir, relB, 3 * HOUR);

    const auditLogPath = join(stateDir, "install-audit.log");
    rmSync(auditLogPath, { force: true });

    const checkoutC = join(root, "checkout-c");
    makeMiniCheckout(checkoutC, "release-c");
    const installC = runInstallSh(checkoutC, env);
    assert.equal(installC.status, 0, `install C failed:\n${installC.stdout}\n${installC.stderr}`);
    const relC = basename(readlinkSync(join(installDir, "current")));

    const recordPath = join(installDir, "rollback-pair.json");
    const finalized = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
    assert.deepEqual(finalized, { current: relC, previous: relB });
    assert.equal("pending" in finalized, false);

    // With default keep=3: C (current), B (previous), and X (newer than A) survive; oldest unpinned A is pruned.
    assert.equal(existsSync(join(installDir, "releases", relC)), true, "current release C must be kept");
    assert.equal(existsSync(join(installDir, "releases", relB)), true, "previous release B must be kept");
    assert.equal(existsSync(join(installDir, "releases", relX)), true, "newer release X should fill keep=3");
    assert.equal(existsSync(join(installDir, "releases", relA)), false, "superseded oldest release A should be pruned");

    const auditText = readFileSync(auditLogPath, "utf8");
    assert.equal(
      auditText.includes("maintenance=interrupted_activation"),
      false,
      `completed activation must not log interrupted_activation:\n${auditText}`,
    );
  });
});
