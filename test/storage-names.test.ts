import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
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
import { runMergedRef } from "../src/worktree/merge-queue.js";

afterEach(() => {
  delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  resetStoragePathsForTest();
});

describe("src/storage/names (legacy layout)", () => {
  it("builds exact legacy branch names, archive refs, merged refs, and ref patterns", () => {
    const run = { id: "run-30", chatSessionId: "chat-4" };
    const bareRun = { id: "run-30" };

    assert.equal(taskBranchName(run, "t-493"), "harness/run-30/t-493");
    assert.equal(taskBranchName(bareRun, "t-493", "legacy"), "harness/run-30/t-493");

    assert.equal(archiveRef(run, "t-493"), "refs/harness/archive/run-30/t-493");
    assert.equal(archiveRef(bareRun, "t-493", "legacy"), "refs/harness/archive/run-30/t-493");

    assert.equal(mergedRef(run), "refs/harness/merged/run-30");
    assert.equal(mergedRef(bareRun, "legacy"), "refs/harness/merged/run-30");
    assert.equal(runMergedRef("run-30"), "refs/harness/merged/run-30");

    assert.deepEqual(mergedRefCandidates(run), ["refs/harness/merged/run-30"]);
    assert.deepEqual(mergedRefCandidates(bareRun, "legacy"), ["refs/harness/merged/run-30"]);

    assert.deepEqual(archiveRefPatterns(), ["refs/harness/archive"]);
    assert.deepEqual(archiveRefPatterns("run-30"), ["refs/harness/archive/run-30"]);
    assert.deepEqual(archiveRefPatterns(run), ["refs/harness/archive/run-30"]);
  });

  it("recognizes archive refs and extracts their owning run id", () => {
    assert.deepEqual(parseArchiveRef("refs/harness/archive/run-30/t-493"), {
      runId: "run-30",
      taskId: "t-493",
    });
    assert.equal(isArchiveRef("refs/harness/archive/run-30/t-493"), true);
    assert.equal(isArchiveRef("refs/harness/archive/run-30/t-493", "run-30"), true);
    assert.equal(isArchiveRef("refs/harness/archive/run-30/t-493", "run-31"), false);
    assert.equal(archiveRefRunId("refs/harness/archive/run-30/t-493"), "run-30");

    for (const nonArchive of [
      "",
      "refs/harness/archive",
      "refs/harness/archive/run-30",
      "refs/harness/archive/run-30/t-493/extra",
      "refs/harness/merged/run-30",
      "refs/heads/harness/run-30/t-493",
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

  it("throws a clear not-implemented error when data-dir layout is requested", () => {
    const run = { id: "run-30", chatSessionId: "chat-1" };
    assert.throws(() => taskBranchName(run, "t-1", "data-dir"), /not implemented/i);
    assert.throws(() => archiveRef(run, "t-1", "data-dir"), /not implemented/i);
    assert.throws(() => mergedRef(run, "data-dir"), /not implemented/i);
    assert.throws(() => mergedRefCandidates(run, "data-dir"), /not implemented/i);
    assert.throws(() => archiveRefPatterns(run, "data-dir"), /not implemented/i);
    assert.throws(() => describeMergedRefTemplate("data-dir"), /not implemented/i);
    assert.throws(() => describeMergedRefFallback("data-dir"), /not implemented/i);
    assert.throws(() => describeMissingMergedRef(run, null, "data-dir"), /not implemented/i);

    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();
    assert.throws(() => mergedRef(run), /not implemented/i);
  });
});
