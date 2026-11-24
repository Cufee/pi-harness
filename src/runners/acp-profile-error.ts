export type AcpProfileErrorKind = "auth_required" | "tools_missing";

/**
 * Matches error text or transport/RPC messages indicating an ACP profile
 * needs interactive authentication before it can run sessions.
 */
export const ACP_AUTH_TEXT_RE =
  /authentication required|auth_required|not (?:logged|signed) in|please (?:run )?\/?login|invalid api key|unauthenticated|login required/i;

const STANDALONE_AUTH_DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
  // Claude CLI /login diagnostics (e.g. "Invalid API key · Please run /login",
  // "Not logged in · Please run /login", "Please run /login").
  /^(?:error:\s*)?(?:(?:invalid\s+api\s+key|not\s+(?:logged|signed)\s+in|session\s+expired|login\s+expired|authentication\s+(?:required|failed)|unauthorized|unauthenticated)\s*[·:\-.–—\n]\s*)?(?:please\s+)?run\s+[`'"]?\/login[`'"]?(?:\b|$)/i,
  // Amp CLI login diagnostics (e.g. "Invalid or missing API key. Run 'amp login'", "No API key found").
  /^(?:error:\s*)?(?:(?:invalid\s+or\s+missing\s+api\s+key|no\s+api\s+key\s+found|not\s+(?:logged|signed)\s+in|authentication\s+(?:required|failed)|login\s+required|unauthorized|unauthenticated)\s*[·:\-.–—\n]\s*)?(?:please\s+)?run\s+[`'"]?amp\s+login[`'"]?(?:\b|$)/i,
  /^(?:error:\s*)?(?:invalid\s+or\s+missing\s+api\s+key|no\s+api\s+key\s+found)(?:\s*[.:·\-–—!\n]|$)/i,
  /^(?:error:\s*)?(?:please\s+)?(?:log\s*in|sign\s*in)\s+(?:with|using)\s+[`'"]?amp\s+login[`'"]?(?:\b|$)/i,
  /^(?:error:\s*)?you\s+must\s+(?:be\s+logged\s+in|log\s+in)\b.*\bamp\s+login\b/i,
  // Standalone start-anchored auth failure diagnostics (whole short message or followed by login remediation, never prose).
  /^(?:error:\s*)?(?:authentication\s+(?:required|failed)|auth_required|login\s+required|invalid\s+api\s+key|unauthenticated)\s*(?:[.!]|$)/i,
  /^(?:error:\s*)?(?:authentication\s+(?:required|failed)|auth_required|login\s+required|invalid\s+api\s+key|unauthenticated)\s*[·:\-.–—\n]\s*(?:please\s+)?(?:run\s+[`'"]?(?:\/login|amp\s+login|claude|codex|gemini)[`'"]?|log\s*in|sign\s*in|authenticate|re-?authenticate|fix\b|set\b|check\b|invalid\b|missing\b|expired\b|no\s+api\s+key\b)/i,
  /^(?:error:\s*)?(?:you\s+are\s+)?not\s+(?:logged|signed)\s+in\s*(?:[.!]|$)/i,
  /^(?:error:\s*)?(?:you\s+are\s+)?not\s+(?:logged|signed)\s+in\s*[·:\-.–—\n]\s*(?:please\s+)?(?:run\s+[`'"]?(?:\/login|amp\s+login|claude|codex|gemini)[`'"]?|log\s*in|sign\s*in|authenticate)\b/i,
];

const STRUCTURED_AUTH_FAILURE_CODES = new Set([
  "auth_required",
  "authentication_required",
  "unauthenticated",
  "unauthorized",
  "invalid_api_key",
  "login_required",
  "not_authenticated",
]);

/**
 * Matches only standalone, start-anchored adapter login diagnostics emitted as plain
 * assistant text (never substrings inside ordinary prose).
 */
export function isStandaloneAcpAuthDiagnostic(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length >= 400) return false;
  return STANDALONE_AUTH_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** True when a structured ACP `sessionFailure` code indicates missing or expired auth. */
export function isStructuredAuthFailureCode(code: string): boolean {
  return STRUCTURED_AUTH_FAILURE_CODES.has(code.trim().toLowerCase());
}

/** Returns profile-specific login advice without naming wrapper executables such as `npx`. */
export function acpProfileLoginHint(
  profileId: string,
  opts?: { adapter?: string; isAmp?: boolean },
): string {
  if (profileId === "acp:amp" || opts?.isAmp) {
    return "run 'amp login'";
  }
  if (profileId === "acp:claude" || opts?.adapter === "claude") {
    return "run 'claude' then /login";
  }
  return `log in to the agent behind profile ${profileId}`;
}

export class AcpProfileError extends Error {
  constructor(
    readonly kind: AcpProfileErrorKind,
    readonly profileId: string,
    message: string,
  ) {
    super(message);
    this.name = "AcpProfileError";
  }
}

function hasAuthRequiredRpcCode(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 4; depth++) {
    try {
      const obj = cur as {
        code?: unknown;
        data?: unknown;
        error?: unknown;
        cause?: unknown;
      };
      const candidates: unknown[] = [obj.code];
      if (obj.data && typeof obj.data === "object") {
        const data = obj.data as { code?: unknown; error?: unknown };
        candidates.push(data.code);
        if (data.error && typeof data.error === "object") {
          candidates.push((data.error as { code?: unknown }).code);
        }
      }
      if (obj.error && typeof obj.error === "object") {
        const inner = obj.error as { code?: unknown; data?: unknown };
        candidates.push(inner.code);
        if (inner.data && typeof inner.data === "object") {
          candidates.push((inner.data as { code?: unknown }).code);
        }
      }
      if (candidates.includes(-32000)) return true;
      cur = obj.cause;
    } catch {
      break;
    }
  }
  return false;
}

/**
 * Classifies an ACP failure as an authentication error when the error carries
 * JSON-RPC code `-32000` (direct or nested under `data`/`error`/`cause`) or
 * when `errMsg` matches `ACP_AUTH_TEXT_RE`.
 */
export function isAcpAuthError(err: unknown, errMsg: string): boolean {
  if (hasAuthRequiredRpcCode(err)) return true;
  return typeof errMsg === "string" && ACP_AUTH_TEXT_RE.test(errMsg);
}
