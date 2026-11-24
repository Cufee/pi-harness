import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { effectiveCodeMode, type CodeExecResult } from "../src/code-mode/index.js";
import { createCodeExecIpcServer } from "../src/code-mode/runner.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator, type CustomRunnerFactory } from "../src/control-plane/orchestrator.js";
import { GoalEngine } from "../src/goals/engine.js";
import { QuotaClient } from "../src/quota/client.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

async function initTempGitRepo(prefix: string): Promise<{ root: string; repoRoot: string; baseSha: string }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const repoRoot = join(root, "repo");
  await runGit(root, ["init", "-b", "main", repoRoot]);
  writeFileSync(join(repoRoot, "README.md"), "# repo\n", "utf8");
  await runGit(repoRoot, ["add", "README.md"]);
  await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
  return { root, repoRoot, baseSha };
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  assert.ok(pred(), `Timed out waiting for ${label}`);
}

interface IpcReply {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: string;
}

function connectIpcClient(socketPath: string): Promise<{
  request: (payload: Record<string, unknown>) => Promise<IpcReply>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath);
    sock.setEncoding("utf8");
    const pending = new Map<number, (reply: IpcReply) => void>();
    let nextId = 0;
    let buf = "";

    sock.once("error", reject);
    sock.once("connect", () => {
      resolve({
        request: (payload) =>
          new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, res);
            sock.write(`${JSON.stringify({ id, ...payload })}\n`, (err) => {
              if (err) {
                pending.delete(id);
                rej(err);
              }
            });
          }),
        close: () => sock.destroy(),
      });
    });

    sock.on("data", (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const msg = JSON.parse(line) as IpcReply;
        const cb = pending.get(msg.id);
        if (cb) {
          pending.delete(msg.id);
          cb(msg);
        }
      }
    });
  });
}

describe("goal-17 Code Mode steer drain and NULL goal_version progress reporting", () => {
  it("drains pending amendment steers and binds goalVersion only at the outer model-visible result, never inside nested code_exec calls (including wait_children)", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g17-cm-steer-");
    const stateDir = join(root, "state");

    const t1Ready = Promise.withResolvers<void>();
    const t1Release = Promise.withResolvers<void>();
    const t2Ready = Promise.withResolvers<void>();
    const t2Release = Promise.withResolvers<void>();

    const runnerFactory: CustomRunnerFactory = () => ({
      run: async (req) => {
        if (req.initialPrompt.includes("CASE_T1_CM")) {
          req.onHandle?.({
            steer: async () => false,
            cancel: async () => {},
          });
          t1Ready.resolve();
          await t1Release.promise;
          return { text: "t1 done", stopReason: "completed" };
        }
        if (req.initialPrompt.includes("CASE_T2_CM")) {
          req.onHandle?.({
            steer: async () => false,
            cancel: async () => {},
          });
          t2Ready.resolve();
          await t2Release.promise;
          return { text: "t2 done", stopReason: "completed" };
        }
        return { text: "ok", stopReason: "completed" };
      },
    });

    const db = new ControlPlaneDb(":memory:");
    const goals = new GoalEngine(db.db);
    const config = withFixtureCatalog({
      ...loadConfig(repoRoot),
      stateDir,
      codeMode: "collapsed",
    });
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const orch = new HarnessOrchestrator(db, config, catalog, quota, runnerFactory);

    const ipcSockets = new Set<Socket>();
    const ipcAbort = new AbortController();
    let ipcServer: ReturnType<typeof createCodeExecIpcServer> | undefined;
    let ipcClient: Awaited<ReturnType<typeof connectIpcClient>> | undefined;

    try {
      const goal = goals.createGoal({
        chatSessionId: "chat-g17-cm",
        repoRoot,
        title: "Goal 17 Code Mode steer",
        description: "v1 contract",
        criteria: [
          { id: "c1", description: "Criterion 1", kind: "behavioral", required: true },
          { id: "c2", description: "Criterion 2", kind: "behavioral", required: true },
        ],
      });
      const run = db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha });
      goals.linkRunAndStart(goal.id, run.id);

      const t1 = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "T1 Code Mode",
        objective: "CASE_T1_CM",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      assert.equal(t1.goalVersion, 1);
      orch.launchTaskLoop(t1.id);
      await t1Ready.promise;

      const t2 = await orch.spawnAndStartTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "T2 Code Mode",
        objective: "CASE_T2_CM",
        readOnly: false,
        writeScopes: ["a.txt"],
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      assert.equal(t2.goalVersion, 1);
      await t2Ready.promise;

      // Amend goal to v2 and queue fallback amendment steers with bind-on-drain for T1 and T2.
      goals.amendGoal(goal.id, {
        rationale: "Scope changed in v2",
        updateCriteria: [{ id: "c1", description: "Criterion 1 (updated in v2)" }],
      });
      const amendMsg = "[GOAL AMENDED: goal-1 v1 -> v2] Scope changed in v2.";

      const t1Steer = await orch.steerTaskDetailed(t1.id, amendMsg);
      assert.equal(t1Steer.steered, true);
      assert.equal(t1Steer.live, false);
      orch.setAmendBindOnDrain(t1.id, 2);

      const t2Steer = await orch.steerTaskDetailed(t2.id, amendMsg);
      assert.equal(t2Steer.steered, true);
      assert.equal(t2Steer.live, false);
      orch.setAmendBindOnDrain(t2.id, 2);

      // Simulate a Code Mode script talking over the real runner IPC server and ignoring every inner result.
      const sockPath = join(root, "cm-ipc.sock");
      let scriptOutput: unknown;
      let stopped = false;
      ipcServer = createCodeExecIpcServer({
        names: new Set(["tree_view", "wait_children", "report_goal_progress"]),
        sockets: ipcSockets,
        isStopped: () => stopped,
        stop: () => {
          stopped = true;
          for (const s of ipcSockets) s.destroy();
        },
        onOutput: (value) => {
          scriptOutput = value;
        },
        onSandboxDenial: () => {},
        onToolCall: () => {},
        callTool: (inner, input, execSignal) => orch.toolExecutor.execute(run.id, t1.id, inner, input, execSignal),
        signal: ipcAbort.signal,
      });
      await new Promise<void>((resolve, reject) => {
        ipcServer!.once("error", reject);
        ipcServer!.listen(sockPath, resolve);
      });
      ipcClient = await connectIpcClient(sockPath);

      // 1. Nested tree_view must NOT drain the queued steer or advance goalVersion.
      const innerTree = await ipcClient.request({ name: "tree_view", args: {} });
      assert.equal(innerTree.ok, true, innerTree.error);
      assert.equal((innerTree.value as Record<string, unknown>).steeringMessages, undefined);
      assert.equal(db.getTask(t1.id)?.goalVersion, 1, "Nested tree_view must not advance goalVersion");

      // 2. Nested wait_children wakes on the queued steer, but must NOT drain it or advance goalVersion.
      const innerWait = await ipcClient.request({ name: "wait_children", args: { timeout_s: 1 } });
      assert.equal(innerWait.ok, true, innerWait.error);
      const waitVal = innerWait.value as Record<string, unknown>;
      assert.equal(waitVal.wakeReason, "steered");
      assert.equal(waitVal.steeringMessages, undefined, "Nested wait_children must not drain pending steers");
      assert.equal(db.getTask(t1.id)?.goalVersion, 1, "Nested wait_children must not advance goalVersion");

      // 3. Nested report_goal_progress in the same script still sees v1 binding (not prematurely bumped to v2).
      const innerProgress = await ipcClient.request({
        name: "report_goal_progress",
        args: {
          summary: "v1 work inside script",
          phase: "completed",
          verification_status: "passed",
          criteria_results: [{ criterion_id: "c1", passed: true, evidence: "checked on v1" }],
        },
      });
      assert.equal(innerProgress.ok, true, innerProgress.error);
      const progVal = innerProgress.value as {
        recorded: boolean;
        dropped?: Array<{ field: string; value: string }>;
        steeringMessages?: string[];
      };
      assert.equal(progVal.steeringMessages, undefined);
      assert.equal(progVal.dropped?.length, 3, "Stale v1 claims inside script must still be dropped before outer delivery");
      assert.equal(db.getTask(t1.id)?.goalVersion, 1);

      // Script ignores all inner results and emits only its own projected output.
      const outAck = await ipcClient.request({ kind: "output", value: { ignored: true } });
      assert.equal(outAck.ok, true);
      assert.deepEqual(scriptOutput, { ignored: true });

      // Nested T2 call with scriptSignal also leaves T2's steer queued and goalVersion at 1.
      const t2Nested = (await orch.toolExecutor.execute(
        run.id,
        t2.id,
        "tree_view",
        {},
        new AbortController().signal,
      )) as Record<string, unknown>;
      assert.equal(t2Nested.steeringMessages, undefined);
      assert.equal(db.getTask(t2.id)?.goalVersion, 1);

      // 4. Outer model-visible result drains the steer and advances goalVersion only now.
      if (effectiveCodeMode("collapsed") !== "off") {
        // Real sandboxed Code Mode execution (macOS): script ignores inner results, outer CodeExecResult carries the amendment.
        const outerCodeExec = (await orch.toolExecutor.execute(run.id, t1.id, "code_exec", {
          code: `
            import { tree_view, wait_children, output } from "harness";
            await tree_view({});
            await wait_children({ timeout_s: 1 });
            output({ ignored: true });
          `,
        })) as CodeExecResult;
        assert.equal(outerCodeExec.ok, true, outerCodeExec.error);
        assert.deepEqual(outerCodeExec.output, { ignored: true });
        assert.deepEqual(outerCodeExec.steeringMessages, [amendMsg]);
        assert.match(outerCodeExec.hint ?? "", /steeringMessages/i);
        assert.equal(db.getTask(t1.id)?.goalVersion, 2, "Outer code_exec result must bind goalVersion to v2");
      } else {
        // On hosts without OS sandbox (Linux), verify outer model-visible delivery drains the preserved steer and binds v2.
        const outerT1 = (await orch.toolExecutor.execute(run.id, t1.id, "tree_view", {})) as Record<string, unknown>;
        assert.deepEqual(outerT1.steeringMessages, [amendMsg]);
        assert.match(String(outerT1.hint ?? ""), /steeringMessages/i);
        assert.equal(db.getTask(t1.id)?.goalVersion, 2, "Outer result must bind goalVersion to v2");
      }

      // Direct (non-script) outer result for T2 also drains and binds T2 to v2.
      const outerT2 = (await orch.toolExecutor.execute(run.id, t2.id, "tree_view", {})) as Record<string, unknown>;
      assert.deepEqual(outerT2.steeringMessages, [amendMsg]);
      assert.equal(db.getTask(t2.id)?.goalVersion, 2);

      // Direct (non-script) wait_children still drains once without duplicating the batch.
      goals.amendGoal(goal.id, { rationale: "v3 tweak" });
      const v3Msg = "[GOAL AMENDED: goal-1 v2 -> v3] v3 tweak.";
      await orch.steerTaskDetailed(t1.id, v3Msg);
      orch.setAmendBindOnDrain(t1.id, 3);
      const directWait = (await orch.toolExecutor.execute(run.id, t1.id, "wait_children", { timeout_s: 1 })) as Record<
        string,
        unknown
      >;
      assert.equal(directWait.wakeReason, "steered");
      assert.deepEqual(directWait.steeringMessages, [v3Msg]);
      assert.equal(db.getTask(t1.id)?.goalVersion, 3);

      t1Release.resolve();
      t2Release.resolve();
      await waitUntil(() => orch.activeTaskCount() === 0, 4000, "runners to settle");
    } finally {
      ipcClient?.close();
      for (const s of ipcSockets) s.destroy();
      if (ipcServer?.listening) {
        await new Promise<void>((resolve) => ipcServer!.close(() => resolve()));
      }
      t1Release.resolve();
      t2Release.resolve();
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes bound/reporter version 0 for goal-linked tasks with NULL goal_version while keeping Director and system paths unrestricted", async () => {
    const { root, repoRoot, baseSha } = await initTempGitRepo("pi-g17-null-gv-");
    const stateDir = join(root, "state");

    const db = new ControlPlaneDb(":memory:");
    const goals = new GoalEngine(db.db);
    const config = withFixtureCatalog({
      ...loadConfig(repoRoot),
      stateDir,
      codeMode: "off",
    });
    const quota = new QuotaClient();
    const catalog = new ModelCatalogCompiler(config, quota);
    const orch = new HarnessOrchestrator(db, config, catalog, quota, () => ({
      run: async () => ({ text: "ok", stopReason: "completed" }),
    }));

    try {
      const goal = goals.createGoal({
        chatSessionId: "chat-g17-null",
        repoRoot,
        title: "Goal 17 NULL goal_version progress",
        description: "Verify pre-migration NULL goal_version is treated as stale (version 0)",
        criteria: [
          { id: "c1", description: "Criterion 1", kind: "behavioral", required: true },
          { id: "c2", description: "Criterion 2", kind: "behavioral", required: true },
        ],
      });
      const run = db.createRun({ goal: goal.title, repoRoot, baseBranch: "main", baseSha });
      goals.linkRunAndStart(goal.id, run.id);

      const t1 = db.createTask({
        runId: run.id,
        tier: 1,
        kind: "orchestrator",
        title: "Orch",
        objective: "Coordinate",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      db.updateTask(t1.id, { status: "running" });

      const nullWorker = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 2,
        kind: "worker",
        title: "Pre-migration worker",
        objective: "Legacy work",
        profileId: "pi:local",
        model: "fixture/fixture",
      });
      const nullVerify = db.createTask({
        runId: run.id,
        parentId: t1.id,
        tier: 3,
        kind: "verify",
        title: "Pre-migration verify",
        objective: "Legacy verify",
        readOnly: true,
        profileId: "pi:local",
        model: "fixture/fixture",
      });

      // Simulate pre-migration rows where tasks.goal_version is NULL on a goal-linked run.
      db.db.prepare("UPDATE tasks SET goal_version = NULL WHERE id IN (?, ?)").run(nullWorker.id, nullVerify.id);
      assert.equal(db.getTask(nullWorker.id)?.goalVersion, null);
      assert.equal(db.getTask(nullVerify.id)?.goalVersion, null);

      // 1. report_goal_progress from NULL-bound worker drops passed, completed, and criteriaResults with a note, keeping summary.
      const mixedRes = (await orch.toolExecutor.execute(run.id, nullWorker.id, "report_goal_progress", {
        summary: "pre-migration worker note",
        phase: "completed",
        verification_status: "passed",
        criteria_results: [{ criterion_id: "c1", passed: true, evidence: "legacy check" }],
      })) as {
        recorded: boolean;
        goalId: string | null;
        dropped?: Array<{ field: string; value: string; reason: string }>;
        note?: string;
      };
      assert.equal(mixedRes.recorded, true);
      assert.equal(mixedRes.goalId, goal.id);
      assert.equal(mixedRes.dropped?.length, 3);
      assert.deepEqual(
        mixedRes.dropped?.map((d) => d.field).sort(),
        ["criteriaResults", "phase", "verificationStatus"],
      );
      assert.ok(mixedRes.dropped?.every((d) => d.reason.includes("unknown version")));
      assert.match(mixedRes.note ?? "", /unknown goal version/i);

      const afterWorker = goals.getGoal(goal.id)!;
      assert.equal(afterWorker.liveProgress?.summary, "pre-migration worker note");
      assert.equal(afterWorker.liveProgress?.verificationStatus, undefined);
      assert.equal(afterWorker.liveProgress?.phase, undefined);
      assert.equal(afterWorker.liveProgress?.criteriaResults, undefined);

      // 2. Claim-only report from NULL-bound worker is fully dropped (recorded: false).
      const claimOnlyRes = (await orch.toolExecutor.execute(run.id, nullWorker.id, "report_goal_progress", {
        verification_status: "passed",
        criteria_results: [{ criterion_id: "c1", passed: true, evidence: "stale only" }],
      })) as { recorded: boolean; dropped?: Array<{ field: string }>; note?: string };
      assert.equal(claimOnlyRes.recorded, false);
      assert.equal(claimOnlyRes.dropped?.length, 2);
      assert.match(claimOnlyRes.note ?? "", /unknown goal version/i);

      // 3. Auto-recorded verify_task progress on return_task for a NULL-bound verify task also drops verificationStatus "passed".
      db.updateTask(nullWorker.id, { status: "completed" });
      db.updateTask(t1.id, { status: "completed" });
      db.updateTask(nullVerify.id, { status: "running" });
      const verifyRet = (await orch.toolExecutor.execute(run.id, nullVerify.id, "return_task", {
        status: "completed",
        summary: "legacy verify completed",
        sources: [{ path: "README.md", note: "checked" }],
      })) as { returned: boolean; status: string };
      assert.equal(verifyRet.returned, true);
      const afterVerify = goals.getGoal(goal.id)!;
      assert.equal(afterVerify.liveProgress?.verificationStatus, undefined);
      assert.equal(afterVerify.liveProgress?.summary, "legacy verify completed");

      // 4. Director and system paths via GoalEngine.reportProgressDetailed stay unrestricted (boundVersion = null).
      const dirRes = goals.reportProgressDetailed(
        goal.id,
        {
          summary: "Director verified v1",
          phase: "completed",
          verificationStatus: "passed",
          criteriaResults: [{ criterionId: "c1", passed: true, evidence: "director verified" }],
        },
        "director",
      );
      assert.equal(dirRes.dropped.length, 0);
      assert.equal(dirRes.goal.liveProgress?.verificationStatus, "passed");
      assert.equal(dirRes.goal.liveProgress?.phase, "completed");
      assert.deepEqual(dirRes.goal.liveProgress?.criteriaResults, [
        { criterionId: "c1", passed: true, evidence: "director verified" },
      ]);

      const sysRes = goals.reportProgressDetailed(
        goal.id,
        {
          summary: "System verified c2",
          verificationStatus: "passed",
          criteriaResults: [{ criterionId: "c2", passed: true, evidence: "system check" }],
        },
        "system",
      );
      assert.equal(sysRes.dropped.length, 0);
      assert.equal(sysRes.goal.liveProgress?.verificationStatus, "passed");
      assert.equal(sysRes.goal.liveProgress?.criteriaResults?.length, 2);
    } finally {
      orch.dispose();
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
