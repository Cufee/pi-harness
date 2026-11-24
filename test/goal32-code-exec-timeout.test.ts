import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import { runCodeExec, type CodeExecOptions } from "../src/code-mode/runner.js";

const bun = process.execPath;
const testIfNonRoot = process.getuid?.() === 0 ? it.skip : it;

function killPidFromFile(pidFile: string) {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(-pid, "SIGKILL"); } catch {}
  try { process.kill(pid, "SIGKILL"); } catch {}
}

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
  let cleanups: Array<() => void>;

  beforeEach(() => {
    root = mkdtempSync("/tmp/cmt-");
    cleanups = [];
  });

  afterEach(() => {
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch {}
    }
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
      launch: () => [bun, "-e", "setTimeout(() => {}, 30_000)"],
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
      code: "setTimeout(() => {}, 30_000)",
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
    const pidDir = mkdtempSync("/tmp/cmt-gc-");
    const pidFile = join(pidDir, "grandchild.pid");
    const cleanup = () => {
      killPidFromFile(pidFile);
      rmSync(pidDir, { recursive: true, force: true });
    };
    cleanups.push(cleanup);
    const gcChildCode = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60_000);`;
    const GC = `const {spawn}=require("node:child_process"); const g=spawn(process.execPath,["-e",${JSON.stringify(gcChildCode)}],{detached:true,stdio:["ignore","inherit","inherit"]}); g.unref(); setTimeout(()=>{},30_000);`;
    const t = performance.now();
    try {
      const result = await runCodeExec({
        ...baseOpts(),
        code: "",
        launch: () => [bun, "-e", GC],
        timeoutMs: 3_000,
      });
      const elapsed = performance.now() - t;
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.match(result.error ?? "", /did not close within 2s of SIGKILL/);
      assert.ok(elapsed < 15_000, `expected bounded return under 15s, took ${elapsed.toFixed(0)}ms`);
      assert.ok(result.phase === "spawned" || result.phase === "exited", `unexpected phase: ${result.phase}`);
      assert.equal(existsSync(pidFile), true, "expected grandchild to record its pid");
    } finally {
      cleanup();
    }
  }, 30_000);

  testIfNonRoot("timeout still resolves when scratch directory cleanup fails", async () => {
    const lockedRoot = mkdtempSync("/tmp/cmt-ro-");
    let createdDir: string | undefined;
    const cleanup = () => {
      try { chmodSync(lockedRoot, 0o700); } catch {}
      rmSync(lockedRoot, { recursive: true, force: true });
    };
    cleanups.push(cleanup);
    try {
      const result = await runCodeExec({
        ...baseOpts(),
        scratchRoot: lockedRoot,
        code: "",
        launch: (dir) => {
          createdDir = dir;
          chmodSync(lockedRoot, 0o555);
          return [bun, "-e", "setTimeout(() => {}, 30_000)"];
        },
        timeoutMs: 1_500,
      });

      assert.equal(result.ok, false);
      assert.equal(result.timedOut, true);
      assert.equal(result.phase, "spawned");
      assert.deepEqual(Object.keys(result.phases ?? {}), ["preparing", "spawned"]);
      assert.equal(typeof result.pid, "number");
      assert.match(result.error ?? "", /^\[harness blocked: code-exec-timeout\] /);
      assert.match(result.error ?? "", /Stalled in phase spawned/);
      assert.equal(createdDir !== undefined && existsSync(createdDir), true);
      assert.equal(await groupGone(result.pid!), true);
    } finally {
      cleanup();
    }
  }, 30_000);
});
