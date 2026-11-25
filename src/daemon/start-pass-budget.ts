import { DEFAULT_MIGRATION_BUDGET_MS } from "../storage/migrate.js";
import { DEFAULT_BOOT_TIMEOUT_MS, resolveSupervisorBootTimeoutMs } from "./supervise.js";

/** Headroom reserved for post-migration startup, recovery, and the first supervisor ping. */
export const START_PASS_BOOT_RESERVE_MS = 10_000;

/** Minimum runnable budget for the start migration pass; below this, skip and retry next start. */
export const MIN_START_PASS_BUDGET_MS = 500;

export interface StartPassBudgetInput {
  /** Process uptime in milliseconds when the start migration pass is about to run. */
  uptimeMs: number;
  /** Environment map used to resolve the supervisor boot timeout (defaults to empty for purity). */
  env?: Record<string, string | undefined>;
  /** Configured migration pass budget in milliseconds (defaults to `DEFAULT_MIGRATION_BUDGET_MS`, 5000). */
  configuredBudgetMs?: number;
}

export type StartPassBudgetResult =
  | {
      skip: false;
      budgetMs: number;
      configuredBudgetMs: number;
      bootTimeoutMs: number;
      uptimeMs: number;
      remainingWindowMs: number;
    }
  | {
      skip: true;
      budgetMs: null;
      configuredBudgetMs: number;
      bootTimeoutMs: number;
      uptimeMs: number;
      remainingWindowMs: number;
    };

/**
 * Computes the wall-clock budget for `HarnessDaemon.start()`'s synchronous storage migration pass
 * (storage_contract_addendum_d D11):
 *   budget = min(configuredBudgetMs, bootTimeoutMs - uptimeMs - 10_000)
 *
 * When the result is below 500 ms, returns `{ skip: true, budgetMs: null }` so the daemon skips
 * the pass instead of risking a supervisor boot timeout and retries at the next start.
 */
export function computeStartPassBudget(input: StartPassBudgetInput): StartPassBudgetResult {
  const env = input.env ?? {};
  const configuredBudgetMs =
    typeof input.configuredBudgetMs === "number" &&
    Number.isFinite(input.configuredBudgetMs) &&
    input.configuredBudgetMs >= 0
      ? input.configuredBudgetMs
      : DEFAULT_MIGRATION_BUDGET_MS;

  // Supervisor fallback boots always use DEFAULT_BOOT_TIMEOUT_MS even when the env override is set.
  const bootTimeoutMs = env.PI_HARNESS_RELOAD_FAILED
    ? DEFAULT_BOOT_TIMEOUT_MS
    : resolveSupervisorBootTimeoutMs(env);

  const uptimeMs = Number.isNaN(input.uptimeMs) ? 0 : Math.max(0, input.uptimeMs);
  const remainingWindowMs = bootTimeoutMs - uptimeMs - START_PASS_BOOT_RESERVE_MS;
  const rawBudgetMs = Math.min(configuredBudgetMs, Math.floor(remainingWindowMs));

  if (rawBudgetMs < MIN_START_PASS_BUDGET_MS) {
    return {
      skip: true,
      budgetMs: null,
      configuredBudgetMs,
      bootTimeoutMs,
      uptimeMs,
      remainingWindowMs,
    };
  }

  return {
    skip: false,
    budgetMs: rawBudgetMs,
    configuredBudgetMs,
    bootTimeoutMs,
    uptimeMs,
    remainingWindowMs,
  };
}
