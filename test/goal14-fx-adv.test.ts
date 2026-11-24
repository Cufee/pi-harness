import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  ALL_RULES,
  AdvisoryEngine,
  AdvisedToolExecutor,
  NativeEventParser,
  WORD_BUDGET,
  attachNotices,
  buildDirectorSubject,
  buildSubject,
  countWords,
  formatNotice,
  harnessToolFromTitle,
  type AdvisoryRecord,
  type AdvisoryRule,
  type Notice,
  type ScopeFinding,
  type ScopeSignalSource,
  type Subject,
} from "../src/advisories/index.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { effectiveCodeMode } from "../src/code-mode/index.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb, type TaskRecord } from "../src/control-plane/db.js";
import { ControlPlaneToolExecutor, type ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { QuotaClient } from "../src/quota/client.js";
import { filesOutsideWriteScopes } from "../src/worktree/merge-queue.js";

const WORKSPACE = "/tmp/pi-harness-fx-adv-ws";

const HARNESS_TOOLS = new Set([
  "task_get",
  "tree_view",
  "queue_list",
  "list_timers",
  "spawn_task",
  "spawn_worker",
  "wait_children",
  "wait_tasks",
  "report_issue",
  "return_task",
  "artifact_write",
  "artifact_read",
  "inspect_command",
  "blackboard_set",
  "code_exec",
  "tool_search",
]);

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    id: "t-1",
    runId: "run-1",
    parentId: null,
    tier: 2,
    kind: "worker",
    title: "Test task",
    objective: "Do bounded work",
    criteria: "",
    readOnly: false,
    profileId: "pi-default",
    model: "test-model",
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

function createFakeScopeSource(opts: {
  evaluate?: () => ScopeFinding | null;
  signals?: () => ReturnType<ScopeSignalSource["signals"]>;
  marks?: () => { areas: number; scoredCalls: number };
} = {}): ScopeSignalSource {
  return {
    observe() {},
    evaluate: () => opts.evaluate?.() ?? null,
    signals: () =>
      opts.signals?.() ?? {
        distinctAreas: [],
        newAreasInWindow: 0,
        searchTopics: [],
        repeatStreak: 0,
        staleStreak: 0,
      },
    marks: () => opts.marks?.() ?? { areas: 0, scoredCalls: 0 },
    resetStale() {},
  };
}

function makeEngine(opts: {
  rules?: readonly AdvisoryRule[];
  createScopeSource?: (subject: Subject) => ScopeSignalSource | null;
  records?: AdvisoryRecord[];
  record?: (entry: AdvisoryRecord) => void;
} = {}) {
  const records = opts.records ?? [];
  const engine = new AdvisoryEngine({
    rules: opts.rules ?? ALL_RULES,
    createScopeSource: opts.createScopeSource ?? (() => null),
    filesOutsideWriteScopes,
    harnessToolNames: HARNESS_TOOLS,
    record: opts.record ?? ((entry) => records.push(entry)),
  });
  return { engine, records };
}

function makeExecutorFixture(opts: {
  rules?: readonly AdvisoryRule[];
  record?: (entry: AdvisoryRecord) => void;
  records?: AdvisoryRecord[];
  subjectFor?: (task: TaskRecord) => Subject | null;
  forceStartWorker?: ToolRuntimeHooks["forceStartWorker"];
  codeMode?: "off" | "hybrid" | "collapsed";
} = {}) {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-harness-fx-adv-"));
  const db = new ControlPlaneDb(join(tmpDir, "harness.sqlite"));
  const run = db.createRun({
    goal: "FX-ADV executor fixture",
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
    profileId: "pi-default",
  });
  db.updateTask(orchTask.id, { status: "running" });

  const records = opts.records ?? [];
  const { engine } = makeEngine({
    rules: opts.rules ?? ALL_RULES,
    records,
    record: opts.record,
  });

  const abort = new AbortController();
  const hooks: ToolRuntimeHooks = {
    spawnAndStartTask: async () => {
      throw new Error("unused");
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
    forceStartWorker: opts.forceStartWorker ?? (async () => ["w-1"]),
    getTaskSignal: () => abort.signal,
  };

  const baseConfig = loadConfig(tmpDir);
  const config = {
    ...baseConfig,
    stateDir: join(tmpDir, "state"),
    codeMode: opts.codeMode ?? ("hybrid" as const),
  };
  const catalog = new ModelCatalogCompiler(config, new QuotaClient());
  const defaultSubjectFor = (task: TaskRecord) =>
    buildSubject({
      task,
      workspaceRoot: tmpDir,
      writeScopes: [],
      writableExtraRoots: [],
    });

  const executor = new AdvisedToolExecutor(db, () => catalog, hooks, config, {
    engine,
    subjectFor: opts.subjectFor ?? defaultSubjectFor,
  });

  return {
    tmpDir,
    db,
    run,
    orchTask,
    engine,
    records,
    executor,
    defaultSubjectFor,
    cleanup() {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe("goal-14 fix FX-ADV", () => {
  it("FXA-1: native search mentioning harness tool is native search activity; structured identity and anchored harness titles still classify", () => {
    // Prose native titles must NOT match harness tools.
    assert.equal(harnessToolFromTitle("Search for harness task_get in src", HARNESS_TOOLS), null);
    assert.equal(harnessToolFromTitle("Search for mcp__harness__task_get in src", HARNESS_TOOLS), null);
    assert.equal(harnessToolFromTitle("Read src/harness/task_get.ts", HARNESS_TOOLS), null);
    assert.equal(harnessToolFromTitle("harness task_get", HARNESS_TOOLS), null);

    // Real anchored harness tool titles still classify.
    const realTitles = [
      "task_get",
      "mcp__harness__task_get",
      "mcp_harness_task_get",
      "mcp.harness.task_get",
      "mcp/harness/task_get",
      "mcp:harness:task_get",
      "harness__task_get",
      "harness_task_get",
      "harness/task_get",
      "harness.task_get",
      "harness:task_get",
      "harness: task_get",
    ];
    for (const title of realTitles) {
      assert.equal(harnessToolFromTitle(title, HARNESS_TOOLS), "task_get", `expected harness tool for title: ${title}`);
    }

    const parser = new NativeEventParser({ workspaceRoot: WORKSPACE, harnessToolNames: HARNESS_TOOLS });

    // Counterexample title parses as native search activity.
    const searchEvent = parser.push({
      id: "search-1",
      name: "Search for harness task_get in src",
      title: "Search for harness task_get in src",
      status: "completed",
      args: JSON.stringify({ path: "src/advisories/native.ts", pattern: "task_get" }),
    });
    assert.ok(searchEvent);
    assert.equal(searchEvent.harnessTool, null);
    assert.equal(searchEvent.nativeClass, "search");
    assert.deepEqual(searchEvent.paths, ["src/advisories/native.ts"]);

    // Structured harness identity classifies even under a generic title.
    const structuredHarness = parser.push({
      id: "mcp-1",
      name: "mcp_call",
      title: "Call MCP tool",
      status: "completed",
      args: JSON.stringify({ server: "harness", tool: "task_get", path: "src/b/ignored.ts" }),
    });
    assert.ok(structuredHarness);
    assert.equal(structuredHarness.harnessTool, "task_get");

    // Explicit non-harness structured server does NOT classify as a harness tool.
    const structuredOther = parser.push({
      id: "mcp-2",
      name: "task_get",
      title: "mcp__harness__task_get",
      status: "completed",
      args: JSON.stringify({ server: "other-mcp", tool: "task_get" }),
    });
    assert.ok(structuredOther);
    assert.equal(structuredOther.harnessTool, null);

    // End-to-end through AdvisoryEngine: native search increments activity; real harness titles do not.
    const { engine } = makeEngine();
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-fxa1", tier: 2, kind: "worker", readOnly: false }),
      workspaceRoot: WORKSPACE,
      writeScopes: ["src/a/"],
      writableExtraRoots: [],
    });

    engine.observeEvent(subject, {
      id: "eng-h1",
      name: "harness: task_get",
      title: "harness: task_get",
      kind: "edit",
      status: "completed",
      args: JSON.stringify({ path: "src/b/ignored.ts" }),
    });
    engine.observeEvent(subject, {
      id: "eng-h2",
      name: "mcp_call",
      status: "completed",
      args: JSON.stringify({ server: "harness", tool: "task_get", path: "src/b/ignored2.ts" }),
    });
    assert.equal(engine.activityProgress(subject.id), 0);
    assert.equal(engine.take(subject.id).length, 0);

    engine.observeEvent(subject, {
      id: "eng-s1",
      name: "Search for harness task_get in src",
      title: "Search for harness task_get in src",
      status: "completed",
      args: JSON.stringify({ path: "src/advisories/native.ts", pattern: "task_get" }),
    });
    assert.equal(engine.activityProgress(subject.id), 1);
  });

  it("FXA-2: every rule interpolating paths or scopes stays <= 60 words with long space-containing paths while preserving full paths in data", () => {
    const advisoryFormat = /^\[harness advisory: [\w-]+\] .+ Why: .+ Instead: .+$/;

    // 1a. worker-edit-outside-scope with 3 long whitespace-containing scopes and a long whitespace-containing path.
    {
      const longScopes = [
        "docs/getting started user guide/section one/overview files/",
        "docs/api reference developer manual/section two/endpoint specs/",
        "docs/release notes archive history/section three/changelog entries/",
      ];
      const longTarget =
        "packages/customer facing web application/src/shared layout components/navigation header banner.ts";
      const { engine, records } = makeEngine();
      const subject = buildSubject({
        task: makeTaskRecord({ id: "t-fxa2-w3", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: longScopes,
        writableExtraRoots: [],
      });

      engine.observeEvent(subject, {
        id: "e-1",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ path: longTarget }),
      });

      const notices = engine.take(subject.id);
      assert.equal(notices.length, 1);
      const notice = notices[0]!;
      assert.ok(
        countWords(notice) <= WORD_BUDGET,
        `worker-edit-outside-scope (3 long scopes) exceeded ${WORD_BUDGET} words (${countWords(notice)}): ${formatNotice(notice)}`,
      );
      assert.match(formatNotice(notice), advisoryFormat);

      engine.delivered(subject.id, notices, "tool_result");
      assert.equal(records.length, 1);
      assert.equal(records[0]!.key, longTarget);
      assert.deepEqual(records[0]!.data, { path: longTarget, writeScopes: longScopes });
    }

    // 1b. worker-edit-outside-scope with 5 long whitespace-containing scopes.
    {
      const manyLongScopes = [
        "packages/first very long package name/src/alpha/",
        "packages/second very long package name/src/beta/",
        "packages/third very long package name/src/gamma/",
        "packages/fourth very long package name/src/delta/",
        "packages/fifth very long package name/src/epsilon/",
      ];
      const longTarget = "services/billing ledger reconciliation engine/internal worker queue handler.ts";
      const { engine, records } = makeEngine();
      const subject = buildSubject({
        task: makeTaskRecord({ id: "t-fxa2-w5", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: manyLongScopes,
        writableExtraRoots: [],
      });

      engine.observeEvent(subject, {
        id: "e-2",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ path: longTarget }),
      });

      const notices = engine.take(subject.id);
      assert.equal(notices.length, 1);
      const notice = notices[0]!;
      assert.ok(
        countWords(notice) <= WORD_BUDGET,
        `worker-edit-outside-scope (5 long scopes) exceeded ${WORD_BUDGET} words (${countWords(notice)}): ${formatNotice(notice)}`,
      );
      assert.match(formatNotice(notice), advisoryFormat);

      engine.delivered(subject.id, notices, "tool_result");
      assert.deepEqual(records[0]!.data, { path: longTarget, writeScopes: manyLongScopes });
    }

    // 2. scope-too-large widening with long whitespace-containing areas and topics.
    {
      const longAreas = Array.from(
        { length: 8 },
        (_, i) => `packages/very long workspace directory area ${i + 1} with spaces/nested module`,
      );
      const longTopics = Array.from(
        { length: 5 },
        (_, i) => `authentication token rotation policy topic ${i + 1} implementation details`,
      );
      const { engine, records } = makeEngine({
        createScopeSource: () =>
          createFakeScopeSource({
            evaluate: () => ({ widening: { areas: longAreas, topics: longTopics } }),
            signals: () => ({
              distinctAreas: longAreas,
              newAreasInWindow: 8,
              searchTopics: longTopics,
              repeatStreak: 0,
              staleStreak: 0,
            }),
          }),
      });
      const subject = buildSubject({
        task: makeTaskRecord({ id: "t-fxa2-scope", tier: 3, kind: "research", readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });

      engine.observeEvent(subject, { id: "s-1", name: "read", kind: "read", status: "completed" });
      const notices = engine.take(subject.id);
      assert.equal(notices.length, 1);
      const notice = notices[0]!;
      assert.ok(
        countWords(notice) <= WORD_BUDGET,
        `scope-too-large widening exceeded ${WORD_BUDGET} words (${countWords(notice)}): ${formatNotice(notice)}`,
      );
      assert.match(formatNotice(notice), advisoryFormat);

      engine.delivered(subject.id, notices, "tool_result");
      const data = records[0]!.data as { finding: ScopeFinding };
      assert.deepEqual(data.finding.widening?.areas, longAreas);
      assert.deepEqual(data.finding.widening?.topics, longTopics);
    }
  });

  it("FXA-3: legal in-workspace names starting with two dots are accepted while parent traversal '..' is still rejected", () => {
    const parser = new NativeEventParser({ workspaceRoot: WORKSPACE, harnessToolNames: HARNESS_TOOLS });

    // NativeEventParser keeps "..config/x.ts" relative (in-workspace) for both relative and absolute input.
    const relTwoDot = parser.push({
      id: "td-1",
      name: "edit_file",
      kind: "edit",
      status: "completed",
      args: JSON.stringify({ path: "..config/x.ts" }),
    });
    assert.deepEqual(relTwoDot?.paths, ["..config/x.ts"]);

    const absTwoDot = parser.push({
      id: "td-2",
      name: "edit_file",
      kind: "edit",
      status: "completed",
      args: JSON.stringify({ path: join(WORKSPACE, "..config/x.ts") }),
    });
    assert.deepEqual(absTwoDot?.paths, ["..config/x.ts"]);

    // Actual parent traversal still resolves outside workspace (absolute path).
    const traversal = parser.push({
      id: "td-3",
      name: "edit_file",
      kind: "edit",
      status: "completed",
      args: JSON.stringify({ path: "../outside/secret.ts" }),
    });
    assert.equal(traversal?.paths[0], "/tmp/outside/secret.ts");

    // worker-edit-outside-scope fires on out-of-scope "..config/x.ts", stays silent on real "../outside.ts".
    {
      const { engine } = makeEngine();
      const worker = buildSubject({
        task: makeTaskRecord({ id: "t-fxa3-w1", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/a/"],
        writableExtraRoots: [],
      });

      assert.equal(
        engine.observeEvent(worker, {
          id: "w-out-traversal",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "../outside/secret.ts" }),
        }),
        false,
      );

      assert.equal(
        engine.observeEvent(worker, {
          id: "w-two-dot",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "..config/x.ts" }),
        }),
        true,
      );
      const notices = engine.take(worker.id);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.rule, "worker-edit-outside-scope");
      assert.ok(notices[0]!.what.includes("..config/x.ts"));
    }

    // worker-edit-outside-scope treats "..config/" in writableExtraRoots as allowed (isUnderRoot).
    {
      const { engine } = makeEngine();
      const worker = buildSubject({
        task: makeTaskRecord({ id: "t-fxa3-w2", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/a/"],
        writableExtraRoots: [join(WORKSPACE, "..config")],
      });

      assert.equal(
        engine.observeEvent(worker, {
          id: "w-extra-two-dot",
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "..config/x.ts" }),
        }),
        false,
      );
    }

    // director-self-reading counts "..config/..." workspace files across 3 areas, and honors pathHints for "..config".
    {
      const { engine } = makeEngine();
      const director = buildDirectorSubject({
        sessionId: "sess-fxa3",
        repoRoot: WORKSPACE,
        userMessage: "Look around",
      });

      const areas = ["..config/a", "..config/b", "..config/c"];
      let fired: Notice[] = [];
      for (let i = 0; i < 12; i++) {
        const notices = engine.observeHarness(director, {
          origin: "result",
          surface: "harness",
          tool: "read_file",
          status: "completed",
          args: { path: `${areas[i % 3]}/file-${i}.ts` },
          paths: [],
          result: { content: "x" },
          inScript: false,
        });
        fired = fired.concat(notices);
      }
      assert.equal(fired.length, 1);
      assert.equal(fired[0]!.rule, "director-self-reading");

      // With absolute "..config" hint, reads under "..config/..." stay silent.
      const hintedDirector = buildDirectorSubject({
        sessionId: "sess-fxa3-hint",
        repoRoot: WORKSPACE,
        userMessage: `Read ${join(WORKSPACE, "..config")}`,
      });
      for (let i = 0; i < 12; i++) {
        const notices = engine.observeHarness(hintedDirector, {
          origin: "result",
          surface: "harness",
          tool: "read_file",
          status: "completed",
          args: { path: `${areas[i % 3]}/file-${i}.ts` },
          paths: [],
          result: { content: "x" },
          inScript: false,
        });
        assert.deepEqual(notices, []);
      }
    }
  });

  it("FXA-4: advisory engine or record exceptions are fail-open, logged, and never hide the underlying tool outcome", async () => {
    const logged: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    try {
      // (a) Engine throws in observeHarness AFTER a successful DB mutation (blackboard_set).
      {
        const fx = makeExecutorFixture();
        try {
          fx.engine.observeHarness = () => {
            throw new Error("engine observe explosion");
          };

          const res = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "blackboard_set", {
            key: "fxa4/contract",
            value: { ok: true },
          })) as { ok: boolean; key: string };

          assert.deepEqual(res, { ok: true, key: "fxa4/contract" });
          assert.deepEqual(fx.db.blackboardGet(fx.run.id, "fxa4/contract")["fxa4/contract"]?.value, { ok: true });
          assert.ok(logged.some((m) => m.includes("engine observe explosion")));
        } finally {
          fx.cleanup();
        }
      }

      // (b) record() callback throws during delivery after a successful mutation.
      {
        logged.length = 0;
        const alwaysRule: AdvisoryRule<null> = {
          id: "fxa4-rule",
          roles: ["orchestrator"],
          surface: "result",
          priority: 50,
          init: () => null,
          observe() {
            return {
              key: "k1",
              what: "Stub notice.",
              why: "Testing record throw.",
              alternative: "Continue.",
            };
          },
          dedupe: { perKey: "generation" },
        };
        const fx = makeExecutorFixture({
          rules: [alwaysRule],
          record: () => {
            throw new Error("record callback explosion");
          },
        });
        try {
          const res = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "blackboard_set", {
            key: "fxa4/recorded",
            value: { saved: 1 },
          })) as { ok: boolean; key: string; harness_advisory?: string[] };

          assert.equal(res.ok, true);
          assert.equal(res.key, "fxa4/recorded");
          assert.deepEqual(fx.db.blackboardGet(fx.run.id, "fxa4/recorded")["fxa4/recorded"]?.value, { saved: 1 });
          assert.ok(logged.some((m) => m.includes("record callback explosion")));
        } finally {
          fx.cleanup();
        }
      }

      // (c) subjectFor throws before dispatch: underlying tool still runs and returns its result.
      {
        logged.length = 0;
        const fx = makeExecutorFixture({
          subjectFor: () => {
            throw new Error("subject lookup explosion");
          },
        });
        try {
          const res = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "blackboard_set", {
            key: "fxa4/subject-throw",
            value: { v: 2 },
          })) as { ok: boolean; key: string };

          assert.deepEqual(res, { ok: true, key: "fxa4/subject-throw" });
          assert.ok(logged.some((m) => m.includes("subject lookup explosion")));
        } finally {
          fx.cleanup();
        }
      }

      // (d) Engine throws in observeHarness after the underlying tool fails: original tool error propagates.
      {
        logged.length = 0;
        const fx = makeExecutorFixture();
        try {
          fx.engine.observeHarness = () => {
            throw new Error("engine failed-path explosion");
          };

          await assert.rejects(
            () => fx.executor.execute(fx.run.id, fx.orchTask.id, "task_get", { task_id: "t-does-not-exist" }),
            /Unknown task t-does-not-exist/,
          );
          assert.ok(logged.some((m) => m.includes("engine failed-path explosion")));
        } finally {
          fx.cleanup();
        }
      }
    } finally {
      console.error = origError;
    }
  });

  it("FXA-5: primitive results including strings are preserved unchanged and queued notices deliver on the next object result", async () => {
    const sampleNotice: Notice = {
      level: "advisory",
      rule: "fxa5-notice",
      what: "Queued notice.",
      why: "Testing primitive preservation.",
      alternative: "Read on next object.",
    };

    // Direct attachNotices checks: strings and all other primitives/arrays stay unchanged with attached=false.
    for (const primitive of ["hello world", "", 42, true, false, null, undefined, ["a", "b"]]) {
      const out = attachNotices(primitive, [sampleNotice]);
      assert.equal(out.attached, false);
      assert.deepEqual(out.result, primitive);
    }

    // Plain object IS annotated.
    const objOut = attachNotices({ ok: true }, [sampleNotice]);
    assert.equal(objOut.attached, true);
    assert.deepEqual(objOut.result, {
      ok: true,
      harness_advisory: [formatNotice(sampleNotice)],
    });

    // End-to-end through AdvisedToolExecutor: string tool result stays untouched, notice requeues and delivers on next object result.
    const fx = makeExecutorFixture({
      forceStartWorker: async () => "started:w-1",
    });
    try {
      const subject = fx.defaultSubjectFor(fx.orchTask);
      fx.engine.post(subject, sampleNotice, { key: "fxa5-key", lifetime: "subject" });

      const stringResult = await fx.executor.execute(fx.run.id, fx.orchTask.id, "queue_force_start", {
        target_id: "w-1",
      });
      assert.equal(stringResult, "started:w-1");
      assert.equal(fx.records.length, 0, "string result must not mark notice delivered");

      const objectResult = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "list_timers", {})) as Record<
        string,
        unknown
      >;
      assert.ok(Array.isArray(objectResult.timers));
      assert.deepEqual(objectResult.harness_advisory, [formatNotice(sampleNotice)]);
      assert.equal(fx.records.length, 1);
      assert.equal(fx.records[0]!.delivery, "tool_result");
    } finally {
      fx.cleanup();
    }
  });

  it("FXA-6: code_exec result resolving with ok:false keeps queued notices until a successful result", async () => {
    const queuedNotice: Notice = {
      level: "advisory",
      rule: "fxa6-queued",
      what: "Notice queued before failed code_exec.",
      why: "Failed Code Mode scripts must not drain notices.",
      alternative: "Deliver on the next successful result.",
    };

    // Deterministic check through AdvisedToolExecutor's code_exec branch (works with or without OS sandbox).
    {
      const fx = makeExecutorFixture();
      const origSuperExecute = ControlPlaneToolExecutor.prototype.execute;
      try {
        const subject = fx.defaultSubjectFor(fx.orchTask);
        fx.engine.post(subject, queuedNotice, { key: "fxa6-1", lifetime: "subject" });

        let nextCodeExecResult: Record<string, unknown> = {
          ok: false,
          preview: "",
          logs: "",
          toolCalls: 1,
          error: "ReferenceError: boom",
        };
        ControlPlaneToolExecutor.prototype.execute = async function (runId, taskId, name, args, scriptSignal, callerSignal) {
          if (name === "code_exec") return nextCodeExecResult;
          return origSuperExecute.call(this, runId, taskId, name, args, scriptSignal, callerSignal);
        };

        const failedRes = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "code_exec", {
          code: "throw new Error('boom');",
        })) as Record<string, unknown>;
        assert.equal(failedRes.ok, false);
        assert.equal(failedRes.harness_advisory, undefined);
        assert.equal(fx.records.length, 0);

        // Next successful code_exec result drains and delivers the still-queued notice.
        nextCodeExecResult = { ok: true, preview: "done", logs: "", toolCalls: 0 };
        const okRes = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "code_exec", {
          code: "output({ done: true });",
        })) as Record<string, unknown>;
        assert.equal(okRes.ok, true);
        assert.deepEqual(okRes.harness_advisory, [formatNotice(queuedNotice)]);
        assert.equal(fx.records.length, 1);
        assert.equal(fx.records[0]!.delivery, "tool_result");
      } finally {
        ControlPlaneToolExecutor.prototype.execute = origSuperExecute;
        fx.cleanup();
      }
    }

    // Real sandboxed code_exec check when the OS sandbox is available on this host.
    if (effectiveCodeMode("hybrid") === "hybrid") {
      const fx = makeExecutorFixture({ codeMode: "hybrid" });
      try {
        const subject = fx.defaultSubjectFor(fx.orchTask);
        fx.engine.post(subject, queuedNotice, { key: "fxa6-sandbox", lifetime: "subject" });

        const failedRes = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "code_exec", {
          code: `throw new Error("script failure");`,
        })) as Record<string, unknown>;
        assert.equal(failedRes.ok, false);
        assert.equal(failedRes.harness_advisory, undefined);
        assert.equal(fx.records.length, 0);

        const nextObj = (await fx.executor.execute(fx.run.id, fx.orchTask.id, "list_timers", {})) as Record<
          string,
          unknown
        >;
        assert.deepEqual(nextObj.harness_advisory, [formatNotice(queuedNotice)]);
        assert.equal(fx.records.length, 1);
      } finally {
        fx.cleanup();
      }
    }
  });
});
