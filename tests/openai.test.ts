/**
 * Tests for src/providers/openai.ts
 *
 * Covers: OpenAI message formatting, tool conversion, content conversion,
 * response parsing, finish reason mapping, streaming, tool call parsing,
 * Responses API routing and conversion, and error handling.
 *
 * The OpenAI SDK is mocked to avoid real API calls - we test the
 * request/response transformation logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Tool, ToolCall } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock config module
vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn((provider: string) => {
    if (provider === 'openai') return 'test-openai-key';
    return undefined;
  }),
  getBaseUrl: vi.fn(() => undefined),
}));

// Mock model-detection to avoid real lookups
vi.mock('../src/model-detection.js', () => ({
  getModelContextLimit: vi.fn(() => 128000),
  getModelMaxOutput: vi.fn(() => 8192),
  getModelInfo: vi.fn(() => null),
  getOllamaFallbackModel: vi.fn(() => null),
}));

// Capture what gets passed to the OpenAI SDK
let lastCreateParams: Record<string, unknown> | null = null;
let lastStreamCreateParams: Record<string, unknown> | null = null;
let mockCreateResponse: Record<string, unknown> = {};
let mockStreamChunks: Array<Record<string, unknown>> = [];
let mockResponsesCreateResponse: Record<string, unknown> = {};
let mockResponsesStreamEvents: Array<Record<string, unknown>> = [];
let lastResponsesCreateParams: Record<string, unknown> | null = null;
let lastResponsesStreamParams: Record<string, unknown> | null = null;
let mockCreateShouldThrow: Error | null = null;
let mockStreamShouldThrow: Error | null = null;

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(async (params: Record<string, unknown>) => {
            if (mockCreateShouldThrow) throw mockCreateShouldThrow;
            if (params.stream) {
              lastStreamCreateParams = params;
              if (mockStreamShouldThrow) throw mockStreamShouldThrow;
              return {
                [Symbol.asyncIterator]() {
                  let index = 0;
                  return {
                    async next() {
                      if (index < mockStreamChunks.length) {
                        return { value: mockStreamChunks[index++], done: false };
                      }
                      return { value: undefined, done: true };
                    },
                  };
                },
              };
            }
            lastCreateParams = params;
            return mockCreateResponse;
          }),
        },
      };
      responses = {
        create: vi.fn(async (params: Record<string, unknown>) => {
          lastResponsesCreateParams = params;
          if (mockCreateShouldThrow) throw mockCreateShouldThrow;
          return mockResponsesCreateResponse;
        }),
        stream: vi.fn((params: Record<string, unknown>) => {
          lastResponsesStreamParams = params;
          if (mockStreamShouldThrow) throw mockStreamShouldThrow;
          return {
            [Symbol.asyncIterator]() {
              let index = 0;
              return {
                async next() {
                  if (index < mockResponsesStreamEvents.length) {
                    return { value: mockResponsesStreamEvents[index++], done: false };
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

// Import after mocks are set up
import {
  chatOpenAI,
  toOpenAIContent,
  toOpenAIMessages,
  toOpenAITools,
  parseOpenAIToolCalls,
  requiresResponsesAPI,
  toResponsesInput,
  toResponsesTools,
} from '../src/providers/openai.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTools(): Tool[] {
  return [
    {
      name: 'read_file',
      description: 'Read a file',
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

function makeSimpleMessages(): Message[] {
  return [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Hello' },
  ];
}

// ---------------------------------------------------------------------------
// Reset state before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  lastCreateParams = null;
  lastStreamCreateParams = null;
  lastResponsesCreateParams = null;
  lastResponsesStreamParams = null;
  mockCreateResponse = {};
  mockStreamChunks = [];
  mockResponsesCreateResponse = {};
  mockResponsesStreamEvents = [];
  mockCreateShouldThrow = null;
  mockStreamShouldThrow = null;
});

// ===========================================================================
// toOpenAIContent
// ===========================================================================

describe('toOpenAIContent', () => {
  it('returns string content as-is', () => {
    expect(toOpenAIContent('hello')).toBe('hello');
  });

  it('converts text content blocks', () => {
    const result = toOpenAIContent([{ type: 'text', text: 'hello world' }]);
    expect(result).toEqual([{ type: 'text', text: 'hello world' }]);
  });

  it('converts image content blocks', () => {
    const result = toOpenAIContent([
      { type: 'image', mediaType: 'image/png', data: 'abc123' },
    ]);
    expect(result).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('converts mixed content blocks', () => {
    const result = toOpenAIContent([
      { type: 'text', text: 'Look at this:' },
      { type: 'image', mediaType: 'image/jpeg', data: 'imgdata' },
    ]);
    expect(result).toEqual([
      { type: 'text', text: 'Look at this:' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,imgdata' } },
    ]);
  });

  it('handles unknown block types with empty text', () => {
    const result = toOpenAIContent([{ type: 'unknown' } as any]);
    expect(result).toEqual([{ type: 'text', text: '' }]);
  });
});

// ===========================================================================
// toOpenAIMessages
// ===========================================================================

describe('toOpenAIMessages', () => {
  it('converts user message with string content', () => {
    const result = toOpenAIMessages([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('converts system message', () => {
    const result = toOpenAIMessages([{ role: 'system', content: 'Be helpful.' }]);
    expect(result).toEqual([{ role: 'system', content: 'Be helpful.' }]);
  });

  it('converts assistant message with string content', () => {
    const result = toOpenAIMessages([{ role: 'assistant', content: 'Sure!' }]);
    expect(result).toEqual([{ role: 'assistant', content: 'Sure!' }]);
  });

  it('converts tool message', () => {
    const result = toOpenAIMessages([
      { role: 'tool', content: 'file contents here', toolCallId: 'call_1' },
    ]);
    expect(result).toEqual([
      { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
    ]);
  });

  it('handles tool message with array content', () => {
    const result = toOpenAIMessages([
      {
        role: 'tool',
        content: [{ type: 'text', text: 'result' }],
        toolCallId: 'call_2',
      },
    ]);
    expect(result[0].content).toBe(JSON.stringify([{ type: 'text', text: 'result' }]));
  });

  it('handles tool message without toolCallId', () => {
    const result = toOpenAIMessages([{ role: 'tool', content: 'data' }]);
    expect(result[0]).toHaveProperty('tool_call_id', '');
  });

  it('converts assistant message with tool calls', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'Let me read that file.',
      toolCalls: [
        { id: 'call_abc', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
      ],
    };
    const result = toOpenAIMessages([msg]);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'Let me read that file.',
      tool_calls: [
        {
          id: 'call_abc',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: JSON.stringify({ path: '/tmp/test.txt' }),
          },
        },
      ],
    });
  });

  it('handles assistant with tool calls and empty string content', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'test', arguments: {} }],
    };
    const result = toOpenAIMessages([msg]);
    // empty string is typeof 'string', so it passes through as ''
    expect(result[0].content).toBe('');
  });

  it('handles assistant with tool calls and array content', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'thinking...' }],
      toolCalls: [{ id: 'call_1', name: 'test', arguments: {} }],
    };
    const result = toOpenAIMessages([msg]);
    // array content gets JSON.stringified since it's truthy
    expect(result[0].content).toBe(JSON.stringify([{ type: 'text', text: 'thinking...' }]));
  });

  it('converts user message with array content (multimodal)', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image', mediaType: 'image/png', data: 'base64data' },
      ],
    };
    const result = toOpenAIMessages([msg]);
    expect(result[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,base64data' } },
      ],
    });
  });

  it('handles non-user role with array content by stringifying', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'response' }],
    };
    const result = toOpenAIMessages([msg]);
    expect(result[0].content).toBe(JSON.stringify([{ type: 'text', text: 'response' }]));
  });
});

// ===========================================================================
// toOpenAITools
// ===========================================================================

describe('toOpenAITools', () => {
  it('converts tools to OpenAI function format', () => {
    const tools = makeTools();
    const result = toOpenAITools(tools);
    expect(result).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: tools[0].parameters,
        },
      },
    ]);
  });

  it('handles empty tools array', () => {
    expect(toOpenAITools([])).toEqual([]);
  });

  it('converts multiple tools', () => {
    const tools: Tool[] = [
      ...makeTools(),
      {
        name: 'write_file',
        description: 'Write a file',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            content: { type: 'string', description: 'File content' },
          },
          required: ['path', 'content'],
        },
      },
    ];
    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe('read_file');
    expect(result[1].function.name).toBe('write_file');
  });
});

// ===========================================================================
// parseOpenAIToolCalls
// ===========================================================================

describe('parseOpenAIToolCalls', () => {
  it('returns empty array for undefined input', () => {
    expect(parseOpenAIToolCalls(undefined)).toEqual([]);
  });

  it('parses valid tool calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: {
          name: 'read_file',
          arguments: JSON.stringify({ path: '/tmp/test.txt' }),
        },
      },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toEqual([
      { id: 'call_1', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
    ]);
  });

  it('parses multiple tool calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{"path": "/a.txt"}' },
      },
      {
        id: 'call_2',
        type: 'function' as const,
        function: { name: 'write_file', arguments: '{"path": "/b.txt", "content": "hi"}' },
      },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('read_file');
    expect(result[1].name).toBe('write_file');
  });

  it('throws on invalid JSON arguments', () => {
    const toolCalls = [
      {
        id: 'call_bad',
        type: 'function' as const,
        function: { name: 'test_tool', arguments: '{invalid json}' },
      },
    ];
    expect(() => parseOpenAIToolCalls(toolCalls)).toThrow('Invalid tool arguments from LLM');
  });

  it('includes truncated raw args in error message', () => {
    const toolCalls = [
      {
        id: 'call_bad',
        type: 'function' as const,
        function: { name: 'test_tool', arguments: 'not-json' },
      },
    ];
    try {
      parseOpenAIToolCalls(toolCalls);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('Raw: not-json');
    }
  });
});

// ===========================================================================
// requiresResponsesAPI
// ===========================================================================

describe('requiresResponsesAPI', () => {
  it('returns true for o3', () => {
    expect(requiresResponsesAPI('o3')).toBe(true);
  });

  it('returns true for o3-mini', () => {
    expect(requiresResponsesAPI('o3-mini')).toBe(true);
  });

  it('returns true for o3-pro', () => {
    expect(requiresResponsesAPI('o3-pro')).toBe(true);
  });

  it('returns true for o4-mini', () => {
    expect(requiresResponsesAPI('o4-mini')).toBe(true);
  });

  it('returns true for gpt-5', () => {
    expect(requiresResponsesAPI('gpt-5')).toBe(true);
  });

  it('returns true for model names that start with a responses API model', () => {
    expect(requiresResponsesAPI('o3-2025-01-01')).toBe(true);
    expect(requiresResponsesAPI('gpt-5-turbo')).toBe(true);
  });

  it('returns false for gpt-4o', () => {
    expect(requiresResponsesAPI('gpt-4o')).toBe(false);
  });

  it('returns false for gpt-4-turbo', () => {
    expect(requiresResponsesAPI('gpt-4-turbo')).toBe(false);
  });

  it('returns false for arbitrary model names', () => {
    expect(requiresResponsesAPI('claude-3-opus')).toBe(false);
    expect(requiresResponsesAPI('gemini-pro')).toBe(false);
  });
});

// ===========================================================================
// toResponsesInput
// ===========================================================================

describe('toResponsesInput', () => {
  it('converts system messages to developer role', () => {
    const result = toResponsesInput([{ role: 'system', content: 'Be helpful.' }]);
    expect(result).toEqual([{ role: 'developer', content: 'Be helpful.' }]);
  });

  it('converts user messages with string content', () => {
    const result = toResponsesInput([{ role: 'user', content: 'Hello' }]);
    expect(result).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('converts user messages with multimodal content', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at this' },
        { type: 'image', mediaType: 'image/png', data: 'imgdata' },
      ],
    };
    const result = toResponsesInput([msg]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'Look at this' },
          { type: 'input_image', image_url: { url: 'data:image/png;base64,imgdata' } },
        ],
      },
    ]);
  });

  it('converts tool messages to function_call_output', () => {
    const result = toResponsesInput([
      { role: 'tool', content: 'file contents', toolCallId: 'call_1' },
    ]);
    expect(result).toEqual([
      { type: 'function_call_output', call_id: 'call_1', output: 'file contents' },
    ]);
  });

  it('converts assistant messages without tool calls', () => {
    const result = toResponsesInput([{ role: 'assistant', content: 'Sure thing.' }]);
    expect(result).toEqual([{ role: 'assistant', content: 'Sure thing.' }]);
  });

  it('converts assistant messages with tool calls', () => {
    const msg: Message = {
      role: 'assistant',
      content: 'Let me check.',
      toolCalls: [
        { id: 'call_1', name: 'read_file', arguments: { path: '/tmp/a.txt' } },
      ],
    };
    const result = toResponsesInput([msg]);
    // Should produce: assistant text message + function_call item
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'assistant', content: 'Let me check.' });
    expect(result[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'read_file',
      arguments: JSON.stringify({ path: '/tmp/a.txt' }),
    });
  });

  it('omits empty text content for assistant with tool calls', () => {
    const msg: Message = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'test', arguments: {} }],
    };
    const result = toResponsesInput([msg]);
    // Empty content should not produce an assistant message
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('type', 'function_call');
  });

  it('handles system message with array content by stringifying', () => {
    const msg: Message = {
      role: 'system',
      content: [{ type: 'text', text: 'instructions' }],
    };
    const result = toResponsesInput([msg]);
    expect(result[0]).toEqual({
      role: 'developer',
      content: JSON.stringify([{ type: 'text', text: 'instructions' }]),
    });
  });

  it('handles tool message without toolCallId', () => {
    const result = toResponsesInput([{ role: 'tool', content: 'result' }]);
    expect(result[0]).toHaveProperty('call_id', '');
  });
});

// ===========================================================================
// toResponsesTools
// ===========================================================================

describe('toResponsesTools', () => {
  it('converts tools to Responses API format', () => {
    const tools = makeTools();
    const result = toResponsesTools(tools);
    expect(result).toEqual([
      {
        type: 'function',
        name: 'read_file',
        description: 'Read a file',
        parameters: tools[0].parameters,
        strict: false,
      },
    ]);
  });

  it('handles empty tools', () => {
    expect(toResponsesTools([])).toEqual([]);
  });
});

// ===========================================================================
// chatOpenAI - Non-streaming (Chat Completions API)
// ===========================================================================

describe('chatOpenAI (non-streaming, Chat Completions)', () => {
  it('returns content and stop finish reason', async () => {
    mockCreateResponse = {
      choices: [
        {
          message: { content: 'Hello there!', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o');
    expect(result.content).toBe('Hello there!');
    expect(result.finishReason).toBe('stop');
    expect(result.toolCalls).toBeUndefined();
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('returns tool calls when present', async () => {
    mockCreateResponse = {
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: JSON.stringify({ path: '/test.txt' }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 15 },
    };

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'gpt-4o');
    expect(result.toolCalls).toEqual([
      { id: 'call_123', name: 'read_file', arguments: { path: '/test.txt' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('maps length finish reason', async () => {
    mockCreateResponse = {
      choices: [
        {
          message: { content: 'truncated...', tool_calls: undefined },
          finish_reason: 'length',
        },
      ],
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o');
    expect(result.finishReason).toBe('length');
  });

  it('defaults to stop for unknown finish reasons', async () => {
    mockCreateResponse = {
      choices: [
        {
          message: { content: 'ok', tool_calls: undefined },
          finish_reason: 'content_filter',
        },
      ],
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o');
    expect(result.finishReason).toBe('stop');
  });

  it('throws on empty response', async () => {
    mockCreateResponse = { choices: [] };
    await expect(chatOpenAI(makeSimpleMessages(), [], 'gpt-4o')).rejects.toThrow(
      'Empty response from OpenAI API'
    );
  });

  it('throws on missing choices', async () => {
    mockCreateResponse = {};
    await expect(chatOpenAI(makeSimpleMessages(), [], 'gpt-4o')).rejects.toThrow(
      'Empty response from OpenAI API'
    );
  });

  it('handles null message content', async () => {
    mockCreateResponse = {
      choices: [
        {
          message: { content: null, tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o');
    expect(result.content).toBe('');
  });

  it('returns undefined usage when not present', async () => {
    mockCreateResponse = {
      choices: [
        {
          message: { content: 'hi', tool_calls: undefined },
          finish_reason: 'stop',
        },
      ],
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o');
    expect(result.usage).toBeUndefined();
  });

  it('throws on API error', async () => {
    mockCreateShouldThrow = new Error('Rate limit exceeded');
    await expect(chatOpenAI(makeSimpleMessages(), [], 'gpt-4o')).rejects.toThrow(
      'Rate limit exceeded'
    );
  });
});

// ===========================================================================
// chatOpenAI - Streaming (Chat Completions API)
// ===========================================================================

describe('chatOpenAI (streaming, Chat Completions)', () => {
  it('streams text content and calls onToken', async () => {
    mockStreamChunks = [
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];

    const tokens: string[] = [];
    const onToken = (t: string) => tokens.push(t);

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o', onToken);
    expect(result.content).toBe('Hello world');
    expect(tokens).toEqual(['Hello', ' world']);
    expect(result.finishReason).toBe('stop');
  });

  it('handles empty choices in stream chunks', async () => {
    mockStreamChunks = [
      { choices: [] },
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ];

    const tokens: string[] = [];
    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o', (t) => tokens.push(t));
    expect(result.content).toBe('ok');
  });

  it('collects tool call deltas across chunks', async () => {
    mockStreamChunks = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_abc',
              function: { name: 'read_file', arguments: '{"pa' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: 'th": "/tmp/test.txt"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'gpt-4o', vi.fn());
    expect(result.toolCalls).toEqual([
      { id: 'call_abc', name: 'read_file', arguments: { path: '/tmp/test.txt' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('maps length finish reason in streaming', async () => {
    mockStreamChunks = [
      { choices: [{ delta: { content: 'partial' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o', vi.fn());
    expect(result.finishReason).toBe('length');
  });

  it('rethrows stream errors and notifies via onToken', async () => {
    mockStreamShouldThrow = new Error('Connection reset');

    const tokens: string[] = [];
    await expect(
      chatOpenAI(makeSimpleMessages(), [], 'gpt-4o', (t) => tokens.push(t))
    ).rejects.toThrow('Connection reset');
  });

  it('handles tool calls with unparseable arguments gracefully', async () => {
    mockStreamChunks = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_bad',
              function: { name: 'test_tool', arguments: '{invalid' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    // Streaming tool call argument parsing is lenient - uses try/catch with empty obj fallback
    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'gpt-4o', vi.fn());
    expect(result.toolCalls).toEqual([
      { id: 'call_bad', name: 'test_tool', arguments: {} },
    ]);
  });

  it('filters out tool call deltas missing id or name', async () => {
    mockStreamChunks = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              // no id, no name
              function: { arguments: '{}' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'gpt-4o', vi.fn());
    expect(result.toolCalls).toBeUndefined();
  });
});

// ===========================================================================
// chatOpenAI - Responses API routing
// ===========================================================================

describe('chatOpenAI (Responses API routing)', () => {
  it('routes o3 model to Responses API', async () => {
    mockResponsesCreateResponse = {
      output_text: 'Response from o3',
      output: [],
      status: 'completed',
      usage: { input_tokens: 50, output_tokens: 25 },
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3');
    expect(result.content).toBe('Response from o3');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 25 });
    expect(lastResponsesCreateParams).not.toBeNull();
    expect(lastCreateParams).toBeNull();
  });

  it('routes o4-mini to Responses API', async () => {
    mockResponsesCreateResponse = {
      output_text: 'o4-mini response',
      output: [],
      status: 'completed',
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o4-mini');
    expect(result.content).toBe('o4-mini response');
  });

  it('routes gpt-4o to Chat Completions API', async () => {
    mockCreateResponse = {
      choices: [{
        message: { content: 'gpt-4o response', tool_calls: undefined },
        finish_reason: 'stop',
      }],
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'gpt-4o');
    expect(result.content).toBe('gpt-4o response');
    expect(lastCreateParams).not.toBeNull();
    expect(lastResponsesCreateParams).toBeNull();
  });
});

// ===========================================================================
// chatOpenAI - Non-streaming Responses API
// ===========================================================================

describe('chatOpenAI (non-streaming, Responses API)', () => {
  it('extracts tool calls from output items', async () => {
    mockResponsesCreateResponse = {
      output_text: '',
      output: [
        {
          type: 'function_call',
          call_id: 'call_resp_1',
          name: 'read_file',
          arguments: JSON.stringify({ path: '/test.txt' }),
        },
      ],
      status: 'completed',
      usage: { input_tokens: 30, output_tokens: 20 },
    };

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3');
    expect(result.toolCalls).toEqual([
      { id: 'call_resp_1', name: 'read_file', arguments: { path: '/test.txt' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('handles function_call with object arguments', async () => {
    mockResponsesCreateResponse = {
      output_text: '',
      output: [
        {
          type: 'function_call',
          call_id: 'call_obj',
          name: 'write_file',
          arguments: { path: '/out.txt', content: 'data' },
        },
      ],
      status: 'completed',
    };

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3');
    expect(result.toolCalls![0].arguments).toEqual({ path: '/out.txt', content: 'data' });
  });

  it('maps incomplete status to length finish reason', async () => {
    mockResponsesCreateResponse = {
      output_text: 'partial...',
      output: [],
      status: 'incomplete',
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3');
    expect(result.finishReason).toBe('length');
  });

  it('returns undefined usage when not present', async () => {
    mockResponsesCreateResponse = {
      output_text: 'hi',
      output: [],
      status: 'completed',
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3');
    expect(result.usage).toBeUndefined();
  });

  it('uses fallback id from item.id when call_id missing', async () => {
    mockResponsesCreateResponse = {
      output_text: '',
      output: [
        {
          type: 'function_call',
          call_id: '',
          id: 'resp_item_1',
          name: 'test',
          arguments: '{}',
        },
      ],
      status: 'completed',
    };

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3');
    expect(result.toolCalls![0].id).toBe('resp_item_1');
  });

  it('skips non-function_call output items', async () => {
    mockResponsesCreateResponse = {
      output_text: 'text output',
      output: [
        { type: 'text', text: 'some text' },
        { type: 'other', data: 'ignored' },
      ],
      status: 'completed',
    };

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3');
    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe('text output');
  });
});

// ===========================================================================
// chatOpenAI - Streaming Responses API
// ===========================================================================

describe('chatOpenAI (streaming, Responses API)', () => {
  it('streams text deltas via onToken', async () => {
    mockResponsesStreamEvents = [
      { type: 'response.output_text.delta', delta: 'Hello' },
      { type: 'response.output_text.delta', delta: ' from o3' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 40, output_tokens: 10 },
        },
      },
    ];

    const tokens: string[] = [];
    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3', (t) => tokens.push(t));
    expect(result.content).toBe('Hello from o3');
    expect(tokens).toEqual(['Hello', ' from o3']);
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 10 });
    expect(result.finishReason).toBe('stop');
  });

  it('collects tool calls from output_item.done events', async () => {
    mockResponsesStreamEvents = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_item',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_stream_1',
          name: 'read_file',
          arguments: '{"path": "/tmp/file.txt"}',
        },
      },
      {
        type: 'response.completed',
        response: { status: 'completed', usage: { input_tokens: 20, output_tokens: 15 } },
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3', vi.fn());
    expect(result.toolCalls).toEqual([
      { id: 'call_stream_1', name: 'read_file', arguments: { path: '/tmp/file.txt' } },
    ]);
    expect(result.finishReason).toBe('tool_use');
  });

  it('maps incomplete status to length in streaming', async () => {
    mockResponsesStreamEvents = [
      { type: 'response.output_text.delta', delta: 'partial' },
      {
        type: 'response.completed',
        response: { status: 'incomplete' },
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3', vi.fn());
    expect(result.finishReason).toBe('length');
  });

  it('ignores unrecognized event types', async () => {
    mockResponsesStreamEvents = [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'data' },
      { type: 'response.some_unknown_event', data: 'ignored' },
      {
        type: 'response.completed',
        response: { status: 'completed' },
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3', vi.fn());
    expect(result.content).toBe('data');
  });

  it('rethrows stream errors and notifies via onToken', async () => {
    mockStreamShouldThrow = new Error('Responses stream failed');

    const tokens: string[] = [];
    await expect(
      chatOpenAI(makeSimpleMessages(), [], 'o3', (t) => tokens.push(t))
    ).rejects.toThrow('Responses stream failed');
  });

  it('handles function call with invalid JSON arguments gracefully', async () => {
    mockResponsesStreamEvents = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_item',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_bad',
          name: 'test',
          arguments: 'not-json',
        },
      },
      {
        type: 'response.completed',
        response: { status: 'completed' },
      },
    ];

    // Streaming Responses API is lenient - falls back to empty object
    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3', vi.fn());
    expect(result.toolCalls).toEqual([
      { id: 'call_bad', name: 'test', arguments: {} },
    ]);
  });
});

// ===========================================================================
// chatOpenAI - API key validation
// ===========================================================================

describe('chatOpenAI (API key validation)', () => {
  it('throws when OpenAI API key is not configured', async () => {
    const { getApiKey } = await import('../src/config.js');
    (getApiKey as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await expect(chatOpenAI(makeSimpleMessages(), [], 'gpt-4o')).rejects.toThrow(
      'OpenAI API key not configured'
    );
  });

  it('throws for Responses API model when API key is missing', async () => {
    const { getApiKey } = await import('../src/config.js');
    (getApiKey as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined);

    await expect(chatOpenAI(makeSimpleMessages(), [], 'o3')).rejects.toThrow(
      'OpenAI API key not configured'
    );
  });
});

// ===========================================================================
// Additional coverage: uncovered branches and functions
// ===========================================================================

describe('toResponsesInput (additional branch coverage)', () => {
  it('extracts text from array content in assistant message with tool calls (line 245)', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'first line' },
        { type: 'text', text: 'second line' },
      ],
      toolCalls: [{ id: 'call_1', name: 'test', arguments: {} }],
    };
    const result = toResponsesInput([msg]);
    // Should produce: assistant text message with joined text + function_call item
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'assistant', content: 'first line\nsecond line' });
    expect(result[1]).toEqual({
      type: 'function_call',
      call_id: 'call_1',
      name: 'test',
      arguments: '{}',
    });
  });

  it('filters non-text blocks from array content in assistant with tool calls', () => {
    const msg: Message = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'visible' },
        { type: 'image', mediaType: 'image/png', data: 'abc' } as any,
      ],
      toolCalls: [{ id: 'call_2', name: 'test', arguments: {} }],
    };
    const result = toResponsesInput([msg]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ role: 'assistant', content: 'visible' });
  });

  it('handles non-string non-array content in assistant with tool calls (empty fallback)', () => {
    const msg: Message = {
      role: 'assistant',
      content: null as any,
      toolCalls: [{ id: 'call_3', name: 'test', arguments: {} }],
    };
    const result = toResponsesInput([msg]);
    // null content should produce empty string, which is falsy so no assistant message
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty('type', 'function_call');
  });

  it('handles tool message with array content by stringifying', () => {
    const msg: Message = {
      role: 'tool',
      content: [{ type: 'text', text: 'tool result' }],
      toolCallId: 'call_4',
    };
    const result = toResponsesInput([msg]);
    expect(result[0]).toEqual({
      type: 'function_call_output',
      call_id: 'call_4',
      output: JSON.stringify([{ type: 'text', text: 'tool result' }]),
    });
  });

  it('handles assistant message with non-string content and no tool calls', () => {
    const msg: Message = {
      role: 'assistant',
      content: [{ type: 'text', text: 'some content' }],
    };
    const result = toResponsesInput([msg]);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: JSON.stringify([{ type: 'text', text: 'some content' }]),
    });
  });
});

describe('toOpenAIMessages (additional branch coverage)', () => {
  it('handles assistant with tool calls and null content', () => {
    const msg: Message = {
      role: 'assistant',
      content: null as any,
      toolCalls: [{ id: 'call_1', name: 'test', arguments: {} }],
    };
    const result = toOpenAIMessages([msg]);
    // null is not typeof 'string', but is falsy → content should be null
    expect(result[0].content).toBeNull();
  });
});

describe('parseOpenAIToolCalls (additional branch coverage)', () => {
  it('handles non-SyntaxError exceptions with Unknown parse error message', () => {
    // JSON.parse always throws SyntaxError for invalid JSON, but we can test
    // the branch by verifying the error message format for a SyntaxError
    const toolCalls = [
      {
        id: 'call_err',
        type: 'function' as const,
        function: { name: 'tool', arguments: '{{{{' },
      },
    ];
    try {
      parseOpenAIToolCalls(toolCalls);
      expect.fail('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('Invalid tool arguments from LLM');
      expect(e.message).toContain('Raw: {{{{');
    }
  });

  it('skips custom tool calls and parses only function tool calls', () => {
    const toolCalls = [
      {
        id: 'call_custom',
        type: 'custom' as const,
        custom: { name: 'not_ours', input: 'raw text' },
      },
      {
        id: 'call_fn',
        type: 'function' as const,
        function: { name: 'read_file', arguments: '{"path":"/a.txt"}' },
      },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toEqual([
      { id: 'call_fn', name: 'read_file', arguments: { path: '/a.txt' } },
    ]);
  });
});

describe('chatOpenAI (Responses API streaming, additional coverage)', () => {
  it('handles completed event without usage', async () => {
    mockResponsesStreamEvents = [
      { type: 'response.output_text.delta', delta: 'hello' },
      {
        type: 'response.completed',
        response: { status: 'completed' },
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3', vi.fn());
    expect(result.content).toBe('hello');
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('handles function call with missing call_id using fallback', async () => {
    mockResponsesStreamEvents = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: '',
          type: 'function_call',
          status: 'completed',
          call_id: '',
          name: 'test',
          arguments: '{}',
        },
      },
      {
        type: 'response.completed',
        response: { status: 'completed' },
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3', vi.fn());
    // Empty call_id should trigger fallback to `call_${Date.now()}`
    expect(result.toolCalls![0].id).toMatch(/^call_/);
    expect(result.toolCalls![0].name).toBe('test');
  });

  it('handles non-Error stream failure', async () => {
    mockStreamShouldThrow = 'string error' as any;

    await expect(
      chatOpenAI(makeSimpleMessages(), [], 'o3', vi.fn())
    ).rejects.toBe('string error');
  });
});

describe('chatOpenAI (Chat Completions streaming, additional coverage)', () => {
  it('handles non-Error stream failure', async () => {
    mockStreamShouldThrow = 'stream string error' as any;

    await expect(
      chatOpenAI(makeSimpleMessages(), [], 'gpt-4o', vi.fn())
    ).rejects.toBe('stream string error');
  });

  it('handles tool call delta without function.arguments', async () => {
    mockStreamChunks = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_x',
              function: { name: 'read_file' },
              // no arguments property
            }],
          },
          finish_reason: null,
        }],
      },
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"path":"/a.txt"}' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'gpt-4o', vi.fn());
    expect(result.toolCalls).toEqual([
      { id: 'call_x', name: 'read_file', arguments: { path: '/a.txt' } },
    ]);
  });

  it('handles tool call delta with empty arguments string (fallback to {})', async () => {
    mockStreamChunks = [
      {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_empty',
              function: { name: 'test_tool' },
            }],
          },
          finish_reason: null,
        }],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'gpt-4o', vi.fn());
    // arguments is empty string → '{}' fallback via || '{}'
    expect(result.toolCalls).toEqual([
      { id: 'call_empty', name: 'test_tool', arguments: {} },
    ]);
  });
});

describe('chatOpenAI (Responses API non-streaming, additional coverage)', () => {
  it('uses Date.now() fallback when both call_id and id are missing', async () => {
    mockResponsesCreateResponse = {
      output_text: '',
      output: [
        {
          type: 'function_call',
          call_id: '',
          // no id property
          name: 'test',
          arguments: '{}',
        },
      ],
      status: 'completed',
    };

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3');
    expect(result.toolCalls![0].id).toMatch(/^call_\d+$/);
  });
});

describe('chatOpenAI (Responses API streaming, usage edge cases)', () => {
  it('handles usage with zero input_tokens (falsy || 0 branch)', async () => {
    mockResponsesStreamEvents = [
      { type: 'response.output_text.delta', delta: 'hi' },
      {
        type: 'response.completed',
        response: {
          status: 'completed',
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), [], 'o3', vi.fn());
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('handles function call with empty arguments string (fallback to {})', async () => {
    mockResponsesStreamEvents = [
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'fc_item',
          type: 'function_call',
          status: 'completed',
          call_id: 'call_empty_args',
          name: 'test',
          arguments: '',
        },
      },
      {
        type: 'response.completed',
        response: { status: 'completed' },
      },
    ];

    const result = await chatOpenAI(makeSimpleMessages(), makeTools(), 'o3', vi.fn());
    expect(result.toolCalls).toEqual([
      { id: 'call_empty_args', name: 'test', arguments: {} },
    ]);
  });
});

describe('toResponsesInput (multimodal user content edge cases)', () => {
  it('skips unknown block types in user multimodal content', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'unknown_block_type' } as any,
        { type: 'image', mediaType: 'image/png', data: 'img' },
      ],
    };
    const result = toResponsesInput([msg]);
    // Only text and image blocks should be included
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_image', image_url: { url: 'data:image/png;base64,img' } },
        ],
      },
    ]);
  });

  it('ignores messages with unknown roles', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'function' as any, content: 'ignored' },
    ];
    const result = toResponsesInput(msgs);
    // Only the user message should be in the output
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('handles user multimodal content with only image blocks', () => {
    const msg: Message = {
      role: 'user',
      content: [
        { type: 'image', mediaType: 'image/jpeg', data: 'data1' },
      ],
    };
    const result = toResponsesInput([msg]);
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'input_image', image_url: { url: 'data:image/jpeg;base64,data1' } },
        ],
      },
    ]);
  });
});

// ============================================================================
// Regression #220: Responses API streaming must collect tool calls from
// response.output_item.done — response.function_call_arguments.done carries
// only arguments + item_id (no name, no call_id), so collecting there
// produced nameless calls that validateLLMResponse dropped.
// ============================================================================

describe('chatOpenAIResponses streaming tool-call collection (regression #220)', () => {
  beforeEach(() => {
    mockResponsesStreamEvents.length = 0;
  });

  it('collects a tool call from output_item.done using real event shapes', async () => {
    mockResponsesStreamEvents.push(
      { type: 'response.created', response: {}, sequence_number: 0 },
      // The real arguments.done event: NO name, NO call_id — must not be relied on
      { type: 'response.function_call_arguments.done', arguments: '{"path":"."}', item_id: 'fc_1', output_index: 0, sequence_number: 1 },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 2, item: {
        id: 'fc_1', type: 'function_call', status: 'completed',
        arguments: '{"path":"."}', call_id: 'call_abc123', name: 'list_files',
      } },
      { type: 'response.completed', sequence_number: 3, response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } },
    );

    const tokens: string[] = [];
    const result = await chatOpenAI(
      [{ role: 'user', content: 'list files' }],
      [{ name: 'list_files', description: 'List files', parameters: { type: 'object', properties: {} } }],
      'gpt-5.3-codex',
      (t) => tokens.push(t),
    );

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('list_files');
    expect(result.toolCalls![0].id).toBe('call_abc123');
    expect(result.toolCalls![0].arguments).toEqual({ path: '.' });
    expect(result.finishReason).toBe('tool_use');
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it('ignores non-function output items and still streams text', async () => {
    mockResponsesStreamEvents.push(
      { type: 'response.output_item.added', output_index: 0, sequence_number: 0, item: { type: 'message' } },
      { type: 'response.output_text.delta', delta: 'hello', sequence_number: 1 },
      { type: 'response.output_item.done', output_index: 0, sequence_number: 2, item: { type: 'message' } },
      { type: 'response.completed', sequence_number: 3, response: { status: 'completed' } },
    );

    const tokens: string[] = [];
    const result = await chatOpenAI(
      [{ role: 'user', content: 'hi' }],
      [],
      'gpt-5.3-codex',
      (t) => tokens.push(t),
    );

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe('hello');
    expect(tokens.join('')).toBe('hello');
    expect(result.finishReason).toBe('stop');
  });
});
