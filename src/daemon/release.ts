import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReleaseTarget {
  releaseId: string;
  releaseDir: string;
  bunPath: string;
  cliPath: string;
}

export interface ReleaseIdentity extends ReleaseTarget {
  kind: "installed" | "checkout";
}

let cachedRelease: ReleaseIdentity | null = null;

export function readReleaseAt(releaseDir: string): ReleaseIdentity | null {
  let dir: string;
  try {
    dir = realpathSync(releaseDir);
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(join(dir, "release.json"), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const id = (parsed as { id?: unknown }).id;
  if (typeof id !== "string" || id.trim().length === 0) return null;
  const bunCandidate = join(dir, ".bun");
  return {
    kind: "installed",
    releaseId: id.trim(),
    releaseDir: dir,
    bunPath: existsSync(bunCandidate) ? bunCandidate : process.execPath,
    cliPath: join(dir, "src", "cli.ts"),
  };
}

export function currentRelease(): ReleaseIdentity {
  if (cachedRelease) return cachedRelease;
  const rawRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  let root: string;
  try {
    root = realpathSync(rawRoot);
  } catch {
    root = rawRoot;
  }
  const installed = readReleaseAt(root);
  if (installed) {
    cachedRelease = installed;
    return cachedRelease;
  }
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 12);
  cachedRelease = {
    kind: "checkout",
    releaseId: `dev-${hash}`,
    releaseDir: root,
    bunPath: process.execPath,
    cliPath: join(root, "src", "cli.ts"),
  };
  return cachedRelease;
}

export function installedCurrent(self: ReleaseIdentity = currentRelease()): ReleaseIdentity | null {
  // Checkouts never consult ~/.pi-harness/install so worktree CLIs and tests stay isolated.
  if (self.kind !== "installed") return null;
  try {
    const currentLink = join(self.releaseDir, "..", "..", "current");
    return readReleaseAt(realpathSync(currentLink));
  } catch {
    return null;
  }
}
