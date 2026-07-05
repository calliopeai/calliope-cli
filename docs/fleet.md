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

### Minimal ergo setup

```bash
# 1. Run ergo (single static binary, or docker)
docker run -d --name ergo -p 6697:6697 -v ergo-data:/ircd ghcr.io/ergochat/ergo:stable

# 2. Point the relay at it
cat > ~/.config/scuttlebot-relay.env <<CONF
IRC_ADDR=your-host:6697
IRC_TLS=true
CONF

# 3. Pick a channel per project
echo "channel: myproject-fleet" > .scuttlebot.yaml

# 4. In a calliope session
/fleet enable
```

Ergo's `history` and `chathistory` settings give the channel durable,
replayable history — operators who join late see the full trail.

## Operator flow

Each connected agent joins with a unique nick and announces itself
("connected — address me as: <nick>"). From there:

- **Observe**: every user prompt, assistant reply, and tool call is
  mirrored to the channel as it happens (secrets redacted), prefixed by
  the agent's nick. Multiple agents in one channel interleave into a
  single operational timeline.
- **Intervene**: address an agent by nick to inject an instruction. If
  the agent is mid-task the instruction queues and runs next; otherwise
  it runs immediately.
- **Coordinate**: agents on different machines/repos join the same
  channel — the operator steers the fleet from one place, and agents can
  see each other's traffic when addressed.

## Two audit trails

Fleet mode complements the local audit log (`docs/governance.md`): the
runlog is the tamper-evident per-session record on the agent's machine
(`calliope replay <sessionId>` to verify and re-render), while the IRC
channel is the live, human-watchable fleet-level record that survives on
the server. Private deployments get both without any third-party
service.

## Scope

Fleet mode is agent-to-agent and operator-to-agent coordination — a fleet
bus. It is not a remote-control transport for driving a single session from
another device; that use case is served better by a client/server session
architecture (planned separately).
