# Features

The v3 feature set. Everything below is current; if you are coming from v2, read
[Removed in v3](#removed-in-v3) for what changed.

## Agent loop with tools

Calliope runs a single agent loop: the model plans, calls tools, observes the
results, and repeats until the task is done. Built-in tools include `shell`,
file `read_file` / `write_file` / `edit_file`, `list_files`, `glob`, `grep`,
`git`, `web_search`, `execute_code` (sandboxed), `think`, `create_plan`, and
`ask_question`. Independent tool calls run in parallel.

Start a bounded autonomous run with `/loop`:

```
/loop "Fix all type errors in src/" --max-iterations 50
```

## Model backends and live discovery

Thirteen provider backends are supported, plus a generic OpenAI-compatible
endpoint. Models are discovered live from each provider's API — there are no
hardcoded model lists, so new models appear as soon as the provider ships them.
Browse the current provider's models with `/model`. See [Providers](./providers.md).

## Modes: plan, hybrid, work

Three operating modes control how much the agent does on its own:

- `plan` — chat and planning only; no tools run.
- `hybrid` — plan before complex work, then execute (default).
- `work` — execute directly.

Switch with `/mode <name>` or cycle with `Shift+Tab`.

## Sandboxing

Shell and code execution can run inside a sandbox. Set the mode with
`/config set sandboxMode <auto|native|docker|off>`:

- `auto` (default) — use Docker if available, else the native OS sandbox
  (macOS Seatbelt), else run unsandboxed.
- `native` — require the native OS sandbox; fail closed if it is unavailable.
- `docker` — run inside a Docker container.
- `off` — no sandboxing.

## Circuit breakers

Opt-in guardrails for long or autonomous runs, off by default
(`circuitBreakersEnabled: false`). When enabled, the loop halts on repeated
consecutive failures, cost runaway (per-session and per-minute spend), infinite
or oscillating tool-call patterns, excessive token burn, stalls with no
progress, and per-iteration wall-clock limits. They make `maxIterations: 0`
(unlimited) safe to run.

## Project memory (CALLIOPE.md)

At startup Calliope loads project context from `CALLIOPE.md` in the working
directory and merges in your global preferences. Create and edit it through
`/memory`:

```
/memory init
/memory add context "React 18 + TypeScript, ESM only"
/memory add preference "Use functional components"
```

## MCP servers

Connect [Model Context Protocol](https://modelcontextprotocol.io) servers to
extend the agent's toolset:

```
/mcp add https://mcp.example.com
/mcp tools
```

## Skills

Install agent skills from the registry, a GitHub URL, or a local path. Skills
are stored under `~/.calliope-cli/`.

```
/skills add git-workflow
/skills add https://github.com/org/skill
```

## Hooks (file-driven)

Run shell commands on lifecycle events — `pre-tool` / `post-tool`,
`pre-shell` / `post-shell`, `pre-write` / `post-write`, `pre-read`,
`session-start` / `session-end`, `error`, and `message`. Hooks are configured by
editing `~/.calliope-cli/hooks/hooks.json`; there is no slash command for them in
v3. A `pre-*` hook can veto the operation it precedes. For safety the file is
refused if it is group- or world-writable (`chmod 600` it).

## Checkpoints and undo (git-based)

Inside a git repository, Calliope commits a checkpoint before a destructive tool
call and records a lightweight ref under `refs/calliope/checkpoints/`. List and
restore with `/restore` — history is never rewritten. Within a session, `/undo`
reverts the last conversational change (up to 10 steps).

```
/restore                 # list checkpoints
/restore src/app.ts 1    # restore a file from checkpoint index 1
```

## Context compaction

`/compact` compresses older messages into a summary to free context; compaction
also triggers automatically as the context approaches the model's limit.
`/compact status` previews what would be summarized without changing anything.

## Cost tracking

`/cost` reports spend per session and per provider. Totals persist in
`~/.calliope-cli/costs.json`; `/cost reset` clears them.

## Headless / CI mode

Run non-interactively with `--headless` (auto-detected when stdout is not a TTY).
`--json` emits a structured event stream and `--max-retries N` retries failed
tool calls. Provide the prompt as an argument or on stdin.

```
calliope --headless "fix the failing lint rule"
echo "summarize the recent changes" | calliope --headless --json
```

## Fleet mode

Optional agent-to-agent and operator-to-agent coordination over a shared IRC
channel, off by default. See [Fleet mode](./fleet.md).

## Themes

Three built-in themes: `dark` (default), `light`, and `no-color`. Switch with
`/config set theme <name>`; the choice persists in
`~/.calliope-cli/themes/current.txt`.

---

## Removed in v3

v3.0 removed a large amount of surface area to keep the tool small and
predictable. If you relied on any of the following in v2, here is what happened
and why:

- Personas and companions — removed; the assistant has one consistent voice.
- Theme packs, skins, and palettes — removed; three plain themes remain
  (`dark`, `light`, `no-color`), and the rest was cosmetic surface with a real
  maintenance cost.
- Multi-agent orchestration (`/agents`, `/swarm`, `/council`) — removed; one
  agent and one loop is easier to reason about. Use [fleet mode](./fleet.md) for
  agent-to-agent coordination.
- The API server and `--serve` — removed; Calliope is a CLI, not a daemon.
- Terminal recording — removed; it duplicated what terminal multiplexers and
  screen recorders already do.
- Conversation branching (`/branch`) and bookmarks (`/bookmark`) — removed; use
  `/export` and git checkpoints instead.
- Prompt templates (`/template`) and TODOs (`/todo`) — removed; keep task lists
  in your project files.
- Configuration profiles — removed; switch provider and model directly, or use
  environment variables.
- Background jobs (`/bg`) and tmux integration — removed; run separate shells.
- The legacy readline UI (`--legacy`) — removed; the Ink UI is the only front end.
- The `/scuttlebot` integration — renamed to [fleet mode](./fleet.md).

The slash-command surface dropped from 84 commands to 22, and configuration from
40 keys to 16. The guiding principle was simplicity: fewer moving parts, each one
documented and tested.
