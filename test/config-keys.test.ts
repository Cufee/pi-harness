import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import {
  DEFAULT_RETENTION_CONFIG,
  defaultDataDir,
  diffHarnessConfig,
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

describe("storage and retention global-only config keys", () => {
  it("applies defaults and omits them from serializeGlobalConfig", () => {
    const cfg = resolveConfig({}, {}, { stateDir: tmpStateDir });
    assert.equal(cfg.storage.dataDir, resolve(join(tmpStateDir, "data")));
    assert.equal(cfg.storage.dataDir, defaultDataDir(tmpStateDir));
    assert.equal(cfg.retention.installReleases, 3);
    assert.equal(cfg.retention.logMaxBytes, 10_485_760);

    const serialized = JSON.parse(serializeGlobalConfig(cfg)) as Record<string, unknown>;
    assert.equal("storage" in serialized, false);
    assert.equal("retention" in serialized, false);
  });

  it("accepts storage.dataDir, retention.installReleases, and retention.logMaxBytes globally", () => {
    const raw = {
      storage: { dataDir: "~/custom-harness-data" },
      retention: { installReleases: 5, logMaxBytes: 2_097_152 },
    };
    assert.deepEqual(validateConfigRaw(raw), []);
    assert.deepEqual(findMisplacedConfigKeys(raw, "global"), []);

    const cfg = resolveConfig(raw, {}, { stateDir: tmpStateDir });
    assert.equal(cfg.storage.dataDir, resolve(join(homedir(), "custom-harness-data")));
    assert.equal(cfg.retention.installReleases, 5);
    assert.equal(cfg.retention.logMaxBytes, 2_097_152);

    const serialized = JSON.parse(serializeGlobalConfig(cfg)) as Record<string, unknown>;
    assert.deepEqual(serialized.storage, { dataDir: resolve(join(homedir(), "custom-harness-data")) });
    assert.deepEqual(serialized.retention, { installReleases: 5, logMaxBytes: 2_097_152 });
  });

  it("omits individual default retention fields while serializing non-default ones", () => {
    const cfg = resolveConfig({ retention: { installReleases: 7 } }, {}, { stateDir: tmpStateDir });
    const serialized = JSON.parse(serializeGlobalConfig(cfg)) as Record<string, unknown>;
    assert.equal("storage" in serialized, false);
    assert.deepEqual(serialized.retention, { installReleases: 7 });
    assert.equal(cfg.retention.logMaxBytes, DEFAULT_RETENTION_CONFIG.logMaxBytes);
  });

  it("expands bare ~ and resolves relative storage.dataDir to an absolute path", () => {
    const homeCfg = resolveConfig({ storage: { dataDir: "~" } }, {}, { stateDir: tmpStateDir });
    assert.equal(homeCfg.storage.dataDir, resolve(homedir()));

    const relCfg = resolveConfig({ storage: { dataDir: "relative-data-dir" } }, {}, { stateDir: tmpStateDir });
    assert.equal(relCfg.storage.dataDir, resolve("relative-data-dir"));
  });

  it("ignores storage and retention in the repo layer and reports them as global-only", () => {
    const repoOverlay = {
      storage: { dataDir: "/tmp/untrusted-data" },
      retention: { installReleases: 99, logMaxBytes: 123 },
    };
    const warnings = findMisplacedConfigKeys(repoOverlay, "repo");
    assert.deepEqual(warnings, [
      { path: "storage", supported: '"storage" in the global config.json' },
      { path: "retention", supported: '"retention" in the global config.json' },
    ]);

    const misplacedNested = findMisplacedConfigKeys({ dataDir: "/x", installReleases: 1 }, "repo");
    assert.deepEqual(misplacedNested, [
      { path: "dataDir", supported: '"storage.dataDir" in the global config.json' },
      { path: "installReleases", supported: '"retention.installReleases" in the global config.json' },
    ]);

    const cfg = resolveConfig({}, repoOverlay, { stateDir: tmpStateDir });
    assert.equal(cfg.storage.dataDir, defaultDataDir(tmpStateDir));
    assert.equal(cfg.retention.installReleases, 3);
    assert.equal(cfg.retention.logMaxBytes, 10_485_760);
  });

  it("rejects invalid storage and retention values in validateConfigRaw and falls back safely in resolveConfig", () => {
    assert.ok(validateConfigRaw({ storage: "bad" }).some((e) => e.includes("storage must be an object")));
    assert.ok(validateConfigRaw({ storage: { dataDir: "" } }).some((e) => e.includes("storage.dataDir")));
    assert.ok(validateConfigRaw({ storage: { dataDir: "   " } }).some((e) => e.includes("storage.dataDir")));
    assert.ok(validateConfigRaw({ storage: { dataDir: "/tmp/a\0b" } }).some((e) => e.includes("storage.dataDir")));
    assert.ok(validateConfigRaw({ retention: "bad" }).some((e) => e.includes("retention must be an object")));
    assert.ok(validateConfigRaw({ retention: { installReleases: 0 } }).some((e) => e.includes("retention.installReleases")));
    assert.ok(validateConfigRaw({ retention: { installReleases: -2 } }).some((e) => e.includes("retention.installReleases")));
    assert.ok(validateConfigRaw({ retention: { installReleases: 1.5 } }).some((e) => e.includes("retention.installReleases")));
    assert.ok(validateConfigRaw({ retention: { logMaxBytes: 0 } }).some((e) => e.includes("retention.logMaxBytes")));
    assert.ok(validateConfigRaw({ retention: { logMaxBytes: 10.5 } }).some((e) => e.includes("retention.logMaxBytes")));

    const cfg = resolveConfig(
      { storage: { dataDir: "" }, retention: { installReleases: 0, logMaxBytes: -1 } },
      {},
      { stateDir: tmpStateDir },
    );
    assert.equal(cfg.storage.dataDir, defaultDataDir(tmpStateDir));
    assert.equal(cfg.retention.installReleases, 3);
    assert.equal(cfg.retention.logMaxBytes, 10_485_760);
  });

  it("diffs storage and retention changes without echoing storage.dataDir values", () => {
    const prev = resolveConfig({}, {}, { stateDir: tmpStateDir });
    const next = resolveConfig(
      { storage: { dataDir: "/tmp/other-data" }, retention: { installReleases: 5, logMaxBytes: 4096 } },
      {},
      { stateDir: tmpStateDir },
    );
    const diff = diffHarnessConfig(prev, next);
    assert.deepEqual(diff, [
      { path: "storage.dataDir" },
      { path: "retention.installReleases", from: 3, to: 5 },
      { path: "retention.logMaxBytes", from: 10_485_760, to: 4096 },
    ]);
  });
});
