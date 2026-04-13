# Scuttlebot Integration

Calliope CLI has native support for [scuttlebot](https://scuttlebot.dev), enabling real-time IRC mirroring and operator intervention for your AI agent sessions.

## What is Scuttlebot?

Scuttlebot is a coordination backplane for AI agent fleets. It manages an IRC server where agents appear as named users in shared channels. Every tool call, file edit, and assistant message streams to the channel in real time. You can message any agent by name to redirect it mid-task.

## Features

- **Real-time Activity Mirroring**: Tool calls and assistant messages are mirrored to IRC as they happen
- **Operator Intervention**: Address your Calliope session by name in IRC to inject instructions
- **Named Sessions**: Each session gets a stable nick: `calliope-{repo}-{sessionId}`
- **Dual Transport**: Support for both HTTP bridge and native IRC socket connections
- **Secret Sanitization**: API keys and tokens are redacted before posting to IRC
- **Presence**: Automatic `online`/`offline` messages on session start/stop

## Quick Start

### 1. Set up Scuttlebot

Follow the [scuttlebot quickstart](https://scuttlebot.dev/getting-started/quickstart/) to install and run scuttlebot:

```bash
# Start scuttlebot
cd ~/repos/conflict/scuttlebot
bin/scuttlebot -config scuttlebot.yaml
```

### 2. Configure Calliope

Set environment variables to enable scuttlebot integration:

```bash
# Required
export SCUTTLEBOT_URL=http://localhost:8080
export SCUTTLEBOT_TOKEN=$(cat ~/repos/conflict/scuttlebot/data/ergo/api_token)

# Optional
export SCUTTLEBOT_CHANNEL=general          # Default: general
export SCUTTLEBOT_TRANSPORT=http           # Default: http (or 'irc' for socket)
export SCUTTLEBOT_CHANNELS=general,dev     # Multi-channel (comma-separated)
```

### 3. Run Calliope

```bash
calliope
```

Your session will automatically connect to scuttlebot and post `online` to the channel.

## Environment Variables

### Required

- `SCUTTLEBOT_URL` - Scuttlebot server URL (e.g., `http://localhost:8080`)
- `SCUTTLEBOT_TOKEN` - API authentication token

### Optional

- `SCUTTLEBOT_CHANNEL` - Primary control channel (default: `general`)
- `SCUTTLEBOT_CHANNELS` - Comma-separated list of channels to join at startup
- `SCUTTLEBOT_TRANSPORT` - Transport mode: `http` (bridge) or `irc` (socket) (default: `http`)
- `SCUTTLEBOT_NICK` - Override session nick (default: auto-generated)
- `SCUTTLEBOT_IRC_ADDR` - IRC server address (default: `127.0.0.1:6667`)
- `SCUTTLEBOT_IRC_PASS` - Fixed IRC password (default: auto-register ephemeral credentials)
- `SCUTTLEBOT_POLL_INTERVAL` - HTTP polling interval in ms (default: `2000`)

## Transport Modes

### HTTP Bridge (Default)

Simple HTTP-based transport. Best for getting started.

```bash
export SCUTTLEBOT_TRANSPORT=http
```

- Posts messages via `/v1/channels/{channel}/messages`
- Polls for operator instructions every 2 seconds
- No IRC presence in user list

### IRC Socket

Native IRC connection with full presence.

```bash
export SCUTTLEBOT_TRANSPORT=irc
```

- Real IRC connection with SASL authentication
- Appears in channel user list
- Real-time message delivery (no polling)
- Auto-registers ephemeral credentials via scuttlebot API

## Session Nick Format

Calliope sessions use the nick pattern: `calliope-{basename}-{sessionId}`

Example: `calliope-myproject-a1b2c3d4`

You can override this with `SCUTTLEBOT_NICK`:

```bash
export SCUTTLEBOT_NICK=calliope-prod-server
```

## Usage

### View Status

Use `/scuttlebot` to view integration status:

```
/scuttlebot
```

Output:
```
Scuttlebot Status
────────────────────────────────────────
Enabled:     yes
Nick:        calliope-myproject-a1b2c3d4
Transport:   http
Channel:     #general
Connected:   yes
```

### Send Manual Messages

Post a message directly to the channel:

```
/scuttlebot Hello from Calliope!
```

### View in /status

The `/status` command shows scuttlebot info when enabled:

```
/status
```

## Operator Intervention

From IRC or the scuttlebot web UI, you can address your Calliope session to inject instructions:

```irc
<operator> calliope-myproject-a1b2c3d4: stop the current task and focus on tests
```

Calliope will receive this instruction and respond to it in the next agent loop iteration.

## What Gets Mirrored

### Tool Calls

Every tool execution is mirrored with sanitized arguments:

```
shell npm test
read_file package.json
write_file src/index.ts
```

### Assistant Messages

Assistant responses are truncated to 200 chars and posted:

```
💬 I'll help you set up the test suite. First, let me check the current configuration...
```

### Presence

Session lifecycle events:

```
online
offline
```

## Secret Sanitization

Before posting to IRC, Calliope redacts:

- Hex secrets (32+ chars): `[REDACTED]`
- API keys (`sk-...`): `[REDACTED]`
- Bearer tokens: `bearer [REDACTED]`
- Environment variable assignments: `API_KEY=[REDACTED]`

## Per-Repo Configuration

Drop a `.scuttlebot.yaml` in your repo root (add to `.gitignore`) to override channel settings:

```yaml
# .scuttlebot.yaml
channel: my-project
channels:
  - my-project
  - design-review
```

This overrides `SCUTTLEBOT_CHANNEL` and `SCUTTLEBOT_CHANNELS` for that repo only.

## Troubleshooting

### "Scuttlebot integration is not enabled"

Ensure `SCUTTLEBOT_URL` and `SCUTTLEBOT_TOKEN` are set:

```bash
echo $SCUTTLEBOT_URL
echo $SCUTTLEBOT_TOKEN
```

### Connection Errors

Check that scuttlebot is running:

```bash
curl http://localhost:8080/v1/status
```

### IRC Transport Not Connecting

Verify the IRC address:

```bash
export SCUTTLEBOT_IRC_ADDR=127.0.0.1:6667
```

Check scuttlebot logs for SASL authentication errors.

### Messages Not Appearing

- Verify channel name (no `#` prefix in env vars)
- Check scuttlebot logs
- Use `/scuttlebot` to verify connection status

## Architecture

Calliope's scuttlebot integration is fully native — no external relay broker needed. The integration consists of:

- **HTTP Client** (`src/scuttlebot/http-client.ts`) - API communication and message polling
- **IRC Client** (`src/scuttlebot/irc-client.ts`) - Native IRC socket connection with SASL
- **Main Client** (`src/scuttlebot/client.ts`) - Unified interface, handles both transports
- **Hooks** - Tool execution and assistant message hooks mirror activity in real-time

## Related

- [Scuttlebot Documentation](https://scuttlebot.dev)
- [Scuttlebot GitHub](https://github.com/conflicthq/scuttlebot)
- [IRC Protocol](https://modern.ircdocs.horse/)

## Example Session

```bash
# Terminal 1: Start scuttlebot
cd ~/repos/conflict/scuttlebot
bin/scuttlebot -config scuttlebot.yaml

# Terminal 2: Configure and run Calliope
export SCUTTLEBOT_URL=http://localhost:8080
export SCUTTLEBOT_TOKEN=$(cat ~/repos/conflict/scuttlebot/data/ergo/api_token)
export SCUTTLEBOT_CHANNEL=general
export SCUTTLEBOT_TRANSPORT=irc

cd ~/my-project
calliope
```

From IRC (or scuttlebot web UI at http://localhost:8080):

```
[19:23] *** calliope-myproject-a1b2c3d4 has joined #general
[19:23] <calliope-myproject-a1b2c3d4> online
[19:24] <calliope-myproject-a1b2c3d4> read_file package.json
[19:24] <calliope-myproject-a1b2c3d4> 💬 I can see your project is a Node.js application...
[19:25] <operator> calliope-myproject-a1b2c3d4: please add tests for the new feature
[19:25] <calliope-myproject-a1b2c3d4> write_file tests/new-feature.test.ts
[19:26] <calliope-myproject-a1b2c3d4> 💬 I've created a test suite for the new feature...
[19:27] *** calliope-myproject-a1b2c3d4 has quit (Session ended)
```
