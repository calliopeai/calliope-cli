/**
 * Provider Shared Types & Utilities
 *
 * Constants, token estimation, context health, validation, and shared helpers.
 */

import { getModelContextLimit } from '../model-detection.js';
import type { Message, Tool, LLMResponse, LLMProvider, TextContent } from '../types.js';

// Constants
export const MAX_TOKENS = 8192;
export const MIN_OUTPUT_TOKENS = 1024; // Minimum output tokens to request
export const CONTEXT_BUFFER_PERCENT = 0.08; // 8% of context as safety buffer
export const CONTEXT_BUFFER_MIN = 5000; // Minimum 5k buffer

/** Maximum allowed content length (1MB) to prevent memory issues */
export const MAX_CONTENT_LENGTH = 1024 * 1024;

// Debug logging helper
const DEBUG = process.env.CALLIOPE_DEBUG === '1';
export function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[DEBUG] ${message}`, ...args);
}

/**
 * Streaming callback type
 */
export type StreamCallback = (token: string) => void;

/**
 * Retry callback type for UI updates
 */
export type RetryCallback = (attempt: number, error: Error, delayMs: number) => void;

/**
 * Extract text from MessageContent
 */
export function getTextContent(content: Message['content']): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .filter(block => block.type === 'text')
    .map(block => (block as TextContent).text)
    .join('\n');
}

/**
 * Estimate tokens from messages (conservative: ~3 chars per token)
 * Uses conservative estimation to avoid context overflow
 */
export function estimateInputTokens(messages: Message[], tools: Tool[]): number {
  let totalChars = 0;

  for (const msg of messages) {
    // Add per-message overhead (role, structure, etc.)
    totalChars += 50;

    if (typeof msg.content === 'string') {
      totalChars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          totalChars += (block as TextContent).text.length;
        } else if (block.type === 'image') {
          // Images are roughly 85 tokens per tile (assuming ~750 tokens average)
          totalChars += 3000;
        }
      }
    }
    // Add overhead for tool calls in assistant messages
    if (msg.toolCalls) {
      totalChars += JSON.stringify(msg.toolCalls).length;
    }
  }

  // Add tool definitions overhead
  if (tools.length > 0) {
    totalChars += JSON.stringify(tools).length;
  }

  // Very conservative estimate: 2.5 characters per token
  // Plus 35% overhead for message structure, system prompt, and formatting
  return Math.ceil((totalChars / 2.5) * 1.35);
}

/**
 * Calculate dynamic max_tokens based on available context space
 */
export function calculateMaxTokens(
  provider: LLMProvider,
  model: string,
  messages: Message[],
  tools: Tool[]
): number {
  const contextLimit = getModelContextLimit(provider, model);
  const estimatedInput = estimateInputTokens(messages, tools);
  // Use percentage-based buffer with minimum floor
  const buffer = Math.max(CONTEXT_BUFFER_MIN, Math.ceil(contextLimit * CONTEXT_BUFFER_PERCENT));
  const available = contextLimit - estimatedInput - buffer;

  debugLog(`Context calculation: limit=${contextLimit}, input≈${estimatedInput}, buffer=${buffer}, available=${available}`);

  // Ensure we have at least MIN_OUTPUT_TOKENS, up to MAX_TOKENS
  if (available < MIN_OUTPUT_TOKENS) {
    debugLog(`WARNING: Very limited output space (${available}), using minimum ${MIN_OUTPUT_TOKENS}`);
    return MIN_OUTPUT_TOKENS;
  }

  return Math.min(MAX_TOKENS, available);
}

/**
 * Check if context needs summarization based on actual token usage
 * Call this with the input_tokens from the last API response
 */
export function needsSummarization(
  provider: LLMProvider,
  model: string,
  actualInputTokens: number
): boolean {
  const contextLimit = getModelContextLimit(provider, model);
  const threshold = contextLimit * 0.70; // Trigger summarization at 70% full
  return actualInputTokens >= threshold;
}

/**
 * Get context health info
 */
export function getContextHealth(
  provider: LLMProvider,
  model: string,
  actualInputTokens: number
): { limit: number; used: number; percent: number; needsSummarization: boolean } {
  const limit = getModelContextLimit(provider, model);
  const percent = Math.round((actualInputTokens / limit) * 100);
  return {
    limit,
    used: actualInputTokens,
    percent,
    needsSummarization: actualInputTokens >= limit * 0.70,
  };
}

/**
 * Estimate context usage before making a request (for pre-request summarization)
 * Uses conservative estimation since we don't have actual token counts yet
 */
export function estimateContextUsage(
  provider: LLMProvider,
  model: string,
  messages: Message[],
  tools: Tool[]
): { estimated: number; limit: number; percent: number; needsSummarization: boolean } {
  const estimated = estimateInputTokens(messages, tools);
  const limit = getModelContextLimit(provider, model);
  const percent = Math.round((estimated / limit) * 100);
  return {
    estimated,
    limit,
    percent,
    needsSummarization: estimated >= limit * 0.70, // Conservative threshold for estimates
  };
}

/**
 * Validate and sanitize LLM response
 */
export function validateLLMResponse(response: LLMResponse): LLMResponse {
  // Ensure content is a string
  if (response.content === null || response.content === undefined) {
    response.content = '';
  } else if (typeof response.content !== 'string') {
    response.content = String(response.content);
  }

  // Truncate if too long to prevent memory issues
  if (response.content.length > MAX_CONTENT_LENGTH) {
    debugLog('Response content truncated from', response.content.length, 'to', MAX_CONTENT_LENGTH);
    response.content = response.content.slice(0, MAX_CONTENT_LENGTH) + '\n... [truncated]';
  }

  // Validate tool calls if present
  if (response.toolCalls) {
    response.toolCalls = response.toolCalls.filter(call => {
      if (!call.id || typeof call.id !== 'string') {
        debugLog('Invalid tool call: missing or invalid id', call);
        return false;
      }
      if (!call.name || typeof call.name !== 'string') {
        debugLog('Invalid tool call: missing or invalid name', call);
        return false;
      }
      if (call.arguments === null || call.arguments === undefined) {
        call.arguments = {};
      }
      return true;
    });

    if (response.toolCalls.length === 0) {
      response.toolCalls = undefined;
    }
  }

  // Ensure valid finish reason
  if (!['stop', 'tool_use', 'length', 'error'].includes(response.finishReason)) {
    response.finishReason = 'stop';
  }

  return response;
}
