import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import { reconcileAssistantHistory, type ReconcileRow } from "../src/tui/chat-reconcile.js";

function row(role: ReconcileRow["role"], content: string, seq?: number): ReconcileRow {
  return seq !== undefined ? { role, content, seq } : { role, content };
}

describe("goal-34: pure reconnect assistant reconciliation (R1-R3)", () => {
  interface TableCase {
    name: string;
    frozen: string[];
    tail: string;
    rows: ReconcileRow[];
    busy: boolean;
    expectedRender: string[];
    expectedSkip: string[];
    expectedTailRemainder: string;
    expectedRemainingFrozen: string[];
  }

  const cases: TableCase[] = [
    // Review-3 case 1: Rollover (tail "AB", rows A, B -> render A, B; empty tail remainder)
    {
      name: "R2 rollover: tail AB covered by successive rows A then B",
      frozen: [],
      tail: "Part A.\n\nPart B.",
      rows: [row("assistant", "Part A.", 1), row("assistant", "Part B.", 2)],
      busy: false,
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
      expectedRender: ["Viewer reply completed."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // Review-3 case 4: Rollover followed by structured tool card seen live
    {
      name: "R1 rollover + live tool card: frozen AB consumes both persisted rows A and B and skips both",
      frozen: ["Part A.\n\nPart B."],
      tail: "",
      rows: [
        row("assistant", "Part A.", 1),
        row("assistant", "Part B.", 2),
        row("tool_output", "run-1", 3),
      ],
      busy: false,
      expectedRender: [],
      expectedSkip: ["Part A.", "Part B."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 multiple frozen segments match successive persisted rows across tool/user rows",
      frozen: ["Seg 1", "Seg 2A Seg 2B"],
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
      expectedRender: ["Seg 3 full"],
      expectedSkip: ["Seg 1", "Seg 2A", "Seg 2B"],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 non-prefix row ends frozen matching, drops remainder, and renders this and all later rows",
      frozen: ["Frozen A", "Frozen B"],
      tail: "",
      rows: [
        row("assistant", "Different X", 1),
        row("assistant", "Frozen B", 2),
      ],
      busy: false,
      expectedRender: ["Different X", "Frozen B"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 partial frozen consumed then non-prefix row drops remaining frozen and renders rest",
      frozen: ["Part A. Part B."],
      tail: "",
      rows: [
        row("assistant", "Part A.", 1),
        row("assistant", "Different C.", 2),
      ],
      busy: false,
      expectedRender: ["Different C."],
      expectedSkip: ["Part A."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 row longer than frozen head is not a prefix: drops frozen and renders row",
      frozen: ["Part A"],
      tail: "",
      rows: [row("assistant", "Part A extended", 1)],
      busy: false,
      expectedRender: ["Part A extended"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // Review-3 case 5: Rollover, then daemon dies before B is persisted
    {
      name: "R2+R3 rollover partial persistence: tail AB with only row A persisted renders A and returns remainder B",
      frozen: [],
      tail: "Part A.\n\nPart B unpersisted.",
      rows: [row("assistant", "Part A.", 1)],
      busy: false,
      expectedRender: ["Part A."],
      expectedSkip: [],
      expectedTailRemainder: "Part B unpersisted.",
      expectedRemainingFrozen: [],
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
      expectedRender: ["INTRO"],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1+R3 live tool card froze INTRO, unpersisted post-tool tail is returned on idle reopen",
      frozen: ["INTRO"],
      tail: "POST-TOOL-TAIL",
      rows: [
        row("assistant", "INTRO", 1),
        row("tool_output", "run-1", 2),
      ],
      busy: false,
      expectedRender: [],
      expectedSkip: ["INTRO"],
      expectedTailRemainder: "POST-TOOL-TAIL",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1+R2 two equal segments: first skipped as frozen, second rendered and covers tail",
      frozen: ["Yes."],
      tail: "Yes.",
      rows: [
        row("assistant", "Yes.", 1),
        row("tool_output", "run-1", 2),
        row("assistant", "Yes.", 3),
      ],
      busy: false,
      expectedRender: ["Yes."],
      expectedSkip: ["Yes."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
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
      expectedRender: ["Part A.", "Part B.", "Part C."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },

    // R3 busy reopen vs idle reopen
    {
      name: "R3 busy reopen always discards tail remainder even when no rows persisted",
      frozen: [],
      tail: "In-progress partial",
      rows: [],
      busy: true,
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
      expectedRender: ["Part A."],
      expectedSkip: [],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R3 idle reopen with no persisted rows preserves trimmed tail",
      frozen: [],
      tail: "  Unpersisted reply\n  line 2  ",
      rows: [],
      busy: false,
      expectedRender: [],
      expectedSkip: [],
      expectedTailRemainder: "Unpersisted reply\n  line 2",
      expectedRemainingFrozen: [],
    },

    // Whitespace-only assistant rows and frozen segments
    {
      name: "Blank assistant rows are skipped without disturbing frozen or tail reconciliation",
      frozen: ["  ", "Part A."],
      tail: "Part B.",
      rows: [
        row("assistant", "   \n ", 1),
        row("assistant", "Part A.", 2),
        row("assistant", "", 3),
        row("assistant", "Part B.", 4),
      ],
      busy: false,
      expectedRender: ["Part B."],
      expectedSkip: ["   \n ", "Part A.", ""],
      expectedTailRemainder: "",
      expectedRemainingFrozen: [],
    },
    {
      name: "R1 busy reopen preserves unconsumed frozen text for a subsequent reconnect in the same turn",
      frozen: ["Part A. Part B."],
      tail: "Tail",
      rows: [row("assistant", "Part A.", 1)],
      busy: true,
      expectedRender: [],
      expectedSkip: ["Part A."],
      expectedTailRemainder: "",
      expectedRemainingFrozen: ["Part B."],
    },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const frozenCopy = [...tc.frozen];
      const rowsCopy = [...tc.rows];

      const res = reconcileAssistantHistory({
        frozen: frozenCopy,
        tail: tc.tail,
        rows: rowsCopy,
        busy: tc.busy,
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

      // Verify skipIndices agrees with skipRows on input.rows
      const indexedSkips = tc.rows.filter((_, idx) => res.skipIndices.has(idx));
      assert.deepEqual(indexedSkips, res.skipRows, "skipIndices must match skipRows");

      // Purity: inputs were not mutated
      assert.deepEqual(frozenCopy, tc.frozen, "frozen input must not be mutated");
      assert.deepEqual(rowsCopy, tc.rows, "rows input must not be mutated");
    });
  }
});
