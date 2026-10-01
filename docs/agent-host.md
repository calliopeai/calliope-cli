# Agent Host Protocol

`calliope attach` lists or follows sessions running on an existing agent host:

```sh
calliope attach --url wss://hub.example/agent-host/
calliope attach --hub https://hub.example --user alice
calliope attach --hub https://hub.example --user alice 'copilot:/session' --read-only
calliope attach --url wss://hub.example/agent-host/ 'copilot:/session' --once
```

The token comes from `JUPYTERHUB_API_TOKEN`, or the environment variable named
by `--token-env`. It is sent in the HTTP preflight and WebSocket upgrade headers.
Use `wss://` for remote hosts. Hub discovery checks `/agent-host/status` first
and connects to `/agent-host/` when enabled. Only a 404 permits the older
named-server discovery route. Authentication, entitlement and disabled refusals
are preserved; they cannot trigger a second route around the refusal.

The client offers AHP `1.0.0`, `0.9.0` and legacy `0.6.0`. The source-pinned
native compatibility gate covers 1.0.0 and 0.9.0; 0.6.0 remains the existing
compatibility offer. Pending tool approvals are recognized by the absence of
`confirmed`, even when the host omits `confirmationTitle`. The invocation
message supplies the prompt title in that case. `--read-only` never answers an
approval. Approvals already waiting at attach and subagent requests listed in
session `inputNeeded` use their original chat and turn.

Discovery, HTTP preflight, WebSocket upgrade, initialization, listing and both
subscriptions share a 60-second setup deadline. A timeout or connection loss
settles pending requests, releases the client transport and withdraws approval
prompts. Streaming after successful attach is not subject to that setup deadline.
Disconnecting leaves the task on its host; attach does not cancel it or start a
local replacement. Reattach explicitly to resume following its updates.

`--once` exits 0 on the next completed turn and 1 on error or cancellation.
Unavailable hosts return exit 3 and a reason: `disabled`, `unentitled`, `auth`,
`version` or `unreachable`. Local fallback requires a separate `calliope`
invocation. `CALLIOPE_AHP=off` disables attach before any network access.

## Native compatibility qualification

CI uses the actual upstream protocol handler, WebSocket transport and state
reducers, with a deterministic provider and no model or cloud calls:

| AHP | Upstream source commit |
| --- | --- |
| 1.0.0 | `08d4889f9ec4a1685d257b9b95de036c8e1ce1e5` |
| 0.9.0 | `07f806f999227108933c2e30515b26eecc1fda74` |

`scripts/qualification/ahp-fixture.mjs` shares the fixture from Calliope IDE
commit `effe71908719e76ed6ddd7389b56ceb28e1f80a7`. Prepare a pinned upstream
checkout with its lockfile's TypeScript compiler and `ws` installed, then run:

```sh
AHP_SOURCE=/path/to/prepared/vscode npm run test:ahp-protocol
```

The gate checks negotiation, listing, following, approval and denial, both
protocol error shapes, cancellation, transport loss and a fresh subscription's
retained history. It fails if the source is missing. These local native checks
complement deployed sign-in and physical two-client acceptance; they do not
establish those deployment results.
