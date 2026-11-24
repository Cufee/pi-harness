import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogCompiler, recommendModelsByTaskKind, routingSkips } from "../src/catalog/compiler.js";
import { RANKING_COHORT } from "../src/catalog/sources.js";
import { loadConfig, type HarnessConfig, type RunnerProfileConfig } from "../src/config.js";
import { resolveLaunchRoute } from "../src/control-plane/launch-route.js";
import { buildDirectorSystemPrompt } from "../src/director/session.js";
import { AvailabilityStatus } from "../src/gen/quota_pb.js";
import {
  AUTH_COOLDOWN_BASE_MS,
  AUTH_COOLDOWN_MAX_MS,
  authCooldownMs,
  isQuotaUnavailable,
  QuotaClient,
} from "../src/quota/client.js";
import { ACP_AUTH_TEXT_RE, AcpProfileError, isAcpAuthError } from "../src/runners/acp-profile-error.js";
import { buildNewSessionParams } from "../src/runners/acp-shims.js";

function makeTwoProfileCatalog(quota: QuotaClient): {
  stateDir: string;
  config: HarnessConfig;
  compiler: ModelCatalogCompiler;
  cleanup: () => void;
} {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-auth-readiness-"));
  const profiles: RunnerProfileConfig[] = [
    {
      id: "acp:gemini",
      kind: "acp",
      adapter: "gemini",
      command: "gemini",
      args: ["--acp"],
      billing: "subscription",
      enabled: true,
    },
    {
      id: "acp:claude",
      kind: "acp",
      adapter: "claude",
      command: "claude",
      billing: "subscription",
      enabled: true,
    },
  ];
  const config: HarnessConfig = {
    ...loadConfig(stateDir),
    stateDir,
    profiles,
    defaultOrchestratorProfile: "acp:gemini",
    defaultWorkerProfile: "acp:gemini",
    defaultTaskProfile: "acp:gemini",
    catalog: { ttlHours: 24 },
  };
  const evidence = {
    ...RANKING_COHORT,
    revision: "https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.TestFix1.json",
    asOf: new Date().toISOString().slice(0, 10),
  };
  const compiler = new ModelCatalogCompiler(config, quota);
  const compiled = compiler.compileFromData({
    enabledProfiles: profiles,
    inventory: new Map([
      ["acp:gemini", [{ wireModelId: "gemini-4-neon" }]],
      ["acp:claude", [{ wireModelId: "claude-opus-5-5" }]],
    ]),
    modelsDev: [],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [
      {
        source: "vals_tb4",
        rawModelName: "google/gemini-4-neon",
        canonicalKeyHint: "google/gemini-4-neon",
        effort: "high",
        codingScore: 74,
        costPerTaskUsd: 3.0,
        timePerTaskSeconds: 600,
        evidence,
      },
      {
        source: "vals_tb4",
        rawModelName: "anthropic/claude-opus-5-5",
        canonicalKeyHint: "anthropic/claude-opus-5-5",
        effort: "high",
        codingScore: 68,
        costPerTaskUsd: 9.0,
        timePerTaskSeconds: 1800,
        evidence,
      },
    ],
    sources: ["vals_ai"],
  });
  writeFileSync(compiler.cachePath, JSON.stringify(compiled), "utf8");
  return {
    stateDir,
    config,
    compiler,
    cleanup: () => rmSync(stateDir, { recursive: true, force: true }),
  };
}

describe("ACP auth readiness, routing skips, profile errors, and prompt consistency", () => {
  it("marks auth-failed profile unavailable, excludes it from recommendations and routingSkips, and restores on authOk", async () => {
    const quota = new QuotaClient();
    const { compiler, cleanup } = makeTwoProfileCatalog(quota);
    try {
      // Baseline: gemini-4-neon ranks highest (74 > 68) and is recommended first.
      const before = await compiler.getCatalog({ excludeExhausted: false });
      const beforeRecs = recommendModelsByTaskKind(before.models);
      assert.equal(beforeRecs.orchestrator?.model, "google/gemini-4-neon");
      assert.deepEqual(routingSkips(before.models), []);

      // Ingest auth_required for acp:gemini.
      const observedAt = Date.now();
      quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Authentication required" },
        observedAt,
      });

      const resolved = quota.resolveForModel({
        profileId: "acp:gemini",
        provider: "gemini",
        wireModelId: "gemini-4-neon",
      });
      assert.ok(resolved);
      assert.equal(resolved!.unavailable, true);
      assert.equal(isQuotaUnavailable(resolved), true);
      assert.equal(resolved!.availability, AvailabilityStatus.DISABLED);
      assert.equal(resolved!.availabilityName, "NEEDS_LOGIN");
      assert.equal(resolved!.unavailableReason, "auth");
      assert.equal(resolved!.exhausted, false);
      assert.equal(resolved!.bindingBucketId, "acp:gemini:auth");
      assert.equal(resolved!.bindingWindowLabel, "auth");
      assert.equal(resolved!.nextAvailableAt, new Date(observedAt + AUTH_COOLDOWN_BASE_MS).toISOString());
      assert.match(resolved!.reason ?? "", /ACP profile acp:gemini needs login \(auth failed 1x; skipped until /);

      // clearPassiveExhaustion must not clear auth state.
      quota.clearPassiveExhaustion("acp:gemini");
      quota.clearPassiveExhaustion();
      assert.ok(quota.authStatus("acp:gemini"));

      // Compiled catalog reflects auth failure -> recommendations skip acp:gemini and pick claude.
      const blocked = await compiler.getCatalog({ excludeExhausted: false });
      const blockedRecs = recommendModelsByTaskKind(blocked.models);
      assert.equal(blockedRecs.orchestrator?.model, "anthropic/claude-opus-5-5");
      assert.equal(blockedRecs.orchestrator?.profile, "acp:claude");

      // routingSkips lists the auth-blocked model.
      const skips = routingSkips(blocked.models);
      assert.deepEqual(skips, [
        {
          model: "google/gemini-4-neon",
          profile: "acp:gemini",
          reason: "auth",
          until: new Date(observedAt + AUTH_COOLDOWN_BASE_MS).toISOString(),
        },
      ]);

      // authOk restores the profile and puts gemini-4-neon back at the top.
      quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { authOk: true },
        observedAt: observedAt + 10_000,
      });
      assert.equal(quota.authStatus("acp:gemini"), null);
      assert.equal(
        quota.resolveForModel({ profileId: "acp:gemini", provider: "gemini", wireModelId: "gemini-4-neon" }),
        null,
      );

      const restored = await compiler.getCatalog({ excludeExhausted: false });
      const restoredRecs = recommendModelsByTaskKind(restored.models);
      assert.equal(restoredRecs.orchestrator?.model, "google/gemini-4-neon");
      assert.deepEqual(routingSkips(restored.models), []);
    } finally {
      cleanup();
    }
  });

  it("expires auth cooldown after 5 min and escalates to 15 min back-off on second failure", () => {
    assert.equal(AUTH_COOLDOWN_BASE_MS, 300_000);
    assert.equal(AUTH_COOLDOWN_MAX_MS, 3_600_000);
    assert.equal(authCooldownMs(1), 5 * 60_000);
    assert.equal(authCooldownMs(2), 15 * 60_000);
    assert.equal(authCooldownMs(3), 45 * 60_000);
    assert.equal(authCooldownMs(4), 60 * 60_000);
    assert.equal(authCooldownMs(5), 60 * 60_000);

    const quota = new QuotaClient();
    const now = Date.now();

    // First failure observed >5 minutes ago: cooldown is expired, so authStatus and resolveForModel return null.
    const sixMinAgo = now - 6 * 60_000;
    quota.ingestPassiveSignal({
      profileId: "acp:gemini",
      model: null,
      raw: { sessionFailure: "auth_required", detail: "first failure" },
      observedAt: sixMinAgo,
    });
    assert.equal(quota.authStatus("acp:gemini"), null);
    assert.equal(
      quota.resolveForModel({ profileId: "acp:gemini", provider: "gemini", wireModelId: "gemini-4-neon" }),
      null,
    );

    // Second failure escalates back-off to 15 min because the expired entry was preserved.
    quota.ingestPassiveSignal({
      profileId: "acp:gemini",
      model: null,
      raw: { sessionFailure: "auth_required", detail: "second failure" },
      observedAt: now,
    });
    const status = quota.authStatus("acp:gemini");
    assert.ok(status);
    assert.equal(status!.failures, 2);
    assert.equal(status!.until, new Date(now + 15 * 60_000).toISOString());
    assert.equal(status!.detail, "second failure");

    // authOk resets failure count so a subsequent failure starts at 5 min again.
    quota.ingestPassiveSignal({
      profileId: "acp:gemini",
      model: null,
      raw: { authOk: true },
      observedAt: now + 1_000,
    });
    quota.ingestPassiveSignal({
      profileId: "acp:gemini",
      model: null,
      raw: { sessionFailure: "auth_required", detail: "after reset" },
      observedAt: now + 2_000,
    });
    const resetStatus = quota.authStatus("acp:gemini");
    assert.ok(resetStatus);
    assert.equal(resetStatus!.failures, 1);
    assert.equal(resetStatus!.until, new Date(now + 2_000 + AUTH_COOLDOWN_BASE_MS).toISOString());
  });

  it("launch-route allows explicit model on auth-blocked route, skips it on auto-route, and reports auth skips when no route remains", async () => {
    const quota = new QuotaClient();
    const { config, compiler, cleanup } = makeTwoProfileCatalog(quota);
    try {
      const now = Date.now();
      const geminiUntil = new Date(now + AUTH_COOLDOWN_BASE_MS).toISOString();
      quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Authentication required" },
        observedAt: now,
      });

      // Explicit model on auth-blocked route resolves instead of hard-blocking.
      const explicit = await resolveLaunchRoute(config, {
        tier: 2,
        catalog: compiler,
        quota,
        model: "google/gemini-4-neon",
      });
      assert.equal(explicit.profile.id, "acp:gemini");
      assert.equal(explicit.model, "google/gemini-4-neon");

      // Auto-route skips the auth-blocked profile and picks the healthy profile.
      const auto = await resolveLaunchRoute(config, {
        tier: 2,
        catalog: compiler,
        quota,
      });
      assert.equal(auto.profile.id, "acp:claude");
      assert.equal(auto.model, "anthropic/claude-opus-5-5");

      // Block the remaining profile too: auto-route error lists the auth skips.
      quota.ingestPassiveSignal({
        profileId: "acp:claude",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Please run /login" },
        observedAt: now,
      });
      await assert.rejects(
        () => resolveLaunchRoute(config, { tier: 2, catalog: compiler, quota }),
        (err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          assert.match(msg, /No eligible current catalog route/);
          assert.match(msg, /Skipped:/);
          assert.ok(msg.includes(`acp:gemini/google/gemini-4-neon (auth: needs login until ${geminiUntil})`), msg);
          assert.ok(msg.includes("acp:claude/anthropic/claude-opus-5-5 (auth: needs login until "), msg);
          return true;
        },
      );
    } finally {
      cleanup();
    }
  });

  it("classifies ACP auth errors via -32000 (direct/nested) and text patterns, and rejects non-auth errors", () => {
    const err = new AcpProfileError("auth_required", "acp:gemini", "Login needed");
    assert.ok(err instanceof Error);
    assert.equal(err.name, "AcpProfileError");
    assert.equal(err.kind, "auth_required");
    assert.equal(err.profileId, "acp:gemini");
    assert.equal(err.message, "Login needed");

    assert.equal(isAcpAuthError({ code: -32000, message: "Internal" }, ""), true);
    assert.equal(isAcpAuthError({ code: -32603, data: { code: -32000 } }, "wrapped"), true);
    assert.equal(isAcpAuthError({ code: -32603, data: { error: { code: -32000 } } }, "wrapped"), true);
    assert.equal(isAcpAuthError({ code: -32603, error: { code: -32000 } }, "wrapped"), true);
    assert.equal(
      isAcpAuthError(Object.assign(new Error("outer"), { cause: { code: -32000 } }), "outer"),
      true,
    );
    assert.equal(isAcpAuthError(new Error("boom"), "Invalid API key · Please run /login"), true);
    assert.equal(isAcpAuthError(null, "Authentication required"), true);
    assert.equal(ACP_AUTH_TEXT_RE.test("Please run /login"), true);

    // Negative cases: unrelated RPC codes and messages.
    assert.equal(isAcpAuthError({ code: -32603, message: "Internal error" }, "Rate limit exceeded (429)"), false);
    assert.equal(isAcpAuthError(new Error("ENOENT"), "spawn gemini ENOENT"), false);
    assert.equal(isAcpAuthError(null, "quota_exhausted"), false);
  });

  it("buildDirectorSystemPrompt lists extraWriteRoots and disables native Write/Edit in favor of write_note", () => {
    const withoutExtra = buildDirectorSystemPrompt("off");
    assert.ok(withoutExtra.includes(".harness/goals/, .harness/notes/, or a configured extra write root (none configured)."));
    assert.ok(withoutExtra.includes("Native Write and Edit tools are disabled in this session."));
    assert.ok(withoutExtra.includes("Ignore any inherited instruction to save memory or other files with the Write tool; save them with `write_note`"));

    const withExtra = buildDirectorSystemPrompt("collapsed", undefined, ["/srv/notes", "/tmp/reports"]);
    assert.ok(withExtra.includes(".harness/goals/, .harness/notes/, or a configured extra write root (/srv/notes, /tmp/reports)."));
    assert.ok(withExtra.includes("Native Write and Edit tools are disabled in this session."));
  });

  it("acp-shims appends the Claude Write-disabled override only when Write is disallowed", () => {
    const readText = (params: Record<string, unknown>): string => {
      const sp = params.systemPrompt as { mode: string; content: Array<{ type: string; text: string }> };
      return sp.content.map((c) => c.text).join("\n");
    };

    const cp = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Director base prompt",
      toolPolicy: "control_plane_only",
      model: "claude-opus-5-5",
      mcpServers: [],
    });
    assert.match(readText(cp.params), /Native Write\/Edit tools are disabled in this session; ignore inherited instructions to save memory files with them\./);

    const ro = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Research base prompt",
      toolPolicy: "read_only_workspace",
      model: "claude-sonnet-5-5",
      mcpServers: [],
    });
    assert.match(readText(ro.params), /Native Write\/Edit tools are disabled in this session; ignore inherited instructions to save memory files with them\./);

    const rw = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Worker base prompt",
      toolPolicy: "read_write_workspace",
      model: "claude-opus-5-5",
      mcpServers: [],
    });
    assert.equal(readText(rw.params), "Worker base prompt");
    assert.doesNotMatch(readText(rw.params), /Native Write\/Edit tools are disabled/);

    const codexCp = buildNewSessionParams("codex", {
      cwd: "/tmp",
      systemPrompt: "Codex base prompt",
      toolPolicy: "control_plane_only",
      model: "gpt-6.2-sol",
      mcpServers: [],
    });
    assert.equal(readText(codexCp.params), "Codex base prompt");
  });
});
