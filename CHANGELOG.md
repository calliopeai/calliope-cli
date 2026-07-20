# Changelog

## 3.1.0 — 2026-07-20

Restores a green build after the grouped dependency sweep in #240, which
landed six major bumps at once (openai 4 to 6, typescript 5 to 7, ink 6 to 7,
inquirer 7 to 8, conf 13 to 15, @types/node 22 to 26) and broke compilation
on `main`.

### Added

- **Fireworks AI in the setup wizard** — Fireworks was already a supported
  provider throughout the config, router, model detection, and compat layers,
  but it was missing from the setup menu and from environment detection, so
  `FIREWORKS_API_KEY` could not be selected during setup. Both are now wired.

### Fixed

- **OpenAI SDK 6 tool-call parsing** — `ChatCompletionMessageToolCall` became
  a union of function and custom tool calls, so `parseOpenAIToolCalls` no
  longer compiled. Tool calls are now narrowed on the `type` discriminator;
  custom tool calls, which the CLI never sends, are skipped.
- **Provider typing in the setup wizard** — the detected-provider list was
  typed as `string[]` where the prompt expects `LLMProvider`, masking the
  missing Fireworks entry above.
- **Dependabot no longer groups major updates** — majors now arrive as
  individual pull requests so each can be reviewed against its own changelog,
  rather than riding in with the weekly minor and patch sweep.

## 3.0.0 — 2026-07-09

v3 is a deliberate reduction. The goal: a fast, predictable, maintainable
agent CLI with a small core and no lock-in — the best harness for models you
run yourself. Roughly 70% of the v2 surface was removed; everything that
stayed is tested (93%+ line coverage, 90% floor enforced).

### Added

- **Single-binary distribution** — cross-compiled binaries for macOS
  (arm64/x64) and Linux (x64/arm64), built on every release with checksums;
  `packaging/install.sh` and a Homebrew formula. Cold start: 75ms median.
- **Performance budgets in CI** — every PR gates on cold start, keystroke
  latency (p95 2.5ms measured vs 16ms budget), and long-session memory
  flatness (`npm run bench`).
- **Local-model excellence** — schema simplification, a one-round
  repair loop with grammar-constrained retries, hash-anchored edits,
  a compact prompt profile, and capability probing for Ollama and
  OpenAI-compatible servers. Verified live against gemma4:31b.
- **Governance** — tamper-evident audit run logs (hash-chained JSONL, on by
  default, secrets redacted), `calliope replay` with chain verification
  (exit 4 on tampering), `calliope cost` spend/tool reporting, per-run and
  per-project budget caps (headless exit 3), and a fail-closed pre-tool
  policy hook for external engines.
- **ACP agent mode** — `calliope acp` speaks the Agent Client Protocol over
  stdio for Zed/JetBrains/Neovim, with editor-buffer file access.
- **Evidence-based agent behavior** — plan mode requires reading before
  proposing (unverified plans are marked in the transcript), and the
  plan-to-work transition binds terse approvals to execution.
- **Config that survives** — `/model` and `/provider` selections persist;
  credentials migrate automatically from v2; a global
  `~/.config/calliope/cli.env` joins the env-file load order.

### Removed

- **Theme packs and the cosmetic layer** — ~180 pop-culture themes
  (`@calliopelabs/cli-themes`, now archived), HUD skins, palettes, companions,
  moods, and personas. Three built-in appearances remain: `dark`, `light`,
  `no-color` (`/config set theme <name>`). One professional system prompt.
- **Multi-agent orchestration** — `/agents`, `/swarm`, `/council`,
  agent-config presets, and the `--agents` mode (preserved on branch
  `agents-orchestration-archive`; a redesigned successor will ride on fleet
  mode).
- **Niche subsystems** — embedded API server (`--serve`), terminal
  recordings, conversation branching, bookmarks, prompt templates, todos,
  profiles, background jobs, tmux integration, idle eviction, session
  timeout, and the legacy readline UI (`--legacy`).
- **Command surface** — 106 → 22 slash commands (+ flag-gated `/fleet`).
  Aliases and near-duplicates folded into subcommands: `/model list`,
  `/config set`, `/scope add|remove`, `/loop stop`, `/trust remove`.
- **Config surface** — 56 → 16 keys. Twenty flat credential keys became one
  `providers.<name>.{apiKey,baseUrl,model,region,profile}` map; smart-routing
  keys became `routing.{enabled,costSensitivity}`. v2 configs migrate
  automatically; environment-variable fallbacks are unchanged.
- **Flags** — `--batch`/`--pipe` (use `--headless`), `--configure` (use
  `--setup`), `--agents`/`--agterm`, `--serve`/`--api`, `--legacy`,
  and the never-implemented `--skip-setup`.

### Changed

- **Checkpoints unified on git.** File-snapshot checkpoints (silently broken
  under ESM since the module migration) are gone; `/restore` lists and
  restores from git-based checkpoint refs (`refs/calliope/checkpoints`).
  History is never rewritten. Non-git directories report cleanly.
- **Routers merged.** `smart-router` + `model-router` → one `router` module;
  behavior unchanged, configured via `routing.*`.
- **Sandboxes unified.** Docker and macOS Seatbelt backends behind one
  interface, routed by `sandboxMode`.
- **`/compact` compacts.** Compression is the default action; `/compact
  status` shows the summary (was inverted in v2's `/summarize`).
- **Plan approval.** `/approve` folded into the mode flow: switch to work
  mode (Shift+Tab) and reply to execute an approved plan.
- **Scuttlebot → fleet mode.** The IRC relay lives behind `fleet.enabled`
  (default off, zero cost when disabled) as `/fleet`, positioned as the
  fleet-coordination bus and audit trail. See `docs/fleet.md`.

### Fixed

- Full-coverage tests for the fleet relay internals (IRC state machine,
  SASL, reconnect), previously untested.
- Dead code removed throughout: unused file watcher, orphaned `/sandbox`
  command, unreferenced config keys, an 8-way layout switch whose branches
  rendered identically.

### Notes

The removals were shipped and validated across a three-day live-testing
cycle that itself produced six of the fixes above — including two cases
where the audit log caught an agent claiming work it had not done.

---

Earlier releases (2.x and before) were published without a changelog; see
the git history.
