import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelCatalogCompiler } from "../../src/catalog/compiler.js";
import { defaultStateDir, type HarnessConfig, type PiProfileConfig } from "../../src/config.js";

export function withFixtureCatalog(input: HarnessConfig): HarnessConfig {
  const profile: PiProfileConfig = {
    id: "pi:local", kind: "pi", provider: "fixture", billing: "local", models: ["fixture"],
  };
  // Never overwrite the live daemon's model-catalog.json in the default state dir.
  const stateDir = resolve(input.stateDir) === resolve(defaultStateDir())
    ? mkdtempSync(join(tmpdir(), "pi-harness-fixture-"))
    : input.stateDir;
  const config = {
    ...input,
    stateDir,
    profiles: [profile],
    defaultOrchestratorProfile: profile.id,
    defaultWorkerProfile: profile.id,
    defaultTaskProfile: profile.id,
    catalog: { ttlHours: 24 },
    quotaEndpoint: undefined,
  };
  const compiler = new ModelCatalogCompiler(config);
  const catalog = compiler.compileFromData({
    enabledProfiles: config.profiles,
    inventory: new Map([[profile.id, [{ wireModelId: "fixture" }]]]),
    profileStatuses: [{ profileId: profile.id, status: "ok", modelCount: 1 }],
    modelsDev: [], openRouter: [], litellmDep: new Map(), benchmarks: [], sources: [],
  });
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(compiler.cachePath, JSON.stringify(catalog));
  return config;
}
