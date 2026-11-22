import { withFixtureCatalog } from "./fixtures/launch-config.js";
import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { buildDirectorSystemPrompt, DirectorSessionStore, type ChatTurnRecord } from "../src/director/session.js";
import type { CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import type { GoalDetailData, GoalsTableData, ToolDisplayPayload } from "../src/protocol/tool-display.js";
import type { RunAgentRequest, ToolDefinition } from "../src/runners/types.js";
import { runGit } from "../src/worktree/manager.js";

type ToolEv = { id?: string; name: string; status: string; display?: ToolDisplayPayload };

async function withDaemon(
  script: (req: RunAgentRequest) => Promise<string>,
  body: (ctx: { daemon: HarnessDaemon; client: DaemonClient; repoRoot: string; sockPath: string; chatId: string; toolEvents: ToolEv[] }) => Promise<void>,
): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-display-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-dstate-"));
  const sockPath = join(stateDir, "d.sock");
  await runGit(repoRoot, ["init", "-b", "main"]);
  writeFileSync(join(repoRoot, "a.txt"), "hello\n", "utf8");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);

  const factory: CustomRunnerFactory = () => ({
    run: async (req) => ({ text: await script(req), stopReason: "completed" }),
  });
  const daemon = new HarnessDaemon(withFixtureCatalog({ ...loadConfig(repoRoot), codeMode: "off", stateDir, socketPath: sockPath }), { dbPath: ":memory:", customRunnerFactory: factory });
  await daemon.start();
  const client = new DaemonClient(sockPath);
  await client.connect();
  const toolEvents: ToolEv[] = [];
  client.onEvent((ev: DaemonEventFrame) => {
    if (ev.type === "chat.tool") toolEvents.push(ev.payload as ToolEv);
  });
  try {
    const opened = (await client.request("chat.open", { repoRoot })) as { session: { id: string } };
    await body({ daemon, client, repoRoot, sockPath, chatId: opened.session.id, toolEvents });
  } finally {
    client.close();
    await daemon.stop();
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
}

/** Seeds one reviewed goal with a linked run, a tier-1 task and an open escalation, plus one never-reviewed draft. */
function seedGoals(daemon: HarnessDaemon, repoRoot: string, chatId: string) {
  const goals = daemon.director.goals;
  const reviewed = goals.createGoal({
    repoRoot,
    chatSessionId: chatId,
    title: "Ship greeting",
    description: "Write greet.txt",
    criteria: [
      { id: "c1", description: "greet.txt exists", kind: "deterministic", command: "test -f greet.txt" },
      { id: "c2", description: "Says world", kind: "behavioral" },
      { id: "c3", description: "Uppercase", kind: "behavioral", required: false },
    ],
    nonGoals: ["No i18n"],
  });
  const run = daemon.db.createRun({ goal: "g", repoRoot, baseBranch: "main", baseSha: "HEAD" });
  goals.linkRunAndStart(reviewed.id, run.id);
  const orch = daemon.db.createTask({ runId: run.id, tier: 1, kind: "orchestrator", title: "Orchestrate", objective: "o", profileId: "p" });
  const esc = daemon.db.createEscalation({
    runId: run.id,
    fromTaskId: orch.id,
    toTaskId: null,
    severity: "P1",
    category: "code_defect",
    title: "Broken build",
    evidencePaths: ["a.txt"],
  });
  // Older review passes everything; latest review must win (c1 pass, c2 fail, c3 unreviewed).
  goals.recordReviewVerdict(reviewed.id, {
    verdict: "changes_requested",
    criteriaResults: [
      { criterionId: "c1", passed: true, evidence: "ok" },
      { criterionId: "c2", passed: true, evidence: "ok" },
      { criterionId: "c3", passed: true, evidence: "ok" },
    ],
    summary: "first",
    diffHash: "a",
  });
  goals.recordReviewVerdict(reviewed.id, {
    verdict: "changes_requested",
    criteriaResults: [
      { criterionId: "c1", passed: true, evidence: "ok" },
      { criterionId: "c2", passed: false, evidence: "no world" },
    ],
    summary: "Missing world",
    diffHash: "b",
  });
  const draft = goals.createGoal({ repoRoot, chatSessionId: chatId, title: "Draft", description: "d", criteria: [{ id: "x", description: "x", kind: "behavioral" }] });
  return { reviewed: goals.getGoal(reviewed.id)!, draft, run, orch, esc };
}

function goalsTable(ev: ToolEv | undefined): GoalsTableData {
  assert.ok(ev?.display, "expected a display event");
  assert.equal(ev.display.kind, "goals_table");
  assert.equal(ev.display.title, "Goals");
  return ev.display.data as GoalsTableData;
}

describe("Director structured tool display", () => {
  it("goal_list via in-process executeTool emits goals_table (empty and populated), persisted as tool_output turns", async () => {
    let phase = 0;
    await withDaemon(
      async (req) => {
        phase++;
        const res = (await req.executeTool("goal_list", {})) as { goals: unknown[] };
        return `listed ${res.goals.length}`;
      },
      async ({ daemon, client, repoRoot, chatId, toolEvents }) => {
        await client.request("chat.send", { chatSessionId: chatId, text: "goals?" });
        assert.equal(toolEvents.length, 1);
        const empty = toolEvents[0]!;
        assert.equal(empty.name, "goal_list");
        assert.equal(empty.status, "completed");
        assert.match(empty.id ?? "", /^display-/);
        assert.deepEqual(goalsTable(empty), { goals: [] });

        const { reviewed, draft, run } = seedGoals(daemon, repoRoot, chatId);
        await client.request("chat.send", { chatSessionId: chatId, text: "goals now?" });
        assert.equal(toolEvents.length, 2);
        assert.notEqual(toolEvents[1]!.id, empty.id);
        const rows = goalsTable(toolEvents[1]).goals;
        const byId = new Map(rows.map((r) => [r.id, r]));
        assert.deepEqual(byId.get(reviewed.id), {
          id: reviewed.id,
          version: 1,
          status: reviewed.status,
          title: "Ship greeting",
          linkedRunId: run.id,
          reviewCycle: reviewed.reviewCycle,
          maxReviewCycles: null,
          verificationLabel: `${reviewed.reviewCycle} rev`,
          criteriaTotal: 3,
          criteriaPassed: 1,
          openEscalations: 1,
        });
        assert.equal(byId.get(draft.id)?.criteriaPassed, null);
        assert.equal(byId.get(draft.id)?.openEscalations, 0);
        assert.equal(byId.get(draft.id)?.linkedRunId, null);

        // History: user, tool_output, assistant per turn, in seq order, with parsed display.
        const history = (await client.request("chat.history", { chatSessionId: chatId })) as ChatTurnRecord[];
        const roles = history.filter((t) => t.role !== "system_notice").map((t) => t.role);
        assert.deepEqual(roles, ["user", "tool_output", "assistant", "user", "tool_output", "assistant"]);
        const toolTurns = history.filter((t) => t.role === "tool_output");
        assert.equal(toolTurns[0]!.content, "goal_list → Goals table (0 goals)");
        assert.equal(toolTurns[1]!.content, "goal_list → Goals table (2 goals)");
        assert.equal(toolTurns[1]!.toolName, "goal_list");
        assert.deepEqual(toolTurns[1]!.display, toolEvents[1]!.display);
        assert.equal(history.find((t) => t.role === "user")!.display, undefined);
        assert.equal(phase, 2);
      },
    );
  });

  it("model context gets the tool_output summary, never the display JSON", async () => {
    const prompts: string[] = [];
    await withDaemon(
      async (req) => {
        prompts.push(req.initialPrompt);
        await req.executeTool("goal_list", {});
        return "ok";
      },
      async ({ daemon, client, repoRoot, chatId }) => {
        seedGoals(daemon, repoRoot, chatId);
        await client.request("chat.send", { chatSessionId: chatId, text: "one" });
        await client.request("chat.send", { chatSessionId: chatId, text: "two" });
        assert.match(prompts[1]!, /Tool output: goal_list → Goals table \(2 goals\)/);
        assert.doesNotMatch(prompts[1]!, /goals_table|criteriaPassed/);
      },
    );
  });

  it("goal_list / goal_get through the ACP MCP bridge path (tool.call) reach the active chat sink; other tools emit no display", async () => {
    let seeded: ReturnType<typeof seedGoals> | undefined;
    let sockPathRef = "";
    let bridgeResults: Record<string, unknown> = {};
    await withDaemon(
      async (req) => {
        // Mimic src/runners/mcp-bridge.ts: a separate socket connection issuing tool.call with the chat session as taskId.
        const bridge = new DaemonClient(sockPathRef);
        await bridge.connect();
        try {
          const call = (name: string, args: Record<string, unknown>) =>
            bridge.request("tool.call", { runId: req.runId, taskId: req.taskId, name, args });
          const tools = (await call("__list_tools", {})) as ToolDefinition[];
          assert.ok(tools.some((t) => t.name === "goal_list"));
          bridgeResults = {
            list: await call("goal_list", {}),
            get: await call("goal_get", { goal_id: seeded!.reviewed.id }),
            read: await call("read_file", { path: "a.txt", exception_reason: "Check fixture bytes" }),
            kb: await call("kb_search", { query: "x" }),
          };
        } finally {
          bridge.close();
        }
        return "done";
      },
      async ({ daemon, client, repoRoot, sockPath, chatId, toolEvents }) => {
        sockPathRef = sockPath;
        seeded = seedGoals(daemon, repoRoot, chatId);
        await client.request("chat.send", { chatSessionId: chatId, text: "status" });

        assert.deepEqual(
          toolEvents.map((e) => e.name),
          ["goal_list", "goal_get"],
          "read_file / kb_search must not emit display events",
        );
        assert.equal(goalsTable(toolEvents[0]).goals.length, 2);

        const detail = toolEvents[1]!.display!;
        assert.equal(detail.kind, "goal_detail");
        const { reviewed, run, orch, esc } = seeded;
        assert.equal(detail.title, `Goal ${reviewed.id} v1`);
        const data = detail.data as GoalDetailData;
        assert.deepEqual(data.goal, {
          id: reviewed.id,
          version: 1,
          status: reviewed.status,
          title: "Ship greeting",
          description: "Write greet.txt",
          linkedRunId: run.id,
          reviewCycle: reviewed.reviewCycle,
          maxReviewCycles: null,
          verificationLabel: `${reviewed.reviewCycle} rev`,
          liveSummary: null,
          nonGoals: ["No i18n"],
        });
        assert.deepEqual(
          data.criteria.map((c) => [c.id, c.kind, c.required, c.lastResult]),
          [
            ["c1", "deterministic", true, "pass"],
            ["c2", "behavioral", true, "fail"],
            ["c3", "behavioral", false, null],
          ],
        );
        assert.deepEqual(
          data.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, tier: t.tier })),
          [{ id: orch.id, title: "Orchestrate", status: orch.status, tier: 1 }],
        );
        assert.deepEqual(data.openEscalations, [{ id: esc.id, taskId: orch.id, summary: "Broken build" }]);
        assert.equal(data.lastReview?.summary, "Missing world");
        assert.equal(data.lastReview?.verdict, "changes_requested");
        assert.equal(data.lastReview?.cycle, reviewed.reviewCycle);

        // Model-facing return values are unchanged apart from the rendered_in_ui note.
        const list = bridgeResults.list as { goals: Array<{ id: string }>; rendered_in_ui: string };
        assert.equal(list.goals.length, 2);
        assert.equal(typeof list.rendered_in_ui, "string");
        assert.ok("reviews" in (bridgeResults.get as object));
        assert.ok(!("display" in (bridgeResults.read as object)));

        const toolTurns = daemon.director.chats.getHistory(chatId).filter((t) => t.role === "tool_output");
        assert.deepEqual(toolTurns.map((t) => t.toolName), ["goal_list", "goal_get"]);
        assert.match(toolTurns[1]!.content, /^goal_get → Goal goal-/);
      },
    );
  });

  it("goal_list outside an active chat turn persists the turn without a sink", async () => {
    await withDaemon(
      async () => "unused",
      async ({ daemon, chatId, toolEvents }) => {
        await daemon.director.executeDirectorMcpTool(chatId, "goal_list", {});
        assert.equal(toolEvents.length, 0);
        const turns = daemon.director.chats.getHistory(chatId);
        assert.equal(turns.at(-1)?.role, "tool_output");
        assert.deepEqual(turns.at(-1)?.display, { kind: "goals_table", title: "Goals", data: { goals: [] } });
      },
    );
  });

  it("migrates a legacy chat_turns table, preserving rows and seq", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, title TEXT NOT NULL, profile_id TEXT NOT NULL,
        model TEXT, effort TEXT, acp_session_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE chat_turns (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_session_id TEXT NOT NULL REFERENCES chat_sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system_notice')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO chat_sessions VALUES ('chat-1', '/r', 'T', 'p', NULL, NULL, NULL, 1, 1);
      INSERT INTO chat_turns(seq, chat_session_id, role, content, created_at) VALUES (5, 'chat-1', 'user', 'hi', 1), (9, 'chat-1', 'assistant', 'yo', 2), (12, 'chat-1', 'user', 'gone', 3);
      DELETE FROM chat_turns WHERE seq = 12;
    `);
    const store = new DirectorSessionStore(db);
    const display: ToolDisplayPayload = { kind: "goals_table", title: "Goals", data: { goals: [] } };
    const added = store.appendTurn("chat-1", "tool_output", "goal_list → Goals table (0 goals)", { toolName: "goal_list", display });
    assert.ok(added.seq > 12, "AUTOINCREMENT high-water mark must survive the rebuild (seq 12 was deleted, not reusable)");
    store.appendTurn("chat-1", "assistant", "after");

    const history = store.getHistory("chat-1");
    assert.deepEqual(
      history.map((t) => [t.seq, t.role, t.content]),
      [
        [5, "user", "hi"],
        [9, "assistant", "yo"],
        [added.seq, "tool_output", "goal_list → Goals table (0 goals)"],
        [added.seq + 1, "assistant", "after"],
      ],
    );
    assert.equal(history[2]!.toolName, "goal_list");
    assert.deepEqual(history[2]!.display, display);

    // Re-opening an already-migrated DB is a no-op.
    new DirectorSessionStore(db);
    assert.equal(new DirectorSessionStore(db).getHistory("chat-1").length, 4);
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'chat_turns'").get() as { sql: string }).sql;
    assert.match(sql, /'tool_output'/);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_chat_turns_session'").get());
  });

  it("Director prompt and goal_list description carry the no-duplicate-table guidance", async () => {
    const prompt = buildDirectorSystemPrompt();
    assert.match(prompt, /goal_list` renders the live Goals table directly in the user's UI/);
    assert.match(prompt, /Never duplicate a rendered table/);
    await withDaemon(
      async () => "unused",
      async ({ daemon, chatId }) => {
        const tools = (await daemon.director.executeDirectorMcpTool(chatId, "__list_tools", {})) as ToolDefinition[];
        const desc = tools.find((t) => t.name === "goal_list")!.description;
        assert.match(desc, /rendered as a live Goals table directly in the user's UI/);
        assert.match(desc, /instead of printing or duplicating a Goals table/);
        assert.match(tools.find((t) => t.name === "goal_get")!.description, /do not re-print it/);
      },
    );
  });
});
