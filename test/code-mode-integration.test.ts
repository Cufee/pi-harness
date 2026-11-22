import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { effectiveCodeMode, type CodeExecResult } from "../src/code-mode/index.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb, type AgentTier } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import type { ToolDefinition } from "../src/runners/types.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

let root: string, db: ControlPlaneDb;
let savedHome: string | undefined;
let orch: HarnessOrchestrator;
let started: ReturnType<typeof Promise.withResolvers<void>>;
let finish: ReturnType<typeof Promise.withResolvers<void>>;
beforeEach(() => {
  started = Promise.withResolvers<void>();
  finish = Promise.withResolvers<void>();
  root = mkdtempSync(join(tmpdir(), "cm-integration-"));
  db = new ControlPlaneDb(":memory:");
  savedHome = process.env.PI_HARNESS_HOME;
  process.env.PI_HARNESS_HOME = root;
});
afterEach(async () => {
  finish.resolve();
  await waitForSettlement();
  if (savedHome === undefined) delete process.env.PI_HARNESS_HOME;
  else process.env.PI_HARNESS_HOME = savedHome;
  db.close();
  rmSync(root, { recursive: true, force: true });
});

async function waitForSettlement() {
  const deadline = Date.now() + 2000;
  while (orch?.activeTaskCount()) {
    assert.ok(Date.now() < deadline, "Runner did not settle");
    await Bun.sleep(5);
  }
}

function fixture(factory: CustomRunnerFactory = () => ({ run: async (req) => {
  await finish.promise;
  await req.executeTool("return_task", { status: "completed", summary: "Checked task ID", sources: [{ path: ".pi-harness.json" }] });
  return { text: "", stopReason: "completed" };
} })) {
  const config = withFixtureCatalog(loadConfig(root));
  const quota = new QuotaClient();
  orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota, profile => ({
    run: req => {
      started.resolve();
      return factory(profile).run(req);
    },
  }));
  const run = db.createRun({ goal: "Verify integration", repoRoot: root, baseBranch: "main", baseSha: "abc" });
  const task = (tier: AgentTier, parentId?: string) => db.createTask({
    runId: run.id, parentId, tier, kind: tier === 1 ? "orchestrator" : tier === 2 ? "worker" : "research",
    title: "fixture", objective: "fixture", profileId: config.profiles[0]!.id,
  }).id;
  const call = (id: string, name: string, args = {}): Promise<unknown> => orch.toolExecutor.execute(run.id, id, name, args);
  return { config, orch, run, task, call };
}

it("lists and discovers only the tier's tools in collapsed, hybrid and off modes", async () => {
  const { config, task, call } = fixture();
  assert.equal(config.codeMode, "collapsed");
  for (const tier of [1, 2, 3] as const) {
    const id = task(tier);
    for (const requested of ["collapsed", "hybrid", "off"] as const) {
      config.codeMode = requested;
      const mode = effectiveCodeMode(requested);
      const names = (await call(id, "__list_tools") as ToolDefinition[]).map(t => t.name);
      if (mode === "collapsed") assert.deepEqual(names.sort(), ["code_exec", "tool_search"]);
      else {
        assert.ok(names.includes("tree_view"));
        assert.equal(names.includes("spawn_worker"), tier === 1);
        assert.equal(names.includes("list_models"), tier !== 3);
        for (const name of ["code_exec", "tool_search"]) assert.equal(names.includes(name), mode === "hybrid");
      }
      if (mode === "off") await assert.rejects(call(id, "code_exec", { code: "output(1)" }), /not permitted/);
      else {
        const { matched } = await call(id, "tool_search", { names: ["tree_view", "spawn_worker", "list_models"] }) as { matched: string[] };
        assert.ok(matched.includes("tree_view"));
        assert.equal(matched.includes("spawn_worker"), tier === 1);
        assert.equal(matched.includes("list_models"), tier !== 3);
      }
    }
  }
});

it.skipIf(effectiveCodeMode("collapsed") === "off")("chains scoped calls, records live events, and externalizes output under the run repo", async () => {
  writeFileSync(join(root, ".pi-harness.json"), JSON.stringify({ codeExec: { maxOutputChars: 4 } }));
  const { task, call, run, orch } = fixture();
  const parent = task(1);
  db.updateTask(parent, { status: "running" });
  const id = task(3, parent);
  orch.launchTaskLoop(id);
  await started.promise;
  const result = await call(id, "code_exec", { code: `
    import { tree_view, task_get } from "harness";
    const { tasks } = await tree_view({});
    output((await task_get({task_id: tasks.find(t => t.tier === 3).id})).task.id);
  ` }) as CodeExecResult;
  assert.ok(result.ok, result.error);
  assert.equal(dirname(result.artifactPath!), join(root, ".harness", "artifacts"));
  const spill = await call(parent, "artifact_read", { path: result.artifactPath }) as { content: string };
  assert.equal(JSON.parse(spill.content), id);
  const events = db.getEventsSince(run.id, 0, id).filter(ev => ev.type === "agent.tool").map(ev => ev.payload);
  assert.deepEqual(events.map(ev => { const { name, status, via } = ev as Record<string, string>; return [name, status, via]; }),
    ["tree_view", "task_get"].flatMap(n => ["in_progress", "completed"].map(s => [n, s, "code_exec"])));
  for (const name of ["spawn_worker", "code_exec", "tool_search"]) {
    const denied = await call(id, "code_exec", { code: `import { ${name} } from "harness"; await ${name}({});` }) as CodeExecResult;
    assert.equal(denied.ok, false);
    assert.match(denied.error ?? "", new RegExp(name));
  }
  finish.resolve();
  await waitForSettlement();
  assert.equal(db.getTask(id)?.status, "completed");
  await assert.rejects(call(id, "code_exec", { code: "output(1)" }), /active task generation/);
});

it.skipIf(effectiveCodeMode("collapsed") === "off")("cancels an in-flight daemon tool call with the same task signal as the in-process runner", async () => {
  const { task, call, orch } = fixture(() => ({ run: async (req) => {
    assert.deepEqual(req.tools.map(t => t.name).sort(), ["code_exec", "tool_search"]);
    assert.match(req.systemPrompt, /## Code Mode/);
    await finish.promise;
    return { text: "", stopReason: "cancelled" };
  } }));
  const id = task(3);
  orch.launchTaskLoop(id);
  await started.promise;
  const off = db.onEvent(ev => {
    if (ev.taskId === id && ev.type === "agent.tool" && (ev.payload as {status: string}).status === "completed") {
      void orch.cancelTask(id, "stop script");
    }
  });
  try {
    const result = await call(id, "code_exec", { code: 'import { tree_view } from "harness"; await tree_view({}); await Bun.sleep(10_000);', timeout_s: 2 }) as CodeExecResult;
    assert.equal(result.cancelled, true, result.error);
    assert.equal(result.timedOut, undefined);
  } finally {
    off();
  }
});
