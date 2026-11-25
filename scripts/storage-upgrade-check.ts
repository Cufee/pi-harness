#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanTestEnv,
  cleanupSandbox,
  initTempRepo,
  isPidAlive,
  rpc,
  waitForPing,
  writeHarnessHome,
} from "../test/helpers/hot-update-fixture.js";
import {
  assertStrictlyUnderRoot,
  computeInstallReleaseId,
  formatSummaryTable,
  listLingeringProcessesForRoot,
  materializeRefWithGitArchive,
  pass,
  pollUntil,
  queryDb,
  readRecordedFakePidsForTasks,
  resolvePrevRef,
  runCommand,
  seedInstallCacheReadOnly,
  sha256File,
  snapshotHarnessTree,
  type PhaseResult,
  type SnapshotFileEntry,
} from "./lib/storage-upgrade/helpers.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_AGENT_PATH = resolve(REPO_ROOT, "scripts", "lib", "storage-upgrade", "fake-acp-agent.ts");

const layout = process.env.STORAGE_UPGRADE_LAYOUT ?? "legacy";
if (layout !== "legacy" && layout !== "data-dir") {
  throw new Error(`Unsupported STORAGE_UPGRADE_LAYOUT=${JSON.stringify(layout)} (expected 'legacy' or 'data-dir')`);
}
const keepTemp = process.env.STORAGE_UPGRADE_KEEP === "1";

// --- W11 data-dir assertion stubs (do not guess; W11 fills these in) -------

export function assertDataDirAfterUpdate(): never {
  throw new Error("not implemented yet (W11)");
}

export function assertInFlightGoalUntouched(): never {
  throw new Error("not implemented yet (W11)");
}

export function assertMigratedAfterSettle(): never {
  throw new Error("not implemented yet (W11)");
}

export function assertIdempotentRerun(): never {
  throw new Error("not implemented yet (W11)");
}

interface ArtifactRow {
  id: string;
  run_id: string;
  task_id: string;
  kind: string;
  path: string;
  summary: string;
}

interface TaskRow {
  id: string;
  run_id: string;
  tier: number;
  status: string;
  generation: number;
  worktree_id: string | null;
}

interface WorktreeRow {
  id: string;
  run_id: string;
  task_id: string;
  path: string;
  branch: string;
  base_sha: string;
  status: string;
}

interface LegacySnapshot {
  files: SnapshotFileEntry[];
  artifacts: ArtifactRow[];
  tasks: TaskRow[];
  worktrees: WorktreeRow[];
  gitStatusPorcelain: string;
  maxEventSeq: number;
  g1EvidenceStat: { dev: bigint; ino: bigint };
  worktreeStat: { dev: bigint; ino: bigint };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const root = realpathSync(mkdtempSync(join(tmpdir(), "su-check-")));
  const homeDir = join(root, "home");
  const installDir = join(root, "install");
  const binDir = join(root, "bin");
  const fakeDir = join(root, "fake");
  const repoDir = join(root, "repo");
  const checkoutPrevDir = join(root, "checkout-prev");
  const socketPath = join(root, "d.sock");
  const dbPath = join(homeDir, "control-plane.sqlite");

  const extraDaemonPids: number[] = [];
  let cleanedUp = false;

  const doCleanup = async () => {
    if (cleanedUp) return;
    cleanedUp = true;
    await cleanupSandbox({
      socketPath,
      homeDir,
      fakeDir,
      extraDaemonPids,
      tempDirs: keepTemp ? [] : [root],
    });
  };

  const onSignal = (sig: NodeJS.Signals, code: number) => {
    console.error(`\nreceived ${sig}; cleaning up sandbox ${root}`);
    void doCleanup().finally(() => process.exit(code));
  };
  process.once("SIGINT", () => onSignal("SIGINT", 130));
  process.once("SIGTERM", () => onSignal("SIGTERM", 143));

  const phases: PhaseResult[] = [
    { id: 1, name: "Sandbox", status: "SKIP", durationMs: 0 },
    { id: 2, name: "Previous release", status: "SKIP", durationMs: 0 },
    { id: 3, name: "Legacy state", status: "SKIP", durationMs: 0 },
    { id: 4, name: "Update", status: "SKIP", durationMs: 0 },
    { id: 5, name: "Resume", status: "SKIP", durationMs: 0 },
    { id: 6, name: `Data (${layout})`, status: "SKIP", durationMs: 0 },
    { id: 7, name: "Settle", status: "SKIP", durationMs: 0 },
    { id: 8, name: "Previous release rollback", status: "SKIP", durationMs: 0 },
    { id: 9, name: "Cleanup", status: "SKIP", durationMs: 0 },
  ];

  const runPhase = async <T>(id: number, fn: () => Promise<T>): Promise<T> => {
    const entry = phases.find((p) => p.id === id)!;
    const t0 = Date.now();
    console.log(`\n=== Phase ${entry.id}: ${entry.name} ===`);
    try {
      const res = await fn();
      entry.status = "PASS";
      entry.durationMs = Date.now() - t0;
      return res;
    } catch (err) {
      entry.status = "FAIL";
      entry.durationMs = Date.now() - t0;
      entry.detail = err instanceof Error ? err.message : String(err);
      throw err;
    }
  };

  console.log("=== Goal-39 Storage Upgrade E2E Check ===");
  console.log(`timestamp: ${new Date().toISOString()}`);
  console.log(`checkout:  ${REPO_ROOT}`);
  console.log(`layout:    ${layout}`);
  console.log(`temp root: ${root}${keepTemp ? " (STORAGE_UPGRADE_KEEP=1)" : ""}`);

  const baseEnv: Record<string, string> = {
    PI_HARNESS_HOME: homeDir,
    PI_HARNESS_INSTALL_DIR: installDir,
    PI_HARNESS_BIN_DIR: binDir,
    XDG_RUNTIME_DIR: root,
  };
  const layoutEnv: Record<string, string> =
    layout === "data-dir" ? { ...baseEnv, PI_HARNESS_STORAGE_LAYOUT: "data-dir" } : { ...baseEnv };

  let relPrev = "";
  let pidPrev = 0;
  let relNew = "";
  let pidNew = 0;
  let canonicalRepoDir = "";

  let g0Id = "";
  let g0RunId = "";
  let g0ArtifactPath = "";
  let g0ArtifactContent = "";

  let g1Id = "";
  let g1RunId = "";
  let g1OrchId = "";
  let g1OrchGen = 0;
  let g1WorkerId = "";
  let g1TaskIds: string[] = [];
  let g1TimerId = "";
  let g1PidsBeforeReload: number[] = [];
  let g1EvidenceDir = "";
  let notePath = "";
  let noteContent = "";
  let legacyWorktreeRow!: WorktreeRow;
  let snapshot!: LegacySnapshot;

  let runError: unknown = null;

  try {
    // -----------------------------------------------------------------------
    // Phase 1: Sandbox
    // -----------------------------------------------------------------------
    await runPhase(1, async () => {
      assertStrictlyUnderRoot("PI_HARNESS_HOME", homeDir, root);
      assertStrictlyUnderRoot("PI_HARNESS_INSTALL_DIR", installDir, root);
      assertStrictlyUnderRoot("PI_HARNESS_BIN_DIR", binDir, root);
      assertStrictlyUnderRoot("socketPath", socketPath, root);
      assertStrictlyUnderRoot("fakeDir", fakeDir, root);
      assertStrictlyUnderRoot("repoDir", repoDir, root);
      assertStrictlyUnderRoot("checkoutPrevDir", checkoutPrevDir, root);
      pass("Safety check: all temp paths and socketPath resolve strictly under temp root", `socketPath=${socketPath}`);

      mkdirSync(homeDir, { recursive: true });
      mkdirSync(installDir, { recursive: true });
      mkdirSync(binDir, { recursive: true });
      mkdirSync(checkoutPrevDir, { recursive: true });
      canonicalRepoDir = initTempRepo(repoDir);

      const seeded = seedInstallCacheReadOnly(installDir);
      console.log(
        `seeded offline caches (read-only from ~/.pi-harness/install): ${seeded.length > 0 ? seeded.join(", ") : "none"}`,
      );

      writeHarnessHome(homeDir, {
        socketPath,
        fakeDir,
        hotUpdate: { mode: "auto", drainTimeoutSec: 20, minIntervalSec: 0 },
      });

      // Point the acp:fake profile at our storage-upgrade fake agent while keeping writeHarnessHome's catalog/config setup.
      const cfgPath = join(homeDir, "config.json");
      const rawCfg = JSON.parse(readFileSync(cfgPath, "utf8")) as {
        socketPath?: string;
        profiles?: Array<{ id?: string; args?: string[] }>;
      };
      assert.equal(rawCfg.socketPath, socketPath);
      assertStrictlyUnderRoot("config.json socketPath", rawCfg.socketPath, root);
      const fakeProfile = rawCfg.profiles?.find((p) => p.id === "acp:fake");
      assert.ok(fakeProfile, "expected acp:fake profile in generated config.json");
      fakeProfile.args = [FAKE_AGENT_PATH];
      writeFileSync(cfgPath, JSON.stringify(rawCfg, null, 2) + "\n", "utf8");
      pass("Sandbox initialized with isolated config, temp repo on main, and fake agent", `repo=${canonicalRepoDir}`);
    });

    // -----------------------------------------------------------------------
    // Phase 2: Previous release
    // -----------------------------------------------------------------------
    await runPhase(2, async () => {
      const prev = resolvePrevRef(REPO_ROOT);
      console.log(`resolved PREV ref: ${prev.ref} (${prev.sha.slice(0, 12)}) via rule=${prev.rule}`);
      pass("Resolved PREV ref", `rule=${prev.rule} ref=${prev.ref} sha=${prev.sha.slice(0, 12)}`);

      materializeRefWithGitArchive(REPO_ROOT, prev.ref, checkoutPrevDir);

      // When PREV falls back to HEAD (before src/storage/paths.ts lands), checkout-prev has the same content hash
      // as REPO_ROOT; add a harmless comment inside checkout-prev only so install.sh assigns a distinct release ID
      // while REPO_ROOT stays untouched.
      const prevHash = computeInstallReleaseId(checkoutPrevDir);
      const curHash = computeInstallReleaseId(REPO_ROOT);
      if (prevHash === curHash) {
        const prevReleaseTs = join(checkoutPrevDir, "src", "daemon", "release.ts");
        appendFileSync(prevReleaseTs, "\n// storage-upgrade-check prev-release marker (identical HEAD fallback)\n", "utf8");
        console.log(
          `checkout-prev matched REPO_ROOT hash (${prevHash}); tagged checkout-prev/src/daemon/release.ts so relPrev != relNew`,
        );
      }

      const installPrev = await runCommand("sh", ["install.sh"], {
        cwd: checkoutPrevDir,
        env: baseEnv,
        label: `PI_HARNESS_HOME=${homeDir} PI_HARNESS_INSTALL_DIR=${installDir} PI_HARNESS_BIN_DIR=${binDir} sh install.sh (PREV)`,
      });
      assert.equal(installPrev.code, 0, `PREV install.sh failed with exit ${installPrev.code}`);
      assert.ok(
        installPrev.stdout.includes("harnessd is not running"),
        "expected 'harnessd is not running' in PREV install stdout",
      );
      assert.equal(existsSync(socketPath), false, "PREV install.sh must not start a daemon");

      const currentLinkPrev = readlinkSync(join(installDir, "current"));
      relPrev = basename(currentLinkPrev);
      assert.ok(currentLinkPrev.startsWith("releases/"), `unexpected current symlink: ${currentLinkPrev}`);
      assert.equal(relPrev.length, 12, `expected 12-char relPrev, got ${relPrev}`);
      pass("Installed PREV release into sandbox", `relPrev=${relPrev} current -> ${currentLinkPrev}`);

      const launcherPath = join(binDir, "pi-harness");
      assert.ok(existsSync(launcherPath), `expected launcher at ${launcherPath}`);
      const daemonLogPath = join(dirname(socketPath), "daemon.log");
      console.log(
        `\n$ ${layout === "data-dir" ? "PI_HARNESS_STORAGE_LAYOUT=data-dir " : ""}${launcherPath} daemon serve (detached -> ${daemonLogPath})`,
      );
      const logFd = openSync(daemonLogPath, "a");
      try {
        const child = spawn(launcherPath, ["daemon", "serve"], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          cwd: dirname(socketPath),
          env: cleanTestEnv(layoutEnv),
        });
        child.unref();
      } finally {
        closeSync(logFd);
      }

      const pingPrev = await waitForPing(socketPath, (p) => typeof p?.pid === "number" && p.pid > 0, 15_000);
      pidPrev = pingPrev.pid as number;
      extraDaemonPids.push(pidPrev);
      assert.equal(pingPrev.releaseId, relPrev, `expected pingPrev.releaseId=${relPrev}, got ${pingPrev.releaseId}`);
      assert.equal(pingPrev.restartSafe, true, "expected pingPrev.restartSafe === true");
      assert.equal(pingPrev.reload?.state, "idle", `expected pingPrev.reload.state === 'idle', got ${pingPrev.reload?.state}`);
      pass("Started PREV daemon via installed launcher", `pid=${pidPrev} releaseId=${relPrev}`);
    });

    // -----------------------------------------------------------------------
    // Phase 3: Legacy state
    // -----------------------------------------------------------------------
    await runPhase(3, async () => {
      // --- G0: terminal goal before update (created via real chat.create + goal.create + goal.commit + goal.accept) ---
      const chat0 = await rpc<{ session: { id: string } }>(socketPath, "chat.create", {
        repoRoot: canonicalRepoDir,
        headless: true,
        title: "storage-upgrade-g0",
      });
      const goal0 = await rpc<{ id: string }>(socketPath, "goal.create", {
        repoRoot: canonicalRepoDir,
        chatSessionId: chat0.session.id,
        title: "FAKE_ROLE=g0_orchestrator G0 terminal pre-upgrade goal",
        description: "Terminal goal with evidence file and indexed dossier created before storage upgrade.",
        criteria: [{ kind: "behavioral", description: "G0 dossier written before upgrade" }],
        verificationMode: "none",
      });
      g0Id = goal0.id;
      const g0Commit = await rpc<{ id: string; linkedRunId: string | null }>(socketPath, "goal.commit", {
        goalId: g0Id,
      });
      assert.ok(g0Commit.linkedRunId, `expected G0 commit to create linkedRunId, got ${JSON.stringify(g0Commit)}`);
      g0RunId = g0Commit.linkedRunId;

      await pollUntil(
        async () => {
          const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId: g0RunId });
          return r.run.status === "completed";
        },
        20_000,
        "G0 linked run completed",
      );

      const g0Arts = await rpc<Array<{ id: string; path: string; taskId: string }>>(socketPath, "artifact.list", {
        runId: g0RunId,
      });
      assert.ok(g0Arts.length >= 1, `expected >=1 artifacts row for G0 run ${g0RunId}`);
      g0ArtifactPath = g0Arts[0]!.path;
      assert.ok(
        g0ArtifactPath.startsWith(join(canonicalRepoDir, ".harness", "artifacts", g0RunId) + "/"),
        `expected G0 artifact under .harness/artifacts/${g0RunId}/, got ${g0ArtifactPath}`,
      );
      assert.ok(existsSync(g0ArtifactPath), `G0 artifact missing on disk: ${g0ArtifactPath}`);
      g0ArtifactContent = readFileSync(g0ArtifactPath, "utf8");
      const g0Read = await rpc<{ content?: string }>(socketPath, "artifact.read", {
        runId: g0RunId,
        path: g0ArtifactPath,
      });
      assert.equal(g0Read.content, g0ArtifactContent, "G0 artifact.read content mismatch before update");

      // Direct file seed: no standalone daemon RPC writes arbitrary files into <repo>/.harness/goals/<G0>/
      // (goal.create creates the evidence directory; agents write files there via shell/file tools).
      const g0EvidenceDir = join(canonicalRepoDir, ".harness", "goals", g0Id);
      assert.ok(lstatSync(g0EvidenceDir).isDirectory(), `expected real evidence dir at ${g0EvidenceDir}`);
      const g0EvidenceFile = join(g0EvidenceDir, "g0-evidence.txt");
      writeFileSync(g0EvidenceFile, `G0 terminal evidence for ${g0Id} (run ${g0RunId})\n`, "utf8");

      const g0Accepted = await rpc<{ goal: { status: string } }>(socketPath, "goal.accept", {
        goalId: g0Id,
        reason: "G0 verified before storage upgrade",
        evidencePaths: [`.harness/goals/${g0Id}/g0-evidence.txt`],
      });
      assert.equal(g0Accepted.goal.status, "achieved", `expected G0 status achieved, got ${g0Accepted.goal.status}`);
      pass(
        "Created terminal goal G0 with evidence file and dossier artifact",
        `goal=${g0Id} run=${g0RunId} status=achieved artifact=${basename(g0ArtifactPath)}`,
      );

      // --- G1: live goal linked to live run (orchestrator + Tier 2 worker with real worktree + timer) ---
      const chat1 = await rpc<{ session: { id: string } }>(socketPath, "chat.create", {
        repoRoot: canonicalRepoDir,
        headless: true,
        title: "storage-upgrade-g1",
      });
      const goal1 = await rpc<{ id: string }>(socketPath, "goal.create", {
        repoRoot: canonicalRepoDir,
        chatSessionId: chat1.session.id,
        title: "FAKE_ROLE=g1_orchestrator G1 live upgrade goal",
        description: "Live goal whose run, Tier 2 worker worktree, dossier, and timer must survive hot update.",
        criteria: [{ kind: "behavioral", description: "G1 survives hot update and settles cleanly" }],
        verificationMode: "none",
      });
      g1Id = goal1.id;

      // Direct file seed into the real evidence dir created by goal.create (no standalone RPC for writing evidence files).
      g1EvidenceDir = join(canonicalRepoDir, ".harness", "goals", g1Id);
      assert.ok(
        lstatSync(g1EvidenceDir).isDirectory() && !lstatSync(g1EvidenceDir).isSymbolicLink(),
        `expected real evidence dir at ${g1EvidenceDir}`,
      );
      writeFileSync(join(g1EvidenceDir, "g1-evidence.txt"), `G1 live evidence for ${g1Id}\n`, "utf8");

      const g1Commit = await rpc<{ id: string; linkedRunId: string | null }>(socketPath, "goal.commit", {
        goalId: g1Id,
      });
      assert.ok(g1Commit.linkedRunId, `expected G1 commit to create linkedRunId, got ${JSON.stringify(g1Commit)}`);
      g1RunId = g1Commit.linkedRunId;

      const preG1 = await pollUntil(
        async () => {
          const runGet = await rpc<{
            run: { status: string };
            tasks: Array<{ id: string; tier: number; status: string; generation: number; worktreeId: string | null }>;
          }>(socketPath, "run.get", { runId: g1RunId });
          const orch = runGet.tasks.find((t) => t.tier === 1);
          const worker = runGet.tasks.find((t) => t.tier === 2);
          if (!orch || !worker || worker.status !== "running" || !worker.worktreeId) return null;

          const timers = queryDb(
            dbPath,
            (db) =>
              db.prepare("SELECT id, status FROM timers WHERE owner_id = ?").all(orch.id) as Array<{
                id: string;
                status: string;
              }>,
          );
          const pendingTimer = timers.find((t) => t.status === "pending");
          if (!pendingTimer) return null;

          const arts = queryDb(
            dbPath,
            (db) =>
              db.prepare("SELECT id, path FROM artifacts WHERE run_id = ?").all(g1RunId) as Array<{
                id: string;
                path: string;
              }>,
          );
          if (arts.length === 0 || !arts.every((a) => existsSync(a.path))) return null;

          const wt = queryDb(
            dbPath,
            (db) =>
              db
                .prepare("SELECT id, run_id, task_id, path, branch, base_sha, status FROM worktrees WHERE id = ?")
                .get(worker.worktreeId!) as WorktreeRow | null,
          );
          if (!wt || !existsSync(wt.path)) return null;

          const livePids = readRecordedFakePidsForTasks(fakeDir, [orch.id, worker.id]).filter((pid) => isPidAlive(pid));
          if (livePids.length < 2) return null;

          return {
            orchId: orch.id,
            orchGen: orch.generation,
            workerId: worker.id,
            taskIds: runGet.tasks.map((t) => t.id).sort(),
            timerId: pendingTimer.id,
            pidsBeforeReload: livePids,
            worktree: wt,
          };
        },
        25_000,
        "G1 live run with Tier 2 worker, worktree, dossier artifact, pending timer, and live fake PIDs",
      );

      g1OrchId = preG1.orchId;
      g1OrchGen = preG1.orchGen;
      g1WorkerId = preG1.workerId;
      g1TaskIds = preG1.taskIds;
      g1TimerId = preG1.timerId;
      g1PidsBeforeReload = preG1.pidsBeforeReload;
      legacyWorktreeRow = preG1.worktree;

      const expectedWtPath = join(canonicalRepoDir, ".harness", "worktrees", g1RunId, g1WorkerId);
      assert.equal(realpathSync(legacyWorktreeRow.path), realpathSync(expectedWtPath), "worktree path mismatch");
      const gitWorktrees = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: canonicalRepoDir,
        encoding: "utf8",
      });
      assert.ok(
        gitWorktrees.includes(`worktree ${realpathSync(expectedWtPath)}`),
        `expected git worktree at ${expectedWtPath} in git worktree list`,
      );
      pass(
        "Live goal G1 active with Tier 2 worker, real git worktree, dossier, and pending timer",
        `goal=${g1Id} run=${g1RunId} orch=${g1OrchId} (gen=${g1OrchGen}) worker=${g1WorkerId} wt=${legacyWorktreeRow.id} timer=${g1TimerId} livePids=[${g1PidsBeforeReload.join(",")}]`,
      );

      // --- Note file ---
      // Direct file seed: `.harness/notes/*` is only written by the Director's internal `write_note` tool during a
      // chat turn; no standalone daemon RPC writes note files.
      const notesDir = join(canonicalRepoDir, ".harness", "notes");
      mkdirSync(notesDir, { recursive: true });
      notePath = join(notesDir, "upgrade-note.md");
      noteContent = "# Upgrade Note\nLegacy note preserved across storage upgrade.\n";
      writeFileSync(notePath, noteContent, "utf8");
      pass("Seeded legacy note file (direct; no standalone RPC)", notePath);

      // --- Snapshot ---
      const files = snapshotHarnessTree(canonicalRepoDir);
      assert.ok(files.length >= 5, `expected >=5 files under .harness (excl. worktrees), got ${files.length}`);
      const artifacts = queryDb(
        dbPath,
        (db) => db.prepare("SELECT id, run_id, task_id, kind, path, summary FROM artifacts ORDER BY id").all() as ArtifactRow[],
      );
      const tasks = queryDb(
        dbPath,
        (db) => db.prepare("SELECT id, run_id, tier, status, generation, worktree_id FROM tasks ORDER BY id").all() as TaskRow[],
      );
      const worktrees = queryDb(
        dbPath,
        (db) =>
          db
            .prepare("SELECT id, run_id, task_id, path, branch, base_sha, status FROM worktrees ORDER BY id")
            .all() as WorktreeRow[],
      );
      const maxEventSeq = queryDb(
        dbPath,
        (db) => (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }).m,
      );
      const gitStatusPorcelain = execFileSync("git", ["status", "--porcelain"], {
        cwd: canonicalRepoDir,
        encoding: "utf8",
      });
      const g1EvSt = lstatSync(g1EvidenceDir, { bigint: true });
      const wtSt = lstatSync(legacyWorktreeRow.path, { bigint: true });

      snapshot = {
        files,
        artifacts,
        tasks,
        worktrees,
        gitStatusPorcelain,
        maxEventSeq,
        g1EvidenceStat: { dev: g1EvSt.dev, ino: g1EvSt.ino },
        worktreeStat: { dev: wtSt.dev, ino: wtSt.ino },
      };

      const timerCheck = queryDb(
        dbPath,
        (db) => db.prepare("SELECT status FROM timers WHERE id = ?").get(g1TimerId) as { status: string } | null,
      );
      assert.equal(timerCheck?.status, "pending", `expected timer ${g1TimerId} still pending before update`);

      pass(
        "Captured pre-update legacy snapshot",
        `files=${snapshot.files.length} artifacts=${snapshot.artifacts.length} tasks=${snapshot.tasks.length} worktrees=${snapshot.worktrees.length} maxEventSeq=${snapshot.maxEventSeq}`,
      );
    });

    // -----------------------------------------------------------------------
    // Phase 4: Update (run real install.sh of checkout under test)
    // -----------------------------------------------------------------------
    await runPhase(4, async () => {
      const installNew = await runCommand("sh", ["install.sh"], {
        cwd: REPO_ROOT,
        env: { ...layoutEnv, PI_HARNESS_RELOAD_WAIT: "1" },
        label: `PI_HARNESS_RELOAD_WAIT=1 ${layout === "data-dir" ? "PI_HARNESS_STORAGE_LAYOUT=data-dir " : ""}sh install.sh (checkout under test)`,
      });
      assert.equal(installNew.code, 0, `checkout-under-test install.sh failed with exit ${installNew.code}`);

      const currentLinkNew = readlinkSync(join(installDir, "current"));
      relNew = basename(currentLinkNew);
      assert.ok(currentLinkNew.startsWith("releases/"), `unexpected current symlink: ${currentLinkNew}`);
      assert.notEqual(relNew, relPrev, `expected current to move from ${relPrev} to a new release ID`);
      pass("current symlink moved to new release", `${relPrev} -> ${relNew}`);

      const pingNew = await rpc<{ pid: number; releaseId: string; reload?: { previousReleaseId?: string } }>(
        socketPath,
        "ping",
      );
      pidNew = pingNew.pid;
      extraDaemonPids.push(pidNew);
      assert.notEqual(pidNew, pidPrev, `expected daemon PID to change from ${pidPrev}`);
      assert.equal(pingNew.releaseId, relNew, `expected ping.releaseId=${relNew}, got ${pingNew.releaseId}`);
      assert.equal(
        pingNew.reload?.previousReleaseId,
        relPrev,
        `expected ping.reload.previousReleaseId=${relPrev}, got ${pingNew.reload?.previousReleaseId}`,
      );
      pass("Daemon hot-updated to checkout under test", `pid ${pidPrev} (${relPrev}) -> pid ${pidNew} (${relNew})`);
    });

    // -----------------------------------------------------------------------
    // Phase 5: Resume
    // -----------------------------------------------------------------------
    await runPhase(5, async () => {
      // Wait for preserved timer to fire and steer orchestrator exactly once.
      await pollUntil(
        () => {
          const row = queryDb(
            dbPath,
            (db) => db.prepare("SELECT status FROM timers WHERE id = ?").get(g1TimerId) as { status: string } | null,
          );
          if (row?.status !== "fired") return null;
          const steers = queryDb(
            dbPath,
            (db) =>
              db
                .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
                .all(g1RunId) as Array<{ payload_json: string }>,
          ).filter((e) => e.payload_json.includes(g1TimerId));
          return steers.length >= 1 ? steers : null;
        },
        15_000,
        "preserved G1 timer fired and steered orchestrator",
      );

      const timerSteers = queryDb(
        dbPath,
        (db) =>
          db
            .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
            .all(g1RunId) as Array<{ payload_json: string }>,
      ).filter((e) => e.payload_json.includes(g1TimerId));
      assert.equal(timerSteers.length, 1, `expected timer ${g1TimerId} to steer once, got ${timerSteers.length}`);
      pass("Preserved timer fired and steered orchestrator exactly once", `timerId=${g1TimerId}`);

      const midRun = await rpc<{
        run: { status: string };
        tasks: Array<{ id: string; tier: number; status: string; generation: number }>;
      }>(socketPath, "run.get", { runId: g1RunId });
      assert.equal(midRun.run.status, "active", `expected G1 run active after update, got ${midRun.run.status}`);
      assert.deepEqual(
        midRun.tasks.map((t) => t.id).sort(),
        g1TaskIds,
        "G1 task ID set changed across hot update",
      );
      const midOrch = midRun.tasks.find((t) => t.id === g1OrchId);
      assert.ok(midOrch, `G1 orchestrator ${g1OrchId} missing after update`);
      assert.equal(midOrch.generation, g1OrchGen, "G1 orchestrator generation changed across restart rollover");
      pass(
        "Live run G1 resumed in place with same task IDs and orchestrator generation",
        `tasks=[${g1TaskIds.join(",")}] orchGen=${midOrch.generation}`,
      );

      const postUpdateStatusEvents = queryDb(
        dbPath,
        (db) =>
          db
            .prepare("SELECT task_id, payload_json FROM events WHERE seq > ? AND type = 'task.status'")
            .all(snapshot.maxEventSeq) as Array<{ task_id: string | null; payload_json: string }>,
      );
      for (const ev of postUpdateStatusEvents) {
        const payload = JSON.parse(ev.payload_json) as { to?: string; status?: string };
        const to = payload.to ?? payload.status;
        assert.notEqual(to, "failed", `unexpected failed task.status event after update: ${ev.payload_json}`);
        assert.notEqual(to, "cancelled", `unexpected cancelled task.status event after update: ${ev.payload_json}`);
      }
      pass("Zero failed/cancelled task.status events since update", `checked=${postUpdateStatusEvents.length} events`);

      await pollUntil(
        () => g1PidsBeforeReload.every((pid) => !isPidAlive(pid)),
        5_000,
        "all pre-update fake agent PIDs reaped",
      );
      pass("Pre-update fake agent PIDs reaped", `dead=[${g1PidsBeforeReload.join(",")}]`);
    });

    // -----------------------------------------------------------------------
    // Phase 6: Data
    // -----------------------------------------------------------------------
    await runPhase(6, async () => {
      if (layout === "data-dir") {
        assertDataDirAfterUpdate();
        assertInFlightGoalUntouched();
      }

      // Layout 'legacy' assertions:
      for (const f of snapshot.files) {
        assert.ok(existsSync(f.absPath), `snapshot file missing after update: ${f.absPath}`);
        const st = lstatSync(f.absPath);
        assert.equal(st.isSymbolicLink(), false, `snapshot file unexpectedly became symlink: ${f.absPath}`);
        assert.equal(sha256File(f.absPath), f.sha256, `sha256 mismatch for ${f.relPath}`);
      }
      pass("Every snapshot file under .harness exists at the same path with identical sha256", `count=${snapshot.files.length}`);

      const curArtifacts = queryDb(
        dbPath,
        (db) => db.prepare("SELECT id, run_id, task_id, kind, path, summary FROM artifacts ORDER BY id").all() as ArtifactRow[],
      );
      assert.ok(curArtifacts.length >= snapshot.artifacts.length, "artifacts rows decreased after update");
      for (const row of snapshot.artifacts) {
        assert.ok(existsSync(row.path), `artifacts row path missing on disk: ${row.path}`);
      }
      pass("Every artifacts row path still exists on disk", `count=${snapshot.artifacts.length}`);

      const curG1EvStat = lstatSync(g1EvidenceDir, { bigint: true });
      assert.ok(curG1EvStat.isDirectory() && !curG1EvStat.isSymbolicLink(), `G1 evidence dir is not a real dir: ${g1EvidenceDir}`);
      assert.equal(curG1EvStat.dev, snapshot.g1EvidenceStat.dev, "G1 evidence dir device changed");
      assert.equal(curG1EvStat.ino, snapshot.g1EvidenceStat.ino, "G1 evidence dir inode changed");
      pass("G1 evidence dir is the same real directory (lstat, not symlink)", g1EvidenceDir);

      assert.equal(readFileSync(notePath, "utf8"), noteContent, "upgrade-note.md content mismatch");
      pass("Legacy note file is readable and unchanged", notePath);

      const curWtRow = queryDb(
        dbPath,
        (db) =>
          db
            .prepare("SELECT id, run_id, task_id, path, branch, base_sha, status FROM worktrees WHERE id = ?")
            .get(legacyWorktreeRow.id) as WorktreeRow | null,
      );
      assert.deepEqual(curWtRow, legacyWorktreeRow, "legacy worktree row changed across update");
      const curWtStat = lstatSync(legacyWorktreeRow.path, { bigint: true });
      assert.ok(curWtStat.isDirectory() && !curWtStat.isSymbolicLink(), "legacy worktree path is not a real directory");
      assert.equal(curWtStat.dev, snapshot.worktreeStat.dev, "legacy worktree dir device changed");
      assert.equal(curWtStat.ino, snapshot.worktreeStat.ino, "legacy worktree dir inode changed");
      pass("Legacy worktree row and directory unchanged", `id=${legacyWorktreeRow.id} path=${legacyWorktreeRow.path}`);

      const curGitStatus = execFileSync("git", ["status", "--porcelain"], {
        cwd: canonicalRepoDir,
        encoding: "utf8",
      });
      assert.equal(curGitStatus, snapshot.gitStatusPorcelain, "repo git status --porcelain changed across update");
      pass("Repo git status --porcelain unchanged", JSON.stringify(curGitStatus.trim()));
    });

    // -----------------------------------------------------------------------
    // Phase 7: Settle
    // -----------------------------------------------------------------------
    await runPhase(7, async () => {
      const goG1 = join(fakeDir, "go-g1");
      console.log(`\n$ write ${goG1}`);
      writeFileSync(goG1, "go\n", "utf8");

      await pollUntil(
        async () => {
          const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId: g1RunId });
          return r.run.status === "completed";
        },
        20_000,
        "G1 run completed after releasing go-g1",
      );

      const finalG1Run = await rpc<{
        run: { status: string };
        tasks: Array<{ id: string; status: string; generation: number }>;
      }>(socketPath, "run.get", { runId: g1RunId });
      assert.equal(finalG1Run.run.status, "completed");
      const failedTasks = finalG1Run.tasks.filter((t) => t.status === "failed" || t.status === "cancelled");
      assert.equal(failedTasks.length, 0, `expected zero failed/cancelled tasks in G1, got ${JSON.stringify(failedTasks)}`);
      assert.deepEqual(
        finalG1Run.tasks.map((t) => t.id).sort(),
        g1TaskIds,
        "G1 final task IDs changed",
      );
      assert.equal(finalG1Run.tasks.find((t) => t.id === g1OrchId)?.generation, g1OrchGen);

      const g1GoalAfter = await rpc<{ goal: { id: string; status: string } }>(socketPath, "goal.get", { goalId: g1Id });
      pass(
        "G1 run settled with zero failed tasks",
        `run=${g1RunId} runStatus=completed goal=${g1GoalAfter.goal.id} goalStatus=${g1GoalAfter.goal.status}`,
      );

      const finalTimerSteers = queryDb(
        dbPath,
        (db) =>
          db
            .prepare("SELECT payload_json FROM events WHERE run_id = ? AND type = 'agent.steered'")
            .all(g1RunId) as Array<{ payload_json: string }>,
      ).filter((e) => e.payload_json.includes(g1TimerId));
      assert.equal(finalTimerSteers.length, 1, `expected final timer steer count 1, got ${finalTimerSteers.length}`);

      const sessionsLog = await pollUntil(
        () => {
          const p = join(fakeDir, "sessions.log");
          if (!existsSync(p)) return null;
          const txt = readFileSync(p, "utf8");
          return txt.includes("g1_orchestrator resumed spawned=0") ? txt : null;
        },
        5_000,
        "sessions.log records g1_orchestrator resumed spawned=0",
      );
      assert.ok(sessionsLog.includes("g1_orchestrator fresh spawned=1"), `missing fresh g1_orchestrator in sessions.log:\n${sessionsLog}`);
      pass("sessions.log confirms G1 orchestrator resumed without duplicate spawn", "g1_orchestrator resumed spawned=0");

      if (layout === "data-dir") {
        assertMigratedAfterSettle();
        assertIdempotentRerun();
      }
    });

    // -----------------------------------------------------------------------
    // Phase 8: Previous release still works on this DB
    // -----------------------------------------------------------------------
    await runPhase(8, async () => {
      const createdR2 = await rpc<{ run: { id: string } }>(socketPath, "run.create", {
        goal: "FAKE_ROLE=r2_orchestrator verify rollback to previous release",
        repoRoot: canonicalRepoDir,
      });
      const r2RunId = createdR2.run.id;

      const preR2 = await pollUntil(
        async () => {
          const runGet = await rpc<{
            run: { status: string };
            tasks: Array<{ id: string; tier: number; status: string; generation: number }>;
          }>(socketPath, "run.get", { runId: r2RunId });
          const orch = runGet.tasks.find((t) => t.tier === 1);
          const child = runGet.tasks.find((t) => t.tier === 3);
          if (!orch || !child || child.status !== "running") return null;
          const livePids = readRecordedFakePidsForTasks(fakeDir, [orch.id, child.id]).filter((pid) => isPidAlive(pid));
          if (livePids.length < 2) return null;
          return {
            orchId: orch.id,
            orchGen: orch.generation,
            childId: child.id,
            taskIds: runGet.tasks.map((t) => t.id).sort(),
            livePids,
          };
        },
        20_000,
        "R2 active on new release with blocking child and live fake PIDs",
      );
      const r2MaxEventBeforeRollback = queryDb(
        dbPath,
        (db) => (db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events").get() as { m: number }).m,
      );
      pass(
        "Started second live run R2 on new release",
        `run=${r2RunId} orch=${preR2.orchId} (gen=${preR2.orchGen}) child=${preR2.childId}`,
      );

      // Hot-update back to relPrev via checkout-prev's install.sh.
      const rollbackInstall = await runCommand("sh", ["install.sh"], {
        cwd: checkoutPrevDir,
        env: { ...baseEnv, PI_HARNESS_RELOAD_WAIT: "1" },
        label: `PI_HARNESS_RELOAD_WAIT=1 sh install.sh (rollback to PREV ${relPrev})`,
      });
      assert.equal(rollbackInstall.code, 0, `rollback install.sh failed with exit ${rollbackInstall.code}`);

      const currentLinkBack = readlinkSync(join(installDir, "current"));
      assert.equal(basename(currentLinkBack), relPrev, `expected current back at ${relPrev}, got ${currentLinkBack}`);

      const pingBack = await rpc<{ pid: number; releaseId: string; reload?: { previousReleaseId?: string } }>(
        socketPath,
        "ping",
      );
      extraDaemonPids.push(pingBack.pid);
      assert.equal(pingBack.releaseId, relPrev, `expected ping.releaseId=${relPrev}, got ${pingBack.releaseId}`);
      assert.notEqual(pingBack.pid, pidNew, `expected daemon PID to change on rollback from ${pidNew}`);
      assert.equal(pingBack.reload?.previousReleaseId, relNew, `expected previousReleaseId=${relNew}`);
      pass(
        "Daemon rolled back to relPrev via checkout-prev/install.sh",
        `pid ${pidNew} (${relNew}) -> pid ${pingBack.pid} (${pingBack.releaseId})`,
      );

      const midR2 = await rpc<{
        run: { status: string };
        tasks: Array<{ id: string; status: string; generation: number }>;
      }>(socketPath, "run.get", { runId: r2RunId });
      assert.equal(midR2.run.status, "active", `expected R2 active after rollback, got ${midR2.run.status}`);
      assert.deepEqual(
        midR2.tasks.map((t) => t.id).sort(),
        preR2.taskIds,
        "R2 task IDs changed across rollback",
      );
      assert.equal(midR2.tasks.find((t) => t.id === preR2.orchId)?.generation, preR2.orchGen);
      await pollUntil(
        () => preR2.livePids.every((pid) => !isPidAlive(pid)),
        5_000,
        "pre-rollback R2 fake PIDs reaped",
      );
      pass("R2 resumed in place on relPrev", `run=${r2RunId} tasks=[${preR2.taskIds.join(",")}]`);

      // Release R2's child and verify completion with zero failed tasks.
      const goR2 = join(fakeDir, "go-r2");
      console.log(`\n$ write ${goR2}`);
      writeFileSync(goR2, "go\n", "utf8");
      await pollUntil(
        async () => {
          const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId: r2RunId });
          return r.run.status === "completed";
        },
        20_000,
        "R2 completed on relPrev after releasing go-r2",
      );

      const finalR2 = await rpc<{
        run: { status: string };
        tasks: Array<{ id: string; status: string }>;
      }>(socketPath, "run.get", { runId: r2RunId });
      const failedR2 = finalR2.tasks.filter((t) => t.status === "failed" || t.status === "cancelled");
      assert.equal(failedR2.length, 0, `expected zero failed tasks in R2, got ${JSON.stringify(failedR2)}`);

      const r2StatusEvents = queryDb(
        dbPath,
        (db) =>
          db
            .prepare("SELECT payload_json FROM events WHERE seq > ? AND run_id = ? AND type = 'task.status'")
            .all(r2MaxEventBeforeRollback, r2RunId) as Array<{ payload_json: string }>,
      );
      for (const ev of r2StatusEvents) {
        const payload = JSON.parse(ev.payload_json) as { to?: string; status?: string };
        const to = payload.to ?? payload.status;
        assert.notEqual(to, "failed", `unexpected failed task.status event in R2: ${ev.payload_json}`);
        assert.notEqual(to, "cancelled", `unexpected cancelled task.status event in R2: ${ev.payload_json}`);
      }
      pass("R2 completed on relPrev with zero failed tasks", `run=${r2RunId} tasks=${finalR2.tasks.length}`);

      // Verify relPrev daemon can still read G0's artifact through artifact.read RPC.
      const g0ReadBack = await rpc<{ content?: string; path?: string }>(socketPath, "artifact.read", {
        runId: g0RunId,
        path: g0ArtifactPath,
      });
      assert.equal(g0ReadBack.content, g0ArtifactContent, "relPrev artifact.read for G0 did not match original content");
      pass("PREV release read G0 artifact through daemon artifact.read RPC", `run=${g0RunId} path=${g0ArtifactPath}`);
    });
  } catch (err) {
    runError = err;
    console.error(`\n[FAIL] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    // -----------------------------------------------------------------------
    // Phase 9: Cleanup (always runs, on success and failure)
    // -----------------------------------------------------------------------
    try {
      await runPhase(9, async () => {
        await doCleanup();
        const lingering = listLingeringProcessesForRoot(root);
        assert.equal(lingering.length, 0, `lingering processes from temp root:\n${lingering.join("\n")}`);
        if (!keepTemp) {
          assert.equal(existsSync(root), false, `temp root ${root} still exists after cleanup`);
        }
        pass(
          keepTemp
            ? "Cleanup verified: zero lingering processes (temp root kept via STORAGE_UPGRADE_KEEP=1)"
            : "Cleanup verified: zero lingering processes and temp root removed",
          `root=${root}`,
        );
      });
    } catch (cleanupErr) {
      if (!runError) runError = cleanupErr;
      console.error(
        `\n[FAIL] cleanup: ${cleanupErr instanceof Error ? cleanupErr.stack ?? cleanupErr.message : String(cleanupErr)}`,
      );
    }
  }

  const totalMs = Date.now() - startedAt;
  console.log("\n=== Phase Summary ===");
  console.log(formatSummaryTable(phases, totalMs));

  const allPassed = phases.every((p) => p.status === "PASS") && !runError;
  if (!allPassed) {
    console.error("\n=== STORAGE UPGRADE CHECK FAILED ===");
    process.exit(1);
  }
  console.log("\n=== ALL PHASES PASSED ===");
}

main().catch((err) => {
  console.error(`\n[FAIL] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
