/**
 * Tests for src/summarization.ts
 *
 * Covers: estimateTokens, estimateTotalTokens, extractKeyInfo,
 * summarizeMessages, summarizeConversation, ConversationSummarizer,
 * validateMessageHistory.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTokens,
  estimateTotalTokens,
  extractKeyInfo,
  summarizeMessages,
  summarizeConversation,
  ConversationSummarizer,
  validateMessageHistory,
} from '../src/summarization.js';
import type { Message as LLMMessage } from '../src/types.js';

// ===========================================================================
// Helpers
// ===========================================================================

function userMsg(content: string): LLMMessage {
  return { role: 'user', content };
}

function assistantMsg(content: string): LLMMessage {
  return { role: 'assistant', content };
}

function systemMsg(content: string): LLMMessage {
  return { role: 'system', content };
}

function toolResultMsg(toolCallId: string, content: string): LLMMessage {
  return { role: 'tool', content, toolCallId };
}

function assistantWithTools(
  content: string,
  toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[]
): LLMMessage {
  return { role: 'assistant', content, toolCalls };
}

// ===========================================================================
// estimateTokens
// ===========================================================================

describe('estimateTokens', () => {
  it('should estimate tokens as ceil(length / 3)', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('abcdef')).toBe(2);
    expect(estimateTokens('abcdefg')).toBe(3);
  });

  it('should return 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('should handle long text', () => {
    const text = 'a'.repeat(300);
    expect(estimateTokens(text)).toBe(100);
  });

  it('should handle single character', () => {
    expect(estimateTokens('a')).toBe(1);
  });
});

// ===========================================================================
// estimateTotalTokens
// ===========================================================================

describe('estimateTotalTokens', () => {
  it('should return 0 for empty array', () => {
    expect(estimateTotalTokens([])).toBe(0);
  });

  it('should estimate tokens for string content messages', () => {
    const messages: LLMMessage[] = [
      userMsg('hello'),  // ceil(5/3) = 2 + 40 overhead = 42
    ];
    expect(estimateTotalTokens(messages)).toBe(42);
  });

  it('should add 40 overhead per message', () => {
    const messages: LLMMessage[] = [
      userMsg('abc'), // ceil(3/3) + 40 = 41
      assistantMsg('abc'), // ceil(3/3) + 40 = 41
    ];
    expect(estimateTotalTokens(messages)).toBe(82);
  });

  it('should handle block content with text blocks', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'world' },
        ],
      },
    ];
    // ceil(5/3) + ceil(5/3) + 40 = 2 + 2 + 40 = 44
    expect(estimateTotalTokens(messages)).toBe(44);
  });

  it('should skip non-text blocks in block content', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', mediaType: 'image/png', data: 'base64data' } as any,
        ],
      },
    ];
    // Only text block counted: ceil(5/3) + 40 = 42
    expect(estimateTotalTokens(messages)).toBe(42);
  });

  it('should sum tokens across multiple messages', () => {
    const messages: LLMMessage[] = [
      userMsg('aaa'),      // 1 + 40 = 41
      assistantMsg('bbb'), // 1 + 40 = 41
      userMsg('ccc'),      // 1 + 40 = 41
    ];
    expect(estimateTotalTokens(messages)).toBe(123);
  });
});

// ===========================================================================
// extractKeyInfo
// ===========================================================================

describe('extractKeyInfo', () => {
  it('should extract topics from markdown headers', () => {
    const messages: LLMMessage[] = [
      assistantMsg('# Main Topic\nSome text\n## Sub Topic'),
    ];
    const info = extractKeyInfo(messages);
    expect(info.topics).toContain('Main Topic');
    expect(info.topics).toContain('Sub Topic');
  });

  it('should extract decisions from decision patterns', () => {
    const messages: LLMMessage[] = [
      assistantMsg('We decided to use TypeScript for the project.'),
    ];
    const info = extractKeyInfo(messages);
    expect(info.decisions.length).toBeGreaterThan(0);
    expect(info.decisions[0]).toContain('use TypeScript');
  });

  it('should extract decisions with "chose to" pattern', () => {
    const messages: LLMMessage[] = [
      assistantMsg('I chose to implement the feature differently.'),
    ];
    const info = extractKeyInfo(messages);
    expect(info.decisions.length).toBeGreaterThan(0);
  });

  it('should extract decisions with "will" pattern', () => {
    const messages: LLMMessage[] = [
      assistantMsg('We will refactor the module next.'),
    ];
    const info = extractKeyInfo(messages);
    expect(info.decisions.length).toBeGreaterThan(0);
  });

  it('should extract shell actions from tool calls', () => {
    const messages: LLMMessage[] = [
      assistantWithTools('Running a command', [
        { id: 'tc1', name: 'shell', arguments: { command: 'npm test' } },
      ]),
    ];
    const info = extractKeyInfo(messages);
    expect(info.actions).toContain('Ran: npm test');
  });

  it('should extract write_file code changes from tool calls', () => {
    const messages: LLMMessage[] = [
      assistantWithTools('Writing file', [
        { id: 'tc1', name: 'write_file', arguments: { path: '/src/index.ts' } },
      ]),
    ];
    const info = extractKeyInfo(messages);
    expect(info.codeChanges).toContain('Wrote: /src/index.ts');
  });

  it('should extract read_file actions from tool calls', () => {
    const messages: LLMMessage[] = [
      assistantWithTools('Reading file', [
        { id: 'tc1', name: 'read_file', arguments: { path: '/src/config.ts' } },
      ]),
    ];
    const info = extractKeyInfo(messages);
    expect(info.actions).toContain('Read: /src/config.ts');
  });

  it('should deduplicate topics', () => {
    const messages: LLMMessage[] = [
      assistantMsg('# Duplicate Topic\ntext'),
      assistantMsg('# Duplicate Topic\nmore text'),
    ];
    const info = extractKeyInfo(messages);
    const count = info.topics.filter(t => t === 'Duplicate Topic').length;
    expect(count).toBe(1);
  });

  it('should limit topics to 10', () => {
    const headers = Array.from({ length: 15 }, (_, i) => `# Topic ${i}`).join('\n');
    const messages: LLMMessage[] = [assistantMsg(headers)];
    const info = extractKeyInfo(messages);
    expect(info.topics.length).toBeLessThanOrEqual(10);
  });

  it('should limit decisions to 10', () => {
    const text = Array.from({ length: 15 }, (_, i) => `We decided to do thing ${i}.`).join(' ');
    const messages: LLMMessage[] = [assistantMsg(text)];
    const info = extractKeyInfo(messages);
    expect(info.decisions.length).toBeLessThanOrEqual(10);
  });

  it('should truncate long shell commands to 50 chars', () => {
    const longCommand = 'a'.repeat(100);
    const messages: LLMMessage[] = [
      assistantWithTools('cmd', [
        { id: 'tc1', name: 'shell', arguments: { command: longCommand } },
      ]),
    ];
    const info = extractKeyInfo(messages);
    expect(info.actions[0]).toBe(`Ran: ${'a'.repeat(50)}`);
  });

  it('should return empty arrays for messages with no extractable info', () => {
    const messages: LLMMessage[] = [
      userMsg('Hello'),
      assistantMsg('Hi there'),
    ];
    const info = extractKeyInfo(messages);
    expect(info.topics).toEqual([]);
    expect(info.decisions).toEqual([]);
    expect(info.actions).toEqual([]);
    expect(info.codeChanges).toEqual([]);
  });

  it('should handle block content messages', () => {
    const messages: LLMMessage[] = [
      {
        role: 'assistant',
        content: [{ type: 'text', text: '# Block Topic\nSome info' }],
      },
    ];
    const info = extractKeyInfo(messages);
    expect(info.topics).toContain('Block Topic');
  });
});

// ===========================================================================
// summarizeMessages
// ===========================================================================

describe('summarizeMessages', () => {
  it('should include message count', () => {
    const messages: LLMMessage[] = [
      userMsg('hello'),
      assistantMsg('hi'),
      userMsg('bye'),
    ];
    const summary = summarizeMessages(messages);
    expect(summary).toContain('[Summary of 3 messages]');
  });

  it('should include topics when present', () => {
    const messages: LLMMessage[] = [
      assistantMsg('# Database Migration\nWe discussed the schema.'),
    ];
    const summary = summarizeMessages(messages);
    expect(summary).toContain('Topics discussed:');
    expect(summary).toContain('Database Migration');
  });

  it('should include decisions when present', () => {
    const messages: LLMMessage[] = [
      assistantMsg('We decided to use PostgreSQL for storage.'),
    ];
    const summary = summarizeMessages(messages);
    expect(summary).toContain('Key decisions:');
  });

  it('should include code changes when present', () => {
    const messages: LLMMessage[] = [
      assistantWithTools('Writing', [
        { id: 'tc1', name: 'write_file', arguments: { path: '/src/db.ts' } },
      ]),
    ];
    const summary = summarizeMessages(messages);
    expect(summary).toContain('Files modified:');
    expect(summary).toContain('/src/db.ts');
  });

  it('should include actions when present', () => {
    const messages: LLMMessage[] = [
      assistantWithTools('Running tests', [
        { id: 'tc1', name: 'shell', arguments: { command: 'npm test' } },
      ]),
    ];
    const summary = summarizeMessages(messages);
    expect(summary).toContain('Actions taken:');
    expect(summary).toContain('npm test');
  });

  it('should limit actions to 5 in summary', () => {
    const toolCalls = Array.from({ length: 8 }, (_, i) => ({
      id: `tc${i}`,
      name: 'shell' as const,
      arguments: { command: `cmd${i}` },
    }));
    const messages: LLMMessage[] = [
      assistantWithTools('Running many commands', toolCalls),
    ];
    const summary = summarizeMessages(messages);
    // Actions are limited to first 5 in the summary output
    const actionLines = summary.split('\n').filter(l => l.startsWith('- Ran:'));
    expect(actionLines.length).toBeLessThanOrEqual(5);
  });

  it('should handle empty message list', () => {
    const summary = summarizeMessages([]);
    expect(summary).toContain('[Summary of 0 messages]');
  });
});

// ===========================================================================
// summarizeConversation
// ===========================================================================

describe('summarizeConversation', () => {
  it('should return messages as-is if under token limit', () => {
    const messages: LLMMessage[] = [
      userMsg('hello'),
      assistantMsg('hi'),
    ];
    const result = summarizeConversation(messages, { maxTokens: 100000 });
    expect(result.summarizedCount).toBe(0);
    expect(result.summary).toBe('');
    expect(result.messages).toBe(messages);
    expect(result.originalTokens).toBe(result.reducedTokens);
  });

  it('should summarize when over token limit', () => {
    // Create many messages to exceed a low token limit
    const messages: LLMMessage[] = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? userMsg(`Question ${i}: ${'x'.repeat(100)}`) : assistantMsg(`Answer ${i}: ${'y'.repeat(100)}`)
    );
    const result = summarizeConversation(messages, {
      maxTokens: 500,
      preserveRecent: 5,
    });
    expect(result.summarizedCount).toBeGreaterThan(0);
    expect(result.summary).toContain('[Summary of');
    expect(result.reducedTokens).toBeLessThan(result.originalTokens);
  });

  it('should preserve system messages', () => {
    const messages: LLMMessage[] = [
      systemMsg('You are a helpful assistant.'),
      ...Array.from({ length: 30 }, (_, i) =>
        i % 2 === 0 ? userMsg(`Q${i}: ${'x'.repeat(100)}`) : assistantMsg(`A${i}: ${'y'.repeat(100)}`)
      ),
    ];
    const result = summarizeConversation(messages, {
      maxTokens: 500,
      preserveRecent: 5,
      preserveSystem: true,
    });
    // System message should be preserved at the start
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toBe('You are a helpful assistant.');
  });

  it('should not preserve system messages when preserveSystem is false', () => {
    const messages: LLMMessage[] = [
      systemMsg('System prompt'),
      ...Array.from({ length: 30 }, (_, i) =>
        i % 2 === 0 ? userMsg(`Q${i}: ${'x'.repeat(100)}`) : assistantMsg(`A${i}: ${'y'.repeat(100)}`)
      ),
    ];
    const result = summarizeConversation(messages, {
      maxTokens: 500,
      preserveRecent: 5,
      preserveSystem: false,
    });
    // First message should be the summary, not the original system message
    const firstSystemContent = result.messages[0].content as string;
    expect(firstSystemContent).toContain('Previous conversation summary');
  });

  it('should keep recent messages intact', () => {
    const messages: LLMMessage[] = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? userMsg(`Q${i}`) : assistantMsg(`A${i}`)
    );
    const result = summarizeConversation(messages, {
      maxTokens: 100,
      preserveRecent: 5,
    });
    // The last few messages should be from the original
    const lastOriginal = messages[messages.length - 1];
    const lastResult = result.messages[result.messages.length - 1];
    expect(lastResult.content).toBe(lastOriginal.content);
  });

  it('should add summary as system message', () => {
    const messages: LLMMessage[] = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? userMsg(`Q${i}: ${'x'.repeat(100)}`) : assistantMsg(`A${i}: ${'y'.repeat(100)}`)
    );
    const result = summarizeConversation(messages, {
      maxTokens: 500,
      preserveRecent: 5,
    });
    // Should have a system message with summary
    const summaryMsg = result.messages.find(
      m => m.role === 'system' && (m.content as string).includes('Previous conversation summary')
    );
    expect(summaryMsg).toBeDefined();
  });

  it('should use default options when none provided', () => {
    const messages: LLMMessage[] = [
      userMsg('hello'),
      assistantMsg('hi'),
    ];
    const result = summarizeConversation(messages);
    // Default maxTokens is 100000, so short conversation should not be summarized
    expect(result.summarizedCount).toBe(0);
  });

  describe('tool call/result pair safety', () => {
    it('should not split between assistant tool_use and tool results', () => {
      const messages: LLMMessage[] = [
        ...Array.from({ length: 20 }, (_, i) =>
          userMsg(`Padding message ${i}: ${'x'.repeat(200)}`)
        ),
        assistantWithTools('Using tool', [
          { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
        ]),
        toolResultMsg('tc1', 'file1.ts\nfile2.ts'),
        userMsg('Thanks'),
        assistantMsg('Done'),
      ];
      const result = summarizeConversation(messages, {
        maxTokens: 500,
        preserveRecent: 3,
      });
      // The tool call and its result should both be present or both absent
      const hasToolCall = result.messages.some(
        m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
      );
      if (hasToolCall) {
        const hasToolResult = result.messages.some(m => m.role === 'tool');
        expect(hasToolResult).toBe(true);
      }
    });
  });
});

// ===========================================================================
// ConversationSummarizer
// ===========================================================================

describe('ConversationSummarizer', () => {
  it('should start with no summaries', () => {
    const summarizer = new ConversationSummarizer();
    expect(summarizer.getSummaryCount()).toBe(0);
  });

  it('should return messages as-is when under limit', () => {
    const summarizer = new ConversationSummarizer({ maxTokens: 100000 });
    summarizer.addMessage(userMsg('hello'));
    summarizer.addMessage(assistantMsg('hi'));
    const messages = summarizer.getMessages();
    expect(messages.length).toBe(2);
    expect(summarizer.getSummaryCount()).toBe(0);
  });

  it('should auto-summarize when exceeding token limit', () => {
    const summarizer = new ConversationSummarizer({
      maxTokens: 200,
      preserveRecent: 3,
    });
    // Add enough messages to exceed the token limit
    for (let i = 0; i < 20; i++) {
      summarizer.addMessage(userMsg(`Message ${i}: ${'x'.repeat(50)}`));
    }
    expect(summarizer.getSummaryCount()).toBeGreaterThan(0);
  });

  it('should keep only recent messages after summarization', () => {
    const summarizer = new ConversationSummarizer({
      maxTokens: 200,
      preserveRecent: 3,
    });
    for (let i = 0; i < 20; i++) {
      summarizer.addMessage(userMsg(`Message ${i}: ${'x'.repeat(50)}`));
    }
    const messages = summarizer.getMessages();
    // Should have summary system message + recent messages
    const nonSystemMessages = messages.filter(m =>
      m.role !== 'system' || !(m.content as string).includes('Previous conversation summaries')
    );
    // Recent messages should be preserved
    expect(nonSystemMessages.length).toBeLessThanOrEqual(5);
  });

  it('should include summaries as system message', () => {
    const summarizer = new ConversationSummarizer({
      maxTokens: 200,
      preserveRecent: 3,
    });
    for (let i = 0; i < 20; i++) {
      summarizer.addMessage(userMsg(`Message ${i}: ${'x'.repeat(50)}`));
    }
    const messages = summarizer.getMessages();
    const summaryMsg = messages.find(
      m => m.role === 'system' && (m.content as string).includes('Previous conversation summaries')
    );
    expect(summaryMsg).toBeDefined();
  });

  it('should addMessages in bulk', () => {
    const summarizer = new ConversationSummarizer({ maxTokens: 100000 });
    summarizer.addMessages([
      userMsg('hello'),
      assistantMsg('hi'),
      userMsg('how are you?'),
    ]);
    const messages = summarizer.getMessages();
    expect(messages.length).toBe(3);
  });

  it('should auto-summarize on addMessages when limit exceeded', () => {
    const summarizer = new ConversationSummarizer({
      maxTokens: 200,
      preserveRecent: 2,
    });
    const bulk = Array.from({ length: 20 }, (_, i) =>
      userMsg(`Bulk message ${i}: ${'x'.repeat(50)}`)
    );
    summarizer.addMessages(bulk);
    expect(summarizer.getSummaryCount()).toBeGreaterThan(0);
  });

  describe('clear', () => {
    it('should clear all summaries and messages', () => {
      const summarizer = new ConversationSummarizer({
        maxTokens: 200,
        preserveRecent: 3,
      });
      for (let i = 0; i < 20; i++) {
        summarizer.addMessage(userMsg(`Msg ${i}: ${'x'.repeat(50)}`));
      }
      expect(summarizer.getSummaryCount()).toBeGreaterThan(0);
      summarizer.clear();
      expect(summarizer.getSummaryCount()).toBe(0);
      expect(summarizer.getMessages()).toEqual([]);
    });
  });

  it('should accumulate multiple summaries over time', () => {
    const summarizer = new ConversationSummarizer({
      maxTokens: 200,
      preserveRecent: 2,
    });
    // First batch
    for (let i = 0; i < 15; i++) {
      summarizer.addMessage(userMsg(`Batch1-${i}: ${'x'.repeat(50)}`));
    }
    const countAfterFirst = summarizer.getSummaryCount();
    expect(countAfterFirst).toBeGreaterThan(0);

    // Second batch
    for (let i = 0; i < 15; i++) {
      summarizer.addMessage(userMsg(`Batch2-${i}: ${'x'.repeat(50)}`));
    }
    expect(summarizer.getSummaryCount()).toBeGreaterThanOrEqual(countAfterFirst);
  });
});

// ===========================================================================
// validateMessageHistory
// ===========================================================================

describe('validateMessageHistory', () => {
  it('should return messages unchanged when no tool calls', () => {
    const messages: LLMMessage[] = [
      userMsg('hello'),
      assistantMsg('hi'),
      userMsg('bye'),
    ];
    const result = validateMessageHistory(messages);
    expect(result).toEqual(messages);
  });

  it('should keep complete tool call/result pairs', () => {
    const messages: LLMMessage[] = [
      userMsg('Run a command'),
      assistantWithTools('Sure', [
        { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
      ]),
      toolResultMsg('tc1', 'file1.ts'),
      assistantMsg('Here are the files.'),
    ];
    const result = validateMessageHistory(messages);
    expect(result.length).toBe(4);
    expect(result[1].toolCalls).toBeDefined();
    expect(result[2].role).toBe('tool');
  });

  it('should strip orphaned tool calls (no matching result)', () => {
    const messages: LLMMessage[] = [
      userMsg('Run a command'),
      assistantWithTools('Sure, running.', [
        { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
      ]),
      // Missing tool result for tc1
      userMsg('What happened?'),
    ];
    const result = validateMessageHistory(messages);
    // The assistant message with orphaned tool call should have content preserved but no toolCalls
    const assistantResult = result.find(m => m.role === 'assistant');
    expect(assistantResult).toBeDefined();
    expect(assistantResult!.toolCalls).toBeUndefined();
    expect(assistantResult!.content).toBe('Sure, running.');
  });

  it('should drop orphaned tool results (no matching tool call)', () => {
    const messages: LLMMessage[] = [
      userMsg('hello'),
      toolResultMsg('tc_orphan', 'some result'),
      assistantMsg('hi'),
    ];
    const result = validateMessageHistory(messages);
    // The orphaned tool result should be dropped
    expect(result.find(m => m.role === 'tool')).toBeUndefined();
    expect(result.length).toBe(2);
  });

  it('should handle multiple tool calls in one assistant message', () => {
    const messages: LLMMessage[] = [
      userMsg('Run commands'),
      assistantWithTools('Running both', [
        { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
        { id: 'tc2', name: 'shell', arguments: { command: 'pwd' } },
      ]),
      toolResultMsg('tc1', 'file1.ts'),
      toolResultMsg('tc2', '/home/user'),
      assistantMsg('Done'),
    ];
    const result = validateMessageHistory(messages);
    expect(result.length).toBe(5);
  });

  it('should strip assistant tool calls when only some results are present', () => {
    const messages: LLMMessage[] = [
      userMsg('Run commands'),
      assistantWithTools('Running both', [
        { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
        { id: 'tc2', name: 'shell', arguments: { command: 'pwd' } },
      ]),
      toolResultMsg('tc1', 'file1.ts'),
      // Missing tc2 result
      assistantMsg('Partial results'),
    ];
    const result = validateMessageHistory(messages);
    // Since not ALL tool calls have results, the assistant message should be stripped
    const assistantWithToolResult = result.find(
      m => m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0
    );
    expect(assistantWithToolResult).toBeUndefined();
  });

  it('should drop assistant message entirely if it has tool calls but no text content', () => {
    const messages: LLMMessage[] = [
      userMsg('run something'),
      { role: 'assistant', content: '', toolCalls: [
        { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
      ]},
      // No tool result
      userMsg('what happened?'),
    ];
    const result = validateMessageHistory(messages);
    // Empty content assistant with orphaned tools should be dropped
    const assistants = result.filter(m => m.role === 'assistant');
    expect(assistants.length).toBe(0);
  });

  it('should handle empty message list', () => {
    const result = validateMessageHistory([]);
    expect(result).toEqual([]);
  });

  it('should handle system messages', () => {
    const messages: LLMMessage[] = [
      systemMsg('You are helpful'),
      userMsg('hello'),
      assistantMsg('hi'),
    ];
    const result = validateMessageHistory(messages);
    expect(result.length).toBe(3);
    expect(result[0].role).toBe('system');
  });

  it('should handle consecutive tool results for different tool calls', () => {
    const messages: LLMMessage[] = [
      userMsg('Do things'),
      assistantWithTools('Ok', [
        { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
        { id: 'tc2', name: 'read_file', arguments: { path: '/a.ts' } },
        { id: 'tc3', name: 'write_file', arguments: { path: '/b.ts' } },
      ]),
      toolResultMsg('tc1', 'result1'),
      toolResultMsg('tc2', 'result2'),
      toolResultMsg('tc3', 'result3'),
    ];
    const result = validateMessageHistory(messages);
    expect(result.length).toBe(5);
    expect(result.filter(m => m.role === 'tool').length).toBe(3);
  });

  it('should clear pending tool IDs when a non-tool message appears', () => {
    const messages: LLMMessage[] = [
      userMsg('Do something'),
      assistantWithTools('Ok', [
        { id: 'tc1', name: 'shell', arguments: { command: 'ls' } },
      ]),
      toolResultMsg('tc1', 'result'),
      userMsg('Great'),
      // Orphaned tool result after a user message
      toolResultMsg('tc1', 'late result'),
    ];
    const result = validateMessageHistory(messages);
    // The late tool result should be dropped since pending IDs were cleared by user msg
    const toolResults = result.filter(m => m.role === 'tool');
    expect(toolResults.length).toBe(1);
  });
});
