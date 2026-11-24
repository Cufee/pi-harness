import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  CONTEXT_OVERFLOW_PATTERNS,
  isContextOverflowError,
  isOverflowTurnText,
  quotaScanText,
} from "../src/runners/context-overflow.js";
import { detectQuotaErrorText } from "../src/runners/quota-detect.js";

describe("goal-14 slice B2o: context-overflow matcher", () => {
  it("T5-5: matches documented provider overflow strings, rejects rate-limit/quota strings, and guards isOverflowTurnText against quoting replies", () => {
    assert.ok(CONTEXT_OVERFLOW_PATTERNS.length > 0);
    for (const entry of CONTEXT_OVERFLOW_PATTERNS) {
      assert.ok(entry.source.trim().length > 0, "Each pattern must carry a source label");
      assert.ok(entry.pattern instanceof RegExp);
    }

    const positiveCases: Array<{ source: string; text: string }> = [
      { source: "documented:openai", text: "Error: context_length_exceeded: This model's maximum context length is 128000 tokens." },
      { source: "documented:openai", text: "Your input exceeds the context window of this model. Please adjust your input and try again." },
      { source: "documented:openai", text: "Requested token count exceeds the model's maximum context length of 131072 tokens." },
      { source: "documented:openai", text: "litellm.ContextWindowExceededError: Context Window exceeded for given call." },
      { source: "documented:anthropic", text: "prompt is too long: 250000 tokens > 200000 maximum" },
      { source: "documented:anthropic", text: "Prompt is too long" },
      { source: "documented:anthropic", text: "ValidationException: Input is too long for requested model." },
      { source: "documented:google", text: "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)." },
      { source: "documented:provider", text: "model_context_window_exceeded" },
      { source: "documented:provider", text: "the request exceeds the available context size, try increasing it" },
      { source: "documented:provider", text: "Prompt exceeds max length" },
    ];

    for (const row of positiveCases) {
      assert.equal(
        isContextOverflowError(row.text),
        true,
        `Expected overflow match for [${row.source}]: ${row.text}`,
      );
    }

    const negativeCases: string[] = [
      "",
      "   ",
      "429 Too Many Requests",
      "Rate limit reached for gpt-4o in organization org-123 on tokens per min (TPM): Limit 30000, Used 29500, Requested 1000.",
      "Request too large for model gpt-4o on tokens per min (TPM): Limit 30000, Requested 35000",
      "Error: rate_limit_error: Number of request tokens has exceeded your per-minute rate limit.",
      "insufficient_quota: You exceeded your current quota, please check your plan and billing details.",
      "quota_exhausted: daily usage limit reached, resets at 2026-11-25T00:00:00Z",
      "overloaded_error: Service temporarily overloaded",
      "RESOURCE_EXHAUSTED: Quota exceeded for quota metric 'GenerateContentRequests'",
      "ThrottlingException: Too many tokens, please wait before trying again.",
      "billing hard limit reached",
      "budget_exhausted",
    ];

    for (const text of negativeCases) {
      assert.equal(isContextOverflowError(text), false, `Must NOT match non-overflow text: ${text}`);
    }

    // isOverflowTurnText positive cases (short turn ending directly with overflow error)
    const positiveTurnTexts = [
      "Prompt is too long",
      "Error: prompt is too long: 250000 tokens > 200000 maximum",
      "API Error: context_length_exceeded",
      "API Error (400): prompt is too long",
      "400: maximum context length exceeded",
      "HTTP 400: Your input exceeds the context window of this model.",
      "This model's maximum context length is 128000 tokens.",
      "The input token count (1196265) exceeds the maximum number of tokens allowed (1048575).",
    ];
    for (const text of positiveTurnTexts) {
      assert.equal(isOverflowTurnText(text), true, `Expected isOverflowTurnText match: ${text}`);
    }

    // isOverflowTurnText negative cases (R3: quoting replies, empty, long, quota/rate-limit)
    const negativeTurnTexts = [
      "",
      "   ",
      "Fixed handling of context_length_exceeded in the ACP runner; tests pass.",
      "Done. The handler now catches prompt is too long errors cleanly.",
      `Summary: ${"x".repeat(5000)} context_length_exceeded`,
      `Prompt is too long: ${"x".repeat(650)}`,
      "Error: 429 Too Many Requests",
      "Request too large for model gpt-4o on tokens per min (TPM)",
    ];
    for (const text of negativeTurnTexts) {
      assert.equal(isOverflowTurnText(text), false, `Must NOT match isOverflowTurnText: ${text.slice(0, 80)}`);
    }

    // quotaScanText: excludes stderr when error itself is an overflow or child exited
    const noisyStderr = "previous warning: 429 rate limit exceeded, retry in 10s";
    const overflowErr = "API Error: prompt is too long: 250000 tokens > 200000 maximum";
    const overflowScan = quotaScanText(overflowErr, noisyStderr, false);
    assert.equal(overflowScan, overflowErr);
    assert.equal(detectQuotaErrorText(overflowScan).isQuota, false);

    const plainErr = "unexpected socket hangup";
    const plainScan = quotaScanText(plainErr, noisyStderr, false);
    assert.ok(plainScan.includes(noisyStderr));
    assert.equal(detectQuotaErrorText(plainScan).isQuota, true);

    const exitScan = quotaScanText(plainErr, noisyStderr, true);
    assert.equal(exitScan, plainErr);
  });
});
