import { withFixtureCatalog } from "./fixtures/launch-config.js";
import assert from "node:assert/strict";
import { it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { effectiveCodeMode, type CodeExecResult } from "../src/code-mode/index.js";
import { loadConfig, type HarnessConfig } from "../src/config.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { RunAgentRequest, ToolDefinition } from "../src/runners/types.js";

async function withDirector(
  mode: HarnessConfig["codeMode"],
  script: (req: RunAgentRequest, bridge: DaemonClient) => Promise<void>,
  test: (daemon: HarnessDaemon, repoRoot: string, chatId: string) => Promise<void>,
): Promise<void> {
  const repoRoot = mkdtempSync(join(tmpdir(), "director-code-"));
  const socketPath = join(repoRoot, "d.sock");
  const daemon = new HarnessDaemon(withFixtureCatalog({
    ...loadConfig(repoRoot), stateDir: repoRoot, socketPath, codeMode: mode, codeExec: { maxOutputChars: 12 },
  }), {
    dbPath: ":memory:",
    customRunnerFactory: () => ({
      run: async (req) => {
        await script(req, bridge);
        return { text: "done", stopReason: "completed" };
      },
    }),
  });
  const bridge = new DaemonClient(socketPath);
  try {
    await daemon.start();
    await bridge.connect();
    const profileId = daemon.config.profiles.find((p) => p.enabled !== false)!.id;
    const chat = daemon.director.chats.createSession({ repoRoot, profileId });
    await test(daemon, chat.repoRoot, chat.id);
  } finally {
    bridge.close();
    await daemon.stop();
    rmSync(repoRoot, { recursive: true, force: true });
  }
}

function callBridge(bridge: DaemonClient, req: RunAgentRequest, name: string, args: Record<string, unknown>) {
  return bridge.request("tool.call", { runId: req.runId, taskId: req.taskId, name, args });
}

for (const mode of ["collapsed", "hybrid", "off"] as const) {
  it(`exposes the same ${mode} Director tools to the runner and MCP`, async () => {
    await withDirector(mode, async (req, bridge) => {
      const tools = await callBridge(bridge, req, "__list_tools", {}) as ToolDefinition[];
      assert.deepEqual(tools, req.tools);
      const names = tools.map((tool) => tool.name);
      if (effectiveCodeMode(mode) === "collapsed") assert.deepEqual(names, ["read_file", "tool_search", "code_exec"]);
      else assert.ok(names.includes("goal_list"));
      if (effectiveCodeMode(mode) === "off") {
        assert.ok(!names.includes("tool_search") && !names.includes("code_exec"));
        assert.doesNotMatch(req.systemPrompt, /## Code Mode/);
        await assert.rejects(req.executeTool("code_exec", { code: "" }), /Unknown Director tool/);
        await assert.rejects(callBridge(bridge, req, "tool_search", {}), /Unknown Director tool/);
      } else {
        assert.ok(names.includes("code_exec"));
        assert.match(req.systemPrompt, /import .* from "harness"/);
        const found = await callBridge(bridge, req, "tool_search", { names: ["read_file", "submit_review_verdict"] });
        assert.deepEqual((found as { matched: string[] }).matched, ["read_file"]);
      }
    }, async ({ director }, _, chatId) => { await director.sendChatMessage(chatId, "show tools"); });
  });
}

it.skipIf(effectiveCodeMode("collapsed") === "off")("runs Director tools in the chat workspace and forwards nested MCP events", async () => {
  const events: { id?: string; name: string; status: string; via?: string }[] = [];
  await withDirector("collapsed", async (req, bridge) => {
    const code = 'import { read_file, output } from "harness"; output((await read_file({ path: "note.txt", exception_reason: "Check fixture bytes" })).content);';
    const result = await callBridge(bridge, req, "code_exec", { code }) as CodeExecResult;
    assert.equal(result.ok, true, result.error);
    assert.equal(result.preview, '"Director wo');
    assert.ok(result.artifactPath);
    assert.equal(dirname(result.artifactPath), join(req.cwd, ".harness", "artifacts"));
    assert.equal(JSON.parse(readFileSync(result.artifactPath, "utf8")), "Director workspace note");
  }, async ({ director }, repoRoot, chatId) => {
    writeFileSync(join(repoRoot, "note.txt"), "Director workspace note");
    await director.sendChatMessage(chatId, "read note", undefined, (ev) => events.push(ev));
    assert.deepEqual(events.map(({ name, status, via }) => [name, status, via]), [
      ["read_file", "in_progress", "code_exec"], ["read_file", "completed", "code_exec"],
    ]);
    assert.ok(events[0]?.id);
    assert.equal(events[0].id, events[1]?.id);
  });
});

it.skipIf(effectiveCodeMode("collapsed") === "off")("cancels both runner-local and MCP Code Mode calls with one chat cancellation", async () => {
  let completedCalls = 0;
  const startedIds = new Set<string>();
  await withDirector("collapsed", async (req, bridge) => {
    const code = 'import { kb_search } from "harness"; await kb_search({}); await Bun.sleep(60_000);';
    const args = { code, timeout_s: 3 };
    const results = await Promise.all([
      req.executeTool("code_exec", args),
      callBridge(bridge, req, "code_exec", args),
    ]) as CodeExecResult[];
    assert.equal(req.signal.aborted, true);
    assert.ok(results.every((result) => !result.ok && result.cancelled && !result.timedOut));
  }, async ({ director }, _, chatId) => {
    await director.sendChatMessage(chatId, "wait", undefined, ({ id, name, status }) => {
      if (name === "kb_search" && status === "in_progress" && id) startedIds.add(id);
      if (name === "kb_search" && status === "completed" && ++completedCalls === 2) director.cancelChat(chatId);
    });
    assert.equal(startedIds.size, 2);
    assert.equal(completedCalls, 2);
    assert.equal(director.isChatBusy(chatId), false);
  });
});

it("keeps the independent reviewer read-only with its native verdict tool in collapsed mode", async () => {
  await withDirector("collapsed", async (req) => {
    assert.equal(req.toolPolicy, "read_only_workspace");
    assert.deepEqual(req.tools.map((tool) => tool.name), ["submit_review_verdict"]);
    assert.doesNotMatch(req.systemPrompt, /## Code Mode/);
    await req.executeTool("submit_review_verdict", {
      verdict: "approved", summary: "Verified", criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Observed" }],
    });
  }, async ({ director }, repoRoot, chatId) => {
    const goal = director.goals.createGoal({
      repoRoot, chatSessionId: chatId, title: "Review", description: "Check isolation",
      criteria: [{ id: "c1", kind: "behavioral", description: "Reviewer tools isolated" }],
    });
    const { review } = await director.verifyAndReviewGoal(goal.id);
    assert.equal(review.verdict, "approved");
  });
});

it("T3-16: Director paths are observed once; inner and failed calls leave findings queued for the next top-level result", async () => {
  let phase: "spawn" | "failed_queued" | "inner_fallback" = "spawn";
  let spawnedId = "";
  await withDirector("off", async (req) => {
    if (req.kind === "research") {
      await req.executeTool("return_task", {
        status: "completed",
        summary: "Found",
        sources: [{ path: "seed.txt", lines: "1" }],
      });
      return;
    }
    if (phase === "spawn") {
      const res = (await req.executeTool("spawn_task", {
        title: "Bounded search",
        objective: "Inspect seed.txt using at most 40 tool calls",
        kind: "research",
        model: req.model,
      })) as { spawned: string; harness_advisory?: string[] };
      spawnedId = res.spawned;
      assert.ok(spawnedId);
      assert.equal(res.harness_advisory?.length, 1);
      assert.match(res.harness_advisory![0]!, /^\[harness advisory: brief-count-limit\] .+ Why: .+ Instead: .+/);
      return;
    }

    if (phase === "failed_queued") {
      // (b) a failed top-level call returns no harness_advisory and leaves a queued finding for the next top-level result.
      let caughtErr: unknown;
      try {
        await req.executeTool("read_file", { path: "missing-top-level.ts" });
      } catch (err) {
        caughtErr = err;
      }
      assert.ok(caughtErr instanceof Error);
      assert.equal("harness_advisory" in caughtErr, false);
      assert.ok(!caughtErr.message.includes("[harness advisory:"));

      // Next top-level plain-object result receives the queued finding.
      const nextRes = (await req.executeTool("read_file", { path: "seed.txt" })) as {
        content: string;
        harness_advisory?: string[];
      };
      assert.ok(nextRes.content.includes("hello"));
      assert.equal(nextRes.harness_advisory?.length, 1);
      assert.match(nextRes.harness_advisory![0]!, /^\[harness advisory: queued-check\] /);
      return;
    }

    // Fallback check when OS sandbox is unavailable: verify queued inner finding arrives on next top-level result.
    const topRes = (await req.executeTool("read_file", { path: "seed.txt" })) as {
      content: string;
      harness_advisory?: string[];
    };
    assert.ok(topRes.content.includes("hello"));
    assert.equal(topRes.harness_advisory?.length, 1);
    assert.match(topRes.harness_advisory![0]!, /^\[harness advisory: director-self-reading\] .+ Why: .+ Instead: .+/);
  }, async ({ director, orchestrator, db }, repoRoot, chatId) => {
    writeFileSync(join(repoRoot, "seed.txt"), "hello\n", "utf8");

    // Idle MCP path uses a throwaway turn state and settles after the call.
    const idleRead = (await director.executeDirectorMcpTool(chatId, "read_file", { path: "seed.txt" })) as {
      content: string;
      harness_advisory?: string[];
    };
    assert.ok(idleRead.content.includes("hello"));
    assert.equal(idleRead.harness_advisory, undefined);
    assert.deepEqual(orchestrator.advisories.take(`chat:${chatId}`), []);

    phase = "spawn";
    await director.sendChatMessage(chatId, "search seed");
    assert.ok(spawnedId);
    const child = db.getTask(spawnedId);
    assert.ok(child, "task must be spawned");
    const advEvents = db
      .getEventsSince(child.runId, 0)
      .filter((ev) => ev.type === "agent.advisory");
    assert.equal(advEvents.length, 1, "must record exactly one agent.advisory event in the bucket run");
    const payload = advEvents[0]!.payload as { rule: string; delivery: string };
    assert.equal(payload.rule, "brief-count-limit");
    assert.equal(payload.delivery, "tool_result");

    phase = "failed_queued";
    orchestrator.advisories.post(
      {
        id: `chat:${chatId}`,
        taskId: null,
        runId: null,
        role: "director",
        readOnly: true,
        brief: { text: "", pathHints: [] },
        writeScopes: [],
        writableExtraRoots: [],
        workspaceRoot: repoRoot,
      },
      {
        level: "advisory",
        rule: "queued-check",
        what: "A prior finding is queued.",
        why: "Failed calls cannot carry advisories.",
        alternative: "Deliver on the next plain-object result.",
      },
      { key: "queued-check", lifetime: "subject" },
    );
    await director.sendChatMessage(chatId, "test queued delivery across failure");

    if (effectiveCodeMode("collapsed") === "off") {
      // Simulate 12 inner script read_file observations (inScript: true) across 3 areas:
      // observeHarness returns [] on every inner call and leaves the finding queued for the next top-level call.
      const dirSubject = {
        id: `chat:${chatId}`,
        taskId: null,
        runId: null,
        role: "director" as const,
        readOnly: true,
        brief: { text: "Analyze the codebase", pathHints: [] },
        writeScopes: [],
        writableExtraRoots: [],
        workspaceRoot: repoRoot,
      };
      for (const area of ["src/a", "src/b", "src/c"]) {
        for (let i = 1; i <= 4; i++) {
          const p = `${area}/f${i}.ts`;
          const innerNotices = orchestrator.advisories.observeHarness(dirSubject, {
            origin: "result",
            surface: "harness",
            tool: "read_file",
            status: "completed",
            args: { path: p },
            paths: [p],
            result: { content: p },
            inScript: true,
          });
          assert.deepEqual(innerNotices, [], "inner script calls must never emit notices directly");
        }
      }
      phase = "inner_fallback";
      await director.sendChatMessage(chatId, "deliver queued inner advisory");
    }
  });

  if (effectiveCodeMode("collapsed") !== "off") {
    let cmPhase: "reads" | "spawn" = "reads";
    let spawnedFromScript = "";
    await withDirector("collapsed", async (req, bridge) => {
      if (req.kind === "research") {
        await req.executeTool("return_task", {
          status: "completed",
          summary: "Done",
          sources: [{ path: "src/a/f1.ts", lines: "1" }],
        });
        return;
      }

      if (cmPhase === "reads") {
        const code = `
          import { read_file, output } from "harness";
          const paths = [
            "src/a/f1.ts","src/a/f2.ts","src/a/f3.ts","src/a/f4.ts",
            "src/b/f1.ts","src/b/f2.ts","src/b/f3.ts","src/b/f4.ts",
            "src/c/f1.ts","src/c/f2.ts","src/c/f3.ts","src/c/f4.ts",
          ];
          const innerAdvisories = [];
          for (const p of paths) {
            const r = await read_file({ path: p });
            if (r && typeof r === "object" && "harness_advisory" in r) innerAdvisories.push(p);
          }
          let innerErrHadAdvisory = false;
          try {
            await read_file({ path: "does-not-exist.ts" });
          } catch (e) {
            if (String(e).includes("harness_advisory") || String(e).includes("[harness advisory:")) {
              innerErrHadAdvisory = true;
            }
          }
          output({ innerAdvisories, innerErrHadAdvisory, readCount: paths.length });
        `;
        const res = (await callBridge(bridge, req, "code_exec", { code })) as CodeExecResult & {
          harness_advisory?: string[];
        };
        assert.equal(res.ok, true, res.error);
        const parsed = res.artifactPath
          ? (JSON.parse(readFileSync(res.artifactPath, "utf8")) as {
              innerAdvisories: string[];
              innerErrHadAdvisory: boolean;
              readCount: number;
            })
          : (res.output as { innerAdvisories: string[]; innerErrHadAdvisory: boolean; readCount: number });
        assert.equal(parsed.readCount, 12);
        assert.deepEqual(parsed.innerAdvisories, [], "inner script calls must never receive harness_advisory");
        assert.equal(parsed.innerErrHadAdvisory, false, "inner failed call must carry no advisory");
        assert.equal(res.harness_advisory?.length, 1, "outer code_exec must carry the queued advisory");
        assert.match(res.harness_advisory![0]!, /^\[harness advisory: director-self-reading\] .+ Why: .+ Instead: .+/);
      } else {
        const code = `
          import { spawn_task, output } from "harness";
          const r = await spawn_task({
            title: "Script search",
            objective: "Check src with at most 40 tool calls",
            kind: "research",
            model: ${JSON.stringify(req.model)},
          });
          output({ spawned: r.spawned, innerHasAdvisory: "harness_advisory" in r });
        `;
        const res = (await req.executeTool("code_exec", { code })) as CodeExecResult & {
          harness_advisory?: string[];
        };
        assert.equal(res.ok, true, res.error);
        const parsed = res.artifactPath
          ? (JSON.parse(readFileSync(res.artifactPath, "utf8")) as { spawned: string; innerHasAdvisory: boolean })
          : (res.output as { spawned: string; innerHasAdvisory: boolean });
        spawnedFromScript = parsed.spawned;
        assert.ok(spawnedFromScript);
        assert.equal(parsed.innerHasAdvisory, false, "inner spawn_task result must not carry harness_advisory");
        assert.equal(res.harness_advisory?.length, 1);
        assert.match(res.harness_advisory![0]!, /^\[harness advisory: brief-count-limit\] /);
      }
    }, async ({ director, db }, repoRoot, chatId) => {
      for (const area of ["src/a", "src/b", "src/c"]) {
        mkdirSync(join(repoRoot, area), { recursive: true });
        for (let i = 1; i <= 4; i++) {
          writeFileSync(join(repoRoot, area, `f${i}.ts`), `export const x = "${area}/f${i}.ts";\n`, "utf8");
        }
      }

      cmPhase = "reads";
      await director.sendChatMessage(chatId, "Analyze the codebase");

      cmPhase = "spawn";
      await director.sendChatMessage(chatId, "Delegate a check");
      assert.ok(spawnedFromScript);
      const child = db.getTask(spawnedFromScript);
      assert.ok(child);
      const advEvents = db
        .getEventsSince(child.runId, 0)
        .filter((ev) => ev.type === "agent.advisory");
      assert.equal(advEvents.length, 1, "bucket run must have exactly one agent.advisory event");
      assert.equal((advEvents[0]!.payload as { rule: string }).rule, "brief-count-limit");
    });
  }
});
