# Gateway replay and usage follow-up — September 13, 2026 UTC

The [machine-readable audit](reports/provider-gateway-followup-2026-09-13.json) adds ten real-wire captures and completes the seven available-provider checks left open by the [earlier semantic audit](provider-semantic-followup.md). The capture protocol, exact tool-result marker, SDK adapters and release assertions are unchanged. Old captures and all failed/incomplete reservations remain retained.

| Adapter | Newly completed evidence | Observed model/path |
| --- | --- | --- |
| Together | Tool-result replay | Live-listed GLM-5.3-Flash |
| Hugging Face | Tool-result replay | Live Novita mapping to Qwen3-Coder-480B |
| LiteLLM | Tool-result replay; usage in text/tool streams | Local LiteLLM to Together GLM-5.3-Flash |
| Bedrock-compatible | Tool-result replay; usage in text/tool streams | Local LiteLLM Converse to US Haiku 4.5 |
| OpenAI-compatible | Usage in text/tool streams | Local Ollama Devstral |

The corpus now holds 75 basic captures covering 56/72 unique combinations, and 59 semantic captures covering 59/72 combinations. Usage requires provider-reported counts in all four basic modes; the new streaming receipts complete the three historical usage gaps. Readiness aggregates evidence by adapter across selected models, including earlier JSON captures; it does not certify every mode for every model. Readiness tests remove each mode's successful usage evidence independently and confirm it becomes incomplete again, even while the older captures remain available.

## What did not pass

Three Qwen3.5 probes through Together/Hugging Face returned empty final assistant content. A bounded diagnostic observed a separate short reasoning field; it was not treated as final text. Those attempts remain incomplete. The diagnostic retained field names, lengths and hashes, not reasoning content.

Together's live catalog also listed Qwen3-Coder-480B with prices, but inference returned HTTP 400 directly and through LiteLLM. Four reservations were retained, including two usage probes already scheduled against that gateway. The successful Together/LiteLLM captures use a different live-listed model. Model listing alone does not establish working inference access.

One overlapping local harness invocation was rejected by the ledger before any HTTP request or reservation. Its intent and terminal result were reconciled, and the private driver gained an exclusive lock before continuing. The successful Hugging Face probe has separate intent and reservation IDs. The public audit labels the reconciled intent timestamp and does not invent an exact terminal time.

## Bounds and provenance

Eighteen probe invocations produced ten captures, three incomplete results, four HTTP-failed probes and one pre-dispatch admission failure. The 24 actual request reservations reconcile exactly with the existing ledger. Prompts were fixed public fixtures; no returned tool executed. Requests allowed at most 512 output tokens, 5,000 reserved input tokens, a 30-second deadline and no automatic retry. The private driver imposed an additional $0.50 incremental ceiling within the existing $50 follow-up / $500 cumulative limits.

New conservative reservations total **$0.102897606**. The existing follow-up retains **$2.065690776 of $50**, and the cumulative ledger retains **$53.662421017 of $500**. These amounts are reservations, not invoices; no historical reservation, budget ID or limit was reset.

Together prices came from its live models API. Hugging Face's live [model metadata](https://router.huggingface.co/v1/models) supplied Novita's mapping, tool support and token prices. The Bedrock allowance of $2/$10 per million exceeds AWS's documented [US-zone Haiku 4.5 rates of $1.1/$5.5](https://aws.amazon.com/jp/blogs/news/amazon-bedrock-now-supports-japan-cross-region-inference/). Local Ollama has no provider token charge. The temporary LiteLLM 1.100.1 gateways used zero retries and a 25-second upstream timeout; both were stopped, and the local port was confirmed closed. Each gateway capture names its upstream model.

Credential scans covered serialized captures and decoded request/response bytes before promotion. All ten captures replay through the real SDK/parser code in the offline suite. They establish behavior for their selected models and paths at capture time, not every model or future provider availability.

## Publication status

The unchanged release gate remains closed on **33 product checks**: eight each for OpenAI Chat, OpenAI Responses and Cerebras, plus nine for user-deferred xAI. The previous OpenAI HTTP 429 and Cerebras HTTP 402 observations remain authoritative access evidence for this report; those providers were not retried here. Media remains deferred. No package, tag or public release was published by this follow-up.
