# Changelog

## 3.2.0 — Unreleased (publication blocked by provider evidence)

- Wire terminal approvals with complete path/command previews and once/session/project/deny choices; bind reusable file grants to exact operations, recheck policy before execution, and add local `/permissions` inspection/revocation with versioned headless JSON. ACP session approvals now honor exact option IDs and bounded scope (#274).

- Add bounded immutable conversation history, manual and automatic safety branches, checkout/diff/replay, private import/export, and a versioned `calliope session ... --json` contract. Session switches restore the visible transcript; transfers preserve provider metadata and current tool state without replaying tools or importing policy grants (#272).

- Add private, versioned recovery snapshots across terminal, headless and ACP turns; pin session tools and saves to their runtime, reject stale writers, and add `/new` and `/sessions` with validated resume (#270).

- Add 33 reviewed live captures, including Fable 5/5.1 and Astra via OpenRouter and native Bedrock, bringing the corpus to 56/72 combinations; add persistent per-run probe caps beneath the cumulative budget and record bounded model-smoke results, provider failures and the xAI deferral (#262).
- Prepare the 3.2.0 package and release notes; the version bump does not publish or tag a release (#262).
- Require real-wire coverage for DeepSeek, xAI and Cerebras, and remove retired AI21 from the active release matrix. `providers:readiness` reports credential presence, historical evidence and missing product checks separately (#262).
- Bound live captures with a persistent dollar ledger, conservative input/output reservations and a single-request cancellation signal. Failed probes retain their reservation; concurrent writers fail closed (#262).
- Strict Anthropic and Google model discovery now exposes API failures and bypasses cached emergency fallbacks, so diagnostics cannot mistake fallback data for live evidence (#262).

- Share one turn runtime across terminal, headless and ACP: isolated scopes, paired tool results, cancellation cleanup, local repair, and budgeted compression/repair calls. Headless incomplete turns now exit 4; terminal checkpoints follow the session project.


### Added

- Shared routing from live model metadata, with explicit preference preservation, capability checks, health/cost/latency scoring, protocol-history pins, and versioned routing events across terminal, headless and ACP (#266).

- Local provider health records, `/doctor` and `calliope doctor --json`, cancellable discovery probes, diagnostic import/export, and repeated-failure quarantine with explicit-provider recovery (#264). See `docs/provider-health.md` for schemas and metric limits.
- Live REPL provider/model controls with health and discovered cost/capacity, session-only switches, `/once` overrides, `/defaults` project preferences, and invocation flags shared with headless/ACP preference resolution (#268). Queued messages retain separate choices and pause on failure or cancellation. See `docs/model-preferences.md`.

- Offline conformance contracts using real SDK parsers across all provider adapters, plus reviewed-wire capture/replay tooling and a required prepublish evidence gate (#222).
- 36 live provider captures across nine adapter paths, with recorded provenance, gateway versions and a spend audit; remaining provider gaps still block publication (#222).

- A canonical permission resolver across terminal, headless and ACP, with
  source-labelled decisions and tool-call IDs in the audit log (#221).

- Shared cancellation signals across all provider adapters, retry waits, terminal
  turns, ACP prompts and headless execution. Headless cancellation emits a
  `cancelled` completion event and exits 130, including while waiting for stdin.
- Trusted, directory-scoped `AGENTS.md` loading with source provenance,
  precedence, checkout boundaries and explicit size errors. `/memory sources`
  and `/memory reload` expose and refresh repository context.

### Fixed

- Preserve audit hash integrity when optional event fields are omitted by JSON serialization. Use discovered prices for turn accounting and adapt built-in prompts after routing without dropping project instructions (#266).

- Use Hugging Face's current router endpoint for discovery and inference; preserve provider quota errors in live capture tooling instead of masking them with rejected SDK retries (#222).

- Preserve all Anthropic/Gemini system instructions and Gemini tool-result associations. Retain streaming usage and incomplete/failed finish reasons. Buffer fragmented Ollama NDJSON and reject corrupted or incomplete streams.

- Headless now honors pre-tool hooks. The executor rechecks filesystem and
  sandbox boundaries after approval; dangling symlinks fail scope validation.

- Terminal direct-send waits for cancellation cleanup before replacing a turn;
  cancelled requests cannot dispatch later tools or retries. ACP cancellation
  interrupts pending permission waits and prevents late approvals from executing.
- POSIX shell/code cancellation terminates the process group, with escalation.
  Docker execution attempts named-container cleanup on cancellation and timeout.
- Explicit Docker shell/code mode fails closed instead of executing on the host
  when Docker is unavailable. Trust changes refresh the active system prompt.
- README now identifies binary installs and local-model repair as shipped, and
  links the next-version roadmap (#254).

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
