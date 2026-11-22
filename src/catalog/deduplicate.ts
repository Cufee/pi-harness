import { stripRoutingSuffix, vendorSuccessors } from "./lifecycle.js";
export { stripRoutingSuffix } from "./lifecycle.js";

export interface CandidateModel {
  canonicalId: string; // e.g. "anthropic/claude-opus-5-5"
  creator: string;
  wireModelId: string;
  name: string;
  rawFamily?: string;
  releaseDate?: string;
  deprecated?: boolean;
  successorModel?: string;
  toolCall?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  contextWindow?: number;
  supportedEfforts?: string[];
  listCostPer1m?: { input: number; output: number; cacheRead?: number };
  codingScore?: number;
  costPerTaskUsd?: number;
  timePerTaskSeconds?: number;
  routes: ModelRoute[];
}

export interface ModelRoute {
  profileId: string;
  runner: "acp" | "pi";
  provider: string;
  wireModelId: string;
  billing: "subscription" | "api" | "local";
  supportedEfforts?: string[];
}

const NON_CODING_RE =
  /(?:^|[-_/])(image|tts|audio|realtime|transcribe|whisper|embedding|embed|moderation|robotics|lyria|veo|sora|deep-research|live)(?:$|[-_/])/i;

const SNAPSHOT_RE = /-(20\d{2}(?:-\d{2}-\d{2}|\d{4}))$/;

export function isCodingEligible(c: CandidateModel): boolean {
  if (c.deprecated) return false;
  if (c.toolCall === false) return false;
  if (NON_CODING_RE.test(c.wireModelId) || NON_CODING_RE.test(c.canonicalId)) return false;
  if (c.modalities?.output && !c.modalities.output.includes("text")) return false;
  return true;
}

export function stripSnapshotAndRouting(id: string): { base: string; isSnapshot: boolean; isPreview: boolean; isLatestAlias: boolean } {
  const noRoute = stripRoutingSuffix(id);
  const isSnapshot = SNAPSHOT_RE.test(noRoute);
  const noSnap = noRoute.replace(SNAPSHOT_RE, "");
  const isPreview = /(?:^|[-_])(preview|beta|alpha|exp)(?:$|[-_])/i.test(noSnap);
  const isLatestAlias = /-latest$/i.test(noSnap);
  return { base: noSnap, isSnapshot, isPreview, isLatestAlias };
}

// Only a version in a known product's release position identifies a generation.
// Keep all other tokens, including parameter counts and distinct product variants.
const versionPatterns: ReadonlyMap<string, RegExp> = new Map([
  ["openai", /^(gpt-)(\d+(?:\.\d+)*)(?=-|$)/],
  ["anthropic", /^(claude-(?:opus|sonnet|haiku|fable)-)(\d+(?:[.-]\d+){0,2})(?=-|$)/],
  ["google", /^(gemini-)(\d+(?:\.\d+)*)(?=-|$)/],
  ["xai", /^(grok-)(\d+(?:\.\d+)*)(?=-|$)/],
  ["zai", /^(glm-)(\d+(?:\.\d+)*)(?=-|$)/],
  ["alibaba", /^(qwen-?)(\d+(?:\.\d+)*)(?=-|$)/],
  ["qwen", /^(qwen-?)(\d+(?:\.\d+)*)(?=-|$)/],
  ["deepseek", /^(deepseek-v)(\d+(?:\.\d+)*)(?=-|$)/],
  ["moonshotai", /^(kimi-k)(\d+(?:\.\d+)*)(?=-|$)/],
  ["meta", /^(muse-(?:wonder|spark)-)(\d+(?:\.\d+)*)(?=-|$)/],
]);

function release(id: string) {
  const info = stripSnapshotAndRouting(id);
  const slash = info.base.indexOf("/");
  const creator = info.base.slice(0, slash);
  const bare = info.base.slice(slash + 1);
  const pattern = versionPatterns.get(creator);
  const match = pattern?.exec(bare);
  const product = match
    ? (match[1]!.replace(/-$/, "") + bare.slice(match[0].length)).replace(/-(?:preview|beta|alpha|exp|latest)$/, "")
    : bare;
  return {
    ...info,
    key: creator + "/" + product,
    version: match ? match[2]!.split(/[.-]/).map(Number) : [],
    snapshotDate: id.match(SNAPSHOT_RE)?.[1]?.replaceAll("-", "") ?? "",
  };
}

export function computeRefinedFamilyKey(creator: string, modelId: string, _rawFamily?: string): string {
  const id = modelId.startsWith(creator + "/") ? modelId : creator + "/" + modelId;
  return release(id).key;
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

export interface DeduplicateOptions {
  allowPreview?: boolean;
  /** @deprecated Ignored for pruning — deduplication operates strictly over actually available candidates. */
  upstreamModelIds?: Iterable<string>;
}

function hasAvailableSuccessor(
  candidate: CandidateModel,
  availableCanonicalIds: Set<string>,
  availableBareIds: Set<string>,
): boolean {
  if (candidate.successorModel) {
    const normSucc = candidate.successorModel.toLowerCase();
    const bareSucc = normSucc.includes("/") ? normSucc.slice(normSucc.indexOf("/") + 1) : normSucc;
    if (availableCanonicalIds.has(normSucc) || availableBareIds.has(bareSucc)) {
      return true;
    }
  }
  const start = candidate.canonicalId.toLowerCase();
  const visited = new Set<string>([start]);
  let next = vendorSuccessors.get(candidate.canonicalId) ?? vendorSuccessors.get(start);
  while (next) {
    const normNext = next.toLowerCase();
    if (visited.has(normNext)) break;
    if (availableCanonicalIds.has(normNext)) return true;
    visited.add(normNext);
    next = vendorSuccessors.get(next) ?? vendorSuccessors.get(normNext);
  }
  return false;
}

export function selectLatestPerFamily(candidates: CandidateModel[], opts?: DeduplicateOptions): CandidateModel[] {
  const eligible: Array<{ model: CandidateModel; info: ReturnType<typeof release> }> = [];
  for (const candidate of candidates) {
    if (!isCodingEligible(candidate)) continue;
    const info = release(candidate.canonicalId);
    if (opts?.allowPreview === false && info.isPreview) continue;

    // https://openrouter.ai/docs/guides/routing/model-variants/extended
    const routes = candidate.routes.filter(r => !(r.provider === "openrouter" && /:extended$/i.test(r.wireModelId)));
    if (!routes.length && candidate.routes.length) continue;
    const model = routes.length === candidate.routes.length ? candidate : { ...candidate, routes };
    eligible.push({ model, info });
  }

  // Only drop a superseded model when its successor is actually available among the user's candidates.
  const availableCanonicalIds = new Set(eligible.map(({ model }) => model.canonicalId.toLowerCase()));
  const availableBareIds = new Set(
    eligible.map(({ model }) => {
      const id = model.canonicalId.toLowerCase();
      return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    }),
  );

  const byFamily = new Map<string, { model: CandidateModel; info: ReturnType<typeof release> }>();
  for (const { model, info } of eligible) {
    if (hasAvailableSuccessor(model, availableCanonicalIds, availableBareIds)) continue;
    const current = byFamily.get(info.key);
    if (current) {
      const other = current.info;
      const order = compareVersions(info.version, other.version)
        || Number(other.isPreview) - Number(info.isPreview)
        || Number(other.isSnapshot) - Number(info.isSnapshot)
        || Number(other.isLatestAlias) - Number(info.isLatestAlias)
        || info.snapshotDate.localeCompare(other.snapshotDate)
        || (model.releaseDate ?? "").localeCompare(current.model.releaseDate ?? "")
        || model.canonicalId.localeCompare(current.model.canonicalId);
      if (order <= 0) continue;
    }
    byFamily.set(info.key, { model, info });
  }

  // A meta alias is a fallback for profiles without a concrete eligible release.
  const winners = [...byFamily.values()].map(entry => entry.model);
  const isAlias = (c: CandidateModel) => /^(?:auto|default)$/i.test(c.wireModelId);
  const concreteProfiles = new Set(winners.filter(c => !isAlias(c)).flatMap(c => c.routes.map(r => r.profileId)));
  return winners.flatMap(c => {
    if (!isAlias(c)) return [c];
    const routes = c.routes.filter(r => !concreteProfiles.has(r.profileId));
    return routes.length ? [{ ...c, routes }] : [];
  });
}
