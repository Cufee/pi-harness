import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig, type HarnessConfig, type RunnerProfileConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { resolveLaunchRoute } from "../src/control-plane/launch-route.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";

const profiles: RunnerProfileConfig[] = [
  { id: "acp:amp", kind: "acp", adapter: "amp", command: "amp", args: ["--acp"], billing: "subscription", enabled: true },
  { id: "acp:claude", kind: "acp", adapter: "claude", command: "claude", args: [], billing: "subscription", enabled: true },
] as RunnerProfileConfig[];

/** Writes a compiled catalog with amp's provider-prefixed wire IDs and claude's `opus` alias. */
function setup(): { stateDir: string; config: HarnessConfig; compiler: ModelCatalogCompiler } {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-resolve-"));
  const config: HarnessConfig = {
    ...loadConfig(stateDir),
    stateDir,
    profiles,
    defaultOrchestratorProfile: "acp:claude",
    catalog: { ttlHours: 24 },
  };
  const compiler = new ModelCatalogCompiler(config);
  const catalog = compiler.compileFromData({
    enabledProfiles: profiles,
    inventory: new Map([
      [
        "acp:amp",
        [
          { wireModelId: "anthropic/claude-opus-5-5" },
          { wireModelId: "google-vertex/gemini-4-carbon", supportedEfforts: ["low", "high"] },
          { wireModelId: "zhipuai/glm-5.3" },
        ],
      ],
      ["acp:claude", [{ wireModelId: "opus" }]],
    ]),
    modelsDev: [
      { id: "claude-opus-5-5", provider: "anthropic", name: "Claude Opus 5.5", family: "claude-opus", releaseDate: "2026-10-01" },
    ],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [],
    sources: [],
  });
  writeFileSync(compiler.cachePath, JSON.stringify(catalog), "utf8");
  return { stateDir, config, compiler };
}

describe("ModelCatalogCompiler.resolveForProfile", () => {
  it("translates canonical, bare and wire IDs to the profile's probed wire ID", () => {
    const { stateDir, compiler } = setup();
    try {
      const wire = (profile: string, model: string) => compiler.resolveForProfile(profile, model)?.wireModelId ?? null;

      // canonical -> wire
      assert.equal(wire("acp:amp", "google/gemini-4-carbon"), "google-vertex/gemini-4-carbon");
      assert.equal(wire("acp:amp", "zai/glm-5.3"), "zhipuai/glm-5.3");
      assert.equal(wire("acp:amp", "anthropic/claude-opus-5-5"), "anthropic/claude-opus-5-5");
      assert.equal(wire("acp:claude", "anthropic/claude-opus-5-5"), "opus");
      assert.deepEqual(compiler.resolveForProfile("acp:amp", "zai/glm-5.3"), {
        wireModelId: "zhipuai/glm-5.3",
        canonicalId: "zai/glm-5.3",
      });

      // bare -> wire, and wire passes through unchanged
      assert.equal(wire("acp:amp", "gemini-4-carbon"), "google-vertex/gemini-4-carbon");
      assert.equal(wire("acp:amp", "glm-5.3"), "zhipuai/glm-5.3");
      assert.equal(wire("acp:amp", "google-vertex/gemini-4-carbon"), "google-vertex/gemini-4-carbon");
      assert.equal(wire("acp:amp", "zhipuai/glm-5.3"), "zhipuai/glm-5.3");
      assert.equal(wire("acp:claude", "opus"), "opus");

      // unknown model, a model the profile has no route for, or unknown profile -> null (caller falls back)
      assert.equal(compiler.resolveForProfile("acp:amp", "openai/gpt-6.2-astra"), null);
      assert.equal(compiler.resolveForProfile("acp:claude", "google/gemini-4-carbon"), null);
      assert.equal(compiler.resolveForProfile("acp:codex", "zai/glm-5.3"), null);

      // effort is kept only when the route supports it
      assert.equal(compiler.resolveForProfile("acp:amp", "google/gemini-4-carbon", "high")?.effort, "high");
      assert.equal(compiler.resolveForProfile("acp:amp", "google/gemini-4-carbon", "xhigh")?.effort, undefined);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns null without a cached catalog", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-resolve-empty-"));
    try {
      const compiler = new ModelCatalogCompiler({ ...loadConfig(stateDir), stateDir, profiles });
      assert.equal(compiler.resolveForProfile("acp:amp", "google/gemini-4-carbon"), null);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("orchestrator hands the runner the wire ID while the task row keeps the canonical ID", async () => {
    const { stateDir, config, compiler } = setup();
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-resolve-repo-"));
    await runGit(repoRoot, ["init", "-b", "main"]);
    await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "--allow-empty", "-m", "init"]);
    const db = new ControlPlaneDb(":memory:");
    const quota = new QuotaClient();
    const seen: Array<{ profileId: string; model: string | null | undefined }> = [];
    const orch = new HarnessOrchestrator(db, config, compiler, quota, (profile) => ({
      run: async (req) => {
        seen.push({ profileId: profile.id, model: req.model });
        return { text: "done", stopReason: "completed" };
      },
    }));
    try {
      const { orchestratorTask } = await orch.startRun({
        goal: "Resolve models",
        repoRoot,
        profileId: "acp:claude",
        model: "anthropic/claude-opus-5-5",
      });
      for (let i = 0; i < 80 && orch.activeTaskCount() > 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.deepEqual(seen, [{ profileId: "acp:claude", model: "opus" }]);
      assert.equal(db.getTask(orchestratorTask.id)?.model, "anthropic/claude-opus-5-5");
    } finally {
      orch.dispose();
      db.close();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("resolveLaunchRoute skips throttled/exhausted routes and falls back to a healthy alternateRoute for a requested model", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-launch-failover-"));
    try {
      const failoverProfiles: RunnerProfileConfig[] = [
        { id: "acp:claude-acct1", kind: "acp", adapter: "claude", command: "claude", billing: "subscription", enabled: true },
        { id: "acp:claude-acct2", kind: "acp", adapter: "claude", command: "claude", billing: "subscription", enabled: true },
      ];
      const config: HarnessConfig = {
        ...loadConfig(stateDir),
        stateDir,
        profiles: failoverProfiles,
        defaultOrchestratorProfile: "acp:claude-acct1",
        catalog: { ttlHours: 24 },
      };
      const quota = new QuotaClient();
      // Mark acct1 THROTTLED (rate_limited) -> unavailable even though exhausted === false
      quota.ingestPassiveSignal({
        profileId: "acp:claude-acct1",
        model: "claude-opus-5-5",
        raw: { sessionFailure: "rate_limited", resetAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        observedAt: Date.now(),
      });

      const compiler = new ModelCatalogCompiler(config, quota);
      const catalog = compiler.compileFromData({
        enabledProfiles: failoverProfiles,
        inventory: new Map([
          ["acp:claude-acct1", [{ wireModelId: "claude-opus-5-5" }]],
          ["acp:claude-acct2", [{ wireModelId: "claude-opus-5-5" }]],
        ]),
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [],
        sources: [],
      });
      writeFileSync(compiler.cachePath, JSON.stringify(catalog), "utf8");

      // 1. Specific model requested: preferred acct1 is THROTTLED -> falls back to healthy alternate acct2
      const routeForModel = await resolveLaunchRoute(config, {
        tier: 1,
        catalog: compiler,
        quota,
        model: "anthropic/claude-opus-5-5",
      });
      assert.equal(routeForModel.profile.id, "acp:claude-acct2");
      assert.equal(routeForModel.model, "anthropic/claude-opus-5-5");

      // 2. Automatic pick (no model specified): skips throttled acct1 and picks healthy acct2
      const autoRoute = await resolveLaunchRoute(config, {
        tier: 1,
        catalog: compiler,
        quota,
      });
      assert.equal(autoRoute.profile.id, "acp:claude-acct2");

      // 3. When ALL routes for the requested model are throttled/exhausted, fails cleanly
      quota.ingestPassiveSignal({
        profileId: "acp:claude-acct2",
        model: "claude-opus-5-5",
        raw: { sessionFailure: "quota_exhausted", resetAt: new Date(Date.now() + 30 * 60_000).toISOString() },
        observedAt: Date.now(),
      });
      await assert.rejects(
        () => resolveLaunchRoute(config, { tier: 1, catalog: compiler, quota, model: "anthropic/claude-opus-5-5" }),
        /No eligible current catalog route/,
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
