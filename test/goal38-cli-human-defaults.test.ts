import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import { formatGoalsTable, formatHelp, formatInboxOutput } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { HarnessDaemon } from "../src/daemon/server.js";
import type { InboxItem } from "../src/protocol/daemon-rpc.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

const CLI_PATH = resolve(import.meta.dir, "../src/cli.ts");

function maybeWriteEvidence(filename: string, content: string): void {
  if (process.env.GOAL38_WRITE_EVIDENCE !== "1") return;
  const dir = process.env.HARNESS_GOAL_EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `${content.trimEnd()}\n`, "utf8");
}

async function makeTempRepo(prefix: string): Promise<string> {
  const rawDir = mkdtempSync(join(tmpdir(), prefix));
  const dir = realpathSync(rawDir);
  await runGit(dir, ["init", "-b", "main"]);
  writeFileSync(join(dir, "file.txt"), "v1\n", "utf8");
  await runGit(dir, ["add", "-A"]);
  await runGit(dir, ["-c", "user.name=t", "-c", "user.email=t@local", "commit", "-m", "init"]);
  return dir;
}

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { stateDir: string; cwd: string }): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PI_HARNESS_HOME: opts.stateDir,
    };
    delete env.XDG_RUNTIME_DIR;

    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: opts.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}

describe("goal-38: CLI human defaults (escalations/inbox/goals/runs)", () => {
  it("applies shared attention policy defaults and --all/--json overrides across escalations, inbox, goals, runs, and tree", async () => {
    const repoRoot = await makeTempRepo("pi-harness-g38-repo-");
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-g38-state-")));
    const socketPath = join(stateDir, "daemon.sock");

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath,
      });

      const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });
      await daemon.start();

      try {
        const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
        const chat = daemon.director.chats.createSession({
          repoRoot,
          profileId: "fixture",
          title: "Goal 38 CLI Test Chat",
        });

        // 1. Seed two goals: one executing (linked to run1), one awaiting_human (linked to run2)
        const goalExecuting = daemon.director.goals.createGoal({
          repoRoot,
          chatSessionId: chat.id,
          title: "Implement CLI human defaults with a deliberately long title to verify table truncation behavior in narrow terminals",
          description: "Executing goal",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const run1 = daemon.db.createRun({
          goal: "Primary feature run for goal-38",
          repoRoot,
          baseBranch: "main",
          baseSha,
        });
        daemon.director.goals.linkRunAndStart(goalExecuting.id, run1.id);

        const goalAwaiting = daemon.director.goals.createGoal({
          repoRoot,
          chatSessionId: chat.id,
          title: "Approve rollout policy for staging",
          description: "Awaiting human decision",
          criteria: [{ id: "c1", description: "Approved", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const run2 = daemon.db.createRun({
          goal: "Staging rollout verification run",
          repoRoot,
          baseBranch: "main",
          baseSha,
        });
        daemon.director.goals.linkRunAndStart(goalAwaiting.id, run2.id);
        daemon.director.goals.setStatus(goalAwaiting.id, "awaiting_human", "Ready for final sign-off");

        // 2. Seed a director-tasks-* container run (should be hidden from `runs` by default)
        const containerRun = daemon.db.createRun({
          id: `director-tasks-${chat.id}`,
          goal: "Director delegation bucket",
          repoRoot,
          baseBranch: "main",
          baseSha,
        });

        // 3. Seed tasks + escalations on run1:
        //    - visibleEsc: P0 blocking toTaskId=null from running T2 worker -> human-visible
        //    - agentEsc: P1 blocking toTaskId=t1 -> hidden (agent_addressed)
        //    - nonBlockingEsc: P2 non-blocking toTaskId=null -> hidden (not_blocking)
        //    - ackedEsc: P0 blocking acked -> hidden (not_open) in default, shown in --all
        const t1 = daemon.db.createTask({
          runId: run1.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orchestrate feature",
          objective: "Coordinate workers",
          profileId: "fixture",
          model: "fixture/fixture",
        });
        daemon.db.updateTask(t1.id, { status: "running" });

        const t2 = daemon.db.createTask({
          runId: run1.id,
          parentId: t1.id,
          tier: 2,
          kind: "worker",
          title: "Implement slice",
          objective: "Build CLI defaults",
          profileId: "fixture",
          model: "fixture/fixture",
        });
        daemon.db.updateTask(t2.id, { status: "running" });

        const visibleEsc = daemon.db.createEscalation({
          runId: run1.id,
          fromTaskId: t2.id,
          toTaskId: null,
          severity: "P0",
          category: "ambiguous_spec",
          title: "Human decision needed on API contract",
          evidencePaths: ["file.txt"],
          blocking: true,
        });
        const agentEsc = daemon.db.createEscalation({
          runId: run1.id,
          fromTaskId: t2.id,
          toTaskId: t1.id,
          severity: "P1",
          category: "code_defect",
          title: "Internal worker question for orchestrator",
          evidencePaths: ["file.txt"],
          blocking: true,
        });
        const nonBlockingEsc = daemon.db.createEscalation({
          runId: run1.id,
          fromTaskId: t2.id,
          toTaskId: null,
          severity: "P2",
          category: "code_defect",
          title: "Non-blocking lint note",
          evidencePaths: ["file.txt"],
          blocking: false,
        });
        const ackedEsc = daemon.db.createEscalation({
          runId: run1.id,
          fromTaskId: t2.id,
          toTaskId: null,
          severity: "P0",
          category: "blocked_dependency",
          title: "Already acknowledged dependency check",
          evidencePaths: ["file.txt"],
          blocking: true,
        });
        daemon.db.ackEscalation(ackedEsc.id, "Director noted", false);

        // --- A. escalations list: default vs --all vs --status vs --json ---
        const [escDefault, escBare, escDefaultJson, escAll, escAllJson, escStatusOpen, escRun2] = await Promise.all([
          runCli(["escalations", "list"], { stateDir, cwd: repoRoot }),
          runCli(["escalations"], { stateDir, cwd: repoRoot }),
          runCli(["escalations", "list", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["escalations", "list", "--all"], { stateDir, cwd: repoRoot }),
          runCli(["escalations", "list", "--all", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["escalations", "list", "--status", "open", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["escalations", "list", "--run", run2.id], { stateDir, cwd: repoRoot }),
        ]);
        assert.equal(escDefault.code, 0, escDefault.stderr);
        assert.ok(escDefault.stdout.includes(visibleEsc.id), escDefault.stdout);
        assert.ok(escDefault.stdout.includes("Human decision needed on API contract"), escDefault.stdout);
        assert.ok(!escDefault.stdout.includes(agentEsc.id), escDefault.stdout);
        assert.ok(!escDefault.stdout.includes(nonBlockingEsc.id), escDefault.stdout);
        assert.ok(!escDefault.stdout.includes(ackedEsc.id), escDefault.stdout);
        assert.ok(
          escDefault.stdout.includes("(3 internal escalation(s) hidden; use --all)"),
          escDefault.stdout,
        );

        // Bare `pi-harness escalations` behaves the same as `escalations list`
        assert.equal(escBare.code, 0, escBare.stderr);
        assert.equal(escBare.stdout, escDefault.stdout);

        // Default --json returns only policy-visible escalations
        assert.equal(escDefaultJson.code, 0, escDefaultJson.stderr);
        const escDefaultParsed = JSON.parse(escDefaultJson.stdout) as Array<{ id: string }>;
        assert.deepEqual(
          escDefaultParsed.map((e) => e.id),
          [visibleEsc.id],
        );

        // --all returns all open + acked escalations and omits hidden hint
        assert.equal(escAll.code, 0, escAll.stderr);
        assert.ok(escAll.stdout.includes(visibleEsc.id), escAll.stdout);
        assert.ok(escAll.stdout.includes(agentEsc.id), escAll.stdout);
        assert.ok(escAll.stdout.includes(nonBlockingEsc.id), escAll.stdout);
        assert.ok(escAll.stdout.includes(ackedEsc.id), escAll.stdout);
        assert.ok(!escAll.stdout.includes("hidden; use --all"), escAll.stdout);

        assert.equal(escAllJson.code, 0, escAllJson.stderr);
        const escAllIds = new Set((JSON.parse(escAllJson.stdout) as Array<{ id: string }>).map((e) => e.id));
        assert.deepEqual(escAllIds, new Set([visibleEsc.id, agentEsc.id, nonBlockingEsc.id, ackedEsc.id]));

        // Explicit --status implies raw listing
        assert.equal(escStatusOpen.code, 0, escStatusOpen.stderr);
        const openIds = new Set((JSON.parse(escStatusOpen.stdout) as Array<{ id: string }>).map((e) => e.id));
        assert.deepEqual(openIds, new Set([visibleEsc.id, agentEsc.id, nonBlockingEsc.id]));

        // Run-scoped escalations list
        assert.equal(escRun2.code, 0, escRun2.stderr);
        assert.ok(escRun2.stdout.includes("No escalations found."), escRun2.stdout);
        assert.ok(!escRun2.stdout.includes("hidden; use --all"), escRun2.stdout);

        // --- B. inbox: default vs --all vs --run vs --json ---
        const [inboxDefault, inboxAll, inboxDefaultJson, inboxAllJson, inboxRun1Json] = await Promise.all([
          runCli(["inbox"], { stateDir, cwd: repoRoot }),
          runCli(["inbox", "--all"], { stateDir, cwd: repoRoot }),
          runCli(["inbox", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["inbox", "--all", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["inbox", "--run", run1.id, "--json"], { stateDir, cwd: repoRoot }),
        ]);
        assert.equal(inboxDefault.code, 0, inboxDefault.stderr);
        assert.ok(inboxDefault.stdout.includes("SEV"), inboxDefault.stdout);
        assert.ok(inboxDefault.stdout.includes("goal_awaiting_human"), inboxDefault.stdout);
        assert.ok(inboxDefault.stdout.includes("escalation"), inboxDefault.stdout);
        assert.ok(inboxDefault.stdout.includes("Human decision needed on API contract"), inboxDefault.stdout);
        assert.ok(inboxDefault.stdout.includes("Approve rollout policy for staging"), inboxDefault.stdout);
        assert.ok(!inboxDefault.stdout.includes("Internal worker question for orchestrator"), inboxDefault.stdout);
        assert.ok(!inboxDefault.stdout.includes("Non-blocking lint note"), inboxDefault.stdout);
        assert.ok(inboxDefault.stdout.includes("internal item(s) hidden; use --all"), inboxDefault.stdout);

        assert.equal(inboxAll.code, 0, inboxAll.stderr);
        assert.ok(inboxAll.stdout.includes("Internal attention ("), inboxAll.stdout);
        assert.ok(inboxAll.stdout.includes("AUDIENCE"), inboxAll.stdout);
        assert.ok(inboxAll.stdout.includes("REASON"), inboxAll.stdout);
        assert.ok(inboxAll.stdout.includes("orchestrator"), inboxAll.stdout);
        assert.ok(inboxAll.stdout.includes("agent_addressed"), inboxAll.stdout);
        assert.ok(inboxAll.stdout.includes("not_blocking"), inboxAll.stdout);
        assert.ok(!inboxAll.stdout.includes("hidden; use --all"), inboxAll.stdout);

        assert.equal(inboxDefaultJson.code, 0, inboxDefaultJson.stderr);
        const inboxItems = JSON.parse(inboxDefaultJson.stdout) as InboxItem[];
        assert.deepEqual(
          new Set(inboxItems.map((i) => i.id)),
          new Set([`inbox:goal:${goalAwaiting.id}`, `inbox:esc:${visibleEsc.id}`]),
        );

        assert.equal(inboxAllJson.code, 0, inboxAllJson.stderr);
        const inboxAllItems = JSON.parse(inboxAllJson.stdout) as InboxItem[];
        assert.ok(inboxAllItems.length > inboxItems.length);
        const hiddenAgentItem = inboxAllItems.find((i) => i.id === `inbox:esc:${agentEsc.id}`);
        assert.equal(hiddenAgentItem?.audience, "orchestrator");
        assert.equal(hiddenAgentItem?.hiddenReason, "agent_addressed");

        // Run-scoped inbox filters out goals from other runs
        assert.equal(inboxRun1Json.code, 0, inboxRun1Json.stderr);
        const inboxRun1Items = JSON.parse(inboxRun1Json.stdout) as InboxItem[];
        assert.deepEqual(
          inboxRun1Items.map((i) => i.id),
          [`inbox:esc:${visibleEsc.id}`],
        );

        // --- C/D/E. goals, runs, and tree ---
        const [goalsTable, goalsJson, runsDefault, runsDefaultJson, runsAll, runsAllJson, treeOut] = await Promise.all([
          runCli(["goals"], { stateDir, cwd: repoRoot }),
          runCli(["goals", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["runs"], { stateDir, cwd: repoRoot }),
          runCli(["runs", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["runs", "--all"], { stateDir, cwd: repoRoot }),
          runCli(["runs", "--all", "--json"], { stateDir, cwd: repoRoot }),
          runCli(["tree", run1.id], { stateDir, cwd: repoRoot }),
        ]);
        assert.equal(goalsTable.code, 0, goalsTable.stderr);
        assert.ok(goalsTable.stdout.startsWith("GOAL"), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes("STATUS"), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes("VER"), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes("UPDATED (UTC)"), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes("TITLE"), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes(goalExecuting.id), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes(goalAwaiting.id), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes("awaiting_human"), goalsTable.stdout);
        assert.ok(goalsTable.stdout.includes("v1"), goalsTable.stdout);
        assert.throws(() => JSON.parse(goalsTable.stdout));

        assert.equal(goalsJson.code, 0, goalsJson.stderr);
        const goalsParsed = JSON.parse(goalsJson.stdout) as Array<{ id: string; title: string; status: string }>;
        assert.equal(goalsParsed.length, 2);
        assert.deepEqual(
          new Set(goalsParsed.map((g) => g.id)),
          new Set([goalExecuting.id, goalAwaiting.id]),
        );

        // --- D. runs: hides director-tasks-* containers unless --all ---
        assert.equal(runsDefault.code, 0, runsDefault.stderr);
        assert.ok(runsDefault.stdout.includes(run1.id), runsDefault.stdout);
        assert.ok(runsDefault.stdout.includes(run2.id), runsDefault.stdout);
        assert.ok(!runsDefault.stdout.includes(containerRun.id), runsDefault.stdout);
        assert.ok(
          runsDefault.stdout.includes("(1 internal container run(s) hidden; use --all)"),
          runsDefault.stdout,
        );

        assert.equal(runsDefaultJson.code, 0, runsDefaultJson.stderr);
        const runsDefaultParsed = JSON.parse(runsDefaultJson.stdout) as Array<{ id: string }>;
        assert.ok(!runsDefaultParsed.some((r) => r.id === containerRun.id));
        assert.deepEqual(new Set(runsDefaultParsed.map((r) => r.id)), new Set([run1.id, run2.id]));

        assert.equal(runsAll.code, 0, runsAll.stderr);
        assert.ok(runsAll.stdout.includes(run1.id), runsAll.stdout);
        assert.ok(runsAll.stdout.includes(run2.id), runsAll.stdout);
        assert.ok(runsAll.stdout.includes(containerRun.id), runsAll.stdout);
        assert.ok(!runsAll.stdout.includes("hidden; use --all"), runsAll.stdout);

        assert.equal(runsAllJson.code, 0, runsAllJson.stderr);
        const runsAllParsed = JSON.parse(runsAllJson.stdout) as Array<{ id: string }>;
        assert.deepEqual(new Set(runsAllParsed.map((r) => r.id)), new Set([run1.id, run2.id, containerRun.id]));

        // --- E. tree stays raw JSON ---
        assert.equal(treeOut.code, 0, treeOut.stderr);
        const treeParsed = JSON.parse(treeOut.stdout) as { run: { id: string }; tasks: unknown[]; escalations: unknown[] };
        assert.equal(treeParsed.run.id, run1.id);
        assert.equal(treeParsed.tasks.length, 2);

        const helpExcerpt = formatHelp()
          .split("\n")
          .filter((line) =>
            /pi-harness (inbox|goals|escalations|runs|tree)|Show human-visible|List goals|List runs|Dump raw/.test(line),
          )
          .join("\n");
        maybeWriteEvidence(
          "cli-sample-outputs.md",
          [
            "# goal-38: CLI Human Defaults — Sample Outputs",
            "",
            "Captured directly from the real CLI (`src/cli.ts`) talking to an in-process `HarnessDaemon` in `test/goal38-cli-human-defaults.test.ts`.",
            "",
            "## `pi-harness --help` (relevant excerpt)",
            "",
            "```text",
            helpExcerpt,
            "```",
            "",
            "## `pi-harness escalations list` (default)",
            "",
            "```text",
            escDefault.stdout.trimEnd(),
            "```",
            "",
            "## `pi-harness escalations list --all`",
            "",
            "```text",
            escAll.stdout.trimEnd(),
            "```",
            "",
            "## `pi-harness inbox` (default)",
            "",
            "```text",
            inboxDefault.stdout.trimEnd(),
            "```",
            "",
            "## `pi-harness inbox --all`",
            "",
            "```text",
            inboxAll.stdout.trimEnd(),
            "```",
            "",
            "## `pi-harness goals` (default table)",
            "",
            "```text",
            goalsTable.stdout.trimEnd(),
            "```",
            "",
            "## `pi-harness goals --json` (head)",
            "",
            "```json",
            goalsJson.stdout.trimEnd().split("\n").slice(0, 20).join("\n"),
            "```",
            "",
            "## `pi-harness runs` (default)",
            "",
            "```text",
            runsDefault.stdout.trimEnd(),
            "```",
            "",
            "## `pi-harness runs --all`",
            "",
            "```text",
            runsAll.stdout.trimEnd(),
            "```",
          ].join("\n"),
        );
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 15_000);

  it("prints empty states cleanly and rejects invalid flags on inbox and escalations", async () => {
    const repoRoot = await makeTempRepo("pi-harness-g38-empty-");
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-g38-empty-state-")));
    const socketPath = join(stateDir, "daemon.sock");

    try {
      // Flag validation must reject unknown flags before touching any daemon
      const badInboxFlag = await runCli(["inbox", "--bogus"], { stateDir, cwd: repoRoot });
      assert.notEqual(badInboxFlag.code, 0);
      assert.ok(badInboxFlag.stderr.includes("not supported for 'inbox'"), badInboxFlag.stderr);

      const badInboxPositional = await runCli(["inbox", "extra"], { stateDir, cwd: repoRoot });
      assert.notEqual(badInboxPositional.code, 0);
      assert.ok(badInboxPositional.stderr.includes("Usage: pi-harness inbox"), badInboxPositional.stderr);

      const badEscAllValue = await runCli(["escalations", "list", "--all=false"], { stateDir, cwd: repoRoot });
      assert.notEqual(badEscAllValue.code, 0);
      assert.ok(badEscAllValue.stderr.includes("--all does not take a value"), badEscAllValue.stderr);

      // Empty daemon states
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath,
      });
      const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });
      await daemon.start();
      try {
        const emptyInbox = await runCli(["inbox"], { stateDir, cwd: repoRoot });
        assert.equal(emptyInbox.code, 0, emptyInbox.stderr);
        assert.equal(emptyInbox.stdout.trim(), "Inbox is empty.");

        const emptyGoals = await runCli(["goals"], { stateDir, cwd: repoRoot });
        assert.equal(emptyGoals.code, 0, emptyGoals.stderr);
        assert.equal(emptyGoals.stdout.trim(), "No goals found.");
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("documents inbox, goals, escalations --all, runs --all, and tree in help and truncates long goal titles", () => {
    const help = formatHelp();
    assert.ok(help.includes("pi-harness inbox [--all] [--run <run-id>] [--json]"));
    assert.ok(help.includes("pi-harness goals [list [--json]"));
    assert.ok(help.includes("pi-harness escalations [list] [--all]"));
    assert.ok(help.includes("--all or --status shows raw list"));
    assert.ok(help.includes("pi-harness runs [--all] [--json]"));
    assert.ok(help.includes("hides director-tasks-* containers unless --all"));
    assert.ok(help.includes("Dump raw run/task/escalation tree JSON"));

    const narrow = formatGoalsTable(
      [
        {
          id: "goal-38",
          status: "executing",
          version: 2,
          updatedAt: Date.UTC(2026, 10, 24, 15, 0, 0),
          title: "A very long goal title that definitely exceeds the available column width on an 80-column terminal",
        },
      ],
      80,
    );
    const lines = narrow.split("\n");
    assert.equal(lines.length, 2);
    assert.ok(lines[1]!.length <= 80, `line length ${lines[1]!.length} exceeded 80: ${lines[1]}`);
    assert.ok(lines[1]!.endsWith("…"), lines[1]);

    const emptyInboxText = formatInboxOutput([], [], { showAll: false });
    assert.equal(emptyInboxText, "Inbox is empty.");
  });

  it("resolves human-visible escalations past the 500-row snapshot cap and applies --limit after filtering", async () => {
    const repoRoot = await makeTempRepo("pi-harness-g38-cap-");
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-harness-g38-cap-state-")));
    const socketPath = join(stateDir, "daemon.sock");

    try {
      const baseCfg = loadConfig(repoRoot);
      const config = withFixtureCatalog({
        ...baseCfg,
        codeMode: "off",
        goals: { ...baseCfg.goals, autoVerifyOnSettle: false },
        stateDir,
        socketPath,
      });
      const daemon = new HarnessDaemon(config, { dbPath: ":memory:" });
      await daemon.start();

      try {
        const baseSha = (await runGit(repoRoot, ["rev-parse", "HEAD"])).stdout.trim();
        const chat = daemon.director.chats.createSession({
          repoRoot,
          profileId: "fixture",
          title: "Goal 38 Cap Test Chat",
        });
        const goal = daemon.director.goals.createGoal({
          repoRoot,
          chatSessionId: chat.id,
          title: "Verify escalations join cap",
          description: "Test human-visible escalation behind >500 internal open rows",
          criteria: [{ id: "c1", description: "Done", kind: "behavioral", required: true }],
          verificationMode: "none",
        });
        const run = daemon.db.createRun({
          goal: "Cap regression run",
          repoRoot,
          baseBranch: "main",
          baseSha,
        });
        daemon.director.goals.linkRunAndStart(goal.id, run.id);

        const t1 = daemon.db.createTask({
          runId: run.id,
          tier: 1,
          kind: "orchestrator",
          title: "Orchestrator",
          objective: "Coordinate",
          profileId: "fixture",
          model: "fixture/fixture",
        });
        daemon.db.updateTask(t1.id, { status: "running" });

        const t2 = daemon.db.createTask({
          runId: run.id,
          parentId: t1.id,
          tier: 2,
          kind: "worker",
          title: "Worker",
          objective: "Execute",
          profileId: "fixture",
          model: "fixture/fixture",
        });
        daemon.db.updateTask(t2.id, { status: "running" });

        const baseTs = Date.now() - 10_000;
        const insertEsc = daemon.db.db.prepare(
          `INSERT INTO escalations (
            id, run_id, from_task_id, to_task_id, severity, category, title,
            evidence_paths_json, attempted_json, suggested_splits_json, blocking, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, '["file.txt"]', '[]', '[]', 1, 'open', ?)`,
        );
        const seedEscalations = daemon.db.db.transaction(() => {
          insertEsc.run("esc-vis-older", run.id, t2.id, null, "P0", "ambiguous_spec", "Older human escalation", baseTs);
          insertEsc.run(
            "esc-vis-newer",
            run.id,
            t2.id,
            null,
            "P0",
            "blocked_dependency",
            "Newer human escalation",
            baseTs + 10,
          );
          for (let i = 0; i < 505; i++) {
            insertEsc.run(
              `esc-agent-${String(i).padStart(3, "0")}`,
              run.id,
              t2.id,
              t1.id,
              "P1",
              "code_defect",
              `Agent escalation ${i}`,
              baseTs + 1000 + i,
            );
          }
        });
        seedEscalations();

        const visibleJson = await runCli(["escalations", "list", "--json"], { stateDir, cwd: repoRoot });
        assert.equal(visibleJson.code, 0, visibleJson.stderr);
        const visibleParsed = JSON.parse(visibleJson.stdout) as Array<{ id: string }>;
        assert.deepEqual(
          visibleParsed.map((e) => e.id),
          ["esc-vis-newer", "esc-vis-older"],
        );

        const limitedJson = await runCli(["escalations", "list", "--limit", "1", "--json"], { stateDir, cwd: repoRoot });
        assert.equal(limitedJson.code, 0, limitedJson.stderr);
        const limitedParsed = JSON.parse(limitedJson.stdout) as Array<{ id: string }>;
        assert.deepEqual(
          limitedParsed.map((e) => e.id),
          ["esc-vis-newer"],
        );

        const limitedText = await runCli(["escalations", "list", "--limit", "1"], { stateDir, cwd: repoRoot });
        assert.equal(limitedText.code, 0, limitedText.stderr);
        assert.ok(limitedText.stdout.includes("esc-vis-newer"), limitedText.stdout);
        assert.ok(!limitedText.stdout.includes("esc-vis-older"), limitedText.stdout);
        assert.ok(
          limitedText.stdout.includes("(showing first 1 matching escalation(s); narrow with --run or raise --limit)"),
          limitedText.stdout,
        );
        assert.ok(
          limitedText.stdout.includes("(505 internal escalation(s) hidden; use --all)"),
          limitedText.stdout,
        );
      } finally {
        await daemon.stop();
      }
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
