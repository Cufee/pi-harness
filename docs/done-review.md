# Done-Review reliability and verification

This reference describes how `pi-harness` runs verification gates and independent Done-Review sessions, records diagnostics, handles in-flight and stale reviews, bounds reviewer context, enforces review cycle budgets, and isolates verification checkouts.

## Verdict submission, nudge, and retry

`rollover.reviewerMaxTurns` is advisory only. Done-Reviewers are never cancelled by turn count. As a known pre-existing wall-clock limit (predating goal-18), each reviewer attempt still has an independent 10-minute per-attempt timeout.

1. **Dedicated verdict tool and strict validation:** Every Done-Reviewer receives the `submit_review_verdict` tool (`src/director/runtime.ts`). Both tool calls and fallback fenced JSON text go through `normalizeReviewerVerdict`, which requires a valid `verdict` (`approved`, `changes_requested`, or `escalate_human`), an array of `criteriaResults` objects with string `criterionId`, boolean `passed`, and string `evidence`, optional string array `blockingIssues`, and a non-empty `summary`. Malformed payloads are rejected with a field-level error so the model can correct and resubmit.
2. **In-session wrap-up nudge:** The runtime passes `isTaskSettled: () => verdictBox.value !== null` and `missingReturnWrapUpPrompt` to `runner.run`. When the reviewer ends a turn without a valid `submit_review_verdict` call, the runner delivers one in-session wrap-up prompt instructing it to call `submit_review_verdict` now.
3. **Single retry with concrete failure:** If attempt 1 still ends without a usable verdict, whether from empty output, malformed JSON, a non-completed stop reason, a runner error, or a wall-clock timeout, the harness starts one fresh reviewer session (2 attempts total). Genuine cancellations exit immediately without retry. The attempt 2 prompt embeds the attempt 1 `stopReason`, `submit_review_verdict` call and rejection count, parse or validation error, turn count, and output tail.
4. **Reviewer failure does not consume a cycle:** If both attempts finish without a structured verdict, the runtime throws `ReviewerFailedError`. Empty reviewer output is treated as an infrastructure error, never coerced into `changes_requested`. No `goal_reviews` row is inserted, `reviewCycle` and `noProgressStreak` stay unchanged, the reviewer task is marked `failed`, the goal moves to `awaiting_human`, and the `goal.reviewer_failed` event is emitted.

## Reviewer diagnostics

Every reviewer run persists structured `ReviewerDiagnostics` (`src/goals/engine.ts`):

| Field | Meaning |
| --- | --- |
| `reviewerTaskId`, `runId`, `profileId`, `model` | Identity and model route of the Tier 3 verify task. |
| `attempts` | Number of reviewer sessions started (1 or 2). |
| `stopReason` | `submitted`, `end_turn_without_verdict`, `max_turns`, `context_limit`, `quota_paused`, `timeout`, `crash`, `cancelled`, or `stale`. Mapped strictly from the runner's actual stop reason or error (`max_turns` only if the runner reports `max_turns`; `context_limit` only on a real runner context-limit signal such as `rollover_requested` or `context_limit`, never from prose matching or advisory turn counts; `quota_paused` on runner quota pauses; `crash` on runner exceptions or `error`). |
| `contextPct` | Last reported context utilization percentage (`used / size`), or `null` when unavailable. |
| `turnsUsed` | Tool-call turns observed in the last attempt. |
| `attemptFailures` | Concrete failure summary strings from failed attempts. |
| `rawOutputPaths` | Paths to per-attempt dossiers (`reviewer-attempt-<n>.txt`) holding final output text, error output, or `(empty)`. |
| `transcript` | Replay hint naming the reviewer task and run (`events for task <id>`). |
| `goalVersion`, `at` | Reviewed goal version and timestamp. |
| `infrastructure` | Set to `true` on `ReviewerFailedError` diagnostics. |

- Recorded reviews store diagnostics in `goal_reviews.diagnostics_json` and return them on `review.diagnostics` in `goal_get` and `goal_trigger_review` (non-reviewer rows such as deterministic-only gates or overrides store `null`).
- Reviewer failures that write no `goal_reviews` row persist diagnostics in `goals.last_reviewer_failure_json` via `GoalEngine.recordReviewerFailure` and expose them as `goal.lastReviewerFailure` on `goal_get`. Recording a later review verdict, accepting the goal, or amending the goal clears `lastReviewerFailure`.
- The Director `goal_trigger_review` tool catches `ReviewerFailedError` and returns `{ outcome: "reviewer_failed", goal, reviewerFailure, message }` instead of throwing. On a stale reviewer, `{ outcome: "stale", goal, reason, diagnostics }` preserves the stale reviewer's diagnostics when available.

## In-progress review visibility and amendment superseding

The runtime tracks active reviews in `activeReviewInfo` alongside `activeReviews` with `inflightId`, `kind` (`review` or `accept`), `goalVersion`, `cycle`, `phase` (`gates` or `reviewer`), `reviewerTaskId`, `runId`, and `startedAt`.

- Calling `verifyAndReviewGoal` while a review for the same goal version is in flight throws `ReviewInProgressError` containing `inFlight` and wait instructions. The Director `goal_trigger_review` tool catches it and returns `{ outcome: "review_in_progress", inFlight, superseded, howToWait, message }`.
- Calling `goal_wait({ goal_id })` while a review is in flight tracks that specific `inflightId` and blocks until the review settles (rather than returning `already_settled` when the linked run is completed or null, or remaining blocked if `changes_requested` relaunches the run), waking with `wakeReason: "event"` as soon as the review finishes.
- When `goal_amend` bumps a goal from `vN` to `vN+1`, `onReviewInvalidated` emits `goal.review_superseded` and aborts the in-flight `vN` review. If `goal_trigger_review` is called immediately afterward while the `vN` review is still unwinding, `verifyAndReviewGoal` waits up to 5 seconds (`waitForReviewUnwind`) for the superseded review to exit and then starts the `vN+1` review cleanly. The superseded `vN` reviewer task finishes as `cancelled` and records no `goal_reviews` row against `vN+1`.

## Acceptance finality and stale reviews

Once `goal_accept` marks a goal `achieved`, no in-flight, queued, or newly triggered review can change its status or create escalations:

1. `verifyAndReviewGoal` rejects `achieved` goals at entry with `StaleReviewError`. The `goal_trigger_review` tool returns `{ outcome: "stale", goal, reason }`.
2. `assertCurrent` in `verifyAndReviewGoalInner` treats `achieved` as stale and throws `StaleReviewError`.
3. `GoalEngine.recordReviewVerdict` accepts `expectedVersion` and refuses to write when the goal is `achieved`, `cancelled`, or at a different version, throwing `StaleReviewError` without inserting a `goal_reviews` row or updating `goals`. Every `recordReviewVerdict` call in `verifyAndReviewGoalInner` passes `expectedVersion: goal.version`.
4. `handlePostReviewTransition` treats any non-approved verdict on an `achieved` goal as invalidated, preventing Tier 1 relaunches and `verification_failed` escalations.
5. Late reviewer results caught as `StaleReviewError` write a `review-stale.json` dossier, mark the reviewer task `completed` with a stale summary, and emit `goal.review_stale`. Non-reviewer stale paths also emit `goal.review_stale` without modifying the goal or waking the Director.

## Reviewer context budget and prompt compaction

To prevent large goals from exhausting reviewer context before submitting a verdict:

- **Compact reviewer prompt (`buildReviewerPrompt`):**
  - When the goal evidence directory is valid, the full contract is written to a fresh unique file `<repoRoot>/.harness/goals/<goalId>/contract-v<N>-<id>.md` using `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` so it never overwrites existing evidence or follows symlinks.
  - Descriptions longer than 4 KB and criterion descriptions longer than 300 characters are truncated only when that full contract file was written successfully and is referenced in the prompt. If the evidence directory or contract file write is unavailable, `buildReviewerPrompt` includes the full description and all non-passed criterion descriptions inline without truncation.
  - Deterministic criteria that passed collapse to `- [<id>] PASS (gate)` so the reviewer does not re-verify them.
  - Inline diff patches are capped at 12 KB (down from 24 KB), while keeping `git diff --stat` and instructing the reviewer to inspect targeted hunks with `git diff <base>..<ref> -- <path>` and read line ranges instead of whole files.
  - The prompt states the context reserve rule directly: reserve the last 30% of context for the verdict, with a nudge at 70%.
- **Runtime 70% context nudge:** Inside `verifyAndReviewGoalInner`, the reviewer's `onUsage` callback watches `usage.used / usage.size`. Once utilization crosses 70% (`REVIEWER_CONTEXT_NUDGE_RATIO = 0.70`) and no verdict has been submitted yet, the runtime emits `reviewer.context_nudge` and steers the live reviewer via `onHandle` (`handle.steer`), falling back to `drainPendingSteers` if live steering is unavailable. The nudge instructs the reviewer to stop exploring and call `submit_review_verdict` immediately with verified evidence (marking unverified required criteria `passed: false` under `changes_requested`).

## Enforcing `budgets.maxReviewCycles`

`budgets.maxReviewCycles` must be a non-negative integer (config default `goals.defaultMaxReviewCycles` is a positive integer, default `4`; negative or non-integer values are rejected at goal creation). A value of `0` means zero review cycles and blocks cycle 1 unless `override_review_budget: true` is passed — `0` does not mean unlimited.

`DirectorRuntime.reviewBudgetExhausted` checks whether `goal.reviewCycle >= goal.budgets.maxReviewCycles` or whether an unresolved `verification_failed` escalation titled `Max review cycles reached...` exists on `goal.linkedRunId`.

- Automatic verification on run settlement (`run.status` `completed` or `failed`) does not start while `reviewBudgetExhausted` is non-null. Instead, an `executing` goal moves to `awaiting_human` with the exhaustion reason and wakes the Director.
- `verifyAndReviewGoal` throws `ReviewBudgetExhaustedError` without mutating goal state when the budget is exhausted unless `overrideReviewBudget: true` is passed.
- The Director `goal_trigger_review` tool catches `ReviewBudgetExhaustedError` and returns `{ outcome: "review_budget_exhausted", goal, reason, howToProceed, message }`.
- Passing `override_review_budget: true` to `goal_trigger_review` runs one additional review cycle explicitly. Amending the goal (`goal_amend`) resets `review_cycle` to 0 and supersedes open `verification_failed` escalations, clearing the block.

## Verification checkouts at the goal's merge commit

When the bisecting merge queue (`src/worktree/merge-queue.ts`) merges a run onto the target branch, it updates the advisory `refs/harness/merged/<runId>` ref with a single atomic CAS (`git update-ref <ref> <mergedSha> <expectedOld>`) without pushing to `origin`, and records a `merge.promoted` event with `mergedSha` as the durable source of truth. If updating the ref fails (for example, when another Git writer holds its lock), the queue leaves the ref and lock files untouched, logs a warning, emits `merge.ref_warning`, and still records `merge.promoted`.

`prepareVerifyCheckout` (`src/director/runtime.ts`) treats the run's latest `merge.promoted` SHA as the source of truth: it checks out the detached `_verify` worktree at that promoted commit directly whenever it resolves and is an ancestor of the base branch tip, regardless of whether the advisory `refs/harness/merged/<runId>` ref exists or is stale (for example, after a lock-induced ref update failure). Only when no `merge.promoted` provenance is recorded does it consult `refs/harness/merged/<runId>` (legacy fallback), falling back to the base branch tip when no valid provenance exists. Sibling goals whose merges sit unpushed on local `main` therefore do not fail another goal's `shipped` gate (`git fetch -q origin && git merge-base --is-ancestor HEAD origin/main`) once that goal's own merge commit has been pushed.

## Root causes documented from production runs

### Goal-7 missing verdicts (`t-75`, `t-84`)

Confirmed in `~/.pi-harness/control-plane.sqlite`: reviewer tasks `t-75` (15 tool calls, 106,292 / 200,000 context) and `t-84` (18 tool calls, 103,075 / 200,000 context) ran on a daemon still executing release `f485271a6b21`, where `reviewerMaxTurns=12` was a hard turn cap that aborted ACP sessions mid-investigation. The old runtime defaulted missing verdicts to `changes_requested: Incomplete review output` and burned the goal's last two review cycles.

### Goal-12 `shipped` gate failure (`t-80`)

Before merge-ref tracking, `prepareVerifyCheckout` checked out the local `main` tip for `_verify`. When sibling goals (`goal-15`, `goal-11`) merged onto local `main` without pushing to `origin`, `goal-12`'s `shipped` gate evaluated the sibling commits at local `main` instead of `goal-12`'s own pushed merge commit and failed.

### Goal-12 `rev-14` and Goal-7 `rev-12`/`rev-15` reopening after `goal_accept`

Confirmed in `~/.pi-harness/control-plane.sqlite` on `run-7` (`goal-12`) and `run-3` (`goal-7`):

1. At `1795476859767` (seq `11365`), `goal-12` cycle 4 (`rev-11`, reviewer `t-85`) recorded `changes_requested`, moved `goal-12` to `awaiting_human`, and opened `esc-21` (`Max review cycles reached (4/4)`, seq `11366`).
2. 163 ms later, at `1795476859930` (seq `11367`), `t-85` settling caused `run-7` to emit `run.status: completed`. Because `handleControlPlaneEvent` did not exclude `awaiting_human` and did not check `budgets.maxReviewCycles`, that event immediately auto-triggered a new `verifyAndReviewGoal` running the ~24-second deterministic gates (`bunx tsc --noEmit && bun test` plus `shipped`).
3. 17.1 seconds into those gates, at `1795476877050` (seq `11412`), the Director called `goal_accept`, writing `rev-13` (cycle 5, `approved`, status `achieved`), emitting `run.status: completed` (seq `11413`), and resolving `esc-21` (seq `11414`). No `goal_trigger_review` call occurred between `rev-13` and `rev-14`.
4. 6.8 seconds after `rev-13` (23.9 seconds after the auto-triggered gate run started at seq `11367`), at `1795476883868` (seq `11423`), the already-in-flight deterministic gate run finished with `tests: passed, shipped: failed`. Because `assertCurrent` and `GoalEngine.recordReviewVerdict` had no `achieved` guard, `recordReviewVerdict` unconditionally ran `UPDATE goals SET status = 'awaiting_human'`, wrote `rev-14` (cycle 6, `changes_requested`), and created `esc-23` (`Max review cycles reached (6/4)`, seq `11424`).
5. `goal-7` (`run-3`) hit the same pair of bugs: seq `11004` (`run.status: completed`, 112 ms after cycle 4 hit `awaiting_human`) auto-triggered cycle 5 (`t-87`) despite `maxReviewCycles=4`, and `t-87` later wrote `rev-12` over the accepted `rev-10` before seq `11387` auto-triggered cycle 7 (`rev-15`).

Enforcing `reviewBudgetExhausted` prevents the extra auto-verify cycle from starting at all, and the `achieved` / `expectedVersion` guards in `verifyAndReviewGoal`, `assertCurrent`, `recordReviewVerdict`, and `handlePostReviewTransition` ensure no late review can ever reopen an accepted goal.
