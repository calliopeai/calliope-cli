# Mixed-model teams and workflow progress

Calliope AI lets you choose the models that plan, review and perform work independently, so a Fable overseer with Luna workers, an Astra controller with Opus workers, or a Fable/Astra planning pair are team configurations. A compact terminal HUD tracks bounded attempts and dependency graphs while recorded evidence, the original budget and human approval determine when work can advance.

Model names here describe operator intent, not a supported-model catalog. Select IDs
from `/provider <name>` and `/model list`; each executing agent still passes live
discovery, capability and budget admission. An unavailable explicit selection is
reported instead of silently replaced.

## Choose a team

```text
/orchestrate "Inspect the parser and propose a focused fix" --planner-provider <provider> --planner-model <discovered-id> --worker-provider <provider> --worker-model <discovered-id> --reviewer-provider <provider> --reviewer-model <discovered-id> --attempts 2 --cost 0.50
```

The same arguments work after `calliope orchestrate` in headless mode. Omit the
reviewer flags for a single planner. Omit a model flag to discover/select a
model for that role; worker/reviewer model flags require their matching provider
flag. `--provider` and `--model` are aliases for the planner/controller selection;
combining an alias with its corresponding `--planner-*` flag is an error.

| Selection | Responsibility |
|---|---|
| Planner/controller | Propose the graph; execute tasks assigned to the graph's root coordinator |
| Reviewer, optional | Read the recorded draft and produce the final proposed graph plus a review artifact |
| Workers | Default provider/model for non-root agents in the generated execution graph |
| `--attempts 1..4` | Maximum attempts per task in that graph, including the first attempt |

The planner cannot override the requested team in its generated proposal. These
bindings are applied before the proposal is hashed and shown for review. Use
`orchestrate revise <goal-id> <plan.json>` to make deliberate per-agent choices in
a human-edited plan; explicit choices survive revision, while unselected workers
receive the captured defaults. A human can lower the attempt allowance. Changing
the proposal invalidates its previous approval hash. Running agents retain their
reviewed choices; model changes are made before approval or in a separately
reviewed child admission. Session model switches do not rewrite an active team.

For ongoing controller/reviewer supervision, add `--supervise` and a pinned
`--isolation-image`. `--controller-provider/model` can override the planner
choice for execution, and `--supervision-reviewer-provider/model` selects a
separate recurring reviewer. Planning and execution reviews have independent
choices and accounts within the one allowance. See
[supervised goals](continuous-supervision.md#start-from-a-goal) for the complete
command and bounds.

## Planning pair, one allowance

With a reviewer, the planner emits `draft`. A second, real agent consumes that
artifact, produces `proposal` and `plan-review`, and retains hashes and event
provenance for all three. The reviewer receives the same goal, scope and planning
instructions. Both agents have read-only tools and share the original planning
allocation and deadline. The reviewer is capped at half that allocation; its
allowance is part of the total, not additional funding. Prior planner spending
can reduce available capacity further, causing a visible budget denial.

The pair requires capacity for two planning agents, two tasks and depth one.
Neither agent approves its own proposal. Headless planning stops with exit 5;
the REPL displays the proposed graph and requests its exact-hash approval. The
review is proposed analysis, not proof that implementation or tests succeeded.
Planning/reviewer failures freeze the original charges and leave no execution
allocation. Existing human revision and recovery rules apply.

## Task loops and graphs

The execution model is bounded iteration:

```text
while a task has not met its acceptance checks:
    require remaining attempts, budget, deadline and permission
    attempt the task using recorded feedback from prior attempts
    collect artifacts and evaluate its declared checks
    stop for review if acceptance needs human judgment
    retry automatically only after a failure with no possible mutation

while reviewed graph work can advance:
    schedule ready tasks, in parallel where scopes permit
    collect evidence and make dependency outputs available
    stop when all tasks are accepted/verified, or a bound/review blocks progress
```

Retries receive at most three prior outcomes with event IDs, failed-check results,
bounded summaries and risks. They do not reset spending or deadlines. Unknown,
cancelled or possibly mutating attempts require explicit recovery; they are not
automatically replayed. Dependency outputs awaiting semantic review may be used
as proposed evidence, but do not make the workflow complete. Checks prove only
their declared predicates; model claims do not establish completion.

These rules remain the default for existing plans. Reviewed version 4 plans can
enable [continuous supervision](continuous-supervision.md), including a separate
reviewer, isolated retries, task strategy changes and bounded child admission.
The operator approves that policy as part of the plan; project permission checks
still apply to every mutation. Use `/agents spawn` for manual hash-approved
expansion and `/tasks graph` to inspect dependencies.

## Compact HUD

The REPL keeps one line per recent workflow and, by default, one line per agent
in the most recently updated workflow. Lines show status, requested provider/model
choice, task attempt/limit and completed-task counts. Actual routing decisions
remain in the task session's run log. Dollar amounts are limits, not billed spend.
Review-required and failed work never inflate completed counts.

```text
/agents hud agents
/agents hud workflows
/agents hud off
/agents tree --run <run-id>
/tasks graph --run <run-id>
/agents stop <agent-id> --run <run-id>
/agents retry <agent-id> --run <run-id>
/run resume <run-id>
/run cancel <run-id>
```

The HUD clips each row to terminal width, retains at most three workflows and
shows at most six agent rows, prioritizing active work. Overflow points to the
full tree. Escape immediately reports cancellation requested and waits for child
cleanup. Existing stop/retry/resume commands enforce the same policy as headless
execution. `/run status`, `/agents tree` and goal inspection restore progress from
the journal after a restart; read-only inspection does not start provider calls.
The HUD updates during an attached execution; inspection of another process is a
snapshot. Session reset clears the HUD. No HUD text is emitted into headless JSON.

## Schema and compatibility

Goals using team options have manifest version 2 and a hashed `team` object:

```json
{"version":1,"reviewer":{"provider":"auto"},"workers":{"provider":"auto"},"maxAttempts":2}
```

Each role is optional, but the object must contain at least one setting. Version
1 goal manifests remain readable; goals without team settings retain version 1.
Goal events, proposal envelopes, execution events and headless result envelopes
retain their existing versions. Team settings persist through restart and replay;
they cannot be changed by resume flags. The HUD is a presentation of verified
execution projections, not a new execution or authority store.
