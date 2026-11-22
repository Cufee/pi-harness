import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RunnerProfileConfig } from "../config.js";
import type { PassiveQuotaSignal } from "../runners/types.js";

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
        byId.set(limitId, { observedAt, snapshot: { ...rl, limit_id: limitId } });
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

/** Finds up to `limit` newest `.jsonl` rollout files under `<codexHome>/sessions/YYYY/MM/DD/`. */
function findRecentCodexSessionFiles(codexHome: string, limit = 4): Array<{ path: string; mtimeMs: number }> {
  const sessionsDir = join(codexHome, "sessions");
  if (!existsSync(sessionsDir)) return [];

  const found: Array<{ path: string; mtimeMs: number }> = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 4 || found.length >= limit * 4) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort().reverse();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const full = join(dir, name);
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth + 1);
          if (found.length >= limit && depth >= 2) return;
        } else if (st.isFile() && name.endsWith(".jsonl")) {
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
  if (codexProfiles.length > 0) {
    const codexHome = opts?.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
    const files = findRecentCodexSessionFiles(codexHome, 5);
    let harvested: HarvestedCodexRateLimits | null = null;
    for (const f of files) {
      if (now - f.mtimeMs > maxAgeMs) continue;
      try {
        const tail = readFileTail(f.path);
        const parsed = parseCodexRateLimitsFromJsonl(tail, f.mtimeMs);
        if (parsed) {
          harvested = parsed;
          break;
        }
      } catch {
        // ignore unreadable session file
      }
    }
    if (harvested) {
      for (const profile of codexProfiles) {
        signals.push({
          profileId: profile.id,
          raw: { codexRateLimits: harvested.snapshots },
          observedAt: harvested.observedAt,
        });
      }
    }
  }

  return signals;
}
