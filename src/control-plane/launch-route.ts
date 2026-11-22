import { ModelCatalogCompiler } from "../catalog/compiler.js";
import type { HarnessConfig, RunnerProfileConfig } from "../config.js";
import type { QuotaClient } from "../quota/client.js";
import type { AgentTier } from "./db.js";

const modelPlaceholder = /(?:^|\/)(?:auto|default)$/i;
const claudeAlias = /^(?:opus|sonnet|haiku|fable)$/;

interface LaunchSelection {
  tier: 0 | AgentTier;
  catalog?: ModelCatalogCompiler;
  quota?: QuotaClient;
  cwd?: string;
  profileId?: string | null;
  model?: string | null;
}

export async function resolveLaunchRoute(config: HarnessConfig, selection: LaunchSelection): Promise<{
  profile: RunnerProfileConfig;
  model: string;
  wireModel: string;
}> {
  const { tier, profileId, model, cwd } = selection;
  const profiles = config.profiles.filter((profile) =>
    profile.enabled !== false && (profileId == null || profile.id === profileId));
  if (profiles.length === 0) {
    if (profileId != null) throw new Error(`Unknown or disabled runner profile "${profileId}". Select an enabled profile.`);
    throw new Error("No runner profiles are enabled.");
  }
  if (model != null && !model.trim()) throw new Error("Select a nonblank catalog model.");

  const compiler = selection.catalog ?? new ModelCatalogCompiler(config);
  const snapshot = await compiler.getCatalog({ cwd, excludeExhausted: model == null && !selection.quota });
  const preferred = tier <= 1 ? config.defaultOrchestratorProfile : tier === 2 ? config.defaultWorkerProfile : config.defaultTaskProfile;
  const candidates = [];
  for (const entry of snapshot.models) {
    if (!entry.id.trim() || modelPlaceholder.test(entry.id)) continue;
    const bareId = entry.id.slice(entry.id.lastIndexOf("/") + 1);
    for (const route of [entry.preferredRoute, ...entry.alternateRoutes]) {
      const profile = profiles.find((p) => p.id === route.profileId);
      if (!profile || !route.wireModelId.trim() || modelPlaceholder.test(route.wireModelId)) continue;
      let canonicalId = entry.id;
      if (model != null && model !== entry.id && model !== route.wireModelId && model !== bareId) {
        // A versioned selection can use a Claude alias only when the fresh catalog contains
        // that exact revision and its profile resolver maps it to this advertised wire ID.
        if (profile.kind !== "acp" || profile.adapter !== "claude" || !claudeAlias.test(route.wireModelId)) continue;
        const requested = model.startsWith("claude-") ? `anthropic/${model}` : model;
        if (!snapshot.models.some(entry => entry.id === requested)) continue;
        const resolved = compiler.resolveForProfile(profile.id, requested);
        if (!resolved || resolved.canonicalId !== requested || resolved.wireModelId !== route.wireModelId) continue;
        canonicalId = requested;
      }
      if ((model == null || profileId == null) && selection.quota?.resolveForModel({ ...route, canonicalModelId: canonicalId })?.exhausted) continue;
      candidates.push({ profile, model: canonicalId, wireModel: route.wireModelId });
    }
  }
  const candidate = candidates.find((route) => route.profile.id === preferred) ?? candidates[0];
  if (candidate) return candidate;
  throw new Error(`No eligible current catalog route for ${model ?? "an available model"} on ${profileId ?? "enabled profiles"} at tier ${tier}. Refresh the catalog and select an advertised model.`);
}
