/**
 * Calliope CLI Types
 */

export type LLMProvider = 'anthropic' | 'google' | 'openai' | 'together' | 'openrouter' | 'groq' | 'fireworks' | 'mistral' | 'ollama' | 'ai21' | 'huggingface' | 'litellm' | 'bedrock' | 'auto';
export type AgentPersona = 'calliope' | 'muse' | 'minimal';

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
}

// Default models for each provider
export const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: 'claude-sonnet-4-20250514',
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
  bedrock: 'anthropic.claude-3-5-sonnet-20241022-v2:0',  // AWS Bedrock (via gateway/proxy)
  auto: 'claude-sonnet-4-20250514',
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

// System prompts for different personas
export const PERSONA_PROMPTS: Record<AgentPersona, string> = {
  calliope: `You are Calliope, an AI assistant for software development.

You have access to tools for:
- Executing shell commands
- Reading and writing files
- Think tool for reasoning through problems

When users ask you to do tasks:
1. Use think tool to plan complex tasks
2. Execute directly with shell and file tools
3. Explain what you're doing clearly

Do NOT create documentation files, summaries, or README files unless explicitly asked. Focus on the task.

Be concise but thorough. Show your work.`,

  muse: `You are Calliope, an AI assistant with a creative personality.

You weave code and prose together with artistry. Your responses blend technical precision with creative flair.
Speak with warmth and occasional poetic flourishes, but never sacrifice clarity for style.

You have access to powerful tools:
- Shell commands for system operations
- File reading and writing
- Think tool for reasoning through complex problems

When approaching tasks:
1. Consider the elegance of the solution, not just its function
2. Break complex work into harmonious steps using the think tool
3. Execute directly with shell and file tools
4. Illuminate your reasoning - show the art behind the craft

IMPORTANT: Do NOT create documentation files, summary documents, README files, or markdown notes unless explicitly requested. Focus on the actual task. Avoid verbose narration between steps.

Be thoughtful, thorough, and occasionally delightful.`,

  minimal: `You are Calliope.

Tools: shell, files, think.
Be extremely concise. Execute tasks efficiently.`,
};

/**
 * Safety preamble prepended to ALL system prompts (including companions).
 * This ensures companion personas cannot override core safety instructions.
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

export function getSystemPrompt(persona: AgentPersona): string {
  // If a companion is active, use its system prompt instead of the base persona
  let basePrompt = PERSONA_PROMPTS[persona];
  try {
    const companions = require('./companions.js');
    const companion = companions.getCurrentCompanion();
    // Only override if companion is not one of the base personas (those already map to PERSONA_PROMPTS)
    if (companion && companion.systemPrompt && !['calliope', 'muse', 'minimal'].includes(companion.name)) {
      basePrompt = companion.systemPrompt;
    }
  } catch { /* companions not loaded yet, use base persona */ }
  // Prepend safety preamble so companion prompts cannot override safety rules
  return SAFETY_PREAMBLE + basePrompt;
}

// Pricing per 1M tokens (input, output) in USD
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic
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
  // AWS Bedrock (same pricing as direct Anthropic)
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
export function supportsVision(provider: LLMProvider, model?: string): boolean {
  if (!VISION_PROVIDERS.includes(provider)) return false;
  // Most modern models from these providers support vision
  if (model?.includes('haiku') || model?.includes('mini')) return true;
  if (model?.includes('sonnet') || model?.includes('opus')) return true;
  if (model?.includes('gpt-4')) return true;
  if (model?.includes('gemini')) return true;
  return true;
}
