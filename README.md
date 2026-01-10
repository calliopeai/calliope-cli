# Calliope CLI

> The Muse of Digital Eloquence

Multi-model AI agent CLI with autonomous loops, project memory, and advanced tooling. Use Claude, Gemini, GPT, and more from a single elegant interface.

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

## Features

### Multi-Model Support

Switch between 12+ providers on the fly:

```
/provider anthropic    # Use Claude
/provider google       # Use Gemini
/provider openai       # Use GPT
/provider mistral      # Use Mistral
/provider ollama       # Use local models
/provider openrouter   # Use any model via OpenRouter
/provider litellm      # Use LiteLLM proxy
```

### Auto Model Routing

Automatically select the best model based on task complexity:

```
/route on              # Enable auto-routing
/route test "explain quantum computing"  # Test routing decision
```

Model tiers:
- **Fast**: Haiku/GPT-4o Mini/Flash - quick, simple tasks
- **Balanced**: Sonnet/GPT-4o/Pro - moderate complexity
- **Smart**: Opus/o1/Pro - complex reasoning tasks

### Project Memory (CALLIOPE.md)

Persistent memory across sessions using markdown files:

```
/memory init           # Create CALLIOPE.md
/memory add context "This is a TypeScript project"
/memory add preference "Use functional components"
/memory show           # View project memory
/memory global         # View global preferences
```

Calliope automatically loads context from standard files:
- `CALLIOPE.md` - Project memory
- `CLAUDE.md` - Claude context
- `README.md`, `SPEC.md`, `TODO.md`
- `ARCHITECTURE.md`, `DESIGN.md`, `NOTES.md`
- `.cursorrules`, `.github/copilot-instructions.md`

### Tools

Built-in tools for autonomous operation:

| Tool | Description |
|------|-------------|
| `shell` | Execute shell commands |
| `read_file` | Read file contents |
| `write_file` | Write files with diff preview |
| `list_files` | Directory listing |
| `think` | Structured reasoning |
| `execute_code` | Run Python/Node/Bash in sandbox |
| `web_search` | Search the web |
| `git` | Git operations |
| `mermaid` | Generate diagrams |

### Sandboxed Code Execution

Execute code safely in Docker containers:

```
The execute_code tool automatically:
- Uses Docker when available (recommended)
- Falls back to local execution
- Shows [sandboxed] or [unsandboxed] status
- Enforces resource limits and timeouts
```

### MCP Server Support

Connect external tools via Model Context Protocol:

```
/mcp add https://mcp-server.example.com
/mcp list              # Show connected servers
/mcp tools             # List available tools
/mcp refresh           # Reconnect all servers
```

### Agent Skills (AgentSkills.io)

Install reusable skills from the registry:

```
/skills add git-workflow
/skills add code-review
/skills list
/skills info <name>
```

### Conversation Branching

Fork conversations to explore different approaches:

```
/branch new experiment "Try approach B"
/branch list
/branch switch experiment
/branch delete experiment
```

### Themes

Customize the color scheme:

```
/theme list            # Show available themes
/theme monokai         # Set theme
```

Available themes: `default`, `light`, `monokai`, `nord`, `minimal`

### Hooks System

Run custom scripts before/after tool execution:

```
/hooks init            # Initialize default hooks
/hooks list            # Show configured hooks
/hooks add pre-shell "echo Running: $CALLIOPE_COMMAND"
```

Hook events: `pre-tool`, `post-tool`, `pre-shell`, `post-shell`, `pre-write`, `post-write`, `session-start`, `session-end`

### Context Summarization

Manage long conversations:

```
/summarize context     # View conversation summary
/summarize compact     # Compress context to fit limits
```

### Project Configuration (.calliope)

Human-readable project config:

```
/project init          # Create .calliope file
/project show          # View config
/project run build     # Run defined command
```

Format:
```
project: My Project
provider: anthropic
model: claude-sonnet-4-20250514

[tech]
typescript
react
postgres

[conventions]
Use functional components
Prefer async/await

[commands]
build: npm run build
test: npm test
```

## Commands Reference

### Core
| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/exit` | Exit Calliope |
| `/clear` | Clear conversation |
| `/status` | Show current status |
| `/config` | Show configuration |

### Model & Provider
| Command | Description |
|---------|-------------|
| `/provider [name]` | Switch AI provider |
| `/model [name]` | Set model (interactive if no name) |
| `/models` | Browse available models |
| `/route [on\|off\|test]` | Auto model routing |
| `/persona [name]` | Switch persona |

### Modes
| Command | Description |
|---------|-------------|
| `/mode [plan\|hybrid\|work]` | Switch operating mode |
| `/confirm [on\|off]` | Toggle risky op confirmation |

Modes:
- **Plan**: Analyze and plan, don't execute
- **Hybrid**: Plan then execute (default)
- **Work**: Execute without planning

### Session & History
| Command | Description |
|---------|-------------|
| `/session [list\|info]` | Session management |
| `/history [search]` | Chat history |
| `/context [load\|summary]` | Context management |
| `/summarize [context\|compact]` | Summarize conversation |

### Memory & Config
| Command | Description |
|---------|-------------|
| `/memory [init\|add\|show\|global]` | Project memory |
| `/project [init\|show\|run]` | Project config |
| `/profile [name\|save\|del]` | Switch/save profiles |

### Search & Navigation
| Command | Description |
|---------|-------------|
| `/find <pattern>` | Fuzzy file search |
| `/search <query>` | Search conversation |
| `/branch [new\|switch\|list]` | Conversation branches |

### Tools & Extensions
| Command | Description |
|---------|-------------|
| `/mcp [list\|add\|remove\|tools]` | MCP servers |
| `/skills [list\|add\|remove\|info]` | Agent skills |
| `/hooks [list\|add\|init]` | Pre/post tool hooks |

### Tasks & Planning
| Command | Description |
|---------|-------------|
| `/todo [add\|done\|list]` | Manage TODOs |
| `/plans [list\|view]` | View plan history |

### Interface
| Command | Description |
|---------|-------------|
| `/theme [name\|list]` | Color themes |
| `/copy` | Copy last response |
| `/export [file.md]` | Export conversation |
| `/edit` | Edit last message |
| `/undo` | Remove last exchange |
| `/upgrade` | Check for updates |

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

### Profiles

Save and switch between configurations:

```
/profile save work     # Save current settings
/profile work          # Load profile
/profile delete work   # Delete profile
/profile list          # Show all profiles
```

Built-in profiles: `fast`, `smart`, `cheap`, `local`

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `ESC` | Exit |
| `Shift+Tab` | Cycle modes |
| `Ctrl+C` | Cancel operation |
| `Ctrl+L` | Clear screen |
| `Up/Down` | Navigate history |
| `Tab` | Tab completion |

## File References

Reference files directly in your messages:

```
@filename.ts           # Include file content
./path/to/file         # Relative path
/absolute/path/file    # Absolute path
```

Images are automatically detected and sent for vision models.

## Security

### API Key Storage
- Keys stored in `~/.config/calliope/config.json`
- Prefer environment variables for better security
- Never commit config to version control

### Tool Execution
- Path traversal protection
- Sandboxed code execution via Docker
- Timeout limits on all commands
- Hook system for custom validation

### Best Practices
1. Review tool calls before execution
2. Use god mode (`-g`) only for trusted tasks
3. Set iteration limits on loops
4. Work from project directories, not system directories

## Troubleshooting

**"No API keys configured"**
- Run `calliope --setup` or set environment variable

**"Empty response from API"**
- Check API key validity and credits
- Try a different provider

**"Access denied" for file operations**
- Operations restricted to cwd and home directory

**Docker not available for sandbox**
- Install Docker for safer code execution
- Without Docker, code runs locally (unsandboxed)

## License

MIT
