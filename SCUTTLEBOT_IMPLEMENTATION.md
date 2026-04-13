# Scuttlebot Native Integration - Implementation Summary

## Overview

Added native scuttlebot support to Calliope CLI, enabling real-time IRC mirroring and operator intervention without requiring an external relay broker.

## Architecture

### Core Components

1. **HTTP Client** (`src/scuttlebot/http-client.ts`)
   - API communication with scuttlebot server
   - Agent registration for IRC credentials
   - Message posting and polling
   - Health checks

2. **IRC Client** (`src/scuttlebot/irc-client.ts`)
   - Native IRC socket connection
   - SASL authentication
   - Real-time message delivery
   - Channel join/part operations

3. **Main Client** (`src/scuttlebot/client.ts`)
   - Unified interface for both transports
   - Session nick generation: `calliope-{basename}-{sessionId}`
   - Secret sanitization (API keys, tokens, hex secrets)
   - Automatic online/offline presence
   - Operator instruction polling/handling

### Integration Points

1. **CLI Startup** (`src/cli/index.ts`)
   - Initialize scuttlebot client from environment variables
   - Post `online` presence on session start
   - Post `offline` and disconnect on exit

2. **Tool Execution** (`src/tools.ts`)
   - Mirror every tool call to IRC with sanitized arguments
   - Non-blocking (errors don't interrupt tool execution)

3. **Assistant Messages** (`src/cli/agent.ts`)
   - Mirror assistant responses (truncated to 200 chars)
   - Posted after message is added to conversation history

4. **Commands** (`src/cli/commands.ts`)
   - `/scuttlebot` - View status or send manual messages
   - `/status` - Shows scuttlebot info when enabled
   - Help text updated

## Environment Variables

### Required
- `SCUTTLEBOT_URL` - Server URL (e.g., http://localhost:8080)
- `SCUTTLEBOT_TOKEN` - API authentication token

### Optional
- `SCUTTLEBOT_CHANNEL` - Primary control channel (default: general)
- `SCUTTLEBOT_CHANNELS` - Comma-separated channel list
- `SCUTTLEBOT_TRANSPORT` - `http` or `irc` (default: http)
- `SCUTTLEBOT_NICK` - Override auto-generated nick
- `SCUTTLEBOT_IRC_ADDR` - IRC server address (default: 127.0.0.1:6667)
- `SCUTTLEBOT_IRC_PASS` - Fixed password (default: auto-register)
- `SCUTTLEBOT_POLL_INTERVAL` - HTTP polling interval in ms (default: 2000)

## Transport Modes

### HTTP Bridge (Default)
- Simple HTTP POST/GET to scuttlebot API
- Polls for operator messages every 2 seconds
- No IRC presence in user list
- Best for getting started

### IRC Socket
- Native IRC connection with SASL auth
- Real-time message delivery (no polling)
- Appears in channel user list
- Auto-registers ephemeral credentials

## Features Implemented

✅ Dual transport support (HTTP and IRC)
✅ Session nick generation and registration  
✅ Tool call mirroring with argument sanitization
✅ Assistant message mirroring (truncated)
✅ Online/offline presence
✅ Secret sanitization (API keys, tokens, env vars)
✅ Operator instruction polling (HTTP mode)
✅ Real-time message handlers (IRC mode)
✅ `/scuttlebot` command for status and manual messages
✅ Integration with `/status` command
✅ Help text and command completion
✅ Comprehensive documentation

## Secret Sanitization

Before posting to IRC, the following are redacted:

- Hex secrets (32+ chars): `\b[a-f0-9]{32,}\b` → `[REDACTED]`
- API keys: `\bsk-[A-Za-z0-9_-]+\b` → `[REDACTED]`
- Bearer tokens: `bearer [token]` → `bearer [REDACTED]`
- Environment vars: `API_KEY=secret` → `API_KEY=[REDACTED]`

## Dependencies Added

- `irc-framework` (^4.14.0) - IRC client library

## Files Created

```
src/scuttlebot/
├── index.ts              # Barrel export
├── client.ts             # Main integration client
├── http-client.ts        # HTTP API transport
└── irc-client.ts         # IRC socket transport

docs/
└── scuttlebot-integration.md  # User documentation
```

## Files Modified

```
package.json              # Added irc-framework dependency
README.md                 # Added feature section
src/cli/index.ts          # Initialize and cleanup
src/cli/agent.ts          # Mirror assistant messages
src/cli/commands.ts       # Added /scuttlebot command
src/cli/types.ts          # Added to COMMANDS array
src/tools.ts              # Mirror tool calls
```

## Usage Example

```bash
# Start scuttlebot
cd ~/repos/conflict/scuttlebot
bin/scuttlebot -config scuttlebot.yaml

# Configure Calliope
export SCUTTLEBOT_URL=http://localhost:8080
export SCUTTLEBOT_TOKEN=$(cat ~/repos/conflict/scuttlebot/data/ergo/api_token)
export SCUTTLEBOT_TRANSPORT=irc

# Run Calliope
cd ~/my-project
calliope
```

From IRC:
```
[19:23] *** calliope-myproject-a1b2c3d4 has joined #general
[19:23] <calliope-myproject-a1b2c3d4> online
[19:24] <calliope-myproject-a1b2c3d4> read_file package.json
[19:24] <calliope-myproject-a1b2c3d4> 💬 I can see your project is...
[19:25] <operator> calliope-myproject-a1b2c3d4: add tests please
```

## Benefits vs Relay Broker Approach

1. **Simpler Setup**: No separate relay binary to install/manage
2. **Native Integration**: Direct access to Calliope's internals
3. **Type Safety**: Full TypeScript throughout
4. **Maintainability**: One codebase instead of two
5. **Performance**: No PTY overhead or log parsing
6. **Flexibility**: Easy to extend with Calliope-specific features

## Testing Checklist

- [ ] HTTP transport connects and posts messages
- [ ] IRC transport connects with auto-registration
- [ ] Tool calls appear in IRC with sanitized args
- [ ] Assistant messages appear truncated
- [ ] Online/offline presence posted correctly
- [ ] `/scuttlebot` command shows status
- [ ] Manual message posting works
- [ ] Secrets properly sanitized
- [ ] Graceful failure when scuttlebot unavailable
- [ ] Multi-channel support works

## Next Steps

1. Install dependencies: `npm install`
2. Build: `npm run build`
3. Test with scuttlebot server
4. Update CHANGELOG.md for next release
5. Consider adding operator instruction injection into active loops

## Related

- [Scuttlebot Documentation](https://scuttlebot.dev)
- [Scuttlebot Relay Pattern](https://scuttlebot.dev/guide/relays/)
- [IRC Protocol](https://modern.ircdocs.horse/)
