/**
 * Calliope CLI - attach to an agent host (#378, calliope-vscode#790)
 *
 * `calliope attach` connects to a running agent host over the Agent Host
 * Protocol (JSON-RPC over WebSocket) and follows a session another surface
 * started (the IDE, desktop, AGTerm, Chat Studio), answering its tool-call
 * confirmations from the terminal, including any already waiting when it joins
 * and those inside a subagent, which the session's `inputNeeded` lists (#394).
 *
 *   calliope attach --url <ws-url>                 list the host's sessions
 *   calliope attach --url <ws-url> <session-uri>   follow one, approve its tool calls
 *   calliope attach --hub <url> --user <name> ...  find (or start) the user's
 *                                                  `agenthost` server on a Workbench hub
 *   --token-env <VAR>   hub API token source (default JUPYTERHUB_API_TOKEN)
 *   --read-only         follow without being asked to approve
 *   --once              exit after the next turn completes
 *
 * AHP is an added route, never a replacement (calliope-vscode#796). When no host
 * answers, attach prints one reason code (disabled, unentitled, auth, version,
 * unreachable) and exits 3; the local `calliope` REPL is the fallback.
 * CALLIOPE_AHP=off is the kill switch.
 */

import * as readline from 'readline';

/** Protocol versions offered in `initialize`; keep in step with calliope-vscode scripts/ahp-supported-versions.json. */
export const SUPPORTED_VERSIONS = ['1.0.0', '0.6.0'];
export type FallbackReason = 'disabled' | 'unentitled' | 'auth' | 'version' | 'unreachable';
export const FALLBACK_EXIT = 3;
const ROOT = 'ahp-root://';
const UNSUPPORTED_PROTOCOL_VERSION = -32005;

type Fail = { ok: false; reason: FallbackReason; detail: string };
const fail = (reason: FallbackReason, detail: string): Fail => ({ ok: false, reason, detail });

export function isDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['off', '0', 'false', 'disabled'].includes(String(env.CALLIOPE_AHP ?? '').trim().toLowerCase());
}

/** A session's default chat channel: `ahp-chat://default/<base64url(session)>`. */
export function defaultChatUri(session: string): string {
  return `ahp-chat://default/${Buffer.from(session).toString('base64url')}`;
}

/**
 * Node's WebSocket hides the status of a refused upgrade, so ask plainly first:
 * an authorized agent-host route answers a plain GET with 426 Upgrade Required.
 */
export async function preflight(wsUrl: string, headers: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<Fail | undefined> {
  const http = wsUrl.replace(/^ws/, 'http');
  try {
    const res = await fetchImpl(http, { headers, redirect: 'manual' });
    if (res.status === 426 || res.ok) {
      return undefined;
    }
    // A hub sends an unauthenticated request to its login page.
    const toLogin = res.status >= 300 && res.status < 400 && /\/(hub\/)?login|oauth/.test(res.headers.get('location') ?? '');
    return fail(res.status === 401 || res.status === 403 || toLogin ? 'auth' : 'unreachable', `the host route answered HTTP ${res.status}`);
  } catch (err) {
    return fail('unreachable', `cannot reach ${http}: ${(err as Error).message}`);
  }
}

/** Find (or start) the user's agent host on a JupyterHub; returns its WebSocket URL. */
export async function resolveHubHost(opts: {
  hubUrl: string; user: string; token: string; serverName?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<{ ok: true; url: string } | Fail> {
  const { hubUrl, user, token, serverName = 'agenthost', fetchImpl = fetch, timeoutMs = 60_000 } = opts;
  const api = new URL('hub/api/', hubUrl.endsWith('/') ? hubUrl : `${hubUrl}/`);
  const headers = { Authorization: `token ${token}` };
  const deadline = Date.now() + timeoutMs;
  try {
    for (let spawned = false; ;) {
      const res = await fetchImpl(new URL(`users/${encodeURIComponent(user)}`, api), { headers });
      if (!res.ok) {
        return fail(res.status === 401 || res.status === 403 ? 'auth' : 'unreachable', `hub user lookup answered ${res.status}`);
      }
      const body = await res.json() as { servers?: Record<string, { ready?: boolean; url?: string }> };
      const server = body.servers?.[serverName];
      if (server?.ready && server.url) {
        const ws = new URL(`${server.url}agent-host/`, hubUrl);
        ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
        return { ok: true, url: ws.toString() };
      }
      if (!spawned) {
        const spawn = await fetchImpl(new URL(`users/${encodeURIComponent(user)}/servers/${encodeURIComponent(serverName)}`, api), { method: 'POST', headers });
        if (spawn.status === 401) {
          return fail('auth', 'hub refused the token');
        }
        if (spawn.status === 403 || (spawn.status === 400 && !server)) {
          return fail('unentitled', `hub refused to start ${serverName}: ${spawn.status}`);
        }
        if (!spawn.ok && spawn.status !== 400) {
          return fail('unreachable', `hub could not start ${serverName}: ${spawn.status}`);
        }
        spawned = true;
      }
      if (Date.now() >= deadline) {
        return fail('unreachable', `${serverName} not ready within ${Math.round(timeoutMs / 1000)}s`);
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (err) {
    return fail('unreachable', `hub unreachable: ${(err as Error).message}`);
  }
}

interface Message { id?: number; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

/** The minimal JSON-RPC client attach needs, over any WebSocket-shaped object. */
export class AhpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (m: Message) => void }>();
  readonly actions: Array<(action: any, channel: string, serverSeq?: number) => void> = [];
  closed?: (detail: string) => void;

  constructor(private readonly ws: { send(data: string): void; close(): void; addEventListener(type: string, fn: (ev: any) => void): void }) {
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(String(ev.data)) as Message;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!.resolve(msg);
        this.pending.delete(msg.id);
        return;
      }
      if (msg.method === 'action' && msg.params?.action) {
        for (const fn of this.actions) {
          fn(msg.params.action, msg.params.channel, msg.params.serverSeq);
        }
      }
    });
    ws.addEventListener('close', ev => this.closed?.(`connection closed (${ev.code ?? 'unknown'})`));
  }

  call(method: string, params: Record<string, unknown>): Promise<Message> {
    const id = this.nextId++;
    return new Promise(resolve => {
      this.pending.set(id, { resolve });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  dispatch(channel: string, clientSeq: number, action: Record<string, unknown>): void {
    this.ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'dispatchAction', params: { channel, clientSeq, action } }));
  }

  close(): void {
    this.ws.close();
  }
}

/** Classify the `initialize` answer; undefined when the host is usable. */
export function checkInitialize(msg: Message, supported = SUPPORTED_VERSIONS): Fail | undefined {
  if (msg.error) {
    return msg.error.code === UNSUPPORTED_PROTOCOL_VERSION
      ? fail('version', `the host speaks none of ${supported.join(', ')}`)
      : fail('unreachable', `initialize failed: ${msg.error.message}`);
  }
  if (!supported.includes(msg.result?.protocolVersion)) {
    return fail('version', `the host answered ${msg.result?.protocolVersion}`);
  }
  return undefined;
}

export interface FollowIo {
  write: (s: string) => void;
  /**
   * Ask the user; resolves true to approve. Absent means read-only. `signal`
   * aborts when the answer is no longer needed (answered elsewhere, turn over,
   * connection closed); the prompt should then close and resolve false.
   */
  approve?: (title: string, input: string, signal: AbortSignal) => Promise<boolean>;
  /** Resolve after the next turn instead of following until the connection closes. */
  once?: boolean;
}

/** A tool call as a chat snapshot or a session `inputNeeded` entry carries it. */
interface ToolCallState { toolCallId: string; status: string; confirmationTitle?: unknown; invocationMessage?: unknown; toolInput?: unknown }

/** The part of a chat channel's `subscribe` snapshot (`result.snapshot`) that attach reads. */
export interface ChatSnapshot {
  /** The snapshot's server sequence; later actions carry `serverSeq > fromSeq`. */
  fromSeq?: number;
  state?: {
    activeTurn?: {
      id: string;
      responseParts?: Array<{ kind: string; toolCall?: ToolCallState }>;
    };
  };
}

/**
 * One entry of a session's `inputNeeded`: input the session waits on in one of
 * its chats, a subagent's included. A `toolConfirmation` is answered on `chat`,
 * with `turnId`, without subscribing to that chat.
 */
export interface SessionInputRequest {
  id: string;
  kind: string;
  chat: string;
  turnId?: string;
  toolCall?: ToolCallState;
}

/** The part of the session channel's `subscribe` snapshot that attach reads. */
export interface SessionSnapshot {
  fromSeq?: number;
  state?: { inputNeeded?: SessionInputRequest[] };
}

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' ? value : (value as { markdown?: string } | undefined)?.markdown ?? fallback;

/**
 * Render a session's chat actions and answer tool confirmations. Resolves when
 * the connection closes, or after the next turn with `once`.
 *
 * `subscribed` is the chat channel's `subscribe` snapshot for a client joining
 * a session already under way: the confirmations it shows waiting are asked
 * first. `sessionSubscribed` is the session channel's: its `inputNeeded` lists
 * the confirmations waiting in the session's other chats (a subagent's), which
 * are answered on their own chat. Each channel's actions that arrive before its
 * snapshot are held, then applied after it, skipping any the snapshot already
 * includes.
 */
export function follow(
  conn: AhpConnection, session: string, io: FollowIo,
  subscribed?: Promise<ChatSnapshot | undefined>, sessionSubscribed?: Promise<SessionSnapshot | undefined>,
): { done: Promise<string> } {
  const chat = defaultChatUri(session);
  let seq = 0;
  let finish!: (s: string) => void;
  const done = new Promise<string>(resolve => { finish = resolve; });
  // Confirmations this client knows are open, by tool call, each able to
  // withdraw its prompt. One prompt at a time: a snapshot can hold several, and
  // two readline prompts on one stdin garble each other. `request` is the
  // session's `inputNeeded` id of a confirmation asked for another chat.
  const open = new Map<string, { asked: AbortController; request?: string }>();
  let prompts = Promise.resolve();
  const settled = (toolCallId: string) => {
    open.get(toolCallId)?.asked.abort();
    open.delete(toolCallId);
  };
  const settleAll = () => {
    for (const toolCallId of [...open.keys()]) {
      settled(toolCallId);
    }
  };
  // The default chat's turn is over, and so are the prompts asked on it. One
  // for another chat closes when the session removes its request: the host ends
  // subagent turns with a cancelled parent's, and a background subagent's turn
  // can outlive the parent's.
  const settleTurn = () => {
    for (const [toolCallId, { request }] of [...open]) {
      if (request === undefined) {
        settled(toolCallId);
      }
    }
  };
  // Following is over: no prompt outlives it, or its readline keeps the process alive.
  const end = (reason: string) => {
    settleAll();
    finish(reason);
  };
  const confirm = (target: string, turnId: string, toolCallId: string, confirmationTitle: unknown, toolInput: unknown, request?: string) => {
    if (open.has(toolCallId)) {
      return;
    }
    const asked = new AbortController();
    open.set(toolCallId, { asked, request });
    const title = text(confirmationTitle, 'Run tool');
    const input = typeof toolInput === 'string' ? toolInput : JSON.stringify(toolInput ?? '');
    const approve = io.approve;
    if (!approve) {
      io.write(`\n[waiting for approval elsewhere] ${title}: ${input}\n`);
      return;
    }
    prompts = prompts.then(async () => {
      if (asked.signal.aborted) {
        return;
      }
      const approved = await approve(title, input, asked.signal);
      if (asked.signal.aborted) {
        io.write('\n[approval no longer needed; nothing sent]\n');
        return;
      }
      open.delete(toolCallId);
      conn.dispatch(target, ++seq, approved
        ? { type: 'chat/toolCallConfirmed', turnId, toolCallId, approved: true, confirmed: 'user-action' }
        : { type: 'chat/toolCallConfirmed', turnId, toolCallId, approved: false, reason: 'denied' });
    }).catch(err => io.write(`\n[approval prompt failed] ${(err as Error).message}\n`));
  };
  const apply = (action: any) => {
    switch (action.type) {
      case 'chat/turnStarted':
        io.write(`\n› ${action.message?.text ?? ''}\n`);
        break;
      case 'chat/delta':
        io.write(action.content ?? '');
        break;
      case 'chat/toolCallReady':
        if (action.confirmationTitle !== undefined) {
          confirm(chat, action.turnId, action.toolCallId, action.confirmationTitle, action.toolInput);
        }
        break;
      case 'chat/toolCallConfirmed':
        settled(action.toolCallId);
        break;
      case 'chat/toolCallComplete':
        settled(action.toolCallId);
        io.write(`\n[tool ${action.result?.success === false ? 'failed' : 'done'}]\n`);
        break;
      case 'chat/turnCancelled':
        settleTurn();
        break;
      case 'chat/turnComplete':
        settleTurn();
        io.write('\n[turn complete]\n');
        if (io.once) {
          end('turnComplete');
        }
        break;
      case 'chat/error':
        settleTurn();
        io.write(`\n[turn error] ${JSON.stringify(action.error ?? action).slice(0, 200)}\n`);
        if (io.once) {
          end('error');
        }
        break;
    }
  };
  // The session's `inputNeeded` lists the input waiting in every chat. A
  // confirmation on the default chat is there too, and is asked through that
  // chat above: a host without calliope-vscode#823 drops its entry while the
  // call still waits (the provider's late ready moves it to running), so that
  // removal is no answer. The session is how attach hears about the other
  // chats, a subagent's.
  const ask = (request: SessionInputRequest | undefined) => {
    const call = request?.toolCall;
    if (request?.kind === 'toolConfirmation' && call?.status === 'pending-confirmation'
      && typeof request.chat === 'string' && request.chat !== chat && typeof request.turnId === 'string') {
      confirm(request.chat, request.turnId, call.toolCallId, call.confirmationTitle ?? call.invocationMessage, call.toolInput, request.id);
    }
  };
  const applySession = (action: any) => {
    switch (action.type) {
      case 'session/inputNeededSet':
        ask(action.request);
        break;
      case 'session/inputNeededRemoved':
        for (const [toolCallId, { request }] of [...open]) {
          if (request === action.id) {
            settled(toolCallId);
          }
        }
        break;
    }
  };
  // Apply a channel's actions from its snapshot on: those that arrive first are
  // held, then applied after it, skipping any it already includes.
  const track = <S extends { fromSeq?: number }>(channel: string, onAction: (action: any) => void, seed: (snapshot: S | undefined) => void, snapshot?: Promise<S | undefined>) => {
    let held: Array<{ action: any; serverSeq?: number }> | undefined = snapshot ? [] : undefined;
    conn.actions.push((action, from, serverSeq) => {
      if (from !== channel) {
        return;
      }
      if (held) {
        held.push({ action, serverSeq });
        return;
      }
      onAction(action);
    });
    const join = (joined: S | undefined) => {
      seed(joined);
      const early = held ?? [];
      held = undefined;
      const fromSeq = joined?.fromSeq;
      for (const { action, serverSeq } of early) {
        if (fromSeq === undefined || serverSeq === undefined || serverSeq > fromSeq) {
          onAction(action);
        }
      }
    };
    snapshot?.then(join, () => join(undefined));
  };
  track<ChatSnapshot>(chat, apply, snapshot => {
    const turn = snapshot?.state?.activeTurn;
    for (const part of turn?.responseParts ?? []) {
      const call = part.kind === 'toolCall' ? part.toolCall : undefined;
      if (turn && call?.status === 'pending-confirmation') {
        confirm(chat, turn.id, call.toolCallId, call.confirmationTitle ?? call.invocationMessage, call.toolInput);
      }
    }
  }, subscribed);
  track<SessionSnapshot>(session, applySession, snapshot => {
    for (const request of snapshot?.state?.inputNeeded ?? []) {
      ask(request);
    }
  }, sessionSubscribed);
  conn.closed = end;
  return { done };
}

function parseArgs(args: string[]): { url?: string; hub?: string; user?: string; tokenEnv: string; readOnly: boolean; once: boolean; session?: string } {
  const out = { tokenEnv: 'JUPYTERHUB_API_TOKEN', readOnly: false, once: false } as ReturnType<typeof parseArgs>;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--url') out.url = args[++i];
    else if (a === '--hub') out.hub = args[++i];
    else if (a === '--user') out.user = args[++i];
    else if (a === '--token-env') out.tokenEnv = args[++i] ?? out.tokenEnv;
    else if (a === '--read-only') out.readOnly = true;
    else if (a === '--once') out.once = true;
    else if (a && !a.startsWith('--')) out.session = a;
  }
  return out;
}

function askYesNo(title: string, input: string, signal: AbortSignal): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    const end = (approved: boolean) => {
      rl.close();
      resolve(approved);
    };
    signal.addEventListener('abort', () => end(false), { once: true });
    rl.question(`\n${title}\n  ${input}\nApprove? [y/N] `, answer => end(/^y(es)?$/i.test(answer.trim())));
  });
}

export async function runAttach(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const opts = parseArgs(args);
  const err = (s: string) => process.stderr.write(`${s}\n`);
  const fallback = (f: Fail) => {
    err(`calliope attach: no agent host (reason: ${f.reason}). ${f.detail}`);
    err('Falling back: run `calliope` to work locally.');
    return FALLBACK_EXIT;
  };
  if (isDisabled(env)) {
    return fallback(fail('disabled', 'CALLIOPE_AHP is off'));
  }
  const token = env[opts.tokenEnv];
  const headers: Record<string, string> = token ? { Authorization: `token ${token}` } : {};
  let url = opts.url;
  if (!url && opts.hub && opts.user) {
    if (!token) {
      return fallback(fail('auth', `set ${opts.tokenEnv} to a hub API token`));
    }
    const resolved = await resolveHubHost({ hubUrl: opts.hub, user: opts.user, token });
    if (!resolved.ok) {
      return fallback(resolved);
    }
    url = resolved.url;
  }
  if (!url) {
    err('usage: calliope attach (--url <ws-url> | --hub <url> --user <name>) [session-uri] [--read-only]');
    return 1;
  }
  const refused = await preflight(url, headers);
  if (refused) {
    return fallback(refused);
  }
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const opened = await new Promise<boolean>(resolve => {
    ws.addEventListener('open', () => resolve(true));
    ws.addEventListener('error', () => resolve(false));
  });
  if (!opened) {
    return fallback(fail('unreachable', 'the WebSocket upgrade failed'));
  }
  const conn = new AhpConnection(ws);
  const init = await conn.call('initialize', {
    channel: ROOT, protocolVersions: SUPPORTED_VERSIONS, clientId: `calliope-cli-${process.pid}`,
    clientInfo: { name: 'calliope-cli', version: '1' }, initialSubscriptions: [ROOT],
  });
  const bad = checkInitialize(init);
  if (bad) {
    conn.close();
    return fallback(bad);
  }
  if (!opts.session) {
    const list = await conn.call('listSessions', { channel: ROOT });
    if (list.error) {
      err(`calliope attach: the host could not list sessions: ${list.error.message.split('\n')[0]}`);
      conn.close();
      return 1;
    }
    const items = (list.result?.items ?? []) as Array<{ resource: string; title?: string; modifiedAt?: string }>;
    process.stdout.write(items.length ? '' : 'No sessions on this host.\n');
    for (const s of items) {
      process.stdout.write(`${s.resource}  ${s.title ?? ''}  ${s.modifiedAt ?? ''}\n`);
    }
    conn.close();
    return 0;
  }
  // The session snapshot lists the input waiting in every chat, a subagent's
  // included; the chat snapshot holds the confirmations waiting on the default
  // chat, which is subscribed once the session answers. follow() listens from
  // the moment the first request goes out: an action can share a network read
  // with an answer, and Node delivers it before an awaited call resumes.
  const chat = defaultChatUri(opts.session);
  const sessionAnswer = conn.call('subscribe', { channel: opts.session });
  const chatAnswer = sessionAnswer.then(() => conn.call('subscribe', { channel: chat }));
  const { done } = follow(conn, opts.session, {
    write: s => process.stdout.write(s),
    approve: opts.readOnly ? undefined : askYesNo,
    once: opts.once,
  }, chatAnswer.then(answer => answer.result?.snapshot), sessionAnswer.then(answer => answer.result?.snapshot));
  process.stderr.write(`attached to ${opts.session} (AHP ${init.result.protocolVersion}); Ctrl+C to detach\n`);
  const ended = await done;
  conn.close();
  return ended === 'turnComplete' ? 0 : 1;
}
