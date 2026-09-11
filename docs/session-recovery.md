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
identify the saved session too; ACP `session/load` is still unavailable. A saved
headless or ACP conversation can be resumed from the terminal in its project.

If a recovery write fails, execution stops with an actionable error. Already
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
  "checksum": "SHA-256 of the serialized envelope without checksum"
}
```

Status is `active`, `completed`, `cancelled`, `interrupted`, or
`waiting_for_user`. The checksum detects damaged or edited content; it is not a
signature against someone who can rewrite the entire local store. The separate
run log remains the audit history. Deterministic event replay and branching are
later work; snapshots retain the latest recovery state.

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
writes and fsyncs a unique temporary file, then atomically renames it into place.
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

This slice does not persist the pending submission queue, offer snapshot import
or export, or implement session branches. Those controls remain in phase 3.

The run-log v1 envelope adds `session_checkpoint` events with `revision`,
`checksum`, `status` and `messageCount`; existing event types are unchanged.
