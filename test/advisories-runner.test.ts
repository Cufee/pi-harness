import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import { agent } from "@agentclientprotocol/sdk/unstable";
import {
  ALL_RULES,
  AdvisoryEngine,
  NativeEventParser,
  buildSubject,
  formatNotice,
} from "../src/advisories/index.js";
import type { AdvisoryRecord, ToolEventLike } from "../src/advisories/types.js";
import type { AcpProfileConfig } from "../src/config.js";
import type { TaskRecord } from "../src/control-plane/db.js";
import { AcpRunner } from "../src/runners/acp-runner.js";
import { filesOutsideWriteScopes } from "../src/worktree/merge-queue.js";

const claudeProfile: AcpProfileConfig = {
  id: "acp:claude",
  kind: "acp",
  adapter: "claude",
  command: "unused",
  billing: "subscription",
};

function makeWorkerTask(id: string): TaskRecord {
  return {
    id,
    runId: "run-t3-9r",
    parentId: "t-parent",
    tier: 2,
    kind: "worker",
    title: "Worker slice",
    objective: "Edit only within src/allowed/",
    criteria: "Modify only in-scope files",
    readOnly: false,
    profileId: "acp:claude",
    model: "opus",
    effort: null,
    status: "running",
    generation: 1,
    maxTurns: 25,
    turnsUsed: 0,
    contextUsed: 0,
    contextSize: 200_000,
    worktreeId: null,
    sessionId: null,
    summary: null,
    handoffJson: null,
    resultJson: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe("goal-14 slice RUN: runner advisory events", () => {
  it("T3-9r: recorded ACP sequence yields one out-of-scope notice, none for in-scope or duplicate completion, and denied events are not counted as edits", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "advisories-runner-t3-9r-"));
    const cwd = join(baseDir, "workspace");
    mkdirSync(join(cwd, "src", "allowed"), { recursive: true });
    mkdirSync(join(cwd, "src", "other"), { recursive: true });
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const inScopeFile = join(cwd, "src", "allowed", "ok.ts");
    const outOfScopeFile = join(cwd, "src", "other", "outside.ts");
    const gitConfig = join(cwd, ".git", "config");
    writeFileSync(inScopeFile, "export const ok = 1;\n", "utf8");
    writeFileSync(outOfScopeFile, "export const outside = 1;\n", "utf8");
    writeFileSync(gitConfig, "[core]\n\trepositoryformatversion = 0\n", "utf8");

    try {
      const recorded: ToolEventLike[] = [];
      const largeContent = "x".repeat(700);

      const fixture = agent()
        .onRequest("initialize", async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest("session/new", async () => ({
          sessionId: "s-t3-9r",
          models: { currentModelId: "opus", availableModels: [{ modelId: "opus", name: "Opus" }] },
        }))
        .onRequest("session/prompt", async ({ client, params }) => {
          const sid = params.sessionId;

          // 1. Out-of-scope edit: pending with locations + truncated rawInput, then completed without rawInput, then duplicate completed
          await client.notify("session/update", {
            sessionId: sid,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "edit-out-1",
              title: "Edit",
              kind: "edit",
              status: "pending",
              locations: [{ path: outOfScopeFile }],
              rawInput: { content: largeContent, file_path: outOfScopeFile },
            },
          } as never);
          await client.notify("session/update", {
            sessionId: sid,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "edit-out-1",
              status: "completed",
            },
          } as never);
          await client.notify("session/update", {
            sessionId: sid,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "edit-out-1",
              status: "completed",
            },
          } as never);

          // 2. In-scope edit: pending with locations + rawInput, then completed without rawInput
          await client.notify("session/update", {
            sessionId: sid,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "edit-in-1",
              title: "Edit",
              kind: "edit",
              status: "pending",
              locations: [{ path: inScopeFile }],
              rawInput: { file_path: inScopeFile, content: "export const ok = 2;\n" },
            },
          } as never);
          await client.notify("session/update", {
            sessionId: sid,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "edit-in-1",
              status: "completed",
            },
          } as never);

          // 3. Denied permission request on protected path, followed by adapter's own failed update for the same call id
          const perm = (await client.request("session/request_permission", {
            sessionId: sid,
            toolCall: {
              toolCallId: "edit-denied-1",
              title: "Edit",
              kind: "edit",
              locations: [{ path: gitConfig }],
              rawInput: { file_path: gitConfig, content: "mutated" },
            },
            options: [
              { kind: "allow_once", optionId: "allow", name: "Allow" },
              { kind: "reject_once", optionId: "deny", name: "Deny" },
            ],
          })) as { outcome: { outcome: string; optionId?: string } };
          assert.equal(perm.outcome.outcome === "selected" ? perm.outcome.optionId : perm.outcome.outcome, "deny");

          await client.notify("session/update", {
            sessionId: sid,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: "edit-denied-1",
              status: "failed",
            },
          } as never);

          await client.notify("session/update", {
            sessionId: sid,
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } },
          } as never);
          return { stopReason: "end_turn" } as never;
        });

      const res = await new AcpRunner(claudeProfile).run(
        {
          runId: "run-t3-9r",
          taskId: "t-worker-1",
          tier: 2,
          kind: "worker",
          cwd,
          model: "opus",
          systemPrompt: "Worker",
          initialPrompt: "Apply edits",
          toolPolicy: "read_write_workspace",
          tools: [],
          executeTool: async () => ({}),
          signal: new AbortController().signal,
          callbacks: {
            onToolEvent: (ev) => {
              recorded.push(ev);
            },
          },
        },
        fixture,
      );
      assert.equal(res.stopReason, "completed");
      assert.equal(recorded.length, 7);

      // Verify NativeEventParser directly against the recorded ACP events
      const parser = new NativeEventParser({
        workspaceRoot: cwd,
        harnessToolNames: new Set(["return_task", "submit_for_merge"]),
      });
      const parsed = recorded.map((ev) => parser.push(ev));
      assert.equal(parsed[0], null, "pending out-of-scope edit caches and returns null");
      assert.deepEqual(parsed[1]?.paths, ["src/other/outside.ts"]);
      assert.equal(parsed[1]?.nativeClass, "edit");
      assert.equal(parsed[1]?.status, "completed");
      assert.equal(parsed[2], null, "duplicate completed update for same call id is dropped");
      assert.equal(parsed[3], null, "pending in-scope edit caches and returns null");
      assert.deepEqual(parsed[4]?.paths, ["src/allowed/ok.ts"]);
      assert.equal(parsed[4]?.nativeClass, "edit");
      assert.equal(parsed[5]?.status, "failed");
      assert.equal(parsed[5]?.denied, "protected-path");
      assert.deepEqual(parsed[5]?.paths, [".git/config"]);
      assert.equal(parsed[6], null, "adapter follow-up failed update after denial is dropped");

      // Feed the recorded sequence into AdvisoryEngine for a worker with write scopes ["src/allowed/"]
      const records: AdvisoryRecord[] = [];
      const engine = new AdvisoryEngine({
        rules: ALL_RULES,
        createScopeSource: () => null,
        filesOutsideWriteScopes,
        harnessToolNames: new Set(["return_task", "submit_for_merge"]),
        record: (entry) => records.push(entry),
      });
      const subject = buildSubject({
        task: makeWorkerTask("t-worker-1"),
        workspaceRoot: cwd,
        writeScopes: ["src/allowed/"],
        writableExtraRoots: [],
      });

      // 1. Out-of-scope edit (pending -> completed -> duplicate completed)
      assert.equal(engine.observeEvent(subject, recorded[0]!), false);
      assert.equal(engine.observeEvent(subject, recorded[1]!), true);
      const outNotices = engine.take(subject.id);
      assert.equal(outNotices.length, 1);
      const w1 = outNotices[0]!;
      assert.equal(w1.level, "advisory");
      assert.equal(w1.rule, "worker-edit-outside-scope");
      assert.ok(w1.what.includes("src/other/outside.ts"));
      assert.ok(w1.why.length > 0);
      assert.ok(w1.alternative.length > 0);
      assert.match(formatNotice(w1), /^\[harness advisory: worker-edit-outside-scope\] .+ Why: .+ Instead: .+/);
      engine.delivered(subject.id, outNotices, "steer");

      // Duplicate completed event for same call id yields no duplicate notice
      assert.equal(engine.observeEvent(subject, recorded[2]!), false);
      assert.deepEqual(engine.take(subject.id), []);
      assert.equal(engine.activityProgress(subject.id), 1);

      // 2. In-scope edit yields no notice
      assert.equal(engine.observeEvent(subject, recorded[3]!), false);
      assert.equal(engine.observeEvent(subject, recorded[4]!), false);
      assert.deepEqual(engine.take(subject.id), []);
      assert.equal(engine.activityProgress(subject.id), 2);

      // 3. Denied permission event (and adapter follow-up failed update) reaches engine as rejection, not as an edit
      assert.equal(engine.observeEvent(subject, recorded[5]!), true);
      assert.equal(engine.observeEvent(subject, recorded[6]!), true);
      const deniedNotices = engine.take(subject.id);
      assert.equal(deniedNotices.length, 1);
      assert.equal(deniedNotices[0]!.level, "rejection");
      assert.equal(deniedNotices[0]!.rule, "protected-path");
      assert.match(formatNotice(deniedNotices[0]!), /^\[harness blocked: protected-path\] .+ Why: .+ Allowed: .+/);
      assert.equal(engine.activityProgress(subject.id), 2, "denied event must not count as an edit");

      // Also verify a denied edit targeting an out-of-scope workspace path never fires worker-edit-outside-scope or adds activity
      const deniedWorkspaceEdit: ToolEventLike = {
        id: "edit-denied-ws",
        name: "Edit",
        title: "Edit",
        kind: "edit",
        status: "failed",
        paths: [join(cwd, "src", "other", "blocked.ts")],
        denied: "read-only-write",
      };
      assert.equal(engine.observeEvent(subject, deniedWorkspaceEdit), true);
      const deniedWsNotices = engine.take(subject.id);
      assert.equal(deniedWsNotices.length, 1);
      assert.equal(deniedWsNotices[0]!.level, "rejection");
      assert.equal(deniedWsNotices[0]!.rule, "read-only-write");
      assert.equal(engine.activityProgress(subject.id), 2, "denied workspace edit must not count as an edit");
      assert.equal(
        records.filter((r) => r.notice.rule === "worker-edit-outside-scope").length,
        1,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
