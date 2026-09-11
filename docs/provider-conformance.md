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
| OpenRouter, Together, Groq, Fireworks, Mistral, Hugging Face | OpenAI-compatible JSON / SSE | Usage is consumed when supplied. Missing usage stays unavailable, with a visible notice that accounting is incomplete. Hugging Face discovery and inference use `router.huggingface.co/v1`. |
| AI21 legacy Studio adapter | OpenAI-compatible JSON / SSE | The configured service returned HTTP 410 on September 11, 2026. Its retirement must be resolved before release; synthetic coverage does not establish availability. |
| LiteLLM, Bedrock compatibility endpoint, generic OpenAI compatibility endpoint | OpenAI-compatible JSON / SSE | Endpoint/shim capabilities vary. The suite tests the unmodified protocol; existing shim tests cover documented tool stripping. |
| Ollama native | JSON / NDJSON | Internal call IDs are generated; incomplete JSON records survive chunk boundaries. Malformed frames, server error envelopes and streams missing their final frame fail. |
| Bedrock native Converse | JSON / binary AWS event stream | SigV4 signing and native call IDs; capture output caps are applied before signing. |

A length limit maps to `length`; a filtered, failed or refused completion maps to
`error`, preserving the existing four-value response contract. Tool calls are
never executed by conformance probes. Runtime tests separately establish permission
and execution semantics. Reported token usage is not an independent measurement of
provider billing; absent usage cannot support complete token/cost totals.

## Real-wire release evidence

**36 of 64 required combinations have real captures**, collected on September 11,
2026 UTC. Nine adapter paths passed text and tool probes in JSON and streaming
mode. The [live test report](provider-live-testing.md) records models, local server
versions, gateway routing, access failures and spend. Synthetic HTTP shapes remain
useful regressions, but cannot establish what every deployed provider sends.
`tests/fixtures/provider-wire/` stores only reviewed captures with origin metadata,
model, timestamp, SDK versions, response bytes and checksums. Generated call IDs are
excluded from normalized expectations; function names and arguments are asserted.

`npm run test:conformance:release` requires a text and tool capture in JSON and
streaming mode for each of the 16 adapter paths (64 combinations). It fails while
any are missing. `prepublishOnly` runs this gate; ordinary CI remains fully offline
and tests any captures that have been checked in. The default suite skips the
readiness assertion explicitly rather than reporting captured coverage as passing.

With authorization for the chosen provider/model and spending, capture one fixed
toy probe at a time:

```sh
npm run capture:provider -- --help
npm run capture:provider -- --live --provider <adapter-id> --model <model-id> \
  --scenario tool --stream --output tests/fixtures/provider-wire/<name>.json
```

The recorder uses configured credentials without storing them, allows one HTTP
request, defaults to 64 output tokens (configurable from 1–512), times out after
30 seconds, caps stored responses at 1 MiB, and refuses to overwrite files.
It reads no project context and executes no returned tools. Credentials and request
headers are excluded from stored metadata. Review the decoded response, origin
and expected result before committing it: checksums detect changed bytes, not a
fabricated provenance claim. A failed or noncompliant probe is not release evidence.

The remaining 28 combinations and additional error captures remain tracked in
[#222](https://github.com/calliopeai/calliope-cli/issues/222). The gate remains closed
for OpenAI Chat/Responses, Google, OpenRouter, Groq, Fireworks and the retired AI21
adapter. Gateway captures count only for the adapter actually invoked.
