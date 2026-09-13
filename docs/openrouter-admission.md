# OpenRouter admission

Bounded turns reserve the full live-discovered input capacity and configured output
limit. Discovery uses the largest advertised prompt/cache-read/cache-write rate for
input and the largest completion rate across all context tiers. These conservative
rates also appear in routing estimates. Missing, malformed or unsupported non-token
pricing leaves prices unknown and prevents admission; an explicit zero remains free.
Optional web-search prices are recognized only because bounded transport disables
the web plugin and sends client function tools, never server tools.

Agent and project budgets snapshot these rates. The dispatcher sends that snapshot
back to admission and refuses changed prices before reserving. Both JSON and stream
requests carry `provider.max_price.prompt` and `completion` in USD per million tokens,
zero `request`/`image` price filters, `allow_fallbacks: false`, and
`require_parameters: true`. They request text and the default service tier, disable
documented optional plugins, and keep SDK retries off. Every shared retry must obtain
another reservation. Missing usage, failure and cancellation retain the allowance
through restart. Existing event IDs and ledger schemas are unchanged.

These are **local admission estimates and provider routing filters**, not a prepaid
invoice or an account-wide charge guarantee. OpenRouter's catalogue advertises the
lowest provider prices; its price filter documents prompt/completion/request/image
fields, not separate cache ceilings. Before a paid workflow, review the selected
upstream endpoint's current tier/cache rates and account settings. Account-enforced
plugins can prohibit request overrides; disable those separately. A custom gateway
must honor the same controls. Calliope does not infer that these external conditions
are satisfied merely because a model was discovered. OpenRouter input counting is
not implemented; small prompts still reserve full discovered capacity.

The semantic capture harness now records `provenance.routingBoundsVersion: 1` for
correctly named wire price controls. Four historical OpenRouter captures used
`input`/`output`, which are not the documented wire keys. Their bytes, hashes and
reservations remain unchanged. Legacy replay checks message/tool behavior while
excluding the old routing controls; those captures do **not** prove a working price
ceiling. New capture/replay validates the corrected controls exactly. No historical
capture is upgraded into new spend evidence.

Sources: [provider routing and max price](https://openrouter.ai/docs/guides/routing/provider-selection),
[catalogue pricing](https://openrouter.ai/docs/guides/overview/models),
[tiered provider pricing](https://openrouter.ai/docs/guides/community/for-providers),
[plugin defaults and enforced overrides](https://openrouter.ai/docs/guides/features/plugins/overview),
[service tiers](https://openrouter.ai/docs/guides/features/service-tiers).
