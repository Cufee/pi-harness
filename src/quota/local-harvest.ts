import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { interpolateEnv, type RunnerProfileConfig } from "../config.js";
import type { PassiveQuotaSignal } from "../runners/types.js";

/** Harvested local snapshots older than 6 hours are treated as stale rather than authoritative. */
export const LOCAL_QUOTA_FRESHNESS_MS = 6 * 60 * 60 * 1000;

export interface CodexRateLimitWindowRaw {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

export interface CodexRateLimitsRaw {
  limit_id?: string | null;
  limit_name?: string | null;
  primary?: CodexRateLimitWindowRaw | null;
  secondary?: CodexRateLimitWindowRaw | null;
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: string | number | null;
  } | null;
  plan_type?: string | null;
  /** Per-snapshot observation timestamp (ms since epoch) when merged across session files */
  observedAt?: number;
  /** True when snapshot age exceeds `LOCAL_QUOTA_FRESHNESS_MS` (> 6h) */
  stale?: boolean;
}

export interface HarvestedCodexRateLimits {
  observedAt: number;
  snapshots: CodexRateLimitsRaw[];
}

/**
 * Parses the latest Codex `rate_limits` snapshot(s) per `limit_id` from a Codex session JSONL tail.
 * Pure helper so unit tests can validate parsing without reading the user's home directory.
 */
export function parseCodexRateLimitsFromJsonl(jsonlText: string, fallbackObservedAt = Date.now()): HarvestedCodexRateLimits | null {
  const byId = new Map<string, { observedAt: number; snapshot: CodexRateLimitsRaw }>();
  const lines = jsonlText.split("\n");

  for (const line of lines) {
    if (!line.includes("rate_limits")) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      const payload = (parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed) as Record<string, unknown>;
      const rl = payload.rate_limits as CodexRateLimitsRaw | null | undefined;
      if (!rl || typeof rl !== "object") continue;
      if (!rl.primary && !rl.secondary && !rl.credits) continue;

      const tsRaw = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
      const observedAt = Number.isFinite(tsRaw) ? tsRaw : fallbackObservedAt;
      const limitId = (typeof rl.limit_id === "string" && rl.limit_id.trim()) || "codex";
      const prev = byId.get(limitId);
      if (!prev || observedAt >= prev.observedAt) {
        byId.set(limitId, { observedAt, snapshot: { ...rl, limit_id: limitId, observedAt } });
      }
    } catch {
      // Ignore partial first line when reading from tail offset or malformed lines
    }
  }

  if (byId.size === 0) return null;
  let newestTs = 0;
  const snapshots: CodexRateLimitsRaw[] = [];
  for (const entry of byId.values()) {
    if (entry.observedAt > newestTs) newestTs = entry.observedAt;
    snapshots.push(entry.snapshot);
  }
  return { observedAt: newestTs || fallbackObservedAt, snapshots };
}

/** Reads at most `maxBytes` from the end of a file (fast O(1) tail read for large session JSONLs). */
function readFileTail(path: string, maxBytes = 256 * 1024): string {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    if (len <= 0) return "";
    const buf = Buffer.allocUnsafe(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * Finds up to `limit` newest `.jsonl` rollout files under `<codexHome>/sessions/YYYY/MM/DD/`.
 * Collects candidate files within `maxAgeMs` across date folders and sorts by `mtimeMs` descending
 * BEFORE capping so an active session started yesterday is never pruned out by today's sessions.
 */
function findRecentCodexSessionFiles(
  codexHome: string,
  limit = 12,
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  now = Date.now(),
): Array<{ path: string; mtimeMs: number }> {
  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return [];

  const cutoffDate = new Date(now - maxAgeMs);
  const cutoffYear = cutoffDate.getUTCFullYear();
  const cutoffYm = cutoffYear * 100 + (cutoffDate.getUTCMonth() + 1);
  const cutoffYmd = cutoffYm * 100 + cutoffDate.getUTCDate();

  const found: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number, y?: number, m?: number) => {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const num = /^\d+$/.test(name) ? Number(name) : NaN;
      if (depth === 0 && !Number.isNaN(num) && num < cutoffYear) continue;
      if (depth === 1 && y !== undefined && !Number.isNaN(num) && y * 100 + num < cutoffYm) continue;
      if (depth === 2 && y !== undefined && m !== undefined && !Number.isNaN(num) && (y * 100 + m) * 100 + num < cutoffYmd) {
        continue;
      }
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1, depth === 0 && !Number.isNaN(num) ? num : y, depth === 1 && !Number.isNaN(num) ? num : m);
        } else if (st.isFile() && name.endsWith(".jsonl") && now - st.mtimeMs <= maxAgeMs) {
          found.push({ path: full, mtimeMs: st.mtimeMs });
        }
      } catch {
        // ignore unreadable entries
      }
    }
  };

  walk(sessionsDir, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

function resolveProfileCodexHome(profile: RunnerProfileConfig, fallbackHome?: string): string {
  const raw = profile.kind === "acp" ? profile.env?.CODEX_HOME?.trim() : undefined;
  if (raw) {
    const expanded = interpolateEnv(raw).trim();
    if (expanded.startsWith("~/")) return join(homedir(), expanded.slice(2));
    if (expanded === "~") return homedir();
    if (expanded) return expanded;
  }
  return fallbackHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function harvestCodexHome(codexHome: string, maxAgeMs: number, now: number): HarvestedCodexRateLimits | null {
  const files = findRecentCodexSessionFiles(codexHome, 12, maxAgeMs, now);
  const mergedById = new Map<string, { observedAt: number; snapshot: CodexRateLimitsRaw }>();

  for (const f of files) {
    if (now - f.mtimeMs > maxAgeMs) continue;
    try {
      const tail = readFileTail(f.path);
      const parsed = parseCodexRateLimitsFromJsonl(tail, f.mtimeMs);
      if (!parsed) continue;
      for (const snap of parsed.snapshots) {
        const limitId = (typeof snap.limit_id === "string" && snap.limit_id.trim()) || "codex";
        const obs = typeof snap.observedAt === "number" && Number.isFinite(snap.observedAt)
          ? snap.observedAt
          : parsed.observedAt;
        const prev = mergedById.get(limitId);
        if (!prev || obs > prev.observedAt) {
          mergedById.set(limitId, {
            observedAt: obs,
            snapshot: {
              ...snap,
              limit_id: limitId,
              observedAt: obs,
              stale: now - obs > LOCAL_QUOTA_FRESHNESS_MS,
            },
          });
        }
      }
    } catch {
      // ignore unreadable session file
    }
  }

  if (mergedById.size === 0) return null;
  let newestTs = 0;
  const snapshots: CodexRateLimitsRaw[] = [];
  for (const entry of mergedById.values()) {
    if (entry.observedAt > newestTs) newestTs = entry.observedAt;
    snapshots.push(entry.snapshot);
  }
  return { observedAt: newestTs, snapshots };
}

/**
 * Passively harvests locally available CLI/session quota snapshots when no external Quota Endpoint
 * is configured (or to complement one). Currently harvests Codex CLI / `codex-acp` session JSONL
 * `rate_limits` (primary/secondary windows + reset timestamps + credits). Adapters without local
 * quota storage (such as generic/local ACPs) are skipped cleanly with zero errors.
 */
export function harvestLocalQuotaSignals(
  profiles: RunnerProfileConfig[],
  opts?: { codexHome?: string; maxAgeMs?: number },
): PassiveQuotaSignal[] {
  const signals: PassiveQuotaSignal[] = [];
  const maxAgeMs = opts?.maxAgeMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const codexProfiles = profiles.filter((p) => p.enabled !== false && p.kind === "acp" && p.adapter === "codex");
  const cacheByHome = new Map<string, HarvestedCodexRateLimits | null>();

  for (const profile of codexProfiles) {
    const codexHome = resolveProfileCodexHome(profile, opts?.codexHome);
    let harvested = cacheByHome.get(codexHome);
    if (harvested === undefined) {
      harvested = harvestCodexHome(codexHome, maxAgeMs, now);
      cacheByHome.set(codexHome, harvested);
    }
    if (harvested) {
      signals.push({
        profileId: profile.id,
        raw: { codexRateLimits: harvested.snapshots },
        observedAt: harvested.observedAt,
      });
    }
  }

  return signals;
}
