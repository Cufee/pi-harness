import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { runCodeExec } from "../src/code-mode/runner.js";
import { sandboxAvailable } from "../src/code-mode/sandbox.js";
import { loadConfig, type AcpProfileConfig, type HarnessConfig } from "../src/config.js";
import { writeCodeOutput } from "../src/control-plane/dossiers.js";
import { SUMMARY_LIMIT } from "../src/control-plane/handoffs.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { createLegacyStoragePaths, resetStoragePathsForTest, storagePaths } from "../src/storage/paths.js";
import { runGit } from "../src/worktree/manager.js";

const tempDirs: string[] = [];
const ORIGINAL_LAYOUT = process.env.PI_HARNESS_STORAGE_LAYOUT;
const INHERITED_HARNESS_ENV_KEYS = [
  "HARNESS_GOAL_ID",
  "HARNESS_GOAL_EVIDENCE_DIR",
  "HARNESS_GOALS_DIR",
  "HARNESS_ARTIFACTS_DIR",
] as const;
const ORIGINAL_HARNESS_ENV = Object.fromEntries(
  INHERITED_HARNESS_ENV_KEYS.map((k) => [k, process.env[k]]),
) as Record<(typeof INHERITED_HARNESS_ENV_KEYS)[number], string | undefined>;

function clearInheritedHarnessEnv(): void {
  for (const key of INHERITED_HARNESS_ENV_KEYS) {
    delete process.env[key];
  }
}

function restoreInheritedHarnessEnv(): void {
  for (const key of INHERITED_HARNESS_ENV_KEYS) {
    const val = ORIGINAL_HARNESS_ENV[key];
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

function setLayoutEnv(layout: "legacy" | "data-dir" | undefined): void {
  if (layout === undefined) delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  else process.env.PI_HARNESS_STORAGE_LAYOUT = layout;
  resetStoragePathsForTest();
}

afterEach(() => {
  setLayoutEnv(ORIGINAL_LAYOUT as "legacy" | "data-dir" | undefined);
  restoreInheritedHarnessEnv();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

interface FakeAgentTrace {
  role: "orchestrator" | "worker" | "reviewer";
  taskId: string;
  runId: string;
  cwd: string;
  env: {
    HARNESS_GOAL_ID: string | null;
    HARNESS_GOAL_EVIDENCE_DIR: string | null;
    HARNESS_GOALS_DIR: string | null;
    HARNESS_ARTIFACTS_DIR: string | null;
  };
  artifactPath?: string;
  evidenceWritePath?: string;
  merged?: boolean;
}

function writeFakeAcpAgent(scriptPath: string): void {
  const source = `#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream } from "@agentclientprotocol/sdk/unstable";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const logPath = process.env.FAKE_TRACE_LOG!;
const summaryOverflowLen = ${SUMMARY_LIMIT + 300};

interface McpServerSpec {
  name?: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

let mcpClient: Client | null = null;
let ownTaskId = "unknown";
let ownRunId = "unknown";
let toolNames = new Set<string>();

async function connectHarnessMcp(server: McpServerSpec): Promise<void> {
  if (mcpClient || !server.command) return;
  const serverEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") serverEnv[k] = v;
  }
  for (const entry of server.env ?? []) {
    serverEnv[entry.name] = entry.value;
    if (entry.name === "PI_HARNESS_TASK_ID") ownTaskId = entry.value.split("@")[0] ?? entry.value;
    if (entry.name === "PI_HARNESS_RUN_ID") ownRunId = entry.value;
  }
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: serverEnv,
    stderr: "ignore",
  });
  mcpClient = new Client({ name: "c2-fake-acp", version: "1.0.0" }, { capabilities: {} });
  await mcpClient.connect(transport);
  const listed = await mcpClient.listTools();
  toolNames = new Set((listed.tools ?? []).map((t) => t.name));
}

async function callMcp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!mcpClient) throw new Error("MCP not connected");
  const res = await mcpClient.callTool({ name, arguments: args });
  const text = (Array.isArray(res.content) ? res.content : [])
    .map((c) => (c && typeof c === "object" && "text" in c && typeof c.text === "string" ? c.text : ""))
    .join("\\n")
    .trim();
  if (res.isError) throw new Error(\`MCP \${name} error: \${text}\`);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { text };
  }
}

function recordTrace(trace: Record<string, unknown>): void {
  appendFileSync(logPath, JSON.stringify(trace) + "\\n", "utf8");
}

const envSnapshot = () => ({
  HARNESS_GOAL_ID: process.env.HARNESS_GOAL_ID ?? null,
  HARNESS_GOAL_EVIDENCE_DIR: process.env.HARNESS_GOAL_EVIDENCE_DIR ?? null,
  HARNESS_GOALS_DIR: process.env.HARNESS_GOALS_DIR ?? null,
  HARNESS_ARTIFACTS_DIR: process.env.HARNESS_ARTIFACTS_DIR ?? null,
});

const app = agent()
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: {},
    agentInfo: { name: "c2-fake-acp", version: "1.0.0" },
  }))
  .onRequest("session/new", async ({ params }) => {
    const servers = (params as { mcpServers?: McpServerSpec[] }).mcpServers ?? [];
    const harness = servers.find((s) => s.name === "harness");
    if (harness) await connectHarnessMcp(harness);
    return {
      sessionId: \`c2-session-\${process.pid}\`,
      models: {
        currentModelId: "fake-model",
        availableModels: [{ modelId: "fake-model", name: "Fake Model" }],
      },
    };
  })
  .onRequest("session/prompt", async ({ client, params }) => {
    const sessionId = params.sessionId;
    try {
      if (toolNames.has("submit_review_verdict")) {
        recordTrace({
          role: "reviewer",
          taskId: ownTaskId,
          runId: ownRunId,
          cwd: process.cwd(),
          env: envSnapshot(),
        });
        await callMcp("submit_review_verdict", {
          verdict: "approved",
          criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Verified in data-dir scratch checkout" }],
          summary: "Approved c2 end-to-end review.",
        });
      } else if (toolNames.has("spawn_worker")) {
        recordTrace({
          role: "orchestrator",
          taskId: ownTaskId,
          runId: ownRunId,
          cwd: process.cwd(),
          env: envSnapshot(),
        });
        const wantMerge = Boolean(process.env.HARNESS_GOAL_ID);
        const fileName = wantMerge ? "worker-chat-output.txt" : "worker-legacy-output.txt";
        const spawned = await callMcp("spawn_worker", {
          title: wantMerge ? "Chat worker" : "Legacy unowned worker",
          objective: \`Create \${fileName} and write dossier\`,
          write_scopes: [fileName],
          model: "fake-model",
        });
        const childId = String(spawned.spawned ?? spawned.taskId ?? spawned.id ?? "");
        while (true) {
          const waited = await callMcp("wait_children", {
            ids: [childId],
            mode: "all",
            fallback_interval_s: 10,
          });
          const children = Array.isArray(waited.children)
            ? (waited.children as Array<{ status?: string }>)
            : [];
          if (children.length > 0 && children.every((c) => c.status === "completed" || c.status === "failed")) {
            break;
          }
        }
      } else if (toolNames.has("return_task")) {
        const wantMerge = Boolean(process.env.HARNESS_GOAL_ID);
        const fileName = wantMerge ? "worker-chat-output.txt" : "worker-legacy-output.txt";
        const dossier = await callMcp("artifact_write", {
          name: "worker-dossier.md",
          content: \`# Worker dossier for \${ownRunId}/\${ownTaskId}\\n\`,
          summary: "Worker c2 dossier",
        });
        const artifactPath = typeof dossier.path === "string" ? dossier.path : undefined;

        let evidenceWritePath: string | undefined;
        if (process.env.HARNESS_GOAL_EVIDENCE_DIR) {
          evidenceWritePath = join(process.env.HARNESS_GOAL_EVIDENCE_DIR, "worker-proof.txt");
          await client.request("fs/write_text_file", {
            sessionId,
            path: evidenceWritePath,
            content: "worker evidence proof\\n",
          });
        }

        let merged = false;
        if (wantMerge) {
          writeFileSync(join(process.cwd(), fileName), "committed by c2 worker\\n", "utf8");
          execFileSync("git", ["add", fileName], { cwd: process.cwd() });
          execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "c2 worker change"], {
            cwd: process.cwd(),
          });
          await callMcp("submit_for_merge", { summary: "Merge c2 worker change" });
          merged = true;
        }

        recordTrace({
          role: "worker",
          taskId: ownTaskId,
          runId: ownRunId,
          cwd: process.cwd(),
          env: envSnapshot(),
          artifactPath,
          evidenceWritePath,
          merged,
        });

        await callMcp("return_task", {
          status: "completed",
          summary: "Worker completed. " + "S".repeat(summaryOverflowLen),
          sources: [{ path: "README.md", note: "c2 test" }],
          ...(artifactPath ? { artifact_paths: [artifactPath] } : {}),
        });
      }

      await client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } },
      });
      return { stopReason: "end_turn" };
    } finally {
      await mcpClient?.close().catch(() => {});
      mcpClient = null;
    }
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
`;
  writeFileSync(scriptPath, source, "utf8");
}

async function initTempGitRepo(root: string): Promise<string> {
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# c2 repo\n", "utf8");
  mkdirSync(join(repoRoot, "src"), { recursive: true });
  writeFileSync(join(repoRoot, "src", "app.ts"), "export const ok = true;\n", "utf8");
  await runGit(repoRoot, ["add", "-A"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return repoRoot;
}

function makeFakeAcpConfig(repoRoot: string, stateDir: string, fakeScript: string, traceLog: string): HarnessConfig {
  const base = loadConfig(repoRoot);
  const profile: AcpProfileConfig = {
    id: "acp:fake",
    kind: "acp",
    adapter: "generic",
    command: process.execPath,
    args: [fakeScript],
    billing: "local",
    models: ["fake-model"],
    enabled: true,
    env: {
      FAKE_TRACE_LOG: traceLog,
    },
  };
  const config: HarnessConfig = {
    ...base,
    stateDir,
    socketPath: join(stateDir, "d.sock"),
    storage: { dataDir: join(stateDir, "data") },
    codeMode: "off",
    codeExec: { ...base.codeExec, maxOutputChars: 80 },
    profiles: [profile],
    defaultOrchestratorProfile: profile.id,
    defaultWorkerProfile: profile.id,
    defaultTaskProfile: profile.id,
    goals: {
      ...base.goals,
      autoVerifyOnSettle: false,
    },
    catalog: { ttlHours: 24 },
    quotaEndpoint: undefined,
  };
  const compiler = new ModelCatalogCompiler(config);
  const catalog = compiler.compileFromData({
    enabledProfiles: [profile],
    inventory: new Map([[profile.id, [{ wireModelId: "fake-model" }]]]),
    profileStatuses: [{ profileId: profile.id, status: "ok", modelCount: 1 }],
    modelsDev: [],
    openRouter: [],
    litellmDep: new Map(),
    benchmarks: [],
    sources: [],
  });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(compiler.cachePath, JSON.stringify(catalog), "utf8");
  return config;
}

async function waitUntil(pred: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(50);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

function assertUnder(actual: string, expectedDir: string, label: string): void {
  const prefix = expectedDir.endsWith(sep) ? expectedDir : expectedDir + sep;
  assert.ok(
    actual === expectedDir || actual.startsWith(prefix),
    `${label}: expected ${actual} to be under ${expectedDir}`,
  );
}

describe("goal criterion c2: data-dir layout keeps all harness data under stateDir/data and leaves repo clean", () => {
  it("routes chat-owned goals, dossiers, code_exec spills, notes, worktrees, and scratch checkouts to chat data-dir, and unowned runs to chats/legacy", async () => {
    clearInheritedHarnessEnv();
    setLayoutEnv("data-dir");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "c2-")));
    tempDirs.push(root);
    const repoRoot = await initTempGitRepo(root);
    const stateDir = join(root, "st");
    const fakeScript = join(root, "fake-acp.ts");
    const traceLog = join(root, "traces.jsonl");
    writeFakeAcpAgent(fakeScript);

    const config = makeFakeAcpConfig(repoRoot, stateDir, fakeScript, traceLog);
    const sp = storagePaths(config, { layout: "data-dir" });
    const legacySp = createLegacyStoragePaths(config);
    assert.equal(sp.layout, "data-dir");

    const expectedProjectDir = join(stateDir, "data", "projects", sp.projectKey(repoRoot));
    assert.equal(sp.projectDir(repoRoot), expectedProjectDir);

    const daemon = new HarnessDaemon(config, {
      dbPath: join(stateDir, "control-plane.sqlite"),
    });
    await daemon.start();

    try {
      // --- Part 1: Director chat-owned lifecycle ---
      const chat = await daemon.director.createChat({ repoRoot });
      const chatOwner = { repoRoot, chatSessionId: chat.id };
      const expectedChatDir = join(expectedProjectDir, "chats", chat.id);

      // Director write_note to chat notes and project notes
      const chatNotePath = join(sp.notesDir(chatOwner), "director-chat-note.md");
      const projNotePath = join(sp.projectNotesDir(repoRoot), "project-note.md");
      const chatNoteRes = (await daemon.director.executeDirectorMcpTool(chat.id, "write_note", {
        path: chatNotePath,
        content: "Director chat note in data-dir\n",
        reason: "Record c2 chat note",
      })) as { written: boolean; path: string };
      assert.equal(chatNoteRes.written, true);
      assertUnder(chatNoteRes.path, join(expectedChatDir, "notes"), "chat write_note path");
      assert.equal(existsSync(chatNoteRes.path), true);

      const projNoteRes = (await daemon.director.executeDirectorMcpTool(chat.id, "write_note", {
        path: projNotePath,
        content: "Director project note in data-dir\n",
        reason: "Record c2 project note",
      })) as { written: boolean; path: string };
      assert.equal(projNoteRes.written, true);
      assertUnder(projNoteRes.path, join(expectedProjectDir, "notes"), "project write_note path");
      assert.equal(existsSync(projNoteRes.path), true);

      // Create and launch goal (long description triggers goal-description-v1.md in evidenceDir on goal_get)
      const longDesc = "End-to-end c2 data-dir storage verification goal. ".repeat(60).trim();
      const goal = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "C2 data-dir end-to-end goal",
        description: longDesc,
        criteria: [{ id: "c1", kind: "behavioral", description: "Everything lands in data-dir", required: true }],
      });

      const commitRes = await daemon.director.commitGoalDetailed(goal.id, {});
      const chatRunId = commitRes.goal.linkedRunId!;
      assert.ok(chatRunId, "commitGoalDetailed must create and link a run");

      await waitUntil(
        () => {
          const r = daemon.db.getRun(chatRunId);
          return r?.status === "completed" || r?.status === "failed";
        },
        30_000,
        "chat-owned goal run to settle",
      );
      assert.equal(daemon.db.getRun(chatRunId)?.status, "completed");

      // Wait for merge queue to drain the worker's submit_for_merge (exercises real _integration scratch checkout)
      const chatWorker = daemon.db.listTasks(chatRunId).find((t) => t.tier === 2 && t.kind === "worker")!;
      assert.ok(chatWorker, "expected Tier 2 worker in chat run");
      const chatRun = daemon.db.getRun(chatRunId)!;
      const chatRunRef = { ...chatRun, chatSessionId: chat.id };

      // Produce a code_exec output spill indexed into artifacts for this run
      const spillRes = await runCodeExec({
        code: 'output({ payload: "X".repeat(300) });',
        tools: [],
        callTool: async () => ({}),
        artifactsDir: sp.artifactsDir(chatRunRef),
        maxOutputChars: 80,
        saveOutput: (outName, json) => writeCodeOutput(daemon.db, chatRunRef, chatWorker.id, outName, json, sp),
        ...(!sandboxAvailable()
          ? { launch: () => [process.execPath, "--preload", "./guard.mjs", "./script.ts"] }
          : {}),
      });
      assert.equal(spillRes.ok, true, `code_exec spill failed: ${spillRes.error ?? ""}`);
      assert.ok(spillRes.artifactPath, "expected code_exec to spill output over maxOutputChars");
      assertUnder(spillRes.artifactPath!, join(expectedChatDir, "artifacts"), "chat code_exec spill path");
      assert.equal(existsSync(spillRes.artifactPath!), true);

      // Run Done-Reviewer (exercises real _verify scratch checkout under <projectDir>/scratch/_verify/)
      const reviewOutcome = await daemon.director.verifyAndReviewGoal(goal.id);
      assert.equal(reviewOutcome.goal.status, "achieved");

      // Also directly verify an _integration scratch checkout path through the real WorktreeManager
      const headSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
      const wtMgr = daemon.orchestrator.getWorktreeManager(repoRoot);
      const integrationScratch = await wtMgr.addScratchWorktree("_integration", `c2-${chatRunId}`, headSha);
      try {
        assertUnder(
          integrationScratch.path,
          join(expectedProjectDir, "scratch", "_integration"),
          "integration scratch checkout path",
        );
        assert.equal(existsSync(integrationScratch.path), true);
      } finally {
        await integrationScratch.remove();
      }

      // Inspect goal_get paths
      const goalGet = (await daemon.director.executeDirectorMcpTool(chat.id, "goal_get", {
        goal_id: goal.id,
      })) as {
        evidenceDir: string;
        goal: { description: { path: string | null } };
      };
      const expectedGoalEvDir = join(expectedChatDir, "goals", goal.id);
      assert.equal(goalGet.evidenceDir, expectedGoalEvDir);
      assert.ok(goalGet.goal.description.path);
      assertUnder(goalGet.goal.description.path!, expectedGoalEvDir, "goal_get description.path");

      // Inspect DB artifacts rows for chatRunId
      const chatArtifacts = daemon.db.listArtifacts(chatRunId);
      assert.ok(chatArtifacts.some((a) => a.path === spillRes.artifactPath), "code_exec spill must be indexed in artifacts");
      assert.ok(chatArtifacts.some((a) => a.path.endsWith("worker-dossier.md")), "worker dossier must be indexed in artifacts");
      for (const art of chatArtifacts) {
        if (art.kind === "write") {
          assertUnder(art.path, expectedGoalEvDir, `chat write artifact ${art.id}`);
        } else {
          assertUnder(art.path, join(expectedChatDir, "artifacts"), `chat artifact ${art.id} (${art.kind})`);
        }
      }
      const chatWorkerResult = JSON.parse(daemon.db.getTask(chatWorker.id)?.resultJson ?? "{}") as {
        summary_overflow?: { path?: string };
      };
      assert.ok(chatWorkerResult.summary_overflow?.path, "expected chat worker summary overflow spill");
      assertUnder(chatWorkerResult.summary_overflow!.path!, join(expectedChatDir, "artifacts"), "chat summary overflow path");
      assert.equal(existsSync(chatWorkerResult.summary_overflow!.path!), true);

      // Inspect DB worktrees rows for chatRunId
      const chatWorktrees = daemon.db.listWorktrees(chatRunId);
      assert.ok(chatWorktrees.length >= 1, "expected at least one worktree row for chat run");
      for (const wt of chatWorktrees) {
        assertUnder(wt.path, join(expectedChatDir, "worktrees"), `chat worktree ${wt.id}`);
      }

      // Inspect traces recorded by the real fake ACP subprocesses for chatRunId
      const traces = readFileSync(traceLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeAgentTrace);
      const chatTraces = traces.filter((t) => t.runId === chatRunId);
      const orchTrace = chatTraces.find((t) => t.role === "orchestrator");
      const workerTrace = chatTraces.find((t) => t.role === "worker");
      const reviewerTrace = chatTraces.find((t) => t.role === "reviewer");
      assert.ok(orchTrace, "expected orchestrator trace");
      assert.ok(workerTrace, "expected worker trace");
      assert.ok(reviewerTrace, "expected reviewer trace");

      for (const tr of [orchTrace, workerTrace, reviewerTrace]) {
        assert.equal(tr.env.HARNESS_GOAL_ID, goal.id);
        assert.equal(tr.env.HARNESS_GOAL_EVIDENCE_DIR, expectedGoalEvDir);
        assert.equal(tr.env.HARNESS_GOALS_DIR, join(expectedChatDir, "goals"));
        assert.equal(tr.env.HARNESS_ARTIFACTS_DIR, join(expectedChatDir, "artifacts"));
      }
      assertUnder(workerTrace.cwd, join(expectedChatDir, "worktrees"), "worker worktree cwd");
      assertUnder(workerTrace.artifactPath!, join(expectedChatDir, "artifacts", chatRunId), "worker artifact_write path");
      assertUnder(workerTrace.evidenceWritePath!, expectedGoalEvDir, "worker native evidence write");
      assert.equal(existsSync(workerTrace.evidenceWritePath!), true);
      assertUnder(reviewerTrace.cwd, join(expectedProjectDir, "scratch", "_verify"), "reviewer verify scratch cwd");

      // --- Part 2: Run without a Director chat lands under chats/legacy ---
      const expectedLegacyChatDir = join(expectedProjectDir, "chats", "legacy");
      const { run: unownedRun } = await daemon.orchestrator.startRun({
        goal: "Unowned c2 run without Director chat",
        repoRoot,
      });
      assert.equal(unownedRun.chatSessionId ?? null, null);

      await waitUntil(
        () => {
          const r = daemon.db.getRun(unownedRun.id);
          return r?.status === "completed" || r?.status === "failed";
        },
        30_000,
        "unowned run to settle",
      );
      assert.equal(daemon.db.getRun(unownedRun.id)?.status, "completed");

      const legacyWorker = daemon.db.listTasks(unownedRun.id).find((t) => t.tier === 2 && t.kind === "worker")!;
      assert.ok(legacyWorker, "expected Tier 2 worker in unowned run");
      assert.equal(legacyWorker.status, "completed", `legacyWorker status=${legacyWorker.status} result=${legacyWorker.resultJson} summary=${legacyWorker.summary}`);

      const legacySpillRes = await runCodeExec({
        code: 'output({ payload: "L".repeat(300) });',
        tools: [],
        callTool: async () => ({}),
        artifactsDir: sp.artifactsDir(unownedRun),
        maxOutputChars: 80,
        saveOutput: (outName, json) => writeCodeOutput(daemon.db, unownedRun, legacyWorker.id, outName, json, sp),
        ...(!sandboxAvailable()
          ? { launch: () => [process.execPath, "--preload", "./guard.mjs", "./script.ts"] }
          : {}),
      });
      assert.equal(legacySpillRes.ok, true);
      assert.ok(legacySpillRes.artifactPath);
      assertUnder(legacySpillRes.artifactPath!, join(expectedLegacyChatDir, "artifacts"), "unowned code_exec spill");

      const legacyArtifacts = daemon.db.listArtifacts(unownedRun.id);
      assert.ok(legacyArtifacts.some((a) => a.path === legacySpillRes.artifactPath), "unowned code_exec spill must be indexed");
      assert.ok(legacyArtifacts.some((a) => a.path.endsWith("worker-dossier.md")), "unowned worker dossier must be indexed");
      for (const art of legacyArtifacts) {
        assertUnder(art.path, join(expectedLegacyChatDir, "artifacts"), `unowned artifact ${art.id}`);
      }
      const legacyWorkerResult = JSON.parse(daemon.db.getTask(legacyWorker.id)?.resultJson ?? "{}") as {
        summary_overflow?: { path?: string };
      };
      assert.ok(legacyWorkerResult.summary_overflow?.path, "expected unowned worker summary overflow spill");
      assertUnder(legacyWorkerResult.summary_overflow!.path!, join(expectedLegacyChatDir, "artifacts"), "unowned summary overflow path");
      assert.equal(existsSync(legacyWorkerResult.summary_overflow!.path!), true);
      const legacyWorktrees = daemon.db.listWorktrees(unownedRun.id);
      assert.ok(legacyWorktrees.length >= 1, "expected worktree row for unowned run");
      for (const wt of legacyWorktrees) {
        assertUnder(wt.path, join(expectedLegacyChatDir, "worktrees"), `unowned worktree ${wt.id}`);
      }

      const allTraces = readFileSync(traceLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeAgentTrace);
      const legacyWorkerTrace = allTraces.find((t) => t.runId === unownedRun.id && t.role === "worker");
      assert.ok(legacyWorkerTrace, "expected trace for unowned worker");
      assert.equal(legacyWorkerTrace.env.HARNESS_GOAL_EVIDENCE_DIR, null);
      assert.equal(legacyWorkerTrace.env.HARNESS_GOAL_ID, null);
      assertUnder(legacyWorkerTrace.cwd, join(expectedLegacyChatDir, "worktrees"), "unowned worker cwd");
      assertUnder(
        legacyWorkerTrace.artifactPath!,
        join(expectedLegacyChatDir, "artifacts", unownedRun.id),
        "unowned worker artifact_write path",
      );

      // --- Part 3: Repo itself has NO legacy harness dir and clean git status --porcelain --ignored ---
      const legacyHarnessDir = legacySp.projectDir(repoRoot);
      assert.throws(
        () => lstatSync(legacyHarnessDir),
        (err: NodeJS.ErrnoException) => err.code === "ENOENT",
        `expected no legacy harness dir at ${legacyHarnessDir}`,
      );
      const gitStatus = await runGit(repoRoot, ["status", "--porcelain", "--ignored"]);
      assert.equal(gitStatus.stdout.trim(), "", `expected clean git status --porcelain --ignored, got:\n${gitStatus.stdout}`);
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
