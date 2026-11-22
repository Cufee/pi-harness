import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

export interface FormattedAgentError {
  headline: string;
  detail?: string;
  logPath?: string;
}

/**
 * Strips raw subprocess stderr noise (`[session/create] phase=...`, stack frames, JSON-RPC wrappers)
 * from user-facing TUI errors while persisting full raw diagnostics to `~/.pi-harness/logs/errors/*.log`.
 */
export function formatAgentError(err: unknown, opts?: { stateDir?: string; context?: string }): FormattedAgentError {
  const raw = err instanceof Error ? `${err.message}${err.stack ? `\n\n${err.stack}` : ""}` : String(err);

  let logPath: string | undefined;
  if (opts?.stateDir) {
    try {
      const logDir = join(opts.stateDir, "logs", "errors");
      mkdirSync(logDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const id = randomBytes(2).toString("hex");
      logPath = join(logDir, `${ts}-${id}.log`);
      writeFileSync(
        logPath,
        `Time: ${new Date().toISOString()}\nContext: ${opts.context ?? "tui"}\n\n${raw}\n`,
        "utf8",
      );
    } catch {
      logPath = undefined;
    }
  }

  // Strip trailing `(stderr: ...)` diagnostic dumps before extracting headline
  const msgOnly = (err instanceof Error ? err.message : String(err))
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\s*\(stderr:[\s\S]*$/i, "")
    .trim();

  // Strip noisy wrapper prefixes (`ACP runner (acp:claude) failed: Internal error: `)
  const cleanHeadline = msgOnly
    .replace(/^ACP runner \(([^)]+)\) failed:\s*/i, "[$1] ")
    .replace(/Internal error:\s*/gi, "")
    .split("\n")[0]!
    .trim();

  // Add actionable hint for common real-world billing / auth / missing-CLI failures
  let detail: string | undefined;
  if (/spend limit|usage-credits|quota|rate limit|429/i.test(cleanHeadline)) {
    detail = "Switch to another enabled CLI/model via /model or check /quota.";
  } else if (/auth|login|unauthorized|401|api key/i.test(cleanHeadline)) {
    detail = "Run your CLI's login command out of band, or pick another profile in /settings.";
  } else if (/ENOENT|not found/i.test(cleanHeadline)) {
    detail = "CLI binary not found on PATH — verify or disable it in /settings (Ctrl+,).";
  }

  return {
    headline: cleanHeadline || "Unexpected error",
    detail,
    logPath,
  };
}
