# Testing Scuttlebot Integration

## Quick Test

### 1. Test Config Resolution

```bash
# Run unit tests
npx vitest run tests/scuttlebot-config.test.ts

# Run manual test
node test-scuttlebot-config.js
```

### 2. Test Mid-Session Enable

```bash
# Start calliope (without scuttlebot env vars)
npm start

# In the session:
/scuttlebot
# Should show: "Scuttlebot integration is not enabled."

# Set env vars in another terminal:
export SCUTTLEBOT_URL=http://localhost:3000
export SCUTTLEBOT_TOKEN=test-token-123

# Then in the calliope session:
/scuttlebot enable
# Should enable and show status with "calliope" channel from .scuttlebot.yaml
```

### 3. Test Channel Override

```bash
# Set override channel
export SCUTTLEBOT_CHANNEL=testing

# Start calliope
npm start

# Check status:
/scuttlebot
# Should show primary channel: testing
# Channels: [testing, calliope]
```

### 4. Test Multiple Channels

```bash
export SCUTTLEBOT_CHANNELS=dev,staging,prod

npm start
/scuttlebot
# Channels should include: dev, staging, prod, calliope
```

## Expected Behavior

### Without Config
- No `.scuttlebot.yaml`: Uses `SCUTTLEBOT_CHANNEL` or defaults to `general`
- Channel resolution: ENV > DEFAULT

### With Repo Config  
- `.scuttlebot.yaml` present: Automatically loads channel configuration
- Channel resolution: ENV > REPO > DEFAULT
- All channels are merged and deduplicated

### Commands

```
/scuttlebot              - Show status
/scuttlebot enable       - Enable mid-session (requires env vars)
/scuttlebot disable      - Disable and disconnect
/scuttlebot <message>    - Post a message to the channel
```

## Integration Points

### Startup (Automatic)
In `src/cli/index.ts` and `src/ui-cli.tsx`:
```typescript
const scuttlebotEnabled = await scuttlebotClient.initialize(session.id, state.cwd);
if (scuttlebotEnabled) {
  await scuttlebotClient.postOnline();
}
```

### Mid-Session (Manual)
Via `/scuttlebot enable` command:
```typescript
const enabled = await scuttlebotClient.initialize(sessionId, cwd);
```

### Config Loading
Happens inside `scuttlebotClient.initialize()`:
```typescript
const { channel, channels } = resolveChannelConfig(
  cwd,
  process.env.SCUTTLEBOT_CHANNEL,
  process.env.SCUTTLEBOT_CHANNELS
);
```

## Files Modified

- `src/scuttlebot/config.ts` - NEW: Config loader
- `src/scuttlebot/client.ts` - Uses `resolveChannelConfig()`
- `src/cli/commands.ts` - Added enable/disable subcommands
- `src/ui/commands.ts` - Added enable/disable subcommands
- `tests/scuttlebot-config.test.ts` - NEW: Test suite
- `.scuttlebot.yaml` - NEW: Example repo config

## Debug Commands

```bash
# Check what config would be loaded
node -e "
import { resolveChannelConfig } from './dist/scuttlebot/config.js';
console.log(resolveChannelConfig(process.cwd()));
"

# Test with env override
SCUTTLEBOT_CHANNEL=testing node -e "
import { resolveChannelConfig } from './dist/scuttlebot/config.js';
console.log(resolveChannelConfig(process.cwd(), 'testing'));
"
```
