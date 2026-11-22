# Model catalog ranking

The CLI, model picker, and automatic selection use the same catalog order. The compiler ranks eligible models by the latest comparable Vals Terminal-Bench 4.0 snapshot. Equal percentages share a rank, with canonical IDs breaking display ties. Eligible models without a measurement follow in ID order with both rank and score set to `null`.

## Before and after

The before column comes from a local schema 4 catalog at `174fbc6`, synced at `2026-11-22T03:19:56.550Z`. The after column comes from replaying its recorded preferred and alternate routes on schema 5 at `69e0ea92` with captured metadata and the November 19 benchmark. Of 22 eligible models, 19 had comparable measurements. These counts describe that inventory capture. A live probe can return different routes.

| Model ID in schema 4 | Before rank / score | Before source | After rank / score |
| --- | ---: | --- | ---: |
| `openai/gpt-5.5` | 1 / 82.6 | vals_swebench | excluded |
| `openai/gpt-5.3-codex` | 2 / 78 | vals_swebench | excluded |
| `google/gemini-3.5-flash-lite` | 3 / 75 | vals_swebench | null / null |
| `anthropic/claude-fable-5-2` | 4 / 65.2 | vals_tb4 | 1 / 65.152 |
| `anthropic/claude-opus-5-5` | 5 / 65.2 | vals_tb4 | 1 / 65.152 |
| `anthropic/claude-sonnet-5-5` | 6 / 64.1 | vals_tb4 | 3 / 64.141 |
| `google/gemini-4-carbon` | 7 / 63.1 | vals_tb4 | 4 / 63.131 |
| `openai/gpt-6.2-astra` | 8 / 63.1 | vals_tb4 | 4 / 63.131 |
| `google/gemini-4-neon` | 9 / 61.2 | harbor_tb4 | 6 / 61.616 |
| `openai/gpt-6.2-sol` | 11 / 60.6 | vals_tb4 | 7 / 60.606 |
| `generic/eb1-frontier-preview` | 28 / null | none | null / null as `keiro/eb1-frontier-preview` |

Set `BASELINE` to an archived copy of the schema 4 catalog to inspect the original rows.

```sh
jq -c 'select(.schemaVersion == 4 and .syncedAt == "2026-11-22T03:19:56.550Z")
  | .models[] | select(.codingRank <= 9 or .codingRank == 11 or .codingRank == 28)
  | [.id,.codingRank,.codingScore,.scoreSource]' "$BASELINE"
```

OpenAI documents migration from GPT-5.5 to the Sol line. Its October 14 retirement applied to ChatGPT-authenticated Codex, while API access continued. OpenAI deprecated GPT-5.3-Codex on October 1 and names GPT-6-Sol as its replacement. The catalog excludes both predecessors. Google still lists Gemini 3.5 Flash-Lite as a low-cost choice alongside newer tiers. It remains eligible and lacks a comparable observation. [GPT-5.5 migration](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.6), [Codex retirement](https://developers.openai.com/codex/models#gpt-55-retirement), [API deprecations](https://developers.openai.com/api/docs/deprecations), [Google model choices](https://aistudio.google.com/docs/choosing-a-model#upgrade-paths)

## Score and source

Vals reports overall accuracy using Mini-SWE-agent on 66 tasks, with an eight-hour task limit and three independent pass@1 runs at each model's published effort. Fable at high effort and Opus at max each scored 129 successes across 198 attempts. Their score is `100 × 129 / 198 = 65.152%` rounded to three decimal places. The compiler uses the published percentage directly. The page identifies the artifact key `google/cobalt-c-high-1p00` as Gemini 4 Neon at xhigh effort. Its 61.616% replaces the old Harbor 4.1 score from a different protocol. [Vals leaderboard and protocol](https://www.vals.ai/benchmarks/terminal-bench-4)

The Vals artifact has revision `CCNUYuKP`, SHA-256 `9f277bf01e62eef919744c0948ee5215bf49a086d3c69726e2c49d9fdf2edbdb`, and coverage date `2026-11-19` in `metadata.updated`. Vals provides no per-run dates. The source reader accepted 53 of 70 overall rows after checking protocol, identity, effort, and displayed accuracy. The former SWE-bench source, revision `CWeqA8t7` dated `2026-09-01`, measured a different task set. [Terminal-Bench artifact](https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.CCNUYuKP.json), [SWE-bench artifact](https://www.vals.ai/_astro/benchmark_view_swebench.CWeqA8t7.json)

## Replay the comparison offline

Run this block from the checkout with Bun and the project's dependencies installed. It passes the table's routes and the seven measured rows directly to the shared compiler. To exercise the source reader too, set `VALS_HTML` and `VALS_JSON` to local copies of the matching page and artifact. Both modes run in memory without probing profiles, fetching from the network, or writing a cache.

```sh
bun - <<'JS'
import {setSystemTime} from "bun:test";
import {ModelCatalogCompiler} from "./src/catalog/compiler.ts";
import {RANKING_COHORT as cohort, fetchValsAiBenchmarks} from "./src/catalog/sources.ts";

const revision = "https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.CCNUYuKP.json";
const evidence = {...cohort, asOf: "2026-11-19", revision};
const measured = [
  ["anthropic/claude-fable-5-2", 65.152, "high"],
  ["anthropic/claude-opus-5-5", 65.152, "max"],
  ["anthropic/claude-sonnet-5-5", 64.141, "max"],
  ["google/gemini-4-carbon", 63.131, "high"],
  ["openai/gpt-6.2-astra", 63.131, "max"],
  ["google/gemini-4-neon", 61.616, "xhigh", "google/cobalt-c-high-1p00"],
  ["openai/gpt-6.2-sol", 60.606, "max"],
];
let observations = measured.map(([canonicalKeyHint, codingScore, effort, raw = canonicalKeyHint]) =>
  ({source: cohort.source, canonicalKeyHint, codingScore, effort, rawModelName: raw, evidence}));
const {VALS_HTML, VALS_JSON} = process.env;
if (VALS_HTML || VALS_JSON) {
  if (!VALS_HTML || !VALS_JSON) throw Error("Supply both Vals files");
  const hash = new Bun.CryptoHasher("sha256").update(await Bun.file(VALS_JSON).arrayBuffer()).digest("hex");
  if (hash !== "9f277bf01e62eef919744c0948ee5215bf49a086d3c69726e2c49d9fdf2edbdb") {
    throw Error("Vals JSON differs from the recorded revision");
  }
  const files = new Map([[cohort.sourceUrl, VALS_HTML], [revision, VALS_JSON]]);
  globalThis.fetch = async url => new Response(await Bun.file(files.get(String(url))).text());
  observations = await fetchValsAiBenchmarks();
  if (observations.length !== 53) throw Error("Expected 53 observations in the November 19 capture");
}

const amp = {id: "acp:amp", kind: "acp", adapter: "generic", billing: "subscription"};
const codex = {...amp, id: "acp:codex", adapter: "codex"};
const profiles = [amp, codex];
const compiler = new ModelCatalogCompiler({profiles, catalog: {ttlHours: 24, allowPreview: true}});
const wires = ids => ids.map(wireModelId => ({wireModelId}));
const inventory = new Map([
  [codex.id, wires(["gpt-6.2-astra", "gpt-6.2-sol"])],
  [amp.id, wires(["anthropic/claude-fable-5-2", "anthropic/claude-opus-5-5",
    "anthropic/claude-sonnet-5-5", "google-vertex/gemini-4-carbon", "google-vertex/gemini-4-neon",
    "google-vertex/gemini-3.5-flash-lite", "keiro/eb1-frontier-preview", "openai/gpt-5.5",
    "openai/gpt-5.3-codex"])],
]);
const compile = benchmarks => compiler.compileFromData({enabledProfiles: profiles, inventory,
  benchmarks, sources: ["vals_ai"], modelsDev: [], openRouter: [], litellmDep: new Map()});
const counts = catalog => [catalog.models.length, catalog.models.filter(m => m.codingRank !== null).length];

// Cross the source's 30-day limit with a cache that is only one minute old.
setSystemTime(new Date("2026-12-18T23:59:00Z"));
const fresh = compile(observations);
for (const m of fresh.models) console.log(JSON.stringify([m.id, m.codingRank, m.codingScore]));
console.log("cache before expiry", compiler.isCacheFresh(fresh));
setSystemTime(new Date("2026-12-19T00:00:00Z"));
console.log("cache at expiry", compiler.isCacheFresh(fresh));
for (const [label, rows] of [["same payload", observations], ["empty feed", []]]) {
  console.log(label, ...counts(compile(rows)));
}
JS
```

The first nine output rows match the after column in rank order, including Flash-Lite and EB1 with two nulls each. The compiler excludes both GPT predecessors. The last two lines show eligible and ranked counts for each new compilation.

```text
cache before expiry true
cache at expiry false
same payload 9 0
empty feed 9 0
```

In the full 22-model replay, empty observations and year-old observations each yielded 22 eligible models and zero ranked models. The cache checks the original evidence date even within its configured TTL. Recompiling the same expired observation preserves the eligible routes and gives each a null score and rank.
