import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { buildPostSessionActions } from "../src/runners/acp-shims.js";

const V2_11_CODEX_MODE_OPTIONS = [
  { value: "read-only", name: "Read-only" },
  { value: "workspace-write", name: "Workspace access" },
  { value: "agent", name: "Auto review" },
  { value: "agent-full-access", name: "Full access" },
];

const V2_11_CODEX_LEGACY_MODES = V2_11_CODEX_MODE_OPTIONS.map((o) => ({ id: o.value, name: o.name }));

const OLDER_CODEX_MODE_OPTIONS = [
  { value: "read-only", name: "Read-only" },
  { value: "auto", name: "Auto" },
  { value: "full-access", name: "Full access" },
];

const CODEX_MODEL_OPT = {
  id: "model",
  category: "model",
  currentValue: "gpt-6-luna",
  options: [{ value: "gpt-6-luna", name: "GPT-6 Luna" }],
};

describe("buildPostSessionActions adapter mode selection (esc-149)", () => {
  it("selects workspace-write for writable Codex sessions against codex-acp v2.11+ advertised modes", () => {
    const actions = buildPostSessionActions(
      "codex",
      "s-codex-v211",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "agent", options: V2_11_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );

    assert.deepEqual(actions, [
      {
        method: "session/set_config_option",
        params: { sessionId: "s-codex-v211", configId: "mode", value: "workspace-write" },
      },
    ]);
  });

  it("selects workspace-write via legacy session/set_mode when only modes.availableModes is advertised", () => {
    const actions = buildPostSessionActions(
      "codex",
      "s-codex-legacy-modes",
      {
        models: { currentModelId: "gpt-6-luna", availableModels: [{ modelId: "gpt-6-luna" }] },
        modes: { currentModeId: "agent", availableModes: V2_11_CODEX_LEGACY_MODES },
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );

    assert.deepEqual(actions, [
      {
        method: "session/set_mode",
        params: { sessionId: "s-codex-legacy-modes", modeId: "workspace-write" },
      },
    ]);
  });

  it("falls back to agent-full-access for writable Codex when workspace-write is not advertised", () => {
    const actions = buildPostSessionActions(
      "codex",
      "s-codex-no-ww",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          {
            id: "mode",
            category: "mode",
            currentValue: "agent",
            options: [
              { value: "read-only", name: "Read-only" },
              { value: "agent", name: "Auto review" },
              { value: "agent-full-access", name: "Full access" },
            ],
          },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );

    assert.deepEqual(actions, [
      {
        method: "session/set_config_option",
        params: { sessionId: "s-codex-no-ww", configId: "mode", value: "agent-full-access" },
      },
    ]);
  });

  it("switches Codex read_only_workspace out of default 'agent' (Done-Reviewer shape) to workspace-write, while keeping read-only untouched", () => {
    const doneReviewerActions = buildPostSessionActions(
      "codex",
      "s-codex-b2",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "agent", options: V2_11_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_only_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(doneReviewerActions, [
      {
        method: "session/set_config_option",
        params: { sessionId: "s-codex-b2", configId: "mode", value: "workspace-write" },
      },
    ]);

    const strictReadOnlyActions = buildPostSessionActions(
      "codex",
      "s-codex-ro",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "read-only", options: V2_11_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_only_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(strictReadOnlyActions, []);

    const explicitNoShellActions = buildPostSessionActions(
      "codex",
      "s-codex-noshell",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "agent", options: V2_11_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_only_workspace", model: "gpt-6-luna", allowShellInReadOnly: false },
    );
    assert.deepEqual(explicitNoShellActions, []);
  });

  it("preserves full-access / full_access / auto selection against older Codex mode lists and no-ops on unknown modes", () => {
    const olderFullAccess = buildPostSessionActions(
      "codex",
      "s-codex-old",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "read-only", options: OLDER_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(olderFullAccess, [
      {
        method: "session/set_config_option",
        params: { sessionId: "s-codex-old", configId: "mode", value: "full-access" },
      },
    ]);

    const olderUnderscore = buildPostSessionActions(
      "codex",
      "s-codex-old-us",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          {
            id: "mode",
            category: "mode",
            currentValue: "read-only",
            options: [{ value: "read-only" }, { value: "full_access" }],
          },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(olderUnderscore, [
      {
        method: "session/set_config_option",
        params: { sessionId: "s-codex-old-us", configId: "mode", value: "full_access" },
      },
    ]);

    const alreadyAuto = buildPostSessionActions(
      "codex",
      "s-codex-auto",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "auto", options: OLDER_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(alreadyAuto, []);

    const alreadyWorkspaceWrite = buildPostSessionActions(
      "codex",
      "s-codex-ww-cur",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "workspace-write", options: V2_11_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(alreadyWorkspaceWrite, []);

    const unknownModes = buildPostSessionActions(
      "codex",
      "s-codex-unknown",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          {
            id: "mode",
            category: "mode",
            currentValue: "custom-a",
            options: [{ value: "custom-a" }, { value: "custom-b" }],
          },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(unknownModes, []);
  });

  it("keeps non-codex adapters on existing YOLO_PRIORITY behavior", () => {
    const claudeActions = buildPostSessionActions(
      "claude",
      "s-claude",
      {
        configOptions: [
          { id: "model", category: "model", currentValue: "haiku", options: [{ value: "haiku" }] },
          {
            id: "mode",
            category: "mode",
            currentValue: "default",
            options: [{ value: "default" }, { value: "workspace-write" }, { value: "bypassPermissions" }],
          },
        ],
      },
      { toolPolicy: "read_write_workspace", model: "haiku" },
    );
    assert.deepEqual(claudeActions, [
      {
        method: "session/set_config_option",
        params: { sessionId: "s-claude", configId: "mode", value: "bypassPermissions" },
      },
    ]);
  });
});
