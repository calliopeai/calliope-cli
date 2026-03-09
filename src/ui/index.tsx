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
import type { Message as LLMMessage, LLMProvider, AgentPersona, Mode, MessageContent } from '../types.js';
import type { ModelInfo } from '../model-detection.js';
import { getCurrentSkin, getCurrentPalette, paletteColorize, applySkin, applyPalette } from '../hud/api.js';
import { renderColoredBanner, renderSplashAnimation, renderTransition, colorFg } from '../terminal-image.js';
import { HUDFrame } from './frame.js';
import { getCurrentCompanion, applyCompanion } from '../companions.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import { IterationLedger } from '../iteration-ledger.js';
import { getDefaultSmartRoutingConfig } from '../smart-router.js';
import type { SmartRoutingConfig } from '../smart-router.js';
import * as recording from '../terminal-recording.js';
import * as sessionTimeout from '../session-timeout.js';
import * as idleEviction from '../idle-eviction.js';
import { isTmux, getTmuxInfo } from '../tmux.js';

// Sub-module imports
import type {
  UIMessage, SessionStats, CollapseSettings, ThinkingState, ActivityState,
  ConversationSnapshot, Bookmark, PromptTemplate, SessionInfo,
} from './types.js';
import { ErrorBoundary } from './error-boundary.js';
import { ThinkingDisplay, ProcessingIndicator, StreamingIndicator } from './components.js';
import { MessageHistory } from './messages.js';
import {
  ModelSelector, SessionSelector, UpgradePrompt, ComplexityWarning,
  SessionResumePrompt, KeybindingsModal,
} from './modals.js';
import { ThemePicker } from './theme-picker.js';
import { PackPicker } from './pack-picker.js';
import { applyThemePack, getCurrentPack, getCompanionMode, getThemePack } from '../hud/theme-packs/api.js';
import type { ThemeSelection } from './theme-picker.js';
import { ChatInput } from './chat-input.js';
import { StatusBar } from './status-bar.js';
import { resetContextWarnings } from './context.js';
import { handleCommand } from './commands.js';
import type { CommandContext } from './commands.js';
import { runAgentImpl, runLoopImpl, validateAndRepairMessagesImpl } from './agent.js';
import type { AgentContext } from './agent.js';

// Module-level state for agterm mode
let moduleAgtermEnabled = false;

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
  const [input, setInput] = useState('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [streamingResponse, setStreamingResponse] = useState<string>('');
  const [activityState, setActivityState] = useState<ActivityState | null>(null);

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

  // Clear suggestions when input changes significantly
  const handleInputChange = useCallback((newValue: string) => {
    setInput(newValue);
    // Clear suggestions if user clears input or submits
    if (!newValue || !newValue.startsWith('/')) {
      setSuggestions([]);
    }
    // Reset history navigation when user types
    setHistoryIndex(-1);
  }, []);

  // Navigate input history
  const navigateHistory = useCallback((direction: 'up' | 'down') => {
    if (inputHistory.length === 0) return;

    if (direction === 'up') {
      if (historyIndex === -1) {
        // Save current input before navigating
        setSavedInput(input);
        setHistoryIndex(inputHistory.length - 1);
        setInput(inputHistory[inputHistory.length - 1]);
      } else if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1);
        setInput(inputHistory[historyIndex - 1]);
      }
    } else {
      if (historyIndex === -1) return;
      if (historyIndex < inputHistory.length - 1) {
        setHistoryIndex(historyIndex + 1);
        setInput(inputHistory[historyIndex + 1]);
      } else {
        // Return to saved input
        setHistoryIndex(-1);
        setInput(savedInput);
      }
    }
  }, [inputHistory, historyIndex, input, savedInput]);

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
  const [persona, setPersona] = useState<AgentPersona>(() => config.get('persona'));
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
  const [modalMode, setModalMode] = useState<'none' | 'model' | 'upgrade' | 'confirm' | 'session-resume' | 'complexity-warning' | 'keys' | 'sessions' | 'theme-picker' | 'pack-picker'>('none');
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
    { role: 'system', content: getSystemPrompt(persona) }
  ]);

  // Keep system prompt in sync when persona changes (fixes #46 - persona lost on model fallback)
  useEffect(() => {
    const firstMsg = llmMessages.current[0];
    if (firstMsg && firstMsg.role === 'system') {
      // Preserve any appended memory context
      const currentContent = typeof firstMsg.content === 'string' ? firstMsg.content : '';
      const memoryIdx = currentContent.indexOf('\n\n--- Project Context ---\n');
      const memoryPart = memoryIdx >= 0 ? currentContent.slice(memoryIdx) : '';
      llmMessages.current[0] = {
        role: 'system',
        content: getSystemPrompt(persona) + memoryPart,
      };
    }
  }, [persona]);

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
  const [loopMaxIterations, setLoopMaxIterations] = useState(100);
  const [loopCompletionPromise, setLoopCompletionPromise] = useState<string | undefined>();
  const [loopIteration, setLoopIteration] = useState(0);
  const loopCancelledRef = useRef(false);

  // Initialize session and load memory on mount
  useEffect(() => {
    const cwd = process.cwd();

    // Check for existing session with messages
    const existingSessions = storage.listSessions(5);
    const recentSession = existingSessions.find(s =>
      s.projectPath === cwd &&
      s.messageCount > 0 &&
      Date.now() - new Date(s.lastAccessedAt).getTime() < 24 * 60 * 60 * 1000 // Within 24 hours
    );

    if (recentSession && !sessionRef.current) {
      // Offer to resume
      setPreviousSession({
        projectName: recentSession.projectName,
        lastAccessedAt: recentSession.lastAccessedAt,
        messageCount: recentSession.messageCount,
      });
      setModalMode('session-resume');
    }

    const session = storage.getOrCreateSession(cwd);
    sessionRef.current = session;

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

      // Start session recording (audit log)
      recording.startRecording({
        provider: selectProvider(provider),
        model: model || DEFAULT_MODELS[selectProvider(provider)],
        cwd: cwdMem,
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

      // Log tmux context if applicable
      if (isTmux()) {
        const info = getTmuxInfo();
        if (info) {
          debugLog('tmux', `session=${info.session}, windows=${info.windows}, panes=${info.panes}`);
        }
      }

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
  const addMessage = useCallback((type: UIMessage['type'], content: string) => {
    setMessages(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      content
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
    agtermEnabled: moduleAgtermEnabled,
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
    persona,
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
    agtermEnabled: moduleAgtermEnabled,
    debugEnabled,
    modalMode,
    circuitBreaker: circuitBreakerRef.current || undefined,
    smartRouteActive,
    smartRoutingConfig: smartRoutingConfigRef.current,

    setProvider,
    setModel,
    setPersona,
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
    setInput,
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
  }), [actualProvider, actualModel, provider, model, persona, mode, confirmMode, autoRoute, smartRouteActive,
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
    recording.recordEvent('input', trimmed);

    // Add to history for up/down arrow navigation
    addToHistory(trimmed);
    setInput('');

    if (trimmed.startsWith('/')) {
      await handleCommandWrapped(trimmed);
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
    const { text: cleanText, files } = parseFileReferences(trimmed, process.cwd());

    // Show user message (with file info if any)
    if (files.length > 0) {
      const fileInfo = formatFileInfo(files);
      addMessage('user', `${cleanText}\n📎 ${fileInfo}`);
    } else {
      addMessage('user', trimmed);
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
  }, [isProcessing, handleCommandWrapped, runAgent, addMessage, provider, model, saveUndoState, addToHistory, mode]);

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
        const { spawn } = await import('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          stdio: 'inherit',
          detached: true,
        });
        child.unref();
        process.exit(0);
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
      addMessage('system', '⏹ Operation cancelled. Use /exit to quit.');
    } else if (modalMode !== 'none') {
      // Close any open modal
      setModalMode('none');
      setPendingComplexPrompt(null);
    } else {
      // Not processing - show hint instead of exiting
      addMessage('system', '💡 Use /exit to quit, or Ctrl+C.');
    }
  }, [isProcessing, modalMode, addMessage]);

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
      <Text color="cyan">✧ {getCurrentCompanion().name}:</Text>
      {streamingResponse.split('\n').map((line, i) => (
        <Text key={i}><Text color="blue">│</Text> {line}</Text>
      ))}
      <Text color="cyan">▌</Text>
    </Box>
  ) : null;

  // Thinking/Processing indicator component
  const ProcessingBox = (
    <>
      {isProcessing && thinkingState && !streamingResponse && <ThinkingDisplay state={thinkingState} />}
      {isProcessing && !thinkingState && !streamingResponse && <ProcessingIndicator label="Waiting for response..." />}
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
            {'  '}{stats.inputTokens ? `tokens: ${stats.inputTokens}/${stats.outputTokens}` : ''}{stats.cost ? ` | cost: $${stats.cost.toFixed(4)}` : ''}{model ? ` | ${model}` : ''}{` | ${getCurrentCompanion().name}`}
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
            // Load chat history into context
            const history = storage.getChatHistory(20);
            if (history.length > 0) {
              for (const msg of history) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                  llmMessages.current.push({
                    role: msg.role,
                    content: msg.content,
                  });
                }
              }
              addMessage('system', `✓ Resumed session with ${history.length} messages loaded`);
              setContextTokens(estimateContextTokens());
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

      {/* Modal: Theme Picker */}
      {modalMode === 'theme-picker' && (
        <ThemePicker
          currentLayout={layout}
          currentSkin={getCurrentSkin().name}
          currentPalette={getCurrentPalette().name}
          currentCompanion={getCurrentCompanion().name}
          onApply={(selection: ThemeSelection) => {
            // Apply all selections
            setLayout(selection.layout as typeof layout);
            config.set('layout', selection.layout as typeof layout);
            applySkin(selection.skin);
            config.set('activeSkin', selection.skin);
            applyPalette(selection.palette);
            config.set('activePalette', selection.palette);
            applyCompanion(selection.companion);
            config.set('activeCompanion', selection.companion);

            const changes: string[] = [];
            if (selection.layout !== layout) changes.push(`layout=${selection.layout}`);
            if (selection.skin !== getCurrentSkin().name) changes.push(`skin=${selection.skin}`);
            if (selection.palette !== getCurrentPalette().name) changes.push(`palette=${selection.palette}`);
            if (selection.companion !== getCurrentCompanion().name) changes.push(`companion=${selection.companion}`);

            addMessage('system', changes.length > 0
              ? `Theme applied: ${changes.join(', ')}`
              : 'Theme unchanged.');
            setModalMode('none');
          }}
          onCancel={() => setModalMode('none')}
        />
      )}

      {/* Modal: Pack Picker */}
      {modalMode === 'pack-picker' && (
        <PackPicker
          onApply={async (packName: string) => {
            setModalMode('none');

            // Run transition animation if defined
            const targetPack = getThemePack(packName);
            if (targetPack?.skin.splash?.transition) {
              await renderTransition(targetPack.skin.splash.transition);
            }

            const success = applyThemePack(packName, getCompanionMode());
            if (success) {
              const pack = getCurrentPack()!;
              config.set('activeThemePack', packName);
              config.set('activeSkin', pack.skin.name);
              config.set('activePalette', pack.palette.name);
              const companion = getCompanionMode() === 'professional'
                ? pack.companions.professional
                : pack.companions.immersive;
              config.set('activeCompanion', companion.name);

              addMessage('system',
                `Theme pack: ${packName}\n` +
                `  Skin: ${pack.skin.name}, Palette: ${pack.palette.name}, Companion: ${companion.name}\n` +
                `  "${companion.greeting}"`
              );
            }
          }}
          onCancel={() => setModalMode('none')}
        />
      )}

      {/* Chat Input */}
      <ChatInput
        value={input}
        onChange={handleInputChange}
        onSubmit={handleSubmit}
        onEscape={handleEscape}
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

  const companion = getCurrentCompanion();
  console.log(`${dim}  v${getVersion()} | ${provider}:${model}${reset}`);
  console.log(`${dim}  /help for commands | ESC to exit${reset}`);
  if (companion.greeting) {
    console.log(`${dim}  ${companion.greeting}${reset}`);
  }
  console.log();
}

export async function startInkCLI(options: { skipPermissions?: boolean; agtermEnabled?: boolean } = {}): Promise<void> {
  // Set module-level agterm state
  moduleAgtermEnabled = options.agtermEnabled ?? false;

  // Print banner BEFORE Ink starts - it stays fixed at the top
  await printBanner();

  const { waitUntilExit } = render(<App />, {
    patchConsole: true,  // Prevent console.log during session from mixing with Ink
  });
  await waitUntilExit();

  // Session cleanup
  recording.stopRecording();
  sessionTimeout.clearTimers();
  idleEviction.stopMonitor();
}
