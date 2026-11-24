export type AcpProfileErrorKind = "auth_required" | "tools_missing";

/**
 * Matches error text or transport/RPC messages indicating an ACP profile
 * needs interactive authentication before it can run sessions.
 */
export const ACP_AUTH_TEXT_RE =
  /authentication required|auth_required|not (?:logged|signed) in|please (?:run )?\/?login|invalid api key|unauthenticated|login required/i;

const AUTH_STATUS_PREFIX =
  "(?:authentication\\s+(?:required|failed)|auth_required|login\\s+(?:required|expired)|session\\s+expired|invalid(?:\\s+or\\s+missing)?\\s+api\\s+key|no\\s+api\\s+key\\s+found|unauthenticated|unauthorized|(?:you\\s+are\\s+)?not\\s+(?:logged|signed)\\s+in)";

const STANDALONE_AUTH_STATUS =
  "(?:authentication\\s+(?:required|failed)|auth_required|login\\s+(?:required|expired)|invalid(?:\\s+or\\s+missing)?\\s+api\\s+key|no\\s+api\\s+key\\s+found|unauthenticated|(?:you\\s+are\\s+)?not\\s+(?:logged|signed)\\s+in)";

const LOGIN_CMD = "[`'\"]?(?:\\/login|amp\\s+login)[`'\"]?";

const SHORT_AUTH_SUFFIX =
  "(?:\\s+(?:first|again|to\\s+(?:continue|proceed|sign\\s*in|log\\s*in|authenticate|re-?authenticate)))?(?:\\s+and\\s+(?:try\\s+again|retry))?";

const LOGIN_REMEDIATION =
  `(?:(?:please\\s+)?run\\s+${LOGIN_CMD}|(?:please\\s+)?(?:log\\s*in|sign\\s*in)(?:\\s+(?:with|using)\\s+${LOGIN_CMD})?|(?:please\\s+)?(?:authenticate|re-?authenticate)|fix\\s+external\\s+api\\s+key)${SHORT_AUTH_SUFFIX}`;

const STANDALONE_LOGIN_REMEDIATION =
  `(?:(?:please\\s+)?run\\s+${LOGIN_CMD}|(?:please\\s+)?(?:log\\s*in|sign\\s*in)\\s+(?:with|using)\\s+${LOGIN_CMD})${SHORT_AUTH_SUFFIX}`;

const AUTH_DIAG_SEP = "\\s*[·:\\-.–—\\n]\\s*";
const AUTH_DIAG_END = "\\s*[.!]?$";

const STANDALONE_AUTH_DIAGNOSTIC_PATTERNS: readonly RegExp[] = [
  // Status prefix + separator + known login remediation (e.g. "Invalid API key · Please run /login",
  // "Not logged in · Please run /login", "Not logged in. Run 'amp login' to sign in.").
  new RegExp(`^(?:error:\\s*)?${AUTH_STATUS_PREFIX}${AUTH_DIAG_SEP}${LOGIN_REMEDIATION}${AUTH_DIAG_END}`, "i"),
  // Standalone login command diagnostic (e.g. "Please run /login", "Run 'amp login' to continue.").
  new RegExp(`^(?:error:\\s*)?${STANDALONE_LOGIN_REMEDIATION}${AUTH_DIAG_END}`, "i"),
  // Standalone auth status diagnostic (e.g. "Authentication required.", "Not logged in", "No API key found.").
  new RegExp(`^(?:error:\\s*)?${STANDALONE_AUTH_STATUS}${SHORT_AUTH_SUFFIX}${AUTH_DIAG_END}`, "i"),
  // Explicit Amp login requirement (e.g. "You must be logged in to use Amp. Run 'amp login'.").
  new RegExp(
    `^(?:error:\\s*)?you\\s+must\\s+(?:be\\s+logged\\s+in|log\\s+in)(?:\\s+(?:first|to\\s+(?:continue|proceed|use\\s+amp)))?(?:${AUTH_DIAG_SEP}(?:please\\s+)?run\\s+[\`'"]?amp\\s+login[\`'"]?|\\s+(?:with|using)\\s+[\`'"]?amp\\s+login[\`'"]?)${SHORT_AUTH_SUFFIX}${AUTH_DIAG_END}`,
    "i",
  ),
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
 * Matches only whole standalone adapter login diagnostics emitted as plain assistant
 * text (with optional trailing punctuation and recognized short suffixes, never prose).
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
