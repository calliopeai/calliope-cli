/**
 * Calliope CLI - Context Summarization
 *
 * Summarize long conversations to fit within context limits.
 */

import type { Message as LLMMessage } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface SummarizationResult {
  messages: LLMMessage[];
  summarizedCount: number;
  summary: string;
  originalTokens: number;
  reducedTokens: number;
}

export interface SummarizationOptions {
  maxTokens: number;           // Target max tokens
  preserveRecent: number;      // Number of recent messages to always keep
  preserveSystem: boolean;     // Always keep system messages
  summaryMaxTokens: number;    // Max tokens for the summary
}

// ============================================================================
// Token Estimation
// ============================================================================

/**
 * Estimate token count for a message
 * Uses conservative approximation: ~3 chars per token for English
 */
export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 3);
}

/**
 * Estimate total tokens for messages
 */
export function estimateTotalTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content);
    } else {
      for (const block of msg.content) {
        if (block.type === 'text') {
          total += estimateTokens(block.text);
        }
      }
    }
    // Add overhead for role, formatting, metadata
    total += 40;
  }
  return total;
}

// ============================================================================
// Message Extraction
// ============================================================================

/**
 * Get text content from a message
 */
function getMessageText(msg: LLMMessage): string {
  if (typeof msg.content === 'string') {
    return msg.content;
  }
  return msg.content
    .filter(b => b.type === 'text')
    .map(b => (b as { type: 'text'; text: string }).text)
    .join('\n');
}

/**
 * Extract key information from messages
 */
export function extractKeyInfo(messages: LLMMessage[]): {
  topics: string[];
  decisions: string[];
  actions: string[];
  codeChanges: string[];
} {
  const topics: string[] = [];
  const decisions: string[] = [];
  const actions: string[] = [];
  const codeChanges: string[] = [];

  for (const msg of messages) {
    const text = getMessageText(msg);

    // Extract topics (headers and emphasized text)
    const topicMatches = text.match(/^#+\s+(.+)$/gm) || [];
    topics.push(...topicMatches.map(m => m.replace(/^#+\s+/, '')));

    // Extract decisions (patterns like "decided to", "chose to", etc.)
    const decisionPatterns = [
      /(?:decided|chose|selected|picked|went with)\s+(?:to\s+)?([^.]+)/gi,
      /(?:will|going to)\s+([^.]+)/gi,
    ];
    for (const pattern of decisionPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        decisions.push(match[1]!.trim());
      }
    }

    // Extract actions (tool uses)
    if (msg.toolCalls) {
      for (const tool of msg.toolCalls) {
        const args = tool.arguments as Record<string, unknown>;
        if (tool.name === 'shell') {
          actions.push(`Ran: ${String(args.command || '').slice(0, 50)}`);
        } else if (tool.name === 'write_file') {
          codeChanges.push(`Wrote: ${String(args.path || '')}`);
        } else if (tool.name === 'read_file') {
          actions.push(`Read: ${String(args.path || '')}`);
        }
      }
    }
  }

  return {
    topics: [...new Set(topics)].slice(0, 10),
    decisions: [...new Set(decisions)].slice(0, 10),
    actions: [...new Set(actions)].slice(0, 10),
    codeChanges: [...new Set(codeChanges)].slice(0, 10),
  };
}

// ============================================================================
// Summarization
// ============================================================================

/**
 * Create a summary of messages
 */
export function summarizeMessages(messages: LLMMessage[]): string {
  const info = extractKeyInfo(messages);
  const parts: string[] = [];

  parts.push(`[Summary of ${messages.length} messages]`);

  if (info.topics.length > 0) {
    parts.push(`\nTopics discussed: ${info.topics.join(', ')}`);
  }

  if (info.decisions.length > 0) {
    parts.push(`\nKey decisions:\n- ${info.decisions.join('\n- ')}`);
  }

  if (info.codeChanges.length > 0) {
    parts.push(`\nFiles modified:\n- ${info.codeChanges.join('\n- ')}`);
  }

  if (info.actions.length > 0) {
    parts.push(`\nActions taken:\n- ${info.actions.slice(0, 5).join('\n- ')}`);
  }

  return parts.join('\n');
}

/**
 * Find a safe split point that doesn't break tool call/result pairs.
 * Tool results must always follow their corresponding tool use in the previous message.
 */
function findSafeSplitPoint(messages: LLMMessage[], targetIndex: number): number {
  // Start from target and move backwards to find a safe point
  let splitIndex = targetIndex;

  // Don't split before a tool result message
  while (splitIndex > 0 && splitIndex < messages.length) {
    const msg = messages[splitIndex]!;
    // If this is a tool result, we need to include the previous message (which has the tool_use)
    if (msg.role === 'tool') {
      splitIndex--;
    } else if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // If this is an assistant message with tool calls, include subsequent tool results
      let nextIndex = splitIndex + 1;
      while (nextIndex < messages.length && messages[nextIndex]!.role === 'tool') {
        nextIndex++;
      }
      // If we'd split in the middle of tool results, move split point after them
      if (nextIndex > splitIndex + 1 && targetIndex < nextIndex) {
        splitIndex = nextIndex;
      }
      break;
    } else {
      break;
    }
  }

  return Math.max(0, splitIndex);
}

/**
 * Summarize conversation to fit within token limit
 */
export function summarizeConversation(
  messages: LLMMessage[],
  options: Partial<SummarizationOptions> = {}
): SummarizationResult {
  const opts: SummarizationOptions = {
    maxTokens: options.maxTokens || 100000,
    preserveRecent: options.preserveRecent || 10,
    preserveSystem: options.preserveSystem !== false,
    summaryMaxTokens: options.summaryMaxTokens || 2000,
  };

  const originalTokens = estimateTotalTokens(messages);

  // If already under limit, return as-is
  if (originalTokens <= opts.maxTokens) {
    return {
      messages,
      summarizedCount: 0,
      summary: '',
      originalTokens,
      reducedTokens: originalTokens,
    };
  }

  // Separate system messages
  const systemMessages = opts.preserveSystem
    ? messages.filter(m => m.role === 'system')
    : [];

  // Find safe split point that doesn't break tool call/result pairs
  const targetSplitIndex = messages.length - opts.preserveRecent;
  const safeSplitIndex = findSafeSplitPoint(messages, targetSplitIndex);

  const recentMessages = messages.slice(safeSplitIndex);
  const toSummarize = messages.slice(
    systemMessages.length,
    safeSplitIndex
  );

  // Create summary
  const summary = summarizeMessages(toSummarize);

  // Build new message list
  const summarizedMessages: LLMMessage[] = [
    ...systemMessages,
    {
      role: 'system',
      content: `Previous conversation summary:\n${summary}`,
    },
    ...recentMessages,
  ];

  const reducedTokens = estimateTotalTokens(summarizedMessages);

  return {
    messages: summarizedMessages,
    summarizedCount: toSummarize.length,
    summary,
    originalTokens,
    reducedTokens,
  };
}

// ============================================================================
// Incremental Summarization
// ============================================================================

export class ConversationSummarizer {
  private summaries: string[] = [];
  private currentMessages: LLMMessage[] = [];
  private options: SummarizationOptions;

  constructor(options: Partial<SummarizationOptions> = {}) {
    this.options = {
      maxTokens: options.maxTokens || 50000,
      preserveRecent: options.preserveRecent || 10,
      preserveSystem: options.preserveSystem !== false,
      summaryMaxTokens: options.summaryMaxTokens || 1000,
    };
  }

  /**
   * Add a message
   */
  addMessage(message: LLMMessage): void {
    this.currentMessages.push(message);
    this.checkAndSummarize();
  }

  /**
   * Add multiple messages
   */
  addMessages(messages: LLMMessage[]): void {
    this.currentMessages.push(...messages);
    this.checkAndSummarize();
  }

  /**
   * Check if summarization is needed
   */
  private checkAndSummarize(): void {
    const tokens = estimateTotalTokens(this.currentMessages);

    if (tokens > this.options.maxTokens) {
      // Summarize older messages
      const toSummarize = this.currentMessages.slice(
        0,
        -this.options.preserveRecent
      );
      const summary = summarizeMessages(toSummarize);
      this.summaries.push(summary);

      // Keep only recent messages
      this.currentMessages = this.currentMessages.slice(
        -this.options.preserveRecent
      );
    }
  }

  /**
   * Get current messages with summaries
   */
  getMessages(): LLMMessage[] {
    const messages: LLMMessage[] = [];

    // Add summaries as system message
    if (this.summaries.length > 0) {
      messages.push({
        role: 'system',
        content: `Previous conversation summaries:\n\n${this.summaries.join('\n\n---\n\n')}`,
      });
    }

    messages.push(...this.currentMessages);
    return messages;
  }

  /**
   * Get summary count
   */
  getSummaryCount(): number {
    return this.summaries.length;
  }

  /**
   * Clear all summaries and messages
   */
  clear(): void {
    this.summaries = [];
    this.currentMessages = [];
  }
}

// ============================================================================
// Message Validation
// ============================================================================

/**
 * Validate and clean message history to ensure:
 * 1. Every tool_result has a corresponding tool_use in the previous assistant message
 * 2. Every tool_use has corresponding tool_result(s) immediately following
 * This prevents API errors from orphaned tool calls or results.
 */
export function validateMessageHistory(messages: LLMMessage[]): LLMMessage[] {
  // First pass: collect all tool_result IDs in the conversation
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'tool') {
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      if (toolCallId) {
        toolResultIds.add(toolCallId);
      }
    }
  }

  // Second pass: build cleaned array, ensuring tool_use/tool_result pairs are complete
  const cleaned: LLMMessage[] = [];
  const pendingToolIds = new Set<string>();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Check if ALL tool calls have corresponding results somewhere after
      const allHaveResults = msg.toolCalls.every(tool => toolResultIds.has(tool.id));

      if (allHaveResults) {
        // Track these tool IDs as valid for upcoming tool results
        pendingToolIds.clear();
        for (const tool of msg.toolCalls) {
          pendingToolIds.add(tool.id);
        }
        cleaned.push(msg);
      } else {
        // This assistant message has orphaned tool_use - strip the toolCalls but keep content
        if (msg.content && typeof msg.content === 'string' && msg.content.trim()) {
          cleaned.push({ role: 'assistant', content: msg.content });
        }
        pendingToolIds.clear();
      }
    } else if (msg.role === 'tool') {
      // Only include tool results with valid pending tool IDs
      const toolCallId = (msg as { toolCallId?: string }).toolCallId;
      if (toolCallId && pendingToolIds.has(toolCallId)) {
        cleaned.push(msg);
        pendingToolIds.delete(toolCallId);
      }
      // Skip orphaned tool results silently
    } else {
      // Non-tool messages clear pending tool IDs
      pendingToolIds.clear();
      cleaned.push(msg);
    }
  }

  return cleaned;
}
