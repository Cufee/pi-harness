import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { HarnessRejection } from "../src/advisories/rejections.js";
import { HARNESS_TEXT_COUNT_PATTERN } from "../src/advisories/rules.js";
import type { Role } from "../src/advisories/types.js";
import { toolsForTier } from "../src/control-plane/tools.js";
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

// Today's tool-name lists as read from commit 075f67b54165c6a8f6ff61d785e8ee7bbfeb26a2
// (ALL_TOOL_DEFS in src/control-plane/tools.ts; DIRECTOR_TOOLS and submit_review_verdict in src/director/runtime.ts).
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
] as const;

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
    assert.deepEqual(sorted(toolsForRole("orchestrator").map((t) => t.name)), sorted(ORCHESTRATOR_EXPECTED));
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

  // slice C1 removes this test when ALL_TOOL_DEFS is deleted
  it("T4-2s schemas preserved", () => {
    const t1Schemas = new Map(toolsForTier(1).map((t) => [t.name, t.inputSchema]));
    const t2Schemas = new Map(toolsForTier(2).map((t) => [t.name, t.inputSchema]));
    const t3Schemas = new Map(toolsForTier(3).map((t) => [t.name, t.inputSchema]));

    const checks: Array<{ role: Role; ctx?: { readOnly: boolean }; expected: Map<string, Record<string, unknown>> }> = [
      { role: "orchestrator", expected: t1Schemas },
      { role: "worker", expected: t2Schemas },
      { role: "research", expected: t3Schemas },
      { role: "plan", expected: t3Schemas },
      { role: "verify", expected: t3Schemas },
      { role: "execute", ctx: { readOnly: true }, expected: t3Schemas },
      { role: "execute", ctx: { readOnly: false }, expected: t3Schemas },
    ];

    for (const { role, ctx, expected } of checks) {
      for (const tool of toolsForRole(role, ctx)) {
        assert.ok(expected.has(tool.name), `unexpected tool ${tool.name} for role ${role}`);
        assert.deepEqual(tool.inputSchema, expected.get(tool.name), `schema drift for ${role}.${tool.name}`);
      }
    }
  });

  it("T4-3d derived role separation", () => {
    const allNames = [...allToolNames()];
    const byName = registryByName();

    for (const role of ALL_ROLES) {
      const allowed = allowedToolNames(role);
      const lacking = allNames.filter((name) => !allowed.has(name));
      const lackingSet = new Set(lacking);
      // Use readOnly: true for execute so inspect_command is also audited under execute.
      const listed = role === "execute" ? toolsForRole(role, { readOnly: true }) : toolsForRole(role);

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

  it("T4-5 prompt references", () => {
    assert.throws(() => toolRef("research", "spawn_task"));
    assert.throws(() => toolFact("research", "spawn_task", "noCounts"));
    assert.throws(() => mentionRef("research", "no_such_tool", "parent"));
    assert.equal(toolRef("orchestrator", "spawn_task"), "`spawn_task`");

    const ref = mentionRef("research", "wait_children", "parent");
    assert.equal(ref, "`wait_children`");
    const recorded = promptMentions("research");
    assert.ok(recorded.some((m) => m.tool === "wait_children" && m.as === "parent"));
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

    const mergeDenied = notYourTool("submit_for_merge", "orchestrator");
    assert.ok(mergeDenied instanceof HarnessRejection);
    assert.ok(mergeDenied.notice.alternative.includes("spawn_worker"));

    const fallbackDenied = notYourTool("kb_archive", "research");
    assert.ok(fallbackDenied instanceof HarnessRejection);
    assert.equal(fallbackDenied.notice.why, "This role's tool list does not include it.");
  });
});
