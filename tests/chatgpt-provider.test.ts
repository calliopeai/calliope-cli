import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as config from '../src/config.js';
import { ChatGPTStore } from '../src/auth/chatgpt/index.js';
import { chatChatGPT, chatGPTInput, chatGPTModels, assertChatGPTLimits } from '../src/providers/chatgpt.js';
import type { Message, Tool } from '../src/types.js';
import * as fs from 'node:fs';
const tool: Tool = { name: 'read_file', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const messages: Message[] = [{ role: 'system', content: 'Be useful.' }, { role: 'user', content: 'Read the file' }];
const textOutput = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] };
const toolOutput = { type: 'function_call', namespace: 'calliope', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}', id: 'fc_1', status: 'completed' };
const completed = (output: unknown[] = [textOutput]) => ({ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output, usage: { input_tokens: 10, output_tokens: 5 } } });
function stream(events: unknown[]) { return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }); }
function transport(events: unknown[] = [{ type: 'response.output_text.delta', delta: 'Hello' }, completed()]) {
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/models')) return Response.json({ models: [{ slug: 'account-model', display_name: 'Account model', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' }] });
    return stream(events);
  }); vi.stubGlobal('fetch', fetcher); return fetcher;
}
beforeEach(async () => {
  config.resetConfig(); config.setProviderCred('openai', { accessMethod: 'chatgpt', apiKey: 'api-key-must-not-be-used', baseUrl: 'https://wrong.example' });
  const store = new ChatGPTStore(); fs.rmSync(store.directory, { recursive: true, force: true });
  await store.update(state => { state.active = 'oaiapp_test'; state.accounts.oaiapp_test = { clientId: 'oaiapp_test', subject: 'person', scopes: ['chatgpt.tokens.use.direct'], accessToken: 'subscription-token', refreshToken: 'refresh', expiresAt: Date.now() + 3600000 }; });
});
afterEach(() => { vi.unstubAllGlobals(); config.resetConfig(); fs.rmSync(new ChatGPTStore().directory, { recursive: true, force: true }); });
describe('subscription transport', () => {
  it('uses live account models and the fixed Responses endpoint, even without a streaming UI', async () => {
    const f = transport(); const models = await chatGPTModels(); expect(models.map(m => m.id)).toEqual(['account-model']);
    const result = await chatChatGPT(messages, [tool], 'account-model');
    expect(result).toMatchObject({ content: 'Hello', finishReason: 'stop', billing: 'subscription', usage: { inputTokens: 10, outputTokens: 5 } });
    const [url, init] = f.mock.calls.at(-1)!; expect(url).toBe('https://api.openai.com/v1/responses');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer subscription-token');
    const body = JSON.parse(init!.body as string); expect(body).toMatchObject({ store: false, stream: true, model: 'account-model', input: [{ role: 'developer', content: 'Be useful.' }, { role: 'user', content: 'Read the file' }], tools: [{ type: 'namespace', name: 'calliope' }] });
    for (const key of ['temperature', 'max_output_tokens', 'previous_response_id', 'metadata', 'conversation']) expect(body).not.toHaveProperty(key);
    expect(init?.redirect).toBe('error');
  });
  it('returns tool calls to the Calliope runtime and preserves stateless reasoning history', async () => {
    transport([completed([toolOutput])]);
    const result = await chatChatGPT(messages, [tool], 'account-model'); expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: { path: 'README.md' } }]);
    const history: Message[] = [...messages, { role: 'assistant', content: '', toolCalls: result.toolCalls, providerMetadata: result.providerMetadata }, { role: 'tool', toolCallId: 'call_1', content: 'file text' }];
    const replay = chatGPTInput(history, 'oaiapp_test', 'account-model'); expect(replay).toContainEqual(toolOutput); expect(replay.at(-1)).toEqual({ type: 'function_call_output', call_id: 'call_1', output: 'file text' });
    expect(() => chatGPTInput(history, 'oaiapp_other', 'account-model')).toThrow('different account');
  });
  it('converts text and images, and preserves tool names in namespace history', () => {
    const input = chatGPTInput([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AA' }] }, { role: 'assistant', content: 'Reading', toolCalls: [{ id: 'c', name: 'read_file', arguments: {} }] }]);
    expect(input[0]).toMatchObject({ content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA' }] }); expect(input[2]).toMatchObject({ namespace: 'calliope', name: 'read_file' });
  });
  it.each(['response.failed', 'response.incomplete', 'error'])('rejects %s after partial output', async type => {
    transport([{ type: 'response.output_text.delta', delta: 'partial' }, { type }]); const output = vi.fn();
    await expect(chatChatGPT(messages, [], 'account-model', output)).rejects.toThrow('failed'); expect(output).toHaveBeenCalledWith('partial');
  });
  it('rejects a truncated stream', async () => { transport([]); await expect(chatChatGPT(messages, [], 'account-model')).rejects.toThrow('without successful completion'); });
  it.each([{ ...toolOutput, arguments: '{' }, { ...toolOutput, arguments: '[]' }, { ...toolOutput, namespace: 'other' }, { ...toolOutput, name: 'shell' }])('rejects invalid tool outputs %j', async item => { transport([completed([item])]); await expect(chatChatGPT(messages, [tool], 'account-model')).rejects.toThrow(/tool/); });
  it('fails before inference for an unavailable account model', async () => { const f = transport(); await expect(chatChatGPT(messages, [], 'not-in-catalog')).rejects.toThrow('not available'); expect(f).toHaveBeenCalledTimes(1); });
  it('honors cancellation before networking', async () => { const f = transport(); const c = new AbortController(); c.abort(); await expect(chatChatGPT(messages, [], 'account-model', undefined, c.signal)).rejects.toThrow(); expect(f).not.toHaveBeenCalled(); });
  it('redacts transport exceptions', async () => { const f = transport(); f.mockImplementationOnce(async () => Response.json({ models: [{ slug: 'account-model', display_name: 'M', visibility: 'list' }] })).mockRejectedValueOnce(Error('subscription-token')); await expect(chatChatGPT(messages, [], 'account-model')).rejects.toThrow('ChatGPT subscription request failed'); });
  it.each([{ bounded: true }, { maxOutputTokens: 100 }])('rejects unenforceable bounds %j', limits => { expect(() => assertChatGPTLimits(limits)).toThrow('cannot enforce'); });
  it('rejects configured dollar budgets', () => { config.set('budget', { maxCostPerRun: 1 }); expect(() => assertChatGPTLimits()).toThrow('cannot enforce'); });
});
it('explains subscription limits without exposing upstream error text or changing billing', async () => {
  transport([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'secret-token' } } }]);
  await expect(chatChatGPT(messages, [], 'account-model')).rejects.toThrow('plan usage limit reached');
  expect(config.getProviderCred('openai').accessMethod).toBe('chatgpt');
});
