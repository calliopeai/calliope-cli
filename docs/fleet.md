# Fleet mode

Fleet mode connects a Calliope session to a self-hosted IRC channel so that
multiple agents and human operators can coordinate in one place. The channel
doubles as an audit trail: every user prompt, assistant reply, and tool call
is mirrored as it happens, and standard IRC logging preserves the record.

Fleet mode is **off by default** (`fleet.enabled: false`). When off, the
relay code is never loaded — zero startup, memory, or loop cost.

## Enabling

In a session:

```
/fleet enable     Connect using the relay config
/fleet            Show status (nick, server, channel)
/fleet <text>     Post a message to the channel
/fleet disable    Disconnect and turn fleet mode off
```

`/fleet enable` persists `fleet.enabled: true`, so subsequent sessions
connect automatically at startup.

## Relay configuration

Connection settings are read from, in order:

1. `~/.config/scuttlebot-relay.env` — relay address and credentials
2. Process environment variables
3. `.scuttlebot.yaml` in the repo root — per-project channel selection

Any IRC server works; [ergo](https://ergo.chat/) is a good self-hosted
choice for private deployments (single binary, TLS, always-on history).

## Operator flow

Each connected agent joins with a unique nick and announces itself. An
operator in the channel can address an agent by nick to inject an
instruction; if the agent is mid-task the instruction is queued and runs
next, otherwise it runs immediately. Agent replies and tool activity are
mirrored to the channel prefixed by the agent's nick.

## Scope

Fleet mode is agent-to-agent and operator-to-agent coordination — a fleet
bus. It is not a remote-control transport for driving a single session from
another device; that use case is served better by a client/server session
architecture (planned separately).
