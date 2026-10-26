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

## Serve a reviewed native run

```sh
calliope ledger serve-reviewed --run RUN_ID --agent AGENT_ID \
  --max-output-tokens 1024 --project /path/to/project \
  --token-file /private/owner.token
```

This mode calls `prepareReviewedLedger`, reuses the run's native permission gates,
original budget, parent funding and deadline, and serves only the selected agent's
subtree. The token file must be outside the project in a private canonical directory;
it is created exclusively and never printed. Output includes the owner, original
deadline and versioned reviewed-host capability. SIGINT/SIGTERM close the listener.
Failed credential delivery also closes it without replacing an existing file.
Library hosts can call `prepareReviewedLedger(cwd, runId, agentId, maxOutputTokens,
options)` for the unbound server and private credential. They control where it listens.

Version 2 credentials bind the owner scope and exact native run review. Older
servers reject that token version; current raw-ledger endpoints reject its reviewed
authority binding. Child credentials retain that binding. A sibling owner endpoint
cannot accept the token, and reservations, settlements and revocations enforce the
selected subtree. Each new request also checks the target account's native admission,
stop/escalation state and the host's output cap. Existing requests can still settle
after owner cancellation; grant revocation and token expiry retain their existing
semantics.

The HTTP grant operation only returns credentials for an **exact, already admitted**
native child grant. It cannot create a proposal, approve children, bypass native
depth/count limits or promote an interrupted ledger grant into the execution graph.
Use the existing native proposal review/admission flow first. Reissuing a credential
preserves its account, deadline and all recorded spending; revoked grants stay revoked.

All owners of a run share its private signing key and revocation history. A native
writer lock serializes revocations from separate processes; only confirmed dead locks
are reclaimed. Malformed, missing, public or linked revocation/key files are refused.
New keys initialize an empty revocation history once. A retained legacy key without
that history requires verified restoration or an explicit owner-managed credential
rotation; opening it never silently treats missing revocations as an empty history.

This is reviewed ledger hosting, not automatic Cykick/Astrolift enrollment. Remote
workspace identity, dispatcher credential delivery, task-attempt ownership, transport
reachability and any narrower Cykick file-mutation policy still need their native
bindings. A loopback listener does not make a desktop reachable from a remote pod.

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

### Private reverse transport for hosted tasks

The execution API exports `LEDGER_TUNNEL_CAPABILITY`, `attachLedgerTunnel` (owner)
and `listenLedgerTunnel` (task). The owner injects an authenticated, non-replayed
duplex exec connection; ordinary HTTP framing and backpressure carry only native
ledger requests. The owner opens no public listener. The task binds its original
loopback port, and never picks another port after a conflict. This does not yet
supply an Astrolift websocket endpoint or its task-placement authorization.

Both ends pin the original child credential's SHA-256, reviewed audience, run,
grant and expiration. Parent/replacement credentials are refused before task
traffic enters the exec stream. Claims are restrictions, not authentication:
the existing native server still verifies the signature, current grant, workspace
and account controls. The owner URL must be its trusted reviewed loopback host;
requests cannot choose another URL, follow redirects or invoke revocation.

Requests retain the native 256 KiB limit. Responses stream with a 32 MiB bound
for the bounded journal and envelope. There is one task request in flight;
heartbeats, request deadlines, stream closure and the original credential expiry
close both ends on loss of the owner. Bridge failures never assert non-admission.
The remote ledger retains unknown charges and retries the original request ID.

Reconnect attaches a new authorized stream to the original task port and native
stores, using the same credential and child checkpoint. It must not mint another
grant or replace a task binding. The trusted host must revalidate task identity,
placement and caller access through `assertConnection`, and abort the connection
when that lease ends. Do not use terminal replay, chat events or logs for these
streams: request headers contain the child bearer credential. The API performs
no task enrollment, credential persistence, scheduling or independent accounting.

### Live execution authority

A retained journal proves accounting history, not current permission to execute.
Delegated clients revalidate the exact account and workspace through `execution`
before model requests and tool effects, and again before committing staged file
bytes. Revoked grants, stopped owners and an unreachable authority refuse further
work even when cached history is readable. Reconciliation reads do not restore
execution permission or release unresolved reservations.


### Runnable host conformance example

Run `npm run test:reviewed-host` from the source checkout. The example at
`scripts/qualification/reviewed-host.mjs` creates a reviewed native run, serves
its parent ledger over HTTP and launches two concurrent built headless CLI
processes with separate account-scoped credentials against a deterministic local
inference endpoint. Each account ledger is also served by its own CLI process,
which is stopped and recreated during the restart check. Both children settle
into one parent allowance. Retained unknown requests then exhaust that allowance;
a host restart preserves them, and real CLI invocations refuse exhausted,
foreign-workspace, sibling-account and cancelled authority without another
inference request.
It uses private disposable configuration and makes no paid provider requests.

To qualify a standalone artifact built from the same source:

```sh
npm run build
bun packaging/build-binary.mjs --native
CALLIOPE_REVIEWED_HOST_BINARY="$PWD/packaging/dist/calliope-native" \
  node scripts/qualification/reviewed-host.mjs
```

The executable reports its tested artifact type and invariant results as JSON.
This is a local HTTP host example, not a deployed Astrolift acceptance test.
Use `delegation-ledger/v1`, reviewed host capability version 1 and the headless
capability tuple above; a matching package version alone is insufficient.
The current CLI entry point requests a 4096-token output limit, so the reviewed
host and discovered model must both permit that bound. Lower output caps are
available to library callers through `DelegatedExecutionOptions.maxOutputTokens`.
The existing ledger, workspace and session suites cover nested grants, lost
acknowledgments, rollback and approval/session replay; those are separate from
this example's process-level assertions.
