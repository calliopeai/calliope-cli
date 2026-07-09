# bootstrap.md — Calliope CLI

> **The canonical conventions document for this codebase.** An agent given this
> file and a requirement should produce correct, idiomatic code without
> exploring first. When any other doc conflicts with this file, **this file
> wins**. Keep it updated as the codebase evolves.

`@calliopelabs/cli` (`calliope`) — a multi-model AI agent CLI. TypeScript +
React/Ink, ESM. v3.0.0. Node ≥ 20.

---

## Stack

| Concern | Choice |
|---|---|
| Language | TypeScript, **ESM** (`"type": "module"`, `module: NodeNext`, `strict: true`) |
| UI | React 19 + Ink 6 (terminal UI) |
| Entry | `src/bin.ts` → `dist/bin.js` (the `calliope` bin) |
| Config store | `conf` (schema-validated JSON under the OS config dir) |
| Providers | `@anthropic-ai/sdk`, `@google/generative-ai`, `openai` (+ OpenAI-compatible endpoints) |
| Tests | Vitest — **~3,500 tests across 94 files** under `tests/`; coverage floor 90% lines (enforced by `npm run test:coverage`) |
| Lint/format | Prettier + ESLint (community defaults; no custom bikeshedding) |

**Local commands**
- Type-check: `npx tsc --noEmit` — must be clean before any commit.
- Tests: `npx vitest run` (watch: `npx vitest --watch`). Must be green before any commit.
- Build: `npm run build` (`tsc && chmod +x dist/bin.js`).
- Run from source: `npm start` (after build) or `node dist/bin.js`.

---

## Hard rules

1. **ESM import paths use the `.js` extension** — even when importing a `.ts`
   file (`import { x } from './foo.js'`). TS resolves it; Node needs it at runtime.
2. **`npx tsc --noEmit` and `npx vitest run` must both pass** before a commit.
3. **No co-authorship / AI-attribution lines** in commits, PRs, or issues, ever.
4. **No hardcoded model lists.** Model IDs, context windows, max-output, and
   capabilities are pulled live from each provider's models API (see *Model
   discovery* below). The only permitted hardcoded model string is a clearly
   labelled emergency fallback.
5. **Surgical changes.** Touch only what the task needs. Don't refactor adjacent
   code, reformat, or add speculative abstractions. Match the surrounding style.

---

## Architecture

Large modules were split into subdirectories **without changing any import
Modules live in subdirectories; import via each package's index.

```
src/
├── bin.ts            # entry point
├── providers/        # 13 backends (anthropic, google, openai, bedrock, ollama, compat)
├── hud/              # color api, 3 palettes, single skin
├── ui/               # Ink components, chat-input, status-bar, messages, modals, agent loop
├── tools.ts          # tool definitions, registry, execution (shell/file/web/etc.)
├── config.ts         # conf store, schema, pre-migration
├── types.ts          # core types, DEFAULT_MODELS, pricing
├── model-detection.ts / model-router.ts / smart-router.ts   # model discovery + routing
├── sandbox.ts / sandbox-native.ts / risk.ts / trust.ts / scope.ts  # security boundary
├── storage.ts / memory.ts / checkpoint.ts / branching.ts    # persistence + session state
├── auto-compressor.ts / summarization.ts                    # context management
├── fleet.ts          # flag-gated IRC fleet bus (sole importer of scuttlebot/)
├── agents/           # dynamic/custom tool definitions
└── sandbox/          # docker + seatbelt backends behind one interface
```

**Adding to a module:** add the new code in the subdirectory and export it from that directory's index.

**Circular-dependency workarounds (keep these patterns):**
- `setStartLoop()` injection in `src/cli/commands.ts` breaks a cycle with the agent loop.
- `require()` (not `import`) is used for lazy loading in `styles.ts` and the
  `emoji()` helper in `styles.ts` to avoid import cycles.

---

## Model discovery (no hardcoded models)

The CLI is multi-provider (Anthropic / Google / OpenAI / OpenAI-compatible:
ollama, bedrock, litellm, mistral, openrouter, together, groq, …).

- **Discover, don't hardcode.** Pull the available models and their capabilities
  from each provider's models API at runtime — Anthropic `GET /v1/models`
  (`max_input_tokens`, `max_tokens`, capability tree), the OpenAI/OpenRouter/
  Together equivalents. `model-detection.ts` holds the live-fetch paths.
- **Capabilities drive limits.** Context window and max-output come from the
  models API per model — never a global constant. `calculateMaxTokens` and the
  summarization/compaction thresholds must read the discovered values.
- **Tier + pricing** (fast/balanced/smart, $/MTok) are not in the models API.
  Resolve them from capabilities + a small, documented fallback table; treat that
  table as the single place a stale value could live, and keep it minimal.
- **Route hosted OpenAI-compatible providers through the OpenAI-compatible
  client**, not the Ollama handler. Reserve the Ollama path for `ollama`.

---

## Security boundary

The CLI runs LLM-chosen shell commands and file ops, so the trust boundary is
load-bearing. The real containment is the **sandbox**, not string matching.

- **Sandbox first.** `sandbox.ts` (Docker: `--network none`, `--cap-drop ALL`,
  `no-new-privileges`, read-only mounts, argv via `execFileSync`) is the strong
  path. `sandbox-native.ts` (macOS Seatbelt) is a weaker mitigation — restrict
  reads to scope and disable network by default.
- **Blocklists are advisory, not a boundary.** `risk.ts` classification and the
  `tools.ts` command blocklist help the UX but cannot be relied on for safety
  (shell parsing is unwinnable). Default unknown/destructive commands to
  *requires confirmation*.
- **Validate at boundaries.** Resolve real paths (`fs.realpathSync`) before
  scope checks; reject `..`, validate names from remote sources (skills,
  plugins, MCP) against `..`/`/`. Never spawn or `import()` remote-sourced code
  without an explicit trust step.
- **Never log or echo secrets** (API keys, tokens) — including in error messages.

---

## Persistence

- **Atomic writes.** Write to `${file}.tmp` then `fs.renameSync` — a crash or a
  second concurrent CLI instance must never truncate `messages.json`,
  `config.json`, or branch/checkpoint state. Readers swallow parse errors and
  fall back to defaults, so a partial write silently destroys data.
- **Bound growth.** Append-only logs (`chat.log`) need rotation/retention.
- **Session dirs are named `{date}_{project}`**, not by session ID — resolve the
  directory via the id→dir lookup before any delete/read.

---

## Testing

- Vitest. Tests live in `tests/*.test.ts` (one area per file; mirror the source
  module name where practical).
- **Every fix gets a regression test; every feature gets a test** covering the
  happy path *and* the error/permission-denied path.
- Don't mock away the thing under test (e.g. the config store, the message
  validator). Assert on real returned/written state.
- Coverage does not decrease on a PR.

---

## Issue & PR workflow

- Plans live on **GitHub issues**, not local markdown. Comment a plan on the
  issue before writing code; reference the issue number in commits
  (`fix: dynamic model discovery #N`); close the loop with a summary.
- Branch per issue: `fix/N-short-desc` or `feat/N-short-desc` off `main`.
- One PR per issue. Green CI + review before merge. No rebases — new commits only.
