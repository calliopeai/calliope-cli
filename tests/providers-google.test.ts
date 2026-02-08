/**
 * Tests for src/providers/google.ts
 *
 * Covers: Google Gemini message formatting, history building, tool conversion,
 * property type conversion, response parsing, function call handling,
 * multi-modal content, and error handling.
 *
 * The Google Generative AI SDK is mocked to avoid real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Tool, ToolCall } from '../src/types.js';

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
  getModelInfo: vi.fn(() => null),
  getOllamaFallbackModel: vi.fn(() => null),
}));

// Track calls to the Gemini SDK
let capturedHistory: Array<Record<string, unknown>> = [];
let capturedSystemInstruction: string | undefined = undefined;
let capturedSendMessageArgs: unknown[] = [];
let capturedToolDeclarations: unknown[] = [];
let mockSendMessageResponse: Record<string, unknown> = {};

vi.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: class MockGoogleGenerativeAI {
      constructor(_apiKey: string) {}
      getGenerativeModel(opts: Record<string, unknown>) {
        // Capture tool declarations
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

function makeComplexTools(): Tool[] {
  return [
    {
      name: 'search',
      description: 'Search for items',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          limit: { type: 'number', description: 'Max results' },
          tags: { type: 'array', description: 'Filter tags', items: { type: 'string' } },
        },
        required: ['query'],
      },
    },
  ];
}

function resetMocks() {
  capturedHistory = [];
  capturedSystemInstruction = undefined;
  capturedSendMessageArgs = [];
  capturedToolDeclarations = [];
  mockSendMessageResponse = {
    text: () => 'Hello from Gemini!',
    candidates: [
      {
        content: {
          parts: [{ text: 'Hello from Gemini!' }],
        },
      },
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
  // Message formatting / history building
  // =========================================================================

  describe('message formatting', () => {
    it('should extract system message as systemInstruction', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedSystemInstruction).toBe('You are a helpful assistant.');
    });

    it('should not include system messages in history', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'System prompt' },
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Second' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      // History should exclude last message AND system messages
      // So: user("First"), model("Reply") => 2 entries in history
      expect(capturedHistory).toHaveLength(2);
      expect(capturedHistory[0].role).toBe('user');
      expect(capturedHistory[1].role).toBe('model');
    });

    it('should convert assistant role to model role', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello!' },
        { role: 'user', content: 'Bye' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      // History = first two messages; last message sent separately
      expect(capturedHistory).toHaveLength(2);
      expect(capturedHistory[0].role).toBe('user');
      expect(capturedHistory[1].role).toBe('model');
      const parts = capturedHistory[1].parts as Array<Record<string, unknown>>;
      expect(parts[0]).toEqual({ text: 'Hello!' });
    });

    it('should send the last message via sendMessage', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'Reply' },
        { role: 'user', content: 'Last message' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedSendMessageArgs).toEqual([{ text: 'Last message' }]);
    });

    it('should handle tool result messages as functionResponse in history', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Read /tmp/test.txt' },
        {
          role: 'assistant',
          content: 'Reading...',
          toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: { path: '/tmp/test.txt' } }],
        },
        { role: 'tool', content: 'file contents', toolCallId: 'tc_1' },
        { role: 'user', content: 'Thanks' },
      ];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      // History: user, model(with functionCall), function(response) => 3 items
      expect(capturedHistory).toHaveLength(3);

      // Check the tool result message
      const toolEntry = capturedHistory[2];
      expect(toolEntry.role).toBe('function');
      const parts = toolEntry.parts as Array<Record<string, unknown>>;
      expect(parts[0]).toEqual({
        functionResponse: {
          name: 'read_file',
          response: { result: 'file contents' },
        },
      });
    });

    it('should resolve function name from tool call ID when building functionResponse', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc_abc', name: 'write_file', arguments: { path: '/x', content: 'hi' } }],
        },
        { role: 'tool', content: 'done', toolCallId: 'tc_abc' },
        { role: 'user', content: 'ok' },
      ];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      const toolEntry = capturedHistory[2];
      const parts = toolEntry.parts as Array<Record<string, unknown>>;
      const funcResp = parts[0] as { functionResponse: { name: string } };
      expect(funcResp.functionResponse.name).toBe('write_file');
    });

    it('should use "unknown" as function name when tool call ID is not found', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Do something' },
        { role: 'tool', content: 'orphan result', toolCallId: 'nonexistent_id' },
        { role: 'user', content: 'ok' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      const toolEntry = capturedHistory[1];
      const parts = toolEntry.parts as Array<Record<string, unknown>>;
      const funcResp = parts[0] as { functionResponse: { name: string } };
      expect(funcResp.functionResponse.name).toBe('unknown');
    });

    it('should convert assistant messages with tool calls to functionCall parts', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'List files' },
        {
          role: 'assistant',
          content: 'Listing...',
          toolCalls: [
            { id: 'tc_1', name: 'shell', arguments: { command: 'ls' } },
            { id: 'tc_2', name: 'read_file', arguments: { path: '/a.txt' } },
          ],
        },
        { role: 'tool', content: 'file1', toolCallId: 'tc_1' },
        { role: 'tool', content: 'content', toolCallId: 'tc_2' },
        { role: 'user', content: 'Thanks' },
      ];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      // The assistant message with tool calls should have text + functionCall parts
      const assistantEntry = capturedHistory[1];
      expect(assistantEntry.role).toBe('model');
      const parts = assistantEntry.parts as Array<Record<string, unknown>>;
      expect(parts).toHaveLength(3); // text + 2 functionCalls
      expect(parts[0]).toEqual({ text: 'Listing...' });
      expect(parts[1]).toEqual({ functionCall: { name: 'shell', args: { command: 'ls' } } });
      expect(parts[2]).toEqual({ functionCall: { name: 'read_file', args: { path: '/a.txt' } } });
    });

    it('should omit text part when assistant message with tool calls has empty text', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc_1', name: 'think', arguments: { thought: 'hmm' } }],
        },
        { role: 'tool', content: 'ok', toolCallId: 'tc_1' },
        { role: 'user', content: 'Done?' },
      ];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      const assistantEntry = capturedHistory[1];
      const parts = assistantEntry.parts as Array<Record<string, unknown>>;
      // Only functionCall, no text part
      expect(parts).toHaveLength(1);
      expect(parts[0]).toHaveProperty('functionCall');
    });

    it('should handle multi-modal last message with images', async () => {
      const messages: Message[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            { type: 'image', mediaType: 'image/png', data: 'base64data' },
          ],
        },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedSendMessageArgs).toHaveLength(2);
      expect(capturedSendMessageArgs[0]).toEqual({ text: 'What is this?' });
      expect(capturedSendMessageArgs[1]).toEqual({
        inlineData: { mimeType: 'image/png', data: 'base64data' },
      });
    });

    it('should pass undefined systemInstruction when no system message present', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello' },
      ];

      await chatGoogle(messages, [], 'gemini-2.0-flash');

      expect(capturedSystemInstruction).toBeUndefined();
    });
  });

  // =========================================================================
  // Tool conversion
  // =========================================================================

  describe('tool conversion', () => {
    it('should convert tools to Gemini functionDeclarations format', async () => {
      const messages: Message[] = [{ role: 'user', content: 'hi' }];

      await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      expect(capturedToolDeclarations).toHaveLength(1);
      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      expect(decl.name).toBe('read_file');
      expect(decl.description).toBe('Read a file');
      const params = decl.parameters as Record<string, unknown>;
      expect(params.type).toBe('OBJECT');
      expect(params.required).toEqual(['path']);
      // Properties should be uppercased
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.path.type).toBe('STRING');
      expect(props.path.description).toBe('File path');
    });

    it('should convert property types to uppercase', async () => {
      const tools: Tool[] = [
        {
          name: 'test',
          description: 'Test tool',
          parameters: {
            type: 'object',
            properties: {
              str: { type: 'string', description: 'A string' },
              num: { type: 'number', description: 'A number' },
              bool: { type: 'boolean', description: 'A bool' },
            },
            required: ['str'],
          },
        },
      ];

      await chatGoogle([{ role: 'user', content: 'hi' }], tools, 'gemini-2.0-flash');

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.str.type).toBe('STRING');
      expect(props.num.type).toBe('NUMBER');
      expect(props.bool.type).toBe('BOOLEAN');
    });

    it('should handle array type properties with items', async () => {
      await chatGoogle(
        [{ role: 'user', content: 'hi' }],
        makeComplexTools(),
        'gemini-2.0-flash'
      );

      const decl = capturedToolDeclarations[0] as Record<string, unknown>;
      const params = decl.parameters as Record<string, unknown>;
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.tags.type).toBe('ARRAY');
      expect(props.tags.items).toEqual({ type: 'STRING', description: undefined });
    });

    it('should handle enum properties', async () => {
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
      const props = params.properties as Record<string, Record<string, unknown>>;
      expect(props.style.enum).toEqual(['json', 'yaml', 'text']);
    });

    it('should not include tools when array is empty', async () => {
      await chatGoogle([{ role: 'user', content: 'hi' }], [], 'gemini-2.0-flash');

      expect(capturedToolDeclarations).toEqual([]);
    });
  });

  // =========================================================================
  // Response parsing
  // =========================================================================

  describe('response parsing', () => {
    it('should parse text response', async () => {
      mockSendMessageResponse = {
        text: () => 'The answer is 42.',
        candidates: [
          { content: { parts: [{ text: 'The answer is 42.' }] } },
        ],
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

    it('should parse function call response', async () => {
      mockSendMessageResponse = {
        text: () => { throw new Error('No text'); },
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: {
                    name: 'read_file',
                    args: { path: '/tmp/test.txt' },
                  },
                },
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

      expect(result.content).toBe(''); // text() throws, so empty
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('read_file');
      expect(result.toolCalls![0].arguments).toEqual({ path: '/tmp/test.txt' });
      expect(result.finishReason).toBe('tool_use');
    });

    it('should generate unique IDs for function calls', async () => {
      mockSendMessageResponse = {
        text: () => { throw new Error('No text'); },
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'read_file', args: { path: '/a.txt' } } },
                { functionCall: { name: 'read_file', args: { path: '/b.txt' } } },
              ],
            },
          },
        ],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Read both' }],
        makeTools(),
        'gemini-2.0-flash'
      );

      expect(result.toolCalls).toHaveLength(2);
      // IDs should start with gemini_
      expect(result.toolCalls![0].id).toMatch(/^gemini_/);
      expect(result.toolCalls![1].id).toMatch(/^gemini_/);
      // IDs should be different
      expect(result.toolCalls![0].id).not.toBe(result.toolCalls![1].id);
    });

    it('should handle function call with no args', async () => {
      mockSendMessageResponse = {
        text: () => { throw new Error('No text'); },
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'read_file', args: undefined } },
              ],
            },
          },
        ],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'Read' }],
        makeTools(),
        'gemini-2.0-flash'
      );

      expect(result.toolCalls![0].arguments).toEqual({});
    });

    it('should handle mixed text and function call response', async () => {
      mockSendMessageResponse = {
        text: () => 'I will read the file.',
        candidates: [
          {
            content: {
              parts: [
                { text: 'I will read the file.' },
                { functionCall: { name: 'read_file', args: { path: '/x.txt' } } },
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

      expect(result.content).toBe('I will read the file.');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.finishReason).toBe('tool_use');
    });

    it('should handle empty candidates', async () => {
      mockSendMessageResponse = {
        text: () => '',
        candidates: [],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.content).toBe('');
      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBe('stop');
    });

    it('should handle candidates with no content parts', async () => {
      mockSendMessageResponse = {
        text: () => '',
        candidates: [{ content: { parts: [] } }],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBe('stop');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('should throw when API key is not configured', async () => {
      const configMod = await import('../src/config.js');
      vi.mocked(configMod.getApiKey).mockReturnValueOnce(undefined);

      await expect(
        chatGoogle([{ role: 'user', content: 'hi' }], [], 'gemini-2.0-flash')
      ).rejects.toThrow('Google API key not configured');
    });

    it('should throw when no messages provided', async () => {
      await expect(
        chatGoogle([], [], 'gemini-2.0-flash')
      ).rejects.toThrow('No messages provided');
    });

    it('should handle text() throwing gracefully (function-call-only response)', async () => {
      mockSendMessageResponse = {
        text: () => { throw new Error('No text content'); },
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'read_file', args: { path: '/x' } } },
              ],
            },
          },
        ],
      };

      // Should not throw - empty text is expected for function-call-only responses
      const result = await chatGoogle(
        [{ role: 'user', content: 'read' }],
        makeTools(),
        'gemini-2.0-flash'
      );

      expect(result.content).toBe('');
      expect(result.toolCalls).toHaveLength(1);
    });
  });

  // =========================================================================
  // Finish reason
  // =========================================================================

  describe('finish reason', () => {
    it('should return stop when no function calls', async () => {
      mockSendMessageResponse = {
        text: () => 'Just text',
        candidates: [{ content: { parts: [{ text: 'Just text' }] } }],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'hi' }],
        [],
        'gemini-2.0-flash'
      );

      expect(result.finishReason).toBe('stop');
    });

    it('should return tool_use when function calls present', async () => {
      mockSendMessageResponse = {
        text: () => { throw new Error('No text'); },
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: 'think', args: {} } }],
            },
          },
        ],
      };

      const result = await chatGoogle(
        [{ role: 'user', content: 'think' }],
        makeTools(),
        'gemini-2.0-flash'
      );

      expect(result.finishReason).toBe('tool_use');
    });
  });

  // =========================================================================
  // Complete conversation flow
  // =========================================================================

  describe('complete conversation flow', () => {
    it('should handle a full tool-use round trip', async () => {
      mockSendMessageResponse = {
        text: () => 'The file contains: hello world',
        candidates: [
          { content: { parts: [{ text: 'The file contains: hello world' }] } },
        ],
      };

      const messages: Message[] = [
        { role: 'system', content: 'You are a file reader.' },
        { role: 'user', content: 'Read /tmp/test.txt' },
        {
          role: 'assistant',
          content: 'Reading...',
          toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: { path: '/tmp/test.txt' } }],
        },
        { role: 'tool', content: 'hello world', toolCallId: 'tc_1' },
        { role: 'user', content: 'What did it say?' },
      ];

      const result = await chatGoogle(messages, makeTools(), 'gemini-2.0-flash');

      // Verify system instruction
      expect(capturedSystemInstruction).toBe('You are a file reader.');

      // Verify history (system excluded, last message excluded)
      // user, model(functionCall), function(response) = 3 history entries
      expect(capturedHistory).toHaveLength(3);
      expect(capturedHistory[0].role).toBe('user');
      expect(capturedHistory[1].role).toBe('model');
      expect(capturedHistory[2].role).toBe('function');

      // Verify last message sent
      expect(capturedSendMessageArgs).toEqual([{ text: 'What did it say?' }]);

      // Verify response
      expect(result.content).toBe('The file contains: hello world');
      expect(result.finishReason).toBe('stop');
    });
  });
});
