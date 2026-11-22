import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { buildMatchKeys, ModelCatalogCompiler, recommendModelsByTaskKind } from "../src/catalog/compiler.js";
import { selectLatestPerFamily, type CandidateModel } from "../src/catalog/deduplicate.js";
import { RANKING_COHORT } from "../src/catalog/sources.js";
import { loadConfig, type RunnerProfileConfig } from "../src/config.js";
import {
  AvailabilityStatus,
  BucketBindingSchema,
  DataConfidence,
  ModelCapacitySchema,
  OveragePolicySchema,
  QuotaBucketSchema,
  QuotaSnapshotSchema,
  QuotaStatus,
  QuotaWindowSchema,
  type QuotaBucket,
} from "../src/gen/quota_pb.js";
import { isQuotaUnavailable, QuotaClient } from "../src/quota/client.js";
import { resolveModelCapacity } from "../src/quota/schema.js";

describe("Latest-Per-Family Model Deduplication & Generated-Proto Multi-Bucket Quota Resolution", () => {
  it("keeps only latest generation per family while preserving distinct tiers and Gemini 4 codenames", () => {
    const make = (creator: string, wireModelId: string, extra?: Partial<CandidateModel>): CandidateModel => ({
      canonicalId: `${creator}/${wireModelId}`,
      creator,
      wireModelId,
      name: wireModelId,
      toolCall: true,
      routes: [{ profileId: "acp:test", runner: "acp", provider: creator, wireModelId, billing: "subscription" }],
      ...extra,
    });

    const input: CandidateModel[] = [
      make("anthropic", "claude-opus-4-6", { rawFamily: "claude-opus", codingScore: 60 }),
      make("anthropic", "claude-opus-5", { rawFamily: "claude-opus", codingScore: 63 }),
      make("anthropic", "claude-opus-5-5", { rawFamily: "claude-opus", codingScore: 68 }),
      make("anthropic", "claude-sonnet-5-5", { rawFamily: "claude-sonnet", codingScore: 64 }),
      make("openai", "gpt-6-astra", { rawFamily: "gpt-astra", codingScore: 62 }),
      make("openai", "gpt-6.2-astra", { rawFamily: "gpt-astra", codingScore: 70 }),
      make("openai", "gpt-image-2", { rawFamily: "gpt-image" }),
      make("google", "gemini-4-neon", { rawFamily: "gemini", codingScore: 66 }),
      make("google", "gemini-4-argon", { rawFamily: "gemini", codingScore: 58 }),
      make("google", "gemini-4-carbon", { rawFamily: "gemini", codingScore: 61 }),
      make("google", "gemini-3.8-flash", { rawFamily: "gemini-flash", codingScore: 55 }),
      make("google", "gemini-3.5-flash", { rawFamily: "gemini-flash", codingScore: 50 }),
    ];

    const winners = selectLatestPerFamily(input).map((w) => w.wireModelId);
    assert.ok(winners.includes("claude-opus-5-5"));
    assert.ok(!winners.includes("claude-opus-5"));
    assert.ok(!winners.includes("claude-opus-4-6"));
    assert.ok(winners.includes("claude-sonnet-5-5"));
    assert.ok(winners.includes("gpt-6.2-astra"));
    assert.ok(!winners.includes("gpt-6-astra"));
    assert.ok(!winners.includes("gpt-image-2"));
    assert.ok(winners.includes("gemini-4-neon"));
    assert.ok(winners.includes("gemini-4-argon"));
    assert.ok(winners.includes("gemini-4-carbon"));
    // gemini-3.8-flash is kept when its vendor successor (gemini-4-hydrogen) is NOT available locally
    assert.ok(winners.includes("gemini-3.8-flash"));
    assert.ok(!winners.includes("gemini-3.5-flash"));

    // Once gemini-4-hydrogen IS present in candidates, gemini-3.8-flash IS superseded and dropped
    const withSuccessor = selectLatestPerFamily([
      ...input,
      make("google", "gemini-4-hydrogen", { rawFamily: "gemini", codingScore: 60 }),
    ]).map((w) => w.wireModelId);
    assert.ok(withSuccessor.includes("gemini-4-hydrogen"));
    assert.ok(!withSuccessor.includes("gemini-3.8-flash"));
  });

  it("resolves separate Antigravity Gemini vs Opus 5.5 buckets, Claude shared∩scoped gates, and Copilot multipliers using generated proto messages", () => {
    const t1 = Date.now() + 3_600_000;
    const t2 = Date.now() + 86_400_000;
    const future1 = timestampFromMs(t1);
    const future2 = timestampFromMs(t2);

    const buckets = new Map<string, QuotaBucket>([
      [
        "agy:ultra:gemini",
        create(QuotaBucketSchema, {
          bucketId: "agy:ultra:gemini",
          provider: "antigravity",
          windows: [create(QuotaWindowSchema, { windowId: "five_hour", remainingRatio: 0.85, resetAt: future1, binding: true })],
        }),
      ],
      [
        "agy:ultra:claude-gpt",
        create(QuotaBucketSchema, {
          bucketId: "agy:ultra:claude-gpt",
          provider: "antigravity",
          windows: [
            create(QuotaWindowSchema, {
              windowId: "five_hour",
              remainingRatio: 0.0,
              usedPercent: 100,
              resetAt: future1,
              status: QuotaStatus.EXHAUSTED,
            }),
          ],
        }),
      ],
      [
        "claude:max:all",
        create(QuotaBucketSchema, {
          bucketId: "claude:max:all",
          provider: "claude",
          windows: [
            create(QuotaWindowSchema, { windowId: "five_hour", usedPercent: 30, resetAt: future1 }),
            create(QuotaWindowSchema, { windowId: "seven_day", usedPercent: 55, resetAt: future2 }),
          ],
        }),
      ],
      [
        "claude:max:opus",
        create(QuotaBucketSchema, {
          bucketId: "claude:max:opus",
          provider: "claude",
          windows: [
            create(QuotaWindowSchema, {
              windowId: "seven_day_opus",
              usedPercent: 100,
              resetAt: future2,
              status: QuotaStatus.EXHAUSTED,
            }),
          ],
          overage: create(OveragePolicySchema, { enabled: true, status: QuotaStatus.AVAILABLE }),
        }),
      ],
      [
        "copilot:pro:premium",
        create(QuotaBucketSchema, {
          bucketId: "copilot:pro:premium",
          provider: "copilot",
          windows: [
            create(QuotaWindowSchema, {
              windowId: "monthly",
              limit: 300,
              used: 270,
              remaining: 30,
              usedPercent: 90,
              resetAt: future2,
            }),
          ],
        }),
      ],
    ]);

    const agyGemini = resolveModelCapacity(
      create(ModelCapacitySchema, {
        provider: "antigravity",
        modelId: "gemini-4-neon",
        bucketBindings: [create(BucketBindingSchema, { bucketId: "agy:ultra:gemini", required: true })],
      }),
      buckets,
    );
    const agyOpus = resolveModelCapacity(
      create(ModelCapacitySchema, {
        provider: "antigravity",
        modelId: "claude-opus-5-5",
        bucketBindings: [create(BucketBindingSchema, { bucketId: "agy:ultra:claude-gpt", required: true })],
      }),
      buckets,
    );
    assert.equal(agyGemini.availability, AvailabilityStatus.READY);
    assert.equal(agyGemini.exhausted, false);
    assert.equal(agyOpus.availability, AvailabilityStatus.EXHAUSTED);
    assert.equal(agyOpus.exhausted, true);
    assert.equal(agyOpus.nextAvailableAt, new Date(t1).toISOString());

    const claudeOpus = resolveModelCapacity(
      create(ModelCapacitySchema, {
        provider: "claude",
        modelId: "claude-opus-5-5",
        bucketBindings: [
          create(BucketBindingSchema, { bucketId: "claude:max:all", required: true }),
          create(BucketBindingSchema, { bucketId: "claude:max:opus", required: true }),
        ],
      }),
      buckets,
    );
    assert.equal(claudeOpus.availability, AvailabilityStatus.DEGRADED);
    assert.equal(claudeOpus.overageActive, true);
    assert.equal(claudeOpus.exhausted, false);

    const copilotFree = resolveModelCapacity(
      create(ModelCapacitySchema, {
        provider: "copilot",
        modelId: "gpt-4.1",
        bucketBindings: [create(BucketBindingSchema, { bucketId: "copilot:pro:premium", multiplier: 0, required: false })],
      }),
      buckets,
    );
    const copilotOpus = resolveModelCapacity(
      create(ModelCapacitySchema, {
        provider: "copilot",
        modelId: "claude-opus-5-5",
        bucketBindings: [create(BucketBindingSchema, { bucketId: "copilot:pro:premium", multiplier: 3, required: true })],
      }),
      buckets,
    );
    assert.equal(copilotFree.availability, AvailabilityStatus.READY);
    assert.equal(copilotOpus.estimatedRequestsRemaining, 10);
  });

  it("fetches both ProtoJSON and binary Protobuf from user-configured Quota Endpoint and surfaces live quota in catalog", async () => {
    const future = timestampFromMs(Date.now() + 7_200_000);
    const snapshot = create(QuotaSnapshotSchema, {
      schemaVersion: "1",
      generatedAt: timestampFromMs(Date.now()),
      ttlSeconds: 60,
      buckets: [
        create(QuotaBucketSchema, {
          bucketId: "agy:claude-gpt",
          provider: "gemini",
          windows: [
            create(QuotaWindowSchema, {
              windowId: "five_hour",
              remainingRatio: 0.0,
              usedPercent: 100,
              resetAt: future,
              status: QuotaStatus.EXHAUSTED,
            }),
          ],
        }),
        create(QuotaBucketSchema, {
          bucketId: "agy:gemini",
          provider: "gemini",
          windows: [
            create(QuotaWindowSchema, {
              windowId: "five_hour",
              remainingRatio: 0.9,
              usedPercent: 10,
              resetAt: future,
              status: QuotaStatus.AVAILABLE,
            }),
          ],
        }),
      ],
      models: [
        create(ModelCapacitySchema, {
          profile: "acp:gemini",
          provider: "gemini",
          modelId: "claude-opus-5-5",
          bucketBindings: [create(BucketBindingSchema, { bucketId: "agy:claude-gpt", required: true })],
        }),
        create(ModelCapacitySchema, {
          profile: "acp:gemini",
          provider: "gemini",
          modelId: "gemini-4-neon",
          bucketBindings: [create(BucketBindingSchema, { bucketId: "agy:gemini", required: true })],
        }),
      ],
    });

    const server = createServer((req, res) => {
      if (req.url === "/v1/quota.pb") {
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        res.end(Buffer.from(toBinary(QuotaSnapshotSchema, snapshot)));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(toJsonString(QuotaSnapshotSchema, snapshot));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };

    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-cat-"));
    try {
      const profiles: RunnerProfileConfig[] = [
        {
          id: "acp:gemini",
          kind: "acp",
          adapter: "gemini",
          command: "gemini",
          args: ["--acp"],
          billing: "subscription",
          enabled: true,
        },
      ];
      const config = {
        ...loadConfig(),
        stateDir,
        profiles,
        quotaEndpoint: { url: `http://127.0.0.1:${addr.port}/v1/quota`, pollIntervalSec: 60 },
      };

      // Verify ProtoJSON endpoint
      const quotaClient = new QuotaClient(config.quotaEndpoint);
      await quotaClient.sync(true);

      // Verify binary Protobuf endpoint
      const binaryClient = new QuotaClient({
        url: `http://127.0.0.1:${addr.port}/v1/quota.pb`,
        format: "protobuf",
      });
      const binSnap = await binaryClient.sync(true);
      assert.equal(binSnap?.buckets.length, 2);

      const compiler = new ModelCatalogCompiler(config, quotaClient);
      const compiled = compiler.compileFromData({
        enabledProfiles: profiles,
        inventory: new Map([
          [
            "acp:gemini",
            [
              { wireModelId: "claude-opus-5-5" },
              { wireModelId: "claude-opus-5" },
              { wireModelId: "gemini-4-neon" },
            ],
          ],
        ]),
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [
          { source: "harbor_tb4", rawModelName: "claude-opus-5-5", codingScore: 68, costPerTaskUsd: 11.2, timePerTaskSeconds: 2400 },
          { source: "harbor_tb4", rawModelName: "gemini-4-neon", codingScore: 66, costPerTaskUsd: 4.5, timePerTaskSeconds: 900 },
        ],
        sources: ["harbor_tb4"],
      });

      writeFileSync(compiler.cachePath, JSON.stringify(compiled), "utf8");

      const live = await compiler.getCatalog({ excludeExhausted: false });
      assert.equal(live.models.length, 2);

      const opus = live.models.find((m) => m.id === "anthropic/claude-opus-5-5")!;
      const neon = live.models.find((m) => m.id === "google/gemini-4-neon")!;
      assert.equal(opus.quota?.exhausted, true);
      assert.equal(opus.quota?.bindingBucketId, "agy:claude-gpt");
      assert.equal(opus.costPerTaskUsd, 0);
      assert.equal(opus.apiEquivCostUsd, 11.2);
      assert.equal(neon.quota?.exhausted, false);
      assert.equal(neon.quota?.bindingBucketId, "agy:gemini");

      const filtered = await compiler.getCatalog({ excludeExhausted: true });
      assert.equal(filtered.models.length, 1);
      assert.equal(filtered.models[0]?.id, "google/gemini-4-neon");

      // Verify Harbor short-name matching ("Opus 5.5" <-> "anthropic/claude-opus-5-5" and "6.2" <-> "6-2")
      const opusKeys = new Set(buildMatchKeys("anthropic/claude-opus-5-5"));
      assert.ok(buildMatchKeys("Opus 5.5 (Max)").some((k) => opusKeys.has(k)));
      const astraKeys = new Set(buildMatchKeys("openai/gpt-6.2-astra"));
      assert.ok(buildMatchKeys("GPT-6-2-Astra (High)").some((k) => astraKeys.has(k)));
    } finally {
      server.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("resolveResumeSchedule does NOT return availableNow on partial endpoint coverage and honors unmatched passive resetAt", async () => {
    const future = timestampFromMs(Date.now() + 3_600_000);
    const snapshot = create(QuotaSnapshotSchema, {
      schemaVersion: "1",
      generatedAt: timestampFromMs(Date.now()),
      ttlSeconds: 60,
      buckets: [
        create(QuotaBucketSchema, {
          bucketId: "claude:5h",
          provider: "claude",
          windows: [
            create(QuotaWindowSchema, {
              windowId: "five_hour",
              remainingRatio: 0.9,
              usedPercent: 10,
              resetAt: future,
              status: QuotaStatus.AVAILABLE,
            }),
          ],
        }),
      ],
      models: [
        create(ModelCapacitySchema, {
          profile: "acp:claude",
          provider: "claude",
          modelId: "claude-opus-5-5",
          bucketBindings: [create(BucketBindingSchema, { bucketId: "claude:5h", required: true })],
        }),
      ],
    });

    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(toJsonString(QuotaSnapshotSchema, snapshot));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };

    try {
      const client = new QuotaClient({ url: `http://127.0.0.1:${addr.port}/v1/quota` });
      const passiveResetMs = Date.now() + 20 * 60_000;
      const passiveResetIso = new Date(passiveResetMs).toISOString();

      // Profile acp:codex is NOT covered by the endpoint, and suffered a passive exhaustion with resetAt
      client.ingestPassiveSignal({
        profileId: "acp:codex",
        model: "gpt-6.2-astra",
        raw: { sessionFailure: "quota_exhausted", resetAt: passiveResetIso },
        observedAt: Date.now(),
      });

      const schedule = await client.resolveResumeSchedule([
        { profileId: "acp:claude", provider: "claude", wireModelId: "claude-opus-5-5" },
        { profileId: "acp:codex", provider: "codex", wireModelId: "gpt-6.2-astra" },
      ]);

      assert.equal(schedule.availableNow, false);
      assert.equal(schedule.source, "passive_reset");
      assert.ok(schedule.resumeAtMs !== null);
      assert.ok(schedule.resumeAtMs! >= passiveResetMs, "must wait for unmatched profile's passive resetAt");

      // When ALL queries are matched and available on the endpoint, availableNow IS true
      const fullSchedule = await client.resolveResumeSchedule([
        { profileId: "acp:claude", provider: "claude", wireModelId: "claude-opus-5-5" },
      ]);
      assert.equal(fullSchedule.availableNow, true);
      assert.equal(fullSchedule.source, "quota_endpoint");
    } finally {
      server.close();
    }
  });

  it("findBestModelCapacity rejects mismatched profile accounts (acp:claude-acct1 vs acp:claude-acct2)", async () => {
    const future = timestampFromMs(Date.now() + 3_600_000);
    const snapshot = create(QuotaSnapshotSchema, {
      schemaVersion: "1",
      generatedAt: timestampFromMs(Date.now()),
      ttlSeconds: 60,
      buckets: [
        create(QuotaBucketSchema, {
          bucketId: "claude:acct1:5h",
          provider: "claude",
          windows: [
            create(QuotaWindowSchema, {
              windowId: "five_hour",
              remainingRatio: 0,
              usedPercent: 100,
              resetAt: future,
              status: QuotaStatus.EXHAUSTED,
            }),
          ],
        }),
      ],
      models: [
        create(ModelCapacitySchema, {
          profile: "acp:claude-acct1",
          provider: "claude",
          modelId: "claude-opus-5-5",
          bucketBindings: [create(BucketBindingSchema, { bucketId: "claude:acct1:5h", required: true })],
        }),
      ],
    });

    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(toJsonString(QuotaSnapshotSchema, snapshot));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };

    try {
      const client = new QuotaClient({ url: `http://127.0.0.1:${addr.port}/v1/quota` });
      await client.sync(true);

      const acct1 = client.resolveForModel({
        profileId: "acp:claude-acct1",
        provider: "claude",
        wireModelId: "claude-opus-5-5",
      });
      const acct2 = client.resolveForModel({
        profileId: "acp:claude-acct2",
        provider: "claude",
        wireModelId: "claude-opus-5-5",
      });

      assert.ok(acct1);
      assert.equal(acct1!.exhausted, true);
      assert.equal(acct1!.unavailable, true);
      assert.equal(acct2, null, "acct1 quota must never be assigned to acct2");
    } finally {
      server.close();
    }
  });

  it("passiveExhaustedProfiles honors 4-hour resetAt past 15m and expires 5-second resetAt promptly", () => {
    const client = new QuotaClient();
    const now = Date.now();

    // 1. Observed 30 minutes ago (> 15m fallback), but resetAt is still 3.5 hours in the future -> STILL ACTIVE!
    const fourHourReset = new Date(now + 3.5 * 3_600_000).toISOString();
    client.ingestPassiveSignal({
      profileId: "acp:claude",
      model: "opus",
      raw: { sessionFailure: "quota_exhausted", resetAt: fourHourReset },
      observedAt: now - 30 * 60_000,
    });
    const active = client.resolveForModel({
      profileId: "acp:claude",
      provider: "claude",
      wireModelId: "opus",
    });
    assert.ok(active, "4-hour resetAt must stay active well past 15 minutes");
    assert.equal(active!.exhausted, true);
    assert.equal(active!.unavailable, true);
    assert.equal(active!.nextAvailableAt, fourHourReset);

    // 2. Observed 10 seconds ago (< 15m fallback), with a 5-second resetAt that already passed -> EXPIRED!
    const passedShortReset = new Date(now - 5_000).toISOString();
    client.ingestPassiveSignal({
      profileId: "acp:codex",
      model: "gpt-6.2-sol",
      raw: { sessionFailure: "rate_limited", resetAt: passedShortReset },
      observedAt: now - 10_000,
    });
    const expired = client.resolveForModel({
      profileId: "acp:codex",
      provider: "codex",
      wireModelId: "gpt-6.2-sol",
    });
    assert.equal(expired, null, "short resetAt must expire promptly once resetAt has passed");

    // 3. Active rate_limited without resetAt uses 15m fallback and exposes unavailable=true (THROTTLED)
    client.ingestPassiveSignal({
      profileId: "acp:gemini",
      model: "gemini-4-neon",
      raw: { sessionFailure: "rate_limited" },
      observedAt: now - 60_000,
    });
    const throttled = client.resolveForModel({
      profileId: "acp:gemini",
      provider: "gemini",
      wireModelId: "gemini-4-neon",
    });
    assert.ok(throttled);
    assert.equal(throttled!.availability, AvailabilityStatus.THROTTLED);
    assert.equal(throttled!.exhausted, false);
    assert.equal(throttled!.unavailable, true);
    assert.equal(isQuotaUnavailable(throttled), true);
  });

  it("selectLatestPerFamily keeps a user's live local model even when upstreamModelIds lists a newer version", () => {
    const localModel: CandidateModel = {
      canonicalId: "anthropic/claude-opus-5-5",
      creator: "anthropic",
      wireModelId: "claude-opus-5-5",
      name: "Claude Opus 5.5",
      toolCall: true,
      routes: [
        { profileId: "acp:claude", runner: "acp", provider: "claude", wireModelId: "claude-opus-5-5", billing: "subscription" },
      ],
    };

    const winners = selectLatestPerFamily([localModel], {
      upstreamModelIds: ["anthropic/claude-opus-5-6", "anthropic/claude-opus-6-0"],
    });
    assert.equal(winners.length, 1);
    assert.equal(winners[0]?.canonicalId, "anthropic/claude-opus-5-5");
  });

  it("getCatalog promotes a healthy alternateRoute when preferredRoute is exhausted or throttled", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-promote-"));
    try {
      const profiles: RunnerProfileConfig[] = [
        { id: "acp:claude-acct1", kind: "acp", adapter: "claude", command: "claude", billing: "subscription", enabled: true },
        { id: "acp:claude-acct2", kind: "acp", adapter: "claude", command: "claude", billing: "subscription", enabled: true },
      ];
      const config = {
        ...loadConfig(stateDir),
        stateDir,
        profiles,
        defaultOrchestratorProfile: "acp:claude-acct1",
        catalog: { ttlHours: 24 },
      };
      const quota = new QuotaClient();
      // Mark acct1 exhausted for 2 hours; acct2 remains healthy
      quota.ingestPassiveSignal({
        profileId: "acp:claude-acct1",
        model: "claude-opus-5-5",
        raw: { sessionFailure: "quota_exhausted", resetAt: new Date(Date.now() + 2 * 3_600_000).toISOString() },
        observedAt: Date.now(),
      });

      const compiler = new ModelCatalogCompiler(config, quota);
      const compiled = compiler.compileFromData({
        enabledProfiles: profiles,
        inventory: new Map([
          ["acp:claude-acct1", [{ wireModelId: "claude-opus-5-5", supportedEfforts: ["low", "high"] }]],
          ["acp:claude-acct2", [{ wireModelId: "claude-opus-5-5", supportedEfforts: ["medium", "max"] }]],
        ]),
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [],
        sources: [],
      });
      // Before quota evaluation, acct1 is preferred (defaultOrchestratorProfile)
      assert.equal(compiled.models[0]?.preferredRoute.profileId, "acp:claude-acct1");
      assert.equal(compiled.models[0]?.alternateRoutes[0]?.profileId, "acp:claude-acct2");
      writeFileSync(compiler.cachePath, JSON.stringify(compiled), "utf8");

      const live = await compiler.getCatalog({ excludeExhausted: true });
      assert.equal(live.models.length, 1);
      assert.equal(live.models[0]?.preferredRoute.profileId, "acp:claude-acct2", "healthy alternate route must be promoted");
      assert.equal(live.models[0]?.alternateRoutes[0]?.profileId, "acp:claude-acct1", "exhausted route must move to alternateRoutes");
      assert.deepEqual(live.models[0]?.efforts, ["medium", "max"]);
      assert.equal(isQuotaUnavailable(live.models[0]?.quota), false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("harvests per-profile CODEX_HOME, merges newest per limit_id across recent files sorted by mtimeMs, and flags stale >6h snapshots", () => {
    const homeA = mkdtempSync(join(tmpdir(), "pi-harness-codex-a-"));
    const homeB = mkdtempSync(join(tmpdir(), "pi-harness-codex-b-"));
    try {
      const now = Date.now();
      const futureResetSec = Math.floor((now + 3 * 3_600_000) / 1000);

      // Home A: yesterday folder has an ACTIVE session (newest mtime) + today folder has 15 older files with a different limit_id
      const yestDir = join(homeA, "sessions", "2026", "11", "21");
      const todayDir = join(homeA, "sessions", "2026", "11", "22");
      mkdirSync(yestDir, { recursive: true });
      mkdirSync(todayDir, { recursive: true });

      for (let i = 0; i < 14; i++) {
        const p = join(todayDir, `rollout-old-${String(i).padStart(2, "0")}.jsonl`);
        writeFileSync(p, JSON.stringify({ type: "event_msg", payload: { note: "no limits" } }) + "\n", "utf8");
        const oldTime = new Date(now - (20 + i) * 60_000);
        utimesSync(p, oldTime, oldTime);
      }
      // One file in todayDir with limit_id "codex_extra"
      const extraPath = join(todayDir, "rollout-extra.jsonl");
      writeFileSync(
        extraPath,
        JSON.stringify({
          timestamp: new Date(now - 5 * 60_000).toISOString(),
          payload: {
            rate_limits: {
              limit_id: "codex_extra",
              primary: { used_percent: 25, window_minutes: 300, resets_at: futureResetSec },
            },
          },
        }) + "\n",
        "utf8",
      );
      const extraTime = new Date(now - 5 * 60_000);
      utimesSync(extraPath, extraTime, extraTime);

      // Active session started yesterday with newest mtime (10s ago) carrying limit_id "codex"
      const activeYestPath = join(yestDir, "rollout-active-yesterday.jsonl");
      writeFileSync(
        activeYestPath,
        JSON.stringify({
          timestamp: new Date(now - 10_000).toISOString(),
          payload: {
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 60, window_minutes: 300, resets_at: futureResetSec },
            },
          },
        }) + "\n",
        "utf8",
      );
      const recentTime = new Date(now - 10_000);
      utimesSync(activeYestPath, recentTime, recentTime);

      // Home B: single 2-day-old snapshot (age > 6 hours -> must NOT be AUTHORITATIVE)
      const homeBDir = join(homeB, "sessions", "2026", "11", "20");
      mkdirSync(homeBDir, { recursive: true });
      const staleTs = now - 48 * 3_600_000;
      const stalePath = join(homeBDir, "rollout-stale.jsonl");
      writeFileSync(
        stalePath,
        JSON.stringify({
          timestamp: new Date(staleTs).toISOString(),
          payload: {
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 15, window_minutes: 300, resets_at: futureResetSec },
            },
          },
        }) + "\n",
        "utf8",
      );
      utimesSync(stalePath, new Date(staleTs), new Date(staleTs));

      const profiles: RunnerProfileConfig[] = [
        { id: "acp:codex-a", kind: "acp", adapter: "codex", command: "codex-acp", env: { CODEX_HOME: homeA }, billing: "subscription", enabled: true },
        { id: "acp:codex-b", kind: "acp", adapter: "codex", command: "codex-acp", env: { CODEX_HOME: homeB }, billing: "subscription", enabled: true },
      ];

      const quota = new QuotaClient();
      const count = quota.harvestLocal(profiles, { force: true });
      assert.equal(count, 2);

      const eff = quota.getEffectiveSnapshot();
      assert.ok(eff);
      const bucketACodex = eff!.buckets.find((b) => b.bucketId === "acp:codex-a:codex");
      const bucketAExtra = eff!.buckets.find((b) => b.bucketId === "acp:codex-a:codex_extra");
      const bucketBCodex = eff!.buckets.find((b) => b.bucketId === "acp:codex-b:codex");

      assert.ok(bucketACodex, "active session started yesterday must not be pruned out");
      assert.equal(bucketACodex!.windows[0]?.usedPercent, 60);
      assert.equal(bucketACodex!.observation?.confidence, DataConfidence.AUTHORITATIVE);

      assert.ok(bucketAExtra, "must merge limit_ids across multiple recent session files");
      assert.equal(bucketAExtra!.windows[0]?.usedPercent, 25);

      assert.ok(bucketBCodex, "second profile must harvest from its own CODEX_HOME");
      assert.equal(bucketBCodex!.windows[0]?.usedPercent, 15);
      assert.notEqual(
        bucketBCodex!.observation?.confidence,
        DataConfidence.AUTHORITATIVE,
        "multi-day-old harvested snapshot must NOT be labeled AUTHORITATIVE",
      );
      assert.equal(bucketBCodex!.observation?.confidence, DataConfidence.STALE);
    } finally {
      rmSync(homeA, { recursive: true, force: true });
      rmSync(homeB, { recursive: true, force: true });
    }
  });

  it("retains >30-day Vals.ai scores, uses short retry TTL for broken catalogs, omits synthetic 'default' efforts, and uses codingScore in inferRoles", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-compiler-hardening-"));
    try {
      const profiles: RunnerProfileConfig[] = [
        { id: "acp:open", kind: "acp", adapter: "generic", command: "opencode", billing: "api", enabled: true },
      ];
      const config = {
        ...loadConfig(stateDir),
        stateDir,
        profiles,
        catalog: { ttlHours: 24 },
      };
      const compiler = new ModelCatalogCompiler(config);

      // Vals.ai evidence dated 60 days ago must NOT wipe out codingScores!
      const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
      const evidence = {
        ...RANKING_COHORT,
        revision: "https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.AbC123.json",
        asOf: sixtyDaysAgo,
      };

      const compiled = compiler.compileFromData({
        enabledProfiles: profiles,
        inventory: new Map([
          [
            "acp:open",
            [
              { wireModelId: "deepseek/deepseek-v4" },
              { wireModelId: "xai/grok-4.7" },
            ],
          ],
        ]),
        modelsDev: [],
        openRouter: [],
        litellmDep: new Map(),
        benchmarks: [
          {
            source: "vals_tb4",
            rawModelName: "deepseek/deepseek-v4",
            canonicalKeyHint: "deepseek/deepseek-v4",
            effort: "high",
            codingScore: 68.5,
            evidence,
          },
          {
            source: "vals_tb4",
            rawModelName: "xai/grok-4.7",
            canonicalKeyHint: "xai/grok-4.7",
            effort: "high",
            codingScore: 71.2,
            evidence,
          },
        ],
        sources: ["vals_ai"],
      });

      assert.equal(compiled.rankingEvidenceStale, true);
      assert.equal(compiled.models[0]?.id, "xai/grok-4.7", "must rank by codingScore, not alphabetically");
      assert.equal(compiled.models[0]?.codingScore, 71.2);
      assert.equal(compiled.models[1]?.id, "deepseek/deepseek-v4");
      assert.equal(compiled.models[1]?.codingScore, 68.5);
      // High-scoring non-hardcoded families qualify for orchestrator and independent_verifier
      assert.ok(compiled.models[0]?.recommendedFor.includes("orchestrator"));
      assert.ok(compiled.models[0]?.recommendedFor.includes("independent_verifier"));
      assert.ok(compiled.models[1]?.recommendedFor.includes("orchestrator"));
      // Real efforts unknown -> omit synthetic "default"
      assert.deepEqual(compiled.models[0]?.efforts, []);

      // recommendModelsByTaskKind omits synthetic effort and filters out THROTTLED/DISABLED models
      const recs = recommendModelsByTaskKind([
        {
          ...compiled.models[0]!,
          quota: {
            availability: AvailabilityStatus.THROTTLED,
            availabilityName: "THROTTLED",
            exhausted: false,
            effectiveRemainingRatio: 0,
            bindingBucketId: null,
            bindingWindowLabel: null,
            nextAvailableAt: null,
            estimatedRequestsRemaining: 0,
            costMultiplier: null,
            overageActive: false,
          },
        },
        compiled.models[1]!,
      ]);
      assert.equal(recs.orchestrator?.model, "deepseek/deepseek-v4", "must skip THROTTLED model");
      assert.equal(recs.orchestrator?.effort, undefined, "must not fabricate synthetic effort");

      // isCacheFresh accepts 60-day-old Vals evidence when synced recently
      assert.equal(compiler.isCacheFresh(compiled), true);

      // isCacheFresh refuses to cache empty or probe-error catalogs for 24h (expires after 2m)
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
      assert.equal(
        compiler.isCacheFresh({ ...compiled, syncedAt: fiveMinAgo, models: [] }),
        false,
        "empty catalog must not stay fresh past short retry TTL",
      );
      assert.equal(
        compiler.isCacheFresh({
          ...compiled,
          syncedAt: fiveMinAgo,
          profileStatuses: [{ profileId: "acp:open", status: "error", modelCount: 0, error: "CLI failed" }],
        }),
        false,
        "catalog with enabled profile probe error must not stay fresh past short retry TTL",
      );
      assert.equal(
        compiler.isCacheFresh({ ...compiled, syncedAt: fiveMinAgo }),
        true,
        "healthy catalog remains fresh within 24h",
      );
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
