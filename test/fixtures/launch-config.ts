import { mkdirSync, writeFileSync } from "node:fs";
import { ModelCatalogCompiler } from "../../src/catalog/compiler.js";
import type { HarnessConfig, PiProfileConfig } from "../../src/config.js";

export function withFixtureCatalog(input: HarnessConfig): HarnessConfig {
  const profile: PiProfileConfig = {
    id: "pi:local", kind: "pi", provider: "fixture", billing: "local", models: ["fixture"],
  };
  const config = {
    ...input,
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
