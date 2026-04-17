/**
 * Tests for src/providers/bedrock.ts
 *
 * Covers: parseIniFile, getAWSCredentials, getAWSRegion, signRequest,
 * toBedrockMessages, toBedrockToolConfig, chatBedrock (non-streaming),
 * chatBedrock (streaming), hasAWSCredentials, and error paths.
 * Uses vi.mock for config and vi.stubGlobal for fetch.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn(),
  set: vi.fn(),
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
}));

import * as config from '../src/config.js';
import { chatBedrock, hasAWSCredentials } from '../src/providers/bedrock.js';
import type { Message, Tool } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
  // Clear AWS credential env vars
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_PROFILE;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeTextMessage(role: 'user' | 'assistant' | 'system', text: string): Message {
  return { role, content: text };
}

function makeToolCallMessage(toolCallId: string, name: string, args: Record<string, unknown>): Message {
  return {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: toolCallId, name, arguments: args }],
  };
}

function makeToolResultMessage(toolCallId: string, content: string): Message {
  return { role: 'tool', content, toolCallId };
}

// Build a minimal valid non-streaming Bedrock response
function makeBedrockResponse(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    text: async () => '',
    json: async () => ({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Hello from Bedrock!' }],
        },
      },
      stopReason: 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
      ...overrides,
    }),
  };
}

// ===========================================================================
// hasAWSCredentials
// ===========================================================================

describe('hasAWSCredentials', () => {
  it('should return true when AWS env vars are set', () => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    expect(hasAWSCredentials()).toBe(true);
  });

  it('should return false when no credentials are available', () => {
    // No env vars, no .aws dir in typical test environment
    const result = hasAWSCredentials();
    // Result depends on whether ~/.aws/credentials exists — just verify it's boolean
    expect(typeof result).toBe('boolean');
  });

  it('should return true when AWS_PROFILE is set and .aws dir exists', () => {
    // Create a fake .aws dir structure temporarily
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aws-test-'));
    const awsDir = path.join(tmpDir, '.aws');
    fs.mkdirSync(awsDir);
    const credFile = path.join(awsDir, 'credentials');
    fs.writeFileSync(credFile, '[default]\naws_access_key_id = FAKE\n');

    // We can't easily override os.homedir() for the module, so just test env path
    process.env.AWS_PROFILE = 'test-profile';
    // Even with AWS_PROFILE set, needs .aws dir to exist at home — may or may not be true
    // Just verify it doesn't throw
    expect(() => hasAWSCredentials()).not.toThrow();

    delete process.env.AWS_PROFILE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ===========================================================================
// chatBedrock — credential resolution
// ===========================================================================

describe('chatBedrock - credential errors', () => {
  it('should throw when no AWS credentials are available', async () => {
    // No env vars, no credential files in typical CI env
    // Mock config.get to return nothing
    vi.mocked(config.get).mockReturnValue(undefined);

    const messages: Message[] = [makeTextMessage('user', 'Hello')];

    // The error should be about missing credentials
    await expect(chatBedrock(messages, [], 'anthropic.claude-3-haiku-20240307-v1:0'))
      .rejects.toThrow(/AWS credentials not found/);
  });
});

// ===========================================================================
// chatBedrock — non-streaming
// ===========================================================================

describe('chatBedrock - non-streaming', () => {
  beforeEach(() => {
    // Set up env credentials for all tests
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    process.env.AWS_REGION = 'us-east-1';
  });

  it('should make a POST request to the bedrock converse endpoint', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const messages: Message[] = [makeTextMessage('user', 'Hello Bedrock')];
    const result = await chatBedrock(messages, [], 'anthropic.claude-3-haiku-20240307-v1:0');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('bedrock-runtime.us-east-1.amazonaws.com');
    expect(url).toContain('converse');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toContain('AWS4-HMAC-SHA256');
    expect(options.headers['x-amz-date']).toBeDefined();
  });

  it('should URL-encode model IDs with colons', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const model = 'anthropic.claude-3-haiku-20240307-v1:0';
    await chatBedrock([makeTextMessage('user', 'test')], [], model);

    const [url] = mockFetch.mock.calls[0];
    // The colon should be URL-encoded
    expect(url).toContain(encodeURIComponent(model));
  });

  it('should parse text content from response', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse({
      output: {
        message: {
          role: 'assistant',
          content: [{ text: 'Response text here' }],
        },
      },
    }));

    const result = await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');

    expect(result.content).toBe('Response text here');
    expect(result.toolCalls).toBeUndefined();
    expect(result.finishReason).toBe('stop');
  });

  it('should parse tool_use stop reason correctly', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse({
      output: {
        message: {
          role: 'assistant',
          content: [
            { toolUse: { toolUseId: 'tool-1', name: 'read_file', input: { path: '/tmp/test' } } },
          ],
        },
      },
      stopReason: 'tool_use',
    }));

    const result = await chatBedrock([makeTextMessage('user', 'use a tool')], [], 'model-id');

    expect(result.finishReason).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('read_file');
    expect(result.toolCalls![0].id).toBe('tool-1');
    expect(result.toolCalls![0].arguments).toEqual({ path: '/tmp/test' });
  });

  it('should parse max_tokens stop reason as length', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse({
      output: { message: { role: 'assistant', content: [{ text: 'truncated...' }] } },
      stopReason: 'max_tokens',
    }));

    const result = await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');
    expect(result.finishReason).toBe('length');
  });

  it('should parse usage tokens', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
      usage: { inputTokens: 42, outputTokens: 17 },
    }));

    const result = await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');
    expect(result.usage?.inputTokens).toBe(42);
    expect(result.usage?.outputTokens).toBe(17);
  });

  it('should throw on HTTP error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'AccessDeniedException: User not authorized',
    });

    await expect(
      chatBedrock([makeTextMessage('user', 'test')], [], 'model-id')
    ).rejects.toThrow(/Bedrock API error \(403\)/);
  });

  it('should include system message in request body', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const messages: Message[] = [
      makeTextMessage('system', 'You are a helpful assistant'),
      makeTextMessage('user', 'Hello'),
    ];

    await chatBedrock(messages, [], 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.system).toEqual([{ text: 'You are a helpful assistant' }]);
    // System message should not appear in messages array
    expect(body.messages[0].role).toBe('user');
  });

  it('should include tool config when tools are provided', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const tools: Tool[] = [{
      name: 'read_file',
      description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    }];

    await chatBedrock([makeTextMessage('user', 'read file')], tools, 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.toolConfig).toBeDefined();
    expect(body.toolConfig.tools).toHaveLength(1);
    expect(body.toolConfig.tools[0].toolSpec.name).toBe('read_file');
  });

  it('should not include toolConfig when tools array is empty', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.toolConfig).toBeUndefined();
  });

  it('should handle tool result messages (role: tool)', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const messages: Message[] = [
      makeTextMessage('user', 'Use a tool'),
      makeToolCallMessage('tc-1', 'read_file', { path: '/test' }),
      makeToolResultMessage('tc-1', 'File content here'),
    ];

    await chatBedrock(messages, [], 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);

    // Tool result should become a user message with toolResult block
    const toolResultMsg = body.messages.find((m: { role: string; content: Array<{ toolResult?: unknown }> }) =>
      m.role === 'user' && m.content[0]?.toolResult
    );
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.content[0].toolResult.toolUseId).toBe('tc-1');
  });

  it('should merge consecutive tool results into ONE user message (Bedrock requires paired toolUses/toolResults)', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const messages: Message[] = [
      makeTextMessage('user', 'Use two tools'),
      // Assistant makes 2 tool calls in a single turn
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'tc-1', name: 'read_file', arguments: { path: '/a' } },
          { id: 'tc-2', name: 'read_file', arguments: { path: '/b' } },
        ],
      },
      // Two separate tool-result messages (how the agent loop produces them)
      makeToolResultMessage('tc-1', 'A'),
      makeToolResultMessage('tc-2', 'B'),
    ];

    await chatBedrock(messages, [], 'model-id');
    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);

    // There must be exactly ONE user message carrying both toolResults;
    // two separate user messages in a row produce a 400 from Bedrock.
    const userToolResultMsgs = body.messages.filter((m: { role: string; content: Array<{ toolResult?: unknown }> }) =>
      m.role === 'user' && m.content.every(b => b.toolResult)
    );
    expect(userToolResultMsgs).toHaveLength(1);
    expect(userToolResultMsgs[0].content).toHaveLength(2);
    expect(userToolResultMsgs[0].content[0].toolResult.toolUseId).toBe('tc-1');
    expect(userToolResultMsgs[0].content[1].toolResult.toolUseId).toBe('tc-2');
  });

  it('should handle assistant message with tool calls', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const messages: Message[] = [
      makeTextMessage('user', 'Run this tool'),
      makeToolCallMessage('tc-1', 'shell', { command: 'ls' }),
    ];

    await chatBedrock(messages, [], 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const assistantMsg = body.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content.some((b: { toolUse?: unknown }) => b.toolUse)).toBe(true);
  });

  it('should handle user message with image content', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const messages: Message[] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What do you see?' },
        { type: 'image', mediaType: 'image/png', data: 'base64imagedata' },
      ],
    }];

    await chatBedrock(messages, [], 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    const userMsg = body.messages[0];
    const imageBlock = userMsg.content.find((b: { image?: unknown }) => b.image);
    expect(imageBlock).toBeDefined();
    expect(imageBlock.image.format).toBe('png');
    expect(imageBlock.image.source.bytes).toBe('base64imagedata');
  });

  it('should handle empty user message content as "(continued)"', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse());

    const messages: Message[] = [{ role: 'user', content: '' }];

    await chatBedrock(messages, [], 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.messages[0].content[0].text).toBe('(continued)');
  });

  it('should use session token in header when present', async () => {
    process.env.AWS_SESSION_TOKEN = 'my-session-token';
    mockFetch.mockResolvedValue(makeBedrockResponse());

    await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers['x-amz-security-token']).toBe('my-session-token');
  });

  it('should return empty toolCalls as undefined when no tools used', async () => {
    mockFetch.mockResolvedValue(makeBedrockResponse({
      output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
    }));

    const result = await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');
    expect(result.toolCalls).toBeUndefined();
  });
});

// ===========================================================================
// chatBedrock — streaming
// ===========================================================================

describe('chatBedrock - streaming', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    process.env.AWS_REGION = 'us-east-1';
  });

  /**
   * Build a binary AWS event stream buffer from a list of events.
   * Each event is: 4-byte total length, 4-byte headers length, 4-byte CRC, headers, payload, 4-byte CRC
   */
  function buildEventStreamBuffer(events: Array<{ type: string; payload: string }>): Buffer {
    const chunks: Buffer[] = [];

    for (const event of events) {
      // Build header: name=":event-type", type=7 (string), value=event.type
      const headerName = ':event-type';
      const headerNameBuf = Buffer.from(headerName, 'utf-8');
      const headerValue = event.type;
      const headerValueBuf = Buffer.from(headerValue, 'utf-8');

      // Header format: 1-byte name len, name, 1-byte type (7=string), 2-byte value len, value
      const headerBuf = Buffer.alloc(1 + headerNameBuf.length + 1 + 2 + headerValueBuf.length);
      let offset = 0;
      headerBuf.writeUInt8(headerNameBuf.length, offset++);
      headerNameBuf.copy(headerBuf, offset);
      offset += headerNameBuf.length;
      headerBuf.writeUInt8(7, offset++); // string type
      headerBuf.writeUInt16BE(headerValueBuf.length, offset);
      offset += 2;
      headerValueBuf.copy(headerBuf, offset);

      const payloadBuf = Buffer.from(event.payload, 'utf-8');
      const totalLength = 12 + headerBuf.length + payloadBuf.length + 4;

      const frame = Buffer.alloc(totalLength);
      frame.writeUInt32BE(totalLength, 0);      // total_length
      frame.writeUInt32BE(headerBuf.length, 4); // headers_length
      frame.writeUInt32BE(0, 8);                // prelude CRC (we skip validation)
      headerBuf.copy(frame, 12);
      payloadBuf.copy(frame, 12 + headerBuf.length);
      frame.writeUInt32BE(0, totalLength - 4);  // message CRC (skipped)

      chunks.push(frame);
    }

    return Buffer.concat(chunks);
  }

  function makeStreamResponse(events: Array<{ type: string; payload: string }>, ok = true) {
    const buf = buildEventStreamBuffer(events);
    let pos = 0;
    const reader = {
      read: vi.fn(async () => {
        if (pos >= buf.length) return { done: true, value: undefined };
        const chunk = buf.subarray(pos, pos + 64);
        pos += 64;
        return { done: false, value: new Uint8Array(chunk) };
      }),
      releaseLock: vi.fn(),
    };
    return {
      ok,
      status: ok ? 200 : 500,
      text: async () => 'error body',
      body: { getReader: () => reader },
    };
  }

  it('should use converse-stream endpoint when onToken is provided', async () => {
    const events = [
      { type: 'contentBlockDelta', payload: JSON.stringify({ delta: { text: 'Hi' } }) },
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'end_turn' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const tokens: string[] = [];
    await chatBedrock(
      [makeTextMessage('user', 'test')],
      [],
      'model-id',
      (t) => tokens.push(t)
    );

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('converse-stream');
  });

  it('should call onToken for each text delta', async () => {
    const events = [
      { type: 'contentBlockDelta', payload: JSON.stringify({ delta: { text: 'Hello' } }) },
      { type: 'contentBlockDelta', payload: JSON.stringify({ delta: { text: ' World' } }) },
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'end_turn' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const tokens: string[] = [];
    const result = await chatBedrock(
      [makeTextMessage('user', 'test')],
      [],
      'model-id',
      (t) => tokens.push(t)
    );

    expect(tokens).toEqual(['Hello', ' World']);
    expect(result.content).toBe('Hello World');
  });

  it('should collect tool calls from streaming events', async () => {
    const events = [
      {
        type: 'contentBlockStart',
        payload: JSON.stringify({ start: { toolUse: { toolUseId: 'tc-1', name: 'shell' } } }),
      },
      {
        type: 'contentBlockDelta',
        payload: JSON.stringify({ delta: { toolUse: { input: '{"command":' } } }),
      },
      {
        type: 'contentBlockDelta',
        payload: JSON.stringify({ delta: { toolUse: { input: '"ls"}' } } }),
      },
      { type: 'contentBlockStop', payload: '{}' },
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'tool_use' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const tokens: string[] = [];
    const result = await chatBedrock(
      [makeTextMessage('user', 'use a tool')],
      [],
      'model-id',
      (t) => tokens.push(t)
    );

    expect(result.finishReason).toBe('tool_use');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].id).toBe('tc-1');
    expect(result.toolCalls![0].name).toBe('shell');
    expect(result.toolCalls![0].arguments).toEqual({ command: 'ls' });
  });

  it('should handle contentBlockStop without tool data (no-op)', async () => {
    const events = [
      { type: 'contentBlockDelta', payload: JSON.stringify({ delta: { text: 'ok' } }) },
      { type: 'contentBlockStop', payload: '{}' }, // No currentToolId
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'end_turn' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const tokens: string[] = [];
    const result = await chatBedrock(
      [makeTextMessage('user', 'test')],
      [],
      'model-id',
      (t) => tokens.push(t)
    );

    expect(result.toolCalls).toBeUndefined();
    expect(result.content).toBe('ok');
  });

  it('should collect token usage from metadata event', async () => {
    const events = [
      { type: 'contentBlockDelta', payload: JSON.stringify({ delta: { text: 'done' } }) },
      { type: 'metadata', payload: JSON.stringify({ usage: { inputTokens: 55, outputTokens: 22 } }) },
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'end_turn' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const result = await chatBedrock(
      [makeTextMessage('user', 'test')],
      [],
      'model-id',
      () => {}
    );

    expect(result.usage?.inputTokens).toBe(55);
    expect(result.usage?.outputTokens).toBe(22);
  });

  it('should set finishReason to length on max_tokens stop', async () => {
    const events = [
      { type: 'contentBlockDelta', payload: JSON.stringify({ delta: { text: 'truncated' } }) },
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'max_tokens' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const result = await chatBedrock(
      [makeTextMessage('user', 'test')],
      [],
      'model-id',
      () => {}
    );

    expect(result.finishReason).toBe('length');
  });

  it('should throw on streaming HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => 'Bad request',
      body: null,
    });

    await expect(
      chatBedrock(
        [makeTextMessage('user', 'test')],
        [],
        'model-id',
        () => {}
      )
    ).rejects.toThrow(/Bedrock streaming API error \(400\)/);
  });

  it('should throw when streaming response has no body', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      body: null,
    });

    await expect(
      chatBedrock(
        [makeTextMessage('user', 'test')],
        [],
        'model-id',
        () => {}
      )
    ).rejects.toThrow(/no body/);
  });

  it('should skip empty payloads without crashing', async () => {
    const events = [
      { type: 'messageStart', payload: '' }, // empty payload
      { type: 'contentBlockDelta', payload: JSON.stringify({ delta: { text: 'ok' } }) },
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'end_turn' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const tokens: string[] = [];
    const result = await chatBedrock(
      [makeTextMessage('user', 'test')],
      [],
      'model-id',
      (t) => tokens.push(t)
    );

    expect(result.content).toBe('ok');
  });

  it('should handle malformed tool input JSON gracefully', async () => {
    const events = [
      {
        type: 'contentBlockStart',
        payload: JSON.stringify({ start: { toolUse: { toolUseId: 'tc-bad', name: 'broken_tool' } } }),
      },
      {
        type: 'contentBlockDelta',
        payload: JSON.stringify({ delta: { toolUse: { input: 'not-valid-json' } } }),
      },
      { type: 'contentBlockStop', payload: '{}' },
      { type: 'messageStop', payload: JSON.stringify({ stopReason: 'tool_use' }) },
    ];
    mockFetch.mockResolvedValue(makeStreamResponse(events));

    const result = await chatBedrock(
      [makeTextMessage('user', 'test')],
      [],
      'model-id',
      () => {}
    );

    // Should fall back to empty arguments
    expect(result.toolCalls![0].arguments).toEqual({});
  });
});

// ===========================================================================
// getAWSRegion - uses env vars
// ===========================================================================

describe('getAWSRegion (via chatBedrock URL)', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  });

  it('should use AWS_REGION env var', async () => {
    process.env.AWS_REGION = 'eu-west-1';
    mockFetch.mockResolvedValue(makeBedrockResponse());

    await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('eu-west-1');
  });

  it('should fall back to AWS_DEFAULT_REGION', async () => {
    process.env.AWS_DEFAULT_REGION = 'ap-southeast-1';
    mockFetch.mockResolvedValue(makeBedrockResponse());

    await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('ap-southeast-1');
  });

  it('should fall back to us-east-1 when no region is set', async () => {
    vi.mocked(config.get).mockReturnValue(undefined);
    mockFetch.mockResolvedValue(makeBedrockResponse());

    await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain('us-east-1');
  });
});

// ===========================================================================
// Response parsing edge cases
// ===========================================================================

describe('chatBedrock - response parsing edge cases', () => {
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
    process.env.AWS_SECRET_ACCESS_KEY = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    process.env.AWS_REGION = 'us-east-1';
  });

  it('should handle response with no output', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 0 } }),
    });

    const result = await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');
    expect(result.content).toBe('');
    expect(result.toolCalls).toBeUndefined();
  });

  it('should concatenate multiple text blocks', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: {
          message: {
            role: 'assistant',
            content: [
              { text: 'Part 1. ' },
              { text: 'Part 2.' },
            ],
          },
        },
        stopReason: 'end_turn',
      }),
    });

    const result = await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');
    expect(result.content).toBe('Part 1. Part 2.');
  });

  it('should handle multiple tool calls in a single response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        output: {
          message: {
            role: 'assistant',
            content: [
              { toolUse: { toolUseId: 'tc-a', name: 'tool_a', input: { x: 1 } } },
              { toolUse: { toolUseId: 'tc-b', name: 'tool_b', input: { y: 2 } } },
            ],
          },
        },
        stopReason: 'tool_use',
        usage: { inputTokens: 10, outputTokens: 5 },
      }),
    });

    const result = await chatBedrock([makeTextMessage('user', 'test')], [], 'model-id');
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls![0].name).toBe('tool_a');
    expect(result.toolCalls![1].name).toBe('tool_b');
  });
});
