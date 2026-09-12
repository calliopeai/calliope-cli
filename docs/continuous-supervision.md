# Continuous controller supervision

Version 4 reviewed plans add a controller at execution barriers. Independent
workers run under the existing scheduler; once their current batch has settled,
the controller receives recorded outcomes, acceptance checks, immutable patch and
test artifacts, remaining accounting and the operator's optimization principle.
An optional second model reviews its draft before any decision takes effect.
Worker, controller and reviewer choices use the existing agent preferences and
live discovery. Each uses its original account, allowance and absolute deadline.

## Reviewed contract

Start with an isolated version 3 plan, set `version` to `4`, and add:

```json
{
  "supervision": {
    "version": 1,
    "controllerId": "coordinator",
    "reviewerId": "reviewer",
    "maxRounds": 4,
    "maxStalledRounds": 2,
    "maxOutputTokens": 1024,
    "principle": "robustness",
    "allowedActions": ["retry", "replan", "decompose"]
  }
}
```

`controllerId` must name the root coordinator. `reviewerId` is optional and must
name a distinct existing agent. Both read scopes must cover task artifact paths.
Their tools remain unavailable during review turns, even when the accounts also
own worker tasks with write permission. Worker candidates use retained Git
worktrees and the plan's pinned local Docker image and declared command checks.
No image is pulled automatically.

Principles are `speed`, `robustness`, `stability`, `security`, `performance` and
`cost`. They guide proposed strategy; they do not change acceptance or policy.
Round limits are 1–64. A round counts when controller admission is recorded,
including a subsequent failed or interrupted model call. A stalled round means
the number of completed tasks has not increased since the previous review.
Explicit recovery never clears either counter. Output is capped at 8,192 tokens
and by each account's original allowance and the discovered model output limit.

```text
calliope run prepare plan.json
calliope run approve <run-id>
calliope run execute <run-id> --json
```

The equivalent `/run` commands work in the REPL. Plan approval and project tool
permissions remain separate: noninteractive mutations still require permission.
Existing goal-generated version 2 plans retain their prior behavior; this contract
can be supplied in a reviewed plan or through goal-plan revision when the original
goal scope already permits the required isolation and verification tools.

## Decisions and execution

Every decision has a reason and references task-outcome event IDs from its exact
review snapshot. The controller cannot establish completion itself. The executor
requires both final review and actual accepted or verified tasks.

| Decision | Executor behavior |
| --- | --- |
| `continue` | Schedule remaining ready work, or evaluate final acceptance. |
| `stop` | Preserve the run for human inspection. No completed result is claimed. |
| `retry` | Reset one eligible failed task within its remaining attempts. |
| `replan` | Also retain a task-specific strategy and supporting evidence for its next attempt. |
| `decompose` | Admit additional children through the existing scope, DAG and persistent budget-grant checks. |

Retry, replan and decomposition require a hypothesis and expected metric with an
increase/decrease direction. This records a proposed improvement, not proof that
the metric improved. Strategy is an overlay: it cannot rewrite original tasks,
acceptance criteria, provider preferences, scopes, budgets or deadlines. Added
children cannot replace or erase existing failed tasks. Their depth/count and
aggregate capacity must fit the original reviewed hierarchy.

Automatic retry of a possible mutation requires an isolated candidate, all tool
outcomes settled, a retained patch, and executor command receipts with confirmed
cleanup and unchanged verification inputs. Denied, cancelled, unknown, consumed
or exhausted attempts require operator recovery. Artifact hashes are checked
again immediately before applying a retry. Prior worktrees, outcomes, artifact
versions and request reservations remain retained.

Artifact excerpts are explicitly marked when truncated, with a maximum of 4 KiB
per artifact and 32 KiB total per review. Complete hashes and provenance remain
in the review. Context larger than 1 MiB is refused before inference. Every
controller/reviewer session preserves its messages, routing and accounting via
the shared runtime and run log.

## Restart and recovery

```text
calliope run status <run-id> --json
calliope run replay <run-id> --json
calliope run resume <run-id>
calliope run retry-controller <run-id>
calliope run resume <run-id>
```

Inspection and replay make no provider calls. Resume can consume an already
committed draft or apply an already committed decision without repeating the
preceding controller call. A child grant interrupted between reservation and
graph activation reuses its original proposal, allocation and event provenance.

An interrupted controller/reviewer call halts supervision. Resume first records
that interruption and settles coordinator ownership; `retry-controller` then
permits an explicit bounded recovery. Failed or unknown provider attempts keep
their charges. A saved decision whose application failed is retried locally;
otherwise recovery begins another controller round. Exhausted rounds, stalled
progress or expired deadlines do not receive fresh allowances through recovery.
An unavailable safe retry remains unavailable after repeated controller recovery.

## Journal and HUD

Legacy plan and execution events remain readable. Supervision changes use execution
event version 3: `supervision_started`, `supervision_decided`,
`supervision_applied`, `supervision_halted`, and `supervision_reset`. A supervised
execution projection has version 3 and a version 1 `supervision` state. The
existing version 2 headless envelopes remain unchanged and carry these versioned
events. Journal IDs, ancestry and hashes use the existing integrity checks.

The HUD shows the optimization principle, controller phase, round/limit and halt
reason alongside verified task counts. Active controller/reviewer rows are
prioritized with active workers. `/agents hud workflows` collapses the display
to one line per workflow; `/agents tree` and `/run status` expose full state.
Cancellation propagates to the active review call and retains its reservation.

This loop improves the strategy for the current reviewed run. Production-code
promotion, merge, publish, deployment, external communication and independent
self-improvement proposals remain subject to explicit human approval.
