import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { buildRunActivitySummary } from "../src/control-plane/telemetry.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { DirectorSessionStore } from "../src/director/session.js";
import { GoalEngine, shouldRunIndependentReview, type GoalRecord } from "../src/goals/engine.js";
import {
  buildGoalDetailDisplay,
  buildGoalsTableDisplay,
  buildRunActivityDisplay,
} from "../src/protocol/tool-display.js";
import { QuotaClient } from "../src/quota/client.js";
import { parseCodexRateLimitsFromJsonl } from "../src/quota/local-harvest.js";
import { isSubagentWaitTool, historyTurnComponent } from "../src/tui/app.js";
import { ModelConfigOverlay, ModelPickerOverlay, QuotaOverlay } from "../src/tui/overlays.js";
import { effectiveRunStatus } from "../src/tui/runs-tree.js";
import { renderToolOutput, type ToolDisplayPayload } from "../src/tui/tool-output/index.js";
import {
  createTheme,
  DISABLE_MOUSE_WHEEL_SEQ,
  ENABLE_MOUSE_WHEEL_SEQ,
  EventCard,
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

  it("lets agents choose proportional verification depth (none / deterministic / auto / independent_review) without hardcoded review overhead", async () => {
    // 1. Safe migration of legacy goals table lacking verification_mode
    const legacyDb = new Database(":memory:");
    legacyDb.exec(`
      CREATE TABLE goals (
        id TEXT PRIMARY KEY,
        chat_session_id TEXT,
        repo_root TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        criteria_json TEXT NOT NULL,
        non_goals_json TEXT NOT NULL DEFAULT '[]',
        budgets_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        linked_run_id TEXT,
        review_cycle INTEGER NOT NULL DEFAULT 0,
        no_progress_streak INTEGER NOT NULL DEFAULT 0,
        last_progress_fingerprint TEXT,
        last_review_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO goals(id, repo_root, title, description, criteria_json, budgets_json, created_at, updated_at)
      VALUES ('goal-legacy', '/tmp/repo', 'Legacy', 'Desc', '[]', '{"maxReviewCycles":4,"maxNoProgressCycles":2}', 1, 1);
    `);
    const migratedGoals = new GoalEngine(legacyDb);
    assert.equal(migratedGoals.getGoal("goal-legacy")?.verificationMode, "auto");
    legacyDb.close();

    // 2. End-to-end verification depth selection
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-verify-mode-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(repoDir);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    let reviewerRuns = 0;
    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async (req) => {
          reviewerRuns += 1;
          await req.executeTool("submit_review_verdict", {
            verdict: "approved",
            criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Checked" }],
            summary: "Independent review passed",
          });
          return { text: "", stopReason: "completed" };
        },
      }),
    });
    await daemon.start();
    try {
      // A. Deterministic-only goal under `auto`: approves at $0 LLM cost without spawning reviewer!
      const detGoal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        title: "Simple operational update",
        description: "Run deterministic check only",
        criteria: [{ id: "c1", kind: "deterministic", description: "Exit 0", command: "true" }],
      });
      assert.equal(shouldRunIndependentReview(detGoal), false);
      const detRes = await daemon.director.verifyAndReviewGoal(detGoal.id);
      assert.equal(detRes.goal.status, "achieved");
      assert.equal(detRes.review.verdict, "approved");
      assert.equal(reviewerRuns, 0, "Deterministic-only goal must NOT spawn redundant LLM reviewer");

      // B. `verificationMode: "none"` allows zero criteria and approves immediately without gates or LLM reviewer!
      const noneGoal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        title: "Quick trivial chore",
        description: "No separate verification needed",
        criteria: [],
        verificationMode: "none",
      });
      const noneRes = await daemon.director.verifyAndReviewGoal(noneGoal.id, undefined, { summary: "Done directly" });
      assert.equal(noneRes.goal.status, "achieved");
      assert.equal(reviewerRuns, 0);

      // C. `verificationMode: "deterministic"` skips LLM reviewer even when behavioral criteria exist
      const detOverrideGoal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        title: "Behavioral note but deterministic mode",
        description: "Check command suffices",
        criteria: [
          { id: "c1", kind: "deterministic", description: "Check passes", command: "true" },
          { id: "c2", kind: "behavioral", description: "Looks clean" },
        ],
        verificationMode: "deterministic",
      });
      const detOverrideRes = await daemon.director.verifyAndReviewGoal(detOverrideGoal.id);
      assert.equal(detOverrideRes.goal.status, "achieved");
      assert.equal(reviewerRuns, 0);

      // D. Required behavioral criterion under `auto` STILL spawns Independent Done-Reviewer!
      const behGoal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        title: "Complex architecture change",
        description: "Needs independent review",
        criteria: [{ id: "c1", kind: "behavioral", description: "Meets architectural contract" }],
      });
      assert.equal(shouldRunIndependentReview(behGoal), true);
      const behRes = await daemon.director.verifyAndReviewGoal(behGoal.id);
      assert.equal(behRes.goal.status, "achieved");
      assert.equal(reviewerRuns, 1);
    } finally {
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("harvests local/passive ACP quota without an endpoint and displays it alongside the settings note", () => {
    const codexHome = mkdtempSync(join(tmpdir(), "pi-harness-codex-quota-"));
    try {
      const sessDir = join(codexHome, "sessions", "2026", "11", "22");
      mkdirSync(sessDir, { recursive: true });
      const futureResetSec = Math.floor((Date.now() + 3 * 3600_000) / 1000);
      const jsonl = [
        JSON.stringify({
          timestamp: new Date().toISOString(),
          type: "event_msg",
          payload: {
            type: "token_count",
            rate_limits: {
              limit_id: "codex",
              primary: { used_percent: 42.5, window_minutes: 300, resets_at: futureResetSec },
              secondary: { used_percent: 90.0, window_minutes: 10080, resets_at: futureResetSec + 86400 },
              credits: { has_credits: true, unlimited: false, balance: null },
            },
          },
        }),
      ].join("\n");
      writeFileSync(join(sessDir, "rollout-2026-11-22T09-00-00-test.jsonl"), jsonl, "utf8");

      const parsed = parseCodexRateLimitsFromJsonl(jsonl);
      assert.ok(parsed);
      assert.equal(parsed!.snapshots.length, 1);
      assert.equal(parsed!.snapshots[0]!.primary?.used_percent, 42.5);

      const profiles = [
        { id: "acp:codex", kind: "acp" as const, adapter: "codex" as const, command: "codex-acp", billing: "subscription" as const, enabled: true },
        { id: "acp:claude", kind: "acp" as const, adapter: "claude" as const, command: "claude-agent-acp", billing: "subscription" as const, enabled: true },
        { id: "acp:amp", kind: "acp" as const, adapter: "generic" as const, command: "amp-acp", billing: "subscription" as const, enabled: true },
      ];

      // No endpoint configured!
      const quota = new QuotaClient();
      assert.equal(quota.isConfigured(), false);
      const count = quota.harvestLocal(profiles, { codexHome, force: true });
      assert.equal(count, 1);

      // Also ingest a live Claude passive ACP signal
      quota.ingestPassiveSignal({
        profileId: "acp:claude",
        model: "opus",
        raw: { status: "allowed", rateLimitType: "five_hour", utilization: 0.35, resetsAt: futureResetSec },
        observedAt: Date.now(),
      });

      const effJson = quota.getEffectiveSnapshotJson() as {
        metadata?: Record<string, string>;
        buckets?: Array<{ bucketId: string; displayName?: string; windows?: Array<{ label?: string; usedPercent?: number }> }>;
      };
      assert.ok(effJson);
      assert.equal(effJson.metadata?.source, "passive_local");
      assert.ok(effJson.buckets?.some((b) => b.bucketId === "acp:codex:codex"));
      assert.ok(effJson.buckets?.some((b) => b.bucketId === "acp:claude:all"));

      const coverage = quota.getProfileQuotaCoverage(profiles);
      assert.equal(coverage.find((c) => c.profileId === "acp:codex")?.source, "local_session");
      assert.equal(coverage.find((c) => c.profileId === "acp:claude")?.source, "acp_passive");
      assert.equal(coverage.find((c) => c.profileId === "acp:amp")?.source, "none");

      // QuotaOverlay renders BOTH the endpoint-in-settings note AND the live harvested quota table + profile coverage!
      const theme = createTheme();
      const overlay = new QuotaOverlay(
        theme,
        {} as unknown as DaemonClient,
        { configured: false, snapshot: effJson as unknown as Record<string, unknown>, coverage },
        () => {},
        () => {},
      );
      for (const w of [60, 90, 120]) {
        const lines = overlay.render(w);
        const plain = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
        const flat = plain.replace(/\s+/g, " ");
        assert.ok(flat.includes("Quota Endpoint URL"));
        assert.ok(flat.includes("/settings"));
        assert.ok(plain.includes("Codex"));
        assert.ok(plain.includes("acp:amp"));
        for (const l of lines) {
          assert.ok(visibleWidth(l) <= w, `QuotaOverlay overflowed ${w}: ${visibleWidth(l)}`);
        }
      }
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("drives Director & child waits via events with long configurable fallback watchdog instead of polling", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-events-wake-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(repoDir);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;
    // Default fallback interval is long (600s = 10m) so agents don't thrash/poll
    assert.equal(cfg.events.fallbackWakeupIntervalSec, 600);
    assert.equal(cfg.events.wakeDirectorOnGoalSettle, true);

    const directorWakePrompts: string[] = [];
    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) {
            directorWakePrompts.push(req.initialPrompt);
            return { text: "Goal completed and reported via event wakeup.", stopReason: "completed" };
          }
          return { text: "ok", stopReason: "completed" };
        },
      }),
    });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();

    try {
      // 1. Event-driven waitForChildren wakes immediately on task.status event (zero polling)
      const run = daemon.db.createRun({ goal: "Event wait test", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      const parent = daemon.db.createTask({
        runId: run.id, tier: 1, kind: "orchestrator", title: "Parent", objective: "Wait", profileId: "acp:codex", model: "openai/gpt-6.2-astra",
      });
      const child = daemon.db.createTask({
        runId: run.id, parentId: parent.id, tier: 2, kind: "worker", title: "Child", objective: "Work", profileId: "acp:codex", model: "openai/gpt-6.2-sol",
      });
      daemon.db.updateTask(child.id, { status: "running" });

      const waitPromise = daemon.orchestrator.waitForChildrenEventDriven(parent.id, [child.id], "all", 60_000);
      setTimeout(() => {
        daemon.db.updateTask(child.id, { status: "completed", summary: "Done quickly" });
      }, 25);
      const t0 = Date.now();
      const waitRes = await waitPromise;
      assert.equal(waitRes.wakeReason, "event");
      assert.ok(Date.now() - t0 < 2000, "Event-driven wait must wake immediately, not at fallback interval");

      // 2. Fallback watchdog detects a dead child stuck in `running` with no active runner!
      const deadChild = daemon.db.createTask({
        runId: run.id, parentId: parent.id, tier: 2, kind: "worker", title: "Dead child", objective: "Hung", profileId: "acp:codex", model: "openai/gpt-6.2-sol",
      });
      daemon.db.updateTask(deadChild.id, { status: "running" });
      const fallbackRes = await daemon.orchestrator.waitForChildrenEventDriven(parent.id, [deadChild.id], "all", 60);
      assert.equal(fallbackRes.wakeReason, "child_inactive");
      assert.deepEqual(fallbackRes.inactiveTaskIds, [deadChild.id]);

      // 3. Automatic Director wakeup when a linked Goal's run completes (AND goal_wait event wake)!
      const chat = await client.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Event Wake Session",
      });
      const goal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chat.session.id,
        title: "Wake Director on Completion",
        description: "Verify event-driven director wake",
        criteria: [{ id: "c1", kind: "deterministic", description: "Pass", command: "true" }],
      });
      const goalRun = daemon.db.createRun({ goal: "Goal run", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      daemon.director.goals.linkRunAndStart(goal.id, goalRun.id);

      const goalWaitPromise = daemon.director.waitForGoalEvent(goal.id, 60_000);
      setTimeout(() => {
        daemon.db.updateRunStatus(goalRun.id, "completed");
      }, 25);
      const goalWaitRes = await goalWaitPromise;
      assert.equal(goalWaitRes.wakeReason, "event");
      assert.equal(goalWaitRes.runStatus, "completed");

      // Wait briefly for the async Director wakeup turn to complete
      for (let i = 0; i < 40 && directorWakePrompts.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(directorWakePrompts.length, 1, "Director must be woken automatically by Goal run settlement event");
      assert.ok(directorWakePrompts[0]!.includes(goal.id));

      // 4. Transcript header includes model name (+ effort) when opening an agent transcript
      const theme = createTheme();
      const tr = new AgentTranscriptOverlay({
        theme,
        runId: "run-999",
        taskId: "t-999",
        title: "Worker slice",
        model: "google/gemini-4-neon",
        effort: "high",
        viewportRows: 8,
        startWatch: async () => ({ replay: [], stop: () => {} }),
        onClose: () => {},
        requestRender: () => {},
      });
      const headerLine = tr.render(100)[0]!.replace(/\x1b\[[0-9;]*m/g, "");
      assert.ok(headerLine.includes("google/gemini-4-neon (high)"));

      // 5. User message while Director is blocked in goal_wait immediately unblocks the wait without killing background work
      const waitChat = await client.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Unblock Wait Session",
      });
      const longGoal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: waitChat.session.id,
        title: "Long background goal",
        description: "Still running while user messages Director",
        criteria: [{ id: "c1", kind: "deterministic", description: "Pass", command: "true" }],
      });
      const longRun = daemon.db.createRun({ goal: "Long run", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      daemon.director.goals.linkRunAndStart(longGoal.id, longRun.id);

      let waitToolResult: Record<string, unknown> | null = null;
      const daemon2 = new HarnessDaemon(
        { ...cfg, socketPath: join(stateDir, "d2.sock") },
        {
          dbPath: join(stateDir, "cp2.sqlite"),
          customRunnerFactory: () => ({
            run: async (req) => {
              waitToolResult = (await req.executeTool("goal_wait", {
                goal_id: longGoal2.id,
                fallback_interval_s: 600,
              })) as Record<string, unknown>;
              return { text: "Received user message immediately while background goal kept running.", stopReason: "completed" };
            },
          }),
        },
      );
      await daemon2.start();
      const chat2 = await daemon2.director.createChat({ repoRoot: repoDir, title: "Interrupt test" });
      const longGoal2 = daemon2.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chat2.id,
        title: "Long background goal",
        description: "Still running",
        criteria: [{ id: "c1", kind: "deterministic", description: "Pass", command: "true" }],
      });
      const longRun2 = daemon2.db.createRun({ goal: "Long run", repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      daemon2.director.goals.linkRunAndStart(longGoal2.id, longRun2.id);

      try {
        const sendPromise = daemon2.director.sendChatMessage(chat2.id, "Wait on the goal");
        await new Promise((r) => setTimeout(r, 30));
        const tStart = Date.now();
        const steered = await daemon2.director.steerChat(chat2.id, "Prefer Neon for subagents", { role: "user" });
        assert.equal(steered, true);
        await sendPromise;
        assert.ok(Date.now() - tStart < 1500, "User message must unblock goal_wait immediately");
        assert.equal((waitToolResult as Record<string, unknown> | null)?.wakeReason, "user_message");
        assert.equal((waitToolResult as Record<string, unknown> | null)?.userMessage, "Prefer Neon for subagents");
        assert.equal(daemon2.db.getRun(longRun2.id)?.status, "active", "Background run must keep running uninterrupted");
      } finally {
        await daemon2.stop();
      }
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("projects structured subagent telemetry automatically and renders dynamic Goal verification without hardcoded counts", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-telemetry-test-"));
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
      const chat = await client.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Telemetry Session",
      });
      const goal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chat.session.id,
        title: "Dynamic telemetry goal",
        description: "Verify zero-tool-call telemetry projection and dynamic review columns",
        criteria: [
          { id: "c1", kind: "deterministic", description: "Typecheck passes", command: "bun run typecheck" },
          { id: "c2", kind: "behavioral", description: "UI renders cleanly" },
        ],
      });
      const run = daemon.db.createRun({ goal: goal.title, repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      daemon.director.goals.linkRunAndStart(goal.id, run.id);

      const orch = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orchestrator",
        objective: "Coordinate workers",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-astra",
        effort: "medium",
      });
      daemon.db.updateTask(orch.id, { status: "running" });

      const worker = daemon.db.createTask({
        runId: run.id,
        parentId: orch.id,
        tier: 2,
        kind: "worker",
        title: "Implement auth middleware",
        objective: "Add auth middleware",
        profileId: "acp:claude",
        model: "anthropic/claude-opus-5-5",
        effort: "high",
      });
      daemon.db.updateTask(worker.id, { status: "running" });

      // Simulate normal ACP tool execution events (no extra telemetry tool calls from the model!)
      daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
        name: "read_file",
        title: "read_file src/auth.ts",
        input: { path: "src/auth.ts" },
        status: "completed",
      });
      daemon.db.emitEvent(run.id, worker.id, "agent.tool", {
        name: "edit_file",
        title: "edit_file src/auth.ts",
        input: { path: "src/auth.ts" },
        status: "running",
      });

      const activity1 = buildRunActivitySummary(daemon.db, run.id);
      assert.ok(activity1);
      assert.equal(activity1.phase, "implementing");
      assert.equal(activity1.counts.running, 2);
      assert.equal(activity1.filesEdited, 1);
      const workerSnap = activity1.tasks.find((t) => t.id === worker.id);
      assert.ok(workerSnap);
      assert.equal(workerSnap.toolCalls, 2);
      assert.equal(workerSnap.filesEdited, 1);
      assert.equal(workerSnap.currentAction, "⚙ edit_file src/auth.ts");

      // Goals table & detail must NEVER show hardcoded 0/4; they reflect dynamic implementing phase
      const activeGoal = daemon.director.goals.getGoal(goal.id)!;
      const tasksNow = daemon.db.listTasks(run.id);
      const tablePayload = buildGoalsTableDisplay([
        { goal: activeGoal, reviews: [], openEscalations: [], tasks: tasksNow, activity: activity1 },
      ]);
      const detailPayload = buildGoalDetailDisplay({
        goal: activeGoal,
        reviews: [],
        tasks: tasksNow,
        openEscalations: [],
        activity: activity1,
      });
      const activityPayload = buildRunActivityDisplay(activity1);

      const theme = createTheme();
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

      for (const payload of [tablePayload, detailPayload, activityPayload]) {
        for (const w of [60, 100, 120]) {
          const lines = renderToolOutput(payload, w, theme);
          assert.ok(lines && lines.length > 0);
          for (const line of lines) {
            assert.ok(visibleWidth(line) <= w, `${payload.kind} overflowed width ${w}: ${visibleWidth(line)}`);
          }
        }
      }

      const tableText = renderToolOutput(tablePayload, 120, theme).map(strip).join("\n");
      assert.equal(tableText.includes("0/4"), false, "Goals table must not show hardcoded 0/4");
      assert.ok(tableText.includes("implementing"), `Expected dynamic phase in table:\n${tableText}`);

      const detailText = renderToolOutput(detailPayload, 120, theme).map(strip).join("\n");
      assert.equal(detailText.includes("Review 0/4"), false, "Goal detail must not show hardcoded Review 0/4");
      assert.ok(detailText.includes("Subagents"), `Expected live subagent breakdown in goal detail:\n${detailText}`);
      assert.ok(detailText.includes("edit_file src/auth.ts"));

      const activityText = renderToolOutput(activityPayload, 120, theme).map(strip).join("\n");
      assert.ok(activityText.includes("● implementing"));
      assert.ok(activityText.includes("1 file edited"));
      assert.ok(activityText.includes("edit_file src/auth.ts"));

      // Optional report_goal_progress updates live criterion status without running a full Goal review cycle
      const progRes = (await daemon.orchestrator.toolExecutor.execute(run.id, worker.id, "report_goal_progress", {
        summary: "Middleware implemented and typecheck green",
        criteria_results: [{ criterion_id: "c1", passed: true, evidence: "bun run typecheck exited 0" }],
      })) as { recorded: boolean; goalId: string };
      assert.equal(progRes.recorded, true);
      assert.equal(progRes.goalId, goal.id);

      // Spawning and completing a verify task automatically marks verification passed on the Goal
      const verifier = daemon.db.createTask({
        runId: run.id,
        parentId: orch.id,
        tier: 2,
        kind: "verify",
        title: "Independent verification",
        objective: "Verify auth middleware",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-astra",
      });
      daemon.db.updateTask(verifier.id, { status: "running" });
      assert.equal(buildRunActivitySummary(daemon.db, run.id)?.phase, "verifying");

      await daemon.orchestrator.toolExecutor.execute(run.id, verifier.id, "return_task", {
        status: "completed",
        summary: "All auth checks verified",
        sources: [{ path: "src/auth.ts", note: "verified middleware implementation" }],
      });
      const updatedGoal = daemon.director.goals.getGoal(goal.id)!;
      assert.equal(updatedGoal.liveProgress?.verificationStatus, "passed");
      assert.equal(updatedGoal.liveProgress?.criteriaResults?.[0]?.passed, true);

      // Verify run_status Director tool resolves goal_id and emits native run_activity display card into history
      const statusRes = (await daemon.director.executeDirectorMcpTool(chat.session.id, "run_status", {
        goal_id: goal.id,
      })) as { activity?: { phase: string; counts: { verifyCompleted: number } }; rendered_in_ui?: string };
      assert.equal(statusRes.activity?.counts.verifyCompleted, 1);
      const turns = await client.request<Array<{ role: string; toolName?: string; display?: ToolDisplayPayload }>>("chat.history", {
        chatSessionId: chat.session.id,
      });
      const activityTurn = turns.find((t) => t.role === "tool_output" && t.toolName === "run_status");
      assert.equal(activityTurn?.display?.kind, "run_activity");
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("uses model-friendly sequential IDs, typed control-plane EventCards, and durable timer self-pacing primitives", async () => {
    const repoDir = initTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-ids-events-timers-"));
    const sockPath = join(stateDir, "d.sock");
    const cfg = loadConfig(repoDir);
    cfg.stateDir = stateDir;
    cfg.socketPath = sockPath;

    const wakePrompts: string[] = [];
    const receivedChatEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];

    const daemon = new HarnessDaemon(cfg, {
      dbPath: join(stateDir, "cp.sqlite"),
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) {
            wakePrompts.push(req.initialPrompt);
            return { text: "Resumed after timer fired.", stopReason: "completed" };
          }
          return { text: "ok", stopReason: "completed" };
        },
      }),
    });
    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();
    client.onEvent((ev) => {
      if (ev.type.startsWith("chat.")) {
        receivedChatEvents.push({ type: ev.type, payload: (ev.payload ?? {}) as Record<string, unknown> });
      }
    });

    try {
      // 1. Model-friendly sequential IDs (no random hex/UUIDs!) + tolerant lookup normalization
      const chat = await client.request<{ session: { id: string } }>("chat.create", {
        repoRoot: repoDir,
        title: "Friendly IDs Session",
      });
      assert.equal(chat.session.id, "chat-1");
      assert.equal(daemon.director.chats.getSession("CHAT_1")?.id, "chat-1");

      const goal = daemon.director.goals.createGoal({
        repoRoot: repoDir,
        chatSessionId: chat.session.id,
        title: "Paced migration",
        description: "Verify friendly IDs, typed events, and timers",
        criteria: [{ kind: "deterministic", description: "Pass", command: "true" }],
      });
      assert.equal(goal.id, "goal-1");
      assert.equal(goal.criteria[0]!.id, "c1");
      assert.equal(daemon.director.goals.getGoal("GOAL-1")?.id, "goal-1");
      assert.equal(daemon.director.goals.getGoal("#1")?.id, "goal-1");

      const run = daemon.db.createRun({ goal: goal.title, repoRoot: repoDir, baseBranch: "main", baseSha: "abc" });
      assert.equal(run.id, "run-1");
      assert.equal(daemon.db.getRun("run_1")?.id, "run-1");
      daemon.director.goals.linkRunAndStart(goal.id, run.id);

      const parent = daemon.db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orchestrator",
        objective: "Coordinate",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-astra",
      });
      assert.equal(parent.id, "t-1");
      assert.equal(daemon.db.getTask("T-1")?.id, "t-1");

      const child = daemon.db.createTask({
        runId: run.id,
        parentId: parent.id,
        tier: 2,
        kind: "worker",
        title: "Worker",
        objective: "Do work",
        profileId: "acp:codex",
        model: "openai/gpt-6.2-sol",
      });
      assert.equal(child.id, "t-2");

      const kb = daemon.db.kb.propose({
        repoScope: repoDir,
        kind: "decision",
        title: "Friendly IDs",
        summary: "Use sequential IDs",
        contextMd: "Sequential IDs prevent model hallucinations.",
        evidencePaths: ["README.md"],
      });
      assert.equal(kb.id, "kb-1");
      assert.equal(daemon.db.kb.getRaw("KB_1")?.id, "kb-1");

      // 2. Director durable timer: pause goal now, schedule timer-1 to auto-resume & wake Director with typed event
      await client.request("chat.open", { repoRoot: repoDir, chatSessionId: chat.session.id });
      const sched = (await daemon.director.executeDirectorMcpTool(chat.session.id, "schedule_timer", {
        delay_seconds: 0.08,
        reason: "Resume after quota reset window",
        goal_id: "GOAL-1",
        pause_goal: true,
        resume_goal: true,
      })) as { timer: { id: string; status: string }; pausedGoal: boolean };
      assert.equal(sched.timer.id, "timer-1");
      assert.equal(sched.pausedGoal, true);
      assert.equal(daemon.director.goals.getGoal("goal-1")?.status, "paused");

      // List timers returns timer-1
      const listed = (await daemon.director.executeDirectorMcpTool(chat.session.id, "list_timers", {
        status: "pending",
      })) as { timers: Array<{ id: string }> };
      assert.equal(listed.timers.some((t) => t.id === "timer-1"), true);

      // Wait for timer-1 to fire and wake Director with a typed `timer.fired` ChatControlEvent
      for (let i = 0; i < 60 && !wakePrompts.some((p) => p.includes("Control-plane event (timer.fired):")); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      const timerWakePrompt = wakePrompts.find((p) => p.includes("Control-plane event (timer.fired):"));
      assert.ok(timerWakePrompt, "Timer firing must wake Director automatically");
      assert.ok(timerWakePrompt.includes("timer-1"));
      const resumedGoal = daemon.director.goals.getGoal("goal-1");
      assert.ok(resumedGoal && resumedGoal.status !== "paused", "resume_goal must auto-resume paused goal");

      // Wire frame chat.turn.start carried typed `event` (NOT a raw `[Event]` string!)
      const startFrame = receivedChatEvents.find(
        (e) => e.type === "chat.turn.start" && (e.payload.event as { kind?: string } | undefined)?.kind === "timer.fired",
      );
      assert.ok(startFrame, "chat.turn.start must carry typed timer.fired event");

      // Persisted history turns carry typed `event` objects and render via EventCard (distinct from chat)
      const history = daemon.director.chats.getHistory(chat.session.id);
      const schedTurn = history.find((t) => t.event?.kind === "timer.scheduled");
      const firedTurn = history.find((t) => t.event?.kind === "timer.fired");
      assert.ok(schedTurn?.event, "timer.scheduled must be persisted as typed event");
      assert.ok(firedTurn?.event, "timer.fired must be persisted as typed event");

      const theme = createTheme();
      const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
      const comp = historyTurnComponent(firedTurn, theme, "model");
      assert.equal(comp instanceof EventCard, true, "Typed event turns must render as EventCard, not plain chat");
      for (const w of [50, 80, 120]) {
        const lines = comp.render(w);
        assert.ok(lines.length > 0);
        for (const l of lines) assert.ok(visibleWidth(l) <= w, `EventCard overflowed width ${w}`);
      }
      const rendered = comp.render(100).map(strip).join("\n");
      assert.ok(rendered.includes("EVENT · TIMER FIRED"));
      assert.ok(rendered.includes("timer-1"));
      assert.equal(rendered.includes("[Event]"), false, "EventCard must not render raw [Event] string prefixes");

      // 3. Subagent `wait_timer` sleeps cleanly with telemetry and wakes early on `child_settled`
      daemon.db.updateTask(parent.id, { status: "running" });
      daemon.db.updateTask(child.id, { status: "running" });
      const waitTimerPromise = daemon.orchestrator.toolExecutor.execute(run.id, parent.id, "wait_timer", {
        delay_seconds: 3600,
        reason: "Wait for quota reset or worker completion",
        wake_on_event: "child_settled",
      }) as Promise<{ timerId: string; wakeReason: string }>;

      await new Promise((r) => setTimeout(r, 25));
      const sleepTelemetry = buildRunActivitySummary(daemon.db, run.id);
      const parentSnap = sleepTelemetry.tasks.find((t) => t.id === parent.id);
      assert.ok(parentSnap?.currentAction?.includes("sleeping"), `Expected sleeping telemetry, got: ${parentSnap?.currentAction}`);

      // Completing child wakes parent's wait_timer immediately!
      const t0 = Date.now();
      daemon.db.updateTask(child.id, { status: "completed", summary: "Finished early" });
      const waitTimerRes = await waitTimerPromise;
      assert.equal(waitTimerRes.timerId, "timer-2");
      assert.equal(waitTimerRes.wakeReason, "child_settled:t-2");
      assert.ok(Date.now() - t0 < 1500, "wait_timer must wake immediately on subscribed child_settled event");

      // 4. cancel_timer cancels a pending future timer cleanly
      const future = (await daemon.director.executeDirectorMcpTool(chat.session.id, "schedule_timer", {
        wake_at: new Date(Date.now() + 86_400_000).toISOString(),
        reason: "Tomorrow quota reset",
      })) as { timer: { id: string } };
      assert.equal(future.timer.id, "timer-3");
      const cancelled = (await daemon.director.executeDirectorMcpTool(chat.session.id, "cancel_timer", {
        timer_id: "TIMER_3",
      })) as { timer: { id: string; status: string } };
      assert.equal(cancelled.timer.id, "timer-3");
      assert.equal(cancelled.timer.status, "cancelled");
    } finally {
      client.close();
      await daemon.stop();
      rmSync(repoDir, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
