import { request as httpRequest } from "node:http";
import { clone, create, fromBinary, fromJsonString, toJson } from "@bufbuild/protobuf";
import { timestampFromMs, timestampMs } from "@bufbuild/protobuf/wkt";
import { interpolateEnv, type QuotaEndpointConfig } from "../config.js";
import {
  AvailabilityStatus,
  BucketBindingSchema,
  DataConfidence,
  ModelCapacitySchema,
  ObservationMetaSchema,
  OveragePolicySchema,
  QuotaBucketSchema,
  QuotaSnapshotSchema,
  QuotaStatus,
  QuotaWindowSchema,
  SignalSource,
  type ModelCapacity,
  type QuotaBucket,
  type QuotaSnapshot,
} from "../gen/quota_pb.js";
import type { PassiveQuotaSignal } from "../runners/types.js";
import { resolveModelCapacity, type ResolvedModelQuota } from "./schema.js";

/**
 * Fetches optional user-configured Quota Endpoint (ProtoJSON or binary Protobuf over
 * HTTP/HTTPS or `unix://`) directly into generated `@bufbuild/protobuf` messages,
 * and merges live passive ACP quota signals (`_claude/rateLimit`, `sessionFailure`).
 */
export class QuotaClient {
  private snapshot: QuotaSnapshot | null = null;
  private lastFetchMs = 0;
  private passiveBuckets = new Map<string, QuotaBucket>();
  private passiveExhaustedProfiles = new Map<string, { resetAt?: string; observedAt: number; reason: string }>();

  constructor(private readonly config?: QuotaEndpointConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config?.url);
  }

  /**
   * Clears cached passive exhaustion / rate-limit state (used when a user manually resumes
   * or an auto-resume timer fires so the quota state machine resets cleanly).
   */
  clearPassiveExhaustion(profileId?: string): void {
    if (!profileId) {
      this.passiveExhaustedProfiles.clear();
      this.passiveBuckets.clear();
      return;
    }
    for (const key of [...this.passiveExhaustedProfiles.keys()]) {
      if (key.startsWith(`${profileId}:`)) {
        this.passiveExhaustedProfiles.delete(key);
      }
    }
    for (const key of [...this.passiveBuckets.keys()]) {
      if (key.startsWith(`${profileId}:`)) {
        this.passiveBuckets.delete(key);
      }
    }
  }

  /**
   * Resolves when quota-paused tasks should automatically restart, consulting:
   * 1. Live `proto/quota.proto` Quota Endpoint (refreshed on demand)
   * 2. Passive ACP `resetsAt` / `Retry-After` hints harvested from rate-limit responses
   * 3. Otherwise returns `resumeAtMs: null` so caller applies exponential fallback backoff.
   */
  async resolveResumeSchedule(
    queries: Array<{
      profileId: string;
      provider: string;
      wireModelId: string;
      canonicalModelId?: string;
      hintResetAt?: string | null;
    }>,
    opts?: { forceSync?: boolean },
  ): Promise<{
    availableNow: boolean;
    resumeAtMs: number | null;
    source: "quota_endpoint" | "passive_reset" | "unknown";
    detail: string;
  }> {
    let syncedEndpoint = false;
    if (this.config?.url) {
      try {
        const snap = await this.sync(opts?.forceSync ?? true);
        syncedEndpoint = Boolean(snap);
      } catch {
        // Endpoint unreachable — fall back to cached snapshot / passive hints
      }
    }

    const now = Date.now();
    const SAFETY_CUSHION_MS = 3_000;
    const endpointResets: number[] = [];
    const passiveResets: number[] = [];
    let endpointMatchedAny = false;
    let endpointAllAvailable = true;

    for (const q of queries) {
      if (q.hintResetAt) {
        const ts = Date.parse(q.hintResetAt);
        if (Number.isFinite(ts) && ts > now) {
          passiveResets.push(ts + SAFETY_CUSHION_MS);
        }
      }

      // Check authoritative Quota Endpoint snapshot directly (ignoring local passiveFailure override)
      if (this.snapshot) {
        const merged = new Map<string, QuotaBucket>();
        for (const b of this.snapshot.buckets ?? []) {
          merged.set(b.bucketId, clone(QuotaBucketSchema, b));
        }
        const match = findBestModelCapacity(this.snapshot.models ?? [], q);
        if (match) {
          endpointMatchedAny = true;
          const resolved = resolveModelCapacity(match, merged);
          const isAvail =
            !resolved.exhausted &&
            resolved.availability !== AvailabilityStatus.EXHAUSTED &&
            resolved.availability !== AvailabilityStatus.THROTTLED;
          if (!isAvail) {
            endpointAllAvailable = false;
            if (resolved.nextAvailableAt) {
              const ts = Date.parse(resolved.nextAvailableAt);
              if (Number.isFinite(ts) && ts > now) {
                endpointResets.push(ts + SAFETY_CUSHION_MS);
              }
            }
          }
        }
      }

      // Also check passive ACP buckets (`_claude/rateLimit` `resetsAt`)
      const passiveResolved = this.resolveForModel(q);
      if (passiveResolved?.nextAvailableAt) {
        const ts = Date.parse(passiveResolved.nextAvailableAt);
        if (Number.isFinite(ts) && ts > now) {
          passiveResets.push(ts + SAFETY_CUSHION_MS);
        }
      }
    }

    if (syncedEndpoint && endpointMatchedAny && endpointAllAvailable && queries.length > 0) {
      return {
        availableNow: true,
        resumeAtMs: now + 1_500,
        source: "quota_endpoint",
        detail: "Quota endpoint reports capacity available now",
      };
    }

    if (endpointResets.length > 0) {
      // Pick earliest reset among paused tasks so work unblocks as soon as any required bucket opens
      const earliest = Math.min(...endpointResets);
      return {
        availableNow: false,
        resumeAtMs: earliest,
        source: "quota_endpoint",
        detail: `Scheduled from Quota Endpoint (nextAvailableAt ${new Date(earliest).toISOString()})`,
      };
    }

    if (passiveResets.length > 0) {
      const earliest = Math.min(...passiveResets);
      return {
        availableNow: false,
        resumeAtMs: earliest,
        source: "passive_reset",
        detail: `Scheduled from passive rate-limit reset (${new Date(earliest).toISOString()})`,
      };
    }

    return {
      availableNow: false,
      resumeAtMs: null,
      source: "unknown",
      detail: "No explicit reset timestamp reported; using fallback cooldown",
    };
  }

  getCurrentSnapshot(): QuotaSnapshot | null {
    return this.snapshot;
  }

  getCurrentSnapshotJson(): unknown {
    return this.snapshot ? toJson(QuotaSnapshotSchema, this.snapshot) : null;
  }

  ingestPassiveSignal(signal: PassiveQuotaSignal): void {
    const raw = signal.raw;

    // 1. Live Claude ACP `_claude/rateLimit` (`SDKRateLimitInfo`)
    if (typeof raw.status === "string" && ("rateLimitType" in raw || "utilization" in raw || "resetsAt" in raw)) {
      const rateLimitType = String(raw.rateLimitType ?? "five_hour");
      const bucketId = rateLimitType.includes("opus")
        ? `${signal.profileId}:opus`
        : rateLimitType.includes("sonnet")
          ? `${signal.profileId}:sonnet`
          : `${signal.profileId}:all`;

      const rawUtil = typeof raw.utilization === "number" ? raw.utilization : undefined;
      const usedPercent = rawUtil === undefined ? undefined : rawUtil <= 1.0 ? rawUtil * 100 : rawUtil;
      const remainingRatio = usedPercent === undefined ? undefined : Math.max(0, Math.min(1, 1 - usedPercent / 100));
      const resetAt = typeof raw.resetsAt === "number" ? timestampFromMs(raw.resetsAt * 1000) : undefined;

      const status =
        raw.status === "rejected"
          ? QuotaStatus.EXHAUSTED
          : raw.status === "allowed_warning"
            ? QuotaStatus.WARNING
            : QuotaStatus.AVAILABLE;

      const existing =
        this.passiveBuckets.get(bucketId) ??
        create(QuotaBucketSchema, {
          bucketId,
          provider: signal.profileId,
          displayName: `Passive ${bucketId}`,
          windows: [],
        });

      const windows = existing.windows.filter((w) => w.windowId !== rateLimitType);
      windows.push(
        create(QuotaWindowSchema, {
          windowId: rateLimitType,
          label: rateLimitType,
          usedPercent,
          remainingRatio,
          resetAt,
          binding: true,
          status,
          observation: create(ObservationMetaSchema, {
            observedAt: timestampFromMs(signal.observedAt),
            source: SignalSource.ACP_PASSIVE,
            confidence: DataConfidence.AUTHORITATIVE,
          }),
        }),
      );

      const overage =
        typeof raw.overageEnabled === "boolean"
          ? create(OveragePolicySchema, {
              enabled: raw.overageEnabled,
              inUse: Boolean(raw.isUsingOverage),
              status:
                raw.overageStatus === "rejected"
                  ? QuotaStatus.EXHAUSTED
                  : raw.overageStatus === "allowed_warning"
                    ? QuotaStatus.WARNING
                    : QuotaStatus.AVAILABLE,
            })
          : existing.overage;

      existing.windows = windows;
      existing.overage = overage;
      existing.observation = create(ObservationMetaSchema, {
        observedAt: timestampFromMs(signal.observedAt),
        source: SignalSource.ACP_PASSIVE,
      });
      this.passiveBuckets.set(bucketId, existing);
      return;
    }

    // 2. Terminal ACP `sessionFailure` (`quota_exhausted`, `rate_limited`, `budget_exhausted`)
    if (typeof raw.sessionFailure === "string") {
      const failure = raw.sessionFailure;
      if (failure === "quota_exhausted" || failure === "rate_limited" || failure === "budget_exhausted") {
        const key = `${signal.profileId}:${signal.model ?? "*"}`;
        this.passiveExhaustedProfiles.set(key, {
          observedAt: signal.observedAt,
          reason: failure,
          resetAt: typeof raw.resetAt === "string" ? raw.resetAt : undefined,
        });
      }
    }
  }

  async sync(force = false): Promise<QuotaSnapshot | null> {
    if (!this.config?.url) return this.snapshot;
    const ttlMs = (this.snapshot?.ttlSeconds ?? this.config.pollIntervalSec ?? 60) * 1000;
    if (!force && this.snapshot && Date.now() - this.lastFetchMs < ttlMs) {
      return this.snapshot;
    }

    const isBinary = this.config.format === "protobuf";
    const headers: Record<string, string> = {
      Accept: isBinary ? "application/x-protobuf" : "application/json",
    };
    for (const [k, v] of Object.entries(this.config.headers ?? {})) {
      headers[k] = interpolateEnv(v);
    }

    const timeoutMs = this.config.timeoutMs ?? 5000;
    const bytes = this.config.url.startsWith("unix://")
      ? await fetchBytesOverUnixSocket(this.config.url, headers, timeoutMs)
      : await fetchBytesOverHttp(this.config.url, headers, timeoutMs);

    const parsed = isBinary
      ? fromBinary(QuotaSnapshotSchema, bytes)
      : fromJsonString(QuotaSnapshotSchema, new TextDecoder().decode(bytes), { ignoreUnknownFields: true });

    this.snapshot = parsed;
    this.lastFetchMs = Date.now();
    return parsed;
  }

  resolveForModel(query: {
    profileId: string;
    provider: string;
    wireModelId: string;
    canonicalModelId?: string;
  }): ResolvedModelQuota | null {
    const mergedBuckets = new Map<string, QuotaBucket>();
    for (const b of this.snapshot?.buckets ?? []) {
      mergedBuckets.set(b.bucketId, clone(QuotaBucketSchema, b));
    }

    for (const [id, passive] of this.passiveBuckets) {
      const existing = mergedBuckets.get(id);
      if (!existing) {
        mergedBuckets.set(id, clone(QuotaBucketSchema, passive));
      } else {
        const byWin = new Map(existing.windows.map((w) => [w.windowId, w]));
        for (const pw of passive.windows) {
          const ew = byWin.get(pw.windowId);
          const pTs = pw.observation?.observedAt ? timestampMs(pw.observation.observedAt) : 0;
          const eTs = ew?.observation?.observedAt
            ? timestampMs(ew.observation.observedAt)
            : existing.observation?.observedAt
              ? timestampMs(existing.observation.observedAt)
              : 0;
          if (!ew || pTs >= eTs) {
            byWin.set(pw.windowId, clone(QuotaWindowSchema, pw));
          }
        }
        existing.windows = [...byWin.values()];
        if (passive.overage) existing.overage = clone(OveragePolicySchema, passive.overage);
      }
    }

    const passiveFail =
      this.passiveExhaustedProfiles.get(`${query.profileId}:${query.wireModelId}`) ??
      this.passiveExhaustedProfiles.get(`${query.profileId}:*`);
    if (passiveFail && Date.now() - passiveFail.observedAt < 15 * 60_000) {
      const avail =
        passiveFail.reason === "rate_limited" ? AvailabilityStatus.THROTTLED : AvailabilityStatus.EXHAUSTED;
      return {
        availability: avail,
        availabilityName: AvailabilityStatus[avail] ?? "EXHAUSTED",
        exhausted: passiveFail.reason !== "rate_limited",
        effectiveRemainingRatio: 0,
        bindingBucketId: `${query.profileId}:passive`,
        bindingWindowLabel: passiveFail.reason,
        nextAvailableAt: passiveFail.resetAt ?? null,
        estimatedRequestsRemaining: 0,
        costMultiplier: null,
        overageActive: false,
        reason: `Recent passive ACP failure: ${passiveFail.reason}`,
      };
    }

    const match = findBestModelCapacity(this.snapshot?.models ?? [], query);
    if (match) {
      return resolveModelCapacity(match, mergedBuckets);
    }

    const passiveBindings = [...mergedBuckets.keys()]
      .filter((id) => id.startsWith(`${query.profileId}:`))
      .filter((id) => {
        if (id.endsWith(":opus")) return query.wireModelId.toLowerCase().includes("opus");
        if (id.endsWith(":sonnet")) return query.wireModelId.toLowerCase().includes("sonnet");
        return true;
      })
      .map((bucketId) => create(BucketBindingSchema, { bucketId, required: true }));

    if (passiveBindings.length > 0) {
      const synth = create(ModelCapacitySchema, {
        provider: query.provider,
        profile: query.profileId,
        modelId: query.wireModelId,
        bucketBindings: passiveBindings,
      });
      return resolveModelCapacity(synth, mergedBuckets);
    }

    return null;
  }
}

function findBestModelCapacity(
  models: ModelCapacity[],
  q: { profileId: string; provider: string; wireModelId: string; canonicalModelId?: string },
): ModelCapacity | null {
  const norm = (s: string) => s.toLowerCase().trim();
  const qModel = norm(q.wireModelId);
  const qCanon = q.canonicalModelId ? norm(q.canonicalModelId) : null;
  const qProv = norm(q.provider);
  const qProf = norm(q.profileId);

  let best: { score: number; item: ModelCapacity } | null = null;
  for (const m of models) {
    const mProf = m.profile ? norm(m.profile) : null;
    const mProv = norm(m.provider);
    const mId = norm(m.modelId);

    const profileMatches = mProf ? mProf === qProf : true;
    const providerMatches = mProv === qProv || mProf === qProf || mProv === "*";
    if (!profileMatches && !providerMatches) continue;

    let score = 0;
    if (mProf === qProf) score += 20;
    if (mProv === qProv) score += 10;

    if (mId === qModel || (qCanon && mId === qCanon) || (qCanon && qCanon.endsWith(`/${mId}`))) {
      score += 100;
    } else if (mId === "*") {
      score += 5;
    } else {
      continue;
    }

    if (!best || score > best.score) {
      best = { score, item: m };
    }
  }
  return best?.item ?? null;
}

async function fetchBytesOverHttp(url: string, headers: Record<string, string>, timeoutMs: number): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error(`Quota endpoint HTTP ${res.status}: ${res.statusText}`);
    return new Uint8Array(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBytesOverUnixSocket(
  unixUrl: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Uint8Array> {
  const withoutScheme = unixUrl.slice("unix://".length);
  const [socketPath, reqPath = "/v1/quota"] = withoutScheme.split("#");
  if (!socketPath) throw new Error(`Invalid unix quota URL: ${unixUrl}`);

  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        socketPath,
        path: reqPath.startsWith("/") ? reqPath : `/${reqPath}`,
        method: "GET",
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Unix quota endpoint HTTP ${res.statusCode}`));
          } else {
            resolve(new Uint8Array(Buffer.concat(chunks)));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("Unix quota endpoint timed out")));
    req.on("error", reject);
    req.end();
  });
}
