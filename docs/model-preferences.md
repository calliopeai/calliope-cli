# Provider and model controls

Use `/provider` to open the provider picker, `/provider list` for local health,
and `/model` or `/model list` to open discovered models. Provider names come from
the adapter registry. The picker shows credential status and recent health,
including quarantine and expiry; listing providers does not make inference calls.
Model details show discovered context/output capacity, tool support, and an
estimate for 1,000 input plus 250 output tokens. Missing prices and limits remain
unknown; an explicitly reported zero price is distinct from unknown cost.

`/provider <name>` and `/model <id>` change the current session. They validate
live eligibility before changing state and explain the result. `auto` is a valid
provider choice. A provider switch clears the previous model override. An
explicitly incompatible model is rejected; unavailable discovery follows the
visible explicit-choice fallback described in [Routing](routing.md). Opaque
reasoning/tool metadata can prevent a provider switch; the conversation is
preserved and the control reports the reason.

Discovery is cancellable with Escape. Model listing and background discovery
have 30-second deadlines. Control validation uses the shared routing deadlines.
A cancelled or failed control leaves the previous session selection intact.

## One turn and one invocation

```text
/once --provider <provider> --model <discovered-id> -- Explain this function
/once --model <discovered-id> -- Review this change
calliope --headless --json --provider <provider> --model <discovered-id> "Say hello"
calliope --headless --json --provider <provider> -- "Explain --model literally"
```

`/once` requires at least one override and the `--` delimiter. The choice applies
to that entire turn, including tool continuations and retries. It is never saved
as a session, project or global default. CLI flags apply to the current invocation;
interactive provider/model switches can subsequently replace them.

Each queued message snapshots the session selection when submitted. A queued
`/once` applies only to that message. Editing a queued message retains its original
base selection; removing its `/once` flags restores that base. Messages run
separately in submission order, using the current session mode and permission
settings when each turn starts. Failure or cancellation pauses pending messages,
and interrupt-and-send waits for the cancelled turn to stop before dispatching.
Queues hold at most 100 messages, each at most 1 MiB; one drain processes at most
100 turns. Pending queue state currently lives in memory. Recorded conversation
and routing events use the existing session/run stores.

## Precedence and project defaults

The effective selection follows this order, highest priority first:

1. Temporary turn override, or explicit flags for a headless invocation.
2. Explicit session selection, including interactive startup flags.
3. `CALLIOPE_PROVIDER` and `CALLIOPE_MODEL` environment settings.
4. Trusted project defaults.
5. Global `defaultProvider` and `defaultModel` configuration.

Changing provider at a higher layer discards an inherited model from a different
provider. An absent model lets routing choose using live discovery and any stored
`providers.<name>.model` preference. Headless and ACP use the same resolver;
headless startup never opens interactive setup or prints a banner into JSON.
Routing events add `preferenceSources` for provider and model while retaining
the existing version 1 decision and headless event envelopes.

`/defaults` shows project defaults and the resolved selection for a new session.
`/defaults save` records the current requested provider/model for that project;
`/defaults reset` writes an empty selection. These commands leave the current
session choice intact. Global preferences remain explicitly editable in the
configuration file shown by `calliope --config`, or through the setup wizard.

The selected canonical project directory is the scope. Defaults are read from
`.calliope-models.json` in that directory, without searching parent checkouts.
Trust that canonical directory with `/trust add` before loading its settings.
Untrusted defaults are ignored with a warning. Malformed trusted defaults stop
loading with an error; repair the file before retrying. Explicit session choices
survive a project/default reload; inherited settings are resolved again.

```json
{
  "version": 1,
  "updatedAt": "2026-09-11T00:00:00.000Z",
  "selection": { "provider": "auto", "model": null }
}
```

Only provider and model are allowed inside `selection`. The schema is versioned,
limited to 64 KiB, and rejects symlinks and non-regular files. Unknown top-level
extension fields are preserved on update. If this file is absent, trusted legacy
`.calliope`, `.calliope.conf` or `calliope.conf` provider/model fields may be read;
their commands are not executed. Reset suppresses legacy fallback without
modifying the legacy file.

## Write policy and recovery

Saving is an explicit user mutation, checked against project scope, pre-tool
hooks and policy. A policy denial or cancellation prevents the write. The audit
records the exact target, selection, before/after digests, policy result and
write outcome, without copying unrelated file content. Writes use an exclusive
lock, compare the original contents after approval and under the lock, then
rename a unique temporary file. File and directory replacement during approval
is rejected.

After an interrupted writer, inspect `.calliope-models.json.lock` and verify its
recorded process has stopped before removing that lock. Retry after inspecting
the defaults file. The implementation does not steal locks, overwrite malformed
files, change trust, or erase source configuration to recover automatically.
