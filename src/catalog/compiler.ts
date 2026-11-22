import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HarnessConfig, RunnerProfileConfig } from "../config.js";
import type { QuotaClient } from "../quota/client.js";
import type { ResolvedModelQuota } from "../quota/schema.js";
import { AcpRunner } from "../runners/acp-runner.js";
import { PiRunner } from "../runners/pi-runner.js";
import type { ProbedModelInfo } from "../runners/types.js";
import {
  computeRefinedFamilyKey,
  selectLatestPerFamily,
  stripSnapshotAndRouting,
  type CandidateModel,
  type ModelRoute,
} from "./deduplicate.js";
import {
  fetchArtificialAnalysisPro,
  fetchEpochAiCodingBenchmarks,
  fetchHarborTerminalBench,
  fetchLiteLlmDeprecations,
  fetchModelsDev,
  fetchOpenRouterMetadata,
  fetchPinchBench,
  fetchValsAiBenchmarks,
  type BenchmarkMetricRow,
  type BenchmarkSourceName,
} from "./sources.js";

export interface CompiledModelEntry {
  id: string;
  family: string;
  name: string;
  codingRank: number;
  codingScore: number | null;
  scoreSource: BenchmarkSourceName | null;
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
}

export const CATALOG_SCHEMA_VERSION = 4;

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
  profileStatuses?: ProfileProbeStatus[];
  models: CompiledModelEntry[];
}

const SOURCE_PRIORITY: Record<BenchmarkSourceName, number> = {
  aa_pro: 100,
  vals_tb4: 95,
  harbor_tb4: 90,
  epoch_frontierswe: 85,
  vals_swebench: 80,
  epoch_terminalbench: 78,
  epoch_cursorbench: 75,
  epoch_frontiercode: 72,
  epoch_deepswe: 70,
  epoch_swebench: 65,
  pinchbench: 60,
  openrouter_eng: 45,
  openrouter_intel: 35,
};

/**
 * Generates normalized match keys bridging vendor IDs (`anthropic/claude-opus-5-5`, `gpt-6.2-sol`),
 * Harbor short names (`Opus 5.5`, `Fable 5.2`), Epoch CSV names (`Claude Opus 5.5 (Max)`),
 * and Vals.ai `provider/model` keys.
 */
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

function inferCreatorFromModelId(id: string, fallbackProvider: string): string {
  const lower = id.toLowerCase();
  if (lower.includes("claude") || lower.includes("opus") || lower.includes("sonnet") || lower.includes("haiku") || lower.includes("fable")) {
    return "anthropic";
  }
  if (lower.includes("gpt") || lower.includes("codex") || lower.includes("astra") || lower.includes("sol") || /^o[134](-|$)/.test(lower)) {
    return "openai";
  }
  if (lower.includes("gemini") || lower.includes("gemma")) return "google";
  if (lower.includes("deepseek")) return "deepseek";
  if (lower.includes("kimi")) return "moonshotai";
  if (lower.includes("glm")) return "zai";
  if (lower.includes("qwen")) return "qwen";
  if (lower.includes("grok")) return "xai";
  return fallbackProvider.replace(/^acp:/, "");
}

function inferRoles(entry: { family: string; codingScore: number | null; apiEquivCostUsd: number | null }): string[] {
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
  if ((entry.apiEquivCostUsd ?? 1) < 0.15) return ["codebase_research", "fast_scout"];
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
    return this.config.profiles
      .filter((p) => p.enabled !== false)
      .map((p) =>
        p.kind === "acp"
          ? `${p.id}|acp|${p.command}|${(p.args ?? []).join(" ")}|${(p.models ?? []).join(",")}`
          : `${p.id}|pi|${p.provider}|${(p.models ?? []).join(",")}`,
      )
      .sort()
      .join(";;");
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
    if ((catalog.schemaVersion ?? 1) < CATALOG_SCHEMA_VERSION) return false;
    if (catalog.profilesFingerprint !== this.computeProfilesFingerprint()) return false;
    const ageMs = Date.now() - Date.parse(catalog.syncedAt);
    return Number.isFinite(ageMs) && ageMs < this.config.catalog.ttlHours * 3_600_000;
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
    const pick =
      candidates.find((c) => c.route.wireModelId.toLowerCase() === lower) ??
      candidates.find((c) => c.entry.id.toLowerCase() === lower) ??
      candidates
        .map((c) => {
          const keys = new Set([...buildMatchKeys(c.entry.id), ...buildMatchKeys(c.route.wireModelId)]);
          return { c, score: [...requestKeys].filter((k) => keys.has(k)).length };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.c;
    if (!pick) return null;

    const efforts = pick.route.supportedEfforts;
    return {
      wireModelId: pick.route.wireModelId,
      canonicalId: pick.entry.id,
      ...(effort && (!efforts?.length || efforts.includes(effort)) ? { effort } : {}),
    };
  }

  async getCatalog(opts?: {
    forceSync?: boolean;
    cwd?: string;
    role?: string;
    maxApiEquivUsd?: number;
    excludeExhausted?: boolean;
  }): Promise<CompiledModelCatalog> {
    const cached = this.loadCached();
    const catalog: CompiledModelCatalog =
      opts?.forceSync || !cached || !this.isCacheFresh(cached)
        ? await this.sync(opts?.cwd ?? process.cwd())
        : cached;

    await this.quotaClient?.sync(false).catch(() => {});
    const enrichedModels = catalog.models
      .map((m) => {
        const route = m.preferredRoute;
        const quota = this.quotaClient?.resolveForModel({
          profileId: route.profileId,
          provider: route.provider,
          wireModelId: route.wireModelId,
          canonicalModelId: m.id,
        });
        return { ...m, quota: quota ?? m.quota ?? null };
      })
      .filter((m) => {
        if (opts?.excludeExhausted && m.quota?.exhausted) return false;
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

    const aaKeyEnv = this.config.catalog.artificialAnalysisKeyEnv ?? "ARTIFICIAL_ANALYSIS_API_KEY";
    const aaKey = process.env[aaKeyEnv];

    const [modelsDev, openRouter, litellmDep, valsAi, harbor, epoch, pinch, aaPro] = await Promise.all([
      fetchModelsDev(),
      fetchOpenRouterMetadata(),
      fetchLiteLlmDeprecations(),
      fetchValsAiBenchmarks(),
      fetchHarborTerminalBench(),
      fetchEpochAiCodingBenchmarks(),
      fetchPinchBench(),
      fetchArtificialAnalysisPro(aaKey),
    ]);

    const sources: string[] = [];
    if (modelsDev.length) sources.push("models.dev");
    if (openRouter.length) sources.push("openrouter");
    if (valsAi.length) sources.push("vals_ai");
    if (harbor.length) sources.push("harbor_tb4");
    if (epoch.length) sources.push("epoch_ai");
    if (pinch.length) sources.push("pinchbench");
    if (aaPro.length) sources.push("artificial_analysis_pro");

    const catalog = this.compileFromData({
      enabledProfiles,
      inventory: discovered.inventory,
      profileStatuses: discovered.statuses,
      modelsDev,
      openRouter,
      litellmDep,
      benchmarks: [...aaPro, ...valsAi, ...harbor, ...epoch, ...pinch],
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
    const mdByKey = new Map<string, (typeof input.modelsDev)[number]>();
    for (const m of input.modelsDev) {
      for (const k of [...buildMatchKeys(`${m.provider}/${m.id}`), ...buildMatchKeys(m.id), ...buildMatchKeys(m.name)]) {
        if (!mdByKey.has(k)) mdByKey.set(k, m);
      }
    }

    const orByKey = new Map<string, (typeof input.openRouter)[number]>();
    for (const m of input.openRouter) {
      for (const k of [...buildMatchKeys(m.id), ...(m.canonicalSlug ? buildMatchKeys(m.canonicalSlug) : [])]) {
        if (!orByKey.has(k)) orByKey.set(k, m);
      }
    }

    const benchByKey = new Map<string, BenchmarkMetricRow[]>();
    const indexBench = (row: BenchmarkMetricRow) => {
      const keys = new Set([
        ...buildMatchKeys(row.rawModelName),
        ...(row.canonicalKeyHint ? buildMatchKeys(row.canonicalKeyHint) : []),
      ]);
      for (const k of keys) {
        const list = benchByKey.get(k) ?? [];
        list.push(row);
        benchByKey.set(k, list);
      }
    };
    for (const b of input.benchmarks) indexBench(b);

    // Also add OpenRouter's free AA engineering_index & intelligence_index as fallback benchmark rows
    for (const m of input.openRouter) {
      if (m.aaEngineeringIndex !== undefined) {
        indexBench({
          source: "openrouter_eng",
          rawModelName: m.id,
          canonicalKeyHint: m.canonicalSlug,
          codingScore: m.aaEngineeringIndex,
        });
      }
      if (m.aaIntelligenceIndex !== undefined) {
        indexBench({
          source: "openrouter_intel",
          rawModelName: m.id,
          canonicalKeyHint: m.canonicalSlug,
          codingScore: m.aaIntelligenceIndex,
        });
      }
    }

    // Track per-canonicalId detailed benchmark breakdown & winning source
    const detailByCanonical = new Map<
      string,
      { scoreSource: BenchmarkSourceName | null; benchmarks: Partial<Record<BenchmarkSourceName, number>> }
    >();
    const candidateMap = new Map<string, CandidateModel>();

    for (const profile of input.enabledProfiles) {
      const models = input.inventory.get(profile.id) ?? [];
      const providerName = profile.kind === "pi" ? profile.provider : profile.adapter;
      for (const m of models) {
        // Resolve short ACP aliases like "opus" / "sonnet" / "haiku" against latest models.dev entry if present
        let resolvedWireId = m.wireModelId;
        if (/^(opus|sonnet|haiku|fable)$/i.test(resolvedWireId)) {
          const matchingMd = input.modelsDev
            .filter((d) => d.family === `claude-${resolvedWireId.toLowerCase()}` && d.status !== "deprecated")
            .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))[0];
          if (matchingMd) resolvedWireId = matchingMd.id;
        }

        const creator = inferCreatorFromModelId(resolvedWireId, providerName);
        const { base } = stripSnapshotAndRouting(resolvedWireId);
        const bare = base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;
        const canonicalId = `${creator}/${bare}`;

        const lookupKeys = [
          ...buildMatchKeys(canonicalId),
          ...buildMatchKeys(bare),
          ...(m.name ? buildMatchKeys(m.name) : []),
        ];

        const md = lookupKeys.map((k) => mdByKey.get(k)).find(Boolean);
        const or = lookupKeys.map((k) => orByKey.get(k)).find(Boolean);
        const dep = input.litellmDep.get(resolvedWireId.toLowerCase()) ?? input.litellmDep.get(canonicalId.toLowerCase());

        const allSearchKeys = new Set([
          ...lookupKeys,
          ...(md?.name ? buildMatchKeys(md.name) : []),
          ...(md?.id ? buildMatchKeys(md.id) : []),
          ...(or?.id ? buildMatchKeys(or.id) : []),
        ]);

        const matchedRows: BenchmarkMetricRow[] = [];
        for (const k of allSearchKeys) {
          const list = benchByKey.get(k);
          if (list) matchedRows.push(...list);
        }

        // Collapse to best score per benchmark source, then pick highest-priority coding benchmark
        const bySource = new Map<BenchmarkSourceName, BenchmarkMetricRow>();
        for (const row of matchedRows) {
          const prev = bySource.get(row.source);
          if (!prev || (row.codingScore ?? -1) > (prev.codingScore ?? -1)) {
            bySource.set(row.source, row);
          }
        }

        const rankedSources = [...bySource.values()].sort(
          (a, b) => (SOURCE_PRIORITY[b.source] ?? 0) - (SOURCE_PRIORITY[a.source] ?? 0),
        );
        const primaryBench = rankedSources[0];
        const costBench = rankedSources.find((r) => r.costPerTaskUsd !== undefined);
        const timeBench = rankedSources.find((r) => r.timePerTaskSeconds !== undefined);

        const benchmarksObj: Partial<Record<BenchmarkSourceName, number>> = {};
        for (const [src, row] of bySource) {
          if (row.codingScore !== undefined) benchmarksObj[src] = Number(row.codingScore.toFixed(1));
        }

        detailByCanonical.set(canonicalId, {
          scoreSource: primaryBench?.source ?? null,
          benchmarks: benchmarksObj,
        });

        const route: ModelRoute = {
          profileId: profile.id,
          runner: profile.kind,
          provider: providerName,
          wireModelId: m.wireModelId, // keep original wire ID so ACP/Pi accepts it verbatim
          billing: profile.billing,
          supportedEfforts: m.supportedEfforts ?? md?.supportedEfforts ?? or?.supportedEfforts,
        };

        const existing = candidateMap.get(canonicalId);
        if (existing) {
          existing.routes.push(route);
        } else {
          const isDeprecated =
            md?.status === "deprecated" ||
            Boolean(dep?.deprecationDate && Date.parse(dep.deprecationDate) <= Date.now());
          candidateMap.set(canonicalId, {
            canonicalId,
            creator,
            wireModelId: bare,
            name: md?.name ?? m.name ?? bare,
            rawFamily: md?.family,
            releaseDate: md?.releaseDate ?? (or?.created ? new Date(or.created * 1000).toISOString().slice(0, 10) : undefined),
            deprecated: isDeprecated,
            successorModel: dep?.successorModel,
            toolCall: md?.toolCall ?? true,
            modalities: md?.modalities,
            contextWindow: md?.contextWindow ?? or?.contextLength,
            supportedEfforts: route.supportedEfforts,
            listCostPer1m:
              md?.cost ??
              (or?.costPer1mInput !== undefined
                ? { input: or.costPer1mInput, output: or.costPer1mOutput ?? 0 }
                : undefined),
            codingScore: primaryBench?.codingScore,
            costPerTaskUsd: costBench?.costPerTaskUsd,
            timePerTaskSeconds: timeBench?.timePerTaskSeconds,
            routes: [route],
          });
        }
      }
    }

    const winners = selectLatestPerFamily([...candidateMap.values()], {
      allowPreview: this.config.catalog.allowPreview ?? true,
    });

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

    const compiled: CompiledModelEntry[] = winners.map((w, idx) => {
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
      const detail = detailByCanonical.get(w.canonicalId);

      return {
        id: w.canonicalId,
        family,
        name: w.name,
        codingRank: idx + 1,
        codingScore: w.codingScore === undefined ? null : Number(w.codingScore.toFixed(1)),
        scoreSource: detail?.scoreSource ?? null,
        benchmarks: detail?.benchmarks ?? {},
        contextK: w.contextWindow ? Math.round(w.contextWindow / 1000) : null,
        efforts: preferredRoute.supportedEfforts ?? w.supportedEfforts ?? ["default"],
        preferredRoute,
        alternateRoutes: sortedRoutes.slice(1),
        costPerTaskUsd: marginalCost,
        apiEquivCostUsd: apiEquiv,
        timePerTaskSeconds: w.timePerTaskSeconds === undefined ? null : Math.round(w.timePerTaskSeconds),
        recommendedFor: inferRoles({ family, codingScore: w.codingScore ?? null, apiEquivCostUsd: apiEquiv }),
      };
    });

    return {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      profilesFingerprint: this.computeProfilesFingerprint(),
      syncedAt: new Date().toISOString(),
      sources: input.sources,
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
