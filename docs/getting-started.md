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

## Install as a single binary

> No Node.js, npm, or Bun required —
> one self-contained executable per platform (macOS arm64/x64, Linux arm64/x64).

**Verified installer** (requires authenticated GitHub CLI and curl; verifies signed
provenance and SHA-256 before installing to
`/usr/local/bin` or `~/.local/bin`):

```
curl -fsSL https://raw.githubusercontent.com/calliopeai/calliope-cli/main/install.sh | bash
```

Historical binaries without attestations are refused. The 3.2 release remains blocked
by provider evidence; see [release integrity](release-integrity.md) for prerequisites,
preview artifacts and independent verification.

**Homebrew** (macOS, separate tap distribution):

```
brew install calliopeai/tap/calliope
```

**Manual** — download the asset for your platform from the
[latest release](https://github.com/calliopeai/calliope-cli/releases/latest)
(`calliope-<version>-<os>-<arch>`) and its `.sigstore.json` bundle, verify its
[provenance and signed checksums](release-integrity.md#standalone-binaries), then:

```
chmod +x calliope-*-darwin-arm64 && sudo mv calliope-*-darwin-arm64 /usr/local/bin/calliope
```

The binary is a drop-in replacement for the npm-installed `calliope` — same
flags, same TUI. It starts in ~75 ms cold (vs ~90 ms for `node`), and self-update
via `calliope --upgrade` still routes through npm, so binary users should
re-download from releases (or re-run the installer) to upgrade.

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
applies them. Work and hybrid modes ask for confirmation on risky operations.

## Modes

Calliope has four modes. It starts in `hybrid`.

| Mode | Behavior |
|------|----------|
| `plan` | Chat and planning only; no tools run. Good for exploring. |
| `hybrid` | Plans before complex work, then executes. Default. |
| `work` | Executes directly and asks before risky or mutating tools. |
| `auto` | Executes directly without per-tool prompts for this session. |

Switch with `/mode <name>`, or press `Shift+Tab` to cycle. Start in plan mode
when you want to think through an approach before any files change:

```
/mode plan
How should I structure the auth module?
```

Use `/mode auto` when you want the current interactive session to continue
without approval prompts. `/auto on|off` and `/permissions off|on` control the
same setting. Policy, project scope, sandbox and orchestration authority checks
still apply.

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

See the [Commands reference](./commands.md) for commands and their subcommands.

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
    --auto          start the interactive REPL in auto mode
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
