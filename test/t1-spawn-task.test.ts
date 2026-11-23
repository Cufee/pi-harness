import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "bun:test";
import { ModelCatalogCompiler, type CompiledModelEntry } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";

it.each(["research", "plan", "verify"] as const)("lets Tier 1 spawn and await a narrow, sourced %s task", async (kind) => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-t1-research-"));
  const db = new ControlPlaneDb(":memory:");
  const finish = Promise.withResolvers<void>();
  let orchestrator: HarnessOrchestrator | undefined;
  try {
    const config = loadConfig(repoRoot);
    config.codeMode = "off"; // This test asserts the individual Tier 1 tool surface.
    const profileId = "pi:research";
    const exhaustedId = "pi:exhausted";
    config.profiles = [exhaustedId, profileId].map(id => ({
      id, kind: "pi", provider: "test", models: ["scout-wire"], billing: "local",
    }));
    config.defaultTaskProfile = exhaustedId;
    const quota = new QuotaClient();
    quota.ingestPassiveSignal({ profileId: exhaustedId, model: "scout-wire", raw: { sessionFailure: "quota_exhausted" }, observedAt: Date.now() });
    const catalog = new ModelCatalogCompiler(config, quota);
    const scout: CompiledModelEntry = {
      id: "test/scout", family: "test/scout", name: "Scout", codingRank: 2, codingScore: 50,
      scoreSource: null, benchmarks: {}, contextK: 64, efforts: ["low", "medium"],
      preferredRoute: { profileId: exhaustedId, runner: "pi", provider: "test", wireModelId: "scout-wire", billing: "local" },
      alternateRoutes: [{ profileId, runner: "pi", provider: "test", wireModelId: "scout-wire", billing: "local" }], costPerTaskUsd: 0, apiEquivCostUsd: 0, timePerTaskSeconds: 1, recommendedFor: ["codebase_research"],
    };
    let catalogCalls = 0;
    catalog.getCatalog = async (opts) => {
      catalogCalls++;
      assert.equal(opts?.excludeExhausted, false);
      assert.equal(opts?.cwd, repoRoot);
      const other = { ...scout, id: "test/other", codingRank: 1, recommendedFor: ["worker_execution"] };
      return { syncedAt: "", sources: [], models: [other, scout] };
    };
    const sources = [{ path: "README.md", lines: "7-9", symbol: "deploy", note: "Deployment entry point" }];
    let dossierPath: string | undefined;
    const summary = kind === "verify" ? "Deployment step verified. ".repeat(100) : "Read the deployment notes";
    const orch = new HarnessOrchestrator(db, config, catalog, quota, (profile) => ({
      run: async (req) => {
        assert.equal(profile.id, profileId);
        assert.equal(req.cwd, repoRoot);
        assert.equal(req.tier, 3);
        assert.equal(req.toolPolicy, "read_only_workspace");
        assert.equal(req.model, "scout-wire");
        assert.equal(req.effort, "medium");
        assert.equal(req.kind, kind);
        req.callbacks.onTextDelta?.("Private child transcript");
        req.callbacks.onToolEvent?.({ name: "read", status: "completed", title: "Private tool log" });
        if (req.initialPrompt.includes("Exit without submitting")) {
          return { text: "Unstructured runner output", stopReason: "completed" };
        }
        await finish.promise;
        await assert.rejects(() => req.executeTool("return_task", { status: "completed", summary }), /sources/);
        await assert.rejects(() => req.executeTool("return_task", { status: "completed", summary, sources: [{ path: " " }] }), /path/);
        const dossier = await req.executeTool("artifact_write", {
          name: "notes.md", content: "Deployment evidence", summary: "Notes",
        }) as { path: string };
        dossierPath = dossier.path;
        await req.executeTool("return_task", { status: "completed", summary, sources, artifact_paths: [dossier.path] });
        return { text: "Unstructured runner output", stopReason: "completed" };
      },
    }));
    orchestrator = orch;
    const run = db.createRun({ goal: "Investigate", repoRoot, baseBranch: "main", baseSha: "abc" });
    const parent = db.createTask({
      runId: run.id, tier: 1, kind: "orchestrator", title: "Parent", objective: "Coordinate", profileId, readOnly: true,
    });
    db.updateTask(parent.id, { status: "running" });
    const execute = (name: string, args: Record<string, unknown>) => orch.toolExecutor.execute(run.id, parent.id, name, args);
    const tools = await execute("__list_tools", {}) as Array<{ name: string }>;
    for (const name of ["spawn_task", "wait_tasks", "wait_children", "cancel_task", "artifact_read"]) {
      assert.ok(tools.some((tool) => tool.name === name), `Tier 1 should expose ${name}`);
    }
    const spawnTool = orch.toolExecutor.tools(1).find(tool => tool.name === "spawn_task")!;
    const properties = spawnTool.inputSchema.properties as Record<string, { enum?: string[] }>;
    assert.deepEqual(properties.kind?.enum?.toSorted(), ["plan", "research", "verify"]);
    assert.deepEqual(Object.keys(properties).toSorted(), ["effort", "kind", "model", "objective", "profile_id", "title"]);
    const assignment = { title: "Read deployment notes", objective: "Find how deployment starts" };
    await assert.rejects(() => execute("spawn_task", { ...assignment, kind: "execute" }), /Tier 1.*only permits research, plan, and verify/);
    assert.equal(catalogCalls, 0);
    assert.deepEqual(db.listTasks(run.id, { parentId: parent.id }), []);

    await assert.rejects(() => execute("spawn_task", { ...assignment, kind }), /nonblank model/);
    const { spawned } = await execute("spawn_task", { ...assignment, kind, model: scout.id, effort: "medium", read_only: false }) as { spawned: string };
    const child = db.getTask(spawned)!;
    assert.equal(child.runId, run.id);
    assert.equal(child.parentId, parent.id);
    assert.equal(child.tier, 3);
    assert.equal(child.kind, kind);
    assert.equal(child.model, scout.id);
    assert.equal(child.readOnly, true);
    const waiting = execute("wait_tasks", { ids: [spawned], timeout_s: 1 });
    finish.resolve();
    const result = await waiting as { children: Array<{ summary: string; artifact_paths: string[] }> };
    let expectedSummary = summary;
    assert.ok(dossierPath);
    const artifactPaths = [dossierPath];
    let overflowMeta: Record<string, unknown> = {};
    if (summary.length > 2000) {
      const [handoff] = result.children;
      assert.ok(handoff);
      assert.ok(handoff.summary.length <= 2000);
      assert.ok(handoff.summary.startsWith("Deployment step verified."));
      assert.equal(handoff.artifact_paths.length, 2);
      const path = handoff.artifact_paths.find(path => path !== dossierPath);
      assert.ok(path);
      assert.ok(path.startsWith(join(repoRoot, ".harness", "artifacts") + "/"));
      assert.ok(handoff.summary.includes(path.slice(repoRoot.length + 1)));
      assert.deepEqual(await execute("artifact_read", { path }), { path, content: summary, truncated: false });
      expectedSummary = handoff.summary;
      artifactPaths.push(path);
      const keptChars = expectedSummary.slice(0, expectedSummary.indexOf("\n\n[Full summary: ")).length;
      overflowMeta = {
        truncated: true,
        full_summary: {
          path,
          next_offset: keptChars,
          total_chars: summary.length,
          read_with: "artifact_read { path, offset: next_offset, task_id }",
        },
      };
    }
    assert.deepEqual(await execute("artifact_read", { path: dossierPath }), {
      path: dossierPath, content: "Deployment evidence", truncated: false,
    });
    const expected = {
      id: spawned, title: assignment.title, kind, status: "completed", summary: expectedSummary,
      ...overflowMeta, sources, artifact_paths: artifactPaths, escalations: [],
    };
    assert.deepEqual(result, { children: [expected] });
    assert.deepEqual(await execute("wait_children", { ids: [spawned] }), { children: [expected] });
    const detail = await execute("task_get", { task_id: spawned }) as { task: unknown };
    assert.deepEqual(detail.task, expected);

    const events = db.getEventsSince(run.id, 0, spawned);
    assert.equal(events[0]?.type, "task.created");
    assert.deepEqual(events[0]?.payload, {
      tier: 3, kind, title: assignment.title, parentId: parent.id,
      profileId, model: scout.id, effort: "medium", writeScopes: [], dependsOn: [],
    });
    assert.ok(events.some((event) => event.type === "task.status" && (event.payload as { to: string }).to === "completed"));

    assert.ok(events.some(event => event.type === "agent.text_delta"));
    assert.ok(events.some(event => event.type === "agent.tool"));

    const { spawned: unsourced } = await execute("spawn_task", {
      title: "Read notes", objective: "Exit without submitting", kind, model: scout.id, effort: "medium",
    }) as { spawned: string };
    const unsourcedWait = await execute("wait_tasks", { ids: [unsourced], timeout_s: 1 }) as {
      children: Array<{ id: string; title: string; kind: string; status: string; partial?: boolean; summary: string; sources: unknown[]; artifact_paths: string[]; escalations: unknown[] }>;
    };
    assert.equal(unsourcedWait.children.length, 1);
    const [unsourcedHandoff] = unsourcedWait.children;
    assert.ok(unsourcedHandoff);
    assert.equal(unsourcedHandoff.id, unsourced);
    assert.equal(unsourcedHandoff.title, "Read notes");
    assert.equal(unsourcedHandoff.kind, kind);
    assert.equal(unsourcedHandoff.status, "failed");
    assert.equal(unsourcedHandoff.partial, true);
    assert.ok(unsourcedHandoff.summary.startsWith("[Partial handoff: task ended without return_task (missing_return_task)"));
    assert.ok(unsourcedHandoff.summary.includes("Unstructured runner output"));
    assert.deepEqual(unsourcedHandoff.sources, []);
    assert.equal(unsourcedHandoff.artifact_paths.length, 1);
    assert.match(unsourcedHandoff.artifact_paths[0]!, /output-gen1(?:-\d+)?\.md$/);
    assert.deepEqual(await execute("artifact_read", { path: unsourcedHandoff.artifact_paths[0]! }), {
      path: unsourcedHandoff.artifact_paths[0]!,
      content: "Unstructured runner output",
      truncated: false,
    });
    assert.deepEqual(unsourcedHandoff.escalations, []);

    const pending = db.createTask({
      runId: run.id, parentId: parent.id, tier: 3, kind: "plan", title: "Queued plan", objective: "Plan", profileId, dependsOn: [parent.id],
    });
    await assert.rejects(() => execute("cancel_task", { task_id: parent.id, reason: "Not a child" }), /Unknown child task/);
    assert.deepEqual(await execute("cancel_task", { task_id: pending.id, reason: "No longer needed" }), { cancelled: pending.id });
    assert.equal(db.getTask(pending.id)?.status, "cancelled");
  } finally {
    finish.resolve();
    const deadline = Date.now() + 1000;
    while (orchestrator?.activeTaskCount() && Date.now() < deadline) await Bun.sleep(1);
    assert.equal(orchestrator?.activeTaskCount() ?? 0, 0);
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

it("scopes waits and child controls to the parent, and dossier reads to the run", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-handoff-scope-"));
  const db = new ControlPlaneDb(":memory:");
  try {
    const config = loadConfig(repoRoot);
    config.codeMode = "off";
    const quota = new QuotaClient();
    const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota);
    const runConfig = { goal: "Review", repoRoot, baseBranch: "main", baseSha: "abc" };
    const run = db.createRun(runConfig);
    const otherRun = db.createRun(runConfig);
    const task = { title: "Coordinate", objective: "Coordinate", profileId: "pi:local" };
    const parent = db.createTask({ ...task, runId: run.id, tier: 1, kind: "orchestrator" });
    const worker = db.createTask({ ...task, runId: run.id, parentId: parent.id, tier: 2, kind: "worker" });
    const nested = db.createTask({ ...task, runId: run.id, parentId: worker.id, tier: 3, kind: "research" });
    const foreign = db.createTask({ ...task, runId: otherRun.id, tier: 3, kind: "research" });
    const execute = (name: string, args: Record<string, unknown>) => orch.toolExecutor.execute(run.id, parent.id, name, args);
    for (const target of [nested, foreign]) {
      for (const name of ["wait_tasks", "wait_children"]) {
        assert.deepEqual(await execute(name, { ids: [target.id], timeout_s: 0 }), { children: [] });
      }
      for (const name of ["steer_child", "cancel_child", "cancel_task"]) {
        await assert.rejects(() => execute(name, { task_id: target.id, message: "Continue", reason: "Stop" }), /Unknown child task/);
      }
      assert.equal(db.getTask(target.id)?.status, target.status);
    }
    await assert.rejects(() => execute("task_get", { task_id: foreign.id }), /Unknown task/);
    const dossier = await orch.toolExecutor.execute(otherRun.id, foreign.id, "artifact_write", {
      name: "notes.md", summary: "Review notes", content: "Evidence from the other run",
    }) as { path: string };
    await assert.rejects(() => execute("artifact_read", { path: dossier.path }), /No indexed dossier in this run/);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
