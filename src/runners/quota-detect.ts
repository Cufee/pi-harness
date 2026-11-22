export interface DetectedQuotaError {
  isQuota: boolean;
  /** True for hard spend/quota exhaustion; false for transient 429 / pool rotation throttling. */
  isHardExhaustion: boolean;
  retryAfterSec?: number;
  resetAtIso?: string;
  summary: string;
}

const HARD_QUOTA_PATTERNS: RegExp[] = [
  /individual spend limit/i,
  /spend limit/i,
  /usage[- ]credits/i,
  /insufficient[_\s-]quota/i,
  /quota[_\s-]exhausted/i,
  /quota exceeded/i,
  /budget[_\s-]exhausted/i,
  /hit your (?:usage |daily |weekly |five[- ]hour )?limit/i,
  /usage limit reached/i,
  /out of (?:usage|quota|credits)/i,
  /billing hard limit/i,
  /plan limit reached/i,
];

const TRANSIENT_RATE_LIMIT_PATTERNS: RegExp[] = [
  /\b429\b/,
  /too many requests/i,
  /rate[_\s-]?limit(?:ed|ing)?/i,
  /\boverloaded(?:_error)?\b/i,
  /\bthrottl(?:ed|ing)\b/i,
  /capacity[_\s-]?exhausted/i,
  /resource[_\s-]?exhausted/i,
  /service temporarily overloaded/i,
];

/**
 * Inspects error messages, stderr chunks, or ACP failure codes for quota / 429 rate-limit signals
 * and extracts any `Retry-After` seconds or ISO reset timestamp.
 */
export function detectQuotaErrorText(text: string): DetectedQuotaError {
  const cleaned = text.trim();
  if (!cleaned) {
    return { isQuota: false, isHardExhaustion: false, summary: "" };
  }

  const isHard = HARD_QUOTA_PATTERNS.some((rx) => rx.test(cleaned));
  const isTransient = TRANSIENT_RATE_LIMIT_PATTERNS.some((rx) => rx.test(cleaned));
  if (!isHard && !isTransient) {
    return { isQuota: false, isHardExhaustion: false, summary: "" };
  }

  // Try to parse Retry-After / "retry in X s/m" hints
  let retryAfterSec: number | undefined;
  const retryHeader = cleaned.match(/retry[- ]after[:=\s]+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes)?/i);
  const retryPhrase = cleaned.match(/(?:try again|retry|reset(?:s)?|available)\s+in\s+(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes|h|hr|hours)\b/i);
  const match = retryHeader ?? retryPhrase;
  if (match) {
    const val = Number(match[1]);
    const unit = (match[2] ?? "s").toLowerCase();
    if (Number.isFinite(val) && val > 0) {
      if (unit === "ms") retryAfterSec = Math.max(1, Math.ceil(val / 1000));
      else if (unit.startsWith("m")) retryAfterSec = Math.ceil(val * 60);
      else if (unit.startsWith("h")) retryAfterSec = Math.ceil(val * 3600);
      else retryAfterSec = Math.ceil(val);
    }
  }

  // Try to parse an explicit ISO-8601 timestamp (e.g. `2026-11-22T01:00:00Z`)
  let resetAtIso: string | undefined;
  const isoMatch = cleaned.match(/\b(20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\b/);
  if (isoMatch) {
    const parsed = Date.parse(isoMatch[1]!);
    if (Number.isFinite(parsed) && parsed > Date.now()) {
      resetAtIso = new Date(parsed).toISOString();
    }
  }
  if (!resetAtIso && retryAfterSec) {
    resetAtIso = new Date(Date.now() + retryAfterSec * 1000).toISOString();
  }

  // Produce a concise 1-line summary (first matching line)
  const firstLine =
    cleaned
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => HARD_QUOTA_PATTERNS.some((rx) => rx.test(l)) || TRANSIENT_RATE_LIMIT_PATTERNS.some((rx) => rx.test(l))) ??
    cleaned.split(/\r?\n/)[0] ??
    "Rate limit / quota reached";

  return {
    isQuota: true,
    isHardExhaustion: isHard,
    retryAfterSec,
    resetAtIso,
    summary: firstLine.slice(0, 220),
  };
}
