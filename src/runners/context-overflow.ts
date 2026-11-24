export interface ContextOverflowPattern {
  source: string;
  pattern: RegExp;
}

/**
 * Provider error patterns indicating that input exceeded the model's context window
 * or prompt length limit. Rate-limit and quota messages are intentionally excluded.
 */
export const CONTEXT_OVERFLOW_PATTERNS: ContextOverflowPattern[] = [
  { source: "documented:openai", pattern: /context[_ ]length[_ ]exceeded/i },
  { source: "documented:openai", pattern: /(?:this model'?s\s+)?maximum context length/i },
  { source: "documented:openai", pattern: /(?:your\s+input\s+)?exceeds the context window/i },
  { source: "documented:openai", pattern: /context window exceeded/i },
  { source: "documented:anthropic", pattern: /(?:the\s+)?prompt (?:is )?too long/i },
  { source: "documented:anthropic", pattern: /(?:the\s+)?input is too long/i },
  { source: "documented:google", pattern: /(?:the\s+)?input token count\b[^\n]*\bexceeds the maximum/i },
  { source: "documented:google", pattern: /(?:the\s+request\s+)?exceeds the maximum number of tokens/i },
  { source: "documented:provider", pattern: /model_context_window_exceeded/i },
  { source: "documented:provider", pattern: /prompt exceeds max length/i },
  { source: "documented:provider", pattern: /exceeds (?:the )?(?:available context size|maximum allowed input length)/i },
];

const ANCHORED_OVERFLOW_PATTERNS: RegExp[] = CONTEXT_OVERFLOW_PATTERNS.map(
  ({ pattern }) => new RegExp(`^(?:${pattern.source})`, pattern.flags),
);

/** Optional leading error/status prefix on a short overflow turn reply (capped at 20 chars). */
const OVERFLOW_TURN_PREFIX =
  /^(?:(?:(?:http\s+)?\d{3}|(?:api\s+)?error(?:\s*\(\d{3}\))?)(?:\s*[:\-]\s*|\s+)){1,2}/i;

const MAX_OVERFLOW_TURN_TEXT_CHARS = 600;
const MAX_OVERFLOW_TURN_PREFIX_CHARS = 20;

export function isContextOverflowError(text: string): boolean {
  if (!text) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some(({ pattern }) => pattern.test(text));
}

/**
 * Matches a generation that ended normally with only a short overflow message
 * (trimmed length 1..600, starting with an overflow pattern after an optional
 * short error/status prefix such as "Error:", "API Error:", or "400:").
 */
export function isOverflowTurnText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_OVERFLOW_TURN_TEXT_CHARS) return false;
  const prefixMatch = OVERFLOW_TURN_PREFIX.exec(trimmed);
  const body =
    prefixMatch && prefixMatch[0].length <= MAX_OVERFLOW_TURN_PREFIX_CHARS
      ? trimmed.slice(prefixMatch[0].length)
      : trimmed;
  return ANCHORED_OVERFLOW_PATTERNS.some((pattern) => pattern.test(body));
}

/**
 * Text to scan for quota signals. Uses the error alone when the child exited
 * or the error itself is a context overflow; otherwise includes stderr.
 */
export function quotaScanText(errMsg: string, stderr: string, isChildExit: boolean): string {
  if (isChildExit || isContextOverflowError(errMsg)) return errMsg;
  return `${errMsg}\n${stderr}`;
}
