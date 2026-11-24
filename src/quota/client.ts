import { request as httpRequest } from "node:http";
import { clone, create, fromBinary, fromJsonString, toJson } from "@bufbuild/protobuf";
import { timestampFromMs, timestampMs } from "@bufbuild/protobuf/wkt";
import { interpolateEnv, type QuotaEndpointConfig, type RunnerProfileConfig } from "../config.js";
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
import {
  harvestLocalQuotaSignals,
  LOCAL_QUOTA_FRESHNESS_MS,
  type CodexRateLimitsRaw,
  type CodexRateLimitWindowRaw,
} from "./local-harvest.js";
import { resolveModelCapacity, type ResolvedModelQuota } from "./schema.js";

export const AUTH_COOLDOWN_BASE_MS = 300_000;
export const AUTH_COOLDOWN_MAX_MS = 3_600_000;

/**
 * Exponential cooldown for ACP authentication failures: 5, 15, 45, then capped at 60 minutes.
 */
export function authCooldownMs(failures: number): number {
  const n = Math.max(1, Math.floor(failures));
  return Math.min(AUTH_COOLDOWN_BASE_MS * 3 ** (n - 1), AUTH_COOLDOWN_MAX_MS);
}

const PASSIVE_FAILURE_FALLBACK_TTL_MS = 15 * 60_000;

/**
 * Returns true when resolved quota indicates a route cannot currently serve requests
 * (exhausted, throttled/rate-limited, or disabled).
 */
export function isQuotaUnavailable(quota: ResolvedModelQuota | null | undefined): boolean {
  if (!quota) return false;
  return (
    quota.exhausted ||
    quota.availability === AvailabilityStatus.EXHAUSTED ||
    quota.availability === AvailabilityStatus.THROTTLED ||
    quota.availability === AvailabilityStatus.DISABLED
  );
}

function isPassiveFailureActive(
  fail: { resetAt?: string; observedAt: number; reason: string },
  now: number,
): boolean {
  if (fail.resetAt != null) {
    const resetMs = Date.parse(fail.resetAt);
    if (Number.isFinite(resetMs)) {
      return now < resetMs;
    }
  }
  return now - fail.observedAt < PASSIVE_FAILURE_FALLBACK_TTL_MS;
}

export interface ProfileQuotaCoverage {
  profileId: string;
  adapter: string;
  hasData: boolean;
  source: "endpoint" | "acp_passive" | "local_session" | "error_signal" | "none";
  note: string;
}

function formatCodexWindowLabel(windowMinutes?: number, fallback = "window"): string {
  if (!windowMinutes || !Number.isFinite(windowMinutes) || windowMinutes <= 0) return fallback;
  if (windowMinutes % 1440 === 0) {
    const days = windowMinutes / 1440;
    return days === 7 ? "7d weekly" : `${days}d rolling`;
  }
  if (windowMinutes % 60 === 0) {
    return `${windowMinutes / 60}h rolling`;
  }
  return `${windowMinutes}m`;
}

function codexWindowToProto(
  windowId: string,
  raw: CodexRateLimitWindowRaw,
  observedAt: number,
  confidence: DataConfidence = DataConfidence.AUTHORITATIVE,
) {
  const usedPercent = typeof raw.used_percent === "number" && Number.isFinite(raw.used_percent) ? raw.used_percent : undefined;
  const remainingRatio =
    usedPercent === undefined ? undefined : Math.max(0, Math.min(1, 1 - usedPercent / 100));
  const resetAt = typeof raw.resets_at === "number" && raw.resets_at > 0 ? timestampFromMs(raw.resets_at * 1000) : undefined;
  const status =
    usedPercent !== undefined && usedPercent >= 100
      ? QuotaStatus.EXHAUSTED
      : usedPercent !== undefined && usedPercent >= 85
        ? QuotaStatus.WARNING
        : QuotaStatus.AVAILABLE;
  return create(QuotaWindowSchema, {
    windowId,
    label: formatCodexWindowLabel(raw.window_minutes, windowId),
    windowSeconds: raw.window_minutes ? BigInt(Math.round(raw.window_minutes * 60)) : undefined,
    usedPercent,
    remainingRatio,
    resetAt,
    binding: true,
    status,
    observation: create(ObservationMetaSchema, {
      observedAt: timestampFromMs(observedAt),
      source: SignalSource.RUNNER_NATIVE,
      confidence,
    }),
  });
}

/**
 * Fetches optional user-configured Quota Endpoint (ProtoJSON or binary Protobuf over
 * HTTP/HTTPS or `unix://`) directly into generated `@bufbuild/protobuf` messages,
 * and merges live passive ACP quota signals (`_claude/rateLimit`, `sessionFailure`).
 */
export class QuotaClient {
  private snapshot: QuotaSnapshot | null = null;
  private lastFetchMs = 0;
  private lastLocalHarvestMs = 0;
  private passiveBuckets = new Map<string, QuotaBucket>();
  private passiveExhaustedProfiles = new Map<string, { resetAt?: string; observedAt: number; reason: string }>();
  private authFailures = new Map<string, { failures: number; observedAt: number; until: number; detail: string }>();

  constructor(private readonly config?: QuotaEndpointConfig) {}

  /**
   * Returns active authentication failure cooldown state for a profile, or null when healthy or expired.
   * Expired entries stay in memory until `authOk` clears them so repeat failures escalate back-off.
   */
  authStatus(profileId: string, now = Date.now()): { until: string; failures: number; detail: string } | null {
    const entry = this.authFailures.get(profileId);
    if (!entry || now >= entry.until) return null;
    return {
      until: new Date(entry.until).toISOString(),
      failures: entry.failures,
      detail: entry.detail,
    };
  }

  isConfigured(): boolean {
    return Boolean(this.config?.url);
  }

  /**
   * Passively harvests locally available quota telemetry (e.g. Codex session `rate_limits`)
   * without requiring a Quota Endpoint. Throttled to every 15s unless `force: true`.
   */
  harvestLocal(profiles: RunnerProfileConfig[], opts?: { codexHome?: string; force?: boolean }): number {
    const now = Date.now();
    if (!opts?.force && now - this.lastLocalHarvestMs < 15_000) return 0;
    this.lastLocalHarvestMs = now;
    const signals = harvestLocalQuotaSignals(profiles, { codexHome: opts?.codexHome });
    for (const sig of signals) {
      this.ingestPassiveSignal(sig);
    }
    return signals.length;
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
    let endpointMatchedCount = 0;
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
          endpointMatchedCount++;
          const resolved = resolveModelCapacity(match, merged, now);
          const isAvail = !isQuotaUnavailable(resolved);
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

      // Also check passive ACP buckets (`_claude/rateLimit` `resetsAt`) and passive exhaustion resetAt
      const passiveResolved = this.resolveForModel(q);
      if (passiveResolved?.nextAvailableAt) {
        const ts = Date.parse(passiveResolved.nextAvailableAt);
        if (Number.isFinite(ts) && ts > now) {
          passiveResets.push(ts + SAFETY_CUSHION_MS);
        }
      }
    }

    if (syncedEndpoint && queries.length > 0 && endpointMatchedCount === queries.length && endpointAllAvailable) {
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

  /**
   * Builds a unified `QuotaSnapshot` merging any external Quota Endpoint data WITH locally harvested
   * passive ACP / CLI quota buckets so `/quota` and `pi-harness quota` show live capacity even when
   * no external Quota Endpoint is configured.
   */
  getEffectiveSnapshot(): QuotaSnapshot | null {
    const now = Date.now();
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
          const eTs = ew?.observation?.observedAt ? timestampMs(ew.observation.observedAt) : 0;
          if (!ew || pTs >= eTs) byWin.set(pw.windowId, clone(QuotaWindowSchema, pw));
        }
        existing.windows = [...byWin.values()];
        if (passive.overage) existing.overage = clone(OveragePolicySchema, passive.overage);
      }
    }

    const activeErrors = [...this.passiveExhaustedProfiles.entries()].filter(
      ([, fail]) => isPassiveFailureActive(fail, now),
    );

    if (!this.snapshot && mergedBuckets.size === 0 && activeErrors.length === 0) {
      return null;
    }

    const models: ModelCapacity[] = (this.snapshot?.models ?? []).map((m) => clone(ModelCapacitySchema, m));
    const coveredProfiles = new Set(models.map((m) => `${m.profile}:${m.modelId}`));

    // Synthesize visible model rows for passive/local buckets when not already covered by endpoint models
    for (const [bucketId, bucket] of mergedBuckets) {
      if (this.snapshot?.buckets?.some((b) => b.bucketId === bucketId)) continue;
      const sep = bucketId.lastIndexOf(":");
      const profileId = bucket.provider || (sep > 0 ? bucketId.slice(0, sep) : bucketId);
      const scope = sep > 0 ? bucketId.slice(sep + 1) : "*";
      const modelLabel = scope === "all" || scope === "codex" ? `${profileId} (*)` : `${profileId} (${scope})`;
      if (coveredProfiles.has(`${profileId}:${modelLabel}`)) continue;
      coveredProfiles.add(`${profileId}:${modelLabel}`);
      const synth = create(ModelCapacitySchema, {
        provider: profileId,
        profile: profileId,
        modelId: modelLabel,
        bucketBindings: [create(BucketBindingSchema, { bucketId, required: true })],
      });
      const resolved = resolveModelCapacity(synth, mergedBuckets, now);
      synth.exhausted = resolved.exhausted;
      synth.availability = resolved.availability;
      if (resolved.effectiveRemainingRatio !== null) synth.effectiveRemainingRatio = resolved.effectiveRemainingRatio;
      models.push(synth);
    }

    for (const [key, fail] of activeErrors) {
      const idx = key.lastIndexOf(":");
      const profileId = idx > 0 ? key.slice(0, idx) : key;
      const modelId = idx > 0 ? key.slice(idx + 1) : "*";
      if (coveredProfiles.has(`${profileId}:${modelId}`)) continue;
      coveredProfiles.add(`${profileId}:${modelId}`);
      models.push(
        create(ModelCapacitySchema, {
          provider: profileId,
          profile: profileId,
          modelId,
          exhausted: fail.reason !== "rate_limited",
          availability:
            fail.reason === "rate_limited" ? AvailabilityStatus.THROTTLED : AvailabilityStatus.EXHAUSTED,
          effectiveRemainingRatio: 0,
          nextAvailableAt: fail.resetAt && Number.isFinite(Date.parse(fail.resetAt))
            ? timestampFromMs(Date.parse(fail.resetAt))
            : undefined,
          reason: `Recent passive ACP failure: ${fail.reason}`,
        }),
      );
    }

    const sourceMode =
      this.snapshot && (this.passiveBuckets.size > 0 || activeErrors.length > 0)
        ? "endpoint+passive"
        : this.snapshot
          ? "endpoint"
          : "passive_local";

    return create(QuotaSnapshotSchema, {
      schemaVersion: this.snapshot?.schemaVersion || "1",
      generatedAt: this.snapshot?.generatedAt ?? timestampFromMs(now),
      ttlSeconds: this.snapshot?.ttlSeconds,
      accounts: this.snapshot?.accounts ?? [],
      buckets: [...mergedBuckets.values()],
      models,
      errors: this.snapshot?.errors ?? [],
      metadata: {
        ...(this.snapshot?.metadata ?? {}),
        source: sourceMode,
      },
    });
  }

  getEffectiveSnapshotJson(): unknown {
    const eff = this.getEffectiveSnapshot();
    return eff ? toJson(QuotaSnapshotSchema, eff) : null;
  }

  /** Summarizes which enabled profiles currently have quota telemetry and where it came from. */
  getProfileQuotaCoverage(profiles: RunnerProfileConfig[]): ProfileQuotaCoverage[] {
    const now = Date.now();
    return profiles
      .filter((p) => p.enabled !== false)
      .map((p) => {
        const adapter = p.kind === "acp" ? p.adapter : p.provider;
        const hasEndpoint = Boolean(
          this.snapshot?.models?.some(
            (m) => m.profile === p.id || (!m.profile && m.provider.toLowerCase() === adapter.toLowerCase()),
          ) ||
            this.snapshot?.buckets?.some(
              (b) => b.provider === p.id || b.provider.toLowerCase() === adapter.toLowerCase(),
            ),
        );
        if (hasEndpoint) {
          return { profileId: p.id, adapter, hasData: true, source: "endpoint", note: "Quota Endpoint" };
        }
        const passiveMatches = [...this.passiveBuckets.values()].filter(
          (b) => b.bucketId.startsWith(`${p.id}:`) || b.provider === p.id,
        );
        if (passiveMatches.length > 0) {
          const isLocal = passiveMatches.some(
            (b) =>
              b.observation?.source === SignalSource.RUNNER_NATIVE ||
              b.windows.some((w) => w.observation?.source === SignalSource.RUNNER_NATIVE),
          );
          return {
            profileId: p.id,
            adapter,
            hasData: true,
            source: isLocal ? "local_session" : "acp_passive",
            note: isLocal ? "harvested from local CLI session" : "harvested from live ACP telemetry",
          };
        }
        const hasErr = [...this.passiveExhaustedProfiles.entries()].some(
          ([k, v]) => k.startsWith(`${p.id}:`) && isPassiveFailureActive(v, now),
        );
        if (hasErr) {
          return {
            profileId: p.id,
            adapter,
            hasData: true,
            source: "error_signal",
            note: "recent rate-limit / exhaustion signal",
          };
        }
        const hint =
          adapter === "claude"
            ? "awaiting live ACP turn (_claude/rateLimit)"
            : adapter === "codex"
              ? "no recent local Codex session rate_limits found"
              : "no local quota telemetry reported by this ACP";
        return { profileId: p.id, adapter, hasData: false, source: "none", note: hint };
      });
  }

  ingestPassiveSignal(signal: PassiveQuotaSignal): void {
    const raw = signal.raw;

    if (raw.authOk === true) {
      this.authFailures.delete(signal.profileId);
    }

    // 0. Codex CLI / `codex-acp` rate_limits (primary / secondary windows + credits)
    if (Array.isArray(raw.codexRateLimits) || (raw.codexRateLimits && typeof raw.codexRateLimits === "object")) {
      const list = (Array.isArray(raw.codexRateLimits) ? raw.codexRateLimits : [raw.codexRateLimits]) as CodexRateLimitsRaw[];
      const now = Date.now();
      for (const snap of list) {
        if (!snap || typeof snap !== "object") continue;
        const limitId = (typeof snap.limit_id === "string" && snap.limit_id.trim()) || "codex";
        const bucketId = `${signal.profileId}:${limitId}`;
        const snapObservedAt =
          typeof snap.observedAt === "number" && Number.isFinite(snap.observedAt)
            ? snap.observedAt
            : signal.observedAt;
        const existing = this.passiveBuckets.get(bucketId);
        const existingTs = existing?.observation?.observedAt ? timestampMs(existing.observation.observedAt) : 0;
        if (existing && existingTs > snapObservedAt) continue;

        const isStale = Boolean(snap.stale) || now - snapObservedAt > LOCAL_QUOTA_FRESHNESS_MS;
        const confidence = isStale ? DataConfidence.STALE : DataConfidence.AUTHORITATIVE;

        const windows = [];
        if (snap.primary && typeof snap.primary === "object") {
          windows.push(codexWindowToProto("primary", snap.primary, snapObservedAt, confidence));
        }
        if (snap.secondary && typeof snap.secondary === "object") {
          windows.push(codexWindowToProto("secondary", snap.secondary, snapObservedAt, confidence));
        }
        if (windows.length === 0 && !snap.credits) continue;

        const overage =
          snap.credits && typeof snap.credits === "object"
            ? create(OveragePolicySchema, {
                enabled: Boolean(snap.credits.has_credits || snap.credits.unlimited),
                inUse: false,
                status: snap.credits.unlimited || snap.credits.has_credits ? QuotaStatus.AVAILABLE : QuotaStatus.DISABLED,
              })
            : existing?.overage;

        const displayName =
          typeof snap.limit_name === "string" && snap.limit_name.trim()
            ? `Codex ${snap.limit_name.trim()}`
            : limitId === "codex"
              ? "Codex (local session)"
              : `Codex ${limitId} (local)`;

        this.passiveBuckets.set(
          bucketId,
          create(QuotaBucketSchema, {
            bucketId,
            provider: signal.profileId,
            displayName,
            windows,
            overage,
            observation: create(ObservationMetaSchema, {
              observedAt: timestampFromMs(snapObservedAt),
              source: SignalSource.RUNNER_NATIVE,
              confidence,
            }),
            labels: {
              source: "local_session",
              ...(isStale ? { stale: "true" } : {}),
              ...(snap.plan_type ? { plan: String(snap.plan_type) } : {}),
            },
          }),
        );
      }
      return;
    }

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

    // 2. Terminal ACP `sessionFailure` (`auth_required`, `quota_exhausted`, `rate_limited`, `budget_exhausted`)
    if (typeof raw.sessionFailure === "string") {
      const failure = raw.sessionFailure;
      if (failure === "auth_required") {
        const prev = this.authFailures.get(signal.profileId);
        const failures = (prev?.failures ?? 0) + 1;
        const observedAt = signal.observedAt;
        const until = observedAt + authCooldownMs(failures);
        const detail = String(raw.detail ?? "").slice(0, 300);
        this.authFailures.set(signal.profileId, { failures, observedAt, until, detail });
        return;
      }
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
  }): (ResolvedModelQuota & { unavailable: boolean }) | null {
    const now = Date.now();
    const auth = this.authStatus(query.profileId, now);
    if (auth) {
      const resolved: ResolvedModelQuota = {
        availability: AvailabilityStatus.DISABLED,
        availabilityName: "NEEDS_LOGIN",
        exhausted: false,
        effectiveRemainingRatio: null,
        bindingBucketId: `${query.profileId}:auth`,
        bindingWindowLabel: "auth",
        nextAvailableAt: auth.until,
        estimatedRequestsRemaining: 0,
        costMultiplier: null,
        overageActive: false,
        unavailableReason: "auth",
        reason: `ACP profile ${query.profileId} needs login (auth failed ${auth.failures}x; skipped until ${auth.until} or a successful session)`,
      };
      return { ...resolved, unavailable: isQuotaUnavailable(resolved) };
    }

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

    const specificFail = this.passiveExhaustedProfiles.get(`${query.profileId}:${query.wireModelId}`);
    const wildcardFail = this.passiveExhaustedProfiles.get(`${query.profileId}:*`);
    const passiveFail =
      specificFail && isPassiveFailureActive(specificFail, now)
        ? specificFail
        : wildcardFail && isPassiveFailureActive(wildcardFail, now)
          ? wildcardFail
          : undefined;
    if (passiveFail) {
      const avail =
        passiveFail.reason === "rate_limited" ? AvailabilityStatus.THROTTLED : AvailabilityStatus.EXHAUSTED;
      const resolved: ResolvedModelQuota = {
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
      return { ...resolved, unavailable: isQuotaUnavailable(resolved) };
    }

    const match = findBestModelCapacity(this.snapshot?.models ?? [], query);
    if (match) {
      const resolved = resolveModelCapacity(match, mergedBuckets, now);
      return { ...resolved, unavailable: isQuotaUnavailable(resolved) };
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
      const resolved = resolveModelCapacity(synth, mergedBuckets, now);
      return { ...resolved, unavailable: isQuotaUnavailable(resolved) };
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

    // Never assign one account/profile's quota capacity to a different profile
    if (mProf && qProf && mProf !== qProf) continue;
    const providerMatches = mProv === qProv || (mProf !== null && mProf === qProf) || mProv === "*";
    if (!providerMatches) continue;

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
