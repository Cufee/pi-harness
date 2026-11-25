# Configuration

This reference covers `pi-harness` configuration files, precedence, extra filesystem roots, live reload, effective-settings inspection, CLI commands, and Director tools. For runtime staging and `octofs` installation layout see [Runtime install](./runtime-install.md); for the Code Mode sandbox see [Python in Code Mode](./code-mode-python.md#sandbox); for model ranking see [Model catalog ranking](./model-catalog-ranking.md).

## Config files and precedence

- **Global file**: `$PI_HARNESS_HOME/config.json` (default `~/.pi-harness/config.json`). The state directory itself comes from the `PI_HARNESS_HOME` environment variable; a `stateDir` key in `config.json` does not set it (though a non-string value is still rejected on reload).
- **Repository overlay**: `<repoRoot>/.pi-harness.json`.
- **Precedence** (lowest to highest): built-in defaults, global file, repository overlay.
- **Merge rules**: `codeExec`, `rollover`, `worktree`, `goals`, `events`, `catalog`, `quotaRetry`, `hotUpdate`, `storage`, and `retention` merge key by key. Scalars, arrays, and `quotaEndpoint` replace whole (`"quotaEndpoint": null` clears an inherited endpoint). An empty `profiles` array falls back to the built-in default profiles.
- **Overlay snapshot**: `harnessd` loads one repository overlay once at startup (one overlay per daemon, not per project). `pi-harness daemon serve` reads it from its `--repo` path, or else its working directory; a daemon auto-spawned by any other command reads it from that command's working directory, not from the command's `--repo` flag. Editing `.pi-harness.json` requires a daemon restart from the intended directory.
- **Global-only keys**: the repository overlay cannot set these keys; values placed there are ignored:
  - `worktree.extraReadRoots`
  - `worktree.extraWriteRoots`
  - `goals.gateShell`
  - `goals.gateEnv`
  - `remotes`
  - `hotUpdate`
  - `storage`
  - `retention`

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
- Known keys at an unsupported location (such as top-level `extraReadRoots` or `extraWriteRoots`, a key in the wrong section, or a global-only key in `.pi-harness.json`) are ignored without taking effect. The scan covers the top level and the immediate fields of recognized sections, not array entries or deeper objects. `harnessd` logs a value-free `config warning:` naming the file, key path, and supported location: for the repository overlay at startup, and for the global file at startup and after each accepted reload (a rejected reload leaves the previous warnings in place). It logs `config warnings cleared:` when global warnings clear, and lists active warnings in `configWarnings` from `pi-harness daemon status`.
- Unrecognized keys outside the schema are ignored without warning. After editing, confirm active settings with `pi-harness daemon status` (see [Inspecting effective settings](#inspecting-effective-settings)).

## Extra read and write roots

- Entries are absolute paths, `~`, or `~/...`. On live reload an invalid list is rejected and previous settings stay active; at daemon startup invalid entries are dropped with a message on stderr.
- These keys govern harness-side checks in ACP sessions: structured text reads and writes, permission requests from an agent's native read, search, write, edit, move, and delete tools that the harness classifies, and the restricted-shell path check for read-only agents without shell execution (such as research and plan tasks). Done-Reviewers receive `extraReadRoots`. The Director's `write_note` accepts `extraWriteRoots`.
- For agents with shell execution enabled (write-capable workers, verify tasks, and Done-Reviewers running in a verification worktree), these keys do not sandbox arbitrary shell execution; in `data-dir` layout, shell permission callbacks perform a best-effort check of explicit path operands, write targets, and `cwd` (excluding option values and allowing the task's own workspace, including its `.git`). For external MCP servers, including `octofs`, permission callbacks check reported explicit path targets against protected paths and `deniedRoots` in `data-dir` layout when the adapter asks permission for MCP calls; adapters or modes that never ask permission for MCP calls, and adapter tools the harness does not classify, are not checked.
- An agent that receives write roots can also read them. Read-only task agents cannot perform harness-mediated structured writes, and Done-Reviewers receive `extraReadRoots` only.
- Protected paths: in the default `data-dir` layout, harness-mediated reads, writes, and permission checks refuse state-dir internals, non-granted paths under the data directory, sibling worktrees, scratch checkouts, and legacy `.harness/worktrees` paths (plus any custom worktree root while the legacy `worktree.dir` value remains present in config, subject to the limits below), even inside a configured extra root. Structured reads and writes, native read/search/write/delete permission checks, and restricted-shell checks for read-only agents also refuse `.git` paths (except a linked git worktree's regular `.git` file inside the agent's own workspace), while the shell-enabled permission check exempts the task's own workspace including its `.git`. Read and search permission checks inspect reported locations and search prefixes, and restricted shell checks the command's working directory and existing canonical operands.
- Claude adapter sessions that are not control-plane-only also receive the resolved roots as Claude Code `additionalDirectories`. If an agent CLI applies its own OS sandbox, that sandbox is configured in that CLI.
- Director `read_file` does not use these roots and already reads user-level paths such as `~/agents/memories` by default; its path rules are under [Director tools](#director-tools). To let task agents read a shared user-level directory such as `~/agents/memories`, add it under `worktree.extraReadRoots` in `$PI_HARNESS_HOME/config.json`:
  ```json
  { "worktree": { "extraReadRoots": ["~/agents/memories"] } }
  ```
  The grant takes effect at the next task launch (running sessions keep the roots they started with). Code Mode `code_exec` scripts never receive them: they run in the macOS sandbox described in [Python in Code Mode](./code-mode-python.md#sandbox) and cannot read workspace files directly.
- Reload: read for each newly started worker, task agent, and Done-Reviewer, and on each `write_note` call; no daemon restart is required. Sessions already running keep the roots they started with.
- Least privilege:
  - List the narrowest directory that works.
  - Prefer a read root over a write root.
  - Do not list your home directory, `/`, credential or shell-startup directories, or directories on `PATH`.
  - Remove a root when the work is done and confirm with `pi-harness daemon status`.
- Manual worktrees: the harness runs `git worktree prune` when cleaning up its own worktrees, which drops metadata for any worktree whose directory is missing at that moment. Protect manual worktrees of the same repository that can be temporarily absent with `git worktree lock <path>`.

### Adapter sandbox limits

In `data-dir` layout, harness-managed tools (`inspect_command`, `artifact_read`, `read_file`, `write_note`) and ACP callbacks (`fs/*`, `session/request_permission`, and read-only shell validation) always enforce the task's granted roots and `deniedRoots` (state-dir internals, other chats, sibling worktrees, and scratch checkouts). Configured `worktree.extraReadRoots` and `worktree.extraWriteRoots` entries that resolve to or inside the state dir or data root are dropped in `data-dir` layout so they cannot bypass `deniedRoots`.

Native adapter tools outside ACP callbacks depend on each adapter's own sandbox:

| Adapter | Harness tools & ACP callbacks | Native file/edit tools | Native shell commands |
| --- | --- | --- | --- |
| `claude` (`claude-agent-acp`) | Enforced | Enforced: workspace scope admits only `cwd` and granted `additionalDirectories`; `read_only_workspace` disallows file-editing tools. | Read-only shell gated via `session/request_permission`; writable and `allowShellInReadOnly` sessions run shell in the agent CLI environment. |
| `codex` (`codex-acp`) | Enforced | Enforced for writes: `read-only` mode blocks writes in strict read-only sessions; `workspace-write` mode keeps the OS `workspaceWrite` sandbox with harness-granted `writable_roots` (for writable workers and `allowShellInReadOnly` sessions). | OS `readOnly` / `workspaceWrite` sandbox restricts writes; OS-level reads outside granted roots follow the host OS sandbox. |
| `gemini` (`gemini-cli`) | Enforced | Enforced: `WorkspaceContext` / `SandboxedFileSystemService` restricts reads and writes to `cwd` and `--include-directories`. | Follows Gemini CLI sandbox settings. |
| `opencode` (`opencode acp`) | Enforced | Partially enforced when `OPENCODE_CONFIG_CONTENT` receives `deniedRoots` and `cwd` (`permission.external_directory`, `read`, and `edit` deny `deniedRoots` before allowing `cwd` and granted dirs, taking precedence over `/etc/opencode/opencode.json` `"**": "allow"`). | Unrestricted: OpenCode has no OS sandbox; shell commands (such as shell redirections) can bypass `external_directory` path rules. |
| `antigravity` (`agy acp`) | Enforced | Not enforced: `agy acp` receives `--add-dir` / `additionalDirectories`, but its native `File` tool reads paths outside granted roots without sending `session/request_permission` even with `--sandbox` and `--dangerously-skip-permissions=false`. | `--sandbox` restricts terminal commands only; no directory-deny flag exists for native file tools. |
| `amp-acp` | Enforced | Not enforced: `amp-acp` has no directory-root sandbox blocking reads or writes outside `cwd`, and never sends `session/request_permission`. `AMP_SETTINGS_FILE` disables write tools in read-only modes. | Unrestricted when shell is enabled; disabled in strict read-only and `control_plane_only` modes. |

## Reference

### Top level

| Key | Default | Notes |
| --- | --- | --- |
| `socketPath` | `$XDG_RUNTIME_DIR/pi-harness/daemon.sock` if `$XDG_RUNTIME_DIR` is set and exists; else `<stateDir>/daemon.sock` if that path is shorter than 96 characters; else `daemon.sock` in a per-user temp directory | Fixed at daemon startup. |
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
| `rollover.orchestratorMaxTurns` | `200` | Deprecated, no effect: tasks are never stopped or reminded by turn count. |
| `rollover.workerMaxTurns` | `120` | Deprecated, no effect: tasks are never stopped or reminded by turn count. |
| `rollover.taskMaxTurns` | `40` | Deprecated, no effect: tasks are never stopped or reminded by turn count. |
| `rollover.reviewerMaxTurns` | `30` | Advisory only: Done-Reviewer prompts mention this turn count as a progress check-in, and runners never stop a reviewer by turn count. |
| `rollover.externalizeBytes` | `2048` | Validated (positive integer) but read by no runtime component; Code Mode spilling uses `codeExec.maxOutputChars`. |
| `rollover.maxGenerations` | `12` | Generation cap per task to stop unbounded rollover loops (positive integer). |

#### Scope checks and Tier 3 context compaction

Instead of turn caps, the harness runs an advisory scope check on Tier 3 tasks (`src/runners/scope-nudge.ts`). It observes completed tool calls for widening across unrelated workspace areas and search topics, or repeated/stale reads (never raw turn or token counts), and steers the task to return a partial handoff (`partial: true` or `scope_too_large` with proposed splits) when scope keeps expanding.

Tier 3 tasks receive no orchestrator rollover threshold and do not use anchored multi-generation rollover (`request_rollover` remains Tier 1/2 only). Both Pi and Claude Tier 3 tasks compact in place instead of rolling over across generations. On the Pi runner (`src/runners/pi-runner.ts`), Tier 3 tasks compact earlier message history in place when context utilization reaches `DEFAULT_TASK_COMPACTION_THRESHOLD` (`0.78` in `src/config.ts`, or an explicit `rolloverThreshold` passed on the run request) and also compact and retry in place on context-overflow responses, preserving the initial prompt, pending steers, and recent turn context so long bounded reads for a single question continue uninterrupted. On the Claude ACP adapter (`src/runners/acp-runner.ts` and `src/runners/acp-shims.ts`), Tier 3 sessions leave Claude's native auto-compaction enabled (no `DISABLE_COMPACT` environment override and no `settings.autoCompactEnabled: false`), while Tier 1 and Tier 2 keep compaction disabled so the harness controls anchored rollover. Other ACP adapters rely on adapter-managed context handling.

### `worktree`

Removed keys: `worktree.dir` and `worktree.artifactsDir` are no longer settings (see [Storage layout and migration](#storage-layout-and-migration)).

| Key | Default | Notes |
| --- | --- | --- |
| `worktree.setupCommand` | Unset | Bootstrap command run inside newly created worktrees. |
| `worktree.ciCommands` | Unset | Array of deterministic CI commands run by the merge queue. |
| `worktree.ciTimeoutMs` | `300000` | Per-command CI timeout in ms (positive integer). |
| `worktree.gitAuthorName` | `pi-harness` | Git author name for automated merge commits. |
| `worktree.gitAuthorEmail` | `harness@local` | Git author email for automated merge commits. |
| `worktree.archiveRetentionDays` | `7` | Days to retain archive git refs before GC (`>= 0`). |
| `worktree.maxConcurrentWorkers` | `4` | Active Tier 2 worker worktree concurrency limit (positive integer); further workers wait in the admission queue. |
| `worktree.extraReadRoots` | Unset | Global-only; see [Extra read and write roots](#extra-read-and-write-roots). |
| `worktree.extraWriteRoots` | Unset | Global-only; see [Extra read and write roots](#extra-read-and-write-roots). |

### `goals`

| Key | Default | Notes |
| --- | --- | --- |
| `goals.defaultMaxReviewCycles` | `4` | Review cycles before escalating to a human (positive integer); copied into each new goal contract. |
| `goals.defaultMaxNoProgressCycles` | `2` | Consecutive no-progress review cycles before escalating (positive integer); copied into each new goal contract. |
| `goals.gateTimeoutMs` | `180000` | Timeout in ms per verification shell gate (positive integer). |
| `goals.autoVerifyOnSettle` | `true` | Automatically start the configured verification workflow when a goal's linked run completes (not when it stops or fails, and not for verification mode `none`; whether Done-Review runs depends on verification mode, criteria, and gate results). |
| `goals.maxConcurrentGoals` | `4` | Active goals per repository (positive integer); further committed goals wait in the admission queue. |
| `goals.gateShell` | `/bin/sh` | Global-only; absolute path of an executable invoked with `-c`. A syntactically invalid live edit is rejected on reload and the previous valid settings stay active. An invalid value at startup, or an accepted absolute path that is not executable, makes gates fail at execution instead of falling back to another shell. Used for goal criteria gates, merge-queue CI commands, and `worktree.setupCommand`. |
| `goals.gateEnv` | Unset | Global-only map of string values. `PATH` is prepended to the resolved gate `PATH` (never a replacement) and must contain absolute directories. Names starting with `HARNESS_` are rejected. A syntactically invalid live edit is rejected on reload; an invalid value at startup makes gates fail at execution. Remove the key from `config.json` to clear it. |

#### Done-Review reliability and verification checkouts

- **Advisory turn budget and wrap-up nudge:** `rollover.reviewerMaxTurns` is advisory only; Done-Reviewers are never cancelled by turn count (each reviewer session has a 10-minute wall-clock limit). When a reviewer ends its turn without a valid `submit_review_verdict` call, the runner's wrap-up hook (`isTaskSettled` and `missingReturnWrapUpPrompt`) sends one in-session nudge instructing it to call `submit_review_verdict` now (or return one fenced JSON verdict if the tool is unavailable; partial evidence with `changes_requested` is accepted).
- **Single retry with concrete failure:** If attempt 1 still finishes without a usable verdict, the harness retries once in a fresh reviewer session (2 attempts total). The retry prompt includes the concrete failure from attempt 1: `stopReason`, whether `submit_review_verdict` was called, the normalizer or JSON parse error when malformed, and a short tail of the final output.
- **Reviewer failure does not consume a cycle:** If both attempts fail without a structured verdict, the reviewer task is marked `failed` with a structured failure result and the goal moves to `awaiting_human` with a reviewer-failure status message. No `goal_reviews` row is inserted, `reviewCycle` is not incremented, and the no-progress breaker is not fed. Missing verdicts never default to `changes_requested`.
- **Verification checkout at the goal's merge commit:** When the merge queue merges a run onto the target branch, it updates `refs/harness/<chat>/merged/<runId>` (or keeps updating the legacy `refs/harness/merged/<runId>` for a pre-flip run that already has one) to the merged commit without pushing to `origin`. `prepareVerifyCheckout` creates the `_verify` worktree at the run's promoted commit or merged ref (accepting both chat-scoped and legacy ref names) when it exists and is an ancestor of the local base branch tip, falling back to the base tip otherwise. Sibling goals' unpushed merges on the local base branch therefore do not break a goal's `shipped` gate (`git merge-base --is-ancestor HEAD origin/main`) once that goal's own merge commit has been pushed.
- **Goal-7 root cause:** Goal-7 reviewer tasks `t-75` and `t-84` burned review cycles because the running daemon had not been restarted off release `f485271a6b21`, where `reviewerMaxTurns=12` was a hard turn cap that cancelled ACP sessions mid-investigation and the old runtime accepted `max_turns` and recorded a defaulted `changes_requested` review.

### `events`, `catalog`, and `quotaRetry`

| Key | Default | Notes |
| --- | --- | --- |
| `events.fallbackWakeupIntervalSec` | `600` | Fallback wakeup interval in seconds for event-driven waits (`> 0`). |
| `events.wakeDirectorOnGoalSettle` | `true` | Wake an idle Director chat when one of its goal runs or Director-spawned tasks settles. |
| `catalog.ttlHours` | `24` | Model catalog cache TTL in hours (`>= 0`). |
| `catalog.artificialAnalysisKeyEnv` | `ARTIFICIAL_ANALYSIS_API_KEY` | Validated (string) but read by no runtime component; setting it selects no credential. |
| `catalog.allowPreview` | `true` | Allow preview models to outrank older GA releases in the same family. |
| `catalog.preferSubscription` | `true` | Prefer subscription routes over API routes for the same canonical model. |
| `catalog.modelFilterMode` | `all` | `all` or `allowlist`. |
| `catalog.disabledModels` | `[]` | Canonical model IDs disabled when `modelFilterMode` is `all`. |
| `catalog.enabledModels` | `[]` | Canonical model IDs enabled when `modelFilterMode` is `allowlist`. |
| `quotaRetry.nativeRetryTimeoutMs` | `45000` | Milliseconds to let a runner natively retry rate-limit errors (`>= 0`). |
| `quotaRetry.fallbackCooldownSec` | `60` | Base backoff in seconds when repeated quota pauses report recovery within 15 s (accepts `>= 0`; runtime floor 15 s). |
| `quotaRetry.maxCooldownSec` | `900` | Backoff ceiling in seconds (accepts `>= 0`; at runtime never below the base). |
| `quotaRetry.autoResumeEnabled` | `true` | Automatically resume quota-paused runs at the scheduled time. |
| `quotaRetry.earlyWakePollMs` | `30000` | Poll interval in ms for early recovery during a scheduled quota wait (accepts `> 0`; runtime floor 5 s). Polls only with a configured `quotaEndpoint` and a wait longer than the interval. |

When neither a reset time nor confirmed current capacity provides a schedule (or when `autoResumeEnabled` is `false`), no fallback timer is started and the run waits for a manual resume (or `pi-harness resume <run-id> --in <dur>`).

### `hotUpdate`

Global-only; values placed in `.pi-harness.json` are ignored with a `config warning:`. See [Runtime install](./runtime-install.md#hot-update) for the reload lifecycle and installer environment variables (`PI_HARNESS_NO_RELOAD`, `PI_HARNESS_RELOAD_WAIT`).

| Key | Default | Notes |
| --- | --- | --- |
| `hotUpdate.mode` | `"auto"` | `"auto"` or `"manual"`. In `"manual"` mode, `install.sh` activates the release on disk without reloading the running daemon. |
| `hotUpdate.drainTimeoutSec` | `90` | Maximum seconds to wait for live Tier 1/2 agents and Director turns to hand off before stopping (`5..600`). |
| `hotUpdate.minIntervalSec` | `900` | Minimum seconds of daemon uptime between install-triggered reloads while agents are live (`0..86400`; `0` disables the rate limit). Idle daemons and manual `pi-harness daemon reload` bypass this limit. |

At startup, out-of-range numeric values for `drainTimeoutSec` (`5..600`) and `minIntervalSec` (`0..86400`) are clamped to the nearest bound with a warning on stderr; non-numeric values, a non-object `hotUpdate`, and an unknown `mode` fall back to the default with a warning on stderr. On live config reload, out-of-range numbers, wrong types, and unknown `mode` values are rejected as a whole and previous settings stay active.

### `storage` and `retention`

Both sections are global-only; values placed in `.pi-harness.json` are ignored with a `config warning:`. Default values are omitted when `config.json` is serialized.

| Key | Default | Notes |
| --- | --- | --- |
| `storage.dataDir` | `<stateDir>/data` | Non-empty path string (`~` and `~/...` expand against `HOME`, resolved to an absolute path). Takes effect at daemon start only; live config reloads do not move paths for a running daemon. |
| `retention.installReleases` | `3` | Number of installed releases kept under `$PI_HARNESS_INSTALL_DIR/releases` during post-install pruning, counting the active release (positive integer). In-use releases, the previous release, and releases modified within the last 10 minutes are always kept even if that exceeds this count. |
| `retention.logMaxBytes` | `10485760` | Maximum size in bytes (10 MiB) for `daemon.log` and `install-audit.log` before renaming to `.1` (positive integer). `daemon.log` rotates at daemon or supervisor spawn; `install-audit.log` rotates during post-install maintenance. |

## Storage layout and migration

By default (`data-dir` layout), harness-owned data lives outside user repositories under `storage.dataDir` (default `<stateDir>/data`, i.e., `~/.pi-harness/data`):

```text
<storage.dataDir>/
  projects/
    <basename>-<12hex sha256(canonical repo root)>/
      project.json
      notes/
      chats/
        <chat-N|legacy>/
          goals/<goalId>/
          artifacts/<runId>/<taskId>/
          notes/
          worktrees/<runId>/<taskId>/
      scratch/
        _verify/<name>/
        _integration/<name>/
```

- **Automatic migration at daemon start:** Upgrading from an older install with in-repo `<repo>/.harness` directories requires no manual step. `harnessd` runs a bounded migration pass automatically at startup, moving eligible completed units into `<storage.dataDir>` and rewriting indexed artifact paths in SQLite. Units belonging to goals that are not finished stay in the repo until the goal is achieved or cancelled and the daemon starts again. Each migrated legacy unit path keeps a bridge symlink pointing to its new location for 7 days before a later startup pass removes it, and empty legacy container directories are cleaned up once empty. Existing worktrees are never moved in place and are retired through normal worktree teardown and sweep.
- **Dry-run inspection:** Run `pi-harness migrate-storage --dry-run` (optionally `--json`) to open the database read-only and print the per-repository migration plan without modifying files or database rows. Running `pi-harness migrate-storage` without `--dry-run` moves nothing and exits `1`, directing you to `pi-harness daemon restart` because the daemon startup pass is the only writer.
- **Removed config keys:** `worktree.dir` and `worktree.artifactsDir` have been removed as configurable settings and cannot be set or changed through config updates. Existing config files that still contain them load without error and without unknown-key warnings. `worktree.artifactsDir` is dropped and never serialized. An existing `worktree.dir` value is kept only internally and written back verbatim when saving a global config file that already contained it (never added when absent); while that legacy value remains present in config, the storage layer uses it to recognize, protect, and sweep existing checkouts created under it and as the base dir under the legacy emergency lever, with no effect on where `data-dir` layout creates new worktrees.
- **Emergency legacy lever:** Set `PI_HARNESS_STORAGE_LAYOUT=legacy` in the environment before starting a process to fall back to the legacy in-repo `<repo>/.harness/{goals,artifacts,notes,worktrees}` layout and legacy git names. The variable is read once at process start (`data-dir` is also accepted explicitly).
- **Git branch and ref names:** In `data-dir` layout, new worker branches use `harness/<chat>/<run>/<task>`, safety archive refs use `refs/harness/<chat>/archive/<run>/<task>`, and run merged refs use `refs/harness/<chat>/merged/<run>`. Readers and archive expiry accept both the chat-scoped names and the legacy `harness/<run>/<task>`, `refs/harness/archive/<run>/<task>`, and `refs/harness/merged/<run>` names. A pre-flip run that already has a legacy merged ref keeps updating that ref.

### Known limits

- **Fallback to previous release and `artifact.read`:** After rolling back to a release prior to the storage move, the old release still lists migrated artifact rows but cannot read a rewritten data-dir dossier path through the `artifact.read` RPC until upgraded again. Native file reads through the bridge symlink continue to work.
- **Fallback to previous release and `write_note` (B11):** After a fallback to the previous release, `write_note` cannot overwrite an already migrated note because it refuses the bridge symlink. Writing new note filenames works.
- **Recursive commands under allowed ancestors (B11):** Recursive shell or search commands running under an allowed ancestor of the state dir (such as `~`) are not filtered internally; explicit path arguments and `cwd` are checked.
- **Worker commits under legacy `.harness` (B11):** A worker branch that commits files under `<repo>/.harness` can still be promoted by the merge queue.
- **Multiple daemons on one state dir (B11):** Running two daemons against the same state directory through different sockets is unsupported.
- **Legacy custom `worktree.dir` protection (C4):** A preserved `worktree.dir` value resolves literally against the repository root (no trimming and no extra `~` expansion) and applies while that legacy value remains present in config. Custom roots at or above the repo root, shared parents of multiple repositories, and another project's relative custom root are not protected.
- **Git ref segment validation and worktree parent races (C11):** In `data-dir` layout, run and task IDs with an interior `@` or trailing `.` are rejected by git ref validation. Concurrent replacement of a worktree parent directory during `git worktree add` is not guarded.
- **Cross-filesystem copy path race, fallback gap, and single-file budget (D2, D3, D4):** When `storage.dataDir` is on a different filesystem from the repository and migration uses the copy path: (1) a writer that modifies a legacy file between the engine's `lstat` and `unlink` can lose that edit; (2) falling back to the previous release between source deletion and bridge symlink creation leaves the legacy path missing until the new release runs again; (3) a single file too large to copy and hash-verify within one startup pass budget is never migrated, stays in the repository, and is reported by `--dry-run`.
- **Unrecorded former goal runs (D8):** A former run of a goal whose link history is not recorded can migrate while the goal is still active; its legacy path remains readable through the bridge symlink.
- **Legacy-lever redirected extra root in ACP runner (E3):** Under `PI_HARNESS_STORAGE_LAYOUT=legacy`, an operator-configured extra root inside the state directory that is already redirected through a symlink when the ACP runner first receives it is adopted by the runner (harness task tools still refuse it).
- **Adapters without a native directory sandbox:** Adapters without a native directory sandbox (`amp-acp`, OpenCode with an allow-all host config, and Antigravity `agy acp`) rely on harness tools and ACP permission callbacks rather than OS-level read confinement (see [Adapter sandbox limits](#adapter-sandbox-limits)).
- **Unfiltered `octofs` MCP calls on non-prompting adapters:** `octofs` tool calls on adapters or modes that never send `session/request_permission` for MCP calls (`codex` tools with `readOnlyHint: true` such as `octofs.view`, `opencode`, `amp-acp`, and Claude writable `bypassPermissions` mode) are not filtered by the harness, and `octofs mcp` has no root-restriction flag.

### `quotaEndpoint`, `profiles`, `remotes`, and `externalMcpServers`

| Key | Default | Notes |
| --- | --- | --- |
| `quotaEndpoint` | Unset | Fields: `url`, `headers` (`${VAR}` names of uppercase letters, digits, and underscores expand from the daemon environment; unset names expand to empty), `pollIntervalSec` (`60`), `timeoutMs` (`5000`), `format` (`protojson`, the default, or `protobuf`). See the example in [README](../README.md) and [`proto/quota.proto`](../proto/quota.proto). |
| `profiles` | `acp:claude` (enabled), `acp:codex` (enabled), `acp:gemini` (disabled) | Managed with `pi-harness profiles` or `/settings`. |
| `remotes` | Unset | Global-only; required fields `name` and `sshTarget`, optional `bridgeCommand`, `autoConnect`, and `reverseAccess`. Managed with `pi-harness remote add\|rm\|connect\|disconnect`. |
| `externalMcpServers` | Unset | Entries have `name`, `command`, `args`, `env`, and `enabled`; forwarded to ACP agents that have workspace access (not control-plane-only agents). The daemon adds `octofs` (`octofs mcp`) when it resolves a binary: the one staged by the installer (see [Runtime install](./runtime-install.md)), one on `PATH` (used without checksum verification), or pinned release `0.26.0` downloaded on demand into `$PI_HARNESS_HOME/tools/octofs/` after a SHA-256 check. Opt out with `{ "name": "octofs", "enabled": false }`; your own `octofs` entry replaces the default. |

## Live reload

- `harnessd` watches the state directory and applies edits to `config.json` about 120 ms after the last change, including editors that save by atomic rename.
- A missing, empty, or unchanged file changes nothing. Deleting `config.json` keeps the previous settings; write `{}` to return to defaults plus the startup overlay.
- Invalid JSON or any value that fails validation is rejected as a whole and previous settings stay active. For a validation failure the daemon log line names the failing keys, never values; a JSON syntax error names no key.
- An applied reload logs the changed keys; values of roots, gate shell and environment, commands, URLs, and headers are not printed.
- Reload log entries use the prefixes `config reload applied`, `config reload rejected`, `config warning:`, and `config warnings cleared:` on the daemon's stderr (redirected to `daemon.log` next to the socket, `$PI_HARNESS_HOME/daemon.log` with the default state-dir socket, when auto-spawned).
- `/settings` in the TUI writes the effective config to `config.json` through the daemon, including values that come from the startup overlay and unknown fields inside sections, and dropping unrecognized top-level keys and misplaced known section keys.

| Takes effect | Settings |
| --- | --- |
| Immediately | `worktree` keys other than the roots (raising `maxConcurrentWorkers` starts queued workers); `goals.gateTimeoutMs`, `gateShell`, `gateEnv`, `autoVerifyOnSettle`, and `maxConcurrentGoals` (raising it starts queued goals); `remotes`; `quotaEndpoint`; `catalog`; `profiles`; `worktree.extraWriteRoots` for Director `write_note`; `events` for Director settlement and wait handlers (a wait already in progress keeps the value read when it started); `codeMode` and `codeExec` for an existing task's next MCP tool discovery (`tools/list`) and Code Mode dispatch; `externalMcpServers` for daemon config, `daemon status`, and background `octofs` staging; `quotaRetry.fallbackCooldownSec`, `maxCooldownSec`, `autoResumeEnabled`, and `earlyWakePollMs` when the next quota pause is handled (timers already armed are not reconfigured); `hotUpdate` for subsequent `daemon.reload` requests (an already armed schedule timer keeps its due time, the drain reads the `hotUpdate` settings that are current when the drain starts, and a drain already in progress keeps its deadline); `retention` on the next daemon spawn or post-install maintenance pass |
| When a task or goal is created | `goals.defaultMaxReviewCycles` and `defaultMaxNoProgressCycles` (copied into the new goal contract; existing goals keep theirs) |
| At agent launch or generation (running sessions keep theirs) | `worktree.extraReadRoots`, `worktree.extraWriteRoots`; `externalMcpServers` entries for newly started ACP sessions; `codeMode` and `codeExec` initial prompt and runner tool list (later MCP tool discovery and Code Mode dispatches read the current mode and limits); `quotaRetry.nativeRetryTimeoutMs`; `rollover.orchestratorThreshold`, `workerThreshold`, and `maxGenerations`; default profiles |
| Only after a daemon restart | state directory (`PI_HARNESS_HOME`), `socketPath`, `storage.dataDir`, the repository overlay |

To change `socketPath` or `PI_HARNESS_HOME`, run `pi-harness daemon stop` while the old setting is still in effect, change the setting, then start the daemon at the new address: `pi-harness daemon restart` targets the newly configured address and leaves the old daemon running if the effective socket path changes. Start or restart from the intended overlay directory.

## Inspecting effective settings

`pi-harness daemon status` (or plain `pi-harness daemon`) prints the daemon's `status` response as JSON. It reports a subset of the settings; alongside `pid`, `socketPath`, `uptimeMs`, `releaseId`, `releaseDir`, `lifecycle`, `restartSafe`, and `reload` (see [Runtime install](./runtime-install.md#inspecting-status-and-dry-run-recovery)), check:

- `configPath`: path to the global `config.json` the daemon watches.
- `configWarnings`: array of value-free warnings for known keys at unsupported locations in `config.json` or the startup `.pi-harness.json` overlay (including global-only keys in the overlay).
- `effectiveLimits`: `maxConcurrentGoals`, `maxConcurrentWorkers`, `reviewerMaxTurns`, `extraReadRoots`, and `extraWriteRoots`.
- `effectiveExternalMcpServers`: array of `{ name, enabled }` entries. The default `octofs` appears only when a binary is resolved; an explicitly disabled entry appears as `{ name: "octofs", enabled: false }`.

An empty `extraReadRoots` after you set roots can mean the key is misplaced, it is set in a repository overlay where it is global-only, the reload was rejected, invalid entries were dropped at startup, the file sets an explicit `[]`, or you are reading a different config or daemon. Check `configPath`, `configWarnings`, and the daemon's stderr.

## CLI

- `pi-harness daemon serve | status | stop | restart | reload | recover --dry-run [--remote <alias|ssh://host>]`: `serve`, `reload`, and `recover --dry-run` run locally. `reload [--now] [--wait] [--target <dir>]` hot-updates a running daemon in place (see [Runtime install](./runtime-install.md#hot-update)). `restart` runs an immediate forced hot reload with `--wait` when the local daemon supports hot update. Against a pre-feature daemon, `restart` refuses a busy daemon without stopping it and prints a notice naming `pi-harness daemon reload --legacy` (use `daemon reload --legacy`, not `daemon stop`, while runs are active); only an idle pre-feature daemon is stopped and started again. An unresponsive local daemon is also refused without stopping it, and if no daemon is listening `restart` starts one.
- `pi-harness resume <run-id> [--in 15m | --message "<msg>"]`: resumes a run immediately; `--in <dur>` instead schedules a delayed resume of a quota-paused run (clamped to 1 s to 24 h). `--in` and `--message` cannot be combined.
- `pi-harness run resume <run-id> ...` is an alias for `pi-harness resume` and rejects `--profile`, `--model`, and `--effort`. To start a new run whose goal begins with `resume`, quote a multi-word goal, or use `pi-harness run -- resume ...`, which works for any such goal, including the single word.
- `pi-harness [--resume] [-p <project>] [--repo <path>]` on a TTY opens the project picker instead of the last-used project. `--resume` opens the registered local project containing the current directory, choosing the innermost project when nested. With no matching project, it opens the picker with a warning. `-p`, `--project`, and `--repo` open that target directly and take precedence over `--resume`.
- `pi-harness --remote <alias|ssh://host>` on a TTY, without `-p`, `--project`, or `--repo`, always opens a picker of that host's registered projects, including when the host has no registered projects.
- Session control: when a second TUI attaches to an open session, the first stays connected in read-only mode and keeps its draft. Pressing `Ctrl+Y` or running `/take` reclaims control and makes the other terminal read-only.
- `pi-harness inbox [--all] [--run <run-id>] [--json] [--remote <alias|ssh://host>]`: lists the same human-visible items as the TUI Inbox from `work.snapshot`, with a hidden count hint when internal items exist. Pass `--all` to append `internalAttention` with audience and hidden reason, or `--json` for raw JSON output.
- `pi-harness escalations [list] [--all] [--status open|acked|resolved|all] [--run <run-id>] [--limit <n>] [--json] [--remote <alias|ssh://host>]`: defaults to escalations the shared attention policy marks human-visible, with a hidden count hint. Pass `--all` or an explicit `--status` for the raw `escalation.list` output.
- `pi-harness goals [list [--json] | review <id> | pause <id> | cancel <id>] [--remote <alias|ssh://host>]`: prints a table by default; pass `--json` for raw `goal.list` JSON output. With `--remote` and no `--repo`, both table and `--json` output list goals across all repositories on the remote host instead of filtering by the local working directory.
- `pi-harness runs [--all] [--json] [--remote <alias|ssh://host>]`: hides `director-tasks-*` container runs by default in both table and `--json` output, with a hidden count hint in table output; pass `--all` to include them.
- `pi-harness tree <run-id> [--remote <alias|ssh://host>]`: stays raw JSON debug output for the run, task, and escalation tree.
- `pi-harness migrate-storage --dry-run [--json]`: opens the control-plane database read-only and prints the per-repository storage migration plan. Without `--dry-run`, it moves nothing, explains that migration runs automatically at daemon start (`pi-harness daemon restart`), and exits `1`.
- `pi-harness --help` lists the primary commands.

## Director tools

| Tool | What it does |
| --- | --- |
| `read_file` | Reads UTF-8 text from the workspace, harness goals, notes, and artifacts, or any file the operator's account can read (absolute or `~/`). Returns one page per call (32 KiB by default, up to 2 MiB with `max_bytes`). Select lines with `start_line`/`end_line` or page with `offset` and the returned `nextOffset` (line range and offset cannot be combined). `exception_reason` is optional. Workspace-relative legacy paths under `.harness/{goals,notes,artifacts}/...` are mapped to their current location (preferring an existing legacy file if both exist). Path rules apply to the canonical path, case-insensitively: it refuses state-dir internals, worktrees and scratch checkouts under the data directory, `project.json`, any `.git` segment, top-level `.harness/*` other than `.harness/{artifacts,goals,notes}` inside the repo, and any `.harness/worktrees` segment pair or preserved legacy `worktree.dir` root. Refuses directories and other non-regular files, and fails when the returned byte slice is not valid UTF-8 (not a whole-file binary check). Available directly in collapsed Code Mode. |
| `write_note` | Logged writer scoped to the current chat's `goals/` and `notes/` directories, the project `notes/` directory under `storage.dataDir`, the chat's own live legacy goal units, or a configured `extraWriteRoots` directory outside harness state and storage roots; workspace-relative `.harness/goals/...` and `.harness/notes/...` paths are mapped automatically. Requires `path`, `content`, and `reason`. |
| `goal_accept` | Director override that marks a goal achieved. Requires `goal_id`, `reason`, and `evidence_paths`; recorded in the goal's review history as an approved review and completes the linked run. It does not run the goal's gates or a Done-Review. |
| `steer_task` | Looks up a task of any tier on the daemon by ID and attempts to steer a live task (returns `steered: false` when the task has no live runner session or the runner does not accept the message, and refuses settled tasks or stopped runs); unlike `cancel_task`, it does not check that the task's run belongs to this repository. |
| `cancel_task` | Cancels any task whose run belongs to this repository. |
| `schedule_timer` | Schedules a durable wakeup timer; `wake_on_event: "goal_settled"` requires `goal_id`, while `"any"` without `goal_id` reacts to any goal of the chat settling. When settlement wakes are enabled (`events.wakeDirectorOnGoalSettle`), a settling goal cancels the chat's matching timer. |

Open escalations on a goal's run are resolved automatically when the goal is achieved (including by `goal_accept`) or cancelled.

### Steering, goal amendments, and stale progress

**Amp ACP steering root cause and fix.** `amp-acp`'s `_amp/session/steer` is a mutating next-turn queue, not live mid-turn injection: while a turn is active it queues the message in `amp-acp` and returns `{"outcome": "queued"}` (or `{"outcome": "failed"}` on Orb sessions or a full queue). Because harness workers normally run their full assignment inside one ACP prompt turn and settle via `return_task` before a second turn starts, closing the session cancels queued steers before the model sees them, while probing `_amp/session/steer` and also falling back to the harness queue would deliver the same steer twice. `AcpRunner` chooses one delivery owner before sending and never probes `_amp/session/steer` mid-turn. `AcpRunner` defaults `AMP_ACP_CANCEL_MODE` to `off` (queued delivery): `handle.steer` returns `false` without sending `session/cancel` so the harness queue delivers the message on the next control-plane tool result or next turn (sending `session/cancel` mid-turn to Amp can disconnect Amp's MCP tool executor with `No executor is connected` for the rest of the session). Explicit opt-in via `AMP_ACP_CANCEL_MODE=steer` on local CLI Amp sessions (not Orb or `AMP_ACP_TRANSPORT=sdk`) enables cancel-then-prompt handoff (`session/cancel` followed by replacement `session/prompt`, re-checking abort, rollover, quota, and settlement after cancel so `amp-acp` writes `{"steer": true}` to the live Amp process) only when no tool call is in flight; while any tool call is running or another hand-off is pending, `handle.steer` still returns `false` and queues delivery. Explicit user stop/cancel (`handle.cancel` / abort) always sends `session/cancel` promptly. **Delivery-acknowledgement rule:** `AcpRunner` reports live delivery (`SteerTaskResult.live === true`) only after observing a model-visible application signal on the replacement turn (a matched `user_message_chunk` echo, post-cancel replacement turn activity, or a clean non-cancelled/non-refusal completion), not when `session/prompt` is merely dispatched. Replacement rejection, cancellation, transport close, or ack timeout reports `live: false`.

**Universal steering piggyback.** Whenever a task invokes any control-plane tool (not only `wait_children`), the executor drains queued steering messages and appends them to the tool result as `steeringMessages`. Goal amendments and scope nudges share this single steering queue.

**Goal amendments and task goal versions.** Each task records `goalVersion` when created from its linked goal. `goal_amend` steers the amendment delta directly to every live Tier 2/3 task bound to an older version, returns per-task `affectedTasks` (`delivered`, `queued`, or `refused`, plus `scopeHit`), emits `goal.amendment_task` events (emitting `delivered` when a queued amendment is drained and `cancelled` once on any authoritative cancellation transition of an affected task, including NULL-bound linked workers, live-rebound tasks, and runner-first cancellations), and lists the affected tasks in the Tier 1 steer. A task's `goalVersion` rebinds immediately only on live delivery; queued delivery rebinds when drained (and resumes rebind to the current version). `goal_get`, `tree_view`, `compactTaskHandoff`, and run activity summaries expose `goalVersion` (with `staleGoalVersion` on `goal_get` tasks and `lastAmendmentAction` on activity rows). Calling `return_task` while bound to an older version still succeeds, records `staleGoalVersion: { bound, current }` in `resultJson`, and returns `amendmentNotice`.

**Stale progress filtering.** `report_goal_progress` drops `criteriaResults` for criterion IDs absent from the current goal version, and for tasks bound to an older goal version also drops `verificationStatus: "passed"` and `phase: "completed"`, accepting the rest and returning `dropped` plus an explanatory `note`. `goal_amend` clears stale claims, phase, and summary (preserving `queued`/`queue_launch_error`), and read-path reconciliation hides claims from older reporter versions or unknown criterion IDs.
