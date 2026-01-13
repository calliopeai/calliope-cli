# Features

Deep-dive into Calliope CLI's capabilities.

## Autonomous Loops

Execute multi-step tasks automatically with human oversight.

### Basic Usage
```bash
/loop "Fix all TypeScript errors"
```

### With Options
```bash
/loop "Refactor to use async/await" --max-iterations 15
/loop "Add tests until coverage > 80%" --completion-promise "Coverage: 80%"
```

### How It Works
1. AI analyzes the task
2. Plans the approach
3. Executes steps iteratively
4. Stops when complete or max iterations reached

### Controlling Loops
```bash
/stop          # Cancel current loop
/cancel-loop   # Same as /stop
```

### Configuration
```bash
/set maxIterations 50    # Increase limit
```

---

## Multi-Model Support

Switch between 13+ providers seamlessly.

### Quick Switch
```bash
/provider anthropic
/provider openai
/provider google
/provider groq
```

### Interactive Selection
```bash
/provider      # Shows provider picker
/model         # Shows model picker
/models        # Browse available models
```

### Auto-Routing
Let Calliope pick the best model for each task:
```bash
/route on
```

- Simple queries → Fast models (Haiku, Flash)
- Complex tasks → Capable models (Sonnet, GPT-4o)
- Coding → Code-optimized models

---

## Project Memory

Persistent context across sessions.

### Automatic Loading
Calliope reads from:
- `CALLIOPE.md` - Primary project memory
- `CLAUDE.md` - Claude-specific context
- `README.md`, `SPEC.md`, `TODO.md`
- `ARCHITECTURE.md`, `DESIGN.md`
- `.cursorrules`, `.github/copilot-instructions.md`

### Create Memory File
```bash
/memory init
```

Creates `CALLIOPE.md` with sections for:
- Project overview
- Tech stack
- Coding preferences
- Important files

### Add Memory
```bash
/memory add context "React 18 with TypeScript"
/memory add preference "Use functional components"
/memory add note "Auth module was refactored on Jan 10"
```

### View Memory
```bash
/memory show      # Project memory
/memory global    # Global preferences
/context          # All loaded context
```

---

## Templates

Save and reuse prompts.

### Save Template
```bash
/template save review "Review this code for bugs, performance, and best practices"
/template save test "Write comprehensive unit tests for this function"
/template save refactor "Refactor this code to improve readability and maintainability"
```

### Use Template
```bash
/template use review
# Loads prompt into input, press Enter to send
```

### List Templates
```bash
/template list
```

Templates persist across sessions in `~/.calliope-cli/templates/`.

---

## TODOs

Track tasks within your session.

### Add TODOs
```bash
/todo add Fix the login bug
/todo add Deploy to production --priority high
/todo add Research caching options --global
```

### View TODOs
```bash
/todo              # List all
/todo list         # Same
```

### Work on TODO
```bash
/todo work abc1    # Set as active, AI knows context
```

### Complete TODO
```bash
/todo done abc1
```

### Clear Active
```bash
/todo clear
```

---

## Plans

Save and rerun execution plans.

### View Plans
```bash
/plans              # List recent plans
/plans view abc1    # See plan details
```

### Rerun Plan
```bash
/plans rerun abc1   # Re-execute a saved plan
```

Plans are created automatically in Hybrid mode when executing complex tasks.

---

## Bookmarks

Mark important points in conversation.

### Create Bookmark
```bash
/bookmark "Got authentication working"
/bm "checkpoint"
```

### List Bookmarks
```bash
/bookmark list
```

### Jump to Bookmark
```bash
/goto 1
```

### Delete Bookmark
```bash
/bookmark delete 1
```

---

## Undo/Redo

Navigate conversation history.

### Undo
```bash
/undo    # Removes last exchange (your message + AI response)
```

### Redo
```bash
/redo    # Restores undone exchange
```

Full state is preserved, including tool executions.

---

## Session Management

### View Current Session
```bash
/session info
```

### List Sessions
```bash
/session list
```

### Resume Session
On startup, Calliope offers to resume recent sessions. Or manually:
```bash
/resume
```

### Export Session
```bash
/export                  # To conversation.md
/export my-session.md    # To specific file
```

---

## Conversation Branches

Explore different approaches without losing work.

### Create Branch
```bash
/branch new experiment "Try approach B"
```

### Switch Branch
```bash
/branch switch experiment
```

### List Branches
```bash
/branch list
```

### Delete Branch
```bash
/branch delete experiment
```

---

## Scope Management

Control which directories the AI can access.

### Add to Scope
```bash
/scope add ./src
/scope add ./tests
```

### Remove from Scope
```bash
/scope remove ./node_modules
```

### View Scope
```bash
/scope list
```

### Reset Scope
```bash
/scope reset    # Clears all restrictions
```

When scope is set, AI can only access listed directories.

---

## Context Management

### View Usage
Status bar shows: `45K/200K` (used/limit)

### Progressive Warnings
- 70%: Info notice
- 85%: Warning
- 95%: Critical
- 98%: Emergency

### Compress Context
```bash
/summarize compact
```

### Clear Context
```bash
/clear
```

---

## Cost Tracking

Monitor API usage and costs.

### View Costs
```bash
/cost
```

Shows:
- Total cost
- Today's cost
- Cost by provider
- Last 7 days

Costs persist across sessions in `~/.calliope-cli/costs.json`.

---

## MCP Servers

Connect external tools via Model Context Protocol.

### Add Server
```bash
/mcp add https://mcp-server.example.com
```

### List Servers
```bash
/mcp list
```

### View Available Tools
```bash
/mcp tools
```

### Refresh Connections
```bash
/mcp refresh
```

---

## Skills

Install community skills from AgentSkills.io.

### Install Skill
```bash
/skills add git-workflow
/skills add code-review
```

### List Installed
```bash
/skills list
```

### Skill Info
```bash
/skills info git-workflow
```

### Remove Skill
```bash
/skills remove git-workflow
```

---

## Hooks

Run custom scripts before/after operations.

### Initialize Defaults
```bash
/hooks init
```

### Add Hook
```bash
/hooks add pre-shell "echo Running: $CALLIOPE_COMMAND"
/hooks add post-write "prettier --write $CALLIOPE_FILE"
```

### List Hooks
```bash
/hooks list
```

### Hook Events
- `pre-tool`, `post-tool` - Any tool execution
- `pre-shell`, `post-shell` - Shell commands
- `pre-write`, `post-write` - File writes
- `session-start`, `session-end` - Session lifecycle

---

## Themes

Customize visual appearance.

### Available Themes
- `default` - Standard colors
- `light` - Light backgrounds
- `monokai` - Monokai scheme
- `nord` - Nord scheme
- `minimal` - Reduced noise

### Set Theme
```bash
/theme monokai
```

### Cycle Themes
```bash
/theme
```

---

## Profiles

Quick-switch configurations.

### Built-in Profiles
```bash
/profile fast    # Groq - speed
/profile smart   # Claude - quality
/profile cheap   # Gemini - cost
/profile local   # Ollama - privacy
```

### Save Custom Profile
```bash
/profile save work
```

### Load Profile
```bash
/profile work
```

---

## Search

### Find Files
```bash
/find auth           # Fuzzy search
/find *.test.ts      # Pattern search
```

### Search History
```bash
/search error handling
```

### Search Chat
```bash
/history auth
```

---

## Copy & Export

### Copy Last Response
```bash
/copy
```

Copies to clipboard (supports macOS, Windows, Linux).

### Export Conversation
```bash
/export                  # To conversation.md
/export session.md       # To specific file
```

---

## Parallel Tool Execution

When the AI needs to run multiple independent operations, they execute in parallel for 2-5x speedup.

```
Sequential: Read file1 → wait → Read file2 → wait → Read file3
Parallel:   Read file1, file2, file3 → all at once
```

This happens automatically when:
- Multiple tool calls have no dependencies
- Operations can safely run concurrently

---

## Risk Assessment

Every operation is classified:

| Level | Examples |
|-------|----------|
| None | Read file, list files |
| Low | Git status, ls |
| Medium | Write file, git commit |
| High | Delete file, git push |
| Critical | rm -rf, sudo, system paths |

Critical operations always require confirmation, even in god mode.
