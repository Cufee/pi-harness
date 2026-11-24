import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { ScopeNudgeMonitor } from "../src/runners/scope-nudge.js";

describe("ScopeNudgeMonitor", () => {
  const workspaceRoot = "/repo";

  it("nudges on widening multi-deliverable scope, repeats only after 6 more areas, and never sends a third", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    const topics = ["cortexsdk", "nats", "listdevices", "commissioning"];
    const nudges: string[] = [];

    // 4 topic searches + reads across 8 areas -> first nudge at 8th area.
    for (let i = 0; i < 4; i++) {
      const res = monitor.observe({
        name: "grep",
        kind: "search",
        status: "completed",
        args: { pattern: topics[i], path: `cloud/mod${i}/handler.go` },
      });
      if (res) nudges.push(res);
    }
    assert.equal(nudges.length, 0);

    for (let i = 4; i < 10; i++) {
      const res = monitor.observe({
        name: "read",
        kind: "read",
        status: "completed",
        args: { path: `cloud/mod${i}/service.go` },
      });
      if (res) nudges.push(res);
    }

    assert.equal(nudges.length, 1);
    assert.ok(nudges[0]!.includes("[Harness scope check]"));
    assert.ok(nudges[0]!.includes("scope_too_large"));
    assert.ok(nudges[0]!.includes("partial: true"));

    // First nudge fired at distinctAreas=8. Areas 8..12 (+5 total: mod8..mod12) must not trigger repeat.
    for (let i = 10; i < 13; i++) {
      const res = monitor.observe({
        name: "read",
        status: "completed",
        args: { path: `cloud/mod${i}/service.go` },
      });
      assert.equal(res, null);
    }

    // 14th distinct area (mod13 -> +6 since 8) triggers the single allowed repeat.
    const second = monitor.observe({
      name: "read",
      status: "completed",
      args: { path: "cloud/mod13/service.go" },
    });
    assert.ok(second && second.includes("[Harness scope check]"));

    // Even after 12 more areas and repeats, a third nudge is never emitted.
    for (let i = 14; i < 26; i++) {
      assert.equal(
        monitor.observe({
          name: "read",
          status: "completed",
          args: { path: `cloud/mod${i}/service.go` },
        }),
        null,
      );
    }
    for (let r = 0; r < 5; r++) {
      assert.equal(
        monitor.observe({
          name: "read",
          status: "completed",
          args: { path: "cloud/mod0/handler.go" },
        }),
        null,
      );
    }
  });

  it("never nudges on a long bounded read of 200 distinct files under 2 areas and one topic", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    assert.equal(
      monitor.observe({
        name: "rg",
        status: "completed",
        args: { query: "schedulerLoop", path: "src/control-plane" },
      }),
      null,
    );
    for (let i = 0; i < 200; i++) {
      const area = i % 2 === 0 ? "src/control-plane" : "src/runners";
      const res = monitor.observe({
        name: "read",
        status: "completed",
        args: { path: `${area}/file-${i}.ts` },
      });
      assert.equal(res, null);
    }
    assert.equal(monitor.signals().distinctAreas.length, 2);
  });

  it("never nudges on a cross-repo single-topic search across 12 areas (W without T)", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    for (let i = 0; i < 12; i++) {
      const res = monitor.observe({
        name: "grep",
        kind: "search",
        status: "completed",
        args: { pattern: "findCallers", path: `packages/pkg${i}/index.ts` },
      });
      assert.equal(res, null);
    }
    const sig = monitor.signals();
    assert.equal(sig.distinctAreas.length, 12);
    assert.equal(sig.searchTopics.length, 1);
  });

  it("nudges when the same normalized read repeats 3 times, but not when paging distinct line ranges", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // Paging through the same file with different ranges is progress, not spinning.
    for (let page = 0; page < 5; page++) {
      assert.equal(
        monitor.observe({
          name: "read",
          status: "completed",
          args: { path: "src/runners/acp-runner.ts", start_line: page * 100 + 1, end_line: (page + 1) * 100 },
        }),
        null,
      );
    }

    // Repeating the exact same read 3 times triggers S.
    assert.equal(
      monitor.observe({ name: "read", status: "completed", args: { path: "src/runners/pi-runner.ts", start_line: 1, end_line: 50 } }),
      null,
    );
    assert.equal(
      monitor.observe({ name: "read", status: "completed", args: { path: "src/runners/pi-runner.ts", start_line: 1, end_line: 50 } }),
      null,
    );
    const nudge = monitor.observe({
      name: "read",
      status: "completed",
      args: { path: "src/runners/pi-runner.ts", start_line: 1, end_line: 50 },
    });
    assert.ok(nudge);
    assert.ok(nudge.includes("[Harness scope check]"));
    assert.match(nudge, /repeated.*3 times/i);
  });

  it("pairs in_progress args with completed events by id, parses truncated JSON previews, and ignores control-plane calls", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    // Ignored control-plane tools do not affect signals.
    for (let i = 0; i < 5; i++) {
      assert.equal(
        monitor.observe({
          name: "artifact_write",
          status: "completed",
          args: { name: "notes.md", content: `differentTopic${i} content body` },
        }),
        null,
      );
    }
    assert.equal(monitor.signals().searchTopics.length, 0);

    // Truncated JSON preview delivered on in_progress, omitted on completed.
    const truncatedPreview = '{"path":"src/runners/pi-runner.ts","start_line":10,"end_line":40,"extra":"' + "x".repeat(500) + "…";
    for (let i = 0; i < 3; i++) {
      const id = `call-${i}`;
      assert.equal(monitor.observe({ id, name: "read", status: "in_progress", args: truncatedPreview }), null);
      const res = monitor.observe({ id, name: "read", status: "completed" });
      if (i < 2) assert.equal(res, null);
      else assert.ok(res?.includes("repeated"));
    }
  });

  it("distinguishes inspect_command by normalized argv at the same cwd and nudges on 3 identical consecutive calls", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // Three different cat argv at the same cwd must NOT nudge and must count as progress.
    for (const file of ["a.ts", "b.ts", "c.ts"]) {
      const res = monitor.observe({
        name: "inspect_command",
        status: "completed",
        args: { cwd: ".", argv: ["cat", file] },
      });
      assert.equal(res, null);
      assert.equal(monitor.signals().repeatStreak, 1);
      assert.equal(monitor.signals().staleStreak, 0);
    }

    // 12 more distinct commands at cwd '.' must not trigger stale spinning either.
    for (let i = 0; i < 12; i++) {
      assert.equal(
        monitor.observe({
          name: "inspect_command",
          status: "completed",
          args: { cwd: ".", argv: ["cat", `extra-${i}.ts`] },
        }),
        null,
      );
      assert.equal(monitor.signals().staleStreak, 0);
    }

    // Three identical consecutive calls at the same cwd DO nudge.
    assert.equal(
      monitor.observe({ name: "inspect_command", status: "completed", args: { cwd: ".", argv: ["cat", "same.ts"] } }),
      null,
    );
    assert.equal(
      monitor.observe({ name: "inspect_command", status: "completed", args: { cwd: ".", argv: ["cat", "same.ts"] } }),
      null,
    );
    const nudge = monitor.observe({
      name: "inspect_command",
      status: "completed",
      args: { cwd: ".", argv: ["cat", "same.ts"] },
    });
    assert.ok(nudge?.includes("[Harness scope check]"));
    assert.match(nudge!, /repeated.*3 times/i);
  });

  it("preserves verbatim argv tokens (including whitespace) in repeat and progress keys", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    for (const pattern of [" = ", " =", "= "]) {
      const res = monitor.observe({
        name: "inspect_command",
        status: "completed",
        args: { cwd: ".", argv: ["rg", "-F", pattern, "src"] },
      });
      assert.equal(res, null);
      assert.equal(monitor.signals().repeatStreak, 1);
      assert.equal(monitor.signals().staleStreak, 0);
    }

    assert.equal(
      monitor.observe({
        name: "inspect_command",
        status: "completed",
        args: { cwd: ".", argv: ["rg", "-F", " = ", "src"] },
      }),
      null,
    );
    assert.equal(
      monitor.observe({
        name: "inspect_command",
        status: "completed",
        args: { cwd: ".", argv: ["rg", "-F", " = ", "src"] },
      }),
      null,
    );
    const nudge = monitor.observe({
      name: "inspect_command",
      status: "completed",
      args: { cwd: ".", argv: ["rg", "-F", " = ", "src"] },
    });
    assert.ok(nudge?.includes("[Harness scope check]"));
    assert.match(nudge!, /repeated.*3 times/i);
  });

  it("preserves verbatim whitespace in Grep patterns and Bash commands for repeat/progress identity while normalizing topic clusters", () => {
    const grepMonitor = new ScopeNudgeMonitor({ workspaceRoot });

    for (const pattern of ["a b", "a  b", "a   b", " = ", " =", "= "]) {
      const res = grepMonitor.observe({
        name: "Grep",
        kind: "search",
        status: "completed",
        args: { path: "src", pattern },
      });
      assert.equal(res, null);
      assert.equal(grepMonitor.signals().repeatStreak, 1);
      assert.equal(grepMonitor.signals().staleStreak, 0);
    }

    // Truly identical repeated Grep calls still count as repeats and nudge on the 3rd.
    assert.equal(
      grepMonitor.observe({ name: "Grep", kind: "search", status: "completed", args: { path: "src", pattern: "a  b" } }),
      null,
    );
    assert.equal(grepMonitor.signals().repeatStreak, 1);
    assert.equal(
      grepMonitor.observe({ name: "Grep", kind: "search", status: "completed", args: { path: "src", pattern: "a  b" } }),
      null,
    );
    assert.equal(grepMonitor.signals().repeatStreak, 2);
    const grepNudge = grepMonitor.observe({
      name: "Grep",
      kind: "search",
      status: "completed",
      args: { path: "src", pattern: "a  b" },
    });
    assert.equal(grepMonitor.signals().repeatStreak, 3);
    assert.ok(grepNudge?.includes("[Harness scope check]"));
    assert.match(grepNudge!, /repeated.*Grep.*3 times/i);

    // Bash command strings with distinct quoted whitespace must not collide.
    const bashMonitor = new ScopeNudgeMonitor({ workspaceRoot });
    for (const command of ['rg -F "a b" src', 'rg -F "a  b" src', 'rg -F "a   b" src']) {
      const res = bashMonitor.observe({
        name: "Bash",
        status: "completed",
        args: { command },
      });
      assert.equal(res, null);
      assert.equal(bashMonitor.signals().repeatStreak, 1);
      assert.equal(bashMonitor.signals().staleStreak, 0);
    }

    // Truly identical repeated Bash commands still nudge on the 3rd call.
    assert.equal(
      bashMonitor.observe({ name: "Bash", status: "completed", args: { command: 'rg -F "a  b" src' } }),
      null,
    );
    assert.equal(
      bashMonitor.observe({ name: "Bash", status: "completed", args: { command: 'rg -F "a  b" src' } }),
      null,
    );
    const bashNudge = bashMonitor.observe({
      name: "Bash",
      status: "completed",
      args: { command: 'rg -F "a  b" src' },
    });
    assert.equal(bashMonitor.signals().repeatStreak, 3);
    assert.ok(bashNudge?.includes("[Harness scope check]"));
    assert.match(bashNudge!, /repeated.*Bash.*3 times/i);

    // Topic clustering still normalizes case and whitespace across variants of the same token.
    const topicMonitor = new ScopeNudgeMonitor({ workspaceRoot });
    for (const [i, pattern] of ["findCallers", "  FINDCALLERS  ", "findcallers  "].entries()) {
      assert.equal(
        topicMonitor.observe({
          name: "Grep",
          kind: "search",
          status: "completed",
          args: { path: `packages/pkg${i}/index.ts`, pattern },
        }),
        null,
      );
      assert.equal(topicMonitor.signals().repeatStreak, 1);
    }
    assert.equal(topicMonitor.signals().searchTopics.length, 1);
  });

  it("skips scoring when inputs cannot distinguish operations (cwd alone, truncated argv, outer code_exec)", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // cwd alone with no argv/path/query must be skipped, never scored as repeats or stale.
    for (let i = 0; i < 15; i++) {
      assert.equal(monitor.observe({ name: "inspect_command", status: "completed", args: { cwd: "." } }), null);
    }
    assert.equal(monitor.signals().repeatStreak, 0);
    assert.equal(monitor.signals().staleStreak, 0);

    // Truncated argv in preview cannot distinguish commands -> skip scoring.
    const truncatedArgv = '{"cwd":".","argv":["cat","' + "a".repeat(500) + "…";
    for (let i = 0; i < 5; i++) {
      assert.equal(monitor.observe({ name: "inspect_command", status: "completed", args: truncatedArgv }), null);
    }
    assert.equal(monitor.signals().repeatStreak, 0);

    // Outer code_exec wrapper stays opaque even if repeated.
    for (let i = 0; i < 5; i++) {
      assert.equal(
        monitor.observe({ name: "code_exec", status: "completed", args: { code: "output(1)", path: "src/a.ts" } }),
        null,
      );
    }
    assert.equal(monitor.signals().repeatStreak, 0);
  });

  it("counts consecutive identical calls for repeatStreak (not lifetime frequency) and merges cached in_progress fields by id", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // Spaced revisits to a.ts (lifetime count = 3, consecutive streak = 1) must NOT nudge.
    assert.equal(monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } }), null);
    assert.equal(monitor.observe({ name: "read", status: "completed", args: { path: "src/b.ts" } }), null);
    assert.equal(monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } }), null);
    assert.equal(monitor.observe({ name: "read", status: "completed", args: { path: "src/c.ts" } }), null);
    assert.equal(monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } }), null);
    assert.equal(monitor.signals().repeatStreak, 1);

    // Intermediate in_progress update carrying only kind must not wipe cached args for the same id.
    for (let i = 0; i < 3; i++) {
      const id = `merge-${i}`;
      assert.equal(
        monitor.observe({ id, name: "inspect_command", status: "in_progress", args: { cwd: ".", argv: ["cat", "z.ts"] } }),
        null,
      );
      assert.equal(
        monitor.observe({ id, name: "inspect_command", status: "in_progress", kind: "read" }),
        null,
      );
      const res = monitor.observe({ id, name: "inspect_command", status: "completed" });
      if (i < 2) assert.equal(res, null);
      else assert.ok(res?.includes("repeated"));
    }
  });
});
