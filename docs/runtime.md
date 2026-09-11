# Shared execution runtime

Terminal, headless and ACP clients call `runTurn` from `src/runtime/index.ts`.
The package root exports it for programmatic clients. A turn owns model requests,
compression, local tool repair, permission resolution, tool execution, retries,
usage accounting, budgets and audit completion. Routing also belongs to the runtime; clients retain display, circuit breakers,
checkpoints and queued user input. ACP retains
streaming notifications, editor file delegates and permission prompts.

`TurnOptions` supplies a session ID, project directory, requested provider/model,
message reference, confirmation policy and optional `AbortSignal`. Callbacks
adapt presentation; they do not bypass the canonical permission resolver. All
provider calls made during a turn, including repair and compression, count
against the same budget. The cap is checked before requests and tools; a response
can exceed the cap because its final usage is known only after it arrives.

See [Routing](routing.md) for live eligibility, preference preservation,
protocol history, price evidence and versioned decision events.

Cancellation is terminal for that turn. The engine waits for started parallel
tools to settle, records explicit interrupted results for missing tool pairs,
flushes the audit log, and returns `reason: cancelled`. An interrupted result is
not evidence of completion and must not cause an automatic replay of a mutation.
Provider failure remains an error; the adapter may request a bounded retry or
stop. Tool retries apply only to known read operations with transient errors.
Unknown/plugin operations and mutating tools are never automatically retried.

Scopes are bound to async turn context. Headless and ACP turns start at their
project root with fresh grants. Terminal turns may inherit explicit scope grants
only when their project matches the scope's original root. Terminal resume
requires the saved project to match; programmatic turns in another project get
a fresh scope. Concurrent sessions cannot borrow grants
from each other. The terminal also creates checkpoints in the session project.

A successful `ask_question` or `create_plan` pauses execution before subsequent
tools. Any unexecuted calls receive explicit placeholder results. Terminal length
continuation remains bounded by the iteration limit; ACP and headless expose an
incomplete outcome instead of claiming success.

| Outcome | Headless exit | ACP stop reason |
|---|---:|---|
| Complete | 0 | `end_turn` |
| Error | 1 | JSON-RPC error |
| Explicit provider unavailable | 2 | Session creation error |
| Budget reached | 3 | `refusal` |
| Iteration limit | 4 | `max_turn_requests` |
| Output length limit | 4 | `max_tokens` |
| Waiting for user/plan approval | 4 | `end_turn` |
| Cancelled | 130 | `cancelled` |

Headless JSONL `done.data.reason` distinguishes these outcomes. Automation that
previously assumed every finished loop was successful should handle exit 4.
Tests in `tests/runtime.test.ts` exercise real file/scope checks with a deterministic
provider, including concurrent sessions, budget exhaustion and cancellation.
They establish runtime behavior; provider wire conformance is tracked separately
in [#222](https://github.com/calliopeai/calliope-cli/issues/222).

Recovery snapshots use the optional `onCheckpoint` callback before provider
work, before dispatching tools, after each result and at turn completion.
Callbacks are serialized across parallel tools; a failed write halts execution.
Terminal, headless and ACP clients enable this callback and save to their own
session IDs. See [session recovery](session-recovery.md) for the versioned schema
and unknown tool outcomes after interruption.

When a client supplies `onSafetyBranch`, the shared runtime waits for one safety
branch before its first allowed medium/high/critical-risk tool. Parallel tools
share that promise. Failure stops execution and inference retry; cancellation is
checked again before dispatch. Terminal, headless and ACP wire this to the saved
session service. A parallel checkpoint failure also stops tools still awaiting
permission, branch creation or retry. See [session history](session-history.md).

Streaming clients can supply `onStreamReset` for safe partial-attempt replacement.
Without replacement support, an interrupted partial stream fails without retry.
`captureToolOutput` persists bounded inspection evidence; a failed output save
does not rerun the tool. See [streaming and output contracts](streaming.md).

Permission policy and pre-tool hooks receive the turn cancellation signal. The
resolver waits for their subprocess to settle after cancellation, instead of
returning while a detached permission process remains alive. POSIX process groups
are killed on abort; hook/policy output buffers are bounded to 64 KiB.
