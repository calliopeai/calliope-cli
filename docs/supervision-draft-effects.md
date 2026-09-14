# Supervision draft effects

A reviewer receives optional `draftEffect` context version 1 whenever it receives
a controller draft. The effect is derived from the validated draft and current
reviewed graph; its `draftHash` matches the existing exact-draft verdict protocol.
It describes the action and grants no authority.

| Field | Meaning |
| --- | --- |
| `version` | `1` |
| `draftHash` | Canonical hash of the complete draft, including reason and evidence |
| `action` | Validated retry, replan, decompose, continue or stop |
| `retryTaskIds` | One existing task for retry/replan; otherwise empty |
| `newAgentIds`, `newTaskIds` | Proposed child additions for decompose; otherwise empty |
| `maxConcurrent` | Unchanged scheduler limit from the current reviewed plan |
| `summary` | Structural effect and relevant scheduling limits |

A replan of task A does not queue a retry of task B merely because its strategy
mentions doing B later. The strategy guides A's next attempt. Other ready tasks
remain subject to ordinary dependency, conflict and concurrency checks; this
summary does not promise which task runs first or what the model will do.

Agent/task count limits constrain new admissions. Exhausting that capacity does
not by itself forbid retrying an existing task. The separate executor availability
snapshot reports preliminary retry constraints. Current permissions, scope,
remaining budgets, attempts, deadlines and verified cleanup still govern actual
execution. Decomposition needs its original child grant and checks.

This context helps an independent reviewer assess the exact action. It cannot
force approval, override rejection or turn missing evidence into success.
Malformed drafts, invented evidence and unknown targets fail existing contract
validation. A revised verdict still carries a complete independently validated
decision. Controller contexts without a draft omit this field.

The outer context remains version 1; persisted decision/event/headless schemas,
legacy plan hashes and execution authority are unchanged. Replay consumes the
original decisions and does not recompute or authorize actions from this summary.

The motivating native experiment admitted a child and collected its failed test,
but its reviewer incorrectly interpreted a single-child replan as simultaneous
work and exhausted agent capacity. That rejection remains a failed native result;
local regression tests are not evidence that a future provider will approve it.
