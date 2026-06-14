# CLAUDE.md - Calliope CLI

> **Read [`bootstrap.md`](./bootstrap.md) before writing code** — it is the
> canonical conventions document. This file is the Claude-specific shim plus
> issue-tracking notes.

## Project

Multi-model AI agent CLI (`@calliopelabs/cli` v2.4.2). TypeScript + React/Ink, ESM modules. Node ≥ 20.

## Development Rules

- No co-authorship messages in commits
- Import paths must use `.js` extension (ESM)
- All changes must pass `npx tsc --noEmit` and `npx vitest run`
- Barrel pattern: original files re-export from subdirectories (zero import path changes)
- Circular dep workaround: `setStartLoop()` injection pattern, `require()` for lazy loading
- No hardcoded model lists — discover models + capabilities from each provider's models API (see `bootstrap.md`)

## Architecture

```
src/
├── bin.ts              # Entry point
├── cli.ts              # Barrel → src/cli/
├── providers.ts        # Barrel → src/providers/
├── hud.ts              # Barrel → src/hud/
├── ui-cli.tsx          # Barrel → src/ui/
├── companions.ts       # Base + expanded companions
├── tools.ts            # Tool definitions & registry
├── config.ts           # Configuration (conf library)
├── types.ts            # Core type definitions
├── agterm/             # Multi-agent orchestration
└── hud/theme-packs/    # 102+ theme packs (7 categories)
```

## Issue Tracking & Workflow

- Issues are tracked in GitHub: https://github.com/calliopeai/calliope-cli/issues
- When working on a feature or fix tied to a GitHub issue, update the issue with progress as you go
- When planning or implementing, reference the issue number in commits (e.g., `feat: smart routing #48`)
- When a task is complete, close the issue via commit message or `gh issue close`
- Check open issues before starting work to avoid duplicating effort

### Roadmap themes

Smart routing (dynamic model selection across providers), swarm mode (parallel
task delegation with overseers), agent councils (consensus / competitive /
collaborative / overseer coordination), and long-running sessions (no iteration
cap, circuit breakers) — track live status in GitHub issues rather than here.

## Testing

- Framework: Vitest
- 4602 tests across 104 test files (`tests/*.test.ts`)
- Run: `npx vitest run`
- Watch: `npx vitest --watch`
- Every fix gets a regression test; cover happy path and error/denied path
