import { inflateRawSync } from "node:zlib";

export interface ModelsDevEntry {
  id: string;
  provider: string;
  name: string;
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

export interface BenchmarkMetricRow {
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
  created?: number;
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

export async function fetchModelsDev(): Promise<ModelsDevEntry[]> {
  const data = await fetchJson<Record<string, { models?: Record<string, Record<string, unknown>> }>>(
    "https://models.dev/api.json",
  );
  if (!data) return [];

  const entries: ModelsDevEntry[] = [];
  for (const [provider, provObj] of Object.entries(data)) {
    const models = provObj?.models;
    if (!models) continue;
    for (const [id, m] of Object.entries(models)) {
      const cost = m.cost as Record<string, number> | undefined;
      const limit = m.limit as Record<string, number> | undefined;
      const modalities = m.modalities as { input?: string[]; output?: string[] } | undefined;
      const reasoningOpts = m.reasoning_options as { effort?: string[] } | undefined;

      entries.push({
        id,
        provider,
        name: String(m.name ?? id),
        family: typeof m.family === "string" ? m.family : undefined,
        releaseDate: typeof m.release_date === "string" ? m.release_date : undefined,
        status: typeof m.status === "string" ? m.status : undefined,
        toolCall: m.tool_call === undefined ? true : Boolean(m.tool_call),
        reasoning: Boolean(m.reasoning),
        supportedEfforts: Array.isArray(reasoningOpts?.effort) ? reasoningOpts.effort : undefined,
        contextWindow: limit?.context,
        maxOutput: limit?.output,
        cost: cost
          ? { input: cost.input ?? 0, output: cost.output ?? 0, cacheRead: cost.cache_read, cacheWrite: cost.cache_write }
          : undefined,
        modalities,
      });
    }
  }
  return entries;
}

export async function fetchOpenRouterMetadata(): Promise<OpenRouterModelMeta[]> {
  const raw = await fetchJson<{ data?: Array<Record<string, unknown>> }>("https://openrouter.ai/api/v1/models");
  if (!raw?.data) return [];
  return raw.data.map((m) => {
    const pricing = m.pricing as Record<string, string> | undefined;
    const reasoning = m.reasoning as { supported_efforts?: string[] } | undefined;
    const benchmarks = m.benchmarks as
      | {
          artificial_analysis?: { intelligence_index?: number; engineering_index?: number };
          design_arena?: Array<{ category?: string; win_rate?: number }>;
        }
      | undefined;
    const codeArena = benchmarks?.design_arena?.find((d) => d.category === "codecategories")?.win_rate;
    return {
      id: String(m.id ?? ""),
      canonicalSlug: typeof m.canonical_slug === "string" ? m.canonical_slug : undefined,
      created: typeof m.created === "number" ? m.created : undefined,
      contextLength: typeof m.context_length === "number" ? m.context_length : undefined,
      supportedEfforts: reasoning?.supported_efforts,
      aaIntelligenceIndex:
        typeof benchmarks?.artificial_analysis?.intelligence_index === "number"
          ? benchmarks.artificial_analysis.intelligence_index
          : undefined,
      aaEngineeringIndex:
        typeof benchmarks?.artificial_analysis?.engineering_index === "number"
          ? benchmarks.artificial_analysis.engineering_index
          : undefined,
      codeArenaWinRate: typeof codeArena === "number" ? codeArena : undefined,
      costPer1mInput: pricing?.prompt ? Number(pricing.prompt) * 1_000_000 : undefined,
      costPer1mOutput: pricing?.completion ? Number(pricing.completion) * 1_000_000 : undefined,
    };
  });
}

export async function fetchLiteLlmDeprecations(): Promise<Map<string, { deprecationDate?: string; successorModel?: string }>> {
  const raw = await fetchJson<Record<string, Record<string, unknown>>>(
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json",
  );
  const out = new Map<string, { deprecationDate?: string; successorModel?: string }>();
  if (!raw) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "object" || !v) continue;
    const dep = typeof v.deprecation_date === "string" ? v.deprecation_date : undefined;
    const succ = typeof v.successor_model === "string" ? v.successor_model : undefined;
    if (dep || succ) out.set(k.toLowerCase(), { deprecationDate: dep, successorModel: succ });
  }
  return out;
}

/**
 * Vals.ai standardized Mini-SWE-agent leaderboards (Terminal-Bench 4.0 + SWE-bench).
 * Provides 70–88 models keyed directly by canonical `provider/model` IDs with
 * `accuracy`, `cost_per_test`, `latency`, and `avg_turns`.
 */
export async function fetchValsAiBenchmarks(): Promise<BenchmarkMetricRow[]> {
  const specs: Array<{ url: string; source: BenchmarkSourceName }> = [
    { url: "https://www.vals.ai/benchmarks/terminal-bench-4", source: "vals_tb4" },
    { url: "https://www.vals.ai/benchmarks/swebench", source: "vals_swebench" },
  ];

  const all: BenchmarkMetricRow[] = [];
  await Promise.all(
    specs.map(async ({ url, source }) => {
      const html = await fetchText(url);
      if (!html) return;
      const assetMatch = html.match(/\/_astro\/benchmark_view_[^"']+\.json/);
      if (!assetMatch) return;
      const json = await fetchJson<{ tasks?: { overall?: Record<string, Record<string, unknown>> } }>(
        `https://www.vals.ai${assetMatch[0]}`,
      );
      const overall = json?.tasks?.overall;
      if (!overall) return;
      for (const [modelKey, row] of Object.entries(overall)) {
        const acc = typeof row.accuracy === "number" ? row.accuracy : undefined;
        if (acc === undefined) continue;
        const turnMetrics = row.turn_metrics as { avg_turns?: number } | undefined;
        all.push({
          source,
          rawModelName: modelKey,
          canonicalKeyHint: modelKey,
          effort:
            typeof row.compute_effort === "string"
              ? row.compute_effort
              : typeof row.reasoning_effort === "string"
                ? row.reasoning_effort
                : null,
          codingScore: acc <= 1 ? acc * 100 : acc,
          costPerTaskUsd: typeof row.cost_per_test === "number" ? row.cost_per_test : undefined,
          timePerTaskSeconds: typeof row.latency === "number" ? row.latency : undefined,
          turnsPerTask: typeof turnMetrics?.avg_turns === "number" ? turnMetrics.avg_turns : undefined,
        });
      }
    }),
  );
  return all;
}

/** Harbor Hub / Terminal-Bench 4.1 (zero-auth, updated continuously with accuracy, cost/task, time/task). */
export async function fetchHarborTerminalBench(): Promise<BenchmarkMetricRow[]> {
  const raw = await fetchJson<
    Array<Record<string, unknown>> | { rows?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> }
  >("https://ofhuhcpkvzjlejydnvyd.supabase.co/functions/v1/leaderboard-read", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ package: "terminal-bench/terminal-bench", name: "4-1-0" }),
  });
  const rows = Array.isArray(raw) ? raw : raw?.rows ?? raw?.data ?? [];
  const out: BenchmarkMetricRow[] = [];
  for (const r of rows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const metrics = (r.metrics ?? {}) as Record<string, unknown>;
    const modelDisplay = (meta.model_display as { label?: string } | undefined)?.label ?? String(meta.model ?? "");
    const modelOrg = (meta.model_org as { label?: string } | undefined)?.label ?? "";
    const nTrials = Number(r.n_trials ?? 0);
    const totalCost = typeof metrics.total_cost_usd === "number" ? metrics.total_cost_usd : undefined;
    const accuracy = typeof metrics.accuracy === "number" ? metrics.accuracy : undefined;
    const duration = typeof metrics.avg_trial_duration_sec === "number" ? metrics.avg_trial_duration_sec : undefined;
    if (!modelDisplay || accuracy === undefined) continue;
    out.push({
      source: "harbor_tb4",
      rawModelName: modelDisplay,
      canonicalKeyHint: modelOrg ? `${modelOrg.toLowerCase()}/${modelDisplay}` : undefined,
      effort: typeof meta.reasoning_effort === "string" ? meta.reasoning_effort : null,
      codingScore: accuracy <= 1 ? accuracy * 100 : accuracy,
      costPerTaskUsd: totalCost !== undefined && nTrials > 0 ? totalCost / nTrials : undefined,
      timePerTaskSeconds: duration,
    });
  }
  return out;
}

/** PinchBench official agentic leaderboard (zero-auth). */
export async function fetchPinchBench(): Promise<BenchmarkMetricRow[]> {
  const raw = await fetchJson<{ leaderboard?: Array<Record<string, unknown>>; data?: Array<Record<string, unknown>> }>(
    "https://api.pinchbench.com/api/leaderboard?official=true&limit=200",
  );
  const rows = raw?.leaderboard ?? raw?.data ?? [];
  const out: BenchmarkMetricRow[] = [];
  for (const r of rows) {
    const model = typeof r.model === "string" ? r.model : "";
    const score =
      typeof r.average_score_percentage === "number"
        ? r.average_score_percentage
        : typeof r.best_score_percentage === "number"
          ? r.best_score_percentage
          : undefined;
    if (!model || score === undefined) continue;
    out.push({
      source: "pinchbench",
      rawModelName: model,
      canonicalKeyHint: model,
      codingScore: score <= 1 ? score * 100 : score,
    });
  }
  return out;
}

/** Optional Artificial Analysis V2 Pro `/api/v2/language/agents/coding` enrichment. */
export async function fetchArtificialAnalysisPro(apiKey?: string): Promise<BenchmarkMetricRow[]> {
  if (!apiKey) return [];
  const raw = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
    "https://artificialanalysis.ai/api/v2/language/agents/coding",
    { headers: { "x-api-key": apiKey } },
  );
  if (!raw?.data) return [];
  const out: BenchmarkMetricRow[] = [];
  for (const row of raw.data) {
    const model = (row.model ?? {}) as Record<string, unknown>;
    const score = typeof row.coding_agent_index === "number" ? row.coding_agent_index : undefined;
    if (score === undefined) continue;
    out.push({
      source: "aa_pro",
      rawModelName: String(model.release_name ?? model.name ?? model.slug ?? ""),
      canonicalKeyHint: typeof model.release_slug === "string" ? `${row.provider ?? ""}/${model.release_slug}` : undefined,
      effort: typeof model.effort === "string" ? model.effort : null,
      codingScore: score,
      costPerTaskUsd: typeof row.cost_per_task === "number" ? row.cost_per_task : undefined,
      timePerTaskSeconds: typeof row.time_per_task_seconds === "number" ? row.time_per_task_seconds : undefined,
      turnsPerTask: typeof row.turns_per_task === "number" ? row.turns_per_task : undefined,
    });
  }
  return out;
}

/**
 * Reliable ZIP Central Directory extractor for Epoch AI `benchmark_data.zip`
 * (works on streaming data-descriptor ZIPs where local headers have compSize=0!).
 * Extracts all 6 coding benchmarks in a single download.
 */
export async function fetchEpochAiCodingBenchmarks(): Promise<BenchmarkMetricRow[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch("https://epoch.ai/data/benchmark_data.zip", { signal: ctrl.signal });
    if (!res.ok) return [];
    const buf = Buffer.from(await res.arrayBuffer());
    const targets: Array<{ file: string; source: BenchmarkSourceName }> = [
      { file: "frontierswe_external.csv", source: "epoch_frontierswe" },
      { file: "terminalbench_external.csv", source: "epoch_terminalbench" },
      { file: "cursorbench_external.csv", source: "epoch_cursorbench" },
      { file: "frontiercode_external.csv", source: "epoch_frontiercode" },
      { file: "deepswe_external.csv", source: "epoch_deepswe" },
      { file: "swe_bench_verified.csv", source: "epoch_swebench" },
    ];
    const extracted = extractFilesFromZipCentralDir(
      buf,
      targets.map((t) => t.file),
    );
    const all: BenchmarkMetricRow[] = [];
    for (const { file, source } of targets) {
      const csv = extracted.get(file);
      if (csv) all.push(...parseEpochCsv(csv, source));
    }
    return all;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function extractFilesFromZipCentralDir(buf: Buffer, suffixes: string[]): Map<string, string> {
  const out = new Map<string, string>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) return out;

  const cdCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  let pos = cdOffset;

  for (let i = 0; i < cdCount && pos + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) break;
    const compression = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localHeaderOffset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    pos += 46 + nameLen + extraLen + commentLen;

    const matchedSuffix = suffixes.find((s) => name === s || name.endsWith(`/${s}`));
    if (!matchedSuffix) continue;

    if (localHeaderOffset + 30 > buf.length || buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;
    const lhNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const payload = buf.subarray(dataStart, dataStart + compSize);
    try {
      if (compression === 0) out.set(matchedSuffix, payload.toString("utf8"));
      else if (compression === 8) out.set(matchedSuffix, inflateRawSync(payload).toString("utf8"));
    } catch {
      // skip corrupt entry
    }
  }
  return out;
}

function parseEpochCsv(csv: string, source: BenchmarkSourceName): BenchmarkMetricRow[] {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const idxModel = headers.findIndex((h) => h.includes("model"));
  const idxScore = headers.findIndex(
    (h) => h === "score" || h.includes("resolved") || h.includes("pass@1") || h.includes("accuracy") || h.includes("mean score"),
  );
  const idxCost = headers.findIndex((h) => h.includes("cost"));
  const idxDur = headers.findIndex((h) => h.includes("duration") || h.includes("seconds"));
  if (idxModel === -1 || idxScore === -1) return [];

  const durIsHours = idxDur >= 0 && headers[idxDur]!.includes("hour");
  const out: BenchmarkMetricRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]!);
    const name = cols[idxModel];
    const score = Number(cols[idxScore]?.replace("%", ""));
    if (!name || !Number.isFinite(score)) continue;
    const cost = idxCost >= 0 ? Number(cols[idxCost]?.replace("$", "")) : NaN;
    const dur = idxDur >= 0 ? Number(cols[idxDur]) : NaN;
    out.push({
      source,
      rawModelName: name,
      codingScore: score <= 1 ? score * 100 : score,
      costPerTaskUsd: Number.isFinite(cost) ? cost : undefined,
      timePerTaskSeconds: Number.isFinite(dur) ? (durIsHours ? dur * 3600 : dur) : undefined,
    });
  }
  return out;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}
