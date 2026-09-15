# Provider health and recovery

`calliope doctor --json` reports local provider observations without making a
network request or running setup. `/doctor`, `/doctor providers`, and
`/doctor provider <name>` expose the same subsystem in the REPL.

```sh
calliope doctor
calliope doctor provider deepseek --json
calliope doctor provider google --probe --timeout-ms 5000 --json
calliope doctor provider deepseek --reset
calliope doctor --export health.json
calliope doctor --import health.json
```

`--probe` explicitly permits model discovery. It bypasses cached models and
emergency fallbacks, sends no inference prompt, and observes the configured
endpoint. Each provider has a deadline (10 seconds by default), and an invocation
has a 60-second deadline. Ctrl+C cancels headless discovery; REPL operation
cancellation also cancels discovery, including AWS credential helper processes.
Missing credentials remain missing and cause a requested probe to fail.

## Report contract

JSON output is one document with `version: 1`, `type: "provider-health"`,
`generatedAt`, `localOnly`, `settings`, and `providers`. An error may omit settings
and return an empty provider list. Each provider reports:

| Field | Meaning |
| --- | --- |
| `provider`, `target` | Provider name and hashed endpoint/protocol/profile identity |
| `endpoint`, `protocol` | Sanitized address and actual adapter protocol |
| `credentials` | `configured`, `missing`, or `not-required`; presence does not validate a credential |
| `discovery` | Last local model discovery outcome, timestamp, and model count |
| `lastSuccessfulConformanceAt` | Last successfully captured individual local conformance probe; this does not certify the full release matrix |
| `latencyMs`, `sampleCount` | Mean elapsed adapter-attempt time and count in the recent window |
| `timeoutRate`, `retryRate`, `errorRate` | Fractions from 0 to 1 in that window; `null` means no samples |
| `capabilities` | Latest observed tools, streaming, cancellation, and usage evidence; absent evidence stays `"unknown"` |
| `lastSuccessAt`, `lastFailure` | Historical local success and sanitized last failure (category, timestamp, HTTP status) |
| `quarantine` | Active state, failure count, reason, and expiry |
| `remediation` | Actions appropriate to missing configuration or observed failures |
| `importedEvents` | Retained imported diagnostic records matching this target |

Attempts are calls through the shared provider adapter. SDK-internal retries
are included in that attempt's elapsed time; `retryRate` counts attempts retried
by the shared retry controller. Cancellation is recorded separately and excluded
from latency/error/retry denominators. Timeouts count as errors. Tool support is
observed when a tool call is returned; streaming when a stream request completes;
usage when both input and output counts are valid. These observations describe
requests to an endpoint, not a guarantee about every model it hosts.

Exit codes: `0` for a completed local report or successful requested probes,
`1` for unavailable diagnostics or unsuccessful probes, `2` for invalid
arguments, and `130` for cancellation. A local report returning zero is not a
provider readiness or release certification. Headless JSON stays on stdout;
interactive progress messages are presentation only.

## Quarantine and preference

Three consecutive failed adapter attempts within five minutes quarantine that
endpoint for one minute by default. Retries are attempts. Cancellation and
discovery failures do not trigger quarantine. Success or `--reset` clears the
failure sequence; reset appends an event instead of deleting failures.

Auto selection skips quarantined endpoints while retaining the existing
provider preference order. An explicitly selected provider receives a recovery
attempt with a visible warning containing the reason and expiry. Shared runtime
clients record that warning in the run's policy events. A successful recovery
clears quarantine. Switching endpoints or AWS profiles creates a new health
target; changing a credential for the same target preserves its history.

Unreadable history produces a warning during provider execution and an error
from doctor. Inference can continue while diagnostics are unavailable; doctor
does not silently erase or repair corrupt records. Quarantine cannot override
project permission policy. Capability, cost, and latency ranking are a separate
routing layer; see [Routing](routing.md) for current selection behavior and limits.

## Storage and schema

Records live locally in `~/.calliope-cli/provider-health`, or
`CALLIOPE_HEALTH_DIR` when explicitly set. Each immutable event has its own
`<epoch-ms>-<uuid>.json` file. A private temporary file is written and fsynced,
then published with an exclusive hard link. Concurrent writers use independent
UUIDs, so they cannot overwrite another event. New directories use mode 0700;
files use 0600. Symlink event files and symlink store directories are rejected.

The version 1 event schema is defined in `src/health/types.ts` and validated by
`src/health/store.ts`. Common fields are `version`, `id`, `at`, `source`,
`provider`, `target`, `type`, and `sha256`. Types are `attempt`, `discovery`,
`conformance`, and `reset`. Observations may include a bounded duration, retry
index, HTTP status, failure category, model count, and boolean capabilities.
Conformance events require an evidence hash. Imported records additionally have
`originId`. Unknown fields, invalid values, future timestamps beyond clock skew,
and mismatched checksums or filenames fail validation.

SHA-256 covers canonical JSON with recursively sorted object keys, excluding the
`sha256` field. This detects accidental corruption; it is not a signature and
does not protect against a local actor able to rewrite both data and checksums.
Prompts, response bodies, model names, credential values, raw errors, and raw
endpoint strings are not accepted by the event schema. Displayed endpoints omit
userinfo, query strings, fragments, and nonstandard path segments.

Retention defaults to 1,000 events and 30 days, whichever limit removes a record
first. Retention only deletes files matching the health event naming convention.
Reads enforce the same limits; publication prunes expired files. Limits apply
across providers. Retained events are append-only; reset and import never edit
an existing event. Metrics and historical timestamps cover retained evidence.

## Configuration, import, and recovery

Set `providerHealth` in the configuration file; omitted fields use defaults:

```json
{
  "providerHealth": {
    "retentionEvents": 1000,
    "retentionDays": 30,
    "failureThreshold": 3,
    "failureWindowMs": 300000,
    "quarantineMs": 60000,
    "probeTimeoutMs": 10000
  }
}
```

Export is `{ "version": 1, "events": [...] }` and refuses to overwrite an existing
file. Import accepts at most 10 MiB and the configured retention count, validates
the entire document before publication, and deduplicates origins. Imported
records receive new local IDs and remain labelled `imported`; they cannot change
local quarantine, capabilities, or routing. Filesystem failure during publication
may leave a partial import; retrying deduplicates already published records.

After authentication or quota failures, fix the account or credentials first,
then probe discovery and explicitly retry the provider or append a reset. For
corrupt history, preserve a copy for diagnosis and restore a known-good local
backup. Keep imports for comparing CI evidence; do not use them to replace local
operational observations. Health records are not uploaded automatically.

Continuous supervision reads these local records before each controller and
reviewer request. The execution journal stores a reduced, endpoint-free snapshot
of only the providers relevant to the reviewed plan, or an explicit unavailable
marker if history cannot be read. This snapshot is evidence for a bounded
hypothesis only; it cannot change pins, routing pools, quarantine policy, budgets,
permissions or any other reviewed authority. See
[continuous supervision](continuous-supervision.md#decisions-and-execution).
