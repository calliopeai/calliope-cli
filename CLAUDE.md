# CLAUDE.md - Calliope CLI

> **Read [`bootstrap.md`](./bootstrap.md) before writing code** — it is the
> canonical conventions document. This file is the Claude-specific shim plus
> issue-tracking notes.

## Project

Multi-model AI agent CLI (`@calliopelabs/cli` v3.0.0). TypeScript + React/Ink, ESM modules. Node ≥ 20.

## Development Rules

- No co-authorship messages in commits
- Import paths must use `.js` extension (ESM)
- All changes must pass `npx tsc --noEmit` and `npx vitest run`
- Circular dep workaround: `setStartLoop()` injection pattern, `require()` for lazy loading
- No hardcoded model lists — discover models + capabilities from each provider's models API (see `bootstrap.md`)

## Architecture

```
src/
├── bin.ts              # Entry point
├── providers/          # 13 backends, live model discovery
├── ui/                 # Ink UI, agent loop, 22 commands
├── tools.ts            # Tool definitions & registry
├── config.ts           # Configuration (conf library, 16 keys)
├── types.ts            # Core type definitions
├── fleet.ts            # Flag-gated IRC fleet bus
└── sandbox/            # Docker + Seatbelt backends, one interface
```

## Issue Tracking & Workflow

- Issues are tracked in GitHub: https://github.com/calliopeai/calliope-cli/issues
- When working on a feature or fix tied to a GitHub issue, update the issue with progress as you go
- When planning or implementing, reference the issue number in commits (e.g., `feat: smart routing #48`)
- When a task is complete, close the issue via commit message or `gh issue close`
- Check open issues before starting work to avoid duplicating effort

### Roadmap themes

v3.0: radical simplification (M1, done), performance + single-binary
distribution (M2), local-model excellence + governance primitives (M3) —
track live status in the roadmap epic (#195) and milestones.

## Testing

- Framework: Vitest
- ~3,500 tests across 94 test files (`tests/*.test.ts`); 90% line-coverage floor via `npm run test:coverage`
- Run: `npx vitest run`
- Watch: `npx vitest --watch`
- Every fix gets a regression test; cover happy path and error/denied path
