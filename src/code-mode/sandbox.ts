import { existsSync } from "node:fs";

/** The kernel boundary matters: Bun exposes native code, so JS stubs alone cannot enforce policy. */
export function sandboxCommand(bun: string, dir: string, socket: string): string[] {
  const args = ["--no-install", "--no-env-file", "--preload", "./guard.mjs", "./script.ts"];
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) {
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
    return ["/usr/bin/sandbox-exec", "-p", profile, bun, ...args];
  }
  if (process.platform === "linux" && existsSync("/usr/bin/bwrap")) {
    // Mount runtime libraries, Bun and the scratch socket in private network/PID namespaces.
    return ["/usr/bin/bwrap", "--die-with-parent", "--unshare-all", "--disable-userns", "--cap-drop", "ALL",
      ...["/lib", "/lib64", "/usr/lib", "/usr/lib64"].filter(existsSync).flatMap(p => ["--ro-bind", p, p]),
      "--dev", "/dev", "--proc", "/proc", "--ro-bind", bun, bun, "--ro-bind", dir, dir,
      "--remount-ro", "/", "--chdir", dir, bun, ...args];
  }
  throw new Error("Code Mode requires macOS sandbox-exec or Linux bubblewrap (/usr/bin/bwrap)");
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
