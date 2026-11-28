import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { HarnessRejection } from "../src/advisories/rejections.js";
import { HARNESS_TEXT_COUNT_PATTERN } from "../src/advisories/rules.js";
import type { Role } from "../src/advisories/types.js";
import { ModelCatalogCompiler } from "../src/catalog/compiler.js";
import { loadConfig } from "../src/config.js";
import { ControlPlaneDb } from "../src/control-plane/db.js";
import { HarnessOrchestrator } from "../src/control-plane/orchestrator.js";
import { buildImmutableSystemPrompt, PROMPT_FACT_USES as TASK_PROMPT_FACT_USES } from "../src/control-plane/prompts.js";
import { toolsForTask } from "../src/control-plane/tools.js";
import { buildDirectorSystemPrompt, DIRECTOR_PROMPT_FACT_USES } from "../src/director/session.js";
import { QuotaClient } from "../src/quota/client.js";
import {
  ALL_ROLES,
  DIRECTOR_ONLY_PHRASES,
  TOOL_REGISTRY,
  WORKER_ONLY_PHRASES,
  allToolNames,
  allowedToolNames,
  describeTool,
  mentionRef,
  notYourTool,
  promptMentions,
  toolFact,
  toolRef,
  toolsForRole,
  type ToolEntry,
} from "../src/tool-descriptions/index.js";
import { runGit } from "../src/worktree/manager.js";
import { withFixtureCatalog } from "./fixtures/launch-config.js";

// Today's tool-name lists re-verified against base commit a9d480d
// (ALL_TOOL_DEFS deleted from src/control-plane/tools.ts; DIRECTOR_TOOLS, GOAL_GET_TOOL, and submit_review_verdict in src/director/).
const DIRECTOR_EXPECTED = [
  "goal_create",
  "goal_commit",
  "queue_list",
  "queue_reorder",
  "queue_force_start",
  "goal_accept",
  "steer_task",
  "write_note",
  "goal_amend",
  "goal_list",
  "project_list",
  "project_switch",
  "project_remove",
  "goal_get",
  "present_result",
  "report_goal_progress",
  "goal_wait",
  "goal_trigger_review",
  "goal_pause",
  "goal_cancel",
  "resolve_escalation",
  "spawn_task",
  "wait_children",
  "wait_tasks",
  "cancel_task",
  "artifact_read",
  "read_file",
  "kb_search",
  "list_models",
  "set_model_selection_context",
  "run_status",
  "steer_run",
  "resume_task",
  "resume_run",
  "schedule_timer",
  "list_timers",
  "cancel_timer",
  "remote_list",
  "session_list",
  "session_create",
  "session_send",
  "session_read",
  "send_request",
  "resolve_request",
  "list_requests",
] as const;

// The lead thread (role "orchestrator"). worktree_status and submit_for_merge are hidden from a read-only lead's listing.
const LEAD_WORKTREE_TOOLS: readonly string[] = ["worktree_status", "submit_for_merge"];

const ORCHESTRATOR_EXPECTED = [
  "tree_view",
  "task_get",
  "list_models",
  "spawn_worker",
  "spawn_task",
  "wait_children",
  "wait_tasks",
  "steer_child",
  "cancel_child",
  "cancel_task",
  "report_goal_progress",
  "report_issue",
  "ack_escalation",
  "request_rollover",
  "query_predecessor",
  "artifact_write",
  "artifact_read",
  "blackboard_set",
  "blackboard_get",
  "ask_agent",
  "reply_agent",
  "kb_search",
  "kb_get",
  "kb_propose",
  "kb_flag_stale",
  "kb_promote",
  "kb_archive",
  "list_peer_runs",
  "contract_publish",
  "contract_get",
  "peer_notify",
  "peer_request",
  "peer_reply",
  "wait_timer",
  "schedule_timer",
  "list_timers",
  "cancel_timer",
  "resume_task",
  "queue_list",
  "queue_reorder",
  "queue_force_start",
  "worktree_status",
  "submit_for_merge",
  "update_plan",
  "triage_request",
  "ask_user",
  "route_to_director",
] as const;

const WORKER_EXPECTED = [
  "tree_view",
  "task_get",
  "list_models",
  "spawn_task",
  "wait_children",
  "wait_tasks",
  "steer_child",
  "cancel_child",
  "report_goal_progress",
  "return_task",
  "report_issue",
  "ack_escalation",
  "request_rollover",
  "query_predecessor",
  "artifact_write",
  "artifact_read",
  "blackboard_set",
  "blackboard_get",
  "ask_agent",
  "reply_agent",
  "worktree_status",
  "submit_for_merge",
  "kb_search",
  "kb_get",
  "kb_propose",
  "kb_flag_stale",
  "wait_timer",
  "schedule_timer",
  "list_timers",
  "cancel_timer",
  "queue_list",
  "queue_reorder",
  "update_plan",
] as const;

const TIER3_EXPECTED = [
  "tree_view",
  "task_get",
  "return_task",
  "report_issue",
  "artifact_write",
  "artifact_read",
  "inspect_command",
  "blackboard_get",
  "kb_search",
  "kb_get",
  "kb_flag_stale",
] as const;

const REVIEWER_EXPECTED = ["submit_review_verdict"] as const;

function sorted(items: Iterable<string>): string[] {
  return [...items].sort();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWordToolPattern(toolName: string): RegExp {
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(toolName)}(?![A-Za-z0-9_])`);
}

function phrasePattern(phrase: string): RegExp {
  return new RegExp(`\\b${escapeRegExp(phrase)}\\b`, "i");
}

function extractSchemaDescriptions(schema: unknown, path = ""): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  if (!schema || typeof schema !== "object") return out;
  for (const [key, value] of Object.entries(schema)) {
    const nextPath = path ? `${path}.${key}` : key;
    if (key === "description" && typeof value === "string") {
      out.push({ path: nextPath, text: value });
    } else if (value && typeof value === "object") {
      out.push(...extractSchemaDescriptions(value, nextPath));
    }
  }
  return out;
}

function registryByName(): Map<string, ToolEntry> {
  return new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]));
}

describe("tool-descriptions registry", () => {
  it("T4-1 single registry", () => {
    const toolsSrc = readFileSync(join(import.meta.dir, "../src/control-plane/tools.ts"), "utf8");
    assert.ok(!toolsSrc.includes("ALL_TOOL_DEFS"), "src/control-plane/tools.ts must not contain ALL_TOOL_DEFS");

    const base = { runId: "run-1", profileId: "acp:claude", title: "Task" };
    assert.deepEqual(
      toolsForTask({ ...base, tier: 1, kind: "orchestrator", readOnly: false }),
      toolsForRole("orchestrator"),
    );
    assert.deepEqual(
      toolsForTask({ ...base, tier: 1, kind: "orchestrator", readOnly: true }),
      toolsForRole("orchestrator", { readOnly: true }),
    );
    assert.deepEqual(
      toolsForTask({ ...base, tier: 2, kind: "worker", readOnly: false }),
      toolsForRole("worker"),
    );
    assert.deepEqual(
      toolsForTask({ ...base, tier: 3, kind: "research", readOnly: true }),
      toolsForRole("research", { readOnly: true }),
    );
    assert.deepEqual(
      toolsForTask({ ...base, tier: 3, kind: "verify", readOnly: true }),
      toolsForRole("verify", { readOnly: true }),
    );
    assert.deepEqual(
      toolsForTask({ ...base, tier: 3, kind: "execute", readOnly: false }),
      toolsForRole("execute", { readOnly: false }),
    );
    assert.deepEqual(
      toolsForTask({ ...base, tier: 3, kind: "execute", readOnly: true }),
      toolsForRole("execute", { readOnly: true }),
    );
  });

  it("T4-1r registry integrity", () => {
    const seen = new Set<string>();
    const allNames = allToolNames();
    const factPlaceholderRe = /\{fact:([A-Za-z0-9_]+)\}/g;

    assert.equal(allNames.size, TOOL_REGISTRY.length);

    for (const entry of TOOL_REGISTRY) {
      assert.ok(!seen.has(entry.name), `duplicate tool name: ${entry.name}`);
      seen.add(entry.name);

      assert.ok(entry.name.includes("_"), `tool name must contain an underscore: ${entry.name}`);
      assert.ok(entry.roles.length > 0, `tool ${entry.name} must have at least one role`);
      assert.equal(typeof entry.description.default, "string", `tool ${entry.name} missing default description`);
      assert.ok(entry.description.default.trim().length > 0, `tool ${entry.name} has blank default description`);
      assert.ok(
        entry.inputSchema.default && typeof entry.inputSchema.default === "object",
        `tool ${entry.name} missing default inputSchema`,
      );

      for (const [variant, template] of Object.entries(entry.description)) {
        if (typeof template !== "string") continue;
        for (const match of template.matchAll(factPlaceholderRe)) {
          const key = match[1];
          assert.ok(
            key !== undefined && entry.facts?.[key] && typeof entry.facts[key].default === "string",
            `tool ${entry.name}.description.${variant} references unknown fact {fact:${key ?? ""}}`,
          );
        }
      }

      for (const role of entry.roles) {
        const expanded = describeTool(entry.name, role);
        assert.ok(!factPlaceholderRe.test(expanded), `unexpanded fact placeholder in ${entry.name} for ${role}: ${expanded}`);
      }

      if (entry.mentions) {
        for (const mention of entry.mentions) {
          assert.ok(allNames.has(mention.tool), `tool ${entry.name} mentions unknown tool ${mention.tool}`);
        }
      }

      if (entry.whenDenied) {
        for (const deniedRole of Object.keys(entry.whenDenied) as Role[]) {
          assert.ok(
            !entry.roles.includes(deniedRole),
            `tool ${entry.name} defines whenDenied for role ${deniedRole} which is in entry.roles`,
          );
        }
      }
    }
  });

  it("T4-2 no tool lost", () => {
    assert.deepEqual(sorted(toolsForRole("director").map((t) => t.name)), sorted(DIRECTOR_EXPECTED));
    // A writable lead thread lists everything it owns; a read-only one loses only its two worktree tools from the listing.
    assert.deepEqual(
      sorted(toolsForRole("orchestrator", { readOnly: false }).map((t) => t.name)),
      sorted(ORCHESTRATOR_EXPECTED),
    );
    assert.deepEqual(
      sorted(toolsForRole("orchestrator", { readOnly: true }).map((t) => t.name)),
      sorted(ORCHESTRATOR_EXPECTED.filter((name) => !LEAD_WORKTREE_TOOLS.includes(name))),
    );
    assert.deepEqual(sorted(allowedToolNames("orchestrator")), sorted(ORCHESTRATOR_EXPECTED));
    assert.deepEqual(sorted(toolsForRole("worker").map((t) => t.name)), sorted(WORKER_EXPECTED));
    assert.deepEqual(sorted(toolsForRole("research").map((t) => t.name)), sorted(TIER3_EXPECTED));
    assert.deepEqual(sorted(toolsForRole("plan").map((t) => t.name)), sorted(TIER3_EXPECTED));
    assert.deepEqual(sorted(toolsForRole("verify").map((t) => t.name)), sorted(TIER3_EXPECTED));
    assert.deepEqual(sorted(toolsForRole("execute", { readOnly: true }).map((t) => t.name)), sorted(TIER3_EXPECTED));
    assert.deepEqual(sorted(toolsForRole("reviewer").map((t) => t.name)), sorted(REVIEWER_EXPECTED));

    // Single expected diff: writable execute does not list inspect_command, while allowedToolNames("execute") still contains it.
    const expectedWritableExecute = TIER3_EXPECTED.filter((name) => name !== "inspect_command");
    assert.deepEqual(sorted(toolsForRole("execute").map((t) => t.name)), sorted(expectedWritableExecute));
    assert.deepEqual(sorted(toolsForRole("execute", { readOnly: false }).map((t) => t.name)), sorted(expectedWritableExecute));
    assert.ok(allowedToolNames("execute").has("inspect_command"));
    assert.deepEqual(sorted(allowedToolNames("execute")), sorted(TIER3_EXPECTED));
  });

  it("T4-3d derived role separation", () => {
    const allNames = [...allToolNames()];
    const byName = registryByName();

    for (const role of ALL_ROLES) {
      const allowed = allowedToolNames(role);
      const lacking = allNames.filter((name) => !allowed.has(name));
      const lackingSet = new Set(lacking);
      // Use readOnly: true for execute so inspect_command is also audited under execute, and readOnly: false for the
      // lead thread so its worktree tools (hidden from a read-only lead) are audited too.
      const listed =
        role === "execute"
          ? toolsForRole(role, { readOnly: true })
          : role === "orchestrator"
            ? toolsForRole(role, { readOnly: false })
            : toolsForRole(role);

      for (const tool of listed) {
        const entry = byName.get(tool.name);
        assert.ok(entry, `missing entry for ${tool.name}`);
        const applicableMentions = (entry.mentions ?? []).filter((m) => !m.roles || m.roles.includes(role));
        const allowedMentionTools = new Set(applicableMentions.map((m) => m.tool));

        const texts: Array<{ label: string; text: string }> = [
          { label: `${role}.${tool.name}.description`, text: tool.description },
          ...extractSchemaDescriptions(tool.inputSchema).map(({ path, text }) => ({
            label: `${role}.${tool.name}.inputSchema.${path}`,
            text,
          })),
        ];

        // 1. No lacking tool name appears as a whole word without an allowance.
        for (const { label, text } of texts) {
          for (const missingTool of lacking) {
            if (allowedMentionTools.has(missingTool)) continue;
            assert.ok(
              !wholeWordToolPattern(missingTool).test(text),
              `${label} mentions lacking tool "${missingTool}" without a mentions allowance: ${text}`,
            );
          }
        }

        // 2. Every mentions item is actually used and names a tool the role lacks.
        const combinedText = texts.map((t) => t.text).join("\n");
        for (const mention of applicableMentions) {
          assert.ok(
            lackingSet.has(mention.tool),
            `${role}.${tool.name} mentions "${mention.tool}", which role "${role}" already owns`,
          );
          assert.ok(
            wholeWordToolPattern(mention.tool).test(combinedText),
            `${role}.${tool.name} declares unused mention "${mention.tool}"`,
          );
        }
      }
    }
  });

  it("T4-4d phrase lists", () => {
    const forbiddenByRole: Record<Role, readonly string[]> = {
      research: [...DIRECTOR_ONLY_PHRASES, ...WORKER_ONLY_PHRASES],
      plan: [...DIRECTOR_ONLY_PHRASES, ...WORKER_ONLY_PHRASES],
      verify: [...DIRECTOR_ONLY_PHRASES, ...WORKER_ONLY_PHRASES],
      reviewer: [...DIRECTOR_ONLY_PHRASES, ...WORKER_ONLY_PHRASES],
      execute: [...DIRECTOR_ONLY_PHRASES],
      worker: [...DIRECTOR_ONLY_PHRASES],
      orchestrator: [...DIRECTOR_ONLY_PHRASES],
      director: [...WORKER_ONLY_PHRASES],
    };

    for (const role of ALL_ROLES) {
      const forbidden = forbiddenByRole[role];
      const listed = role === "execute" ? toolsForRole(role, { readOnly: true }) : toolsForRole(role);

      for (const tool of listed) {
        const texts: Array<{ label: string; text: string }> = [
          { label: `${role}.${tool.name}.description`, text: tool.description },
          ...extractSchemaDescriptions(tool.inputSchema).map(({ path, text }) => ({
            label: `${role}.${tool.name}.inputSchema.${path}`,
            text,
          })),
        ];
        for (const { label, text } of texts) {
          for (const phrase of forbidden) {
            assert.ok(
              !phrasePattern(phrase).test(text),
              `${label} contains forbidden phrase "${phrase}": ${text}`,
            );
          }
        }
      }
    }
  });

  it("T4-3p derived role separation on prompts", () => {
    const allNames = [...allToolNames()];
    const promptsByRole: Array<{ role: Role; prompt: string }> = [
      { role: "director", prompt: buildDirectorSystemPrompt("off") },
      { role: "orchestrator", prompt: buildImmutableSystemPrompt(1, "orchestrator", "off") },
      { role: "worker", prompt: buildImmutableSystemPrompt(2, "worker", "off") },
      { role: "research", prompt: buildImmutableSystemPrompt(3, "research", "off") },
      { role: "plan", prompt: buildImmutableSystemPrompt(3, "plan", "off") },
      { role: "verify", prompt: buildImmutableSystemPrompt(3, "verify", "off") },
      { role: "execute", prompt: buildImmutableSystemPrompt(3, "execute", "off") },
    ];

    for (const { role, prompt } of promptsByRole) {
      const allowed = allowedToolNames(role);
      const lacking = allNames.filter((name) => !allowed.has(name));
      const lackingSet = new Set(lacking);
      const mentions = promptMentions(role);
      const allowedMentions = new Set(mentions.map((m) => m.tool));

      for (const missingTool of lacking) {
        if (allowedMentions.has(missingTool)) continue;
        assert.ok(
          !wholeWordToolPattern(missingTool).test(prompt),
          `${role} system prompt mentions lacking tool "${missingTool}" without mentionRef`,
        );
      }

      for (const mention of mentions) {
        assert.ok(
          lackingSet.has(mention.tool),
          `${role} prompt mentions "${mention.tool}", which role "${role}" already owns`,
        );
        assert.ok(
          wholeWordToolPattern(mention.tool).test(prompt),
          `${role} prompt declares unused mentionRef "${mention.tool}"`,
        );
      }
    }
  });

  it("T4-4p phrase lists on prompts", () => {
    const forbiddenByRole: Record<Exclude<Role, "reviewer">, readonly string[]> = {
      research: [...DIRECTOR_ONLY_PHRASES, ...WORKER_ONLY_PHRASES],
      plan: [...DIRECTOR_ONLY_PHRASES, ...WORKER_ONLY_PHRASES],
      verify: [...DIRECTOR_ONLY_PHRASES, ...WORKER_ONLY_PHRASES],
      execute: [...DIRECTOR_ONLY_PHRASES],
      worker: [...DIRECTOR_ONLY_PHRASES],
      orchestrator: [...DIRECTOR_ONLY_PHRASES],
      director: [...WORKER_ONLY_PHRASES],
    };

    const promptsByRole: Array<{ role: Exclude<Role, "reviewer">; prompt: string }> = [
      { role: "director", prompt: buildDirectorSystemPrompt("off") },
      { role: "orchestrator", prompt: buildImmutableSystemPrompt(1, "orchestrator", "off") },
      { role: "worker", prompt: buildImmutableSystemPrompt(2, "worker", "off") },
      { role: "research", prompt: buildImmutableSystemPrompt(3, "research", "off") },
      { role: "plan", prompt: buildImmutableSystemPrompt(3, "plan", "off") },
      { role: "verify", prompt: buildImmutableSystemPrompt(3, "verify", "off") },
      { role: "execute", prompt: buildImmutableSystemPrompt(3, "execute", "off") },
    ];

    for (const { role, prompt } of promptsByRole) {
      for (const phrase of forbiddenByRole[role]) {
        assert.ok(
          !phrasePattern(phrase).test(prompt),
          `${role} system prompt contains forbidden phrase "${phrase}"`,
        );
      }
    }
  });

  it("T4-5 prompt references", () => {
    assert.throws(() => toolRef("research", "spawn_task"));
    assert.throws(() => toolFact("research", "spawn_task", "noCounts"));
    assert.throws(() => mentionRef("research", "no_such_tool", "parent"));
    assert.equal(toolRef("orchestrator", "spawn_task"), "`spawn_task`");

    // Prompts build cleanly in collapsed Code Mode (toolRef/toolFact check the registry set, not collapsed surface).
    assert.ok(buildDirectorSystemPrompt("collapsed").length > 0);
    assert.ok(buildImmutableSystemPrompt(1, "orchestrator", "collapsed").length > 0);
    assert.ok(buildImmutableSystemPrompt(2, "worker", "collapsed").length > 0);
    for (const kind of ["research", "plan", "verify", "execute"] as const) {
      assert.ok(buildImmutableSystemPrompt(3, kind, "collapsed").length > 0);
    }

    const ref = mentionRef("research", "wait_children", "parent");
    assert.equal(ref, "`wait_children`");
    const recorded = promptMentions("research");
    assert.ok(recorded.some((m) => m.tool === "wait_children" && m.as === "parent"));
  });

  it("T4-6 facts agree", () => {
    const promptsByRole: Record<Exclude<Role, "reviewer">, string> = {
      director: buildDirectorSystemPrompt("off"),
      orchestrator: buildImmutableSystemPrompt(1, "orchestrator", "off"),
      worker: buildImmutableSystemPrompt(2, "worker", "off"),
      research: buildImmutableSystemPrompt(3, "research", "off"),
      plan: buildImmutableSystemPrompt(3, "plan", "off"),
      verify: buildImmutableSystemPrompt(3, "verify", "off"),
      execute: buildImmutableSystemPrompt(3, "execute", "off"),
    };

    const allUses = [...TASK_PROMPT_FACT_USES, ...DIRECTOR_PROMPT_FACT_USES];
    assert.ok(allUses.length > 0);

    // 1. Every PROMPT_FACT_USES entry appears verbatim in both the role's prompt and describeTool.
    for (const { role, tool, key } of allUses) {
      const fact = toolFact(role, tool, key);
      assert.ok(role !== "reviewer", `unexpected reviewer entry in C1 PROMPT_FACT_USES`);
      const prompt = promptsByRole[role];
      const desc = describeTool(tool, role);
      assert.ok(prompt.includes(fact), `${role} prompt missing verbatim fact ${tool}.${key}: ${fact}`);
      assert.ok(desc.includes(fact), `${role} describeTool(${tool}) missing verbatim fact ${tool}.${key}: ${fact}`);
    }

    // 2. Hot-spot literals: after removing every fact string from a role's prompt, none of these may remain.
    const hotSpotLiterals = ["2,000 characters", "blocking: false", "72%", "78%"] as const;
    for (const [role, prompt] of Object.entries(promptsByRole) as Array<[Exclude<Role, "reviewer">, string]>) {
      let stripped = prompt;
      for (const use of allUses) {
        if (use.role !== role) continue;
        stripped = stripped.replaceAll(toolFact(role, use.tool, use.key), "");
      }
      for (const literal of hotSpotLiterals) {
        assert.ok(
          !stripped.includes(literal),
          `${role} prompt still contains hot-spot literal "${literal}" outside toolFact`,
        );
      }
    }
  });

  it("T4-7 allowed set by role", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "pi-harness-t47-"));
    const stateDir = mkdtempSync(join(tmpdir(), "pi-harness-t47-state-"));
    try {
      await runGit(repoRoot, ["init", "-b", "main"]);
      writeFileSync(join(repoRoot, "README.md"), "hello\n", "utf8");
      await runGit(repoRoot, ["add", "README.md"]);
      await runGit(repoRoot, ["-c", "user.name=test", "-c", "user.email=test@local", "commit", "-m", "init"]);

      const db = new ControlPlaneDb(":memory:");
      const config = withFixtureCatalog({ ...loadConfig(repoRoot), stateDir, codeMode: "off" });
      const quota = new QuotaClient();
      const catalog = new ModelCatalogCompiler(config, quota);
      const orch = new HarnessOrchestrator(db, config, catalog, quota, () => ({
        run: async (req) => {
          const art = (await req.executeTool("artifact_write", {
            name: "note.md",
            content: "director child artifact",
            summary: "Note",
          })) as { path: string };
          await req.executeTool("return_task", {
            status: "completed",
            summary: "Done",
            sources: [{ path: "README.md", lines: "1" }],
            artifact_paths: [art.path],
          });
          return { text: "", stopReason: "completed" };
        },
      }));

      // 1. Research task calling spawn_task gets [harness blocked: not-your-tool] with its whenDenied text and nothing is spawned.
      const run = db.createRun({ goal: "Allowed set test", repoRoot, baseBranch: "main", baseSha: "abc" });
      const research = db.createTask({
        runId: run.id,
        tier: 3,
        kind: "research",
        title: "Scout",
        objective: "Explore",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(research.id, { status: "running" });

      const expectedDenied = notYourTool("spawn_task", "research");
      await assert.rejects(
        () =>
          orch.toolExecutor.execute(run.id, research.id, "spawn_task", {
            kind: "research",
            objective: "Should be denied",
            model: "fixture/fixture",
          }),
        (err: unknown) => {
          assert.ok(err instanceof HarnessRejection);
          assert.ok(err.message.startsWith("[harness blocked: not-your-tool]"));
          assert.ok(err.message.includes(expectedDenied.notice.why));
          assert.ok(err.message.includes(expectedDenied.notice.alternative));
          return true;
        },
      );
      assert.deepEqual(db.listTasks(run.id, { parentId: research.id }), []);

      // 2. Writable execute task calling inspect_command runs (L20).
      const execTask = db.createTask({
        runId: run.id,
        tier: 3,
        kind: "execute",
        title: "Writable exec",
        objective: "Edit files",
        readOnly: false,
        profileId: "pi:local",
      });
      db.updateTask(execTask.id, { status: "running" });
      const inspectRes = (await orch.toolExecutor.execute(run.id, execTask.id, "inspect_command", {
        argv: ["cat", "README.md"],
      })) as { exit_code: number; stdout: string };
      assert.equal(inspectRes.exit_code, 0);
      assert.equal(inspectRes.stdout, "hello\n");

      // 3. Synthetic Director owner's spawn_task, wait_tasks, artifact_read, cancel_task pass the allowed-set check.
      const spawned = (await orch.executeDirectorTaskTool("chat-1", repoRoot, "spawn_task", {
        kind: "research",
        title: "Dir scout",
        objective: "Read README",
        model: "fixture/fixture",
      })) as { spawned: string };
      assert.ok(spawned.spawned);
      const waited = (await orch.executeDirectorTaskTool("chat-1", repoRoot, "wait_tasks", {
        ids: [spawned.spawned],
        timeout_s: 5,
      })) as { children: Array<{ artifact_paths: string[] }> };
      const artPath = waited.children[0]?.artifact_paths[0];
      assert.ok(artPath);
      const readRes = (await orch.executeDirectorTaskTool("chat-1", repoRoot, "artifact_read", {
        path: artPath,
      })) as { content: string };
      assert.equal(readRes.content, "director child artifact");

      // cancel_task on a live Director child passes the allowed-set check and cancels it.
      const dirRun = orch.listDirectorTaskRuns("chat-1")[0]!;
      const owner = db.listTasks(dirRun.id).find((t) => t.tier === 1 && t.profileId === "director")!;
      const liveChild = db.createTask({
        runId: dirRun.id,
        parentId: owner.id,
        tier: 3,
        kind: "research",
        title: "Live dir child",
        objective: "Wait",
        readOnly: true,
        profileId: "pi:local",
      });
      db.updateTask(liveChild.id, { status: "running" });
      const cancelled = (await orch.executeDirectorTaskTool("chat-1", repoRoot, "cancel_task", {
        task_id: liveChild.id,
        reason: "No longer needed",
      })) as { cancelled: string };
      assert.equal(cancelled.cancelled, liveChild.id);

      db.close();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("T4-8 no counts", () => {
    for (const role of ALL_ROLES) {
      const listed = role === "execute" ? toolsForRole(role, { readOnly: true }) : toolsForRole(role);
      for (const tool of listed) {
        assert.ok(
          !HARNESS_TEXT_COUNT_PATTERN.test(tool.description),
          `${role}.${tool.name}.description matched count pattern: ${tool.description}`,
        );
        for (const { path, text } of extractSchemaDescriptions(tool.inputSchema)) {
          assert.ok(
            !HARNESS_TEXT_COUNT_PATTERN.test(text),
            `${role}.${tool.name}.inputSchema.${path} matched count pattern: ${text}`,
          );
        }
      }
    }

    for (const entry of TOOL_REGISTRY) {
      if (!entry.facts) continue;
      for (const [key] of Object.entries(entry.facts)) {
        for (const role of entry.roles) {
          const fact = toolFact(role, entry.name, key);
          assert.ok(
            !HARNESS_TEXT_COUNT_PATTERN.test(fact),
            `${role}.${entry.name}.facts.${key} matched count pattern: ${fact}`,
          );
        }
      }
    }
  });

  it("T4-9 role-specific text exists where the design requires it", () => {
    assert.notEqual(describeTool("artifact_read", "director"), describeTool("artifact_read", "research"));
    assert.notEqual(describeTool("spawn_task", "orchestrator"), describeTool("spawn_task", "worker"));
    assert.notEqual(describeTool("report_issue", "worker"), describeTool("report_issue", "verify"));
    assert.notEqual(describeTool("return_task", "worker"), describeTool("return_task", "verify"));

    // Research and verify descriptions of every listed tool contain no Director tool name they lack.
    const directorTools = [...allowedToolNames("director")];
    for (const role of ["research", "verify"] as const) {
      const roleAllowed = allowedToolNames(role);
      const lackingDirectorTools = directorTools.filter((name) => !roleAllowed.has(name));
      for (const tool of toolsForRole(role)) {
        for (const dirTool of lackingDirectorTools) {
          assert.ok(
            !wholeWordToolPattern(dirTool).test(tool.description),
            `${role}.${tool.name} description mentions Director tool "${dirTool}": ${tool.description}`,
          );
        }
      }
    }

    // Explicit c4 assertion: Director's descriptions contain none of WORKER_ONLY_PHRASES.
    for (const tool of toolsForRole("director")) {
      for (const phrase of WORKER_ONLY_PHRASES) {
        assert.ok(
          !phrasePattern(phrase).test(tool.description),
          `director.${tool.name} description contains worker-only phrase "${phrase}": ${tool.description}`,
        );
      }
    }

    // Role-specific whenDenied rejections flow through notYourTool -> REJECTIONS.notYourTool.
    const spawnDenied = notYourTool("spawn_task", "research");
    assert.ok(spawnDenied instanceof HarnessRejection);
    assert.equal(spawnDenied.notice.rule, "not-your-tool");
    assert.ok(!spawnDenied.notice.why.includes("This role's tool list does not include it."));
    assert.ok(spawnDenied.notice.alternative.includes("return_task"));

    const goalDenied = notYourTool("goal_create", "worker");
    assert.ok(goalDenied instanceof HarnessRejection);
    assert.ok(goalDenied.notice.why.includes("Director"));

    // submit_for_merge is the lead thread's own tool now, so the registry holds no denial for it; a read-only Tier 3
    // role still gets a role-specific one, and the lead still gets role-specific text for a tool it lacks.
    assert.ok(allowedToolNames("orchestrator").has("submit_for_merge"));
    assert.equal(registryByName().get("submit_for_merge")?.whenDenied?.orchestrator, undefined);
    const mergeDenied = notYourTool("submit_for_merge", "research");
    assert.ok(mergeDenied instanceof HarnessRejection);
    assert.ok(!mergeDenied.notice.why.includes("This role's tool list does not include it."));
    assert.ok(mergeDenied.notice.alternative.includes("return_task"));

    const leadDenied = notYourTool("goal_create", "orchestrator");
    assert.ok(leadDenied instanceof HarnessRejection);
    assert.ok(leadDenied.notice.why.includes("Director"));
    assert.ok(leadDenied.notice.alternative.includes("report_goal_progress"));

    const fallbackDenied = notYourTool("kb_archive", "research");
    assert.ok(fallbackDenied instanceof HarnessRejection);
    assert.equal(fallbackDenied.notice.why, "This role's tool list does not include it.");
  });

  it("FXT-7b return_task sources parameter description matches the sources fact for every role", () => {
    const returnTaskRoles = ["worker", "execute", "research", "plan", "verify"] as const;
    for (const role of returnTaskRoles) {
      const tool = toolsForRole(role).find((t) => t.name === "return_task");
      assert.ok(tool, `return_task missing from toolsForRole("${role}")`);
      const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> }).properties;
      const paramDesc = props?.sources?.description;
      const factText = toolFact(role, "return_task", "sources");
      assert.equal(
        paramDesc,
        factText,
        `${role} return_task.inputSchema.properties.sources.description must equal toolFact("${role}", "return_task", "sources")`,
      );
      if (role === "research" || role === "plan" || role === "verify") {
        assert.ok(
          paramDesc?.includes("unless you pass partial: true with artifact_paths"),
          `${role} sources parameter description must state the partial artifact-only exception: ${paramDesc}`,
        );
      }
    }
  });
});
