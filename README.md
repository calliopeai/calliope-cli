# Calliope CLI

> The Muse of Digital Eloquence

Multi-model AI agent CLI with Ralph Wiggum autonomous loops. Use Claude, Gemini, GPT, and more from a single elegant interface.

```
  ╭─────────────────────────────────────────────────────────────────╮
  │                                                                   │
  │     ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗  │
  │    ██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝  │
  │    ██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗    │
  │    ██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝    │
  │    ╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗  │
  │     ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝  │
  │                                                                   │
  │              The Muse of Digital Eloquence                        │
  │                                                                   │
  ╰─────────────────────────────────────────────────────────────────╯
```

## Installation

```bash
npm install -g @calliopeai/cli
```

## Quick Start

```bash
# Run Calliope (first run will prompt for setup)
calliope

# Or set API key via environment
export ANTHROPIC_API_KEY=sk-ant-...
calliope
```

On first run, Calliope will guide you through:
1. Selecting an AI provider (Anthropic, Google, OpenAI, etc.)
2. Entering your API key
3. Choosing a persona (Calliope, Professional, or Minimal)

## Features

### Multi-Model Support

Switch between providers on the fly:

```
calliope> /provider anthropic    # Use Claude
calliope> /provider google       # Use Gemini
calliope> /provider openai       # Use GPT
calliope> /provider openrouter   # Use any model via OpenRouter
```

### Ralph Wiggum Autonomous Loops

Run tasks autonomously until completion:

```
calliope> /loop "Build a REST API with CRUD operations. Output DONE when complete." --max-iterations 20 --completion-promise "DONE"
```

The loop will:
- Run your prompt repeatedly
- Each iteration sees the previous work (files, git history)
- Stop when it outputs the completion promise
- Or stop at max iterations

Cancel anytime with `/cancel-loop` or `ESC`.

### Tools

Calliope has access to:
- **Shell** - Run any command
- **Read/Write Files** - File operations
- **Think** - Structured reasoning

### Personas

```
calliope> /persona calliope      # Poetic, creative
calliope> /persona professional  # Clear, concise
calliope> /persona minimal       # Extremely brief
```

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/provider <name>` | Switch AI provider |
| `/model <name>` | Set model |
| `/persona <name>` | Switch persona |
| `/clear` | Clear conversation |
| `/status` | Show current status |
| `/loop "<prompt>"` | Start autonomous loop |
| `/cancel-loop` | Stop active loop |
| `/setup` | Reconfigure |
| `/exit` | Exit |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic Claude API key |
| `GOOGLE_API_KEY` | Google Gemini API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `TOGETHER_API_KEY` | Together AI API key |
| `GROQ_API_KEY` | Groq API key |

## Configuration

Config is stored in `~/.config/calliope/config.json` (or platform equivalent).

```bash
# Show config location
calliope --config

# Reset config
calliope --reset

# Force setup wizard
calliope --setup
```

## Examples

### Basic Usage

```bash
$ calliope
calliope> What's in this directory?
✧ Calliope:
│ Let me check...
╭─ ⚡ shell
│  $ ls -la
│  ...
╰─ ✓
│ This directory contains...
```

### Autonomous Loop

```bash
calliope> /loop "Refactor all TypeScript files to use strict mode. Run tsc after each change. Output DONE when no errors." --max-iterations 30 --completion-promise "DONE"

╭─ 🔄 Ralph Loop Started
│  Max: 30
│  Promise: DONE
╰─ /cancel-loop to stop

╭─ Iteration 1/30
...
🎉 Completion promise detected!
```

## License

MIT © 2026 Calliope Labs Inc
