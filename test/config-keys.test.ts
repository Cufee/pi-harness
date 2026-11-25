import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "bun:test";
import {
  DEFAULT_RETENTION_CONFIG,
  defaultDataDir,
  diffHarnessConfig,
  findMisplacedConfigKeys,
  getLegacyWorktreeDir,
  loadConfig,
  resolveConfig,
  saveGlobalConfig,
  serializeGlobalConfig,
  validateConfigRaw,
} from "../src/config.js";
import { storagePaths } from "../src/storage/paths.js";

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
    const res = findMisplacedConfigKeys({ quotaEndpoint: { ulr: "x" } }, "global");
    assert.equal(res.length, 1);
    assert.equal(res[0]!.path, "quotaEndpoint.ulr");
    assert.equal(res[0]!.suggestion, "quotaEndpoint.url");
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
      worktree: { gitAuthorName: "custom-bot", maxConcurentWorkers: 9 },
      quotaEndpoint: { ulr: "x" },
    };
    assert.deepEqual(validateConfigRaw(raw), []);
    const cfg = resolveConfig(raw, {}, { stateDir: tmpStateDir });
    assert.equal(cfg.worktree.gitAuthorName, "custom-bot");
    assert.equal(cfg.worktree.maxConcurrentWorkers, 4);
    assert.equal("maxConcurentWorkers" in cfg.worktree, false);
    assert.equal(cfg.quotaEndpoint, undefined);
  });

  it("accepts removed worktree.dir and worktree.artifactsDir silently, keeps worktree.dir verbatim across save/load, and never exposes or adds it", () => {
    const raw = {
      worktree: { dir: " legacy-wt ", artifactsDir: ".harness/old-artifacts" },
    };
    assert.deepEqual(findMisplacedConfigKeys(raw, "global"), []);
    assert.deepEqual(findMisplacedConfigKeys(raw, "repo"), []);
    assert.deepEqual(validateConfigRaw(raw), []);

    const cfg = resolveConfig(raw, {}, { stateDir: tmpStateDir });
    assert.equal("dir" in cfg.worktree, false);
    assert.equal("artifactsDir" in cfg.worktree, false);
    assert.equal(getLegacyWorktreeDir(cfg), " legacy-wt ");
    // Public JSON serialization of config (as returned by config.get) omits removed keys.
    const jsonCfg = JSON.parse(JSON.stringify(cfg)) as { worktree: Record<string, unknown> };
    assert.equal("dir" in jsonCfg.worktree, false);
    assert.equal("artifactsDir" in jsonCfg.worktree, false);

    // serializeGlobalConfig writes an existing global worktree.dir back verbatim and drops artifactsDir.
    const serialized = JSON.parse(serializeGlobalConfig(cfg)) as { worktree: Record<string, unknown> };
    assert.equal(serialized.worktree.dir, " legacy-wt ");
    assert.equal("artifactsDir" in serialized.worktree, false);
    assert.deepEqual(findMisplacedConfigKeys(serialized, "global"), []);
    assert.deepEqual(validateConfigRaw(serialized), []);

    // Clean config never adds worktree.dir on save.
    const cleanCfg = resolveConfig({}, {}, { stateDir: tmpStateDir });
    const cleanSerialized = JSON.parse(serializeGlobalConfig(cleanCfg)) as { worktree: Record<string, unknown> };
    assert.equal("dir" in cleanSerialized.worktree, false);
    assert.equal("artifactsDir" in cleanSerialized.worktree, false);

    // Repo-only worktree.dir is honored internally without adding worktree.dir to global config.json on save.
    const repoOnlyCfg = resolveConfig({}, { worktree: { dir: "repo-only-wt" } }, { stateDir: tmpStateDir });
    assert.equal(getLegacyWorktreeDir(repoOnlyCfg), "repo-only-wt");
    const repoOnlySerialized = JSON.parse(serializeGlobalConfig(repoOnlyCfg)) as { worktree: Record<string, unknown> };
    assert.equal("dir" in repoOnlySerialized.worktree, false);

    // When both global and repo files specify worktree.dir, repo wins for runtime resolution while global save preserves global verbatim.
    const bothCfg = resolveConfig(
      { worktree: { dir: "/global-wt" } },
      { worktree: { dir: "repo-wt" } },
      { stateDir: tmpStateDir },
    );
    assert.equal(getLegacyWorktreeDir(bothCfg), "repo-wt");
    const bothSerialized = JSON.parse(serializeGlobalConfig(bothCfg)) as { worktree: Record<string, unknown> };
    assert.equal(bothSerialized.worktree.dir, "/global-wt");

    // A stray dir/artifactsDir placed on config.worktree (e.g. from a legacy config.update patch) cannot set or alter
    // either serialized output or StoragePaths protection/placement.
    const patchedClean = {
      ...cleanCfg,
      worktree: { ...cleanCfg.worktree, dir: "/injected-wt", artifactsDir: "/injected-art" },
    } as typeof cleanCfg;
    const patchedSerialized = JSON.parse(serializeGlobalConfig(patchedClean)) as { worktree: Record<string, unknown> };
    assert.equal("dir" in patchedSerialized.worktree, false);
    assert.equal("artifactsDir" in patchedSerialized.worktree, false);
    const repo = join(tmpStateDir, "demo-repo");
    const patchedSp = storagePaths(patchedClean, { layout: "data-dir" });
    assert.equal(patchedSp.managedWorktreeRoots(repo).includes("/injected-wt"), false);

    // Simulated orchestrator.updateConfig (Object.keys delete + Object.assign) clears the symbol when reload removes worktree.dir.
    const mutableTarget = { ...cfg };
    for (const key of Object.keys(mutableTarget)) {
      if (!(key in cleanCfg)) delete (mutableTarget as unknown as Record<string, unknown>)[key];
    }
    Object.assign(mutableTarget, cleanCfg);
    assert.equal(getLegacyWorktreeDir(mutableTarget), undefined);

    // Storage uses the internal legacy value for protection/managed roots and legacy-layout base dir,
    // without changing where data-dir layout places worktrees.
    const ddSp = storagePaths(cfg, { layout: "data-dir" });
    assert.ok(ddSp.worktreePath({ repoRoot: repo, id: "run-1", chatSessionId: "chat-1" }, "t-1").startsWith(cfg.storage.dataDir));
    assert.ok(ddSp.managedWorktreeRoots(repo).includes(resolve(repo, " legacy-wt ")));
    assert.equal(ddSp.isProtectedWorktreePath(resolve(repo, " legacy-wt ", "run-1", "t-2", "a.ts"), undefined, repo), true);

    const legacySp = storagePaths(cfg, { layout: "legacy" });
    assert.equal(
      legacySp.worktreePath({ repoRoot: repo, id: "run-1", chatSessionId: "chat-1" }, "t-1"),
      resolve(repo, " legacy-wt ", "run-1", "t-1"),
    );

    // Full disk round-trip: loadConfig -> saveGlobalConfig -> loadConfig preserves internal worktree.dir verbatim.
    const diskRoot = mkdtempSync(join(tmpdir(), "pi-config-legacy-wt-save-"));
    const prevHome = process.env.PI_HARNESS_HOME;
    try {
      const stateDir = join(diskRoot, "state");
      const repoDir = join(diskRoot, "repo");
      mkdirSync(stateDir, { recursive: true });
      mkdirSync(repoDir, { recursive: true });
      const customRoot = join(diskRoot, "custom-checkouts");
      writeFileSync(
        join(stateDir, "config.json"),
        JSON.stringify({ worktree: { dir: customRoot, artifactsDir: ".harness/old", maxConcurrentWorkers: 3 } }, null, 2),
        "utf8",
      );
      process.env.PI_HARNESS_HOME = stateDir;

      const loaded = loadConfig(repoDir);
      assert.equal("dir" in loaded.worktree, false);
      assert.equal("artifactsDir" in loaded.worktree, false);
      assert.equal(getLegacyWorktreeDir(loaded), customRoot);
      assert.equal(loaded.worktree.maxConcurrentWorkers, 3);

      // Edit another setting and save: worktree.dir survives verbatim on disk while artifactsDir is dropped.
      const updated = { ...loaded, worktree: { ...loaded.worktree, maxConcurrentWorkers: 6 } };
      saveGlobalConfig(updated);
      const savedRaw = JSON.parse(readFileSync(join(stateDir, "config.json"), "utf8")) as {
        worktree: Record<string, unknown>;
      };
      assert.equal(savedRaw.worktree.dir, customRoot);
      assert.equal("artifactsDir" in savedRaw.worktree, false);
      assert.equal(savedRaw.worktree.maxConcurrentWorkers, 6);

      // Reload after save (simulating daemon restart or disk reload): internal legacy value is preserved.
      const reloaded = loadConfig(repoDir);
      assert.equal("dir" in reloaded.worktree, false);
      assert.equal(getLegacyWorktreeDir(reloaded), customRoot);
      assert.equal(reloaded.worktree.maxConcurrentWorkers, 6);
      assert.ok(storagePaths(reloaded, { layout: "data-dir" }).managedWorktreeRoots(repoDir).includes(resolve(customRoot)));
    } finally {
      if (prevHome === undefined) delete process.env.PI_HARNESS_HOME;
      else process.env.PI_HARNESS_HOME = prevHome;
      rmSync(diskRoot, { recursive: true, force: true });
    }
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
