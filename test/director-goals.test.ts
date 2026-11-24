import { withFixtureCatalog } from "./fixtures/launch-config.js";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveGlobalConfig, type AcpProfileConfig, type HarnessConfig } from "../src/config.js";
import { globsOverlap } from "../src/control-plane/db.js";
import { parseReviewerVerdictJson } from "../src/director/runtime.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { GoalRecord } from "../src/goals/engine.js";
import { runGit } from "../src/worktree/manager.js";

async function makeTempRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-goal-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "status.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

describe("Tier 0 Director, Run-Until-Done Goal Engine, Independent Done-Review & Settings Hot-Reload", () => {
  it("runs Tier 0 chat -> Goal Contract -> deterministic gates -> Independent Reviewer anti-sycophancy -> surgical cycle 2 -> achieved", async () => {
    const repoRoot = await makeTempRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-gstate-"));
    const sockPath = join(stateDir, "d.sock");
    let reviewCalls = 0;

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath: sockPath,
      });
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            // Tier 0 Director Chat creates and commits a Goal Contract on user request (and acknowledges event wakeups)
            if (req.taskId.startsWith("chat-")) {
              if (req.initialPrompt.includes("Control-plane event")) {
                return { text: "Noted goal run settlement.", stopReason: "completed" };
              }
              const created = (await req.executeTool("goal_create", {
                title: "Ship greeting file",
                description: "Create greet.txt and pass deterministic verification",
                criteria: [
                  { id: "c1", description: "greet.txt exists", kind: "deterministic", command: "test -f greet.txt", required: true },
                  { id: "c2", description: "Greeting includes world", kind: "behavioral", required: true },
                ],
                commit_immediately: true,
                model: req.model,
              })) as GoalRecord;
              return { text: `Drafted & started goal ${created.id}`, stopReason: "completed" };
            }

            // Independent Done-Reviewer
            if (req.kind === "verify") {
              reviewCalls++;
              if (reviewCalls === 1) {
                // Attempt premature approval WITHOUT satisfying required c2 -> mechanical guard MUST reject!
                await req.executeTool("submit_review_verdict", {
                  verdict: "approved",
                  criteriaResults: [{ criterionId: "c2", passed: false, evidence: "Missing world", remediation: "Add world" }],
                  summary: "Looks mostly fine, approving anyway",
                });
                return { text: "submitted", stopReason: "completed" };
              }
              await req.executeTool("submit_review_verdict", {
                verdict: "approved",
                criteriaResults: [{ criterionId: "c2", passed: true, evidence: "Verified greet.txt contains 'hello world'" }],
                summary: "All criteria verified with concrete evidence.",
              });
              return { text: "approved", stopReason: "completed" };
            }

            return { text: "orchestrator idle", stopReason: "completed" };
          },
        }),
      });

      await daemon.start();
      const client = new DaemonClient(sockPath);
      await client.connect();

      try {
        const opened = (await client.request("chat.open", { repoRoot })) as { session: { id: string } };
        const sent = (await client.request("chat.send", {
          chatSessionId: opened.session.id,
          text: "Let's ship greet.txt",
        })) as { assistantTurn: { content: string } };
        assert.match(sent.assistantTurn.content, /goal-/);

        const goals = (await client.request("goal.list", { repoRoot })) as GoalRecord[];
        assert.equal(goals.length, 1);
        const goal = goals[0]!;
        assert.ok(goal.status === "executing" || goal.status === "awaiting_human", goal.status);

        // Review 1 BEFORE greet.txt exists -> deterministic gate fails at $0 LLM cost (reviewCalls stays 0!)
        const rFail = (await client.request("goal.review", { goalId: goal.id })) as {
          goal: GoalRecord;
          review: { verdict: string };
        };
        assert.equal(rFail.review.verdict, "changes_requested");
        assert.equal(reviewCalls, 0, "LLM reviewer must not be called when deterministic check_cmds fail");

        // Create greet.txt (without 'world') and commit -> deterministic gate passes, Reviewer attempts premature approval -> mechanically rejected!
        writeFileSync(join(repoRoot, "greet.txt"), "hello\n", "utf8");
        await runGit(repoRoot, ["add", "greet.txt"]);
        await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add greet"]);

        const rRejectPremature = (await client.request("goal.review", { goalId: goal.id })) as {
          goal: GoalRecord;
          review: { verdict: string; blockingIssues: string[] };
        };
        assert.equal(reviewCalls, 1);
        assert.equal(rRejectPremature.review.verdict, "changes_requested");
        assert.ok(rRejectPremature.review.blockingIssues.some((b) => b.includes("Mechanical gate rejected premature approval")));

        // Fix greet.txt -> Review 2 approves -> Goal reaches `achieved`!
        writeFileSync(join(repoRoot, "greet.txt"), "hello world\n", "utf8");
        await runGit(repoRoot, ["add", "greet.txt"]);
        await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add world"]);

        const rApproved = (await client.request("goal.review", { goalId: goal.id })) as {
          goal: GoalRecord;
          review: { verdict: string };
        };
        assert.equal(rApproved.review.verdict, "approved");
        assert.equal(rApproved.goal.status, "achieved");

        // Mid-flight dynamic amendment v1 -> v2 re-opens achieved Goal back to `executing`!
        const amended = (await client.request("goal.amend", {
          goalId: goal.id,
          rationale: "Also require uppercase",
          addCriteria: [{ id: "c3", description: "Uppercase greeting", kind: "behavioral", required: true }],
        })) as { goal: GoalRecord; delta: { fromVersion: number; toVersion: number; addedCriteria: unknown[] } };
        assert.equal(amended.delta.fromVersion, 1);
        assert.equal(amended.delta.toVersion, 2);
        assert.equal(amended.goal.status, "executing");
        assert.equal(amended.goal.criteria.length, 3);

        // Anti-spin circuit breaker: 2 identical diff/failure reviews trip `awaiting_human`
        daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c3", passed: false, evidence: "lowercase" }],
          summary: "Still lowercase",
          diffHash: "deadbeef",
        });
        daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c3", passed: false, evidence: "lowercase" }],
          summary: "Still lowercase 2",
          diffHash: "deadbeef",
        });
        const tripped = daemon.director.goals.recordReviewVerdict(goal.id, {
          verdict: "changes_requested",
          criteriaResults: [{ criterionId: "c3", passed: false, evidence: "lowercase" }],
          summary: "Still lowercase 3",
          diffHash: "deadbeef",
        });
        assert.equal(tripped.goal.status, "awaiting_human");
        assert.match(tripped.circuitBreakerTripped ?? "", /circuit breaker/i);

        // Settings & External CLI Manager hot-reload + persistence to config.json
        const customCli: AcpProfileConfig = {
          id: "acp:opencode",
          kind: "acp",
          adapter: "generic",
          command: "opencode",
          args: ["acp"],
          billing: "subscription",
          enabled: true,
        };
        const updatedCfg = (await client.request("profiles.upsert", { profile: customCli })) as HarnessConfig;
        assert.ok(updatedCfg.profiles.some((p) => p.id === "acp:opencode"));

        const patchedCfg = (await client.request("config.update", {
          patch: { quotaEndpoint: { url: "http://127.0.0.1:9090/v1/quota", format: "protobuf" } },
        })) as HarnessConfig;
        assert.equal(patchedCfg.quotaEndpoint?.format, "protobuf");

        const savedFile = join(stateDir, "config.json");
        assert.ok(existsSync(savedFile));
        const persisted = JSON.parse(readFileSync(savedFile, "utf8")) as HarnessConfig;
        assert.ok(persisted.profiles.some((p) => p.id === "acp:opencode"));
        assert.equal(persisted.quotaEndpoint?.url, "http://127.0.0.1:9090/v1/quota");
      } finally {
        client.close();
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

it("logs Director reads and delegates sourced research", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "director-isolation-"));
  let childId = "";
  try {
    writeFileSync(join(repoRoot, "large.txt"), "é".repeat(2500));
    writeFileSync(join(stateDir, "outside.txt"), "private");
    symlinkSync(join(stateDir, "outside.txt"), join(repoRoot, "link.txt"));
    const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, socketPath: join(stateDir, "d.sock"), codeMode: "off" });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.kind === "research") {
            assert.equal(req.toolPolicy, "read_only_workspace");
            req.callbacks.onTextDelta?.("Inspecting status.txt");
            await req.executeTool("return_task", {
              status: "completed", summary: "Status found", sources: [{ path: "status.txt", lines: "1" }],
            });
            return { stopReason: "completed", text: "raw child transcript" };
          }
          assert.equal(req.toolPolicy, "control_plane_only");
          const linked = await req.executeTool("read_file", { path: "link.txt", exception_reason: "Inspect link" }) as { content: string };
          assert.equal(linked.content, "private");
          const snippet = await req.executeTool("read_file", {
            path: "large.txt", max_chars: 10000, exception_reason: "Check encoding",
          }) as { content: string; truncated: boolean };
          assert.equal(Buffer.byteLength(snippet.content), 5000);
          assert.equal(snippet.truncated, false);
          const assignment = { title: "Locate status", objective: "Read status.txt", model: req.model };
          await assert.rejects(req.executeTool("spawn_task", { ...assignment, kind: "execute" }), /only permits/);
          const child = await req.executeTool("spawn_task", { ...assignment, kind: "research" }) as { spawned: string };
          childId = child.spawned;
          const result = await req.executeTool("wait_tasks", { ids: [childId], timeout_s: 2 });
          assert.deepEqual(result, { children: [{
            id: childId, title: assignment.title, kind: "research", status: "completed", summary: "Status found",
            sources: [{ path: "status.txt", lines: "1" }], artifact_paths: [], escalations: [],
          }] });
          return { stopReason: "completed", text: "Status found" };
        },
      }),
    });
    try {
      const chat = await daemon.director.createChat({ repoRoot });
      await daemon.director.sendChatMessage(chat.id, "Locate status");
      const child = daemon.db.getTask(childId);
      assert.equal(child?.tier, 3);
      assert.equal(child?.runId, `director-tasks-${chat.id}`);
      const events = daemon.db.getEventsSince(child!.runId, 0, childId);
      assert.equal(events[0]?.type, "task.created");
      assert.ok(events.some(event => event.type === "agent.text_delta" && (event.payload as { text: string }).text === "Inspecting status.txt"));
      assert.ok(events.some(event => event.type === "task.status" && (event.payload as { to: string }).to === "completed"));
      const notices = daemon.director.chats.getHistory(chat.id).filter(turn => turn.role === "system_notice");
      assert.match(notices[0]!.content, /^Registered project /);
      const reads = notices.slice(1);
      assert.equal(reads.length, 2);
      assert.match(reads[1]!.content, /large\.txt \(5000 bytes\).*Check encoding/);
    } finally {
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("drives unattended auto-verification -> remediation relaunch -> achieved, protects pending timers, and preserves config", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-auto-goal-"));
  const sockPath = join(stateDir, "d.sock");
  let orchGenerations = 0;
  let reviewerSawDiffPatch = false;

  try {
    // 1. Verify globsOverlap path-segment boundary and reviewer JSON parser with code braces
    assert.equal(globsOverlap("src/auth", "src/auth-utils/**"), false);
    assert.equal(globsOverlap("src/auth/**", "src/auth/login.ts"), true);
    const parsed = parseReviewerVerdictJson(
      'Checked `function f() { return { a: 1 }; }`.\n```json\n{"verdict":"approved","criteriaResults":[{"criterionId":"c1","passed":true,"evidence":"ok"}],"summary":"Clean"}\n```',
    );
    assert.equal(parsed?.verdict, "approved");

    // 2. Verify saveGlobalConfig preserves goals and events
    const cfg = withFixtureCatalog({
      ...loadConfig(repoRoot),
      stateDir,
      socketPath: sockPath,
      codeMode: "off",
      goals: { defaultMaxReviewCycles: 6, defaultMaxNoProgressCycles: 3, gateTimeoutMs: 90_000, autoVerifyOnSettle: true },
      events: { fallbackWakeupIntervalSec: 900, wakeDirectorOnGoalSettle: true },
    });
    saveGlobalConfig(cfg);
    const saved = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as HarnessConfig;
    assert.equal(saved.goals.defaultMaxReviewCycles, 6);
    assert.equal(saved.events.fallbackWakeupIntervalSec, 900);

    // 3. Full unattended run-until-done loop: gen 1 misses file -> gate fails -> auto-relaunch gen 2 -> fixes file -> reviewer approves
    const daemon = new HarnessDaemon(cfg, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) {
            return { text: "Acknowledged.", stopReason: "completed" };
          }
          if (req.tier === 1) {
            orchGenerations++;
            if (orchGenerations === 1) {
              // Gen 1 exits without creating out.txt -> deterministic gate should fail and auto-relaunch Gen 2!
              return { text: "First attempt finished prematurely", stopReason: "completed" };
            }
            assert.match(req.initialPrompt, /CHANGES REQUESTED/);
            writeFileSync(join(repoRoot, "out.txt"), "fixed in gen 2\n", "utf8");
            await runGit(repoRoot, ["add", "out.txt"]);
            await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "fix out.txt"]);
            return { text: "Created out.txt in remediation gen 2", stopReason: "completed" };
          }
          if (req.kind === "verify") {
            reviewerSawDiffPatch = req.initialPrompt.includes("fixed in gen 2");
            // Return prose with code braces + fenced JSON (exercising fallback parser)
            return {
              stopReason: "completed",
              text: 'Reviewed diff `const x = { ok: true };`.\n```json\n{"verdict":"approved","criteriaResults":[{"criterionId":"c2","passed":true,"evidence":"out.txt says fixed in gen 2"}],"summary":"Verified"}\n```',
            };
          }
          return { text: "done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    const client = new DaemonClient(sockPath);
    await client.connect();
    try {
      const chat = await daemon.director.createChat({ repoRoot });
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat.id,
        title: "Auto-remediate out.txt",
        description: "Produce out.txt and verify",
        criteria: [
          { id: "c1", kind: "deterministic", description: "out.txt exists", command: "test -f out.txt", required: true },
          { id: "c2", kind: "behavioral", description: "out.txt mentions gen 2", required: true },
        ],
      });
      await daemon.director.commitGoal(goal.id);

      // Wait for the hands-free loop to run Gen 1 -> Fail gate -> Auto-resume Gen 2 -> Pass gate -> Reviewer -> Achieved!
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && daemon.director.goals.getGoal(goal.id)?.status !== "achieved") {
        await new Promise((r) => setTimeout(r, 40));
      }
      assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "achieved");
      assert.equal(orchGenerations, 2, "Failed gate must auto-relaunch Tier 1 generation 2");
      assert.equal(reviewerSawDiffPatch, true, "Done-Reviewer prompt must include actual git diff patch");

      // Verify pending durable timers keep daemon `running: true` so autoQuitWhenIdle never kills it
      const timer = daemon.db.timers.schedule({
        ownerKind: "chat",
        ownerId: chat.id,
        delaySeconds: 3600,
        reason: "Multi-hour unattended check",
      });
      const ping = (await client.request("ping")) as { running?: boolean; liveWork?: string };
      assert.equal(ping.running, true);
      assert.match(ping.liveWork ?? "", /pending timer/);
      daemon.db.timers.cancel(timer.id, "cleanup");

      // Verify contradictory approval (approved + blockingIssues) is rejected mechanically
      const g2 = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat.id,
        title: "Contradictory verdict check",
        description: "Verify blockers prevent approval",
        criteria: [{ id: "c1", kind: "behavioral", description: "Works", required: true }],
      });
      const contra = daemon.director.goals.recordReviewVerdict(g2.id, {
        verdict: "approved",
        criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Checked" }],
        blockingIssues: ["Critical memory leak remains"],
        summary: "Approving despite blocker",
        diffHash: "abc123",
      });
      assert.equal(contra.review.verdict, "changes_requested");
      assert.equal(contra.goal.status, "executing");

      // Verify `runs.stop_all` (`/stop`) stops all active runs cleanly
      const activeRun = daemon.db.createRun({ goal: "Stop me", repoRoot, baseBranch: "main", baseSha: "abc" });
      const activeTask = daemon.db.createTask({
        runId: activeRun.id,
        tier: 1,
        kind: "orchestrator",
        title: "Running",
        objective: "Run",
        profileId: "acp:codex",
      });
      daemon.db.updateTask(activeTask.id, { status: "running" });
      const stopAll = (await client.request("runs.stop_all", { reason: "User /stop" })) as {
        stopped: boolean;
        stoppedRunIds: string[];
      };
      assert.equal(stopAll.stopped, true);
      assert.ok(stopAll.stoppedRunIds.includes(activeRun.id));
      assert.equal(daemon.db.getRun(activeRun.id)?.status, "stopped");
      assert.equal(daemon.db.getTask(activeTask.id)?.status, "cancelled");
    } finally {
      client.close();
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("wakes an idle Director chat when a Director-spawned Tier 3 task settles, skips already-waited tasks, and respects wakeDirectorOnGoalSettle", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-task-wake-"));
  const sockPath = join(stateDir, "d.sock");

  try {
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      events: { ...baseCfg.events, wakeDirectorOnGoalSettle: true },
      stateDir,
      socketPath: sockPath,
    });

    const releaseAsyncTask = Promise.withResolvers<void>();
    const releaseNoWakeTask = Promise.withResolvers<void>();
    const chatPrompts: string[] = [];
    let spawnedAsyncId = "";
    let spawnedWaitId = "";
    let spawnedNoWakeId = "";
    let sawToolDescriptions = false;

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) {
            chatPrompts.push(req.initialPrompt);
            if (!sawToolDescriptions) {
              const spawn = req.tools.find((t) => t.name === "spawn_task");
              const waitT = req.tools.find((t) => t.name === "wait_tasks");
              const waitC = req.tools.find((t) => t.name === "wait_children");
              const resume = req.tools.find((t) => t.name === "resume_task");
              assert.ok(spawn?.description.includes("No turn limit"));
              assert.ok(spawn?.description.includes("daemon wakes this chat"));
              assert.ok(spawn?.description.includes("events.wakeDirectorOnGoalSettle"));
              assert.ok(spawn?.description.includes("completes, fails, blocks, or returns for re-scope"));
              assert.ok(spawn?.description.includes("not on cancel"));
              for (const waitTool of [waitT, waitC]) {
                assert.ok(waitTool?.description.includes("Waits only within this turn"));
                assert.ok(waitTool?.description.includes("events.wakeDirectorOnGoalSettle"));
                assert.ok(waitTool?.description.includes("default on"));
                assert.ok(waitTool?.description.includes("completes, fails, blocks, or returns for re-scope"));
                assert.ok(waitTool?.description.includes("not on cancel"));
              }
              assert.ok(req.systemPrompt.includes("events.wakeDirectorOnGoalSettle"));
              assert.ok(req.systemPrompt.includes("default on"));
              assert.ok(req.systemPrompt.includes("completes, fails, blocks, or returns for re-scope"));
              assert.ok(req.systemPrompt.includes("not on cancel"));
              assert.ok(resume?.description.includes("does not reset or impose any turn limit"));
              sawToolDescriptions = true;
            }
            if (req.initialPrompt.includes("SPAWN_AND_END") && !spawnedAsyncId) {
              const res = (await req.executeTool("spawn_task", {
                kind: "research",
                title: "Async lookup",
                objective: "WAIT_RELEASE_ASYNC",
                model: "fixture/fixture",
              })) as { spawned: string };
              spawnedAsyncId = res.spawned;
              return { text: `Spawned ${res.spawned} and ending turn.`, stopReason: "completed" };
            }
            if (req.initialPrompt.includes("SPAWN_AND_WAIT") && !spawnedWaitId) {
              const res = (await req.executeTool("spawn_task", {
                kind: "research",
                title: "In-turn lookup",
                objective: "COMPLETE_IMMEDIATELY",
                model: "fixture/fixture",
              })) as { spawned: string };
              spawnedWaitId = res.spawned;
              await req.executeTool("wait_tasks", { ids: [res.spawned], timeout_s: 5 });
              return { text: `Consumed ${res.spawned} in-turn.`, stopReason: "completed" };
            }
            if (req.initialPrompt.includes("SPAWN_NO_WAKE") && !spawnedNoWakeId) {
              const res = (await req.executeTool("spawn_task", {
                kind: "research",
                title: "Disabled wake lookup",
                objective: "WAIT_RELEASE_NOWAKE",
                model: "fixture/fixture",
              })) as { spawned: string };
              spawnedNoWakeId = res.spawned;
              return { text: `Spawned ${res.spawned} with wake off.`, stopReason: "completed" };
            }
            return { text: "Handled delegated task settlement.", stopReason: "completed" };
          }
          if (req.initialPrompt.includes("WAIT_RELEASE_ASYNC")) {
            await releaseAsyncTask.promise;
          } else if (req.initialPrompt.includes("WAIT_RELEASE_NOWAKE")) {
            await releaseNoWakeTask.promise;
          }
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Found answer in status.txt",
            sources: [{ path: "status.txt", lines: "1", note: "checked" }],
          });
          return { text: "done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const chat = await daemon.director.createChat({ repoRoot });

      // 1. Spawn and end turn -> settling wakes the idle Director chat with "Delegated task <id>"
      await daemon.director.sendChatMessage(chat.id, "SPAWN_AND_END");
      assert.ok(spawnedAsyncId);
      assert.equal(sawToolDescriptions, true);
      const promptsBeforeRelease = chatPrompts.length;
      releaseAsyncTask.resolve();

      const wakeDeadline = Date.now() + 5_000;
      while (Date.now() < wakeDeadline && chatPrompts.length === promptsBeforeRelease) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(chatPrompts.length, promptsBeforeRelease + 1, "Settling delegated task must wake Director");
      const wakePrompt = chatPrompts[chatPrompts.length - 1]!;
      assert.ok(wakePrompt.includes(`Delegated task ${spawnedAsyncId}`), `Expected Delegated task ${spawnedAsyncId} in wake prompt, got: ${wakePrompt}`);
      assert.ok(wakePrompt.includes(`wait_tasks({ ids: ["${spawnedAsyncId}"] })`));

      // 2. Control: wait_tasks consumed the settled task in-turn -> NO follow-up wake turn
      const beforeInTurn = chatPrompts.length;
      await daemon.director.sendChatMessage(chat.id, "SPAWN_AND_WAIT");
      assert.equal(chatPrompts.length, beforeInTurn + 1);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(chatPrompts.length, beforeInTurn + 1, "Task already consumed via wait_tasks must not trigger a wake");

      // 3. Control: wakeDirectorOnGoalSettle: false -> NO wake turn when task settles after turn ends
      daemon.director.updateConfig({
        ...config,
        events: { ...config.events, wakeDirectorOnGoalSettle: false },
      });
      const beforeNoWake = chatPrompts.length;
      await daemon.director.sendChatMessage(chat.id, "SPAWN_NO_WAKE");
      assert.equal(chatPrompts.length, beforeNoWake + 1);
      releaseNoWakeTask.resolve();
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(chatPrompts.length, beforeNoWake + 1, "wakeDirectorOnGoalSettle=false must suppress delegated-task wake");
    } finally {
      releaseAsyncTask.resolve();
      releaseNoWakeTask.resolve();
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("goal_amend delivers delta to running workers and reports per task", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-amend-workers-state-"));
  const sockPath = join(stateDir, "d.sock");
  try {
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: sockPath,
    });
    const releaseAll = Promise.withResolvers<void>();
    const workersReady = Promise.withResolvers<void>();
    let liveWorkerId = "";
    let queuedWorkerId = "";
    let readyHandles = 0;
    const liveSteers: string[] = [];
    const t1Steers: string[] = [];

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.tier === 1) {
            req.onHandle?.({
              steer: async (msg) => {
                t1Steers.push(msg);
                return true;
              },
              cancel: async () => {
                releaseAll.resolve();
              },
            });
            const r1 = (await req.executeTool("spawn_worker", {
              title: "Worker covering c2",
              objective: "Implement criterion c2 cleanly",
              criteria: "Satisfies c2",
              write_scopes: ["a.txt"],
              model: "fixture/fixture",
            })) as { spawned: string };
            liveWorkerId = r1.spawned;
            const r2 = (await req.executeTool("spawn_worker", {
              title: "Worker covering c1",
              objective: "Implement criterion c1 cleanly",
              criteria: "Satisfies c1",
              write_scopes: ["b.txt"],
              model: "fixture/fixture",
            })) as { spawned: string };
            queuedWorkerId = r2.spawned;
            await releaseAll.promise;
            return { text: "t1 done", stopReason: "completed" };
          }
          if (req.taskId === liveWorkerId) {
            req.onHandle?.({
              steer: async (msg) => {
                liveSteers.push(msg);
                return true;
              },
              cancel: async () => {
                releaseAll.resolve();
              },
            });
            readyHandles += 1;
            if (readyHandles === 2) workersReady.resolve();
            await releaseAll.promise;
            return { text: "live worker done", stopReason: "completed" };
          }
          if (req.taskId === queuedWorkerId) {
            req.onHandle?.({
              steer: async () => false,
              cancel: async () => {
                releaseAll.resolve();
              },
            });
            readyHandles += 1;
            if (readyHandles === 2) workersReady.resolve();
            await releaseAll.promise;
            return { text: "queued worker done", stopReason: "completed" };
          }
          return { text: "ok", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Amend delivery test",
        description: "Test per-task amendment delivery",
        criteria: [
          { id: "c1", description: "Criterion one", kind: "behavioral", required: true },
          { id: "c2", description: "Criterion two", kind: "behavioral", required: true },
        ],
        verificationMode: "none",
      });
      await daemon.director.commitGoal(goal.id);
      await workersReady.promise;

      assert.equal(daemon.db.getTask(liveWorkerId)?.goalVersion, 1);
      assert.equal(daemon.db.getTask(queuedWorkerId)?.goalVersion, 1);

      const amended = await daemon.director.amendGoal(goal.id, {
        removeCriteriaIds: ["c2"],
        rationale: "Scope cut: drop c2",
      });

      const liveEntry = amended.affectedTasks.find((a) => a.taskId === liveWorkerId);
      const queuedEntry = amended.affectedTasks.find((a) => a.taskId === queuedWorkerId);
      assert.ok(liveEntry, "expected affectedTasks entry for live worker");
      assert.ok(queuedEntry, "expected affectedTasks entry for queued worker");
      assert.equal(liveEntry.action, "delivered");
      assert.equal(liveEntry.mode, "native");
      assert.equal(liveEntry.live, true);
      assert.equal(liveEntry.boundVersion, 1);
      assert.deepEqual(liveEntry.scopeHit, ["c2"]);

      assert.equal(queuedEntry.action, "queued");
      assert.equal(queuedEntry.mode, "queued_turn");
      assert.equal(queuedEntry.live, false);
      assert.equal(queuedEntry.boundVersion, 1);
      assert.deepEqual(queuedEntry.scopeHit, []);

      // Live worker received formatted delta and rebound immediately; queued worker stays bound to v1 until drained.
      assert.equal(liveSteers.length, 1);
      assert.ok(liveSteers[0]!.includes("v1 -> v2"));
      assert.ok(liveSteers[0]!.includes("Removed criteria: c2"));
      assert.equal(daemon.db.getTask(liveWorkerId)?.goalVersion, 2);
      assert.equal(daemon.db.getTask(queuedWorkerId)?.goalVersion, 1);

      // T1 steer lists affected tasks and their delivery results.
      assert.ok(t1Steers.some((m) => m.includes(liveWorkerId) && m.includes("delivered") && m.includes(queuedWorkerId) && m.includes("queued")));

      // goal.amendment_task events emitted for both affected tasks.
      const runId = amended.goal.linkedRunId!;
      const events = daemon.db.db
        .prepare("SELECT task_id, payload_json FROM events WHERE run_id = ? AND type = 'goal.amendment_task'")
        .all(runId) as Array<{ task_id: string; payload_json: string }>;
      assert.equal(events.length, 2);
      const byTask = new Map(events.map((e) => [e.task_id, JSON.parse(e.payload_json) as { action: string }]));
      assert.equal(byTask.get(liveWorkerId)?.action, "delivered");
      assert.equal(byTask.get(queuedWorkerId)?.action, "queued");

      // Safety net: any control-plane tool call by the queued worker drains steeringMessages and rebinds to v2.
      const treeRes = (await daemon.orchestrator.toolExecutor.execute(runId, queuedWorkerId, "tree_view", {})) as {
        steeringMessages?: string[];
        tasks: Array<{ id: string; goalVersion: number | null }>;
      };
      assert.ok(Array.isArray(treeRes.steeringMessages) && treeRes.steeringMessages.length === 1);
      assert.ok(treeRes.steeringMessages[0]!.includes("Removed criteria: c2"));
      assert.equal(daemon.db.getTask(queuedWorkerId)?.goalVersion, 2);
    } finally {
      releaseAll.resolve();
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("report_goal_progress drops stale entries with a note and keeps summary", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-stale-progress-state-"));
  const sockPath = join(stateDir, "d.sock");
  try {
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: sockPath,
    });
    const releaseAll = Promise.withResolvers<void>();
    const workerReady = Promise.withResolvers<void>();
    let workerId = "";
    let staleReturnWorkerId = "";
    let readyCount = 0;

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.tier === 1) {
            req.onHandle?.({
              steer: async () => true,
              cancel: async () => releaseAll.resolve(),
            });
            const r1 = (await req.executeTool("spawn_worker", {
              title: "Stale progress worker",
              objective: "Work on v1",
              write_scopes: ["p1.txt"],
              model: "fixture/fixture",
            })) as { spawned: string };
            workerId = r1.spawned;
            const r2 = (await req.executeTool("spawn_worker", {
              title: "Stale return worker",
              objective: "Work on v1 and return",
              write_scopes: ["p2.txt"],
              model: "fixture/fixture",
            })) as { spawned: string };
            staleReturnWorkerId = r2.spawned;
            await releaseAll.promise;
            return { text: "t1 done", stopReason: "completed" };
          }
          req.onHandle?.({
            steer: async () => false,
            cancel: async () => releaseAll.resolve(),
          });
          readyCount += 1;
          if (readyCount === 2) workerReady.resolve();
          await releaseAll.promise;
          return { text: "worker done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        title: "Stale progress test",
        description: "Verify stale progress filtering",
        criteria: [
          { id: "c1", description: "Keep me", kind: "behavioral", required: true },
          { id: "c2", description: "Remove me", kind: "behavioral", required: true },
        ],
        verificationMode: "none",
      });
      await daemon.director.commitGoal(goal.id);
      await workerReady.promise;
      const runId = daemon.director.goals.getGoal(goal.id)!.linkedRunId!;

      // Seed v1 progress including c2 + completed phase before amending.
      await daemon.orchestrator.toolExecutor.execute(runId, workerId, "report_goal_progress", {
        summary: "v1 finished",
        phase: "completed",
        verification_status: "passed",
        criteria_results: [{ criterion_id: "c2", passed: true, evidence: "v1 ok" }],
      });
      assert.equal(daemon.director.goals.getGoal(goal.id)?.liveProgress?.phase, "completed");

      // Amending to v2 drops c2 and clears old-version phase/summary/claims.
      const amended = await daemon.director.amendGoal(goal.id, {
        removeCriteriaIds: ["c2"],
        rationale: "Drop c2 in v2",
      });
      assert.equal(amended.goal.liveProgress, null);

      // Worker still bound to v1 reports passed/completed + removed criterion c2 + a summary.
      assert.equal(daemon.db.getTask(workerId)?.goalVersion, 1);
      const progRes = (await daemon.orchestrator.toolExecutor.execute(runId, workerId, "report_goal_progress", {
        summary: "Progress note from v1 worker",
        phase: "completed",
        verification_status: "passed",
        criteria_results: [{ criterion_id: "c2", passed: true, evidence: "stale check" }],
      })) as {
        recorded: boolean;
        goalId: string;
        dropped?: Array<{ field: string; value: string; reason: string }>;
        note?: string;
        steeringMessages?: string[];
      };

      assert.equal(progRes.recorded, true);
      assert.equal(progRes.goalId, goal.id);
      assert.equal(progRes.dropped?.length, 3);
      assert.ok(progRes.note && progRes.note.includes("c2") && progRes.note.includes("v1"));
      assert.ok(progRes.steeringMessages?.length === 1, "queued amendment steer should piggyback on tool result");

      const stored = daemon.director.goals.getGoal(goal.id)!;
      assert.equal(stored.liveProgress?.summary, "Progress note from v1 worker");
      assert.equal(stored.liveProgress?.verificationStatus, undefined);
      assert.equal(stored.liveProgress?.phase, undefined);
      assert.equal(stored.liveProgress?.criteriaResults, undefined);

      // Stale worker calling return_task is accepted with amendmentNotice and staleGoalVersion in resultJson.
      assert.equal(daemon.db.getTask(staleReturnWorkerId)?.goalVersion, 1);
      const retRes = (await daemon.orchestrator.toolExecutor.execute(runId, staleReturnWorkerId, "return_task", {
        status: "completed",
        summary: "Finished old v1 assignment",
        sources: [],
      })) as { returned: boolean; amendmentNotice?: string; staleGoalVersion?: { bound: number; current: number } };
      assert.equal(retRes.returned, true);
      assert.ok(retRes.amendmentNotice?.includes("v2"));
      assert.deepEqual(retRes.staleGoalVersion, { bound: 1, current: 2 });
      const settledTask = daemon.db.getTask(staleReturnWorkerId)!;
      assert.equal(settledTask.goalVersion, 1, "settled stale worker must keep its bound goalVersion");
      assert.deepEqual(JSON.parse(settledTask.resultJson!).staleGoalVersion, { bound: 1, current: 2 });
    } finally {
      releaseAll.resolve();
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("goal_get shows task goalVersion and staleGoalVersion", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-goal-version-state-"));
  const sockPath = join(stateDir, "d.sock");
  try {
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: sockPath,
    });
    const releaseAll = Promise.withResolvers<void>();
    const workerReady = Promise.withResolvers<void>();
    let workerId = "";
    let goalId = "";
    type GoalGetRes = {
      tasks: Array<{ id: string; goalVersion: number | null; staleGoalVersion: boolean }>;
      activity: { tasks: Array<{ id: string; goalVersion?: number | null; lastAmendmentAction?: string | null }> } | null;
    };
    let goalGetResult: GoalGetRes | undefined;

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) {
            goalGetResult = (await req.executeTool("goal_get", { goal_id: goalId })) as GoalGetRes;
            return { text: "inspected", stopReason: "completed" };
          }
          if (req.tier === 1) {
            req.onHandle?.({
              steer: async () => true,
              cancel: async () => releaseAll.resolve(),
            });
            const r = (await req.executeTool("spawn_worker", {
              title: "v1 worker",
              objective: "Do work",
              write_scopes: ["v.txt"],
              model: "fixture/fixture",
            })) as { spawned: string };
            workerId = r.spawned;
            await releaseAll.promise;
            return { text: "t1 done", stopReason: "completed" };
          }
          req.onHandle?.({
            steer: async () => false,
            cancel: async () => releaseAll.resolve(),
          });
          workerReady.resolve();
          await releaseAll.promise;
          return { text: "w done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const chat = await daemon.director.createChat({ repoRoot });
      const goal = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "Goal version visibility",
        description: "Check goal_get task version fields",
        criteria: [{ id: "c1", description: "Works", kind: "behavioral", required: true }],
        verificationMode: "none",
      });
      goalId = goal.id;
      await daemon.director.commitGoal(goal.id);
      await workerReady.promise;

      await daemon.director.amendGoal(
        goal.id,
        {
          appendDescription: "Extra requirement in v2",
          rationale: "Add v2 scope",
        },
        { source: "director", actorChatSessionId: chat.id },
      );

      await daemon.director.sendChatMessage(chat.id, "inspect goal");
      assert.ok(goalGetResult, "expected goal_get result");
      const got = goalGetResult;

      const workerRow = got.tasks.find((t) => t.id === workerId);
      const t1Row = got.tasks.find((t) => t.id !== workerId);
      assert.ok(workerRow, "expected worker row in goal_get.tasks");
      assert.ok(t1Row, "expected T1 row in goal_get.tasks");
      assert.equal(workerRow.goalVersion, 1);
      assert.equal(workerRow.staleGoalVersion, true);
      assert.equal(t1Row.goalVersion, 2);
      assert.equal(t1Row.staleGoalVersion, false);

      const actWorker = got.activity?.tasks.find((t) => t.id === workerId);
      assert.equal(actWorker?.goalVersion, 1);
      assert.equal(actWorker?.lastAmendmentAction, "queued");
    } finally {
      releaseAll.resolve();
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
