/**
 * UI orchestration - chat controller
 *
 * Assembles every state group, the long-lived refs, the agent/command context
 * builders, and all handlers, then returns flat prop bags for the four regions
 * plus resetSession(). This is the "orchestration" half of the old TerminalChat
 * body; index.tsx keeps only composition. It carries no JSX, so it is a plain
 * module (not a component file).
 */

import { useCallback, useEffect, useRef } from 'react';
import { useApp } from 'ink';
import * as config from '../../config.js';
import { selectProvider } from '../../providers/index.js';
import { getSystemPrompt, DEFAULT_MODELS, supportsVision } from '../../types.js';
import type { Message as LLMMessage, LLMProvider, Mode, MessageContent } from '../../types.js';
import { getModelContextLimit } from '../../model-detection.js';
import type { ModelInfo } from '../../model-detection.js';
import { detectComplexity } from '../../risk.js';
import * as storage from '../../storage.js';
import { parseFileReferences, processFilesForMessage, formatFileInfo } from '../../files.js';
import * as memory from '../../memory.js';
import { CircuitBreaker } from '../../circuit-breaker.js';
import { IterationLedger } from '../../iteration-ledger.js';
import { getDefaultSmartRoutingConfig } from '../../router.js';
import type { SmartRoutingConfig } from '../../router.js';
import { fleetActive, fleetStartPolling, fleetPostMessage } from '../../fleet.js';
import { runAgentImpl, runLoopImpl, validateAndRepairMessagesImpl } from '../agent.js';
import type { AgentContext } from '../agent.js';
import { handleCommand } from '../commands.js';
import type { CommandContext } from '../commands.js';
import { resetContextWarnings } from '../context.js';
import { requestSelfRestart } from '../self-restart.js';
import { isDebugEnabled, setDebugEnabled, debugLog } from '../debug-log.js';
import type { UIMessage, ConversationSnapshot, SessionInfo } from '../types.js';
import type { ProviderEntry } from '../modals/index.js';

import { useTerminalWidth } from './use-terminal-width.js';
import { useProcessingState } from './use-processing-state.js';
import { useTranscriptState } from './use-transcript-state.js';
import { useSessionStats } from './use-session-stats.js';
import { useModelState } from './use-model-state.js';
import { useModalState } from './use-modal-state.js';
import { useQueueState } from './use-queue-state.js';
import { useLoopState } from './use-loop-state.js';
import { useSessionInit } from './use-session-init.js';
import type { TranscriptRegionProps } from '../regions/transcript-region.js';
import type { StatusRegionProps } from '../regions/status-region.js';
import type { InputRegionProps } from '../regions/input-region.js';
import type { ModalHostProps } from '../regions/modal-host.js';

const MAX_UNDO_HISTORY = 10;

export interface ChatController {
  width: number;
  resetSession: () => void;
  transcript: TranscriptRegionProps;
  status: StatusRegionProps;
  input: InputRegionProps;
  modal: ModalHostProps;
}

function makeCircuitBreaker(): CircuitBreaker {
  if (config.get('circuitBreakersEnabled') === false) {
    return null as unknown as CircuitBreaker;
  }
  const iterTimeSec = config.get('maxIterationTime');
  const cb = new CircuitBreaker();
  if (typeof iterTimeSec === 'number' && iterTimeSec > 0) {
    cb.adjust('wall-clock', { maxIterationDurationMs: iterTimeSec * 1000 });
  }
  // Local/free providers: disable cost breaker, relax token limits
  const prov = config.get('defaultProvider');
  if (prov === 'ollama' || prov === 'litellm') {
    cb.adjust('cost-runaway', { maxSessionCost: 999999, maxCostPerMinute: 999999 });
    cb.adjust('token-burn', { maxTokensPerIteration: 500_000, maxTotalTokens: 20_000_000 });
  }
  return cb;
}

export function useChatController(): ChatController {
  const { exit } = useApp();
  const width = useTerminalWidth();

  // -- State groups ---------------------------------------------------------
  const proc = useProcessingState();
  const transcript = useTranscriptState();
  const stats = useSessionStats();
  const modelState = useModelState();
  const modal = useModalState();
  const queue = useQueueState();
  const loop = useLoopState();

  const { messages, collapseSettings, clearCount, addMessage, setMessages } = transcript;
  const { isProcessing, thinkingState, streamingResponse, activityState,
    setIsProcessing, setThinkingState, setStreamingResponse, setActivityState } = proc;
  const { provider, model, mode, confirmMode, autoRoute, smartRouteActive, breakerHealth,
    setProvider, setModel, setMode, setBreakerHealth } = modelState;
  const { queuedMessages, setQueuedMessages, queuedMessagesRef, editingQueueIndex, setEditingQueueIndex } = queue;
  const { loopActive, loopCancelledRef, setLoopActive } = loop;

  // -- Long-lived refs ------------------------------------------------------
  const isProcessingRef = useRef(false);
  const inputSubmitRef = useRef<((value: string) => void) | null>(null);
  const openProviderPickerRef = useRef<(() => void) | null>(null);
  const sessionRef = useRef<storage.Session | null>(null);
  const undoStack = useRef<ConversationSnapshot[]>([]);
  const redoStack = useRef<ConversationSnapshot[]>([]);
  const llmMessages = useRef<LLMMessage[]>([{ role: 'system', content: getSystemPrompt() }]);
  const ledgerRef = useRef<IterationLedger>(new IterationLedger());
  const circuitBreakerRef = useRef<CircuitBreaker>(makeCircuitBreaker());
  const smartRoutingConfigRef = useRef<SmartRoutingConfig>({
    ...getDefaultSmartRoutingConfig(),
    enabled: config.get('routing')?.enabled ?? false,
    costSensitivity: config.get('routing')?.costSensitivity ?? 0.3,
  });

  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);

  // -- Derived --------------------------------------------------------------
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];
  const isModalActive = modal.modalMode !== 'none';
  const contextPercentage = Math.round((stats.contextTokens / getModelContextLimit(actualProvider, actualModel)) * 100);
  const resolvedBreakerHealth = config.get('circuitBreakersEnabled') !== false ? breakerHealth : undefined;

  // -- Core helpers ---------------------------------------------------------
  const handleEditQueuedMessage = useCallback((index: number, newMsg: string) => {
    if (newMsg === '') {
      setQueuedMessages(prev => prev.filter((_, i) => i !== index));
      addMessage('system', `🗑️ Deleted queued message #${index + 1}`);
    } else {
      setQueuedMessages(prev => prev.map((msg, i) => i === index ? newMsg : msg));
      addMessage('system', `✏️ Updated queued message #${index + 1}`);
    }
  }, [addMessage, setQueuedMessages]);

  const validateAndRepairMessages = useCallback(() => {
    return validateAndRepairMessagesImpl({ llmMessages, addMessage, debugLog } as AgentContext);
  }, [addMessage]);

  // Estimate context tokens (conservative: ~2.5 chars/token + 1.35x overhead)
  const estimateContextTokens = useCallback(() => {
    let chars = 0;
    let msgCount = 0;
    for (const msg of llmMessages.current) {
      msgCount++;
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            chars += block.text.length;
          } else if (block.type === 'image') {
            chars += 1000; // Images count as ~250 tokens
          }
        }
      }
      if (msg.toolCalls) {
        for (const tool of msg.toolCalls) {
          chars += JSON.stringify(tool.arguments || {}).length;
        }
      }
    }
    return Math.round((chars / 2.5) * 1.35 + msgCount * 50);
  }, []);

  const saveUndoState = useCallback(() => {
    undoStack.current.push({
      messages: [...messages],
      llmMessages: [...llmMessages.current],
      timestamp: new Date(),
    });
    if (undoStack.current.length > MAX_UNDO_HISTORY) {
      undoStack.current.shift();
    }
    redoStack.current = [];
  }, [messages]);

  // -- Agent / command context builders ------------------------------------
  const buildAgentContext = useCallback((): AgentContext => ({
    provider, model, mode, confirmMode, autoRoute, actualProvider, actualModel,
    stats: stats.stats,
    ledger: ledgerRef.current,
    circuitBreaker: circuitBreakerRef.current || undefined,
    smartRouteActive,
    smartRoutingConfig: smartRoutingConfigRef.current,
    setBreakerHealth,

    setStats: stats.setStats,
    setStreamingResponse,
    setThinkingState,
    setActivityState,
    setContextTokens: stats.setContextTokens,
    setIsProcessing,
    setQueuedMessages,
    setEditingQueueIndex,
    setLoopIteration: loop.setLoopIteration,
    setLoopActive,

    llmMessages,
    queuedMessagesRef,
    loopCancelledRef,
    sessionRef,

    addMessage,
    estimateContextTokens,
    validateAndRepairMessages,

    debugLog,
  }), [provider, model, mode, confirmMode, autoRoute, smartRouteActive, actualProvider, actualModel,
    stats.stats, stats.setStats, stats.setContextTokens, setBreakerHealth, setStreamingResponse,
    setThinkingState, setActivityState, setIsProcessing, setQueuedMessages, setEditingQueueIndex,
    loop.setLoopIteration, setLoopActive, addMessage, estimateContextTokens, validateAndRepairMessages]);

  const runAgent = useCallback(async (content: MessageContent) => {
    await runAgentImpl(buildAgentContext(), content);
  }, [buildAgentContext]);

  const runLoop = useCallback(async (prompt: string, maxIter: number, completionPromise?: string) => {
    await runLoopImpl(buildAgentContext(), prompt, maxIter, completionPromise);
  }, [buildAgentContext]);

  const handleFleetInstruction = useCallback((instruction: string) => {
    if (isProcessingRef.current) {
      setQueuedMessages(prev => [...prev, instruction]);
    } else {
      void inputSubmitRef.current?.(instruction);
    }
  }, [setQueuedMessages]);

  const buildCommandContext = useCallback((): CommandContext => ({
    actualProvider, actualModel, model, mode, confirmMode,
    messages, stats: stats.stats, loopActive, isProcessing, thinkingState, streamingResponse,
    queuedMessages, debugEnabled: isDebugEnabled(), modalMode: modal.modalMode,
    ledger: ledgerRef.current,

    setProvider, setModel, setMode,
    setMessages,
    setStats: stats.setStats,
    setModalMode: modal.setModalMode as (m: string) => void,
    setAvailableModels: modal.setAvailableModels,
    setLoopActive,
    setLoopPrompt: loop.setLoopPrompt,
    setLoopMaxIterations: loop.setLoopMaxIterations,
    setLoopCompletionPromise: loop.setLoopCompletionPromise,
    setLoopIteration: loop.setLoopIteration,
    setContextTokens: stats.setContextTokens,
    setDebugEnabled,

    llmMessages,
    undoStack,
    redoStack,
    loopCancelledRef,
    sessionRef,

    addMessage,
    estimateContextTokens,
    runLoop,
    startFleetPolling: () => { fleetStartPolling(handleFleetInstruction); },
    openProviderPicker: () => openProviderPickerRef.current?.(),
  }), [actualProvider, actualModel, model, mode, confirmMode, messages, stats.stats, stats.setStats,
    stats.setContextTokens, loopActive, isProcessing, thinkingState, streamingResponse, queuedMessages,
    modal.modalMode, modal.setModalMode, modal.setAvailableModels, setProvider, setModel, setMode,
    setMessages, setLoopActive, loop.setLoopPrompt, loop.setLoopMaxIterations, loop.setLoopCompletionPromise,
    loop.setLoopIteration, addMessage, estimateContextTokens, runLoop, handleFleetInstruction]);

  const handleCommandWrapped = useCallback(async (cmd: string): Promise<void> => {
    await handleCommand(cmd, buildCommandContext());
  }, [buildCommandContext]);

  // -- Submit (routing) -----------------------------------------------------
  // The input-widget concerns (history, clearing) live in InputRegion; this is
  // the content-processing half of the original handleSubmit.
  const onSubmitMessage = useCallback(async (trimmed: string) => {
    if (trimmed.startsWith('/')) {
      await handleCommandWrapped(trimmed);
      return;
    }

    // ! prefix executes shell commands directly
    if (trimmed.startsWith('!')) {
      const shellCmd = trimmed.slice(1).trim();
      if (shellCmd) {
        addMessage('system', `$ ${shellCmd}`);
        try {
          const { execSync } = await import('child_process');
          const activeCwd = sessionRef.current?.projectPath ?? process.cwd();
          const output = execSync(shellCmd, {
            cwd: activeCwd,
            encoding: 'utf-8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 10 * 1024 * 1024,
          }).trim();
          addMessage('system', output || '(no output)');
        } catch (err: unknown) {
          const execErr = err as { stderr?: string; message?: string };
          addMessage('error', execErr.stderr?.trim() || execErr.message || String(err));
        }
      }
      return;
    }

    // In hybrid mode, check for complex operations
    if (mode === 'hybrid') {
      const complexity = detectComplexity(trimmed);
      if (complexity.isComplex) {
        modal.setPendingComplexPrompt({ prompt: trimmed, complexity });
        modal.setModalMode('complexity-warning');
        return;
      }
    }

    // Save state for undo before modifying conversation
    saveUndoState();

    // Parse file references from input
    const activeCwd = sessionRef.current?.projectPath ?? process.cwd();
    const { text: cleanText, files } = parseFileReferences(trimmed, activeCwd);

    // Show user message (with file info if any)
    if (files.length > 0) {
      const fileInfo = formatFileInfo(files);
      addMessage('user', `${cleanText}\n📎 ${fileInfo}`);
    } else {
      addMessage('user', trimmed);
    }

    // Mirror user input to IRC so observers see what prompted each agent run
    if (fleetActive()) {
      fleetPostMessage(cleanText || trimmed);
    }

    setIsProcessing(true);

    try {
      let messageContent: MessageContent;
      if (files.length > 0) {
        const visionSupported = supportsVision(provider, model);
        const { content, warnings } = processFilesForMessage(cleanText || trimmed, files, visionSupported);
        for (const warning of warnings) {
          addMessage('system', warning);
        }
        messageContent = content;
      } else {
        messageContent = trimmed;
      }
      await runAgent(messageContent);
    } finally {
      setIsProcessing(false);
      setThinkingState(null);
      setStreamingResponse('');
    }
  }, [handleCommandWrapped, runAgent, addMessage, provider, model, saveUndoState, mode,
    modal, setIsProcessing, setThinkingState, setStreamingResponse]);

  // -- Input action handlers ------------------------------------------------
  const handleQueueMessage = useCallback((msg: string) => {
    setQueuedMessages(prev => [...prev, msg]);
    addMessage('system', `📨 Queued: "${msg.substring(0, 50)}${msg.length > 50 ? '...' : ''}"`);
  }, [addMessage, setQueuedMessages]);

  const cycleMode = useCallback(() => {
    setMode(current => {
      const modes: Mode[] = ['plan', 'hybrid', 'work'];
      const idx = modes.indexOf(current);
      return modes[(idx + 1) % modes.length];
    });
  }, [setMode]);

  const handleEscape = useCallback(() => {
    if (isProcessing) {
      setIsProcessing(false);
      setThinkingState(null);
      setStreamingResponse('');
      setLoopActive(false);
      setEditingQueueIndex(null);
      addMessage('system', '⏹ Operation cancelled. Press Ctrl+C again to quit.');
    } else if (modal.modalMode !== 'none') {
      modal.setModalMode('none');
      modal.setPendingComplexPrompt(null);
    } else {
      addMessage('system', '💡 Press Ctrl+C again to quit, or /exit.');
    }
  }, [isProcessing, modal, addMessage, setIsProcessing, setThinkingState, setStreamingResponse,
    setLoopActive, setEditingQueueIndex]);

  const handleExit = useCallback(() => { exit(); }, [exit]);

  const handleDirectSend = useCallback((msg: string) => {
    setIsProcessing(false);
    setThinkingState(null);
    setStreamingResponse('');
    setEditingQueueIndex(null);

    addMessage('system', '⚡ Direct send - interrupting current operation');
    addMessage('user', msg);

    setIsProcessing(true);
    runAgent(msg).finally(() => {
      setIsProcessing(false);
      setThinkingState(null);
      setStreamingResponse('');
      setEditingQueueIndex(null);
    });
  }, [addMessage, runAgent, setIsProcessing, setThinkingState, setStreamingResponse, setEditingQueueIndex]);

  // -- Modal handlers -------------------------------------------------------
  const handleModelSelect = useCallback((selectedModel: string) => {
    setModel(selectedModel);
    addMessage('system', `Model: ${selectedModel}`);
    modal.setModalMode('none');
    modal.setAvailableModels([]);
  }, [addMessage, setModel, modal]);

  const handleModalCancel = useCallback(() => {
    modal.setModalMode('none');
    modal.setAvailableModels([]);
    modal.setLatestVersion(null);
  }, [modal]);

  const handleUpgradeConfirm = useCallback(async () => {
    modal.setModalMode('none');
    addMessage('system', 'Upgrading...');
    try {
      const { performUpgrade } = await import('../../version-check.js');
      const success = await performUpgrade();
      if (success) {
        addMessage('system', 'Upgrade complete! Restarting...');
        requestSelfRestart(process.argv.slice(1));
        exit();
        return;
      }
      addMessage('error', 'Upgrade failed. Try: npm install -g @calliopelabs/cli@latest');
    } catch (e) {
      addMessage('error', `Upgrade failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    modal.setLatestVersion(null);
  }, [addMessage, modal, exit]);

  const buildProviderEntries = useCallback((): ProviderEntry[] => {
    const hasBedrock = !!(config.getApiKey('bedrock') || config.getBaseUrl('bedrock')
      || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
    return [
      { id: 'ollama',      label: 'Ollama',       configured: !!config.getBaseUrl('ollama'),    configHint: 'OLLAMA_BASE_URL',   recommended: true, note: 'local, free' },
      { id: 'anthropic',   label: 'Anthropic',    configured: !!config.getApiKey('anthropic'),  configHint: 'ANTHROPIC_API_KEY' },
      { id: 'openai',      label: 'OpenAI',       configured: !!config.getApiKey('openai'),     configHint: 'OPENAI_API_KEY' },
      { id: 'google',      label: 'Google',       configured: !!config.getApiKey('google'),     configHint: 'GOOGLE_API_KEY' },
      { id: 'mistral',     label: 'Mistral',      configured: !!config.getApiKey('mistral'),    configHint: 'MISTRAL_API_KEY' },
      { id: 'openrouter',  label: 'OpenRouter',   configured: !!config.getApiKey('openrouter'), configHint: 'OPENROUTER_API_KEY' },
      { id: 'together',    label: 'Together',     configured: !!config.getApiKey('together'),   configHint: 'TOGETHER_API_KEY' },
      { id: 'groq',        label: 'Groq',         configured: !!config.getApiKey('groq'),       configHint: 'GROQ_API_KEY' },
      { id: 'fireworks',   label: 'Fireworks',    configured: !!config.getApiKey('fireworks'),  configHint: 'FIREWORKS_API_KEY' },
      { id: 'ai21',        label: 'AI21',         configured: !!config.getApiKey('ai21'),       configHint: 'AI21_API_KEY' },
      { id: 'huggingface', label: 'HuggingFace',  configured: !!config.getApiKey('huggingface'),configHint: 'HUGGINGFACE_API_KEY' },
      { id: 'bedrock',     label: 'AWS Bedrock',  configured: hasBedrock,                       configHint: 'AWS_PROFILE or AWS_ACCESS_KEY_ID', note: 'AWS credentials' },
      { id: 'litellm',     label: 'LiteLLM',      configured: !!config.getBaseUrl('litellm'),   configHint: 'LITELLM_BASE_URL' },
    ];
  }, []);

  const openProviderPicker = useCallback(() => {
    modal.setProviderEntries(buildProviderEntries());
    modal.setModalMode('provider');
  }, [buildProviderEntries, modal]);

  useEffect(() => { openProviderPickerRef.current = openProviderPicker; }, [openProviderPicker]);

  const handleProviderSelect = useCallback((entry: ProviderEntry) => {
    if (entry.configured) {
      setProvider(entry.id);
      addMessage('system', `Provider: ${entry.label}${entry.id === 'ollama' ? ' (local)' : ''}`);
      modal.setModalMode('none');
      modal.setProviderEntries([]);
      return;
    }
    modal.setPendingSetupProvider(entry);
    modal.setModalMode('api-key-setup');
  }, [addMessage, setProvider, modal]);

  const handleProviderCancel = useCallback(() => {
    modal.setModalMode('none');
    modal.setProviderEntries([]);
  }, [modal]);

  const handleApiKeySubmit = useCallback((value: string) => {
    const entry = modal.pendingSetupProvider;
    if (!entry) {
      modal.setModalMode('none');
      return;
    }
    try {
      if (entry.id === 'ollama') {
        config.setProviderCred('ollama', { baseUrl: value });
      } else if (entry.id === 'litellm') {
        config.setProviderCred('litellm', { baseUrl: value });
      } else if (entry.id === 'bedrock') {
        process.env.AWS_PROFILE = value;
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_SESSION_TOKEN;
        addMessage('system', `AWS_PROFILE=${value} set for this session. Add to shell rc to persist.`);
      } else {
        config.setProviderCred(entry.id, { apiKey: value });
      }
      setProvider(entry.id);
      addMessage('system', `✓ Configured ${entry.label}. Provider switched.`);
    } catch (e) {
      addMessage('error', `Failed to configure ${entry.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    modal.setPendingSetupProvider(null);
    modal.setModalMode('none');
  }, [addMessage, setProvider, modal]);

  const handleApiKeyCancel = useCallback(() => {
    modal.setPendingSetupProvider(null);
    modal.setModalMode('none');
  }, [modal]);

  // -- Session-selector / resume handlers -----------------------------------
  const handleSessionSelect = useCallback((session: SessionInfo) => {
    addMessage('system', `Loading session: ${session.projectName}...`);
    addMessage('system', `Session path: ${session.projectPath}\nTo load this session, run calliope from that directory.`);
    modal.setModalMode('none');
  }, [addMessage, modal]);

  const handleSessionDelete = useCallback((session: SessionInfo) => {
    if (storage.deleteSession(session.id)) {
      addMessage('system', `🗑️ Deleted session: ${session.projectName}`);
      modal.setAvailableSessions(prev => prev.filter(s => s.id !== session.id));
    } else {
      addMessage('error', `Failed to delete session: ${session.projectName}`);
    }
  }, [addMessage, modal]);

  const handleSessionResume = useCallback(() => {
    const savedMessages = storage.loadMessageHistory();
    if (savedMessages && savedMessages.length > 0) {
      llmMessages.current.length = 0;
      for (const msg of savedMessages) {
        llmMessages.current.push(msg as LLMMessage);
      }
      addMessage('system', `✓ Resumed session with ${savedMessages.length} saved messages loaded`);
      const activeSessionId = sessionRef.current?.id;
      if (activeSessionId) {
        ledgerRef.current.loadSnapshot(storage.loadIterationLedger(activeSessionId));
        storage.saveIterationLedger(ledgerRef.current, activeSessionId);
      }
      stats.setContextTokens(estimateContextTokens());
    } else {
      const history = storage.getChatHistory(20);
      if (history.length > 0) {
        llmMessages.current.length = 0;
        const activeCwd = sessionRef.current?.projectPath ?? process.cwd();
        const basePrompt = getSystemPrompt();
        const memoryContext = memory.buildMemoryContext(activeCwd);
        llmMessages.current.push({
          role: 'system',
          content: memoryContext.trim()
            ? `${basePrompt}\n\n--- Project Context ---\n${memoryContext}`
            : basePrompt,
        });
        for (const msg of history) {
          if (msg.role === 'user' || msg.role === 'assistant') {
            llmMessages.current.push({ role: msg.role, content: msg.content });
          }
        }
        addMessage('system', `✓ Resumed session with ${history.length} chat messages loaded`);
        stats.setContextTokens(estimateContextTokens());
      }
    }
    modal.setModalMode('none');
    modal.setPreviousSession(null);
  }, [addMessage, estimateContextTokens, stats, modal]);

  const handleSessionResumeNew = useCallback(() => {
    addMessage('system', '✓ Starting fresh session');
    modal.setModalMode('none');
    modal.setPreviousSession(null);
  }, [addMessage, modal]);

  // -- Complexity-warning handlers ------------------------------------------
  const handleComplexityProceed = useCallback(async () => {
    modal.setModalMode('none');
    const prompt = modal.pendingComplexPrompt?.prompt;
    modal.setPendingComplexPrompt(null);
    if (prompt === undefined) return;

    saveUndoState();
    addMessage('user', typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
    setIsProcessing(true);
    try {
      await runAgent(prompt);
    } finally {
      setIsProcessing(false);
    }
  }, [modal, saveUndoState, addMessage, runAgent, setIsProcessing]);

  const handleComplexityPlan = useCallback(() => {
    modal.setModalMode('none');
    const prompt = modal.pendingComplexPrompt?.prompt;
    modal.setPendingComplexPrompt(null);
    if (prompt === undefined) return;

    setMode('plan');
    addMessage('system', '📋 Switched to Plan mode - I\'ll describe what I would do without executing.');
    saveUndoState();
    addMessage('user', typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
    setIsProcessing(true);
    runAgent(prompt).finally(() => setIsProcessing(false));
  }, [modal, setMode, saveUndoState, addMessage, runAgent, setIsProcessing]);

  const handleComplexityCancel = useCallback(() => {
    modal.setModalMode('none');
    modal.setPendingComplexPrompt(null);
    addMessage('system', 'Operation cancelled.');
  }, [modal, addMessage]);

  const handleKeybindingsClose = useCallback(() => {
    modal.setModalMode('none');
  }, [modal]);

  // -- Session reset (replaces the old full-remount reset) ------------------
  const resetSession = useCallback(() => {
    proc.reset();
    transcript.reset();
    stats.reset();
    modelState.reset();
    modal.reset();
    queue.reset();
    loop.reset();
    llmMessages.current = [{ role: 'system', content: getSystemPrompt() }];
    undoStack.current = [];
    redoStack.current = [];
    ledgerRef.current.reset();
    resetContextWarnings();
  }, [proc, transcript, stats, modelState, modal, queue, loop]);

  // -- Mount initialization -------------------------------------------------
  useSessionInit({ sessionRef, ledgerRef, llmMessages, addMessage, onFleetInstruction: handleFleetInstruction });

  // -- Region prop bags -----------------------------------------------------
  // Plain objects (not memoized): TerminalChat spreads them, so each region's
  // React.memo compares individual props — all of which are stable values or
  // stable useCallback refs when unchanged. This also keeps module-level reads
  // (debugEnabled) fresh on every render, matching the original.
  const transcriptProps: TranscriptRegionProps = {
    messages, collapseSettings, clearCount, isProcessing, thinkingState, streamingResponse, activityState,
    debugEnabled: isDebugEnabled(), mode, queuedCount: queuedMessages.length,
  };

  const statusProps: StatusRegionProps = {
    provider: actualProvider, model: actualModel, mode, stats: stats.stats,
    contextTokens: stats.contextTokens, breakerHealth: resolvedBreakerHealth, smartRouteActive, width,
  };

  const inputProps: InputRegionProps = {
    onSubmitMessage, submitRef: inputSubmitRef, disabled: isModalActive, isProcessing,
    queuedCount: queuedMessages.length, queuedMessages, editingQueueIndex,
    onQueueMessage: handleQueueMessage, onEditQueuedMessage: handleEditQueuedMessage,
    onSetEditingQueueIndex: setEditingQueueIndex, onDirectSend: handleDirectSend,
    onEscape: handleEscape, onExit: handleExit, onCycleMode: cycleMode,
    currentMode: mode, contextPercentage, cwd: process.cwd(),
  };

  const modalProps: ModalHostProps = {
    modalMode: modal.modalMode,
    availableModels: modal.availableModels, onModelSelect: handleModelSelect, onModalCancel: handleModalCancel,
    availableSessions: modal.availableSessions, onSessionSelect: handleSessionSelect, onSessionDelete: handleSessionDelete,
    latestVersion: modal.latestVersion, onUpgradeConfirm: handleUpgradeConfirm,
    previousSession: modal.previousSession, onSessionResume: handleSessionResume, onSessionResumeNew: handleSessionResumeNew,
    pendingComplexPrompt: modal.pendingComplexPrompt, onComplexityProceed: handleComplexityProceed,
    onComplexityPlan: handleComplexityPlan, onComplexityCancel: handleComplexityCancel,
    onKeybindingsClose: handleKeybindingsClose,
    providerEntries: modal.providerEntries, onProviderSelect: handleProviderSelect, onProviderCancel: handleProviderCancel,
    pendingSetupProvider: modal.pendingSetupProvider, onApiKeySubmit: handleApiKeySubmit, onApiKeyCancel: handleApiKeyCancel,
  };

  return {
    width,
    resetSession,
    transcript: transcriptProps,
    status: statusProps,
    input: inputProps,
    modal: modalProps,
  };
}
