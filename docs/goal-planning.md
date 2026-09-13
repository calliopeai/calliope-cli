# Goal planning and approval

`calliope orchestrate` asks a read-only planner to propose a bounded task graph.
Calliope validates its structure, provenance, scopes and remaining allowance;
execution requires human approval of the exact proposal hash. Workers then use
the [coordinator](coordinator-execution.md), shared runtime and normal tool policy.
Use [mixed-model teams](mixed-model-teams.md) for independent planner, reviewer
and worker choices, bounded attempts and the live workflow HUD. Add
[`--supervise`](continuous-supervision.md#start-from-a-goal) with a pinned local
verification image for an isolated work → verify → review → retry/replan loop.

```sh
calliope orchestrate "Inspect the parser and propose a focused fix" \
  --tokens 1000000 --cost 1 --time-ms 1800000 --json
# Exit 5: inspect the returned proposal, especially its acceptance checks.
calliope orchestrate proposal GOAL_ID --json
calliope orchestrate approve GOAL_ID PROPOSAL_HASH --allow-mutations --json
calliope orchestrate status GOAL_ID --json
calliope orchestrate replay GOAL_ID --json
calliope orchestrate list --json
calliope orchestrate resume GOAL_ID --allow-mutations --json
calliope orchestrate cancel GOAL_ID --json
calliope orchestrate revise GOAL_ID reviewed-plan.json --json
```

`/orchestrate <goal>` in the REPL prints the complete proposed plan and presents
the approval dialog before execution. The same status, proposal, replay, list,
approve, revise, resume and cancel subcommands work there. Starting work occupies
the active turn; cancellation and read-only inspection remain available. Headless
planning always stops at review. Use `plan <goal>` or `-- <goal>` when a goal starts
with a reserved command word. Arguments are literal; shell substitutions in REPL
arguments are never evaluated.

Approval of a proposal grants no automatic file access. Headless writes need
`--allow-mutations` on approval/resume, an embedding callback or a matching saved
file grant. The flag authorizes policy-permitted file operations during that
invocation within the reviewed scopes. REPL writes use their separate normal
approval dialogs. Project policy still applies to planning, review, recovery,
execution and control operations. Plan mode denies these mutations of run state.

## One budget and clock

Defaults are operator limits, not model capabilities or estimated prices:

| Limit | Default | Flag |
|---|---:|---|
| Total tokens | 1,000,000, lowered by configured per-run caps | `--tokens` |
| Total dollars | $1, lowered by configured per-run caps | `--cost` |
| Total time | 30 minutes | `--time-ms` |
| Planning tokens | At most one quarter of total, capped at 250,000 | `--planning-tokens` |
| Planning dollars | One quarter of total | `--planning-cost` |
| Planning time | At most two minutes within the original clock | `--planning-time-ms` |
| Output per request | At most 8,192 tokens within planning allowance | `--max-output-tokens` |
| Agents / tasks / depth / concurrency | 16 / 64 / 3 / 2 | `--max-agents`, `--max-tasks`, `--max-depth`, `--max-concurrent` |

Costs accept plain decimal USD with up to nine fractional digits. The stored
money unit is integer nanodollars. `--provider` and `--model` capture an explicit
preference; otherwise the existing preference chain applies. An `auto` root in
the proposed plan inherits the captured goal preference. Explicit choices in
the proposal remain visible for review. Models, capabilities, capacity and
prices still require live discovery before provider admission.

Repeat `--read-path` and/or `--write-path` to constrain project-relative scope.
Without these flags the goal permits the project root, with read/list/think and
write/edit tools. The planner receives only the read portion. Without
`--supervise`, shell, network, custom tools and dynamic child creation are unavailable to these workers. Supervised goals add inherited shell authority
only for declared isolated executor checks; worker-selected shell remains
unavailable. The read-only planner never receives shell or mutation tools.

The private goal manifest fixes the project identity, scopes, preferences, total
allowance and absolute deadline before planning starts. One planner allocation
pins a run ID and plan hash before its run is created. Provider requests use the
existing [reservation ledger](agent-runtime.md); allocations are not synthetic
requests and do not count as observed usage. Planning input/output requests may
need substantially more than the expected completion because conservative
admission reserves the discovered input capacity plus requested output.

After planning, the ledger revision and charged spend are frozen, including
unknown requests. A reviewed execution plan must fit total allowance minus that
frozen spend. Atomic, revision-bound approval allocates at most one execution
run. Its tasks share the original clock, including time spent planning or
waiting for approval. Resuming never refreshes the deadline or resets spend.
The goal allocation, agent ancestor ledgers and project ledger all constrain
admission. A changed, missing, exceeded or damaged planning ledger denies
execution. Provider billing-bound certification remains a release requirement;
model metadata alone is not evidence of a contractual pricing upper bound.

## Evidence and schemas

Goal records live in `~/.calliope-cli/goals/GOAL_ID/` by default:

| Record | Version and purpose |
|---|---|
| `manifest.json` | v1: original identity, goal, run-store path, scopes, preferences, limits, deadline and SHA-256; v2 adds captured team settings; v3 adds captured isolation and supervision settings |
| `history.json` | v1: append-only logical event history and integrity hash |
| `proposals/HASH.json` | v1: immutable validated plan, plan hash, source and inference marker |
| `owner.json` | v1: process ownership lease, reclaimed only after confirmed process exit |
| Linked run `manifest.json` | v2: v1 run fields plus exact goal/allocation linkage |

A linked run uses `source.kind: "goal"`; its source path names a generated goal
artifact, not a claimed existing project file. Unlinked v1 run manifests retain
their original schema. Linked execution admission, including direct `run`
commands and task retry/acceptance, rechecks parent authority and the original
allocation. Copies moved to a different run store cannot acquire authority.

Every goal event has an immutable UUID, goal ID, sequence, timestamp, previous
hash, typed change and hash. Changes cover planning allocation/freeze, proposal
revision, execution allocation/start/finish/interruption and explicit
cancellation. An interruption records a reason without inventing a child result.
Completion requires the coordinator's recorded task evidence; planner prose
cannot establish it. A later explicit task acceptance may make the child run
newer than the goal journal; status reports expose both and derive their current
result from the bound child evidence without rewriting history on read.

Agent proposals retain the actual planner run, artifact ID, artifact-byte hash
and trusted source event. Human revisions retain the source file path and hash.
Preference inheritance can change the derived plan, whose separate hash covers
that normalization. All proposals keep `knowledgeStatus: "proposed"` and
`confidence: null`; model proposals also carry `inferred: true`. Execution
approval does not promote their statements to accepted project facts.

Goal records and run stores are private and must stay outside the worker project
root. Files are bounded and reject aliases. Retention permits 1,000 goals, 64
proposals/64 MiB per goal and 10,000 events/16 MiB per history, with space reserved
for terminal outcomes. Records are never silently discarded. Hash ancestry
detects corruption; it is not a cryptographic defense against the local account
owner rewriting all records. No OS containment is claimed for arbitrary host
code. Source files remain separate from generated proposals and artifacts.

## Recovery and machine output

Malformed or excessive model proposals freeze planning as failed. When spend is
known, `revise` accepts a policy-checked project plan without another model call.
It preserves total limits and invalidates the old approval hash. Execution must
not already be allocated; an explicitly cancelled goal cannot be revised.

A native Anthropic refusal stops planning with a fixed provider-refusal message
in the CLI and saved goal events. It does not authorize tools or create a proposal.
The request's usage evidence and conservative failure reservation are retained;
`resume` and `replay` inspect the frozen result without another planning request.
Review the request and provider policy before deciding how to proceed.

An interruption after allocation but before run creation resumes the same ID.
A partially written or damaged run fails closed: preserve its directory and
restore verified records instead of deleting evidence to obtain fresh budget.
Orphaned worker attempts remain unknown until explicitly reviewed and reset
through `run retry` or `agents retry`; request charges and retry limits persist.
See [coordinator recovery](coordinator-execution.md) for interrupted file changes.

Explicit goal cancellation revokes both planner and execution authority.
Its command reports `cancellation-requested`, since another process may still
be closing requests. Inspect the owner and linked task state to confirm cleanup.
An interrupt signal stops the active invocation; recorded failed/cancelled
attempts still need inspection before any bounded retry. Deadlines never restart.

NDJSON envelopes use `version: 1` and types `orchestration.goal.created`,
`orchestration.goal.event`, `orchestration.goal.run_event`,
`orchestration.goal.review`, `orchestration.goal.list`,
`orchestration.goal.cancelled` and `orchestration.goal`. Each includes `action`,
an available `goalId`, and `data`; failures instead contain `error.code/message`.
Run events retain their original IDs and schema inside the envelope. Read-only
commands exit 0 when inspection succeeds. Execution returns 0 complete, 4 partial,
5 review required, 3 policy/budget denial, 130 cancellation, 2 invalid input or
1 failure. Cancellation control exits 0 once its request is durably recorded.

Goal plans feed the coordinator. Opt-in [continuous supervision](continuous-supervision.md)
adds isolated verification and bounded automatic child admission; manual
[child admission](child-admission.md), [improvement cycles](improvement-cycles.md)
and the [project brain](project-brain.md) share its retained evidence. Remaining
release gates are tracked under #254.
