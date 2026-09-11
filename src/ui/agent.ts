/** Terminal presentation adapter for the shared turn runtime. */
import type React from 'react';
import { runTurn } from '../runtime/index.js';
import { cancellableDelay, isCancellation, throwIfCancelled } from '../cancellation.js';
import * as config from '../config.js';
import { estimateContextUsage } from '../providers/types.js';
import { getTools } from '../tools.js';
import { RISK_CONFIG } from '../types.js';
import { assessToolRisk } from '../risk.js';
import { formatError, classifyError } from '../errors.js';
import { getAvailableProviders } from '../providers/index.js';
import * as storage from '../storage.js';
import { formatRoutingDecision, type RoutingDecision } from '../routing/index.js';
import { fleetActive, fleetMirrorAssistant } from '../fleet.js';
import * as summarization from '../summarization.js';
import { createStreamFlusher } from '../streaming.js';
import { checkAndWarnContextLimit } from './context.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import type { SmartRoutingConfig } from '../router.js';
import type { Message as LLMMessage, LLMProvider, Mode, MessageContent } from '../types.js';
import type { SessionStats, ThinkingState, ActivityState } from './types.js';
import type { Session } from '../storage.js';
import { IterationLedger } from '../iteration-ledger.js';
import { shouldCheckpoint, createCheckpoint } from '../checkpoint.js';
import { startPreventSleep, stopPreventSleep } from '../prevent-sleep.js';
import { resolveIterationLimit, formatIterationProgress, isFiniteIterationLimit } from '../iteration-limit.js';
import { formatBudgetHalt } from '../budget.js';

function summarizeMessageContent(content: MessageContent): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map(block => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return '[image]';
      return '[content]';
    })
    .join(' ')
    .trim();
}

// ============================================================================
// Agent Context Interface
// ============================================================================

export interface AgentContext {
  onCheckpoint?: import('../runtime/turn.js').TurnOptions['onCheckpoint'];
  signal?: AbortSignal;
  // State
  provider: LLMProvider;
  model: string | undefined;
  onRoute?: (decision: RoutingDecision) => void;
  preferenceSources?: RoutingDecision['preferenceSources'];
  afterLoopTurn?: () => Promise<boolean>;
  mode: Mode;
  confirmMode: boolean;
  autoRoute: boolean;
  actualProvider: string;
  actualModel: string;
  stats: SessionStats;

  // Iteration Ledger
  ledger?: IterationLedger;

  // Circuit Breaker & Smart Routing
  circuitBreaker?: CircuitBreaker;
  smartRouteActive?: boolean;
  smartRoutingConfig?: SmartRoutingConfig;
  setBreakerHealth?: (health: 'ok' | 'warning' | 'tripped') => void;

  // Setters
  setStats: (fn: SessionStats | ((prev: SessionStats) => SessionStats)) => void;
  setStreamingResponse: (fn: string | ((prev: string) => string)) => void;
  setThinkingState: (v: ThinkingState | null) => void;
  setActivityState: (v: ActivityState | null) => void;
  setContextTokens: (v: number) => void;
  setIsProcessing: (v: boolean) => void;
  setEditingQueueIndex: (v: number | null) => void;
  setLoopIteration: (v: number) => void;
  setLoopActive: (v: boolean) => void;

  // Refs
  llmMessages: React.MutableRefObject<LLMMessage[]>;
  loopCancelledRef: React.MutableRefObject<boolean>;
  sessionRef: React.MutableRefObject<Session | null>;

  // Callbacks
  addMessage: (type: 'user' | 'assistant' | 'tool' | 'system' | 'error', content: string, isError?: boolean) => void;
  estimateContextTokens: () => number;
  validateAndRepairMessages: () => boolean;

  // Debug
  debugLog: (label: string, ...args: unknown[]) => void;
}

// ============================================================================
// Validate and Repair Messages
// ============================================================================

/**
 * Validate and repair message history to ensure tool_use always has tool_result.
 */
export function validateAndRepairMessagesImpl(ctx: AgentContext): boolean {
  const messages = ctx.llmMessages.current;
  let repaired = false;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === 'assistant' && msg.toolCalls && msg.toolCalls.length > 0) {
      // Check that each tool_use has a corresponding tool_result
      for (const toolCall of msg.toolCalls) {
        const hasResult = messages.slice(i + 1).some(
          m => m.role === 'tool' && m.toolCallId === toolCall.id
        );
        if (!hasResult) {
          // Add a placeholder tool_result for the missing tool call
          ctx.debugLog('repair', 'Adding missing tool_result for', toolCall.id);
          // Find the right position to insert (right after this assistant message or after existing tool results)
          let insertPos = i + 1;
          while (insertPos < messages.length && messages[insertPos]!.role === 'tool') {
            insertPos++;
          }
          messages.splice(insertPos, 0, {
            role: 'tool',
            content: '[Error: Tool execution was interrupted. Please retry.]',
            toolCallId: toolCall.id,
          });
          repaired = true;
        }
      }
    }
  }

  if (repaired) {
    ctx.addMessage('system', '🔧 Repaired corrupted message history (missing tool results).');
  }
  return repaired;
}

const surfacedWarnings = new Set<string>();

let previousTurnMode: string | null = null;

/** Test seam: clear the plan-to-work transition tracking. */
export function _resetModeTracking(): void {
  previousTurnMode = null;
}

export async function runAgentImpl(ctx: AgentContext, content: MessageContent): Promise<boolean> {
  throwIfCancelled(ctx.signal);
  ctx.debugLog('runAgent', 'ENTER', typeof content === 'string' ? content.substring(0, 50) : '[complex]');

  // Validate message history before adding new content
  ctx.validateAndRepairMessages();

  ctx.llmMessages.current.push({ role: 'user', content });
  ctx.setStats(s => ({ ...s, messageCount: s.messageCount + 1 }));
  ctx.setStreamingResponse('');

  const maxIterations = resolveIterationLimit(config.get('maxIterations'));
  const hasParentRun = Boolean(
    ctx.ledger?.getActiveRun('loop') ||
    ctx.ledger?.getActiveRun('workflow') ||
    ctx.ledger?.getActiveRun('swarm') ||
    ctx.ledger?.getActiveRun('council')
  );
  const runId = ctx.ledger && !hasParentRun
    ? ctx.ledger.startRun('agent', summarizeMessageContent(content), {
        maxIterations: isFiniteIterationLimit(maxIterations) ? maxIterations : null,
      })
    : undefined;
  let runStatus: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'stopped' | undefined;
  let runErrorSummary: string | undefined;

  const sessionId = ctx.sessionRef.current?.id ?? 'session_adhoc';
  const projectDir = ctx.sessionRef.current?.projectPath ?? process.cwd();
  let provider = ctx.actualProvider as LLMProvider;
  let model = ctx.actualModel;
  const justLeftPlanMode = previousTurnMode === 'plan' && ctx.mode !== 'plan';
  previousTurnMode = ctx.mode;
  let flusher: ReturnType<typeof createStreamFlusher> | undefined;
  let iteration = 0;
  let streamStarted = false;
  let errorShown = false;
  let finalResponse = false;
  let lastResponseCost: number | undefined;
  const blocked = new Set<string>();
  const failed = ctx.ledger?.getFailedApproachesMessage();
  if (failed) ctx.llmMessages.current.push({ role: 'user', content: failed });
  const clearDisplay = () => {
    flusher?.destroy();
    ctx.setThinkingState(null);
    ctx.setActivityState(null);
    ctx.setStreamingResponse('');
  };
  try {
    const result = await runTurn({
      onCheckpoint: ctx.onCheckpoint,
      client: 'terminal', sessionId, cwd: projectDir, provider: ctx.provider, model: ctx.model,
      preferenceSources: ctx.preferenceSources,
      routing: { ...ctx.smartRoutingConfig, ...config.get('routing') },
      onRoute: decision => {
        if (decision.selected) { provider = decision.selected.provider; model = decision.selected.model; }
        ctx.onRoute?.(decision);
        ctx.addMessage(decision.selected ? 'system' : 'error', formatRoutingDecision(decision));
      },
      prompt: summarizeMessageContent(content), messages: ctx.llmMessages,
      signal: ctx.signal, mode: ctx.mode, maxIterations,
      inheritScope: true, parallel: true, continueOnLength: true, tools: getTools,
      confirmation: ctx.confirmMode ? 'risk' : 'none',
      prepare: async (request, index) => {
        iteration = index;
        finalResponse = false;
        ctx.ledger?.startIteration(ctx.ledger.getNextIterationNumber());
        flusher?.destroy();
        flusher = createStreamFlusher(delta => ctx.setStreamingResponse(prev => prev + delta));
        streamStarted = false;
        ctx.setStreamingResponse('');
        ctx.setThinkingState({ status: index === 1 ? 'Analyzing request...' : 'Processing response...',
          detail: `Iteration ${formatIterationProgress(index, maxIterations)}`, iteration: index,
          maxIterations: isFiniteIterationLimit(maxIterations) ? maxIterations : undefined });
        ctx.setActivityState({ action: index === 1 ? 'Analyzing request' : 'Processing', target: `iteration ${index}`, startTime: Date.now() });
        ctx.llmMessages.current = summarization.validateMessageHistory(ctx.llmMessages.current);
        const context = estimateContextUsage(request.provider, request.model, ctx.llmMessages.current, request.tools);
        if (context.needsSummarization) {
          const compact = summarization.summarizeConversation(ctx.llmMessages.current, { maxTokens: Math.floor(context.limit * 0.6) });
          if (compact.summarizedCount > 0) ctx.llmMessages.current = compact.messages;
        }
        // Mode directives are transient; compaction never writes them into history.
        let messages = [...ctx.llmMessages.current];
        if (ctx.mode === 'plan') messages.push({ role: 'system', content:
          'You are in PLAN mode: no mutating tools will execute. '
          + 'Read-only tools (read_file, list_files, think, create_plan, ask_question) ARE available — use them. '
          + 'Before proposing any plan, read the files you intend to change and cite file:line for every claim. '
          + 'State explicitly what you verified versus what you assume. '
          + 'A plan produced without reading anything will be marked unverified.' });
        if (justLeftPlanMode && index === 1) messages.push({ role: 'system', content:
          'The user has just switched from plan mode to work mode and replied. '
          + 'Treat their message as approval to execute the plan discussed above. '
          + 'Carry it out now using tools, step by step. '
          + 'Never state that work is done unless you performed it with tool calls in this turn.' });
        return { ...request, messages };
      },
      onCompression: result => {
        ctx.setContextTokens(ctx.estimateContextTokens());
        ctx.addMessage('system', `🔄 Auto-compressed ${result.summarizedCount} messages using ${result.method} (${Math.round(result.originalTokens / 1000)}K → ${Math.round(result.compressedTokens / 1000)}K tokens)`);
      },
      onToken: token => {
        if (!streamStarted) { ctx.setThinkingState(null); streamStarted = true; }
        flusher?.push(token);
      },
      onRetry: (attempt, error, delayMs) => ctx.setThinkingState({ status: `Retrying... (attempt ${attempt + 1})`,
        detail: `${error.message.substring(0, 40)}... Waiting ${Math.round(delayMs / 1000)}s`, iteration,
        maxIterations: isFiniteIterationLimit(maxIterations) ? maxIterations : undefined }),
      onUsage: (response, request, cost) => {
        lastResponseCost = response.usage ? cost : undefined;
        if (!response.usage) return;
        const { inputTokens, outputTokens } = response.usage;
        ctx.setStats(s => ({ ...s, inputTokens: s.inputTokens + inputTokens, outputTokens: s.outputTokens + outputTokens, cost: s.cost + cost }));
        ctx.ledger?.recordTokens(inputTokens, outputTokens, cost);
        storage.recordCost(cost, request.provider, sessionId);
      },
      onWarning: warning => {
        const key = `${sessionId}::${warning}`;
        if (!surfacedWarnings.has(key)) { surfacedWarnings.add(key); ctx.addMessage('system', warning); }
      },
      onResponse: (response, index) => {
        flusher?.flush();
        if (ctx.circuitBreaker) {
          const breaker = ctx.circuitBreaker.check({ iteration: index, inputTokens: response.usage?.inputTokens,
            outputTokens: response.usage?.outputTokens,
            cost: lastResponseCost,
            toolCalls: response.toolCalls?.map(call => ({ name: call.name, arguments: call.arguments })),
            content: response.content, timestamp: new Date() });
          ctx.setBreakerHealth?.(ctx.circuitBreaker.getHealth());
          if (breaker.tripped) {
            ctx.addMessage('system', `⚠️ Circuit breaker tripped: ${breaker.breaker}\n${breaker.message}\n\nUse /breaker resume to continue, /breaker status for details.`);
            runErrorSummary = breaker.message;
            return 'stop';
          }
        }
        if (fleetActive() && response.content) fleetMirrorAssistant(response.content);
        if (response.toolCalls?.length) return;
        finalResponse = true;
        ctx.setThinkingState(null);
        ctx.addMessage('assistant', response.content);
        ctx.setStreamingResponse('');
        ctx.setContextTokens(ctx.estimateContextTokens());
        checkAndWarnContextLimit(provider, model, ctx.estimateContextTokens(), ctx.addMessage);
        if (response.finishReason === 'length') ctx.addMessage('system', '(auto-continuing...)');
        else if (!ctx.onCheckpoint) storage.saveMessageHistory(ctx.llmMessages.current);
        return undefined;
      },
      onRepair: event => {
        if (event.status === 'started') {
          ctx.addMessage('system', `🔧 Malformed tool call from local model (${event.reason}); attempting one repair…`);
        } else {
          ctx.ledger?.recordAction('repair', { tool: event.call.name, ...(event.corrected ? { to: event.corrected.name } : {}) }, event.status, event.status === 'ok' ? undefined : event.reason);
          ctx.addMessage('system', event.status === 'ok' ? `🔧 Repaired tool call → ${event.corrected!.name}`
            : event.corrected ? '🔧 Repair did not resolve the malformed call; surfacing the error.' : '🔧 Repair produced no usable tool call; surfacing the original error.');
        }
      },
      onPermission: (call, decision) => {
        const risk = assessToolRisk(call);
        const display = risk.level !== 'none' ? ` [${RISK_CONFIG[risk.level].bar}]` : '';
        const preview = String(call.arguments.command || call.arguments.path || '...');
        if (decision.decision !== 'allow') {
          blocked.add(call.id);
          ctx.addMessage('tool', `${call.name}: ${preview}${display}\n${decision.reason}`);
          ctx.ledger?.recordAction(call.name, call.arguments, 'blocked', decision.reason);
        } else ctx.addMessage('tool', `⚡ ${call.name}: ${preview}${display}`);
      },
      beforeTool: call => {
        const args = call.arguments;
        const thought = call.name === 'think' ? String(args.thought || '') : undefined;
        ctx.setActivityState({ action: `Executing ${call.name}`, target: String(args.path || args.command || '').substring(0, 40), startTime: Date.now() });
        ctx.setThinkingState({ status: thought ? 'Reasoning...' : `Executing ${call.name}...`, thinking: thought,
          detail: (thought || String(args.path || args.command || '...')).substring(0, 60), iteration,
          maxIterations: isFiniteIterationLimit(maxIterations) ? maxIterations : undefined });
        if (shouldCheckpoint(call.name, args, projectDir)) createCheckpoint(call.name, args, projectDir);
      },
      onToolOutput: (call, chunk) => {
        if (call.name === 'shell') ctx.setActivityState({ action: 'Running shell', target: String(call.arguments.command || '').substring(0, 40),
          startTime: Date.now(), detail: chunk.trimEnd().split('\n').pop()?.substring(0, 60) });
      },
      onToolResult: (call, result) => {
        if (blocked.has(call.id)) return;
        const args = call.arguments;
        ctx.ledger?.recordAction(call.name, args, result.isError ? 'error' : 'ok', result.isError ? result.result : undefined);
        if (call.name === 'think' && !result.isError) ctx.addMessage('tool', String(args.thought || ''));
        else if (call.name === 'ask_question' && !result.isError) {
          let question = `❓ ${String(args.question || '')}`;
          if (typeof args.context === 'string') question += `\n   ${args.context}`;
          if (Array.isArray(args.options)) question += '\n' + args.options.map((o, i) => `   ${i + 1}. ${o}`).join('\n');
          ctx.addMessage('assistant', question);
        } else if (call.name === 'create_plan' && !result.isError) {
          let plan = `📋 Plan: ${String(args.title || 'Plan')}\n`;
          if (typeof args.reasoning === 'string') plan += `\n   ${args.reasoning}\n`;
          if (Array.isArray(args.steps)) plan += '\n' + args.steps.map((step, i) => `   ${i + 1}. [ ] ${step}`).join('\n');
          ctx.addMessage('assistant', plan + '\n\n   Switch to work mode (Shift+Tab) and reply to execute, or give feedback to revise.');
        } else {
          const display = result.displayResult || result.result;
          ctx.addMessage('tool', display.split('\n').slice(0, 5).join('\n') + (display.split('\n').length > 5 ? '\n...' : ''), result.isError);
        }
      },
      onIterationEnd: () => { ctx.ledger?.endIteration(finalResponse ? 'success' : undefined); },
      onError: (error, index) => {
        clearDisplay();
        ctx.ledger?.endIteration('error');
        const message = formatError(error, { provider });
        ctx.addMessage('error', message);
        errorShown = true;
        runErrorSummary = message;
        if (ctx.circuitBreaker) {
          const breaker = ctx.circuitBreaker.check({ iteration: index, error: message, timestamp: new Date() });
          ctx.setBreakerHealth?.(ctx.circuitBreaker.getHealth());
          if (breaker.tripped) {
            ctx.addMessage('system', `⚠️ Circuit breaker tripped: ${breaker.breaker}\n${breaker.message}\n\nUse /breaker resume to continue.`);
            return 'stop';
          }
        }
        const { category } = classifyError(error);
        const others = getAvailableProviders().filter(p => p !== provider);
        if (['rate_limit', 'server'].includes(category) && others.length) ctx.addMessage('system', `💡 Try switching providers: /provider ${others[0]} or /model to see alternatives`);
        else if (['timeout', 'network'].includes(category)) ctx.addMessage('system', '💡 Network issue detected. Check connection and try again, or use /provider to switch.');
        else if (category === 'auth') ctx.addMessage('system', "💡 Run 'calliope --setup' to reconfigure API keys.");
        if (ctx.circuitBreaker && ['rate_limit', 'server', 'timeout', 'network'].includes(category)) {
          ctx.addMessage('system', `Retrying... (circuit breaker will pause after ${ctx.circuitBreaker.getConfig().breakers['repeated-failure'].maxConsecutiveErrors} consecutive failures)`);
          return 'retry';
        }
        return undefined;
      },
    });
    runStatus = ['completed', 'waiting_for_user'].includes(result.reason) ? 'completed' : 'stopped';
    if (result.reason === 'cancelled') {
      runErrorSummary = 'Operation cancelled';
      ctx.ledger?.endIteration('error');
      ctx.validateAndRepairMessages();
    } else if (result.reason === 'iteration_limit') {
      runErrorSummary = `Reached ${maxIterations} iterations limit`;
      ctx.addMessage('system', `⚠️ Reached ${maxIterations} iterations limit. Task may be incomplete. Adjust with /set maxIterations <number>.`);
    } else if (result.reason === 'budget' && result.budget) {
      runErrorSummary = formatBudgetHalt(result.budget);
      ctx.addMessage('system', `‖ ${runErrorSummary}`);
    }
    if (runId) ctx.ledger?.finishRun(runId, runStatus, { errorSummary: runErrorSummary });
    ctx.setContextTokens(ctx.estimateContextTokens());
    if (ctx.mode === 'plan' && result.totals.toolCalls === 0 && result.reason !== 'cancelled') ctx.addMessage('system', '⚠ Unverified plan — the agent read nothing to produce this. Ask it to verify (it can read files in plan mode), or treat claims as assumptions.');
    return ['completed', 'waiting_for_user'].includes(result.reason);
  } catch (error) {
    const cancelled = ctx.signal?.aborted || isCancellation(error);
    if (!cancelled && !errorShown) ctx.addMessage('error', formatError(error, { provider }));
    if (runId) ctx.ledger?.finishRun(runId, cancelled ? 'stopped' : 'failed', { errorSummary: cancelled ? 'Operation cancelled' : String(error) });
    return false;
  } finally { clearDisplay(); }
}

// ============================================================================
// Run Loop
// ============================================================================

/**
 * Agent loop - runs prompt repeatedly until completion promise or max iterations.
 */
export async function runLoopImpl(ctx: AgentContext, prompt: string, maxIter: number, completionPromise?: string): Promise<void> {
  ctx.setIsProcessing(true);

  // Prevent system sleep during long agent loops (macOS)
  startPreventSleep();

  let completedIterations = 0;
  let loopOutcome: 'running' | 'cancelled' | 'promise-met' | 'error' = 'running';
  let loopErrorSummary: string | undefined;
  const loopRunId = ctx.ledger?.startRun('loop', prompt, {
    completionPromise,
    maxIterations: isFiniteIterationLimit(maxIter) ? maxIter : null,
  });

  try {
    for (let i = 0; i < maxIter; i++) {
      // Check if cancelled
      if (ctx.loopCancelledRef.current || ctx.signal?.aborted) {
        ctx.addMessage('system', '🛑 Loop cancelled by user');
        loopOutcome = 'cancelled';
        break;
      }

      completedIterations = i + 1;
      ctx.setLoopIteration(completedIterations);
      ctx.addMessage('system', `🔄 Loop iteration ${formatIterationProgress(completedIterations, maxIter)}`);

      // First iteration: send original prompt. Subsequent: send continuation.
      const iterationPrompt = i === 0
        ? prompt
        : `Continue working on the task: "${prompt}"\n\nThis is iteration ${i + 1}. Review what you've done so far and continue making progress.`;

      try {
        // Run the agent
        if (!await runAgentImpl(ctx, iterationPrompt) || ctx.afterLoopTurn && !await ctx.afterLoopTurn()) {
          loopOutcome = ctx.signal?.aborted ? 'cancelled' : 'error';
          loopErrorSummary = 'Turn stopped; queued work and remaining loop iterations are paused';
          break;
        }

        // Check for completion promise in the last assistant message
        if (completionPromise) {
          const lastMessage = ctx.llmMessages.current[ctx.llmMessages.current.length - 1];
          if (lastMessage?.role === 'assistant') {
            const content = typeof lastMessage.content === 'string'
              ? lastMessage.content
              : JSON.stringify(lastMessage.content);
            if (content.includes(completionPromise)) {
              ctx.addMessage('system', `🎉 Completion promise "${completionPromise}" detected! Loop finished.`);
              loopOutcome = 'promise-met';
              break;
            }
          }
        }

        // Check cancelled again after agent run
        if (ctx.loopCancelledRef.current || ctx.signal?.aborted) {
          ctx.addMessage('system', '🛑 Loop cancelled by user');
          loopOutcome = 'cancelled';
          break;
        }

        // Small delay between iterations
        if (i + 1 < maxIter) {
          await cancellableDelay(500, ctx.signal);
        }

      } catch (error) {
        if (ctx.signal?.aborted || isCancellation(error)) {
          ctx.addMessage('system', '🛑 Loop cancelled by user');
          loopOutcome = 'cancelled';
          break;
        }
        loopErrorSummary = error instanceof Error ? error.message : String(error);
        ctx.addMessage('error', `Loop error: ${loopErrorSummary}`);
        loopOutcome = 'error';
        break;
      }
    }

    if (loopOutcome === 'running') {
      if (completionPromise) {
        ctx.addMessage('system', `⚠️ Loop stopped after ${completedIterations} iteration${completedIterations === 1 ? '' : 's'} without matching completion promise "${completionPromise}".`);
      } else {
        ctx.addMessage('system', `✅ Loop completed ${completedIterations} iteration${completedIterations === 1 ? '' : 's'}.`);
      }
    }
  } finally {
    if (loopRunId) {
      const finalStatus = loopOutcome === 'cancelled'
        ? 'cancelled'
        : loopOutcome === 'error'
          ? 'failed'
          : loopOutcome === 'promise-met'
            ? 'completed'
            : completionPromise
              ? 'stopped'
              : 'completed';
      ctx.ledger?.finishRun(loopRunId, finalStatus, {
        errorSummary: loopErrorSummary
          || (finalStatus === 'cancelled' ? 'Stopped by user' : undefined)
          || (finalStatus === 'stopped' && completionPromise
            ? `Stopped after ${completedIterations} iterations without matching completion promise`
            : undefined),
      });
    }
    ctx.setLoopActive(false);
    ctx.setIsProcessing(false);
    stopPreventSleep();
  }
}
