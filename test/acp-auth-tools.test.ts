import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogCompiler, type RoutingSkip } from "../src/catalog/compiler.js";
import { RANKING_COHORT } from "../src/catalog/sources.js";
import { loadConfig, type HarnessConfig, type RunnerProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { AUTH_COOLDOWN_BASE_MS, QuotaClient } from "../src/quota/client.js";

interface ListModelsQuota {
  availability: string;
  exhausted: boolean;
  remainingPct: number | null;
  bucket: string | null;
  nextAvailableAt: string | null;
  reason: string | null;
  unavailableReason?: "auth" | "quota";
}

interface ListModelsResult {
  recommendedByKind: Record<string, { model: string; profile?: string } | null>;
  skippedForRouting: RoutingSkip[];
  models: Array<{
    id: string;
    profile: string;
    quota: ListModelsQuota | null;
    alternateRoutes?: Array<{
      profile: string;
      wireModel: string;
      billing: string;
      quota?: ListModelsQuota;
    }>;
  }>;
}

function makeCatalogFixture(quota: QuotaClient): {
  stateDir: string;
  config: HarnessConfig;
  compiler: ModelCatalogCompiler;
  cleanup: () => void;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-auth-tools-"));
  const profiles: RunnerProfileConfig[] = [
    {
      id: "acp:gemini",
      kind: "acp",
      adapter: "gemini",
      command: "gemini",
      args: ["--acp"],
      billing: "subscription",
      enabled: true,
    },
    {
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "claude",
      billing: "subscription",
      enabled: true,
    },
  ];
  const config: HarnessConfig = {
    ...loadConfig(stateDir),
    stateDir,
    profiles,
    defaultOrchestratorProfile: "acp:gemini",
    defaultWorkerProfile: "acp:gemini",
    defaultTaskProfile: "acp:gemini",
    catalog: { ttlHours: 24 },
  };
  const evidence = {
    ...RANKING_COHORT,
    revision: "https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.TestFix1.json",
    asOf: new Date().toISOString().slice(0, 10),
  };
  const compiler = new ModelCatalogCompiler(config, quota);
  const compiled = compiler.compileFromData({
    enabledProfiles: profiles,
    inventory: new Map([
      ["acp:gemini", [{ wireModelId: "gemini-4-neon" }]],
      ["acp:claude", [{ wireModelId: "claude-opus-5-5" }]],
    ]),
    modelsDev: [],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [
      {
        source: "vals_tb4",
        rawModelName: "google/gemini-4-neon",
        canonicalKeyHint: "google/gemini-4-neon",
        effort: "high",
        codingScore: 74,
        costPerTaskUsd: 3.0,
        timePerTaskSeconds: 600,
        evidence,
      },
      {
        source: "vals_tb4",
        rawModelName: "anthropic/claude-opus-5-5",
        canonicalKeyHint: "anthropic/claude-opus-5-5",
        effort: "high",
        codingScore: 68,
        costPerTaskUsd: 9.0,
        timePerTaskSeconds: 1800,
        evidence,
      },
    ],
    sources: ["vals_ai"],
  });
  writeFileSync(compiler.cachePath, JSON.stringify(compiled), "utf8");
  return {
    stateDir,
    config,
    compiler,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

function makeBaseHooks(db: ControlPlaneDb, overrides?: Partial<ToolRuntimeHooks>): ToolRuntimeHooks {
  return {
    spawnAndStartTask: async (input) =>
      db.createTask({
        runId: input.runId,
        parentId: input.parentId,
        tier: input.tier,
        kind: input.kind,
        title: input.title,
        objective: input.objective,
        criteria: input.criteria,
        readOnly: input.readOnly,
        profileId: input.profileId ?? "acp:gemini",
        model: input.model,
        effort: input.effort,
        dependsOn: input.dependsOn,
        writeScopes: input.writeScopes,
      }),
    waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
    steerTask: async () => false,
    cancelTask: async () => {},
    scheduleRollover: async () => {},
    getWorktreeManager: () => {
      throw new Error("unused");
    },
    getMergeQueue: () => {
      throw new Error("unused");
    },
    getTaskSignal: () => undefined,
    ...overrides,
  };
}

describe("ControlPlaneToolExecutor ACP auth hooks, list_models auth fields, and spawn warnings", () => {
  it("list_models reports auth-blocked models with unavailableReason, reason, skippedForRouting, excludes from recommendedByKind, and restores on authOk", async () => {
    const quota = new QuotaClient();
    const { config, compiler, cleanup } = makeCatalogFixture(quota);
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({ goal: "Auth tools test", repoRoot: config.stateDir, baseBranch: "main", baseSha: "abc1234" });
      const orch = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "acp:claude",
      });
      const executor = new ControlPlaneToolExecutor(db, () => compiler, makeBaseHooks(db), config);

      // Baseline: gemini-4-neon is healthy and highest-ranked.
      const before = (await executor.execute(run.id, orch.id, "list_models", {})) as ListModelsResult;
      assert.deepEqual(before.skippedForRouting, []);
      assert.equal(before.recommendedByKind.orchestrator?.model, "google/gemini-4-neon");
      const beforeGemini = before.models.find((m) => m.id === "google/gemini-4-neon");
      assert.ok(beforeGemini);
      assert.equal(beforeGemini.quota?.unavailableReason, undefined);

      // Ingest auth_required for acp:gemini.
      const observedAt = Date.now();
      quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Authentication required" },
        observedAt,
      });

      const blocked = (await executor.execute(run.id, orch.id, "list_models", {})) as ListModelsResult;
      const blockedGemini = blocked.models.find((m) => m.id === "google/gemini-4-neon");
      assert.ok(blockedGemini?.quota);
      assert.equal(blockedGemini.quota.availability, "NEEDS_LOGIN");
      assert.equal(blockedGemini.quota.unavailableReason, "auth");
      assert.equal(blockedGemini.quota.nextAvailableAt, new Date(observedAt + AUTH_COOLDOWN_BASE_MS).toISOString());
      assert.match(blockedGemini.quota.reason ?? "", /ACP profile acp:gemini needs login/);

      assert.deepEqual(blocked.skippedForRouting, [
        {
          model: "google/gemini-4-neon",
          profile: "acp:gemini",
          reason: "auth",
          until: new Date(observedAt + AUTH_COOLDOWN_BASE_MS).toISOString(),
        },
      ]);

      // recommendedByKind excludes auth-blocked models across all task kinds.
      for (const [kind, rec] of Object.entries(blocked.recommendedByKind)) {
        assert.notEqual(rec?.model, "google/gemini-4-neon", `kind ${kind} should not recommend auth-blocked model`);
      }
      assert.equal(blocked.recommendedByKind.orchestrator?.model, "anthropic/claude-opus-5-5");

      // Ingest authOk: true for acp:gemini -> restored.
      quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { authOk: true },
        observedAt: Date.now(),
      });

      const restored = (await executor.execute(run.id, orch.id, "list_models", {})) as ListModelsResult;
      assert.deepEqual(restored.skippedForRouting, []);
      assert.equal(restored.recommendedByKind.orchestrator?.model, "google/gemini-4-neon");
      const restoredGemini = restored.models.find((m) => m.id === "google/gemini-4-neon");
      assert.ok(restoredGemini);
      assert.equal(restoredGemini.quota?.unavailableReason, undefined);
      if (restoredGemini.quota) {
        assert.equal("unavailableReason" in restoredGemini.quota, false);
        assert.equal(restoredGemini.quota.reason, null);
      }
    } finally {
      db.close();
      cleanup();
    }
  });

  it("__list_tools invokes onToolsListed with the calling task id", async () => {
    const db = new ControlPlaneDb(":memory:");
    try {
      const cfg = loadConfig(process.cwd());
      const run = db.createRun({ goal: "List tools hook test", repoRoot: process.cwd(), baseBranch: "main", baseSha: "abc1234" });
      const worker = db.createTask({
        runId: run.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Do work",
        profileId: "acp:gemini",
      });

      const listedIds: string[] = [];
      const executor = new ControlPlaneToolExecutor(
        db,
        () => {
          throw new Error("unused");
        },
        makeBaseHooks(db, {
          onToolsListed: (taskId) => listedIds.push(taskId),
        }),
        cfg,
      );

      const tools = (await executor.execute(run.id, worker.id, "__list_tools", {})) as Array<{ name: string }>;
      assert.ok(Array.isArray(tools) && tools.length > 0);
      assert.deepEqual(listedIds, [worker.id]);
    } finally {
      db.close();
    }
  });

  it("spawn_task and spawn_worker include profileAuthAdvisory and merge it with existing warnings", async () => {
    const quota = new QuotaClient();
    const observedAt = Date.now();
    quota.ingestPassiveSignal({
      profileId: "acp:gemini",
      model: null,
      raw: { sessionFailure: "auth_required", detail: "Authentication required" },
      observedAt,
    });

    const db = new ControlPlaneDb(":memory:");
    try {
      const cfg = loadConfig(process.cwd());
      const run = db.createRun({ goal: "Spawn auth warning test", repoRoot: process.cwd(), baseBranch: "main", baseSha: "abc1234" });
      const orch = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "acp:claude",
      });

      const advisoryCalls: string[] = [];
      const executor = new ControlPlaneToolExecutor(
        db,
        () => {
          throw new Error("unused");
        },
        makeBaseHooks(db, {
          profileAuthAdvisory: (profileId) => {
            advisoryCalls.push(profileId);
            const auth = quota.authStatus(profileId);
            if (!auth) return null;
            return `Profile ${profileId} failed authentication recently (needs login until ${auth.until}); this task may fail immediately. Prefer recommendedByKind or log in first.`;
          },
        }),
        cfg,
      );

      // 1. spawn_task on auth-failed profile returns auth advisory in warning.
      const taskRes = (await executor.execute(run.id, orch.id, "spawn_task", {
        kind: "research",
        title: "Check auth",
        objective: "Inspect files",
        profile_id: "acp:gemini",
        model: "google/gemini-4-neon",
      })) as { spawned: string; warning?: string };
      assert.match(taskRes.warning ?? "", /Profile acp:gemini failed authentication recently \(needs login until /);

      // 2. spawn_task on healthy profile omits warning.
      const healthyTaskRes = (await executor.execute(run.id, orch.id, "spawn_task", {
        kind: "research",
        title: "Healthy check",
        objective: "Inspect files",
        profile_id: "acp:claude",
        model: "anthropic/claude-opus-5-5",
      })) as { spawned: string; warning?: string };
      assert.equal(healthyTaskRes.warning, undefined);

      // 3. spawn_worker on auth-failed profile returns auth advisory in warning.
      const workerRes = (await executor.execute(run.id, orch.id, "spawn_worker", {
        title: "Auth worker",
        objective: "Implement feature",
        write_scopes: ["src/foo.ts"],
        profile_id: "acp:gemini",
        model: "google/gemini-4-neon",
      })) as { spawned: string; warning?: string };
      assert.match(workerRes.warning ?? "", /Profile acp:gemini failed authentication recently \(needs login until /);

      // 4. Both duplicate-after-restart advisory and profileAuthAdvisory merge cleanly into warning.
      db.emitEvent(run.id, orch.id, "task.resumed", { note: "daemon_restart", generation: orch.generation });

      const dupTaskRes = (await executor.execute(run.id, orch.id, "spawn_task", {
        kind: "research",
        title: "Check auth",
        objective: "Inspect files again",
        profile_id: "acp:gemini",
        model: "google/gemini-4-neon",
      })) as { spawned: string; warning?: string };
      assert.match(dupTaskRes.warning ?? "", /already exists under you and predates the daemon restart/);
      assert.match(dupTaskRes.warning ?? "", /Profile acp:gemini failed authentication recently/);

      const dupWorkerRes = (await executor.execute(run.id, orch.id, "spawn_worker", {
        title: "Auth worker",
        objective: "Implement feature again",
        write_scopes: ["src/bar.ts"],
        profile_id: "acp:gemini",
        model: "google/gemini-4-neon",
      })) as { spawned: string; warning?: string };
      assert.match(dupWorkerRes.warning ?? "", /already exists under you and predates the daemon restart/);
      assert.match(dupWorkerRes.warning ?? "", /Profile acp:gemini failed authentication recently/);

      assert.deepEqual(advisoryCalls, ["acp:gemini", "acp:claude", "acp:gemini", "acp:gemini", "acp:gemini"]);
    } finally {
      db.close();
    }
  });

  it("list_models reports auth-blocked alternates and computes skippedForRouting before exclude_exhausted filtering", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-auth-tools-alt-"));
    const db = new ControlPlaneDb(":memory:");
    try {
      const profiles: RunnerProfileConfig[] = [
        {
          id: "pi:openai",
          kind: "pi",
          provider: "openai",
          models: ["gpt-6.2-astra"],
          billing: "subscription",
          enabled: true,
        },
        {
          id: "acp:amp",
          kind: "acp",
          adapter: "generic",
          command: "npx",
          args: ["-y", "amp-acp"],
          billing: "api",
          enabled: true,
        },
        {
          id: "acp:gemini",
          kind: "acp",
          adapter: "gemini",
          command: "gemini",
          args: ["--acp"],
          billing: "subscription",
          enabled: true,
        },
      ];
      const config: HarnessConfig = {
        ...loadConfig(stateDir),
        stateDir,
        profiles,
        defaultOrchestratorProfile: "pi:openai",
        defaultWorkerProfile: "pi:openai",
        defaultTaskProfile: "pi:openai",
        catalog: { ttlHours: 24 },
      };
      const quota = new QuotaClient();
      const evidence = {
        ...RANKING_COHORT,
        revision: "https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.TestFix1.json",
        asOf: new Date().toISOString().slice(0, 10),
      };
      const compiler = new ModelCatalogCompiler(config, quota);
      const compiled = compiler.compileFromData({
        enabledProfiles: profiles,
        inventory: new Map([
          ["pi:openai", [{ wireModelId: "gpt-6.2-astra" }]],
          ["acp:amp", [{ wireModelId: "openai/gpt-6.2-astra" }]],
          ["acp:gemini", [{ wireModelId: "gemini-4-neon" }]],
        ]),
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [
          {
            source: "vals_tb4",
            rawModelName: "openai/gpt-6.2-astra",
            canonicalKeyHint: "openai/gpt-6.2-astra",
            effort: "high",
            codingScore: 76,
            costPerTaskUsd: 5.0,
            timePerTaskSeconds: 900,
            evidence,
          },
          {
            source: "vals_tb4",
            rawModelName: "google/gemini-4-neon",
            canonicalKeyHint: "google/gemini-4-neon",
            effort: "high",
            codingScore: 74,
            costPerTaskUsd: 3.0,
            timePerTaskSeconds: 600,
            evidence,
          },
        ],
        sources: ["vals_ai"],
      });
      writeFileSync(compiler.cachePath, JSON.stringify(compiled), "utf8");

      const observedAt = Date.now();
      const expectedUntil = new Date(observedAt + AUTH_COOLDOWN_BASE_MS).toISOString();
      quota.ingestPassiveSignal({
        profileId: "acp:amp",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Authentication required" },
        observedAt,
      });
      quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Authentication required" },
        observedAt,
      });

      const run = db.createRun({ goal: "Auth tools alt test", repoRoot: stateDir, baseBranch: "main", baseSha: "abc1234" });
      const orch = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi:openai",
      });
      const executor = new ControlPlaneToolExecutor(db, () => compiler, makeBaseHooks(db), config);

      const expectedSkips: RoutingSkip[] = [
        { model: "openai/gpt-6.2-astra", profile: "acp:amp", reason: "auth", until: expectedUntil },
        { model: "google/gemini-4-neon", profile: "acp:gemini", reason: "auth", until: expectedUntil },
      ];

      const unfiltered = (await executor.execute(run.id, orch.id, "list_models", {
        exclude_exhausted: false,
      })) as ListModelsResult;
      assert.deepEqual(unfiltered.skippedForRouting, expectedSkips);
      const astra = unfiltered.models.find((m) => m.id === "openai/gpt-6.2-astra");
      assert.ok(astra);
      assert.equal(astra.profile, "pi:openai");
      assert.equal(astra.quota, null);
      assert.equal(astra.alternateRoutes?.[0]?.profile, "acp:amp");
      assert.equal(astra.alternateRoutes?.[0]?.quota?.availability, "NEEDS_LOGIN");
      assert.equal(astra.alternateRoutes?.[0]?.quota?.unavailableReason, "auth");
      assert.equal(astra.alternateRoutes?.[0]?.quota?.nextAvailableAt, expectedUntil);

      const filtered = (await executor.execute(run.id, orch.id, "list_models", {
        exclude_exhausted: true,
      })) as ListModelsResult;
      assert.deepEqual(
        filtered.models.map((m) => m.id),
        ["openai/gpt-6.2-astra"],
      );
      assert.deepEqual(filtered.skippedForRouting, expectedSkips);
      assert.equal(filtered.recommendedByKind.orchestrator?.model, "openai/gpt-6.2-astra");
      assert.equal(filtered.recommendedByKind.orchestrator?.profile, "pi:openai");
    } finally {
      db.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
