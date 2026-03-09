/**
 * Calliope CLI - Headless Renderer
 *
 * Minimal, no-TTY renderer for agent orchestration.
 * Outputs structured JSON or plain text with no ANSI, no decorations.
 * Designed for piping, CI, scripting, and multi-agent fleet coordination.
 */

import * as config from './config.js';
import { chat, selectProvider } from './providers/index.js';
import { TOOLS, executeTool, getTools } from './tools.js';
import { getSystemPrompt, DEFAULT_MODELS } from './types.js';
import * as memory from './memory.js';
import * as recording from './terminal-recording.js';
import type { Message, LLMProvider, AgentPersona, ToolCall } from './types.js';

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
  persona?: AgentPersona;
  prompt?: string;
  outputMode?: HeadlessOutputMode;
  maxIterations?: number;
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
// Headless Runner
// ============================================================================

export async function runHeadless(options: HeadlessOptions): Promise<number> {
  const outputMode = options.outputMode || 'json';
  const provider = options.provider || (process.env.CALLIOPE_PROVIDER as LLMProvider) || config.get('defaultProvider');
  const model = options.model || process.env.CALLIOPE_MODEL || config.get('defaultModel');
  const persona: AgentPersona = options.persona || config.get('persona');
  const maxIterations = options.maxIterations || config.get('maxIterations');
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

  // Build messages
  const systemPrompt = getSystemPrompt(persona);
  const memoryContext = memory.buildMemoryContext(cwd);
  const fullPrompt = memoryContext.trim()
    ? systemPrompt + '\n\n--- Project Context ---\n' + memoryContext
    : systemPrompt;

  const messages: Message[] = [
    { role: 'system', content: fullPrompt },
    { role: 'user', content: prompt },
  ];

  // Start session recording — respects config
  recording.setRecordingEnabled(config.get('recordSessions') !== false);
  recording.setRetentionDays(config.get('recordingRetentionDays') || 30);
  recording.startRecording({
    provider: selectProvider(provider),
    model: model || DEFAULT_MODELS[selectProvider(provider)],
    cwd,
  });
  recording.recordEvent('input', prompt);

  emit({
    type: 'status',
    timestamp: now(),
    data: {
      message: 'Starting headless session',
      provider: selectProvider(provider),
      model: model || DEFAULT_MODELS[selectProvider(provider)],
    },
  }, outputMode);

  try {
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      const response = await chat(provider, messages, TOOLS, model);

      if (response.toolCalls && response.toolCalls.length > 0) {
        // Add assistant message with tool calls
        messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        for (const toolCall of response.toolCalls) {
          recording.recordEvent('tool_call', toolCall.name, { name: toolCall.name, arguments: toolCall.arguments });
          emit({
            type: 'tool_call',
            timestamp: now(),
            data: {
              id: toolCall.id,
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          }, outputMode);

          const result = await executeTool(toolCall, cwd);
          recording.recordEvent('tool_result', result.result.slice(0, 1000), { name: toolCall.name, isError: result.isError });

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

      recording.recordEvent('output', response.content.slice(0, 5000));
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

    recording.stopRecording();
    emit({
      type: 'done',
      timestamp: now(),
      data: { iterations: iteration },
    }, outputMode);

    return 0;
  } catch (error) {
    recording.stopRecording();
    const msg = error instanceof Error ? error.message : String(error);
    emit({
      type: 'error',
      timestamp: now(),
      data: { message: msg },
    }, outputMode);
    return 1;
  }
}
