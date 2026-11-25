import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import {
  findRunDossier,
  hashRunDossier,
  readRunDossier,
  readWorkspaceArtifact,
  spillSummaryOverflow,
  writeCodeOutput,
  writeTaskDossier,
  writeUniqueTaskDossier,
} from "../src/control-plane/dossiers.js";
import { compactTaskHandoff, SUMMARY_LIMIT } from "../src/control-plane/handoffs.js";
import { GoalEngine } from "../src/goals/engine.js";
import { legacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";

const ORIGINAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  if (ORIGINAL_LAYOUT_ENV === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = ORIGINAL_LAYOUT_ENV;
  resetStoragePathsForTest();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("dossiers, handoffs, and GoalEngine (data-dir layout)", () => {
  it("round-trips writeTaskDossier, writeUniqueTaskDossier, spillSummaryOverflow, writeCodeOutput, readRunDossier, and hashRunDossier in data-dir", async () => {
    const root = makeTempDir("pi-dd-dossiers-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "Dossier round trip", repoRoot: repo, baseBranch: "main", baseSha: "abc1234", chatSessionId: "chat-4" });
      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Produce dossiers",
        profileId: "acp:claude",
      });

      const projDir = sp.projectDir(repo);
      const expectedChatArtifacts = join(projDir, "chats", "chat-4", "artifacts");

      // 1. writeTaskDossier
      const dossier = writeTaskDossier(db, run, task.id, "report.md", "hello dossier\n", "Report", sp);
      assert.equal(dossier.path, join(expectedChatArtifacts, run.id, task.id, "report.md"));
      assert.equal(existsSync(dossier.path), true);

      // 2. writeUniqueTaskDossier
      const unique = writeUniqueTaskDossier(db, run, task.id, "notes", ".md", "unique body", "Notes", sp);
      assert.equal(unique.path, join(expectedChatArtifacts, run.id, task.id, "notes-1.md"));

      // 3. spillSummaryOverflow (absolute data-dir pointer in summary)
      const longText = "A".repeat(SUMMARY_LIMIT + 500);
      const spilled = spillSummaryOverflow(db, run, task.id, longText, sp);
      assert.ok(spilled.overflowPath);
      assert.equal(dirname(spilled.overflowPath), expectedChatArtifacts);
      assert.ok(spilled.summary.endsWith(`[Full summary: ${spilled.overflowPath}]`));
      db.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: spilled.overflowPath, summary: "Spill" });

      // 4. writeCodeOutput
      const codePath = writeCodeOutput(db, run, task.id, "result.json", '{"ok":true}', sp);
      assert.equal(dirname(codePath), expectedChatArtifacts);

      // Nothing created inside repo.
      assert.equal(existsSync(join(repo, ".harness")), false);

      // 5. readRunDossier + hashRunDossier by absolute data-dir path
      const readRes = readRunDossier(db, run, { path: dossier.path }, sp) as { path: string; content: string };
      assert.equal(readRes.path, dossier.path);
      assert.equal(readRes.content, "hello dossier\n");

      const hashRes = await hashRunDossier(db, run, dossier.path, undefined, sp);
      assert.deepEqual(hashRes, {
        sha256: createHash("sha256").update("hello dossier\n").digest("hex"),
        bytes: 14,
      });

      // 6. readRunDossier list returns data-dir paths
      const listed = readRunDossier(db, run, { task_id: task.id }, sp) as { artifacts: Array<{ path: string }> };
      assert.ok(listed.artifacts.some((a) => a.path === dossier.path));
      assert.ok(listed.artifacts.some((a) => a.path === unique.path));
      assert.ok(listed.artifacts.some((a) => a.path === spilled.overflowPath));
      assert.ok(listed.artifacts.some((a) => a.path === codePath));
    } finally {
      db.close();
    }
  });

  it("reads migrated dossiers by old absolute, old relative, and new paths without following bridge symlinks", async () => {
    const root = makeTempDir("pi-dd-mig-read-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    const repoLink = join(root, "repo-link");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    symlinkSync(repo, repoLink);

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "Migrated run", repoRoot: repo, baseBranch: "main", baseSha: "abc1234", chatSessionId: "chat-2" });
      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Write legacy then migrate",
        profileId: "acp:claude",
      });

      // 1. Write dossier in legacy layout.
      const body = "migrated dossier content\n";
      const legacyArt = writeTaskDossier(db, run, task.id, "findings.md", body, "Findings", legacyStoragePaths);
      const oldAbs = legacyArt.path;
      const oldRel = `.harness/artifacts/${run.id}/${task.id}/findings.md`;
      const oldViaRepoLink = join(repoLink, oldRel);

      // 2. Simulate migration: rename legacy unit dir to data-dir, rewrite artifacts.path, leave bridge symlink.
      const newRunDir = join(sp.artifactsDir(run), run.id);
      mkdirSync(dirname(newRunDir), { recursive: true });
      const legacyRunDir = join(repo, ".harness", "artifacts", run.id);
      renameSync(legacyRunDir, newRunDir);
      const newAbs = join(newRunDir, task.id, "findings.md");
      db.db.prepare("UPDATE artifacts SET path = ? WHERE id = ?").run(newAbs, legacyArt.id);
      symlinkSync(newRunDir, legacyRunDir);

      // 3. Readable by old absolute, old relative, symlinked-repo absolute, and new absolute paths; always displays newAbs.
      const expectedHash = { sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length };
      for (const queryPath of [newAbs, oldAbs, oldRel, oldViaRepoLink]) {
        const found = findRunDossier(db, run, queryPath, sp);
        assert.ok(found, `findRunDossier should match ${queryPath}`);
        const read = readRunDossier(db, run, { path: queryPath }, sp) as { path: string; content: string };
        assert.equal(read.path, newAbs);
        assert.equal(read.content, body);
        assert.deepEqual(await hashRunDossier(db, run, queryPath, undefined, sp), expectedHash);
      }

      // 4. Prove readers never follow the bridge symlink: repoint bridge at a trap file; readers still read newAbs!
      const trapDir = join(root, "trap-dir");
      mkdirSync(join(trapDir, task.id), { recursive: true });
      writeFileSync(join(trapDir, task.id, "findings.md"), "TRAP CONTENT DO NOT READ", "utf8");
      rmSync(legacyRunDir);
      symlinkSync(trapDir, legacyRunDir);

      const readWithTrapBridge = readRunDossier(db, run, { path: oldRel }, sp) as { path: string; content: string };
      assert.equal(readWithTrapBridge.path, newAbs);
      assert.equal(readWithTrapBridge.content, body);

      // 5. readWorkspaceArtifact refuses legacy/bridge/data-dir paths without following the bridge symlink.
      for (const blocked of [oldRel, oldAbs, newAbs]) {
        assert.throws(() => readWorkspaceArtifact(repo, blocked, undefined, undefined, sp), /artifact-outside-workspace/);
      }

      // 6. readWorkspaceArtifact allows normal source files inside a data-dir worktree.
      const wtDir = sp.worktreePath(run, task.id);
      mkdirSync(join(wtDir, "src"), { recursive: true });
      writeFileSync(join(wtDir, "src", "app.ts"), "export const x = 1;\n", "utf8");
      const wsRead = readWorkspaceArtifact(wtDir, "src/app.ts", undefined, undefined, sp) as { content: string };
      assert.equal(wsRead.content, "export const x = 1;\n");
    } finally {
      db.close();
    }
  });

  it("enforces both-exist union, symlink refusals, and multi-run ownership ambiguity in dossier readers", async () => {
    const root = makeTempDir("pi-dd-dossier-guards-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const db = new ControlPlaneDb(":memory:");
    try {
      const run1 = db.createRun({ goal: "Run 1", repoRoot: repo, baseBranch: "main", baseSha: "abc1234", chatSessionId: "chat-1" });
      const task1 = db.createTask({
        runId: run1.id,
        tier: 2,
        kind: "worker",
        title: "T1",
        objective: "Obj",
        profileId: "acp:claude",
      });

      // Both-exist union: real legacy dir + data-dir copy both exist.
      const legacyTaskDir = join(repo, ".harness", "artifacts", run1.id, task1.id);
      const dataTaskDir = join(sp.artifactsDir(run1), run1.id, task1.id);
      mkdirSync(legacyTaskDir, { recursive: true });
      mkdirSync(dataTaskDir, { recursive: true });

      const legacyConflict = join(legacyTaskDir, "conflict.md");
      const dataConflict = join(dataTaskDir, "conflict.md");
      const dataOnly = join(dataTaskDir, "data-only.md");
      writeFileSync(legacyConflict, "legacy-wins", "utf8");
      writeFileSync(dataConflict, "datadir-shadowed", "utf8");
      writeFileSync(dataOnly, "only-in-datadir", "utf8");

      db.recordArtifact({ runId: run1.id, taskId: task1.id, kind: "dossier", path: legacyConflict, summary: "Conflict" });
      db.recordArtifact({ runId: run1.id, taskId: task1.id, kind: "dossier", path: dataOnly, summary: "Data only" });

      const conflictRead = readRunDossier(db, run1, { path: dataConflict }, sp) as { content: string };
      assert.equal(conflictRead.content, "legacy-wins");

      const dataOnlyRead = readRunDossier(db, run1, { path: `.harness/artifacts/${run1.id}/${task1.id}/data-only.md` }, sp) as {
        path: string;
        content: string;
      };
      assert.equal(dataOnlyRead.path, dataOnly);
      assert.equal(dataOnlyRead.content, "only-in-datadir");

      // Hostile symlink inside data-dir is refused.
      const secretFile = join(root, "secret.txt");
      writeFileSync(secretFile, "TOP SECRET", "utf8");
      const hostileLink = join(dataTaskDir, "evil.md");
      symlinkSync(secretFile, hostileLink);
      db.recordArtifact({ runId: run1.id, taskId: task1.id, kind: "dossier", path: hostileLink, summary: "Evil" });
      assert.throws(() => readRunDossier(db, run1, { path: hostileLink }, sp), /dossier-symlink/);
      assert.equal(await hashRunDossier(db, run1, hostileLink, undefined, sp), null);

      // Multi-run ambiguous ownership across legacy and data-dir spellings is refused.
      const run2 = db.createRun({ goal: "Run 2", repoRoot: repo, baseBranch: "main", baseSha: "abc1234", chatSessionId: "chat-1" });
      const task2 = db.createTask({
        runId: run2.id,
        tier: 2,
        kind: "worker",
        title: "T2",
        objective: "Obj2",
        profileId: "acp:claude",
      });
      db.recordArtifact({ runId: run2.id, taskId: task2.id, kind: "dossier", path: dataConflict, summary: "Dup" });
      assert.throws(() => readRunDossier(db, run1, { path: legacyConflict }, sp), /dossier-ambiguous-owner/);
      assert.equal(await hashRunDossier(db, run1, legacyConflict, undefined, sp), null);
    } finally {
      db.close();
    }
  });

  it("maps legacy full_summary and artifact_paths in compactTaskHandoff and renders real data-dir locations in GoalEngine", async () => {
    const root = makeTempDir("pi-dd-handoff-goal-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const db = new ControlPlaneDb(":memory:");
    try {
      // 1. compactTaskHandoff maps migrated legacy full_summary.path and artifact_paths to current data-dir paths.
      const run = db.createRun({ goal: "Handoff mapping", repoRoot: repo, baseBranch: "main", baseSha: "abc1234", chatSessionId: "chat-6" });
      const migratedSpill = join(sp.artifactsDir(run), "t-1-summary-1.md");
      const migratedDossier = join(sp.artifactsDir(run), run.id, "t-1", "out.md");
      mkdirSync(dirname(migratedDossier), { recursive: true });
      writeFileSync(migratedSpill, "full summary body", "utf8");
      writeFileSync(migratedDossier, "dossier body", "utf8");

      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Obj",
        profileId: "acp:claude",
      });
      db.db
        .prepare("UPDATE tasks SET status = 'completed', summary = ?, result_json = ? WHERE id = ?")
        .run(
          "Truncated summary\n\n[Full summary: .harness/artifacts/t-1-summary-1.md]",
          JSON.stringify({
            summary: "Truncated summary",
            artifact_paths: [
              `.harness/artifacts/${run.id}/t-1/out.md`,
              `${repo}/.harness/artifacts/t-1-summary-1.md`,
            ],
            summary_overflow: { path: ".harness/artifacts/t-1-summary-1.md", next_offset: 100, total_chars: 500 },
          }),
          task.id,
        );
      const reloadedTask = db.getTask(task.id)!;
      const handoff = compactTaskHandoff(reloadedTask, [], {
        repoRoot: repo,
        chatSessionId: "chat-6",
        storage: sp,
      });
      assert.equal(handoff.full_summary?.path, migratedSpill);
      assert.deepEqual(handoff.artifact_paths, [migratedDossier, migratedSpill]);

      // Also test pointer-matching when summary_overflow metadata is absent (legacy summary text + rewritten artifact_paths).
      db.db
        .prepare("UPDATE tasks SET result_json = ? WHERE id = ?")
        .run(
          JSON.stringify({
            summary: "Truncated summary",
            artifact_paths: [migratedSpill],
          }),
          task.id,
        );
      const handoffMatched = compactTaskHandoff(db.getTask(task.id)!, [], {
        repoRoot: repo,
        chatSessionId: "chat-6",
        storage: sp,
      });
      assert.equal(handoffMatched.full_summary?.path, migratedSpill);

      // 2. GoalEngine with injected data-dir StoragePaths creates, reports, and prints real data-dir locations.
      const engine = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);
      const goal = engine.createGoal({
        chatSessionId: "chat-6",
        repoRoot: repo,
        title: "Data-dir goal",
        description: "Verify data-dir evidence locations",
        criteria: [{ id: "c1", description: "Check env", kind: "deterministic", command: "echo $HARNESS_GOAL_EVIDENCE_DIR", required: true }],
      });
      const expectedEvDir = join(sp.goalsDir({ repoRoot: repo, chatSessionId: "chat-6" }), goal.id);
      assert.equal(engine.evidenceDir(goal), expectedEvDir);
      assert.equal(engine.ensureEvidenceDir(goal), expectedEvDir);
      assert.equal(existsSync(expectedEvDir), true);
      assert.equal(existsSync(join(repo, ".harness")), false);

      const linked = engine.linkRunAndStart(goal.id, run.id);
      const locs = engine.evidenceLocations(linked);
      assert.deepEqual(locs, {
        goalEvidenceDir: expectedEvDir,
        goalsDir: join(sp.chatDir({ repoRoot: repo, chatSessionId: "chat-6" }), "goals"),
        artifactsDir: join(sp.chatDir({ repoRoot: repo, chatSessionId: "chat-6" }), "artifacts"),
        runArtifactsDir: join(sp.chatDir({ repoRoot: repo, chatSessionId: "chat-6" }), "artifacts", run.id),
      });

      const prompt = engine.buildReviewerPrompt(
        linked,
        {
          allPassed: true,
          results: [{ criterionId: "c1", passed: true, evidence: "ok" }],
          diffHash: "deadbeef",
          location: { cwd: repo, ref: "HEAD", sha: "abc1234", isolated: false, source: "repo_root" },
        },
        "1 file changed",
        "",
        { evidence: "auto" },
      );
      assert.ok(prompt.includes(`- Goal Evidence Directory: ${locs.goalEvidenceDir} (env HARNESS_GOAL_EVIDENCE_DIR)`));
      assert.ok(prompt.includes(`- Goals Root: ${locs.goalsDir} (env HARNESS_GOALS_DIR)`));
      assert.ok(prompt.includes(`- Artifacts Root: ${locs.artifactsDir} (env HARNESS_ARTIFACTS_DIR)`));
      assert.ok(prompt.includes(`- Run Artifacts Directory: ${locs.runArtifactsDir}`));
    } finally {
      db.close();
    }
  });

  it("returns the absolute winning legacy file path in readRunDossier when the DB row holds the data-dir path in a both-exist unit", () => {
    const root = makeTempDir("pi-dd-winner-path-");
    const stateDir = join(root, "state");
    const repo = join(root, "repo");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(repo, { recursive: true });

    const sp = storagePaths({ stateDir }, { layout: "data-dir" });
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "Both-exist winner path", repoRoot: repo, baseBranch: "main", baseSha: "abc1234", chatSessionId: "chat-7" });
      const task = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Check winner path",
        profileId: "acp:claude",
      });

      const legacyTaskDir = join(repo, ".harness", "artifacts", run.id, task.id);
      const dataTaskDir = join(sp.artifactsDir(run), run.id, task.id);
      mkdirSync(legacyTaskDir, { recursive: true });
      mkdirSync(dataTaskDir, { recursive: true });

      const legacyFile = join(legacyTaskDir, "winner.md");
      const dataFile = join(dataTaskDir, "winner.md");
      writeFileSync(legacyFile, "legacy-winning-bytes", "utf8");
      writeFileSync(dataFile, "shadowed-datadir-bytes", "utf8");

      // DB row records the data-dir path (e.g. post-migration row with a recreated legacy copy on disk).
      db.recordArtifact({ runId: run.id, taskId: task.id, kind: "dossier", path: dataFile, summary: "Winner" });

      const relLegacy = `.harness/artifacts/${run.id}/${task.id}/winner.md`;
      for (const queryPath of [dataFile, legacyFile, relLegacy]) {
        const res = readRunDossier(db, run, { path: queryPath }, sp) as { path: string; content: string };
        assert.equal(res.content, "legacy-winning-bytes");
        assert.equal(res.path, legacyFile, `expected winning file path for query ${queryPath}`);
      }
    } finally {
      db.close();
    }
  });
});
