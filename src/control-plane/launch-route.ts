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
  /** True for internal automatic selections so blocked routes are skipped instead of treated as user overrides. */
  automatic?: boolean;
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
  const snapshot = await compiler.getCatalog({ cwd, excludeExhausted: false });
  const preferred = tier <= 1 ? config.defaultOrchestratorProfile : tier === 2 ? config.defaultWorkerProfile : config.defaultTaskProfile;
  const candidates: Array<{ profile: RunnerProfileConfig; model: string; wireModel: string; unavailable: boolean }> = [];
  const skipped: Array<{ profile: string; model: string; reason: "auth" | "quota"; until: string | null }> = [];
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
        const resolved = compiler.resolveForProfile(profile.id, requested, undefined, snapshot);
        if (!resolved || resolved.canonicalId !== requested || resolved.wireModelId !== route.wireModelId) continue;
        canonicalId = requested;
      }
      const routeQuota = selection.quota?.resolveForModel({
        profileId: route.profileId,
        provider: route.provider,
        wireModelId: route.wireModelId,
        canonicalModelId: canonicalId,
      });
      const effectiveQuota = routeQuota ?? route.quota ?? (route === entry.preferredRoute ? entry.quota : null);
      const unavailable = isQuotaUnavailable(effectiveQuota);
      const authBlocked = effectiveQuota?.unavailableReason === "auth";
      if (unavailable && (selection.automatic || model == null || (profileId == null && !authBlocked))) {
        skipped.push({
          profile: route.profileId,
          model: canonicalId,
          reason: authBlocked ? "auth" : "quota",
          until: effectiveQuota?.nextAvailableAt ?? null,
        });
        continue;
      }
      candidates.push({ profile, model: canonicalId, wireModel: route.wireModelId, unavailable });
    }
  }
  const healthyCandidates = candidates.filter((c) => !c.unavailable);
  const pool = healthyCandidates.length > 0 ? healthyCandidates : candidates;
  // Capability-aware routing: Tier 2/3 workspace roles need filesystem/shell tools (ACP profiles)
  // rather than bare `pi` profiles (which only expose control-plane harness tools), unless only `pi` is available.
  const capabilityPool =
    tier >= 2 && profileId == null && pool.some((c) => c.profile.kind === "acp")
      ? pool.filter((c) => c.profile.kind === "acp")
      : pool;
  const candidate = capabilityPool.find((route) => route.profile.id === preferred) ?? capabilityPool[0];
  if (candidate) return { profile: candidate.profile, model: candidate.model, wireModel: candidate.wireModel };
  const skippedDetail =
    skipped.length > 0
      ? ` Skipped: ${skipped
          .slice(0, 8)
          .map((s) =>
            s.reason === "auth"
              ? `${s.profile}/${s.model} (auth: needs login${s.until ? ` until ${s.until}` : ""})`
              : `${s.profile}/${s.model} (quota${s.until ? `: unavailable until ${s.until}` : ""})`,
          )
          .join(", ")}${skipped.length > 8 ? ` (+${skipped.length - 8} more)` : ""}.`
      : "";
  throw new Error(`No eligible current catalog route for ${model ?? "an available model"} on ${profileId ?? "enabled profiles"} at tier ${tier}. Refresh the catalog and select an advertised model.${skippedDetail}`);
}
