# Calliope CLI

> The Muse of Digital Eloquence

Multi-model AI agent CLI with Ralph Wiggum autonomous loops. Use Claude, Gemini, GPT, and more from a single elegant interface.

```
 ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗
██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝
██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗
██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝
╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗
 ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝

        The Muse of Digital Eloquence
```

## Installation

```bash
npm install -g @calliopelabs/cli
```

## Quick Start

```bash
# Run Calliope (first run will prompt for setup)
calliope

# Or set API key via environment
export ANTHROPIC_API_KEY=sk-ant-...
calliope

# Run in god mode (no permission prompts)
calliope -g
calliope --god-mode
```

On first run, Calliope will guide you through:
1. Selecting an AI provider (Anthropic, Google, OpenAI, etc.)
2. Entering your API key
3. Choosing a persona (Calliope, Professional, or Minimal)

## Features

### Multi-Model Support

Switch between 12+ providers on the fly:

```
calliope> /provider anthropic    # Use Claude
calliope> /provider google       # Use Gemini
calliope> /provider openai       # Use GPT
calliope> /provider mistral      # Use Mistral
calliope> /provider ollama       # Use local models
calliope> /provider openrouter   # Use any model via OpenRouter
calliope> /provider litellm      # Use LiteLLM proxy
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

### Model Selection

Browse and select from available models with an interactive menu:

```
calliope> /models
🔍 Discovering models for anthropic...
✨ Found 5 models

? Select a model for anthropic:
❯ Claude 3.5 Sonnet (200K tokens) - $3.00/$15.00/1M
  Claude 3.5 Haiku (200K tokens) - $0.25/$1.25/1M
  Claude 3 Opus (200K tokens) - $15.00/$75.00/1M
  ...

calliope> /model              # Interactive selection
calliope> /model gpt-4o       # Direct model set
```

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
| `/model [name]` | Set model (interactive if no name) |
| `/models` | Browse and select available models |
| `/persona <name>` | Switch persona |
| `/clear` | Clear conversation |
| `/status` | Show current status |
| `/loop "<prompt>"` | Start autonomous loop |
| `/cancel-loop` | Stop active loop |
| `/upgrade` | Check for and install updates |
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
| `MISTRAL_API_KEY` | Mistral AI API key |
| `AI21_API_KEY` | AI21 Labs API key |
| `HUGGINGFACE_API_KEY` | HuggingFace API key |
| `OLLAMA_BASE_URL` | Ollama server URL (default: localhost:11434) |
| `LITELLM_BASE_URL` | LiteLLM proxy URL (default: localhost:4000) |
| `LITELLM_API_KEY` | LiteLLM API key (if required) |

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

## Security

### API Key Storage

API keys entered during setup are stored in `~/.config/calliope/config.json`. For better security:
- **Prefer environment variables** over stored keys
- The config file should have restricted permissions (0600)
- Never commit your config file to version control

### Tool Execution

Calliope can execute shell commands on your behalf. Safety measures include:
- **Path traversal protection** - File operations are restricted to the current directory and home folder
- **God mode warning** - Running with `-g`/`--god-mode` shows a clear warning
- **Timeout limits** - Shell commands timeout after 60 seconds by default

### Best Practices

1. **Review before running** - In normal mode, review tool calls before execution
2. **Use god mode carefully** - Only use `--god-mode` for trusted, well-defined tasks
3. **Limit iterations** - Always set `--max-iterations` on autonomous loops
4. **Work in project directories** - Run Calliope from your project root, not system directories

## Troubleshooting

### Common Issues

**"No API keys configured"**
- Run `calliope --setup` to configure your API key
- Or set environment variable: `export ANTHROPIC_API_KEY=sk-ant-...`

**"API key too short"**
- API keys have minimum length requirements (usually 40+ characters)
- Make sure you copied the full key

**"Empty response from API"**
- Check your API key is valid and has credits
- Try a different provider with `/provider`

**"Access denied" for file operations**
- File operations are restricted to cwd and home directory
- Use absolute paths within allowed directories

## More from Calliope

Check out our full suite of AI tools at **[calliope.ai](https://calliope.ai)**

## License

MIT © 2026 Calliope Labs Inc
