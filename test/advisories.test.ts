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
  REJECTIONS,
  SCOPE_ROLES,
  WORD_BUDGET,
  buildDirectorSubject,
  buildSubject,
  contextWarningNotice,
  countWords,
  deniedNotice,
  formatNotice,
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
import type { ToolRuntimeHooks } from "../src/control-plane/tools.js";
import { QuotaClient } from "../src/quota/client.js";

const WORKSPACE = "/tmp/pi-harness-advisories-ws";

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
  "code_exec",
  "tool_search",
]);

function makeTaskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = Date.now();
  return {
    id: "t-1",
    runId: "run-1",
    parentId: null,
    tier: 3,
    kind: "research",
    title: "Investigate module",
    objective: "Find callers of foo",
    criteria: "Return structured sources",
    readOnly: true,
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

function fakeFilesOutsideWriteScopes(files: string[], writeScopes: string[]): string[] {
  const scopes = writeScopes.map((s) => s.trim()).filter(Boolean);
  if (scopes.length === 0 || scopes.some((s) => s === "*" || s === "**" || s === "**/*")) {
    return [];
  }
  return files.filter((file) => {
    const clean = file.replace(/^\.\//, "");
    return !scopes.some((raw) => {
      const norm = raw.replace(/^\.\//, "");
      if (norm.endsWith("/")) return clean.startsWith(norm);
      return clean === norm || clean.startsWith(`${norm}/`);
    });
  });
}

function createFakeScopeSource(opts: {
  evaluate: () => ScopeFinding | null;
  marks?: () => { areas: number; scoredCalls: number };
  onObserve?: (call: Parameters<ScopeSignalSource["observe"]>[0]) => void;
  onResetStale?: () => void;
}): ScopeSignalSource {
  return {
    observe: (call) => opts.onObserve?.(call),
    evaluate: opts.evaluate,
    signals: () => ({
      distinctAreas: [],
      newAreasInWindow: 0,
      searchTopics: [],
      repeatStreak: 0,
      staleStreak: 0,
    }),
    marks: opts.marks ?? (() => ({ areas: 0, scoredCalls: 0 })),
    resetStale: () => opts.onResetStale?.(),
  };
}

function makeEngine(opts?: {
  rules?: readonly AdvisoryRule[];
  createScopeSource?: (subject: Subject) => ScopeSignalSource | null;
  firedBefore?: (subject: Subject) => Array<{ rule: string; key: string }>;
  records?: AdvisoryRecord[];
}): { engine: AdvisoryEngine; records: AdvisoryRecord[] } {
  const records = opts?.records ?? [];
  const engine = new AdvisoryEngine({
    rules: opts?.rules ?? ALL_RULES,
    createScopeSource:
      opts?.createScopeSource ??
      ((s) => (SCOPE_ROLES.has(s.role) ? createFakeScopeSource({ evaluate: () => null }) : null)),
    filesOutsideWriteScopes: fakeFilesOutsideWriteScopes,
    harnessToolNames: HARNESS_TOOLS,
    record: (entry) => records.push(entry),
    firedBefore: opts?.firedBefore,
  });
  return { engine, records };
}

describe("goal-14 slice A advisories", () => {
  it("T3-1a: scope rule fires for a research subject", () => {
    let completedCount = 0;
    const scopeSource = createFakeScopeSource({
      onObserve: (call) => {
        if (call.status === "completed") completedCount += 1;
      },
      evaluate: () =>
        completedCount >= 5
          ? {
              widening: {
                areas: ["src/a", "src/b", "src/c", "src/d", "src/e", "src/f", "src/g", "src/h"],
                topics: ["auth", "billing", "cache", "metrics"],
              },
            }
          : null,
      marks: () => ({ areas: completedCount >= 5 ? 8 : completedCount, scoredCalls: completedCount }),
    });
    const { engine } = makeEngine({ createScopeSource: () => scopeSource });
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-res-1", tier: 3, kind: "research", readOnly: true }),
      workspaceRoot: WORKSPACE,
      writeScopes: [],
      writableExtraRoots: [],
    });

    for (let i = 1; i <= 4; i++) {
      assert.equal(
        engine.observeEvent(subject, {
          id: `c-${i}`,
          name: "read_file",
          kind: "read",
          status: "completed",
          args: JSON.stringify({ path: `src/a${i}/file.ts` }),
        }),
        false,
      );
    }

    const pending = engine.observeEvent(subject, {
      id: "c-5",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: JSON.stringify({ path: "src/a5/file.ts" }),
    });
    assert.equal(pending, true);

    const notices = engine.take(subject.id);
    assert.equal(notices.length, 1);
    const notice = notices[0]!;
    assert.equal(notice.rule, "scope-too-large");
    assert.ok(notice.what.length > 0);
    assert.ok(notice.why.length > 0);
    assert.ok(notice.alternative.length > 0);
    assert.ok(formatNotice(notice).startsWith("[harness advisory: scope-too-large]"));
  });

  it("T3-1b: W1 fires for a worker subject", () => {
    const { engine, records } = makeEngine();
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-work-1", tier: 2, kind: "worker", readOnly: false }),
      workspaceRoot: WORKSPACE,
      writeScopes: ["src/a/"],
      writableExtraRoots: [],
    });

    const first = engine.observeEvent(subject, {
      id: "edit-1",
      name: "edit_file",
      kind: "edit",
      status: "in_progress",
      args: JSON.stringify({ path: "src/b/x.ts" }),
    });
    assert.equal(first, false);

    const second = engine.observeEvent(subject, {
      id: "edit-1",
      name: "edit_file",
      status: "completed",
    });
    assert.equal(second, true);

    const notices = engine.take(subject.id);
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.rule, "worker-edit-outside-scope");
    assert.ok(notices[0]!.what.includes("src/b/x.ts"));

    engine.delivered(subject.id, notices, "tool_result");
    assert.equal(records.length, 1);
    assert.equal(records[0]!.key, "src/b/x.ts");
    assert.equal(records[0]!.delivery, "tool_result");
  });

  it("T3-1c: D1 fires for a Director subject", () => {
    const { engine } = makeEngine();
    const subject = buildDirectorSubject({
      sessionId: "sess-1",
      repoRoot: WORKSPACE,
      userMessage: "How does authentication work in this repository?",
    });

    const files = [
      "src/auth/a1.ts",
      "src/auth/a2.ts",
      "src/auth/a3.ts",
      "src/auth/a4.ts",
      "src/billing/b1.ts",
      "src/billing/b2.ts",
      "src/billing/b3.ts",
      "src/billing/b4.ts",
      "src/cache/c1.ts",
      "src/cache/c2.ts",
      "src/cache/c3.ts",
      "src/cache/c4.ts",
    ];

    for (let i = 0; i < 11; i++) {
      const notices = engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: "read_file",
        status: "completed",
        args: { path: files[i] },
        paths: [files[i]!],
        result: { content: "ok" },
        inScript: false,
      });
      assert.equal(notices.length, 0, `expected no notice on call ${i + 1}`);
    }

    const twelfth = engine.observeHarness(subject, {
      origin: "result",
      surface: "harness",
      tool: "read_file",
      status: "completed",
      args: { path: files[11] },
      paths: [files[11]!],
      result: { content: "ok" },
      inScript: false,
    });
    assert.equal(twelfth.length, 1);
    assert.equal(twelfth[0]!.rule, "director-self-reading");
  });

  it("T3-1d: finding rule fires for research, plan, verify", () => {
    for (const kind of ["research", "plan", "verify"] as const) {
      const { engine } = makeEngine();
      const subject = buildSubject({
        task: makeTaskRecord({ id: `t-${kind}`, tier: 3, kind, readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });

      const notices = engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: "report_issue",
        status: "completed",
        args: { category: "code_defect", severity: "P1", title: "bug", evidence_paths: ["src/a.ts"] },
        paths: [],
        result: { escalationId: "esc-1", blocking: false },
        inScript: false,
      });
      assert.equal(notices.length, 1, `expected notice for ${kind}`);
      assert.equal(notices[0]!.rule, "read-only-finding-escalation");
      assert.ok(notices[0]!.what.includes("esc-1"));
    }

    // blocking: true -> silent
    {
      const { engine } = makeEngine();
      const subject = buildSubject({
        task: makeTaskRecord({ id: "t-ver-block", tier: 3, kind: "verify", readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });
      const notices = engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: "report_issue",
        status: "completed",
        args: { category: "code_defect", severity: "P1", blocking: true },
        paths: [],
        result: { escalationId: "esc-2", blocking: true },
        inScript: false,
      });
      assert.equal(notices.length, 0);
    }

    // worker role -> silent
    {
      const { engine } = makeEngine();
      const subject = buildSubject({
        task: makeTaskRecord({ id: "t-worker-find", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/"],
        writableExtraRoots: [],
      });
      const notices = engine.observeHarness(subject, {
        origin: "result",
        surface: "harness",
        tool: "report_issue",
        status: "completed",
        args: { category: "code_defect", severity: "P2" },
        paths: [],
        result: { escalationId: "esc-3", blocking: false },
        inScript: false,
      });
      assert.equal(notices.length, 0);
    }
  });

  it("T3-2: silent cases across rules 6.1 to 6.6", () => {
    const cases: Array<{ name: string; run: () => Notice[] }> = [
      // 6.1 worker-edit-outside-scope
      {
        name: "W1 in-scope edit",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-1", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["src/a/"],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "completed",
            args: JSON.stringify({ path: "src/a/ok.ts" }),
          });
          return engine.take(s.id);
        },
      },
      {
        name: "W1 path under writableExtraRoots",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-2", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["src/a/"],
            writableExtraRoots: [join(WORKSPACE, ".harness/goals/g1/evidence")],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "completed",
            args: JSON.stringify({ path: ".harness/goals/g1/evidence/out.txt" }),
          });
          return engine.take(s.id);
        },
      },
      {
        name: "W1 path outside workspace (temp file)",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-3", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["src/a/"],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "completed",
            args: JSON.stringify({ path: "/tmp/other-scratch/notes.txt" }),
          });
          return engine.take(s.id);
        },
      },
      {
        name: "W1 empty write scopes",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-4", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "completed",
            args: JSON.stringify({ path: "src/z/x.ts" }),
          });
          return engine.take(s.id);
        },
      },
      {
        name: "W1 wildcard write scopes",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-5", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["**"],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "completed",
            args: JSON.stringify({ path: "src/z/x.ts" }),
          });
          return engine.take(s.id);
        },
      },
      {
        name: "W1 read-only subject",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-6", tier: 3, kind: "execute", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["src/a/"],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "completed",
            args: JSON.stringify({ path: "src/b/x.ts" }),
          });
          return engine.take(s.id);
        },
      },
      {
        name: "W1 failed edit",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-7", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["src/a/"],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "failed",
            args: JSON.stringify({ path: "src/b/x.ts" }),
          });
          return engine.take(s.id);
        },
      },
      {
        name: "W1 edit with no parseable path",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "w1-8", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["src/a/"],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, {
            id: "1",
            name: "edit_file",
            kind: "edit",
            status: "completed",
            args: JSON.stringify({ content: "hello" }),
          });
          return engine.take(s.id);
        },
      },
      // 6.2 scope-too-large
      {
        name: "scope-too-large silent for non-scope role (worker) even if source fires",
        run: () => {
          const { engine } = makeEngine({
            createScopeSource: () =>
              createFakeScopeSource({
                evaluate: () => ({ repeated: { tool: "read", times: 5 } }),
              }),
          });
          const s = buildSubject({
            task: makeTaskRecord({ id: "sc-1", tier: 2, kind: "worker", readOnly: false }),
            workspaceRoot: WORKSPACE,
            writeScopes: ["src/a/"],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, { id: "1", name: "read", kind: "read", status: "completed" });
          return engine.take(s.id);
        },
      },
      {
        name: "scope-too-large silent when evaluate returns null",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "sc-2", tier: 3, kind: "research", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          engine.observeEvent(s, { id: "1", name: "read", kind: "read", status: "completed" });
          return engine.take(s.id);
        },
      },
      // 6.3 read-only-finding-escalation
      {
        name: "finding rule silent on non-finding category (env_failure)",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "f-1", tier: 3, kind: "verify", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          return engine.observeHarness(s, {
            origin: "result",
            surface: "harness",
            tool: "report_issue",
            status: "completed",
            args: { category: "env_failure", severity: "P1" },
            paths: [],
            result: { escalationId: "esc-1", blocking: false },
            inScript: false,
          });
        },
      },
      // 6.4 brief-count-limit
      {
        name: "S1 output-size guidance (summary under 1,500 tokens)",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "s1-1", tier: 1, kind: "orchestrator", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          return engine.observeHarness(s, {
            origin: "result",
            surface: "harness",
            tool: "spawn_task",
            status: "completed",
            args: { title: "Check", objective: "Keep your summary under 1,500 tokens.", criteria: "" },
            paths: [],
            result: { spawned: "t-2" },
            inScript: false,
          });
        },
      },
      {
        name: "S1 counts inside code fences, inline code, and quotes",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "s1-2", tier: 1, kind: "orchestrator", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          return engine.observeHarness(s, {
            origin: "result",
            surface: "harness",
            tool: "spawn_task",
            status: "completed",
            args: {
              title: "Remove old text",
              objective:
                'Delete `Turn budget: 300`, remove "at most 40 tool calls", and drop:\n```\nyou have 50 turns\n```',
              criteria: "Also skip 'stop after 20 turns'.",
            },
            paths: [],
            result: { spawned: "t-3" },
            inScript: false,
          });
        },
      },
      {
        name: "S1 code description with no number, time limits, char limits",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "s1-3", tier: 1, kind: "orchestrator", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          return engine.observeHarness(s, {
            origin: "result",
            surface: "harness",
            tool: "spawn_task",
            status: "completed",
            args: {
              title: "Delete the turn budget reminder",
              objective: "Finish within 10 minutes and keep output at most 2,000 characters.",
              criteria: "No regressions",
            },
            paths: [],
            result: { spawned: "t-4" },
            inScript: false,
          });
        },
      },
      // 6.5 director-self-reading
      {
        name: "D1 user named directory and files",
        run: () => {
          const { engine } = makeEngine();
          const s = buildDirectorSubject({
            sessionId: "d1-named",
            repoRoot: WORKSPACE,
            userMessage: "Check src/a/, src/b/, and c1.ts plus src/c/c2.ts, src/c/c3.ts, src/c/c4.ts",
          });
          const files = [
            "src/a/1.ts", "src/a/2.ts", "src/a/3.ts", "src/a/4.ts",
            "src/b/1.ts", "src/b/2.ts", "src/b/3.ts", "src/b/4.ts",
            "src/c/c1.ts", "src/c/c2.ts", "src/c/c3.ts", "src/c/c4.ts",
          ];
          const all: Notice[] = [];
          for (const f of files) {
            all.push(
              ...engine.observeHarness(s, {
                origin: "result",
                surface: "harness",
                tool: "read_file",
                status: "completed",
                args: { path: f },
                paths: [f],
                result: { content: "ok" },
                inScript: false,
              }),
            );
          }
          return all;
        },
      },
      {
        name: "D1 paging same file, .harness files, and outside workspace files",
        run: () => {
          const { engine } = makeEngine();
          const s = buildDirectorSubject({
            sessionId: "d1-page",
            repoRoot: WORKSPACE,
            userMessage: "Inspect status",
          });
          const all: Notice[] = [];
          for (let i = 0; i < 15; i++) {
            all.push(
              ...engine.observeHarness(s, {
                origin: "result",
                surface: "harness",
                tool: "read_file",
                status: "completed",
                args: { path: "src/a/big.ts", offset: i * 100 },
                paths: ["src/a/big.ts"],
                result: { content: "ok" },
                inScript: false,
              }),
            );
          }
          for (let i = 0; i < 15; i++) {
            const p = i % 2 === 0 ? `.harness/goals/g${i}/plan.md` : `/tmp/ext/dir${i}/file.md`;
            all.push(
              ...engine.observeHarness(s, {
                origin: "result",
                surface: "harness",
                tool: "read_file",
                status: "completed",
                args: { path: p },
                paths: [p],
                result: { content: "ok" },
                inScript: false,
              }),
            );
          }
          return all;
        },
      },
      {
        name: "D1 silent after spawn_task earlier in the turn",
        run: () => {
          const { engine } = makeEngine();
          const s = buildDirectorSubject({
            sessionId: "d1-spawned",
            repoRoot: WORKSPACE,
            userMessage: "Explore codebase",
          });
          const all: Notice[] = [];
          all.push(
            ...engine.observeHarness(s, {
              origin: "result",
              surface: "harness",
              tool: "spawn_task",
              status: "completed",
              args: { title: "Research", objective: "Look up symbols" },
              paths: [],
              result: { spawned: "t-9" },
              inScript: false,
            }),
          );
          for (let i = 0; i < 12; i++) {
            const f = `src/area${i % 4}/f${i}.ts`;
            all.push(
              ...engine.observeHarness(s, {
                origin: "result",
                surface: "harness",
                tool: "read_file",
                status: "completed",
                args: { path: f },
                paths: [f],
                result: { content: "ok" },
                inScript: false,
              }),
            );
          }
          return all;
        },
      },
      // 6.6 status-polling
      {
        name: "P1 silent when results differ",
        run: () => {
          const { engine } = makeEngine();
          const s = buildSubject({
            task: makeTaskRecord({ id: "p1-1", tier: 1, kind: "orchestrator", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          const all: Notice[] = [];
          for (let i = 0; i < 4; i++) {
            all.push(
              ...engine.observeHarness(s, {
                origin: "result",
                surface: "harness",
                tool: "tree_view",
                status: "completed",
                args: {},
                paths: [],
                result: { step: i },
                inScript: false,
              }),
            );
          }
          return all;
        },
      },
      {
        name: "P1 silent on wait_children default interval and goal_wait and interleaved work",
        run: () => {
          const { engine } = makeEngine();
          const dir = buildDirectorSubject({ sessionId: "p1-dir", repoRoot: WORKSPACE, userMessage: "Wait" });
          const all: Notice[] = [];
          for (let i = 0; i < 4; i++) {
            all.push(
              ...engine.observeHarness(dir, {
                origin: "result",
                surface: "harness",
                tool: "goal_wait",
                status: "completed",
                args: { goal_id: "goal-1" },
                paths: [],
                result: { status: "active" },
                inScript: false,
              }),
            );
          }
          const orch = buildSubject({
            task: makeTaskRecord({ id: "p1-orch", tier: 1, kind: "orchestrator", readOnly: true }),
            workspaceRoot: WORKSPACE,
            writeScopes: [],
            writableExtraRoots: [],
          });
          for (let i = 0; i < 4; i++) {
            all.push(
              ...engine.observeHarness(orch, {
                origin: "result",
                surface: "harness",
                tool: "wait_children",
                status: "completed",
                args: { mode: "any" },
                paths: [],
                result: { children: [], wakeReason: "fallback_interval" },
                inScript: false,
              }),
            );
          }
          for (let i = 0; i < 3; i++) {
            all.push(
              ...engine.observeHarness(orch, {
                origin: "result",
                surface: "harness",
                tool: "tree_view",
                status: "completed",
                args: {},
                paths: [],
                result: { run: { status: "active" } },
                inScript: false,
              }),
            );
            all.push(
              ...engine.observeHarness(orch, {
                origin: "result",
                surface: "harness",
                tool: "blackboard_get",
                status: "completed",
                args: {},
                paths: [],
                result: {},
                inScript: false,
              }),
            );
          }
          return all;
        },
      },
    ];

    for (const tc of cases) {
      assert.deepEqual(tc.run(), [], `expected silence for case: ${tc.name}`);
    }
  });

  it("T3-3: long bounded read is silent", () => {
    const { engine } = makeEngine();

    // (a) 200 distinct files under 2 areas
    const subA = buildSubject({
      task: makeTaskRecord({ id: "t-long-a", tier: 3, kind: "research", readOnly: true }),
      workspaceRoot: WORKSPACE,
      writeScopes: [],
      writableExtraRoots: [],
    });
    for (let i = 0; i < 200; i++) {
      const area = i % 2 === 0 ? "src/alpha" : "src/beta";
      assert.equal(
        engine.observeEvent(subA, {
          id: `a-${i}`,
          name: "read_file",
          kind: "read",
          status: "completed",
          args: JSON.stringify({ path: `${area}/file-${i}.ts` }),
        }),
        false,
      );
    }
    assert.equal(engine.take(subA.id).length, 0);
    assert.equal(engine.activityProgress(subA.id), 200);

    // (b) 300 ranged reads of one file plus 50 searches
    const subB = buildSubject({
      task: makeTaskRecord({ id: "t-long-b", tier: 3, kind: "research", readOnly: true }),
      workspaceRoot: WORKSPACE,
      writeScopes: [],
      writableExtraRoots: [],
    });
    for (let i = 0; i < 300; i++) {
      assert.equal(
        engine.observeEvent(subB, {
          id: `b-r-${i}`,
          name: "read_file",
          kind: "read",
          status: "completed",
          args: JSON.stringify({ path: "src/alpha/huge.ts", offset: i * 100, limit: 100 }),
        }),
        false,
      );
    }
    for (let i = 0; i < 50; i++) {
      assert.equal(
        engine.observeEvent(subB, {
          id: `b-s-${i}`,
          name: "grep",
          kind: "search",
          status: "completed",
          args: JSON.stringify({ path: "src/alpha/huge.ts", pattern: `sym_${i}` }),
        }),
        false,
      );
    }
    assert.equal(engine.take(subB.id).length, 0);
    assert.equal(engine.activityProgress(subB.id), 1);

    // (c) a worker reading 500 in-scope files
    const subC = buildSubject({
      task: makeTaskRecord({ id: "t-long-c", tier: 2, kind: "worker", readOnly: false }),
      workspaceRoot: WORKSPACE,
      writeScopes: ["src/alpha/"],
      writableExtraRoots: [],
    });
    for (let i = 0; i < 500; i++) {
      assert.equal(
        engine.observeEvent(subC, {
          id: `c-${i}`,
          name: "read_file",
          kind: "read",
          status: "completed",
          args: JSON.stringify({ path: `src/alpha/f${i}.ts` }),
        }),
        false,
      );
    }
    assert.equal(engine.take(subC.id).length, 0);
  });

  it("T3-4: dedupe", () => {
    // (a) same out-of-scope path edited 20 times -> 1 notice
    {
      const { engine } = makeEngine();
      const s = buildSubject({
        task: makeTaskRecord({ id: "d-a", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/a/"],
        writableExtraRoots: [],
      });
      for (let i = 0; i < 20; i++) {
        engine.observeEvent(s, {
          id: `e-${i}`,
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: "src/b/same.ts" }),
        });
      }
      assert.equal(engine.take(s.id).length, 1);
    }

    // (b) 5 distinct out-of-scope paths -> 3 notices
    {
      const { engine } = makeEngine();
      const s = buildSubject({
        task: makeTaskRecord({ id: "d-b", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/a/"],
        writableExtraRoots: [],
      });
      for (let i = 0; i < 5; i++) {
        engine.observeEvent(s, {
          id: `e-${i}`,
          name: "edit_file",
          kind: "edit",
          status: "completed",
          args: JSON.stringify({ path: `src/b/file-${i}.ts` }),
        });
      }
      assert.equal(engine.take(s.id).length, 3);
    }

    // (c) scope finding held for 20 events with marks unchanged, then areas +6 -> 1, then 2nd, never 3rd
    {
      let areas = 8;
      let scoredCalls = 12;
      const scopeSource = createFakeScopeSource({
        evaluate: () => ({
          widening: {
            areas: Array.from({ length: areas }, (_, i) => `src/a${i}`),
            topics: ["t1", "t2", "t3", "t4"],
          },
        }),
        marks: () => ({ areas, scoredCalls }),
      });
      const { engine } = makeEngine({ createScopeSource: () => scopeSource });
      const s = buildSubject({
        task: makeTaskRecord({ id: "d-c", tier: 3, kind: "research", readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });

      for (let i = 0; i < 20; i++) {
        engine.observeEvent(s, { id: `r-${i}`, name: "read", kind: "read", status: "completed" });
      }
      assert.equal(engine.take(s.id).length, 1);

      // areas +6 -> 2nd notice
      areas += 6;
      scoredCalls += 6;
      engine.observeEvent(s, { id: "r-20", name: "read", kind: "read", status: "completed" });
      assert.equal(engine.take(s.id).length, 1);

      // areas +6 again -> never a 3rd in the same generation
      areas += 6;
      scoredCalls += 6;
      engine.observeEvent(s, { id: "r-21", name: "read", kind: "read", status: "completed" });
      assert.equal(engine.take(s.id).length, 0);
    }

    // (d) generationEnded then the same W1 path -> none
    {
      const { engine } = makeEngine();
      const s = buildSubject({
        task: makeTaskRecord({ id: "d-d", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/a/"],
        writableExtraRoots: [],
      });
      engine.observeEvent(s, {
        id: "e-1",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ path: "src/b/x.ts" }),
      });
      assert.equal(engine.take(s.id).length, 1);

      engine.generationEnded(s.id);
      engine.observeEvent(s, {
        id: "e-2",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ path: "src/b/x.ts" }),
      });
      assert.equal(engine.take(s.id).length, 0);
    }

    // (e) new engine with firedBefore returning the W1 key -> none
    {
      const { engine } = makeEngine({
        firedBefore: () => [{ rule: "worker-edit-outside-scope", key: "src/b/x.ts" }],
      });
      const s = buildSubject({
        task: makeTaskRecord({ id: "d-e", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/a/"],
        writableExtraRoots: [],
      });
      engine.observeEvent(s, {
        id: "e-1",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ path: "src/b/x.ts" }),
      });
      assert.equal(engine.take(s.id).length, 0);
    }
  });

  it("T3-5: count-only guard", () => {
    const forbiddenFields = ["turnsUsed", "contextUsed", "contextSize", "maxTurns", "generation"];
    const eventCounts = [10, 100, 1000, 5000];
    const countCombos = [
      { turnsUsed: 0, contextUsed: 0, contextSize: 200_000, maxTurns: 10, generation: 1 },
      { turnsUsed: 999, contextUsed: 199_999, contextSize: 200_000, maxTurns: 5, generation: 42 },
    ];

    for (const combo of countCombos) {
      const task = makeTaskRecord({ id: `t-guard-${combo.generation}`, tier: 3, kind: "research", ...combo });
      const subject = buildSubject({
        task,
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });
      const keys = Object.keys(subject);
      for (const field of forbiddenFields) {
        assert.equal(keys.includes(field), false, `Subject must not expose ${field}`);
      }

      for (const total of eventCounts) {
        const { engine } = makeEngine();
        for (let i = 0; i < total; i++) {
          assert.equal(
            engine.observeEvent(subject, {
              id: `ev-${i}`,
              name: "other_tool",
              status: "completed",
            }),
            false,
          );
        }
        assert.equal(engine.take(subject.id).length, 0);
      }
    }
  });

  it("T3-6: priority, no cap", () => {
    const { engine } = makeEngine();
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-prio", tier: 2, kind: "worker", readOnly: false }),
      workspaceRoot: WORKSPACE,
      writeScopes: ["src/a/"],
      writableExtraRoots: [],
    });

    // Queue W1 (priority 100) via event
    assert.equal(
      engine.observeEvent(subject, {
        id: "e-1",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ path: "src/b/other.ts" }),
      }),
      true,
    );

    // Queue status-polling (priority 20) via inScript calls so notices stay queued
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(
        engine.observeHarness(subject, {
          origin: "result",
          surface: "harness",
          tool: "tree_view",
          status: "completed",
          args: {},
          paths: [],
          result: { status: "running", updatedAt: i },
          inScript: true,
        }),
        [],
      );
    }

    // Trigger S1 (priority 60) on a top-level observeHarness call
    const notices = engine.observeHarness(subject, {
      origin: "result",
      surface: "harness",
      tool: "spawn_task",
      status: "completed",
      args: { title: "Scout", objective: "Use at most 40 tool calls to inspect auth.", criteria: "" },
      paths: [],
      result: { spawned: "t-child-1" },
      inScript: false,
    });

    assert.equal(notices.length, 3);
    assert.deepEqual(
      notices.map((n) => n.rule),
      ["worker-edit-outside-scope", "brief-count-limit", "status-polling"],
    );
  });

  it("T3-7: executor delivery", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "pi-harness-adv-exec-"));
    const db = new ControlPlaneDb(":memory:");
    try {
      const run = db.createRun({
        goal: "Test executor",
        repoRoot: tmpDir,
        baseBranch: "main",
        baseSha: "0000000000000000000000000000000000000000",
      });
      const orchTask = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        readOnly: true,
        profileId: "pi-default",
      });
      const doneReviewTask = db.createTask({
        runId: run.id,
        parentId: orchTask.id,
        tier: 3,
        kind: "verify",
        title: "Done-Review: goal-1",
        objective: "Verify",
        readOnly: true,
        profileId: "pi-default",
      });
      const dirRun = db.createRun({
        id: "director-tasks-chat-1",
        goal: "Director bucket",
        repoRoot: tmpDir,
        baseBranch: "main",
        baseSha: "0000000000000000000000000000000000000000",
      });
      const dirOwner = db.createTask({
        runId: dirRun.id,
        tier: 1,
        kind: "orchestrator",
        title: "Director owner",
        objective: "Own delegated tasks",
        readOnly: true,
        profileId: "director",
      });

      let ruleCalls = 0;
      const alwaysFireRule: AdvisoryRule<null> = {
        id: "stub-always",
        roles: ["orchestrator", "worker", "research", "plan", "verify", "execute", "director", "reviewer"],
        surface: "result",
        priority: 50,
        init: () => null,
        observe(_state, _subject, call) {
          ruleCalls += 1;
          if (call.status !== "completed") return null;
          return {
            key: `k-${ruleCalls}`,
            what: `Observed ${call.tool}.`,
            why: "Stub rule fired for test.",
            alternative: "Continue.",
          };
        },
        dedupe: { perKey: "generation" },
      };

      const records: AdvisoryRecord[] = [];
      const { engine } = makeEngine({ rules: [alwaysFireRule], records });
      const abort = new AbortController();
      let arrayHookCalls = 0;

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
        forceStartWorker: async () => {
          arrayHookCalls += 1;
          return ["w-1", "w-2"];
        },
        getTaskSignal: () => abort.signal,
      };

      const baseConfig = loadConfig(tmpDir);
      const config = { ...baseConfig, stateDir: join(tmpDir, "state"), codeMode: "hybrid" as const };
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

      // (a) object result
      const objRes = (await executor.execute(run.id, orchTask.id, "list_timers", {})) as Record<string, unknown>;
      assert.ok(Array.isArray(objRes.timers));
      assert.ok(Array.isArray(objRes.harness_advisory));
      assert.equal((objRes.harness_advisory as string[]).length, 1);
      assert.ok((objRes.harness_advisory as string[])[0]!.startsWith("[harness advisory: stub-always]"));

      // (b) array result: unchanged, notice arrives on the next object result
      const arrRes = await executor.execute(run.id, orchTask.id, "queue_force_start", { target_id: "t-99" });
      assert.equal(arrayHookCalls, 1);
      assert.deepEqual(arrRes, ["w-1", "w-2"]);
      assert.equal((arrRes as unknown as Record<string, unknown>).harness_advisory, undefined);

      const nextObj = (await executor.execute(run.id, orchTask.id, "list_timers", {})) as Record<string, unknown>;
      assert.ok(Array.isArray(nextObj.harness_advisory));
      assert.equal((nextObj.harness_advisory as string[]).length, 2);

      // (c) inner script call then outer code_exec
      const innerAbort = new AbortController();
      const innerRes = (await executor.execute(
        run.id,
        orchTask.id,
        "list_timers",
        {},
        innerAbort.signal,
      )) as Record<string, unknown>;
      assert.ok(Array.isArray(innerRes.timers));
      assert.equal(innerRes.harness_advisory, undefined);

      if (effectiveCodeMode("hybrid") === "hybrid") {
        const codeRes = (await executor.execute(run.id, orchTask.id, "code_exec", {
          code: `import { list_timers, output } from "harness"; const r = await list_timers({}); output(r);`,
        })) as Record<string, unknown>;
        assert.ok(Array.isArray(codeRes.harness_advisory));
        assert.ok((codeRes.harness_advisory as string[]).length >= 2);
      } else {
        // Fallback if OS sandbox is unavailable: verify the queued notice from innerRes delivers on next top-level call
        const drained = (await executor.execute(run.id, orchTask.id, "list_timers", {})) as Record<string, unknown>;
        assert.ok(Array.isArray(drained.harness_advisory));
        assert.equal((drained.harness_advisory as string[]).length, 2);
      }

      // (d) tool that throws: same error rethrown, notice stays queued
      const queuedNotice: Notice = {
        level: "advisory",
        rule: "queued-check",
        what: "Queued before error.",
        why: "Testing error path.",
        alternative: "Retry later.",
      };
      engine.post(
        buildSubject({ task: orchTask, workspaceRoot: tmpDir, writeScopes: [], writableExtraRoots: [] }),
        queuedNotice,
        { key: "pre-err", lifetime: "subject" },
      );
      await assert.rejects(
        () => executor.execute(run.id, orchTask.id, "task_get", { task_id: "t-missing" }),
        /Unknown task t-missing/,
      );
      const stillQueued = engine.take(orchTask.id);
      assert.equal(stillQueued.length, 1);
      assert.equal(stillQueued[0]!.rule, "queued-check");

      // (e) synthetic Director owner: engine not called, tool runs
      const callsBeforeSkip = ruleCalls;
      const dirRes = (await executor.execute(dirRun.id, dirOwner.id, "list_timers", {})) as Record<string, unknown>;
      assert.ok(Array.isArray(dirRes.timers));
      assert.equal(dirRes.harness_advisory, undefined);
      assert.equal(ruleCalls, callsBeforeSkip);

      // (f) Done-Review task: engine not called, tool runs
      const revRes = (await executor.execute(run.id, doneReviewTask.id, "artifact_read", {})) as Record<string, unknown>;
      assert.ok(Array.isArray(revRes.artifacts));
      assert.equal(revRes.harness_advisory, undefined);
      assert.equal(ruleCalls, callsBeforeSkip);
    } finally {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("T3-11: recorded native sequences (N2)", () => {
    const parser = new NativeEventParser({ workspaceRoot: WORKSPACE, harnessToolNames: HARNESS_TOOLS });

    // (a) ACP tool_call pending with rawInput { file_path } and kind "edit", then completed with neither
    assert.equal(
      parser.push({
        id: "acp-1",
        name: "Edit",
        kind: "edit",
        status: "pending",
        args: JSON.stringify({ file_path: join(WORKSPACE, "src/b/target.ts") }),
      }),
      null,
    );
    const mergedA = parser.push({
      id: "acp-1",
      name: "Edit",
      status: "completed",
    });
    assert.ok(mergedA);
    assert.equal(mergedA.nativeClass, "edit");
    assert.deepEqual(mergedA.paths, ["src/b/target.ts"]);

    // (b) Amp edit_file and create_file titles with path args and no kind
    const mergedEdit = parser.push({
      id: "amp-1",
      name: "edit_file",
      title: "edit_file",
      status: "completed",
      args: JSON.stringify({ path: "src/foo.ts" }),
    });
    assert.ok(mergedEdit);
    assert.equal(mergedEdit.nativeClass, "edit");
    assert.deepEqual(mergedEdit.paths, ["src/foo.ts"]);

    const mergedCreate = parser.push({
      id: "amp-2",
      name: "create_file",
      title: "create_file",
      status: "completed",
      args: JSON.stringify({ path: "src/bar.ts" }),
    });
    assert.ok(mergedCreate);
    assert.equal(mergedCreate.nativeClass, "edit");
    assert.deepEqual(mergedCreate.paths, ["src/bar.ts"]);

    // (c) Codex apply_patch touching two files: once with paths from locations + preview cut at 512 chars, once patch text only
    const longPatch =
      "*** Begin Patch\n" +
      "*** Update File: src/first.ts\n" +
      "@@ -1,3 +1,3 @@\n" +
      `+${"x".repeat(500)}\n` +
      "*** Update File: src/second.ts\n" +
      "@@ -1,1 +1,1 @@\n+y\n*** End Patch";
    const truncatedPreview = JSON.stringify({ input: longPatch }).slice(0, 512);

    assert.equal(
      parser.push({
        id: "codex-1",
        name: "apply_patch",
        status: "in_progress",
        args: truncatedPreview,
        paths: [join(WORKSPACE, "src/first.ts"), join(WORKSPACE, "src/second.ts")],
      }),
      null,
    );
    const mergedCodexLoc = parser.push({
      id: "codex-1",
      name: "apply_patch",
      status: "completed",
    });
    assert.ok(mergedCodexLoc);
    assert.equal(mergedCodexLoc.nativeClass, "edit");
    assert.deepEqual(mergedCodexLoc.paths, ["src/first.ts", "src/second.ts"]);

    const mergedCodexPatchOnly = parser.push({
      id: "codex-2",
      name: "apply_patch",
      status: "completed",
      args: truncatedPreview,
    });
    assert.ok(mergedCodexPatchOnly);
    assert.equal(mergedCodexPatchOnly.nativeClass, "edit");
    assert.ok(mergedCodexPatchOnly.paths.includes("src/first.ts"));

    // (d) completed event with no id is parsed by itself
    const mergedNoId = parser.push({
      name: "read_file",
      kind: "read",
      status: "completed",
      args: JSON.stringify({ path: "src/solo.ts" }),
    });
    assert.ok(mergedNoId);
    assert.equal(mergedNoId.nativeClass, "read");
    assert.deepEqual(mergedNoId.paths, ["src/solo.ts"]);
  });

  it("T3-12: harness filter (NB2)", () => {
    const { engine } = makeEngine();
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-filter", tier: 2, kind: "worker", readOnly: false }),
      workspaceRoot: WORKSPACE,
      writeScopes: ["src/a/"],
      writableExtraRoots: [],
    });

    const nonNativeEvents = [
      { id: "h-1", name: "mcp__harness__task_get", kind: "edit", status: "completed", args: JSON.stringify({ path: "src/b/1.ts" }) },
      { id: "h-2", name: "mcp_harness_task_get", kind: "edit", status: "completed", args: JSON.stringify({ path: "src/b/2.ts" }) },
      { id: "h-3", name: "harness/task_get", kind: "edit", status: "completed", args: JSON.stringify({ path: "src/b/3.ts" }) },
      { id: "h-4", name: "harness.task_get", kind: "edit", status: "completed", args: JSON.stringify({ path: "src/b/4.ts" }) },
      { id: "h-5", name: "harness:task_get", kind: "edit", status: "completed", args: JSON.stringify({ path: "src/b/5.ts" }) },
      { id: "h-6", name: "task_get", kind: "edit", status: "completed", args: JSON.stringify({ path: "src/b/6.ts" }) },
      {
        id: "h-7",
        name: "mcp_call",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ server: "harness", tool: "task_get", path: "src/b/7.ts" }),
      },
      {
        id: "h-8",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        via: "code_exec" as const,
        args: JSON.stringify({ path: "src/b/8.ts" }),
      },
    ];

    for (const ev of nonNativeEvents) {
      assert.equal(engine.observeEvent(subject, ev), false, `expected non-native: ${ev.name}`);
    }
    assert.equal(engine.take(subject.id).length, 0);
    assert.equal(engine.activityProgress(subject.id), 0);

    // 9th event: "Read src/harness/x.ts" IS native and adds activity
    engine.observeEvent(subject, {
      id: "n-1",
      name: "Read src/harness/x.ts",
      title: "Read src/harness/x.ts",
      status: "completed",
      args: JSON.stringify({ path: "src/harness/x.ts" }),
    });
    assert.equal(engine.activityProgress(subject.id), 1);
  });

  it("T3-13: generation-lifetime notices", () => {
    const { engine, records } = makeEngine({
      createScopeSource: () =>
        createFakeScopeSource({
          evaluate: () => ({ repeated: { tool: "read", times: 3 } }),
          marks: () => ({ areas: 2, scoredCalls: 3 }),
        }),
    });
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-gen", tier: 3, kind: "execute", readOnly: false }),
      workspaceRoot: WORKSPACE,
      writeScopes: ["src/a/"],
      writableExtraRoots: [],
    });

    // Trigger both scope-too-large (generation lifetime) and W1 (subject lifetime)
    engine.observeEvent(subject, {
      id: "e-1",
      name: "edit_file",
      kind: "edit",
      status: "completed",
      args: JSON.stringify({ path: "src/b/out.ts" }),
    });

    engine.generationEnded(subject.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.notice.rule, "scope-too-large");
    assert.equal(records[0]!.delivery, "dropped");

    // W1 is still pending until settle
    engine.settle(subject.id);
    assert.equal(records.length, 2);
    assert.equal(records[1]!.notice.rule, "worker-edit-outside-scope");
    assert.equal(records[1]!.delivery, "dropped");
  });

  it("T-act: activity counts paths only", () => {
    const { engine } = makeEngine();
    const subject = buildSubject({
      task: makeTaskRecord({ id: "t-act", tier: 3, kind: "research", readOnly: true }),
      workspaceRoot: WORKSPACE,
      writeScopes: [],
      writableExtraRoots: [],
    });

    // 3 files read with 40 different ranges
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    for (let i = 0; i < 40; i++) {
      engine.observeEvent(subject, {
        id: `r-${i}`,
        name: "read_file",
        kind: "read",
        status: "completed",
        args: JSON.stringify({ path: files[i % 3], offset: i * 50, limit: 50 }),
      });
    }

    // 10 searches with different queries in one directory
    for (let i = 0; i < 10; i++) {
      engine.observeEvent(subject, {
        id: `s-${i}`,
        name: "grep",
        kind: "search",
        status: "completed",
        args: JSON.stringify({ path: "src/sub", pattern: `query_${i}` }),
      });
    }

    // 5 shell events
    for (let i = 0; i < 5; i++) {
      engine.observeEvent(subject, {
        id: `sh-${i}`,
        name: "bash",
        kind: "execute",
        status: "completed",
        args: JSON.stringify({ command: `ls src/d${i}`, path: `src/d${i}/ignored.ts` }),
      });
    }

    // Paths under .harness/ and outside workspace add nothing
    engine.observeEvent(subject, {
      id: "h-1",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: JSON.stringify({ path: ".harness/artifacts/run-1/dossier.md" }),
    });
    engine.observeEvent(subject, {
      id: "ext-1",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: JSON.stringify({ path: "/etc/hosts" }),
    });
    engine.observeEvent(subject, {
      id: "root-1",
      name: "read_file",
      kind: "read",
      status: "completed",
      args: JSON.stringify({ path: "." }),
    });

    assert.equal(engine.activityProgress(subject.id), 4);
  });

  it("T6-3: rules in one place", () => {
    assert.deepEqual(
      ALL_RULES.map((r) => r.id),
      [
        "worker-edit-outside-scope",
        "scope-too-large",
        "read-only-finding-escalation",
        "brief-count-limit",
        "director-self-reading",
        "status-polling",
      ],
    );

    const protoMethods = Object.getOwnPropertyNames(AdvisoryEngine.prototype);
    for (const name of protoMethods) {
      assert.equal(/addRule|registerRule|pushRule/i.test(name), false, `Unexpected rule-mutating method: ${name}`);
    }
  });

  it("T-budget: word budget and format for every rule template and rejection builder", () => {
    const advisoryFormat = /^\[harness advisory: [\w-]+\] .+ Why: .+ Instead: .+$/;
    const rejectionFormat = /^\[harness blocked: [\w-]+\] .+ Why: .+ Allowed: .+$/;

    const checkNotice = (label: string, notice: Notice) => {
      const words = countWords(notice);
      assert.ok(words <= WORD_BUDGET, `${label} exceeded ${WORD_BUDGET} words (got ${words}): ${formatNotice(notice)}`);
      const formatted = formatNotice(notice);
      const pattern = notice.level === "rejection" ? rejectionFormat : advisoryFormat;
      assert.match(formatted, pattern, `${label} failed tag format: ${formatted}`);
    };

    // 1. worker-edit-outside-scope
    {
      const { engine } = makeEngine();
      const s = buildSubject({
        task: makeTaskRecord({ id: "b-w1", tier: 2, kind: "worker", readOnly: false }),
        workspaceRoot: WORKSPACE,
        writeScopes: ["src/control-plane/", "src/worktree/", "src/runners/", "src/director/"],
        writableExtraRoots: [],
      });
      engine.observeEvent(s, {
        id: "1",
        name: "edit_file",
        kind: "edit",
        status: "completed",
        args: JSON.stringify({ path: "src/advisories/engine.ts" }),
      });
      const [n] = engine.take(s.id);
      assert.ok(n);
      checkNotice("worker-edit-outside-scope", n);
    }

    // 2. scope-too-large (widening, repeated, stale, widening+repeated, widening+stale, repeated+stale)
    const scopeFindings: Array<[string, ScopeFinding]> = [
      [
        "scope-too-large widening",
        {
          widening: {
            areas: ["src/control-plane", "src/runners", "src/worktree", "src/director", "src/goals", "src/code-mode", "src/daemon", "src/cli"],
            topics: ["authToken", "mergeQueue", "scopeNudge", "toolRegistry"],
          },
        },
      ],
      ["scope-too-large repeated", { repeated: { tool: "inspect_command", times: 5 } }],
      ["scope-too-large stale", { stale: { reads: 12 } }],
      [
        "scope-too-large widening+repeated",
        {
          widening: {
            areas: ["src/control-plane", "src/runners", "src/worktree", "src/director", "src/goals", "src/code-mode", "src/daemon", "src/cli"],
            topics: ["authToken", "mergeQueue", "scopeNudge", "toolRegistry"],
          },
          repeated: { tool: "inspect_command", times: 5 },
        },
      ],
      [
        "scope-too-large widening+stale",
        {
          widening: {
            areas: ["src/control-plane", "src/runners", "src/worktree", "src/director", "src/goals", "src/code-mode", "src/daemon", "src/cli"],
            topics: ["authToken", "mergeQueue", "scopeNudge", "toolRegistry"],
          },
          stale: { reads: 12 },
        },
      ],
      [
        "scope-too-large repeated+stale",
        {
          repeated: { tool: "inspect_command", times: 5 },
          stale: { reads: 12 },
        },
      ],
    ];
    for (const [label, finding] of scopeFindings) {
      const { engine } = makeEngine({ createScopeSource: () => createFakeScopeSource({ evaluate: () => finding }) });
      const s = buildSubject({
        task: makeTaskRecord({ id: `b-${label}`, tier: 3, kind: "research", readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });
      engine.observeEvent(s, { id: "1", name: "read", kind: "read", status: "completed" });
      const [n] = engine.take(s.id);
      assert.ok(n, `expected notice for ${label}`);
      checkNotice(label, n);
    }

    // 3. read-only-finding-escalation
    {
      const { engine } = makeEngine();
      const s = buildSubject({
        task: makeTaskRecord({ id: "b-ro", tier: 3, kind: "verify", readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });
      const [n] = engine.observeHarness(s, {
        origin: "result",
        surface: "harness",
        tool: "report_issue",
        status: "completed",
        args: { category: "verification_failed" },
        paths: [],
        result: { escalationId: "esc-123", blocking: false },
        inScript: false,
      });
      assert.ok(n);
      checkNotice("read-only-finding-escalation", n);
    }

    // 4. brief-count-limit
    {
      const { engine } = makeEngine();
      const s = buildSubject({
        task: makeTaskRecord({ id: "b-s1", tier: 1, kind: "orchestrator", readOnly: true }),
        workspaceRoot: WORKSPACE,
        writeScopes: [],
        writableExtraRoots: [],
      });
      const [n] = engine.observeHarness(s, {
        origin: "result",
        surface: "harness",
        tool: "spawn_task",
        status: "completed",
        args: {
          title: "Investigate",
          objective: "Stop reading repository files and wrap up before 50 tool calls.",
          criteria: "",
        },
        paths: [],
        result: { spawned: "t-142" },
        inScript: false,
      });
      assert.ok(n);
      checkNotice("brief-count-limit", n);
    }

    // 5. director-self-reading
    {
      const { engine } = makeEngine();
      const s = buildDirectorSubject({ sessionId: "b-d1", repoRoot: WORKSPACE, userMessage: "Explain the system" });
      let fired: Notice | undefined;
      for (let i = 0; i < 12; i++) {
        const p = `src/mod${i % 4}/file${i}.ts`;
        const out = engine.observeHarness(s, {
          origin: "result",
          surface: "harness",
          tool: "read_file",
          status: "completed",
          args: { path: p },
          paths: [p],
          result: { content: "ok" },
          inScript: false,
        });
        if (out[0]) fired = out[0];
      }
      assert.ok(fired);
      checkNotice("director-self-reading", fired);
    }

    // 6. status-polling (task role and director)
    for (const [label, subject] of [
      [
        "status-polling task",
        buildSubject({
          task: makeTaskRecord({ id: "b-p1-t", tier: 1, kind: "orchestrator", readOnly: true }),
          workspaceRoot: WORKSPACE,
          writeScopes: [],
          writableExtraRoots: [],
        }),
      ],
      [
        "status-polling director",
        buildDirectorSubject({ sessionId: "b-p1-d", repoRoot: WORKSPACE, userMessage: "Check status" }),
      ],
    ] as const) {
      const { engine } = makeEngine();
      let fired: Notice | undefined;
      for (let i = 0; i < 3; i++) {
        const out = engine.observeHarness(subject, {
          origin: "result",
          surface: "harness",
          tool: "tree_view",
          status: "completed",
          args: {},
          paths: [],
          result: { tasks: [] },
          inScript: false,
        });
        if (out[0]) fired = out[0];
      }
      assert.ok(fired);
      checkNotice(label, fired);
    }

    // 7. context-rollover (tier 1/2 and tier 3)
    checkNotice("context-rollover tier 1", contextWarningNotice(1, 72, 80));
    checkNotice("context-rollover tier 2", contextWarningNotice(2, 72, 80));
    checkNotice("context-rollover tier 3", contextWarningNotice(3, 72, 80));

    // 8. Every catalog builder in REJECTIONS (all 27 rows of section 6.9)
    const rejectionSamples: Array<[string, Notice]> = [
      ["not-your-tool default", REJECTIONS.notYourTool("spawn_worker", "research").notice],
      [
        "not-your-tool with whenDenied",
        REJECTIONS.notYourTool("spawn_worker", "research", {
          why: "Spawning is reserved for orchestrators and Workers, which hold the leases for child work.",
          alternative: "Describe the follow-up you need in return_task. Your parent decides whether to start it.",
        }).notice,
      ],
      ["spawn-execute-needs-worker", REJECTIONS.spawnExecuteNeedsWorker().notice],
      ["write-scopes-required", REJECTIONS.writeScopesRequired().notice],
      ["write-scopes-blanket", REJECTIONS.writeScopesBlanket(["**", "*"], "main").notice],
      ["draining", REJECTIONS.draining("spawn_worker").notice],
      ["settlement-live-children", REJECTIONS.settlementLiveChildren(["t-10", "t-11", "t-12"]).notice],
      ["settlement-dirty-worktree", REJECTIONS.settlementDirtyWorktree().notice],
      ["settlement-unmerged", REJECTIONS.settlementUnmerged("branch has 3 unmerged commits ahead of target", "main").notice],
      ["handoff-sources", REJECTIONS.handoffSources("verify").notice],
      ["escalation-evidence", REJECTIONS.escalationEvidence("report_issue").notice],
      ["read-only-argv", REJECTIONS.readOnlyArgv("rm", "binary is not on the read-only inspection allowlist").notice],
      ["read-only-shell", REJECTIONS.readOnlyShell("git reset --hard HEAD~1 && rm -rf dist").notice],
      ["read-only-write", REJECTIONS.readOnlyWrite("src/control-plane/orchestrator.ts").notice],
      ["protected-path", REJECTIONS.protectedPath(".git/HEAD", "/repo/worktrees/run-9/t-140").notice],
      ["outside-roots", REJECTIONS.outsideRoots("/etc/passwd", "/repo/worktrees/run-9/t-140").notice],
      ["read-only-mcp", REJECTIONS.readOnlyMcp("github", "create_pull_request").notice],
      ["tool-policy", REJECTIONS.toolPolicy("Bash", "read_only_workspace").notice],
      [
        "write-scope-merge",
        REJECTIONS.writeScopeMerge(
          ["src/control-plane/tools.ts", "src/runners/acp-runner.ts", "src/director/runtime.ts", "src/config.ts"],
          ["src/advisories/", "test/advisories.test.ts"],
        ).notice,
      ],
      ["peer-round-cap", REJECTIONS.peerRoundCap("api-schema-v2", 6, "run-8").notice],
      ["submit-dirty-worktree", REJECTIONS.submitDirtyWorktree().notice],
      ["artifact-outside-workspace", REJECTIONS.artifactOutsideWorkspace("/tmp/outside.md").notice],
      ["inspect-cwd", REJECTIONS.inspectCwd("../other-worktree").notice],
      ["director-protected-read", REJECTIONS.directorProtectedRead(".git/config").notice],
      ["director-note-root", REJECTIONS.directorNoteRoot("src/index.ts").notice],
      ["code-exec-timeout", REJECTIONS.codeExecTimeout(60, 180).notice],
      ["code-exec-ipc", REJECTIONS.codeExecIpc().notice],
      ["python-packages", REJECTIONS.pythonPackages(33).notice],
    ];

    assert.equal(Object.keys(REJECTIONS).length, 27);
    for (const [label, notice] of rejectionSamples) {
      checkNotice(`REJECTIONS.${label}`, notice);
    }

    // 9. deniedNotice variants
    for (const id of ["read-only-shell", "read-only-write", "protected-path", "outside-roots", "read-only-mcp", "unknown-id"]) {
      checkNotice(
        `deniedNotice:${id}`,
        deniedNotice({ denied: id, name: "Bash", args: { command: "rm -rf /tmp/x" }, paths: ["src/x.ts"] }, { workspaceRoot: WORKSPACE }),
      );
    }
  });
});
