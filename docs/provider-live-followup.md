# Provider capture follow-up — September 11, 2026 UTC

New local credentials produced 12 additional real-wire captures in 15 bounded
inference attempts. The corpus now contains **48 of 72 required combinations**.
The user explicitly deferred xAI live testing; its adapter remains supported and
its four missing cases remain visible in the unchanged full release gate.

| Adapter | Live-discovered model | Text JSON / stream | Tool JSON / stream |
|---|---|---|---|
| Google `@google/genai` | `gemini-2.5-flash-lite` | Pass / pass | Pass / pass |
| OpenRouter | `liquid/lfm-2.5-2.6b:free` | Pass / pass | Pass / pass |
| DeepSeek | `deepseek-flash` | Pass / pending | Pending / pending |
| Groq | `openai/gpt-oss-20b` | Pass / pass | Pending / pending |
| Fireworks | `accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b` | Pass / pending | Pending / pending |
| Cerebras | `gpt-oss-120b` | HTTP 402 / unattempted | Unattempted / unattempted |
| OpenAI Chat | `gpt-4.1-nano` | HTTP 429 / unattempted | Unattempted / unattempted |
| OpenAI Responses | `gpt-5-nano` | HTTP 429 / unattempted | Unattempted / unattempted |
| xAI | Not selected | Deferred / deferred | Deferred / deferred |

The replacement Gemini credential listed models and completed all four probes.
Read-only discovery returned models for all eleven configured active providers;
discovery alone does not prove inference access, and some catalogs are public.
Cerebras requires billing/access remediation after HTTP 402. OpenAI requires
checking quota and rate-limit status after HTTP 429; raw upstream error bodies
were not retained, so this pass does not establish a more specific cause.

All requests contained fixed public toy prompts. No project context was sent and
no returned tool executed. Each request used a 30-second deadline, a 128- or
512-token output cap, a 5,000-token input reservation and no automatic retry.
Credentials remained process-local. Captures preserve reviewed response bytes,
checksums, SDK versions and origins, with request headers and query strings
excluded. Decoded captures passed a secret scan and replayed through the release
branch's actual adapters and installed SDKs.

The [machine-readable ledger](reports/provider-capture-followup-2026-09-11.json)
contains every new attempt, exact reservation references, primary pricing sources,
the xAI deferral and a fresh readiness inventory. Its existing **$0.01 cap** now
has **$0.0099328 reserved**, including the two earlier failed requests. No
reservation was refunded or reset. The new successful responses imply an
estimated **$0.00019635** from reported usage and the recorded rates; failed-request
billing is unknown, so this is not a reconciled total. DeepSeek's higher peak rates
were reserved conservatively; OpenRouter's selected model listed zero input and
output prices at discovery.

Eight additional cases for the currently reachable providers await more probe
budget. Twelve cases for OpenAI and Cerebras await access remediation, and four
xAI cases are deferred. Cancellation, provider-error, system-instruction and
tool-result-replay wire evidence remain outstanding; synthetic tests and HTTP
failure statuses do not substitute for those captures. Publication remains blocked.
