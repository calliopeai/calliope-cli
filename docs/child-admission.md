# Bounded child admission

`calliope agents spawn children.json --run RUN_ID --json` inspects a project-local
proposal and returns review-required exit code 5. The file contains version 1,
`parentId`, `agents` (full existing agent contracts), and `tasks` (existing task
contracts). Every new task belongs to a new agent, and every new agent descends
from the named parent. New tasks may depend on existing tasks. Version 2 runs
require the same acceptance checks for new tasks as for their original tasks.

```sh
calliope agents spawn children.json --run RUN_ID --dry-run --json
calliope agents spawn children.json --run RUN_ID --approve PROPOSAL_HASH --json
calliope agents spawn --resume PROPOSAL_HASH --run RUN_ID --json
calliope agents --tree --run RUN_ID
calliope tasks --graph --run RUN_ID
calliope agents stop CHILD_ID --run RUN_ID
calliope agents retry CHILD_ID --run RUN_ID
```

The run must already have execution history and an active approval. Preview does
not create a budget, advance the clock, or start a provider request. `--dry-run`
refuses executable policy/hooks; normal reads pass current policy. An approval
names the exact proposal hash and rechecks its source bytes and graph revision.
The REPL displays the proposal and requires approval once even with confirmation
mode off. `/agents spawn` can join an active turn; at most one such command may
join, and cancellation and replacement wait for its cleanup.

`--allow-mutations` permits policy-approved worker file mutations during that
invocation; it does not approve the proposal or change a coordinator already
running in another process. Without it, worker mutations retain normal safe
defaults and saved-grant checks. Live model discovery and provider routing remain
mandatory. Agents cannot call the admission API through a worker tool.

No original contract, task, preference, scope, acceptance criterion, run limit or
completed evidence is edited. The original plan's maximum agents/tasks, depth,
direct child count, concurrency, token and dollar limits still apply. Per-proposal
limits are 16 agents, 64 tasks, and 64 KiB; budget grants are at most 32 KiB.
Child deadlines are measured from the original execution start, including time
spent waiting for approval. A completed or revoked run, a stopped/escalated parent,
or an expired parent/child deadline prevents admission.

The ledger records a child grant as authority, separately from provider usage.
After admission, a parent's own charged work plus its direct children's total
allowances must fit its allowance. Children therefore retain their remaining
capacity; parents cannot borrow it. Pending and unknown provider requests count
as charged work. Legacy runs without a grant retain their prior charging rules.
Scope inheritance and charges continue through every ancestor. A grant never
resets project spending, run spending, unknown charges, retry counts or deadlines.

## Transaction and recovery decision

The immutable original run and budget manifests remain unchanged. A proposal
binds their hashes, the approval revision, source byte hash, previous graph hash
and resulting graph hash. The grant ID is deterministically derived from the
proposal hash. Under the execution writer lock, admission saves the reviewed
proposal privately, appends the grant under the budget writer lock, then appends
a `graph_admitted` execution event containing that exact recorded grant. No human
approval runs while either writer lock is held. Execution finish uses the same
writer lock so it cannot skip a concurrently admitted child.

A crash after the grant commits can leave it pending without an admitted graph.
The grant stays reserved; the run cannot complete while it is pending. Recover
with `agents spawn --resume PROPOSAL_HASH --run RUN_ID`. Recovery reads the saved
reviewed proposal, checks current policy and the original authority, and reuses
the exact grant. It does not need the source file to remain present. A repeated
successful admission is idempotent. Other proposals cannot pass an unactivated
grant. Failed recovery preserves evidence; it never invents a replacement budget.

The scheduler checks for graph changes while existing workers run, respects
dependencies and conflicting path scopes, and collects and verifies child
artifacts through the same pipeline. Child execution commands wait for actual
task outcomes. If a coordinator owns the run, they observe it; otherwise they
resume under normal exclusive ownership. Interrupted attempts remain unknown
until an explicit bounded retry. Cancelling a command attached to another
coordinator stops its admitted child roots and waits for observed cleanup while
that coordinator remains alive and within its deadline.

## Schemas and evidence

Budget child-grant events and execution graph-admission events use version 2;
their projections upgrade only when a grant is present. Ordinary events and
immutable manifests keep their existing versions. Replay derives the current
graph from the original plan plus ordered admissions. Runtime admission checks
each execution admission against the corresponding ledger event, including its
event ID/hash, proposal, original approval and manifest binding.

The spawn command emits version-1 envelopes `{version,type,data}` with types
`orchestration.spawn.review`, `.admitted`, `.event`, `.result` and `.error`.
The admitted report is not a successful task result. Final result exit codes are
0 verified/accepted children, 4 partial work, 3 policy/budget denial, 130
cancellation, 1 failure, and 2 malformed arguments. Review-only returns 5;
successful dry-run returns 0. Execution events retain their immutable IDs so
consumers can identify events observed through both coordinator and spawn streams.

Reviewed proposals live in `execution/spawn-proposals/HASH.json`, with private
permissions and at most 256 entries. Run/budget/proposal stores must be outside
the worker project, including symlink aliases. Hashes detect corruption but are
not signatures against an account owner who can rewrite every local record.
Shell, network, custom tools, merge/publish/deploy and external communication
remain outside worker authority. Automated model-initiated spawning is not enabled.

## Externally scheduled allowances

A trusted host can admit a version 2 proposal for work whose lifecycle belongs
outside the native coordinator, such as an Astrolift task. Discover
`DELEGATED_ADMISSION_CAPABILITY` from `spawning/index.js` before using this form:
`{version:1, proposalVersion:2, workspaceBinding:1, scheduling:'external'}`.

The proposal retains `parentId` and full reviewed `agents` contracts, requires
`tasks: []`, and adds:

```json
{
  "delegation": {
    "project": {"root": "/observed/worker/project", "key": "<native project identity SHA-256>"},
    "reference": "<external task identity>",
    "observationHash": "<SHA-256 of the owner's retained workspace observation>"
  }
}
```

The host must obtain and retain the observation from its authorized execution
backend, revalidate the task before credential delivery, and bind the proposal
to that exact evidence. The CLI binds this declaration to the approval and
native journal; it does not independently attest a remote cluster or schedule
that task. A digest alone is not evidence that a workspace was observed.

Use the same `agents spawn ... --dry-run` review and exact `--approve` hash.
Approval displays the external reference, root, project identity and observation
digest. Version 2 admits only budget accounts: no native task is added or
executed. `executeSpawn` and the command return `status: "delegated"`, not a
completed task result. Agent inputs must be text; the external executor owns
file/artifact preparation and outcome verification. Supervision cannot propose
external placement. A delegated account's descendants must also use reviewed
version 2 allowances, so a later local spawn cannot execute in the wrong project.

The original graph's scope, routing, child-count/depth and aggregate allowance
checks still apply. A version 2 native ledger grant carries the exact child
project. Parent-side filesystem checks apply only to local agents; the remote
CLI validates its actual canonical workspace identity and tool scope when it
connects, before inference. Wrong-workspace, revoked, stopped and expired
requests fail through the existing ledger gates. Admission recovery reuses the
original grant, evidence, budget and deadline.

Trusted hosts can preview an already observed version 2 input with
`inspectDelegatedSpawn(project, runId, input, options)`. Discover
`DELEGATED_HOST_PROPOSAL_CAPABILITY` first:
`{version:1, source:'delegation', review:'hash', scheduling:'external', hostAuthority:1}`.
This preview returns the same review envelope as a file proposal and writes
neither the project nor an allowance. Its `source.kind: "delegation"` records
the canonical input digest and a logical `delegation/DIGEST.json` identity;
that identity is not a path to read or write in the project. The complete input,
including the observed workspace and external task reference, remains in the
hash-approved proposal. `admitSpawn` still requires that exact hash, current
policy and the original parent authority, and saves the proposal privately under
the native writer lock. Recovery uses its saved hash and original grant. This
API does not attest the host's observation or authorize remote task creation.
Hosts pass `assertAuthority` in the preview/admission options to retain their own
connection and placement restrictions. Native admission rechecks this callback
inside the execution and budget writer locks, including after waiting for
another writer, so an approved proposal cannot outrun a revoked host connection.

`prepareReviewedLedger` now establishes an empty native execution history from
the existing budget's creation time and deadline when no coordinator has run.
This permits reviewed admission without launching local work. It does not
extend the allowance. Cancellation or completion of the owning native run
fences its delegated accounts; the external scheduler still owns stopping its
containers, collecting outcomes and reconciling retained charges. Token delivery,
transport and external task enrollment remain trusted-host responsibilities.
