import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agent } from "@agentclientprotocol/sdk/unstable";
import { loadConfig, type AcpProfileConfig, type HarnessConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { GoalEngine } from "../src/goals/engine.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { checkReadOnlyArgv, DENIED_HARNESS_STATE_REASON, type ReadOnlyShellScope } from "../src/runners/acp-shims.js";
import type { RunAgentRequest } from "../src/runners/types.js";
import { resetStoragePathsForTest, storagePaths, type TaskGrants } from "../src/storage/paths.js";
import { runGit, WorktreeManager } from "../src/worktree/manager.js";

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
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function initTempGitRepo(root: string, name: string): Promise<string> {
  const repoRoot = join(root, name);
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), `# ${name}\n`, "utf8");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "app.ts"), "export const ok = true;\n", "utf8");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return repoRoot;
}

const claudeProfile: AcpProfileConfig = {
  id: "acp:claude",
  kind: "acp",
  adapter: "claude",
  command: "unused",
  billing: "subscription",
};

function errorDetail(err: unknown): string {
  const data = (err as { data?: { details?: unknown } })?.data;
  if (typeof data?.details === "string") return data.details;
  return err instanceof Error ? err.message : String(err);
}

interface MatrixRow {
  id: string;
  target: string;
  isDir?: boolean;
  expectRead: "allow" | "deny";
  expectWrite: "allow" | "deny";
  /**
   * Surfaces to skip because an existing test already proves this exact row on that surface
   * with real `storage.taskGrants`.
   */
  skipInspectCommand?: boolean;
  /** File path used for ACP native fs write test (for dir rows, a child file under that dir). */
  writeTarget?: string;
}

interface MatrixFixture {
  root: string;
  repoA: string;
  repoB: string;
  stateDir: string;
  config: HarnessConfig;
  db: ControlPlaneDb;
  wtMgr: WorktreeManager;
  exec: ControlPlaneToolExecutor;
  runAId: string;
  workerTaskId: string;
  readerTaskId: string;
  ownWtPath: string;
  workerGrants: TaskGrants;
  readerGrants: TaskGrants;
  rows: MatrixRow[];
}

async function createMatrixFixture(extraReadRoots: string[]): Promise<MatrixFixture> {
  setLayoutEnv("data-dir");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-c4-")));
  tempDirs.push(root);

  const repoA = await initTempGitRepo(root, "repo-a");
  const repoB = await initTempGitRepo(root, "repo-b");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });

  const base = loadConfig(repoA);
  const config: HarnessConfig = {
    ...base,
    stateDir,
    storage: { dataDir: join(stateDir, "data") },
    codeMode: "off",
    worktree: {
      ...base.worktree,
      extraReadRoots,
      extraWriteRoots: [],
    },
  };

  const sp = storagePaths(config, { layout: "data-dir" });
  assert.equal(sp.layout, "data-dir");
  const db = new ControlPlaneDb(":memory:");
  const wtMgr = new WorktreeManager(db, repoA, config.worktree, { stateDir }, sp);
  const goals = new GoalEngine(db.db, undefined, undefined, undefined, undefined, sp);

  const chatA = "chat-a";
  const chatB = "chat-b";

  const goalA = goals.createGoal({
    chatSessionId: chatA,
    repoRoot: repoA,
    title: "Chat A goal",
    description: "C4 matrix goal A",
    criteria: [{ id: "c1", kind: "behavioral", description: "Grants enforced", required: true }],
  });
  const goalB = goals.createGoal({
    chatSessionId: chatB,
    repoRoot: repoA,
    title: "Chat B goal",
    description: "C4 matrix goal B",
    criteria: [{ id: "c1", kind: "behavioral", description: "Isolated", required: true }],
  });

  const baseSha = (await runGit(repoA, ["rev-parse", "HEAD"])).stdout.trim();
  const runA = db.createRun({ goal: goalA.title, repoRoot: repoA, baseBranch: "main", baseSha, chatSessionId: chatA });
  goals.linkRunAndStart(goalA.id, runA.id);

  const worker = db.createTask({
    runId: runA.id,
    tier: 2,
    kind: "worker",
    title: "Worker A",
    objective: "Own worktree",
    profileId: "acp:claude",
  });
  const ownWt = await wtMgr.createForWorker(runA.id, worker.id);
  db.updateTask(worker.id, { status: "running", worktreeId: ownWt.id });

  const sibling = db.createTask({
    runId: runA.id,
    tier: 2,
    kind: "worker",
    title: "Sibling A",
    objective: "Sibling worktree",
    profileId: "acp:claude",
  });
  const siblingWt = await wtMgr.createForWorker(runA.id, sibling.id);
  db.updateTask(sibling.id, { status: "running", worktreeId: siblingWt.id });

  const reader = db.createTask({
    runId: runA.id,
    parentId: worker.id,
    tier: 3,
    kind: "research",
    title: "Read-only Tier 3 A",
    objective: "Read granted state-dir subpath",
    profileId: "acp:claude",
    readOnly: true,
  });
  db.updateTask(reader.id, { status: "running", worktreeId: ownWt.id });

  // Populate every target on disk.
  const ownEvidenceDir = sp.ensureGoalEvidenceDir({ repoRoot: repoA, id: goalA.id, chatSessionId: chatA })!;
  const ownEvidenceFile = join(ownEvidenceDir, "ev-a.txt");
  writeFileSync(ownEvidenceFile, "own evidence\n", "utf8");

  const ownRunArtDir = sp.ensureDossierDir({ repoRoot: repoA, id: runA.id, chatSessionId: chatA }, runA.id, worker.id);
  const ownRunArtFile = join(ownRunArtDir, "dossier-a.md");
  writeFileSync(ownRunArtFile, "own run artifact\n", "utf8");

  const ownChatNotesDir = sp.notesDir({ repoRoot: repoA, chatSessionId: chatA });
  mkdirSync(ownChatNotesDir, { recursive: true });
  const ownChatNoteFile = join(ownChatNotesDir, "chat-a-note.md");
  writeFileSync(ownChatNoteFile, "own chat note\n", "utf8");

  const projNotesDir = sp.projectNotesDir(repoA);
  mkdirSync(projNotesDir, { recursive: true });
  const projNoteFile = join(projNotesDir, "proj-note.md");
  writeFileSync(projNoteFile, "project note\n", "utf8");

  const legacyChatGoalsDir = sp.goalsDir({ repoRoot: repoA, chatSessionId: null });
  mkdirSync(legacyChatGoalsDir, { recursive: true });
  const legacyChatFile = join(legacyChatGoalsDir, "legacy-item.md");
  writeFileSync(legacyChatFile, "chats legacy content\n", "utf8");

  const chatBGoalsDir = sp.ensureGoalEvidenceDir({ repoRoot: repoA, id: goalB.id, chatSessionId: chatB })!;
  const chatBGoalFile = join(chatBGoalsDir, "secret-b.txt");
  writeFileSync(chatBGoalFile, "chat B secret\n", "utf8");

  const otherProjGoalsDir = sp.ensureGoalEvidenceDir({ repoRoot: repoB, id: "goal-other-proj", chatSessionId: chatA })!;
  const otherProjFile = join(otherProjGoalsDir, "other-proj.txt");
  writeFileSync(otherProjFile, "other project secret\n", "utf8");

  const dbFile = join(stateDir, "control-plane.sqlite");
  const configFile = join(stateDir, "config.json");
  const installDir = join(stateDir, "install");
  const installFile = join(installDir, "release.txt");
  const toolsDir = join(stateDir, "tools");
  const toolsFile = join(toolsDir, "octofs.txt");
  writeFileSync(dbFile, "sqlite-secret\n", "utf8");
  writeFileSync(configFile, '{"secret":"cfg"}\n', "utf8");
  mkdirSync(installDir, { recursive: true });
  writeFileSync(installFile, "install-secret\n", "utf8");
  mkdirSync(toolsDir, { recursive: true });
  writeFileSync(toolsFile, "tools-secret\n", "utf8");

  const siblingWtFile = join(siblingWt.path, "sibling-secret.txt");
  writeFileSync(siblingWtFile, "sibling worktree secret\n", "utf8");

  const scratchDir = sp.scratchPath(repoA, "_verify", "c4-scratch");
  mkdirSync(scratchDir, { recursive: true });
  const scratchFile = join(scratchDir, "scratch-secret.txt");
  writeFileSync(scratchFile, "scratch secret\n", "utf8");

  const ownWtFile = join(ownWt.path, "src", "app.ts");

  const symlinkToConfig = join(ownEvidenceDir, "symlink-to-config.json");
  symlinkSync(configFile, symlinkToConfig);

  const runRef = { repoRoot: repoA, id: runA.id, chatSessionId: chatA };
  const goalRef = { repoRoot: repoA, id: goalA.id, chatSessionId: chatA };
  const workerGrants = sp.taskGrants({ run: runRef, goal: goalRef, writable: true, workspace: ownWt.path });
  const readerGrants = sp.taskGrants({ run: runRef, goal: goalRef, writable: false, workspace: ownWt.path });

  const hooks: ToolRuntimeHooks = {
    spawnAndStartTask: async () => {
      throw new Error("unused");
    },
    waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
    steerTask: async () => false,
    cancelTask: async () => {},
    scheduleRollover: async () => {},
    getWorktreeManager: () => wtMgr,
    getMergeQueue: () => {
      throw new Error("unused");
    },
    getTaskSignal: () => undefined,
  };
  const exec = new ControlPlaneToolExecutor(db, () => {
    throw new Error("unused");
  }, hooks, config);

  const rows: MatrixRow[] = [
    {
      id: "own-evidence-dir",
      target: ownEvidenceFile,
      writeTarget: join(ownEvidenceDir, "worker-write.txt"),
      expectRead: "allow",
      expectWrite: "allow",
      // Already proven on inspect_command in test/storage-inspect-grants.test.ts
      skipInspectCommand: true,
    },
    {
      id: "own-run-artifacts-dir",
      target: ownRunArtFile,
      writeTarget: join(ownRunArtDir, "tamper.txt"),
      expectRead: "allow",
      expectWrite: "deny",
      // Already proven on inspect_command in test/storage-inspect-grants.test.ts
      skipInspectCommand: true,
    },
    {
      id: "own-chat-notes",
      target: ownChatNoteFile,
      writeTarget: join(ownChatNotesDir, "tamper-note.md"),
      expectRead: "allow",
      expectWrite: "deny",
    },
    {
      id: "project-notes-dir",
      target: projNoteFile,
      writeTarget: join(projNotesDir, "tamper-proj-note.md"),
      expectRead: "allow",
      expectWrite: "deny",
    },
    {
      id: "chats-legacy",
      target: legacyChatFile,
      writeTarget: join(legacyChatGoalsDir, "tamper-legacy.md"),
      expectRead: "allow",
      expectWrite: "deny",
    },
    {
      id: "chat-b-goals-dir",
      target: chatBGoalFile,
      writeTarget: join(chatBGoalsDir, "tamper-b.txt"),
      expectRead: "deny",
      expectWrite: "deny",
      // Already proven on inspect_command (without extraReadRoots=[stateDir]) in test/storage-inspect-grants.test.ts
      skipInspectCommand: extraReadRoots.length === 0,
    },
    {
      id: "other-project-dir",
      target: otherProjFile,
      writeTarget: join(otherProjGoalsDir, "tamper-other.txt"),
      expectRead: "deny",
      expectWrite: "deny",
    },
    {
      id: "state-dir-root",
      target: stateDir,
      isDir: true,
      writeTarget: join(stateDir, "tamper-root.txt"),
      expectRead: "deny",
      expectWrite: "deny",
      skipInspectCommand: extraReadRoots.length === 0,
    },
    {
      id: "control-plane-sqlite",
      target: dbFile,
      expectRead: "deny",
      expectWrite: "deny",
      skipInspectCommand: extraReadRoots.length === 0,
    },
    {
      id: "config-json",
      target: configFile,
      expectRead: "deny",
      expectWrite: "deny",
      skipInspectCommand: extraReadRoots.length === 0,
    },
    {
      id: "state-install-dir",
      target: installFile,
      writeTarget: join(installDir, "tamper-install.txt"),
      expectRead: "deny",
      expectWrite: "deny",
    },
    {
      id: "state-tools-dir",
      target: toolsFile,
      writeTarget: join(toolsDir, "tamper-tools.txt"),
      expectRead: "deny",
      expectWrite: "deny",
    },
    {
      id: "sibling-worktree",
      target: siblingWtFile,
      writeTarget: join(siblingWt.path, "tamper-sibling.txt"),
      expectRead: "deny",
      expectWrite: "deny",
      skipInspectCommand: extraReadRoots.length === 0,
    },
    {
      id: "scratch-dir",
      target: scratchFile,
      writeTarget: join(scratchDir, "tamper-scratch.txt"),
      expectRead: "deny",
      expectWrite: "deny",
    },
    {
      id: "own-worktree",
      target: ownWtFile,
      writeTarget: join(ownWt.path, "own-write.txt"),
      expectRead: "allow",
      expectWrite: "allow",
    },
    {
      id: "symlink-in-granted-dir-to-config",
      target: symlinkToConfig,
      writeTarget: symlinkToConfig,
      expectRead: "deny",
      expectWrite: "deny",
    },
  ];

  return {
    root,
    repoA,
    repoB,
    stateDir,
    config,
    db,
    wtMgr,
    exec,
    runAId: runA.id,
    workerTaskId: worker.id,
    readerTaskId: reader.id,
    ownWtPath: ownWt.path,
    workerGrants,
    readerGrants,
    rows,
  };
}

function makeBaseAcpRequest(overrides: Partial<RunAgentRequest> & { cwd: string }): RunAgentRequest {
  return {
    runId: "run-c4",
    taskId: "t-c4",
    tier: 2,
    kind: "worker",
    toolPolicy: "read_write_workspace",
    systemPrompt: "C4 test",
    initialPrompt: "Check grants",
    model: "opus",
    maxTurns: 1,
    tools: [],
    executeTool: async () => ({}),
    signal: new AbortController().signal,
    callbacks: {},
    ...overrides,
  };
}

async function runAcpMatrix(
  fx: MatrixFixture,
  grants: TaskGrants,
  toolPolicy: "read_write_workspace" | "read_only_workspace",
  rows: MatrixRow[],
): Promise<Map<string, { readOk: boolean; readErr?: string; writeOk: boolean; writeErr?: string }>> {
  const results = new Map<string, { readOk: boolean; readErr?: string; writeOk: boolean; writeErr?: string }>();
  const fixture = agent()
    .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
    .onRequest("session/new", async () => ({
      sessionId: `s-c4-${toolPolicy}`,
      models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
    }))
    .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
      for (const row of rows) {
        let readOk = false;
        let readErr: string | undefined;
        try {
          await client.request("fs/read_text_file", { sessionId, path: row.target });
          readOk = true;
        } catch (err) {
          readErr = errorDetail(err);
        }

        const wTarget = row.writeTarget ?? row.target;
        let writeOk = false;
        let writeErr: string | undefined;
        try {
          await client.request("fs/write_text_file", { sessionId, path: wTarget, content: "c4-probe-write\n" });
          writeOk = true;
        } catch (err) {
          writeErr = errorDetail(err);
        }

        results.set(row.id, { readOk, readErr, writeOk, writeErr });
      }
      await client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      });
      return { stopReason: "end_turn" };
    });

  await new AcpRunner(claudeProfile).run(
    makeBaseAcpRequest({
      cwd: fx.ownWtPath,
      tier: toolPolicy === "read_only_workspace" ? 3 : 2,
      kind: toolPolicy === "read_only_workspace" ? "research" : "worker",
      toolPolicy,
      extraReadRoots: grants.extraReadRoots,
      extraWriteRoots: grants.extraWriteRoots,
      extraEnv: grants.extraEnv,
      deniedRoots: grants.deniedRoots,
      protectedRoots: grants.protectedRoots,
    }),
    fixture,
  );
  return results;
}

describe("goal criterion c4: data-dir taskGrants refusal matrix across inspect_command, checkReadOnlyArgv, and AcpRunner", () => {
  it("enforces all allow and refusal rows across inspect_command, checkReadOnlyArgv, and AcpRunner native fs (writable goal worker + read-only Tier 3)", async () => {
    const fx = await createMatrixFixture([]);
    try {
      const sp = storagePaths(fx.config, { layout: "data-dir" });

      // 1. Absolute-root protected worktree rule
      const siblingRow = fx.rows.find((r) => r.id === "sibling-worktree")!;
      const scratchRow = fx.rows.find((r) => r.id === "scratch-dir")!;
      const ownWtRow = fx.rows.find((r) => r.id === "own-worktree")!;
      assert.equal(sp.isProtectedWorktreePath(siblingRow.target, fx.ownWtPath), true);
      assert.equal(sp.isProtectedWorktreePath(scratchRow.target, fx.ownWtPath), true);
      assert.equal(sp.isProtectedWorktreePath(ownWtRow.target, fx.ownWtPath), false);

      // 2. Surface A: checkReadOnlyArgv fed with real storage.taskGrants
      const workerReadRoots = [
        fx.ownWtPath,
        ...fx.workerGrants.extraReadRoots,
        ...(fx.workerGrants.extraWriteRoots ?? []),
      ];
      const workerScope: ReadOnlyShellScope = {
        cwd: fx.ownWtPath,
        readRoots: workerReadRoots,
        deniedRoots: fx.workerGrants.deniedRoots,
        protectedRoots: workerReadRoots,
      };
      for (const row of fx.rows) {
        const argv = row.isDir ? ["ls", row.target] : ["cat", row.target];
        const verdict = checkReadOnlyArgv(argv, workerScope);
        if (row.expectRead === "allow") {
          assert.deepEqual(verdict, { ok: true }, `checkReadOnlyArgv must allow ${row.id}`);
        } else {
          assert.equal(verdict.ok, false, `checkReadOnlyArgv must refuse ${row.id}`);
          assert.equal(
            verdict.reason,
            DENIED_HARNESS_STATE_REASON,
            `checkReadOnlyArgv refusal for ${row.id} must name harness state, got: ${verdict.reason}`,
          );
        }
      }

      // 3. Surface B: inspect_command (tools.ts) for rows not already proven in test/storage-inspect-grants.test.ts
      for (const row of fx.rows) {
        if (row.skipInspectCommand) continue;
        const argv = row.isDir ? ["ls", row.target] : ["cat", row.target];
        if (row.expectRead === "allow") {
          const res = (await fx.exec.execute(fx.runAId, fx.readerTaskId, "inspect_command", { argv })) as {
            exit_code: number;
            stdout: string;
          };
          assert.equal(res.exit_code, 0, `inspect_command must allow ${row.id}`);
        } else {
          await assert.rejects(
            () => fx.exec.execute(fx.runAId, fx.readerTaskId, "inspect_command", { argv }),
            (err: Error) => {
              assert.match(err.message, /read-only-argv/, `inspect_command refusal for ${row.id}`);
              assert.ok(
                err.message.includes(DENIED_HARNESS_STATE_REASON),
                `inspect_command refusal for ${row.id} must name harness state, got: ${err.message}`,
              );
              return true;
            },
          );
        }
      }

      // 4. Surface C: AcpRunner native fs/read_text_file & fs/write_text_file (writable goal worker)
      const workerAcp = await runAcpMatrix(fx, fx.workerGrants, "read_write_workspace", fx.rows);
      for (const row of fx.rows) {
        const res = workerAcp.get(row.id)!;
        if (row.expectRead === "allow") {
          assert.equal(res.readOk, true, `AcpRunner worker read must allow ${row.id} (err: ${res.readErr})`);
        } else {
          assert.equal(res.readOk, false, `AcpRunner worker read must refuse ${row.id}`);
          assert.ok(
            res.readErr?.includes(DENIED_HARNESS_STATE_REASON),
            `AcpRunner worker read refusal for ${row.id} must name harness state, got: ${res.readErr}`,
          );
        }
        if (row.expectWrite === "allow") {
          assert.equal(res.writeOk, true, `AcpRunner worker write must allow ${row.id} (err: ${res.writeErr})`);
          assert.equal(readFileSync(row.writeTarget ?? row.target, "utf8"), "c4-probe-write\n");
        } else {
          assert.equal(res.writeOk, false, `AcpRunner worker write must refuse ${row.id}`);
          assert.ok(
            res.writeErr?.includes(DENIED_HARNESS_STATE_REASON),
            `AcpRunner worker write refusal for ${row.id} must name harness state, got: ${res.writeErr}`,
          );
          if (row.writeTarget && row.writeTarget !== row.target) {
            assert.equal(existsSync(row.writeTarget), false, `no file should be created for refused write ${row.id}`);
          }
        }
      }

      // 5. Read-only Tier 3 task reads granted subpaths of stateDir and cannot write them
      const roRows = fx.rows.filter((r) =>
        ["own-evidence-dir", "own-run-artifacts-dir", "own-chat-notes", "project-notes-dir", "chats-legacy", "config-json"].includes(r.id),
      );
      const roScope: ReadOnlyShellScope = {
        cwd: fx.ownWtPath,
        readRoots: [fx.ownWtPath, ...fx.readerGrants.extraReadRoots],
        deniedRoots: fx.readerGrants.deniedRoots,
        protectedRoots: [fx.ownWtPath, ...fx.readerGrants.extraReadRoots],
      };
      for (const row of roRows) {
        const verdict = checkReadOnlyArgv(["cat", row.target], roScope);
        assert.equal(verdict.ok, row.expectRead === "allow", `checkReadOnlyArgv read-only ${row.id}`);
      }
      const roInspectNote = (await fx.exec.execute(fx.runAId, fx.readerTaskId, "inspect_command", {
        argv: ["cat", fx.rows.find((r) => r.id === "own-chat-notes")!.target],
      })) as { exit_code: number; stdout: string };
      assert.equal(roInspectNote.exit_code, 0);
      assert.equal(roInspectNote.stdout, "own chat note\n");

      const roAcp = await runAcpMatrix(fx, fx.readerGrants, "read_only_workspace", roRows);
      for (const row of roRows) {
        const res = roAcp.get(row.id)!;
        assert.equal(res.readOk, row.expectRead === "allow", `AcpRunner read-only read ${row.id} (err: ${res.readErr})`);
        assert.equal(res.writeOk, false, `AcpRunner read-only write must always refuse ${row.id}`);
        assert.match(res.writeErr ?? "", /^\[harness blocked: read-only-write\] /);
      }
    } finally {
      fx.db.close();
    }
  });

  it("refuses all denied rows when config worktree.extraReadRoots covers parent of stateDir", async () => {
    const fx = await createMatrixFixture([]);
    const parentOfState = dirname(fx.stateDir);
    const configWithParentRead: HarnessConfig = {
      ...fx.config,
      worktree: {
        ...fx.config.worktree,
        extraReadRoots: [parentOfState],
        extraWriteRoots: [],
      },
    };
    const sp = storagePaths(configWithParentRead, { layout: "data-dir" });
    const runRecord = fx.db.getRun(fx.runAId)!;
    const goals = new GoalEngine(fx.db.db, undefined, undefined, undefined, undefined, sp);
    const goal = goals.listGoals()[0]!;
    const grants = sp.taskGrants({
      run: { repoRoot: fx.repoA, id: runRecord.id, chatSessionId: runRecord.chatSessionId },
      goal: { repoRoot: fx.repoA, id: goal.id, chatSessionId: goal.chatSessionId },
      writable: true,
      workspace: fx.ownWtPath,
    });
    const execWithParentRead = new ControlPlaneToolExecutor(
      fx.db,
      () => {
        throw new Error("unused");
      },
      {
        spawnAndStartTask: async () => {
          throw new Error("unused");
        },
        waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
        steerTask: async () => false,
        cancelTask: async () => {},
        scheduleRollover: async () => {},
        getWorktreeManager: () => fx.wtMgr,
        getMergeQueue: () => {
          throw new Error("unused");
        },
        getTaskSignal: () => undefined,
      },
      configWithParentRead,
    );

    const refusalRows = fx.rows.filter((r) => r.expectRead === "deny");
    try {
      const readRoots = [fx.ownWtPath, ...grants.extraReadRoots, ...(grants.extraWriteRoots ?? [])];
      const scope: ReadOnlyShellScope = {
        cwd: fx.ownWtPath,
        readRoots,
        deniedRoots: grants.deniedRoots,
        protectedRoots: readRoots,
      };
      const acpRes = await runAcpMatrix(fx, grants, "read_write_workspace", refusalRows);

      for (const row of refusalRows) {
        const argv = row.isDir ? ["ls", row.target] : ["cat", row.target];
        const shimVerdict = checkReadOnlyArgv(argv, scope);
        assert.equal(shimVerdict.ok, false, `checkReadOnlyArgv must refuse ${row.id} under parent extraReadRoots`);
        assert.equal(shimVerdict.reason, DENIED_HARNESS_STATE_REASON);

        await assert.rejects(
          () => execWithParentRead.execute(fx.runAId, fx.readerTaskId, "inspect_command", { argv }),
          (err: Error) => {
            assert.match(err.message, /read-only-argv/);
            assert.ok(err.message.includes(DENIED_HARNESS_STATE_REASON));
            return true;
          },
        );

        const acpRow = acpRes.get(row.id)!;
        assert.equal(acpRow.readOk, false, `AcpRunner read must refuse ${row.id} under parent extraReadRoots`);
        assert.ok(acpRow.readErr?.includes(DENIED_HARNESS_STATE_REASON));
        assert.equal(acpRow.writeOk, false, `AcpRunner write must refuse ${row.id} under parent extraReadRoots`);
        assert.ok(acpRow.writeErr?.includes(DENIED_HARNESS_STATE_REASON));
      }
    } finally {
      fx.db.close();
    }
  });

  // Known src/ defect (esc-148): StoragePaths.taskGrants appends config.worktree.extraReadRoots verbatim,
  // causing extraReadRoots=[stateDir] to tie with deniedRoots=[stateDir] in mostSpecificRootDecision (allowed wins ties).
  // Flip it.failing -> it once StoragePaths.taskGrants filters stateDir/dataRoot out of configured extra roots.
  it.failing("refuses all denied rows even when config worktree.extraReadRoots = [stateDir] (defect esc-148)", async () => {
    const fx = await createMatrixFixture([]);
    const configWithStateRead: HarnessConfig = {
      ...fx.config,
      worktree: {
        ...fx.config.worktree,
        extraReadRoots: [fx.stateDir],
        extraWriteRoots: [],
      },
    };
    const sp = storagePaths(configWithStateRead, { layout: "data-dir" });
    const runRecord = fx.db.getRun(fx.runAId)!;
    const goals = new GoalEngine(fx.db.db, undefined, undefined, undefined, undefined, sp);
    const goal = goals.listGoals()[0]!;
    const grants = sp.taskGrants({
      run: { repoRoot: fx.repoA, id: runRecord.id, chatSessionId: runRecord.chatSessionId },
      goal: { repoRoot: fx.repoA, id: goal.id, chatSessionId: goal.chatSessionId },
      writable: true,
      workspace: fx.ownWtPath,
    });
    const execWithStateRead = new ControlPlaneToolExecutor(
      fx.db,
      () => {
        throw new Error("unused");
      },
      {
        spawnAndStartTask: async () => {
          throw new Error("unused");
        },
        waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
        steerTask: async () => false,
        cancelTask: async () => {},
        scheduleRollover: async () => {},
        getWorktreeManager: () => fx.wtMgr,
        getMergeQueue: () => {
          throw new Error("unused");
        },
        getTaskSignal: () => undefined,
      },
      configWithStateRead,
    );

    const refusalRows = fx.rows.filter((r) => r.expectRead === "deny");
    try {
      const readRoots = [fx.ownWtPath, ...grants.extraReadRoots, ...(grants.extraWriteRoots ?? [])];
      const scope: ReadOnlyShellScope = {
        cwd: fx.ownWtPath,
        readRoots,
        deniedRoots: grants.deniedRoots,
        protectedRoots: readRoots,
      };
      const acpRes = await runAcpMatrix(fx, grants, "read_write_workspace", refusalRows);

      const failures: string[] = [];
      for (const row of refusalRows) {
        const argv = row.isDir ? ["ls", row.target] : ["cat", row.target];
        const shimVerdict = checkReadOnlyArgv(argv, scope);
        if (shimVerdict.ok) failures.push(`checkReadOnlyArgv allowed ${row.id}`);

        try {
          await execWithStateRead.execute(fx.runAId, fx.readerTaskId, "inspect_command", { argv });
          failures.push(`inspect_command allowed ${row.id}`);
        } catch {
          // expected refusal
        }

        const acpRow = acpRes.get(row.id)!;
        if (acpRow.readOk) failures.push(`AcpRunner read allowed ${row.id}`);
        if (acpRow.writeOk) failures.push(`AcpRunner write allowed ${row.id}`);
      }
      assert.deepEqual(failures, [], `extraReadRoots=[stateDir] bypassed refusals:\n${failures.join("\n")}`);
    } finally {
      fx.db.close();
    }
  });
});
