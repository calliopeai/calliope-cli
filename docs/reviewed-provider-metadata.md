# Reviewed metadata for bounded provider calls

Some providers discover model IDs without publishing capabilities, limits or
prices through their models API. An operator can supply the missing evidence for
bounded execution in a private billing file. This does not enable Smart routing,
change a provider/model pin, or add models to discovery. The selected model and
endpoint must still match recent live discovery.

Use `~/.calliope-cli/billing.json` or `CALLIOPE_BILLING_FILE`, outside the worker
project. Protect it with `chmod 600`. The existing reader rejects aliases,
symlinks, hardlinks, group/world write access, files over 128 KiB and more than
64 profiles. Profiles are operator authority; workers must never generate or
install them from their outputs.

```json
{
  "version": 2,
  "profiles": [{
    "version": 2,
    "provider": "deepseek",
    "model": "<exact live-discovered model ID>",
    "target": "<configured providerTarget(provider).key digest>",
    "checkedAt": 0,
    "expiresAt": 0,
    "sources": ["https://api-docs.deepseek.com/quick_start/pricing/"],
    "prices": {"input": 0, "output": 0},
    "capabilities": {"chat": true, "tools": true, "streaming": true},
    "limits": {"contextLength": 0, "maxOutputTokens": 0},
    "admission": "reviewed-full-context-v1"
  }]
}
```

The placeholders are intentionally invalid. Set positive token limits from
current provider documentation and epoch-millisecond timestamps, with expiry at
most seven days after review. Review the exact endpoint's billing terms: a
gateway may charge differently from its upstream provider. Prices are USD per
million tokens and must upper-bound applicable cache, reasoning and time/tier
rates on the adapter path. URL presence alone does not verify metadata. Include
no keys, private prompts or response content; source URLs must be HTTPS without
credentials, queries or fragments. Every configured provider can use this schema;
the CLI bundles no model or pricing catalogue.

## Conservative admission

Each request reserves the larger of reviewed and live input capacity, plus its
requested maximum output. This is a full-capacity allowance, not a tokenizer
estimate or consumed tokens. A tiny prompt to a large-context model may therefore
need substantial token headroom before dispatch; do not reduce the reviewed
capacity to make a budget fit. Successful usage reporting settles the reservation
to reported usage at the reserved rates. Failures, cancellation and missing usage
retain the reservation, and overruns stop subsequent requests.

The output maximum is the smaller of the reviewed and live limits. Prices use
the larger rate for each input/output direction. Reviewed capabilities fill only
unknown live fields; a live rejection always vetoes the request. Unknown required
capabilities in both sources fail closed. Live routing metadata remains unchanged,
including unknown prices used by Smart ranking. This profile does not request
Anthropic token counting, accept supplied input counts or admit multimodal input.

The provider/model/endpoint binding, original run/agent/project budgets, policy,
deadlines and cancellation checks still apply. The profile is re-read before
reservation and before dispatch; deletion, edits or expiry revoke admission.
Revocation after a durable reservation retains that reservation conservatively.
No automatic paid probe or retry can replenish the original allowance.

## Versioning and recovery

Version-2 billing files can contain these profiles together with unchanged
[legacy counted profiles](counted-admission.md). Version-1 files retain their
original format and hashes; no file or historical journal is migrated.

New quotes carry `quoteEvidence.version = 2`, including the reviewed profile and
digest, quote time, live observations and required capabilities. Execution
reservations carrying that proof use reservation event version 4, also supporting
existing request attribution. Replay reconstructs the conservative bounds from
the recorded proof and rejects inconsistent prices, limits or event versions.
Historical replay checks validity at quote time, without fetching metadata or
requiring a now-expired profile to be renewed.

Ordinary project-capped turns include the same proof in their existing hash-linked
policy audit event. Execution journals retain it with the reservation. Neither
contains prompt bytes, tool arguments or credentials. The outer headless JSON
envelope and existing ledger projections retain their versions.
