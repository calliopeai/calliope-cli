# Extended provider semantics — September 13, 2026 UTC

Later that day, the [gateway follow-up](provider-gateway-followup.md) completed the seven replay/usage gaps described below. This report retains the original findings and reservations; its counts are historical.

The [machine-readable audit](reports/provider-semantic-followup-2026-09-13.json) records **55 reviewed real-wire captures across 17 adapter paths**, from 70 bounded probes and 90 independently reserved requests. Fifteen probes were incomplete: fourteen positive checks missed their exact expected result, and an OpenRouter negative/access check returned a successful HTTP 200 response. That access recovery led to passing positive OpenRouter checks. No incomplete result was promoted into the corpus.

| Adapter | System instructions | Tool-result replay | Cancellation | Provider error |
| --- | --- | --- | --- | --- |
| anthropic | Captured | Captured | Captured | Captured |
| google | Captured | Captured | Captured | Captured |
| openai-chat | Access blocked | Access blocked | Access blocked | Captured |
| openai-responses | Access blocked | Access blocked | Access blocked | Captured |
| ollama | Captured | Captured | Captured | Captured |
| bedrock-native | Captured | Captured | Captured | Captured |
| openrouter | Captured | Captured | Captured | Captured |
| together | Captured | Incomplete | Captured | Captured |
| groq | Captured | Captured | Captured | Captured |
| fireworks | Captured | Captured | Captured | Captured |
| mistral | Captured | Captured | Captured | Captured |
| deepseek | Captured | Captured | Captured | Captured |
| xai | Deferred | Deferred | Deferred | Deferred |
| cerebras | Access blocked | Access blocked | Access blocked | Captured |
| huggingface | Captured | Incomplete | Captured | Captured |
| litellm | Captured | Incomplete | Captured | Captured |
| bedrock-compat | Captured | Incomplete | Captured | Captured |
| openai-compat | Captured | Captured | Captured | Captured |

## What the wire revealed

- OpenAI Chat and compatible SDK iterators can end normally after cancellation. Explicit post-iteration checks now reject instead of returning an empty success. Additional tests cancel from an emitted token with final frames already buffered; Google, Ollama and native Bedrock needed the same terminal check. All 18 paths are exercised through real SDK/parser code.
- Native Bedrock returned a successful inference-profile listing with `nextToken: null`. Discovery incorrectly rejected it and lost the model list. The terminal cursor fix restored live discovery of 129 models while retaining page, malformed-cursor and repeat-cursor limits.
- The recorder now preserves `max_completion_tokens` when the OpenAI adapter uses it, instead of adding a competing legacy `max_tokens` field. It refuses redirects and records live chunks without waiting for the complete body.
- Mistral Large 3 and native Bedrock Haiku 4.5 passed tool-result replay after smaller models missed the exact marker. Local Qwen3 Coder passed replay through native Ollama and its compatible endpoint. Earlier incomplete results remain in the ledger.
- Together, Hugging Face routed to Together, and the two temporary LiteLLM gateway configurations still have incomplete exact tool-result evidence. This pass does not classify those providers as incompatible. Their observed output/finish/usage metadata and retained reservations are recorded for follow-up.

## Bounds and provenance

Positive models were selected from live provider catalogs or live Hugging Face provider mappings. Negative model probes deliberately use a fixed nonexistent ID to observe rejection; valid-model access rechecks separately preserve OpenAI HTTP 429 and Cerebras HTTP 402. Model discovery alone was never counted as successful inference.

Requests used fixed public toy prompts, at most 512 output tokens and a 30-second per-request deadline. Each turn reserved 5,000 input tokens plus its output cap; signed Bedrock requests were bounded before signing. No returned tool executed. OpenRouter requests carried maximum token prices and disabled provider fallbacks. Hugging Face routes were pinned to a live-listed Together mapping. Models with additional research/search fees were not selected.

The temporary LiteLLM 1.100.1 process used Together Llama 3.3 and native Bedrock Nova Micro, with zero retries and a 25-second upstream timeout; it was stopped after the probes. Ollama 0.33.2 supplied native and compatible local paths. Gateway provenance identifies the upstream without treating a gateway result as evidence for another adapter.

New reservations total **$0.192693170**. The existing follow-up run retains **$1.962793170 of $50**; the cumulative ledger retains **$53.559523411 of $500**. These are conservative reservations, not invoiced spend. All 90 IDs reconcile with the append-only reservation list; failures, incomplete responses and cancellations retain their amounts. No new run or cap reset was used.

The audit records a pricing-source correction for the native Haiku follow-up: newer Anthropic models use AWS Marketplace pricing and were absent from the regional Bedrock offer file. Its retained $2/$10 per-million allowance exceeds the documented [US-zone Haiku 4.5 rates of $1.1/$5.5](https://aws.amazon.com/jp/blogs/news/amazon-bedrock-now-supports-japan-cross-region-inference/). Nova Micro rates were verified against AWS offer version `20260911124408`; other rate sources are recorded per probe.

Cancellation captures prove client abort after actual bytes arrived, adapter rejection, and a terminal local response body. They do not prove when server computation or billing stopped. HTTP-error evidence covers rejected HTTP responses; in-band errors in otherwise successful streams remain covered by synthetic regressions, not by this new captured-error set.

## Release status

Publication remains blocked. The original corpus still covers 56/72 basic combinations; OpenAI Chat/Responses and Cerebras remain access-blocked, and xAI is explicitly deferred. Extended coverage is 55/72 combinations. Together, Hugging Face and the two LiteLLM configurations need passing replay evidence; three historical gateway/compatible corpora also have incomplete usage reporting.

`npm run test:conformance:release` now enforces the entire nine-check product matrix as well as the basic wire matrix. `npm run providers:readiness -- --json` reports both historical corpora without treating unavailable, incomplete or deferred checks as passing. Release signing/provenance is still tracked separately under #223.

## Validation

Current checks pass: strict TypeScript, 5,125 tests (6 explicitly skipped), 96.60% line coverage (13,370/13,840), 518 offline conformance tests (2 release-only assertions skipped), build, and all benchmark budgets. The focused provider/discovery suite also passes on Node 20 and Node 22 (235 tests each). Credential scans found no configured secrets in tracked/new files or decoded captures. The release command fails both required readiness assertions on the documented missing evidence; publication remains blocked.
