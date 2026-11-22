import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.js";
import type { EventRecord, RunRecord, TaskRecord } from "../src/control-plane/db.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { DaemonEventFrame } from "../src/protocol/daemon-rpc.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

type WatchStartResult = { watchId: string; replay: EventRecord[]; lastSeq: number; run?: RunRecord; task?: TaskRecord };
type RunsTreesResult = { generatedAt: number; runs: Array<{ run: RunRecord; tasks: TaskRecord[]; escalations: unknown[] }> };

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-watch-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "a.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

async function connect(sockPath: string): Promise<{ client: DaemonClient; frames: DaemonEventFrame[] }> {
  const client = new DaemonClient(sockPath);
  await client.connect();
  const frames: DaemonEventFrame[] = [];
  client.onEvent((f) => frames.push(f));
  return { client, frames };
}

describe("Daemon read-only runs.trees + watch.start/stop", () => {
  it("lists full task trees incl. reviewer, watches without evicting, replays fully, streams live without dupes", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-wstate-"));
    const sockPath = join(stateDir, "d.sock");
    const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, socketPath: sockPath });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.kind === "verify") {
            req.callbacks.onThoughtDelta?.("checking c2");
            req.callbacks.onToolEvent?.({ name: "read_file", status: "completed" });
            req.callbacks.onTextDelta?.("verdict incoming");
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              criteriaResults: [{ criterionId: "c2", passed: true, evidence: "a.txt has v1" }],
              summary: "Verified.",
            });
            return { text: "approved", stopReason: "completed" };
          }
          return { text: "idle", stopReason: "completed" };
        },
      }),
    });
    await daemon.start();
    const db = daemon.db;
    const clients: DaemonClient[] = [];

    try {
      const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
      const run = db.createRun({ goal: "Watch me", repoRoot, baseBranch: "main", baseSha });
      const t1 = db.createTask({ runId: run.id, tier: 1, kind: "orchestrator", title: "Orch", objective: "o", readOnly: true, profileId: "pi:local", model: "fixture" });
      const mk = (title: string, status?: TaskRecord["status"]) => {
        const t = db.createTask({ runId: run.id, parentId: t1.id, tier: 2, kind: "worker", title, objective: title, profileId: "pi:local", model: "fixture", readOnly: true });
        if (status) db.updateTask(t.id, { status });
        return t;
      };
      const wDone = mk("done", "completed");
      const wFailed = mk("failed", "failed");
      const wRunning = mk("running", "running");
      const wPending = mk("pending");

      // Independent reviewer persisted as a T3 verify task under the linked run
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Keep a.txt",
        description: "a.txt exists",
        criteria: [
          { id: "c1", description: "a.txt exists", kind: "deterministic", command: "test -f a.txt" },
          { id: "c2", description: "a.txt sane", kind: "behavioral" },
        ],
      });
      daemon.director.goals.linkRunAndStart(goal.id, run.id);

      // Pre-existing sessions: A holds Director Chat, B is attached to the run.
      const a = await connect(sockPath);
      const b = await connect(sockPath);
      clients.push(a.client, b.client);
      await a.client.request("chat.open", { repoRoot, profileId: "pi:local", model: "fixture" });
      await b.client.request("attach", { runId: run.id });

      const review = (await a.client.request("goal.review", { goalId: goal.id })) as { review: { verdict: string } };
      assert.equal(review.review.verdict, "approved");

      const trees = (await a.client.request("runs.trees", {})) as RunsTreesResult;
      const tree = trees.runs.find((r) => r.run.id === run.id);
      assert.ok(tree);
      const byId = new Map(tree.tasks.map((t) => [t.id, t]));
      assert.equal(byId.get(t1.id)?.tier, 1);
      assert.equal(byId.get(wDone.id)?.status, "completed");
      assert.equal(byId.get(wFailed.id)?.status, "failed");
      assert.equal(byId.get(wRunning.id)?.status, "running");
      assert.ok(byId.has(wPending.id));
      const reviewer = tree.tasks.find((t) => t.kind === "verify");
      assert.ok(reviewer, "reviewer must be persisted as a task");
      assert.equal(reviewer.tier, 3);
      assert.equal(reviewer.parentId, t1.id);
      assert.equal(reviewer.status, "completed");
      assert.equal(reviewer.title, "Done-Review: Keep a.txt (cycle 1)");

      // runIds filter
      const only = (await a.client.request("runs.trees", { runIds: [run.id] })) as RunsTreesResult;
      assert.deepEqual(only.runs.map((r) => r.run.id), [run.id]);

      // Reviewer transcript is replayable
      const rw = (await a.client.request("watch.start", { scope: "task", runId: run.id, taskId: reviewer.id })) as WatchStartResult;
      const rTypes = rw.replay.map((e) => e.type);
      for (const t of ["agent.thought_delta", "agent.tool", "agent.text_delta", "task.status"]) assert.ok(rTypes.includes(t), t);
      assert.equal(rw.task?.id, reviewer.id);

      // Both sessions start watches; neither may be evicted from chat / run attachment.
      a.frames.length = 0;
      b.frames.length = 0;
      const aRuns = (await a.client.request("watch.start", { scope: "runs" })) as WatchStartResult;
      const bRuns = (await b.client.request("watch.start", { scope: "runs" })) as WatchStartResult;
      assert.deepEqual(aRuns.replay, []);
      const goalEv = db.emitEvent(run.id, null, "goal.updated", { x: 1 });
      const runEv = db.emitEvent(run.id, wRunning.id, "agent.text_delta", { text: "hi" });
      const statusEv = db.emitEvent(run.id, wRunning.id, "task.status", { from: "running", to: "running" });
      await tick();
      assert.ok(a.frames.some((f) => f.seq === goalEv.seq && !f.watchId), "chat subscriber still receives goal events");
      assert.ok(b.frames.some((f) => f.seq === runEv.seq && !f.watchId), "attached socket still receives run events");
      assert.ok(!a.frames.some((f) => /evict|took_?over/i.test(f.type)));
      assert.ok(!b.frames.some((f) => /evict|took_?over/i.test(f.type)));
      // runs-scope watch frames: only run./task./quota./escalation.* types, tagged with watchId
      const aWatch = a.frames.filter((f) => f.watchId === aRuns.watchId);
      assert.deepEqual(aWatch.map((f) => f.seq), [statusEv.seq]);
      assert.ok(b.frames.some((f) => f.watchId === bRuns.watchId && f.seq === statusEv.seq));

      // Full replay of >500 task events
      const c = await connect(sockPath);
      clients.push(c.client);
      const emitted: number[] = [];
      for (let i = 0; i < 1200; i++) emitted.push(db.emitEvent(run.id, wRunning.id, "agent.text_delta", { text: `t${i}` }).seq);
      const tw = (await c.client.request("watch.start", { scope: "task", runId: run.id, taskId: wRunning.id })) as WatchStartResult;
      const replaySeqs = tw.replay.map((e) => e.seq);
      for (const s of emitted) assert.ok(replaySeqs.includes(s));
      assert.ok(tw.replay.length >= 1202);
      assert.equal(new Set(replaySeqs).size, replaySeqs.length);
      assert.equal(tw.lastSeq, replaySeqs[replaySeqs.length - 1]);

      // attach replay is not truncated either
      const att = (await c.client.request("attach", { runId: run.id, taskId: wRunning.id })) as { replay: EventRecord[] };
      assert.equal(att.replay.length, tw.replay.length);
      await c.client.request("detach", {});

      // sinceSeq replays only the tail
      const tail = (await c.client.request("watch.start", { scope: "task", runId: run.id, taskId: wRunning.id, sinceSeq: emitted[1199 - 10] })) as WatchStartResult;
      assert.deepEqual(tail.replay.map((e) => e.seq), emitted.slice(1190));

      // Live events after replay: tagged, task-filtered, no dupes
      c.frames.length = 0;
      const live = [
        db.emitEvent(run.id, wRunning.id, "agent.text_delta", { text: "live1" }).seq,
        db.emitEvent(run.id, wDone.id, "agent.text_delta", { text: "other task" }).seq,
        db.emitEvent(run.id, wRunning.id, "agent.tool", { name: "x", status: "completed" }).seq,
      ];
      await tick();
      const got = c.frames.filter((f) => f.watchId === tw.watchId).map((f) => f.seq);
      assert.deepEqual(got, [live[0], live[2]]);
      assert.ok(got.every((s) => s > tw.lastSeq));

      // watch.stop halts delivery for that watch
      assert.deepEqual(await c.client.request("watch.stop", { watchId: tw.watchId }), { stopped: true });
      assert.deepEqual(await c.client.request("watch.stop", { watchId: tw.watchId }), { stopped: false });
      c.frames.length = 0;
      db.emitEvent(run.id, wRunning.id, "agent.text_delta", { text: "after stop" });
      await tick();
      assert.ok(!c.frames.some((f) => f.watchId === tw.watchId));
      assert.ok(c.frames.some((f) => f.watchId === tail.watchId), "other watch on same socket keeps streaming");

      // Socket close removes its watches
      const watches = (daemon as unknown as { watches: Map<unknown, unknown> }).watches;
      const before = watches.size;
      c.client.close();
      await tick();
      assert.equal(watches.size, before - 1);
      db.emitEvent(run.id, wRunning.id, "task.status", { from: "running", to: "running" });
      await tick();
    } finally {
      for (const cl of clients) cl.close();
      await daemon.stop();
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
