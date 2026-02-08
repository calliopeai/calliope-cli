/**
 * Tests for src/providers/compat.ts
 *
 * Covers: OpenAI-compatible provider routing (OpenRouter, Together, Groq,
 * Fireworks, Mistral, AI21, HuggingFace, Ollama, LiteLLM, Bedrock),
 * base URL configuration, API key handling, message/tool format reuse
 * from openai.ts, streaming, response parsing, finish reason mapping,
 * Ollama fallback behavior, and error handling.
 *
 * Also tests the shared format converters from openai.ts that compat uses:
 * toOpenAIMessages, toOpenAITools, parseOpenAIToolCalls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message, Tool, ToolCall } from '../src/types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const apiKeys: Record<string, string | undefined> = {
  openrouter: 'test-openrouter-key',
  together: 'test-together-key',
  groq: 'test-groq-key',
  fireworks: 'test-fireworks-key',
  mistral: 'test-mistral-key',
  ai21: 'test-ai21-key',
  huggingface: 'test-hf-key',
  bedrock: 'test-bedrock-key',
};

const baseUrls: Record<string, string | undefined> = {
  ollama: 'http://localhost:11434',
  litellm: 'http://localhost:4000',
  bedrock: 'https://bedrock-gateway.example.com',
};

vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn((provider: string) => apiKeys[provider]),
  getBaseUrl: vi.fn((provider: string) => baseUrls[provider]),
}));

vi.mock('../src/model-detection.js', () => ({
  getModelContextLimit: vi.fn(() => 128000),
  getModelInfo: vi.fn(() => null),
  getOllamaFallbackModel: vi.fn(async () => 'llama3.3:latest'),
}));

// Track OpenAI client construction and API calls
let lastClientConfig: { apiKey?: string; baseURL?: string } | null = null;
let lastCreateParams: Record<string, unknown> | null = null;
let mockCreateResponse: Record<string, unknown> = {};
let mockCreateThrows: Error | null = null;
let mockStreamChunks: Array<Record<string, unknown>> = [];
let createCallCount = 0;

vi.mock('openai', () => {
  return {
    default: class MockOpenAI {
      chat = {
        completions: {
          create: vi.fn(async (params: Record<string, unknown>) => {
            createCallCount++;
            lastCreateParams = params;
            if (mockCreateThrows) {
              const err = mockCreateThrows;
              // Only throw on first call for fallback testing
              if (createCallCount <= 1) {
                throw err;
              }
            }
            if (params.stream) {
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
            return mockCreateResponse;
          }),
        },
      };
      constructor(opts: Record<string, unknown>) {
        lastClientConfig = { apiKey: opts.apiKey as string, baseURL: opts.baseURL as string };
      }
    },
  };
});

import { chatOpenAICompatible } from '../src/providers/compat.js';
import {
  toOpenAIMessages,
  toOpenAITools,
  toOpenAIContent,
  parseOpenAIToolCalls,
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

function resetMocks() {
  lastClientConfig = null;
  lastCreateParams = null;
  createCallCount = 0;
  mockCreateThrows = null;
  mockStreamChunks = [];
  mockCreateResponse = {
    choices: [
      {
        message: { content: 'Hello from compat!', tool_calls: undefined },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  };
}

// ---------------------------------------------------------------------------
// Tests: Shared OpenAI format converters (from openai.ts)
// ---------------------------------------------------------------------------

describe('toOpenAIMessages', () => {
  it('should convert system messages', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
    ];
    const result = toOpenAIMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: 'system', content: 'You are helpful.' });
  });

  it('should convert user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello' },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should convert assistant messages', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({ role: 'assistant', content: 'Hi there' });
  });

  it('should convert tool messages with tool_call_id', () => {
    const messages: Message[] = [
      { role: 'tool', content: 'result data', toolCallId: 'call_123' },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_123',
      content: 'result data',
    });
  });

  it('should convert assistant messages with tool calls', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'read_file', arguments: { path: '/test.txt' } },
    ];
    const messages: Message[] = [
      { role: 'assistant', content: 'Reading file...', toolCalls },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({
      role: 'assistant',
      content: 'Reading file...',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"path":"/test.txt"}',
          },
        },
      ],
    });
  });

  it('should JSON stringify tool call arguments', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'shell', arguments: { command: 'ls -la', cwd: '/tmp' } },
    ];
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls },
    ];
    const result = toOpenAIMessages(messages);
    const tcResult = result[0] as Record<string, unknown>;
    const tcs = tcResult.tool_calls as Array<Record<string, unknown>>;
    const func = tcs[0].function as Record<string, unknown>;
    expect(func.arguments).toBe('{"command":"ls -la","cwd":"/tmp"}');
  });

  it('should convert multi-modal user messages', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image', mediaType: 'image/png', data: 'abc123' },
        ],
      },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0].role).toBe('user');
    const content = result[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'What is this?' });
    expect(content[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,abc123' },
    });
  });

  it('should handle assistant messages with null content and tool calls', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_1', name: 'think', arguments: { thought: 'hmm' } },
    ];
    const messages: Message[] = [
      { role: 'assistant', content: '', toolCalls },
    ];
    const result = toOpenAIMessages(messages);
    const msg = result[0] as Record<string, unknown>;
    // Empty string content should be passed through
    expect(msg.content).toBe('');
  });

  it('should handle tool messages with no toolCallId', () => {
    const messages: Message[] = [
      { role: 'tool', content: 'orphan result' },
    ];
    const result = toOpenAIMessages(messages);
    expect(result[0]).toEqual({
      role: 'tool',
      tool_call_id: '',
      content: 'orphan result',
    });
  });

  it('should handle a complete conversation', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Read /tmp/test.txt' },
      {
        role: 'assistant',
        content: 'Reading...',
        toolCalls: [{ id: 'tc_1', name: 'read_file', arguments: { path: '/tmp/test.txt' } }],
      },
      { role: 'tool', content: 'hello world', toolCallId: 'tc_1' },
      { role: 'assistant', content: 'The file says: hello world' },
    ];

    const result = toOpenAIMessages(messages);
    expect(result).toHaveLength(5);
    expect(result[0].role).toBe('system');
    expect(result[1].role).toBe('user');
    expect(result[2].role).toBe('assistant');
    expect(result[3].role).toBe('tool');
    expect(result[4].role).toBe('assistant');
  });
});

describe('toOpenAIContent', () => {
  it('should pass through string content', () => {
    expect(toOpenAIContent('Hello')).toBe('Hello');
  });

  it('should convert text blocks', () => {
    const content = toOpenAIContent([
      { type: 'text', text: 'Hello' },
    ]);
    expect(content).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('should convert image blocks to image_url format', () => {
    const content = toOpenAIContent([
      { type: 'image', mediaType: 'image/jpeg', data: 'jpegdata' },
    ]);
    expect(content).toEqual([
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,jpegdata' },
      },
    ]);
  });

  it('should handle unknown block types with empty text', () => {
    const content = toOpenAIContent([
      { type: 'unknown' as 'text', text: '' },
    ]);
    // Unknown type falls through to the default case
    expect(content).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('toOpenAITools', () => {
  it('should convert tools to OpenAI function format', () => {
    const tools = makeTools();
    const result = toOpenAITools(tools);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a file',
        parameters: tools[0].parameters,
      },
    });
  });

  it('should convert multiple tools', () => {
    const tools: Tool[] = [
      {
        name: 'read_file',
        description: 'Read',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'p' } } },
      },
      {
        name: 'write_file',
        description: 'Write',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'p' }, content: { type: 'string', description: 'c' } } },
      },
    ];
    const result = toOpenAITools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe('read_file');
    expect(result[1].function.name).toBe('write_file');
  });

  it('should return empty array for empty tools', () => {
    expect(toOpenAITools([])).toEqual([]);
  });
});

describe('parseOpenAIToolCalls', () => {
  it('should return empty array for undefined', () => {
    expect(parseOpenAIToolCalls(undefined)).toEqual([]);
  });

  it('should parse valid tool calls', () => {
    const toolCalls = [
      {
        id: 'call_1',
        type: 'function' as const,
        function: {
          name: 'read_file',
          arguments: '{"path":"/test.txt"}',
        },
      },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: '/test.txt' },
    });
  });

  it('should parse multiple tool calls', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"/a.txt"}' } },
      { id: 'call_2', type: 'function' as const, function: { name: 'write_file', arguments: '{"path":"/b.txt","content":"hi"}' } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('read_file');
    expect(result[1].name).toBe('write_file');
    expect(result[1].arguments).toEqual({ path: '/b.txt', content: 'hi' });
  });

  it('should throw on invalid JSON arguments', () => {
    const toolCalls = [
      { id: 'call_bad', type: 'function' as const, function: { name: 'read_file', arguments: '{not valid json' } },
    ];
    expect(() => parseOpenAIToolCalls(toolCalls)).toThrow('Invalid tool arguments from LLM');
  });

  it('should include raw arguments in error message for invalid JSON', () => {
    const toolCalls = [
      { id: 'call_bad', type: 'function' as const, function: { name: 'read_file', arguments: '{broken' } },
    ];
    expect(() => parseOpenAIToolCalls(toolCalls)).toThrow('{broken');
  });

  it('should parse empty object arguments', () => {
    const toolCalls = [
      { id: 'call_1', type: 'function' as const, function: { name: 'think', arguments: '{}' } },
    ];
    const result = parseOpenAIToolCalls(toolCalls);
    expect(result[0].arguments).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Tests: chatOpenAICompatible
// ---------------------------------------------------------------------------

beforeEach(() => {
  resetMocks();
});

describe('chatOpenAICompatible', () => {
  // =========================================================================
  // Provider base URL routing
  // =========================================================================

  describe('provider routing', () => {
    it('should use correct base URL for openrouter', async () => {
      await chatOpenAICompatible('openrouter', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://openrouter.ai/api/v1');
      expect(lastClientConfig!.apiKey).toBe('test-openrouter-key');
    });

    it('should use correct base URL for together', async () => {
      await chatOpenAICompatible('together', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://api.together.xyz/v1');
    });

    it('should use correct base URL for groq', async () => {
      await chatOpenAICompatible('groq', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://api.groq.com/openai/v1');
    });

    it('should use correct base URL for fireworks', async () => {
      await chatOpenAICompatible('fireworks', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://api.fireworks.ai/inference/v1');
    });

    it('should use correct base URL for mistral', async () => {
      await chatOpenAICompatible('mistral', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://api.mistral.ai/v1');
    });

    it('should use correct base URL for ai21', async () => {
      await chatOpenAICompatible('ai21', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://api.ai21.com/studio/v1');
    });

    it('should use correct base URL for huggingface', async () => {
      await chatOpenAICompatible('huggingface', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://api-inference.huggingface.co/v1');
    });

    it('should append /v1 for Ollama base URL', async () => {
      await chatOpenAICompatible('ollama', [{ role: 'user', content: 'hi' }], [], 'llama3.3');
      expect(lastClientConfig!.baseURL).toBe('http://localhost:11434/v1');
      expect(lastClientConfig!.apiKey).toBe('ollama');
    });

    it('should not double-append /v1 for Ollama if already present', async () => {
      const configMod = await import('../src/config.js');
      vi.mocked(configMod.getBaseUrl).mockImplementation((p: string) => {
        if (p === 'ollama') return 'http://localhost:11434/v1';
        return baseUrls[p];
      });

      await chatOpenAICompatible('ollama', [{ role: 'user', content: 'hi' }], [], 'llama3.3');
      expect(lastClientConfig!.baseURL).toBe('http://localhost:11434/v1');

      // Restore
      vi.mocked(configMod.getBaseUrl).mockImplementation((p: string) => baseUrls[p]);
    });

    it('should append /v1 for LiteLLM base URL', async () => {
      await chatOpenAICompatible('litellm', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('http://localhost:4000/v1');
    });

    it('should append /v1 for Bedrock base URL', async () => {
      await chatOpenAICompatible('bedrock', [{ role: 'user', content: 'hi' }], [], 'test-model');
      expect(lastClientConfig!.baseURL).toBe('https://bedrock-gateway.example.com/v1');
    });
  });

  // =========================================================================
  // Error handling
  // =========================================================================

  describe('error handling', () => {
    it('should throw when API key is missing for key-based providers', async () => {
      const configMod = await import('../src/config.js');
      vi.mocked(configMod.getApiKey).mockReturnValueOnce(undefined);

      await expect(
        chatOpenAICompatible('openrouter', [{ role: 'user', content: 'hi' }], [], 'model')
      ).rejects.toThrow('openrouter API key not configured');
    });

    it('should throw when Bedrock base URL is missing', async () => {
      const configMod = await import('../src/config.js');
      vi.mocked(configMod.getBaseUrl).mockImplementation((p: string) => {
        if (p === 'bedrock') return undefined;
        return baseUrls[p];
      });

      await expect(
        chatOpenAICompatible('bedrock', [{ role: 'user', content: 'hi' }], [], 'model')
      ).rejects.toThrow('Bedrock base URL not configured');

      // Restore
      vi.mocked(configMod.getBaseUrl).mockImplementation((p: string) => baseUrls[p]);
    });

    it('should throw on empty response from API', async () => {
      mockCreateResponse = { choices: [] };

      await expect(
        chatOpenAICompatible('groq', [{ role: 'user', content: 'hi' }], [], 'model')
      ).rejects.toThrow('Empty response from groq API');
    });

    it('should throw on missing choices', async () => {
      mockCreateResponse = {};

      await expect(
        chatOpenAICompatible('together', [{ role: 'user', content: 'hi' }], [], 'model')
      ).rejects.toThrow('Empty response from together API');
    });
  });

  // =========================================================================
  // Request building
  // =========================================================================

  describe('request building', () => {
    it('should pass model and messages to the API', async () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello' },
      ];

      await chatOpenAICompatible('groq', messages, [], 'llama-3.3-70b-versatile');

      expect(lastCreateParams!.model).toBe('llama-3.3-70b-versatile');
      const msgs = lastCreateParams!.messages as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe('system');
      expect(msgs[1].role).toBe('user');
    });

    it('should pass tools when provided', async () => {
      const tools = makeTools();

      await chatOpenAICompatible('mistral', [{ role: 'user', content: 'hi' }], tools, 'mistral-large');

      expect(lastCreateParams!.tools).toBeDefined();
      const apiTools = lastCreateParams!.tools as Array<Record<string, unknown>>;
      expect(apiTools).toHaveLength(1);
      expect(apiTools[0].type).toBe('function');
    });

    it('should pass undefined for tools when array is empty', async () => {
      await chatOpenAICompatible('together', [{ role: 'user', content: 'hi' }], [], 'model');

      expect(lastCreateParams!.tools).toBeUndefined();
    });

    it('should include max_tokens in request', async () => {
      await chatOpenAICompatible('groq', [{ role: 'user', content: 'hi' }], [], 'model');

      expect(lastCreateParams!.max_tokens).toBeDefined();
      expect(typeof lastCreateParams!.max_tokens).toBe('number');
    });
  });

  // =========================================================================
  // Response parsing
  // =========================================================================

  describe('response parsing', () => {
    it('should parse text response', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: { content: 'Hello from Groq!', tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 30, completion_tokens: 10 },
      };

      const result = await chatOpenAICompatible(
        'groq',
        [{ role: 'user', content: 'hi' }],
        [],
        'llama-3.3-70b'
      );

      expect(result.content).toBe('Hello from Groq!');
      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 10 });
    });

    it('should parse response with tool calls', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: {
              content: 'Reading file...',
              tool_calls: [
                {
                  id: 'call_xyz',
                  type: 'function',
                  function: { name: 'read_file', arguments: '{"path":"/tmp/test.txt"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      };

      const result = await chatOpenAICompatible(
        'openrouter',
        [{ role: 'user', content: 'read file' }],
        makeTools(),
        'model'
      );

      expect(result.content).toBe('Reading file...');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]).toEqual({
        id: 'call_xyz',
        name: 'read_file',
        arguments: { path: '/tmp/test.txt' },
      });
    });

    it('should handle null content in response', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: { content: null, tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
      };

      const result = await chatOpenAICompatible(
        'groq',
        [{ role: 'user', content: 'hi' }],
        [],
        'model'
      );

      expect(result.content).toBe('');
    });

    it('should handle response without usage data', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: { content: 'hello', tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
      };

      const result = await chatOpenAICompatible(
        'ollama',
        [{ role: 'user', content: 'hi' }],
        [],
        'llama3.3'
      );

      expect(result.usage).toBeUndefined();
    });
  });

  // =========================================================================
  // Finish reason mapping
  // =========================================================================

  describe('finish reason mapping', () => {
    it('should map tool_calls to tool_use', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'c1', type: 'function', function: { name: 'think', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      };

      const result = await chatOpenAICompatible(
        'groq',
        [{ role: 'user', content: 'think' }],
        makeTools(),
        'model'
      );

      expect(result.finishReason).toBe('tool_use');
    });

    it('should map length to length', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: { content: 'truncated...', tool_calls: undefined },
            finish_reason: 'length',
          },
        ],
      };

      const result = await chatOpenAICompatible(
        'together',
        [{ role: 'user', content: 'write a lot' }],
        [],
        'model'
      );

      expect(result.finishReason).toBe('length');
    });

    it('should default to stop for other finish reasons', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: { content: 'done', tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
      };

      const result = await chatOpenAICompatible(
        'mistral',
        [{ role: 'user', content: 'hi' }],
        [],
        'model'
      );

      expect(result.finishReason).toBe('stop');
    });
  });

  // =========================================================================
  // Streaming
  // =========================================================================

  describe('streaming', () => {
    it('should handle text streaming', async () => {
      mockStreamChunks = [
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];

      const tokens: string[] = [];
      const result = await chatOpenAICompatible(
        'groq',
        [{ role: 'user', content: 'hi' }],
        [],
        'model',
        (token) => tokens.push(token)
      );

      expect(tokens).toEqual(['Hello', ' world']);
      expect(result.content).toBe('Hello world');
      expect(result.finishReason).toBe('stop');
    });

    it('should handle tool call streaming with deltas', async () => {
      mockStreamChunks = [
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                function: { name: 'read_file', arguments: '' },
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
                function: { arguments: '{"path"' },
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
                function: { arguments: ':"/tmp/test.txt"}' },
              }],
            },
            finish_reason: null,
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ];

      const tokens: string[] = [];
      const result = await chatOpenAICompatible(
        'openrouter',
        [{ role: 'user', content: 'read file' }],
        makeTools(),
        'model',
        (token) => tokens.push(token)
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0]).toEqual({
        id: 'call_1',
        name: 'read_file',
        arguments: { path: '/tmp/test.txt' },
      });
      expect(result.finishReason).toBe('tool_use');
    });

    it('should handle mixed text and tool call streaming', async () => {
      mockStreamChunks = [
        { choices: [{ delta: { content: 'Reading...' }, finish_reason: null }] },
        {
          choices: [{
            delta: {
              tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"path":"/x"}' } }],
            },
            finish_reason: null,
          }],
        },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      ];

      const tokens: string[] = [];
      const result = await chatOpenAICompatible(
        'together',
        [{ role: 'user', content: 'read' }],
        makeTools(),
        'model',
        (token) => tokens.push(token)
      );

      expect(tokens).toEqual(['Reading...']);
      expect(result.content).toBe('Reading...');
      expect(result.toolCalls).toHaveLength(1);
      expect(result.finishReason).toBe('tool_use');
    });

    it('should handle length finish reason in streaming', async () => {
      mockStreamChunks = [
        { choices: [{ delta: { content: 'long text...' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'length' }] },
      ];

      const result = await chatOpenAICompatible(
        'fireworks',
        [{ role: 'user', content: 'write a novel' }],
        [],
        'model',
        () => {}
      );

      expect(result.finishReason).toBe('length');
    });

    it('should handle empty chunks gracefully', async () => {
      mockStreamChunks = [
        { choices: [] },
        { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
      ];

      const tokens: string[] = [];
      const result = await chatOpenAICompatible(
        'groq',
        [{ role: 'user', content: 'hi' }],
        [],
        'model',
        (token) => tokens.push(token)
      );

      expect(tokens).toEqual(['Hello']);
      expect(result.content).toBe('Hello');
    });
  });

  // =========================================================================
  // Ollama fallback
  // =========================================================================

  describe('Ollama fallback', () => {
    it('should attempt fallback model when Ollama returns 404', async () => {
      // First call throws 404, second succeeds
      mockCreateThrows = Object.assign(new Error('model not found'), { status: 404 });
      mockCreateResponse = {
        choices: [
          {
            message: { content: 'from fallback model', tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
      };

      const result = await chatOpenAICompatible(
        'ollama',
        [{ role: 'user', content: 'hi' }],
        [],
        'nonexistent-model'
      );

      expect(result.content).toBe('from fallback model');
      // Should have been called twice (original + fallback)
      expect(createCallCount).toBe(2);
    });

    it('should not attempt fallback for non-Ollama providers', async () => {
      mockCreateThrows = Object.assign(new Error('not found'), { status: 404 });

      await expect(
        chatOpenAICompatible('groq', [{ role: 'user', content: 'hi' }], [], 'model')
      ).rejects.toThrow();

      expect(createCallCount).toBe(1);
    });
  });

  // =========================================================================
  // Complete conversation flow
  // =========================================================================

  describe('complete conversation flow', () => {
    it('should handle full tool-use conversation through compat provider', async () => {
      mockCreateResponse = {
        choices: [
          {
            message: { content: 'Here are the files.', tool_calls: undefined },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 200, completion_tokens: 30 },
      };

      const messages: Message[] = [
        { role: 'system', content: 'You are a helpful file assistant.' },
        { role: 'user', content: 'What files are in /tmp?' },
        {
          role: 'assistant',
          content: 'Checking...',
          toolCalls: [{ id: 'tc_1', name: 'shell', arguments: { command: 'ls /tmp' } }],
        },
        { role: 'tool', content: 'a.txt\nb.txt', toolCallId: 'tc_1' },
      ];

      const result = await chatOpenAICompatible(
        'openrouter',
        messages,
        makeTools(),
        'anthropic/claude-sonnet-4'
      );

      // Verify the request was built correctly
      const msgs = lastCreateParams!.messages as Array<Record<string, unknown>>;
      expect(msgs).toHaveLength(4);
      expect(msgs[0].role).toBe('system');
      expect(msgs[3].role).toBe('tool');

      // Verify response
      expect(result.content).toBe('Here are the files.');
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 30 });
    });
  });
});
