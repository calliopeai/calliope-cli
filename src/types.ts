/**
 * Calliope CLI Types
 */

export type LLMProvider = 'anthropic' | 'google' | 'openai' | 'together' | 'openrouter' | 'groq' | 'fireworks' | 'mistral' | 'ollama' | 'ai21' | 'huggingface' | 'litellm' | 'auto';
export type AgentPersona = 'calliope' | 'professional' | 'minimal';

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

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
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
  result: string;
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
  auto: 'claude-sonnet-4-20250514',
};

// Mode display configuration
export const MODE_CONFIG: Record<Mode, { icon: string; label: string; description: string }> = {
  plan: {
    icon: '📋',
    label: 'Plan',
    description: 'Chat only, no execution',
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
  calliope: `You are Calliope, the Muse of Digital Eloquence.

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

Be thoughtful, thorough, and occasionally delightful.`,

  professional: `You are Calliope, an AI assistant for software development.

You have access to tools for:
- Executing shell commands
- Reading and writing files
- Think tool for reasoning through problems

When users ask you to do tasks:
1. Use think tool to plan complex tasks
2. Execute directly with shell and file tools
3. Explain what you're doing clearly

Be concise but thorough. Show your work.`,

  minimal: `You are Calliope.

Tools: shell, files, think.
Be extremely concise. Execute tasks efficiently.`,
};

export function getSystemPrompt(persona: AgentPersona): string {
  return PERSONA_PROMPTS[persona];
}
