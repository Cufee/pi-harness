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
