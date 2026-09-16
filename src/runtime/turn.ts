/** One model/tool turn engine. Clients adapt context, presentation and approval. */
import { chat } from '../providers/index.js';
import type { ChatOptions, StreamCallback, RetryCallback } from '../providers/types.js';
import type { ProviderAttemptBudget } from '../providers/types.js';
import { executeTool, getTools, type ExecuteToolOptions } from '../tools.js';
import { DEFAULT_MODELS, calculateCost, type LLMProvider, type LLMResponse, type Message, type Tool, type ToolCall, type ToolResult, type Mode } from '../types.js';
import { cancellable, cancellableDelay, cancellationError, isCancellation, throwIfCancelled } from '../cancellation.js';
import { selectRoute, formatRoutingDecision, adaptRoutingPrompt, RoutingUnavailableError, type RouteCandidate, type RoutingDecision, type RoutingPreferences } from '../routing/index.js';
import { autoCompress, type CompressionResult } from '../auto-compressor.js';
import { withScope } from '../scope.js';
import { analyzeDependencies } from '../parallel-tools.js';
import { getModelContextLimit } from '../model-detection.js';
import { isLocalBackend } from '../local-model.js';
import { resolveIterationLimit } from '../iteration-limit.js';
import { getBudgetCaps, evaluateBudget, hasBudgetCaps, loadProjectSpend, formatBudgetHalt, type BudgetVerdict } from '../budget.js';
import { RunLog } from '../runlog.js';
import * as config from '../config.js';
import { executeHooks } from '../hooks.js';
import { resolvePermission, type PermissionContext } from './permissions.js';
import type { PermissionDecision } from './types.js';
import { repairToolCalls, type RepairEvent } from './repair.js';
import { shouldRetryTool } from './tool-retry.js';
import { withSession, makeToolOutput, saveToolOutput, type CapturedToolOutput, type RecoveryStatus } from '../sessions/index.js';
import { getSessionDirById } from '../storage.js';
import { assessToolRisk } from '../risk.js';
import type { ApprovalChoice, ApprovalStore } from '../approvals/index.js';
import { StreamInterruptedError, StreamProtocolError, ProviderRefusalError } from '../errors.js';
import { ExecutionGuard, ExecutionLimitError, agentFiles, projectAttemptBudget, type AgentExecution } from '../execution/index.js';
import {randomUUID} from 'node:crypto';

export interface RuntimeRequest { provider: LLMProvider; model: string; messages: Message[]; tools: Tool[]; route?: RouteCandidate }
export type TurnReason = 'completed' | 'cancelled' | 'budget' | 'iteration_limit' | 'length' | 'waiting_for_user' | 'stopped';
export interface TurnTotals { inputTokens: number; outputTokens: number; cost: number; toolCalls: number; durationMs: number }
export interface TurnResult { reason: TurnReason; iterations: number; totals: TurnTotals; budget?: BudgetVerdict }
export interface TurnOptions {
  /** Planning calls reserve measured prompt size while retaining the reviewed context ceiling. */
  measuredInputReservation?: boolean;
  execution?: AgentExecution;
  reasoningEffort?: ChatOptions['reasoningEffort'];
  client?: 'terminal' | 'headless' | 'acp' | 'library';
  sessionId: string; cwd: string; provider: LLMProvider; model?: string; prompt: string;
  messages: { current: Message[] }; signal?: AbortSignal; mode?: Mode;
  maxIterations?: number; maxRetries?: number; parallel?: boolean; continueOnLength?: boolean;
  inheritScope?: boolean; runlog?: RunLog; toolOptions?: ExecuteToolOptions;
  approvals?: ApprovalStore;
  captureToolOutput?: boolean;
  confirmation: PermissionContext['confirmation']; approve?: (call: ToolCall, decision: PermissionDecision) => Promise<ApprovalChoice>;
  tools?: () => Tool[];
  prepare?: (request: RuntimeRequest, iteration: number) => Promise<RuntimeRequest>;
  onCompression?: (result: CompressionResult) => void;
  onToken?: StreamCallback; onRetry?: RetryCallback;
  onStreamReset?: () => void;
  onStreamEvent?: ChatOptions['onStreamEvent'];
  onUsage?: (response: LLMResponse, request: RuntimeRequest, cost: number) => void;
  onResponse?: (response: LLMResponse, iteration: number) => void | 'stop' | Promise<void | 'stop'>;
  onRepair?: (event: RepairEvent) => void;
  onToolStart?: (call: ToolCall, iteration: number) => void | Promise<void>;
  onPermission?: (call: ToolCall, decision: PermissionDecision) => void | Promise<void>;
  beforeTool?: (call: ToolCall, iteration: number) => void | Promise<void>;
  onToolOutput?: (call: ToolCall, chunk: string) => void;
  onToolResult?: (call: ToolCall, result: ToolResult, iteration: number, output?: CapturedToolOutput) => void | Promise<void>;
  onToolRetry?: (call: ToolCall, attempt: number, result: ToolResult) => void;
  onIterationEnd?: (iteration: number) => void;
  onError?: (error: unknown, iteration: number) => 'retry' | 'stop' | void | Promise<'retry' | 'stop' | void>;
  onWarning?: (message: string) => void;
  routing?: RoutingPreferences;
  smart?: import('../routing/smart.js').SmartRoutingSelection;
  preferenceSources?: RoutingDecision['preferenceSources'];
  onRoute?: (decision: RoutingDecision) => void | Promise<void>;
  /** Must finish before execution continues. A failed recovery write stops the turn. */
  onCheckpoint?: (messages: Message[], status: RecoveryStatus) => void | Promise<void>;
  /** Called once before the first allowed medium-or-higher-risk action in a turn. */
  onSafetyBranch?: (call: ToolCall) => Promise<void>;
}

function contextResult(call: ToolCall, result: ToolResult, limit: number): string {
  if (!result.isError && call.name === 'ask_question') return '[Waiting for user response. The user will reply with their answer.]';
  if (!result.isError && call.name === 'create_plan') return '[Plan displayed to user. Waiting for approval. Do NOT proceed with execution until the user approves.]';
  const max = limit < 8000 ? Math.floor(limit * 0.6) : limit < 16000 ? Math.floor(limit * 0.8) : limit < 32000 ? 20000 : 50000;
  const half = Math.floor(max / 2);
  return result.result.length <= max ? result.result : result.result.slice(0, half) + `\n[Tool output truncated: ${result.result.length - max} chars]\n` + result.result.slice(-half);
}

/** Cancel/stop paths complete outstanding tool pairs without claiming execution. */
export function completePendingTools(messages: Message[], reason: string): void {
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role !== 'assistant' || !message.toolCalls?.length) continue;
    let end = index + 1;
    while (end < messages.length && messages[end]!.role === 'tool') end++;
    const recorded = new Set(messages.slice(index + 1, end).map(result => result.toolCallId));
    for (const call of message.toolCalls) if (!recorded.has(call.id)) {
      messages.splice(end++, 0, { role: 'tool', toolCallId: call.id, content: `[${reason}; no result recorded. Do not assume completion or replay automatically.]` });
      recorded.add(call.id);
    }
    index = end - 1;
  }
}

export async function runTurn(options: TurnOptions): Promise<TurnResult> {
  const guard=options.execution?new ExecutionGuard(options.execution,options.cwd):undefined;
  if(!guard)return withSession(options.sessionId, () => withScope(options.cwd, () => executeTurn(options), options.inheritScope));
  const controller=new AbortController(),abort=()=>controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  if(Date.now()>=guard.deadline)controller.abort();
  const timer=setTimeout(()=>controller.abort(),Math.max(0,guard.deadline-Date.now()));
  try{return await withSession(options.sessionId,()=>withScope(options.cwd,()=>executeTurn({...options,signal:controller.signal},guard),options.inheritScope));}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',abort);}
}

async function executeTurn(options: TurnOptions,guard?:ExecutionGuard): Promise<TurnResult> {
  const { signal, messages } = options;
  const started = Date.now();
  const totals: TurnTotals = { inputTokens: 0, outputTokens: 0, cost: 0, toolCalls: 0, durationMs: 0 };
  const runlog = options.runlog ?? RunLog.open(options.sessionId);
  const caps = getBudgetCaps();
  const trackProject = typeof caps.maxCostPerProject === 'number';
  const projectRunId=guard?.manifest.runId??randomUUID();
  const seenWarnings = new Set<string>();
  const repairedIds = new Set<string>();
  let reason: TurnReason | 'error' = 'iteration_limit';
  let iterations = 0;
  let budget: BudgetVerdict | undefined;
  let permissionCancelled = false;
  let checkpointFailed = false;
  let safetyFailed = false;
  let safetyBranch: Promise<void> | undefined;
  // Parallel tools can finish together: serialize snapshots and copy each boundary now.
  let checkpointTail = Promise.resolve();
  const checkpoint = (status: RecoveryStatus): Promise<void> => {
    if (!options.onCheckpoint || checkpointFailed) return checkpointTail;
    const copy = structuredClone(messages.current);
    checkpointTail = checkpointTail.then(() => options.onCheckpoint!(copy, status)).catch(error => {
      checkpointFailed = true;
      throw error;
    });
    return checkpointTail;
  };
  let currentRequest: RuntimeRequest = { provider: options.provider, model: options.model || DEFAULT_MODELS[options.provider], messages: messages.current, tools: [] };
  const origin = { provider: options.provider, model: options.model };
  const resolveRoute = async (input: RuntimeRequest, initial = false, extra: ChatOptions = {}, stream = true): Promise<RuntimeRequest> => {
    throwIfCancelled(signal);
    const decision = await selectRoute({ provider: initial ? options.provider : input.provider, model: initial ? options.model : input.model,
      ...(initial ? {} : { origin }), messages: input.messages, preferences: options.routing, smart:options.smart, signal,
      requirements: { reasoningEffort: options.reasoningEffort, tools: input.tools.length > 0, streaming: stream && !!options.onToken,
        vision: input.messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image')),
        json: extra.format !== undefined,
        inputTokens: Math.ceil(JSON.stringify(input.messages).length / 3), outputTokens: 250 },
    });
    if (options.preferenceSources) decision.preferenceSources = options.preferenceSources;
    runlog.routingDecision(decision);
    if (options.onRoute) await cancellable(Promise.resolve(options.onRoute(decision)),signal);
    else options.onWarning?.(formatRoutingDecision(decision));
    if (decision.status === 'cancelled') throw cancellationError();
    if (!decision.selected) throw new RoutingUnavailableError(decision);
    return { ...input, provider: decision.selected.provider, model: decision.selected.model, route: decision.selected,
      messages: adaptRoutingPrompt(input.messages, decision.selected.provider) };
  };
  const checkBudget = () => {
    guard?.assertActive(signal);
    if (!hasBudgetCaps(caps)) return;
    const verdict = evaluateBudget(caps, { runCostUsd: totals.cost, runTokens: totals.inputTokens + totals.outputTokens, projectCostUsd: trackProject ? loadProjectSpend(options.cwd).spentUsd : 0 });
    if (verdict.exceeded) {
      budget = verdict;
      const error = new Error(formatBudgetHalt(verdict));
      error.name = 'RuntimeBudgetExceeded';
      throw error;
    }
  };
  const request = async (input: RuntimeRequest, extra: ChatOptions = {}, stream = true): Promise<LLMResponse> => {
    throwIfCancelled(signal);
    checkBudget();
    if(guard)input={...input,tools:guard.tools(input.tools)};
    input = await resolveRoute(input, false, extra, stream);
    throwIfCancelled(signal);
    if(guard)input={...input,tools:guard.tools(input.tools)};
    const maxOutputTokens=guard?.maxOutputTokens??(trackProject?input.route?.maxOutputTokens??0:undefined);
    const requestController=!guard&&trackProject?new AbortController():undefined;
    const abortRequest=()=>requestController?.abort(signal?.reason);
    const requestSignal=requestController?.signal??signal;
    let attemptBudget:ProviderAttemptBudget|undefined;
    try {
      attemptBudget=guard?.budget(input.route,input.messages,input.tools,stream&&!!options.onToken,signal,event=>runlog.policyEvent({tool:'provider',source:'execution-budget',decision:event.stage==='exceeded'?'deny':'allow',reason:JSON.stringify(event),durationMs:0}))
        ??(trackProject?projectAttemptBudget(options.cwd,projectRunId,input.route,input.messages,input.tools,stream&&!!options.onToken,maxOutputTokens!,requestSignal,(requestId,stage,quoteEvidence)=>runlog.policyEvent({tool:'provider',source:'project-budget',decision:stage==='exceeded'?'deny':'allow',reason:JSON.stringify({requestId,stage,quoteEvidence}),durationMs:0}),options.measuredInputReservation??false):undefined);
    } catch (error) {
      runlog.policyEvent({tool:'provider',source:'execution-budget',decision:'deny',reason:error instanceof Error?error.message:'Budget admission failed',durationMs:0});
      throw error;
    }
    signal?.addEventListener('abort',abortRequest,{once:true});if(signal?.aborted)abortRequest();
    const requestTimer=requestController?setTimeout(()=>requestController.abort(),60000):undefined;
    let response:LLMResponse;
    try {response = await chat(input.provider, input.messages, input.tools, input.model, stream ? options.onToken : undefined, options.onRetry, { ...extra, signal:requestSignal,
      ...(attemptBudget?{maxOutputTokens,attemptBudget}:{}),
      reasoningEffort: options.reasoningEffort,
      selectionMode: origin.provider === 'auto' ? 'auto' : 'explicit',
      onStreamReset: stream ? options.onStreamReset : undefined,
      onStreamEvent: event => { runlog.streamAttempt(event, { iteration: iterations, provider: input.provider, model: input.model }); options.onStreamEvent?.(event); },
      onHealthWarning: (message, denied = false) => {
        runlog.policyEvent({ tool: 'provider', source: 'provider-health', decision: denied ? 'deny' : 'allow', reason: message, durationMs: 0 });
        options.onWarning?.(message);
      },
    });}finally{if(requestTimer)clearTimeout(requestTimer);signal?.removeEventListener('abort',abortRequest);}
    throwIfCancelled(signal);
    const prices = input.route?.price;
    const costSource = prices?.input !== undefined && prices.output !== undefined ? 'discovery' : 'fallback';
    const cost = response.usage ? costSource === 'discovery'
      ? response.usage.inputTokens / 1000000 * prices!.input! + response.usage.outputTokens / 1000000 * prices!.output!
      : calculateCost(input.model, response.usage.inputTokens, response.usage.outputTokens) : 0;
    totals.inputTokens += response.usage?.inputTokens ?? 0;
    totals.outputTokens += response.usage?.outputTokens ?? 0;
    totals.cost += cost;
    // Project accounting is committed by the attempt receipt, including retries and unknown outcomes.
    runlog.assistantMessage({ content: response.content, tokens: { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 }, cost, costSource });
    options.onUsage?.(response, input, cost);
    for (const warning of response.warnings ?? []) if (!seenWarnings.has(warning)) { seenWarnings.add(warning); options.onWarning?.(warning); }
    return response;
  };
  const report = async (call: ToolCall, result: ToolResult, durationMs: number) => {
    let output: CapturedToolOutput | undefined;
    if (options.captureToolOutput) {
      try {
        const content = call.name === 'think' && !result.isError && typeof call.arguments.thought === 'string' ? call.arguments.thought
          : result.displayResult && result.displayResult !== result.result ? `${result.result}\n\n--- Tool preview ---\n${result.displayResult}` : result.result;
        output = { record: makeToolOutput(call.id, call.name, content, !!result.isError), saved: false };
        const dir = getSessionDirById(options.sessionId);
        if (!dir) throw new Error('Session storage is unavailable.');
        saveToolOutput(dir, output.record); output.saved = true;
      } catch { options.onWarning?.('Tool output could not be saved. The tool has already finished and will not be repeated; use /tools to inspect any retained output.'); }
    }
    runlog.toolResult({ id: call.id, result: result.result, isError: !!result.isError, durationMs, ...(output ? { output: { id: output.record.id, hash: output.record.hash, truncated: output.record.truncated, saved: output.saved } } : {}) });
    messages.current.push({ role: 'tool', toolCallId: call.id, content: contextResult(call, result, getModelContextLimit(currentRequest.provider, currentRequest.model)) });
    await checkpoint('active');
    await options.onToolResult?.(call, result, iterations, output);
  };
  const execute = async (call: ToolCall): Promise<boolean> => {
    throwIfCancelled(signal);
    checkBudget();
    runlog.toolCall({ id: call.id, name: call.name, args: call.arguments });
    totals.toolCalls++;
    await options.onToolStart?.(call, iterations);
    const decision = await resolvePermission(call, { cwd: options.cwd, mode: options.mode, confirmation: guard && options.confirmation==='none'?'mutating':options.confirmation, signal, sessionId: options.sessionId, approvals: options.approvals, authority:guard?.check,
      approve: options.approve ? pending => options.approve!(call, pending) : undefined, audit: event => runlog.policyEvent(event) });
    await options.onPermission?.(call, decision);
    throwIfCancelled(signal);
    if (decision.decision === 'cancelled') { permissionCancelled = true; return true; }
    if (decision.decision !== 'allow') { await report(call, { toolCallId: call.id, result: decision.reason, isError: true }, decision.durationMs); return false; }
    await checkpointTail;
    if (options.onSafetyBranch && ['medium', 'high', 'critical'].includes(assessToolRisk(call).level)) {
      safetyBranch ??= Promise.resolve().then(() => options.onSafetyBranch!(call)).catch(error => { if (!isCancellation(error)) safetyFailed = true; throw error; });
      await safetyBranch;
    }
    // A parallel result may have failed to persist while this tool awaited permission.
    await checkpointTail;
    await options.beforeTool?.(call, iterations);
    throwIfCancelled(signal);
    checkBudget();
    const toolStarted = Date.now();
    const runTool = async (): Promise<ToolResult> => {
      await checkpointTail;
      if (safetyFailed) await safetyBranch;
      throwIfCancelled(signal);
      try { return await executeTool(call, options.cwd, Math.min(60000,guard?Math.max(1,guard.deadline-Date.now()):60000), chunk => options.onToolOutput?.(call, chunk), {
      ...options.toolOptions, ...(guard?{authority:guard.check,brain:{...guard.brainContext(),runlog,mode:options.mode},fs:agentFiles(guard,options.execution!.agentId,call,signal)}:{}), signal, appendAnchorHash: isLocalBackend(currentRequest.provider), auditPermission: event => runlog.policyEvent(event),
    }); } catch (error) {
        throwIfCancelled(signal);
        if (isCancellation(error)) throw error;
        return { toolCallId: call.id, result: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
      }
    };
    let result = await runTool();
    throwIfCancelled(signal);
    for (let attempt = 1; result.isError && attempt <= (options.maxRetries ?? 0) && shouldRetryTool(call.name, result.result); attempt++) {
      await cancellableDelay(Math.min(250 * 2 ** (attempt - 1), 4000), signal);
      options.onToolRetry?.(call, attempt, result);
      result = await runTool();
      throwIfCancelled(signal);
    }
    await report(call, result, Date.now() - toolStarted);
    if (!signal?.aborted) {
      const post = executeHooks('post-tool', { tool: call.name, toolArgs: call.arguments, toolResult: result.result }, { signal, bounded: !!guard }).catch(error => {
        throwIfCancelled(signal); options.onWarning?.(`Post-tool hook failed: ${String(error)}`);
      });
      if (guard) await post; else void post.catch(() => {});
    }
    return !result.isError && ['ask_question', 'create_plan'].includes(call.name);
  };

  runlog.runStart({ mode: options.client ?? 'library', session: options.sessionId, cwd: options.cwd, provider: options.provider, model: currentRequest.model, config: config.getConfig() as unknown as Record<string, unknown> });
  runlog.userPrompt(options.prompt);
  const availableTools=()=>guard?guard.tools((options.tools??getTools)()):(options.tools??getTools)();
  try {
    throwIfCancelled(signal);
    await checkpoint('active');
    checkBudget();
    currentRequest = await resolveRoute({ ...currentRequest, tools: availableTools() }, true);
    messages.current = currentRequest.messages;
    const limit = resolveIterationLimit(options.maxIterations ?? config.get('maxIterations'));
    for (iterations = 1; iterations <= limit; iterations++) {
      try {
        throwIfCancelled(signal);
        checkBudget();
        currentRequest = { ...currentRequest, messages: messages.current, tools: availableTools() };
        const compressed = await autoCompress(messages.current, getModelContextLimit(currentRequest.provider, currentRequest.model), currentRequest.provider, currentRequest.model, signal,
          async (summaryMessages, summaryModel) => {
            const response = await request({ ...currentRequest, model: summaryModel || currentRequest.model, messages: summaryMessages, tools: [] }, {}, false);
            checkBudget();
            return response;
          });
        if (compressed.compressed) {
          messages.current = compressed.messages;
          currentRequest.messages = messages.current;
          options.onCompression?.(compressed);
        }
        if (options.prepare) currentRequest = await options.prepare(currentRequest, iterations);
        throwIfCancelled(signal);
        let response = await request(currentRequest);
        if (response.finishReason === 'error') throw response.errorCode === 'refusal' ? new ProviderRefusalError() : new Error('Provider returned an unsuccessful completion');
        try { checkBudget(); }
        catch (error) {
          messages.current.push({ role: 'assistant', content: response.content, ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}), providerMetadata: { ...response.providerMetadata, calliopeRouting: { provider: currentRequest.provider, model: currentRequest.model } } });
          await options.onResponse?.(response, iterations);
          throw error;
        }
        response = await repairToolCalls({ ...currentRequest, response, repairedIds, signal,
          request: async (repairMessages, format) => { const value = await request({ ...currentRequest, messages: repairMessages }, { format }, false); checkBudget(); return value; },
          onRepair: options.onRepair });
        throwIfCancelled(signal);
        messages.current.push({ role: 'assistant', content: response.content, ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}), providerMetadata: { ...response.providerMetadata, calliopeRouting: { provider: currentRequest.provider, model: currentRequest.model } } });
        await checkpoint('active');
        const stop = await options.onResponse?.(response, iterations);
        throwIfCancelled(signal);
        checkBudget();
        if (stop === 'stop') { reason = 'stopped'; break; }
        if (!response.toolCalls?.length) {
          if (response.finishReason === 'length' && options.continueOnLength) {
            messages.current.push({ role: 'user', content: 'Please continue where you left off.' });
            options.onIterationEnd?.(iterations);
            continue;
          }
          reason = response.finishReason === 'length' ? 'length' : 'completed';
          options.onIterationEnd?.(iterations);
          break;
        }
        const canParallel = options.parallel && !response.toolCalls.some(call => ['ask_question', 'create_plan'].includes(call.name));
        const stages = canParallel ? analyzeDependencies(response.toolCalls).stages : response.toolCalls.map(call => [call]);
        let pause = false;
        for (const stage of stages) {
          const results = await Promise.allSettled(stage.map(execute));
          const failed = results.find(result => result.status === 'rejected');
          if (failed?.status === 'rejected') throw failed.reason;
          pause = results.some(result => result.status === 'fulfilled' && result.value);
          if (pause) break;
        }
        options.onIterationEnd?.(iterations);
        if (pause) { reason = permissionCancelled ? 'cancelled' : 'waiting_for_user'; break; }
      } catch (error) {
        if (checkpointFailed || safetyFailed || signal?.aborted || isCancellation(error) || error instanceof ExecutionLimitError || (error instanceof Error && error.name === 'RuntimeBudgetExceeded')) throw error;
        completePendingTools(messages.current, 'Tool execution interrupted');
        const action = await options.onError?.(error, iterations);
        if (action === 'retry' && !(error instanceof StreamInterruptedError) && !(error instanceof StreamProtocolError) && !(error instanceof ProviderRefusalError)) { await cancellableDelay(2000, signal); continue; }
        if (action === 'stop') { reason = 'stopped'; break; }
        throw error;
      }
    }
    iterations = Math.min(iterations, limit);
  } catch (error) {
    if (checkpointFailed || safetyFailed) { reason = 'error'; throw error; }
    if (signal?.aborted || isCancellation(error) || error instanceof ExecutionLimitError && error.code==='deadline') reason = 'cancelled';
    else if (error instanceof ExecutionLimitError && error.code==='budget') {
      reason = 'budget'; budget = { exceeded: true, message: error.message };
      runlog.policyEvent({tool:'provider',source:'execution-budget',decision:'deny',reason:error.message,durationMs:0});
    }
    else if (budget?.exceeded) {
      reason = 'budget';
      runlog.budgetEvent({ scope: budget.scope ?? 'run', kind: budget.kind ?? 'cost', spent: budget.spent ?? 0, cap: budget.cap ?? 0, message: formatBudgetHalt(budget) });
    } else { reason = 'error'; throw error; }
  } finally {
    completePendingTools(messages.current, reason);
    try {
      if (!checkpointFailed) await checkpoint(reason === 'completed' || reason === 'cancelled' || reason === 'waiting_for_user' ? reason : 'interrupted');
    } catch (error) { reason = 'error'; throw error; }
    finally {
      totals.durationMs = Date.now() - started;
      runlog.runEnd({ totals, exitReason: reason });
      await runlog.flush();
    }
  }
  return { reason, iterations, totals, budget };
}
