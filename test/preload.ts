import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { defaultStateDir } from "../src/config.js";

const realHome = resolve(homedir());
const realStateDir = resolve(join(realHome, ".pi-harness"));
const testHome = mkdtempSync(join(tmpdir(), "pi-harness-test-home-"));
const testGitConfig = join(testHome, ".gitconfig");

// Provide a hermetic Git identity so tests that run git commands (e.g. commit-tree in worktree
// archiving) do not depend on or leak the developer's real ~/.gitconfig.
writeFileSync(testGitConfig, "[user]\n\tname = pi-harness-test\n\temail = test@pi-harness.local\n", "utf8");

process.env.HOME = testHome;
process.env.PI_HARNESS_HOME = join(testHome, ".pi-harness");
process.env.XDG_CONFIG_HOME = testHome;
process.env.GIT_CONFIG_GLOBAL = testGitConfig;

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
