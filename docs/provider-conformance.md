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

**36 of 72 required combinations have real captures**, collected on September 11,
2026 UTC. Nine adapter paths passed text and tool probes in JSON and streaming
mode. The [live test report](provider-live-testing.md) records models, local server
versions, gateway routing, access failures and spend. Synthetic HTTP shapes remain
useful regressions, but cannot establish what every deployed provider sends.
`tests/fixtures/provider-wire/` stores only reviewed captures with origin metadata,
model, timestamp, SDK versions, response bytes and checksums. Generated call IDs are
excluded from normalized expectations; function names and arguments are asserted.

`npm run test:conformance:release` requires a text and tool capture in JSON and
streaming mode for each of the 18 active adapter paths (72 combinations). It fails while
any are missing. `prepublishOnly` runs this gate; ordinary CI remains fully offline
and tests any captures that have been checked in. The default suite skips the
readiness assertion explicitly rather than reporting captured coverage as passing.

With authorization for the chosen provider/model and spending, capture one fixed
toy probe at a time:

```sh
npm run capture:provider -- --help
npm run capture:provider -- --live --provider <adapter-id> --model <model-id> \
  --scenario tool --stream --output tests/fixtures/provider-wire/<name>.json \
  --ledger /private/local/probe-budget.json --max-cost-usd 1 \
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
An exclusive lock prevents concurrent overspend; a crash leaves the lock in place
for inspection, never automatic refund. Each ledger permits at most 1,000 probes.

It reads no project context and executes no returned tools. Credentials and request
headers are excluded from stored metadata. Review the decoded response, origin
and expected result before committing it: checksums detect changed bytes, not a
fabricated provenance claim. A failed or noncompliant probe is not release evidence.

The remaining combinations and additional semantic captures remain tracked in
[#222](https://github.com/calliopeai/calliope-cli/issues/222) and
[#262](https://github.com/calliopeai/calliope-cli/issues/262). The gate remains closed
for OpenAI Chat/Responses, Google, OpenRouter, Groq, Fireworks, DeepSeek, xAI and
Cerebras. AI21 is retired and explicitly excluded from active coverage. Gateway
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
