# Calliope CLI

**The private-AI agent CLI.** One terminal agent for any model backend — including the ones you run yourself. MIT-licensed, small core, no lock-in.

```bash
npm install -g @calliopelabs/cli
calliope
```

Single-binary installs (Homebrew and a `curl` installer, no Node.js required) are
coming with the v3.0.0 stable release — see
[Install as a single binary](docs/getting-started.md#install-as-a-single-binary).

## Why Calliope

- **Any backend, live-discovered.** 13 providers — Anthropic, OpenAI, Google, AWS Bedrock, Ollama, OpenRouter, Together, Groq, Fireworks, Mistral, AI21, Hugging Face, LiteLLM, plus any OpenAI-compatible server. No hardcoded model lists: models and capabilities are discovered from each provider's API, so new models work the day they ship.
- **Built for models you run yourself.** Ollama and self-hosted OpenAI-compatible servers are first-class targets, not checkboxes. Run fully air-gapped.
- **Sandbox-first execution.** Shell and code tools run inside macOS Seatbelt or Docker sandboxes (`auto`/`native`/`docker`/`off`). Blocklists are advisory; the sandbox is the boundary.
- **Safety rails that survive long sessions.** Circuit breakers, iteration budgets, git-based checkpoints with `/restore`, and automatic context compaction.
- **Governance built in.** Tamper-evident audit run logs (on by default), a `replay` command to inspect and verify them, budget caps that halt a run before it overspends, and a pre-tool policy hook for an external allow/deny engine. See [docs/governance.md](docs/governance.md).
- **Small on purpose.** 22 commands. 16 config keys. 11 flags. v3 removed more code than it kept — the changelog lists everything that went and why.
- **Tested like infrastructure.** 3,500 tests, 93%+ line coverage with an enforced 90% floor.

## Quick start

```bash
calliope --setup        # pick a provider, paste a key (or point at Ollama)
calliope                # start a session in the current directory
```

Inside a session:

```
/mode plan              think first — the agent proposes, you approve
/model list             see live-discovered models for your provider
/scope add ../lib       widen file access deliberately
/compact                compress context when it grows
/restore                list git checkpoints; /restore <path> to roll back
/help                   everything else — it fits on one screen
```

Headless, for CI and scripts:

```bash
calliope --headless --json "run the tests and summarize failures"
```

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

Docs: [getting started](docs/getting-started.md) · [commands](docs/commands.md) · [configuration](docs/configuration.md) · [providers](docs/providers.md) · [features](docs/features.md) · [fleet mode](docs/fleet.md)

## Editors

Run Calliope as an [Agent Client Protocol](https://agentclientprotocol.com) agent (`calliope acp`) inside Zed, JetBrains, Neovim, and other ACP editors — client-side file edits, per-tool permissions, and the same audit trail. See [docs/acp.md](docs/acp.md).

## Fleet mode

Coordinate a fleet of agents and human operators over a self-hosted IRC channel that doubles as an audit trail. Off by default, zero cost when disabled. See [docs/fleet.md](docs/fleet.md).

## Project memory

Drop a `CALLIOPE.md` in your repo and every session starts knowing your conventions. `/memory` manages it.

## v3.0

v3 is a deliberate reduction: 84 commands, 40 config keys, and ~20k lines of speculative features (theme packs, companions, multi-agent orchestration, an embedded API server, and more) were removed to make the core fast, predictable, and maintainable. The full list and rationale live in [CHANGELOG.md](CHANGELOG.md) and the [v3.0 roadmap](https://github.com/calliopeai/calliope-cli/issues/195).

Coming in v3.0 stable: single-binary installs (brew/curl, no Node required) and enforced performance budgets. Governance primitives — replayable audit run logs, budget caps, and a policy hook — have landed; see [docs/governance.md](docs/governance.md). Coming after: local-model edit-reliability hardening.

## Contributing

Issues and PRs welcome — [CONTRIBUTING.md](CONTRIBUTING.md). The codebase is TypeScript ESM with React/Ink; `npm test` must stay green and coverage must stay above 90%.

## License

MIT © Calliope Labs Inc
