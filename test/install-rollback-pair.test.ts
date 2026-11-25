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
});
