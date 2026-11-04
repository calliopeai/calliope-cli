import * as config from '../config.js';
import { ChatGPTStore, login, logout, ChatGPTAuthError } from './chatgpt/index.js';
export async function runAuthCommand(args: string[], signal?: AbortSignal): Promise<void> {
  if (args[0] !== 'chatgpt') throw new ChatGPTAuthError('Usage: calliope auth chatgpt login [client-id] | status | use <client-id> | logout | api-key');
  const store = new ChatGPTStore();
  const [, action, id] = args;
  if (args.length > (action === 'login' || action === 'use' ? 3 : 2)) throw new ChatGPTAuthError('Unexpected auth arguments.');
  if (action === 'login') {
    await login(store, id, signal);
    config.setProviderCred('openai', { accessMethod: 'chatgpt' });
    console.log(store.active()?.scopes.includes('chatgpt.tokens.use.direct') ? 'ChatGPT connected. Subscription access selected for OpenAI.' : 'Signed in, but ChatGPT plan usage was not granted. Sign in again to enable it, or select api-key.');
  } else if (action === 'status') {
    const state = store.read();
    console.log(JSON.stringify({ accessMethod: config.getProviderCred('openai').accessMethod ?? 'api-key', accounts: Object.values(state?.accounts ?? {}).map(a => ({ clientId: a.clientId, email: a.email, active: state?.active === a.clientId, signedIn: !!a.accessToken, planUsage: a.scopes.includes('chatgpt.tokens.use.direct') })) }, null, 2));
  } else if (action === 'use' && id) {
    await store.update(state => { if (!state.accounts[id]?.accessToken) throw new ChatGPTAuthError('Account is not signed in. Run auth chatgpt login <client-id>.'); state.active = id; });
    config.setProviderCred('openai', { accessMethod: 'chatgpt' });
    console.log('ChatGPT account selected.');
  } else if (action === 'logout') {
    const revoked = await logout(store);
    console.log(revoked ? 'ChatGPT signed out.' : 'Signed out locally. Remote revocation failed; disconnect Calliope AI CLI in ChatGPT settings.');
  } else if (action === 'api-key') {
    config.setProviderCred('openai', { accessMethod: 'api-key' }); console.log('OpenAI API-key access selected.');
  } else throw new ChatGPTAuthError('Usage: calliope auth chatgpt login [client-id] | status | use <client-id> | logout | api-key');
}
