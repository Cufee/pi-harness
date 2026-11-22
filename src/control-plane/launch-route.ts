import { ModelCatalogCompiler } from "../catalog/compiler.js";
import type { HarnessConfig, RunnerProfileConfig } from "../config.js";
import { isQuotaUnavailable, type QuotaClient } from "../quota/client.js";
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

  const compiler = selection.catalog ?? new ModelCatalogCompiler(config, selection.quota);
  const snapshot = await compiler.getCatalog({ cwd, excludeExhausted: model == null && !selection.quota });
  const preferred = tier <= 1 ? config.defaultOrchestratorProfile : tier === 2 ? config.defaultWorkerProfile : config.defaultTaskProfile;
  const candidates: Array<{ profile: RunnerProfileConfig; model: string; wireModel: string; unavailable: boolean }> = [];
  for (const entry of snapshot.models) {
    if (!entry.id.trim() || modelPlaceholder.test(entry.id)) continue;
    const bareId = entry.id.slice(entry.id.lastIndexOf("/") + 1);
    const allRoutes = [entry.preferredRoute, ...entry.alternateRoutes];
    const entryMatchesRequestedModel =
      model != null &&
      (model === entry.id || model === bareId || allRoutes.some((r) => r.wireModelId === model));
    for (const route of allRoutes) {
      const profile = profiles.find((p) => p.id === route.profileId);
      if (!profile || !route.wireModelId.trim() || modelPlaceholder.test(route.wireModelId)) continue;
      let canonicalId = entry.id;
      if (model != null && !entryMatchesRequestedModel) {
        // A versioned selection can use a Claude alias only when the fresh catalog contains
        // that exact revision and its profile resolver maps it to this advertised wire ID.
        if (profile.kind !== "acp" || profile.adapter !== "claude" || !claudeAlias.test(route.wireModelId)) continue;
        const requested = model.startsWith("claude-") ? `anthropic/${model}` : model;
        if (!snapshot.models.some(entry => entry.id === requested)) continue;
        const resolved = compiler.resolveForProfile(profile.id, requested);
        if (!resolved || resolved.canonicalId !== requested || resolved.wireModelId !== route.wireModelId) continue;
        canonicalId = requested;
      }
      const routeQuota = selection.quota?.resolveForModel({
        profileId: route.profileId,
        provider: route.provider,
        wireModelId: route.wireModelId,
        canonicalModelId: canonicalId,
      });
      const unavailable = routeQuota
        ? isQuotaUnavailable(routeQuota)
        : route === entry.preferredRoute && isQuotaUnavailable(entry.quota);
      if ((model == null || profileId == null) && unavailable) continue;
      candidates.push({ profile, model: canonicalId, wireModel: route.wireModelId, unavailable });
    }
  }
  const healthyCandidates = candidates.filter((c) => !c.unavailable);
  const pool = healthyCandidates.length > 0 ? healthyCandidates : candidates;
  const candidate = pool.find((route) => route.profile.id === preferred) ?? pool[0];
  if (candidate) return { profile: candidate.profile, model: candidate.model, wireModel: candidate.wireModel };
  throw new Error(`No eligible current catalog route for ${model ?? "an available model"} on ${profileId ?? "enabled profiles"} at tier ${tier}. Refresh the catalog and select an advertised model.`);
}
