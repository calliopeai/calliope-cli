/**
 * UI orchestration - chat controller
 *
 * Assembles every state group, the long-lived refs, the agent/command context
 * builders, and all handlers, then returns flat prop bags for the four regions
 * plus resetSession(). This is the "orchestration" half of the old TerminalChat
 * body; index.tsx keeps only composition. It carries no JSX, so it is a plain
 * module (not a component file).
 */

import { providerChoices, createSubmission, drainSubmissions, type ModelPreference, type ResolvedPreference, type Submission } from '../../preferences/index.js';
import { isCancellation } from '../../cancellation.js';
import { TurnController } from '../../turn-controller.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from 'ink';
import * as config from '../../config.js';
import { selectProvider, ProviderUnavailableError } from '../../providers/index.js';
import { DEFAULT_MODELS } from '../../types.js';
import { getSystemPromptForProvider } from '../../local-model.js';
import type { Message as LLMMessage, LLMProvider, Mode, MessageContent } from '../../types.js';
import { getModelContextLimit } from '../../model-detection.js';
import type { ModelInfo } from '../../model-detection.js';
import type { RoutingDecision } from '../../routing/index.js';
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

export function useChatController(initial?: ModelPreference): ChatController {
  const { exit } = useApp();
  const width = useTerminalWidth();

  // -- State groups ---------------------------------------------------------
  const proc = useProcessingState();
  const transcript = useTranscriptState();
  const stats = useSessionStats();
  const modelState = useModelState(initial);
  const modal = useModalState();
  const queue = useQueueState();
  const loop = useLoopState();

  const { messages, collapseSettings, clearCount, addMessage, setMessages } = transcript;
  const { isProcessing, thinkingState, streamingResponse, activityState,
    setIsProcessing, setThinkingState, setStreamingResponse, setActivityState } = proc;
  const { provider, model, mode, confirmMode, autoRoute, smartRouteActive, breakerHealth,
    setProvider, setModel, setMode, setBreakerHealth } = modelState;
  const { queuedMessages, setQueuedMessages, queuedMessagesRef, editingQueueIndex, setEditingQueueIndex } = queue;
  const [lastRoute, setLastRoute] = useState<RoutingDecision>();
  const { loopActive, loopCancelledRef, setLoopActive } = loop;

  // -- Long-lived refs ------------------------------------------------------
  const isProcessingRef = useRef(false);
  const turnController = useRef(new TurnController());
  useEffect(() => () => turnController.current.cancel(), []);
  const surfacedProviderErrorRef = useRef<string | null>(null);
  const inputSubmitRef = useRef<((value: string) => void) | null>(null);
  const openProviderPickerRef = useRef<(() => Promise<void>) | null>(null);
  const sessionRef = useRef<storage.Session | null>(null);
  const undoStack = useRef<ConversationSnapshot[]>([]);
  const redoStack = useRef<ConversationSnapshot[]>([]);
  const llmMessages = useRef<LLMMessage[]>([{ role: 'system', content: getSystemPromptForProvider(provider) }]);
  const ledgerRef = useRef<IterationLedger>(new IterationLedger());
  const circuitBreakerRef = useRef<CircuitBreaker>(makeCircuitBreaker());
  const smartRoutingConfigRef = useRef<SmartRoutingConfig>({
    ...getDefaultSmartRoutingConfig(),
    ...config.get('routing'),
    enabled: config.get('routing')?.enabled ?? false,
    costSensitivity: config.get('routing')?.costSensitivity ?? 0.3,
  });

  useEffect(() => { isProcessingRef.current = isProcessing; }, [isProcessing]);

  // -- Derived --------------------------------------------------------------
  // Resolve the true serving provider. An explicitly-selected provider with no
  // credential must NOT silently fall back (#217): keep the status bar honest
  // (show the real, unconfigured selection — not a provider that won't serve)
  // and surface the fix once, keeping the UI alive so the user can /setup or
  // /config set. 'auto' with no keys degrades to 'auto' for display.
  let actualProvider: LLMProvider;
  let providerErrorMessage: string | undefined;
  try {
    actualProvider = selectProvider(provider);
  } catch (err) {
    providerErrorMessage = err instanceof Error ? err.message : String(err);
    actualProvider = err instanceof ProviderUnavailableError ? err.provider : 'auto';
  }
  const matchingRoute = lastRoute?.selected && (isProcessing || lastRoute.requested.provider === provider && lastRoute.requested.model === (model ?? null)) ? lastRoute.selected : undefined;
  if (matchingRoute) actualProvider = matchingRoute.provider;
  const actualModel = matchingRoute?.model || model || DEFAULT_MODELS[actualProvider];
  const isModalActive = modal.modalMode !== 'none';
  const contextPercentage = Math.round((stats.contextTokens / getModelContextLimit(actualProvider, actualModel)) * 100);
  const resolvedBreakerHealth = config.get('circuitBreakersEnabled') !== false ? breakerHealth : undefined;

  // Surface a provider-credential problem once per unique message (per session).
  useEffect(() => {
    if (providerErrorMessage && surfacedProviderErrorRef.current !== providerErrorMessage) {
      surfacedProviderErrorRef.current = providerErrorMessage;
      addMessage('system', `⚠️ ${providerErrorMessage}`);
    }
  }, [providerErrorMessage, addMessage]);

  // -- Core helpers ---------------------------------------------------------
  const selection: ResolvedPreference = { provider, model, sources: modelState.sources, warnings: modelState.warnings };
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  useEffect(() => { for (const warning of modelState.warnings) addMessage('system', warning); }, [modelState.warnings, addMessage]);

  const handleEditQueuedMessage = useCallback((index: number, newMsg: string) => {
    try {
      setQueuedMessages(previous => previous.flatMap((message, i) => i !== index ? [message]
        : newMsg ? [{ ...createSubmission(newMsg, message.base), id: message.id }] : []));
      addMessage('system', `${newMsg ? 'Updated' : 'Deleted'} queued message #${index + 1}`);
    } catch (error) { addMessage('error', error instanceof Error ? error.message : 'Cannot edit queued message'); }
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
    preferenceSources: modelState.sources,
    stats: stats.stats,
    ledger: ledgerRef.current,
    circuitBreaker: circuitBreakerRef.current || undefined,
    smartRouteActive,
    smartRoutingConfig: smartRoutingConfigRef.current,
    onRoute: setLastRoute,
    setBreakerHealth,

    setStats: stats.setStats,
    setStreamingResponse,
    setThinkingState,
    setActivityState,
    setContextTokens: stats.setContextTokens,
    setIsProcessing,
    setEditingQueueIndex,
    setLoopIteration: loop.setLoopIteration,
    setLoopActive,

    llmMessages,
    loopCancelledRef,
    sessionRef,

    addMessage,
    estimateContextTokens,
    validateAndRepairMessages,

    debugLog,
  }), [provider, model, modelState.sources, mode, confirmMode, autoRoute, smartRouteActive, actualProvider, actualModel,
    stats.stats, stats.setStats, stats.setContextTokens, setBreakerHealth, setStreamingResponse,
    setThinkingState, setActivityState, setIsProcessing, setQueuedMessages, setEditingQueueIndex,
    loop.setLoopIteration, setLoopActive, addMessage, estimateContextTokens, validateAndRepairMessages]);
  const agentContextRef = useRef(buildAgentContext);
  agentContextRef.current = buildAgentContext;

  const runSubmission = useCallback(async (first: Submission, signal: AbortSignal, modeOverride?: Mode) => {
    const outcome = await drainSubmissions(first, {
      signal,
      next: () => {
        const next = queuedMessagesRef.current[0];
        if (next) { setQueuedMessages(previous => previous.slice(1)); setEditingQueueIndex(null); }
        return next;
      },
      run: async submission => {
        const activeCwd = sessionRef.current?.projectPath ?? process.cwd();
        const { text, files } = parseFileReferences(submission.prompt, activeCwd);
        addMessage('user', files.length ? `${text}\n📎 ${formatFileInfo(files)}` : submission.prompt);
        let content: MessageContent = submission.prompt;
        if (files.length) {
          // Retain attached images; the shared router validates discovered vision
          // support before inference instead of a static provider-name guess.
          const prepared = processFilesForMessage(text || submission.prompt, files, true);
          content = prepared.content;
          for (const warning of prepared.warnings) addMessage('system', warning);
        }
        if (fleetActive()) fleetPostMessage(text || submission.prompt);
        return runAgentImpl({ ...agentContextRef.current(), signal, ...(submission.id === first.id && modeOverride ? { mode: modeOverride } : {}), provider: submission.selection.provider,
          model: submission.selection.model, preferenceSources: submission.selection.sources }, content);
      },
    });
    if (outcome === 'limit' && queuedMessagesRef.current.length) addMessage('system', 'Processed 100 turns; remaining queued work is paused. Submit a new turn to continue.');
    return outcome === 'empty';
  }, [addMessage, setQueuedMessages, setEditingQueueIndex]);

  const runAgent = useCallback(async (submission: Submission, modeOverride?: Mode) => {
    await turnController.current.run(async signal => { await runSubmission(submission, signal, modeOverride); });
  }, [runSubmission]);

  const runLoop = useCallback(async (prompt: string, maxIter: number, completionPromise?: string) => {
    await turnController.current.run(signal => runLoopImpl({ ...buildAgentContext(), signal, afterLoopTurn: async () => {
      const next = queuedMessagesRef.current[0];
      if (!next) return true;
      setQueuedMessages(previous => previous.slice(1)); setEditingQueueIndex(null);
      return runSubmission(next, signal);
    } }, prompt, maxIter, completionPromise));
  }, [buildAgentContext, runSubmission, setQueuedMessages, setEditingQueueIndex]);

  const handleFleetInstruction = useCallback((instruction: string) => {
    if (isProcessingRef.current) {
      try { setQueuedMessages(prev => [...prev, createSubmission(instruction, selectionRef.current)]); }
      catch (error) { addMessage('error', error instanceof Error ? error.message : 'Cannot queue instruction'); }
    } else {
      void inputSubmitRef.current?.(instruction);
    }
  }, [setQueuedMessages, addMessage]);

  const buildCommandContext = useCallback((): CommandContext => ({
    cancelActiveTurn: () => turnController.current.cancel(),
    provider, actualProvider, actualModel, model, mode, confirmMode,
    reloadDefaults: modelState.reload,
    submitOnce: async input => { inputSubmitRef.current?.(input); },
    messages, stats: stats.stats, loopActive, isProcessing, thinkingState, streamingResponse,
    queuedMessages: queuedMessages.map(message => message.text), debugEnabled: isDebugEnabled(), modalMode: modal.modalMode,
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
  }), [provider, modelState.reload, actualProvider, actualModel, model, mode, confirmMode, messages, stats.stats, stats.setStats,
    stats.setContextTokens, loopActive, isProcessing, thinkingState, streamingResponse, queuedMessages,
    modal.modalMode, modal.setModalMode, modal.setAvailableModels, setProvider, setModel, setMode,
    setMessages, setLoopActive, loop.setLoopPrompt, loop.setLoopMaxIterations, loop.setLoopCompletionPromise,
    loop.setLoopIteration, addMessage, estimateContextTokens, runLoop, handleFleetInstruction]);

  const handleCommandWrapped = useCallback(async (cmd: string): Promise<void> => {
    const parts = cmd.trim().split(/\s+/);
    const controlled = ['/provider', '/model', '/defaults'].includes(parts[0]!.toLowerCase()) || parts[0] === '/doctor' && parts.includes('--probe');
    try {
      if (controlled) {
        if (turnController.current.busy) { addMessage('error', 'Wait for the active turn or cancel it before changing provider settings.'); return; }
        setIsProcessing(true);
        try { await turnController.current.run(signal => handleCommand(cmd, { ...buildCommandContext(), signal })); }
        finally { setIsProcessing(false); }
      } else await handleCommand(cmd, buildCommandContext());
    } catch (error) {
      if (!isCancellation(error)) addMessage('error', error instanceof Error ? error.message : 'Command failed');
    }
  }, [buildCommandContext, addMessage, setIsProcessing]);

  // -- Submit (routing) -----------------------------------------------------
  // The input-widget concerns (history, clearing) live in InputRegion; this is
  // the content-processing half of the original handleSubmit.
  const onSubmitMessage = useCallback(async (trimmed: string) => {
    if (trimmed.startsWith('/') && !/^\/once(?:\s|$)/i.test(trimmed)) {
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

    let submission: Submission;
    try { submission = createSubmission(trimmed, selectionRef.current); }
    catch (error) { addMessage('error', error instanceof Error ? error.message : 'Invalid prompt'); return; }
    if (mode === 'hybrid') {
      const complexity = detectComplexity(submission.prompt);
      if (complexity.isComplex) {
        modal.setPendingComplexPrompt({ prompt: submission.prompt, submission, complexity });
        modal.setModalMode('complexity-warning');
        return;
      }
    }
    saveUndoState();
    setIsProcessing(true);
    try { await runAgent(submission); }
    catch (error) { if (!isCancellation(error)) addMessage('error', error instanceof Error ? error.message : 'Turn failed'); }
    finally {
      if (!turnController.current.busy) { setIsProcessing(false); setThinkingState(null); setStreamingResponse(''); }
    }
  }, [handleCommandWrapped, runAgent, addMessage, saveUndoState, mode, modal, setIsProcessing, setThinkingState, setStreamingResponse]);

  // -- Input action handlers ------------------------------------------------
  const handleQueueMessage = useCallback((msg: string) => {
    try { setQueuedMessages(prev => [...prev, createSubmission(msg, selectionRef.current)]); }
    catch (error) { addMessage('error', error instanceof Error ? error.message : 'Cannot queue message'); return; }
    addMessage('system', `📨 Queued: "${msg.substring(0, 50)}${msg.length > 50 ? '...' : ''}"`);
  }, [addMessage, setQueuedMessages]);

  const cycleMode = useCallback(() => {
    setMode(current => {
      const modes: Mode[] = ['plan', 'hybrid', 'work'];
      const idx = modes.indexOf(current);
      return modes[(idx + 1) % modes.length]!;
    });
  }, [setMode]);

  const handleEscape = useCallback(() => {
    if (isProcessing) {
      turnController.current.cancel();
      loopCancelledRef.current = true;
      setThinkingState(null);
      setStreamingResponse('');
      setLoopActive(false);
      setEditingQueueIndex(null);
      addMessage('system', '⏹ Cancellation requested. Waiting for active work to stop.');
    } else if (modal.modalMode !== 'none') {
      modal.setModalMode('none');
      modal.setPendingComplexPrompt(null);
    } else {
      addMessage('system', '💡 Press Ctrl+C again to quit, or /exit.');
    }
  }, [isProcessing, modal, addMessage, setIsProcessing, setThinkingState, setStreamingResponse,
    setLoopActive, setEditingQueueIndex]);

  const handleExit = useCallback(() => { turnController.current.cancel(); exit(); }, [exit]);

  const handleDirectSend = useCallback((msg: string) => {
    let submission: Submission;
    try { submission = createSubmission(msg, selectionRef.current); }
    catch (error) { addMessage('error', error instanceof Error ? error.message : 'Invalid prompt'); return; }
    addMessage('system', 'Interrupting the active turn before sending the new message...');
    loopCancelledRef.current = true;
    void turnController.current.replace(async signal => {
      setIsProcessing(true); setEditingQueueIndex(null); saveUndoState();
      await runSubmission(submission, signal);
    }).catch(error => {
      if (!isCancellation(error)) addMessage('error', error instanceof Error ? error.message : 'Turn failed');
    }).finally(() => {
      if (!turnController.current.busy) { setIsProcessing(false); setThinkingState(null); setStreamingResponse(''); setEditingQueueIndex(null); }
    });
  }, [addMessage, runSubmission, saveUndoState, setIsProcessing, setThinkingState, setStreamingResponse, setEditingQueueIndex]);

  // -- Modal handlers -------------------------------------------------------
  const handleModelSelect = useCallback((selectedModel: string) => {
    modal.setModalMode('none'); modal.setAvailableModels([]);
    void handleCommandWrapped(`/model ${selectedModel}`);
  }, [handleCommandWrapped, modal]);

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

  const openProviderPicker = useCallback(async () => {
    modal.setProviderEntries(await providerChoices());
    modal.setModalMode('provider');
  }, [modal]);

  useEffect(() => { openProviderPickerRef.current = openProviderPicker; }, [openProviderPicker]);

  const handleProviderSelect = useCallback((entry: ProviderEntry) => {
    if (entry.configured) {
      modal.setModalMode('none'); modal.setProviderEntries([]);
      void handleCommandWrapped(`/provider ${entry.id}`);
      return;
    }
    modal.setPendingSetupProvider(entry); modal.setModalMode('api-key-setup');
  }, [handleCommandWrapped, modal]);

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
      } else if (entry.id === 'litellm' || entry.id === 'openai-compat') {
        config.setProviderCred(entry.id, { baseUrl: value });
      } else if (entry.id === 'bedrock') {
        process.env.AWS_PROFILE = value;
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_SESSION_TOKEN;
        addMessage('system', `AWS_PROFILE=${value} set for this session. Add to shell rc to persist.`);
      } else {
        config.setProviderCred(entry.id, { apiKey: value });
      }
      addMessage('system', `Configured ${entry.label}. Checking model discovery...`);
      void handleCommandWrapped(`/provider ${entry.id}`);
    } catch (e) {
      addMessage('error', `Failed to configure ${entry.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    modal.setPendingSetupProvider(null);
    modal.setModalMode('none');
  }, [addMessage, handleCommandWrapped, modal]);

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
        const basePrompt = getSystemPromptForProvider(actualProvider);
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
  }, [addMessage, estimateContextTokens, stats, modal, actualProvider]);

  const handleSessionResumeNew = useCallback(() => {
    addMessage('system', '✓ Starting fresh session');
    modal.setModalMode('none');
    modal.setPreviousSession(null);
  }, [addMessage, modal]);

  // -- Complexity-warning handlers ------------------------------------------
  const handleComplexityProceed = useCallback(async () => {
    modal.setModalMode('none');
    const submission = modal.pendingComplexPrompt?.submission;
    modal.setPendingComplexPrompt(null);
    if (!submission) return;

    saveUndoState();
    setIsProcessing(true);
    try {
      await runAgent(submission);
    } finally {
      setIsProcessing(false);
    }
  }, [modal, saveUndoState, addMessage, runAgent, setIsProcessing]);

  const handleComplexityPlan = useCallback(() => {
    modal.setModalMode('none');
    const submission = modal.pendingComplexPrompt?.submission;
    modal.setPendingComplexPrompt(null);
    if (!submission) return;

    setMode('plan');
    addMessage('system', '📋 Switched to Plan mode - I\'ll describe what I would do without executing.');
    saveUndoState();
    setIsProcessing(true);
    void runAgent(submission, 'plan').catch(error => { if (!isCancellation(error)) addMessage('error', error instanceof Error ? error.message : 'Turn failed'); }).finally(() => setIsProcessing(false));
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
    llmMessages.current = [{ role: 'system', content: getSystemPromptForProvider(actualProvider) }];
    undoStack.current = [];
    redoStack.current = [];
    ledgerRef.current.reset();
    resetContextWarnings();
  }, [proc, transcript, stats, modelState, modal, queue, loop, actualProvider]);

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
    queuedCount: queuedMessages.length, queuedMessages: queuedMessages.map(message => message.text), editingQueueIndex,
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
