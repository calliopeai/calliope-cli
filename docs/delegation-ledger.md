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
starts a headless run:

```sh
calliope --headless --json --ledger-url URL --ledger-token-file /private/child.token \
  --ledger-agent CHILD_ACCOUNT "objective"
```

The turn runs under `ExecutionGuard` with the parent's ledger: the child's tools, paths, deadline
and budget come from its grant, and every provider request is reserved and settled with the
parent. A revoked or unknown grant, or an unreachable parent, stops the child before any turn.
The three flags go together.

## Operations

`POST /v1/<op>` with `Authorization: Bearer <token>` and a JSON body.

| Op | Who | Effect |
| --- | --- | --- |
| `hello` | any | protocol and operations |
| `journal` | any | the full hash-chained history (`manifest`, `events`) |
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

## Client behaviour

`RemoteReservationLedger` gives `ExecutionGuard` the same read/reserve/settle surface as the local
ledger. It replays and verifies the hash chain itself and refuses any history that is not an
append-only extension of what it has seen, so a server reset or rollback cannot return spent
capacity. Writes retry with the same id; if every attempt is lost it inspects the journal, and
only an outcome the parent recorded counts. Otherwise the result is `unavailable` and nothing is
authorized (a reservation that was admitted stays charged).

The shared project budget also retains its reservation while admission is unknown.
An error releases project capacity only after a confirmed rejection before any
lost response. Even a fresh journal can lag an in-flight admission. Neither a
disconnect nor restarting the child restores the reserved project capacity.
Reservation errors optionally report `admission: refused` when the server has
verified non-admission after the local operation ends, or `unknown` otherwise.
Clients retain capacity when talking to older v1 servers that omit this evidence.

`tests/delegation-ledger.test.ts` is the local-host conformance suite: concurrent and nested
children exhausting one allowance, duplicate dispatch and lost acknowledgements, an unreachable
parent, restart and rollback, revocation of a child and its descendants, foreign runs, siblings
and forged tokens, and `ExecutionGuard` admission through the parent.
