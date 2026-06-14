/**
 * Calliope Agents — SDK Backend
 *
 * In-process agent executors using Claude Agent SDK, OpenAI Agents JS, and Google ADK.
 * All are optional dependencies — gracefully degrade to CLI backend if absent.
 *
 * Supports all providers: Anthropic, OpenAI, Google, Bedrock, Vertex, Azure,
 * Ollama, OpenRouter, Together, Groq, Fireworks, Mistral, and more.
 */

import type { AgentEvent, SubAgentTask } from './types.js';
import * as config from '../config.js';

// ============================================================================
// SDK availability detection
// ============================================================================

let claudeSdkAvailable: boolean | null = null;
let openaiSdkAvailable: boolean | null = null;
let googleAdkAvailable: boolean | null = null;

/**
 * Check if Claude Agent SDK is installed
 */
export async function isClaudeSdkAvailable(): Promise<boolean> {
  if (claudeSdkAvailable !== null) return claudeSdkAvailable;
  try {
    await import('@anthropic-ai/claude-agent-sdk');
    claudeSdkAvailable = true;
  } catch {
    claudeSdkAvailable = false;
  }
  return claudeSdkAvailable;
}

/**
 * Check if OpenAI Agents JS is installed
 */
export async function isOpenaiSdkAvailable(): Promise<boolean> {
  if (openaiSdkAvailable !== null) return openaiSdkAvailable;
  try {
    await import('@openai/agents');
    openaiSdkAvailable = true;
  } catch {
    openaiSdkAvailable = false;
  }
  return openaiSdkAvailable;
}

/**
 * Check if Google ADK is installed
 */
export async function isGoogleAdkAvailable(): Promise<boolean> {
  if (googleAdkAvailable !== null) return googleAdkAvailable;
  try {
    await import('@google/adk');
    googleAdkAvailable = true;
  } catch {
    googleAdkAvailable = false;
  }
  return googleAdkAvailable;
}

/**
 * Get available SDK executors
 */
export async function getAvailableExecutors(): Promise<string[]> {
  const executors: string[] = ['cli']; // CLI always available
  if (await isClaudeSdkAvailable()) executors.push('claude-sdk');
  if (await isOpenaiSdkAvailable()) executors.push('openai-sdk');
  if (await isGoogleAdkAvailable()) executors.push('google-adk');
  return executors;
}

// ============================================================================
// Provider configuration mapping
// ============================================================================

/**
 * Get API key for the task's provider (from env or config)
 */
function getTaskApiKey(task: SubAgentTask): string | undefined {
  const provider = task.provider || config.get('defaultProvider');
  return config.getApiKey(provider as config.LLMProvider);
}

/**
 * Get base URL for the task's provider (for Ollama, LiteLLM, Bedrock, etc.)
 */
function getTaskBaseUrl(task: SubAgentTask): string | undefined {
  const provider = task.provider || config.get('defaultProvider');
  return config.getBaseUrl(provider as config.LLMProvider);
}

/**
 * Map calliope provider name to OpenAI-compatible base URL
 * OpenAI Agents JS can use any OpenAI-compatible API via baseURL
 */
function getOpenAICompatBaseUrl(provider: string): string | undefined {
  const urlMap: Record<string, string | undefined> = {
    openai: undefined, // default
    anthropic: undefined, // uses native SDK path
    ollama: (process.env.OLLAMA_BASE_URL || config.getBaseUrl('ollama') || 'http://localhost:11434') + '/v1',
    openrouter: 'https://openrouter.ai/api/v1',
    together: 'https://api.together.xyz/v1',
    groq: 'https://api.groq.com/openai/v1',
    fireworks: 'https://api.fireworks.ai/inference/v1',
    mistral: 'https://api.mistral.ai/v1',
    litellm: (process.env.LITELLM_BASE_URL || config.getBaseUrl('litellm') || 'http://localhost:4000') + '/v1',
    bedrock: config.getBaseUrl('bedrock'),
  };
  return urlMap[provider];
}

/**
 * Restore environment variables from a snapshot
 */
function restoreEnv(prevEnv: Record<string, string | undefined>): void {
  for (const [key, val] of Object.entries(prevEnv)) {
    if (val === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = val;
    }
  }
}

// ============================================================================
// Claude Agent SDK executor
// ============================================================================

/**
 * Execute a task using Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
 *
 * Supports:
 * - Native Anthropic API keys
 * - AWS Bedrock via ANTHROPIC_BEDROCK_BASE_URL
 * - Google Vertex via ANTHROPIC_VERTEX_PROJECT_ID
 * - Any provider that speaks the Anthropic API format
 */
export async function* executeClaudeSdk(
  task: SubAgentTask,
  cwd: string,
  timeout: number = 15 * 60 * 1000
): AsyncIterable<AgentEvent> {
  yield {
    type: 'start',
    taskId: task.id,
    timestamp: new Date(),
    message: `Starting Claude SDK executor (model: ${task.model || 'default'})`,
  };

  // Track env vars to restore (must be outside try for finally access)
  const prevEnv: Record<string, string | undefined> = {};

  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { query } = sdk;

    const apiKey = getTaskApiKey(task);
    if (!apiKey) {
      throw new Error('No API key available for Claude SDK executor');
    }

    // Set up env for the SDK
    const provider = task.provider || config.get('defaultProvider');

    // The Claude SDK uses ANTHROPIC_API_KEY
    if (provider === 'anthropic' || !provider || provider === 'auto') {
      prevEnv['ANTHROPIC_API_KEY'] = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = apiKey;
    } else if (provider === 'bedrock') {
      // Bedrock support via Claude SDK
      const baseUrl = getTaskBaseUrl(task);
      if (baseUrl) {
        prevEnv['ANTHROPIC_BEDROCK_BASE_URL'] = process.env.ANTHROPIC_BEDROCK_BASE_URL;
        process.env.ANTHROPIC_BEDROCK_BASE_URL = baseUrl;
      }
    }

    // Build query options
    const queryOptions: Record<string, unknown> = {
      prompt: task.prompt,
      options: {
        model: task.model || 'claude-sonnet-4-6',
        permissionMode: 'bypassPermissions',
        maxTurns: 50,
        cwd,
        ...(task.systemPrompt && { systemPrompt: task.systemPrompt }),
      },
    };

    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Task timed out after ${timeout}ms`)), timeout);
    });

    // Run the query
    let fullOutput = '';

    // The SDK's query() returns an async generator of messages
    const queryGen = query(queryOptions as unknown as Parameters<typeof query>[0]);

    // Race between query execution and timeout
    const processQuery = async () => {
      for await (const message of queryGen) {
        const msgAny = message as Record<string, unknown>;
        // Extract text content from SDK messages
        if (msgAny.type === 'text' || msgAny.type === 'assistant') {
          const content = String(msgAny.content || msgAny.text || '');
          if (content) {
            fullOutput += content;
          }
        } else if (msgAny.type === 'result') {
          const content = String(msgAny.content || msgAny.text || msgAny.result || '');
          if (content) {
            fullOutput += content;
          }
        }
      }
    };

    await Promise.race([processQuery(), timeoutPromise]);

    // Emit result
    if (fullOutput) {
      yield {
        type: 'text',
        taskId: task.id,
        timestamp: new Date(),
        content: fullOutput,
      };
    }

    yield {
      type: 'complete',
      taskId: task.id,
      timestamp: new Date(),
    };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    yield {
      type: 'error',
      taskId: task.id,
      timestamp: new Date(),
      code: 'SDK_ERROR',
      message: `Claude SDK error: ${msg}`,
    };
  } finally {
    // Always restore env vars, even on timeout/error
    restoreEnv(prevEnv);
  }
}

// ============================================================================
// OpenAI Agents JS executor
// ============================================================================

/**
 * Execute a task using OpenAI Agents JS (@openai/agents)
 *
 * Supports any OpenAI-compatible API via baseURL:
 * - Native OpenAI
 * - Azure OpenAI (via base URL)
 * - Ollama (via /v1 endpoint)
 * - OpenRouter, Together, Groq, Fireworks, Mistral
 * - LiteLLM proxy
 * - Any OpenAI-compatible API
 */
export async function* executeOpenaiSdk(
  task: SubAgentTask,
  cwd: string,
  timeout: number = 15 * 60 * 1000
): AsyncIterable<AgentEvent> {
  yield {
    type: 'start',
    taskId: task.id,
    timestamp: new Date(),
    message: `Starting OpenAI Agents executor (model: ${task.model || 'default'})`,
  };

  try {
    const agentsSdk = await import('@openai/agents');
    const { Agent, run } = agentsSdk;

    const provider = task.provider || config.get('defaultProvider') || 'openai';
    const apiKey = getTaskApiKey(task);
    const baseUrl = getOpenAICompatBaseUrl(provider as string);

    // For providers that need API keys, validate
    if (!apiKey && provider !== 'ollama') {
      throw new Error(`No API key available for provider '${provider}'`);
    }

    // Create agent with model configuration
    const agentConfig: Record<string, unknown> = {
      name: `calliope-subagent-${task.id.slice(0, 8)}`,
      instructions: task.systemPrompt || `You are a sub-agent executing a delegated task. Complete the task thoroughly and return your findings. Working directory: ${cwd}`,
      model: task.model || 'gpt-4o',
    };

    // Configure model provider if not default OpenAI
    if (baseUrl || (apiKey && provider !== 'openai')) {
      agentConfig.modelSettings = {
        ...(baseUrl && { baseUrl }),
        ...(apiKey && { apiKey }),
      };
    }

    const agent = new Agent(agentConfig as ConstructorParameters<typeof Agent>[0]);

    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Task timed out after ${timeout}ms`)), timeout);
    });

    let fullOutput = '';

    const processRun = async () => {
      // Try streaming first, fall back to non-streaming
      try {
        const result = await run(agent, task.prompt, { stream: true } as Parameters<typeof run>[2]);
        const resultAny = result as Record<string, unknown>;

        // Handle streamed result
        if (typeof resultAny.toTextStream === 'function') {
          const stream = (resultAny.toTextStream as () => AsyncIterable<string>)();
          for await (const chunk of stream) {
            fullOutput += chunk;
          }
        } else if (typeof resultAny.finalOutput === 'string') {
          fullOutput = resultAny.finalOutput;
        } else if (resultAny.output) {
          fullOutput = String(resultAny.output);
        }
      } catch {
        // Fall back to non-streaming
        const result = await run(agent, task.prompt);
        const resultAny = result as Record<string, unknown>;
        fullOutput = String(resultAny.finalOutput || resultAny.output || '');
      }
    };

    await Promise.race([processRun(), timeoutPromise]);

    if (fullOutput) {
      yield {
        type: 'text',
        taskId: task.id,
        timestamp: new Date(),
        content: fullOutput,
      };
    }

    yield {
      type: 'complete',
      taskId: task.id,
      timestamp: new Date(),
    };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    yield {
      type: 'error',
      taskId: task.id,
      timestamp: new Date(),
      code: 'SDK_ERROR',
      message: `OpenAI Agents error: ${msg}`,
    };
  }
}

// ============================================================================
// Google ADK executor
// ============================================================================

/**
 * Execute a task using Google ADK (@google/adk)
 *
 * Supports:
 * - Native Google AI (Gemini API key)
 * - Google Cloud Vertex AI
 * - Any model supported by ADK
 */
export async function* executeGoogleAdk(
  task: SubAgentTask,
  cwd: string,
  timeout: number = 15 * 60 * 1000
): AsyncIterable<AgentEvent> {
  yield {
    type: 'start',
    taskId: task.id,
    timestamp: new Date(),
    message: `Starting Google ADK executor (model: ${task.model || 'default'})`,
  };

  const prevEnv: Record<string, string | undefined> = {};

  try {
    const adk = await import('@google/adk');
    const { Agent, Runner } = adk;

    const apiKey = getTaskApiKey(task);

    if (!apiKey) {
      throw new Error('No API key available for Google ADK executor. Set GOOGLE_API_KEY.');
    }

    // Set up env for the ADK
    prevEnv['GOOGLE_API_KEY'] = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = apiKey;

    // Create agent
    const agent = new Agent({
      name: `calliope-subagent-${task.id.slice(0, 8)}`,
      model: task.model || 'gemini-2.0-flash',
      instruction: task.systemPrompt || `You are a sub-agent executing a delegated task. Complete the task thoroughly and return your findings. Working directory: ${cwd}`,
    } as ConstructorParameters<typeof Agent>[0]);

    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Task timed out after ${timeout}ms`)), timeout);
    });

    let fullOutput = '';

    const processRun = async () => {
      // ADK uses Runner to execute agents
      const runner = new Runner({ agent, appName: 'calliope-subagent' } as ConstructorParameters<typeof Runner>[0]);
      const runnerAny = runner as Record<string, unknown>;

      // Try the run method
      if (typeof runnerAny.run === 'function') {
        const result = await (runnerAny.run as (prompt: string) => Promise<Record<string, unknown>>)(task.prompt);
        fullOutput = String(result.output || result.text || result.content || '');
      } else {
        // Fallback: use agent directly if Runner pattern differs
        const agentAny = agent as Record<string, unknown>;
        if (typeof agentAny.generate === 'function') {
          const result = await (agentAny.generate as (prompt: string) => Promise<Record<string, unknown>>)(task.prompt);
          fullOutput = String(result.text || result.content || result.output || '');
        } else {
          throw new Error('Google ADK: could not find run() or generate() method. Check ADK version.');
        }
      }
    };

    await Promise.race([processRun(), timeoutPromise]);

    if (fullOutput) {
      yield {
        type: 'text',
        taskId: task.id,
        timestamp: new Date(),
        content: fullOutput,
      };
    }

    yield {
      type: 'complete',
      taskId: task.id,
      timestamp: new Date(),
    };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    yield {
      type: 'error',
      taskId: task.id,
      timestamp: new Date(),
      code: 'SDK_ERROR',
      message: `Google ADK error: ${msg}`,
    };
  } finally {
    restoreEnv(prevEnv);
  }
}

// ============================================================================
// Executor dispatcher
// ============================================================================

/**
 * Execute a task using the appropriate SDK backend.
 * Falls back to CLI backend if the requested SDK is not available.
 */
export async function* executeSdkAgent(
  task: SubAgentTask,
  cwd: string,
  timeout: number = 15 * 60 * 1000
): AsyncIterable<AgentEvent> {
  switch (task.executor) {
    case 'claude-sdk':
      if (await isClaudeSdkAvailable()) {
        yield* executeClaudeSdk(task, cwd, timeout);
      } else {
        yield {
          type: 'error',
          taskId: task.id,
          timestamp: new Date(),
          code: 'SDK_MISSING',
          message: 'Claude Agent SDK not installed. Run: npm install @anthropic-ai/claude-agent-sdk',
        };
      }
      break;

    case 'openai-sdk':
      if (await isOpenaiSdkAvailable()) {
        yield* executeOpenaiSdk(task, cwd, timeout);
      } else {
        yield {
          type: 'error',
          taskId: task.id,
          timestamp: new Date(),
          code: 'SDK_MISSING',
          message: 'OpenAI Agents JS not installed. Run: npm install @openai/agents',
        };
      }
      break;

    case 'google-adk':
      if (await isGoogleAdkAvailable()) {
        yield* executeGoogleAdk(task, cwd, timeout);
      } else {
        yield {
          type: 'error',
          taskId: task.id,
          timestamp: new Date(),
          code: 'SDK_MISSING',
          message: 'Google ADK not installed. Run: npm install @google/adk',
        };
      }
      break;

    default:
      yield {
        type: 'error',
        taskId: task.id,
        timestamp: new Date(),
        code: 'INVALID_EXECUTOR',
        message: `Unknown executor: ${task.executor}`,
      };
  }
}
