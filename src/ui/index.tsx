/**
 * UI Module - Entry Point
 *
 * TerminalChat (main component), App wrapper, printBanner, startInkCLI.
 * Imports extracted modules and wires state through context bags.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { render, Box, Text, useApp, useStdout } from 'ink';
import * as fs from 'fs';
import * as config from '../config.js';
import { selectProvider } from '../providers/index.js';
import { estimateContextUsage } from '../providers/types.js';
import { getTools } from '../tools.js';
import { getSystemPrompt, DEFAULT_MODELS, MODE_CONFIG, supportsVision, calculateCost } from '../types.js';
import { getVersion } from '../version-check.js';
import { getModelContextLimit, preWarmModelCache } from '../model-detection.js';
import { detectComplexity } from '../risk.js';
import * as storage from '../storage.js';
import { parseFileReferences, processFilesForMessage, formatFileInfo } from '../files.js';
import * as memory from '../memory.js';
import * as hooks from '../hooks.js';
import * as summarization from '../summarization.js';
import type { Message as LLMMessage, LLMProvider, Mode, MessageContent } from '../types.js';
import type { ModelInfo } from '../model-detection.js';
import { getCurrentSkin, paletteColorize } from '../hud/api.js';
import { renderColoredBanner, renderSplashAnimation, renderTransition, colorFg } from '../terminal-image.js';
import { HUDFrame } from './frame.js';
import { setEmojiConfig } from '../styles.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import { IterationLedger } from '../iteration-ledger.js';
import { getDefaultSmartRoutingConfig } from '../router.js';
import type { SmartRoutingConfig } from '../router.js';
import * as sessionTimeout from '../session-timeout.js';
import * as idleEviction from '../idle-eviction.js';
import { fleetInit, fleetStatus, fleetActive, fleetStartPolling, fleetPostOnline, fleetPostOffline, fleetPostMessage } from '../fleet.js';

// Sub-module imports
import type {
  UIMessage, SessionStats, CollapseSettings, ThinkingState, ActivityState,
  ConversationSnapshot, Bookmark, PromptTemplate, SessionInfo,
} from './types.js';
import { ErrorBoundary } from './error-boundary.js';
import { ThinkingDisplay, ProcessingIndicator, StreamingIndicator, StateTransition } from './components.js';
import { MessageHistory } from './messages.js';
import {
  ModelSelector, SessionSelector, UpgradePrompt, ComplexityWarning,
  SessionResumePrompt, KeybindingsModal, ProviderSelector, ApiKeySetup,
} from './modals.js';
import type { ProviderEntry } from './modals.js';
import { ChatInput } from './chat-input.js';
import { StatusBar } from './status-bar.js';
import { resetContextWarnings } from './context.js';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';
import { runAgentImpl, runLoopImpl, validateAndRepairMessagesImpl } from './agent.js';
import type { AgentContext } from './agent.js';
import { resolveIterationLimit } from '../iteration-limit.js';

// Wire emoji config at module load (breaks circular dep: styles → config)
setEmojiConfig(config);

let pendingRestartArgs: string[] | null = null;

function requestSelfRestart(args: string[] = process.argv.slice(1)): void {
  pendingRestartArgs = [...args];
}

async function spawnPendingRestart(): Promise<void> {
  if (!pendingRestartArgs) {
    return;
  }

  const restartArgs = pendingRestartArgs;
  pendingRestartArgs = null;
  const { spawn } = await import('child_process');
  const child = spawn(process.argv[0], restartArgs, {
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
}

// Debug logging for flow control issues
let debugEnabled = process.env.CALLIOPE_DEBUG === '1';
const debugLog = (label: string, ...args: unknown[]) => {
  if (debugEnabled) {
    const timestamp = new Date().toISOString().split('T')[1].slice(0, 12);
    console.error(`[${timestamp}] ${label}:`, ...args);
  }
};

// ============================================================================
// Main Chat Component
// ============================================================================

function TerminalChat() {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Reactive terminal width - re-renders on resize via SIGWINCH
  const [width, setWidth] = useState(() => stdout?.columns || 80);
  useEffect(() => {
    const onResize = () => {
      const cols = stdout?.columns || process.stdout.columns || 80;
      setWidth(cols);
    };
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, [stdout]);

  // Core state
  // Input value is held primarily in a ref so that keystrokes don't force
  // a full parent re-render (which cascades through modals, layouts, status bar
  // and causes visible paint lag on every character). We only bump `inputVersion`
  // when we need the parent to re-render with a programmatic value change
  // (history nav, clear on submit) — keystrokes never trigger a parent render.
  const inputRef = useRef('');
  const [inputVersion, setInputVersion] = useState(0);
  const setInputValue = useCallback((value: string) => {
    inputRef.current = value;
    setInputVersion(v => v + 1);
  }, []);
  const input = inputRef.current;
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [streamingResponse, setStreamingResponse] = useState<string>('');
  const [activityState, setActivityState] = useState<ActivityState | null>(null);

  // State transition tracking
  const prevProcessingState = useRef<'idle' | 'thinking' | 'streaming' | 'done'>('idle');
  const [transition, setTransition] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    const current: 'idle' | 'thinking' | 'streaming' | 'done' =
      isProcessing && thinkingState && !streamingResponse ? 'thinking' :
      isProcessing && streamingResponse ? 'streaming' :
      !isProcessing && prevProcessingState.current !== 'idle' ? 'done' : 'idle';

    if (current !== prevProcessingState.current) {
      const from = prevProcessingState.current;
      // Only show transitions for meaningful state changes
      if (from !== 'idle' || current !== 'idle') {
        setTransition({ from, to: current });
      }
      prevProcessingState.current = current;
    }
  }, [isProcessing, thinkingState, streamingResponse]);

  // Input history for up/down arrow navigation
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState(''); // Save current input when navigating

  // Smart suggestions context
  const [hasGitRepo] = useState(() => {
    try {
      return fs.existsSync('.git') || fs.existsSync('../.git');
    } catch {
      return false;
    }
  });
  const recentCommands = React.useMemo(
    () => inputHistory.filter(cmd => cmd.startsWith('/')).slice(-10),
    [inputHistory]
  );

  // Handle changes coming from the ChatInput. During typing, we update the
  // ref only — ChatInput paints itself synchronously from its own ref, so we
  // don't need to re-render the parent. We still want to clear stale slash
  // suggestions and reset history navigation, but those setters bail out
  // via functional updates when the value is already current.
  const handleInputChange = useCallback((newValue: string) => {
    inputRef.current = newValue;
    if (!newValue || !newValue.startsWith('/')) {
      setSuggestions(prev => prev.length > 0 ? [] : prev);
    }
    setHistoryIndex(prev => prev === -1 ? prev : -1);
  }, []);

  // Navigate input history
  const navigateHistory = useCallback((direction: 'up' | 'down') => {
    if (inputHistory.length === 0) return;

    if (direction === 'up') {
      if (historyIndex === -1) {
        // Save current input before navigating
        setSavedInput(inputRef.current);
        setHistoryIndex(inputHistory.length - 1);
        setInputValue(inputHistory[inputHistory.length - 1]);
      } else if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1);
        setInputValue(inputHistory[historyIndex - 1]);
      }
    } else {
      if (historyIndex === -1) return;
      if (historyIndex < inputHistory.length - 1) {
        setHistoryIndex(historyIndex + 1);
        setInputValue(inputHistory[historyIndex + 1]);
      } else {
        // Return to saved input
        setHistoryIndex(-1);
        setInputValue(savedInput);
      }
    }
  }, [inputHistory, historyIndex, savedInput, setInputValue]);

  // Add to history when submitting
  const addToHistory = useCallback((value: string) => {
    if (value.trim() && (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== value)) {
      setInputHistory(prev => [...prev.slice(-100), value]); // Keep last 100 entries
    }
    setHistoryIndex(-1);
    setSavedInput('');
  }, [inputHistory]);

  // Config state
  // Use lazy initializers to avoid calling config.get() on every render
  const [provider, setProvider] = useState<LLMProvider>(() =>
    (process.env.CALLIOPE_PROVIDER as LLMProvider) || config.get('defaultProvider'));
  const [model, setModel] = useState<string | undefined>(() =>
    process.env.CALLIOPE_MODEL || config.get('defaultModel'));
  const [mode, setMode] = useState<Mode>('hybrid'); // Default to hybrid mode
  const [confirmMode, setConfirmMode] = useState<boolean>(true); // Require confirmation for risky ops
  const [layout, setLayout] = useState<'classic' | 'response-top' | 'response-bottom' | 'split' | 'zen' | 'focus' | 'dashboard' | 'minimal'>(() => config.get('layout') || 'response-bottom');
  const [density, setDensity] = useState<'normal' | 'compact'>(() => config.get('density') || 'normal');
  const [collapseSettings, setCollapseSettings] = useState<CollapseSettings>(() => ({
    collapseTools: config.get('collapseTools') ?? false,
    collapseThinking: config.get('collapseThinking') ?? false,
    toolDisplayLimit: config.get('toolDisplayLimit') ?? 0,
  }));

  // Modal state
  const [modalMode, setModalMode] = useState<'none' | 'model' | 'upgrade' | 'confirm' | 'session-resume' | 'complexity-warning' | 'keys' | 'sessions' | 'provider' | 'api-key-setup'>('none');
  const [providerEntries, setProviderEntries] = useState<ProviderEntry[]>([]);
  const [pendingSetupProvider, setPendingSetupProvider] = useState<ProviderEntry | null>(null);
  const [pendingComplexPrompt, setPendingComplexPrompt] = useState<{ prompt: MessageContent; complexity: { isComplex: boolean; reason?: string } } | null>(null);
  const [previousSession, setPreviousSession] = useState<{ projectName: string; lastAccessedAt: string; messageCount: number } | null>(null);
  const [pendingToolCall, setPendingToolCall] = useState<{ toolCall: import('../types.js').ToolCall; resolve: (approved: boolean) => void } | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [availableSessions, setAvailableSessions] = useState<SessionInfo[]>([]);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  // Stats
  const [stats, setStats] = useState<SessionStats>({
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    messageCount: 0,
  });
  const [contextTokens, setContextTokens] = useState(0);

  // Message queue for human-in-the-loop feedback during processing
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const queuedMessagesRef = useRef<string[]>([]); // Ref to avoid stale closure in runAgent
  const [queueInput, setQueueInput] = useState('');
  const [editingQueueIndex, setEditingQueueIndex] = useState<number | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);

  // Refs for fleet polling — avoids stale closures across re-renders
  const isProcessingRef = useRef(false);
  const handleSubmitRef = useRef<(value: string) => Promise<void>>(async () => {});
  const openProviderPickerRef = useRef<(() => void) | null>(null);

  // Keep isProcessingRef in sync
  useEffect(() => {
    isProcessingRef.current = isProcessing;
  }, [isProcessing]);

  // Undo/Redo history - stores snapshots of conversation state
  const undoStack = useRef<ConversationSnapshot[]>([]);
  const redoStack = useRef<ConversationSnapshot[]>([]);
  const MAX_UNDO_HISTORY = 10;

  // Conversation bookmarks
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  // Prompt templates
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);

  // Save state before changes (call before modifying messages)
  const saveUndoState = useCallback(() => {
    undoStack.current.push({
      messages: [...messages],
      llmMessages: [...llmMessages.current],
      timestamp: new Date(),
    });
    // Limit stack size
    if (undoStack.current.length > MAX_UNDO_HISTORY) {
      undoStack.current.shift();
    }
    // Clear redo stack on new action
    redoStack.current = [];
  }, [messages]);

  // LLM conversation history
  const llmMessages = useRef<LLMMessage[]>([
    { role: 'system', content: getSystemPrompt() }
  ]);

  // Estimate context tokens (conservative: ~2.5 chars per token + 1.35x overhead)
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
      // Include tool call arguments in estimation
      if (msg.toolCalls) {
        for (const tool of msg.toolCalls) {
          chars += JSON.stringify(tool.arguments || {}).length;
        }
      }
    }
    // Conservative: 2.5 chars/token, 1.35x overhead for formatting/metadata, +50 per message
    return Math.round((chars / 2.5) * 1.35 + msgCount * 50);
  }, []);

  // Session state
  const sessionRef = useRef<storage.Session | null>(null);
  const [autoRoute, setAutoRoute] = useState<boolean>(false);  // Auto model routing
  const [smartRouteActive, setSmartRouteActive] = useState<boolean>(() => config.get('smartRoutingEnabled') ?? false);
  const [breakerHealth, setBreakerHealth] = useState<'ok' | 'warning' | 'tripped'>('ok');
  const ledgerRef = useRef<IterationLedger>(new IterationLedger());
  const circuitBreakerRef = useRef<CircuitBreaker>(
    config.get('circuitBreakersEnabled') !== false ? (() => {
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
    })() : null as unknown as CircuitBreaker
  );
  const smartRoutingConfigRef = useRef<SmartRoutingConfig>({
    ...getDefaultSmartRoutingConfig(),
    enabled: config.get('smartRoutingEnabled') ?? false,
    costSensitivity: config.get('smartRoutingCostSensitivity') ?? 0.3,
  });
  const [memoryLoaded, setMemoryLoaded] = useState(false);

  // Agent loop state
  const [loopActive, setLoopActive] = useState(false);
  const [loopPrompt, setLoopPrompt] = useState<string>('');
  const [loopMaxIterations, setLoopMaxIterations] = useState(() => resolveIterationLimit(config.get('maxIterations')));
  const [loopCompletionPromise, setLoopCompletionPromise] = useState<string | undefined>();
  const [loopIteration, setLoopIteration] = useState(0);
  const loopCancelledRef = useRef(false);

  // Initialize session and load memory on mount
  useEffect(() => {
    const cwd = process.cwd();

    // Always start fresh session - skip resume dialog
    // Note: Previous session data is still available via storage APIs if needed

    const session = storage.getOrCreateSession(cwd);
    sessionRef.current = session;
    ledgerRef.current.setRetentionLimit(config.get('sessionLogLimit') ?? 0);
    ledgerRef.current.setOnChange(() => {
      const activeSessionId = sessionRef.current?.id;
      if (activeSessionId) {
        storage.saveIterationLedger(ledgerRef.current, activeSessionId);
      }
    });
    ledgerRef.current.loadSnapshot(storage.loadIterationLedger(session.id));
    storage.saveIterationLedger(ledgerRef.current, session.id);

    // Load memory context into system prompt
    if (!memoryLoaded) {
      const cwdMem = process.cwd();
      const memoryContext = memory.buildMemoryContext(cwdMem);
      if (memoryContext.trim()) {
        // Append memory context to system prompt
        const currentSystem = llmMessages.current[0];
        if (currentSystem && currentSystem.role === 'system') {
          const systemContent = typeof currentSystem.content === 'string'
            ? currentSystem.content
            : '';
          llmMessages.current[0] = {
            role: 'system',
            content: systemContent + '\n\n--- Project Context ---\n' + memoryContext,
          };
        }
      }
      setMemoryLoaded(true);

      // Execute session start hooks
      hooks.executeHooks('session-start', {}).catch((err) => {
        debugLog('hooks', 'session-start hook failed:', err instanceof Error ? err.message : err);
      });

      // Initialize fleet mode (no-op unless fleet.enabled)
      fleetInit(session.id, cwdMem).then((enabled) => {
        if (enabled) {
          const status = fleetStatus();
          debugLog('fleet', `active, nick=${status?.nick}, irc=${status?.config?.ircAddr}`);
          // Show nick in system messages so operators know how to address calliope
          addMessage('system', `Fleet connected — address me as: ${status?.nick}`);
          fleetPostOnline();
          fleetPostMessage(`connected — address me as: ${status?.nick}`);
          // Route incoming fleet instructions into the agent loop
          fleetStartPolling((instruction) => {
            if (isProcessingRef.current) {
              setQueuedMessages(prev => [...prev, instruction]);
            } else {
              void handleSubmitRef.current(instruction);
            }
          });
        }
      }).catch((err) => {
        debugLog('fleet', 'initialization failed:', err instanceof Error ? err.message : err);
      });

      // Configure session timeout (opt-in via config)
      const timeoutMs = config.get('sessionTimeoutMs');
      if (timeoutMs) {
        sessionTimeout.configureTimeout({
          enabled: true,
          idleTimeoutMs: typeof timeoutMs === 'number' ? timeoutMs : 2 * 60 * 60 * 1000,
        });
        sessionTimeout.onTimeout((type) => {
          if (type === 'warning') {
            addMessage('system', `\u23f1\ufe0f  Session will timeout in ${sessionTimeout.formatTimeRemaining()}`);
          } else {
            addMessage('system', '\ud83d\udeaa Session timeout. Saving and exiting...');
            storage.saveMessageHistory(llmMessages.current);
          }
        });
      }

      // Start idle eviction monitor
      idleEviction.configureEviction({ enabled: true });
      idleEviction.onEviction((action) => {
        if (action === 'auto-save') {
          storage.saveMessageHistory(llmMessages.current);
        }
      });


      // Load templates from storage
      const savedTemplates = storage.getTemplates();
      if (savedTemplates.length > 0) {
        setTemplates(savedTemplates.map(t => ({
          name: t.name,
          prompt: t.prompt,
          createdAt: new Date(t.createdAt),
        })));
      }

      // Pre-warm model cache in background for faster model switching
      preWarmModelCache().catch((err) => {
        debugLog('cache', 'model cache pre-warm failed:', err instanceof Error ? err.message : err);
      });
    }
  }, [memoryLoaded]);

  // Derived values
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];
  const isModalActive = modalMode !== 'none';

  // Add message helper
  const addMessage = useCallback((type: UIMessage['type'], content: string, isError?: boolean) => {
    setMessages(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      content,
      // isError is plumbed through to the renderer (messages.tsx) so the tool
      // status icon is driven by the authoritative executeTool flag rather than
      // string-matching the output. Omitted (undefined) for non-tool messages.
      ...(isError !== undefined ? { isError } : {}),
    }]);
    // Persist user and assistant messages to storage for session history
    if (type === 'user' || type === 'assistant') {
      storage.addChatMessage({ role: type, content });
    }
  }, []);

  // Handler to edit or delete a queued message
  const handleEditQueuedMessage = useCallback((index: number, newMsg: string) => {
    if (newMsg === '') {
      // Delete the message
      setQueuedMessages(prev => prev.filter((_, i) => i !== index));
      addMessage('system', `🗑️ Deleted queued message #${index + 1}`);
    } else {
      // Update the message
      setQueuedMessages(prev => prev.map((msg, i) => i === index ? newMsg : msg));
      addMessage('system', `✏️ Updated queued message #${index + 1}`);
    }
  }, [addMessage]);

  // Validate and repair message history
  const validateAndRepairMessages = useCallback(() => {
    return validateAndRepairMessagesImpl({
      llmMessages,
      addMessage,
      debugLog,
    } as AgentContext);
  }, [addMessage]);

  // Build agent context
  const buildAgentContext = useCallback((): AgentContext => ({
    provider,
    model,
    mode,
    confirmMode,
    autoRoute,
    actualProvider,
    actualModel,
    stats,
    ledger: ledgerRef.current,
    circuitBreaker: circuitBreakerRef.current || undefined,
    smartRouteActive,
    smartRoutingConfig: smartRoutingConfigRef.current,
    setBreakerHealth,

    setStats,
    setStreamingResponse,
    setThinkingState,
    setActivityState,
    setContextTokens,
    setIsProcessing,
    setQueuedMessages,
    setEditingQueueIndex,
    setLoopIteration,
    setLoopActive,

    llmMessages,
    queuedMessagesRef,
    loopCancelledRef,
    sessionRef,

    addMessage,
    estimateContextTokens,
    validateAndRepairMessages,

    debugLog,
  }), [provider, model, mode, confirmMode, autoRoute, smartRouteActive, actualProvider, actualModel, stats, addMessage, estimateContextTokens, validateAndRepairMessages]);

  // Run agent with user prompt
  const runAgent = useCallback(async (content: MessageContent) => {
    const ctx = buildAgentContext();
    await runAgentImpl(ctx, content);
  }, [buildAgentContext]);

  // Agent loop - runs prompt repeatedly until completion promise or max iterations
  const runLoop = useCallback(async (prompt: string, maxIter: number, completionPromise?: string) => {
    const ctx = buildAgentContext();
    await runLoopImpl(ctx, prompt, maxIter, completionPromise);
  }, [buildAgentContext]);

  // Build command context
  const buildCommandContext = useCallback((): CommandContext => ({
    actualProvider,
    actualModel,
    provider,
    model,
    mode,
    confirmMode,
    autoRoute,
    layout,
    density,
    collapseSettings,
    messages,
    stats,
    loopActive,
    isProcessing,
    thinkingState,
    streamingResponse,
    queuedMessages,
    bookmarks,
    templates,
    debugEnabled,
    modalMode,
    circuitBreaker: circuitBreakerRef.current || undefined,
    smartRouteActive,
    smartRoutingConfig: smartRoutingConfigRef.current,
    ledger: ledgerRef.current,

    setProvider,
    setModel,
    setMode,
    setConfirmMode,
    setAutoRoute,
    setLayout: setLayout as (l: string) => void,
    setDensity: setDensity as (d: string) => void,
    setCollapseSettings,
    setMessages,
    setStats,
    setModalMode: setModalMode as (m: string) => void,
    setPendingComplexPrompt,
    setAvailableModels,
    setAvailableSessions,
    setLatestVersion,
    setLoopActive,
    setLoopPrompt,
    setLoopMaxIterations,
    setLoopCompletionPromise,
    setLoopIteration,
    setIsProcessing,
    setThinkingState,
    setStreamingResponse,
    setQueuedMessages,
    setInput: setInputValue,
    setBookmarks,
    setTemplates,
    setContextTokens,
    setDebugEnabled: (v: boolean) => { debugEnabled = v; },
    setSmartRouteActive,
    setBreakerHealth,

    llmMessages,
    undoStack,
    redoStack,
    loopCancelledRef,
    sessionRef,

    addMessage,
    estimateContextTokens,
    saveUndoState,
    runAgent,
    runLoop,
    exit,
    startFleetPolling: () => {
      fleetStartPolling((instruction) => {
        if (isProcessingRef.current) {
          setQueuedMessages(prev => [...prev, instruction]);
        } else {
          void handleSubmitRef.current(instruction);
        }
      });
    },
    openProviderPicker: () => openProviderPickerRef.current?.(),
  }), [actualProvider, actualModel, provider, model, mode, confirmMode, autoRoute, smartRouteActive,
       layout, density, collapseSettings, messages, stats, loopActive, isProcessing,
       thinkingState, streamingResponse, queuedMessages, bookmarks, templates, modalMode,
       addMessage, estimateContextTokens, saveUndoState, runAgent, runLoop, exit]);

  // Handle slash commands
  const handleCommandWrapped = useCallback(async (cmd: string): Promise<void> => {
    const ctx = buildCommandContext();
    await handleCommand(cmd, ctx);
  }, [buildCommandContext]);

  // Handle input submission
  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isProcessing) return;

    // Record activity for timeout/eviction and audit log
    sessionTimeout.recordActivity();
    idleEviction.recordActivity();

    // Add to history for up/down arrow navigation
    addToHistory(trimmed);
    setInputValue('');

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
        setPendingComplexPrompt({ prompt: trimmed, complexity });
        setModalMode('complexity-warning');
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
      // Build message content (with file/image support)
      let messageContent: MessageContent;

      if (files.length > 0) {
        const visionSupported = supportsVision(provider, model);
        const { content, warnings } = processFilesForMessage(cleanText || trimmed, files, visionSupported);

        // Show any warnings about files
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
  }, [isProcessing, handleCommandWrapped, runAgent, addMessage, provider, model, saveUndoState, addToHistory, mode, setInputValue]);

  // Keep handleSubmitRef current so fleet polling never captures a stale closure
  useEffect(() => {
    handleSubmitRef.current = handleSubmit;
  }, [handleSubmit]);

  // Modal handlers
  const handleModelSelect = useCallback((selectedModel: string) => {
    setModel(selectedModel);
    addMessage('system', `Model: ${selectedModel}`);
    setModalMode('none');
    setAvailableModels([]);
  }, [addMessage]);

  const handleModalCancel = useCallback(() => {
    setModalMode('none');
    setAvailableModels([]);
    setLatestVersion(null);
  }, []);

  const handleUpgradeConfirm = useCallback(async () => {
    setModalMode('none');
    addMessage('system', 'Upgrading...');

    try {
      const { performUpgrade } = await import('../version-check.js');
      const success = await performUpgrade();
      if (success) {
        addMessage('system', 'Upgrade complete! Restarting...');
        requestSelfRestart(process.argv.slice(1));
        exit();
        return;
      } else {
        addMessage('error', 'Upgrade failed. Try: npm install -g @calliopelabs/cli@latest');
      }
    } catch (e) {
      addMessage('error', `Upgrade failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLatestVersion(null);
  }, [addMessage]);

  // Cycle through modes
  const cycleMode = useCallback(() => {
    setMode(current => {
      const modes: Mode[] = ['plan', 'hybrid', 'work'];
      const idx = modes.indexOf(current);
      const next = modes[(idx + 1) % modes.length];
      return next;
    });
  }, []);

  // Handle Escape key - cancel operation if processing, otherwise show hint
  const handleEscape = useCallback(() => {
    if (isProcessing) {
      // Cancel current operation
      setIsProcessing(false);
      setThinkingState(null);
      setStreamingResponse('');
      setLoopActive(false);
      setEditingQueueIndex(null);
      addMessage('system', '⏹ Operation cancelled. Press Ctrl+C again to quit.');
    } else if (modalMode !== 'none') {
      // Close any open modal
      setModalMode('none');
      setPendingComplexPrompt(null);
    } else {
      // Not processing - show hint. Second Ctrl+C within 2s will actually exit.
      addMessage('system', '💡 Press Ctrl+C again to quit, or /exit.');
    }
  }, [isProcessing, modalMode, addMessage]);

  const handleExit = useCallback(() => {
    exit();
  }, [exit]);

  // Build the list of providers with their configuration status for the picker.
  // Ordering: Ollama first (recommended onboarding), then others by rough popularity.
  const buildProviderEntries = useCallback((): ProviderEntry[] => {
    const hasBedrock = !!(config.getApiKey('bedrock') || config.getBaseUrl('bedrock')
      || process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE);
    const entries: ProviderEntry[] = [
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
    return entries;
  }, []);

  const openProviderPicker = useCallback(() => {
    setProviderEntries(buildProviderEntries());
    setModalMode('provider');
  }, [buildProviderEntries]);

  const handleProviderSelect = useCallback((entry: ProviderEntry) => {
    if (entry.configured) {
      setProvider(entry.id);
      addMessage('system', `Provider: ${entry.label}${entry.id === 'ollama' ? ' (local)' : ''}`);
      setModalMode('none');
      setProviderEntries([]);
      return;
    }
    // Not configured — open inline setup.
    setPendingSetupProvider(entry);
    setModalMode('api-key-setup');
  }, [addMessage, setProvider]);

  const handleApiKeySubmit = useCallback((value: string) => {
    const entry = pendingSetupProvider;
    if (!entry) {
      setModalMode('none');
      return;
    }
    try {
      // Map provider → config key. Bedrock/Ollama/LiteLLM are special (base URL or AWS).
      if (entry.id === 'ollama') {
        config.set('ollamaBaseUrl', value);
      } else if (entry.id === 'litellm') {
        config.set('litellmBaseUrl', value);
      } else if (entry.id === 'bedrock') {
        // Simplest path: user enters AWS_PROFILE name. Write to env for this session;
        // persistence is user's responsibility (profile lives in ~/.aws).
        process.env.AWS_PROFILE = value;
        // Clear any stale env-var credentials (e.g. from a prior `aws sso login`
        // export that's since expired) so the profile actually wins.
        delete process.env.AWS_ACCESS_KEY_ID;
        delete process.env.AWS_SECRET_ACCESS_KEY;
        delete process.env.AWS_SESSION_TOKEN;
        addMessage('system', `AWS_PROFILE=${value} set for this session. Add to shell rc to persist.`);
      } else {
        const keyMap: Record<string, string> = {
          anthropic: 'anthropicApiKey',
          openai: 'openaiApiKey',
          google: 'googleApiKey',
          mistral: 'mistralApiKey',
          openrouter: 'openrouterApiKey',
          together: 'togetherApiKey',
          groq: 'groqApiKey',
          fireworks: 'fireworksApiKey',
          ai21: 'ai21ApiKey',
          huggingface: 'huggingfaceApiKey',
        };
        const configKey = keyMap[entry.id];
        if (!configKey) throw new Error(`No config mapping for ${entry.id}`);
        // Cast through any — the mapping above guarantees a valid ApiKey field.
        (config.set as (k: string, v: string) => void)(configKey, value);
      }
      setProvider(entry.id);
      addMessage('system', `✓ Configured ${entry.label}. Provider switched.`);
    } catch (e) {
      addMessage('error', `Failed to configure ${entry.label}: ${e instanceof Error ? e.message : String(e)}`);
    }
    setPendingSetupProvider(null);
    setModalMode('none');
  }, [pendingSetupProvider, addMessage, setProvider]);

  const handleApiKeyCancel = useCallback(() => {
    setPendingSetupProvider(null);
    setModalMode('none');
  }, []);

  // Forward-declared ref so buildCommandContext (defined earlier) can open the
  // provider picker without a TDZ on the openProviderPicker callback.
  useEffect(() => {
    openProviderPickerRef.current = openProviderPicker;
  }, [openProviderPicker]);

  // Handle direct send (Shift+Enter) - interrupts current operation and sends immediately
  const handleDirectSend = useCallback((msg: string) => {
    // Stop current processing
    setIsProcessing(false);
    setThinkingState(null);
    setStreamingResponse('');
    setEditingQueueIndex(null);

    // Show what happened
    addMessage('system', '⚡ Direct send - interrupting current operation');
    addMessage('user', msg);

    // Start new agent run with this message
    setIsProcessing(true);
    runAgent(msg).finally(() => {
      setIsProcessing(false);
      setThinkingState(null);
      setStreamingResponse('');
      setEditingQueueIndex(null);
    });
  }, [addMessage, runAgent]);

  // Streaming response component (reused across layouts)
  const StreamingResponseBox = streamingResponse ? (
    <Box flexDirection="column">
      <Text color="cyan">✧ Calliope:</Text>
      {streamingResponse.split('\n').map((line, i) => (
        <Text key={i}><Text color="blue">│</Text> {line}</Text>
      ))}
      <Text color="cyan">▌</Text>
    </Box>
  ) : null;

  // Thinking/Processing indicator component with state transitions
  const ProcessingBox = (
    <>
      {transition && (
        <StateTransition
          from={transition.from as 'idle' | 'thinking' | 'streaming' | 'done'}
          to={transition.to as 'idle' | 'thinking' | 'streaming' | 'done'}
          onComplete={() => setTransition(null)}
        />
      )}
      {isProcessing && thinkingState && !streamingResponse && <ThinkingDisplay state={thinkingState} />}
      {isProcessing && !thinkingState && !streamingResponse && <ProcessingIndicator label="Waiting for response" />}
      {isProcessing && streamingResponse && <StreamingIndicator activity={activityState ?? undefined} />}
    </>
  );

  // Render based on layout
  return (
    <HUDFrame width={width}>
    <Box flexDirection="column" width={width}>
      {/* Split layout: side by side */}
      {layout === 'split' && (
        <Box flexDirection="row" width={width}>
          {/* Left: Tools/History */}
          <Box flexDirection="column" width="50%">
            <Text color="yellow" dimColor>─ Tools ─</Text>
            <MessageHistory messages={messages} collapseSettings={collapseSettings} />
            {ProcessingBox}
          </Box>
          {/* Right: Response */}
          <Box flexDirection="column" width="50%" borderStyle="single" borderLeft borderColor="gray">
            <Text color="cyan" dimColor>─ Response ─</Text>
            {StreamingResponseBox}
          </Box>
        </Box>
      )}

      {/* Classic layout: chronological */}
      {layout === 'classic' && (
        <>
          <MessageHistory messages={messages} collapseSettings={collapseSettings} />
          {ProcessingBox}
          {StreamingResponseBox}
        </>
      )}

      {/* Response-top layout */}
      {layout === 'response-top' && (
        <>
          {StreamingResponseBox}
          <MessageHistory messages={messages} collapseSettings={collapseSettings} />
          {ProcessingBox}
        </>
      )}

      {/* Response-bottom layout (default) */}
      {layout === 'response-bottom' && (
        <>
          <MessageHistory messages={messages} collapseSettings={collapseSettings} />
          {ProcessingBox}
          {StreamingResponseBox}
        </>
      )}

      {/* Zen layout: response only, tools hidden */}
      {layout === 'zen' && (
        <>
          <MessageHistory
            messages={messages.filter(m => m.type === 'user' || m.type === 'assistant')}
            collapseSettings={{ collapseTools: true, collapseThinking: true, toolDisplayLimit: 0 }}
          />
          {ProcessingBox}
          {StreamingResponseBox}
        </>
      )}

      {/* Focus layout: latest response pinned, compact tool log */}
      {layout === 'focus' && (
        <>
          {StreamingResponseBox}
          {ProcessingBox}
          <MessageHistory messages={messages} collapseSettings={{ collapseTools: true, collapseThinking: true, toolDisplayLimit: 3 }} />
        </>
      )}

      {/* Dashboard layout: stats strip, response, tools */}
      {layout === 'dashboard' && (
        <>
          <Text dimColor>
            {'  '}{stats.inputTokens ? `tokens: ${stats.inputTokens}/${stats.outputTokens}` : ''}{stats.cost ? ` | cost: $${stats.cost.toFixed(4)}` : ''}{model ? ` | ${model}` : ''}
          </Text>
          {StreamingResponseBox}
          {ProcessingBox}
          <MessageHistory messages={messages} collapseSettings={collapseSettings} />
        </>
      )}

      {/* Minimal layout: no decorations */}
      {layout === 'minimal' && (
        <>
          <MessageHistory messages={messages} collapseSettings={collapseSettings} />
          {ProcessingBox}
          {StreamingResponseBox}
        </>
      )}

      {/* Debug overlay when debug mode is enabled */}
      {debugEnabled && (
        <Box marginY={0}>
          <Text dimColor>[dbg] proc={isProcessing ? 'Y' : 'N'} think={thinkingState ? 'Y' : 'N'} stream={streamingResponse.length} mode={mode} queue={queuedMessages.length} activity={activityState?.action || 'none'}</Text>
        </Box>
      )}

      {/* Modal: Model Selector */}
      {modalMode === 'model' && availableModels.length > 0 && (
        <ModelSelector
          models={availableModels}
          onSelect={handleModelSelect}
          onCancel={handleModalCancel}
        />
      )}

      {/* Modal: Session Selector */}
      {modalMode === 'sessions' && (
        <SessionSelector
          sessions={availableSessions}
          onSelect={(session) => {
            // Load history from selected session
            addMessage('system', `Loading session: ${session.projectName}...`);
            addMessage('system', `Session path: ${session.projectPath}\nTo load this session, run calliope from that directory.`);
            setModalMode('none');
          }}
          onDelete={(session) => {
            if (storage.deleteSession(session.id)) {
              addMessage('system', `🗑️ Deleted session: ${session.projectName}`);
              // Refresh the list
              setAvailableSessions(prev => prev.filter(s => s.id !== session.id));
            } else {
              addMessage('error', `Failed to delete session: ${session.projectName}`);
            }
          }}
          onCancel={handleModalCancel}
        />
      )}

      {/* Modal: Upgrade Prompt */}
      {modalMode === 'upgrade' && latestVersion && (
        <UpgradePrompt
          currentVersion={getVersion()}
          latestVersion={latestVersion}
          onConfirm={handleUpgradeConfirm}
          onCancel={handleModalCancel}
        />
      )}

      {/* Modal: Session Resume */}
      {modalMode === 'session-resume' && previousSession && (
        <SessionResumePrompt
          session={previousSession}
          onResume={() => {
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
              setContextTokens(estimateContextTokens());
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
                    llmMessages.current.push({
                      role: msg.role,
                      content: msg.content,
                    });
                  }
                }
                addMessage('system', `✓ Resumed session with ${history.length} chat messages loaded`);
                setContextTokens(estimateContextTokens());
              }
            }
            setModalMode('none');
            setPreviousSession(null);
          }}
          onNew={() => {
            addMessage('system', '✓ Starting fresh session');
            setModalMode('none');
            setPreviousSession(null);
          }}
        />
      )}

      {/* Modal: Complexity Warning */}
      {modalMode === 'complexity-warning' && pendingComplexPrompt && (
        <ComplexityWarning
          reason={pendingComplexPrompt.complexity.reason || 'Complex operation detected'}
          prompt={typeof pendingComplexPrompt.prompt === 'string' ? pendingComplexPrompt.prompt : undefined}
          onProceed={async () => {
            setModalMode('none');
            const prompt = pendingComplexPrompt.prompt;
            setPendingComplexPrompt(null);

            // Proceed with execution
            saveUndoState();
            addMessage('user', typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
            setIsProcessing(true);
            try {
              await runAgent(prompt);
            } finally {
              setIsProcessing(false);
            }
          }}
          onPlan={() => {
            setModalMode('none');
            const prompt = pendingComplexPrompt.prompt;
            setPendingComplexPrompt(null);

            // Switch to plan mode and proceed
            setMode('plan');
            addMessage('system', '📋 Switched to Plan mode - I\'ll describe what I would do without executing.');
            saveUndoState();
            addMessage('user', typeof prompt === 'string' ? prompt : JSON.stringify(prompt));
            setIsProcessing(true);
            runAgent(prompt).finally(() => setIsProcessing(false));
          }}
          onCancel={() => {
            setModalMode('none');
            setPendingComplexPrompt(null);
            addMessage('system', 'Operation cancelled.');
          }}
        />
      )}

      {/* Modal: Keybindings */}
      {modalMode === 'keys' && (
        <KeybindingsModal onClose={() => setModalMode('none')} />
      )}

      {/* Modal: Provider Picker */}
      {modalMode === 'provider' && providerEntries.length > 0 && (
        <ProviderSelector
          providers={providerEntries}
          onSelect={handleProviderSelect}
          onCancel={() => {
            setModalMode('none');
            setProviderEntries([]);
          }}
        />
      )}

      {/* Modal: API Key Setup (inline configuration for unconfigured provider) */}
      {modalMode === 'api-key-setup' && pendingSetupProvider && (
        <ApiKeySetup
          provider={pendingSetupProvider.id}
          configHint={pendingSetupProvider.configHint}
          onSubmit={handleApiKeySubmit}
          onCancel={handleApiKeyCancel}
          extraInstructions={
            pendingSetupProvider.id === 'ollama'
              ? 'e.g. http://localhost:11434  (start with: ollama serve)'
              : pendingSetupProvider.id === 'bedrock'
              ? 'Enter your AWS profile name. Ensure it exists in ~/.aws/credentials or ~/.aws/config.'
              : pendingSetupProvider.id === 'litellm'
              ? 'e.g. http://localhost:4000'
              : undefined
          }
        />
      )}


      {/* Chat Input */}
      <ChatInput
        value={input}
        valueVersion={inputVersion}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        onEscape={handleEscape}
        onExit={handleExit}
        onCycleMode={cycleMode}
        disabled={isModalActive}
        isProcessing={isProcessing}
        queuedCount={queuedMessages.length}
        queuedMessages={queuedMessages}
        editingQueueIndex={editingQueueIndex}
        onQueueMessage={(msg) => {
          setQueuedMessages(prev => [...prev, msg]);
          addMessage('system', `📨 Queued: "${msg.substring(0, 50)}${msg.length > 50 ? '...' : ''}"`);
        }}
        onEditQueuedMessage={handleEditQueuedMessage}
        onSetEditingQueueIndex={setEditingQueueIndex}
        onDirectSend={handleDirectSend}
        cwd={process.cwd()}
        suggestions={suggestions}
        onSuggestionsChange={setSuggestions}
        onNavigateHistory={navigateHistory}
        // Smart suggestions context
        currentMode={mode}
        contextPercentage={Math.round((contextTokens / getModelContextLimit(actualProvider, actualModel)) * 100)}
        recentCommands={recentCommands}
        hasGitRepo={hasGitRepo}
      />

      {/* Status Bar */}
      <StatusBar
        provider={actualProvider}
        model={actualModel}
        mode={mode}
        stats={stats}
        contextTokens={contextTokens}
        breakerHealth={config.get('circuitBreakersEnabled') !== false ? breakerHealth : undefined}
        smartRouteActive={smartRouteActive}
        width={width}
      />
    </Box>
    </HUDFrame>
  );
}

// ============================================================================
// App Wrapper & Entry Point
// ============================================================================

function App() {
  const [resetKey, setResetKey] = React.useState(0);

  const handleReset = React.useCallback(() => {
    setResetKey(k => k + 1);
  }, []);

  return (
    <ErrorBoundary onReset={handleReset}>
      <TerminalChat key={resetKey} />
    </ErrorBoundary>
  );
}


// Print banner before Ink takes over (stays fixed at top)
export async function printBanner(): Promise<void> {
  const provider = selectProvider(config.get('defaultProvider'));
  const model = config.get('defaultModel') || DEFAULT_MODELS[provider];
  const skin = getCurrentSkin();

  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  // Run theme transition on startup if configured
  if (skin.splash?.transition && skin.splash.transition.effect !== 'none') {
    await renderTransition(skin.splash.transition);
  }

  if (skin.banner.style === 'none') {
    // No banner
  } else if (skin.splash?.coloredArt && skin.splash.coloredArt.length > 0) {
    // Rich colored banner from splash config
    console.log();
    if (skin.splash.entryAnimation && skin.splash.entryAnimation !== 'none') {
      // Animated splash
      const coloredLines = skin.splash.coloredArt.map(l => colorFg(l.text, l.color));
      await renderSplashAnimation(
        coloredLines,
        skin.splash.entryAnimation,
        skin.splash.animationSpeed ?? 50,
      );
    } else {
      // Static colored banner
      const banner = renderColoredBanner(
        skin.splash.coloredArt,
        skin.banner.tagline,
      );
      console.log(banner);
    }
    console.log();
    if (skin.banner.tagline && skin.splash.entryAnimation) {
      console.log(`${dim}        ${skin.banner.tagline}${reset}`);
      console.log();
    }
  } else {
    // Standard banner (existing behavior)
    console.log();
    for (const line of skin.banner.art) {
      if (line.includes('\x1b[')) {
        console.log(line);
      } else {
        console.log(paletteColorize(line, 'primary'));
      }
    }
    console.log();
    if (skin.banner.tagline) {
      console.log(`${dim}        ${skin.banner.tagline}${reset}`);
      console.log();
    }
  }

  console.log(`${dim}  v${getVersion()} | ${provider}:${model}${reset}`);
  console.log(`${dim}  /help for commands | ESC to exit${reset}`);
  console.log();
}

export async function startInkCLI(options: { skipPermissions?: boolean } = {}): Promise<void> {

  // Print banner BEFORE Ink starts - it stays fixed at the top
  await printBanner();

  const { waitUntilExit } = render(<App />, {
    patchConsole: true,  // Prevent console.log during session from mixing with Ink
  });
  await waitUntilExit();

  // Session cleanup
  await fleetPostOffline();
  sessionTimeout.clearTimers();
  idleEviction.stopMonitor();
  await spawnPendingRestart();
}
