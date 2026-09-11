import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/config.js', () => ({
  getApiKey: vi.fn(() => 'google-test-key'),
  getBaseUrl: vi.fn(() => undefined),
}));

const generateContent = vi.fn();
const generateContentStream = vi.fn();
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent, generateContentStream };
    constructor(_opts: unknown) {}
  },
}));

import { chatGoogle } from '../src/providers/google.js';

describe('Google GenAI maintained SDK adapter', () => {
  beforeEach(() => {
    generateContent.mockReset();
    generateContentStream.mockReset();
  });
  afterEach(() => {});

  it('sends multimodal content and parses function calls', async () => {
    generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ text: 'I will inspect it.' }, { functionCall: { name: 'read_file', args: { path: 'a.txt' } } }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 7 },
    });
    const response = await chatGoogle([{ role: 'system', content: 'Be concise' }, { role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image', mediaType: 'image/png', data: 'abc' }] }], [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' } }, required: ['path'] } }], 'gemini-2.5-flash');
    expect(response.content).toBe('I will inspect it.');
    expect(response.toolCalls?.[0]?.name).toBe('read_file');
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(generateContent).toHaveBeenCalledOnce();
    expect(generateContent.mock.calls[0][0].config.systemInstruction).toBe('Be concise');
  });

  it('streams tokens and honors cancellation checks', async () => {
    generateContentStream.mockResolvedValue((async function* () {
      yield { candidates: [{ content: { parts: [{ text: 'hello ' }] } }] };
      yield { candidates: [{ content: { parts: [{ text: 'world' }], }, finishReason: 'STOP' }] };
    })());
    const tokens: string[] = [];
    const response = await chatGoogle([{ role: 'user', content: 'hello' }], [], 'gemini-2.5-flash', token => tokens.push(token));
    expect(tokens).toEqual(['hello ', 'world']);
    expect(response.content).toBe('hello world');
  });
});
