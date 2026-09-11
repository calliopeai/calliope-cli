# Session history and portability

Session history is local and private. Conversation content, images, tool results,
plans, todos, ledgers and opaque provider reasoning metadata can contain project
secrets. Transfer files preserve that data intentionally; configuration keys,
permission grants and trust settings are never included. Audit records for
session operations contain paths, IDs, counts and digests, not transferred content.

## Commands

| REPL | Behavior |
| --- | --- |
| `/branch [name]` | Create a new session from the current conversation and session tool state, then switch to it. |
| `/checkout <id\|name>` | Restore a saved conversation and its session tool state in the same project. |
| `/diff <id\|name>` | Show the common prefix and changed conversation messages relative to the current conversation. |
| `/replay [revision]` | Verify the committed event ancestry and project the conversation, without inference or tool execution. |
| `/export [file.json]` | Write an importable private bundle; the default filename includes a timestamp. |
| `/export file.md` | Write a readable conversation transcript without protocol metadata or the initial system instructions. |
| `/import <file.json>` | Validate and import a bundle into a new inactive session, then show its ID. |

`/new`, `/sessions` and `/resume [id]` remain available. Names are optional labels;
duplicate names require selection by session ID. Checkout changes the conversation,
its plans/todos/ledger and visible transcript. It clears the previous submission
queue and undo stack. It does not restore Git or workspace files. Provider/model
preferences still follow the [preference rules](model-preferences.md).

Switches and transfers wait for the active turn to end or be cancelled. Missing
tool results are marked as having unknown outcomes on resume; inspect project
files before requesting a retry. No stored tool call is automatically executed.

The separate headless namespace requires no provider credentials:

```sh
calliope session list --json
calliope session status SESSION_ID --json
calliope session branch SESSION_ID experiment --json
calliope session diff SESSION_ID experiment --json
calliope session replay SESSION_ID [REVISION] --json
calliope session export SESSION_ID private-session.json --json
calliope session import private-session.json --json
```

Every response is one JSON object with `version: 1`, `type: "session"`, `action`,
`localOnly: true`, and either `data` or `error: {code, message}`. List data contains
`sessions`; status contains session metadata, revision, status, message count,
dropped count and history link; replay contains `sessionId`, `snapshot`, and
ordered `events`; branch contains `session` and `revision`; diff contains common,
removed and added messages; export contains `path`; import contains `session`,
revision, status and message count. Replay and diff output is private data too.

Exit codes are 0 success, 1 invalid saved state or failed operation, 2 invalid
arguments, 3 policy denial, and 130 cancellation. Existing headless turn envelopes
and `calliope replay <path|sessionId>` (audit-log replay) retain their contracts.

## Event schema and commit protocol

`events/<UUID>.json` records are immutable version 1 deltas. Every event contains:

```json
{
  "version": 1,
  "id": "UUID",
  "sessionId": "original owner ID",
  "at": "ISO timestamp",
  "parent": {"id": "previous UUID", "hash": "SHA-256", "sessionId": "owner ID"},
  "change": {"keep": 3, "append": [], "status": "completed", "droppedMessages": 0},
  "stateHash": "SHA-256 of projected messages, status and droppedMessages",
  "hash": "SHA-256 of this serialized event without hash"
}
```

The root has a null parent and keeps zero messages. Apply a delta by retaining
the first `keep` messages and appending its message array. Replay validates every
event digest, link, message/tool association and projected state hash. Provider
metadata remains opaque JSON. Digests detect damage, not the identity of whoever
created or rewrote a bundle; importing a digest does not establish trust.

Each save holds `messages.lock`, compares its expected revision, appends and
fsyncs the new event, then writes and fsyncs a private temporary snapshot.
Renaming it to `messages.json` commits its `history: {id, hash, sessionId}` link.
Ordinary snapshot reads verify the snapshot checksum and referenced head;
replay/export/branch verify its complete ancestry. Historical replay can inspect
a known event even if the current cached snapshot is damaged.

Unreferenced events from interrupted saves remain on disk and count toward the
budget. They are never silently adopted or deleted. A legacy snapshot gains an
anchor event on its next successful save; this records the available prior state
without inventing earlier turns. A manual or safety branch starts a new root
with versioned source session, revision, state-hash and tool-state-hash provenance
in session metadata. Unsaved REPL edits become the new root without appending
to the source, so branching still works when the source history is full; the
source revision must match the terminal’s cursor.

History is limited to 10,000 files and 64 MiB per session; each event is limited
to 16 MiB plus envelope overhead. The [snapshot limits](session-recovery.md)
still apply. Hitting the history limit stops writes with instructions to branch
or start a new session. Branching preserves the source history and copies the
current retained projection; it does not claim that omitted messages are present.

## Transfers, safety branches and failure recovery

Transfer files must be regular files inside the current project with existing,
non-symlink parent directories. The shared permission resolver checks scope,
mode, hooks and project policy. Export uses an exclusive private file and refuses
overwrites, including concurrent writers. Import checks read permission and the
`session_import` mutation before creating its inactive destination; branching
checks `session_branch`. These operation names can be governed by project policy.

A version 1 `calliope-session` bundle contains creation time, source session/
revision/state hash, head link, committed ancestry, current `toolState` files and
a checksum over the envelope. The total file limit is 81 MiB; tool state is
limited to 1,000 allowlisted files and 16 MiB before JSON escaping. Supported
files are `todos.txt`, `active-todo.json`, `ledger.json`, and `plans/*.json`.
Structured tool files are validated before installation. Tool state is captured
at transfer/branch time, not reconstructed at historical conversation revisions.

Imports retain original immutable event IDs and owners. Subsequent destination
events link to the imported head while using the destination's session ID.
Full validation precedes destination creation, and the final snapshot is the
commit marker after tool files and events have been installed. A failed import
may leave an inactive partial session; it cannot be resumed without a committed
snapshot. Preserve it for inspection and retry into a new destination.

Terminal, headless and ACP create one safety branch per turn before the first
allowed tool assessed as medium, high or critical risk. Parallel risky tools
wait for the same branch. Permission denial creates no safety branch; branch
failure prevents the proposed tool from starting and prevents inference retry.
Cancellation stops waiting work before dispatch. The run log records the source
revision and branch ID, and each client displays the recovery ID. A safety
branch preserves conversation and session-owned tool state; workspace recovery
still requires the existing Git checkpoints or a separate backup.

Session tool files are separate from the conversation journal. A different
process editing them concurrently is not a multi-file transaction. Use an idle
session for manual branch/export; do not infer that an interrupted tool's
filesystem mutation succeeded from its saved call alone. Automatic branches
capture state before the first risky dispatch in their turn.

If a lock remains after a crash, verify its process has stopped before removing
that lock. Never overwrite damaged records to make a checksum pass. Retain the
original, inspect a known revision with replay, or import a known backup.
