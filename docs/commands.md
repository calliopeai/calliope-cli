# Commands

Calliope exposes slash commands, plus `/fleet` when fleet mode is enabled.
Type `/help` in a session to print the same list. Commands are entered at the
prompt; arguments in `[brackets]` are optional.

## Session

### `/help`
Show the command list.
```
/help
```

### `/status`
Show the active provider, model, token usage, terminal capabilities, and fleet status.
```
/status
```

### `/doctor [providers|provider <name>]`
Report credentials, endpoint, discovery evidence, observed capabilities, recent
latency/errors, and quarantine. Defaults to local observations; `--probe` permits
bounded live model discovery. `--json` returns the versioned diagnostic document.
Use `/doctor provider <name> --reset` after fixing a quarantined endpoint.
The same arguments work with `calliope doctor` in headless environments.
See [Provider health](./provider-health.md) for export/import and recovery.

### `/clear`
Clear the conversation and reset context to the system prompt.
```
/clear
```

### `/exit`
Exit Calliope. `/quit` is an alias.
```
/exit
```

## Model and mode

### `/model [name|list]`
Switch model, or open the picker of live-discovered models. `/model` and
`/model list` fetch the current provider's models; `/model <name>` validates live
eligibility before switching for this session. The picker shows discovered
capacity and estimated cost, with missing values marked unknown.
```
/model
/model claude-sonnet-4-6
```

### `/provider [name|list]`
Switch provider, or list providers with local health. `/provider` opens the picker;
`/provider <name>` validates discovery before switching for this session. `auto`
is supported. An incompatible choice leaves the prior selection intact.
```
/provider
/provider anthropic
/provider list
```

### `/defaults [save|reset]`
Inspect the project selection and the defaults for a new session. `save` persists
the current selection to the project; `reset` clears project overrides. Loading
requires project trust, and writes obey policy. Global defaults are unchanged.

### `/once [--provider <name>] [--model <id>] -- <prompt>`
Override one turn, including its retries and tool continuations. Queued messages
retain separate choices; these overrides never become saved defaults. See
[Model preferences](model-preferences.md) for precedence, bounds and recovery.

### `/mode [plan|hybrid|work]`
Switch operating mode. With no argument, prints the current mode. Press
`Shift+Tab` to cycle.
```
/mode plan
/mode work
```
- `plan` — chat and planning only, no tools run
- `hybrid` — plan before complex work, then execute (default)
- `work` — execute directly

## Conversation

### `/tools [list|last|output-id]`
List bounded retained tool output or open a selected record. E/Enter collapses
or expands; N/P changes page; Esc closes. Output survives restart when saved.
`calliope session outputs <session-id> [output-id] --json` provides local headless
inspection. See [streaming and output storage](streaming.md) for limits.

### `/undo`
Revert the last change. Up to 10 steps are retained.
```
/undo
```

### `/export [file.md]`
Export the conversation to a markdown file. Defaults to `calliope-export-<timestamp>.md`.
```
/export
/export review.md
```

### `/resume [sessionId]`
Resume a saved session, restoring its full message history. With no ID, resumes
the current session.
```
/resume
/resume 2026-07-04_myproject
```

### `/compact [status]`
Compress conversation context to free tokens. `/compact status` prints a summary
of topics, decisions, and changes without compacting.
```
/compact
/compact status
```

## Workspace

### `/scope [add <dir>|remove <dir>|details|reset]`
Manage the directories the agent may access. With no argument, prints the current scope.
```
/scope
/scope add ./packages/api
/scope remove ./tmp
/scope reset
```

### `/memory [init|show|sources|reload|add <type> <text>|remove <type> <text>|global]`
Manage project memory in `CALLIOPE.md`. `sources` lists applicable trusted `AGENTS.md` files; `reload` refreshes project context for subsequent turns. See [repository instructions](./instructions.md). Types: `context`, `preference`, `history`, `note`.
```
/memory init
/memory add context "React 18 + TypeScript, ESM only"
/memory show
```

### `/trust [status|add [path]|remove [path]|list|clear [path]]`
Manage the project trust registry. With no argument, prints trust status for the
current directory.
```
/trust
/trust add
/trust remove
/trust list
```

### `/restore [<path> [index]]`
List git-based checkpoints, or restore a file from one. Checkpoints are created
automatically before destructive tool calls and require a git repository.
```
/restore
/restore src/app.ts
/restore src/app.ts 1
```

## Extend

### `/mcp [list|add <url>|remove <id>|refresh|tools]`
Manage Model Context Protocol servers and inspect the tools they expose.
```
/mcp add https://mcp.example.com
/mcp list
/mcp tools
```

### `/skills [list|add <source>|remove <name>|info <name>]`
Manage agent skills. A source is a registry name, a GitHub URL, or a local path.
```
/skills add git-workflow
/skills add https://github.com/org/skill
/skills list
```

## System

### `/config [set <key> <value>]`
Show configuration, or change a setting at runtime. Settable keys: `maxIterations`,
`sessionLogLimit`, `collapseTools`, `toolDisplayLimit`, `diffStyle`, `sandboxMode`,
`routing.enabled`, `routing.costSensitivity`, `theme`.
```
/config
/config set diffStyle side-by-side
/config set theme light
```
See [Configuration](./configuration.md) for the full key reference.

### `/setup`
Print the command to reconfigure Calliope (`calliope --setup`).
```
/setup
```

### `/cost [reset]`
Show the cost-tracking summary. `/cost reset` clears the totals.
```
/cost
/cost reset
```

### `/loop ["<prompt>" [--max-iterations N] [--completion-promise "text"] | stop]`
Start an autonomous agent loop, or stop a running one. The loop runs until it
satisfies the completion promise, reaches the iteration limit, or is stopped.
```
/loop "Fix all type errors in src/" --max-iterations 50
/loop "Add tests" --completion-promise "all tests pass"
/loop stop
```

### `/debug [on|off]`
Toggle debug logging, or print internal session state. Logs go to stderr / the
debug log, never the TUI.
```
/debug
/debug on
/debug off
```

## Fleet

### `/fleet [enable|disable|<message>]`
Coordinate multiple agents over a shared IRC channel. Appears in completions only
when fleet mode is enabled; with no argument, prints status. See [Fleet mode](./fleet.md).
```
/fleet enable
/fleet "starting the migration"
/fleet disable
```

## Input reference

- `@filename`, `./path`, `/absolute/path` — reference files inline in a message.
- `Tab` completes commands and paths. `Shift+Tab` cycles the mode. `Up`/`Down`
  navigate input history. `Ctrl+C` cancels the current operation.

Session recovery: `/new` starts a separate session, `/sessions` lists saved
sessions, and `/resume [id]` validates and restores a conversation for the
current project. See [session recovery](session-recovery.md) for interrupted
tools, concurrent writers and recovery procedures.

## Orchestration preparation

`/run <plan> --dry-run` validates a project plan without writes or inference.
`/run prepare <plan>` records an inactive run; `/run list`, `/run status [id]`,
`/run approve <id>`, `/run cancel <id>` and `/run replay <id>` inspect its journal
and record review decisions. `/agents tree [id]` shows the declared hierarchy;
`/tasks graph [id]` shows dependencies and scope conflicts. Child execution is
not yet available. See [contracts and commands](orchestration.md) for limits,
policy behavior, schemas and recovery.
