# Runtime install

`install.sh` turns a source checkout into a self-contained, per-user install. It needs no global Node, Bun, Python or package manager, writes only to the install and launcher directories plus a best-effort audit log under `$PI_HARNESS_HOME`, and is safe to re-run. The same command updates an existing install.

```sh
sh install.sh
~/.local/bin/pi-harness --help
```

From a checkout with Bun on `PATH`, `bun run install` runs the same script. A plain `bun install` does not.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_HARNESS_INSTALL_DIR` | `~/.pi-harness/install` | Staged Bun, releases and caches |
| `PI_HARNESS_BIN_DIR` | `~/.local/bin` | Where `pi-harness` and `harness` are written |
| `PI_HARNESS_NO_RELOAD` | `0` | Set to `1` to skip reloading a running daemon after activation |
| `PI_HARNESS_RELOAD_WAIT` | terminal-dependent | Set to `1` to wait for reload completion, `0` to return immediately (defaults to waiting when stdout is a terminal) |

State (`config.json`, the SQLite database, daemon socket) is untouched. Its locations are configured independently of the install: the state directory is `$PI_HARNESS_HOME` (default `~/.pi-harness`, one level above the default install directory), and the daemon socket can live elsewhere (see `socketPath` in [configuration.md](./configuration.md)). Each run that reaches activation, including unchanged re-runs, attempts to append one line (UTC time, user, pid, release id, source path) to `$PI_HARNESS_HOME/install-audit.log`; the append is best-effort and write errors are ignored, so exit status 0 does not guarantee an audit line was written. `pi-harness` has no `--version` flag; `--help` is the smoke test.

## Layout

```
$PI_HARNESS_INSTALL_DIR/
  bun/<version>-<target>/bin/bun   staged upstream Bun
  tools/octofs/<version>-<triple>/bin/octofs   staged octofs (file tools for agents over MCP)
  releases/<id>/                   src, proto, package.json, bun.lock, tsconfig.json, node_modules, .bun -> staged Bun, release.json
  current -> releases/<id>         active release (symlink swapped atomically)
  cache/downloads/                 verified Bun and octofs archives
  cache/bun/                       Bun package cache (BUN_INSTALL_CACHE_DIR, not ~/.bun)
$PI_HARNESS_BIN_DIR/pi-harness     launcher; harness -> pi-harness
```

`<id>` is the first 12 hex digits of a SHA-256 hash of the runtime files, so the same source always maps to the same release and an unchanged re-run reuses the existing release and its dependencies (it still swaps `current`, rewrites the launcher, and attempts the audit append). `release.json` records `{"id":"<id>","bunVersion":"<version>"}` and is the build identity reported by the daemon and CLI: installed releases report `<id>` from `release.json`, and a source checkout without `release.json` reports `dev-<hash>` derived from its canonical path (no file-mtime heuristics). A release is built in a staging directory and moved into place only after `bun install` succeeds; an interrupted install leaves the previous `current` and launcher working. Old releases are kept (running daemons keep executing from theirs); delete unwanted directories under `releases/` by hand.

The launcher is `exec "$release/.bun" "$release/src/cli.ts" "$@"`: the staged Bun by default. `BUN_BIN=/path/to/bun` overrides it for debugging only. Code Mode uses `process.execPath`, so it runs under whichever Bun started the CLI.

## What the installer does

1. Maps `uname` to a Bun target (`darwin-{aarch64,x64}`, `linux-{aarch64,x64}`, `-musl` where `/lib/ld-musl-*` exists, `-baseline` for x64 CPUs without AVX2; a shell under Rosetta is treated as arm64).
2. Downloads `https://github.com/oven-sh/bun/releases/download/bun-v$BUN_VERSION/bun-$target.zip` and checks it against the SHA-256 pinned in `install.sh`, before unzipping. A cached archive that fails the check is deleted and fetched again.
3. On the four targets with a pin (macOS and Linux, arm64 and x64), downloads `octofs` `0.26.0` from its GitHub release and checks the pinned SHA-256 before unpacking; the daemon offers it to agents as an MCP server (opt-out and the on-demand fallback are in [configuration.md](./configuration.md)).
4. Copies the runtime files into a release directory and runs `bun install --frozen-lockfile --production`. The frozen lockfile fails on any drift from `bun.lock` instead of re-resolving; `bun.lock` carries integrity hashes. Dev dependencies (`tsc`, `protoc-gen-es`) are not installed; `src/gen` is committed.
5. Writes `release.json`, swaps `current`, and rewrites the launcher.
6. Releases `.lock` and removes its staging directory, then invokes `daemon reload --from-install` from the new release unless `PI_HARNESS_NO_RELOAD=1` (never starting a daemon if none is running).

A `.lock` directory prevents concurrent installs; remove it if a killed install left it behind.

## Prerequisites

Actual inventory, verified by running the installer with `PATH` limited to symlinks of exactly these tools on macOS arm64:

| Needed | For | Updated by |
| --- | --- | --- |
| `sh`, `uname`, `mkdir`, `mv`, `ln`, `rm`, `cp`, `cat`, `chmod`, `touch`, `dirname`, `find`, `sort`, `cut`, `awk`, `grep`, `tar` | installer logic | the OS |
| `curl`, `unzip` | fetching and unpacking Bun | the OS |
| `sha256sum` or `shasum` | checksum verification | the OS |
| `sysctl` (macOS) | Rosetta and AVX2 detection | the OS |
| `date` | UTC timestamp in the audit line | the OS |
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

- **Harness source or JS dependencies**: pull, then `sh install.sh` (or `bun run install`). Changed `src/` or `bun.lock` yields a new release, swaps `current` atomically, and triggers a hot update of the running daemon (see [Hot update](#hot-update)).
- **Bun**: edit `BUN_VERSION` and `BUN_PINS` in `install.sh`, then re-run. Take the digests from `https://github.com/oven-sh/bun/releases/download/bun-v<version>/SHASUMS256.txt` (the `bun-<target>.zip` lines, not `-profile`), and run the Code Mode tests and the Code Mode sandbox probe under the new Bun before committing. A newer Bun than the one the sandbox was verified with can change probe behaviour (1.4.5 needs the probe to `destroy()` its socket rather than `end()`).
- **JS dependencies**: `bun update` in a checkout, commit `bun.lock`, re-run.
- **OS utilities**: the OS vendor.

The pinned version is Bun 1.4.5 (published 2026-11-19, the latest release when this was written); its SHA-256 pins were compared against `SHASUMS256.txt` for all nine targets in the installer.

## Hot update

After activating a release and appending to `install-audit.log`, `install.sh` removes its staging directory and `.lock`, clears its exit trap, and runs `"$BUN" "$REL/src/cli.ts" daemon reload --from-install` from the newly installed release. Releasing `.lock` first ensures a waiting reload does not block another install. `install.sh` never starts a daemon when none is running.

When stdout is a terminal, or when `PI_HARNESS_RELOAD_WAIT=1`, `install.sh` passes `--wait` so the CLI waits for a draining reload to finish. Set `PI_HARNESS_RELOAD_WAIT=0` to return immediately after the daemon accepts the request, or `PI_HARNESS_NO_RELOAD=1` to skip the reload step for one install. To disable automatic reloads for all installs, set `hotUpdate.mode` to `"manual"` in global `config.json` (see [configuration.md](./configuration.md#hotupdate)).

### Output and exit status

`daemon reload --from-install` prints one of the following outcomes:

- No daemon listening: `harnessd is not running. Release <id> is used on next start.` (exit `0`).
- Already on the target release: `already running release <id>` (exit `0`).
- Draining: `reload: harnessd pid <P> release <A> -> <B>, draining up to <N>s (<liveWork>)`, followed when `--wait` is active by `reloaded harnessd to release <B> (pid <P2>).` (exit `0`).
- Rate-limited: `reload scheduled for <ISO UTC> (rate limit). Run "pi-harness daemon reload" to apply now.` (exit `0`; `--wait` does not block on a `scheduled` reply).
- Manual mode: `reload skipped (mode_manual). Run "pi-harness daemon reload" to apply manually.` (exit `0`).
- Daemon predates hot-update support: prints the bootstrap notice and exits `0` without restarting it (see [First activation](#first-activation)).

`pi-harness daemon reload` uses these exit codes:

| Exit code | Meaning |
| --- | --- |
| `0` | Reloaded, accepted, scheduled, skipped, bootstrap notice printed, or no daemon running |
| `1` | Other error (invalid target, checkout without `--target`, dry-run failure, legacy PID/home mismatch, or supervisor abort recorded in `reload-fallback.txt`) |
| `2` | Confirmation missing for `daemon reload --legacy` without a terminal or `--yes` (or `--db` pointing at a different database without `--yes`) |
| `3` | Target release failed to boot (daemon fell back to a restart-safe previous release, or left no daemon running with recovery instructions in `reload-fallback.txt` when the fallback is pre-feature) |
| `4` | Timed out waiting for the new release to serve (`--wait`); detached supervisor errors that produce neither a serving daemon nor `reload-fallback.txt` can surface as exit `4` |

`install.sh` maps CLI exit `0` to `0`, maps exit `3` to `1` after noting that the install succeeded and `current` still points to the new release, and maps any other non-zero exit code to a warning recommending `pi-harness daemon reload` with exit `0`. A manual `pi-harness daemon reload` targets the already-installed `current` release (or `--target <dir>`) and does not change disk symlinks.

### Drain and in-place resume

1. **Drain**: when the daemon begins draining, its lifecycle moves to `"draining"`, work-starting RPCs are rejected with `DAEMON_RELOADING: ...`, and timers are suspended without cancelling them. Live Tier 1 orchestrators and Tier 2 workers that are running a session receive a steer asking them to call `request_rollover` within `hotUpdate.drainTimeoutSec` (default `90` seconds, read when the drain starts). Live Director chat turns receive one `system_notice` asking them to end the turn before the deadline; at the deadline, `stop()` cancels them (waiting up to 5 seconds) to flush buffered text and record their tool calls so a continuation turn runs on startup. Steer delivery is raced against the drain deadline so an unresponsive steer never extends the drain. Tier 3 task agents, Done-Reviews, verification gates, merges, and `code_exec` scripts are not steered and not waited for; they stop when the drain ends. When no Tier 1/2 agent or Director turn is running, the drain finishes immediately.
2. **Handover**: the old daemon captures child agent process groups, stops, reaps those groups, spawns a detached handover supervisor, and exits. The supervisor waits for the old PID to exit (sending `SIGKILL` after the wait if needed), reaps any surviving captured process groups, refuses to start a successor if the old PID is still alive (recording the reason in `<sockDir>/reload-fallback.txt` and exiting `1`), and starts the target release with the stopped daemon's home and socket path.
3. **In-place resume**: the new daemon recovers interrupted tasks of `active` and `paused_quota` runs (plus children of Director containers) in place, keeping the same task IDs, worktrees, write leases, and generation counts without marking tasks `failed` or `cancelled`. Pending timers (`wait_timer` and `schedule_timer`) stay `pending` and fire once into the resumed task. Queued Director wakeups captured at stop are replayed once. Tasks in runs whose stored status is not `active` or `paused_quota` keep the legacy failure behavior.
4. **What is redone and cost**: interrupted merges are closed as `ci_failed` and re-run CI when the worker resumes; interrupted Done-Reviews are cancelled and replayed (re-running verification gates and the reviewer); active PTYs, `code_exec` scripts, and in-memory quota `--in` timers do not survive a restart. Each live Tier 1/2 agent spends one extra model turn on cached context to write its rollover handoff, and each resumed agent hydrates fresh context and re-reads working files (expect roughly 1 to 5 minutes per active agent to return to steady state).

### Rate limit

While agents are live, install-triggered reloads are rate-limited to at most once every `hotUpdate.minIntervalSec` seconds (default `900`, 15 minutes) since the daemon started. An idle daemon reloads immediately. An install inside the cooldown window receives a `scheduled` reply naming the UTC due time and exits `0` immediately even with `--wait`; later installs during the window coalesce to the newest target release while keeping the original due time. Re-installing the release the daemon already runs clears a scheduled reload to another target and returns `already_current`. Running `pi-harness daemon reload` directly (or with `--now`) bypasses the rate limit and drains immediately.

### Fallback on boot failure

The supervisor waits up to 20 seconds for the target release to answer `ping` with the expected `releaseId`. If the target exits early or times out:

- When the previous release is restart-safe (`release.json` and `restartSafe: true`), the supervisor restarts it with `reload.lastError` set to `{ targetReleaseId, error }`, and that release's startup recovery resumes active work. Callers waiting with `--wait` exit `3` (including on a forced same-release restart that fell back), `install.sh` exits `1`, and `pi-harness daemon status` shows `reload.lastError`.
- When the only fallback is a pre-feature release (no `release.json` or no `restartSafe` in its `ping`), the supervisor fails closed instead of auto-starting it: it leaves no daemon running, writes recovery instructions to `daemon.log` and `<sockDir>/reload-fallback.txt`, and `--wait` prints that file and exits `3`.

In both cases `current` is left pointing to the newly installed release so you can inspect or fix it without the installer reverting symlinks.

### TUI reconnect

Attached chat and run TUIs stay open across a hot update. On socket close, the TUI reconnects on the same `DaemonClient` with exponential backoff, restores its previous controller or viewer role, fetches only missed chat history or run events without duplicates, and preserves the composer draft and queued messages.

- An older-release TUI speaking the same `protocolRev` reconnects normally and appends `harnessd runs release <B>. This terminal still runs <A>. Restart it to load the new UI.`
- If `protocolRev` changes, the TUI prints the incompatibility message (along with any unsent draft) and exits.
- After an explicit `pi-harness daemon stop`, local TUIs show `harnessd was stopped. Waiting for it to start · Ctrl+C quit` and do not respawn the daemon; remote SSH TUIs exit.
- The project picker does not reconnect.

### Inspecting status and dry-run recovery

`pi-harness daemon status` includes the hot-update fields:

- `releaseId`: build identity of the running daemon (`<id>` from `release.json`, or `dev-<hash>` for a checkout).
- `releaseDir`: directory the daemon is executing from.
- `lifecycle`: `"serving"`, `"draining"`, or `"stopping"`.
- `restartSafe`: `true` on restart-safe builds.
- `reload`: `{ state, targetReleaseId?, dueAt?, deadlineAt?, previousReleaseId?, lastError? }`, where `state` is `"idle"`, `"scheduled"`, or `"draining"`.

Run `pi-harness daemon recover --dry-run [--db <path>] [--json]` at any time to inspect what startup recovery would do without modifying the database. It opens `<stateDir>/control-plane.sqlite` (or `--db`) read-only and lists tasks that would be relaunched in place, tasks whose missing worktree would be recreated, read-only tasks falling back to the repo root, tasks failed by the legacy rule, untouched `pending`/`paused_quota` tasks, Done-Review rows to cancel, pending timers, stale merges, and goal reviews to replay.

### First activation

A daemon started from a build that predates hot-update support omits `reload` from `ping`. Running `install.sh` activates the new release on disk, prints the bootstrap notice, and exits `0` without touching the running daemon. Running `pi-harness daemon reload` manually targets the already-installed `current` release without changing symlinks, prints the same notice, and exits `0`.

Never run `pi-harness daemon stop` or `pi-harness daemon restart` against a pre-feature daemon while runs are active. Those commands skip child process-group reaping and `wait_timer` revival, which leaves old agents running beside resumed copies and leaves cancelled `wait_timer` rows cancelled.

`pi-harness daemon reload --legacy` is the only supported first-activation path. Run it from an independent interactive terminal, never from inside an agent and never from a terminal attached to a TUI of that daemon (stopping the old daemon kills agent process groups and closes attached old-release TUIs):

```sh
pi-harness daemon recover --dry-run
pi-harness daemon reload --legacy --wait
```

1. Review the dry-run report: confirm interrupted tasks of active runs appear under relaunched, untouched `pending` and `paused_quota` tasks and cancelled Done-Reviewers appear in their own sections, and nothing unexpected appears under legacy-failed.
2. Run `pi-harness daemon reload --legacy --wait`. It repeats the dry run against the resolved `PI_HARNESS_HOME` database (`--db <path>` changes only what the preview reads; when `--db` differs from the resolved database it prints a warning and requires `--yes` in addition to interactive confirmation), binds the preview to the running daemon's PID and home, displays the running PID, running release, target release, and resolved fallback release (override with `--previous <dir>` or `--target <dir>`), and asks for confirmation (pass `--yes` in non-interactive shells; without confirmation it exits `2`). After confirmation it re-checks the daemon PID and refuses to stop if the PID changed or the daemon now supports hot update; the supervisor also verifies `ping.pid` matches right before shutdown and refuses to start a successor if the old PID does not exit.
3. On the first activation against a pre-feature daemon, the following are not preserved: attached old-release TUIs exit; an in-flight Director turn is aborted and its unflushed tail is lost without a tool list or continuation turn; queued Director wakeups are lost; agents write no rollover handoffs and resume from harness-built recovery handoffs; in-flight merges, reviews, and gates run again; PTYs, `code_exec` runs, and quota `--in` timers are lost. `wait_timer` rows cancelled by the old daemon during shutdown are revived to `pending` by the new daemon.
4. If the command exits `3` and the only fallback is a pre-feature release, the supervisor does not auto-start the old daemon (starting a pre-feature daemon marks every interrupted task `failed`). It leaves no daemon running and writes recovery instructions to `daemon.log` and `<sockDir>/reload-fallback.txt` (printed by `--wait`): the boot error tail, confirmation that all work is intact in the database and will resume in place when a hot-update-capable release starts, the exact command to start the target release after fixing it, and, as a clearly labelled last resort, the command to start the old release with a warning that it fails interrupted tasks followed by `pi-harness resume <run>` for every affected run (relaunch, review cancel/replay, and legacy-fail).

### Known limitations

- An event-triggered timer (`wake_on_event` `child_settled` or `any`) whose event happens while the daemon restarts fires at its due time instead of early.
- Agent subprocesses that left their process group (started a separate session) are fenced from harness tools by the daemon nonce but are not killed during handover reaping.
- A Director turn that does not stop within 5 seconds of cancellation can lose its unflushed tail.
- After a hard daemon crash, nothing reaps old agent processes.
- An old-release TUI keeps its old UI until you restart it.

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
