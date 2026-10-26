# Reviewed task feedback

Hosts discover this interface explicitly through
`calliope improve host-capabilities --contract-version 2 --json` or the
`taskFeedbackCapabilities()` library API. Default/version-1 host discovery and
the existing execution capability contract retain their original shapes.

`recordTaskFeedback` records one native-policy-reviewed assessment of an exact
completed task attempt. It does not mark the task accepted, change a check,
allocate execution, award a numeric reward or activate a learned policy. A host's
claimed user/workflow identity is not independently authenticated by this API.
The trust boundary is the operator-owned native permission decision and store.

```ts
import {randomUUID} from 'node:crypto';
import {inspectTaskOutcome, recordTaskFeedback} from
  '@calliopelabs/cli/dist/improvement/index.js';

const selection = {taskId, attempt, executionRevision};
const observation = await inspectTaskOutcome(cwd, runId, selection, options);
const result = await recordTaskFeedback(cwd, runId, {
  version: 1,
  id: randomUUID(),
  selection,
  observationHash: observation.hash,
  assessment: {decision: 'accepted', reason: 'Reviewed against the requested result.'},
  references: [{kind: 'workflow', id: workflowId, revision: workflowHash}],
}, options);
```

The caller first presents the native observation and assessment for review.
The request binds its exact observation hash and execution revision. The shared
permission resolver applies plan-mode denial, hooks, policy and mutation
confirmation. Missing confirmation denies by default. An operator may explicitly
provide the usual native noninteractive permission options; request data cannot
set its own trust or approval. The writer checks current run approval, ownership,
revision, retained artifact bytes and accounting again before commit.

Requests accept only the versioned identity, assessment and optional declared
workflow/skill/policy references. Each reference has a bounded ID and immutable
revision hash. Unknown fields, including reward, cost, check results and trust
flags, are rejected. The native configuration hash identifies the actual task,
agent and applied strategy at that attempt, including prior strategy restoration
after withdrawal. Declared external references are reviewed metadata; they do not
prove the content of an external workflow or skill.

## Persistence and inspection

The receipt is a version-12 event in the existing private execution journal.
Its source includes the native run, manifest, plan, approval, configuration,
graph, task/start/session and attempt identities. Older journal readers that
cannot read version 12 must refuse it. The previous journal versions are unchanged.
At most 64 receipts can be retained in one run, inside the existing journal byte
limits. Preserve the run when that limit is reached.

Identical request IDs and payloads return the same receipt after rechecking
native permission. Changed payloads cannot reuse an ID. A lost acknowledgement
does not append another event, reset the original clock or alter reservations.

`taskFeedbackHistory(cwd, runId, options)` returns recorded receipt history, with
an explicit notice that its outcome evidence has not been revalidated.
`inspectTaskFeedback(cwd, runId, feedbackId, options)` reuses `inspectTaskOutcome`
to verify native evidence and derive current checks, duration and accounting.
An active coordinator or altered artifact refuses inspection. A later native
outcome change, including explicit task acceptance, marks the old assessment
`stale`. Late billing settlement updates the observed accounting without
rewriting the assessment or converting unknown costs to zero.

Both inspection APIs return `{data, redacted}`. Known credentials are rejected
on write. Read-time redaction also protects strings that later become configured
credentials; redacted display data is not a byte-for-byte copy of the retained
receipt. No raw worker prose, tool logs or artifact contents are imported into
the assessment record.

Cross-run learned strategy selection, training data admission, reward weighting,
baseline/held-out evaluation and candidate activation/withdrawal remain separate
work under #413. This receipt API does not claim those capabilities.
