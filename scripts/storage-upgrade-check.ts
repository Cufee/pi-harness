#!/usr/bin/env bun
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { mergedRef, taskBranchName } from "../src/storage/names.js";
import { storagePaths, type StorageLayout, type StoragePaths } from "../src/storage/paths.js";
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
  fail,
  formatSummaryTable,
  getLogFileSize,
  listLingeringProcessesForRoot,
  materializeRefWithGitArchive,
  parseMigrationLogSection,
  pass,
  pinCheckoutPrevToLegacyLayout,
  pollUntil,
  queryDb,
  readRecordedFakePidsForTasks,
  resolvePrevRef,
  runCommand,
  seedInstallCacheReadOnly,
  sha256File,
  snapshotGitignoreBytes,
  snapshotHarnessTree,
  snapshotTree,
  type MigrationSummaryLine,
  type PhaseResult,
  type SnapshotFileEntry,
  type TreeSnapshot,
} from "./lib/storage-upgrade/helpers.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_AGENT_PATH = resolve(REPO_ROOT, "scripts", "lib", "storage-upgrade", "fake-acp-agent.ts");

function parseCliArgs(argv: readonly string[]): { layout: StorageLayout; prevFlag?: string; keepTemp: boolean } {
  let layoutRaw = process.env.STORAGE_UPGRADE_LAYOUT ?? "legacy";
  let prevFlag: string | undefined;
  let keepTemp = process.env.STORAGE_UPGRADE_KEEP === "1";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--keep") {
      keepTemp = true;
    } else if (arg.startsWith("--layout=")) {
      layoutRaw = arg.slice("--layout=".length);
    } else if (arg === "--layout" && argv[i + 1]) {
      layoutRaw = argv[++i]!;
    } else if (arg.startsWith("--prev=")) {
      prevFlag = arg.slice("--prev=".length);
    } else if (arg === "--prev" && argv[i + 1]) {
      prevFlag = argv[++i]!;
    } else {
      throw new Error(`Unknown CLI argument: ${arg} (supported: --layout=legacy|data-dir, --prev=origin|head|<ref>, --keep)`);
    }
  }

  if (layoutRaw !== "legacy" && layoutRaw !== "data-dir") {
    throw new Error(`Unsupported layout=${JSON.stringify(layoutRaw)} (expected 'legacy' or 'data-dir')`);
  }
  return { layout: layoutRaw, prevFlag, keepTemp };
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

interface RecordedHarnessEnv {
  taskId: string;
  taskIdToken: string;
  role: string;
  mode: "fresh" | "resumed";
  cwd: string;
  HARNESS_GOAL_EVIDENCE_DIR: string | null;
  HARNESS_GOAL_ID: string | null;
  HARNESS_GOALS_DIR: string | null;
  HARNESS_ARTIFACTS_DIR: string | null;
}

interface SeededGoalInfo {
  goalId: string;
  chatSessionId: string;
  runId: string;
  orchId: string;
  evidenceDir: string;
  evidenceFile: string;
  evidenceContent: string;
  artifactPath: string;
  artifactContent: string;
}

interface LegacySnapshot {
  files: SnapshotFileEntry[];
  artifacts: ArtifactRow[];
  tasks: TaskRow[];
  worktrees: WorktreeRow[];
  gitStatusPorcelain: string;
  gitignoreBytes: Record<string, string>;
  maxEventSeq: number;
  g1EvidenceStat: { dev: bigint; ino: bigint };
  g1RunDirStat: { dev: bigint; ino: bigint };
  worktreeStat: { dev: bigint; ino: bigint };
}

interface MigrationStartTiming {
  label: string;
  pid: number;
  summary: MigrationSummaryLine | null;
  failureCount: number;
}

class CheckCollector {
  readonly failures: Array<{ label: string; error: string }> = [];

  async run(label: string, fn: () => Promise<void> | void): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.failures.push({ label, error: msg });
      fail(label, msg);
      return false;
    }
  }
}

function queryArtifacts(dbPath: string, runId?: string): ArtifactRow[] {
  return queryDb(dbPath, (db) =>
    runId
      ? (db
          .prepare("SELECT id, run_id, task_id, kind, path, summary FROM artifacts WHERE run_id = ? ORDER BY id")
          .all(runId) as ArtifactRow[])
      : (db.prepare("SELECT id, run_id, task_id, kind, path, summary FROM artifacts ORDER BY id").all() as ArtifactRow[]),
  );
}

function assertBridgeSymlink(label: string, legacyPath: string, expectedTarget: string): void {
  assert.ok(lstatSync(legacyPath).isSymbolicLink(), `${label}: expected symlink at ${legacyPath}`);
  assert.equal(
    readlinkSync(legacyPath),
    expectedTarget,
    `${label}: bridge target mismatch at ${legacyPath}`,
  );
}

function assertRealDir(label: string, dirPath: string): void {
  const st = lstatSync(dirPath);
  assert.ok(st.isDirectory() && !st.isSymbolicLink(), `${label}: expected real directory (not symlink) at ${dirPath}`);
}

function assertDirHashMapEquals(label: string, actualDir: string, expectedFiles: Record<string, string>): void {
  const actual = snapshotTree(actualDir);
  assert.deepEqual(actual.files, expectedFiles, `${label}: file sha256 map mismatch at ${actualDir}`);
  assert.deepEqual(actual.symlinks, {}, `${label}: unexpected symlinks inside migrated dir ${actualDir}`);
}

function readRecordedEnv(fakeDir: string, role: string, mode: "fresh" | "resumed"): RecordedHarnessEnv {
  const p = join(fakeDir, `env-${role}-${mode}.json`);
  assert.ok(existsSync(p), `expected recorded env snapshot at ${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as RecordedHarnessEnv;
}

function assertNoModifiedTrackedFiles(repoDir: string, label: string): void {
  const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: repoDir, encoding: "utf8" });
  const trackedModified = porcelain
    .split(/\r?\n/)
    .filter((line) => line.length >= 2 && !line.startsWith("??"));
  assert.deepEqual(
    trackedModified,
    [],
    `${label}: git status --porcelain reported modified tracked files:\n${porcelain}`,
  );
}

// --- Data-dir assertion implementations (W11b) -----------------------------

export interface DataDirAfterUpdateContext {
  checks: CheckCollector;
  root: string;
  homeDir: string;
  canonicalRepoDir: string;
  socketPath: string;
  dbPath: string;
  daemonLogPath: string;
  logOffsetBeforeUpdate: number;
  storage: StoragePaths;
  g0: SeededGoalInfo;
  notePath: string;
  noteContent: string;
  snapshot: LegacySnapshot;
  migrationTimings: MigrationStartTiming[];
  pidNew: number;
}

export async function assertDataDirAfterUpdate(ctx: DataDirAfterUpdateContext): Promise<{
  g0DestEvidenceDir: string;
  g0DestRunDir: string;
  g0NewArtifactPath: string;
  noteDestPath: string;
}> {
  const { checks, root, canonicalRepoDir, socketPath, dbPath, storage, g0, notePath, noteContent, snapshot } = ctx;
  const projectDir = storage.projectDir(canonicalRepoDir);
  assertStrictlyUnderRoot("data-dir projectDir", projectDir, root);

  const g0DestEvidenceDir = storage.unitDataDirDestination({
    kind: "goal",
    repoRoot: canonicalRepoDir,
    id: g0.goalId,
    chatSessionId: g0.chatSessionId,
  });
  const g0DestRunDir = storage.unitDataDirDestination({
    kind: "run",
    repoRoot: canonicalRepoDir,
    id: g0.runId,
    chatSessionId: g0.chatSessionId,
  });
  const noteDestPath = storage.unitDataDirDestination({
    kind: "note",
    repoRoot: canonicalRepoDir,
    id: basename(notePath),
  });
  assertStrictlyUnderRoot("g0DestEvidenceDir", g0DestEvidenceDir, root);
  assertStrictlyUnderRoot("g0DestRunDir", g0DestRunDir, root);
  assertStrictlyUnderRoot("noteDestPath", noteDestPath, root);

  const g0RelInRun = relative(join(canonicalRepoDir, ".harness", "artifacts", g0.runId), g0.artifactPath);
  const g0NewArtifactPath = join(g0DestRunDir, g0RelInRun);

  await checks.run("G0 migrated under owner chat with project.json, matching hashes, rewritten rows, and bridges", () => {
    const ownerSegment = storage.chatSegment(g0.chatSessionId);
    assert.equal(ownerSegment, g0.chatSessionId, `expected G0 owner chat ${g0.chatSessionId}`);
    assert.ok(
      g0DestEvidenceDir.includes(`${sep}chats${sep}${ownerSegment}${sep}goals${sep}${g0.goalId}`),
      `expected G0 evidence under owner chat ${ownerSegment}, got ${g0DestEvidenceDir}`,
    );
    assert.ok(
      g0DestRunDir.includes(`${sep}chats${sep}${ownerSegment}${sep}artifacts${sep}${g0.runId}`),
      `expected G0 run artifacts under owner chat ${ownerSegment}, got ${g0DestRunDir}`,
    );

    // project.json exists and records root & key.
    const projectJsonPath = join(projectDir, "project.json");
    assert.ok(existsSync(projectJsonPath), `expected project.json at ${projectJsonPath}`);
    const projectMeta = JSON.parse(readFileSync(projectJsonPath, "utf8")) as {
      root?: string;
      key?: string;
    };
    assert.equal(projectMeta.root, canonicalRepoDir, "project.json root mismatch");
    assert.equal(projectMeta.key, storage.projectKey(canonicalRepoDir), "project.json key mismatch");

    // G0 evidence & run artifacts files migrated with identical sha256.
    assertRealDir("g0DestEvidenceDir", g0DestEvidenceDir);
    assertRealDir("g0DestRunDir", g0DestRunDir);

    const expectedG0Evidence: Record<string, string> = {};
    const expectedG0Run: Record<string, string> = {};
    const evPrefix = `goals/${g0.goalId}/`;
    const runPrefix = `artifacts/${g0.runId}/`;
    for (const f of snapshot.files) {
      const relNorm = f.relPath.replaceAll("\\", "/");
      if (relNorm.startsWith(evPrefix)) expectedG0Evidence[relNorm.slice(evPrefix.length)] = f.sha256;
      if (relNorm.startsWith(runPrefix)) expectedG0Run[relNorm.slice(runPrefix.length)] = f.sha256;
    }
    assert.ok(Object.keys(expectedG0Evidence).length >= 1, "expected >=1 snapshot file for G0 evidence");
    assert.ok(Object.keys(expectedG0Run).length >= 1, "expected >=1 snapshot file for G0 run artifacts");
    assertDirHashMapEquals("G0 evidence dir", g0DestEvidenceDir, expectedG0Evidence);
    assertDirHashMapEquals("G0 run artifacts dir", g0DestRunDir, expectedG0Run);

    // artifacts.path rows for G0 rewritten to new absolute paths.
    const g0PreRows = snapshot.artifacts.filter((a) => a.run_id === g0.runId);
    const g0PostRows = queryArtifacts(dbPath, g0.runId);
    assert.equal(g0PostRows.length, g0PreRows.length, "G0 artifacts row count changed");
    for (const pre of g0PreRows) {
      const post = g0PostRows.find((r) => r.id === pre.id);
      assert.ok(post, `missing rewritten artifact row ${pre.id}`);
      const sub = relative(join(canonicalRepoDir, ".harness", "artifacts", g0.runId), pre.path);
      const expectedPath = join(g0DestRunDir, sub);
      assert.equal(post.path, expectedPath, `G0 artifact ${pre.id} path not rewritten to data-dir`);
      assert.ok(existsSync(post.path), `G0 rewritten artifact missing on disk: ${post.path}`);
    }

    // Unit-level bridges at legacy paths; container dirs stay real dirs.
    assertBridgeSymlink("G0 evidence bridge", g0.evidenceDir, g0DestEvidenceDir);
    assertBridgeSymlink("G0 run artifacts bridge", join(canonicalRepoDir, ".harness", "artifacts", g0.runId), g0DestRunDir);
    assertRealDir(".harness", join(canonicalRepoDir, ".harness"));
    assertRealDir(".harness/goals", join(canonicalRepoDir, ".harness", "goals"));
    assertRealDir(".harness/artifacts", join(canonicalRepoDir, ".harness", "artifacts"));
    assertRealDir(".harness/notes", join(canonicalRepoDir, ".harness", "notes"));

    pass(
      "G0 migrated to data-dir under owner chat with matching hashes, rewritten rows, bridges, and project.json",
      `chat=${ownerSegment} destEv=${g0DestEvidenceDir} destRun=${g0DestRunDir}`,
    );
  });

  await checks.run("Seeded legacy note migrated to project notes dir with matching hash and bridge", () => {
    const expectedNoteDest = join(storage.projectNotesDir(canonicalRepoDir), basename(notePath));
    assert.equal(noteDestPath, expectedNoteDest);
    const st = lstatSync(noteDestPath);
    assert.ok(st.isFile() && !st.isSymbolicLink(), `expected regular migrated note file at ${noteDestPath}`);
    const preNote = snapshot.files.find((f) => f.relPath.replaceAll("\\", "/") === `notes/${basename(notePath)}`);
    assert.ok(preNote, "pre-update snapshot missing upgrade-note.md");
    assert.equal(sha256File(noteDestPath), preNote.sha256, "migrated note sha256 mismatch");
    assert.equal(readFileSync(noteDestPath, "utf8"), noteContent, "migrated note content mismatch");
    assertBridgeSymlink("note bridge", notePath, noteDestPath);
    pass("Legacy note migrated to project notes dir with bridge", `${notePath} -> ${noteDestPath}`);
  });

  // Old & new paths through running daemon RPCs:
  const g0OldAbsArt = g0.artifactPath;
  const g0OldRelArt = `.harness/artifacts/${g0.runId}/${g0RelInRun.replaceAll("\\", "/")}`;
  const g0NewEvFile = join(g0DestEvidenceDir, basename(g0.evidenceFile));
  const g0OldAbsEv = g0.evidenceFile;
  const g0OldRelEv = `.harness/goals/${g0.goalId}/${basename(g0.evidenceFile)}`;
  const noteOldAbs = notePath;
  const noteOldRel = `.harness/notes/${basename(notePath)}`;

  await checks.run("artifact.read RPC resolves G0 dossier via new absolute, old absolute, and workspace-relative legacy paths", async () => {
    const rNew = await rpc<{ content?: string }>(socketPath, "artifact.read", { runId: g0.runId, path: g0NewArtifactPath });
    assert.equal(rNew.content, g0.artifactContent, "artifact.read(newAbs) content mismatch");
    const rOldAbs = await rpc<{ content?: string }>(socketPath, "artifact.read", { runId: g0.runId, path: g0OldAbsArt });
    assert.equal(rOldAbs.content, g0.artifactContent, "artifact.read(oldAbs) content mismatch");
    const rOldRel = await rpc<{ content?: string }>(socketPath, "artifact.read", { runId: g0.runId, path: g0OldRelArt });
    assert.equal(rOldRel.content, g0.artifactContent, "artifact.read(oldRel) content mismatch");
    pass("artifact.read RPC returned identical content for new, old-abs, and old-rel paths", `run=${g0.runId}`);
  });

  await checks.run("Director artifact_read (tool.call) resolves G0 dossier via new, old-abs, and old-rel paths", async () => {
    for (const [label, p] of [
      ["newAbs", g0NewArtifactPath],
      ["oldAbs", g0OldAbsArt],
      ["oldRel", g0OldRelArt],
    ] as const) {
      const res = await rpc<{ content?: string }>(socketPath, "tool.call", {
        taskId: g0.chatSessionId,
        name: "artifact_read",
        args: { path: p },
      });
      assert.equal(res.content, g0.artifactContent, `Director artifact_read(${label}=${p}) content mismatch`);
    }
    pass("Director artifact_read resolved new, old-abs, and old-rel paths", `chat=${g0.chatSessionId}`);
  });

  await checks.run("Director read_file (tool.call) resolves G0 evidence file and note via new, old-abs, and old-rel paths", async () => {
    for (const [label, p] of [
      ["ev:newAbs", g0NewEvFile],
      ["ev:oldAbs", g0OldAbsEv],
      ["ev:oldRel", g0OldRelEv],
    ] as const) {
      const res = await rpc<{ content?: string }>(socketPath, "tool.call", {
        taskId: g0.chatSessionId,
        name: "read_file",
        args: { path: p },
      });
      assert.equal(res.content, g0.evidenceContent, `Director read_file(${label}=${p}) content mismatch`);
    }
    for (const [label, p] of [
      ["note:newAbs", noteDestPath],
      ["note:oldAbs", noteOldAbs],
      ["note:oldRel", noteOldRel],
    ] as const) {
      const res = await rpc<{ content?: string }>(socketPath, "tool.call", {
        taskId: g0.chatSessionId,
        name: "read_file",
        args: { path: p },
      });
      assert.equal(res.content, noteContent, `Director read_file(${label}=${p}) content mismatch`);
    }
    pass("Director read_file resolved G0 evidence file and note across all 3 path forms each", `chat=${g0.chatSessionId}`);
  });

  await checks.run("Director goal_get (tool.call) reports G0 data-dir evidenceDir", async () => {
    const res = await rpc<{
      evidenceDir?: string | null;
      goal?: { id?: string; status?: string };
    }>(socketPath, "tool.call", {
      taskId: g0.chatSessionId,
      name: "goal_get",
      args: { goal_id: g0.goalId },
    });
    assert.equal(res.evidenceDir, g0DestEvidenceDir, `goal_get evidenceDir mismatch: got ${res.evidenceDir}`);
    assert.equal(res.goal?.status, "achieved", `goal_get status mismatch: got ${res.goal?.status}`);
    pass("Director goal_get returned migrated data-dir evidenceDir", `goal=${g0.goalId} evidenceDir=${res.evidenceDir}`);
  });

  await checks.run("Daemon log has exactly one storage migration summary line for hot-update start with errors=0", () => {
    const parsed = parseMigrationLogSection(ctx.daemonLogPath, ctx.logOffsetBeforeUpdate);
    assert.equal(parsed.failureLines.length, 0, `unexpected storage migration failure lines: ${parsed.failureLines.join("; ")}`);
    assert.equal(
      parsed.summaryLines.length,
      1,
      `expected exactly 1 storage migration summary line, got ${parsed.summaryLines.length}:\n${parsed.rawText}`,
    );
    const line = parsed.summaryLines[0]!;
    assert.equal(line.errors, 0, `expected errors=0, got: ${line.raw}`);
    assert.ok(line.moved >= 2, `expected moved>=2 (G0 + note), got: ${line.raw}`);
    assert.ok(line.deferred >= 1, `expected deferred>=1 (G1), got: ${line.raw}`);
    ctx.migrationTimings.push({
      label: "Phase 4 hot-update start",
      pid: ctx.pidNew,
      summary: line,
      failureCount: parsed.failureLines.length,
    });
    pass("Daemon log recorded exactly one storage migration summary line with errors=0", line.raw);
  });

  return { g0DestEvidenceDir, g0DestRunDir, g0NewArtifactPath, noteDestPath };
}

export interface InFlightGoalUntouchedContext {
  checks: CheckCollector;
  homeDir: string;
  canonicalRepoDir: string;
  fakeDir: string;
  dbPath: string;
  g1Id: string;
  g1RunId: string;
  g1EvidenceDir: string;
  legacyWorktreeRow: WorktreeRow;
  snapshot: LegacySnapshot;
}

export async function assertInFlightGoalUntouched(ctx: InFlightGoalUntouchedContext): Promise<void> {
  const { checks, homeDir, canonicalRepoDir, fakeDir, dbPath, g1Id, g1RunId, g1EvidenceDir, legacyWorktreeRow, snapshot } = ctx;
  const g1LegacyRunDir = join(canonicalRepoDir, ".harness", "artifacts", g1RunId);

  await checks.run("G1 legacy evidence dir and run artifacts dir are real dirs with unchanged hashes and inodes", () => {
    assertRealDir("G1 evidence dir", g1EvidenceDir);
    assertRealDir("G1 run artifacts dir", g1LegacyRunDir);

    const curEvStat = lstatSync(g1EvidenceDir, { bigint: true });
    assert.equal(curEvStat.dev, snapshot.g1EvidenceStat.dev, "G1 evidence dir dev changed");
    assert.equal(curEvStat.ino, snapshot.g1EvidenceStat.ino, "G1 evidence dir ino changed");

    const curRunStat = lstatSync(g1LegacyRunDir, { bigint: true });
    assert.equal(curRunStat.dev, snapshot.g1RunDirStat.dev, "G1 run dir dev changed");
    assert.equal(curRunStat.ino, snapshot.g1RunDirStat.ino, "G1 run dir ino changed");

    const expectedEv: Record<string, string> = {};
    const expectedRun: Record<string, string> = {};
    const evPrefix = `goals/${g1Id}/`;
    const runPrefix = `artifacts/${g1RunId}/`;
    for (const f of snapshot.files) {
      const relNorm = f.relPath.replaceAll("\\", "/");
      if (relNorm.startsWith(evPrefix)) expectedEv[relNorm.slice(evPrefix.length)] = f.sha256;
      if (relNorm.startsWith(runPrefix)) expectedRun[relNorm.slice(runPrefix.length)] = f.sha256;
    }
    assertDirHashMapEquals("G1 legacy evidence dir", g1EvidenceDir, expectedEv);
    assertDirHashMapEquals("G1 legacy run artifacts dir", g1LegacyRunDir, expectedRun);
    pass("G1 legacy evidence and run artifacts dirs untouched (real dirs, unchanged hashes & inodes)", `${g1Id} / ${g1RunId}`);
  });

  await checks.run("G1 artifacts rows and Tier 2 worktree row/directory unchanged; nothing of G1 exists under data dir", () => {
    const preG1Arts = snapshot.artifacts.filter((a) => a.run_id === g1RunId);
    const curG1Arts = queryArtifacts(dbPath, g1RunId);
    assert.deepEqual(curG1Arts, preG1Arts, "G1 artifacts rows changed while in flight");

    const curWtRow = queryDb(
      dbPath,
      (db) =>
        db
          .prepare("SELECT id, run_id, task_id, path, branch, base_sha, status FROM worktrees WHERE id = ?")
          .get(legacyWorktreeRow.id) as WorktreeRow | null,
    );
    assert.deepEqual(curWtRow, legacyWorktreeRow, "G1 legacy worktree row changed");
    assertRealDir("G1 legacy worktree", legacyWorktreeRow.path);
    const curWtStat = lstatSync(legacyWorktreeRow.path, { bigint: true });
    assert.equal(curWtStat.dev, snapshot.worktreeStat.dev, "G1 worktree dev changed");
    assert.equal(curWtStat.ino, snapshot.worktreeStat.ino, "G1 worktree ino changed");

    const dataDir = join(homeDir, "data");
    const dataTree = snapshotTree(dataDir);
    const g1Leaks = [
      ...Object.keys(dataTree.files),
      ...Object.keys(dataTree.symlinks),
      ...dataTree.dirs,
    ].filter((rel) => rel.includes(g1Id) || rel.includes(g1RunId));
    assert.deepEqual(g1Leaks, [], `unexpected G1 entries under data dir while live: ${JSON.stringify(g1Leaks)}`);
    pass("G1 artifacts rows, worktree row/dir unchanged; zero G1 entries under data dir", `wt=${legacyWorktreeRow.id}`);
  });

  await checks.run("Resumed G1 agents received the exact same legacy HARNESS_* env values as before update", async () => {
    await pollUntil(
      () =>
        existsSync(join(fakeDir, "env-g1_orchestrator-resumed.json")) &&
        existsSync(join(fakeDir, "env-g1_worker-resumed.json")),
      10_000,
      "resumed G1 orchestrator and worker HARNESS_* env snapshots",
    );
    for (const role of ["g1_orchestrator", "g1_worker"] as const) {
      const fresh = readRecordedEnv(fakeDir, role, "fresh");
      const resumed = readRecordedEnv(fakeDir, role, "resumed");
      assert.ok(fresh.HARNESS_GOAL_EVIDENCE_DIR, `${role} fresh HARNESS_GOAL_EVIDENCE_DIR missing`);
      assert.equal(resumed.HARNESS_GOAL_ID, fresh.HARNESS_GOAL_ID, `${role} HARNESS_GOAL_ID mismatch`);
      assert.equal(
        resumed.HARNESS_GOAL_EVIDENCE_DIR,
        fresh.HARNESS_GOAL_EVIDENCE_DIR,
        `${role} HARNESS_GOAL_EVIDENCE_DIR changed across update`,
      );
      assert.equal(
        resumed.HARNESS_GOALS_DIR,
        fresh.HARNESS_GOALS_DIR,
        `${role} HARNESS_GOALS_DIR changed across update`,
      );
      assert.equal(
        resumed.HARNESS_ARTIFACTS_DIR,
        fresh.HARNESS_ARTIFACTS_DIR,
        `${role} HARNESS_ARTIFACTS_DIR changed across update`,
      );
    }
    pass("Resumed g1_orchestrator and g1_worker saw identical legacy HARNESS_* env values", `evidenceDir=${g1EvidenceDir}`);
  });
}

export interface MigratedAfterSettleContext {
  checks: CheckCollector;
  root: string;
  homeDir: string;
  canonicalRepoDir: string;
  socketPath: string;
  dbPath: string;
  launcherPath: string;
  daemonLogPath: string;
  layoutEnv: Record<string, string>;
  storage: StoragePaths;
  g1Id: string;
  g1ChatId: string;
  g1RunId: string;
  g1EvidenceDir: string;
  legacyWorktreeRow: WorktreeRow;
  snapshot: LegacySnapshot;
  extraDaemonPids: number[];
  migrationTimings: MigrationStartTiming[];
  currentDaemonPid: () => number;
  setCurrentDaemonPid: (pid: number) => void;
}

export async function assertMigratedAfterSettle(ctx: MigratedAfterSettleContext): Promise<void> {
  const {
    checks,
    root,
    homeDir,
    canonicalRepoDir,
    socketPath,
    dbPath,
    launcherPath,
    daemonLogPath,
    layoutEnv,
    storage,
    g1Id,
    g1ChatId,
    g1RunId,
    g1EvidenceDir,
    legacyWorktreeRow,
    snapshot,
  } = ctx;

  const g1LegacyRunDir = join(canonicalRepoDir, ".harness", "artifacts", g1RunId);
  const g1DestEvidenceDir = storage.unitDataDirDestination({
    kind: "goal",
    repoRoot: canonicalRepoDir,
    id: g1Id,
    chatSessionId: g1ChatId,
  });
  const g1DestRunDir = storage.unitDataDirDestination({
    kind: "run",
    repoRoot: canonicalRepoDir,
    id: g1RunId,
    chatSessionId: g1ChatId,
  });
  assertStrictlyUnderRoot("g1DestEvidenceDir", g1DestEvidenceDir, root);
  assertStrictlyUnderRoot("g1DestRunDir", g1DestRunDir, root);

  // First verify post-update writes by G1 agents landed in the legacy unit before G1 became terminal.
  await checks.run("Post-update writes by G1 worker and orchestrator landed in legacy unit (not data dir)", () => {
    assertRealDir("G1 legacy evidence dir after settle", g1EvidenceDir);
    assertRealDir("G1 legacy run dir after settle", g1LegacyRunDir);
    const postEvPath = join(g1EvidenceDir, "g1-post-update-evidence.txt");
    assert.ok(existsSync(postEvPath), `expected post-update evidence file at ${postEvPath}`);
    const g1Arts = queryArtifacts(dbPath, g1RunId);
    const postDossier = g1Arts.find((a) => basename(a.path) === "g1-post-update-dossier.md");
    assert.ok(postDossier, `expected g1-post-update-dossier.md row in artifacts for ${g1RunId}`);
    assert.ok(
      postDossier.path.startsWith(g1LegacyRunDir + sep),
      `expected post-update dossier in legacy run dir ${g1LegacyRunDir}, got ${postDossier.path}`,
    );
    assert.ok(existsSync(postDossier.path), `post-update dossier missing on disk: ${postDossier.path}`);
    assert.equal(existsSync(g1DestEvidenceDir), false, "G1 dest evidence dir must not exist before terminal restart");
    assert.equal(existsSync(g1DestRunDir), false, "G1 dest run dir must not exist before terminal restart");
    pass("Post-update G1 evidence and dossier landed inside G1 legacy unit", `${basename(postEvPath)}, ${basename(postDossier.path)}`);
  });

  // Snapshot G1 pre-migration files (including post-update files), artifact rows, and settled worktree row.
  const preG1EvidenceHashes = snapshotTree(g1EvidenceDir).files;
  const preG1RunHashes = snapshotTree(g1LegacyRunDir).files;
  const preG1ArtRows = queryArtifacts(dbPath, g1RunId);
  const preRestartWtRow = queryDb(
    dbPath,
    (db) =>
      db
        .prepare("SELECT id, run_id, task_id, path, branch, base_sha, status FROM worktrees WHERE id = ?")
        .get(legacyWorktreeRow.id) as WorktreeRow | null,
  );
  assert.ok(preRestartWtRow, `missing G1 worktree row ${legacyWorktreeRow.id} before migration restart`);

  // Make G1 terminal via real RPC (`goal.accept`), then restart the daemon via installed launcher.
  const accepted = await rpc<{ goal: { status: string } }>(socketPath, "goal.accept", {
    goalId: g1Id,
    reason: "G1 verified after hot-update settle",
    evidencePaths: [
      `.harness/goals/${g1Id}/g1-evidence.txt`,
      `.harness/goals/${g1Id}/g1-post-update-evidence.txt`,
    ],
  });
  assert.equal(accepted.goal.status, "achieved", `expected G1 status achieved after goal.accept, got ${accepted.goal.status}`);
  pass("Accepted G1 via goal.accept RPC (now terminal)", `goal=${g1Id} status=achieved`);

  const pidBeforeRestart = ctx.currentDaemonPid();
  const logOffset = getLogFileSize(daemonLogPath);
  const restartRes = await runCommand(launcherPath, ["daemon", "restart"], {
    cwd: dirname(socketPath),
    env: layoutEnv,
    label: `PI_HARNESS_STORAGE_LAYOUT=data-dir ${launcherPath} daemon restart (migrate settled G1)`,
  });
  assert.equal(restartRes.code, 0, `daemon restart failed with exit ${restartRes.code}`);

  const pingAfter = await waitForPing(socketPath, (p) => typeof p?.pid === "number" && p.pid !== pidBeforeRestart, 15_000);
  const pidAfter = pingAfter.pid as number;
  ctx.extraDaemonPids.push(pidAfter);
  ctx.setCurrentDaemonPid(pidAfter);
  pass("Restarted daemon via installed launcher", `pid ${pidBeforeRestart} -> ${pidAfter}`);

  await checks.run("Daemon log recorded G1 migration pass with errors=0", () => {
    const parsed = parseMigrationLogSection(daemonLogPath, logOffset);
    assert.equal(parsed.failureLines.length, 0, `unexpected migration failure lines: ${parsed.failureLines.join("; ")}`);
    assert.equal(parsed.summaryLines.length, 1, `expected 1 migration summary line, got ${parsed.summaryLines.length}`);
    assert.equal(parsed.summaryLines[0]!.errors, 0, `expected errors=0: ${parsed.summaryLines[0]!.raw}`);
    assert.ok(parsed.summaryLines[0]!.moved >= 1, `expected moved>=1 for G1: ${parsed.summaryLines[0]!.raw}`);
    ctx.migrationTimings.push({
      label: "Phase 7 G1-settled restart",
      pid: pidAfter,
      summary: parsed.summaryLines[0]!,
      failureCount: parsed.failureLines.length,
    });
    pass("G1 migration log line verified", parsed.summaryLines[0]!.raw);
  });

  await checks.run("Both halves of G1 migrated with identical hashes (including post-update files), rewritten rows, and bridges", () => {
    assertRealDir("g1DestEvidenceDir", g1DestEvidenceDir);
    assertRealDir("g1DestRunDir", g1DestRunDir);
    assertDirHashMapEquals("G1 migrated evidence dir", g1DestEvidenceDir, preG1EvidenceHashes);
    assertDirHashMapEquals("G1 migrated run artifacts dir", g1DestRunDir, preG1RunHashes);
    assert.ok(
      "g1-post-update-evidence.txt" in preG1EvidenceHashes,
      "expected g1-post-update-evidence.txt in migrated G1 evidence",
    );

    const postG1Arts = queryArtifacts(dbPath, g1RunId);
    assert.equal(postG1Arts.length, preG1ArtRows.length, "G1 artifacts row count changed after migration");
    for (const pre of preG1ArtRows) {
      const post = postG1Arts.find((r) => r.id === pre.id);
      assert.ok(post, `missing rewritten G1 artifact row ${pre.id}`);
      const sub = relative(g1LegacyRunDir, pre.path);
      assert.equal(post.path, join(g1DestRunDir, sub), `G1 artifact ${pre.id} path not rewritten`);
      assert.ok(existsSync(post.path), `G1 rewritten artifact missing on disk: ${post.path}`);
    }

    assertBridgeSymlink("G1 evidence bridge", g1EvidenceDir, g1DestEvidenceDir);
    assertBridgeSymlink("G1 run artifacts bridge", g1LegacyRunDir, g1DestRunDir);
    pass(
      "G1 migrated cleanly after settle (pre- and post-update files, rows rewritten, bridges in place)",
      `files=${Object.keys(preG1EvidenceHashes).length + Object.keys(preG1RunHashes).length} rows=${postG1Arts.length}`,
    );
  });

  await checks.run("G1 legacy worktree never moved by migration, .harness exists, .gitignore & tracked git status unchanged", () => {
    const curWtRow = queryDb(
      dbPath,
      (db) =>
        db
          .prepare("SELECT id, run_id, task_id, path, branch, base_sha, status FROM worktrees WHERE id = ?")
          .get(legacyWorktreeRow.id) as WorktreeRow | null,
    );
    assert.ok(curWtRow, `G1 legacy worktree row ${legacyWorktreeRow.id} disappeared after migration`);
    // Migration never moves worktrees or rewrites their row identity/paths; startup sweep may retire the completed worktree to 'archived'.
    assert.equal(curWtRow.id, preRestartWtRow.id);
    assert.equal(curWtRow.run_id, preRestartWtRow.run_id);
    assert.equal(curWtRow.task_id, preRestartWtRow.task_id);
    assert.equal(curWtRow.path, legacyWorktreeRow.path, "G1 legacy worktree path changed");
    assert.equal(curWtRow.branch, legacyWorktreeRow.branch, "G1 legacy worktree branch changed");
    assert.equal(curWtRow.base_sha, legacyWorktreeRow.base_sha, "G1 legacy worktree base_sha changed");
    assert.ok(
      curWtRow.status === preRestartWtRow.status || curWtRow.status === "archived",
      `unexpected G1 worktree status transition: ${preRestartWtRow.status} -> ${curWtRow.status}`,
    );

    // Ensure migration never copied or moved G1's worktree into the data dir.
    const dataTree = snapshotTree(join(homeDir, "data"));
    const movedWt = [...Object.keys(dataTree.files), ...dataTree.dirs].filter(
      (rel) => rel.includes("worktrees") && rel.includes(g1RunId),
    );
    assert.deepEqual(movedWt, [], `G1 worktree unexpectedly appeared under data dir: ${JSON.stringify(movedWt)}`);

    if (curWtRow.status === "active") {
      assertRealDir("G1 legacy worktree", legacyWorktreeRow.path);
      const curWtStat = lstatSync(legacyWorktreeRow.path, { bigint: true });
      assert.equal(curWtStat.dev, snapshot.worktreeStat.dev, "G1 worktree dev changed");
      assert.equal(curWtStat.ino, snapshot.worktreeStat.ino, "G1 worktree ino changed");
      assertRealDir(".harness/worktrees", join(canonicalRepoDir, ".harness", "worktrees"));
    } else {
      // Startup sweep retired the completed legacy worktree via managedWorktreeRoots.
      assert.equal(existsSync(legacyWorktreeRow.path), false, "archived worktree checkout still on disk");
    }

    assertRealDir(".harness", join(canonicalRepoDir, ".harness"));
    if (existsSync(join(canonicalRepoDir, ".harness", "worktrees"))) {
      assertRealDir(".harness/worktrees", join(canonicalRepoDir, ".harness", "worktrees"));
    }

    const curGitignore = snapshotGitignoreBytes(canonicalRepoDir);
    assert.deepEqual(curGitignore, snapshot.gitignoreBytes, ".gitignore files changed during migration");
    assertNoModifiedTrackedFiles(canonicalRepoDir, "after G1 settle migration");
    pass(
      "G1 legacy worktree row/path untouched by migration (.harness, .gitignore, and tracked git status intact)",
      `wt=${curWtRow.id} status=${curWtRow.status} path=${curWtRow.path}`,
    );
  });
}

export interface CrashResumeContext {
  checks: CheckCollector;
  root: string;
  canonicalRepoDir: string;
  socketPath: string;
  dbPath: string;
  launcherPath: string;
  daemonLogPath: string;
  layoutEnv: Record<string, string>;
  storage: StoragePaths;
  crash1: SeededGoalInfo;
  crash2: SeededGoalInfo;
  extraDaemonPids: number[];
  migrationTimings: MigrationStartTiming[];
  currentDaemonPid: () => number;
  setCurrentDaemonPid: (pid: number) => void;
}

export async function assertCrashResume(ctx: CrashResumeContext): Promise<void> {
  const {
    checks,
    root,
    canonicalRepoDir,
    socketPath,
    dbPath,
    launcherPath,
    daemonLogPath,
    layoutEnv,
    storage,
    crash1,
    crash2,
  } = ctx;

  // Make both crash-test goals terminal while their legacy dirs are still intact.
  for (const [label, g] of [
    ["G_CRASH1", crash1],
    ["G_CRASH2", crash2],
  ] as const) {
    const acc = await rpc<{ goal: { status: string } }>(socketPath, "goal.accept", {
      goalId: g.goalId,
      reason: `${label} terminal for crash-resume test`,
      evidencePaths: [`.harness/goals/${g.goalId}/${basename(g.evidenceFile)}`],
    });
    assert.equal(acc.goal.status, "achieved", `expected ${label} achieved`);
  }

  const c1LegacyRunDir = join(canonicalRepoDir, ".harness", "artifacts", crash1.runId);
  const c2LegacyRunDir = join(canonicalRepoDir, ".harness", "artifacts", crash2.runId);
  const c1DestEvDir = storage.unitDataDirDestination({
    kind: "goal",
    repoRoot: canonicalRepoDir,
    id: crash1.goalId,
    chatSessionId: crash1.chatSessionId,
  });
  const c1DestRunDir = storage.unitDataDirDestination({
    kind: "run",
    repoRoot: canonicalRepoDir,
    id: crash1.runId,
    chatSessionId: crash1.chatSessionId,
  });
  const c2DestEvDir = storage.unitDataDirDestination({
    kind: "goal",
    repoRoot: canonicalRepoDir,
    id: crash2.goalId,
    chatSessionId: crash2.chatSessionId,
  });
  const c2DestRunDir = storage.unitDataDirDestination({
    kind: "run",
    repoRoot: canonicalRepoDir,
    id: crash2.runId,
    chatSessionId: crash2.chatSessionId,
  });
  assertStrictlyUnderRoot("c1DestEvDir", c1DestEvDir, root);
  assertStrictlyUnderRoot("c1DestRunDir", c1DestRunDir, root);
  assertStrictlyUnderRoot("c2DestEvDir", c2DestEvDir, root);
  assertStrictlyUnderRoot("c2DestRunDir", c2DestRunDir, root);

  const c1PreEvHashes = snapshotTree(crash1.evidenceDir).files;
  const c1PreRunHashes = snapshotTree(c1LegacyRunDir).files;
  const c1PreRows = queryArtifacts(dbPath, crash1.runId);
  const c2PreRows = queryArtifacts(dbPath, crash2.runId);

  // Stop the daemon cleanly before staging crash states on disk.
  const pidBeforeStop = ctx.currentDaemonPid();
  const stopRes = await runCommand(launcherPath, ["daemon", "stop"], {
    cwd: dirname(socketPath),
    env: layoutEnv,
    label: `${launcherPath} daemon stop (stage crash-resume states)`,
  });
  assert.equal(stopRes.code, 0, `daemon stop failed with exit ${stopRes.code}`);
  await pollUntil(() => !isPidAlive(pidBeforeStop), 10_000, `daemon pid ${pidBeforeStop} exited`);

  // Crash state 1 (after rename, before row rewrite, no bridge):
  // Move G_CRASH1's run artifacts dir by hand to its data-dir destination while rows still name legacy path.
  assert.ok(c1PreRows.every((r) => r.path.startsWith(c1LegacyRunDir + sep)), "G_CRASH1 rows must still be legacy");
  mkdirSync(dirname(c1DestRunDir), { recursive: true });
  renameSync(c1LegacyRunDir, c1DestRunDir);
  assert.equal(existsSync(c1LegacyRunDir), false, "G_CRASH1 legacy run dir should be absent after simulated post-rename crash");
  assertRealDir("c1DestRunDir (staged crash 1)", c1DestRunDir);

  // Crash state 2 (after copy, both real legacy dir and real destination exist, with one file only in legacy):
  mkdirSync(dirname(c2DestEvDir), { recursive: true });
  mkdirSync(dirname(c2DestRunDir), { recursive: true });
  cpSync(crash2.evidenceDir, c2DestEvDir, { recursive: true });
  cpSync(c2LegacyRunDir, c2DestRunDir, { recursive: true });
  const c2LegacyOnlyEv = join(crash2.evidenceDir, "legacy-only-evidence.txt");
  const c2LegacyOnlyDossier = join(c2LegacyRunDir, crash2.orchId, "legacy-only-note.md");
  writeFileSync(c2LegacyOnlyEv, `Only in legacy evidence for ${crash2.goalId}\n`, "utf8");
  writeFileSync(c2LegacyOnlyDossier, `# Only in legacy run dir for ${crash2.runId}\n`, "utf8");
  const c2ExpectedEvHashes = snapshotTree(crash2.evidenceDir).files;
  const c2ExpectedRunHashes = snapshotTree(c2LegacyRunDir).files;
  pass(
    "Staged crash-resume states while daemon stopped",
    `crash1(post-rename)=${crash1.goalId}/${crash1.runId} crash2(post-copy+legacy-only)=${crash2.goalId}/${crash2.runId}`,
  );

  // Start daemon again and wait for health check.
  const logOffset = getLogFileSize(daemonLogPath);
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
  const pingResumed = await waitForPing(socketPath, (p) => typeof p?.pid === "number" && p.pid > 0, 15_000);
  const pidResumed = pingResumed.pid as number;
  ctx.extraDaemonPids.push(pidResumed);
  ctx.setCurrentDaemonPid(pidResumed);
  pass("Restarted daemon for crash-resume convergence", `pid=${pidResumed}`);

  await checks.run("Daemon log recorded crash-resume migration pass with errors=0", () => {
    const parsed = parseMigrationLogSection(daemonLogPath, logOffset);
    assert.equal(parsed.failureLines.length, 0, `unexpected migration failure lines: ${parsed.failureLines.join("; ")}`);
    assert.equal(parsed.summaryLines.length, 1, `expected 1 migration summary line, got ${parsed.summaryLines.length}`);
    assert.equal(parsed.summaryLines[0]!.errors, 0, `expected errors=0: ${parsed.summaryLines[0]!.raw}`);
    ctx.migrationTimings.push({
      label: "Phase 7 crash-resume start",
      pid: pidResumed,
      summary: parsed.summaryLines[0]!,
      failureCount: parsed.failureLines.length,
    });
    pass("Crash-resume migration log line verified", parsed.summaryLines[0]!.raw);
  });

  await checks.run("Crash 1 (post-rename, pre-row-rewrite) converged: files at dest, rows rewritten, bridges in place", () => {
    assertRealDir("c1DestEvDir", c1DestEvDir);
    assertRealDir("c1DestRunDir", c1DestRunDir);
    assertDirHashMapEquals("Crash 1 evidence dir", c1DestEvDir, c1PreEvHashes);
    assertDirHashMapEquals("Crash 1 run dir", c1DestRunDir, c1PreRunHashes);
    assertBridgeSymlink("Crash 1 evidence bridge", crash1.evidenceDir, c1DestEvDir);
    assertBridgeSymlink("Crash 1 run bridge", c1LegacyRunDir, c1DestRunDir);
    const postRows = queryArtifacts(dbPath, crash1.runId);
    assert.equal(postRows.length, c1PreRows.length);
    for (const pre of c1PreRows) {
      const post = postRows.find((r) => r.id === pre.id);
      assert.ok(post);
      assert.equal(post.path, join(c1DestRunDir, relative(c1LegacyRunDir, pre.path)));
    }
    pass("Crash 1 (after rename, before row rewrite) converged cleanly", `${crash1.goalId} / ${crash1.runId}`);
  });

  await checks.run("Crash 2 (post-copy with legacy-only files) converged: all files at dest, nothing lost, rows rewritten, bridges in place", () => {
    assertRealDir("c2DestEvDir", c2DestEvDir);
    assertRealDir("c2DestRunDir", c2DestRunDir);
    assertDirHashMapEquals("Crash 2 evidence dir", c2DestEvDir, c2ExpectedEvHashes);
    assertDirHashMapEquals("Crash 2 run dir", c2DestRunDir, c2ExpectedRunHashes);
    assert.ok(existsSync(join(c2DestEvDir, "legacy-only-evidence.txt")), "legacy-only-evidence.txt lost during merge");
    assert.ok(
      existsSync(join(c2DestRunDir, crash2.orchId, "legacy-only-note.md")),
      "legacy-only-note.md lost during merge",
    );
    assertBridgeSymlink("Crash 2 evidence bridge", crash2.evidenceDir, c2DestEvDir);
    assertBridgeSymlink("Crash 2 run bridge", c2LegacyRunDir, c2DestRunDir);
    const postRows = queryArtifacts(dbPath, crash2.runId);
    assert.equal(postRows.length, c2PreRows.length);
    for (const pre of c2PreRows) {
      const post = postRows.find((r) => r.id === pre.id);
      assert.ok(post);
      assert.equal(post.path, join(c2DestRunDir, relative(c2LegacyRunDir, pre.path)));
    }
    pass("Crash 2 (both-exist post-copy merge) converged cleanly with zero lost files", `${crash2.goalId} / ${crash2.runId}`);
  });
}

export interface IdempotentRerunContext {
  checks: CheckCollector;
  homeDir: string;
  canonicalRepoDir: string;
  socketPath: string;
  dbPath: string;
  launcherPath: string;
  daemonLogPath: string;
  layoutEnv: Record<string, string>;
  extraDaemonPids: number[];
  migrationTimings: MigrationStartTiming[];
  currentDaemonPid: () => number;
  setCurrentDaemonPid: (pid: number) => void;
}

export async function assertIdempotentRerun(ctx: IdempotentRerunContext): Promise<void> {
  const { checks, homeDir, canonicalRepoDir, socketPath, dbPath, launcherPath, daemonLogPath, layoutEnv } = ctx;
  const dataDir = join(homeDir, "data");
  const legacyRoot = join(canonicalRepoDir, ".harness");

  const captureState = () => ({
    data: snapshotTree(dataDir),
    legacy: snapshotTree(legacyRoot, { excludeTopLevel: ["worktrees"] }),
    artifacts: queryArtifacts(dbPath),
  });

  const beforeRestart = captureState();
  const pidBefore = ctx.currentDaemonPid();
  const logOffset = getLogFileSize(daemonLogPath);

  const restartRes = await runCommand(launcherPath, ["daemon", "restart"], {
    cwd: dirname(socketPath),
    env: layoutEnv,
    label: `PI_HARNESS_STORAGE_LAYOUT=data-dir ${launcherPath} daemon restart (idempotency check)`,
  });
  assert.equal(restartRes.code, 0, `idempotent daemon restart failed with exit ${restartRes.code}`);

  const pingAfter = await waitForPing(socketPath, (p) => typeof p?.pid === "number" && p.pid !== pidBefore, 15_000);
  const pidAfter = pingAfter.pid as number;
  ctx.extraDaemonPids.push(pidAfter);
  ctx.setCurrentDaemonPid(pidAfter);

  const parsed = parseMigrationLogSection(daemonLogPath, logOffset);
  ctx.migrationTimings.push({
    label: "Phase 7 idempotent restart",
    pid: pidAfter,
    summary: parsed.summaryLines[0] ?? null,
    failureCount: parsed.failureLines.length,
  });

  await checks.run("Idempotent daemon restart leaves data dir, legacy root, bridges, and artifacts rows identical", () => {
    assert.equal(parsed.failureLines.length, 0, `unexpected migration failure lines: ${parsed.failureLines.join("; ")}`);
    for (const s of parsed.summaryLines) {
      assert.equal(s.errors, 0);
      assert.equal(s.moved, 0);
      assert.equal(s.rowsRewritten, 0);
    }
    const afterRestart = captureState();
    assert.deepEqual(afterRestart.data, beforeRestart.data, "data dir changed on idempotent restart");
    assert.deepEqual(afterRestart.legacy, beforeRestart.legacy, "legacy root/bridges changed on idempotent restart");
    assert.deepEqual(afterRestart.artifacts, beforeRestart.artifacts, "artifacts rows changed on idempotent restart");
    pass(
      "Idempotent restart left data dir, legacy root, bridges, and artifacts rows identical",
      `dataFiles=${Object.keys(afterRestart.data.files).length} bridges=${Object.keys(afterRestart.legacy.symlinks).length}`,
    );
  });

  await checks.run("migrate-storage --dry-run exits 0, lists no unit to migrate/merge, and changes nothing", async () => {
    const beforeDry = captureState();
    const dryText = await runCommand(launcherPath, ["migrate-storage", "--dry-run"], {
      cwd: canonicalRepoDir,
      env: layoutEnv,
      label: `PI_HARNESS_STORAGE_LAYOUT=data-dir ${launcherPath} migrate-storage --dry-run`,
    });
    assert.equal(dryText.code, 0, `migrate-storage --dry-run exited ${dryText.code}`);

    const dryJson = await runCommand(launcherPath, ["migrate-storage", "--dry-run", "--json"], {
      cwd: canonicalRepoDir,
      env: layoutEnv,
      label: `PI_HARNESS_STORAGE_LAYOUT=data-dir ${launcherPath} migrate-storage --dry-run --json`,
    });
    assert.equal(dryJson.code, 0, `migrate-storage --dry-run --json exited ${dryJson.code}`);
    const plan = JSON.parse(dryJson.stdout) as {
      layout?: string;
      totals?: {
        migrate?: number;
        merge?: number;
        finishMigration?: number;
        rewriteRows?: number;
        removeBridge?: number;
        deferred?: number;
        pendingRowRewrites?: number;
      };
    };
    assert.equal(plan.layout, "data-dir", `expected plan.layout=data-dir, got ${plan.layout}`);
    assert.equal(plan.totals?.migrate, 0, `expected migrate=0, got ${JSON.stringify(plan.totals)}`);
    assert.equal(plan.totals?.merge, 0, `expected merge=0, got ${JSON.stringify(plan.totals)}`);
    assert.equal(plan.totals?.finishMigration, 0, `expected finishMigration=0, got ${JSON.stringify(plan.totals)}`);
    assert.equal(plan.totals?.rewriteRows, 0, `expected rewriteRows=0, got ${JSON.stringify(plan.totals)}`);
    assert.equal(plan.totals?.deferred, 0, `expected deferred=0, got ${JSON.stringify(plan.totals)}`);
    assert.equal(plan.totals?.pendingRowRewrites, 0, `expected pendingRowRewrites=0, got ${JSON.stringify(plan.totals)}`);

    const afterDry = captureState();
    assert.deepEqual(afterDry.data, beforeDry.data, "dry-run mutated data dir");
    assert.deepEqual(afterDry.legacy, beforeDry.legacy, "dry-run mutated legacy root");
    assert.deepEqual(afterDry.artifacts, beforeDry.artifacts, "dry-run mutated artifacts rows");
    pass("migrate-storage --dry-run exited 0 with 0 units to migrate/merge and changed nothing");
  });

  await checks.run("migrate-storage without --dry-run refuses while daemon runs (non-zero exit) and changes nothing", async () => {
    const beforeLive = captureState();
    const liveRes = await runCommand(launcherPath, ["migrate-storage"], {
      cwd: canonicalRepoDir,
      env: layoutEnv,
      label: `PI_HARNESS_STORAGE_LAYOUT=data-dir ${launcherPath} migrate-storage (while daemon running)`,
    });
    assert.notEqual(liveRes.code, 0, "expected migrate-storage without --dry-run to exit non-zero while daemon runs");
    assert.ok(
      liveRes.stderr.includes("harnessd is running") || liveRes.stderr.includes("daemon restart"),
      `expected daemon-running refusal in stderr, got: ${liveRes.stderr}`,
    );
    const afterLive = captureState();
    assert.deepEqual(afterLive.data, beforeLive.data, "refused migrate-storage mutated data dir");
    assert.deepEqual(afterLive.legacy, beforeLive.legacy, "refused migrate-storage mutated legacy root");
    assert.deepEqual(afterLive.artifacts, beforeLive.artifacts, "refused migrate-storage mutated artifacts rows");
    pass("migrate-storage refused while daemon runs and changed nothing", `exit=${liveRes.code}`);
  });
}

async function seedCompletedGoalViaRpc(opts: {
  socketPath: string;
  canonicalRepoDir: string;
  chatTitle: string;
  goalTitle: string;
  goalDescription: string;
  dossierName: string;
  evidenceFilename: string;
  evidenceContent: string;
  accept: boolean;
  expectLegacyPaths: boolean;
}): Promise<SeededGoalInfo> {
  const chat = await rpc<{ session: { id: string } }>(opts.socketPath, "chat.create", {
    repoRoot: opts.canonicalRepoDir,
    headless: true,
    title: opts.chatTitle,
  });
  const goal = await rpc<{ id: string }>(opts.socketPath, "goal.create", {
    repoRoot: opts.canonicalRepoDir,
    chatSessionId: chat.session.id,
    title: `FAKE_ROLE=g0_orchestrator FAKE_DOSSIER=${opts.dossierName} ${opts.goalTitle}`,
    description: opts.goalDescription,
    criteria: [{ kind: "behavioral", description: `${opts.dossierName} written` }],
    verificationMode: "none",
  });
  const committed = await rpc<{ id: string; linkedRunId: string | null }>(opts.socketPath, "goal.commit", {
    goalId: goal.id,
  });
  assert.ok(committed.linkedRunId, `expected commit for ${goal.id} to create linkedRunId`);
  const runId = committed.linkedRunId;

  await pollUntil(
    async () => {
      const r = await rpc<{ run: { status: string } }>(opts.socketPath, "run.get", { runId });
      return r.run.status === "completed";
    },
    20_000,
    `${opts.chatTitle} linked run completed`,
  );

  const runGet = await rpc<{ tasks: Array<{ id: string; tier: number }> }>(opts.socketPath, "run.get", { runId });
  const orch = runGet.tasks.find((t) => t.tier === 1);
  assert.ok(orch, `missing Tier 1 orchestrator for ${runId}`);

  const arts = await rpc<Array<{ id: string; path: string; taskId: string }>>(opts.socketPath, "artifact.list", {
    runId,
  });
  assert.ok(arts.length >= 1, `expected >=1 artifacts row for ${runId}`);
  const artifactPath = arts[0]!.path;
  if (opts.expectLegacyPaths) {
    assert.ok(
      artifactPath.startsWith(join(opts.canonicalRepoDir, ".harness", "artifacts", runId) + sep),
      `expected legacy artifact under .harness/artifacts/${runId}/, got ${artifactPath}`,
    );
  }
  assert.ok(existsSync(artifactPath), `artifact missing on disk: ${artifactPath}`);
  const artifactContent = readFileSync(artifactPath, "utf8");

  const evidenceDir = join(opts.canonicalRepoDir, ".harness", "goals", goal.id);
  assertRealDir(`${opts.chatTitle} evidence dir`, evidenceDir);
  const evidenceFile = join(evidenceDir, opts.evidenceFilename);
  writeFileSync(evidenceFile, opts.evidenceContent, "utf8");

  if (opts.accept) {
    const accepted = await rpc<{ goal: { status: string } }>(opts.socketPath, "goal.accept", {
      goalId: goal.id,
      reason: `${opts.chatTitle} accepted`,
      evidencePaths: [`.harness/goals/${goal.id}/${opts.evidenceFilename}`],
    });
    assert.equal(accepted.goal.status, "achieved", `expected ${goal.id} status achieved`);
  }

  return {
    goalId: goal.id,
    chatSessionId: chat.session.id,
    runId,
    orchId: orch.id,
    evidenceDir,
    evidenceFile,
    evidenceContent: opts.evidenceContent,
    artifactPath,
    artifactContent,
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const { layout, prevFlag, keepTemp } = parseCliArgs(process.argv.slice(2));
  const isDataDir = layout === "data-dir";

  const root = realpathSync(mkdtempSync(join(tmpdir(), "su-check-")));
  const homeDir = join(root, "home");
  const installDir = join(root, "install");
  const binDir = join(root, "bin");
  const fakeDir = join(root, "fake");
  const repoDir = join(root, "repo");
  const checkoutPrevDir = join(root, "checkout-prev");
  const socketPath = join(root, "d.sock");
  const dbPath = join(homeDir, "control-plane.sqlite");
  const daemonLogPath = join(dirname(socketPath), "daemon.log");

  const extraDaemonPids: number[] = [];
  const migrationTimings: MigrationStartTiming[] = [];
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

  const phases: PhaseResult[] = isDataDir
    ? [
        { id: 1, name: "Sandbox", status: "SKIP", durationMs: 0 },
        { id: 2, name: "Previous release", status: "SKIP", durationMs: 0 },
        { id: 3, name: "Legacy state", status: "SKIP", durationMs: 0 },
        { id: 4, name: "Update", status: "SKIP", durationMs: 0 },
        { id: 5, name: "Resume", status: "SKIP", durationMs: 0 },
        { id: 6, name: "Data (data-dir)", status: "SKIP", durationMs: 0 },
        { id: 7, name: "Settle, crash-resume & idempotency", status: "SKIP", durationMs: 0 },
        { id: 8, name: "New data (data-dir)", status: "SKIP", durationMs: 0 },
        { id: 9, name: "Fallback round trip", status: "SKIP", durationMs: 0 },
        { id: 10, name: "Cleanup", status: "SKIP", durationMs: 0 },
      ]
    : [
        { id: 1, name: "Sandbox", status: "SKIP", durationMs: 0 },
        { id: 2, name: "Previous release", status: "SKIP", durationMs: 0 },
        { id: 3, name: "Legacy state", status: "SKIP", durationMs: 0 },
        { id: 4, name: "Update", status: "SKIP", durationMs: 0 },
        { id: 5, name: "Resume", status: "SKIP", durationMs: 0 },
        { id: 6, name: "Data (legacy)", status: "SKIP", durationMs: 0 },
        { id: 7, name: "Settle", status: "SKIP", durationMs: 0 },
        { id: 8, name: "Previous release rollback", status: "SKIP", durationMs: 0 },
        { id: 9, name: "Cleanup", status: "SKIP", durationMs: 0 },
      ];

  const allSoftFailures: Array<{ phaseId: number; phaseName: string; label: string; error: string }> = [];

  const runPhase = async <T>(id: number, fn: (checks: CheckCollector) => Promise<T>): Promise<T> => {
    const entry = phases.find((p) => p.id === id)!;
    const t0 = Date.now();
    const checks = new CheckCollector();
    console.log(`\n=== Phase ${entry.id}: ${entry.name} ===`);
    try {
      const res = await fn(checks);
      entry.durationMs = Date.now() - t0;
      if (checks.failures.length > 0) {
        entry.status = "FAIL";
        entry.detail = checks.failures.map((f) => `${f.label}: ${f.error}`).join(" | ");
        for (const f of checks.failures) {
          allSoftFailures.push({ phaseId: entry.id, phaseName: entry.name, ...f });
        }
      } else {
        entry.status = "PASS";
      }
      return res;
    } catch (err) {
      entry.status = "FAIL";
      entry.durationMs = Date.now() - t0;
      entry.detail = err instanceof Error ? err.message : String(err);
      for (const f of checks.failures) {
        allSoftFailures.push({ phaseId: entry.id, phaseName: entry.name, ...f });
      }
      throw err;
    }
  };

  console.log("=== Goal-39 Storage Upgrade E2E Check ===");
  console.log(`timestamp: ${new Date().toISOString()}`);
  console.log(`checkout:  ${REPO_ROOT}`);
  console.log(`layout:    ${layout}`);
  if (prevFlag) console.log(`prev flag: ${prevFlag}`);
  console.log(`temp root: ${root}${keepTemp ? " (keep)" : ""}`);

  const baseEnv: Record<string, string> = {
    PI_HARNESS_HOME: homeDir,
    PI_HARNESS_INSTALL_DIR: installDir,
    PI_HARNESS_BIN_DIR: binDir,
    XDG_RUNTIME_DIR: root,
  };
  // Set PI_HARNESS_STORAGE_LAYOUT explicitly in both modes so results are identical before and after the default flips.
  const layoutEnv: Record<string, string> = {
    ...baseEnv,
    PI_HARNESS_STORAGE_LAYOUT: layout,
  };

  let relPrev = "";
  let pidPrev = 0;
  let relNew = "";
  let pidNew = 0;
  let currentDaemonPid = 0;
  let canonicalRepoDir = "";
  let launcherPath = "";
  let logOffsetBeforeUpdate = 0;

  let dataDirStorage!: StoragePaths;
  let g0!: SeededGoalInfo;
  let g0NewArtifactPath = "";
  let gCrash1: SeededGoalInfo | null = null;
  let gCrash2: SeededGoalInfo | null = null;

  let g1Id = "";
  let g1ChatId = "";
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

  let gNewId = "";
  let gNewRunId = "";

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

      dataDirStorage = storagePaths({ stateDir: homeDir }, { layout: "data-dir" });
      assertStrictlyUnderRoot("storage dataRoot", dataDirStorage.dataRoot!, root);

      pass("Sandbox initialized with isolated config, temp repo on main, and fake agent", `repo=${canonicalRepoDir}`);
    });

    // -----------------------------------------------------------------------
    // Phase 2: Previous release
    // -----------------------------------------------------------------------
    await runPhase(2, async () => {
      const prev = resolvePrevRef(REPO_ROOT, prevFlag);
      console.log(
        `resolved PREV ref: ${prev.ref} (${prev.sha.slice(0, 12)}) via rule=${prev.rule} hasStorageModule=${prev.hasStorageModule}`,
      );
      pass(
        "Resolved PREV ref",
        `rule=${prev.rule} ref=${prev.ref} sha=${prev.sha.slice(0, 12)} hasStorageModule=${prev.hasStorageModule}`,
      );

      materializeRefWithGitArchive(REPO_ROOT, prev.ref, checkoutPrevDir);

      // In data-dir mode when PREV itself contains src/storage/paths.ts (Config b: PREV=HEAD in legacy, NEW=HEAD in data-dir):
      // daemon.reload RPC spawns the supervisor from PREV's process.env rather than install.sh's env, so PREV must carry
      // PI_HARNESS_STORAGE_LAYOUT=data-dir for NEW to inherit it on handover while PREV itself behaves as pre-flip legacy
      // (both on initial start and on rollback). Pin only the disposable temp copy under checkoutPrevDir (never REPO_ROOT).
      if (isDataDir && prev.hasStorageModule) {
        const pinned = pinCheckoutPrevToLegacyLayout(checkoutPrevDir, root);
        assert.equal(pinned, true, "expected temp checkout-prev/src/storage/paths.ts to be pinned to legacy");
        console.log(
          "pinned disposable checkout-prev/src/storage/paths.ts to legacy layout (simulating pre-flip binary while preserving PI_HARNESS_STORAGE_LAYOUT=data-dir across daemon.reload supervisor handover)",
        );
      }

      const prevHash = computeInstallReleaseId(checkoutPrevDir);
      const curHash = computeInstallReleaseId(REPO_ROOT);
      if (prevHash === curHash) {
        const prevReleaseTs = join(checkoutPrevDir, "src", "daemon", "release.ts");
        assertStrictlyUnderRoot("checkoutPrevDir/src/daemon/release.ts", prevReleaseTs, root);
        appendFileSync(prevReleaseTs, "\n// storage-upgrade-check prev-release marker (identical HEAD fallback)\n", "utf8");
        console.log(
          `checkout-prev matched REPO_ROOT hash (${prevHash}); tagged checkout-prev/src/daemon/release.ts so relPrev != relNew`,
        );
      }

      const installPrev = await runCommand("sh", ["install.sh"], {
        cwd: checkoutPrevDir,
        env: { ...baseEnv, PI_HARNESS_STORAGE_LAYOUT: "legacy" },
        label: `PI_HARNESS_STORAGE_LAYOUT=legacy sh install.sh (PREV ${prev.ref})`,
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

      launcherPath = join(binDir, "pi-harness");
      assert.ok(existsSync(launcherPath), `expected launcher at ${launcherPath}`);
      console.log(
        `\n$ PI_HARNESS_STORAGE_LAYOUT=${layout} ${launcherPath} daemon serve (detached -> ${daemonLogPath})`,
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
      currentDaemonPid = pidPrev;
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
      // --- G0: terminal goal before update ---
      g0 = await seedCompletedGoalViaRpc({
        socketPath,
        canonicalRepoDir,
        chatTitle: "storage-upgrade-g0",
        goalTitle: "G0 terminal pre-upgrade goal",
        goalDescription: "Terminal goal with evidence file and indexed dossier created before storage upgrade.",
        dossierName: "g0-dossier.md",
        evidenceFilename: "g0-evidence.txt",
        evidenceContent: "G0 terminal evidence seeded before storage upgrade.\n",
        accept: true,
        expectLegacyPaths: true,
      });
      const g0Read = await rpc<{ content?: string }>(socketPath, "artifact.read", {
        runId: g0.runId,
        path: g0.artifactPath,
      });
      assert.equal(g0Read.content, g0.artifactContent, "G0 artifact.read content mismatch before update");
      pass(
        "Created terminal goal G0 with evidence file and dossier artifact",
        `goal=${g0.goalId} chat=${g0.chatSessionId} run=${g0.runId} status=achieved artifact=${basename(g0.artifactPath)}`,
      );

      // In data-dir mode, also seed two non-terminal (awaiting_human) goals for Phase 7 crash-resume testing.
      if (isDataDir) {
        gCrash1 = await seedCompletedGoalViaRpc({
          socketPath,
          canonicalRepoDir,
          chatTitle: "storage-upgrade-crash1",
          goalTitle: "G_CRASH1 post-rename crash-resume goal",
          goalDescription: "Non-terminal until Phase 7; used to test crash recovery after rename and before row rewrite.",
          dossierName: "gcrash1-dossier.md",
          evidenceFilename: "gcrash1-evidence.txt",
          evidenceContent: "G_CRASH1 evidence for post-rename crash recovery.\n",
          accept: false,
          expectLegacyPaths: true,
        });
        gCrash2 = await seedCompletedGoalViaRpc({
          socketPath,
          canonicalRepoDir,
          chatTitle: "storage-upgrade-crash2",
          goalTitle: "G_CRASH2 post-copy crash-resume goal",
          goalDescription: "Non-terminal until Phase 7; used to test crash recovery when both legacy and dest exist.",
          dossierName: "gcrash2-dossier.md",
          evidenceFilename: "gcrash2-evidence.txt",
          evidenceContent: "G_CRASH2 evidence for post-copy crash recovery.\n",
          accept: false,
          expectLegacyPaths: true,
        });
        pass(
          "Seeded non-terminal goals G_CRASH1 and G_CRASH2 (awaiting_human) for Phase 7 crash-resume",
          `crash1=${gCrash1.goalId}/${gCrash1.runId} crash2=${gCrash2.goalId}/${gCrash2.runId}`,
        );
      }

      // --- G1: live goal linked to live run (orchestrator + Tier 2 worker with real worktree + timer) ---
      const chat1 = await rpc<{ session: { id: string } }>(socketPath, "chat.create", {
        repoRoot: canonicalRepoDir,
        headless: true,
        title: "storage-upgrade-g1",
      });
      g1ChatId = chat1.session.id;
      const goal1 = await rpc<{ id: string }>(socketPath, "goal.create", {
        repoRoot: canonicalRepoDir,
        chatSessionId: g1ChatId,
        title: "FAKE_ROLE=g1_orchestrator G1 live upgrade goal",
        description: "Live goal whose run, Tier 2 worker worktree, dossier, and timer must survive hot update.",
        criteria: [{ kind: "behavioral", description: "G1 survives hot update and settles cleanly" }],
        verificationMode: "none",
      });
      g1Id = goal1.id;

      g1EvidenceDir = join(canonicalRepoDir, ".harness", "goals", g1Id);
      assertRealDir("G1 evidence dir", g1EvidenceDir);
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

          const arts = queryArtifacts(dbPath, g1RunId);
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

          if (
            !existsSync(join(fakeDir, "env-g1_orchestrator-fresh.json")) ||
            !existsSync(join(fakeDir, "env-g1_worker-fresh.json"))
          ) {
            return null;
          }

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
        "G1 live run with Tier 2 worker, worktree, dossier artifact, pending timer, env snapshots, and live fake PIDs",
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
        `goal=${g1Id} chat=${g1ChatId} run=${g1RunId} orch=${g1OrchId} (gen=${g1OrchGen}) worker=${g1WorkerId} wt=${legacyWorktreeRow.id} timer=${g1TimerId}`,
      );

      // --- Note file ---
      const notesDir = join(canonicalRepoDir, ".harness", "notes");
      mkdirSync(notesDir, { recursive: true });
      notePath = join(notesDir, "upgrade-note.md");
      noteContent = "# Upgrade Note\nLegacy note preserved across storage upgrade.\n";
      writeFileSync(notePath, noteContent, "utf8");
      pass("Seeded legacy note file", notePath);

      // --- Snapshot ---
      const files = snapshotHarnessTree(canonicalRepoDir);
      assert.ok(files.length >= 5, `expected >=5 files under .harness (excl. worktrees), got ${files.length}`);
      const artifacts = queryArtifacts(dbPath);
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
      const gitignoreBytes = snapshotGitignoreBytes(canonicalRepoDir);
      const g1EvSt = lstatSync(g1EvidenceDir, { bigint: true });
      const g1RunSt = lstatSync(join(canonicalRepoDir, ".harness", "artifacts", g1RunId), { bigint: true });
      const wtSt = lstatSync(legacyWorktreeRow.path, { bigint: true });

      snapshot = {
        files,
        artifacts,
        tasks,
        worktrees,
        gitStatusPorcelain,
        gitignoreBytes,
        maxEventSeq,
        g1EvidenceStat: { dev: g1EvSt.dev, ino: g1EvSt.ino },
        g1RunDirStat: { dev: g1RunSt.dev, ino: g1RunSt.ino },
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
      logOffsetBeforeUpdate = getLogFileSize(daemonLogPath);
      const installNew = await runCommand("sh", ["install.sh"], {
        cwd: REPO_ROOT,
        env: { ...layoutEnv, PI_HARNESS_RELOAD_WAIT: "1" },
        label: `PI_HARNESS_RELOAD_WAIT=1 PI_HARNESS_STORAGE_LAYOUT=${layout} sh install.sh (checkout under test)`,
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
      currentDaemonPid = pidNew;
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
    await runPhase(6, async (checks) => {
      if (isDataDir) {
        const g0Migrated = await assertDataDirAfterUpdate({
          checks,
          root,
          homeDir,
          canonicalRepoDir,
          socketPath,
          dbPath,
          daemonLogPath,
          logOffsetBeforeUpdate,
          storage: dataDirStorage,
          g0,
          notePath,
          noteContent,
          snapshot,
          migrationTimings,
          pidNew,
        });
        g0NewArtifactPath = g0Migrated.g0NewArtifactPath;

        await assertInFlightGoalUntouched({
          checks,
          homeDir,
          canonicalRepoDir,
          fakeDir,
          dbPath,
          g1Id,
          g1RunId,
          g1EvidenceDir,
          legacyWorktreeRow,
          snapshot,
        });
        return;
      }

      // Layout 'legacy' assertions:
      for (const f of snapshot.files) {
        assert.ok(existsSync(f.absPath), `snapshot file missing after update: ${f.absPath}`);
        const st = lstatSync(f.absPath);
        assert.equal(st.isSymbolicLink(), false, `snapshot file unexpectedly became symlink: ${f.absPath}`);
        assert.equal(sha256File(f.absPath), f.sha256, `sha256 mismatch for ${f.relPath}`);
      }
      pass("Every snapshot file under .harness exists at the same path with identical sha256", `count=${snapshot.files.length}`);

      const curArtifacts = queryArtifacts(dbPath);
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
    // Phase 7: Settle (+ G1 migration, crash-resume, idempotency in data-dir)
    // -----------------------------------------------------------------------
    await runPhase(7, async (checks) => {
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

      if (isDataDir) {
        await assertMigratedAfterSettle({
          checks,
          root,
          homeDir,
          canonicalRepoDir,
          socketPath,
          dbPath,
          launcherPath,
          daemonLogPath,
          layoutEnv,
          storage: dataDirStorage,
          g1Id,
          g1ChatId,
          g1RunId,
          g1EvidenceDir,
          legacyWorktreeRow,
          snapshot,
          extraDaemonPids,
          migrationTimings,
          currentDaemonPid: () => currentDaemonPid,
          setCurrentDaemonPid: (pid) => {
            currentDaemonPid = pid;
          },
        });

        await assertCrashResume({
          checks,
          root,
          canonicalRepoDir,
          socketPath,
          dbPath,
          launcherPath,
          daemonLogPath,
          layoutEnv,
          storage: dataDirStorage,
          crash1: gCrash1!,
          crash2: gCrash2!,
          extraDaemonPids,
          migrationTimings,
          currentDaemonPid: () => currentDaemonPid,
          setCurrentDaemonPid: (pid) => {
            currentDaemonPid = pid;
          },
        });

        await assertIdempotentRerun({
          checks,
          homeDir,
          canonicalRepoDir,
          socketPath,
          dbPath,
          launcherPath,
          daemonLogPath,
          layoutEnv,
          extraDaemonPids,
          migrationTimings,
          currentDaemonPid: () => currentDaemonPid,
          setCurrentDaemonPid: (pid) => {
            currentDaemonPid = pid;
          },
        });
      }
    });

    // -----------------------------------------------------------------------
    // Phase 8 (data-dir only): New data created on new release in data-dir mode
    // -----------------------------------------------------------------------
    if (isDataDir) {
      await runPhase(8, async (checks) => {
        const legacyFullBefore = snapshotTree(join(canonicalRepoDir, ".harness"));

        const chatNew = await rpc<{ session: { id: string } }>(socketPath, "chat.create", {
          repoRoot: canonicalRepoDir,
          headless: true,
          title: "storage-upgrade-gnew",
        });
        const chatNewId = chatNew.session.id;

        const goalNew = await rpc<{ id: string }>(socketPath, "goal.create", {
          repoRoot: canonicalRepoDir,
          chatSessionId: chatNewId,
          title: "FAKE_ROLE=gnew_orchestrator G_NEW data-dir goal",
          description: "Goal created on the new release in data-dir layout with worker commit and merge.",
          criteria: [{ kind: "behavioral", description: "G_NEW evidence, dossier, worktree, branch, and merged ref use data-dir chat layout" }],
          verificationMode: "none",
        });
        gNewId = goalNew.id;

        const committedNew = await rpc<{ id: string; linkedRunId: string | null }>(socketPath, "goal.commit", {
          goalId: gNewId,
        });
        assert.ok(committedNew.linkedRunId, `expected G_NEW commit linkedRunId`);
        gNewRunId = committedNew.linkedRunId;

        await pollUntil(
          async () => {
            const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId: gNewRunId });
            return r.run.status === "completed";
          },
          25_000,
          "G_NEW run completed with worker merge",
        );

        const gNewRun = await rpc<{
          run: { status: string };
          tasks: Array<{ id: string; tier: number; status: string; worktreeId: string | null }>;
        }>(socketPath, "run.get", { runId: gNewRunId });
        const gNewWorker = gNewRun.tasks.find((t) => t.tier === 2);
        assert.ok(gNewWorker && gNewWorker.worktreeId, "expected G_NEW Tier 2 worker with worktree");
        assert.equal(gNewWorker.status, "completed", `expected G_NEW worker completed, got ${gNewWorker.status}`);

        await checks.run("G_NEW evidence dir, dossiers, and worktree live under data-dir with chat segment", () => {
          const expectedEvDir = dataDirStorage.goalEvidenceDir({
            repoRoot: canonicalRepoDir,
            id: gNewId,
            chatSessionId: chatNewId,
          });
          const expectedRunDir = dataDirStorage.runArtifactsDir({
            repoRoot: canonicalRepoDir,
            id: gNewRunId,
            chatSessionId: chatNewId,
          });
          const expectedWtPath = dataDirStorage.worktreePath(
            { repoRoot: canonicalRepoDir, id: gNewRunId, chatSessionId: chatNewId },
            gNewWorker.id,
          );
          assertStrictlyUnderRoot("G_NEW evidence dir", expectedEvDir, root);
          assertStrictlyUnderRoot("G_NEW run dir", expectedRunDir, root);
          assertStrictlyUnderRoot("G_NEW worktree path", expectedWtPath, root);

          assert.ok(expectedEvDir.includes(`${sep}chats${sep}${chatNewId}${sep}goals${sep}${gNewId}`), `bad evDir: ${expectedEvDir}`);
          assert.ok(expectedRunDir.includes(`${sep}chats${sep}${chatNewId}${sep}artifacts${sep}${gNewRunId}`), `bad runDir: ${expectedRunDir}`);
          assert.ok(expectedWtPath.includes(`${sep}chats${sep}${chatNewId}${sep}worktrees${sep}${gNewRunId}${sep}${gNewWorker.id}`), `bad wtPath: ${expectedWtPath}`);

          assertRealDir("G_NEW evidence dir", expectedEvDir);
          assert.ok(existsSync(join(expectedEvDir, "gnew-evidence.txt")), "missing gnew-evidence.txt in data-dir evidence dir");
          assertRealDir("G_NEW run artifacts dir", expectedRunDir);

          const arts = queryArtifacts(dbPath, gNewRunId);
          assert.ok(arts.length >= 1, "expected >=1 artifact row for G_NEW");
          for (const a of arts) {
            assert.ok(a.path.startsWith(expectedRunDir + sep), `expected G_NEW artifact under ${expectedRunDir}, got ${a.path}`);
            assert.ok(existsSync(a.path), `G_NEW artifact missing on disk: ${a.path}`);
          }

          const wtRow = queryDb(
            dbPath,
            (db) =>
              db
                .prepare("SELECT id, run_id, task_id, path, branch, base_sha, status FROM worktrees WHERE id = ?")
                .get(gNewWorker.worktreeId!) as WorktreeRow | null,
          );
          assert.ok(wtRow, "missing G_NEW worktree row");
          assert.equal(wtRow.path, expectedWtPath, `G_NEW worktree path mismatch: got ${wtRow.path}`);
          pass(
            "G_NEW evidence, dossiers, and worktree created under data-dir with chat segment",
            `chat=${chatNewId} wt=${wtRow.path}`,
          );
        });

        await checks.run("G_NEW task branch and merged ref carry the chat segment from src/storage/names.ts", () => {
          const expectedBranch = taskBranchName({ id: gNewRunId, chatSessionId: chatNewId }, gNewWorker.id, "data-dir");
          const expectedMergedRef = mergedRef({ id: gNewRunId, chatSessionId: chatNewId }, "data-dir");
          const wtRow = queryDb(
            dbPath,
            (db) =>
              db
                .prepare("SELECT branch FROM worktrees WHERE id = ?")
                .get(gNewWorker.worktreeId!) as { branch: string } | null,
          );
          assert.ok(wtRow, "missing G_NEW worktree row for branch check");
          assert.equal(wtRow.branch, expectedBranch, `G_NEW task branch mismatch: expected ${expectedBranch}, got ${wtRow.branch}`);

          const mergedSha = execFileSync("git", ["rev-parse", "--verify", expectedMergedRef], {
            cwd: canonicalRepoDir,
            encoding: "utf8",
          }).trim();
          assert.match(mergedSha, /^[0-9a-f]{40}$/, `unexpected merged ref SHA for ${expectedMergedRef}: ${mergedSha}`);
          pass(
            "G_NEW task branch and merged ref carry chat segment",
            `branch=${wtRow.branch} mergedRef=${expectedMergedRef} (${mergedSha.slice(0, 8)})`,
          );
        });

        await checks.run("Repo gained zero new files or directories under .harness for G_NEW", () => {
          const legacyFullAfter = snapshotTree(join(canonicalRepoDir, ".harness"));
          assert.deepEqual(legacyFullAfter, legacyFullBefore, "new files/dirs appeared under repo .harness for G_NEW");
          pass("Zero new files or directories created under repo .harness for G_NEW");
        });
      });
    }

    // -----------------------------------------------------------------------
    // Phase 8 (legacy) / Phase 9 (data-dir): Fallback round trip
    // -----------------------------------------------------------------------
    const rollbackPhaseId = isDataDir ? 9 : 8;
    await runPhase(rollbackPhaseId, async (checks) => {
      let preRollbackDataTree: TreeSnapshot | null = null;
      if (isDataDir) {
        preRollbackDataTree = snapshotTree(join(homeDir, "data"));
      }

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
      const pidBeforeRollback = currentDaemonPid;
      const rollbackInstall = await runCommand("sh", ["install.sh"], {
        cwd: checkoutPrevDir,
        env: { ...baseEnv, PI_HARNESS_STORAGE_LAYOUT: "legacy", PI_HARNESS_RELOAD_WAIT: "1" },
        label: `PI_HARNESS_RELOAD_WAIT=1 sh install.sh (rollback to PREV ${relPrev})`,
      });
      assert.equal(rollbackInstall.code, 0, `rollback install.sh failed with exit ${rollbackInstall.code}`);

      const currentLinkBack = readlinkSync(join(installDir, "current"));
      assert.equal(basename(currentLinkBack), relPrev, `expected current back at ${relPrev}, got ${currentLinkBack}`);

      const pingBack = await rpc<{ pid: number; releaseId: string; reload?: { previousReleaseId?: string } }>(
        socketPath,
        "ping",
      );
      currentDaemonPid = pingBack.pid;
      extraDaemonPids.push(pingBack.pid);
      assert.equal(pingBack.releaseId, relPrev, `expected ping.releaseId=${relPrev}, got ${pingBack.releaseId}`);
      assert.notEqual(pingBack.pid, pidBeforeRollback, `expected daemon PID to change on rollback from ${pidBeforeRollback}`);
      assert.equal(pingBack.reload?.previousReleaseId, relNew, `expected previousReleaseId=${relNew}`);
      pass(
        "Daemon rolled back to relPrev via checkout-prev/install.sh and passed health check against migrated DB",
        `pid ${pidBeforeRollback} (${relNew}) -> pid ${pingBack.pid} (${pingBack.releaseId})`,
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

      // Verify relPrev reads G0's dossier through artifact.read RPC.
      await checks.run("PREV release reads G0 dossier through artifact.read RPC (rewritten row or bridge)", async () => {
        if (!isDataDir) {
          const g0ReadBack = await rpc<{ content?: string }>(socketPath, "artifact.read", {
            runId: g0.runId,
            path: g0.artifactPath,
          });
          assert.equal(g0ReadBack.content, g0.artifactContent, "relPrev artifact.read for G0 content mismatch");
          pass("PREV release read G0 artifact through daemon artifact.read RPC", `run=${g0.runId} path=${g0.artifactPath}`);
          return;
        }
        const candidates = [
          { label: "rewritten-row", path: g0NewArtifactPath },
          { label: "legacy-bridge-abs", path: g0.artifactPath },
          {
            label: "legacy-bridge-rel",
            path: `.harness/artifacts/${g0.runId}/${relative(join(canonicalRepoDir, ".harness", "artifacts", g0.runId), g0.artifactPath).replaceAll("\\", "/")}`,
          },
        ];
        const errors: string[] = [];
        for (const c of candidates) {
          try {
            const res = await rpc<{ content?: string }>(socketPath, "artifact.read", {
              runId: g0.runId,
              path: c.path,
            });
            if (res.content === g0.artifactContent) {
              pass("PREV release read migrated G0 dossier through artifact.read RPC", `via=${c.label} path=${c.path}`);
              return;
            }
            errors.push(`${c.label}: content mismatch`);
          } catch (err) {
            errors.push(`${c.label}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        throw new Error(`relPrev could not read migrated G0 dossier via any path (${errors.join(" | ")})`);
      });

      if (!isDataDir) return;

      // While running relPrev, create new legacy data (goal G_FALLBACK + note fallback-note.md) and assert it lands in repo's legacy dirs.
      const gFallback = await seedCompletedGoalViaRpc({
        socketPath,
        canonicalRepoDir,
        chatTitle: "storage-upgrade-fallback",
        goalTitle: "G_FALLBACK legacy goal written during rollback",
        goalDescription: "Goal created while rolled back to previous release; must merge into data-dir on re-upgrade.",
        dossierName: "gfb-dossier.md",
        evidenceFilename: "gfb-evidence.txt",
        evidenceContent: "G_FALLBACK evidence written during previous-release rollback.\n",
        accept: true,
        expectLegacyPaths: true,
      });

      const fbNoteRel = ".harness/notes/fallback-note.md";
      const fbNoteAbs = join(canonicalRepoDir, ".harness", "notes", "fallback-note.md");
      const fbNoteContent = "# Fallback Note\nWritten by previous release during rollback.\n";
      await rpc(socketPath, "tool.call", {
        taskId: gFallback.chatSessionId,
        name: "write_note",
        args: {
          path: fbNoteRel,
          content: fbNoteContent,
          reason: "Seed legacy note during previous-release rollback",
        },
      });
      assert.ok(existsSync(fbNoteAbs) && !lstatSync(fbNoteAbs).isSymbolicLink(), `expected real legacy note at ${fbNoteAbs}`);
      const fbEvHashes = snapshotTree(gFallback.evidenceDir).files;
      const fbRunLegacyDir = join(canonicalRepoDir, ".harness", "artifacts", gFallback.runId);
      const fbRunHashes = snapshotTree(fbRunLegacyDir).files;
      const fbNoteHash = sha256File(fbNoteAbs);
      const fbPreRows = queryArtifacts(dbPath, gFallback.runId);
      pass(
        "Previous release created new legacy goal and note in repo .harness dirs",
        `goal=${gFallback.goalId} run=${gFallback.runId} note=${fbNoteAbs}`,
      );

      // Re-install the new release again and verify merge of fallback data + preservation of earlier data + intact run state.
      const logOffsetReupgrade = getLogFileSize(daemonLogPath);
      const pidBeforeReupgrade = currentDaemonPid;
      const reupgradeInstall = await runCommand("sh", ["install.sh"], {
        cwd: REPO_ROOT,
        env: { ...layoutEnv, PI_HARNESS_RELOAD_WAIT: "1" },
        label: `PI_HARNESS_RELOAD_WAIT=1 PI_HARNESS_STORAGE_LAYOUT=data-dir sh install.sh (re-upgrade to NEW ${relNew})`,
      });
      assert.equal(reupgradeInstall.code, 0, `re-upgrade install.sh failed with exit ${reupgradeInstall.code}`);

      const currentLinkRe = readlinkSync(join(installDir, "current"));
      assert.equal(basename(currentLinkRe), relNew, `expected current back at ${relNew}, got ${currentLinkRe}`);

      const pingRe = await rpc<{ pid: number; releaseId: string; reload?: { previousReleaseId?: string } }>(
        socketPath,
        "ping",
      );
      currentDaemonPid = pingRe.pid;
      extraDaemonPids.push(pingRe.pid);
      assert.equal(pingRe.releaseId, relNew, `expected ping.releaseId=${relNew}, got ${pingRe.releaseId}`);
      assert.notEqual(pingRe.pid, pidBeforeReupgrade, `expected PID to change on re-upgrade`);
      assert.equal(pingRe.reload?.previousReleaseId, relPrev, `expected previousReleaseId=${relPrev}`);
      pass(
        "Re-installed new release after rollback",
        `pid ${pidBeforeReupgrade} (${relPrev}) -> pid ${pingRe.pid} (${pingRe.releaseId})`,
      );

      await checks.run("Daemon log recorded re-upgrade migration pass with errors=0", () => {
        const parsed = parseMigrationLogSection(daemonLogPath, logOffsetReupgrade);
        assert.equal(parsed.failureLines.length, 0, `unexpected migration failure lines: ${parsed.failureLines.join("; ")}`);
        assert.equal(parsed.summaryLines.length, 1, `expected 1 migration summary line, got ${parsed.summaryLines.length}`);
        assert.equal(parsed.summaryLines[0]!.errors, 0, `expected errors=0: ${parsed.summaryLines[0]!.raw}`);
        assert.ok(parsed.summaryLines[0]!.moved >= 2, `expected moved>=2 (G_FALLBACK + fallback-note): ${parsed.summaryLines[0]!.raw}`);
        migrationTimings.push({
          label: "Phase 9 re-upgrade start",
          pid: pingRe.pid,
          summary: parsed.summaryLines[0]!,
          failureCount: parsed.failureLines.length,
        });
        pass("Re-upgrade migration log line verified", parsed.summaryLines[0]!.raw);
      });

      await checks.run("Fallback legacy goal and note merged into data-dir with nothing lost or shadowed", () => {
        const fbDestEvDir = dataDirStorage.unitDataDirDestination({
          kind: "goal",
          repoRoot: canonicalRepoDir,
          id: gFallback.goalId,
          chatSessionId: gFallback.chatSessionId,
        });
        const fbDestRunDir = dataDirStorage.unitDataDirDestination({
          kind: "run",
          repoRoot: canonicalRepoDir,
          id: gFallback.runId,
          chatSessionId: gFallback.chatSessionId,
        });
        const fbNoteDest = dataDirStorage.unitDataDirDestination({
          kind: "note",
          repoRoot: canonicalRepoDir,
          id: basename(fbNoteAbs),
        });
        assertRealDir("fbDestEvDir", fbDestEvDir);
        assertRealDir("fbDestRunDir", fbDestRunDir);
        assertDirHashMapEquals("G_FALLBACK evidence dir", fbDestEvDir, fbEvHashes);
        assertDirHashMapEquals("G_FALLBACK run artifacts dir", fbDestRunDir, fbRunHashes);
        assert.equal(sha256File(fbNoteDest), fbNoteHash, "fallback-note.md sha256 mismatch at data-dir destination");
        assertBridgeSymlink("G_FALLBACK evidence bridge", gFallback.evidenceDir, fbDestEvDir);
        assertBridgeSymlink("G_FALLBACK run bridge", fbRunLegacyDir, fbDestRunDir);
        assertBridgeSymlink("fallback-note bridge", fbNoteAbs, fbNoteDest);

        const postFbRows = queryArtifacts(dbPath, gFallback.runId);
        assert.equal(postFbRows.length, fbPreRows.length);
        for (const pre of fbPreRows) {
          const post = postFbRows.find((r) => r.id === pre.id);
          assert.ok(post);
          assert.equal(post.path, join(fbDestRunDir, relative(fbRunLegacyDir, pre.path)));
        }
        pass("Fallback goal and note migrated/merged cleanly into data-dir with bridges and rewritten rows");
      });

      await checks.run("Earlier migrated data unchanged (sha256 map) and run/goal state intact after round trip", async () => {
        const postReupgradeDataTree = snapshotTree(join(homeDir, "data"));
        assert.ok(preRollbackDataTree, "missing preRollbackDataTree");
        for (const [relPath, sha] of Object.entries(preRollbackDataTree.files)) {
          // migration-state.json legitimately updates across passes.
          if (basename(relPath) === "migration-state.json") continue;
          assert.equal(
            postReupgradeDataTree.files[relPath],
            sha,
            `earlier migrated file changed or lost during fallback round trip: ${relPath}`,
          );
        }

        // Verify all runs and goals remain intact through daemon RPC.
        for (const rid of [g0.runId, g1RunId, gNewRunId, r2RunId, gFallback.runId]) {
          const r = await rpc<{ run: { status: string } }>(socketPath, "run.get", { runId: rid });
          assert.equal(r.run.status, "completed", `expected run ${rid} completed after round trip, got ${r.run.status}`);
        }
        for (const gid of [g0.goalId, g1Id, gCrash1!.goalId, gCrash2!.goalId, gFallback.goalId]) {
          const g = await rpc<{ goal: { status: string } }>(socketPath, "goal.get", { goalId: gid });
          assert.equal(g.goal.status, "achieved", `expected goal ${gid} achieved after round trip, got ${g.goal.status}`);
        }
        pass(
          "Earlier migrated data unchanged (sha256 map) and all run/goal states intact after fallback round trip",
          `preservedFiles=${Object.keys(preRollbackDataTree.files).length} verifiedRuns=5 verifiedGoals=5`,
        );
      });
    });
  } catch (err) {
    runError = err;
    console.error(`\n[FAIL] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  } finally {
    // -----------------------------------------------------------------------
    // Final Phase: Cleanup (always runs, on success and failure)
    // -----------------------------------------------------------------------
    const cleanupPhaseId = isDataDir ? 10 : 9;
    try {
      await runPhase(cleanupPhaseId, async () => {
        await doCleanup();
        const lingering = listLingeringProcessesForRoot(root);
        assert.equal(lingering.length, 0, `lingering processes from temp root:\n${lingering.join("\n")}`);
        if (!keepTemp) {
          assert.equal(existsSync(root), false, `temp root ${root} still exists after cleanup`);
        }
        pass(
          keepTemp
            ? "Cleanup verified: zero lingering processes (temp root kept)"
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

  if (migrationTimings.length > 0) {
    console.log("\n=== Migration Pass Timings ===");
    for (const t of migrationTimings) {
      if (t.summary) {
        console.log(
          `- ${t.label} (pid=${t.pid}): elapsedMs=${t.summary.elapsedMs} moved=${t.summary.moved} deferred=${t.summary.deferred} rowsRewritten=${t.summary.rowsRewritten} errors=${t.summary.errors} budgetHit=${t.summary.budgetHit}`,
        );
      } else {
        console.log(`- ${t.label} (pid=${t.pid}): no-op (no migration summary line; failureLines=${t.failureCount})`);
      }
    }
  }

  if (allSoftFailures.length > 0) {
    console.log("\n=== Recorded Assertion Failures ===");
    for (const f of allSoftFailures) {
      console.log(`- Phase ${f.phaseId} (${f.phaseName}) | ${f.label}: ${f.error}`);
    }
  }

  const totalMs = Date.now() - startedAt;
  console.log("\n=== Phase Summary ===");
  console.log(formatSummaryTable(phases, totalMs));

  const allPassed = phases.every((p) => p.status === "PASS") && !runError && allSoftFailures.length === 0;
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
