import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import type { AcpProfileConfig } from "../src/config.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { buildPostSessionActions } from "../src/runners/acp-shims.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

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
      { toolPolicy: "read_only_workspace", model: "gpt-6-luna", allowShellInReadOnly: true },
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

    const omittedShellActions = buildPostSessionActions(
      "codex",
      "s-codex-omitted-shell",
      {
        configOptions: [
          CODEX_MODEL_OPT,
          { id: "mode", category: "mode", currentValue: "agent", options: V2_11_CODEX_MODE_OPTIONS },
        ],
      },
      { toolPolicy: "read_only_workspace", model: "gpt-6-luna" },
    );
    assert.deepEqual(omittedShellActions, []);

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

  it("D9(b) (C8): AcpRunner never requests workspace-write when Codex reports mode 'agent' for a shell-disabled read-only task", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "codex-mode-guard-")));
    tempDirs.push(cwd);

    const codexProfile: AcpProfileConfig = {
      id: "acp:codex",
      kind: "acp",
      adapter: "codex",
      command: "unused",
      billing: "subscription",
    };

    const runCodexCase = async (
      allowShellInReadOnly: boolean | undefined,
      useLegacyModes = false,
    ) => {
      const modeRequests: Array<{ method: string; value: string }> = [];
      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () =>
          useLegacyModes
            ? {
                sessionId: "s-codex-legacy",
                models: { currentModelId: "gpt-6-luna", availableModels: [{ modelId: "gpt-6-luna", name: "GPT-6 Luna" }] },
                modes: { currentModeId: "agent", availableModes: V2_11_CODEX_LEGACY_MODES },
              }
            : {
                sessionId: "s-codex-cfg",
                configOptions: [
                  { ...CODEX_MODEL_OPT, type: "select" as const, name: "Model" },
                  {
                    id: "mode",
                    name: "Mode",
                    type: "select" as const,
                    category: "mode",
                    currentValue: "agent",
                    options: V2_11_CODEX_MODE_OPTIONS,
                  },
                ],
              },
        )
        .onRequest("session/set_config_option", async ({ params }) => {
          const p = params as unknown as { configId: string; value: string };
          if (p.configId === "mode") modeRequests.push({ method: "session/set_config_option", value: p.value });
          return {
            configOptions: [
              { ...CODEX_MODEL_OPT, type: "select" as const, name: "Model" },
              {
                id: "mode",
                name: "Mode",
                type: "select" as const,
                category: "mode",
                currentValue: p.value,
                options: V2_11_CODEX_MODE_OPTIONS,
              },
            ],
          };
        })
        .onRequest("session/set_mode", async ({ params }) => {
          const p = params as unknown as { modeId: string };
          modeRequests.push({ method: "session/set_mode", value: p.modeId });
          return {};
        })
        .onRequest("session/prompt", async ({ client, params: { sessionId } }) => {
          await client.notify("session/update", {
            sessionId,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
          });
          return { stopReason: "end_turn" };
        });

      await new AcpRunner(codexProfile).run(
        {
          runId: "run-d9b",
          taskId: "t-d9b",
          tier: 3,
          kind: "research",
          cwd,
          toolPolicy: "read_only_workspace",
          ...(allowShellInReadOnly !== undefined ? { allowShellInReadOnly } : {}),
          systemPrompt: "Strict read-only researcher",
          initialPrompt: "Inspect only",
          model: "gpt-6-luna",
          maxTurns: 1,
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {},
        },
        fixture,
      );
      return modeRequests;
    };

    // Shell-disabled read-only task (explicit false, omitted, and legacy modes shape) must never request a writable mode.
    assert.deepEqual(await runCodexCase(false), []);
    assert.deepEqual(await runCodexCase(undefined), []);
    assert.deepEqual(await runCodexCase(false, true), []);

    // Shell-enabled read-only task (Done-Reviewer / verify) still switches agent -> workspace-write.
    assert.deepEqual(await runCodexCase(true), [
      { method: "session/set_config_option", value: "workspace-write" },
    ]);
  });
});
