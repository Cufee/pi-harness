export type AcpProfileErrorKind = "auth_required" | "tools_missing";

/**
 * Matches error text or logged-out assistant responses indicating an ACP profile
 * needs interactive authentication before it can run sessions.
 */
export const ACP_AUTH_TEXT_RE =
  /authentication required|auth_required|not (?:logged|signed) in|please (?:run )?\/?login|invalid api key|unauthenticated|login required/i;

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
