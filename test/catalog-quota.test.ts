import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, toBinary, toJsonString } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { buildMatchKeys, ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { selectLatestPerFamily, type CandidateModel } from "../src/catalog/deduplicate.js";
import { loadConfig, type RunnerProfileConfig } from "../src/config.js";
import {
  AvailabilityStatus,
  BucketBindingSchema,
  ModelCapacitySchema,
  OveragePolicySchema,
  QuotaBucketSchema,
  QuotaSnapshotSchema,
  QuotaStatus,
  QuotaWindowSchema,
  type QuotaBucket,
} from "../src/gen/quota_pb.js";
import { QuotaClient } from "../src/quota/client.js";
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
    assert.ok(winners.includes("gemini-3.8-flash"));
    assert.ok(!winners.includes("gemini-3.5-flash"));
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
});
