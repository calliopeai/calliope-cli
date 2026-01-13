# Getting Started

Get up and running with Calliope CLI in minutes.

## Installation

### Quick Install (recommended)
```bash
curl -fsSL https://calliope.ai/install.sh | bash
```

### npm
```bash
npm install -g @calliopelabs/cli
```

### Verify Installation
```bash
calliope --version
```

---

## Initial Setup

### Option 1: Interactive Setup
Run Calliope and follow the setup wizard:
```bash
calliope
```

The wizard will guide you through:
1. Selecting your preferred AI provider
2. Entering your API key
3. Choosing a default model

### Option 2: Environment Variables
```bash
export ANTHROPIC_API_KEY=sk-ant-...
calliope
```

### Option 3: Config File
Create `~/.config/calliope/config.json`:
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "apiKeys": {
    "anthropic": "sk-ant-..."
  }
}
```

---

## Your First Session

### Start Calliope
```bash
cd your-project
calliope
```

### Basic Interaction
```
calliope 🔄> Hello! Can you help me understand this codebase?
```

### Try Some Commands
```bash
/status              # Check current provider/model
/help                # See all commands
/find auth           # Search for files
/clear               # Start fresh
```

---

## Quick Examples

### Ask Questions
```
What does the main function do in index.ts?
```

### Make Changes
```
Add error handling to the login function
```

### Run Tasks
```
Fix all TypeScript errors in src/
```

### Autonomous Mode
```bash
/loop "Refactor all components to use hooks"
```

---

## Key Concepts

### Modes

Calliope has three operating modes:

| Mode | When to Use |
|------|-------------|
| **Hybrid** (default) | Most tasks - auto-plans when needed |
| **Work** | Simple tasks - direct execution |
| **Plan** | Exploration - no tool execution |

Switch modes:
```bash
/mode work
/mode plan
/mode hybrid
```

### God Mode

Skip confirmation prompts for faster execution:
```bash
calliope -g
```

Or during session:
```bash
/confirm off
```

### Context Management

Monitor context usage in the status bar:
```
anthropic:claude-sonnet-4 │ 45K/200K │ $0.23
```

When context fills up:
```bash
/summarize compact    # Compress history
/clear                # Start fresh
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Tab` | Autocomplete commands/paths |
| `Up/Down` | Navigate input history |
| `Ctrl+C` | Cancel current operation |
| `Ctrl+L` | Clear screen |
| `Esc` | Exit |

---

## Project Memory

Calliope automatically reads context from:
- `CALLIOPE.md` - Project memory
- `CLAUDE.md` - Claude context
- `README.md` - Project readme
- `.cursorrules` - Cursor rules

Create project memory:
```bash
/memory init
```

Add context:
```bash
/memory add context "This is a React TypeScript project"
/memory add preference "Use functional components"
```

---

## Sessions

### Resume Previous Session
On startup, Calliope offers to resume recent sessions:
```
Found previous session (2 hours ago)
  • 12 messages
[R]esume  [N]ew session
```

### Manual Resume
```bash
/resume
```

### View Sessions
```bash
/session list
```

---

## Next Steps

- [Commands Reference](./commands.md) - All available commands
- [Configuration](./configuration.md) - Customize your setup
- [Providers](./providers.md) - Available AI providers
- [Features](./features.md) - Deep-dive into features

---

## Troubleshooting

### "No API keys configured"
```bash
calliope --setup
# Or set environment variable:
export ANTHROPIC_API_KEY=sk-ant-...
```

### "Empty response from API"
- Check API key validity
- Verify account has credits
- Try a different provider: `/provider openai`

### Context limit warnings
```bash
/summarize compact    # Compress context
/clear                # Start fresh
```

### Need help?
```bash
/help
```

Or visit: https://github.com/calliopeai/calliope-cli/issues
