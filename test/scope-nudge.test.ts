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
});
