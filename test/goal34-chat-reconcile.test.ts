import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  matchLiveBoundaryRows,
  reconcileAssistantHistory,
  type FrozenSegment,
  type LiveRenderedTool,
  type LiveRenderedUser,
  type ReconcileRow,
} from "../src/tui/chat-reconcile.js";

function row(role: ReconcileRow["role"], content: string, seq?: number): ReconcileRow {
  return seq !== undefined ? { role, content, seq } : { role, content };
}

function seg(text: string, afterBoundaryCount = 0): FrozenSegment {
  return { text, afterBoundaryCount };
}

function liveTool(ordinal: number, fingerprint: string): LiveRenderedTool {
  return { ordinal, fingerprint };
}

function liveUser(content: string, boundaryOrdinal: number | null = null): LiveRenderedUser {
  return { content, boundaryOrdinal };
}

describe("goal-34: pure reconnect assistant reconciliation (live-boundary ack + R1-R3)", () => {
  interface TableCase {
    name: string;
    frozen: FrozenSegment[];
    tail: string;
    rows: ReconcileRow[];
    busy: boolean;
    daemonRestarted: boolean;
    liveTools?: LiveRenderedTool[];
    liveUsers?: LiveRenderedUser[];
    expectedRender: string[];
    expectedSkip: string[];
    expectedTailRemainder: string;
    expectedRemainingFrozen: FrozenSegment[];
    expectedSkipToolIndices?: number[];
    expectedSkipUserIndices?: number[];
  }

  const cases: TableCase[] = [
    // Review-3 case 1: Rollover (tail "AB", rows A, B -> render A, B; empty tail remainder)
    {
      name: "R2 rollover: tail AB covered by successive rows A then B",
      frozen: [],
      tail: "Part A.\n\nPart B.",
      rows: [row("assistant", "Part A.", 1), row("assistant", "Part B.", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Part A.", "Part B."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R2 rollover: tail AB with tight spacing and edge whitespace covered by rows A, B",
      frozen: [],
      tail: "  Part A. Part B.  ",
      rows: [row("assistant", " Part A. ", 1), row("assistant", "\nPart B.\n", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: [" Part A. ", "\nPart B.\n"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R2 rollover: tail A + partial B covered by rows A then full B",
      frozen: [],
      tail: "Part A.\nPart B",
      rows: [row("assistant", "Part A.", 1), row("assistant", "Part B completed offline.", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Part A.", "Part B completed offline."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // Review-3 case 2: Pi last-response-only (tail "AB", row B -> render B, discard tail)
    {
      name: "R2 Pi last-response-only: tail AB with persisted row B discards tail (history wins, no indexOf)",
      frozen: [],
      tail: "Commentary A.\n\nFinal answer B.",
      rows: [row("assistant", "Final answer B.", 1)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Final answer B."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R2 mismatch: row in the middle of tail does not match via indexOf; history wins and tail is discarded",
      frozen: [],
      tail: "prefix MIDDLE suffix",
      rows: [row("assistant", "MIDDLE", 1)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["MIDDLE"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // Review-3 case 3: Viewer opening busy before user row is persisted
    {
      name: "R2 viewer: leading user row is not a boundary; exact tail matches following assistant reply",
      frozen: [],
      tail: "Viewer reply.",
      rows: [row("user", "Opening prompt", 1), row("assistant", "Viewer reply.", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Viewer reply."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R2 viewer: leading user row is not a boundary; partial prefix tail is covered by full assistant reply",
      frozen: [],
      tail: "Viewer",
      rows: [row("user", "Opening prompt", 1), row("assistant", "Viewer reply completed.", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Viewer reply completed."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // Review-3 case 4: Rollover followed by structured tool card seen live
    {
      name: "R1+tool ack rollover + live tool card: frozen AB consumes both persisted rows A and B and skips both",
      frozen: [seg("Part A.\n\nPart B.", 0)],
      tail: "",
      rows: [
        row("assistant", "Part A.", 1),
        row("assistant", "Part B.", 2),
        row("tool_output", "run-1", 3),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "run-1")],
      expectedRender: [],
      expectedSkip: ["Part A.", "Part B."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [2],
    },
    {
      name: "R1 rollover without live tool match: frozen AB consumes both persisted rows A and B by prefix",
      frozen: [seg("Part A.\n\nPart B.", 0)],
      tail: "",
      rows: [row("assistant", "Part A.", 1), row("assistant", "Part B.", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: [],
      expectedSkip: ["Part A.", "Part B."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 multiple frozen segments match successive persisted rows across tool/user rows",
      frozen: [seg("Seg 1", 0), seg("Seg 2A Seg 2B", 1)],
      tail: "Seg 3",
      rows: [
        row("assistant", "Seg 1", 1),
        row("tool_output", "t1", 2),
        row("assistant", "Seg 2A", 3),
        row("assistant", "Seg 2B", 4),
        row("user", "steer", 5),
        row("assistant", "Seg 3 full", 6),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "t1")],
      expectedRender: ["Seg 3 full"],
      expectedSkip: ["Seg 1", "Seg 2A", "Seg 2B"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [1],
    },
    {
      name: "R1 non-prefix row ends frozen matching, drops remainder, and renders this and all later rows",
      frozen: [seg("Frozen A", 0), seg("Frozen B", 0)],
      tail: "",
      rows: [row("assistant", "Different X", 1), row("assistant", "Frozen B", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Different X", "Frozen B"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 partial frozen consumed then non-prefix row drops remaining frozen and renders rest",
      frozen: [seg("Part A. Part B.", 0)],
      tail: "",
      rows: [row("assistant", "Part A.", 1), row("assistant", "Different C.", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Different C."],
      expectedSkip: ["Part A."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 row longer than frozen head is not a prefix: drops frozen and renders row",
      frozen: [seg("Part A", 0)],
      tail: "",
      rows: [row("assistant", "Part A extended", 1)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Part A extended"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // Review-4 blocker 1 (restart-gated R3): no restart evidence discards tail remainder
    {
      name: "R3 no restart evidence discards tail remainder even when row is a prefix of tail (tail 'X rest X', row 'X')",
      frozen: [],
      tail: "X rest X",
      rows: [row("assistant", "X", 1)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["X"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R3 no restart evidence discards Pi commentary remainder ('Confirmed. I will check.\\n\\nConfirmed.' with row 'Confirmed.')",
      frozen: [],
      tail: "Confirmed. I will check.\n\nConfirmed.",
      rows: [row("assistant", "Confirmed.", 2)],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Confirmed."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R3 no restart evidence discards tail when no rows persisted (live daemon dropped or cancelled empty)",
      frozen: [],
      tail: "Transient streamed text",
      rows: [],
      busy: false,
      daemonRestarted: false,
      expectedRender: [],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R3 restart evidence keeps slice 5 behavior for tail 'X rest X' with row 'X'",
      frozen: [],
      tail: "X rest X",
      rows: [row("assistant", "X", 1)],
      busy: false,
      daemonRestarted: true,
      expectedRender: ["X"],
      expectedSkip: [],
      expectedTailRemainder: "rest X",
      expectedRemainingFrozen: [],
    },

    // Review-3 case 5: Rollover, then daemon dies before B is persisted (with restart evidence)
    {
      name: "R2+R3 rollover partial persistence with restart evidence: tail AB with row A renders A and returns remainder B",
      frozen: [],
      tail: "Part A.\n\nPart B unpersisted.",
      rows: [row("assistant", "Part A.", 1)],
      busy: false,
      daemonRestarted: true,
      expectedRender: ["Part A."],
      expectedSkip: [],
      expectedTailRemainder: "Part B unpersisted.",
      expectedRemainingFrozen: [],
    },

    // Review-4 blocker 2 (structural live-tool acknowledgement before R1)
    {
      name: "Live-tool ack: skips preceding assistant row even when not a prefix of frozen segment (overflow retry + live tool)",
      frozen: [seg("Prompt is too long.\n\nRETRIED-ANSWER", 0)],
      tail: "",
      rows: [
        row("user", "Summarize run", 1),
        row("assistant", "RETRIED-ANSWER", 2),
        row("tool_output", "run-overflow", 3),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "run-overflow")],
      expectedRender: [],
      expectedSkip: ["RETRIED-ANSWER"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [2],
    },
    {
      name: "Live-tool ack: consumes all frozen segments closed by matched tool card and keeps later unclosed frozen segments for R1 + tail for R2",
      frozen: [
        seg("Discarded overflow.\n\nBefore tool 1", 0),
        seg("Steered after tool 1", 1),
      ],
      tail: "After steer",
      rows: [
        row("assistant", "Before tool 1", 1),
        row("tool_output", "card-1", 2),
        row("assistant", "Steered after tool 1", 3),
        row("user", "focus on tests", 4),
        row("assistant", "After steer complete", 5),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "card-1")],
      expectedRender: ["After steer complete"],
      expectedSkip: ["Before tool 1", "Steered after tool 1"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [1],
    },
    {
      name: "Live-tool ack: multiple live tool cards acknowledge all assistant rows before the last matched tool, and rows after follow R2",
      frozen: [
        seg("Overflow.\n\nSeg 1", 0),
        seg("Seg 2", 1),
      ],
      tail: "Seg 3",
      rows: [
        row("assistant", "Seg 1", 1),
        row("tool_output", "card-1", 2),
        row("assistant", "Seg 2", 3),
        row("tool_output", "card-2", 4),
        row("assistant", "Seg 3", 5),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "card-1"), liveTool(2, "card-2")],
      expectedRender: ["Seg 3"],
      expectedSkip: ["Seg 1", "Seg 2"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [1, 3],
    },
    {
      name: "Live-tool ack: offline unmatched tool after live tool does not skip post-live assistant rows",
      frozen: [seg("Overflow.\n\nSeg 1", 0)],
      tail: "Seg 2",
      rows: [
        row("assistant", "Seg 1", 1),
        row("tool_output", "live-card-1", 2),
        row("assistant", "Seg 2", 3),
        row("tool_output", "offline-card-2", 4),
        row("assistant", "Seg 3", 5),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "live-card-1")],
      expectedRender: ["Seg 2", "Seg 3"],
      expectedSkip: ["Seg 1"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [1],
    },
    {
      name: "Live-tool ack on busy reopen: consumes frozen closed by matched card #1 and retains frozen for unmatched card #2",
      frozen: [seg("Overflow.\n\nSeg 1", 0), seg("Seg 2", 1)],
      tail: "In-progress",
      rows: [
        row("assistant", "Seg 1", 1),
        row("tool_output", "card-1", 2),
      ],
      busy: true,
      daemonRestarted: false,
      liveTools: [liveTool(1, "card-1"), liveTool(2, "card-2")],
      expectedRender: [],
      expectedSkip: ["Seg 1"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [seg("Seg 2", 1)],
      expectedSkipToolIndices: [1],
    },

    // Earlier round cases (slice 4)
    {
      name: "R2 offline tool flush + goal system_notice with no final assistant row covers tail and leaves empty remainder",
      frozen: [],
      tail: "INTRO",
      rows: [
        row("assistant", "INTRO", 1),
        row("tool_output", "run-1", 2),
        row("system_notice", "goal achieved", 3),
      ],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["INTRO"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "Live-tool ack + R3 restart: live tool card froze INTRO, unpersisted post-tool tail is returned on idle reopen after restart",
      frozen: [seg("INTRO", 0)],
      tail: "POST-TOOL-TAIL",
      rows: [row("assistant", "INTRO", 1), row("tool_output", "run-1", 2)],
      busy: false,
      daemonRestarted: true,
      liveTools: [liveTool(1, "run-1")],
      expectedRender: [],
      expectedSkip: ["INTRO"],
      expectedTailRemainder: "POST-TOOL-TAIL",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [1],
    },
    {
      name: "Live-tool ack + R3 no restart: live tool card froze INTRO, post-tool tail is discarded on idle reopen without restart",
      frozen: [seg("INTRO", 0)],
      tail: "POST-TOOL-TAIL",
      rows: [row("assistant", "INTRO", 1), row("tool_output", "run-1", 2)],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "run-1")],
      expectedRender: [],
      expectedSkip: ["INTRO"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [1],
    },
    {
      name: "Live-tool ack + R2 two equal segments: first skipped before live tool, second rendered and covers tail",
      frozen: [seg("Yes.", 0)],
      tail: "Yes.",
      rows: [
        row("assistant", "Yes.", 1),
        row("tool_output", "run-1", 2),
        row("assistant", "Yes.", 3),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "run-1")],
      expectedRender: ["Yes."],
      expectedSkip: ["Yes."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [1],
    },
    {
      name: "R2 extra assistant rows persisted after tail is exhausted still render without reviving tail",
      frozen: [],
      tail: "Part A.",
      rows: [
        row("assistant", "Part A.", 1),
        row("assistant", "Part B.", 2),
        row("assistant", "Part C.", 3),
      ],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Part A.", "Part B.", "Part C."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // R3 busy reopen vs idle reopen
    {
      name: "R3 busy reopen always discards tail remainder even with restart flag and no rows persisted",
      frozen: [],
      tail: "In-progress partial",
      rows: [],
      busy: true,
      daemonRestarted: true,
      expectedRender: [],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R3 busy reopen discards unpersisted remainder after rollover row A",
      frozen: [],
      tail: "Part A.\n\nPart B",
      rows: [row("assistant", "Part A.", 1)],
      busy: true,
      daemonRestarted: true,
      expectedRender: ["Part A."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R3 idle reopen after daemon restart with no persisted rows preserves trimmed tail",
      frozen: [],
      tail: "  Unpersisted reply\n  line 2  ",
      rows: [],
      busy: false,
      daemonRestarted: true,
      expectedRender: [],
      expectedSkip: [],
      expectedTailRemainder: "Unpersisted reply\n  line 2",
      expectedRemainingFrozen: [],
    },

    // Whitespace-only assistant rows and frozen segments
    {
      name: "Blank assistant rows are skipped without disturbing frozen or tail reconciliation",
      frozen: [seg("  ", 0), seg("Part A.", 0)],
      tail: "Part B.",
      rows: [
        row("assistant", "   \n ", 1),
        row("assistant", "Part A.", 2),
        row("assistant", "", 3),
        row("assistant", "Part B.", 4),
      ],
      busy: false,
      daemonRestarted: false,
      expectedRender: ["Part B."],
      expectedSkip: ["   \n ", "Part A.", ""],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 busy reopen preserves unconsumed frozen text and its afterBoundaryCount for a subsequent reconnect",
      frozen: [seg("Part A. Part B.", 2)],
      tail: "Tail",
      rows: [row("assistant", "Part A.", 1)],
      busy: true,
      daemonRestarted: false,
      expectedRender: [],
      expectedSkip: ["Part A."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [seg("Part B.", 2)],
    },

    // Review-5 B1 (structural live-boundary acknowledgement for accepted steers + shared ordinal with tool cards)
    {
      name: "Live-steer ack: skips preceding assistant row even when not a prefix of frozen segment (overflow retry + accepted steer)",
      frozen: [seg("Prompt is too long.\n\nRETRIED-ANSWER", 0)],
      tail: "",
      rows: [
        row("user", "Check status", 1),
        row("assistant", "\n\nRETRIED-ANSWER", 2),
        row("user", "Keep going", 3),
        row("assistant", "FINISHED", 4),
      ],
      busy: false,
      daemonRestarted: false,
      liveUsers: [liveUser("Check status", null), liveUser("Keep going", 1)],
      expectedRender: ["FINISHED"],
      expectedSkip: ["\n\nRETRIED-ANSWER"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipUserIndices: [0, 2],
    },
    {
      name: "Live-steer ack: rows after last matched steer boundary still follow R1 and R2",
      frozen: [
        seg("Overflow.\n\nBefore steer 1", 0),
        seg("After steer 1 prefix", 1),
      ],
      tail: "Final tail",
      rows: [
        row("user", "Check status", 1),
        row("assistant", "Before steer 1", 2),
        row("user", "Keep going", 3),
        row("assistant", "After steer 1 prefix", 4),
        row("assistant", "Final tail completed", 5),
      ],
      busy: false,
      daemonRestarted: false,
      liveUsers: [liveUser("Check status", null), liveUser("Keep going", 1)],
      expectedRender: ["Final tail completed"],
      expectedSkip: ["Before steer 1", "After steer 1 prefix"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipUserIndices: [0, 2],
    },
    {
      name: "Live-boundary ack: tool boundary (ordinal 1) followed by steer boundary (ordinal 2) shares one ordinal counter",
      frozen: [
        seg("Overflow 1.\n\nSeg 1", 0),
        seg("Overflow 2.\n\nSeg 2", 1),
      ],
      tail: "Seg 3",
      rows: [
        row("user", "Start", 1),
        row("assistant", "Seg 1", 2),
        row("tool_output", "card-1", 3),
        row("assistant", "Seg 2", 4),
        row("user", "Keep going", 5),
        row("assistant", "Seg 3", 6),
      ],
      busy: false,
      daemonRestarted: false,
      liveTools: [liveTool(1, "card-1")],
      liveUsers: [liveUser("Start", null), liveUser("Keep going", 2)],
      expectedRender: ["Seg 3"],
      expectedSkip: ["Seg 1", "Seg 2"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipToolIndices: [2],
      expectedSkipUserIndices: [0, 4],
    },
    {
      name: "Live-steer ack: unmatched offline steer and opening user row leave R1 in force",
      frozen: [seg("Prompt is too long.\n\nRETRIED-ANSWER", 0)],
      tail: "",
      rows: [
        row("user", "Check status", 1),
        row("assistant", "RETRIED-ANSWER", 2),
        row("user", "Offline steer", 3),
        row("assistant", "FINISHED", 4),
      ],
      busy: false,
      daemonRestarted: false,
      liveUsers: [liveUser("Check status", null)],
      expectedRender: ["RETRIED-ANSWER", "FINISHED"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
      expectedSkipUserIndices: [0],
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const frozenCopy = tc.frozen.map((s) => ({ ...s }));
      const rowsCopy = [...tc.rows];
      const liveToolsCopy = (tc.liveTools ?? []).map((t) => ({ ...t }));
      const liveUsersCopy = (tc.liveUsers ?? []).map((u) => ({ ...u }));

      const liveMatch = matchLiveBoundaryRows(rowsCopy, liveToolsCopy, liveUsersCopy, (r) => r.content);
      const res = reconcileAssistantHistory({
        frozen: frozenCopy,
        tail: tc.tail,
        rows: rowsCopy,
        busy: tc.busy,
        daemonRestarted: tc.daemonRestarted,
        liveBoundaryMatches: liveMatch.matches,
      });

      assert.deepEqual(
        res.renderRows.map((r) => r.content),
        tc.expectedRender,
        "renderRows mismatch",
      );
      assert.deepEqual(
        res.skipRows.map((r) => r.content),
        tc.expectedSkip,
        "skipRows mismatch",
      );
      assert.equal(res.tailRemainder, tc.expectedTailRemainder, "tailRemainder mismatch");
      assert.deepEqual(res.remainingFrozen, tc.expectedRemainingFrozen, "remainingFrozen mismatch");

      if (tc.expectedSkipToolIndices) {
        assert.deepEqual(
          [...liveMatch.skipToolIndices].sort((a, b) => a - b),
          tc.expectedSkipToolIndices,
          "skipToolIndices mismatch",
        );
      }
      if (tc.expectedSkipUserIndices) {
        assert.deepEqual(
          [...liveMatch.skipUserIndices].sort((a, b) => a - b),
          tc.expectedSkipUserIndices,
          "skipUserIndices mismatch",
        );
      }

      // Verify skipIndices agrees with skipRows on input.rows
      const indexedSkips = tc.rows.filter((_, idx) => res.skipIndices.has(idx));
      assert.deepEqual(indexedSkips, res.skipRows, "skipIndices must match skipRows");

      // Purity: inputs were not mutated
      assert.deepEqual(frozenCopy, tc.frozen, "frozen input must not be mutated");
      assert.deepEqual(rowsCopy, tc.rows, "rows input must not be mutated");
      assert.deepEqual(liveToolsCopy, tc.liveTools ?? [], "liveTools input must not be mutated");
      assert.deepEqual(liveUsersCopy, tc.liveUsers ?? [], "liveUsers input must not be mutated");
    });
  }
});
