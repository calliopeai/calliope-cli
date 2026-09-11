# Orchestration plans and run preparation

Calliope can validate a bounded project plan, record an inactive run, and inspect
its hierarchy, dependencies and journal after restart. This is the first
orchestration layer. It does not yet invoke a coordinator model, execute child
agents, verify their artifacts, or satisfy the orchestration execution release
gate. Goal decomposition, scheduling, shared request reservations, isolated
mutations, cancellation trees and execution recovery remain required in #254.

## Commands

```sh
calliope run plan.json --dry-run --json
calliope run prepare plan.json --json
calliope run list --json
calliope run status RUN_ID --json
calliope run approve RUN_ID --json
calliope run cancel RUN_ID --json
calliope run replay RUN_ID --json
calliope agents --tree --run RUN_ID
calliope tasks --graph --run RUN_ID
```

The REPL exposes `/run`, `/agents tree [run-id]` and `/tasks graph [run-id]`.
Quoted paths work, for example `/run prepare "project plan.json"`. Status and
hierarchy inspection without an ID select the newest valid run in the current
project and display its ID. Approval, cancellation and replay require an explicit
run ID. `calliope run <plan>` without an operation flag reports that execution is
not yet available instead of claiming to run the plan.

Dry-run validates and reads only; it writes no run or audit record, executes no
commands, and performs no provider discovery or inference. With an executable
policy or pre-tool hook configured, it fails closed before reading the plan,
because evaluating that program could itself mutate state. Explicit preparation
checks the source read and `orchestration_prepare` through the shared permission
resolver, including policy and hooks. Approval and cancellation use
`orchestration_approve` and `orchestration_cancel`. Plan mode and non-interactive
confirmation requirements remain enforced. No operation grants tool permission.
Cancellation reaches the permission subprocess: its POSIX process group is
killed, and the resolver waits for settlement before preparation returns. Hook
and policy output buffers retain at most 65,536 characters per stream. This controls trusted permission
programs; process groups are not a sandbox for programs that deliberately escape
them. Cancellation is covered by real-process tests on macOS/Linux.

JSON reports contain `version: 1`, `type: "orchestration"`, `action`,
`localOnly: true`, `execution: "not-started"`, and `data` or
`error: {code, message}`. Preparation/status return a `run` and graph summary;
list returns `runs` and an `unavailable` directory count; agents/tasks return
their full declarations; replay returns the ordered committed events. Dry-run
includes the declared plan, source digest, stages, scope conflicts and explicit
`modelDiscovery: "not-checked"`. JSON can contain private project text. Human
output is bounded to 32,000 characters and directs larger inspections to JSON.
Exit codes are 0 success, 1 invalid/damaged state or failed operation, 2 invalid
arguments, 3 policy denial, and 130 cancellation. Existing headless turn JSON is
unchanged; a successful preparation is not successful task execution.

## Agent, task and workspace contracts

A version 1 plan contains `id`, `goal`, `workspace`, `limits`, `agents` and `tasks`.
The workspace root is `.`: the current project is canonicalized and pinned by
path, device and inode. There is exactly one root agent, identified by a null
`parentId`. Other agents name an existing parent. Roles are bounded descriptive
text; domain leads and verification workers use the same contract as task agents.

Every agent declares its ID, parent, role, objective, inputs, allowed tools and
paths, provider/model preference, token/dollar/time budgets, maximum child depth
and count, acceptance criteria, and escalation policy. The schema rejects unknown
fields and providers, missing declarations, duplicate IDs, cycles, malformed
budgets, unsafe text and excessive nesting. Models are preferences only; live
compatibility must be checked when execution is added. No model catalog is stored.

Path grants are normalized project-relative subtrees with `read` or `write`
access; write includes read. Globs, traversal and symlink aliases are rejected.
Child tools and path grants must fit within their parent's authority. Child
budgets and delegation/retry limits cannot exceed the parent's ceilings.
Token and dollar budgets cover an agent and its descendants; the sum reserved
for direct children must fit the parent envelope. Time budgets are wall-clock
ceilings, not estimates of the time required. Their enforcement at provider/tool
admission belongs to the future executor; preparation spends none of them.

Each task has an assigned agent, objective, inputs, outputs, dependencies and
acceptance criteria. Inputs declare `id`, `kind` (`text`, `file`, `artifact`) and
`value`. File inputs must exist as regular files within the agent's allowed scope.
An artifact input names a declared output from a transitive dependency, including
inputs shared at agent level. Every task declares at least one output artifact.
Artifacts declare an ID, kind, description, and optional project-relative path
(required for file artifacts). Kinds are file, patch, report, test_result,
decision and evidence. Output paths require write authority.

Dependency stages are deterministic readiness layers, not permission to run all
members concurrently. The analysis separately reports unordered task pairs
whose scopes overlap with at least one writer. The future scheduler must resolve
those conflicts through ordering or isolation and enforce the concurrency cap.

Hard validation limits: 2 MiB per plan, 256 agents, 1,024 tasks, depth 8,
concurrency 16, 100 inputs/outputs/criteria per declaration, 256 tools/path grants
per agent, and 100,000 plain JSON values. Text is limited to 8,192 characters,
IDs to 64, and paths to 1,024. Scope analysis stops at two million comparisons or
10,000 conflicts. Run/agent limits may be smaller; token budgets cap at
100,000,000, dollars at 10,000, time at 24 hours, and retries at three.

## Minimal plan

The following plan expects an existing `src/index.ts`. Generated reports have a
separate write scope from source files.

```json
{
  "version": 1,
  "id": "inspect-project",
  "goal": "Inspect the entry point and verify a source-backed report.",
  "workspace": {
    "id": "project", "root": ".",
    "allowedTools": ["read_file", "write_file"],
    "allowedPaths": [{"path": "src", "access": "read"}, {"path": ".calliope-artifacts", "access": "write"}]
  },
  "limits": {"maxAgents": 2, "maxTasks": 2, "maxDepth": 1, "maxConcurrent": 1, "tokenBudget": 5000, "costBudgetUsd": 0.05, "timeBudgetMs": 60000},
  "agents": [
    {
      "id": "coordinator", "parentId": null, "role": "Coordinator and verifier",
      "objective": "Verify the source references in the report.", "inputs": [],
      "allowedTools": ["read_file", "write_file"],
      "allowedPaths": [{"path": "src", "access": "read"}, {"path": ".calliope-artifacts", "access": "write"}],
      "preference": {"provider": "auto"}, "tokenBudget": 5000, "costBudgetUsd": 0.05, "timeBudgetMs": 60000,
      "maxChildDepth": 1, "maxChildCount": 1,
      "acceptanceCriteria": ["Every report claim has a checked source reference."],
      "escalationPolicy": {"onFailure": "human", "maxRetries": 1}
    },
    {
      "id": "reader", "parentId": "coordinator", "role": "Source reader",
      "objective": "Describe the entry point with source references.", "inputs": [],
      "allowedTools": ["read_file", "write_file"],
      "allowedPaths": [{"path": "src", "access": "read"}, {"path": ".calliope-artifacts/report.md", "access": "write"}],
      "preference": {"provider": "auto"}, "tokenBudget": 2000, "costBudgetUsd": 0.02, "timeBudgetMs": 30000,
      "maxChildDepth": 0, "maxChildCount": 0,
      "acceptanceCriteria": ["The report cites the entry point."],
      "escalationPolicy": {"onFailure": "parent", "maxRetries": 1}
    }
  ],
  "tasks": [
    {
      "id": "inspect", "agentId": "reader", "objective": "Inspect the entry point.",
      "inputs": [{"id": "entry", "kind": "file", "value": "src/index.ts"}],
      "outputs": [{"id": "report", "kind": "report", "description": "Source-backed report", "path": ".calliope-artifacts/report.md"}],
      "dependencies": [], "acceptanceCriteria": ["Source references are included."]
    },
    {
      "id": "verify", "agentId": "coordinator", "objective": "Check the report against source.",
      "inputs": [{"id": "report-input", "kind": "artifact", "value": "report"}],
      "outputs": [{"id": "verification", "kind": "test_result", "description": "Verification findings", "path": ".calliope-artifacts/verification.json"}],
      "dependencies": ["inspect"], "acceptanceCriteria": ["Each source reference is checked."]
    }
  ]
}
```

## Evidence-bearing agent output

The separate `AgentOutput` validator requires version, agent/task IDs, status,
summary, changed files, artifacts, test evidence references, unresolved risks
and recommended next action. Status is success, partial, failed, cancelled or
denied. Each artifact must match a declared output and include its owner,
project-relative path, SHA-256, creation time, confidence (0–1), and source run
and immutable event IDs. Test references must point to supplied test/evidence
artifacts. A success declaration requires every planned output.

These checks validate associations, not the truth of a worker's claims. The
future verifier must read artifacts, compare hashes, inspect source events and
execute acceptance checks before the coordinator can credit completed work.
Preparation cannot attach a worker result or advance a task to success.

## Local journal and recovery

Runs live under `~/.calliope-cli/orchestration/<UUID>/`, with private 0700
directories and 0600 files. Store roots must be canonical paths without symlink
ancestors. `manifest.json` stores the immutable versioned plan, its digest,
source path/digest, project identity, creation time and manifest hash.
`events/<UUID>.json` stores version, immutable ID, run ID, ISO timestamp,
sequence, previous event ID/hash, change and hash. Changes currently are:

- `prepared`, binding the manifest hash;
- `approved`, recording an explicit CLI/REPL review action;
- `cancelled`, revoking preparation approval.

`head.json` is a versioned, hashed commit pointer binding the manifest and newest
committed event. An exclusive writer lock protects compare-and-append updates.
Each event is created exclusively and fsynced; an fsynced private temporary head
is renamed into place and its directory synced. The previous head is compared
again before commit, and project/store identity changes reject the operation.
Creation uses a separate exclusive root lock. The journal is retained even if
the optional conversation audit log is disabled.

Replay follows the head, verifies every digest, causal link, sequence and legal
transition, and deterministically projects run status. `executedTasks` remains
zero. Approval is pending, approved or revoked; approval binds the immutable
plan and conveys no permission to mutate a project or spend a provider budget.
Digests detect corruption, not authorship or an adversary who can rewrite the
entire store. The journal is local evidence, not a signed remote trust root.

The store admits at most 1,000 run directories. A run retains at most 10,000
event files, 32 MiB of event data and 4 KiB per event. Orphan events count toward
retention and are never silently adopted or deleted. A failed initial save can
leave an inactive directory without a committed head; listing reports an
unavailable directory count. A failed later head commit keeps the previous
projection valid. If cancellation arrives after commit, inspect `run list` or
`run status` before retrying preparation. Cancellation cannot undo a durable
commit that already completed.

Preserve damaged or incomplete directories for inspection. Verify a lock's
process stopped before removing the lock; do not delete live writer locks or
rewrite hashes to conceal corruption. Archive old run directories outside the
active store before exceeding retention. Project replacement changes identity;
existing runs do not automatically acquire authority over the new project.
