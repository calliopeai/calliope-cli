/**
 * Calliope CLI - LLM-Based Auto-Compression
 *
 * Automatically compresses conversation context using LLM summarization
 * when approaching token limits. Falls back to heuristic summarization.
 */

import { chat } from './providers/index.js';
import { summarizeMessages, estimateTotalTokens } from './summarization.js';
import type { Message as LLMMessage, LLMProvider, Tool } from './types.js';

// ============================================================================
// Configuration
// ============================================================================

export interface AutoCompressorConfig {
  enabled: boolean;
  triggerThreshold: number;   // Compress when context exceeds this % of limit (default: 75)
  targetThreshold: number;    // Compress down to this % of limit (default: 50)
  preserveRecent: number;     // Always keep this many recent messages (default: 10)
  useLlm: boolean;           // Use LLM for compression (default: true, falls back to heuristic)
  compressionModel?: string;  // Override model for compression (default: use cheapest available)
}

const DEFAULT_CONFIG: AutoCompressorConfig = {
  enabled: true,
  triggerThreshold: 75,
  targetThreshold: 50,
  preserveRecent: 10,
  useLlm: true,
};

let config: AutoCompressorConfig = { ...DEFAULT_CONFIG };

/** Configure auto-compressor */
export function configureAutoCompressor(opts: Partial<AutoCompressorConfig>): void {
  config = { ...config, ...opts };
}

/** Get current config */
export function getAutoCompressorConfig(): AutoCompressorConfig {
  return { ...config };
}

// ============================================================================
// LLM-Based Summarization
// ============================================================================

const COMPRESSION_PROMPT = `You are a conversation summarizer. Compress the following conversation into a concise summary that preserves:
1. Key decisions and their reasoning
2. Files modified and their changes
3. Commands executed and their outcomes
4. Current task status and next steps
5. Any errors encountered and how they were resolved

Be concise but complete. Use bullet points. Do not lose important technical details like file paths, function names, or error messages.

Conversation to summarize:`;

/**
 * Summarize messages using an LLM call.
 * Returns the summary text, or null if LLM call fails.
 */
export async function llmSummarize(
  messages: LLMMessage[],
  provider: LLMProvider,
  model?: string,
): Promise<string | null> {
  try {
    // Build conversation text for the summarizer
    const conversationText = messages.map(m => {
      const content = typeof m.content === 'string' ? m.content :
        m.content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('\n');
      const prefix = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'System';
      return `${prefix}: ${content.slice(0, 2000)}`;  // Cap per-message length
    }).join('\n\n');

    const emptyTools: Tool[] = [];
    const summaryMessages: LLMMessage[] = [
      { role: 'system', content: 'You are a precise conversation summarizer. Output only the summary, no preamble.' },
      { role: 'user', content: `${COMPRESSION_PROMPT}\n\n${conversationText}` },
    ];

    const response = await chat(provider, summaryMessages, emptyTools, model);
    if (response.content && response.content.length > 20) {
      return response.content;
    }
    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Auto-Compression Engine
// ============================================================================

export interface CompressionResult {
  compressed: boolean;
  method: 'llm' | 'heuristic' | 'none';
  messages: LLMMessage[];
  originalTokens: number;
  compressedTokens: number;
  summarizedCount: number;
  summary?: string;
}

/**
 * Check if compression is needed and compress if so.
 * Returns the (possibly compressed) message array.
 */
export async function autoCompress(
  messages: LLMMessage[],
  contextLimit: number,
  provider: LLMProvider,
  model?: string,
): Promise<CompressionResult> {
  const currentTokens = estimateTotalTokens(messages);
  const triggerAt = contextLimit * (config.triggerThreshold / 100);

  // Not over threshold — no compression needed
  if (!config.enabled || currentTokens < triggerAt) {
    return {
      compressed: false,
      method: 'none',
      messages,
      originalTokens: currentTokens,
      compressedTokens: currentTokens,
      summarizedCount: 0,
    };
  }

  // Separate system messages and recent messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const nonSystem = messages.filter(m => m.role !== 'system');
  const preserveCount = Math.min(config.preserveRecent, nonSystem.length);
  const toSummarize = nonSystem.slice(0, nonSystem.length - preserveCount);
  const toKeep = nonSystem.slice(nonSystem.length - preserveCount);

  if (toSummarize.length === 0) {
    return {
      compressed: false,
      method: 'none',
      messages,
      originalTokens: currentTokens,
      compressedTokens: currentTokens,
      summarizedCount: 0,
    };
  }

  // Try LLM summarization first
  let summary: string | null = null;
  let method: 'llm' | 'heuristic' = 'heuristic';

  if (config.useLlm) {
    summary = await llmSummarize(toSummarize, provider, config.compressionModel || model);
    if (summary) method = 'llm';
  }

  // Fallback to heuristic
  if (!summary) {
    summary = summarizeMessages(toSummarize);
    method = 'heuristic';
  }

  // Build compressed messages
  const compressed: LLMMessage[] = [
    ...systemMessages,
    { role: 'system', content: `[Auto-compressed context — ${method} summary of ${toSummarize.length} messages]\n\n${summary}` },
    ...toKeep,
  ];

  const compressedTokens = estimateTotalTokens(compressed);

  return {
    compressed: true,
    method,
    messages: compressed,
    originalTokens: currentTokens,
    compressedTokens,
    summarizedCount: toSummarize.length,
    summary,
  };
}

/**
 * Check if compression should be triggered (without actually compressing).
 * Useful for status display.
 */
export function shouldCompress(currentTokens: number, contextLimit: number): boolean {
  if (!config.enabled) return false;
  return currentTokens >= contextLimit * (config.triggerThreshold / 100);
}
