# Calliope CLI documentation

Calliope is a multi-model AI agent for the terminal: one agent, one loop, 13
provider backends, and a small, tested command surface.

## Contents

- [Getting started](./getting-started.md) — install, setup, first session
- [Commands](./commands.md) — all 22 commands and their subcommands
- [Configuration](./configuration.md) — config keys, defaults, environment variables
- [Providers](./providers.md) — supported backends and how credentials resolve
- [Local models](./local-models.md) — how the harness adapts to self-hosted 7-70B models
- [Features](./features.md) — the full v3 feature set (and what was removed)
- [Governance](./governance.md) — audit run logs, replay, budget caps, policy hook
- [Editors (ACP)](./acp.md) — run Calliope as an Agent Client Protocol agent in Zed, JetBrains, and more
- [Fleet mode](./fleet.md) — optional multi-agent coordination over IRC

## Quick reference

### Common commands

| Command | Description |
|---------|-------------|
| `/help` | List all commands |
| `/status` | Provider, model, token usage |
| `/model [name]` | Browse or switch models |
| `/provider [name]` | Switch provider |
| `/mode [plan\|hybrid\|work]` | Switch operating mode |
| `/loop "<prompt>"` | Run an autonomous agent loop |
| `/compact` | Compress conversation context |
| `/undo` | Revert the last change |
| `/cost` | Show spend this session |
| `/clear` | Clear the conversation |
| `/exit` | Quit (alias `/quit`) |
| `calliope replay <path\|id>` | Render an audit run-log trace (see [governance](./governance.md)) |

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Complete commands and paths |
| `Shift+Tab` | Cycle mode (plan -> hybrid -> work) |
| `Up` / `Down` | Navigate input history |
| `Ctrl+C` | Cancel the current operation |
| `Esc` | Dismiss a picker or modal |

## Getting help

- Issues: https://github.com/calliopeai/calliope-cli/issues
- Discussions: https://github.com/calliopeai/calliope-cli/discussions
