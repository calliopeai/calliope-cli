/** One model/tool turn engine. Clients adapt context, presentation and approval. */
import { chat } from '../providers/index.js';
import type { ChatOptions, StreamCallback, RetryCallback } from '../providers/types.js';
import { executeTool, getTools, type ExecuteToolOptions } from '../tools.js';
import { DEFAULT_MODELS, calculateCost, type LLMProvider, type LLMResponse, type Message, type Tool, type ToolCall, type ToolResult, type Mode } from '../types.js';
import { cancellableDelay, isCancellation, throwIfCancelled } from '../cancellation.js';
import { autoCompress, type CompressionResult } from '../auto-compressor.js';
import { withScope } from '../scope.js';
import { analyzeDependencies } from '../parallel-tools.js';
import { getModelContextLimit } from '../model-detection.js';
import { isLocalBackend } from '../local-model.js';
import { resolveIterationLimit } from '../iteration-limit.js';
import { getBudgetCaps, evaluateBudget, hasBudgetCaps, loadProjectSpend, recordProjectSpend, formatBudgetHalt, type BudgetVerdict } from '../budget.js';
import { RunLog } from '../runlog.js';
import * as config from '../config.js';
import { executeHooks } from '../hooks.js';
import { resolvePermission, type PermissionContext } from './permissions.js';
import type { PermissionDecision } from './types.js';
import { repairToolCalls, type RepairEvent } from './repair.js';
import { shouldRetryTool } from './tool-retry.js';

export interface RuntimeRequest { provider: LLMProvider; model: string; messages: Message[]; tools: Tool[] }
export type TurnReason = 'completed' | 'cancelled' | 'budget' | 'iteration_limit' | 'length' | 'waiting_for_user' | 'stopped';
export interface TurnTotals { inputTokens: number; outputTokens: number; cost: number; toolCalls: number; durationMs: number }
export interface TurnResult { reason: TurnReason; iterations: number; totals: TurnTotals; budget?: BudgetVerdict }
export interface TurnOptions {
  client?: 'terminal' | 'headless' | 'acp' | 'library';
  sessionId: string; cwd: string; provider: LLMProvider; model?: string; prompt: string;
  messages: { current: Message[] }; signal?: AbortSignal; mode?: Mode;
  maxIterations?: number; maxRetries?: number; parallel?: boolean; continueOnLength?: boolean;
  inheritScope?: boolean; runlog?: RunLog; toolOptions?: ExecuteToolOptions;
  confirmation: PermissionContext['confirmation']; approve?: (call: ToolCall, decision: PermissionDecision) => Promise<'allow' | 'reject' | 'cancelled'>;
  tools?: () => Tool[];
  prepare?: (request: RuntimeRequest, iteration: number) => Promise<RuntimeRequest>;
  onCompression?: (result: CompressionResult) => void;
  onToken?: StreamCallback; onRetry?: RetryCallback;
  onUsage?: (response: LLMResponse, request: RuntimeRequest, cost: number) => void;
  onResponse?: (response: LLMResponse, iteration: number) => void | 'stop' | Promise<void | 'stop'>;
  onRepair?: (event: RepairEvent) => void;
  onToolStart?: (call: ToolCall, iteration: number) => void | Promise<void>;
  onPermission?: (call: ToolCall, decision: PermissionDecision) => void | Promise<void>;
  beforeTool?: (call: ToolCall, iteration: number) => void | Promise<void>;
  onToolOutput?: (call: ToolCall, chunk: string) => void;
  onToolResult?: (call: ToolCall, result: ToolResult, iteration: number) => void | Promise<void>;
  onToolRetry?: (call: ToolCall, attempt: number, result: ToolResult) => void;
  onIterationEnd?: (iteration: number) => void;
  onError?: (error: unknown, iteration: number) => 'retry' | 'stop' | void | Promise<'retry' | 'stop' | void>;
  onWarning?: (message: string) => void;
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

export function runTurn(options: TurnOptions): Promise<TurnResult> {
  return withScope(options.cwd, () => executeTurn(options), options.inheritScope);
}

async function executeTurn(options: TurnOptions): Promise<TurnResult> {
  const { signal, messages } = options;
  const started = Date.now();
  const totals: TurnTotals = { inputTokens: 0, outputTokens: 0, cost: 0, toolCalls: 0, durationMs: 0 };
  const runlog = options.runlog ?? RunLog.open(options.sessionId);
  const caps = getBudgetCaps();
  const trackProject = typeof caps.maxCostPerProject === 'number';
  const seenWarnings = new Set<string>();
  const repairedIds = new Set<string>();
  let reason: TurnReason | 'error' = 'iteration_limit';
  let iterations = 0;
  let budget: BudgetVerdict | undefined;
  let permissionCancelled = false;
  let currentRequest: RuntimeRequest = { provider: options.provider, model: options.model || DEFAULT_MODELS[options.provider], messages: messages.current, tools: [] };
  const checkBudget = () => {
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
    const response = await chat(input.provider, input.messages, input.tools, input.model, stream ? options.onToken : undefined, options.onRetry, { ...extra, signal });
    throwIfCancelled(signal);
    const cost = response.usage ? calculateCost(input.model, response.usage.inputTokens, response.usage.outputTokens) : 0;
    totals.inputTokens += response.usage?.inputTokens ?? 0;
    totals.outputTokens += response.usage?.outputTokens ?? 0;
    totals.cost += cost;
    if (trackProject) recordProjectSpend(options.cwd, cost);
    runlog.assistantMessage({ content: response.content, tokens: { input: response.usage?.inputTokens ?? 0, output: response.usage?.outputTokens ?? 0 }, cost });
    options.onUsage?.(response, input, cost);
    for (const warning of response.warnings ?? []) if (!seenWarnings.has(warning)) { seenWarnings.add(warning); options.onWarning?.(warning); }
    return response;
  };
  const report = async (call: ToolCall, result: ToolResult, durationMs: number) => {
    runlog.toolResult({ id: call.id, result: result.result, isError: !!result.isError, durationMs });
    messages.current.push({ role: 'tool', toolCallId: call.id, content: contextResult(call, result, getModelContextLimit(currentRequest.provider, currentRequest.model)) });
    await options.onToolResult?.(call, result, iterations);
  };
  const execute = async (call: ToolCall): Promise<boolean> => {
    throwIfCancelled(signal);
    checkBudget();
    runlog.toolCall({ id: call.id, name: call.name, args: call.arguments });
    totals.toolCalls++;
    await options.onToolStart?.(call, iterations);
    const decision = await resolvePermission(call, { cwd: options.cwd, mode: options.mode, confirmation: options.confirmation, signal,
      approve: options.approve ? pending => options.approve!(call, pending) : undefined, audit: event => runlog.policyEvent(event) });
    await options.onPermission?.(call, decision);
    throwIfCancelled(signal);
    if (decision.decision === 'cancelled') { permissionCancelled = true; return true; }
    if (decision.decision !== 'allow') { await report(call, { toolCallId: call.id, result: decision.reason, isError: true }, decision.durationMs); return false; }
    await options.beforeTool?.(call, iterations);
    throwIfCancelled(signal);
    checkBudget();
    const toolStarted = Date.now();
    const runTool = async (): Promise<ToolResult> => {
      try { return await executeTool(call, options.cwd, 60000, chunk => options.onToolOutput?.(call, chunk), {
      ...options.toolOptions, signal, appendAnchorHash: isLocalBackend(currentRequest.provider), auditPermission: event => runlog.policyEvent(event),
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
    if (!signal?.aborted) void executeHooks('post-tool', { tool: call.name, toolArgs: call.arguments, toolResult: result.result }).catch(error => options.onWarning?.(`Post-tool hook failed: ${String(error)}`));
    return !result.isError && ['ask_question', 'create_plan'].includes(call.name);
  };

  runlog.runStart({ mode: options.client ?? 'library', session: options.sessionId, cwd: options.cwd, provider: options.provider, model: currentRequest.model, config: config.getConfig() as unknown as Record<string, unknown> });
  runlog.userPrompt(options.prompt);
  try {
    throwIfCancelled(signal);
    checkBudget();
    const limit = resolveIterationLimit(options.maxIterations ?? config.get('maxIterations'));
    for (iterations = 1; iterations <= limit; iterations++) {
      try {
        throwIfCancelled(signal);
        checkBudget();
        currentRequest = { ...currentRequest, messages: messages.current, tools: (options.tools ?? getTools)() };
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
        if (response.finishReason === 'error') throw new Error('Provider returned an unsuccessful completion');
        try { checkBudget(); }
        catch (error) {
          messages.current.push({ role: 'assistant', content: response.content, ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}) });
          await options.onResponse?.(response, iterations);
          throw error;
        }
        response = await repairToolCalls({ ...currentRequest, response, repairedIds, signal,
          request: async (repairMessages, format) => { const value = await request({ ...currentRequest, messages: repairMessages }, { format }, false); checkBudget(); return value; },
          onRepair: options.onRepair });
        throwIfCancelled(signal);
        messages.current.push({ role: 'assistant', content: response.content, ...(response.toolCalls?.length ? { toolCalls: response.toolCalls } : {}) });
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
        if (signal?.aborted || isCancellation(error) || (error instanceof Error && error.name === 'RuntimeBudgetExceeded')) throw error;
        completePendingTools(messages.current, 'Tool execution interrupted');
        const action = await options.onError?.(error, iterations);
        if (action === 'retry') { await cancellableDelay(2000, signal); continue; }
        if (action === 'stop') { reason = 'stopped'; break; }
        throw error;
      }
    }
    iterations = Math.min(iterations, limit);
  } catch (error) {
    if (signal?.aborted || isCancellation(error)) reason = 'cancelled';
    else if (budget?.exceeded) {
      reason = 'budget';
      runlog.budgetEvent({ scope: budget.scope ?? 'run', kind: budget.kind ?? 'cost', spent: budget.spent ?? 0, cap: budget.cap ?? 0, message: formatBudgetHalt(budget) });
    } else { reason = 'error'; throw error; }
  } finally {
    completePendingTools(messages.current, reason);
    totals.durationMs = Date.now() - started;
    runlog.runEnd({ totals, exitReason: reason });
    await runlog.flush();
  }
  return { reason, iterations, totals, budget };
}
