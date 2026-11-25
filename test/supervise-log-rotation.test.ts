import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { runSupervisor, spawnSupervisorDetached } from "../src/daemon/supervise.js";
import type { ReleaseTarget } from "../src/daemon/release.js";
import { attachDaemonReader, writeDaemonMessage } from "../src/protocol/frames.js";

const tempRoots: string[] = [];
const spawnedPids: number[] = [];

function makeTempRoot(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

function killPidBestEffort(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

async function pollUntil(fn: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}`);
}

afterEach(() => {
  while (spawnedPids.length > 0) {
    killPidBestEffort(spawnedPids.pop()!);
  }
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("daemon.log rotation timing during supervision (I3)", () => {
  it("does not rotate daemon.log when stop is aborted and rotates once after the old daemon exits before opening the new daemon log", async () => {
    const root = makeTempRoot("pi-sup-logrot-");
    const stateDir = join(root, "state");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "config.json"), JSON.stringify({ retention: { logMaxBytes: 64 } }), "utf8");

    const socketPath = join(root, "d.sock");
    const logPath = join(root, "daemon.log");
    const fallbackPath = join(root, "reload-fallback.txt");
    writeFileSync(logPath, "old-daemon-initial-line\n".repeat(5), "utf8"); // 120 bytes > 64
    const initialIno = statSync(logPath).ino;

    // Spawn an old writer holding an open fd on daemon.log that flushes a final shutdown line on SIGTERM.
    const oldWriterScript = join(root, "old-writer.ts");
    writeFileSync(
      oldWriterScript,
      `
process.stdout.write("old-daemon-alive\\n");
process.on("SIGTERM", () => {
  setTimeout(() => {
    process.stdout.write("old-daemon-final-shutdown-line\\n");
    process.exit(0);
  }, 120);
});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const oldLogFd = openSync(logPath, "a");
    let oldChild: ChildProcess;
    try {
      oldChild = spawn(process.execPath, [oldWriterScript], {
        stdio: ["ignore", oldLogFd, oldLogFd],
      });
    } finally {
      closeSync(oldLogFd);
    }
    const oldPid = oldChild.pid!;
    spawnedPids.push(oldPid);

    await pollUntil(
      () => existsSync(logPath) && readFileSync(logPath, "utf8").includes("old-daemon-alive"),
      5_000,
      "old writer to log startup line",
    );

    // Fake target daemon that listens on PI_HARNESS_SOCKET_PATH, logs a boot line, and answers ping.
    const targetDir = join(root, "rel-target");
    const targetCli = join(targetDir, "src", "cli.ts");
    const targetPidFile = join(root, "target.pid");
    mkdirSync(join(targetDir, "src"), { recursive: true });
    writeFileSync(
      targetCli,
      `
import { createServer } from "node:net";
import { rmSync, writeFileSync } from "node:fs";
import { attachDaemonReader, writeDaemonMessage } from ${JSON.stringify(join(process.cwd(), "src", "protocol", "frames.ts"))};

const sockPath = process.env.PI_HARNESS_SOCKET_PATH!;
try { rmSync(sockPath, { force: true }); } catch {}
writeFileSync(${JSON.stringify(targetPidFile)}, String(process.pid), "utf8");
process.stdout.write("new-daemon-booted\\n");

const server = createServer((sock) => {
  attachDaemonReader(sock, {
    onMessage: (msg) => {
      const req = msg as { id?: string; op?: string };
      if (req.op === "ping") {
        writeDaemonMessage(sock, {
          kind: "res",
          id: req.id ?? "1",
          ok: true,
          result: { pong: true, pid: process.pid, releaseId: "rel-target" },
        });
      }
    },
  });
});
server.listen(sockPath);
process.on("SIGTERM", () => { server.close(() => process.exit(0)); });
`,
      "utf8",
    );
    const targetRelease: ReleaseTarget = {
      releaseId: "rel-target",
      releaseDir: targetDir,
      bunPath: process.execPath,
      cliPath: targetCli,
    };

    // Part 1: Listener answers ping with a DIFFERENT pid so runSupervisor aborts the stop.
    // Neither spawnSupervisorDetached nor the aborted runSupervisor may rotate daemon.log.
    const sockets = new Set<Socket>();
    const mismatchServer = createServer((sock) => {
      sockets.add(sock);
      sock.once("close", () => sockets.delete(sock));
      attachDaemonReader(sock, {
        onMessage: (msg) => {
          const req = msg as { id?: string; op?: string };
          if (req.op === "ping") {
            writeDaemonMessage(sock, {
              kind: "res",
              id: req.id ?? "1",
              ok: true,
              result: { pong: true, pid: process.pid, releaseId: "rel-other" },
            });
          }
        },
      });
    });
    await new Promise<void>((r) => mismatchServer.listen(socketPath, r));

    const selfRelease: ReleaseTarget = {
      releaseId: "checkout",
      releaseDir: process.cwd(),
      bunPath: process.execPath,
      cliPath: join(process.cwd(), "src", "cli.ts"),
    };

    try {
      spawnSupervisorDetached(
        selfRelease,
        {
          socketPath,
          stateDir,
          target: targetRelease,
          previous: null,
          stopPid: oldPid,
        },
        root,
      );

      assert.equal(existsSync(`${logPath}.1`), false, "spawnSupervisorDetached must not rotate daemon.log before old daemon exits");
      assert.equal(statSync(logPath).ino, initialIno, "daemon.log inode must stay unchanged when supervisor spawns");

      await pollUntil(() => existsSync(fallbackPath), 10_000, "aborted supervisor to write reload-fallback.txt");
      assert.ok(readFileSync(fallbackPath, "utf8").includes("# Reload aborted (exit 1):"));
      assert.equal(existsSync(`${logPath}.1`), false, "aborted stop must not rotate daemon.log");
      assert.equal(statSync(logPath).ino, initialIno, "daemon.log inode must remain unchanged after aborted stop");
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => mismatchServer.close(() => r()));
      rmSync(socketPath, { force: true });
    }

    // Part 2: Confirmed stop + target start must rotate daemon.log ONCE after old daemon exits,
    // capturing the old daemon's final shutdown line in daemon.log.1 and opening a fresh daemon.log for the new daemon.
    const code = await runSupervisor({
      socketPath,
      stateDir,
      target: targetRelease,
      previous: null,
      stopPid: oldPid,
      bootTimeoutMs: 10_000,
    });
    if (existsSync(targetPidFile)) {
      const targetPid = Number(readFileSync(targetPidFile, "utf8").trim());
      if (Number.isInteger(targetPid) && targetPid > 0) spawnedPids.push(targetPid);
    }

    assert.equal(code, 0, "supervisor should exit 0 after target boots");
    assert.equal(existsSync(`${logPath}.1`), true, "daemon.log should rotate to daemon.log.1 after old daemon exits");
    assert.equal(statSync(`${logPath}.1`).ino, initialIno, "daemon.log.1 should be the original daemon.log inode");
    assert.ok(
      readFileSync(`${logPath}.1`, "utf8").includes("old-daemon-final-shutdown-line"),
      "daemon.log.1 must contain the old daemon's final shutdown line written before exit",
    );
    assert.equal(existsSync(logPath), true, "new daemon must create a fresh daemon.log");
    assert.notEqual(statSync(logPath).ino, initialIno, "fresh daemon.log must have a new inode");
    assert.ok(
      readFileSync(logPath, "utf8").includes("new-daemon-booted"),
      "fresh daemon.log must contain the new daemon's output",
    );
  }, 20_000);
});
