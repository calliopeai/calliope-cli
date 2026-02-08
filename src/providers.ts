/**
 * Calliope CLI - LLM Providers
 *
 * Barrel re-export. The implementation lives in src/providers/.
 *
 * @see providers/types.ts     — Shared types, constants, token estimation, validation
 * @see providers/anthropic.ts — Anthropic Claude provider
 * @see providers/google.ts    — Google Gemini provider
 * @see providers/openai.ts    — OpenAI provider (Chat Completions + Responses API)
 * @see providers/compat.ts    — OpenAI-compatible providers (OpenRouter, Groq, etc.)
 * @see providers/index.ts     — Provider selection, routing, re-exports
 */

export * from './providers/index.js';
