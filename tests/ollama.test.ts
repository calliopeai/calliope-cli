import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mock dependencies
// ============================================================================

vi.mock('../src/config.js', () => ({
  getBaseUrl: vi.fn(() => null),
  get: vi.fn(),
}));

vi.mock('../src/model-detection.js', () => ({
  getOllamaFallbackModel: vi.fn(),
  getModelContextLimit: vi.fn(() => 128000),
  getModelMaxOutput: vi.fn(() => 8192),
}));

// Stub fetch globally
vi.stubGlobal('fetch', vi.fn());

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { chatOllama } from '../src/providers/ollama.js';
import * as config from '../src/config.js';
import { getOllamaFallbackModel } from '../src/model-detection.js';
import type { Message, Tool } from '../src/types.js';

// ============================================================================
// Helpers
// ============================================================================

function mockFetchResponse(data: object, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
    body: null,
  };
}

function mockStreamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(chunks[index++]) };
        },
      }),
    },
  };
}

const sampleTool: Tool = {
  name: 'read_file',
  description: 'Read a file',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
    },
    required: ['path'],
  },
};

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: 'llama3.3',
    message: { role: 'assistant', content: 'Hello!' },
    done: true,
    prompt_eval_count: 10,
    eval_count: 20,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(config.getBaseUrl).mockReturnValue(undefined as unknown as string);
});

// We need to reset the module-level toolUnsupportedModels set between certain tests.
// Since it's module-level state, we'll use unique model names to avoid cross-test contamination.

describe('chatOllama', () => {
  // --------------------------------------------------------------------------
  // Basic non-streaming responses
  // --------------------------------------------------------------------------

  describe('non-streaming responses', () => {
    it('returns content-only response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3'
      );

      expect(result.content).toBe('Hello!');
      expect(result.toolCalls).toBeUndefined();
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    });

    it('returns response with tool calls', async () => {
      const data = makeResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              function: { name: 'read_file', arguments: { path: '/tmp/a.txt' } },
            },
          ],
        },
      });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Read file' }],
        [sampleTool],
        'llama3.3'
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].id).toBe('call_1');
      expect(result.toolCalls![0].name).toBe('read_file');
      expect(result.toolCalls![0].arguments).toEqual({ path: '/tmp/a.txt' });
      expect(result.finishReason).toBe('tool_use');
    });

    it('logs cold start when load_duration exceeds 10s', async () => {
      const data = makeResponse({ load_duration: 15_000_000_000 });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      // cold start is just a debugLog, doesn't affect return value
      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3'
      );
      expect(result.content).toBe('Hello!');
    });

    it('does not log cold start for fast loads', async () => {
      const data = makeResponse({ load_duration: 1_000_000_000 });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3'
      );
      expect(result.content).toBe('Hello!');
    });

    it('handles missing usage counts', async () => {
      const data = makeResponse({
        prompt_eval_count: undefined,
        eval_count: undefined,
      });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3'
      );
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('handles missing message content', async () => {
      const data = makeResponse({
        message: { role: 'assistant', content: '' },
      });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3'
      );
      expect(result.content).toBe('');
    });
  });

  // --------------------------------------------------------------------------
  // Streaming responses
  // --------------------------------------------------------------------------

  describe('streaming responses', () => {
    it('streams content chunks and accumulates them', async () => {
      const chunks = [
        JSON.stringify({ message: { role: 'assistant', content: 'Hello' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: ' world' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 5, eval_count: 10 }),
      ];
      vi.mocked(fetch).mockResolvedValueOnce(mockStreamResponse(chunks) as unknown as Response);

      const tokens: string[] = [];
      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3',
        (token) => tokens.push(token)
      );

      expect(result.content).toBe('Hello world');
      expect(tokens).toEqual(['Hello', ' world']);
      expect(result.finishReason).toBe('stop');
      expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 10 });
    });

    it('collects tool calls from stream', async () => {
      const chunks = [
        JSON.stringify({
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: { path: '/tmp' } } }],
          },
          done: false,
        }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 3, eval_count: 7 }),
      ];
      vi.mocked(fetch).mockResolvedValueOnce(mockStreamResponse(chunks) as unknown as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Read' }],
        [sampleTool],
        'llama3.3',
        () => {}
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].name).toBe('read_file');
      expect(result.finishReason).toBe('tool_use');
    });

    it('skips invalid JSON lines in stream', async () => {
      const chunks = [
        'not-json\n' + JSON.stringify({ message: { role: 'assistant', content: 'OK' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }),
      ];
      vi.mocked(fetch).mockResolvedValueOnce(mockStreamResponse(chunks) as unknown as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3',
        () => {}
      );
      expect(result.content).toBe('OK');
    });

    it('throws error when response body is null', async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: null,
      } as unknown as Response);

      await expect(
        chatOllama(
          [{ role: 'user', content: 'Hi' }],
          [],
          'llama3.3',
          () => {}
        )
      ).rejects.toThrow('No response body from Ollama');
    });

    it('handles done chunk without token counts', async () => {
      const chunks = [
        JSON.stringify({ message: { role: 'assistant', content: 'Hi' }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }),
      ];
      vi.mocked(fetch).mockResolvedValueOnce(mockStreamResponse(chunks) as unknown as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3',
        () => {}
      );
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('handles multiple stream reads', async () => {
      // Each chunk as a separate read
      const c1 = JSON.stringify({ message: { role: 'assistant', content: 'A' }, done: false });
      const c2 = JSON.stringify({ message: { role: 'assistant', content: 'B' }, done: false });
      const c3 = JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 1, eval_count: 2 });

      vi.mocked(fetch).mockResolvedValueOnce(mockStreamResponse([c1, c2, c3]) as unknown as Response);

      const tokens: string[] = [];
      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3',
        (t) => tokens.push(t)
      );

      expect(result.content).toBe('AB');
      expect(tokens).toEqual(['A', 'B']);
    });
  });

  // --------------------------------------------------------------------------
  // Message conversion (toOllamaMessages)
  // --------------------------------------------------------------------------

  describe('message conversion', () => {
    it('converts string content messages', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
        [],
        'llama3.3'
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' },
      ]);
    });

    it('converts array content (TextContent blocks)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Line 1' },
              { type: 'text', text: 'Line 2' },
            ],
          },
        ],
        [],
        'llama3.3'
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages[0].content).toBe('Line 1\nLine 2');
    });

    it('converts tool result messages', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [
          { role: 'user', content: 'Read file' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/tmp' } }],
          },
          { role: 'tool', content: 'file contents here', toolCallId: 'tc1' },
        ],
        [sampleTool],
        'llama3.3'
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages[2]).toEqual({ role: 'tool', content: 'file contents here' });
    });

    it('converts tool result with non-string content via JSON.stringify', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const messages: Message[] = [
        { role: 'tool', content: [{ type: 'text', text: 'result' }] as any, toolCallId: 'tc1' },
      ];

      await chatOllama(messages, [], 'llama3.3');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages[0].content).toBe(JSON.stringify([{ type: 'text', text: 'result' }]));
    });

    it('converts assistant messages with toolCalls', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [
          {
            role: 'assistant',
            content: 'Let me read that',
            toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }],
          },
        ],
        [sampleTool],
        'llama3.3'
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages[0]).toEqual({
        role: 'assistant',
        content: 'Let me read that',
        tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: { path: '/a' } } }],
      });
    });

    it('handles assistant toolCalls with non-string content', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const messages: Message[] = [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'planning' }] as any,
          toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }],
        },
      ];

      await chatOllama(messages, [sampleTool], 'llama3.3');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages[0].content).toBe(JSON.stringify([{ type: 'text', text: 'planning' }]));
    });

    it('handles assistant toolCalls with empty content', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }],
          },
        ],
        [sampleTool],
        'llama3.3'
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages[0].content).toBe('');
    });

    it('filters image blocks from array content', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this' },
              { type: 'image', mediaType: 'image/png', data: 'abc123' },
            ] as any,
          },
        ],
        [],
        'llama3.3'
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      // Image blocks are filtered, only text blocks remain
      expect(body.messages[0].content).toBe('Look at this');
    });

    it('handles non-string non-array content with JSON.stringify', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const messages: Message[] = [
        { role: 'user', content: { custom: 'data' } as any },
      ];

      await chatOllama(messages, [], 'llama3.3');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.messages[0].content).toBe('{"custom":"data"}');
    });

    it('stripToolHistory=true filters tool messages and tool-only assistant messages', async () => {
      // We need to trigger stripToolHistory=true path, which happens when model is in toolUnsupportedModels.
      // First, make a tool error to add model to the set.
      const toolErrorModel = 'strip-test-model';

      // First call: 400 tool error → adds to toolUnsupportedModels
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockFetchResponse(
          { error: 'does not support tools' },
          false,
          400
        ) as Response)
        // Retry without tools succeeds
        .mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [sampleTool],
        toolErrorModel
      );

      // Now the model is in toolUnsupportedModels. Second call should strip tool history.
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const messages: Message[] = [
        { role: 'user', content: 'Read file' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'tc1', name: 'read_file', arguments: { path: '/a' } }],
        },
        { role: 'tool', content: 'file data', toolCallId: 'tc1' },
        { role: 'assistant', content: 'Here is the file content' },
        { role: 'user', content: 'Thanks' },
      ];

      await chatOllama(messages, [sampleTool], toolErrorModel);

      const body = JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string);
      // Tool messages and tool-only assistant messages should be stripped
      expect(body.messages).toEqual([
        { role: 'user', content: 'Read file' },
        { role: 'assistant', content: 'Here is the file content' },
        { role: 'user', content: 'Thanks' },
      ]);
      // Tools should be empty
      expect(body.tools).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Tool conversion (toOllamaTools)
  // --------------------------------------------------------------------------

  describe('tool conversion', () => {
    it('converts Tool[] to OllamaTool[] format', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const tools: Tool[] = [
        {
          name: 'write_file',
          description: 'Write a file',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path' },
              content: { type: 'string', description: 'Content' },
            },
            required: ['path', 'content'],
          },
        },
      ];

      await chatOllama([{ role: 'user', content: 'Hi' }], tools, 'llama3.3');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.tools).toEqual([
        {
          type: 'function',
          function: {
            name: 'write_file',
            description: 'Write a file',
            parameters: tools[0].parameters,
          },
        },
      ]);
    });

    it('omits tools from request when empty', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama([{ role: 'user', content: 'Hi' }], [], 'llama3.3');

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.tools).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Tool call parsing (parseOllamaToolCalls)
  // --------------------------------------------------------------------------

  describe('tool call parsing', () => {
    it('returns empty array for undefined tool_calls', async () => {
      const data = makeResponse({
        message: { role: 'assistant', content: 'No tools', tool_calls: undefined },
      });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3'
      );
      expect(result.toolCalls).toBeUndefined();
    });

    it('returns empty array for empty tool_calls', async () => {
      const data = makeResponse({
        message: { role: 'assistant', content: 'No tools', tool_calls: [] },
      });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3'
      );
      expect(result.toolCalls).toBeUndefined();
    });

    it('auto-generates IDs when tool calls lack them', async () => {
      const data = makeResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { function: { name: 'read_file', arguments: { path: '/tmp' } } },
          ],
        },
      });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Read' }],
        [sampleTool],
        'llama3.3'
      );

      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls![0].id).toMatch(/^call_\d+_0$/);
    });

    it('handles multiple tool calls', async () => {
      const data = makeResponse({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            { id: 'a', function: { name: 'read_file', arguments: { path: '/a' } } },
            { id: 'b', function: { name: 'read_file', arguments: { path: '/b' } } },
          ],
        },
      });
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(data) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Read both' }],
        [sampleTool],
        'llama3.3'
      );

      expect(result.toolCalls).toHaveLength(2);
      expect(result.toolCalls![0].id).toBe('a');
      expect(result.toolCalls![1].id).toBe('b');
    });
  });

  // --------------------------------------------------------------------------
  // getBaseUrl
  // --------------------------------------------------------------------------

  describe('getBaseUrl', () => {
    it('uses default localhost:11434 when no config', async () => {
      vi.mocked(config.getBaseUrl).mockReturnValue(undefined as unknown as string);
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama([{ role: 'user', content: 'Hi' }], [], 'llama3.3');

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://localhost:11434/api/chat');
    });

    it('uses custom base URL from config', async () => {
      vi.mocked(config.getBaseUrl).mockReturnValue('http://myserver:8080' as unknown as string);
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama([{ role: 'user', content: 'Hi' }], [], 'llama3.3');

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://myserver:8080/api/chat');
    });

    it('strips trailing /v1 from base URL', async () => {
      vi.mocked(config.getBaseUrl).mockReturnValue('http://myserver:8080/v1' as unknown as string);
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama([{ role: 'user', content: 'Hi' }], [], 'llama3.3');

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe('http://myserver:8080/api/chat');
    });
  });

  // --------------------------------------------------------------------------
  // Error handling
  // --------------------------------------------------------------------------

  describe('error handling', () => {
    it('throws on non-ok response', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'server error' },
        false,
        500
      ) as Response);

      await expect(
        chatOllama([{ role: 'user', content: 'Hi' }], [], 'llama3.3')
      ).rejects.toThrow('Ollama API error 500');
    });

    it('model not found triggers tryFallback', async () => {
      // First call: 404 error
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'model not found' },
        false,
        404
      ) as Response);

      // Fallback call succeeds
      vi.mocked(getOllamaFallbackModel).mockResolvedValueOnce('codellama:7b');
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse({
        model: 'codellama:7b',
      })) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'missing-model'
      );

      expect(result.content).toBe('Hello!');
      // Second fetch should use fallback model
      const secondBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
      expect(secondBody.model).toBe('codellama:7b');
    });

    it('model not found with "not found" in error text triggers fallback', async () => {
      // The doChat function throws the error. 400 with "not found" text.
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'model "xyz" not found' },
        false,
        400
      ) as Response);

      vi.mocked(getOllamaFallbackModel).mockResolvedValueOnce('llama3:latest');
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'xyz'
      );
      expect(result.content).toBe('Hello!');
    });

    it('tool error (400) retries without tools and adds to unsupported set', async () => {
      const toolErrorModel2 = 'tool-error-model-2';

      // First call: 400 with tool error
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'does not support tools' },
        false,
        400
      ) as Response);

      // Retry without tools
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Read it' }],
        [sampleTool],
        toolErrorModel2
      );

      expect(result.content).toBe('Hello!');

      // Second call should have no tools
      const retryBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
      expect(retryBody.tools).toBeUndefined();
    });

    it('known tool-unsupported model skips tools on subsequent calls', async () => {
      const knownUnsupported = 'known-unsupported-model';

      // First: trigger tool error to add to map
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockFetchResponse(
          { error: 'does not support tools' },
          false,
          400
        ) as Response)
        .mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [sampleTool],
        knownUnsupported
      );

      // Second call: should skip tools automatically
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [{ role: 'user', content: 'Again' }],
        [sampleTool],
        knownUnsupported
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[2][1]!.body as string);
      expect(body.tools).toBeUndefined();
    });

    it('non-tool 400 error is propagated (no tools in request)', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'some other error' },
        false,
        400
      ) as Response);

      await expect(
        chatOllama([{ role: 'user', content: 'Hi' }], [], 'llama3.3')
      ).rejects.toThrow('Ollama API error 400');
    });

    it('non-tool error with tools present is propagated if not tool-related', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'out of memory' },
        false,
        500
      ) as Response);

      await expect(
        chatOllama([{ role: 'user', content: 'Hi' }], [sampleTool], 'llama3.3')
      ).rejects.toThrow('Ollama API error 500');
    });

    it('propagates non-Error thrown values', async () => {
      vi.mocked(fetch).mockRejectedValueOnce('string error');

      // The catch block does String(error) for non-Error values.
      // "string error" doesn't contain "not found" or tool keywords, so it should rethrow.
      await expect(
        chatOllama([{ role: 'user', content: 'Hi' }], [], 'llama3.3')
      ).rejects.toBe('string error');
    });
  });

  // --------------------------------------------------------------------------
  // tryFallback
  // --------------------------------------------------------------------------

  describe('tryFallback', () => {
    it('throws helpful error when no fallback model available', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'model not found' },
        false,
        404
      ) as Response);

      vi.mocked(getOllamaFallbackModel).mockResolvedValueOnce(null);

      await expect(
        chatOllama([{ role: 'user', content: 'Hi' }], [], 'nonexistent')
      ).rejects.toThrow('Ollama model "nonexistent" not found. Pull it with: ollama pull nonexistent');
    });

    it('throws when fallback is same as original model', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'model not found' },
        false,
        404
      ) as Response);

      vi.mocked(getOllamaFallbackModel).mockResolvedValueOnce('same-model');

      await expect(
        chatOllama([{ role: 'user', content: 'Hi' }], [], 'same-model')
      ).rejects.toThrow('Ollama model "same-model" not found. Pull it with: ollama pull same-model');
    });

    it('fallback model found retries with it', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'not found' },
        false,
        404
      ) as Response);

      vi.mocked(getOllamaFallbackModel).mockResolvedValueOnce('fallback-model');
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      const result = await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [sampleTool],
        'original-model'
      );

      expect(result.content).toBe('Hello!');
      const fallbackBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
      expect(fallbackBody.model).toBe('fallback-model');
      // Tools should still be passed through
      expect(fallbackBody.tools).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // isToolError
  // --------------------------------------------------------------------------

  describe('isToolError detection', () => {
    const toolErrorStrings = [
      'does not support tools',
      'invalid tool_calls format',
      'tools are not supported',
      'unknown field: tool in request',
    ];

    for (const errStr of toolErrorStrings) {
      it(`detects "${errStr}" as tool error`, async () => {
        const modelName = `tool-err-${errStr.replace(/\s+/g, '-').toLowerCase()}`;

        vi.mocked(fetch)
          .mockResolvedValueOnce(mockFetchResponse(
            { error: errStr },
            false,
            400
          ) as Response)
          .mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

        const result = await chatOllama(
          [{ role: 'user', content: 'Hi' }],
          [sampleTool],
          modelName
        );

        expect(result.content).toBe('Hello!');
      });
    }

    it('does not treat generic errors as tool errors', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(
        { error: 'out of memory' },
        false,
        400
      ) as Response);

      await expect(
        chatOllama([{ role: 'user', content: 'Hi' }], [sampleTool], 'llama3.3')
      ).rejects.toThrow('Ollama API error 400');
    });
  });

  // --------------------------------------------------------------------------
  // Request format validation
  // --------------------------------------------------------------------------

  describe('request format', () => {
    it('sends correct request structure for non-streaming', async () => {
      vi.mocked(fetch).mockResolvedValueOnce(mockFetchResponse(makeResponse()) as Response);

      await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [sampleTool],
        'llama3.3'
      );

      const [url, options] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe('http://localhost:11434/api/chat');
      expect(options!.method).toBe('POST');
      expect(options!.headers).toEqual({ 'Content-Type': 'application/json' });

      const body = JSON.parse(options!.body as string);
      expect(body.model).toBe('llama3.3');
      expect(body.stream).toBe(false);
      expect(body.messages).toHaveLength(1);
      expect(body.tools).toHaveLength(1);
    });

    it('sends stream=true when onToken is provided', async () => {
      const chunks = [
        JSON.stringify({ message: { role: 'assistant', content: 'Hi' }, done: true }),
      ];
      vi.mocked(fetch).mockResolvedValueOnce(mockStreamResponse(chunks) as unknown as Response);

      await chatOllama(
        [{ role: 'user', content: 'Hi' }],
        [],
        'llama3.3',
        () => {}
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.stream).toBe(true);
    });
  });
});
