# Calliope CLI - Project Memory

## Overview

Calliope CLI is a multi-model AI agent for the terminal: one agent loop over
13 provider backends (cloud and self-hosted), with sandbox-first tool
execution, git-based checkpoints, project memory, MCP, and a flag-gated
fleet-coordination mode. Positioning: **the private-AI agent CLI** — the
best harness for models you run yourself.

**Current Version:** 3.0.0
**Organization:** Calliope Labs Inc
**Repository:** https://github.com/calliopeai/calliope-cli

## Architecture (v3)

- `src/bin.ts` — entry; renderer selection is automatic (headless without a
  TTY or with `--headless`, Ink otherwise)
- `src/providers/` — 13 backends; native Anthropic/Google/OpenAI + Bedrock,
  Ollama, and an OpenAI-compatible layer with server shims. No hardcoded
  model lists: live discovery per provider.
- `src/ui/` — Ink UI; `agent.ts` holds the loop; 22 slash commands + gated
  `/fleet` (`commands.ts`, registry-tested)
- `src/tools.ts` + `src/sandbox/` — tool registry; Docker/Seatbelt sandboxes
  behind one interface (`sandboxMode`)
- `src/router.ts` — complexity analysis + cross-provider routing
  (`routing.*` config)
- `src/checkpoint.ts` — git-based checkpoints (refs under
  `refs/calliope/checkpoints`); `/restore`
- `src/fleet.ts` — sole importer of `src/scuttlebot/`; lazy, off by default
  (`fleet.enabled`)
- `src/config.ts` — 16 keys; `providers.<name>.*` credential map with env
  fallbacks; `migrateV3()` folds v2 configs forward

## Conventions

See `bootstrap.md` (canonical) and `CLAUDE.md` (agent shim). Highlights:
TypeScript ESM with `.js` import extensions; `npx tsc --noEmit` and
`npx vitest run` must pass; coverage floor 90% lines; no hardcoded model
lists; sandbox is the security boundary; plans live in GitHub issues.

## v3.0 status

M1 (The Cut) is complete — see the roadmap epic
https://github.com/calliopeai/calliope-cli/issues/195 for the live
milestone state (M2: performance + single-binary distribution; M3:
local-model excellence + governance primitives).
