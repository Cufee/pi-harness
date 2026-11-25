import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { writeTaskDossier } from "../src/control-plane/dossiers.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { resolveDirectorEvidencePath, resolveDirectorReadablePath } from "../src/director/runtime.js";
import type { RunAgentRequest, ToolDefinition } from "../src/runners/types.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const tempDirs: string[] = [];
const ORIGINAL_LAYOUT = process.env.PI_HARNESS_STORAGE_LAYOUT;

function setLayoutEnv(layout: "legacy" | "data-dir" | undefined): void {
  if (layout === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = layout;
  resetStoragePathsForTest();
}

afterEach(() => {
  setLayoutEnv(ORIGINAL_LAYOUT as "legacy" | "data-dir" | undefined);
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

async function makeTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(root);
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "index.ts"), "export const ok = true;\n", "utf8");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return { root, repoRoot };
}

function makeConfig(
  repoRoot: string,
  stateDir: string,
  overrides?: Partial<HarnessConfig["worktree"]>,
): HarnessConfig {
  const base = loadConfig(repoRoot);
  return withFixtureCatalog({
    ...base,
    stateDir,
    socketPath: join(stateDir, "d.sock"),
    storage: { dataDir: join(stateDir, "data") },
    codeMode: "off",
    worktree: {
      ...base.worktree,
      ...(overrides ?? {}),
    },
  });
}

describe("Director storage paths (legacy layout)", () => {
  it("preserves legacy read_file, write_note, artifact_read, goal_get, goal_accept, and Done-Reviewer grants", async () => {
    setLayoutEnv("legacy");
    const { root, repoRoot } = await makeTempGitRepo("pi-dir-legacy-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    // Deliberately configure a non-default legacy worktree.artifactsDir to prove it is ignored.
    const config = makeConfig(repoRoot, stateDir, {
      artifactsDir: ".harness/custom-ignored-artifacts",
    });

    const reviewerRequests: RunAgentRequest[] = [];
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.tools.some((t) => t.name === "submit_review_verdict")) {
            reviewerRequests.push(req);
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              summary: "Legacy review approved",
              criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Checked evidence" }],
            });
            return { stopReason: "completed", text: "approved" };
          }
          return { stopReason: "completed", text: "ok" };
        },
      }),
    });

    try {
      const chat = await daemon.director.createChat({ repoRoot });

      // write_note writes under <repo>/.harness/notes and refuses src/ and .harness/worktrees/
      const noteRes = (await daemon.director.executeDirectorMcpTool(chat.id, "write_note", {
        path: ".harness/notes/legacy-note.md",
        content: "legacy note body\n",
        reason: "Pin legacy note write",
      })) as { written: boolean; path: string };
      assert.equal(noteRes.written, true);
      assert.equal(noteRes.path, join(repoRoot, ".harness", "notes", "legacy-note.md"));
      assert.equal(readFileSync(join(repoRoot, ".harness", "notes", "legacy-note.md"), "utf8"), "legacy note body\n");

      await assert.rejects(
        () =>
          daemon.director.executeDirectorMcpTool(chat.id, "write_note", {
            path: "src/nope.ts",
            content: "x",
            reason: "bad root",
          }),
        /\[harness blocked: director-note-root\]/,
      );
      await assert.rejects(
        () =>
          daemon.director.executeDirectorMcpTool(chat.id, "write_note", {
            path: ".harness/worktrees/run-1/t-1/leak.md",
            content: "x",
            reason: "worktree write",
          }),
        /\[harness blocked: director-note-root\]/,
      );

      // read_file reads legacy note and refuses .git and .harness/worktrees
      const readNote = (await daemon.director.executeDirectorMcpTool(chat.id, "read_file", {
        path: ".harness/notes/legacy-note.md",
      })) as { path: string; content: string };
      assert.equal(readNote.content, "legacy note body\n");
      assert.equal(readNote.path, ".harness/notes/legacy-note.md");

      mkdirSync(join(repoRoot, ".harness", "worktrees", "run-1", "t-1"), { recursive: true });
      writeFileSync(join(repoRoot, ".harness", "worktrees", "run-1", "t-1", "wip.ts"), "secret\n", "utf8");
      await assert.rejects(
        () => daemon.director.executeDirectorMcpTool(chat.id, "read_file", { path: ".git/config" }),
        /\[harness blocked: director-protected-read\]/,
      );
      await assert.rejects(
        () =>
          daemon.director.executeDirectorMcpTool(chat.id, "read_file", {
            path: ".harness/worktrees/run-1/t-1/wip.ts",
          }),
        /\[harness blocked: director-protected-read\]/,
      );

      // Goal + run + dossier for artifact_read, goal_get, goal_accept, and Done-Reviewer
      const longDesc = "Legacy long description. ".repeat(100).trim();
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat.id,
        title: "Legacy path goal",
        description: longDesc,
        criteria: [{ id: "c1", kind: "behavioral", description: "Check evidence", required: true }],
      });
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const run = daemon.db.createRun({
        goal: goal.title,
        repoRoot,
        baseBranch: "main",
        baseSha,
        chatSessionId: chat.id,
      });
      daemon.director.goals.linkRunAndStart(goal.id, run.id);
      const worker = daemon.db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Produce dossier",
        profileId: "acp:claude",
      });
      const legacySp = createLegacyStoragePaths(config);
      const dossier = writeTaskDossier(daemon.db, run, worker.id, "report.md", "legacy dossier\n", "Summary", legacySp);
      daemon.db.updateTask(worker.id, {
        status: "completed",
        summary: "Done",
        resultJson: JSON.stringify({ summary: "Done", artifact_paths: [dossier.path] }),
      });

      // artifact_read
      const artRes = (await daemon.director.executeDirectorMcpTool(chat.id, "artifact_read", {
        path: `.harness/artifacts/${run.id}/${worker.id}/report.md`,
      })) as { content: string };
      assert.equal(artRes.content, "legacy dossier\n");

      // goal_get: evidenceDir, repo-relative description.path, tasks[].artifactPaths all accepted by read_file
      const goalGet = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
        goal_id: goal.id,
      })) as {
        evidenceDir: string;
        goal: { description: { path: string | null } };
        tasks: Array<{ id: string; artifactPaths?: string[] }>;
      };
      assert.equal(goalGet.evidenceDir, join(repoRoot, ".harness", "goals", goal.id));
      assert.equal(goalGet.goal.description.path, `.harness/goals/${goal.id}/goal-description-v1.md`);
      const readDesc = (await daemon.director.executeDirectorMcpTool(chat.id, "read_file", {
        path: goalGet.goal.description.path!,
      })) as { content: string };
      assert.equal(readDesc.content, longDesc);
      const workerRow = goalGet.tasks.find((t) => t.id === worker.id);
      assert.deepEqual(workerRow?.artifactPaths, [dossier.path]);
      const readArt = (await daemon.director.executeDirectorMcpTool(chat.id, "read_file", {
        path: workerRow!.artifactPaths![0]!,
      })) as { content: string };
      assert.equal(readArt.content, "legacy dossier\n");

      // Done-Reviewer grants in legacy layout ignore worktree.artifactsDir and match taskGrants
      await daemon.director.verifyAndReviewGoal(goal.id);
      assert.equal(reviewerRequests.length, 1);
      const revReq = reviewerRequests[0]!;
      assert.deepEqual(revReq.extraReadRoots, [
        join(repoRoot, ".harness", "goals"),
        join(repoRoot, ".harness", "artifacts"),
      ]);
      assert.deepEqual(revReq.extraEnv, {
        HARNESS_GOAL_EVIDENCE_DIR: join(repoRoot, ".harness", "goals", goal.id),
        HARNESS_GOAL_ID: goal.id,
        HARNESS_GOALS_DIR: join(repoRoot, ".harness", "goals"),
        HARNESS_ARTIFACTS_DIR: join(repoRoot, ".harness", "artifacts"),
      });
      assert.deepEqual(revReq.deniedRoots, []);
      assert.deepEqual(revReq.protectedRoots, []);
      assert.ok(revReq.initialPrompt.includes(join(repoRoot, ".harness", "artifacts", run.id)));
      assert.ok(!revReq.initialPrompt.includes("custom-ignored-artifacts"));

      // goal_accept in legacy layout accepts .harness/goals/<id>/ev.md and refuses .harness/worktrees
      const goal2 = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat.id,
        title: "Accept legacy goal",
        description: "Accept me",
        criteria: [{ id: "c1", kind: "behavioral", description: "Check", required: true }],
      });
      daemon.director.goals.setStatus(goal2.id, "awaiting_human", "ready for accept");
      const evFile = join(repoRoot, ".harness", "goals", goal2.id, "ev.md");
      mkdirSync(dirname(evFile), { recursive: true });
      writeFileSync(evFile, "evidence ok\n", "utf8");
      const accepted = await daemon.director.acceptGoalOverride(goal2.id, {
        reason: "Verified legacy evidence",
        evidencePaths: [`.harness/goals/${goal2.id}/ev.md`],
        source: "director",
        chatSessionId: chat.id,
      });
      assert.equal(accepted.goal.status, "achieved");
      assert.equal(accepted.review.audit?.evidence[0]?.canonicalPath, evFile);
      assert.throws(() => resolveDirectorEvidencePath(repoRoot, ".harness/worktrees/run-1/t-1/wip.ts"), /refused/);
    } finally {
      await daemon.stop();
    }
  });
});

describe("Director storage paths (data-dir layout, criterion c8 pre- and post-migration)", () => {
  it("supports read_file, artifact_read, write_note, goal_get, goal_accept, wait_tasks, and refusals before and after simulated migration", async () => {
    setLayoutEnv("data-dir");
    const { root, repoRoot } = await makeTempGitRepo("pi-dir-c8-");
    const { repoRoot: otherRepoRoot } = await makeTempGitRepo("pi-dir-c8-other-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    // Populate state-dir internals that must always be refused.
    writeFileSync(join(stateDir, "control-plane.sqlite"), "sqlite-header", "utf8");
    writeFileSync(join(stateDir, "config.json"), '{"stateDir":true}\n', "utf8");

    const config = makeConfig(repoRoot, stateDir);
    const sp = storagePaths(config, { layout: "data-dir" });
    const legacySp = createLegacyStoragePaths(config);
    assert.equal(sp.layout, "data-dir");

    let lastWaitTasksResult: unknown = null;
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          const match = req.initialPrompt.match(/RUN_WAIT_TASKS:(\S+)/);
          if (match) {
            lastWaitTasksResult = await req.executeTool("wait_tasks", {
              ids: [match[1]!],
              timeout_s: 1,
            });
          }
          return { stopReason: "completed", text: "ok" };
        },
      }),
    });

    try {
      const chat1 = await daemon.director.createChat({ repoRoot });
      const chat2 = await daemon.director.createChat({ repoRoot });

      // --- Seed legacy data BEFORE migration (real files/dirs under <repo>/.harness/) ---
      const legacyNotePath = join(repoRoot, ".harness", "notes", "shared-note.md");
      mkdirSync(dirname(legacyNotePath), { recursive: true });
      writeFileSync(legacyNotePath, "v1 legacy note\n", "utf8");

      const longDesc = "Migrated goal full description. ".repeat(80).trim();
      const goal1 = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat1.id,
        title: "Migrated c8 goal",
        description: longDesc,
        criteria: [{ id: "c1", kind: "behavioral", description: "Check migrated files", required: true }],
      });
      const legacyGoalDir = join(repoRoot, ".harness", "goals", goal1.id);
      mkdirSync(legacyGoalDir, { recursive: true });
      const legacyEvFile = join(legacyGoalDir, "evidence.md");
      writeFileSync(legacyEvFile, "goal evidence body\n", "utf8");

      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
      const run1 = daemon.db.createRun({
        goal: goal1.title,
        repoRoot,
        baseBranch: "main",
        baseSha,
        chatSessionId: chat1.id,
      });
      daemon.director.goals.linkRunAndStart(goal1.id, run1.id);
      const task1 = daemon.db.createTask({
        runId: run1.id,
        tier: 2,
        kind: "worker",
        title: "Worker 1",
        objective: "Generate report",
        profileId: "acp:claude",
      });
      const legacyArt = writeTaskDossier(
        daemon.db,
        run1,
        task1.id,
        "findings.md",
        "dossier findings content\n",
        "Findings",
        legacySp,
      );
      const legacySpillRel = `.harness/artifacts/${task1.id}-summary-1.md`;
      const legacySpillAbs = join(repoRoot, legacySpillRel);
      writeFileSync(legacySpillAbs, "full overflow summary body\n", "utf8");
      daemon.db.recordArtifact({
        runId: run1.id,
        taskId: task1.id,
        kind: "dossier",
        path: legacySpillAbs,
        summary: "Overflow summary",
      });
      daemon.db.updateTask(task1.id, {
        status: "completed",
        summary: `Short summary\n\n[Full summary: ${legacySpillRel}]`,
        resultJson: JSON.stringify({
          summary: "Short summary",
          artifact_paths: [`.harness/artifacts/${run1.id}/${task1.id}/findings.md`, legacySpillAbs],
          summary_overflow: { path: legacySpillRel, next_offset: 10, total_chars: 100 },
        }),
      });

      // Seed a Director-bucket settled task for wait_tasks verification too.
      const bucketRun = await daemon.orchestrator.ensureDirectorTaskRun(chat1.id, repoRoot);
      const [bucketOwner] = daemon.db.listTasks(bucketRun.id, { parentId: null });
      const subTask = daemon.db.createTask({
        runId: bucketRun.id,
        parentId: bucketOwner!.id,
        tier: 3,
        kind: "research",
        title: "Scout",
        objective: "Find paths",
        readOnly: true,
        profileId: "acp:claude",
      });
      const legacySubArt = writeTaskDossier(
        daemon.db,
        bucketRun,
        subTask.id,
        "scout.md",
        "scout dossier body\n",
        "Scout summary",
        legacySp,
      );
      const legacySubSpillRel = `.harness/artifacts/${subTask.id}-summary-1.md`;
      const legacySubSpillAbs = join(repoRoot, legacySubSpillRel);
      writeFileSync(legacySubSpillAbs, "scout overflow summary\n", "utf8");
      daemon.db.recordArtifact({
        runId: bucketRun.id,
        taskId: subTask.id,
        kind: "dossier",
        path: legacySubSpillAbs,
        summary: "Scout overflow",
      });
      daemon.db.updateTask(subTask.id, {
        status: "completed",
        summary: `Scout done\n\n[Full summary: ${legacySubSpillRel}]`,
        resultJson: JSON.stringify({
          summary: "Scout done",
          sources: [{ path: "README.md" }],
          artifact_paths: [`.harness/artifacts/${bucketRun.id}/${subTask.id}/scout.md`, legacySubSpillAbs],
          summary_overflow: { path: legacySubSpillRel, next_offset: 12, total_chars: 200 },
        }),
      });

      // --- PRE-MIGRATION CHECKS (real legacy units stay legacy under data-dir layout) ---
      const preReadNoteRel = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
        path: ".harness/notes/shared-note.md",
      })) as { path: string; content: string };
      assert.equal(preReadNoteRel.content, "v1 legacy note\n");
      assert.equal(preReadNoteRel.path, ".harness/notes/shared-note.md");

      const preReadEv = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
        path: `.harness/goals/${goal1.id}/evidence.md`,
      })) as { content: string };
      assert.equal(preReadEv.content, "goal evidence body\n");

      const preArt = (await daemon.director.executeDirectorMcpTool(chat1.id, "artifact_read", {
        path: `.harness/artifacts/${run1.id}/${task1.id}/findings.md`,
      })) as { content: string };
      assert.equal(preArt.content, "dossier findings content\n");

      const preGoalGet = (await daemon.director.executeDirectorMcpTool(chat1.id, "goal_get", {
        goal_id: goal1.id,
      })) as {
        evidenceDir: string;
        goal: { description: { path: string | null } };
        tasks: Array<{ id: string; artifactPaths?: string[] }>;
      };
      assert.equal(preGoalGet.evidenceDir, legacyGoalDir);
      assert.ok(isAbsolute(preGoalGet.goal.description.path!), `expected absolute description.path, got ${preGoalGet.goal.description.path}`);
      assert.equal(preGoalGet.goal.description.path, join(legacyGoalDir, "goal-description-v1.md"));
      const preDescRead = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
        path: preGoalGet.goal.description.path!,
      })) as { content: string };
      assert.equal(preDescRead.content, longDesc);

      // write_note before migration updates the real legacy file in place
      const preWrite = (await daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
        path: ".harness/notes/shared-note.md",
        content: "v2 pre-migration note\n",
        reason: "Update legacy note before migration",
      })) as { written: boolean; path: string };
      assert.equal(preWrite.written, true);
      assert.equal(preWrite.path, legacyNotePath);
      const chat2PreRead = (await daemon.director.executeDirectorMcpTool(chat2.id, "read_file", {
        path: ".harness/notes/shared-note.md",
      })) as { content: string };
      assert.equal(chat2PreRead.content, "v2 pre-migration note\n");

      // --- SIMULATED MIGRATION ---
      // 1. Ensure project dir & project.json
      const projectDir = sp.ensureProjectDir(repoRoot);
      const projectJsonPath = join(projectDir, "project.json");
      assert.ok(existsSync(projectJsonPath), "project.json should exist after ensureProjectDir");

      // 2. Migrate note file -> projectNotesDir + leave symlink bridge
      const migratedNotePath = join(sp.projectNotesDir(repoRoot), "shared-note.md");
      mkdirSync(dirname(migratedNotePath), { recursive: true });
      renameSync(legacyNotePath, migratedNotePath);
      symlinkSync(migratedNotePath, legacyNotePath);
      assert.ok(lstatSync(legacyNotePath).isSymbolicLink());

      // 3. Migrate goal dir -> chat1/goals/<goal1.id> + leave symlink bridge
      const migratedGoalDir = join(sp.goalsDir({ repoRoot, chatSessionId: chat1.id }), goal1.id);
      mkdirSync(dirname(migratedGoalDir), { recursive: true });
      renameSync(legacyGoalDir, migratedGoalDir);
      symlinkSync(migratedGoalDir, legacyGoalDir);
      const migratedEvFile = join(migratedGoalDir, "evidence.md");
      assert.ok(lstatSync(legacyGoalDir).isSymbolicLink());

      // 4. Migrate run1 artifacts dir + flat spill -> chat1/artifacts/ + rewrite DB rows + leave symlink bridges
      const chat1Artifacts = sp.artifactsDir({ repoRoot, chatSessionId: chat1.id });
      const legacyRunDir = join(repoRoot, ".harness", "artifacts", run1.id);
      const migratedRunDir = join(chat1Artifacts, run1.id);
      mkdirSync(dirname(migratedRunDir), { recursive: true });
      renameSync(legacyRunDir, migratedRunDir);
      symlinkSync(migratedRunDir, legacyRunDir);
      const migratedFindingsPath = join(migratedRunDir, task1.id, "findings.md");

      const migratedSpillPath = join(chat1Artifacts, `${task1.id}-summary-1.md`);
      renameSync(legacySpillAbs, migratedSpillPath);
      symlinkSync(migratedSpillPath, legacySpillAbs);

      // 5. Migrate Director-bucket task dir + flat spill -> chat1/artifacts/ + rewrite DB rows + leave symlink bridges
      const legacySubTaskDir = join(repoRoot, ".harness", "artifacts", bucketRun.id, subTask.id);
      const migratedSubTaskDir = join(chat1Artifacts, bucketRun.id, subTask.id);
      mkdirSync(dirname(migratedSubTaskDir), { recursive: true });
      renameSync(legacySubTaskDir, migratedSubTaskDir);
      symlinkSync(migratedSubTaskDir, legacySubTaskDir);
      const migratedScoutPath = join(migratedSubTaskDir, "scout.md");

      const migratedSubSpillPath = join(chat1Artifacts, `${subTask.id}-summary-1.md`);
      renameSync(legacySubSpillAbs, migratedSubSpillPath);
      symlinkSync(migratedSubSpillPath, legacySubSpillAbs);

      // Rewrite artifacts.path rows in SQLite (simulating migration transaction)
      daemon.db.db.prepare("UPDATE artifacts SET path = ? WHERE path = ?").run(migratedFindingsPath, legacyArt.path);
      daemon.db.db.prepare("UPDATE artifacts SET path = ? WHERE path = ?").run(migratedSpillPath, legacySpillAbs);
      daemon.db.db.prepare("UPDATE artifacts SET path = ? WHERE path = ?").run(migratedScoutPath, legacySubArt.path);
      daemon.db.db.prepare("UPDATE artifacts SET path = ? WHERE path = ?").run(migratedSubSpillPath, legacySubSpillAbs);

      // --- POST-MIGRATION CHECKS (c8) ---
      // 1. read_file and artifact_read by new absolute, old workspace-relative, and old absolute return identical content
      const evQueries = [
        migratedEvFile,
        `.harness/goals/${goal1.id}/evidence.md`,
        legacyEvFile,
      ];
      for (const q of evQueries) {
        const res = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", { path: q })) as {
          path: string;
          content: string;
        };
        assert.equal(res.content, "goal evidence body\n", `read_file failed for ${q}`);
        assert.equal(res.path, migratedEvFile, `read_file display should be migrated absolute path for ${q}`);
      }

      const artQueries = [
        migratedFindingsPath,
        `.harness/artifacts/${run1.id}/${task1.id}/findings.md`,
        legacyArt.path,
      ];
      for (const q of artQueries) {
        const rf = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", { path: q })) as {
          path: string;
          content: string;
        };
        assert.equal(rf.content, "dossier findings content\n", `read_file artifact failed for ${q}`);
        assert.equal(rf.path, migratedFindingsPath);

        const ar = (await daemon.director.executeDirectorMcpTool(chat1.id, "artifact_read", { path: q })) as {
          path: string;
          content: string;
        };
        assert.equal(ar.content, "dossier findings content\n", `artifact_read failed for ${q}`);
        assert.equal(ar.path, migratedFindingsPath);
      }

      // 2. write_note to old .harness/notes/shared-note.md updates the single migrated file; chat2 reads that same content
      const postWriteOld = (await daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
        path: ".harness/notes/shared-note.md",
        content: "v3 post-migration single file\n",
        reason: "Update migrated note via legacy path",
      })) as { written: boolean; path: string };
      assert.equal(postWriteOld.written, true);
      assert.equal(postWriteOld.path, migratedNotePath);
      assert.equal(readFileSync(migratedNotePath, "utf8"), "v3 post-migration single file\n");
      assert.equal(
        existsSync(join(sp.notesDir({ repoRoot, chatSessionId: chat1.id }), "shared-note.md")),
        false,
        "must not create a second per-chat copy for a legacy note path",
      );
      for (const q of [migratedNotePath, ".harness/notes/shared-note.md", legacyNotePath]) {
        const chat2Read = (await daemon.director.executeDirectorMcpTool(chat2.id, "read_file", { path: q })) as {
          path: string;
          content: string;
        };
        assert.equal(chat2Read.content, "v3 post-migration single file\n");
        assert.equal(chat2Read.path, migratedNotePath);
      }

      // 3. write_note into chat1's goals/ and notes/ dirs works; outside them is refused naming the new roots;
      //    dynamic __list_tools write_note description also names chat1's absolute new roots
      const tools = (await daemon.director.executeDirectorMcpTool(chat1.id, "__list_tools", {})) as ToolDefinition[];
      const writeNoteTool = tools.find((t) => t.name === "write_note");
      assert.ok(writeNoteTool);
      const chat1GoalsDir = sp.goalsDir({ repoRoot, chatSessionId: chat1.id });
      const chat1NotesDir = sp.notesDir({ repoRoot, chatSessionId: chat1.id });
      const projectNotesDir = sp.projectNotesDir(repoRoot);
      assert.ok(writeNoteTool.description.includes(chat1GoalsDir), writeNoteTool.description);
      assert.ok(writeNoteTool.description.includes(chat1NotesDir), writeNoteTool.description);
      assert.ok(writeNoteTool.description.includes(projectNotesDir), writeNoteTool.description);

      const newGoalNote = join(chat1GoalsDir, "goal-fresh", "scratch.md");
      const newChatNote = join(chat1NotesDir, "session-notes.md");
      const wgRes = (await daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
        path: newGoalNote,
        content: "goal note in data-dir\n",
        reason: "Write to chat goals dir",
      })) as { written: boolean; path: string };
      assert.equal(wgRes.written, true);
      assert.equal(wgRes.path, newGoalNote);

      const wnRes = (await daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
        path: newChatNote,
        content: "chat note in data-dir\n",
        reason: "Write to chat notes dir",
      })) as { written: boolean; path: string };
      assert.equal(wnRes.written, true);
      assert.equal(wnRes.path, newChatNote);

      await assert.rejects(
        () =>
          daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
            path: "src/outside.ts",
            content: "nope",
            reason: "Outside note roots",
          }),
        (err: Error) => {
          assert.match(err.message, /^\[harness blocked: director-note-root\] /);
          assert.ok(err.message.includes("goals/ or notes/ directory"), err.message);
          assert.ok(err.message.includes("project notes directory under the harness data directory"), err.message);
          return true;
        },
      );

      // 4. goal_get returns evidenceDir, description.path, and tasks[].artifactPaths that read_file accepts
      const postGoalGet = (await daemon.director.executeDirectorMcpTool(chat1.id, "goal_get", {
        goal_id: goal1.id,
      })) as {
        evidenceDir: string;
        goal: { description: { path: string | null } };
        tasks: Array<{ id: string; artifactPaths?: string[] }>;
      };
      assert.equal(postGoalGet.evidenceDir, migratedGoalDir);
      assert.ok(isAbsolute(postGoalGet.goal.description.path!), `expected absolute description.path, got ${postGoalGet.goal.description.path}`);
      assert.equal(postGoalGet.goal.description.path, join(migratedGoalDir, "goal-description-v1.md"));
      const postDescRead = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
        path: postGoalGet.goal.description.path!,
      })) as { content: string };
      assert.equal(postDescRead.content, longDesc);

      const postWorkerRow = postGoalGet.tasks.find((t) => t.id === task1.id);
      assert.deepEqual(postWorkerRow?.artifactPaths, [migratedFindingsPath, migratedSpillPath]);
      for (const artPath of postWorkerRow!.artifactPaths!) {
        const readViaGoalGet = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
          path: artPath,
        })) as { content: string };
        assert.ok(readViaGoalGet.content.length > 0);
      }

      // Brand-new goal in data-dir layout creates evidenceDir + description.path directly under data-dir
      const freshGoal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat1.id,
        title: "Fresh data-dir goal",
        description: "Brand new long description. ".repeat(90),
        criteria: [{ id: "c1", kind: "behavioral", description: "Works", required: true }],
      });
      const freshGoalGet = (await daemon.director.executeDirectorMcpTool(chat1.id, "goal_get", {
        goal_id: freshGoal.id,
      })) as { evidenceDir: string; goal: { description: { path: string | null } } };
      assert.equal(freshGoalGet.evidenceDir, join(chat1GoalsDir, freshGoal.id));
      assert.equal(freshGoalGet.goal.description.path, join(chat1GoalsDir, freshGoal.id, "goal-description-v1.md"));
      assert.equal(existsSync(join(repoRoot, ".harness", "goals", freshGoal.id)), false);
      const freshDescRead = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
        path: freshGoalGet.goal.description.path!,
      })) as { content: string };
      assert.equal(freshDescRead.content, freshGoal.description);

      // 5. wait_tasks maps legacy artifact_paths and full_summary.path to migrated absolute data-dir paths
      await daemon.director.sendChatMessage(chat1.id, `RUN_WAIT_TASKS:${subTask.id}`);
      const waitRes = lastWaitTasksResult as {
        children: Array<{
          id: string;
          artifact_paths: string[];
          full_summary?: { path: string };
        }>;
      };
      assert.equal(waitRes.children.length, 1);
      assert.deepEqual(waitRes.children[0]!.artifact_paths, [migratedScoutPath, migratedSubSpillPath]);
      assert.equal(waitRes.children[0]!.full_summary?.path, migratedSubSpillPath);
      const waitSpillRead = (await daemon.director.executeDirectorMcpTool(chat1.id, "artifact_read", {
        path: waitRes.children[0]!.full_summary!.path,
      })) as { content: string };
      assert.equal(waitSpillRead.content, "scout overflow summary\n");

      // 6. goal_accept accepts evidence_paths in BOTH old and new forms
      daemon.director.goals.setStatus(goal1.id, "awaiting_human", "ready");
      const accepted = await daemon.director.acceptGoalOverride(goal1.id, {
        reason: "Verified via old and new paths",
        evidencePaths: [`.harness/goals/${goal1.id}/evidence.md`, legacyEvFile, migratedEvFile],
        source: "director",
        chatSessionId: chat1.id,
      });
      assert.equal(accepted.goal.status, "achieved");
      assert.equal(accepted.review.audit?.evidence.length, 3);
      for (const item of accepted.review.audit!.evidence) {
        assert.equal(item.canonicalPath, migratedEvFile);
      }

      // 7. Refusals: worktree under data-dir, another project's worktree, scratch, project.json,
      //    control-plane.sqlite, config.json, and stateDir root are ALL refused by read_file and write_note
      const ownWorktreeFile = join(
        sp.worktreePath({ repoRoot, id: "run-99", chatSessionId: chat1.id }, "t-1"),
        "secret.ts",
      );
      const otherProjWorktreeFile = join(
        sp.worktreePath({ repoRoot: otherRepoRoot, id: "run-88", chatSessionId: "chat-other" }, "t-2"),
        "secret.ts",
      );
      const scratchFile = join(sp.scratchPath(repoRoot, "_verify", "goal-check"), "secret.ts");
      for (const f of [ownWorktreeFile, otherProjWorktreeFile, scratchFile]) {
        mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, "protected\n", "utf8");
      }

      const protectedPaths = [
        ownWorktreeFile,
        otherProjWorktreeFile,
        scratchFile,
        projectJsonPath,
        join(stateDir, "control-plane.sqlite"),
        join(stateDir, "config.json"),
        stateDir,
      ];
      for (const p of protectedPaths) {
        await assert.rejects(
          () => daemon.director.executeDirectorMcpTool(chat1.id, "read_file", { path: p }),
          /\[harness blocked: director-protected-read\]/,
          `read_file must refuse ${p}`,
        );
        await assert.rejects(
          () =>
            daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
              path: p,
              content: "nope",
              reason: "Attempt protected write",
            }),
          /\[harness blocked: director-note-root\]/,
          `write_note must refuse ${p}`,
        );
        assert.throws(
          () => resolveDirectorReadablePath(repoRoot, p, { storage: sp, owner: { repoRoot, chatSessionId: chat1.id } }),
          /\[harness blocked: director-protected-read\]/,
        );
      }

      // 8. Another chat's goals dir of the same project is readable by chat1, but NOT writable by chat1
      const chat2GoalFile = join(sp.goalsDir({ repoRoot, chatSessionId: chat2.id }), "goal-other", "evidence.md");
      mkdirSync(dirname(chat2GoalFile), { recursive: true });
      writeFileSync(chat2GoalFile, "chat2 goal evidence\n", "utf8");

      const crossChatRead = (await daemon.director.executeDirectorMcpTool(chat1.id, "read_file", {
        path: chat2GoalFile,
      })) as { path: string; content: string };
      assert.equal(crossChatRead.content, "chat2 goal evidence\n");
      assert.equal(crossChatRead.path, chat2GoalFile);

      await assert.rejects(
        () =>
          daemon.director.executeDirectorMcpTool(chat1.id, "write_note", {
            path: chat2GoalFile,
            content: "overwrite attempt",
            reason: "Cross-chat write should fail",
          }),
        /\[harness blocked: director-note-root\]/,
      );
      assert.equal(readFileSync(chat2GoalFile, "utf8"), "chat2 goal evidence\n");
    } finally {
      await daemon.stop();
    }
  });

  it("passes data-dir taskGrants and deniedRoots to Done-Reviewer (with and without linked run) and passes chatSessionId on goal launch", async () => {
    setLayoutEnv("data-dir");
    const { root, repoRoot } = await makeTempGitRepo("pi-dir-rev-dd-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });

    const config = makeConfig(repoRoot, stateDir);
    const sp = storagePaths(config, { layout: "data-dir" });
    const capturedReviewReqs: RunAgentRequest[] = [];

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.tools.some((t) => t.name === "submit_review_verdict")) {
            capturedReviewReqs.push(req);
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              summary: "Data-dir review approved",
              criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Checked data-dir evidence" }],
            });
            return { stopReason: "completed", text: "approved" };
          }
          return { stopReason: "completed", text: "done" };
        },
      }),
    });

    try {
      const chat = await daemon.director.createChat({ repoRoot });

      // 1. Goal WITHOUT linked run: Done-Reviewer uses its own review run and gets data-dir taskGrants + deniedRoots
      const unlinkedGoal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat.id,
        title: "Unlinked data-dir review",
        description: "Review without a linked run",
        criteria: [{ id: "c1", kind: "behavioral", description: "Check", required: true }],
      });
      await daemon.director.verifyAndReviewGoal(unlinkedGoal.id);
      assert.equal(capturedReviewReqs.length, 1);
      const unlinkedReq = capturedReviewReqs[0]!;
      const expectedEvDir = sp.goalEvidenceDir({ repoRoot, id: unlinkedGoal.id, chatSessionId: chat.id });
      assert.equal(unlinkedReq.extraEnv?.HARNESS_GOAL_EVIDENCE_DIR, expectedEvDir);
      assert.equal(unlinkedReq.extraEnv?.HARNESS_GOALS_DIR, sp.goalsDir({ repoRoot, chatSessionId: chat.id }));
      assert.equal(unlinkedReq.extraEnv?.HARNESS_ARTIFACTS_DIR, sp.artifactsDir({ repoRoot, chatSessionId: chat.id }));
      assert.equal(unlinkedReq.extraWriteRoots, undefined);
      assert.deepEqual(unlinkedReq.deniedRoots, [realpathSync(stateDir)]);
      assert.deepEqual(unlinkedReq.protectedRoots, []);
      assert.equal(existsSync(join(repoRoot, ".harness")), false, "no in-repo .harness dir should be created");

      // 2. Goal WITH linked run via commitGoalDetailed: run records chatSessionId and reviewer gets runArtifactsDir
      const linkedGoal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat.id,
        title: "Committed data-dir goal",
        description: "Run created with goal chatSessionId",
        criteria: [{ id: "c1", kind: "behavioral", description: "Check", required: true }],
      });
      const commitRes = await daemon.director.commitGoalDetailed(linkedGoal.id, {});
      assert.ok(commitRes.goal.linkedRunId, "commitGoalDetailed should link a run");
      const createdRun = daemon.db.getRun(commitRes.goal.linkedRunId!);
      assert.equal(createdRun?.chatSessionId, chat.id, "startRun must record the goal's chatSessionId");

      // Trigger Done-Reviewer on the linked goal
      await daemon.director.verifyAndReviewGoal(linkedGoal.id);
      assert.equal(capturedReviewReqs.length, 2);
      const linkedReq = capturedReviewReqs[1]!;
      const expectedRunArtDir = sp.runArtifactsDir({
        repoRoot,
        id: commitRes.goal.linkedRunId!,
        chatSessionId: chat.id,
      });
      assert.ok(
        linkedReq.initialPrompt.includes(expectedRunArtDir),
        `reviewer prompt should name data-dir runArtifactsDir ${expectedRunArtDir}`,
      );
      assert.deepEqual(linkedReq.deniedRoots, [realpathSync(stateDir)]);
      assert.equal(existsSync(join(repoRoot, ".harness")), false, "no in-repo .harness dir should be created");
    } finally {
      await daemon.stop();
    }
  });
});
