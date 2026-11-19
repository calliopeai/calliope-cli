# Session recovery

Every terminal starts a separate session, including terminals opened for the
same project on the same day. `/sessions` lists the most recent 50 sessions;
`/new` starts another and `/resume <id>` restores a saved conversation for the
current project. `/resume` without an ID reloads the active session, which also
resolves a stale-writer conflict. Start Calliope in the recorded project to
resume a session belonging to a different project.

Session switches require the active turn to finish or be cancelled first. A
successful switch clears queued submissions and undo/redo state so that work
from the previous session cannot run in the new one. Provider/model preferences
continue to follow the [preference rules](model-preferences.md); protocol-owned
provider metadata stays attached to the saved assistant messages.

Terminal, headless and ACP turns save recovery snapshots before provider work,
before dispatching a response's tools, after each tool result, and on completion,
failure or cancellation. Headless output includes the session ID in a `status`
event and retains the existing event envelope and exit codes. ACP session IDs
identify the saved session too, and ACP `session/load` restores one in its
recorded project under the same rules ([ACP](acp.md#loading-a-session)). A saved
headless or ACP conversation can also be resumed from the terminal in its project.

If a recovery write fails, execution stops with an actionable error, including
when cancellation is also in progress. That recovery error takes precedence
over a normal cancelled result. Already
running parallel tools can finish; the runtime waits for them to settle. It does
not retry a failed snapshot or continue with more tools. An interrupted tool
without a recorded result is marked as having an unknown outcome on resume:
check the project state before requesting a retry. Resume itself makes no
provider request and executes no tool.

## Storage and schema

State is local under `~/.calliope-cli/sessions/{date}_{project}_{unique}/`.
New directories are private (`0700`) and snapshots are private files (`0600`).
The conversation is intentionally stored with its original content, including
images, tool results and opaque reasoning signatures. Configuration credentials
are not copied into snapshots. Treat these files as private user data; only
revision IDs, checksums, status and counts are added to the snapshot audit events.

`messages.json` is a version 1 envelope:

```json
{
  "version": 1,
  "sessionId": "session_...",
  "revision": "UUID",
  "updatedAt": "ISO timestamp",
  "status": "active",
  "droppedMessages": 0,
  "messages": [],
  "history": {"id": "same UUID as revision", "hash": "event SHA-256", "sessionId": "event owner ID"},
  "checksum": "SHA-256 of the serialized envelope without checksum"
}
```

Status is `active`, `completed`, `cancelled`, `interrupted`, or
`waiting_for_user`. The checksum detects damaged or edited content; it is not a
signature against someone who can rewrite the entire local store. The separate
run log remains the audit history. New snapshots also reference an immutable
conversation history head; see [session history](session-history.md) for branching,
replay, safe transfers and the event schema.

Readers accept legacy message arrays and migrate them on the next successful
save. Malformed metadata, unknown schema versions, invalid message shapes,
checksum mismatches, symlinked files and non-regular files are rejected. A broken
snapshot never falls back to a text chat log that has lost tool context.

A snapshot is bounded to 16 MiB and 10,000 messages. The usual retention target
is 1,000 messages, configurable with `CALLIOPE_MAX_PERSISTED_MESSAGES` (values
above 10,000 are clamped). The initial system message and complete contiguous
tool-call/result groups survive a retention boundary even if that exceeds the
target count. Overlarge snapshots fail visibly; compact the conversation or
start `/new`. Retention changes do not mutate the running conversation.

Each save takes an exclusive `messages.lock`, checks the expected revision,
appends an immutable delta event, writes and fsyncs a unique temporary snapshot,
then atomically renames the snapshot into place.
A stale terminal cannot overwrite another writer's committed snapshot. Session
IDs also bind chat history, iteration ledgers and runtime session tools (todos
and plans); another process changing the compatibility `current` pointer cannot
redirect those writes. Session tool state remains separate from conversation
snapshots and is not a multi-file transaction. Library runs using session-scoped
tools must supply a session ID created by storage.

## Recovery procedures

- **Stale revision:** use `/resume` to load the saved revision, or `/new` to start
  separately. The failed save leaves committed data intact.
- **Damaged snapshot:** preserve the file for inspection, restore a known good
  backup, or use `/new`. Do not substitute a partial chat log for tool evidence.
- **Lock left after a crash:** inspect the lock's PID and creation time, confirm
  that its writer has stopped, then remove that session's `messages.lock`.
  Calliope never steals a lock automatically. Abandoned `.messages-*.tmp` files
  are not committed snapshots and can be removed after the writer has stopped.
- **Disk full or permission failure:** correct the storage issue before resuming.
  A crash after a tool mutation but before its result is saved has an unknown
  outcome; inspect the workspace rather than replaying the tool automatically.

The pending submission queue is not persisted. Branching and private import/export
are documented in [session history](session-history.md).

## Headless execution evidence

SDK hosts can opt into `runHeadless({ retainRuntimeState: true, ... })` when
starting a new session. First require the root SDK export
`HEADLESS_RUNTIME_STATE_PROTOCOL_VERSION === 1`; older SDKs can silently ignore
unknown options. This capability advertises evidence capture, not execution resume.
Its checkpoints retain `runtimeState` beside the existing
turn allowance: the original start and deadline, cost cap, continuation count,
reported response token totals, estimated cost, tool-call count and current
provider/tool/question/verification effect. Pending work is saved before its
effect. An unresolved request or acknowledgment remains pending on interruption;
synthetic tool-pair cleanup does not turn it into a successful effect.

Hosts can explicitly select `runtimeStateVersion: 2` with capture enabled after
requiring `HEADLESS_EXECUTION_STATE_PROTOCOL_VERSION === 2`. These records add
`execution.phase` and every active effect, distinguishing provider admission,
recorded assistant responses, installed compressed context, queued/running tools,
questions and verification.
A recorded result can coexist with unresolved post-tool or acknowledgment work;
its effect remains active until that work settles. Parallel tool completion
removes only the settled tool. If a tool callback leaves work unresolved, v2
capture stops rather than allowing an error retry to overwrite those effects. An existing conversation cannot change capture
versions, and older v1 records do not acquire phase facts retrospectively.
This additional evidence does not enable execution restore or settle unknown
provider reservations. Legacy callers keep the original v1 capture format.

Hosts that retain a remote recovery floor can also supply
`onRuntimeStateCommitted` with capture enabled. The callback receives the exact
saved session/revision/checksum, status, original allowance and runtime evidence
after every local checkpoint. It must durably acknowledge that receipt and
return nothing before execution continues, and honor the original abort signal.
A rejection, invalid return, cancellation or changed local checkpoint stops
execution. The callback does not grant ownership, release a reservation or enable
headless resume; the paired host must still validate those separately.

When the execution signal is already aborted, the final cancelled checkpoint is
saved locally without calling the host acknowledgment with that expired signal.
Cancellation and time-cap exits retain their normal result; save failures still
fail the run. The host's last acknowledged checkpoint and unresolved reservations
remain authoritative. A locally saved final state does not claim remote acknowledgment.
The same rule applies when cancellation arrives during a successful local save or interrupts a pending host acknowledgment:
no further effects start, and the final cancelled state is saved locally. Genuine
write or acknowledgment failures still fail the run.
Returned-response usage is retained even when cancellation prevents presenting
the response or starting further work.

`responseUsageComplete` describes only responses returned to the runtime. It is
false after any such response omits usage. Totals are not an invoice or proof
that all provider attempts settled; the original reservation ledger remains
authoritative for charges and unknown requests.

Runtime evidence uses history event version 3. It must start with the first
conversation checkpoint, match the original turn ID, and retain its start,
deadline and cost cap. Later checkpoints cannot reduce reported totals or
restore a missing-usage marker. Replay, branches and portable bundles retain the
evidence. Versions 1 and 2 remain unchanged when capture is disabled; older CLI
versions cannot read version 3 histories.

Hosts can also require the root SDK export
`PROVIDER_RESPONSE_CHECKPOINT_PROTOCOL_VERSION === 1` before installing
`onProviderResponseReceived` on a captured, delegated headless run (or a
captured `runTurn` with its original execution guard). Older SDKs can ignore
unknown options, so supplying the callback alone is insufficient qualification.
The awaited callback receives a detached adapter response tied to its original
session, turn, run, agent, manifest, logical operation, request digest, provider
attempt and reservation. Primary requests, compression and repair carry distinct
purposes; a repair also identifies its parent operation. The digest describes
the runtime request, not exact provider wire bytes.

The callback must durably acknowledge the facts and return nothing before
settlement or dependent execution. A failure stops execution without another
provider request. Complete facts can arrive after caller cancellation; hosts
must retain that evidence without treating it as permission to continue.
Known usage settles against the original reservation once. Missing usage stays
unknown. Malformed completion fields, tool argument objects, stream framing or
usage cannot attest completion and leave the reservation charged. Tool calls
cut off by an output limit retain the existing truncation handling.

This option captures evidence and does not enable headless execution resume.
A quiescent marker, a portable bundle or a valid checksum does not prove current
Native ownership, the original account/model/policy, settled reservations or
remaining execution authority. Interrupted goals still require the paired
host admission and ledger recovery contract tracked in #521.

The run-log v1 envelope adds `session_checkpoint` events with `revision`,
`checksum`, `status` and `messageCount`; existing event types are unchanged.
