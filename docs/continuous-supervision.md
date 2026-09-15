# Continuous controller supervision

Version 4 reviewed plans add a controller at execution barriers. Independent
workers run under the existing scheduler; once their current batch has settled,
the controller receives recorded outcomes, acceptance checks, immutable patch and
test artifacts, remaining accounting and the operator's optimization principle.
An optional second model reviews its draft before any decision takes effect.
Worker, controller and reviewer choices use the existing agent preferences and
live discovery. Each uses its original account, allowance and absolute deadline.

## Start from a goal

Use the same flags in the terminal REPL and headless CLI:

```text
calliope orchestrate "Fix the parser boundary case and verify its regression test" \
  --supervise --isolation-image sha256:<existing-local-Linux-image-ID> \
  --planner-provider <provider> --planner-model <discovered-ID> \
  --controller-provider <provider> --controller-model <discovered-ID> \
  --worker-provider <provider> --worker-model <discovered-ID> \
  --supervision-reviewer-provider <provider> --supervision-reviewer-model <discovered-ID> \
  --principle robustness --supervision-rounds 4 --supervision-stall-rounds 2 \
  --supervision-output-tokens 1024 --attempts 2 --cost 1 --json
```

The placeholders must be replaced with live-discovered model IDs and a pinned
local image ID, not a mutable image tag. Calliope checks that image with the local
Docker daemon before planning inference. It never pulls or runs it during
planning. Missing images leave an unallocated goal that can be resumed under its
original clock after the exact image is prepared. Image inspection is bounded to
five seconds, cancellable, and receives only PATH rather than provider credentials
or Docker remote-context environment.

`--supervise` opts into a version 3 goal manifest that captures isolated verification
and supervision settings before the read-only planner runs. The planner proposes
a version 4 execution plan; it cannot remove supervision, change the image or
principle, or widen the captured limits/actions. Every initial worker task needs
at least one declared isolated verification command and its executor acceptance
check. Controller and reviewer accounts are separate from worker tasks; the
reviewer is a read-only leaf. Review the proposed commands for meaningful coverage
of your goal: validation cannot establish that a model selected an adequate test.

The controller defaults to the captured planner preference. The execution
reviewer is optional and independent of `--reviewer-provider/model`, which still
selects a read-only **planning** reviewer. Selecting a planning reviewer does not
silently add a recurring execution reviewer. Explicit controller/reviewer model
flags require their matching provider flags. Optional `--controller-effort` and
`--supervision-reviewer-effort` use the native discovery restrictions below.
Supervision flags require `--supervise` when creating a goal, and cannot change an
existing goal during approval or resume.

Defaults are four rounds, two stalled rounds, 1,024 output tokens per review and
`robustness`, with retry, replan and decomposition allowed within the original
graph limits. With `--supervision-rounds 1`, the default stalled limit is one.
The proposed plan can narrow those bounds. Normal token, cost, task-attempt,
agent-count/depth, time and project-policy limits still apply to every role.

Headless planning stops at exit 5 with the complete proposal and hash:

```text
calliope orchestrate proposal <goal-id>
calliope orchestrate approve <goal-id> <proposal-hash> --allow-mutations --json
calliope orchestrate status <goal-id> --json
calliope orchestrate resume <goal-id> --allow-mutations --json
```

In the REPL, `/orchestrate` shows the same proposal before its approval dialog and
updates the existing per-workflow/per-agent HUD during execution. Tool permission
checks still apply separately to candidate edits and each exact verification
command. Candidates remain in retained worktrees; source-checkout promotion is a
separate human decision. Existing goal manifests and NDJSON envelopes remain
readable; goal output envelopes stay at version 1.

## Reviewed contract

For a manually authored plan, start with an isolated version 3 plan, set
`version` to `4`, and add:

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
Linked reviews also receive [whole-goal accounting](goal-accounting.md), including
planning costs. Its diagnostic headroom never replaces the active run's budget.
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
Existing goal-generated version 2 plans retain their prior behavior. Supervised
goal revisions must preserve the captured isolation and supervision authority;
explicit human per-agent model choices remain visible in the new proposal hash.

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

Older isolated output cutoffs without receipts can use
`run recover-evidence <run-id> <task-id> --allow-mutations` before controller
recovery. It appends actual verification of the retained candidate and invalidates
the stale decision, preserving round/attempt counts and the original clock.
See [evidence recovery](isolated-workers.md#evidence-and-recovery) for eligibility
and interruption limits. New output cutoffs collect that evidence immediately
while authority remains; their incomplete reports still cannot complete a task.

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

### Small controller reviews

The version 1 controller context is a deterministic derived view: full acceptance
criteria, tool/path scopes, limits, retry authority, original deadlines and check
hashes remain present. It replaces duplicate task outputs with event/hash
references, omits text inputs and worker prose over 512 bytes with explicit
byte/hash references, and bounds artifact excerpts to 512 bytes. Original plans,
outputs and artifacts remain intact. Controller command summaries validate the
executor-owned receipt against the reviewed argv/image and retain exit status,
cleanup and before/after workspace hashes; raw logs remain in the artifact.
Worker retry feedback still reads the original evidence. A controller must stop
if omitted evidence is needed to decide safely. The 1 MiB context and 32 KiB
evidence limits still apply; the formatter never drops acceptance or authority
to make a large graph fit. A `controller-context` policy event records context
version, size, hash, plan hash, role, round and chosen effort.

`continue` and `stop` are always available. `allowedActions` adds optional retry,
replan and decomposition permissions; it does not disable those two safe decisions.
Only permitted optional action shapes appear in the controller instructions.

The availability snapshot includes `retryCapacity` separately from
`remainingCapacity`. Its `available` count is the number of existing tasks whose
recorded evidence permits a retry or replan under the current policy. Retrying an
existing task does not consume agent/task admission capacity and creates no child;
the exact task's `retryTasks` entry remains authoritative for its evidence and
reason. The field is descriptive and grants no authority.

A reviewed supervision policy can explicitly choose reasoning effort by role:

```json
"reasoningEffort": { "controller": "low", "reviewer": "high" }
```

A reviewer effort requires a separate reviewed reviewer account. This setting is
optional and hash-bound to the approved plan; existing defaults remain intact.
For now the explicit control is supported by native Anthropic only. Routing must
have fresh positive discovery evidence for that exact model and effort level;
missing, stale, unsupported or incompatible evidence stops before inference.
The adapter rechecks support after asynchronous admission. Counted admission
includes the same `output_config.effort` in free counting, request hashing and
paid dispatch, including retries. Effort changes invalidate a previous count.
Routing records explain the selected effort. Other adapters reject this explicit
setting rather than ignoring it.

Effort is a behavioral preference, not a token limit: lower effort may reduce
reasoning quality. Keep `maxOutputTokens` and all run/agent budgets explicit;
truncated decisions remain failed reviews requiring explicit recovery. API
contracts: [effort](https://platform.claude.com/docs/en/build-with-claude/effort),
[live model capabilities](https://platform.claude.com/docs/en/api/typescript/models),
and [token counting](https://platform.claude.com/docs/en/api/http/messages/count_tokens).
