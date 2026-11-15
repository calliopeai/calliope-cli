# Shared execution runtime

Terminal, headless and ACP clients call `runTurn` from `src/runtime/index.ts`.
The package root exports it for programmatic clients. A turn owns model requests,
compression, local tool repair, permission resolution, tool execution, retries,
usage accounting, budgets and audit completion. Routing also belongs to the runtime; clients retain display, circuit breakers,
checkpoints and queued user input. ACP retains
streaming notifications, editor file delegates and permission prompts.

`TurnOptions` supplies a session ID, project directory, requested provider/model,
message reference, confirmation policy and optional `AbortSignal`. Callbacks
adapt presentation; they do not bypass the canonical permission resolver.

Pending tool calls are detached from model-response and client-notification
objects. Editing a callback's arguments or permission notification cannot change
the call that policy evaluates or turn a denial into execution. After client and
recovery waits, dispatch validates the original invocation, current session,
project/policy/scope state, inherited authority and any saved approval. An expired
or revoked approval refuses execution. Read retries obtain a new permission and
policy decision before dispatch; a prior allow does not authorize another attempt.

All provider calls made during a turn, including repair and compression, count
against the same budget. Ordinary per-run counters are checked before requests
and tools. Project-capped turns and bounded agent contexts additionally reserve
each attempt before HTTP; missing usage remains charged. See
[agent runtime authority](agent-runtime.md) for admission, persistence and the
provider pricing assumptions behind those bounds.

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
tools by default. A host supplying `answerQuestion` instead waits inside the same
turn for an `ask_question` answer. The runtime passes its cancellation signal,
validates bounded nonempty answer text, records one tool result, and continues
with the original iteration and budget accounting. Cancellation discards a late
answer and completes the pending tool pair without claiming success. This callback
does not approve tools or alter the behavior of `create_plan`.
Embedded headless callers can provide this callback as `HeadlessOptions.answerQuestion`
to `runHeadless`. The trusted host must authorize the answer against its exact
question and revision and preserve durable delivery evidence. A rejected callback
or invalid answer fails the headless run. An absent callback retains the existing
waiting outcome (exit 4); the CLI does not read an answer from stdin implicitly.
The existing `maxTime` includes time spent waiting for the host, and `maxCost`
remains cumulative across the answer. This callback alone does not resume a
terminated process or supply factory steering, execution pause or recovery.

Hosts can also supply `HeadlessOptions.onQuestionCommitted`. It receives a frozen
`HeadlessQuestionReceipt` containing the original session/tool-call IDs, saved
conversation revision/checksum and answer SHA-256. The existing conversation
writer must have saved the exact answer before the callback runs. The shared
runtime waits for host acknowledgement before admitting further execution, within
the same cancellation signal, deadline and cumulative budget. Direct `runTurn`
callers using this hook must supply their checkpoint writer.

Host refusal stops the turn and retains the already-saved answer for recovery.
A conversation changed while acknowledgement was pending cannot continue from
the stale revision. The host still authorizes the exact question/request revision;
a local conversation receipt grants no tools, scope or account access. These
callbacks do not implement hosted Factory routing, steering, execution pause or
process recovery by themselves.

Embedded clients can pass a `RuntimeControl` to `runHeadless` for cooperative
execution pause and ordered steering within the original live turn:

```ts
const control = new RuntimeControl();
const running = runHeadless({ ...originalOptions, control });
const paused = await control.pause('operator-pause-1');
const steered = control.steer({ requestId: 'operator-note-1',
  sessionId: paused.sessionId, revision: paused.revision,
  text: 'Include the verification commands and keep the original criteria.' });
await control.resume(paused);
await steered;
await running;
```

Pause is first `pausing`, then `paused` after a saved, quiescent boundary and
the optional `onControlCommitted` acknowledgment. Started parallel work and
post-tool hooks settle before acknowledgment. An unanswered host question can
be parked; an answer received while paused waits before changing the snapshot.
An already-saved answer's host acknowledgment settles before a requested pause,
preserving the revision that acknowledgment names.

Resume requires the exact frozen pause receipt. Control receipts carry the
session, request ID, kind, revision and checksum. Steering binds its origin
session/revision and exact text, is idempotent by request ID, and is saved at a
complete conversation boundary before another model request. Steering received
with a final response requires another iteration or an explicit limit outcome.
The original budget, iteration allowance, deadline and permission checks remain
in force; cancellation and deadlines settle control waits. A failed writer or
refused acknowledgment stops admission and cannot be retried through `onError`.

Direct `runTurn` callers supply their existing `onCheckpoint` writer plus a
`controlSnapshot` reader for that writer's saved revision/checksum. Hosts authorize
incoming operator intents before calling the controller. Its bounded request
history belongs to one live turn; authoritative host intent retention, durable
CLI homes and fenced process recovery require the host recovery implementation.

Any unexecuted calls receive explicit placeholder results. With
`continueOnLength` (terminal and headless), a reply cut off by the output limit,
or an empty reply, is not completion: any tool calls in the truncated reply are
discarded unrun and the model is asked to continue, up to
`MAX_CONSECUTIVE_CONTINUATIONS` (3) times in a row; any other reply resets the
count. Headless emits a `status` event with `continuing: true`, `reason`,
`attempt` and `max` for each continuation. If the bound is exceeded the turn
ends as `length` or `empty_response`, headless emits an `error` then `done`, and
exits 4. The iteration limit, budget, time caps and abort still apply. ACP and
library callers that do not opt in expose an incomplete outcome instead of
claiming success.

| Outcome | Headless exit | ACP stop reason |
|---|---:|---|
| Complete | 0 | `end_turn` |
| Error | 1 | JSON-RPC error |
| Explicit provider unavailable | 2 | Session creation error |
| Budget reached | 3 | `refusal` |
| Iteration limit | 4 | `max_turn_requests` |
| Output length limit | 4 | `max_tokens` |
| Repeated empty replies | 4 | `refusal` |
| Waiting for user/plan approval | 4 | `end_turn` |
| Cancelled | 130 | `cancelled` |

Headless JSONL `done.data.reason` distinguishes these outcomes. Automation that
previously assumed every finished loop was successful should handle exit 4.
Tests in `tests/runtime.test.ts` exercise real file/scope checks with a deterministic
provider, including concurrent sessions, budget exhaustion and cancellation.
They establish runtime behavior; provider wire conformance is tracked separately
in [#222](https://github.com/calliopeai/calliope-cli/issues/222).

`npm run test:native-policy` builds the CLI and exercises its headless JSONL,
ACP stdio and terminal Ink clients against a loopback inference fixture and real
policy subprocesses. Each client verifies an allowed file effect and the absence
of effects for denial, timeout and an unavailable policy command. Ordinary policy
descendants cannot produce delayed effects after allow, deny or timeout in any
of the three clients. Headless SIGINT, ACP `session/cancel`, and terminal Escape
and Ctrl+C refuse a pending policy's late allow, stop its ordinary descendants,
and stop a running shell descendant that ignores SIGTERM after its parent exits.
The terminal uses a real PTY with `--auto`, waits for the idle prompt after
cancellation, and exits through `/exit`. Its first Ctrl+C cancels through the
input handler; a second press within two seconds exits. ACP uses actual editor
permission and file requests.
The fixtures use private temporary homes/configuration and remove their own
process groups and files. This qualification requires POSIX and Python 3; it does
not establish Windows or hosted-provider conformance. Policy-command output still
uses the documented exit-code contract, without a remote expiry/revocation lease.

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

Permission policy and pre-tool hooks receive the turn cancellation signal.
Policy-command cancellation and deadlines deny immediately, kill the owned POSIX
process group and close captured pipes; inherited pipes cannot extend the decision
even when a descendant escapes that group. Ordinary policy descendants are also
killed after successful or denied completion. Policy stdout is drained without
retention and stderr retains at most 65,536 characters. General pre-tool hooks
retain their own subprocess cleanup contract. POSIX groups do not contain escaped
processes: sandbox containment, other tool paths, remote oversight leases and
Windows process supervision require separate qualification.
