import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig, type HarnessConfig, type PiProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { writeTaskDossier } from "../src/control-plane/dossiers.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const REPO_ROOT_DIR = resolve(import.meta.dir, "..");
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "returned_for_rescope", "blocked"]);

async function makeTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; stateDir: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(`/tmp/${prefix}`));
  const repoRoot = join(root, "repo");
  const stateDir = join(root, "state");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "a.ts"), "export const a = 1;\n", "utf8");
  writeFileSync(join(repoRoot, "src", "b.ts"), "export const b = 2;\n", "utf8");
  writeFileSync(join(repoRoot, "src", "c.ts"), "export const c = 3;\n", "utf8");
  await runGit(repoRoot, ["add", "."]);
  await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, stateDir, baseSha };
}

function makeOrchestrator(
  repoRoot: string,
  stateDir: string,
  runnerFactory: CustomRunnerFactory,
  opts?: {
    mutateConfig?: (cfg: HarnessConfig) => HarnessConfig;
    models?: Array<{ wireModelId: string; supportedEfforts?: string[] }>;
  },
) {
  const db = new ControlPlaneDb(":memory:");
  let config = withFixtureCatalog({
    ...loadConfig(repoRoot),
    stateDir,
    codeMode: "off",
  });
  if (opts?.models) {
    const profile: PiProfileConfig = {
      id: "pi:local",
      kind: "pi",
      provider: "fixture",
      billing: "local",
      models: opts.models.map((m) => m.wireModelId),
    };
    config = {
      ...config,
      profiles: [profile],
      defaultOrchestratorProfile: profile.id,
      defaultWorkerProfile: profile.id,
      defaultTaskProfile: profile.id,
    };
    const compiler = new ModelCatalogCompiler(config);
    const catalog = compiler.compileFromData({
      enabledProfiles: config.profiles,
      inventory: new Map([[profile.id, opts.models]]),
      profileStatuses: [{ profileId: profile.id, status: "ok", modelCount: opts.models.length }],
      modelsDev: [],
      openRouter: [],
      litellmDep: new Map(),
      benchmarks: [],
      sources: [],
    });
    mkdirSync(config.stateDir, { recursive: true });
    writeFileSync(compiler.cachePath, JSON.stringify(catalog));
  }
  if (opts?.mutateConfig) {
    config = opts.mutateConfig(config);
  }
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);
  return { db, config, orch };
}

async function waitUntil(pred: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function createRunWithParent(db: ControlPlaneDb, repoRoot: string, baseSha: string, goal: string) {
  const run = db.createRun({ goal, repoRoot, baseBranch: "main", baseSha });
  const parent = db.createTask({
    runId: run.id,
    tier: 1,
    kind: "orchestrator",
    title: "Orch",
    objective: "Coordinate",
    readOnly: true,
    profileId: "pi:local",
    model: "fixture/fixture",
  });
  db.updateTask(parent.id, { status: "running" });
  return { run, parent };
}

describe("goal-14 slice B2o: count-free rollover liveness and overflow rollovers", () => {
  it("T5-3a: a task touching new files each window rolls over 15+ generations without stopping and completes on return_task", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53a-");
    const targetGenerations = 16;
    for (let i = 1; i <= targetGenerations; i += 1) {
      writeFileSync(join(repoRoot, "src", `file-${i}.ts`), `export const f${i} = ${i};\n`, "utf8");
    }
    let seenGenerations = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        seenGenerations += 1;
        const gen = req.taskGeneration ?? seenGenerations;
        // Touch a distinct new workspace file via inspect_command (Pi path, no native read event)
        await req.executeTool("inspect_command", { argv: ["cat", `src/file-${gen}.ts`] });
        if (gen < targetGenerations) {
          return { text: `explored file-${gen}`, stopReason: "rollover_requested" };
        }
        await req.executeTool("return_task", {
          status: "completed",
          summary: `Explored all ${targetGenerations} files across rollovers.`,
          sources: [{ path: `src/file-${gen}.ts`, note: "final file" }],
        });
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "T5-3a productive file reads");
      const task = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Read 16 files",
        objective: "Read all files one per window",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 15_000, "T5-3a terminal");
      const finalTask = db.getTask(task.id)!;
      assert.equal(finalTask.status, "completed");
      assert.equal(finalTask.generation, targetGenerations);
      assert.equal(seenGenerations, targetGenerations);
      assert.equal(db.listEscalations(run.id).length, 0);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T5-3g: re-reading the same 3 files with new line ranges each window stops at the third rollover with partial handoff and created escalation", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53g-");
    let runs = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runs += 1;
        const offset = runs * 10;
        for (const [idx, path] of ["src/a.ts", "src/b.ts", "src/c.ts"].entries()) {
          req.callbacks.onToolEvent?.({
            id: `r-${runs}-${idx}`,
            name: "read_file",
            kind: "read",
            status: "completed",
            args: JSON.stringify({ path, offset, limit: 10 }),
            paths: [path],
          });
        }
        return { text: `re-read batch ${runs}`, stopReason: "rollover_requested" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "T5-3g re-read loop");
      const task = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Re-read same 3 files",
        objective: "Research",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 10_000, "T5-3g terminal");

      const finalTask = db.getTask(task.id)!;
      assert.equal(runs, 3, "Must stop on the third rollover (2 consecutive empty windows)");
      assert.equal(finalTask.status, "failed");
      assert.ok((finalTask.summary ?? "").includes("2 context windows in a row with nothing new"), finalTask.summary ?? "");
      const parsed = JSON.parse(finalTask.resultJson ?? "{}") as { fallback?: { partial?: boolean; reason?: string } };
      assert.equal(parsed.fallback?.partial, true);
      assert.equal(parsed.fallback?.reason, "zero_progress_rollover");

      const rollovers = db.getEventsSince(run.id, 0, task.id).filter((e) => e.type === "agent.rollover");
      assert.equal(rollovers.length, 2);

      const escs = db.listEscalations(run.id).filter((e) => e.fromTaskId === task.id);
      assert.equal(escs.length, 1);
      assert.equal(escs[0]!.category, "budget_exhausted");
      assert.equal(escs[0]!.blocking, true);
      assert.ok(escs[0]!.title.includes("2 context windows in a row with nothing new"), escs[0]!.title);
      assert.ok(escs[0]!.evidencePaths.length > 0, "Escalation must carry non-empty evidence paths");
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T5-3m: explicit request_rollover loops stop on the third rollover (normal, catch path, model A->B->A, and arbitrary effort strings)", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53m-");
    let workerNormalRuns = 0;
    let workerCatchRuns = 0;
    let workerModelRuns = 0;
    let workerEffortRuns = 0;

    const { db, orch } = makeOrchestrator(
      repoRoot,
      stateDir,
      () => ({
        run: async (req) => {
          const title = db.getTask(req.taskId)?.title ?? "";
          if (title === "explicit-normal") {
            workerNormalRuns += 1;
            await req.executeTool("request_rollover", {
              goal_invariants: ["stay alive"],
              architectural_decisions: [],
              active_risks: [],
              next_actions: ["keep rolling"],
            });
            return { text: "rolling over", stopReason: "rollover_requested" };
          }
          if (title === "explicit-catch") {
            workerCatchRuns += 1;
            await req.executeTool("request_rollover", {
              goal_invariants: ["catch path"],
              architectural_decisions: [],
              active_risks: [],
              next_actions: ["throw after schedule"],
            });
            throw new Error("runner rejected on clean_rollover cancel");
          }
          if (title === "explicit-model-flip") {
            workerModelRuns += 1;
            // Gen 1: stay on model A -> routes=[A], streak=1
            // Gen 2: switch to model B -> routes=[A,B], streak=1 (progress!)
            // Gen 3: switch back to A -> routes=[A,B], streak=2
            // Gen 4: switch back to B -> routes=[A,B], streak=3 -> stop!
            const targetModel =
              workerModelRuns === 2
                ? "fixture/model-b"
                : workerModelRuns === 3
                  ? "fixture/model-a"
                  : workerModelRuns === 4
                    ? "fixture/model-b"
                    : undefined;
            await req.executeTool("request_rollover", {
              goal_invariants: ["model flip"],
              architectural_decisions: [],
              active_risks: [],
              next_actions: ["flip model"],
              ...(targetModel ? { target_model: targetModel } : {}),
            });
            return { text: "flip", stopReason: "rollover_requested" };
          }
          if (title === "explicit-arbitrary-effort") {
            workerEffortRuns += 1;
            await req.executeTool("request_rollover", {
              goal_invariants: ["effort spam"],
              architectural_decisions: [],
              active_risks: [],
              next_actions: ["try bogus effort"],
              target_effort: `non-catalog-effort-${workerEffortRuns}`,
            });
            return { text: "effort", stopReason: "rollover_requested" };
          }
          return { text: "ok", stopReason: "completed" };
        },
      }),
      {
        models: [
          { wireModelId: "model-a", supportedEfforts: ["low", "high"] },
          { wireModelId: "model-b", supportedEfforts: ["low", "high"] },
        ],
      },
    );

    try {
      const run = db.createRun({ goal: "T5-3m explicit rollovers", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/model-a",
      });
      db.updateTask(parent.id, { status: "running" });

      // (i) Normal explicit rollover loop -> stopped at 3rd rollover
      const w1 = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "explicit-normal",
        objective: "Explicit loop",
        readOnly: false,
        writeScopes: ["src/a.ts"],
        profileId: "pi:local",
        model: "fixture/model-a",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(w1.id)?.status ?? ""), 10_000, "T5-3m(i) terminal");
      const w1Final = db.getTask(w1.id)!;
      assert.equal(workerNormalRuns, 3);
      assert.equal(w1Final.status, "failed");
      assert.ok((w1Final.summary ?? "").includes("2 context windows in a row with nothing new"));
      assert.equal(JSON.parse(w1Final.resultJson ?? "{}").fallback?.partial, true);
      const w1Esc = db.listEscalations(run.id).filter((e) => e.fromTaskId === w1.id);
      assert.equal(w1Esc.length, 1);
      assert.equal(w1Esc[0]!.category, "budget_exhausted");
      assert.ok(w1Esc[0]!.evidencePaths.length > 0);
      assert.equal(db.getEventsSince(run.id, 0, w1.id).filter((e) => e.type === "agent.rollover").length, 2);

      // (v) Explicit rollover caught on runner throw -> stopped at 3rd rollover
      const wCatch = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "explicit-catch",
        objective: "Explicit catch loop",
        readOnly: false,
        writeScopes: ["src/b.ts"],
        profileId: "pi:local",
        model: "fixture/model-a",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(wCatch.id)?.status ?? ""), 10_000, "T5-3m(v) terminal");
      assert.equal(workerCatchRuns, 3);
      assert.equal(db.getTask(wCatch.id)?.status, "failed");
      assert.equal(db.listEscalations(run.id).filter((e) => e.fromTaskId === wCatch.id).length, 1);

      // (ii) Switching model A -> B -> A -> B credits B once and fails at the 4th rollover
      const wModel = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "explicit-model-flip",
        objective: "Model flip loop",
        readOnly: false,
        writeScopes: ["src/c.ts"],
        profileId: "pi:local",
        model: "fixture/model-a",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(wModel.id)?.status ?? ""), 10_000, "T5-3m(ii) terminal");
      assert.equal(workerModelRuns, 4, "First switch to model-b counts once; flipping back to A then B stops on 4th rollover");
      assert.equal(db.getTask(wModel.id)?.status, "failed");

      // (vi) Switching target_effort to arbitrary non-catalog strings each window does NOT count as progress (R2)
      const wEffort = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "explicit-arbitrary-effort",
        objective: "Effort spam",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/model-a",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(wEffort.id)?.status ?? ""), 10_000, "T5-3m(vi) terminal");
      assert.equal(workerEffortRuns, 3, "Arbitrary effort strings must not reset the zero-progress streak");
      assert.equal(db.getTask(wEffort.id)?.status, "failed");
      assert.equal(db.listEscalations(run.id).filter((e) => e.fromTaskId === wEffort.id).length, 1);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T5-3n: harness-written output dossiers (inspect_command spills) do not count as progress", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53n-");
    writeFileSync(join(repoRoot, "big.txt"), `${"0123456789abcdef\n".repeat(2000)}`, "utf8");
    let runs = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runs += 1;
        await req.executeTool("inspect_command", { argv: ["cat", "big.txt"] });
        return { text: `spilled ${runs}`, stopReason: "rollover_requested" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "T5-3n harness spills");
      const task = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "Spill inspect output",
        objective: "Verify big.txt",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 10_000, "T5-3n terminal");

      assert.equal(runs, 3);
      assert.equal(db.getTask(task.id)?.status, "failed");
      const spills = db
        .listArtifacts(run.id, task.id, 50, "dossier")
        .filter((a) => a.path.includes("inspect-output-"));
      assert.ok(spills.length >= 2, `Expected >=2 inspect-output spills, got ${spills.length}`);
      for (const s of spills) {
        assert.equal(s.origin, undefined, "Harness spill dossier must not have origin='agent'");
      }
      assert.equal(db.listAgentDossierPaths(run.id, task.id).length, 0);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T5-3p: alternating productive and empty windows completes without being stopped", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53p-");
    for (let i = 1; i <= 5; i += 1) {
      writeFileSync(join(repoRoot, "src", `alt-${i}.ts`), `export const alt${i} = ${i};\n`, "utf8");
    }
    let runs = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runs += 1;
        // Odd generations read a new file; even generations do nothing new (1 empty window, never 2 in a row).
        if (runs % 2 === 1 && runs <= 9) {
          const idx = Math.ceil(runs / 2);
          req.callbacks.onToolEvent?.({
            id: `alt-${runs}`,
            name: "read_file",
            kind: "read",
            status: "completed",
            paths: [`src/alt-${idx}.ts`],
          });
        }
        if (runs < 9) {
          return { text: `gen ${runs}`, stopReason: "rollover_requested" };
        }
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Finished after 8 alternating rollovers",
          sources: [{ path: "src/alt-5.ts", note: "done" }],
        });
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "T5-3p alternating windows");
      const task = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Alternating windows",
        objective: "Research with synthesis windows",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 10_000, "T5-3p terminal");

      assert.equal(runs, 9);
      assert.equal(db.getTask(task.id)?.status, "completed");
      assert.equal(db.listEscalations(run.id).length, 0);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T5-3h: rewriting one agent dossier at the same size (or duplicating under a new name) does not count, while growing dossier content does", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53h-");
    let sameSizeRuns = 0;
    let dupContentRuns = 0;
    let growingRuns = 0;
    let bystanderTaskId = "";

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        const title = db.getTask(req.taskId)?.title ?? "";
        if (title === "same-size-rewrite") {
          sameSizeRuns += 1;
          // Another task mutating blackboard and opening an unrelated escalation must not reset this task's streak.
          db.blackboardSet(req.runId, `other-key-${sameSizeRuns}`, { v: sameSizeRuns }, bystanderTaskId);
          db.createEscalation({
            runId: req.runId,
            fromTaskId: bystanderTaskId,
            toTaskId: null,
            severity: "P1",
            category: "code_defect",
            title: `Unrelated defect ${sameSizeRuns}`,
            evidencePaths: [repoRoot],
            blocking: false,
          });
          const ch = String.fromCharCode(64 + sameSizeRuns);
          await req.executeTool("artifact_write", {
            name: "findings.md",
            content: ch.repeat(200),
            summary: `rewrite ${sameSizeRuns}`,
          });
          return { text: `rewrite ${sameSizeRuns}`, stopReason: "rollover_requested" };
        }
        if (title === "duplicate-under-new-name") {
          dupContentRuns += 1;
          await req.executeTool("artifact_write", {
            name: `copy-${dupContentRuns}.md`,
            content: "identical dossier payload across windows",
            summary: `copy ${dupContentRuns}`,
          });
          return { text: `dup ${dupContentRuns}`, stopReason: "rollover_requested" };
        }
        if (title === "growing-dossier") {
          growingRuns += 1;
          await req.executeTool("artifact_write", {
            name: "notes.md",
            content: `section-${growingRuns}: ${"x".repeat(growingRuns * 120)}`,
            summary: `growth ${growingRuns}`,
          });
          if (growingRuns < 5) {
            return { text: `grow ${growingRuns}`, stopReason: "rollover_requested" };
          }
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Completed after growing dossier across 4 rollovers",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "T5-3h dossier high-water mark");
      const bystander = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Bystander",
        objective: "Unrelated",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      bystanderTaskId = bystander.id;

      const tSame = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "same-size-rewrite",
        objective: "Rewrite same size",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tSame.id)?.status ?? ""), 10_000, "T5-3h same-size");
      assert.equal(sameSizeRuns, 3);
      assert.equal(db.getTask(tSame.id)?.status, "failed");

      const tDup = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "duplicate-under-new-name",
        objective: "Duplicate content",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tDup.id)?.status ?? ""), 10_000, "T5-3h dup");
      assert.equal(dupContentRuns, 3);
      assert.equal(db.getTask(tDup.id)?.status, "failed");

      const tGrow = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "growing-dossier",
        objective: "Grow dossier",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tGrow.id)?.status ?? ""), 10_000, "T5-3h grow");
      assert.equal(growingRuns, 5);
      assert.equal(db.getTask(tGrow.id)?.status, "completed");
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T5-3x: provider context-overflow errors (error result, thrown error, overflow turn text) become rollovers with reset hydration, and repeated empty overflows are guarded", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53x-");
    const counts = new Map<string, number>();
    let gen2PromptForErrorResult = "";
    let savedDossierPath = "";

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        const title = db.getTask(req.taskId)?.title ?? "";
        const n = (counts.get(title) ?? 0) + 1;
        counts.set(title, n);

        if (title === "overflow-error-result") {
          if (n === 1) {
            const wrote = (await req.executeTool("artifact_write", {
              name: "notes.md",
              content: "saved findings before overflow",
              summary: "pre-overflow notes",
            })) as { path: string };
            savedDossierPath = wrote.path;
            return { text: "API Error: context_length_exceeded", stopReason: "error" };
          }
          gen2PromptForErrorResult = req.initialPrompt;
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Completed after overflow error result rollover",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        if (title === "overflow-thrown") {
          if (n === 1) {
            throw new Error("prompt is too long: 250000 tokens > 200000 maximum");
          }
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Completed after thrown overflow rollover",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        if (title === "overflow-turn-text") {
          if (n === 1) {
            return { text: "Prompt is too long", stopReason: "completed" };
          }
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Completed after overflow turn-text rollover",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }

        if (title === "overflow-repeated") {
          return { text: "context_length_exceeded", stopReason: "error" };
        }

        return { text: "ok", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "T5-3x overflow rollovers");

      for (const title of ["overflow-error-result", "overflow-thrown", "overflow-turn-text"]) {
        const task = await orch.spawnAndStartTask({
          runId: run.id,
          parentId: parent.id,
          tier: 3,
          kind: "research",
          title,
          objective: `Test ${title}`,
          readOnly: true,
          profileId: "pi:local",
          model: "fixture/fixture",
        });
        await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 10_000, title);
        assert.equal(db.getTask(task.id)?.status, "completed", `${title} should complete after rollover`);
        assert.equal(counts.get(title), 2);
        const rolloverEvents = db
          .getEventsSince(run.id, 0, task.id)
          .filter((e) => e.type === "agent.rollover");
        assert.equal(rolloverEvents.length, 1);
        assert.equal((rolloverEvents[0]!.payload as { reason?: string }).reason, "context_overflow");
      }

      // Check buildCleanRolloverHandoff reset statement & dossier path in Gen 2 hydration
      assert.ok(gen2PromptForErrorResult.includes("Context was reset"), "Gen 2 hydration must state context was reset");
      assert.ok(savedDossierPath.length > 0);
      assert.ok(gen2PromptForErrorResult.includes(savedDossierPath), "Gen 2 hydration must list agent-written dossier path");

      // Repeated overflow with nothing new must stop at the 3rd rollover
      const tLoop = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "overflow-repeated",
        objective: "Repeated overflow",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tLoop.id)?.status ?? ""), 10_000, "overflow-repeated");
      assert.equal(counts.get("overflow-repeated"), 3);
      assert.equal(db.getTask(tLoop.id)?.status, "failed");
      assert.ok((db.getTask(tLoop.id)?.summary ?? "").includes("2 context windows in a row with nothing new"));
      assert.equal(db.listEscalations(run.id).filter((e) => e.fromTaskId === tLoop.id).length, 1);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("T5-3z: no code path fails a task on its generation number even with rollover.maxGenerations set to 2", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-b2o-t53z-");
    const targetGenerations = 20;
    let runs = 0;

    const { db, orch } = makeOrchestrator(
      repoRoot,
      stateDir,
      () => ({
        run: async (req) => {
          runs += 1;
          await req.executeTool("artifact_write", {
            name: `step-${runs}.md`,
            content: `unique progress for generation ${runs}`,
            summary: `step ${runs}`,
          });
          if (runs < targetGenerations) {
            return { text: `gen ${runs}`, stopReason: "rollover_requested" };
          }
          await req.executeTool("return_task", {
            status: "completed",
            summary: `Reached generation ${targetGenerations}`,
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        },
      }),
      {
        mutateConfig: (cfg) => ({
          ...cfg,
          rollover: { ...cfg.rollover, maxGenerations: 2 },
        }),
      },
    );

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "T5-3z no maxGenerations stop");
      const task = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "20 productive generations",
        objective: "Verify maxGenerations has no effect",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(task.id)?.status ?? ""), 15_000, "T5-3z terminal");
      const finalTask = db.getTask(task.id)!;
      assert.equal(finalTask.status, "completed");
      assert.equal(finalTask.generation, targetGenerations);
      assert.equal(runs, targetGenerations);

      // Source check: orchestrator.ts contains no reference to maxGenerations
      const orchSrc = readFileSync(join(REPO_ROOT_DIR, "src", "control-plane", "orchestrator.ts"), "utf8");
      assert.equal(orchSrc.includes("maxGenerations"), false, "orchestrator.ts must not reference maxGenerations");
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("goal-14 fix FX-ORCH: rollover progress fingerprint and Tier 1 partial handoff", () => {
  it("FXO-4a: editing an existing untracked file between rollovers advances the fingerprint", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-fxo-4a-");
    let runs = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runs += 1;
        // Write same-length updated content to the same untracked file each window so porcelain status is unchanged.
        writeFileSync(join(req.cwd, "scratch.tmp"), `untracked-rev-${runs}\n`, "utf8");
        if (runs < 5) {
          return { text: `edited untracked ${runs}`, stopReason: "rollover_requested" };
        }
        await runGit(req.cwd, ["add", "scratch.tmp"]);
        await runGit(req.cwd, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "final untracked"]);
        await req.executeTool("submit_for_merge", { summary: "merge scratch.tmp" });
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Completed after editing untracked file across 4 rollovers",
          sources: [{ path: "README.md", note: "done" }],
        });
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "FXO-4a untracked file content");
      const worker = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Edit untracked file",
        objective: "Iteratively edit an untracked file",
        readOnly: false,
        writeScopes: ["scratch.tmp"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(worker.id)?.status ?? ""), 10_000, "FXO-4a terminal");
      const finalTask = db.getTask(worker.id)!;
      assert.equal(finalTask.status, "completed");
      assert.equal(runs, 5);
      assert.equal(finalTask.generation, 5);
      assert.equal(db.listEscalations(run.id).length, 0);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FXO-4b: replacing staged content advances the fingerprint", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-fxo-4b-");
    let runs = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        runs += 1;
        // Replace content and immediately stage it so unstaged diff stays empty and porcelain stays "M  src/a.ts".
        writeFileSync(join(req.cwd, "src", "a.ts"), `export const a = ${runs + 10};\n`, "utf8");
        await runGit(req.cwd, ["add", "src/a.ts"]);
        if (runs < 5) {
          return { text: `staged rev ${runs}`, stopReason: "rollover_requested" };
        }
        await runGit(req.cwd, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "final staged"]);
        await req.executeTool("submit_for_merge", { summary: "merge staged src/a.ts" });
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Completed after replacing staged content across 4 rollovers",
          sources: [{ path: "src/a.ts", note: "done" }],
        });
        return { text: "done", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "FXO-4b staged content");
      const worker = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Replace staged content",
        objective: "Iteratively stage edits to src/a.ts",
        readOnly: false,
        writeScopes: ["src/a.ts"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(worker.id)?.status ?? ""), 10_000, "FXO-4b terminal");
      const finalTask = db.getTask(worker.id)!;
      assert.equal(finalTask.status, "completed");
      assert.equal(runs, 5);
      assert.equal(finalTask.generation, 5);
      assert.equal(db.listEscalations(run.id).length, 0);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FXO-4c: reading a new child dossier advances the fingerprint while re-reading the same dossier does not", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-fxo-4c-");
    const childDossiers: string[] = [];
    let progressRuns = 0;
    let repeatRuns = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        const title = db.getTask(req.taskId)?.title ?? "";
        if (title === "read-new-child-dossiers") {
          progressRuns += 1;
          const target = childDossiers[progressRuns - 1];
          if (target) {
            await req.executeTool("artifact_read", { path: target });
          }
          if (progressRuns < 5) {
            return { text: `read child dossier ${progressRuns}`, stopReason: "rollover_requested" };
          }
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Synthesized 4 distinct child dossiers across rollovers",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }
        if (title === "reread-same-child-dossier") {
          repeatRuns += 1;
          await req.executeTool("artifact_read", { path: childDossiers[0]! });
          return { text: `reread ${repeatRuns}`, stopReason: "rollover_requested" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "FXO-4c child dossier reads");
      const child = db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "research",
        title: "Scout child",
        objective: "Produce dossiers",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      for (let i = 1; i <= 4; i += 1) {
        const rec = writeTaskDossier(db, run, child.id, `finding-${i}.md`, `# Finding ${i}\nDetails ${i}\n`, `finding ${i}`);
        childDossiers.push(rec.path);
      }

      const tProgress = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "read-new-child-dossiers",
        objective: "Read each child dossier",
        readOnly: false,
        writeScopes: ["README.md"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tProgress.id)?.status ?? ""), 10_000, "FXO-4c progress");
      assert.equal(db.getTask(tProgress.id)?.status, "completed");
      assert.equal(progressRuns, 5);
      assert.equal(db.listEscalations(run.id).filter((e) => e.fromTaskId === tProgress.id).length, 0);

      const tRepeat = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "reread-same-child-dossier",
        objective: "Re-read same dossier",
        readOnly: false,
        writeScopes: ["src/a.ts"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tRepeat.id)?.status ?? ""), 10_000, "FXO-4c repeat");
      assert.equal(repeatRuns, 3);
      assert.equal(db.getTask(tRepeat.id)?.status, "failed");
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FXO-4d: a verification run with new output advances the fingerprint and an identical repeated command does not", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-fxo-4d-");
    let newOutputRuns = 0;
    let identicalRuns = 0;

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        const title = db.getTask(req.taskId)?.title ?? "";
        if (title === "verify-new-output") {
          newOutputRuns += 1;
          req.callbacks.onToolEvent?.({
            id: `verify-new-${newOutputRuns}`,
            name: "Bash",
            kind: "execute",
            status: newOutputRuns < 4 ? "failed" : "completed",
            args: JSON.stringify({ command: "bun test" }),
            ...(newOutputRuns < 4
              ? { error: `${4 - newOutputRuns} failing tests` }
              : { result: "0 failing tests, 12 passed" }),
          });
          if (newOutputRuns < 5) {
            return { text: `verify pass ${newOutputRuns}`, stopReason: "rollover_requested" };
          }
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Verification converged across rollovers",
            sources: [{ path: "README.md", note: "verified" }],
          });
          return { text: "done", stopReason: "completed" };
        }
        if (title === "verify-identical-output") {
          identicalRuns += 1;
          req.callbacks.onToolEvent?.({
            id: `verify-same-${identicalRuns}`,
            name: "Bash",
            kind: "execute",
            status: "completed",
            args: JSON.stringify({ command: "bun test" }),
            result: "2 failing tests (identical)",
          });
          return { text: `same verify ${identicalRuns}`, stopReason: "rollover_requested" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    }));

    try {
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "FXO-4d verification evidence");

      const tNew = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "verify-new-output",
        objective: "Run verification suite",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tNew.id)?.status ?? ""), 10_000, "FXO-4d new output");
      assert.equal(db.getTask(tNew.id)?.status, "completed");
      assert.equal(newOutputRuns, 5);
      assert.equal(db.listEscalations(run.id).filter((e) => e.fromTaskId === tNew.id).length, 0);

      const tSame = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 3,
        kind: "verify",
        title: "verify-identical-output",
        objective: "Run identical verification",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tSame.id)?.status ?? ""), 10_000, "FXO-4d identical");
      assert.equal(identicalRuns, 3);
      assert.equal(db.getTask(tSame.id)?.status, "failed");
      assert.equal(db.listEscalations(run.id).filter((e) => e.fromTaskId === tSame.id).length, 1);
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FXO-4e: three empty windows stop Tier 1 with a structured partial handoff; real child activity advances fingerprint while silent running child does not; escalation errors record durably", async () => {
    const { root, repoRoot, stateDir, baseSha } = await makeTempGitRepo("pi-fxo-4e-");
    let tier1Runs = 0;
    let activeChildParentRuns = 0;
    let silentChildParentRuns = 0;
    let escThrowRuns = 0;
    let activeChildId = "";
    let silentChildId = "";
    let activeChildRunId = "";

    const { db, orch } = makeOrchestrator(repoRoot, stateDir, () => ({
      run: async (req) => {
        const t = db.getTask(req.taskId);
        if (t?.tier === 1) {
          tier1Runs += 1;
          return { text: `tier1 empty window ${tier1Runs}`, stopReason: "rollover_requested" };
        }
        if (t?.title === "parent-with-active-child") {
          activeChildParentRuns += 1;
          if (!activeChildId) {
            const c = db.createTask({
              runId: req.runId,
              parentId: req.taskId,
              tier: 3,
              kind: "research",
              title: "Active child",
              objective: "Emit real tool events",
              readOnly: true,
              profileId: "pi:local",
              model: "fixture/fixture",
            });
            db.updateTask(c.id, { status: "running" });
            activeChildId = c.id;
            activeChildRunId = req.runId;
          }
          if (activeChildParentRuns < 5) {
            // Simulate real child tool activity while child remains marked running.
            db.emitEvent(activeChildRunId, activeChildId, "agent.tool", {
              id: `child-tool-${activeChildParentRuns}`,
              name: "read_file",
              status: "completed",
            });
            return { text: `waiting on active child ${activeChildParentRuns}`, stopReason: "rollover_requested" };
          }
          db.updateTask(activeChildId, { status: "completed", summary: "child finished" });
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Completed after observing real child activity across rollovers",
            sources: [{ path: "README.md", note: "done" }],
          });
          return { text: "done", stopReason: "completed" };
        }
        if (t?.title === "parent-with-silent-child") {
          silentChildParentRuns += 1;
          if (!silentChildId) {
            const c = db.createTask({
              runId: req.runId,
              parentId: req.taskId,
              tier: 3,
              kind: "research",
              title: "Silent child",
              objective: "Stuck running",
              readOnly: true,
              profileId: "pi:local",
              model: "fixture/fixture",
            });
            db.updateTask(c.id, { status: "running" });
            silentChildId = c.id;
          }
          // Merely touching the child row or emitting an external steer must not count as child progress.
          db.updateTask(silentChildId, { summary: `touched ${silentChildParentRuns}` });
          db.emitEvent(req.runId, silentChildId, "agent.steered", { message: "ping", accepted: false });
          return { text: `waiting on silent child ${silentChildParentRuns}`, stopReason: "rollover_requested" };
        }
        if (t?.title === "escalation-throw-worker") {
          escThrowRuns += 1;
          return { text: `empty ${escThrowRuns}`, stopReason: "rollover_requested" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    }));

    try {
      // 1. Tier 1 empty windows -> stops on 3rd rollover with structured partial handoff and P0 escalation.
      const started = await orch.startRun({
        goal: "FXO-4e Tier 1 empty rollover stop",
        repoRoot,
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(
        () => TERMINAL_STATUSES.has(db.getTask(started.orchestratorTask.id)?.status ?? ""),
        10_000,
        "FXO-4e Tier 1 terminal",
      );
      const t1Final = db.getTask(started.orchestratorTask.id)!;
      assert.equal(tier1Runs, 3);
      assert.equal(t1Final.status, "failed");
      assert.ok((t1Final.summary ?? "").includes("2 context windows in a row with nothing new"));
      const t1Parsed = JSON.parse(t1Final.resultJson ?? "{}") as {
        status?: string;
        fallback?: { partial?: boolean; reason?: string; summary?: string; artifact_paths?: string[] };
      };
      assert.equal(t1Parsed.status, "failed");
      assert.equal(t1Parsed.fallback?.partial, true, "Tier 1 stop must store a structured partial handoff");
      assert.equal(t1Parsed.fallback?.reason, "zero_progress_rollover");
      assert.ok(typeof t1Parsed.fallback?.summary === "string" && t1Parsed.fallback.summary.length > 0);
      assert.ok(Array.isArray(t1Parsed.fallback?.artifact_paths));
      const t1Escs = db.listEscalations(started.run.id).filter((e) => e.fromTaskId === started.orchestratorTask.id);
      assert.equal(t1Escs.length, 1);
      assert.equal(t1Escs[0]!.severity, "P0");
      assert.equal(t1Escs[0]!.category, "budget_exhausted");

      // 2. Real child activity advances parent fingerprint; silent running child does not.
      const { run, parent } = createRunWithParent(db, repoRoot, baseSha, "FXO-4e child activity");

      const pActive = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "parent-with-active-child",
        objective: "Wait for active child",
        readOnly: false,
        writeScopes: ["src/a.ts"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(pActive.id)?.status ?? ""), 10_000, "FXO-4e active child");
      assert.equal(db.getTask(pActive.id)?.status, "completed");
      assert.equal(activeChildParentRuns, 5);

      const pSilent = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "parent-with-silent-child",
        objective: "Wait for silent child",
        readOnly: false,
        writeScopes: ["src/b.ts"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(pSilent.id)?.status ?? ""), 10_000, "FXO-4e silent child");
      assert.equal(silentChildParentRuns, 3);
      assert.equal(db.getTask(pSilent.id)?.status, "failed");

      // 3. If createEscalation throws on stop, record failure durably (event + task summary).
      const origCreateEsc = db.createEscalation.bind(db);
      db.createEscalation = () => {
        throw new Error("simulated escalation DB failure");
      };
      try {
        const tEscFail = await orch.spawnAndStartTask({
          runId: run.id,
          parentId: parent.id,
          tier: 2,
          kind: "worker",
          title: "escalation-throw-worker",
          objective: "Trigger escalation error",
          readOnly: false,
          writeScopes: ["src/c.ts"],
          profileId: "pi:local",
          model: "fixture/fixture",
        });
        await waitUntil(() => TERMINAL_STATUSES.has(db.getTask(tEscFail.id)?.status ?? ""), 10_000, "FXO-4e esc fail");
        const finalEscTask = db.getTask(tEscFail.id)!;
        assert.equal(escThrowRuns, 3);
        assert.equal(finalEscTask.status, "failed");
        assert.ok(
          (finalEscTask.summary ?? "").includes("Escalation creation failed: simulated escalation DB failure"),
          finalEscTask.summary ?? "",
        );
        const failEvents = db
          .getEventsSince(run.id, 0, tEscFail.id)
          .filter((e) => e.type === "escalation.create_failed");
        assert.equal(failEvents.length, 1);
        assert.equal(
          (failEvents[0]!.payload as { error?: string }).error,
          "simulated escalation DB failure",
        );
      } finally {
        db.createEscalation = origCreateEsc;
      }
    } finally {
      await orch.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
