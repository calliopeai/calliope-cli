/**
 * Comprehensive tests for src/providers/google.ts
 *
 * Targets 100% coverage by testing all paths including:
 * - convertPropertyType: nested objects, arrays, enums
 * - Non-streaming: text, function calls, mixed, usageMetadata
 * - Streaming: text chunks, function calls, usageMetadata, error handling
 * - History building, multi-modal content, error paths
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Tool } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn((provider: string) => {
    if (provider === 'google') return 'test-google-key';
    return undefined;
  }),
  getBaseUrl: vi.fn(() => undefined),
}));

vi.mock('../src/model-detection.js', () => ({
  getModelContextLimit: vi.fn(() => 1000000),
  getModelMaxOutput: vi.fn(() => 8192),
  getModelInfo: vi.fn(() => null),
  getOllamaFallbackModel: vi.fn(() => null),
}));

// Track calls to the Gemini SDK
let capturedHistory: Array<Record<string, unknown>> = [];
let capturedSystemInstruction: string | undefined = undefined;
let capturedSendMessageArgs: unknown[] = [];
let capturedToolDeclarations: unknown[] = [];
let mockSendMessageResponse: Record<string, unknown> = {};
let mockSendMessageStreamResult: { stream: AsyncIterable<Record<string, unknown>> } | null = null;

// Helper to create an async iterable from an array of chunks
async function* mockStream(chunks: Record<string, unknown>[]) {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// Helper to create a stream that throws
async function* mockErrorStream(error: Error) {
  throw error;
  // Need at least one yield for TS to see this as a generator
  yield {} as never; // unreachable
}

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      constructor(_apiKey: string) {}
      getGenerativeModel(opts: Record<string, unknown>) {
        if (opts.tools) {
          const toolsArr = opts.tools as Array<{ functionDeclarations: unknown[] }>;
          capturedToolDeclarations = toolsArr[0]?.functionDeclarations || [];
        } else {
          capturedToolDeclarations = [];
        }
        return {
          startChat(chatOpts: Record<string, unknown>) {
            capturedHistory = (chatOpts.history || []) as Array<Record<string, unknown>>;
            capturedSystemInstruction = chatOpts.systemInstruction as string | undefined;
            return {
              async sendMessage(parts: unknown[]) {
                capturedSendMessageArgs = parts;
                return { response: mockSendMessageResponse };
              },
              async sendMessageStream(parts: unknown[]) {
                capturedSendMessageArgs = parts;
                if (mockSendMessageStreamResult) {
                  return mockSendMessageStreamResult;
                }
                // Default: empty stream
                return { stream: mockStream([]) };
              },
            };
          },
        };
      }
    },
  };
});

import { chatGoogle } from '../src/providers/google.js';

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

function resetMocks() {
  capturedHistory = [];
  capturedSystemInstruction = undefined;
  capturedSendMessageArgs = [];
  capturedToolDeclarations = [];
  mockSendMessageStreamResult = null;
  mockSendMessageResponse = {
    text: () => 'Hello from Gemini!',
    candidates: [
      { content: { parts: [{ text: 'Hello from Gemini!' }] } },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetMocks();
});

describe('chatGoogle', () => {
  // =========================================================================
  // Non-streaming: basic text response
  // =========================================================================

  describe('non-streaming text response', () => {
    it('should return text-only response with stop finish reason', async () => {
      mockSendMessageResponse = {
        text: () => 'The answer is 42.',
        candidates: [{ content: { parts: [{ text: 'The answer is 42.' }] } }],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'What is the meaning of life?' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.content).toBe('The answer is 42.');
      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBe('stop');
    });
  });

  // =========================================================================
  // Non-streaming: function call response (text() throws)
  // =========================================================================

  describe('non-streaming function call response', () => {
    it('should handle function-call-only response where text() throws', async () => {
      mockSendMessageResponse = {
        text: () => { throw new Error('No text content'); },
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'read_file', args: { path: '/tmp/test.txt' } } },
              ],
            },
          },
        ],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Read the file' }],
        makeTools(),
        'gemini-2.0-flash'
      );

      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('read_file');
      expect(result.toolCalls![0].arguments).toEqual({ path: '/tmp/test.txt' });
      expect(result.finishReason).toBe('tool_use');
    });
  });

  // =========================================================================
  // Non-streaming: mixed text + function calls
  // =========================================================================

  describe('non-streaming mixed response', () => {
    it('should handle text + function calls together', async () => {
      mockSendMessageResponse = {
        text: () => 'Let me read that file.',
        candidates: [
          {
            content: {
              parts: [
                { text: 'Let me read that file.' },
                { functionCall: { name: 'read_file', args: { path: '/a.txt' } } },
              ],
            },
          },
        ],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Read file' }],
        makeTools(),
        'gemini-2.0-flash'
      );

      expect(result.content).toBe('Let me read that file.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.finishReason).toBe('tool_use');
    });
  });

  // =========================================================================
  // Non-streaming: usageMetadata extraction
  // =========================================================================

  describe('non-streaming usageMetadata', () => {
    it('should extract usage from usageMetadata', async () => {
      mockSendMessageResponse = {
        text: () => 'Hello',
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
        },
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    });

    it('should return undefined usage when no usageMetadata', async () => {
      mockSendMessageResponse = {
        text: () => 'Hello',
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        // No usageMetadata
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.usage).toBeUndefined();
    });

    it('should handle usageMetadata with zero counts', async () => {
      mockSendMessageResponse = {
        text: () => 'Hello',
        candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        usageMetadata: {
          promptTokenCount: 0,
          candidatesTokenCount: 0,
        },
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash'
      );

      // Both are 0 so (inputTokens || outputTokens) is falsy => undefined
      // Wait, this is non-streaming. Let me check the code...
      // Non-streaming: usage: response.usageMetadata ? { ... } : undefined
      // usageMetadata is truthy (it's an object), so it returns the object
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
  });

  // =========================================================================
  // Streaming: text chunks with onToken callback
  // =========================================================================

  describe('streaming text chunks', () => {
    it('should stream text chunks via onToken callback', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        },
        {
          candidates: [{ content: { parts: [{ text: ' world' }] } }],
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const tokens: string[] = [];
      const onToken = (token: string) => { tokens.push(token); };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        onToken
      );

      expect(tokens).toEqual(['Hello', ' world']);
      expect(result.content).toBe('Hello world');
      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBe('stop');
    });

    it('should handle empty text parts in stream (skips falsy text)', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: '' }] } }],
        },
        {
          candidates: [{ content: { parts: [{ text: 'actual text' }] } }],
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const tokens: string[] = [];
      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        (t) => tokens.push(t)
      );

      // Empty text should not trigger onToken (line 145: if 'text' in part && part.text)
      expect(tokens).toEqual(['actual text']);
      expect(result.content).toBe('actual text');
    });
  });

  // =========================================================================
  // Streaming: function calls in stream
  // =========================================================================

  describe('streaming function calls', () => {
    it('should collect function calls from stream', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'read_file', args: { path: '/test.txt' } } },
                ],
              },
            },
          ],
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const tokens: string[] = [];
      const result = await chatGoogle(
        [{ role: 'user', content: 'Read the file' }],
        makeTools(),
        'gemini-2.0-flash',
        (t) => tokens.push(t)
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('read_file');
      expect(result.toolCalls![0].arguments).toEqual({ path: '/test.txt' });
      expect(result.toolCalls![0].id).toMatch(/^gemini_/);
      expect(result.finishReason).toBe('tool_use');
      // No text tokens should have been emitted
      expect(tokens).toEqual([]);
    });

    it('should handle function call with no args in stream', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { functionCall: { name: 'list_files', args: undefined } },
                ],
              },
            },
          ],
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const result = await chatGoogle(
        [{ role: 'user', content: 'List files' }],
        makeTools(),
        'gemini-2.0-flash',
        () => {}
      );

      expect(result.toolCalls![0].arguments).toEqual({});
    });

    it('should handle mixed text and function calls in stream', async () => {
      const chunks = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'Reading file...' },
                  { functionCall: { name: 'read_file', args: { path: '/x' } } },
                ],
              },
            },
          ],
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const tokens: string[] = [];
      const result = await chatGoogle(
        [{ role: 'user', content: 'Read' }],
        makeTools(),
        'gemini-2.0-flash',
        (t) => tokens.push(t)
      );

      expect(tokens).toEqual(['Reading file...']);
      expect(result.content).toBe('Reading file...');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.finishReason).toBe('tool_use');
    });
  });

  // =========================================================================
  // Streaming: usageMetadata in chunks
  // =========================================================================

  describe('streaming usageMetadata', () => {
    it('should extract usage from chunk usageMetadata', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
        },
        {
          candidates: [{ content: { parts: [{ text: ' there' }] } }],
          usageMetadata: {
            promptTokenCount: 25,
            candidatesTokenCount: 10,
          },
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hello' }],
        [],
        'gemini-2.0-flash',
        () => {}
      );

      expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 10 });
    });

    it('should return undefined usage when no usageMetadata in any chunk', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        () => {}
      );

      // inputTokens=0, outputTokens=0 => (0 || 0) is falsy => undefined
      expect(result.usage).toBeUndefined();
    });

    it('should use the last usageMetadata when multiple chunks have it', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'A' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        },
        {
          candidates: [{ content: { parts: [{ text: 'B' }] } }],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15 },
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        () => {}
      );

      // Should overwrite with last chunk's values
      expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 15 });
    });
  });

  // =========================================================================
  // Streaming: error handling
  // =========================================================================

  describe('streaming error handling', () => {
    it('should call onToken with error message and rethrow', async () => {
      const streamError = new Error('Network timeout');
      mockSendMessageStreamResult = { stream: mockErrorStream(streamError) };

      const tokens: string[] = [];
      const onToken = (token: string) => { tokens.push(token); };

      await expect(
        chatGoogle(
          [{ role: 'user', content: 'Hi' }],
          [],
          'gemini-2.0-flash',
          onToken
        )
      ).rejects.toThrow('Network timeout');

      // onToken should have been called with the error message
      expect(tokens.some(t => t.includes('[Streaming error: Network timeout]'))).toBe(true);
    });

    it('should handle non-Error stream failures', async () => {
      // Create a stream that throws a string instead of Error
      async function* stringErrorStream() {
        throw 'string error';
        yield {} as never;
      }

      mockSendMessageStreamResult = { stream: stringErrorStream() };

      const tokens: string[] = [];

      await expect(
        chatGoogle(
          [{ role: 'user', content: 'Hi' }],
          [],
          'gemini-2.0-flash',
          (t) => tokens.push(t)
        )
      ).rejects.toBe('string error');

      expect(tokens.some(t => t.includes('[Streaming error: string error]'))).toBe(true);
    });
  });

  // =========================================================================
  // Streaming: empty candidates / no content parts
  // =========================================================================

  describe('streaming edge cases', () => {
    it('should handle chunks with no candidates', async () => {
      const chunks = [
        { candidates: undefined },
        { candidates: [] },
        { candidates: [{ content: { parts: [{ text: 'final' }] } }] },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks as any) };

      const tokens: string[] = [];
      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        (t) => tokens.push(t)
      );

      expect(tokens).toEqual(['final']);
      expect(result.content).toBe('final');
    });

    it('should handle chunks with candidates but no content parts', async () => {
      const chunks = [
        { candidates: [{ content: { parts: [] } }] },
        { candidates: [{ content: undefined }] },
        { candidates: [{ content: { parts: [{ text: 'ok' }] } }] },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks as any) };

      const tokens: string[] = [];
      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        (t) => tokens.push(t)
      );

      expect(tokens).toEqual(['ok']);
      expect(result.content).toBe('ok');
    });
  });

  // =========================================================================
  // Missing API key
  // =========================================================================

  describe('missing API key', () => {
    it('should throw when Google API key is not configured', async () => {
      const configMod = await import('../src/config.js');
      vi.mocked(configMod.getApiKey).mockReturnValueOnce(undefined);

      await expect(
        chatGoogle([{ role: 'user', content: 'hi' }], [], 'gemini-2.0-flash')
      ).rejects.toThrow('Google API key not configured');
    });
  });

  // =========================================================================
  // Empty messages
  // =========================================================================

  describe('empty messages', () => {
    it('should throw when no messages provided', async () => {
      await expect(
        chatGoogle([], [], 'gemini-2.0-flash')
      ).rejects.toThrow('No messages provided');
    });
  });

  // =========================================================================
  // convertPropertyType: nested objects
  // =========================================================================

  describe('convertPropertyType nested objects', () => {
    it('should recursively convert nested object properties', async () => {
      const tools: Tool[] = [
        {
          name: 'create_config',
          description: 'Create config',
          parameters: {
            type: 'object',
            properties: {
              settings: {
                type: 'object',
                description: 'Settings object',
                properties: {
                  name: { type: 'string', description: 'Name' },
                  count: { type: 'number', description: 'Count' },
                },
                required: ['name'],
              } as any,
            },
            required: ['settings'],
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.settings.type).toBe('OBJECT');
      expect(props.settings.properties).toBeDefined();
      expect(props.settings.properties.name.type).toBe('STRING');
      expect(props.settings.properties.name.description).toBe('Name');
      expect(props.settings.properties.count.type).toBe('NUMBER');
      expect(props.settings.required).toEqual(['name']);
    });

    it('should handle deeply nested objects', async () => {
      const tools: Tool[] = [
        {
          name: 'deep',
          description: 'Deep nesting',
          parameters: {
            type: 'object',
            properties: {
              level1: {
                type: 'object',
                description: 'L1',
                properties: {
                  level2: {
                    type: 'object',
                    description: 'L2',
                    properties: {
                      value: { type: 'string', description: 'Value' },
                    },
                  },
                },
              } as any,
            },
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.level1.type).toBe('OBJECT');
      expect(props.level1.properties.level2.type).toBe('OBJECT');
      expect(props.level1.properties.level2.properties.value.type).toBe('STRING');
    });

    it('should not add required or properties for plain object type (no nested props)', async () => {
      const tools: Tool[] = [
        {
          name: 'simple',
          description: 'Simple',
          parameters: {
            type: 'object',
            properties: {
              data: { type: 'object', description: 'Any object' },
            },
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.data.type).toBe('OBJECT');
      // No nested properties since prop.properties is undefined
      expect(props.data.properties).toBeUndefined();
      expect(props.data.required).toBeUndefined();
    });
  });

  // =========================================================================
  // convertPropertyType: arrays with items
  // =========================================================================

  describe('convertPropertyType arrays', () => {
    it('should recursively convert array items', async () => {
      const tools: Tool[] = [
        {
          name: 'process',
          description: 'Process items',
          parameters: {
            type: 'object',
            properties: {
              items: {
                type: 'array',
                description: 'List of items',
                items: { type: 'string' },
              },
            },
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.items.type).toBe('ARRAY');
      expect(props.items.items).toEqual({ type: 'STRING', description: undefined });
    });

    it('should handle array of objects', async () => {
      const tools: Tool[] = [
        {
          name: 'batch',
          description: 'Batch process',
          parameters: {
            type: 'object',
            properties: {
              entries: {
                type: 'array',
                description: 'Entries',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', description: 'Key' },
                    value: { type: 'number', description: 'Value' },
                  },
                  required: ['key'],
                },
              } as any,
            },
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.entries.type).toBe('ARRAY');
      expect(props.entries.items.type).toBe('OBJECT');
      expect(props.entries.items.properties.key.type).toBe('STRING');
      expect(props.entries.items.properties.value.type).toBe('NUMBER');
      expect(props.entries.items.required).toEqual(['key']);
    });

    it('should handle array without items (no items property)', async () => {
      const tools: Tool[] = [
        {
          name: 'bare_array',
          description: 'Array without items spec',
          parameters: {
            type: 'object',
            properties: {
              tags: { type: 'array', description: 'Tags' },
            },
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.tags.type).toBe('ARRAY');
      expect(props.tags.items).toBeUndefined();
    });
  });

  // =========================================================================
  // convertPropertyType: enum
  // =========================================================================

  describe('convertPropertyType enum', () => {
    it('should include enum values in converted property', async () => {
      const tools: Tool[] = [
        {
          name: 'format',
          description: 'Format output',
          parameters: {
            type: 'object',
            properties: {
              style: { type: 'string', description: 'Style', enum: ['json', 'yaml', 'text'] },
            },
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.style.type).toBe('STRING');
      expect(props.style.enum).toEqual(['json', 'yaml', 'text']);
    });
  });

  // =========================================================================
  // History building
  // =========================================================================

  describe('history building', () => {
    it('should exclude system messages from history', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Second' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedHistory).toHaveLength(2);
      expect(capturedHistory[0].role).toBe('user');
      expect(capturedHistory[1].role).toBe('model');
      expect(capturedSystemInstruction).toBe('You are helpful.');
    });

    it('should convert tool messages to functionResponse with resolved name', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read file' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: { path: '/x' } }],
        },
        { role: 'tool', content: 'file data', toolCallId: 'tc_1' },
        { role: 'user', content: 'Thanks' },
      ];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      const toolEntry = capturedHistory[2];
      expect(toolEntry.role).toBe('function');
      const parts = toolEntry.parts as any[];
      expect(parts[0].functionResponse.name).toBe('read_file');
      expect(parts[0].functionResponse.response.result).toBe('file data');
    });

    it('should use "unknown" when tool call ID not found', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Go' },
        { role: 'tool', content: 'result', toolCallId: 'nonexistent' },
        { role: 'user', content: 'Ok' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      const toolEntry = capturedHistory[1];
      const parts = toolEntry.parts as any[];
      expect(parts[0].functionResponse.name).toBe('unknown');
    });

    it('should convert assistant with toolCalls to model with functionCall parts', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: 'Working...',
          toolCalls: [
            { id: 'tc_1', name: 'shell', arguments: { command: 'ls' } },
          ],
        },
        { role: 'tool', content: 'file1', toolCallId: 'tc_1' },
        { role: 'user', content: 'Done' },
      ];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      const assistantEntry = capturedHistory[1];
      expect(assistantEntry.role).toBe('model');
      const parts = assistantEntry.parts as any[];
      expect(parts).toHaveLength(2);
      expect(parts[0]).toEqual({ text: 'Working...' });
      expect(parts[1]).toEqual({ functionCall: { name: 'shell', args: { command: 'ls' } } });
    });

    it('should omit text part when assistant with toolCalls has empty content', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc_1', name: 'think', arguments: { thought: 'hmm' } }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'tc_1' },
        { role: 'user', content: 'Done' },
      ];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      const assistantEntry = capturedHistory[1];
      const parts = assistantEntry.parts as any[];
      expect(parts).toHaveLength(1);
      expect(parts[0]).toHaveProperty('functionCall');
    });
  });

  // =========================================================================
  // Last message with array content (text + image blocks)
  // =========================================================================

  describe('last message with array content', () => {
    it('should handle array content with text and image blocks', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image' },
            { type: 'image', mediaType: 'image/jpeg', data: 'base64imagedata' },
          ],
        },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedSendMessageArgs).toHaveLength(2);
      expect(capturedSendMessageArgs[0]).toEqual({ text: 'Describe this image' });
      expect(capturedSendMessageArgs[1]).toEqual({
        inlineData: { mimeType: 'image/jpeg', data: 'base64imagedata' },
      });
    });

    it('should handle array content with only text blocks', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Part one' },
            { type: 'text', text: 'Part two' },
          ],
        },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedSendMessageArgs).toHaveLength(2);
      expect(capturedSendMessageArgs[0]).toEqual({ text: 'Part one' });
      expect(capturedSendMessageArgs[1]).toEqual({ text: 'Part two' });
    });

    it('should handle string content as single text part', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Simple string' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedSendMessageArgs).toEqual([{ text: 'Simple string' }]);
    });
  });

  // =========================================================================
  // No tools -> geminiTools is undefined
  // =========================================================================

  describe('no tools', () => {
    it('should pass undefined tools when no tools provided', async () => {
      await chatGoogle(
        [{ role: 'user', content: 'hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(capturedToolDeclarations).toEqual([]);
    });
  });

  // =========================================================================
  // Streaming path for last message array content
  // =========================================================================

  describe('streaming with array content last message', () => {
    it('should send array content parts via streaming', async () => {
      const chunks = [
        { candidates: [{ content: { parts: [{ text: 'I see an image' }] } }] },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', mediaType: 'image/png', data: 'abc123' },
          ],
        },
      ];

      const tokens: string[] = [];
      const result = await chatGoogle(messages, [], 'gemini-2.0-flash', (t) => tokens.push(t));

      expect(capturedSendMessageArgs).toHaveLength(2);
      expect(result.content).toBe('I see an image');
    });
  });

  // =========================================================================
  // Non-streaming: candidates with missing content
  // =========================================================================

  describe('non-streaming candidates edge cases', () => {
    it('should handle candidates with undefined content (content?.parts fallback)', async () => {
      mockSendMessageResponse = {
        text: () => '',
        candidates: [
          { content: undefined },
        ],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.content).toBe('');
      expect(result.toolCalls).toBeUndefined();
    });

    it('should handle no candidates at all (response.candidates is undefined)', async () => {
      mockSendMessageResponse = {
        text: () => '',
        // candidates is undefined, so || [] kicks in
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.content).toBe('');
      expect(result.toolCalls).toBeUndefined();
    });
  });

  // =========================================================================
  // Last message array content: unknown block type
  // =========================================================================

  describe('last message with unknown block type', () => {
    it('should skip blocks that are neither text nor image', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Hello' },
            { type: 'unknown_type' as any, data: 'something' } as any,
            { type: 'image', mediaType: 'image/png', data: 'imgdata' },
          ],
        },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      // Only text and image blocks should be in parts
      expect(capturedSendMessageArgs).toHaveLength(2);
      expect(capturedSendMessageArgs[0]).toEqual({ text: 'Hello' });
      expect(capturedSendMessageArgs[1]).toEqual({
        inlineData: { mimeType: 'image/png', data: 'imgdata' },
      });
    });
  });

  // =========================================================================
  // History: toolCalls exist but none match the toolCallId
  // =========================================================================

  describe('history tool call ID resolution edge cases', () => {
    it('should iterate through messages with toolCalls but not find a match', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc_other', name: 'other_tool', arguments: {} }],
        },
        { role: 'tool', content: 'result', toolCallId: 'tc_nonexistent' },
        { role: 'user', content: 'ok' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      // toolCalls exist on the assistant but none have id === 'tc_nonexistent'
      const toolEntry = capturedHistory[2];
      const parts = toolEntry.parts as any[];
      expect(parts[0].functionResponse.name).toBe('unknown');
    });
  });

  // =========================================================================
  // convertPropertyType: default type when type is missing
  // =========================================================================

  describe('convertPropertyType defaults', () => {
    it('should default to STRING when type is not specified', async () => {
      const tools: Tool[] = [
        {
          name: 'test',
          description: 'Test',
          parameters: {
            type: 'object',
            properties: {
              field: { description: 'No type specified' } as any,
            },
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, any>;

      expect(props.field.type).toBe('STRING');
    });
  });

  // =========================================================================
  // Streaming: empty stream returns correctly
  // =========================================================================

  describe('streaming empty stream', () => {
    it('should handle empty stream gracefully', async () => {
      mockSendMessageStreamResult = { stream: mockStream([]) };

      const tokens: string[] = [];
      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        (t) => tokens.push(t)
      );

      expect(tokens).toEqual([]);
      expect(result.content).toBe('');
      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toBeUndefined();
    });
  });

  // =========================================================================
  // Streaming: usageMetadata with missing fields
  // =========================================================================

  describe('streaming usageMetadata partial fields', () => {
    it('should handle usageMetadata with missing promptTokenCount', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: {
            candidatesTokenCount: 10,
            // no promptTokenCount
          },
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        () => {}
      );

      // promptTokenCount is undefined, || 0 => 0; candidatesTokenCount=10 so truthy
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 10 });
    });

    it('should handle usageMetadata with missing candidatesTokenCount', async () => {
      const chunks = [
        {
          candidates: [{ content: { parts: [{ text: 'Hi' }] } }],
          usageMetadata: {
            promptTokenCount: 25,
            // no candidatesTokenCount
          },
        },
      ];

      mockSendMessageStreamResult = { stream: mockStream(chunks) };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Hi' }],
        [],
        'gemini-2.0-flash',
        () => {}
      );

      expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 0 });
    });
  });
});
