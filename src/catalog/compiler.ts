import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CatalogConfig, HarnessConfig, RunnerProfileConfig } from "../config.js";
import { isQuotaUnavailable, type QuotaClient } from "../quota/client.js";
import type { ResolvedModelQuota } from "../quota/schema.js";
import { AcpRunner } from "../runners/acp-runner.js";
import { PiRunner } from "../runners/pi-runner.js";
import type { ProbedModelInfo } from "../runners/types.js";
import {
  computeRefinedFamilyKey,
  selectLatestPerFamily,
  type CandidateModel,
  type ModelRoute,
} from "./deduplicate.js";
import { canonicalModelId } from "./lifecycle.js";
import {
  RANKING_COHORT,
  type BenchmarkEvidence,
  fetchLiteLlmDeprecations,
  fetchModelsDev,
  fetchOpenRouterMetadata,
  fetchValsAiBenchmarks,
  type BenchmarkMetricRow,
  type BenchmarkSourceName,
} from "./sources.js";

export interface CompiledModelEntry {
  id: string;
  family: string;
  name: string;
  codingRank: number | null;
  codingScore: number | null;
  scoreSource: BenchmarkSourceName | null;
  scoreObservation?: { model: string; effort: string };
  benchmarks: Partial<Record<BenchmarkSourceName, number>>;
  contextK: number | null;
  efforts: string[];
  preferredRoute: ModelRoute;
  alternateRoutes: ModelRoute[];
  /** Marginal USD per task ($0 for subscription/local) */
  costPerTaskUsd: number | null;
  /** Equivalent API USD per task so agents still respect scarce frontier subscription quotas */
  apiEquivCostUsd: number | null;
  timePerTaskSeconds: number | null;
  quota?: ResolvedModelQuota | null;
  recommendedFor: string[];
  /** Whether this model is enabled in the user's configured model list (default true). */
  enabled?: boolean;
}

/** Evaluates whether a canonical model ID is enabled under the user's `config.catalog` filter. */
export function isModelEnabledInCatalog(modelId: string, catalogCfg?: Partial<CatalogConfig>): boolean {
  const mode = catalogCfg?.modelFilterMode ?? "all";
  const norm = modelId.toLowerCase();
  if (mode === "allowlist") {
    return (catalogCfg?.enabledModels ?? []).some((id) => id.toLowerCase() === norm);
  }
  return !(catalogCfg?.disabledModels ?? []).some((id) => id.toLowerCase() === norm);
}

export interface TaskModelRecommendation {
  model: string;
  profile: string;
  effort?: string;
  rationale: string;
}

function pickEffort(supported: string[], preferred: string[]): string | undefined {
  const real = supported.filter((e) => e.trim() && e.toLowerCase() !== "default");
  if (real.length === 0) return undefined;
  const lowerMap = new Map(real.map((e) => [e.toLowerCase(), e]));
  for (const want of preferred) {
    const hit = lowerMap.get(want);
    if (hit) return hit;
  }
  return real[0];
}

/**
 * Computes concrete task-kind-aware model + effort recommendations from the user's currently enabled
 * catalog so Orchestrators & Workers stop spawning every task on the exact same model as Director.
 */
export function recommendModelsByTaskKind(
  models: CompiledModelEntry[],
  opts?: { avoidModelId?: string | null },
): Record<"orchestrator" | "worker" | "research" | "plan" | "execute" | "verify", TaskModelRecommendation | null> {
  const pool = models.filter((m) => m.enabled !== false && !isQuotaUnavailable(m.quota));
  const byRank = [...pool].sort((a, b) => (b.codingScore ?? -1) - (a.codingScore ?? -1) || a.id.localeCompare(b.id));

  const pickByRoles = (
    roles: string[],
    preferredEfforts: string[],
    rationale: string,
    preferDifferentFrom?: string | null,
    preferFastest = false,
  ): TaskModelRecommendation | null => {
    if (byRank.length === 0) return null;
    let candidates = byRank.filter((m) => roles.some((r) => m.recommendedFor.includes(r)));
    if (candidates.length === 0) candidates = byRank;
    if (preferDifferentFrom) {
      const normAvoid = preferDifferentFrom.toLowerCase();
      const diff = candidates.filter(
        (m) => m.id.toLowerCase() !== normAvoid && m.preferredRoute.wireModelId.toLowerCase() !== normAvoid,
      );
      if (diff.length > 0) candidates = diff;
    }
    const chosen = preferFastest
      ? [...candidates].sort(
          (a, b) =>
            (a.timePerTaskSeconds ?? Number.POSITIVE_INFINITY) - (b.timePerTaskSeconds ?? Number.POSITIVE_INFINITY) ||
            (a.apiEquivCostUsd ?? Number.POSITIVE_INFINITY) - (b.apiEquivCostUsd ?? Number.POSITIVE_INFINITY) ||
            (b.codingScore ?? -1) - (a.codingScore ?? -1),
        )[0]!
      : candidates[0]!;
    const effort = pickEffort(chosen.preferredRoute.supportedEfforts ?? chosen.efforts, preferredEfforts);
    return {
      model: chosen.id,
      profile: chosen.preferredRoute.profileId,
      ...(effort !== undefined ? { effort } : {}),
      rationale,
    };
  };

  return {
    orchestrator: pickByRoles(
      ["orchestrator", "complex_architecture"],
      ["high", "medium", "xhigh"],
      "Top frontier reasoning model for planning & architecture",
    ),
    worker: pickByRoles(
      ["worker_execution", "refactoring", "general_coding"],
      ["high", "medium"],
      "Balanced coding workhorse for vertical implementation slices",
    ),
    research: pickByRoles(
      ["codebase_research", "fast_scout", "log_triage"],
      ["low", "minimal", "medium"],
      "Fast, low-cost scout for read-only codebase exploration",
      null,
      true,
    ),
    plan: pickByRoles(
      ["complex_architecture", "plan_synthesis", "orchestrator"],
      ["high", "medium"],
      "Strong architectural model for design synthesis",
    ),
    execute: pickByRoles(
      ["worker_execution", "refactoring", "general_coding"],
      ["medium", "high"],
      "Fast coding workhorse for bounded implementation sub-steps",
    ),
    verify: pickByRoles(
      ["independent_verifier", "hard_debugging", "verification"],
      ["high", "xhigh", "medium"],
      "Independent skeptical verifier (prefers a different model than generator)",
      opts?.avoidModelId ?? null,
    ),
  };
}

export const CATALOG_SCHEMA_VERSION = 5;

export interface ProfileProbeStatus {
  profileId: string;
  status: "ok" | "error";
  modelCount: number;
  error?: string;
}

export interface CompiledModelCatalog {
  schemaVersion?: number;
  profilesFingerprint?: string;
  syncedAt: string;
  sources: string[];
  rankingEvidence?: BenchmarkEvidence;
  /** True when the benchmark evidence `asOf` date is older than 30 days (scores are still retained). */
  rankingEvidenceStale?: boolean;
  nextLifecycleChangeAt?: string;
  profileStatuses?: ProfileProbeStatus[];
  /** Optional per-session model selection context set by the discovery/director agent (empty/null by default). */
  sessionModelContext?: string | null;
  models: CompiledModelEntry[];
}

// Defaults for the native Claude CLI, verified 2026-11-21.
// https://code.claude.com/docs/en/model-config#model-aliases
const CLAUDE_ROUTE_ALIASES = new Map([
  ["anthropic/claude-opus-5-5", "opus"],
  ["anthropic/claude-sonnet-5-5", "sonnet"],
  ["anthropic/claude-haiku-5-5", "haiku"],
  ["anthropic/claude-fable-5-2", "fable"],
]);

const EVIDENCE_STALE_AGE_MS = 30 * 86_400_000;
const BROKEN_CATALOG_RETRY_TTL_MS = 2 * 60_000;

function isEvidenceStale(evidence: BenchmarkEvidence | undefined, now: number): boolean {
  if (!evidence) return false;
  const date = Date.parse(evidence.asOf);
  return Number.isFinite(date) && now - date >= EVIDENCE_STALE_AGE_MS;
}

function currentEvidence(evidence: BenchmarkEvidence | undefined, now: number): evidence is BenchmarkEvidence {
  if (!evidence || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.asOf)) return false;
  const date = Date.parse(evidence.asOf);
  if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== evidence.asOf) return false;
  const age = now - date;
  const { source: _source, ...cohort } = RANKING_COHORT;
  return age >= 0 &&
    /^https:\/\/www\.vals\.ai\/_astro\/benchmark_view_terminal_bench_4\.[a-zA-Z0-9_-]+\.json$/.test(evidence.revision) &&
    Object.entries(cohort).every(([key, value]) => evidence[key as keyof BenchmarkEvidence] === value);
}

/** Vals publishes one aggregate per model. Ambiguous identities and conflicting reruns have no score. */
function selectMeasurements(rows: BenchmarkMetricRow[], now: number) {
  const cohortRows = rows.filter((row) => row.source === RANKING_COHORT.source && row.evidence);
  const snapshotDates = new Map<string, string>();
  for (const { evidence } of cohortRows) {
    const { revision, asOf } = evidence!;
    const previous = snapshotDates.get(revision);
    snapshotDates.set(revision, previous === undefined || previous === asOf ? asOf : "");
  }
  const eligible = cohortRows.filter(({ evidence }) => currentEvidence(evidence, now) &&
    snapshotDates.get(evidence.revision) === evidence.asOf);
  const latestDate = eligible.reduce((date, row) => row.evidence!.asOf > date ? row.evidence!.asOf : date, "");
  const latest = eligible.filter((row) => row.evidence!.asOf === latestDate);
  const measurements = new Map<string, BenchmarkMetricRow>();
  const evidence = latest[0]?.evidence;
  if (!evidence || latest.some((row) => row.evidence!.revision !== evidence.revision)) return { measurements };

  const identities = new Map<string, string>();
  const conflicts = new Set<string>();
  for (const row of latest) {
    const id = row.canonicalKeyHint;
    if (!id || !row.rawModelName) continue;
    const priorId = identities.get(row.rawModelName);
    const prior = measurements.get(id);
    if (priorId && priorId !== id) {
      conflicts.add(priorId);
      conflicts.add(id);
    }
    identities.set(row.rawModelName, id);
    if (!row.effort?.trim() || typeof row.codingScore !== "number" || !Number.isFinite(row.codingScore) ||
        row.codingScore < 0 || row.codingScore > 100 ||
        (prior && (prior.rawModelName !== row.rawModelName || prior.codingScore !== row.codingScore || prior.effort !== row.effort))) {
      conflicts.add(id);
    }
    measurements.set(id, row);
  }
  for (const conflict of conflicts) measurements.delete(conflict);
  return { evidence, measurements };
}

/** Fuzzy keys for translating explicit route requests. Ranking uses exact canonical IDs. */
export function buildMatchKeys(raw: string): string[] {
  const cleaned = raw
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(adaptive|reasoning|thinking|non-reasoning|default|fallback|preview|latest|max|xhigh|high|medium|low|minimal|fast)\b/g, " ")
    .replace(/(\d+)\.(\d+)/g, "$1-$2") // unify 5.5 <-> 5-5 and 6.2 <-> 6-2
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "");

  if (!cleaned) return [];
  const keys = new Set<string>();
  const flat = cleaned.replace(/\//g, "-").replace(/-+/g, "-");
  keys.add(flat);

  const bare = cleaned.includes("/") ? cleaned.slice(cleaned.lastIndexOf("/") + 1) : cleaned;
  if (bare) {
    keys.add(bare);
    // Strip leading vendor/product family prefix (`claude-opus-5-5` -> `opus-5-5`, `gemini-4-neon` -> `4-neon`)
    const noBrand = bare.replace(/^(claude|openai|anthropic|google|deepseek|kimi|qwen|meta|xai|zai)-/, "");
    if (noBrand && noBrand.length >= 4 && /[a-z]/.test(noBrand)) {
      keys.add(noBrand);
    }
    // Also strip trailing snapshot dates
    const noSnap = bare.replace(/-(20\d{2}-?\d{2}-?\d{2}|20\d{6})$/, "");
    if (noSnap && noSnap !== bare) keys.add(noSnap);
  }

  return [...keys];
}

function inferRoles(entry: {
  family: string;
  codingScore: number | null;
  apiEquivCostUsd: number | null;
  topCodingScore?: number | null;
}): string[] {
  const f = entry.family.toLowerCase();
  if (f.includes("opus") || f.includes("fable") || f.includes("pro") || f.includes("astra") || f.includes("neon")) {
    return ["orchestrator", "complex_architecture", "hard_debugging", "independent_verifier"];
  }
  if (f.includes("codex") || f.includes("sonnet") || f.includes("sol") || f.includes("carbon")) {
    return ["worker_execution", "refactoring", "plan_synthesis", "verification"];
  }
  if (f.includes("flash") || f.includes("mini") || f.includes("haiku") || f.includes("nano") || f.includes("lite") || f.includes("argon")) {
    return ["codebase_research", "log_triage", "fast_scout"];
  }
  const score = entry.codingScore;
  const top = entry.topCodingScore ?? null;
  const isHighScoringFrontier =
    score !== null &&
    (score >= 60 || (top !== null && top >= 40 && score >= top - 5));
  if (isHighScoringFrontier) {
    const roles = ["orchestrator", "complex_architecture", "hard_debugging", "independent_verifier", "worker_execution"];
    if (entry.apiEquivCostUsd !== null && entry.apiEquivCostUsd < 0.15) {
      roles.push("codebase_research", "fast_scout");
    }
    return roles;
  }
  if ((entry.apiEquivCostUsd ?? 1) < 0.15) return ["codebase_research", "fast_scout"];
  if (score !== null && score >= 45) {
    return ["worker_execution", "refactoring", "plan_synthesis", "verification"];
  }
  return ["worker_execution", "general_coding"];
}

function estimateApiTaskCostUsd(cost?: { input: number; output: number; cacheRead?: number }): number | null {
  if (!cost || (cost.input === 0 && cost.output === 0)) return null;
  const cacheRate = cost.cacheRead ?? cost.input * 0.1;
  const usd = (12_000 * cost.input + 68_000 * cacheRate + 4_000 * cost.output) / 1_000_000;
  return Number(usd.toFixed(4));
}

export class ModelCatalogCompiler {
  constructor(
    private readonly config: HarnessConfig,
    private readonly quotaClient?: QuotaClient,
  ) {}

  get cachePath(): string {
    return join(this.config.stateDir, "model-catalog.json");
  }

  computeProfilesFingerprint(): string {
    const profiles = this.config.profiles
      .filter((p) => p.enabled !== false)
      .map((p) => p.kind === "acp"
        ? [p.id, p.kind, p.adapter, p.command, p.args, p.models, p.billing, Object.entries(p.env ?? {}).sort()]
        : [p.id, p.kind, p.provider, p.models, p.billing, p.baseUrl, p.api]);
    const content = JSON.stringify([profiles, this.config.catalog.allowPreview, this.config.catalog.preferSubscription,
      this.config.defaultOrchestratorProfile]);
    return createHash("sha256").update(content).digest("hex");
  }

  invalidateCache(): void {
    try {
      if (existsSync(this.cachePath)) {
        writeFileSync(this.cachePath, "{}", "utf8");
      }
    } catch {
      // ignore cache invalidation errors
    }
  }

  loadCached(): CompiledModelCatalog | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.cachePath, "utf8")) as CompiledModelCatalog;
      return parsed && Array.isArray(parsed.models) ? parsed : null;
    } catch {
      return null;
    }
  }

  isCacheFresh(catalog: CompiledModelCatalog | null): boolean {
    if (!catalog) return false;
    if (catalog.schemaVersion !== CATALOG_SCHEMA_VERSION) return false;
    if (catalog.profilesFingerprint !== this.computeProfilesFingerprint()) return false;
    const now = Date.now();
    if (catalog.nextLifecycleChangeAt !== undefined && !(Date.parse(catalog.nextLifecycleChangeAt) > now)) return false;
    const syncedAt = Date.parse(catalog.syncedAt);
    if (!Number.isFinite(syncedAt) || new Date(syncedAt).toISOString() !== catalog.syncedAt) return false;
    if (catalog.models.some((model) => model.codingScore !== null || model.codingRank !== null) &&
        !currentEvidence(catalog.rankingEvidence, now)) return false;
    const ageMs = now - syncedAt;
    if (ageMs < 0) return false;
    const enabledProfileIds = new Set(
      this.config.profiles.filter((p) => p.enabled !== false).map((p) => p.id),
    );
    const hasProbeError = Boolean(
      catalog.profileStatuses?.some(
        (s) => s.status === "error" && enabledProfileIds.has(s.profileId),
      ),
    );
    const normalTtlMs = this.config.catalog.ttlHours * 3_600_000;
    const ttlMs =
      catalog.models.length === 0 || hasProbeError
        ? Math.min(BROKEN_CATALOG_RETRY_TTL_MS, normalTtlMs)
        : normalTtlMs;
    return ageMs < ttlMs;
  }

  /**
   * Translates a canonical (`google/gemini-4-carbon`), bare (`gemini-4-carbon`), or wire
   * (`google-vertex/gemini-4-carbon`) model ID into the exact wire ID that `profileId` probed,
   * using the cached catalog. Returns null when there is no catalog or no route on that profile
   * matches; callers then pass the original string through unchanged.
   */
  resolveForProfile(
    profileId: string,
    model: string,
    effort?: string,
  ): { wireModelId: string; canonicalId: string; effort?: string } | null {
    const catalog = this.loadCached();
    if (!catalog || !model) return null;

    const candidates = catalog.models.flatMap((entry) =>
      [entry.preferredRoute, ...entry.alternateRoutes]
        .filter((route) => route?.profileId === profileId)
        .map((route) => ({ entry, route })),
    );
    if (candidates.length === 0) return null;

    const lower = model.toLowerCase();
    const requestKeys = new Set(buildMatchKeys(model));
    const claudeAlias = CLAUDE_ROUTE_ALIASES.get(lower);
    const aliasRoute = candidates.find(({ route }) => route.runner === "acp" && route.provider === "claude" &&
      route.wireModelId === claudeAlias);
    const pick =
      candidates.find((c) => c.route.wireModelId.toLowerCase() === lower) ??
      candidates.find((c) => c.entry.id.toLowerCase() === lower) ??
      aliasRoute ??
      candidates
        .map((c) => {
          const keys = new Set([...buildMatchKeys(c.entry.id), ...buildMatchKeys(c.route.wireModelId)]);
          return { c, score: [...requestKeys].filter((k) => keys.has(k)).length };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.c;
    if (!pick) return null;

    const efforts = pick.route.supportedEfforts;
    const validEffort = effort && effort.toLowerCase() !== "default" ? effort : undefined;
    return {
      wireModelId: pick.route.wireModelId,
      canonicalId: pick === aliasRoute ? lower : pick.entry.id,
      ...(validEffort && (!efforts?.length || efforts.includes(validEffort)) ? { effort: validEffort } : {}),
    };
  }

  async getCatalog(opts?: {
    forceSync?: boolean;
    cwd?: string;
    role?: string;
    maxApiEquivUsd?: number;
    excludeExhausted?: boolean;
    includeDisabled?: boolean;
  }): Promise<CompiledModelCatalog> {
    const cached = this.loadCached();
    const catalog: CompiledModelCatalog =
      opts?.forceSync || !cached || !this.isCacheFresh(cached)
        ? await this.sync(opts?.cwd ?? process.cwd())
        : cached;

    this.quotaClient?.harvestLocal(this.config.profiles);
    await this.quotaClient?.sync(false).catch(() => {});
    const enrichedModels = catalog.models
      .map((m) => {
        const allRoutes = [m.preferredRoute, ...m.alternateRoutes];
        const resolvedRoutes = allRoutes.map((route) => ({
          route,
          quota:
            this.quotaClient?.resolveForModel({
              profileId: route.profileId,
              provider: route.provider,
              wireModelId: route.wireModelId,
              canonicalModelId: m.id,
            }) ?? null,
        }));

        let chosenIndex = 0;
        if (isQuotaUnavailable(resolvedRoutes[0]?.quota)) {
          const healthyIdx = resolvedRoutes.findIndex(
            (r, idx) => idx > 0 && !isQuotaUnavailable(r.quota),
          );
          if (healthyIdx > 0) {
            chosenIndex = healthyIdx;
          }
        }

        const chosen = resolvedRoutes[chosenIndex]!;
        const preferredRoute = chosen.route;
        const alternateRoutes = resolvedRoutes
          .filter((_, idx) => idx !== chosenIndex)
          .map((r) => r.route);
        const costPerTaskUsd =
          chosenIndex === 0
            ? m.costPerTaskUsd
            : preferredRoute.billing === "subscription" || preferredRoute.billing === "local"
              ? 0
              : m.apiEquivCostUsd;
        const promotedEfforts = preferredRoute.supportedEfforts?.filter(
          (e) => e.trim() && e.toLowerCase() !== "default",
        );
        const efforts =
          chosenIndex === 0
            ? m.efforts
            : promotedEfforts?.length
              ? promotedEfforts
              : m.efforts;

        const enabled = isModelEnabledInCatalog(m.id, this.config.catalog);
        const quota = chosen.quota ?? (chosenIndex === 0 ? (m.quota ?? null) : null);
        return {
          ...m,
          preferredRoute,
          alternateRoutes,
          costPerTaskUsd,
          efforts,
          quota,
          enabled,
        };
      })
      .filter((m) => {
        if (!opts?.includeDisabled && m.enabled === false) return false;
        if (opts?.excludeExhausted && isQuotaUnavailable(m.quota)) return false;
        if (opts?.role && !m.recommendedFor.includes(opts.role)) return false;
        if (opts?.maxApiEquivUsd !== undefined && m.apiEquivCostUsd !== null && m.apiEquivCostUsd > opts.maxApiEquivUsd) {
          return false;
        }
        return true;
      });

    return { ...catalog, models: enrichedModels };
  }

  async sync(cwd: string, injectedInventory?: Map<string, ProbedModelInfo[]>): Promise<CompiledModelCatalog> {
    const enabledProfiles = this.config.profiles.filter((p) => p.enabled !== false);
    const discovered = injectedInventory
      ? {
          inventory: injectedInventory,
          statuses: enabledProfiles.map((p) => ({
            profileId: p.id,
            status: "ok" as const,
            modelCount: injectedInventory.get(p.id)?.length ?? 0,
          })),
        }
      : await this.discoverEnabledInventory(enabledProfiles, cwd);

    const [modelsDev, openRouter, litellmDep, benchmarks] = await Promise.all([
      fetchModelsDev(), fetchOpenRouterMetadata(), fetchLiteLlmDeprecations(), fetchValsAiBenchmarks(),
    ]);

    const sources: string[] = [];
    if (modelsDev.length) sources.push("models.dev");
    if (openRouter.length) sources.push("openrouter");
    if (litellmDep.size) sources.push("litellm");
    if (benchmarks.length) sources.push("vals_ai");

    const catalog = this.compileFromData({
      enabledProfiles,
      inventory: discovered.inventory,
      profileStatuses: discovered.statuses,
      modelsDev,
      openRouter,
      litellmDep,
      benchmarks,
      sources,
    });

    mkdirSync(dirname(this.cachePath), { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(catalog, null, 2), "utf8");
    return catalog;
  }

  compileFromData(input: {
    enabledProfiles: RunnerProfileConfig[];
    inventory: Map<string, ProbedModelInfo[]>;
    profileStatuses?: ProfileProbeStatus[];
    modelsDev: Awaited<ReturnType<typeof fetchModelsDev>>;
    openRouter: Awaited<ReturnType<typeof fetchOpenRouterMetadata>>;
    litellmDep: Awaited<ReturnType<typeof fetchLiteLlmDeprecations>>;
    benchmarks: BenchmarkMetricRow[];
    sources: string[];
  }): CompiledModelCatalog {
    const now = Date.now();
    const { evidence, measurements } = selectMeasurements(input.benchmarks, now);
    let nextLifecycleChange = Infinity;
    const reached = (date: string | undefined): boolean => {
      if (!date) return false;
      const at = Date.parse(date);
      if (at > now) nextLifecycleChange = Math.min(nextLifecycleChange, at);
      return at <= now;
    };
    const canonicalMetadata = new Map<string, (typeof input.modelsDev)[number]>();
    const routeMetadata = new Map<string, (typeof input.modelsDev)[number]>();
    for (const md of input.modelsDev) {
      if (md.isCanonical !== false) {
        canonicalMetadata.set(canonicalModelId(md.canonicalId ?? `${md.provider}/${md.id}`, md.provider), md);
      }
      if (!md.isCanonical) routeMetadata.set(`${md.provider}/${md.id}`, md);
    }
    const orById = new Map(input.openRouter.map((row) => [row.id, row]));
    const candidateMap = new Map<string, CandidateModel>();
    for (const profile of input.enabledProfiles) {
      const models = input.inventory.get(profile.id) ?? [];
      const providerName = profile.kind === "pi" ? profile.provider : profile.adapter;
      for (const m of models) {
        const routeMd = routeMetadata.get(`${providerName}/${m.wireModelId}`);
        const inventoryId = canonicalModelId(m.wireModelId, providerName);
        const linkedId = routeMd?.canonicalId ? canonicalModelId(routeMd.canonicalId, providerName) : undefined;
        // Some provider listings link dated or preview routes to an undated product page.
        // An exact provider route may identify its publisher only if its model ID is unchanged.
        const canonicalId = linkedId &&
          inventoryId.slice(inventoryId.indexOf("/") + 1) === linkedId.slice(linkedId.indexOf("/") + 1)
          ? linkedId : inventoryId;
        const slash = canonicalId.indexOf("/");
        const creator = canonicalId.slice(0, slash);
        const bare = canonicalId.slice(slash + 1);
        const md = canonicalMetadata.get(canonicalId);
        const or = providerName === "openrouter" ? orById.get(m.wireModelId) : orById.get(canonicalId);
        const dep = input.litellmDep.get(canonicalId.toLowerCase()) ??
          (canonicalModelId(bare, "generic") === canonicalId ? input.litellmDep.get(bare.toLowerCase()) : undefined);
        if (routeMd?.status === "deprecated" || routeMd?.status === "retired" || routeMd?.toolCall === false ||
            (routeMd?.modalities?.output && !routeMd.modalities.output.includes("text"))) continue;
        if (providerName === "openrouter" && reached(or?.expirationDate)) continue;

        const primaryBench = measurements.get(canonicalId);
        // Undated task measurements can supply cost/time on exact native IDs, never quality.
        const taskMetrics = primaryBench ?? input.benchmarks.find((row) => row.source === "harbor_tb4" &&
          (row.canonicalKeyHint === canonicalId || (!row.canonicalKeyHint && row.rawModelName === bare &&
            canonicalModelId(bare, "generic") === canonicalId)));

        const route: ModelRoute = {
          profileId: profile.id,
          runner: profile.kind,
          provider: providerName,
          wireModelId: m.wireModelId, // keep original wire ID so ACP/Pi accepts it verbatim
          billing: profile.billing,
          supportedEfforts: m.supportedEfforts ?? routeMd?.supportedEfforts ?? md?.supportedEfforts ?? or?.supportedEfforts,
        };

        const existing = candidateMap.get(canonicalId);
        if (existing) {
          existing.routes.push(route);
        } else {
          const isDeprecated =
            md?.status === "deprecated" || md?.status === "retired" ||
            reached(dep?.deprecationDate);
          candidateMap.set(canonicalId, {
            canonicalId,
            creator,
            wireModelId: bare,
            name: md?.name ?? m.name ?? bare,
            rawFamily: md?.family,
            releaseDate: md?.releaseDate,
            deprecated: isDeprecated,
            successorModel: dep?.deprecationDate && !isDeprecated ? undefined : dep?.successorModel,
            toolCall: md?.toolCall ?? true,
            modalities: md?.modalities,
            contextWindow: md?.contextWindow ?? or?.contextLength,
            supportedEfforts: route.supportedEfforts,
            listCostPer1m:
              routeMd?.cost ?? md?.cost ??
              (or?.costPer1mInput !== undefined
                ? { input: or.costPer1mInput, output: or.costPer1mOutput ?? 0 }
                : undefined),
            codingScore: primaryBench?.codingScore,
            costPerTaskUsd: taskMetrics?.costPerTaskUsd,
            timePerTaskSeconds: taskMetrics?.timePerTaskSeconds,
            routes: [route],
          });
        }
      }
    }

    const winners = selectLatestPerFamily([...candidateMap.values()], {
      allowPreview: this.config.catalog.allowPreview ?? true,
    });

    const scoredValues = winners
      .map((w) => w.codingScore)
      .filter((s): s is number => typeof s === "number" && Number.isFinite(s));
    const topCodingScore = scoredValues.length > 0 ? Math.max(...scoredValues) : null;

    const preferSub = this.config.catalog.preferSubscription ?? true;
    const defaultProfile = this.config.defaultOrchestratorProfile;
    const isNativeCliForCreator = (profileId: string, creator: string): boolean => {
      const p = profileId.toLowerCase();
      const c = creator.toLowerCase();
      if (c === "anthropic" && p.includes("claude")) return true;
      if (c === "openai" && p.includes("codex")) return true;
      if (c === "google" && (p.includes("gemini") || p.includes("antigravity"))) return true;
      return false;
    };

    const compiled: CompiledModelEntry[] = winners.map((w) => {
      const sortedRoutes = [...w.routes].sort((a, b) => {
        if (preferSub && a.billing !== b.billing) {
          if (a.billing === "subscription") return -1;
          if (b.billing === "subscription") return 1;
        }
        const aNative = isNativeCliForCreator(a.profileId, w.creator);
        const bNative = isNativeCliForCreator(b.profileId, w.creator);
        if (aNative !== bNative) return aNative ? -1 : 1;
        if (defaultProfile) {
          const aDef = a.profileId === defaultProfile;
          const bDef = b.profileId === defaultProfile;
          if (aDef !== bDef) return aDef ? -1 : 1;
        }
        return a.profileId.localeCompare(b.profileId);
      });
      const preferredRoute = sortedRoutes[0]!;
      const rawApiEquiv = w.costPerTaskUsd ?? estimateApiTaskCostUsd(w.listCostPer1m);
      const apiEquiv = rawApiEquiv === null ? null : Number(rawApiEquiv.toFixed(2));
      const marginalCost = preferredRoute.billing === "subscription" || preferredRoute.billing === "local" ? 0 : apiEquiv;
      const family = computeRefinedFamilyKey(w.creator, w.wireModelId, w.rawFamily);
      const observation = measurements.get(w.canonicalId);
      const realEfforts = (preferredRoute.supportedEfforts ?? w.supportedEfforts ?? []).filter(
        (e) => e.trim() && e.toLowerCase() !== "default",
      );

      return {
        id: w.canonicalId,
        family,
        name: w.name,
        codingRank: null,
        codingScore: w.codingScore ?? null,
        scoreSource: w.codingScore === undefined ? null : RANKING_COHORT.source,
        ...(observation?.effort ? { scoreObservation: { model: observation.rawModelName, effort: observation.effort } } : {}),
        benchmarks: w.codingScore === undefined ? {} : { [RANKING_COHORT.source]: w.codingScore },
        contextK: w.contextWindow ? Math.round(w.contextWindow / 1000) : null,
        efforts: realEfforts,
        preferredRoute,
        alternateRoutes: sortedRoutes.slice(1),
        costPerTaskUsd: marginalCost,
        apiEquivCostUsd: apiEquiv,
        timePerTaskSeconds: w.timePerTaskSeconds === undefined ? null : Math.round(w.timePerTaskSeconds),
        recommendedFor: inferRoles({
          family,
          codingScore: w.codingScore ?? null,
          apiEquivCostUsd: apiEquiv,
          topCodingScore,
        }),
      };
    });

    compiled.sort((a, b) => (b.codingScore ?? -1) - (a.codingScore ?? -1) || a.id.localeCompare(b.id));
    for (const [index, entry] of compiled.entries()) {
      if (entry.codingScore === null) break;
      const previous = compiled[index - 1];
      entry.codingRank = previous?.codingScore === entry.codingScore ? previous.codingRank : index + 1;
    }

    const hasScores = compiled.some((entry) => entry.codingScore !== null);
    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      profilesFingerprint: this.computeProfilesFingerprint(),
      syncedAt: new Date().toISOString(),
      sources: input.sources,
      nextLifecycleChangeAt: Number.isFinite(nextLifecycleChange) ? new Date(nextLifecycleChange).toISOString() : undefined,
      rankingEvidence: hasScores ? evidence : undefined,
      ...(hasScores && isEvidenceStale(evidence, now) ? { rankingEvidenceStale: true } : {}),
      profileStatuses: input.profileStatuses,
      models: compiled,
    };
  }

  private async discoverEnabledInventory(
    profiles: RunnerProfileConfig[],
    cwd: string,
  ): Promise<{ inventory: Map<string, ProbedModelInfo[]>; statuses: ProfileProbeStatus[] }> {
    const inventory = new Map<string, ProbedModelInfo[]>();
    const statuses: ProfileProbeStatus[] = [];
    await Promise.all(
      profiles.map(async (p) => {
        try {
          const models =
            p.kind === "pi" ? new PiRunner(p).probeModels() : await new AcpRunner(p).probeModels(cwd);
          inventory.set(p.id, models);
          statuses.push({
            profileId: p.id,
            status: models.length > 0 ? "ok" : "error",
            modelCount: models.length,
            ...(models.length === 0 ? { error: "CLI responded but reported 0 models" } : {}),
          });
        } catch (err) {
          const msg = (err instanceof Error ? err.message : String(err)).split("\n")[0]?.trim() || "Probe failed";
          if (p.models?.length) {
            inventory.set(
              p.id,
              p.models.map((wireModelId) => ({ wireModelId })),
            );
            statuses.push({ profileId: p.id, status: "ok", modelCount: p.models.length });
          } else {
            inventory.set(p.id, []);
            statuses.push({ profileId: p.id, status: "error", modelCount: 0, error: msg });
          }
        }
      }),
    );
    return { inventory, statuses };
  }
}
