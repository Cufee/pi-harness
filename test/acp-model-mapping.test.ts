import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { buildNewSessionParams, buildPostSessionActions, resolveNativeModelOption } from "../src/runners/acp-shims.js";

const modelConfig = (values: Array<string | { value: string; name?: string }>, currentValue?: string) => ({
  id: "model",
  category: "model",
  currentValue,
  options: values.map((v) => (typeof v === "string" ? { value: v } : v)),
});

const effortConfig = (values: string[], currentValue?: string) => ({
  id: "effort",
  category: "thought_level",
  currentValue,
  options: values.map((value) => ({ value })),
});

const sentValues = (actions: ReturnType<typeof buildPostSessionActions>) =>
  actions.map((a) => String(a.params.value ?? a.params.modelId ?? ""));

describe("ACP adapter-native model matching", () => {
  it("never hands Claude a company prefix on session/new", () => {
    const { params } = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Role",
      readOnly: false,
      model: "anthropic/claude-opus-5-5",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { options: {} } },
    });
    const meta = (params._meta as { claudeCode: { options: { model?: string } } }).claudeCode.options;
    assert.equal(meta.model, "claude-opus-5-5");
    assert.deepEqual(params.configOptions, [{ configId: "model", value: "claude-opus-5-5" }]);
  });

  it("maps Claude canonical IDs to the advertised alias and corrects a mismatched currentValue", () => {
    const res = {
      configOptions: [
        modelConfig(
          [
            { value: "default", name: "Default (recommended)" },
            { value: "sonnet", name: "Sonnet" },
            { value: "opus", name: "Opus" },
            { value: "haiku", name: "Haiku" },
          ],
          "default",
        ),
      ],
    };
    const actions = buildPostSessionActions("claude", "s1", res, { readOnly: false, model: "anthropic/claude-opus-5-5" });
    assert.deepEqual(actions, [
      { method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "opus" } },
    ]);

    // Already on the resolved option: nothing to send
    const same = buildPostSessionActions(
      "claude",
      "s1",
      { configOptions: [modelConfig(["sonnet", "opus"], "opus")] },
      { readOnly: false, model: "anthropic/claude-opus-5-5" },
    );
    assert.equal(same.length, 0);
  });

  it("prefers the exact bare Claude ID over a family alias and never sends anthropic/", () => {
    const opts = ["opus", "claude-opus-5-5", "claude-opus-5"];
    assert.equal(resolveNativeModelOption("claude", "anthropic/claude-opus-5-5", opts.map((value) => ({ value }))), "claude-opus-5-5");
    assert.equal(resolveNativeModelOption("claude", "anthropic/claude-sonnet-5-5", [{ value: "sonnet" }, { value: "opus" }]), "sonnet");
    assert.equal(resolveNativeModelOption("claude", "anthropic/claude-haiku-5-5", [{ value: "Haiku-tier", name: "Claude Haiku 5.5" }]), "Haiku-tier");
    assert.equal(resolveNativeModelOption("claude", "anthropic/claude-fable-5-2", [{ value: "opus" }, { value: "fable" }]), "fable");
    // Reverse alias: requested `opus` against full IDs
    assert.equal(resolveNativeModelOption("claude", "opus", [{ value: "claude-sonnet-5-5" }, { value: "claude-opus-5-5" }]), "claude-opus-5-5");
    // Nothing advertised: single-vendor prefix strip
    assert.equal(resolveNativeModelOption("claude", "anthropic/claude-opus-5-5", []), "claude-opus-5-5");

    const actions = buildPostSessionActions(
      "claude",
      "s1",
      { configOptions: [modelConfig(["claude-opus-5", "claude-opus-5-5"], "claude-opus-5")] },
      { readOnly: false, model: "anthropic/claude-opus-5-5" },
    );
    assert.deepEqual(sentValues(actions), ["claude-opus-5-5"]);
    assert.ok(sentValues(actions).every((v) => !v.startsWith("anthropic/")));
  });

  it("strips openai/ for Codex with or without advertised options", () => {
    const blind = buildPostSessionActions("codex", "s1", {}, { readOnly: false, model: "openai/gpt-6.2-astra" });
    assert.deepEqual(blind[0], {
      method: "session/set_config_option",
      params: { sessionId: "s1", configId: "model", value: "gpt-6.2-astra" },
    });

    const advertised = buildPostSessionActions(
      "codex",
      "s1",
      { configOptions: [modelConfig(["gpt-6.2-sol", "gpt-6.2-astra"], "gpt-6.2-sol")] },
      { readOnly: false, model: "openai/gpt-6.2-astra" },
    );
    assert.deepEqual(sentValues(advertised), ["gpt-6.2-astra"]);
  });

  it("strips google/ for Gemini set_model, using legacy availableModels when advertised", () => {
    const blind = buildPostSessionActions("gemini", "s1", {}, { readOnly: false, model: "google/gemini-4-neon" });
    assert.deepEqual(blind, [{ method: "session/set_model", params: { sessionId: "s1", modelId: "gemini-4-neon" } }]);

    const legacy = buildPostSessionActions(
      "gemini",
      "s1",
      {
        models: {
          currentModelId: "gemini-3.8-flash",
          availableModels: [{ modelId: "gemini-3.8-flash" }, { modelId: "gemini-4-carbon" }],
        },
      },
      { readOnly: false, model: "google/gemini-4-carbon" },
    );
    assert.deepEqual(sentValues(legacy), ["gemini-4-carbon"]);
  });

  it("maps Amp/generic canonical IDs onto the advertised provider namespace", () => {
    const res = {
      configOptions: [
        modelConfig(
          ["anthropic/claude-opus-5-5", "google-vertex/gemini-4-carbon", "zhipuai/glm-5.3", "openai/gpt-6.2-astra"],
          "anthropic/claude-opus-5-5",
        ),
      ],
    };
    const gemini = buildPostSessionActions("generic", "s1", res, { readOnly: true, model: "google/gemini-4-carbon" });
    assert.deepEqual(sentValues(gemini), ["google-vertex/gemini-4-carbon"]);
    const glm = buildPostSessionActions("generic", "s1", res, { readOnly: true, model: "zai/glm-5.3" });
    assert.deepEqual(sentValues(glm), ["zhipuai/glm-5.3"]);
    const exact = buildPostSessionActions("generic", "s1", res, { readOnly: true, model: "openai/gpt-6.2-astra" });
    assert.deepEqual(sentValues(exact), ["openai/gpt-6.2-astra"]);
    // Generic never prefix-strips blindly: no match means null from the resolver
    assert.equal(resolveNativeModelOption("generic", "google/gemini-9", res.configOptions[0]!.options), null);
    // ...and an unadvertised model is skipped instead of sent
    assert.equal(buildPostSessionActions("generic", "s1", res, { readOnly: true, model: "google/gemini-9" }).length, 0);
    const codexUnknown = buildPostSessionActions(
      "codex",
      "s1",
      { configOptions: [modelConfig(["gpt-6.2-sol"], "gpt-6.2-sol")] },
      { readOnly: false, model: "openai/gpt-9" },
    );
    assert.equal(codexUnknown.length, 0);
  });

  it("only sets effort when an advertised effort option matches (case-insensitive)", () => {
    const res = { configOptions: [effortConfig(["low", "medium", "high"], "medium")] };

    const ok = buildPostSessionActions("codex", "s1", res, { readOnly: false, effort: "HIGH" });
    assert.deepEqual(ok, [
      { method: "session/set_config_option", params: { sessionId: "s1", configId: "effort", value: "high" } },
    ]);

    for (const adapter of ["claude", "codex", "gemini", "generic"] as const) {
      const bad = buildPostSessionActions(adapter, "s1", res, { readOnly: false, effort: "xhigh" });
      assert.equal(bad.length, 0, `${adapter} must not send an unadvertised effort`);
    }

    const claude = buildPostSessionActions("claude", "s1", res, { readOnly: false, effort: "Low" });
    assert.deepEqual(sentValues(claude), ["low"]);
  });
});
