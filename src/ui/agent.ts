/**
 * UI Module - Agent Runner
 *
 * Core agent execution loop, tool handling, and message validation.
 * Extracted from TerminalChat using an AgentContext state bag.
 */

import type React from 'react';
import { spawn, type ChildProcess } from 'child_process';
import * as config from '../config.js';
import { chat } from '../providers/index.js';
import { estimateContextUsage, needsSummarization } from '../providers/types.js';
import { executeTool, getTools } from '../tools.js';
import { DEFAULT_MODELS, RISK_CONFIG, calculateCost } from '../types.js';
import { getModelContextLimit } from '../model-detection.js';
import { assessToolRisk, requiresConfirmation } from '../risk.js';
import { formatError, classifyError } from '../errors.js';
import { getAvailableProviders } from '../providers/index.js';
import * as storage from '../storage.js';
import * as hooks from '../hooks.js';
import * as modelRouter from '../model-router.js';
import * as summarization from '../summarization.js';
import { executeParallel, getParallelizationStats } from '../parallel-tools.js';
import { setMood } from '../companions.js';
import { checkAndWarnContextLimit } from './context.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import type { IterationData, BreakerCheckResult } from '../circuit-breaker.js';
import { smartRoute, getDefaultSmartRoutingConfig } from '../smart-router.js';
import type { SmartRoutingConfig } from '../smart-router.js';
import type { Message as LLMMessage, LLMProvider, Mode, MessageContent, ToolCall } from '../types.js';
import type { UIMessage, SessionStats, ThinkingState, ActivityState } from './types.js';
import type { Session } from '../storage.js';
import { IterationLedger } from '../iteration-ledger.js';
import { shouldCheckpoint, createCheckpoint } from '../auto-checkpoint.js';
import { recordEvent } from '../terminal-recording.js';

// ============================================================================
// Tool Result Truncation
// ============================================================================

/**
 * Truncate tool result content to fit within available context.
 * For small models (< 16K), aggressively cap tool output to prevent context overflow.
 */
function truncateToolResult(content: string, modelLimit: number): string {
  // Scale max tool result size based on model context
  // Small models: 25% of context, large models: up to 50K chars
  const maxChars = modelLimit < 8000 ? Math.floor(modelLimit * 0.6)   // ~2.4K chars for 4K model
    : modelLimit < 16000 ? Math.floor(modelLimit * 0.8)               // ~12K chars for 16K model
    : modelLimit < 32000 ? 20000
    : 50000;

  if (content.length <= maxChars) return content;

  const half = Math.floor(maxChars / 2);
  const trimmed = content.slice(0, half) + `\n\n... [truncated ${content.length - maxChars} chars] ...\n\n` + content.slice(-half);
  return trimmed;
}

// ============================================================================
// Agent Context Interface
// ============================================================================

export interface AgentContext {
  // State
  provider: LLMProvider;
  model: string | undefined;
  mode: Mode;
  confirmMode: boolean;
  autoRoute: boolean;
  actualProvider: string;
  actualModel: string;
  stats: SessionStats;
  agtermEnabled: boolean;

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
  setQueuedMessages: (fn: string[] | ((prev: string[]) => string[])) => void;
  setEditingQueueIndex: (v: number | null) => void;
  setLoopIteration: (v: number) => void;
  setLoopActive: (v: boolean) => void;

  // Refs
  llmMessages: React.MutableRefObject<LLMMessage[]>;
  queuedMessagesRef: React.MutableRefObject<string[]>;
  loopCancelledRef: React.MutableRefObject<boolean>;
  sessionRef: React.MutableRefObject<Session | null>;

  // Callbacks
  addMessage: (type: 'user' | 'assistant' | 'tool' | 'system' | 'error', content: string) => void;
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
    const msg = messages[i];
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
          while (insertPos < messages.length && messages[insertPos].role === 'tool') {
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

// ============================================================================
// Run Agent
// ============================================================================

/**
 * Run agent with user prompt. Core execution loop that handles LLM calls,
 * tool execution (parallel + sequential), auto-compaction, and queued messages.
 */
export async function runAgentImpl(ctx: AgentContext, content: MessageContent): Promise<void> {
  ctx.debugLog('runAgent', 'ENTER', typeof content === 'string' ? content.substring(0, 50) : '[complex]');
  setMood('thinking');

  // Validate message history before adding new content
  ctx.validateAndRepairMessages();

  ctx.llmMessages.current.push({ role: 'user', content });
  ctx.setStats(s => ({ ...s, messageCount: s.messageCount + 1 }));
  ctx.setStreamingResponse('');

  // Smart routing (cross-provider) takes precedence over autoRoute (single-provider)
  let effectiveModel = ctx.model;
  let effectiveProvider = ctx.provider;
  if (ctx.smartRouteActive && ctx.smartRoutingConfig?.enabled && typeof content === 'string') {
    const decision = smartRoute(content, ctx.smartRoutingConfig, {
      messageCount: ctx.stats.messageCount,
      hasCode: content.includes('```') || /\.(ts|js|py|go|rs|java)/.test(content),
    });
    effectiveModel = decision.selected.model;
    effectiveProvider = decision.selected.provider;
    if (effectiveModel !== ctx.model || effectiveProvider !== ctx.provider) {
      ctx.addMessage('system', `[Smart route: ${decision.selected.provider}/${decision.selected.tier} - ${decision.taskType}/${decision.complexity}]`);
    }
  } else if (ctx.autoRoute && typeof content === 'string') {
    const routeDecision = modelRouter.routeRequest(content, ctx.provider, {
      messageCount: ctx.stats.messageCount,
      hasCode: content.includes('```') || /\.(ts|js|py|go|rs|java)/.test(content),
    });
    effectiveModel = routeDecision.model.model;
    if (effectiveModel !== ctx.model) {
      ctx.addMessage('system', `[Auto-route: ${routeDecision.tier} tier - ${routeDecision.reason}]`);
    }
  }

  const maxIterations = config.get('maxIterations') || Infinity; // 0 = unlimited
  let completedNaturally = false;

  // Check context limit and warn if approaching capacity
  // Uses model's actual context length from API when available
  let currentContextTokens = ctx.estimateContextTokens();
  const modelLimit = getModelContextLimit(ctx.actualProvider as LLMProvider, effectiveModel || ctx.actualModel);
  let contextPercentage = (currentContextTokens / modelLimit) * 100;

  // Adaptive preserveRecent: small models keep fewer messages to leave room for output
  const preserveRecent = modelLimit < 8000 ? 2 : modelLimit < 16000 ? 4 : modelLimit < 32000 ? 6 : modelLimit < 64000 ? 10 : 15;

  // Auto-compact if we're over 75% capacity to prevent API errors
  if (contextPercentage > 75) {
    ctx.addMessage('system', `🔄 Context at ${Math.round(contextPercentage)}% - auto-compacting to prevent errors...`);
    const result = summarization.summarizeConversation(ctx.llmMessages.current, {
      maxTokens: Math.floor(modelLimit * 0.7), // Target 70% of limit after compaction
      preserveRecent,
    });
    if (result.summarizedCount > 0) {
      ctx.llmMessages.current = result.messages;
      currentContextTokens = ctx.estimateContextTokens();
      contextPercentage = (currentContextTokens / modelLimit) * 100;
      ctx.setContextTokens(currentContextTokens);
      ctx.addMessage('system', `✓ Compacted ${result.summarizedCount} messages. Now at ${Math.round(contextPercentage)}% (${Math.round(currentContextTokens/1000)}K/${Math.round(modelLimit/1000)}K)`);
    } else {
      // If compaction didn't help enough, force-trim old messages
      if (contextPercentage > 98) {
        const systemMsgs = ctx.llmMessages.current.filter(m => m.role === 'system');
        const recentMsgs = ctx.llmMessages.current.filter(m => m.role !== 'system').slice(-5);
        ctx.llmMessages.current = [...systemMsgs, ...recentMsgs];
        currentContextTokens = ctx.estimateContextTokens();
        contextPercentage = (currentContextTokens / modelLimit) * 100;
        ctx.setContextTokens(currentContextTokens);
        ctx.addMessage('system', `⚠️  Force-trimmed to last 5 messages (${Math.round(contextPercentage)}%). Use /clear for a full reset.`);
      }
    }
  } else if (contextPercentage > 65) {
    ctx.addMessage('system', `⚠️  Context at ${Math.round(contextPercentage)}% capacity (${Math.round(currentContextTokens/1000)}K/${Math.round(modelLimit/1000)}K tokens)
   Consider: /summarize compact | /clear | shorter messages`);
  }

  // Inject failed approaches into context so the agent avoids repeating mistakes
  if (ctx.ledger) {
    const failedMsg = ctx.ledger.getFailedApproachesMessage();
    if (failedMsg) {
      ctx.llmMessages.current.push({ role: 'user', content: failedMsg });
    }
  }

  for (let i = 0; i < maxIterations; i++) {
    // Start ledger tracking for this iteration
    ctx.ledger?.startIteration(i + 1);

    // Safety check at start of each iteration - context may have grown from tool results
    if (i > 0) {
      const iterContextTokens = ctx.estimateContextTokens();
      const iterContextPercentage = (iterContextTokens / modelLimit) * 100;
      if (iterContextPercentage > 75) {
        ctx.addMessage('system', `🔄 Context grew to ${Math.round(iterContextPercentage)}% - auto-compacting...`);
        const result = summarization.summarizeConversation(ctx.llmMessages.current, {
          maxTokens: Math.floor(modelLimit * 0.7),
          preserveRecent,
        });
        if (result.summarizedCount > 0) {
          ctx.llmMessages.current = result.messages;
          ctx.setContextTokens(ctx.estimateContextTokens());
          ctx.addMessage('system', `✓ Compacted ${result.summarizedCount} messages during iteration ${i + 1}`);
        }
      }
    }

    try {
      // Update thinking state for LLM call
      ctx.setThinkingState({
        status: i === 0 ? 'Analyzing request...' : 'Processing response...',
        detail: `Iteration ${i + 1}/${maxIterations}`,
        iteration: i + 1,
        maxIterations,
      });
      ctx.setActivityState({
        action: i === 0 ? 'Analyzing request' : 'Processing',
        target: `iteration ${i + 1}`,
        startTime: Date.now(),
      });

      // Streaming callback for final response
      const onToken = (token: string) => {
        ctx.setThinkingState(null); // Clear thinking when streaming starts
        ctx.setStreamingResponse(prev => prev + token);
      };

      // Retry callback for error recovery
      const onRetry = (attempt: number, error: Error, delayMs: number) => {
        ctx.setThinkingState({
          status: `Retrying... (attempt ${attempt + 1})`,
          detail: `${error.message.substring(0, 40)}... Waiting ${Math.round(delayMs / 1000)}s`,
          iteration: i + 1,
          maxIterations,
        });
      };

      ctx.debugLog('chat', 'WAITING for LLM response', `iteration=${i + 1}`);
      // Validate message history to prevent orphaned tool_result errors
      let validatedMessages = summarization.validateMessageHistory(ctx.llmMessages.current);
      if (validatedMessages.length !== ctx.llmMessages.current.length) {
        ctx.debugLog('chat', 'CLEANED orphaned tool results', `removed=${ctx.llmMessages.current.length - validatedMessages.length}`);
        ctx.llmMessages.current = validatedMessages;
      }

      // Pre-request summarization check - summarize BEFORE sending if context is too large
      const tools = getTools(ctx.agtermEnabled);
      const contextCheck = estimateContextUsage(ctx.provider, effectiveModel || DEFAULT_MODELS[ctx.provider], validatedMessages, tools);
      ctx.debugLog('chat', 'CONTEXT CHECK', `estimated=${contextCheck.estimated}, limit=${contextCheck.limit}, percent=${contextCheck.percent}%`);
      if (contextCheck.needsSummarization) {
        ctx.debugLog('chat', 'PRE-REQUEST SUMMARIZING', `estimated=${contextCheck.estimated} >= 80% of ${contextCheck.limit}`);
        const result = summarization.summarizeConversation(validatedMessages, { maxTokens: Math.floor(contextCheck.limit * 0.6) });
        if (result.summarizedCount > 0) {
          ctx.llmMessages.current = result.messages;
          validatedMessages = result.messages;
          ctx.debugLog('chat', 'PRE-SUMMARIZED', `removed=${result.summarizedCount} messages, reduced from ${result.originalTokens} to ${result.reducedTokens}`);
        }
      }

      const response = await chat(ctx.provider, validatedMessages, tools, effectiveModel, onToken, onRetry);
      ctx.debugLog('chat', 'GOT response', `toolCalls=${response.toolCalls?.length ?? 0}`);

      // Update token stats and cost
      if (response.usage) {
        const usageCost = calculateCost(ctx.model || DEFAULT_MODELS[ctx.provider], response.usage.inputTokens, response.usage.outputTokens);
        ctx.setStats(s => ({
          ...s,
          inputTokens: s.inputTokens + response.usage!.inputTokens,
          outputTokens: s.outputTokens + response.usage!.outputTokens,
          cost: s.cost + usageCost,
        }));
        // Record in iteration ledger
        ctx.ledger?.recordTokens(response.usage.inputTokens, response.usage.outputTokens, usageCost);
        // Persist cost to storage
        storage.recordCost(usageCost, ctx.actualProvider, ctx.sessionRef.current?.id);

        // Auto-summarize if context is getting too full (85% threshold)
        if (needsSummarization(ctx.provider, ctx.model || DEFAULT_MODELS[ctx.provider], response.usage.inputTokens)) {
          ctx.debugLog('chat', 'AUTO-SUMMARIZING', `inputTokens=${response.usage.inputTokens}`);
          const postCompactLimit = Math.floor(getModelContextLimit(ctx.provider, ctx.model || DEFAULT_MODELS[ctx.provider]) * 0.6);
          const result = summarization.summarizeConversation(ctx.llmMessages.current, { maxTokens: postCompactLimit });
          if (result.summarizedCount > 0) {
            ctx.llmMessages.current = result.messages;
            ctx.debugLog('chat', 'SUMMARIZED', `removed=${result.summarizedCount} messages`);
          }
        }
      }

      // Circuit breaker check after each iteration
      if (ctx.circuitBreaker) {
        const iterData: IterationData = {
          iteration: i + 1,
          inputTokens: response.usage?.inputTokens,
          outputTokens: response.usage?.outputTokens,
          cost: response.usage ? calculateCost(ctx.model || DEFAULT_MODELS[ctx.provider], response.usage.inputTokens, response.usage.outputTokens) : undefined,
          toolCalls: response.toolCalls?.map(tc => ({ name: tc.name, arguments: tc.arguments as Record<string, unknown> })),
          content: response.content,
          timestamp: new Date(),
        };
        const breakerResult = ctx.circuitBreaker.check(iterData);
        ctx.setBreakerHealth?.(ctx.circuitBreaker.getHealth());
        if (breakerResult.tripped) {
          ctx.addMessage('system', `\u26a0\ufe0f Circuit breaker tripped: ${breakerResult.breaker}\n${breakerResult.message}\n\nUse /breaker resume to continue, /breaker status for details.`);
          completedNaturally = true;
          break;
        }
      }

      // Handle tool calls with parallel execution support
      if (response.toolCalls?.length) {
        ctx.llmMessages.current.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // ============================================================
        // Phase 1: Pre-check all tools, categorize into blocked vs executable
        // ============================================================
        interface ToolPreCheck {
          toolCall: ToolCall;
          args: Record<string, unknown>;
          preview: string;
          risk: ReturnType<typeof assessToolRisk>;
          riskDisplay: string;
          blocked: boolean;
          blockReason?: string;
          blockContent?: string;
        }

        const preChecks: ToolPreCheck[] = [];
        const executableTools: ToolCall[] = [];

        for (const toolCall of response.toolCalls) {
          const args = toolCall.arguments as Record<string, unknown>;
          const toolPreview = String(args.command || args.path || '...');
          const risk = assessToolRisk(toolCall);
          const riskConfig = RISK_CONFIG[risk.level];
          const riskDisplay = risk.level !== 'none' ? ` [${riskConfig.bar}]` : '';

          const preCheck: ToolPreCheck = {
            toolCall,
            args,
            preview: toolPreview,
            risk,
            riskDisplay,
            blocked: false,
          };

          // Check blocking conditions
          const PLAN_MODE_ALLOWED = new Set(['think', 'ask_question', 'create_plan', 'read_file', 'list_files']);
          if (ctx.mode === 'plan' && !PLAN_MODE_ALLOWED.has(toolCall.name)) {
            preCheck.blocked = true;
            preCheck.blockReason = 'plan mode';
            preCheck.blockContent = '[Plan mode: Tool not executed. Describe what this would do.]';
            ctx.addMessage('tool', `📋 ${toolCall.name}: ${toolPreview}${riskDisplay} (plan mode - not executed)`);
          } else if (ctx.confirmMode && requiresConfirmation(risk, false) && toolCall.name !== 'think') {
            preCheck.blocked = true;
            preCheck.blockReason = 'confirmation required';
            preCheck.blockContent = `[Operation blocked - ${risk.level} risk: ${risk.reason}. User confirmation required.]`;
            const riskIcon = risk.level === 'critical' ? '🛑' : '⚠️';
            ctx.addMessage('tool', `${riskIcon} ${toolCall.name}: ${toolPreview}${riskDisplay}\n  → Requires confirmation (use /confirm off to disable)`);
          } else {
            // Check pre-tool hooks
            const preHookResult = await hooks.checkHooksAllow('pre-tool', {
              tool: toolCall.name,
              toolArgs: args,
            });
            if (!preHookResult.allowed) {
              preCheck.blocked = true;
              preCheck.blockReason = 'blocked by hook';
              preCheck.blockContent = `[Blocked by hook: ${preHookResult.reason}]`;
              ctx.addMessage('tool', `⚡ ${toolCall.name}: ${toolPreview}${riskDisplay}`);
              ctx.addMessage('tool', `🛑 Blocked by hook: ${preHookResult.reason}`);
            } else {
              // Tool can be executed
              executableTools.push(toolCall);
              ctx.addMessage('tool', `⚡ ${toolCall.name}: ${toolPreview}${riskDisplay}`);
            }
          }

          preChecks.push(preCheck);

          // Record blocked tools in ledger and add to LLM messages
          if (preCheck.blocked) {
            ctx.ledger?.recordAction(toolCall.name, args, 'blocked', preCheck.blockReason);
            ctx.llmMessages.current.push({
              role: 'tool',
              content: preCheck.blockContent!,
              toolCallId: toolCall.id,
            });
          }
        }

        // ============================================================
        // Phase 2: Execute tools (parallel when beneficial)
        // ============================================================
        if (executableTools.length > 0) {
          const parallelStats = getParallelizationStats(executableTools);
          const useParallel = parallelStats.maxParallel > 1 && executableTools.length > 1;

          if (useParallel) {
            // Show parallelization info
            ctx.setThinkingState({
              status: `Executing ${executableTools.length} tools in parallel...`,
              detail: `${parallelStats.stages} stages, up to ${parallelStats.maxParallel}x speedup`,
              iteration: i + 1,
              maxIterations,
            });
            ctx.setActivityState({
              action: `Executing ${executableTools.length} tools`,
              target: 'in parallel',
              startTime: Date.now(),
            });

            // Execute in parallel using dependency-aware staging
            ctx.debugLog('tools', 'PARALLEL exec start', `count=${executableTools.length}`);
            const results = await executeParallel(
              executableTools,
              async (call) => {
                const result = await executeTool(call, process.cwd());
                return result.result;
              },
              (completed, total, current) => {
                const args = current.arguments as Record<string, unknown>;
                const target = (args.path as string) || (args.command as string)?.substring(0, 30) || current.name;
                ctx.setActivityState({
                  action: `Running ${current.name}`,
                  target: target,
                  startTime: Date.now(),
                });
                ctx.setThinkingState({
                  status: `Executing tools... (${completed + 1}/${total})`,
                  detail: current.name,
                  iteration: i + 1,
                  maxIterations,
                });
              }
            );

            ctx.debugLog('tools', 'PARALLEL exec done', `results=${results.length}`);
            // Process results sequentially for UI and LLM messages
            for (const result of results) {
              const toolCall = result.toolCall;
              const args = toolCall.arguments as Record<string, unknown>;
              recordEvent('tool_call', toolCall.name, { name: toolCall.name, arguments: args });
              recordEvent('tool_result', (result.result || result.error || '').slice(0, 1000), { name: toolCall.name, isError: !!result.error });

              // Record in iteration ledger
              ctx.ledger?.recordAction(
                toolCall.name,
                args,
                result.error ? 'error' : 'ok',
                result.error || undefined,
              );

              // Execute post-tool hooks
              hooks.executeHooks('post-tool', {
                tool: toolCall.name,
                toolArgs: args,
                toolResult: result.result,
              }).catch((err) => {
                ctx.debugLog('hooks', `post-tool hook failed for ${toolCall.name}:`, err instanceof Error ? err.message : err);
              });

              // Display result
              if (toolCall.name === 'think') {
                const thought = String(args.thought || '');
                ctx.addMessage('tool', thought);
              } else if (result.error) {
                ctx.addMessage('tool', `Error: ${result.error}`);
              } else {
                const preview = result.result.split('\n').slice(0, 3).join('\n');
                ctx.addMessage('tool', preview + (result.result.split('\n').length > 3 ? '\n...' : ''));
              }

              ctx.llmMessages.current.push({
                role: 'tool',
                content: truncateToolResult(result.error ? `Error: ${result.error}` : result.result, modelLimit),
                toolCallId: toolCall.id,
              });
            }
          } else {
            // Sequential execution (single tool or dependencies prevent parallelization)
            ctx.debugLog('tools', 'SEQUENTIAL exec start', `count=${executableTools.length}`);
            for (const toolCall of executableTools) {
              const args = toolCall.arguments as Record<string, unknown>;
              const toolPreview = String(args.command || args.path || args.content?.toString().substring(0, 30) || '...');

              // Set activity state for streaming indicator
              const actionMap: Record<string, string> = {
                read_file: 'Reading',
                write_file: 'Writing',
                edit_file: 'Editing',
                bash: 'Running',
                search: 'Searching',
                glob: 'Finding',
                think: 'Thinking',
              };
              const action = actionMap[toolCall.name] || `Executing ${toolCall.name}`;
              const target = toolCall.name === 'bash'
                ? (args.command as string)?.substring(0, 40) + ((args.command as string)?.length > 40 ? '...' : '')
                : toolCall.name === 'think'
                ? undefined
                : (args.path as string) || (args.pattern as string);
              ctx.setActivityState({ action, target, startTime: Date.now() });

              // Special handling for think tool UI
              if (toolCall.name === 'think') {
                const thought = String(args.thought || '');
                ctx.setThinkingState({
                  status: 'Reasoning...',
                  detail: thought.substring(0, 60) + (thought.length > 60 ? '...' : ''),
                  thinking: thought,
                  iteration: i + 1,
                  maxIterations,
                });
              } else {
                ctx.setThinkingState({
                  status: `Executing ${toolCall.name}...`,
                  detail: toolPreview.substring(0, 60),
                  thinking: undefined,
                  iteration: i + 1,
                  maxIterations,
                });
              }

              ctx.debugLog('tools', 'EXEC', toolCall.name, toolPreview.substring(0, 30));
              recordEvent('tool_call', toolCall.name, { name: toolCall.name, arguments: args });
              // Auto-checkpoint before destructive operations
              if (shouldCheckpoint(toolCall.name, args)) {
                const hash = createCheckpoint(toolCall.name, args);
                if (hash) {
                  ctx.debugLog('checkpoint', `auto-checkpoint ${hash} before ${toolCall.name}`);
                }
              }
              // Stream shell output in real-time (#15)
              const shellStreamCallback = toolCall.name === 'shell' ? (chunk: string) => {
                ctx.setActivityState({
                  action: 'Running shell',
                  target: (args.command as string)?.substring(0, 40),
                  startTime: Date.now(),
                  detail: chunk.trimEnd().split('\n').pop()?.substring(0, 60),
                });
              } : undefined;
              const result = await executeTool(toolCall, process.cwd(), 60000, shellStreamCallback);
              ctx.debugLog('tools', 'DONE', toolCall.name);
              recordEvent('tool_result', result.result.slice(0, 1000), { name: toolCall.name, isError: result.isError });

              // Record in iteration ledger
              ctx.ledger?.recordAction(
                toolCall.name,
                args,
                result.isError ? 'error' : 'ok',
                result.isError ? result.result : undefined,
              );

              // Execute post-tool hooks
              hooks.executeHooks('post-tool', {
                tool: toolCall.name,
                toolArgs: args,
                toolResult: result.result,
              }).catch((err) => {
                ctx.debugLog('hooks', `post-tool hook failed for ${toolCall.name}:`, err instanceof Error ? err.message : err);
              });

              // Display result - use displayResult for UI, full result for LLM (#25)
              if (toolCall.name === 'think') {
                const thought = String(args.thought || '');
                ctx.addMessage('tool', thought);
              } else if (toolCall.name === 'ask_question') {
                // Display question prominently (#42)
                const question = String(args.question || '');
                const options = Array.isArray(args.options) ? args.options as string[] : undefined;
                const contextNote = typeof args.context === 'string' ? args.context : undefined;
                let questionMsg = `❓ ${question}`;
                if (contextNote) questionMsg += `\n   ${contextNote}`;
                if (options) questionMsg += '\n' + options.map((o: string, i: number) => `   ${i + 1}. ${o}`).join('\n');
                ctx.addMessage('assistant', questionMsg);
                // Tell the LLM that we're waiting for user input
                ctx.llmMessages.current.push({
                  role: 'tool',
                  content: '[Waiting for user response. The user will reply with their answer.]',
                  toolCallId: toolCall.id,
                });
                // Break out of tool loop - let user respond naturally
                completedNaturally = true;
              } else if (toolCall.name === 'create_plan') {
                // Display plan as a checklist for user approval (#19)
                const planTitle = String(args.title || 'Plan');
                const planSteps = Array.isArray(args.steps) ? args.steps as string[] : [];
                const planReasoning = typeof args.reasoning === 'string' ? args.reasoning : undefined;
                let planMsg = `📋 Plan: ${planTitle}\n`;
                if (planReasoning) planMsg += `\n   ${planReasoning}\n`;
                planMsg += '\n' + planSteps.map((s: string, idx: number) => `   ${idx + 1}. [ ] ${s}`).join('\n');
                planMsg += '\n\n   Type /approve to execute, or provide feedback to revise.';
                ctx.addMessage('assistant', planMsg);
                // Tell the LLM to wait for user approval
                ctx.llmMessages.current.push({
                  role: 'tool',
                  content: '[Plan displayed to user. Waiting for approval. The user will either type /approve to execute the plan, or provide feedback to revise it. Do NOT proceed with execution until the user approves.]',
                  toolCallId: toolCall.id,
                });
                // Break out of tool loop - wait for user approval
                completedNaturally = true;
              } else {
                const display = result.displayResult || result.result;
                const preview = display.split('\n').slice(0, 5).join('\n');
                ctx.addMessage('tool', preview + (display.split('\n').length > 5 ? '\n...' : ''));
              }

              if (toolCall.name !== 'ask_question') {
                ctx.llmMessages.current.push({
                  role: 'tool',
                  content: truncateToolResult(result.result, modelLimit),
                  toolCallId: toolCall.id,
                });
              }
            }
          }
        }
        ctx.ledger?.endIteration();
        if (completedNaturally) break; // ask_question pauses for user input (#42)
        continue;
      }


      // Final response - move streaming content to message history
      ctx.setThinkingState(null);
      ctx.llmMessages.current.push({ role: 'assistant', content: response.content });
      ctx.addMessage('assistant', response.content);
      recordEvent('output', response.content.slice(0, 5000));
      ctx.setStreamingResponse('');
      ctx.setContextTokens(ctx.estimateContextTokens());
      checkAndWarnContextLimit(ctx.actualProvider as LLMProvider, ctx.actualModel, ctx.estimateContextTokens(), ctx.addMessage);
      setMood('success');

      // Auto-continue if response was truncated due to length
      if (response.finishReason === 'length') {
        ctx.addMessage('system', '(auto-continuing...)');
        ctx.llmMessages.current.push({ role: 'user', content: 'Please continue where you left off.' });
        continue; // Loop again to get continuation
      }
      completedNaturally = true;

      // End iteration ledger entry
      ctx.ledger?.endIteration('success');

      // Auto-save full message history for session persistence
      storage.saveMessageHistory(ctx.llmMessages.current);

      break;

    } catch (error) {
      ctx.setThinkingState(null);
      ctx.setActivityState(null);
      ctx.setStreamingResponse('');

      // End iteration ledger entry with error
      ctx.ledger?.endIteration('error');

      // Format error with provider context for better suggestions
      setMood('error');
      const errorMsg = formatError(error, { provider: ctx.actualProvider });
      ctx.addMessage('error', errorMsg);

      // Classify error to provide additional recovery suggestions
      const classified = classifyError(error);
      const availableProviders = getAvailableProviders();
      const otherProviders = availableProviders.filter(p => p !== ctx.actualProvider);

      // Feed error to circuit breaker
      if (ctx.circuitBreaker) {
        const errorIterData: IterationData = {
          iteration: i + 1,
          error: errorMsg,
          timestamp: new Date(),
        };
        const breakerResult = ctx.circuitBreaker.check(errorIterData);
        ctx.setBreakerHealth?.(ctx.circuitBreaker.getHealth());
        if (breakerResult.tripped) {
          ctx.addMessage('system', `\u26a0\ufe0f Circuit breaker tripped: ${breakerResult.breaker}\n${breakerResult.message}\n\nUse /breaker resume to continue.`);
          completedNaturally = true;
          break;
        }
      }

      // Retryable errors continue the loop (circuit breaker handles safety)
      const isRetryable = classified.category === 'rate_limit' || classified.category === 'server' || classified.category === 'timeout' || classified.category === 'network';

      // Suggest alternatives based on error type
      if (classified.category === 'rate_limit' || classified.category === 'server') {
        if (otherProviders.length > 0) {
          ctx.addMessage('system', `\u{1f4a1} Try switching providers: /provider ${otherProviders[0]} or /models to see alternatives`);
        }
      } else if (classified.category === 'timeout' || classified.category === 'network') {
        ctx.addMessage('system', `\u{1f4a1} Network issue detected. Check connection and try again, or use /provider to switch.`);
      } else if (classified.category === 'auth') {
        ctx.addMessage('system', `\u{1f4a1} Run 'calliope --setup' to reconfigure API keys.`);
      }

      if (isRetryable && ctx.circuitBreaker) {
        // Retryable errors: continue the loop, circuit breaker will catch repeated failures
        ctx.addMessage('system', `Retrying... (circuit breaker will pause after ${ctx.circuitBreaker.getConfig().breakers['repeated-failure'].maxConsecutiveErrors} consecutive failures)`);
        await new Promise(r => setTimeout(r, 2000)); // Brief delay before retry
        continue;
      }

      // Non-retryable errors (auth, etc.) still kill the session
      completedNaturally = true;

      // On error, clear queued messages to prevent infinite retry loop
      const currentQueuedOnError = ctx.queuedMessagesRef.current;
      if (currentQueuedOnError.length > 0) {
        ctx.addMessage('system', `\u26a0\ufe0f Cleared ${currentQueuedOnError.length} queued message(s) due to error. Use /clear to reset conversation.`);
        ctx.setQueuedMessages([]);
      }
      return; // Exit early on error - don't process queued messages
    }
  }

  // Only show warning if we actually hit the iteration limit (not errors or natural completion)
  if (!completedNaturally) {
    ctx.addMessage('system', `⚠️ Reached ${maxIterations} iterations limit. Task may be incomplete. Adjust with /set maxIterations <number>.`);
  }

  // Update context tokens after agent run
  ctx.setContextTokens(ctx.estimateContextTokens());

  // Process any queued messages (human-in-the-loop feedback)
  // CRITICAL: Use ref to get current value, not stale closure
  const currentQueued = ctx.queuedMessagesRef.current;
  ctx.debugLog('runAgent', 'EXIT loop', `queued=${currentQueued.length}`);
  if (currentQueued.length > 0) {
    const queued = [...currentQueued];
    ctx.setQueuedMessages([]); // Clear the queue
    ctx.queuedMessagesRef.current = []; // Also clear ref immediately

    // Combine queued messages into a single follow-up
    const followUp = queued.length === 1
      ? queued[0]
      : `[Multiple follow-up messages from user:]\n${queued.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;

    ctx.addMessage('system', `📨 Processing ${queued.length} queued message${queued.length > 1 ? 's' : ''}...`);

    // Recursively run agent with follow-up
    // Use setTimeout to avoid stack overflow and allow UI to update
    // Note: handleSubmit's finally will set isProcessing=false, so we need to re-enable it
    ctx.debugLog('runAgent', 'SCHEDULING recursive call for queued messages');
    setTimeout(() => {
      ctx.debugLog('runAgent', 'RECURSIVE call starting');
      ctx.setIsProcessing(true);
      runAgentImpl(ctx, followUp).finally(() => {
        ctx.setIsProcessing(false);
        ctx.setThinkingState(null);
        ctx.setActivityState(null);
        ctx.setStreamingResponse('');
        ctx.setEditingQueueIndex(null);
      });
    }, 100);
  }
  ctx.debugLog('runAgent', 'RETURN');
}

// ============================================================================
// Run Loop
// ============================================================================

/**
 * Start caffeinate to prevent system sleep during long operations (macOS).
 */
function startCaffeinate(): ChildProcess | null {
  if (process.platform !== 'darwin') return null;
  try {
    const proc = spawn('caffeinate', ['-di'], { stdio: 'ignore', detached: true });
    proc.unref();
    return proc;
  } catch {
    return null;
  }
}

function stopCaffeinate(proc: ChildProcess | null): void {
  if (proc) {
    try { proc.kill('SIGTERM'); } catch { /* already dead */ }
  }
}

/**
 * Agent loop - runs prompt repeatedly until completion promise or max iterations.
 */
export async function runLoopImpl(ctx: AgentContext, prompt: string, maxIter: number, completionPromise?: string): Promise<void> {
  ctx.setIsProcessing(true);
  setMood('focused');

  // Prevent system sleep during long agent loops (macOS)
  const caffeinateProc = startCaffeinate();

  for (let i = 0; i < maxIter; i++) {
    // Check if cancelled
    if (ctx.loopCancelledRef.current) {
      ctx.addMessage('system', '🛑 Loop cancelled by user');
      break;
    }

    ctx.setLoopIteration(i + 1);
    ctx.addMessage('system', `🔄 Loop iteration ${i + 1}/${maxIter}`);

    // First iteration: send original prompt. Subsequent: send continuation.
    const iterationPrompt = i === 0
      ? prompt
      : `Continue working on the task: "${prompt}"\n\nThis is iteration ${i + 1}. Review what you've done so far and continue making progress.`;
    ctx.llmMessages.current.push({ role: 'user', content: iterationPrompt });

    try {
      // Run the agent
      await runAgentImpl(ctx, iterationPrompt);

      // Check for completion promise in the last assistant message
      if (completionPromise) {
        const lastMessage = ctx.llmMessages.current[ctx.llmMessages.current.length - 1];
        if (lastMessage?.role === 'assistant') {
          const content = typeof lastMessage.content === 'string'
            ? lastMessage.content
            : JSON.stringify(lastMessage.content);
          if (content.includes(completionPromise)) {
            ctx.addMessage('system', `🎉 Completion promise "${completionPromise}" detected! Loop finished.`);
            break;
          }
        }
      }

      // Check cancelled again after agent run
      if (ctx.loopCancelledRef.current) {
        ctx.addMessage('system', '🛑 Loop cancelled by user');
        break;
      }

      // Small delay between iterations
      await new Promise(r => setTimeout(r, 500));

    } catch (error) {
      ctx.addMessage('error', `Loop error: ${error instanceof Error ? error.message : String(error)}`);
      break;
    }
  }

  // If we completed all iterations without hitting completion promise
  if (!ctx.loopCancelledRef.current && !completionPromise) {
    ctx.addMessage('system', `✅ Loop completed ${maxIter} iterations`);
  }

  ctx.setLoopActive(false);
  ctx.setIsProcessing(false);
  stopCaffeinate(caffeinateProc);
}
