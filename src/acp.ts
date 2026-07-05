/**
 * Calliope CLI - Agent Client Protocol (ACP) agent mode.
 *
 * `calliope acp` speaks the Agent Client Protocol (https://agentclientprotocol.com)
 * over stdio JSON-RPC, so editors that speak ACP (Zed, JetBrains, Neovim, …) can
 * drive Calliope as a coding agent. This module is the adapter: it maps the ACP
 * surface onto Calliope's existing agent core (the same provider `chat`, `TOOLS`,
 * `executeTool`, governance and audit pieces the headless runner uses) — no forked
 * agent logic.
 *
 * Baseline agent surface implemented: `initialize`, `authenticate`, `session/new`,
 * `session/prompt`; `session/cancel`; streaming `session/update` notifications; and
 * the `session/request_permission` flow. When the client advertises `fs`
 * capabilities, file tools are routed through the client's `fs/read_text_file` and
 * `fs/write_text_file` so edits land on the editor's (possibly unsaved) buffers.
 *
 * The protocol owns stdout/stdin; ALL diagnostics go to stderr (see {@link log}),
 * so a stray `console.log` never corrupts the JSON-RPC stream. The whole module is
 * lazy-loaded from bin.ts only for the `acp` subcommand, so it adds nothing to the
 * default cold-start path.
 */

import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  RequestError,
  PROTOCOL_VERSION,
  type Agent,
  type Stream,
  type ClientCapabilities,
  type ContentBlock,
  type SessionNotification,
  type ToolKind,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type AuthenticateResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
} from '@zed-industries/agent-client-protocol';

import * as config from './config.js';
import { chat, selectProvider } from './providers/index.js';
import { TOOLS, executeTool, type FsDelegate } from './tools.js';
import { DEFAULT_MODELS, calculateCost } from './types.js';
import type { Message, LLMProvider, LLMResponse, ToolCall, ToolResult } from './types.js';
import { getSystemPromptForProvider, isLocalBackend } from './local-model.js';
import * as memory from './memory.js';
import { resolveIterationLimit } from './iteration-limit.js';
import { RunLog } from './runlog.js';
import { evaluatePolicy, isPolicyEnabled } from './policy.js';
import { assessToolRisk } from './risk.js';
import { checkHooksAllow } from './hooks.js';

// ============================================================================
// Diagnostics — stderr only (stdout carries the protocol).
// ============================================================================

function log(message: string): void {
  process.stderr.write(`[calliope-acp] ${message}\n`);
}

/** Chatty per-request trace, gated on CALLIOPE_DEBUG (matches the rest of the CLI). */
function debug(message: string): void {
  if (process.env.CALLIOPE_DEBUG === '1') log(message);
}

/**
 * Best-effort human message from a thrown value. Handles Error instances and the
 * bare `{ code, message, data }` JSON-RPC error object the SDK rejects with.
 */
function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return String(err);
}

// ============================================================================
// Tool → permission / presentation mapping
// ============================================================================

/**
 * Tools with side effects. These always route through the permission flow (and
 * are denied under the non-interactive fallback), matching the headless runner's
 * notion of a mutating tool.
 */
const MUTATING_TOOLS = new Set(['shell', 'write_file', 'edit_file', 'git', 'execute_code', 'configure']);

/**
 * Whether a tool call must ask the client for permission before running.
 * Read-only tools (read_file, list_files, think, glob, grep, web_search) run
 * silently; anything that mutates state or that Calliope's risk model flags for
 * confirmation asks first.
 */
function toolNeedsPermission(toolCall: ToolCall): boolean {
  if (MUTATING_TOOLS.has(toolCall.name)) return true;
  return assessToolRisk(toolCall).requiresConfirmation;
}

/** Map a Calliope tool name to the ACP tool kind (drives client icons/UX). */
function toolKind(name: string): ToolKind {
  switch (name) {
    case 'read_file':
    case 'list_files':
    case 'glob':
    case 'grep':
      return 'read';
    case 'write_file':
    case 'edit_file':
      return 'edit';
    case 'shell':
    case 'execute_code':
    case 'git':
      return 'execute';
    case 'web_search':
    case 'web_fetch':
      return 'fetch';
    case 'think':
    case 'create_plan':
      return 'think';
    default:
      return 'other';
  }
}

/** A short human-readable title for a tool call, e.g. `read_file: src/a.ts`. */
function toolTitle(toolCall: ToolCall): string {
  const a = toolCall.arguments as Record<string, unknown>;
  const hint =
    typeof a.path === 'string'
      ? a.path
      : typeof a.command === 'string'
        ? a.command
        : typeof a.pattern === 'string'
          ? a.pattern
          : typeof a.query === 'string'
            ? a.query
            : '';
  return hint ? `${toolCall.name}: ${hint}` : toolCall.name;
}

/** Absolute file location(s) a tool touches, for the client's follow-along UI. */
function toolLocations(toolCall: ToolCall, cwd: string): { path: string }[] | undefined {
  const p = (toolCall.arguments as Record<string, unknown>).path;
  if (typeof p !== 'string' || p.length === 0) return undefined;
  return [{ path: path.isAbsolute(p) ? p : path.join(cwd, p) }];
}

/**
 * Flatten an ACP prompt (content blocks) into the plain text Calliope's agent
 * loop consumes. Baseline requires Text and ResourceLink; a resource link is
 * surfaced as an `@uri` mention, and an embedded text resource is inlined.
 */
function promptToText(blocks: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      parts.push(block.text);
    } else if (block.type === 'resource_link') {
      parts.push(`@${block.uri}`);
    } else if (block.type === 'resource') {
      const resource = block.resource as { text?: unknown; uri?: unknown };
      if (typeof resource.text === 'string') {
        parts.push(resource.text);
      } else if (typeof resource.uri === 'string') {
        parts.push(`@${resource.uri}`);
      }
    }
    // image / audio blocks are not advertised in promptCapabilities; ignore.
  }
  return parts.join('\n');
}

// ============================================================================
// Session state
// ============================================================================

interface AcpSession {
  id: string;
  cwd: string;
  /** Configured provider passed to `chat` (may be 'auto'). */
  provider: LLMProvider;
  /** Resolved provider used for the system prompt, cost model, and local flag. */
  resolvedProvider: LLMProvider;
  /** Configured model, or '' to let the provider pick its default. */
  model: string;
  localBackend: boolean;
  messages: Message[];
  runlog: RunLog;
  /** Set by session/cancel; checked cooperatively at every loop boundary. */
  cancelled: boolean;
  totals: { inputTokens: number; outputTokens: number; cost: number; toolCalls: number };
  startedAt: number;
}

type GateResult =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'cancelled' };

// ============================================================================
// The agent
// ============================================================================

class CalliopeAgent implements Agent {
  private clientCapabilities: ClientCapabilities = {};
  private readonly sessions = new Map<string, AcpSession>();
  /** Tail of the outgoing write chain; awaited to flush notifications. */
  private lastWrite: Promise<void> = Promise.resolve();

  constructor(private readonly conn: AgentSideConnection) {}

  // ---- ACP: initialize --------------------------------------------------

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = params.clientCapabilities ?? {};
    const requested = typeof params.protocolVersion === 'number' ? params.protocolVersion : PROTOCOL_VERSION;
    // Negotiate down to the newest version we both support (we support 1).
    const negotiated = requested >= 1 && requested <= PROTOCOL_VERSION ? requested : PROTOCOL_VERSION;
    debug(
      `initialize: client protocol v${requested} -> v${negotiated}; ` +
        `fs=${JSON.stringify(this.clientCapabilities.fs ?? {})} terminal=${this.clientCapabilities.terminal ?? false}`,
    );
    return {
      protocolVersion: negotiated,
      agentCapabilities: {
        // session/load, MCP-over-ACP, and modes are not implemented yet.
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
      },
      // Calliope authenticates via locally-configured provider keys, so no ACP
      // auth method is required.
      authMethods: [],
    };
  }

  // ---- ACP: authenticate (no-op; no auth methods advertised) ------------

  async authenticate(): Promise<AuthenticateResponse> {
    return {};
  }

  // ---- ACP: session/new -------------------------------------------------

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const cwd = params.cwd || process.cwd();
    const provider = (process.env.CALLIOPE_PROVIDER as LLMProvider) || config.get('defaultProvider');
    const model = process.env.CALLIOPE_MODEL || config.get('defaultModel') || '';

    // Resolve the provider so 'auto' picks a real backend for the system prompt,
    // cost model, and local-backend flag (mirrors the headless runner). Fall back
    // to the raw provider if selection throws (chat() surfaces the real error).
    let resolvedProvider: LLMProvider;
    try {
      resolvedProvider = selectProvider(provider);
    } catch {
      resolvedProvider = provider;
    }
    const localBackend = isLocalBackend(resolvedProvider);
    const costModel = model || DEFAULT_MODELS[resolvedProvider];

    const sessionId = `acp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const runlog = RunLog.open(sessionId);
    runlog.runStart({
      session: sessionId,
      cwd,
      provider: resolvedProvider,
      model: costModel,
      config: config.getConfig() as unknown as Record<string, unknown>,
      mode: 'acp',
    });

    const systemPrompt = getSystemPromptForProvider(resolvedProvider);
    const memoryContext = memory.buildMemoryContext(cwd);
    const fullPrompt = memoryContext.trim()
      ? systemPrompt + '\n\n--- Project Context ---\n' + memoryContext
      : systemPrompt;

    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      provider,
      resolvedProvider,
      model,
      localBackend,
      messages: [{ role: 'system', content: fullPrompt }],
      runlog,
      cancelled: false,
      totals: { inputTokens: 0, outputTokens: 0, cost: 0, toolCalls: 0 },
      startedAt: Date.now(),
    });
    debug(`session/new: ${sessionId} cwd=${cwd} provider=${resolvedProvider} model=${costModel}`);
    return { sessionId };
  }

  // ---- ACP: session/prompt ---------------------------------------------

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw RequestError.invalidParams({ error: `unknown session: ${params.sessionId}` });
    }

    // Each prompt is a fresh turn; clear any stale cancel from a prior turn.
    session.cancelled = false;
    const text = promptToText(params.prompt);
    session.messages.push({ role: 'user', content: text });
    session.runlog.userPrompt(text);
    debug(`session/prompt: ${session.id} (${text.length} chars)`);

    const stopReason = await this.runTurn(session);
    await session.runlog.flush();
    return { stopReason };
  }

  // ---- ACP: session/cancel (notification) -------------------------------

  async cancel(params: CancelNotification): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (session) {
      session.cancelled = true;
      debug(`session/cancel: ${params.sessionId}`);
    }
  }

  // ---- The agent loop (ACP-flavoured mirror of the headless loop) --------

  private async runTurn(session: AcpSession): Promise<PromptResponse['stopReason']> {
    const maxIterations = resolveIterationLimit(config.get('maxIterations'));
    const costModel = session.model || DEFAULT_MODELS[session.resolvedProvider];
    let iteration = 0;

    while (iteration < maxIterations) {
      if (session.cancelled) return this.finishCancelled(session);
      iteration++;

      // Stream assistant text as agent_message_chunk deltas via the chat seam.
      let streamedChars = 0;
      const onToken = (token: string): void => {
        if (!token) return;
        streamedChars += token.length;
        this.emit(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: token } });
      };

      let response: LLMResponse;
      try {
        response = await chat(session.provider, session.messages, TOOLS, session.model || undefined, onToken);
      } catch (err) {
        const msg = errMessage(err);
        log(`chat error: ${msg}`);
        session.runlog.assistantMessage({ content: `[error: ${msg}]`, tokens: { input: 0, output: 0 }, cost: 0 });
        await session.runlog.flush();
        throw RequestError.internalError({ error: msg });
      }

      // Audit + spend accounting (mirrors headless).
      if (response.usage) {
        const cost = calculateCost(costModel, response.usage.inputTokens, response.usage.outputTokens);
        session.totals.inputTokens += response.usage.inputTokens;
        session.totals.outputTokens += response.usage.outputTokens;
        session.totals.cost += cost;
        session.runlog.assistantMessage({
          content: response.content,
          tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
          cost,
        });
      } else {
        session.runlog.assistantMessage({ content: response.content, tokens: { input: 0, output: 0 }, cost: 0 });
      }

      // Providers that don't stream: emit the assembled content once so the
      // client still sees the assistant message.
      if (streamedChars === 0 && response.content) {
        this.emit(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: response.content } });
      }

      if (session.cancelled) return this.finishCancelled(session);

      if (response.toolCalls && response.toolCalls.length > 0) {
        session.messages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });

        for (const toolCall of response.toolCalls) {
          if (session.cancelled) return this.finishCancelled(session);
          const outcome = await this.runToolCall(session, toolCall);
          if (outcome === 'cancelled') return this.finishCancelled(session);
        }
        continue; // next model turn
      }

      // No tool calls: this is the final assistant message → end of turn.
      session.messages.push({ role: 'assistant', content: response.content });
      await this.flush();
      return response.finishReason === 'length' ? 'max_tokens' : 'end_turn';
    }

    // Exhausted the iteration budget.
    await this.flush();
    return 'max_turn_requests';
  }

  /** Flush pending notifications and return the cancelled stop reason. */
  private async finishCancelled(session: AcpSession): Promise<PromptResponse['stopReason']> {
    debug(`turn cancelled: ${session.id}`);
    await this.flush();
    return 'cancelled';
  }

  // ---- One tool call: announce → gate → execute → report ----------------

  private async runToolCall(session: AcpSession, toolCall: ToolCall): Promise<'ok' | 'cancelled'> {
    session.runlog.toolCall({ id: toolCall.id, name: toolCall.name, args: toolCall.arguments });
    session.totals.toolCalls++;

    // Announce the pending tool call.
    await this.emit(session.id, {
      sessionUpdate: 'tool_call',
      toolCallId: toolCall.id,
      title: toolTitle(toolCall),
      kind: toolKind(toolCall.name),
      status: 'pending',
      rawInput: toolCall.arguments,
      locations: toolLocations(toolCall, session.cwd),
    });

    // Permission + hard governance gates.
    const gate = await this.gateToolCall(session, toolCall);
    if (gate.decision === 'cancelled') {
      await this.reportToolResult(session, toolCall.id, '[cancelled]', true);
      session.runlog.toolResult({ id: toolCall.id, result: '[cancelled]', isError: true, durationMs: 0 });
      session.messages.push({ role: 'tool', content: '[cancelled]', toolCallId: toolCall.id });
      return 'cancelled';
    }
    if (gate.decision === 'deny') {
      await this.reportToolResult(session, toolCall.id, gate.reason, true);
      session.runlog.toolResult({ id: toolCall.id, result: gate.reason, isError: true, durationMs: 0 });
      session.messages.push({ role: 'tool', content: gate.reason, toolCallId: toolCall.id });
      return 'ok';
    }

    // Allowed: mark in-progress and execute through the shared tool runtime,
    // preferring the client's filesystem when it advertised fs capabilities.
    await this.emit(session.id, { sessionUpdate: 'tool_call_update', toolCallId: toolCall.id, status: 'in_progress' });

    const started = Date.now();
    let result: ToolResult;
    try {
      result = await executeTool(toolCall, session.cwd, 60000, undefined, {
        appendAnchorHash: session.localBackend,
        fs: this.clientFsDelegate(session.id),
      });
    } catch (err) {
      result = {
        toolCallId: toolCall.id,
        result: `Error: ${errMessage(err)}`,
        isError: true,
      };
    }
    const durationMs = Date.now() - started;

    session.runlog.toolResult({
      id: toolCall.id,
      result: result.result,
      isError: result.isError || false,
      durationMs,
    });
    await this.reportToolResult(session, toolCall.id, result.displayResult || result.result, result.isError || false, result.result);
    session.messages.push({ role: 'tool', content: result.result, toolCallId: toolCall.id });
    return 'ok';
  }

  /** Send a terminal (completed/failed) tool_call_update to the client. */
  private reportToolResult(
    session: AcpSession,
    toolCallId: string,
    text: string,
    isError: boolean,
    rawResult?: string,
  ): Promise<void> {
    return this.emit(session.id, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: isError ? 'failed' : 'completed',
      content: [{ type: 'content', content: { type: 'text', text } }],
      rawOutput: { result: rawResult ?? text, isError },
    });
  }

  // ---- Gates: permission, then the hard hooks -------------------------

  private async gateToolCall(session: AcpSession, toolCall: ToolCall): Promise<GateResult> {
    // 1. Permission via the client (only for mutating / confirm-worthy tools).
    if (toolNeedsPermission(toolCall)) {
      const permission = await this.requestPermission(session, toolCall);
      if (permission === 'cancelled') return { decision: 'cancelled' };
      if (permission === 'reject') return { decision: 'deny', reason: '[Permission denied by user]' };
      // 'allow' falls through to the hard gates below.
    }

    // 2. Pre-tool hooks — the hard gate, runs regardless of permission (exit-42
    //    veto contract; see hooks.ts / docs/governance.md).
    const hookGate = await checkHooksAllow('pre-tool', { tool: toolCall.name, toolArgs: toolCall.arguments });
    if (!hookGate.allowed) {
      return { decision: 'deny', reason: `[Blocked by hook: ${hookGate.reason || 'no reason given'}]` };
    }

    // 3. Policy hook — the Zentinelle integration point (fail closed).
    if (isPolicyEnabled()) {
      const verdict = await evaluatePolicy(toolCall);
      session.runlog.policyEvent({
        tool: toolCall.name,
        decision: verdict.decision,
        source: verdict.source,
        reason: verdict.reason,
        durationMs: verdict.durationMs,
      });
      if (verdict.decision === 'deny') {
        return { decision: 'deny', reason: `[Policy denied: ${verdict.reason || 'no reason given'}]` };
      }
    }

    return { decision: 'allow' };
  }

  /**
   * Ask the client to authorize a tool call. Returns the user's decision, or
   * falls back to Calliope's non-interactive default (deny) when the client does
   * not support the permission request at all.
   */
  private async requestPermission(session: AcpSession, toolCall: ToolCall): Promise<'allow' | 'reject' | 'cancelled'> {
    try {
      const res = await this.conn.requestPermission({
        sessionId: session.id,
        toolCall: {
          toolCallId: toolCall.id,
          title: toolTitle(toolCall),
          kind: toolKind(toolCall.name),
          rawInput: toolCall.arguments,
        },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      });
      const outcome = res.outcome;
      if (outcome.outcome === 'cancelled') return 'cancelled';
      if (outcome.outcome === 'selected') return outcome.optionId.startsWith('allow') ? 'allow' : 'reject';
      return 'reject';
    } catch (err) {
      // Client can't handle permission requests: non-interactive default is to
      // deny anything that needed asking (read-only tools never reach here).
      log(
        `requestPermission unavailable (${errMessage(err)}); ` +
          `denying ${toolCall.name} under the non-interactive default`,
      );
      return 'reject';
    }
  }

  // ---- Client-side filesystem delegate ---------------------------------

  /**
   * Build an {@link FsDelegate} that routes file tool reads/writes through the
   * client's `fs/read_text_file` / `fs/write_text_file`, but only for the
   * capabilities the client advertised. Returns undefined when the client has no
   * fs capability, so tools fall back to local disk.
   */
  private clientFsDelegate(sessionId: string): FsDelegate | undefined {
    const fsCap = this.clientCapabilities.fs;
    if (!fsCap || (!fsCap.readTextFile && !fsCap.writeTextFile)) return undefined;

    const conn = this.conn;
    const delegate: FsDelegate = {};
    if (fsCap.readTextFile) {
      delegate.readTextFile = async (absPath: string): Promise<string> => {
        const res = await conn.readTextFile({ sessionId, path: absPath });
        return res.content;
      };
    }
    if (fsCap.writeTextFile) {
      delegate.writeTextFile = async (absPath: string, content: string): Promise<void> => {
        await conn.writeTextFile({ sessionId, path: absPath, content });
      };
    }
    return delegate;
  }

  // ---- Notification plumbing -------------------------------------------

  /**
   * Send a session/update notification. Writes serialize in call order via the
   * SDK's write queue, so the tail promise flushes everything before it. Errors
   * are swallowed to stderr — a failed notification must never crash the loop.
   */
  private emit(sessionId: string, update: SessionNotification['update']): Promise<void> {
    const p = this.conn.sessionUpdate({ sessionId, update }).catch((err) => {
      log(`sessionUpdate failed: ${errMessage(err)}`);
    });
    this.lastWrite = p;
    return p;
  }

  /** Await all pending outgoing notifications. */
  private flush(): Promise<void> {
    return this.lastWrite;
  }

  /** Close every session's audit log (best-effort) on shutdown. */
  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.runlog.runEnd({
        totals: {
          inputTokens: session.totals.inputTokens,
          outputTokens: session.totals.outputTokens,
          cost: session.totals.cost,
          toolCalls: session.totals.toolCalls,
          durationMs: Date.now() - session.startedAt,
        },
        exitReason: session.cancelled ? 'cancelled' : 'completed',
      });
      await session.runlog.close();
    }
  }
}

// ============================================================================
// Entry points
// ============================================================================

/**
 * Wire a {@link CalliopeAgent} onto an ACP {@link Stream}. Exposed for tests,
 * which drive the SDK's client side against it over an in-memory stream pair.
 * The SDK calls the factory synchronously, so the returned agent is ready.
 */
export function serveAcp(stream: Stream): CalliopeAgent {
  let agent!: CalliopeAgent;
  // eslint-disable-next-line no-new -- the connection registers itself and reads.
  new AgentSideConnection((conn) => {
    agent = new CalliopeAgent(conn);
    return agent;
  }, stream);
  return agent;
}

/**
 * Run Calliope as an ACP agent over stdio (stdout/stdin carry JSON-RPC). Started
 * from bin.ts when argv[0] === 'acp'. Resolves when the client closes the stream.
 */
export async function runAcpAgent(): Promise<number> {
  const input = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);
  const agent = serveAcp(stream);
  log(`Calliope ACP agent ready on stdio (protocol v${PROTOCOL_VERSION}). Logs go to stderr.`);

  // Stay alive until the client disconnects (stdin closes).
  await new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.stdin.on('end', done);
    process.stdin.on('close', done);
    process.stdin.on('error', done);
  });

  await agent.shutdown();
  log('ACP client disconnected; shutting down.');
  return 0;
}
