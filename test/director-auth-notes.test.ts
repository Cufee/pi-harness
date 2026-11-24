import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalogCompiler, type RoutingSkip } from "../src/catalog/compiler.js";
import { RANKING_COHORT } from "../src/catalog/sources.js";
import { effectiveCodeMode, toolSearch } from "../src/code-mode/index.js";
import { loadConfig, type HarnessConfig, type RunnerProfileConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { AUTH_COOLDOWN_BASE_MS } from "../src/quota/client.js";
import type { ToolDefinition } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";

async function makeTempGitRepo(prefix = "pi-harness-dir-auth-"): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

function makeTwoProfileConfig(
  repoRoot: string,
  stateDir: string,
  overrides?: { codeMode?: HarnessConfig["codeMode"]; extraWriteRoots?: string[] },
): HarnessConfig {
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
  const base = loadConfig(repoRoot);
  const config: HarnessConfig = {
    ...base,
    stateDir,
    socketPath: join(stateDir, "d.sock"),
    codeMode: overrides?.codeMode ?? "off",
    profiles,
    defaultOrchestratorProfile: "acp:gemini",
    defaultWorkerProfile: "acp:gemini",
    defaultTaskProfile: "acp:gemini",
    catalog: { ttlHours: 24 },
    quotaEndpoint: undefined,
    worktree: {
      ...base.worktree,
      ...(overrides?.extraWriteRoots !== undefined ? { extraWriteRoots: overrides.extraWriteRoots } : {}),
    },
  };
  const evidence = {
    ...RANKING_COHORT,
    revision: "https://www.vals.ai/_astro/benchmark_view_terminal_bench_4.TestFix1.json",
    asOf: new Date().toISOString().slice(0, 10),
  };
  const compiler = new ModelCatalogCompiler(config);
  const compiled = compiler.compileFromData({
    enabledProfiles: profiles,
    inventory: new Map([
      ["acp:gemini", [{ wireModelId: "gemini-4-neon" }]],
      ["acp:claude", [{ wireModelId: "claude-opus-5-5" }]],
    ]),
    profileStatuses: [
      { profileId: "acp:gemini", status: "ok", modelCount: 1 },
      { profileId: "acp:claude", status: "ok", modelCount: 1 },
    ],
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
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(compiler.cachePath, JSON.stringify(compiled), "utf8");
  return config;
}

describe("Director write_note extraWriteRoots, list_models skippedForRouting, and spawn_task auth warning", () => {
  it("__list_tools and system prompt reflect configured extraWriteRoots, none configured, and hot-reload updates", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-dir-roots-state-"));
    const extraDirA = mkdtempSync(join(tmpdir(), "pi-harness-extra-root-a-"));
    const extraDirB = mkdtempSync(join(tmpdir(), "pi-harness-extra-root-b-"));
    const canonicalA = realpathSync(extraDirA);
    const canonicalB = realpathSync(extraDirB);

    const capturedPrompts: string[] = [];
    const configWithRoot = makeTwoProfileConfig(repoRoot, stateDir, {
      codeMode: "off",
      extraWriteRoots: [extraDirA],
    });
    const daemon = new HarnessDaemon(configWithRoot, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          capturedPrompts.push(req.systemPrompt);
          return { stopReason: "completed", text: "ok" };
        },
      }),
    });

    try {
      const chat = await daemon.director.createChat({ repoRoot, profileId: "acp:claude", model: "anthropic/claude-opus-5-5" });

      // 1. With extraWriteRoots = [extraDirA], __list_tools lists the resolved path in both description and path schema.
      const toolsWithA = (await daemon.director.executeDirectorMcpTool(chat.id, "__list_tools", {})) as ToolDefinition[];
      const writeNoteA = toolsWithA.find((t) => t.name === "write_note");
      assert.ok(writeNoteA, "write_note should be exposed in __list_tools");
      assert.ok(
        writeNoteA.description.includes(`or these configured extraWriteRoots: ${canonicalA}`),
        `expected write_note description to list ${canonicalA}, got: ${writeNoteA.description}`,
      );
      const pathDescA = String((writeNoteA.inputSchema.properties as Record<string, { description?: string }>).path?.description ?? "");
      assert.ok(
        pathDescA.includes(`or these configured extraWriteRoots: ${canonicalA}`),
        `expected write_note path description to list ${canonicalA}, got: ${pathDescA}`,
      );
      const searchA = toolSearch(toolsWithA, { names: ["write_note"] });
      assert.deepEqual(searchA.matched, ["write_note"]);
      assert.ok(searchA.signatures.includes(canonicalA));

      // sendChatMessage passes resolved extraWriteRoots to buildDirectorSystemPrompt.
      await daemon.director.sendChatMessage(chat.id, "hello");
      assert.equal(capturedPrompts.length, 1);
      assert.ok(
        capturedPrompts[0]!.includes(canonicalA),
        `expected systemPrompt to include ${canonicalA}`,
      );

      // 2. Hot-reload to no extraWriteRoots -> __list_tools and systemPrompt say no extraWriteRoots configured / none configured.
      const configWithoutRoots: HarnessConfig = {
        ...configWithRoot,
        worktree: { ...configWithRoot.worktree, extraWriteRoots: [] },
      };
      daemon.director.updateConfig(configWithoutRoots);

      const toolsNone = (await daemon.director.executeDirectorMcpTool(chat.id, "__list_tools", {})) as ToolDefinition[];
      const writeNoteNone = toolsNone.find((t) => t.name === "write_note");
      assert.ok(writeNoteNone);
      assert.ok(
        writeNoteNone.description.includes("no extraWriteRoots configured"),
        `expected write_note description to say no extraWriteRoots configured, got: ${writeNoteNone.description}`,
      );
      const pathDescNone = String((writeNoteNone.inputSchema.properties as Record<string, { description?: string }>).path?.description ?? "");
      assert.ok(
        pathDescNone.includes("no extraWriteRoots configured"),
        `expected write_note path description to say no extraWriteRoots configured, got: ${pathDescNone}`,
      );

      await daemon.director.sendChatMessage(chat.id, "hello again");
      assert.equal(capturedPrompts.length, 2);
      assert.ok(capturedPrompts[1]!.includes("none configured"));
      assert.ok(!capturedPrompts[1]!.includes(canonicalA));

      // 3. Hot-reload to [extraDirA, extraDirB] -> both roots appear and write_note writes into extraDirB.
      const configWithBoth: HarnessConfig = {
        ...configWithRoot,
        worktree: { ...configWithRoot.worktree, extraWriteRoots: [extraDirA, extraDirB] },
      };
      daemon.director.updateConfig(configWithBoth);

      const toolsBoth = (await daemon.director.executeDirectorMcpTool(chat.id, "__list_tools", {})) as ToolDefinition[];
      const writeNoteBoth = toolsBoth.find((t) => t.name === "write_note");
      assert.ok(writeNoteBoth);
      assert.ok(
        writeNoteBoth.description.includes(`or these configured extraWriteRoots: ${canonicalA}, ${canonicalB}`),
        `expected both roots in write_note description, got: ${writeNoteBoth.description}`,
      );

      const noteTarget = join(extraDirB, "hot-reloaded-note.md");
      const writeRes = (await daemon.director.executeDirectorMcpTool(chat.id, "write_note", {
        path: noteTarget,
        content: "hello from extra root\n",
        reason: "Verify resolved extraWriteRoots",
      })) as { written: boolean; path: string };
      assert.equal(writeRes.written, true);
      assert.ok(existsSync(noteTarget));
      assert.equal(readFileSync(noteTarget, "utf8"), "hello from extra root\n");
    } finally {
      await daemon.stop();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(extraDirA, { recursive: true, force: true });
      rmSync(extraDirB, { recursive: true, force: true });
    }
  });

  it("tool_search reflects configured extraWriteRoots dynamically", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-dir-cm-state-"));
    const extraDir = mkdtempSync(join(tmpdir(), "pi-harness-dir-cm-extra-"));
    const canonicalExtra = realpathSync(extraDir);
    const config = makeTwoProfileConfig(repoRoot, stateDir, {
      codeMode: effectiveCodeMode("collapsed") !== "off" ? "collapsed" : "off",
      extraWriteRoots: [extraDir],
    });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async () => ({ stopReason: "completed", text: "ok" }),
      }),
    });
    try {
      const chat = await daemon.director.createChat({ repoRoot, profileId: "acp:claude", model: "anthropic/claude-opus-5-5" });
      if (effectiveCodeMode("collapsed") !== "off") {
        const found = (await daemon.director.executeDirectorMcpTool(chat.id, "tool_search", {
          names: ["write_note"],
        })) as { signatures: string; matched: string[] };
        assert.deepEqual(found.matched, ["write_note"]);
        assert.ok(
          found.signatures.includes(canonicalExtra),
          `expected tool_search write_note signature to include ${canonicalExtra}, got: ${found.signatures}`,
        );
      } else {
        const tools = (await daemon.director.executeDirectorMcpTool(chat.id, "__list_tools", {})) as ToolDefinition[];
        const found = toolSearch(tools, { names: ["write_note"] });
        assert.deepEqual(found.matched, ["write_note"]);
        assert.ok(
          found.signatures.includes(canonicalExtra),
          `expected toolSearch write_note signature to include ${canonicalExtra}, got: ${found.signatures}`,
        );
      }
    } finally {
      await daemon.stop();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(extraDir, { recursive: true, force: true });
    }
  });

  it("Director list_models reports skippedForRouting after auth_required and clears it after authOk", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-dir-models-state-"));
    const config = makeTwoProfileConfig(repoRoot, stateDir, { codeMode: "off" });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async () => ({ stopReason: "completed", text: "ok" }),
      }),
    });

    interface DirectorListModelsResult {
      skippedForRouting: RoutingSkip[];
      recommendedByKind: Record<string, { model: string; profile?: string } | null>;
    }

    try {
      const chat = await daemon.director.createChat({ repoRoot, profileId: "acp:claude", model: "anthropic/claude-opus-5-5" });

      const before = (await daemon.director.executeDirectorMcpTool(chat.id, "list_models", {})) as DirectorListModelsResult;
      assert.deepEqual(before.skippedForRouting, []);
      assert.equal(before.recommendedByKind.orchestrator?.model, "google/gemini-4-neon");

      const observedAt = Date.now();
      daemon.orchestrator.quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Authentication required" },
        observedAt,
      });

      const blocked = (await daemon.director.executeDirectorMcpTool(chat.id, "list_models", {})) as DirectorListModelsResult;
      const expectedUntil = new Date(observedAt + AUTH_COOLDOWN_BASE_MS).toISOString();
      assert.deepEqual(blocked.skippedForRouting, [
        {
          model: "google/gemini-4-neon",
          profile: "acp:gemini",
          reason: "auth",
          until: expectedUntil,
        },
      ]);
      assert.equal(blocked.recommendedByKind.orchestrator?.model, "anthropic/claude-opus-5-5");

      daemon.orchestrator.quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { authOk: true },
        observedAt: Date.now(),
      });

      const restored = (await daemon.director.executeDirectorMcpTool(chat.id, "list_models", {})) as DirectorListModelsResult;
      assert.deepEqual(restored.skippedForRouting, []);
      assert.equal(restored.recommendedByKind.orchestrator?.model, "google/gemini-4-neon");
    } finally {
      await daemon.stop();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("Director spawn_task warns without blocking when the resolved profile is in auth cooldown", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-dir-spawn-state-"));
    const config = makeTwoProfileConfig(repoRoot, stateDir, { codeMode: "off" });
    const spawns: {
      blocked?: { spawned: string; warning?: string };
      healthy?: { spawned: string; warning?: string };
    } = {};

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.kind === "orchestrator" && req.runId === req.taskId) {
            spawns.blocked = (await req.executeTool("spawn_task", {
              kind: "research",
              title: "Probe auth-blocked model",
              objective: "Inspect repo",
              model: "google/gemini-4-neon",
            })) as { spawned: string; warning?: string };
            spawns.healthy = (await req.executeTool("spawn_task", {
              kind: "research",
              title: "Probe healthy model",
              objective: "Inspect repo",
              model: "anthropic/claude-opus-5-5",
            })) as { spawned: string; warning?: string };
            await req.executeTool("wait_tasks", {
              ids: [spawns.blocked.spawned, spawns.healthy.spawned],
              timeout_s: 5,
            });
          }
          return { stopReason: "completed", text: "done" };
        },
      }),
    });

    try {
      const chat = await daemon.director.createChat({ repoRoot, profileId: "acp:claude", model: "anthropic/claude-opus-5-5" });

      const observedAt = Date.now();
      daemon.orchestrator.quota.ingestPassiveSignal({
        profileId: "acp:gemini",
        model: null,
        raw: { sessionFailure: "auth_required", detail: "Authentication required" },
        observedAt,
      });
      const expectedUntil = new Date(observedAt + AUTH_COOLDOWN_BASE_MS).toISOString();

      await daemon.director.sendChatMessage(chat.id, "Delegate tasks");

      // Explicit model whose only route is acp:gemini is allowed (inform, don't block) with an auth warning.
      const blockedSpawn = spawns.blocked;
      assert.ok(blockedSpawn, "blocked spawn_task should have run");
      assert.ok(blockedSpawn.spawned, "spawn_task should succeed without blocking");
      assert.ok(blockedSpawn.warning, "spawn_task should include an auth warning");
      assert.ok(
        blockedSpawn.warning.includes("acp:gemini") && blockedSpawn.warning.includes(expectedUntil),
        `expected warning to mention acp:gemini and ${expectedUntil}, got: ${blockedSpawn.warning}`,
      );
      assert.match(blockedSpawn.warning, /failed (?:ACP )?auth/i);
      // Should not duplicate the auth warning even when orchestrator also provides one.
      assert.equal(
        (blockedSpawn.warning.match(/acp:gemini/g) ?? []).length,
        1,
        `auth warning should not be duplicated: ${blockedSpawn.warning}`,
      );

      // Healthy profile omits auth warning.
      const healthySpawn = spawns.healthy;
      assert.ok(healthySpawn, "healthy spawn_task should have run");
      assert.ok(healthySpawn.spawned);
      assert.equal(healthySpawn.warning, undefined);
    } finally {
      await daemon.stop();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
