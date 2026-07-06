/**
 * Calliope CLI - Headless Renderer
 *
 * Minimal, no-TTY renderer for agent orchestration.
 * Outputs structured JSON or plain text with no ANSI, no decorations.
 * Designed for piping, CI, scripting, and multi-agent fleet coordination.
 */

import * as config from './config.js';
import { chat, selectProvider, ProviderUnavailableError } from './providers/index.js';
import { TOOLS, executeTool, getTools } from './tools.js';
import { DEFAULT_MODELS, calculateCost } from './types.js';
import { getSystemPromptForProvider, isLocalBackend } from './local-model.js';
import * as memory from './memory.js';
import { resolveIterationLimit } from './iteration-limit.js';
import { RunLog } from './runlog.js';
import {
  getBudgetCaps, evaluateBudget, hasBudgetCaps,
  recordProjectSpend, loadProjectSpend, formatBudgetHalt,
} from './budget.js';
import { evaluatePolicy, isPolicyEnabled } from './policy.js';
import type { Message, LLMProvider, ToolCall } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface HeadlessEvent {
  type: 'message' | 'tool_call' | 'tool_result' | 'error' | 'status' | 'done';
  timestamp: string;
  data: Record<string, unknown>;
}

export type HeadlessOutputMode = 'json' | 'text';

export interface HeadlessOptions {
  provider?: LLMProvider;
  model?: string;
  prompt?: string;
  outputMode?: HeadlessOutputMode;
  maxIterations?: number;
  maxRetries?: number;
  cwd?: string;
}

// ============================================================================
// Output
// ============================================================================

function emit(event: HeadlessEvent, mode: HeadlessOutputMode): void {
  if (mode === 'json') {
    process.stdout.write(JSON.stringify(event) + '\n');
  } else {
    // Plain text mode
    switch (event.type) {
      case 'message':
        process.stdout.write(String(event.data.content || '') + '\n');
        break;
      case 'tool_call':
        process.stdout.write(`[tool:${event.data.name}] ${JSON.stringify(event.data.arguments)}\n`);
        break;
      case 'tool_result':
        process.stdout.write(String(event.data.result || '') + '\n');
        break;
      case 'error':
        process.stderr.write(`ERROR: ${event.data.message}\n`);
        break;
      case 'status':
        process.stderr.write(`STATUS: ${event.data.message}\n`);
        break;
      case 'done':
        // Silence
        break;
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

// ============================================================================
// Retry policy
// ============================================================================

/**
 * Tools that mutate state / have side effects. Re-running these on an error
 * risks compounding partial side effects (duplicate writes, repeated commands),
 * so they are never blindly retried.
 */
const MUTATING_TOOLS = new Set(['shell', 'write_file', 'edit_file', 'git', 'execute_code', 'configure']);

/**
 * Classify an error message as plausibly transient (worth retrying) vs.
 * deterministic (validation / auth / invalid-request — retrying cannot help).
 */
function isTransientError(message: string): boolean {
  const m = message.toLowerCase();

  // Deterministic failures: never retry.
  const nonTransient = [
    'must be a string', 'must be a', 'is required', 'invalid', 'not found',
    'no such file', 'permission denied', 'unauthorized', 'forbidden',
    '401', '403', '404', '400', 'bad request', 'validation',
  ];
  if (nonTransient.some(p => m.includes(p))) return false;

  // Plausibly transient: network / timeout / rate-limit / transient server errors.
  const transient = [
    'timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused',
    'enotfound', 'eai_again', 'network', 'socket hang up', 'rate limit',
    'rate-limit', 'too many requests', '429', '503', '502', '500',
    'temporarily', 'try again',
  ];
  return transient.some(p => m.includes(p));
}

/** Exponential backoff with a cap, in milliseconds. */
function backoffDelay(attempt: number): number {
  return Math.min(250 * 2 ** (attempt - 1), 4000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Decide whether a failed tool result should be retried.
 * - Mutating tools are never retried (avoid duplicated side effects).
 * - Only errors classified as transient are retried.
 */
function shouldRetry(toolName: string, errorText: string): boolean {
  if (MUTATING_TOOLS.has(toolName)) return false;
  return isTransientError(errorText);
}

// ============================================================================
// Headless Runner
// ============================================================================

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const outputMode = options.outputMode || 'json';
  const provider = options.provider || (process.env.CALLIOPE_PROVIDER as LLMProvider) || config.get('defaultProvider');
  const model = options.model || process.env.CALLIOPE_MODEL || config.get('defaultModel');
  const maxIterations = resolveIterationLimit(options.maxIterations ?? config.get('maxIterations'));
  const maxRetries = options.maxRetries ?? 3;
  const cwd = options.cwd || process.cwd();

  // Build prompt from stdin or --prompt flag
  let prompt = options.prompt || '';

  if (!prompt && !process.stdin.isTTY) {
    // Read from stdin
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    prompt = Buffer.concat(chunks).toString('utf-8').trim();
  }

  if (!prompt) {
    emit({
      type: 'error',
      timestamp: now(),
      data: { message: 'No prompt provided. Use --prompt or pipe to stdin.' },
    }, outputMode);
    return 1;
  }

  // Resolve the provider so 'auto' picks up a local backend correctly, then
  // select the compact-vs-full system prompt for it (feature 5).
  //
  // An explicitly-requested-but-unconfigured provider is a hard, actionable
  // failure: print the fix to stderr and exit 2 rather than silently switching
  // providers (#217). 'auto'-with-no-keys throws a plain Error instead — keep
  // the old lenient fallback so chat() below surfaces that as a normal error.
  let resolvedProvider: LLMProvider;
  try {
    resolvedProvider = selectProvider(provider);
  } catch (err) {
    if (err instanceof ProviderUnavailableError) {
      emit({ type: 'error', timestamp: now(), data: { message: err.message } }, outputMode);
      return 2;
    }
    resolvedProvider = provider;
  }
  const localBackend = isLocalBackend(resolvedProvider);

  // Build messages
  const systemPrompt = getSystemPromptForProvider(resolvedProvider);
  const memoryContext = memory.buildMemoryContext(cwd);
  const fullPrompt = memoryContext.trim()
    ? systemPrompt + '\n\n--- Project Context ---\n' + memoryContext
    : systemPrompt;

  const messages: Message[] = [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: prompt },
  ];


  emit({
    type: 'status',
    timestamp: now(),
    data: {
      message: 'Starting headless session',
      provider: resolvedProvider,
      model: model || DEFAULT_MODELS[resolvedProvider],
    },
  }, outputMode);

  // ---- Governance (#189): audit run log, budget caps, policy hook ----------
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const runlog = RunLog.open(sessionId);
  const costModel = model || DEFAULT_MODELS[resolvedProvider];
  const budgetCaps = getBudgetCaps();
  // Only maintain the cross-run project ledger when a project cap is active.
  const trackProjectBudget = typeof budgetCaps.maxCostPerProject === 'number';
  const runStartedAt = Date.now();
  let runInputTokens = 0;
  let runOutputTokens = 0;
  let runCostUsd = 0;
  let runToolCalls = 0;
  // Provider warnings (e.g. Ollama model substitution) surface as status events,
  // deduped so a repeated substitution across iterations isn't emitted twice.
  const seenWarnings = new Set<string>();

  runlog.runStart({
    session: sessionId,
    cwd,
    provider: resolvedProvider,
    model: costModel,
    config: config.getConfig() as unknown as Record<string, unknown>,
  });
  runlog.userPrompt(prompt);
  if (runlog.enabled) {
    emit({ type: 'status', timestamp: now(), data: { message: `Run log: ${runlog.filePath}` } }, outputMode);
  }

  const runTotals = () => ({
    inputTokens: runInputTokens,
    outputTokens: runOutputTokens,
    cost: runCostUsd,
    toolCalls: runToolCalls,
    durationMs: Date.now() - runStartedAt,
  });

  try {
    let iteration = 0;
    let budgetVerdict: ReturnType<typeof evaluateBudget> | undefined;

    // Up-front project-budget guard: refuse to start a run whose project has
    // already spent its cap (the CI hard stop) before making any provider call.
    if (hasBudgetCaps(budgetCaps)) {
      const pre = evaluateBudget(budgetCaps, {
        runCostUsd: 0,
        runTokens: 0,
        projectCostUsd: loadProjectSpend(cwd).spentUsd,
      });
      if (pre.exceeded) budgetVerdict = pre;
    }

    while (!budgetVerdict && iteration < maxIterations) {
      iteration++;

      const response = await chat(provider, messages, TOOLS, model);

      // Surface provider warnings (model substitution, etc.) without hiding them.
      if (response.warnings) {
        for (const warning of response.warnings) {
          if (seenWarnings.has(warning)) continue;
          seenWarnings.add(warning);
          emit({ type: 'status', timestamp: now(), data: { message: warning } }, outputMode);
        }
      }

      // Accumulate spend, persist it to the project ledger, and audit it.
      if (response.usage) {
        const usageCost = calculateCost(costModel, response.usage.inputTokens, response.usage.outputTokens);
        runInputTokens += response.usage.inputTokens;
        runOutputTokens += response.usage.outputTokens;
        runCostUsd += usageCost;
        if (trackProjectBudget) recordProjectSpend(cwd, usageCost);
        runlog.assistantMessage({
          content: response.content,
          tokens: { input: response.usage.inputTokens, output: response.usage.outputTokens },
          cost: usageCost,
        });
      } else {
        runlog.assistantMessage({ content: response.content, tokens: { input: 0, output: 0 }, cost: 0 });
      }

      // Budget check: finish the current turn cleanly if a cap is now exceeded.
      if (hasBudgetCaps(budgetCaps)) {
        const verdict = evaluateBudget(budgetCaps, {
          runCostUsd,
          runTokens: runInputTokens + runOutputTokens,
          projectCostUsd: loadProjectSpend(cwd).spentUsd,
        });
        if (verdict.exceeded) {
          budgetVerdict = verdict;
          break;
        }
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          emit({
            type: 'tool_call',
            timestamp: now(),
            data: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          }, outputMode);
          runlog.toolCall({ id: toolCall.id, name: toolCall.name, args: toolCall.arguments as Record<string, unknown> });
          runToolCalls++;

          // Pre-tool policy gate (fail closed). A deny short-circuits execution;
          // the agent sees the denial as the tool result and can adapt.
          if (isPolicyEnabled()) {
            const verdict = await evaluatePolicy(toolCall);
            runlog.policyEvent({
              tool: toolCall.name,
              decision: verdict.decision,
              source: verdict.source,
              reason: verdict.reason,
              durationMs: verdict.durationMs,
            });
            if (verdict.decision === 'deny') {
              const denyText = `[Policy denied: ${verdict.reason || 'no reason given'}]`;
              runlog.toolResult({ id: toolCall.id, result: denyText, isError: true, durationMs: verdict.durationMs });
              emit({
                type: 'tool_result',
                timestamp: now(),
                data: { toolCallId: toolCall.id, name: toolCall.name, result: denyText, isError: true },
              }, outputMode);
              messages.push({ role: 'tool', content: denyText, toolCallId: toolCall.id });
              continue;
            }
          }

          // Execute tool with a guarded retry budget.
          // Only retry classified-transient errors, never re-run mutating tools
          // (avoids duplicated side effects), and back off between attempts.
          const toolStart = Date.now();
          let result = await executeTool(toolCall, cwd, 60000, undefined, { appendAnchorHash: localBackend });
          let attempt = 0;
          while (
            result.isError &&
            attempt < maxRetries &&
            shouldRetry(toolCall.name, result.result)
          ) {
            attempt++;
            await sleep(backoffDelay(attempt));
            process.stderr.write(`[retry ${attempt}/${maxRetries}] tool failed: ${result.result}\n`);
            result = await executeTool(toolCall, cwd, 60000, undefined, { appendAnchorHash: localBackend });
          }


          emit({
            type: 'tool_result',
            timestamp: now(),
            data: {
              toolCallId: toolCall.id,
              name: toolCall.name,
              result: result.result,
              isError: result.isError || false,
            },
          }, outputMode);
          runlog.toolResult({
            id: toolCall.id,
            result: result.result,
            isError: result.isError || false,
            durationMs: Date.now() - toolStart,
          });

          messages.push({
            role: 'tool',
            content: result.result,
            toolCallId: toolCall.id,
          });
        }

        continue;
      }

      // Final response
      messages.push({
        role: 'assistant',
        content: response.content,
      });

      emit({
        type: 'message',
        timestamp: now(),
        data: {
          role: 'assistant',
          content: response.content,
        },
      }, outputMode);

      break;
    }

    // Budget halt: emit the event, summarize spend vs cap, exit code 3.
    if (budgetVerdict?.exceeded) {
      const summary = formatBudgetHalt(budgetVerdict);
      runlog.budgetEvent({
        scope: budgetVerdict.scope ?? 'run',
        kind: budgetVerdict.kind ?? 'cost',
        spent: budgetVerdict.spent ?? 0,
        cap: budgetVerdict.cap ?? 0,
        message: budgetVerdict.message ?? summary,
      });
      emit({ type: 'status', timestamp: now(), data: { message: summary } }, outputMode);
      process.stderr.write(summary + '\n');
      runlog.runEnd({ totals: runTotals(), exitReason: 'budget' });
      await runlog.flush();
      return 3;
    }

    emit({
      type: 'done',
      timestamp: now(),
      data: { iterations: iteration },
    }, outputMode);

    runlog.runEnd({ totals: runTotals(), exitReason: 'completed' });
    await runlog.flush();
    return 0;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    emit({
      type: 'error',
      timestamp: now(),
      data: { message: msg },
    }, outputMode);
    runlog.runEnd({ totals: runTotals(), exitReason: 'error' });
    await runlog.flush();
    return 1;
  }
}
