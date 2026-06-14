/**
 * Additional tests for src/providers/anthropic.ts
 *
 * Targets uncovered lines: 15, 31, 68, 186-189.
 * Covers: toAnthropicContent edge cases, array content with toolCalls,
 * and streaming error handling (catch block).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Tool } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn((provider: string) => {
    if (provider === 'anthropic') return 'test-anthropic-key';
    return undefined;
  }),
  getBaseUrl: vi.fn(() => undefined),
}));

vi.mock('../src/model-detection.js', () => ({
  getModelContextLimit: vi.fn(() => 200000),
  getModelMaxOutput: vi.fn(() => 8192),
  getModelInfo: vi.fn(() => null),
  getOllamaFallbackModel: vi.fn(() => null),
}));

let lastCreateParams: Record<string, unknown> | null = null;
let lastStreamParams: Record<string, unknown> | null = null;
let mockCreateResponse: Record<string, unknown> = {};
let mockStreamEvents: Array<Record<string, unknown>> = [];
let mockStreamShouldThrow: Error | null = null;

vi.mock('@anthropic-ai/sdk', () => {
  return {
    default: class MockAnthropic {
      messages = {
        create: vi.fn(async (params: Record<string, unknown>) => {
          lastCreateParams = params;
          return mockCreateResponse;
        }),
        stream: vi.fn(async (params: Record<string, unknown>) => {
          lastStreamParams = params;
          if (mockStreamShouldThrow) {
            throw mockStreamShouldThrow;
          }
          return {
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                async next() {
                  if (index < mockStreamEvents.length) {
                    return { value: mockStreamEvents[index++], done: false };
                  }
                  return { value: undefined, done: true };
                },
              };
            },
          };
        }),
      };
      constructor(_opts: Record<string, unknown>) {}
    },
  };
});

import { chatAnthropic } from '../src/providers/anthropic.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools(): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file from disk',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
        },
        required: ['path'],
      },
    },
  ];
}

function resetMocks() {
  lastCreateParams = null;
  lastStreamParams = null;
  mockStreamShouldThrow = null;
  mockCreateResponse = {
    content: [{ type: 'text', text: 'Hello from Claude!' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  mockStreamEvents = [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetMocks();
});

describe('chatAnthropic - uncovered lines', () => {

  // Line 31: unknown block type in toAnthropicContent -> fallback to { type: 'text', text: '' }
  describe('toAnthropicContent unknown block type (line 31)', () => {
    it('should produce empty text block for unknown content block types', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            // Force an unknown block type by casting
            { type: 'audio' as 'text', text: '' } as any,
          ],
        },
      ];

      await chatAnthropic(messages, [], 'claude-sonnet-4-20250514');

      const msgs = lastCreateParams!.messages as Array<Record<string, unknown>>;
      const content = msgs[0].content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: 'text', text: 'describe this' });
      // Unknown block type falls back to empty text
      expect(content[1]).toEqual({ type: 'text', text: '' });
    });
  });

  // Line 68: assistant message with toolCalls AND array content (not string)
  describe('assistant message with toolCalls and array content (line 68)', () => {
    it('should extract text from array content blocks when toolCalls are present', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'First part.' },
            { type: 'text', text: 'Second part.' },
          ],
          toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: { path: '/x' } }],
        },
        { role: 'tool', content: 'result', toolCallId: 'tc_1' },
      ];

      await chatAnthropic(messages, makeTools(), 'claude-sonnet-4-20250514');

      const msgs = lastCreateParams!.messages as Array<Record<string, unknown>>;
      const assistantMsg = msgs[1];
      expect(assistantMsg.role).toBe('assistant');
      const content = assistantMsg.content as Array<Record<string, unknown>>;
      // Should have joined text block + tool_use block
      expect(content).toHaveLength(2);
      expect(content[0]).toEqual({ type: 'text', text: 'First part.\nSecond part.' });
      expect(content[1]).toEqual({
        type: 'tool_use',
        id: 'tc_1',
        name: 'read_file',
        input: { path: '/x' },
      });
    });

    it('should handle array content with no text blocks when toolCalls present', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          // Array with no text blocks (e.g., only image blocks which get filtered out)
          content: [
            { type: 'image', mediaType: 'image/png' as const, data: 'abc' },
          ],
          toolCalls: [{ id: 'tc_2', name: 'read_file', arguments: { path: '/y' } }],
        },
        { role: 'tool', content: 'result', toolCallId: 'tc_2' },
      ];

      await chatAnthropic(messages, makeTools(), 'claude-sonnet-4-20250514');

      const msgs = lastCreateParams!.messages as Array<Record<string, unknown>>;
      const assistantMsg = msgs[1];
      const content = assistantMsg.content as Array<Record<string, unknown>>;
      // Empty text gets omitted, only tool_use
      expect(content).toHaveLength(1);
      expect(content[0].type).toBe('tool_use');
    });
  });

  // Lines 186-189: streaming error handler (catch block)
  describe('streaming error handling (lines 186-189)', () => {
    it('should call onToken with error message and rethrow when stream fails', async () => {
      mockStreamShouldThrow = new Error('Connection reset by peer');

      const tokens: string[] = [];
      const onToken = (token: string) => tokens.push(token);

      await expect(
        chatAnthropic(
          [{ role: 'user', content: 'hi' }],
          [],
          'claude-sonnet-4-20250514',
          onToken
        )
      ).rejects.toThrow('Connection reset by peer');

      // Verify onToken received the error message
      expect(tokens).toHaveLength(1);
      expect(tokens[0]).toContain('[Streaming error: Connection reset by peer]');
    });

    it('should handle non-Error stream failures', async () => {
      mockStreamShouldThrow = 'network failure' as unknown as Error;

      const tokens: string[] = [];
      const onToken = (token: string) => tokens.push(token);

      await expect(
        chatAnthropic(
          [{ role: 'user', content: 'hi' }],
          [],
          'claude-sonnet-4-20250514',
          onToken
        )
      ).rejects.toBe('network failure');

      // Non-Error values get String()'d
      expect(tokens[0]).toContain('[Streaming error: network failure]');
    });
  });

  // Additional edge cases for completeness
  describe('streaming edge cases', () => {
    it('should handle content_block_stop when no tool is being built', async () => {
      mockStreamEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_start', content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } },
        { type: 'content_block_stop' },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ];

      const tokens: string[] = [];
      const result = await chatAnthropic(
        [{ role: 'user', content: 'hi' }],
        [],
        'claude-sonnet-4-20250514',
        (t) => tokens.push(t)
      );

      expect(result.content).toBe('Hi');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should handle message_delta without usage', async () => {
      mockStreamEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ];

      const result = await chatAnthropic(
        [{ role: 'user', content: 'hi' }],
        [],
        'claude-sonnet-4-20250514',
        () => {}
      );

      expect(result.usage.outputTokens).toBe(0);
    });

    it('should pass tools as undefined to stream when no tools provided', async () => {
      mockStreamEvents = [
        { type: 'message_start', message: { usage: { input_tokens: 10 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      ];

      await chatAnthropic(
        [{ role: 'user', content: 'hi' }],
        [],
        'claude-sonnet-4-20250514',
        () => {}
      );

      expect(lastStreamParams!.tools).toBeUndefined();
    });
  });
});
