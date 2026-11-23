# Runtime install

`install.sh` turns a source checkout into a self-contained, per-user install. It needs no global Node, Bun, Python or package manager, writes nothing outside two directories, and is safe to re-run. The same command updates an existing install.

```sh
sh install.sh
~/.local/bin/pi-harness --help
```

From a checkout with Bun on `PATH`, `bun run install` runs the same script. A plain `bun install` does not.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_HARNESS_INSTALL_DIR` | `~/.pi-harness/install` | Staged Bun, releases and caches |
| `PI_HARNESS_BIN_DIR` | `~/.local/bin` | Where `pi-harness` and `harness` are written |

State (`~/.pi-harness/config.json`, the SQLite database, daemon socket) is untouched and stays one level above the install directory. Every successful run appends one line (UTC time, user, pid, release id, source path) to `$PI_HARNESS_HOME/install-audit.log` (default `~/.pi-harness/install-audit.log`), including unchanged re-runs. `pi-harness` has no `--version` flag; `--help` is the smoke test.

## Layout

```
$PI_HARNESS_INSTALL_DIR/
  bun/<version>-<target>/bin/bun   staged upstream Bun
  tools/octofs/<version>-<triple>/bin/octofs   staged octofs (file tools for agents over MCP)
  releases/<id>/                   src, proto, package.json, bun.lock, tsconfig.json, node_modules, .bun -> staged Bun
  current -> releases/<id>         active release (symlink swapped atomically)
  cache/downloads/                 verified Bun archives
  cache/bun/                       Bun package cache (BUN_INSTALL_CACHE_DIR, not ~/.bun)
$PI_HARNESS_BIN_DIR/pi-harness     launcher; harness -> pi-harness
```

`<id>` is the first 12 hex digits of a hash of the runtime files, so the same source always maps to the same release and an unchanged re-run does no work. A release is built in a staging directory and moved into place only after `bun install` succeeds; an interrupted install leaves the previous `current` and launcher working. Old releases are kept (running daemons keep executing from theirs); delete unwanted directories under `releases/` by hand.

The launcher is `exec "$release/.bun" "$release/src/cli.ts" "$@"`: the staged Bun by default. `BUN_BIN=/path/to/bun` overrides it for debugging only. Code Mode uses `process.execPath`, so it runs under whichever Bun started the CLI.

## What the installer does

1. Maps `uname` to a Bun target (`darwin-{aarch64,x64}`, `linux-{aarch64,x64}`, `-musl` where `/lib/ld-musl-*` exists, `-baseline` for x64 CPUs without AVX2; a shell under Rosetta is treated as arm64).
2. Downloads `https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$target.zip` and checks it against the SHA-256 pinned in `install.sh`, before unzipping. A cached archive that fails the check is deleted and fetched again.
3. On the four targets with a pin (macOS and Linux, arm64 and x64), downloads `octofs` `0.26.0` from its GitHub release and checks the pinned SHA-256 before unpacking; the daemon offers it to agents as an MCP server (opt-out and the on-demand fallback are in [configuration.md](./configuration.md)).
4. Copies the runtime files into a release directory and runs `bun install --frozen-lockfile --production`. The frozen lockfile fails on any drift from `bun.lock` instead of re-resolving; `bun.lock` carries integrity hashes. Dev dependencies (`tsc`, `protoc-gen-es`) are not installed; `src/gen` is committed.
5. Swaps `current`, then rewrites the launcher.

A `.lock` directory prevents concurrent installs; remove it if a killed install left it behind.

## Prerequisites

Actual inventory, verified by running the installer with `PATH` limited to symlinks of exactly these tools on macOS arm64:

| Needed | For | Updated by |
| --- | --- | --- |
| `sh`, `uname`, `mkdir`, `mv`, `ln`, `rm`, `cp`, `cat`, `chmod`, `touch`, `dirname`, `find`, `sort`, `cut`, `awk`, `grep`, `tar` | installer logic | the OS |
| `curl`, `unzip` | fetching and unpacking Bun | the OS |
| `sha256sum` or `shasum` | checksum verification | the OS |
| `sysctl` (macOS) | Rosetta and AVX2 detection | the OS |
| HTTPS to `github.com` | Bun and octofs release downloads | n/a |
| HTTPS to `registry.npmjs.org` | locked JS dependencies (cold cache) | `bun.lock` |
| `/usr/bin/sandbox-exec` (macOS) | Code Mode sandbox | the OS |
| `git` | harness worktrees and agent runs, not the install | the OS |

Not needed: Node, npm, Bun on `PATH`, Python, Nix, mise, pixi, Homebrew, a compiler. ACP agent CLIs (`claude-agent-acp`, `codex-acp`, …) are managed out of band as before.

Python for Code Mode is provisioned separately (uv, CPython, wheels); see [code-mode-python.md](./code-mode-python.md). This installer neither installs nor requires it.

### Platforms

- **macOS arm64/x86_64**: full support, including Code Mode when the sandbox probe passes at startup.
- **Linux (glibc, musl; x64, arm64)**: the CLI, daemon and TUI install and run. Code Mode stays disabled because `src/code-mode/sandbox.ts` has no verified Linux sandbox; the installer says so.
- Other OSes (Windows, FreeBSD) are rejected.

## Updating

- **Harness source or JS dependencies**: pull, then `sh install.sh`. Changed `src/` or `bun.lock` yields a new release and an atomic switch; restart the daemon (`pi-harness daemon restart`) to use it.
- **Bun**: edit `BUN_VERSION` and `BUN_PINS` in `install.sh`, then re-run. Take the digests from `https://github.com/oven-sh/bun/releases/download/bun-v<version>/SHASUMS256.txt` (the `bun-<target>.zip` lines, not `-profile`), and run the Code Mode tests and the Code Mode sandbox probe under the new Bun before committing. A newer Bun than the one the sandbox was verified with can change probe behaviour (1.4.5 needs the probe to `destroy()` its socket rather than `end()`).
- **JS dependencies**: `bun update` in a checkout, commit `bun.lock`, re-run.
- **OS utilities**: the OS vendor.

The pinned version is Bun 1.4.5 (published 2026-11-19, the latest release when this was written); its SHA-256 pins were compared against `SHASUMS256.txt` for all nine targets in the installer.

## Why not Nix, mise or pixi

Compared on 2026-11-22 against the upstream sources named below.

| | This installer | Nix | mise | pixi |
| --- | --- | --- | --- | --- |
| Extra host tool | none (curl, unzip, shasum are in the base OS) | Nix itself, installed system-wide | the `mise` binary | the `pixi` binary |
| Bun version available | exact upstream tag, 1.4.5 | `nixos-unstable` `pkgs/by-name/bu/bun/package.nix`: 1.4.4; platforms `aarch64-darwin`, `aarch64-linux`, `x86_64-linux`; `broken` on musl | not checked (mise docs list a Bun tool) | conda-forge `bun`: 1.4.2 (anaconda.org API) |
| Intel macOS / musl | covered by pins | not covered (no `x86_64-darwin` source, musl broken) | not checked | conda-forge `bun` builds: `linux-64`, `linux-aarch64`, `osx-64`, `osx-arm64`, `win-64` |
| Lock | pinned SHA-256 + `bun.lock` integrity | `flake.lock` (strongest) | `mise.lock` records checksums "where the backend provides them" | `pixi.lock` |
| Refresh | edit two constants | track nixpkgs | `mise lock --bump` | track conda-forge |

For a Bun-only runtime whose JS dependencies are already locked by `bun.lock`, the extra tool and its lag or platform gaps buy little. mise would be the closest alternative if Python and Bun were to share one lock. Sources: `https://raw.githubusercontent.com/NixOS/nixpkgs/nixos-unstable/pkgs/by-name/bu/bun/package.nix`, `https://api.anaconda.org/package/conda-forge/bun`, `https://mise.jdx.dev/dev-tools/mise-lock.html`, `https://github.com/oven-sh/bun/releases/tag/bun-v1.4.5`.
