import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { buildNewSessionParams, buildPostSessionActions } from "../src/runners/acp-shims.js";

const toolPolicy = "read_write_workspace" as const;
const modelConfig = (values: string[], currentValue: string) => ({
  id: "model",
  category: "model",
  currentValue,
  options: values.map((value) => ({ value })),
});

describe("ACP adapter-native model matching", () => {
  it("hands Claude its selected native model on session/new", () => {
    const { params } = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Role",
      toolPolicy,
      model: "claude-opus-5-5",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { options: {} } },
    });
    const meta = (params._meta as { claudeCode: { options: { model?: string } } }).claudeCode.options;
    assert.equal(meta.model, "claude-opus-5-5");
    assert.deepEqual(params.configOptions, [{ configId: "model", value: "claude-opus-5-5" }]);
  });

  it("sets Claude's explicitly selected alias unless it is already current", () => {
    const opts = { toolPolicy, model: "opus" };
    const config = modelConfig(["sonnet", "opus"], "sonnet");
    assert.deepEqual(buildPostSessionActions("claude", "s1", { configOptions: [config] }, opts), [{
      method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: "opus" }, requiredModel: "opus",
    }]);
    assert.deepEqual(buildPostSessionActions("claude", "s1", { configOptions: [{ ...config, currentValue: "opus" }] }, opts), []);
  });

  it("does not substitute a Claude family alias, display name or sibling revision", () => {
    const model = "claude-opus-5-5";
    const res = { configOptions: [{ id: "model", currentValue: "opus", options: [
      { value: "opus", name: "Claude Opus 5.5" }, { value: "claude-opus-5" },
    ] }] };
    assert.throws(() => buildPostSessionActions("claude", "s1", res, { toolPolicy, model }), /claude-opus-5-5.*not advertised/);
  });

  it("sets the exact Codex model with or without advertised options", () => {
    const model = "gpt-6.2-astra";
    for (const res of [{}, { configOptions: [modelConfig(["gpt-6.2-sol", model], "gpt-6.2-sol")] }]) {
      assert.deepEqual(buildPostSessionActions("codex", "s1", res, { toolPolicy, model }), [{
        method: "session/set_config_option", params: { sessionId: "s1", configId: "model", value: model }, requiredModel: model,
      }]);
    }
  });

  it("uses Gemini's legacy model setter and its advertised model list", () => {
    const model = "gemini-4-carbon";
    const opts = { toolPolicy, model };
    const res = { models: { currentModelId: "gemini-3.8-flash", availableModels: [{ modelId: model }] } };
    for (const response of [{}, res]) {
      assert.deepEqual(buildPostSessionActions("gemini", "s1", response, opts), [{
        method: "session/set_model", params: { sessionId: "s1", modelId: model }, requiredModel: model,
      }]);
    }
    assert.throws(() => buildPostSessionActions("gemini", "s1", res, { toolPolicy, model: "gemini-4-neon" }), /not advertised/);
  });

  it("keeps Amp's provider namespace and fails if the selected route disappeared", () => {
    const model = "google-vertex/gemini-4-carbon";
    const res = { configOptions: [modelConfig([model, "openai/gpt-6.2-astra"], "openai/gpt-6.2-astra")] };
    assert.equal(buildPostSessionActions("generic", "s1", res, { toolPolicy, model })[0]?.params.value, model);
    assert.throws(() => buildPostSessionActions("generic", "s1", res, { toolPolicy, model: "google/gemini-4-carbon" }), /not advertised/);
  });

  it("only sets effort when an advertised effort option matches (case-insensitive)", () => {
    const opts = { toolPolicy, model: "selected" };
    const res = { configOptions: [modelConfig([opts.model], opts.model), {
      id: "effort", category: "thought_level", currentValue: "medium", options: ["low", "medium", "high"].map((value) => ({ value })),
    }] };
    assert.deepEqual(buildPostSessionActions("codex", "s1", res, { ...opts, effort: "HIGH" }), [
      { method: "session/set_config_option", params: { sessionId: "s1", configId: "effort", value: "high" } },
    ]);
    for (const adapter of ["claude", "codex", "gemini", "generic"] as const) {
      assert.deepEqual(buildPostSessionActions(adapter, "s1", res, { ...opts, effort: "xhigh" }), []);
    }
  });

  it("omits synthetic 'default' effort and applies strictMcpConfig/settingSources on Claude read_only_workspace", () => {
    const { params } = buildNewSessionParams("claude", {
      cwd: "/tmp",
      systemPrompt: "Role",
      toolPolicy: "read_only_workspace",
      model: "claude-opus-5-5",
      effort: "default",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { options: {} } },
    });
    const meta = (params._meta as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options;
    assert.equal(meta.effort, undefined);
    assert.equal(meta.strictMcpConfig, true);
    assert.deepEqual(meta.settingSources, []);
    assert.equal(meta.tools, undefined);
    assert.deepEqual(params.configOptions, [{ configId: "model", value: "claude-opus-5-5" }]);

    assert.deepEqual(
      buildPostSessionActions("codex", "s1", {
        configOptions: [modelConfig(["gpt-5"], "gpt-5")],
      }, { toolPolicy, model: "gpt-5", effort: "default" }),
      [],
    );
  });
});
