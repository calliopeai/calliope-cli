# DeepSeek reasoning and tool replay

The DeepSeek compatible adapter retains `reasoning_content` as opaque protocol
state in JSON and streaming responses. Current DeepSeek thinking/tool requests
require this field from previous assistant turns, including turns without tool
calls. See the provider's [thinking-mode contract](https://api-docs.deepseek.com/guides/thinking_mode/).

Calliope stores it as:

```json
{"providerMetadata":{"deepseek":{"version":1,"reasoningContent":"<opaque provider text>"}}}
```

The shared runtime checkpoints it with the assistant message and tool calls.
After restart, the adapter restores the exact field on DeepSeek assistant
messages. Empty strings remain present; absent/null wire values create no new
state. All previous assistant turns are retained through ordinary conversation
persistence, subject to the existing whole-conversation retention rules.

Only the DeepSeek adapter replays this namespace. Other provider adapters ignore
it, and shared routing still preserves protocol-bound provider/model continuity.
The field is never concatenated into the displayed answer, emitted as text
tokens, interpreted as tool calls or granted authority. Session files remain
private and existing headless event envelopes retain their schema.

Malformed metadata and reasoning exceeding 1 MiB of UTF-8 per assistant message
fail as non-retryable protocol errors. Required state is never silently truncated.
For unusually long reasoning, request less output or start a shorter conversation.
The conversation's existing 16 MiB persistence bound also applies. A cancelled
or failed stream does not return its partial reasoning as reusable message state;
a successful transport retry starts its own accumulation. Existing request
reservations and usage accounting still include provider-reported reasoning usage.

Historical messages are not rewritten and missing reasoning cannot be recreated.
If a legacy thinking/tool conversation is rejected for missing protocol state,
start a new session or restore a complete snapshot. This implementation does not
disable thinking, infer support from a model name, change tools or budgets, or
constitute a native conformance capture. Real captures must separately preserve
only sanitized protocol evidence.

New semantic captures mark verified request/response replay with
`provenance.reasoningReplayVersion = 1`. The validator checks the exact opaque
field against captured bytes. The historical DeepSeek capture omitted it from
the second request: offline replay verifies that today's adapter restores the
original response field, then compares the other request fields. It returns the
unchanged historical capture and flags `historicalReasoningOmission`; this derived
check is not fresh wire evidence. Unmarked captures do not satisfy the current
DeepSeek tool-result release-readiness check.

The [2026-09-13 capture ledger](reports/deepseek-reasoning-2026-09-13.json)
records fresh JSON and streaming tool-result replay against live-discovered
`deepseek-flash`: four successful requests, 1,552 input and 294 output tokens,
with $0.0084576 retained reservations under a $0.01 probe cap. These fixed public
echo fixtures replay offline through the real SDK. Original capture bytes remain
unchanged. This evidence covers this model and scenario at that timestamp; the
full release gate still requires the other missing provider captures.
