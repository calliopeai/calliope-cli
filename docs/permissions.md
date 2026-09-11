# Permission decisions and saved approvals

Terminal, headless and ACP tools use `resolvePermission` from `src/runtime`.
Every result is `allow`, `deny`, `confirm` or `cancelled`, with a deciding layer,
a reason and elapsed time. The reason reaches the client, model and
`policy_event` audit; events include the tool call ID.

## Checks and client defaults

1. Plan mode permits `think`, `ask_question`, `create_plan`, `read_file` and
   `list_files`.
2. Scope, advisory shell blocklist and required sandbox availability must permit
   execution; pre-tool hooks and configured external policy may veto it.
3. When client confirmation applies, reuse a matching grant or request approval.
   Missing callbacks, errors, unknown answers and queue overflow fail closed.
4. After approval or grant lookup, recheck operation identity and all gates.
   Changed arguments, project identity, policy configuration, scope or session
   invalidate the pending choice. Expired/revoked grants cannot be reused.
5. The executor checks scope and required sandbox again immediately before use.

| Client | Confirmation default |
| --- | --- |
| Terminal | With confirmation enabled, prompt for medium/high/critical risk, including ordinary file mutations |
| Headless | No prompt; invocation authorizes execution subject to hard gates, with no grant store attached |
| ACP | Prompt for mutating tools and tools flagged for confirmation; a client unable to answer denies execution |

An approval only satisfies confirmation. It cannot override plan mode, scope,
hooks, external policy or a missing required sandbox. Hooks and external policy
may run twice; write these checks to tolerate repeated evaluation. They can have
side effects before cancellation, which Calliope cannot undo.

## Terminal controls

The dialog shows the risk reason, complete canonical path, complete command or
operation when present, and an argument fingerprint. File content is represented
by size and SHA-256 rather than printed. Known credential formats are redacted;
terminal control and bidirectional formatting characters are escaped.

| Key | Action |
| --- | --- |
| Y | Approve this attempt once |
| S | Approve this exact file operation for this session, at most 24 hours |
| P | Approve this exact file operation in this project for 30 days |
| N | Deny this tool attempt |
| Escape | Cancel the turn, including other queued approval requests |

Reusable grants are available only for the built-in `read_file`, `list_files`,
`write_file` and `edit_file` tools, with a resolved target inside the project
and noncritical risk. Reads normally need no confirmation. Changed content or
other arguments require a new grant. Shell, code, git, plugins, critical actions
and operations outside the project cannot receive reusable grants. Arbitrary
code can indirectly publish or communicate, so a shell command is never deemed
safe for reuse by string matching.

Parallel tool requests enter a FIFO of at most 100 entries. Each dialog has a
unique ID; stale replies do nothing. Cancellation removes pending requests
immediately, and unmount/reset cancels the queue. Provider/session changes are
blocked while a turn runs. Session grants do not transfer to a new session,
branch or imported session, and disappear when the process exits. Project grants
are independent of session history and are never included in session exports.

Inspect and reduce authority without inference or provider credentials:

```text
/permissions
/permissions list
/permissions revoke <grant-id>
/permissions reset
calliope permissions --json
calliope permissions revoke <grant-id> --json
calliope permissions reset --json
```

Reset revokes every grant for the current project; revoke selects one ID. These
are explicit user commands and can only remove authority. Session grants appear
only in the terminal that owns them. A separate headless process sees project
grants. The list shows tool, scope, expiry and operation fingerprint; audit events
link grant IDs to the original tool call.

## Local schema and bounds

`src/approvals` owns version 1. Project grants live in
`~/.calliope-cli/approvals/history.json` (0600, directory 0700 by default).
The envelope is `{ "version": 1, "events": [...] }`.

| Record | Fields |
| --- | --- |
| Event | `version: 1`, unique `id`, `at` (epoch milliseconds), `previous` hash or null, `change`, `hash` |
| Grant change | `type: "grant"`, `grant` |
| Revoke change | `type: "revoke"`, `projectKey`, `grantId` |
| Reset change | `type: "reset"`, `projectKey` |
| Project grant | `version: 1`, `id`, `projectKey`, `key`, `tool`, `scope: "project"`, `createdAt`, `expiresAt` |

`projectKey` hashes canonical root path, device and inode; replacing the root
invalidates its grants. `key` hashes the tool, complete canonical JSON arguments,
resolved target, project key and current scope/sandbox/policy/hook/trust
configuration. It does not hash the contents of arbitrary external policy
scripts; those checks still execute on every attempt. Raw arguments, file
content, commands, credentials and project paths are not persisted in this store.
Fingerprints can reveal equality and are not encryption for guessable values.

Events are logically append-only. Under an exclusive lock, a private temporary
file is fsynced and atomically renamed after checking the original directory
identity and contents. Revoke/reset add events; they never edit earlier events.
Strict schema, type, UUID/hash-link, timestamp, file-type and size checks reject
malformed history. Symlinks and group/world-writable stores are refused.
Checksums detect corruption, not forgery by an actor already able to write the
whole store. Calliope file tools block aliases into its state directory and the
native sandbox denies approval-store access; full host access remains powerful.

Bounds: 5,000 events, 4 MiB on disk, 1,000 in-memory session grants, JSON depth
32 and 16 MiB per operation. At 4,999 events reuse is disabled and one final
revocation event remains available. Expired grants stop authorizing immediately;
their audit history is retained. Capacity exhaustion disables reuse instead of
automatically deleting audit evidence. A malformed store fails permission lookup
closed; it is never silently reset.

## JSON and audit contracts

`calliope permissions ... --json` emits one JSON object and newline. Success:

```json
{"version":1,"type":"permissions","localOnly":true,"action":"list","project":"/project","grants":[],"events":0,"disabled":false}
```

Failure has the same `version`, `type`, `localOnly` and an
`error: { code, message }` instead. Exit codes: 0 success, 1 records unavailable,
2 invalid arguments, 130 cancellation. This command neither probes providers nor
creates approvals. JSON output may include a private project path; treat it as
local diagnostics.

`policy_event` retains its existing shape and adds optional `operationKey`,
`grantId`, `grantScope` and `grantExpiresAt` fields for confirmation evidence.
New grants and reused grants are distinguished in the reason. Once/deny/cancel
and later policy denials remain visible. Revocation commands also add a user
policy event. Known secret formats are redacted from policy reasons.

## Recovery and limits

For a writer lock, wait for the owning CLI process to finish. After a crash,
verify that process is gone before manually preserving and removing the stale
`history.json.lock`; Calliope never guesses that another writer is dead.

For damaged or full history, stop CLI instances, preserve a private copy of the
entire approval directory, inspect the reported problem, and archive it outside
the active store before beginning a fresh store. Preserve the archive as audit
evidence; starting fresh discards all authority and requires new approvals.
Session grants already in memory disappear on process exit.

Scope checks and blocklists cannot eliminate every filesystem race and are not
OS/container isolation. Headless confirmation defaults and the user-controlled
confirmation toggle are unchanged. This layer does not enforce the later
orchestration/self-improvement publication rules, provide signed audit history,
or persist pending UI requests across a crash. See [runtime](runtime.md) and
[sandbox modes](features.md#sandboxing) for execution boundaries.
