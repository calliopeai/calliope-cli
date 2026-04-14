/**
 * CLI Agent Loop & Display
 *
 * Agent execution, autonomous loop, and tool output formatting.
 */

import * as readline from 'readline';
import * as config from '../config.js';
import { chat } from '../providers/index.js';
import { TOOLS, executeTool } from '../tools.js';
import { assessToolRisk, requiresConfirmation, formatRiskBar } from '../risk.js';
import * as hooks from '../hooks.js';
import type { ToolCall } from '../types.js';
import * as storage from '../storage.js';
import { colors as c, color } from '../styles.js';
import { scuttlebotClient } from '../scuttlebot/index.js';
import { getSpinnerFrames, getBoxChars } from '../hud/api.js';
import { getToolLabel, getThinkingPhrase } from '../companions.js';
import type { CLIState } from './types.js';
import { debugLog } from './types.js';
import { recordEvent } from '../terminal-recording.js';
import { startPreventSleep, stopPreventSleep } from '../prevent-sleep.js';
import {
  resolveIterationLimit,
  formatIterationLimit,
  formatIterationProgress,
  isFiniteIterationLimit,
} from '../iteration-limit.js';

export async function runAgent(prompt: string, state: CLIState): Promise<string> {
  state.messages.push({ role: 'user', content: prompt });
  const runId = !state.loopActive
    ? state.ledger.startRun('agent', prompt, {
        maxIterations: isFiniteIterationLimit(resolveIterationLimit(config.get('maxIterations')))
          ? resolveIterationLimit(config.get('maxIterations'))
          : null,
      })
    : undefined;

  // Spinner setup
  const frames = getSpinnerFrames();
  const thinkText = getThinkingPhrase() || 'Thinking...';
  let spinnerIdx = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${color(frames[spinnerIdx], 'cyan')} ${color(thinkText, 'dim')}`);
    spinnerIdx = (spinnerIdx + 1) % frames.length;
  }, 80);

  const clearSpinner = () => {
    clearInterval(spinnerInterval);
    process.stdout.write('\r\x1b[K');
  };

  try {
    const maxIterations = resolveIterationLimit(config.get('maxIterations'));
    let iteration = 0;
    let finalResponse = '';
    let runStatus: 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'stopped' | undefined;
    let runErrorSummary: string | undefined;

    while (iteration < maxIterations) {
      iteration++;
      state.ledger.startIteration(state.ledger.getNextIterationNumber());

      const response = await chat(
        state.provider,
        state.messages,
        TOOLS,
        state.model
      );

      if (response.usage) {
        state.ledger.recordTokens(
          response.usage.inputTokens,
          response.usage.outputTokens,
          0
        );
      }

      if (response.toolCalls && response.toolCalls.length > 0) {
        clearSpinner();

        state.messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // Mirror any text the assistant produced alongside the tool calls
        // (the "thinking out loud" content before invoking tools)
        if (scuttlebotClient.isEnabled() && response.content) {
          scuttlebotClient.mirrorAssistant(response.content).catch(() => {});
        }

        for (const toolCall of response.toolCalls) {
          const preHookResult = await hooks.checkHooksAllow('pre-tool', {
            tool: toolCall.name,
            toolArgs: toolCall.arguments as Record<string, unknown>,
          });
          if (!preHookResult.allowed) {
            state.ledger.recordAction(
              toolCall.name,
              toolCall.arguments as Record<string, unknown>,
              'blocked',
              preHookResult.reason
            );
            console.log(`${color(getBoxChars().vertical, 'dim')}  ${color(`Blocked by hook: ${preHookResult.reason}`, 'red')}`);
            state.messages.push({
              role: 'tool',
              content: `[Blocked by hook: ${preHookResult.reason}]`,
              toolCallId: toolCall.id,
            });
            continue;
          }

          if (!state.skipPermissions) {
            const risk = assessToolRisk(toolCall);
            if (requiresConfirmation(risk, false)) {
              console.log(`${color(getBoxChars().vertical, 'dim')}  ${formatRiskBar(risk.level)} ${color(risk.reason, 'yellow')}`);
              const proceed = await new Promise<boolean>((resolve) => {
                process.stdout.write(`${color(getBoxChars().vertical, 'dim')}  ${color('Allow? (y/N) ', 'cyan')}`);
                const rl2 = readline.createInterface({ input: process.stdin, output: process.stdout });
                rl2.question('', (answer) => {
                  rl2.close();
                  resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
                });
              });
              if (!proceed) {
                state.ledger.recordAction(
                  toolCall.name,
                  toolCall.arguments as Record<string, unknown>,
                  'blocked',
                  'denied by user'
                );
                state.messages.push({
                  role: 'tool',
                  content: '[Tool execution denied by user]',
                  toolCallId: toolCall.id,
                });
                continue;
              }
            }
          }

          printToolCall(toolCall);
          recordEvent('tool_call', toolCall.name, { name: toolCall.name, arguments: toolCall.arguments as Record<string, unknown> });
          const isShell = toolCall.name === 'shell';
          const streamCallback = isShell ? (chunk: string) => {
            process.stdout.write(`${c.dim}${chunk}${c.reset}`);
          } : undefined;
          const result = await executeTool(toolCall, state.cwd, 60000, streamCallback);
          if (isShell) process.stdout.write('\n');
          recordEvent('tool_result', result.result.slice(0, 1000), { name: toolCall.name, isError: result.isError });
          printToolResult(toolCall.name, result.result);
          state.ledger.recordAction(
            toolCall.name,
            toolCall.arguments as Record<string, unknown>,
            result.isError ? 'error' : 'ok',
            result.isError ? result.result : undefined,
          );

          hooks.executeHooks('post-tool', {
            tool: toolCall.name,
            toolArgs: toolCall.arguments as Record<string, unknown>,
            toolResult: result.result,
          }).catch((err) => {
            debugLog(`post-tool hook failed for ${toolCall.name}:`, err instanceof Error ? err.message : err);
          });

          state.messages.push({
            role: 'tool',
            content: result.result,
            toolCallId: toolCall.id,
          });
        }

        state.ledger.endIteration();
        storage.saveMessageHistory(state.messages);

        continue;
      }

      // No tool calls - final response
      clearSpinner();

      state.messages.push({
        role: 'assistant',
        content: response.content,
      });

      // Mirror assistant message to scuttlebot
      if (scuttlebotClient.isEnabled()) {
        await scuttlebotClient.mirrorAssistant(response.content).catch(() => {
          // Silently fail
        });
      }

      finalResponse = response.content;
      runStatus = 'completed';
      recordEvent('output', response.content.slice(0, 5000));
      console.log();
      console.log(`${color('✧', 'cyan')} ${color('Calliope:', 'dim')}`);
      console.log();
      printOutput(response.content);
      console.log();

      state.ledger.endIteration('success');
      storage.saveMessageHistory(state.messages);
      break;
    }

    if (!finalResponse && !runStatus && isFiniteIterationLimit(resolveIterationLimit(config.get('maxIterations')))) {
      runStatus = 'stopped';
      runErrorSummary = `Reached ${resolveIterationLimit(config.get('maxIterations'))} iterations limit`;
    }

    if (runId) {
      state.ledger.finishRun(runId, runStatus || 'completed', { errorSummary: runErrorSummary });
    }

    return finalResponse;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    state.ledger.endIteration('error');
    if (runId) {
      state.ledger.finishRun(runId, 'failed', { errorSummary: msg });
    }
    storage.saveMessageHistory(state.messages);
    console.log();
    console.log(`${color('✗', 'red')} ${color(`Error: ${msg}`, 'red')}`);
    console.log();

    return '';
  } finally {
    clearInterval(spinnerInterval);
  }
}

export async function startLoop(args: string, state: CLIState): Promise<void> {
  if (state.loopActive) {
    console.log(color('Loop already active. Use /breakloop to stop it first.', 'yellow'));
    console.log();
    return;
  }

  const maxIterMatch = args.match(/--max-iterations\s+(\d+)/);
  const completionMatch = args.match(/--completion-promise\s+"([^"]+)"/);

  let prompt = args
    .replace(/--max-iterations\s+\d+/, '')
    .replace(/--completion-promise\s+"[^"]+"/, '')
    .trim();

  const quotedMatch = prompt.match(/^"([^"]+)"$/);
  if (quotedMatch) prompt = quotedMatch[1];

  if (!prompt) {
    console.log(color('Usage: /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]', 'red'));
    console.log();
    return;
  }

  const defaultMaxIterations = resolveIterationLimit(config.get('maxIterations'));

  state.loopActive = true;
  state.loopPrompt = prompt;
  state.loopIteration = 0;
  state.loopMaxIterations = maxIterMatch
    ? resolveIterationLimit(parseInt(maxIterMatch[1], 10))
    : defaultMaxIterations;
  state.loopCompletionPromise = completionMatch ? completionMatch[1] : undefined;

  // Prevent system sleep during long agent loops (macOS)
  startPreventSleep();

  let loopOutcome: 'running' | 'cancelled' | 'promise-met' = 'running';
  const loopRunId = state.ledger.startRun('loop', prompt, {
    completionPromise: state.loopCompletionPromise,
    maxIterations: isFiniteIterationLimit(state.loopMaxIterations) ? state.loopMaxIterations : null,
  });

  try {
    const box = getBoxChars();
    console.log();
    console.log(`${color(box.topLeft + box.horizontal, 'dim')} ${color('🔄 Agent Loop Started', 'bold')}`);
    console.log(`${color(box.vertical, 'dim')}  ${color('Max:', 'dim')} ${color(formatIterationLimit(state.loopMaxIterations), 'cyan')}`);
    if (state.loopCompletionPromise) {
      console.log(`${color(box.vertical, 'dim')}  ${color('Promise:', 'dim')} ${color(state.loopCompletionPromise, 'green')}`);
    }
    console.log(`${color(box.bottomLeft + box.horizontal, 'dim')} ${color('/breakloop to stop', 'dim')}`);
    console.log();

    while (state.loopActive && state.loopIteration < state.loopMaxIterations) {
      state.loopIteration++;

      const iterBox = getBoxChars();
      console.log(`${color(iterBox.topLeft + iterBox.horizontal, 'cyan')} ${color(`Iteration ${formatIterationProgress(state.loopIteration, state.loopMaxIterations)}`, 'bold')}`);

      // First iteration: use the original prompt
      // Subsequent iterations: use a continuation prompt that references prior context
      const iterationPrompt = state.loopIteration === 1
        ? state.loopPrompt
        : `Continue working on: ${state.loopPrompt}\n\nThis is iteration ${state.loopIteration}. Review your previous progress and continue from where you left off. Do not repeat completed work.`;

      const result = await runAgent(iterationPrompt, state);

      if (state.loopCompletionPromise && result.includes(state.loopCompletionPromise)) {
        console.log(`${color('🎉 Completion promise detected!', 'green')}`);
        loopOutcome = 'promise-met';
        state.loopActive = false;
        break;
      }

      if (!state.loopActive) {
        loopOutcome = 'cancelled';
        break;
      }

      if (state.loopIteration < state.loopMaxIterations) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (loopOutcome === 'running' && isFiniteIterationLimit(state.loopMaxIterations) && state.loopIteration >= state.loopMaxIterations) {
      if (state.loopCompletionPromise) {
        console.log(color(`⚠️ Completion promise "${state.loopCompletionPromise}" was not reached after ${state.loopIteration} iterations.`, 'yellow'));
      } else {
        console.log(`${color('⚠️ Max iterations reached', 'yellow')}`);
      }
    }
  } finally {
    state.ledger.finishRun(
      loopRunId,
      loopOutcome === 'cancelled'
        ? 'cancelled'
        : loopOutcome === 'promise-met'
          ? 'completed'
          : state.loopCompletionPromise
            ? 'stopped'
            : 'completed',
      {
        errorSummary: loopOutcome === 'cancelled'
          ? 'Stopped by user'
          : (loopOutcome === 'running' && state.loopCompletionPromise
            ? `Stopped after ${state.loopIteration} iterations without matching completion promise`
            : undefined),
      }
    );
    storage.saveMessageHistory(state.messages);
    state.loopActive = false;
    stopPreventSleep();
    console.log();
  }
}

function printToolCall(toolCall: ToolCall): void {
  const icons: Record<string, string> = {
    shell: '⚡',
    read_file: '📄',
    write_file: '✍️',
    list_files: '📁',
    think: '💭',
  };

  const box = getBoxChars();
  const toolLabel = getToolLabel(toolCall.name);
  const displayName = toolLabel || toolCall.name;

  console.log();
  console.log(`${color(box.topLeft + box.horizontal, 'dim')} ${icons[toolCall.name] || '⚙️'} ${color(displayName, 'yellow')}`);

  if (toolCall.name === 'shell' && toolCall.arguments.command) {
    console.log(`${color(box.vertical, 'dim')}  ${color('$', 'green')} ${toolCall.arguments.command}`);
  } else if (toolCall.name === 'think' && toolCall.arguments.thought) {
    const thought = String(toolCall.arguments.thought);
    const preview = thought.length > 80 ? thought.substring(0, 80) + '...' : thought;
    console.log(`${color(box.vertical, 'dim')}  ${color(preview, 'dim')}`);
  }
}

function printToolResult(name: string, result: string): void {
  const box = getBoxChars();
  if (name === 'think') {
    console.log(`${color(box.bottomLeft + box.horizontal, 'dim')} ${color('✓', 'green')}`);
    return;
  }

  const lines = result.split('\n').slice(0, 10);
  for (const line of lines) {
    console.log(`${color(box.vertical, 'dim')}  ${color(line.substring(0, 100), 'dim')}`);
  }
  if (result.split('\n').length > 10) {
    console.log(`${color(box.vertical, 'dim')}  ${color(`... (${result.split('\n').length - 10} more lines)`, 'dim')}`);
  }

  const success = !result.toLowerCase().includes('error');
  console.log(`${color(box.bottomLeft + box.horizontal, 'dim')} ${success ? color('✓', 'green') : color('✗', 'red')}`);
}

function printOutput(text: string): void {
  const box = getBoxChars();
  const lines = text.split('\n');
  for (const line of lines) {
    console.log(`${color(box.vertical, 'blue')} ${line}`);
  }
}
