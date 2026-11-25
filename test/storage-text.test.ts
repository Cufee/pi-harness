import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, it } from "bun:test";
import { REJECTIONS } from "../src/advisories/rejections.js";
import { HARNESS_TEXT_COUNT_PATTERN } from "../src/advisories/rules.js";
import { buildDirectorSystemPrompt } from "../src/director/session.js";
import { describeMergedRefFallback } from "../src/storage/names.js";
import { createLegacyStoragePaths, resetStoragePathsForTest } from "../src/storage/paths.js";
import { storageText } from "../src/storage/text.js";
import { describeTool, toolsForRole } from "../src/tool-descriptions/registry.js";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ORIGINAL_LAYOUT_ENV = process.env.PI_HARNESS_STORAGE_LAYOUT;

const EXPECTED_HELPERS = [
  "artifactsRoot",
  "directorNoteLocation",
  "directorNoteRootAlternative",
  "dossierInvalidDirectoryReason",
  "dossierSymlinkWhat",
  "goalEvidenceDirTemplate",
  "writeNotePathParam",
  "writeNoteTool",
] as const;

const ACCEPTED_OLD_PATHS_RE =
  /Old workspace-relative `?.harness\/goals\/\.\.\.`? and `?.harness\/notes\/\.\.\.`? paths are still accepted and mapped to the new location\.?/g;

function restoreLayoutEnv(): void {
  if (ORIGINAL_LAYOUT_ENV === undefined) {
    delete process.env.PI_HARNESS_STORAGE_LAYOUT;
  } else {
    process.env.PI_HARNESS_STORAGE_LAYOUT = ORIGINAL_LAYOUT_ENV;
  }
  resetStoragePathsForTest();
}

function assertOnlyOldPathsSentenceMentionsHarness(text: string, label: string): void {
  const matches = text.match(ACCEPTED_OLD_PATHS_RE) ?? [];
  assert.equal(matches.length, 1, `${label}: expected exactly one sentence about accepted old paths, got: ${text}`);
  const stripped = text.replace(ACCEPTED_OLD_PATHS_RE, "");
  assert.ok(!stripped.includes(".harness"), `${label}: unexpected .harness reference outside accepted-old-paths sentence: ${stripped}`);
}

describe("src/storage/text", () => {
  afterEach(() => {
    restoreLayoutEnv();
  });

  it("exposes exactly the Addendum A2 helpers for both layouts", () => {
    assert.deepEqual(Object.keys(storageText("legacy")).sort(), [...EXPECTED_HELPERS]);
    assert.deepEqual(Object.keys(storageText("data-dir")).sort(), [...EXPECTED_HELPERS]);
  });

  it("matches StoragePaths.describe*() byte-for-byte in legacy layout for static and dynamic inputs", () => {
    const legacy = createLegacyStoragePaths();
    const text = storageText("legacy");
    const defaultText = storageText();

    assert.equal(text.artifactsRoot(), legacy.describeArtifactsRoot());
    assert.equal(defaultText.artifactsRoot(), legacy.describeArtifactsRoot());

    assert.equal(text.goalEvidenceDirTemplate(), legacy.describeGoalEvidenceDirTemplate());
    assert.equal(
      text.directorNoteLocation("none configured"),
      legacy.describeDirectorNoteLocation("none configured"),
    );
    assert.equal(
      text.directorNoteLocation("/srv/notes, /tmp/reports"),
      legacy.describeDirectorNoteLocation("/srv/notes, /tmp/reports"),
    );

    // Static variants (omitted roots or omitted extraRoots; noteRoots ignored in legacy).
    assert.equal(text.writeNoteTool(), legacy.describeWriteNoteTool());
    assert.equal(text.writeNoteTool({}), legacy.describeWriteNoteTool());
    assert.equal(text.writeNoteTool({ noteRoots: ["/data/p/chats/chat-1/notes"] }), legacy.describeWriteNoteTool());
    assert.equal(text.writeNotePathParam(), legacy.describeWriteNotePathParam());
    assert.equal(text.writeNotePathParam({}), legacy.describeWriteNotePathParam());
    assert.equal(text.writeNotePathParam({ noteRoots: ["/data/p/chats/chat-1/notes"] }), legacy.describeWriteNotePathParam());

    // Dynamic variants with empty and populated extraRoots; noteRoots ignored in legacy.
    assert.equal(text.writeNoteTool({ extraRoots: [] }), legacy.describeWriteNoteTool([]));
    assert.equal(
      text.writeNoteTool({ noteRoots: ["/ignored"], extraRoots: [] }),
      legacy.describeWriteNoteTool([]),
    );
    assert.equal(text.writeNoteTool({ extraRoots: ["/a", "/b"] }), legacy.describeWriteNoteTool(["/a", "/b"]));
    assert.equal(
      text.writeNoteTool({ noteRoots: ["/ignored"], extraRoots: ["/a", "/b"] }),
      legacy.describeWriteNoteTool(["/a", "/b"]),
    );

    assert.equal(text.writeNotePathParam({ extraRoots: [] }), legacy.describeWriteNotePathParam([]));
    assert.equal(
      text.writeNotePathParam({ noteRoots: ["/ignored"], extraRoots: [] }),
      legacy.describeWriteNotePathParam([]),
    );
    assert.equal(text.writeNotePathParam({ extraRoots: ["/a", "/b"] }), legacy.describeWriteNotePathParam(["/a", "/b"]));
    assert.equal(
      text.writeNotePathParam({ noteRoots: ["/ignored"], extraRoots: ["/a", "/b"] }),
      legacy.describeWriteNotePathParam(["/a", "/b"]),
    );

    assert.equal(text.directorNoteRootAlternative(), legacy.describeDirectorNoteRootAlternative());
    assert.equal(text.dossierInvalidDirectoryReason(), legacy.describeDossierInvalidDirectoryReason());
    assert.equal(
      text.dossierSymlinkWhat("/repo/.harness/artifacts/run-1/t-1/note.md"),
      legacy.describeDossierSymlinkWhat("/repo/.harness/artifacts/run-1/t-1/note.md"),
    );
  });

  it("describes data-dir roots cleanly without .harness as a write target and lists noteRoots/extraRoots verbatim", () => {
    const text = storageText("data-dir");
    const noteRoots = [
      "/home/test/.pi-harness/data/projects/demo-1234567890ab/chats/chat-1/goals",
      "/home/test/.pi-harness/data/projects/demo-1234567890ab/chats/chat-1/notes",
      "/home/test/.pi-harness/data/projects/demo-1234567890ab/notes",
    ];
    const extraRoots = ["/srv/shared-notes", "/tmp/reports"];

    const artifacts = text.artifactsRoot();
    assert.ok(artifacts.includes("harness artifacts directory"));
    assert.ok(artifacts.includes("HARNESS_ARTIFACTS_DIR"));
    assert.ok(!artifacts.includes(".harness"));

    assert.equal(text.goalEvidenceDirTemplate(), "<dataDir>/projects/<project>/chats/<chat>/goals/<goalId>");

    const dossierReason = text.dossierInvalidDirectoryReason();
    assert.ok(dossierReason.includes("regular directories under the harness artifacts directory"));
    assert.ok(!dossierReason.includes(".harness"));

    const symlinkWhat = text.dossierSymlinkWhat("/data/projects/demo/chats/chat-1/artifacts/x");
    assert.ok(symlinkWhat.includes("harness artifacts directory"));
    assert.ok(symlinkWhat.includes("/data/projects/demo/chats/chat-1/artifacts/x"));
    assert.ok(!symlinkWhat.includes(".harness"));

    const dirLoc = text.directorNoteLocation("/srv/shared-notes, /tmp/reports");
    assert.ok(dirLoc.includes("this chat's goals/ and notes/ directories"));
    assert.ok(dirLoc.includes("project notes directory under the harness data directory"));
    assert.ok(dirLoc.includes("/srv/shared-notes, /tmp/reports"));
    assertOnlyOldPathsSentenceMentionsHarness(dirLoc, "directorNoteLocation");

    const noteAlt = text.directorNoteRootAlternative();
    assert.ok(noteAlt.includes("this chat's goals/ or notes/ directory"));
    assert.ok(noteAlt.includes("project notes directory under the harness data directory"));
    assert.ok(noteAlt.includes("worktree.extraWriteRoots"));
    assert.ok(noteAlt.includes("goal_create and goal_commit"));
    assertOnlyOldPathsSentenceMentionsHarness(noteAlt, "directorNoteRootAlternative");

    // Static write_note descriptions.
    const staticTool = text.writeNoteTool();
    assert.ok(staticTool.includes("this chat's `goals/` and `notes/` directories"));
    assert.ok(staticTool.includes("project notes directory under the harness data directory"));
    assert.ok(staticTool.includes("`extraWriteRoots`"));
    assertOnlyOldPathsSentenceMentionsHarness(staticTool, "writeNoteTool()");

    const staticParam = text.writeNotePathParam();
    assert.ok(staticParam.includes("this chat's goals/ and notes/ directories"));
    assert.ok(staticParam.includes("project notes directory under the harness data directory"));
    assert.ok(staticParam.includes("extraWriteRoots"));
    assertOnlyOldPathsSentenceMentionsHarness(staticParam, "writeNotePathParam()");

    // Dynamic write_note descriptions with noteRoots and extraRoots.
    const dynToolBoth = text.writeNoteTool({ noteRoots, extraRoots });
    const dynParamBoth = text.writeNotePathParam({ noteRoots, extraRoots });
    for (const [label, value] of [
      ["writeNoteTool(both)", dynToolBoth],
      ["writeNotePathParam(both)", dynParamBoth],
    ] as const) {
      for (const root of noteRoots) assert.ok(value.includes(root), `${label} missing noteRoot ${root}`);
      for (const root of extraRoots) assert.ok(value.includes(root), `${label} missing extraRoot ${root}`);
      assertOnlyOldPathsSentenceMentionsHarness(value, label);
    }

    // Dynamic write_note descriptions with empty extraRoots.
    const dynToolNoExtra = text.writeNoteTool({ noteRoots, extraRoots: [] });
    const dynParamNoExtra = text.writeNotePathParam({ noteRoots, extraRoots: [] });
    for (const [label, value] of [
      ["writeNoteTool(noExtra)", dynToolNoExtra],
      ["writeNotePathParam(noExtra)", dynParamNoExtra],
    ] as const) {
      for (const root of noteRoots) assert.ok(value.includes(root), `${label} missing noteRoot ${root}`);
      assert.ok(value.includes("no extraWriteRoots configured"), `${label} missing empty-extra notice`);
      assertOnlyOldPathsSentenceMentionsHarness(value, label);
    }

    // Ensure no data-dir helper trips the harness count-pattern guard.
    for (const sample of [
      artifacts,
      text.goalEvidenceDirTemplate(),
      dossierReason,
      symlinkWhat,
      dirLoc,
      noteAlt,
      staticTool,
      staticParam,
      dynToolBoth,
      dynParamBoth,
      dynToolNoExtra,
      dynParamNoExtra,
    ]) {
      assert.ok(!HARNESS_TEXT_COUNT_PATTERN.test(sample), `unexpected count-pattern match in: ${sample}`);
    }
  });

  it("wires registry write_note, goal_trigger_review, and Director system prompt for both layouts", () => {
    // Legacy layout (default).
    const legacyText = storageText("legacy");
    const legacyWriteNote = toolsForRole("director").find((t) => t.name === "write_note");
    assert.ok(legacyWriteNote);
    assert.equal(describeTool("write_note", "director"), legacyText.writeNoteTool());
    assert.equal(legacyWriteNote.description, legacyText.writeNoteTool());
    const legacyPathDesc = (legacyWriteNote.inputSchema as { properties?: { path?: { description?: string } } }).properties
      ?.path?.description;
    assert.equal(legacyPathDesc, legacyText.writeNotePathParam());
    assert.ok(describeTool("goal_trigger_review", "director").includes(describeMergedRefFallback("legacy")));

    const legacyPrompt = buildDirectorSystemPrompt("off", undefined, ["/srv/notes"], "legacy");
    assert.ok(legacyPrompt.includes(legacyText.directorNoteLocation("/srv/notes")));
    assert.ok(legacyPrompt.includes(`\`${legacyText.goalEvidenceDirTemplate()}\``));

    // Data-dir layout via explicit prompt argument.
    const dataDirText = storageText("data-dir");
    const dataDirPromptArg = buildDirectorSystemPrompt("off", undefined, ["/srv/notes"], "data-dir");
    assert.ok(dataDirPromptArg.includes(dataDirText.directorNoteLocation("/srv/notes")));
    assert.ok(dataDirPromptArg.includes(`\`${dataDirText.goalEvidenceDirTemplate()}\``));
    assert.ok(!dataDirPromptArg.includes("<repo>/.harness/goals/<goalId>"));

    // Data-dir layout via process-start env (resetStoragePathsForTest re-reads PI_HARNESS_STORAGE_LAYOUT).
    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();

    const dataDirWriteNote = toolsForRole("director").find((t) => t.name === "write_note");
    assert.ok(dataDirWriteNote);
    assert.equal(describeTool("write_note", "director"), dataDirText.writeNoteTool());
    assert.equal(dataDirWriteNote.description, dataDirText.writeNoteTool());
    const dataDirPathDesc = (dataDirWriteNote.inputSchema as { properties?: { path?: { description?: string } } }).properties
      ?.path?.description;
    assert.equal(dataDirPathDesc, dataDirText.writeNotePathParam());

    const dataDirPromptEnv = buildDirectorSystemPrompt("off", undefined, ["/srv/notes"]);
    assert.equal(dataDirPromptEnv, dataDirPromptArg);
  });

  it("selects data-dir registry and rejection text in a fresh process started with PI_HARNESS_STORAGE_LAYOUT=data-dir", () => {
    const script = [
      'import { describeTool, toolsForRole } from "./src/tool-descriptions/registry.js";',
      'import { REJECTIONS } from "./src/advisories/rejections.js";',
      'import { storageText } from "./src/storage/text.js";',
      'const expected = storageText("data-dir");',
      'const tool = toolsForRole("director").find((t) => t.name === "write_note");',
      'const out = {',
      '  descMatch: describeTool("write_note", "director") === expected.writeNoteTool(),',
      '  paramMatch: tool?.inputSchema?.properties?.path?.description === expected.writeNotePathParam(),',
      '  noteRejMatch: REJECTIONS.directorNoteRoot("/x").notice.alternative === expected.directorNoteRootAlternative(),',
      '  dirRejMatch: REJECTIONS.dossierInvalidDirectory("/x").notice.why === expected.dossierInvalidDirectoryReason(),',
      '  symRejMatch: REJECTIONS.dossierSymlink("/x").notice.what === expected.dossierSymlinkWhat("/x"),',
      "};",
      "console.log(JSON.stringify(out));",
    ].join("\n");
    const res = spawnSync(process.execPath, ["-e", script], {
      cwd: REPO_ROOT,
      env: { ...process.env, PI_HARNESS_STORAGE_LAYOUT: "data-dir" },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `subprocess failed: ${res.stderr}`);
    assert.deepEqual(JSON.parse(res.stdout.trim()), {
      descMatch: true,
      paramMatch: true,
      noteRejMatch: true,
      dirRejMatch: true,
      symRejMatch: true,
    });
  });

  it("produces legacy text from the three storage REJECTIONS by default and switches at call time", () => {
    const legacy = createLegacyStoragePaths();
    assert.equal(
      REJECTIONS.directorNoteRoot("/repo/src/a.ts").notice.alternative,
      legacy.describeDirectorNoteRootAlternative(),
    );
    assert.equal(
      REJECTIONS.dossierInvalidDirectory("/repo/.harness/artifacts/x").notice.why,
      legacy.describeDossierInvalidDirectoryReason(),
    );
    assert.equal(
      REJECTIONS.dossierSymlink("/repo/.harness/artifacts/x").notice.what,
      legacy.describeDossierSymlinkWhat("/repo/.harness/artifacts/x"),
    );

    process.env.PI_HARNESS_STORAGE_LAYOUT = "data-dir";
    resetStoragePathsForTest();
    const dataDir = storageText("data-dir");
    assert.equal(
      REJECTIONS.directorNoteRoot("/repo/src/a.ts").notice.alternative,
      dataDir.directorNoteRootAlternative(),
    );
    assert.equal(
      REJECTIONS.dossierInvalidDirectory("/data/artifacts/x").notice.why,
      dataDir.dossierInvalidDirectoryReason(),
    );
    assert.equal(
      REJECTIONS.dossierSymlink("/data/artifacts/x").notice.what,
      dataDir.dossierSymlinkWhat("/data/artifacts/x"),
    );
  });

  it("leaves no .harness or refs/harness literals in registry.ts, session.ts, or rejections.ts", () => {
    for (const rel of [
      "src/tool-descriptions/registry.ts",
      "src/director/session.ts",
      "src/advisories/rejections.ts",
    ]) {
      const content = readFileSync(resolve(REPO_ROOT, rel), "utf8");
      assert.ok(!/(^|[^A-Za-z0-9_-])\.harness(?=$|[^A-Za-z0-9_-])/.test(content), `${rel} still contains a .harness literal`);
      assert.ok(!/refs\/harness\b/.test(content), `${rel} still contains a refs/harness literal`);
    }
  });
});
