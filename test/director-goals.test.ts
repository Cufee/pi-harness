import { withFixtureCatalog } from "./fixtures/launch-config.js";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveGlobalConfig, type AcpProfileConfig, type HarnessConfig } from "../src/config.js";
import { globsOverlap } from "../src/control-plane/db.js";
import { parseReviewerVerdictJson } from "../src/director/runtime.js";
import { DaemonClient } from "../src/daemon/remote.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { GoalRecord, GoalReviewVerdict } from "../src/goals/engine.js";
import type { ChatControlEvent } from "../src/protocol/chat-events.js";
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
  const outsideDir = mkdtempSync(join(tmpdir(), "director-outside-"));
  let childId = "";
  try {
    writeFileSync(join(repoRoot, "large.txt"), "é".repeat(2500));
    writeFileSync(join(outsideDir, "outside.txt"), "private");
    symlinkSync(join(outsideDir, "outside.txt"), join(repoRoot, "link.txt"));
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
    rmSync(outsideDir, { recursive: true, force: true });
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

it("verifies deterministic gates at verify_ref without touching primary checkout, reports GateLocation, handles remote-only/unknown refs, and supports metadata-only goal_amend verify_ref", async () => {
  const repoRoot = await makeTempRepo();
  const originDir = mkdtempSync(join(tmpdir(), "pi-harness-verify-origin-"));
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-verify-ref-state-"));
  const sockPath = join(stateDir, "d.sock");
  try {
    const mainSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
    await runGit(repoRoot, ["checkout", "-b", "feature"]);
    writeFileSync(join(repoRoot, "only-on-feature.txt"), "feature work\n", "utf8");
    await runGit(repoRoot, ["add", "only-on-feature.txt"]);
    await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "feat: branch work"]);
    const featureSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
    await runGit(repoRoot, ["checkout", "main"]);
    await runGit(originDir, ["init", "--bare", "-b", "main"]);
    await runGit(repoRoot, ["remote", "add", "origin", originDir]);
    await runGit(repoRoot, ["push", "origin", "main"]);
    await runGit(repoRoot, ["push", "origin", `${featureSha}:refs/tags/v1.0-remote`]);

    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
      stateDir,
      socketPath: sockPath,
    });

    type ToolAction = (executeTool: (name: string, args: Record<string, unknown>) => Promise<unknown>, tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>) => Promise<void>;
    let nextChatAction: ToolAction | null = null;

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) {
            if (nextChatAction) {
              const fn = nextChatAction;
              nextChatAction = null;
              await fn(req.executeTool, req.tools);
            }
            return { text: "ok", stopReason: "completed" };
          }
          return { text: "idle", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const chat = await daemon.director.createChat({ repoRoot });

      // 1. Gate sees produced branch via verify_ref; primary checkout untouched; _verify worktree removed.
      let gFeature!: GoalRecord;
      let gFeatureReview!: { goal: GoalRecord; review: GoalReviewVerdict };
      nextChatAction = async (executeTool, tools) => {
        const createTool = tools.find((t) => t.name === "goal_create");
        assert.ok(createTool?.description.includes("_verify"));
        assert.ok(createTool?.description.includes("HARNESS_VERIFY_REF"));
        assert.ok(createTool?.description.includes("HARNESS_VERIFY_SHA"));
        assert.ok(createTool?.description.includes("criteriaResults[].gate"));
        assert.equal(createTool?.description.includes("The primary checkout is never modified."), false);
        assert.ok(createTool?.description.includes("primary checkout"));

        // Invalid verify_ref values (destination refspecs, leading -/+, whitespace, bad ref format) are rejected.
        for (const badRef of ["a:b", "+x:refs/heads/main", "-foo", "+main", "foo bar", "foo..bar", "origin/-x", "origin/+x"]) {
          await assert.rejects(
            () =>
              executeTool("goal_create", {
                title: "Bad verify_ref",
                description: "Should fail validation",
                verify_ref: badRef,
                verification_mode: "deterministic",
                criteria: [{ id: "c1", description: "t", kind: "deterministic", command: "true", required: true }],
              }),
            /Invalid verify_ref/,
            `expected goal_create to reject '${badRef}'`,
          );
        }

        gFeature = (await executeTool("goal_create", {
          title: "Verify feature branch",
          description: "Check only-on-feature.txt at verify_ref",
          verify_ref: "feature",
          verification_mode: "deterministic",
          criteria: [
            {
              id: "c1",
              description: "only-on-feature.txt exists at verified SHA",
              kind: "deterministic",
              command: 'test -f only-on-feature.txt && test "$(git rev-parse HEAD)" = "$HARNESS_VERIFY_SHA" && test "$HARNESS_VERIFY_REF" = "feature"',
              required: true,
            },
          ],
        })) as GoalRecord;
        gFeatureReview = (await executeTool("goal_trigger_review", { goal_id: gFeature.id })) as {
          goal: GoalRecord;
          review: GoalReviewVerdict;
        };
      };
      await daemon.director.sendChatMessage(chat.id, "create and verify feature goal");

      assert.equal(gFeature.verifyRef, "feature");
      assert.equal(gFeatureReview.review.verdict, "approved");
      assert.equal(gFeatureReview.goal.status, "achieved");
      const g1Gate = gFeatureReview.review.criteriaResults[0]?.gate;
      assert.ok(g1Gate, "expected gate location on criterion result");
      assert.equal(g1Gate.ref, "feature");
      assert.equal(g1Gate.sha, featureSha);
      assert.equal(g1Gate.isolated, true);
      assert.equal(g1Gate.source, "verify_ref");
      assert.ok(g1Gate.cwd.includes("/_verify/"), `expected _verify worktree cwd, got ${g1Gate.cwd}`);
      assert.ok(
        gFeatureReview.review.criteriaResults[0]!.evidence.startsWith(`[at feature@${featureSha.slice(0, 7)}]`),
        `expected evidence prefix, got ${gFeatureReview.review.criteriaResults[0]!.evidence}`,
      );

      // Primary checkout unchanged and _verify worktree removed.
      assert.equal((await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout, "main");
      assert.equal(existsSync(join(repoRoot, "only-on-feature.txt")), false);
      assert.equal((await runGit(repoRoot, ["status", "--porcelain"])).stdout, "");
      const wtList = (await runGit(repoRoot, ["worktree", "list", "--porcelain"])).stdout;
      assert.equal(wtList.includes("_verify"), false, `expected _verify cleaned up: ${wtList}`);
      assert.equal(existsSync(g1Gate.cwd), false, "expected _verify directory removed from disk");

      // 2. Control: without verify_ref, gate runs at run.baseBranch and notes unchanged commit + verify_ref.
      const gControl = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "Control without verify_ref",
        description: "Verify on baseBranch with no merged commits",
        verificationMode: "deterministic",
        criteria: [
          {
            id: "c1",
            description: "only-on-feature.txt exists",
            kind: "deterministic",
            command: "test -f only-on-feature.txt",
            required: true,
          },
        ],
      });
      const controlRun = daemon.db.createRun({ goal: gControl.title, repoRoot, baseBranch: "main", baseSha: mainSha });
      daemon.director.goals.linkRunAndStart(gControl.id, controlRun.id);

      const controlRes = await daemon.director.verifyAndReviewGoal(gControl.id);
      assert.equal(controlRes.review.verdict, "changes_requested");
      const controlGate = controlRes.review.criteriaResults[0]?.gate;
      assert.ok(controlGate);
      assert.equal(controlGate.source, "run_base_branch");
      assert.equal(controlGate.ref, "main");
      assert.equal(controlGate.sha, mainSha);
      assert.equal(controlGate.isolated, true);
      assert.ok(controlGate.note?.includes("no work merged"), `expected unchanged-commit note, got ${controlGate.note}`);
      assert.ok(controlGate.note?.includes("verify_ref"), `expected verify_ref hint, got ${controlGate.note}`);
      assert.ok(controlRes.review.summary.includes("no work merged"), controlRes.review.summary);
      assert.ok(controlRes.review.summary.includes("verify_ref"), controlRes.review.summary);

      // 3. Remote-only ref via refs/remotes/origin/feature + metadata-only goal_amend verify_ref.
      await runGit(repoRoot, ["branch", "-D", "feature"]);
      await runGit(repoRoot, ["update-ref", "refs/remotes/origin/feature", featureSha]);

      const beforeAmend = daemon.director.goals.getGoal(gControl.id)!;
      let amendRes!: { goal: GoalRecord; metadataOnly?: boolean; hint?: string };
      nextChatAction = async (executeTool) => {
        amendRes = (await executeTool("goal_amend", {
          goal_id: gControl.id,
          rationale: "Point verification at remote feature branch",
          verify_ref: "feature",
        })) as { goal: GoalRecord; metadataOnly?: boolean; hint?: string };
      };
      await daemon.director.sendChatMessage(chat.id, "amend verify_ref only");

      assert.equal(amendRes.metadataOnly, true);
      assert.equal(amendRes.goal.version, beforeAmend.version, "verify_ref-only amend must not bump version");
      assert.equal(amendRes.goal.status, beforeAmend.status, "verify_ref-only amend must not change status");
      assert.equal(amendRes.goal.verifyRef, "feature");
      assert.ok(amendRes.hint?.includes("goal_trigger_review"), amendRes.hint);

      const remoteRes = await daemon.director.verifyAndReviewGoal(gControl.id);
      assert.equal(remoteRes.review.verdict, "approved");
      assert.equal(remoteRes.goal.status, "achieved");
      const remoteGate = remoteRes.review.criteriaResults[0]?.gate;
      assert.equal(remoteGate?.ref, "origin/feature");
      assert.equal(remoteGate?.sha, featureSha);
      assert.equal(remoteGate?.source, "verify_ref");
      assert.equal(remoteGate?.isolated, true);

      // Clearing verify_ref via "" also preserves version and status.
      const beforeClear = daemon.director.goals.getGoal(gControl.id)!;
      let clearRes!: { goal: GoalRecord; metadataOnly?: boolean };
      nextChatAction = async (executeTool) => {
        clearRes = (await executeTool("goal_amend", {
          goal_id: gControl.id,
          rationale: "Reset verify_ref to default",
          verify_ref: "",
        })) as { goal: GoalRecord; metadataOnly?: boolean };
      };
      await daemon.director.sendChatMessage(chat.id, "clear verify_ref");
      assert.equal(clearRes.metadataOnly, true);
      assert.equal(clearRes.goal.version, beforeClear.version);
      assert.equal(clearRes.goal.status, beforeClear.status);
      assert.equal(clearRes.goal.verifyRef, null);

      // Invalid verify_ref on goal_amend (metadata-only or mixed) is rejected without bumping version.
      const beforeBadAmend = daemon.director.goals.getGoal(gControl.id)!;
      nextChatAction = async (executeTool) => {
        await assert.rejects(
          () =>
            executeTool("goal_amend", {
              goal_id: gControl.id,
              rationale: "Bad refspec",
              verify_ref: "+x:refs/heads/main",
            }),
          /Invalid verify_ref/,
        );
        await assert.rejects(
          () =>
            executeTool("goal_amend", {
              goal_id: gControl.id,
              rationale: "Mixed amend with bad refspec",
              append_description: "Should not apply",
              verify_ref: "a:b",
            }),
          /Invalid verify_ref/,
        );
      };
      await daemon.director.sendChatMessage(chat.id, "reject bad verify_ref on amend");
      assert.equal(daemon.director.goals.getGoal(gControl.id)!.version, beforeBadAmend.version);

      // Remote-only tag fetched via source-only `git fetch --no-tags origin -- <ref>` resolves from FETCH_HEAD
      // without creating refs/heads/* or local tags or touching HEAD/index.
      const headsBeforeFetch = (await runGit(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).stdout;
      const gRemoteTag = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "Verify remote tag via FETCH_HEAD",
        description: "Fetches tag with --no-tags and resolves via FETCH_HEAD",
        verifyRef: "v1.0-remote",
        verificationMode: "deterministic",
        criteria: [
          {
            id: "c1",
            description: "only-on-feature.txt exists at tag commit",
            kind: "deterministic",
            command: 'test -f only-on-feature.txt && test "$(git rev-parse HEAD)" = "$HARNESS_VERIFY_SHA"',
            required: true,
          },
        ],
      });
      const remoteTagRes = await daemon.director.verifyAndReviewGoal(gRemoteTag.id);
      assert.equal(remoteTagRes.review.verdict, "approved");
      const remoteTagGate = remoteTagRes.review.criteriaResults[0]?.gate;
      assert.equal(remoteTagGate?.ref, "v1.0-remote");
      assert.equal(remoteTagGate?.sha, featureSha);
      assert.equal(remoteTagGate?.isolated, true);
      assert.equal(remoteTagGate?.source, "verify_ref");
      assert.equal(
        (await runGit(repoRoot, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).stdout,
        headsBeforeFetch,
        "fetch must not write refs/heads/*",
      );
      assert.equal(
        await runGit(repoRoot, ["rev-parse", "--verify", "refs/tags/v1.0-remote"]).then(() => true).catch(() => false),
        false,
        "fetch --no-tags must not write local tags",
      );
      assert.equal((await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout, "main");
      assert.equal((await runGit(repoRoot, ["status", "--porcelain"])).stdout, "");

      // Changing verify_ref mid-review invalidates the in-flight review so gates from the old ref cannot approve.
      const markerPath = join(stateDir, "inflight-gate-started");
      const releasePath = join(stateDir, "inflight-gate-release");
      const gInFlight = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "Stale verify_ref in flight",
        description: "Changing verify_ref during review must prevent approval from old ref",
        verifyRef: "feature",
        verificationMode: "deterministic",
        criteria: [
          {
            id: "c1",
            description: "only-on-feature.txt exists after barrier",
            kind: "deterministic",
            command: `touch "${markerPath}" && i=0; while [ ! -f "${releasePath}" ] && [ "$i" -lt 250 ]; do sleep 0.02; i=$((i+1)); done; test -f only-on-feature.txt`,
            required: true,
          },
        ],
      });
      daemon.director.goals.setStatus(gInFlight.id, "executing");
      const inflightReview = daemon.director.verifyAndReviewGoal(gInFlight.id);
      const waitDeadline = Date.now() + 5_000;
      while (!existsSync(markerPath) && Date.now() < waitDeadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(existsSync(markerPath), true, "expected in-flight gate to start");
      let midAmendRes!: { goal: GoalRecord; metadataOnly?: boolean };
      nextChatAction = async (executeTool) => {
        midAmendRes = (await executeTool("goal_amend", {
          goal_id: gInFlight.id,
          rationale: "Switch verify_ref to main while review is in flight",
          verify_ref: "main",
        })) as { goal: GoalRecord; metadataOnly?: boolean };
      };
      await daemon.director.sendChatMessage(chat.id, "switch verify_ref mid-review");
      writeFileSync(releasePath, "go\n", "utf8");
      await assert.rejects(() => inflightReview);
      assert.equal(midAmendRes.metadataOnly, true);
      assert.equal(midAmendRes.goal.version, gInFlight.version, "mid-review verify_ref change must not bump version");
      const afterAbort = daemon.director.goals.getGoal(gInFlight.id)!;
      assert.equal(afterAbort.status, "executing", "aborted old-ref review must neither approve nor strand verifying status");
      assert.equal(afterAbort.verifyRef, "main");
      const freshMainReview = await daemon.director.verifyAndReviewGoal(gInFlight.id);
      assert.equal(freshMainReview.review.verdict, "changes_requested");
      assert.equal(freshMainReview.review.criteriaResults[0]?.gate?.ref, "main");

      // Unknown verify_ref fails closed with "does not resolve" (even after a prior FETCH_HEAD exists) and parks awaiting_human.
      const gUnknown = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "Unknown verify_ref",
        description: "Must fail closed",
        verifyRef: "nope",
        verificationMode: "deterministic",
        criteria: [{ id: "c1", description: "Always true", kind: "deterministic", command: "true", required: true }],
      });
      daemon.director.goals.setStatus(gUnknown.id, "executing");
      await assert.rejects(() => daemon.director.verifyAndReviewGoal(gUnknown.id), /does not resolve/);
      const parked = daemon.director.goals.getGoal(gUnknown.id)!;
      assert.equal(parked.status, "awaiting_human");
      assert.ok(parked.lastReviewSummary?.includes("does not resolve"), parked.lastReviewSummary ?? "");
    } finally {
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(originDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("reports Blocked on verification settlement wording when a failed run's workers all completed and gates fail", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-blocked-verify-state-"));
  const sockPath = join(stateDir, "d.sock");
  try {
    const mainSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout;
    const baseCfg = loadConfig(repoRoot);
    const config = withFixtureCatalog({
      ...baseCfg,
      codeMode: "off",
      goals: { ...baseCfg.goals, autoVerifyOnSettle: true },
      events: { ...baseCfg.events, wakeDirectorOnGoalSettle: true },
      stateDir,
      socketPath: sockPath,
    });

    const wakes: ChatControlEvent[] = [];
    const wakeArrived = Promise.withResolvers<ChatControlEvent>();

    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) {
            return { text: "noted", stopReason: "completed" };
          }
          if (req.tier === 1) {
            const spawned = (await req.executeTool("spawn_worker", {
              title: "Worker pushing elsewhere",
              objective: "Complete work outside merge queue",
              write_scopes: ["feature.txt"],
              model: "fixture/fixture",
            })) as { spawned: string };
            await req.executeTool("wait_children", { ids: [spawned.spawned], timeout_s: 10 });
            return { text: "orchestrator failed after worker finished", stopReason: "error" };
          }
          if (req.tier === 2) {
            // Spawn a Tier 3 read-only execute child that fails; it must not affect Tier 2 worker completion count.
            const child = (await req.executeTool("spawn_task", {
              kind: "execute",
              read_only: true,
              title: "Tier 3 execute helper",
              objective: "Fail as a Tier 3 child",
              model: "fixture/fixture",
            })) as { spawned: string };
            await req.executeTool("wait_children", { ids: [child.spawned], timeout_s: 10 });
            await req.executeTool("return_task", {
              status: "completed",
              summary: "Committed on separate branch",
              sources: [],
            });
            return { text: "worker completed", stopReason: "completed" };
          }
          return { text: "tier 3 execute child failed", stopReason: "error" };
        },
      }),
    });

    await daemon.start();
    daemon.director.setWakeHandler((_chatId, event) => {
      wakes.push(event);
      if (event.kind === "goal.settled") wakeArrived.resolve(event);
    });
    try {
      const chat = await daemon.director.createChat({ repoRoot });
      const goal = daemon.director.goals.createGoal({
        chatSessionId: chat.id,
        repoRoot,
        title: "External branch work",
        description: "Worker completes without merging into main",
        verificationMode: "deterministic",
        criteria: [
          {
            id: "c1",
            description: "only-on-feature.txt exists",
            kind: "deterministic",
            command: "test -f only-on-feature.txt",
            required: true,
          },
        ],
      });
      await daemon.director.commitGoal(goal.id);

      const settledEvent = await Promise.race([
        wakeArrived.promise,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out waiting for goal.settled wake")), 10_000)),
      ]);
      const finalGoal = daemon.director.goals.getGoal(goal.id)!;
      const sha7 = mainSha.slice(0, 7);

      const runTasks = daemon.db.listTasks(finalGoal.linkedRunId!);
      assert.ok(
        runTasks.some((t) => t.tier === 3 && t.kind === "execute" && t.readOnly && t.status === "failed"),
        "expected failed Tier 3 execute child task to exist and be excluded from worker count",
      );
      assert.equal(finalGoal.status, "awaiting_human");
      assert.ok(
        finalGoal.lastReviewSummary?.startsWith("Blocked on verification:"),
        `expected Blocked on verification prefix, got: ${finalGoal.lastReviewSummary}`,
      );
      assert.ok(
        finalGoal.lastReviewSummary?.includes(`main@${sha7}`),
        `expected main@${sha7}, got: ${finalGoal.lastReviewSummary}`,
      );
      assert.ok(
        finalGoal.lastReviewSummary?.includes("/_verify/"),
        `expected actual _verify cwd in summary, got: ${finalGoal.lastReviewSummary}`,
      );
      assert.equal(
        finalGoal.lastReviewSummary?.includes("removed"),
        false,
        `must not claim worktree was removed in summary: ${finalGoal.lastReviewSummary}`,
      );
      assert.ok(
        finalGoal.lastReviewSummary?.includes("All 1 worker task(s) completed"),
        `expected worker count, got: ${finalGoal.lastReviewSummary}`,
      );
      assert.ok(
        finalGoal.lastReviewSummary?.includes("no work merged") && finalGoal.lastReviewSummary?.includes("verify_ref"),
        `expected unchanged-commit note, got: ${finalGoal.lastReviewSummary}`,
      );
      assert.equal(
        /Linked run .* failed and/.test(finalGoal.lastReviewSummary ?? ""),
        false,
        `must not blame linked run: ${finalGoal.lastReviewSummary}`,
      );

      assert.equal(settledEvent.kind, "goal.settled");
      if (settledEvent.kind === "goal.settled") {
        assert.equal(settledEvent.cause, "gates_failed");
        assert.ok(
          settledEvent.detail?.startsWith("blocked_on_verification: "),
          `expected blocked_on_verification detail prefix, got: ${settledEvent.detail}`,
        );
        assert.ok(settledEvent.detail?.includes(`main@${sha7}`), settledEvent.detail);
      }
      assert.ok(wakes.length >= 1);
    } finally {
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("T3-15: Director self-reading advisory fires once per turn and stays silent on named, paged, .harness, and post-delegation reads", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-t315-state-"));
  try {
    const areas = ["src/alpha", "src/beta", "src/gamma"];
    const sourceFiles: string[] = [];
    for (const area of areas) {
      mkdirSync(join(repoRoot, area), { recursive: true });
      const count = area === "src/gamma" ? 4 : 5;
      for (let i = 1; i <= count; i++) {
        const rel = `${area}/file${i}.ts`;
        writeFileSync(join(repoRoot, rel), `export const v_${i} = "${rel}";\n`, "utf8");
        sourceFiles.push(rel);
      }
    }
    // 14 distinct source files across 3 areas
    assert.equal(sourceFiles.length, 14);

    // One large file for paging reads
    mkdirSync(join(repoRoot, "src/big"), { recursive: true });
    const bigLines = Array.from({ length: 120 }, (_, i) => `export const line_${i + 1} = ${i + 1};`).join("\n") + "\n";
    writeFileSync(join(repoRoot, "src/big/large.ts"), bigLines, "utf8");

    // 12 files under .harness/notes across 3 subdirs
    const harnessFiles: string[] = [];
    for (const sub of [".harness/notes/a", ".harness/notes/b", ".harness/notes/c"]) {
      mkdirSync(join(repoRoot, sub), { recursive: true });
      for (let i = 1; i <= 4; i++) {
        const rel = `${sub}/note${i}.md`;
        writeFileSync(join(repoRoot, rel), `note ${rel}\n`, "utf8");
        harnessFiles.push(rel);
      }
    }

    type ReadRes = { content: string; harness_advisory?: string[] };
    type Scenario = "fire_14" | "second_turn_12" | "user_named_dirs" | "paging_one_file" | "harness_reads" | "after_spawn_task";
    let scenario: Scenario = "fire_14";
    const resultsByScenario = new Map<Scenario, ReadRes[]>();
    let directorTurnRuns = 0;

    const config = withFixtureCatalog({
      ...loadConfig(repoRoot),
      stateDir,
      socketPath: join(stateDir, "d.sock"),
      codeMode: "off",
    });
    const daemon = new HarnessDaemon(config, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.kind === "research") {
            await req.executeTool("return_task", {
              status: "completed",
              summary: "Delegated read done",
              sources: [{ path: "status.txt", lines: "1" }],
            });
            return { stopReason: "completed", text: "done" };
          }
          directorTurnRuns += 1;
          const out: ReadRes[] = [];
          if (scenario === "fire_14") {
            for (const rel of sourceFiles) {
              out.push((await req.executeTool("read_file", { path: rel })) as ReadRes);
            }
          } else if (scenario === "second_turn_12" || scenario === "user_named_dirs") {
            for (const rel of sourceFiles.slice(0, 12)) {
              out.push((await req.executeTool("read_file", { path: rel })) as ReadRes);
            }
          } else if (scenario === "paging_one_file") {
            for (let p = 0; p < 15; p++) {
              out.push(
                (await req.executeTool("read_file", {
                  path: "src/big/large.ts",
                  start_line: p * 5 + 1,
                  end_line: p * 5 + 5,
                })) as ReadRes,
              );
            }
          } else if (scenario === "harness_reads") {
            for (const rel of harnessFiles) {
              out.push((await req.executeTool("read_file", { path: rel })) as ReadRes);
            }
          } else if (scenario === "after_spawn_task") {
            const spawned = (await req.executeTool("spawn_task", {
              title: "Research repo",
              objective: "Inspect status.txt and report findings",
              kind: "research",
              model: req.model,
            })) as { spawned: string; harness_advisory?: string[] };
            assert.ok(spawned.spawned);
            assert.equal(spawned.harness_advisory, undefined);
            for (const rel of sourceFiles.slice(0, 12)) {
              out.push((await req.executeTool("read_file", { path: rel })) as ReadRes);
            }
          }
          resultsByScenario.set(scenario, out);
          return { stopReason: "completed", text: `finished ${scenario}` };
        },
      }),
    });

    try {
      const chat = await daemon.director.createChat({ repoRoot });

      // 1. 14 distinct files across 3 areas, no spawn_task: every read returns content, only 12th has advisory, no extra turn
      scenario = "fire_14";
      directorTurnRuns = 0;
      await daemon.director.sendChatMessage(chat.id, "How is this codebase structured?");
      assert.equal(directorTurnRuns, 1, "advisory must never open an extra turn");
      const fire14 = resultsByScenario.get("fire_14")!;
      assert.equal(fire14.length, 14);
      for (let i = 0; i < fire14.length; i++) {
        assert.ok(fire14[i]!.content.includes(sourceFiles[i]!), `read ${i + 1} must still return content`);
      }
      const annotatedIndices = fire14
        .map((r, i) => (r.harness_advisory ? i : -1))
        .filter((i) => i !== -1);
      assert.deepEqual(annotatedIndices, [11], "exactly the 12th read must carry the advisory");
      const notice = fire14[11]!.harness_advisory!;
      assert.equal(notice.length, 1);
      assert.match(notice[0]!, /^\[harness advisory: director-self-reading\] .+ Why: .+ Instead: .+/);

      // 2. Second turn with the same reads fires again (per-turn subject settled in finally)
      scenario = "second_turn_12";
      directorTurnRuns = 0;
      await daemon.director.sendChatMessage(chat.id, "Check the codebase again");
      assert.equal(directorTurnRuns, 1);
      const turn2 = resultsByScenario.get("second_turn_12")!;
      assert.equal(turn2[11]!.harness_advisory?.length, 1);
      assert.match(turn2[11]!.harness_advisory![0]!, /^\[harness advisory: director-self-reading\] /);

      // 3. Silent: user message names those directories
      scenario = "user_named_dirs";
      await daemon.director.sendChatMessage(chat.id, "Inspect src/alpha, src/beta, and src/gamma please");
      const namedRes = resultsByScenario.get("user_named_dirs")!;
      assert.ok(namedRes.every((r) => r.harness_advisory === undefined), "user-named dirs must stay silent");

      // 4. Silent: paging one large file many times
      scenario = "paging_one_file";
      await daemon.director.sendChatMessage(chat.id, "Read through the large file");
      const pagedRes = resultsByScenario.get("paging_one_file")!;
      assert.equal(pagedRes.length, 15);
      assert.ok(pagedRes.every((r) => r.harness_advisory === undefined), "paging one file must stay silent");

      // 5. Silent: reads under .harness/
      scenario = "harness_reads";
      await daemon.director.sendChatMessage(chat.id, "Review my saved notes");
      const harnessRes = resultsByScenario.get("harness_reads")!;
      assert.equal(harnessRes.length, 12);
      assert.ok(harnessRes.every((r) => r.harness_advisory === undefined), ".harness/ reads must stay silent");

      // 6. Silent: reads after a spawn_task earlier in the turn
      scenario = "after_spawn_task";
      await daemon.director.sendChatMessage(chat.id, "Investigate and delegate");
      const postSpawnRes = resultsByScenario.get("after_spawn_task")!;
      assert.equal(postSpawnRes.length, 12);
      assert.ok(postSpawnRes.every((r) => r.harness_advisory === undefined), "reads after spawn_task must stay silent");
    } finally {
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

it("releases activeReviews and cleans up _verify worktree before relaunching Tier 1 on changes_requested", async () => {
  const repoRoot = await makeTempRepo();
  const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-settle-order-state-"));
  const sockPath = join(stateDir, "d.sock");
  let orchGenerations = 0;
  let gen2SawActiveReview: boolean | null = null;
  let gen2SawVerifyWorktree: boolean | null = null;

  try {
    const cfg = withFixtureCatalog({
      ...loadConfig(repoRoot),
      stateDir,
      socketPath: sockPath,
      codeMode: "off",
      goals: { defaultMaxReviewCycles: 4, defaultMaxNoProgressCycles: 3, gateTimeoutMs: 90_000, autoVerifyOnSettle: true },
      events: { fallbackWakeupIntervalSec: 900, wakeDirectorOnGoalSettle: false },
    });

    let goalId = "";
    const daemon = new HarnessDaemon(cfg, {
      dbPath: ":memory:",
      customRunnerFactory: () => ({
        run: async (req) => {
          if (req.taskId.startsWith("chat-")) return { text: "ok", stopReason: "completed" };
          if (req.tier === 1) {
            orchGenerations++;
            if (orchGenerations === 1) {
              return { text: "gen1", stopReason: "completed" };
            }
            const activeReviews = (daemon.director as unknown as { activeReviews: Map<string, AbortController> }).activeReviews;
            gen2SawActiveReview = activeReviews.has(goalId);
            gen2SawVerifyWorktree = (await runGit(repoRoot, ["worktree", "list", "--porcelain"])).stdout.includes("_verify");
            writeFileSync(join(repoRoot, "out.txt"), "gen2\n", "utf8");
            await runGit(repoRoot, ["add", "out.txt"]);
            await runGit(repoRoot, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "add out.txt"]);
            return { text: "gen2", stopReason: "completed" };
          }
          return { text: "done", stopReason: "completed" };
        },
      }),
    });

    await daemon.start();
    try {
      const chat = await daemon.director.createChat({ repoRoot });
      const goal = daemon.director.goals.createGoal({
        repoRoot,
        chatSessionId: chat.id,
        title: "Verify settle ordering before Tier 1 relaunch",
        description: "Produce out.txt on remediation gen 2",
        verificationMode: "deterministic",
        criteria: [{ id: "c1", kind: "deterministic", description: "out.txt exists", command: "test -f out.txt", required: true }],
      });
      goalId = goal.id;
      await daemon.director.commitGoal(goal.id);

      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && daemon.director.goals.getGoal(goal.id)?.status !== "achieved") {
        await new Promise((r) => setTimeout(r, 30));
      }
      assert.equal(daemon.director.goals.getGoal(goal.id)?.status, "achieved");
      assert.equal(orchGenerations, 2);
      assert.equal(gen2SawActiveReview, false, "activeReviews must be cleared before Tier 1 remediation relaunch");
      assert.equal(gen2SawVerifyWorktree, false, "_verify worktree must be cleaned up before Tier 1 remediation relaunch");
    } finally {
      await daemon.stop();
    }
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});
