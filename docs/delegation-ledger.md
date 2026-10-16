# Delegation ledger (`delegation-ledger/v1`)

One parent execution allowance, shared with children that run in other processes or on other
hosts (#415). The authority is the existing reservation ledger (`src/execution/ledger.ts`):
requests are charged before dispatch, every ancestor is charged, child accounts come from
`child_grant` events, original deadlines hold, and unknown outcomes never restore capacity. This
protocol serves that ledger; it adds no second set of budget rules.

## Placement

The user chooses where a run's ledger lives:

- **local**: the parent CLI serves its own ledger from the user's machine or container.
- **astrolift**: Astrolift runs the same `calliope ledger serve` as a durable managed service, so
  children in pods, restarts and disconnects never lose reservations.

Children only receive a URL and a scoped token.

## Serve

```sh
calliope ledger serve --budget RUNS/<run>/budget --project /path/to/project \
  --token-file /private/parent.token [--host 127.0.0.1] [--port 0]
```

It prints `{"protocol":"delegation-ledger/v1","url":...,"runId":...}` once listening. The parent
token goes to `--token-file` (created new, mode 0600) and is never printed. Server state (signing
key, grant epochs) lives in a private sibling directory, never inside the budget directory.

## Run a delegated child

A host (Cy, an Astrolift task) grants the child, writes its scoped token to a private file and
starts a headless run or native ACP process:

```sh
calliope --headless --json --ledger-url URL --ledger-token-file /private/child.token \
  --ledger-agent CHILD_ACCOUNT "objective"

calliope acp --ledger-url URL --ledger-token-file /private/child.token \
  --ledger-agent CHILD_ACCOUNT
```

The turn runs under `ExecutionGuard` with the parent's ledger: the child's tools, paths, deadline
and budget come from its grant, and every provider request is reserved and settled with the
parent. A revoked or unknown grant, or an unreachable parent, stops the child before any turn.
The three flags go together, using separate flag/value arguments. Partial, repeated,
unknown or equals-form ledger flags fail before execution; they never select an
undelegated fallback.

## Operations

`POST /v1/<op>` with `Authorization: Bearer <token>` and a JSON body.

| Op | Who | Effect |
| --- | --- | --- |
| `hello` | any | protocol and operations |
| `journal` | any | the full hash-chained history (`manifest`, `events`) |
| `execution` | account owner | verify `{agentId, project: {root, key}}` against the retained owner grant and return its native workspace binding |
| `reserve` | owner of `reservation.agentId` | charge before dispatch; same id replays the original admission |
| `settle` | owner of the reserved request | record usage or an outcome; same settlement replays |
| `grant` | parent, or a child for its own accounts | allocate child accounts; returns the child's scoped token |
| `revoke` | parent | permanently fence a grant and every descendant |

A token may act for its accounts and their descendants only. A child cannot charge a sibling or
the root, cannot mint a root allowance, and a revoked grant cannot be reissued. Errors carry the
ledger's codes (`budget`, `deadline`, `authority`, `conflict`, `limit`, `locked`, `unavailable`).

Admission rechecks token expiry and grant revocation while holding the ledger's
writer lock, immediately before committing a reservation or nested grant. A
request queued before revocation cannot acquire authority when the lock opens.

An embedded owner can also supply `createLedgerServer({ledger, cwd, state,
assertAuthority: execution.assertAuthority})`, using the handle returned by
`prepareAgentExecution`. The server rechecks this trusted callback before new
admission and under the writer lock, including grant reissue. Cancelling the
native reviewed run then fences remote reservations and grants even before a
coordinator journal exists. Once the journal exists, completing the run or stopping
the handle's selected agent (or an ancestor) through an explicit stop control also
fences new work. Reopening the handle does not bypass those controls; an independently active sibling remains
eligible under its own handle. These checks reuse native execution history.
The callback is host code, never a request argument.
The standalone `ledger serve --budget ...` command serves an explicitly selected
raw ledger; it does not infer a reviewed-run binding.

Owner cancellation, agent stops and run completion still permit authenticated
journal inspection, replay of an already admitted reservation, and settlement
of existing requests. These reconcile
prior work; they do not authorize another provider call. Unknown/cancelled usage
retains its reserved charge. Token expiry and grant revocation continue to apply
to every operation, so a revoked child needs its owner to reconcile its requests.

## Client behaviour

`RemoteReservationLedger` gives `ExecutionGuard` the same read/reserve/settle surface as the local
ledger. It replays and verifies the hash chain itself and refuses any history that is not an
append-only extension of what it has seen, so a server reset or rollback cannot return spent
capacity. Writes retry with the same id; if every attempt is lost it inspects the journal, and
only an outcome the parent recorded counts. Otherwise the result is `unavailable` and nothing is
authorized (a reservation that was admitted stays charged).

The verified history is checkpointed atomically beneath the client's private
`root` as `verified-parent/history.json`. Reuse that root after reconnect or
restart. A missing, damaged, public or linked history file is an error; it is
never replaced with an empty allowance. Concurrent clients retain the longest
verified history, so an older response cannot overwrite a newer checkpoint.
The checkpoint contains no bearer token and never admits a provider request by
itself. Only the parent service can reserve or settle usage.

Headless and ACP children keep this state under `~/.calliope-cli/delegation-ledgers`,
keyed by the canonical project, configured token-file location and account. Rotating
the token or its projected-secret symlink at that location preserves verified history; restarting against a
rolled-back parent stops before the turn starts. Keep this directory on the
child's persistent private volume when running in a container. A new configured
token path is a separate connection, not recovery of the old one. These client
checkpoints do not by themselves wire Astrolift task admission or cancellation
to the ledger service.

The shared project budget also retains its reservation while admission is unknown.
An error releases project capacity only after a confirmed rejection before any
lost response. Even a fresh journal can lag an in-flight admission. Neither a
disconnect nor restarting the child restores the reserved project capacity.
Reservation errors optionally report `admission: refused` when the server has
verified non-admission after the local operation ends, or `unknown` otherwise.
Clients retain capacity when talking to older v1 servers that omit this evidence.

## Owner-bound remote workspaces

A copied checkout has a different path and filesystem identity. It cannot use a
parent grant just because its files look the same. The ledger owner may issue a
version 2 child grant with `project: {root, key}`, captured using the CLI's
`projectIdentity()` on the intended child host. The existing proposal hash,
review revision and native run manifest references remain part of that immutable
grant. The trusted host must establish the identity and authorize the binding;
model output or an unauthenticated workspace claim is not sufficient.

Only a parent token may issue these workspace grants. Child-issued version 1
grants inherit the nearest owner-bound workspace, and cannot change it. Workspace
grants use reservation event version 5 and projection version 4; existing grant
events, manifests and hashes are unchanged. A restarted client replays the same
grant through its retained verified checkpoint.

Headless and ACP invocations negotiate `execution` before starting their turn. The server
checks the token's account scope, live owner authority and exact project identity.
The client independently checks the response against the native journal and its
actual local directory. Missing protocol support, another account, a substituted
binding or a replaced directory stops execution. Library callers opt in with
`RemoteReservationLedger.connect({..., execution: {cwd, agentId}})`.

File and brain-path checks use the bound child root and key, with the original
relative tool/path grants. Filesystem separators are normalized for grant checks;
parent traversal and symlink aliases remain denied. The immutable source budget
manifest, account ancestry, reservations and deadline remain on the parent ledger.
The checkpoint stays outside the child's project, and local project spending
limits still apply. Binding a folder does not copy files, mount a volume, import
brain content, install credentials or create another allowance.

The protocol now supports explicit workspace identity binding. Astrolift must
still establish that identity from its native runtime authority, enroll the task
under its owner, and connect lifecycle cancellation and funding. The raw ledger
service and a parent task UUID do not establish those bindings automatically.

`tests/delegation-ledger.test.ts` is the local-host conformance suite: concurrent and nested
children exhausting one allowance, duplicate dispatch and lost acknowledgements, an unreachable
parent, restart and rollback, revocation of a child and its descendants, foreign runs, siblings
and forged tokens, and `ExecutionGuard` admission through the parent.

### Runner capability negotiation

`calliope --version --json` is an offline, credential-free probe.
`headless: {protocol: 1, delegation: 1, workspaceBinding: 1}` advertises
NDJSON terminal events, native parent-ledger admission and owner-bound workspace
validation. Embedders must verify these fields before supplying delegated tasks;
a matching package version alone does not establish those capabilities. This
probe does not grant authority: each invocation still negotiates with the live
parent and validates its token, journal and workspace before inference.


### Native ACP session continuity

ACP connects to the parent's ledger before opening its protocol transport. The
process has one trusted execution context; `session/new` and `session/load` cannot
replace it through client parameters. `initialize` advertises
`agentCapabilities._meta.calliopeDelegation` with `version: 1`,
`workspaceBinding: 1` and `sessionBinding: 1`. A host must negotiate this metadata
before relying on delegated ACP behavior.

New delegated sessions retain a versioned restriction containing the original
manifest hash and account ID in private session metadata. Saving a conversation
or creating a manual/safety branch preserves it. This marker does not mint a
grant, reserve tokens or confer authority. Loading requires the same live ledger
and account, an exact workspace match and an unexpired original deadline. A
plain ACP process cannot load a bound session, and a delegated process cannot
attach its allowance to old unbound history. The shared turn engine also checks
the restriction before inference through other clients.

Follow-up prompts use the original account's reservations, costs and clock.
Native one-time approvals, tool results, cancellation and protocol replay remain
in use. Automatic project memory/context is filtered through the granted read
scope before inclusion in the system prompt; project trust alone does not widen
that scope. Operator-owned global preferences remain trusted configuration.

This is a CLI capability, not completed Astrolift enrollment. The runtime adapter
must still pass the trusted tuple, retain its task binding across restarts, verify
the capability and connect owner lifecycle/funding. Retained metadata is a
restriction within the private store, not protection against an administrator
rewriting that store or explicitly transferring conversation content elsewhere.
