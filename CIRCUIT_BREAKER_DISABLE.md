# How to Disable Circuit Breakers

Circuit breakers are safety mechanisms that monitor for problematic patterns during agent execution. You can disable them in several ways:

## Option 1: Via Configure Tool (Recommended)

Inside Calliope, ask the AI to disable them:

```
disable circuit breakers
```

Or explicitly:

```
set circuitBreakersEnabled to false
```

The AI will use the `configure` tool to set the config value.

## Option 2: Via Command

Use the `/breaker` command:

```
/breaker disable all
```

## Option 3: Via calliope configure command

From your terminal (when not in a Calliope session):

```bash
calliope
```

Then use the configure tool:
```
configure set circuitBreakersEnabled false
```

## Option 4: Directly Edit Config

Find your config file:
```bash
calliope
/config
```

This will show the path (usually `~/.config/calliope-nodejs/config.json`).

Edit that file and set:
```json
{
  "circuitBreakersEnabled": false
}
```

## Option 5: Environment Variable

Set before running Calliope:

```bash
export CALLIOPE_CIRCUIT_BREAKERS=false
calliope
```

## Verify It's Disabled

Check status:
```
/breaker status
```

Or:
```
/status
```

## What Gets Disabled

When circuit breakers are off, the following safety checks are bypassed:

- **Infinite Loop Detection** - Won't stop repetitive tool patterns
- **Resource Exhaustion** - Won't limit excessive tool calls
- **Error Cascade Detection** - Won't stop chains of failures
- **Dangerous Pattern Detection** - Won't flag risky sequences

## Re-enable Later

```
/breaker enable all
```

Or:
```
configure set circuitBreakersEnabled true
```

## Current Uncommitted Changes

Based on your current work, you have:

1. ✅ Added `.scuttlebot.yaml` with `channel: calliope`
2. ✅ Created `src/scuttlebot/config.ts` for repo-level channel config
3. ✅ Modified `src/scuttlebot/client.ts` to use `resolveChannelConfig`
4. ✅ Created `tests/scuttlebot-config.test.ts`
5. ✅ Added scuttlebot integration to Ink UI (`src/ui/index.tsx`, `src/ui/agent.ts`, `src/ui/commands.ts`)

Ready to commit when you want!
