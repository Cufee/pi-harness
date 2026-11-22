import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import {
  ModelCatalogCompiler,
  resolveProbedModelIdentity,
} from "../src/catalog/compiler.js";
import { loadConfig, type AcpProfileConfig, type HarnessConfig, type RunnerProfileConfig } from "../src/config.js";
import { AcpRunner } from "../src/runners/acp-runner.js";

const claudeProfile: AcpProfileConfig = {
  id: "acp:claude",
  kind: "acp",
  adapter: "claude",
  command: "claude-agent-acp",
  billing: "subscription",
  enabled: true,
};

function makeCompiler(stateDir: string, profiles: RunnerProfileConfig[] = [claudeProfile]): {
  config: HarnessConfig;
  compiler: ModelCatalogCompiler;
} {
  const config: HarnessConfig = {
    ...loadConfig(stateDir),
    stateDir,
    profiles,
    defaultOrchestratorProfile: profiles[0]!.id,
    catalog: { ttlHours: 24 },
  };
  return { config, compiler: new ModelCatalogCompiler(config) };
}

describe("Claude Model Probe Identity & Downgrade Guard", () => {
  it("prefers explicit metadata (explicitModelId / description) and ANTHROPIC_DEFAULT_*_MODEL over stale display names", async () => {
    // 1. Explicit ID in `description` beats stale fallback label `Opus 4.7`
    const fromDesc = resolveProbedModelIdentity("opus", "claude", "Opus 4.7", {
      description: "Anthropic claude-opus-5-5 flagship model",
    });
    assert.equal(fromDesc?.canonicalId, "anthropic/claude-opus-5-5");
    assert.equal(fromDesc?.wireModelId, "claude-opus-5-5");
    assert.equal(fromDesc?.source, "metadata");

    // 2. Explicit ID from `models.availableModels` (`explicitModelId`) beats stale label `Opus 4.7`
    const fromExplicit = resolveProbedModelIdentity("opus", "claude", "Opus 4.7", {
      explicitModelId: "claude-opus-5-5",
    });
    assert.equal(fromExplicit?.canonicalId, "anthropic/claude-opus-5-5");
    assert.equal(fromExplicit?.wireModelId, "claude-opus-5-5");
    assert.equal(fromExplicit?.source, "metadata");

    // 3. ANTHROPIC_DEFAULT_*_MODEL acts as tiebreaker/hint when bare alias only has older built-in label
    const fromEnv = resolveProbedModelIdentity("opus", "claude", "Opus 4.7", {
      env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "anthropic/claude-opus-5-5" },
    });
    assert.equal(fromEnv?.canonicalId, "anthropic/claude-opus-5-5");
    assert.equal(fromEnv?.wireModelId, "claude-opus-5-5");
    assert.equal(fromEnv?.source, "env");

    const fableFromEnv = resolveProbedModelIdentity("fable", "claude", "Fable 4.5", {
      env: { ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-2" },
    });
    assert.equal(fableFromEnv?.canonicalId, "anthropic/claude-fable-5-2");
    assert.equal(fableFromEnv?.wireModelId, "claude-fable-5-2");

    // 4. AcpRunner.probeModels forwards description and explicit availableModels ID into ProbedModelInfo
    const fixture = agent()
      .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest("session/new", async () => ({
        sessionId: "probe-1",
        configOptions: [
          {
            type: "select" as const,
            id: "model",
            name: "Model",
            category: "model",
            currentValue: "opus",
            options: [
              { value: "opus", name: "Opus 4.7", description: "Uses claude-opus-5-5" },
              { value: "sonnet", name: "Sonnet 4.7" },
            ],
          },
        ],
        models: {
          currentModelId: "opus",
          availableModels: [
            { modelId: "claude-sonnet-5-5", name: "Sonnet 5.5" },
          ],
        },
      }));

    const probed = await new AcpRunner(claudeProfile).probeModels(process.cwd(), 5_000, fixture);
    const opusInfo = probed.find((p) => p.wireModelId === "opus");
    const sonnetInfo = probed.find((p) => p.wireModelId === "sonnet");
    assert.equal(opusInfo?.description, "Uses claude-opus-5-5");
    assert.equal(sonnetInfo?.explicitModelId, "claude-sonnet-5-5");

    const resolvedOpus = resolveProbedModelIdentity(opusInfo!.wireModelId, "claude", opusInfo!.name, {
      description: opusInfo!.description,
      explicitModelId: opusInfo!.explicitModelId,
    });
    const resolvedSonnet = resolveProbedModelIdentity(sonnetInfo!.wireModelId, "claude", sonnetInfo!.name, {
      description: sonnetInfo!.description,
      explicitModelId: sonnetInfo!.explicitModelId,
    });
    assert.equal(resolvedOpus?.canonicalId, "anthropic/claude-opus-5-5");
    assert.equal(resolvedSonnet?.canonicalId, "anthropic/claude-sonnet-5-5");
  });

  it("prevents a fallback bare-alias probe (Opus 4.7) from downgrading a verified cached anthropic/claude-opus-5-5 entry and records probeWarning", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-downgrade-guard-"));
    try {
      const { compiler } = makeCompiler(stateDir);

      // Step 1: Verified initial catalog with Opus 5.5 + Haiku 5.5
      const verifiedCatalog = compiler.compileFromData({
        enabledProfiles: [claudeProfile],
        inventory: new Map([
          [
            "acp:claude",
            [
              { wireModelId: "opus", name: "Opus 5.5", supportedEfforts: ["low", "medium", "high", "max"] },
              { wireModelId: "haiku", name: "Haiku 5.5" },
            ],
          ],
        ]),
        profileStatuses: [{ profileId: "acp:claude", status: "ok", modelCount: 2 }],
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [],
        sources: [],
      });
      writeFileSync(compiler.cachePath, JSON.stringify(verifiedCatalog), "utf8");
      assert.ok(verifiedCatalog.models.some((m) => m.id === "anthropic/claude-opus-5-5"));
      assert.equal(verifiedCatalog.profileStatuses?.[0]?.probeWarning, undefined);

      // Step 2: Subsequent probe runs in a shell lacking ANTHROPIC_DEFAULT_*_MODEL -> fallback labels "Opus 4.7" / "Haiku 4.5"
      const guardedCatalog = compiler.compileFromData({
        enabledProfiles: [claudeProfile],
        inventory: new Map([
          [
            "acp:claude",
            [
              { wireModelId: "opus", name: "Opus 4.7", supportedEfforts: ["low", "medium", "high", "max"] },
              { wireModelId: "haiku", name: "Haiku 4.5" },
            ],
          ],
        ]),
        profileStatuses: [{ profileId: "acp:claude", status: "ok", modelCount: 2 }],
        previousCatalog: verifiedCatalog,
        env: {},
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [],
        sources: [],
      });

      const ids = guardedCatalog.models.map((m) => m.id).sort();
      assert.deepEqual(ids, ["anthropic/claude-haiku-5-5", "anthropic/claude-opus-5-5"]);
      const opus = guardedCatalog.models.find((m) => m.id === "anthropic/claude-opus-5-5")!;
      assert.equal(opus.preferredRoute.wireModelId, "claude-opus-5-5");

      const status = guardedCatalog.profileStatuses?.find((s) => s.profileId === "acp:claude");
      assert.ok(status?.probeWarning, "Expected probeWarning on downgraded bare-alias probe");
      assert.ok(status!.probeWarning!.includes("anthropic/claude-opus-5-5"));
      assert.ok(status!.probeWarning!.includes("Opus 4.7"));

      // Step 3: A catalog carrying a probeWarning uses short retry TTL instead of sticking for 24h
      const agedWarningCatalog = {
        ...guardedCatalog,
        syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(), // 5 minutes old (< 24h, > 2m retry TTL)
      };
      assert.equal(compiler.isCacheFresh(agedWarningCatalog), false);
      const agedHealthyCatalog = {
        ...verifiedCatalog,
        syncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      };
      assert.equal(compiler.isCacheFresh(agedHealthyCatalog), true);

      // Step 4: An explicit versioned wire ID (NOT a bare family alias) IS respected without warning
      const explicitWireCatalog = compiler.compileFromData({
        enabledProfiles: [claudeProfile],
        inventory: new Map([
          ["acp:claude", [{ wireModelId: "claude-opus-4-7", name: "Opus 4.7" }]],
        ]),
        profileStatuses: [{ profileId: "acp:claude", status: "ok", modelCount: 1 }],
        previousCatalog: verifiedCatalog,
        env: {},
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [],
        sources: [],
      });
      assert.deepEqual(explicitWireCatalog.models.map((m) => m.id), ["anthropic/claude-opus-4-7"]);
      assert.equal(explicitWireCatalog.profileStatuses?.[0]?.probeWarning, undefined);

      // Step 5: An explicit ANTHROPIC_DEFAULT_OPUS_MODEL env override IS respected without warning
      const explicitEnvCatalog = compiler.compileFromData({
        enabledProfiles: [claudeProfile],
        inventory: new Map([
          ["acp:claude", [{ wireModelId: "opus", name: "Opus 4.7" }]],
        ]),
        profileStatuses: [{ profileId: "acp:claude", status: "ok", modelCount: 1 }],
        previousCatalog: verifiedCatalog,
        env: { ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-4-7" },
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [],
        sources: [],
      });
      assert.deepEqual(explicitEnvCatalog.models.map((m) => m.id), ["anthropic/claude-opus-4-7"]);
      assert.equal(explicitEnvCatalog.profileStatuses?.[0]?.probeWarning, undefined);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
