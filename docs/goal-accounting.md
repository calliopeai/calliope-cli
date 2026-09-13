# Whole-goal accounting and verified task costs

`calliope orchestrate status <goal-id> --json` includes `accounting` for the
complete goal: its planning run plus its execution run, including retries,
controller/reviewer requests and admitted children. The workflow HUD and controller
review context carry the same numeric projection. Smart routing remains opt-in;
these observations do not select models or change execution authority.

For a final artifact-backed measurement, use:

```sh
calliope orchestrate metrics <goal-id> --json
# REPL: /orchestrate metrics <goal-id>
```

The command reads recorded evidence under current project policy. It performs no
inference, tool replay, test reproduction, reservation, settlement or journal
repair. Permission decisions use the existing audit mechanism. Source artifacts
and goal/run/budget journals are not changed.

## Accounting schema

`GoalAccounting` version 1 is a derived projection, not a new journal format.
Existing goal envelopes retain version 1 and historical manifest/event hashes
remain unchanged. Available and partial projections include:

- Goal ID, manifest hash, goal revision, combined observation revision and the
  original absolute deadline and token/nano-dollar limits.
- `phases.planning` and `phases.execution`: `not-allocated` (known zero),
  `unavailable` (allocated evidence missing or inconsistent), or `available`.
- Available phases identify their allocation, run/plan hashes, budget and execution
  revisions, accounted charges, request-state counts, closure, unresolved child
  grants and `usageComplete`.
- `knownCharges` sums readable phases. `accounted` and `remaining` are null when
  any allocated phase is unavailable. A fully available projection sums each run
  once; it never adds ancestor balances or allocated capacity to actual charges.
- `remaining` is clamped arithmetic goal headroom. It is **not spendable execution
  authority**: original run/ancestor limits, child reservations, current policy,
  deadlines and the next request quote still govern admission.

The reader validates allocation identity, original budget contract and clock,
child-admission evidence and the recorded frozen planning balance. A stale or
inconsistent goal yields a fixed unavailable result. Missing files are never
created or reported as free usage. Independent journal revisions identify the
observations; they do not imply a cross-journal atomic transaction.

Charges follow the existing reservation ledger: valid successful usage settles
at recorded rates; failed, cancelled or unknown requests retain conservative
reservations; exceeded reservations retain the recorded overrun. `usageComplete`
requires closed phases without pending, unknown or exceeded requests or pending
child grants. An unallocated phase has no usage to resolve. These are accounting
observations, not provider invoices or external conformance-harness charges.

## Metrics schema and interpretation

The headless envelope has `version: 1`, `type: orchestration.goal.metrics`,
`action: metrics` and `data` with `version: 1`, `kind: goal.metrics`:

| Field | Meaning |
| --- | --- |
| `accounting` | Complete goal accounting, including planning and every review/retry |
| `tasks` | Final graph population, mechanically verified, human accepted, unverified and success ratio |
| `attempts` | Recorded starts and finished/failed/cancelled/denied/unknown outcomes |
| `checks` | Recorded acceptance-check passes and total across all attempts, not individual test assertions |
| `recovery` | Mean recorded time from first failed outcome to later mechanical completion for the same task; repeated failures share an episode |
| `evidence` | Inspection status, immutable artifact event IDs and checked bytes |
| `costPerVerifiedTask` | Whole-goal nano-dollar numerator, verified task denominator, ratio or null, and reason |

Only currently completed, mechanically verified tasks with intact final artifact
bytes enter the denominator. Human acceptance is counted separately. Reads use
current source permissions, bounded private files and the existing verification
receipt checks. A second snapshot check detects changes to earlier-read artifacts.
The cap is 64 MiB of unique evidence; the final check can read those bytes again.
Cancellation is checked between reads; inherited per-file limits still apply.

The ratio is null if usage is unresolved, execution is active, no task qualifies,
evidence is unavailable, or goal/budget/execution revisions change during the
inspection. A changed artifact also makes the success ratio unavailable. Policy
denial and cancellation retain their normal exit codes (3 and 130). An unavailable
diagnostic result itself exits 0; automation must inspect status and nullable
values. With unchanged records, restart/replay yields the same measurements.

Recovery describes recorded outcomes; human acceptance does not close a mechanical
recovery episode. Final artifact verification does not rerun tests or prove all
historical test claims. Decomposition changes the task population, and a task can
be much larger than another task. These metrics therefore do not establish causal
improvement or make different goals comparable. Cross-run routing learning and
provider-invoice reconciliation are separate work.
