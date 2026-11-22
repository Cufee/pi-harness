import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { Database } from "bun:sqlite";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  isModelEnabledInCatalog,
  ModelCatalogCompiler,
  recommendModelsByTaskKind,
  type CompiledModelCatalog,
  type CompiledModelEntry,
} from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { deriveRunStatus } from "../src/control-plane/orchestrator.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { DirectorSessionStore } from "../src/director/session.js";
import type { GoalRecord } from "../src/goals/engine.js";
import { isSubagentWaitTool } from "../src/tui/app.js";
import { ModelConfigOverlay, ModelPickerOverlay } from "../src/tui/overlays.js";
import { effectiveRunStatus } from "../src/tui/runs-tree.js";
import { renderToolOutput, type ToolDisplayPayload } from "../src/tui/tool-output/index.js";
import {
  createTheme,
  DISABLE_MOUSE_WHEEL_SEQ,
  ENABLE_MOUSE_WHEEL_SEQ,
  GoalHeader,
  OverlayManager,
  parseMouseWheel,
} from "../src/tui/primitives/index.js";
import { AgentTranscriptOverlay } from "../src/tui/transcript-overlay.js";

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-scope-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function sampleModels(): CompiledModelEntry[] {
  return [
    {
      id: "openai/gpt-6.2-astra",
      family: "gpt-6.2-astra",
      name: "GPT-6.2 Astra",
      codingRank: 1,
      codingScore: 76.2,
      scoreSource: "vals_tb4",
      benchmarks: { vals_tb4: 76.2 },
      contextK: 400,
      efforts: ["low", "medium", "high", "xhigh"],
      preferredRoute: {
        profileId: "acp:codex",
        runner: "acp",
        provider: "codex",
        wireModelId: "gpt-6.2-astra",
        billing: "subscription",
        supportedEfforts: ["low", "medium", "high", "xhigh"],
      },
      alternateRoutes: [],
      costPerTaskUsd: 0,
      apiEquivCostUsd: 1.2,
      timePerTaskSeconds: 240,
      recommendedFor: ["orchestrator", "complex_architecture", "hard_debugging", "independent_verifier"],
      enabled: true,
    },
    {
      id: "anthropic/claude-opus-5-5",
      family: "claude-opus",
      name: "Claude Opus 5.5",
      codingRank: 2,
      codingScore: 75.8,
      scoreSource: "vals_tb4",
      benchmarks: { vals_tb4: 75.8 },
      contextK: 200,
      efforts: ["low", "medium", "high", "max"],
      preferredRoute: {
        profileId: "acp:claude",
        runner: "acp",
        provider: "claude",
        wireModelId: "opus",
        billing: "subscription",
        supportedEfforts: ["low", "medium", "high", "max"],
      },
      alternateRoutes: [],
      costPerTaskUsd: 0,
      apiEquivCostUsd: 1.5,
      timePerTaskSeconds: 260,
      recommendedFor: ["orchestrator", "complex_architecture", "hard_debugging", "independent_verifier"],
      enabled: true,
    },
    {
      id: "openai/gpt-6.2-sol",
      family: "gpt-6.2-sol",
      name: "GPT-6.2 Sol",
      codingRank: 3,
      codingScore: 72.1,
      scoreSource: "vals_tb4",
      benchmarks: { vals_tb4: 72.1 },
      contextK: 400,
      efforts: ["low", "medium", "high"],
      preferredRoute: {
        profileId: "acp:codex",
        runner: "acp",
        provider: "codex",
        wireModelId: "gpt-6.2-sol",
        billing: "subscription",
        supportedEfforts: ["low", "medium", "high"],
      },
      alternateRoutes: [],
      costPerTaskUsd: 0,
      apiEquivCostUsd: 0.45,
      timePerTaskSeconds: 120,
      recommendedFor: ["worker_execution", "refactoring", "plan_synthesis", "verification"],
      enabled: true,
    },
    {
      id: "google/gemini-4-argon",
      family: "gemini-4-argon",
      name: "Gemini 4 Argon",
      codingRank: 4,
      codingScore: 63.0,
      scoreSource: "vals_tb4",
      benchmarks: { vals_tb4: 63.0 },
      contextK: 1000,
      efforts: ["low", "medium", "high"],
      preferredRoute: {
        profileId: "acp:amp",
        runner: "acp",
        provider: "generic",
        wireModelId: "google-vertex/gemini-4-argon",
        billing: "subscription",
        supportedEfforts: ["low", "medium", "high"],
      },
      alternateRoutes: [],
      costPerTaskUsd: 0,
      apiEquivCostUsd: 0.08,
      timePerTaskSeconds: 35,
      recommendedFor: ["codebase_research", "log_triage", "fast_scout"],
      enabled: true,
    },
  ];
}

describe("Session Scoping, GoalHeader Separation, Mouse Wheel Transcript Scrolling & Configurable Model List", () => {
  it("renders GoalHeader with boxed visual separation and strict width safety", () => {
    const theme = createTheme();
    const header = new GoalHeader(theme);
    assert.deepEqual(header.render(80), []);

    const goals: GoalRecord[] = [
      {
        id: "goal-11111111",
        chatSessionId: "chat-a",
        repoRoot: "/tmp/repo",
        version: 1,
        title: "Build resilient queue engine",
        description: "desc",
        criteria: [],
        nonGoals: [],
        budgets: { maxReviewCycles: 4, maxNoProgressCycles: 2 },
        status: "executing",
        linkedRunId: "run-1",
        reviewCycle: 0,
        noProgressStreak: 0,
        lastProgressFingerprint: null,
        lastReviewSummary: null,
        createdAt: 1,
        updatedAt: 20,
      },
      {
        id: "goal-22222222",
        chatSessionId: "chat-a",
        repoRoot: "/tmp/repo",
        version: 1,
        title: "Add live telemetry dashboard",
        description: "desc",
        criteria: [],
        nonGoals: [],
        budgets: { maxReviewCycles: 4, maxNoProgressCycles: 2 },
        status: "draft",
        linkedRunId: null,
        reviewCycle: 0,
        noProgressStreak: 0,
        lastProgressFingerprint: null,
        lastReviewSummary: null,
        createdAt: 1,
        updatedAt: 10,
      },
      {
        id: "goal-33333333",
        chatSessionId: "chat-a",
        repoRoot: "/tmp/repo",
        version: 1,
        title: "Older archived goal",
        description: "desc",
        criteria: [],
        nonGoals: [],
        budgets: { maxReviewCycles: 4, maxNoProgressCycles: 2 },
        status: "achieved",
        linkedRunId: null,
        reviewCycle: 1,
        noProgressStreak: 0,
        lastProgressFingerprint: null,
        lastReviewSummary: null,
        createdAt: 1,
        updatedAt: 5,
      },
    ];

    header.update(goals);
    for (const width of [40, 80, 120]) {
      const lines = header.render(width);
      assert.equal(lines.length, 4); // top border + 2 rows + bottom border
      assert.ok(lines[0]!.includes("╭─"));
      assert.ok(lines[0]!.includes("Goals"));
      assert.ok(lines[3]!.includes("╰─"));
      for (const l of lines) {
        assert.ok(visibleWidth(l) <= width, `overflow at width=${width}: ${visibleWidth(l)}`);
      }
    }
  });

  it("parses SGR/X10 mouse wheel events, scrolls AgentTranscriptOverlay, and toggles terminal mouse tracking cleanly", async () => {
    assert.deepEqual(parseMouseWheel("\x1b[<64;10;5M"), { isMouse: true, deltaLines: -3 });
    assert.deepEqual(parseMouseWheel("\x1b[<65;10;5M\x1b[<65;10;5M"), { isMouse: true, deltaLines: 6 });
    assert.deepEqual(parseMouseWheel("\x1b[<72;10;5M"), { isMouse: true, deltaLines: -9 }); // Alt+wheel up
    assert.deepEqual(parseMouseWheel("\x1b[<0;10;5M\x1b[<0;10;5m"), { isMouse: true, deltaLines: 0 }); // click ignored
    assert.deepEqual(parseMouseWheel("j"), { isMouse: false, deltaLines: 0 });

    const theme = createTheme();
    const lines = Array.from({ length: 40 }, (_, i) => `Line ${i + 1}\n`).join("");
    const overlay = new AgentTranscriptOverlay({
      theme,
      runId: "run-1",
      taskId: "t-1",
      title: "Worker",
      viewportRows: 10,
      startWatch: async () => ({
        replay: [{ seq: 1, runId: "run-1", taskId: "t-1", type: "agent.text_delta", payload: { text: lines }, createdAt: 1 }],
        stop: () => {},
      }),
      onClose: () => {},
      requestRender: () => {},
    });

    await new Promise((r) => setTimeout(r, 15));
    const atBottom = overlay.render(80).join("\n");
    assert.ok(atBottom.includes("following"));

    // Scroll up 6 lines with two SGR wheel-up ticks -> should pause following and move viewport up!
    overlay.handleInput("\x1b[<64;20;10M\x1b[<64;20;10M");
    const scrolledUp = overlay.render(80).join("\n");
    assert.ok(scrolledUp.includes("paused"));
    assert.ok(!scrolledUp.includes("Line 40"));

    // Scroll back down -> resumes following at bottom!
    overlay.handleInput("\x1b[<65;20;10M\x1b[<65;20;10M");
    const backBottom = overlay.render(80).join("\n");
    assert.ok(backBottom.includes("following"));

    // Verify OverlayManager ref-counted SGR mouse enable/disable sequences
    const writes: string[] = [];
    const fakeTui = {
      terminal: { write: (s: string) => writes.push(s) },
      showOverlay: () => ({ hide() {} }),
      setFocus() {},
      requestRender() {},
    } as unknown as TUI;
    const mgr = new OverlayManager(fakeTui, theme, { render: () => [], invalidate() {} });
    const h1 = mgr.push({ title: "Runs" }, { render: () => [], invalidate() {} }, { captureMouseWheel: true });
    const h2 = mgr.push({ title: "Transcript" }, { render: () => [], invalidate() {} }, { captureMouseWheel: true });
    assert.deepEqual(writes, [ENABLE_MOUSE_WHEEL_SEQ]); // enabled once on 0 -> 1
    h2.close();
    assert.deepEqual(writes, [ENABLE_MOUSE_WHEEL_SEQ]); // still 1 open -> stays enabled
    h1.close();
    assert.deepEqual(writes, [ENABLE_MOUSE_WHEEL_SEQ, DISABLE_MOUSE_WHEEL_SEQ]); // disabled on 1 -> 0!
  });

  it("scopes goals, runs.trees, and run.list strictly to the active chat session", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-scoping-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(repoDir);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async () => ({ text: "ok", stopReason: "completed" }),
      }),
    });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      const chatA = await client.request<{ session: { id: string }; goals: GoalRecord[] }>("chat.create", {
        repoRoot: repoDir,
        title: "Session A",
      });
      const goalA = await client.request<GoalRecord>("goal.create", {
        repoRoot: repoDir,
        chatSessionId: chatA.session.id,
        title: "Goal belonging to Chat A",
        description: "Only for A",
        criteria: [{ description: "Pass", kind: "behavioral" }],
      });
      const runA = daemon.db.createRun({ goal: "Run A", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      daemon.director.goals.linkRunAndStart(goalA.id, runA.id);

      const chatB = await client.request<{ session: { id: string }; goals: GoalRecord[] }>("chat.create", {
        repoRoot: repoDir,
        title: "Session B",
      });
      assert.equal(chatB.goals.length, 0, "New chat B must NOT see goals from chat A");

      const goalsA = await client.request<GoalRecord[]>("goal.list", { repoRoot: repoDir, chatSessionId: chatA.session.id });
      const goalsB = await client.request<GoalRecord[]>("goal.list", { repoRoot: repoDir, chatSessionId: chatB.session.id });
      assert.equal(goalsA.length, 1);
      assert.equal(goalsA[0]!.id, goalA.id);
      assert.equal(goalsB.length, 0);

      const treesA = await client.request<{ runs: Array<{ run: { id: string } }> }>("runs.trees", {
        chatSessionId: chatA.session.id,
      });
      const treesB = await client.request<{ runs: Array<{ run: { id: string } }> }>("runs.trees", {
        chatSessionId: chatB.session.id,
      });
      assert.deepEqual(treesA.runs.map((r) => r.run.id), [runA.id]);
      assert.deepEqual(treesB.runs, []);

      const listA = await client.request<Array<{ id: string }>>("run.list", { chatSessionId: chatA.session.id });
      const listB = await client.request<Array<{ id: string }>>("run.list", { chatSessionId: chatB.session.id });
      assert.deepEqual(listA.map((r) => r.id), [runA.id]);
      assert.deepEqual(listB, []);
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("supports toggling models on/off, Toggle All Off, Enable All, and task-kind model recommendations", () => {
    const models = sampleModels();
    const theme = createTheme();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-models-cfg-"));
    try {
      const cfg = loadConfig();
      cfg.stateDir = stateDir;
      // Isolate from any local ~/.pi-harness/config.json model toggles on the test machine
      cfg.catalog = { ...cfg.catalog, modelFilterMode: "all", disabledModels: [], enabledModels: [] };

      // Default: all ranked models enabled
      assert.equal(models.every((m) => isModelEnabledInCatalog(m.id, cfg.catalog)), true);

      // Task-kind recommendations choose DIFFERENT appropriate models per kind (not same as Director!)
      const recs = recommendModelsByTaskKind(models, { avoidModelId: "openai/gpt-6.2-astra" });
      assert.equal(recs.research?.model, "google/gemini-4-argon");
      assert.equal(recs.research?.effort, "low");
      assert.equal(recs.worker?.model, "openai/gpt-6.2-sol");
      assert.equal(recs.verify?.model, "anthropic/claude-opus-5-5"); // avoids generator openai/gpt-6.2-astra!
      assert.equal(recs.verify?.effort, "high");

      // Interactive ModelConfigOverlay: Toggle All Off (`x`), then select 1 model (`enter`), then Enable All (`a`)
      let latestCfg = cfg;
      const fakeClient = {
        request: async (_op: string, params?: Record<string, unknown>) => {
          const patch = (params?.patch ?? {}) as { catalog?: typeof cfg.catalog };
          latestCfg = { ...latestCfg, catalog: { ...latestCfg.catalog, ...(patch.catalog ?? {}) } };
          return latestCfg;
        },
      } as unknown as DaemonClient;

      const overlay = new ModelConfigOverlay(
        theme,
        fakeClient,
        process.cwd(),
        cfg,
        (next) => {
          latestCfg = next;
        },
        () => {},
        () => {},
        models,
      );

      // 1. Toggle ALL off with 'x'
      overlay.handleInput("x");
      assert.equal(latestCfg.catalog.modelFilterMode, "allowlist");
      assert.deepEqual(latestCfg.catalog.enabledModels, []);
      assert.equal(models.filter((m) => isModelEnabledInCatalog(m.id, latestCfg.catalog)).length, 0);

      // 2. Toggle first model ON with Enter
      overlay.handleInput("\r");
      assert.equal(latestCfg.catalog.modelFilterMode, "allowlist");
      assert.deepEqual(latestCfg.catalog.enabledModels, ["openai/gpt-6.2-astra"]);
      assert.equal(isModelEnabledInCatalog("openai/gpt-6.2-astra", latestCfg.catalog), true);
      assert.equal(isModelEnabledInCatalog("openai/gpt-6.2-sol", latestCfg.catalog), false);

      // 3. Enable ALL with 'a'
      overlay.handleInput("a");
      assert.equal(latestCfg.catalog.modelFilterMode, "all");
      assert.deepEqual(latestCfg.catalog.disabledModels, []);
      assert.equal(models.every((m) => isModelEnabledInCatalog(m.id, latestCfg.catalog)), true);

      // Width safety check
      for (const w of [48, 80, 120]) {
        for (const line of overlay.render(w)) {
          assert.ok(visibleWidth(line) <= w, `ModelConfigOverlay overflowed ${w}: ${visibleWidth(line)}`);
        }
      }

      // Verify ModelCatalogCompiler filters disabled models out unless includeDisabled=true
      const compiler = new ModelCatalogCompiler({
        ...cfg,
        catalog: { ...cfg.catalog, modelFilterMode: "allowlist", enabledModels: ["openai/gpt-6.2-sol"] },
      });
      assert.equal(isModelEnabledInCatalog("openai/gpt-6.2-sol", compiler["config"].catalog), true);
      assert.equal(isModelEnabledInCatalog("openai/gpt-6.2-astra", compiler["config"].catalog), false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("persists per-session model selection context via discovery agent and returns it to agents and users", async () => {
    // 1. Verify safe migration of legacy chat_sessions tables without model_selection_context
    const legacyDb = new Database(":memory:");
    legacyDb.exec(`
      CREATE TABLE chat_sessions (
        id TEXT PRIMARY KEY,
        repo_root TEXT NOT NULL,
        title TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        model TEXT,
        effort TEXT,
        acp_session_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO chat_sessions(id, repo_root, title, profile_id, created_at, updated_at)
      VALUES ('chat-legacy', '/tmp/legacy', 'Legacy', 'acp:codex', 1, 1);
    `);
    const migratedStore = new DirectorSessionStore(legacyDb);
    assert.equal(migratedStore.getSession("chat-legacy")?.modelSelectionContext, null);
    legacyDb.close();

    // 2. End-to-end daemon + Director tool + ControlPlane tool + /model overlay rendering
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-model-ctx-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(repoDir);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async () => ({ text: "ok", stopReason: "completed" }),
      }),
    });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      const chatA = await client.request<{ session: { id: string; modelSelectionContext: string | null } }>("chat.create", {
        repoRoot: repoDir,
        title: "Session A",
      });
      const chatB = await client.request<{ session: { id: string; modelSelectionContext: string | null } }>("chat.create", {
        repoRoot: repoDir,
        title: "Session B",
      });
      // Empty/null by default
      assert.equal(chatA.session.modelSelectionContext, null);
      assert.equal(chatB.session.modelSelectionContext, null);

      const defaultModelsA = await client.request<CompiledModelCatalog>("models.list", {
        cwd: repoDir,
        chatSessionId: chatA.session.id,
      });
      assert.equal(defaultModelsA.sessionModelContext, null);

      // Director (discovery agent) sets per-session context on chatA
      const guidance = "Prefer Claude Opus for planning/architecture and utilize Gemini family more for research.";
      const setRes = (await daemon.director.executeDirectorMcpTool(chatA.session.id, "set_model_selection_context", {
        context: guidance,
      })) as { chatSessionId: string; sessionModelContext: string | null };
      assert.equal(setRes.chatSessionId, chatA.session.id);
      assert.equal(setRes.sessionModelContext, guidance);

      // Returned to Director list_models (chatA sees it, chatB does not)
      const dirModelsA = (await daemon.director.executeDirectorMcpTool(chatA.session.id, "list_models", {})) as {
        sessionModelContext: string | null;
      };
      const dirModelsB = (await daemon.director.executeDirectorMcpTool(chatB.session.id, "list_models", {})) as {
        sessionModelContext: string | null;
      };
      assert.equal(dirModelsA.sessionModelContext, guidance);
      assert.equal(dirModelsB.sessionModelContext, null);

      // Returned to user via daemon models.list RPC (isolated per session)
      const userModelsA = await client.request<CompiledModelCatalog>("models.list", {
        cwd: repoDir,
        chatSessionId: chatA.session.id,
      });
      const userModelsB = await client.request<CompiledModelCatalog>("models.list", {
        cwd: repoDir,
        chatSessionId: chatB.session.id,
      });
      assert.equal(userModelsA.sessionModelContext, guidance);
      assert.equal(userModelsB.sessionModelContext, null);

      // Returned to Tier 1/2 spawned agents via ControlPlaneToolExecutor list_models
      const goalA = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chatA.session.id,
        title: "Goal A",
        description: "Test session context propagation",
        criteria: [{ description: "Pass", kind: "behavioral" }],
      });
      const runA = daemon.db.createRun({ goal: "Run A", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      daemon.director.goals.linkRunAndStart(goalA.id, runA.id);
      const orchTaskA = daemon.db.createTask({
        runId: runA.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch A",
        objective: "Plan",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-astra",
      });
      const agentModelsA = (await daemon.orchestrator.toolExecutor.execute(runA.id, orchTaskA.id, "list_models", {})) as {
        sessionModelContext: string | null;
      };
      assert.equal(agentModelsA.sessionModelContext, guidance);

      // Unrelated run for chatB gets null
      const goalB = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chatB.session.id,
        title: "Goal B",
        description: "Other session",
        criteria: [{ description: "Pass", kind: "behavioral" }],
      });
      const runB = daemon.db.createRun({ goal: "Run B", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      daemon.director.goals.linkRunAndStart(goalB.id, runB.id);
      const orchTaskB = daemon.db.createTask({
        runId: runB.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch B",
        objective: "Plan",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-astra",
      });
      const agentModelsB = (await daemon.orchestrator.toolExecutor.execute(runB.id, orchTaskB.id, "list_models", {})) as {
        sessionModelContext: string | null;
      };
      assert.equal(agentModelsB.sessionModelContext, null);

      // ModelPickerOverlay renders the banner when set (width-safe across 48/80/120) and omits it when null
      const theme = createTheme();
      const catalogWithCtx: CompiledModelCatalog = {
        syncedAt: new Date().toISOString(),
        sources: ["fixture"],
        sessionModelContext: guidance,
        models: sampleModels(),
      };
      const pickerWithCtx = new ModelPickerOverlay(
        theme,
        client,
        repoDir,
        catalogWithCtx,
        null,
        null,
        () => {},
        () => {},
        () => {},
      );
      for (const w of [48, 80, 120]) {
        const lines = pickerWithCtx.render(w);
        assert.ok(lines.some((l) => l.includes("Session model context:")));
        for (const l of lines) {
          assert.ok(visibleWidth(l) <= w, `ModelPickerOverlay overflowed ${w}: ${visibleWidth(l)}`);
        }
      }

      const pickerNoCtx = new ModelPickerOverlay(
        theme,
        client,
        repoDir,
        { ...catalogWithCtx, sessionModelContext: null },
        null,
        null,
        () => {},
        () => {},
        () => {},
      );
      assert.equal(pickerNoCtx.render(80).some((l) => l.includes("Session model context:")), false);

      // Clearing via empty string resets to null
      const cleared = (await daemon.director.executeDirectorMcpTool(chatA.session.id, "set_model_selection_context", {
        context: "",
      })) as { sessionModelContext: string | null };
      assert.equal(cleared.sessionModelContext, null);
      const afterClear = await client.request<CompiledModelCatalog>("models.list", {
        cwd: repoDir,
        chatSessionId: chatA.session.id,
      });
      assert.equal(afterClear.sessionModelContext, null);
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("reconciles dynamic run status, native goal card printing, subagent-wait indicator, and clean rollover handoffs", async () => {
    // 1. Subagent wait vs Director thinking classification
    assert.equal(isSubagentWaitTool("wait_tasks"), true);
    assert.equal(isSubagentWaitTool("mcp__harness__wait_children"), true);
    assert.equal(isSubagentWaitTool("goal_trigger_review"), true);
    assert.equal(isSubagentWaitTool("goal_list"), false);
    assert.equal(isSubagentWaitTool("list_models"), false);

    // 2. Dynamic run status never contradicts running or settled tasks
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-dyn-status-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(repoDir);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async () => ({ text: "ok", stopReason: "completed" }),
      }),
    });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      // Run wrongly marked `completed` while a child worker is still `running` -> must dynamically report `active`!
      const runWithChild = daemon.db.createRun({ goal: "Child still running", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      const t1 = daemon.db.createTask({
        runId: runWithChild.id, tier: 1, kind: "orchestrator", title: "Orch", objective: "Coord", profileId: "acp:codex", model: "openai/gpt-6.2-astra",
      });
      const t2 = daemon.db.createTask({
        runId: runWithChild.id, parentId: t1.id, tier: 2, kind: "worker", title: "Worker", objective: "Code", profileId: "acp:codex", model: "openai/gpt-6.2-sol",
      });
      daemon.db.updateTask(t1.id, { status: "completed" });
      daemon.db.updateTask(t2.id, { status: "running" });
      daemon.db.updateRunStatus(runWithChild.id, "completed");

      const effWhileRunning = daemon.orchestrator.getEffectiveRun(runWithChild.id)!;
      assert.equal(effWhileRunning.status, "active", "Run with running task must NEVER report completed");
      assert.equal(
        effectiveRunStatus({ run: { ...runWithChild, status: "completed" }, tasks: [daemon.db.getTask(t1.id)!, daemon.db.getTask(t2.id)!], escalations: [], quotaPause: null }),
        "active",
      );

      // Run wrongly stuck in `active` after all tasks finished (e.g. director-tasks-* or crashed finish) -> must report `completed`!
      daemon.db.updateTask(t2.id, { status: "completed" });
      daemon.db.updateRunStatus(runWithChild.id, "active");
      const effAfterDone = daemon.orchestrator.getEffectiveRun(runWithChild.id)!;
      assert.equal(effAfterDone.status, "completed", "Run with all terminal tasks must NEVER stay active");
      assert.equal(
        deriveRunStatus({ ...runWithChild, status: "active" }, [daemon.db.getTask(t1.id)!, daemon.db.getTask(t2.id)!], false),
        "completed",
      );

      // Startup stale-run reconciliation clears orphaned `running` tasks left by a dead daemon
      const staleRun = daemon.db.createRun({ goal: "Dead daemon run", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      const staleTask = daemon.db.createTask({
        runId: staleRun.id, tier: 1, kind: "orchestrator", title: "Orphan", objective: "Old", profileId: "acp:codex", model: "openai/gpt-6.2-astra",
      });
      daemon.db.updateTask(staleTask.id, { status: "running" });
      daemon.orchestrator.reconcileStaleRunsOnStartup();
      assert.equal(daemon.db.getTask(staleTask.id)?.status, "failed");
      assert.equal(daemon.db.getRun(staleRun.id)?.status, "failed");

      // 3. Native goal UI printing for BOTH user (`goal.get` / `goal.table_display`) AND Director (`goal_create`)
      const chat = await client.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Goals Print Test",
      });
      const created = (await daemon.director.executeDirectorMcpTool(chat.session.id, "goal_create", {
        title: "Native Goal Card",
        description: "Verify native card rendering",
        criteria: [{ id: "c1", kind: "deterministic", description: "Tests pass", command: "bun test" }],
        non_goals: ["Unrelated refactor"],
      })) as { id: string; rendered_in_ui?: string };
      assert.ok(created.rendered_in_ui?.includes("Goal detail card"));

      const detailRes = await client.request<{ display: ToolDisplayPayload }>("goal.get", {
        goalId: created.id,
        persistChatSessionId: chat.session.id,
      });
      assert.equal(detailRes.display.kind, "goal_detail");
      const theme = createTheme();
      const rendered = renderToolOutput(detailRes.display, 100, theme);
      const plain = rendered.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(plain.includes("╭─"));
      assert.ok(plain.includes("Native Goal Card"));
      assert.ok(plain.includes("$ bun test"));
      assert.ok(plain.includes("Unrelated refactor"));
      assert.ok(plain.includes("╰─"));
      for (const l of rendered) assert.ok(visibleWidth(l) <= 100);

      const tableRes = await client.request<{ display: ToolDisplayPayload }>("goal.table_display", {
        repoRoot: repoDir,
        chatSessionId: chat.session.id,
        persistChatSessionId: chat.session.id,
      });
      assert.equal(tableRes.display.kind, "goals_table");
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
