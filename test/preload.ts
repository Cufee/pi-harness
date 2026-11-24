import { mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as origOs from "node:os";
import { join, resolve, sep } from "node:path";

const realHome = resolve(origOs.homedir());
const realStateDir = resolve(join(realHome, ".pi-harness"));
const testHome = mkdtempSync(join(origOs.tmpdir(), "pi-harness-test-home-"));
const testGitConfig = join(testHome, ".gitconfig");

// Provide a hermetic Git identity so tests that run git commands (e.g. commit-tree in worktree
// archiving) do not depend on or leak the developer's real ~/.gitconfig.
writeFileSync(testGitConfig, "[user]\n\tname = pi-harness-test\n\temail = test@pi-harness.local\n", "utf8");

process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.PI_HARNESS_HOME = join(testHome, ".pi-harness");
process.env.XDG_CONFIG_HOME = join(testHome, ".config");
process.env.XDG_DATA_HOME = join(testHome, ".local", "share");
process.env.XDG_CACHE_HOME = join(testHome, ".cache");
process.env.XDG_STATE_HOME = join(testHome, ".local", "state");
process.env.CODEX_HOME = join(testHome, ".codex");
process.env.CLAUDE_CONFIG_DIR = join(testHome, ".claude");
process.env.GIT_CONFIG_GLOBAL = testGitConfig;

// Bun caches node:os.homedir() at process startup, so mutating process.env.HOME alone does not
// redirect os.homedir() consumers (e.g. quota/local-harvest.ts, cost/ledger.ts, tools/gate-env.ts).
// Mock both "node:os" and "os" so both `bun run test` and bare `bun test <file>` isolate homedir().
const origOsExports = Object.fromEntries(Object.entries(origOs).filter(([key]) => key !== "default"));
const origUserInfo = origOs.userInfo;
const isolatedHomedir = (): string => process.env.HOME || testHome;
const isolatedUserInfo = ((options?: { encoding?: BufferEncoding | "buffer" }) => {
  const info = options ? origUserInfo(options as never) : origUserInfo();
  const home = isolatedHomedir();
  return {
    ...info,
    homedir: options?.encoding === "buffer" ? Buffer.from(home) : home,
  };
}) as typeof origUserInfo;
const mockedOs = {
  ...origOsExports,
  homedir: isolatedHomedir,
  userInfo: isolatedUserInfo,
};
const mockedOsModule = { ...mockedOs, default: mockedOs };
mock.module("node:os", () => mockedOsModule);
mock.module("os", () => mockedOsModule);

const [{ homedir: nodeOsHomedir }, { homedir: bareOsHomedir }, { defaultStateDir }] = await Promise.all([
  import("node:os"),
  import("os"),
  import("../src/config.js"),
]);

for (const [label, candidate] of [
  ["node:os homedir()", resolve(nodeOsHomedir())],
  ["os homedir()", resolve(bareOsHomedir())],
] as const) {
  if (candidate === realHome || candidate.startsWith(`${realHome}${sep}`)) {
    rmSync(testHome, { recursive: true, force: true });
    throw new Error(`test isolation failed: ${label} resolved under real startup home (${candidate})`);
  }
}

const resolvedStateDir = resolve(defaultStateDir());
if (resolvedStateDir === realStateDir || resolvedStateDir.startsWith(`${realStateDir}${sep}`)) {
  rmSync(testHome, { recursive: true, force: true });
  throw new Error(`test isolation failed: defaultStateDir() resolved under real state dir (${resolvedStateDir})`);
}

process.on("exit", () => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup of temp test home
  }
});
