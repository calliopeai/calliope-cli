# 🎭 Calliope CLI v0.5.0 — Complete Improvement Spec

## Current State Assessment

Your Calliope CLI is genuinely well-architected:

- **Clean multi-provider abstraction** that makes adding new AI services trivial
- **Thoughtful security model** with path validation and permission controls
- **Elegant CLI design** with beautiful output and good UX patterns
- **Autonomous loop functionality** that's genuinely innovative
- **Solid TypeScript foundation** with proper module organization

---

## 🎯 Top Improvement Recommendations

### High Impact, Medium Effort:

1. **Enhanced Error Handling & Resilience**
   - Add retry logic with exponential backoff for API failures
   - Better error messages with actionable suggestions
   - Recovery strategies for common issues (network, rate limits, etc.)

2. **Plugin Architecture**
   - Allow users to add custom tools and providers as plugins
   - Create a simple plugin discovery/installation system
   - This would make Calliope truly extensible by the community

3. **Comprehensive Testing**
   - Your codebase is complex enough to benefit greatly from tests
   - Mock AI providers for reliable testing
   - Prevent regressions as you add features

### Medium Impact, Low Effort:

4. **Streaming Support**
   - Real-time token streaming for better perceived performance
   - Progress indicators for long operations
   - Enhanced visual feedback during tool execution

5. **Configuration Overhaul**
   - Schema validation for configs
   - Environment-specific settings
   - Better API key management

### High Impact, High Effort:

6. **Workflow Engine**
   - Extend your "Ralph loops" into a full workflow system
   - Conditional branching, parallel execution
   - Save/load workflows for complex automations

---

## Storage: `~/.calliope-cli/`

```
~/.calliope-cli/
├── config.json                 # User preferences
├── sessions/
│   ├── current -> ./2024-01-15_project-name/
│   └── 2024-01-15_project-name/
│       ├── session.json
│       ├── chat-history.json
│       ├── plans/
│       │   ├── plan_001.json
│       │   └── active.json
│       └── todos.json
├── todos/
│   ├── global.json
│   └── by-project/
├── templates/plans/
├── plugins/                    # Plugin directory
└── history/commands.txt
```

---

## The Three Modes

| Mode | Prompt | Behavior |
|------|--------|----------|
| **Plan** | `calliope 📋>` | Chat only. No tools executed. Pure discussion. |
| **Hybrid** | `calliope 🔄>` | Smart default. Detects complexity, plans first, confirms. |
| **Work** | `calliope 🔧>` | Direct execution (current behavior). |

**Shift+Tab** cycles through modes instantly.

**Hybrid is always the default** for new users/sessions.

---

## Hybrid Mode: Smart Detection

Calliope auto-detects when to pause and plan:

| Trigger | Example |
|---------|---------|
| Multi-file scope | "refactor the codebase" |
| Destructive keywords | "delete", "remove", "replace all" |
| Ambiguous requests | "clean this up" |
| High estimated changes | 10+ modifications |
| System-level ops | "update dependencies" |

### Flow Example

```
calliope 🔄> Refactor all error handling to use a centralized class

✧ Calliope:
│ This looks like a significant change. Let me analyze...
│
╭─ 🔍 COMPLEXITY DETECTED
│  Scope: ~12 files, ~35 functions
│  Risk: ███░░ Medium
│  
│  I recommend planning this before execution.
╰─ 
│ [P]lan first (recommended)  [W]ork directly  [C]ancel
```

### User Chooses Plan First

```
calliope 🔄> p

✧ Calliope:
│ 
╭─ 📋 PROPOSED PLAN: Centralized Error Handling
├──────────────────────────────────────────────────
│ 
│ Phase 1: Setup (Risk: Low)
│   • Create src/errors.ts with CalliopeError class
│   • Define error codes enum
│   • Add error formatting utilities
│
│ Phase 2: Core Migration (Risk: Medium)  
│   • Update src/providers.ts - wrap API errors
│   • Update src/tools.ts - wrap tool execution errors
│   • Update src/cli.ts - centralize error display
│
│ Phase 3: Verification (Risk: Low)
│   • Run TypeScript compiler
│   • Test each provider
│   • Verify error messages display correctly
│
├──────────────────────────────────────────────────
│ Total: 3 phases, 8 files, ~45 changes
│ Risk: Medium | Reversible: Yes (git)
╰──────────────────────────────────────────────────

? Feedback on this plan?
  ❯ Looks good, execute it
    I have changes (describe them)
    Show me more detail on Phase 2
    Let's discuss alternatives first
    Cancel
```

### User Provides Feedback

```
calliope 🔄> I have changes - skip phase 3, I'll test manually

✧ Calliope:
│ Got it. Updated plan:
│ 
│ Phase 1: Setup (Risk: Low) ✓
│ Phase 2: Core Migration (Risk: Medium) ✓
│ Phase 3: Verification — SKIPPED (user will test)
│
│ Ready to execute Phases 1-2?
│ 
│ [Y]es  [N]o, more changes  [C]ancel
```

After approval → auto-switches to Work mode for execution.

---

## Risk Assessment: Always Visible

Every operation shows risk:

```
╭─ ⚡ shell                              Risk: █░░░░ Low
│  $ git status
╰─ ✓

╭─ ✍️ write_file                        Risk: ███░░ Medium  
│  path: src/utils.ts
╰─ ✓

╭─ ⚡ shell                              Risk: █████ CRITICAL
│  $ rm -rf node_modules
│  
│  ⚠️  Destructive operation detected
╰─ [Y]es  [N]o  [S]how details
```

### Risk Levels

| Level | Bar | Examples |
|-------|-----|----------|
| None | `░░░░░` | read_file, list_files, think |
| Low | `█░░░░` | git status, ls, cat |
| Medium | `███░░` | write_file, git commit |
| High | `████░` | rm, mv, git push |
| Critical | `█████` | sudo, rm -rf, system paths |

**Critical ops ALWAYS require confirmation**, even in god mode.

### Shell Command Classification

| Risk | Patterns |
|------|----------|
| Low | `ls`, `cat`, `head`, `grep`, `find`, `pwd`, `git status`, `git log`, `git diff` |
| Medium | `git add`, `git commit`, `npm install`, `mkdir`, `touch` |
| High | `rm`, `rmdir`, `mv`, `chmod`, `chown`, `git push`, `git reset`, `npm publish` |
| Critical | `sudo`, `rm -rf`, paths outside cwd, system directories |

---

## Autonomous Loops: Mini-Plans

```
calliope 🔄> /loop "Fix all TypeScript errors" --max-iterations 10

╭─ 🔄 Loop Started (Hybrid Mode)
╰──────────────────────────────────────────────────

╭─ Iteration 1/10
│  
│  Mini-plan:
│    1. Run tsc to find errors         Risk: █░░░░
│    2. Read files with errors         Risk: ░░░░░
│    3. Fix errors in src/cli.ts       Risk: ███░░
│  
╰─ [Y]es  [S]kip  [A]uto-approve remaining  [C]ancel
```

### Scope Drift Protection

```
╭─ ⚠️ HOLD: Out-of-Scope Operation
│  
│  Task: "Fix TypeScript errors"
│  Attempted: rm -rf dist/
│  
│  This doesn't match the original task.
│  Auto-approve paused.
│  
╰─ [Y]es, allow  [N]o, skip  [C]ancel loop
```

---

## TODO System

### Adding TODOs

```
calliope 🔄> /todo add Implement streaming support --priority high
✓ TODO added (#1, priority: high)

calliope 🔄> /todo add Write tests for plan mode --tag testing --tag v0.5
✓ TODO added (#2, tags: testing, v0.5)
```

### Viewing TODOs

```
calliope 🔄> /todo

╭─ 📋 TODOs for calliope-cli
├──────────────────────────────────────────────────
│ High Priority:
│   □ #1 Implement streaming support
│ 
│ Normal Priority:
│   □ #2 Write tests for plan mode [testing, v0.5]
│
│ Completed:
│   ✓ #0 Set up plan mode
╰─
```

### Working on TODOs

```
calliope 🔄> /todo work #1

✧ Calliope:
│ Loading context for: "Implement streaming support"
│ Shall I create a plan?
```

### Global TODOs

```
calliope 🔄> /todo add Research Gemini 2.0 --global
✓ Global TODO added (visible in all sessions)
```

**Plan → TODO:** Incomplete plan phases become TODOs automatically.

---

## Session & History

### Resume Sessions

```
$ calliope

╭─ 🎭 Calliope v0.5.0
│ Mode: Hybrid 🔄 (Shift+Tab to toggle)
│ 
│ 📂 Found previous session (2 hours ago)
│    • 12 messages, 3 plans, 2 TODOs
│
╰─ [R]esume  [N]ew session  [V]iew TODOs
```

### Chat History

```
calliope 🔄> /history search streaming

╭─ 🔍 Found 3 matches
│ 
│ Jan 14, 09:45:
│   You: "Should we add streaming?"
│   Calliope: "Yes, it would improve UX..."
╰─
```

### Plan History

```
calliope 🔄> /plans

╭─ 📋 Plan History
│ 
│ This Session:
│   ✓ plan_003: Add Plan Mode (12 steps)
│   ✓ plan_002: Error Handling (8 steps)
│
╰─ /plans view <id>  |  /plans rerun <id>
```

### Context Loading

```
calliope 🔄> /context load

✓ Loaded last 20 messages into context
  (Token estimate: ~2,400)
```

---

## Additional Improvements

### 7. Developer Tooling
- Hot-reloading dev server
- Debug utilities and profiling
- VSCode integration with launch configs

### 8. Documentation
- TypeDoc API generation
- Interactive guides with examples
- Troubleshooting decision trees
- Mermaid architecture diagrams

### 9. CLI UX Enhancements
- Smart autocomplete with context awareness
- Real-time status display
- Theme manager (default, monochrome, high-contrast)
- Enhanced error display with suggestions

### 10. Package & Build Improvements
- Enhanced scripts (test, lint, release)
- Bundlesize monitoring
- Security auditing with Snyk
- Dual ESM/CJS builds

### 11. Visual Diffs (like Claude Code)
When files are edited, show a visual diff:
```
╭─ ✍️ write_file
│  path: src/utils.ts
├──────────────────────────────────────
│  @@ -12,3 +12,5 @@
│  - const old = "value";
│  + const new = "better value";
│  + const added = true;
╰─ ✓
```

### 12. Thinking Display (Agent Reasoning)
Replace static "Thinking..." with live status:
```
⠋ Analyzing request...
⠙ Searching codebase for relevant files...
⠹ Found 3 files to examine
⠸ Reading src/providers.ts...
⠼ Planning approach: will refactor error handling
```

Options:
- Stream intermediate status messages
- Display `think` tool output inline
- Show tool previews before execution ("About to read src/foo.ts...")
- Streaming token output for responses

---

## New Commands Summary

| Command | Purpose |
|---------|---------|
| `/mode [plan\|hybrid\|work]` | Switch modes |
| `/todo [add\|list\|work\|done]` | Manage TODOs |
| `/history [search\|clear]` | Chat history |
| `/context [load\|summary]` | Conversation context |
| `/plans [list\|view\|rerun]` | Plan history |
| `/session [resume\|new\|info]` | Session management |

### Keybindings

| Key | Action |
|-----|--------|
| Shift+Tab | Toggle mode (Plan → Hybrid → Work) |
| Escape | Cancel current operation |
| Tab | Autocomplete |

---

## Mode Interaction Matrix

| Plan Mode | God Mode | Behavior |
|-----------|----------|----------|
| Off | Off | Current behavior (prompt per tool) |
| Off | On | Current behavior (auto-execute) |
| On | Off | Plan first, then prompt per step |
| On | On | Plan first, then auto-execute (critical still confirms) |

---

## Implementation Priority

| Phase | Features | Effort | Status |
|-------|----------|--------|--------|
| **1** | Visual diffs, thinking display, streaming | Medium | 🔲 Not started |
| **2** | Mode system, risk display, Shift+Tab | Medium | 🔲 Not started |
| **3** | ~/.calliope-cli/ storage, session persistence | Medium | 🔲 Not started |
| **4** | TODO system, plan history | Medium | 🔲 Not started |
| **5** | Chat history, context loading | Low | 🔲 Not started |
| **6** | Error handling & resilience | Medium | 🔲 Not started |
| **7** | Plugin architecture | High | 🔲 Not started |
| **8** | Workflows (extended loops) | High | 🔲 Not started |
| **9** | Testing, docs, DX tooling | Ongoing | 🔲 Not started |

---

## Changelog

| Date | Changes |
|------|---------|
| 2024-XX-XX | Initial spec created |
