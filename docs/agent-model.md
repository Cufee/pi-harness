# Agent model

This page describes who the agents in `pi-harness` are, what each decides for itself, and how work, questions, and user messages move between them. Configuration keys are in [configuration.md](configuration.md).

## The three kinds of agent

| Agent | Tier | Talks to | Workspace | Decides |
| --- | --- | --- | --- | --- |
| **Director** | 0 | The user, and lead threads | Read-only, no shell | What to answer itself, when to start a goal, where work a lead sent back should go |
| **Lead thread** | 1 | The Director, and its children | Its own git worktree, read and write | Scope, plan, and for each step whether to do it itself or hand it to a child |
| **Worker thread** | 2 | Its lead, and its subagents | Its own git worktree, limited to its write scopes | How to deliver the slice its lead gave it |
| **Subagent** | 3 | Its parent only | Its parent's worktree; `research`, `plan`, and `verify` are read-only, `execute` writes | How to finish its one assignment |

The Director is the only agent the user talks to. A lead thread owns one goal and its outcome. Worker threads and subagents exist only when a lead (or a Worker) chooses to start them.

Internal identifiers keep their earlier names: the lead thread is role `orchestrator` and task kind `orchestrator`, and tiers are stored as `1`, `2`, `3`.

## A lead thread works on its own

A lead thread scopes its goal, records a plan, and then delivers it.

- **It does the work itself by default.** It edits, runs commands, and commits in its own worktree, and merges with `submit_for_merge`. It can merge more than once: after a merge its worktree continues from the merged base branch.
- **It delegates when that helps**, and only then: steps that can run at the same time on different files go to Worker threads (`spawn_worker`); a step whose intermediate output would fill its context goes to a subagent (`spawn_task`, including `execute` subagents that edit the lead's worktree); a conclusion that needs independent checking goes to a `verify` subagent.
- **Nothing forces a split.** No agent is stopped by a turn, tool-call, or token count, subagents compact their context in place, and the harness no longer advises an agent to hand back partial work because it read widely. The `scope-too-large` advisory fires only when an agent is spinning: the same call repeated, or reads that find nothing new. `return_task` status `scope_too_large` remains available as the agent's own choice.

Setting `goals.leadWritable` to `false` restores a read-only lead that plans and delegates every change.

## The plan and the turn-end check

A lead records its scope and steps with `update_plan`. The plan is stored by the harness, not only in the model's context: the lead sees it again after a context rollover or a resume, and the Director reads it with `run_status` (`leadPlan`). Clients get the same plan, and the requests still open on the run, from `work.snapshot` as `runs[].leadPlan` and `runs[].requests`.

When a lead ends its turn, the harness checks the goal against what it can observe, not against the lead's last message:

| Checked | Source | Open when |
| --- | --- | --- |
| Forwarded requests | Request ledger | A `user_request` has not been triaged |
| Child tasks | Task tree | A child is still running |
| Plan | `update_plan` | No plan is recorded, or a step is `pending` or `in_progress` |
| Worktree | git | Uncommitted changes; a bounced merge; commits not on the base branch (unless the plan's `delivery` is `external` or `none`) |
| Required criteria | Goal progress | A required criterion has no reported result, or was last reported failing (checked once the plan's steps are finished) |

If anything is open, the turn is reopened with the exact list. The lead may end with open items in two cases:

- **It waits on the user.** It asked a question with `ask_user` and everything left depends on the answer. It is reminded once to do what does not depend on the answer, then allowed to end. The goal is parked as `awaiting_human` and is not verified as if it were finished.
- **The same list came back unchanged `goals.leadTurnEndChecks` times** (default 3). The thread ends, and the open items are appended to its summary (`[Ended with N open items: ...]`) so the Director and the Done-Review see them. Any change to the list or the plan resets the count.

Each check emits a `lead.turn_end_check` event with the open items and the outcome (`reopened`, `waiting_on_user`, or `ended_unfinished`).

## The request ledger

Three kinds of request move between the user, the Director, and a lead. Each is a row in `thread_requests` with an id such as `req-7`, and stays open until someone closes it.

| Kind | From → to | Opened with | Closed by | Outcomes |
| --- | --- | --- | --- | --- |
| `user_request` | Director → lead | `send_request` | The lead, with `triage_request` | `accepted`, `delegated`, `answered`, `declined` |
| `user_question` | Lead → user | `ask_user` | The Director, with `resolve_request` | `user_answered`, `withdrawn` |
| `routed_work` | Lead → Director | `route_to_director`, or a declined `user_request` | The Director, with `resolve_request` | `rescheduled`, `dropped` |

### A user message while work runs

1. The user tells the Director about a new requirement or asks a question about running work.
2. The Director forwards it to that goal's lead with `send_request`. A running lead is steered; a lead that has ended its turn is resumed with the request.
3. The lead decides it with `triage_request`:
   - `accept`: it belongs to the goal and the lead will do it. The lead amends its plan.
   - `delegate`: it belongs to the goal and a child task takes it.
   - `answer`: it is a question. The Director is woken and relays the answer.
   - `decline`: it is outside the goal, or would put the goal at risk. The request becomes `routed_work`, and the Director is woken to place it.
4. An untriaged request keeps the lead's turn open (see the turn-end check).

`goal_amend` remains the tool for changing what done means (the acceptance criteria). `steer_run` and `steer_task` remain for plain guidance that needs no decision.

### Work outside the goal

A lead that is asked for, or finds, work outside its goal does not do it and does not drop it. Declining a request or calling `route_to_director` creates `routed_work`. The Director creates a goal for it, sends it to a goal it fits, or asks the user, and then closes it with `resolve_request`.

### Questions for the user

1. A lead calls `ask_user`. Its task keeps running on work that does not depend on the answer.
2. The Director is woken with the question and asks the user.
3. The harness appends every unanswered question to each reply the Director sends the user, under `Waiting on you:`. This does not depend on the model remembering to ask again. Blocking escalations addressed to the human are listed the same way.
4. When the user answers, the Director calls `resolve_request` with `user_answered`. The harness delivers the answer to the lead: steered if it is running, resumed with the answer if it had stopped to wait.

Every Director turn starts with the open requests of its chat: what waits on the user, what was routed back, and what is forwarded and not yet triaged.

## What was taken from Amp, and what differs

The wording of the lead and Director prompts follows Amp's where it fits: do the work yourself by default and delegate for parallel independent work or to keep large output out of context; brief a child as a capable colleague who has not seen the thread; a child's conclusion is a report to assess, not proof; a blocker pauses only the work that depends on it; and the four-part report (Result, Not done, Where, Next).

`pi-harness` differs where Amp relies on the model alone:

- **A turn that ends is checked against observed state.** Amp has no built-in loop that restarts a turn that ended early; its `/goal` example plugin judges completion from the agent's last message. The turn-end check reads the plan, the ledger, the task tree, git, and the reported criteria.
- **The plan survives context loss.** It is stored and shown again, instead of living only in a compaction summary.
- **Unanswered questions are re-asked by the harness**, on every reply to the user, until they are closed.
- **Out-of-scope work is a tracked record**, not a sentence in a report: it stays open until the Director reschedules or drops it.
- **Goals are contracts.** Deterministic gates and the independent Done-Review still decide whether a goal is achieved, after the lead says it is.

## Not changed by this model

- Goal contracts, gates, the Done-Review, and the review budgets.
- Context rollover for lead and Worker threads at `rollover.orchestratorThreshold` and `rollover.workerThreshold`. A rollover now hydrates the plan and the open requests as well as the anchored handoff.
- Worker write scopes and leases, the merge queue, and worktree limits. A lead's own worktree does not take a Worker slot and holds no write lease, so a lead that edits files it also assigned to a Worker finds out at merge time.
