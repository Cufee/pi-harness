/**
 * Deterministic "latest-per-family" model deduplication & lineage normalization.
 * Solves real Nov 2026 catalog edge cases:
 *  - Filters non-chat/non-tool models (`gpt-image`, `tts`, `realtime`, `deep-research`, `embedding`)
 *  - Preserves distinct parallel tiers even when `models.dev` lumps them under a coarse family
 *    (e.g. `gemini-4-argon` / `carbon` / `hydrogen` / `neon`, `gpt-codex` vs `gpt-sol` vs `gpt-astra`)
 *  - Strips dated snapshots (`-20260901`, `-2026-03-05`), `:batch`/`:free`, and effort suffixes
 *  - Ranks strictly by `(notDeprecated, notSuperseded, GA > preview at same semver, semver DESC, releaseDate DESC)`
 */

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

const SNAPSHOT_RE = /-(?:20\d{2}-?\d{2}-?\d{2}|20\d{6})$/;
const ROUTE_SUFFIX_RE = /(?:[:](?:free|batch|extended|exacto|nitro|floor)|@default)$/i;

export function isCodingEligible(c: CandidateModel): boolean {
  if (c.deprecated) return false;
  if (c.toolCall === false) return false;
  if (NON_CODING_RE.test(c.wireModelId) || NON_CODING_RE.test(c.canonicalId)) return false;
  if (c.modalities?.output && !c.modalities.output.includes("text")) return false;
  return true;
}

export function stripSnapshotAndRouting(id: string): { base: string; isSnapshot: boolean; isPreview: boolean; isLatestAlias: boolean } {
  const noRoute = id.replace(ROUTE_SUFFIX_RE, "");
  const isSnapshot = SNAPSHOT_RE.test(noRoute);
  const noSnap = noRoute.replace(SNAPSHOT_RE, "");
  const isPreview = /(?:^|[-_])(preview|beta|alpha|exp)(?:$|[-_])/i.test(noSnap);
  const isLatestAlias = /-latest$/i.test(noSnap);
  return { base: noSnap, isSnapshot, isPreview, isLatestAlias };
}

/**
 * Extracts a comparable semver tuple from model IDs like:
 *  - `claude-opus-5-5` -> [5, 5, 0]
 *  - `gpt-6.2-astra` -> [6, 2, 0]
 *  - `gemini-3.8-flash` -> [3, 8, 0]
 *  - `o3-mini` -> [3, 0, 0]
 */
export function extractVersionTuple(id: string): [number, number, number] {
  const { base } = stripSnapshotAndRouting(id.toLowerCase());
  // Match `5.5`, `6.2`, `4-6`, `5-5`, `3.1`
  const dotted = base.match(/(?:^|[-_/])(\d+)\.(\d+)(?:\.(\d+))?(?:$|[-_/])/);
  if (dotted) {
    return [Number(dotted[1]), Number(dotted[2]), Number(dotted[3] ?? 0)];
  }
  const hyphenated = base.match(/(?:^|[-_/])(\d+)-(\d+)(?:-(\d+))?(?:$|[-_/])/);
  if (hyphenated) {
    return [Number(hyphenated[1]), Number(hyphenated[2]), Number(hyphenated[3] ?? 0)];
  }
  const single = base.match(/(?:^|[-_/a-z])(\d+)(?:$|[-_/])/);
  if (single) {
    return [Number(single[1]), 0, 0];
  }
  return [0, 0, 0];
}

export function compareVersionTuples(a: [number, number, number], b: [number, number, number]): number {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

/**
 * Computes a refined `(creator, family_tier)` deduplication bucket that preserves
 * distinct capability tiers (Opus vs Sonnet vs Haiku, Codex vs Sol vs Astra vs Mini,
 * Gemini Pro vs Flash vs Flash-Lite vs Gemini 4 Neon/Argon/Carbon/Hydrogen)
 * while collapsing generational versions (`Opus 5.5` over `Opus 5`, `Astra 6.2` over `Astra 6`).
 */
export function computeRefinedFamilyKey(creator: string, modelId: string, rawFamily?: string): string {
  const normCreator = creator.toLowerCase().trim();
  const { base } = stripSnapshotAndRouting(modelId.toLowerCase());
  const bare = base.includes("/") ? base.slice(base.lastIndexOf("/") + 1) : base;

  // Preserve distinct Gemini 4 codenames that models.dev lumps under `"gemini"`
  const geminiCodename = bare.match(/\bgemini-[\d.]+-(argon|carbon|hydrogen|neon)\b/);
  if (geminiCodename) {
    return `${normCreator}/gemini-${geminiCodename[1]}`;
  }

  // Strip version numbers, `-preview`/`-beta`/`-exp`/`-latest`/`-fast`/`-thinking` to isolate the lineage
  const stripped = bare
    .replace(/(?:^|[-_])(preview|beta|alpha|exp|latest|fast|thinking|reasoning|customtools)(?=$|[-_])/g, "")
    .replace(/-\d+(?:[.-]\d+)*(?=$|-)/g, "")
    .replace(/\d+(?:\.\d+)+/g, "")
    .replace(/--+/g, "-")
    .replace(/^-|-$/g, "");

  if (stripped && stripped.length >= 2) {
    return `${normCreator}/${stripped}`;
  }
  return `${normCreator}/${(rawFamily ?? bare).toLowerCase()}`;
}

export interface DeduplicateOptions {
  allowPreview?: boolean;
}

export function selectLatestPerFamily(candidates: CandidateModel[], opts?: DeduplicateOptions): CandidateModel[] {
  const allowPreview = opts?.allowPreview ?? true;
  const rawEligible = candidates.filter(isCodingEligible);

  // Drop generic meta-aliases (`default`, `auto`) when a profile already exposes concrete models
  const profilesWithConcrete = new Set<string>();
  for (const c of rawEligible) {
    const bare = c.wireModelId.toLowerCase().split("/").pop() ?? "";
    if (bare !== "default" && bare !== "auto") {
      for (const r of c.routes) profilesWithConcrete.add(r.profileId);
    }
  }
  const eligible = rawEligible.filter((c) => {
    const bare = c.wireModelId.toLowerCase().split("/").pop() ?? "";
    if (bare !== "default" && bare !== "auto") return true;
    return c.routes.some((r) => !profilesWithConcrete.has(r.profileId));
  });

  // Build set of explicitly superseded IDs (via LiteLLM `successorModel`)
  const supersededIds = new Set<string>();
  const eligibleIds = new Set(eligible.map((c) => c.wireModelId.toLowerCase()));
  for (const c of eligible) {
    if (c.successorModel && eligibleIds.has(c.successorModel.toLowerCase())) {
      supersededIds.add(c.wireModelId.toLowerCase());
    }
  }

  const byFamily = new Map<string, CandidateModel[]>();
  for (const c of eligible) {
    if (supersededIds.has(c.wireModelId.toLowerCase())) continue;
    const info = stripSnapshotAndRouting(c.wireModelId);
    if (!allowPreview && info.isPreview) continue;
    const key = computeRefinedFamilyKey(c.creator, c.wireModelId, c.rawFamily);
    const list = byFamily.get(key) ?? [];
    list.push(c);
    byFamily.set(key, list);
  }

  const winners: CandidateModel[] = [];
  for (const group of byFamily.values()) {
    group.sort((a, b) => {
      const va = extractVersionTuple(a.wireModelId);
      const vb = extractVersionTuple(b.wireModelId);
      const verCmp = compareVersionTuples(vb, va);
      if (verCmp !== 0) return verCmp;

      const ia = stripSnapshotAndRouting(a.wireModelId);
      const ib = stripSnapshotAndRouting(b.wireModelId);
      // At the exact same semver: GA beats preview, undated beats snapshot, pinned beats `-latest`
      if (ia.isPreview !== ib.isPreview) return ia.isPreview ? 1 : -1;
      if (ia.isSnapshot !== ib.isSnapshot) return ia.isSnapshot ? 1 : -1;
      if (ia.isLatestAlias !== ib.isLatestAlias) return ia.isLatestAlias ? 1 : -1;

      const da = a.releaseDate ?? "";
      const db = b.releaseDate ?? "";
      if (da !== db) return db.localeCompare(da);

      return (b.codingScore ?? -1) - (a.codingScore ?? -1);
    });

    const winner = group[0]!;
    // Merge routes from exact same-version aliases (e.g. dated snapshot or API + subscription route)
    const winnerVer = extractVersionTuple(winner.wireModelId);
    const mergedRoutes = [...winner.routes];
    const seenRouteKeys = new Set(mergedRoutes.map((r) => `${r.profileId}:${r.wireModelId}`));
    for (const peer of group.slice(1)) {
      if (compareVersionTuples(extractVersionTuple(peer.wireModelId), winnerVer) === 0) {
        for (const r of peer.routes) {
          const rk = `${r.profileId}:${r.wireModelId}`;
          if (!seenRouteKeys.has(rk)) {
            seenRouteKeys.add(rk);
            mergedRoutes.push(r);
          }
        }
      }
    }
    winners.push({ ...winner, routes: mergedRoutes });
  }

  // Rank winners by codingScore DESC, then version/name
  winners.sort((a, b) => (b.codingScore ?? -1) - (a.codingScore ?? -1) || a.canonicalId.localeCompare(b.canonicalId));
  return winners;
}
