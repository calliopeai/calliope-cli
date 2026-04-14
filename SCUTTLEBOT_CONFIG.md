# Scuttlebot Configuration Integration

## Overview

Calliope CLI now supports `.scuttlebot.yaml` configuration files for automatic channel configuration when working in scuttlebot-enabled repositories.

## Features

### 1. Repository Configuration (`.scuttlebot.yaml`)

Place a `.scuttlebot.yaml` file in your repository root:

```yaml
# Single channel
channel: calliope

# Or multiple channels
channels:
  - calliope
  - release
  - dev
```

The file is automatically discovered by searching from the current working directory up to the git repository root.

### 2. Channel Resolution Priority

Channels are merged from multiple sources in this priority order:

1. **Explicit CLI argument** (future: `--channel`)
2. **SCUTTLEBOT_CHANNEL** environment variable
3. **SCUTTLEBOT_CHANNELS** environment variable (comma-separated)
4. **Repository `.scuttlebot.yaml`** file
5. **Default**: `general`

**Primary channel** is determined by the highest priority source.
**All channels** are merged and deduplicated across all sources.

### 3. Example Usage

#### Scenario 1: Repository Only
```bash
# .scuttlebot.yaml in repo:
# channel: calliope

$ calliope
# Uses channel: calliope
# Channels: [calliope]
```

#### Scenario 2: Environment Override
```bash
# .scuttlebot.yaml: channel: calliope
$ export SCUTTLEBOT_CHANNEL=testing
$ calliope
# Uses channel: testing (primary)
# Channels: [testing, calliope]
```

#### Scenario 3: Multiple Channels
```bash
# .scuttlebot.yaml: channel: calliope
$ export SCUTTLEBOT_CHANNELS=dev,staging
$ calliope
# Uses channel: dev (primary)
# Channels: [dev, staging, calliope]
```

## Implementation

### Files Added

- `src/scuttlebot/config.ts` - Configuration loader and resolver
- `tests/scuttlebot-config.test.ts` - Test suite (5 tests)
- `.scuttlebot.yaml` - Example config for calliope-cli repo

### Key Functions

```typescript
// Load .scuttlebot.yaml from repo
loadRepoConfig(dir: string): RepoScuttlebotConfig | null

// Resolve final channel configuration
resolveChannelConfig(
  cwd: string,
  channel?: string,      // Explicit channel
  channelsEnv?: string   // SCUTTLEBOT_CHANNELS value
): ResolvedChannelConfig

// Merge channels with deduplication
mergeChannels(existing: string[], extra: string[]): string[]
```

### Integration Point

The configuration is loaded in `ScuttlebotClient.initialize()`:

```typescript
const { channel, channels } = resolveChannelConfig(
  cwd,
  process.env.SCUTTLEBOT_CHANNEL,
  process.env.SCUTTLEBOT_CHANNELS
);
```

## Testing

### Unit Tests
```bash
npx vitest run tests/scuttlebot-config.test.ts
```

### Manual Testing
```bash
node test-scuttlebot-config.js
```

All tests pass ✓

## Environment Variables

The scuttlebot integration still requires these environment variables:

- `SCUTTLEBOT_URL` - Server URL (required)
- `SCUTTLEBOT_TOKEN` - API token (required)
- `SCUTTLEBOT_CHANNEL` - Override default channel
- `SCUTTLEBOT_CHANNELS` - Additional channels (comma-separated)
- `SCUTTLEBOT_TRANSPORT` - `http` or `irc` (default: `http`)
- `SCUTTLEBOT_NICK` - Override auto-generated nick

## Future Enhancements

- [ ] `/scuttlebot enable` command for mid-session activation
- [ ] `/scuttlebot channel <name>` to switch channels
- [ ] `--channel` CLI flag
- [ ] Support for `.scuttlebot.json` format
- [ ] Per-channel message routing
