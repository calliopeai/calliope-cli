# Changelog

## 3.2.0 — Unreleased (publication blocked by provider evidence)

- Include OpenRouter context tiers and cache rates in admission estimates, bind request price filters to reservations, disable optional routing expansion, and correct the capture harness's price-field names while retaining historical evidence (#318).

- Connect CLI/REPL goal planning to opt-in isolated supervision, with independent controller/reviewer models, bounded optimization controls, local-image admission before inference, exact-plan approval and unchanged recovery/accounting (#312).

- Complete seven available-provider replay/usage evidence gaps with ten real captures; retain prior failures and enforce the unchanged release gate (#310).

- Use one exact certificate identity across installer and CI attestation verification; reject incompatible GitHub CLI identity flags (#308).

- Gate exact-tag npm/binary publication, attest and verify all standalone artifacts, require installer provenance, separate development image tags, and add independent anchored run-log verification. Bundle SQLite for standalone Brain/KG search (#223).
- Preserve complete piped JSON on headless command exit, including standalone macOS binaries, and run the independent verifier through linked package paths (#223).

- Capture and replay real cancellation, provider errors, system instructions and tool-result conversations under persistent budgets; enforce the extended product release gate. Fix cancelled streams reported as success, preserve modern OpenAI token-limit fields, and accept Bedrock's null terminal discovery cursor (#305).

- Add a private project/global brain with a versioned journal, SQLite search and graph indexes, source provenance, human review/reversal, freshness checks, safe transfers and verified run ingestion; expose matching CLI/REPL commands and stable local JSON (#302).

- Add auditable recursive improvement cycles, measured outcome feedback and HUD status; provide persistent proposal holds, exact-hash execution approval and strategy withdrawal while preserving isolated evidence, original budgets and deadlines (#301).

- Compact controller reviews without dropping acceptance or authority, validate executor receipt summaries, and support explicit per-role reasoning effort gated by live native Anthropic discovery and counted-request hashes (#299).

- Add opt-in native Anthropic counted-request admission with expiring local billing evidence, exact request hashes, conservative estimate headroom and retained reservation provenance; preserve discovery exclusions, inherited caps and overrun stops (#297).

- Add opt-in continuous controller/reviewer supervision for isolated version-4 plans: review immutable worker evidence, apply bounded retry/replan and child decisions, preserve original budgets and deadlines across recovery, and show controller phase/rounds in the live HUD (#293).

- Add reviewed isolated worker plans: retain per-attempt Git worktrees, run bounded verification commands in required Docker containment, and collect actual diffs and content-bound test evidence without changing the source checkout (#290).

- Add independent planner/controller, reviewer and worker model choices to goal planning, with persisted team settings and bounded task attempts. A second controller reviews recorded draft evidence within the original allowance; retries receive failed-check feedback. Add a compact live workflow/agent HUD and display modes without changing headless event envelopes (#288).

- Add bounded goal planning with `/orchestrate` and `calliope orchestrate`: read-only proposal generation, exact-hash approval, human revision, linked execution, persistent shared limits/deadlines and versioned JSON events. Cancellation and restart retain authority and unknown spend; planning prose never counts as verified work (#284).

- Execute reviewed task graphs through bounded agents, parallelize independent tasks, serialize conflicting scopes, and verify declared artifacts against versioned acceptance checks. Add auditable agent/task events, explicit escalation, cross-process cancellation, safe restart/retry and headless execution contracts; unverified criteria require human acceptance (#282).

- Add a library boundary for inherited agent authority, scoped atomic file operations, deadlines and persistent request reservations across agent ancestors and the project. Bound SDK output/retries and retain unknown spend across restart; ordinary project-capped turns share admission (#280).

- Add strict agent/task/workspace plans, bounded hierarchy and dependency checks, artifact provenance contracts, and a private immutable run journal. CLI/REPL dry-run, preparation, review, cancellation and graph/tree inspection record inactive runs without invoking child agents (#278). Thread cancellation into policy/hook subprocesses and wait for permission cleanup before returning.

- Reset failed streaming attempts before retry, stop append-only clients after partial failures, preserve assistant tool prefaces, and show independent tool progress. Add bounded private tool-output inspection with `/tools`, resize-aware expand/collapse pages, restart/transfer support, and `calliope session outputs ... --json` (#275).

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
