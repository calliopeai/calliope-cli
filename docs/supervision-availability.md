# Executor availability in controller reviews

Controller and reviewer context includes a version-1 `availability` snapshot of
the current execution revision and observation time. It reports retry/replan
preconditions for each task and candidate child-parent preconditions for each
agent. A stopped or escalated ancestor blocks both automatic retry and child
admission below it. Original deadlines, allowed actions, task status, consumed or
exhausted attempts, uncertain mutations, direct child counts and remaining graph
count/depth capacity are visible before the model chooses its next action.

The snapshot also includes `retryCapacity`, which counts existing tasks whose
recorded evidence permits a retry or replan. This is independent of
`remainingCapacity.agents` and `.tasks`: retrying an existing task consumes no
child-admission slot and creates no agent or task. The task-level `retryTasks`
entry remains authoritative for the exact evidence and reason.

The snapshot reuses the executor's stopped-agent and supervised-retry checks.
It is derived from validated plans and recorded execution state, without model
calls, writes, new grants or clock resets. A graph revision mismatch is rejected.
The current graph is used consistently for review context, improvement feedback
and decision validation, including children already admitted during the run.

`blocked` names a failed preliminary check. `possible` means those checks passed;
it is not permission to execute. Actual application still verifies ownership,
current project policy, exact child contracts, scopes and dependencies, retained
artifact bytes and process cleanup, budgets, pending grants and original clocks.
A snapshot can become stale while a provider responds. Neither a controller
proposal nor a reviewer approval can bypass these application checks.

Both roles are instructed to revise or stop when their proposed action is
blocked. A denied parent does not authorize moving its work to a different agent
to evade the denial. This is guidance using executor facts, not a guarantee that
a model will choose a valid action. The executor still refuses invalid actions.

The context's existing byte limit and hash audit cover the nested snapshot.
Exact contexts remain in private sessions; no conversation or secret material
is copied into this summary. Existing journal and headless envelope versions are
unchanged, and historical contexts without availability retain their original
meaning. Inspection never retroactively changes an earlier failed run or verdict.
Smart routing remains opt-in and explicit model/provider choices retain priority.

This addresses the failed-parent proposal observed in the
[native supervision study](reports/native-supervision-2026-09-14.json). That study
still does not prove native child admission or nested recovery. Local SDK tests
and offline inspection of its original journals validate the context behavior;
no new paid inference is needed to establish these deterministic properties.

The [offline inspection receipt](evidence/supervision-availability-smoke.json)
binds both role snapshots to their original execution events and archived native
evidence. It records derived availability separately from the original requests.
