# Opt-in Smart routing for agent teams

Smart routing is an explicit orchestration mode. Omitting it keeps existing
routing, preference inheritance and goal contracts unchanged. It selects from
operator-approved, live-discovered model pools using capability, recent provider
health, latency and estimated cost. It does not infer model quality from names or
prices, and it does not yet learn task success rates across runs.

Start a new goal with a project-relative policy file:

```sh
calliope orchestrate "Fix the failing boundary test" \
  --routing smart --routing-policy routing.json \
  --cost 5 --attempts 2 --json
```

The REPL accepts the same flags on `/orchestrate`. General `/routing` session
controls and automatically saved project defaults are not part of this mode.
The policy file is read through project scope and permission checks, bounded to
64 KiB, and copied into the goal before planning. Editing that file later does
not change an existing goal. Resume/approve commands reject replacement routing
flags; they use the original reviewed policy.

For example, `routing.json` can select among every discovered chat model of the
specified providers:

```json
{
  "version": 1,
  "default": {
    "version": 1,
    "profile": "balanced",
    "pool": [{"provider": "anthropic"}]
  },
  "workers": {
    "version": 1,
    "profile": "cost",
    "pool": [{"provider": "deepseek"}],
    "escalationPool": [{"provider": "anthropic"}]
  }
}
```

Add a `model` field to a pool target to restrict it to an ID obtained from live
model discovery. Each pool has 1–32 unique targets; unknown providers, empty
pools, secret-like model IDs and terminal controls are rejected. The optional
roles are `planner`, `reviewer` (planning review), `workers`, `controller` and
`supervisionReviewer`. Missing role policies use `default`. A policy does not
create a reviewer or enable supervision: those still require the corresponding
team/supervision controls.

Existing explicit provider/model flags win. A pinned model is never replaced
by escalation; known incompatibility still stops execution. An explicit provider
restricts selection to that provider, including when it is outside the automatic
pool. Automatic workers use their own approved pools independently of the
controller's pin. Captured role pools override ambient routing provider pools
and per-provider model defaults; later configuration cannot expand their targets.
Credential, discovery, capability, quarantine and actual request budget checks
still apply. An explicitly pinned model retains the existing visibly unverified
fallback when its provider has no usable discovery endpoint.

The profiles use these relative ranking weights (higher scores win):

| Profile | Capability/capacity | Recent health | Latency | Estimated cost |
| --- | ---: | ---: | ---: | ---: |
| cost | 25% | 25% | 5% | 45% |
| balanced | 40% | 35% | 15% | 10% |
| speed | 30% | 25% | 40% | 5% |

Missing metadata is not a claim of support or free usage. Ranking estimates are
not prepaid reservations; the existing request admission ledger remains the
hard dollar/token boundary. A budget denial does not trigger model-shopping.

## Verification and escalation

An optional `escalationPool` becomes eligible on a later task attempt only when
the previous attempt ended `failed` with a recorded failed acceptance check
against a collected, hash-verified artifact. The routing event cites that outcome's
immutable event ID. A provider error, a model's claim of failure, a missing
artifact, cancellation, denial or unknown outcome does not supply this evidence.

Smart routing does not authorize a retry. The coordinator still requires its
existing retry policy, or the controller's reviewed retry/replan decision for an
isolated mutation. Every attempt shares the original ledger, deadline and attempt
limit. Model changes occur in a new attempt session; tool/reasoning continuations
keep their original provider/model. An escalation pool describes operator intent,
not a claim that its models are more capable.

Planning-proposed routing policies and model pins cannot replace the operator's
captured choices. Human revisions can deliberately pin a model before exact-hash
approval, but cannot replace a captured role policy. New dynamic children must
inherit or narrow their parent's `childRouting` delegation policy (or `routing`
when no separate delegation policy exists), including any further delegation
grants. Explicit child pins must fit that policy's initial pool. Smart goals
capture the worker policy as `childRouting` for agents with delegation capacity,
so an independently pinned controller can add cheaper workers. Initial team
members may have different reviewed pools.

## Events, HUD and recovery

New Smart goals use manifest version 5. The optional agent `routing` field carries
its own version-1 policy inside the reviewed plan hash. Legacy goal manifests and
generated planner contracts keep their hashes. Smart route events use execution
event version 5, change type `agent_routed`, with agent/session/task identity,
decision ID, actual provider/model, profile, stage, reason and optional failed
verification event ID. They contain no conversation, tool arguments or secrets.

Route recording completes before inference. Revalidation may produce several
routing events for one paid request; event counts are not request or usage counts.
The existing session run log retains full routing alternatives and exclusions.
Execution projections expose the last route per agent in `routes` and the current
route on each task, keeping concurrent sessions independent; the headless
outer envelope stays version 1. Replay validates policy, pins, session ownership,
deadlines and escalation provenance without discovering models or sending requests.

The HUD shows the actual model once its active attempt selects a route, followed
by attempt/count and a compact selection reason. Before selection, it shows the
requested choice. Dollar figures remain declared limits, not billed spending;
request reservations and settled usage remain in the budget ledger.
