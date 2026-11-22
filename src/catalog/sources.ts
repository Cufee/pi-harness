export interface ModelsDevEntry {
  id: string;
  provider: string;
  name: string;
  canonicalId?: string;
  isCanonical?: boolean;
  lastUpdated?: string;
  family?: string;
  releaseDate?: string;
  status?: string;
  toolCall?: boolean;
  reasoning?: boolean;
  supportedEfforts?: string[];
  contextWindow?: number;
  maxOutput?: number;
  cost?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  modalities?: { input?: string[]; output?: string[] };
}

export type BenchmarkSourceName =
  | "aa_pro"
  | "vals_tb4"
  | "harbor_tb4"
  | "epoch_frontierswe"
  | "vals_swebench"
  | "epoch_terminalbench"
  | "epoch_cursorbench"
  | "epoch_frontiercode"
  | "epoch_deepswe"
  | "epoch_swebench"
  | "pinchbench"
  | "openrouter_eng"
  | "openrouter_intel";

export const RANKING_COHORT = {
  source: "vals_tb4",
  benchmark: "Terminal-Bench",
  version: "4.0",
  harness: "Mini-SWE-agent",
  metric: "Overall accuracy (avg@3 pass@1)",
  unit: "percent",
  sourceUrl: "https://www.vals.ai/benchmarks/terminal-bench-4",
  settings: "66 tasks, 3 runs, 8-hour task limit, Vals headline effort per model",
} as const;

export interface BenchmarkEvidence {
  benchmark: string;
  version: string;
  harness: string;
  metric: string;
  unit: string;
  sourceUrl: string;
  revision: string;
  asOf: string;
  settings?: string;
}

export interface BenchmarkMetricRow {
  evidence?: BenchmarkEvidence;
  source: BenchmarkSourceName;
  rawModelName: string;
  canonicalKeyHint?: string;
  effort?: string | null;
  codingScore?: number; // normalized 0..100
  costPerTaskUsd?: number;
  timePerTaskSeconds?: number;
  turnsPerTask?: number;
}

export interface OpenRouterModelMeta {
  id: string;
  canonicalSlug?: string;
  created?: number; // OpenRouter listing timestamp
  expirationDate?: string;
  contextLength?: number;
  supportedEfforts?: string[];
  aaIntelligenceIndex?: number;
  aaEngineeringIndex?: number;
  codeArenaWinRate?: number;
  costPer1mInput?: number;
  costPer1mOutput?: number;
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function strings(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string") ? value : undefined;
}

function isoDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value) ? value : undefined;
}

function modelEntry(id: string, provider: string, m: JsonObject, isCanonical: boolean): ModelsDevEntry {
  const limit = object(m.limit) ? m.limit : {};
  const cost = object(m.cost) ? m.cost : {};
  const input = nonNegative(cost.input);
  const output = nonNegative(cost.output);
  const effort = Array.isArray(m.reasoning_options)
    ? m.reasoning_options.find((option) => object(option) && option.type === "effort")
    : undefined;
  return {
    id,
    provider,
    isCanonical,
    canonicalId: isCanonical ? provider + "/" + id : string(m.canonical_model_id),
    name: string(m.name) ?? id,
    family: string(m.family),
    releaseDate: string(m.release_date),
    lastUpdated: string(m.last_updated),
    status: string(m.status),
    toolCall: typeof m.tool_call === "boolean" ? m.tool_call : undefined,
    reasoning: typeof m.reasoning === "boolean" ? m.reasoning : undefined,
    supportedEfforts: strings(effort?.values),
    contextWindow: nonNegative(limit.context),
    maxOutput: nonNegative(limit.output),
    cost: input !== undefined && output !== undefined
      ? { input, output, cacheRead: nonNegative(cost.cache_read), cacheWrite: nonNegative(cost.cache_write) }
      : undefined,
    modalities: object(m.modalities) ? { input: strings(m.modalities.input), output: strings(m.modalities.output) } : undefined,
  };
}

export async function fetchModelsDev(): Promise<ModelsDevEntry[]> {
  const data = await fetchJson<JsonObject>("https://models.dev/catalog.json");
  if (!data) return [];
  const entries: ModelsDevEntry[] = [];
  for (const [provider, route] of Object.entries(data.providers ?? {})) {
    if (!object(route) || !object(route.models)) continue;
    for (const [id, m] of Object.entries(route.models)) {
      if (object(m)) entries.push(modelEntry(id, provider, m, false));
    }
  }
  for (const [key, m] of Object.entries(data.models ?? {})) {
    const slash = key.indexOf("/");
    if (slash > 0 && object(m)) entries.push(modelEntry(key.slice(slash + 1), key.slice(0, slash), m, true));
  }
  return entries;
}

function pricePerMillion(value: unknown): number | undefined {
  return typeof value === "string" && value.trim() ? nonNegative(Number(value) * 1_000_000) : undefined;
}

export async function fetchOpenRouterMetadata(): Promise<OpenRouterModelMeta[]> {
  const url = "https://openrouter.ai/api/v1/models";
  const rows: OpenRouterModelMeta[] = [];
  let page = url;
  const seen = new Set<string>();
  while (!seen.has(page)) {
    seen.add(page);
    const raw: JsonObject | null = await fetchJson<JsonObject>(page);
    if (!Array.isArray(raw?.data)) return [];
    for (const m of raw.data) {
      if (!object(m) || typeof m.id !== "string") continue;
      const pricing = object(m.pricing) ? m.pricing : {};
      rows.push({
        id: m.id,
        canonicalSlug: string(m.canonical_slug),
        created: nonNegative(m.created),
        expirationDate: isoDate(m.expiration_date),
        contextLength: nonNegative(m.context_length),
        supportedEfforts: object(m.reasoning) ? strings(m.reasoning.supported_efforts) : undefined,
        costPer1mInput: pricePerMillion(pricing.prompt),
        costPer1mOutput: pricePerMillion(pricing.completion),
      });
    }
    const next: unknown = object(raw.links) ? raw.links.next : null;
    if (!next) return rows;
    if (typeof next !== "string" || !URL.canParse(next, url)) return [];
    const resolved = new URL(next, url);
    if (resolved.origin + resolved.pathname !== url) return [];
    page = resolved.href;
  }
  return [];
}

interface Deprecation {
  deprecationDate?: string;
  successorModel?: string;
  deprecationSource?: string;
}

export async function fetchLiteLlmDeprecations(): Promise<Map<string, Deprecation>> {
  const raw = await fetchJson<JsonObject>(
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  );
  const out = new Map<string, Deprecation>();
  for (const [k, v] of Object.entries(raw ?? {})) {
    if (k === "sample_spec" || !object(v)) continue;
    const deprecationDate = isoDate(v.deprecation_date);
    const successorModel = string(v.successor_model);
    if (deprecationDate || successorModel) {
      out.set(k.toLowerCase(), { deprecationDate, successorModel, deprecationSource: string(v.deprecation_source) });
    }
  }
  return out;
}

// Vals model cards link their internal selectedModel keys to these public names.
// The Mistral preview and release have distinct cards despite the unsuffixed preview key.
const valsModelAliases: Record<string, { card?: string; name: string; id: string }> = {
  "google/cobalt-c-high-1p00": { card: "google_gemini-4-neon", name: "Gemini 4 Neon", id: "google/gemini-4-neon" },
  "alibaba/qwen3.8-max-internal": { card: "alibaba_qwen3.8-max-0902", name: "Qwen 3.8 Max 0902", id: "alibaba/qwen3.8-max-0902" },
  "thinkingmachines/inkling-mini-1117": { card: "thinkingmachines_inkling-2-mini", name: "Inkling 2 Mini", id: "thinkingmachines/inkling-2-mini" },
  "mistralai/mistral-large-4-oss": { name: "Mistral Large 4", id: "mistralai/mistral-large-4-oss" },
  "kimi/kimi-k3": { name: "Kimi K3", id: "moonshotai/kimi-k3" },
  "kimi/kimi-k3.1-pro": { name: "Kimi K3.1 Pro", id: "moonshotai/kimi-k3.1-pro" },
  "meta/muse-wonder": { name: "Wonder", id: "meta/muse-wonder-1.0" },
  "meta/muse-wonder-full": { name: "Wonder Full", id: "meta/muse-wonder-full" },
  "meta/muse-ember": { name: "Muse Ember", id: "meta/muse-ember-1.0" },
  "meta/muse_spark_1_2": { name: "Muse Spark 1.2", id: "meta/muse-spark-1.2" },
  "meta/muse_spark_1_3": { name: "Muse Spark 1.3", id: "meta/muse-spark-1.3" },
  "meta/muse_spark_1_3_max": { name: "Muse Spark 1.3 Max", id: "meta/muse-spark-1.3-max" },
  "grok/grok-4.5": { name: "Grok 4.5", id: "xai/grok-4.5" },
  "grok/grok-4.6": { name: "Grok 4.6", id: "xai/grok-4.6" },
  "grok/grok-4.7": { name: "Grok 4.7", id: "xai/grok-4.7" },
};

function labelWords(label: string): string {
  return label.toLowerCase().match(/[a-z]+|[0-9]+/g)?.join("-") ?? "";
}

function hasPublishedDate(html: string, asOf: string): boolean {
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([^<]+)<\/script>/g)) {
    try {
      const data: unknown = JSON.parse(json!);
      const entries = Array.isArray(data) ? data : [data];
      if (entries.some((entry) => object(entry) && entry["@type"] === "Dataset" &&
          entry.url === RANKING_COHORT.sourceUrl && entry.name === "Terminal-Bench 4.0 leaderboard" &&
          entry.dateModified === asOf)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

function publishedScores(html: string) {
  const cards = new Map<string, { name: string; percent: number }>();
  const pattern = /<th scope="row">\s*<a href="\/models\/([^"]+)">([^<]+)<\/a>\s*<\/th>\s*<td>Mini-SWE-agent<\/td>\s*<td>(\d+(?:\.\d+)?)%<\/td>/g;
  for (const [, card, name, percent] of html.matchAll(pattern)) {
    if (card && name) cards.set(card, { name, percent: Number(percent) });
  }
  return cards;
}

export async function fetchValsAiBenchmarks(): Promise<BenchmarkMetricRow[]> {
  const cohort = RANKING_COHORT;
  const html = await fetchText(cohort.sourceUrl);
  if (!html ||
      !html.includes("All results reported are avg@3: each model is run through the full benchmark three times, each run scored as pass@1 (one attempt per task)") ||
      !html.includes("Each task has an 8-hour agent time limit,") ||
      !html.includes("All 66 tasks are new")) return [];
  const assets = new Set(Array.from(
    html.matchAll(/href="(\/_astro\/benchmark_view_terminal_bench_4\.[a-zA-Z0-9_-]+\.json)"/g),
    (match) => match[1]!,
  ));
  if (assets.size !== 1) return [];
  const revision = new URL([...assets][0]!, cohort.sourceUrl).href;
  const data = await fetchJson<JsonObject>(revision);
  const meta = data?.metadata;
  if (!object(meta) || meta.benchmark_id !== "terminal_bench_4" || meta.version !== cohort.version ||
      meta.benchmark !== "Terminal-Bench 4.0" || meta.family !== "terminal_bench" || meta.mode !== "agentic" ||
      meta.harness !== cohort.harness || meta.slug !== "terminal-bench-4" || meta.runner !== "external" ||
      meta.token_tasks_measured !== 66 || meta.archived !== false) return [];
  const asOf = isoDate(meta.updated);
  if (!asOf || !hasPublishedDate(html, asOf)) return [];
  const overall = object(data?.tasks) ? data.tasks.overall : null;
  if (!object(overall) || !Array.isArray(meta.models) || meta.total_models !== Object.keys(overall).length) return [];
  const models = new Set(meta.models);
  const published = publishedScores(html);
  const evidence: BenchmarkEvidence = { ...cohort, revision, asOf };
  const rows: BenchmarkMetricRow[] = [];
  for (const [key, row] of Object.entries(overall)) {
    if (!models.has(key) || !object(row) || row.token_tasks_measured !== 66 ||
        (row.harness !== null && row.harness !== cohort.harness)) continue;
    const score = nonNegative(row.accuracy);
    const alias = valsModelAliases[key];
    const card = published.get(alias?.card ?? key.replace("/", "_"));
    if (!card || score === undefined || score > 100 || Math.abs(card.percent - score) > 0.00501) continue;
    const model = key.split("/")[1];
    if (!model || (alias ? card.name !== alias.name : labelWords(model) !== labelWords(card.name))) continue;
    const computeEffort = string(row.compute_effort);
    const reasoningEffort = string(row.reasoning_effort);
    if (computeEffort && reasoningEffort && computeEffort !== reasoningEffort) continue;
    const effort = computeEffort ?? reasoningEffort;
    if (!effort?.trim()) continue;
    rows.push({
      source: cohort.source,
      rawModelName: key,
      canonicalKeyHint: alias?.id ?? key,
      effort,
      codingScore: score,
      evidence,
      costPerTaskUsd: nonNegative(row.cost_per_test),
      timePerTaskSeconds: nonNegative(row.latency),
      turnsPerTask: object(row.turn_metrics) ? nonNegative(row.turn_metrics.avg_turns) : undefined,
    });
  }
  return rows;
}

// These exported entry points have no observations in the selected ranking protocol.
export async function fetchHarborTerminalBench(): Promise<BenchmarkMetricRow[]> { return []; }
export async function fetchEpochAiCodingBenchmarks(): Promise<BenchmarkMetricRow[]> { return []; }
export async function fetchPinchBench(): Promise<BenchmarkMetricRow[]> { return []; }
export async function fetchArtificialAnalysisPro(_apiKey?: string): Promise<BenchmarkMetricRow[]> { return []; }
