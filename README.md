# Calliope CLI

**The private-AI agent CLI.** One terminal agent for any model backend — including the ones you run yourself. MIT-licensed, small core, no lock-in.

```bash
npm install -g @calliopelabs/cli
calliope
```

Single-binary installs are available through Homebrew and a `curl` installer,
with no Node.js required — see
[Install as a single binary](docs/getting-started.md#install-as-a-single-binary).

## Why Calliope

- **Any backend, live-discovered.** Hosted providers, local runtimes, and OpenAI-compatible servers share the same workflow. Models and capabilities are discovered from provider APIs; unsupported or unknown behavior stays explicit. See the [provider matrix and real-wire evidence](docs/provider-conformance.md).
- **Built for models you run yourself.** Ollama and self-hosted OpenAI-compatible servers are first-class targets, not checkboxes. Run fully air-gapped.
- **Sandbox-first execution.** Shell and code tools run inside macOS Seatbelt or Docker sandboxes (`auto`/`native`/`docker`/`off`). Blocklists are advisory; the sandbox is the boundary.
- **Safety rails that survive long sessions.** Circuit breakers, iteration budgets, git-based checkpoints with `/restore`, and automatic context compaction.
- **Governance built in.** Tamper-evident audit run logs (on by default), a `replay` command to inspect and verify them, budget caps that halt a run before it overspends, and a pre-tool policy hook for an external allow/deny engine. See [docs/governance.md](docs/governance.md).
- **Typed judgments.** `calliope judge` evaluates a state against noul/choice/score questions and returns probabilities and confidence your code can branch on, from any backend (including local Ollama) or the native TypeSafe engine. See [docs/judgments.md](docs/judgments.md).
- **Focused command surface.** 23 commands, plus optional fleet mode. The [command reference](docs/commands.md) documents the available workflows and subcommands.
- **Tested like infrastructure.** 3,500 tests, 93%+ line coverage with an enforced 90% floor.

## What's new in 3.2

3.2 turns the provider foundation into a project workbench: live provider health and
model discovery, `/doctor` diagnostics, health-aware routing, resumable sessions,
stream-safe retries, and the `auto` permission mode are available from the same
terminal and headless interfaces. It also adds reviewed orchestration with planner,
worker and verifier roles, isolated execution, bounded retry/replan supervision,
auditable artifacts, and a local Brain/KG for provenance-aware project memory.

The release includes native Bedrock reasoning preservation, Google's `@google/genai`
adapter, expanded DeepSeek/Cerebras and OpenAI-compatible coverage, and real-wire
provider evidence. See the [3.2.0 release notes](docs/releases/3.2.0.md) for the
complete feature and validation details.

## Quick start

```bash
calliope --setup        # pick a provider, paste a key (or point at Ollama)
calliope                # start a session in the current directory
```

Inside a session:

```
/mode plan              think first — the agent proposes, you approve
/mode auto              execute without per-tool approval prompts this session
/model list             see live-discovered models for your provider
/defaults save          save the current provider/model for this project
/scope add ../lib       widen file access deliberately
/compact                compress context when it grows
/restore                list git checkpoints; /restore <path> to roll back
/help                   everything else — it fits on one screen
```

Headless, for CI and scripts:

```bash
calliope --headless --json "run the tests and summarize failures"
```

Plan a project goal within a fixed budget, then approve the returned proposal hash:

```bash
calliope orchestrate "Inspect the parser and propose a focused fix" --cost 1 --json
calliope orchestrate approve GOAL_ID PROPOSAL_HASH --allow-mutations --json
```

Planning exits 5 for review; the [goal workflow](docs/goal-planning.md) documents
scope limits, approval, recovery and the JSON contract. `/orchestrate` presents
the proposed plan and approval dialog in the REPL.

Add [`--supervise --isolation-image sha256:ID`](docs/continuous-supervision.md#start-from-a-goal)
to propose an isolated work → verify → review → retry/replan loop. Choose separate
controller, worker and optional execution-reviewer models; the existing HUD shows
roles, task attempts and bounded supervision rounds. Planning remains read-only
and execution requires approval of the exact plan.

Execute a reviewed project task graph with bounded agents:

```bash
calliope run plan.json --dry-run --json
calliope run plan.json --allow-mutations --json
```

Independent tasks run concurrently with per-agent permissions and shared budgets.
Recorded artifact checks determine completion; unverified criteria require human
acceptance. See [coordinator execution](docs/coordinator-execution.md) for plan
contracts, provider requirements, cancellation and recovery.

Record and query project knowledge locally, without model requests:

```bash
calliope brain init --allow-mutations
calliope brain ingest docs/design.md --allow-mutations
calliope brain search "storage decision" --json
calliope kg graph
```

The [project brain](docs/project-brain.md) preserves source provenance, supports
human review and reversal, tracks stale documents, and links verified run evidence.
Use `/brain` and `/kg` for the same controls in the REPL.


## Configuration

One file, 16 keys. Credentials live in a per-provider map with environment-variable fallbacks:

```jsonc
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "ollama":    { "baseUrl": "http://localhost:11434" }
  },
  "sandboxMode": "auto",
  "routing": { "enabled": false, "costSensitivity": 0.3 }
}
```

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`, and friends work as before. v2 configs migrate automatically on first run.

Docs: [getting started](docs/getting-started.md) · [commands](docs/commands.md) · [configuration](docs/configuration.md) · [model preferences](docs/model-preferences.md) · [providers](docs/providers.md) · [features](docs/features.md) · [fleet mode](docs/fleet.md)

## Editors

Run Calliope as an [Agent Client Protocol](https://agentclientprotocol.com) agent (`calliope acp`) inside Zed, JetBrains, Neovim, and other ACP editors — client-side file edits, per-tool permissions, and the same audit trail. See [docs/acp.md](docs/acp.md).

## Fleet mode

Coordinate a fleet of agents and human operators over a self-hosted IRC channel that doubles as an audit trail. Off by default, zero cost when disabled. See [docs/fleet.md](docs/fleet.md).

## Project memory

Use `AGENTS.md` for portable repository instructions and `CALLIOPE.md` for project memory. Trusted instructions load from the checkout root to your working directory, with source paths and directory precedence. `/memory sources` shows applicable files; `/memory reload` refreshes them. See [repository instructions](docs/instructions.md).

## v3.0

v3 is a deliberate reduction: 84 commands, 40 config keys, and ~20k lines of speculative features (theme packs, companions, multi-agent orchestration, an embedded API server, and more) were removed to make the core fast, predictable, and maintainable. The full list and rationale live in [CHANGELOG.md](CHANGELOG.md) and the [v3.0 roadmap](https://github.com/calliopeai/calliope-cli/issues/195).

Single-binary installs, enforced performance budgets, governance, ACP editor integration, and local-model edit repair shipped in v3.0. See [docs/governance.md](docs/governance.md) and [docs/local-models.md](docs/local-models.md).

The [next-version roadmap](https://github.com/calliopeai/calliope-cli/issues/254) prioritizes consistent execution across providers, portable sessions and instructions, and measured task reliability. The [first implementation](https://github.com/calliopeai/calliope-cli/issues/255) adds cancellation through provider requests, retries and local processes, plus scoped `AGENTS.md` support. See [cancellation behavior](docs/features.md#cancellation).

## Contributing

Issues and PRs welcome — [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is TypeScript ESM with React/Ink; `npm test` must stay green and coverage must stay above 90%.

## License

MIT © Calliope Labs Inc
