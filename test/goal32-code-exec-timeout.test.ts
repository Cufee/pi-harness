import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { runCodeExec, type CodeExecOptions } from "../src/code-mode/runner.js";

const bun = process.execPath;

async function groupGone(pid: number): Promise<boolean> {
  const deadline = performance.now() + 3_000;
  while (performance.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("goal-32: code_exec phase telemetry and bounded timeout kill", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/cmt-");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function baseOpts(): Omit<CodeExecOptions, "code"> {
    return {
      tools: [],
      artifactsDir: join(root, "a"),
      scratchRoot: root,
      callTool: async () => assert.fail("no tool expected"),
    };
  }

  it("a child that never connects times out in phase spawned and is killed", async () => {
    const controller = new AbortController();
    const result = await runCodeExec({
      ...baseOpts(),
      code: "",
      launch: () => [bun, "-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 1_500,
      signal: controller.signal,
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.toolCalls, 0);
    assert.equal(result.cancelled, undefined);
    assert.equal(result.phase, "spawned");
    assert.deepEqual(Object.keys(result.phases ?? {}), ["preparing", "spawned"]);
    assert.equal(typeof result.pid, "number");
    assert.match(result.error ?? "", /^\[harness blocked: code-exec-timeout\] /);
    assert.match(result.error ?? "", /Stalled in phase spawned/);
    assert.match(result.error ?? "", /No harness tool ran\./);
    assert.equal(controller.signal.aborted, false);
    assert.equal(await groupGone(result.pid!), true);
  }, 30_000);

  it("a ready child that never calls a tool reports runtime_ready", async () => {
    const result = await runCodeExec({
      ...baseOpts(),
      code: "setInterval(() => {}, 1000)",
      launch: () => [bun, "--no-install", "--no-env-file", "--preload", "./guard.mjs", "./script.ts"],
      timeoutMs: 5_000,
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.toolCalls, 0);
    assert.equal(result.phase, "runtime_ready");
    assert.ok(result.phases?.ipc_connected !== undefined);
    assert.ok(result.phases?.runtime_ready !== undefined);
    assert.ok(result.phases.ipc_connected <= result.phases.runtime_ready);
    assert.equal("first_call" in result.phases, false);
    assert.match(result.error ?? "", /Stalled in phase runtime_ready/);
    assert.equal(typeof result.pid, "number");
    assert.equal(await groupGone(result.pid!), true);
  }, 30_000);

  it("timeout returns even when the child's pipes never close", async () => {
    const GC =
      'const {spawn}=require("node:child_process"); const g=spawn(process.execPath,["-e","setTimeout(()=>{},60000)"],{detached:true,stdio:["ignore","inherit","inherit"]}); g.unref(); console.log("grandchild", g.pid); setInterval(()=>{},1000);';
    const t = performance.now();
    const result = await runCodeExec({
      ...baseOpts(),
      code: "",
      launch: () => [bun, "-e", GC],
      timeoutMs: 3_000,
    });
    const elapsed = performance.now() - t;
    const match = /grandchild (\d+)/.exec(result.logs);
    const grandchildPid = match ? Number(match[1]) : undefined;
    try {
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.match(result.error ?? "", /did not close within 2s of SIGKILL/);
      assert.ok(elapsed < 15_000, `expected bounded return under 15s, took ${elapsed.toFixed(0)}ms`);
      assert.ok(result.phase === "spawned" || result.phase === "exited", `unexpected phase: ${result.phase}`);
      assert.ok(grandchildPid !== undefined, `expected grandchild pid in logs: ${JSON.stringify(result.logs)}`);
    } finally {
      if (grandchildPid !== undefined) {
        try { process.kill(-grandchildPid, "SIGKILL"); } catch {}
        try { process.kill(grandchildPid, "SIGKILL"); } catch {}
      }
    }
  }, 30_000);
});
