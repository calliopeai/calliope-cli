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
```

**Supported Providers:**
- Anthropic (Claude): Sonnet 4, Opus 4, Haiku
- OpenAI: GPT-4o, o1, o3-mini
- Google: Gemini 2.0 Flash, 1.5 Pro
- Mistral: Large, Small
- Groq: Llama 3.3, Mixtral
- Cerebras: Llama 3.3
- Fireworks: Llama models
- xAI: Grok
- Ollama: Local models
- OpenRouter: 100+ models
- GitHub Models: Via Azure
- DeepSeek: R1, V3

### 🤖 AGTerm: Multi-Agent Orchestration

Launch multiple specialized AI agents that work together on complex tasks:

```bash
# Enable AGTerm mode
/agterm on

# Create specialized agents
"Create a backend agent to handle API development and a frontend agent for React UI"

# Agents collaborate automatically with intelligent message routing
# Human-in-the-loop queue for important decisions
```

**AGTerm Features:**
- 🤖 **Multiple specialized agents** - Each with unique personas and skills
- 🔄 **Intelligent message routing** - Agents communicate contextually
- 👤 **Human-in-the-loop** - Review and approve agent decisions
- 📊 **Status dashboard** - Monitor all agents at once with `/agterm status`
- 🎯 **Task delegation** - Agents can request help from specialists
- 🧵 **Parallel execution** - Multiple agents work simultaneously

**Commands:**
```bash
/agterm on|off         # Toggle multi-agent mode
/agterm status         # Show agent status dashboard
/agterm create         # Create a new specialized agent
```

### 🔒 Scope Management

Control which directories your AI can access for enhanced security:

```bash
/scope add ./src              # Grant access to src directory
/scope add ./tests            # Add tests directory
/scope list                   # View current scope
/scope remove ./src           # Revoke access
/scope reset                  # Clear all scope restrictions
```

**Benefits:**
- 🔒 **Security** - Prevent accidental modifications outside project areas
- 🎯 **Focus** - Keep AI operations within relevant directories
- ⚡ **Performance** - Reduce unnecessary file scanning
- 📋 **Audit trail** - Track which directories are in scope

### 🔁 Session Management & Continuity

Seamless continuity between sessions:

```bash
# On startup, Calliope detects previous sessions:
╭─ 🎭 Calliope v0.6.11
│  Found previous session (2 hours ago)
│    • 12 messages, 2 TODOs pending
╰─ [R]esume  [N]ew session

# Commands
/session list          # List all sessions
/session info          # Current session details
/history               # View conversation history
/export [file.md]      # Export conversation to markdown
```

### 🔖 Bookmarks & Navigation

Mark and return to important moments in your conversation:

```bash
/bookmark "Got auth working"    # Create a bookmark
/bookmarks                      # List all bookmarks
/goto bookmark-1                # Jump to that point in history
/bookmark delete 1              # Remove a bookmark
```

**Use cases:**
- Mark successful implementations
- Save decision points
- Quick navigation in long conversations

### 📋 Templates

Save and reuse common prompts and workflows:

```bash
/template save code-review "Review this code for bugs, performance, and best practices"
/template list                  # View all templates
/template use code-review       # Use a saved template
/template delete code-review    # Remove a template
```

**Built-in templates include:**
- Code review
- Bug investigation
- Refactoring plans
- Testing strategies

### ↩️ Undo/Redo

Navigate conversation history with full state management:

```bash
/undo                  # Undo last exchange (message + all responses)
/redo                  # Redo previously undone exchange
/history               # View full conversation timeline
```

**Features:**
- Preserves entire conversation state
- Works across tool executions
- Unlimited undo/redo stack
- Shows available undo/redo count

### 💰 Cost Tracking

Monitor API usage and costs across sessions:

```bash
# Automatic tracking in status bar:
# anthropic:claude-sonnet-4 │ 5.2K/200K │ 12.5K used │ $0.45

/cost                  # Detailed cost breakdown
```

**Tracks:**
- Current session cost
- Total cost across all sessions
- Cost per provider
- Token usage (input/output)
- Persists across sessions

### ⌨️ Advanced Input Experience

Enhanced input with modern conveniences:

- **Tab completion** - Slash commands and file paths autocomplete
- **History navigation** - Up/down arrows to browse previous inputs
- **Multi-line editing** - Shift+Enter for new lines (if supported)
- **Path suggestions** - Real-time file path completion
- **Command hints** - Footer shows available options

**Example:**
```
> /boo[TAB]           → /bookmark
> /scope add ./[TAB]  → ./src/  ./tests/  ./docs/
> [Up Arrow]          → Previous command
```

### 🚀 Parallel Tool Execution

Automatically executes independent tool calls in parallel for 2-5x speedup:

```
# When AI needs to read 3 files:
Sequential: Read file1 → wait → Read file2 → wait → Read file3
Parallel:   Read file1, file2, file3 → all at once!

# Dependency-aware:
- Detects when tools depend on each other
- Executes in optimal order
- Shows parallel execution progress
```

### ⚡ Autonomous Loops (Ralph Mode)

Enable continuous execution for complex multi-step tasks:

```bash
/ralph on              # Enable autonomous loops
/ralph off             # Disable
/ralph 10              # Set max iterations

# The AI will:
# 1. Plan the approach
# 2. Execute tools
# 3. Evaluate results
# 4. Continue until goal achieved or max iterations
```

### 🧠 Project Memory (CALLIOPE.md)

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

### 🛠️ Tools

Built-in tools for autonomous operation:

| Tool | Description |
|------|-------------|
| `shell` | Execute shell commands with safety checks |
| `read_file` | Read file contents |
| `write_file` | Write files with diff preview |
| `list_files` | Directory listing |
| `think` | Structured reasoning (visible in output) |
| `execute_code` | Run Python/Node/Bash in sandbox |
| `web_search` | Search the web for information |
| `git` | Git operations (status, diff, log, etc.) |
| `mermaid` | Generate diagrams |

### 🐳 Sandboxed Code Execution

Execute code safely in Docker containers:

```
The execute_code tool automatically:
- Uses Docker when available (recommended)
- Falls back to local execution if needed
- Shows [sandboxed] or [unsandboxed] status
- Enforces resource limits and timeouts
```

### 🌐 MCP Server Support

Connect external tools via Model Context Protocol:

```bash
/mcp add https://mcp-server.example.com
/mcp list              # Show connected servers
/mcp tools             # List available tools from all servers
/mcp refresh           # Reconnect all servers
```

### 📦 Agent Skills (AgentSkills.io)

Install reusable skills from the community registry:

```bash
/skills add git-workflow
/skills add code-review
/skills list           # Show installed skills
/skills info <name>    # Skill details
```

### 🌲 Conversation Branching

Fork conversations to explore different approaches:

```bash
/branch new experiment "Try approach B"
/branch list           # Show all branches
/branch switch experiment
/branch delete experiment
```

### 🎨 Themes & Personas

Customize the visual style and AI personality:

```bash
# Themes
/theme list            # Show available themes
/theme monokai         # Set theme
/theme                 # Cycle through themes

# Personas
/persona professional  # Professional, concise responses
/persona minimal       # Minimal output, just essentials
/persona calliope      # Poetic, elegant responses (default)
```

**Available themes:** `default`, `light`, `monokai`, `nord`, `minimal`

### 🪝 Hooks System

Run custom scripts before/after tool execution:

```bash
/hooks init            # Initialize default hooks
/hooks list            # Show configured hooks
/hooks add pre-shell "echo Running: $CALLIOPE_COMMAND"
```

**Hook events:** `pre-tool`, `post-tool`, `pre-shell`, `post-shell`, `pre-write`, `post-write`, `session-start`, `session-end`

### 📊 Context Management & Warnings

Smart context tracking with proactive warnings:

```
⚠️  Context at 85% capacity (170K/200K tokens)
   Consider: /summarize compact | /clear | shorter messages

🚨 Context at 95% capacity! (190K/200K tokens)
   Action required: /summarize compact | /clear
```

**Commands:**
```bash
/summarize context     # View conversation summary
/summarize compact     # Compress context to fit limits
/clear                 # Clear conversation
```

### 🔍 Smart Search

Find anything in your conversation or project:

```bash
/search error handling    # Fuzzy search through history
/find auth               # Find files in project
```

### ⚙️ Modes

Three distinct operating modes for different workflows:

```bash
/mode plan             # Analyze and plan, don't execute
/mode hybrid           # Plan then execute (default)
/mode work             # Execute directly without planning
```

| Mode | Icon | Behavior | Use Case |
|------|------|----------|----------|
| **Plan** | 📋 | Chat only, no execution | Design discussions, exploration |
| **Hybrid** | 🔄 | Smart planning before complex ops | Default for most users |
| **Work** | 🔧 | Direct execution | Experienced users, simple tasks |

### 🛡️ Risk Assessment & Safety

Built-in safety for potentially dangerous operations:

- Automatic risk classification (low/medium/high/critical)
- Permission prompts for risky operations
- God mode (`-g`) to bypass prompts for trusted tasks
- Detailed explanations of risks
- Scope restrictions for file access

### 🚄 Streaming & Real-time Feedback

Live response rendering for immediate feedback:

- Token-by-token streaming for text responses
- Live tool execution status with progress indicators
- Visual diffs for file changes
- Parallel tool execution visualization
- Thinking process display

## Commands Reference

### Core Commands
```bash
/help                  # Show all commands
/exit                  # Exit Calliope
/clear                 # Clear conversation
/status                # Show current status
/config                # Show configuration
```

### Model & Provider
```bash
/provider [name]       # Switch AI provider
/model [name]          # Set model (interactive if no name)
/models                # Browse available models
/persona [name]        # Switch persona (calliope/professional/minimal)
```

### Modes & Settings
```bash
/mode [plan|hybrid|work]  # Switch operating mode
/ralph [on|off|N]      # Toggle/configure autonomous mode
/confirm [on|off]      # Toggle risky operation confirmation
/theme [name]          # Switch theme
```

### AGTerm (Multi-Agent)
```bash
/agterm on|off         # Toggle multi-agent mode
/agterm status         # Show agent status dashboard
/agterm create         # Create specialized agent
```

### Scope Management
```bash
/scope add <path>      # Add directory to scope
/scope remove <path>   # Remove directory from scope
/scope list            # Show current scope
/scope reset           # Clear all scope restrictions
```

### Session & History
```bash
/session list          # List all sessions
/session info          # Current session details
/history [search]      # View/search conversation history
/bookmark [name]       # Create bookmark
/bookmarks             # List bookmarks
/goto <id>             # Jump to bookmark
/undo                  # Undo last exchange
/redo                  # Redo exchange
```

### Templates & Memory
```bash
/template save <name> <prompt>  # Save template
/template list         # View all templates
/template use <name>   # Use template
/template delete <name> # Remove template

/memory init           # Initialize project memory
/memory add <text>     # Add to memory
/memory show           # View project memory
/memory global         # View global memory
```

### Context & Search
```bash
/summarize [context|compact]  # Summarize/compress conversation
/search <query>        # Search conversation history
/find <pattern>        # Fuzzy file search in project
/branch [new|switch|list]  # Conversation branches
```

### Tools & Extensions
```bash
/mcp [list|add|remove|tools]  # MCP server management
/skills [list|add|remove|info] # Agent skills
/hooks [list|add|init] # Pre/post tool hooks
```

### Tasks & Planning
```bash
/todo [add|done|list]  # Manage TODOs
/plans [list|view]     # View plan history
```

### Utility
```bash
/cost                  # Show cost breakdown
/copy                  # Copy last response
/export [file.md]      # Export conversation to file
/upgrade               # Check for updates
```

## Environment Variables

```bash
# API Keys
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
MISTRAL_API_KEY=...
GROQ_API_KEY=...
XAI_API_KEY=...
CEREBRAS_API_KEY=...
FIREWORKS_API_KEY=...
DEEPSEEK_API_KEY=...
OPENROUTER_API_KEY=...

# Configuration
CALLIOPE_PROVIDER=anthropic
CALLIOPE_MODEL=claude-sonnet-4-20250514
CALLIOPE_GOD_MODE=false
CALLIOPE_DEBUG=false

# Ollama
OLLAMA_BASE_URL=http://localhost:11434

# LiteLLM
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=...
```

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

### Sample config.json
```json
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "apiKeys": {
    "anthropic": "sk-ant-...",
    "openai": "sk-...",
    "google": "..."
  },
  "theme": "default",
  "persona": "calliope",
  "godMode": false,
  "maxIterations": 25,
  "scope": ["./src", "./tests"]
}
```

### Profiles

Save and switch between configurations:

```bash
/profile save work     # Save current settings as "work"
/profile work          # Load "work" profile
/profile delete work   # Delete profile
/profile list          # Show all profiles
```

**Built-in profiles:** `fast`, `smart`, `cheap`, `local`

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `ESC` | Exit Calliope |
| `Ctrl+C` | Cancel current operation |
| `Ctrl+L` | Clear screen |
| `Up/Down` | Navigate input history |
| `Tab` | Autocomplete commands/paths |
| `Shift+Enter` | Multi-line input (where supported) |

## File References

Reference files directly in your messages:

```
@filename.ts           # Include file content
./path/to/file         # Relative path
/absolute/path/file    # Absolute path
```

Images are automatically detected and sent for vision-capable models.

## Security & Best Practices

### API Key Storage
- Keys stored in `~/.config/calliope/config.json`
- Prefer environment variables for better security
- Never commit config to version control

### Tool Execution Safety
- Path traversal protection
- Sandboxed code execution via Docker
- Timeout limits on all commands
- Risk assessment for dangerous operations
- Scope restrictions for file access
- Hook system for custom validation

### Best Practices
1. Use `/scope` to limit directory access
2. Review tool calls before execution (unless in god mode)
3. Set iteration limits on autonomous loops
4. Work from project directories, not system directories
5. Regular `/summarize` to manage context
6. Use bookmarks for important moments
7. Enable AGTerm for complex multi-faceted tasks

## Development

```bash
# Clone and setup
git clone https://github.com/calliopeai/calliope-cli.git
cd calliope-cli
npm install

# Build
npm run build

# Run locally
node dist/bin.js

# Run tests
npm test

# Watch mode for development
npm run dev
```

## Architecture

- **TypeScript** - Full type safety throughout
- **Ink (React)** - Declarative CLI rendering
- **Vitest** - Fast unit testing framework
- **Multi-provider** - Unified interface for 12+ LLM providers
- **Modular design** - Clean separation of concerns
- **Parallel execution** - Dependency-aware tool execution
- **Error boundaries** - Graceful crash recovery

## Troubleshooting

**"No API keys configured"**
- Run `calliope --setup` to configure keys
- Or set environment variables (see above)

**"Empty response from API"**
- Check API key validity
- Verify account credits/quota
- Try a different provider

**Context limit warnings**
- Use `/summarize compact` to compress
- Or `/clear` to start fresh
- Consider shorter messages

**"Access denied" for file operations**
- Operations restricted to cwd and home directory
- Check `/scope list` for current restrictions
- Use `/scope add <path>` to grant access

**Docker not available for sandbox**
- Install Docker for safer code execution
- Without Docker, code runs locally (less safe)

**AGTerm agents not responding**
- Check `/agterm status` for agent states
- Use `/agterm create` to add more agents
- Restart with `/agterm off` then `/agterm on`

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE)

## Support

- **Issues**: [GitHub Issues](https://github.com/calliopeai/calliope-cli/issues)
- **Discussions**: [GitHub Discussions](https://github.com/calliopeai/calliope-cli/discussions)
- **Twitter**: [@calliopelabs](https://twitter.com/calliopelabs)

## Acknowledgments

Built with love by the Calliope team. Special thanks to:
- Anthropic for Claude
- OpenAI for GPT
- Google for Gemini
- The open-source community
- All contributors and users

---

*May your code be elegant, your execution swift, and your automation poetic.* 🎭✨
