import assert from "node:assert/strict";
import { afterEach, describe, it } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import {
  buildGoalGetResult,
  GOAL_GET_LIMITS,
  parseGoalGetOptions,
  writeGoalDescriptionFile,
} from "../src/director/goal-get.js";
import type { GoalRecord } from "../src/goals/engine.js";
import { storagePaths } from "../src/storage/paths.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("writeGoalDescriptionFile", () => {
  it("atomically replaces hard-linked or same-length mismatched description files and rejects symlinks", () => {
    const root = makeTempDir("pi-goal-desc-d1-");
    const repoRoot = join(root, "repo");
    const evidenceDir = join(repoRoot, "evidence", "goal-1");
    mkdirSync(evidenceDir, { recursive: true });

    const longDesc = "Authentic goal description payload. ".repeat(60);
    assert.ok(longDesc.length > GOAL_GET_LIMITS.descriptionExcerpt);

    // 1. Hard-linked regular file of different length must be replaced by rename without modifying the other link.
    const victimShort = join(root, "victim-short.txt");
    const victimShortBody = "do-not-truncate-victim-short\n";
    writeFileSync(victimShort, victimShortBody, "utf8");
    const descPathV1 = join(evidenceDir, "goal-description-v1.md");
    linkSync(victimShort, descPathV1);
    const victimShortIno = lstatSync(victimShort).ino;

    const outV1 = writeGoalDescriptionFile({ version: 1, description: longDesc, repoRoot }, evidenceDir, repoRoot);
    assert.equal(outV1, "evidence/goal-1/goal-description-v1.md");
    assert.equal(readFileSync(victimShort, "utf8"), victimShortBody);
    assert.equal(readFileSync(descPathV1, "utf8"), longDesc);
    const descV1Stat = lstatSync(descPathV1);
    assert.notEqual(descV1Stat.ino, victimShortIno);
    assert.equal(descV1Stat.nlink, 1);
    assert.equal(descV1Stat.mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(evidenceDir), ["goal-description-v1.md"]);

    // Re-running with matching bytes keeps the existing file in place.
    const outV1Repeat = writeGoalDescriptionFile({ version: 1, description: longDesc, repoRoot }, evidenceDir, repoRoot);
    assert.equal(outV1Repeat, "evidence/goal-1/goal-description-v1.md");
    assert.equal(lstatSync(descPathV1).ino, descV1Stat.ino);

    // 2. Hard-linked regular file of the EXACT same byte length but different bytes must be replaced without modifying the other link.
    const sameLenVictim = join(root, "victim-samelen.txt");
    const sameLenOther = "X".repeat(Buffer.byteLength(longDesc, "utf8"));
    assert.equal(Buffer.byteLength(sameLenOther, "utf8"), Buffer.byteLength(longDesc, "utf8"));
    assert.notEqual(sameLenOther, longDesc);
    writeFileSync(sameLenVictim, sameLenOther, "utf8");
    const descPathV2 = join(evidenceDir, "goal-description-v2.md");
    linkSync(sameLenVictim, descPathV2);
    const sameLenVictimIno = lstatSync(sameLenVictim).ino;

    const outV2 = writeGoalDescriptionFile({ version: 2, description: longDesc, repoRoot }, evidenceDir, repoRoot);
    assert.equal(outV2, "evidence/goal-1/goal-description-v2.md");
    assert.equal(readFileSync(sameLenVictim, "utf8"), sameLenOther);
    assert.equal(readFileSync(descPathV2, "utf8"), longDesc);
    const descV2Stat = lstatSync(descPathV2);
    assert.notEqual(descV2Stat.ino, sameLenVictimIno);
    assert.equal(descV2Stat.nlink, 1);

    // 3. Symlink entry at destination returns null and writes nothing.
    const symlinkTarget = join(root, "symlink-target.txt");
    writeFileSync(symlinkTarget, "untouched-symlink-target\n", "utf8");
    const descPathV3 = join(evidenceDir, "goal-description-v3.md");
    symlinkSync(symlinkTarget, descPathV3);
    assert.equal(writeGoalDescriptionFile({ version: 3, description: longDesc, repoRoot }, evidenceDir, repoRoot), null);
    assert.ok(lstatSync(descPathV3).isSymbolicLink());
    assert.equal(readFileSync(symlinkTarget, "utf8"), "untouched-symlink-target\n");

    // 4. Non-regular entry (directory) at destination returns null and leaves no temp files.
    const descPathV4 = join(evidenceDir, "goal-description-v4.md");
    mkdirSync(descPathV4);
    assert.equal(writeGoalDescriptionFile({ version: 4, description: longDesc, repoRoot }, evidenceDir, repoRoot), null);
    assert.ok(lstatSync(descPathV4).isDirectory());
    assert.deepEqual(
      readdirSync(evidenceDir).sort(),
      ["goal-description-v1.md", "goal-description-v2.md", "goal-description-v3.md", "goal-description-v4.md"],
    );

    // 5. Symlinked evidenceDir (with and without trailing separator) and symlinked ancestor write nothing.
    const realTargetDir = join(root, "real-target-dir");
    mkdirSync(realTargetDir, { recursive: true });
    const symlinkEvidenceDir = join(repoRoot, "evidence-link");
    symlinkSync(realTargetDir, symlinkEvidenceDir);
    assert.equal(
      writeGoalDescriptionFile({ version: 5, description: longDesc, repoRoot }, symlinkEvidenceDir, repoRoot),
      null,
    );
    assert.equal(
      writeGoalDescriptionFile({ version: 5, description: longDesc, repoRoot }, `${symlinkEvidenceDir}${sep}`, repoRoot),
      null,
    );
    assert.deepEqual(readdirSync(realTargetDir), []);

    const nestedUnderSymlink = join(symlinkEvidenceDir, "nested");
    mkdirSync(join(realTargetDir, "nested"));
    assert.equal(
      writeGoalDescriptionFile({ version: 5, description: longDesc, repoRoot }, nestedUnderSymlink, repoRoot),
      null,
    );
    assert.deepEqual(readdirSync(join(realTargetDir, "nested")), []);

    const danglingEvidenceDir = join(repoRoot, "dangling-link");
    symlinkSync(join(root, "does-not-exist"), danglingEvidenceDir);
    assert.equal(
      writeGoalDescriptionFile({ version: 5, description: longDesc, repoRoot }, danglingEvidenceDir, repoRoot),
      null,
    );

    // 6. Missing evidenceDir is not created via recursive mkdir when caller passes storage or path is outside repo.
    const missingInRepo = join(repoRoot, "evidence", "missing-goal");
    assert.equal(
      writeGoalDescriptionFile({ version: 6, description: longDesc, repoRoot }, missingInRepo, repoRoot, {
        layout: "legacy",
      }),
      null,
    );
    assert.throws(() => lstatSync(missingInRepo), { code: "ENOENT" });
    const missingOutsideRepo = join(root, "outside-missing", "goal-6");
    assert.equal(
      writeGoalDescriptionFile({ version: 6, description: longDesc, repoRoot }, missingOutsideRepo, repoRoot),
      null,
    );
    assert.throws(() => lstatSync(join(root, "outside-missing")), { code: "ENOENT" });
  });

  it("returns absolute description.path in data-dir layout and repo-relative path in legacy layout", () => {
    const root = makeTempDir("pi-goal-desc-d2-");
    const repoRoot = join(root, "repo");
    const stateDir = join(root, "state");
    const evidenceDir = join(repoRoot, "evidence", "goal-active-legacy");
    mkdirSync(evidenceDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    const longDesc = "Active legacy unit description text. ".repeat(60);
    assert.ok(longDesc.length > GOAL_GET_LIMITS.descriptionExcerpt);

    const expectedAbs = join(evidenceDir, "goal-description-v1.md");
    const expectedRel = "evidence/goal-active-legacy/goal-description-v1.md";

    // Direct calls with explicit layout.
    const dataDirPath = writeGoalDescriptionFile(
      { version: 1, description: longDesc, repoRoot },
      evidenceDir,
      repoRoot,
      "data-dir",
    );
    assert.equal(dataDirPath, expectedAbs);
    assert.ok(isAbsolute(dataDirPath!));

    const legacyPath = writeGoalDescriptionFile(
      { version: 1, description: longDesc, repoRoot },
      evidenceDir,
      repoRoot,
      "legacy",
    );
    assert.equal(legacyPath, expectedRel);
    assert.equal(isAbsolute(legacyPath!), false);

    // Through buildGoalGetResult, layout reaches writeGoalDescriptionFile via ctx.storage.
    const goal: GoalRecord = {
      id: "goal-active-legacy",
      chatSessionId: "chat-1",
      repoRoot,
      version: 1,
      title: "Active legacy unit",
      description: longDesc,
      criteria: [],
      nonGoals: [],
      budgets: { maxReviewCycles: 3, maxNoProgressCycles: 2 },
      verificationMode: "auto",
      verifyRef: "main",
      liveProgress: null,
      status: "executing",
      linkedRunId: null,
      reviewCycle: 0,
      noProgressStreak: 0,
      lastProgressFingerprint: null,
      lastReviewSummary: null,
      createdAt: 1_000,
      updatedAt: 2_000,
    };
    const detail = { goal, reviews: [], tasks: [], openEscalations: [], activity: null };
    const cfg = { stateDir };

    const dataDirRes = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["goal"] }), {
      evidenceDir,
      repoRoot,
      storage: storagePaths(cfg, { layout: "data-dir" }),
    }) as { goal: { description: { path: string | null } } };
    assert.equal(dataDirRes.goal.description.path, expectedAbs);

    const legacyRes = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["goal"] }), {
      evidenceDir,
      repoRoot,
      storage: storagePaths(cfg, { layout: "legacy" }),
    }) as { goal: { description: { path: string | null } } };
    assert.equal(legacyRes.goal.description.path, expectedRel);
  });
});
