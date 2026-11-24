import type { Notice } from "./types.js";

/** Maximum words across what + why + alternative (tag excluded). */
export const WORD_BUDGET = 60;

export function formatNotice(n: Notice): string {
  if (n.level === "rejection") {
    return `[harness blocked: ${n.rule}] ${n.what} Why: ${n.why} Allowed: ${n.alternative}`;
  }
  return `[harness advisory: ${n.rule}] ${n.what} Why: ${n.why} Instead: ${n.alternative}`;
}

export function countWords(n: Notice): number {
  const combined = `${n.what} ${n.why} ${n.alternative}`.trim();
  if (!combined) return 0;
  return combined.split(/\s+/).length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function attachNotices(result: unknown, notices: Notice[]): { result: unknown; attached: boolean } {
  if (notices.length === 0) {
    return { result, attached: false };
  }
  if (isPlainObject(result)) {
    const formatted = notices.map(formatNotice);
    const existing = Array.isArray(result.harness_advisory)
      ? result.harness_advisory.filter((item): item is string => typeof item === "string")
      : [];
    return {
      result: { ...result, harness_advisory: [...existing, ...formatted] },
      attached: true,
    };
  }
  return { result, attached: false };
}

/** Rollover mechanics, not an advisory rule. Runners call it. Tier 3 has no request_rollover, so it gets its own alternative. */
export function contextWarningNotice(tier: 1 | 2 | 3, pct: number, limitPct: number): Notice {
  const what = `Context is at ${pct}%, and the harness starts a fresh session at ${limitPct}%.`;
  const why = "Anything that is not in a handoff or an artifact is lost at the rollover.";
  const alternative =
    tier === 3
      ? "Save findings that are not yet in a dossier with artifact_write now. You continue from your dossiers after the rollover. If your answer is ready, call return_task."
      : "Finish the current step, then call request_rollover with an anchored handoff (goal_invariants, architectural_decisions, active_risks, next_actions).";
  return {
    level: "advisory",
    rule: "context-rollover",
    what,
    why,
    alternative,
  };
}

export function contextWarningText(tier: 1 | 2 | 3, pct: number, limitPct: number): string {
  return formatNotice(contextWarningNotice(tier, pct, limitPct));
}
