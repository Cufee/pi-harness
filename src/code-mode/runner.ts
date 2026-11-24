import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessRejection, REJECTIONS } from "../advisories/rejections.js";
import { writeUniqueFile } from "../control-plane/ids.js";
import { toolEventPreview } from "../protocol/tool-display.js";
import type { ToolDefinition } from "../runners/types.js";
import { providePython, pythonBridge, pythonEntry, pythonGuard, pythonModule, type PythonRuntime } from "./python.js";
import { guard, pythonSandboxCommand, pythonSandboxEnv, sandboxCommand, sandboxEnv } from "./sandbox.js";
import { generatePythonDeclarations, generateSdkDeclarations, pythonTools } from "./sdk.js";

export type CodeLanguage = "typescript" | "python";
export type CodeExecPhase = "provisioning" | "preparing" | "spawned" | "ipc_connected" | "runtime_ready" | "first_call" | "exited";

export interface CodeExecToolEvent {
  phase: "start" | "end"; name: string; args: Record<string, unknown>; ok?: boolean; error?: string; result?: string; via: "code_exec";
}
export interface CodeExecOptions {
  code: string; tools: ToolDefinition[];
  /** Optional authorized callable tool names beyond listed `tools` (e.g. unlisted-but-allowed role tools). */
  allowedToolNames?: Iterable<string>;
  /** Default TypeScript. Python runs a harness-managed CPython under the same sandbox and IPC. */
  language?: CodeLanguage;
  /** Python only: exact `name==version` wheel pins. */
  packages?: string[];
  pythonCacheDir?: string;
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  signal?: AbortSignal; timeoutMs?: number; maxOutputChars?: number;
  artifactsDir: string; scratchRoot?: string;
  /** Persists oversized output. `name` is a suggested base name; the callback owns collision-free uniqueness. */
  saveOutput?: (name: string, json: string) => string | Promise<string>;
  onToolEvent?: (event: CodeExecToolEvent) => void;
  /** Test seam: replaces the sandboxed TypeScript interpreter command. Tools cannot set it. createCodeModeExecutor never passes it. */
  launch?: (dir: string, socket: string) => string[];
}
export interface CodeExecResult {
  ok: boolean; output?: unknown; preview: string; artifactPath?: string; logs: string; toolCalls: number;
  error?: string; timedOut?: boolean; cancelled?: boolean;
  steeringMessages?: string[]; hint?: string;
  /** Set on timeout or cancel: last lifecycle phase the host observed. */
  phase?: CodeExecPhase;
  /** Set on timeout or cancel: ms since runCodeExec started at which each phase was first reached. */
  phases?: Partial<Record<CodeExecPhase, number>>;
  /** Set on timeout or cancel: the interpreter pid, which leads the process group that was killed. */
  pid?: number;
}

export function timeoutMs(ms: number | undefined, max = 1_800_000): number {
  return Math.max(1, Math.min(Number.isFinite(ms) ? ms! : 300_000, max, 1_800_000));
}

export function codeExecTimeoutError(ms: number | undefined): HarnessRejection {
  return REJECTIONS.codeExecTimeout(Math.max(1, Math.round(timeoutMs(ms) / 1000)), 1800);
}

// A referenced socket keeps Bun alive until all pending requests (including synchronous output()) are acknowledged.
function bridge(socket: string): string {
  return `import { createConnection } from 'node:net';
const sock = createConnection(${JSON.stringify(socket)});
await new Promise((res,rej) => {sock.once('connect',res); sock.once('error',rej)});
class ToolError extends Error { constructor(m) { super(m); this.name = 'ToolError'; } }
const pending = new Map(); let next = 0, buf = '';
sock.setEncoding('utf8'); sock.unref();
sock.on('close', () => { for (const p of pending.values()) p.reject(new Error('Code Mode IPC closed')); pending.clear() });
sock.on('data', chunk => { buf += chunk; let n;
  while ((n = buf.indexOf('\\n')) >= 0) {
    const r = JSON.parse(buf.slice(0,n)); buf = buf.slice(n+1);
    const p = pending.get(r.id); pending.delete(r.id);
    if (r.ok) p.resolve(r.value); else p.reject(new ToolError(r.error));
  } if (!pending.size) sock.unref();
});
function send(msg) {
  const id = ++next, line = JSON.stringify({id,...msg})+'\\n';
  sock.ref(); return new Promise((resolve,reject) => {pending.set(id,{resolve,reject});sock.write(line)});
}
export const call = (name,args={}) => send({name,args});
export const output = value => { void send({kind:'output',value}) };
export const ready = () => { void send({kind:'ready'}).catch(() => {}) };
globalThis.output = output;
// Reports whether the script's terminal exception came from the sandbox itself; harness tool failures never do.
export const reportError = e => send({kind:'error',value: !!e && !(e instanceof ToolError) &&
  (e.code === 'EPERM' || e.code === 'EACCES' || e.message === 'Blocked by Code Mode sandbox')});
`;
}

// Appended to the preload guard so script.ts stays the entrypoint while its terminal exception, from module
// evaluation, a timer, or an unhandled rejection, still reports provenance before Bun exits nonzero.
// A script that installs its own handler for the event keeps control of it. Bun calls these listeners natively. An
// ordinary once-listener is appended after ours and still counts while ours runs; a prepended once-listener removes
// itself before ours runs, so those are wrapped to mark the dispatch they handled, and removal by the original function
// is mapped to its wrapper.
// Bun dispatches a rejection left by the last timer only after beforeExit and may exit before the report is
// acknowledged; the report is written before the first await, exitCode keeps the exit nonzero, and the host drains it.
const fatalHook = `
import { reportError, ready } from './bridge.mjs';
const fatalEvents = ['uncaughtException', 'unhandledRejection'], onceRan = {};
// Bun's process emitter keeps one registration per callback: the first one wins and off removes it.
// A callback is registered either as itself or as one prepended once-wrapper tagged with origKey, never both;
// the live listener list is the only record, so native removal by any identity leaves nothing stale.
const origKey = Symbol(), origRaw = process.rawListeners;
const orig = {};
for (const m of ['on', 'addListener', 'once', 'prependListener', 'prependOnceListener', 'removeListener']) orig[m] = process[m];
const findWrapper = (event, fn) => typeof fn === 'function' ? origRaw.call(process, event).find(l => l && l[origKey] === fn) : undefined;
const hasCallback = (event, fn) => typeof fn === 'function' && origRaw.call(process, event).some(l => l === fn || (l && l[origKey] === fn));
let fatalHandled = false;
for (const m of ['on', 'addListener', 'once', 'prependListener']) process[m] = function (event, fn) {
  if (fatalEvents.includes(event) && typeof fn === 'function' && findWrapper(event, fn)) return this;
  return orig[m].call(this, event, fn);
};
process.prependOnceListener = function (event, fn) {
  if (!fatalEvents.includes(event) || typeof fn !== 'function') return orig.prependOnceListener.call(this, event, fn);
  if (hasCallback(event, fn)) return this;
  function wrapped(...args) {
    orig.removeListener.call(process, event, wrapped);
    onceRan[event] = true; queueMicrotask(() => { onceRan[event] = false; });
    return fn.apply(this, args);
  }
  wrapped[origKey] = fn;
  return orig.prependListener.call(this, event, wrapped);
};
process.removeListener = process.off = function (event, fn) {
  if (!fatalEvents.includes(event) || typeof fn !== 'function') return orig.removeListener.call(this, event, fn);
  orig.removeListener.call(this, event, findWrapper(event, fn) ?? fn);
  return this;
};
for (const event of fatalEvents) process.on(event, async e => {
  const handled = onceRan[event] || process.listenerCount(event) > 1;
  onceRan[event] = false;
  if (fatalHandled || handled) return;
  fatalHandled = true; process.exitCode = 1;
  console.error(e);
  await reportError(e).catch(() => {});
  process.exit(1);
});
ready();
`;

const message = (err: unknown) => err instanceof Error ? err.message : String(err);
function formatScriptError(raw: string, sandboxDenial: boolean, toolNames: Iterable<string>): string {
  if (!sandboxDenial) return raw;
  const available = new Set(toolNames);
  const readers = (["read_file", "artifact_read"] as const).filter((name) => available.has(name));
  const guidance = readers.length > 0
    ? `Read files with ${readers.join(" or ")} from "harness" and pass the data into the script.`
    : "Read files with your own file tools outside code_exec and pass the data into the script.";
  return `${raw}\n\nHint: if this failed on a direct filesystem, subprocess, or network call, code_exec runs in an OS sandbox that blocks workspace file reads, all writes, subprocesses, and network. ${guidance}`;
}
const IPC_BYTES = 16 * 1024 * 1024;
const CLOSE_GRACE_MS = 2_000;

export function createCodeExecIpcServer(ctx: {
  names: ReadonlySet<string>;
  sockets: Set<Socket>;
  isStopped: () => boolean;
  stop: (reason: string) => void;
  onOutput: (value: unknown) => void;
  onSandboxDenial: (denial: boolean) => void;
  onToolCall: () => void;
  onPhase?: (phase: "ipc_connected" | "runtime_ready") => void;
  onToolEvent?: (event: CodeExecToolEvent) => void;
  callTool: (name: string, args: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;
  signal: AbortSignal;
}) {
  let pending = 0, pendingBytes = 0;
  return createServer(socket => {
    if (ctx.isStopped() || ctx.sockets.size) { socket.destroy(); return; }
    ctx.sockets.add(socket);
    ctx.onPhase?.("ipc_connected");
    socket.on("error", () => socket.destroy());
    socket.once("close", () => ctx.sockets.delete(socket));
    let parts: Buffer[] = [], bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      let start = 0;
      while (start < chunk.length && !ctx.isStopped()) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        bytes += part.length;
        if (bytes > IPC_BYTES) { ctx.stop(REJECTIONS.codeExecIpc().message); return; }
        parts.push(part);
        if (end < 0) return;
        const size = bytes;
        if (pending >= 64 || pendingBytes + size > IPC_BYTES) { ctx.stop("Too many outstanding Code Mode requests"); return; }
        pending++; pendingBytes += size;
        void dispatch(Buffer.concat(parts, bytes).toString()).catch(e => ctx.stop(message(e)))
          .finally(() => { pending--; pendingBytes -= size; });
        parts = []; bytes = 0; start = end + 1;
      }
    });

    async function dispatch(line: string) {
      const { id, name, args, kind, value } = JSON.parse(line);
      function reply(payload: Record<string, unknown>) {
        if (ctx.isStopped() || socket.destroyed) return;
        const json = JSON.stringify({ id, ...payload }) + "\n";
        if (Buffer.byteLength(json) + socket.writableLength > IPC_BYTES) throw REJECTIONS.codeExecIpc();
        socket.write(json);
      }
      if (!Number.isSafeInteger(id)) throw new Error("Invalid IPC request id");
      if (kind === "ready") { ctx.onPhase?.("runtime_ready"); reply({ ok: true }); return; }
      if (kind === "output") { ctx.onOutput(value); reply({ ok: true }); return; }
      if (kind === "error") { ctx.onSandboxDenial(Boolean(value)); reply({ ok: true }); return; }
      if (typeof name !== "string" || !args || Array.isArray(args) || typeof args !== "object") throw new Error("Invalid tool call");
      const event = { name, args, via: "code_exec" as const };
      ctx.onToolCall();
      ctx.onToolEvent?.({ ...event, phase: "start" });
      try {
        if (name === "code_exec" || name === "tool_search") throw new Error(`Recursive ${name} calls are not allowed inside code_exec`);
        if (!ctx.names.has(name)) throw REJECTIONS.notYourTool(name, "code_exec");
        const out = await ctx.callTool(name, args, ctx.signal);
        reply({ ok: true, value: out });
        ctx.onToolEvent?.({ ...event, phase: "end", ok: true, result: toolEventPreview(out) });
      } catch (e) {
        const error = message(e);
        ctx.onToolEvent?.({ ...event, phase: "end", ok: false, error });
        reply({ ok: false, error });
      }
    }
  });
}

export function codeExecCallableNames(opts: Pick<CodeExecOptions, "tools" | "allowedToolNames">): Set<string> {
  return new Set([...opts.tools.map((t) => t.name), ...(opts.allowedToolNames ?? [])]);
}

export async function runCodeExec(opts: CodeExecOptions): Promise<CodeExecResult> {
  const result: CodeExecResult = { ok: false, preview: "", logs: "", toolCalls: 0 };
  const t0 = performance.now();
  const phases: Partial<Record<CodeExecPhase, number>> = {};
  let phase: CodeExecPhase | undefined;
  let stopped = false;
  const mark = (p: CodeExecPhase) => {
    if (stopped || phases[p] !== undefined) return;
    phases[p] = performance.now() - t0;
    phase = p;
  };
  let python: PythonRuntime | undefined;
  if (opts.language === "python") {
    mark("provisioning");
    // Provisioning happens before the script timer starts: a cold first call downloads pinned tools and wheels.
    try { python = await providePython(opts.packages ?? [], opts.pythonCacheDir, opts.signal); }
    catch (e) {
      if (opts.signal?.aborted) {
        result.cancelled = true;
        result.phase = phase;
        result.phases = phases;
      }
      result.error = opts.signal?.aborted
        ? "Code Mode cancelled"
        : e instanceof HarnessRejection
          ? e.message
          : `Python provisioning failed: ${message(e)}`;
      return result;
    }
  }
  const names = codeExecCallableNames(opts);
  const sockets = new Set<Socket>();
  const execAbort = new AbortController();
  let child: ChildProcess | undefined, proc: ChildProcess | undefined, dir: string | undefined, output: unknown, sandboxDenial = false;
  let pid: number | undefined, closed = false, closeGraceExpired = false;
  let releaseWait: (() => void) | undefined;
  let closeGraceTimer: ReturnType<typeof setTimeout> | undefined;
  let tail = "";
  let timeoutDetail: string | undefined;
  const fmtSec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(1);
  function buildTimeoutDetail(): string {
    const now = performance.now() - t0;
    const currentPhase = phase ?? "preparing";
    const phaseStart = phases[currentPhase] ?? 0;
    const timeline = (Object.entries(phases) as [CodeExecPhase, number][])
      .map(([name, ms]) => `${name} +${fmtSec(ms)}s`)
      .join(", ");
    const toolsText = result.toolCalls === 0
      ? " No harness tool ran."
      : ` Harness tool calls before the stall: ${result.toolCalls}.`;
    const trimmedTail = tail.trim();
    const tailText = trimmedTail ? ` Last output: ${trimmedTail.slice(-500)}` : "";
    return `Stalled in phase ${currentPhase} for ${fmtSec(now - phaseStart)}s (pid ${pid ?? "none"}; ${timeline}).${toolsText}${tailText}`;
  }
  function kill() {
    if (child?.pid) try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  function stop(reason: string) {
    if (stopped) return;
    stopped = true; result.error = reason;
    if (!execAbort.signal.aborted) execAbort.abort(new Error(reason));
    kill();
    for (const s of sockets) s.destroy();
    if (releaseWait && !closeGraceTimer) {
      closeGraceTimer = setTimeout(() => { releaseWait?.(); }, CLOSE_GRACE_MS);
      closeGraceTimer.unref();
    }
  }
  const abort = () => { if (!stopped) { result.cancelled = true; stop("Code Mode cancelled"); } };
  const effectiveTimeoutMs = timeoutMs(opts.timeoutMs);
  const timer = setTimeout(() => {
    if (!stopped) {
      result.timedOut = true;
      timeoutDetail = buildTimeoutDetail();
      stop(`${codeExecTimeoutError(effectiveTimeoutMs).message}\n${timeoutDetail}`);
    }
  }, effectiveTimeoutMs);
  mark("preparing");
  opts.signal?.addEventListener("abort", abort, { once: true });
  if (opts.signal?.aborted) abort();

  const server = createCodeExecIpcServer({
    names,
    sockets,
    isStopped: () => stopped,
    stop,
    onOutput: (value) => { output = value; },
    onSandboxDenial: (denial) => { sandboxDenial = denial; },
    onToolCall: () => { if (result.toolCalls === 0) mark("first_call"); result.toolCalls++; },
    onPhase: mark,
    onToolEvent: opts.onToolEvent,
    callTool: opts.callTool,
    signal: execAbort.signal,
  });

  try {
    if (stopped) return result;
    const defaultScratch = Buffer.byteLength(join(tmpdir(), "cm-XXXXXX", "ipc")) > 100 ? "/tmp" : tmpdir();
    dir = await realpath(await mkdtemp(join(opts.scratchRoot ?? defaultScratch, "cm-")));
    const socket = join(dir, "ipc");
    if (Buffer.byteLength(socket) >= 104) throw new Error("Code Mode scratch path too long for Unix socket; use a shorter scratchRoot");
    let cmd: string | undefined, args: string[], env: Record<string, string>;
    if (python) {
      [cmd, ...args] = pythonSandboxCommand(python.exe, python.roots, dir, socket);
      env = pythonSandboxEnv(dir);
      const extraPythonTools = [...names]
        .filter((n) => !opts.tools.some((t) => t.name === n))
        .map((name): ToolDefinition => ({ name, description: "", inputSchema: {} }));
      const { module, stubs } = pythonModule(
        pythonTools([...opts.tools, ...extraPythonTools]).map((t) => t.name),
        generatePythonDeclarations(opts.tools),
      );
      await Promise.all([
        writeFile(join(dir, "_cm_bridge.py"), pythonBridge(socket)), writeFile(join(dir, "_cm_guard.py"), pythonGuard),
        writeFile(join(dir, "_cm_entry.py"), pythonEntry(python.sitePackages)), writeFile(join(dir, "script.py"), opts.code),
        writeFile(join(dir, "harness.py"), module), writeFile(join(dir, "harness.pyi"), stubs),
      ]);
    } else {
      [cmd, ...args] = opts.launch
        ? opts.launch(dir, socket)
        : sandboxCommand(await realpath(process.execPath), dir, socket);
      env = sandboxEnv(dir);
      const pkg = join(dir, "node_modules/harness");
      await mkdir(pkg, { recursive: true });
      const exports = [...new Set([...names, "code_exec", "tool_search"])].filter(n => n !== "output")
        .map((n, i) => `const t${i} = args => call(${JSON.stringify(n)}, args); export { t${i} as ${JSON.stringify(n)} };`);
      await Promise.all([
        writeFile(join(dir, "bridge.mjs"), bridge(socket)), writeFile(join(dir, "guard.mjs"), guard + fatalHook),
        writeFile(join(dir, "script.ts"), opts.code),
        writeFile(join(pkg, "package.json"), '{"name":"harness","type":"module","main":"index.mjs","types":"index.d.ts"}'),
        writeFile(join(pkg, "index.d.ts"), generateSdkDeclarations(opts.tools)),
        writeFile(join(pkg, "index.mjs"), `import {call,output} from '../../bridge.mjs'; export {output};\n${exports.join("\n")}`),
      ]);
    }
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
    if (stopped) return result;
    proc = child = spawn(cmd!, args, { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    pid = proc.pid;
    mark("spawned");
    proc.once("exit", () => mark("exited"));
    for (const stream of [proc.stdout!, proc.stderr!]) {
      stream.setEncoding("utf8");
      stream.on("data", (s: string) => { result.logs += s.slice(0, Math.max(0, 8192 - result.logs.length)); tail = (tail + s).slice(-2048); });
    }
    const status = await new Promise<number | null>((resolve, reject) => {
      releaseWait = () => { if (!closed) { closeGraceExpired = true; resolve(null); } };
      proc!.once("error", reject);
      proc!.once("close", (c) => { closed = true; resolve(c); });
    });
    releaseWait = undefined;
    clearTimeout(closeGraceTimer);
    closeGraceTimer = undefined;
    child = undefined;
    if (stopped) {
      if (closeGraceExpired) {
        const graceNote = " The process did not close within 2s of SIGKILL.";
        if (result.error) result.error += graceNote;
        if (timeoutDetail) timeoutDetail += graceNote;
      }
      return result;
    }
    clearTimeout(timer); opts.signal?.removeEventListener("abort", abort);
    // An error report written just before exit may still be buffered on the IPC socket; read it before attributing.
    if (status !== 0 && sockets.size > 0) await Promise.race([
      Promise.all([...sockets].map(s => new Promise(resolve => s.once("close", resolve)))),
      new Promise(resolve => setTimeout(resolve, 100)),
    ]);
    if (status !== 0) throw new Error(formatScriptError(tail.trim() || `${python ? "Python" : "Bun"} exited with status ${status}`, sandboxDenial, names));
    const json = JSON.stringify(output) ?? "";
    const limit = Math.max(0, opts.maxOutputChars ?? 20_000);
    result.preview = json.slice(0, limit);
    if (json.length > limit) {
      if (opts.saveOutput) {
        result.artifactPath = await opts.saveOutput("code-exec.json", json);
      } else {
        const directDir = join(opts.artifactsDir, "direct");
        await mkdir(directDir, { recursive: true });
        result.artifactPath = join(directDir, writeUniqueFile(directDir, "direct-code-exec", ".json", json));
      }
    } else if (output !== undefined) result.output = output;
    result.ok = true;
  } catch (e) { result.error ??= message(e); }
  finally {
    stopped = true; clearTimeout(timer); clearTimeout(closeGraceTimer); opts.signal?.removeEventListener("abort", abort);
    if (!execAbort.signal.aborted) execAbort.abort();
    kill();
    proc?.stdout?.destroy();
    proc?.stderr?.destroy();
    for (const socket of sockets) socket.destroy();
    if (result.timedOut || result.cancelled) {
      result.phase = phase;
      result.phases = phases;
      if (pid !== undefined) result.pid = pid;
    }
    if (result.timedOut && timeoutDetail) {
      console.error(`[harnessd ${new Date().toISOString()}] code_exec timeout: ${timeoutDetail}`);
    }
    if (server.listening) {
      try { await new Promise<void>(resolve => server.close(() => resolve())); } catch {}
    }
    if (dir) {
      try { await rm(dir, { recursive: true, force: true }); }
      catch (e) { console.error(`[harnessd ${new Date().toISOString()}] code_exec cleanup failed: ${dir}: ${message(e)}`); }
    }
  }
  return result;
}
