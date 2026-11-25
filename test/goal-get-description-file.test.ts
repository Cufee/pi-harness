import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { afterEach, describe, it } from "bun:test";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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

  it("does not write into a redirected evidence directory when swapped after verification", () => {
    const root = makeTempDir("pi-goal-desc-d1-pin-");
    const repoRoot = join(root, "repo");
    mkdirSync(repoRoot, { recursive: true });
    const longDesc = "Pinned goal description payload. ".repeat(60);
    assert.ok(longDesc.length > GOAL_GET_LIMITS.descriptionExcerpt);

    // 1. Leaf swapped for a symlink to another directory after verification (before dirfd open).
    const leafEvDir = join(root, "external-leaf", "goal-1");
    const leafMovedDir = join(root, "external-leaf", "goal-1-moved");
    const leafOtherDir = join(root, "other-leaf-dir");
    mkdirSync(leafEvDir, { recursive: true });
    mkdirSync(leafOtherDir, { recursive: true });
    const leafVictim = join(leafOtherDir, "goal-description-v1.md");
    const leafVictimBody = "untouched-other-dir-leaf-swap\n";
    writeFileSync(leafVictim, leafVictimBody, "utf8");
    const leafVictimIno = lstatSync(leafVictim).ino;

    let leafSwapRan = false;
    const leafOut = writeGoalDescriptionFile(
      { version: 1, description: longDesc, repoRoot },
      leafEvDir,
      repoRoot,
      "data-dir",
      {
        afterVerifyDir: () => {
          leafSwapRan = true;
          renameSync(leafEvDir, leafMovedDir);
          symlinkSync(leafOtherDir, leafEvDir);
        },
      },
    );
    assert.equal(leafSwapRan, true);
    assert.equal(leafOut, null);
    assert.equal(readFileSync(leafVictim, "utf8"), leafVictimBody);
    assert.equal(lstatSync(leafVictim).ino, leafVictimIno);
    assert.deepEqual(readdirSync(leafOtherDir), ["goal-description-v1.md"]);

    // 2. Ancestor swapped for a symlink to another parent holding a real leaf directory after verification.
    const ancParent = join(root, "anc-parent");
    const ancParentMoved = join(root, "anc-parent-moved");
    const ancEvDir = join(ancParent, "goal-2");
    const ancOtherParent = join(root, "anc-other-parent");
    const ancOtherLeaf = join(ancOtherParent, "goal-2");
    mkdirSync(ancEvDir, { recursive: true });
    mkdirSync(ancOtherLeaf, { recursive: true });
    const ancVictim = join(ancOtherLeaf, "goal-description-v2.md");
    const ancVictimBody = "untouched-other-dir-ancestor-swap\n";
    writeFileSync(ancVictim, ancVictimBody, "utf8");
    const ancVictimIno = lstatSync(ancVictim).ino;

    let ancSwapRan = false;
    const ancOut = writeGoalDescriptionFile(
      { version: 2, description: longDesc, repoRoot },
      ancEvDir,
      repoRoot,
      "data-dir",
      {
        afterVerifyDir: () => {
          ancSwapRan = true;
          renameSync(ancParent, ancParentMoved);
          symlinkSync(ancOtherParent, ancParent);
        },
      },
    );
    assert.equal(ancSwapRan, true);
    assert.equal(ancOut, null);
    assert.equal(readFileSync(ancVictim, "utf8"), ancVictimBody);
    assert.equal(lstatSync(ancVictim).ino, ancVictimIno);
    assert.deepEqual(readdirSync(ancOtherLeaf), ["goal-description-v2.md"]);

    // 3. Swaps right before temp creation and right before rename, both with /proc/self/fd pinning and the non-procfs fallback.
    for (const disableProcSelfFd of [false, true]) {
      for (const phase of ["beforeTempCreate", "beforeRename"] as const) {
        const tag = `${disableProcSelfFd ? "fallback" : "procfd"}-${phase}`;
        const evDir = join(root, `ev-${tag}`, "goal");
        const movedDir = join(root, `ev-${tag}`, "goal-moved");
        const otherDir = join(root, `other-${tag}`);
        mkdirSync(evDir, { recursive: true });
        mkdirSync(otherDir, { recursive: true });
        const victim = join(otherDir, "goal-description-v3.md");
        const victimBody = `untouched-${tag}\n`;
        writeFileSync(victim, victimBody, "utf8");
        const victimIno = lstatSync(victim).ino;

        let swapped = false;
        const swap = () => {
          swapped = true;
          renameSync(evDir, movedDir);
          symlinkSync(otherDir, evDir);
        };
        const out = writeGoalDescriptionFile(
          { version: 3, description: longDesc, repoRoot },
          evDir,
          repoRoot,
          "data-dir",
          {
            disableProcSelfFd,
            ...(phase === "beforeTempCreate" ? { beforeTempCreate: swap } : { beforeRename: swap }),
          },
        );
        assert.equal(swapped, true, `${tag}: swap hook should run`);
        assert.equal(out, null, `${tag}: redirected directory should return null`);
        assert.equal(readFileSync(victim, "utf8"), victimBody, `${tag}: victim bytes must be unchanged`);
        assert.equal(lstatSync(victim).ino, victimIno, `${tag}: victim inode must be unchanged`);
        assert.deepEqual(readdirSync(otherDir), ["goal-description-v3.md"], `${tag}: no temp files in other dir`);
      }
    }

    // 4. On refusal, goal_get preserves its result shape with description.path = null and inline description text.
    const goal: GoalRecord = {
      id: "goal-refused",
      chatSessionId: "chat-1",
      repoRoot,
      version: 1,
      title: "Refused evidence dir",
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
    const goalGetRes = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["goal", "description"] }), {
      evidenceDir: leafEvDir, // now a symlink
      repoRoot,
    }) as {
      goal: { description: { chars: number; excerpt: string; path: string | null; more?: string } };
      descriptionPage: { text: string; chars: number };
    };
    assert.equal(goalGetRes.goal.description.path, null);
    assert.equal(goalGetRes.goal.description.chars, longDesc.length);
    assert.ok(goalGetRes.goal.description.excerpt.length > 0);
    assert.equal(goalGetRes.goal.description.more, "goal_get sections:['description']");
    assert.equal(goalGetRes.descriptionPage.text, longDesc);
  });

  it("returns null without blocking when the description path is a FIFO", () => {
    const root = makeTempDir("pi-goal-desc-d1-fifo-");
    const repoRoot = join(root, "repo");
    const evidenceDir = join(root, "external-evidence", "goal-fifo");
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(evidenceDir, { recursive: true });

    const longDesc = "FIFO non-blocking description payload. ".repeat(60);
    assert.ok(longDesc.length > GOAL_GET_LIMITS.descriptionExcerpt);

    // 1. Existing FIFO at destination returns null without blocking.
    const fifoV1 = join(evidenceDir, "goal-description-v1.md");
    execFileSync("mkfifo", [fifoV1]);
    const startExisting = Date.now();
    const outV1 = writeGoalDescriptionFile(
      { version: 1, description: longDesc, repoRoot },
      evidenceDir,
      repoRoot,
      "data-dir",
    );
    assert.equal(outV1, null);
    assert.ok(Date.now() - startExisting < 2_000, "existing FIFO must not block");
    assert.ok(lstatSync(fifoV1).isFIFO());
    assert.deepEqual(readdirSync(evidenceDir), ["goal-description-v1.md"]);

    // 2. Matching-length regular file swapped to a FIFO right before the comparison open returns null without blocking.
    const descPathV2 = join(evidenceDir, "goal-description-v2.md");
    writeFileSync(descPathV2, "Y".repeat(Buffer.byteLength(longDesc, "utf8")), "utf8");
    let swappedToFifo = false;
    const startSwapped = Date.now();
    const outV2 = writeGoalDescriptionFile(
      { version: 2, description: longDesc, repoRoot },
      evidenceDir,
      repoRoot,
      "data-dir",
      {
        beforeCompareOpen: () => {
          swappedToFifo = true;
          unlinkSync(descPathV2);
          execFileSync("mkfifo", [descPathV2]);
        },
      },
    );
    assert.equal(swappedToFifo, true);
    assert.equal(outV2, null);
    assert.ok(Date.now() - startSwapped < 2_000, "comparison open on swapped FIFO must not block");
    assert.ok(lstatSync(descPathV2).isFIFO());

    // 3. buildGoalGetResult returns inline description without blocking when the description file is a FIFO.
    const goal: GoalRecord = {
      id: "goal-fifo",
      chatSessionId: "chat-1",
      repoRoot,
      version: 1,
      title: "FIFO goal",
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
    const startGoalGet = Date.now();
    const res = buildGoalGetResult(detail, parseGoalGetOptions({ sections: ["goal", "description"] }), {
      evidenceDir,
      repoRoot,
    }) as {
      goal: { description: { path: string | null; chars: number; more?: string } };
      descriptionPage: { text: string };
    };
    assert.ok(Date.now() - startGoalGet < 2_000, "goal_get must not block on FIFO description path");
    assert.equal(res.goal.description.path, null);
    assert.equal(res.goal.description.chars, longDesc.length);
    assert.equal(res.goal.description.more, "goal_get sections:['description']");
    assert.equal(res.descriptionPage.text, longDesc);
  });
});
