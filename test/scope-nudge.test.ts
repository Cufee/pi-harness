import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { ScopeNudgeMonitor } from "../src/runners/scope-nudge.js";

describe("ScopeNudgeMonitor", () => {
  const workspaceRoot = "/repo";

  it("T-sn: detects widening multi-deliverable scope at the 8th area with 4 topics", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    const topics = ["cortexsdk", "nats", "listdevices", "commissioning"];

    // 4 topic searches + reads across 7 areas -> no finding yet.
    for (let i = 0; i < 4; i++) {
      monitor.observe({
        name: "grep",
        kind: "search",
        status: "completed",
        args: { pattern: topics[i], path: `cloud/mod${i}/handler.go` },
      });
      assert.equal(monitor.evaluate(), null);
    }

    for (let i = 4; i < 7; i++) {
      monitor.observe({
        name: "read",
        kind: "read",
        status: "completed",
        args: { path: `cloud/mod${i}/service.go` },
      });
      assert.equal(monitor.evaluate(), null);
    }

    // 8th area -> widening finding holds.
    monitor.observe({
      name: "read",
      kind: "read",
      status: "completed",
      args: { path: "cloud/mod7/service.go" },
    });
    const first = monitor.evaluate();
    assert.ok(first?.widening);
    assert.equal(first.widening.areas.length, 8);
    assert.equal(first.widening.topics.length, 4);

    // Continued widening keeps reporting structured widening without monitor-side cadence suppression.
    for (let i = 8; i < 14; i++) {
      monitor.observe({
        name: "read",
        status: "completed",
        args: { path: `cloud/mod${i}/service.go` },
      });
    }
    const later = monitor.evaluate();
    assert.ok(later?.widening);
    assert.equal(later.widening.areas.length, 14);
    assert.equal(later.widening.topics.length, 4);
  });

  it("never flags a long bounded read of 200 distinct files under 2 areas and one topic", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    monitor.observe({
      name: "rg",
      status: "completed",
      args: { query: "schedulerLoop", path: "src/control-plane" },
    });
    assert.equal(monitor.evaluate(), null);
    for (let i = 0; i < 200; i++) {
      const area = i % 2 === 0 ? "src/control-plane" : "src/runners";
      monitor.observe({
        name: "read",
        status: "completed",
        args: { path: `${area}/file-${i}.ts` },
      });
      assert.equal(monitor.evaluate(), null);
    }
    assert.equal(monitor.signals().distinctAreas.length, 2);
  });

  it("never flags a cross-repo single-topic search across 12 areas (W without T)", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    for (let i = 0; i < 12; i++) {
      monitor.observe({
        name: "grep",
        kind: "search",
        status: "completed",
        args: { pattern: "findCallers", path: `packages/pkg${i}/index.ts` },
      });
      assert.equal(monitor.evaluate(), null);
    }
    const sig = monitor.signals();
    assert.equal(sig.distinctAreas.length, 12);
    assert.equal(sig.searchTopics.length, 1);
  });

  it("flags when the same normalized read repeats 3 times, but not when paging distinct line ranges", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // Paging through the same file with different ranges is progress, not spinning.
    for (let page = 0; page < 5; page++) {
      monitor.observe({
        name: "read",
        status: "completed",
        args: { path: "src/runners/acp-runner.ts", start_line: page * 100 + 1, end_line: (page + 1) * 100 },
      });
      assert.equal(monitor.evaluate(), null);
    }

    // Repeating the exact same read 3 times triggers S.
    monitor.observe({ name: "read", status: "completed", args: { path: "src/runners/pi-runner.ts", start_line: 1, end_line: 50 } });
    assert.equal(monitor.evaluate(), null);
    monitor.observe({ name: "read", status: "completed", args: { path: "src/runners/pi-runner.ts", start_line: 1, end_line: 50 } });
    assert.equal(monitor.evaluate(), null);
    monitor.observe({
      name: "read",
      status: "completed",
      args: { path: "src/runners/pi-runner.ts", start_line: 1, end_line: 50 },
    });
    assert.deepEqual(monitor.evaluate(), { repeated: { tool: "read", times: 3 } });
  });

  it("pairs in_progress args with completed events by id, parses truncated JSON previews, and ignores control-plane calls", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });
    // Ignored control-plane tools do not affect signals.
    for (let i = 0; i < 5; i++) {
      monitor.observe({
        name: "artifact_write",
        status: "completed",
        args: { name: "notes.md", content: `differentTopic${i} content body` },
      });
      assert.equal(monitor.evaluate(), null);
    }
    assert.equal(monitor.signals().searchTopics.length, 0);

    // Truncated JSON preview delivered on in_progress, omitted on completed.
    const truncatedPreview = '{"path":"src/runners/pi-runner.ts","start_line":10,"end_line":40,"extra":"' + "x".repeat(500) + "…";
    for (let i = 0; i < 3; i++) {
      const id = `call-${i}`;
      monitor.observe({ id, name: "read", status: "in_progress", args: truncatedPreview });
      assert.equal(monitor.evaluate(), null);
      monitor.observe({ id, name: "read", status: "completed" });
      if (i < 2) assert.equal(monitor.evaluate(), null);
      else assert.deepEqual(monitor.evaluate(), { repeated: { tool: "read", times: 3 } });
    }
  });

  it("distinguishes inspect_command by normalized argv at the same cwd and flags 3 identical consecutive calls", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // Three different cat argv at the same cwd must NOT flag and must count as progress.
    for (const file of ["a.ts", "b.ts", "c.ts"]) {
      monitor.observe({
        name: "inspect_command",
        status: "completed",
        args: { cwd: ".", argv: ["cat", file] },
      });
      assert.equal(monitor.evaluate(), null);
      assert.equal(monitor.signals().repeatStreak, 1);
      assert.equal(monitor.signals().staleStreak, 0);
    }

    // 12 more distinct commands at cwd '.' must not trigger stale spinning either.
    for (let i = 0; i < 12; i++) {
      monitor.observe({
        name: "inspect_command",
        status: "completed",
        args: { cwd: ".", argv: ["cat", `extra-${i}.ts`] },
      });
      assert.equal(monitor.evaluate(), null);
      assert.equal(monitor.signals().staleStreak, 0);
    }

    // Three identical consecutive calls at the same cwd DO flag.
    monitor.observe({ name: "inspect_command", status: "completed", args: { cwd: ".", argv: ["cat", "same.ts"] } });
    assert.equal(monitor.evaluate(), null);
    monitor.observe({ name: "inspect_command", status: "completed", args: { cwd: ".", argv: ["cat", "same.ts"] } });
    assert.equal(monitor.evaluate(), null);
    monitor.observe({
      name: "inspect_command",
      status: "completed",
      args: { cwd: ".", argv: ["cat", "same.ts"] },
    });
    assert.deepEqual(monitor.evaluate(), { repeated: { tool: "inspect_command", times: 3 } });
  });

  it("preserves verbatim argv tokens (including whitespace) in repeat and progress keys", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    for (const pattern of [" = ", " =", "= "]) {
      monitor.observe({
        name: "inspect_command",
        status: "completed",
        args: { cwd: ".", argv: ["rg", "-F", pattern, "src"] },
      });
      assert.equal(monitor.evaluate(), null);
      assert.equal(monitor.signals().repeatStreak, 1);
      assert.equal(monitor.signals().staleStreak, 0);
    }

    monitor.observe({
      name: "inspect_command",
      status: "completed",
      args: { cwd: ".", argv: ["rg", "-F", " = ", "src"] },
    });
    assert.equal(monitor.evaluate(), null);
    monitor.observe({
      name: "inspect_command",
      status: "completed",
      args: { cwd: ".", argv: ["rg", "-F", " = ", "src"] },
    });
    assert.equal(monitor.evaluate(), null);
    monitor.observe({
      name: "inspect_command",
      status: "completed",
      args: { cwd: ".", argv: ["rg", "-F", " = ", "src"] },
    });
    assert.deepEqual(monitor.evaluate(), { repeated: { tool: "inspect_command", times: 3 } });
  });

  it("preserves verbatim whitespace in Grep patterns and Bash commands for repeat/progress identity while normalizing topic clusters", () => {
    const grepMonitor = new ScopeNudgeMonitor({ workspaceRoot });

    for (const pattern of ["a b", "a  b", "a   b", " = ", " =", "= "]) {
      grepMonitor.observe({
        name: "Grep",
        kind: "search",
        status: "completed",
        args: { path: "src", pattern },
      });
      assert.equal(grepMonitor.evaluate(), null);
      assert.equal(grepMonitor.signals().repeatStreak, 1);
      assert.equal(grepMonitor.signals().staleStreak, 0);
    }

    // Truly identical repeated Grep calls still count as repeats and flag on the 3rd.
    grepMonitor.observe({ name: "Grep", kind: "search", status: "completed", args: { path: "src", pattern: "a  b" } });
    assert.equal(grepMonitor.evaluate(), null);
    assert.equal(grepMonitor.signals().repeatStreak, 1);
    grepMonitor.observe({ name: "Grep", kind: "search", status: "completed", args: { path: "src", pattern: "a  b" } });
    assert.equal(grepMonitor.evaluate(), null);
    assert.equal(grepMonitor.signals().repeatStreak, 2);
    grepMonitor.observe({
      name: "Grep",
      kind: "search",
      status: "completed",
      args: { path: "src", pattern: "a  b" },
    });
    assert.equal(grepMonitor.signals().repeatStreak, 3);
    assert.deepEqual(grepMonitor.evaluate(), { repeated: { tool: "Grep", times: 3 } });

    // Bash command strings with distinct quoted whitespace must not collide.
    const bashMonitor = new ScopeNudgeMonitor({ workspaceRoot });
    for (const command of ['rg -F "a b" src', 'rg -F "a  b" src', 'rg -F "a   b" src']) {
      bashMonitor.observe({
        name: "Bash",
        status: "completed",
        args: { command },
      });
      assert.equal(bashMonitor.evaluate(), null);
      assert.equal(bashMonitor.signals().repeatStreak, 1);
      assert.equal(bashMonitor.signals().staleStreak, 0);
    }

    // Truly identical repeated Bash commands still flag on the 3rd call.
    bashMonitor.observe({ name: "Bash", status: "completed", args: { command: 'rg -F "a  b" src' } });
    assert.equal(bashMonitor.evaluate(), null);
    bashMonitor.observe({ name: "Bash", status: "completed", args: { command: 'rg -F "a  b" src' } });
    assert.equal(bashMonitor.evaluate(), null);
    bashMonitor.observe({
      name: "Bash",
      status: "completed",
      args: { command: 'rg -F "a  b" src' },
    });
    assert.equal(bashMonitor.signals().repeatStreak, 3);
    assert.deepEqual(bashMonitor.evaluate(), { repeated: { tool: "Bash", times: 3 } });

    // Topic clustering still normalizes case and whitespace across variants of the same token.
    const topicMonitor = new ScopeNudgeMonitor({ workspaceRoot });
    for (const [i, pattern] of ["findCallers", "  FINDCALLERS  ", "findcallers  "].entries()) {
      topicMonitor.observe({
        name: "Grep",
        kind: "search",
        status: "completed",
        args: { path: `packages/pkg${i}/index.ts`, pattern },
      });
      assert.equal(topicMonitor.evaluate(), null);
      assert.equal(topicMonitor.signals().repeatStreak, 1);
    }
    assert.equal(topicMonitor.signals().searchTopics.length, 1);
  });

  it("skips scoring when inputs cannot distinguish operations (cwd alone, truncated argv, outer code_exec)", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // cwd alone with no argv/path/query must be skipped, never scored as repeats or stale.
    for (let i = 0; i < 15; i++) {
      monitor.observe({ name: "inspect_command", status: "completed", args: { cwd: "." } });
      assert.equal(monitor.evaluate(), null);
    }
    assert.equal(monitor.signals().repeatStreak, 0);
    assert.equal(monitor.signals().staleStreak, 0);

    // Truncated argv in preview cannot distinguish commands -> skip scoring.
    const truncatedArgv = '{"cwd":".","argv":["cat","' + "a".repeat(500) + "…";
    for (let i = 0; i < 5; i++) {
      monitor.observe({ name: "inspect_command", status: "completed", args: truncatedArgv });
      assert.equal(monitor.evaluate(), null);
    }
    assert.equal(monitor.signals().repeatStreak, 0);

    // Outer code_exec wrapper stays opaque even if repeated.
    for (let i = 0; i < 5; i++) {
      monitor.observe({ name: "code_exec", status: "completed", args: { code: "output(1)", path: "src/a.ts" } });
      assert.equal(monitor.evaluate(), null);
    }
    assert.equal(monitor.signals().repeatStreak, 0);
  });

  it("counts consecutive identical calls for repeatStreak (not lifetime frequency) and merges cached in_progress fields by id", () => {
    const monitor = new ScopeNudgeMonitor({ workspaceRoot });

    // Spaced revisits to a.ts (lifetime count = 3, consecutive streak = 1) must NOT flag.
    monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } });
    monitor.observe({ name: "read", status: "completed", args: { path: "src/b.ts" } });
    monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } });
    monitor.observe({ name: "read", status: "completed", args: { path: "src/c.ts" } });
    monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } });
    assert.equal(monitor.evaluate(), null);
    assert.equal(monitor.signals().repeatStreak, 1);

    // Intermediate in_progress update carrying only kind must not wipe cached args for the same id.
    for (let i = 0; i < 3; i++) {
      const id = `merge-${i}`;
      monitor.observe({ id, name: "inspect_command", status: "in_progress", args: { cwd: ".", argv: ["cat", "z.ts"] } });
      assert.equal(monitor.evaluate(), null);
      monitor.observe({ id, name: "inspect_command", status: "in_progress", kind: "read" });
      assert.equal(monitor.evaluate(), null);
      monitor.observe({ id, name: "inspect_command", status: "completed" });
      if (i < 2) assert.equal(monitor.evaluate(), null);
      else assert.deepEqual(monitor.evaluate(), { repeated: { tool: "inspect_command", times: 3 } });
    }
  });

  it("T-sn: evaluate() returns structured findings for widening, repeat, and stale, null on silent cases, and observe() returns void", () => {
    // 1. Widening with multiple topics
    {
      const monitor = new ScopeNudgeMonitor({ workspaceRoot });
      const topics = ["cortexsdk", "nats", "listdevices", "commissioning"];

      for (let i = 0; i < 4; i++) {
        assert.equal(
          monitor.observe({
            name: "grep",
            kind: "search",
            status: "completed",
            args: { pattern: topics[i], path: `cloud/mod${i}/handler.go` },
          }),
          undefined,
        );
        assert.equal(monitor.evaluate(), null);
      }

      for (let i = 4; i < 7; i++) {
        monitor.observe({
          name: "read",
          kind: "read",
          status: "completed",
          args: { path: `cloud/mod${i}/service.go` },
        });
        assert.equal(monitor.evaluate(), null);
      }

      // 8th area: widening + 4 topics holds
      monitor.observe({
        name: "read",
        kind: "read",
        status: "completed",
        args: { path: "cloud/mod7/service.go" },
      });
      const firstFinding = monitor.evaluate();
      assert.ok(firstFinding?.widening);
      assert.equal(firstFinding.widening.areas.length, 8);
      assert.equal(firstFinding.widening.topics.length, 4);
      assert.equal(firstFinding.repeated, undefined);
      assert.equal(firstFinding.stale, undefined);
      assert.deepEqual(monitor.marks(), { areas: 8, scoredCalls: 8 });

      // Additional areas keep evaluate() reporting widening with updated marks
      for (let i = 8; i <= 20; i++) {
        monitor.observe({
          name: "read",
          kind: "read",
          status: "completed",
          args: { path: `cloud/mod${i}/service.go` },
        });
      }

      const postCapFinding = monitor.evaluate();
      assert.ok(postCapFinding?.widening);
      assert.equal(postCapFinding.widening.areas.length, 21);
      assert.equal(postCapFinding.widening.topics.length, 4);
      assert.deepEqual(monitor.marks(), { areas: 21, scoredCalls: 21 });
    }

    // 2. Repeat finding
    {
      const monitor = new ScopeNudgeMonitor({ workspaceRoot });
      for (let i = 0; i < 2; i++) {
        monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts", start_line: 1, end_line: 40 } });
        assert.equal(monitor.evaluate(), null);
      }
      monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts", start_line: 1, end_line: 40 } });
      const finding = monitor.evaluate();
      assert.deepEqual(finding, { repeated: { tool: "read", times: 3 } });
    }

    // 3. Stale finding and resetStale()
    {
      const monitor = new ScopeNudgeMonitor({ workspaceRoot });
      // Seed two seen files so alternating revisits build staleStreak without repeatStreak >= 3
      monitor.observe({ name: "read", status: "completed", args: { path: "src/a.ts" } });
      monitor.observe({ name: "read", status: "completed", args: { path: "src/b.ts" } });
      for (let i = 0; i < 11; i++) {
        monitor.observe({ name: "read", status: "completed", args: { path: i % 2 === 0 ? "src/a.ts" : "src/b.ts" } });
        assert.equal(monitor.evaluate(), null);
      }
      // 12th stale read: evaluate() reports stale until resetStale()
      monitor.observe({ name: "read", status: "completed", args: { path: "src/b.ts" } });
      assert.deepEqual(monitor.evaluate(), { stale: { reads: 12 } });
      assert.deepEqual(monitor.marks(), { areas: 1, scoredCalls: 14 });

      monitor.resetStale();
      assert.equal(monitor.evaluate(), null);
      assert.equal(monitor.signals().staleStreak, 0);
    }

    // 4. Silent cases: long bounded read (200 files, 2 areas, 1 topic) and single topic across 12 areas
    {
      const bounded = new ScopeNudgeMonitor({ workspaceRoot });
      bounded.observe({ name: "rg", status: "completed", args: { query: "schedulerLoop", path: "src/control-plane" } });
      for (let i = 0; i < 200; i++) {
        const area = i % 2 === 0 ? "src/control-plane" : "src/runners";
        bounded.observe({ name: "read", status: "completed", args: { path: `${area}/file-${i}.ts` } });
        assert.equal(bounded.evaluate(), null);
      }

      const singleTopic = new ScopeNudgeMonitor({ workspaceRoot });
      for (let i = 0; i < 12; i++) {
        singleTopic.observe({
          name: "grep",
          kind: "search",
          status: "completed",
          args: { pattern: "findCallers", path: `packages/pkg${i}/index.ts` },
        });
        assert.equal(singleTopic.evaluate(), null);
      }
    }
  });
});
