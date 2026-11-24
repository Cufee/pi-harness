import { withFixtureCatalog } from "./fixtures/launch-config.js";
import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HARNESS_TEXT_COUNT_PATTERN } from "../src/advisories/rules.js";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import { buildReviewerSystemPrompt, resolveDirectorReadablePath } from "../src/director/runtime.js";
import { runGit } from "../src/worktree/manager.js";

const BLOCKED_SHAPE = /^\[harness blocked: [\w-]+\] .+ Why: .+ Allowed: .+/;

async function makeTempGitRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-limits-dir-"));
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "README.md"), "hello\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

describe("Director rejections and reviewer prompt", () => {
  it("T5-2d1: Director read_file on .git/config throws the shared blocked shape and reads nothing", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-t52d1-"));
    try {
      assert.throws(() => resolveDirectorReadablePath(repoRoot, ".git/config"), { message: BLOCKED_SHAPE });

      const config = withFixtureCatalog({
        ...loadConfig(repoRoot),
        stateDir,
        socketPath: join(stateDir, "d.sock"),
        codeMode: "off",
      });
      const caught: Error[] = [];
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            try {
              await req.executeTool("read_file", { path: ".git/config" });
            } catch (err) {
              caught.push(err as Error);
            }
            return { stopReason: "completed", text: "done" };
          },
        }),
      });
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        await daemon.director.sendChatMessage(chat.id, "Check git config");
        assert.equal(caught.length, 1, "read_file on .git/config must throw");
        assert.match(caught[0]!.message, BLOCKED_SHAPE);
        assert.match(caught[0]!.message, /^\[harness blocked: director-protected-read\] /);
        const readTurns = daemon.director.chats
          .getHistory(chat.id)
          .filter((t) => t.event?.kind === "director.read_file");
        assert.equal(readTurns.length, 0, "blocked read_file must not read or log anything");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T5-2d2: Director write_note to src/ throws the shared blocked shape and writes nothing", async () => {
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-t52d2-"));
    try {
      const config = withFixtureCatalog({
        ...loadConfig(repoRoot),
        stateDir,
        socketPath: join(stateDir, "d.sock"),
        codeMode: "off",
      });
      const caught: Error[] = [];
      const daemon = new HarnessDaemon(config, {
        dbPath: ":memory:",
        customRunnerFactory: () => ({
          run: async (req) => {
            try {
              await req.executeTool("write_note", {
                path: "src/should-not-exist.ts",
                content: "export const nope = true;\n",
                reason: "Attempt write outside note roots",
              });
            } catch (err) {
              caught.push(err as Error);
            }
            return { stopReason: "completed", text: "done" };
          },
        }),
      });
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        await daemon.director.sendChatMessage(chat.id, "Write a note to src/");
        assert.equal(caught.length, 1, "write_note to src/ must throw");
        assert.match(caught[0]!.message, BLOCKED_SHAPE);
        assert.match(caught[0]!.message, /^\[harness blocked: director-note-root\] /);
        assert.equal(existsSync(join(repoRoot, "src/should-not-exist.ts")), false, "must write nothing");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T5-4r: buildReviewerSystemPrompt matches no turn/token count pattern and keeps the wall-clock sentence", async () => {
    const prompt = buildReviewerSystemPrompt();
    assert.equal(
      HARNESS_TEXT_COUNT_PATTERN.test(prompt),
      false,
      `buildReviewerSystemPrompt must not match HARNESS_TEXT_COUNT_PATTERN: ${prompt}`,
    );
    assert.ok(
      prompt.includes("The review has a hard 10-minute wall-clock limit."),
      `buildReviewerSystemPrompt must keep the 10-minute wall-clock sentence: ${prompt}`,
    );

    // Also verify the live Done-Reviewer session receives buildReviewerSystemPrompt()
    const repoRoot = await makeTempGitRepo();
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-t54r-"));
    try {
      let seenSystemPrompt = "";
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
            seenSystemPrompt = req.systemPrompt;
            await req.executeTool("submit_review_verdict", {
              verdict: "approved",
              summary: "Verified",
              criteriaResults: [{ criterionId: "c1", passed: true, evidence: "Checked README.md" }],
            });
            return { stopReason: "completed", text: "approved" };
          },
        }),
      });
      try {
        const chat = await daemon.director.createChat({ repoRoot });
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          chatSessionId: chat.id,
          title: "Check reviewer prompt",
          description: "Verify system prompt has no turn count",
          criteria: [{ id: "c1", kind: "behavioral", description: "README exists", required: true }],
        });
        await daemon.director.verifyAndReviewGoal(goal.id);
        assert.equal(seenSystemPrompt, prompt);
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
