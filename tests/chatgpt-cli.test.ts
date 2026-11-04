import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as config from '../src/config.js';
import { ChatGPTStore } from '../src/auth/chatgpt/store.js';
import * as fs from 'node:fs';
const mocks = vi.hoisted(() => ({ login: vi.fn(), logout: vi.fn() }));
vi.mock('../src/auth/chatgpt/login.js', () => ({ login: mocks.login }));
vi.mock('../src/auth/chatgpt/session.js', () => ({ logout: mocks.logout }));
import { runAuthCommand } from '../src/auth/cli.js';
beforeEach(async () => {
  config.resetConfig(); const s = new ChatGPTStore(); fs.rmSync(s.directory, { recursive: true, force: true });
  await s.update(state => { state.active = 'oaiapp_test'; state.accounts.oaiapp_test = { clientId: 'oaiapp_test', subject: 'user', email: 'user@example.test', accessToken: 'secret', refreshToken: 'secret', scopes: ['chatgpt.tokens.use.direct'] }; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); config.resetConfig(); fs.rmSync(new ChatGPTStore().directory, { recursive: true, force: true }); });
it('shows redacted status and switches explicit access methods', async () => {
  await runAuthCommand(['chatgpt', 'status']); expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('secret');
  await runAuthCommand(['chatgpt', 'use', 'oaiapp_test']); expect(config.getProviderCred('openai').accessMethod).toBe('chatgpt');
  await runAuthCommand(['chatgpt', 'api-key']); expect(config.getProviderCred('openai').accessMethod).toBe('api-key');
});
it('activates access only after successful login', async () => {
  mocks.login.mockRejectedValueOnce(Error('denied')); await expect(runAuthCommand(['chatgpt', 'login'])).rejects.toThrow('denied'); expect(config.getProviderCred('openai').accessMethod).toBeUndefined();
  mocks.login.mockResolvedValueOnce(undefined); await runAuthCommand(['chatgpt', 'login', 'oaiapp_test']); expect(config.getProviderCred('openai').accessMethod).toBe('chatgpt');
});
it('explains missing consent and incomplete remote revocation', async () => {
  await new ChatGPTStore().update(state => { state.accounts.oaiapp_test!.scopes = []; }); mocks.login.mockResolvedValueOnce(undefined);
  await runAuthCommand(['chatgpt', 'login']); expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('not granted'));
  mocks.logout.mockResolvedValueOnce(false); await runAuthCommand(['chatgpt', 'logout']); expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('Remote revocation failed'));
  mocks.logout.mockResolvedValueOnce(true); await runAuthCommand(['chatgpt', 'logout']); expect(console.log).toHaveBeenLastCalledWith('ChatGPT signed out.');
});
it.each([[], ['other'], ['chatgpt', 'use'], ['chatgpt', 'status', 'unexpected'], ['chatgpt', 'bad'], ['chatgpt', 'use', 'oaiapp_unknown']])('rejects invalid commands %j', async args => { await expect(runAuthCommand(args)).rejects.toThrow(); });
