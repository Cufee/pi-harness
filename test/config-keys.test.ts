import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";
import {
  findMisplacedConfigKeys,
  resolveConfig,
  serializeGlobalConfig,
  validateConfigRaw,
} from "../src/config.js";

const tmpStateDir = join(tmpdir(), "pi-harness-config-keys-test");

describe("Unknown and misplaced config key detection", () => {
  it("warns with suggestion on a typo inside a section", () => {
    const res = findMisplacedConfigKeys({ worktree: { maxConcurentWorkers: 2 } }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "worktree.maxConcurentWorkers");
    assert.equal(res[0]!.suggestion, "worktree.maxConcurrentWorkers");
    assert.ok(res[0]!.supported.includes('did you mean "worktree.maxConcurrentWorkers"'));
  });

  it("warns with suggestion on a top-level typo", () => {
    const res = findMisplacedConfigKeys({ worktre: {} }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "worktre");
    assert.equal(res[0]!.suggestion, "worktree");
    assert.ok(res[0]!.supported.includes('did you mean "worktree"'));
  });

  it("suggests the right key on a case-only mismatch", () => {
    const res = findMisplacedConfigKeys({ Goals: {} }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "Goals");
    assert.equal(res[0]!.suggestion, "goals");
  });

  it("suggests on adjacent transposition for short keys", () => {
    const res = findMisplacedConfigKeys({ worktree: { dri: "x" } }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "worktree.dri");
    assert.equal(res[0]!.suggestion, "worktree.dir");
  });

  it("omits suggestion when no known key is within threshold", () => {
    const res = findMisplacedConfigKeys({ catalog: { zzzzzzzz: 1 } }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "catalog.zzzzzzzz");
    assert.equal(res[0]!.supported, "none (unknown key)");
    assert.equal(res[0]!.suggestion, undefined);
  });

  it("suggests a nested key path for a typo placed at top level", () => {
    const res = findMisplacedConfigKeys({ maxConcurentWorkers: 1 }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "maxConcurentWorkers");
    assert.equal(res[0]!.suggestion, "worktree.maxConcurrentWorkers");
  });

  it("annotates global-only suggestions in the repo layer", () => {
    const res = findMisplacedConfigKeys({ worktree: { extraReadRoot: [] } }, "repo");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "worktree.extraReadRoot");
    assert.equal(res[0]!.suggestion, "worktree.extraReadRoots");
    assert.ok(res[0]!.supported.includes('"worktree.extraReadRoots" in the global config.json'));
  });

  it("keeps misplaced-key output unchanged without a suggestion field", () => {
    const res = findMisplacedConfigKeys({ extraReadRoots: [] }, "global");
    assert.deepEqual(res, [{ path: "extraReadRoots", supported: '"worktree.extraReadRoots"' }]);
    assert.equal("suggestion" in res[0]!, false);
  });

  it("warns on stateDir pointing to PI_HARNESS_HOME", () => {
    const res = findMisplacedConfigKeys({ stateDir: "/x" }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "stateDir");
    assert.ok(res[0]!.supported.includes("PI_HARNESS_HOME"));
  });

  it("does not check entries inside arrays", () => {
    const res = findMisplacedConfigKeys(
      {
        profiles: [{ id: "p", kind: "pi", provider: "x", billing: "api", bogus: 1 }],
        remotes: [{ name: "r", sshTarget: "ssh://h", typo: 1 }],
      },
      "global",
    );
    assert.deepEqual(res, []);
  });

  it("never rejects unknown section keys and drops them when resolving config", () => {
    const raw = {
      worktree: { dir: "wt", maxConcurentWorkers: 9 },
      quotaEndpoint: { ulr: "x" },
    };
    assert.deepEqual(validateConfigRaw(raw), []);
    const cfg = resolveConfig(raw, {}, { stateDir: tmpStateDir });
    assert.equal(cfg.worktree.dir, "wt");
    assert.equal(cfg.worktree.maxConcurrentWorkers, 4);
    assert.equal("maxConcurentWorkers" in cfg.worktree, false);
    assert.equal(cfg.quotaEndpoint, undefined);
  });

  it("emits no warnings for a daemon-serialized clean config", () => {
    const serialized = JSON.parse(serializeGlobalConfig(resolveConfig({}, {}, { stateDir: tmpStateDir })));
    assert.deepEqual(findMisplacedConfigKeys(serialized, "global"), []);
  });
});
