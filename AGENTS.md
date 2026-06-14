# AGENTS.md — Calliope CLI

**Read [`bootstrap.md`](./bootstrap.md) before writing any code.** It is the
canonical conventions document; when anything here conflicts with it, it wins.

## Stack at a glance
- TypeScript, **ESM** (`strict: true`, `module: NodeNext`). React 19 + Ink 6 TUI.
- Entry `src/bin.ts`. Config via `conf`. Multi-provider (Anthropic / Google /
  OpenAI / OpenAI-compatible). Tests in `tests/` (Vitest).

## Non-negotiables
- ESM imports use the **`.js`** extension, even for `.ts` files.
- `npx tsc --noEmit` and `npx vitest run` must both pass before any commit.
- **No hardcoded model lists** — discover models + capabilities from each
  provider's models API (see `bootstrap.md` → *Model discovery*).
- No AI co-authorship/attribution anywhere. Surgical changes only — match
  existing style, touch only what the task needs.
- Barrel pattern: add to the subdirectory and re-export from the original file;
  never reintroduce a monolith.

## Workflow
- Plans go on GitHub issues, not local files. Branch per issue off `main`
  (`fix/N-…` / `feat/N-…`), reference the issue number in commits, one PR per
  issue, green CI + review before merge. No rebases.

## Testing
- Every fix gets a regression test; cover happy path **and** error/denied path.
  Don't mock away the unit under test. Coverage must not decrease.
