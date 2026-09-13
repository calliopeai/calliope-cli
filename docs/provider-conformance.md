# Provider conformance

The next release has one behavioral contract for text, tool calls, finish reasons,
usage, instruction preservation, tool-result association and cancellation.
`npm run test:conformance` exercises every adapter with the actual installed SDKs;
only HTTP transport is intercepted. Synthetic streams split frames into seven-byte
chunks, including UTF-8 boundaries. These tests are deterministic and offline.

| Adapter paths | Wire format | Intentional differences |
|---|---|---|
| Anthropic | JSON / named SSE | All system instructions are combined in order; native tool IDs retained. |
| Google | JSON / SSE | Function results are associated by function name; Calliope generates internal call IDs. All system directives become `systemInstruction`. |
| OpenAI Chat Completions | JSON / SSE | Requests streamed usage, including usage-only terminal chunks. |
| OpenAI Responses | JSON / named SSE | Separate completed/incomplete/failed events; native call IDs differ from output-item IDs. |
| OpenRouter, Together, Groq, Fireworks, Mistral, DeepSeek, xAI, Cerebras, Hugging Face | OpenAI-compatible JSON / SSE | Usage is consumed when supplied. Missing usage stays unavailable, with a visible notice that accounting is incomplete. Hugging Face discovery and inference use `router.huggingface.co/v1`. |
| LiteLLM, Bedrock compatibility endpoint, generic OpenAI compatibility endpoint | OpenAI-compatible JSON / SSE | Endpoint/shim capabilities vary. The suite tests the unmodified protocol; existing shim tests cover documented tool stripping. |
| Ollama native | JSON / NDJSON | Internal call IDs are generated; incomplete JSON records survive chunk boundaries. Malformed frames, server error envelopes and streams missing their final frame fail. |
| Bedrock native Converse | JSON / binary AWS event stream | SigV4 signing and native call IDs; capture output caps are applied before signing. |

A length limit maps to `length`; a filtered, failed or refused completion maps to
`error`, preserving the existing four-value response contract. Tool calls are
never executed by conformance probes. Runtime tests separately establish permission
and execution semantics. Reported token usage is not an independent measurement of
provider billing; absent usage cannot support complete token/cost totals.

## Real-wire release evidence

**56 of 72 required combinations have real captures**, collected on September 11,
2026 UTC. Fourteen adapter paths passed text and tool probes in JSON and streaming
mode. Additional captures cover Claude Fable 5/5.1 and GPT-6 Astra via OpenRouter. The
[follow-up report](provider-live-followup.md) records newly working credentials,
the explicit xAI deferral, provider failures and retained budget reservations.
The [original live test report](provider-live-testing.md) records earlier models,
local server versions and gateway routing. Synthetic HTTP shapes remain
useful regressions, but cannot establish what every deployed provider sends.
`tests/fixtures/provider-wire/` stores only reviewed captures with origin metadata,
model, timestamp, SDK versions, response bytes and checksums. Generated call IDs are
excluded from normalized expectations; function names and arguments are asserted.

`npm run test:conformance:release` requires a text and tool capture in JSON and
streaming mode for each of the 18 active adapter paths (72 combinations). It fails while
any are missing. `prepublishOnly` also requires the nine-check product gate, including extended semantic captures and usage; ordinary CI remains fully offline
and tests any captures that have been checked in. The default suite skips the
readiness assertion explicitly rather than reporting captured coverage as passing.

With authorization for the chosen provider/model and spending, capture one fixed
toy probe at a time:

```sh
npm run capture:provider -- --help
npm run capture:provider -- --live --provider <adapter-id> --model <model-id> \
  --scenario tool --stream --output tests/fixtures/provider-wire/<name>.json \
  --ledger /private/local/probe-budget.json --max-cost-usd 500 \
  --run-id model-smoke-20260911 --max-run-cost-usd 5 \
  --input-usd-per-million <verified-input-rate> \
  --output-usd-per-million <verified-output-rate>
```

The recorder uses configured credentials without storing them, allows one HTTP
request, defaults to 64 output tokens (configurable from 1–512), times out after
30 seconds, caps stored responses at 1 MiB, and refuses to overwrite files.
Before network I/O it reserves a conservative 5,000 input tokens plus the output
cap at the supplied model rates against the ledger's total dollar limit. The
request body is bounded to 4,000 UTF-8 bytes, leaving an allowance for protocol
overhead. Rates must be verified for the selected model; zero rates are appropriate
only for local or unbilled inference. Failed/unknown requests keep their reservation.
This token reservation does not bound separate provider-internal research or
search fees. Models with mandatory extra charges need separate fee bounds and
billing evidence before further probes; an output-token cap alone is insufficient.
An exclusive lock prevents concurrent overspend; a crash leaves the lock in place
for inspection, never automatic refund. Each ledger permits at most 1,000 probes.

The example uses the explicitly authorized $500 cumulative ceiling and $5 per-run
ceiling for this testing campaign; these are not default spending allowances.
Both limits are enforced by the same atomic reservation. Keep one ledger across
runs and the same `--run-id` across restarts. Once a ledger has run records,
omitting the run flags is rejected. Changing an existing run's cap is rejected;
failed and cancelled requests still count toward both ceilings. A new run never
resets cumulative reservations. Do not start new runs merely to bypass a run cap.
The version-1 ledger adds `runs: [{ id, limitNanoUsd }]` and a `runId` reference
on new reservations; historical unscoped reservations remain in the total.

It reads no project context and executes no returned tools. Credentials and request
headers are excluded from stored metadata. Review the decoded response, origin
and expected result before committing it: checksums detect changed bytes, not a
fabricated provenance claim. A failed or noncompliant probe is not release evidence.

The remaining combinations and additional semantic captures remain tracked in
[#222](https://github.com/calliopeai/calliope-cli/issues/222) and
[#262](https://github.com/calliopeai/calliope-cli/issues/262). The gate remains closed
for OpenAI Chat/Responses, xAI and Cerebras. The user
deferred xAI live testing; its four missing cases stay visible and are not counted
as passing. AI21 is retired and explicitly excluded from active coverage. Gateway
captures count only for the adapter actually invoked.

Run `npm run providers:readiness -- --json` for a versioned offline inventory,
or, after building, `node scripts/conformance/report.mjs --json` for JSON-only
stdout. `--output <new-file>` saves a private snapshot without overwriting another
file. Credential presence is separate from historical evidence and does not prove
current access. The nine-check product matrix also tracks cancellation, provider
errors, usage, system instructions and tool-result replay. Missing extended wire
evidence remains missing even when synthetic regression tests pass; use
`--require-ready` to fail on any incomplete product check. This inventory is not
the phase-2 runtime health subsystem.

## Extended semantic captures

`npm run capture:semantics -- --help` describes the opt-in runner. It retains the
same persistent ledger and per-request output/input bounds as basic captures.
Tool-result replay uses two independently reserved requests; the other scenarios
use one. Every request has a 30-second deadline. HTTP redirects and SDK retries
cannot create hidden extra wire requests. OpenRouter probes additionally bind
`provider.max_price` to the reservation rates and disable provider fallbacks.

```sh
npm run capture:semantics -- --live --provider <adapter-id> --model <model-id> \
  --scenario tool-result-replay --max-output-tokens 128 \
  --output /private/local/new-capture.json \
  --ledger /private/local/probe-budget.json --max-cost-usd <authorized-total> \
  --run-id <existing-run-id> --max-run-cost-usd <authorized-run-limit> \
  --input-usd-per-million <verified-rate> --output-usd-per-million <verified-rate>
```

The scenarios are `system-instructions`, `tool-result-replay`, `provider-error`
and `cancellation` (requires `--stream`). Successful instruction/replay checks
require the exact public marker, with no extra tools; noncompliant or truncated
replies remain incomplete. Error checks require a complete HTTP error response
and adapter rejection. A successful completion in an error check is incomplete
negative evidence, and does not mean inference access failed.

Cancellation now observes the live body rather than buffering it to completion.
It aborts after actual bytes arrive and records that the adapter rejected and its
local response body reached a terminal state. This does not establish when a
remote provider stopped computing or billing. A local HTTP integration test also
checks connection closure while the server deliberately leaves the stream open.
Tests additionally cancel from an emitted token with terminal frames already
buffered; no adapter may return success after that cancellation.

The version-1 `provider-semantic` schema stores backend/model/scenario, stream
mode, output cap, provenance and one or two turns. Each turn has its own budget
reservation ID; a fixed public request and response encoded as base64 with SHA256
checksums; method/path/status/content-type; complete/body-closed flags; and a
strict expected outcome. Headers other than response content-type, query strings
and exception objects are excluded. Request bodies contain only the fixed toy
conversation and provider state derived from its first response. Returned tools
never execute. Known credentials and recognizable key material are refused,
without modifying bytes to manufacture a passing transcript. Review decoded
content before adding any capture to `tests/fixtures/provider-semantic/`.

`probeVersion: 2` clarifies that a tool's returned marker can differ from its input;
version 1 remains replayable and is the default for older records without this
field. Both versions require the same exact output. Gateway provenance identifies
the local server/version and actual upstream. OpenRouter price limits are recorded
and checked against the request. Replay reconstructs both turns through actual
SDKs, carries provider metadata, and compares the request bodies and results.
Only generated Ollama call IDs are excluded from equality; native IDs stay intact.
Checksums provide tamper detection, not independent proof of where bytes came from.

The [September 13 semantic follow-up](provider-semantic-followup.md) records initial
coverage and limitations; the [gateway follow-up](provider-gateway-followup.md)
completes seven further replay/usage checks. `providers:readiness` includes both corpora. The mandatory
release gate now fails for *any* missing basic, semantic or usage check; deferrals
and incomplete results remain visible. No publication bypass was added.
