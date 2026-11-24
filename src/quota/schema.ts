import { timestampDate, timestampMs } from "@bufbuild/protobuf/wkt";
import {
  AvailabilityStatus,
  QuotaStatus,
  type ModelCapacity,
  type QuotaBucket,
  type QuotaWindow,
} from "../gen/quota_pb.js";

export * from "../gen/quota_pb.js";

export interface ResolvedModelQuota {
  availability: AvailabilityStatus;
  availabilityName: string;
  exhausted: boolean;
  effectiveRemainingRatio: number | null;
  bindingBucketId: string | null;
  bindingWindowLabel: string | null;
  nextAvailableAt: string | null;
  estimatedRequestsRemaining: number | null;
  costMultiplier: number | null;
  overageActive: boolean;
  unavailableReason?: "auth" | "quota";
  reason?: string;
}

function windowRemainingRatio(w: QuotaWindow): number | null {
  if (w.unlimited) return 1.0;
  if (w.isPlaceholder) return null;
  if (w.remainingRatio !== undefined) return Math.max(0, Math.min(1, w.remainingRatio));
  if (w.usedPercent !== undefined) return Math.max(0, Math.min(1, 1 - w.usedPercent / 100));
  if (w.limit !== undefined && w.limit > 0) {
    if (w.remaining !== undefined) return Math.max(0, Math.min(1, w.remaining / w.limit));
    if (w.used !== undefined) return Math.max(0, Math.min(1, (w.limit - w.used) / w.limit));
  }
  return null;
}

/**
 * Pure deterministic scheduler resolver operating directly on generated Protobuf messages
 * (`QuotaBucket` + `ModelCapacity` from `src/gen/quota_pb.ts`).
 */
export function resolveModelCapacity(
  model: ModelCapacity,
  bucketsById: Map<string, QuotaBucket>,
  nowMs = Date.now(),
): ResolvedModelQuota {
  const bindings = model.bucketBindings;
  if (bindings.length === 0) {
    const avail =
      model.availability !== AvailabilityStatus.UNSPECIFIED
        ? model.availability
        : model.exhausted
          ? AvailabilityStatus.EXHAUSTED
          : AvailabilityStatus.UNKNOWN;
    return {
      availability: avail,
      availabilityName: AvailabilityStatus[avail] ?? "UNKNOWN",
      exhausted: Boolean(model.exhausted),
      effectiveRemainingRatio: model.effectiveRemainingRatio ?? null,
      bindingBucketId: null,
      bindingWindowLabel: null,
      nextAvailableAt: model.nextAvailableAt ? timestampDate(model.nextAvailableAt).toISOString() : null,
      estimatedRequestsRemaining: model.estimatedRequestsRemaining ?? null,
      costMultiplier: model.costMultiplier ?? null,
      overageActive: false,
      reason: model.reason,
    };
  }

  let minRatio: number | null = null;
  let bindingBucketId: string | null = null;
  let bindingWindowLabel: string | null = null;
  let maxBlockResetMs: number | null = null;
  let missingResetOnBlocker = false;
  let exhausted = false;
  let throttled = false;
  let disabled = false;
  let degraded = false;
  let overageActive = false;
  let minEstRequests: number | null = null;
  let effectiveMultiplier: number | null = model.costMultiplier ?? null;

  for (const binding of bindings) {
    const mult = binding.multiplier === undefined ? 1.0 : binding.multiplier;
    const isRequired = binding.required !== false;
    if (effectiveMultiplier === null) effectiveMultiplier = mult;

    // 0x multiplier models never block on this bucket (e.g. Copilot 0x included base models)
    if (mult === 0) continue;

    const bucket = bucketsById.get(binding.bucketId);
    if (!bucket) continue;

    if (bucket.status === QuotaStatus.DISABLED && isRequired) {
      disabled = true;
      continue;
    }

    const canOverage =
      Boolean(bucket.overage?.enabled) &&
      bucket.overage?.status !== QuotaStatus.EXHAUSTED &&
      bucket.overage?.status !== QuotaStatus.DISABLED;

    let bucketMinRatio: number | null = null;
    let bucketMinLabel: string | null = null;

    for (const w of bucket.windows) {
      if (w.binding === false || w.isPlaceholder) continue;
      const resetMs = w.resetAt ? timestampMs(w.resetAt) : null;
      if (resetMs !== null && resetMs <= nowMs) continue;

      const ratio = windowRemainingRatio(w);
      if (ratio !== null && (bucketMinRatio === null || ratio < bucketMinRatio)) {
        bucketMinRatio = ratio;
        bucketMinLabel = w.label || w.windowId;
      }

      if (w.remaining !== undefined && mult > 0) {
        const reqs = Math.floor(w.remaining / mult);
        if (minEstRequests === null || reqs < minEstRequests) minEstRequests = reqs;
      }

      const wExhausted = w.status === QuotaStatus.EXHAUSTED || (ratio !== null && ratio <= 0);
      const wThrottled = w.status === QuotaStatus.RATE_LIMITED;
      const wWarning = w.status === QuotaStatus.WARNING || (ratio !== null && ratio <= 0.15);

      if (wExhausted) {
        if (canOverage) {
          overageActive = true;
          degraded = true;
        } else if (isRequired) {
          exhausted = true;
          if (resetMs !== null) {
            maxBlockResetMs = maxBlockResetMs === null ? resetMs : Math.max(maxBlockResetMs, resetMs);
          } else {
            missingResetOnBlocker = true;
          }
        }
      } else if (wThrottled && isRequired) {
        throttled = true;
        if (resetMs !== null) {
          maxBlockResetMs = maxBlockResetMs === null ? resetMs : Math.max(maxBlockResetMs, resetMs);
        }
      } else if (wWarning) {
        degraded = true;
      }
    }

    if (bucket.windows.length === 0) {
      const bRatio =
        bucket.remainingRatio !== undefined
          ? Math.max(0, Math.min(1, bucket.remainingRatio))
          : bucket.usedPercent !== undefined
            ? Math.max(0, Math.min(1, 1 - bucket.usedPercent / 100))
            : null;
      if (bRatio !== null) {
        bucketMinRatio = bRatio;
        bucketMinLabel = bucket.displayName || bucket.bucketId;
      }
      const bResetMs = bucket.resetAt ? timestampMs(bucket.resetAt) : null;
      const stillActive = bResetMs === null || bResetMs > nowMs;
      if (stillActive && (bucket.status === QuotaStatus.EXHAUSTED || (bRatio !== null && bRatio <= 0))) {
        if (canOverage) {
          overageActive = true;
          degraded = true;
        } else if (isRequired) {
          exhausted = true;
          if (bResetMs !== null) maxBlockResetMs = maxBlockResetMs === null ? bResetMs : Math.max(maxBlockResetMs, bResetMs);
          else missingResetOnBlocker = true;
        }
      } else if (stillActive && bucket.status === QuotaStatus.WARNING) {
        degraded = true;
      }
    }

    if (bucketMinRatio !== null && (minRatio === null || bucketMinRatio < minRatio)) {
      minRatio = bucketMinRatio;
      bindingBucketId = bucket.bucketId;
      bindingWindowLabel = bucketMinLabel;
    }
  }

  let availability = AvailabilityStatus.READY;
  if (disabled) availability = AvailabilityStatus.DISABLED;
  else if (exhausted) availability = AvailabilityStatus.EXHAUSTED;
  else if (throttled) availability = AvailabilityStatus.THROTTLED;
  else if (degraded) availability = AvailabilityStatus.DEGRADED;
  else if (minRatio === null && model.availability !== AvailabilityStatus.UNSPECIFIED) availability = model.availability;

  const nextAvailableAt =
    !missingResetOnBlocker && maxBlockResetMs !== null ? new Date(maxBlockResetMs).toISOString() : null;

  return {
    availability,
    availabilityName: AvailabilityStatus[availability] ?? "UNKNOWN",
    exhausted,
    effectiveRemainingRatio: minRatio,
    bindingBucketId,
    bindingWindowLabel,
    nextAvailableAt,
    estimatedRequestsRemaining: minEstRequests ?? model.estimatedRequestsRemaining ?? null,
    costMultiplier: effectiveMultiplier,
    overageActive,
    reason: model.reason,
  };
}
