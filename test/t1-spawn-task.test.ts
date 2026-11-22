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

it("lets Tier 1 spawn and await a quota-routed, read-only Tier 3 task, but not execute", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-t1-research-"));
  const db = new ControlPlaneDb(":memory:");
  const finish = Promise.withResolvers<void>();
  try {
    const config = loadConfig(repoRoot);
    const profileId = "acp:research-fixture";
    config.profiles = [{ id: profileId, kind: "acp", adapter: "generic", command: "unused", billing: "subscription" }];
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const scout: CompiledModelEntry = {
      id: "test/scout", family: "test/scout", name: "Scout", codingRank: 2, codingScore: 50,
      scoreSource: null, benchmarks: {}, contextK: 64, efforts: ["low", "medium"],
      preferredRoute: { profileId, runner: "acp", provider: "test", wireModelId: "scout-wire", billing: "subscription" },
      alternateRoutes: [], costPerTaskUsd: 0, apiEquivCostUsd: 0, timePerTaskSeconds: 1, recommendedFor: ["codebase_research"],
    };
    let catalogCalls = 0;
    catalog.getCatalog = async (opts) => {
      catalogCalls++;
      assert.equal(opts?.excludeExhausted, true);
      assert.equal(opts?.cwd, repoRoot);
      const other = { ...scout, id: "test/other", codingRank: 1, recommendedFor: ["worker_execution"] };
      return { syncedAt: "", sources: [], models: [other, scout] };
    };
    const sources = [{ path: "README.md", lines: "7-9" }];
    const orch = new HarnessOrchestrator(db, config, catalog, quota, (profile) => ({
      run: async (req) => {
        assert.equal(profile.id, profileId);
        assert.equal(req.cwd, repoRoot);
        assert.equal(req.tier, 3);
        assert.equal(req.readOnly, true);
        assert.equal(req.model, "scout-wire");
        assert.equal(req.effort, "medium");
        await finish.promise;
        await req.executeTool("return_task", { status: "completed", summary: "Read the deployment notes", sources });
        return { text: "Unstructured runner output", stopReason: "completed" };
      },
    }));
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
    const assignment = { title: "Read deployment notes", objective: "Find how deployment starts" };
    await assert.rejects(() => execute("spawn_task", { ...assignment, kind: "execute" }), /Tier 1.*only permits research, plan, and verify/);
    assert.equal(catalogCalls, 0);
    assert.deepEqual(db.listTasks(run.id, { parentId: parent.id }), []);

    const { spawned } = await execute("spawn_task", { ...assignment, kind: "research", read_only: false }) as { spawned: string };
    const child = db.getTask(spawned)!;
    assert.equal(child.runId, run.id);
    assert.equal(child.parentId, parent.id);
    assert.equal(child.tier, 3);
    assert.equal(child.kind, "research");
    assert.equal(child.model, "scout-wire");
    assert.equal(child.readOnly, true);
    const waiting = execute("wait_tasks", { ids: [spawned], timeout_s: 1 });
    finish.resolve();
    assert.deepEqual(await waiting, { children: [{
      id: spawned, title: assignment.title, kind: "research", status: "completed", summary: "Read the deployment notes",
      sources, artifact_paths: [], escalations: [],
    }] });

    const events = db.getEventsSince(run.id, 0, spawned);
    assert.equal(events[0]?.type, "task.created");
    assert.deepEqual(events[0]?.payload, {
      tier: 3, kind: "research", title: assignment.title, parentId: parent.id,
      profileId, model: "scout-wire", effort: "medium", writeScopes: [], dependsOn: [],
    });
    assert.ok(events.some((event) => event.type === "task.status" && (event.payload as { to: string }).to === "completed"));

    const pending = db.createTask({
      runId: run.id, parentId: parent.id, tier: 3, kind: "plan", title: "Queued plan", objective: "Plan", profileId, dependsOn: [parent.id],
    });
    await assert.rejects(() => execute("cancel_task", { task_id: parent.id, reason: "Not a child" }), /Unknown child task/);
    assert.deepEqual(await execute("cancel_task", { task_id: pending.id, reason: "No longer needed" }), { cancelled: pending.id });
    assert.equal(db.getTask(pending.id)?.status, "cancelled");
  } finally {
    finish.resolve();
    // The task loop drives lifecycle cleanup after wait_tasks observes its terminal status.
    await Bun.sleep(0);
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
