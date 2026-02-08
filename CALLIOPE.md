# Calliope CLI - Project Memory

## Overview

Calliope CLI is a multi-model AI agent command-line interface that provides autonomous loops, project memory, and advanced tooling. The project enables users to interact with various LLM providers (Claude, Gemini, GPT, and more) from a single elegant interface.

**Current Version:** 0.8.14  
**Organization:** Calliope Labs Inc  
**Repository:** https://github.com/calliopeai/calliope-cli  

## Core Architecture

### Multi-Provider Support
- **Primary Providers:** Anthropic (Claude), Google (Gemini), OpenAI (GPT)
- **Additional Providers:** Together, OpenRouter, Groq, Fireworks, Mistral, Ollama, AI21, Hugging Face, LiteLLM
- **Auto-routing:** Intelligent model selection based on complexity tiers (fast/balanced/smart)

### Key Components

#### CLI Interface (`src/cli.ts`)
- Interactive REPL with readline interface
- Rich command system with 30+ slash commands
- Real-time spinner animations and colored output
- Session management with cost tracking
- Autonomous agent loop system (`/loop`)

#### Tool System (`src/tools.ts`)
- Core tools: shell execution, file operations, thinking framework
- Parallel tool execution support
- Pre/post tool hooks for customization
- Risk assessment and confirmation prompts

#### Memory System (`src/memory.ts`)
- Project-specific memory (CALLIOPE.md files)
- Global memory persistence
- Context building with automatic injection
- History tracking and preferences

#### Configuration (`src/config.ts`)
- Persistent configuration using `conf` library
- Provider credentials management
- User preferences and defaults
- Theme and persona settings

#### Features & Modules
- **Branching:** Conversation branch management
- **Streaming:** Real-time response handling
- **Fuzzy Search:** File discovery and matching
- **Themes:** Customizable color schemes
- **Hooks:** Pre/post execution customization
- **Scope:** File access security boundaries
- **Summarization:** Context compression and key extraction
- **Version Check:** Auto-update capabilities

## Development Context

### Technology Stack
- **Runtime:** Node.js 18+ (TypeScript)
- **UI Framework:** Ink (React for CLI)
- **Testing:** Vitest with coverage
- **Build:** TypeScript compiler
- **Dependencies:** Minimal, focused set (Anthropic SDK, Google AI, OpenAI, etc.)

### Project Structure
```
src/
├── cli.ts              # Main CLI interface and REPL
├── bin.ts              # Entry point binary
├── providers.ts        # LLM provider abstraction
├── tools.ts           # Core tool system
├── config.ts          # Configuration management
├── memory.ts          # Project and global memory
├── types.ts           # TypeScript definitions
├── agterm/            # Agent terminal subsystem
│   ├── orchestrator.ts
│   ├── agent-detection.ts
│   └── ...
└── [various modules]  # Specialized functionality
```

### Persona System
Three distinct interaction modes:
- **Calliope:** Poetic, creative AI with warmth and flair
- **Professional:** Business-focused, direct communication
- **Minimal:** Concise, technical responses

### Mode System
- **Plan Mode:** Strategic thinking and planning
- **Hybrid Mode:** Balanced approach (default)
- **Work Mode:** Execution-focused with minimal confirmations

## Recent Development

### Version 0.8.14 (Current)
- **Pre-request summarization** - Summarizes BEFORE sending if context >= 80%
- Async debug logging to fix input lag
- Collapsed consecutive blank lines in responses

### Version 0.8.13
- **Auto-summarization** - Automatically summarizes context at 85% capacity
- More conservative token estimation (2.5 chars/token, 35% overhead)
- 8% context buffer (was 5%) to prevent overflow errors

### Version 0.8.12
- **Enhanced inline diffs** - Claude Code-style diffs with line numbers
- Context-aware diff display (normal: 3 lines, compact: 1 line)
- Summary line showing "Added N lines", "Modified N lines", etc.

### Version 0.8.11
- Self-spawning sub-agents (`calliope --agterm`)
- Display density setting (`/density compact`)
- Reduced whitespace in tool output
- Input lag fixes (lazy useState initializers)
- Conservative token estimation (5% buffer)
- `!msg` prefix for direct send

### Key Capabilities
1. **Autonomous Loops:** Self-directed task execution with completion promises
2. **Multi-Modal Routing:** Automatic model selection based on task complexity
3. **Project Memory:** Persistent context across sessions
4. **Tool Orchestration:** Sophisticated command execution with safety checks
5. **Real-time Streaming:** Live response display with progress indicators

## Technical Preferences

### Code Style
- Modern TypeScript with strict typing
- Functional programming patterns where appropriate
- Clean separation of concerns
- Comprehensive error handling
- Rich CLI user experience with colors and animations

### Architecture Principles
- Provider abstraction for multi-LLM support
- Plugin-based extensibility (hooks, themes)
- Security-first approach (scope management, confirmations)
- Performance optimization (streaming, parallel execution)
- User experience focus (autocomplete, help system)

## Installation & Usage

### Quick Installation
```bash
# Via curl
curl -fsSL https://calliope.ai/install.sh | bash

# Via npm
npm install -g @calliopelabs/cli
```

### Key Commands
- `/help` - Complete command reference
- `/provider <name>` - Switch AI providers
- `/loop "<prompt>"` - Start autonomous execution
- `/memory init` - Initialize project memory
- `/scope` - Manage file access boundaries

## Project Goals

1. **Unified AI Interface:** Single CLI for multiple LLM providers
2. **Developer Productivity:** Advanced tooling for code and project management
3. **Intelligent Automation:** Autonomous task execution with safety
4. **Extensibility:** Plugin system for community contributions
5. **User Experience:** Intuitive, beautiful command-line interface

## History

- **2026-01-15:** Project memory system established
- **2024-Present:** Active development with regular releases
- **Core Features:** Multi-provider support, autonomous loops, project memory
- **Latest:** v0.7.23 with enhanced session management and upgrade system

---

*"The Muse of Digital Eloquence" - Bridging human creativity with artificial intelligence*