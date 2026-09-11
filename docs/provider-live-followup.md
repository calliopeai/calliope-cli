# Provider capture follow-up — September 11, 2026 UTC

The follow-up passes added **32 real-wire captures in 36 bounded inference attempts**.
A native Bedrock Astra capture was also promoted from the model sweep.
The reviewed corpus contains **69 captures covering 56 of 72 required combinations**;
multiple models on one adapter do not inflate combination coverage. The user deferred
xAI live testing; its four missing cases remain explicit in the full release gate.

| Adapter | Live-discovered model | Text JSON / stream | Tool JSON / stream |
|---|---|---|---|
| Anthropic | `claude-fable-5-1` | Pass / pass | Pass / pass |
| Anthropic | `claude-fable-5` | Pass / pass | Pass / pass |
| OpenRouter | `openai/gpt-6-astra` | Pass / pass | Pass / pass |
| Bedrock native | `global.openai.gpt-6-astra` | Pass / unattempted | Unattempted / unattempted |
| Google `@google/genai` | `gemini-2.5-flash-lite` | Pass / pass | Pass / pass |
| OpenRouter | `liquid/lfm-2.5-2.6b:free` | Pass / pass | Pass / pass |
| DeepSeek | `deepseek-flash` | Pass / pass | Pass / pass |
| Groq | `openai/gpt-oss-20b` | Pass / pass | Pass / pass |
| Fireworks | `accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b` | Pass / pass | Pass / pass |
| Cerebras | `gpt-oss-120b` | HTTP 402 / unattempted | Unattempted / unattempted |
| OpenAI Chat | `gpt-4.1-nano`, `gpt-6-astra` | HTTP 429 / unattempted | Unattempted / unattempted |
| OpenAI Responses | `gpt-5-nano` | HTTP 429 / unattempted | Unattempted / unattempted |
| xAI | Not selected | Deferred / deferred | Deferred / deferred |

Fable 5 and 5.1 passed directly through Anthropic. Astra passed through OpenRouter;
native Bedrock also passed its 64-token Astra text check. Direct OpenAI access
still returned HTTP 429. These are distinct adapter results. Native Bedrock Fable
5/5.1 returned HTTP 400; one bounded diagnostic classified the Fable 5.1 error as
requiring the AWS data-retention opt-in. That account setting needs separate review.
The replacement Gemini credential also completed all four checks. Model discovery
succeeded for eleven configured providers, but listing models does not establish
inference access. Cerebras HTTP 402 and OpenAI HTTP 429 require checking account
access, billing, quota or rate limits; raw error bodies were not retained here,
so the statuses do not establish a more specific cause.

All requests used fixed public toy prompts, with no project context and no executed
tools. Each capture attempt allowed one request, at most 512 output tokens, a
30-second deadline and no automatic retry. Credentials remained process-local.
Captures preserve reviewed response bytes, checksums, SDK versions and origins;
request headers and query strings are excluded. Decoded captures passed secret
scans and replayed through both release and current development adapters.

## Budget and model sweep

The user reconfirmed the existing **$500 cumulative ceiling** and specified a
**$5 maximum per run**, emphasizing small tests. The previous separate $0.01
follow-up cap was an agent accounting error. The ledgers were reconciled without
refunds or resets: the original 47 one-dollar reservations plus 17 recent
reservations totaled **$47.0099328 reserved** before this run. These conservative
reservations are not billed spend. Original snapshots and hashes are retained.

One canonical ledger now enforces both ceilings under an exclusive lock, using the
same run ID across restarts. Failed, cancelled and unknown requests retain their
reservations. The [capture audit](reports/provider-capture-followup-2026-09-11.json)
records the correction, prior reservations, every capture attempt and current run
totals. The [model sweep audit](reports/provider-model-sweep-2026-09-11.json) records
one tiny text check per eligible live-discovered model, or an explicit skip reason.
The sweep uses 64 output tokens, 15 seconds and one request per model, with a
100,000-token output-reservation ceiling and no automatic retries. Both activities
share run `models-2026-09-11-01` and its $5 ceiling; no fresh run is created to evade it.

The sweep is a bounded compatibility smoke, not a quality benchmark. An incomplete
response at the tiny token cap does not establish model incompatibility. A live-listed
model may still reject inference, and an unpriced, unsupported, paused or deferred
model is never counted as passing. OpenRouter sweep requests disable fallbacks and
bound provider token prices; Hugging Face routes are pinned to live-listed providers
with verified prices. The harness requests no images or audio and executes no tools;
some search models can perform provider-internal work.

The sweep identified an accounting gap for five Perplexity search/research models:
provider-reported costs include fees beyond the token estimate. Three completed
responses expose those costs; one unexpected response and one cancellation lack
per-request cost evidence. Further probes of models with mandatory extra charges
are excluded until those charges can be bounded. The audit retains all five attempts
and a separate OpenRouter API-key daily-usage snapshot; neither is a reconciled invoice.

## Completed run

Run `models-2026-09-11-01` reserved **$4.586797441 of $5**,
including 21 focused capture probes, 596 catalog probes and one diagnostic. Reported
usage across this run was **36,635 tokens**; requests without usage remain unknown.
The cumulative ledger retains **$51.596730241 of $500**,
including all historical reservations. Reservations are not billed spend.

The 1,151-ID inventory contains 274 new exact-response passes, 197 failures,
100 incomplete responses, 16 unexpected responses, nine cancellations, 547 explicit
skips and eight earlier passes. The diagnostic is recorded separately. Earlier
captures remain valid evidence for their original conditions; local cold-start
timeouts in this short smoke do not overwrite them. The other-attempts column
combines failures, incomplete/unexpected responses and cancellations.

| Provider | Catalog IDs | New passes | Other attempts | Skipped | Earlier passes |
|---|---:|---:|---:|---:|---:|
| google | 40 | 3 | 2 | 34 | 1 |
| deepseek | 2 | 1 | 0 | 0 | 1 |
| openrouter | 443 | 200 | 123 | 118 | 2 |
| groq | 12 | 1 | 2 | 8 | 1 |
| fireworks | 25 | 9 | 8 | 7 | 1 |
| anthropic | 11 | 9 | 0 | 0 | 2 |
| mistral | 48 | 16 | 4 | 28 | 0 |
| together | 186 | 10 | 162 | 14 | 0 |
| huggingface | 138 | 11 | 12 | 115 | 0 |
| openai | 115 | 0 | 0 | 115 | 0 |
| cerebras | 3 | 0 | 0 | 3 | 0 |
| bedrock-native | 120 | 12 | 3 | 105 | 0 |
| ollama | 8 | 2 | 6 | 0 | 0 |

Twelve basic cases for OpenAI and Cerebras remain blocked, and four xAI cases are
deferred. Cancellation, provider-error, system-instruction and tool-result-replay
wire evidence remain outstanding; smoke responses and synthetic tests do not
substitute for those captures. Publication remains blocked.
