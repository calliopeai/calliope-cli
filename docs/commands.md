# Commands Reference

Complete reference for all Calliope CLI commands.

## Core Commands

### `/help`, `/h`
Display all available commands with descriptions.

```bash
/help
/h
```

### `/exit`, `/quit`, `/q`
Exit Calliope CLI.

```bash
/exit
/quit
/q
```

### `/clear`, `/c`
Clear the conversation history and start fresh.

```bash
/clear
/c
```

### `/status`, `/s`
Show current status including provider, model, mode, and context usage.

```bash
/status
/s
```

### `/config`
Display current configuration settings.

```bash
/config
```

### `/debug [on|off]`
Toggle debug mode for verbose output.

```bash
/debug on    # Enable debug mode
/debug off   # Disable debug mode
/debug       # Toggle debug mode
```

---

## Provider & Model Commands

### `/provider`, `/p [name]`
Switch AI provider. Without arguments, shows interactive selector.

```bash
/provider              # Interactive provider selection
/provider anthropic    # Switch to Anthropic (Claude)
/provider google       # Switch to Google (Gemini)
/provider openai       # Switch to OpenAI (GPT)
/provider ollama       # Switch to local Ollama
/p anthropic           # Shorthand
```

**Supported Providers:**
- `anthropic` - Claude models
- `openai` - GPT models
- `google` - Gemini models
- `mistral` - Mistral models
- `groq` - Groq-hosted models
- `cerebras` - Cerebras-hosted models
- `fireworks` - Fireworks AI
- `xai` - xAI (Grok)
- `ollama` - Local models via Ollama
- `openrouter` - OpenRouter (100+ models)
- `github` - GitHub Models
- `deepseek` - DeepSeek models
- `litellm` - LiteLLM proxy

### `/model`, `/m [name]`
Switch model. Without arguments, shows interactive selector.

```bash
/model                          # Interactive model selection
/model claude-sonnet-4          # Switch to Claude Sonnet 4
/model gpt-4o                   # Switch to GPT-4o
/m gemini-2.0-flash             # Shorthand
```

### `/models`
Browse available models for the current provider.

```bash
/models
```

### `/persona [name]`
Switch AI persona/personality.

```bash
/persona                # Show available personas
/persona calliope       # Poetic, elegant (default)
/persona professional   # Concise, business-like
/persona minimal        # Minimal output
```

---

## Mode Commands

### `/mode [plan|hybrid|work]`
Switch operating mode.

```bash
/mode plan     # Chat only, no tool execution
/mode hybrid   # Smart planning before complex operations (default)
/mode work     # Direct execution without planning
```

| Mode | Icon | Behavior |
|------|------|----------|
| Plan | 📋 | Discussion only, no tools |
| Hybrid | 🔄 | Auto-detects when to plan |
| Work | 🔧 | Execute directly |

### `/work`
Shortcut to switch to work mode.

```bash
/work
```

### `/plan`
Shortcut to switch to plan mode.

```bash
/plan
```

---

## Autonomous Loop Commands

### `/loop "<prompt>" [options]`
Start an autonomous execution loop.

```bash
/loop "Fix all TypeScript errors"
/loop "Refactor the auth module" --max-iterations 10
/loop "Add tests" --completion-promise "All tests pass"
```

**Options:**
- `--max-iterations N` - Maximum loop iterations (default: 25)
- `--completion-promise "text"` - Stop when this condition is met

### `/cancel-loop`, `/stop`
Cancel the current autonomous loop.

```bash
/cancel-loop
/stop
```

### `/set <key> <value>`
Set runtime configuration.

```bash
/set maxIterations 50    # Set max loop iterations
```

---

## Session & History Commands

### `/session [list|info]`
Manage sessions.

```bash
/session         # Show current session info
/session info    # Same as above
/session list    # List recent sessions
```

### `/history [query]`
Search conversation history.

```bash
/history              # Show recent history
/history auth         # Search for "auth" in history
```

### `/resume`
Resume the previous session.

```bash
/resume
```

### `/undo`
Undo the last exchange (your message + AI response).

```bash
/undo
```

### `/redo`
Redo a previously undone exchange.

```bash
/redo
```

### `/copy`
Copy the last AI response to clipboard.

```bash
/copy
```

### `/export [filename]`
Export conversation to markdown file.

```bash
/export                    # Export to conversation.md
/export my-session.md      # Export to specific file
```

---

## Bookmark Commands

### `/bookmark`, `/bm [name|list|delete]`
Manage conversation bookmarks.

```bash
/bookmark "Got auth working"    # Create bookmark
/bookmark list                  # List all bookmarks
/bookmark delete 1              # Delete bookmark #1
/bm "checkpoint"                # Shorthand
```

### `/goto <bookmark-id>`
Jump to a bookmarked point in conversation.

```bash
/goto 1
/goto bookmark-1
```

---

## Template Commands

### `/template`, `/t [save|list|use|delete]`
Manage prompt templates. Templates persist across sessions.

```bash
/template list                              # List templates
/template save review "Review this code"    # Save template
/template use review                        # Load template into input
/template delete review                     # Delete template
/t list                                     # Shorthand
```

---

## TODO Commands

### `/todo [add|done|work|clear|list]`
Manage TODOs.

```bash
/todo                                    # List TODOs
/todo list                               # Same as above
/todo add Fix the login bug              # Add TODO
/todo add Deploy to prod --priority high # Add high priority
/todo add Research caching --global      # Add global TODO
/todo done abc1                          # Mark TODO done
/todo work abc1                          # Set as active TODO
/todo clear                              # Clear active TODO
```

**Options for add:**
- `--priority high` - Set high priority
- `--global` - Make globally visible across projects

---

## Plan Commands

### `/plans [list|view|rerun]`
Manage execution plans.

```bash
/plans              # List recent plans
/plans list         # Same as above
/plans view abc1    # View plan details
/plans rerun abc1   # Re-execute a plan
```

---

## Scope & Directory Commands

### `/scope`, `/dirs [add|remove|list|reset]`
Manage directory access scope.

```bash
/scope              # Show current scope
/scope list         # Same as above
/scope add ./src    # Grant access to src/
/scope remove ./src # Revoke access
/scope reset        # Clear all restrictions
/dirs               # Alias for /scope
```

### `/add-dir <path>`
Add directory to scope.

```bash
/add-dir ./tests
```

### `/remove-dir <path>`
Remove directory from scope.

```bash
/remove-dir ./tests
```

---

## Context & Memory Commands

### `/context`
Show loaded project context (from CALLIOPE.md, etc.).

```bash
/context
```

### `/memory [init|show|add|global]`
Manage project memory.

```bash
/memory init                              # Create CALLIOPE.md
/memory show                              # Show project memory
/memory add context "TypeScript project"  # Add context
/memory add preference "Use ESM"          # Add preference
/memory global                            # Show global memory
```

**Memory types:** `context`, `preference`, `history`, `note`

### `/summarize [context|compact]`
Summarize or compress context.

```bash
/summarize context    # View conversation summary
/summarize compact    # Compress to save tokens
```

---

## Search Commands

### `/find <pattern>`
Fuzzy search for files in project.

```bash
/find auth
/find *.test.ts
```

### `/search <query>`
Search conversation history.

```bash
/search error handling
```

---

## Branch Commands

### `/branch [new|list|switch|delete]`
Manage conversation branches.

```bash
/branch list                    # List branches
/branch new experiment "Try B"  # Create branch
/branch switch experiment       # Switch to branch
/branch delete experiment       # Delete branch
```

---

## Theme Commands

### `/theme [name]`
Switch visual theme.

```bash
/theme              # Cycle through themes
/theme list         # List available themes
/theme monokai      # Switch to monokai
```

**Available themes:** `default`, `light`, `monokai`, `nord`, `minimal`

---

## Profile Commands

### `/profile [save|load|list|delete]`
Manage configuration profiles.

```bash
/profile list           # List profiles
/profile save work      # Save current config as "work"
/profile work           # Load "work" profile
/profile load work      # Same as above
/profile delete work    # Delete profile
```

**Built-in profiles:**
- `fast` - Groq for speed
- `smart` - Claude for quality
- `cheap` - Gemini for cost
- `local` - Ollama for privacy

---

## MCP Server Commands

### `/mcp [list|add|remove|refresh|tools]`
Manage Model Context Protocol servers.

```bash
/mcp list                           # List connected servers
/mcp add https://server.example.com # Add server
/mcp remove server-name             # Remove server
/mcp refresh                        # Reconnect all servers
/mcp tools                          # List tools from servers
```

---

## Skills Commands

### `/skills [list|add|remove|info]`
Manage agent skills from AgentSkills.io.

```bash
/skills list              # List installed skills
/skills add git-workflow  # Install skill
/skills remove git-flow   # Remove skill
/skills info git-workflow # Show skill details
```

---

## Hook Commands

### `/hooks [list|add|init]`
Manage pre/post execution hooks.

```bash
/hooks list                                    # List hooks
/hooks init                                    # Initialize defaults
/hooks add pre-shell "echo Running: $CMD"     # Add hook
```

**Hook events:**
- `pre-tool`, `post-tool`
- `pre-shell`, `post-shell`
- `pre-write`, `post-write`
- `session-start`, `session-end`

---

## Cost Commands

### `/cost`, `/costs`
Show API usage costs.

```bash
/cost           # Show cost breakdown
/costs          # Same as above
```

---

## Route Commands

### `/route`, `/autoroute [on|off|test]`
Auto-route requests to optimal model.

```bash
/route on           # Enable auto-routing
/route off          # Disable auto-routing
/route test "msg"   # Test routing for message
/autoroute on       # Alias
```

---

## Queue Commands

### `/queue`, `/q [list|clear|edit]`
Manage human-in-the-loop queue.

```bash
/queue              # Show pending items
/queue list         # Same as above
/queue clear        # Clear queue
/queue edit 1       # Edit queue item
```

### `/flush`
Process all pending queue items.

```bash
/flush
```

---

## Utility Commands

### `/upgrade`
Check for CLI updates.

```bash
/upgrade
```

### `/setup`
Run the setup wizard.

```bash
/setup
```

### `/keys`
Show configured API keys (masked).

```bash
/keys
```

### `/project`
Show project information.

```bash
/project
```

### `/agents`
Show active agents.

```bash
/agents
```

### `/unstick`
Reset if the CLI gets stuck.

```bash
/unstick
```

### `/confirm [on|off]`
Toggle confirmation prompts for risky operations.

```bash
/confirm on     # Require confirmations
/confirm off    # Skip confirmations (careful!)
```

---

## Command Aliases

| Command | Aliases |
|---------|---------|
| `/help` | `/h` |
| `/provider` | `/p` |
| `/model` | `/m` |
| `/clear` | `/c` |
| `/status` | `/s` |
| `/exit` | `/quit`, `/q` |
| `/template` | `/t` |
| `/bookmark` | `/bm` |
| `/scope` | `/dirs` |
| `/route` | `/autoroute` |
| `/cost` | `/costs` |
| `/cancel-loop` | `/stop` |
