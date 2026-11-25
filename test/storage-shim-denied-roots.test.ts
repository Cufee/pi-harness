import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AcpProfileConfig } from "../src/config.js";
import {
  buildNewSessionParams,
  checkReadOnlyArgv,
  DENIED_HARNESS_STATE_REASON,
  isAntigravityAcpProfile,
  isOpenCodeAcpProfile,
  isSafeReadOnlyShellCommand,
  mostSpecificRootDecision,
  OUTSIDE_READ_ROOTS_REASON,
  prepareAcpSpawn,
  type ReadOnlyShellScope,
} from "../src/runners/acp-shims.js";

const tempRoots: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("mostSpecificRootDecision (Addendum A3)", () => {
  it("resolves by most specific containing root, lets allowed win ties, and avoids prefix collisions", () => {
    const home = "/tmp/fake-home";
    const ws = `${home}/repo`;
    const stateDir = `${home}/.pi-harness`;
    const goalsDir = `${stateDir}/data/projects/k/chats/c/goals`;
    const siblingWt = `${stateDir}/data/projects/k/chats/c/worktrees/run/t-2`;

    assert.deepEqual(mostSpecificRootDecision(`${ws}/src/a.ts`, [ws, home], [stateDir]), {
      allowed: true,
      root: ws,
    });
    assert.deepEqual(mostSpecificRootDecision(`${stateDir}/control-plane.sqlite`, [ws, home], [stateDir]), {
      allowed: false,
      reason: "denied",
      root: stateDir,
    });
    assert.deepEqual(mostSpecificRootDecision(stateDir, [ws, home], [stateDir]), {
      allowed: false,
      reason: "denied",
      root: stateDir,
    });
    assert.deepEqual(mostSpecificRootDecision(`${goalsDir}/goal-1/note.md`, [ws, home, goalsDir], [stateDir]), {
      allowed: true,
      root: goalsDir,
    });
    assert.deepEqual(mostSpecificRootDecision(`${siblingWt}/a.ts`, [ws, home, goalsDir], [stateDir]), {
      allowed: false,
      reason: "denied",
      root: stateDir,
    });
    // Allowed wins a tie on the exact same directory.
    assert.deepEqual(mostSpecificRootDecision(`${stateDir}/config.json`, [stateDir], [stateDir]), {
      allowed: true,
      root: stateDir,
    });
    // Non-segment prefix similarity (`/.pi-harness-other`) does not match denied root `/.pi-harness`.
    assert.deepEqual(mostSpecificRootDecision(`${home}/.pi-harness-other/file.txt`, [home], [stateDir]), {
      allowed: true,
      root: home,
    });
    // Outside all roots.
    assert.deepEqual(mostSpecificRootDecision("/etc/hosts", [ws, home], [stateDir]), {
      allowed: false,
      reason: "outside",
    });
    // Empty deniedRoots never returns denied.
    assert.deepEqual(mostSpecificRootDecision(`${stateDir}/config.json`, [home], []), {
      allowed: true,
      root: home,
    });
    assert.deepEqual(mostSpecificRootDecision(`${stateDir}/config.json`, [home]), {
      allowed: true,
      root: home,
    });
  });

  it("handles trailing slashes, empty entries, and external denied data roots", () => {
    const stateDir = "/tmp/state/";
    const dataDir = "/var/harness-data/";
    const goalsDir = "/var/harness-data/projects/k/chats/c/goals";

    assert.deepEqual(
      mostSpecificRootDecision(`${goalsDir}/g1/out.txt`, ["", goalsDir, "/var"], ["", stateDir, dataDir]),
      { allowed: true, root: goalsDir },
    );
    assert.deepEqual(
      mostSpecificRootDecision("/var/harness-data/projects/k/chats/c/worktrees/r/t-2/a.ts", ["/var", goalsDir], [stateDir, dataDir]),
      { allowed: false, reason: "denied", root: dataDir },
    );
  });
});

describe("read-only shell and inspect_command denied-roots enforcement", () => {
  function setupFixture() {
    const home = makeTempDir("pi-harness-denied-roots-");
    const ws = join(home, "repo");
    const stateDir = join(home, ".pi-harness");
    const goalsDir = join(stateDir, "data", "projects", "k", "chats", "c", "goals");
    const goalFile = join(goalsDir, "goal-1", "evidence.md");
    const wt1 = join(stateDir, "data", "projects", "k", "chats", "c", "worktrees", "run-1", "t-1");
    const wt2 = join(stateDir, "data", "projects", "k", "chats", "c", "worktrees", "run-1", "t-2");

    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, ".git"), { recursive: true });
    mkdirSync(join(goalsDir, "goal-1"), { recursive: true });
    mkdirSync(join(wt1, "src"), { recursive: true });
    mkdirSync(join(wt1, ".git"), { recursive: true });
    mkdirSync(join(wt2, "src"), { recursive: true });

    const wsFile = join(ws, "src", "app.ts");
    const dbFile = join(stateDir, "control-plane.sqlite");
    const cfgFile = join(stateDir, "config.json");
    const wt1File = join(wt1, "src", "ok.ts");
    const wt2File = join(wt2, "src", "secret.ts");

    writeFileSync(wsFile, "export const ok = true;\n");
    writeFileSync(join(ws, ".git", "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(dbFile, "sqlite");
    writeFileSync(cfgFile, "{}");
    writeFileSync(goalFile, "# evidence\n");
    writeFileSync(wt1File, "export const worker1 = true;\n");
    writeFileSync(join(wt1, ".git", "HEAD"), "ref: refs/heads/t-1\n");
    writeFileSync(wt2File, "export const worker2 = true;\n");

    return { home, ws, wsFile, stateDir, dbFile, cfgFile, goalsDir, goalFile, wt1, wt1File, wt2, wt2File };
  }

  it("allows workspace and granted state-dir subpaths while refusing state-dir root, DB, config, and sibling worktrees", () => {
    const fx = setupFixture();
    const scope: ReadOnlyShellScope = {
      cwd: fx.ws,
      readRoots: [fx.ws, fx.home, fx.goalsDir],
      deniedRoots: [fx.stateDir],
      protectedRoots: [fx.ws, fx.home, fx.goalsDir],
    };

    // Workspace files are allowed across cat/ls/grep/rg forms.
    for (const argv of [
      ["cat", "src/app.ts"],
      ["cat", fx.wsFile],
      ["ls", "src"],
      ["rg", "ok", fx.wsFile],
    ]) {
      assert.deepEqual(checkReadOnlyArgv(argv, scope), { ok: true }, `expected allow: ${argv.join(" ")}`);
    }
    for (const cmd of [
      "cat src/app.ts",
      `ls "${fx.ws}"`,
      `grep ok "${fx.wsFile}"`,
      `rg ok "${fx.wsFile}"`,
    ]) {
      assert.equal(isSafeReadOnlyShellCommand(cmd, scope), true, `expected allow: ${cmd}`);
    }

    // State dir root, DB, config, missing state-dir files, and sibling worktree are refused with harness-state reason.
    const deniedTargets = [
      fx.stateDir,
      fx.dbFile,
      fx.cfgFile,
      join(fx.stateDir, "does-not-exist.sqlite"),
      fx.wt2,
      fx.wt2File,
    ];
    for (const target of deniedTargets) {
      for (const argv of [
        ["cat", target],
        ["ls", target],
        ["rg", "secret", target],
      ]) {
        const res = checkReadOnlyArgv(argv, scope);
        assert.equal(res.ok, false, `expected refusal for ${argv.join(" ")}`);
        assert.equal(res.reason, DENIED_HARNESS_STATE_REASON);
        assert.match(res.reason, /harness state/i);
      }
      for (const cmd of [
        `cat "${target}"`,
        `ls "${target}"`,
        `grep secret "${target}"`,
        `rg secret "${target}"`,
      ]) {
        assert.equal(isSafeReadOnlyShellCommand(cmd, scope), false, `expected refusal: ${cmd}`);
      }
    }

    // Granted sub-directory under stateDir is readable (proves read-only task can read granted state-dir subpath).
    for (const argv of [
      ["cat", fx.goalFile],
      ["ls", fx.goalsDir],
      ["rg", "evidence", fx.goalsDir],
    ]) {
      assert.deepEqual(checkReadOnlyArgv(argv, scope), { ok: true }, `expected allow: ${argv.join(" ")}`);
    }
    for (const cmd of [
      `cat "${fx.goalFile}"`,
      `ls "${fx.goalsDir}"`,
      `grep evidence "${fx.goalFile}"`,
    ]) {
      assert.equal(isSafeReadOnlyShellCommand(cmd, scope), true, `expected allow: ${cmd}`);
    }
  });

  it("allows a workspace that itself lies under the denied data root while refusing siblings and state-dir internals", () => {
    const fx = setupFixture();
    const scope: ReadOnlyShellScope = {
      cwd: fx.wt1,
      readRoots: [fx.wt1, fx.home, fx.goalsDir],
      deniedRoots: [fx.stateDir],
      protectedRoots: [fx.wt1],
    };

    assert.deepEqual(checkReadOnlyArgv(["cat", "src/ok.ts"], scope), { ok: true });
    assert.deepEqual(checkReadOnlyArgv(["ls"], scope), { ok: true });
    assert.deepEqual(checkReadOnlyArgv(["rg", "worker1", "src"], scope), { ok: true });
    assert.deepEqual(checkReadOnlyArgv(["cat", fx.goalFile], scope), { ok: true });
    assert.equal(isSafeReadOnlyShellCommand("cat src/ok.ts && grep worker1 src/ok.ts", scope), true);

    // Sibling worktree and state-dir DB/config stay refused.
    const sibRes = checkReadOnlyArgv(["cat", fx.wt2File], scope);
    assert.equal(sibRes.ok, false);
    assert.equal(sibRes.reason, DENIED_HARNESS_STATE_REASON);
    assert.equal(isSafeReadOnlyShellCommand(`cat "${fx.wt2File}"`, scope), false);

    const dbRes = checkReadOnlyArgv(["cat", fx.dbFile], scope);
    assert.equal(dbRes.ok, false);
    assert.equal(dbRes.reason, DENIED_HARNESS_STATE_REASON);

    // `.git` inside the workspace remains protected.
    const gitRes = checkReadOnlyArgv(["cat", ".git/HEAD"], scope);
    assert.equal(gitRes.ok, false);
    assert.equal(gitRes.reason, OUTSIDE_READ_ROOTS_REASON);
    assert.equal(isSafeReadOnlyShellCommand("cat .git/HEAD", scope), false);
  });

  it("refuses symlinks inside an allowed root pointing into a denied root, denied cwd, and '..' escapes", () => {
    const fx = setupFixture();
    const leakCfg = join(fx.ws, "leak-config.json");
    const leakDir = join(fx.ws, "leak-state");
    const leakBroken = join(fx.ws, "leak-broken");
    symlinkSync(fx.cfgFile, leakCfg);
    symlinkSync(fx.stateDir, leakDir);
    symlinkSync(join(fx.stateDir, "missing-db.sqlite"), leakBroken);

    const scope: ReadOnlyShellScope = {
      cwd: fx.ws,
      readRoots: [fx.ws, fx.home, fx.goalsDir],
      deniedRoots: [fx.stateDir],
    };

    // Symlinks into denied root are refused with harness-state reason.
    for (const link of [leakCfg, leakDir, leakBroken]) {
      const res = checkReadOnlyArgv(["cat", link], scope);
      assert.equal(res.ok, false, `expected symlink refusal: ${link}`);
      assert.equal(res.reason, DENIED_HARNESS_STATE_REASON);
      assert.equal(isSafeReadOnlyShellCommand(`cat "${link}"`, scope), false);
    }

    // Denied cwd (direct, sibling worktree, or symlinked cwd) is refused even for bare `ls`.
    for (const badCwd of [fx.stateDir, fx.wt2, leakDir]) {
      const badScope: ReadOnlyShellScope = { ...scope, cwd: badCwd };
      const res = checkReadOnlyArgv(["ls"], badScope);
      assert.equal(res.ok, false, `expected cwd refusal: ${badCwd}`);
      assert.equal(res.reason, DENIED_HARNESS_STATE_REASON);
      assert.equal(isSafeReadOnlyShellCommand("ls", badScope), false);
    }
    // Granted subpath cwd is allowed.
    const goalsCwdScope: ReadOnlyShellScope = { ...scope, cwd: fx.goalsDir };
    assert.deepEqual(checkReadOnlyArgv(["ls"], goalsCwdScope), { ok: true });
    assert.deepEqual(checkReadOnlyArgv(["cat", "goal-1/evidence.md"], goalsCwdScope), { ok: true });
    assert.equal(isSafeReadOnlyShellCommand("cat goal-1/evidence.md", goalsCwdScope), true);

    // Relative `..` escapes into denied root are refused with harness-state reason.
    const dotDotToState = checkReadOnlyArgv(["cat", "../.pi-harness/config.json"], scope);
    assert.equal(dotDotToState.ok, false);
    assert.equal(dotDotToState.reason, DENIED_HARNESS_STATE_REASON);
    assert.equal(isSafeReadOnlyShellCommand("cat ../.pi-harness/config.json", scope), false);
    assert.equal(isSafeReadOnlyShellCommand("grep -f../.pi-harness/config.json foo", scope), false);

    // Relative `..` from wt1 to sibling wt2 is refused with harness-state reason.
    const wt1Scope: ReadOnlyShellScope = {
      cwd: fx.wt1,
      readRoots: [fx.wt1, fx.home],
      deniedRoots: [fx.stateDir],
    };
    const dotDotToSibling = checkReadOnlyArgv(["cat", "../t-2/src/secret.ts"], wt1Scope);
    assert.equal(dotDotToSibling.ok, false);
    assert.equal(dotDotToSibling.reason, DENIED_HARNESS_STATE_REASON);
    assert.equal(isSafeReadOnlyShellCommand("cat ../t-2/src/secret.ts", wt1Scope), false);

    // Relative `..` to a non-denied path is still refused with OUTSIDE_READ_ROOTS_REASON.
    const dotDotOutside = checkReadOnlyArgv(["cat", "../repo/src/app.ts"], scope);
    assert.equal(dotDotOutside.ok, false);
    assert.equal(dotDotOutside.reason, OUTSIDE_READ_ROOTS_REASON);
  });

  it("preserves exact existing behavior when deniedRoots is omitted or empty", () => {
    const fx = setupFixture();
    const legacyWorktreeFile = join(fx.ws, ".harness", "worktrees", "run-1", "t-2", "a.ts");
    mkdirSync(join(fx.ws, ".harness", "worktrees", "run-1", "t-2"), { recursive: true });
    writeFileSync(legacyWorktreeFile, "x\n");

    for (const deniedRoots of [undefined, [] as string[]]) {
      const scope: ReadOnlyShellScope = {
        cwd: fx.ws,
        readRoots: [fx.ws, fx.home],
        ...(deniedRoots ? { deniedRoots } : {}),
        protectedRoots: [fx.ws],
      };

      // Without deniedRoots, home covers stateDir just as before.
      assert.deepEqual(checkReadOnlyArgv(["cat", fx.cfgFile], scope), { ok: true });
      assert.equal(isSafeReadOnlyShellCommand(`cat "${fx.cfgFile}"`, scope), true);

      // Outside readRoots still returns OUTSIDE_READ_ROOTS_REASON.
      const outside = checkReadOnlyArgv(["cat", "/etc/hosts"], scope);
      assert.equal(outside.ok, false);
      assert.equal(outside.reason, OUTSIDE_READ_ROOTS_REASON);
      assert.equal(isSafeReadOnlyShellCommand("cat /etc/hosts", scope), false);

      // Protected `.git` and legacy worktree paths still fail with OUTSIDE_READ_ROOTS_REASON.
      const gitRes = checkReadOnlyArgv(["cat", ".git/HEAD"], scope);
      assert.equal(gitRes.ok, false);
      assert.equal(gitRes.reason, OUTSIDE_READ_ROOTS_REASON);

      const wtRes = checkReadOnlyArgv(["cat", legacyWorktreeFile], scope);
      assert.equal(wtRes.ok, false);
      assert.equal(wtRes.reason, OUTSIDE_READ_ROOTS_REASON);
    }
  });
});

describe("ACP adapter directory wiring (prepareAcpSpawn and buildNewSessionParams)", () => {
  const dirs = ["/tmp/data/goals", "/tmp/data/artifacts"];
  const writeDirs = ["/tmp/data/goals/goal-1"];

  const claudeProfile: AcpProfileConfig = {
    id: "acp:claude",
    kind: "acp",
    adapter: "claude",
    command: "claude-agent-acp",
    billing: "subscription",
  };
  const codexProfile: AcpProfileConfig = {
    id: "acp:codex",
    kind: "acp",
    adapter: "codex",
    command: "codex-acp",
    billing: "subscription",
  };
  const geminiProfile: AcpProfileConfig = {
    id: "acp:gemini",
    kind: "acp",
    adapter: "gemini",
    command: "gemini",
    args: ["--acp"],
    billing: "subscription",
  };
  const opencodeProfile: AcpProfileConfig = {
    id: "acp:opencode",
    kind: "acp",
    adapter: "generic",
    command: "opencode",
    args: ["acp"],
    billing: "subscription",
  };
  const antigravityProfile: AcpProfileConfig = {
    id: "acp:antigravity",
    kind: "acp",
    adapter: "generic",
    command: "agy",
    args: ["acp"],
    billing: "subscription",
  };
  const ampProfile: AcpProfileConfig = {
    id: "acp:amp",
    kind: "acp",
    adapter: "generic",
    command: "amp-acp",
    billing: "subscription",
  };
  const customGenericProfile: AcpProfileConfig = {
    id: "acp:custom",
    kind: "acp",
    adapter: "generic",
    command: "my-custom-acp",
    billing: "subscription",
  };

  it("detects OpenCode and Antigravity generic profiles cleanly", () => {
    assert.equal(isOpenCodeAcpProfile(opencodeProfile), true);
    assert.equal(isOpenCodeAcpProfile(ampProfile), false);
    assert.equal(isOpenCodeAcpProfile(claudeProfile), false);

    assert.equal(isAntigravityAcpProfile(antigravityProfile), true);
    assert.equal(isAntigravityAcpProfile(opencodeProfile), false);
    assert.equal(isAntigravityAcpProfile(geminiProfile), false);
  });

  it("wires Claude via both standard ACP additionalDirectories and _meta.claudeCode.options.additionalDirectories", () => {
    const withDirs = buildNewSessionParams("claude", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "claude-opus-5-5",
      mcpServers: [],
      additionalDirectories: [...dirs, dirs[0]!],
    });
    assert.deepEqual(withDirs.params.additionalDirectories, dirs);
    const meta = (withDirs.params._meta as { claudeCode: { options: { additionalDirectories?: string[] } } }).claudeCode.options;
    assert.deepEqual(meta.additionalDirectories, dirs);

    const withoutDirs = buildNewSessionParams("claude", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "claude-opus-5-5",
      mcpServers: [],
    });
    assert.equal(withoutDirs.params.additionalDirectories, undefined);
    const metaNoDirs = (withoutDirs.params._meta as { claudeCode: { options: { additionalDirectories?: string[] } } }).claudeCode.options;
    assert.equal(metaNoDirs.additionalDirectories, undefined);

    const ctrlOnly = buildNewSessionParams("claude", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "control_plane_only",
      model: "claude-opus-5-5",
      mcpServers: [],
      additionalDirectories: dirs,
    });
    assert.equal(ctrlOnly.params.additionalDirectories, undefined);
    const metaCtrl = (ctrlOnly.params._meta as { claudeCode: { options: { additionalDirectories?: string[] } } }).claudeCode.options;
    assert.equal(metaCtrl.additionalDirectories, undefined);
  });

  it("wires Codex via CODEX_CONFIG sandbox_workspace_write.writable_roots (writable only) and ACP additionalDirectories", () => {
    // prepareAcpSpawn without dirs leaves sandbox_workspace_write unset.
    const noDirsSpawn = prepareAcpSpawn(codexProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
    });
    assert.equal(JSON.parse(noDirsSpawn.env.CODEX_CONFIG ?? "{}").sandbox_workspace_write, undefined);
    noDirsSpawn.cleanup();

    // prepareAcpSpawn with writeDirectories merges with existing CODEX_CONFIG sandbox_workspace_write.
    const existingCfgProfile: AcpProfileConfig = {
      ...codexProfile,
      env: {
        CODEX_CONFIG: JSON.stringify({
          sandbox_workspace_write: { network_access: false, writable_roots: ["/tmp/existing"] },
        }),
      },
    };
    const rwSpawn = prepareAcpSpawn(existingCfgProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      readDirectories: dirs,
      writeDirectories: [...writeDirs, "/tmp/existing"],
    });
    const rwCfg = JSON.parse(rwSpawn.env.CODEX_CONFIG ?? "{}") as {
      sandbox_workspace_write?: { network_access?: boolean; writable_roots?: string[] };
    };
    assert.equal(rwCfg.sandbox_workspace_write?.network_access, false);
    assert.deepEqual(rwCfg.sandbox_workspace_write?.writable_roots, ["/tmp/existing", ...writeDirs]);
    rwSpawn.cleanup();

    // read_only_workspace and control_plane_only do not add writable_roots.
    for (const toolPolicy of ["read_only_workspace", "control_plane_only"] as const) {
      const roSpawn = prepareAcpSpawn(codexProfile, {
        systemPrompt: "Role",
        toolPolicy,
        readDirectories: dirs,
        writeDirectories: writeDirs,
      });
      assert.equal(JSON.parse(roSpawn.env.CODEX_CONFIG ?? "{}").sandbox_workspace_write, undefined);
      roSpawn.cleanup();
    }

    // buildNewSessionParams passes standard ACP additionalDirectories for codex (unless control_plane_only or empty).
    const codexWithDirs = buildNewSessionParams("codex", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "gpt-6.2-sol",
      mcpServers: [],
      additionalDirectories: dirs,
    });
    assert.deepEqual(codexWithDirs.params.additionalDirectories, dirs);

    const codexRoWithDirs = buildNewSessionParams("codex", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_only_workspace",
      model: "gpt-6.2-sol",
      mcpServers: [],
      additionalDirectories: dirs,
    });
    assert.deepEqual(codexRoWithDirs.params.additionalDirectories, dirs);

    const codexNoDirs = buildNewSessionParams("codex", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "gpt-6.2-sol",
      mcpServers: [],
    });
    assert.equal(codexNoDirs.params.additionalDirectories, undefined);

    const codexCtrl = buildNewSessionParams("codex", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "control_plane_only",
      model: "gpt-6.2-sol",
      mcpServers: [],
      additionalDirectories: dirs,
    });
    assert.equal(codexCtrl.params.additionalDirectories, undefined);
  });

  it("wires Gemini via repeated --include-directories in prepareAcpSpawn and capability-gated session/new", () => {
    const noDirs = prepareAcpSpawn(geminiProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
    });
    assert.equal(noDirs.args.includes("--include-directories"), false);
    noDirs.cleanup();

    const rw = prepareAcpSpawn(geminiProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      readDirectories: dirs,
      writeDirectories: writeDirs,
    });
    assert.deepEqual(rw.args, [
      "--acp",
      "--approval-mode=yolo",
      "--include-directories",
      dirs[0],
      "--include-directories",
      dirs[1],
      "--include-directories",
      writeDirs[0],
    ]);
    rw.cleanup();

    // read_only_workspace includes readDirectories only (not writeDirectories).
    const ro = prepareAcpSpawn(geminiProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_only_workspace",
      readDirectories: dirs,
      writeDirectories: writeDirs,
    });
    assert.deepEqual(ro.args, ["--acp", "--include-directories", dirs[0], "--include-directories", dirs[1]]);
    ro.cleanup();

    // control_plane_only adds no --include-directories.
    const ctrl = prepareAcpSpawn(geminiProfile, {
      systemPrompt: "Role",
      toolPolicy: "control_plane_only",
      readDirectories: dirs,
      writeDirectories: writeDirs,
    });
    assert.deepEqual(ctrl.args, ["--acp"]);
    ctrl.cleanup();

    // buildNewSessionParams omits additionalDirectories unless gemini advertises the capability.
    const geminiDefault = buildNewSessionParams("gemini", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "gemini-4-neon",
      mcpServers: [],
      additionalDirectories: dirs,
    });
    assert.equal(geminiDefault.params.additionalDirectories, undefined);

    const geminiCapable = buildNewSessionParams("gemini", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "gemini-4-neon",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } },
      additionalDirectories: dirs,
    });
    assert.deepEqual(geminiCapable.params.additionalDirectories, dirs);
  });

  it("wires OpenCode via OPENCODE_CONFIG_CONTENT permission.external_directory", () => {
    const noDirs = prepareAcpSpawn(opencodeProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
    });
    assert.equal(noDirs.env.OPENCODE_CONFIG_CONTENT, process.env.OPENCODE_CONFIG_CONTENT);
    noDirs.cleanup();

    const withExistingProfile: AcpProfileConfig = {
      ...opencodeProfile,
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: "custom",
          permission: { bash: "allow", external_directory: "ask" },
        }),
      },
    };
    const rw = prepareAcpSpawn(withExistingProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      readDirectories: [`${dirs[0]}/`],
      writeDirectories: writeDirs,
    });
    const parsed = JSON.parse(rw.env.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      model?: string;
      permission?: { bash?: string; external_directory?: Record<string, string> };
    };
    assert.equal(parsed.model, "custom");
    assert.equal(parsed.permission?.bash, "allow");
    assert.deepEqual(parsed.permission?.external_directory, {
      "*": "ask",
      [dirs[0]!]: "allow",
      [`${dirs[0]}/**`]: "allow",
      [writeDirs[0]!]: "allow",
      [`${writeDirs[0]}/**`]: "allow",
    });
    rw.cleanup();

    const ctrl = prepareAcpSpawn(opencodeProfile, {
      systemPrompt: "Role",
      toolPolicy: "control_plane_only",
      readDirectories: dirs,
      writeDirectories: writeDirs,
    });
    assert.equal(ctrl.env.OPENCODE_CONFIG_CONTENT, process.env.OPENCODE_CONFIG_CONTENT);
    ctrl.cleanup();
  });

  it("wires Antigravity via --add-dir and capability-gated session/new, and passes nothing extra for amp-acp or unadvertised generic adapters", () => {
    const agyNoDirs = prepareAcpSpawn(antigravityProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
    });
    assert.deepEqual(agyNoDirs.args, ["acp"]);
    agyNoDirs.cleanup();

    const agyRw = prepareAcpSpawn(antigravityProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      readDirectories: dirs,
      writeDirectories: writeDirs,
    });
    assert.deepEqual(agyRw.args, [
      "acp",
      "--add-dir",
      dirs[0],
      "--add-dir",
      dirs[1],
      "--add-dir",
      writeDirs[0],
    ]);
    agyRw.cleanup();

    const agyCtrl = prepareAcpSpawn(antigravityProfile, {
      systemPrompt: "Role",
      toolPolicy: "control_plane_only",
      readDirectories: dirs,
    });
    assert.deepEqual(agyCtrl.args, ["acp"]);
    agyCtrl.cleanup();

    // amp-acp supports no directory option: neither args nor AMP_SETTINGS_FILE gain directory entries.
    const ampWithDirs = prepareAcpSpawn(ampProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      readDirectories: dirs,
      writeDirectories: writeDirs,
    });
    assert.deepEqual(ampWithDirs.args, []);
    const ampCfg = JSON.parse(readFileSync(ampWithDirs.env.AMP_SETTINGS_FILE!, "utf8")) as Record<string, unknown>;
    assert.deepEqual(ampCfg, { "amp.dangerouslyAllowAll": true });
    ampWithDirs.cleanup();

    // Custom generic adapter gets no unknown CLI flags or env vars.
    const customSpawn = prepareAcpSpawn(customGenericProfile, {
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      readDirectories: dirs,
      writeDirectories: writeDirs,
    });
    assert.deepEqual(customSpawn.args, []);
    customSpawn.cleanup();

    // Generic buildNewSessionParams passes additionalDirectories ONLY when advertised and non-control_plane_only.
    const genericWithoutCap = buildNewSessionParams("generic", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "any",
      mcpServers: [],
      additionalDirectories: dirs,
    });
    assert.equal(genericWithoutCap.params.additionalDirectories, undefined);

    const genericWithCap = buildNewSessionParams("generic", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "read_write_workspace",
      model: "any",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } },
      additionalDirectories: dirs,
    });
    assert.deepEqual(genericWithCap.params.additionalDirectories, dirs);

    const genericWithCapCtrl = buildNewSessionParams("generic", {
      cwd: "/tmp/ws",
      systemPrompt: "Role",
      toolPolicy: "control_plane_only",
      model: "any",
      mcpServers: [],
      agentCapabilities: { sessionCapabilities: { additionalDirectories: {} } },
      additionalDirectories: dirs,
    });
    assert.equal(genericWithCapCtrl.params.additionalDirectories, undefined);
  });
});
