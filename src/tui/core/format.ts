import { sanitizeLine } from "./text.js";

/** Formats elapsed/duration milliseconds concisely (`420ms`, `14s`, `3m 12s`, `2h 05m`). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hrs = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hrs < 24) return min > 0 ? `${hrs}h ${String(min).padStart(2, "0")}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days}d`;
}

/** Formats relative age since a timestamp (`just now`, `4m ago`, `2h ago`, `3d ago`). */
export function formatAge(tsMs: number, now = Date.now()): string {
  const diff = Math.max(0, now - tsMs);
  if (diff < 5_000) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Formats a future ISO timestamp or epoch ms as a countdown (`in 14m`, `in 2h 10m`, `due`). */
export function formatCountdown(target: string | number | null | undefined, now = Date.now()): string {
  if (target == null) return "—";
  const ms = typeof target === "number" ? target : Date.parse(target);
  if (!Number.isFinite(ms)) return "—";
  const remaining = ms - now;
  if (remaining <= 0) return "due";
  return `in ${formatDuration(remaining)}`;
}

/** Formats `HH:MM:SS` local clock time. */
export function formatClock(tsMs: number): string {
  const d = new Date(tsMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Formats byte counts (`512B`, `4.2KB`, `1.8MB`). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0B";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** Parses human duration strings like `30s`, `15m`, `2 hours`, `1h30m`, `in 45m` into ms. Rejects negatives & trailing garbage. */
export function parseDurationMs(input: string): number | null {
  const trimmed = input.trim().toLowerCase().replace(/^in\s+/, "");
  if (!trimmed || trimmed.startsWith("-")) return null;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const mins = Number(trimmed);
    return mins > 0 ? Math.round(mins * 60_000) : null;
  }
  const tokenRx = /(\d+(?:\.\d+)?)\s*(ms|milliseconds?|secs?|seconds?|s|mins?|minutes?|m|hrs?|hours?|h|days?|d)(?![a-z])/g;
  let total = 0;
  let matchedChars = 0;
  let count = 0;
  for (const m of trimmed.matchAll(tokenRx)) {
    const val = Number(m[1]);
    const unit = m[2]!;
    if (!Number.isFinite(val) || val <= 0) return null;
    count += 1;
    matchedChars += m[0].length;
    if (unit === "ms" || unit.startsWith("millisecond")) total += val;
    else if (unit.startsWith("s")) total += val * 1_000;
    else if (unit.startsWith("m")) total += val * 60_000;
    else if (unit.startsWith("h")) total += val * 3_600_000;
    else if (unit.startsWith("d")) total += val * 86_400_000;
  }
  // Reject any leftover non-whitespace / non-separator characters (e.g. "1h garbage" or "-5m")
  const stripped = trimmed.replace(tokenRx, "").replace(/[\s,]+/g, "");
  if (count === 0 || matchedChars === 0 || stripped.length > 0) return null;
  return total > 0 ? Math.round(total) : null;
}

/** Strips redundant MCP prefixes (`mcp__harness__`) and cleans tool labels for compact UI pills. */
export function formatToolLabel(raw: string): string {
  return sanitizeLine(raw).replace(/^mcp__[^_]+__/, "").replace(/^harness__/, "");
}

/** Returns sanitized first non-empty line of a multiline string. */
export function firstLine(raw: string | null | undefined, maxLen = 140): string {
  if (!raw) return "";
  const line = sanitizeLine(raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? raw);
  return line.length > maxLen ? `${line.slice(0, Math.max(1, maxLen - 1))}…` : line;
}

/** Formats USD amounts cleanly (`$0.04`, `$1.25`, `—`). */
export function formatUsd(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
