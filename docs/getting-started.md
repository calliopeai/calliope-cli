# Getting started

Calliope is a multi-model AI agent for the terminal. This guide takes you from
install to your first session.

## Install

```
npm i -g @calliopelabs/cli
```

Requires Node.js 20 or later. Verify the install:

```
calliope --version
```

## Configure a provider

Run the setup wizard and follow the prompts to pick a provider and enter a key:

```
calliope --setup
```

The first time you run `calliope` with no configuration, the wizard starts
automatically. If a provider API key is already in your environment (for example
`ANTHROPIC_API_KEY`), Calliope uses it and skips the wizard. See
[Providers](./providers.md) for every backend and
[Configuration](./configuration.md) for keys and environment variables.

## Your first session

```
cd your-project
calliope
```

Type a request at the prompt and press Enter:

```
Explain what src/index.ts does, then add error handling to the init function.
```

Calliope reads the relevant files, proposes changes, and — outside plan mode —
applies them, asking for confirmation on risky operations.

## Modes

Calliope has three modes. It starts in `hybrid`.

| Mode | Behavior |
|------|----------|
| `plan` | Chat and planning only; no tools run. Good for exploring. |
| `hybrid` | Plans before complex work, then executes. Default. |
| `work` | Executes directly. |

Switch with `/mode <name>`, or press `Shift+Tab` to cycle. Start in plan mode
when you want to think through an approach before any files change:

```
/mode plan
How should I structure the auth module?
```

## Key commands

```
/help                 # list all commands
/status               # provider, model, token usage
/model                # browse and switch models
/provider anthropic   # switch provider
/loop "<prompt>"      # run an autonomous agent loop
/compact              # compress context when it fills up
/undo                 # revert the last change
/cost                 # show spend this session
/clear                # clear the conversation
/exit                 # quit
```

See the [Commands reference](./commands.md) for all 22 commands and their subcommands.

## Non-interactive use

Run a single task without the TUI — useful in scripts and CI:

```
calliope --headless "fix the failing lint rule"
echo "summarize the recent changes" | calliope --headless --json
```

## Project memory

Calliope loads `CALLIOPE.md` from your project directory at startup and treats it
as standing context. Create one and add notes:

```
/memory init
/memory add context "React 18 + TypeScript, ESM only"
/memory add preference "Use functional components"
```

## Command-line flags

```
-h, --help          show help
-v, --version       show version
-u, --upgrade       upgrade to the latest version
    --setup         run the setup wizard
    --config        show config path and status
    --reset         clear all configuration
-g, --god-mode      run tools without confirmation prompts
    --headless      non-interactive mode (auto-detected when piped)
    --json          emit a JSON event stream (with --headless)
    --max-retries N retry failed tool calls N times in headless mode (default 3)
    --debug         verbose logging to /tmp/calliope-debug.log
```

## Upgrading from v2

v3 is a major simplification. Your existing configuration migrates automatically
the first time v3 runs — see [Configuration → Migration](./configuration.md#migration).
Several v2 subsystems were removed; the full list and rationale is in
[Removed in v3](./features.md#removed-in-v3).

## Next steps

- [Commands](./commands.md) — every command and subcommand
- [Configuration](./configuration.md) — keys, defaults, environment variables
- [Providers](./providers.md) — supported backends and credentials
- [Features](./features.md) — the full feature set
- [Fleet mode](./fleet.md) — multi-agent coordination

Questions or bugs: https://github.com/calliopeai/calliope-cli/issues
