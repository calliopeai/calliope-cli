# Coordinator execution

Calliope executes a reviewed agent/task graph through the shared runtime.
Independent tasks run concurrently; overlapping read/write scopes are serialized.
Workers cannot create children, expand authority, or declare their own work verified.
[Goal planning](goal-planning.md) supplies validated proposals for human approval.
[Child admission](child-admission.md) adds reviewed descendants within the original
contract. [Version 3 isolated plans](isolated-workers.md) add retained worker
worktrees and reviewed verification commands in required Docker containment.

## Commands and permissions

```sh
calliope run plan.json --dry-run --json
calliope run prepare plan.json --json
calliope run approve RUN_ID --json
calliope run execute RUN_ID --allow-mutations --max-output-tokens 512 --json
calliope run status RUN_ID --json
calliope agents --tree --run RUN_ID
calliope tasks --graph --run RUN_ID
calliope agents stop AGENT_ID --run RUN_ID
calliope agents retry AGENT_ID --run RUN_ID
calliope run retry RUN_ID TASK_ID
calliope run resume RUN_ID --allow-mutations --json
calliope run accept RUN_ID TASK_ID
calliope run cancel RUN_ID --json
calliope run replay RUN_ID --json
```

`calliope run plan.json` combines preparation, approval through current policy,
and execution. Read the plan and use dry-run to inspect its hierarchy, scopes and
budgets before invoking it. The equivalent `/run`, `/agents` and `/tasks` commands
work in the REPL. `run approve RUN_ID TASK_ID` is an alias for task acceptance;
without a task ID, it approves the plan. Approval of a plan grants no file access.

Headless file mutations require `--allow-mutations`, an embedding approval
callback, or a matching saved grant. The flag authorizes policy-permitted worker
file operations throughout that invocation within the reviewed scopes; it does
not override project policy. The REPL uses the normal once/session/project/deny
dialog. Plan mode and non-interactive safe defaults remain enforced. Execute,
retry, acceptance, stop and cancellation also pass the shared permission gates.
REPL cancellation signals all children and waits for cleanup before another turn.
Run cancellation and agent stop remain available during execution.
For version 3 plans, the flag also authorizes declared verification commands
under their required read-only mounts, network restriction and current policy.

The default per-request output cap is 1,024 tokens, further limited by live
discovery. This is an operator budget, not a model capability claim. Explicit
agent provider/model choices win; `auto` inherits the nearest ancestor choice,
then the normal project/global preference chain. Every selection is recorded in
the child session run log. Live capabilities, capacity and price metadata must
support bounded execution; missing evidence produces a visible failure/denial.
See [request reservations](agent-runtime.md) for price assumptions and unknown spend.

## Scheduling and acceptance

Version 1 plans remain readable and executable, but their prose criteria require
human acceptance. Version 2 requires an `acceptanceChecks` array on every task;
an empty array also leaves criteria for human review. Example check:

```json
{
  "id": "report-format",
  "artifactId": "report",
  "kind": "contains",
  "criteria": ["task:0", "agent:0"],
  "expected": "Required report heading"
}
```

`criteria` explicitly maps the reviewed check to zero-based task and assigned-agent
criteria. A check supports `exists` (no expected field), `contains` (literal UTF-8
text), `sha256` (expected hexadecimal digest), or `json` (expected JSON encoded as
a string, compared canonically). A task completes mechanically only when every
declared output is collected, every check passes, and every task/agent criterion
has a passing mapped check. These checks prove precisely their predicates:
an existence or substring check cannot establish arbitrary semantic correctness.
Review the mapping accordingly. Check IDs in `testEvidence` identify those
acceptance checks; they do not imply that a compiler or test suite ran.
Version 3 adds `command` checks backed by captured process results and unchanged
workspace content. Those checks certify the exact reviewed command and its exit.

Artifacts with project paths are read under current policy and bound to actual
bytes, SHA-256, run/task/agent IDs and a trusted source event ID. Inline outputs
must use the worker report schema below and are stored separately in the private
run directory. Model-supplied hashes, changed-file lists and test claims never
establish completion. Changed files come from successful executor events; a
possibly interrupted mutation remains explicitly uncertain. Source documents are
not overwritten by artifact collection.

```json
{
  "version": 1,
  "summary": "What the worker actually observed",
  "outputs": [{"id": "report", "content": "Public example report"}],
  "risks": []
}
```

Dependencies may consume completed or review-required outputs, with their status
visible in the run. Project artifacts require the consuming agent's read scope;
all inputs are rehashed before use. Collection is checked again synchronously at
the completion commit boundary. Missing/changed evidence fails the task. A human
may accept only a review-required task with all artifacts present and no failed
mechanical checks, after seeing criteria and evidence. Acceptance binds the
artifact-set hash and rechecks bytes before committing. This records a human
decision; it does not fabricate an additional machine test.

Retry attempts share the original run/ancestor budgets and absolute deadlines.
Each agent permits at most `maxRetries + 1` attempts per task. Automatic retry
requires a failed task with no possible mutation. Otherwise the declared
`onFailure` policy is recorded as an escalation: `stop` cancels the run; `parent`
or `human` exposes the decision and prevents further work in that agent subtree.
No parent policy is expanded automatically. Explicit task reset clears that
task's escalation; group retry resets eligible descendant tasks and manual stop
flags atomically. Retry is refused after an output has already been used by a
started dependent task. Cancellation/unknown outcomes never trigger automatic
mutation replay. SDK/shared transport retries remain separately bounded and each
provider attempt requires another reservation; a task retry does not reset spend.

Every worker request includes an executor-owned version-1 `attempt` descriptor:
the current number, `initial` or `retry` phase, reviewed maximum, current
`task_started` event ID and numbered prior start/outcome event pairs. A prior
attempt interrupted before an outcome has a null outcome ID and `unknown` status.
The descriptor is derived from the replayed journal after task start and rejected if it differs
from projected state. Workers must use it instead of inferring retry state from
task prose, files or prior model output. Detailed `previousAttempts` evidence is
present only on retries and carries the same event IDs. Evidence recovery can
append a corrected outcome without creating another attempt; in that case the
descriptor selects the last authoritative outcome before the next task start.
This context grants no additional attempts, tools, paths, budget or time.

## Event and output schemas

Execution commands emit newline-delimited JSON envelopes:

- `{version:2,type:"orchestration.event",runId,event}` for committed events.
- `{version:2,type:"orchestration.execution",action,data}` for reports.
- The same report envelope with `error:{code,message}` for command failures.

Execution results contain `version:2`, `type`, `runId`, `status`, `execution` and
`exitCode`. `execution` contains the immutable header, events and replayed state.
Existing events have version 1; child graph admissions use version 2. Each has a UUID `id`, `runId`, monotonic sequence/timestamp,
`previous` hash, typed `change`, and its own SHA-256. Changes include coordinator
start/finish, task start/finish/reset/acceptance, agent start/finish/stop/reset,
escalation, tool start/result, and collected artifact. Task output includes status,
summary, changed files, artifacts, check evidence, unresolved risks and next action.
Artifact confidence 1 denotes verified integrity/provenance, not semantic truth.

Exit codes: 0 all tasks accepted/verified; 4 partial evidence or incomplete work;
3 policy/budget denial; 130 cancellation; 1 failure; 2 malformed arguments.
Successful inspection/retry/acceptance commands return 0 for that operation;
inspect the reported run status to determine whether project work is complete.
Cancellation reports `cancellation-requested`; the final worker result follows
only after cleanup. A worker or storage failure is not reported as user cancellation.

Inactive preparation and dry-run retain version-1 reports. Inspection upgrades
to version 2 when execution history exists; existing headless conversation JSON
is unchanged. Replay validates and projects stored events without discovery,
inference or tools. Private project text may appear in execution JSON; store CI
artifacts with appropriate access controls.

## Persistence, recovery and threat boundary

Execution lives under `~/.calliope-cli/orchestration/RUN_ID/execution/`:
`history.json` is a version-1 logical append-only, hash-linked journal committed
with private temporary files, fsync and atomic rename. `artifacts/` stores
immutable UUID-named inline outputs. Permissions are 0700 directories and 0600
private files. Bounds are 10,000 events, 32 MiB history, 128 KiB per event,
1 MiB per artifact, 10,000 inline files/64 MiB combined, and 1 MiB dependency
content per task. Admission preserves journal space for active outcomes; no
retention operation silently erases evidence. Archive complete runs outside the
active store when capacity is reached.

An exclusive owner record prevents simultaneous coordinators. A live PID remains
authoritative even when its timer expires; a dead PID can be reclaimed under an
exclusive election lock. PID reuse conservatively blocks recovery. Short writer
locks serialize control commands and event batches. Private election/writer locks
with a confirmed dead PID can be reclaimed once per inode; `lock-recovery/` retains
the old lock as evidence. Live, reused, ambiguous, malformed or already claimed
locks fail closed. Recovery history is bounded to 64 claims per directory; an
interrupted recovery requires inspection. Never delete live locks or rewrite hashes.

Approval revision and project identity are pinned. An independent cancellation
command changes the approval journal; the coordinator observes it within its
100 ms polling interval and rechecks ownership/approval at provider/tool admission.
Signals propagate through child provider calls, tools and policy cleanup. The
parent does not return while its children are still running.

After interruption, inspect status, task sessions, files and budgets. `resume`
keeps the original run ID, approval and deadlines, and marks orphaned running
tasks unknown. It may execute untouched pending tasks, but never automatically
replays an unknown attempt. Use explicit retry only after inspection. Unknown
provider requests retain their full reservations. Revoked approval cannot be
silently refreshed on an existing execution; expired budgets cannot be reset by
resume. Preserve the original run and prepare a separately reviewed plan when
new authority is needed.

Every attempt has its own persistent child conversation and run log, with shared
runtime checkpoints and safety branches before risky changes. Protocol metadata
is preserved there. Retrying creates a fresh attempt session; it does not resend
an uncertain prior tool call. Hashes detect damage and inconsistent ancestry;
they are not signatures against a hostile account owner who can rewrite all
local files. Synchronous artifact checks cannot prevent later external edits.

Workers currently receive bounded file tools and safe reasoning tools. Shell,
network, git, configuration, plugin and custom execution stay unavailable until
matching containment exists. Trusted host policy/hook programs remain outside
the worker sandbox boundary. Merge, publish, deploy and external communication
are not coordinator powers. These limitations and real-provider certification
remain release work, alongside brain/KG and controlled improvement loops.
