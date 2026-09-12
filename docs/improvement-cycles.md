# Bounded improvement cycles

Version-4 [supervised runs](continuous-supervision.md) record each final `retry`,
`replan` or `decompose` decision as an improvement cycle. The controller optimizes
for the reviewed principle (`speed`, `robustness`, `stability`, `security`,
`performance` or `cost`), reviews executor evidence, and receives the latest four
cycles' measured outcomes. A reviewer, when configured, owns the final decision;
its controller draft is not a second improvement.

## Controls

```sh
calliope improve history --run RUN_ID --json
calliope improve propose --run RUN_ID --allow-mutations --json
calliope improve run CYCLE_ID --run RUN_ID --approve PROPOSAL_HASH --allow-mutations --json
calliope improve rollback CYCLE_ID --run RUN_ID --allow-mutations --json
```

The REPL exposes the same arguments under `/improve`. Without a subcommand it
shows history; without `--run` it inspects the latest run in the active project.
Headless mutations require `--allow-mutations` or an approval callback, and still
pass project policy. REPL approvals use the existing scope preview and audit log.

`propose` reviews an inactive supervised run's retained outcomes, or returns its
existing pending proposal without another model call. Explicit recovery of a
halted controller retains its original rounds, task attempts, reservations and
deadline. It starts no workers and applies no proposed changes. It needs recorded
outcomes and remaining controller authority; a completed run or a `continue` or
`stop` decision can produce no improvement proposal. Inspect that decision before
resuming ordinary execution.

A recorded proposal hold survives restart. `run` requires its exact review hash;
ordinary `run resume` cannot bypass that hold. Approval is recorded in the same
execution journal before application, and checked again under coordinator
ownership. All subsequent decisions remain subject to the original reviewed
supervision policy. To inspect and retire a strategy, stop the coordinator first.

`rollback` **withdraws the execution strategy**. For a replan it restores the
previous unwithdrawn applied strategy; for decomposition it stops the admitted
child agents and their descendants. It stops controller continuation and preserves
the task graph, allocations, attempts, checks, candidate worktrees and artifacts.
It does not apply an inverse patch to source: this loop edits isolated candidates,
and never automatically applies them to the source checkout. Inspect the retained
base commit and patch artifacts to compare or recover a candidate. A different
pending decision must be resolved before withdrawing an older cycle. Withdrawing
an expired cycle is allowed because it reduces authority; it cannot revive the
clock or refund spend.

## Evidence and schema

History is a deterministic projection of the existing private, hash-chained
execution journal, not a second mutable database. Each `ImprovementCycle` has
`version: 1` and an immutable ID equal to the final decision event ID. It includes:

- Trigger event IDs/hashes, principle, proposed hypothesis/change/metric.
- Parent decomposition and previous attempt links, target tasks, original run
  deadline and limits, scoped worker/controller/reviewer accounts and ancestors.
- Review hold, explicit approval, application and withdrawal event references;
  original plan approval and separate production approval (`not-approved`).
- Baseline and direct next-attempt outcomes, checks, artifact hashes, observed
  duration/tool results, unresolved risks, isolation image and rollback references.
- Original manifest hash and the inspected execution revision.

Inspection validates journal ancestry, current artifact read permissions, retained
artifact bytes and the pinned worktree base. Evidence reads are bounded to 64 MiB
per inspection; histories retain the execution store's existing event/size bounds.
No inspection calls a model or replays a tool. Recorded run replay reproduces the
same cycles without execution. Keep history private: task evidence can contain
project information even though API keys are not part of the cycle contract.

A cycle measures its **direct next attempts**. If a decomposed child fails and a
nested replan fixes it, the parent cycle retains that first failed result and the
nested cycle records the verified retry. This preserves the failure instead of
retroactively claiming every experiment succeeded. `verified` means the recorded
targets completed their acceptance process, not that every optimization claim was
proved. Human acceptance remains distinguishable by its source event.

## Measurements and limitations

| Measurement | Definition | Comparison requirement |
|---|---|---|
| `acceptance-check-pass-rate` | Passed recorded acceptance checks / all recorded checks | Same tasks and check definitions |
| `attempt-duration` | Sum of task-start to task-finish event durations, milliseconds | Same complete task population |
| `tool-failure-rate` | Failed completed tool calls / completed tool calls | Same complete task population |

Missing measurements are `null`, never zero. New task populations and changed
check definitions are explicitly non-comparable. These observations do not prove
causality or provide an automatic security/performance certification. Requested
metrics remain proposed even when checks pass. The duration is summed task time,
not workflow wall time; acceptance checks are not the individual assertions inside
a test process. Per-cycle provider cost is unavailable without trustworthy request
attribution; the shared run/project ledgers continue enforcing actual reservations.

The HUD adds the latest cycle's status and comparable check rate. Headless output
uses `version: 1`, `type: improvement` for results and `type: improvement.event`
for streamed execution events; enclosed events keep their own schema version.
Execution exit codes remain 0 success, 4 partial, 3 policy denial, 130 cancellation
and 1 failure; malformed command arguments exit 2. History is local-only JSON and
can be redirected for diagnostics. There is no import of execution authority.

## Safety and recovery

The loop cannot edit permissions, expand budgets/depth/count, reset deadlines,
erase evidence, publish, merge, deploy or send external messages. Every file/tool
mutation uses the shared runtime gates; child admission rechecks inherited scope
and grants. All coding attempts use retained Git worktrees and reviewed isolated
verification. Unknown requests retain their reservation, and interrupted calls
require explicit recovery. A cancelled or denied experiment keeps its partial
results; a new run is not an automatic escape from its allowance.

This implements recursive, evidence-driven **task strategy improvement**. It does
not automatically patch Calliope itself, promote knowledge to accepted fact, or
provide the later project Brain/KG subsystem.
