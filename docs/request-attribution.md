# Provider request attribution

An agent's aggregate spend cannot identify the cost of one task when that agent
handles several tasks, retries or controller reviews. New coordinator executions
bind each provider reservation to the exact execution start that authorized it.
This is recorded provenance, not a guess based on overlapping timestamps.

Task and supervision start events use execution event version 6 with
`requestAttribution: 1`. The coordinator passes a version-1 attribution object to
the shared execution guard: start event ID/hash, session ID, and either task ID /
attempt or controller/reviewer role / round. The guard validates and copies that
object, then stores it atomically with the reservation before provider dispatch.
Providers and models cannot supply or change this metadata.

Attributed reserve events use budget event version 3. Their projections retain
per-request accounted tokens and integer nano-dollars, including conservative
pending/unknown charges and overshoot. Settlement events keep their existing
format. Legacy reservations, execution events and hashes remain unchanged; a
legacy run does not acquire fabricated historical attribution on upgrade.

## Inspection and comparisons

```sh
calliope run status RUN_ID --json
calliope run replay RUN_ID --json
calliope improve history --run RUN_ID --json
```

The existing headless envelopes are unchanged. Attributed runs add
`accounting.attribution`, a version-1 report with its budget and execution
revisions and groups keyed by start event ID. Each available group contains its
source binding, agent ID, request IDs, accounted tokens/cost, request-state counts,
and whether its turn is closed and usage is complete. Worker attempts and each
controller/reviewer turn remain separate; do not count ancestor balances as
additional request costs.

Inspection checks the original run/plan/clock and child grants, both journals,
start event hash, session, task/attempt or role/round, agent ownership and the
reservation's placement within that start's lifetime. A foreign binding makes
attribution unavailable without hiding independently valid aggregate balances.
An agent with legacy unbound requests has unavailable partitioned costs; even a
new zero-request attempt cannot safely claim a zero share of those unknown costs.
A marked, closed attempt with no requests or unbound agent charges is a genuine
zero-request observation.

The improvement metric `provider-accounted-cost` covers worker attempts only.
Cost deltas require the same complete task population and fully settled usage in
both observations. Pending, failed, cancelled and unknown requests remain charged
conservatively and prevent comparison. Missing or invalid provenance yields `null`,
not zero. Accounted cost uses the ledger's reviewed rates; it is not an invoice,
causal proof, or whole-goal cost per successful task. Planning and review overhead
remain separate from this metric, and no automatic routing preference is learned
from it.

Version-2 improvement history and cycles carry the cost evidence. Controller
feedback still includes at most four cycles; the HUD shows comparable attempt
costs. Explicit Brain ingestion cites the accounting revision and appends a new
snapshot if that revision changes, while retaining proposed hypotheses and all
prior observations. Legacy Brain snapshots keep their existing identity.

Reads never call providers, reserve or settle requests, recreate damaged ledgers,
or replay tools. They remain subject to the existing project/inspection policy
and journal limits. Different journal revisions are separate observations, not
an atomic transaction across stores. Diagnostics contain IDs and numeric evidence,
not prompts, tool arguments, credentials, endpoints or billing profiles. No new
budget, permission, retry authority or routing default is introduced.
