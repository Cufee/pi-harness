import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  ALL_RULES,
  AdvisoryEngine,
  AdvisedToolExecutor,
  WORD_BUDGET,
  buildDirectorSubject,
  buildSubject,
  countWords,
  formatNotice,
  type AdvisoryRecord,
  type Notice,
} from "../src/advisories/index.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb, type TaskRecord } from "../src/control-plane/db.js";
import type { ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { QuotaClient } from "../src/quota/client.js";
import { describeTool, toolFact, toolsForRole } from "../src/tool-descriptions/index.js";
import { filesOutsideWriteScopes } from "../src/worktree/merge-queue.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const WORKSPACE = "/tmp/pi-harness-fx-spawn-ws";
const ADVISORY_FORMAT = /^\[harness advisory: read-only-brief-needs-shell\] .+ Why: .+ Instead: .+$/;

const HARNESS_TOOLS = new Set([
  "spawn_task",
  "spawn_worker",
  "wait_children",
  "wait_tasks",
  "steer_child",
  "steer_task",
  "return_task",
  "inspect_command",
  "task_get",
  "tree_view",
]);

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    id: "t-1",
    runId: "run-1",
    parentId: null,
    tier: 1,
    kind: "orchestrator",
    title: "Parent task",
    objective: "Coordinate",
    criteria: "",
    readOnly: true,
    profileId: "pi-default",
    model: "fixture/fixture",
    effort: null,
    status: "running",
    generation: 1,
    maxTurns: 25,
    turnsUsed: 0,
    contextUsed: 0,
    contextSize: 200_000,
    worktreeId: null,
    sessionId: null,
    summary: null,
    handoffJson: null,
    resultJson: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeEngine() {
  const records: AdvisoryRecord[] = [];
  const engine = new AdvisoryEngine({
    rules: ALL_RULES,
    createScopeSource: () => null,
    filesOutsideWriteScopes,
    harnessToolNames: HARNESS_TOOLS,
    record: (entry) => records.push(entry),
  });
  return { engine, records };
}

function makeExecutorFixture() {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-harness-fx-spawn-"));
  const db = new ControlPlaneDb(join(tmpDir, "harness.sqlite"));
  const run = db.createRun({
    goal: "FX-SPAWN executor fixture",
    repoRoot: tmpDir,
    baseBranch: "main",
    baseSha: "0000000000000000000000000000000000000000",
  });
  const orchTask = db.createTask({
    runId: run.id,
    tier: 1,
    kind: "orchestrator",
    title: "Orchestrator",
    objective: "Coordinate",
    readOnly: true,
    profileId: "pi:local",
  });
  db.updateTask(orchTask.id, { status: "running" });

  const workerTask = db.createTask({
    runId: run.id,
    parentId: orchTask.id,
    tier: 2,
    kind: "worker",
    title: "Worker",
    objective: "Implement feature",
    readOnly: false,
    profileId: "pi:local",
  });
  db.updateTask(workerTask.id, { status: "running" });

  const { engine, records } = makeEngine();
  const startedIds: string[] = [];
  const abort = new AbortController();

  const hooks: ToolRuntimeHooks = {
    spawnAndStartTask: async (input) => {
      const created = db.createTask({
        runId: input.runId,
        parentId: input.parentId,
        tier: input.tier,
        kind: input.kind,
        title: input.title,
        objective: input.objective,
        criteria: input.criteria ?? "",
        readOnly: input.readOnly,
        profileId: input.profileId ?? "pi:local",
        model: input.model,
        effort: input.effort,
      });
      db.updateTask(created.id, { status: "running" });
      startedIds.push(created.id);
      return db.getTask(created.id)!;
    },
    waitForChildren: async () => ({ children: [], wakeReason: "already_settled", inactiveTaskIds: [] }),
    steerTask: async () => true,
    cancelTask: async () => {},
    scheduleRollover: async () => {},
    getWorktreeManager: () => {
      throw new Error("unused");
    },
    getMergeQueue: () => {
      throw new Error("unused");
    },
    forceStartWorker: async () => [],
    getTaskSignal: () => abort.signal,
  };

  const baseConfig = loadConfig(tmpDir);
  const config = withFixtureCatalog({
    ...baseConfig,
    stateDir: join(tmpDir, "state"),
    codeMode: "off",
  });
  const catalog = new ModelCatalogCompiler(config, new QuotaClient());

  const executor = new AdvisedToolExecutor(db, () => catalog, hooks, config, {
    engine,
    subjectFor: (task) =>
      buildSubject({
        task,
        workspaceRoot: tmpDir,
        writeScopes: [],
        writableExtraRoots: [],
      }),
  });

  return {
    tmpDir,
    db,
    run,
    orchTask,
    workerTask,
    engine,
    records,
    startedIds,
    executor,
    cleanup() {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function checkNoticeShape(notice: Notice, label: string): string {
  const words = countWords(notice);
  const formatted = formatNotice(notice);
  assert.ok(words <= WORD_BUDGET, `${label} exceeded ${WORD_BUDGET} words (${words}): ${formatted}`);
  assert.match(formatted, ADVISORY_FORMAT, `${label} failed format: ${formatted}`);
  return formatted;
}

describe("goal-14 fix FX-SPAWN", () => {
  it("FXS-1: spawn_task contains the no-shell fact verbatim for director, orchestrator, and worker, defined once in registry.ts", () => {
    const roles = ["director", "orchestrator", "worker"] as const;
    for (const role of roles) {
      const fact = toolFact(role, "spawn_task", "readOnlyNoShell");
      const described = describeTool("spawn_task", role);
      const listed = toolsForRole(role).find((t) => t.name === "spawn_task");
      assert.ok(listed, `spawn_task missing from toolsForRole("${role}")`);
      assert.ok(described.includes(fact), `describeTool("spawn_task", "${role}") missing verbatim fact`);
      assert.ok(listed.description.includes(fact), `toolsForRole("${role}") spawn_task missing verbatim fact`);
      assert.ok(fact.includes("Research, plan, and verify tasks have no shell."));
      assert.ok(fact.includes("inspect_command"));
    }

    // Role-specific writable options. The lead thread may hand the work to an execute subagent or a Worker, or run it itself.
    assert.ok(
      describeTool("spawn_task", "orchestrator").includes("Give that work to a kind execute task or a Worker, or run it yourself when you have a shell."),
    );
    assert.ok(describeTool("spawn_task", "worker").includes("kind execute task"));
    // A Worker cannot start Workers: its fact must not offer one (the lead's does, so spawn_worker alone no longer tells them apart).
    assert.ok(!toolFact("worker", "spawn_task", "readOnlyNoShell").includes("a Worker"));
    assert.ok(!describeTool("spawn_task", "worker").includes("spawn_worker"));
    assert.ok(describeTool("spawn_task", "director").includes("goal"));
    assert.ok(!describeTool("spawn_task", "director").includes("spawn_worker"));

    // Fact sentence defined once in registry source
    const registrySrc = readFileSync(join(import.meta.dir, "../src/tool-descriptions/registry.ts"), "utf8");
    const occurrences = registrySrc.split("Research, plan, and verify tasks have no shell.").length - 1;
    assert.equal(occurrences, 1, `expected no-shell fact sentence to be defined once in registry.ts, found ${occurrences}`);
  });

  it("FXS-2: inspect_command description for research, plan, and verify includes return_task guidance and never instructs blocking or escalating", () => {
    for (const role of ["research", "plan", "verify"] as const) {
      const described = describeTool("inspect_command", role);
      const listed = toolsForRole(role).find((t) => t.name === "inspect_command");
      assert.ok(listed, `inspect_command missing from toolsForRole("${role}")`);
      assert.equal(listed.description, described);

      assert.ok(described.includes("return_task"), `${role} inspect_command missing return_task guidance`);
      assert.match(described, /outside this list/i);
      assert.match(described, /writable task/i);
      assert.doesNotMatch(
        described,
        /\b(?:block|blocked|escalat\w*|report_issue)\b/i,
        `${role} inspect_command must not instruct blocking or escalating: ${described}`,
      );
    }

    // Read-only execute also lists inspect_command with the same guidance
    const roExecTool = toolsForRole("execute", { readOnly: true }).find((t) => t.name === "inspect_command");
    assert.ok(roExecTool?.description.includes("return_task"));
  });

  it("FXS-3a: orchestrator spawning research with build command succeeds unchanged apart from harness_advisory naming spawn_worker", async () => {
    const fx = makeExecutorFixture();
    try {
      const res = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "spawn_task", {
        kind: "research",
        title: "Build check",
        objective: "Run bun run build and report the errors",
        model: "fixture/fixture",
      })) as Record<string, unknown>;

      assert.equal(typeof res.spawned, "string");
      const childId = res.spawned as string;
      assert.deepEqual(fx.startedIds, [childId], "spawn must still start the child task");
      const childRow = fx.db.getTask(childId);
      assert.ok(childRow, "child task must be persisted in DB");
      assert.equal(childRow.kind, "research");
      assert.equal(childRow.readOnly, true);

      // Result payload apart from harness_advisory matches a clean spawn result
      const cleanRes = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "spawn_task", {
        kind: "research",
        title: "Clean check",
        objective: "Inspect src/advisories/rules.ts and summarize the rules",
        model: "fixture/fixture",
      })) as Record<string, unknown>;
      assert.equal(cleanRes.harness_advisory, undefined);
      const resWithoutAdv = { ...res };
      delete resWithoutAdv.harness_advisory;
      assert.deepEqual(Object.keys(resWithoutAdv).sort(), Object.keys(cleanRes).sort());
      assert.equal(resWithoutAdv.kind, cleanRes.kind);
      assert.equal(resWithoutAdv.readOnly, cleanRes.readOnly);
      assert.equal(resWithoutAdv.status, cleanRes.status);

      // Single read-only-brief-needs-shell advisory naming child, command, Why, Instead with spawn_worker
      assert.ok(Array.isArray(res.harness_advisory), "expected harness_advisory array");
      assert.equal((res.harness_advisory as string[]).length, 1);
      const noticeText = (res.harness_advisory as string[])[0]!;
      assert.match(noticeText, ADVISORY_FORMAT);
      assert.ok(noticeText.includes(childId), `notice should name child ${childId}: ${noticeText}`);
      assert.ok(noticeText.includes("bun run build"), `notice should quote command: ${noticeText}`);
      const insteadPart = noticeText.split("Instead:")[1] ?? "";
      assert.ok(insteadPart.includes("spawn_worker"), `orchestrator Instead must name spawn_worker: ${noticeText}`);

      assert.equal(fx.records.length, 1);
      assert.equal(fx.records[0]!.notice.rule, "read-only-brief-needs-shell");
      assert.equal(fx.records[0]!.key, childId);
      checkNoticeShape(fx.records[0]!.notice, "FXS-3a orchestrator");
    } finally {
      fx.cleanup();
    }

    // Additional positive examples from spec through AdvisoryEngine
    const positiveCases = [
      { objective: "run bun run build", expected: "bun run build" },
      { objective: "run `npm install` then start the dev server", expected: "npm install" },
      { objective: "execute scripts/release.sh", expected: "scripts/release.sh" },
      { objective: "build the project with cargo build", expected: "cargo build" },
      { objective: "run make test", expected: "make test" },
      { objective: "run bun run install", expected: "bun run install" },
      { objective: "`cargo build --release` and report any compiler warnings", expected: "cargo build --release" },
    ];
    for (let i = 0; i < positiveCases.length; i++) {
      const { objective, expected } = positiveCases[i]!;
      const { engine } = makeEngine();
      const subject = buildSubject({
        task: makeTaskRecord({ id: `t-pos-${i}`, tier: 1, kind: "orchestrator", readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });
      const notices = engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: "spawn_task",
        status: "completed",
        args: { kind: "research", title: "Task", objective, criteria: "" },
        paths: [],
        result: { spawned: `t-child-pos-${i}` },
        inScript: false,
      });
      assert.equal(notices.length, 1, `expected advisory for "${objective}"`);
      assert.equal(notices[0]!.rule, "read-only-brief-needs-shell");
      assert.ok(notices[0]!.what.includes(expected), `expected "${expected}" in "${notices[0]!.what}"`);
      checkNoticeShape(notices[0]!, `positive case ${i}`);
    }
  });

  it("FXS-3b: director case names a goal or steer_task in Instead and does not name spawn_worker", () => {
    const { engine } = makeEngine();
    const director = buildDirectorSubject({
      sessionId: "dir-fxs-3b",
      repoRoot: WORKSPACE,
      userMessage: "Check the build",
    });

    const notices = engine.observeHarness(director, {
      origin: "result",
      surface: "harness",
      tool: "spawn_task",
      status: "completed",
      args: {
        kind: "plan",
        title: "Build plan",
        objective: "Run bun run build and capture output",
        criteria: "",
      },
      paths: [],
      result: { spawned: "t-dir-child-1" },
      inScript: false,
    });

    assert.equal(notices.length, 1);
    const notice = notices[0]!;
    assert.equal(notice.rule, "read-only-brief-needs-shell");
    checkNoticeShape(notice, "FXS-3b director");
    assert.ok(notice.what.includes("t-dir-child-1"));
    assert.ok(notice.what.includes("bun run build"));
    assert.ok(
      notice.alternative.includes("goal") || notice.alternative.includes("steer_task"),
      `director Instead must name a goal or steer_task: ${notice.alternative}`,
    );
    assert.ok(notice.alternative.includes("goal"), `director Instead should name a goal: ${notice.alternative}`);
    assert.ok(notice.alternative.includes("steer_task"), `director Instead should name steer_task: ${notice.alternative}`);
    assert.ok(!notice.alternative.includes("spawn_worker"), `director Instead must not name spawn_worker: ${notice.alternative}`);
  });

  it("FXS-3c: worker spawning kind verify with build command names an execute task in Instead", async () => {
    const fx = makeExecutorFixture();
    try {
      const res = (await fx.executor.execute(fx.run.id, fx.workerTask.id, "spawn_task", {
        kind: "verify",
        title: "Verify build",
        objective: "Run make test and report failures",
        model: "fixture/fixture",
      })) as Record<string, unknown>;

      assert.equal(typeof res.spawned, "string");
      assert.ok(Array.isArray(res.harness_advisory));
      assert.equal((res.harness_advisory as string[]).length, 1);
      const noticeText = (res.harness_advisory as string[])[0]!;
      assert.match(noticeText, ADVISORY_FORMAT);
      const insteadPart = noticeText.split("Instead:")[1] ?? "";
      assert.match(insteadPart, /execute task/i, `worker Instead must name an execute task: ${noticeText}`);
      assert.ok(!insteadPart.includes("spawn_worker"), `worker Instead must not name spawn_worker: ${noticeText}`);

      assert.equal(fx.records.length, 1);
      checkNoticeShape(fx.records[0]!.notice, "FXS-3c worker verify");
    } finally {
      fx.cleanup();
    }
  });

  it("FXS-3d: silent table stays silent on allowlisted commands, negations, reading-about-command briefs, and writable execute tasks", () => {
    const silentBriefs: Array<{ label: string; role: "orchestrator" | "worker" | "director"; kind: string; read_only?: boolean; objective: string }> = [
      { label: "allowlisted bun test", role: "orchestrator", kind: "verify", objective: "run bun test test/foo.test.ts" },
      { label: "allowlisted bunx tsc --noEmit", role: "orchestrator", kind: "verify", objective: "run bunx tsc --noEmit" },
      { label: "allowlisted git log", role: "orchestrator", kind: "research", objective: "check git log for the commit" },
      { label: "allowlisted rg", role: "orchestrator", kind: "research", objective: "use rg to find callers" },
      { label: "negated build", role: "orchestrator", kind: "research", objective: "do not run the build" },
      { label: "negated without running npm install", role: "orchestrator", kind: "research", objective: "without running npm install" },
      { label: "explain what bun run build does", role: "orchestrator", kind: "research", objective: "explain what bun run build does" },
      {
        label: "reading about bun run build failure",
        role: "orchestrator",
        kind: "research",
        objective: "find out why bun run build fails by reading scripts/build.ts",
      },
      {
        label: "writable execute task (read_only omitted)",
        role: "worker",
        kind: "execute",
        objective: "Run bun run build and report the errors",
      },
      {
        label: "writable execute task (read_only false)",
        role: "worker",
        kind: "execute",
        read_only: false,
        objective: "Run `npm install` then execute scripts/release.sh",
      },
    ];

    for (let i = 0; i < silentBriefs.length; i++) {
      const tc = silentBriefs[i]!;
      const { engine } = makeEngine();
      const subject =
        tc.role === "director"
          ? buildDirectorSubject({ sessionId: `dir-silent-${i}`, repoRoot: WORKSPACE, userMessage: "Inspect" })
          : buildSubject({
              task: makeTaskRecord({
                id: `t-silent-${i}`,
                tier: tc.role === "worker" ? 2 : 1,
                kind: tc.role,
                readOnly: tc.role !== "worker",
              }),
              workspaceRoot: WORKSPACE,
              writeScopes: [],
              writableExtraRoots: [],
            });

      const notices = engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: "spawn_task",
        status: "completed",
        args: {
          kind: tc.kind,
          ...(tc.read_only !== undefined ? { read_only: tc.read_only } : {}),
          title: tc.label,
          objective: tc.objective,
          criteria: "",
        },
        paths: [],
        result: { spawned: `t-silent-child-${i}` },
        inScript: false,
      });

      assert.deepEqual(
        notices,
        [],
        `expected silent for "${tc.label}" ("${tc.objective}"), got: ${notices.map(formatNotice).join("; ")}`,
      );
    }
  });

  it("FXS-3e: same child does not produce a second notice; second child does, up to the cap", () => {
    const { engine } = makeEngine();
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-dedupe-orch", tier: 1, kind: "orchestrator", readOnly: true }),
      workspaceRoot: WORKSPACE,
      writeScopes: [],
      writableExtraRoots: [],
    });

    const spawnCall = (childId: string, objective: string) =>
      engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: "spawn_task",
        status: "completed",
        args: { kind: "research", title: "Check", objective, criteria: "" },
        paths: [],
        result: { spawned: childId },
        inScript: false,
      });

    // First child fires
    const first = spawnCall("t-child-1", "run bun run build");
    assert.equal(first.length, 1);
    assert.equal(first[0]!.rule, "read-only-brief-needs-shell");

    // Same child does not fire a second notice
    const repeatSameChild = spawnCall("t-child-1", "run make test");
    assert.deepEqual(repeatSameChild, []);

    // Second child fires (up to maxPerSubject = 2)
    const second = spawnCall("t-child-2", "execute scripts/release.sh");
    assert.equal(second.length, 1);
    assert.equal(second[0]!.rule, "read-only-brief-needs-shell");
    assert.ok(second[0]!.what.includes("t-child-2"));

    // Third child is capped (no flood)
    const third = spawnCall("t-child-3", "build the project with cargo build");
    assert.deepEqual(third, []);
  });

  it("FXS-3f: worker spawning kind execute with read_only true and a build command fires", async () => {
    const fx = makeExecutorFixture();
    try {
      const res = (await fx.executor.execute(fx.run.id, fx.workerTask.id, "spawn_task", {
        kind: "execute",
        read_only: true,
        title: "Read-only exec build",
        objective: "Build the project with cargo build",
        model: "fixture/fixture",
      })) as Record<string, unknown>;

      assert.equal(typeof res.spawned, "string");
      const childId = res.spawned as string;
      const childRow = fx.db.getTask(childId);
      assert.ok(childRow);
      assert.equal(childRow.kind, "execute");
      assert.equal(childRow.readOnly, true);

      assert.ok(Array.isArray(res.harness_advisory));
      assert.equal((res.harness_advisory as string[]).length, 1);
      const noticeText = (res.harness_advisory as string[])[0]!;
      assert.match(noticeText, ADVISORY_FORMAT);
      assert.ok(noticeText.includes(childId));
      assert.ok(noticeText.includes("cargo build"));
      assert.ok(noticeText.includes("read-only execute"));
      const insteadPart = noticeText.split("Instead:")[1] ?? "";
      assert.match(insteadPart, /execute task/i);

      assert.equal(fx.records.length, 1);
      checkNoticeShape(fx.records[0]!.notice, "FXS-3f worker read-only execute");
    } finally {
      fx.cleanup();
    }
  });
});
