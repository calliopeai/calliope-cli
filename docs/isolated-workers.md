# Isolated workers and verification

Version 3 project plans run file tools in a separate, retained Git worktree for
each task attempt. Reviewed verification commands then run against that task's
read-only file grants in Docker. The source checkout is unchanged; inspect the
candidate diff and explicitly decide whether to apply it.

Prepare a normal [reviewed task plan](coordinator-execution.md), then add:

```json
{
  "version": 3,
  "workspace": {
    "isolation": { "version": 1, "image": "sha256:<local-image-id>" }
  }
}
```

This is a fragment: retain the plan's other required fields. Obtain the full
64-digit image ID with `docker image inspect <your-image> --format '{{.Id}}'`.
The image must already exist in the local daemon and contain the executable and
dependencies you intend to use. Calliope never pulls an image during execution.

Each task declares a patch output and its optional verification commands:

```json
{
  "outputs": [
    { "id": "candidate", "kind": "file", "path": "src/result.txt", "description": "Candidate output." },
    { "id": "candidate-patch", "kind": "patch", "description": "Candidate diff." },
    { "id": "unit-tests", "kind": "test_result", "description": "Verification process result." }
  ],
  "isolation": {
    "patchArtifactId": "candidate-patch",
    "commands": [
      { "artifactId": "unit-tests", "argv": ["node", "--test", "tests/result.test.js"], "timeoutMs": 30000 }
    ]
  },
  "acceptanceChecks": [
    { "id": "tests-passed", "artifactId": "unit-tests", "kind": "command", "criteria": ["task:0", "agent:0"] }
  ]
}
```

The task's agent and every ancestor need `shell` in `allowedTools` for declared
commands. Their path grants must include the test files and source they need to
read. File outputs still require a write grant. Add acceptance checks for any
other criteria in the plan. Every command requires its own `command` check;
worker-authored JSON cannot supply this result or the generated patch.

```sh
calliope run plan.json --dry-run --json
calliope run prepare plan.json --json
calliope run approve <run-id> --json
calliope run execute <run-id> --allow-mutations --json
calliope run status <run-id> --json
calliope run replay <run-id> --json
```

The same plans work through `/run`; the existing agent/workflow HUD displays their
progress. In the REPL, command approvals show the exact argv, worktree, image,
read grants, network restriction and timeout. Headless execution needs the explicit
mutation flag for file edits and verification commands; current project policy and
hooks can still deny them. Model-selected shell, network and custom tools remain
unavailable to these workers.

## Evidence and recovery

All file artifacts are immutable run snapshots. A verification artifact records
the argv, pinned image, exit code, outcome, bounded stdout/stderr, truncation,
duration, container name and cleanup confirmation. It also records workspace
hashes before and after execution. A passing process certifies only unchanged
input content; a changed or replaced workspace cannot pass collection afterward.
Patch artifacts contain actual Git diffs, including newly created ignored files.
They include any declared dependency files copied into the candidate and do not
claim those dependency changes as the current worker's edits.

The existing version 2 headless envelopes and version 1 tool/artifact events stay
unchanged. `command` acceptance checks refer to executor-generated results.
Failed checks cannot complete a task. Once a command or file mutation starts,
automatic replay is disabled; inspect the outcome and use the existing explicit
retry/resume controls. Original approval, provider preferences, token/dollar
reservations and deadlines remain tied to the source project across attempts.

The default store is `~/.calliope-cli/orchestration/<run-id>/execution/`:

- `workspace-base.json` pins the original commit and reviewed plan.
- `worker-<task-id>-<attempt>/identity.json` binds the retained directory and Git identity.
- `worker-<task-id>-<attempt>/files/` is the detached worktree.
- `artifacts/` and `history.json` retain hashed evidence and its event provenance.

The coordinator records workspace admission and command policy decisions in each
task's session audit log and flushes them before finishing. Cancellation retains
completed command receipts. Interrupted workspace creation is preserved for
inspection, and explicit retries use fresh directories. Changed dependency
artifacts or two inputs disagreeing on one path stop the consumer.

No worktree is deleted automatically. Archive the run evidence before explicitly
removing its retained worktrees with Git. A failed cleanup result names the
container to inspect; preserve that result rather than treating it as a test pass.

New command receipts include optional version-1 `cleanup` diagnostics: the final
removal outcome (`removed`, `absent`, `timeout` or `error`) and exit code, plus a
read-only verification outcome when needed. After an unconfirmed removal, the
executor inspects the exact container once, only if creation was acknowledged.
Only the daemon's exact named absence response confirms removal. A present
container, daemon error, malformed/oversized response or timeout stays unconfirmed.
The five-second removal and three-second inspection limits each allow 250 ms for
process-group termination. Safety cleanup can outlast the command deadline; it
does not authorize another command or extend the task's execution allowance.
Cancellation and command timeout retain their original outcomes, and a failed
test remains failed even when absence is confirmed. Interrupted creation cannot
be confirmed by this probe because the create request might still complete later.
Legacy receipts stay valid and unchanged; this check does not repair prior runs.
The [local process smoke evidence](evidence/container-cleanup-smoke.json) records
a real failing Docker command and deliberately lost removal acknowledgement,
with the exact source hashes and matching clean-package behavior.

An output-limit cutoff now collects the actual patch and runs the approved
verification commands while authority and time remain. The task stays failed:
partial model reports cannot establish success, even when the tests pass. A
supervised retry can use these independently collected receipts. Cancellation,
policy denial and expired budgets/deadlines do not start this verification path.

For older attempts recorded as `Worker stopped: length.` with mutations and no
artifacts, explicit recovery is available in the CLI and `/run` REPL command:

```sh
calliope run recover-evidence <run-id> <task-id> --allow-mutations --json
calliope run retry-controller <run-id>
calliope run resume <run-id> --allow-mutations --max-output-tokens 2048
```

Recovery reopens the original worktree and pinned baseline. It checks the actual
diff against recorded changed paths, applies current project permissions, and
runs only the reviewed container commands within the original deadline. Missing
or damaged state, changed approval, stopped agents and unrecorded file changes
require manual inspection. This includes dependency copies that changed files
outside the recorded worker edits; recovery does not guess their origin.

Each attempt permits one evidence recovery, including interrupted or failed
verification. It makes no model calls, changes no source files, and replenishes
no budget, attempt count, round count or deadline. The new receipts describe the
**currently retained candidate**, not a reconstructed historical snapshot. The
original failed outcome remains in the append-only history. A version-1
`task_recovery_started` event binds recovery to that outcome ID; its replacement
outcome cannot accept the incomplete worker report. Any pending controller
decision is invalidated so a subsequent explicit controller retry reviews the
new evidence within its remaining rounds. The recovery command's successful
exit means evidence was collected; its JSON task/run status remains `failed`.

## Boundaries

Git worktrees separate edits; Docker constrains verification processes. Commands
use only the local Unix Docker socket, a pinned image, read-only mounts, no network,
no inherited host environment, dropped capabilities and a read-only root. Each
container has one CPU, 256 MiB memory, 64 processes and a 64 MiB temporary directory.
The image itself, local daemon, host and configured policy programs are trusted.
There is no unsandboxed fallback and no automatic merge, deploy or publication.

Commands are reviewed argv arrays, at most eight per task, 64 arguments per
command and 60 seconds each, further constrained by the original agent deadline.
Each output channel retains at most 64 KiB and redacts known credentials. Put
temporary test output under the container's `/tmp`; source mounts cannot be written.

The source must be a complete local clone without lazy fetching or pending tracked/untracked
changes, except an untracked plan file. Ignored files are excluded. Initial
snapshots reject symlinks/submodules and exceed neither 10,000 files, 50 MiB total
nor 10 MiB per file. Git hooks, filters, external diff and text conversion are
disabled during workspace operations. Existing file-tool and run-artifact limits
remain in force; preserve/archive retained runs to manage disk use.

This slice supports explicitly reviewed version 3 plans. Saved teams and automatic
goal planning continue to use their existing contracts; continuing dual-controller
supervision and automatic graph revision remain separate work.
