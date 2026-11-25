import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "bun:test";

const REPO_ROOT_DIR = resolve(import.meta.dir, "..");
const SRC_DIR = join(REPO_ROOT_DIR, "src");

/**
 * Files under `src/` (outside `src/storage/`) that still reference legacy storage literals or import
 * deprecated wrappers. Entries may already be converted; the goal-39 cleanup slice empties this
 * list. Do not add entries.
 */
const ALLOWED_UNCONVERTED_FILES: readonly string[] = [];

const HARNESS_SEGMENT_RE = /(^|[^A-Za-z0-9_-])\.harness(?=$|[^A-Za-z0-9_-])/;
const REFS_HARNESS_RE = /refs\/harness\b/;
const HARNESS_BRANCH_RE = /(?<![A-Za-z0-9_-])harness\/(?:\$\{|<|run|chat|legacy)/;
const DEPRECATED_IMPORT_RE =
  /import\s+(?:type\s+)?\{[^}]*\b(goalEvidenceDir|ensureGoalEvidenceDir|dossierDirectory|runMergedRef|isProtectedWritePath)\b[^}]*\}\s+from\s+/gs;

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      out.push(...walkTsFiles(abs));
    } else if (abs.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

function scanStorageLiterals(content: string): string[] {
  const hits: string[] = [];
  if (HARNESS_SEGMENT_RE.test(content)) hits.push("'.harness' path segment");
  if (REFS_HARNESS_RE.test(content)) hits.push("'refs/harness' literal");
  if (HARNESS_BRANCH_RE.test(content)) hits.push("'harness/' branch template");
  const depNames = new Set<string>();
  for (const match of content.matchAll(DEPRECATED_IMPORT_RE)) {
    if (match[1]) depNames.add(match[1]);
  }
  if (depNames.size > 0) {
    hits.push(`deprecated wrapper import (${[...depNames].sort().join(", ")})`);
  }
  return hits;
}

describe("storage literal and deprecated-wrapper scan", () => {
  it("forbids storage literals and deprecated wrapper imports outside src/storage/ and the explicit allowlist", () => {
    const allowlist = new Set(ALLOWED_UNCONVERTED_FILES);
    const matchedFiles = new Map<string, string[]>();

    for (const absPath of walkTsFiles(SRC_DIR).sort()) {
      const rel = relative(REPO_ROOT_DIR, absPath).replaceAll("\\", "/");
      if (rel.startsWith("src/storage/")) continue;
      const hits = scanStorageLiterals(readFileSync(absPath, "utf8"));
      if (hits.length > 0) {
        matchedFiles.set(rel, hits);
      }
    }

    const unexpected: string[] = [];
    for (const [rel, hits] of matchedFiles) {
      if (!allowlist.has(rel)) {
        unexpected.push(`${rel}: ${hits.join("; ")}`);
      }
    }
    assert.deepEqual(
      unexpected,
      [],
      `Found forbidden storage literals or deprecated wrapper imports in unlisted src/ files:\n${unexpected.join("\n")}`,
    );
  });

  it("detects every prohibited pattern and ignores unrelated identifiers", () => {
    assert.deepEqual(scanStorageLiterals('const p = join(root, ".harness", "goals");'), ["'.harness' path segment"]);
    assert.deepEqual(scanStorageLiterals("// stored under .harness/artifacts"), ["'.harness' path segment"]);
    assert.deepEqual(scanStorageLiterals('const ref = "refs/harness/merged/run-1";'), ["'refs/harness' literal"]);
    assert.deepEqual(scanStorageLiterals("const br = `harness/${runId}/${taskId}`;"), ["'harness/' branch template"]);
    assert.deepEqual(
      scanStorageLiterals('import {\n  ensureGoalEvidenceDir,\n} from "../goals/engine.js";'),
      ["deprecated wrapper import (ensureGoalEvidenceDir)"],
    );

    assert.deepEqual(scanStorageLiterals("this.storage.harnessDirtyPathspec();"), []);
    assert.deepEqual(scanStorageLiterals("// ~/.pi-harness/config.json"), []);
    assert.deepEqual(scanStorageLiterals("// harness/code_exec MCP alias"), []);
  });
});
