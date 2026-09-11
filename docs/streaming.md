# Streaming and tool output

The terminal replaces a failed response attempt before retrying. Partial text
stays in the live display; only the validated completed response enters the
conversation. Assistant prefaces accompanying tool calls are retained. Esc
clears the active display immediately and propagates cancellation through the
runtime; settled attempts ignore late chunks and discard pending display timers.

The shared provider dispatcher permits at most three attempts, with bounded,
cancellable retry delays. A streaming client opts into replacement through
`ChatOptions.onStreamReset`; it must remove the previous attempt's text when
called. Clients without this callback stop with `StreamInterruptedError` after
an emitted partial response. That prevents append-only clients, including ACP,
from receiving duplicate prefixes. The runtime also prevents its outer retry
handler from repeating an interrupted or malformed stream. An explicit later
prompt may continue from the last committed conversation. Headless turn JSON
and ACP JSON-RPC schemas remain unchanged.

Provider failures are errors, never assistant tokens. The terminal distinguishes
assistant text, tool results, explicitly submitted `think` tool text, and status.
It does not synthesize provider-private reasoning. Active tools have separate
call IDs, phases and elapsed times; output chunks do not restart their clocks.
The display shows eight active tools plus an omitted count, with at most 256
tracked entries. Cancellation clears that state and stops the display timer.

## Attempt events

A run-log `stream_attempt` event contains a versioned `stream` object:

```json
{"version":1,"id":"UUID","attempt":1,"state":"started","emittedChars":0}
```

States are `started`, `completed`, `failed`, `cancelled`, and `retrying`.
`retrying` includes `delayMs` (0–30,000). A failed attempt and its retry notice
share an ID; the next attempt has a new ID. Cancellation during a retry delay
adds `cancelled` to the waiting attempt. `emittedChars` counts UTF-16 code units,
bounded to 1,048,576 per attempt. Context identifies iteration, provider and model.
These events contain no response text, tool arguments or provider error body.
Audit replay validates and displays this metadata without executing anything.

## Inspecting tool output

```text
/tools
/tools last
/tools OUTPUT_ID
calliope session outputs SESSION_ID --json
calliope session outputs SESSION_ID OUTPUT_ID --json
```

The terminal stores a compact preview in scrollback. `/tools` lists retained
records; selecting one opens a live viewer. E or Enter collapses/expands it;
N/P, arrows or Page Down/Up change pages; Esc closes it. Grapheme-aware wrapping
and pagination follow terminal dimensions without altering stored text or
rewriting previously emitted scrollback. The viewer labels failed, unsaved and
truncated records. Approval dialogs take precedence over this read-only viewer.

The headless command uses the version 1 `session` envelope and existing exit
codes. `action: "outputs"` contains `sessionId`, `dropped`, and either `records`
(metadata without content) or the selected `record` (including content). Selection
is limited to the current project. These commands require no provider request.

## Storage schema and bounds

Each session's private `tool-output.json` has `{version: 1, dropped, records,
checksum}`. The checksum covers the serialized envelope without its checksum.
Each record contains:

| Field | Meaning |
| --- | --- |
| `version`, `id` | Schema 1 and immutable UUID. |
| `toolCallId`, `tool`, `channel` | Source call, tool name, and `tool` or `thinking`. |
| `content` | Retained display text, with known credentials redacted and terminal controls escaped. |
| `sourceChars`, `truncated` | Original UTF-16 length and whether capture omitted content. |
| `isError`, `createdAt` | Tool outcome and ISO timestamp. |
| `hash` | SHA-256 of retained content. |

Capture keeps the result and, when different, its tool preview. Successful `think`
calls retain their explicit `thought` argument. Capture processes at most 131,072
source characters and retains at most 65,536 characters per record. The store
keeps at most 100 records and 4 MiB of serialized data, evicting oldest records
with an incremented `dropped` count. Audit `tool_result` entries retain output ID,
hash, truncation and save status after cache eviction. Hashes detect corruption;
they do not authenticate an imported record's author.

Writes use a private exclusive lock, fsync and atomic rename, verify directory
identity and prior content, and refuse symlinks, duplicate IDs, malformed state
or concurrent changes. A failed output save warns without repeating the completed
tool. The terminal retains unsaved results in a separate current-session cache,
limited to 100 records and 4 MiB; those results disappear on eviction, reset,
session switch or process exit. Saved results are read from disk on demand.
Library callers opt into capture with `captureToolOutput`; terminal, headless
and ACP enable it. Conversation checkpoints remain independently authoritative.

Output files are local private session data, not a guarantee of comprehensive
content classification. Known-secret redaction cannot identify every confidential
value. Session branch/export/import includes the bounded output file and validates
its schema and hashes; transferred text remains private data. Output state is
copied at branch/transfer time, not reconstructed for historical conversation
revisions. Old audit references may point to expired records.

If a writer crashed, verify it stopped before removing its lock. Preserve damaged
output files rather than overwriting them to force a successful check; use a
known backup or start a new session. A missing output cache never proves whether
a tool mutation completed. Inspect the workspace and conversation checkpoint
before explicitly retrying interrupted work.
