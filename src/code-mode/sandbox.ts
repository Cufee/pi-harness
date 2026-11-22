import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const launcher = "/usr/bin/sandbox-exec";

function sandboxArgs(bun: string, dir: string, socket: string): string[] {
  const q = JSON.stringify;
  const profile = `(version 1)
    (deny default)
    (import "dyld-support.sb")
    (allow sysctl-read file-read-metadata)
    (allow file-read* file-map-executable (subpath "/System/Library") (subpath "/usr/lib") (literal ${q(bun)}))
    (allow file-read* (subpath "/usr/share/icu")
      (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random")
      (subpath ${q(dir)}))
    (allow process-exec (literal ${q(bun)}))
    (allow signal (target self))
    (allow network-outbound (remote unix-socket (path-literal ${q(socket)})))`;
  return ["-p", profile, bun, "--no-install", "--no-env-file"];
}

export function sandboxEnv(dir: string) {
  return { HOME: dir, TMPDIR: dir, PATH: "/usr/bin:/bin" };
}

// Run before installing the JS guard so these checks exercise the OS profile.
const probe = (port: number, socketPath: string) => `
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
function denied(error) {
  return error?.code === "EPERM" || error?.code === "EACCES";
}
function mustDeny(action) {
  try { action(); } catch (error) { if (denied(error)) return; throw error; }
  throw new Error("Sandbox permitted a restricted operation");
}
mustDeny(() => writeFileSync("write-probe", ""));
mustDeny(() => execFileSync(process.execPath, ["--version"]));
await new Promise((resolve, reject) => {
  const socket = connect(${port}, "127.0.0.1");
  socket.on("connect", () => { socket.destroy(); reject(new Error("TCP permitted")); });
  socket.on("error", error => {
    // Bun can report a denied connect to the listening parent as ECONNREFUSED.
    if (denied(error) || error.code === "ECONNREFUSED") resolve();
    else reject(error);
  });
});
await new Promise((resolve, reject) => {
  const socket = connect(${JSON.stringify(socketPath)});
  socket.on("connect", () => { socket.destroy(); resolve(); });
  socket.on("error", reject);
});
console.log("sandbox probe complete");
`;

export function sandboxUnavailableReason(): string | null {
  return unavailableReason;
}

let available: boolean | undefined;
let unavailableReason: string | null = null;
export function sandboxAvailable(): boolean {
  if (available !== undefined) return available;
  // Bubblewrap namespaces alone permit spawning children and using loopback.
  // Linux (including NixOS) needs an additional verified kernel policy.
  if (process.platform !== "darwin") {
    available = false;
    unavailableReason = `Code Mode sandbox is only supported on macOS (platform: ${process.platform})`;
    return false;
  }
  let dir: string | undefined;
  let listener: Bun.UnixSocketListener<undefined> | undefined;
  let tcp: Bun.TCPSocketListener<undefined> | undefined;
  try {
    const sysTmp = tmpdir();
    const probeBase = Buffer.byteLength(join(sysTmp, "cm-XXXXXX", "ipc")) > 100 ? "/tmp" : sysTmp;
    dir = realpathSync(mkdtempSync(join(probeBase, "cm-")));
    let socket = join(dir, "ipc");
    if (Buffer.byteLength(socket) >= 104 && probeBase !== "/tmp") {
      rmSync(dir, { recursive: true, force: true });
      dir = realpathSync(mkdtempSync(join("/tmp", "cm-")));
      socket = join(dir, "ipc");
    }
    if (Buffer.byteLength(socket) >= 104) throw new Error("Code Mode IPC path too long");
    listener = Bun.listen({ unix: socket, socket: { data() {} } });
    tcp = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const args = sandboxArgs(realpathSync(process.execPath), dir, socket);
    const result = spawnSync(launcher, [...args, "-e", probe(tcp.port, socket)], {
      cwd: dir, env: sandboxEnv(dir), timeout: 3000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const errCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const timedOut = (result.status === null && result.signal === "SIGTERM") || errCode === "ETIMEDOUT";
    if (timedOut) {
      unavailableReason = "Code Mode sandbox probe timed out";
      return false;
    }
    available = result.status === 0 && result.stdout.trim() === "sandbox probe complete";
    if (!available) {
      const detail = typeof result.stderr === "string" && result.stderr.trim()
        ? `: ${result.stderr.trim().slice(0, 200)}`
        : result.error
          ? `: ${result.error.message}`
          : "";
      unavailableReason = `Code Mode sandbox probe failed (status=${result.status}, signal=${result.signal})${detail}`;
    } else {
      unavailableReason = null;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const msg = err instanceof Error ? err.message : String(err);
    unavailableReason = `Code Mode sandbox probe error: ${msg}`;
    if (code === "ETIMEDOUT") return false;
    available = false;
  } finally {
    tcp?.stop(true);
    listener?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  return available;
}

export function sandboxCommand(bun: string, dir: string, socket: string): string[] {
  if (!sandboxAvailable()) throw new Error(unavailableReason ?? "Code Mode sandbox unavailable on this host");
  return [launcher, ...sandboxArgs(bun, dir, socket), "--preload", "./guard.mjs", "./script.ts"];
}

// Import the bridge first: it opens the one authorized socket before networking is disabled.
export const guard = String.raw`
import './bridge.mjs';
import fs from 'node:fs';
import cp from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
const deny = () => { throw new Error('Blocked by Code Mode sandbox'); };
function block(obj, names) {
  for (const key of names) if (key in obj) obj[key] = deny;
}
const writeOps = ['appendFile','chmod','chown','copyFile','cp','fchmod','fchown','fdatasync',
  'fsync','ftruncate','futimes','lchmod','lchown','link','lutimes','mkdir','mkdtemp','rename',
  'rm','rmdir','symlink','truncate','unlink','utimes','write','writeFile','writev'];
block(fs, [...writeOps, ...writeOps.map(k => k + 'Sync'), 'createWriteStream','WriteStream']);
block(fs.promises, writeOps);
for (const [obj, key] of [[fs,'open'],[fs,'openSync'],[fs.promises,'open']]) {
  const open = obj[key];
  obj[key] = function(path, flags, ...rest) {
    if (flags != null && !['r','rs','sr',0].includes(flags)) deny();
    return open.call(this,path,flags,...rest);
  };
}
block(cp, ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']);
block(net, ['connect','createConnection','createServer']); block(net.Socket.prototype, ['connect']);
block(tls, ['connect','createServer']); block(dgram, ['createSocket']);
for (const obj of [http,https,http2]) block(obj, ['connect','request','get','createServer','createSecureServer']);
block(Bun, ['write','spawn','spawnSync','connect','listen','serve','$','which']);
block(globalThis, ['fetch','WebSocket','Worker']);
syncBuiltinESMExports();
`;
