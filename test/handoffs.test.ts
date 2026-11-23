import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { QuotaClient } from "../src/quota/client.js";

it("requires structured sources for read-only handoffs and externalizes only oversized summaries", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-handoff-"));
  const db = new ControlPlaneDb(":memory:");
  try {
    const config = { ...loadConfig(repoRoot), stateDir: repoRoot };
    const quota = new QuotaClient();
    const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota);
    const run = db.createRun({ goal: "Handoffs", repoRoot, baseBranch: "main", baseSha: "abc" });
    const parent = db.createTask({
      runId: run.id, tier: 1, kind: "orchestrator", title: "Parent", objective: "Coordinate", profileId: "acp:codex",
    });
    const sources = [{ path: "src/catalog/compiler.ts", lines: "209-244", symbol: "getCatalog", note: "Quota filter" }];
    const providedPath = ".harness/artifacts/notes.md";
    const longSummary = "x".repeat(2000) + "\nFull findings that do not fit in the handoff.";
    const children = [];
    for (const kind of ["research", "plan", "verify"] as const) {
      const child = db.createTask({
        runId: run.id, parentId: parent.id, tier: 3, kind, title: kind, objective: "Investigate", profileId: "acp:codex",
      });
      const summary = kind === "research" ? longSummary : "y".repeat(2000);
      const returnTask = (extra: Record<string, unknown>) =>
        orch.toolExecutor.execute(run.id, child.id, "return_task", { status: "completed", summary, ...extra });

      await assert.rejects(() => returnTask({}), new RegExp(`non-empty sources array for ${kind}`));
      await assert.rejects(() => returnTask({ sources: [] }), /non-empty sources/);
      await assert.rejects(() => returnTask({ sources: [{ lines: "1-2" }] }), /non-empty path/);
      assert.equal(db.getTask(child.id)?.status, "ready");
      assert.deepEqual(db.listArtifacts(run.id, child.id), []);

      await returnTask({ sources, artifact_paths: [providedPath] });
      const persisted = db.getTask(child.id)!;
      const result = JSON.parse(persisted.resultJson!);
      assert.equal(persisted.status, "completed");
      assert.equal(result.summary, persisted.summary);
      assert.deepEqual(result.sources, sources);
      const paths = [providedPath];
      let overflowMeta: Record<string, unknown> = {};
      if (kind === "research") {
        const [artifact] = db.listArtifacts(run.id, child.id);
        assert.ok(artifact);
        assert.match(artifact.path, /\.harness\/artifacts\/t-[\w]+-summary-.*\.md$/);
        paths.push(artifact.path);
        const pointer = relative(repoRoot, artifact.path);
        assert.ok(persisted.summary!.length <= 2000);
        assert.ok(persisted.summary!.endsWith(`[Full summary: ${pointer}]`));
        assert.deepEqual(await orch.toolExecutor.execute(run.id, parent.id, "artifact_read", { path: pointer }), {
          path: artifact.path, truncated: false, content: longSummary,
        });
        const keptChars = persisted.summary!.slice(0, persisted.summary!.indexOf("\n\n[Full summary: ")).length;
        overflowMeta = {
          truncated: true,
          full_summary: {
            path: artifact.path,
            next_offset: keptChars,
            total_chars: longSummary.length,
            read_with: "artifact_read { path, offset: next_offset, task_id }",
          },
        };
      } else {
        assert.equal(persisted.summary, summary);
        assert.deepEqual(db.listArtifacts(run.id, child.id), []);
      }
      assert.deepEqual(result.artifact_paths, paths);
      // Older or runner-generated result JSON may also contain free-form transcript/log data.
      db.updateTask(child.id, { resultJson: JSON.stringify({ ...result, transcript: "private transcript", tool_logs: "raw logs" }) });
      children.push({
        id: child.id, title: kind, kind, status: "completed", summary: persisted.summary,
        ...overflowMeta, sources, artifact_paths: paths, escalations: [],
      });
    }

    const runnerOnly = db.createTask({
      runId: run.id, parentId: parent.id, tier: 2, kind: "worker", title: "Worker", objective: "Implement", profileId: "acp:codex",
    });
    db.updateTask(runnerOnly.id, {
      status: "completed", summary: "Raw runner output", resultJson: JSON.stringify({ status: "completed", text: "Raw runner output" }),
    });
    children.push({
      id: runnerOnly.id, title: runnerOnly.title, kind: runnerOnly.kind, status: "completed",
      summary: "Task ended without a structured handoff.", sources: [], artifact_paths: [], escalations: [],
    });
    const escalations = [
      db.createEscalation({
        runId: run.id, fromTaskId: children[0]!.id, toTaskId: null, severity: "P0", category: "code_defect",
        title: "Human-routed finding", evidencePaths: ["src/catalog/compiler.ts"], blocking: false,
      }),
      db.createEscalation({
        runId: run.id, fromTaskId: children[1]!.id, toTaskId: parent.id, severity: "P2", category: "code_defect",
        title: "Parent-routed finding", evidencePaths: ["src/catalog/compiler.ts"], blocking: false,
      }),
    ];
    for (const tool of ["wait_children", "wait_tasks"]) {
      const response = await orch.toolExecutor.execute(run.id, parent.id, tool, {}) as { children: Array<{ id: string }> };
      assert.equal(response.children.length, children.length);
      for (const child of children) {
        assert.deepEqual(response.children.find((value) => child.id === value.id), {
          ...child, escalations: escalations.filter((escalation) => escalation.fromTaskId === child.id),
        });
      }
    }

    writeFileSync(join(repoRoot, "source.ts"), "This file is not a dossier");
    await assert.rejects(() => orch.toolExecutor.execute(run.id, parent.id, "artifact_read", { path: "source.ts" }), /No indexed dossier/);
    const link = join(repoRoot, ".harness", "artifacts", "redirect.md");
    symlinkSync(join(repoRoot, "source.ts"), link);
    db.recordArtifact({ runId: run.id, taskId: children[0]!.id, kind: "dossier", path: link, summary: "Redirect" });
    await assert.rejects(() => orch.toolExecutor.execute(run.id, parent.id, "artifact_read", { path: link }), /non-symlink/);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});

it("does not commit a scope send-back when summary overflow fails and records it once on retry", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-handoff-"));
  const db = new ControlPlaneDb(":memory:");
  try {
    const config = { ...loadConfig(repoRoot), stateDir: repoRoot };
    const quota = new QuotaClient();
    const orch = new HarnessOrchestrator(db, config, new ModelCatalogCompiler(config, quota), quota);
    const run = db.createRun({ goal: "Send-back", repoRoot, baseBranch: "main", baseSha: "abc" });
    const parent = db.createTask({
      runId: run.id, tier: 1, kind: "orchestrator", title: "Parent", objective: "Coordinate", profileId: "acp:codex",
    });
    const child = db.createTask({
      runId: run.id, parentId: parent.id, tier: 2, kind: "worker", title: "Worker", objective: "Implement", profileId: "acp:codex",
    });
    const summary = "Oversized send-back summary.\n".repeat(100);
    const returnTask = () => orch.toolExecutor.execute(run.id, child.id, "return_task", {
      status: "scope_too_large", summary, evidence_paths: ["src/control-plane/tools.ts"],
      suggested_splits: ["Split wait output", "Split send-back settlement"],
    });

    mkdirSync(join(repoRoot, ".harness"), { recursive: true });
    const artifactsDir = join(repoRoot, ".harness", "artifacts");
    writeFileSync(artifactsDir, "Block creation of the artifact directory");
    await assert.rejects(returnTask, /EEXIST|ENOTDIR/);
    assert.deepEqual(db.listEscalations(run.id), []);
    assert.deepEqual(db.listArtifacts(run.id, child.id), []);
    assert.deepEqual(db.getTask(child.id), child);

    rmSync(artifactsDir);
    const response = await returnTask();
    const escalations = db.listEscalations(run.id);
    assert.equal(escalations.length, 1);
    const [escalation] = escalations;
    assert.deepEqual(response, { returned: true, status: "returned_for_rescope", escalationId: escalation!.id });
    assert.equal(escalation!.toTaskId, parent.id);
    assert.equal(db.getTask(child.id)?.status, "returned_for_rescope");
    const artifacts = db.listArtifacts(run.id, child.id);
    assert.equal(artifacts.length, 1);
    assert.equal(readFileSync(artifacts[0]!.path, "utf8"), summary);
  } finally {
    db.close();
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
