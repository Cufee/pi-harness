# Configuration

This reference covers `pi-harness` configuration files, precedence, extra filesystem roots, live reload, effective-settings inspection, CLI commands, and Director tools. For runtime staging and `octofs` installation layout see [Runtime install](./runtime-install.md); for the Code Mode sandbox see [Python in Code Mode](./code-mode-python.md#sandbox); for model ranking see [Model catalog ranking](./model-catalog-ranking.md).

## Config files and precedence

- **Global file**: `$PI_HARNESS_HOME/config.json` (default `~/.pi-harness/config.json`). The state directory itself comes from the `PI_HARNESS_HOME` environment variable, not from a config key.
- **Repository overlay**: `<repoRoot>/.pi-harness.json`.
- **Precedence** (lowest to highest): built-in defaults, global file, repository overlay.
- **Merge rules**: `codeExec`, `rollover`, `worktree`, `goals`, `events`, `catalog`, and `quotaRetry` merge key by key. Scalars, arrays, and `quotaEndpoint` replace whole (`"quotaEndpoint": null` clears an inherited endpoint). An empty `profiles` array falls back to the built-in default profiles.
- **Overlay snapshot**: `harnessd` loads one repository overlay once at startup, from the `--repo` path passed to `pi-harness daemon serve` or the working directory of the command that starts or auto-spawns the daemon (one overlay per daemon, not per project). Editing `.pi-harness.json` requires `pi-harness daemon restart`.
- **Global-only keys**: the repository overlay cannot set these five keys; values placed there are ignored:
  - `worktree.extraReadRoots`
  - `worktree.extraWriteRoots`
  - `goals.gateShell`
  - `goals.gateEnv`
  - `remotes`

Every other key can come from `.pi-harness.json`, including `profiles`, `externalMcpServers`, `worktree.setupCommand`, and `worktree.ciCommands`, which execute commands; start `harnessd` only from repositories whose overlay you trust.

## Key placement

```json
{
  "worktree": {
    "maxConcurrentWorkers": 4,
    "extraReadRoots": ["~/reference-docs"],
    "extraWriteRoots": ["~/harness-reports"]
  },
  "goals": { "maxConcurrentGoals": 4 },
  "rollover": { "reviewerMaxTurns": 30 }
}
```

- A key takes effect only at the path shown in the reference below. `extraReadRoots` and `extraWriteRoots` belong under `worktree`; at the top level they are not read.
- Known keys at an unsupported location (such as top-level `extraReadRoots` or `extraWriteRoots`, a key in the wrong section, or a global-only key in `.pi-harness.json`) are ignored without taking effect. `harnessd` logs a value-free `config warning:` naming the file, key path, and supported location at startup and on live reload (and `config warnings cleared:` when global warnings clear), and lists active warnings in `configWarnings` from `pi-harness daemon status`.
- Unrecognized keys outside the schema are ignored without warning. After editing, confirm active settings with `pi-harness daemon status` (see [Inspecting effective settings](#inspecting-effective-settings)).

## Extra read and write roots

- Entries are absolute paths, `~`, or `~/...`. On live reload an invalid list is rejected and previous settings stay active; at daemon startup invalid entries are dropped with a message on stderr.
- These keys govern the harness-side checks on agent file access over ACP: text file reads and writes, permission requests from an agent's own read, search, write, edit, move, and delete tools, and the paths a read-only agent's shell commands may read. Done-Reviewers receive `extraReadRoots`. The Director's `write_note` accepts `extraWriteRoots`.
- An agent that receives write roots can also read them. Read-only task agents cannot write to configured roots, and Done-Reviewers receive `extraReadRoots` only.
- Protected paths: harness-mediated writes refuse any path containing a `.git` segment and any path under `.harness/worktrees` relative to the admitting root, even inside a configured root.
- Shell commands of write-capable workers are not checked against these roots.
- If an agent CLI applies its own OS sandbox, that sandbox is configured in that CLI; these keys are not passed to it.
- Director `read_file` does not use these roots: it reads any UTF-8 text file the operator's account can read and still refuses `.git`, task worktrees, and harness-internal state. Code Mode `code_exec` scripts never receive them: they run in the macOS sandbox described in [Python in Code Mode](./code-mode-python.md#sandbox) and cannot read workspace files directly.
- Reload: read for each newly started worker, task agent, and Done-Reviewer, and on each `write_note` call; no daemon restart is required. Sessions already running keep the roots they started with.
- Least privilege:
  - List the narrowest directory that works.
  - Prefer a read root over a write root.
  - Do not list your home directory, `/`, credential or shell-startup directories, or directories on `PATH`.
  - Remove a root when the work is done and confirm with `pi-harness daemon status`.
- Manual worktrees: the harness runs `git worktree prune` when cleaning up its own worktrees, which drops metadata for any worktree whose directory is missing at that moment. Protect manual worktrees of the same repository that can be temporarily absent with `git worktree lock <path>`.

## Reference

### Top level

| Key | Default | Notes |
| --- | --- | --- |
| `socketPath` | `$XDG_RUNTIME_DIR/pi-harness/daemon.sock` if that directory exists, else `<stateDir>/daemon.sock`, else a per-user temp directory when the path is too long | Fixed at daemon startup. |
| `codeMode` | `collapsed` | `collapsed`, `hybrid`, or `off`. |
| `defaultOrchestratorProfile` | First enabled profile | Default profile ID for Tier 0/1 sessions. |
| `defaultWorkerProfile` | First enabled profile | Default profile ID for Tier 2 workers. |
| `defaultTaskProfile` | First enabled profile | Default profile ID for Tier 3 task agents. |

### `codeExec`

| Key | Default | Notes |
| --- | --- | --- |
| `codeExec.defaultTimeoutMs` | `300000` | Default per-script timeout in ms (positive integer). |
| `codeExec.maxTimeoutMs` | `1800000` | Upper bound for per-script timeout in ms (positive integer). |
| `codeExec.maxOutputChars` | `20000` | Inline output character threshold before spilling to an artifact (positive integer). |

### `rollover`

| Key | Default | Notes |
| --- | --- | --- |
| `rollover.orchestratorThreshold` | `0.72` | Context utilization ratio in `(0, 1]` triggering Tier 1 rollover. |
| `rollover.workerThreshold` | `0.78` | Context utilization ratio in `(0, 1]` triggering Tier 2 rollover. |
| `rollover.orchestratorMaxTurns` | `200` | Tool-call turns after which the agent gets one progress reminder. The harness does not stop an agent at this count. |
| `rollover.workerMaxTurns` | `120` | Tool-call turns after which the agent gets one progress reminder. The harness does not stop an agent at this count. |
| `rollover.taskMaxTurns` | `40` | Tool-call turns after which the agent gets one progress reminder. The harness does not stop an agent at this count. |
| `rollover.reviewerMaxTurns` | `30` | Tool-call turns after which the agent gets one progress reminder. The harness does not stop an agent at this count. |
| `rollover.externalizeBytes` | `2048` | Byte threshold above which tool output is externalized (positive integer). |
| `rollover.maxGenerations` | `12` | Generation cap per task to stop unbounded rollover loops (positive integer). |

A value in your config file overrides the default; an older file that sets `reviewerMaxTurns` (for example to `12`) keeps that value until you remove the key.

### `worktree`

| Key | Default | Notes |
| --- | --- | --- |
| `worktree.dir` | `.harness/worktrees` | Base worktree directory relative to repo root. |
| `worktree.artifactsDir` | `.harness/artifacts` | Artifact directory relative to repo root. |
| `worktree.setupCommand` | Unset | Bootstrap command run inside newly created worktrees. |
| `worktree.ciCommands` | Unset | Array of deterministic CI commands run by the merge queue. |
| `worktree.ciTimeoutMs` | `300000` | Per-command CI timeout in ms (positive integer). |
| `worktree.gitAuthorName` | `pi-harness` | Git author name for automated merge commits. |
| `worktree.gitAuthorEmail` | `harness@local` | Git author email for automated merge commits. |
| `worktree.archiveRetentionDays` | `7` | Days to retain archive git refs before GC (`>= 0`). |
| `worktree.maxConcurrentWorkers` | `4` | Active Tier 2 worker worktree concurrency limit; further workers wait in the admission queue. |
| `worktree.extraReadRoots` | Unset | Global-only; see [Extra read and write roots](#extra-read-and-write-roots). |
| `worktree.extraWriteRoots` | Unset | Global-only; see [Extra read and write roots](#extra-read-and-write-roots). |

### `goals`

| Key | Default | Notes |
| --- | --- | --- |
| `goals.defaultMaxReviewCycles` | `4` | Review cycles before escalating to a human (positive integer). |
| `goals.defaultMaxNoProgressCycles` | `2` | Consecutive no-progress review cycles before escalating (positive integer). |
| `goals.gateTimeoutMs` | `180000` | Timeout in ms per verification shell gate (positive integer). |
| `goals.autoVerifyOnSettle` | `true` | Automatically run gates and Done-Review when a goal's linked run settles. |
| `goals.maxConcurrentGoals` | `4` | Active goals per repository; further committed goals wait in the admission queue. |
| `goals.gateShell` | `/bin/sh` | Global-only; absolute path of an executable invoked with `-c`. Invalid values make gates fail instead of falling back to another shell. Used for goal criteria gates, merge-queue CI commands, and `worktree.setupCommand`. |
| `goals.gateEnv` | Unset | Global-only map of string values. `PATH` is prepended to the resolved gate `PATH` (never a replacement) and must contain absolute directories. Names starting with `HARNESS_` are rejected. Invalid values make gates fail. Remove the key from `config.json` to clear it. |

### `events`, `catalog`, and `quotaRetry`

| Key | Default | Notes |
| --- | --- | --- |
| `events.fallbackWakeupIntervalSec` | `600` | Fallback wakeup interval in seconds for event-driven waits (`> 0`). |
| `events.wakeDirectorOnGoalSettle` | `true` | Wake an idle Director chat when one of its goal runs settles. |
| `catalog.ttlHours` | `24` | Model catalog cache TTL in hours (`>= 0`). |
| `catalog.artificialAnalysisKeyEnv` | `ARTIFICIAL_ANALYSIS_API_KEY` | Environment variable name for the optional Artificial Analysis key. |
| `catalog.allowPreview` | `true` | Allow preview models to outrank older GA releases in the same family. |
| `catalog.preferSubscription` | `true` | Prefer subscription routes over API routes for the same canonical model. |
| `catalog.modelFilterMode` | `all` | `all` or `allowlist`. |
| `catalog.disabledModels` | `[]` | Canonical model IDs disabled when `modelFilterMode` is `all`. |
| `catalog.enabledModels` | `[]` | Canonical model IDs enabled when `modelFilterMode` is `allowlist`. |
| `quotaRetry.nativeRetryTimeoutMs` | `45000` | Milliseconds to let a runner natively retry rate-limit errors (`>= 0`). |
| `quotaRetry.fallbackCooldownSec` | `60` | Base backoff cooldown in seconds when no reset time is reported (`>= 0`). |
| `quotaRetry.maxCooldownSec` | `900` | Ceiling for fallback backoff cooldown in seconds (`>= 0`). |
| `quotaRetry.autoResumeEnabled` | `true` | Automatically resume quota-paused runs once capacity returns. |
| `quotaRetry.earlyWakePollMs` | `30000` | Poll interval in ms while paused on quota to detect early recovery (`> 0`). |

### `quotaEndpoint`, `profiles`, `remotes`, and `externalMcpServers`

| Key | Default | Notes |
| --- | --- | --- |
| `quotaEndpoint` | Unset | Fields: `url`, `headers` (`${VAR}` expands from the daemon environment), `pollIntervalSec` (`60`), `timeoutMs` (`5000`), `format` (`protojson` or `protobuf`). See the example in [README](../README.md) and [`proto/quota.proto`](../proto/quota.proto). |
| `profiles` | `acp:claude` (enabled), `acp:codex` (enabled), `acp:gemini` (disabled) | Managed with `pi-harness profiles` or `/settings`. |
| `remotes` | Unset | Global-only; fields `name` and `sshTarget`. Managed with `pi-harness remote add\|rm\|connect\|disconnect`. |
| `externalMcpServers` | Unset | Entries have `name`, `command`, `args`, `env`, and `enabled`; forwarded to ACP agents that have workspace access (not control-plane-only agents). The daemon automatically adds `octofs` (`octofs mcp`) when its binary is available: the one staged by the installer (see [Runtime install](./runtime-install.md)), or pinned release `0.26.0` fetched into `$PI_HARNESS_HOME/tools/octofs/` after a SHA-256 check. Opt out with `{ "name": "octofs", "enabled": false }`; your own `octofs` entry replaces the default. |

## Live reload

- `harnessd` watches the state directory and applies edits to `config.json` about 120 ms after the last change, including editors that save by atomic rename.
- A missing, empty, or unchanged file changes nothing. Deleting `config.json` keeps the previous settings; write `{}` to return to defaults plus the startup overlay.
- Invalid JSON or any value that fails validation is rejected as a whole and previous settings stay active. The daemon log line names the failing keys, never values.
- An applied reload logs the changed keys; values of roots, gate shell and environment, commands, URLs, and headers are not printed.
- Reload log entries use the prefixes `config reload applied`, `config reload rejected`, `config warning:`, and `config warnings cleared:` on the daemon's stderr (redirected to `daemon.log` next to the socket, `$PI_HARNESS_HOME/daemon.log` with the default state-dir socket, when auto-spawned).
- `/settings` in the TUI writes the same `config.json` through the daemon, omitting unrecognized top-level keys and misplaced known section keys.

| Takes effect | Settings |
| --- | --- |
| Immediately | `worktree.maxConcurrentWorkers` and the other `worktree` keys except the roots; all `goals` keys (raising a limit starts queued work); `remotes`; `quotaEndpoint`; `catalog`; `profiles`; `externalMcpServers`; `worktree.extraWriteRoots` for Director `write_note` |
| For agents started after the change (running sessions keep theirs) | `worktree.extraReadRoots`, `worktree.extraWriteRoots`, `externalMcpServers`, `codeMode`, `codeExec`, `rollover`, `quotaRetry.nativeRetryTimeoutMs`, default profiles, `events` |
| Only after `pi-harness daemon restart` | state directory (`PI_HARNESS_HOME`), `socketPath`, the repository overlay |

## Inspecting effective settings

`pi-harness daemon status` (or plain `pi-harness daemon`) prints the daemon's `status` response as JSON. Alongside `pid`, `socketPath`, and `uptimeMs`, check:

- `configPath`: path to the global `config.json` the daemon watches.
- `configWarnings`: array of value-free warnings for known keys at unsupported locations in `config.json` or the startup `.pi-harness.json` overlay (including global-only keys in the overlay).
- `effectiveLimits`: `maxConcurrentGoals`, `maxConcurrentWorkers`, `reviewerMaxTurns`, `extraReadRoots`, and `extraWriteRoots`.
- `effectiveExternalMcpServers`: array of `{ name, enabled }` entries, including the default `octofs` unless disabled.

An empty `extraReadRoots` after you set roots means the key is misplaced or set as a global-only key in a repository overlay (check `configWarnings`), or the reload was rejected.

## CLI

- `pi-harness daemon serve | status | stop | restart [--remote <alias|ssh://host>]`: `serve` runs in the foreground on the local host; `restart` is needed after an install and for startup-fixed settings.
- `pi-harness resume <run-id> [--in 15m | --message "<msg>"]`: resumes a run immediately or after a delay; `--in` and `--message` cannot be combined.
- `pi-harness run resume <run-id> ...` is an alias for `pi-harness resume` and rejects `--profile`, `--model`, and `--effort`. To start a new run whose goal begins with `"resume"`, quote the goal or use `pi-harness run -- resume ...`.
- `pi-harness --remote <alias|ssh://host>` without `-p` or `--repo` opens a picker of that host's projects.
- `pi-harness --help` lists every command.

## Director tools

| Tool | What it does |
| --- | --- |
| `read_file` | Reads UTF-8 text from the workspace, harness goals, notes, and artifacts, or any file the operator's account can read (absolute or `~/`). Returns one page per call (32 KiB by default, up to 2 MiB with `max_bytes`). Select lines with `start_line`/`end_line` or page with `offset` and the returned `nextOffset` (line range and offset cannot be combined). `exception_reason` is optional. Refuses `.git`, task worktrees, harness-internal state, binaries, and directories. Available directly in collapsed Code Mode. |
| `write_note` | Logged writer scoped to `.harness/goals/`, `.harness/notes/`, or a configured `extraWriteRoots` directory; requires `path`, `content`, and `reason`. |
| `goal_accept` | Director override that marks a goal achieved. Requires `goal_id`, `reason`, and `evidence_paths`; recorded in the goal's review history as an approved review and completes the linked run. It does not run the goal's gates or a Done-Review. |
| `steer_task` | Sends a steering message to a running task of any tier in this workspace. |
| `cancel_task` | Cancels any task whose run belongs to this repository. |
| `schedule_timer` | Schedules a durable wakeup timer; `wake_on_event: "goal_settled"` requires `goal_id`, while `"any"` without `goal_id` reacts to any goal of the chat settling. |

Open escalations on a goal's run are resolved automatically when the goal is achieved (including by `goal_accept`) or cancelled.
