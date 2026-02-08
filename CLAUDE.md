# CLAUDE.md - Calliope CLI

## Project

Multi-model AI agent CLI (`@calliopelabs/cli` v0.8.20). TypeScript + React/Ink, ESM modules.

## Development Rules

- No co-authorship messages in commits
- Import paths must use `.js` extension (ESM)
- All changes must pass `npx tsc --noEmit` and `npx vitest run`
- Barrel pattern: original files re-export from subdirectories (zero import path changes)
- Circular dep workaround: `setStartLoop()` injection pattern, `require()` for lazy loading

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

### Active Roadmap Issues

- #48 - Smart Routing: dynamic model selection across providers
- #49 - Swarm Mode: parallel task delegation with overseers
- #50 - Agent Councils: multi-agent coordination (consensus, competitive, collaborative, overseer)
- #51 - Long-running sessions: remove iteration cap, add circuit breakers

## Testing

- Framework: Vitest
- 200 tests across 10 test files
- Run: `npx vitest run`
- Watch: `npx vitest --watch`
