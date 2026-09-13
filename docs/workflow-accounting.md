# Workflow budget visibility

The workflow HUD and `run status|replay --json` show a version-1 accounting
snapshot from the run's existing reservation ledger. Execution results include
the same `accounting` field. Existing headless envelope and execution event
versions remain unchanged. This feature does not change model selection or
request admission; Smart routing remains an explicit mode.

The HUD shows accounted dollars against the limit, remaining tokens and counts
of pending and unknown requests. Agent rows show their remaining recorded
allowances; parent balances include their descendants and are labelled `subtree`.
Do not sum ancestor rows: a child request is charged once to the run and once to
each ancestor's shared allowance. Budget changes refresh rows even while a model
request is waiting and no new task event has arrived.

## Snapshot schema

Available accounting includes:

- `version: 1`, `status: available`, `basis: reservations-and-settlements`.
- The immutable ledger `revision` and independently inspected `executionRevision`.
- `exceeded`, indicating a recorded reservation violation.
- `run` and `accounts`, keyed by agent ID, including admitted child grants.
- Each balance's `limit`, `accounted`, `remaining` (tokens and integer nano-dollars),
  original absolute `deadline`, and `requests` counts by `pending`, `settled`,
  `unknown`, and `exceeded` state.

The snapshots are read independently; their revisions identify the observed
records, not a cross-journal atomic transaction. Pending child grants can appear
before graph activation. Their presence does not authorize execution.

`accounted` includes pre-dispatch reservations. Successful requests with valid
usage settle at the ledger's reviewed rates; failed, cancelled, unfinished or
otherwise unknown requests retain conservative charges. Overruns retain at least
the reserved amount and mark the ledger exceeded. Remaining balances clamp to
zero rather than becoming negative. These figures are not invoices or proof of
actual provider billing.

A positive recorded balance is not guaranteed request admission. Current project
policy, ancestor limits, protected child allocations, deadlines, discovered
capabilities and the next request's full quote still apply. Planning and execution
remain separate runs with their existing shared goal allowance; this snapshot
does not combine them or the external provider-validation ledger.

Unavailable accounting has only `version`, `status: unavailable` and a fixed
remediation `reason`. A missing, damaged, mismatched or unreadable ledger is never
reported as zero. Status and stop controls remain available where execution
history itself can be read; an unavailable balance does not grant new authority.

Inspection and replay perform no inference, settlement, reservation, repair or
ledger creation. Repeated inspection reproduces the same balances until the
underlying ledger changes, including after cancellation or restart. No prompts,
tool arguments, provider endpoints, credentials or billing-profile records are
included in the snapshot. Historical execution replay displays the currently
recorded ledger revision, not a fabricated per-event spending timeline.
