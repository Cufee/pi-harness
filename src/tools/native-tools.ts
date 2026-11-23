import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExternalMcpServerConfig } from "../config.js";

// Supply chain: pinned upstream GitHub Release archive SHA-256 digests for octofs.
export const OCTOFS_VERSION = "0.26.0";
export const OCTOFS_PINS: Record<string, { triple: string; sha256: string }> = {
  "darwin-arm64": {
    triple: "aarch64-apple-darwin",
    sha256: "6c2703bc519c0574a05da50582a6fd63f285372e9a76ad1c02898ced587d5e3f",
  },
  "darwin-x64": {
    triple: "x86_64-apple-darwin",
    sha256: "f5cb45ca410cdeb41dd674825592b8476529399fd542045a665e461cd70a23c4",
  },
  "linux-arm64": {
    triple: "aarch64-unknown-linux-musl",
    sha256: "b5f368faa66fe4c1b800d4185300d2f1951d5e186982aec043ae7f3e92d1b951",
  },
  "linux-x64": {
    triple: "x86_64-unknown-linux-musl",
    sha256: "18b78be9c4099285832a1efeb2579a6029eb8bc4c7ac0ac7105da9207611eb03",
  },
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function currentOctofsTarget(): { key: string; triple: string; sha256: string } | null {
  const key = `${process.platform}-${process.arch}`;
  const pin = OCTOFS_PINS[key];
  return pin ? { key, ...pin } : null;
}

/**
 * Resolves directories containing bundled native CLI tools (`ast-grep` / `sg` from `@ast-grep/cli`
 * and staged `octofs`) so ACP agents always have them on `PATH` without manual host installation.
 */
export function nativeToolsPathDirs(stateDir: string): string[] {
  const dirs: string[] = [];
  const addIfExists = (dir: string) => {
    if (existsSync(dir) && !dirs.includes(dir)) dirs.push(dir);
  };

  // Prefer the direct native `@ast-grep/cli-<platform>` binary dir (zero Node wrapper overhead), then `node_modules/.bin`.
  const astPlatformSuffixes =
    process.platform === "darwin"
      ? [`darwin-${process.arch}`]
      : process.platform === "linux"
        ? [`linux-${process.arch}-gnu`, `linux-${process.arch}-musl`]
        : [];
  for (const suffix of astPlatformSuffixes) {
    addIfExists(join(packageRoot, "node_modules", "@ast-grep", `cli-${suffix}`));
  }
  addIfExists(join(packageRoot, "node_modules", ".bin"));

  const octofsBin = resolveOctofsBin(stateDir);
  if (octofsBin) {
    addIfExists(dirname(octofsBin));
  }
  return dirs;
}

function normalizeMcpServerName(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/**
 * Returns whether the daemon should stage the bundled `octofs` binary.
 * Stages by default (when omitted, empty, or absent from `externalMcpServers`) or when
 * the first `octofs` entry is enabled and invokes bare `octofs` via `PATH`.
 */
export function shouldStageOctofs(configured?: ExternalMcpServerConfig[]): boolean {
  const first = (configured ?? []).find((s) => normalizeMcpServerName(s?.name) === "octofs");
  if (!first) return true;
  return first.enabled !== false && typeof first.command === "string" && first.command.trim() === "octofs";
}

/** Resolves an installed `octofs` binary from `install.sh` staging, stateDir cache, or `PATH`. */
export function resolveOctofsBin(stateDir: string): string | null {
  const target = currentOctofsTarget();
  if (target) {
    const installDir = process.env.PI_HARNESS_INSTALL_DIR?.trim();
    const candidates = [
      ...(installDir
        ? [join(resolve(installDir), "tools", "octofs", `${OCTOFS_VERSION}-${target.triple}`, "bin", "octofs")]
        : []),
      join(resolve(packageRoot, "..", ".."), "tools", "octofs", `${OCTOFS_VERSION}-${target.triple}`, "bin", "octofs"),
      join(stateDir, "install", "tools", "octofs", `${OCTOFS_VERSION}-${target.triple}`, "bin", "octofs"),
      join(stateDir, "tools", "octofs", `${OCTOFS_VERSION}-${target.triple}`, "bin", "octofs"),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  const found = spawnSync("which", ["octofs"], { encoding: "utf8", timeout: 2000 });
  if (found.status === 0 && found.stdout.trim() && existsSync(found.stdout.trim())) {
    return found.stdout.trim();
  }
  return null;
}

const inflightProvisions = new Map<string, Promise<string | null>>();

/**
 * Lazily provisions the pinned `octofs` static binary into `<stateDir>/tools/octofs/...`
 * verified against its hardcoded SHA-256 digest before unpacking. Safe under concurrent callers.
 */
export async function ensureOctofs(stateDir: string): Promise<string | null> {
  const existing = resolveOctofsBin(stateDir);
  if (existing) return existing;
  const target = currentOctofsTarget();
  if (!target) return null;

  const key = `${stateDir}::${target.triple}`;
  const inflight = inflightProvisions.get(key);
  if (inflight) return inflight;

  const run = (async (): Promise<string | null> => {
    const finalDir = join(stateDir, "tools", "octofs", `${OCTOFS_VERSION}-${target.triple}`);
    const finalBin = join(finalDir, "bin", "octofs");
    if (existsSync(finalBin)) return finalBin;

    const url = `https://github.com/Muvon/octofs/releases/download/${OCTOFS_VERSION}/octofs-${OCTOFS_VERSION}-${target.triple}.tar.gz`;
    const stagingDir = join(stateDir, "tools", ".staging", `octofs-${process.pid}-${randomBytes(4).toString("hex")}`);
    mkdirSync(join(stagingDir, "bin"), { recursive: true, mode: 0o700 });
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== target.sha256) {
        throw new Error(`octofs checksum mismatch for ${target.triple}: expected ${target.sha256}, got ${digest}`);
      }
      const archivePath = join(stagingDir, "octofs.tar.gz");
      writeFileSync(archivePath, bytes, { mode: 0o600 });
      const tar = spawnSync("tar", ["-xzf", archivePath, "-C", join(stagingDir, "bin")], {
        encoding: "utf8",
        timeout: 30_000,
      });
      if (tar.status !== 0) {
        throw new Error(`Failed to extract octofs: ${tar.stderr.trim() || `exit ${tar.status}`}`);
      }
      const stagedBin = join(stagingDir, "bin", "octofs");
      if (!existsSync(stagedBin)) throw new Error("octofs archive did not contain expected 'octofs' binary");
      chmodSync(stagedBin, 0o755);
      rmSync(archivePath, { force: true });
      mkdirSync(dirname(finalDir), { recursive: true, mode: 0o700 });
      try {
        renameSync(stagingDir, finalDir);
      } catch {
        if (!existsSync(finalBin)) throw new Error("Failed to publish staged octofs binary");
      }
      return existsSync(finalBin) ? finalBin : null;
    } catch {
      return null;
    } finally {
      rmSync(stagingDir, { recursive: true, force: true });
      inflightProvisions.delete(key);
    }
  })();

  inflightProvisions.set(key, run);
  return run;
}

/**
 * Merges default native external MCP servers (`octofs mcp` when the binary is available)
 * with any user-configured `externalMcpServers`. Users can override or disable `octofs`
 * explicitly via `{ name: "octofs", enabled: false }`.
 */
export function resolveExternalMcpServers(
  stateDir: string,
  configured?: ExternalMcpServerConfig[],
): ExternalMcpServerConfig[] {
  const list: ExternalMcpServerConfig[] = [];
  const seen = new Set<string>();
  for (const entry of configured ?? []) {
    const normalized = normalizeMcpServerName(entry?.name);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    list.push(entry);
  }
  if (!seen.has("octofs")) {
    const octofsBin = resolveOctofsBin(stateDir);
    if (octofsBin) {
      list.unshift({
        name: "octofs",
        command: octofsBin,
        args: ["mcp"],
        enabled: true,
      });
    }
  }
  return list;
}
