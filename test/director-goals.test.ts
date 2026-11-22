import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type AcpProfileConfig, type HarnessConfig } from "../src/config.js";
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
      const config = { ...loadConfig(repoRoot), stateDir, socketPath: sockPath };
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            // Tier 0 Director Chat creates and commits a Goal Contract
            if (req.taskId.startsWith("chat-")) {
              const created = (await req.executeTool("goal_create", {
                title: "Ship greeting file",
                description: "Create greet.txt and pass deterministic verification",
                criteria: [
                  { id: "c1", description: "greet.txt exists", kind: "deterministic", command: "test -f greet.txt", required: true },
                  { id: "c2", description: "Greeting includes world", kind: "behavioral", required: true },
                ],
                commit_immediately: true,
              })) as GoalRecord;
              return { text: `Drafted & started goal ${created.id}`, stopReason: "completed" };
            }

            // Independent Done-Reviewer
            if (req.taskId.startsWith("reviewer-")) {
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
        assert.equal(goal.status, "executing");

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
