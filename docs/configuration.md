# Configuration

Calliope CLI can be configured via environment variables, config files, or runtime commands.

## Configuration Hierarchy

1. **Command-line flags** (highest priority)
2. **Environment variables**
3. **Config file** (`~/.config/calliope/config.json`)
4. **Defaults** (lowest priority)

---

## Config File

Located at `~/.config/calliope/config.json` (or platform equivalent).

### View Location
```bash
calliope --config
```

### Sample Configuration

```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "...",
    "mistral": "...",
    "groq": "gsk_...",
    "openrouter": "sk-or-..."
  },
  "theme": "default",
  "persona": "calliope",
  "godMode": false,
  "maxIterations": 25,
  "confirmRiskyOperations": true,
  "scope": ["./src", "./tests"],
  "autoRoute": false
}
```

### Configuration Options

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | string | `"anthropic"` | Default AI provider |
| `model` | string | `"claude-sonnet-4-20250514"` | Default model |
| `apiKeys` | object | `{}` | API keys by provider |
| `theme` | string | `"default"` | Visual theme |
| `persona` | string | `"calliope"` | AI persona |
| `godMode` | boolean | `false` | Skip all confirmations |
| `maxIterations` | number | `25` | Max autonomous loop iterations |
| `confirmRiskyOperations` | boolean | `true` | Confirm dangerous operations |
| `scope` | string[] | `[]` | Allowed directories |
| `autoRoute` | boolean | `false` | Auto-select model by task |

### Reset Configuration
```bash
calliope --reset
```

### Run Setup Wizard
```bash
calliope --setup
```

---

## Environment Variables

### API Keys

```bash
# Primary providers
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
export GOOGLE_API_KEY=...

# Additional providers
export MISTRAL_API_KEY=...
export GROQ_API_KEY=gsk_...
export XAI_API_KEY=xai-...
export CEREBRAS_API_KEY=...
export FIREWORKS_API_KEY=...
export DEEPSEEK_API_KEY=sk-...
export OPENROUTER_API_KEY=sk-or-...

# GitHub
export GITHUB_TOKEN=ghp_...
```

### Provider Configuration

```bash
# Default provider and model
export CALLIOPE_PROVIDER=anthropic
export CALLIOPE_MODEL=claude-sonnet-4-20250514

# Local provider URLs
export OLLAMA_BASE_URL=http://localhost:11434
export LITELLM_BASE_URL=http://localhost:4000
export LITELLM_API_KEY=...
```

### Behavior Configuration

```bash
# Enable god mode (skip confirmations)
export CALLIOPE_GOD_MODE=true

# Enable debug output
export CALLIOPE_DEBUG=true

# Set max iterations for loops
export CALLIOPE_MAX_ITERATIONS=50
```

---

## Command-Line Flags

```bash
# Run with god mode (no confirmations)
calliope -g
calliope --god-mode

# Show config location
calliope --config

# Reset configuration
calliope --reset

# Run setup wizard
calliope --setup

# Show version
calliope --version
calliope -v

# Show help
calliope --help
```

---

## Runtime Configuration

### `/set` Command

Change settings during a session:

```bash
/set maxIterations 50    # Set max loop iterations
```

### `/confirm` Command

Toggle confirmation prompts:

```bash
/confirm on     # Require confirmations
/confirm off    # Skip confirmations
```

### `/debug` Command

Toggle debug mode:

```bash
/debug on       # Enable verbose output
/debug off      # Disable debug output
```

---

## Profiles

Save and load configuration profiles:

### Save Current Config as Profile
```bash
/profile save work
```

### Load Profile
```bash
/profile work
/profile load work
```

### List Profiles
```bash
/profile list
```

### Delete Profile
```bash
/profile delete work
```

### Built-in Profiles

| Profile | Provider | Model | Use Case |
|---------|----------|-------|----------|
| `fast` | Groq | llama-3.3-70b | Speed priority |
| `smart` | Anthropic | claude-sonnet-4 | Quality priority |
| `cheap` | Google | gemini-flash | Cost priority |
| `local` | Ollama | llama3.2 | Privacy priority |

```bash
/profile fast    # Quick switch to fast config
```

---

## Data Storage

Calliope stores data in `~/.calliope-cli/`:

```
~/.calliope-cli/
├── config.json              # User configuration (legacy location)
├── costs.json               # Cost tracking data
├── sessions/                # Session data
│   ├── current -> ...       # Symlink to active session
│   └── 2025-01-13_project/
│       ├── session.json     # Session metadata
│       ├── chat.log         # Conversation history
│       ├── todos.txt        # Session TODOs
│       ├── active-todo.json # Currently active TODO
│       └── plans/           # Saved plans
├── todos/
│   ├── global.txt           # Global TODOs
│   └── by-project/          # Project-specific TODOs
├── templates/
│   └── prompts.json         # Saved prompt templates
├── plugins/                 # Custom plugins
└── history/
    └── commands.txt         # Command history
```

---

## Scope Configuration

Restrict which directories the AI can access:

### Via Config File
```json
{
  "scope": ["./src", "./tests", "./docs"]
}
```

### Via Commands
```bash
/scope add ./src
/scope add ./tests
/scope remove ./docs
/scope list
/scope reset
```

### Scope Behavior
- When scope is empty: AI can access cwd and subdirectories
- When scope is set: AI can only access listed directories
- Always blocked: System directories, parent directories

---

## Theme Configuration

### Available Themes
- `default` - Standard colors
- `light` - Light mode friendly
- `monokai` - Monokai color scheme
- `nord` - Nord color scheme
- `minimal` - Reduced visual noise

### Set Theme
```bash
/theme monokai
```

### Cycle Themes
```bash
/theme
```

---

## Persona Configuration

### Available Personas
- `calliope` - Poetic, elegant responses (default)
- `professional` - Concise, business-like
- `minimal` - Minimal output, just essentials

### Set Persona
```bash
/persona professional
```

---

## Security Considerations

### API Key Storage
- Keys in config file are stored in plain text
- Prefer environment variables for better security
- Never commit config files to version control

### Recommended `.gitignore`
```gitignore
# Calliope config
.calliope-cli/
~/.config/calliope/
```

### God Mode Warning
When running with `-g` or `godMode: true`:
- All tool executions proceed without confirmation
- Critical operations (like `rm -rf`) still require confirmation
- Use only in trusted environments
