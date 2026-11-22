import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  CODE_EXEC_TOOL,
  TOOL_SEARCH_TOOL,
  codeModePromptSection,
  createCodeModeExecutor,
  exposedTools,
  generateSdkDeclarations,
  handleCodeModeTool,
  runCodeExec,
  toolSearch,
  type CodeExecOptions,
  type CodeExecToolEvent,
} from "../src/code-mode/index.js";
import type { ToolDefinition } from "../src/runners/types.js";

const lookup: ToolDefinition = {
  name: "lookup_gizmo",
  description: "Find a warehouse gizmo by ID",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string" },
      limit: { type: "integer" },
      zone: { type: "string", enum: ["cold", "ambient"], description: "Storage temperature" },
      filter: {
        type: "object",
        properties: { active: { type: "boolean" }, tags: { type: "array", items: { type: "string" } } },
        required: ["active"],
      },
    },
    required: ["id"],
  },
};
const reserve: ToolDefinition = {
  name: "reserve_bin",
  description: "Reserve an inventory bin",
  inputSchema: {
    type: "object", properties: { bin: { type: "integer" }, quantity: { type: "integer" } },
    required: ["bin", "quantity"],
  },
};

describe("Code Mode discovery", () => {
  it("generates typed harness declarations with required and optional fields", () => {
    const sdk = generateSdkDeclarations([lookup, reserve]);
    assert.match(sdk, /declare\s+module\s+["']harness["']/);
    assert.match(sdk, /\blookup_gizmo\s*\(/);
    assert.match(sdk, /\breserve_bin\s*\(/);
    assert.match(sdk, /["']?\bid["']?\s*:\s*string\b/);
    assert.match(sdk, /["']?\blimit["']?\s*\?\s*:\s*number\b/);
    assert.match(sdk, /\/\*\* Storage temperature \*\//);
    assert.match(sdk, /zone\?: "cold" \| "ambient"/);
    assert.match(sdk, /["']?\bactive["']?\s*:\s*boolean\b/);
    assert.match(sdk, /["']?\btags["']?\s*\?\s*:\s*(?:string\s*\[\s*\]|Array\s*<\s*string\s*>)/);
    assert.match(sdk, /Promise\s*<\s*unknown\s*>/);
    assert.match(sdk, /\boutput\s*\(/);
  });

  it("exposes the mode's surface and searches only the supplied tools", () => {
    const allowed = [lookup, reserve];
    const names = (tools: ToolDefinition[]) => tools.map((tool) => tool.name);
    assert.deepEqual(names(exposedTools(allowed, "collapsed")).sort(), ["code_exec", "tool_search"]);
    const hybrid = names(exposedTools(allowed, "hybrid")).filter((name) => name !== "tool_search");
    assert.deepEqual(hybrid.sort(), ["code_exec", "lookup_gizmo", "reserve_bin"]);
    assert.deepEqual(exposedTools(allowed, "off"), allowed);

    const byDescription = toolSearch(allowed, { query: "warehouse" });
    assert.deepEqual(byDescription.matched, [lookup.name]);
    assert.match(byDescription.signatures, /\blookup_gizmo\s*\(/);
    assert.doesNotMatch(byDescription.signatures, /reserve_bin/);
    const byName = toolSearch(allowed, { names: ["not_allowed", reserve.name] });
    assert.deepEqual(byName.matched, [reserve.name]);
    assert.match(byName.signatures, /\breserve_bin\s*\(/);
    assert.doesNotMatch(byName.signatures, /lookup_gizmo|not_allowed/);
    assert.deepEqual(toolSearch([], { names: [lookup.name] }).matched, []);
  });

  it("documents script conventions only when Code Mode is enabled", () => {
    assert.equal(codeModePromptSection("off"), "");
    for (const mode of ["collapsed", "hybrid"] as const) {
      const prompt = codeModePromptSection(mode);
      for (const pattern of [/tool_search/, /code_exec/, /from\s+["']harness["']/, /top.level.{0,80}await|await.{0,80}top.level/i, /output\s*\(/, /timeout/i, /preview|truncat|externaliz/i]) {
        assert.match(prompt, pattern);
      }
    }
  });
});

describe("Code Mode execution", () => {
  let root: string;
  let scratchRoot: string;
  let artifactsDir: string;

  beforeEach(() => {
    root = mkdtempSync("/tmp/cm-");
    scratchRoot = join(root, "s");
    artifactsDir = join(root, "a");
    mkdirSync(scratchRoot);
    mkdirSync(artifactsDir);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const context = (): Omit<CodeExecOptions, "code" | "timeoutMs"> => ({
    tools: [],
    async callTool(name) { assert.fail(`Unexpected parent tool call: ${name}`); },
    artifactsDir,
    scratchRoot,
  });
  const run = (code: string, options: Partial<Omit<CodeExecOptions, "code">> = {}) =>
    runCodeExec({ ...context(), timeoutMs: 2_000, ...options, code });

  it("dispatches only Code Mode operations and preserves scoped delegation", async () => {
    assert.equal(handleCodeModeTool(lookup.name, { id: "g9" }, context()), undefined);
    assert.deepEqual(
      await handleCodeModeTool("tool_search", { names: [lookup.name, reserve.name] }, { ...context(), tools: [lookup] }),
      toolSearch([lookup], { names: [lookup.name, reserve.name] }),
    );

    let allowed = [lookup];
    const delegated: unknown[] = [];
    const options = {
      allowedTools: () => allowed,
      async execute(name: string, args: Record<string, unknown>) {
        delegated.push({ name, args });
        return { bin: 13 };
      },
      artifactsDir,
      defaultTimeoutMs: 2_000,
    };
    const executor = createCodeModeExecutor({ ...options, mode: "collapsed" });
    assert.deepEqual(executor.tools().map((tool) => tool.name).sort(), ["code_exec", "tool_search"]);
    assert.deepEqual(await executor.execute("tool_search", { names: [lookup.name] }), toolSearch([lookup], { names: [lookup.name] }));
    allowed = [reserve];
    assert.deepEqual(await executor.execute("tool_search", { names: [lookup.name] }), toolSearch([reserve], { names: [lookup.name] }));

    // Existing direct calls still flow through the caller's executor unchanged.
    assert.deepEqual(await executor.execute(lookup.name, { id: "g9" }), { bin: 13 });
    const result = await executor.execute("code_exec", {
      code: 'import { reserve_bin, output } from "harness"; output(await reserve_bin({bin: 2, quantity: 7}));',
    }) as Awaited<ReturnType<typeof runCodeExec>>;
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.output, { bin: 13 });

    const off = createCodeModeExecutor({ ...options, mode: "off" });
    assert.deepEqual(off.tools(), [reserve]);
    assert.deepEqual(await off.execute("code_exec", { code: "not executed" }), { bin: 13 });
    assert.deepEqual(delegated, [
      { name: lookup.name, args: { id: "g9" } },
      { name: reserve.name, args: { bin: 2, quantity: 7 } },
      { name: "code_exec", args: { code: "not executed" } },
    ]);
  });

  it("chains real Bun SDK calls through the parent, emitting events, output, and logs", async () => {
    const events: CodeExecToolEvent[] = [];
    const calls: unknown[] = [];
    const result = await run(`
      import { lookup_gizmo, reserve_bin, output } from "harness";
      console.log("looking up gizmo");
      const item = await lookup_gizmo({ id: "g9", filter: { active: true, tags: ["cold"] } });
      const receipt = await reserve_bin({ bin: item.bin, quantity: item.available - 2 });
      console.error("reservation finished");
      output({ receipt, runtime: Bun.version });
    `, {
      tools: [lookup, reserve],
      onToolEvent: (event) => events.push(event),
      async callTool(name, args) {
        calls.push({ name, args });
        return name === lookup.name ? { bin: 31, available: 8 } : { reserved: args.quantity };
      },
    });
    const expectedCalls = [
      { name: lookup.name, args: { id: "g9", filter: { active: true, tags: ["cold"] } } },
      { name: reserve.name, args: { bin: 31, quantity: 6 } },
    ];
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.output, { receipt: { reserved: 6 }, runtime: Bun.version });
    assert.equal(result.toolCalls, 2);
    assert.match(result.logs, /looking up gizmo/);
    assert.match(result.logs, /reservation finished/);
    assert.deepEqual(calls, expectedCalls);
    assert.deepEqual(events.map(({ phase, name, args, ok, via }) => ({ phase, name, args, ok, via })),
      expectedCalls.flatMap((call) => [
        { ...call, phase: "start", ok: undefined, via: "code_exec" },
        { ...call, phase: "end", ok: true, via: "code_exec" },
      ]));
    assert.deepEqual(readdirSync(scratchRoot), []);
  });

  it("propagates a caller's inner permission denial to the script and end event", async () => {
    const events: CodeExecToolEvent[] = [];
    const result = await run('import { reserve_bin } from "harness"; await reserve_bin({bin: 3, quantity: 2});', {
      tools: [reserve],
      onToolEvent: (event) => events.push(event),
      async callTool() { throw new Error("reservation denied by caller policy"); },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /reservation denied by caller policy/);
    assert.deepEqual(events.map(({ phase, name }) => [phase, name]), [["start", reserve.name], ["end", reserve.name]]);
    assert.equal(events[1]?.ok, false);
    assert.match(events[1]?.error ?? "", /reservation denied by caller policy/);
    assert.deepEqual(readdirSync(scratchRoot), []);
  });

  it("never delegates recursive operations even when passed in the tool list", async () => {
    const delegated: string[] = [];
    for (const [name, args] of [["code_exec", { code: "console.log(1)" }], ["tool_search", { names: [] }]] as const) {
      const result = await run(`import { ${name} } from "harness"; await ${name}(${JSON.stringify(args)});`, {
        tools: [CODE_EXEC_TOOL, TOOL_SEARCH_TOOL],
        async callTool(inner) { delegated.push(inner); },
      });
      assert.equal(result.ok, false, `Expected ${name} to be rejected`);
      assert.ok(result.error, `Missing error for ${name}`);
    }
    assert.deepEqual(delegated, []);
  });

  it("starts in a fresh scratch directory with credential-like env keys removed", async () => {
    const keys = ["CM_TEST_API_KEY", "CM_TEST_TOKEN", "CM_TEST_SECRET", "CM_TEST_PASSWORD", "AWS_CM_TEST_KEY"];
    const saved = keys.map((key) => process.env[key]);
    try {
      for (const key of keys) process.env[key] = "fake-engine-test-credential";
      const result = await run(`
        import { output } from "harness";
        output({ cwd: process.cwd(), leaked: ${JSON.stringify(keys)}.filter(key => key in process.env) });
      `);
      assert.equal(result.ok, true, result.error);
      const output = result.output as { cwd: string; leaked: string[] };
      assert.deepEqual(output.leaked, []);
      // macOS can canonicalize /tmp to /private/tmp in the child cwd.
      assert.ok(output.cwd.replace(/^\/private(?=\/tmp\/)/, "").startsWith(`${scratchRoot}/`), output.cwd);
      assert.equal(existsSync(output.cwd), false);
      assert.deepEqual(readdirSync(scratchRoot), []);
    } finally {
      keys.forEach((key, index) => {
        const value = saved[index];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      });
    }
  });

  it("rejects filesystem writes and child process launches", async () => {
    const fsTarget = join(root, "fs-write");
    const bunTarget = join(root, "bun-write");
    const result = await run(`
      import { output } from "harness";
      import { writeFileSync } from "node:fs";
      import { execFileSync } from "node:child_process";
      const probes = {
        fs: () => writeFileSync(${JSON.stringify(fsTarget)}, "test"),
        bunWrite: () => Bun.write(${JSON.stringify(bunTarget)}, "test"),
        fsScratch: () => writeFileSync("fs-write", "test"),
        bunScratch: () => Bun.write("bun-write", "test"),
        bunSpawn: () => Bun.spawn(["/usr/bin/true"]).exited,
        childProcess: () => execFileSync("/usr/bin/true"),
      };
      const denied = {};
      for (const [key, probe] of Object.entries(probes)) {
        try { await probe(); denied[key] = false; }
        catch { denied[key] = true; }
      }
      output(denied);
    `);
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.output, { fs: true, bunWrite: true, fsScratch: true, bunScratch: true, bunSpawn: true, childProcess: true });
    assert.equal(existsSync(fsTarget), false);
    assert.equal(existsSync(bunTarget), false);
  });

  it("times out a busy child and removes its scratch directory", async () => {
    const result = await run("while (true) {}", { timeoutMs: 150 });
    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true, result.error);
    assert.notEqual(result.cancelled, true);
    assert.deepEqual(readdirSync(scratchRoot), []);
  });

  it("bounds the serialized IPC frame in bytes, not string length", async () => {
    const result = await run('output("界".repeat(6 * 1024 * 1024))');
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /16 MiB/);
    assert.deepEqual(readdirSync(artifactsDir), []);
    assert.deepEqual(readdirSync(scratchRoot), []);
  });

  it("aborts an already running child rather than waiting for its timeout", async () => {
    const controller = new AbortController();
    let called = false;
    const result = await run('import { lookup_gizmo } from "harness"; await lookup_gizmo({id: "g9"}); while (true) {}', {
      signal: controller.signal,
      tools: [lookup],
      async callTool() {
        called = true;
        controller.abort();
        return {};
      },
    });
    assert.equal(called, true, result.error);
    assert.equal(result.ok, false);
    assert.equal(result.cancelled, true, result.error);
    assert.notEqual(result.timedOut, true);
    assert.deepEqual(readdirSync(scratchRoot), []);
  });

  it("externalizes oversized output under the artifact directory and keeps a short preview", async () => {
    const payload = `preview marker ${"x".repeat(4_096)} tail marker`;
    const result = await run(`import { output } from "harness"; output(${JSON.stringify(payload)});`, { maxOutputChars: 128 });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.artifactPath);
    const artifact = isAbsolute(result.artifactPath) ? result.artifactPath : resolve(artifactsDir, result.artifactPath);
    const inside = relative(artifactsDir, artifact);
    assert.ok(inside && !inside.startsWith("..") && !isAbsolute(inside), artifact);
    assert.ok(readFileSync(artifact, "utf8").includes(payload), "expected the full payload in the artifact");
    assert.match(result.preview, /preview marker/);
    assert.doesNotMatch(result.preview, /tail marker/);
    assert.ok(result.preview.length < 512);
    assert.notEqual(result.output, payload);
    assert.deepEqual(readdirSync(scratchRoot), []);
  });
});
