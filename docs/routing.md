# Routing from live evidence

Terminal, headless, ACP and library turns use the same selector in
`src/routing/`. The runtime selects a route before compression, then validates
it before every inference request, including tool continuations, retries,
compression and repair. Discovery sends no conversation content and never starts
inference. Every decision has an ID and a versioned audit event.

## Preferences and eligibility

An explicit provider stays selected; an explicit model stays selected or the
turn stops with a reason. A stored `providers.<name>.model` preference also
restricts that provider unless the turn supplies a model. Model aliases require provider evidence. Anthropic
aliases can be resolved with its model retrieval endpoint. Prefix matches and
model-family tiers do not establish live compatibility.

Automatic selection considers configured providers in `routing.providerPool`
(or the registered adapters when the pool is omitted). Quarantined targets are
excluded. Explicit choices can attempt recovery with a visible warning; a fresh
quarantine also blocks automatic dispatch if health changes after selection.
Missing credentials and unavailable discovery are exclusions, not passing checks.

Discovery can report capabilities as `true`, `false`, or absent. A discovered
`false` blocks a required capability, including for an explicit choice. Unknown
support remains eligible with a lower score; it is never reported as verified.
An explicit provider and model can still run when the models endpoint is
unavailable, with `evidence: "explicit-unverified"` and an explanation. Successful
negative discovery, malformed discovery, and stale known-negative capability
information do not grant that exception. Fresh discovery can establish recovery.

Opaque provider state pins history to its provider and, when recorded, model.
Conflicting or unknown owners stop routing. The runtime preserves the original
client preference in every continuation decision and adds a `calliopeRouting`
origin to assistant metadata. Start a new session or normalize history explicitly
before moving opaque protocol state to another provider.

## Configuration and score

```json
{
  "routing": {
    "enabled": true,
    "costSensitivity": 0.3,
    "preferredProviders": ["deepseek", "xai"],
    "providerPool": ["deepseek", "xai", "cerebras"],
    "discoveryTimeoutMs": 5000
  }
}
```

`enabled` controls score optimization. When false, eligible candidates follow
configured provider order and then model ID order. Eligibility, discovery,
quarantine and audit gates remain active. `preferredProviders` determines scan
order and breaks score ties. `providerPool` restricts automatic selection only;
it cannot override an explicit provider. Use the config JSON for provider arrays
and timeout; the REPL supports `/config set routing.enabled true` and
`/config set routing.costSensitivity 0.3`.

With optimization enabled the score combines capability/capacity fit (40%),
recent health (40%) and latency (20%), then interpolates that result with cost
using `costSensitivity`. Health uses the local error, timeout and adapter retry
rates described in [Provider health](provider-health.md). Missing health has a
neutral score. Input capacity affects ranking; oversized input may be compacted
by the runtime. Library callers can set `minOutputTokens` as a hard requirement.

Cost ranking uses discovered input/output prices in USD per million tokens and
estimated request tokens. Unknown prices have no cost advantage; explicit zero
prices are distinct. Cost estimates are advisory. Runtime accounting uses
available discovered prices and records `costSource: "discovery"`; missing prices
retain the documented emergency estimate with `costSource: "fallback"`. Existing
budget caps still act on observed usage after a response, so this layer does not
promise a prepaid dollar ceiling. See [Runtime](runtime.md).

## Discovery evidence and bounds

A successful list is cached for five minutes and tied to provider, endpoint and
credential identity (an in-memory hash), plus the native Bedrock profile/region.
Cache readers receive copies. Native Anthropic, OpenAI and Google discovery and
inference share configured endpoints, including their base URL environment overrides.
Anthropic/Google base URLs may include their standard `/v1` or `/v1beta` suffix;
it is added exactly once. OpenAI base URLs include `/v1`. An endpoint or credential change invalidates the
cache. Emergency fallback catalogues are never eligible as live evidence.

Each route has a 30-second overall deadline and a configurable per-provider
deadline (100–30,000 ms; default 5,000). Provider scans are sequential and limited
to the adapter registry. Lists have a 10,000-model limit. Anthropic/Google lists
and Bedrock inference profiles have a 20-page limit, reject repeated/invalid
cursors, and follow cursors only on the original endpoint. Caller cancellation
aborts discovery before inference and produces a cancelled decision.

Metadata is normalized from provider fields:

- [Anthropic Models](https://platform.claude.com/docs/en/models/overview):
  input/output token limits and the SDK capability tree; model retrieval resolves
  aliases. No tool support is inferred from a Claude model name.
- [Google Models](https://ai.google.dev/api/models): input/output limits,
  `supportedGenerationMethods` and `thinking`.
- [Mistral Models](https://docs.mistral.ai/api/endpoint/models): aliases, context
  limits and capability flags. Compatible servers can expose the same extensions.
- [Ollama API types](https://github.com/ollama/ollama/blob/main/api/types.go):
  `/api/show` capabilities, model information and `num_ctx` parameters.
- [Bedrock foundation metadata](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_FoundationModelSummary.html):
  modalities and streaming support. No tool-family allowlist is used. Profile
  capability inheritance requires the model ARNs returned by
  [ListInferenceProfiles](https://docs.aws.amazon.com/bedrock/latest/APIReference/API_ListInferenceProfiles.html).

Fields omitted by providers remain unknown. Discovery is metadata evidence, not
an inference/conformance test. Live capture coverage and publication gates remain
separate in [Provider conformance](provider-conformance.md).

## Decision schema and clients

`RoutingDecision.version` is `1`. It contains `id`, `at`, `status`, the original
`requested` provider/model, `mode`, `selected`, up to 20 ranked `alternatives`, up
to 1,000 `exclusions`, and a human-readable `reason`. Each candidate contains the
provider/model, hashed target, evidence source/timestamp, capabilities, limits,
prices, estimated cost, latency, error rate, score and explanation. Missing
scalar evidence uses `null`; unknown capability/price members are omitted.
No prompt, tool arguments, API keys, or raw provider errors enter this record.
Clients that resolve scoped preferences also include `preferenceSources`, naming
the source of the provider and model choice; see [Model preferences](model-preferences.md).

Run logs append `routing_decision` events and include them in read-only replay
and JSON export. The hash covers the exact serialized JSON, including omission
of absent optional fields. Headless clients receive the same decision as
`status.data.routing`; existing `status`, `message` and `done` envelopes and exit
codes are retained. The initial headless status is preliminary; the route event
identifies the selected target. ACP uses a thought/status notification so routing
explanations do not become assistant answer text. The terminal displays the
explanation and selected provider/model in its status.

The runtime adapts recognized built-in local/cloud prompt prefixes after
selection. Appended project instructions and caller-supplied custom prompts are
preserved. Tests use synthetic HTTP responses through real SDK parsers, the
runtime, permission resolver and audit store; they do not imply paid provider
captures have passed.
