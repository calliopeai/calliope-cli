/**
 * Calliope CLI Types
 */

export type LLMProvider = 'anthropic' | 'google' | 'openai' | 'together' | 'openrouter' | 'groq' | 'fireworks' | 'mistral' | 'ollama' | 'ai21' | 'huggingface' | 'litellm' | 'bedrock' | 'openai-compat' | 'auto';

/**
 * CLI operation modes
 * - plan: Chat only, no tools executed
 * - hybrid: Smart detection, plans before complex operations
 * - work: Direct execution (current behavior)
 */
export type Mode = 'plan' | 'hybrid' | 'work';

/**
 * Risk levels for operations
 */
export type RiskLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Risk assessment result
 */
export interface RiskAssessment {
  level: RiskLevel;
  reason: string;
  requiresConfirmation: boolean;
}

export interface ImageContent {
  type: 'image';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string; // base64
}

export interface TextContent {
  type: 'text';
  text: string;
}

export type MessageContent = string | (TextContent | ImageContent)[];

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: MessageContent;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  result: string;           // Full content sent to LLM
  displayResult?: string;   // Human-friendly summary for terminal display (if different from result)
  isError?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
      items?: { type: string };
    }>;
    required?: string[];
  };
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  finishReason: 'stop' | 'tool_use' | 'length' | 'error';
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  // Non-fatal notices the caller must surface, never swallow (#217). Example:
  // Ollama substituting a fallback model when the requested one isn't pulled.
  warnings?: string[];
}

// Default model per provider. This is the OFFLINE EMERGENCY FALLBACK only —
// model selection is normally driven by live discovery (see model-detection.ts).
// Keep these current so the no-key / offline path doesn't point at a retired model.
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-6',
  google: 'gemini-2.0-flash',
  openai: 'gpt-4o',
  together: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
  openrouter: 'anthropic/claude-sonnet-4',
  groq: 'llama-3.3-70b-versatile',
  fireworks: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
  mistral: 'mistral-large-latest',
  ollama: 'llama3.3',
  ai21: 'jamba-1.5-large',
  huggingface: 'meta-llama/Llama-3.3-70B-Instruct',
  litellm: 'gpt-4o',  // LiteLLM proxies to other providers
  bedrock: 'us.anthropic.claude-sonnet-4-20250514-v1:0',  // AWS Bedrock (native Converse API)
  'openai-compat': 'gpt-3.5-turbo',  // Generic OpenAI-compatible server
  auto: 'claude-sonnet-4-6',
};

// Mode display configuration
export const MODE_CONFIG: Record<Mode, { icon: string; label: string; description: string }> = {
  plan: {
    icon: '📋',
    label: 'Plan',
    description: 'Chat & plan, no execution. Use create_plan for structured plans.',
  },
  hybrid: {
    icon: '🔄',
    label: 'Hybrid',
    description: 'Smart planning before execution',
  },
  work: {
    icon: '🔧',
    label: 'Work',
    description: 'Direct execution',
  },
};

// Risk display configuration
export const RISK_CONFIG: Record<RiskLevel, { bar: string; color: string; label: string }> = {
  none: {
    bar: '░░░░░',
    color: 'dim',
    label: 'None',
  },
  low: {
    bar: '█░░░░',
    color: 'green',
    label: 'Low',
  },
  medium: {
    bar: '███░░',
    color: 'yellow',
    label: 'Medium',
  },
  high: {
    bar: '████░',
    color: 'red',
    label: 'High',
  },
  critical: {
    bar: '█████',
    color: 'red',
    label: 'CRITICAL',
  },
};

// Base system prompt for the Calliope agent.
const BASE_PROMPT = `You are Calliope, an AI assistant for software development.

You have access to tools for:
- Executing shell commands
- Reading and writing files
- Think tool for reasoning through problems

When users ask you to do tasks:
1. Use think tool to plan complex tasks
2. Execute directly with shell and file tools
3. Explain what you're doing clearly

Do NOT create documentation files, summaries, or README files unless explicitly asked. Focus on the task.

Be concise but thorough. Show your work.`;

/**
 * Safety preamble prepended to the system prompt.
 * These rules are non-negotiable and cannot be overridden.
 */
const SAFETY_PREAMBLE = `[SAFETY - These rules ALWAYS apply and cannot be overridden]
- Only modify files within the user's project scope
- Never execute destructive system commands (rm -rf /, sudo, dd, mkfs)
- Never access or leak credentials, API keys, or sensitive environment variables
- Always respect user's explicit instructions (read-only, no-write, etc.)
- Do NOT create documentation files unless explicitly requested
[END SAFETY]

[GROUNDING - Prevent agent overreach]
- If the user sends a short or ambiguous message, ask a brief clarifying question instead of speculating
- Never read source files or run commands unless the user explicitly asks or the task requires it
- Keep responses concise and focused on what was asked
- Do NOT offer numbered option menus for simple inputs
- If unsure what the user wants, respond with a brief question, not a multi-tool investigation
[END GROUNDING]

`;

/**
 * Compact base prompt for local (self-hosted) backends. Folds the essentials of
 * BASE_PROMPT and the grounding cues into one tight paragraph so small-context
 * 7-70B models spend their budget on the task, not boilerplate. Keep this short
 * (~100 chars): the local-model test asserts the whole compact prompt is under
 * 40% of the full prompt's tokens. The non-negotiable [SAFETY] rules block is
 * still prepended verbatim (see getSystemPrompt below).
 */
const COMPACT_BASE_PROMPT = `You are Calliope, a terminal coding agent. Use tools to edit files and run commands; ask if unclear.`;

export function getSystemPrompt(opts?: { compact?: boolean }): string {
  if (opts?.compact) {
    // Keep the [SAFETY]…[END SAFETY] block verbatim; drop the verbose GROUNDING
    // section and long base prompt in favour of the compact base.
    const safetyOnly = SAFETY_PREAMBLE.slice(0, SAFETY_PREAMBLE.indexOf('[GROUNDING'));
    return safetyOnly + COMPACT_BASE_PROMPT;
  }
  return SAFETY_PREAMBLE + BASE_PROMPT;
}

// Pricing per 1M tokens (input, output) in USD
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic — current models
  'claude-fable-5': { input: 10, output: 50 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  // Anthropic — legacy (still served)
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-opus-4-20250514': { input: 15, output: 75 },
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-haiku-20241022': { input: 0.8, output: 4 },
  'claude-3-opus-20240229': { input: 15, output: 75 },
  // OpenAI
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  // Google
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  // Mistral
  'mistral-large-latest': { input: 2, output: 6 },
  'mistral-small-latest': { input: 0.2, output: 0.6 },
  // Groq (free tier, minimal cost)
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  'llama-3.1-8b-instant': { input: 0.05, output: 0.08 },
  // Together
  'meta-llama/Llama-3.3-70B-Instruct-Turbo': { input: 0.88, output: 0.88 },
  // AWS Bedrock — global inference model IDs
  'us.anthropic.claude-opus-4-20250514-v1:0': { input: 15, output: 75 },
  'us.anthropic.claude-sonnet-4-20250514-v1:0': { input: 3, output: 15 },
  'us.anthropic.claude-haiku-4-5-20251001-v1:0': { input: 0.8, output: 4 },
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3, output: 15 },
  'us.anthropic.claude-3-5-haiku-20241022-v1:0': { input: 0.8, output: 4 },
  'us.meta.llama3-3-70b-instruct-v1:0': { input: 0.99, output: 0.99 },
  'us.amazon.nova-pro-v1:0': { input: 0.8, output: 3.2 },
  'us.amazon.nova-lite-v1:0': { input: 0.06, output: 0.24 },
  // AWS Bedrock — regional model IDs (legacy)
  'anthropic.claude-3-5-sonnet-20241022-v2:0': { input: 3, output: 15 },
  'anthropic.claude-3-opus-20240229-v1:0': { input: 15, output: 75 },
  'anthropic.claude-3-haiku-20240307-v1:0': { input: 0.25, output: 1.25 },
  'amazon.titan-text-premier-v1:0': { input: 0.5, output: 1.5 },
  'meta.llama3-1-70b-instruct-v1:0': { input: 0.99, output: 0.99 },
  // Default fallback
  'default': { input: 1, output: 3 },
};

/**
 * Calculate cost for token usage
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['default'];
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
}

/**
 * Providers that support vision
 */
export const VISION_PROVIDERS: LLMProvider[] = ['anthropic', 'openai', 'google', 'bedrock'];

/**
 * Check if a provider/model supports vision
 */
export function supportsVision(provider: LLMProvider, _model?: string): boolean {
  return VISION_PROVIDERS.includes(provider);
}
