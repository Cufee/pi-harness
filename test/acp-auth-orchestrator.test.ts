import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler, type RoutingSkip } from "../src/catalog/compiler.js";
import { RANKING_COHORT } from "../src/catalog/sources.js";
import { loadConfig, type HarnessConfig, type RunnerProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import { AcpProfileError } from "../src/runners/acp-profile-error.js";
import type { RunAgentRequest } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";

interface WaitChildrenResult {
  children: Array<{
    id: string;
    status: string;
    summary: string | null;
    partial?: boolean;
  }>;
}

interface ListModelsResult {
  recommendedByKind: Record<string, { model: string; profile?: string } | null>;
  skippedForRouting: RoutingSkip[];
  models: Array<{
    id: string;
    profile: string;
    quota: {
      availability: string;
      unavailableReason?: "auth" | "quota";
      reason: string | null;
      nextAvailableAt: string | null;
    } | null;
  }>;
}

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, baseSha };
}

function createAcpTestOrchestrator(
  repoRoot: string,
  stateDir: string,
  runnerFactory: CustomRunnerFactory,
) {
  const db = new ControlPlaneDb(":memory:");
  const profiles: RunnerProfileConfig[] = [
    {
      id: "acp:fake",
      kind: "acp",
      adapter: "gemini",
      command: "gemini",
      args: ["--acp"],
      billing: "subscription",
      enabled: true,
    },
    {
      id: "acp:backup",
      kind: "acp",
      adapter: "claude",
      command: "claude",
      billing: "subscription",
      enabled: true,
    },
    {
      id: "pi:local",
      kind: "pi",
      provider: "fixture",
      billing: "local",
      models: ["fixture"],
      enabled: true,
    },
  ];
  const config: HarnessConfig = {
    ...loadConfig(repoRoot),
    codeMode: "off",
    stateDir,
    profiles,
    defaultOrchestratorProfile: "acp:backup",
    defaultWorkerProfile: "acp:fake",
    defaultTaskProfile: "acp:fake",
    catalog: { ttlHours: 24 },
    quotaEndpoint: undefined,
  };
  const quota = new QuotaClient();
  const catalog = new ModelCatalogCompiler(config, quota);
  const evidence = {
    ...RANKING_COHORT,
    revision: "https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.TestFix1.json",
    asOf: new Date().toISOString().slice(0, 10),
  };
  const compiled = catalog.compileFromData({
    enabledProfiles: profiles,
    inventory: new Map([
      ["acp:fake", [{ wireModelId: "gemini-4-neon" }]],
      ["acp:backup", [{ wireModelId: "claude-opus-5-5" }]],
      ["pi:local", [{ wireModelId: "fixture" }]],
    ]),
    profileStatuses: [
      { profileId: "acp:fake", status: "ok", modelCount: 1 },
      { profileId: "acp:backup", status: "ok", modelCount: 1 },
      { profileId: "pi:local", status: "ok", modelCount: 1 },
    ],
    modelsDev: [],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [
      {
        source: "vals_tb4",
        rawModelName: "google/gemini-4-neon",
        canonicalKeyHint: "google/gemini-4-neon",
        effort: "high",
        codingScore: 76,
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
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(catalog.cachePath, JSON.stringify(compiled), "utf8");
  const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);
  return { db, config, quota, catalog, orch };
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  assert.ok(pred(), `Timed out waiting for ${label}`);
}

describe("HarnessOrchestrator ACP auth readiness and tools-missing wiring", () => {
  it("fails auth_required with structured handoff, marks profile unavailable in list_models, warns on spawn, and restores on authOk", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-acp-auth-e2e-");
    const stateDir = join(root, "state");
    let fakeAttempt = 0;

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        fakeAttempt += 1;
        if (fakeAttempt === 1) {
          req.callbacks.onPassiveQuota?.({
            profileId: "acp:fake",
            model: null,
            raw: { sessionFailure: "auth_required", detail: "Authentication required (-32000)" },
            observedAt: Date.now(),
          });
          throw new AcpProfileError(
            "auth_required",
            "acp:fake",
            "ACP profile acp:fake is not authenticated (Authentication required). Log in with the profile's CLI (gemini) and retry, or choose another model.",
          );
        }
        // Second attempt succeeds after the user logged in and emits authOk.
        req.callbacks.onPassiveQuota?.({
          profileId: "acp:fake",
          model: null,
          raw: { authOk: true },
          observedAt: Date.now(),
        });
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Recovered after login",
          sources: [{ path: "README.md", note: "checked" }],
        });
        return { text: "Recovered after login", stopReason: "completed" };
      },
    });

    const { db, orch } = createAcpTestOrchestrator(repoRoot, stateDir, runnerFactory);
    try {
      const run = db.createRun({ goal: "ACP auth e2e", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Parent",
        objective: "Coordinate children",
        profileId: "acp:backup",
        model: "anthropic/claude-opus-5-5",
      });
      db.updateTask(parent.id, { status: "running" });

      const firstSpawn = (await orch.toolExecutor.execute(run.id, parent.id, "spawn_task", {
        kind: "research",
        title: "Probe auth failure",
        objective: "Check repo",
        profile_id: "acp:fake",
        model: "google/gemini-4-neon",
      })) as { spawned: string; warning?: string };
      assert.equal(firstSpawn.warning, undefined);

      await waitUntil(() => db.getTask(firstSpawn.spawned)?.status === "failed", 4000, "first task failed");

      const failedRow = db.getTask(firstSpawn.spawned)!;
      assert.equal(failedRow.status, "failed");
      assert.match(failedRow.summary ?? "", /acp_auth_required/);
      assert.match(failedRow.summary ?? "", /acp:fake/);
      assert.match(failedRow.summary ?? "", /needs login/i);

      const parsedResult = JSON.parse(failedRow.resultJson ?? "{}") as {
        fallback?: { reason?: string; summary?: string; partial?: boolean };
      };
      assert.equal(parsedResult.fallback?.partial, true);
      assert.match(parsedResult.fallback?.reason ?? "", /^acp_auth_required: profile acp:fake needs login;/);
      assert.match(parsedResult.fallback?.summary ?? "", /acp_auth_required: profile acp:fake needs login/);

      const waited = (await orch.toolExecutor.execute(run.id, parent.id, "wait_children", {
        ids: [firstSpawn.spawned],
      })) as WaitChildrenResult;
      assert.equal(waited.children.length, 1);
      assert.equal(waited.children[0]!.status, "failed");
      assert.match(waited.children[0]!.summary ?? "", /acp_auth_required/);
      assert.match(waited.children[0]!.summary ?? "", /acp:fake/);
      assert.match(waited.children[0]!.summary ?? "", /login/i);

      const errorEvents = db
        .getEventsSince(run.id, 0, firstSpawn.spawned)
        .filter((e) => e.type === "agent.error");
      assert.equal(errorEvents.length, 1);
      const errPayload = errorEvents[0]!.payload as Record<string, unknown>;
      assert.equal(errPayload.infrastructure, true);
      assert.equal(errPayload.kind, "auth_required");
      assert.equal(errPayload.profileId, "acp:fake");

      // list_models reflects unavailableReason: "auth" and skips acp:fake in routing.
      const blockedModels = (await orch.toolExecutor.execute(run.id, parent.id, "list_models", {})) as ListModelsResult;
      const fakeModel = blockedModels.models.find((m) => m.id === "google/gemini-4-neon");
      assert.ok(fakeModel?.quota);
      assert.equal(fakeModel.quota.unavailableReason, "auth");
      assert.equal(fakeModel.quota.availability, "NEEDS_LOGIN");
      assert.ok(blockedModels.skippedForRouting.some((s) => s.profile === "acp:fake" && s.reason === "auth"));

      // Explicit spawn on auth-blocked profile still creates the task and attaches profileAuthAdvisory warning.
      const retrySpawn = (await orch.toolExecutor.execute(run.id, parent.id, "spawn_task", {
        kind: "research",
        title: "Retry after login",
        objective: "Check repo again",
        profile_id: "acp:fake",
        model: "google/gemini-4-neon",
      })) as { spawned: string; warning?: string };
      assert.ok(retrySpawn.warning);
      assert.match(retrySpawn.warning, /acp:fake/);
      assert.match(retrySpawn.warning, /cooldown until/i);
      assert.match(retrySpawn.warning, /login/i);

      await waitUntil(() => db.getTask(retrySpawn.spawned)?.status === "completed", 4000, "retry task completed");

      // authOk restored readiness in list_models and cleared profileAuthAdvisory.
      const restoredModels = (await orch.toolExecutor.execute(run.id, parent.id, "list_models", {})) as ListModelsResult;
      const restoredFake = restoredModels.models.find((m) => m.id === "google/gemini-4-neon");
      assert.equal(restoredFake?.quota?.unavailableReason, undefined);
      assert.equal(restoredModels.skippedForRouting.length, 0);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails tools_missing with infrastructure error and non-completed handoff naming the profile", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-acp-tools-missing-e2e-");
    const stateDir = join(root, "state");

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async () => {
        throw new AcpProfileError(
          "tools_missing",
          "acp:fake",
          "ACP profile acp:fake started a session without the harness MCP tools: bridge was never queried within 20000 ms; respawn on another profile.",
        );
      },
    });

    const { db, orch } = createAcpTestOrchestrator(repoRoot, stateDir, runnerFactory);
    try {
      const run = db.createRun({ goal: "ACP tools_missing e2e", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Parent",
        objective: "Coordinate children",
        profileId: "acp:backup",
        model: "anthropic/claude-opus-5-5",
      });
      db.updateTask(parent.id, { status: "running" });

      const spawned = (await orch.toolExecutor.execute(run.id, parent.id, "spawn_task", {
        kind: "research",
        title: "Session missing MCP tools",
        objective: "Inspect files",
        profile_id: "acp:fake",
        model: "google/gemini-4-neon",
      })) as { spawned: string };

      await waitUntil(() => db.getTask(spawned.spawned)?.status === "failed", 4000, "tools_missing task failed");

      const row = db.getTask(spawned.spawned)!;
      assert.equal(row.status, "failed");
      assert.match(row.summary ?? "", /tools_missing/);
      assert.match(row.summary ?? "", /acp:fake/);

      const parsed = JSON.parse(row.resultJson ?? "{}") as {
        status?: string;
        fallback?: { reason?: string; summary?: string; partial?: boolean };
      };
      assert.equal(parsed.status, "failed");
      assert.equal(parsed.fallback?.partial, true);
      assert.match(parsed.fallback?.reason ?? "", /^tools_missing: profile acp:fake session started without harness MCP tools;/);

      const waited = (await orch.toolExecutor.execute(run.id, parent.id, "wait_children", {
        ids: [spawned.spawned],
      })) as WaitChildrenResult;
      assert.equal(waited.children[0]!.status, "failed");
      assert.equal(waited.children[0]!.partial, true);
      assert.match(waited.children[0]!.summary ?? "", /tools_missing/);
      assert.match(waited.children[0]!.summary ?? "", /acp:fake/);
      assert.match(waited.children[0]!.summary ?? "", /without harness MCP tools/);

      const errorEvents = db
        .getEventsSince(run.id, 0, spawned.spawned)
        .filter((e) => e.type === "agent.error");
      assert.equal(errorEvents.length, 1);
      const errPayload = errorEvents[0]!.payload as Record<string, unknown>;
      assert.equal(errPayload.infrastructure, true);
      assert.equal(errPayload.kind, "tools_missing");
      assert.equal(errPayload.profileId, "acp:fake");
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("wires onToolsListed via __list_tools to harnessToolsListedSince for ACP tasks and cleans up on settle", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-acp-tools-listed-e2e-");
    const stateDir = join(root, "state");

    let acpListedBefore: boolean | null = null;
    let acpListedAfter: boolean | null = null;
    let acpListedFuture: boolean | null = null;
    let capturedAcpCheck: RunAgentRequest["harnessToolsListedSince"];
    let piCheck: RunAgentRequest["harnessToolsListedSince"] | "not-called" = "not-called";

    const runnerFactory: CustomRunnerFactory = (profile) => ({
      run: async (req) => {
        if (profile.kind === "acp") {
          capturedAcpCheck = req.harnessToolsListedSince;
          assert.equal(typeof req.harnessToolsListedSince, "function");
          const sessionStartMs = Date.now();
          acpListedBefore = req.harnessToolsListedSince!(sessionStartMs);
          await req.executeTool("__list_tools", {});
          acpListedAfter = req.harnessToolsListedSince!(sessionStartMs);
          acpListedFuture = req.harnessToolsListedSince!(Date.now() + 60_000);
        } else {
          piCheck = req.harnessToolsListedSince;
        }
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Done",
          sources: [{ path: "README.md", note: "checked" }],
        });
        return { text: "Done", stopReason: "completed" };
      },
    });

    const { db, orch } = createAcpTestOrchestrator(repoRoot, stateDir, runnerFactory);
    try {
      const run = db.createRun({ goal: "ACP toolsListedAt wiring", repoRoot, baseBranch: "main", baseSha });
      const parent = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Parent",
        objective: "Coordinate children",
        profileId: "acp:backup",
        model: "anthropic/claude-opus-5-5",
      });
      db.updateTask(parent.id, { status: "running" });

      const acpSpawn = (await orch.toolExecutor.execute(run.id, parent.id, "spawn_task", {
        kind: "research",
        title: "ACP child",
        objective: "Verify __list_tools",
        profile_id: "acp:fake",
        model: "google/gemini-4-neon",
      })) as { spawned: string };

      await waitUntil(() => db.getTask(acpSpawn.spawned)?.status === "completed", 4000, "ACP child completed");
      await waitUntil(() => !orch.executingTaskIds().includes(acpSpawn.spawned), 4000, "ACP child inactive");

      assert.equal(acpListedBefore, false);
      assert.equal(acpListedAfter, true);
      assert.equal(acpListedFuture, false);
      // Map entry is cleaned up once the task settles.
      assert.equal(capturedAcpCheck?.(0), false);

      // Non-ACP (pi) tasks do not receive harnessToolsListedSince.
      const piSpawn = (await orch.toolExecutor.execute(run.id, parent.id, "spawn_task", {
        kind: "research",
        title: "Pi child",
        objective: "Verify pi skips ACP tools hook",
        profile_id: "pi:local",
        model: "fixture",
      })) as { spawned: string };

      await waitUntil(() => db.getTask(piSpawn.spawned)?.status === "completed", 4000, "Pi child completed");
      assert.equal(piCheck, undefined);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
