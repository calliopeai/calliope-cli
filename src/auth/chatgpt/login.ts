import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { ChatGPTStore } from './store.js';
import { prepareAuthorization, ChatGPTAuthError } from './protocol.js';
import { tokenRequest, validateIdentity, applyTokens } from './session.js';

export function openBrowser(url: string): Promise<void> {
  // argv only; no shell and no user-controlled executable.
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore', shell: false });
    child.once('error', () => reject(new ChatGPTAuthError('Could not open the browser.')));
    child.once('exit', code => code === 0 ? resolve() : reject(new ChatGPTAuthError('Could not open the browser.')));
  });
}
export async function login(store = new ChatGPTStore(), clientId?: string, signal?: AbortSignal, launch = openBrowser): Promise<void> {
  // Persist host identity before opening a browser; failed attempts retain it.
  await store.update(() => {});
  const state = store.read()!;
  const previous = clientId ? state.accounts[clientId] : undefined;
  if (clientId && !previous) throw new ChatGPTAuthError('Unknown ChatGPT registration. Use auth chatgpt status.');
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new ChatGPTAuthError('Could not start ChatGPT callback listener.');
  const redirect = `http://127.0.0.1:${address.port}/auth/callback`;
  const attempt = prepareAuthorization(state.hostId, redirect, previous);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const callback = new Promise<ReturnType<typeof attempt.consume>>((resolve, reject) => {
      timer = setTimeout(() => reject(new ChatGPTAuthError('ChatGPT sign-in timed out.')), 300000);
      abort = () => reject(new ChatGPTAuthError('ChatGPT sign-in cancelled.'));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      server.on('request', (req, res) => {
        res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/plain');
        if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${address.port}` || !req.url?.startsWith('/auth/callback?')) { res.writeHead(404).end('Not found'); return; }
        try {
          const result = attempt.consume(new URL(req.url, redirect).href);
          res.end('Authorization received. Return to your terminal to finish verification.'); resolve(result);
        } catch (e) { res.writeHead(400).end('Sign-in rejected. Return to your terminal.'); reject(e); }
      });
    });
    // Attach a rejection handler before browser launch so an immediate abort is handled.
    const [result] = await Promise.all([callback, launch(attempt.url)]);
    const tokens = await tokenRequest(result.form, signal);
    if (!tokens.id_token) throw new ChatGPTAuthError('ChatGPT did not return an identity token.');
    const identity = await validateIdentity(tokens.id_token, result.clientId, attempt.nonce, previous ?? state.accounts[result.clientId]);
    signal?.throwIfAborted();
    await store.update(current => {
      if (JSON.stringify(current.accounts[result.clientId]) !== JSON.stringify(state.accounts[result.clientId])) throw new ChatGPTAuthError('ChatGPT registration changed during sign-in. Retry.');
      current.accounts[result.clientId] = applyTokens({ clientId: result.clientId, ...identity, scopes: [] }, tokens);
      current.active = result.clientId;
    });
  } finally {
    attempt.cancel(); clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort);
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
