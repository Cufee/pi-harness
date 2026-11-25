import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "bun:test";
import {
  archiveRef,
  archiveRefPatterns,
  archiveRefRunId,
  describeMergedRefFallback,
  describeMergedRefTemplate,
  describeMissingMergedRef,
  isArchiveRef,
  mergedRef,
  mergedRefCandidates,
  parseArchiveRef,
  taskBranchName,
} from "../src/storage/names.js";
import { resetStoragePathsForTest } from "../src/storage/paths.js";

const initialStorageLayout = process.env.PI_HARNESS_STORAGE_LAYOUT;

function restoreStorageLayout(): void {
  if (initialStorageLayout === undefined) {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  } else {
    process.env.PI_HARNESS_STORAGE_LAYOUT = initialStorageLayout;
  }
  resetStoragePathsForTest();
}

afterEach(() => {
  restoreStorageLayout();
});

describe("src/storage/names (legacy layout)", () => {
  beforeEach(() => {
    process.env.PI_HARNESS_STORAGE_LAYOUT = "legacy";
    resetStoragePathsForTest();
  });
  it("builds exact legacy branch names, archive refs, merged refs, and ref patterns", () => {
    const run = { id: "run-30", chatSessionId: "chat-4" };
    const bareRun = { id: "run-30" };

    assert.equal(taskBranchName(run, "t-493"), "harness/run-30/t-493");
    assert.equal(taskBranchName(bareRun, "t-493", "legacy"), "harness/run-30/t-493");

    assert.equal(archiveRef(run, "t-493"), "refs/harness/archive/run-30/t-493");
    assert.equal(archiveRef(bareRun, "t-493", "legacy"), "refs/harness/archive/run-30/t-493");

    assert.equal(mergedRef(run), "refs/harness/merged/run-30");
    assert.equal(mergedRef(bareRun, "legacy"), "refs/harness/merged/run-30");

    assert.deepEqual(mergedRefCandidates(run), ["refs/harness/merged/run-30"]);
    assert.deepEqual(mergedRefCandidates(bareRun, "legacy"), ["refs/harness/merged/run-30"]);

    assert.deepEqual(archiveRefPatterns(), ["refs/harness/archive/*/*", "refs/harness/*/archive/*/*"]);
    assert.deepEqual(archiveRefPatterns("run-30"), [
      "refs/harness/archive/run-30/*",
      "refs/harness/*/archive/run-30/*",
    ]);
    assert.deepEqual(archiveRefPatterns(run), [
      "refs/harness/archive/run-30/*",
      "refs/harness/*/archive/run-30/*",
    ]);
  });

  it("recognizes archive refs of both legacy and chat shapes and extracts their owning run id", () => {
    assert.deepEqual(parseArchiveRef("refs/harness/archive/run-30/t-493"), {
      runId: "run-30",
      taskId: "t-493",
    });
    assert.equal(isArchiveRef("refs/harness/archive/run-30/t-493"), true);
    assert.equal(isArchiveRef("refs/harness/archive/run-30/t-493", "run-30"), true);
    assert.equal(isArchiveRef("refs/harness/archive/run-30/t-493", "run-31"), false);
    assert.equal(archiveRefRunId("refs/harness/archive/run-30/t-493"), "run-30");

    assert.deepEqual(parseArchiveRef("refs/harness/chat-7/archive/run-30/t-493"), {
      runId: "run-30",
      taskId: "t-493",
      chatSessionId: "chat-7",
    });
    assert.deepEqual(parseArchiveRef("refs/harness/legacy/archive/run-30/t-493"), {
      runId: "run-30",
      taskId: "t-493",
      chatSessionId: "legacy",
    });
    assert.equal(isArchiveRef("refs/harness/chat-7/archive/run-30/t-493"), true);
    assert.equal(isArchiveRef("refs/harness/chat-7/archive/run-30/t-493", "run-30"), true);
    assert.equal(isArchiveRef("refs/harness/chat-7/archive/run-30/t-493", "run-3"), false);
    assert.equal(archiveRefRunId("refs/harness/chat-7/archive/run-30/t-493"), "run-30");

    // Chat segments literally named "archive" or "merged" round-trip cleanly and never collide with merged refs.
    const archiveChatRef = archiveRef({ id: "run-30", chatSessionId: "archive" }, "t-493", "data-dir");
    assert.equal(archiveChatRef, "refs/harness/archive/archive/run-30/t-493");
    assert.deepEqual(parseArchiveRef(archiveChatRef), {
      runId: "run-30",
      taskId: "t-493",
      chatSessionId: "archive",
    });
    assert.equal(isArchiveRef(archiveChatRef, "run-30"), true);

    const mergedChatRef = archiveRef({ id: "run-30", chatSessionId: "merged" }, "t-493", "data-dir");
    assert.equal(mergedChatRef, "refs/harness/merged/archive/run-30/t-493");
    assert.deepEqual(parseArchiveRef(mergedChatRef), {
      runId: "run-30",
      taskId: "t-493",
      chatSessionId: "merged",
    });
    assert.equal(isArchiveRef(mergedChatRef, "run-30"), true);

    for (const nonArchive of [
      "",
      "refs/harness/archive",
      "refs/harness/archive/run-30",
      "refs/harness/archive/run-30/t-493/extra",
      "refs/harness/merged/run-30",
      "refs/harness/chat-7/merged/run-30",
      "refs/harness/legacy/merged/run-30",
      "refs/harness/archive/merged/run-30",
      "refs/harness/merged/merged/run-30",
      "refs/harness/chat-7/archive/run-30",
      "refs/harness/chat-7/archive/run-30/t-493/extra",
      "refs/heads/harness/run-30/t-493",
      "refs/heads/harness/chat-7/run-30/t-493",
    ]) {
      assert.equal(parseArchiveRef(nonArchive), null, `expected null for ${JSON.stringify(nonArchive)}`);
      assert.equal(isArchiveRef(nonArchive), false, `expected false for ${JSON.stringify(nonArchive)}`);
      assert.equal(archiveRefRunId(nonArchive), null, `expected null runId for ${JSON.stringify(nonArchive)}`);
    }
  });

  it("produces exact prompt and diagnostic text naming the merged ref", () => {
    assert.equal(describeMergedRefTemplate(), "refs/harness/merged/<runId>");
    assert.equal(
      describeMergedRefFallback(),
      "If the run's base branch was deleted and verify_ref is unset, gates fall back to the run's last merged commit (refs/harness/merged/<runId>); if neither exists, verification fails with remediation options.",
    );
    assert.equal(
      describeMissingMergedRef({ id: "run-30" }),
      "has no merged commit (refs/harness/merged/run-30)",
    );
    assert.equal(
      describeMissingMergedRef({ id: "run-30" }, "1234567890abcdef"),
      "has no merged ref (refs/harness/merged/run-30; latest promoted commit was 1234567)",
    );
  });
});

describe("src/storage/names (data-dir layout)", () => {
  it("builds chat-scoped branch, archive ref, merged ref, and candidate lists", () => {
    const chatRun = { id: "run-30", chatSessionId: "chat-7" };
    const bareRun = { id: "run-30" };
    const nullChatRun = { id: "run-30", chatSessionId: null };

    assert.equal(taskBranchName(chatRun, "t-493", "data-dir"), "harness/chat-7/run-30/t-493");
    assert.equal(taskBranchName(bareRun, "t-493", "data-dir"), "harness/legacy/run-30/t-493");
    assert.equal(taskBranchName(nullChatRun, "t-493", "data-dir"), "harness/legacy/run-30/t-493");

    assert.equal(archiveRef(chatRun, "t-493", "data-dir"), "refs/harness/chat-7/archive/run-30/t-493");
    assert.equal(archiveRef(bareRun, "t-493", "data-dir"), "refs/harness/legacy/archive/run-30/t-493");
    assert.equal(archiveRef(nullChatRun, "t-493", "data-dir"), "refs/harness/legacy/archive/run-30/t-493");

    assert.equal(mergedRef(chatRun, "data-dir"), "refs/harness/chat-7/merged/run-30");
    assert.equal(mergedRef(bareRun, "data-dir"), "refs/harness/legacy/merged/run-30");
    assert.equal(mergedRef(nullChatRun, "data-dir"), "refs/harness/legacy/merged/run-30");

    assert.deepEqual(mergedRefCandidates(chatRun, "data-dir"), [
      "refs/harness/chat-7/merged/run-30",
      "refs/harness/merged/run-30",
    ]);
    assert.deepEqual(mergedRefCandidates(bareRun, "data-dir"), [
      "refs/harness/legacy/merged/run-30",
      "refs/harness/merged/run-30",
    ]);
    assert.deepEqual(mergedRefCandidates(chatRun, "legacy"), ["refs/harness/merged/run-30"]);

    assert.deepEqual(archiveRefPatterns(undefined, "data-dir"), [
      "refs/harness/archive/*/*",
      "refs/harness/*/archive/*/*",
    ]);
    assert.deepEqual(archiveRefPatterns(chatRun, "data-dir"), [
      "refs/harness/archive/run-30/*",
      "refs/harness/*/archive/run-30/*",
    ]);

    assert.equal(describeMergedRefTemplate("data-dir"), "refs/harness/<chat>/merged/<runId>");
    assert.equal(
      describeMergedRefFallback("data-dir"),
      "If the run's base branch was deleted and verify_ref is unset, gates fall back to the run's last merged commit (refs/harness/<chat>/merged/<runId>); if neither exists, verification fails with remediation options.",
    );
    assert.equal(
      describeMissingMergedRef(chatRun, null, "data-dir"),
      "has no merged commit (refs/harness/chat-7/merged/run-30)",
    );
    assert.equal(
      describeMissingMergedRef(chatRun, "abcdef1234567890", "data-dir"),
      "has no merged ref (refs/harness/chat-7/merged/run-30; latest promoted commit was abcdef1)",
    );
    assert.equal(
      describeMissingMergedRef(bareRun, null, "data-dir"),
      "has no merged commit (refs/harness/legacy/merged/run-30)",
    );
  });

  it("uses data-dir names by default when PI_HARNESS_STORAGE_LAYOUT is unset or set to data-dir", () => {
    const run = { id: "run-30", chatSessionId: "chat-7" };
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
    resetStoragePathsForTest();

    assert.equal(taskBranchName(run, "t-1"), "harness/chat-7/run-30/t-1");
    assert.equal(archiveRef(run, "t-1"), "refs/harness/chat-7/archive/run-30/t-1");
    assert.equal(mergedRef(run), "refs/harness/chat-7/merged/run-30");
    assert.deepEqual(mergedRefCandidates(run), [
      "refs/harness/chat-7/merged/run-30",
      "refs/harness/merged/run-30",
    ]);
    assert.equal(describeMergedRefTemplate(), "refs/harness/<chat>/merged/<runId>");

    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();
    assert.equal(mergedRef({ id: "run-30" }), "refs/harness/legacy/merged/run-30");
  });
});
